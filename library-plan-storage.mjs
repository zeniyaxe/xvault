import { MAX_LIBRARY_RANKS } from './library-ranked-query.mjs';

const STORE = 'libraryPlans';
let lastWriteAt = 0;

function validatePlanId(value) {
  const id = String(value || '');
  if (!id || id.length > 128) throw new TypeError('Invalid Library query-plan ID.');
  return id;
}

function transactionResult(transaction, errorMessage) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error(`${errorMessage} transaction aborted.`));
    transaction.onerror = () => reject(transaction.error || new Error(`${errorMessage} transaction failed.`));
  });
}

export function readStoredLibraryPlan(database, planId) {
  const id = validatePlanId(planId);
  if (!database.objectStoreNames.contains(STORE)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readonly'), request = tx.objectStore(STORE).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Library query-plan read failed.'));
    tx.onabort = () => reject(tx.error || new Error('Library query-plan read aborted.'));
  });
}

export function deleteStoredLibraryPlan(database, planId) {
  const id = validatePlanId(planId);
  if (!database.objectStoreNames.contains(STORE)) return Promise.resolve();
  const tx = database.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  return transactionResult(tx, 'Library query-plan deletion');
}

// Query plans are disposable performance data. Keep only the three most
// recently written compact plans; cursor eviction never reads their large
// values into memory and never touches archive or recovery evidence.
export function writeStoredLibraryPlan(database, planId, identityKey, plan, maxPlans = 3) {
  const id = validatePlanId(planId), identity = String(identityKey || '');
  if (identity.length > 4096 || !plan || !Array.isArray(plan.ranks) || plan.ranks.length > MAX_LIBRARY_RANKS) {
    return Promise.reject(new RangeError('The Library query plan exceeds its safe persistent-cache bounds.'));
  }
  if (!database.objectStoreNames.contains(STORE)) return Promise.reject(new Error('Library query-plan storage is unavailable.'));
  const capacity = Math.max(1, Math.min(3, Math.floor(Number(maxPlans) || 3)));
  const tx = database.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE), index = store.index('updatedAt');
  const row = { id, identityKey: identity, plan, updatedAt: 0 };
  const existing = store.getKey(id);
  const newest = index.openKeyCursor(null, 'prev');
  let currentKey = null, newestAt = 0, ready = 0;
  const beginWrite = () => {
    if (++ready < 2) return;
    row.updatedAt = lastWriteAt = Math.max(Date.now(), lastWriteAt + 1, newestAt + 1);
    if (currentKey != null) { store.put(row); return; }
    let seen = 0, oldestId = null;
    const request = index.openKeyCursor(null, 'next');
    request.onerror = () => { try { tx.abort(); } catch {} };
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) { store.put(row); return; }
      if (oldestId == null) oldestId = cursor.primaryKey;
      if (++seen >= capacity) {
        store.delete(oldestId);
        store.put(row);
        return;
      }
      cursor.continue();
    };
  };
  existing.onsuccess = () => { currentKey = existing.result ?? null; beginWrite(); };
  existing.onerror = () => { try { tx.abort(); } catch {} };
  newest.onsuccess = () => { newestAt = Number(newest.result?.key || 0); beginWrite(); };
  newest.onerror = () => { try { tx.abort(); } catch {} };
  return transactionResult(tx, 'Library query-plan write');
}
