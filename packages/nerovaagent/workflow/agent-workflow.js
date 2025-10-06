import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ensureAgentInitialized, command as agentCommand, assignRun as markAgentRun } from '../lib/remote-driver.js';
import { callCritic, callAssistantDecision, defaultAssistantKey } from '../lib/llm.js';
import {
  generateRunId,
  extractCompletes,
  filterByRadius,
  pickExactMatch,
  pickFuzzyMatch
} from '../lib/decision-helpers.js';

const DEFAULT_SCREENSHOT_TIMEOUT = Number(process.env.AGENT_SCREENSHOT_TIMEOUT_MS || 20000);
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 10);
const DEFAULT_CLICK_RADIUS = Number(process.env.AGENT_CLICK_RADIUS || 120);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, '..', '..');
const RUN_LOG_DIR = path.join(APP_ROOT, 'logs', 'runs');

async function captureSnapshot(agent) {
  const urlResult = await agentCommand('URL', null, { agent }).catch(() => null);
  const shotResult = await agentCommand('SCREENSHOT', { options: { fullPage: false } }, { agent, timeout: DEFAULT_SCREENSHOT_TIMEOUT });
  const screenshot = shotResult?.data || shotResult?.result?.data || null;
  if (!screenshot) {
    throw new Error('screenshot_missing');
  }
  return {
    screenshot,
    url: urlResult?.url || ''
  };
}


async function performClickByTextRole(decision, agent, context) {
  const hints = decision?.target?.hints || {};
  const center = Array.isArray(decision?.target?.center) && decision.target.center.length === 2
    ? decision.target.center
    : null;
  const elementsResponse = await agentCommand('GET_HITTABLES_VIEWPORT', { options: { minSize: 8, max: 2000 } }, { agent, timeout: 15000 });
  const elements = Array.isArray(elementsResponse?.elements) ? elementsResponse.elements : [];
  const exact = pickExactMatch(elements, hints, center);
  const pick = exact || pickFuzzyMatch(elements, hints, center);
  const limitedElements = elements.slice(0, 50);
  if (!pick) {
    const small = elements.slice(0, 10);
    try {
      const assistantResult = await callAssistantDecision({
        prompt: context.prompt,
        target: decision?.target || null,
        elements: small,
        screenshot: context.screenshot,
        openaiApiKey: context.assistantOpenAiKey,
        assistantId: context.assistantId
      });
      const parsed = assistantResult?.parsed || null;
      if (
        parsed &&
        (parsed.action === 'click' || parsed.action === 'accept') &&
        Array.isArray(parsed.center) && parsed.center.length === 2 &&
        typeof parsed.confidence === 'number' && parsed.confidence >= 0.6
      ) {
        const targetCenter = parsed.center;
        await agentCommand('CLICK_VIEWPORT', { vx: targetCenter[0], vy: targetCenter[1], button: 'left', clickCount: 1 }, { agent, timeout: 5000 });
        if (decision?.target?.content) {
          if (decision.target.clear === true) {
            await agentCommand('CLEAR_ACTIVE_INPUT', {}, { agent, timeout: 2000 }).catch(() => {});
          }
          await agentCommand('TYPE_TEXT', { text: decision.target.content, delay: 120 }, { agent, timeout: 5000 }).catch(() => {});
          if (decision.target.submit === true) {
            await agentCommand('PRESS_ENTER', null, { agent, timeout: 2000 }).catch(() => {});
          }
        }
        return {
          next: 'continue',
          clicked: {
            center: targetCenter,
            candidate_id: parsed.candidate_id || null,
            reason: parsed.reason || null,
            confidence: parsed.confidence,
            assistant: parsed
          },
          assistant: assistantResult,
          debug: {
            hints,
            center,
            elements: limitedElements,
            assistantRequest: small
          }
        };
      }
      return {
        next: 'await_assistance',
        reason: 'assistant_no_match',
        candidates: small,
        assistant: assistantResult,
        debug: {
          hints,
          center,
          elements: limitedElements,
          assistantRequest: small
        }
      };
    } catch (error) {
      return {
        next: 'await_assistance',
        reason: 'assistant_error',
        error: String(error?.message || error),
        candidates: small,
        debug: {
          hints,
          center,
          elements: limitedElements
        }
      };
    }
  }
  const targetCenter = Array.isArray(pick.center) && pick.center.length === 2
    ? pick.center
    : Array.isArray(pick.rect) && pick.rect.length === 4
      ? [pick.rect[0] + (pick.rect[2] || 0) / 2, pick.rect[1] + (pick.rect[3] || 0) / 2]
      : [0, 0];
  await agentCommand('CLICK_VIEWPORT', { vx: targetCenter[0], vy: targetCenter[1], button: 'left', clickCount: 1 }, { agent, timeout: 5000 });
  const content = typeof decision?.target?.content === 'string' ? decision.target.content : '';
  const shouldClear = decision?.target?.clear === true;
  if (content) {
    if (shouldClear) {
      await agentCommand('CLEAR_ACTIVE_INPUT', {}, { agent, timeout: 2000 }).catch(() => {});
    }
    await agentCommand('TYPE_TEXT', { text: content, delay: 120 }, { agent, timeout: 5000 }).catch(() => {});
    if (decision?.target?.submit === true) {
      await agentCommand('PRESS_ENTER', null, { agent, timeout: 2000 }).catch(() => {});
    }
  }
  return {
    next: 'continue',
    clicked: {
      id: pick.id,
      name: pick.name,
      role: pick.role,
      center: targetCenter,
      hit_state: pick.hit_state,
      content
    },
    assistant: null,
    exact: Boolean(exact),
    debug: {
      hints,
      center,
      elements: limitedElements,
      exactCandidate: exact || null,
      chosen: pick
    }
  };
}

