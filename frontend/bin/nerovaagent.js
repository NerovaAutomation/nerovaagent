#!/usr/bin/env node
import { readFileSync } from 'fs';
import readline from 'readline';
import { runAgent, warmPlaywright, shutdownContext } from '../src/runner.js';

function printHelp() {
  console.log(`nerovaagent commands:
  start <prompt|string>             Run the agent workflow with the given prompt
  playwright-launch                 Warm the local Playwright runtime
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
    return readFileSync(filePath, 'utf8');
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

async function handleStart(argv, { suppressExit = false } = {}) {
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
    console.error('Failed to run agent:', err?.message || err);
    if (!suppressExit) {
      process.exit(1);
    } else {
      throw err;
    }
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

  const cleanup = async () => {
    await shutdownContext();
    rl.close();
    process.exit(0);
  };

  rl.on('line', async (line) => {
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
      try {
        await handleStart(args, { suppressExit: true });
      } catch (err) {
        console.error('Run failed:', err?.message || err);
      }
      rl.prompt();
      return;
    }

    console.log(`Unknown command: ${cmd}`);
    rl.prompt();
  });

  rl.on('SIGINT', async () => {
    await cleanup();
  });

  rl.prompt();
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
