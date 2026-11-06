// Phone Remote first-paint profile at 390×844: serves a remote-ui folder with a mocked companion API (60 posts,
// mixed media) and measures time to the first tile with a decoded image, DOM size and transfer size of the shell.
// Synthetic; network and companion latency are excluded. Usage:
//   node tests/remote-perf.mjs [playwright] [chromium] [remote-ui dir] [runs]
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright'),
  dir = path.resolve(process.argv[4] || 'FFmpeg_Helper/remote-ui'),
  runs = Number(process.argv[5] || 5);
const svg = (w, h, fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/></svg>`;
const now = Date.now();
const ROWS = Array.from({ length: 60 }, (_, i) => ({
  id: String(1790000000000000000n + BigInt(i)),
  name: ['Mira Okafor', 'Jun Park', 'Studio Ledger', 'A very long display name that keeps going'][i % 4],
  handle: ['miraokafor', 'junpark', 'studioledger', 'longname_account'][i % 4],
  verified: i % 3 === 0,
  text: 'Field notes from the coast: three frames from this morning, before the fog lifted. '.repeat(1 + (i % 3)),
  link: `https://x.com/a/status/${i}`,
  createdAt: new Date(now - i * 3600e3).toISOString(),
  archivedAt: now - i * 1000,
  media: Array.from({ length: i % 5 }, (_, m) => ({
    type: m === 0 && i % 7 === 0 ? 'video' : 'photo',
    width: 1200,
    height: 800,
    url: `/api/media/${String(i * 10 + m + 1).padStart(32, 'b')}`,
  })),
  mediaCount: i % 5,
  mediaState: i % 2 ? 'local' : 'remote',
  metrics: { replies: i, reposts: i * 3, likes: i * 40, views: i * 900 },
  tags: i % 4 ? [] : ['coast'],
}));
const types = { js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', woff2: 'font/woff2', png: 'image/png' };
const browser = await pw.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
const results = [];
try {
  for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: 'block',
      hasTouch: true,
    });
    await context.addInitScript(() => {
      localStorage.setItem('xvault.remote.device.v1', JSON.stringify({ deviceId: 'fixture', name: 'Phone' }));
      localStorage.setItem('xvault.remote.install-dismissed', '1');
    });
    await context.route('http://127.0.0.1:8765/**', async route => {
      const url = new URL(route.request().url());
      let data;
      if (url.pathname === '/api/session')
        data = {
          deviceId: 'fixture',
          name: 'Phone',
          motion: 'normal',
          libraryRevision: 1,
          permissions: ['library.read', 'media.read'],
        };
      else if (url.pathname === '/api/library')
        data = { rows: ROWS, matched: ROWS.length, matchedExact: true, nextCursor: null, hasMore: false };
      else if (url.pathname.startsWith('/api/media/') || url.pathname.startsWith('/api/avatar/'))
        return route.fulfill({ contentType: 'image/svg+xml', body: svg(1200, 800, '#8fb3c9') });
      else if (url.pathname.startsWith('/api/')) data = { rows: [] };
      else {
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        try {
          const body = await fs.readFile(path.join(dir, name));
          return route.fulfill({ body, contentType: types[name.split('.').pop()] || 'text/html' });
        } catch {
          return route.fulfill({ status: 404, body: '' });
        }
      }
      return route.fulfill({ json: data });
    });
    const page = await context.newPage();
    const started = Date.now();
    await page.goto('http://127.0.0.1:8765/');
    const firstTile = await page.evaluate(
      () =>
        new Promise(resolve => {
          const check = () => {
            const image = [
              ...document.querySelectorAll('.post-card img, .post-tile img, .tile-media img, .card-media img'),
            ].find(item => item.complete && item.naturalWidth > 0);
            if (image) resolve(performance.now());
            else if (performance.now() > 15000) resolve(-1);
            else requestAnimationFrame(check);
          };
          check();
        })
    );
    await page.waitForTimeout(300);
    const facts = await page.evaluate(() => ({
      nodes: document.getElementsByTagName('*').length,
      cards: document.querySelectorAll('.post-card, .post-tile').length,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e5) / 10 : null,
    }));
    results.push({ firstTileMs: Math.round(firstTile), wallMs: Date.now() - started, ...facts });
    await context.close();
  }
} finally {
  await browser.close();
}
const sizes = {};
for (const name of ['remote.js', 'remote-capture.js', 'remote.css', 'index.html']) {
  try {
    const body = await fs.readFile(path.join(dir, name));
    sizes[name] = { bytes: body.length, gzip: zlib.gzipSync(body, { level: 9 }).length };
  } catch {}
}
const median = key => results.map(r => r[key]).sort((a, b) => a - b)[Math.floor(results.length / 2)];
console.log(
  JSON.stringify({
    dir,
    runs: results.length,
    firstTileMs: median('firstTileMs'),
    nodes: median('nodes'),
    cards: median('cards'),
    heapMB: median('heapMB'),
    sizes,
    results,
  })
);
