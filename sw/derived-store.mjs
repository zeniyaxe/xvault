// Derived, rebuildable data (image fingerprints, OCR text) lives in its own IndexedDB database so it
// never touches archive records, exports or backups. Everything here can be deleted and recomputed.
export const DERIVED_DB = 'xvault-derived';
// v1 (XVault 18): phash. v2 (XVault 19): + ocr (by postId) + meta (revisions).
// v3 (XVault 21): + snapshots (opt-in readable copies of linked pages, by postId).
export const DERIVED_VERSION = 3;

export function upgradeDerived(database, transaction) {
  if (!database.objectStoreNames.contains('phash')) database.createObjectStore('phash', { keyPath: 'key' });
  if (!database.objectStoreNames.contains('ocr')) {
    const ocr = database.createObjectStore('ocr', { keyPath: 'key' });
    ocr.createIndex('postId', 'postId', { unique: false });
  } else {
    const ocr = transaction.objectStore('ocr');
    if (!ocr.indexNames.contains('postId')) ocr.createIndex('postId', 'postId', { unique: false });
  }
  if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' });
  if (!database.objectStoreNames.contains('snapshots')) {
    const snapshots = database.createObjectStore('snapshots', { keyPath: 'key' });
    snapshots.createIndex('postId', 'postId', { unique: false });
  }
}

export function createDerivedStore(idb = globalThis.indexedDB) {
  let opening = null;
  function open() {
    opening ||= new Promise((resolve, reject) => {
      const request = idb.open(DERIVED_DB, DERIVED_VERSION);
      request.onupgradeneeded = () => upgradeDerived(request.result, request.transaction);
      request.onsuccess = () => {
        const database = request.result;
        // Let other pages (older Atlas tabs) upgrade the schema without deadlocking.
        database.onversionchange = () => {
          database.close();
          opening = null;
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('Derived data is open in an older XVault tab. Reload it and retry.'));
    }).catch(error => {
      opening = null;
      throw error;
    });
    return opening;
  }
  const done = transaction =>
    new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error || Error('Derived store failed'));
    });
  async function getMany(name, keys) {
    const found = new Map();
    if (!keys.length) return found;
    const database = await open(),
      transaction = database.transaction(name, 'readonly'),
      objects = transaction.objectStore(name);
    for (const key of keys) {
      const request = objects.get(key);
      request.onsuccess = () => request.result && found.set(key, request.result);
    }
    await done(transaction);
    return found;
  }
  async function putMany(name, rows) {
    if (!rows.length) return;
    const database = await open(),
      transaction = database.transaction(name, 'readwrite'),
      objects = transaction.objectStore(name);
    rows.forEach(row => objects.put(row));
    await done(transaction);
  }
  async function getAll(name) {
    const database = await open(),
      transaction = database.transaction(name, 'readonly'),
      request = transaction.objectStore(name).getAll();
    await done(transaction);
    return request.result || [];
  }
  async function count(name) {
    const database = await open(),
      transaction = database.transaction(name, 'readonly'),
      request = transaction.objectStore(name).count();
    await done(transaction);
    return Number(request.result || 0);
  }
  async function clear(name) {
    const database = await open(),
      transaction = database.transaction([name, 'meta'], 'readwrite');
    transaction.objectStore(name).clear();
    transaction.objectStore('meta').put({ key: `${name}:revision`, value: Date.now() });
    await done(transaction);
  }
  async function revision(name) {
    const row = (await getMany('meta', [`${name}:revision`])).get(`${name}:revision`);
    return Number(row?.value || 0);
  }
  async function bump(name) {
    const value = Date.now();
    await putMany('meta', [{ key: `${name}:revision`, value }]);
    return value;
  }
  return { open, getMany, putMany, getAll, count, clear, revision, bump };
}
