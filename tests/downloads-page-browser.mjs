// Usage: node tests/downloads-page-browser.mjs [Playwright package] [Chromium executable] [extension root]
// XVault 23 Downloads page against the real MV3 service worker and real Chromium downloads: progress is honest
// (no invented percentage while a server sends no size), live transfers get their own cards, the queue pause the
// user chooses holds new work and is stored, history filters/search work, and Retry re-queues a failed file.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright');
const root = path.resolve(process.argv[4] || '.');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xvault-downloads-'));
const downloadDir = path.join(profile, 'downloads');
await fs.mkdir(downloadDir, { recursive: true });

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
let missingFixed = false,
  releaseSlow = false;
const server = http.createServer((request, response) => {
  const name = new URL(request.url, 'http://x').pathname;
  if (/^\/fast-\d+\.png$/.test(name)) {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    return response.end(png);
  }
  if (name === '/missing.png') {
    if (!missingFixed) return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    return response.end(png);
  }
  if (name === '/slow.mp4') {
    // Chunked, no Content-Length: Chrome cannot know the size, so no percentage may be shown.
    response.writeHead(200, { 'content-type': 'video/mp4' });
    const timer = setInterval(() => {
      if (response.destroyed) return clearInterval(timer);
      response.write(Buffer.alloc(16_384, 1));
      if (releaseSlow) {
        clearInterval(timer);
        response.end();
      }
    }, 120);
    request.on('close', () => clearInterval(timer));
    return;
  }
  response.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

await fs.mkdir(path.join(profile, 'chrome', 'Default'), { recursive: true });
await fs.writeFile(
  path.join(profile, 'chrome', 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true } })
);
const context = await pw.chromium.launchPersistentContext(path.join(profile, 'chrome'), {
  headless: true,
  executablePath: process.argv[3] || process.env.CHROMIUM_PATH || undefined,
  channel: process.argv[3] || process.env.CHROMIUM_PATH ? undefined : 'chromium',
  acceptDownloads: true,
  viewport: { width: 1360, height: 960 },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox'],
});
try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  const send = message => page.evaluate(message => chrome.runtime.sendMessage(message), message);
  await send({
    type: 'SET_SETTINGS',
    settings: {
      onboardingComplete: true,
      mediaFolder: 'XVaultDownloadsTest',
      organizeByType: false,
      organizeByAuthor: false,
      organizeByDate: false,
      skipDuplicateDownloads: false,
      downloadRetries: 0,
      maxConcurrentDownloads: 3,
    },
  });
  await page.reload();
  await page.locator('.nav[data-page="media"]').click();
  await page.waitForSelector('#page-media[data-xd="1"] #xdPause');
  const item = (name, index, mediaType = 'image') => ({
    url: origin + name,
    tweetId: String(5000 + index),
    author: 'grace',
    index: 1,
    mediaType,
  });
  await send({
    type: 'QUEUE_DOWNLOADS',
    items: [item('/slow.mp4', 0, 'video'), item('/fast-1.png', 1), item('/fast-2.png', 2), item('/missing.png', 3)],
  });

  // Live transfer card for the slow file, with an indeterminate meter and no invented queue percentage.
  // The card appears while XVault probes the file, and gets its own controls once Chrome has the download.
  await page.waitForSelector('#xdActive:not([hidden]) .xd-transfer[data-state="downloading"]', { timeout: 15000 });
  await page.waitForSelector('#xdActive .xd-transfer [data-xd="pause"]', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#downloadHistory .xd-row.complete').length >= 2, null, {
    timeout: 15000,
  });
  await page.waitForSelector('#downloadHistory .xd-row.failed', { timeout: 15000 });
  const live = await page.evaluate(() => ({
    percent: document.querySelector('#qPercent').textContent,
    indeterminate: document.querySelector('#qBar').parentElement.classList.contains('is-indeterminate'),
    meter: document.querySelector('#xdActive .xd-transfer .xd-meter').classList.contains('is-indeterminate'),
    valuenow: document.querySelector('#qBar').parentElement.getAttribute('aria-valuenow'),
    card: document.querySelector('#xdActive .xd-transfer small').textContent,
    actions: [...document.querySelectorAll('#xdActive .xd-transfer button')].map(button => button.textContent),
  }));
  assert.equal(live.percent, '…', `no invented percentage: ${JSON.stringify(live)}`);
  assert.equal(live.indeterminate, true);
  assert.equal(live.meter, true);
  assert.equal(live.valuenow, null, 'an unknown size has no aria-valuenow');
  assert.match(live.card, /so far|starting/);
  assert.deepEqual(live.actions, ['Pause', 'Cancel']);

  // Filters and search.
  await page.locator('#page-media .xd-filters [data-xd-filter="failed"]').click();
  const failedView = await page.locator('#downloadHistory .xd-row').evaluateAll(rows => rows.map(row => row.className));
  assert.equal(failedView.length, 1, JSON.stringify(failedView));
  assert.match(failedView[0], /failed/);
  assert.equal(await page.locator('#downloadHistory .xd-row [data-xd="retry"]').count(), 1);
  assert.equal(
    await page.locator('#downloadHistory .xd-row [data-xd="copy"]').count(),
    1,
    'the failure reason can be copied'
  );
  await page.locator('#page-media .xd-filters [data-xd-filter="all"]').click();
  await page.fill('#xdSearch', 'fast-2');
  await page.waitForFunction(() => document.querySelectorAll('#downloadHistory .xd-row').length === 1);
  await page.fill('#xdSearch', 'nothing-like-this');
  await page.waitForSelector('#downloadHistory > .empty');
  await page.fill('#xdSearch', '');
  await page.dispatchEvent('#xdSearch', 'input');
  // A stat tile is a filter too.
  await page.locator('#page-media .queue-stats > div[data-xd-filter="complete"]').click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#downloadHistory .xd-row')].every(row => row.classList.contains('complete'))
  );
  await page.locator('#page-media .xd-filters [data-xd-filter="all"]').click();

  const commandNames = () => page.evaluate(() => (window.XVaultExtraCommands?.('') || []).map(row => row.name));
  assert.ok((await commandNames()).includes('Pause download queue'), 'Command Center can pause the queue');
  // Pause the queue: the running transfer is held, new work waits, the choice is stored.
  await page.click('#xdPause');
  await page.waitForFunction(() => document.querySelector('#xdPause').textContent === 'Resume queue');
  await page.waitForSelector('#xdHold:not([hidden])');
  assert.match(await page.textContent('#xdHold'), /Paused/);
  assert.deepEqual(
    Object.keys((await page.evaluate(() => chrome.storage.local.get('downloadQueuePause'))) || {}),
    ['downloadQueuePause'],
    'the pause is persisted'
  );
  await page.waitForSelector('#xdActive .xd-transfer[data-state="paused"]');
  await send({ type: 'QUEUE_DOWNLOADS', items: [item('/fast-3.png', 4)] });
  await page.waitForTimeout(2500);
  const held = await send({ type: 'DOWNLOAD_QUEUE_STATS' });
  assert.equal(held.pausedByUser, true);
  assert.equal(held.hold?.code, 'paused');
  assert.ok(held.queued >= 1, `new work waits while paused: ${JSON.stringify({ queued: held.queued })}`);
  assert.equal(await page.textContent('#qTitle'), 'Paused');
  assert.ok((await commandNames()).includes('Resume download queue'), 'Command Center offers Resume while paused');
  await fs.mkdir(path.join(root, 'output', 'e2e'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'output', 'e2e', 'downloads-page.png'), fullPage: false });
  // Reopening the page keeps showing the stored pause.
  await page.reload();
  await page.locator('.nav[data-page="media"]').click();
  await page.waitForFunction(() => document.querySelector('#xdPause')?.textContent === 'Resume queue', null, {
    timeout: 10000,
  });

  // Resume: the held transfer continues and the waiting file downloads.
  await page.click('#xdPause');
  await page.waitForFunction(() => document.querySelector('#xdPause').textContent === 'Pause queue');
  assert.equal(Object.keys(await page.evaluate(() => chrome.storage.local.get('downloadQueuePause'))).length, 0);
  releaseSlow = true;
  await page.waitForFunction(() => document.querySelectorAll('#downloadHistory .xd-row.complete').length >= 4, null, {
    timeout: 20000,
  });

  // Retry the failed file once the server has it.
  missingFixed = true;
  await page.locator('#downloadHistory .xd-row.failed [data-xd="retry"]').click();
  await page.waitForFunction(() => document.querySelectorAll('#downloadHistory .xd-row.complete').length >= 5, null, {
    timeout: 20000,
  });
  const final = await send({ type: 'DOWNLOAD_QUEUE_STATS' });
  assert.equal(final.failed, 0, JSON.stringify({ failed: final.failed }));

  // XVault 25 per-host pause: files from a paused host wait while the queue itself stays running.
  const host = new URL(origin).hostname;
  await page.waitForSelector(`#xdHosts:not([hidden]) .xd-host[data-host="${host}"]`);
  await page.locator(`#xdHosts .xd-host[data-host="${host}"] [data-xd-host="toggle"]`).click();
  await page.waitForSelector(`#xdHosts .xd-host.is-paused[data-host="${host}"] [aria-pressed="true"]`);
  assert.deepEqual((await page.evaluate(() => chrome.storage.local.get('settings'))).settings.pausedDownloadHosts, [
    host,
  ]);
  await send({ type: 'QUEUE_DOWNLOADS', items: [item('/fast-4.png', 5)] });
  await page.waitForTimeout(2500);
  const hostHeld = await send({ type: 'DOWNLOAD_QUEUE_STATS' });
  assert.equal(hostHeld.pausedByUser, false, 'a host pause is not a queue pause');
  assert.deepEqual(hostHeld.pausedHosts, [host]);
  assert.ok(
    hostHeld.queued >= 1,
    `the file from the paused host waits: ${JSON.stringify({ queued: hostHeld.queued })}`
  );
  assert.match(await page.textContent(`#xdHosts .xd-host[data-host="${host}"]`), /Paused · queued files wait/);
  await page.locator('#xdHosts').screenshot({ path: path.join(root, 'output', 'e2e', 'downloads-hosts.png') });
  await page.locator(`#xdHosts .xd-host[data-host="${host}"] [data-xd-host="toggle"]`).click();
  await page.waitForFunction(() => document.querySelectorAll('#downloadHistory .xd-row.complete').length >= 6, null, {
    timeout: 20000,
  });
  assert.deepEqual((await send({ type: 'DOWNLOAD_QUEUE_STATS' })).pausedHosts, []);
  await page.waitForFunction(() => document.querySelector('#qPercent').textContent !== '…');
  assert.notEqual(await page.textContent('#qPercent'), '35%');
  assert.deepEqual(errors, []);
  console.log(
    'downloads page: honest progress, live transfer card, filters/search, persistent pause, resume, retry, per-host pause'
  );
} finally {
  await context.close();
  server.close();
  await fs.rm(profile, { recursive: true, force: true });
}
