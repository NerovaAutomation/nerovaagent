import express from 'express';
import bodyParser from 'body-parser';

const PORT = process.env.PORT || 3333;

const app = express();
app.use(bodyParser.json({ limit: '1mb' }));

let browserReady = false;
let lastPrompt = null;

app.post('/runtime/playwright/launch', (_req, res) => {
  browserReady = true;
  res.json({ ok: true, status: 'warmed', ts: Date.now() });
});

app.post('/run/start', (req, res) => {
  const { prompt } = req.body || {};
  if (!browserReady) {
    res.status(409).json({ ok: false, error: 'playwright_not_ready' });
    return;
  }
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    res.status(400).json({ ok: false, error: 'prompt_required' });
    return;
  }
  lastPrompt = prompt.trim();
  res.json({ ok: true, accepted: lastPrompt });
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, browserReady, lastPrompt });
});

export default app;

if (import.meta.main) {
  app.listen(PORT, () => {
    console.log(`[nerovaagent] listening on ${PORT}`);
  });
}
