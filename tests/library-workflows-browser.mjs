import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright');
const browser = await pw.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true }),
    errors = [],
    downloads = [];
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await page.goto('http://127.0.0.1:8765/tests/dashboard-harness.html?records=1250');
  await page.locator('iframe').waitFor({ state: 'attached' });
  const frame = page.frames().find(candidate => candidate !== page.mainFrame());
  if (!frame) throw new Error('Dashboard test iframe was not created');
  await frame.locator('#libraryView').waitFor({ state: 'attached', timeout: 30000 });
  await frame.locator('.nav[data-page="library"]').click();
  await frame.waitForFunction(
    () => window.XVaultLibraryRows?.().length === 50 && !document.querySelector('#list').hasAttribute('aria-busy')
  );
  const startup = await frame.evaluate(() => ({
    rows: XVaultLibraryRows().length,
    query: XVaultLibraryQueryState(),
    messages: window.__xvMessageLog,
  }));
  assert.equal(startup.rows, 50, 'Library startup should retain only its first page');
  assert.ok(
    !startup.messages.includes('GET_LIBRARY_ROWS') && !startup.messages.includes('GET_LIBRARY_CHUNK'),
    'normal Library startup must not fall back to whole-store reads'
  );
  await frame.locator('#libraryDownloadAll').waitFor({ state: 'attached' });
  assert.equal(
    await frame.locator('script[src="command-center.js"]').count(),
    1,
    'Command Center must be installed once'
  );
  await frame.locator('#libraryExportOpen').click();
  assert.equal(await frame.locator('#libraryExportDialog').evaluate(element => element.open), true);
  assert.match(
    await frame.locator('#libraryExportCount').textContent(),
    /remaining matches stream newest first in revision-checked pages/
  );
  assert.equal(
    await frame.locator('#libraryExportTxt').isDisabled(),
    false,
    'All matching links should stream even when only the first 50 posts are resident'
  );
  await frame.locator('#libraryExportBlock').press('Shift+Tab');
  assert.equal(await frame.evaluate(() => document.activeElement.closest('#libraryExportDialog') != null), true);
  const downloaded = page.waitForEvent('download');
  await frame.locator('#libraryExportTxt').click();
  const download = await downloaded,
    text = await fs.readFile(await download.path(), 'utf8');
  assert.equal(text.split(/\r?\n/).filter(Boolean).length, 1250);
  assert.ok(
    text
      .split(/\r?\n/)
      .filter(Boolean)
      .every(url => /^https:\/\/fixvx.com\/test\/status\/\d+$/.test(url))
  );
  await page.keyboard.press('Escape');
  assert.equal(await frame.evaluate(() => document.activeElement.id), 'libraryExportOpen');
  const downloadsBeforeCancel = downloads.length,
    queryCallsBeforeCancel = await frame.evaluate(() => window.__xvQueryCalls.length);
  await frame.evaluate(() => {
    const NativeWorker = window.Worker;
    window.__NativeWorker = NativeWorker;
    window.Worker = class PausingExportWorker extends NativeWorker {
      postMessage(message, ...rest) {
        if (message?.type === 'chunk') {
          window.__heldExportChunk = message;
          return;
        }
        return super.postMessage(message, ...rest);
      }
    };
  });
  await frame.locator('#libraryExportOpen').click();
  await frame.locator('#libraryExportTxt').click();
  await frame.waitForFunction(
    () => window.__heldExportChunk && document.querySelector('#libraryCancelExport')?.hidden === false
  );
  await frame.locator('#libraryCancelExport').click();
  await frame.waitForFunction(
    () => document.querySelector('#libraryExportProgress')?.textContent === 'Export cancelled'
  );
  assert.equal(
    downloads.length,
    downloadsBeforeCancel,
    'cancelling with a worker acknowledgement pending must not emit a partial TXT'
  );
  assert.ok(
    (await frame.evaluate(() => window.__xvQueryCalls.length)) > queryCallsBeforeCancel,
    'the cancelled export should have read one bounded cursor page'
  );
  assert.ok(
    await frame.evaluate(() => window.__xvMessageLog.includes('CANCEL_LIBRARY_QUERY')),
    'cancelling the worker should also cancel its IndexedDB query'
  );
  await frame.evaluate(() => {
    window.Worker = window.__NativeWorker;
    delete window.__heldExportChunk;
  });
  await page.keyboard.press('Escape');
  console.log('PASS streamed export cancellation while worker backpressure is pending');
  const downloadsBeforeConflict = downloads.length;
  await frame.evaluate(() => {
    const original = chrome.runtime.sendMessage;
    window.__armExportConflict = true;
    window.__exportPageRevisions = [];
    window.__exportPageResults = [];
    chrome.runtime.sendMessage = async message => {
      const result = await original(message);
      if (window.__armExportConflict && message.type === 'QUERY_LIBRARY_PAGE') {
        window.__exportPageRevisions.push(message.expectedRevision);
        window.__exportPageResults.push({ stale: !!result.stale, revision: result.revision });
        if (window.__exportPageRevisions.length === 1) window.__xvMutatePost('900000', { metrics: { likes: 777 } });
      }
      return result;
    };
  });
  await frame.locator('#libraryExportOpen').click();
  await frame.locator('#libraryExportTxt').click();
  await frame.waitForFunction(() =>
    document
      .querySelector('#libraryExportProgress')
      ?.textContent.startsWith('Export stopped - The archive changed during export')
  );
  const conflict = await frame.evaluate(() => ({
    revisions: window.__exportPageRevisions,
    results: window.__exportPageResults,
    rows: window.XVaultLibraryRows().length,
  }));
  assert.equal(
    conflict.revisions.length,
    2,
    'the export should request a second cursor page before detecting the mutation'
  );
  assert.equal(conflict.results[1].stale, true, 'the next page should reject its stale cursor revision');
  assert.equal(conflict.rows, 50, 'export must keep the dashboard page bounded');
  assert.equal(
    downloads.length,
    downloadsBeforeConflict,
    'a partial TXT must never be emitted after a revision conflict'
  );
  await frame.evaluate(() => {
    window.__armExportConflict = false;
  });
  await page.keyboard.press('Escape');
  console.log('PASS revision conflict cancels the streamed export without producing a partial file');
  console.log('PASS native export focus/return and streamed 1,250-link TXT download');
  await frame.locator('#search').fill('from:artist3');
  await frame.waitForFunction(() => {
    const state = window.XVaultLibraryQueryState?.();
    return (
      state?.rows === 50 &&
      state.loadedFor === state.queryKeyNow &&
      !state.busy &&
      document.querySelector('#libShown').textContent.endsWith('+')
    );
  });
  await frame.locator('#sort').selectOption('old');
  await frame.waitForFunction(() => {
    const state = window.XVaultLibraryQueryState?.();
    return (
      state?.loadedFor === state.queryKeyNow &&
      !state.busy &&
      document.querySelector('#list .tweet')?.dataset.id === '901249'
    );
  });
  await frame.locator('#libraryViewName').fill('Artist Three');
  await frame.locator('#librarySaveView').click();
  await frame.waitForFunction(() => document.querySelectorAll('#facetViews [data-view-index]').length === 1);
  await frame.locator('#search').fill('has:video');
  await frame.locator('#sort').selectOption('new');
  await frame.locator('#libraryViewName').fill('Pinned Videos');
  await frame.locator('#libraryCollectionIcon').selectOption('video');
  await frame.locator('#libraryView').selectOption('gallery');
  await frame.locator('#librarySaveView').click();
  await frame.waitForFunction(() => document.querySelectorAll('#facetViews [data-view-index]').length === 2);
  await frame.locator('#search').fill('from:artist1');
  await frame.locator('#sort').selectOption('new');
  await frame.locator('#facetViews [data-view-index="0"]').click();
  assert.equal(await frame.locator('#search').inputValue(), 'from:artist3');
  await frame.waitForFunction(
    () =>
      document.querySelector('#list .tweet')?.dataset.id === '901249' &&
      !document.querySelector('#list').hasAttribute('aria-busy')
  );
  assert.equal(await frame.locator('#sort').inputValue(), 'old', 'saved view must restore its sort');
  await frame.evaluate(async () => {
    await save({ motionLevel: 'off' }, false);
  });
  await frame.locator('#list .tweet').first().press('Space');
  assert.equal(
    await frame.locator('#xvQuickLook').evaluate(element => getComputedStyle(element).animationName),
    'none'
  );
  console.log('PASS Off preview open');
  await frame.locator('#xvQuickLookTitle').press('ArrowRight');
  assert.equal(
    await frame
      .locator('.xv-preview-stage > :first-child')
      .evaluate(element => getComputedStyle(element).animationName),
    'none'
  );
  await frame.evaluate(async () => {
    await save({ motionLevel: 'rich' }, false);
  });
  await frame.locator('#xvQuickLookTitle').press('ArrowLeft');
  assert.equal(
    await frame
      .locator('.xv-preview-stage > :first-child')
      .evaluate(element => getComputedStyle(element).animationName),
    'slidePrev'
  );
  if (process.argv[4]) await page.screenshot({ path: `${process.argv[4]}/quick-look.png`, animations: 'disabled' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(
    await frame
      .locator('.xv-preview-stage > :first-child')
      .evaluate(element => getComputedStyle(element).animationName),
    'none'
  );
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await frame.evaluate(async () => {
    await save({ motionLevel: 'normal' }, false);
  });
  console.log('PASS dynamic Smart Collections restore query/sort/layout and Off/Rich/system reduced preview motion');
  const firstCollectionOrder = await frame
    .locator('#facetViews [data-collection-id]')
    .evaluateAll(rows => rows.map(row => row.dataset.collectionId));
  await frame.locator('#facetViews [data-collection-id]').first().locator('[data-view-move="1"]').click();
  await frame.waitForFunction(
    previous => document.querySelector('#facetViews [data-collection-id]')?.dataset.collectionId === previous[1],
    firstCollectionOrder
  );
  const orderedNames = await frame
    .locator('#facetViews [data-view-index]')
    .evaluateAll(rows => rows.map(row => row.innerText.trim()));
  assert.match(orderedNames[0], /Pinned Videos/, 'keyboard-accessible collection ordering should persist');
  const collectionForm = await frame.locator('#libraryViewForm').evaluate(form => ({
    display: getComputedStyle(form).display,
    width: form.getBoundingClientRect().width,
    input: form.querySelector('input').getBoundingClientRect().width,
    right: form.getBoundingClientRect().right,
    facetRight: form.closest('.xv-facets').getBoundingClientRect().right,
  }));
  assert.equal(collectionForm.display, 'grid');
  assert.ok(collectionForm.input >= 150, 'the collection name field should use the sidebar width');
  assert.ok(collectionForm.right <= collectionForm.facetRight + 1, 'collection controls must not overflow the sidebar');
  if (process.argv[4])
    await page.screenshot({ path: `${process.argv[4]}/collections-sidebar-desktop.png`, animations: 'disabled' });
  const exportedFile = page.waitForEvent('download');
  await frame.locator('#libraryCollectionsExport').click();
  const collectionDownload = await exportedFile,
    collectionDocument = JSON.parse(await fs.readFile(await collectionDownload.path(), 'utf8'));
  assert.equal(collectionDocument.format, 'xvault-collections-v1');
  assert.equal(collectionDocument.collections.length, 2);
  assert.ok(
    collectionDocument.collections.every(item => !('posts' in item) && !('media' in item)),
    'portable collection files contain rules only'
  );
  assert.equal(collectionDocument.collections.find(item => item.name === 'Pinned Videos').icon, 'video');
  const importDocument = {
    format: 'xvault-collections-v1',
    collections: [
      {
        id: 'portable-artist-three',
        name: 'Artist Three',
        query: 'fav:true',
        sort: 'new',
        view: 'timeline',
        icon: 'favorite',
      },
      {
        id: 'portable-annotation-cues',
        name: 'Annotation cues',
        query: 'annotation:door',
        sort: 'new',
        view: 'timeline',
        icon: 'note',
      },
    ],
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.locator('#libraryCollectionsFile').setInputFiles({
    name: 'xvault-collections.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(importDocument)),
  });
  const importDialog = frame.locator('.xv-collection-import[open]');
  await importDialog.waitFor();
  assert.match(
    await importDialog.locator('.xv-collection-import-counts').textContent(),
    /1 new · 0 already present · 1 name\/rule conflicts/
  );
  assert.ok(
    await importDialog.evaluate(element => element.getBoundingClientRect().width <= innerWidth),
    'collection conflict preview should fit a 390px viewport'
  );
  if (process.argv[4])
    await page.screenshot({ path: `${process.argv[4]}/collections-import-narrow.png`, animations: 'disabled' });
  await importDialog.locator('[data-import-policy="skip"]').click();
  await importDialog.waitFor({ state: 'detached' });
  await frame.waitForFunction(() => document.querySelectorAll('#facetViews [data-view-index]').length === 3);
  assert.equal(
    await frame.evaluate(() => settings.savedViews.find(item => item.name === 'Artist Three').query),
    'from:artist3',
    'import preview/commit must preserve the existing conflicting query'
  );
  const importFile = {
    name: 'xvault-collections.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(importDocument)),
  };
  await frame.locator('#libraryCollectionsFile').setInputFiles(importFile);
  await frame.locator('.xv-collection-import[open]').waitFor();
  await frame.locator('.xv-collection-import [data-import-policy="keep-both"]').click();
  await frame.waitForFunction(() => document.querySelectorAll('#facetViews [data-view-index]').length === 4);
  assert.ok(
    await frame.evaluate(() =>
      settings.savedViews.some(item => item.name === 'Artist Three (imported)' && item.query === 'fav:true')
    )
  );
  await frame.locator('#libraryCollectionsFile').setInputFiles(importFile);
  await frame.locator('.xv-collection-import[open]').waitFor();
  assert.equal(
    await frame.locator('.xv-collection-import [data-import-policy="keep-both"]').isDisabled(),
    true,
    'reimporting the same file must not create another copy'
  );
  await frame.locator('.xv-collection-import [value="cancel"]').first().click();
  await frame.locator('.xv-collection-import').waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log(
    'PASS portable Smart Collection export, collision preview, keep-both import, reordering, and idempotent reimport'
  );
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await frame.evaluate(() => {
    const original = chrome.runtime.sendMessage;
    window.__mediaQueueAttempts = 0;
    chrome.runtime.sendMessage = message => {
      if (message.type === 'DOWNLOAD_URLS') window.__mediaQueueAttempts++;
      return original(message);
    };
  });
  const mediaButton = frame.locator('#list [data-dl-one]').first();
  await mediaButton.click();
  await frame.locator('.xv-media-menu').waitFor({ state: 'visible' });
  assert.equal(await frame.evaluate(() => document.activeElement.closest('.xv-media-menu') != null), true);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const expectedUrl = await frame.evaluate(
    () => window.XVaultLibraryRows().find(row => row.id === '901249').media[0].url
  );
  assert.equal(await frame.evaluate(() => navigator.clipboard.readText()), expectedUrl);
  assert.equal(
    await frame.evaluate(() => window.__mediaQueueAttempts),
    0,
    'Copy original URL must not queue a download'
  );
  assert.equal(await mediaButton.evaluate(button => document.activeElement === button), true);
  await mediaButton.click();
  await page.keyboard.press('Escape');
  assert.equal(await frame.locator('.xv-media-menu').count(), 0);
  console.log('PASS media menu uses current Library, copies without download, and restores keyboard focus');
  await frame.evaluate(() => {
    const original = chrome.runtime.sendMessage;
    window.__queuedPlans = [];
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'PLAN_LIBRARY_DOWNLOAD') {
        const delay = message.options.scope === 'all' ? 180 : 20;
        await new Promise(resolve => setTimeout(resolve, delay));
        return {
          ok: true,
          totals: {
            postsScanned: 125,
            postsMatched: message.options.scope === 'favorites' ? 1 : 125,
            media: message.options.scope === 'favorites' ? 1 : 93,
            needDownload: window.__emptyPlan ? 0 : 1,
          },
          items: window.__emptyPlan
            ? []
            : [
                {
                  post: { id: '900122', author: { handle: 'artist3' } },
                  media: { type: 'photo', url: 'https://pbs.twimg.com/media/fixture.jpg' },
                },
              ],
        };
      }
      if (message.type === 'START_LIBRARY_BULK_DOWNLOAD') {
        window.__queuedPlans.push(message.options);
        await new Promise(resolve => setTimeout(resolve, 80));
        return { ok: true, added: 1 };
      }
      return original(message);
    };
    document.querySelector('#libraryTools').open = true;
  });
  await frame.locator('#libraryDownloadAll').click();
  assert.equal(await frame.locator('.xv-bulk-modal').evaluate(element => element.open), true);
  await page.setViewportSize({ width: 390, height: 1000 });
  assert.ok(
    await frame.locator('.xv-bulk-modal').evaluate(element => element.scrollWidth <= element.clientWidth + 1),
    'planner must fit a narrow viewport'
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await frame.locator('[name="bulk-scope"]').selectOption('favorites');
  await frame.waitForFunction(() => document.querySelector('#bulkPlanStatus').textContent === 'Plan ready');
  await frame.evaluate(() => new Promise(resolve => setTimeout(resolve, 220)));
  assert.match(
    await frame.locator('#bulkPlanSummary').innerText(),
    /^1\n/,
    'superseded scans cannot replace the latest plan'
  );
  await frame.evaluate(() => (window.__emptyPlan = true));
  await frame.locator('#bulkPlanRefresh').click();
  await frame.waitForFunction(() => document.querySelector('#bulkPlanStatus').textContent !== 'Scanning IndexedDB…');
  assert.equal(
    await frame.locator('#bulkStart').isDisabled(),
    true,
    'matching media with no planned files must not enable Start'
  );
  await frame.evaluate(() => (window.__emptyPlan = false));
  await frame.locator('#bulkPlanRefresh').click();
  await frame.waitForFunction(() => !document.querySelector('#bulkStart').disabled);
  if (process.argv[4])
    await page.screenshot({ path: `${process.argv[4]}/download-planner.png`, animations: 'disabled' });
  await frame.locator('[name="bulk-scope"]').press('Shift+Tab');
  assert.equal(await frame.evaluate(() => document.activeElement.closest('.xv-bulk-modal') != null), true);
  await frame.evaluate(() => {
    const start = document.querySelector('#bulkStart');
    start.click();
    start.click();
  });
  await frame.waitForFunction(() => !document.querySelector('.xv-bulk-modal'));
  assert.equal(await frame.evaluate(() => window.__queuedPlans.length), 1);
  assert.equal(await frame.evaluate(() => window.__queuedPlans[0].scope), 'favorites');
  await frame.evaluate(() => {
    document.querySelector('#libraryTools').open = true;
  });
  await frame.locator('#libraryDownloadAll').click();
  await page.keyboard.press('Escape');
  await frame.evaluate(() => new Promise(resolve => setTimeout(resolve, 220)));
  assert.equal(await frame.locator('.xv-bulk-modal').count(), 0);
  await frame.evaluate(() => {
    if (
      !window.__xvMutatePost('900000', {
        media: [{ type: 'photo', url: 'http://127.0.0.1:8765/__missing-preview.png' }],
      })
    )
      throw new Error('Could not prepare the missing-preview fixture');
    document.querySelector('#search').value = '';
    document.querySelector('#sort').value = 'new';
    window.XVaultInvalidateLibraryCache();
    renderLib();
  });
  await frame.waitForFunction(
    () =>
      !document.querySelector('#list').hasAttribute('aria-busy') &&
      document.querySelector('#list .tweet')?.dataset.id === '900000'
  );
  await frame.locator('#list .tweet').first().press('Space');
  await frame.locator('.xv-preview-unavailable').waitFor({ state: 'visible' });
  assert.match(await frame.locator('.xv-preview-unavailable').innerText(), /archived text and metadata/);
  await page.keyboard.press('Escape');
  console.log('PASS failed preview retains metadata and offers retry/source recovery');
  assert.deepEqual(errors, []);
  console.log('PASS native planner focus, stale scan rejection, single Start, close during scan');
} finally {
  await browser.close();
}
