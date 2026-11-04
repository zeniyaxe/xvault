// Explicit installed-host integration. Disposable Chrome profile; no registration writes.
// Uses the existing allowed extension ID and a temporary listener on 18766.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  { chromium } = require(process.argv[2] || 'playwright');
const profile = await fs.mkdtemp(path.join(process.env.TEMP, 'xvault-native-browser-'));
const root = path.resolve('.');
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  ignoreHTTPSErrors: true,
  executablePath: process.argv[3],
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  viewport: { width: 1280, height: 1000 },
});
let page;
try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname;
  page = await context.newPage();
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  const command = (name, payload = {}) =>
    page.evaluate(({ name, payload }) => chrome.runtime.sendMessage({ type: 'REMOTE_COMMAND', name, payload }), {
      name,
      payload,
    });
  const devices = await command('devices.list');
  assert.notEqual(devices.ok, false, devices.error);
  // Give idle cleanup time to run: the next command must reconnect rather than use a stale Port.
  await new Promise(resolve => setTimeout(resolve, 150));
  const status = await command('remote.status');
  assert.notEqual(status.ok, false, status.error);
  const started = await command('remote.start', { port: 18766 });
  assert.equal(started.listening, true, started.error);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await command('remote.status')).listening, true, 'earlier idle cleanup must not kill the listener');
  const invite = await command('pairing.start', { port: 18766 });
  assert.ok(invite.url?.includes('/pair#'), invite.error);
  const phone = await context.newPage();
  const response = await phone.goto(new URL(invite.url).origin);
  assert.equal(response.status(), 200);
  await phone.close();
  assert.equal((await command('remote.stop')).listening, false);
  assert.equal(
    (await command('remote.start', { port: 18766 })).listening,
    true,
    'rapid Stop → Start must supersede old shutdown'
  );
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal((await command('remote.status')).listening, true);
  assert.equal((await command('remote.stop')).listening, false);
  await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SET_SETTINGS',
      settings: { onboardingComplete: true, remoteEnabled: false, remotePort: 18766 },
    })
  );
  await page.reload();
  await page.evaluate(() => window.XVaultRemoteSettings.reveal());
  await page.locator('#remoteCheck').click();
  await page.waitForFunction(() =>
    document.querySelector('#remoteConnectionStatus')?.textContent.includes('installed and connected')
  );
  await page
    .locator('#remoteCompanion')
    .screenshot({ path: path.join(process.env.TEMP, 'xvault-installed-remote-ready.png') });
  await page.locator('#remoteToggle').click();
  await page.locator('#remotePairStage').waitFor({ state: 'visible' });
  assert.equal(
    await page.locator('#remoteError').count(),
    0,
    'real installed pairing should show a QR without the disconnected error'
  );
  assert.equal((await command('remote.status')).listening, true);
  console.log('PASS installed Native Messaging: idle reconnect, real HTTPS listener/QR shell, rapid Stop/Start');
} finally {
  if (page && !page.isClosed())
    await page
      .evaluate(() => chrome.runtime.sendMessage({ type: 'REMOTE_COMMAND', name: 'remote.stop' }))
      .catch(() => {});
  await context.close();
  await fs.rm(profile, { recursive: true, force: true });
}
