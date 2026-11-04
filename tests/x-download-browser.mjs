// Installed content script -> validated message -> real worker -> real Chrome file.
// The worker test adapter replaces synthetic CDN transport with local counted bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createRequire } from 'node:module';
const pw = createRequire(import.meta.url)(process.argv[2] || 'playwright'),
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'xvault-x-download-')),
  downloads = path.join(scratch, 'downloads');
await fs.mkdir(downloads);
let hits = 0;
const server = http.createServer((req, res) => {
  if (!req.headers.range) hits++;
  const bytes = Buffer.alloc(40000);
  bytes.set([255, 216, 255]);
  res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': bytes.length });
  res.write(bytes.subarray(0, 100));
  setTimeout(() => res.end(bytes.subarray(100)), 500);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const context = await pw.chromium.launchPersistentContext(path.join(scratch, 'profile'), {
  headless: true,
  executablePath: process.argv[3],
  acceptDownloads: true,
  downloadsPath: downloads,
  args: [`--disable-extensions-except=${path.resolve('.')}`, `--load-extension=${path.resolve('.')}`],
});
try {
  let worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname,
    dashboard = await context.newPage();
  await dashboard.goto(`chrome-extension://${id}/dashboard.html`);
  await dashboard.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SET_SETTINGS',
      settings: {
        onboardingComplete: true,
        inlineDownloadButton: true,
        healthCheckOnStartup: false,
        skipDuplicateDownloads: true,
        maxConcurrentDownloads: 2,
      },
    })
  );
  const adapt = worker =>
    worker.evaluate(origin => {
      const fetchOriginal = fetch,
        startOriginal = chrome.downloads.download.bind(chrome.downloads);
      const local = url => (String(url).startsWith('https://pbs.twimg.com/media/') ? origin + '/live.jpg' : url);
      globalThis.fetch = (url, options) => fetchOriginal(local(url), options);
      chrome.downloads.download = options => startOriginal({ ...options, url: local(options.url) });
    }, `http://127.0.0.1:${server.address().port}`);
  await adapt(worker);
  await context.route('https://x.com/**', route =>
    route.fulfill({
      contentType: 'text/html',
      body: '<html><body style="background:#fff"><article data-testid="tweet"><a href="https://x.com/fixture/status/99001122"><time>Now</time></a><div data-testid="tweetText">Synthetic own media</div><img width="80" height="80" src="https://pbs.twimg.com/media/live.jpg"><div role="group" id="actions"></div></article></body></html>',
    })
  );
  await context.route('https://pbs.twimg.com/**', route =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#586b62"/></svg>',
    })
  );
  const x = await context.newPage();
  await x.goto('https://x.com/xvault-test');
  await x.locator('.xvault-download').waitFor();
  assert.equal(await x.locator('.xvault-download').getAttribute('data-xv-owner'), id);
  await x.evaluate(() => {
    const button = document.querySelector('.xvault-download');
    for (let i = 0; i < 5; i++) button.click();
  });
  const done = async () => {
    for (let n = 0; n < 80; n++) {
      const result = await dashboard.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_DOWNLOADS_FOR_TWEETS', ids: ['99001122'] })
      );
      if (result.rows.some(row => row.state === 'complete')) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Installed X download did not complete');
  };
  await done();
  for (const attempts of [1, 2, 5]) {
    await x.waitForFunction(() => !document.querySelector('.xvault-download').disabled);
    await x.evaluate(attempts => {
      for (let i = 0; i < attempts; i++) document.querySelector('.xvault-download').click();
    }, attempts);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await x.evaluate(() => document.querySelector('#actions').replaceChildren());
  await x.locator('.xvault-download').waitFor();
  await x.locator('.xvault-download').click();
  await x.waitForFunction(() => !document.querySelector('.xvault-download').disabled);
  const cdp = await context.newCDPSession(dashboard);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await dashboard.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }));
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  await adapt(worker);
  await x.reload();
  await x.locator('.xvault-download').waitFor();
  await x.locator('.xvault-download').click();
  await x.waitForFunction(() => !document.querySelector('.xvault-download').disabled);
  const files = (await fs.readdir(downloads)).filter(name => !name.endsWith('.crdownload')),
    decisions = await dashboard.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'GET_DOWNLOAD_DECISIONS', limit: 200 })
    );
  assert.equal(hits, 1);
  assert.equal(files.length, 1);
  assert.ok(decisions.rows.some(row => row.source === 'x.com' && row.installationId === id));
  console.log(
    JSON.stringify({
      scratch,
      installedButton: true,
      fetches: hits,
      physicalFiles: files.length,
      buttonCount: await x.locator('.xvault-download').count(),
      codes: [...new Set(decisions.rows.map(row => row.code))],
    })
  );
  console.log(
    'PASS installed X fixture: five rapid clicks, completed repeats, framework rerender and worker restart retain one physical file'
  );
} finally {
  await context.close();
  await new Promise(resolve => server.close(resolve));
}
