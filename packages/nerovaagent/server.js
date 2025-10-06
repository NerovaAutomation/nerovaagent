import express from 'express';
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import { attachAgent, listAgents, agentCount } from './lib/agents.js';
import { command as sendAgentCommand, ensureAgentInitialized } from './lib/remote-driver.js';
import { runAgentWorkflow } from './workflow/agent-workflow.js';
import { callCritic } from './lib/llm.js';
// Optional: http-proxy (used only for /console); tolerate absence
let createProxyServer = null;
try {
  const httpProxy = await import('http-proxy');
  const mod = httpProxy && (httpProxy.default || httpProxy);
  if (mod && typeof mod.createProxyServer === 'function') {
    createProxyServer = mod.createProxyServer.bind(mod);
  }
} catch {}
import { chromium } from '@playwright/test';
import fs from 'fs/promises';
import path from 'path';
import net from 'net';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
// Simple log helper with optional verbosity toggle
function log(...args) { 
  try { 
    if (process.env.LOG_VERBOSE === '0') return; 
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}]`, ...args);
    // Force flush stdout for Fly.io
    if (process.stdout.write) {
      process.stdout.write('');
    }
  } catch {} 
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const DATA_DIR = path.join(APP_ROOT, 'data');
const RECIPES_DIR = path.join(DATA_DIR, 'recipes');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const USER_DATA_DIR = path.join(APP_ROOT, 'user-data');
const RUN_LOG_DIR = path.join(APP_ROOT, 'logs', 'runs');

const logSubscribers = new Set();

function broadcastRunEvent(payload) {
  if (!payload) return;
  const data = JSON.stringify({ ...payload, timestamp: new Date().toISOString() });
  for (const res of logSubscribers) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {}
  }
}

const app = express();
// Basic HTTP request logger (concise)
app.use((req, _res, next) => { try { log('[http]', req.method, req.url); } catch {} next(); });
app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));
// CORS for local UI (and optional domains via ALLOWED_ORIGINS)
const allowedOrigins = (() => {
  const raw = String(process.env.ALLOWED_ORIGINS || 'http://localhost:3333,http://127.0.0.1:3333')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const set = new Set();
  for (const value of raw) {
    if (!value) continue;
    set.add(value);
    try {
      const parsed = new URL(value);
      if (parsed && parsed.protocol && parsed.host) {
        set.add(`${parsed.protocol}//${parsed.host}`);
      }
    } catch {}
  }
  return set;
})();

const WORKER_APP_NAME = process.env.WORKER_APP || process.env.FLY_WORKER_APP || 'webagent-worker';
const WORKER_APP_HOST = process.env.WORKER_APP_HOST || `${WORKER_APP_NAME}.fly.dev`;
const WORKER_IMAGE = process.env.WORKER_IMAGE || process.env.WORKER_MACHINE_IMAGE || null;
const WORKER_REGION = process.env.WORKER_REGION || process.env.FLY_REGION || 'iad';
const WORKER_MACHINE_TIMEOUT_MS = Number(process.env.WORKER_START_TIMEOUT_MS || 120000);
const FLY_MACHINES_API = process.env.FLY_MACHINE_API_BASE || 'https://api.machines.dev';
const FLY_MACHINE_TOKEN = process.env.FLY_MACHINE_TOKEN || process.env.FLY_API_TOKEN || null;
const SIGNAL_SERVER_URL = (process.env.SIGNAL_SERVER_URL || process.env.SIGNAL_URL || process.env.SIGNAL_BASE_URL || 'https://signal.nerova.app').trim().replace(/\/$/, '');
const SIGNAL_REQUEST_TIMEOUT_MS = Number(process.env.SIGNAL_REQUEST_TIMEOUT_MS || 10000);
const DEFAULT_BOOT_URL = process.env.PLAYWRIGHT_BOOT_URL || 'https://www.google.com';
const STREAM_WIDTH = (() => {
  const raw = Number(process.env.WEBRTC_W) || 1152;
  const clamped = Math.max(640, Math.min(1920, raw));
  return clamped % 2 === 0 ? clamped : clamped - 1;
})();
const STREAM_HEIGHT = (() => {
  const raw = Number(process.env.WEBRTC_H) || 648;
  const clamped = Math.max(360, Math.min(1080, raw));
  return clamped % 2 === 0 ? clamped : clamped - 1;
})();

let context = null;
let page = null;
let browser = null;
let browserStarting = null; // Promise guard to avoid concurrent launches
try { if (!process.env.DISPLAY) process.env.DISPLAY = ':0'; } catch {}
let windowHidden = false;           // current off-screen state
let windowHideOnNextLaunch = false; // request to launch first window off-screen
let screencastCdp = null;
let screencastActive = false;
let screencastLast = { buf: null, ts: 0 };
const screencastSubscribers = new Set(); // Set<WebSocket>

let controlPage = null;                 // Playwright page hosting /noplanner for server-side runs
let controlPageInitPromise = null;
let controlBrowser = null;              // headless browser for agent control UI
let controlBrowserInitPromise = null;
let controlRunActive = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestSignalerSession(machineId, ttlSeconds = 300) {
  if (!SIGNAL_SERVER_URL) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIGNAL_REQUEST_TIMEOUT_MS);
    const payload = { machineId, ttlSeconds };
    const resp = await fetch(`${SIGNAL_SERVER_URL}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || !data.ok) {
      const err = data && data.error ? data.error : `HTTP ${resp.status}`;
      throw new Error(err);
    }
    return data;
  } catch (err) {
    try { console.warn('[signaler] session request failed', err?.message || err); } catch {}
    return null;
  }
}

function enforceMachineAffinity(req, res) {
  try {
    const actual = (process.env.FLY_MACHINE_ID || '').trim();
    if (!actual) return true;
    const headerId = (req.headers['fly-machine'] || '').toString().trim();
    const queryId = (req.query && req.query.fly_machine ? req.query.fly_machine : '').toString().trim();
    const requested = headerId || queryId;
    const host = String(req.headers.host || '').split(':')[0];
    const hostMatches = host === `${actual}.vm.fly.dev` || host === actual;
    if (requested && requested !== actual) {
      res.status(404).json({ ok: false, error: 'wrong_machine' });
      return false;
    }
    if (!requested && !hostMatches) {
      res.status(428).json({ ok: false, error: 'missing_machine_binding' });
      return false;
    }
    return true;
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
    return false;
  }
}

app.use((req, res, next) => {
  try {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      const reqHeadersRaw = (req.headers['access-control-request-headers'] || '').toString().trim();
      if (reqHeadersRaw) {
        const lowerToOriginal = new Map();
        for (const part of reqHeadersRaw.split(',')) {
          const name = part.trim();
          if (!name) continue;
          const key = name.toLowerCase();
          if (!lowerToOriginal.has(key)) lowerToOriginal.set(key, name);
        }
        const ensure = (name) => {
          const key = name.toLowerCase();
          if (!lowerToOriginal.has(key)) lowerToOriginal.set(key, name);
        };
        ensure('Content-Type');
        ensure('Authorization');
        ensure('Fly-Machine');
        const allow = Array.from(lowerToOriginal.values()).join(', ');
        res.setHeader('Access-Control-Allow-Headers', allow);
      } else {
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Fly-Machine');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      // No credentials used by this UI; keep off for safety
      res.setHeader('Access-Control-Allow-Credentials', 'false');
    }
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  } catch {}
  next();
});
app.get('/interface', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'interface.html'));
});
app.get('/sandbox', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'sandbox.html'));
});
app.get('/noplanner', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'noplanner.html'));
});
app.get('/ui', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'ui.html'));
});

app.get('/logs/stream', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    await fs.mkdir(RUN_LOG_DIR, { recursive: true }).catch(() => {});
  } catch {}
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  try { res.flushHeaders?.(); } catch {}
  res.write('\n');
  logSubscribers.add(res);
  req.on('close', () => {
    logSubscribers.delete(res);
  });
});

// Lightweight health probe used by installer CLIs
app.get('/healthz', async (_req, res) => {
  try {
    const up = process.uptime();
    const state = {
      ok: true,
      uptime: up,
      browser: Boolean(browser && !browser.isClosed?.()),
      machine: {
        id: process.env.FLY_MACHINE_ID || null,
        app: process.env.FLY_APP_NAME || null,
        region: process.env.FLY_REGION || null
      },
      agents: listAgents()
    };
    res.json(state);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
});

app.post('/agent/snapshot', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    const agent = await ensureAgentInitialized();
    const [urlResult, shotResult] = await Promise.all([
      sendAgentCommand('URL', null, { agent }).catch(() => null),
      sendAgentCommand('SCREENSHOT', { options: { fullPage: false } }, { agent, timeout: 20000 })
    ]);
    const screenshot = shotResult?.data || shotResult?.result?.data || null;
    if (!screenshot) {
      throw new Error('screenshot_missing');
    }
    res.json({
      ok: true,
      url: urlResult?.url || '',
      screenshot,
      capturedAt: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/agent/hittables', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    const { max = 1000, minSize = 8 } = req.body || {};
    const agent = await ensureAgentInitialized();
    const response = await sendAgentCommand('GET_HITTABLES_VIEWPORT', {
      options: {
        max: Math.max(10, Math.min(5000, Number(max) || 1000)),
        minSize: Math.max(4, Math.min(100, Number(minSize) || 8))
      }
    }, { agent, timeout: 20000 });
    const elements = Array.isArray(response?.elements) ? response.elements : [];
    res.json({ ok: true, elements, count: elements.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/agent/command', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  const body = req.body || {};
  const action = String(body.action || '').toLowerCase();
  try {
    const agent = await ensureAgentInitialized();
    switch (action) {
      case 'click': {
        const vx = Number(body.vx);
        const vy = Number(body.vy);
        if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
          res.status(400).json({ ok: false, error: 'invalid_coordinates' });
          return;
        }
        await sendAgentCommand('CLICK_VIEWPORT', {
          vx,
          vy,
          button: body.button === 'right' ? 'right' : 'left',
          clickCount: Number(body.clickCount) === 2 ? 2 : 1
        }, { agent, timeout: 10000 });
        if (typeof body.text === 'string' && body.text.length > 0) {
          if (body.clear === true) {
            await sendAgentCommand('CLEAR_ACTIVE_INPUT', {}, { agent, timeout: 2000 }).catch(() => {});
          }
          await sendAgentCommand('TYPE_TEXT', { text: body.text, delay: 120 }, { agent, timeout: 10000 }).catch(() => {});
          if (body.submit === true) {
            await sendAgentCommand('PRESS_ENTER', null, { agent, timeout: 5000 }).catch(() => {});
          }
        }
        res.json({ ok: true });
        return;
      }
      case 'scroll': {
        const direction = body.direction === 'up' ? 'up' : 'down';
        await sendAgentCommand('SCROLL_UNIVERSAL', { direction }, { agent, timeout: 8000 }).catch(() => {});
        res.json({ ok: true });
        return;
      }
      case 'navigate': {
        const url = String(body.url || '').trim();
        if (!url) {
          res.status(400).json({ ok: false, error: 'missing_url' });
          return;
        }
        await sendAgentCommand('NAVIGATE', { url }, { agent, timeout: 20000 });
        res.json({ ok: true });
        return;
      }
      case 'back': {
        await sendAgentCommand('GO_BACK', null, { agent, timeout: 15000 }).catch(() => {});
        res.json({ ok: true });
        return;
      }
      case 'keypress': {
        const key = String(body.key || '').trim();
        if (!key) {
          res.status(400).json({ ok: false, error: 'missing_key' });
          return;
        }
        await sendAgentCommand('PRESS_KEY', { key }, { agent, timeout: 5000 }).catch(() => {});
        res.json({ ok: true });
        return;
      }
      default:
        res.status(400).json({ ok: false, error: 'unsupported_action' });
        return;
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post('/assistant/decision', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    const { prompt, target, candidates = [], screenshot, openaiApiKey, assistantId } = req.body || {};
    if (!screenshot || typeof screenshot !== 'string') {
      res.status(400).json({ ok: false, error: 'screenshot_required' });
      return;
    }
    const result = await callAssistantDecision({
      prompt: prompt || '',
      target: target || null,
      elements: Array.isArray(candidates) ? candidates.slice(0, 20) : [],
      screenshot,
      openaiApiKey,
      assistantId
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Launch a dedicated Fly.io machine for each run and return connection info
async function provisionWorkerMachine(runId, prompt = '') {
  if (!FLY_MACHINE_TOKEN) {
    throw new Error('FLY_MACHINE_TOKEN env not set');
  }
  if (!WORKER_IMAGE) {
    throw new Error('WORKER_IMAGE env not set');
  }
  const sanitizedId = runId && typeof runId === 'string'
    ? runId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || `run-${Date.now()}`
    : `run-${Date.now()}`;
  const machineName = `run-${sanitizedId}`.slice(0, 52);
  const headers = {
    Authorization: `Bearer ${FLY_MACHINE_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };
  const fqdn = `${machineName}.${WORKER_APP_NAME}.fly.dev`;
  const body = {
    name: machineName,
    region: WORKER_REGION,
    config: {
      image: WORKER_IMAGE,
      guest: {
        cpu_kind: 'performance',
        cpus: 8,
        memory_mb: 16384
      },
      services: [
        {
          protocol: 'tcp',
          internal_port: 3333,
          ports: [
            { port: 80, handlers: ['http'] },
            { port: 443, handlers: ['tls', 'http'] }
          ],
          concurrency: {
            type: 'connections',
            hard_limit: 200,
            soft_limit: 150
          }
        }
      ],
      restart: { policy: 'no' },
      metadata: { run_id: sanitizedId, 'fly.fqdn': fqdn },
      env: {
        RUN_ID: sanitizedId,
        BASE_PROMPT: String(prompt || '').slice(0, 800),
        ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || 'http://localhost:3333,http://127.0.0.1:3333',
        WEBRTC2_MODE: process.env.WEBRTC2_MODE || 'server',
        LOG_VERBOSE: process.env.LOG_VERBOSE || '1'
      }
    }
  };
  const createUrl = `${FLY_MACHINES_API}/v1/apps/${WORKER_APP_NAME}/machines`;
  const createResp = await fetch(createUrl, { method: 'POST', headers, body: JSON.stringify(body) });
  const createJson = await createResp.json().catch(() => ({}));
  if (!createResp.ok) {
    const msg = createJson && createJson.error ? createJson.error : `HTTP ${createResp.status}`;
    throw new Error(`Fly machine create failed: ${msg}`);
  }
  const machineId = createJson.id || createJson.Machine?.id;
  if (!machineId) {
    throw new Error('Fly machine create returned no id');
  }
  try {
    const hostLog = `${machineId}.vm.fly.dev`;
    log('[machines] created', machineId, 'for run', sanitizedId, 'host', hostLog);
  } catch {}
  const statusUrl = `${FLY_MACHINES_API}/v1/apps/${WORKER_APP_NAME}/machines/${machineId}`;
  const deadline = Date.now() + WORKER_MACHINE_TIMEOUT_MS;
  let state = createJson.state || createJson.status?.state || 'starting';
  while (Date.now() < deadline) {
    const statusResp = await fetch(statusUrl, { headers });
    const statusJson = await statusResp.json().catch(() => ({}));
    state = statusJson.state || statusJson.status?.state || statusJson.current_state || state;
    if (state === 'started' || state === 'running') {
      break;
    }
    await sleep(1500);
  }
  if (state !== 'started' && state !== 'running') {
    throw new Error(`Fly machine did not start in time (state=${state})`);
  }
  let httpBase = `https://${WORKER_APP_HOST}`;
  let wsBase = httpBase.replace(/^https:/, 'wss:');
  const machineHost = `https://${machineId}.vm.fly.dev`;
  const readyDeadline = Date.now() + WORKER_MACHINE_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < readyDeadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const baseUrl = `${httpBase}/webrtc/config?fly_machine=${machineId}`;
      const ping = await fetch(baseUrl, { method: 'GET', signal: controller.signal, headers: { 'Fly-Machine': machineId } });
      clearTimeout(timer);
      if (ping.ok || ping.status === 410) {
        ready = true;
        break;
      }
      if (ping.status >= 200 && ping.status < 500) {
        ready = true;
        break;
      }
    } catch (err) {
      try { log('[machines] primary health check failed', machineId, err?.message || err); } catch {}
      try {
        const altController = new AbortController();
        const altTimer = setTimeout(() => altController.abort(), 5000);
        const altPing = await fetch(`${machineHost}/webrtc/config`, { method: 'GET', signal: altController.signal });
        clearTimeout(altTimer);
        if (altPing.ok || altPing.status === 410 || (altPing.status >= 200 && altPing.status < 500)) {
          httpBase = `https://${WORKER_APP_HOST}`;
          wsBase = httpBase.replace(/^https:/, 'wss:');
          ready = true;
          break;
        }
      } catch {}
    }
    await sleep(1500);
  }
  if (!ready) {
    console.warn('[machines] worker started but health check timed out', machineId);
  }
  const httpBaseTrimmed = httpBase.replace(/\/$/, '');
  const viewerUrl = `${httpBaseTrimmed}/webrtc?autoconnect=1&mode=viewer&fly_machine=${machineId}`;
  const directViewerUrl = machineHost ? `${machineHost.replace(/\/$/, '')}/webrtc?autoconnect=1&mode=viewer&fly_machine=${machineId}` : null;
  const directWs = machineHost ? machineHost.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') : null;
  const signalSession = await requestSignalerSession(machineId);
  return {
    machineId,
    httpBase: httpBaseTrimmed,
    wsBase,
    machineHost,
    directWs,
    viewerUrl,
    directViewerUrl,
    signal: signalSession ? signalSession.signaling : null,
    ice: signalSession ? signalSession.ice : null
  };
}

async function startRemoteRunOnWorker(info, prompt) {
  const runPrompt = String(prompt || '').trim();
  if (!info || !info.httpBase || !info.machineId || !runPrompt) return;
  const url = `${info.httpBase.replace(/\/$/, '')}/run/start`;
  const headers = {
    'Content-Type': 'application/json',
    'Fly-Machine': info.machineId
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WORKER_MACHINE_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt: runPrompt }),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`remote_run_status_${resp.status}: ${text}`);
    }
    try { log('[machines] remote run triggered', info.machineId); } catch {}
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

app.post('/machines/start', async (req, res) => {
  try {
    const body = req.body || {};
    const requestedRunId = typeof body.runId === 'string' && body.runId.trim() ? body.runId.trim() : (crypto.randomUUID ? crypto.randomUUID() : `run-${Date.now()}`);
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const info = await provisionWorkerMachine(requestedRunId, prompt);
    try {
      await startRemoteRunOnWorker(info, prompt);
    } catch (err) {
      try { log('[machines] remote run trigger failed', err?.message || err); } catch {}
    }
    res.json({
      ok: true,
      machineId: info.machineId,
      httpBase: info.httpBase,
      wsBase: info.wsBase,
      machineHost: info.machineHost,
      directWs: info.directWs,
      viewerUrl: info.viewerUrl,
      directViewerUrl: info.directViewerUrl,
      bootUrl: DEFAULT_BOOT_URL,
      streamDimensions: { width: STREAM_WIDTH, height: STREAM_HEIGHT },
      signaling: info.signal || null,
      ice: info.ice || null,
      runTriggered: true
    });
  } catch (e) {
    console.error('[machines] start error', e?.message || e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/run/start', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    const body = req.body || {};
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    const contextNotes = typeof body.contextNotes === 'string' ? body.contextNotes : '';
    const criticKey = typeof body.criticKey === 'string' ? body.criticKey : null;
    const assistantKey = typeof body.assistantKey === 'string' ? body.assistantKey : null;
    const assistantId = typeof body.assistantId === 'string' ? body.assistantId : (process.env.ASSISTANT_ID2 || null);
    const run = await startRemoteAgent({
      prompt,
      contextNotes,
      criticKey,
      assistantKey,
      assistantId
    });
    res.json(run);
  } catch (err) {
    console.error('[run] start error', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Allow local CLI tooling to prelaunch the browser context without starting a run
app.post('/runtime/playwright/launch', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    if (agentCount() > 0) {
      const agent = await ensureAgentInitialized();
      let viewport = null;
      try {
        const vp = await sendAgentCommand('VIEWPORT', null, { agent, timeout: 5000 });
        viewport = vp && vp.viewport ? vp.viewport : vp || null;
      } catch {}
      res.json({ ok: true, status: 'ready', viewport });
      return;
    }
    await ensureBrowser();
    let viewport = null;
    if (page) {
      try { viewport = await page.viewportSize(); } catch {}
    }
    res.json({ ok: true, status: 'ready', viewport });
  } catch (err) {
    console.error('[runtime] playwright launch failed', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Minimal WebRTC viewer
app.get('/webrtc', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'webrtc.html'));
});

// Default to XPRA WebRTC bridge for /webrtc2
app.get('/webrtc2', async (req, res) => {
  const mode = String(process.env.WEBRTC2_MODE || 'xpra').toLowerCase();
  if (mode === 'xpra') {
    // Pre-flight: check xpra is listening to return a clearer error
    const ok = await new Promise((resolve) => {
      try {
        const c = net.connect({ host: '127.0.0.1', port: 14500 }, () => { try { c.destroy(); } catch {} resolve(true); });
        c.setTimeout(500, () => { try { c.destroy(); } catch {} resolve(false); });
        c.on('error', () => resolve(false));
      } catch { resolve(false); }
    });
    if (!ok) {
      res.status(503).type('text/plain').send('xpra not listening on 127.0.0.1:14500. Check /xpra/health and /xpra/logs');
      return;
    }
    // Redirect to the proxied Xpra HTML5 client
    res.redirect('/xpra/');
    return;
  }
  res.sendFile(path.join(PUBLIC_DIR, 'webrtc2.html'));
});

// Config for v2
app.get('/webrtc2/config', (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  const mode = String(process.env.WEBRTC2_MODE || 'xpra').toLowerCase();
  if (mode === 'xpra') return res.status(410).json({ error: 'disabled_in_xpra_mode' });
  try {
    let iceServers = null;
    try {
      const raw = process.env.WEBRTC_ICE_SERVERS;
      if (raw) iceServers = JSON.parse(raw);
    } catch {}
    if (!Array.isArray(iceServers) || iceServers.length === 0) {
      iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    }
    res.json({ iceServers });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Clean WebRTC v2 offer handler - minimal, direct streaming
app.post('/webrtc2/offer', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  const mode0 = String(process.env.WEBRTC2_MODE || 'xpra').toLowerCase();
  if (mode0 === 'xpra') { return res.status(410).json({ error: 'disabled_in_xpra_mode' }); }
  console.log('[webrtc2] Received offer request');
  try {
    const { offer } = req.body;
    if (!offer) {
      console.log('[webrtc2] ERROR: No offer provided');
      return res.status(400).json({ error: 'No offer provided' });
    }
    
    console.log('[webrtc2] Ensuring browser...');
    await ensureBrowser();

    // Native in-browser WebRTC path for maximum FPS and fidelity
    // Default to server-side pipeline for consistent 30fps on headless servers
    const mode = String(process.env.WEBRTC2_MODE || 'server').toLowerCase();
    if (mode === 'native') {
      try {
        const viewport = await page.viewportSize();
        const dims = { width: viewport?.width || 1280, height: viewport?.height || 720 };
        const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
        const result = await page.evaluate(async ({ offer, dims, iceServers }) => {
          const waitForIce = (pc) => new Promise((resolve) => {
            if (pc.iceGatheringState === 'complete') { resolve(); return; }
            const t = setTimeout(resolve, 3000);
            pc.addEventListener('icegatheringstatechange', () => {
              if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
            });
          });
          if (!window.__w2pc) {
            window.__w2pc = new RTCPeerConnection({ iceServers });
            try {
              const stream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { ideal: 30, max: 30 }, width: dims.width, height: dims.height, displaySurface: 'window' },
                audio: false
              });
              const track = stream.getVideoTracks()[0];
              try { track.contentHint = 'detail'; } catch {}
              try { await track.applyConstraints({ frameRate: { ideal: 30, max: 30 } }); } catch {}
              const sender = window.__w2pc.addTrack(track, stream);
              // Prefer H.264 if available
              try {
                const tx = window.__w2pc.getTransceivers().find(t => t.sender && t.sender.track && t.sender.track.kind === 'video');
                if (tx && tx.setCodecPreferences) {
                  const h264 = RTCRtpSender.getCapabilities('video').codecs.filter(c => /H264/gi.test(c.mimeType || c.sdpFmtpLine || ''));
                  const rest = RTCRtpSender.getCapabilities('video').codecs.filter(c => !/H264/gi.test(c.mimeType || c.sdpFmtpLine || ''));
                  if (h264 && h264.length) tx.setCodecPreferences([...h264, ...rest]);
                }
              } catch {}
              // Try to pin 30fps and a sane bitrate
              try {
                const params = sender.getParameters();
                params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
                if (params.encodings[0]) {
                  params.encodings[0].maxFramerate = 30;
                  params.encodings[0].maxBitrate = 4_000_000; // 4 Mbps
                  params.encodings[0].scaleResolutionDownBy = 1;
                }
                await sender.setParameters(params);
              } catch {}
              // Keep a tiny offscreen painter to ensure continuous paints
              try {
                if (!document.getElementById('__w2_paint__')) {
                  const d = document.createElement('div');
                  d.id = '__w2_paint__';
                  d.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;background:#000;opacity:0;';
                  document.documentElement.appendChild(d);
                  let t0 = 0;
                  const tick = (ts) => { try { if (ts - t0 > 16) { d.style.opacity = d.style.opacity === '0' ? '0.01' : '0'; t0 = ts; } } catch {} requestAnimationFrame(tick); };
                  requestAnimationFrame(tick);
                }
              } catch {}
            } catch (e) {
              return { error: 'getDisplayMedia failed: ' + (e && e.message || String(e)) };
            }
          }
          const pc = window.__w2pc;
          await pc.setRemoteDescription(offer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await waitForIce(pc);
          const s = pc.getTransceivers()[0]?.sender?.track?.getSettings?.() || {};
          return { answer: pc.localDescription, dims: { width: s.width || dims.width, height: s.height || dims.height } };
        }, { offer, dims, iceServers });
        if (result && result.error) throw new Error(result.error);
        const response = { answer: result.answer, dimensions: result.dims };
        res.json(response);
        console.log('[webrtc2] Native in-browser WebRTC answer sent', response.dimensions);
        // Proactively tick headless frames to sustain capture FPS
        try {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('Page.enable').catch(()=>{});
          await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(()=>{});
          await cdp.send('HeadlessExperimental.enable').catch(()=>{});
          const pumpFps = Math.max(10, Math.min(120, Number(process.env.WEBRTC2_PUMP_FPS) || 120));
          const interval = Math.floor(1000 / pumpFps);
          const timer = setInterval(() => {
            cdp.send('HeadlessExperimental.beginFrame', {
              frameTimeTicks: Date.now(),
              interval: 1 / pumpFps,
              noDisplayUpdates: false,
              screenshot: false
            }).catch(()=>{});
          }, interval);
          // Cleanup on process exit
          try { process.on('exit', () => { try { clearInterval(timer); } catch {}; try { cdp.detach(); } catch {}; }); } catch {}
        } catch {}
        return;
      } catch (e) {
        console.log('[webrtc2] Native mode failed, falling back:', e && e.message || String(e));
        // continue to server-side pipeline
      }
    }
    
    // Get ACTUAL viewport dimensions - what screenshot will capture
    const viewport = await page.viewportSize();
    let streamWidth = viewport?.width || 1280;
    let streamHeight = viewport?.height || 720;
    
    // Ensure even dimensions for YUV420p
    streamWidth = streamWidth % 2 === 0 ? streamWidth : streamWidth - 1;
    streamHeight = streamHeight % 2 === 0 ? streamHeight : streamHeight - 1;
    
    console.log('[webrtc2] Using viewport dimensions:', streamWidth, 'x', streamHeight);
    
    // Import WebRTC and video processing modules
    const wrtcMod = await import('wrtc');
    const wrtc = (wrtcMod && (wrtcMod.default || wrtcMod)) || {};
    const { RTCPeerConnection, RTCSessionDescription, MediaStream, nonstandard } = wrtc;
    const { spawn } = await import('child_process');
    // Optional: turbojpeg for in-process JPEG->I420 (faster than ffmpeg)
    let turbo = null;
    let turboReady = false;
    try {
      const tmod = await import('jpeg-turbo');
      turbo = (tmod && (tmod.default || tmod)) || null;
      // validate api present
      if (turbo && (turbo.decompressSync || turbo.decompress) && turbo.TJPF && (turbo.TJPF.I420 || turbo.TJPF.TJPF_I420)) {
        turboReady = String(process.env.WEBRTC2_DECODE || 'turbo').toLowerCase() !== 'ffmpeg';
      }
    } catch {}
    try { console.log('[webrtc2] JPEG decoder:', turboReady ? 'turbojpeg' : 'ffmpeg'); } catch {}
    
    if (!RTCPeerConnection) {
      throw new Error('RTCPeerConnection not available from wrtc');
    }
    
    // Get RTCVideoSource from nonstandard
    const { RTCVideoSource } = (nonstandard || {});
    if (!RTCVideoSource) {
      console.log('[webrtc2] ERROR: RTCVideoSource not available in wrtc.nonstandard');
      console.log('[webrtc2] Available nonstandard:', nonstandard ? Object.keys(nonstandard) : 'nonstandard is null');
      throw new Error('RTCVideoSource not available from wrtc');
    }
    
    console.log('[webrtc2] Creating peer connection...');
    // Create peer connection
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    
    console.log('[webrtc2] Creating video source and track...');
    // Create video source and track
    const videoSource = new RTCVideoSource();
    const track = videoSource.createTrack();
    
    // Create MediaStream if available
    if (MediaStream) {
      const stream = new MediaStream();
      stream.addTrack(track);
      pc.addTrack(track, stream);
    } else {
      pc.addTrack(track);
    }
    
    console.log('[webrtc2] Track added to peer connection');
    // Re-enforce viewport size to ensure CDP captures match expected WxH
    try { await page.setViewportSize({ width: streamWidth, height: streamHeight }); } catch {}
    
    // Setup encoding parameters (bitrate/framerate)
    try {
      const sender = pc.getSenders()[0];
      if (sender && sender.getParameters) {
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [];
        // Avoid changing encoding count; only tune if one exists
        if (params.encodings.length > 0) {
          const enc = params.encodings[0];
          const maxKbps = Math.max(500_000, Math.min(10_000_000, Number(process.env.WEBRTC2_MAX_BITRATE) || 3_000_000));
          const fpsCap = Math.max(5, Math.min(60, Number(process.env.WEBRTC2_FPS) || 45));
          enc.maxBitrate = maxKbps;
          enc.maxFramerate = fpsCap;
          if (sender.setParameters) {
            await sender.setParameters(params);
            console.log('[webrtc2] Encoding parameters set (maxBitrate=%d, maxFramerate=%d)', maxKbps, fpsCap);
          }
        }
      }
    } catch (e) {
      console.log('[webrtc2] Could not set encoding parameters:', e.message);
      // Continue anyway - not critical
    }
    
    // FFmpeg for JPEG to YUV420p conversion (fallback if turbojpeg not available)
    const frameSize = (streamWidth * streamHeight * 3) >> 1; // YUV420p size
    let ffmpeg = null;
    let ffmpegBuffer = Buffer.alloc(0);
    
    console.log('[webrtc2] Expected frame size:', frameSize, 'bytes for', streamWidth, 'x', streamHeight);
    
    function startFFmpeg(vfFilter = null, setSize = true) {
      if (ffmpeg && !ffmpeg.killed) return;
      
      // More explicit FFmpeg parameters to ensure exact output
      const ffThreads = String(process.env.WEBRTC2_FFMPEG_THREADS || '4');
      const args = [
        // Low-latency, minimal buffering
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-probesize', '32',
        '-analyzeduration', '0',
        '-thread_queue_size', '2048',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-i', '-',
        '-f', 'rawvideo',
        '-pix_fmt', 'yuv420p',
        // Avoid vsync frame duplication/delay
        '-vsync', '0',
        // Filter chain (crop/scale) passed per capture mode
        '-vf', vfFilter || `scale=${streamWidth}:${streamHeight}:flags=fast_bilinear:force_original_aspect_ratio=decrease,pad=${streamWidth}:${streamHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1/1`,
      ];
      // Do not force -s; rely on vf chain to produce exact WxH
      args.push('-threads', ffThreads, 'pipe:1');
      ffmpeg = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] }); // Capture stderr for debugging
      
      let canWrite = true; // backpressure flag for stdin (set below)

      ffmpeg.stdout.on('data', (chunk) => {
        ffmpegBuffer = Buffer.concat([ffmpegBuffer, chunk]);
        
        // Process complete frames only
        while (ffmpegBuffer.length >= frameSize) {
          const frame = ffmpegBuffer.subarray(0, frameSize);
          ffmpegBuffer = ffmpegBuffer.subarray(frameSize);
          
          // Double-check frame size
          if (frame.length !== frameSize) {
            console.error('[webrtc2] Frame size mismatch! Expected:', frameSize, 'Got:', frame.length, 'Restarting ffmpeg...');
            try { ffmpeg.kill(); } catch {}
            ffmpeg = null; ffmpegBuffer = Buffer.alloc(0);
            startFFmpeg(vfFilter, setSize);
            break;
          }
          
          try {
            videoSource.onFrame({
              width: streamWidth,
              height: streamHeight,
              data: frame
            });
          } catch (e) {
            console.error('[webrtc2] onFrame error:', e.message, 'Frame size:', frame.length);
          }
        }
      });
      
      ffmpeg.stderr.on('data', (data) => {
        // Log FFmpeg stderr for debugging (only first few lines to avoid spam)
        const lines = data.toString().split('\n').slice(0, 3);
        lines.forEach(line => {
          if (line.includes('Stream') || line.includes('Error') || line.includes('Warning')) {
            console.log('[webrtc2] FFmpeg:', line);
          }
        });
      });
      
      ffmpeg.on('error', (e) => console.error('[webrtc2] FFmpeg spawn error:', e.message));
      ffmpeg.on('exit', (code, signal) => {
        console.log('[webrtc2] FFmpeg exited with code:', code, 'signal:', signal);
      });
      try {
        ffmpeg.stdin.on('drain', () => { canWrite = true; });
      } catch {}
    }

    async function restartFFmpeg(vfFilter = null, setSize = true) {
      try {
        if (ffmpeg) {
          try { ffmpeg.kill(); } catch {}
        }
      } catch {}
      ffmpeg = null; ffmpegBuffer = Buffer.alloc(0);
      startFFmpeg(vfFilter, setSize);
    }
    
    function decodeAndPushJPEG(jpegBuf) {
      if (!turboReady || !turbo) return false;
      try {
        // Prefer sync decompress for predictable pacing
        const fmt = (turbo.TJPF && (turbo.TJPF.I420 || turbo.TJPF.TJPF_I420)) || 'I420';
        const out = turbo.decompressSync ? turbo.decompressSync(jpegBuf, { format: fmt }) : null;
        const yuv = out && (out.data || out);
        if (!yuv || yuv.length !== frameSize) return false;
        videoSource.onFrame({ width: streamWidth, height: streamHeight, data: yuv });
        return true;
      } catch (e) {
        try { console.log('[webrtc2] turbo decode error:', e && e.message || String(e)); } catch {}
        return false;
      }
    }
    
    // Streaming loop
    let streaming = true;
    pc.onconnectionstatechange = () => {
      console.log('[webrtc2] Connection state:', pc.connectionState);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        streaming = false;
        if (ffmpeg) ffmpeg.kill();
      }
    };

    // DataChannel for control (clicks, etc.) initiated by the client offer
    pc.ondatachannel = (evt) => {
      try {
        const dc = evt && evt.channel;
        if (!dc) return;
        console.log('[webrtc2] DataChannel opened:', dc.label);
        dc.onmessage = async (e) => {
          try {
            let msg = null;
            try { msg = JSON.parse(String(e.data || '')); } catch {}
            if (!msg || typeof msg !== 'object') return;
            await ensureBrowser();
            if (msg.type === 'CLICK_VIEWPORT') {
              const vx = Math.round(Number(msg.vx || 0));
              const vy = Math.round(Number(msg.vy || 0));
              console.log('[webrtc2-dc] CLICK_VIEWPORT received:', vx, vy);
              try {
                // Always operate on the most recent non-blank page
                try {
                  const pages = browser.pages();
                  let pick = pages[pages.length - 1];
                  for (let i = pages.length - 1; i >= 0; i--) {
                    try { const u = await pages[i].url(); if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; } } catch {}
                  }
                  if (pick) page = pick;
                } catch {}
                try { await page.bringToFront(); } catch {}
                const vp = await page.viewportSize();
                const cx = Math.max(0, Math.min(vp.width - 1, vx));
                const cy = Math.max(0, Math.min(vp.height - 1, vy));
                // Optional: verify hittable target
                try {
                  const info = await page.evaluate(({x,y}) => {
                    const el = document.elementFromPoint(x, y);
                    return { tag: el && el.tagName || null, id: el && el.id || null, cls: el && el.className || null };
                  }, {x: cx, y: cy});
                  console.log('[webrtc2-dc] target at', cx, cy, info);
                } catch {}
                await page.mouse.move(cx, cy);
                await page.mouse.click(cx, cy, { button: 'left', clickCount: 1, delay: 0 });
                try { dc.send(JSON.stringify({ ok: true, type: 'CLICKED' })); } catch {}
              } catch (err) {
                console.error('[webrtc2-dc] CLICK error:', err && err.message || String(err));
                try { dc.send(JSON.stringify({ ok: false, type: 'CLICKED', error: String(err && err.message || err) })); } catch {}
              }
              return;
            }
          } catch {}
        };
        dc.onclose = () => { try { console.log('[webrtc2] DataChannel closed:', dc.label); } catch {} };
        dc.onerror = (err) => { try { console.log('[webrtc2] DataChannel error:', err && err.message || String(err)); } catch {} };
      } catch {}
    };
    
    // Capture loop (supports screencast-cropped or screenshot)
    (async () => {
      // Prefer CDP captureScreenshot by default; maintains 1:1 viewport and sustains 30fps
      const capMode = String(process.env.WEBRTC2_CAPTURE || 'cdp').toLowerCase();
      // Allow higher headroom by default; auto-adapt JPEG to sustain
      const targetFps = Math.max(10, Math.min(120, Number(process.env.WEBRTC2_FPS) || 60));
      let frameCount = 0;
      let lastLog = Date.now();
      let nextFrameAt = Date.now();
      // Start with moderate JPEG Q and adapt; clamp to 20..60 to keep quality while sustaining fps
      let jpegQ = Math.max(20, Math.min(60, Number(process.env.WEBRTC2_JPEG_Q) || 35));
      let dropped = 0;
      // Screencast mode: fastest, cropped to viewport to mimic screenshots
      if (capMode === 'screencast') {
        // Assume screencast frames already match viewport; avoid costly scaling
        const vf = `crop=${streamWidth}:${streamHeight}:0:0,setsar=1/1`;
        if (!turboReady) {
          // Do not force -s; use input size as-is to minimize work
          startFFmpeg(vf, false);
        }
        let cdp = null;
        let screencastStarted = false;
        let pump = null;
        let scWatch = null;
        let lastFrameTs = 0;
        try {
          cdp = await page.context().newCDPSession(page);
          // Keep page active and try to drive frames in headless
          try { await cdp.send('Page.setWebLifecycleState', { state: 'active' }); } catch {}
          try { await cdp.send('HeadlessExperimental.enable'); } catch {}
          try { await cdp.send('Page.enable'); } catch {}
          const scQ = Math.max(30, Math.min(60, Number(process.env.WEBRTC2_JPEG_Q) || 30));
          await cdp.send('Page.startScreencast', {
            format: 'jpeg',
            quality: scQ,
            maxWidth: streamWidth,
            maxHeight: streamHeight,
            everyNthFrame: 1
          });
          console.log('[webrtc2] Screencast started (cropped to viewport)');
          screencastStarted = true;
          // Proactively tick frames in headless to avoid idle throttling
          try {
            const pumpFps = Math.max(10, Math.min(60, Number(process.env.WEBRTC2_PUMP_FPS) || 60));
            const interval = Math.floor(1000 / pumpFps);
            pump = setInterval(async () => {
              try {
                await cdp.send('HeadlessExperimental.beginFrame', {
                  frameTimeTicks: Date.now(),
                  interval: 1 / pumpFps,
                  noDisplayUpdates: false,
                  screenshot: false
                });
              } catch {}
            }, interval);
          } catch {}
          let droppedSc = 0;
          cdp.on('Page.screencastFrame', async (evt) => {
            try {
              if (!streaming || pc.connectionState === 'closed') return;
              // Ack first to keep Chrome pushing frames
              try { await cdp.send('Page.screencastFrameAck', { sessionId: evt.sessionId }); } catch {}
              lastFrameTs = Date.now();
              const buf = Buffer.from(evt.data || '', 'base64');
              if (turboReady) {
                const ok = decodeAndPushJPEG(buf);
                if (!ok) droppedSc++;
                frameCount++;
              } else if (ffmpeg && !ffmpeg.killed) {
                const wrote = ffmpeg.stdin.write(buf);
                if (!wrote) droppedSc++;
                frameCount++;
              const now = Date.now();
                if (now - lastLog > 5000) {
                  const actualFps = Math.round((frameCount * 1000) / (now - lastLog));
                  console.log('[webrtc2] Streaming at', actualFps, 'fps (screencast-', turboReady?'turbo':'ffmpeg', ')', 'dropped:', droppedSc, 'jpegQ:', scQ);
                  frameCount = 0;
                  droppedSc = 0;
                  lastLog = now;
                }
              }
            } catch (e) {
              console.error('[webrtc2] Screencast frame error:', e && e.message || String(e));
            }
          });

          // Watchdog: if screencast stalls, fall back to captureScreenshot loop
          scWatch = setInterval(async () => {
            try {
              const gap = Date.now() - (lastFrameTs || 0);
              if (gap > 1500 && streaming && pc.connectionState !== 'closed') {
                console.log('[webrtc2] Screencast stalled (', gap, 'ms ). Switching to captureScreenshot loop.');
                try { await cdp.send('Page.stopScreencast'); } catch {}
                try { await cdp.detach(); } catch {}
                try { if (pump) clearInterval(pump); } catch {}
                try { if (scWatch) clearInterval(scWatch); } catch {}
                if (!turboReady) {
                  // Restart FFmpeg to enforce exact WxH for capture loop
                  await restartFFmpeg(`scale=${streamWidth}:${streamHeight}:flags=fast_bilinear,setsar=1/1`, true);
                }
                // Start captureScreenshot loop writing into the new ffmpeg
                let localJpegQ = Math.max(30, Math.min(60, Number(process.env.WEBRTC2_JPEG_Q) || 30));
                let localNext = Date.now();
                let cap = null;
                try { cap = await page.context().newCDPSession(page); await cap.send('Page.enable'); } catch {}
                (async () => {
                  while (streaming && pc.connectionState !== 'closed') {
                    const now = Date.now();
                    if (now < localNext) { await new Promise(r => setTimeout(r, Math.max(0, localNext - now))); }
                    const t0 = Date.now();
                    try {
                      const vp = await page.viewportSize();
                      const clip = vp && vp.width && vp.height ? { x: 0, y: 0, width: vp.width, height: vp.height, scale: 1 } : undefined;
                      const resp = cap ? await cap.send('Page.captureScreenshot', { format: 'jpeg', quality: localJpegQ, fromSurface: true, captureBeyondViewport: false, clip }) : null;
                      const buf = Buffer.from(String(resp && resp.data || ''), 'base64');
                      if (turboReady) {
                        const ok = decodeAndPushJPEG(buf);
                        if (!ok) droppedSc++;
                        frameCount++;
                      } else if (ffmpeg && !ffmpeg.killed) {
                        ffmpeg.stdin.write(buf);
                        frameCount++;
                        const t1 = Date.now();
                        const budget = 1000 / targetFps;
                        localNext = t0 + Math.max(0, budget);
                        if (t1 - lastLog > 5000) {
                          const actualFps = Math.round((frameCount * 1000) / (t1 - lastLog));
                          console.log('[webrtc2] Streaming at', actualFps, 'fps (cdp-capture-', turboReady?'turbo':'ffmpeg', ')');
                          frameCount = 0; lastLog = t1;
                        }
                      }
                    } catch {}
                  }
                  try { if (cap) await cap.detach(); } catch {}
                })();
              }
            } catch {}
          }, 1000);
        } catch (e) {
          console.log('[webrtc2] Screencast unavailable, falling back to screenshots:', e && e.message || String(e));
          try { await cdp?.detach(); } catch {}
          // fallthrough to screenshot path below
        }
        if (screencastStarted) {
          // Cleanup when connection ends
          const cleanup = async () => {
            try { await cdp?.send('Page.stopScreencast'); } catch {}
            try { await cdp?.detach(); } catch {}
            try { if (pump) clearInterval(pump); } catch {}
            try { if (scWatch) clearInterval(scWatch); } catch {}
            if (ffmpeg) ffmpeg.kill();
          };
          pc.addEventListener('connectionstatechange', async () => {
            if (pc.connectionState === 'closed' || pc.connectionState === 'failed' || pc.connectionState === 'disconnected') { await cleanup(); }
          });
          return; // main loop done; watchdog may start fallback loop
        }
      }
      // Default to screenshot capture; set WEBRTC2_CAPTURE=cdp to use CDP captureScreenshot
      const tryCdp = capMode !== 'shot' && capMode !== 'screenshot';
      let cdp = null;
      if (tryCdp) {
        try {
          cdp = await page.context().newCDPSession(page);
          console.log('[webrtc2] Using CDP session (jpegQ', jpegQ, ')');
        } catch (e) {
          console.log('[webrtc2] CDP capture unavailable, falling back:', e && e.message || String(e));
          cdp = null;
        }
      }
      console.log('[webrtc2] Starting screenshot capture loop... (mode:', cdp ? 'cdp' : 'shot', ')');
      let cdpStats = { w: streamWidth, h: streamHeight };
      if (!turboReady) {
        startFFmpeg(`scale=${streamWidth}:${streamHeight}:flags=fast_bilinear,setsar=1/1`);
      }
      // Proactively tick frames in headless to sustain paint cadence
      let pumpSS = null;
      if (cdp) {
        try {
          await cdp.send('Page.enable').catch(()=>{});
          await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(()=>{});
          await cdp.send('HeadlessExperimental.enable').catch(()=>{});
          const pumpFps = Math.max(10, Math.min(120, Number(process.env.WEBRTC2_PUMP_FPS) || 120));
          const interval = Math.floor(1000 / pumpFps);
          pumpSS = setInterval(() => {
            try {
              cdp.send('HeadlessExperimental.beginFrame', {
                frameTimeTicks: Date.now(),
                interval: 1 / pumpFps,
                noDisplayUpdates: false,
                screenshot: false
              }).catch(()=>{});
            } catch {}
          }, interval);
        } catch {}
      }
      while (streaming && pc.connectionState !== 'closed') {
        const now = Date.now();
        if (now < nextFrameAt) { await new Promise(r => setTimeout(r, Math.max(0, nextFrameAt - now))); }
        const t0 = Date.now();
        try {
          let screenshot;
          if (cdp) {
            const vp = await page.viewportSize();
            const clip = vp && vp.width && vp.height ? { x: 0, y: 0, width: vp.width, height: vp.height, scale: 1 } : undefined;
            let used = 'beginFrame';
            let resp = null;
            try {
              resp = await cdp.send('HeadlessExperimental.beginFrame', {
                frameTimeTicks: Date.now(),
                interval: 1 / Math.max(10, Math.min(120, Number(process.env.WEBRTC2_FPS) || 60)),
                noDisplayUpdates: false,
                screenshot: { format: 'jpeg', quality: jpegQ, clip }
              });
            } catch {}
            let b64 = resp && resp.screenshotData;
            if (!b64) {
              used = 'captureScreenshot';
              const r2 = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: jpegQ, fromSurface: true, captureBeyondViewport: false, clip });
              b64 = String(r2 && r2.data || '');
            }
            screenshot = Buffer.from(b64 || '', 'base64');
            try { cdpStats = { w: vp?.width||0, h: vp?.height||0, q: jpegQ, method: used }; } catch {}
          } else {
            screenshot = await page.screenshot({ type: 'jpeg', quality: jpegQ, fullPage: false });
          }
          if (turboReady) {
            const ok = decodeAndPushJPEG(screenshot);
            if (!ok) { dropped++; }
            frameCount++;
            const t1 = Date.now();
            const budget = 1000 / targetFps;
            const elapsed = t1 - t0;
            nextFrameAt = t0 + Math.max(0, budget);
            if (elapsed > budget) nextFrameAt = t1;
            // Adaptive JPEG quality: keep within budget
            if (elapsed > budget * 1.1 && jpegQ > 30) {
              const newQ = Math.max(30, jpegQ - 2);
              if (newQ !== jpegQ) { jpegQ = newQ; console.log('[webrtc2] Adjust JPEG_Q down to', jpegQ, '(elapsed', elapsed, 'ms)'); }
            } else if (elapsed < budget * 0.6 && jpegQ < 60) {
              const newQ = Math.min(60, jpegQ + 2);
              if (newQ !== jpegQ) { jpegQ = newQ; console.log('[webrtc2] Adjust JPEG_Q up to', jpegQ, '(elapsed', elapsed, 'ms)'); }
            }
            if (t1 - lastLog > 5000) {
              const actualFps = Math.round((frameCount * 1000) / (t1 - lastLog));
              console.log('[webrtc2] Streaming at', actualFps, 'fps (shots-turbo)', 'dropped:', dropped, 'jpegQ:', jpegQ, 'mode:', cdp ? 'cdp' : 'shot', 'cdp-size:', cdpStats.w, 'x', cdpStats.h);
              frameCount = 0;
              dropped = 0;
              lastLog = t1;
            }
          } else if (ffmpeg && !ffmpeg.killed) {
            // Drop frame if backpressure, keep latency low and pace steady
            // canWrite is closed over from startFFmpeg()
            const wrote = ffmpeg.stdin.write(screenshot);
            if (!wrote) { dropped++; }
            frameCount++;
            const t1 = Date.now();
            const budget = 1000 / targetFps;
            const elapsed = t1 - t0;
            nextFrameAt = t0 + Math.max(0, budget);
            if (elapsed > budget) {
              // If over budget, push the schedule by the overrun to avoid tight loops
              nextFrameAt = t1;
            }
            // Adaptive JPEG quality: push toward target FPS
            if (elapsed > budget * 1.2 && jpegQ > 30) {
              const newQ = Math.max(30, jpegQ - 5);
              if (newQ !== jpegQ) { jpegQ = newQ; console.log('[webrtc2] Adjust JPEG_Q down to', jpegQ, '(elapsed', elapsed, 'ms)'); }
            } else if (elapsed < budget * 0.6 && jpegQ < 60) {
              const newQ = Math.min(60, jpegQ + 5);
              if (newQ !== jpegQ) { jpegQ = newQ; console.log('[webrtc2] Adjust JPEG_Q up to', jpegQ, '(elapsed', elapsed, 'ms)'); }
            }
            if (t1 - lastLog > 5000) {
              const actualFps = Math.round((frameCount * 1000) / (t1 - lastLog));
              console.log('[webrtc2] Streaming at', actualFps, 'fps (shots-ffmpeg)', 'dropped:', dropped, 'jpegQ:', jpegQ, 'mode:', cdp ? 'cdp' : 'shot', 'cdp-size:', cdpStats.w, 'x', cdpStats.h);
              frameCount = 0;
              dropped = 0;
              lastLog = t1;
            }
          }
        } catch (e) {
          console.error('[webrtc2] Screenshot error:', e && e.message || String(e));
        }
      }
      console.log('[webrtc2] Streaming stopped');
      try { if (pumpSS) clearInterval(pumpSS); } catch {}
      try { if (cdp) await cdp.detach(); } catch {}
      if (ffmpeg) ffmpeg.kill();
    })();
    
    // Handle offer/answer
    console.log('[webrtc2] Setting remote description...');
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    
    console.log('[webrtc2] Creating answer...');
    const answer = await pc.createAnswer();
    console.log('[webrtc2] Answer created, SDP length:', answer?.sdp?.length || 0);
    
    // Prefer a codec via env (vp8|h264|auto)
    function preferCodecInSdp(sdpText, prefer) {
      try {
        if (!/m=video/.test(sdpText) || !prefer) return sdpText;
        const want = String(prefer).toLowerCase();
        const lines = sdpText.split('\r\n');
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].startsWith('m=video')) continue;
          const parts = lines[i].split(' ');
          const payloads = parts.slice(3);
          const wanted = [];
          const others = [];
          for (let j = i + 1; j < lines.length && !lines[j].startsWith('m='); j++) {
            const line = lines[j];
            if (!/^a=rtpmap:/.test(line)) continue;
            const pt = line.split(':')[1].split(' ')[0];
            const codec = (line.split(' ')[1] || '').toUpperCase();
            const isWanted = (want === 'h264' && /H264\/90000/.test(codec)) || (want === 'vp8' && /VP8\/90000/.test(codec));
            if (isWanted) wanted.push(pt); else others.push(pt);
          }
          if (wanted.length) {
            lines[i] = parts.slice(0, 3).join(' ') + ' ' + [...wanted, ...others.filter(pt => !wanted.includes(pt))].join(' ');
          }
          break;
        }
        return lines.join('\r\n');
      } catch { return sdpText; }
    }
    let sdp = answer.sdp;
    const prefer = (process.env.WEBRTC2_CODEC || 'vp8').toLowerCase();
    if (prefer === 'vp8' || prefer === 'h264') {
      sdp = preferCodecInSdp(sdp, prefer);
    }
    
    answer.sdp = sdp;
    await pc.setLocalDescription(answer);
    
    // Wait for ICE gathering with timeout
    console.log('[webrtc2] Waiting for ICE gathering...');
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('[webrtc2] ICE gathering timeout, proceeding anyway');
        resolve();
      }, 3000);
      
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timeout);
        resolve();
      } else {
        const checkState = () => {
          console.log('[webrtc2] ICE gathering state:', pc.iceGatheringState);
          if (pc.iceGatheringState === 'complete') {
            clearTimeout(timeout);
            pc.removeEventListener('icegatheringstatechange', checkState);
            resolve();
          }
        };
        pc.addEventListener('icegatheringstatechange', checkState);
      }
    });
    
    const finalAnswer = pc.localDescription;
    console.log('[webrtc2] Sending answer, SDP length:', finalAnswer?.sdp?.length || 0);
    
    const response = {
      answer: finalAnswer,
      dimensions: {
        width: streamWidth,
        height: streamHeight
      }
    };
    
    res.json(response);
    console.log('[webrtc2] Response sent successfully');
    
  } catch (e) {
    console.error('[webrtc2] ERROR:', e.message, e.stack);
    res.status(500).json({ error: e.message });
  }
});

