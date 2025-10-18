import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { chromium } from '@playwright/test';

const USER_DATA_ROOT = path.join(os.homedir(), '.nerovaagent');
const BROWSER_PROFILE = path.join(USER_DATA_ROOT, 'browser');
const DEFAULT_BRAIN_URL = process.env.NEROVA_BRAIN_URL || 'http://127.0.0.1:4000';
const MAX_STEPS = Number(process.env.NEROVA_MAX_STEPS || 10);
const MODE = 'browser';
const DEFAULT_CLICK_RADIUS = Number(process.env.AGENT_CLICK_RADIUS || 120);
const RUNS_ROOT = path.join(USER_DATA_ROOT, 'runs');

let sharedContext = null;
let sharedPage = null;
let warmExplicit = false;
let activeRunSession = null;

let pauseRequested = false;
let pauseAck = false;
let abortRequested = false;
let pauseGeneration = 0;
let pauseHandledGeneration = 0;
const pausedContextQueue = [];
const activeAbortControllers = new Set();
const pendingHistoryLines = [];
let suppressHistoryOutput = false;

class PauseInterrupt extends Error {
  constructor(stage, options = {}) {
    super(options.abort ? 'run_aborted' : 'pause_interrupt');
    this.code = options.abort ? 'run_aborted' : 'pause_interrupt';
    this.stage = stage;
    this.abort = options.abort === true;
  }
}

function registerAbortController(tag = 'fetch') {
  const controller = new AbortController();
  controller.__nerovaTag = tag;
  activeAbortControllers.add(controller);
  const cleanup = () => {
    activeAbortControllers.delete(controller);
  };
  controller.signal.addEventListener('abort', cleanup, { once: true });
  return { controller, cleanup };
}

function abortActiveControllers(reason = 'pause') {
  for (const controller of Array.from(activeAbortControllers)) {
    try {
      if (!controller.signal.aborted) {
        controller.__nerovaAbortReason = reason;
        controller.abort(reason);
      }
    } catch {}
  }
}

function isAbortError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  if (typeof error.code === 'string' && error.code.toUpperCase() === 'ABORT_ERR') return true;
  const message = error.message || '';
  return message.toLowerCase().includes('abort');
}

function emitHistoryLine(text) {
  if (!text) return;
  if (suppressHistoryOutput || pauseRequested || pauseGeneration > pauseHandledGeneration) {
    pendingHistoryLines.push(text);
    if (pendingHistoryLines.length > 200) {
      pendingHistoryLines.shift();
    }
    return;
  }
  console.log(text);
}

function shouldHardPause() {
  return pauseRequested || pauseGeneration > pauseHandledGeneration;
}

function ensureNotPaused(stage, { allowAbort = false } = {}) {
  if (allowAbort && abortRequested) {
    throw new PauseInterrupt(stage, { abort: true });
  }
  if (shouldHardPause()) {
    throw new PauseInterrupt(stage);
  }
}

function isPauseInterrupt(error) {
  if (!error) return false;
  if (error instanceof PauseInterrupt) return true;
  return error?.code === 'pause_interrupt';
}

export function requestPause() {
  pauseRequested = true;
  pauseAck = false;
  pauseGeneration += 1;
  abortActiveControllers('pause');
  suppressHistoryOutput = true;
}

export function abortRun() {
  abortRequested = true;
  pauseRequested = false;
  pauseAck = false;
  pausedContextQueue.length = 0;
  abortActiveControllers('abort_run');
  suppressHistoryOutput = true;
  pendingHistoryLines.length = 0;
}

export function supplyContext(text) {
  if (typeof text === 'string') {
    const trimmed = text.trim();
    if (trimmed) pausedContextQueue.push(trimmed);
  }
  pauseRequested = false;
  pauseAck = true;
  suppressHistoryOutput = false;
}

function consumeContext() {
  return pausedContextQueue.shift() || null;
}

function shouldAbort() {
  if (abortRequested) {
    abortRequested = false;
    return true;
  }
  return false;
}

async function ensureUserDataDir() {
  await fs.mkdir(BROWSER_PROFILE, { recursive: true }).catch(() => {});
  return BROWSER_PROFILE;
}


function formatRunId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function startRunSession(meta) {
  pauseRequested = false;
  pauseAck = false;
  abortRequested = false;
  pausedContextQueue.length = 0;
  pauseHandledGeneration = pauseGeneration;
  pendingHistoryLines.length = 0;
  suppressHistoryOutput = false;

  await fs.mkdir(RUNS_ROOT, { recursive: true });
  const startedAt = new Date();
  const id = formatRunId(startedAt);
  const dir = path.join(RUNS_ROOT, id);
  await fs.mkdir(dir, { recursive: true });
  const logPath = path.join(dir, 'run.log');

  const writeFile = async (filePath, data) => {
    await fs.writeFile(filePath, data);
  };

  const session = {
    id,
    dir,
    logPath,
    startedAt: startedAt.toISOString(),
    meta,
    currentStep: 0,
    async log(message) {
      const line = `[${new Date().toISOString()}] ${message}`;
      await fs.appendFile(logPath, `${line}\n`);
    },
    async writeJson(name, data) {
      const fileName = name.endsWith('.json') ? name : `${name}.json`;
      await writeFile(path.join(dir, fileName), JSON.stringify(data, null, 2));
      return fileName;
    },
    async writeStepJson(step, name, data) {
      const prefix = String(step).padStart(2, '0');
      const fileName = name.endsWith('.json') ? name : `${name}.json`;
      await writeFile(path.join(dir, `${prefix}_${fileName}`), JSON.stringify(data, null, 2));
      return `${prefix}_${fileName}`;
    },
    async writeStepBuffer(step, name, buffer) {
      const prefix = String(step).padStart(2, '0');
      const fileName = path.join(dir, `${prefix}_${name}`);
      await writeFile(fileName, buffer);
      return `${prefix}_${name}`;
    },
    async updateCompleteHistory(history) {
      await this.writeJson('complete-history', history);
    },
    async finish(status, extra = {}) {
      await this.log(`Run finished status=${status}`);
      await this.writeJson('summary', {
        status,
        finishedAt: new Date().toISOString(),
        ...extra
      });
    },
    async logWorkflow(event) {
      const payload = {
        timestamp: new Date().toISOString(),
        ...event
      };
      await fs.appendFile(path.join(dir, 'workflow.log'), `${JSON.stringify(payload)}\n`);
    }
  };

  await session.writeJson('meta', {
    ...meta,
    runId: id,
    startedAt: session.startedAt
  });

  await session.log(`Run started prompt="${meta.prompt}" brain=${meta.brainUrl}`);

  activeRunSession = session;
  return session;
}

function getActiveRunSession() {
  return activeRunSession;
}

