import express from 'express';
import http from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import pino from 'pino';
import url from 'url';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_HOST = process.env.SIGNAL_PUBLIC_HOST || null;
const JWT_SECRET = process.env.SIGNAL_JWT_SECRET || '';
if (!JWT_SECRET) {
  log.error('SIGNAL_JWT_SECRET env not set');
  process.exit(1);
}
const TURN_SECRET = process.env.TURN_SHARED_SECRET || '';
const TURN_REALM = process.env.TURN_REALM || 'signal.fly';
const TURN_HOST = process.env.TURN_HOST || PUBLIC_HOST;
const TURN_UDP_PORT = Number(process.env.TURN_PORT || 3478);
const TURN_TLS_PORT = Number(process.env.TURN_TLS_PORT || 5349);
const TURN_TTL_SECONDS = Number(process.env.TURN_TTL_SECONDS || 600);
const TURN_MIN_PORT = Number(process.env.TURN_MIN_PORT || 49152);
const TURN_MAX_PORT = Number(process.env.TURN_MAX_PORT || 65535);
const WORKER_HTTP_BASE = (process.env.WORKER_HTTP_BASE || 'https://webagent-worker.fly.dev').replace(/\/$/, '');
const SESSION_TTL_SECONDS = Number(process.env.SIGNAL_SESSION_TTL_SECONDS || 300);
const ALLOWED_PATHS = new Set(
  (process.env.SIGNAL_ALLOWED_PATHS || '/webrtc/config,/webrtc/offer,/webrtc/viewport,/webrtc/grid,/webrtc/dimensions,/webrtc/snap,/webrtc/test-click,/webrtc2/config,/webrtc2/offer,/webrtc2/click,/critic,/nl2web2')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
);

const app = express();
app.use(express.json({ limit: '2mb' }));

