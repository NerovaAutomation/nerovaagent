#!/usr/bin/env node
import { readFileSync } from 'fs';
import { createClient } from '../lib/runtime.js';
import { ensureAgentDaemon, isAgentDaemonRunning } from '../lib/agent-manager.js';
import { runCliWorkflow } from '../lib/cli-workflow.js';

const args = process.argv.slice(2);
const client = createClient();

function printHelp() {
  console.log(`nerovaagent commands:
  (no command)                      Activate the local agent daemon
  playwright-launch                 Warm the local Playwright runtime
  start <prompt|string>             Kick off a run with the given prompt
    --prompt-file <path>            Read prompt from a file
    --context <string>              Supply additional context notes for the run
    --context-file <path>           Load context notes from a file
    --critic-key <key>              Override critic OpenAI key
    --assistant-key <key>           Override Step 4 assistant key
    --assistant-id <id>             Override Step 4 assistant id
  logs                              Stream backend run logs in realtime
  status                            Fetch runtime status
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
    if (token === '--prompt-file' && next) {
      out.promptFile = consume();
      continue;
    }
    if (token === '--prompt' && next) {
      out.prompt = consume();
      continue;
    }
    if (token === '--context' && next) {
      out.context = consume();
      continue;
    }
    if (token === '--context-file' && next) {
      out.contextFile = consume();
      continue;
    }
    if (token === '--critic-key' && next) {
      out.criticKey = consume();
      continue;
    }
    if (token === '--assistant-key' && next) {
      out.assistantKey = consume();
      continue;
    }
    if (token === '--assistant-id' && next) {
      out.assistantId = consume();
      continue;
    }
    out._.push(token);
  }
  return out;
}

async function callRuntime(pathname, { method = 'GET', body } = {}) {
  return client.request(pathname, { method, body });
}

function loadFileSafe(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err?.message || err);
    process.exit(1);
  }
  return '';
}

async function handleActivate() {
  try {
    const pid = await ensureAgentDaemon({ origin: client.config.origin });
    console.log(`[nerovaagent] agent daemon running (pid ${pid})`);
    console.log('[nerovaagent] You can now run `nerovaagent playwright-launch` or `nerovaagent start "<prompt>"`.');
  } catch (err) {
    console.error('Failed to activate agent daemon:', err?.message || err);
    process.exit(1);
  }
}

async function requireAgentDaemon() {
  if (await isAgentDaemonRunning()) return true;
  console.error('No active nerova agent daemon detected. Run `nerovaagent` first to activate it.');
  process.exit(1);
}

async function handleLogs() {
  const origin = client.config.origin;
  const url = new URL('/logs/stream', origin).toString();
  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/event-stream' }
    });
    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }
    console.log(`[nerovaagent] streaming run logs from ${url}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const chunk of parts) {
        const line = chunk.split('\n').find((entry) => entry.startsWith('data:'));
        if (!line) continue;
        const payloadStr = line.slice(5).trim();
        if (!payloadStr) continue;
        try {
          const payload = JSON.parse(payloadStr);
          renderLogEvent(payload);
        } catch (err) {
          console.error('[nerovaagent] log parse error:', err?.message || err);
        }
      }
    }
  } catch (err) {
    console.error('Failed to stream logs via fetch:', err?.message || err);
    console.error('[nerovaagent] falling back to `curl -N`');
    const { spawn } = await import('child_process');
    const proc = spawn('curl', ['-N', url], { stdio: 'inherit' });
    proc.on('exit', (code) => process.exit(code || 0));
  }
}

function renderLogEvent(event) {
  const type = event?.type || 'unknown';
  const runId = event?.runId || 'n/a';
  switch (type) {
    case 'run_started':
      console.log(`run ${runId} ▶️  prompt=${JSON.stringify(event.prompt || '')}`);
      break;
    case 'iteration': {
      const iter = event.iteration ?? '?';
      const action = event.decision?.action || 'none';
      const reason = event.decision?.reason || event.decision?.summary || '';
      console.log(`run ${runId} • step ${iter} action=${action}${reason ? ` :: ${reason}` : ''}`);
      if (event.decision?.target) {
        const hints = event.decision.target.hints || {};
        const label = (hints.text_exact && hints.text_exact.join(' | ')) || hints.text_partial || (Array.isArray(hints.text_contains) && hints.text_contains[0]) || '';
        if (label) console.log(`   target: ${label}`);
      }
      if (event.result?.debug?.elements) {
        console.log(`   hittables: ${event.result.debug.elements.length} candidates`);
      }
      if (event.assistant?.parsed) {
        console.log(`   assistant: ${JSON.stringify(event.assistant.parsed)}`);
      }
      break;
    }
    case 'run_completed':
      console.log(`run ${runId} ✅ status=${event.status} iterations=${event.iterations}`);
      if (event.logPath) console.log(`   log: ${event.logPath}`);
      break;
    default:
      console.log(`run ${runId} ${type}:`, JSON.stringify(event));
  }
}

