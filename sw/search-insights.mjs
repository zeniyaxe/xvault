// XVault 21: search helpers that need the service worker's data.
//   SEARCH_SUGGEST       — "did you mean" for queries with no results (meaning-index vocabulary, edit distance);
//   SAVED_VIEW_ALERTS    — "new since last visit" counts for Smart Collections;
//   SAVED_VIEW_VISITED   — marks a collection as seen;
//   CLUSTERS_BUILD/GET   — topic clusters over the meaning index (sw/clusters.mjs);
//   CLUSTER_RENAME       — user names for clusters (carried over on rebuild);
//   CLUSTER_MEMBERS      — post ids of a cluster (for "Make board" / opening in the Library).
import { nearestTerms } from './semantic.mjs';
import { kmeans, labelClusters, carryNames, suggestK } from './clusters.mjs';

const VISITS_KEY = 'xvViewVisits';
const CLUSTERS_KEY = 'clusters:last';

/** Plain words of a query that could be misspelled (operators, quoted phrases and negations are left alone). */
export function suggestibleWords(query) {
  return (String(query || '').match(/-?[^\s"]*"[^"]*"?|\S+/g) || [])
    .map((token, position) => ({ token, position }))
    .filter(
      ({ token }) => !token.startsWith('-') && !token.includes(':') && !token.includes('"') && !/^[#@]/.test(token)
    )
    .filter(({ token }) => /^[\p{L}][\p{L}'-]{2,}$/u.test(token) && !token.endsWith('~'));
}

export function createSearchInsights(deps) {
  const {
    chromeApi = globalThis.chrome,
    semanticIndex,
    editDistance,
    readRecords,
    postsArchivedSince,
    matcherFor,
    getSettings,
    meta,
    collectionId = (view, index) => String(view.id ?? index),
    now = () => Date.now(),
  } = deps;
  // Same ids as the Library's Smart Collection rows (library-collections.js normalizeDefinition).
  const viewId = (view, index) => {
    try {
      return String(collectionId(view, index));
    } catch {
      return String(index);
    }
  };

  async function suggest(message) {
    const query = String(message.query || '').slice(0, 500),
      words = suggestibleWords(query);
    if (!words.length) return { ok: true, suggestions: [] };
    const index = await semanticIndex();
    const tokens = query.match(/-?[^\s"]*"[^"]*"?|\S+/g) || [];
    const replaced = [...tokens];
    let changed = false;
    const alternatives = [];
    for (const { token, position } of words.slice(0, 6)) {
      const lower = token.toLowerCase();
      const [best, ...others] = nearestTerms(index, lower, {
        distance: lower.length >= 8 ? 2 : 1,
        editDistance,
        limit: 3,
      });
      if (best && best !== lower) {
        replaced[position] = best;
        changed = true;
        alternatives.push({ word: token, options: [best, ...others] });
      }
    }
    const suggestions = [];
    if (changed) suggestions.push({ query: replaced.join(' '), kind: 'spelling', label: 'Did you mean' });
    const fuzzy = tokens
      .map((token, position) => (words.some(word => word.position === position) ? `${token}~` : token))
      .join(' ');
    if (fuzzy !== query) suggestions.push({ query: fuzzy, kind: 'fuzzy', label: 'Allow typos' });
    const meaning = words.map(word => word.token).join(' ');
    if (meaning && !/about:/.test(query))
      suggestions.push({ query: `about:"${meaning}"`, kind: 'meaning', label: 'Search by meaning' });
    return { ok: true, suggestions, alternatives, vocabulary: index?.terms?.length || 0 };
  }

  async function visits() {
    return (await chromeApi.storage.local.get(VISITS_KEY))[VISITS_KEY] || {};
  }
  async function alerts() {
    const settings = await getSettings(),
      views = (settings.savedViews || [])
        .map((view, index) => ({ view, id: view && view.query ? viewId(view, index) : '' }))
        .filter(entry => entry.id)
        .slice(0, 60),
      seen = await visits();
    if (!views.length) return { ok: true, counts: {} };
    const since = Math.min(...views.map(({ id }) => Number(seen[id] || 0) || now()));
    const fresh = since < now() ? await postsArchivedSince(since, 5000) : [];
    const counts = {};
    for (const { view, id } of views) {
      const visited = Number(seen[id] || 0);
      if (!visited) {
        counts[id] = 0;
        continue;
      }
      const matches = await matcherFor(view.query);
      counts[id] = fresh.filter(post => Number(post.archivedAt || 0) > visited && matches(post)).length;
    }
    return { ok: true, counts, since };
  }
  async function visited(message) {
    const id = String(message.id ?? '');
    if (!id || id.length > 128) throw Error('Invalid collection');
    const current = await visits();
    current[id] = now();
    const entries = Object.entries(current)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200);
    await chromeApi.storage.local.set({ [VISITS_KEY]: Object.fromEntries(entries) });
    return { ok: true };
  }
  /** First visit initialises every collection so counts start from "now", not from the beginning. */
  async function initVisits() {
    const settings = await getSettings(),
      current = await visits();
    let changed = false;
    (settings.savedViews || []).forEach((view, index) => {
      if (!view || !view.query) return;
      const id = viewId(view, index);
      if (!current[id]) ((current[id] = now()), (changed = true));
    });
    if (changed) await chromeApi.storage.local.set({ [VISITS_KEY]: current });
  }

  async function buildClusters(message) {
    const index = await semanticIndex();
    if (!index?.ids?.length)
      return { ok: false, error: 'Build the meaning index first (Settings › Library › Meaning search).' };
    const count = index.ids.length,
      k = Math.max(2, Math.min(60, Number(message.k) || suggestK(count)));
    const result = kmeans(index.vectors, count, { k, seed: Number(message.seed) || 7 });
    const members = Array.from({ length: result.k }, () => []);
    for (let row = 0; row < count; row++) {
      const cluster = result.assignments[row];
      if (cluster >= 0) members[cluster].push([index.ids[row], result.scores[row]]);
    }
    const central = members.map(list =>
      list
        .sort((a, b) => b[1] - a[1])
        .slice(0, 60)
        .map(([id]) => id)
    );
    const records = await readRecords(central.flat());
    const byId = new Map(records.map(record => [String(record.id), record]));
    const texts = new Map(central.map((ids, cluster) => [cluster, ids.map(id => byId.get(id)?.text || '')]));
    const labels = labelClusters(texts);
    const previous = (await meta.get(CLUSTERS_KEY))?.clusters || [];
    const clusters = carryNames(
      previous,
      members
        .map((list, cluster) => ({
          id: `c${cluster}`,
          size: list.length,
          terms: labels.get(cluster) || [],
          sample: central[cluster].slice(0, 6),
          cohesion: list.length
            ? Math.round((list.reduce((sum, [, score]) => sum + score, 0) / list.length) * 100) / 100
            : 0,
          ids: list.map(([id]) => id),
        }))
        .filter(cluster => cluster.size > 0)
        .sort((a, b) => b.size - a.size)
    );
    const value = { builtAt: now(), k: result.k, documents: count, clusters };
    await meta.set(CLUSTERS_KEY, value);
    return { ok: true, ...summary(value) };
  }
  const summary = value => ({
    builtAt: value.builtAt,
    k: value.k,
    documents: value.documents,
    clusters: value.clusters.map(({ ids, ...cluster }) => cluster),
  });
  async function getClusters() {
    const value = await meta.get(CLUSTERS_KEY);
    return value ? { ok: true, ...summary(value) } : { ok: true, clusters: [], builtAt: 0 };
  }
  async function rename(message) {
    const value = await meta.get(CLUSTERS_KEY);
    const cluster = value?.clusters.find(entry => entry.id === String(message.id || ''));
    if (!cluster) throw Error('Unknown cluster');
    cluster.name = String(message.name || '')
      .trim()
      .slice(0, 80);
    await meta.set(CLUSTERS_KEY, value);
    return { ok: true, ...summary(value) };
  }
  async function clusterMembers(message) {
    const value = await meta.get(CLUSTERS_KEY);
    const cluster = value?.clusters.find(entry => entry.id === String(message.id || ''));
    if (!cluster) throw Error('Unknown cluster');
    return {
      ok: true,
      id: cluster.id,
      name: cluster.name || cluster.terms.join(' · '),
      ids: cluster.ids.slice(0, 20000),
    };
  }

  const MESSAGES = {
    SEARCH_SUGGEST: message => suggest(message),
    SAVED_VIEW_ALERTS: () => alerts(),
    SAVED_VIEW_VISITED: message => visited(message),
    CLUSTERS_BUILD: message => buildClusters(message),
    CLUSTERS_GET: () => getClusters(),
    CLUSTER_RENAME: message => rename(message),
    CLUSTER_MEMBERS: message => clusterMembers(message),
  };
  return {
    suggest,
    alerts,
    initVisits,
    buildClusters,
    types: Object.keys(MESSAGES),
    handle: message => MESSAGES[message.type](message),
  };
}