function issueSignalToken(machineId, ttlSeconds = SESSION_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.max(60, ttlSeconds);
  const jti = crypto.randomUUID();
  return jwt.sign({ sub: machineId, machineId, jti }, JWT_SECRET, { expiresIn: exp - now });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function generateTurnCredentials(ttlSeconds = TURN_TTL_SECONDS) {
  if (!TURN_SECRET || !TURN_HOST) {
    return null;
  }
  const timestamp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = String(timestamp);
  const hmac = crypto.createHmac('sha1', TURN_SECRET);
  hmac.update(username);
  const credential = hmac.digest('base64');
  return {
    username,
    credential,
    ttl: ttlSeconds
  };
}

function buildIceServers() {
  const servers = [];
  if (TURN_HOST) {
    const turnCreds = generateTurnCredentials();
    if (turnCreds) {
      const stunUrl = `stun:${TURN_HOST}:${TURN_UDP_PORT}`;
      servers.push({ urls: [stunUrl] });
      servers.push({
        urls: [
          `turn:${TURN_HOST}:${TURN_UDP_PORT}?transport=udp`,
          `turn:${TURN_HOST}:${TURN_UDP_PORT}?transport=tcp`
        ],
        username: turnCreds.username,
        credential: turnCreds.credential
      });
      if (TURN_TLS_PORT) {
        servers.push({
          urls: [`turns:${TURN_HOST}:${TURN_TLS_PORT}`],
          username: turnCreds.username,
          credential: turnCreds.credential
        });
      }
      return { iceServers: servers, ttl: turnCreds.ttl };
    }
  }
  return {
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    ttl: TURN_TTL_SECONDS
  };
}

function buildWorkerUrl(machineId, path, query = '') {
  const params = new url.URLSearchParams(query);
  if (!params.has('fly_machine')) params.set('fly_machine', machineId);
  const qs = params.toString();
  return `${WORKER_HTTP_BASE}${path}${qs ? `?${qs}` : ''}`;
}

async function forwardToWorker(machineId, method, path, body, headers = {}) {
  if (!ALLOWED_PATHS.has(path)) {
    const error = new Error('path_not_allowed');
    error.status = 400;
    log.warn({ machineId, path }, 'signal_path_rejected');
    throw error;
  }
  const target = buildWorkerUrl(machineId, path);
  const fetchHeaders = {
    'Content-Type': 'application/json',
    'Fly-Machine': machineId,
    ...headers
  };
  const init = { method, headers: fetchHeaders };
  if (body !== undefined && body !== null) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  log.debug({ machineId, method, path }, 'signal_forward');
  const response = await fetch(target, init);
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return {
    status: response.status,
    ok: response.ok,
    body: payload
  };
}

app.get('/healthz', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.post('/sessions', (req, res) => {
  try {
    const { machineId, ttlSeconds } = req.body || {};
    if (!machineId || typeof machineId !== 'string') {
      return res.status(400).json({ ok: false, error: 'machineId_required' });
    }
    const token = issueSignalToken(machineId, ttlSeconds);
    const ice = buildIceServers();
    const host = PUBLIC_HOST || req.headers['host'] || 'localhost';
    const urlBase = `wss://${host}/signal`;
    res.json({
      ok: true,
      machineId,
      signaling: {
        url: urlBase,
        token,
        expiresIn: ttlSeconds || SESSION_TTL_SECONDS
      },
      ice
    });
  } catch (err) {
    log.error({ err }, 'session_create_error');
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

function rejectSocket(socket, code = 400, message = 'Bad Request') {
  try { socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`); } catch {}
  try { socket.destroy(); } catch {}
}

server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new url.URL(req.url, 'http://localhost');
  if (pathname !== '/signal') {
    rejectSocket(socket, 404, 'Not Found');
    return;
  }
  const token = searchParams.get('token');
  if (!token) {
    rejectSocket(socket, 401, 'Unauthorized');
    return;
  }
  let claims;
  try {
    claims = verifyToken(token);
  } catch (err) {
    log.warn({ err: err.message }, 'token_verify_failed');
    rejectSocket(socket, 401, 'Unauthorized');
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.session = {
      machineId: claims.machineId || claims.sub,
      tokenId: claims.jti,
      exp: claims.exp
    };
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const session = ws.session;
  if (!session?.machineId) {
    ws.close(1011, 'invalid_session');
    return;
  }
  log.info({ machineId: session.machineId }, 'signal_ws_connected');
  ws.send(JSON.stringify({ type: 'ready', machineId: session.machineId, exp: session.exp }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' }));
      return;
    }
    if (!msg || typeof msg !== 'object') {
      ws.send(JSON.stringify({ type: 'error', error: 'invalid_message' }));
      return;
    }
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      return;
    }
    if (msg.type !== 'request') {
      ws.send(JSON.stringify({ type: 'error', error: 'unsupported_type', id: msg.id }));
      return;
    }
    const { id, method = 'GET', path, body, headers } = msg;
    if (!path || typeof path !== 'string') {
      ws.send(JSON.stringify({ type: 'response', id, ok: false, error: 'path_required' }));
      return;
    }
    try {
      const result = await forwardToWorker(session.machineId, method.toUpperCase(), path, body, headers);
      ws.send(JSON.stringify({ type: 'response', id, ok: result.ok, status: result.status, body: result.body }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'response', id, ok: false, status: err.status || 500, error: err.message || 'forward_error' }));
    }
  });

  ws.on('close', (code) => {
    log.info({ machineId: session.machineId, code }, 'signal_ws_closed');
  });

  ws.on('error', (err) => {
    log.warn({ machineId: session.machineId, err: err.message }, 'signal_ws_error');
  });
});

server.listen(PORT, () => {
  log.info({ port: PORT, workerBase: WORKER_HTTP_BASE }, 'signaler_listening');
  if (!TURN_SECRET || !TURN_HOST) {
    log.warn('TURN not fully configured; returning STUN-only ICE');
  } else {
    log.info({ host: TURN_HOST, udpPort: TURN_UDP_PORT, tlsPort: TURN_TLS_PORT, realm: TURN_REALM, minPort: TURN_MIN_PORT, maxPort: TURN_MAX_PORT }, 'turn_config');
  }
});

process.on('SIGTERM', () => {
  log.info('SIGTERM received, shutting down');
  wss.close(() => {
    server.close(() => process.exit(0));
  });
});
