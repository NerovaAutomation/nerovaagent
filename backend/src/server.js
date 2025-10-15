import 'dotenv/config';
import express from 'express';
import { runBootstrap, runCritic, runAssistant } from './brain.js';
import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = process.env.LOG_DIR || path.resolve('logs');
function ensureLogsDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}
function writeLog(filename, payload) {
  try {
    ensureLogsDir();
    const file = path.join(LOG_DIR, filename);
    fs.appendFileSync(file, `${JSON.stringify(payload)}\n`);
  } catch {}
}
function logRequest(label, payload) {
  writeLog('requests.log', {
    label,
    timestamp: new Date().toISOString(),
    payload
  });
}
function logResponse(label, payload) {
  writeLog('responses.log', {
    label,
    timestamp: new Date().toISOString(),
    payload
  });
}
function logError(label, error) {
  writeLog('errors.log', {
    label,
    timestamp: new Date().toISOString(),
    error: error?.stack || error?.message || String(error)
  });
}

const app = express();
app.use(express.json({ limit: '8mb' }));
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, status: 'ready' });
});

app.post('/v1/brain/bootstrap', async (req, res) => {
  logRequest('bootstrap', req.body || {});
  try {
    const result = await runBootstrap(req.body || {});
    logResponse('bootstrap', result);
    res.json(result);
  } catch (error) {
    logError('bootstrap', error);
    res.status(400).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post('/v1/brain/critic', async (req, res) => {
  logRequest('critic', req.body || {});
  try {
    const result = await runCritic(req.body || {});
    logResponse('critic', result);
    res.json(result);
  } catch (error) {
    logError('critic', error);
    res.status(400).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post('/v1/brain/assistant', async (req, res) => {
  logRequest('assistant', req.body || {});
  try {
    const result = await runAssistant(req.body || {});
    logResponse('assistant', result);
    res.json(result);
  } catch (error) {
    logError('assistant', error);
    res.status(400).json({ ok: false, error: error?.message || String(error) });
  }
});
const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`[nerova-brain] listening on http://${host}:${port}`);
});
export default app;
