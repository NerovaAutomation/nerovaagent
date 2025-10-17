import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';

const TEST_CRITIC_KEY = [
  process.env.CRITIC_OPENAI_KEY,
  process.env.OPENAI_API_KEY,
  process.env.NEROVA_AGENT_CRITIC_KEY
].find((value) => value && value.trim()) || '';

const TEST_ASSISTANT_KEY = [
  process.env.RETRIEVER_OPENAI_KEY,
  process.env.NANO_OPENAI_KEY,
  process.env.NEROVA_AGENT_ASSISTANT_KEY,
  process.env.OPENAI_API_KEY
].find((value) => value && value.trim()) || '';

function resolveKey(explicit, fallback) {
  const value = (explicit || '').trim();
  if (value) return value;
  if (fallback && fallback.trim()) return fallback.trim();
  return null;
}

function buildCriticSystemPrompt() {
  return `SYSTEM (Screen-first Web Action Critic)

You are a natural-language-to-web action critic. The goal is stated by the user prompt. Make the best single decision NOW, based ONLY on what is visible in the current screenshot, to advance toward the final goal.

Strict rules:
- Output ONLY a single valid JSON object (no prose, no markdown, no code fences).
 - Allowed actions: accept | click_by_text_role | scroll | back | navigate | resend | stop (choose ONE).
 - Use action="resend" ONLY if the intended/expected candidate is not visible in the screenshot and the page appears to be still loading or an initial blank/transition frame; on resend the runtime will immediately retry the same prompt with a fresh screenshot of the same viewport.
- Prefer deterministic visible signals: text + role.
- Never return "accept" unless the chosen control is visibly present.
- For action="scroll" include: scroll { direction: "down" | "up", pages?: 1..3 }.
- Include a non-empty reason and a numeric confidence 0..1.
 - Include what has been completed this step under a top-level "complete" array (use [] if none).

Context override (active only when goal.new_context is non-empty):
- Treat goal.new_context as a temporary subgoal that overrides the original prompt.
- Include keep: true|false (true = more steps needed to finish the subgoal; false = subgoal finished). Do not return stop while new_context is active.

Universal schema (ALL ACTIONS):
- Required fields: action (string), reason (string), confidence (number), continue (boolean).
- Optional depending on action:
  - target (for click_by_text_role)
  - scroll { direction:"down"|"up", pages?:1..3 } (for scroll)
  - url (for navigate)
  - content (for typing after focus)
  - clear (boolean; delete all pre-existing text before typing)


Examples (non-click actions include continue):
{ "action":"scroll", "scroll": { "direction":"down", "pages":1 }, "reason":"…", "confidence":0.7, "continue": true }
{ "action":"back", "reason":"…", "confidence":0.6, "continue": true }
{ "action":"navigate", "url":"https://example.com/cart", "reason":"…", "confidence":0.8, "continue": true }

Output format for click actions (REQUIRED):
- Return exactly: { "action": "click_by_text_role", "target": { "id": "Step 2", "type": "click_by_candidates", "center": [vx, vy], "hints": { "text_exact": string[], "roles": string[], "text": string[] }, "content": optional string, "clear": optional boolean }, "reason": "…", "confidence": 0.0, "continue": true }
- target.center MUST be present (CSS viewport pixels).
- Use arrays for hints; do NOT use singular fields like "role" or a single "text_exact" string. If none, use empty arrays.
- Do NOT return type_in_text_role. If typing is needed after focusing an input, include "content".
 - If the intent requires replacing pre-existing text in an input, set target.clear=true (meaning: delete all text in the focused input before typing), then include the desired "content".

Objective:
- Make the best single decision in the current situation to advance toward the final goal from the user prompt.

Screen-first precedence:
- Always prioritize what is visible on the current screen.

Visual-first decision policy:
- Decide only from the screenshot (no hidden assumptions).
- If a visible control more directly advances the end goal, return click_by_text_role and include a full Step-2 replacement target with text_exact first (then fallbacks).
- Prefer direct on-screen goal-aligned controls over indirect paths. Only type/search when the needed entity/control is not visible.
- If nothing clearly aligns, return scroll (direction/pages). Do not click unrelated CTAs.
- When the page is a different variant than expected, pick the visible entry point whose text best matches the goal keywords.
- Never choose controls whose text contradicts the goal keywords.

Visibility constraint (MUST SEE ON SCREEN):
- Only return click_by_text_role when the replacement target is fully visible in the screenshot (not offscreen, not clipped, not clearly occluded).
- Edge-centering rule: If the chosen target is near the top/bottom edges (≈ <90px from top OR ≈ <120px from bottom), first return action="scroll" with scroll { direction: "up" or "down", pages: 1 }, keep the same target, then decide again.

Full-page scan discipline:
- Scan the ENTIRE screenshot (top, middle, bottom) before deciding; do not anchor on one region.
- Do NOT default to search if a goal-aligned entity/control is visible anywhere on screen.

Popup awareness:
- Detect blocking overlays/modals/popups/banners (e.g., cookie consent, newsletter modal, full-screen dialog). If they block the intended action, first dismiss/close them using click_by_text_role on visible controls like “Close”, “×”, “No thanks”, “Accept”. If non-blocking, ignore and proceed with the primary goal.

Navigation optimization:
- Prefer the most direct, on-screen link/button toward the goal (e.g., a deep link to the target page/tile) over generic home/dashboard links. If a deep link is visible and relevant, choose it now.
- If a chosen deep link fails to load correctly on the next turn (e.g., unexpected page or error), then fall back to a safer, more general navigation link.

Complete history awareness:
- You will receive recent complete_history (ordered). Treat each entry as DONE. Do not attempt to redo or re-verify them unless the page clearly reset.
- When choosing the next action, advance the next unmet milestone implied by the goal and complete_history. If complete_history contains a matching milestone (e.g., variant selected), prefer the next step (e.g., Add to cart) over re-selecting variants.

Stuck handling:
- If recent decisions have not produced any new "complete" items (no visible progress), change strategy immediately.
- Try a different viable on-screen control, reverse scroll direction, use back, or navigate to a better entry point. Do not loop re-checking the same milestone.

Goal-first rule:
- Choose the single action that most directly advances the prompt’s end goal NOW; avoid redundant actions (e.g., do not search for something already visible to click).`;
}