// Minimal HTTP fallback to trigger a viewport click
app.post('/webrtc2/click', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  const mode0 = String(process.env.WEBRTC2_MODE || 'xpra').toLowerCase();
  if (mode0 === 'xpra') { return res.status(410).json({ error: 'disabled_in_xpra_mode' }); }
  try {
    const vx = Math.round(Number((req.body && req.body.vx) || 0));
    const vy = Math.round(Number((req.body && req.body.vy) || 0));
    await ensureBrowser();
    console.log('[webrtc2] HTTP CLICK_VIEWPORT received:', vx, vy);
    try {
      const pages = browser.pages();
      let pick = pages[pages.length - 1];
      for (let i = pages.length - 1; i >= 0; i--) {
        try { const u = await pages[i].url(); if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; } } catch {}
      }
      if (pick) page = pick;
    } catch {}
    try { await page.bringToFront(); } catch {}
    const vp = await page.viewportSize();
    const cx = Math.max(0, Math.min(vp.width - 1, vx));
    const cy = Math.max(0, Math.min(vp.height - 1, vy));
    await page.mouse.move(cx, cy);
    await page.mouse.click(cx, cy, { button: 'left', clickCount: 1, delay: 0 });
    res.json({ ok: true });
  } catch (e) {
    console.error('[webrtc2] HTTP CLICK error:', e && e.message || String(e));
    res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
});
// Report current CSS viewport size (for precise coord mapping)
app.get('/webrtc/viewport', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    await ensureBrowser();
    const pwViewport = await page.viewportSize();
    const size = await page.evaluate(() => ({
      w: Math.floor(window.innerWidth||0),
      h: Math.floor(window.innerHeight||0),
      dpr: (window.devicePixelRatio||1),
      scale: (window.visualViewport && window.visualViewport.scale) || 1,
      vh: (window.visualViewport && Math.floor(window.visualViewport.height)) || null,
      scrollX: window.scrollX || window.pageXOffset || 0,
      scrollY: window.scrollY || window.pageYOffset || 0
    }));
    console.log('[viewport] Playwright viewport:', pwViewport, 'Browser reported:', size);
    res.json({ 
      ok:true, 
      width: pwViewport?.width || size.w, 
      height: pwViewport?.height || size.h, 
      browserWidth: size.w,
      browserHeight: size.h,
      dpr: size.dpr, 
      scale: size.scale, 
      visualHeight: size.vh,
      scrollX: size.scrollX,
      scrollY: size.scrollY
    });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});
// Get actual dimensions for debugging
app.get('/webrtc/dimensions', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    await ensureBrowser();
    const viewport = await page.viewportSize();
    const windowInfo = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      screenX: window.screenX,
      screenY: window.screenY,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      documentHeight: document.documentElement.scrollHeight,
      bodyHeight: document.body.scrollHeight
    }));
    
    res.json({
      ok: true,
      playwright: {
        viewport
      },
      browser: windowInfo,
      expected: {
        width: Number(process.env.WEBRTC_W) || 1280,
        height: Number(process.env.WEBRTC_H) || 720
      },
      actual: {
        playwrightViewport: viewport,
        browserInner: {
          width: windowInfo.innerWidth,
          height: windowInfo.innerHeight
        }
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Draw grid on server for alignment testing
app.get('/webrtc/grid', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    await ensureBrowser();
    const result = await page.evaluate(() => {
      // Remove existing grid if any
      const existing = document.getElementById('serverDebugGrid');
      if (existing) {
        existing.remove();
        return { removed: true };
      }
      
      // Create grid overlay
      const grid = document.createElement('div');
      grid.id = 'serverDebugGrid';
      grid.style.position = 'fixed';
      grid.style.left = '0';
      grid.style.top = '0';
      grid.style.width = window.innerWidth + 'px';
      grid.style.height = window.innerHeight + 'px';
      grid.style.pointerEvents = 'none';
      grid.style.zIndex = '999999';
      
      // Create canvas for grid
      const canvas = document.createElement('canvas');
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      const ctx = canvas.getContext('2d');
      
      // Draw grid lines
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
      ctx.lineWidth = 2;
      
      // Vertical lines every 100px
      for (let x = 0; x <= window.innerWidth; x += 100) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, window.innerHeight);
        ctx.stroke();
      }
      
      // Horizontal lines every 100px
      for (let y = 0; y <= window.innerHeight; y += 100) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(window.innerWidth, y);
        ctx.stroke();
      }
      
      // Draw coordinate labels
      ctx.fillStyle = 'red';
      ctx.font = 'bold 14px monospace';
      for (let x = 0; x <= window.innerWidth; x += 100) {
        for (let y = 0; y <= window.innerHeight; y += 100) {
          ctx.fillText(`${x},${y}`, x + 2, y + 14);
        }
      }
      
      // Mark corners with larger markers
      ctx.fillStyle = 'blue';
      ctx.fillRect(0, 0, 10, 10);
      ctx.fillRect(window.innerWidth - 10, 0, 10, 10);
      ctx.fillRect(0, window.innerHeight - 10, 10, 10);
      ctx.fillRect(window.innerWidth - 10, window.innerHeight - 10, 10, 10);
      
      grid.appendChild(canvas);
      document.body.appendChild(grid);
      
      return { 
        created: true, 
        viewport: { 
          width: window.innerWidth, 
          height: window.innerHeight 
        } 
      };
    });
    
    console.log('[grid] Server grid result:', result);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Test click accuracy
app.post('/webrtc/test-click', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    await ensureBrowser();
    const { x, y } = req.body || {};
    const vx = Math.round(Number(x) || 0);
    const vy = Math.round(Number(y) || 0);
    
    console.log('[test-click] Clicking at:', vx, vy);
    
    // Draw marker and get element info
    const result = await page.evaluate((x, y) => {
      // Draw marker
      const marker = document.createElement('div');
      marker.style.position = 'fixed';
      marker.style.left = (x - 5) + 'px';
      marker.style.top = (y - 5) + 'px';
      marker.style.width = '10px';
      marker.style.height = '10px';
      marker.style.borderRadius = '50%';
      marker.style.backgroundColor = 'red';
      marker.style.border = '2px solid white';
      marker.style.pointerEvents = 'none';
      marker.style.zIndex = '999999';
      document.body.appendChild(marker);
      setTimeout(() => marker.remove(), 3000);
      
      // Get element at position
      const el = document.elementFromPoint(x, y);
      return {
        clicked: { x, y },
        element: el ? {
          tag: el.tagName,
          text: el.textContent?.substring(0, 100),
          rect: el.getBoundingClientRect()
        } : null,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          scrollX: window.scrollX,
          scrollY: window.scrollY
        }
      };
    }, vx, vy);
    
    await page.mouse.click(vx, vy);
    console.log('[test-click] Result:', result);
    
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Debug: raw screenshot for verification
app.get('/webrtc/snap', async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    await ensureBrowser();
    try {
      const pages = browser.pages();
      let pick = pages[pages.length - 1];
      for (let i = pages.length - 1; i >= 0; i--) {
        try { const u = await pages[i].url(); if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; } } catch {}
      }
      if (pick) page = pick;
      try { await page.bringToFront(); } catch {}
      try { await stabilizeBeforeScreenshot(); } catch {}
    } catch {}
    
    // Take screenshot and analyze it
    const buf = await page.screenshot({ type: 'png', fullPage: false });
    
    // Get image dimensions using a simple PNG header parser
    // PNG dimensions are at bytes 16-24 (width) and 20-24 (height)
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    
    console.log('[snap] Screenshot dimensions:', width, 'x', height);
    
    // Also get viewport for comparison
    const viewport = await page.viewportSize();
    console.log('[snap] Viewport dimensions:', viewport);
    
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Screenshot-Width', width);
    res.setHeader('X-Screenshot-Height', height);
    res.setHeader('X-Viewport-Width', viewport?.width || 0);
    res.setHeader('X-Viewport-Height', viewport?.height || 0);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});
// WebRTC config (ICE servers) — pulled by client
app.get('/webrtc/config', (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    // Allow JSON via WEBRTC_ICE_SERVERS env (e.g., '[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com","username":"u","credential":"p"}]')
    let iceServers = null;
    try {
      const raw = process.env.WEBRTC_ICE_SERVERS;
      if (raw) iceServers = JSON.parse(raw);
    } catch {}
    if (!Array.isArray(iceServers) || iceServers.length === 0) {
      iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    }
    res.json({ ok: true, iceServers });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});
// Debug endpoints
app.get('/console/logs', async (req, res) => {
  try {
    const a = await fs.readFile('/tmp/x11vnc.log','utf8').catch(()=>'');
    const b = await fs.readFile('/tmp/websockify.log','utf8').catch(()=>'');
    res.type('text/plain').send('=== x11vnc.log ===\n' + a + '\n\n=== websockify.log ===\n' + b);
  } catch { res.type('text/plain').send(''); }
});
app.get('/console/status', (req, res) => {
  const p = http.request({ hostname: '127.0.0.1', port: 6080, path: '/', method: 'GET' }, (pr) => { res.status(pr.statusCode || 200); pr.pipe(res); });
  p.on('error', (e) => res.status(502).send(String(e&&e.message||e)) ); p.end();
});
app.get('/console', (req, res) => {
  res.redirect('/console/vnc.html?autoconnect=true&resize=remote&path=/console/websockify');
});
// Robust HTTP+WS proxy for /console to 127.0.0.1:6080 (if available)
let consoleProxy = null;
if (typeof createProxyServer === 'function') {
  try { log('[console] proxy: http/ws -> 127.0.0.1:6080'); } catch {}
  consoleProxy = createProxyServer({ target: 'http://127.0.0.1:6080', ws: true, changeOrigin: true, xfwd: true });
  consoleProxy.on('error', (err, req, res) => {
    try { console.log('[console] proxy error', err?.message||String(err)); } catch {}
    if (!res || res.headersSent) return;
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('console proxy error');
  });
  app.use('/console', (req, res) => { req.url = req.url.replace(/^\/+console/, ''); consoleProxy.web(req, res); });
} else {
  app.use('/console', (_req, res) => res.status(503).send('console proxy not available'));
}

// (scroll-test route removed)
const PORT = Number(process.env.NEROVA_AGENT_PORT || process.env.PORT || 3333);
const BIND_HOST = process.env.NEROVA_AGENT_HOST || process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`[STARTUP] Server running on port ${PORT}`);
  console.log(`[STARTUP] Environment: FLY_APP_NAME=${process.env.FLY_APP_NAME || 'not set'}`);
  console.log(`[STARTUP] WebRTC dimensions: ${process.env.WEBRTC_W || 1280}x${process.env.WEBRTC_H || 720}`);
  log(`UI server listening on :${PORT}`);
});
// Warm a headed Playwright window on Fly so the remote desktop isn't empty
if (process.env.FLY_APP_NAME) {
  (async () => {
    try {
      await ensureBrowser();
      log('[warm] boot url', DEFAULT_BOOT_URL);
      try {
        await startScreencast({ quality: 65, maxWidth: STREAM_WIDTH, maxHeight: STREAM_HEIGHT, everyNthFrame: 1 });
        log(`[warm] screencast primed (${STREAM_WIDTH}x${STREAM_HEIGHT})`);
      } catch (scErr) {
        try { log('[warm] screencast error', String(scErr && scErr.message || scErr)); } catch {}
      }
      log('[warm] browser context ready');
    } catch (e) {
      try { log('[warm] browser error', String(e && e.message || e)); } catch {}
    }
  })();
}

// (moved ws bridge below after wss initialization)

// Simple health endpoint for debugging VNC availability
app.get('/console/health', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      const c = net.connect({ host: '127.0.0.1', port: 5900 }, resolve);
      c.setTimeout(1000, () => { try { c.destroy(); } catch {} reject(new Error('timeout')); });
      c.on('error', reject);
      c.on('connect', () => { try { c.destroy(); } catch {} resolve(); });
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e) });
  }
});

const wss = new WebSocketServer({ server });
// Upgrade handler: delegate /console WS to proxy
server.on('upgrade', (req, socket, head) => {
  try {
    const url = String(req.url || '');
    if (url.startsWith('/console') && consoleProxy) {
      req.url = url.replace(/^\/+console/, '');
      consoleProxy.ws(req, socket, head);
      return;
    }
  } catch (e) { try { socket.destroy(); } catch {} }
});

// Xpra HTTP proxy (default /webrtc2 path)
let xpraProxy = null;
if (typeof createProxyServer === 'function') {
  try { log('[xpra] proxy: http -> 127.0.0.1:14500'); } catch {}
  xpraProxy = createProxyServer({ target: 'http://127.0.0.1:14500', ws: true, changeOrigin: true, xfwd: true });
  xpraProxy.on('error', (err, req, res) => {
    try { console.log('[xpra] proxy error', err?.message||String(err)); } catch {}
    if (!res || res.headersSent) return;
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('xpra proxy error');
  });
  // Health and logs endpoints must come before proxy to avoid interception
  app.get('/xpra/health', async (req, res) => {
    try {
      await new Promise((resolve, reject) => {
        const c = net.connect({ host: '127.0.0.1', port: 14500 }, resolve);
        c.setTimeout(1000, () => { try { c.destroy(); } catch {} reject(new Error('timeout')); });
        c.on('error', reject);
        c.on('connect', () => { try { c.destroy(); } catch {} resolve(); });
      });
      res.json({ ok: true });
    } catch (e) {
      try {
        const log = await fs.readFile('/tmp/xpra.log','utf8').catch(()=> '');
        res.status(503).json({ ok: false, error: String(e && e.message || e), log: log.slice(-4000) });
      } catch {
        res.status(503).json({ ok: false, error: String(e && e.message || e) });
      }
    }
  });
  app.get('/xpra/logs', async (_req, res) => {
    try { const log = await fs.readFile('/tmp/xpra.log','utf8').catch(()=> ''); res.type('text/plain').send(log); }
    catch { res.type('text/plain').send(''); }
  });
  // Proxy to Xpra for all other paths
  app.use('/xpra', (req, res) => {
    xpraProxy.web(req, res);
  });
  // Upgrade WebSocket for Xpra (signaling)
  try {
    server.on('upgrade', (req, socket, head) => {
      const url = String(req.url || '');
      if (url.startsWith('/xpra')) {
        xpraProxy.ws(req, socket, head);
      }
    });
  } catch {}
} else {
  // Provide health/logs even if proxy unavailable
  app.get('/xpra/health', (_req, res) => res.status(503).json({ ok:false, error:'proxy_not_available' }));
  app.get('/xpra/logs', (_req, res) => res.type('text/plain').send(''));
  app.use('/xpra', (_req, res) => res.status(503).send('xpra proxy not available'));
}

// Xpra diagnostics
app.get('/xpra/health', async (req, res) => {
  try {
    await new Promise((resolve, reject) => {
      const c = net.connect({ host: '127.0.0.1', port: 14500 }, resolve);
      c.setTimeout(1000, () => { try { c.destroy(); } catch {} reject(new Error('timeout')); });
      c.on('error', reject);
      c.on('connect', () => { try { c.destroy(); } catch {} resolve(); });
    });
    res.json({ ok: true });
  } catch (e) {
    try {
      const log = await fs.readFile('/tmp/xpra.log','utf8').catch(()=> '');
      res.status(503).json({ ok: false, error: String(e && e.message || e), log: log.slice(-4000) });
    } catch {
      res.status(503).json({ ok: false, error: String(e && e.message || e) });
    }
  }
});
app.get('/xpra/logs', async (_req, res) => {
  try { const log = await fs.readFile('/tmp/xpra.log','utf8').catch(()=> ''); res.type('text/plain').send(log); }
  catch { res.type('text/plain').send(''); }
});

// --- CDP Screencast state (shared headed browser) ---
// (state variables declared near top of file for early warm-up)

async function startScreencast(opts = {}) {
  try {
    await ensureBrowser();
    // If already active, do nothing
    if (screencastActive && screencastCdp) return true;
    // Bind a CDP session to the current active page
    try { if (screencastCdp) { try { await screencastCdp.send('Page.stopScreencast'); } catch {} try { screencastCdp.detach && await screencastCdp.detach(); } catch {} } } catch {}
    screencastCdp = await page.context().newCDPSession(page);
    const cfg = {
      format: (opts.format || 'jpeg'),
      quality: Math.max(30, Math.min(100, Number(opts.quality) || 60)),
      maxWidth: Math.max(640, Math.min(1920, Number(opts.maxWidth) || 1366)),
      maxHeight: Math.max(360, Math.min(1080, Number(opts.maxHeight) || 768)),
      everyNthFrame: Math.max(1, Math.min(4, Number(opts.everyNthFrame) || 1))
    };
    // Listen for frames
    screencastCdp.on('Page.screencastFrame', async (evt) => {
      try {
        // Keep last JPEG for WebRTC pipeline
        try { screencastLast.buf = Buffer.from(evt.data || '', 'base64'); screencastLast.ts = Date.now(); } catch {}
        const dataUrl = `data:image/${cfg.format};base64,${evt.data}`;
        for (const client of Array.from(screencastSubscribers)) {
          try { client.send(JSON.stringify({ ok: true, type: 'SCREENCAST_FRAME', data: dataUrl })); } catch {}
        }
        try { await screencastCdp.send('Page.screencastFrameAck', { sessionId: evt.sessionId }); } catch {}
      } catch {}
    });
    try { await screencastCdp.send('Page.startScreencast', cfg); } catch {}
    screencastActive = true;
    return true;
  } catch (e) {
    screencastActive = false; screencastCdp = null; return false;
  }
}

async function stopScreencast() {
  try {
    if (screencastCdp) {
      try { await screencastCdp.send('Page.stopScreencast'); } catch {}
      try { screencastCdp.removeAllListeners && screencastCdp.removeAllListeners(); } catch {}
      try { screencastCdp.detach && await screencastCdp.detach(); } catch {}
    }
  } catch {}
  screencastActive = false; screencastCdp = null;
}

