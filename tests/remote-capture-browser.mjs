// Phone Remote 4.0 in a real browser: the Capture view (paste several links, live inbox states, retry, filters,
// remove, the on-phone outbox while the computer is unreachable, the Web Share Target /share route, the
// permission-off state) and archived avatars served by the Companion (one request per author, monogram fallback).
// Usage: node tests/remote-capture-browser.mjs [playwright module path] [chromium executable]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright'),
  axeSource = await fs.readFile(require.resolve('axe-core/axe.min.js'), 'utf8'),
  out = path.join(os.tmpdir(), 'xvault-remote-capture');
await fs.mkdir(out, { recursive: true });
const STATIC = [
  'index.html',
  'remote.js',
  'remote-drafts.js',
  'remote-capture.js',
  'remote.css',
  'app-icon.svg',
  'manifest.webmanifest',
  'app-icon-192.png',
  'app-icon-512.png',
  'remote-font.woff2',
];

// A real 48 × 48 PNG portrait, so the avatar path decodes an actual image.
function portrait(hue) {
  const size = 48,
    rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(0);
    for (let x = 0; x < size; x++) {
      const face = (x - 24) ** 2 + (y - 19) ** 2 < 100,
        body = (x - 24) ** 2 + (y - 52) ** 2 < 420;
      rows.push(...(face ? [246, 214, 190] : body ? [40 + hue, 70, 150] : [110 + x * 2, 120 + y * 2, 200 - hue]));
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buffer => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const AVATARS = { miraokafor: portrait(10), lenswork: portrait(80) };
const now = Date.now();
const post = (id, handle, name, text) => ({
  id,
  name,
  handle,
  text,
  link: `https://x.com/${handle}/status/${id}`,
  createdAt: new Date(now - 3 * 86400e3).toISOString(),
  archivedAt: now,
  media: [],
  mediaCount: 0,
  mediaState: 'none',
});
const ROWS = [
  post('1790000000000000001', 'miraokafor', 'Mira Okafor', 'Morning light over the harbour.'),
  post('1790000000000000002', 'miraokafor', 'Mira Okafor', 'Second post by the same author.'),
  post('1790000000000000003', 'nobodyyet', 'Nobody Yet', 'An author without an archived avatar.'),
];
const PREVIEWS = {
  '1790000000000000101': { name: 'Mira Okafor', handle: 'miraokafor', text: 'Tide tables for the week, with notes.' },
  '1790000000000000102': {
    name: 'Lens Work',
    handle: 'lenswork',
    text: 'Fog is a diffuser. Shoot into it.',
    mediaCount: 2,
  },
  '1790000000000000109': {
    name: 'Lens Work',
    handle: 'lenswork',
    text: 'Shared from the X app.',
    mediaCount: 1,
    video: true,
  },
};

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
  let canCapture = true,
    offline = false;
  const inbox = [],
    captureCalls = [],
    controlCalls = [],
    avatarCalls = [],
    downloadControls = [];
  const snapshot = () => {
    const counts = Object.fromEntries(
      ['queued', 'waiting', 'capturing', 'archived', 'duplicate', 'unavailable', 'failed'].map(key => [
        key,
        inbox.filter(item => item.state === key).length,
      ])
    );
    return {
      ok: true,
      paused: false,
      pending: counts.queued + counts.waiting + counts.capturing,
      counts,
      items: inbox.map(item => ({ ...item })),
    };
  };
  // Each inbox read moves work forward one step, like the computer's single background tab.
  const advance = () => {
    const busy = inbox.find(item => item.state === 'capturing');
    if (busy) {
      const missing = busy.id.endsWith('404');
      Object.assign(busy, {
        state: missing ? 'unavailable' : 'archived',
        error: missing ? 'X shows this post as deleted or protected' : '',
        preview: missing ? null : PREVIEWS[busy.id] || null,
        updatedAt: Date.now(),
      });
      return;
    }
    const next = inbox.find(item => item.state === 'queued');
    if (next) Object.assign(next, { state: 'capturing', attempts: next.attempts + 1, updatedAt: Date.now() });
  };
  await context.addInitScript(() => {
    localStorage.setItem('xvault.remote.device.v1', JSON.stringify({ deviceId: 'fixture', name: 'Phone' }));
    localStorage.setItem('xvault.remote.install-dismissed', '1');
  });
  await context.route('http://127.0.0.1:8766/**', async route => {
    const url = new URL(route.request().url()),
      body = route.request().postDataJSON();
    let data;
    if (url.pathname.startsWith('/api/capture') && offline) return route.abort('internetdisconnected');
    if (url.pathname === '/api/session')
      data = {
        deviceId: 'fixture',
        name: 'Phone',
        motion: 'normal',
        libraryRevision: 1,
        permissions: ['library.read', 'media.read', 'downloads.manage', ...(canCapture ? ['capture.create'] : [])],
      };
    else if (url.pathname === '/api/library')
      data = { rows: ROWS, matched: ROWS.length, matchedExact: true, nextCursor: null, hasMore: false };
    else if (url.pathname === '/api/views') data = { rows: [] };
    else if (url.pathname === '/api/downloads')
      data = {
        countsReady: true,
        queued: 4,
        downloading: 1,
        active: 1,
        complete: 10,
        failed: 0,
        pausedByUser: false,
        hold: null,
        bytesReceived: 0,
        totalBytes: 0,
        speedBps: 0,
        etaSeconds: null,
        transfers: [
          {
            name: 'miraokafor_1790000000000000001_1.jpg',
            kind: 'photo',
            state: 'downloading',
            postId: '1790000000000000001',
            bytesReceived: 10,
            totalBytes: 100,
            speedBps: 5,
            downloadId: 41,
          },
        ],
        pausedHosts: ['video.twimg.com'],
        upNext: [
          { name: 'lenswork_1790000000000000102_1.jpg', kind: 'photo', postId: '1790000000000000102' },
          { name: 'lenswork_1790000000000000109_1.mp4', kind: 'video', postId: '1790000000000000109' },
        ],
        recent: [],
        canManage: true,
      };
    else if (url.pathname === '/api/downloads/control') {
      downloadControls.push(body);
      data = { ok: true, count: 1 };
    } else if (url.pathname === '/api/activity') data = { rows: [] };
    else if (url.pathname.startsWith('/api/avatar/')) {
      const handle = decodeURIComponent(url.pathname.split('/').pop());
      avatarCalls.push(handle);
      const bytes = AVATARS[handle.toLowerCase()];
      if (bytes) return route.fulfill({ body: bytes, contentType: 'image/png' });
      return route.fulfill({ status: 404, json: { error: 'No archived avatar for this author' } });
    } else if (url.pathname === '/api/capture' && route.request().method() === 'POST') {
      if (!canCapture) return route.fulfill({ status: 403, json: { error: 'no capture.create' } });
      captureCalls.push(body);
      const match = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/.exec(body.url || '');
      assert.ok(match, `the phone sends canonical x.com links: ${body.url}`);
      const [, handle, id] = match;
      let duplicate = null;
      if (inbox.some(item => item.id === id)) duplicate = 'pending';
      else
        inbox.unshift({
          id,
          handle: handle === 'i' ? '' : handle,
          url: body.url,
          state: 'queued',
          error: '',
          source: body.via === 'share' ? 'share' : 'remote',
          device: 'Phone',
          mine: true,
          attempts: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          preview: null,
        });
      data = { ...snapshot(), added: [{ ...inbox.find(item => item.id === id), duplicate }], id };
    } else if (url.pathname === '/api/capture') {
      if (!canCapture) return route.fulfill({ status: 403, json: { error: 'no capture.create' } });
      advance();
      data = snapshot();
    } else if (url.pathname === '/api/capture/control') {
      controlCalls.push(body);
      if (body.action === 'retry')
        Object.assign(
          inbox.find(item => item.id === body.id),
          { state: 'queued', error: '' }
        );
      if (body.action === 'remove')
        inbox.splice(
          inbox.findIndex(item => item.id === body.id),
          1
        );
      if (body.action === 'clear')
        for (let i = inbox.length - 1; i >= 0; i--)
          if (['archived', 'duplicate', 'unavailable', 'failed'].includes(inbox[i].state)) inbox.splice(i, 1);
      data = snapshot();
    } else {
      const name = url.pathname === '/' || url.pathname === '/share' ? 'index.html' : url.pathname.slice(1);
      if (!STATIC.includes(name)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({
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
                  : name.endsWith('.webmanifest')
                    ? 'application/manifest+json'
                    : 'text/html',
      });
    }
    await route.fulfill({ json: data });
  });
  const page = await context.newPage(),
    errors = [];
  page.setDefaultTimeout(10000);
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
  const quiet = () =>
    page.waitForFunction(
      () =>
        !document
          .getAnimations()
          .some(
            animation => animation.playState === 'running' && animation.effect?.getTiming?.().iterations !== Infinity
          )
    );

  // ── Archived avatars ──
  await page.goto('http://127.0.0.1:8766/');
  await page.locator('.post-card').first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.post-card .avatar.has-image').length === 2);
  assert.match(await page.locator('.post-card .avatar.has-image img').first().getAttribute('src'), /^blob:/);
  assert.equal(
    await page.locator('.post-card').nth(2).locator('.avatar').textContent(),
    'N',
    'an author without an archived avatar keeps the monogram'
  );
  assert.equal(await page.locator('.post-card').nth(2).locator('.avatar img').count(), 0);
  assert.deepEqual(avatarCalls.sort(), ['miraokafor', 'nobodyyet'], 'one avatar request per author, misses included');
  await settle();
  await page.screenshot({ path: path.join(out, 'remote4-avatars-390.png') });

  // ── Capture: empty inbox ──
  assert.deepEqual(await page.locator('.bottom-nav .nav-item span').allTextContents(), [
    'Library',
    'Capture',
    'Downloads',
    'Overview',
    'Phone',
  ]);
  await page.locator('[data-view="captureView"]').click();
  await page.locator('#captureView .capture-empty').waitFor();
  assert.match(await page.locator('#captureView .capture-empty').textContent(), /Your inbox is empty/);
  assert.equal(await page.locator('#captureSend').isDisabled(), true, 'nothing to send yet');
  await quiet();
  await page.screenshot({ path: path.join(out, 'remote4-capture-empty-390.png') });
  await audit('empty capture view', '#captureView');

  // ── Paste several links (with noise, a mirror host and an /i/web link) ──
  await page
    .locator('#captureInput')
    .fill(
      'look https://twitter.com/miraokafor/status/1790000000000000101?s=20 and x.com/i/web/status/1790000000000000102, also https://example.com/a and https://fxtwitter.com/lenswork/status/1790000000000000404.'
    );
  assert.equal(await page.locator('#captureSendLabel').textContent(), 'Save 3 posts');
  assert.match(await page.locator('#captureHint').textContent(), /3 posts ready/);
  await page.locator('#captureSend').click();
  await page.locator('.toast', { hasText: '3 links sent to XVault' }).waitFor();
  assert.deepEqual(
    captureCalls.map(call => [call.url, call.via]),
    [
      ['https://x.com/miraokafor/status/1790000000000000101', 'paste'],
      ['https://x.com/i/status/1790000000000000102', 'paste'],
      ['https://x.com/lenswork/status/1790000000000000404', 'paste'],
    ],
    'links are canonicalised on the phone and sent one by one'
  );
  assert.equal(await page.locator('#captureInput').inputValue(), '', 'the box clears after a successful send');
  await page.waitForFunction(() => document.querySelectorAll('.capture-item').length === 3);

  // ── Live states while the computer captures ──
  await page.locator('.capture-item[data-state="capturing"]').first().waitFor();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.capture-item[data-state="archived"]').length === 2 &&
      document.querySelectorAll('.capture-item[data-state="unavailable"]').length === 1,
    null,
    { timeout: 20000 }
  );
  const saved = page.locator('.capture-item[data-id="1790000000000000102"]');
  assert.match(await saved.textContent(), /Lens Work.*@lenswork.*Fog is a diffuser.*Saved.*2 media · from this phone/s);
  assert.equal(await saved.locator('[data-capture-action="open"]').count(), 1, 'saved posts open in the Library');
  const missing = page.locator('.capture-item[data-state="unavailable"]');
  assert.match(await missing.textContent(), /Unavailable.*deleted or protected/s);
  assert.equal(await page.locator('#captureUpdated').textContent(), 'Up to date');
  await page.waitForFunction(() => document.querySelector('.capture-item .avatar.has-image'));
  const targets = await page.locator('#captureView button').evaluateAll(buttons =>
    buttons
      .filter(button => button.offsetParent)
      .map(button => ({
        name: (button.getAttribute('aria-label') || button.textContent).trim(),
        w: button.getBoundingClientRect().width,
        h: button.getBoundingClientRect().height,
      }))
  );
  assert.ok(
    targets.every(target => target.name),
    'every capture control has an accessible name'
  );
  assert.ok(
    targets.filter(target => !/^(All|Pending|Saved|Problems)/.test(target.name)).every(t => t.w >= 44 && t.h >= 44),
    `capture controls are at least 44 × 44 px: ${JSON.stringify(targets.filter(t => t.w < 44 || t.h < 44))}`
  );
  await quiet();
  await page.screenshot({ path: path.join(out, 'remote4-capture-inbox-390.png') });
  await audit('capture inbox', '#captureView');

  // ── Filters, retry, remove ──
  await page.locator('[data-capture-filter="problem"]').click();
  assert.equal(await page.locator('.capture-item').count(), 1);
  assert.equal(await page.locator('[data-capture-filter="problem"]').getAttribute('data-count'), '1');
  await missing.locator('[data-capture-action="retry"]').click();
  await page.locator('.toast', { hasText: 'Trying again on your computer' }).waitFor();
  await page.locator('[data-capture-filter="all"]').click();
  await page.locator('.capture-item[data-id="1790000000000000404"]').waitFor();
  await page.locator('.capture-item[data-id="1790000000000000404"] [data-capture-action="remove"]').click();
  await page.waitForFunction(() => !document.querySelector('.capture-item[data-id="1790000000000000404"]'));
  assert.deepEqual(
    controlCalls.map(call => call.action),
    ['retry', 'remove']
  );

  // ── Show in Library jumps to an id: search ──
  await saved.locator('[data-capture-action="open"]').click();
  await page.waitForFunction(() => !document.querySelector('#libraryView').hidden);
  assert.equal(await page.locator('#searchInput').inputValue(), 'id:1790000000000000102');
  await page.locator('[data-view="captureView"]').click();

  // ── Computer unreachable: the link waits on the phone ──
  offline = true;
  await page.locator('#captureInput').fill('https://x.com/lenswork/status/1790000000000000108');
  await page.locator('#captureSend').click();
  await page.locator('#captureOutbox:not([hidden])').waitFor();
  assert.match(await page.locator('#captureOutbox').textContent(), /1 link waiting on this phone/);
  assert.equal(await page.locator('#captureUpdated').textContent(), 'Offline');
  assert.equal(await page.locator('#captureInput').inputValue(), '', 'a kept link leaves the box');
  assert.equal(
    await page.evaluate(() => JSON.parse(localStorage.getItem('xvault.remote.capture-outbox.v1')).length),
    1
  );
  await quiet();
  await page.screenshot({ path: path.join(out, 'remote4-capture-offline-390.png') });
  offline = false;
  const before = captureCalls.length;
  await page.locator('#captureOutbox button', { hasText: 'Send now' }).click();
  await page.locator('.toast', { hasText: 'Waiting link sent to XVault' }).waitFor();
  assert.equal(captureCalls.length, before + 1);
  await page.locator('#captureOutbox[hidden]').waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => localStorage.getItem('xvault.remote.capture-outbox.v1')), null);

  // ── Web Share Target: /share?title=&text= opens Capture and sends at once ──
  await page.goto(
    'http://127.0.0.1:8766/share?title=Post&text=' +
      encodeURIComponent('Check this out https://x.com/lenswork/status/1790000000000000109?s=46&t=abc')
  );
  await page.locator('#captureView:not([hidden])').waitFor();
  await page.waitForFunction(() => location.pathname === '/');
  await page.waitForFunction(() => document.querySelector('.capture-item[data-id="1790000000000000109"]'));
  assert.deepEqual(captureCalls.at(-1), { url: 'https://x.com/lenswork/status/1790000000000000109', via: 'share' });
  assert.equal(await page.locator('[data-view="captureView"]').getAttribute('aria-current'), 'page');
  await page.waitForFunction(
    () => document.querySelector('.capture-item[data-id="1790000000000000109"]')?.dataset.state === 'archived',
    null,
    { timeout: 20000 }
  );

  // ── Downloads: Up next with per-post "Download next" ──
  await page.locator('[data-view="downloadsView"]').click();
  await page.locator('.dl-row', { hasText: 'lenswork_1790000000000000109_1.mp4' }).waitFor();
  const next = page.locator('.dl-row', { hasText: 'lenswork_1790000000000000109_1.mp4' });
  assert.match(await next.textContent(), /Video · queued/);
  await next.locator('button[aria-label^="Download"]').click();
  await page.locator('.toast', { hasText: '1 file moved to the front' }).waitFor();
  assert.deepEqual(downloadControls, [{ action: 'prioritize', postId: '1790000000000000109' }]);
  await settle();
  await page.screenshot({ path: path.join(out, 'remote4-downloads-next-390.png') });
  await audit('downloads up next', '#downloadsView');
  // Per-transfer pause/cancel and pause by media host (images keep going while video is held, and back).
  const transfer = page.locator('.dl-row', { hasText: 'miraokafor_1790000000000000001_1.jpg' });
  assert.equal(await transfer.locator('button[aria-label^="Cancel"]').count(), 1);
  await transfer.locator('button[aria-label^="Pause"]').click();
  await page.locator('.toast', { hasText: 'Transfer paused' }).waitFor();
  assert.deepEqual(downloadControls.at(-1), { action: 'pause-item', downloadId: 41 });
  const video = page.locator('.dl-host', { hasText: 'Video paused' });
  assert.equal(await video.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.dl-host', { hasText: /^Images$/ }).getAttribute('aria-pressed'), 'false');
  await page.locator('.dl-host', { hasText: /^Images$/ }).click();
  await page.locator('.toast', { hasText: 'Images downloads paused' }).waitFor();
  assert.deepEqual(downloadControls.at(-1), { action: 'pause-host', host: 'pbs.twimg.com' });
  await page.locator('.dl-host', { hasText: 'Video paused' }).click();
  assert.deepEqual(downloadControls.at(-1), { action: 'resume-host', host: 'video.twimg.com' });
  await settle();
  await page.screenshot({ path: path.join(out, 'remote4-downloads-hosts-390.png') });
  await transfer.locator('button[aria-label^="Show the post"]').click();
  assert.equal(await page.locator('#searchInput').inputValue(), 'id:1790000000000000001');
  await page.locator('[data-view="captureView"]').click();

  // ── Widths ──
  for (const [width, height] of [
    [320, 700],
    [768, 1024],
  ]) {
    await page.setViewportSize({ width, height });
    await settle();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `no horizontal overflow at ${width}px`);
    await page.screenshot({ path: path.join(out, `remote4-capture-${width}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });

  // ── Permission off: explained, nothing sent, links kept ──
  canCapture = false;
  await page.reload();
  await page.locator('.post-card').first().waitFor();
  await page.locator('[data-view="captureView"]').click();
  await page.locator('#captureView .capture-empty').waitFor();
  assert.match(await page.locator('#captureView .capture-empty').textContent(), /Capture is off for this phone/);
  const sent = captureCalls.length;
  await page.locator('#captureInput').fill('https://x.com/lenswork/status/1790000000000000110');
  await page.locator('#captureSend').click();
  await page.locator('#captureNotice:not([hidden])').waitFor();
  assert.match(await page.locator('#captureNotice').textContent(), /Send posts to capture/);
  assert.equal(captureCalls.length, sent, 'no request without the permission');
  await page.locator('[data-view="settingsView"]').click();
  assert.match(await page.locator('#permissionList').textContent(), /Send posts to capture\s*Off/);
  await page.locator('[data-view="captureView"]').click();
  await quiet();
  await page.screenshot({ path: path.join(out, 'remote4-capture-off-390.png') });
  await audit('capture off', '#captureView');

  assert.deepEqual(errors, []);
  console.log(`Phone Remote 4.0 capture checks passed · ${out}`);
} finally {
  await browser.close();
}