export function buildBootstrapSystemPrompt() {
  return `SYSTEM (URL Bootstrap Critic)

You are the URL Bootstrap Critic. Decide the single best initial URL to open NOW to advance toward the final goal.

Rules:
- Output ONLY a single JSON object (no prose, no markdown, no code fences).
- Allowed actions (choose ONE): navigate | proceed | resend
- If action=navigate: url must be HTTPS, canonical/official page (no shorteners). Remove tracking query unless required.
- If action=proceed: current page is already correct to start the task.
- If action=resend: the page appears in transition/blank; the runtime will retry this same prompt with a fresh screenshot.
- Include a short reason and numeric confidence 0..1.
- REQUIRED: include top-level complete (array). Use [] if nothing was completed; otherwise include one concise string that reflects the outcome, e.g., "navigated to https://example.com" for navigate, or "proceed" for proceed.`;
}

export async function callCritic({
  prompt,
  screenshot,
  currentUrl = '',
  contextNotes = '',
  completeHistory = [],
  openaiApiKey = null,
  model = process.env.CRITIC_MODEL || 'gpt-5',
  systemPrompt: systemPromptOverride = null,
  userPayload: explicitUserPayload = null,
  signal = null
}) {
  assert(prompt && prompt.trim(), 'prompt_required');
  assert(screenshot && screenshot.length > 10, 'screenshot_required');
  const apiKey = resolveKey(openaiApiKey, TEST_CRITIC_KEY);
  if (!apiKey) throw new Error('critic_api_key_missing');

  const systemPrompt = systemPromptOverride || buildCriticSystemPrompt();
  let userPayload = explicitUserPayload;
  if (!userPayload) {
    const contextActive = !!(contextNotes && contextNotes.trim());
    const plannedStep = {
      id: 'Step 2',
      type: 'click_by_candidates',
      hints: {},
      content: ''
    };
    userPayload = {
      goal: {
        original_prompt: prompt,
        new_context: contextActive ? contextNotes : ''
      },
      context: {
        current_url: currentUrl,
        context_active: contextActive,
        context_step: contextActive ? 0 : 0
      },
      plan_window: {
        planned_step: plannedStep,
        next_steps: []
      },
      complete_history: Array.isArray(completeHistory)
        ? completeHistory.slice(-20)
        : []
    };
  }

  const chosenModel = model || 'gpt-5';
  const body = {
    model: chosenModel,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: JSON.stringify(userPayload) },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot}` } }
        ]
      }
    ]
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: signal ?? undefined
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`critic_http_${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const raw = (data?.choices?.[0]?.message?.content || '').trim();
  let parsed = null;
  let normalized = raw;
  if (normalized.startsWith('```')) {
    normalized = normalized.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
  }
  try { parsed = JSON.parse(normalized); } catch {}
  return {
    ok: true,
    raw,
    parsed,
    screenshot: `data:image/png;base64,${screenshot}`,
    model: chosenModel,
    system: systemPrompt,
    user: userPayload
  };
}

