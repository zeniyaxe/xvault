// Phone Remote 3.0 in a real browser: rich feed cards (verified, reply context, media grid, quoted post,
// link card, chips, metrics), the feed/grid layout switch, the bottom-sheet preview, the live Downloads
// monitor (pause/resume/retry only when allowed, polling stops when hidden), the Overview (month bars and
// people jump into Library searches), viewer gestures (double-tap zoom, keyboard zoom, swipe, swipe-down
// close), reduced motion and an axe-core audit of every new surface.
// Usage: node tests/remote-aurora-browser.mjs [playwright module path] [chromium executable]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright'),
  axeSource = await fs.readFile(require.resolve('axe-core/axe.min.js'), 'utf8'),
  out = path.join(os.tmpdir(), 'xvault-remote-aurora');
await fs.mkdir(out, { recursive: true });
const STATIC = [
  'index.html',
  'remote.js',
  'remote-drafts.js',
  'remote.css',
  'app-icon.svg',
  'manifest.webmanifest',
  'app-icon-192.png',
  'app-icon-512.png',
  'remote-font.woff2',
];
const svg = (w, h, fill) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${fill}"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 4}" fill="#26303a"/></svg>`;
const media = (count, w = 1200, h = 800) =>
  Array.from({ length: count }, (_, i) => ({
    type: 'photo',
    width: w,
    height: h,
    url: `/api/media/${String(i + 1).padStart(32, 'b')}`,
  }));
const now = Date.now();
const ROWS = [
  {
    id: '1790000000000000001',
    name: 'Mira Okafor',
    handle: 'miraokafor',
    verified: true,
    text: 'Field notes from the coast: three frames from this morning, before the fog lifted.',
    link: 'https://x.com/miraokafor/status/1790000000000000001',
    createdAt: new Date(now - 3 * 3600e3).toISOString(),
    archivedAt: now,
    media: media(3),
    mediaCount: 3,
    mediaState: 'local',
    metrics: { replies: 42, reposts: 318, likes: 5120, views: 98000 },
    readLater: true,
    hasNote: true,
    tags: ['coast'],
  },
  {
    id: '1790000000000000002',
    name: 'Jun Park',
    handle: 'junpark',
    replyTo: 'miraokafor',
    text: 'The second frame is the one. Quoting the thread I mentioned last week:',
    link: 'https://x.com/junpark/status/1790000000000000002',
    createdAt: new Date(now - 26 * 3600e3).toISOString(),
    archivedAt: now,
    media: [],
    mediaCount: 0,
    quote: {
      id: '1780000000000000009',
      handle: 'lenswork',
      name: 'Lens Work',
      text: 'Fog is a diffuser the size of a city. Expose for the highlights.',
      mediaCount: 2,
    },
    metrics: { replies: 3, likes: 88 },
  },
  {
    id: '1790000000000000003',
    name: 'Studio Ledger',
    handle: 'studioledger',
    text: 'New essay on archiving your own work offline.',
    link: 'https://x.com/studioledger/status/1790000000000000003',
    createdAt: new Date(now - 9 * 86400e3).toISOString(),
    archivedAt: now,
    media: [],
    mediaCount: 0,
    card: { title: 'Keeping a private archive that outlives the platform', domain: 'ledger.example' },
    quote: { id: '1770000000000000001', missing: true },
    metrics: { likes: 12 },
  },
  {
    id: '1790000000000000004',
    name: 'Mira Okafor',
    handle: 'miraokafor',
    verified: true,
    thread: true,
    replyTo: 'miraokafor',
    text: 'And the full set.',
    link: 'https://x.com/miraokafor/status/1790000000000000004',
    createdAt: new Date(now - 40 * 86400e3).toISOString(),
    archivedAt: now,
    media: media(4, 800, 800),
    mediaCount: 9,
    mediaState: 'local',
    metrics: { likes: 700 },
  },
  {
    id: '1790000000000000005',
    name: 'Archive Desk',
    handle: 'archivedesk',
    text: 'A video that has not been downloaded to the computer yet.',
    link: 'https://x.com/archivedesk/status/1790000000000000005',
    createdAt: new Date(now - 400 * 86400e3).toISOString(),
    archivedAt: now,
    media: [],
    mediaCount: 1,
    mediaTypes: ['video'],
    mediaState: 'not-downloaded',
  },
];
const browser = await pw.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
    hasTouch: true,
  });
  let paused = false,
    canManage = true;
  const libraryCalls = [],
    controlCalls = [],
    downloadPolls = [];
  await context.addInitScript(() => {
    localStorage.setItem('xvault.remote.device.v1', JSON.stringify({ deviceId: 'fixture', name: 'Phone' }));
    localStorage.setItem('xvault.remote.install-dismissed', '1');
  });
  await context.route('http://127.0.0.1:8765/**', async route => {
    const url = new URL(route.request().url()),
      body = route.request().postDataJSON();
    let data;
    if (url.pathname === '/api/session')
      data = {
        deviceId: 'fixture',
        name: 'Phone',
        motion: 'normal',
        libraryRevision: 1,
        permissions: [
          'library.read',
          'media.read',
          'notes.write',
          'favorite.write',
          ...(canManage ? ['downloads.manage'] : []),
        ],
      };
    else if (url.pathname === '/api/library') {
      libraryCalls.push(body);
      data = { rows: ROWS, matched: ROWS.length, matchedExact: true, nextCursor: null, hasMore: false };
    } else if (url.pathname === '/api/media/page')
      data = {
        id: body.id,
        offset: body.offset,
        mediaCount: 3,
        mediaVersion: 'c'.repeat(64),
        media: Array.from({ length: 3 }, (_, i) => ({
          index: i,
          mediaId: String(i),
          type: 'photo',
          url: '/api/media/' + String(i + 1).padStart(32, 'b'),
        })),
        nextOffset: null,
      };
    else if (url.pathname === '/api/note/read') data = { note: 'Shot at f/8, 1/250.' };
    else if (url.pathname === '/api/views') data = { rows: [] };
    else if (url.pathname === '/api/activity') data = { rows: [] };
    else if (url.pathname === '/api/downloads') {
      downloadPolls.push(Date.now());
      data = {
        countsReady: true,
        queued: 3,
        downloading: paused ? 0 : 2,
        active: paused ? 0 : 2,
        complete: 1284,
        failed: 2,
        pausedByUser: paused,
        hold: null,
        bytesReceived: 7_340_032,
        totalBytes: 20_971_520,
        speedBps: 1_572_864,
        etaSeconds: 9,
        transfers: paused
          ? []
          : [
              {
                name: 'miraokafor_1790000000000000001_1.jpg',
                kind: 'photo',
                state: 'downloading',
                bytesReceived: 5_242_880,
                totalBytes: 10_485_760,
                speedBps: 1_048_576,
              },
              {
                name: 'archivedesk_1790000000000000005_1.mp4',
                kind: 'video',
                state: 'downloading',
                bytesReceived: 2_097_152,
                totalBytes: 10_485_760,
                speedBps: 524_288,
              },
            ],
        recent: [
          { name: 'junpark_1790000000000000002_1.jpg', kind: 'photo', state: 'complete', at: now - 60e3, error: '' },
          {
            name: 'lenswork_1780000000000000009_2.mp4',
            kind: 'video',
            state: 'failed',
            at: now - 120e3,
            error: 'Network error',
          },
        ],
        canManage,
      };
    } else if (url.pathname === '/api/downloads/control') {
      controlCalls.push(body);
      if (!canManage) {
        await route.fulfill({ status: 403, json: { error: 'Save media to PC is off for this phone' } });
        return;
      }
      if (body.action === 'pause') paused = true;
      if (body.action === 'resume') paused = false;
      data = { ok: true, count: body.action === 'retry' ? 2 : 0 };
    } else if (url.pathname === '/api/overview')
      data = {
        totals: {
          posts: 12840,
          media: 30211,
          images: 26000,
          videos: 4211,
          favorites: 932,
          notes: 41,
          later: 17,
          people: 1203,
        },
        months: Array.from({ length: 12 }, (_, i) => {
          const date = new Date(new Date().getFullYear(), new Date().getMonth() - 11 + i, 1);
          return {
            key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
            count: [120, 340, 90, 0, 610, 800, 450, 300, 980, 1200, 760, 515][i],
          };
        }),
        authors: [
          { handle: 'miraokafor', name: 'Mira Okafor', count: 812 },
          { handle: 'junpark', name: 'Jun Park', count: 455 },
          { handle: 'studioledger', name: 'Studio Ledger', count: 120 },
        ],
      };
    else if (url.pathname.startsWith('/api/media/')) {
      const index = Number(url.pathname.slice(-1)) || 1;
      await route.fulfill({
        contentType: 'image/svg+xml',
        body: svg(1200, 800, ['#8fb3c9', '#c9a98f', '#9fc98f', '#b49fc9'][index % 4]),
      });
      return;
    } else {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!STATIC.includes(name)) {
        await route.fulfill({ status: 404, body: '' });
        return;
      }
      await route.fulfill({
        body: await fs.readFile(path.join('FFmpeg_Helper/remote-ui', name)),
        contentType: name.endsWith('.js')
          ? 'text/javascript'
          : name.endsWith('.css')
            ? 'text/css'
            : name.endsWith('.svg')
              ? 'image/svg+xml'
              : name.endsWith('.woff2')
                ? 'font/woff2'
                : name.endsWith('.png')
                  ? 'image/png'
                  : 'text/html',
      });
      return;
    }
    await route.fulfill({ json: data });
  });
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  const audit = async (label, include) => {
    await page.evaluate(axeSource);
    const result = await page.evaluate(
      target =>
        window.axe.run(target ? document.querySelector(target) : document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
        }),
      include || null
    );
    const bad = result.violations.filter(v => v.impact === 'serious' || v.impact === 'critical');
    assert.deepEqual(
      bad.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(' ')).join(', ')}`),
      [],
      `${label} has no serious or critical axe-core violations`
    );
  };
  const settle = () =>
    page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  // ── Feed cards ──
  await page.goto('http://127.0.0.1:8765/');
  await page.locator('.post-card').first().waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.card-media img')].every(image => image.complete && image.naturalWidth > 0)
  );
  assert.equal(await page.locator('#gallery').getAttribute('data-layout'), 'feed', 'feed is the default layout');
  assert.equal(await page.locator('.post-card').count(), ROWS.length);
  const first = page.locator('.post-card').nth(0);
  assert.equal(await first.locator('.avatar').textContent(), 'M', 'avatar is a monogram, never a fetched image');
  assert.equal(await first.locator('.card-name .verified').getAttribute('aria-label'), 'Verified');
  assert.equal(await first.locator('.card-media').getAttribute('data-count'), '3');
  assert.equal(await first.locator('.card-media .tile-media.has-media').count(), 3);
  assert.deepEqual(
    await first.locator('.chip').allTextContents(),
    ['Later', 'Note', '#coast'],
    'read-later, note and tag chips come from the record'
  );
  assert.deepEqual(
    await first.locator('.metric .sr-only').allTextContents(),
    ['42 replies', '318 reposts', '5,120 likes', '98,000 views'],
    'metrics carry exact counts for screen readers'
  );
  assert.deepEqual(
    await first.locator('.metric b').allTextContents(),
    ['42', '318', '5.1K', '98K'],
    'metrics display compact numbers'
  );
  const reply = page.locator('.post-card').nth(1);
  assert.match(await reply.locator('.card-context').textContent(), /Replying to @miraokafor/);
  assert.match(await reply.locator('.card-quote').textContent(), /Lens Work.*@lenswork.*Fog is a diffuser.*2 media/s);
  const linked = page.locator('.post-card').nth(2);
  assert.match(await linked.locator('.card-link').textContent(), /ledger\.example.*Keeping a private archive/s);
  assert.match(await linked.locator('.card-quote.is-missing').textContent(), /not in this archive/);
  const thread = page.locator('.post-card').nth(3);
  assert.match(await thread.locator('.card-context').textContent(), /Continues a thread/);
  assert.equal(await thread.locator('.media-more').textContent(), '+5', 'more media than the grid shows is counted');
  const pending = page.locator('.post-card').nth(4);
  assert.match(await pending.locator('.card-media-status').textContent(), /1 media.*not downloaded to PC yet/s);
  const targets = await page.locator('#gallery button').evaluateAll(buttons =>
    buttons
      .filter(button => button.offsetParent)
      .map(button => ({
        name: (button.getAttribute('aria-label') || button.textContent).trim(),
        w: button.getBoundingClientRect().width,
        h: button.getBoundingClientRect().height,
      }))
  );
  assert.ok(targets.length > 20);
  assert.ok(
    targets.every(target => target.name),
    'every card control has an accessible name'
  );
  assert.ok(
    targets.every(target => target.w >= 44 && target.h >= 44),
    `every card control is at least 44 × 44 px: ${JSON.stringify(targets.filter(t => t.w < 44 || t.h < 44))}`
  );
  await page.screenshot({ path: path.join(out, 'remote3-feed-390.png') });
  await audit('feed');

  // ── Bottom-sheet preview ──
  await reply.locator('.card-text').click();
  await page.locator('#actionSheet[open]').waitFor();
  assert.match(await page.locator('#sheetPreview').textContent(), /Jun Park.*Replying to @miraokafor/s);
  assert.equal(await page.locator('#sheetExtras .card-quote').count(), 1, 'the sheet repeats the quoted post');
  await settle();
  await page.screenshot({ path: path.join(out, 'remote3-sheet-390.png') });
  await audit('post sheet', '#actionSheet');
  await page.keyboard.press('Escape');
  await page.locator('#actionSheet[open]').waitFor({ state: 'detached' });

  // ── Layout switch persists ──
  await page.locator('#layoutToggle [data-layout="grid"]').click();
  await page.waitForFunction(() => document.querySelector('#gallery').dataset.layout === 'grid');
  await page.locator('.post-tile:not(.post-card)').first().waitFor();
  assert.equal(await page.locator('.post-card').count(), 0);
  assert.equal(await page.locator('#layoutToggle [data-layout="grid"]').getAttribute('aria-checked'), 'true');
  await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running'));
  await page.screenshot({ path: path.join(out, 'remote3-grid-390.png') });
  await page.reload();
  await page.locator('.post-tile').first().waitFor();
  assert.equal(await page.locator('#gallery').getAttribute('data-layout'), 'grid', 'the chosen layout is remembered');
  await page.locator('#layoutToggle [data-layout="feed"]').click();
  await page.locator('.post-card').first().waitFor();

  // ── Downloads monitor ──
  await page.locator('[data-view="downloadsView"]').click();
  await page.locator('.dl-hero').waitFor();
  assert.match(await page.locator('.dl-hero').textContent(), /Downloading 2.*1\.5 MB\/s/s);
  assert.equal(await page.locator('.dl-hero .dl-bar').getAttribute('aria-valuenow'), '35');
  assert.equal(await page.locator('#navDownloadsBadge').textContent(), '5', 'badge counts active + queued');
  assert.deepEqual(await page.locator('#downloadsView .stat b').allTextContents(), ['3', '2', '1.3K', '2']);
  assert.equal(await page.locator('.dl-list').nth(0).locator('.dl-row').count(), 2);
  assert.equal(await page.locator('.dl-row.is-failed').count(), 1);
  await settle();
  await page.screenshot({ path: path.join(out, 'remote3-downloads-390.png') });
  await audit('downloads', '#downloadsView');
  await page.locator('.dl-controls button', { hasText: 'Pause queue' }).click();
  await page.locator('.dl-hero.is-paused').waitFor();
  assert.match(await page.locator('.dl-hero').textContent(), /Queue paused/);
  await page.locator('.dl-controls button', { hasText: 'Retry failed' }).click();
  await page.locator('.toast', { hasText: 'Retrying 2 failed downloads' }).waitFor();
  await page.locator('.dl-controls button', { hasText: 'Resume queue' }).click();
  await page.locator('.dl-hero.is-active').waitFor();
  assert.deepEqual(
    controlCalls.map(call => call.action),
    ['pause', 'retry', 'resume'],
    'only the supported queue actions are sent'
  );
  const pollsBefore = downloadPolls.length;
  await page.waitForTimeout(3400);
  assert.ok(downloadPolls.length > pollsBefore, 'the monitor refreshes while visible');
  await page.locator('[data-view="libraryView"]').click();
  const pollsAfterLeave = downloadPolls.length;
  await page.waitForTimeout(3600);
  assert.equal(downloadPolls.length, pollsAfterLeave, 'polling stops when the Downloads view is hidden');

  // ── Overview ──
  await page.locator('[data-view="overviewView"]').click();
  await page.locator('.ov-bar').first().waitFor();
  assert.deepEqual(await page.locator('#overviewView .stat b').allTextContents(), ['13K', '30K', '1.2K', '932']);
  assert.equal(await page.locator('.ov-bar').count(), 12);
  assert.equal(await page.locator('.ov-author').count(), 3);
  await settle();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, 'remote3-overview-390.png') });
  await audit('overview', '#overviewView');
  await page.locator('.ov-bar').last().click();
  await page.locator('#libraryView:not([hidden])').waitFor();
  await page.waitForFunction(() =>
    /archived-after:\d{4}-\d{2}-01 archived-before:\d{4}-\d{2}-01/.test(document.querySelector('#searchInput').value)
  );
  await page.locator('[data-view="overviewView"]').click();
  await page.locator('.ov-author').first().click();
  await page.waitForFunction(() => document.querySelector('#searchInput').value === 'from:miraokafor');
  await page.waitForFunction(() => document.querySelector('#gallery').getAttribute('aria-busy') === 'false');
  assert.ok(
    libraryCalls.some(call => JSON.stringify(call).includes('from:miraokafor')),
    'the people list runs a real Library search'
  );
  assert.ok(libraryCalls.some(call => JSON.stringify(call).includes('archived-after:')));
  await page.locator('#clearQuery').click();
  await page.locator('.post-card').first().waitFor();

  // ── Viewer gestures ──
  await page.locator('.post-card').first().locator('.tile-media.has-media').first().click();
  await page.locator('#viewer[open] #viewerStage img').waitFor();
  await page.waitForFunction(() => document.querySelector('#viewerStage img').naturalWidth > 0);
  assert.equal(await page.locator('#viewerZoom').isVisible(), true, 'images offer a zoom button');
  const stage = await page.locator('#viewerStage img').boundingBox();
  const cx = stage.x + stage.width / 2,
    cy = stage.y + stage.height / 2;
  await page.mouse.click(cx, cy);
  await page.mouse.click(cx, cy);
  await page.waitForFunction(() => document.querySelector('#viewerStage').classList.contains('zoomed'));
  assert.match(await page.locator('#viewerStage img').getAttribute('style'), /scale\(2\.5\)/, 'double-tap zooms in');
  assert.equal(await page.locator('#viewerZoom').getAttribute('aria-pressed'), 'true');
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy + 40, { steps: 6 });
  await page.mouse.up();
  assert.match(
    await page.locator('#viewerStage img').getAttribute('style'),
    /translate\(\d/,
    'dragging pans the zoomed image'
  );
  assert.equal(await page.locator('#viewerPosition').textContent(), '1 / 3', 'panning never switches media');
  await page.keyboard.press('0');
  await page.waitForFunction(() => !document.querySelector('#viewerStage').classList.contains('zoomed'));
  await page.keyboard.press('+');
  await page.waitForFunction(() => document.querySelector('#viewerStage').classList.contains('zoomed'));
  await page.locator('#viewerZoom').click();
  await page.waitForFunction(() => !document.querySelector('#viewerStage').classList.contains('zoomed'));
  // two-finger pinch through real touch events
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  await touch('touchStart', [
    { x: cx - 30, y: cy, id: 1 },
    { x: cx + 30, y: cy, id: 2 },
  ]);
  for (let step = 1; step <= 6; step++)
    await touch('touchMove', [
      { x: cx - 30 - step * 12, y: cy, id: 1 },
      { x: cx + 30 + step * 12, y: cy, id: 2 },
    ]);
  await touch('touchEnd', []);
  await page.waitForFunction(() => document.querySelector('#viewerStage').classList.contains('zoomed'));
  const pinched = await page.locator('#viewerStage img').getAttribute('style');
  const scale = Number(/scale\(([\d.]+)\)/.exec(pinched)?.[1]);
  assert.ok(scale > 1.8 && scale <= 4, `pinch zooms with the fingers (scale ${scale})`);
  await page.keyboard.press('0');
  await page.waitForFunction(() => !document.querySelector('#viewerStage').classList.contains('zoomed'));
  // swipe left moves to the next media
  await page.mouse.move(cx + 80, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 80, cy, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('#viewerPosition').textContent === '2 / 3');
  await page.waitForFunction(
    () =>
      document.querySelector('#viewerStage img')?.naturalWidth > 0 &&
      !document.getAnimations().some(animation => animation.playState === 'running')
  );
  await page.screenshot({ path: path.join(out, 'remote3-viewer-390.png') });
  // swipe down closes
  await page.mouse.move(cx, cy - 40);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 160, { steps: 8 });
  await page.mouse.up();
  await page.locator('#viewer[open]').waitFor({ state: 'detached' });

  // ── Read-only phone: watch, never control ──
  canManage = false;
  await page.reload();
  await page.locator('.post-card').first().waitFor();
  await page.locator('[data-view="downloadsView"]').click();
  await page.locator('.dl-hero').waitFor();
  assert.equal(await page.locator('.dl-controls').count(), 0, 'no queue controls without Save media to PC');
  assert.match(await page.locator('#downloadsBody').textContent(), /can watch the queue/);
  await page.locator('[data-view="libraryView"]').click();

  // ── Themes and viewports ──
  for (const theme of ['graphite', 'oled', 'paper']) {
    await page.evaluate(value => {
      const select = document.querySelector('#remoteTheme');
      select.value = value;
      select.dispatchEvent(new Event('change'));
    }, theme);
    await settle();
    await page.screenshot({ path: path.join(out, `remote3-feed-${theme}-390.png`) });
    if (theme !== 'graphite') await audit(`feed (${theme})`, '#libraryView');
  }
  await page.evaluate(() => {
    const select = document.querySelector('#remoteTheme');
    select.value = 'graphite';
    select.dispatchEvent(new Event('change'));
  });
  for (const [width, height] of [
    [320, 700],
    [768, 1024],
    [1440, 900],
  ]) {
    await page.setViewportSize({ width, height });
    await settle();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal overflow at ${width}px`);
    await page.screenshot({ path: path.join(out, `remote3-feed-${width}.png`) });
  }

  // ── Reduced motion ──
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-view="overviewView"]').click();
  await page.locator('.ov-bar').first().waitFor();
  assert.equal(
    await page
      .locator('.ov-bar i')
      .first()
      .evaluate(bar => getComputedStyle(bar).animationName),
    'none',
    'reduced motion removes the chart animation'
  );
  assert.deepEqual(errors, []);
  console.log(`Phone Remote 3.0 browser checks passed · ${out}`);
} finally {
  await browser.close();
}
