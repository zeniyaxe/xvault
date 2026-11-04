export const MAX_LIBRARY_RANKS = 5000;

export class LibraryRankPlanCache {
  constructor({ maxPlans = 3, maxRanks = MAX_LIBRARY_RANKS } = {}) {
    this.maxPlans = Math.max(1, Math.min(8, Math.floor(Number(maxPlans) || 3)));
    this.maxRanks = Math.max(1, Math.min(MAX_LIBRARY_RANKS, Math.floor(Number(maxRanks) || MAX_LIBRARY_RANKS)));
    this.plans = new Map();
  }

  get(planId, identityKey) {
    const entry = this.plans.get(String(planId));
    if (!entry) return null;
    if (entry.identityKey !== String(identityKey)) {
      this.plans.delete(String(planId));
      return null;
    }
    this.plans.delete(String(planId));
    this.plans.set(String(planId), entry);
    return entry.plan;
  }

  set(planId, identityKey, plan) {
    if (!plan || !Array.isArray(plan.ranks) || plan.ranks.length > this.maxRanks)
      throw new RangeError('The Library rank plan exceeds its bounded cache capacity.');
    const id = String(planId);
    this.plans.delete(id);
    this.plans.set(id, { identityKey: String(identityKey), plan });
    while (this.plans.size > this.maxPlans) this.plans.delete(this.plans.keys().next().value);
  }

  delete(planId) {
    this.plans.delete(String(planId));
  }
  clear() {
    this.plans.clear();
  }
  get size() {
    return this.plans.size;
  }
}

function retainRank(heap, candidate, limit, compare) {
  const swap = (a, b) => {
    const item = heap[a];
    heap[a] = heap[b];
    heap[b] = item;
  };
  if (heap.length < limit) {
    heap.push(candidate);
    let index = heap.length - 1;
    while (index) {
      const parent = (index - 1) >> 1;
      if (compare(heap[index], heap[parent]) <= 0) break;
      swap(index, parent);
      index = parent;
    }
    return;
  }
  if (compare(candidate, heap[0]) >= 0) return;
  heap[0] = candidate;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1,
      right = left + 1;
    let worst = index;
    if (left < heap.length && compare(heap[left], heap[worst]) > 0) worst = left;
    if (right < heap.length && compare(heap[right], heap[worst]) > 0) worst = right;
    if (worst === index) break;
    swap(index, worst);
    index = worst;
  }
}

function validStoredPlan(plan, maxRanks, compare) {
  if (
    !plan ||
    !Array.isArray(plan.ranks) ||
    plan.ranks.length > maxRanks ||
    !Number.isSafeInteger(plan.scanned) ||
    plan.scanned < 0 ||
    !Number.isSafeInteger(plan.matched) ||
    plan.matched < plan.ranks.length ||
    plan.matched > plan.scanned ||
    !Number.isSafeInteger(plan.rankLimit) ||
    plan.rankLimit < plan.ranks.length ||
    plan.rankLimit > maxRanks ||
    plan.truncated !== plan.matched > plan.ranks.length
  )
    return false;
  const ids = new Set();
  try {
    for (let index = 0; index < plan.ranks.length; index++) {
      const rank = plan.ranks[index];
      if (
        !rank ||
        typeof rank !== 'object' ||
        Array.isArray(rank) ||
        !['string', 'number'].includes(typeof rank.id) ||
        !String(rank.id)
      )
        return false;
      const id = String(rank.id);
      if (ids.has(id) || (index && compare(plan.ranks[index - 1], rank) > 0)) return false;
      ids.add(id);
    }
  } catch {
    return false;
  }
  return true;
}

