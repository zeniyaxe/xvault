// Usage: node tests/download-queue-browser.mjs [Playwright package] [Chromium executable]
// Real unpacked MV3 service worker + real Chromium downloads against a local HTTP server that counts every
// download request. The server's request count is the authority on duplicate downloading: it cannot be fooled
// by queue bookkeeping. Uses a fresh profile and a temporary download directory; never touches a user profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright');
const root = path.resolve(process.argv[4] || '.');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xvault-dlq-'));
const downloadDir = path.join(profile, 'downloads');
await fs.mkdir(downloadDir, { recursive: true });

// Count queue fetches; Range probes and legitimate dashboard image previews are separate work.
const hits = new Map(),
  behavior = new Map();
const server = http.createServer(async (request, response) => {
  const name = new URL(request.url, 'http://x').pathname;
  const counted = !request.headers.range && !['image', 'video', 'audio'].includes(request.headers['sec-fetch-dest']);
  if (counted) hits.set(name, (hits.get(name) || 0) + 1);
  const mode = behavior.get(name) || {};
  const body = Buffer.alloc(40_000, name.length % 251);
  if (mode.failFirst && (hits.get(name) || 0) === 1 && counted) {
    response.writeHead(500);
    return response.end('no');
  }
  response.writeHead(request.headers.range ? 206 : 200, {
    'content-type': 'image/jpeg',
    'content-length': body.length,
    ...(request.headers.range ? { 'content-range': `bytes 0-${body.length - 1}/${body.length}` } : {}),
  });
  if (mode.slowMs) {
    response.write(body.subarray(0, 1000));
    await new Promise(resolve => setTimeout(resolve, mode.slowMs));
    response.end(body.subarray(1000));
  } else response.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const context = await pw.chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.argv[3],
  acceptDownloads: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
try {
  let worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir }).catch(() => {});
  const send = (target, message) => target.evaluate(message => chrome.runtime.sendMessage(message), message);
  await send(page, {
    type: 'SET_SETTINGS',
    settings: {
      onboardingComplete: true,
      maxConcurrentDownloads: 8,
      retryDelay: 250,
      downloadRetries: 2,
      skipDuplicateDownloads: true,
      mediaFolder: 'XVaultTest',
      organizeByType: false,
      organizeByAuthor: false,
      organizeByDate: false,
    },
  });
  const windows = [page, await context.newPage(), await context.newPage()];
  for (const extra of windows.slice(1)) await extra.goto(`chrome-extension://${id}/dashboard.html`);
  let serial = 0;
  const diskMetrics = [];
  const fresh = () => `/asset-${++serial}.jpg`;
  const item = (name, extra = {}) => ({
    url: origin + name,
    tweetId: '900',
    author: 'tester',
    index: 1,
    mediaType: 'image',
    ...extra,
  });
  const rows = () =>
    page.evaluate(
      () =>
        new Promise(resolve => {
          const open = indexedDB.open('xvault-db');
          open.onsuccess = () => {
            const query = open.result.transaction('downloads').objectStore('downloads').getAll();
            query.onsuccess = () => {
              resolve(
                query.result.map(row => ({
                  key: row.key,
                  state: row.state,
                  url: row.item?.url,
                  attempts: row.attempts,
                  supersededAt: row.supersededAt,
                  downloadId: row.downloadId,
                }))
              );
              open.result.close();
            };
          };
        })
    );
  const settle = async (names, timeout = 15000) => {
    const until = Date.now() + timeout;
    for (;;) {
      const current = await rows();
      if (
        names.every(name =>
          current.some(
            row => !row.supersededAt && row.url === origin + name && ['complete', 'failed'].includes(row.state)
          )
        )
      )
        return current;
      if (Date.now() > until)
        throw new Error(
          `downloads did not settle: ${JSON.stringify(current.filter(row => names.some(name => row.url === origin + name)))}`
        );
      await page.waitForTimeout(100);
    }
  };

  // 1 · 2, 5, 10, 50, 100 simultaneous requests for one asset, spread over three extension windows and both entry types.
  for (const count of [1, 2, 5, 10, 50, 100]) {
    const name = fresh();
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        send(windows[index % 3], { type: index % 2 ? 'DOWNLOAD_URLS' : 'QUEUE_DOWNLOADS', items: [item(name)] })
      )
    );
    await settle([name]);
    assert.equal(hits.get(name), 1, `${count} simultaneous requests must fetch the file once`);
    const stem = name.slice(1).replace(/\.jpg$/, '');
    const actualFiles = (await fs.readdir(downloadDir, { recursive: true })).filter(
      file => path.basename(file).startsWith(stem + '.') || path.basename(file).startsWith(stem + ' (')
    );
    assert.equal(actualFiles.length, 1, 'disk evidence must contain one physical file for the asset');
    diskMetrics.push({
      attempts: count,
      httpFetches: hits.get(name),
      files: actualFiles.length,
      uniquified: actualFiles.filter(file => / \(\d+\)/.test(file)).length,
    });
  }
  console.log('PASS 1/2/5/10/50/100 simultaneous requests from 3 windows fetch each file exactly once');

  // 2 · one request listing the same file repeatedly, plus a double-click (two sends in the same tick).
  let name = fresh();
  await send(page, { type: 'DOWNLOAD_URLS', items: [item(name), item(name), item(name, { index: 2 })] });
  await Promise.all([
    send(page, { type: 'DOWNLOAD_URLS', items: [item(name)] }),
    send(page, { type: 'DOWNLOAD_URLS', items: [item(name)] }),
  ]);
  await settle([name]);
  assert.equal(hits.get(name), 1);

  // 3 · after completion, repeating the request (stale UI, another entry point) downloads nothing.
  const again = await send(page, { type: 'DOWNLOAD_URLS', items: [item(name)] });
  assert.equal(again.added, 0);
  assert.equal(again.lookup?.identityRequests, 1, 'a repeat request checks the canonical primary key directly');
  assert.equal(
    again.lookup?.identityRowsMaterialized,
    1,
    'only the matching download row is materialized for an exact duplicate'
  );
  assert.equal(again.lookup?.assetScanRecords, 0, 'the default cross-post policy does not scan history');
  await page.waitForTimeout(300);
  assert.equal(hits.get(name), 1, 'a completed file is never fetched again by a repeat request');

  // Queue history can be cleared independently of Chrome's already saved file.
  await page.evaluate(
    url =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('xvault-db');
        open.onsuccess = () => {
          const database = open.result,
            tx = database.transaction('downloads', 'readwrite'),
            request = tx.objectStore('downloads').openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (cursor.value.item?.url === url) cursor.delete();
            cursor.continue();
          };
          tx.oncomplete = () => {
            database.close();
            resolve();
          };
          tx.onabort = () => reject(tx.error);
        };
      }),
    origin + name
  );
  await send(page, { type: 'DOWNLOAD_URLS', items: [item(name)] });
  await settle([name]);
  assert.equal(hits.get(name), 1, 'lost queue history must not fetch an asset already retained in Chrome history');

  // 4 · explicit redownload is the only way to get a second fetch; while one is in flight force is ignored.
  name = fresh();
  behavior.set(name, { slowMs: 1500 });
  await send(page, { type: 'DOWNLOAD_URLS', items: [item(name)] });
  await page.waitForTimeout(300);
  await Promise.all(
    Array.from({ length: 5 }, () => send(page, { type: 'DOWNLOAD_URLS', items: [item(name)], force: true }))
  );
  await settle([name]);
  assert.equal(hits.get(name), 1, 'force must not start a second fetch while the first is active');
  const key = (await rows()).find(row => row.url === origin + name).key;
  await send(page, { type: 'FORCE_REDOWNLOAD', key });
  await settle([name]);
  await page.waitForTimeout(500);
  assert.equal(hits.get(name), 2, 'an explicit redownload fetches once more');
  const copies = (await rows()).filter(row => row.url === origin + name);
  assert.equal(copies.length, 2, 'redownload must retain the earlier completed file record');
  assert.equal(
    new Set(copies.map(row => row.downloadId)).size,
    2,
    'both saved files keep their distinct Chrome identities'
  );
  console.log('PASS repeat, double-click, stale-UI, force-while-active and explicit redownload');

  // 5 · restart mid-download: the worker is killed while Chrome is still receiving bytes.
  name = fresh();
  behavior.set(name, { slowMs: 2500 });
  await send(page, { type: 'DOWNLOAD_URLS', items: [item(name)] });
  await page.waitForTimeout(500);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  await send(page, { type: 'DOWNLOAD_URLS', items: [item(name)] });
  await settle([name], 20000);
  await page.waitForTimeout(800);
  assert.equal(hits.get(name), 1, 'restarting the service worker must not re-fetch a download Chrome is still running');
  console.log('PASS service-worker restart during a live download');

  // 6 · a failing first fetch retries once while repeat requests keep arriving.
  name = fresh();
  behavior.set(name, { failFirst: true });
  await send(page, { type: 'DOWNLOAD_URLS', items: [item(name)] });
  for (let i = 0; i < 6; i++) {
    await send(windows[i % 3], { type: 'DOWNLOAD_URLS', items: [item(name)] });
    await page.waitForTimeout(120);
  }
  await settle([name]);
  await page.waitForTimeout(500);
  assert.ok(hits.get(name) <= 2, `failed fetch + one retry is the most that may happen (saw ${hits.get(name)})`);
  assert.equal((await rows()).find(row => row.url === origin + name).state, 'complete');
  const files = (await fs.readdir(downloadDir, { recursive: true })).filter(file => /asset-/.test(file));
  assert.equal(
    new Set(files.map(file => path.basename(file).replace(/ \(\d+\)/, ''))).size,
    files.length,
    `no uniquified duplicate files on disk: ${files.join(', ')}`
  );
  console.log('PASS retry racing manual requests, and no "(1)" duplicates on disk');

  // 7 · the decision log explains what happened, without signatures or query strings.
  const decisions = (await send(page, { type: 'GET_DOWNLOAD_DECISIONS', limit: 400 })).rows;
  const codes = new Set(decisions.map(row => row.code));
  for (const code of ['new', 'in-flight', 'already-downloaded', 'explicit-redownload', 'same-request'])
    assert.ok(codes.has(code), `decision log should include ${code}`);
  assert.ok(
    decisions.every(row => !String(row.url).includes('?') && !String(row.url).includes('token')),
    'decision log must not keep URL queries'
  );
  console.log('PASS decision log records accepted and rejected requests');
  const privateName = fresh(),
    privateUrl = origin + privateName + '?token=secret-download-value';
  await send(page, { type: 'DOWNLOAD_URLS', items: [item(privateName, { url: privateUrl })] });
  for (let retry = 0; retry < 40; retry++) {
    if ((await rows()).some(row => row.url === privateUrl && row.state === 'complete')) break;
    await page.waitForTimeout(100);
  }
  const privateDecisions = (await send(page, { type: 'GET_DOWNLOAD_DECISIONS', limit: 400 })).rows;
  assert.ok(
    !JSON.stringify(privateDecisions).includes('secret-download-value'),
    'every diagnostics field, including identity and matchKey, must omit signed URL query data'
  );
  // Chrome documents that search() returns cached exists values before its disk check finishes.
  await worker.evaluate(() => {
    globalThis.__presenceSearch = chrome.downloads.search.bind(chrome.downloads);
    globalThis.__presenceFetch = fetch;
    chrome.downloads.search = async query =>
      (await __presenceSearch(query)).map(row => (row.url?.includes('/presence-') ? { ...row, exists: false } : row));
    globalThis.fetch = (url, ...args) =>
      String(url).startsWith('file:')
        ? Promise.reject(Error('Synthetic local-file permission denied'))
        : __presenceFetch(url, ...args);
  });
  const presenceName = `/presence-${++serial}.jpg`;
  await send(page, { type: 'DOWNLOAD_URLS', items: [item(presenceName)] });
  await settle([presenceName]);
  assert.equal(
    hits.get(presenceName),
    1,
    'cached Chrome exists:false without local access must not redownload a successfully completed file'
  );
  await worker.evaluate(() => {
    chrome.downloads.search = __presenceSearch;
    globalThis.fetch = __presenceFetch;
  });
  console.log('PASS secret-free diagnostics and unconfirmed file-presence safety');
  await send(page, { type: 'SET_SETTINGS', settings: { crossPostDuplicates: 'skip' } });
  const shared = fresh();
  const sharedBatch = await send(page, {
    type: 'DOWNLOAD_URLS',
    items: [item(shared, { tweetId: '8001' }), item(shared, { tweetId: '8002' })],
  });
  assert.equal(sharedBatch.added, 1, 'save-once policy must apply within a single batch');
  assert.equal(sharedBatch.skipped, 1);
  await settle([shared]);
  await send(page, { type: 'SET_SETTINGS', settings: { crossPostDuplicates: 'keep' } });

  const bulkAsset = fresh();
  await page.evaluate(
    async ({ url }) => {
      await chrome.runtime.sendMessage({
        type: 'STORE_RECORDS',
        tweets: [
          {
            id: '880001',
            archivedAt: Date.now(),
            author: { handle: 'bulk' },
            media: [{ id: 'bulk-media', type: 'photo', url }],
          },
        ],
        users: [],
      });
    },
    { url: origin + bulkAsset }
  );
  await send(page, { type: 'DOWNLOAD_URLS', items: [item(bulkAsset, { tweetId: '880001' })] });
  await settle([bulkAsset]);
  const skipPlan = await send(page, {
    type: 'PLAN_LIBRARY_DOWNLOAD',
    options: { scope: 'selected', selectedIds: ['880001'], existingPolicy: 'skip' },
  });
  assert.equal(
    skipPlan.totals.alreadyLocal,
    1,
    'bulk planner must recognize the canonical asset even when its capture mediaId differs'
  );
  const bulkSkip = await send(page, {
    type: 'START_LIBRARY_BULK_DOWNLOAD',
    options: { scope: 'selected', selectedIds: ['880001'], existingPolicy: 'skip' },
  });
  assert.equal(bulkSkip.added, 0);
  assert.equal(hits.get(bulkAsset), 1, 'skip-existing bulk action never fetches the asset again');
  const bulkAgain = await send(page, {
    type: 'START_LIBRARY_BULK_DOWNLOAD',
    options: { scope: 'selected', selectedIds: ['880001'], existingPolicy: 'redownload' },
  });
  assert.equal(
    bulkAgain.added,
    1,
    'bulk redownload must pass explicit force through canonical identity rather than inventing a mediaId'
  );
  await settle([bulkAsset]);
  assert.equal(hits.get(bulkAsset), 2);
  console.log('PASS preserved completed evidence, same-batch shared-media policy, and bulk redownload');
  await send(page, { type: 'SET_SETTINGS', settings: { hashDedupe: true } });
  const hashName = fresh();
  await send(page, { type: 'DOWNLOAD_URLS', items: [item(hashName)] });
  await settle([hashName]);
  const hashForce = await send(page, { type: 'DOWNLOAD_URLS', items: [item(hashName)], force: true });
  assert.equal(hashForce.added, 1, 'explicit force must override optional content-hash deduplication');
  await settle([hashName]);
  await send(page, { type: 'SET_SETTINGS', settings: { skipDuplicateDownloads: false } });
  const keepBothHash = await send(page, { type: 'DOWNLOAD_URLS', items: [item(hashName)] });
  assert.equal(keepBothHash.added, 1, 'Keep Both must also override hash deduplication');
  await settle([hashName]);
  assert.equal(
    (await rows()).filter(row => row.url === origin + hashName).length,
    3,
    'every intentionally retained copy keeps its file evidence'
  );
  // A large completed history must not add normal-path enqueue materialization.
  await send(page, {
    type: 'SET_SETTINGS',
    settings: { hashDedupe: false, skipDuplicateDownloads: true, crossPostDuplicates: 'keep' },
  });
  const queueBeforeHistorySeed = await send(page, { type: 'DOWNLOAD_QUEUE_STATS' });
  const historySeedStarted = Date.now();
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('xvault-db');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const database = open.result,
            tx = database.transaction(['downloads', 'checkpoints'], 'readwrite'),
            store = tx.objectStore('downloads'),
            checkpoints = tx.objectStore('checkpoints');
          for (let index = 0; index < 50000; index++) {
            const key = `synthetic-history-${String(index).padStart(5, '0')}`,
              assetKey = `img:history-${index}`;
            store.put({
              key,
              state: 'complete',
              countedStateVersion: 1,
              updatedAt: index,
              assetKey,
              usableAssetKey: assetKey,
              item: { tweetId: `history-${index}`, url: `https://pbs.twimg.com/media/history-${index}` },
              totalBytes: 4096,
            });
          }
          const checkpoint = checkpoints.get('download-asset-index-v1');
          checkpoint.onsuccess = () =>
            checkpoints.put({
              ...checkpoint.result,
              complete: true,
              countsComplete: true,
              stateCounterVersion: 1,
              stateCounts: {
                ...(checkpoint.result?.stateCounts || {}),
                complete: (Number(checkpoint.result?.stateCounts?.complete) || 0) + 50000,
              },
            });
          tx.oncomplete = () => {
            database.close();
            resolve();
          };
          tx.onabort = () => reject(tx.error || new Error('Large history fixture failed'));
        };
      })
  );
  const historySeedMs = Date.now() - historySeedStarted;
  const enqueueStarted = Date.now();
  const largeHistoryPath = fresh(),
    largeHistoryRequest = await send(page, {
      type: 'DOWNLOAD_URLS',
      items: [item(largeHistoryPath, { tweetId: 'large-history-check' })],
    });
  const indexedEnqueueMs = Date.now() - enqueueStarted;
  assert.equal(largeHistoryRequest.countsReady, true, 'queue totals stay available from the durable state checkpoint');
  assert.equal(
    largeHistoryRequest.bookkeeping?.indexCountRequests,
    0,
    'normal enqueue and queue refresh do not count the 50000-row state index'
  );
  assert.equal(
    largeHistoryRequest.total,
    queueBeforeHistorySeed.total + 50001,
    'queue totals include the 50000 raw fixture rows and the newly queued request'
  );
  assert.equal(
    largeHistoryRequest.lookup?.identityRowsRead,
    0,
    '50000 unrelated completed rows do not become an enqueue projection'
  );
  assert.equal(largeHistoryRequest.lookup?.identityRowsMaterialized, 0);
  assert.equal(largeHistoryRequest.lookup?.assetScanRecords, 0);
  await settle([largeHistoryPath]);
  await send(page, { type: 'SET_SETTINGS', settings: { crossPostDuplicates: 'skip' } });
  const sharedAssetUrl = 'https://pbs.twimg.com/media/history-12345',
    sharedLookupStarted = Date.now(),
    sharedLookup = await send(page, {
      type: 'DOWNLOAD_URLS',
      items: [item('/unused.jpg', { url: sharedAssetUrl, tweetId: 'large-history-share' })],
    });
  const sharedLookupMs = Date.now() - sharedLookupStarted;
  assert.equal(sharedLookup.added, 0, 'Save Once finds a cross-post copy from the asset index');
  assert.equal(sharedLookup.lookup?.assetScanIndex, 'usableAssetKey');
  assert.equal(
    sharedLookup.lookup?.assetScanRecords,
    1,
    'one shared asset among 50000 unrelated history rows requires one index result'
  );
  assert.equal(sharedLookup.lookup?.assetScanRetained, 1);
  assert.equal(sharedLookup.lookup?.lookupBlocked, 0);
  assert.equal(hits.get('/media/history-12345') || 0, 0, 'an indexed duplicate is skipped without a network request');
  await send(page, { type: 'SET_SETTINGS', settings: { crossPostDuplicates: 'keep' } });
  console.log('PASS 50000-row download history: normal enqueue reads 0 unrelated rows; indexed Save Once reads 1');
  console.log(
    'HISTORY_INDEX_METRICS ' +
      JSON.stringify({
        rows: 50000,
        seedMs: historySeedMs,
        normalEnqueueMs: indexedEnqueueMs,
        normalIdentityRowsRead: largeHistoryRequest.lookup?.identityRowsRead,
        normalAssetRowsRead: largeHistoryRequest.lookup?.assetScanRecords,
        sharedLookupMs,
        sharedAssetRowsRead: sharedLookup.lookup?.assetScanRecords,
        index: sharedLookup.lookup?.assetScanIndex,
      })
  );
  await send(page, { type: 'SET_SETTINGS', settings: { hashDedupe: false, skipDuplicateDownloads: true } });
  await worker.evaluate(() => {
    globalThis.__verificationFetch = fetch;
    globalThis.fetch = (url, ...args) =>
      String(url).startsWith('file:')
        ? Promise.resolve(
            new Response('{"error":"synthetic corrupt media"}', { headers: { 'content-type': 'application/json' } })
          )
        : __verificationFetch(url, ...args);
  });
  const corruptName = fresh();
  await send(page, { type: 'DOWNLOAD_URLS', items: [item(corruptName)] });
  const corruptRows = await settle([corruptName]);
  assert.equal(
    corruptRows.find(row => !row.supersededAt && row.url === origin + corruptName).state,
    'failed',
    'confirmed corrupt content after its bounded verification retry must never be labelled complete'
  );
  assert.equal(hits.get(corruptName), 2, 'confirmed corruption permits one verification retry, not an unbounded loop');
  await worker.evaluate(() => (globalThis.fetch = __verificationFetch));
  console.log('PASS bounded verification failure retains explicit failed evidence');
  // An interrupt can finish while the binding transaction's completion is delayed.
  // The original start must not reinsert its retired row into the active map.
  await send(page, { type: 'SET_SETTINGS', settings: { retryDelay: 700, downloadRetries: 2 } });
  await worker.evaluate(() => {
    globalThis.__originalTransaction = IDBDatabase.prototype.transaction;
    globalThis.__originalPut = IDBObjectStore.prototype.put;
    globalThis.__cancelBindingOnce = true;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = __originalTransaction.apply(this, args);
      if (args[1] === 'readwrite' && tx.objectStoreNames.contains('downloads'))
        Object.defineProperty(tx, 'oncomplete', {
          configurable: true,
          set(callback) {
            tx.addEventListener('complete', event => {
              if (tx.__delayBinding) setTimeout(() => callback(event), 500);
              else callback(event);
            });
          },
        });
      return tx;
    };
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (this.name === 'downloads' && __cancelBindingOnce && value.downloadId && value.state === 'downloading') {
        __cancelBindingOnce = false;
        this.transaction.__delayBinding = true;
        setTimeout(() => chrome.downloads.cancel(value.downloadId), 0);
      }
      return __originalPut.call(this, value, ...args);
    };
  });
  const bindingName = fresh();
  behavior.set(bindingName, { slowMs: 1500 });
  await send(page, { type: 'DOWNLOAD_URLS', items: [item(bindingName)] });
  const bindingRows = await settle([bindingName], 20000);
  assert.equal(
    bindingRows.find(row => row.url === origin + bindingName && !row.supersededAt).state,
    'complete',
    'a retired attempt must not strand its retry behind a stale active entry'
  );
  assert.equal(hits.get(bindingName), 2, 'one interrupted fetch and one successful retry');
  await worker.evaluate(() => {
    IDBDatabase.prototype.transaction = __originalTransaction;
    IDBObjectStore.prototype.put = __originalPut;
  });
  console.log('PASS interruption during delayed ID binding does not resurrect a retired active attempt');
  // 8 · one physical image/video through every URL spelling and entry point (stubbed CDN: probe + Chrome download).
  await worker.evaluate(() => {
    globalThis.fetch = async () =>
      new Response(new Uint8Array(4000), {
        status: 206,
        headers: { 'content-type': 'image/jpeg', 'content-range': 'bytes 0-3999/4000', 'content-length': '4000' },
      });
    globalThis.__started = [];
    let n = 5000;
    chrome.downloads.download = async options => {
      __started.push(options.url);
      return ++n;
    };
    chrome.downloads.search = async () => [];
  });
  const cdn =
    tweetId =>
    (url, extra = {}) => ({ url, tweetId, author: 'a', index: 1, mediaType: 'image', ...extra });
  const post = cdn('7001'),
    image = 'https://pbs.twimg.com/media/SpellingTestImage';
  const forms = [
    `${image}.jpg`,
    `${image}.jpg:orig`,
    `${image}?format=jpg&name=small`,
    `${image}?format=jpg&name=orig`,
    `${image}.jpg?name=large`,
    `${image}?format=png`,
  ];
  await Promise.all(
    forms.map((form, index) =>
      send(windows[index % 3], { type: index % 2 ? 'QUEUE_DOWNLOADS' : 'DOWNLOAD_URLS', items: [post(form)] })
    )
  );
  const videoUrl = bitrate =>
    `https://video.twimg.com/ext_tw_video/55001/pu/vid/avc1/${bitrate}/h${bitrate}.mp4?tag=12`;
  await Promise.all(
    ['1280x720', '640x360', '320x180'].map(bitrate =>
      send(page, { type: 'DOWNLOAD_URLS', items: [post(videoUrl(bitrate), { mediaType: 'video' })] })
    )
  );
  await page.waitForTimeout(500);
  const started = await worker.evaluate(() => __started);
  assert.equal(
    started.filter(url => url.includes('SpellingTestImage')).length,
    1,
    'six spellings of one image start one download'
  );
  assert.equal(
    started.filter(url => url.includes('55001')).length,
    1,
    'three bitrates of one video start one download'
  );
  await send(page, { type: 'DOWNLOAD_URLS', items: [cdn('7002')(`${image}.jpg`)] });
  await page.waitForTimeout(300);
  assert.equal(
    (await worker.evaluate(() => __started)).filter(url => url.includes('SpellingTestImage')).length,
    2,
    'the same asset on another post keeps its own copy by default'
  );
  await send(page, { type: 'SET_SETTINGS', settings: { crossPostDuplicates: 'skip' } });
  const skipped = await send(page, { type: 'DOWNLOAD_URLS', items: [cdn('7003')(`${image}?format=jpg&name=orig`)] });
  assert.equal(skipped.added, 0, 'with "one file per asset" the quote/repost copy is skipped');
  console.log('PASS URL spellings, bitrate ladders and cross-post policy collapse to the right number of downloads');
  console.log('DISK_METRICS ' + JSON.stringify(diskMetrics));
  assert.deepEqual(errors, []);
} finally {
  await context.close();
  server.close();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
