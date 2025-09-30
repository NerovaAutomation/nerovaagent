#!/usr/bin/env node
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const command = args[0];

function printHelp() {
  console.log(`nerovastream commands:\n  start               Start the Nerova streamer runtime (launches start.sh if present)\n  playwright-launch   Ensure the Playwright browser is running on the local runtime\n  status              Check whether the local runtime responds to health checks\n  help                Show this help message\n`);
}

function resolveAppRoot() {
  if (process.env.NEROVA_STREAM_APP_ROOT) {
    return process.env.NEROVA_STREAM_APP_ROOT;
  }
  let current = path.resolve(__dirname, '../../..');
  const marker = 'package.json';
  for (let i = 0; i < 6; i += 1) {
    const markerPath = path.join(current, marker);
    if (fs.existsSync(markerPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        if (pkg && pkg.name === 'ocr-playwright-app') {
          return current;
        }
      } catch {}
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(__dirname, '../../..');
}

async function callRuntime(pathname, { method = 'GET', body } = {}) {
  const base = process.env.NEROVA_STREAM_HTTP || 'http://127.0.0.1:3333';
  const url = new URL(pathname, base);
  const headers = { 'Content-Type': 'application/json' };
  const machineId = process.env.FLY_MACHINE_ID;
  if (machineId) {
    headers['Fly-Machine'] = machineId;
  }
  const init = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const err = new Error(`Request failed: ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function handleStart() {
  const appRoot = resolveAppRoot();
  const startScript = path.join(appRoot, 'start.sh');
  const serverEntry = path.join(appRoot, 'server.js');
  if (fs.existsSync(startScript)) {
    const child = spawn('bash', [startScript], { stdio: 'inherit', cwd: appRoot });
    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  } else if (fs.existsSync(serverEntry)) {
    const child = spawn('node', [serverEntry], { stdio: 'inherit', cwd: appRoot });
    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
  } else {
    console.error('Could not locate start.sh or server.js in app root:', appRoot);
    process.exit(1);
  }
}

async function handlePlaywrightLaunch() {
  try {
    const result = await callRuntime('/runtime/playwright/launch', { method: 'POST' });
    console.log('Playwright ready:', result && result.status ? result.status : 'ok');
  } catch (err) {
    console.error('Failed to launch Playwright via runtime:', err?.message || err);
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
  switch (command) {
    case 'start':
      await handleStart();
      break;
    case 'playwright-launch':
      await handlePlaywrightLaunch();
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
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main();
