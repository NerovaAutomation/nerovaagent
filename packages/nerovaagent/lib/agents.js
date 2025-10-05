import crypto from 'crypto';

const agents = new Map();

function randomId(prefix = 'agent') {
  const raw = crypto.randomBytes(6).toString('hex');
  return `${prefix}-${raw}`;
}

function buildAgentRecord(ws, req) {
  const now = Date.now();
  return {
    id: null,
    ws,
    req,
    status: 'connecting',
    lastSeen: now,
    connectedAt: now,
    pending: new Map(),
    currentRun: null,
    meta: {
      userAgent: req?.headers?.['user-agent'] || null,
      ip: req?.socket?.remoteAddress || null
    }
  };
}

function finalizeAgentId(agent, requestedId) {
  const candidate = (requestedId || '').toString().trim();
  if (candidate && !agents.has(candidate)) {
    agent.id = candidate;
    return candidate;
  }
  let unique;
  do {
    unique = randomId();
  } while (agents.has(unique));
  agent.id = unique;
  return unique;
}

export function attachAgent(ws, req) {
  const agent = buildAgentRecord(ws, req);
  const register = (id) => {
    agents.set(id, agent);
    agent.status = 'idle';
    agent.id = id;
    agent.lastSeen = Date.now();
  };

  const cleanup = () => {
    if (agent.id && agents.get(agent.id) === agent) {
      agents.delete(agent.id);
    }
    for (const [, entry] of agent.pending) {
      try { clearTimeout(entry.timer); entry.reject(new Error('agent_disconnected')); } catch {}
    }
    agent.pending.clear();
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    agent.lastSeen = Date.now();
    switch (msg.type) {
      case 'HANDSHAKE': {
        const assigned = finalizeAgentId(agent, msg.agentId);
        register(assigned);
        try {
          ws.send(JSON.stringify({ type: 'WELCOME', agentId: assigned }));
        } catch {}
        break;
      }
      case 'PING': {
        try { ws.send(JSON.stringify({ type: 'PONG', ts: Date.now() })); } catch {}
        break;
      }
      case 'RESPONSE': {
        const id = msg.id;
        if (!id) break;
        const entry = agent.pending.get(id);
        if (!entry) break;
        agent.pending.delete(id);
        clearTimeout(entry.timer);
        if (msg.ok) {
          entry.resolve(msg.result);
        } else {
          const err = new Error(msg.error || 'agent_error');
          entry.reject(err);
        }
        break;
      }
      case 'EVENT': {
        // propagate to listener if provided
        if (typeof agent.onEvent === 'function') {
          try { agent.onEvent(msg); } catch {}
        }
        break;
      }
      case 'LOG': {
        if (typeof agent.onLog === 'function') {
          try { agent.onLog(msg); } catch {}
        }
        break;
      }
      case 'STATUS': {
        agent.status = msg.status || agent.status;
        break;
      }
      default:
        break;
    }
  });

  return agent;
}

export function detachAgent(agent) {
  if (!agent) return;
  try { agent.ws?.close?.(); } catch {}
}

export function listAgents() {
  return Array.from(agents.values()).map((agent) => ({
    id: agent.id,
    status: agent.status,
    lastSeen: agent.lastSeen,
    currentRun: agent.currentRun,
    meta: agent.meta
  }));
}

export function pickAgent(preferredId = null) {
  if (preferredId && agents.has(preferredId)) {
    return agents.get(preferredId);
  }
  let best = null;
  for (const agent of agents.values()) {
    if (agent.status === 'busy') continue;
    if (!best) { best = agent; continue; }
    if ((agent.lastSeen || 0) > (best.lastSeen || 0)) best = agent;
  }
  if (best) return best;
  // fallback to any agent
  const iter = agents.values().next();
  return iter.done ? null : iter.value;
}

export function setAgentRun(agent, runId) {
  if (!agent) return;
  agent.currentRun = runId || null;
  agent.status = runId ? 'busy' : 'idle';
}

export function agentCount() {
  return agents.size;
}

export function heartbeatAgents(thresholdMs = 60000) {
  const now = Date.now();
  for (const agent of agents.values()) {
    if ((now - agent.lastSeen) > thresholdMs) {
      try { agent.ws.terminate(); } catch {}
      agents.delete(agent.id);
    }
  }
}

export function agentSnapshot(agent) {
  if (!agent) return null;
  return {
    id: agent.id,
    status: agent.status,
    lastSeen: agent.lastSeen,
    currentRun: agent.currentRun
  };
}

export function getAgent(agentId) {
  if (!agentId) return null;
  return agents.get(agentId) || null;
}

export default {
  attachAgent,
  detachAgent,
  listAgents,
  pickAgent,
  setAgentRun,
  agentCount,
  heartbeatAgents,
  agentSnapshot,
  getAgent
};
