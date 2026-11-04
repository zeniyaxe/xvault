import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { LibraryRankPlanCache, buildLibraryRankPlan, pageLibraryRankPlan } from '../library-ranked-query.mjs';
const require = createRequire(import.meta.url);
const search = require('../library-search-core.js');

const rankOnly = search.projectRankPost(
  {
    id: '42',
    text: 'Large text '.repeat(100000),
    author: { handle: '@Maker' },
    metrics: { likes: 9 },
    media: [{}, {}],
    userMeta: { tags: ['private'], note: 'private note' },
  },
  7
);
assert.deepEqual(
  Object.keys(rankOnly).sort(),
  ['archivedAt', 'handle', 'id', 'index', 'mediaCount', 'metrics', 'randomOrder'].sort(),
  'unfiltered rank scans should never build search text, notes, tags or source projections'
);
assert.equal(rankOnly.handle, 'maker');
assert.equal(rankOnly.metrics.likes, 9);

const rows = Array.from({ length: 1300 }, (_, index) => ({
  id: String(index + 1),
  metrics: { likes: index % 173 },
  text: `Large text ${'x'.repeat(2000)}`,
  tags: Array.from({ length: 20 }, (_, tag) => `tag-${tag}`),
}));
const cache = new LibraryRankPlanCache({ maxPlans: 2, maxRanks: 500 });
let pagesRead = 0,
  reported = 0;
const options = {
  cache,
  planId: 'plan-a',
  identityKey: 'likes|q=|rev=4',
  sort: 'likes',
  maxRanks: 500,
  readPage: async (after, limit) => {
    pagesRead++;
    const start = after == null ? 0 : Number(after);
    const page = rows.slice(start, start + limit);
    return { rows: page, nextKey: start + page.length, done: start + page.length >= rows.length };
  },
  project: post => ({
    id: post.id,
    text: post.text.toLowerCase(),
    tags: post.tags,
    metrics: post.metrics,
    index: Number(post.id) - 1,
    archivedAt: 1,
    mediaCount: 0,
    handle: '',
  }),
  matches: () => true,
  toRank: (projection, post, index) => ({
    id: post.id,
    index,
    metrics: { likes: projection.metrics.likes },
    archivedAt: projection.archivedAt,
    mediaCount: projection.mediaCount,
    handle: projection.handle,
  }),
  compare: (a, b) => b.metrics.likes - a.metrics.likes || a.index - b.index,
  isCurrent: async () => true,
  onProgress: progress => {
    reported = progress.scanned;
  },
};

const first = await buildLibraryRankPlan(options);
assert.equal(first.cached, false);
assert.equal(first.plan.scanned, 1300);
assert.equal(first.plan.matched, 1300);
assert.equal(first.plan.ranks.length, 500);
assert.equal(reported, 1300);
assert.ok(
  first.plan.ranks.every(rank => !('text' in rank) && !('tags' in rank)),
  'cache must retain rank tuples, never post projections'
);
const firstPage = pageLibraryRankPlan(first.plan, 0, 100);
const secondPage = pageLibraryRankPlan(first.plan, 100, 100);
assert.equal(firstPage.ranks.length, 100);
assert.equal(secondPage.ranks.length, 100);
assert.equal(
  new Set([...firstPage.ranks, ...secondPage.ranks].map(rank => rank.id)).size,
  200,
  'rank pages must not repeat records'
);
assert.equal(firstPage.ranks[0].metrics.likes, 172);
assert.equal(firstPage.hasMore, true);
assert.equal(firstPage.truncated, true);

const pagesAfterBuild = pagesRead;
let cacheValidationCalls = 0;
const cached = await buildLibraryRankPlan({
  ...options,
  isCurrent: async () => {
    cacheValidationCalls++;
    return true;
  },
});
assert.equal(cached.cached, true, 'later pages should reuse the complete revision-matched rank plan');
assert.equal(cacheValidationCalls, 1, 'a cached plan must still validate the current query generation');
assert.equal(pagesRead, pagesAfterBuild, 'a cached page must not rescan the archive');
assert.equal(pageLibraryRankPlan(cached.plan, 400, 100).hasMore, false);
assert.throws(
  () => pageLibraryRankPlan(cached.plan, 500, 100),
  { name: 'RangeError' },
  'pages beyond retained rank tuples must fail explicitly'
);

const invalidated = await buildLibraryRankPlan({ ...options, identityKey: 'likes|q=|rev=5' });
assert.equal(invalidated.cached, false, 'a new revision must rebuild instead of reusing stale ranks');

const staleCache = await buildLibraryRankPlan({ ...options, isCurrent: async () => false });
assert.equal(staleCache.stale, true, 'a cached plan with changed query settings must be rejected');
assert.equal(
  pagesRead,
  pagesAfterBuild + 2 * Math.ceil(rows.length / 128),
  'stale plans must not be returned or rescanned under the old identity'
);

