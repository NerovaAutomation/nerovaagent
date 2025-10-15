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

async function ensureUserDataDir() {
  await fs.mkdir(BROWSER_PROFILE, { recursive: true }).catch(() => {});
  return BROWSER_PROFILE;
}

let sharedContext = null;
let sharedPage = null;
let warmExplicit = false;
let activeRunSession = null;

function formatRunId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

async function startRunSession(meta) {
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
  switch (action.type) {
    case 'navigate':
      if (action.url) {
        await page.goto(action.url, { waitUntil: 'load' });
      }
      break;
    case 'scroll': {
      const direction = action.direction === 'up' ? 'up' : 'down';
      const pages = Number(action.amount) || 1;
      await page.evaluate(({ direction, pages }) => {
        const dir = direction === 'up' ? -1 : 1;
        const step = Math.max(200, Math.round((window.innerHeight || 800) * 0.8));
        for (let i = 0; i < pages; i += 1) {
          window.scrollBy({ top: dir * step, behavior: 'smooth' });
        }
      }, { direction, pages });
      break;
    }
    case 'click': {
      await page.bringToFront().catch(() => {});
      let clicked = false;
      if (Array.isArray(action.center) && action.center.length === 2) {
        try {
          const viewport = await page.viewportSize();
          console.log(`[nerovaagent] viewport=${viewport?.width || 'n/a'}x${viewport?.height || 'n/a'} center=${action.center.join(',')}`);
        } catch {}
        const [x, y] = action.center.map((value) => Math.round(value));
        await page.mouse.click(x, y, { button: 'left', clickCount: 1 });
        clicked = true;
        console.log(`[nerovaagent] click coordinates (${x}, ${y})`);
      } else {
        console.warn('[nerovaagent] click action skipped (no coordinates)');
        break;
      }
      await delay(120);
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
        await delay(60);
      }
      if (typeof action.target?.content === 'string' && action.target.content.length) {
        await page.keyboard.type(action.target.content, { delay: 120 });
        if (action.target.submit) {
          await page.keyboard.press('Enter');
        }
      }
      break;
    }
    case 'back':
      await page.goBack().catch(() => {});
      break;
    default:
      break;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const error = new Error(`HTTP ${response.status}: ${text}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
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
  step = 0
}) {
  const hints = decision?.target?.hints || {};
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
  console.log('[nerovaagent] target summary:', {
    type: decision?.target?.type || null,
    role: decision?.target?.role || null,
    hasCenter: !!center,
    hintExact: Array.isArray(hints.text_exact) ? hints.text_exact.length : 0,
    hintContains: Array.isArray(hints.text_contains) ? hints.text_contains.length : 0,
    hintRoles: Array.isArray(hints.roles) ? hints.roles.length : 0
  });
  if (center) {
    console.log(`[nerovaagent] decision target center=${center.join(',')} radius=${radius} dpr=${safeDpr}`);
  } else {
    console.log(`[nerovaagent] decision target has no center; using default radius=${radius} dpr=${safeDpr}`);
  }
  const allElementsRaw = await collectViewportElements(page, { max: 1500 });
  const allElements = dedupeElements(allElementsRaw);
  if (runContext) {
    await runContext.writeStepJson(step, 'step3-hittables', allElements.slice(0, 200));
  }
  console.log(`[nerovaagent] STEP3 hittables total=${allElements.length}`);
  const candidates = filterByRadius(allElements, center, radius);
  if (center) {
    console.log(`[nerovaagent] step3 radius center=${center.join(',')} radius=${radius} pool=${candidates.length}`);
  } else {
    console.log(`[nerovaagent] step3 radius center=none radius=${radius} pool=${candidates.length}`);
  }
  if (candidates.length) {
    console.log('[nerovaagent] step3 radius sample:', candidates.slice(0, 5).map((item) => ({
      id: item.id || null,
      name: item.name,
      role: item.role,
      center: item.center,
      rect: item.rect,
      hit: item.hit_state
    })));
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
  console.log(`[nerovaagent] resolveClickTarget candidates=${candidates.length} hittable=${hittableCandidates.length} roleFilter=${Array.from(expectedRoles).join(',') || 'none'}`);
  if (preferredPool.length) {
    console.log('[nerovaagent] top candidates:');
    for (const item of preferredPool.slice(0, 5)) {
      const rect = item.rect ? item.rect.join(',') : 'n/a';
      console.log(`  - name="${item.name || ''}" role=${item.role || ''} hit=${item.hit_state || ''} center=${Array.isArray(item.center) ? item.center.join(',') : 'n/a'} rect=${rect}`);
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
    console.log('[nerovaagent] exact match chosen:', { name: exact.name, role: exact.role, center: centerPoint, rect: exact.rect });
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
    console.log('[nerovaagent] assistant request candidates:', assistantPayload.elements.map((item) => ({
      id: item.id || null,
      name: item.name,
      role: item.role,
      center: item.center,
      hit: item.hit_state
    })));
    if (runContext) {
      const assistantLogPayload = {
        ...assistantPayload,
        screenshot: screenshotPath ? `./${screenshotPath}` : 'inline'
      };
      if (assistantLogPayload.assistantKey) assistantLogPayload.assistantKey = '***';
      await runContext.writeStepJson(step, 'assistant-request', assistantLogPayload);
    }
    try {
      const response = await postJson(`${brainUrl}/v1/brain/assistant`, assistantPayload);
      const parsed = response?.assistant?.parsed || response?.assistant || null;
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
      console.log('[nerovaagent] assistant response (non-click):', response.assistant);
      if (runContext) {
        await runContext.writeStepJson(step, 'assistant-response', response.assistant || {});
      }
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
    const assistantResult = await tryAssistant(preferredPool);
    if (assistantResult?.status === 'assistant') {
      return assistantResult;
    }
    if (assistantResult) {
      console.log(`[nerovaagent] assistant fallback status=${assistantResult.status || 'unknown'}`);
      if (assistantResult.status === 'await_assistance' || assistantResult.status === 'assistant_error') {
        return assistantResult;
      }
    }
  }

  const lastResort = await tryAssistant(allElements.slice(0, 12));
  if (lastResort) {
    if (lastResort.status !== 'assistant') {
      console.log(`[nerovaagent] last-resort assistant status=${lastResort.status || 'unknown'}`);
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
  const contextText = typeof contextNotes === 'string' ? contextNotes.trim() : '';
  const effectivePrompt = contextText
    ? `${basePrompt}\n\nContext:\n${contextText}`
    : basePrompt;

  const runSession = await startRunSession({
    prompt: basePrompt,
    contextNotes,
    brainUrl,
    bootUrl,
    maxSteps
  });

  const normalizedBrainUrl = brainUrl.replace(/\/$/, '');

  const { context } = await ensureContext();
  let activePage = null;
  let captureFrame = null;
  let sessionId = null;
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
      const buffer = await activePage.screenshot({ fullPage: false }).catch(() => null);
      if (!buffer) {
        throw new Error('screenshot_failed');
      }
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
        const label = `bootstrap-${String(attempt).padStart(2, '0')}`;
        const { screenshotB64, screenshotPath } = await captureFrame(0, `${label}.png`);
        const payload = {
          mode: MODE,
          prompt: effectivePrompt,
          screenshot: screenshotB64,
          sessionId,
          criticKey
        };
        const logPayload = {
          ...payload,
          screenshot: `./${screenshotPath}`
        };
        if (logPayload.criticKey) logPayload.criticKey = '***';
        await runSession.writeStepJson(0, `${label}-input`, logPayload);

        const consolePayload = {
          ...payload,
          screenshot: `base64(${screenshotB64.length} chars)`
        };
        if (consolePayload.criticKey) consolePayload.criticKey = '***';
        console.log('[nerovaagent] bootstrap input:', consolePayload);

        const response = await postJson(`${normalizedBrainUrl}/v1/brain/bootstrap`, payload);
        sessionId = response?.sessionId || sessionId;
        if (Array.isArray(response?.completeHistory)) {
          completeHistory = response.completeHistory;
        }
        await runSession.updateCompleteHistory(completeHistory);
        await runSession.writeStepJson(0, `${label}-output`, response || {});
        const decision = response?.decision || null;
        console.log('[nerovaagent] bootstrap output:', {
          action: decision?.action || null,
          reason: decision?.reason || null,
          url: decision?.url || null,
          sessionId,
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
          await executeAction(activePage, {
            type: 'navigate',
            url: decision.url,
            reason: decision.reason || null
          });
          await delay(800);
          break;
        }

        await runSession.log(`bootstrap action=${decision.action || 'proceed'}`);
        break;
      }
    };

    await runBootstrapPhase();

    try {
      while (iterations < maxSteps) {
        iterations += 1;
        runSession.currentStep = iterations;
        await delay(200);

        const { screenshotB64, screenshotPath, devicePixelRatio } = await captureFrame(iterations);
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

        const consolePayload = {
          ...criticPayload,
          screenshot: `base64(${screenshotB64.length} chars)`
        };
        if (consolePayload.criticKey) consolePayload.criticKey = '***';
        console.log('[nerovaagent] critic input:', consolePayload);

        const criticResponse = await postJson(`${normalizedBrainUrl}/v1/brain/critic`, criticPayload);
        sessionId = criticResponse?.sessionId || sessionId;
        if (Array.isArray(criticResponse?.completeHistory)) {
          completeHistory = criticResponse.completeHistory;
        }
        await runSession.updateCompleteHistory(completeHistory);
        await runSession.writeStepJson(iterations, 'critic-output', criticResponse || {});
        const decision = criticResponse?.decision || null;
        console.log('[nerovaagent] critic output:', {
          decision,
          completeHistory,
          sessionId,
          raw: criticResponse?.critic?.raw || null,
          confidence: decision?.confidence ?? null
        });

        const decisionLabel = decision?.action || 'none';
        const reason = decision?.reason || decision?.summary || '';
        await runSession.log(`step ${iterations} action=${decisionLabel}${reason ? ` :: ${reason}` : ''}`);
        console.log(`[nerovaagent] step ${iterations} action=${decisionLabel}${reason ? ` :: ${reason}` : ''}`);

        if (!decision || !decision.action) {
          status = 'resend';
          await runSession.log('critic returned no action, resend');
          await delay(250);
          continue;
        }

        if (decision.action === 'stop') {
          status = 'stop';
          await runSession.log('stop requested by critic');
          break;
        }

        if (decision.action === 'resend') {
          status = 'resend';
          await runSession.log('critic requested resend');
          await delay(300);
          continue;
        }

        if (decision.action === 'navigate' && decision.url) {
          await executeAction(activePage, {
            type: 'navigate',
            url: decision.url,
            reason: decision.reason || null
          });
          await runSession.log(`navigate -> ${decision.url}`);
          status = 'continue';
          continue;
        }

        if (decision.action === 'scroll') {
          const dir = decision?.scroll?.direction === 'up' ? 'up' : 'down';
          await executeAction(activePage, {
            type: 'scroll',
            direction: dir,
            amount: decision?.scroll?.amount || decision?.scroll?.pages || null,
            reason: decision.reason || null
          });
          await runSession.log(`scroll direction=${dir} amount=${decision?.scroll?.amount || decision?.scroll?.pages || ''}`);
          status = 'continue';
          continue;
        }

        if (decision.action === 'back') {
          await executeAction(activePage, { type: 'back' });
          await runSession.log('back');
          status = 'continue';
          continue;
        }

        if (decision.action === 'click_by_text_role' || decision.action === 'accept') {
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
            step: iterations
          });

          if (selection.status === 'ok' || selection.status === 'assistant') {
            const target = {
              id: selection.element?.id || decision?.target?.id || null,
              name: selection.element?.name || decision?.target?.hints?.text_partial || null,
              role: selection.element?.role || decision?.target?.role || null,
              content: decision?.target?.content || null,
              clear: decision?.target?.clear || false,
              submit: decision?.target?.submit || false
            };
            console.log(`[nerovaagent] click target name=${target.name || 'unknown'} source=${selection.source || selection.status} center=${Array.isArray(selection.center) ? selection.center.join(',') : 'n/a'}`);
            await runSession.log(`click name=${target.name || 'unknown'} source=${selection.source || selection.status} center=${Array.isArray(selection.center) ? selection.center.join(',') : 'n/a'}`);
            await runSession.writeStepJson(iterations, 'click-selection', {
              target,
              selection
            });
            await executeAction(activePage, {
              type: 'click',
              center: selection.center,
              target,
              source: selection.source || selection.status
            });
            status = 'continue';
            continue;
          }

          if (selection.status === 'await_assistance') {
            console.warn('[nerovaagent] backend awaiting additional assistance; pausing iteration.');
            await runSession.log('awaiting additional assistance');
            status = 'await_assistance';
            await delay(800);
            continue;
          }

          console.warn(`[nerovaagent] click target not resolved (${selection.status || 'unknown'}).`);
          await runSession.log(`click target unresolved status=${selection.status || 'unknown'}`);
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

    if (status !== 'stop') {
      console.warn(`[nerovaagent] run finished with status ${status}.`);
      await runSession.log(`run finished with status ${status}`);
    } else {
      console.log(`[nerovaagent] run completed after ${iterations} iterations.`);
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
