// XVault 25: locally archived author avatars.
// Avatars live in their own small IndexedDB database ("xvault-avatars"), separate from the archive schema, so
// they never force a Library upgrade and can be cleared on their own. The service worker writes them (after a
// capture, or when a page asks for an author it has not stored yet); the dashboard reads the same database
// directly; the phone Remote gets them through the Companion's /api/avatar/<handle> route.
export const AVATAR_DB = 'xvault-avatars';
export const AVATAR_STORE = 'avatars';
export const MAX_AVATAR_BYTES = 256 * 1024;
export const AVATAR_MESSAGES = ['AVATARS_REMEMBER', 'AVATARS_STATS', 'AVATARS_CLEAR'];
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const DAY = 86_400_000;

/** Canonical 96-px variant of an X profile image, or '' for anything that is not a pbs.twimg.com avatar. */
export function avatarSource(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'pbs.twimg.com' || parsed.port) return '';
  if (!/^\/(?:profile_images|default_profile_images)\/[\w./-]+$/.test(parsed.pathname)) return '';
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(
    /_(?:normal|bigger|mini|reasonably_small|x96|200x200|400x400)(\.[A-Za-z]{3,4})?$/,
    '_x96$1'
  );
  return parsed.href;
}

/** Image type from magic bytes (the server's Content-Type is not trusted). */
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45)
    return 'image/webp';
  return '';
}

/** Unique { handle, url } pairs (lower-cased handle key) from post records, including quoted authors. */
export function avatarCandidates(posts, limit = 400) {
  const found = new Map();
  const add = author => {
    const handle = String(author?.handle || '').replace(/^@/, '');
    const url = avatarSource(author?.avatar);
    if (!HANDLE.test(handle) || !url || found.has(handle.toLowerCase())) return;
    found.set(handle.toLowerCase(), { handle: handle.toLowerCase(), url });
  };
  for (const post of posts || []) {
    if (found.size >= limit) break;
    add(post?.author);
    add(post?.quoted?.author || post?.quote?.author);
    add(post?.retweeted?.author);
  }
  return [...found.values()].slice(0, limit);
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

/** Promise wrapper around the avatar database. `idb` is injectable for tests. */
export function openAvatarStore(idb = globalThis.indexedDB) {
  let opening = null;
  const open = () =>
    (opening ||= new Promise((resolve, reject) => {
      const request = idb.open(AVATAR_DB, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(AVATAR_STORE)) {
          const store = database.createObjectStore(AVATAR_STORE, { keyPath: 'handle' });
          store.createIndex('fetchedAt', 'fetchedAt');
          // size > 0 marks a stored image; failure rows keep size 0, so pages can list real avatars by key only.
          store.createIndex('size', 'size');
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          opening = null;
        };
        resolve(database);
      };
      request.onerror = () => {
        opening = null;
        reject(request.error || new Error('Avatar storage is unavailable'));
      };
    }));
  const run = async (mode, work) => {
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(AVATAR_STORE, mode);
      let value;
      const request = work(tx.objectStore(AVATAR_STORE));
      if (request) request.onsuccess = () => (value = request.result);
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Avatar storage failed'));
    });
  };
  return {
    get: handle => run('readonly', store => store.get(handle)),
    put: row => run('readwrite', store => store.put(row)),
    remove: handle => run('readwrite', store => store.delete(handle)),
    clear: () => run('readwrite', store => store.clear()),
    count: () => run('readonly', store => store.count()),
    keys: () => run('readonly', store => store.getAllKeys()),
    async bytes() {
      let total = 0;
      await run('readonly', store => {
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          total += Number(row.value?.size) || 0;
          row.continue();
        };
        return null;
      });
      return total;
    },
  };
}

/**
 * Background fetcher. `enabled()` reads the archiveAvatars setting; `lookup(handle)` finds an avatar URL for an
 * author that has no stored image yet (used when the phone asks for one).
 */
