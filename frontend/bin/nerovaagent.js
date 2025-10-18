#!/usr/bin/env node
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import readline from 'readline';
import {
  runAgent,
  warmPlaywright,
  shutdownContext,
  requestPause,
  supplyContext,
  abortRun
} from '../src/runner.js';

const RUNS_ROOT = path.join(os.homedir(), '.nerovaagent', 'runs');

function printHelp() {
  console.log(`nerovaagent commands:
  start <prompt|string>             Run the agent workflow with the given prompt
  playwright-launch                 Warm the local Playwright runtime
  logs [runId] [--follow] [--workflow]  Show run logs (use --workflow for action feed)
    --prompt-file <path>            Read the prompt from a file
    --context <string>              Additional context notes for the run
    --context-file <path>           Read context notes from a file
    --brain-url <url>               Override brain backend URL (default http://127.0.0.1:4000)
    --critic-key <key>              Override critic OpenAI key
    --assistant-key <key>           Override Step 4 assistant key
    --assistant-id <id>             Override Step 4 assistant id
    --boot-url <url>                Navigate to this URL before starting the loop
    --max-steps <n>                 Limit the number of iterations (default 10)
  help                              Show this message
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    const consume = () => {
      i += 1;
      return next;
    };
    switch (token) {
      case '--prompt-file':
        if (next) out.promptFile = consume();
        break;
      case '--context':
        if (next) out.context = consume();
        break;
      case '--context-file':
        if (next) out.contextFile = consume();
        break;
      case '--brain-url':
        if (next) out.brainUrl = consume();
        break;
      case '--critic-key':
        if (next) out.criticKey = consume();
        break;
      case '--assistant-key':
        if (next) out.assistantKey = consume();
        break;
      case '--assistant-id':
        if (next) out.assistantId = consume();
        break;
      case '--boot-url':
        if (next) out.bootUrl = consume();
        break;
      case '--max-steps':
        if (next) out.maxSteps = Number(consume());
        break;
      default:
        out._.push(token);
        break;
    }
  }
  return out;
}

function loadFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err?.message || err);
    process.exit(1);
  }
}

function tokenizeArgs(line) {
  const tokens = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|\S+/g;
  let match;
  while ((match = regex.exec(line))) {
    if (match[1] !== undefined) {
      tokens.push(match[1].replace(/\\"/g, '"'));
    } else if (match[2] !== undefined) {
      tokens.push(match[2].replace(/\\'/g, "'"));
    } else {
      tokens.push(match[0]);
    }
  }
  return tokens;
}

function setupPauseControls(hooks = {}) {
  if (!process.stdin.isTTY) {
    return () => {};
  }

  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);

  const originalSigintHandlers = process.listeners('SIGINT');
  for (const handler of originalSigintHandlers) {
    process.removeListener('SIGINT', handler);
  }

  const previousRaw = process.stdin.isRaw;
  if (!previousRaw) {
    try { process.stdin.setRawMode(true); } catch {}
  }

  let paused = false;
  let awaitingResume = false;
  let contextInterface = null;
  let keypressAttached = false;

  const enableRaw = () => {
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(true); } catch {}
    }
  };

  const disableRaw = () => {
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
  };

  const closeInterface = () => {
    if (contextInterface) {
      contextInterface.close();
      contextInterface = null;
    }
  };

  const finishPause = (message) => {
    paused = false;
    awaitingResume = false;
    closeInterface();
    try { hooks.resumeInput?.(); } catch {}
    enableRaw();
    attachKeypress();
    if (message) console.log(message);
  };

  const handleKeypress = (_str, key) => {
    if (!key || !key.ctrl || key.name !== 'c') return;

    if (!paused) {
      paused = true;
      requestPause();
      promptForContext();
    } else if (awaitingResume) {
      abortRun();
      finishPause('[nerovaagent] Abort requested.');
    }
  };

  const attachKeypress = () => {
    if (keypressAttached) return;
    process.stdin.on('keypress', handleKeypress);
    keypressAttached = true;
  };

  const detachKeypress = () => {
    if (!keypressAttached) return;
    process.stdin.removeListener('keypress', handleKeypress);
    keypressAttached = false;
  };

  const promptForContext = () => {
    if (contextInterface || awaitingResume) return;
    awaitingResume = true;

    const handleAnswer = (answer) => {
      const text = typeof answer === 'string' ? answer : '';
      supplyContext(text);
      if (text && text.trim()) {
        console.log(`[nerovaagent] context added: ${text.trim()}`);
      }
      finishPause('[nerovaagent] Resuming…');
    };

    const handleAbort = () => {
      abortRun();
      finishPause('[nerovaagent] Abort requested.');
    };

    detachKeypress();
    disableRaw();
    try { hooks.pauseInput?.(); } catch {}

    console.log('[nerovaagent] Paused. Enter context (Enter to resume, Ctrl+C to abort).');

    contextInterface = readline.createInterface({ input: process.stdin, output: process.stdout });
    contextInterface.question('context> ', (answer) => {
      handleAnswer(answer || '');
    });
    contextInterface.on('SIGINT', () => {
      handleAbort();
    });
  };

  attachKeypress();

  const noopSigint = () => {};
  process.on('SIGINT', noopSigint);

  return () => {
    detachKeypress();
    process.removeListener('SIGINT', noopSigint);
    closeInterface();
    if (!previousRaw && process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch {}
    }
    for (const handler of originalSigintHandlers) {
      process.on('SIGINT', handler);
    }
  };
}

function formatWorkflowLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return line.trim();
  }
  const parts = [];
  if (event.timestamp) parts.push(new Date(event.timestamp).toISOString());
  if (Number.isFinite(event.step)) parts.push(`step ${event.step}`);
  if (event.stage) parts.push(event.stage);

  const decisionSummary = (decision) => {
    if (!decision) return 'decision: none';
    const items = [`action=${decision.action || 'none'}`];
    if (typeof decision.reason === 'string' && decision.reason.trim()) items.push(`reason=${decision.reason.trim()}`);
    if (typeof decision.confidence === 'number') items.push(`confidence=${decision.confidence}`);
    return items.join(' ');
  };

  let detail = '';
  switch (event.stage) {
    case 'run_start':
      detail = `prompt="${event.prompt || ''}" maxSteps=${event.maxSteps ?? 'n/a'}`;
      break;
    case 'bootstrap_request':
      detail = `attempt ${event.attempt || 0} prompt="${event.prompt || ''}" screenshot=${event.screenshotLength || 0}`;
      break;
    case 'bootstrap_response':
      if (event.decision) {
        detail = `action=${event.decision.action || 'none'}${event.decision.url ? ` url=${event.decision.url}` : ''}`;
      } else {
        detail = 'no decision';
      }
      break;
    case 'bootstrap_error':
      detail = `error=${event.error}`;
      break;
    case 'critic_request':
      detail = `prompt="${event.prompt || ''}" screenshot=${event.screenshotLength || 0}`;
      break;
    case 'critic_response':
      detail = decisionSummary(event.decision);
      if (Array.isArray(event.completeHistory)) {
        detail += ` complete=[${event.completeHistory.slice(-5).join(', ')}]`;
      }
      break;
    case 'critic_error':
      detail = `error=${event.error}`;
      break;
    case 'critic_no_action':
      detail = 'no action returned (resend)';
      break;
    case 'step3_hittables':
      detail = `hittables=${event.count || 0}`;
      break;
    case 'step3_radius':
      detail = `candidates=${event.candidateCount || 0}`;
      break;
    case 'step3_exact_match':
      if (event.target) {
        detail = `exact target="${event.target.name || ''}" role=${event.target.role || ''}`;
      }
      break;
    case 'assistant_request':
      detail = `candidates=${event.candidateCount || 0}`;
      break;
    case 'assistant_response':
      if (event.assistant?.action) {
        detail = `assistant action=${event.assistant.action} confidence=${event.assistant.confidence ?? 'n/a'}`;
      } else {
        detail = 'assistant response (no action)';
      }
      break;
    case 'assistant_error':
      detail = `error=${event.error}`;
      break;
    case 'action_navigate':
      detail = `navigate -> ${event.url}`;
      break;
    case 'action_scroll':
      detail = `scroll ${event.direction || ''} amount=${event.amount || ''}`;
      break;
    case 'action_back':
      detail = 'back navigation';
      break;
    case 'action_click':
      detail = `click target="${event.target?.name || ''}" source=${event.source || ''}`;
      break;
    case 'action_stop':
      detail = 'run stopped';
      break;
    case 'action_resend':
      detail = 'critic requested resend';
      break;
    case 'await_assistance':
      detail = 'awaiting assistance';
      break;
    case 'click_unresolved':
      detail = `click unresolved status=${event.status}`;
      break;
    default:
      detail = JSON.stringify(event);
      break;
  }

  parts.push(detail);
  return parts.join(' | ');
}

function formatWorkflowChunk(chunk) {
  return chunk
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(formatWorkflowLine)
    .join('\n');
}

async function handleStart(argv, { suppressExit = false, pauseHooks = null } = {}) {
  const options = parseArgs(argv);
  let prompt = options.prompt;
  if (!prompt && options.promptFile) {
    prompt = loadFileSafe(options.promptFile);
  }
  if (!prompt && options._.length > 0) {
    prompt = options._.join(' ');
  }
  if (!prompt || !prompt.trim()) {
    console.error('A prompt is required. Pass as argument or use --prompt-file.');
    process.exit(1);
  }

  let contextNotes = options.context || '';
  if (!contextNotes && options.contextFile) {
    contextNotes = loadFileSafe(options.contextFile);
  }

  const teardown = setupPauseControls(pauseHooks || {});
  try {
    await runAgent({
      prompt,
      contextNotes,
      brainUrl: options.brainUrl,
      criticKey: options.criticKey || process.env.NEROVA_AGENT_CRITIC_KEY || null,
      assistantKey: options.assistantKey || process.env.NEROVA_AGENT_ASSISTANT_KEY || null,
      assistantId: options.assistantId || process.env.NEROVA_AGENT_ASSISTANT_ID || null,
      maxSteps: Number.isFinite(options.maxSteps) && options.maxSteps > 0 ? options.maxSteps : undefined,
      bootUrl: options.bootUrl || process.env.NEROVA_BOOT_URL || null
    });
  } catch (err) {
    if (err?.message === 'run_aborted') {
      console.log('[nerovaagent] run aborted by user.');
      if (!suppressExit) return;
      throw err;
    }
    console.error('Failed to run agent:', err?.message || err);
    if (!suppressExit) {
      process.exit(1);
    } else {
      throw err;
    }
  }
  finally {
    teardown();
  }
}

async function handlePlaywrightLaunch(argv) {
  const options = parseArgs(argv);
  const bootUrl = options.bootUrl || process.env.NEROVA_BOOT_URL || null;
  const headlessOverride = false;
  try {
    await warmPlaywright({ bootUrl, headlessOverride });
  } catch (err) {
    console.error('Failed to warm Playwright:', err?.message || err);
    process.exit(1);
    return;
  }

  console.log('[nerovaagent] Enter commands (e.g., `start "<prompt>"` or `exit`).');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  let runActive = false;
  const pauseHooks = {
    pauseInput: () => rl.pause(),
    resumeInput: () => {
      rl.resume();
      rl.prompt();
    }
  };

  const cleanup = async () => {
    await shutdownContext();
    rl.close();
    process.exit(0);
  };

  rl.on('line', async (line) => {
    if (runActive) {
      rl.prompt();
      return;
    }

    const raw = line.trim();
    if (!raw) { rl.prompt(); return; }

    const tokens = tokenizeArgs(raw);
    if (!tokens.length) { rl.prompt(); return; }

    const cmd = tokens[0] === 'nerovaagent' ? tokens[1] : tokens[0];
    const args = tokens[0] === 'nerovaagent' ? tokens.slice(2) : tokens.slice(1);

    if (!cmd) {
      rl.prompt();
      return;
    }

    if (cmd === 'exit' || cmd === 'quit') {
      await cleanup();
      return;
    }

    if (cmd === 'start') {
      runActive = true;
      try {
        await handleStart(args, {
          suppressExit: true,
          pauseHooks
        });
      } catch (err) {
        console.error('Run failed:', err?.message || err);
      } finally {
        runActive = false;
      }
      rl.prompt();
      return;
    }

    console.log(`Unknown command: ${cmd}`);
    rl.prompt();
  });

  rl.on('SIGINT', async () => {
    if (runActive) {
      console.log('[nerovaagent] Run in progress. Use Ctrl+C in the pause prompt or type exit to quit.');
      return;
    }
    await cleanup();
  });

  rl.prompt();
}

async function listRuns() {
  try {
    const entries = await fsPromises.readdir(RUNS_ROOT, { withFileTypes: true });
    const details = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = path.join(RUNS_ROOT, entry.name);
        const stat = await fsPromises.stat(dir);
        return { name: entry.name, dir, mtime: stat.mtimeMs };
      }));
    return details.sort((a, b) => b.mtime - a.mtime);
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
}

async function tailFile(filePath, follow = false, formatter = null) {
  const handle = await fsPromises.open(filePath, 'r');
  let position = 0;
  const pump = async () => {
    const { size } = await handle.stat();
    if (size > position) {
      const length = size - position;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, position);
      position = size;
      const chunk = buffer.toString('utf8');
      const output = formatter ? formatter(chunk) : chunk;
      if (output && output.length) {
        process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
      }
    }
  };
  await pump();

  if (!follow) {
    await handle.close();
    return;
  }

  await new Promise((resolve) => {
    const watcher = fs.watch(filePath, async (eventType) => {
      if (eventType === 'change') {
        try {
          await pump();
        } catch (err) {
          console.error('log tail error:', err?.message || err);
        }
      }
    });

    const cleanup = async () => {
      watcher.close();
      await handle.close().catch(() => {});
      process.off('SIGINT', cleanup);
      resolve();
    };

    process.on('SIGINT', cleanup);
  });
}

async function handleLogs(argv) {
  let runId = null;
  let follow = false;
  let workflow = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--id':
        if (argv[i + 1]) { runId = argv[i + 1]; i += 1; }
        break;
      case '--follow':
      case '-f':
        follow = true;
        break;
      case '--workflow':
        workflow = true;
        break;
      default:
        if (!runId) runId = token;
        break;
    }
  }

  const runs = await listRuns();
  if (!runId && runs.length) {
    runId = runs[0].name;
  }
  if (!runId) {
    console.error('[nerovaagent] no runs found. Start a run first.');
    return;
  }
  const dir = path.join(RUNS_ROOT, runId);
  const fileName = workflow ? 'workflow.log' : 'run.log';
  const logPath = path.join(dir, fileName);
  try {
    await fsPromises.access(logPath);
  } catch (err) {
    console.error(`[nerovaagent] log not found for run ${runId} (${logPath})`);
    if (!runs.length) {
      console.error('[nerovaagent] run directory is empty.');
    }
    return;
  }

  console.log(`[nerovaagent] ${workflow ? 'workflow' : 'log'} for run ${runId} (${follow ? 'follow' : 'static'})`);
  console.log(`[nerovaagent] path: ${logPath}`);
  if (!follow) {
    const data = await fsPromises.readFile(logPath, 'utf8').catch(() => '');
    if (!data || !data.trim()) {
      console.log('[nerovaagent] log is empty.');
      return;
    }
    const output = workflow ? formatWorkflowChunk(data) : data.trimEnd();
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    return;
  }

  await tailFile(logPath, true, workflow ? formatWorkflowChunk : null);

}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  switch (command) {
    case 'start':
      await handleStart(args.slice(1));
      break;
    case 'playwright-launch':
      await handlePlaywrightLaunch(args.slice(1));
      break;
    case 'logs':
      await handleLogs(args.slice(1));
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