let currentRevision = 8;
const mutationDuringScanCache = new LibraryRankPlanCache();
const changedDuringScan = await buildLibraryRankPlan({
  ...options,
  cache: mutationDuringScanCache,
  planId: 'mutating',
  identityKey: 'revision-8',
  readPage: async (after, limit) => {
    const page = await options.readPage(after, limit);
    if (Number(after || 0) >= 256) currentRevision++;
    return page;
  },
  isCurrent: async () => currentRevision === 8,
});
assert.equal(
  changedDuringScan.stale,
  true,
  'a mutation during a multi-transaction scan must invalidate the mixed-revision plan'
);
assert.equal(mutationDuringScanCache.size, 0, 'a mixed-revision plan must never enter the cache');

let cancelChecks = 0,
  cancelledPages = 0;
const cancelled = await buildLibraryRankPlan({
  ...options,
  planId: 'plan-cancel',
  identityKey: 'cancel',
  cache: new LibraryRankPlanCache(),
  readPage: async (after, limit) => {
    cancelledPages++;
    const start = after == null ? 0 : Number(after);
    const page = rows.slice(start, start + limit);
    return { rows: page, nextKey: start + page.length, done: false };
  },
  cancelled: () => ++cancelChecks >= 2,
});
assert.equal(cancelled.cancelled, true);
assert.ok(cancelledPages <= 1, 'a canceled ranked scan must stop at the next bounded page boundary');
assert.equal(cancelled.cacheHit, false);

const smallCache = new LibraryRankPlanCache({ maxPlans: 2, maxRanks: 10 });
smallCache.set('a', '1', { ranks: [] });
smallCache.set('b', '1', { ranks: [] });
smallCache.get('a', '1');
smallCache.set('c', '1', { ranks: [] });
assert.ok(smallCache.get('a', '1'));
assert.equal(smallCache.get('b', '1'), null, 'rank-plan LRU must release the least recently used plan');

const persistedPlans = new Map(),
  firstWorkerCache = new LibraryRankPlanCache();
const persistentOptions = {
  ...options,
  cache: firstWorkerCache,
  planId: 'worker-restart',
  identityKey: 'revision-12',
  loadPlan: async id => persistedPlans.get(id) || null,
  savePlan: async (id, identityKey, plan) => persistedPlans.set(id, { identityKey, plan }),
};
const firstWorker = await buildLibraryRankPlan(persistentOptions);
assert.equal(firstWorker.persisted, true, 'finished bounded plans should persist when a durable cache is available');
const secondWorker = await buildLibraryRankPlan({
  ...persistentOptions,
  cache: new LibraryRankPlanCache(),
  readPage: async () => {
    throw Error('a worker restart should not rescan a valid persisted plan');
  },
});
assert.equal(secondWorker.cached, true);
assert.equal(secondWorker.durableHit, true, 'a fresh worker cache should report a validated IndexedDB plan hit');
assert.equal(secondWorker.plan.ranks.length, 500);
const changedPersistentPlan = await buildLibraryRankPlan({
  ...persistentOptions,
  cache: new LibraryRankPlanCache(),
  identityKey: 'revision-13',
  readPage: options.readPage,
  isCurrent: async () => true,
});
assert.equal(changedPersistentPlan.cached, false, 'a durable plan from a previous archive revision must not be reused');
let cacheWriteErrors = 0;
const cacheQuotaFailure = await buildLibraryRankPlan({
  ...options,
  cache: new LibraryRankPlanCache(),
  planId: 'cache-quota',
  identityKey: 'quota',
  savePlan: async () => {
    throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
  },
  onCacheError: () => cacheWriteErrors++,
});
assert.ok(cacheQuotaFailure.plan, 'a disposable query-plan quota failure must not fail a correct ranked query');
assert.equal(cacheQuotaFailure.persisted, false);
assert.equal(cacheWriteErrors, 1);
let malformedPlanDeleted = false;
const malformedRecovered = await buildLibraryRankPlan({
  ...options,
  cache: new LibraryRankPlanCache(),
  planId: 'malformed',
  identityKey: 'bad',
  loadPlan: async () => ({
    identityKey: 'bad',
    plan: {
      scanned: 2,
      matched: 2,
      rankLimit: 2,
      truncated: false,
      ranks: [
        { id: 'same', metrics: { likes: 1 } },
        { id: 'same', metrics: { likes: 2 } },
      ],
    },
  }),
  deletePlan: async () => {
    malformedPlanDeleted = true;
  },
});
assert.equal(
  malformedPlanDeleted,
  true,
  'corrupt or duplicate-ID durable plans must be discarded before they can affect page semantics'
);
assert.equal(malformedRecovered.cached, false);
assert.equal(malformedRecovered.plan.scanned, 1300);

console.log(
  'Library ranked plans: bounded rank tuples, indexed revisions, cached page reuse, cancellation and LRU passed'
);
