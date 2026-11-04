import test from 'node:test';
import assert from 'node:assert/strict';
import { createDerivedJobs, HttpStatusError, backoffDelay, retryAfterMs } from '../sw/derived-jobs.mjs';
import { dHash, pHash, hamming, toHex, fromHex } from '../sw/image-hash.mjs';

function harness({ pages, process, now = () => 1000 }) {
  const saved = new Map(),
    stored = {},
    alarms = [];
  const storage = {
    get: async key => ({ [key]: stored[key] && structuredClone(stored[key]) }),
    set: async value => Object.assign(stored, structuredClone(value)),
  };
  const deps = {
    storage,
    alarms: { create: async (name, info) => alarms.push([name, info]), clear: async () => {} },
    now,
    listPage: async cursor => {
      const index = cursor == null ? 0 : Number(cursor);
      const items = pages[index] || [];
      return { items, nextKey: index + 1 < pages.length ? String(index + 1) : null, done: index + 1 >= pages.length };
    },
    processors: {
      phash: {
        concurrency: 2,
        eligible: () => true,
        lookup: async keys => new Map(keys.filter(key => saved.has(key)).map(key => [key, saved.get(key)])),
        isFresh: row => !!row,
        isMissing: row => !row.h,
        process,
        missingRow: item => ({ key: item.key, h: '' }),
        save: async rows => rows.forEach(row => saved.set(row.key, row)),
      },
    },
  };
  return { deps, saved, stored, alarms, make: () => createDerivedJobs(deps) };
}
const items = (prefix, n) => Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}` }));

test('derived job walks every page, remembers results and finishes', async () => {
  const h = harness({ pages: [items('a', 3), items('b', 2)], process: async item => ({ key: item.key, h: 'ff' }) });
  const jobs = h.make();
  await jobs.start('phash');
  await jobs.pump('phash');
  const status = (await jobs.status()).phash;
  assert.equal(status.state, 'done');
  assert.equal(status.seen, 5);
  assert.equal(status.processed, 5);
  assert.equal(h.saved.size, 5);
  // Scanning again only re-reads the cache.
  await jobs.start('phash', { restart: true });
  await jobs.pump('phash');
  const again = (await jobs.status()).phash;
  assert.equal(again.cached, 5);
  assert.equal(again.processed, 0);
});

test('a terminated worker resumes from the last checkpointed page', async () => {
  let calls = 0;
  const h = harness({
    pages: [items('a', 2), items('b', 2)],
    process: async item => {
      calls++;
      return { key: item.key, h: '1' };
    },
  });
  const first = h.make();
  await first.start('phash');
  await first.pump('phash');
  assert.equal(calls, 4);
  // Simulate a crash mid-job by rewinding the stored state to "running on page 1".
  h.stored.xvDerivedJobs.phash = { ...h.stored.xvDerivedJobs.phash, state: 'running', cursor: '1', exhausted: false };
  h.saved.delete('b0');
  const second = h.make();
  await second.resume();
  await second.pump('phash');
  assert.equal(calls, 5, 'only the missing item on the resumed page is processed');
  assert.equal((await second.status()).phash.state, 'done');
});

test('429 backs off without advancing the cursor; 404 is recorded as unavailable', async () => {
  let clock = 1000,
    limited = true;
  const h = harness({
    now: () => clock,
    pages: [[{ key: 'ok' }, { key: 'gone' }, { key: 'slow' }]],
    process: async item => {
      if (item.key === 'gone') throw new HttpStatusError(404);
      if (item.key === 'slow' && limited) throw new HttpStatusError(429, 60000);
      return { key: item.key, h: 'aa' };
    },
  });
  const jobs = h.make();
  await jobs.start('phash');
  await jobs.pump('phash');
  let status = (await jobs.status()).phash;
  assert.equal(status.state, 'waiting');
  assert.equal(status.cursor, null);
  assert.ok(status.backoffUntil >= 61000);
  assert.ok(h.alarms.some(([, info]) => info.when === status.backoffUntil));
  limited = false;
  clock = status.backoffUntil + 1;
  await jobs.resume();
  await jobs.pump('phash');
  status = (await jobs.status()).phash;
  assert.equal(status.state, 'done');
  assert.equal(h.saved.get('gone').h, '');
  assert.equal(h.saved.get('slow').h, 'aa');
});

test('backoff and retry-after helpers', () => {
  assert.equal(backoffDelay(1), 30000);
  assert.equal(backoffDelay(3), 120000);
  assert.equal(backoffDelay(20), 900000);
  assert.equal(backoffDelay(1, 200000), 200000);
  assert.equal(retryAfterMs({ headers: new Headers({ 'retry-after': '7' }) }), 7000);
});

test('perceptual hashes are stable under brightness shifts and differ for different images', () => {
  const ramp = Array.from({ length: 72 }, (_, i) => (i % 9) * 20);
  const brighter = ramp.map(v => v + 30);
  assert.equal(hamming(dHash(ramp), dHash(brighter)), 0);
  const image = Array.from({ length: 1024 }, (_, i) => Math.sin(i / 37) * 100 + (i % 32 > 16 ? 50 : 0));
  const noisy = image.map((v, i) => v + ((i * 7919) % 5) - 2);
  const other = Array.from({ length: 1024 }, (_, i) => ((i * 2654435761) >>> 0) % 255);
  assert.ok(hamming(pHash(image), pHash(noisy)) <= 4);
  assert.ok(hamming(pHash(image), pHash(other)) > 12);
  assert.deepEqual(fromHex(toHex([0xdeadbeef, 0x01234567])), [0xdeadbeef, 0x01234567]);
});

test('calendar keys and day filters follow the time-zone setting', async () => {
  const { dayKeyIn, dayStreaks } = await import('../vault-insights.mjs');
  const { createRequire } = await import('node:module');
  const search = createRequire(import.meta.url)('../library-search-core.js');
  const stamp = Date.UTC(2026, 0, 1, 23, 30);
  assert.equal(dayKeyIn(stamp, 'utc'), '2026-01-01');
  const local = new Date(stamp);
  assert.equal(
    dayKeyIn(stamp, 'local'),
    `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
  );
  assert.equal(dayStreaks({ '2026-01-01': 1, '2026-01-02': 2 }, Date.UTC(2026, 0, 2, 12), 'utc').current, 2);
  search.setCalendarTimeZone('local');
  const [rule] = search.compileQuery('on:2026-03-08');
  assert.equal(rule.start, new Date(2026, 2, 8).getTime());
  assert.equal(rule.end, new Date(2026, 2, 9).getTime());
  search.setCalendarTimeZone('utc');
  assert.equal(search.compileQuery('on:2026-03-08')[0].start, Date.UTC(2026, 2, 8));
});