async function restartScreencastIfNeeded() {
  try {
    if (screencastActive && screencastSubscribers.size > 0) {
      await stopScreencast();
      await startScreencast();
    }
  } catch {}
}
// (scrollBoth helper removed)
/*
async function scrollBoth(p, ratio = 0.8, direction = 'down') {
  const sign = direction === 'up' ? -1 : 1;
  const r = Math.max(0.1, Math.min(0.95, Math.abs(Number(ratio) || 0.8)));
  const mainResult = await p.evaluate((ratioIn, signIn) => {
    const vh = window.innerHeight || 800;
    const dy = signIn * Math.max(100, Math.round(vh * ratioIn));

    const describe = (el) => {
      const t = (el.tagName || '').toLowerCase();
      const id = el.id ? `#${el.id}` : '';
      const cls = el.className && el.className.toString
        ? '.' + el.className.toString().trim().split(/\s+/).join('.')
        : '';
      return `${t}${id}${cls}`.slice(0, 160);
    };

    const scrolled = [];

    // 1) window/document scroll
    const prev = { x: window.scrollX, y: window.scrollY };
    const se = document.scrollingElement || document.documentElement;
    if (se) {
      const before = se.scrollTop;
      se.scrollTop = before + dy;
    } else {
      window.scrollBy(0, dy);
    }
    const after = { x: window.scrollX, y: window.scrollY };

    // 2) central ancestor chain
    const centerEl = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2));
    const isScrollable = (el) => {
      try {
        const s = getComputedStyle(el);
        const oy = s.overflowY;
        if (!(oy === 'auto' || oy === 'scroll')) return false;
        return el.scrollHeight > el.clientHeight;
      } catch { return false; }
    };
    let cur = centerEl, climbed = 0;
    while (cur && climbed < 8) {
      if (isScrollable(cur)) {
        const before = cur.scrollTop;
        cur.scrollTop = before + dy;
        if (cur.scrollTop !== before) scrolled.push(`center:${describe(cur)}`);
      }
      cur = cur.parentElement; climbed++;
    }

    // 3) targeted overflow containers
    const candidateSelectors = [
      'aside', 'nav', 'div[role="navigation"]', 'main', '[role="main"]',
      '[data-testid*="sidebar"]', '[data-test*="sidebar"]', '[data-testid*="content"]', '[data-test*="content"]',
      '[class*="sidebar"]', '[class*="side"]', '[class*="nav"]', '[class*="content"]',
      '[class*="panel"]', '[class*="container"]', '[class*="page"]', '[class*="workspace"]'
    ];
    const targetSet = new Set();
    for (const sel of candidateSelectors) {
      try { document.querySelectorAll(sel).forEach(el => targetSet.add(el)); } catch {}
    }
    Array.from(document.querySelectorAll('*')).forEach(el => {
      if (!isScrollable(el)) return;
      const r = el.getBoundingClientRect();
      if (r.height <= 100) return;
      targetSet.add(el);
    });
    for (const el of targetSet) {
      try {
        const before = el.scrollTop;
        el.scrollTop = before + dy;
        if (el.scrollTop !== before) scrolled.push(describe(el));
      } catch {}
    }

    return { windowBefore: prev, windowAfter: after, containersScrolled: scrolled };
  }, r, sign);

  // Also scroll inside each visible iframe
  const frameResults = [];
  for (const f of p.frames()) {
    if (f === p.mainFrame()) continue;
    try {
      const fe = await f.frameElement();
      if (!fe) continue;
      const box = await fe.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) continue;

      const rf = await f.evaluate((ratioIn, signIn) => {
        const vh = window.innerHeight || 800;
        const dy = signIn * Math.max(100, Math.round(vh * ratioIn));

        const describe = (el) => {
          const t = (el.tagName || '').toLowerCase();
          const id = el.id ? `#${el.id}` : '';
          const cls = el.className && el.className.toString
            ? '.' + el.className.toString().trim().split(/\s+/).join('.')
            : '';
          return `${t}${id}${cls}`.slice(0, 160);
        };

        const scrolled = [];
        const prev = { x: window.scrollX, y: window.scrollY };
        const se = document.scrollingElement || document.documentElement;
        if (se) {
          const before = se.scrollTop; se.scrollTop = before + dy;
        } else {
          window.scrollBy(0, dy);
        }
        const after = { x: window.scrollX, y: window.scrollY };

        const centerEl = document.elementFromPoint(Math.floor(innerWidth / 2), Math.floor(innerHeight / 2));
        const isScrollable = (el) => {
          try {
            const s = getComputedStyle(el);
            const oy = s.overflowY;
            if (!(oy === 'auto' || oy === 'scroll')) return false;
            return el.scrollHeight > el.clientHeight;
          } catch { return false; }
        };
        let cur = centerEl, climbed = 0;
        while (cur && climbed < 8) {
          if (isScrollable(cur)) {
            const before = cur.scrollTop; cur.scrollTop = before + dy;
            if (cur.scrollTop !== before) scrolled.push(`center:${describe(cur)}`);
          }
          cur = cur.parentElement; climbed++;
        }

        const candidateSelectors = [
          'aside', 'nav', 'div[role="navigation"]', 'main', '[role="main"]',
          '[data-testid*="sidebar"]', '[data-test*="sidebar"]', '[data-testid*="content"]', '[data-test*="content"]',
          '[class*="sidebar"]', '[class*="side"]', '[class*="nav"]', '[class*="content"]',
          '[class*="panel"]', '[class*="container"]', '[class*="page"]', '[class*="workspace"]'
        ];
        const targetSet = new Set();
        for (const sel of candidateSelectors) {
          try { document.querySelectorAll(sel).forEach(el => targetSet.add(el)); } catch {}
        }
        Array.from(document.querySelectorAll('*')).forEach(el => {
          if (!isScrollable(el)) return;
          const r = el.getBoundingClientRect();
          if (r.height <= 100) return;
          targetSet.add(el);
        });
        for (const el of targetSet) {
          try {
            const before = el.scrollTop; el.scrollTop = before + dy;
            if (el.scrollTop !== before) scrolled.push(describe(el));
          } catch {}
        }

        return { windowBefore: prev, windowAfter: after, containersScrolled: scrolled };
      }, r, sign);

      frameResults.push({ frameUrl: f.url(), frameBox: { x: box.x, y: box.y, width: box.width, height: box.height }, result: rf });
    } catch {}
  }

  return { main: mainResult, frames: frameResults };
}
*/
// In-memory recent click chains captured via initScript/binding
let recentChains = [];
function pushRecentChain(entry) {
  try {
    if (!entry || !Array.isArray(entry.chain) || entry.chain.length === 0) return;
    entry.ts = Number(entry.ts) || Date.now();
    recentChains.push({ ts: entry.ts, chain: entry.chain, frameUrl: entry.frameUrl || null });
    // Keep only recent (≤ 10) and ≤ 5s old
    const cutoff = Date.now() - 5000;
    recentChains = recentChains.filter(e => e && e.ts >= cutoff);
    if (recentChains.length > 10) recentChains = recentChains.slice(-10);
  } catch {}
}

// Stabilize the page before taking any screenshot to avoid capturing blank/transition frames
async function stabilizeBeforeScreenshot() {
  try {
    try { await page.waitForLoadState('domcontentloaded', { timeout: 3000 }); } catch {}
    try { await page.waitForLoadState('load', { timeout: 2500 }); } catch {}
    try { await page.waitForLoadState('networkidle', { timeout: 2500 }); } catch {}
    try {
      await page.waitForFunction(() => {
        try {
          const se = document.scrollingElement || document.documentElement || document.body;
          const rs = document.readyState;
          return !!se && (se.clientHeight > 0 || se.scrollHeight > 0) && rs !== 'loading';
        } catch { return false; }
      }, { timeout: 1500 });
    } catch {}
    // Heuristic settle loop for SPAs/loaders: wait until visible content is non-trivial and loaders disappear
    for (let i = 0; i < 8; i++) {
      const ok = await page.evaluate(() => {
        try {
          const vw = window.innerWidth || 0, vh = window.innerHeight || 0;
          if (vw < 320 || vh < 240) return false;
          const body = document.body;
          if (!body) return false;
          // Count visible elements of reasonable size
          let visible = 0; const nodes = Array.from(document.querySelectorAll('*'));
          for (const el of nodes) {
            try {
              const s = getComputedStyle(el);
              if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity || '1') === 0) continue;
              const r = el.getBoundingClientRect();
              if (r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.right > 0 && r.left < vw && r.top < vh) { visible++; if (visible >= 20) break; }
            } catch {}
          }
          // Detect common spinners/loaders
          const hasSpinner = (() => {
            const q = [
              '[role="progressbar"]',
              '.spinner', '.Spinner', '.loading', '.Loading', '.loader', '.Loader', '[aria-busy="true"]'
            ];
            for (const sel of q) {
              const el = document.querySelector(sel);
              if (el) {
                const s = getComputedStyle(el);
                if (s && s.display !== 'none' && s.visibility !== 'hidden') return true;
              }
            }
            return false;
          })();
          return visible >= 12 && !hasSpinner;
        } catch { return false; }
      }).catch(() => false);
      if (ok) break;
      await page.waitForTimeout(200);
    }
    try { await page.waitForAnimationFrame(); } catch {}
  } catch {}
}

async function ensureBrowser() {
  if (browser) return;
  if (browserStarting) { await browserStarting.catch(()=>{}); return; }
  browserStarting = (async () => {
    await fs.mkdir(USER_DATA_DIR, { recursive: true });
    // Launch a chromeless app window so viewport == visible content (no URL/tab bars)
    const launchArgs = [
      "--app=data:text/html,<title>WebAgent</title><style>html,body{margin:0;padding:0;background:#111;color:#ddd;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif}</style><div style='padding:8px'>WebAgent window</div>"
    ];
    if (windowHideOnNextLaunch) {
      launchArgs.push('--window-position=10000,10000');
    }
    const forceHeadless = String(process.env.FORCE_HEADLESS || '').trim() === '1';
  const forceHeadful = String(process.env.FORCE_HEADFUL || '').trim() === '1' || String(process.env.WEBRTC2_MODE || 'xpra').toLowerCase() === 'xpra';
  // Default to headless for optimal performance and consistent viewport
  const headful = forceHeadful ? true : (forceHeadless ? false : false);
  // Default to a crisp but lighter 16:9 size to sustain 30fps
  let vw = STREAM_WIDTH;
  let vh = STREAM_HEIGHT;
  
  try {
    browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: !headful,
      viewport: { width: vw, height: vh },
      deviceScaleFactor: 1,
      args: [
        ...launchArgs,
        `--window-size=${vw},${vh + (headful ? 100 : 0)}`, // Add height for chrome in headful
        '--force-device-scale-factor=1',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-features=CalculateNativeWinOcclusion',
        ...(headful ? [] : ['--headless=new']),
        '--use-gl=swiftshader',
        // Treat local origins as secure to stabilize getDisplayMedia in headless
        '--unsafely-treat-insecure-origin-as-secure=http://localhost:3333,http://127.0.0.1:3333',
        // Enable seamless headless screen capture
        '--use-fake-ui-for-media-stream',
        '--allow-http-screen-capture',
        '--auto-select-desktop-capture-source=WebAgent'
      ]
    });
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/ProcessSingleton/i.test(msg) || /SingletonLock/i.test(msg)) {
      try { await fs.rm(path.join(USER_DATA_DIR, 'SingletonLock'), { force: true }); } catch {}
      try {
        browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
          headless: !headful,
          viewport: { width: vw, height: vh },
          deviceScaleFactor: 1,
          args: [
            ...launchArgs,
            `--window-size=${vw},${vh + (headful ? 100 : 0)}`, // Add height for chrome in headful
            '--force-device-scale-factor=1',
            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
            '--disable-features=CalculateNativeWinOcclusion',
            ...(headful ? [] : ['--headless=new']),
            '--use-gl=swiftshader',
            '--unsafely-treat-insecure-origin-as-secure=http://localhost:3333,http://127.0.0.1:3333',
            '--use-fake-ui-for-media-stream',
            '--allow-http-screen-capture',
            '--auto-select-desktop-capture-source=WebAgent'
          ]
        });
      } catch (e2) { browserStarting = null; throw e2; }
    } else { browserStarting = null; throw e; }
  }
  const pages = browser.pages();
  page = pages.length ? pages[0] : await browser.newPage();
  
  // Force the viewport to our desired size
  try {
    await page.setViewportSize({ width: vw, height: vh });
    console.log('[browser] Set viewport to:', vw, 'x', vh);
  } catch (e) {
    console.log('[browser] Failed to set viewport:', e.message);
  }
  
  // Log the actual viewport size we got
  const actualViewport = await page.viewportSize();
  console.log('[browser] Actual viewport after setting:', actualViewport);
  
  // In headless mode, rely on explicit viewport above; skip window bounds
  // Persist hidden state if requested
  if (windowHideOnNextLaunch) {
    windowHidden = true;
    windowHideOnNextLaunch = false;
  }
  try {
    // Expose backend cache binding
    await browser.exposeBinding('wocrPushChain', async (source, payload) => {
      try {
        const p = payload || {};
        const entry = {
          ts: Number(p.ts) || Date.now(),
          chain: Array.isArray(p.chain) ? p.chain : [],
          frameUrl: typeof p.frameUrl === 'string' ? p.frameUrl : (source && source.frame ? source.frame.url() : null)
        };
        pushRecentChain(entry);
      } catch {}
    });
  } catch {}
  try {
    // Install init script to capture clicks/submits as early as possible in all documents/frames
    await browser.addInitScript(() => {
      try {
        if (window.__wocr_init_installed) return;
        window.__wocr_init_installed = true;
        function collapseWhitespace(text){ return (text||'').toString().replace(/\s+/g,' ').trim(); }
        function computeRole(el){
          try {
            const aria=(el.getAttribute('role')||'').trim(); if(aria) return aria.toLowerCase();
            const tag=(el.tagName||'').toLowerCase();
            if(tag==='a') return (el.getAttribute('href')?'link':'generic');
            if(tag==='button') return 'button';
            if(tag==='input'){
              const type=(el.getAttribute('type')||'').toLowerCase();
              if(['button','submit','reset','image'].includes(type)) return 'button';
              if(['checkbox'].includes(type)) return 'checkbox';
              if(['radio'].includes(type)) return 'radio';
              if(['range'].includes(type)) return 'slider';
              return 'textbox';
            }
            if(tag==='select') return 'combobox';
            if(tag==='textarea') return 'textbox';
            if(tag==='summary') return 'button';
            return 'generic';
          } catch { return 'generic'; }
        }
        function shortAnchor(el){
          try {
            let cur=el, levels=0;
            while(cur&&levels<4){
              if(cur.id) return `#${cur.id}`;
              const dt=cur.getAttribute&& (cur.getAttribute('data-testid')||cur.getAttribute('data-test')||cur.getAttribute('data-qa'));
              if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`;
              const al=cur.getAttribute&&cur.getAttribute('aria-label');
              if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`;
              cur=cur.parentElement; levels++;
            }
            const parts=[]; cur=el;
            for(let i=0;i<3&&cur;i++){
              const tag=(cur.tagName||'div').toLowerCase();
              const parent=cur.parentElement;
              if(!parent){ parts.unshift(tag); break; }
              const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName);
              const idx=siblings.indexOf(cur)+1;
              parts.unshift(`${tag}:nth-of-type(${idx})`);
              cur=parent;
            }
            return parts.join('>');
          } catch { return ''; }
        }
        function bestSelector(el){
          try {
            if(el.id) return `#${el.id}`;
            const dt=el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-qa');
            if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`;
            const al=el.getAttribute('aria-label');
            if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`;
            const parts=[]; let cur=el;
            for(let i=0;i<3&&cur;i++){
              const tag=(cur.tagName||'div').toLowerCase();
              const parent=cur.parentElement;
              if(!parent){ parts.unshift(tag); break; }
              const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName);
              const idx=siblings.indexOf(cur)+1;
              parts.unshift(`${tag}:nth-of-type(${idx})`);
              cur=parent;
            }
            let sel=parts.join('>'); if(sel.length>80) sel=sel.slice(0,80); return sel;
          } catch { return ''; }
        }
        function hash36(str){ try{ let h=5381; for(let i=0;i<str.length;i++){ h=((h<<5)+h)+str.charCodeAt(i); h|=0; } return (h>>>0).toString(36);}catch{return '';} }
        function describe(el){
          try {
            const r=el.getBoundingClientRect();
            const name = collapseWhitespace((el.getAttribute('aria-label')||'') || el.innerText || el.textContent || '');
            const role = computeRole(el);
            const selector = bestSelector(el);
            const anchor = shortAnchor(el);
            const idBase = `${role}|${name.toLowerCase()}|${anchor}|${selector}`;
            const idHash = hash36(idBase);
            return { id:idHash, selector, role, name, rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)] };
          } catch { return { id:'', selector:'', role:'generic', name:'' }; }
        }
        function buildChainFrom(el){
          const chain=[]; try{
            let cur = el; let steps=0;
            while(cur && cur.nodeType===Node.ELEMENT_NODE && steps<20){ chain.push(describe(cur)); cur=cur.parentElement; steps++; }
          }catch{}
          return chain;
        }
        function persist(chain){
          try {
            const payload = { ts: Date.now(), frameUrl: location.href, chain };
            // Backend cache if binding exists
            try { window.wocrPushChain && window.wocrPushChain(payload); } catch {}
            // Secondary: window.name
            try {
              const host = String(location.hostname||'').toLowerCase();
              const allow = /(^|\.)amazon\./.test(host);
              if (allow) {
                const prev = String(window.name || '');
                window.name = 'WOCR:' + btoa(JSON.stringify({ ...payload, prev }));
              }
            } catch {}
          } catch {}
        }
        // Capture submit (fastest reliable for form submissions)
        window.addEventListener('submit', (e) => {
          try {
            const s = e && e.submitter;
            const tgt = (s && s.nodeType===Node.ELEMENT_NODE) ? s : (document.activeElement || (e && e.target && e.target.querySelector && e.target.querySelector('button[type="submit"],input[type="submit"]')));
            if (tgt) persist(buildChainFrom(tgt));
          } catch {}
        }, true);
        // Also capture pointer/mouse just in case
        const evs = ['pointerdown','mousedown','click'];
        for (const ev of evs) {
          window.addEventListener(ev, (e) => {
            try { const t = e && e.target; if (t && t.nodeType===Node.ELEMENT_NODE) persist(buildChainFrom(t)); } catch {}
          }, true);
        }
      } catch {}
    });
  } catch {}
  try { browser.on && browser.on('close', () => { try { browser = null; context = null; page = null; } catch {} }); } catch {}
  try {
    // Initial bootstrap: if blank, open local test page so WebRTC shows pixels immediately
    const u = await page.url();
    if (!u || /^about:blank/.test(u) || /^data:text\//.test(u)) {
      await page.goto(DEFAULT_BOOT_URL, { waitUntil: 'load', timeout: 3000 }).catch(()=>{});
    }
    // Enforce viewport size even in headed mode to guarantee 1:1 mapping
    // Make sure dimensions are even for video encoding
    let targetVw = vw;
    let targetVh = vh;
    if (targetVw % 2 !== 0) targetVw -= 1;
    if (targetVh % 2 !== 0) targetVh -= 1;
    console.log('[browser] Setting viewport to:', targetVw, 'x', targetVh);
    try { 
      await page.setViewportSize({ width: targetVw, height: targetVh });
      const actualVp = await page.viewportSize();
      console.log('[browser] Viewport set to:', actualVp);
    } catch (e) {
      console.log('[browser] Failed to set viewport:', e.message);
    }
    // Zoom guard: force 100% CSS zoom and reset transforms
    try {
      await page.evaluate(() => {
        try {
          document.documentElement.style.zoom = '100%';
          document.body && (document.body.style.zoom = '100%');
          document.documentElement.style.transform = 'none';
          document.documentElement.style.transformOrigin = '50% 50%';
        } catch {}
      });
    } catch {}
  } catch {}
  })();
  try { await browserStarting; } finally { browserStarting = null; }
}

// Move headed window off-screen or restore it (for /ui-only runs)
async function setWindowHidden(hide) {
  try {
    await ensureBrowser();
    const cdp = await page.context().newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    if (hide) {
      // Place window far off-screen to avoid OS throttling of minimized windows
      try { await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 10000, top: 10000, windowState: 'normal' } }); } catch {}
    } else {
      // Restore and maximize
      try { await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } }); } catch {}
      try { await page.bringToFront(); } catch {}
    }
    try { await cdp.detach(); } catch {}
    return true;
  } catch { return false; }
}

// --- Lightweight CDP screencast manager (used only by /ui) ---
const screencast = {
  running: false,
  cdp: null,
  clients: new Set(),
  onFrame: null,
  format: 'jpeg'
};

async function legacyStartScreencast() {
  if (screencast.running) return true;
  await ensureBrowser();
  try {
    const cdp = await page.context().newCDPSession(page);
    try { await cdp.send('Page.enable'); } catch {}
    screencast.cdp = cdp;
    const handler = async (ev) => {
      try { await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch {}
      const dataUrl = `data:image/${screencast.format};base64,${ev.data}`;
      const payload = JSON.stringify({ ok: true, type: 'SCREENCAST_FRAME', dataUrl });
      for (const client of Array.from(screencast.clients)) {
        try { client.send(payload); } catch {}
      }
    };
    cdp.on('Page.screencastFrame', handler);
    screencast.onFrame = handler;
    await cdp.send('Page.startScreencast', { format: screencast.format, quality: 60, everyNthFrame: 1 });
    screencast.running = true;
    return true;
  } catch (e) {
    try { if (screencast.cdp) await screencast.cdp.detach(); } catch {}
    screencast.cdp = null; screencast.onFrame = null; screencast.running = false;
    return false;
  }
}

async function legacyStopScreencast(force = false) {
  if (!screencast.running && !force) return;
  try {
    if (screencast.cdp) {
      try { await screencast.cdp.send('Page.stopScreencast'); } catch {}
      try { if (screencast.onFrame) { screencast.cdp.off?.('Page.screencastFrame', screencast.onFrame); } } catch {}
      try { await screencast.cdp.detach(); } catch {}
    }
  } catch {}
  screencast.cdp = null; screencast.onFrame = null; screencast.running = false;
  if (force) screencast.clients.clear();
}

async function ensureControlBrowser() {
  if (controlBrowser) return controlBrowser;
  if (controlBrowserInitPromise) return controlBrowserInitPromise;
  controlBrowserInitPromise = (async () => {
    const launchArgs = [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--use-gl=swiftshader'
    ];
    const browserCtl = await chromium.launch({
      headless: true,
      args: launchArgs
    });
    browserCtl.on('disconnected', () => {
      controlBrowser = null;
      controlPage = null;
    });
    return browserCtl;
  })();
  try {
    controlBrowser = await controlBrowserInitPromise;
    return controlBrowser;
  } finally {
    controlBrowserInitPromise = null;
  }
}

async function getControlPage() {
  await ensureBrowser();
  try {
    if (controlPage && !controlPage.isClosed()) {
      return controlPage;
    }
  } catch { controlPage = null; }
  if (controlPageInitPromise) {
    try { return await controlPageInitPromise; } catch (err) { controlPageInitPromise = null; throw err; }
  }
  controlPageInitPromise = (async () => {
    const browserCtl = await ensureControlBrowser();
    const page = await browserCtl.newPage();
    const targetUrl = `http://127.0.0.1:${PORT}/noplanner?auto=1`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__NEROVA_AGENT && window.__NEROVA_AGENT.ready === true, { timeout: 20000 });
    return page;
  })();
  try {
    controlPage = await controlPageInitPromise;
    return controlPage;
  } finally {
    controlPageInitPromise = null;
  }
}

async function startRemoteAgent({
  prompt: promptText,
  contextNotes = '',
  criticKey = null,
  assistantKey = null,
  assistantId = process.env.ASSISTANT_ID2 || null
} = {}) {
  const prompt = String(promptText || '').trim();
  if (!prompt) throw new Error('prompt_required');
  try { log('[agent] launching run', { prompt: prompt.slice(0, 160) }); } catch {}
  const result = await runAgentWorkflow({
    prompt,
    contextNotes,
    openaiApiKey: criticKey,
    assistantOpenAiKey: assistantKey,
    assistantId,
    onEvent: (event) => broadcastRunEvent(event)
  });
  return result;
}

