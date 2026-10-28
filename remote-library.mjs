import './library-search-core.js';

const search = globalThis.XVaultLibrarySearch;
const POST_ID = /^\d{1,32}$/;

function remoteProjection(post, index, downloadedIds, missingIds, knownBytesById = null, inboxSince = 0, downloadSummary = null) {
  if (!post || !POST_ID.test(String(post.id || ''))) return null;
  const media = Array.isArray(post.media) ? post.media : [];
  const userMeta = post.userMeta && typeof post.userMeta === 'object' ? post.userMeta : {};
  const mediaNotes = media.map(item => String(item?.xvault?.note || '').toLowerCase()).filter(Boolean);
  const annotationText = media.flatMap(item => (Array.isArray(item?.xvault?.annotations) ? item.xvault.annotations : []).filter(annotation => !annotation?.deletedAt).map(annotation => String(annotation?.text || '').toLowerCase()).filter(Boolean)).join(' ');
  const handle = String(post.author?.handle || '').replace(/^@/, '').toLowerCase();
  const metrics = post.metrics && typeof post.metrics === 'object' ? post.metrics : {};
  const archiveSources = [...(Array.isArray(post.archiveSources) ? post.archiveSources : []),
    ...(Array.isArray(post.sourceFlags) ? post.sourceFlags : [])];
  return {
    id: String(post.id),
    text: String(post.text || '').slice(0, 3000).toLowerCase(),
    displayText: String(post.text || '').slice(0, 900),
    handle,
    name: String(post.author?.name || handle).slice(0, 80),
    createdAt: post.createdAt || null,
    mediaTypes: media.map(item => String(item?.type || '').toLowerCase()).filter(Boolean),
    mediaCount: media.length,
    sources: archiveSources.map(source => String(source).toLowerCase()),
    sensitive: !!post.sensitive,
    favorite: !!userMeta.favorite,
    tags: (Array.isArray(userMeta.tags) ? userMeta.tags : []).map(tag => String(tag).toLowerCase()),
    note: !!([userMeta.note, ...mediaNotes, annotationText].some(value => String(value || '').trim())),
    noteText: [String(userMeta.note || '').toLowerCase(), ...mediaNotes, annotationText].filter(Boolean).join(' '),
    mediaNoteText: mediaNotes.join(' '), annotationText,
    inbox: Number(inboxSince) > 0 && Number(post.archivedAt || 0) >= Number(inboxSince) && !userMeta.reviewedAt,
    downloaded: downloadSummary ? !!downloadSummary.downloaded : downloadedIds.has(String(post.id)),
    missing: downloadSummary ? !!downloadSummary.missing : missingIds.has(String(post.id)),
    metrics: Object.fromEntries(['likes', 'views', 'bookmarks', 'reposts', 'replies'].map(key => [key, Number(metrics[key] || 0)])),
    archivedAt: Number(post.archivedAt || 0),
    postedAt: new Date(post.createdAt || 0).getTime(),
    knownBytes: downloadSummary ? Math.max(0, Number(downloadSummary.knownBytes) || 0) : knownBytesById?.get(String(post.id)) || 0,
    index
  };
}

function compareId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRemote(a, b, sort) {
  const metric = ['likes', 'views', 'bookmarks', 'reposts', 'replies'].includes(sort) ? sort : null;
  let result;
  if (metric) result = b.metrics[metric] - a.metrics[metric];
  else if (sort === 'old') result = a.archivedAt - b.archivedAt;
  else if (sort === 'media') result = b.mediaCount - a.mediaCount;
  else if (sort === 'author') result = a.handle.localeCompare(b.handle);
  else result = b.archivedAt - a.archivedAt;
  return result || compareId(a.id, b.id);
}

function tupleFor(row, sort) {
  const metric = ['likes', 'views', 'bookmarks', 'reposts', 'replies'].includes(sort) ? sort : null;
  return {
    id: row.id,
    archivedAt: row.archivedAt,
    metric: metric ? row.metrics[metric] : 0,
    mediaCount: row.mediaCount,
    handle: row.handle
  };
}

function compareCursor(row, tuple, sort) {
  const tail = { ...row, ...tuple, metrics: { ...row.metrics, [sort]: tuple.metric } };
  const result = compareRemote(row, tail, sort);
  return result || compareId(row.id, tuple.id);
}

export function decodeRemoteCursor(cursor, sort = 'new', query = '') {
  if (cursor == null || cursor === '') return null;
  try {
    const prefix = 'xvr1:';
    if (typeof cursor !== 'string' || cursor.length > 4096 || !cursor.startsWith(prefix)) throw new Error();
    const value = JSON.parse(decodeURIComponent(cursor.slice(prefix.length)));
    if (value.sort !== sort || value.query !== query || !value.tuple || !POST_ID.test(String(value.tuple.id || '')) ||
        !Number.isFinite(Number(value.tuple.archivedAt)) || !Number.isFinite(Number(value.tuple.metric)) ||
        !Number.isFinite(Number(value.tuple.mediaCount)) || typeof value.tuple.handle !== 'string') throw new Error();
    return value.tuple;
  } catch {
    throw new Error('This library cursor is invalid or belongs to a different search');
  }
}