export function defaultAssistantKey() {
  return resolveKey(null, TEST_ASSISTANT_KEY);
}

const STEP4_SYSTEM_PROMPT = `SYSTEM (Step 4 Output / Assistant 2 Decision)

You are the Action Disambiguator. Given the goal, current target hints, and a list of candidate UI elements (with role, text, selector, center, hit_state), decide the single best on-screen action NOW.

Rules:
- Output ONLY one JSON object. No prose, markdown, or code fences.
- If a click candidate is appropriate, return action="click" and the center coordinates [x, y] in viewport CSS pixels.
- Limit actions to: click | scroll | stop | unknown. Default to action="unknown" if confidence is low.
- Always include:
  - action
  - reason (<=160 chars)
  - confidence (0..1)
  - center when action="click" (array [x, y])
  - candidate_id referencing the chosen element's id when action="click".
- Prefer hittable elements; avoid occluded/offscreen unless no other option.
- Use the provided hints (exact text, text_contains, roles) to guide the choice.
- If nothing matches confidently, return action="unknown".
- Never invent coordinates; only use provided candidate data.
- If goal already satisfied, return action="stop" with a short summary.`;

export async function callAssistantDecision({
  prompt,
  target = null,
  elements = [],
  screenshot,
  openaiApiKey = null,
  assistantId = process.env.ASSISTANT_ID2 || null,
  pollTimeoutMs = 30000,
  signal = null
}) {
  if (!screenshot || screenshot.length < 20) {
    throw new Error('assistant_screenshot_required');
  }
  const apiKey = resolveKey(openaiApiKey, TEST_ASSISTANT_KEY);
  if (!apiKey) throw new Error('assistant_api_key_missing');

  const cleanScreenshot = (() => {
    const trimmed = screenshot.trim();
    if (trimmed.startsWith('data:image')) {
      const idx = trimmed.indexOf(',');
      return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
    }
    return trimmed;
  })();

  const payload = {
    goal: prompt || '',
    target: target || null,
    candidates: Array.isArray(elements) ? elements.slice(0, 12) : []
  };

  if (assistantId) {
    const buffer = Buffer.from(cleanScreenshot, 'base64');
    const form = new FormData();
    form.append('purpose', 'assistants');
    form.append('file', new Blob([buffer], { type: 'image/png' }), 'screenshot.png');

    const upload = await fetch('https://api.openai.com/v1/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: signal ?? undefined
    });
    if (!upload.ok) {
      const text = await upload.text().catch(() => '');
      throw new Error(`assistant_upload_${upload.status}: ${text}`);
    }
    const fileMeta = await upload.json();

    const threadResp = await fetch('https://api.openai.com/v1/threads', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({}),
      signal: signal ?? undefined
    });
    if (!threadResp.ok) {
      const text = await threadResp.text().catch(() => '');
      throw new Error(`assistant_thread_${threadResp.status}: ${text}`);
    }
    const thread = await threadResp.json();

    const messageResp = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({
        role: 'user',
        content: [
          { type: 'text', text: JSON.stringify(payload) },
          { type: 'image_file', image_file: { file_id: fileMeta.id } }
        ]
      }),
      signal: signal ?? undefined
    });
    if (!messageResp.ok) {
      const text = await messageResp.text().catch(() => '');
      throw new Error(`assistant_message_${messageResp.status}: ${text}`);
    }

    const runResp = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      },
      body: JSON.stringify({ assistant_id: assistantId }),
      signal: signal ?? undefined
    });
    if (!runResp.ok) {
      const text = await runResp.text().catch(() => '');
      throw new Error(`assistant_run_${runResp.status}: ${text}`);
    }
    let run = await runResp.json();
    const start = Date.now();
    while (run.status !== 'completed') {
      if (signal?.aborted) {
        throw new Error('assistant_poll_aborted');
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (signal?.aborted) {
        throw new Error('assistant_poll_aborted');
      }
      const poll = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Beta': 'assistants=v2'
        },
        signal: signal ?? undefined
      });
      if (!poll.ok) {
        const text = await poll.text().catch(() => '');
        throw new Error(`assistant_poll_${poll.status}: ${text}`);
      }
      run = await poll.json();
      if (Date.now() - start > pollTimeoutMs) {
        throw new Error('assistant_timeout');
      }
      if (['failed', 'cancelled', 'expired'].includes(run.status)) {
        throw new Error(`assistant_status_${run.status}`);
      }
    }

    if (signal?.aborted) {
      throw new Error('assistant_poll_aborted');
    }
    const messages = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v2'
      },
      signal: signal ?? undefined
    });
    if (!messages.ok) {
      const text = await messages.text().catch(() => '');
      throw new Error(`assistant_messages_${messages.status}: ${text}`);
    }
    const data = await messages.json();
    let raw = '';
    for (const message of data.data || []) {
      if (message.role === 'assistant' && Array.isArray(message.content)) {
        for (const part of message.content) {
          if ((part.type === 'text' || part.type === 'output_text') && part.text && part.text.value) {
            raw = part.text.value.trim();
            if (raw) break;
          }
        }
      }
      if (raw) break;
    }
    let parsed = null;
    let normalized = raw;
    if (normalized.startsWith('```')) {
      normalized = normalized.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
    }
    try { parsed = JSON.parse(normalized); } catch {}
    return { ok: true, raw, parsed, request: payload, model: process.env.ASSISTANT_MODEL || 'gpt-5-nano' };
  }

  // Fallback to chat completions if no assistantId provided
  const model = process.env.ASSISTANT_MODEL || 'gpt-5-nano';
  const body = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: STEP4_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: JSON.stringify(payload) },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${cleanScreenshot}` } }
        ]
      }
    ]
  };
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: signal ?? undefined
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`assistant_chat_${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const raw = (data?.choices?.[0]?.message?.content || '').trim();
  let parsed = null;
  let normalized = raw;
  if (normalized.startsWith('```')) {
    normalized = normalized.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
  }
  try { parsed = JSON.parse(normalized); } catch {}
  return { ok: true, raw, parsed, request: payload, model };
}

export default {
  callCritic,
  callAssistantDecision,
  defaultAssistantKey
};
