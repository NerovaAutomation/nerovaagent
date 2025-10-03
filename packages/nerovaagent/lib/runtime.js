import { promises as fs } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const APP_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const SERVER_ENTRY = path.join(PACKAGE_ROOT, 'server.js');
const RUN_DIR = path.join(APP_ROOT, 'run');
const PID_FILE = path.join(RUN_DIR, 'nerovaagent.pid');
const MACHINE_HEADER = process.env.FLY_MACHINE_ID ? { 'Fly-Machine': process.env.FLY_MACHINE_ID } : null;

export function resolveConfig(overrides = {}) {
  const defaultPort = Number(process.env.NEROVA_AGENT_PORT || process.env.PORT || overrides.port || 3333);
  let baseUrl;
  try {
    baseUrl = new URL(process.env.NEROVA_AGENT_HTTP || overrides.baseUrl || `http://127.0.0.1:${defaultPort}`);
  } catch {
    baseUrl = new URL(`http://127.0.0.1:${defaultPort}`);
  }
  const port = Number(overrides.port || process.env.NEROVA_AGENT_PORT || process.env.PORT || baseUrl.port || defaultPort);
  if (!baseUrl.port) baseUrl.port = String(port);
  const origin = baseUrl.origin;
  const isLocal = overrides.hasOwnProperty('isLocal')
    ? !!overrides.isLocal
    : ['127.0.0.1', 'localhost', '::1'].includes(baseUrl.hostname);
  return { port, origin, url: baseUrl, isLocal };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isServerUp(origin) {
  try {
    const res = await fetch(new URL('/healthz', origin));
    return res.ok;
  } catch {
    return false;
  }
}

async function launchLocalDaemon(config) {
  await fs.mkdir(RUN_DIR, { recursive: true }).catch(() => {});
  try {
    const existingPid = Number(await fs.readFile(PID_FILE, 'utf8'));
    if (existingPid && Number.isFinite(existingPid)) {
      try {
        process.kill(existingPid, 0);
        return existingPid;
      } catch {
        // stale pid
      }
    }
  } catch {}

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(config.port),
      NEROVA_AGENT_PORT: String(config.port),
      NEROVA_AGENT_HTTP: config.origin,
      NEROVA_AGENT_ROOT: APP_ROOT
    }
  });
  child.unref();
  try { await fs.writeFile(PID_FILE, String(child.pid)); } catch {}
  return child.pid;
}

export async function ensureServer(config = resolveConfig()) {
  if (await isServerUp(config.origin)) return config;
  if (!config.isLocal) {
    throw new Error(`Agent runtime at ${config.origin} is not reachable`);
  }
  console.log('[nerovaagent] starting local runtime...');
  await launchLocalDaemon(config);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (await isServerUp(config.origin)) return config;
    await sleep(500);
  }
  throw new Error('Timed out waiting for nerova agent runtime to start');
}

export function createClient(overrides = {}) {
  const config = resolveConfig(overrides);
  return {
    config,
    ensureServer: () => ensureServer(config),
    async request(pathname, { method = 'GET', body } = {}) {
      await ensureServer(config);
      const url = new URL(pathname, config.origin);
      const headers = { 'Content-Type': 'application/json' };
      if (MACHINE_HEADER) Object.assign(headers, MACHINE_HEADER);
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
  };
}
