// XVault 21: pure selection logic for the archive-quality tools (repair, thread gaps, still-on-X
// checks) and the quality report. Inputs are archived post records; nothing here touches storage.
import '../library-search-core.js';

const search = () => globalThis.XVaultLibrarySearch;
const DAY = 86400000;

/** Quality summary: histogram (10-point buckets), counts per missing reason, incomplete total. */
export function qualityReport(posts) {
  const buckets = Array(11).fill(0),
    reasons = {};
  let incomplete = 0,
    total = 0,
    sum = 0;
  for (const post of posts) {
    const { score, missing } = search().postQuality(post);
    total++;
    sum += score;
    buckets[Math.min(10, Math.floor(score / 10))]++;
    if (score < search().INCOMPLETE_BELOW) incomplete++;
    for (const reason of missing) reasons[reason] = (reasons[reason] || 0) + 1;
  }
  return { total, incomplete, average: total ? Math.round(sum / total) : 0, buckets, reasons };
}

/** Lowest-quality posts first; skips posts repaired recently or known to be gone from X. */
export function repairCandidates(posts, { now = Date.now(), retryDays = 7, limit = 500 } = {}) {
  const out = [];
  for (const post of posts) {
    if (!/^\d{1,32}$/.test(String(post?.id || ''))) continue;
    const state = post.availability?.state;
    if (state && state !== 'available') continue;
    if (Number(post.repairAttemptAt || 0) > now - retryDays * DAY) continue;
    const { score, missing } = search().postQuality(post);
    if (score >= search().INCOMPLETE_BELOW) continue;
    out.push({ id: String(post.id), score, missing });
  }
  return out.sort((a, b) => a.score - b.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/** Referenced-but-not-archived posts: thread parents first (by how many archived replies need them), then quotes. */
export function gapCandidates(posts, archivedIds, { limit = 500, include = ['parents', 'quotes'] } = {}) {
  const parents = new Map(),
    quotes = new Map(),
    known = archivedIds instanceof Set ? archivedIds : new Set(posts.map(post => String(post.id)));
  for (const post of posts) {
    const parent = String(post?.replyToId || ''),
      quoted = String(post?.quotedPostId || '');
    if (include.includes('parents') && /^\d{1,32}$/.test(parent) && !known.has(parent))
      parents.set(parent, (parents.get(parent) || 0) + 1);
    if (include.includes('quotes') && /^\d{1,32}$/.test(quoted) && !known.has(quoted))
      quotes.set(quoted, (quotes.get(quoted) || 0) + 1);
  }
  const rank = map => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const list = [
    ...rank(parents).map(([id, needed]) => ({ id, kind: 'parent', needed })),
    ...rank(quotes)
      .filter(([id]) => !parents.has(id))
      .map(([id, needed]) => ({ id, kind: 'quote', needed })),
  ];
  return { parents: parents.size, quotes: quotes.size, list: list.slice(0, limit) };
}

/** Threads in the archive with at least one missing link, for the "fetch the rest" list. */
export function threadGaps(posts, archivedIds, { limit = 100 } = {}) {
  const known = archivedIds instanceof Set ? archivedIds : new Set(posts.map(post => String(post.id)));
  const threads = new Map();
  for (const post of posts) {
    const conversation = String(post?.conversationId || '');
    if (!conversation) continue;
    const entry = threads.get(conversation) || {
      conversationId: conversation,
      posts: 0,
      missing: new Set(),
      handle: '',
    };
    entry.posts++;
    entry.handle ||= String(post.author?.handle || '');
    const parent = String(post.replyToId || '');
    if (parent && !known.has(parent)) entry.missing.add(parent);
    if (!known.has(conversation)) entry.missing.add(conversation);
    threads.set(conversation, entry);
  }
  return [...threads.values()]
    .filter(entry => entry.missing.size)
    .map(entry => ({ ...entry, missing: [...entry.missing] }))
    .sort((a, b) => b.posts - a.posts || b.missing.length - a.missing.length)
    .slice(0, limit);
}

/** Favourites (optionally colour-labelled posts, or everything) not checked within `recheckDays`. */
export function checkCandidates(posts, { scope = 'favorites', recheckDays = 30, now = Date.now(), limit = 500 } = {}) {
  const out = [];
  for (const post of posts) {
    if (!/^\d{1,32}$/.test(String(post?.id || ''))) continue;
    const meta = post.userMeta || {};
    const inScope = scope === 'all' || meta.favorite || (scope === 'favorites-labeled' && !!meta.colorLabel);
    if (!inScope) continue;
    const checked = Number(post.availability?.checkedAt || 0);
    if (checked > now - recheckDays * DAY) continue;
    out.push({ id: String(post.id), checkedAt: checked });
  }
  return out.sort((a, b) => a.checkedAt - b.checkedAt || a.id.localeCompare(b.id)).slice(0, limit);
}

/** Change-tracking summary for the Quality page. */
export function changeSummary(posts) {
  const out = { edited: 0, revisions: 0, deleted: 0, unavailable: 0, checked: 0, recent: [] };
  for (const post of posts) {
    const textEdits = Number(post.textRevisionCount) || 0;
    if (textEdits > 0 || post.edit?.edited) out.edited++;
    out.revisions += Number(post.revisionCount) || 0;
    const state = post.availability?.state;
    if (state) out.checked++;
    if (state === 'deleted') out.deleted++;
    else if (state && state !== 'available') out.unavailable++;
    if (state && state !== 'available')
      out.recent.push({
        id: String(post.id),
        state,
        at: Number(post.availability.checkedAt) || 0,
        handle: String(post.author?.handle || ''),
        text: String(post.text || '').slice(0, 140),
      });
  }
  out.recent = out.recent.sort((a, b) => b.at - a.at).slice(0, 25);
  return out;
}