wss.on('connection', (ws, req) => {
  let pathname = '/';
  try {
    const host = req?.headers?.host || '127.0.0.1';
    pathname = new URL(req?.url || '/', `http://${host}`).pathname;
  } catch {
    pathname = (req && req.url) || '/';
  }
  if (pathname.startsWith('/agent/connect')) {
    attachAgent(ws, req);
    return;
  }
  ws.on('close', async () => {
    try {
      if (screencast.clients.has(ws)) {
        screencast.clients.delete(ws);
        if (screencast.clients.size === 0) await legacyStopScreencast(true);
      }
    } catch {}
  });
  ws.on('message', async (raw) => {
    let msg = null;
    try { msg = JSON.parse(raw.toString()); } catch { ws.send(JSON.stringify({ ok:false, type:'ERROR', error:'bad_json' })); return; }
    try {
      await ensureBrowser();
      if (msg.type === 'PRESS_KEY') {
        try {
          const key = String(msg.key || '').trim();
          if (!key) { ws.send(JSON.stringify({ ok:false, type:'PRESS_KEY', error:'missing_key' })); return; }
          await page.keyboard.press(key);
          ws.send(JSON.stringify({ ok:true, type:'PRESSED', key }));
        } catch (e) {
          ws.send(JSON.stringify({ ok:false, type:'PRESS_KEY', error:String(e) }));
        }
        return;
      }
      if (msg.type === 'SERVER_IP') {
        try {
          const r = await fetch('https://api.ipify.org?format=json');
          const j = await r.json();
          ws.send(JSON.stringify({ ok: true, type: 'SERVER_IP', ip: j && j.ip || null, env: {
            fly: {
              app: process.env.FLY_APP_NAME || null,
              machine: process.env.FLY_MACHINE_ID || null,
              alloc: process.env.FLY_ALLOC_ID || null,
              region: process.env.FLY_REGION || null
            }
          }}));
        } catch (e) {
          ws.send(JSON.stringify({ ok:false, type:'SERVER_IP', error: String(e) }));
        }
        return;
      }
      if (msg.type === 'BROWSER_IP') {
        try {
          // Evaluate in page context to get egress IP of the browser session
          const j = await page.evaluate(async () => {
            try { const r = await fetch('https://api.ipify.org?format=json'); return await r.json(); } catch (e) { return { error: String(e) }; }
          });
          ws.send(JSON.stringify({ ok: true, type:'BROWSER_IP', ip: j && j.ip || null, raw: j }));
        } catch (e) {
          ws.send(JSON.stringify({ ok:false, type:'BROWSER_IP', error: String(e) }));
        }
        return;
      }
      if (msg.type === 'START_SCREENCAST') {
        try { screencast.clients.add(ws); } catch {}
        const ok = await legacyStartScreencast();
        ws.send(JSON.stringify({ ok: !!ok, type: 'SCREENCAST_STARTED' }));
        return;
      }
      if (msg.type === 'STOP_SCREENCAST') {
        try { screencast.clients.delete(ws); } catch {}
        if (screencast.clients.size === 0) await legacyStopScreencast(true);
        ws.send(JSON.stringify({ ok: true, type: 'SCREENCAST_STOPPED' }));
        return;
      }
      if (msg.type === 'FOCUS') {
        try {
          await ensureBrowser();
          // Prefer the most recently opened, visible page
          const pages = browser.pages();
          let pick = pages[pages.length - 1];
          // If last is about:blank, find a non-blank
          for (let i = pages.length - 1; i >= 0; i--) {
            try {
              const u = await pages[i].url();
              if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; }
            } catch {}
          }
          if (pick) page = pick;
          try { await page.bringToFront(); } catch {}
        } catch {}
        ws.send(JSON.stringify({ ok: true, type: 'FOCUSED' }));
        return;
      }
      if (msg.type === 'SCREENCAST_SUB') {
        try { screencastSubscribers.add(ws); } catch {}
        await startScreencast({ quality: 60, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
        ws.send(JSON.stringify({ ok: true, type: 'SCREENCAST_STATUS', active: screencastActive }));
        return;
      }
      if (msg.type === 'SCREENCAST_UNSUB') {
        try { screencastSubscribers.delete(ws); } catch {}
        if (screencastSubscribers.size === 0) { await stopScreencast(); }
        ws.send(JSON.stringify({ ok: true, type: 'SCREENCAST_STATUS', active: screencastActive }));
        return;
      }
      if (msg.type === 'NAVIGATE') {
        await page.goto(msg.url, { waitUntil: 'load' });
        try { await page.bringToFront(); } catch {}
        await stabilizeBeforeScreenshot();
        const shot = await page.screenshot({ fullPage: false });
        ws.send(JSON.stringify({ ok: true, type: 'NAVIGATED', url: msg.url, preview: `data:image/png;base64,${shot.toString('base64')}` }));
        return;
      }
      if (msg.type === 'GET_URL') {
        try {
          // Always read URL from the active (most recent non-blank) page
          const pages = browser.pages();
          let pick = pages[pages.length - 1];
          for (let i = pages.length - 1; i >= 0; i--) {
            try { const u = await pages[i].url(); if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; } } catch {}
          }
          if (pick) page = pick;
          const url = await page.url();
          ws.send(JSON.stringify({ ok: true, type: 'URL', url }));
        } catch (e) {
          ws.send(JSON.stringify({ ok: false, type: 'URL', error: String(e) }));
        }
        return;
      }
      // UI-only window visibility control
      if (msg.type === 'HIDE_WINDOW') {
        // If browser not launched yet, request off-screen position on first window
        if (!browser) { windowHideOnNextLaunch = true; }
        const ok = await setWindowHidden(true); ws.send(JSON.stringify({ ok, type:'HIDE_WINDOW' })); return;
      }
      if (msg.type === 'SHOW_WINDOW') { const ok = await setWindowHidden(false); ws.send(JSON.stringify({ ok, type:'SHOW_WINDOW' })); return; }
      if (msg.type === 'OCR_SCREEN_JSON') {
        // Screenshot with overlay OCR via OCR.space
        await stabilizeBeforeScreenshot();
        const shot = await page.screenshot({ fullPage: false });
        const base64Image = `data:image/png;base64,${shot.toString('base64')}`;
        const data = await ocrSpace({ base64Image, language: msg.language, apiKey: msg.apiKey, overlay: true });
        const dpr = await page.evaluate(() => window.devicePixelRatio || 1);
        const items = [];
        const prs = Array.isArray(data.ParsedResults) ? data.ParsedResults : [];
        for (const pr of prs) {
          const overlay = pr.TextOverlay || {};
          const lines = Array.isArray(overlay.Lines) ? overlay.Lines : [];
          for (const line of lines) {
            const words = Array.isArray(line.Words) ? line.Words : [];
            if (!words.length) continue;
            let minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
            const parts = [];
            for (const w of words) {
              const left = Number(w.Left) || 0;
              const top = Number(w.Top) || 0;
              const width = Number(w.Width) || 0;
              const height = Number(w.Height) || 0;
              minL = Math.min(minL, left);
              minT = Math.min(minT, top);
              maxR = Math.max(maxR, left + width);
              maxB = Math.max(maxB, top + height);
              const t = (w.WordText || w.text || '').toString().trim();
              if (t) parts.push(t);
            }
            const text = parts.join(' ').replace(/\s+/g, ' ').trim();
            if (!text) continue;
            const cx = (minL + (maxR - minL) / 2) / dpr;
            const cy = (minT + (maxB - minT) / 2) / dpr;
            items.push({ text, center: [Math.round(cx), Math.round(cy)] });
          }
        }
        ws.send(JSON.stringify({ ok: true, items }));
        return;
      }
      if (msg.type === 'FIND_ICONS') {
        const { options = {} } = msg;
        const res = await page.evaluate((opts) => {
          function isVisible(el){ const s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||parseFloat(s.opacity||'1')===0) return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.left<innerWidth&&r.top<innerHeight; }
          function rect(el){ const r=el.getBoundingClientRect(); return {left:r.left,top:r.top,width:r.width,height:r.height}; }
          function findIcons(){
            const out=[]; const els=Array.from(document.querySelectorAll('*'));
            for(const el of els){
              try{
                if(!isVisible(el)) continue; const tag=el.tagName.toLowerCase();
                const role=el.getAttribute('role')||null; const aria=el.getAttribute('aria-label')||null; const title=el.getAttribute('title')||null;
                const cls=(el.className?.toString?.()||'').toLowerCase(); const id=el.id||'';
                const hint=(role+" "+aria+" "+title+" "+cls+" "+id).toLowerCase();
                let is=false;
                if(tag==='svg') is=true;
                else if(tag==='img'){
                  const r=el.getBoundingClientRect(); const sq=Math.abs(r.width-r.height)<=Math.max(4,0.2*Math.max(r.width,r.height)); const small=Math.max(r.width,r.height)<=64; const src=el.currentSrc||el.src||''; const nameHint=/icon|glyph|logo|favicon|sprite|menu|close|search|settings|heart|star|arrow/i.test(src);
                  is = (sq && small) || nameHint;
                } else {
                  const s=getComputedStyle(el);
                  const usesIconFont=/(fontawesome|fa |fa-|material icons|mdi|ionicons|octicons|bootstrap-icons|bi )/.test((s.fontFamily||'').toLowerCase());
                  const pseudo=getComputedStyle(el,'::before').content+getComputedStyle(el,'::after').content; const hasGlyph=pseudo && pseudo!=='none' && pseudo!=='""';
                  const bg=s.backgroundImage||''; const hasBg=bg&&bg!=='none';
                  if(usesIconFont&&hasGlyph) is=true; else if(hasBg){ const r=el.getBoundingClientRect(); if(Math.max(r.width,r.height)<=64) is=true; }
                }
                if(!is && /(icon|fa-|bi-|mdi-|ion-|glyph|material-icons|octicon|heroicon)/.test(hint)) is=true;
                if(!is) continue; const b=rect(el); if(b.width<=0||b.height<=0) continue;
                out.push({ box:b, tag:tag, role:role, title:title, ariaLabel:aria }); if(out.length>= (opts.maxIcons||500)) break;
              }catch{}
            }
            return out;
          }
          function ensureLayer(){ let layer=document.getElementById('wocr-hl'); if(!layer){ layer=document.createElement('div'); layer.id='wocr-hl'; layer.style.cssText='position:fixed;inset:0;z-index:2147483645;pointer-events:none;'; document.documentElement.appendChild(layer);} return layer; }
          function clearLayer(){ const l=document.getElementById('wocr-hl'); if(l) l.remove(); }
          const icons = findIcons();
          if(opts.highlight){ const layer=ensureLayer(); layer.innerHTML=''; for(const ic of icons){ const d=document.createElement('div'); d.style.cssText='position:absolute;border:2px solid #ffcc00;background:rgba(255,204,0,.12);border-radius:4px;'; d.style.left=ic.box.left+'px'; d.style.top=ic.box.top+'px'; d.style.width=ic.box.width+'px'; d.style.height=ic.box.height+'px'; layer.appendChild(d);} if(opts.highlightDurationMs>0){ setTimeout(clearLayer, opts.highlightDurationMs);} }
          return { icons };
        }, options);
        ws.send(JSON.stringify({ ok: true, icons: res.icons }));
        return;
      }
      if (msg.type === 'FIND_HITTABLE') {
        const { options = {} } = msg;
        const res = await page.evaluate((opts) => {
          function isVisible(el){ const s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||parseFloat(s.opacity||'1')===0) return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.left<innerWidth&&r.top<innerHeight; }
          function isHittable(el){ if(!isVisible(el)) return false; const s=getComputedStyle(el); if(s.pointerEvents==='none') return false; if(el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true') return false; const tag=el.tagName.toLowerCase(); if(tag==='a'&&el.getAttribute('href')) return true; if(tag==='button'||tag==='summary'||tag==='select'||tag==='textarea') return true; if(tag==='input'){ const t=(el.getAttribute('type')||'').toLowerCase(); if(t!=='hidden') return true; } const ti=el.getAttribute('tabindex'); const tiNum=ti!=null?parseInt(ti,10):NaN; if(!Number.isNaN(tiNum)&&tiNum>=0) return true; if((s.cursor||'').includes('pointer')) return true; if(typeof el.onclick==='function'||el.getAttribute('onclick')) return true; return false; }
          function rect(el){ const r=el.getBoundingClientRect(); return {left:r.left,top:r.top,width:r.width,height:r.height}; }
          function ensureLayer(){ let layer=document.getElementById('wocr-hl'); if(!layer){ layer=document.createElement('div'); layer.id='wocr-hl'; layer.style.cssText='position:fixed;inset:0;z-index:2147483645;pointer-events:none;'; document.documentElement.appendChild(layer);} return layer; }
          function clearLayer(){ const l=document.getElementById('wocr-hl'); if(l) l.remove(); }
          const out=[]; const nodes=Array.from(document.querySelectorAll('*'));
          for(const el of nodes){ try{ if(!isHittable(el)) continue; const b=rect(el); if(Math.max(b.width,b.height)< (opts.minSize||8)) continue; out.push({ box:b }); if(out.length>= (opts.max||2000)) break; }catch{} }
          if(opts.highlight){ const layer=ensureLayer(); layer.innerHTML=''; for(const it of out){ const d=document.createElement('div'); d.style.cssText='position:absolute;border:2px solid #33ff99;background:rgba(51,255,153,.15)'; d.style.left=it.box.left+'px'; d.style.top=it.box.top+'px'; d.style.width=it.box.width+'px'; d.style.height=it.box.height+'px'; layer.appendChild(d);} if(opts.highlightDurationMs>0){ setTimeout(clearLayer, opts.highlightDurationMs);} }
          return out;
        }, options);
        ws.send(JSON.stringify({ ok: true, elements: res }));
        return;
      }
      if (msg.type === 'HIGHLIGHT_IFRAMES') {
        const { options = {} } = msg;
        const res = await page.evaluate((opts)=>{
          function isRectVisible(r){ return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.left<innerWidth&&r.top<innerHeight; }
          function ensureLayer(){ let layer=document.getElementById('wocr-hl'); if(!layer){ layer=document.createElement('div'); layer.id='wocr-hl'; layer.style.cssText='position:fixed;inset:0;z-index:2147483645;pointer-events:none;'; document.documentElement.appendChild(layer);} return layer; }
          function clearLayer(){ const l=document.getElementById('wocr-hl'); if(l) l.remove(); }
          const items=[]; const frames=Array.from(document.querySelectorAll('iframe'));
          for(const f of frames){ try{ const r=f.getBoundingClientRect(); if(!isRectVisible(r)) continue; items.push({ box:{left:r.left,top:r.top,width:r.width,height:r.height}, src:f.getAttribute('src')||null, id:f.id||null, name:f.getAttribute('name')||null }); }catch{} }
          if(opts.highlight){ const layer=ensureLayer(); layer.innerHTML=''; for(const it of items){ const d=document.createElement('div'); d.style.cssText='position:absolute;border:2px solid #3399ff;background:rgba(51,153,255,.12)'; d.style.left=it.box.left+'px'; d.style.top=it.box.top+'px'; d.style.width=it.box.width+'px'; d.style.height=it.box.height+'px'; layer.appendChild(d);} if(opts.highlightDurationMs>0){ setTimeout(clearLayer, opts.highlightDurationMs);} }
          return items;
        }, options);
        ws.send(JSON.stringify({ ok: true, iframes: res }));
        return;
      }
      if (msg.type === 'HIGHLIGHT_TOGGLES') {
        const { options = {} } = msg;
        if (options.discover) {
          // Not fully interactive via WS; acknowledge
          ws.send(JSON.stringify({ ok: true, success: false, note: 'Discover not supported in WS demo yet' }));
          return;
        }
        const res = await page.evaluate((opts)=>{
          function isVisible(el){ const s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||parseFloat(s.opacity||'1')===0) return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.left<innerWidth&&r.top<innerHeight; }
          function isHittable(el){ if(!isVisible(el)) return false; const s=getComputedStyle(el); if(s.pointerEvents==='none') return false; if(el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true') return false; const tag=el.tagName.toLowerCase(); if(tag==='a'&&el.getAttribute('href')) return true; if(tag==='button'||tag==='summary'||tag==='select'||tag==='textarea') return true; if(tag==='input'){ const t=(el.getAttribute('type')||'').toLowerCase(); if(t!=='hidden') return true; } const ti=el.getAttribute('tabindex'); const tiNum=ti!=null?parseInt(ti,10):NaN; if(!Number.isNaN(tiNum)&&tiNum>=0) return true; if((s.cursor||'').includes('pointer')) return true; if(typeof el.onclick==='function'||el.getAttribute('onclick')) return true; return false; }
          function ensureLayer(){ let layer=document.getElementById('wocr-hl'); if(!layer){ layer=document.createElement('div'); layer.id='wocr-hl'; layer.style.cssText='position:fixed;inset:0;z-index:2147483645;pointer-events:none;'; document.documentElement.appendChild(layer);} return layer; }
          function clearLayer(){ const l=document.getElementById('wocr-hl'); if(l) l.remove(); }
          function scoreToggle(el){ if(!isHittable(el)) return 0; const role=(el.getAttribute('role')||'').toLowerCase(); const tag=el.tagName.toLowerCase(); const cls=(el.className?.toString?.()||'').toLowerCase(); const name=((el.getAttribute('aria-label')||'')+' '+(el.innerText||'')).toLowerCase(); let score=0; if(tag==='select'||tag==='summary'||tag==='details') score+=3; if(role==='combobox') score+=2; if(role==='button'&&(el.hasAttribute('aria-haspopup')||el.hasAttribute('aria-controls'))) score+=1; if(el.hasAttribute('aria-haspopup')){ const v=(el.getAttribute('aria-haspopup')||'').toLowerCase(); if(v===''||v==='true'||v==='menu'||v==='listbox'||v==='dialog') score+=2; } if(el.hasAttribute('aria-expanded')) score+=1; if(el.hasAttribute('aria-controls')){ const ids=(el.getAttribute('aria-controls')||'').split(/\s+/).filter(Boolean); for(const id of ids){ const tgt=document.getElementById(id); if(!tgt) continue; const r=(tgt.getAttribute('role')||'').toLowerCase(); const st=getComputedStyle(tgt); const looks=r==='menu'||r==='listbox'||r==='dialog'||st.position==='absolute'||st.position==='fixed'; if(looks){ score+=2; break; } } } const dataToggle=(el.getAttribute('data-toggle')||el.getAttribute('data-dropdown')||el.getAttribute('data-menu')||'').toLowerCase(); const bs=(el.getAttribute('data-bs-toggle')||'').toLowerCase(); if(dataToggle.includes('dropdown')||dataToggle.includes('menu')||bs==='dropdown') score+=1; const icon=!!el.querySelector('svg,i'); const hint=/(dropdown|caret|chevron|more|options|kebab|dots|ellipsis)/; if(icon&&(hint.test(cls)||hint.test(name))) score+=1; return score; }
          const items=[]; const nodes=Array.from(document.querySelectorAll('*'));
          for(const el of nodes){ try{ const sc=scoreToggle(el); if(sc>=3){ const r=el.getBoundingClientRect(); items.push({ box:{left:r.left,top:r.top,width:r.width,height:r.height} }); } }catch{} }
          if(opts.highlight){ const layer=ensureLayer(); layer.innerHTML=''; for(const it of items){ const d=document.createElement('div'); d.style.cssText='position:absolute;border:2px solid #66ccff;background:rgba(102,204,255,.12)'; d.style.left=it.box.left+'px'; d.style.top=it.box.top+'px'; d.style.width=it.box.width+'px'; d.style.height=it.box.height+'px'; layer.appendChild(d);} if(opts.highlightDurationMs>0){ setTimeout(clearLayer, opts.highlightDurationMs);} }
          return items;
        }, options);
        ws.send(JSON.stringify({ ok: true, toggles: res }));
        return;
      }
      // Step 2: Aggregate candidates across main document AND visible iframes
      if (msg.type === 'GRAB_CANDIDATE_STRINGS') {
        const options = msg.options || {};
        const minSize = Math.max(6, options.minSize || 8);
        const maxItems = Math.max(100, options.max || 2000);

        // Wait for page + visible iframes to finish initial load to avoid premature collection
        async function stabilizeForCandidates(totalTimeoutMs = 2500) {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const deadline = Date.now() + Math.max(500, totalTimeoutMs);
          try { await page.waitForLoadState('domcontentloaded', { timeout: 1500 }); } catch {}
          try { await page.waitForLoadState('load', { timeout: 1500 }); } catch {}
          try { await page.waitForLoadState('networkidle', { timeout: 1500 }); } catch {}
          // Wait a brief idle period
          await sleep(150);
          const frames = page.frames();
          for (const f of frames) {
            if (f === page.mainFrame()) continue;
            const remaining = Math.max(0, deadline - Date.now());
            if (remaining <= 0) break;
            try {
              const fe = await f.frameElement();
              if (!fe) continue;
              const box = await fe.boundingBox();
              if (!box || box.width <= 0 || box.height <= 0) continue; // only visible iframes
              try { await f.waitForLoadState('domcontentloaded', { timeout: Math.min(900, remaining) }); } catch {}
              try { await f.waitForLoadState('load', { timeout: Math.min(900, Math.max(0, deadline - Date.now())) }); } catch {}
              try { await f.waitForLoadState('networkidle', { timeout: Math.min(900, Math.max(0, deadline - Date.now())) }); } catch {}
            } catch {}
          }
          // final short settle
          await sleep(120);
        }

        await stabilizeForCandidates(2500);

        // Helper: collect raw hittables from a given frame context
        async function collectRawFromFrame(f) {
          return await f.evaluate((minSize) => {
            function collapseWhitespace(text){ return (text||'').replace(/\s+/g,' ').trim(); }
            function isVisible(el){ const s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||parseFloat(s.opacity||'1')===0) return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.left<innerWidth&&r.top<innerHeight; }
            function isHittable(el){ if(!isVisible(el)) return false; const s=getComputedStyle(el); if(s.pointerEvents==='none') return false; if(el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true') return false; const tag=el.tagName.toLowerCase(); if(tag==='a'&&el.getAttribute('href')) return true; if(tag==='button'||tag==='summary'||tag==='select'||tag==='textarea') return true; if(tag==='input'){ const t=(el.getAttribute('type')||'').toLowerCase(); if(t!=='hidden') return true; } const ti=el.getAttribute('tabindex'); const tiNum=ti!=null?parseInt(ti,10):NaN; if(!Number.isNaN(tiNum)&&tiNum>=0) return true; if((s.cursor||'').includes('pointer')) return true; if(typeof el.onclick==='function'||el.getAttribute('onclick')) return true; return false; }
            function computeRole(el){ const aria=(el.getAttribute('role')||'').trim(); if(aria) return aria.toLowerCase(); const tag=el.tagName.toLowerCase(); if(tag==='a') return (el.getAttribute('href')?'link':'generic'); if(tag==='button') return 'button'; if(tag==='input'){ const type=(el.getAttribute('type')||'').toLowerCase(); if(['button','submit','reset','image'].includes(type)) return 'button'; if(['checkbox'].includes(type)) return 'checkbox'; if(['radio'].includes(type)) return 'radio'; if(['range'].includes(type)) return 'slider'; return 'textbox'; } if(tag==='select') return 'combobox'; if(tag==='textarea') return 'textbox'; if(tag==='summary') return 'button'; return 'generic'; }
            function computeEnabled(el){ const style=getComputedStyle(el); const disabledAttr=el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true'; const peNone=style.pointerEvents==='none'; const opacityOk=parseFloat(style.opacity||'1')>=0.4; return !disabledAttr && !peNone && opacityOk; }
            function shortAnchor(el){ let cur=el, levels=0; while(cur&&levels<4){ if(cur.id) return `#${cur.id}`; const dt=cur.getAttribute&& (cur.getAttribute('data-testid')||cur.getAttribute('data-test')||cur.getAttribute('data-qa')); if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`; const al=cur.getAttribute&&cur.getAttribute('aria-label'); if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`; cur=cur.parentElement; levels++; } const parts=[]; cur=el; for(let i=0;i<3&&cur;i++){ const tag=(cur.tagName||'div').toLowerCase(); const parent=cur.parentElement; if(!parent){ parts.unshift(tag); break; } const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName); const idx=siblings.indexOf(cur)+1; parts.unshift(`${tag}:nth-of-type(${idx})`); cur=parent; } return parts.join('>'); }
            function bestSelector(el){ if(el.id) return `#${el.id}`; const dt=el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-qa'); if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`; const al=el.getAttribute('aria-label'); if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`; const parts=[]; let cur=el; for(let i=0;i<3&&cur;i++){ const tag=(cur.tagName||'div').toLowerCase(); const parent=cur.parentElement; if(!parent){ parts.unshift(tag); break; } const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName); const idx=siblings.indexOf(cur)+1; parts.unshift(`${tag}:nth-of-type(${idx})`); cur=parent; } let sel=parts.join('>'); if(sel.length>80) sel=sel.slice(0,80); return sel; }
            function hash36(str){ let h=5381; for(let i=0;i<str.length;i++){ h=((h<<5)+h)+str.charCodeAt(i); h|=0; } return (h>>>0).toString(36); }
            function isOccluded(el,r){ const cx=r.left+r.width/2, cy=r.top+r.height/2; const top= document.elementFromPoint(cx,cy); return top ? !el.contains(top) && top!==el : true; }
            const nodes=Array.from(document.querySelectorAll('*'));
            const items=[]; const idCounts=new Map();
            for(const el of nodes){ try{
              if(!isHittable(el)) continue; const r=el.getBoundingClientRect(); if(Math.max(r.width,r.height) < minSize) continue;
              const name = collapseWhitespace((el.getAttribute('aria-label')||'') || el.innerText || el.textContent || '');
              const role = computeRole(el); const enabled=computeEnabled(el);
              const cx = r.left + r.width/2, cy = r.top + r.height/2;
              let hit_state='hittable'; if(!enabled) hit_state='disabled'; else if(r.right<0||r.bottom<0||r.left>innerWidth||r.top>innerHeight) hit_state='offscreen_page'; else if(isOccluded(el,r)) hit_state='occluded';
              const selector = bestSelector(el); const href = el.tagName.toLowerCase()==='a' && el.href ? el.href : null; const anchor=shortAnchor(el);
              const idBase = `${role}|${name.toLowerCase()}|${anchor}|${selector}`; let id=hash36(idBase); const prev=idCounts.get(id)||0; if(prev>0) id=`${id}-${prev}`; idCounts.set(id, prev+1);
              const className = el.className?.toString?.()||'';
              items.push({ id, name, role, enabled, hit_state, center:[Math.round(cx),Math.round(cy)], rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)], selector, href, anchor, className });
            }catch{} }
            return items;
          }, minSize);
        }

        // 1) Main document
        const mainItems = await collectRawFromFrame(page);
        let all = Array.isArray(mainItems) ? mainItems : [];

        // 2) Visible iframes
        const frames = page.frames();
        for (const f of frames) {
          if (f === page.mainFrame()) continue;
          try {
            const fe = await f.frameElement();
            if (!fe) continue;
            const box = await fe.boundingBox();
            if (!box || box.width <= 0 || box.height <= 0) continue;
            const hits = await collectRawFromFrame(f);
            for (const h of hits) {
              const adjCenter = [ Math.round(box.x + (h.center?.[0] || 0)), Math.round(box.y + (h.center?.[1] || 0)) ];
              const hr = h.rect || [0,0,0,0];
              const adjRect = [ Math.round(box.x + (hr[0]||0)), Math.round(box.y + (hr[1]||0)), hr[2]||0, hr[3]||0 ];
              all.push({ ...h, center: adjCenter, rect: adjRect });
            }
          } catch {}
        }

        // 3) Filtering pipeline (Gate B + dedupe by id and center)
        const enabled = all.filter(it => it && it.enabled && it.hit_state === 'hittable' && (it.name || it.selector));
        function rectArea(rc){ return Math.max(0, rc[2]) * Math.max(0, rc[3]); }
        function overlapArea(a,b){ const ax2=a[0]+a[2], ay2=a[1]+a[3]; const bx2=b[0]+b[2], by2=b[1]+b[3]; const x1=Math.max(a[0],b[0]); const y1=Math.max(a[1],b[1]); const x2=Math.min(ax2,bx2); const y2=Math.min(ay2,by2); const w=Math.max(0,x2-x1); const h=Math.max(0,y2-y1); return w*h; }
        const isAction = (role) => ['button','link','combobox'].includes(String(role||'').toLowerCase());
        const drop = new Set();
        for (let i=0;i<enabled.length;i++){
          if (drop.has(i)) continue; const A = enabled[i]; const aRect=A.rect; const aArea=rectArea(aRect);
          for (let j=0;j<enabled.length;j++){
            if (i===j || drop.has(j)) continue; const B = enabled[j]; const bRect=B.rect; const bArea=rectArea(bRect); if (bArea<=0) { drop.add(j); continue; }
            const inter = overlapArea(aRect, bRect); const frac = inter / bArea;
            if (frac >= 0.85) {
              const aAct = isAction(A.role), bAct = isAction(B.role);
              if (aAct && !bAct) { drop.add(j); continue; }
              if (!aAct && !bAct) { if (aArea >= bArea) { drop.add(j); continue; } drop.add(i); break; }
            }
          }
        }
        const afterGateB = enabled.filter((_,idx)=>!drop.has(idx));
        const byId = new Map(); for (const it of afterGateB) { if (!byId.has(it.id)) byId.set(it.id, it); }
        // Strong preference for non-empty name when deduping by center
        const byCenter = new Map();
        for (const it of byId.values()) {
          const key = `${it.center?.[0]||0}x${it.center?.[1]||0}`;
          const prev = byCenter.get(key);
          if (!prev) { byCenter.set(key, it); continue; }
          const prevHas = !!(prev.name||'').trim(); const curHas = !!(it.name||'').trim();
          if (curHas && !prevHas) { byCenter.set(key, it); continue; }
          if (!curHas && prevHas) { continue; }
          const act = (v)=>['button','link','combobox'].includes(String(v.role||'').toLowerCase());
          if (act(it) && !act(prev)) { byCenter.set(key, it); continue; }
        }
        let filtered = Array.from(byCenter.values()).slice(0, maxItems);

        // Final pass: if two entries share same selector and center, keep the one with a non-empty name
        const byKey = new Map();
        for (const it of filtered) {
          const key = `${it.selector || ''}|${it.center?.[0]||0}x${it.center?.[1]||0}`;
          const prev = byKey.get(key);
          if (!prev) { byKey.set(key, it); continue; }
          const prevHas = !!(prev.name||'').trim();
          const curHas = !!(it.name||'').trim();
          if (curHas && !prevHas) { byKey.set(key, it); continue; }
        }
        const finalList = Array.from(byKey.values());

        // Collapse duplicates across selector, but PRESERVE items with different non-empty names
        // Prefer within the same (selector + normalizedName) bucket: hittable > larger area > first-seen
        const areaOf = (rc) => Array.isArray(rc) ? Math.max(0, rc[2]) * Math.max(0, rc[3]) : 0;
        const scoreOf = (it) => (String(it.hit_state||'')==='hittable'?2:(String(it.hit_state||'')==='occluded'?1:0)) + (it.enabled?0.1:0) + Math.min(1, areaOf(it.rect)/20000);
        const normalizeName = (s) => String(s||'').toLowerCase().replace(/\s+/g,' ').trim();
        const bySelName = new Map();
        for (const it of finalList) {
          const sel = String(it.selector || '');
          if (!sel) continue;
          const n = normalizeName(it.name);
          const key = `${sel}|${n || '__noname__'}`;
          const prev = bySelName.get(key);
          if (!prev) { bySelName.set(key, it); continue; }
          const curScore = scoreOf(it);
          const prevScore = scoreOf(prev);
          if (curScore > prevScore) bySelName.set(key, it);
        }
        const selectorCollapsed = [ ...bySelName.values() ];
        // Include items without selectors as-is (rare but useful)
        const noSelector = finalList.filter(it => !it.selector);
        const finalSelectorList = [ ...selectorCollapsed, ...noSelector ].slice(0, maxItems);

        // 4) Build candidate strings
        function tokenize(s){ return String(s||'').toLowerCase().split(/[^a-z0-9]+/).filter(t=>t&&t.length>=3); }
        function hrefParts(href){ const out=[]; try{ const u=new URL(href); const segs=u.pathname.split('/').filter(Boolean); for(const seg of segs){ if(seg.length>=2) out.push('/'+seg); } }catch{} return out; }
        const result = finalSelectorList.map(it=>{
          const strings = new Set();
          if (it.selector) strings.add(it.selector);
          for (const hp of hrefParts(it.href)) strings.add(hp);
          for (const tok of tokenize(it.name)) strings.add(tok);
          for (const tok of tokenize(it.className)) strings.add(tok);
          return { id: it.id, name: it.name, strings: Array.from(strings).slice(0, 8) };
        });
        ws.send(JSON.stringify({ ok: true, candidates: result }));
        return;
      }

      if (msg.type === 'GRAB_HITTABLE_TEXTS' || msg.type === 'GRAB_ACCESSIBLE_NAMES' || msg.type === 'GRAB_HITTABLE_CANDIDATES') {
        const { options = {} } = msg;
        const res = await page.evaluate((payload) => {
          const { type, options } = payload;
          function collapseWhitespace(text){ return (text||'').replace(/\s+/g,' ').trim(); }
          function isVisible(el){ const s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||parseFloat(s.opacity||'1')===0) return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.left<innerWidth&&r.top<innerHeight; }
          function isHittable(el){ if(!isVisible(el)) return false; const s=getComputedStyle(el); if(s.pointerEvents==='none') return false; if(el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true') return false; const tag=el.tagName.toLowerCase(); if(tag==='a'&&el.getAttribute('href')) return true; if(tag==='button'||tag==='summary'||tag==='select'||tag==='textarea') return true; if(tag==='input'){ const t=(el.getAttribute('type')||'').toLowerCase(); if(t!=='hidden') return true; } const ti=el.getAttribute('tabindex'); const tiNum=ti!=null?parseInt(ti,10):NaN; if(!Number.isNaN(tiNum)&&tiNum>=0) return true; if((s.cursor||'').includes('pointer')) return true; if(typeof el.onclick==='function'||el.getAttribute('onclick')) return true; return false; }
          function computeRole(el){ const aria=(el.getAttribute('role')||'').trim(); if(aria) return aria.toLowerCase(); const tag=el.tagName.toLowerCase(); if(tag==='a') return (el.getAttribute('href')?'link':'generic'); if(tag==='button') return 'button'; if(tag==='input'){ const type=(el.getAttribute('type')||'').toLowerCase(); if(['button','submit','reset','image'].includes(type)) return 'button'; if(['checkbox'].includes(type)) return 'checkbox'; if(['radio'].includes(type)) return 'radio'; if(['range'].includes(type)) return 'slider'; return 'textbox'; } if(tag==='select') return 'combobox'; if(tag==='textarea') return 'textbox'; if(tag==='summary') return 'button'; return 'generic'; }
          function computeEnabled(el){ const style=getComputedStyle(el); const disabledAttr=el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true'; const peNone=style.pointerEvents==='none'; const opacityOk=parseFloat(style.opacity||'1')>=0.4; return !disabledAttr && !peNone && opacityOk; }
          function shortAnchor(el){ let cur=el, levels=0; while(cur&&levels<4){ if(cur.id) return `#${cur.id}`; const dt=cur.getAttribute&& (cur.getAttribute('data-testid')||cur.getAttribute('data-test')||cur.getAttribute('data-qa')); if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`; const al=cur.getAttribute&&cur.getAttribute('aria-label'); if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`; cur=cur.parentElement; levels++; } const parts=[]; cur=el; for(let i=0;i<3&&cur;i++){ const tag=(cur.tagName||'div').toLowerCase(); const parent=cur.parentElement; if(!parent){ parts.unshift(tag); break; } const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName); const idx=siblings.indexOf(cur)+1; parts.unshift(`${tag}:nth-of-type(${idx})`); cur=parent; } return parts.join('>'); }
          function bestSelector(el){ if(el.id) return `#${el.id}`; const dt=el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-qa'); if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`; const al=el.getAttribute('aria-label'); if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`; const parts=[]; let cur=el; for(let i=0;i<3&&cur;i++){ const tag=(cur.tagName||'div').toLowerCase(); const parent=cur.parentElement; if(!parent){ parts.unshift(tag); break; } const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName); const idx=siblings.indexOf(cur)+1; parts.unshift(`${tag}:nth-of-type(${idx})`); cur=parent; } let sel=parts.join('>'); if(sel.length>80) sel=sel.slice(0,80); return sel; }
          function hash36(str){ let h=5381; for(let i=0;i<str.length;i++){ h=((h<<5)+h)+str.charCodeAt(i); h|=0; } return (h>>>0).toString(36); }
          function isOccluded(el,r){ const cx=r.left+r.width/2, cy=r.top+r.height/2; const top= document.elementFromPoint(cx,cy); return top ? !el.contains(top) && top!==el : true; }
          const nodes=Array.from(document.querySelectorAll('*'));
          const items=[]; const idCounts=new Map();
          for(const el of nodes){ try{
            if(!isHittable(el)) continue; const r=el.getBoundingClientRect(); if(Math.max(r.width,r.height) < (options.minSize||8)) continue;
            const name = collapseWhitespace((el.getAttribute('aria-label')||'') || el.innerText || el.textContent || '');
            const role = computeRole(el); const enabled=computeEnabled(el);
            const cx = r.left + r.width/2, cy = r.top + r.height/2;
            let hit_state='hittable'; if(!enabled) hit_state='disabled'; else if(r.right<0||r.bottom<0||r.left>innerWidth||r.top>innerHeight) hit_state='offscreen_page'; else if(isOccluded(el,r)) hit_state='occluded';
            const selector = bestSelector(el); const href = el.tagName.toLowerCase()==='a' && el.href ? el.href : null; const anchor=shortAnchor(el);
            const idBase = `${role}|${name.toLowerCase()}|${anchor}|${selector}`; let id=hash36(idBase); const prev=idCounts.get(id)||0; if(prev>0) id=`${id}-${prev}`; idCounts.set(id, prev+1);
            items.push({ id, name, role, enabled, hit_state, center:[Math.round(cx),Math.round(cy)], rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)], selector, href, anchor, className: el.className?.toString?.()||'' });
          }catch{} }
          if(type==='GRAB_HITTABLE_TEXTS'){
            return { elements: items };
          }
          if(type==='GRAB_ACCESSIBLE_NAMES'){
            // Already includes name; just strip to essentials
            const out = items.map(it=>({ name: it.name, role: it.role, href: it.href, click:{ viewport:{ x: it.center[0], y: it.center[1] } }, rect:{ left: it.rect[0], top: it.rect[1], width: it.rect[2], height: it.rect[3] } }));
            return { elements: out };
          }
          function rectArea(rc){ return Math.max(0,rc[2]) * Math.max(0,rc[3]); }
          function overlapArea(a,b){ const ax2=a[0]+a[2], ay2=a[1]+a[3]; const bx2=b[0]+b[2], by2=b[1]+b[3]; const x1=Math.max(a[0],b[0]); const y1=Math.max(a[1],b[1]); const x2=Math.min(ax2,bx2); const y2=Math.min(ay2,by2); const w=Math.max(0,x2-x1); const h=Math.max(0,y2-y1); return w*h; }
          const enabledList = items.filter(it => it.enabled && it.hit_state==='hittable' && (it.name || it.selector));
          const isAction=(role)=> {
            const r=(role||'').toLowerCase();
            return r==='button'||r==='link'||r==='combobox';
          };
          const drop=new Set();
          for(let i=0;i<enabledList.length;i++){
            if(drop.has(i)) continue; const A=enabledList[i]; const aRect=A.rect; const aArea=rectArea(aRect);
            for(let j=0;j<enabledList.length;j++){
              if(i===j||drop.has(j)) continue; const B=enabledList[j]; const bRect=B.rect; const bArea=rectArea(bRect); if(bArea<=0){ drop.add(j); continue; }
              const inter=overlapArea(aRect,bRect); const frac=inter/bArea; if(frac>=0.85){ const aAct=isAction(A.role), bAct=isAction(B.role); if(aAct && !bAct){ drop.add(j); continue; } if(!aAct && !bAct){ if(aArea>=bArea){ drop.add(j); continue; } drop.add(i); break; } }
            }
          }
          const afterGateB = enabledList.filter((_,idx)=>!drop.has(idx));
          const byId=new Map(); for(const it of afterGateB){ if(!byId.has(it.id)) byId.set(it.id,it); }
          let filtered;
          if (type==='GRAB_CANDIDATE_STRINGS') {
            // Step 2 input: dedupe by center with strong preference for non-empty names
            const byCenter=new Map();
            for (const it of byId.values()) {
              const key = `${it.center[0]}x${it.center[1]}`;
              const prev = byCenter.get(key);
              if (!prev) { byCenter.set(key, it); continue; }
              const prevHasName = !!(prev.name||'').trim();
              const curHasName = !!(it.name||'').trim();
              if (curHasName && !prevHasName) { byCenter.set(key, it); continue; }
              if (!curHasName && prevHasName) { continue; }
              // If both have (or both lack) name, prefer actionable role
              const act = v => ['button','link','combobox'].includes((v.role||'').toLowerCase());
              if (act(it) && !act(prev)) { byCenter.set(key, it); continue; }
              // Otherwise keep existing
            }
            filtered = Array.from(byCenter.values());
          } else {
            // Other flows: original first-wins by center
            const byCenter=new Map();
            for (const it of byId.values()) {
              const key = `${it.center[0]}x${it.center[1]}`;
              if (!byCenter.has(key)) byCenter.set(key, it);
            }
            filtered = Array.from(byCenter.values());
          }
          if(type==='GRAB_HITTABLE_CANDIDATES'){
            const sanitized = filtered.map(({ anchor,className, ...rest })=>rest);
            return { elements: sanitized };
          }
          if(type==='GRAB_CANDIDATE_STRINGS'){
            // Additional final pass: if two entries share same selector and center, keep the one with a non-empty name
            const byKey=new Map();
            for(const it of filtered){
              const key=`${it.selector||''}|${it.center[0]}x${it.center[1]}`;
              const prev=byKey.get(key);
              if(!prev){ byKey.set(key,it); continue; }
              const prevHas=!!(prev.name||'').trim(); const curHas=!!(it.name||'').trim();
              if(curHas && !prevHas){ byKey.set(key,it); continue; }
            }
            const finalList=Array.from(byKey.values());
            function tokenize(s){ return (s||'').toLowerCase().split(/[^a-z0-9]+/).filter(t=>t&&t.length>=3); }
            function hrefParts(href){ const out=[]; try{ const u=new URL(href); const segs=u.pathname.split('/').filter(Boolean); for(const seg of segs){ if(seg.length>=2) out.push('/'+seg); } }catch{} return out; }
            const result = finalList.map(it=>{ const strings=new Set(); if(it.selector) strings.add(it.selector); for(const hp of hrefParts(it.href)) strings.add(hp); for(const tok of tokenize(it.name)) strings.add(tok); for(const tok of tokenize(it.className||'')) strings.add(tok); return { id: it.id, name: it.name, strings: Array.from(strings).slice(0,8) }; });
            return { candidates: result };
          }
          return { elements: items };
        }, { type: msg.type, options });
        ws.send(JSON.stringify({ ok: true, ...res }));
        return;
      }
      // OCR_IFRAMES_VIEWPORT_JSON removed: fallback via OCR is no longer used.
      if (msg.type === 'ICON_VISUAL_RECOGNITION') {
        // Fallback to DOM icon scan due to server simplicity
        const resp = await page.evaluate(()=>{
          function isVisible(el){ const s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||parseFloat(s.opacity||'1')===0) return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.left<innerWidth&&r.top<innerHeight; }
          function rect(el){ const r=el.getBoundingClientRect(); return {left:r.left,top:r.top,width:r.width,height:r.height}; }
          const out=[]; const els=Array.from(document.querySelectorAll('*'));
          for(const el of els){ try{ if(!isVisible(el)) continue; const tag=el.tagName.toLowerCase(); let is=false; if(tag==='svg') is=true; else if(tag==='img'){ const r=el.getBoundingClientRect(); const sq=Math.abs(r.width-r.height)<=Math.max(4,0.2*Math.max(r.width,r.height)); const small=Math.max(r.width,r.height)<=64; is = (sq && small); } if(!is) continue; const b=rect(el); out.push({ box:b, click:{ viewport:{ x: b.left+b.width/2, y: b.top+b.height/2 } } }); }catch{} }
          return out;
        });
        ws.send(JSON.stringify({ ok: true, items: resp }));
        return;
      }
      if (msg.type === 'SCAN_IFRAMES_HITTABLES') {
        const minSize = (msg.options && msg.options.minSize) || 8;
        const max = (msg.options && msg.options.max) || 2000;
        const frames = page.frames();
        const elements = [];
        for (const f of frames) {
          try {
            const fe = await f.frameElement();
            if (!fe) continue;
            const box = await fe.boundingBox();
            if (!box || box.width <= 0 || box.height <= 0) continue;
            const hits = await f.evaluate(({ minSize, max }) => {
              function collapseWhitespace(text){ return (text||'').replace(/\s+/g,' ').trim(); }
              function isVisible(el){ const s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||parseFloat(s.opacity||'1')===0) return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.left<innerWidth&&r.top<innerHeight; }
              function isHittable(el){ if(!isVisible(el)) return false; const s=getComputedStyle(el); if(s.pointerEvents==='none') return false; if(el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true') return false; const tag=el.tagName.toLowerCase(); if(tag==='a'&&el.getAttribute('href')) return true; if(tag==='button'||tag==='summary'||tag==='select'||tag==='textarea') return true; if(tag==='input'){ const t=(el.getAttribute('type')||'').toLowerCase(); if(t!=='hidden') return true; } const ti=el.getAttribute('tabindex'); const tiNum=ti!=null?parseInt(ti,10):NaN; if(!Number.isNaN(tiNum)&&tiNum>=0) return true; if((s.cursor||'').includes('pointer')) return true; if(typeof el.onclick==='function'||el.getAttribute('onclick')) return true; return false; }
              function computeRole(el){ const aria=(el.getAttribute('role')||'').trim(); if(aria) return aria.toLowerCase(); const tag=el.tagName.toLowerCase(); if(tag==='a') return (el.getAttribute('href')?'link':'generic'); if(tag==='button') return 'button'; if(tag==='input'){ const type=(el.getAttribute('type')||'').toLowerCase(); if(['button','submit','reset','image'].includes(type)) return 'button'; if(['checkbox'].includes(type)) return 'checkbox'; if(['radio'].includes(type)) return 'radio'; if(['range'].includes(type)) return 'slider'; return 'textbox'; } if(tag==='select') return 'combobox'; if(tag==='textarea') return 'textbox'; if(tag==='summary') return 'button'; return 'generic'; }
              function computeEnabled(el){ const style=getComputedStyle(el); const disabledAttr=el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true'; const peNone=style.pointerEvents==='none'; const opacityOk=parseFloat(style.opacity||'1')>=0.4; return !disabledAttr && !peNone && opacityOk; }
              function shortAnchor(el){ let cur=el, levels=0; while(cur&&levels<4){ if(cur.id) return `#${cur.id}`; const dt=cur.getAttribute&& (cur.getAttribute('data-testid')||cur.getAttribute('data-test')||cur.getAttribute('data-qa')); if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`; const al=cur.getAttribute&&cur.getAttribute('aria-label'); if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`; cur=cur.parentElement; levels++; } const parts=[]; cur=el; for(let i=0;i<3&&cur;i++){ const tag=(cur.tagName||'div').toLowerCase(); const parent=cur.parentElement; if(!parent){ parts.unshift(tag); break; } const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName); const idx=siblings.indexOf(cur)+1; parts.unshift(`${tag}:nth-of-type(${idx})`); cur=parent; } return parts.join('>'); }
              function bestSelector(el){ if(el.id) return `#${el.id}`; const dt=el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-qa'); if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`; const al=el.getAttribute('aria-label'); if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`; const parts=[]; let cur=el; for(let i=0;i<3&&cur;i++){ const tag=(cur.tagName||'div').toLowerCase(); const parent=cur.parentElement; if(!parent){ parts.unshift(tag); break; } const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName); const idx=siblings.indexOf(cur)+1; parts.unshift(`${tag}:nth-of-type(${idx})`); cur=parent; } let sel=parts.join('>'); if(sel.length>80) sel=sel.slice(0,80); return sel; }
              function hash36(str){ let h=5381; for(let i=0;i<str.length;i++){ h=((h<<5)+h)+str.charCodeAt(i); h|=0; } return (h>>>0).toString(36); }
              function isOccluded(el,r){ const cx=r.left+r.width/2, cy=r.top+r.height/2; const top= document.elementFromPoint(cx,cy); return top ? !el.contains(top) && top!==el : true; }
              const nodes=Array.from(document.querySelectorAll('*'));
              const items=[]; const idCounts=new Map();
              for(const el of nodes){ try{
                if(!isHittable(el)) continue; const r=el.getBoundingClientRect(); if(Math.max(r.width,r.height) < minSize) continue;
                const name = collapseWhitespace((el.getAttribute('aria-label')||'') || el.innerText || el.textContent || (el.getAttribute('placeholder')||''));
                const role = computeRole(el); const enabled=computeEnabled(el);
                const cx = r.left + r.width/2, cy = r.top + r.height/2;
                let hit_state='hittable'; if(!enabled) hit_state='disabled'; else if(r.right<0||r.bottom<0||r.left>innerWidth||r.top>innerHeight) hit_state='offscreen_page'; else if(isOccluded(el,r)) hit_state='occluded';
                const selector = bestSelector(el); const href = el.tagName.toLowerCase()==='a' && el.href ? el.href : null; const anchor=shortAnchor(el);
                const idBase = `${role}|${name.toLowerCase()}|${anchor}|${selector}`; let id=hash36(idBase); const prev=idCounts.get(id)||0; if(prev>0) id=`${id}-${prev}`; idCounts.set(id, prev+1);
                items.push({ id, name, role, enabled, hit_state, center:[Math.round(cx),Math.round(cy)], rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)], selector, href });
                if (items.length >= max) break;
              } catch{} }
              return items;
            }, { minSize, max });
            const frameUrl = f.url();
            for (const h of hits) {
              const vpCenter = [ Math.round(box.x + h.center[0]), Math.round(box.y + h.center[1]) ];
              const vpRect = [ Math.round(box.x + h.rect[0]), Math.round(box.y + h.rect[1]), h.rect[2], h.rect[3] ];
              elements.push({ ...h, center: vpCenter, rect: vpRect, frameUrl });
            }
          } catch {}
        }
        ws.send(JSON.stringify({ ok: true, type: 'IFRAME_SCAN', elements }));
        return;
      }
      if (msg.type === 'GET_HITTABLES_BY_IDS') {
        const idsWanted = new Set(Array.isArray(msg.ids) ? msg.ids : []);
        // Stabilize page and visible iframes before resolving IDs
        async function stabilizeForStep3(totalTimeoutMs = 2500) {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const deadline = Date.now() + Math.max(500, totalTimeoutMs);
          try { await page.waitForLoadState('domcontentloaded', { timeout: 1500 }); } catch {}
          try { await page.waitForLoadState('load', { timeout: 1500 }); } catch {}
          try { await page.waitForLoadState('networkidle', { timeout: 1500 }); } catch {}
          await sleep(120);
          const frames = page.frames();
          for (const f of frames) {
            if (f === page.mainFrame()) continue;
            const remaining = Math.max(0, deadline - Date.now()); if (remaining <= 0) break;
            try {
              const fe = await f.frameElement(); if (!fe) continue;
              const box = await fe.boundingBox(); if (!box || box.width<=0 || box.height<=0) continue;
              try { await f.waitForLoadState('domcontentloaded', { timeout: Math.min(900, remaining) }); } catch {}
              try { await f.waitForLoadState('load', { timeout: Math.min(900, Math.max(0, deadline - Date.now())) }); } catch {}
              try { await f.waitForLoadState('networkidle', { timeout: Math.min(900, Math.max(0, deadline - Date.now())) }); } catch {}
            } catch {}
          }
          await sleep(100);
        }

        await stabilizeForStep3(2500);
        // Helper to collect raw items from a frame
        async function collectRawFromFrame(f) {
          return await f.evaluate(() => {
            function collapseWhitespace(text){ return (text||'').replace(/\s+/g,' ').trim(); }
            function isVisible(el){ const s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||parseFloat(s.opacity||'1')===0) return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.left<innerWidth&&r.top<innerHeight; }
            function isHittable(el){ if(!isVisible(el)) return false; const s=getComputedStyle(el); if(s.pointerEvents==='none') return false; if(el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true') return false; const tag=el.tagName.toLowerCase(); if(tag==='a'&&el.getAttribute('href')) return true; if(tag==='button'||tag==='summary'||tag==='select'||tag==='textarea') return true; if(tag==='input'){ const t=(el.getAttribute('type')||'').toLowerCase(); if(t!=='hidden') return true; } const ti=el.getAttribute('tabindex'); const tiNum=ti!=null?parseInt(ti,10):NaN; if(!Number.isNaN(tiNum)&&tiNum>=0) return true; if((s.cursor||'').includes('pointer')) return true; if(typeof el.onclick==='function'||el.getAttribute('onclick')) return true; return false; }
            function computeRole(el){ const aria=(el.getAttribute('role')||'').trim(); if(aria) return aria.toLowerCase(); const tag=el.tagName.toLowerCase(); if(tag==='a') return (el.getAttribute('href')?'link':'generic'); if(tag==='button') return 'button'; if(tag==='input'){ const type=(el.getAttribute('type')||'').toLowerCase(); if(['button','submit','reset','image'].includes(type)) return 'button'; if(['checkbox'].includes(type)) return 'checkbox'; if(['radio'].includes(type)) return 'radio'; if(['range'].includes(type)) return 'slider'; return 'textbox'; } if(tag==='select') return 'combobox'; if(tag==='textarea') return 'textbox'; if(tag==='summary') return 'button'; return 'generic'; }
            function computeEnabled(el){ const style=getComputedStyle(el); const disabledAttr=el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true'; const peNone=style.pointerEvents==='none'; const opacityOk=parseFloat(style.opacity||'1')>=0.4; return !disabledAttr && !peNone && opacityOk; }
            function shortAnchor(el){ let cur=el, levels=0; while(cur&&levels<4){ if(cur.id) return `#${cur.id}`; const dt=cur.getAttribute&& (cur.getAttribute('data-testid')||cur.getAttribute('data-test')||cur.getAttribute('data-qa')); if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`; const al=cur.getAttribute&&cur.getAttribute('aria-label'); if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`; cur=cur.parentElement; levels++; } const parts=[]; cur=el; for(let i=0;i<3&&cur;i++){ const tag=(cur.tagName||'div').toLowerCase(); const parent=cur.parentElement; if(!parent){ parts.unshift(tag); break; } const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName); const idx=siblings.indexOf(cur)+1; parts.unshift(`${tag}:nth-of-type(${idx})`); cur=parent; } return parts.join('>'); }
            function bestSelector(el){ if(el.id) return `#${el.id}`; const dt=el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-qa'); if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`; const al=el.getAttribute('aria-label'); if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`; const parts=[]; let cur=el; for(let i=0;i<3&&cur;i++){ const tag=(cur.tagName||'div').toLowerCase(); const parent=cur.parentElement; if(!parent){ parts.unshift(tag); break; } const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName); const idx=siblings.indexOf(cur)+1; parts.unshift(`${tag}:nth-of-type(${idx})`); cur=parent; } let sel=parts.join('>'); if(sel.length>80) sel=sel.slice(0,80); return sel; }
            function hash36(str){ let h=5381; for(let i=0;i<str.length;i++){ h=((h<<5)+h)+str.charCodeAt(i); h|=0; } return (h>>>0).toString(36); }
            function isOccluded(el,r){ const cx=r.left+r.width/2, cy=r.top+r.height/2; const top= document.elementFromPoint(cx,cy); return top ? !el.contains(top) && top!==el : true; }
            const nodes=Array.from(document.querySelectorAll('*'));
            const items=[]; const idCounts=new Map();
            for(const el of nodes){ try{
              if(!isHittable(el)) continue; const r=el.getBoundingClientRect(); if(Math.max(r.width,r.height) < 8) continue;
              const name = collapseWhitespace((el.getAttribute('aria-label')||'') || el.innerText || el.textContent || (el.getAttribute('placeholder')||''));
              const role = computeRole(el); const enabled=computeEnabled(el);
              const cx = r.left + r.width/2, cy = r.top + r.height/2;
              let hit_state='hittable'; if(!enabled) hit_state='disabled'; else if(r.right<0||r.bottom<0||r.left>innerWidth||r.top>innerHeight) hit_state='offscreen_page'; else if(isOccluded(el,r)) hit_state='occluded';
              const selector = bestSelector(el); const href = el.tagName.toLowerCase()==='a' && el.href ? el.href : null; const anchor=shortAnchor(el);
              const idBase = `${role}|${name.toLowerCase()}|${anchor}|${selector}`; let id=hash36(idBase); const prev=idCounts.get(id)||0; if(prev>0) id=`${id}-${prev}`; idCounts.set(id, prev+1);
              const className = el.className?.toString?.()||'';
              items.push({ id, name, role, enabled, hit_state, center:[Math.round(cx),Math.round(cy)], rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)], selector, href, anchor, className });
            }catch{} }
            return items;
          });
        }

        // Aggregate across main document and visible iframes
        const all = [];
        const main = await collectRawFromFrame(page);
        if (Array.isArray(main)) all.push(...main);
        const frames = page.frames();
        for (const f of frames) {
          if (f === page.mainFrame()) continue;
          try {
            const fe = await f.frameElement(); if (!fe) continue;
            const box = await fe.boundingBox(); if (!box || box.width<=0 || box.height<=0) continue;
            const hits = await collectRawFromFrame(f);
            for (const h of hits) {
              const c = h.center || [0,0]; const r = h.rect || [0,0,0,0];
              all.push({ ...h, center: [ Math.round(box.x + c[0]), Math.round(box.y + c[1]) ], rect: [ Math.round(box.x + r[0]), Math.round(box.y + r[1]), r[2], r[3] ] });
            }
          } catch {}
        }

        // Hard dedupe per id across main + all iframes; prefer hittable, then larger area, then first-seen (main doc comes first)
        function rectArea(rc){ return Array.isArray(rc) ? Math.max(0, rc[2]) * Math.max(0, rc[3]) : 0; }
        const byId = new Map();
        for (const it of all) {
          if (!idsWanted.has(it.id)) continue;
          const prev = byId.get(it.id);
          if (!prev) { byId.set(it.id, it); continue; }
          const prevHS = String(prev.hit_state||'');
          const curHS = String(it.hit_state||'');
          const prevArea = rectArea(prev.rect);
          const curArea = rectArea(it.rect);
          const prevScore = (prevHS==='hittable'?2:(prevHS==='occluded'?1:0)) + (prev.enabled?0.1:0) + Math.min(1, prevArea/20000);
          const curScore = (curHS==='hittable'?2:(curHS==='occluded'?1:0)) + (it.enabled?0.1:0) + Math.min(1, curArea/20000);
          if (curScore > prevScore) byId.set(it.id, it);
        }
        const filtered = Array.from(byId.values()).map(({ anchor, className, ...rest }) => rest);
        try {
          const vp = page.viewportSize() || { width: 1280, height: 800 };
          const vArea = Math.max(1, (vp.width||1280) * (vp.height||800));
          filtered = filtered.filter(it => {
            const role = String(it.role||'').toLowerCase();
            if (role === 'generic') {
              const area = rectArea(it.rect);
              const nameLen = String(it.name||'').length;
              if (area > vArea * 0.6 || nameLen > 300) return false; // drop massive containers / giant text blobs
            }
            return true;
          });
        } catch {}
        ws.send(JSON.stringify({ ok: true, type: 'STEP3', elements: filtered }));
        return;
      }
      if (msg.type === 'GET_HITTABLES_VIEWPORT') {
        const maxItems = (msg.options && Number.isFinite(msg.options.max)) ? Math.max(10, Math.min(5000, msg.options.max)) : 1000;
        const minSize = (msg.options && Number.isFinite(msg.options.minSize)) ? Math.max(4, Math.min(100, msg.options.minSize)) : 8;
        // Reuse the same collection + dedupe logic as GET_HITTABLES_BY_IDS but without ids filter
        async function collectRawFromFrame(f) {
          return await f.evaluate(({ minSize, maxItems }) => {
            function collapseWhitespace(text){ return (text||'').replace(/\s+/g,' ').trim(); }
            function isVisible(el){ const s=getComputedStyle(el); if(s.visibility==='hidden'||s.display==='none'||parseFloat(s.opacity||'1')===0) return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.left<innerWidth&&r.top<innerHeight; }
            function isHittable(el){ if(!isVisible(el)) return false; const s=getComputedStyle(el); if(s.pointerEvents==='none') return false; if(el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true') return false; const tag=el.tagName.toLowerCase(); if(tag==='a'&&el.getAttribute('href')) return true; if(tag==='button'||tag==='summary'||tag==='select'||tag==='textarea') return true; if(tag==='input'){ const t=(el.getAttribute('type')||'').toLowerCase(); if(t!=='hidden') return true; } const ti=el.getAttribute('tabindex'); const tiNum=ti!=null?parseInt(ti,10):NaN; if(!Number.isNaN(tiNum)&&tiNum>=0) return true; if((s.cursor||'').includes('pointer')) return true; if(typeof el.onclick==='function'||el.getAttribute('onclick')) return true; return false; }
            function computeRole(el){ const aria=(el.getAttribute('role')||'').trim(); if(aria) return aria.toLowerCase(); const tag=el.tagName.toLowerCase(); if(tag==='a') return (el.getAttribute('href')?'link':'generic'); if(tag==='button') return 'button'; if(tag==='input'){ const type=(el.getAttribute('type')||'').toLowerCase(); if(['button','submit','reset','image'].includes(type)) return 'button'; if(['checkbox'].includes(type)) return 'checkbox'; if(['radio'].includes(type)) return 'radio'; if(['range'].includes(type)) return 'slider'; return 'textbox'; } if(tag==='select') return 'combobox'; if(tag==='textarea') return 'textbox'; if(tag==='summary') return 'button'; return 'generic'; }
            function computeEnabled(el){ const style=getComputedStyle(el); const disabledAttr=el.hasAttribute('disabled')||el.getAttribute('aria-disabled')==='true'; const peNone=style.pointerEvents==='none'; const opacityOk=parseFloat(style.opacity||'1')>=0.4; return !disabledAttr && !peNone && opacityOk; }
            function shortAnchor(el){ let cur=el, levels=0; while(cur&&levels<4){ if(cur.id) return `#${cur.id}`; const dt=cur.getAttribute&& (cur.getAttribute('data-testid')||cur.getAttribute('data-test')||cur.getAttribute('data-qa')); if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`; const al=cur.getAttribute&&cur.getAttribute('aria-label'); if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`; cur=cur.parentElement; levels++; } const parts=[]; cur=el; for(let i=0;i<3&&cur;i++){ const tag=(cur.tagName||'div').toLowerCase(); const parent=cur.parentElement; if(!parent){ parts.unshift(tag); break; } const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName); const idx=siblings.indexOf(cur)+1; parts.unshift(`${tag}:nth-of-type(${idx})`); cur=parent; } return parts.join('>'); }
            function bestSelector(el){ if(el.id) return `#${el.id}`; const dt=el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-qa'); if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`; const al=el.getAttribute('aria-label'); if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`; const parts=[]; let cur=el; for(let i=0;i<3&&cur;i++){ const tag=(cur.tagName||'div').toLowerCase(); const parent=cur.parentElement; if(!parent){ parts.unshift(tag); break; } const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName); const idx=siblings.indexOf(cur)+1; parts.unshift(`${tag}:nth-of-type(${idx})`); cur=parent; } let sel=parts.join('>'); if(sel.length>80) sel=sel.slice(0,80); return sel; }
            function hash36(str){ let h=5381; for(let i=0;i<str.length;i++){ h=((h<<5)+h)+str.charCodeAt(i); h|=0; } return (h>>>0).toString(36); }
            function isOccluded(el,r){ const cx=r.left+r.width/2, cy=r.top+r.height/2; const top= document.elementFromPoint(cx,cy); return top ? !el.contains(top) && top!==el : true; }
            const nodes=Array.from(document.querySelectorAll('*'));
            const items=[]; const idCounts=new Map();
            for(const el of nodes){ try{
              if(!isHittable(el)) continue; const r=el.getBoundingClientRect(); if(Math.max(r.width,r.height) < minSize) continue;
              const name = collapseWhitespace((el.getAttribute('aria-label')||'') || el.innerText || el.textContent || (el.getAttribute('placeholder')||''));
              const role = computeRole(el); const enabled=computeEnabled(el);
              const cx = r.left + r.width/2, cy = r.top + r.height/2;
              let hit_state='hittable'; if(!enabled) hit_state='disabled'; else if(r.right<0||r.bottom<0||r.left>innerWidth||r.top>innerHeight) hit_state='offscreen_page'; else if(isOccluded(el,r)) hit_state='occluded';
              const selector = bestSelector(el); const href = el.tagName.toLowerCase()==='a' && el.href ? el.href : null; const anchor=shortAnchor(el);
              const idBase = `${role}|${name.toLowerCase()}|${anchor}|${selector}`; let id=hash36(idBase); const prev=idCounts.get(id)||0; if(prev>0) id=`${id}-${prev}`; idCounts.set(id, prev+1);
              items.push({ id, name, role, enabled, hit_state, center:[Math.round(cx),Math.round(cy)], rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)], selector, href, anchor });
              if (items.length >= maxItems) break;
            }catch{} }
            return items;
          }, { minSize, maxItems });
        }
        // Aggregate main + frames, adjusting to viewport coords and dedupe identically to GET_HITTABLES_BY_IDS
        const all = [];
        try {
          const main = await collectRawFromFrame(page);
          if (Array.isArray(main)) all.push(...main);
          for (const f of page.frames()) {
            if (f === page.mainFrame()) continue;
            try {
              const fe = await f.frameElement(); if (!fe) continue;
              const box = await fe.boundingBox(); if (!box || box.width<=0 || box.height<=0) continue;
              const hits = await collectRawFromFrame(f);
              for (const h of hits) {
                const c = h.center || [0,0]; const r = h.rect || [0,0,0,0];
                all.push({ ...h, center: [ Math.round(box.x + c[0]), Math.round(box.y + c[1]) ], rect: [ Math.round(box.x + r[0]), Math.round(box.y + r[1]), r[2], r[3] ] });
              }
            } catch {}
          }
        } catch {}
        // EXACT Step 2 candidate dedupe (viewport-wide): drop huge generics, Gate B overlap, then center (allow small K) and selector|center passes
        function rectArea(rc){ return Array.isArray(rc) ? Math.max(0, rc[2]) * Math.max(0, rc[3]) : 0; }
        function overlapArea(a,b){ const ax2=a[0]+a[2], ay2=a[1]+a[3]; const bx2=b[0]+b[2], by2=b[1]+b[3]; const x1=Math.max(a[0],b[0]); const y1=Math.max(a[1],b[1]); const x2=Math.min(ax2,bx2); const y2=Math.min(ay2,by2); const w=Math.max(0,x2-x1); const h=Math.max(0,y2-y1); return w*h; }
        // Drop massive generic containers / text blobs that crowd lists
        const vp = page.viewportSize() || { width: 1280, height: 800 };
        const vArea = Math.max(1, (vp.width||1280) * (vp.height||800));
        const enabledList = all
          .filter(it => it.enabled && String(it.hit_state||'')==='hittable' && (it.name || it.selector))
          .filter(it => {
            const role = String(it.role||'').toLowerCase();
            if (role === 'generic') {
              const area = rectArea(it.rect||[0,0,0,0]);
              const nameLen = String(it.name||'').length;
              if (area > vArea * 0.6 || nameLen > 300) return false;
            }
            return true;
          });
        const isAction=(role)=> { const r=(role||'').toLowerCase(); return r==='button'||r==='link'||r==='combobox'; };
        const drop=new Set();
        for(let i=0;i<enabledList.length;i++){
          if(drop.has(i)) continue; const A=enabledList[i]; const aRect=A.rect; const aArea=rectArea(aRect);
          for(let j=0;j<enabledList.length;j++){
            if(i===j||drop.has(j)) continue; const B=enabledList[j]; const bRect=B.rect; const bArea=rectArea(bRect); if(bArea<=0){ drop.add(j); continue; }
            const inter=overlapArea(aRect,bRect); const frac=inter/bArea; if(frac>=0.85){
              const aAct=isAction(A.role), bAct=isAction(B.role);
              if(aAct && !bAct){ drop.add(j); continue; }
              if(!aAct && !bAct){
                // Prefer named, then smaller area for non-actionables
                const aNamed = !!String(A.name||'').trim();
                const bNamed = !!String(B.name||'').trim();
                if (aNamed !== bNamed) { if (aNamed) { drop.add(j); continue; } else { drop.add(i); break; } }
                if(aArea <= bArea){ drop.add(j); continue; }
                drop.add(i); break;
              }
            }
          }
        }
        const afterGateB = enabledList.filter((_,idx)=>!drop.has(idx));
        // Center-key dedupe: keep top K per center (K=3) sorted by: named desc, actionable desc, area asc
        const byCenter=new Map();
        for (const it of afterGateB) {
          const c = Array.isArray(it.center) ? it.center : [undefined, undefined];
          const key = `${c[0]}x${c[1]}`;
          const arr = byCenter.get(key) || [];
          arr.push(it);
          byCenter.set(key, arr);
        }
        const centerDeduped = [];
        for (const arr of byCenter.values()) {
          arr.sort((a,b)=>{
            const aNamed = !!String(a.name||'').trim();
            const bNamed = !!String(b.name||'').trim();
            if (aNamed !== bNamed) return Number(bNamed) - Number(aNamed);
            const aAct = isAction(a.role); const bAct = isAction(b.role);
            if (aAct !== bAct) return Number(bAct) - Number(aAct);
            const aArea = rectArea(a.rect||[0,0,0,0]); const bArea = rectArea(b.rect||[0,0,0,0]);
            return aArea - bArea; // smaller first to keep tidy labels
          });
          const K = 3;
          for (let i=0;i<Math.min(K, arr.length); i++) centerDeduped.push(arr[i]);
        }
        // Final pass: same selector|center, prefer named
        const byKey=new Map();
        for(const it of centerDeduped){
          const c = Array.isArray(it.center) ? it.center : [undefined, undefined];
          const key=`${it.selector||''}|${c[0]}x${c[1]}`;
          const prev=byKey.get(key);
          if(!prev){ byKey.set(key,it); continue; }
          const prevHas=!!(String(prev.name||'').trim()); const curHas=!!(String(it.name||'').trim());
          if(curHas && !prevHas){ byKey.set(key,it); continue; }
        }
        // Final stack ranking: always prefer filled names over empty, then hittable, then actionable, then larger area
        let filtered = Array.from(byKey.values());
        try {
          const hasName = (v) => !!String(v && v.name || '').trim();
          const hitOk = (v) => String(v && v.hit_state || '') === 'hittable';
          const actOk = (v) => isAction(v && v.role || '');
          filtered.sort((a,b) => {
            // 1) Hittable first
            const aH = hitOk(a) ? 1 : 0, bH = hitOk(b) ? 1 : 0;
            if (aH !== bH) return bH - aH;
            // 2) Non-empty name next
            const aN = hasName(a) ? 1 : 0, bN = hasName(b) ? 1 : 0;
            if (aN !== bN) return bN - aN;
            // 3) Actionable role
            const aA = actOk(a) ? 1 : 0, bA = actOk(b) ? 1 : 0;
            if (aA !== bA) return bA - aA;
            // 4) Larger area last
            const aArea = rectArea(a && a.rect || [0,0,0,0]);
            const bArea = rectArea(b && b.rect || [0,0,0,0]);
            return bArea - aArea;
          });
        } catch {}
        ws.send(JSON.stringify({ ok: true, type: 'STEP3', elements: filtered }));
        return;
      }
      if (msg.type === 'CLICK_PAGE') {
        const { x, y } = msg; // page coords
        const viewport = await page.viewportSize();
        const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
        const vx = Math.round(x - scroll.x);
        const vy = Math.round(y - scroll.y);
        // Revert to simple click without marker to avoid interference
        await page.mouse.move(vx, vy);
        await page.mouse.down();
        await page.mouse.up();
        ws.send(JSON.stringify({ ok: true }));
        return;
      }
      if (msg.type === 'CLICK_VIEWPORT') {
        const { vx, vy } = msg; // viewport CSS px
        console.log('[ws] CLICK_VIEWPORT received:', vx, vy);
        const viewport = await page.viewportSize();
        console.log('[ws] Current viewport:', viewport);
        await page.mouse.move(Math.round(vx), Math.round(vy));
        await page.mouse.down();
        await page.mouse.up();
        console.log('[ws] Clicked at:', Math.round(vx), Math.round(vy));
        ws.send(JSON.stringify({ ok: true }));
        return;
      }
      if (msg.type === 'SCROLL_DIR') {
        const directionIn = typeof msg.direction === 'string' ? msg.direction : 'down';
        // Reuse global scroll helper
        const dir = directionIn === 'up' ? -1 : 1;
        try {
          // simple main-only programmatic scroll for responsiveness
          await page.evaluate((sign)=>{
            const se = document.scrollingElement || document.documentElement || document.body;
            if (!se) return;
            const vh = window.innerHeight || 800;
            const delta = sign * Math.max(100, Math.round(vh * 0.75));
            se.scrollTop = Math.max(0, Math.min((se.scrollTop||0) + delta, Math.max(0,(se.scrollHeight||0)-(se.clientHeight||0))));
          }, dir);
          ws.send(JSON.stringify({ ok:true, type:'SCROLLED', direction: directionIn }));
        } catch (e) { ws.send(JSON.stringify({ ok:false, type:'SCROLL_DIR', error:String(e) })); }
        return;
      }
      if (msg.type === 'PRESS_ENTER') {
        try {
          await page.keyboard.press('Enter');
          ws.send(JSON.stringify({ ok: true }));
        } catch (e) {
          ws.send(JSON.stringify({ ok: false, error: String(e) }));
        }
        return;
      }
      // Draw a debug dot and radius ring at viewport coords
      if (msg.type === 'DRAW_RADIUS') {
        const { vx, vy, r = 120, color = '#ff0' } = msg || {};
        try {
          await page.evaluate((vx, vy, r, color) => {
            try {
              const id = '__wocr_radius_overlay__';
              let layer = document.getElementById(id);
              if (!layer) {
                layer = document.createElement('div');
                layer.id = id;
                layer.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
                document.documentElement.appendChild(layer);
              }
              // clear previous
              while (layer.firstChild) layer.removeChild(layer.firstChild);
              // dot
              const dot = document.createElement('div');
              dot.style.cssText = `position:absolute;left:${vx}px;top:${vy}px;transform:translate(-50%,-50%);width:8px;height:8px;border-radius:50%;background:${color};box-shadow:0 0 6px ${color}`;
              layer.appendChild(dot);
              // ring
              const ring = document.createElement('div');
              ring.style.cssText = `position:absolute;left:${vx}px;top:${vy}px;transform:translate(-50%,-50%);width:${2*r}px;height:${2*r}px;border:2px dashed ${color};border-radius:50%;box-shadow:0 0 6px ${color}80`;
              layer.appendChild(ring);
            } catch {}
          }, Math.round(Number(vx)||0), Math.round(Number(vy)||0), Math.round(Number(r)||0), String(color||'#ff0'));
          ws.send(JSON.stringify({ ok: true, type: 'DRAWN_RADIUS' }));
        } catch (e) {
          ws.send(JSON.stringify({ ok: false, type: 'DRAWN_RADIUS', error: String(e) }));
        }
        return;
      }
      if (msg.type === 'CLEAR_RADIUS') {
        try {
          await page.evaluate(() => { try { const el = document.getElementById('__wocr_radius_overlay__'); if (el) el.remove(); } catch {} });
          ws.send(JSON.stringify({ ok: true }));
        } catch (e) {
          ws.send(JSON.stringify({ ok: false, error: String(e) }));
        }
        return;
      }
      // Install click verification listeners in main doc and visible iframes
      if (msg.type === 'INJECT_CLICK_VERIFIER') {
        const installInFrame = async (f) => {
          return await f.evaluate(() => {
            try {
              if (window.__wocr_cv_installed) return true;
              function collapseWhitespace(text){ return (text||'').replace(/\s+/g,' ').trim(); }
              function computeRole(el){
                const aria=(el.getAttribute('role')||'').trim(); if(aria) return aria.toLowerCase();
                const tag=(el.tagName||'').toLowerCase();
                if(tag==='a') return (el.getAttribute('href')?'link':'generic');
                if(tag==='button') return 'button';
                if(tag==='input'){
                  const type=(el.getAttribute('type')||'').toLowerCase();
                  if(['button','submit','reset','image'].includes(type)) return 'button';
                  if(['checkbox'].includes(type)) return 'checkbox';
                  if(['radio'].includes(type)) return 'radio';
                  if(['range'].includes(type)) return 'slider';
                  return 'textbox';
                }
                if(tag==='select') return 'combobox';
                if(tag==='textarea') return 'textbox';
                if(tag==='summary') return 'button';
                return 'generic';
              }
              function shortAnchor(el){
                let cur=el, levels=0;
                while(cur&&levels<4){
                  if(cur.id) return `#${cur.id}`;
                  const dt=cur.getAttribute&& (cur.getAttribute('data-testid')||cur.getAttribute('data-test')||cur.getAttribute('data-qa'));
                  if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`;
                  const al=cur.getAttribute&&cur.getAttribute('aria-label');
                  if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`;
                  cur=cur.parentElement; levels++;
                }
                const parts=[]; cur=el;
                for(let i=0;i<3&&cur;i++){
                  const tag=(cur.tagName||'div').toLowerCase();
                  const parent=cur.parentElement;
                  if(!parent){ parts.unshift(tag); break; }
                  const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName);
                  const idx=siblings.indexOf(cur)+1;
                  parts.unshift(`${tag}:nth-of-type(${idx})`);
                  cur=parent;
                }
                return parts.join('>');
              }
              function bestSelector(el){
                if(el.id) return `#${el.id}`;
                const dt=el.getAttribute('data-testid')||el.getAttribute('data-test')||el.getAttribute('data-qa');
                if(dt) return `[data-testid='${String(dt).replace(/'/g,"\\'")}']`;
                const al=el.getAttribute('aria-label');
                if(al) return `[aria-label='${String(al).replace(/'/g,"\\'")}']`;
                const parts=[]; let cur=el;
                for(let i=0;i<3&&cur;i++){
                  const tag=(cur.tagName||'div').toLowerCase();
                  const parent=cur.parentElement;
                  if(!parent){ parts.unshift(tag); break; }
                  const siblings=Array.from(parent.children).filter(c=>c.tagName===cur.tagName);
                  const idx=siblings.indexOf(cur)+1;
                  parts.unshift(`${tag}:nth-of-type(${idx})`);
                  cur=parent;
                }
                let sel=parts.join('>'); if(sel.length>80) sel=sel.slice(0,80); return sel;
              }
              function hash36(str){ let h=5381; for(let i=0;i<str.length;i++){ h=((h<<5)+h)+str.charCodeAt(i); h|=0; } return (h>>>0).toString(36); }
              function describe(el){
                const r=el.getBoundingClientRect();
                const name = collapseWhitespace((el.getAttribute('aria-label')||'') || el.innerText || el.textContent || '');
                const role = computeRole(el);
                const selector = bestSelector(el);
                const anchor = shortAnchor(el);
                const idBase = `${role}|${name.toLowerCase()}|${anchor}|${selector}`;
                const idHash = hash36(idBase);
                return { tag: (el.tagName||'').toLowerCase(), role, name, selector, anchor, id: idHash, rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)] };
              }
              window.__wocr_cv_installed = true;
              window.__wocr_lastClickChain = null;
              const handler = (e) => {
                try {
                  const chain=[];
                  const path = (typeof e.composedPath === 'function') ? e.composedPath() : null;
                  if (Array.isArray(path) && path.length) {
                    for (const n of path) {
                      if (n && n.nodeType===Node.ELEMENT_NODE) chain.push(describe(n));
                      if (chain.length>=20) break;
                    }
                  } else {
                    let cur = e.target; let steps=0;
                    while(cur && cur.nodeType===Node.ELEMENT_NODE && steps<20){ chain.push(describe(cur)); cur=cur.parentElement; steps++; }
                  }
              window.__wocr_lastClickChain = { ts: Date.now(), chain };
                  // Persist to window.name only on allowlisted domains (e.g., amazon.*)
                  try {
                    const host = String(location.hostname||'').toLowerCase();
                    const allow = /(^|\.)amazon\./.test(host);
                    if (allow) {
                      const prev = String(window.name || '');
                      const payload = { ts: Date.now(), frameUrl: location.href, chain, prev };
                      window.name = 'WOCR:' + btoa(JSON.stringify(payload));
                    }
                  } catch {}
                } catch {}
              };
              window.addEventListener('pointerdown', handler, true);
              window.addEventListener('pointerup', handler, true);
              window.addEventListener('mousedown', handler, true);
              window.addEventListener('mouseup', handler, true);
              window.addEventListener('click', handler, true);
              return true;
            } catch { return false; }
          });
        };
        try {
          await installInFrame(page.mainFrame());
          const frames = page.frames();
          for (const f of frames) {
            if (f === page.mainFrame()) continue;
            try {
              const fe = await f.frameElement(); if (!fe) continue;
              const box = await fe.boundingBox(); if (!box || box.width <= 0 || box.height <= 0) continue;
              await installInFrame(f);
            } catch {}
          }
          ws.send(JSON.stringify({ ok: true, type: 'CLICK_VERIFIER_READY' }));
        } catch (e) {
          ws.send(JSON.stringify({ ok: false, type: 'CLICK_VERIFIER_READY', error: String(e) }));
        }
        return;
      }
      if (msg.type === 'GET_LAST_CLICK_CHAIN') {
        const getChain = async (f) => {
          try { return await f.evaluate(() => window.__wocr_lastClickChain || null); } catch { return null; }
        };
        let best = { ts: 0, chain: null, frameUrl: null };
        // Prefer recent backend-cached entries first
        try {
          const cutoff = Date.now() - 5000;
          const fresh = recentChains.filter(e => e && e.ts >= cutoff);
          if (fresh.length) {
            const latest = fresh[fresh.length - 1];
            if (latest && latest.ts > (best.ts||0)) best = { ts: latest.ts, chain: latest.chain, frameUrl: latest.frameUrl };
          }
        } catch {}
        try { const main = await getChain(page.mainFrame()); if (main && main.ts>best.ts) { best = { ts: main.ts, chain: main.chain, frameUrl: await page.url() }; } } catch {}
        try {
          const frames = page.frames();
          for (const f of frames) {
            if (f === page.mainFrame()) continue;
            try {
              const fe = await f.frameElement(); if (!fe) continue;
              const box = await fe.boundingBox(); if (!box || box.width <= 0 || box.height <= 0) continue;
              const c = await getChain(f); if (c && c.ts>best.ts) best = { ts: c.ts, chain: c.chain, frameUrl: f.url() };
            } catch {}
          }
        } catch {}
        // Fallback: read window.name persisted payload in main and visible iframes (survives navigation), then restore previous window.name
        const decodeFrom = async (frame) => {
          try {
            return await frame.evaluate(() => {
              try {
                const nm = String(window.name || '');
                if (nm.startsWith('WOCR:')) {
                  const obj = JSON.parse(atob(nm.slice(5)));
                  // Restore previous name to avoid leaking state
                  try { window.name = obj && obj.prev ? String(obj.prev) : ''; } catch {}
                  if (obj && Array.isArray(obj.chain)) {
                    return { ts: Number(obj.ts)||Date.now(), chain: obj.chain, frameUrl: String(obj.frameUrl||location.href), persisted: true };
                  }
                }
              } catch {}
              return null;
            });
          } catch { return null; }
        };
        try {
          const pMain = await decodeFrom(page.mainFrame());
          if (pMain && (!best.chain || pMain.ts > (best.ts||0))) best = { ts: pMain.ts, chain: pMain.chain, frameUrl: pMain.frameUrl };
          const frames = page.frames();
          for (const f of frames) {
            if (f === page.mainFrame()) continue;
            const fe = await f.frameElement().catch(()=>null); if (!fe) continue;
            const box = await fe.boundingBox().catch(()=>null); if (!box || box.width<=0 || box.height<=0) continue;
            const p = await decodeFrom(f);
            if (p && (!best.chain || p.ts > (best.ts||0))) best = { ts: p.ts, chain: p.chain, frameUrl: p.frameUrl };
          }
        } catch {}
        ws.send(JSON.stringify({ ok: !!best.chain, type: 'CLICK_CHAIN', ts: best.ts||0, frameUrl: best.frameUrl||null, chain: best.chain||[] }));
        return;
      }
      if (msg.type === 'TYPE_TEXT') {
        const { text = '', delay, token } = msg;
        // Slightly slower, human-like delay by default (80–140ms), unless caller specifies
        const baseDelay = (Number.isFinite(delay) ? Number(delay) : (80 + Math.floor(Math.random() * 61)));
        const delayMs = Math.max(20, Math.min(300, baseDelay));
        await page.keyboard.type(String(text), { delay: delayMs });
        ws.send(JSON.stringify({ ok: true, type: 'TYPED', token: (typeof token === 'string' ? token : null), typed: true, delay: delayMs, length: String(text).length }));
        return;
      }
      if (msg.type === 'CLEAR_ACTIVE_INPUT') {
        const token = (typeof msg.token === 'string' ? msg.token : null);
        async function clearInFrame(f){
          try {
            return await f.evaluate(() => {
              try {
                const el = document.activeElement;
                if (!el) return false;
                const anyEl = el;
                let changed = false;
                if ('value' in anyEl) {
                  const before = anyEl.value;
                  anyEl.value = '';
                  try { anyEl.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
                  try { anyEl.dispatchEvent(new Event('change', { bubbles: true })); } catch {}
                  changed = (before !== '' || true);
                } else if (anyEl && anyEl.isContentEditable) {
                  anyEl.textContent = '';
                  changed = true;
                }
                return !!changed;
              } catch { return false; }
            });
          } catch { return false; }
        }
        let okCleared = false;
        try {
          okCleared = await clearInFrame(page);
          if (!okCleared) {
            for (const f of page.frames()) {
              if (okCleared) break;
              if (f === page.mainFrame()) continue;
              try {
                const fe = await f.frameElement(); if (!fe) continue;
                const box = await fe.boundingBox(); if (!box || box.width<=0 || box.height<=0) continue;
                const ok = await clearInFrame(f);
                if (ok) { okCleared = true; break; }
              } catch {}
            }
          }
        } catch {}
        // Fallback: Select-All + Backspace
        if (!okCleared) {
          try { await page.keyboard.down('Meta'); await page.keyboard.press('KeyA'); await page.keyboard.up('Meta'); await page.keyboard.press('Backspace'); okCleared = true; } catch {}
          if (!okCleared) { try { await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); okCleared = true; } catch {} }
        }
        ws.send(JSON.stringify({ ok: !!okCleared, type: 'CLEARED', token }));
        return;
      }
      if (msg.type === 'WAIT_FOR_LOAD') {
        async function stabilize(totalTimeoutMs = 6000) {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const deadline = Date.now() + Math.max(1000, totalTimeoutMs);
          try { await page.waitForLoadState('domcontentloaded', { timeout: 3000 }); } catch {}
          try { await page.waitForLoadState('load', { timeout: 3000 }); } catch {}
          try { await page.waitForLoadState('networkidle', { timeout: 3000 }); } catch {}
          // Visible iframes
          const frames = page.frames();
          for (const f of frames) {
            if (f === page.mainFrame()) continue;
            const remaining = Math.max(0, deadline - Date.now()); if (!remaining) break;
            try {
              const fe = await f.frameElement(); if (!fe) continue;
              const box = await fe.boundingBox(); if (!box || box.width<=0 || box.height<=0) continue;
              try { await f.waitForLoadState('domcontentloaded', { timeout: Math.min(1500, remaining) }); } catch {}
              try { await f.waitForLoadState('load', { timeout: Math.min(1500, Math.max(0, deadline - Date.now())) }); } catch {}
              try { await f.waitForLoadState('networkidle', { timeout: Math.min(1500, Math.max(0, deadline - Date.now())) }); } catch {}
            } catch {}
          }
          await sleep(120);
        }
        await stabilize(6000);
        ws.send(JSON.stringify({ ok: true, type: 'LOADED' }));
        return;
      }
      // (scroll helper/simple routes removed)
      // Sandbox-only: scroll MAIN document by fixed 80% programmatically
      if (msg.type === 'SCROLL_MAIN_ONLY') {
        const ratioIn = 0.8;
        const directionIn = typeof msg.direction === 'string' ? msg.direction : (typeof msg.dir === 'string' ? msg.dir : 'down');
        const dir = (directionIn === 'up') ? -1 : 1;
        // Skip event-driven main wheel by default; prefer programmatic writes for determinism
        let skipMainWheel = true;
        try {
          // Focus most recent non-blank page
          const pages = browser.pages();
          let pick = pages[pages.length - 1];
          for (let i = pages.length - 1; i >= 0; i--) {
            try { const u = await pages[i].url(); if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; } } catch {}
          }
          if (pick) page = pick;
          try { await page.bringToFront(); } catch {}
        } catch {}
        let beforeY = 0, afterY = 0;
        try { beforeY = await page.evaluate(() => (typeof window.scrollY === 'number' ? window.scrollY : (document.scrollingElement ? document.scrollingElement.scrollTop : 0)) ); } catch {}
        try {
          await page.evaluate((ratio, sign) => {
            const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
            const se = document.scrollingElement || document.documentElement || document.body;
            if (!se) return;
            const vh = window.innerHeight || 800;
            const delta = sign * Math.max(100, Math.round(vh * Math.abs(ratio)));
            const maxTop = Math.max(0, (se.scrollHeight || 0) - (se.clientHeight || 0));
            const cur = se.scrollTop || 0;
            const next = clamp(cur + delta, 0, maxTop);
            if (next !== cur) se.scrollTop = next;
          }, ratioIn, dir);
          try { await page.waitForTimeout(60); } catch {}
          afterY = await page.evaluate(() => (typeof window.scrollY === 'number' ? window.scrollY : (document.scrollingElement ? document.scrollingElement.scrollTop : 0)) );
        } catch {}
        const delta = (afterY || 0) - (beforeY || 0);
        const ok = dir > 0 ? (delta > 30) : (delta < -30);
        ws.send(JSON.stringify({ ok: true, type: 'SCROLLED', target: 'main', direction: directionIn, verified: { ok, reason: ok ? 'main_delta' : 'no_movement', delta } }));
        return;
      }
      // Sandbox-only: scroll visible sidebars/scrollable containers via mouse wheel at container centers
      if (msg.type === 'SCROLL_SIDEBARS_ONLY') {
        const ratioIn = 0.8;
        const directionIn = typeof msg.direction === 'string' ? msg.direction : (typeof msg.dir === 'string' ? msg.dir : 'down');
        const dir = (directionIn === 'up') ? -1 : 1;
        try {
          const pages = browser.pages();
          let pick = pages[pages.length - 1];
          for (let i = pages.length - 1; i >= 0; i--) {
            try { const u = await pages[i].url(); if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; } } catch {}
          }
          if (pick) page = pick;
          try { await page.bringToFront(); } catch {}
        } catch {}
        // Discover likely sidebar containers and compute safe wheel coordinates
        let targets = [];
        try {
          targets = await page.evaluate((ratio) => {
            const vw = window.innerWidth || 1280;
            const vh = window.innerHeight || 800;
            const isScrollable = (el) => {
              try { const s = getComputedStyle(el); const oy = s.overflowY; return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight; } catch { return false; }
            };
            const likelySidebar = (el, r) => {
              try {
                const cls = (el.className && el.className.toString ? el.className.toString().toLowerCase() : '');
                const role = (el.getAttribute && (el.getAttribute('role') || '')).toLowerCase();
                const id = (el.id || '').toLowerCase();
                const leftOrRight = (r.left <= 60) || (r.right >= vw - 60);
                const narrow = (r.width <= vw * 0.42);
                const tall = (r.height >= vh * 0.5);
                const keywords = /(side|sidebar|nav|menu|pane|panel)/;
                const hasKw = keywords.test(cls) || keywords.test(id) || role === 'navigation' || el.tagName.toLowerCase() === 'aside';
                return (leftOrRight && narrow && tall) || hasKw;
              } catch { return false; }
            };
            const out = [];
            const nodes = Array.from(document.querySelectorAll('*'));
            for (const el of nodes) {
              try {
                if (!isScrollable(el)) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 100 || r.height < 120) continue;
                if (r.bottom < 20 || r.top > vh - 20) continue;
                const score = (likelySidebar(el, r) ? 2 : 0) + (r.left <= 60 ? 1 : 0) + (r.right >= vw - 60 ? 1 : 0);
                // pick a safe point inside the element
                const cx = Math.floor(r.left + Math.max(10, Math.min(r.width - 10, r.width * 0.5)));
                const cy = Math.floor(r.top + Math.max(10, Math.min(r.height - 10, r.height * 0.6)));
                // verify it hits inside same element
                const at = document.elementFromPoint(cx, cy);
                let inside = false; let cur = at; let steps = 0;
                while (cur && steps < 8) { if (cur === el) { inside = true; break; } cur = cur.parentElement; steps++; }
                if (!inside) continue;
                const maxTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
                const curTop = el.scrollTop || 0;
                out.push({
                  cx, cy,
                  width: Math.floor(r.width), height: Math.floor(r.height),
                  remainingDown: Math.max(0, maxTop - curTop),
                  remainingUp: Math.max(0, curTop),
                  label: (el.id || el.className || el.tagName).toString().slice(0, 120),
                  score
                });
                if (out.length >= 4) break;
              } catch {}
            }
            out.sort((a,b)=> b.score - a.score || b.height - a.height);
            return out.slice(0, 3);
          }, ratioIn);
        } catch {}
        // Perform wheel on each target
        let moved = 0;
        for (const t of Array.isArray(targets) ? targets : []) {
          try {
            await page.mouse.move(Math.max(1, t.cx), Math.max(1, t.cy));
            const approx = Math.max(250, Math.round((t.height || 600) * Math.abs(ratioIn)));
            const room = dir > 0 ? (t.remainingDown || approx) : (t.remainingUp || approx);
            const delta = dir * Math.max(200, Math.min(approx, room + 80));
            await page.mouse.wheel(0, delta);
            try { await page.waitForTimeout(80); } catch {}
            moved++;
          } catch {}
        }
        ws.send(JSON.stringify({ ok: true, type: 'SCROLLED', target: 'sidebar', direction: directionIn, movedCount: moved }));
        return;
      }
      // Sandbox-only: GLOBAL scroll — move main + all visible containers + visible iframes by 80%
      if (msg.type === 'SCROLL_GLOBAL') {
        const ratioIn = 0.8;
        const directionIn = typeof msg.direction === 'string' ? msg.direction : (typeof msg.dir === 'string' ? msg.dir : 'down');
        const dir = (directionIn === 'up') ? -1 : 1;
        try {
          const pages = browser.pages();
          let pick = pages[pages.length - 1];
          for (let i = pages.length - 1; i >= 0; i--) {
            try { const u = await pages[i].url(); if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; } } catch {}
          }
          if (pick) page = pick;
          try { await page.bringToFront(); } catch {}
        } catch {}
        // Main before
        let beforeY = 0, afterY = 0;
        try { beforeY = await page.evaluate(() => (typeof window.scrollY === 'number' ? window.scrollY : (document.scrollingElement ? document.scrollingElement.scrollTop : 0)) ); } catch {}
        // Scroll main + containers programmatically in one eval; collect center+sidebars for wheel pass
        let mainRes = { changed: [], sidebars: [], center: null };
        try {
          mainRes = await page.evaluate((ratio, sign) => {
            const vh = window.innerHeight || 800;
            const deltaMain = sign * Math.max(100, Math.round(vh * Math.abs(ratio)));
            const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
            const label = (el) => { try { const t=(el.tagName||'').toLowerCase(); const id=el.id?`#${el.id}`:''; const cls=el.className&&el.className.toString?'.'+el.className.toString().trim().split(/\s+/).slice(0,3).join('.') : ''; return `${t}${id}${cls}`.slice(0,160);} catch { return ''; } };
            const isScrollable = (el) => { try { const s=getComputedStyle(el); const oy=s.overflowY; return (oy==='auto'||oy==='scroll') && el.scrollHeight>el.clientHeight; } catch { return false; } };
            const likelySidebar = (el, r) => {
              try {
                const vw = window.innerWidth || 1280;
                const vh2 = window.innerHeight || 800;
                const cls = (el.className && el.className.toString ? el.className.toString().toLowerCase() : '');
                const role = (el.getAttribute && (el.getAttribute('role') || '')).toLowerCase();
                const id = (el.id || '').toLowerCase();
                const leftOrRight = (r.left <= 60) || (r.right >= vw - 60);
                const narrow = (r.width <= vw * 0.42);
                const tall = (r.height >= vh2 * 0.5);
                const keywords = /(side|sidebar|nav|menu|pane|panel)/;
                const hasKw = keywords.test(cls) || keywords.test(id) || role === 'navigation' || el.tagName.toLowerCase() === 'aside';
                return (leftOrRight && narrow && tall) || hasKw;
              } catch { return false; }
            };
            // Determine center wheel target first and mark it to avoid double-scrolling
            const wheels = [];
            const wheelSet = new Set();
            try {
              const vw = window.innerWidth || 1280;
              const vhc = window.innerHeight || 800;
              const cx = Math.floor(vw * 0.5);
              const cy = Math.floor(vhc * 0.55);
              const clampPoint = (v, min, max) => Math.max(min, Math.min(max, v));
              let el = document.elementFromPoint(cx, cy);
              let climb = 0;
              while (el && climb < 8 && !isScrollable(el)) { el = el.parentElement; climb++; }
              if (el) {
                const r = el.getBoundingClientRect();
                const tx = Math.floor(clampPoint(r.left + r.width * 0.5, r.left + 8, r.right - 8));
                const ty = Math.floor(clampPoint(r.top + Math.min(r.height - 10, Math.max(10, r.height * 0.6)), r.top + 8, r.bottom - 8));
                const maxTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
                const curTop = el.scrollTop || 0;
                wheels.push({ x: tx, y: ty, height: Math.floor(r.height), remainingDown: Math.max(0, maxTop - curTop), remainingUp: Math.max(0, curTop), label: label(el) });
                try { wheelSet.add(el); } catch {}
              }
            } catch {}
            // Root
            const se = document.scrollingElement || document.documentElement || document.body;
            if (se) {
              const maxTop = Math.max(0, (se.scrollHeight||0) - (se.clientHeight||0));
              const cur = se.scrollTop || 0;
              const next = clamp(cur + deltaMain, 0, maxTop);
              if (next !== cur) se.scrollTop = next;
            }
            // Containers
            const nodes = Array.from(document.querySelectorAll('*'));
            const changed = [];
            const sidebars = [];
            for (const el of nodes) {
              try {
                if (!isScrollable(el)) continue;
                const r = el.getBoundingClientRect();
                if (r.height <= 80) continue;
                if (r.bottom < 20 || r.top > (window.innerHeight||800) - 20) continue;
                if (likelySidebar(el, r)) {
                  // Do not programmatically scroll sidebars; emit safe wheel target for later
                  const clampPoint = (v, min, max) => Math.max(min, Math.min(max, v));
                  const tx = Math.floor(clampPoint(r.left + r.width * 0.5, r.left + 8, r.right - 8));
                  const ty = Math.floor(clampPoint(r.top + Math.min(r.height - 10, Math.max(10, r.height * 0.6)), r.top + 8, r.bottom - 8));
                  const maxTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
                  const curTop = el.scrollTop || 0;
                  const target = { x: tx, y: ty, height: Math.floor(r.height), remainingDown: Math.max(0, maxTop - curTop), remainingUp: Math.max(0, curTop), label: label(el) };
                  sidebars.push(target);
                  wheels.push(target);
                  try { wheelSet.add(el); } catch {}
                } else {
                  // Skip programmatic write if this element is the center wheel target
                  let skip = false;
                  try { skip = wheelSet.has(el); } catch {}
                  if (!skip) {
                    const d = sign * Math.max(80, Math.round((el.clientHeight || (window.innerHeight||800)) * Math.abs(ratio)));
                    const maxTop = Math.max(0, (el.scrollHeight||0) - (el.clientHeight||0));
                    const before = el.scrollTop || 0;
                    const next = clamp(before + d, 0, maxTop);
                    if (next !== before) { el.scrollTop = next; changed.push({ label: label(el), before, after: next, delta: next - before }); }
                  }
                }
              } catch {}
            }
            const center = wheels.length ? wheels[0] : null;
            return { changed, sidebars, center };
          }, ratioIn, dir);
        } catch {}
        // Wheel the center (main content) once, then each detected sidebar once (no overlap with programmatic writes)
        try {
          if (mainRes.center && Number.isFinite(mainRes.center.x) && Number.isFinite(mainRes.center.y)) {
            const c = mainRes.center;
            try { await page.mouse.move(Math.max(1, c.x), Math.max(1, c.y)); } catch {}
            const approx = Math.max(250, Math.round((c.height || 600) * Math.abs(ratioIn)));
            const room = dir > 0 ? (c.remainingDown || approx) : (c.remainingUp || approx);
            const delta = dir * Math.max(200, Math.min(approx, room + 80));
            try { await page.mouse.wheel(0, delta); } catch {}
            try { await page.waitForTimeout(60); } catch {}
          }
          for (const sb of Array.isArray(mainRes.sidebars) ? mainRes.sidebars : []) {
            try {
              await page.mouse.move(Math.max(1, sb.x), Math.max(1, sb.y));
              const approx = Math.max(250, Math.round((sb.height || 600) * Math.abs(ratioIn)));
              const room = dir > 0 ? (sb.remainingDown || approx) : (sb.remainingUp || approx);
              const delta = dir * Math.max(200, Math.min(approx, room + 80));
              await page.mouse.wheel(0, delta);
              try { await page.waitForTimeout(60); } catch {}
            } catch {}
          }
        } catch {}
        // Iframes: programmatic scroll non-sidebars, collect sidebars for wheel with absolute coords
        const frameResults = [];
        const frameSidebars = [];
        try {
          for (const f of page.frames()) {
            if (f === page.mainFrame()) continue;
            try {
              const fe = await f.frameElement(); if (!fe) continue;
              const box = await fe.boundingBox(); if (!box || box.width<=0 || box.height<=0) continue;
              const res = await f.evaluate((ratio, sign) => {
                const vh = window.innerHeight || 800;
                const deltaMain = sign * Math.max(100, Math.round(vh * Math.abs(ratio)));
                const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
                const label = (el) => { try { const t=(el.tagName||'').toLowerCase(); const id=el.id?`#${el.id}`:''; const cls=el.className&&el.className.toString?'.'+el.className.toString().trim().split(/\s+/).slice(0,3).join('.') : ''; return `${t}${id}${cls}`.slice(0,160);} catch { return ''; } };
                const isScrollable = (el) => { try { const s=getComputedStyle(el); const oy=s.overflowY; return (oy==='auto'||oy==='scroll') && el.scrollHeight>el.clientHeight; } catch { return false; } };
                const likelySidebar = (el, r) => {
                  try {
                    const vw = window.innerWidth || 1280;
                    const vh2 = window.innerHeight || 800;
                    const cls = (el.className && el.className.toString ? el.className.toString().toLowerCase() : '');
                    const role = (el.getAttribute && (el.getAttribute('role') || '')).toLowerCase();
                    const id = (el.id || '').toLowerCase();
                    const leftOrRight = (r.left <= 40) || (r.right >= vw - 40);
                    const narrow = (r.width <= vw * 0.5);
                    const tall = (r.height >= vh2 * 0.5);
                    const keywords = /(side|sidebar|nav|menu|pane|panel)/;
                    const hasKw = keywords.test(cls) || keywords.test(id) || role === 'navigation' || el.tagName.toLowerCase() === 'aside';
                    return (leftOrRight && narrow && tall) || hasKw;
                  } catch { return false; }
                };
                const changed = [];
                const sidebars = [];
                let center = null;
                try {
                  const vw = window.innerWidth || 1280;
                  const vhc = window.innerHeight || 800;
                  const cx = Math.floor(vw * 0.5);
                  const cy = Math.floor(vhc * 0.55);
                  const clampPoint = (v, min, max) => Math.max(min, Math.min(max, v));
                  let el = document.elementFromPoint(cx, cy);
                  let climb = 0;
                  while (el && climb < 8 && !isScrollable(el)) { el = el.parentElement; climb++; }
                  if (el) {
                    const r = el.getBoundingClientRect();
                    const tx = Math.floor(clampPoint(r.left + r.width * 0.5, r.left + 8, r.right - 8));
                    const ty = Math.floor(clampPoint(r.top + Math.min(r.height - 10, Math.max(10, r.height * 0.6)), r.top + 8, r.bottom - 8));
                    const maxTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
                    const curTop = el.scrollTop || 0;
                    center = { x: tx, y: ty, height: Math.floor(r.height), remainingDown: Math.max(0, maxTop - curTop), remainingUp: Math.max(0, curTop), label: label(el) };
                  }
                } catch {}
                const se = document.scrollingElement || document.documentElement || document.body;
                if (se) {
                  const maxTop = Math.max(0, (se.scrollHeight||0) - (se.clientHeight||0));
                  const cur = se.scrollTop || 0;
                  const next = clamp(cur + deltaMain, 0, maxTop);
                  if (next !== cur) { se.scrollTop = next; changed.push({ label: 'frame:root', before: cur, after: next, delta: next - cur }); }
                }
                const nodes = Array.from(document.querySelectorAll('*'));
                for (const el of nodes) {
                  try {
                    if (!isScrollable(el)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.height <= 80) continue;
                    if (r.bottom < 20 || r.top > (window.innerHeight||800) - 20) continue;
                    if (likelySidebar(el, r)) {
                      const clampPoint = (v, min, max) => Math.max(min, Math.min(max, v));
                      const tx = Math.floor(clampPoint(r.left + r.width * 0.5, r.left + 8, r.right - 8));
                      const ty = Math.floor(clampPoint(r.top + Math.min(r.height - 10, Math.max(10, r.height * 0.6)), r.top + 8, r.bottom - 8));
                      const maxTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
                      const curTop = el.scrollTop || 0;
                      sidebars.push({ x: tx, y: ty, height: Math.floor(r.height), remainingDown: Math.max(0, maxTop - curTop), remainingUp: Math.max(0, curTop), label: label(el) });
                    } else {
                      const d = sign * Math.max(80, Math.round((el.clientHeight || (window.innerHeight||800)) * Math.abs(ratio)));
                      const maxTop = Math.max(0, (el.scrollHeight||0) - (el.clientHeight||0));
                      const before = el.scrollTop || 0;
                      const next = clamp(before + d, 0, maxTop);
                      if (next !== before) { el.scrollTop = next; changed.push({ label: label(el), before, after: next, delta: next - before }); }
                    }
                  } catch {}
                }
                return { changed, sidebars, center };
              }, ratioIn, dir);
              frameResults.push({ frameUrl: f.url(), frameBox: { x: box.x, y: box.y, width: box.width, height: box.height }, containers: (res && res.changed) || [] });
              // Collect sidebars with absolute coordinates for wheeling after programmatic writes
              const sbs = (res && res.sidebars) || [];
              for (const sb of sbs) {
                frameSidebars.push({ x: Math.floor(box.x + sb.x), y: Math.floor(box.y + sb.y), height: sb.height, remainingDown: sb.remainingDown, remainingUp: sb.remainingUp, frameUrl: f.url(), label: sb.label });
              }
              if (res && res.center) {
                const c = res.center; frameSidebars.unshift({ x: Math.floor(box.x + c.x), y: Math.floor(box.y + c.y), height: c.height, remainingDown: c.remainingDown, remainingUp: c.remainingUp, frameUrl: f.url(), label: 'frame:center' });
              }
            } catch {}
          }
        } catch {}
        // Wheel center of each frame first (if present), then sidebars once
        try {
          for (const sb of frameSidebars) {
            try {
              await page.mouse.move(Math.max(1, sb.x), Math.max(1, sb.y));
              const approx = Math.max(250, Math.round((sb.height || 600) * Math.abs(ratioIn)));
              const room = dir > 0 ? (sb.remainingDown || approx) : (sb.remainingUp || approx);
              const delta = dir * Math.max(200, Math.min(approx, room + 80));
              await page.mouse.wheel(0, delta);
              try { await page.waitForTimeout(60); } catch {}
            } catch {}
          }
        } catch {}
        try { afterY = await page.evaluate(() => (typeof window.scrollY === 'number' ? window.scrollY : (document.scrollingElement ? document.scrollingElement.scrollTop : 0)) ); } catch {}
        const deltaMain = (afterY||0) - (beforeY||0);
        let anyContainer = false;
        try { anyContainer = Array.isArray(mainRes.changed) && mainRes.changed.some(it => Math.abs(it.delta||0) > 5); } catch {}
        let anyFrame = false;
        try { for (const fr of frameResults) { if (fr && Array.isArray(fr.containers) && fr.containers.some(it => Math.abs(it.delta||0) > 5)) { anyFrame = true; break; } } } catch {}
        const ok = (dir>0 ? deltaMain>30 : deltaMain<-30) || anyContainer || anyFrame;
        ws.send(JSON.stringify({ ok: true, type: 'SCROLLED', mode: 'GLOBAL', direction: directionIn, verified: { ok, deltaMain }, containers: mainRes.changed || [], frames: frameResults }));
        return;
      }
      // Sandbox-only: Wheel-only scroll (no programmatic writes). Wheels center content and sidebars once.
      if (msg.type === 'SCROLL_WHEEL_ONLY') {
        const ratioIn = 0.8;
        const directionIn = typeof msg.direction === 'string' ? msg.direction : (typeof msg.dir === 'string' ? msg.dir : 'down');
        const dir = (directionIn === 'up') ? -1 : 1;
        try {
          const pages = browser.pages();
          let pick = pages[pages.length - 1];
          for (let i = pages.length - 1; i >= 0; i--) {
            try { const u = await pages[i].url(); if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; } } catch {}
          }
          if (pick) page = pick;
          try { await page.bringToFront(); } catch {}
        } catch {}
        // Determine center + sidebar targets in one eval
        let targets = { center: null, sidebars: [] };
        try {
          targets = await page.evaluate(() => {
            const vw = window.innerWidth || 1280;
            const vh = window.innerHeight || 800;
            const clampPoint = (v, min, max) => Math.max(min, Math.min(max, v));
            const isScrollable = (el) => { try { const s=getComputedStyle(el); const oy=s.overflowY; return (oy==='auto'||oy==='scroll') && el.scrollHeight>el.clientHeight; } catch { return false; } };
            const label = (el) => { try { const t=(el.tagName||'').toLowerCase(); const id=el.id?`#${el.id}`:''; const cls=el.className&&el.className.toString?'.'+el.className.toString().trim().split(/\s+/).slice(0,2).join('.') : ''; return `${t}${id}${cls}`.slice(0,120);} catch { return ''; } };
            const likelySidebar = (el, r) => {
              try {
                const cls = (el.className && el.className.toString ? el.className.toString().toLowerCase() : '');
                const role = (el.getAttribute && (el.getAttribute('role') || '')).toLowerCase();
                const id = (el.id || '').toLowerCase();
                const leftOrRight = (r.left <= 60) || (r.right >= vw - 60);
                const narrow = (r.width <= vw * 0.42);
                const tall = (r.height >= vh * 0.5);
                const keywords = /(side|sidebar|nav|menu|pane|panel)/;
                const hasKw = keywords.test(cls) || keywords.test(id) || role === 'navigation' || el.tagName.toLowerCase() === 'aside';
                return (leftOrRight && narrow && tall) || hasKw;
              } catch { return false; }
            };
            // Center target
            let center = null;
            try {
              let el = document.elementFromPoint(Math.floor(vw*0.5), Math.floor(vh*0.55));
              let climb = 0;
              while (el && climb < 8 && !isScrollable(el)) { el = el.parentElement; climb++; }
              if (el) {
                const r = el.getBoundingClientRect();
                const tx = Math.floor(clampPoint(r.left + r.width * 0.5, r.left + 8, r.right - 8));
                const ty = Math.floor(clampPoint(r.top + Math.min(r.height - 10, Math.max(10, r.height * 0.6)), r.top + 8, r.bottom - 8));
                const maxTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
                const curTop = el.scrollTop || 0;
                center = { x: tx, y: ty, height: Math.floor(r.height), remainingDown: Math.max(0, maxTop - curTop), remainingUp: Math.max(0, curTop), label: label(el) };
              }
            } catch {}
            // Sidebars
            const sidebars = [];
            const nodes = Array.from(document.querySelectorAll('*'));
            for (const el of nodes) {
              try {
                if (!isScrollable(el)) continue;
                const r = el.getBoundingClientRect();
                if (r.width < 100 || r.height < 120) continue;
                if (r.bottom < 20 || r.top > vh - 20) continue;
                if (!likelySidebar(el, r)) continue;
                const tx = Math.floor(clampPoint(r.left + r.width * 0.5, r.left + 8, r.right - 8));
                const ty = Math.floor(clampPoint(r.top + Math.min(r.height - 10, Math.max(10, r.height * 0.6)), r.top + 8, r.bottom - 8));
                const maxTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
                const curTop = el.scrollTop || 0;
                sidebars.push({ x: tx, y: ty, height: Math.floor(r.height), remainingDown: Math.max(0, maxTop - curTop), remainingUp: Math.max(0, curTop), label: label(el) });
                if (sidebars.length >= 3) break;
              } catch {}
            }
            return { center, sidebars };
          });
        } catch {}
        // Wheel center then sidebars once each
        let moved = 0;
        const wheelOnce = async (t) => {
          if (!t) return;
          try {
            await page.mouse.move(Math.max(1, t.x), Math.max(1, t.y));
            const approx = Math.max(250, Math.round((t.height || 600) * Math.abs(ratioIn)));
            const room = dir > 0 ? (t.remainingDown || approx) : (t.remainingUp || approx);
            const delta = dir * Math.max(200, Math.min(approx, room + 80));
            await page.mouse.wheel(0, delta);
            try { await page.waitForTimeout(60); } catch {}
            moved++;
          } catch {}
        };
        await wheelOnce(targets.center);
        for (const sb of (targets.sidebars || [])) { await wheelOnce(sb); }
        ws.send(JSON.stringify({ ok: true, type: 'SCROLLED', mode: 'WHEEL_ONLY', direction: directionIn, moved }));
        return;
      }
      if (msg.type === 'SCROLL_BOTH') {
        // Enforce fixed 80% of viewport scroll regardless of client-provided delta
        const ratioIn = 0.8;
        const directionIn = typeof msg.direction === 'string' ? msg.direction : (typeof msg.dir === 'string' ? msg.dir : 'down');
        const dir = (directionIn === 'up') ? -1 : 1;
        // Ensure we operate on the active page (latest non-blank)
        try {
          const pages = browser.pages();
          let pick = pages[pages.length - 1];
          for (let i = pages.length - 1; i >= 0; i--) {
            try { const u = await pages[i].url(); if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; } } catch {}
          }
          if (pick) page = pick;
          try { await page.bringToFront(); } catch {}
        } catch {}
        let curUrl = '';
        try { curUrl = await page.url(); } catch {}
        try { ws.send(JSON.stringify({ ok: true, type: 'SCROLL_DEBUG', phase: 'START', direction: directionIn, ratio: ratioIn, token: msg.token || null, url: curUrl })); } catch {}
        // Briefly wait for a stable DOM (helps avoid eval context destruction)
        try { await page.waitForLoadState('domcontentloaded', { timeout: 500 }); } catch {}
        // Minimal eval reads for before/after
        let beforeY = 0; let afterY = 0; let beforeAnchor = ''; let afterAnchor = '';
        let beforeAnchors = []; let afterAnchors = [];
        try { beforeY = await page.evaluate(() => (typeof window.scrollY === 'number' ? window.scrollY : (document.scrollingElement ? document.scrollingElement.scrollTop : 0)) ); } catch (e) {
          try { ws.send(JSON.stringify({ ok:false, type:'SCROLL_DEBUG', phase:'READ_BEFORE_ERROR', error: String(e), token: msg.token || null })); } catch {}
        }
        try {
          beforeAnchor = await page.evaluate(() => {
            const anchorY = Math.floor((window.innerHeight || 800) * 0.9);
            const el = document.elementFromPoint(Math.floor((window.innerWidth||1200)/2), anchorY);
            const sig = (node) => {
              if (!node) return '';
              const t = (node.tagName||'').toLowerCase();
              const id = node.id ? `#${node.id}` : '';
              const cls = node.className && node.className.toString ? '.' + node.className.toString().trim().split(/\s+/).slice(0,3).join('.') : '';
              const txt = (node.innerText||node.textContent||'').trim().toLowerCase().slice(0,32);
              return `${t}${id}${cls}|${txt}`;
            };
            return sig(el);
          });
          // Multi-point anchors (x: 0.2, 0.5, 0.8; y: 0.2, 0.5, 0.9)
          beforeAnchors = await page.evaluate(() => {
            const sig = (node) => {
              if (!node) return '';
              const t = (node.tagName||'').toLowerCase();
              const id = node.id ? `#${node.id}` : '';
              const cls = node.className && node.className.toString ? '.' + node.className.toString().trim().split(/\s+/).slice(0,2).join('.') : '';
              const txt = (node.innerText||node.textContent||'').trim().toLowerCase().slice(0,24);
              return `${t}${id}${cls}|${txt}`;
            };
            const xs = [0.2, 0.5, 0.8]; const ys = [0.2, 0.5, 0.9]; const out = [];
            for (const fx of xs) {
              for (const fy of ys) {
                const x = Math.floor((window.innerWidth||1200) * fx);
                const y = Math.floor((window.innerHeight||800) * fy);
                const el = document.elementFromPoint(x, y);
                out.push(sig(el));
              }
            }
            return out;
          });
        } catch {}
        // Always programmatically advance the main document first for deterministic "scroll everything" behavior
        try {
          await page.evaluate((ratio, sign) => {
            const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
            const se = document.scrollingElement || document.documentElement || document.body;
            if (!se) return;
            const vh = window.innerHeight || 800;
            const d = sign * Math.max(200, Math.round(vh * Math.abs(ratio)));
            const maxTop = Math.max(0, (se.scrollHeight || 0) - (se.clientHeight || 0));
            const cur = se.scrollTop || 0;
            const next = clamp(cur + d, 0, maxTop);
            if (next !== cur) se.scrollTop = next;
          }, ratioIn, dir);
        } catch {}
        // Try targeted container scroll first at left/center/right stripes (avoid bubbling to main if container moves)
        let targetedContainer = { moved: false, label: '' };
        try {
          targetedContainer = await page.evaluate((ratio, sign) => {
            const vh = window.innerHeight || 800;
            const vw = window.innerWidth || 1280;
            const delta = sign * Math.max(100, Math.round(vh * Math.abs(ratio)));
            const points = [ {x: Math.floor(vw*0.08), y: Math.floor(vh*0.5)}, {x: Math.floor(vw*0.92), y: Math.floor(vh*0.5)}, {x: Math.floor(vw*0.5), y: Math.floor(vh*0.5)} ];
            const isScrollable = (el) => {
              try { const s=getComputedStyle(el); const oy=s.overflowY; return (oy==='auto'||oy==='scroll') && el.scrollHeight>el.clientHeight; } catch { return false; }
            };
            const label = (el) => {
              try {
                const t=(el.tagName||'').toLowerCase(); const id=el.id?`#${el.id}`:''; const cls=el.className&&el.className.toString?'.'+el.className.toString().trim().split(/\s+/).slice(0,3).join('.') : '';
                return `${t}${id}${cls}`.slice(0,160);
              } catch { return ''; }
            };
            for (const p of points) {
              let el = document.elementFromPoint(p.x, p.y);
              let climb = 0;
              while (el && climb < 8) {
                if (isScrollable(el)) {
                  const maxTop = Math.max(0, (el.scrollHeight||0) - (el.clientHeight||0));
                  const cur = el.scrollTop || 0;
                  const next = Math.max(0, Math.min(maxTop, cur + delta));
                  if (next !== cur) { el.scrollTop = next; return { moved: true, label: label(el), before: cur, after: next }; }
                  break;
                }
                el = el.parentElement; climb++;
              }
            }
            return { moved: false, label: '' };
          }, ratioIn, dir);
        } catch {}
        if (targetedContainer.moved) {
          try { ws.send(JSON.stringify({ ok:true, type:'SCROLL_DEBUG', phase:'TARGET_CONTAINER_MOVED', label: targetedContainer.label, token: msg.token || null })); } catch {}
          // Also apply a reduced main scroll so the page advances in tandem
          try {
            await page.evaluate((ratio, sign) => {
              const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
              const se = document.scrollingElement || document.documentElement || document.body;
              if (se) {
                const vh = window.innerHeight || 800;
                const d = sign * Math.max(60, Math.round(vh * Math.abs(ratio)));
                const maxTop = Math.max(0, (se.scrollHeight || 0) - (se.clientHeight || 0));
                const cur = se.scrollTop || 0;
                const next = clamp(cur + d, 0, maxTop);
                if (next !== cur) se.scrollTop = next;
              }
            }, Math.min(ratioIn * 0.5, 0.5), dir);
          } catch {}
        } else {
          // Try a single targeted container wheel first; if it moved, skip batch and main wheel
          let batchMoved = false;
          try {
            const pick = await page.evaluate(() => {
              const vpw = window.innerWidth || 1280;
              const vph = window.innerHeight || 800;
              const isScrollable = (el) => { try { const s=getComputedStyle(el); const oy=s.overflowY; return (oy==='auto'||oy==='scroll') && el.scrollHeight>el.clientHeight; } catch { return false; } };
              const nodes = Array.from(document.querySelectorAll('*'));
              for (const el of nodes) {
                try {
                  if (!isScrollable(el)) continue;
                  const r = el.getBoundingClientRect();
                  if (r.height < 100 || r.width < 120) continue;
                  if (r.bottom < 20 || r.top > vph-20) continue;
                  const cx = Math.floor(r.left + r.width/2);
                  const cy = Math.floor(r.top + Math.min(r.height-10, Math.max(10, r.height*0.6)));
                  const sig = (node) => {
                    if (!node) return '';
                    const t=(node.tagName||'').toLowerCase(); const id=node.id?`#${node.id}`:'';
                    const cls=node.className&&node.className.toString?'.'+node.className.toString().trim().split(/\s+/).slice(0,2).join('.') : '';
                    const txt=(node.innerText||node.textContent||'').trim().toLowerCase().slice(0,24);
                    return `${t}${id}${cls}|${txt}`;
                  };
                  const beforeSig = sig(document.elementFromPoint(cx, cy));
                  return { cx, cy, label: (el.id||el.className||el.tagName).toString().slice(0,80), beforeSig };
                } catch {}
              }
              return null;
            });
            if (pick) {
              try { await page.mouse.move(pick.cx, pick.cy); } catch {}
              try { await page.mouse.wheel(0, dir * Math.max(240, Math.round(900 * Math.abs(ratioIn)))); } catch {}
              try { await page.waitForTimeout(60); } catch {}
              const after = await page.evaluate(({cx, cy}) => {
                const el = document.elementFromPoint(cx, cy);
                const sig = (node) => {
                  if (!node) return '';
                  const t=(node.tagName||'').toLowerCase(); const id=node.id?`#${node.id}`:'';
                  const cls=node.className&&node.className.toString?'.'+node.className.toString().trim().split(/\s+/).slice(0,2).join('.') : '';
                  const txt=(node.innerText||node.textContent||'').trim().toLowerCase().slice(0,24);
                  return `${t}${id}${cls}|${txt}`;
                };
                return { afterSig: sig(el) };
              }, { cx: pick.cx, cy: pick.cy });
              if (after && after.afterSig && after.afterSig !== pick.beforeSig) batchMoved = true;
            }
          } catch {}
          // If not moved by targeted wheel, try a single clamped batch scroll of visible containers; if any changed, skip main wheel
          if (!batchMoved) {
            try {
              const res = await page.evaluate((ratio, sign) => {
              const vh = window.innerHeight || 800;
              const delta = sign * Math.max(100, Math.round(vh * Math.abs(ratio)));
              const isScrollable = (el) => { try { const s=getComputedStyle(el); const oy=s.overflowY; return (oy==='auto'||oy==='scroll') && el.scrollHeight>el.clientHeight; } catch { return false; } };
              const viewport = { top: 0, bottom: (window.innerHeight||800) };
              const nodes = Array.from(document.querySelectorAll('*'));
              let moved = false;
              for (const el of nodes) {
                try {
                  if (!isScrollable(el)) continue; const r=el.getBoundingClientRect(); if (r.height<=80) continue; if (r.bottom<viewport.top+40||r.top>viewport.bottom-40) continue;
                  const maxTop = Math.max(0, (el.scrollHeight||0) - (el.clientHeight||0));
                  const before = el.scrollTop || 0;
                  const next = Math.max(0, Math.min(maxTop, before + delta));
                  if (next !== before) { el.scrollTop = next; moved = true; }
                } catch {}
              }
              return { moved };
              }, ratioIn, dir);
              batchMoved = !!(res && res.moved);
            } catch {}
          }
          if (!batchMoved && !skipMainWheel) {
            // Event-driven wheel on main viewport only once (single step)
            try {
              const vp = page.viewportSize() || { width: 1280, height: 800 };
              const cx = Math.floor((vp.width || 1280) / 2);
              const cy = Math.floor((vp.height || 800) / 2);
              try { await page.mouse.move(cx, Math.max(10, Math.min(cy, (vp.height || 800) - 10))); } catch {}
              try { await page.mouse.wheel(0, dir * Math.max(300, Math.round(1000 * Math.abs(ratioIn)))); } catch {}
              try { await page.waitForTimeout(120); } catch {}
            } catch (e) {
              try { ws.send(JSON.stringify({ ok:false, type:'SCROLL_DEBUG', phase:'WHEEL_ERROR', error: String(e), token: msg.token || null })); } catch {}
            }
          } else {
            // Ensure main document advances a bit as well when a container moved via targeted wheel
            try {
              await page.evaluate((ratio, sign) => {
                const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
                const se = document.scrollingElement || document.documentElement || document.body;
                if (se) {
                  const vh = window.innerHeight || 800;
                  const d = sign * Math.max(60, Math.round(vh * Math.abs(ratio)));
                  const maxTop = Math.max(0, (se.scrollHeight || 0) - (se.clientHeight || 0));
                  const cur = se.scrollTop || 0;
                  const next = clamp(cur + d, 0, maxTop);
                  if (next !== cur) se.scrollTop = next;
                }
              }, Math.min(ratioIn * 0.5, 0.5), dir);
            } catch {}
          }
        }
        try { afterY = await page.evaluate(() => (typeof window.scrollY === 'number' ? window.scrollY : (document.scrollingElement ? document.scrollingElement.scrollTop : 0)) ); } catch (e) {
          try { ws.send(JSON.stringify({ ok:false, type:'SCROLL_DEBUG', phase:'READ_AFTER_ERROR', error: String(e), token: msg.token || null })); } catch {}
        }
        try {
          afterAnchor = await page.evaluate(() => {
            const anchorY = Math.floor((window.innerHeight || 800) * 0.9);
            const el = document.elementFromPoint(Math.floor((window.innerWidth||1200)/2), anchorY);
            const sig = (node) => {
              if (!node) return '';
              const t = (node.tagName||'').toLowerCase();
              const id = node.id ? `#${node.id}` : '';
              const cls = node.className && node.className.toString ? '.' + node.className.toString().trim().split(/\s+/).slice(0,3).join('.') : '';
              const txt = (node.innerText||node.textContent||'').trim().toLowerCase().slice(0,32);
              return `${t}${id}${cls}|${txt}`;
            };
            return sig(el);
          });
          afterAnchors = await page.evaluate(() => {
            const sig = (node) => {
              if (!node) return '';
              const t = (node.tagName||'').toLowerCase();
              const id = node.id ? `#${node.id}` : '';
              const cls = node.className && node.className.toString ? '.' + node.className.toString().trim().split(/\s+/).slice(0,2).join('.') : '';
              const txt = (node.innerText||node.textContent||'').trim().toLowerCase().slice(0,24);
              return `${t}${id}${cls}|${txt}`;
            };
            const xs = [0.2, 0.5, 0.8]; const ys = [0.2, 0.5, 0.9]; const out = [];
            for (const fx of xs) {
              for (const fy of ys) {
                const x = Math.floor((window.innerWidth||1200) * fx);
                const y = Math.floor((window.innerHeight||800) * fy);
                const el = document.elementFromPoint(x, y);
                out.push(sig(el));
              }
            }
            return out;
          });
        } catch {}
        // If no movement, attempt JS scrollBy fallback
        if (Number.isFinite(beforeY) && Number.isFinite(afterY) && afterY === beforeY) {
          try {
            const delta = dir * Math.max(200, Math.round(800 * Math.abs(ratioIn)));
            await page.evaluate((d) => {
              const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
              try {
                const se = document.scrollingElement || document.documentElement || document.body;
                if (se) {
                  const maxTop = Math.max(0, (se.scrollHeight || 0) - (se.clientHeight || 0));
                  const cur = se.scrollTop || 0;
                  const next = clamp(cur + d, 0, maxTop);
                  se.scrollTop = next;
                } else {
                  window.scrollBy(0, d);
                }
              } catch {}
            }, delta);
            try { await page.waitForTimeout(60); } catch {}
            afterY = await page.evaluate(() => (typeof window.scrollY === 'number' ? window.scrollY : (document.scrollingElement ? document.scrollingElement.scrollTop : 0)) );
          } catch (e) {
            try { ws.send(JSON.stringify({ ok:false, type:'SCROLL_DEBUG', phase:'JS_FALLBACK_ERROR', error: String(e), token: msg.token || null })); } catch {}
          }
        }
        // Also scroll visible iframes with the same targeted/container logic (one smooth step)
        const frameResults = [];
        try {
          for (const f of page.frames()) {
            if (f === page.mainFrame()) continue;
            try {
              const fe = await f.frameElement();
              if (!fe) continue;
              const box = await fe.boundingBox();
              if (!box || box.width <= 0 || box.height <= 0) continue;
              const beforeYf = await f.evaluate(() => (typeof window.scrollY === 'number' ? window.scrollY : (document.scrollingElement ? document.scrollingElement.scrollTop : 0)) );
              let beforeAf = '';
              let beforeAfTop = '';
              try {
                const res = await f.evaluate(() => {
                  const sig = (node) => {
                    if (!node) return '';
                    const t = (node.tagName||'').toLowerCase();
                    const id = node.id ? `#${node.id}` : '';
                    const cls = node.className && node.className.toString ? '.' + node.className.toString().trim().split(/\s+/).slice(0,3).join('.') : '';
                    const txt = (node.innerText||node.textContent||'').trim().toLowerCase().slice(0,32);
                    return `${t}${id}${cls}|${txt}`;
                  };
                  const x = Math.floor((window.innerWidth||1200)/2);
                  const yBottom = Math.floor((window.innerHeight || 800) * 0.9);
                  const yTop = Math.floor((window.innerHeight || 800) * 0.2);
                  const elB = document.elementFromPoint(x, yBottom);
                  const elT = document.elementFromPoint(x, yTop);
                  return { bottom: sig(elB), top: sig(elT) };
                });
                beforeAf = res.bottom || '';
                beforeAfTop = res.top || '';
              } catch {}
              // Targeted container inside iframe first
              const targetedInFrame = await f.evaluate((ratio, sign) => {
                const vh = window.innerHeight || 800;
                const vw = window.innerWidth || 1280;
                const delta = sign * Math.max(100, Math.round(vh * Math.abs(ratio)));
                const pts = [ {x: Math.floor(vw*0.08), y: Math.floor(vh*0.5)}, {x: Math.floor(vw*0.92), y: Math.floor(vh*0.5)}, {x: Math.floor(vw*0.5), y: Math.floor(vh*0.5)} ];
                const isScrollable = (el) => { try { const s=getComputedStyle(el); const oy=s.overflowY; return (oy==='auto'||oy==='scroll') && el.scrollHeight>el.clientHeight; } catch { return false; } };
                const label = (el) => { try { const t=(el.tagName||'').toLowerCase(); const id=el.id?`#${el.id}`:''; const cls=el.className&&el.className.toString?'.'+el.className.toString().trim().split(/\s+/).slice(0,3).join('.') : ''; return `${t}${id}${cls}`.slice(0,160);} catch { return ''; } };
                for (const p of pts) {
                  let el = document.elementFromPoint(p.x, p.y);
                  let climb = 0;
                  while (el && climb < 8) {
                    if (isScrollable(el)) {
                      const maxTop = Math.max(0, (el.scrollHeight||0) - (el.clientHeight||0));
                      const cur = el.scrollTop || 0;
                      const next = Math.max(0, Math.min(maxTop, cur + delta));
                      if (next !== cur) { el.scrollTop = next; return { moved: true, label: label(el), before: cur, after: next }; }
                      break;
                    }
                    el = el.parentElement; climb++;
                  }
                }
                return { moved: false, label: '' };
              }, ratioIn, dir);

              // If targeted container moved, do not scroll others; else try single-pass clamped containers first
              let cont = { movedAny: false, changed: [] };
              if (!targetedInFrame || !targetedInFrame.moved) {
                cont = await f.evaluate((ratio, sign) => {
                const vh = window.innerHeight || 800;
                const delta = sign * Math.max(100, Math.round(vh * Math.abs(ratio)));
                const isScrollable = (el) => { try { const s=getComputedStyle(el); const oy=s.overflowY; return (oy==='auto'||oy==='scroll') && el.scrollHeight>el.clientHeight; } catch { return false; } };
                const label = (el) => { try { const t=(el.tagName||'').toLowerCase(); const id=el.id?`#${el.id}`:''; const cls=el.className&&el.className.toString?'.'+el.className.toString().trim().split(/\s+/).slice(0,3).join('.') : ''; return `${t}${id}${cls}`.slice(0,160);} catch { return ''; } };
                const viewport = { top: 0, bottom: (window.innerHeight||800) };
                const nodes = Array.from(document.querySelectorAll('*'));
                const changed = [];
                let movedAny = false;
                for (const el of nodes) {
                  try {
                    if (!isScrollable(el)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.height <= 80) continue;
                    if (r.bottom < viewport.top + 40 || r.top > viewport.bottom - 40) continue;
                    const maxTop = Math.max(0, (el.scrollHeight||0) - (el.clientHeight||0));
                    const before = el.scrollTop || 0;
                    const next = Math.max(0, Math.min(maxTop, before + delta));
                    if (next !== before) { el.scrollTop = next; movedAny = true; }
                    const after = el.scrollTop || 0;
                    if (Math.abs(after - before) > 0) changed.push({ label: label(el), before, after, delta: after - before });
                  } catch {}
                }
                return { movedAny, changed };
                }, ratioIn, dir);
              // If no containers moved, wheel once at frame center; else skip
              if (!cont || !cont.movedAny) {
                try { await page.mouse.move(Math.floor(box.x + box.width / 2), Math.floor(box.y + box.height / 2)); } catch {}
                try { await page.mouse.wheel(0, dir * Math.max(250, Math.round(900 * Math.abs(ratioIn)))); } catch {}
                try { await page.waitForTimeout(80); } catch {}
              }
              }

              const afterYf = await f.evaluate(() => (typeof window.scrollY === 'number' ? window.scrollY : (document.scrollingElement ? document.scrollingElement.scrollTop : 0)) );
              let afterAf = '';
              let afterAfTop = '';
              try {
                const res2 = await f.evaluate(() => {
                  const sig = (node) => {
                    if (!node) return '';
                    const t = (node.tagName||'').toLowerCase();
                    const id = node.id ? `#${node.id}` : '';
                    const cls = node.className && node.className.toString ? '.' + node.className.toString().trim().split(/\s+/).slice(0,3).join('.') : '';
                    const txt = (node.innerText||node.textContent||'').trim().toLowerCase().slice(0,32);
                    return `${t}${id}${cls}|${txt}`;
                  };
                  const x = Math.floor((window.innerWidth||1200)/2);
                  const yBottom = Math.floor((window.innerHeight || 800) * 0.9);
                  const yTop = Math.floor((window.innerHeight || 800) * 0.2);
                  const elB = document.elementFromPoint(x, yBottom);
                  const elT = document.elementFromPoint(x, yTop);
                  return { bottom: sig(elB), top: sig(elT) };
                });
                afterAf = res2.bottom || '';
                afterAfTop = res2.top || '';
              } catch {}
              const frameEntry = { frameUrl: f.url(), frameBox: { x: box.x, y: box.y, width: box.width, height: box.height }, result: { beforeY: beforeYf, afterY: afterYf }, anchors: { before: beforeAf, after: afterAf, beforeTop: beforeAfTop, afterTop: afterAfTop } };
              if (targetedInFrame && targetedInFrame.moved) frameEntry.targeted = { label: targetedInFrame.label };
              if (cont && Array.isArray(cont.changed)) frameEntry.containers = cont.changed;
              frameResults.push(frameEntry);
            } catch (e) {
              frameResults.push({ frameUrl: f.url(), error: String(e) });
            }
          }
        } catch (e) {
          try { ws.send(JSON.stringify({ ok:false, type:'SCROLL_DEBUG', phase:'FRAME_LOOP_ERROR', error: String(e), token: msg.token || null })); } catch {}
        }
        // Note: we avoid extra wheel passes over containers to keep a single smooth scroll per action

        // Scroll all visible scrollable containers (sidebars etc.) and measure before/after (single pass, clamped)
        let containerBeforeAfter = { changed: [], total: 0 };
        try {
          containerBeforeAfter = await page.evaluate((ratio, sign) => {
            const vh = window.innerHeight || 800;
            const delta = sign * Math.max(100, Math.round(vh * Math.abs(ratio)));
            const isScrollable = (el) => {
              try {
                const s = getComputedStyle(el);
                const oy = s.overflowY;
                if (!(oy === 'auto' || oy === 'scroll')) return false;
                return el.scrollHeight > el.clientHeight;
              } catch { return false; }
            };
            const label = (el) => {
              try {
                const t = (el.tagName||'').toLowerCase();
                const id = el.id ? `#${el.id}` : '';
                const cls = el.className && el.className.toString ? '.' + el.className.toString().trim().split(/\s+/).slice(0,3).join('.') : '';
                return `${t}${id}${cls}`.slice(0,160);
              } catch { return ''; }
            };
            const viewport = { top: 0, bottom: (window.innerHeight||800) };
            const cand = [];
            const nodes = Array.from(document.querySelectorAll('*'));
            for (const el of nodes) {
              try {
                if (!isScrollable(el)) continue;
                const r = el.getBoundingClientRect();
                if (r.height <= 80) continue;
                if (r.bottom < viewport.top + 40 || r.top > viewport.bottom - 40) continue;
                const maxTop = Math.max(0, (el.scrollHeight||0) - (el.clientHeight||0));
                cand.push({ el, top: el.scrollTop || 0, maxTop, lab: label(el) });
                if (cand.length >= 20) break;
              } catch {}
            }
            // Apply scroll to each container
            for (const c of cand) {
              try {
                const next = Math.max(0, Math.min(c.maxTop, c.top + delta));
                c.el.scrollTop = next;
              } catch {}
            }
            // Measure after
            const changed = [];
            for (const c of cand) {
              try {
                const after = c.el.scrollTop;
                changed.push({ label: c.lab, before: c.top, after, delta: after - c.top });
              } catch {}
            }
            return { total: cand.length, changed };
          }, ratioIn, dir);
        } catch {}
        try { ws.send(JSON.stringify({ ok: true, type: 'SCROLL_DEBUG', phase: 'END', direction: directionIn, token: msg.token || null })); } catch {}
        // Compute verification across multiple signals (main, iframe, container, anchor)
        const delta = (afterY || 0) - (beforeY || 0);
        const signOk = dir > 0 ? (delta > 30) : (delta < -30);
        const anchorChanged = (!!beforeAnchor && !!afterAnchor && beforeAnchor !== afterAnchor) || (Array.isArray(beforeAnchors) && Array.isArray(afterAnchors) && beforeAnchors.length === afterAnchors.length && beforeAnchors.some((v,i)=>v!==afterAnchors[i]));
        let frameOk = false;
        try {
          for (const fr of frameResults) {
            if (!fr || !fr.result) continue;
            const d = (fr.result.afterY || 0) - (fr.result.beforeY || 0);
            if (dir > 0 ? d > 30 : d < -30) { frameOk = true; break; }
          }
        } catch {}
        let containerOk = false;
        let containerOkFrame = false;
        const containersScrolled = [];
        try {
          if (containerBeforeAfter && Array.isArray(containerBeforeAfter.changed)) {
            for (const it of containerBeforeAfter.changed) {
              const d = (it && typeof it.delta === 'number') ? it.delta : 0;
              if (Math.abs(d) > 5) containersScrolled.push(it.label || '');
              if (dir > 0 ? d > 30 : d < -30) containerOk = true;
            }
          }
          // Aggregate container movements inside frames
          for (const fr of frameResults) {
            if (fr && Array.isArray(fr.containers)) {
              for (const it of fr.containers) {
                const d = (it && typeof it.delta === 'number') ? it.delta : 0;
                if (Math.abs(d) > 5) containersScrolled.push(`[frame] ${it.label || ''}`);
                if (dir > 0 ? d > 30 : d < -30) containerOkFrame = true;
              }
            }
          }
        } catch {}
        // Frame anchor change detection (same-origin frames only)
        let frameAnchorOk = false;
        try {
          for (const fr of frameResults) {
            if (fr && fr.anchors && fr.anchors.before && fr.anchors.after && fr.anchors.before !== fr.anchors.after) { frameAnchorOk = true; break; }
          }
        } catch {}
        const framesAttempted = Array.isArray(frameResults) && frameResults.length > 0;
        const mainAttempted = true;
        const containersAttempted = !!(containerBeforeAfter && containerBeforeAfter.total > 0) || !!(targetedContainer && targetedContainer.moved);
        const mainMoved = !!(signOk || anchorChanged);
        const framesMoved = !!(frameOk || frameAnchorOk || containerOkFrame);
        const containersMainMoved = !!containerOk;
        const all = (!mainAttempted || mainMoved) && (!containersAttempted || containersMainMoved) && (!framesAttempted || framesMoved);
        const ok = !!(signOk || frameOk || containerOk || containerOkFrame || frameAnchorOk || anchorChanged);
        const reason = ok
          ? (signOk ? 'main_delta' : (frameOk ? 'iframe_delta' : ((containerOk || containerOkFrame) ? 'container_delta' : (frameAnchorOk ? 'iframe_anchor_changed' : 'anchor_changed'))))
          : 'no_movement_detected';
        ws.send(JSON.stringify({
          ok: true,
          type: 'SCROLLED',
          result: { windowBefore:{ y: beforeY || 0, anchor: beforeAnchor || '' }, windowAfter:{ y: afterY || 0, anchor: afterAnchor || '' }, containersScrolled, containersMain: (containerBeforeAfter && Array.isArray(containerBeforeAfter.changed)) ? containerBeforeAfter.changed : [] },
          frames: frameResults,
          direction: directionIn,
          token: msg.token || null,
          verified: {
            ok,
            reason,
            delta,
            parts: {
              mainDelta: !!signOk,
              mainAnchors: !!anchorChanged,
              containersMain: !!containerOk,
              framesDelta: !!frameOk,
              framesAnchors: !!frameAnchorOk,
            },
            attempted: { main: mainAttempted, containersMain: containersAttempted, frames: framesAttempted },
            moved: { main: mainMoved, containersMain: containersMainMoved, frames: framesMoved },
            all
          }
        }));
        return;
      }
      // Universal scroll: aggressively scroll main + containers + iframes in one composite step
      if (msg.type === 'SCROLL_UNIVERSAL') {
        const directionIn = typeof msg.direction === 'string' ? msg.direction : 'down';
        const dir = (directionIn === 'up') ? -1 : 1;
        // Make sure we operate on the most recent non-blank page
        try {
          const pages = browser.pages();
          let pick = pages[pages.length - 1];
          for (let i = pages.length - 1; i >= 0; i--) {
            try { const u = await pages[i].url(); if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; } } catch {}
          }
          if (pick) page = pick;
          try { await page.bringToFront(); } catch {}
        } catch {}
        const vp = page.viewportSize() || { width: 1280, height: 800 };
        const vh = vp.height || 800;
        const deltaPx = dir * Math.max(200, Math.round(vh * 0.8));

        // Run universal pass in main document
        const mainRes = await page.evaluate(async (delta) => {
          const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
          const wait = (ms) => new Promise(r => setTimeout(r, ms));
          const isScrollable = (el) => {
            try {
              const s = getComputedStyle(el);
              const oy = (s.overflowY || '').toLowerCase();
              const ox = (s.overflowX || '').toLowerCase();
              const scrollable = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') || (ox === 'auto' || ox === 'scroll' || ox === 'overlay');
              return scrollable && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth);
            } catch { return false; }
          };
          const label = (el) => {
            try {
              const t=(el.tagName||'').toLowerCase(); const id=el.id?`#${el.id}`:''; const cls=el.className&&el.className.toString?'.'+el.className.toString().trim().split(/\s+/).slice(0,3).join('.') : '';
              return `${t}${id}${cls}`.slice(0,160);
            } catch { return ''; }
          };
          // 1) Main viewport via programmatic write
          const se = document.scrollingElement || document.documentElement || document.body;
          let mainBefore = 0; let mainAfter = 0;
          try {
            mainBefore = se.scrollTop || 0;
            const maxTop = Math.max(0, (se.scrollHeight || 0) - (se.clientHeight || 0));
            const next = clamp(mainBefore + delta, 0, maxTop);
            if (next !== mainBefore) se.scrollTop = next;
            await wait(40);
            mainAfter = se.scrollTop || 0;
          } catch {}
          // 2) Scroll visible scrollable containers (batch)
          const nodes = Array.from(document.querySelectorAll('*'));
          const viewport = { top: 0, bottom: (window.innerHeight||800) };
          const changed = [];
          for (const el of nodes) {
            try {
              if (!isScrollable(el)) continue;
              const r = el.getBoundingClientRect();
              if (r.height <= 60) continue;
              if (r.bottom < viewport.top + 30 || r.top > viewport.bottom - 30) continue;
              const before = el.scrollTop || 0;
              const maxTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
              const next = clamp(before + delta, 0, maxTop);
              if (next !== before) { el.scrollTop = next; changed.push({ label: label(el), before, after: next, delta: next - before }); }
            } catch {}
          }
          return { main: { before: mainBefore, after: mainAfter, delta: (mainAfter - mainBefore) }, containers: changed };
        }, deltaPx);

        // Run universal pass inside each visible iframe
        const frameResults = [];
        try {
          for (const f of page.frames()) {
            if (f === page.mainFrame()) continue;
            try {
              const fe = await f.frameElement();
              if (!fe) continue;
              const box = await fe.boundingBox();
              if (!box || box.width <= 0 || box.height <= 0) continue;
              const res = await f.evaluate(async (delta) => {
                const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
                const wait = (ms) => new Promise(r => setTimeout(r, ms));
                const isScrollable = (el) => {
                  try {
                    const s = getComputedStyle(el);
                    const oy = (s.overflowY || '').toLowerCase();
                    const ox = (s.overflowX || '').toLowerCase();
                    const scrollable = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') || (ox === 'auto' || ox === 'scroll' || ox === 'overlay');
                    return scrollable && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth);
                  } catch { return false; }
                };
                const label = (el) => { try { const t=(el.tagName||'').toLowerCase(); const id=el.id?`#${el.id}`:''; const cls=el.className&&el.className.toString?'.'+el.className.toString().trim().split(/\s+/).slice(0,3).join('.') : ''; return `${t}${id}${cls}`.slice(0,160);} catch { return ''; } };
                const se = document.scrollingElement || document.documentElement || document.body;
                let mainBefore = 0; let mainAfter = 0;
                try {
                  mainBefore = se.scrollTop || 0;
                  const maxTop = Math.max(0, (se.scrollHeight || 0) - (se.clientHeight || 0));
                  const next = clamp(mainBefore + delta, 0, maxTop);
                  if (next !== mainBefore) se.scrollTop = next;
                  await wait(40);
                  mainAfter = se.scrollTop || 0;
                } catch {}
                const nodes = Array.from(document.querySelectorAll('*'));
                const viewport = { top: 0, bottom: (window.innerHeight||800) };
                const changed = [];
                for (const el of nodes) {
                  try {
                    if (!isScrollable(el)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.height <= 60) continue;
                    if (r.bottom < viewport.top + 30 || r.top > viewport.bottom - 30) continue;
                    const before = el.scrollTop || 0;
                    const maxTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
                    const next = clamp(before + delta, 0, maxTop);
                    if (next !== before) { el.scrollTop = next; changed.push({ label: label(el), before, after: next, delta: next - before }); }
                  } catch {}
                }
                return { main: { before: mainBefore, after: mainAfter, delta: (mainAfter - mainBefore) }, containers: changed };
              }, deltaPx);
              frameResults.push({ frameUrl: f.url(), result: res });
            } catch (e) {
              frameResults.push({ frameUrl: f.url(), error: String(e) });
            }
          }
        } catch {}

        // Summarize and report
        const mainDeltaOk = !!(mainRes && mainRes.main && Math.abs(mainRes.main.delta) > 5);
        let containersOk = false;
        try { containersOk = !!(mainRes && Array.isArray(mainRes.containers) && mainRes.containers.some(c => Math.abs(c.delta||0) > 5)); } catch {}
        let framesOk = false;
        try {
          for (const fr of frameResults) {
            const d = fr && fr.result && fr.result.main ? (fr.result.main.delta || 0) : 0;
            const anyCont = fr && fr.result && Array.isArray(fr.result.containers) ? fr.result.containers.some(c => Math.abs(c.delta||0) > 5) : false;
            if (Math.abs(d) > 5 || anyCont) { framesOk = true; break; }
          }
        } catch {}
        const ok = !!(mainDeltaOk || containersOk || framesOk);
        ws.send(JSON.stringify({ ok: true, type: 'SCROLLED', mode: 'UNIVERSAL', direction: directionIn, universal: { main: mainRes, frames: frameResults }, verified: { ok, parts: { main: !!mainDeltaOk, containers: !!containersOk, frames: !!framesOk } } }));
        return;
      }
      if (msg.type === 'GRAB_HITTABLES') {
        const results = await page.evaluate(() => {
          function collapseWhitespace(text) { return (text || '').replace(/\s+/g, ' ').trim(); }
          function computeRole(el) {
            const aria = (el.getAttribute('role') || '').trim();
            if (aria) return aria.toLowerCase();
            const tag = el.tagName.toLowerCase();
            if (tag === 'a') return (el.getAttribute('href') ? 'link' : 'generic');
            if (tag === 'button') return 'button';
            if (tag === 'input') {
              const type = (el.getAttribute('type') || '').toLowerCase();
              if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
              if (['checkbox'].includes(type)) return 'checkbox';
              if (['radio'].includes(type)) return 'radio';
              if (['range'].includes(type)) return 'slider';
              return 'textbox';
            }
            if (tag === 'select') return 'combobox';
            if (tag === 'textarea') return 'textbox';
            if (tag === 'summary') return 'button';
            return 'generic';
          }
          function computeEnabled(el) {
            const style = window.getComputedStyle(el);
            const disabledAttr = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
            const peNone = style.pointerEvents === 'none';
            const opacityOk = parseFloat(style.opacity || '1') >= 0.4;
            return !disabledAttr && !peNone && opacityOk;
          }
          function shortAncestorAnchor(el) {
            let cur = el; let levels = 0;
            while (cur && levels < 4) {
              if (cur.id) return `#${cur.id}`;
              const dtid = cur.getAttribute && (cur.getAttribute('data-testid') || cur.getAttribute('data-test') || cur.getAttribute('data-qa'));
              if (dtid) return `[data-testid='${String(dtid).replace(/'/g, "\\'")}']`;
              const al = cur.getAttribute && cur.getAttribute('aria-label');
              if (al) return `[aria-label='${String(al).replace(/'/g, "\\'")}']`;
              cur = cur.parentElement; levels += 1;
            }
            const parts = []; cur = el;
            for (let i = 0; i < 3 && cur; i++) {
              const tag = (cur.tagName || 'div').toLowerCase();
              const parent = cur.parentElement;
              if (!parent) { parts.unshift(tag); break; }
              const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
              const idx = siblings.indexOf(cur) + 1;
              parts.unshift(`${tag}:nth-of-type(${idx})`);
              cur = parent;
            }
            return parts.join('>');
          }
          function bestSingleSelector(el) {
            if (el.id) return `#${el.id}`;
            const dtid = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
            if (dtid) return `[data-testid='${String(dtid).replace(/'/g, "\\'")}']`;
            const al = el.getAttribute('aria-label');
            if (al) return `[aria-label='${String(al).replace(/'/g, "\\'")}']`;
            const parts = []; let cur = el;
            for (let i = 0; i < 3 && cur; i++) {
              const tag = (cur.tagName || 'div').toLowerCase();
              const parent = cur.parentElement;
              if (!parent) { parts.unshift(tag); break; }
              const siblings = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
              const idx = siblings.indexOf(cur) + 1;
              parts.unshift(`${tag}:nth-of-type(${idx})`);
              cur = parent;
            }
            let sel = parts.join('>'); if (sel.length > 80) sel = sel.slice(0, 80); return sel;
          }
          function hashBase36(str) { let h = 5381; for (let i = 0; i < str.length; i++) { h=((h<<5)+h)+str.charCodeAt(i); h|=0; } return (h>>>0).toString(36); }
          function isVisible(el) { const s = getComputedStyle(el); if (s.visibility==='hidden'||s.display==='none'||parseFloat(s.opacity||'1')===0) return false; const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.left<innerWidth&&r.top<innerHeight; }
          function isHittable(el) {
            if (!isVisible(el)) return false;
            const s = getComputedStyle(el); if (s.pointerEvents==='none') return false;
            if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled')==='true') return false;
            const tag = el.tagName.toLowerCase(); const href = el.getAttribute('href'); const role=(el.getAttribute('role')||'').toLowerCase();
            if (tag==='a' && href) return true; if (tag==='button'||tag==='summary'||tag==='select'||tag==='textarea') return true;
            if (tag==='input') { const t=(el.getAttribute('type')||'').toLowerCase(); if (t!=='hidden') return true; }
            const ti = el.getAttribute('tabindex'); const tiNum = ti!=null?parseInt(ti,10):NaN; if (!Number.isNaN(tiNum)&&tiNum>=0) return true;
            if ((s.cursor||'').includes('pointer')) return true; if (typeof el.onclick==='function'||el.getAttribute('onclick')) return true; return false;
          }
          const out = []; const idCounts=new Map(); const nodes=Array.from(document.querySelectorAll('*'));
          for (const el of nodes) {
            try {
              if (!isHittable(el)) continue;
              const r = el.getBoundingClientRect(); if (Math.max(r.width,r.height) < 8) continue;
              const role = computeRole(el); const enabled = computeEnabled(el);
              const cx = r.left + r.width/2, cy = r.top + r.height/2;
              let hit_state = 'hittable'; if (!enabled) hit_state='disabled';
              const name = collapseWhitespace((el.getAttribute('aria-label')||'') || el.innerText || el.textContent || '');
              const selector = bestSingleSelector(el); const href = el.tagName.toLowerCase()==='a' && el.href ? el.href : null;
              const anchor = shortAncestorAnchor(el); const idBase = `${role}|${name.toLowerCase()}|${anchor}|${selector}`; let id = hashBase36(idBase); const prev=idCounts.get(id)||0; if(prev>0) id = `${id}-${prev}`; idCounts.set(id, prev+1);
              const item = { id, name, role, enabled, hit_state, center: [Math.round(cx), Math.round(cy)], rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], selector, href };
              out.push(item);
            } catch{}
          }
          return out;
        });
        ws.send(JSON.stringify({ ok: true, elements: results }));
        return;
      }
    } catch (err) {
      ws.send(JSON.stringify({ ok: false, error: String(err) }));
    }
  });
  ws.on('close', async () => {
    try { screencastSubscribers.delete(ws); } catch {}
    if (screencastSubscribers.size === 0) { await stopScreencast(); }
  });
});

