// Full dashboard query and first render over a real, synthetic IndexedDB archive.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url), playwright = require(process.argv[2] || 'playwright');
const output = process.argv[4] || path.join(os.tmpdir(), 'xvault-indexeddb-ui-pass');
const browser = await playwright.chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.goto('http://127.0.0.1:8765/tests/dashboard-harness.html?records=10000&idb=1');
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('#libraryView'));
  const frame = page.frames().find(candidate => candidate !== page.mainFrame());
  await frame.waitForFunction(() => window.__xvMockReadyComplete === true, null, { timeout: 30000 });
  await frame.waitForFunction(() => window.__xvQueryCalls?.length === 1 && document.querySelectorAll('#homeRecent .recent-tile').length === 16, null, { timeout: 30000 });
  const startupBeforeLibrary = await frame.evaluate(() => ({ state: window.XVaultLibraryQueryState?.(), queryCalls: window.__xvQueryCalls?.length || 0 }));
  assert.equal(startupBeforeLibrary.queryCalls, 1, `Home should use exactly one small newest-post query: ${JSON.stringify(startupBeforeLibrary)}`);
  assert.notEqual(startupBeforeLibrary.state?.loaded, true, 'the Home screen should not retain an unused Library page');
  const homeQuery = await frame.evaluate(() => window.__xvQueryCalls[0]);
  assert.equal(homeQuery.limit, 16, 'Home recent posts should retain only its visible 16-record strip');
  assert.equal(homeQuery.scanLimit, 16, 'Home recent posts should not scan the full archive');
  const started = performance.now();
  await frame.locator('.nav[data-page="library"]').click();
  try { await frame.waitForFunction(() => {
    const state = window.XVaultLibraryQueryState?.();
    return state?.loaded && state.rows === 50 && state.loadedFor === state.queryKeyNow && !document.querySelector('#list').hasAttribute('aria-busy');
  }, null, { timeout: 10000 }); } catch (error) {
    console.log(JSON.stringify({ state: await frame.evaluate(() => ({ query: window.XVaultLibraryQueryState?.(), calls: window.__xvQueryCalls, messages: window.__xvMessageLog?.slice(-15), title: document.querySelector('#title')?.textContent, shown: document.querySelector('#libShown')?.textContent })), list: await frame.locator('#list').innerText().catch(() => ''), errors }));
    throw error;
  }
  const usableWallMs = performance.now() - started;
  const evidence = await frame.evaluate(() => ({
    state: window.XVaultLibraryQueryState(), metric: window.XVaultLibraryMetrics().at(-1),
    calls: window.__xvMessageLog, idb: { ...window.__xvIdbOperations }, firstRows: document.querySelectorAll('#list .tweet').length,
    allCount: document.querySelector('[data-destination="all"] .count')?.textContent
  }));
  await frame.waitForFunction(() => document.querySelector('[data-destination="all"]')?.title === 'Archive total is not calculated to keep Library paging fast.');
  const visibleAllCount = await frame.locator('[data-destination="all"] .count').textContent();
  assert.equal(evidence.state.rows, 50);
  assert.equal(evidence.metric.archiveRecords, null);
  assert.equal(evidence.metric.recordsRead, 50);
  assert.equal(evidence.metric.recordsMaterialized, 50);
  assert.equal(evidence.metric.searchProjectionRows, 0);
  assert.equal(evidence.metric.cursorOperations, 50);
  assert.equal(evidence.metric.plan, 'real IndexedDB descending archivedAt cursor');
  assert.equal(evidence.idb.getAll + evidence.idb.getAllKeys + evidence.idb.count + evidence.idb.indexCount, 0, 'normal Library opening must not call an IndexedDB whole-store read or count');
  assert.ok(evidence.metric.mainThreadLongTasks.every(task => task.duration < 100), `Library startup should not wait on a cold media/audio initialization task: ${JSON.stringify(evidence.metric.mainThreadLongTasks)}`);
  assert.ok(!evidence.calls.includes('GET_LIBRARY_ROWS') && !evidence.calls.includes('GET_LIBRARY_CHUNK'));
  assert.equal(visibleAllCount, '—');
  const pathologicalPost = frame.locator('.tweet[data-id="900000"]');
  const timelineText = pathologicalPost.locator('.tweetText');
  assert.ok((await timelineText.textContent()).length <= 1201, 'the timeline should bound the post text DOM instead of rendering the complete pathological record');
  assert.equal(await pathologicalPost.locator('.mediaItem').count(), 4, 'the timeline should bound per-post media DOM to four items');
  const mediaOverflow = pathologicalPost.locator('[data-media-more]');
  assert.equal(await mediaOverflow.textContent(), '+21 more media');
  await mediaOverflow.click();
  await frame.waitForFunction(() => !document.querySelector('#lightbox').classList.contains('hidden'));
  assert.equal(await frame.locator('#lbMeta small').textContent(), '1/65', 'the full viewer should still expose every media item across the loaded page');
  await frame.locator('#lbClose').click();
  await frame.waitForFunction(() => document.querySelector('#lightbox').classList.contains('hidden'));
  const fullTextButton = pathologicalPost.locator('.textOverflow');
  assert.match(await fullTextButton.getAttribute('aria-label'), /characters/);
  assert.doesNotMatch(await fullTextButton.textContent(), /\uFFFD/, 'long-text controls must not contain broken source-encoding glyphs');
  await fullTextButton.click();
  await frame.waitForFunction(() => !document.querySelector('#detailsDrawer').classList.contains('hidden'));
  assert.match(await frame.locator('#drawerBody > .tweetText').textContent(), /long-post-marker/,'Inspector should retain access to the complete archived post text');
  await frame.locator('#drawerClose').click();
  await frame.waitForFunction(() => document.querySelector('#detailsDrawer').classList.contains('hidden'));
  const pathologicalTags = frame.locator('.tweet[data-id="900000"] .tweetTags');
  assert.equal(await pathologicalTags.locator('[data-tag]').count(), 8, 'large tag lists should not create a button for every tag during first render');
  const tagDisclosure = pathologicalTags.locator('[data-expand-tags]');
  assert.equal(await tagDisclosure.getAttribute('aria-expanded'), 'false');
  await tagDisclosure.click();
  assert.equal(await pathologicalTags.locator('[data-tag]').count(), 80, 'all tags should remain reachable on explicit expansion');
  assert.equal(await tagDisclosure.getAttribute('aria-expanded'), 'true');
  await tagDisclosure.click();
  assert.equal(await pathologicalTags.locator('[data-tag]').count(), 8, 'expanded tags should collapse without rebuilding the Library page');
  await fs.mkdir(output, { recursive: true });
  await frame.locator('#list').evaluate(element => { element.scrollTop = 0; });
  await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: path.join(output, 'indexeddb-library-desktop.png'), animations: 'disabled' });
  await frame.locator('#search').fill('favorite:true');
  await frame.waitForFunction(() => {
    const state = window.XVaultLibraryQueryState?.();
    return state?.loadedFor === state?.queryKeyNow && state.rows === 50 && !state.busy;
  });
  assert.equal(await frame.locator('#list .tweet[data-id="900510"]').count(), 0, 'the real IndexedDB sync fixture should initially be outside favorite:true results');
  const queriesBeforeMetadata = await frame.evaluate(() => window.__xvQueryCalls.length);
  await frame.evaluate(async () => {
    if (!await window.__xvMutatePost('900510', { favorite: true })) throw Error('Could not update the off-page IndexedDB fixture');
    const channel = new BroadcastChannel('xvault-library-metadata');
    channel.postMessage({ ids: ['900510'] });
    channel.close();
  });
  await frame.waitForFunction(() => {
    const state = window.XVaultLibraryQueryState?.();
    return state?.loadedFor === state?.queryKeyNow && !state.busy && !!document.querySelector('#list .tweet[data-id="900510"]');
  }, null, { timeout: 15000 });
  const metadataSync = await frame.evaluate(() => ({
    records: [...document.querySelectorAll('#list .tweet')].map(node => node.dataset.id),
    metadataReads: window.__xvMessageLog.filter(type => type === 'GET_LIBRARY_METADATA').length,
    queryCalls: window.__xvQueryCalls.length
  }));
  assert.ok(metadataSync.metadataReads > 0, 'a metadata event should retrieve the bounded affected-row metadata');
  assert.ok(metadataSync.queryCalls > queriesBeforeMetadata, 'an off-page favorite edit must refresh a query whose membership depends on favorite state');
  assert.equal(new Set(metadataSync.records).size, metadataSync.records.length, 'metadata-triggered revision restart must not duplicate cursor results');
  const queriesBeforeHiddenUpdate = await frame.evaluate(() => window.__xvQueryCalls.filter(query => !String(query.queryId || '').startsWith('home-recent:')).length);
  const metadataReadsBeforeHiddenUpdate = metadataSync.metadataReads;
  await frame.locator('.nav[data-page="home"]').click();
  await frame.evaluate(async () => {
    if (!await window.__xvMutatePost('900527', { favorite: true })) throw Error('Could not prepare the hidden-page IndexedDB fixture');
    const channel = new BroadcastChannel('xvault-library-metadata');
    channel.postMessage({ ids: ['900527'] });
    channel.close();
  });
  await frame.waitForFunction(before => window.__xvMessageLog.filter(type => type === 'GET_LIBRARY_METADATA').length > before, metadataReadsBeforeHiddenUpdate);
  await page.waitForTimeout(180);
  const hiddenQueryCalls = await frame.evaluate(() => window.__xvQueryCalls.filter(query => !String(query.queryId || '').startsWith('home-recent:')).length);
  assert.equal(hiddenQueryCalls, queriesBeforeHiddenUpdate, `metadata arriving while Library is hidden should invalidate its page without reading it in the background: ${JSON.stringify(await frame.evaluate(() => ({ state: window.XVaultLibraryQueryState?.(), visible: document.querySelector('#page-library')?.className, queries: window.__xvQueryCalls.slice(-5), messages: window.__xvMessageLog.slice(-15) })))}`);
  await frame.locator('.nav[data-page="library"]').click();
  try { await frame.waitForFunction(() => {
    const state = window.XVaultLibraryQueryState?.();
    return state?.loadedFor === state?.queryKeyNow && !state.busy && !!document.querySelector('#list .tweet[data-id="900527"]');
  }, null, { timeout: 15000 }); }
  catch (error) { console.log(JSON.stringify({ reentry: await frame.evaluate(() => ({ state: window.XVaultLibraryQueryState?.(), search: document.querySelector('#search')?.value, pages: [...document.querySelectorAll('.page')].filter(node => node.classList.contains('show')).map(node => node.id), list: document.querySelector('#list')?.innerText.slice(0, 500), queries: window.__xvQueryCalls.slice(-8), messages: window.__xvMessageLog.slice(-18) })) })); throw error; }
  const hiddenPageQueryDelta = hiddenQueryCalls - queriesBeforeHiddenUpdate;
  await frame.locator('#search').fill('');
  await frame.waitForFunction(() => window.XVaultLibraryQueryState?.().rows === 50 && !document.querySelector('#list').hasAttribute('aria-busy'));
  const compactRenderMs = await frame.evaluate(async () => {
    const start = performance.now(); await save({ libraryView: 'compact' }, false); renderLib(); return performance.now() - start;
  });
  const compactTags = frame.locator('.xv-record-row[data-id="900000"] .xv-record-copy small');
  await frame.waitForFunction(() => document.querySelector('.xv-record-row[data-id="900000"]'));
  const compactTagText = await compactTags.innerText();
  assert.ok((await frame.locator('.xv-record-row[data-id="900000"] .xv-record-copy p').textContent()).length <= 501, 'compact rows should not construct unbounded text nodes');
  assert.match(compactTagText, /\+72 more/);
  assert.doesNotMatch(compactTagText, /#tag-79/, 'Compact rows should summarize large tag arrays instead of overflowing');
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'the real IndexedDB Library should fit a narrow viewport');
  await page.screenshot({ path: path.join(output, 'indexeddb-library-narrow.png'), animations: 'disabled' });
  const dbName = await frame.evaluate(() => window.__xvMockRealDatabaseName);
  await frame.evaluate(async name => {
    await window.__xvCloseMockDB();
    await new Promise(resolve => { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve(); });
  }, dbName);
  console.log(JSON.stringify({ ok: true, recordsInIndexedDB: 10000, homeQueryReads: 16, homeDashboardPageLoaded: false, usableWallMs: Number(usableWallMs.toFixed(1)), recordsRead: evidence.metric.recordsRead, recordsMaterialized: evidence.metric.recordsMaterialized, cursorOperations: evidence.metric.cursorOperations, cursorIndex: 'archivedAt', openMs: evidence.metric.openMs, databaseOpenMs: evidence.metric.databaseOpenMs, schemaPreparationMs: evidence.metric.schemaPreparationMs, queryPlanningMs: evidence.metric.queryPlanningMs, queryMs: evidence.metric.queryMs, pageReadMs: evidence.metric.pageReadMs, downloadLookupMs: evidence.metric.downloadLookupMs, firstRenderMs: evidence.metric.firstRenderMs, usableLibraryMs: evidence.metric.usableLibraryMs, compactRenderMs: Number(compactRenderMs.toFixed(1)), responseBytesEstimate: evidence.metric.responseBytesEstimate, heapDeltaBytes: evidence.metric.heapDeltaBytes, heapMeasurement: evidence.metric.heapMeasurement, wholeStoreReads: evidence.idb.getAll + evidence.idb.getAllKeys, wholeStoreCounts: evidence.idb.count + evidence.idb.indexCount, longTasks: evidence.metric.mainThreadLongTasks, dashboardRowsRetained: evidence.metric.dashboardRecordsRetained, offPageMetadataSync: metadataSync, hiddenPageQueryDelta, totalCountInUi: visibleAllCount, screenshots: output }));
} finally { await browser.close(); }
