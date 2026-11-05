import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright');
const browser = await pw.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
let saved = 'Original private note',
  fail = false,
  failRead = false,
  delay = 0,
  saves = 0,
  hostMotion = 'normal',
  sparseRequests = 0,
  cancelledRequests = 0,
  staleRequests = 0;
const sessionIds = new Set();
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(() =>
    localStorage.setItem('xvault.remote.device.v1', JSON.stringify({ deviceId: 'fixture', name: 'Test phone' }))
  );
  await context.route('http://127.0.0.1:8765/**', async route => {
    const url = new URL(route.request().url()),
      payload = route.request().postDataJSON();
    if (url.pathname === '/api/library') sessionIds.add(payload.sessionId);
    let value;
    if (url.pathname === '/api/library' && payload.query === 'stale') {
      staleRequests++;
      if (staleRequests === 2) {
        await route.fulfill({ status: 410, json: { error: 'Search results expired; refresh the search' } });
        return;
      }
      value =
        staleRequests === 1
          ? { rows: [], matched: 0, matchedExact: false, nextCursor: 'expired-cursor', hasMore: true, scanned: 2500 }
          : {
              rows: [
                {
                  id: '111111111',
                  handle: 'current_revision',
                  name: 'Fresh revision',
                  text: 'A stale cursor restarted from the current archive revision',
                  archivedAt: Date.now(),
                  media: [],
                },
              ],
              matched: 1,
              matchedExact: true,
              nextCursor: null,
              hasMore: false,
            };
    } else if (url.pathname === '/api/session')
      value = {
        deviceId: 'fixture',
        name: 'Test phone',
        motion: hostMotion,
        permissions: ['library.read', 'notes.write'],
      };
    else if (url.pathname === '/api/library' && payload.query === 'refresh') {
      cancelledRequests++;
      value =
        cancelledRequests === 1
          ? { rows: [], matched: 0, cancelled: true, matchedExact: false, hasMore: false }
          : {
              rows: [
                {
                  id: '555555555',
                  handle: 'fresh_match',
                  name: 'Fresh after archive change',
                  text: 'The cancelled scan restarted against current metadata',
                  archivedAt: Date.now(),
                  media: [],
                },
              ],
              matched: 1,
              matchedExact: true,
              nextCursor: null,
              hasMore: false,
            };
    } else if (url.pathname === '/api/library' && payload.query === 'rare') {
      sparseRequests++;
      value =
        sparseRequests === 1
          ? { rows: [], matched: 0, matchedExact: false, nextCursor: 'sparse-cursor', hasMore: true, scanned: 2500 }
          : {
              rows: [
                {
                  id: '987654321',
                  handle: 'rare_match',
                  name: 'Sparse match',
                  text: 'Found after another bounded scan',
                  archivedAt: Date.now(),
                  media: [],
                },
              ],
              matched: 1,
              matchedExact: true,
              nextCursor: null,
              hasMore: false,
              scanned: 2501,
            };
    } else if (url.pathname === '/api/library')
      value = {
        rows: [
          {
            id: '123456789',
            handle: 'long_author_name_for_archive',
            name: 'A deliberately long author name to test text truncation',
            text: 'Reference post with no media',
            archivedAt: Date.now(),
            media: [],
          },
        ],
        matched: 1,
        matchedExact: true,
        nextCursor: null,
        hasMore: false,
      };
    else if (url.pathname === '/api/note/read') {
      if (failRead) {
        await route.fulfill({ status: 502, json: { error: 'Offline fixture' } });
        return;
      }
      value = { ok: true, note: saved };
    } else if (url.pathname === '/api/note') {
      saves++;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (fail) {
        await route.fulfill({ status: 502, json: { error: 'Synthetic connection failure' } });
        return;
      }
      if (payload.expectedNote !== saved) {
        await route.fulfill({
          status: 409,
          json: { ok: false, conflict: true, note: saved, error: 'Note changed in desktop' },
        });
        return;
      }
      saved = payload.note;
      value = { ok: true, note: saved };
    } else {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (
        ![
          'index.html',
          'remote.css',
          'remote.js',
          'remote-capture.js',
          'app-icon.svg',
          'manifest.webmanifest',
          'remote-font.woff2',
        ].includes(name)
      ) {
        await route.fulfill({ status: 404, body: '' });
        return;
      }
      const body = await fs.readFile(path.join('FFmpeg_Helper/remote-ui', name));
      await route.fulfill({
        body,
        contentType: name.endsWith('.js')
          ? 'text/javascript'
          : name.endsWith('.css')
            ? 'text/css'
            : name.endsWith('.svg')
              ? 'image/svg+xml'
              : name.endsWith('.woff2')
                ? 'font/woff2'
                : 'text/html',
      });
      return;
    }
    await route.fulfill({ json: value });
  });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8765/');
  const open = async () => {
    await page.getByRole('button', { name: 'More post actions' }).click();
    await page.waitForFunction(() => !document.querySelector('#noteInput').disabled);
  };
  await open();
  assert.equal(await page.locator('#noteInput').inputValue(), saved);
  fail = true;
  await page.locator('#noteInput').fill('Retained phone draft');
  await page.locator('#noteSave').click();
  await page.waitForFunction(() => document.querySelector('#noteStatus').textContent.includes('Save failed'));
  await page.reload();
  await open();
  assert.equal(await page.locator('#noteInput').inputValue(), 'Retained phone draft');
  fail = false;
  saved = 'Desktop changed note';
  await page.locator('#noteSave').click();
  await page.locator('#noteConflict').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#noteSaved').inputValue(), 'Desktop changed note');
  assert.equal(await page.locator('#noteInput').inputValue(), 'Retained phone draft');
  if (process.argv[4]) await page.screenshot({ path: path.join(process.argv[4], 'remote-note-conflict.png') });
  await page.locator('#noteKeepDraft').click();
  await page.waitForFunction(() => document.querySelector('#noteStatus').textContent === 'Note saved.');
  assert.equal(saved, 'Retained phone draft');
  delay = 200;
  await page.locator('#noteInput').fill('First queued edit');
  await page.locator('#noteSave').click();
  await page.locator('#noteInput').fill('Newer typing while saving');
  await page.waitForFunction(() => document.querySelector('#noteStatus').textContent.includes('Newer edits'));
  await page.locator('#noteSave').click();
  await page.waitForFunction(() => document.querySelector('#noteStatus').textContent === 'Note saved.');
  assert.equal(saved, 'Newer typing while saving');
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.querySelector('#actionSheet').scrollWidth <= document.querySelector('#actionSheet').clientWidth
    ),
    true
  );
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#actionSheet').evaluate(el => el.open), false);
  await page.evaluate(base => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith('xvault.remote.note-draft:fixture:123456789:')) localStorage.removeItem(key);
    localStorage.setItem(
      'xvault.remote.note-draft:fixture:123456789',
      JSON.stringify({ value: 'Offline retained evidence', base })
    );
  }, saved);
  failRead = true;
  await open();
  await page.waitForFunction(() => document.querySelector('#noteStatus').textContent.includes('Could not read'));
  assert.equal(await page.locator('#noteInput').inputValue(), 'Offline retained evidence');
  assert.equal(await page.locator('#noteInput').evaluate(el => el.readOnly), true);
  failRead = false;
  await page.locator('#noteRetry').click();
  await page.waitForFunction(
    () => !document.querySelector('#noteInput').disabled && !document.querySelector('#noteInput').readOnly
  );
  await page.locator('#noteSave').click();
  await page.waitForFunction(() => document.querySelector('#noteStatus').textContent === 'Note saved.');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (process.argv[4]) await page.screenshot({ path: path.join(process.argv[4], 'remote-desktop.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open();
  assert.equal(await page.locator('#actionSheet').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  hostMotion = 'off';
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => document.documentElement.dataset.motion === 'off');
  assert.equal(await page.locator('#actionSheet').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.keyboard.press('Escape');
  await page.locator('#searchInput').fill('rare');
  await page.waitForFunction(() => document.querySelector('#loadStatus button')?.textContent === 'Continue search');
  assert.match(
    await page.locator('#gallery').innerText(),
    /Continue to search/,
    'an empty bounded scan must explain that more archive records remain'
  );
  assert.equal(
    await page.locator('#resultCount').innerText(),
    '0 found so far',
    'the Remote count must not claim an unfinished scan is complete'
  );
  if (process.argv[4]) await page.screenshot({ path: path.join(process.argv[4], 'remote-sparse-search-empty.png') });
  await page.locator('#continueSearch').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#gallery .post-tile')?.dataset.postId === '987654321');
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'loadStatus',
    'keyboard continuation should return focus to the updated result status'
  );
  assert.equal(await page.locator('#resultCount').innerText(), '1 post');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= innerWidth &&
        document.querySelector('#scrollRegion').scrollWidth <= document.querySelector('#scrollRegion').clientWidth
    ),
    true,
    'the sparse continuation control must fit a narrow Remote viewport'
  );
  await page.locator('#searchInput').fill('refresh');
  await page.waitForFunction(() => document.querySelector('#gallery .post-tile')?.dataset.postId === '555555555');
  assert.equal(
    cancelledRequests,
    2,
    'a mutation-cancelled request should restart once against the current archive revision'
  );
  await page.locator('#searchInput').fill('stale');
  await page.waitForFunction(() => document.querySelector('#continueSearch'));
  await page.locator('#continueSearch').click();
  await page.waitForFunction(() => document.querySelector('#gallery .post-tile')?.dataset.postId === '111111111');
  assert.equal(
    staleRequests,
    3,
    'an expired page cursor should rebuild once at the new revision and show current rows'
  );
  if (process.argv[4]) await page.screenshot({ path: path.join(process.argv[4], 'remote-sparse-search-narrow.png') });
  assert.equal(
    sessionIds.size,
    2,
    'Remote keeps one cancellation namespace per page lifetime and rotates it after reload'
  );
  assert.ok([...sessionIds].every(id => /^[0-9a-f-]{36}$/i.test(id || '')));
  assert.deepEqual(errors, []);
  console.log(
    `PASS Remote retained drafts, 409 comparison, query invalidation/restart, session isolation, 390/1440px layouts, Reduced motion (${saves} saves)`
  );
  await context.close();
} finally {
  await browser.close();
}
