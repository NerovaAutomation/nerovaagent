import crypto from 'node:crypto';
import { callCritic, callAssistantDecision, buildBootstrapSystemPrompt } from './llm.js';

const MODES = new Set(['browser']);

const sessions = new Map();

function touchSession(session) {
  if (session) {
    session.updatedAt = Date.now();
  }
  return session;
}

function createSession(initial = {}) {
  const session = {
    id: crypto.randomUUID(),
    completeHistory: [],
    contextNotes: '',
    currentUrl: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...initial
  };
  sessions.set(session.id, session);
  return session;
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const session = sessions.get(sessionId) || null;
  return touchSession(session);
}

function ensureSession(sessionId) {
  const existing = getSession(sessionId);
  if (existing) return existing;
  return createSession();
}

function assertMode(mode) {
  const value = (mode || 'browser').toLowerCase();
  if (!MODES.has(value)) {
    const supported = Array.from(MODES).join(', ');
    throw new Error(`unsupported_mode_${value}. Supported modes: ${supported}`);
  }
  return value;
}

function sanitizeScreenshot(input) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('data:image')) {
    const idx = trimmed.indexOf(',');
    return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
  }
  return trimmed;
}

export function extractCompletes(decision, store = []) {
  if (!decision) return Array.isArray(store) ? [...store] : [];
  const current = Array.isArray(store) ? [...store] : [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const key = text.toLowerCase();
    if (!current.some((existing) => String(existing || '').toLowerCase() === key)) {
      current.push(text);
    }
  };
  if (Array.isArray(decision.complete)) {
    for (const entry of decision.complete) push(entry);
  } else if (typeof decision.complete === 'string') {
    push(decision.complete);
  }
  return current;
}

export async function runBootstrap({
  mode = 'browser',
  prompt,
  screenshot,
  sessionId = null,
  criticKey = null,
  model = undefined
}) {
  const normalizedMode = assertMode(mode);
  const cleanScreenshot = sanitizeScreenshot(screenshot);
  if (!prompt || !prompt.trim()) {
    throw new Error('prompt_required');
  }
  if (!cleanScreenshot) {
    throw new Error('screenshot_required');
  }

  const session = ensureSession(sessionId);
  const userPayload = {
    goal: {
      original_prompt: prompt.trim()
    },
    context: {
      current_url: session.currentUrl || ''
    },
    complete_history: Array.isArray(session.completeHistory)
      ? session.completeHistory.slice(-20)
      : []
  };

  const critic = await callCritic({
    prompt: prompt.trim(),
    screenshot: cleanScreenshot,
    openaiApiKey: criticKey,
    model,
    systemPrompt: buildBootstrapSystemPrompt(),
    userPayload
  });

  const decision = critic?.parsed || null;
  session.completeHistory = extractCompletes(decision, session.completeHistory);
  if (decision?.action === 'navigate' && typeof decision.url === 'string') {
    session.currentUrl = decision.url.trim();
  }

  return {
    ok: true,
    mode: normalizedMode,
    sessionId: session.id,
    decision,
    critic,
    completeHistory: session.completeHistory
  };
}

export async function runCritic({
  mode = 'browser',
  prompt,
  screenshot,
  sessionId = null,
  criticKey = null,
  model = undefined
}) {
  const normalizedMode = assertMode(mode);
  const cleanScreenshot = sanitizeScreenshot(screenshot);
  if (!prompt || !prompt.trim()) {
    throw new Error('prompt_required');
  }
  if (!cleanScreenshot) {
    throw new Error('screenshot_required');
  }

  const session = ensureSession(sessionId);

  const critic = await callCritic({
    prompt: prompt.trim(),
    screenshot: cleanScreenshot,
    currentUrl: session.currentUrl || '',
    contextNotes: session.contextNotes || '',
    completeHistory: session.completeHistory,
    openaiApiKey: criticKey,
    model
  });
  const decision = critic?.parsed || null;
  session.completeHistory = extractCompletes(decision, session.completeHistory);
  if (decision?.action === 'navigate' && typeof decision.url === 'string') {
    session.currentUrl = decision.url.trim();
  }

  return {
    ok: true,
    mode: normalizedMode,
    sessionId: session.id,
    decision,
    critic,
    completeHistory: session.completeHistory
  };
}

export async function runAssistant({
  mode = 'browser',
  prompt,
  target = null,
  elements = [],
  screenshot,
  assistantKey = null,
  assistantId = null,
  pollTimeoutMs = 30000
}) {
  const normalizedMode = assertMode(mode);
  const cleanScreenshot = sanitizeScreenshot(screenshot);
  if (!cleanScreenshot) {
    throw new Error('assistant_screenshot_required');
  }

  const payload = {
    prompt: prompt || '',
    target,
    elements,
    screenshot: cleanScreenshot,
    openaiApiKey: assistantKey,
    assistantId,
    pollTimeoutMs
  };
  const result = await callAssistantDecision(payload);
  return {
    ok: true,
    mode: normalizedMode,
    assistant: result
  };
}

export default {
  runBootstrap,
  runCritic,
  runAssistant,
  extractCompletes
};
