import { chromium } from '@playwright/test';

const url = process.env.URL || 'http://127.0.0.1:3333/webrtc2';
const runMs = Number(process.env.RUN_MS || 12000);

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Click Connect
  await page.locator('#connectBtn').click();
  // Wait for video track or status connected
  try {
    await page.waitForFunction(() => {
      const s = document.querySelector('#status');
      return s && /connected|connecting|completed/i.test(s.textContent||'');
    }, { timeout: 8000 });
  } catch {}
  // Let it run to collect frames and compute FPS on the UI
  await page.waitForTimeout(runMs);
  try {
    const infoText = await page.locator('#info').textContent();
    console.log('[client] info:', (infoText||'').trim());
  } catch {}
  await browser.close();
  process.exit(0);
})();
