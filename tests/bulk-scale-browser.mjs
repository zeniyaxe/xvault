// Real extension IndexedDB, disposable profile, no network downloads.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright');
const profile = await fs.mkdtemp(path.join(path.resolve(process.env.TEMP), 'xvault-bulk-scale-'));
const context = await pw.chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.argv[3],
  args: [`--disable-extensions-except=${path.resolve('.')}`, `--load-extension=${path.resolve('.')}`],
});
try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).hostname}/tests/library-storage.html`);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'STATS' }));
  await worker.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('xvault-db');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    for (let offset = 0; offset < 50000; offset += 1000)
      await new Promise((resolve, reject) => {
        const tx = db.transaction('tweets', 'readwrite');
        for (let i = offset; i < offset + 1000; i++)
          tx.objectStore('tweets').put({
            id: String(100000 + i),
            text: 'Synthetic planning reference ' + i,
            author: { handle: 'fixture' },
            archivedAt: Date.now(),
            userMeta: {},
            media: [{ id: 'm' + i, type: 'photo', url: 'https://pbs.twimg.com/media/fixture' + i, bytes: 1024 }],
          });
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    db.close();
    globalThis.__bulkFullReads = 0;
    const original = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === 'tweets' || this.name === 'downloads') globalThis.__bulkFullReads++;
      return original.apply(this, args);
    };
  });
  const start = Date.now();
  const plan = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'PLAN_LIBRARY_DOWNLOAD', options: { scope: 'all', mediaFilter: 'images' } })
  );
  const elapsed = Date.now() - start;
  assert.equal(plan.totals.postsScanned, 50000);
  assert.equal(plan.totals.media, 50000);
  assert.equal(plan.items.length, 100);
  assert.equal(plan.sampleLimited, true);
  assert.equal(
    await worker.evaluate(() => globalThis.__bulkFullReads),
    0,
    'preview cannot materialize complete tweet or download stores'
  );
  const selectedStart = Date.now();
  const selected = await page.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'PLAN_LIBRARY_DOWNLOAD',
      options: { scope: 'selected', selectedIds: ['149999', 'absent', '149999'] },
    })
  );
  assert.equal(selected.totals.postsScanned, 1);
  assert.equal(selected.totals.postsMatched, 1);
  assert.equal(selected.items[0].tweetId, '149999');
  console.log(`Selected scope primary-key lookup: ${Date.now() - selectedStart}ms, one record read from 50k`);
  const cancelled = await page.evaluate(async () => {
    const requestId = crypto.randomUUID();
    const pending = chrome.runtime.sendMessage({ type: 'PLAN_LIBRARY_DOWNLOAD', requestId, options: { scope: 'all' } });
    await chrome.runtime.sendMessage({ type: 'CANCEL_LIBRARY_PLAN', requestId });
    return pending;
  });
  assert.equal(cancelled.cancelled, true);
  console.log(`PASS real IndexedDB 50k planner: ${elapsed}ms, 100 preview items, zero full-store reads, cancellation`);
} finally {
  await context.close();
  const relative = path.relative(path.resolve(process.env.TEMP), profile);
  if (relative.startsWith('xvault-bulk-scale-') && !relative.includes(path.sep))
    await fs.rm(profile, { recursive: true, force: true });
}
