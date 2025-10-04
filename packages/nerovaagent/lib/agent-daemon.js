import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(os.homedir(), '.nerovaagent');

const DEFAULT_REMOTE_ORIGIN = (process.env.NEROVA_AGENT_HTTP
  || process.env.NEROVA_AGENT_REMOTE_DEFAULT
  || process.env.NEROVA_AGENT_DEFAULT_ORIGIN
  || 'http://ec2-54-227-111-189.compute-1.amazonaws.com:3333').trim();

const AGENT_TOKEN = process.env.NEROVA_AGENT_AGENT_TOKEN || process.env.NEROVA_AGENT_TOKEN || '';
const AGENT_ID = process.env.NEROVA_AGENT_ID || `${os.hostname()}-${process.pid}`;

const wsUrlFromHttp = (origin) => {
  try {
    const url = new URL(origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = path.posix.join(url.pathname, '/agent/connect');
    return url.toString();
  } catch (err) {
    console.error('[agent] invalid origin', origin, err);
    process.exit(1);
  }
};

const WS_URL = wsUrlFromHttp(DEFAULT_REMOTE_ORIGIN);

let context = null;
let page = null;
let browser = null;
let agentIdAcknowledged = null;

const pending = new Map();

const resolveCommand = (id, payload) => {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(payload);
};

const rejectCommand = (id, error) => {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.reject(error);
};

async function ensureBrowser() {
  if (context) return;
  await fs.mkdir(DATA_DIR, { recursive: true }).catch(() => {});
  browser = await chromium.launchPersistentContext(DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 720 },
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows'
    ]
  });
  const pages = browser.pages();
  page = pages.length ? pages[0] : await browser.newPage();
  context = browser;
}

async function handleCommand(command, payload = {}) {
  await ensureBrowser();
  switch (command) {
    case 'PING':
      return { pong: Date.now() };
    case 'INIT':
      await page.bringToFront?.();
      return { ok: true };
    case 'FOCUS': {
      await page.bringToFront?.();
      return { ok: true };
    }
    case 'NAVIGATE': {
      const { url, options } = payload;
      if (!url) throw new Error('Missing url');
      await page.goto(url, options || { waitUntil: 'load' });
      return { ok: true };
    }
    case 'WAIT_FOR_LOAD_STATE': {
      const { state = 'load', timeout } = payload;
      await page.waitForLoadState(state, timeout ? { timeout } : undefined);
      return { ok: true };
    }
    case 'WAIT_FOR_TIMEOUT': {
      const { ms = 0 } = payload;
      await page.waitForTimeout(ms);
      return { ok: true };
    }
    case 'WAIT_FOR_FUNCTION': {
      const { expression, arg, timeout } = payload;
      if (!expression) throw new Error('Missing expression');
      const fn = Function(`return (${expression});`)();
      await page.waitForFunction(fn, arg, timeout ? { timeout } : undefined);
      return { ok: true };
    }
    case 'WAIT_FOR_ANIMATION_FRAME': {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(true))));
      return { ok: true };
    }
    case 'EVALUATE': {
      const { expression, arg } = payload;
      const fn = Function(`return (${expression});`)();
      const result = await page.evaluate(fn, arg);
      return { ok: true, result };
    }
    case 'SCREENSHOT': {
      const { options } = payload;
      const buf = await page.screenshot({ fullPage: false, ...(options || {}) });
      return { ok: true, data: buf.toString('base64') };
    }
    case 'VIEWPORT': {
      const vp = await page.viewportSize();
      return { ok: true, viewport: vp };
    }
    case 'SET_VIEWPORT': {
      const { size } = payload || {};
      if (!size || typeof size.width !== 'number' || typeof size.height !== 'number') {
        throw new Error('Invalid viewport size');
      }
      await page.setViewportSize({ width: size.width, height: size.height });
      return { ok: true };
    }
    case 'MOUSE_MOVE': {
      const { x, y } = payload;
      await page.mouse.move(x, y);
      return { ok: true };
    }
    case 'MOUSE_CLICK': {
      const { x, y, button = 'left', clickCount = 1 } = payload;
      await page.mouse.click(x, y, { button, clickCount });
      return { ok: true };
    }
    case 'KEY_PRESS': {
      const { key } = payload;
      await page.keyboard.press(key);
      return { ok: true };
    }
    case 'TYPE_TEXT': {
      const { text, delay = 100 } = payload;
      await page.keyboard.type(text, { delay });
      return { ok: true };
    }
    case 'SCROLL_VIEWPORT': {
      const { dx = 0, dy = 0 } = payload;
      await page.evaluate(({ dx: mdx, dy: mdy }) => {
        window.scrollBy(mdx, mdy);
      }, { dx, dy });
      return { ok: true };
    }
    case 'ADD_INIT_SCRIPT': {
      const { script = '', fn = '', path: scriptPath = '' } = payload || {};
      if (scriptPath) {
        await context.addInitScript?.({ path: scriptPath });
        await page.addInitScript?.({ path: scriptPath });
        return { ok: true };
      }
      if (fn) {
        const wrapped = `(${fn})(window);`;
        await context.addInitScript?.({ content: wrapped });
        await page.addInitScript?.({ content: wrapped });
        return { ok: true };
      }
      if (script) {
        await context.addInitScript?.({ content: script });
        await page.addInitScript?.({ content: script });
      }
      return { ok: true };
    }
    case 'URL': {
      const current = await page.url();
      return { ok: true, url: current };
    }
    default:
      throw new Error(`Unknown command ${command}`);
  }
}

async function main() {
  console.log('[agent] starting, id', AGENT_ID, 'origin', DEFAULT_REMOTE_ORIGIN);
  const ws = new WebSocket(WS_URL, {
    headers: {
      'X-Nerova-Agent': AGENT_ID,
      Authorization: AGENT_TOKEN ? `Bearer ${AGENT_TOKEN}` : undefined
    }
  });

  ws.on('open', () => {
    console.log('[agent] connected to coordinator');
    ws.send(JSON.stringify({ type: 'HANDSHAKE', agentId: AGENT_ID }));
  });

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch (err) {
      console.error('[agent] bad json', err);
      return;
    }

    if (msg.type === 'WELCOME') {
      agentIdAcknowledged = msg.agentId || agentIdAcknowledged;
      ws.send(JSON.stringify({ type: 'HANDSHAKE_ACK', agentId: agentIdAcknowledged || AGENT_ID }));
      return;
    }

    if (msg.type === 'COMMAND') {
      const { id, command, payload } = msg;
      try {
        const result = await handleCommand(command, payload);
        ws.send(JSON.stringify({ type: 'RESPONSE', id, ok: true, result }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'RESPONSE', id, ok: false, error: err?.message || String(err) }));
      }
      return;
    }

    if (msg.type === 'RESOLVE') {
      resolveCommand(msg.id, msg.payload);
      return;
    }
    if (msg.type === 'REJECT') {
      rejectCommand(msg.id, msg.error || 'error');
      return;
    }
  });

  ws.on('close', () => {
    console.log('[agent] connection closed');
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error('[agent] ws error', err);
    process.exit(1);
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'PING', ts: Date.now() }));
    }
  }, 10000);

  ws.once('close', () => clearInterval(heartbeat));
}

main().catch((err) => {
  console.error('[agent] fatal', err);
  process.exit(1);
});
