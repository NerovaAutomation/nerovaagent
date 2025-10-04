#!/usr/bin/env node
import { readFileSync } from 'fs';
import { createClient } from '../lib/runtime.js';
import { ensureAgentDaemon } from '../lib/agent-manager.js';

const args = process.argv.slice(2);
const client = createClient();

function printHelp() {
  console.log(`nerovaagent commands:\n  playwright-launch      Ensure the local Playwright runtime is warmed up\n  start <prompt|string>  Kick off a run with the given prompt\n  start --prompt-file <path>   Read prompt from a file\n  status                 Fetch runtime status\n  help                   Show this message\n`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--prompt-file' && argv[i + 1]) {
      out.promptFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--prompt' && argv[i + 1]) {
      out.prompt = argv[i + 1];
      i += 1;
      continue;
    }
    out._.push(token);
  }
  return out;
}

async function callRuntime(pathname, { method = 'GET', body } = {}) {
  return client.request(pathname, { method, body });
}

async function handleStart(options) {
  let prompt = options.prompt;
  if (!prompt && options.promptFile) {
    prompt = readFileSync(options.promptFile, 'utf8');
  }
  if (!prompt && options._.length > 0) {
    prompt = options._.join(' ');
  }
  if (!prompt || !prompt.trim()) {
    console.error('A prompt is required. Pass as argument or use --prompt/--prompt-file.');
    process.exit(1);
  }
  const payload = { prompt: prompt.trim() };
  try {
    await ensureAgentDaemon({ origin: client.config.origin });
    const result = await callRuntime('/run/start', { method: 'POST', body: payload });
    console.log('Agent started:', JSON.stringify(result));
  } catch (err) {
    console.error('Failed to start agent:', err?.message || err);
    if (err?.data) {
      console.error('Runtime response:', err.data);
    }
    process.exit(1);
  }
}

async function handlePlaywrightLaunch() {
  try {
    await ensureAgentDaemon({ origin: client.config.origin });
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

async function main() {
  const options = parseArgs(args.slice(1));
  switch (args[0]) {
    case 'agent-daemon':
      await import('../lib/agent-daemon.js');
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
    case 'help':
    case undefined:
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
