// Service-worker side of meaning search: builds/loads the local semantic index, keeps it current
// incrementally between full rebuilds and answers SEMANTIC_* messages. The index is derived data
// (xvault-derived/meta) — never part of archive records, exports or backups.
import {
  buildSemanticIndexAsync,
  searchIndex,
  similarTo,
  suggestTags,
  upsertDocuments,
  documentText,
  SEMANTIC_VERSION,
} from './semantic.mjs';

export const SEMANTIC_KEY = 'semantic:index';
const DAY = 86400000;

export function createSemanticService(deps) {
  const { store, readRevision, scanDocuments, documentsSince, readRecords, ocrMap, now = () => Date.now() } = deps;
  let index = null,
    pending = null,
    lastBuild = null;
  const queryCache = new Map();

  async function load() {
    try {
      const row = (await store.getMany('meta', [SEMANTIC_KEY])).get(SEMANTIC_KEY);
      return row?.value?.version === SEMANTIC_VERSION ? row.value : null;
    } catch {
      return null;
    }
  }
  async function persist() {
    try {
      await store.putMany('meta', [{ key: SEMANTIC_KEY, value: index }]);
    } catch (error) {
      console.warn('Meaning index could not be cached; it will be rebuilt next time.', error);
    }
  }
  async function rebuild(revision) {
    const started = now(),
      ocr = await ocrMap().catch(() => new Map()),
      docs = [];
    await scanDocuments(post => docs.push({ id: String(post.id), text: documentText(post, ocr.get(String(post.id))) }));
    index = await buildSemanticIndexAsync(docs, { now: now(), revision });
    index.syncedAt = index.builtAt;
    lastBuild = { documents: docs.length, ms: now() - started, at: now() };
    queryCache.clear();
    await persist();
    return index;
  }
  function stale(current) {
    if (!current) return true;
    if (now() - current.builtAt > 7 * DAY) return true;
    return (current.added || 0) > Math.max(150, current.documents * 0.3);
  }
  async function ensure({ force = false } = {}) {
    if (pending) return pending;
    pending = (async () => {
      const revision = await readRevision();
      if (!force && index?.revision === revision) return index;
      if (!force) index ||= await load();
      if (!force && index?.revision === revision) return index;
      if (force || stale(index)) return rebuild(revision);
      // Between rebuilds, new captures are embedded with the existing vocabulary.
      const ocr = await ocrMap().catch(() => new Map());
      const posts = await documentsSince(Math.max(0, (index.syncedAt || index.builtAt) - 60000));
      index = upsertDocuments(
        index,
        posts.map(post => ({ id: String(post.id), text: documentText(post, ocr.get(String(post.id))) }))
      );
      index.revision = revision;
      index.syncedAt = now();
      queryCache.clear();
      persist();
      return index;
    })().finally(() => (pending = null));
    return pending;
  }
  const identity = current => `${current.builtAt}:${current.ids.length}:${current.syncedAt || 0}`;

  /** rules: compiled semantic rules → { revision, scores: Map postId → { [ruleKey]: score } }. */
  async function scoresFor(rules, keyOf) {
    const current = await ensure(),
      byId = new Map();
    for (const rule of rules) {
      const key = keyOf(rule),
        cacheKey = `${identity(current)}|${key}`;
      let found = queryCache.get(cacheKey);
      if (!found) {
        found = rule.similarTo
          ? new Map(similarTo(current, rule.similarTo, { limit: 400, minimum: 0.18 }).map(hit => [hit.id, hit.score]))
          : searchIndex(current, rule.value);
        queryCache.set(cacheKey, found);
        if (queryCache.size > 24) queryCache.delete(queryCache.keys().next().value);
      }
      for (const [id, score] of found) {
        if (!byId.has(id)) byId.set(id, {});
        byId.get(id)[key] = score;
      }
    }
    return { revision: identity(current), scores: byId };
  }

  async function suggestionsFor(id) {
    const current = await ensure(),
      [post] = await readRecords([String(id)]);
    if (!post) return [];
    const neighbours = similarTo(current, id, { limit: 30, minimum: 0.22 }),
      records = await readRecords(neighbours.map(hit => hit.id)),
      tagsById = new Map(records.map(record => [String(record.id), record.userMeta?.tags || []]));
    return suggestTags(
      { text: documentText(post), tags: post.userMeta?.tags || [] },
      neighbours.map(hit => ({ score: hit.score, tags: tagsById.get(hit.id) || [] }))
    );
  }

  const status = current =>
    current
      ? {
          documents: current.ids.length,
          vocabulary: current.terms.length,
          builtAt: current.builtAt,
          syncedAt: current.syncedAt || current.builtAt,
          added: current.added || 0,
          lastBuild,
        }
      : null;
  const MESSAGES = {
    SEMANTIC_STATUS: async () => ({ ok: true, index: status(index || (await load())) }),
    SEMANTIC_REBUILD: async () => ({ ok: true, index: status(await ensure({ force: true })) }),
    SEMANTIC_SEARCH: async m => {
      const current = await ensure(),
        hits = searchIndex(current, String(m.text || '').slice(0, 500), {
          limit: Math.max(1, Math.min(500, Number(m.limit) || 50)),
        });
      return { ok: true, results: [...hits].map(([postId, score]) => ({ id: postId, score })) };
    },
    SEMANTIC_SIMILAR: async m => {
      const current = await ensure();
      return {
        ok: true,
        results: similarTo(current, String(m.id || ''), { limit: Math.max(1, Math.min(100, Number(m.limit) || 12)) }),
      };
    },
    SEMANTIC_SUGGEST_TAGS: async m => ({ ok: true, suggestions: await suggestionsFor(String(m.id || '')) }),
    // Storage manager: drop the cached index (it is rebuilt on the next about:/similar: query).
    SEMANTIC_CLEAR: async () => {
      if (pending) await pending.catch(() => {});
      index = null;
      queryCache.clear();
      const database = await store.open(),
        transaction = database.transaction('meta', 'readwrite');
      transaction.objectStore('meta').delete(SEMANTIC_KEY);
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = transaction.onabort = () => reject(transaction.error || Error('Clear failed'));
      });
      return { ok: true };
    },
  };
  return {
    ensure,
    scoresFor,
    suggestionsFor,
    types: Object.keys(MESSAGES),
    handles: type => Object.hasOwn(MESSAGES, type),
    handle: message => MESSAGES[message.type](message),
  };
}
