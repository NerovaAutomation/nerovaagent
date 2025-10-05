import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..');
const BIN_PATH = path.resolve(APP_ROOT, 'bin', 'nerovaagent.js');
const RUN_DIR = path.resolve(APP_ROOT, '..', '..', 'run');
const PID_FILE = path.join(RUN_DIR, 'agent-daemon.pid');

async function readPid() {
  try {
    const value = await fs.readFile(PID_FILE, 'utf8');
    const pid = Number(value.trim());
    if (Number.isFinite(pid)) return pid;
  } catch {}
  return null;
}

async function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureRunDir() {
  await fs.mkdir(RUN_DIR, { recursive: true }).catch(() => {});
}

const DEFAULT_AGENT_ID = process.env.NEROVA_AGENT_ID || `cli-${os.hostname()}`;

async function waitForAgentReady(origin, agentId) {
  if (typeof fetch !== 'function') return;
  if (!origin) return;
  const deadline = Date.now() + 20000;
  const url = (() => {
    try {
      const u = new URL('/healthz', origin);
      return u.toString();
    } catch {
      return null;
    }
  })();
  if (!url) return;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        const agents = Array.isArray(data?.agents) ? data.agents : [];
        if (!agentId || agents.some((a) => a && a.id === agentId)) return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  throw new Error('agent_ready_timeout');
}

export async function ensureAgentDaemon({ origin } = {}) {
  await ensureRunDir();
  const existingPid = await readPid();
  if (await isRunning(existingPid)) {
    try {
      await waitForAgentReady(origin, DEFAULT_AGENT_ID);
    } catch (err) {
      console.warn('[nerovaagent] agent readiness check failed', err?.message || err);
    }
    return existingPid;
  }

  const env = {
    ...process.env,
    NEROVA_AGENT_HTTP: origin || process.env.NEROVA_AGENT_HTTP,
    NEROVA_AGENT_ID: DEFAULT_AGENT_ID
  };

  const child = spawn(process.execPath, [BIN_PATH, 'agent-daemon'], {
    detached: true,
    stdio: 'ignore',
    env
  });
  child.unref();
  await fs.writeFile(PID_FILE, String(child.pid)).catch(() => {});
  try {
    await waitForAgentReady(origin, env.NEROVA_AGENT_ID);
  } catch (err) {
    console.warn('[nerovaagent] agent readiness check failed', err?.message || err);
  }
  return child.pid;
}

export async function stopAgentDaemon() {
  const pid = await readPid();
  if (!pid) return false;
  if (!(await isRunning(pid))) return false;
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

export async function isAgentDaemonRunning() {
  const pid = await readPid();
  return isRunning(pid);
}