async function handleStart(options) {
  let prompt = options.prompt;
  if (!prompt && options.promptFile) {
    prompt = loadFileSafe(options.promptFile);
  }
  if (!prompt && options._.length > 0) {
    prompt = options._.join(' ');
  }
  if (!prompt || !prompt.trim()) {
    console.error('A prompt is required. Pass as argument or use --prompt/--prompt-file.');
    process.exit(1);
  }

  let contextNotes = options.context || '';
  if (!contextNotes && options.contextFile) {
    contextNotes = loadFileSafe(options.contextFile);
  }

  await requireAgentDaemon();

  try {
    await client.ensureServer();
  } catch (err) {
    console.error('Failed to reach backend runtime:', err?.message || err);
    process.exit(1);
  }

  try {
    const result = await runCliWorkflow({
      client,
      prompt: prompt.trim(),
      contextNotes: contextNotes ? contextNotes.trim() : '',
      criticKey: options.criticKey || process.env.NEROVA_AGENT_CRITIC_KEY || null,
      assistantKey: options.assistantKey || process.env.NEROVA_AGENT_ASSISTANT_KEY || null,
      assistantId: options.assistantId || process.env.NEROVA_AGENT_ASSISTANT_ID || null,
      log: console
    });
    renderRunResult(result);
  } catch (err) {
    console.error('Failed to execute workflow:', err?.message || err);
    process.exit(1);
  }
}

async function handlePlaywrightLaunch() {
  await requireAgentDaemon();
  try {
    const result = await callRuntime('/runtime/playwright/launch', { method: 'POST' });
    console.log('Playwright ready:', JSON.stringify(result));
  } catch (err) {
    console.error('Failed to warm Playwright runtime:', err?.message || err);
    if (err?.data) {
      console.error('Runtime response:', err.data);
    }
    process.exit(1);
  }
}

async function handleStatus() {
  try {
    const result = await callRuntime('/healthz', { method: 'GET' });
    console.log('Runtime status:', JSON.stringify(result));
  } catch (err) {
    console.error('Runtime not reachable:', err?.message || err);
    process.exit(1);
  }
}

function renderRunResult(run) {
  if (!run || typeof run !== 'object') {
    console.log('Agent response:', JSON.stringify(run));
    return;
  }
  const status = run.status || (run.ok ? 'completed' : 'unknown');
  console.log(`[nerovaagent] status=${status} iterations=${run.iterations ?? 'n/a'}`);

  const timeline = Array.isArray(run.timeline) ? run.timeline : [];
  if (!timeline.length) {
    console.log('[nerovaagent] timeline: <empty>');
  }
  for (const entry of timeline) {
    const iter = entry.iteration ?? '?';
    const decision = entry.decision || {};
    const action = decision.action || 'none';
    const reason = decision.reason || decision.summary || decision?.target?.reason || '';
    console.log(` step ${iter}: action=${action}${reason ? ` :: ${reason}` : ''}`);
    if (decision.target && typeof decision.target === 'object') {
      const hints = decision.target.hints || {};
      const exact = Array.isArray(hints.text_exact) ? hints.text_exact.join(' | ') : '';
      const partial = hints.text_partial || (Array.isArray(hints.text_contains) && hints.text_contains[0]) || '';
      const label = exact || partial;
      if (label) {
        console.log(`   target: ${label}`);
      }
    }
    const result = entry.result || {};
    if (result.next && result.next !== 'continue') {
      console.log(`   result: next=${result.next}${result.reason ? ` reason=${result.reason}` : ''}`);
    }
    if (result.action === 'click' && result.target) {
      console.log(`   clicked: ${(result.target.name || result.target.id || 'candidate')} @ ${JSON.stringify(result.target.center || [])}`);
    }
    if (entry.assistant) {
      const parsed = entry.assistant.parsed || entry.assistant.raw;
      console.log(`   assistant: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }
  }

  if (Array.isArray(run.completeHistory) && run.completeHistory.length) {
    console.log(` complete history: ${run.completeHistory.join(' | ')}`);
  }

  const successStatuses = new Set(['completed']);
  if (!successStatuses.has(status)) {
    process.exitCode = 1;
    console.error(`[nerovaagent] run finished with status ${status}. Inspect timeline for details.`);
  }
}

async function main() {
  const options = parseArgs(args.slice(1));
  switch (args[0]) {
    case 'agent-daemon':
      await import('../lib/agent-daemon.js');
      break;
    case 'activate':
      await handleActivate();
      break;
    case 'playwright-launch':
      await handlePlaywrightLaunch();
      break;
    case 'start':
      await handleStart(options);
      break;
    case 'status':
      await handleStatus();
      break;
    case 'logs':
      await handleLogs();
      break;
    case 'help':
      printHelp();
      break;
    case undefined:
      await handleActivate();
      break;
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${args[0]}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