function encodeCursor(row, sort, query) {
  return `xvr1:${encodeURIComponent(JSON.stringify({ sort, query, tuple: tupleFor(row, sort) }))}`;
}

export function createRemoteScanner(options = {}) {
  if (!search) throw new Error('The shared Library search rules are unavailable');
  const query = String(options.query || '').trim();
  if (query.length > 1000) throw new RangeError('Search query is too long');
  const sort = ['new', 'old', 'likes', 'views', 'bookmarks', 'reposts', 'replies', 'media', 'author'].includes(options.sort)
    ? options.sort : 'new';
  const limit = Math.max(1, Math.min(60, Math.floor(Number(options.limit) || 40)));
  const after = decodeRemoteCursor(options.cursor, sort, query);
  const tokens = search.compileQuery(query);
  const downloadedIds = options.downloadedIds instanceof Set ? options.downloadedIds : new Set();
  const missingIds = options.missingIds instanceof Set ? options.missingIds : new Set();
  const page = [];
  let matched = 0;
  let index = 0;
  const visit = (post, downloadSummary = null) => {
    const row = remoteProjection(post, index++, downloadedIds, missingIds, options.knownBytesById, options.inboxSince, downloadSummary);
    if (!row || !search.matchesCompiledQuery(row, tokens)) return;
    matched++;
    if (after && compareCursor(row, after, sort) <= 0) return;
    let low = 0, high = page.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareRemote(page[mid], row, sort) <= 0) low = mid + 1;
      else high = mid;
    }
    page.splice(low, 0, row);
    if (page.length > limit + 1) page.pop();
  };
  const finish = () => {
    const hasMore = page.length > limit;
    if (hasMore) page.pop();
    const rows = page.map(row => ({
      id: row.id,
      handle: row.handle,
      name: row.name,
      text: row.displayText,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      metrics: row.metrics,
      sensitive: row.sensitive,
      favorite: row.favorite,
      tags: row.tags.slice(0, 30),
      mediaCount: row.mediaCount,
      mediaTypes: row.mediaTypes.slice(0, 12)
    }));
    const last = page[page.length - 1];
    return {
      rows,
      matched,
      nextCursor: hasMore && last ? encodeCursor(last, sort, query) : null,
      hasMore,
      sort
    };
  };
  return Object.freeze({ visit, finish });
}

function planValue(row, sort) {
  if (['likes', 'views', 'bookmarks', 'reposts', 'replies'].includes(sort)) return Number(row.metrics[sort]) || 0;
  if (sort === 'old' || sort === 'new') return Number(row.archivedAt) || 0;
  if (sort === 'media') return Number(row.mediaCount) || 0;
  if (sort === 'author') return row.handle;
  return Number(row.archivedAt) || 0;
}

function comparePlanRows(a, b, sort) {
  let result = 0;
  if (sort === 'old') result = a.value - b.value;
  else if (sort === 'new') result = b.value - a.value;
  else if (sort === 'author') result = String(a.value).localeCompare(String(b.value));
  else result = Number(b.value) - Number(a.value);
  return result || compareId(a.id, b.id);
}

const REMOTE_RANK_LIMIT = 5000;

function retainPlanRow(heap, candidate, limit, sort) {
  if (!limit) return;
  if (heap.length < limit) {
    heap.push(candidate);
    let index = heap.length - 1;
    while (index) {
      const parent = (index - 1) >> 1;
      if (comparePlanRows(heap[index], heap[parent], sort) <= 0) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
    return;
  }
  if (comparePlanRows(candidate, heap[0], sort) >= 0) return;
  heap[0] = candidate;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1, right = left + 1;
    let worst = index;
    if (left < heap.length && comparePlanRows(heap[left], heap[worst], sort) > 0) worst = left;
    if (right < heap.length && comparePlanRows(heap[right], heap[worst], sort) > 0) worst = right;
    if (worst === index) break;
    [heap[index], heap[worst]] = [heap[worst], heap[index]];
    index = worst;
  }
}

// Remote pages are separated by HTTP requests, so IndexedDB state can change
// between them. Bind the cached ID order to the generations that shaped it.
export function remotePlanIsCurrent(entry, revision, downloadRevision = null) {
  if (!entry || !Number.isFinite(Number(entry.revision)) || Number(entry.revision) !== Number(revision)) return false;
  return entry.downloadRevision == null || Number(entry.downloadRevision) === Number(downloadRevision);
}

