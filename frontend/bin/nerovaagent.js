#!/usr/bin/env node
import { readFileSync } from 'fs';
import { runAgent } from '../src/runner.js';

function printHelp() {
  console.log(`nerovaagent commands:
  start <prompt|string>             Run the agent workflow with the given prompt
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

async function handleStart(argv) {
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
    process.exit(1);
  }
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