async function endRunSession(status, extra = {}) {
  if (activeRunSession) {
    await activeRunSession.finish(status, extra);
    activeRunSession = null;
  }
  abortActiveControllers('run_complete');
  pendingHistoryLines.length = 0;
  suppressHistoryOutput = false;
  pauseHandledGeneration = pauseGeneration;
}

async function ensureContext({ headlessOverride } = {}) {
  if (sharedContext && !sharedContext.isClosed?.()) {
    const pages = sharedContext.pages();
    let current = pages.length ? pages[pages.length - 1] : null;
    if (!current) {
      current = sharedPage && !sharedPage.isClosed?.() ? sharedPage : await sharedContext.newPage();
    }
    sharedPage = current;
    return { context: sharedContext, page: current, created: false };
  }

  const headlessEnv = process.env.NEROVA_HEADLESS === '1';
  const headless = typeof headlessOverride === 'boolean' ? headlessOverride : headlessEnv;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt === 0) {
      await ensureUserDataDir();
    } else {
      await fs.rm(BROWSER_PROFILE, { recursive: true, force: true }).catch(() => {});
      await ensureUserDataDir();
    }
    try {
      await fs.rm(path.join(BROWSER_PROFILE, 'SingletonLock')).catch(() => {});
      await fs.rm(path.join(BROWSER_PROFILE, 'SingletonCookie')).catch(() => {});
      await fs.rm(path.join(BROWSER_PROFILE, 'SingletonSocket')).catch(() => {});
      await fs.rm(path.join(BROWSER_PROFILE, 'SingletonSocket.lock')).catch(() => {});
    } catch {}
    try {
      const context = await chromium.launchPersistentContext(BROWSER_PROFILE, {
        headless,
        viewport: { width: 1280, height: 720 },
        args: [
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows'
        ]
      });
      const pages = context.pages();
      const page = pages.length ? pages[pages.length - 1] : await context.newPage();
      sharedContext = context;
      sharedPage = page;
      return { context, page, created: true };
    } catch (err) {
      if (attempt === 1) throw err;
      // Clean profile and retry
    }
  }

  throw new Error('Failed to initialise Playwright context');
}

