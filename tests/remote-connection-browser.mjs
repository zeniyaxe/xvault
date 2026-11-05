// Isolated desktop Remote setup states; never registers or starts a native host.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { chromium } = require(process.argv[2] || 'playwright');
const html = await fs.readFile('dashboard.html', 'utf8');
const temp = process.env.TEMP || os.tmpdir(); // TEMP is Windows-only; CI runs on Linux
const start = html.indexOf('<section class="remote-panel'),
  end = html.indexOf('</section>', start) + 10;
const browser = await chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 1000 } });
  await page.addInitScript(() => {
    window.chrome = { runtime: { id: 'a'.repeat(32) } };
    window.__ready = false;
    window.__starts = 0;
    window.call = async message => {
      if (message.type === 'GET_SETTINGS') return { settings: {} };
      if (!window.__ready) return { ok: false, error: 'Specified native messaging host not found.' };
      if (message.name === 'remote.status') return { ok: true, listening: false };
      if (message.name === 'remote.start') {
        window.__starts++;
        return { ok: true, listening: true, baseUrl: 'https://192.168.1.2:18765' };
      }
      if (message.name === 'pairing.start')
        return { url: 'https://192.168.1.2:18765/pair#fixture', code: '123456', expiresAt: Date.now() / 1000 + 300 };
      return { ok: true, rows: [] };
    };
    window.save = async settings => settings;
    window.toast = () => {};
    window.page = () => {};
  });
  await page.route('http://remote-setup.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1);
    if (!file)
      return route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: `<!doctype html><html data-theme="graphite"><head><meta charset="utf-8"><link rel="stylesheet" href="xv-app.css"></head><body style="padding:24px"><main>${html.slice(start, end)}</main><script src="FFmpeg_Helper/remote-ui/qrcode-generator.js"></script><script src="FFmpeg_Helper/remote-ui/qrcode-utf8.js"></script><script src="remote-settings.js"></script></body></html>`,
      });
    try {
      return await route.fulfill({
        contentType: file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'application/octet-stream',
        body: await fs.readFile(path.resolve(file)),
      });
    } catch {
      return route.abort();
    }
  });
  await page.goto('http://remote-setup.test/');
  await page.locator('#remoteCheck').click();
  await page.waitForFunction(() => document.querySelector('#remoteError')?.textContent.includes('not installed'));
  assert.equal(await page.locator('#remoteCheck').isEnabled(), true);
  await page.evaluate(() => (window.__ready = true));
  await page.locator('#remoteCheck').click();
  await page.waitForFunction(() =>
    document.querySelector('#remoteConnectionStatus').textContent.includes('installed and connected')
  );
  assert.equal(await page.locator('#remoteError').count(), 0);
  await page.locator('#remoteToggle').click();
  await page.locator('#remotePairStage').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#remotePairCode').textContent(), '123456');
  assert.equal(await page.evaluate(() => window.__starts), 1);
  await page.screenshot({ path: path.join(temp, 'xvault-remote-connection-ready.png') });
  await page.setViewportSize({ width: 390, height: 1100 });
  await page.evaluate(() => {
    document.querySelector('#remoteSetupHint').hidden = false;
  });
  await page.screenshot({ path: path.join(temp, 'xvault-remote-connection-narrow.png') });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'setup must fit a narrow viewport'
  );
  assert.equal(
    await page.locator('#remoteCheck').evaluate(node => {
      const r = node.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth;
    }),
    true,
    'connection action must remain fully visible'
  );
  console.log('PASS Remote missing-install recovery, retry, ready status, QR, and narrow layout');
} finally {
  await browser.close();
}