// Large Remote searches cache only post IDs plus the active sort key. Full
// post/media records remain in IndexedDB and are read only for the requested
// bounded page. This makes subsequent phone pages O(page size), not O(archive).
export function createRemotePlanner(options = {}) {
  if (!search) throw new Error('The shared Library search rules are unavailable');
  const query = String(options.query || '').trim();
  if (query.length > 1000) throw new RangeError('Search query is too long');
  const sort = ['new', 'old', 'likes', 'views', 'bookmarks', 'reposts', 'replies', 'media', 'author'].includes(options.sort)
    ? options.sort : 'new';
  const tokens = search.compileQuery(query);
  const downloadedIds = options.downloadedIds instanceof Set ? options.downloadedIds : new Set();
  const missingIds = options.missingIds instanceof Set ? options.missingIds : new Set();
  const candidates = [];
  const limit = Math.max(1, Math.min(REMOTE_RANK_LIMIT, Math.floor(Number(options.maxCandidates) || REMOTE_RANK_LIMIT)));
  let matched = 0;
  let index = 0;
  const visit = (post, downloadSummary = null) => {
    const row = remoteProjection(post, index++, downloadedIds, missingIds, options.knownBytesById, options.inboxSince, downloadSummary);
    if (!row || !search.matchesCompiledQuery(row, tokens)) return;
    matched++;
    retainPlanRow(candidates, { id: row.id, value: planValue(row, sort) }, limit, sort);
  };
  const finish = () => {
    candidates.sort((a, b) => comparePlanRows(a, b, sort));
    return Object.freeze({ sort, query, matched, truncated: matched > candidates.length, rows: candidates });
  };
  return Object.freeze({ visit, finish });
}

export function pageRemotePlan(plan, offset, limit = 40) {
  if (!plan || !Array.isArray(plan.rows)) throw new TypeError('A Remote query plan is required');
  const start = Math.max(0, Math.min(plan.rows.length, Math.floor(Number(offset) || 0)));
  const size = Math.max(1, Math.min(50, Math.floor(Number(limit) || 40)));
  const rows = plan.rows.slice(start, start + size).map(row => ({ id: row.id }));
  const nextOffset = start + rows.length;
  return { rows, matched: plan.matched, nextOffset,
    hasMore: nextOffset < plan.rows.length, truncated: !!plan.truncated, sort: plan.sort };
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const binary = atob(String(value).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (toBase64Url(bytes) !== value) throw new Error('Noncanonical cursor encoding');
  return bytes;
}

export function remotePageCursorId(cursor) {
  const match = String(cursor || '').match(/^xvr3:([0-9a-f-]{36}):[A-Za-z0-9_-]{1,3500}\.[A-Za-z0-9_-]{20,100}$/i);
  if (!match) throw new Error('Search cursor is invalid or expired');
  return match[1];
}

export async function encodeRemotePageCursor(id, after, matched = 0, scanned = 0, secret) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || '')) || !after || !['indexed', 'legacy'].includes(after.phase) || !['new', 'old'].includes(after.sort)) {
    throw new TypeError('A revision-bound Remote cursor is required');
  }
  if (!(secret instanceof Uint8Array) || secret.length < 32) throw new TypeError('Remote cursor signing key is unavailable');
  const payload = new TextEncoder().encode(JSON.stringify({ id, after, matched, scanned }));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
  const token = `xvr3:${id}:${toBase64Url(payload)}.${toBase64Url(signature)}`;
  if (token.length > 4096) throw new RangeError('Remote query cursor is too large');
  return token;
}

export async function decodeRemotePageCursor(cursor, secret) {
  try {
    const match = String(cursor || '').match(/^xvr3:([0-9a-f-]{36}):([A-Za-z0-9_-]{1,3500})\.([A-Za-z0-9_-]{20,100})$/i);
    if (!match) throw new Error();
    if (!(secret instanceof Uint8Array) || secret.length < 32) throw new Error();
    const payload = fromBase64Url(match[2]), signature = fromBase64Url(match[3]);
    const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('HMAC', key, signature, payload)) throw new Error();
    const value = JSON.parse(new TextDecoder().decode(payload));
    if (value.id !== match[1]) throw new Error();
    const after = value?.after;
    if (!after || !['indexed', 'legacy'].includes(after.phase) || !['new', 'old'].includes(after.sort) ||
        !Number.isSafeInteger(Number(after.revision)) || Number(after.revision) < 0 ||
        after.id == null || String(after.id).length > 128 ||
        (after.phase === 'indexed' && !Number.isFinite(Number(after.key))) ||
        !Number.isSafeInteger(Number(value.matched)) || Number(value.matched) < 0 ||
        !Number.isSafeInteger(Number(value.scanned)) || Number(value.scanned) < 0 ||
        (after.downloadRevision != null && (!Number.isSafeInteger(Number(after.downloadRevision)) || Number(after.downloadRevision) < 0))) throw new Error();
    return { id: match[1], after, matched: Number(value.matched), scanned: Number(value.scanned) };
  } catch {
    throw new Error('Search cursor is invalid or expired');
  }
}

export function scanRemotePage(posts, options = {}) {
  const scanner = createRemoteScanner(options);
  for (const post of posts) scanner.visit(post);
  return scanner.finish();
}