async function ensureActivePage(context) {
  try {
    const pages = context.pages();
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
    if (!pick) pick = await context.newPage();
    try { await pick.bringToFront(); } catch {}
    sharedPage = pick;
    return pick;
  } catch {
    const page = await context.newPage();
    sharedPage = page;
    return page;
  }
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function dedupeElements(elements = []) {
  const map = new Map();
  for (const element of elements) {
    if (!element) continue;
    const key = (() => {
      if (element.id) return `id:${element.id}`;
      if (Array.isArray(element.center) && element.center.length === 2) {
        const [x, y] = element.center;
        return `pos:${Math.round(x)}:${Math.round(y)}:${normalizeText(element.role)}:${normalizeText(element.name)}`;
      }
      return `name:${normalizeText(element.name)}:${normalizeText(element.role)}`;
    })();
    if (!map.has(key)) {
      map.set(key, element);
    }
  }
  return Array.from(map.values());
}

async function collectViewportElements(page, options = {}) {
  const params = {
    max: Math.max(10, Math.min(5000, Number(options.max) || 1000)),
    minSize: Math.max(4, Math.min(100, Number(options.minSize) || 8))
  };
  const elements = await page.evaluate(({ max, minSize }) => {
    const clamp = (val) => (Number.isFinite(val) ? Math.round(val) : 0);
    const collapseWhitespace = (text) => (text || '').toString().replace(/\s+/g, ' ').trim();
    const isVisible = (el) => {
      try {
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) return false;
        const rect = el.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return false;
        if (rect.bottom <= 0 || rect.right <= 0) return false;
        if (rect.left >= (window.innerWidth || 0) || rect.top >= (window.innerHeight || 0)) return false;
        return true;
      } catch {
        return false;
      }
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
      } catch {
        return 'generic';
      }
    };
    const computeEnabled = (el) => {
      try {
        if (el.disabled) return false;
        const aria = (el.getAttribute('aria-disabled') || '').trim().toLowerCase();
        if (aria === 'true') return false;
        return true;
      } catch {
        return true;
      }
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

    const viewW = Math.max(1, window.innerWidth || 0);
    const viewH = Math.max(1, window.innerHeight || 0);
    const maxArea = viewW * viewH * 1.5;
    const nodes = Array.from(document.querySelectorAll('*'));
    const items = [];
    for (const el of nodes) {
      try {
        const tagName = (el.tagName || '').toLowerCase();
        if (tagName === 'html' || tagName === 'head' || tagName === 'body') continue;
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < minSize && rect.height < minSize) continue;
        if ((rect.width * rect.height) > maxArea) continue;
        if (rect.width >= viewW * 0.95 && rect.height >= viewH * 0.95) continue;
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
        const aria = el.getAttribute('aria-label');
        const placeholder = el.getAttribute('placeholder');
        const value = (el.value || '').toString();
        const name = collapseWhitespace(((aria || '') || el.innerText || el.textContent || placeholder || value || '').slice(0, 400));
        const role = computeRole(el);
        const enabled = computeEnabled(el);
        const href = el.tagName && el.tagName.toLowerCase() === 'a' ? el.href || null : null;
        const selector = bestSelector(el);
        if (selector) {
          const lowerSelector = selector.toLowerCase();
          if (lowerSelector === 'html' || lowerSelector === 'head' || lowerSelector === 'body') continue;
          if (/html\s*>/.test(lowerSelector) || /body\s*>/.test(lowerSelector)) continue;
        }
        if (role === 'generic' && !href && !enabled) continue;
        if (!name && role === 'generic') continue;
        if (role === 'generic' && rect.width >= viewW * 0.8 && rect.height >= viewH * 0.8) continue;
        items.push({
          id: `${role}-${items.length}`,
          name,
          role,
          enabled,
          hit_state: hitState,
          center,
          rect: [clamp(rect.left), clamp(rect.top), clamp(rect.width), clamp(rect.height)],
          selector,
          href,
          className: (el.className && el.className.toString && el.className.toString()) || ''
        });
      } catch {}
      if (items.length >= max) break;
    }
    return items;
  }, params);
  return Array.isArray(elements) ? elements : [];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeAction(page, action = {}) {
  const label = action?.type ? `action_${action.type}` : 'action_unknown';
  ensureNotPaused(`${label}_start`, { allowAbort: true });
  switch (action.type) {
    case 'navigate':
      if (action.url) {
        ensureNotPaused(`${label}_pre`, { allowAbort: true });
        await page.goto(action.url, { waitUntil: 'load' });
        ensureNotPaused(`${label}_post`, { allowAbort: true });
      }
      break;
    case 'scroll': {
      const direction = action.direction === 'up' ? 'up' : 'down';
      const pages = Number(action.amount) || 1;
      ensureNotPaused(`${label}_pre`, { allowAbort: true });
      await page.evaluate(({ direction, pages }) => {
        const dir = direction === 'up' ? -1 : 1;
        const step = Math.max(200, Math.round((window.innerHeight || 800) * 0.8));
        for (let i = 0; i < pages; i += 1) {
          window.scrollBy({ top: dir * step, behavior: 'smooth' });
        }
      }, { direction, pages });
      ensureNotPaused(`${label}_post`, { allowAbort: true });
      break;
    }
    case 'click': {
      await page.bringToFront().catch(() => {});
      ensureNotPaused(`${label}_pre`, { allowAbort: true });
      if (Array.isArray(action.center) && action.center.length === 2) {
        const [x, y] = action.center.map((value) => Math.round(value));
        ensureNotPaused(`${label}_pre_click`, { allowAbort: true });
        await page.mouse.click(x, y, { button: 'left', clickCount: 1 });
        ensureNotPaused(`${label}_post_click`, { allowAbort: true });
      } else {
        console.warn('[nerovaagent] click action skipped (no coordinates)');
        break;
      }
      await delay(120);
      ensureNotPaused(`${label}_post_delay`, { allowAbort: true });
      if (action.target?.clear) {
        await page.evaluate(() => {
          try {
            const el = document.activeElement;
            if (!el) return;
            if ('value' in el) {
              el.value = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            } else if (el.isContentEditable) {
              el.textContent = '';
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
          } catch {}
        });
        ensureNotPaused(`${label}_post_clear`, { allowAbort: true });
        await delay(60);
        ensureNotPaused(`${label}_post_clear_delay`, { allowAbort: true });
      }
      if (typeof action.target?.content === 'string' && action.target.content.length) {
        for (const char of action.target.content) {
          ensureNotPaused(`${label}_typing`, { allowAbort: true });
          await page.keyboard.type(char, { delay: 120 });
        }
        ensureNotPaused(`${label}_typing_post`, { allowAbort: true });
        if (action.target.submit) {
          ensureNotPaused(`${label}_submit_pre`, { allowAbort: true });
          await page.keyboard.press('Enter');
          ensureNotPaused(`${label}_submit_post`, { allowAbort: true });
        }
      }
      break;
    }
    case 'back':
      ensureNotPaused(`${label}_pre`, { allowAbort: true });
      await page.goBack().catch(() => {});
      ensureNotPaused(`${label}_post`, { allowAbort: true });
      break;
    default:
      ensureNotPaused(`${label}_noop`, { allowAbort: true });
      break;
  }
}

async function postJson(url, body, options = {}) {
  const {
    signal: externalSignal = null,
    pauseSensitive = true,
    tag = 'fetch'
  } = options;
  let controller = null;
  let cleanup = () => {};
  let signal = externalSignal;
  if (!signal && pauseSensitive) {
    const registration = registerAbortController(tag);
    controller = registration.controller;
    cleanup = registration.cleanup;
    signal = controller.signal;
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const error = new Error(`HTTP ${response.status}: ${text}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (pauseSensitive && (controller?.signal?.aborted || (externalSignal && externalSignal.aborted) || isAbortError(error))) {
      const reason = controller?.signal?.reason || externalSignal?.reason || controller?.__nerovaAbortReason || null;
      if (reason === 'pause' || (pauseRequested && reason == null)) {
        throw new PauseInterrupt(tag || 'fetch');
      }
      if (reason === 'abort_run' || abortRequested) {
        throw new PauseInterrupt(tag || 'fetch', { abort: true });
      }
    }
    throw error;
  } finally {
    if (cleanup) cleanup();
  }
}

function filterByRadius(elements, center, radius = DEFAULT_CLICK_RADIUS) {
  if (!center || !Array.isArray(center) || center.length !== 2) {
    const list = Array.isArray(elements) ? elements : [];
    return list.slice(0, 200);
  }
  const [cx, cy] = center;
  const r = Number.isFinite(radius) ? radius : DEFAULT_CLICK_RADIUS;
  const within = (element) => {
    try {
      if (Array.isArray(element.center) && element.center.length === 2) {
        const d = Math.hypot(element.center[0] - cx, element.center[1] - cy);
        if (d <= r) return true;
      }
      if (Array.isArray(element.rect) && element.rect.length === 4) {
        const [left, top, width, height] = element.rect;
        const right = left + (width || 0);
        const bottom = top + (height || 0);
        if (cx >= left && cx <= right && cy >= top && cy <= bottom) return true;
        const dx = cx < left ? left - cx : cx > right ? cx - right : 0;
        const dy = cy < top ? top - cy : cy > bottom ? cy - bottom : 0;
        return Math.hypot(dx, dy) <= r;
      }
    } catch {}
    return false;
  };
  const filtered = (elements || []).filter(within);
  if (filtered.length) return filtered;
  const dist = (element) => {
    try {
      if (Array.isArray(element.center) && element.center.length === 2) {
        return Math.hypot(element.center[0] - cx, element.center[1] - cy);
      }
      if (Array.isArray(element.rect) && element.rect.length === 4) {
        const [left, top, width, height] = element.rect;
        const right = left + (width || 0);
        const bottom = top + (height || 0);
        const dx = cx < left ? left - cx : cx > right ? cx - right : 0;
        const dy = cy < top ? top - cy : cy > bottom ? cy - bottom : 0;
        return Math.hypot(dx, dy);
      }
    } catch {}
    return Number.POSITIVE_INFINITY;
  };
  return (elements || [])
    .slice()
    .sort((a, b) => dist(a) - dist(b))
    .slice(0, 20);
}

async function resolveClickTarget({
  page,
  decision,
  devicePixelRatio = 1,
  screenshot,
  screenshotPath = null,
  prompt,
  brainUrl,
  sessionId = null,
  assistantKey,
  assistantId,
  runContext = null,
  step = 0,
  pauseGate = null
}) {
  const waitIfPaused = async (stage) => {
    if (typeof pauseGate !== 'function') {
      return { acknowledged: true, resumed: false };
    }
    const outcome = await pauseGate(stage, step);
    if (outcome && typeof outcome.acknowledged === 'boolean') {
      return outcome;
    }
    return {
      acknowledged: Boolean(outcome),
      resumed: false
    };
  };
  const hints = decision?.target?.hints || {};
  const logWorkflow = async (event) => {
    if (runContext?.logWorkflow) {
      try {
        await runContext.logWorkflow(event);
      } catch {}
    }
  };
  const center = Array.isArray(decision?.target?.center) && decision.target.center.length === 2
    ? decision.target.center.map((value) => {
        const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
        return value / ratio;
      })
    : null;
  const rawRadius = Number(decision?.target?.radius);
  const safeDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const radius = Number.isFinite(rawRadius)
    ? rawRadius / safeDpr
    : DEFAULT_CLICK_RADIUS;
  const collectGate = await waitIfPaused('step3_collect');
  if (!collectGate.acknowledged) {
    return { status: 'aborted' };
  }
  if (collectGate.resumed) {
    return { status: 'retry' };
  }
  const allElementsRaw = await collectViewportElements(page, { max: 1500 });
  const allElements = dedupeElements(allElementsRaw);
  await logWorkflow({
    stage: 'step3_hittables',
    step,
    count: allElements.length,
    sample: allElements.slice(0, 5).map((item) => ({
      id: item.id || null,
      name: item.name,
      role: item.role,
      center: item.center,
      hit: item.hit_state
    }))
  });
  if (runContext) {
    await runContext.writeStepJson(step, 'step3-hittables', allElements.slice(0, 200));
  }
  const candidates = filterByRadius(allElements, center, radius);
  await logWorkflow({
    stage: 'step3_radius',
    step,
    candidateCount: candidates.length,
    center,
    radius
  });
  if (candidates.length) {
    if (runContext) {
      await runContext.writeStepJson(step, 'step3-radius', {
        center,
        radius,
        sample: candidates.slice(0, 50)
      });
    }
  }
  const hittableCandidates = candidates.filter((element) => element?.hit_state === 'hittable');
  let preferredPool = hittableCandidates.length ? [...hittableCandidates] : [...candidates];
  const expectedRoles = new Set();
  if (decision?.target?.role) expectedRoles.add(decision.target.role);
  if (Array.isArray(hints.roles)) {
    for (const role of hints.roles) {
      if (role) expectedRoles.add(role);
    }
  }
  if (expectedRoles.size) {
    const roleFiltered = preferredPool.filter((element) => expectedRoles.has(element?.role));
    if (roleFiltered.length) {
      preferredPool = roleFiltered;
    }
  }
  const exactHints = Array.isArray(hints.text_exact) ? hints.text_exact.map(normalizeText).filter(Boolean) : [];
  let exact = null;
  if (exactHints.length) {
    const exactPool = preferredPool.filter((element) => exactHints.includes(normalizeText(element?.name)));
    const pool = exactPool.length ? exactPool : [];
    if (pool.length) {
      exact = pool.reduce((best, current) => {
        if (!best) return current;
        if (center && Array.isArray(current.center) && current.center.length === 2) {
          const bestDist = Math.hypot(best.center[0] - center[0], best.center[1] - center[1]);
          const curDist = Math.hypot(current.center[0] - center[0], current.center[1] - center[1]);
          return curDist < bestDist ? current : best;
        }
        return best;
      }, pool[0]);
    }
  }

  if (exact) {
    const centerPoint = Array.isArray(exact.center) && exact.center.length === 2
      ? exact.center
      : Array.isArray(exact.rect) && exact.rect.length === 4
        ? [exact.rect[0] + (exact.rect[2] || 0) / 2, exact.rect[1] + (exact.rect[3] || 0) / 2]
        : [0, 0];
    await logWorkflow({
      stage: 'step3_exact_match',
      step,
      target: {
        name: exact.name,
        role: exact.role,
        center: centerPoint,
        id: exact.id || null
      }
    });
    return {
      status: 'ok',
      source: 'exact',
      element: exact,
      center: centerPoint,
      debug: {
        hints,
        center,
        radius,
        elements: allElements.slice(0, 50),
        exactCandidate: exact
      }
    };
  }

  const tryAssistant = async (pool) => {
    if (!pool.length) return null;
    const assistantGate = await waitIfPaused('assistant_pre_request');
    if (!assistantGate.acknowledged) {
      return { status: 'aborted' };
    }
    if (assistantGate.resumed) {
      return { status: 'retry' };
    }
    const assistantPayload = {
      mode: MODE,
      prompt,
      target: decision?.target || null,
      elements: pool.slice(0, 12),
      screenshot: `data:image/png;base64,${screenshot}`,
      sessionId,
      assistantKey,
      assistantId
    };
    await logWorkflow({
      stage: 'assistant_request',
      step,
      target: decision?.target || null,
      candidateCount: pool.length,
      sessionId,
      hints
    });
    if (runContext) {
      const assistantLogPayload = {
        ...assistantPayload,
        screenshot: screenshotPath ? `./${screenshotPath}` : 'inline'
      };
      if (assistantLogPayload.assistantKey) assistantLogPayload.assistantKey = '***';
      await runContext.writeStepJson(step, 'assistant-request', assistantLogPayload);
    }
    try {
      let response;
      try {
        response = await postJson(`${brainUrl}/v1/brain/assistant`, assistantPayload, { tag: 'assistant' });
      } catch (error) {
        if (isPauseInterrupt(error)) {
          if (error.abort) {
            return { status: 'aborted' };
          }
          await logWorkflow({
            stage: 'assistant_pause_interrupt',
            step,
            sessionId
          });
          const resumedGate = await waitIfPaused('assistant_pause_interrupt');
          if (!resumedGate.acknowledged) {
            return { status: 'aborted' };
          }
          return { status: 'retry' };
        }
        await logWorkflow({
          stage: 'assistant_error',
          step,
          sessionId,
          error: error?.message || String(error)
        });
        throw error;
      }
      const parsed = response?.assistant?.parsed || response?.assistant || null;
      const assistantResponseGate = await waitIfPaused('assistant_post_response');
      if (!assistantResponseGate.acknowledged) {
        return { status: 'aborted' };
      }
      if (assistantResponseGate.resumed) {
        return { status: 'retry' };
      }
      if (
        parsed &&
        (parsed.action === 'click' || parsed.action === 'accept') &&
        Array.isArray(parsed.center) && parsed.center.length === 2 &&
        typeof parsed.confidence === 'number' && parsed.confidence >= 0.6
      ) {
        const element = pool.find((el) => el?.id === parsed.candidate_id) || pool[0] || null;
        if (runContext) {
          await runContext.writeStepJson(step, 'assistant-response', response.assistant || {});
        }
        await logWorkflow({
          stage: 'assistant_response',
          step,
          sessionId,
          assistant: parsed
        });
        return {
          status: 'assistant',
          source: 'assistant',
          element,
          center: parsed.center,
          assistant: response.assistant,
          debug: {
            hints,
            center,
            radius,
            elements: allElements.slice(0, 50),
            assistantRequest: pool.slice(0, 12)
          }
        };
      }
      if (runContext) {
        await runContext.writeStepJson(step, 'assistant-response', response.assistant || {});
      }
      await logWorkflow({
        stage: 'assistant_response',
        step,
        sessionId,
        assistant: response.assistant || null
      });
      return {
        status: 'await_assistance',
        assistant: response.assistant,
        debug: {
          hints,
          center,
          radius,
          elements: allElements.slice(0, 50)
        }
      };
    } catch (error) {
      console.warn('[nerovaagent] assistant decision error:', error?.message || error);
      if (runContext) {
        await runContext.writeStepJson(step, 'assistant-error', {
          message: error?.message || String(error)
        });
      }
      return {
        status: 'assistant_error',
        error: error?.message || String(error),
        debug: {
          hints,
          center,
          radius,
          elements: allElements.slice(0, 50)
        }
      };
    }
  };

  if (preferredPool.length) {
    // We now rely on the backend assistant when an exact-match click is unavailable.
    let assistantResult = await tryAssistant(preferredPool);
    while (assistantResult?.status === 'retry') {
      assistantResult = await tryAssistant(preferredPool);
    }
    if (assistantResult?.status === 'assistant' || assistantResult?.status === 'aborted') {
      return assistantResult;
    }
    if (assistantResult) {
      emitHistoryLine(`[nerovaagent] assistant fallback status=${assistantResult.status || 'unknown'}`);
      if (assistantResult.status === 'await_assistance' || assistantResult.status === 'assistant_error') {
        return assistantResult;
      }
    }
  }

  let lastResort = await tryAssistant(allElements.slice(0, 12));
  while (lastResort?.status === 'retry') {
    lastResort = await tryAssistant(allElements.slice(0, 12));
  }
  if (lastResort) {
    if (lastResort.status !== 'assistant') {
      emitHistoryLine(`[nerovaagent] last-resort assistant status=${lastResort.status || 'unknown'}`);
    }
    return lastResort;
  }
  return {
    status: 'await_assistance',
    debug: {
      hints,
      center,
      radius,
      elements: allElements.slice(0, 50)
    }
  };
}

export async function warmPlaywright({ bootUrl = null, headlessOverride = false } = {}) {
  warmExplicit = true;
  const { context } = await ensureContext({ headlessOverride });
  const page = await ensureActivePage(context);
  if (bootUrl) {
    try {
      await page.goto(bootUrl, { waitUntil: 'load' });
    } catch (err) {
      console.warn(`[nerovaagent] boot navigation failed: ${err?.message || err}`);
    }
  }
  console.log('[nerovaagent] Playwright context ready.');
  return { context, page };
}

export async function runAgent({
  prompt,
  contextNotes = '',
  brainUrl = DEFAULT_BRAIN_URL,
  criticKey = null,
  assistantKey = null,
  assistantId = null,
  maxSteps = MAX_STEPS,
  bootUrl = null
}) {
  if (!prompt || !prompt.trim()) {
    throw new Error('prompt_required');
  }

  const basePrompt = prompt.trim();
  const initialContexts = [];
  if (typeof contextNotes === 'string') {
    const trimmed = contextNotes.trim();
    if (trimmed) initialContexts.push(trimmed);
  }
  let overrideContext = null;
  const collectContexts = () => {
    const contexts = [...initialContexts];
    if (typeof overrideContext === 'string' && overrideContext.trim()) {
      contexts.push(overrideContext.trim());
    }
    return contexts;
  };
  const buildPrompt = () => {
    const contexts = collectContexts();
    return contexts.length
      ? `${basePrompt}\n\nContext:\n${contexts.join('\n---\n')}`
      : basePrompt;
  };
  let effectivePrompt = buildPrompt();
  const syncOverrideFromDecision = (decision, stage) => {
    if (!decision) return;
    let updated = false;
    const keepFlag = decision.keep ?? decision.goal?.keep;
    if (Object.prototype.hasOwnProperty.call(decision.goal ?? {}, 'new_context')) {
      const raw = (decision.goal?.new_context ?? '').trim();
      if (!raw) {
        if (overrideContext !== null) {
          overrideContext = null;
          updated = true;
        }
      } else if (overrideContext !== raw) {
        overrideContext = raw;
        updated = true;
      }
    }
    if (keepFlag === false && overrideContext !== null) {
      overrideContext = null;
      updated = true;
    }
    if (updated) {
      effectivePrompt = buildPrompt();
      try {
        const contexts = collectContexts();
        runSession.logWorkflow({
          stage: 'context_override_update',
          step: runSession.currentStep || 0,
          source: stage,
          contextList: contexts
        });
      } catch {}
    }
  };

  const runSession = await startRunSession({
    prompt: basePrompt,
    contextNotes,
    brainUrl,
    bootUrl,
    maxSteps
  });

  await runSession.logWorkflow({
    stage: 'run_start',
    prompt: basePrompt,
    brainUrl,
    bootUrl,
    maxSteps
  });

  const normalizedBrainUrl = brainUrl.replace(/\/$/, '');

  const { context } = await ensureContext();
  let activePage = null;
  let captureFrame = null;
  let sessionId = null;

  const waitForPauseAcknowledgement = async () => {
    if (!pauseRequested) return true;
    pauseAck = false;
    while (!pauseAck) {
      if (shouldAbort()) return false;
      await delay(120);
    }
    return true;
  };
  const pauseBarrier = async (stage, step = null) => {
    const generation = pauseGeneration;
    const needsHandling = pauseRequested || generation > pauseHandledGeneration;
    if (!needsHandling) {
      return { acknowledged: true, resumed: false };
    }
    const barrierMeta = {
      stage: 'pause_barrier',
      barrierStage: stage,
      step,
      generation
    };
    await runSession.log(`pause barrier stage=${stage}${step != null ? ` step=${step}` : ''} generation=${generation}`);
    await runSession.logWorkflow({ ...barrierMeta, state: pauseRequested ? 'waiting' : 'resuming' });
    if (!pauseAck) {
      const acknowledged = await waitForPauseAcknowledgement();
      if (!acknowledged) {
        await runSession.logWorkflow({ ...barrierMeta, state: 'aborted' });
        return { acknowledged: false, resumed: false };
      }
    }
    pauseHandledGeneration = generation;
    if (!suppressHistoryOutput && pendingHistoryLines.length) {
      while (pendingHistoryLines.length) {
        const line = pendingHistoryLines.shift();
        if (line) console.log(line);
      }
    }
    await runSession.logWorkflow({ ...barrierMeta, state: 'resumed' });
    return { acknowledged: true, resumed: true };
  };
  let iterations = 0;
  let completeHistory = [];
  let status = 'in_progress';
  let runError = null;
  try {
    activePage = await ensureActivePage(context);
    if (bootUrl) {
      await activePage.goto(bootUrl, { waitUntil: 'load' }).catch(() => {});
      await delay(800);
    }

    captureFrame = async (step, imageName = 'critic.png') => {
      ensureNotPaused('capture_frame', { allowAbort: true });
      const buffer = await activePage.screenshot({ fullPage: false }).catch(() => null);
      if (!buffer) {
        throw new Error('screenshot_failed');
      }
      ensureNotPaused('capture_frame_post', { allowAbort: true });
      const pathName = await runSession.writeStepBuffer(step, imageName, buffer);
      let devicePixelRatio = 1;
      try {
        const ratio = await activePage.evaluate(() => window.devicePixelRatio || 1);
        if (Number.isFinite(ratio) && ratio > 0) {
          devicePixelRatio = ratio;
        }
      } catch {}
      return {
        screenshotB64: buffer.toString('base64'),
        screenshotPath: pathName,
        devicePixelRatio
      };
    };

    const runBootstrapPhase = async () => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await delay(200);

        if (shouldAbort()) {
          status = 'aborted';
          break;
        }

        const bootstrapCaptureGate = await pauseBarrier('bootstrap_pre_capture', attempt);
        if (!bootstrapCaptureGate.acknowledged) {
          status = 'aborted';
          break;
        }
        if (bootstrapCaptureGate.resumed) {
          attempt -= 1;
          continue;
        }

        const label = `bootstrap-${String(attempt).padStart(2, '0')}`;
        let screenshotResult;
        try {
          screenshotResult = await captureFrame(0, `${label}.png`);
        } catch (error) {
          if (isPauseInterrupt(error)) {
            if (error.abort) {
              status = 'aborted';
              break;
            }
            const resumedBarrier = await pauseBarrier(error.stage || 'bootstrap_capture_interrupt', attempt);
            if (!resumedBarrier.acknowledged) {
              status = 'aborted';
              break;
            }
            attempt -= 1;
            continue;
          }
          throw error;
        }
        const { screenshotB64, screenshotPath } = screenshotResult;
        const payload = {
          mode: MODE,
          prompt: effectivePrompt,
          screenshot: screenshotB64,
          sessionId,
          criticKey
        };
        await runSession.logWorkflow({
          stage: 'bootstrap_request',
          step: 0,
          attempt,
          label,
          sessionId,
          prompt: effectivePrompt,
          screenshotLength: screenshotB64.length
        });
        const logPayload = {
          ...payload,
          screenshot: `./${screenshotPath}`
        };
        if (logPayload.criticKey) logPayload.criticKey = '***';
        await runSession.writeStepJson(0, `${label}-input`, logPayload);

        await runSession.logWorkflow({
          stage: 'bootstrap_input_payload',
          step: 0,
          sessionId,
          payload: {
            ...payload,
            screenshot: `base64(${screenshotB64.length} chars)`
          }
        });

        const bootstrapRequestGate = await pauseBarrier('bootstrap_pre_request', attempt);
        if (!bootstrapRequestGate.acknowledged) {
          status = 'aborted';
          break;
        }
        if (bootstrapRequestGate.resumed) {
          attempt -= 1;
          continue;
        }

        let response;
        try {
          response = await postJson(`${normalizedBrainUrl}/v1/brain/bootstrap`, payload, { tag: 'bootstrap' });
        } catch (error) {
          if (isPauseInterrupt(error)) {
            if (error.abort) {
              status = 'aborted';
              break;
            }
            await runSession.logWorkflow({
              stage: 'bootstrap_pause_interrupt',
              step: 0,
              attempt,
              label,
              sessionId
            });
            const resumedBarrier = await pauseBarrier('bootstrap_pause_interrupt', attempt);
            if (!resumedBarrier.acknowledged) {
              status = 'aborted';
              break;
            }
            if (resumedBarrier.resumed) {
              attempt -= 1;
              continue;
            }
          }
          await runSession.logWorkflow({
            stage: 'bootstrap_error',
            step: 0,
            attempt,
            label,
            sessionId,
            error: error?.message || String(error)
          });
          throw error;
        }
        sessionId = response?.sessionId || sessionId;
        if (Array.isArray(response?.completeHistory)) {
          completeHistory = response.completeHistory;
        }
        syncOverrideFromDecision(response?.decision, 'bootstrap');

        const bootstrapResponseGate = await pauseBarrier('bootstrap_post_response', attempt);
        if (!bootstrapResponseGate.acknowledged) {
          status = 'aborted';
          break;
        }
        if (bootstrapResponseGate.resumed) {
          attempt -= 1;
          continue;
        }
        if (bootstrapResponseGate.resumed) {
          attempt -= 1;
          continue;
        }

        await runSession.updateCompleteHistory(completeHistory);
        await runSession.writeStepJson(0, `${label}-output`, response || {});
        const decision = response?.decision || null;
        await runSession.logWorkflow({
          stage: 'bootstrap_response',
          step: 0,
          attempt,
          label,
          sessionId,
          decision,
          completeHistory
        });
        await runSession.logWorkflow({
          stage: 'bootstrap_output_summary',
          step: 0,
          sessionId,
          action: decision?.action || null,
          url: decision?.url || null,
          reason: decision?.reason || null,
          decision,
          completeHistory
        });

        if (!decision) {
          await runSession.log('bootstrap: no decision, retrying');
          await delay(400);
          continue;
        }

        if (decision.action === 'resend') {
          await runSession.log('bootstrap requested resend');
          await delay(400);
          continue;
        }

        if (decision.action === 'navigate' && decision.url) {
          await runSession.log(`bootstrap navigate -> ${decision.url}`);
          try {
            await executeAction(activePage, {
              type: 'navigate',
              url: decision.url,
              reason: decision.reason || null
            });
          } catch (error) {
            if (isPauseInterrupt(error)) {
              if (error.abort) {
                status = 'aborted';
                break;
              }
              const resumedBarrier = await pauseBarrier(error.stage || 'bootstrap_action_navigate', attempt);
              if (!resumedBarrier.acknowledged) {
                status = 'aborted';
                break;
              }
              attempt -= 1;
              continue;
            }
            throw error;
          }
          await delay(800);
          const postNavigateGate = await pauseBarrier('bootstrap_post_navigate', attempt);
          if (!postNavigateGate.acknowledged) {
            status = 'aborted';
            break;
          }
          if (postNavigateGate.resumed) {
            attempt -= 1;
            continue;
          }
          break;
        }

        await runSession.log(`bootstrap action=${decision.action || 'proceed'}`);
        break;
      }
    };

    await runBootstrapPhase();
    if (status === 'aborted') {
      throw new Error('run_aborted');
    }

    try {
      while (iterations < maxSteps) {
        iterations += 1;
        runSession.currentStep = iterations;

        if (shouldAbort()) {
          status = 'aborted';
          break;
        }

        const loopEntryGate = await pauseBarrier('critic_loop_entry', iterations);
        if (!loopEntryGate.acknowledged) {
          status = 'aborted';
          break;
        }
        if (loopEntryGate.resumed) {
          iterations -= 1;
          runSession.currentStep = iterations;
          continue;
        }

        const contextAddition = consumeContext();
        if (contextAddition) {
          overrideContext = contextAddition.trim();
          effectivePrompt = buildPrompt();
          const contexts = collectContexts();
          await runSession.logWorkflow({
            stage: 'context_append',
            step: iterations,
            context: overrideContext,
            contextList: contexts,
            completeHistory,
            prompt: effectivePrompt
          });
        }

        await delay(200);

        const preCaptureGate = await pauseBarrier('critic_pre_capture', iterations);
        if (!preCaptureGate.acknowledged) {
          status = 'aborted';
          break;
        }
        if (preCaptureGate.resumed) {
          iterations -= 1;
          runSession.currentStep = iterations;
          continue;
        }

        let criticFrameResult;
        try {
          criticFrameResult = await captureFrame(iterations);
        } catch (error) {
          if (isPauseInterrupt(error)) {
            if (error.abort) {
              status = 'aborted';
              break;
            }
            const resumedBarrier = await pauseBarrier(error.stage || 'critic_capture_interrupt', iterations);
            if (!resumedBarrier.acknowledged) {
              status = 'aborted';
              break;
            }
            iterations -= 1;
            runSession.currentStep = iterations;
            continue;
          }
          throw error;
        }
        const { screenshotB64, screenshotPath, devicePixelRatio } = criticFrameResult;
        const criticPayload = {
          mode: MODE,
          prompt: effectivePrompt,
          screenshot: screenshotB64,
          sessionId,
          criticKey
        };
        const criticLogPayload = {
          ...criticPayload,
          screenshot: `./${screenshotPath}`
        };
        if (criticLogPayload.criticKey) criticLogPayload.criticKey = '***';
        await runSession.writeStepJson(iterations, 'critic-input', criticLogPayload);

        await runSession.logWorkflow({
          stage: 'critic_input_payload',
          step: iterations,
          sessionId,
          payload: {
            ...criticPayload,
            screenshot: `base64(${screenshotB64.length} chars)`
          }
        });
        await runSession.logWorkflow({
          stage: 'critic_request',
          step: iterations,
          sessionId,
          prompt: effectivePrompt,
          screenshotLength: screenshotB64.length
        });

        const preCriticRequestGate = await pauseBarrier('critic_pre_request', iterations);
        if (!preCriticRequestGate.acknowledged) {
          status = 'aborted';
          break;
        }
        if (preCriticRequestGate.resumed) {
          iterations -= 1;
          runSession.currentStep = iterations;
          continue;
        }

        let criticResponse;
        try {
          criticResponse = await postJson(`${normalizedBrainUrl}/v1/brain/critic`, criticPayload, { tag: 'critic' });
        } catch (error) {
          if (isPauseInterrupt(error)) {
            if (error.abort) {
              status = 'aborted';
              break;
            }
            await runSession.logWorkflow({
              stage: 'critic_pause_interrupt',
              step: iterations,
              sessionId
            });
            const resumedBarrier = await pauseBarrier('critic_pause_interrupt', iterations);
            if (!resumedBarrier.acknowledged) {
              status = 'aborted';
              break;
            }
            iterations -= 1;
            runSession.currentStep = iterations;
            continue;
          }
          await runSession.logWorkflow({
            stage: 'critic_error',
            step: iterations,
            sessionId,
            error: error?.message || String(error)
          });
          throw error;
        }
        const postCriticResponseGate = await pauseBarrier('critic_post_response', iterations);
        if (!postCriticResponseGate.acknowledged) {
          status = 'aborted';
          break;
        }
        if (postCriticResponseGate.resumed) {
          iterations -= 1;
          runSession.currentStep = iterations;
          continue;
        }

        sessionId = criticResponse?.sessionId || sessionId;
        if (Array.isArray(criticResponse?.completeHistory)) {
          completeHistory = criticResponse.completeHistory;
        }
        syncOverrideFromDecision(criticResponse?.decision, 'critic');
        await runSession.updateCompleteHistory(completeHistory);
        await runSession.writeStepJson(iterations, 'critic-output', criticResponse || {});
        const decision = criticResponse?.decision || null;
        const preHistoryGate = await pauseBarrier('critic_pre_history', iterations);
        if (!preHistoryGate.acknowledged) {
          status = 'aborted';
          break;
        }
        if (preHistoryGate.resumed) {
          iterations -= 1;
          runSession.currentStep = iterations;
          continue;
        }
        await runSession.logWorkflow({
          stage: 'critic_output_payload',
          step: iterations,
          sessionId,
          decision,
          completeHistory,
          raw: criticResponse?.critic?.raw || null,
          confidence: decision?.confidence ?? null
        });
        await runSession.logWorkflow({
          stage: 'critic_response',
          step: iterations,
          sessionId,
          decision,
          completeHistory
        });

        const decisionLabel = decision?.action || 'none';
        const reason = decision?.reason || decision?.summary || '';
        await runSession.log(`step ${iterations} action=${decisionLabel}${reason ? ` :: ${reason}` : ''}`);
        const historySummary = completeHistory.length ? completeHistory.join(' -> ') : '(none)';
        if (!historySummary || historySummary === '(none)') {
          emitHistoryLine('[nerovaagent] complete history: (none)');
        } else {
          const latest = completeHistory[completeHistory.length - 1];
          if (typeof latest === 'string' && latest.trim()) {
            emitHistoryLine(`[nerovaagent] + ${latest.trim()}`);
          } else {
            emitHistoryLine(`[nerovaagent] complete history: ${historySummary}`);
          }
        }

        if (!decision || !decision.action) {
          status = 'resend';
          await runSession.log('critic returned no action, resend');
          await runSession.logWorkflow({
            stage: 'critic_no_action',
            step: iterations
          });
          await delay(250);
          continue;
        }

        if (decision.action === 'stop') {
          status = 'stop';
          await runSession.log('stop requested by critic');
          await runSession.logWorkflow({
            stage: 'action_stop',
            step: iterations
          });
          break;
        }

        if (decision.action === 'resend') {
          status = 'resend';
          await runSession.log('critic requested resend');
          await runSession.logWorkflow({
            stage: 'action_resend',
            step: iterations
          });
          await delay(300);
          continue;
        }

        if (decision.action === 'navigate' && decision.url) {
          const navigateGate = await pauseBarrier('action_pre_navigate', iterations);
          if (!navigateGate.acknowledged) {
            status = 'aborted';
            break;
          }
          if (navigateGate.resumed) {
            iterations -= 1;
            runSession.currentStep = iterations;
            continue;
          }
          try {
            await executeAction(activePage, {
              type: 'navigate',
              url: decision.url,
              reason: decision.reason || null
            });
          } catch (error) {
            if (isPauseInterrupt(error)) {
              if (error.abort) {
                status = 'aborted';
                break;
              }
              const resumedBarrier = await pauseBarrier(error.stage || 'action_navigate_interrupt', iterations);
              if (!resumedBarrier.acknowledged) {
                status = 'aborted';
                break;
              }
              iterations -= 1;
              runSession.currentStep = iterations;
              continue;
            }
            throw error;
          }
          await runSession.log(`navigate -> ${decision.url}`);
          await runSession.logWorkflow({
            stage: 'action_navigate',
            step: iterations,
            url: decision.url,
            reason: decision.reason || null
          });
          status = 'continue';
          continue;
        }

        if (decision.action === 'scroll') {
          const scrollGate = await pauseBarrier('action_pre_scroll', iterations);
          if (!scrollGate.acknowledged) {
            status = 'aborted';
            break;
          }
          if (scrollGate.resumed) {
            iterations -= 1;
            runSession.currentStep = iterations;
            continue;
          }
          const dir = decision?.scroll?.direction === 'up' ? 'up' : 'down';
          try {
            await executeAction(activePage, {
              type: 'scroll',
              direction: dir,
              amount: decision?.scroll?.amount || decision?.scroll?.pages || null,
              reason: decision.reason || null
            });
          } catch (error) {
            if (isPauseInterrupt(error)) {
              if (error.abort) {
                status = 'aborted';
                break;
              }
              const resumedBarrier = await pauseBarrier(error.stage || 'action_scroll_interrupt', iterations);
              if (!resumedBarrier.acknowledged) {
                status = 'aborted';
                break;
              }
              iterations -= 1;
              runSession.currentStep = iterations;
              continue;
            }
            throw error;
          }
          await runSession.log(`scroll direction=${dir} amount=${decision?.scroll?.amount || decision?.scroll?.pages || ''}`);
          await runSession.logWorkflow({
            stage: 'action_scroll',
            step: iterations,
            direction: dir,
            amount: decision?.scroll?.amount || decision?.scroll?.pages || null
          });
          status = 'continue';
          continue;
        }

        if (decision.action === 'back') {
          const backGate = await pauseBarrier('action_pre_back', iterations);
          if (!backGate.acknowledged) {
            status = 'aborted';
            break;
          }
          if (backGate.resumed) {
            iterations -= 1;
            runSession.currentStep = iterations;
            continue;
          }
          try {
            await executeAction(activePage, { type: 'back' });
          } catch (error) {
            if (isPauseInterrupt(error)) {
              if (error.abort) {
                status = 'aborted';
                break;
              }
              const resumedBarrier = await pauseBarrier(error.stage || 'action_back_interrupt', iterations);
              if (!resumedBarrier.acknowledged) {
                status = 'aborted';
                break;
              }
              iterations -= 1;
              runSession.currentStep = iterations;
              continue;
            }
            throw error;
          }
          await runSession.log('back');
          await runSession.logWorkflow({
            stage: 'action_back',
            step: iterations
          });
          status = 'continue';
          continue;
        }

        if (decision.action === 'click_by_text_role' || decision.action === 'accept') {
          const resolveGate = await pauseBarrier('action_pre_resolve_click', iterations);
          if (!resolveGate.acknowledged) {
            status = 'aborted';
            break;
          }
          if (resolveGate.resumed) {
            iterations -= 1;
            runSession.currentStep = iterations;
            continue;
          }
          const selection = await resolveClickTarget({
            page: activePage,
            devicePixelRatio,
            decision,
            screenshot: screenshotB64,
            screenshotPath,
            prompt: effectivePrompt,
            brainUrl: normalizedBrainUrl,
            sessionId,
            assistantKey,
            assistantId,
            runContext: runSession,
            step: iterations,
            pauseGate: pauseBarrier
          });

          if (selection?.status === 'aborted') {
            status = 'aborted';
            break;
          }
          if (selection?.status === 'retry') {
            iterations -= 1;
            runSession.currentStep = iterations;
            continue;
          }

          if (selection.status === 'ok' || selection.status === 'assistant') {
            const target = {
              id: selection.element?.id || decision?.target?.id || null,
              name: selection.element?.name || decision?.target?.hints?.text_partial || null,
              role: selection.element?.role || decision?.target?.role || null,
              content: decision?.target?.content || null,
              clear: decision?.target?.clear || false,
              submit: decision?.target?.submit || false
            };
            await runSession.log(`click name=${target.name || 'unknown'} source=${selection.source || selection.status} center=${Array.isArray(selection.center) ? selection.center.join(',') : 'n/a'}`);
            await runSession.writeStepJson(iterations, 'click-selection', {
              target,
              selection
            });
            const clickGate = await pauseBarrier('action_pre_click', iterations);
            if (!clickGate.acknowledged) {
              status = 'aborted';
              break;
            }
            if (clickGate.resumed) {
              iterations -= 1;
              runSession.currentStep = iterations;
              continue;
            }
            try {
              await executeAction(activePage, {
                type: 'click',
                center: selection.center,
                target,
                source: selection.source || selection.status
              });
            } catch (error) {
              if (isPauseInterrupt(error)) {
                if (error.abort) {
                  status = 'aborted';
                  break;
                }
                const resumedBarrier = await pauseBarrier(error.stage || 'action_click_interrupt', iterations);
                if (!resumedBarrier.acknowledged) {
                  status = 'aborted';
                  break;
                }
                iterations -= 1;
                runSession.currentStep = iterations;
                continue;
              }
              throw error;
            }
            await runSession.logWorkflow({
              stage: 'action_click',
              step: iterations,
              target,
              source: selection.source || selection.status
            });
            status = 'continue';
            continue;
          }

          if (selection.status === 'await_assistance') {
            await runSession.log('awaiting additional assistance');
            await runSession.logWorkflow({
              stage: 'await_assistance',
              step: iterations
            });
            status = 'await_assistance';
            await delay(800);
            continue;
          }

          console.warn(`[nerovaagent] click target not resolved (${selection.status || 'unknown'}).`);
          await runSession.log(`click target unresolved status=${selection.status || 'unknown'}`);
          await runSession.logWorkflow({
            stage: 'click_unresolved',
            step: iterations,
            status: selection.status || 'unknown'
          });
          status = 'halt';
          break;
        }

        console.warn(`[nerovaagent] unsupported action ${decision.action}`);
        await runSession.log(`unsupported action ${decision.action}`);
        status = 'halt';
        break;
      }
    } catch (error) {
      runError = error;
      status = 'error';
      const message = error?.stack || error?.message || String(error);
      console.error('[nerovaagent] iteration loop failed:', message);
      await runSession.log(`error: ${message}`);
      throw error;
    }

    if (status === 'aborted') {
      const abortError = new Error('run_aborted');
      runError = abortError;
      throw abortError;
    }

    if (status !== 'stop') {
      await runSession.log(`run finished with status ${status}`);
    } else {
      await runSession.log(`run completed after ${iterations} iterations`);
    }

    return { iterations, status, completeHistory };
  } finally {
    const keepBrowser = process.env.NEROVA_KEEP_BROWSER === '1' || warmExplicit;
    if (!keepBrowser) {
      await context.close().catch(() => {});
      sharedContext = null;
      sharedPage = null;
    } else {
      sharedContext = context;
    }
    if (runSession) {
      await endRunSession(runError ? 'error' : status, runError ? { error: runError?.message || String(runError) } : {});
    }
  }
}

export async function shutdownContext() {
  if (sharedContext && !sharedContext.isClosed?.()) {
    try { await sharedContext.close(); } catch {}
  }
  sharedContext = null;
  sharedPage = null;
  warmExplicit = false;
}

export default {
  runAgent,
  warmPlaywright,
  shutdownContext
};
