import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const playwright = require(process.argv[2] || 'playwright');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
assert.match(
  background,
  /r\.onblocked=\(\)=>\{if\(settled\)return;settled=true;no\(new Error\('XVault storage is waiting for another open XVault tab\./,
  'a blocked schema upgrade must fail visibly instead of leaving Library loading forever'
);
assert.match(
  background,
  /if\(settled\)\{database\.close\(\);return\}/,
  'a database connection that opens after the UI received a blocked error must be closed'
);
const browser = await playwright.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8765/tests/dashboard-harness.html?records=50000');
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('#libraryView'));
  const frame = page.frames().find(candidate => candidate !== page.mainFrame());
  await frame.locator('.nav[data-page="library"]').click();
  await frame.waitForFunction(
    () => window.XVaultLibraryQueryState?.().loaded && !document.querySelector('#list').hasAttribute('aria-busy')
  );
  const initial = await frame.evaluate(() => ({
    state: window.XVaultLibraryQueryState(),
    metric: window.XVaultLibraryMetrics().at(-1),
    requests: window.__xvMessageLog,
  }));
  assert.equal(
    initial.metric.archiveRecords,
    null,
    'normal cursor pages should not make startup wait for a full archive count'
  );
  assert.equal(initial.metric.recordsRead, 50);
  assert.equal(initial.metric.searchProjectionRows, 0);
  assert.equal(initial.state.rows, 50);
  assert.equal(initial.state.totalRecords, null);
  assert.match(await frame.locator('#libShown').textContent(), /\+/);
  for (const phase of [
    'settingsMs',
    'databaseOpenMs',
    'schemaPreparationMs',
    'queryPlanningMs',
    'pageReadMs',
    'downloadLookupMs',
    'renderMs',
    'usableLibraryMs',
  ]) {
    assert.equal(typeof initial.metric[phase], 'number', `Library startup telemetry should report ${phase} separately`);
  }
  assert.ok(
    initial.metric.usableLibraryMs >= initial.metric.renderMs,
    'usable-Library time should include first render and query retrieval'
  );
  assert.ok(Array.isArray(initial.metric.mainThreadLongTasks), 'long tasks should be reported for this query window');
  assert.ok(
    initial.metric.mainThreadLongTasks.every(
      task =>
        task.startTime <= initial.metric.queryEndPerformanceMs &&
        task.startTime + task.duration >= initial.metric.queryStartPerformanceMs
    ),
    'long-task evidence must overlap this Library query, not merely be the most recent document tasks'
  );
  assert.equal(initial.metric.settingsMs, 3);
  assert.equal(initial.metric.databaseOpenMs, 2);
  assert.equal(initial.metric.queryPlanningMs, 4);
  assert.equal(initial.metric.pageReadMs, 5);
  assert.equal(initial.metric.downloadLookupMs, 6);
  for (const phase of ['mediaMounted', 'mediaReady', 'mediaPending', 'mediaFailed'])
    assert.equal(typeof initial.metric[phase], 'number', `Library media telemetry should report ${phase}`);
  assert.ok(!initial.requests.some(type => ['GET_ALL', 'GET_LIBRARY_ROWS', 'GET_LIBRARY_CHUNK'].includes(type)));

  // Keep the dashboard visible for several polling intervals. Queue/history
  // panels should reuse bounded snapshots, and Library should not trigger the
  // Home stats endpoint's whole-store count work in the background.
  const pollBaseline = await frame.evaluate(() =>
    window.__xvMessageLog.reduce((counts, type) => {
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    }, {})
  );
  await page.waitForTimeout(3200);
  const pollCounts = await frame.evaluate(() =>
    window.__xvMessageLog.reduce((counts, type) => {
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    }, {})
  );
  const pollDelta = Object.fromEntries(
    ['STATS', 'GET_DOWNLOAD_HISTORY', 'DOWNLOAD_QUEUE_STATS'].map(type => [
      type,
      (pollCounts[type] || 0) - (pollBaseline[type] || 0),
    ])
  );
  assert.equal(pollDelta.STATS, 0, 'Library should not poll full archive statistics while it is visible');
  assert.ok(
    pollDelta.GET_DOWNLOAD_HISTORY <= 2,
    `download history should refresh at the bounded cadence, got ${pollDelta.GET_DOWNLOAD_HISTORY}`
  );
  assert.ok(
    pollDelta.DOWNLOAD_QUEUE_STATS <= 4,
    `graph sampling should reuse queue stats rather than issue duplicate requests, got ${pollDelta.DOWNLOAD_QUEUE_STATS}`
  );

  const unrelatedTask = await frame.evaluate(() => {
    const start = performance.now(),
      until = start + 70;
    while (performance.now() < until) {}
    return { start, end: performance.now() };
  });
  await frame.locator('#search').fill('unknown:value');
  try {
    await frame.waitForFunction(
      () =>
        document.querySelector('#libShown').textContent === '0' &&
        !document.querySelector('#list').hasAttribute('aria-busy')
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        afterInput: await frame.evaluate(() => ({
          state: window.XVaultLibraryQueryState(),
          search: document.querySelector('#search').value,
          shown: document.querySelector('#libShown').textContent,
          messages: window.__xvMessageLog.slice(-15),
          render: renderLib.toString().slice(0, 180),
        })),
      })
    );
    throw error;
  }
  const invalid = await frame.evaluate(() => ({
    metric: window.XVaultLibraryMetrics().at(-1),
    state: window.XVaultLibraryQueryState(),
  }));
  assert.equal(invalid.metric.plan, 'invalid query rejected before scanning');
  assert.equal(invalid.metric.recordsRead, 0);
  assert.ok(
    invalid.metric.queryStartPerformanceMs >= unrelatedTask.end,
    'the query profile should begin after unrelated main-thread work'
  );
  assert.ok(invalid.state.queryInputEvents > 0 && invalid.state.queryRenderScheduled > 0);

  await frame.locator('#search').fill('Saved artwork');
  await frame.waitForFunction(
    () =>
      !document.querySelector('#list').hasAttribute('aria-busy') && document.querySelectorAll('#list .tweet').length > 0
  );
  const matching = await frame.locator('#list .tweet').evaluateAll(nodes => nodes.map(node => node.dataset.id));
  assert.ok(matching.every(id => Number(id) % 3 === 0));
  const next = frame.locator('#libraryNext');
  if ((await next.isVisible()) && !(await next.isDisabled())) {
    await next.click();
    await frame.waitForFunction(
      () =>
        window.XVaultLibraryQueryState?.().pageIndex === 1 &&
        window.XVaultLibraryQueryState?.().loadedFor.includes('|1|') &&
        !document.querySelector('#list').hasAttribute('aria-busy')
    );
    const nextIds = await frame.locator('#list .tweet').evaluateAll(nodes => nodes.map(node => node.dataset.id));
    if (nextIds.some(id => matching.includes(id)))
      console.log(
        JSON.stringify({
          first: matching.slice(0, 3),
          firstTail: matching.at(-1),
          next: nextIds.slice(0, 3),
          nextTail: nextIds.at(-1),
          state: await frame.evaluate(() => window.XVaultLibraryQueryState()),
          calls: await frame.evaluate(() => window.__xvQueryCalls.slice(-3)),
          toast: await frame
            .locator('#toast')
            .textContent()
            .catch(() => ''),
          empty: await frame
            .locator('#list .empty')
            .textContent()
            .catch(() => ''),
          errors,
        })
      );
    assert.equal(nextIds.filter(id => matching.includes(id)).length, 0, 'stable cursor pages must not duplicate IDs');
  }
  // Give the mock enough known favorite results to place the edited fixture
  // immediately outside the first page while keeping its state deterministic.
  await frame.evaluate(() => {
    for (let index = 0; index < 550; index += 11) {
      window.__xvMutatePost(String(900000 + index), { userMeta: { favorite: true, tags: [], note: '' } });
    }
  });
  await frame.locator('#search').fill('favorite:true');
  try {
    await frame.waitForFunction(
      () =>
        window.XVaultLibraryQueryState?.().loaded &&
        window.XVaultLibraryQueryState?.().loadedFor === window.XVaultLibraryQueryState?.().queryKeyNow &&
        !document.querySelector('#list').hasAttribute('aria-busy') &&
        document.querySelectorAll('#list .tweet').length === 50
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        favoriteState: await frame.evaluate(() => ({
          state: window.XVaultLibraryQueryState?.(),
          shown: document.querySelector('#libShown')?.textContent,
          list: document.querySelector('#list')?.innerText.slice(0, 1000),
          calls: window.__xvMessageLog?.slice(-20),
          queryCalls: window.__xvQueryCalls?.slice(-5),
        })),
      })
    );
    throw error;
  }
  assert.equal(
    await frame.locator('#list .tweet[data-id="900510"]').count(),
    0,
    'the off-page fixture should not initially match favorite:true'
  );
  const queryCallsBeforeMetadata = await frame.evaluate(() => window.__xvQueryCalls.length);
  await frame.evaluate(() => {
    const id = '900510';
    if (!window.__xvMutatePost(id, { userMeta: { favorite: true, tags: [], note: '' } }))
      throw Error('Could not prepare the off-page metadata fixture');
    const channel = new BroadcastChannel('xvault-library-metadata');
    channel.postMessage({ ids: [id] });
    channel.close();
  });
  await frame.locator('#list .tweet[data-id="900510"]').waitFor({ state: 'attached' });
  const metadataSync = await frame.evaluate(() => ({
    ids: [...document.querySelectorAll('#list .tweet')].map(node => node.dataset.id),
    metadataReads: window.__xvMessageLog.filter(type => type === 'GET_LIBRARY_METADATA').length,
    queryCalls: window.__xvQueryCalls.length,
  }));
  assert.equal(
    new Set(metadataSync.ids).size,
    metadataSync.ids.length,
    'metadata synchronization must not duplicate cursor results'
  );
  assert.ok(metadataSync.metadataReads > 0);
  assert.ok(
    metadataSync.queryCalls > queryCallsBeforeMetadata,
    'an off-page favorite edit must revalidate metadata-backed query results'
  );
  await frame.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = message =>
      message.type === 'QUERY_LIBRARY_PAGE'
        ? Promise.resolve({ ok: false, error: 'Unknown message' })
        : original(message);
    chrome.runtime.reload = () => {
      window.__extensionReloadRequested = true;
    };
    document.querySelector('#search').value = 'protocol mismatch';
    renderLib();
  });
  await frame.locator('#list [role="alert"]').waitFor();
  assert.match(await frame.locator('#list [role="alert"]').textContent(), /newer than its background worker/);
  await frame.locator('#list [role="alert"] button').click();
  assert.equal(
    await frame.evaluate(() => window.__extensionReloadRequested),
    true,
    'the stale-worker recovery action should call Chrome extension reload'
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      firstPage: initial.metric,
      pollDelta,
      invalidQuery: invalid.metric,
      offPageMetadataSync: metadataSync,
      visibleRows: await frame.locator('#list .tweet').count(),
      queryEvents: invalid.state.queryInputEvents,
    })
  );
} finally {
  await browser.close();
}
