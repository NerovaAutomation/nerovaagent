import { callCritic, callAssistantDecision } from './llm.js';

const MODES = new Set(['browser']);

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

export async function runCritic({
  mode = 'browser',
  prompt,
  screenshot,
  currentUrl = '',
  contextNotes = '',
  completeHistory = [],
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

  const critic = await callCritic({
    prompt: prompt.trim(),
    screenshot: cleanScreenshot,
    currentUrl,
    contextNotes,
    completeHistory,
    openaiApiKey: criticKey,
    model
  });
  const decision = critic?.parsed || null;
  const history = extractCompletes(decision, completeHistory);

  return {
    ok: true,
    mode: normalizedMode,
    decision,
    critic,
    completeHistory: history
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
  runCritic,
  runAssistant,
  extractCompletes
};