async function ocrSpace({ imageUrl, base64Image, language, apiKey, overlay = false }) {
  const form = new FormData();
  form.append('language', language || 'eng');
  form.append('isOverlayRequired', overlay ? 'true' : 'false');
  if (imageUrl) form.append('url', imageUrl);
  if (base64Image) form.append('base64Image', base64Image);
  const res = await fetch('https://api.ocr.space/parse/image', { method: 'POST', headers: { apikey: apiKey || 'helloworld' }, body: form });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.IsErroredOnProcessing) throw new Error(data.ErrorMessage?.[0] || 'OCR error');
  return data;
}

// Planner (GPT-5 chat): generate plan JSON from natural language (no Assistant ID required)
app.post('/nl2plan', async (req, res) => {
  try {
    const { prompt, openaiApiKey, model } = req.body || {};
    if (!openaiApiKey) {
      res.status(400).json({ ok: false, error: 'Missing openaiApiKey' });
      return;
    }
    const plannerModel = (typeof model === 'string' && model.trim()) ? model.trim() : 'gpt-5';
    const systemRules = `- You are the PLANNER.
Your only job is to output JSON describing a step-by-step plan for how to complete the user’s intent inside a web app.

Rules:
1. Output ONLY valid JSON, no explanations, no comments, no markdown.
2. Expected output example

    {
  "plan_id": "a2c1e0b7-38db-4d7c-9cbb-bd6a12a4a123",
  "intent": "update_workflows_emails",
  "domain": "dashboard.nerovaautomation.com",
  "intent_patterns": ["update emails in workflows", "workflows emails"],
  "steps": [
    {
      "id": Step 1,
      "type": "navigate",
      "url": "https://dashboard.nerovaautomation.com"
    },
    {
      "id": Step 2,
      "type": "click_by_candidates",
      "hints": {
        "text": ["Sub-Accounts"],
        "roles": ["link", "button"]
      }
    },
    {
      "id": Step 3,
      "type": "click_by_candidates",
      "hints": {
        "text": ["NerovaAutomation"]
      }
    },
    {
      "id": Step 4,
      "type": "click_by_candidates",
      "hints": {
        "text": ["Automations", "Automation"]
      }
    },
    {
      "id": Step 5,
      "type": "click_by_candidates",
      "hints": {
        "text": ["(1) NerovaCustomWorkflows"]
      }
    },
    {
      "id": Step 6,
      "type": "click_by_candidates",
      "hints": {
        "text": ["Email", "Emails"],
        "roles": ["tab", "button", "link"]
      }
    }
  ]
}

3. Assume you’re are logged in to accounts unless user explicitly says to login
4. Always include multiple candidate texts/roles if possible unless you are confident you know the exact candidate.
5. If an element can vary, use parameter placeholders like {{account_name}} or {{workflow_name}}.
6. Do not include success checks, prose, or anything outside the schema.
7. Plan steps using only these units: "navigate" and "click_by_candidates". Do not use a standalone "type" step.
8. If typing is needed (e.g., search boxes, inputs), add a string field "content" to the same click step. The runtime will click the target and type the content before proceeding.
9. The first step must always be a "navigate" to the app domain.
10. Use deterministic, human-visible anchors for hints: visible text, button names, menu labels.
11. When in doubt, include both singular and plural forms in text hints (e.g., "Automation","Automations").
12. UUIDs for plan_id must be unique each time.`;
    // Additional navigation constraints for clarity
    const navConstraints = `\n12. If the user provides a full URL/link, Step 1 MUST navigate to EXACTLY that URL (use it verbatim).\n13. Do NOT include more than one navigate step. There must be a single Step 1 navigate; all later steps are actions (click/type) only.`;
    const finalRules = systemRules + navConstraints;
    const sentText = `SYSTEM:\n${finalRules}\n\nUSER:\n${String(prompt || '').trim()}`;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: plannerModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: finalRules },
          { role: 'user', content: String(prompt || '').trim() }
        ]
      })
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`OpenAI chat HTTP ${r.status}: ${t}`);
    }
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    let parsed = null; let raw = text;
    if (raw.startsWith('```')) raw = raw.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
    try { parsed = JSON.parse(raw); } catch {}
    res.json({ ok: true, prompt: String(prompt || ''), sent: sentText, raw: text, parsed });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// --- WebRTC offer/answer for DataChannel frame streaming ---
