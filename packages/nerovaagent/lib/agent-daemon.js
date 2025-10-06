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
  || 'http://ec2-3-92-220-237.compute-1.amazonaws.com:3333').trim();

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

async function ensureActivePage() {
  await ensureBrowser();
  try {
    const pages = browser.pages();
    let pick = pages[pages.length - 1];
    for (let i = pages.length - 1; i >= 0; i -= 1) {
      try {
        const url = await pages[i].url();
        if (url && !/^about:blank/.test(url)) {
          pick = pages[i];
          break;
        }
      } catch {}
    }
    if (pick) page = pick;
    try { await page.bringToFront?.(); } catch {}
  } catch {}
  if (!page) {
    const pages = browser.pages();
    page = pages.length ? pages[0] : await browser.newPage();
  }
  return page;
}

async function collectViewportHittables(options = {}) {
  const { max = 1000, minSize = 8 } = options || {};
  const activePage = await ensureActivePage();
  const params = {
    max: Math.max(10, Math.min(5000, Number(max) || 1000)),
    minSize: Math.max(4, Math.min(100, Number(minSize) || 8))
  };
  const main = await activePage.evaluate(({ max, minSize }) => {
    const clamp = (val) => Number.isFinite(val) ? Math.round(val) : 0;
    const collapseWhitespace = (text) => (text || '').toString().replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      try {
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        return rect.bottom > 0 && rect.right > 0 && rect.left < (window.innerWidth || 0) && rect.top < (window.innerHeight || 0);
      } catch { return false; }
    };
    const computeRole = (el) => {
      try {
        const aria = (el.getAttribute('role') || '').trim().toLowerCase();
        if (aria) return aria;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'a') return el.getAttribute('href') ? 'link' : 'generic';
        if (tag === 'button') return 'button';
        if (tag === 'input') {
          const type = (el.getAttribute('type') || '').toLowerCase();
          if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'range') return 'slider';
          return 'textbox';
        }
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'summary') return 'button';
        if (tag === 'option') return 'option';
        return 'generic';
      } catch { return 'generic'; }
    };
    const computeEnabled = (el) => {
      try {
        if (el.disabled) return false;
        const aria = (el.getAttribute('aria-disabled') || '').trim().toLowerCase();
        if (aria === 'true') return false;
        return true;
      } catch { return true; }
    };
    const bestSelector = (el) => {
      try {
        if (el.id) return `#${el.id}`;
        const dt = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
        if (dt) return `[data-testid="${dt.replace(/"/g, '\\"')}"]`;
        const aria = el.getAttribute('aria-label');
        if (aria) return `[aria-label="${aria.replace(/"/g, '\\"')}"]`;
        const parts = [];
        let cur = el;
        for (let depth = 0; depth < 3 && cur; depth += 1) {
          const tag = (cur.tagName || 'div').toLowerCase();
          const parent = cur.parentElement;
          if (!parent) {
            parts.unshift(tag);
            break;
          }
          const siblings = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
          const idx = siblings.indexOf(cur) + 1;
          parts.unshift(`${tag}:nth-of-type(${idx})`);
          cur = parent;
        }
        return parts.join('>') || (el.tagName || '').toLowerCase();
      } catch {
        return (el.tagName || '').toLowerCase();
      }
    };
    const items = [];
    const nodes = Array.from(document.querySelectorAll('*'));
    for (const el of nodes) {
      try {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < minSize && rect.height < minSize) continue;
        const center = [clamp(rect.left + rect.width / 2), clamp(rect.top + rect.height / 2)];
        const viewport = {
          left: rect.left,
          top: rect.top,
          right: rect.left + rect.width,
          bottom: rect.top + rect.height
        };
        const inViewport = viewport.right > 0 && viewport.bottom > 0 && viewport.left < (window.innerWidth || 0) && viewport.top < (window.innerHeight || 0);
        const elAtPoint = document.elementFromPoint(center[0], center[1]);
        const occluded = elAtPoint && elAtPoint !== el && !el.contains(elAtPoint);
        const hitState = inViewport ? (occluded ? 'occluded' : 'hittable') : 'offscreen_page';
        const name = collapseWhitespace((el.getAttribute('aria-label') || el.innerText || el.textContent || '').slice(0, 400));
        const role = computeRole(el);
        const enabled = computeEnabled(el);
        const href = el.tagName && el.tagName.toLowerCase() === 'a' ? el.href || null : null;
        const anchor = (() => {
          try {
            const anc = el.closest('a');
            return anc && anc.href ? anc.href : null;
          } catch { return null; }
        })();
        items.push({
          id: items.length ? `${role}-${items.length}` : `${role}-0`,
          name,
          role,
          enabled,
          hit_state: hitState,
          center,
          rect: [clamp(rect.left), clamp(rect.top), clamp(rect.width), clamp(rect.height)],
          selector: bestSelector(el),
          href,
          anchor,
          className: (el.className && el.className.toString && el.className.toString()) || ''
        });
      } catch {}
      if (items.length >= max) break;
    }
    return items;
  }, params);
  return Array.isArray(main) ? main : [];
}

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
    case 'WAIT_FOR_LOAD': {
      const { state = 'load', timeout = 5000 } = payload || {};
      await page.waitForLoadState(state, { timeout });
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
    case 'CLICK_VIEWPORT': {
      const { vx, vy, button = 'left', clickCount = 1 } = payload || {};
      if (!Number.isFinite(vx) || !Number.isFinite(vy)) throw new Error('invalid_coordinates');
      await ensureActivePage();
      await page.mouse.click(Math.round(vx), Math.round(vy), { button, clickCount });
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
    case 'SCROLL_UNIVERSAL': {
      const { direction = 'down' } = payload || {};
      const dir = direction === 'up' ? -1 : 1;
      const activePage = await ensureActivePage();
      const vp = activePage.viewportSize() || { width: 1280, height: 800 };
      const deltaPx = dir * Math.max(200, Math.round((vp.height || 800) * 0.8));
      await activePage.evaluate((delta) => {
        const clamp = (val, min, max) => Math.max(min, Math.min(max, val));
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const run = async () => {
          const se = document.scrollingElement || document.documentElement || document.body;
          if (se) {
            const before = se.scrollTop || 0;
            const maxTop = Math.max(0, (se.scrollHeight || 0) - (se.clientHeight || 0));
            const next = clamp(before + delta, 0, maxTop);
            if (next !== before) se.scrollTop = next;
            await wait(40);
          }
          const nodes = Array.from(document.querySelectorAll('*'));
          for (const el of nodes) {
            try {
              const style = getComputedStyle(el);
              const oy = (style.overflowY || '').toLowerCase();
              const ox = (style.overflowX || '').toLowerCase();
              const scrollable = (oy === 'auto' || oy === 'scroll' || oy === 'overlay') || (ox === 'auto' || ox === 'scroll' || ox === 'overlay');
              if (!scrollable) continue;
              if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) continue;
              const rect = el.getBoundingClientRect();
              if (rect.height <= 60) continue;
              if (rect.bottom < 30 || rect.top > (window.innerHeight || 0) - 30) continue;
              const before = el.scrollTop || 0;
              const maxTop = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
              const next = clamp(before + delta, 0, maxTop);
              if (next !== before) { el.scrollTop = next; await wait(12); }
            } catch {}
          }
        };
        return run();
      }, deltaPx);
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
    case 'CLEAR_ACTIVE_INPUT': {
      const { token = null } = payload || {};
      const cleared = await page.evaluate(() => {
        try {
          const el = document.activeElement;
          if (!el) return false;
          if ('value' in el) {
            const prev = el.value;
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return !!prev;
          }
          if (el.isContentEditable) {
            el.textContent = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }
          return false;
        } catch {
          return false;
        }
      });
      return { ok: true, cleared, token };
    }
    case 'PRESS_ENTER': {
      await page.keyboard.press('Enter');
      return { ok: true };
    }
    case 'GET_HITTABLES_VIEWPORT': {
      const { options = {} } = payload || {};
      const elements = await collectViewportHittables(options);
      return { ok: true, elements };
    }
    case 'GO_BACK': {
      const response = await page.goBack({ waitUntil: 'load' }).catch(() => null);
      return { ok: true, navigated: !!response };
    }
    case 'URL': {
      const current = await page.url();
      return { ok: true, url: current };
    }
    case 'GET_URL': {
      const current = await page.url();
      return { ok: true, url: current };
    }
    default:
      throw new Error(`Unknown command ${command}`);
  }
}

async function main() {
  console.log('[agent] starting, id', AGENT_ID, 'origin', DEFAULT_REMOTE_ORIGIN);
  const headers = { 'X-Nerova-Agent': AGENT_ID };
  if (AGENT_TOKEN) headers.Authorization = `Bearer ${AGENT_TOKEN}`;
  const ws = new WebSocket(WS_URL, { headers });

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