export function createAvatarArchive({
  store,
  fetchImpl = (...args) => fetch(...args),
  enabled = async () => true,
  lookup = async () => '',
  now = () => Date.now(),
  onChange = () => {},
  concurrency = 2,
  staleMs = 30 * DAY,
  retryMs = DAY / 2,
  timeoutMs = 15_000,
  maxQueue = 600,
} = {}) {
  const queue = new Map();
  const inflight = new Map();
  let workers = 0;
  let stored = 0;

  const fresh = (row, url) => {
    if (!row) return false;
    const age = now() - Number(row.data ? row.fetchedAt : row.failedAt || 0);
    if (row.source === url && row.data) return age < staleMs;
    if (row.source === url && !row.data) return age < retryMs;
    return Boolean(row.data) && !url;
  };

  async function fetchOne(handle, url) {
    const previous = await store.get(handle).catch(() => null);
    if (fresh(previous, url)) return previous;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : 0;
    let failure = 'X did not return this avatar';
    try {
      const response = await fetchImpl(url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'force-cache',
        signal: controller?.signal,
      });
      if (response?.ok) {
        const declared = Number(response.headers?.get?.('content-length')) || 0;
        if (declared > MAX_AVATAR_BYTES) failure = 'Avatar is larger than 256 KB';
        else {
          const buffer = await response.arrayBuffer();
          const mime = sniffImage(new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength)));
          if (buffer.byteLength > MAX_AVATAR_BYTES) failure = 'Avatar is larger than 256 KB';
          else if (!mime) failure = 'Avatar is not a JPEG, PNG, GIF or WebP image';
          else {
            const row = { handle, source: url, mime, data: buffer, size: buffer.byteLength, fetchedAt: now() };
            await store.put(row);
            stored++;
            onChange(handle);
            return row;
          }
        }
      } else if (response) failure = `X answered ${response.status}`;
    } catch (error) {
      failure = error?.name === 'AbortError' ? 'X did not answer in time' : 'Network error';
    } finally {
      if (timer) clearTimeout(timer);
    }
    // Keep a stale image when a refresh fails; only remember the failure time so it is not retried in a loop.
    const row = previous?.data
      ? { ...previous, failedAt: now(), error: failure }
      : { handle, source: url, failedAt: now(), error: failure, size: 0 };
    await store.put(row).catch(() => {});
    return previous?.data ? previous : null;
  }

  function fetchShared(handle, url) {
    if (inflight.has(handle)) return inflight.get(handle);
    const task = fetchOne(handle, url).finally(() => inflight.delete(handle));
    inflight.set(handle, task);
    return task;
  }

  async function pump() {
    while (workers < concurrency && queue.size) {
      const [handle, url] = queue.entries().next().value;
      queue.delete(handle);
      workers++;
      fetchShared(handle, url)
        .catch(() => null)
        .finally(() => {
          workers--;
          void pump();
        });
    }
  }

  async function remember(items) {
    if (!(await enabled())) return { ok: true, queued: 0, disabled: true };
    let queued = 0;
    for (const item of items || []) {
      const handle = String(item?.handle || '')
        .replace(/^@/, '')
        .toLowerCase();
      const url = avatarSource(item?.url || item?.avatar);
      if (!HANDLE.test(handle) || !url || queue.has(handle) || inflight.has(handle)) continue;
      if (queue.size >= maxQueue) break;
      queue.set(handle, url);
      queued++;
    }
    void pump();
    return { ok: true, queued };
  }

  async function read(handle, { fetchMissing = true } = {}) {
    const key = String(handle || '')
      .replace(/^@/, '')
      .toLowerCase();
    if (!HANDLE.test(key)) return null;
    let row = await store.get(key).catch(() => null);
    if (row?.data) return row;
    if (!fetchMissing || !(await enabled())) return null;
    if (row && now() - Number(row.failedAt || 0) < retryMs) return null;
    const url = avatarSource(await lookup(handle).catch(() => ''));
    if (!url) return null;
    row = await fetchShared(key, url);
    return row?.data ? row : null;
  }

  async function readEncoded(handle) {
    const row = await read(handle);
    if (!row) return { ok: false };
    return { ok: true, mime: row.mime, data: toBase64(row.data) };
  }

  async function stats() {
    const [count, bytes] = await Promise.all([store.count(), store.bytes()]);
    return { ok: true, count, bytes, queued: queue.size + inflight.size, storedThisSession: stored };
  }

  async function clear() {
    queue.clear();
    await store.clear();
    onChange('*');
    return { ok: true };
  }

  return {
    types: AVATAR_MESSAGES,
    remember,
    read,
    readEncoded,
    stats,
    clear,
    pending: () => queue.size + inflight.size,
    async handle(message) {
      if (message.type === 'AVATARS_REMEMBER')
        return remember(Array.isArray(message.items) ? message.items.slice(0, 200) : []);
      if (message.type === 'AVATARS_STATS') return stats();
      if (message.type === 'AVATARS_CLEAR') return clear();
      throw Error('Unsupported avatar message');
    },
  };
}