app.post('/webrtc/offer', express.json({ limit: '2mb' }), async (req, res) => {
  if (!enforceMachineAffinity(req, res)) return;
  try {
    const offer = req.body && req.body.offer;
    if (!offer || !offer.sdp || !offer.type) { res.status(400).json({ ok:false, error:'bad_offer', got: req.body }); return; }

    await ensureBrowser();

    const wrtcMod = await import('wrtc');
    const { RTCPeerConnection, RTCSessionDescription, MediaStream, nonstandard } = (wrtcMod && (wrtcMod.default || wrtcMod)) || {};
    if (!RTCPeerConnection || !MediaStream) throw new Error('wrtc classes not available');
    let turbo = null; let turboAvailable = false;
    try { const turboMod = await import('jpeg-turbo'); turbo = (turboMod && (turboMod.default || turboMod)); turboAvailable = !!(turbo && turbo.decompress); } catch {}
    const jpegMod = await import('jpeg-js');
    const decodeJpeg = jpegMod.decode || (jpegMod.default && jpegMod.default.decode);

    // ICE servers configuration; prefer env-provided
    let iceServers = null;
    try { const raw = process.env.WEBRTC_ICE_SERVERS; if (raw) iceServers = JSON.parse(raw); } catch {}
    if (!Array.isArray(iceServers) || iceServers.length === 0) iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

    const pc = new RTCPeerConnection({ iceServers });
    console.log('[webrtc] offer len=', String(offer.sdp||'').length);

    // Debug state logs
    pc.addEventListener('iceconnectionstatechange', ()=> console.log('[webrtc] iceConnectionState=', pc.iceConnectionState));
    pc.addEventListener('connectionstatechange', ()=> console.log('[webrtc] connectionState=', pc.connectionState));
    pc.addEventListener('signalingstatechange', ()=> console.log('[webrtc] signalingState=', pc.signalingState));
    pc.addEventListener('icegatheringstatechange', ()=> console.log('[webrtc] iceGatheringState=', pc.iceGatheringState));

    // DataChannel control (client -> server)
    try {
      pc.ondatachannel = (event) => {
        try {
          const dc = event && (event.channel || event.target) && event.channel ? event.channel : (event && event.channel);
          if (!dc || dc.label !== 'control') return;
          dc.onmessage = async (e) => {
            try {
              let m = null; try { m = JSON.parse(typeof e.data === 'string' ? e.data : ''); } catch {}
              if (!m || !m.t) return;
              await ensureBrowser();
              if (m.t === 'CLICK_VIEWPORT') {
                const rx = Math.round(Number(m.vx)||0), ry = Math.round(Number(m.vy)||0);
                console.log('[webrtc-dc] CLICK_VIEWPORT received:', rx, ry);
                try { await page.bringToFront(); } catch {}
                // Map from streamed pixels (1280x720) to actual viewport pixels
                const viewport = await page.viewportSize();
                const vpW = Math.max(1, Number(viewport && viewport.width || 0));
                const vpH = Math.max(1, Number(viewport && viewport.height || 0));
                const streamW = 1280, streamH = 720; // /webrtc output is forced to 1280x720
                const sx = vpW / streamW, sy = vpH / streamH;
                const vx = Math.max(0, Math.min(vpW - 1, Math.round(rx * sx)));
                const vy = Math.max(0, Math.min(vpH - 1, Math.round(ry * sy)));
                console.log('[webrtc-dc] Current viewport:', viewport, 'mapped:', vx, vy);
                await page.mouse.click(vx, vy, { button: 'left', delay: 20 });
                console.log('[webrtc-dc] Clicked at (mapped):', vx, vy);
                
                // Draw a visual marker where we clicked for debugging
                try {
                  await page.evaluate((x, y) => {
                    const marker = document.createElement('div');
                    marker.style.position = 'fixed';
                    marker.style.left = (x - 5) + 'px';
                    marker.style.top = (y - 5) + 'px';
                    marker.style.width = '10px';
                    marker.style.height = '10px';
                    marker.style.borderRadius = '50%';
                    marker.style.backgroundColor = 'lime';
                    marker.style.border = '2px solid black';
                    marker.style.pointerEvents = 'none';
                    marker.style.zIndex = '999999';
                    document.body.appendChild(marker);
                    setTimeout(() => marker.remove(), 2000);
                    console.log('Drew marker at:', x, y);
                  }, vx, vy);
                } catch {}
                
                // Also dispatch a DOM-level click at the exact coordinate to satisfy JS handlers
                try {
                  await page.evaluate((x,y)=>{
                    const el = document.elementFromPoint(x,y);
                    if (!el) return false;
                    const ev1 = new MouseEvent('click', { bubbles:true, cancelable:true, view:window });
                    return el.dispatchEvent(ev1);
                  }, vx, vy);
                } catch {}
                // Debug: draw a transient dot at the click point to verify mapping
                try {
                  await page.evaluate((x,y)=>{
                    try {
                      const id='__wocr_click_dot__';
                      let layer=document.getElementById(id);
                      if(!layer){ layer=document.createElement('div'); layer.id=id; layer.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:2147483646;'; document.documentElement.appendChild(layer);} 
                      const d=document.createElement('div');
                      d.style.cssText=`position:absolute;left:${x}px;top:${y}px;transform:translate(-50%,-50%);width:10px;height:10px;border-radius:50%;background:#00e0ff;box-shadow:0 0 8px #00e0ff;opacity:.9`;
                      layer.appendChild(d);
                      setTimeout(()=>{ try{ d.remove(); }catch{} }, 300);
                    } catch {}
                  }, vx, vy);
                } catch {}
                return;
              }
              if (m.t === 'DOUBLE_CLICK') {
                const rx = Math.round(Number(m.vx)||0), ry = Math.round(Number(m.vy)||0);
                const viewport = await page.viewportSize();
                const vpW = Math.max(1, Number(viewport && viewport.width || 0));
                const vpH = Math.max(1, Number(viewport && viewport.height || 0));
                const sx = vpW / 1280, sy = vpH / 720;
                const vx = Math.max(0, Math.min(vpW - 1, Math.round(rx * sx)));
                const vy = Math.max(0, Math.min(vpH - 1, Math.round(ry * sy)));
                try { await page.bringToFront(); } catch {}
                try { await page.mouse.move(vx, vy); await page.waitForTimeout(20); await page.mouse.dblclick(vx, vy, { delay: 20 }); } catch {}
                return;
              }
              if (m.t === 'TRIPLE_CLICK') {
                const rx = Math.round(Number(m.vx)||0), ry = Math.round(Number(m.vy)||0);
                const viewport = await page.viewportSize();
                const vpW = Math.max(1, Number(viewport && viewport.width || 0));
                const vpH = Math.max(1, Number(viewport && viewport.height || 0));
                const sx = vpW / 1280, sy = vpH / 720;
                const vx = Math.max(0, Math.min(vpW - 1, Math.round(rx * sx)));
                const vy = Math.max(0, Math.min(vpH - 1, Math.round(ry * sy)));
                try { await page.bringToFront(); } catch {}
                try {
                  await page.mouse.move(vx, vy);
                  await page.waitForTimeout(10);
                  await page.mouse.dblclick(vx, vy, { delay: 10 });
                  await page.mouse.click(vx, vy, { delay: 10 });
                } catch {}
                return;
              }
              if (m.t === 'MOUSEDOWN' || m.t === 'MOUSEUP' || m.t === 'MOUSEMOVE' || m.t === 'RIGHT_CLICK') {
                const rx = Math.round(Number(m.vx)||0), ry = Math.round(Number(m.vy)||0);
                const viewport = await page.viewportSize();
                const vpW = Math.max(1, Number(viewport && viewport.width || 0));
                const vpH = Math.max(1, Number(viewport && viewport.height || 0));
                const sx = vpW / 1280, sy = vpH / 720;
                const vx = Math.max(0, Math.min(vpW - 1, Math.round(rx * sx)));
                const vy = Math.max(0, Math.min(vpH - 1, Math.round(ry * sy)));
                const btn = (m.button === 'right') ? 'right' : (m.button === 'middle' ? 'middle' : 'left');
                try { await page.bringToFront(); } catch {}
                try {
                  if (m.t === 'MOUSEDOWN') { await page.mouse.move(vx, vy); await page.mouse.down({ button: btn }); }
                  if (m.t === 'MOUSEMOVE') { await page.mouse.move(vx, vy); }
                  if (m.t === 'MOUSEUP') { await page.mouse.move(vx, vy); await page.mouse.up({ button: btn }); }
                  if (m.t === 'RIGHT_CLICK') { await page.mouse.click(vx, vy, { button: 'right' }); }
                } catch {}
                return;
              }
              if (m.t === 'TYPE_TEXT') {
                const text = String(m.text||''); const delay = Math.max(0, Math.min(40, Number(m.delay)||0));
                if (text) {
                  if (text.length === 1 && !m.forceType) {
                    try { await page.keyboard.insertText(text); } catch { await page.keyboard.type(text, { delay }); }
                  } else {
                    await page.keyboard.type(text, { delay });
                  }
                }
                return;
              }
              if (m.t === 'FOCUS') { try { await page.bringToFront(); } catch {}; return; }
              if (m.t === 'PRESS_KEY_MOD') {
                const key = String(m.key||'').trim(); const ctrl=!!m.ctrl, meta=!!m.meta, alt=!!m.alt, shift=!!m.shift;
                try {
                  if (ctrl) await page.keyboard.down('Control'); if (meta) await page.keyboard.down('Meta'); if (alt) await page.keyboard.down('Alt'); if (shift) await page.keyboard.down('Shift');
                  if (key) await page.keyboard.press(key);
                } finally {
                  try { if (shift) await page.keyboard.up('Shift'); } catch {}
                  try { if (alt) await page.keyboard.up('Alt'); } catch {}
                  try { if (meta) await page.keyboard.up('Meta'); } catch {}
                  try { if (ctrl) await page.keyboard.up('Control'); } catch {}
                }
                return;
              }
              if (m.t === 'PRESS_ENTER') { await page.keyboard.press('Enter'); return; }
              if (m.t === 'PRESS_KEY') {
                const key = String(m.key||'').trim(); if (key) await page.keyboard.press(key); return;
              }
              if (m.t === 'SCROLL_DIR') {
                const dir = m.direction === 'up' ? -1 : 1;
                await page.evaluate((sign)=>{
                  const se = document.scrollingElement || document.documentElement || document.body;
                  if (!se) return; const vh = window.innerHeight||800; const delta = sign * Math.max(100, Math.round(vh*0.75));
                  const maxTop = Math.max(0,(se.scrollHeight||0)-(se.clientHeight||0));
                  se.scrollTop = Math.max(0, Math.min((se.scrollTop||0)+delta, maxTop));
                }, dir);
                return;
              }
            } catch {}
          };
        } catch {}
      };
    } catch {}

    // Create a server-side video track from Playwright frames (browser encodes VP8/H.264)
    const { RTCVideoSource } = (nonstandard || {});
    if (!RTCVideoSource) { throw new Error('wrtc nonstandard RTCVideoSource not available'); }
    const source = new RTCVideoSource();
    const track = source.createTrack();
    const stream = new MediaStream();
    stream.addTrack(track);
    pc.addTrack(track, stream);

    // RGBA -> I420 converter (BT.601)
    function rgbaToI420(rgba, width, height) {
      const w = width & ~1, h = height & ~1; // even dims
      const ySize = w * h;
      const uvSize = (w * h) >> 2;
      const out = Buffer.allocUnsafe(ySize + uvSize * 2);
      let yOff = 0, uOff = ySize, vOff = ySize + uvSize;
      // Y plane
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * width + x) * 4;
          const R = rgba[idx], G = rgba[idx + 1], B = rgba[idx + 2];
          const Y = ((66 * R + 129 * G + 25 * B + 128) >> 8) + 16;
          out[yOff++] = Y < 0 ? 0 : Y > 255 ? 255 : Y;
        }
      }
      // U, V planes (2x2 subsampling)
      for (let y = 0; y < h; y += 2) {
        for (let x = 0; x < w; x += 2) {
          // gather 2x2
          const p = [
            (y * width + x) * 4,
            (y * width + (x + 1)) * 4,
            ((y + 1) * width + x) * 4,
            ((y + 1) * width + (x + 1)) * 4
          ];
          let Ru = 0, Gu = 0, Bu = 0;
          for (let k = 0; k < 4; k++) { Ru += rgba[p[k]]; Gu += rgba[p[k] + 1]; Bu += rgba[p[k] + 2]; }
          const Rm = Ru >> 2, Gm = Gu >> 2, Bm = Bu >> 2;
          const U = ((-38 * Rm - 74 * Gm + 112 * Bm + 128) >> 8) + 128;
          const V = ((112 * Rm - 94 * Gm - 18 * Bm + 128) >> 8) + 128;
          out[uOff++] = U < 0 ? 0 : U > 255 ? 255 : U;
          out[vOff++] = V < 0 ? 0 : V > 255 ? 255 : V;
        }
      }
      return { data: out, width: w, height: h };
    }

    // Optional RGBA downscale (nearest-neighbor) to reduce CPU cost
    function scaleRGBA(src, sw, sh, scale) {
      const w = Math.max(2, (Math.floor(sw * scale)) & ~1);
      const h = Math.max(2, (Math.floor(sh * scale)) & ~1);
      if (w === sw && h === sh) return { data: src, width: sw, height: sh };
      const dst = Buffer.allocUnsafe(w * h * 4);
      for (let y = 0; y < h; y++) {
        const sy = Math.min(sh - 1, Math.floor(y / scale));
        const srow = sy * sw * 4;
        const drow = y * w * 4;
        for (let x = 0; x < w; x++) {
          const sx = Math.min(sw - 1, Math.floor(x / scale));
          const si = srow + sx * 4;
          const di = drow + x * 4;
          dst[di] = src[si];
          dst[di + 1] = src[si + 1];
          dst[di + 2] = src[si + 2];
          dst[di + 3] = src[si + 3];
        }
      }
      return { data: dst, width: w, height: h };
    }

    // Frame pump loop (JPEG -> I420). If turbojpeg is available, use it; else JPEG.js.
    let pumpRunning = true; let sent = 0; let since = Date.now();
    const fps = Number(process.env.WEBRTC_FPS || 30);
    const delay = Math.max(5, Math.floor(1000 / Math.max(1, fps)));
    const jpegQ = Math.max(20, Math.min(90, Number(process.env.WEBRTC_JPEG_Q || 75)));
    const scale = Math.max(0.5, Math.min(1, Number(process.env.WEBRTC_SCALE || 1.0)));
    // Force viewport to match stream output for 1:1 mapping
    try {
      await page.setViewportSize({ width: 1280, height: 720 });
      console.log('[webrtc] Set viewport to 1280x720 for exact mapping');
    } catch (e) { console.log('[webrtc] Failed to set viewport:', e && e.message || String(e)); }

    // CRITICAL: Get the ACTUAL viewport size from the page
    // This is what the screenshot captures, so we MUST use these exact dimensions
    // DO NOT assume any default size - use what the browser actually gives us
    let targetW = null;
    let targetH = null;
    
    // First try to get the actual browser window inner dimensions
    try {
      const browserDims = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight
      }));
      
      if (browserDims.innerWidth && browserDims.innerHeight) {
        targetW = browserDims.innerWidth;
        targetH = browserDims.innerHeight;
        console.log('[webrtc] Using browser inner dimensions:', targetW, 'x', targetH);
      }
    } catch (e) {
      console.log('[webrtc] Could not get browser dimensions:', e.message);
    }
    
    // Also check Playwright's viewport size
    try {
      const vp = await page.viewportSize();
      if (vp && vp.width && vp.height) {
        // If different from browser, log the discrepancy
        if (vp.width !== targetW || vp.height !== targetH) {
          console.log('[webrtc] VIEWPORT MISMATCH! Playwright says:', vp.width, 'x', vp.height, 'but browser says:', targetW, 'x', targetH);
          // Use the Playwright viewport as it's what screenshot captures
          targetW = vp.width;
          targetH = vp.height;
        }
      }
    } catch (e) {
      console.log('[webrtc] Failed to get viewport size:', e.message);
    }
    
    // Force a fixed output size for /webrtc to 1280x720 as requested
    targetW = 1280;
    targetH = 720;
    
    // Ensure even dimensions for yuv420p encoding
    if (targetW % 2 !== 0) targetW -= 1;
    if (targetH % 2 !== 0) targetH -= 1;
    console.log('[webrtc] FINAL video stream dimensions:', targetW, 'x', targetH);
    const frameSize = (targetW * targetH * 3) >> 1; // yuv420p
    let ff = null; let stdoutBuf = Buffer.alloc(0);
    function ensureFfmpeg() {
      if (ff && !ff.killed) return;
      try { ff && ff.kill('SIGKILL'); } catch {}
      stdoutBuf = Buffer.alloc(0);
      ff = spawn('ffmpeg', [
        '-hide_banner','-loglevel','error',
        '-fflags','nobuffer','-flags','low_delay',
        '-f','mjpeg','-i','pipe:0',
        '-threads','8',
        '-filter_threads','4',
        // Enforce exact 1280x720 without letterboxing: scale to cover then center-crop, set SAR
        '-vf', `scale=${targetW}:${targetH}:flags=fast_bilinear:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}:(iw-${targetW})/2:(ih-${targetH})/2,setsar=1/1,format=yuv420p`,
        '-f','rawvideo','pipe:1'
      ], { stdio: ['pipe','pipe','pipe'] });
      ff.on('error', (e)=>{ try { log('[webrtc] ffmpeg error', String(e && e.message || e)); } catch {} });
      ff.stderr.on('data', (d)=>{ try { log('[ffmpeg]', d.toString().trim()); } catch {} });
      ff.stdout.on('data', (chunk) => {
        try {
          stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
          while (stdoutBuf.length >= frameSize) {
            const frame = stdoutBuf.subarray(0, frameSize);
            stdoutBuf = stdoutBuf.subarray(frameSize);
            try { source.onFrame({ width: targetW, height: targetH, data: frame }); sent++; } catch {}
          }
          const now = Date.now();
          if (now - since > 5000) { log('[webrtc] pump fps ~', Math.round((sent * 1000) / (now - since))); sent = 0; since = now; }
        } catch {}
      });
    }
    let lastScreencastTs = 0;
    async function pump() {
      try {
        await ensureBrowser();
        // Pick most recent non-blank page and bring to front (no per-frame stabilization)
        try {
          const pages = browser.pages();
          let pick = pages[pages.length - 1];
          for (let i = pages.length - 1; i >= 0; i--) {
            try { const u = await pages[i].url(); if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; } } catch {}
          }
          if (pick) page = pick;
          try { await page.bringToFront(); } catch {}
          try {
            const u = await page.url();
            if (!u || /^about:blank/.test(u) || /^data:text\//.test(u)) {
              await page.goto(DEFAULT_BOOT_URL, { waitUntil: 'load', timeout: 3000 }).catch(()=>{});
            }
          } catch {}
          // removed per-frame stabilization to maximize FPS
        } catch {}
        // Prefer CDP screencast frames; feed latest frame every tick to maintain steady fps
        if (!screencastActive) { try { await startScreencast({ quality: Math.min(70, jpegQ), maxWidth: targetW, maxHeight: targetH, everyNthFrame: 1 }); } catch {} }
        let jpegBuf = null;
        if (screencastLast && screencastLast.buf) { jpegBuf = screencastLast.buf; lastScreencastTs = screencastLast.ts || lastScreencastTs; }
        else { jpegBuf = await page.screenshot({ type: 'jpeg', quality: jpegQ, fullPage: false }); }
        try { ensureFfmpeg(); if (jpegBuf) ff.stdin.write(jpegBuf); } catch {}
        const now = Date.now();
        if (now - since > 5000) { log('[webrtc] pump fps ~', Math.round((sent * 1000) / (now - since))); sent = 0; since = now; }
      } catch (e) { log('[webrtc] pump error', String(e && e.message || e)); }
    }
    (async () => {
      log('[webrtc] video source started (fps=' + fps + ') [ffmpeg]');
      while (pumpRunning && pc.connectionState !== 'closed') { await pump(); await new Promise(r=>setTimeout(r, delay)); }
      log('[webrtc] video source stopped');
    })();
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { pumpRunning = false; try { track.stop(); } catch {} try { ff && ff.kill('SIGKILL'); } catch {} }
    });

    await pc.setRemoteDescription(new RTCSessionDescription({ type: String(offer.type), sdp: String(offer.sdp) }));
    const answer = await pc.createAnswer();
    function preferCodecInSdp(sdp, kind, codec) {
      try {
        const s = sdp.split('\n');
        const mlineIndex = s.findIndex(l => l.startsWith('m=' + kind));
        if (mlineIndex === -1) return sdp;
        const rtpmap = {};
        for (let i=0;i<s.length;i++) {
          const m = s[i].match(/^a=rtpmap:(\d+)\s+([^\/]+)/);
          if (m) rtpmap[m[1]] = m[2];
        }
        const mParts = s[mlineIndex].split(' ');
        const header = mParts.slice(0,3);
        const pts = mParts.slice(3);
        const preferred = [];
        const others = [];
        for (const pt of pts) { if ((rtpmap[pt]||'').toUpperCase().includes(codec.toUpperCase())) preferred.push(pt); else others.push(pt); }
        if (!preferred.length) return sdp;
        s[mlineIndex] = [...header, ...preferred, ...others].join(' ');
        return s.join('\n');
      } catch { return sdp; }
    }
    let munged = { type: 'answer', sdp: String(answer && answer.sdp || '') };
    munged.sdp = preferCodecInSdp(munged.sdp, 'video', 'H264');
    await pc.setLocalDescription(munged);
    // Try to raise encoder bitrate/framerate
    try {
      const sender = (pc.getSenders && pc.getSenders()[0]) || null;
      if (sender && sender.getParameters) {
        const p = sender.getParameters() || {};
        p.encodings = p.encodings || [{}];
        p.encodings[0].maxBitrate = 6_000_000; // ~6 Mbps
        p.encodings[0].maxFramerate = Math.max(60, fps);
        await sender.setParameters(p).catch(()=>{});
      }
    } catch {}
    const t0 = Date.now();
    while (pc.iceGatheringState !== 'complete' && Date.now() - t0 < 3000) { await new Promise(r=>setTimeout(r, 50)); }
    const out = pc.localDescription ? { type: pc.localDescription.type, sdp: pc.localDescription.sdp } : null;
    if (!out) { res.status(500).json({ ok:false, error:'no_local_description', debug:{ ice: pc.iceGatheringState } }); return; }
    console.log('[webrtc] answer len=', String(out.sdp||'').length, 'ice=', pc.iceGatheringState);
    res.json({ ok:true, answer: out, debug: { ice: pc.iceGatheringState, video: { width: targetW, height: targetH } } });
  } catch (e) {
    try { console.log('[webrtc] error', String(e && e.stack || e)); } catch {}
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// NL2Web proxy: call OpenAI Assistants with prompt + candidates
app.post('/nl2web', async (req, res) => {
  try {
    const { prompt, target, k = 15, candidates = [], openaiApiKey, assistantId } = req.body || {};
    if (!openaiApiKey || !assistantId) {
      res.status(400).json({ ok: false, error: 'Missing openaiApiKey or assistantId' });
      return;
    }
    // Compose message content
    const content = target ? JSON.stringify({ target, k, candidates }) : JSON.stringify({ prompt, k, candidates });
    // Create thread (empty), then add user message (Assistants v2)
    let r = await fetch('https://api.openai.com/v1/threads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({})
    });
    if (!r.ok) throw new Error(`OpenAI threads HTTP ${r.status}`);
    const thread = await r.json();
    // Add user message
    r = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        role: 'user',
        content: [ { type: 'text', text: content } ]
      })
    });
    if (!r.ok) throw new Error(`OpenAI messages HTTP ${r.status}`);
    // Create run
    r = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({ assistant_id: assistantId })
    });
    if (!r.ok) throw new Error(`OpenAI runs HTTP ${r.status}`);
    let run = await r.json();
    // Poll until completed or 30s timeout
    const start = Date.now();
    while (run.status !== 'completed') {
      await new Promise(r => setTimeout(r, 800));
      const rr = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, {
        headers: { 'Authorization': `Bearer ${openaiApiKey}`, 'OpenAI-Beta': 'assistants=v2' }
      });
      if (!rr.ok) throw new Error(`OpenAI get run HTTP ${rr.status}`);
      run = await rr.json();
      if (Date.now() - start > 30000) throw new Error('OpenAI run timeout');
      if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'expired') throw new Error(`OpenAI run status ${run.status}`);
    }
    // Read messages
    r = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      headers: { 'Authorization': `Bearer ${openaiApiKey}`, 'OpenAI-Beta': 'assistants=v2' }
    });
    if (!r.ok) throw new Error(`OpenAI list messages HTTP ${r.status}`);
    const msgs = await r.json();
    // Find the latest assistant message with text
    let text = '';
    for (const m of msgs.data || []) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const c of m.content) {
          if ((c.type === 'text' || c.type === 'output_text') && c.text && c.text.value) { text = c.text.value; break; }
        }
      }
      if (text) break;
    }
    let ids = [];
    try { const parsed = JSON.parse(text); if (Array.isArray(parsed.ids)) ids = parsed.ids; } catch {}
    res.json({ id: ids });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Second AI: send Step 3 + screenshot to action assistant
