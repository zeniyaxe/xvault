import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const playwright = require(process.argv[2] || 'playwright');
const browser = await playwright.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8765/tests/dashboard-harness.html?idb=1&records=10000');
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('#libraryView'));
  const frame = page.frames().find(candidate => candidate !== page.mainFrame());
  await frame.locator('.nav[data-page="library"]').click();
  await frame.waitForFunction(
    () => window.XVaultLibraryQueryState?.().loaded && !document.querySelector('#list').hasAttribute('aria-busy')
  );
  await frame.locator('#sort').selectOption('likes');
  const cancelButton = frame.locator('#list [data-cancel-library-query]');
  await cancelButton.waitFor({ state: 'visible' });
  await cancelButton.focus();
  assert.equal(
    await cancelButton.evaluate(button => document.activeElement === button),
    true,
    'the scan cancellation action must be keyboard focusable'
  );
  await cancelButton.press('Enter');
  await frame.waitForFunction(() =>
    document.querySelector('#list [data-query-progress]')?.textContent.includes('Search canceled')
  );
  assert.equal(await frame.locator('#list .tweet').count(), 0, 'cancelled ranked scans must not publish partial rows');
  await frame.locator('#list [data-cancel-library-query]').click();
  await frame.waitForFunction(
    () => /Sorting archive · checked/.test(document.querySelector('#list [data-query-progress]')?.textContent || ''),
    null,
    { timeout: 5000 }
  );
  await frame.waitForFunction(
    () =>
      window.__xvRankMetrics?.length === 1 &&
      window.XVaultLibraryQueryState?.().loaded &&
      !document.querySelector('#list').hasAttribute('aria-busy'),
    null,
    { timeout: 60000 }
  );
  const firstPage = await frame.evaluate(() => ({
    ids: [...document.querySelectorAll('#list .tweet')].map(row => row.dataset.id),
    metric: window.__xvRankMetrics.at(-1),
    query: window.XVaultLibraryQueryState(),
    shown: document.querySelector('#libShown').textContent,
  }));
  assert.equal(firstPage.metric.scanned, 10000);
  assert.equal(firstPage.metric.cacheHit, false);
  assert.equal(firstPage.metric.recordsRead, 10050);
  assert.equal(firstPage.ids[0], '909999', 'most-liked query should sort the highest metric record first');
  await frame.evaluate(() => window.__xvSimulateWorkerRestart());
  // Library 5 keeps loading as the reader scrolls; turn that off so the footer's page buttons stay put.
  await frame.evaluate(() => save({ libraryAutoLoad: false }, false));
  await frame.locator('#libraryNext').click();
  await frame.waitForFunction(
    () =>
      window.XVaultLibraryQueryState?.().pageIndex === 1 &&
      window.XVaultLibraryQueryState?.().loaded &&
      !document.querySelector('#list').hasAttribute('aria-busy')
  );
  const secondPage = await frame.evaluate(() => ({
    ids: [...document.querySelectorAll('#list .tweet')].map(row => row.dataset.id),
    metric: window.__xvRankMetrics.at(-1),
  }));
  assert.equal(secondPage.metric.cacheHit, true, 'the next page should reuse the revision-matched rank plan');
  assert.equal(secondPage.metric.durableHit, true, 'a fresh worker cache should hydrate the plan from IndexedDB');
  assert.equal(secondPage.metric.scanned, 0);
  assert.equal(secondPage.metric.recordsRead, 50, 'a cache page should read only its selected records');
  assert.equal(
    secondPage.ids.some(id => firstPage.ids.includes(id)),
    false,
    'ranked pages must not repeat records'
  );
  await frame.locator('#sort').selectOption('random');
  await frame.waitForFunction(
    () => {
      const state = window.XVaultLibraryQueryState?.();
      return (
        state?.loaded &&
        !state.busy &&
        state.loadedFor === state.queryKeyNow &&
        document.querySelectorAll('#list .tweet').length > 0
      );
    },
    null,
    { timeout: 60000 }
  );
  const randomPage = await frame.evaluate(() => ({
    rows: window.XVaultLibraryRows().map(row => String(row.id)),
    cards: [...document.querySelectorAll('#list .tweet')].map(row => row.dataset.id),
    archived: window
      .XVaultLibraryRows()
      .map(row => String(row.id))
      .slice()
      .sort((a, b) => Number(b) - Number(a)),
  }));
  // Library 5 mounts the first block of cards, so the mounted cards are a prefix of the page.
  assert.deepEqual(
    randomPage.cards,
    randomPage.rows.slice(0, randomPage.cards.length),
    'the card renderer must preserve the cursor-backed randomized page order'
  );
  assert.notDeepEqual(
    randomPage.cards,
    randomPage.archived,
    'random order must not be silently replaced by the renderer’s former newest-first sort'
  );
  if (process.argv[4])
    await page.screenshot({ path: `${process.argv[4]}\\ranked-library.png`, animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      cancel: 'no partial rows published',
      firstPage: firstPage.metric,
      secondPage: secondPage.metric,
      shown: firstPage.shown,
    })
  );
} finally {
  await browser.close();
}