async function performNavigate(decision, agent) {
  if (!decision?.url) {
    return { next: 'halt', reason: 'missing_url' };
  }
  await agentCommand('NAVIGATE', { url: decision.url, options: { waitUntil: 'load' } }, { agent, timeout: 20000 });
  return { next: 'continue', navigatedTo: decision.url };
}

async function performScroll(decision, agent) {
  const direction = decision?.scroll?.direction === 'up' ? 'up' : 'down';
  await agentCommand('SCROLL_UNIVERSAL', { direction }, { agent, timeout: 5000 }).catch(() => {});
  return { next: 'continue', direction };
}

async function performBack(agent) {
  await agentCommand('GO_BACK', null, { agent, timeout: 15000 }).catch(() => {});
  return { next: 'continue', action: 'back' };
}

export async function runAgentWorkflow({
  prompt,
  contextNotes = '',
  openaiApiKey = null,
  assistantOpenAiKey = null,
  assistantId = process.env.ASSISTANT_ID2 || null,
  onEvent = null
} = {}) {
  if (!prompt || !prompt.toString().trim()) {
    throw new Error('prompt_required');
  }
  const emit = (payload) => {
    if (typeof onEvent === 'function') {
      try {
        onEvent(payload);
      } catch {}
    }
  };
  const agent = await ensureAgentInitialized();
  const runId = generateRunId();
  markAgentRun(agent, runId);
  const timeline = [];
  let status = 'in_progress';
  let iterations = 0;
  let completeHistory = [];

  emit({ type: 'run_started', runId, prompt: prompt.toString(), contextNotes });
  try {
    const timeline = [];
    while (iterations < MAX_STEPS) {
      iterations += 1;
      const snapshot = await captureSnapshot(agent);
      const criticUserPayload = {
        goal: {
          original_prompt: prompt.toString(),
          new_context: contextNotes || ''
        },
        context: { current_url: snapshot.url, context_active: false, context_step: 0 },
        plan_window: { planned_step: null, next_steps: [] },
        complete_history: completeHistory
      };
      const critic = await callCritic({
        prompt: prompt.toString(),
        screenshot: snapshot.screenshot,
        currentUrl: snapshot.url,
        contextNotes: contextNotes || '',
        completeHistory,
        openaiApiKey
      });
      const decision = critic?.parsed || null;
      completeHistory = extractCompletes(decision, completeHistory);

      let stepResult = { next: 'halt', reason: 'no_action' };
      let assistant = null;
      if (decision && decision.action) {
        switch (decision.action) {
          case 'stop':
            status = 'completed';
            stepResult = { next: 'stop', summary: decision.summary || null };
            break;
          case 'resend':
            stepResult = { next: 'continue', reason: 'resend' };
            break;
          case 'navigate':
            stepResult = await performNavigate(decision, agent);
            break;
          case 'scroll':
            stepResult = await performScroll(decision, agent);
            break;
          case 'back':
            stepResult = await performBack(agent);
            break;
          case 'click_by_text_role':
            stepResult = await performClickByTextRole(decision, agent, {
              prompt: prompt.toString(),
              screenshot: snapshot.screenshot,
              assistantOpenAiKey: assistantOpenAiKey || defaultAssistantKey(),
              assistantId
            });
            assistant = stepResult?.assistant || null;
            if (stepResult && Object.prototype.hasOwnProperty.call(stepResult, 'assistant')) {
              delete stepResult.assistant;
            }
            break;
          case 'accept':
            stepResult = await performClickByTextRole(decision, agent, {
              prompt: prompt.toString(),
              screenshot: snapshot.screenshot,
              assistantOpenAiKey: assistantOpenAiKey || defaultAssistantKey(),
              assistantId
            });
            assistant = stepResult?.assistant || null;
            if (stepResult && Object.prototype.hasOwnProperty.call(stepResult, 'assistant')) {
              delete stepResult.assistant;
            }
            break;
          default:
            stepResult = { next: 'halt', reason: `unsupported_action_${decision.action}` };
            break;
        }
      }

      timeline.push({
        iteration: iterations,
        critic: {
          request: {
            system: critic.system,
            user: critic.user,
            screenshot: critic.screenshot,
            url: snapshot.url,
            contextNotes: contextNotes || ''
          },
          response: critic
        },
        decision,
        assistant,
        result: stepResult,
        debug: stepResult?.debug || null
      });

      emit({
        type: 'iteration',
        runId,
        iteration: iterations,
        critic: {
          request: {
            system: critic.system,
            user: critic.user,
            url: snapshot.url,
            contextNotes: contextNotes || ''
          },
          response: critic
        },
        decision,
        result: stepResult,
        assistant
      });

      if (stepResult.next === 'stop') {
        status = status === 'in_progress' ? 'completed' : status;
        break;
      }
      if (stepResult.next === 'halt' || stepResult.next === 'await_assistance') {
        status = stepResult.next;
        break;
      }
      // Continue loop for 'continue'
    }

    if (status === 'in_progress') {
      status = iterations >= MAX_STEPS ? 'max_iterations' : 'completed';
    }

    const runSummary = {
      ok: true,
      runId,
      status,
      iterations,
      agent: { id: agent.id },
      completeHistory,
      timeline
    };

    try {
      await fs.mkdir(RUN_LOG_DIR, { recursive: true });
      const logPath = path.join(RUN_LOG_DIR, `${runId}.json`);
      const logPayload = {
        runId,
        createdAt: new Date().toISOString(),
        prompt,
        contextNotes,
        status,
        iterations,
        agent: { id: agent.id },
        completeHistory,
        timeline
      };
      await fs.writeFile(logPath, JSON.stringify(logPayload, null, 2), 'utf8');
      emit({ type: 'run_completed', runId, status, iterations, logPath, summary: runSummary });
    } catch (err) {
      console.warn('[nerovaagent] failed to write run log', err?.message || err);
    }

    return runSummary;
  } finally {
    markAgentRun(agent, null);
  }
}

export default {
  runAgentWorkflow
};