app.post('/nl2web2', async (req, res) => {
  try {
    const { prompt, target, elements = [], openaiApiKey, assistantId } = req.body || {};
    if (!openaiApiKey || !assistantId) {
      res.status(400).json({ ok: false, error: 'Missing openaiApiKey or assistantId' });
      return;
    }
    await ensureBrowser();
      try { await page.bringToFront(); } catch {}
      await stabilizeBeforeScreenshot();
      const shot = await page.screenshot({ fullPage: false });
    // Pass through only the user input and collected elements; no extra local rules
    const inputPayload = JSON.stringify(target ? { target, elements } : { prompt, elements });
    // Upload screenshot as a file for Assistants v2
    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', new Blob([shot], { type: 'image/png' }), 'screenshot.png');
    let ur = await fetch('https://api.openai.com/v1/files', {
      method: 'POST', headers: { 'Authorization': `Bearer ${openaiApiKey}` }, body: form
    });
    if (!ur.ok) {
      const t = await ur.text();
      throw new Error(`OpenAI file upload HTTP ${ur.status}: ${t}`);
    }
    const fileMeta = await ur.json();
    // Assistants v2: create thread, add multimodal message, run
    let r = await fetch('https://api.openai.com/v1/threads', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({})
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`OpenAI threads HTTP ${r.status}: ${t}`); }
    const thread = await r.json();
    // Add user message with text + image
    r = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        role: 'user',
        content: [
          { type: 'text', text: inputPayload },
          { type: 'image_file', image_file: { file_id: fileMeta.id } }
        ]
      })
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`OpenAI messages HTTP ${r.status}: ${t}`); }
    // Run
    r = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({ assistant_id: assistantId })
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`OpenAI runs HTTP ${r.status}: ${t}`); }
    let run = await r.json();
    const start = Date.now();
    while (run.status !== 'completed') {
      await new Promise(r => setTimeout(r, 800));
      const rr = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, {
        headers: { 'Authorization': `Bearer ${openaiApiKey}`, 'OpenAI-Beta': 'assistants=v2' }
      });
      if (!rr.ok) { const t = await rr.text(); throw new Error(`OpenAI get run HTTP ${rr.status}: ${t}`); }
      run = await rr.json();
      if (Date.now() - start > 30000) throw new Error('OpenAI run timeout');
      if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'expired') throw new Error(`OpenAI run status ${run.status}`);
    }
    // Messages
    r = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      headers: { 'Authorization': `Bearer ${openaiApiKey}`, 'OpenAI-Beta': 'assistants=v2' }
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`OpenAI list messages HTTP ${r.status}: ${t}`); }
    const msgs = await r.json();
    let text = '';
    for (const m of msgs.data || []) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const c of m.content) {
          if ((c.type === 'text' || c.type === 'output_text') && c.text && c.text.value) { text = c.text.value; break; }
        }
      }
      if (text) break;
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    res.json({ ok: true, raw: text, parsed });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Step Critic (text-only): call OpenAI chat with system + user JSON payload
app.post('/critic', async (req, res) => {
  try {
    const body = req.body || {};
    const {
      prompt: bodyPrompt,
      openaiApiKey,
      screenshot: providedScreenshot,
      currentUrl: explicitUrl,
      contextNotes = '',
      model
    } = body;

    const prompt = typeof bodyPrompt === 'string' && bodyPrompt.trim()
      ? bodyPrompt.trim()
      : (typeof body?.goal?.original_prompt === 'string' ? body.goal.original_prompt : '');

    const cleanScreenshot = (() => {
      if (typeof providedScreenshot !== 'string') return null;
      const trimmed = providedScreenshot.trim();
      if (!trimmed) return null;
      if (trimmed.startsWith('data:image')) {
        const idx = trimmed.indexOf(',');
        return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
      }
      return trimmed;
    })();

    if (cleanScreenshot && cleanScreenshot.length > 20) {
      const result = await callCritic({
        prompt: prompt || '',
        screenshot: cleanScreenshot,
        currentUrl: explicitUrl || body?.context?.current_url || '',
        contextNotes,
        openaiApiKey,
        model
      });
      res.json(result);
      return;
    }

    await ensureBrowser();
    try {
      const pages = browser.pages();
      let pick = pages[pages.length - 1];
      for (let i = pages.length - 1; i >= 0; i--) {
        try { const u = await pages[i].url(); if (u && !/^about:blank/.test(u)) { pick = pages[i]; break; } } catch {}
      }
      if (pick) page = pick;
      try { await page.bringToFront(); } catch {}
    } catch {}
    try { await page.waitForLoadState('domcontentloaded', { timeout: 3000 }); } catch {}
    try { await page.waitForLoadState('load', { timeout: 2500 }); } catch {}
    try { await page.waitForLoadState('networkidle', { timeout: 2500 }); } catch {}
    try {
      await page.waitForFunction(() => {
        try {
          const se = document.scrollingElement || document.documentElement || document.body;
          const ok = !!se && (se.scrollHeight > 0 || se.clientHeight > 0);
          const rs = document.readyState;
          return ok && rs !== 'loading';
        } catch { return false; }
      }, { timeout: 1500 });
    } catch {}
    try { await page.waitForTimeout(200); } catch {}
    const shotBuf = await page.screenshot({ fullPage: false });
    const shotB64 = shotBuf.toString('base64');
    const result = await callCritic({
      prompt: prompt || '',
      screenshot: shotB64,
      currentUrl: explicitUrl || await page.url().catch(() => '') || '',
      contextNotes,
      openaiApiKey,
      model
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Save a successful run as a reusable recipe
app.post('/recipes/save', async (req, res) => {
  try {
    const { guide_id, domain, intent_patterns, steps } = req.body || {};
    if (!guide_id || !domain || !Array.isArray(intent_patterns) || !Array.isArray(steps)) {
      res.status(400).json({ ok: false, error: 'Missing guide_id, domain, intent_patterns, or steps' });
      return;
    }
    const dir = RECIPES_DIR;
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${domain}.json`);
    let cur = [];
    try {
      const buf = await fs.readFile(file, 'utf8');
      cur = JSON.parse(buf);
      if (!Array.isArray(cur)) cur = [];
    } catch {}
    const now = new Date().toISOString();
    const recipe = { guide_id, domain, intent_patterns, steps, updated_at: now, created_at: now };
    let replaced = false;
    const next = cur.map(r => {
      if (r && r.guide_id === guide_id) { replaced = true; return recipe; }
      return r;
    });
    if (!replaced) next.push(recipe);
    await fs.writeFile(file, JSON.stringify(next, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Temp journal endpoints for an in-progress plan execution
app.post('/recipes/journal/start', async (req, res) => {
  try {
    const { plan_id, intent, domain, intent_patterns, url } = req.body || {};
    if (!plan_id || !domain) { res.status(400).json({ ok:false, error:'Missing plan_id or domain' }); return; }
    const dir = TMP_DIR;
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${plan_id}.json`);
    const now = new Date().toISOString();
    const data = { plan_id, intent: intent||'', domain, intent_patterns: Array.isArray(intent_patterns)?intent_patterns:[], url: url||'', steps: [{ step: 1, type: 'navigate', url: url||'' }], created_at: now, updated_at: now };
    await fs.writeFile(file, JSON.stringify(data, null, 2));
    // Prune tmp directory to at most 3 journal files (delete oldest first)
    try {
      const entries = await fs.readdir(dir);
      const jsonFiles = entries.filter(n => n.endsWith('.json')).map(name => path.join(dir, name));
      if (jsonFiles.length > 3) {
        const withTime = await Promise.all(jsonFiles.map(async p => ({ p, t: (await fs.stat(p)).mtimeMs })));
        withTime.sort((a,b)=>a.t-b.t);
        const toDelete = withTime.slice(0, jsonFiles.length - 3);
        for (const it of toDelete) { try { await fs.unlink(it.p); } catch {} }
      }
    } catch {}
    res.json({ ok: true, file });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

app.post('/recipes/journal/append', async (req, res) => {
  try {
    const { plan_id, step, id, name, action, role, selector } = req.body || {};
    if (!plan_id || typeof step !== 'number') { res.status(400).json({ ok:false, error:'Missing plan_id or step' }); return; }
    const file = path.join(TMP_DIR, `${plan_id}.json`);
    const buf = await fs.readFile(file, 'utf8');
    const data = JSON.parse(buf);
    data.steps = Array.isArray(data.steps) ? data.steps : [];
    const entry = { step };
    if (id != null) entry.id = id;
    if (name != null) entry.name = name;
    if (action != null) entry.action = action;
    if (role != null) entry.role = role;
    if (selector != null) entry.selector = selector;
    entry.ts = new Date().toISOString();
    data.steps.push(entry);
    data.updated_at = new Date().toISOString();
    const part = file + '.part';
    await fs.writeFile(part, JSON.stringify(data, null, 2));
    await fs.rename(part, file);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

app.post('/recipes/journal/delete', async (req, res) => {
  try {
    const { plan_id } = req.body || {};
    if (!plan_id) { res.status(400).json({ ok:false, error:'Missing plan_id' }); return; }
    const file = path.join(TMP_DIR, `${plan_id}.json`);
    try { await fs.unlink(file); } catch {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok:false, error:String(e) }); }
});

// Finalize a journal into a saved recipe and delete the temp file
app.post('/recipes/journal/finalize', async (req, res) => {
  try {
    const { plan_id } = req.body || {};
    if (!plan_id) { res.status(400).json({ ok:false, error:'Missing plan_id' }); return; }
    const tmpFile = path.join(TMP_DIR, `${plan_id}.json`);
    const buf = await fs.readFile(tmpFile, 'utf8');
    const data = JSON.parse(buf);
    const domain = String(data.domain||'').trim();
    if (!domain) { res.status(400).json({ ok:false, error:'Journal missing domain' }); return; }
    const recipe = {
      guide_id: String(data.intent||data.plan_id||'').trim() || `guide-${Date.now()}`,
      domain,
      intent_patterns: Array.isArray(data.intent_patterns) ? data.intent_patterns : [],
      steps: Array.isArray(data.steps) ? data.steps.map(s => {
        const out = { step: s.step };
        if (s.type === 'navigate' && s.url) {
          out.type = 'navigate';
          out.url = s.url;
          return out;
        }
        if (s.id != null) out.id = s.id;
        if (s.name != null) out.name = s.name;
        if (s.action != null) out.action = s.action;
        if (s.role != null) out.role = s.role;
        if (s.selector != null) out.selector = s.selector;
        return out;
      }) : []
    };
    // Save into domain recipes file
    const recipesDir = RECIPES_DIR;
    await fs.mkdir(recipesDir, { recursive: true });
    const file = path.join(recipesDir, `${domain}.json`);
    let cur = [];
    try { const ex = await fs.readFile(file, 'utf8'); cur = JSON.parse(ex); if (!Array.isArray(cur)) cur = []; } catch {}
    // Replace by same guide_id if exists, else push
    let replaced = false;
    const next = cur.map(r => (r && r.guide_id === recipe.guide_id ? (replaced = true, recipe) : r));
    if (!replaced) next.push(recipe);
    await fs.writeFile(file, JSON.stringify(next, null, 2));
    // Delete temp
    try { await fs.unlink(tmpFile); } catch {}
    res.json({ ok: true, recipe });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

// Helper: tokenize text into meaningful tokens
function tokenizeText(text) {
  const stop = new Set(['the','and','for','you','are','with','from','that','this','then','into','your','just','only','over','onto','onto','out','when','have','has','had','will','would','could','should','a','an','to','of','in','on','by','at','as','or','be','is','it']);
  return String(text||'').toLowerCase().split(/[^a-z0-9]+/).filter(t => t && t.length >= 3 && !stop.has(t));
}
function normalizeLoose(text){
  return String(text||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
}

// Retrieve best-matching recipes using token overlap; optionally re-rank with OpenAI nano
app.post('/recipes/retrieve', async (req, res) => {
  try {
    const { prompt, topN = 20, openaiApiKey, model } = req.body || {};
    const dir = RECIPES_DIR;
    let files = [];
    try { files = (await fs.readdir(dir)).filter(n => n.endsWith('.json')); } catch {}
    const recipes = [];
    for (const name of files) {
      try {
        const arr = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
        if (!Array.isArray(arr)) continue;
        for (const r of arr) {
          if (!r || !r.guide_id || !r.domain) continue;
          const patterns = Array.isArray(r.intent_patterns) ? r.intent_patterns : [];
          recipes.push({ guide_id: r.guide_id, domain: r.domain, intent_patterns: patterns });
        }
      } catch {}
    }
    const pTokens = new Set(tokenizeText(prompt || ''));
    const score = (cand) => {
      const tokens = new Set();
      for (const s of cand.intent_patterns || []) tokenizeText(s).forEach(t => tokens.add(t));
      if (tokens.size === 0 || pTokens.size === 0) return 0;
      let inter = 0; for (const t of pTokens) if (tokens.has(t)) inter++;
      const union = new Set([...pTokens, ...tokens]).size;
      return inter / union; // Jaccard
    };
    const ranked = recipes.map(r => ({ ...r, score: score(r) }))
      .sort((a,b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(100, Number(topN) || 20)));
    // Prepare nano prompt parts regardless, using top 20
    const cands = ranked.slice(0, 20).map(({ guide_id, domain, intent_patterns }) => ({ guide_id, domain, intent_patterns }));
    const system = [
      'You are a retrieval re-ranker. Output JSON only. Pick at most one candidate that matches the user intent; otherwise set guide_id to null.',
      'Output schema: {"guide_id": string|null, "confidence": number, "continue": "true"|"false"}.',
      'Set continue="true" only when confidence ≥ 0.92. No explanations or extra fields.'
    ].join(' ');
    const user = JSON.stringify({ prompt: String(prompt||''), candidates: cands });
    // If no API key, return prefilter only plus the sent payload
    if (!openaiApiKey || !model) { res.json({ ok: true, candidates: ranked, continue: false, sent: { system, user } }); return; }
    // Re-rank with nano: pick at most 20
    // cands/system/user already computed above
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { 'Authorization': `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages: [ { role: 'system', content: system }, { role: 'user', content: user } ] })
    });
    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ ok: false, error: `OpenAI chat HTTP ${r.status}: ${t}`, candidates: cands, sent: { system, user } });
      return;
    }
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '{}';
    let parsed = {}; try { parsed = JSON.parse(text); } catch {}
    const guideId = parsed && parsed.guide_id != null ? parsed.guide_id : null;
    const conf = Number(parsed && parsed.confidence != null ? parsed.confidence : 0);
    const cont = !!guideId && conf >= 0.92;
    const rerank = { guide_id: guideId, confidence: conf, continue: cont ? 'true' : 'false' };
    res.json({ ok: true, candidates: cands, rerank, continue: cont, sent: { system, user } });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// Get a full recipe by guide_id
app.get('/recipes/get', async (req, res) => {
  try {
    const guideId = String(req.query.guide_id || '').trim();
    if (!guideId) { res.status(400).json({ ok:false, error:'Missing guide_id' }); return; }
    const dir = RECIPES_DIR;
    let files = [];
    try { files = (await fs.readdir(dir)).filter(n => n.endsWith('.json')); } catch {}
    for (const name of files) {
      try {
        const arr = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
        if (!Array.isArray(arr)) continue;
        const hit = arr.find(r => r && r.guide_id === guideId);
        if (hit) { res.json({ ok: true, recipe: hit }); return; }
      } catch {}
    }
    res.status(404).json({ ok:false, error:'guide_id not found' });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});
