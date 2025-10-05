import crypto from 'crypto';
import { pickAgent, setAgentRun, agentSnapshot } from './agents.js';

const DEFAULT_TIMEOUT_MS = 15000;

function nextCommandId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(8).toString('hex');
}

function ensureOpenSocket(agent) {
  if (!agent || !agent.ws) throw new Error('agent_missing');
  if (agent.ws.readyState !== 1) throw new Error('agent_socket_not_open');
}

export async function waitForAgent({ timeout = 10000, preferredId = null } = {}) {
  const start = Date.now();
  while ((Date.now() - start) <= timeout) {
    const agent = pickAgent(preferredId);
    if (agent) return agent;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('agent_unavailable');
}

export async function executeCommand(agent, command, payload = null, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  ensureOpenSocket(agent);
  const id = nextCommandId();
  const body = { type: 'COMMAND', id, command, payload };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      agent.pending.delete(id);
      reject(new Error('agent_command_timeout'));
    }, timeout);
    agent.pending.set(id, { resolve, reject, timer });
    try {
      agent.ws.send(JSON.stringify(body));
    } catch (err) {
      agent.pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

export async function command(command, payload = null, options = {}) {
  const { agent: agentOpt = null, preferredId = null, timeout } = options || {};
  const agent = agentOpt || pickAgent(preferredId);
  if (!agent) throw new Error('agent_unavailable');
  return executeCommand(agent, command, payload, { timeout });
}

export async function ensureAgentInitialized(options = {}) {
  const agent = await waitForAgent(options);
  try {
    await executeCommand(agent, 'INIT', null, { timeout: 5000 });
  } catch (err) {
    throw err;
  }
  return agent;
}

export function assignRun(agent, runId) {
  if (!agent) return;
  setAgentRun(agent, runId);
}

export function currentAgentState(preferredId = null) {
  const agent = pickAgent(preferredId);
  return agentSnapshot(agent);
}

export default {
  waitForAgent,
  executeCommand,
  command,
  ensureAgentInitialized,
  assignRun,
  currentAgentState
};
