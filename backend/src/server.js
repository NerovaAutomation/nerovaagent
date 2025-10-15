import 'dotenv/config';
import express from 'express';
import { runBootstrap, runCritic, runAssistant } from './brain.js';

const app = express();
app.use(express.json({ limit: '8mb' }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, status: 'ready' });
});

app.post('/v1/brain/bootstrap', async (req, res) => {
  try {
    const result = await runBootstrap(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post('/v1/brain/critic', async (req, res) => {
  try {
    const result = await runCritic(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post('/v1/brain/assistant', async (req, res) => {
  try {
    const result = await runAssistant(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ ok: false, error: error?.message || String(error) });
  }
});

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`[nerova-brain] listening on http://${host}:${port}`);
});

export default app;
