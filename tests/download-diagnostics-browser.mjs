// Opens the real Downloads diagnostics surface in a disposable unpacked MV3 profile.
// Usage: node tests/download-diagnostics-browser.mjs [Playwright package] [Chromium] [screenshot directory]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url), playwright = require(process.argv[2] || 'playwright');
const root = path.resolve('.'), profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xvault-diagnostics-'));
const screenshotDir = path.resolve(process.argv[4] || path.join(os.tmpdir(), 'xvault-visual-review'));
await fs.mkdir(screenshotDir, { recursive: true });
const context = await playwright.chromium.launchPersistentContext(profile, {
  headless: true, executablePath: process.argv[3], viewport: { width: 1440, height: 960 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname, page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings: { onboardingComplete: true, theme: 'graphite', motionLevel: 'normal' } }));
  await page.reload();
  await page.locator('.nav[data-page="media"]').click();
  const disclosure = page.locator('#downloadDecisions');
  await disclosure.locator('summary').click();
  await page.waitForFunction(() => document.querySelector('#decisionQueueState')?.textContent.includes('Persisted backlog'));
  assert.match(await page.locator('#decisionState').innerText(), /Recent requests in this browser session/);
  await page.screenshot({ path: path.join(screenshotDir, 'xvault-downloads-desktop.png') });
  const desktop = await page.evaluate(() => ({ width: innerWidth, rootWidth: document.documentElement.scrollWidth, dialogCount: document.querySelectorAll('dialog[open]').length, queueState: document.querySelector('#decisionQueueState').textContent }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(screenshotDir, 'xvault-downloads-phone.png') });
  const narrow = await page.evaluate(() => ({ width: innerWidth, rootWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, decisionWidth: document.querySelector('#downloadDecisions')?.getBoundingClientRect().width, decisionScrollWidth: document.querySelector('#downloadDecisions')?.scrollWidth }));
  assert.deepEqual(errors, []);
  assert.ok(narrow.rootWidth <= narrow.width + 1, `Downloads overflows at 390px: ${JSON.stringify(narrow)}`);
  assert.ok(narrow.decisionWidth > 0 && narrow.decisionScrollWidth <= narrow.decisionWidth + 1, `Diagnostics panel overflows its narrow layout: ${JSON.stringify(narrow)}`);
  console.log(JSON.stringify({ ok: true, desktop, narrow, screenshots: screenshotDir }));
} finally {
  await context.close();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
