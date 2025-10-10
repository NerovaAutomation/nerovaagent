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

async function ensureUserDataDir() {
  await fs.mkdir(BROWSER_PROFILE, { recursive: true }).catch(() => {});
  return BROWSER_PROFILE;
}

let sharedContext = null;
let sharedPage = null;
let warmExplicit = false;

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

    const nodes = Array.from(document.querySelectorAll('*'));
    const items = [];
    for (const el of nodes) {
      try {
        const tagName = (el.tagName || '').toLowerCase();
        if (tagName === 'html' || tagName === 'head') continue;
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
        const selector = bestSelector(el);
        if (selector && (selector === 'html' || selector === 'head' || selector === 'body')) continue;
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
      const selector = action.target?.selector;
      const selectorUsable = selector && selector !== 'html' && selector !== 'body';
      if (selectorUsable) {
        try {
          await page.click(selector, { timeout: 2500, force: true });
          clicked = true;
          console.log(`[nerovaagent] click selector ${selector}`);
        } catch (err) {
          console.warn(`[nerovaagent] selector click failed (${selector}):`, err?.message || err);
        }
      }
      if (!clicked && Array.isArray(action.center) && action.center.length === 2) {
        const [x, y] = action.center.map((value) => Math.round(value));
        await page.mouse.click(x, y, { button: 'left', clickCount: 1 });
        clicked = true;
        console.log(`[nerovaagent] click coordinates (${x}, ${y})`);
      }
      if (!clicked) {
        console.warn('[nerovaagent] click action skipped (no selector or coordinates)');
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
  if (!center || !Array.isArray(center) || center.length !== 2) return elements || [];
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
  decision,
  elements = [],
  screenshot,
  prompt,
  brainUrl,
  assistantKey,
  assistantId
}) {
  const hints = decision?.target?.hints || {};
  const center = Array.isArray(decision?.target?.center) && decision.target.center.length === 2
    ? decision.target.center
    : null;
  const candidates = filterByRadius(elements, center);
  const hittableCandidates = candidates.filter((element) => element?.hit_state === 'hittable');
  const preferredPool = hittableCandidates.length ? hittableCandidates : candidates;
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
    return {
      status: 'ok',
      source: 'exact',
      element: exact,
      center: centerPoint,
      debug: {
        hints,
        center,
        elements: elements.slice(0, 50),
        exactCandidate: exact
      }
    };
  }

  if (preferredPool.length) {
    const fuzzyTerms = [];
    if (Array.isArray(hints.text_contains)) fuzzyTerms.push(...hints.text_contains);
    if (typeof hints.text_partial === 'string') fuzzyTerms.push(hints.text_partial);
    const normalized = fuzzyTerms.map(normalizeText).filter(Boolean);
    let pick = preferredPool[0];
    if (normalized.length) {
      const match = preferredPool.find((element) => {
        const name = normalizeText(element?.name);
        return normalized.some((term) => name.includes(term));
      });
      if (match) pick = match;
    }
    if (pick) {
      const centerPoint = Array.isArray(pick.center) && pick.center.length === 2
        ? pick.center
        : Array.isArray(pick.rect) && pick.rect.length === 4
          ? [pick.rect[0] + (pick.rect[2] || 0) / 2, pick.rect[1] + (pick.rect[3] || 0) / 2]
          : [0, 0];
      return {
        status: 'ok',
        source: 'fuzzy',
        element: pick,
        center: centerPoint,
        debug: {
          hints,
          center,
          elements: elements.slice(0, 50)
        }
      };
    }
  }

  const small = elements.slice(0, 12);
  const assistantPayload = {
    mode: MODE,
    prompt,
    target: decision?.target || null,
    elements: small,
    screenshot: `data:image/png;base64,${screenshot}`,
    assistantKey,
    assistantId
  };
  try {
    const response = await postJson(`${brainUrl}/v1/brain/assistant`, assistantPayload);
    const parsed = response?.assistant?.parsed || null;
    if (
      parsed &&
      (parsed.action === 'click' || parsed.action === 'accept') &&
      Array.isArray(parsed.center) && parsed.center.length === 2 &&
      typeof parsed.confidence === 'number' && parsed.confidence >= 0.6
    ) {
      return {
        status: 'assistant',
        source: 'assistant',
        element: small.find((el) => el?.id === parsed.candidate_id) || null,
        center: parsed.center,
        assistant: response.assistant,
        debug: {
          hints,
          center,
          elements: elements.slice(0, 50),
          assistantRequest: small
        }
      };
    }
    return {
      status: 'await_assistance',
      assistant: response.assistant,
      debug: {
        hints,
        center,
        elements: elements.slice(0, 50)
      }
    };
  } catch (error) {
    return {
      status: 'assistant_error',
      error: error?.message || String(error),
      debug: {
        hints,
        center,
        elements: elements.slice(0, 50)
      }
    };
  }
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

  const { context, page, created } = await ensureContext();
  try {
    const activePage = await ensureActivePage(context);
    if (bootUrl) {
      await activePage.goto(bootUrl, { waitUntil: 'load' }).catch(() => {});
    }

    let iterations = 0;
    let completeHistory = [];
    let status = 'in_progress';

    while (iterations < maxSteps) {
      iterations += 1;
      await delay(250);
      const screenshotBuffer = await activePage.screenshot({ fullPage: false }).catch(() => null);
      if (!screenshotBuffer) {
        throw new Error('screenshot_failed');
      }
      const screenshotB64 = screenshotBuffer.toString('base64');
      const elements = await collectViewportElements(activePage, { max: 1500 });
      let currentUrl = '';
      try {
        currentUrl = await activePage.url();
      } catch {}

      const criticPayload = {
        mode: MODE,
        prompt: prompt.trim(),
        contextNotes,
        screenshot: `data:image/png;base64,${screenshotB64}`,
        currentUrl,
        completeHistory,
        criticKey
      };

      const criticResponse = await postJson(`${brainUrl.replace(/\/$/, '')}/v1/brain/critic`, criticPayload);
      const decision = criticResponse?.decision || null;
      completeHistory = Array.isArray(criticResponse?.completeHistory)
        ? criticResponse.completeHistory
        : completeHistory;

      const decisionLabel = decision?.action || 'none';
      const reason = decision?.reason || decision?.summary || '';
      console.log(`[nerovaagent] step ${iterations} action=${decisionLabel}${reason ? ` :: ${reason}` : ''}`);

      if (!decision || !decision.action) {
        status = 'resend';
        await delay(250);
        continue;
      }

      if (decision.action === 'stop') {
        status = 'stop';
        break;
      }

      if (decision.action === 'resend') {
        status = 'resend';
        await delay(300);
        continue;
      }

      if (decision.action === 'navigate' && decision.url) {
        await executeAction(activePage, {
          type: 'navigate',
          url: decision.url,
          reason: decision.reason || null
        });
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
        status = 'continue';
        continue;
      }

      if (decision.action === 'back') {
        await executeAction(activePage, { type: 'back' });
        status = 'continue';
        continue;
      }

      if (decision.action === 'click_by_text_role' || decision.action === 'accept') {
       const selection = await resolveClickTarget({
         decision,
         elements,
         screenshot: screenshotB64,
         prompt: prompt.trim(),
         brainUrl: brainUrl.replace(/\/$/, ''),
         assistantKey,
         assistantId
       });

        if (selection.status === 'ok' || selection.status === 'assistant') {
          const target = {
            id: selection.element?.id || decision?.target?.id || null,
            name: selection.element?.name || decision?.target?.hints?.text_partial || null,
            role: selection.element?.role || decision?.target?.role || null,
            selector: selection.element?.selector || null,
            content: decision?.target?.content || null,
            clear: decision?.target?.clear || false,
            submit: decision?.target?.submit || false
          };
          console.log(`[nerovaagent] click target name=${target.name || 'unknown'} source=${selection.source || selection.status} selector=${target.selector || 'n/a'} center=${Array.isArray(selection.center) ? selection.center.join(',') : 'n/a'}`);
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
          status = 'await_assistance';
          await delay(800);
          continue;
        }

        console.warn(`[nerovaagent] click target not resolved (${selection.status || 'unknown'}).`);
        status = 'halt';
        break;
      }

      console.warn(`[nerovaagent] unsupported action ${decision.action}`);
      status = 'halt';
      break;
    }

    if (status !== 'stop') {
      console.warn(`[nerovaagent] run finished with status ${status}.`);
    } else {
      console.log(`[nerovaagent] run completed after ${iterations} iterations.`);
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
