import { generateRunId, extractCompletes, pickExactMatch, pickFuzzyMatch, filterByRadius } from './decision-helpers.js';

const DEFAULT_MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 10);
const DEFAULT_CLICK_RADIUS = Number(process.env.AGENT_CLICK_RADIUS || 120);

async function fetchSnapshot(client) {
  return client.request('/agent/snapshot', { method: 'POST' });
}

async function fetchHittables(client, options = {}) {
  return client.request('/agent/hittables', { method: 'POST', body: options });
}

async function executeCommand(client, payload) {
  return client.request('/agent/command', { method: 'POST', body: payload });
}

async function callCriticRemote(client, payload) {
  return client.request('/critic', { method: 'POST', body: payload });
}

async function callAssistantRemote(client, payload) {
  return client.request('/assistant/decision', { method: 'POST', body: payload });
}

function summarizeDecision(decision) {
  if (!decision || typeof decision !== 'object') return 'none';
  return decision.action || 'none';
}

export async function runCliWorkflow({
  client,
  prompt,
  contextNotes = '',
  criticKey = null,
  assistantKey = null,
  assistantId = null,
  maxSteps = DEFAULT_MAX_STEPS,
  log = console
} = {}) {
  if (!client) throw new Error('client_required');
  const normalizedPrompt = String(prompt || '').trim();
  if (!normalizedPrompt) throw new Error('prompt_required');

  const runId = generateRunId();
  const timeline = [];
  let completeHistory = [];
  let iterations = 0;
  let status = 'in_progress';

  while (iterations < maxSteps) {
    iterations += 1;
    const snapshot = await fetchSnapshot(client);
    const screenshot = snapshot?.screenshot;
    const currentUrl = snapshot?.url || '';

    const criticPayload = {
      prompt: normalizedPrompt,
      screenshot,
      currentUrl,
      contextNotes,
      openaiApiKey: criticKey,
      completeHistory
    };

    const criticResponse = await callCriticRemote(client, criticPayload);
    const decision = criticResponse?.parsed || null;
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
          iterations -= 1; // do not count resend as a full iteration
          continue;
        case 'navigate': {
          const targetUrl = String(decision.url || '').trim();
          if (targetUrl) {
            await executeCommand(client, { action: 'navigate', url: targetUrl });
            stepResult = { next: 'continue', action: 'navigate', url: targetUrl };
          }
          break;
        }
        case 'scroll': {
          const direction = decision.scroll?.direction === 'up' ? 'up' : 'down';
          await executeCommand(client, { action: 'scroll', direction });
          stepResult = { next: 'continue', action: 'scroll', direction };
          break;
        }
        case 'back': {
          await executeCommand(client, { action: 'back' });
          stepResult = { next: 'continue', action: 'back' };
          break;
        }
        case 'click_by_text_role':
        case 'accept': {
          const hints = decision?.target?.hints || {};
          const center = Array.isArray(decision?.target?.center) && decision.target.center.length === 2
            ? decision.target.center
            : null;

          const hittablesResponse = await fetchHittables(client, { max: 1500, minSize: 8 });
          const elements = Array.isArray(hittablesResponse?.elements) ? hittablesResponse.elements : [];

          const exact = pickExactMatch(elements, hints, center, DEFAULT_CLICK_RADIUS);
          const fuzzy = pickFuzzyMatch(elements, hints, center, DEFAULT_CLICK_RADIUS);
          const pick = exact || fuzzy || (filterByRadius(elements, center, DEFAULT_CLICK_RADIUS)[0] || null);

          if (pick && Array.isArray(pick.center) && pick.center.length === 2) {
            const commandPayload = {
              action: 'click',
              vx: pick.center[0],
              vy: pick.center[1]
            };
            if (decision?.target?.content) {
              commandPayload.text = decision.target.content;
              commandPayload.clear = decision.target.clear === true;
              commandPayload.submit = decision.target.submit === true;
            }
            await executeCommand(client, commandPayload);
            stepResult = {
              next: 'continue',
              action: 'click',
              target: {
                id: pick.id || null,
                name: pick.name || null,
                role: pick.role || null,
                center: pick.center
              }
            };
          } else {
            const assistantPayload = {
              prompt: normalizedPrompt,
              target: decision?.target || null,
              candidates: filterByRadius(elements, center, DEFAULT_CLICK_RADIUS).slice(0, 12),
              screenshot,
              openaiApiKey: assistantKey,
              assistantId
            };
            assistant = await callAssistantRemote(client, assistantPayload).catch(() => null);
            const parsed = assistant?.parsed || assistant;
            if (
              parsed &&
              (parsed.action === 'click' || parsed.action === 'accept') &&
              Array.isArray(parsed.center) && parsed.center.length === 2
            ) {
              await executeCommand(client, {
                action: 'click',
                vx: parsed.center[0],
                vy: parsed.center[1]
              });
              stepResult = {
                next: 'continue',
                action: 'click',
                assistant: parsed
              };
            } else if (parsed && parsed.action === 'scroll') {
              const direction = parsed.direction === 'up' ? 'up' : 'down';
              await executeCommand(client, { action: 'scroll', direction });
              stepResult = { next: 'continue', action: 'scroll', direction, assistant: parsed };
            } else {
              stepResult = { next: 'await_assistance', reason: 'no_click_candidate', assistant: parsed };
            }
          }
          break;
        }
        default:
          stepResult = { next: 'halt', reason: `unsupported_action_${decision.action}` };
          break;
      }
    }

    timeline.push({
      iteration: iterations,
      critic: criticResponse,
      decision,
      result: stepResult,
      assistant
    });

    log?.log?.(`[nerovaagent] step ${iterations} decision=${summarizeDecision(decision)} result=${stepResult.next}`);

    if (stepResult.next === 'stop') break;
    if (stepResult.next === 'halt' || stepResult.next === 'await_assistance') {
      status = stepResult.next;
      break;
    }
  }

  if (status === 'in_progress') {
    status = iterations >= maxSteps ? 'max_iterations' : 'completed';
  }

  return {
    ok: status === 'completed',
    runId,
    status,
    iterations,
    completeHistory,
    timeline
  };
}

export default {
  runCliWorkflow
};
