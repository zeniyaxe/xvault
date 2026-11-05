// Real local service-worker caching, separate from API-routed product fixtures.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const pw = createRequire(import.meta.url)(process.argv[2] || 'playwright');
const root = path.resolve('FFmpeg_Helper/remote-ui');
const files = new Set([
  'index.html',
  'remote.js',
  'remote-drafts.js',
  'remote.css',
  'remote-sw.js',
  'manifest.webmanifest',
  'app-icon.svg',
  'app-icon-192.png',
  'app-icon-512.png',
  'remote-font.woff2',
]);
const mediaPath = '/api/media/' + 'a'.repeat(32),
  mediaBytes = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#354c46"/></svg>'
  );
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/session') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        deviceId: 'shell-test',
        name: 'Shell fixture',
        motion: 'off',
        permissions: ['library.read', 'media.read'],
      })
    );
    return;
  }
  if (url.pathname === '/api/library') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        rows: [{ id: '123', name: 'Local file', mediaCount: 1, media: [{ type: 'photo', url: mediaPath }] }],
        matched: 1,
        matchedExact: true,
        hasMore: false,
        nextCursor: null,
      })
    );
    return;
  }
  if (url.pathname === '/api/media/page') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        id: '123',
        offset: 0,
        mediaCount: 1,
        mediaVersion: 'a'.repeat(64),
        media: [{ index: 0, type: 'photo', url: mediaPath }],
        nextOffset: null,
      })
    );
    return;
  }
  if (url.pathname === mediaPath) {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader(
      'Content-Disposition',
      url.searchParams.get('download') === '1' ? 'attachment; filename="reference.svg"' : 'inline'
    );
    res.end(mediaBytes);
    return;
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!files.has(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const mime = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.webmanifest': 'application/manifest+json',
  }[path.extname(file)];
  res.setHeader('Content-Type', mime);
  res.end(await fs.readFile(path.join(root, file)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await pw.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
try {
  const context = await browser.newContext();
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() =>
    localStorage.setItem('xvault.remote.device.v1', JSON.stringify({ deviceId: 'shell-test', name: 'Shell fixture' }))
  );
  await page.goto(origin);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.locator('.tile-media.has-media').first().click();
  await page.waitForFunction(
    () => document.querySelector('#viewerSavePhone').getAttribute('aria-disabled') === 'false'
  );
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#viewerSavePhone').click()]);
  assert.equal(download.suggestedFilename(), 'reference.svg');
  assert.deepEqual(
    await fs.readFile(await download.path()),
    mediaBytes,
    'actual browser download receives exact attachment bytes'
  );
  await page.locator('#viewerBack').click();
  const cached = await page.evaluate(async () => {
    const cache = await caches.open('xvault-remote-shell-v7');
    return {
      paths: (await cache.keys()).map(req => new URL(req.url).pathname),
      session: !!(await caches.match('/api/session')),
      media: !!(await caches.match('/api/media/private-file')),
    };
  });
  assert.ok(cached.paths.includes('/remote-drafts.js'), 'the recovery model belongs in the offline shell');
  assert.ok(cached.paths.includes('/app-icon-192.png') && cached.paths.includes('/app-icon-512.png'));
  assert.equal(cached.session, false);
  assert.equal(cached.media, false);
  await context.setOffline(true);
  await page.reload();
  await page.locator('#pairScreen:not([hidden])').waitFor();
  assert.equal(
    await page.evaluate(() => typeof window.XVaultRemoteDrafts),
    'object',
    'draft recovery remains executable after an offline reload'
  );
  await page.locator('#pairDrafts').click();
  assert.equal(await page.locator('#draftRecovery').evaluate(node => node.open), true);
  assert.deepEqual(errors, []);
  console.log(
    'PASS real Chromium Remote: native attachment bytes/filename, offline draft module/icons; session/media excluded'
  );
  await context.close();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