export async function buildLibraryRankPlan(options = {}) {
  const cache = options.cache;
  const planId = String(options.planId || ''),
    identityKey = String(options.identityKey || '');
  if (
    !cache ||
    !planId ||
    typeof options.readPage !== 'function' ||
    typeof options.project !== 'function' ||
    typeof options.matches !== 'function' ||
    typeof options.toRank !== 'function' ||
    typeof options.compare !== 'function'
  ) {
    throw new TypeError('A bounded Library rank plan requires a cache and query functions.');
  }
  let existing = cache.get(planId, identityKey),
    durableHit = false;
  if (!existing && typeof options.loadPlan === 'function') {
    try {
      const stored = await options.loadPlan(planId);
      if (
        stored &&
        String(stored.identityKey) === identityKey &&
        validStoredPlan(stored.plan, cache.maxRanks, options.compare)
      ) {
        existing = stored.plan;
        durableHit = true;
        cache.set(planId, identityKey, existing);
      } else if (stored && typeof options.deletePlan === 'function') await options.deletePlan(planId);
    } catch (error) {
      options.onCacheError?.(error);
    }
  }
  if (existing) {
    if (options.cancelled?.()) return { cancelled: true, cacheHit: false };
    if (typeof options.isCurrent === 'function' && !(await options.isCurrent())) {
      cache.delete(planId);
      if (durableHit && typeof options.deletePlan === 'function')
        try {
          await options.deletePlan(planId);
        } catch (error) {
          options.onCacheError?.(error);
        }
      return { stale: true, cacheHit: false };
    }
    return { plan: existing, cached: true, cacheHit: true, durableHit };
  }
  const maxRanks = Math.max(1, Math.min(cache.maxRanks, Math.floor(Number(options.maxRanks) || cache.maxRanks)));
  const pageSize = Math.max(1, Math.min(128, Math.floor(Number(options.pageSize) || 128)));
  const ranks = [];
  let afterKey = null,
    scanned = 0,
    matched = 0;
  for (;;) {
    if (options.cancelled?.()) return { cancelled: true, cacheHit: false };
    const page = await options.readPage(afterKey, pageSize);
    if (options.cancelled?.()) return { cancelled: true, cacheHit: false };
    const pageRows = Array.isArray(page?.rows) ? page.rows : [];
    if (!pageRows.length && !page?.done && page?.nextKey === afterKey)
      throw new Error('The ranked Library cursor stopped advancing.');
    for (const post of pageRows) {
      const index = scanned++;
      const projection = options.project(post, index);
      if (!options.matches(projection, post, index)) continue;
      matched++;
      const tuple = options.toRank(projection, post, index);
      if (!tuple || typeof tuple !== 'object' || Array.isArray(tuple))
        throw new TypeError('Library rank projection must return a compact rank tuple.');
      retainRank(ranks, tuple, maxRanks, options.compare);
    }
    if (typeof options.onProgress === 'function') options.onProgress({ scanned, matched, rankLimit: maxRanks });
    if (page?.done) break;
    if (page?.nextKey == null || page.nextKey === afterKey)
      throw new Error('The ranked Library cursor stopped advancing.');
    afterKey = page.nextKey;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (options.cancelled?.()) return { cancelled: true, cacheHit: false };
  if (typeof options.isCurrent === 'function' && !(await options.isCurrent())) return { stale: true, cacheHit: false };
  ranks.sort(options.compare);
  const plan = { ranks, matched, scanned, rankLimit: maxRanks, truncated: matched > ranks.length };
  cache.set(planId, identityKey, plan);
  let persisted = false;
  if (typeof options.savePlan === 'function') {
    try {
      await options.savePlan(planId, identityKey, plan);
      persisted = true;
    } catch (error) {
      options.onCacheError?.(error);
    }
  }
  return { plan, cached: false, cacheHit: false, durableHit: false, persisted };
}

export function pageLibraryRankPlan(plan, requestedOffset = 0, requestedLimit = 120) {
  const offset = Math.max(0, Math.floor(Number(requestedOffset) || 0));
  const limit = Math.max(1, Math.min(1500, Math.floor(Number(requestedLimit) || 120)));
  if (!plan || !Array.isArray(plan.ranks)) throw new TypeError('The Library rank plan is unavailable.');
  if (plan.truncated && offset >= plan.ranks.length)
    throw new RangeError(
      `Only the top ${plan.ranks.length.toLocaleString()} of ${plan.matched.toLocaleString()} matches are retained. Narrow the search to continue deeper.`
    );
  const ranks = plan.ranks.slice(offset, offset + limit);
  return {
    ranks,
    offset,
    matched: plan.matched,
    scanned: plan.scanned,
    retained: plan.ranks.length,
    hasMore: offset + ranks.length < plan.ranks.length,
    truncated: plan.truncated,
  };
}
