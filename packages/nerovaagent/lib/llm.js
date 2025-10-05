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
- For action=scroll, specify direction (up/down) and amount (small/medium/large).
- Include a concise reason (<= 140 characters) to justify the action referencing concrete on-screen elements.
- Always include a "complete" array (may be empty). Add milestones that are definitively finished (e.g., \"opened https://example.com\").
- Include "confidence" 0..1.
- If action is click_by_text_role, provide object: { role, text, fallback_text?, selector_hint?, reason }.
- If action is navigate, provide field "url" (absolute) and reason.
- If action is scroll, include direction and amount (small/medium/large).
- If action is back, reason must explain why the current page is incorrect or a dead-end.
- If action is stop, include final summary.
- If the screenshot shows blockers (cookie banner, modal, etc.), prioritize dismissing them first.

General guidance:
- Use what is visibly present; do not invent controls.
- Prefer the element that most directly advances the goal right now.
- If nothing useful is visible, return action="scroll" (down by default) or action="resend" if page is blank/loading.
- If you already completed the main goal, return action="stop" with a confirming summary.`;
}

export async function callCritic({
  prompt,
  screenshot,
  currentUrl = '',
  contextNotes = '',
  completeHistory = [],
  openaiApiKey = null,
  model = process.env.CRITIC_MODEL || 'gpt-5'
}) {
  assert(prompt && prompt.trim(), 'prompt_required');
  assert(screenshot && screenshot.length > 10, 'screenshot_required');
  const apiKey = resolveKey(openaiApiKey, TEST_CRITIC_KEY);
  if (!apiKey) throw new Error('critic_api_key_missing');

  const systemPrompt = buildCriticSystemPrompt();
  const userPayload = {
    goal: {
      original_prompt: prompt,
      new_context: contextNotes
    },
    context: {
      current_url: currentUrl
    },
    plan_window: {
      planned_step: null,
      next_steps: []
    },
    complete_history: Array.isArray(completeHistory) ? completeHistory : []
  };

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
    body: JSON.stringify(body)
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
  pollTimeoutMs = 30000
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
      body: form
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
      body: JSON.stringify({})
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
      })
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
      body: JSON.stringify({ assistant_id: assistantId })
    });
    if (!runResp.ok) {
      const text = await runResp.text().catch(() => '');
      throw new Error(`assistant_run_${runResp.status}: ${text}`);
    }
    let run = await runResp.json();
    const start = Date.now();
    while (run.status !== 'completed') {
      await new Promise((resolve) => setTimeout(resolve, 800));
      const poll = await fetch(`https://api.openai.com/v1/threads/${thread.id}/runs/${run.id}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'OpenAI-Beta': 'assistants=v2'
        }
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

    const messages = await fetch(`https://api.openai.com/v1/threads/${thread.id}/messages`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v2'
      }
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
    body: JSON.stringify(body)
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
  defaultAssistantKey
};
