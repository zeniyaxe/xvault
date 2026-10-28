import './media-asset.js';
import './media-metadata.js';
import { RECOVERY_STORES } from './archive-recovery.mjs';
import { readSharedFiles, remapSharedFile, collectSharedPostIds } from './media-associations.mjs';

const mediaArchive = globalThis.XVaultMediaMetadata;
export const DOWNLOAD_ASSET_INDEX_CHECKPOINT = 'download-asset-index-v1';
export const DOWNLOAD_STATE_COUNTER_VERSION = 1;
const DOWNLOAD_ASSET_STATES = new Set([
  'complete',
  'queued',
  'downloading',
  'retry-wait',
  'paused',
  'verifying',
  'converting',
]);
const DOWNLOAD_COUNT_STATES = [
  'queued',
  'retry-wait',
  'downloading',
  'paused',
  'verifying',
  'converting',
  'complete',
  'failed',
  'cancelled',
];
const DOWNLOAD_COUNT_STATE_SET = new Set(DOWNLOAD_COUNT_STATES);

export function emptyDownloadStateCounts() {
  return Object.fromEntries(DOWNLOAD_COUNT_STATES.map(state => [state, 0]));
}

function rowCountDelta(counts, state, amount) {
  const key = String(state || '');
  if (DOWNLOAD_COUNT_STATE_SET.has(key)) counts[key] = Math.max(0, (Number(counts[key]) || 0) + amount);
}

// Keep exact queue totals beside the asset lookup checkpoint. Mutations and
// their state deltas commit together; old rows receive a version marker during
// the bounded checkpoint scan so concurrent edits cannot be counted twice.
function createDownloadStateCounter(transaction) {
  if (!transaction.db.objectStoreNames.contains('checkpoints')) {
    return {
      replace: (_previous, next) => withDownloadAssetLookup(next),
      insert: next => withDownloadAssetLookup(next),
      preserveHistory: (_previous, history, next) => [withDownloadAssetLookup(history), withDownloadAssetLookup(next)],
      remove() {},
      finish() {},
    };
  }
  const checkpoints = transaction.objectStore('checkpoints');
  let checkpoint = null,
    ready = false,
    finished = false,
    saved = false;
  const deltas = Object.create(null);
  const change = (row, amount) => {
    const state = String(row?.state || '');
    if (DOWNLOAD_COUNT_STATE_SET.has(state)) deltas[state] = (deltas[state] || 0) + amount;
  };
  const prepare = row => withDownloadAssetLookup({ ...row, countedStateVersion: DOWNLOAD_STATE_COUNTER_VERSION });
  const flush = () => {
    if (!ready || !finished || saved) return;
    const changes = Object.entries(deltas).filter(([, amount]) => amount !== 0);
    if (!changes.length) return;
    saved = true;
    checkpoint ||= {
      key: DOWNLOAD_ASSET_INDEX_CHECKPOINT,
      complete: false,
      countsComplete: false,
      afterKey: null,
      processed: 0,
    };
    const counts = { ...emptyDownloadStateCounts(), ...(checkpoint.stateCounts || {}) };
    for (const [state, amount] of changes) counts[state] = Math.max(0, (Number(counts[state]) || 0) + amount);
    checkpoint.stateCounts = counts;
    checkpoint.stateCounterVersion = DOWNLOAD_STATE_COUNTER_VERSION;
    checkpoint.updatedAt = Date.now();
    checkpoints.put(checkpoint);
  };
  const request = checkpoints.get(DOWNLOAD_ASSET_INDEX_CHECKPOINT);
  request.onsuccess = () => {
    checkpoint = request.result || null;
    ready = true;
    flush();
  };
  request.onerror = () => {
    try {
      transaction.abort();
    } catch {}
  };
  return {
    replace(previous, next) {
      if (previous?.countedStateVersion === DOWNLOAD_STATE_COUNTER_VERSION) change(previous, -1);
      const stored = prepare(next);
      change(stored, 1);
      return stored;
    },
    insert(next) {
      const stored = prepare(next);
      change(stored, 1);
      return stored;
    },
    preserveHistory(previous, history, next) {
      const retained = prepare(history);
      if (previous?.countedStateVersion !== DOWNLOAD_STATE_COUNTER_VERSION) change(retained, 1);
      const replacement = this.insert(next);
      return [retained, replacement];
    },
    remove(previous) {
      if (previous?.countedStateVersion === DOWNLOAD_STATE_COUNTER_VERSION) change(previous, -1);
    },
    finish() {
      finished = true;
      flush();
    },
  };
}

// Keep the indexed lookup key in the same write as the queue state. The index
// is sparse for failed/cancelled rows, so a duplicate query sees only a
// completed or potentially active physical source.
export function withDownloadAssetLookup(row) {
  if (!row || typeof row !== 'object') return row;
  const assetKey = row.item?.url ? globalThis.XVaultMediaAsset.assetIdentity(row.item.url).asset : '';
  if (assetKey) row.assetKey = assetKey;
  else delete row.assetKey;
  if (assetKey && DOWNLOAD_ASSET_STATES.has(String(row.state || ''))) row.usableAssetKey = assetKey;
  else delete row.usableAssetKey;
  return row;
}

// A prepared retry may become stale while a browser event commits a new state.
// Admission reads and reserves the canonical key in the same write transaction.
export function reserveLibraryDownload(database, row) {
  return new Promise((resolve, reject) => {
    const names = database.objectStoreNames.contains('checkpoints') ? ['downloads', 'checkpoints'] : ['downloads'],
      tx = database.transaction(names, 'readwrite'),
      store = tx.objectStore('downloads'),
      counter = createDownloadStateCounter(tx);
    let result = { queued: false };
    const request = store.get(row.key);
    request.onsuccess = () => {
      const current = request.result;
      if (current && DOWNLOAD_ASSET_STATES.has(current.state)) {
        result = { queued: false, state: current.state };
        counter.finish();
        return;
      }
      store.put(counter.replace(current, row));
      result = { queued: true };
      counter.finish();
    };
    request.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || Error('Download reservation aborted'));
    tx.onerror = () => reject(tx.error || Error('Download reservation failed'));
  });
}

// Read one bounded page without materializing the entire tweet store.
const LIBRARY_REVISION_KEY = 'library-query-revision';
const LIBRARY_DOWNLOAD_REVISION_KEY = 'library-download-query-revision';

function bumpLibraryRevision(transaction) {
  if (!transaction.db.objectStoreNames.contains('checkpoints')) return null;
  const checkpoints = transaction.objectStore('checkpoints');
  const request = checkpoints.get(LIBRARY_REVISION_KEY);
  let revision = 0;
  request.onsuccess = () => {
    revision = Number(request.result?.revision || 0) + 1;
    checkpoints.put({ key: LIBRARY_REVISION_KEY, revision, updatedAt: Date.now() });
  };
  return request;
}

export function readLibraryRevision(database) {
  if (!database.objectStoreNames.contains('checkpoints')) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    const tx = database.transaction('checkpoints', 'readonly');
    const request = tx.objectStore('checkpoints').get(LIBRARY_REVISION_KEY);
    request.onsuccess = () => resolve(Number(request.result?.revision || 0));
    request.onerror = () => reject(request.error || new Error('Library revision read failed'));
    tx.onabort = () => reject(tx.error || new Error('Library revision read aborted'));
  });
}

function bumpLibraryDownloadRevision(transaction) {
  if (!transaction.db.objectStoreNames.contains('checkpoints')) return null;
  const checkpoints = transaction.objectStore('checkpoints');
  const request = checkpoints.get(LIBRARY_DOWNLOAD_REVISION_KEY);
  request.onsuccess = () =>
    checkpoints.put({
      key: LIBRARY_DOWNLOAD_REVISION_KEY,
      revision: Number(request.result?.revision || 0) + 1,
      updatedAt: Date.now(),
    });
  return request;
}

function downloadQuerySignature(row) {
  if (!row || row.state !== 'complete') return '';
  const verification = row.verification?.state || row.verificationState || '';
  return JSON.stringify([
    String(row.item?.tweetId || ''),
    String(row.item?.mediaId || ''),
    String(row.item?.url || ''),
    Math.max(0, Number(row.totalBytes) || 0),
    !['mismatch', 'corrupt', 'missing'].includes(verification),
  ]);
}

// Download rows are written with their query-generation bump in the same
// transaction. Progress-only updates do not invalidate Library cursors.
export function writeLibraryDownloads(database, rows = []) {
  const finalRows = new Map();
  for (const row of rows) if (row?.key != null) finalRows.set(String(row.key), row);
  if (!finalRows.size) return Promise.resolve({ written: 0, changedIds: [], truncated: false, revision: 0 });
  return new Promise((resolve, reject) => {
    const names = database.objectStoreNames.contains('checkpoints') ? ['downloads', 'checkpoints'] : ['downloads'];
    if (database.objectStoreNames.contains('mediaAssociations')) names.push('mediaAssociations');
    const tx = database.transaction(names, 'readwrite'),
      store = tx.objectStore('downloads'),
      changedIds = new Set(),
      counter = createDownloadStateCounter(tx);
    let written = 0,
      bumped = false,
      revision = 0,
      pending = finalRows.size;
    tx.oncomplete = () =>
      resolve({ written, changedIds: [...changedIds], truncated: !!changedIds.truncated, revision });
    tx.onabort = () => reject(tx.error || new Error('Download update aborted'));
    tx.onerror = () => reject(tx.error || new Error('Download update failed'));
    if (names.includes('checkpoints')) {
      const currentRevision = tx.objectStore('checkpoints').get(LIBRARY_DOWNLOAD_REVISION_KEY);
      currentRevision.onsuccess = () => {
        revision = Number(currentRevision.result?.revision || 0);
      };
    }
    for (const [key, row] of finalRows) {
      const request = store.get(key);
      request.onsuccess = () => {
        const previous = request.result;
        if (downloadQuerySignature(previous) !== downloadQuerySignature(row)) {
          collectSharedPostIds(tx, key, changedIds);
          const id = row.item?.tweetId || previous?.item?.tweetId;
          if (id != null && String(id)) changedIds.add(String(id));
          if (!bumped) {
            bumped = true;
            const revisionRequest = bumpLibraryDownloadRevision(tx);
            if (revisionRequest) {
              const onSuccess = revisionRequest.onsuccess;
              revisionRequest.onsuccess = event => {
                onSuccess?.call(revisionRequest, event);
                revision = Number(revisionRequest.result?.revision || 0) + 1;
              };
            } else revision++;
          }
        }
        store.put(
          counter.replace(
            previous,
            !row.sourceGeneration && previous?.sourceGeneration
              ? { ...row, sourceGeneration: previous.sourceGeneration }
              : row
          )
        );
        written++;
        if (--pending === 0) counter.finish();
      };
      request.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
    }
  });
}

// Retain the latest completed evidence and install its replacement in one transaction.
// Target preparation can take time; never archive a stale conversion/verification snapshot.
export function replaceCompletedDownloadWithHistory(database, row, options = {}) {
  return new Promise((resolve, reject) => {
    const names = database.objectStoreNames.contains('checkpoints') ? ['downloads', 'checkpoints'] : ['downloads'];
    if (database.objectStoreNames.contains('mediaAssociations')) names.push('mediaAssociations');
    const tx = database.transaction(names, 'readwrite'),
      store = tx.objectStore('downloads'),
      counter = createDownloadStateCounter(tx);
    let result = { queued: false, changedIds: [] },
      counterFinished = false;
    const finishCounter = () => {
      if (counterFinished) return;
      counterFinished = true;
      counter.finish();
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Download replacement failed'));
    tx.onabort = () => reject(tx.error || new Error('Download replacement aborted'));
    const request = store.get(row.key);
    request.onsuccess = () => {
      const current = request.result;
      if (
        current?.state !== 'complete' ||
        ('expectedDownloadId' in options && (current.downloadId ?? null) !== (options.expectedDownloadId ?? null))
      ) {
        finishCounter();
        return;
      }
      try {
        const historyKey = `${row.key}|copy:${crypto.randomUUID()}`;
        const [historyRow, replacementRow] = counter.preserveHistory(
          current,
          {
            ...current,
            key: historyKey,
            supersededAt: Date.now(),
            supersededReason: options.reason || 'explicit-redownload',
          },
          row
        );
        store.put(historyRow);
        remapSharedFile(tx, current.key, historyKey);
        store.put(replacementRow);
        bumpLibraryDownloadRevision(tx);
        finishCounter();
        result = { queued: true, historyKey, changedIds: current.item?.tweetId ? [String(current.item.tweetId)] : [] };
      } catch (error) {
        try {
          tx.abort();
        } catch {}
        reject(error);
      }
    };
    request.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
  });
}

export function deleteLibraryDownloads(database, keys = []) {
  const wanted = [...new Set(keys.map(String))];
  return new Promise((resolve, reject) => {
    const names = database.objectStoreNames.contains('checkpoints') ? ['downloads', 'checkpoints'] : ['downloads'];
    if (!wanted.length) return resolve({ deleted: 0, changedIds: [], revision: 0 });
    const tx = database.transaction(names, 'readwrite'),
      store = tx.objectStore('downloads'),
      changedIds = new Set(),
      counter = createDownloadStateCounter(tx);
    let deleted = 0,
      bumped = false,
      revision = 0,
      pending = wanted.length;
    tx.oncomplete = () => resolve({ deleted, changedIds: [...changedIds], revision });
    tx.onabort = () => reject(tx.error || new Error('Download deletion aborted'));
    tx.onerror = () => reject(tx.error || new Error('Download deletion failed'));
    if (names.includes('checkpoints')) {
      const currentRevision = tx.objectStore('checkpoints').get(LIBRARY_DOWNLOAD_REVISION_KEY);
      currentRevision.onsuccess = () => {
        revision = Number(currentRevision.result?.revision || 0);
      };
    }
    const finishOne = () => {
      if (--pending === 0) counter.finish();
    };
    for (const key of wanted) {
      const request = store.get(key);
      request.onsuccess = () => {
        const row = request.result;
        if (!row) {
          finishOne();
          return;
        }
        if (downloadQuerySignature(row)) {
          if (row.item?.tweetId != null) changedIds.add(String(row.item.tweetId));
          if (!bumped) {
            bumped = true;
            const revisionRequest = bumpLibraryDownloadRevision(tx);
            if (revisionRequest) {
              const onSuccess = revisionRequest.onsuccess;
              revisionRequest.onsuccess = event => {
                onSuccess?.call(revisionRequest, event);
                revision = Number(revisionRequest.result?.revision || 0) + 1;
              };
            } else revision++;
          }
        }
        counter.remove(row);
        store.delete(key);
        deleted++;
        finishOne();
      };
      request.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
    }
  });
}

// Delete matching queue/history rows through the state index. Values are
// visited one at a time so clearing a large queue never clones the downloads
// store into background-worker memory. All matching deletes and the single
// completed-file query-revision bump commit atomically.
export function deleteLibraryDownloadsByState(database, states = [], { onDelete } = {}) {
  const wanted = [...new Set(states.map(state => String(state)))];
  if (!wanted.length)
    return Promise.resolve({
      deleted: 0,
      changedIds: [],
      truncatedIds: false,
      revision: 0,
      recordsScanned: 0,
      cursorOperations: 0,
    });
  if (!database.objectStoreNames.contains('downloads'))
    return Promise.reject(new Error('The downloads store is unavailable'));
  return new Promise((resolve, reject) => {
    const hasCheckpoints = database.objectStoreNames.contains('checkpoints');
    const tx = database.transaction(hasCheckpoints ? ['downloads', 'checkpoints'] : ['downloads'], 'readwrite');
    const store = tx.objectStore('downloads');
    if (!store.indexNames.contains('state')) {
      try {
        tx.abort();
      } catch {}
      reject(new Error('The downloads state index is unavailable; reopen XVault to finish the storage upgrade'));
      return;
    }
    const changedIds = new Set(),
      counter = createDownloadStateCounter(tx);
    let deleted = 0,
      recordsScanned = 0,
      cursorOperations = 0,
      truncatedIds = false,
      revision = 0,
      bumped = false,
      statePosition = 0;
    tx.oncomplete = () =>
      resolve({ deleted, changedIds: [...changedIds], truncatedIds, revision, recordsScanned, cursorOperations });
    tx.onabort = () => reject(tx.error || new Error('Download-state cleanup aborted'));
    tx.onerror = () => reject(tx.error || new Error('Download-state cleanup failed'));
    if (hasCheckpoints) {
      const currentRevision = tx.objectStore('checkpoints').get(LIBRARY_DOWNLOAD_REVISION_KEY);
      currentRevision.onsuccess = () => {
        revision = Number(currentRevision.result?.revision || 0);
      };
      currentRevision.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
    }

    const bumpOnce = () => {
      if (bumped) return;
      bumped = true;
      const revisionRequest = bumpLibraryDownloadRevision(tx);
      if (!revisionRequest) {
        revision++;
        return;
      }
      const onSuccess = revisionRequest.onsuccess;
      revisionRequest.onsuccess = event => {
        onSuccess?.call(revisionRequest, event);
        revision = Number(revisionRequest.result?.revision || 0) + 1;
      };
    };
    const noteChangedId = value => {
      if (value == null || String(value) === '') return;
      const id = String(value);
      if (changedIds.has(id)) return;
      if (changedIds.size < 1000) changedIds.add(id);
      else truncatedIds = true;
    };
    // The last state cursor seals the accumulated deltas before the
    // transaction can become inactive.
    const scanStates = () => {
      if (statePosition >= wanted.length) {
        counter.finish();
        return;
      }
      const state = wanted[statePosition++];
      const request = store.index('state').openCursor(IDBKeyRange.only(state));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          scanStates();
          return;
        }
        cursorOperations++;
        recordsScanned++;
        const row = cursor.value;
        try {
          onDelete?.(row);
        } catch {}
        noteChangedId(row?.item?.tweetId);
        if (downloadQuerySignature(row)) bumpOnce();
        counter.remove(row);
        cursor.delete();
        deleted++;
        cursor.continue();
      };
      request.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
    };
    scanStates();
  });
}

// Final download cleanup must check and delete the same current row in one
// transaction. A conversion scheduler that commits first is therefore visible
// to this check, while concurrent finalizers serialize and only one can delete.
export function deleteCompletedDownloadIfEligible(database, key) {
  const primaryKey = String(key);
  return new Promise((resolve, reject) => {
    const hasCheckpoints = database.objectStoreNames.contains('checkpoints');
    const tx = database.transaction(hasCheckpoints ? ['downloads', 'checkpoints'] : ['downloads'], 'readwrite');
    const downloads = tx.objectStore('downloads');
    const counter = createDownloadStateCounter(tx);
    let deleted = false,
      reason = null,
      revision = 0,
      changedId = null;
    tx.oncomplete = () => resolve({ deleted, reason, changedIds: changedId ? [changedId] : [], revision });
    tx.onabort = () => reject(tx.error || new Error('Verified-download cleanup aborted'));
    tx.onerror = () => reject(tx.error || new Error('Verified-download cleanup failed'));
    if (hasCheckpoints) {
      const currentRevision = tx.objectStore('checkpoints').get(LIBRARY_DOWNLOAD_REVISION_KEY);
      currentRevision.onsuccess = () => {
        revision = Number(currentRevision.result?.revision || 0);
      };
      currentRevision.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
    }
    const request = downloads.get(primaryKey);
    request.onsuccess = () => {
      const row = request.result;
      if (!row) {
        reason = 'missing';
        counter.finish();
        return;
      }
      if (row.state !== 'complete') {
        reason = 'state-changed';
        counter.finish();
        return;
      }
      if (row.conversionExpected) {
        reason = 'conversion-pending';
        counter.finish();
        return;
      }
      const verification = row.verification?.state || row.verificationState || '';
      if (!['verified', 'verified-with-warning'].includes(verification)) {
        reason = 'not-verified';
        counter.finish();
        return;
      }
      const signature = downloadQuerySignature(row);
      if (signature) {
        changedId = row.item?.tweetId == null ? null : String(row.item.tweetId);
        const revisionRequest = bumpLibraryDownloadRevision(tx);
        if (revisionRequest) {
          const onSuccess = revisionRequest.onsuccess;
          revisionRequest.onsuccess = event => {
            onSuccess?.call(revisionRequest, event);
            revision = Number(revisionRequest.result?.revision || 0) + 1;
          };
        } else revision++;
      }
      downloads.delete(primaryKey);
      counter.remove(row);
      counter.finish();
      deleted = true;
      reason = 'deleted';
    };
    request.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
  });
}

export function readLibraryDownloadRevision(database) {
  if (!database.objectStoreNames.contains('checkpoints')) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    const tx = database.transaction('checkpoints', 'readonly');
    const request = tx.objectStore('checkpoints').get(LIBRARY_DOWNLOAD_REVISION_KEY);
    request.onsuccess = () => resolve(Number(request.result?.revision || 0));
    request.onerror = () => reject(request.error || new Error('Download query revision read failed'));
    tx.onabort = () => reject(tx.error || new Error('Download query revision read aborted'));
  });
}

// Keep the archive's query generation monotonic while clearing its related
// stores atomically. Readers cannot observe a half-cleared archive, and old
// cursors cannot accidentally become valid again after a clear.
export function clearLibraryData(
  database,
  stores = [
    'tweets',
    'users',
    'captures',
    'jobs',
    'revisions',
    'archiveRuns',
    'snapshots',
    'integrity',
    'manifests',
    'libraryPlans',
  ]
) {
  const names = [...new Set(stores.filter(name => database.objectStoreNames.contains(name)))];
  const clearsDownloads = names.includes('downloads');
  if (database.objectStoreNames.contains('checkpoints')) names.push('checkpoints');
  return new Promise((resolve, reject) => {
    const tx = database.transaction([...new Set(names)], 'readwrite');
    let result = { ok: true, revision: 0 };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('Library clear aborted; no partial clear was applied'));
    tx.onerror = () => reject(tx.error || new Error('Library clear failed'));
    for (const name of new Set(names)) if (name !== 'checkpoints') tx.objectStore(name).clear();
    if (!database.objectStoreNames.contains('checkpoints')) return;
    const checkpoints = tx.objectStore('checkpoints');
    const cursor = checkpoints.openCursor();
    cursor.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return;
      if (
        item.primaryKey !== DOWNLOAD_ASSET_INDEX_CHECKPOINT &&
        item.primaryKey !== LIBRARY_REVISION_KEY &&
        item.primaryKey !== LIBRARY_DOWNLOAD_REVISION_KEY
      )
        item.delete();
      item.continue();
    };
    const request = bumpLibraryRevision(tx);
    if (request) {
      const updateRevision = request.onsuccess;
      request.onsuccess = event => {
        updateRevision?.call(request, event);
        result = { ok: true, revision: Number(request.result?.revision || 0) + 1 };
      };
    }
    if (clearsDownloads) {
      checkpoints.put({
        key: DOWNLOAD_ASSET_INDEX_CHECKPOINT,
        complete: true,
        countsComplete: true,
        afterKey: null,
        processed: 0,
        stateCounts: emptyDownloadStateCounts(),
        stateCounterVersion: DOWNLOAD_STATE_COUNTER_VERSION,
        updatedAt: Date.now(),
      });
      const downloadRequest = bumpLibraryDownloadRevision(tx);
      if (downloadRequest) {
        const onSuccess = downloadRequest.onsuccess;
        downloadRequest.onsuccess = event => onSuccess?.call(downloadRequest, event);
      }
    }
  });
}

// Read a revision-bound page from the archive timestamp index. The cursor token
// carries both index and primary keys, so equal timestamps never duplicate or
// skip a post. Legacy rows without a usable archive timestamp follow the index.
export function readLibraryQueryPage(database, options = {}) {
  const limit = Math.max(1, Math.min(1500, Math.floor(Number(options.limit) || 120)));
  const scanLimit = Math.max(limit, Math.min(10000, Math.floor(Number(options.scanLimit) || 2500)));
  const sort = options.sort === 'old' ? 'old' : 'new';
  const direction = sort === 'new' ? 'prev' : 'next';
  const after = options.after || null;
  if (after && (after.sort !== sort || !['indexed', 'legacy'].includes(after.phase))) {
    return Promise.reject(new Error('Library cursor does not belong to this sort. Restart the query.'));
  }
  return new Promise((resolve, reject) => {
    const names = ['tweets', 'checkpoints'];
    if (options.downloads && database.objectStoreNames.contains('downloads')) names.push('downloads');
    const tx = database.transaction(names, 'readonly');
    const tweets = tx.objectStore('tweets'),
      rows = [];
    let revision = 0,
      downloadRevision = 0,
      scanned = 0,
      cursorOperations = 0,
      downloadRowsRead = 0,
      downloadCursorOperations = 0,
      downloadLookupMs = 0,
      nextKey = after,
      done = false,
      stale = false,
      cancelled = false,
      error = null;
    const revisionRequest = tx.objectStore('checkpoints').get(LIBRARY_REVISION_KEY);
    const downloadRevisionRequest = options.downloads
      ? tx.objectStore('checkpoints').get(LIBRARY_DOWNLOAD_REVISION_KEY)
      : null;
    revisionRequest.onsuccess = () => {
      revision = Number(revisionRequest.result?.revision || 0);
    };
    const finish = () => {
      done = true;
    };
    const stopWhenCancelled = () => {
      if (typeof options.cancelled !== 'function' || !options.cancelled()) return false;
      cancelled = true;
      try {
        tx.abort();
      } catch {}
      return true;
    };
    const isAfterBoundary = (key, primaryKey, boundary) => {
      if (!boundary) return true;
      const keyOrder = indexedDB.cmp(key, boundary.key);
      const pairOrder = keyOrder || indexedDB.cmp(primaryKey, boundary.id);
      return direction === 'prev' ? pairOrder < 0 : pairOrder > 0;
    };
    const includeRecord = (cursor, phase, downloadSummary = null) => {
      if (rows.length >= limit || scanned >= scanLimit) return;
      scanned++;
      nextKey = {
        key: phase === 'indexed' ? cursor.key : cursor.primaryKey,
        id: cursor.primaryKey,
        phase,
        sort,
        revision,
        ...(options.downloads ? { downloadRevision } : {}),
      };
      let include = true;
      try {
        if (typeof options.match === 'function') include = !!options.match(cursor.value, downloadSummary);
      } catch (matchError) {
        error = matchError;
        tx.abort();
        reject(matchError);
        return;
      }
      if (include) rows.push(cursor.value);
      if (rows.length >= limit || scanned >= scanLimit) return;
      cursor.continue();
    };
    const getDownloadSummary = (post, callback) => {
      const downloads = tx.objectStore('downloads');
      if (!downloads.indexNames.contains('tweetId')) {
        error = new Error('Download lookup index is unavailable');
        tx.abort();
        reject(error);
        return;
      }
      const media = Array.isArray(post.media) ? post.media : [];
      if (media.length > 500) {
        error = new Error(
          'This post has too many media entries to safely evaluate download filters. Narrow the search or inspect it directly.'
        );
        tx.abort();
        reject(error);
        return;
      }
      const summary = { completeCount: 0, bytes: 0, matchedMedia: new Set(), truncated: false };
      let visited = 0;
      const request = downloads.index('tweetId').openCursor(IDBKeyRange.only(String(post.id)));
      request.onerror = () => {
        error = request.error || new Error('Download query failed');
        reject(error);
      };
      request.onsuccess = () => {
        downloadCursorOperations++;
        if (stopWhenCancelled()) return;
        const cursor = request.result;
        if (!cursor) {
          summary.missing = media.length > 0 && summary.matchedMedia.size < media.length;
          summary.downloaded = summary.completeCount > 0;
          callback(summary);
          return;
        }
        if (++visited > 5000) {
          error = new RangeError(
            'A post has more than 5,000 download-history rows. The filter stopped safely instead of returning an incomplete match.'
          );
          tx.abort();
          reject(error);
          return;
        }
        downloadRowsRead++;
        const row = cursor.value;
        if (row.state === 'complete') {
          summary.bytes += Math.max(0, Number(row.totalBytes) || 0);
          if (!['mismatch', 'corrupt', 'missing'].includes(row.verification?.state || row.verificationState)) {
            summary.completeCount++;
            for (let index = 0; index < media.length; index++) {
              const item = media[index],
                itemId = String(item.id || ''),
                mediaId = String(row.item?.mediaId || '');
              const urls = [item.url, item.playbackUrl, ...(item.variants || []).map(variant => variant.url)].filter(
                Boolean
              );
              if (
                (itemId && mediaId && itemId === mediaId) ||
                urls.some(url => url === row.item?.url || globalThis.XVaultMediaAsset.sameAsset(url, row.item?.url))
              )
                summary.matchedMedia.add(index);
            }
          }
        }
        cursor.continue();
      };
    };
    const consume = (cursor, phase) => {
      if (!cursor) {
        if (phase === 'indexed') return openPhase('legacy', null);
        return finish();
      }
      if (scanned >= scanLimit || rows.length >= limit) return;
      if (phase === 'legacy' && cursor.value?.archivedAt != null && Number(cursor.value.archivedAt) > 0) {
        cursor.continue();
        return;
      }
      if (phase === 'indexed' && !(Number(cursor.key) > 0)) {
        cursor.continue();
        return;
      }
      if (options.downloads) {
        const lookupStarted = performance.now();
        getDownloadSummary(cursor.value, summary => {
          downloadLookupMs += performance.now() - lookupStarted;
          includeRecord(cursor, phase, summary);
        });
        return;
      }
      includeRecord(cursor, phase);
    };
    const openPhase = (phase, phaseBoundary) => {
      const source =
        phase === 'indexed' && tweets.indexNames.contains('archivedAt') ? tweets.index('archivedAt') : tweets;
      const useIndex = phase === 'indexed' && source !== tweets;
      const primaryBoundary =
        phase === 'legacy' && phaseBoundary ? IDBKeyRange.lowerBound(phaseBoundary.id, true) : null;
      const request = source.openCursor(primaryBoundary, useIndex ? direction : 'next');
      let boundaryPending = !!phaseBoundary;
      request.onerror = () => reject(request.error || new Error('Library query cursor failed'));
      request.onsuccess = () => {
        cursorOperations++;
        if (stopWhenCancelled()) return;
        const cursor = request.result;
        if (!cursor) return consume(null, phase);
        if (boundaryPending) {
          boundaryPending = false;
          // Request a composite-key seek when the saved item still exists; the
          // local pair check below also covers deletion of the boundary item.
          if (useIndex && typeof cursor.continuePrimaryKey === 'function') {
            try {
              cursor.continuePrimaryKey(phaseBoundary.key, phaseBoundary.id);
              return;
            } catch {}
          }
          // Legacy rows use the object-store primary key as their cursor. The
          // lowerBound above seeks directly past a possibly deleted boundary;
          // do not rescan every older legacy key on each page.
        }
        if (useIndex && phaseBoundary && !isAfterBoundary(cursor.key, cursor.primaryKey, phaseBoundary)) {
          cursor.continue();
          return;
        }
        consume(cursor, phase);
      };
    };
    const phase = after?.phase || 'indexed';
    const boundary =
      after &&
      after.revision === options.expectedRevision &&
      (!options.downloads || after.downloadRevision === options.expectedDownloadRevision)
        ? after
        : null;
    let revisionReady = false,
      downloadRevisionReady = !options.downloads,
      queryStarted = false;
    const beginQuery = () => {
      if (queryStarted || !revisionReady || !downloadRevisionReady || stopWhenCancelled()) return;
      if (options.expectedRevision != null && revision !== Number(options.expectedRevision)) {
        stale = true;
        return;
      }
      if (
        options.downloads &&
        options.expectedDownloadRevision != null &&
        downloadRevision !== Number(options.expectedDownloadRevision)
      ) {
        stale = true;
        return;
      }
      queryStarted = true;
      openPhase(phase, boundary);
    };
    revisionRequest.onsuccess = () => {
      revision = Number(revisionRequest.result?.revision || 0);
      revisionReady = true;
      beginQuery();
    };
    if (downloadRevisionRequest)
      downloadRevisionRequest.onsuccess = () => {
        downloadRevision = Number(downloadRevisionRequest.result?.revision || 0);
        downloadRevisionReady = true;
        beginQuery();
      };
    tx.oncomplete = () => {
      if (error) return;
      let bytesEstimate = 0;
      try {
        bytesEstimate = rows.length ? JSON.stringify(rows).length * 2 : 0;
      } catch {}
      resolve({
        rows: cancelled ? [] : rows,
        revision,
        ...(options.downloads ? { downloadRevision } : {}),
        totalRecords: null,
        scanned,
        recordsRead: scanned,
        materialized: scanned,
        returned: cancelled ? 0 : rows.length,
        cursorOperations,
        downloadRowsRead,
        downloadCursorOperations,
        downloadLookupMs,
        bytesEstimate: cancelled ? 0 : bytesEstimate,
        index: phase === 'indexed' ? 'archivedAt' : 'primaryKey',
        nextKey: cancelled ? after : nextKey,
        done: done && !stale,
        hasMore: !done && !stale,
        stale,
        cancelled,
      });
    };
    tx.onerror = () => reject(tx.error || new Error('Library query failed'));
    tx.onabort = () =>
      cancelled
        ? resolve({
            rows: [],
            revision,
            ...(options.downloads ? { downloadRevision } : {}),
            totalRecords: null,
            scanned,
            recordsRead: scanned,
            materialized: scanned,
            returned: 0,
            cursorOperations,
            downloadRowsRead,
            downloadCursorOperations,
            downloadLookupMs,
            bytesEstimate: 0,
            index: phase === 'indexed' ? 'archivedAt' : 'primaryKey',
            nextKey: after,
            done: false,
            hasMore: true,
            stale: false,
            cancelled: true,
          })
        : reject(error || tx.error || new Error('Library query aborted'));
  });
}

export function readLibraryPage(database, afterKey, requestedLimit = 500) {
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(requestedLimit) || 500)));
  return new Promise((resolve, reject) => {
    const tx = database.transaction('tweets', 'readonly');
    const range = afterKey === undefined || afterKey === null ? null : IDBKeyRange.lowerBound(afterKey, true);
    const request = tx.objectStore('tweets').openCursor(range);
    const rows = [];
    let nextKey = afterKey ?? null,
      cursorOperations = 0;
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error || new Error('Library read aborted'));
    request.onsuccess = () => {
      cursorOperations++;
      const cursor = request.result;
      if (!cursor) return resolve({ rows, nextKey, done: true, cursorOperations });
      if (rows.length >= limit) return resolve({ rows, nextKey, done: false, cursorOperations });
      rows.push(cursor.value);
      nextKey = cursor.key;
      cursor.continue();
    };
  });
}

function readLibraryRecordsById(database, ids, metadataOnly, maxIds = 1000) {
  if (
    !Array.isArray(ids) ||
    ids.length > maxIds ||
    ids.some(id => !['string', 'number'].includes(typeof id) || !String(id).trim() || String(id).length > 128)
  ) {
    throw new RangeError(`Library reads are limited to ${maxIds.toLocaleString()} validated post IDs per batch`);
  }
  const wanted = [...new Set(ids.map(String))];
  return new Promise((resolve, reject) => {
    const tx = database.transaction('tweets'),
      rows = [];
    tx.oncomplete = () => resolve(rows);
    tx.onabort = () => reject(tx.error || new Error('Metadata read aborted'));
    tx.onerror = () => reject(tx.error || new Error('Metadata read failed'));
    for (const id of wanted) {
      const request = tx.objectStore('tweets').get(id);
      request.onsuccess = () => {
        const row = request.result;
        if (row) rows.push(metadataOnly ? { id: row.id, userMeta: row.userMeta || {}, updatedAt: row.updatedAt } : row);
      };
    }
  });
}

export const readLibraryMetadata = (database, ids) => readLibraryRecordsById(database, ids, true);
// Ranked query pages can contain up to 1,500 IDs; keep this read capacity
// separate from the 1,000-ID write/mutation boundary.
export const readLibraryRecords = (database, ids) => readLibraryRecordsById(database, ids, false, 1500);

export async function readDownloadRows(database, tweetIds, options = {}) {
  const rows = await readOwnDownloadRows(database, tweetIds, options),
    limit = Math.max(1, Math.min(10000, Number(options.totalLimit) || 5000));
  const shared = await readSharedFiles(database, (tweetIds || []).slice(0, 1000), {
    limit: Math.max(0, limit - rows.length),
    perPostLimit: Math.min(128, Number(options.perPostLimit) || 64),
  });
  rows.push(...shared);
  rows.truncated = !!(rows.truncated || shared.truncated);
  rows.cursorOperations = (rows.cursorOperations || 0) + (shared.cursorOperations || 0);
  return rows;
}

function readOwnDownloadRows(database, tweetIds, options = {}) {
  const ids = new Set(mutationIds((tweetIds || []).slice(0, 1000)));
  if (!ids.size) return Promise.resolve([]);
  const perPostLimit = Math.max(1, Math.min(128, Math.floor(Number(options.perPostLimit) || 64)));
  const totalLimit = Math.max(1, Math.min(10000, Math.floor(Number(options.totalLimit) || 5000)));
  return new Promise((resolve, reject) => {
    const tx = database.transaction('downloads', 'readonly');
    const store = tx.objectStore('downloads');
    const rows = [];
    if (store.indexNames.contains('tweetId')) {
      const index = store.index('tweetId');
      let cursorOperations = 0;
      for (const id of ids) {
        let count = 0;
        const request = index.openCursor(IDBKeyRange.only(id));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          cursorOperations++;
          const cursor = request.result;
          if (!cursor) return;
          if (count >= perPostLimit || rows.length >= totalLimit) {
            rows.truncated = true;
            return;
          }
          rows.push(cursor.value);
          count++;
          cursor.continue();
        };
      }
      tx.oncomplete = () => {
        rows.cursorOperations = cursorOperations;
        resolve(rows);
      };
      tx.onabort = () => reject(tx.error || new Error('Download read aborted'));
      tx.onerror = () => reject(tx.error || new Error('Download read failed'));
      return;
    }
    const scanLimit = 10000;
    let scanned = 0,
      cursorOperations = 0;
    const request = store.openCursor();
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error || new Error('Download read aborted'));
    tx.onerror = () => reject(tx.error || new Error('Download read failed'));
    tx.oncomplete = () => {
      rows.scanned ??= scanned;
      rows.cursorOperations = cursorOperations;
      resolve(rows);
    };
    request.onsuccess = () => {
      cursorOperations++;
      const cursor = request.result;
      if (!cursor) return;
      if (scanned >= scanLimit) {
        rows.truncated = true;
        rows.scanned = scanned;
        rows.cursorOperations = cursorOperations;
        return;
      }
      scanned++;
      const row = cursor.value;
      if (ids.has(String(row.item?.tweetId || ''))) {
        if (rows.length >= totalLimit) {
          rows.truncated = true;
          rows.scanned = scanned;
          rows.cursorOperations = cursorOperations;
          return;
        }
        rows.push(row);
      }
      rows.scanned = scanned;
      rows.cursorOperations = cursorOperations;
      cursor.continue();
    };
  });
}

// The dashboard's recent-download strip is a window, not a request for the
// complete transfer ledger. Prefer the creation-time index and bound the
// returned record set independently of the archive size.
export function readDownloadHistoryPage(database, requestedLimit = 60) {
  const limit = Math.max(1, Math.min(500, Math.floor(Number(requestedLimit) || 60)));
  return new Promise((resolve, reject) => {
    const tx = database.transaction('downloads', 'readonly');
    const store = tx.objectStore('downloads'),
      rows = [],
      indexed = store.indexNames.contains('createdAt');
    let cursorOperations = 0,
      recordsRead = 0,
      legacyScanned = 0,
      legacyScanTruncated = false,
      legacyStarted = false,
      error = null;
    const legacyScanLimit = Math.min(1000, Math.max(250, limit * 4));
    tx.oncomplete = () => {
      let bytesEstimate = 0;
      try {
        bytesEstimate = rows.length ? JSON.stringify(rows).length * 2 : 0;
      } catch {}
      resolve({
        rows,
        recordsRead,
        recordsMaterialized: recordsRead,
        cursorOperations,
        legacyScanned,
        legacyScanLimit,
        legacyScanTruncated,
        bytesEstimate,
        index: indexed ? 'createdAt' : 'primaryKey',
      });
    };
    tx.onabort = () => reject(error || tx.error || new Error('Download history read aborted'));
    tx.onerror = () => reject(error || tx.error || new Error('Download history read failed'));
    const beginLegacy = () => {
      if (!indexed || legacyStarted || rows.length >= limit) return;
      legacyStarted = true;
      const legacy = store.openCursor(null, 'prev');
      legacy.onerror = () => {
        error = legacy.error || new Error('Legacy download history cursor failed');
        try {
          tx.abort();
        } catch {}
      };
      legacy.onsuccess = () => {
        cursorOperations++;
        const cursor = legacy.result;
        if (!cursor || rows.length >= limit) return;
        if (legacyScanned >= legacyScanLimit) {
          legacyScanTruncated = true;
          return;
        }
        legacyScanned++;
        recordsRead++;
        if (cursor.value?.createdAt == null) rows.push(cursor.value);
        if (rows.length >= limit) return;
        if (legacyScanned >= legacyScanLimit) {
          legacyScanTruncated = true;
          return;
        }
        cursor.continue();
      };
    };
    const source = indexed ? store.index('createdAt') : store;
    const request = source.openCursor(null, 'prev');
    request.onerror = () => {
      error = request.error || new Error('Download history cursor failed');
      try {
        tx.abort();
      } catch {}
    };
    request.onsuccess = () => {
      cursorOperations++;
      const cursor = request.result;
      if (!cursor) {
        beginLegacy();
        return;
      }
      if (rows.length >= limit) return;
      recordsRead++;
      rows.push(cursor.value);
      if (rows.length < limit) cursor.continue();
    };
  });
}

// Queue maintenance reads a narrow state window. The compound [state, key]
// index also gives callers a deterministic continuation point without keeping
// a cursor or a large queue projection alive between IndexedDB transactions.
export function readDownloadRowsByStatePage(database, state, options = {}) {
  const wantedState = String(state || '');
  const limit = Math.max(1, Math.min(256, Math.floor(Number(options.limit) || 64)));
  const afterKey = options.afterKey == null ? null : String(options.afterKey);
  if (!wantedState) return Promise.reject(new TypeError('A download state is required'));
  return new Promise((resolve, reject) => {
    const tx = database.transaction('downloads', 'readonly');
    const store = tx.objectStore('downloads');
    if (!store.indexNames.contains('stateKey')) {
      try {
        tx.abort();
      } catch {}
      reject(new Error('The download state/key index is unavailable; reopen XVault to finish the storage upgrade'));
      return;
    }
    const rows = [];
    let recordsRead = 0,
      cursorOperations = 0,
      hasMore = false,
      nextKey = afterKey,
      error = null;
    const lower = afterKey == null ? [wantedState] : [wantedState, afterKey];
    const range = IDBKeyRange.bound(lower, [wantedState, []], afterKey != null, false);
    tx.oncomplete = () => {
      let bytesEstimate = 0;
      try {
        bytesEstimate = rows.length ? JSON.stringify(rows).length * 2 : 0;
      } catch {}
      resolve({
        rows,
        state: wantedState,
        nextKey,
        hasMore,
        done: !hasMore,
        recordsRead,
        recordsMaterialized: recordsRead,
        returned: rows.length,
        cursorOperations,
        bytesEstimate,
        index: 'stateKey',
      });
    };
    tx.onabort = () => reject(error || tx.error || new Error('Download state page aborted'));
    tx.onerror = () => reject(error || tx.error || new Error('Download state page failed'));
    const request = store.index('stateKey').openCursor(range);
    request.onerror = () => {
      error = request.error || new Error('Download state cursor failed');
      try {
        tx.abort();
      } catch {}
    };
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursorOperations++;
      recordsRead++;
      if (rows.length >= limit) {
        hasMore = true;
        return;
      }
      rows.push(cursor.value);
      nextKey = String(cursor.primaryKey);
      cursor.continue();
    };
  });
}

// Enqueue usually needs only the canonical primary keys for the requested
// assets. Read those directly instead of cloning download history into a Map.
export function readDownloadRowsByKeys(database, keys = []) {
  const wanted = [...new Set(keys.map(String))].slice(0, 2000);
  if (!wanted.length)
    return Promise.resolve({ rows: new Map(), recordsRead: 0, indexOperations: 0, recordsMaterialized: 0 });
  return new Promise((resolve, reject) => {
    const tx = database.transaction('downloads', 'readonly');
    const store = tx.objectStore('downloads'),
      rows = new Map();
    let recordsRead = 0,
      indexOperations = 0,
      error = null;
    tx.oncomplete = () => resolve({ rows, recordsRead, indexOperations, recordsMaterialized: rows.size });
    tx.onabort = () => reject(error || tx.error || new Error('Download identity lookup aborted'));
    tx.onerror = () => reject(error || tx.error || new Error('Download identity lookup failed'));
    for (const key of wanted) {
      indexOperations++;
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result) {
          rows.set(key, request.result);
          recordsRead++;
        }
      };
      request.onerror = () => {
        error = request.error || new Error('Download identity lookup failed');
        try {
          tx.abort();
        } catch {}
      };
    }
  });
}

// The optional Save Once policy asks whether one of a small batch of assets is
// already represented elsewhere. `stateKey` lets this exceptional path scan
// one cursor value at a time; only rows matching this request are retained.
// Completed files are preferred because they provide a real local owner.
export function readExistingDownloadRowsByAssets(database, assets = [], options = {}) {
  const wanted = [...new Set(assets.map(String).filter(Boolean).slice(0, 2000))];
  if (!wanted.length)
    return Promise.resolve({
      rows: new Map(),
      recordsRead: 0,
      recordsMaterialized: 0,
      cursorOperations: 0,
      statesScanned: 0,
      index: 'none',
    });
  const wantedSet = new Set(wanted);
  const states = [
    ...new Set(
      (options.states || ['complete', 'queued', 'downloading', 'retry-wait', 'paused', 'verifying', 'converting']).map(
        String
      )
    ),
  ];
  return new Promise((resolve, reject) => {
    const hasCheckpoints = database.objectStoreNames.contains('checkpoints');
    const names = hasCheckpoints ? ['downloads', 'checkpoints'] : ['downloads'];
    const tx = database.transaction(names, 'readonly'),
      store = tx.objectStore('downloads');
    const indexed = hasCheckpoints && store.indexNames.contains('usableAssetKey');
    if (!store.indexNames.contains('stateKey')) {
      if (!indexed) {
        try {
          tx.abort();
        } catch {}
        reject(new Error('The download state/key index is unavailable; reopen XVault to finish the storage upgrade'));
        return;
      }
    }
    const rows = new Map();
    const scanLimit = Math.max(1, Math.min(100_000, Math.floor(Number(options.scanLimit) || 50_000)));
    let recordsRead = 0,
      cursorOperations = 0,
      statesScanned = 0,
      stateIndex = 0,
      assetIndex = 0,
      truncated = false,
      cancelled = false,
      error = null,
      assetIndexComplete = false,
      indexOperations = 0;
    const checkCancellation = () => {
      if (typeof options.cancelled !== 'function') return false;
      try {
        if (!options.cancelled()) return false;
      } catch (cancelError) {
        error = cancelError instanceof Error ? cancelError : new Error(String(cancelError));
        try {
          tx.abort();
        } catch {}
        return true;
      }
      cancelled = true;
      try {
        tx.abort();
      } catch {}
      return true;
    };
    const finishIndexedLookup = () => {
      const unresolved = wanted.filter(asset => !rows.has(asset));
      const incompleteIndex = !assetIndexComplete && unresolved.length > 0;
      resolve({
        rows,
        recordsRead,
        recordsMaterialized: rows.size,
        cursorOperations,
        statesScanned: 0,
        indexOperations,
        scanLimit: 0,
        truncated: incompleteIndex,
        cancelled,
        incompleteIndex: !assetIndexComplete,
        assetIndexComplete,
        unresolved,
        index: 'usableAssetKey',
      });
    };
    const openNextAsset = () => {
      if (checkCancellation()) return;
      if (assetIndex >= wanted.length) return;
      const asset = wanted[assetIndex++];
      indexOperations++;
      const request = store.index('usableAssetKey').openCursor(IDBKeyRange.only(asset));
      request.onerror = () => {
        error = request.error || new Error('Indexed download asset lookup failed');
        try {
          tx.abort();
        } catch {}
      };
      request.onsuccess = () => {
        if (checkCancellation()) return;
        const cursor = request.result;
        if (!cursor) return openNextAsset();
        cursorOperations++;
        recordsRead++;
        const row = cursor.value;
        if (row?.usableAssetKey === asset && row?.assetKey === asset && states.includes(String(row.state || ''))) {
          rows.set(asset, row);
          return openNextAsset();
        }
        cursor.continue();
      };
    };
    if (indexed) {
      const status = tx.objectStore('checkpoints').get(DOWNLOAD_ASSET_INDEX_CHECKPOINT);
      status.onerror = () => {
        error = status.error || new Error('Download asset-index status read failed');
        try {
          tx.abort();
        } catch {}
      };
      status.onsuccess = () => {
        assetIndexComplete = status.result?.complete === true;
        openNextAsset();
      };
      tx.oncomplete = finishIndexedLookup;
      tx.onabort = () =>
        cancelled
          ? resolve({
              rows,
              recordsRead,
              recordsMaterialized: rows.size,
              cursorOperations,
              statesScanned: 0,
              indexOperations,
              scanLimit: 0,
              truncated: false,
              cancelled: true,
              incompleteIndex: !assetIndexComplete,
              assetIndexComplete,
              unresolved: wanted.filter(asset => !rows.has(asset)),
              index: 'usableAssetKey',
            })
          : reject(error || tx.error || new Error('Download asset lookup aborted'));
      tx.onerror = () => reject(error || tx.error || new Error('Download asset lookup failed'));
      return;
    }
    if (!store.indexNames.contains('stateKey')) {
      try {
        tx.abort();
      } catch {}
      reject(new Error('The download state/key index is unavailable; reopen XVault to finish the storage upgrade'));
      return;
    }
    const openNextState = () => {
      if (stateIndex >= states.length || rows.size === wanted.length || truncated || cancelled) return;
      const state = states[stateIndex++];
      statesScanned++;
      const range = IDBKeyRange.bound([state], [state, []]);
      const request = store.index('stateKey').openCursor(range);
      request.onerror = () => {
        error = request.error || new Error('Download asset cursor failed');
        try {
          tx.abort();
        } catch {}
      };
      request.onsuccess = () => {
        if (checkCancellation()) return;
        const cursor = request.result;
        if (!cursor) {
          openNextState();
          return;
        }
        cursorOperations++;
        recordsRead++;
        const row = cursor.value;
        if (row?.item?.url) {
          const asset = globalThis.XVaultMediaAsset.assetIdentity(row.item.url).asset;
          if (wantedSet.has(asset) && !rows.has(asset)) rows.set(asset, row);
        }
        if (rows.size < wanted.length) {
          if (recordsRead >= scanLimit) {
            truncated = true;
            return;
          }
          cursor.continue();
        }
      };
    };
    tx.oncomplete = () =>
      resolve({
        rows,
        recordsRead,
        recordsMaterialized: rows.size,
        cursorOperations,
        statesScanned,
        scanLimit,
        truncated,
        cancelled,
        index: 'stateKey',
      });
    tx.onabort = () =>
      cancelled
        ? resolve({
            rows,
            recordsRead,
            recordsMaterialized: rows.size,
            cursorOperations,
            statesScanned,
            scanLimit,
            truncated: false,
            cancelled: true,
          })
        : reject(error || tx.error || new Error('Download asset lookup aborted'));
    tx.onerror = () => reject(error || tx.error || new Error('Download asset lookup failed'));
    openNextState();
  });
}

export function readDownloadAssetIndexStatus(database) {
  if (!database.objectStoreNames.contains('checkpoints'))
    return Promise.resolve({ complete: false, processed: 0, available: false });
  return new Promise((resolve, reject) => {
    const tx = database.transaction('checkpoints', 'readonly');
    const request = tx.objectStore('checkpoints').get(DOWNLOAD_ASSET_INDEX_CHECKPOINT);
    request.onsuccess = () =>
      resolve({
        complete: request.result?.complete === true,
        countsComplete: request.result?.countsComplete === true,
        stateCounts:
          request.result?.countsComplete === true
            ? { ...emptyDownloadStateCounts(), ...(request.result?.stateCounts || {}) }
            : null,
        processed: Math.max(0, Number(request.result?.processed) || 0),
        available: true,
      });
    request.onerror = () => reject(request.error || new Error('Download asset-index status read failed'));
    tx.onabort = () => reject(tx.error || new Error('Download asset-index status read aborted'));
  });
}

// Backfill legacy rows in bounded primary-key pages. New writes maintain both
// lookup fields directly, so a durable cursor checkpoint cannot miss a row
// inserted or changed behind the migration boundary.
export function backfillDownloadAssetIndexPage(database, { limit = 256 } = {}) {
  const pageLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 256)));
  if (!database.objectStoreNames.contains('checkpoints'))
    return Promise.reject(new Error('Download asset-index checkpoint store is unavailable'));
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['downloads', 'checkpoints'], 'readwrite');
    const store = tx.objectStore('downloads'),
      checkpoints = tx.objectStore('checkpoints');
    if (!store.indexNames.contains('usableAssetKey')) {
      try {
        tx.abort();
      } catch {}
      reject(new Error('Download asset lookup index is unavailable; reopen XVault to finish the storage upgrade'));
      return;
    }
    let checkpoint = null,
      recordsRead = 0,
      recordsUpdated = 0,
      afterKey = null,
      complete = false,
      error = null;
    const writeCheckpoint = isComplete => {
      complete = isComplete;
      checkpoint = {
        ...checkpoint,
        key: DOWNLOAD_ASSET_INDEX_CHECKPOINT,
        complete: isComplete,
        countsComplete: isComplete,
        afterKey: isComplete ? null : afterKey,
        processed: Math.max(0, Number(checkpoint?.processed) || 0) + recordsRead,
        stateCounts: checkpoint?.stateCounts || emptyDownloadStateCounts(),
        stateCounterVersion: DOWNLOAD_STATE_COUNTER_VERSION,
        updatedAt: Date.now(),
      };
      checkpoints.put(checkpoint);
    };
    tx.oncomplete = () =>
      resolve({
        recordsRead,
        recordsUpdated,
        complete,
        afterKey: complete ? null : afterKey,
        processed: Math.max(0, Number(checkpoint?.processed) || 0),
        index: 'primaryKey',
      });
    tx.onabort = () => reject(error || tx.error || new Error('Download asset-index backfill aborted'));
    tx.onerror = () => reject(error || tx.error || new Error('Download asset-index backfill failed'));
    const stateRequest = checkpoints.get(DOWNLOAD_ASSET_INDEX_CHECKPOINT);
    stateRequest.onerror = () => {
      error = stateRequest.error || new Error('Download asset-index checkpoint read failed');
      try {
        tx.abort();
      } catch {}
    };
    stateRequest.onsuccess = () => {
      checkpoint = stateRequest.result || { complete: false, afterKey: null, processed: 0 };
      if (checkpoint.complete === true && checkpoint.countsComplete === true) {
        complete = true;
        return;
      }
      checkpoint.stateCounts = { ...emptyDownloadStateCounts(), ...(checkpoint.stateCounts || {}) };
      afterKey = checkpoint.afterKey == null ? null : String(checkpoint.afterKey);
      const range = afterKey == null ? undefined : IDBKeyRange.lowerBound(afterKey, true);
      const request = store.openCursor(range);
      request.onerror = () => {
        error = request.error || new Error('Download asset-index cursor failed');
        try {
          tx.abort();
        } catch {}
      };
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          checkpoint.countsComplete = true;
          writeCheckpoint(true);
          return;
        }
        const row = cursor.value,
          oldAsset = row.assetKey,
          oldUsable = row.usableAssetKey,
          oldCountedVersion = row.countedStateVersion;
        recordsRead++;
        afterKey = String(cursor.primaryKey);
        withDownloadAssetLookup(row);
        if (row.countedStateVersion !== DOWNLOAD_STATE_COUNTER_VERSION) {
          rowCountDelta(checkpoint.stateCounts, row.state, 1);
          row.countedStateVersion = DOWNLOAD_STATE_COUNTER_VERSION;
        }
        if (
          row.assetKey !== oldAsset ||
          row.usableAssetKey !== oldUsable ||
          oldCountedVersion !== row.countedStateVersion
        ) {
          cursor.update(row);
          recordsUpdated++;
        }
        if (recordsRead >= pageLimit) {
          writeCheckpoint(false);
          return;
        }
        cursor.continue();
      };
    };
  });
}

// Hash deduplication is an opt-in exceptional query. Stream the completed
// state index and stop at the first match; never retain unrelated history.
export function findCompletedDownloadByHash(database, hash, options = {}) {
  const wanted = String(hash || '');
  if (!wanted) return Promise.resolve({ found: false, recordsRead: 0, cursorOperations: 0, index: 'stateKey' });
  return new Promise((resolve, reject) => {
    const tx = database.transaction('downloads', 'readonly'),
      store = tx.objectStore('downloads');
    if (!store.indexNames.contains('stateKey')) {
      try {
        tx.abort();
      } catch {}
      reject(new Error('The download state/key index is unavailable; reopen XVault to finish the storage upgrade'));
      return;
    }
    const scanLimit = Math.max(1, Math.min(100_000, Math.floor(Number(options.scanLimit) || 50_000)));
    let found = false,
      recordsRead = 0,
      cursorOperations = 0,
      truncated = false,
      cancelled = false,
      error = null;
    const checkCancellation = () => {
      if (typeof options.cancelled !== 'function') return false;
      try {
        if (!options.cancelled()) return false;
      } catch (cancelError) {
        error = cancelError instanceof Error ? cancelError : new Error(String(cancelError));
        try {
          tx.abort();
        } catch {}
        return true;
      }
      cancelled = true;
      try {
        tx.abort();
      } catch {}
      return true;
    };
    const request = store.index('stateKey').openCursor(IDBKeyRange.bound(['complete'], ['complete', []]));
    request.onerror = () => {
      error = request.error || new Error('Completed-file hash scan failed');
      try {
        tx.abort();
      } catch {}
    };
    request.onsuccess = () => {
      if (checkCancellation()) return;
      const cursor = request.result;
      if (!cursor) return;
      recordsRead++;
      cursorOperations++;
      if (cursor.value?.sha256 === wanted) {
        found = true;
        return;
      }
      if (recordsRead >= scanLimit) {
        truncated = true;
        return;
      }
      cursor.continue();
    };
    tx.oncomplete = () =>
      resolve({ found, recordsRead, cursorOperations, index: 'stateKey', scanLimit, truncated, cancelled });
    tx.onabort = () =>
      cancelled
        ? resolve({
            found,
            recordsRead,
            cursorOperations,
            index: 'stateKey',
            scanLimit,
            truncated: false,
            cancelled: true,
          })
        : reject(error || tx.error || new Error('Completed-file hash scan aborted'));
    tx.onerror = () => reject(error || tx.error || new Error('Completed-file hash scan failed'));
  });
}

// Chrome's download ID is a secondary identity assigned after admission. Use
// its index to route progress/completion events to one row in constant-time.
export function readDownloadRowByBrowserId(database, downloadId) {
  const id = Number(downloadId);
  if (!Number.isSafeInteger(id) || id < 0)
    return Promise.resolve({ row: null, recordsRead: 0, indexOperations: 0, index: 'downloadId' });
  return new Promise((resolve, reject) => {
    const tx = database.transaction('downloads', 'readonly');
    const store = tx.objectStore('downloads');
    if (!store.indexNames.contains('downloadId')) {
      try {
        tx.abort();
      } catch {}
      reject(new Error('The browser download ID index is unavailable; reopen XVault to finish the storage upgrade'));
      return;
    }
    let row = null,
      error = null;
    const request = store.index('downloadId').get(id);
    request.onsuccess = () => {
      row = request.result || null;
    };
    request.onerror = () => {
      error = request.error || new Error('Browser download lookup failed');
      try {
        tx.abort();
      } catch {}
    };
    tx.oncomplete = () => resolve({ row, recordsRead: row ? 1 : 0, indexOperations: 1, index: 'downloadId' });
    tx.onabort = () => reject(error || tx.error || new Error('Browser download lookup aborted'));
    tx.onerror = () => reject(error || tx.error || new Error('Browser download lookup failed'));
  });
}

// Prepared queue actions may yield while deriving a target. Recheck their
// state/version in the write transaction and apply only a small patch to the
// latest row, so a completion/progress event cannot be overwritten by a stale
// retry or target rebuild snapshot.
export function patchLibraryDownloadRowsIfCurrent(database, entries = []) {
  const prepared = new Map();
  for (const entry of entries)
    if (entry?.key != null && entry.patch && typeof entry.patch === 'object') prepared.set(String(entry.key), entry);
  if (!prepared.size) return Promise.resolve({ updated: 0, skipped: 0, changedIds: [], truncated: false, revision: 0 });
  return new Promise((resolve, reject) => {
    const names = database.objectStoreNames.contains('checkpoints') ? ['downloads', 'checkpoints'] : ['downloads'];
    if (database.objectStoreNames.contains('mediaAssociations')) names.push('mediaAssociations');
    const tx = database.transaction(names, 'readwrite'),
      store = tx.objectStore('downloads'),
      changedIds = new Set();
    let updated = 0,
      skipped = 0,
      truncated = false,
      bumped = false,
      revision = 0,
      error = null;
    tx.oncomplete = () => resolve({ updated, skipped, changedIds: [...changedIds], truncated, revision });
    tx.onabort = () => reject(error || tx.error || new Error('Conditional download update aborted'));
    tx.onerror = () => reject(error || tx.error || new Error('Conditional download update failed'));
    if (names.includes('checkpoints')) {
      const currentRevision = tx.objectStore('checkpoints').get(LIBRARY_DOWNLOAD_REVISION_KEY);
      currentRevision.onsuccess = () => {
        revision = Number(currentRevision.result?.revision || 0);
      };
      currentRevision.onerror = () => {
        error = currentRevision.error;
        try {
          tx.abort();
        } catch {}
      };
    }
    const addChangedId = value => {
      if (value == null || String(value) === '') return;
      const id = String(value);
      if (changedIds.has(id)) return;
      if (changedIds.size >= 1000) {
        truncated = true;
        return;
      }
      changedIds.add(id);
    };
    const bumpOnce = () => {
      if (bumped) return;
      bumped = true;
      const request = bumpLibraryDownloadRevision(tx);
      if (!request) {
        revision++;
        return;
      }
      const onSuccess = request.onsuccess;
      request.onsuccess = event => {
        onSuccess?.call(request, event);
        revision = Number(request.result?.revision || 0) + 1;
      };
    };
    for (const [key, entry] of prepared) {
      const request = store.get(key);
      request.onsuccess = () => {
        const current = request.result;
        const expected = entry.expected && typeof entry.expected === 'object' ? entry.expected : {};
        const matches =
          current && Object.entries(expected).every(([field, value]) => (current[field] ?? null) === (value ?? null));
        if (!matches) {
          skipped++;
          return;
        }
        const next = { ...current, ...entry.patch, key };
        if (downloadQuerySignature(current) !== downloadQuerySignature(next)) {
          if (names.includes('mediaAssociations')) collectSharedPostIds(tx, key, changedIds);
          addChangedId(next.item?.tweetId ?? current.item?.tweetId);
          bumpOnce();
        }
        store.put(next);
        updated++;
      };
      request.onerror = () => {
        error = request.error || new Error('Conditional download read failed');
        try {
          tx.abort();
        } catch {}
      };
    }
  });
}

function mutationIds(ids) {
  if (!Array.isArray(ids) || ids.length > 1000)
    throw new RangeError('Library changes require batches of at most 1000 post IDs');
  if (ids.some(id => !['string', 'number'].includes(typeof id) || !String(id).trim() || String(id).length > 128))
    throw new TypeError('Invalid post ID');
  return [...new Set(ids.map(String))];
}

// Compare and patch inside one readwrite transaction. Separate reads/writes
// allow two dashboard windows (or Remote) to silently overwrite each other.
export function updateLibraryRecord(database, id, patch = {}, expectedNote) {
  const [key] = mutationIds([id]);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Invalid metadata patch');
  if (Object.hasOwn(patch, 'note') && (typeof patch.note !== 'string' || patch.note.length > 100000))
    throw new RangeError('A note must be text with at most 100000 characters');
  return new Promise((resolve, reject) => {
    const stores = database.objectStoreNames.contains('checkpoints') ? ['tweets', 'checkpoints'] : ['tweets'];
    const tx = database.transaction(stores, 'readwrite'),
      store = tx.objectStore('tweets');
    let result = { ok: false, error: 'Post not found' };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('Note update aborted'));
    tx.onerror = () => reject(tx.error || new Error('Metadata update failed'));
    const request = store.get(key);
    request.onsuccess = () => {
      const row = request.result;
      if (!row) return;
      if (
        Object.keys(patch).length === 1 &&
        Object.hasOwn(patch, 'note') &&
        (row.userMeta?.note || '') === patch.note
      ) {
        result = { ok: true, row };
        return;
      }
      if (Object.hasOwn(patch, 'note') && expectedNote !== undefined && (row.userMeta?.note || '') !== expectedNote) {
        result = {
          ok: false,
          conflict: true,
          row,
          error: 'This note changed in another window. Both versions are preserved.',
        };
        return;
      }
      const meta = { ...(row.userMeta || {}) };
      for (const field of ['note', 'favorite', 'tags', 'colorLabel', 'reviewedAt'])
        if (Object.hasOwn(patch, field)) meta[field] = patch[field];
      const next = { ...row, userMeta: meta, updatedAt: Date.now() };
      store.put(next);
      bumpLibraryRevision(tx);
      result = { ok: true, row: next };
    };
  });
}

function mediaPatchConflict(row, index, error) {
  return { ok: false, conflict: true, row, media: row.media[index], error };
}

function validMediaTags(value) {
  if (!Array.isArray(value) || value.length > 200 || value.some(tag => typeof tag !== 'string' || tag.length > 80))
    throw new RangeError('Media tags must contain at most 200 text labels of 80 characters each');
  return [...new Set(value.map(tag => tag.trim().replace(/^#/, '')).filter(Boolean))];
}

function safeMediaSourceUrl(value) {
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Media source must be an HTTP or HTTPS URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 2048)
    throw new TypeError('Media source must be a credential-free HTTP or HTTPS URL of at most 2,048 characters');
  return url.href;
}

// Per-media edits share the post's atomic IndexedDB record write and archive
// query revision. Field baselines and annotation timestamps make a stale
// editor visible instead of silently replacing a different window's work.
export function updateLibraryMediaMetadata(database, id, requestedKey, command = {}) {
  const [key] = mutationIds([id]);
  const mediaKey = String(requestedKey || '');
  if (!mediaKey || mediaKey.length > 512) throw new TypeError('Invalid media identity');
  if (!command || typeof command !== 'object' || Array.isArray(command))
    throw new TypeError('Invalid media metadata change');
  const supported = new Set([
    'fields',
    'annotation-add',
    'annotation-edit',
    'annotation-delete',
    'annotation-restore',
    'annotation-move',
  ]);
  if (!supported.has(command.type)) throw new TypeError('Unsupported media metadata operation');
  if (command.type === 'fields') {
    if (
      !command.expected ||
      !command.values ||
      typeof command.expected !== 'object' ||
      typeof command.values !== 'object'
    )
      throw new TypeError('Media field edits require current and proposed values');
    for (const field of ['note', 'tags', 'source', 'sourceUrl'])
      if (!Object.hasOwn(command.expected, field) || !Object.hasOwn(command.values, field))
        throw new TypeError('Media field edits require a baseline for every field');
    if (typeof command.values.note !== 'string' || command.values.note.length > 100000)
      throw new RangeError('A media note must be text with at most 100,000 characters');
    if (typeof command.values.source !== 'string' || command.values.source.length > 1000)
      throw new RangeError('Media provenance text must be at most 1,000 characters');
    validMediaTags(command.expected.tags);
    validMediaTags(command.values.tags);
    safeMediaSourceUrl(command.expected.sourceUrl);
    safeMediaSourceUrl(command.values.sourceUrl);
  }
  if (command.type === 'annotation-add' || command.type === 'annotation-edit')
    mediaArchive.validateAnnotation(command.annotation);
  if (
    ['annotation-delete', 'annotation-restore', 'annotation-move'].includes(command.type) &&
    !String(command.annotationId || '')
  )
    throw new TypeError('Annotation ID is required');
  if (
    command.type === 'annotation-move' &&
    (!Array.isArray(command.expectedOrder) ||
      command.expectedOrder.length > 2000 ||
      new Set(command.expectedOrder.map(String)).size !== command.expectedOrder.length ||
      ![-1, 1].includes(Number(command.delta)))
  )
    throw new TypeError('Reordering requires the current unique annotation order and a one-step direction');
  return new Promise((resolve, reject) => {
    const stores = database.objectStoreNames.contains('checkpoints') ? ['tweets', 'checkpoints'] : ['tweets'];
    const tx = database.transaction(stores, 'readwrite'),
      store = tx.objectStore('tweets');
    let result = { ok: false, error: 'Post not found' },
      revision = null,
      failure = null;
    tx.oncomplete = () => resolve({ ...result, ...(revision == null ? {} : { revision }) });
    tx.onabort = () => reject(failure || tx.error || new Error('Media metadata update aborted'));
    tx.onerror = () => reject(failure || tx.error || new Error('Media metadata update failed'));
    const request = store.get(key);
    request.onerror = () => {
      failure = request.error || new Error('Media record read failed');
      try {
        tx.abort();
      } catch {}
    };
    request.onsuccess = () => {
      try {
        const row = request.result;
        if (!row) return;
        const media = Array.isArray(row.media) ? row.media : [];
        const index = media.findIndex((item, itemIndex) => mediaArchive.mediaKey(key, item, itemIndex) === mediaKey);
        if (index < 0) {
          result = {
            ok: false,
            mediaMissing: true,
            error:
              'This media item changed or was replaced. Its saved metadata remains attached to the archived evidence.',
          };
          return;
        }
        if (command.type.startsWith('annotation-') && !mediaArchive.canTimestamp(media[index])) {
          result = { ok: false, error: 'Timestamp notes can only be attached to video or animated media.' };
          return;
        }
        const previous = mediaArchive.metadataFor(media[index]);
        let annotations = previous.annotations.slice();
        if (command.type.startsWith('annotation-')) {
          try {
            annotations = annotations.map(mediaArchive.validateAnnotation);
          } catch {
            result = {
              ok: false,
              error:
                'Existing timestamp annotation evidence is malformed. It was preserved; repair or export it before editing annotations.',
            };
            return;
          }
        }
        let nextMeta = {
          ...media[index].xvault,
          mediaKey,
          note: previous.note,
          tags: previous.tags,
          source: previous.source,
          sourceUrl: previous.sourceUrl,
          annotations,
          provenance: previous.provenance,
          derivatives: previous.derivatives,
          importConflicts: previous.importConflicts,
        };
        // Several rapid edits can occur inside one clock millisecond. Keep
        // annotation baselines strictly increasing so stale delete/undo checks
        // cannot accidentally accept an earlier version with the same stamp.
        const latestAnnotationEdit = annotations.reduce(
          (latest, annotation) =>
            Math.max(latest, Number(annotation.updatedAt) || 0, Number(annotation.deletedAt) || 0),
          0
        );
        const now = Math.max(Date.now(), latestAnnotationEdit + 1);
        if (command.type === 'fields') {
          const expected = command.expected;
          const values = command.values;
          if (!expected || !values || typeof expected !== 'object' || typeof values !== 'object') {
            result = { ok: false, error: 'Reload media metadata before saving; a field baseline is required.' };
            return;
          }
          for (const field of ['note', 'tags', 'source', 'sourceUrl']) {
            if (!Object.hasOwn(expected, field) || !Object.hasOwn(values, field)) {
              result = { ok: false, error: 'Reload media metadata before saving; all edited fields need a baseline.' };
              return;
            }
            const actual = field === 'tags' ? JSON.stringify(previous.tags) : previous[field];
            const baseline =
              field === 'tags' ? JSON.stringify(validMediaTags(expected.tags)) : String(expected[field] || '');
            if (actual !== baseline) {
              result = mediaPatchConflict(
                row,
                index,
                `Media ${field} changed in another window. Your draft is still open; load the saved version before trying again.`
              );
              return;
            }
          }
          const note = values.note;
          const source = values.source;
          if (typeof note !== 'string' || note.length > 100000)
            throw new RangeError('A media note must be text with at most 100,000 characters');
          if (typeof source !== 'string' || source.length > 1000)
            throw new RangeError('Media provenance text must be at most 1,000 characters');
          const tags = validMediaTags(values.tags),
            sourceUrl = safeMediaSourceUrl(values.sourceUrl);
          nextMeta = { ...nextMeta, note, tags, source, sourceUrl };
        } else if (command.type === 'annotation-add') {
          const lastPosition = annotations
            .filter(item => !item.deletedAt)
            .reduce((latest, item) => Math.max(latest, Number(item.position) || 0), -1);
          const added = mediaArchive.validateAnnotation({
            ...command.annotation,
            createdAt: Number(command.annotation?.createdAt) || now,
            updatedAt: now,
            position: lastPosition + 1,
          });
          const existing = annotations.find(item => item.id === added.id);
          if (existing) {
            if (!existing.deletedAt && existing.atMs === added.atMs && existing.text === added.text) {
              result = { ok: true, row, unchanged: true };
              return;
            }
            result = mediaPatchConflict(
              row,
              index,
              'An annotation with this ID already exists. Reload the current annotations before retrying.'
            );
            return;
          }
          annotations.push(added);
          nextMeta.annotations = annotations;
        } else if (command.type === 'annotation-edit') {
          const incoming = mediaArchive.validateAnnotation(command.annotation);
          const at = annotations.findIndex(item => item.id === incoming.id);
          if (at < 0 || annotations[at].deletedAt) {
            result = mediaPatchConflict(
              row,
              index,
              'This annotation was removed in another window. Reload its current state.'
            );
            return;
          }
          if (
            !Number.isFinite(Number(command.expectedUpdatedAt)) ||
            annotations[at].updatedAt !== Number(command.expectedUpdatedAt)
          ) {
            result = mediaPatchConflict(
              row,
              index,
              'This annotation changed in another window. Your text is still open; reload before saving.'
            );
            return;
          }
          annotations[at] = {
            ...annotations[at],
            ...incoming,
            createdAt: annotations[at].createdAt,
            updatedAt: now,
            position: annotations[at].position,
          };
          nextMeta.annotations = annotations;
        } else if (command.type === 'annotation-delete') {
          const at = annotations.findIndex(item => item.id === String(command.annotationId || ''));
          if (at < 0 || annotations[at].deletedAt) {
            result = { ok: true, row, unchanged: true };
            return;
          }
          if (
            !Number.isFinite(Number(command.expectedUpdatedAt)) ||
            annotations[at].updatedAt !== Number(command.expectedUpdatedAt)
          ) {
            result = mediaPatchConflict(
              row,
              index,
              'This annotation changed in another window and was not deleted. Reload before trying again.'
            );
            return;
          }
          annotations[at] = { ...annotations[at], deletedAt: now, updatedAt: now };
          nextMeta.annotations = annotations;
        } else if (command.type === 'annotation-restore') {
          const at = annotations.findIndex(item => item.id === String(command.annotationId || ''));
          if (at < 0 || !annotations[at].deletedAt) {
            result = { ok: true, row, unchanged: true };
            return;
          }
          if (
            !Number.isFinite(Number(command.expectedUpdatedAt)) ||
            annotations[at].updatedAt !== Number(command.expectedUpdatedAt)
          ) {
            result = mediaPatchConflict(
              row,
              index,
              'This annotation changed in another window and was not restored. Reload before trying again.'
            );
            return;
          }
          const { deletedAt, ...restored } = annotations[at];
          const lastPosition = annotations
            .filter((item, position) => position !== at && !item.deletedAt)
            .reduce((latest, item) => Math.max(latest, Number(item.position) || 0), -1);
          annotations[at] = { ...restored, position: lastPosition + 1, updatedAt: now };
          nextMeta.annotations = annotations;
        } else {
          const active = annotations
            .filter(item => !item.deletedAt)
            .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
          const ids = active.map(item => item.id);
          if (
            !Array.isArray(command.expectedOrder) ||
            command.expectedOrder.length !== ids.length ||
            command.expectedOrder.some((value, position) => String(value) !== ids[position])
          ) {
            result = mediaPatchConflict(
              row,
              index,
              'The annotation order changed in another window. Reload before reordering.'
            );
            return;
          }
          const at = ids.indexOf(String(command.annotationId || ''));
          const target = at + Math.sign(Number(command.delta) || 0);
          if (at < 0 || target < 0 || target >= active.length) {
            result = { ok: true, row, unchanged: true };
            return;
          }
          [active[at], active[target]] = [active[target], active[at]];
          const positions = new Map(active.map((item, position) => [item.id, position]));
          nextMeta.annotations = annotations.map(item =>
            positions.has(item.id) ? { ...item, position: positions.get(item.id) } : item
          );
        }
        const nextMedia = media.slice();
        nextMedia[index] = {
          ...media[index],
          xvault: { ...nextMeta, version: (Number(media[index].xvault?.version) || 0) + 1, updatedAt: now },
        };
        const next = { ...row, media: nextMedia, updatedAt: now };
        store.put(next);
        const bump = bumpLibraryRevision(tx);
        if (bump) {
          const success = bump.onsuccess;
          bump.onsuccess = event => {
            success?.call(bump, event);
            revision = Number(bump.result?.revision || 0) + 1;
          };
        }
        result = { ok: true, row: next };
      } catch (error) {
        failure = error;
        try {
          tx.abort();
        } catch {}
      }
    };
  });
}

function sidecarPlanFingerprint(plan) {
  const value = JSON.stringify(plan);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `xv1-${(hash >>> 0).toString(36)}-${value.length.toString(36)}`;
}

function recoveryCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(recoveryCanonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${recoveryCanonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function recoveryRowKey(store, value) {
  const field = store === 'revisions' ? 'key' : 'id';
  return String(value?.[field] ?? '');
}

function recoveryExpectedRevisions(value, explicitDownloadRevision = null) {
  if (value && typeof value === 'object')
    return {
      archive: value.archiveRevision ?? value.libraryRevision ?? null,
      downloads: value.downloadRevision ?? explicitDownloadRevision ?? null,
    };
  return { archive: value ?? null, downloads: explicitDownloadRevision };
}

function validRecoveryStore(database, store) {
  if (!RECOVERY_STORES.includes(store) || !database.objectStoreNames.contains(store === 'assets' ? 'downloads' : store))
    throw new TypeError(`Unsupported archive recovery store: ${store}`);
  if (store === 'assets' && !database.transaction('downloads').objectStore('downloads').indexNames.contains('stateKey'))
    throw new Error(
      'The completed-download lookup index is unavailable; reopen XVault to finish the recovery schema upgrade'
    );
}

function basenameFromPath(value) {
  return (
    String(value || '')
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.slice(0, 512) || ''
  );
}

function recoveryFileReference(row) {
  const sha = String(row?.sha256 || '').toLowerCase();
  return {
    id: String(row?.key || ''),
    postId: String(row?.item?.tweetId || ''),
    mediaId: String(row?.item?.mediaId || ''),
    filename: basenameFromPath(row?.target?.filename || row?.filename),
    size: Math.max(0, Math.floor(Number(row?.totalBytes || row?.target?.size) || 0)),
    mime: String(row?.target?.mime || row?.item?.mime || '').slice(0, 160),
    mediaType: String(row?.item?.logicalType || row?.item?.mediaType || '').slice(0, 64),
    sha256: /^[a-f0-9]{64}$/.test(sha) ? sha : '',
    verification: String(row?.verification?.state || row?.verificationState || '').slice(0, 48),
    completedAt: Math.max(0, Math.floor(Number(row?.completedAt || row?.updatedAt) || 0)),
  };
}

function classifyRecoveryAsset(incoming, evidence, download) {
  if (download) {
    if (download.state !== 'complete')
      return {
        status: 'conflict',
        reason: 'local-download-is-not-complete',
        current: { id: incoming.id, state: String(download.state || 'unknown') },
      };
    const local = recoveryFileReference(download);
    if (recoveryCanonical(local) === recoveryCanonical(incoming)) return { status: 'identical', current: local };
    return { status: 'conflict', reason: 'local-file-reference-diverges', current: local };
  }
  if (evidence?.kind === 'asset-reference') {
    if (recoveryCanonical(evidence.value) === recoveryCanonical(incoming))
      return { status: 'identical', current: evidence.value };
    return { status: 'conflict', reason: 'recovered-file-reference-diverges', current: evidence.value };
  }
  return { status: 'missing', current: null };
}

/** Read one sorted, primary-key page for a portable archive. */
export function readLibraryBackupPage(
  database,
  storeName,
  afterKey = null,
  requestedLimit = 100,
  expectedRevision = null
) {
  validRecoveryStore(database, storeName);
  const limit = Math.max(1, Math.min(250, Math.floor(Number(requestedLimit) || 100)));
  const sourceStoreName = storeName === 'assets' ? 'downloads' : storeName;
  const names = database.objectStoreNames.contains('checkpoints')
    ? [sourceStoreName, 'checkpoints']
    : [sourceStoreName];
  const expected = recoveryExpectedRevisions(expectedRevision);
  return new Promise((resolve, reject) => {
    const tx = database.transaction(names, 'readonly');
    const rows = [];
    let revision = 0,
      downloadRevision = 0,
      stale = false,
      cursorOperations = 0,
      recordsRead = 0,
      settled = false,
      pending = names.includes('checkpoints') ? 2 : 0;
    const finishStale = () => {
      if (settled) return;
      settled = true;
      try {
        tx.abort();
      } catch {}
      resolve({
        rows: [],
        stale: true,
        revision,
        downloadRevision,
        done: false,
        hasMore: true,
        nextKey: afterKey,
        recordsRead: 0,
        cursorOperations: 0,
      });
    };
    const start = () => {
      if (pending || settled) return;
      if (
        (expected.archive != null && revision !== Number(expected.archive)) ||
        (expected.downloads != null && downloadRevision !== Number(expected.downloads))
      ) {
        stale = true;
        finishStale();
        return;
      }
      const store = tx.objectStore(sourceStoreName);
      const request =
        storeName === 'assets'
          ? store
              .index('stateKey')
              .openCursor(
                afterKey == null
                  ? IDBKeyRange.lowerBound(['complete', ''])
                  : IDBKeyRange.lowerBound(['complete', String(afterKey)], true)
              )
          : store.openCursor(afterKey == null ? undefined : IDBKeyRange.lowerBound(afterKey, true));
      request.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (storeName === 'assets' && cursor.key[0] !== 'complete') return;
        cursorOperations++;
        if (rows.length < limit) {
          rows.push(storeName === 'assets' ? recoveryFileReference(cursor.value) : cursor.value);
          recordsRead++;
          cursor.continue();
          return;
        }
        // One bounded look-ahead tells the caller whether another page exists.
        recordsRead++;
      };
    };
    if (names.includes('checkpoints')) {
      const checkpoints = tx.objectStore('checkpoints');
      const request = checkpoints.get(LIBRARY_REVISION_KEY);
      request.onsuccess = () => {
        revision = Number(request.result?.revision || 0);
        pending--;
        start();
      };
      request.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
      const downloadsRequest = checkpoints.get(LIBRARY_DOWNLOAD_REVISION_KEY);
      downloadsRequest.onsuccess = () => {
        downloadRevision = Number(downloadsRequest.result?.revision || 0);
        pending--;
        start();
      };
      downloadsRequest.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
    } else start();
    tx.oncomplete = () => {
      if (settled) return;
      const hasMore = recordsRead > rows.length;
      resolve({
        rows,
        stale,
        revision,
        downloadRevision,
        done: !hasMore,
        hasMore,
        nextKey: rows.at(-1)?.[storeName === 'revisions' ? 'key' : 'id'] ?? afterKey,
        recordsRead,
        cursorOperations,
      });
    };
    tx.onabort = () => {
      if (settled) return;
      if (stale)
        resolve({
          rows: [],
          stale: true,
          revision,
          downloadRevision,
          done: false,
          hasMore: true,
          nextKey: afterKey,
          recordsRead: 0,
          cursorOperations: 0,
        });
      else reject(tx.error || new Error('Archive backup page aborted'));
    };
    tx.onerror = () => {
      if (!settled) reject(tx.error || new Error('Archive backup page failed'));
    };
  });
}

const recoveryAssetEvidenceKey = (importId, key) =>
  `asset:${encodeURIComponent(String(importId))}:${encodeURIComponent(String(key))}`;

function classifyRecoveryRows(store, incoming, current, opposite, download = null) {
  if (store === 'assets') return classifyRecoveryAsset(incoming, current, download);
  if (opposite)
    return {
      status: 'conflict',
      reason: store === 'tweets' ? 'exists-in-trash' : 'exists-in-library',
      current: opposite,
    };
  if (!current) return { status: 'missing', current: null };
  if (recoveryCanonical(current) === recoveryCanonical(incoming)) return { status: 'identical', current };
  return { status: 'conflict', reason: 'same-key-divergence', current };
}

function recoveryConflictSample(store, key, state) {
  const summarize = value => {
    if (!value) return null;
    if (store === 'assets')
      return {
        filename: String(value.filename || '').slice(0, 160),
        size: Math.max(0, Number(value.size) || 0),
        mediaId: String(value.mediaId || '').slice(0, 120),
        sha256: String(value.sha256 || '').slice(0, 64),
      };
    const meta = value.userMeta || {};
    return {
      text: String(value.text || '').slice(0, 220),
      note: String(meta.note || '').slice(0, 160),
      tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 4).map(tag => String(tag).slice(0, 64)) : [],
      mediaCount: Array.isArray(value.media) ? value.media.length : 0,
      archivedAt: Number(value.archivedAt) || null,
      deletedAt: Number(value.deletedAt) || null,
    };
  };
  return {
    store,
    key: String(key),
    reason: state.reason || 'same-key-divergence',
    existing: summarize(state.current),
    incoming: summarize(state.incoming),
  };
}

function validateRecoveryBatch(records, store = null) {
  if (!Array.isArray(records) || !records.length || records.length > 250)
    throw new RangeError('Archive recovery batches must contain 1–250 records');
  const actualStore = store || records[0]?.store;
  if (!RECOVERY_STORES.includes(actualStore)) throw new TypeError(`Unsupported archive recovery store: ${actualStore}`);
  let previous = null;
  for (const record of records) {
    if (
      record?.type !== 'record' ||
      record.store !== actualStore ||
      typeof record.key !== 'string' ||
      !record.key ||
      recoveryRowKey(actualStore, record.value) !== record.key
    )
      throw new TypeError('Archive recovery batch has a malformed primary key');
    if (
      actualStore === 'assets' &&
      (record.value.filename !== basenameFromPath(record.value.filename) ||
        record.value.filename === '.' ||
        record.value.filename === '..' ||
        !Number.isSafeInteger(Number(record.value.size)) ||
        Number(record.value.size) < 0 ||
        typeof record.value.postId !== 'string' ||
        record.value.postId.length > 32)
    )
      throw new TypeError('Recovery file manifest contains an invalid or machine-specific reference');
    if (previous != null && record.key <= previous)
      throw new TypeError('Archive recovery batch keys must be strictly increasing');
    previous = record.key;
  }
  return actualStore;
}

/** Compare one bounded batch against current live and Trash rows without mutation. */
export function previewArchiveImportBatch(
  database,
  records,
  expectedRevision,
  expectedDownloadRevision = null,
  importId = null
) {
  const storeName = validateRecoveryBatch(records);
  validRecoveryStore(database, storeName);
  if (storeName === 'assets' && (typeof importId !== 'string' || !importId))
    throw new TypeError('File-manifest previews require the source archive ID');
  const expected = recoveryExpectedRevisions(expectedRevision, expectedDownloadRevision);
  const targetName = storeName === 'assets' ? 'archiveImports' : storeName;
  const names = new Set([targetName, 'checkpoints']);
  if (storeName === 'assets') names.add('downloads');
  const oppositeName = storeName === 'tweets' ? 'trash' : storeName === 'trash' ? 'tweets' : null;
  if (oppositeName && database.objectStoreNames.contains(oppositeName)) names.add(oppositeName);
  return new Promise((resolve, reject) => {
    const tx = database.transaction(
      [...names].filter(name => database.objectStoreNames.contains(name)),
      'readonly'
    );
    const store = tx.objectStore(targetName),
      opposite = oppositeName && names.has(oppositeName) ? tx.objectStore(oppositeName) : null;
    const downloads = storeName === 'assets' ? tx.objectStore('downloads') : null;
    const rows = records.map(record => ({ record, current: undefined, opposite: undefined, download: undefined }));
    let revision = 0,
      downloadRevision = 0,
      pending = 2,
      stale = false,
      settled = false;
    const finish = () => {
      if (pending) return;
      if (
        (expected.archive != null && revision !== Number(expected.archive)) ||
        (expected.downloads != null && downloadRevision !== Number(expected.downloads))
      ) {
        stale = true;
        return;
      }
      const counts = { missing: 0, identical: 0, conflict: 0 },
        conflictSamples = [];
      for (const row of rows) {
        const state = classifyRecoveryRows(storeName, row.record.value, row.current, row.opposite, row.download);
        counts[state.status]++;
        if (state.status === 'conflict' && conflictSamples.length < 5)
          conflictSamples.push(
            recoveryConflictSample(storeName, row.record.key, { ...state, incoming: row.record.value })
          );
      }
      settled = true;
      resolve({ revision, downloadRevision, counts, conflictSamples, stale: false, scanned: records.length });
    };
    const revisionRequest = tx.objectStore('checkpoints').get(LIBRARY_REVISION_KEY);
    revisionRequest.onsuccess = () => {
      revision = Number(revisionRequest.result?.revision || 0);
      pending--;
      finish();
    };
    revisionRequest.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
    const downloadsRevisionRequest = tx.objectStore('checkpoints').get(LIBRARY_DOWNLOAD_REVISION_KEY);
    downloadsRevisionRequest.onsuccess = () => {
      downloadRevision = Number(downloadsRevisionRequest.result?.revision || 0);
      pending--;
      finish();
    };
    downloadsRevisionRequest.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
    for (const item of rows) {
      pending++;
      const request = store.get(
        storeName === 'assets' ? recoveryAssetEvidenceKey(importId, item.record.key) : item.record.key
      );
      request.onsuccess = () => {
        item.current = request.result || null;
        pending--;
        finish();
      };
      request.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
      if (downloads) {
        pending++;
        const downloadRequest = downloads.get(item.record.key);
        downloadRequest.onsuccess = () => {
          item.download = downloadRequest.result || null;
          pending--;
          finish();
        };
        downloadRequest.onerror = () => {
          try {
            tx.abort();
          } catch {}
        };
      }
      if (opposite) {
        pending++;
        const cross = opposite.get(item.record.key);
        cross.onsuccess = () => {
          item.opposite = cross.result || null;
          pending--;
          finish();
        };
        cross.onerror = () => {
          try {
            tx.abort();
          } catch {}
        };
      }
    }
    tx.oncomplete = () => {
      if (!settled) finish();
    };
    tx.onabort = () => {
      if (settled) return;
      if (stale)
        resolve({
          stale: true,
          revision,
          downloadRevision,
          counts: { missing: 0, identical: 0, conflict: 0 },
          scanned: 0,
        });
      else reject(tx.error || new Error('Archive import preview aborted'));
    };
    tx.onerror = () => {
      if (!settled) reject(tx.error || new Error('Archive import preview failed'));
    };
  });
}

const archiveImportJobKey = id => `job:${String(id)}`;
const ARCHIVE_IMPORT_REVISION_KEY = LIBRARY_REVISION_KEY;

/** Start or resume only when both the file identity and local revision still match. */
export function beginArchiveImport(
  database,
  { jobId, importId, fingerprint, expectedRevision, expectedDownloadRevision = 0, header = {} } = {}
) {
  if (!database.objectStoreNames.contains('archiveImports'))
    throw new Error(
      'Archive recovery requires the current database schema; reopen XVault to finish its non-destructive upgrade'
    );
  if (
    typeof jobId !== 'string' ||
    !jobId ||
    jobId.length > 256 ||
    typeof importId !== 'string' ||
    !importId ||
    typeof fingerprint !== 'string' ||
    !fingerprint
  )
    throw new TypeError('Archive import identity is invalid');
  return new Promise((resolve, reject) => {
    const names = database.objectStoreNames.contains('checkpoints')
      ? ['archiveImports', 'checkpoints']
      : ['archiveImports'];
    const tx = database.transaction(names, 'readwrite'),
      imports = tx.objectStore('archiveImports');
    const id = archiveImportJobKey(jobId);
    let revision = 0,
      downloadRevision = 0,
      existing = null,
      pending = 0,
      result = null;
    const finish = () => {
      if (pending) return;
      if (revision !== Number(expectedRevision) || downloadRevision !== Number(expectedDownloadRevision)) {
        result = {
          ok: false,
          stale: true,
          revision,
          downloadRevision,
          error: 'The archive or file manifest changed after this preview. Review the conflicts again before resuming.',
        };
        return;
      }
      if (existing && (existing.fingerprint !== fingerprint || existing.importId !== importId)) {
        result = {
          ok: false,
          stale: true,
          revision,
          error: 'This recovery checkpoint belongs to a different file. Start a fresh preview.',
        };
        return;
      }
      const resumed = !!existing;
      const job = existing
        ? {
            ...existing,
            header: {
              ...existing.header,
              archiveRevision: Number.isSafeInteger(existing.header?.archiveRevision)
                ? existing.header.archiveRevision
                : header.archiveRevision,
              downloadRevision: Number.isSafeInteger(existing.header?.downloadRevision)
                ? existing.header.downloadRevision
                : header.downloadRevision,
            },
          }
        : {
            id,
            jobId,
            kind: 'job',
            importId,
            fingerprint,
            header: {
              archiveId: header.archiveId,
              exportedAt: header.exportedAt,
              archiveRevision: header.archiveRevision,
              downloadRevision: header.downloadRevision,
            },
            createdAt: Date.now(),
            updatedAt: Date.now(),
            status: 'in-progress',
            expectedRevision: revision,
            expectedDownloadRevision: downloadRevision,
            storeIndex: -1,
            lastKey: null,
            recordCount: 0,
            importedCount: 0,
            identicalCount: 0,
            conflictCount: 0,
          };
      if (!resumed) imports.add(job);
      else if (
        !Number.isSafeInteger(existing.header?.archiveRevision) ||
        !Number.isSafeInteger(existing.header?.downloadRevision)
      )
        imports.put(job);
      result = { ok: true, resumed, job: structuredClone(job), revision, downloadRevision };
    };
    if (names.includes('checkpoints')) {
      pending += 2;
      const checkpoints = tx.objectStore('checkpoints');
      const request = checkpoints.get(ARCHIVE_IMPORT_REVISION_KEY);
      request.onsuccess = () => {
        revision = Number(request.result?.revision || 0);
        pending--;
        finish();
      };
      request.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
      const downloadRequest = checkpoints.get(LIBRARY_DOWNLOAD_REVISION_KEY);
      downloadRequest.onsuccess = () => {
        downloadRevision = Number(downloadRequest.result?.revision || 0);
        pending--;
        finish();
      };
      downloadRequest.onerror = () => {
        try {
          tx.abort();
        } catch {}
      };
    }
    pending++;
    const jobRequest = imports.get(id);
    jobRequest.onsuccess = () => {
      existing = jobRequest.result || null;
      pending--;
      finish();
    };
    jobRequest.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
    tx.oncomplete = () => resolve(result || { ok: false, error: 'Archive import checkpoint could not be created' });
    tx.onabort = () => reject(tx.error || new Error('Archive import checkpoint aborted'));
    tx.onerror = () => reject(tx.error || new Error('Archive import checkpoint failed'));
  });
}

function archiveConflictDigest(store, key, current, incoming) {
  const text = `${store}\n${key}\n${recoveryCanonical(current)}\n${recoveryCanonical(incoming)}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

/** Commit a single resumable batch. Inserts, conflict evidence, progress and query revision are atomic. */
export function commitArchiveImportBatch(
  database,
  { jobId, importId, fingerprint, store: requestedStore, records, expectedRevision, expectedDownloadRevision = 0 } = {}
) {
  const storeName = validateRecoveryBatch(records, requestedStore);
  validRecoveryStore(database, storeName);
  if (!database.objectStoreNames.contains('archiveImports') || !database.objectStoreNames.contains('checkpoints'))
    throw new Error(
      'Archive recovery requires the current database schema; reopen XVault to finish its non-destructive upgrade'
    );
  const storeIndex = RECOVERY_STORES.indexOf(storeName);
  const targetName = storeName === 'assets' ? 'archiveImports' : storeName;
  const oppositeName = storeName === 'tweets' ? 'trash' : storeName === 'trash' ? 'tweets' : null;
  const names = new Set([targetName, 'archiveImports', 'checkpoints']);
  if (storeName === 'assets') names.add('downloads');
  if (oppositeName && database.objectStoreNames.contains(oppositeName)) names.add(oppositeName);
  return new Promise((resolve, reject) => {
    const tx = database.transaction([...names], 'readwrite'),
      target = tx.objectStore(targetName),
      imports = tx.objectStore('archiveImports');
    const opposite = oppositeName && names.has(oppositeName) ? tx.objectStore(oppositeName) : null;
    const downloads = storeName === 'assets' ? tx.objectStore('downloads') : null;
    const jobKey = archiveImportJobKey(jobId);
    let job = null,
      revision = 0,
      downloadRevision = 0,
      pending = 3,
      stale = false,
      failure = null,
      result = null,
      bumped = false,
      imported = 0,
      identical = 0,
      conflicts = 0;
    const rows = records.map(record => ({ record, current: undefined, opposite: undefined, download: undefined }));
    let lookedUp = false;
    const finishLookups = () => {
      if (pending || lookedUp) return;
      lookedUp = true;
      if (
        !job ||
        job.kind !== 'job' ||
        job.importId !== importId ||
        job.fingerprint !== fingerprint ||
        job.expectedRevision !== Number(expectedRevision) ||
        revision !== Number(expectedRevision) ||
        job.expectedDownloadRevision !== Number(expectedDownloadRevision) ||
        downloadRevision !== Number(expectedDownloadRevision)
      ) {
        stale = true;
        result = {
          ok: false,
          stale: true,
          revision,
          downloadRevision,
          error:
            'The archive or file manifest changed since this preview or resume checkpoint. The batch was not applied.',
        };
        return;
      }
      if (job.status === 'complete') {
        result = { ok: true, complete: true, job, revision };
        return;
      }
      if (
        storeIndex < job.storeIndex ||
        (storeIndex === job.storeIndex && job.lastKey != null && records[0].key <= job.lastKey)
      ) {
        stale = true;
        result = {
          ok: false,
          stale: true,
          revision,
          error: 'This recovery batch overlaps the saved checkpoint. Review the file and resume position.',
        };
        return;
      }
      const time = Date.now();
      for (const row of rows) {
        const state = classifyRecoveryRows(storeName, row.record.value, row.current, row.opposite, row.download);
        if (state.status === 'identical') {
          identical++;
          continue;
        }
        if (state.status === 'conflict') {
          conflicts++;
          const id = `conflict:${jobId}:${archiveConflictDigest(storeName, row.record.key, state.current, row.record.value)}`;
          imports.put({
            id,
            kind: 'conflict',
            importId,
            at: time,
            store: storeName,
            recordKey: row.record.key,
            reason: state.reason,
            existing: state.current,
            incoming: row.record.value,
          });
          continue;
        }
        if (storeName === 'assets')
          target.add({
            id: recoveryAssetEvidenceKey(importId, row.record.key),
            kind: 'asset-reference',
            importId,
            assetKey: row.record.key,
            at: time,
            value: row.record.value,
          });
        else target.add(row.record.value);
        imported++;
      }
      job = {
        ...job,
        updatedAt: time,
        status: 'in-progress',
        storeIndex,
        lastKey: records.at(-1).key,
        expectedDownloadRevision: downloadRevision,
        recordCount: Number(job.recordCount || 0) + records.length,
        importedCount: Number(job.importedCount || 0) + imported,
        identicalCount: Number(job.identicalCount || 0) + identical,
        conflictCount: Number(job.conflictCount || 0) + conflicts,
        assetReferenceCount: Number(job.assetReferenceCount || 0) + (storeName === 'assets' ? imported : 0),
      };
      if (imported && ['tweets', 'trash', 'revisions'].includes(storeName)) {
        bumped = true;
        const request = bumpLibraryRevision(tx);
        if (request) {
          const original = request.onsuccess;
          request.onsuccess = event => {
            original?.call(request, event);
            revision = Number(request.result?.revision || 0) + 1;
            job.expectedRevision = revision;
            imports.put(job);
            result = {
              ok: true,
              imported,
              identical,
              conflicts,
              revision,
              downloadRevision,
              job: structuredClone(job),
              changedIds: ['tweets', 'trash'].includes(storeName)
                ? rows
                    .filter(row => !row.current && !row.opposite)
                    .map(row => row.record.key)
                    .slice(0, 100)
                : [],
            };
          };
        } else {
          imports.put(job);
          result = {
            ok: true,
            imported,
            identical,
            conflicts,
            revision,
            downloadRevision,
            job: structuredClone(job),
            changedIds: ['tweets', 'trash'].includes(storeName)
              ? rows
                  .filter(row => !row.current && !row.opposite)
                  .map(row => row.record.key)
                  .slice(0, 100)
              : [],
          };
        }
      } else {
        imports.put(job);
        result = {
          ok: true,
          imported,
          identical,
          conflicts,
          revision,
          downloadRevision,
          job: structuredClone(job),
          changedIds: [],
        };
      }
    };
    const revisionRequest = tx.objectStore('checkpoints').get(LIBRARY_REVISION_KEY);
    revisionRequest.onsuccess = () => {
      revision = Number(revisionRequest.result?.revision || 0);
      pending--;
      finishLookups();
    };
    revisionRequest.onerror = () => {
      failure = revisionRequest.error;
      try {
        tx.abort();
      } catch {}
    };
    const downloadRevisionRequest = tx.objectStore('checkpoints').get(LIBRARY_DOWNLOAD_REVISION_KEY);
    downloadRevisionRequest.onsuccess = () => {
      downloadRevision = Number(downloadRevisionRequest.result?.revision || 0);
      pending--;
      finishLookups();
    };
    downloadRevisionRequest.onerror = () => {
      failure = downloadRevisionRequest.error;
      try {
        tx.abort();
      } catch {}
    };
    const jobRequest = imports.get(jobKey);
    jobRequest.onsuccess = () => {
      job = jobRequest.result || null;
      pending--;
      finishLookups();
    };
    jobRequest.onerror = () => {
      failure = jobRequest.error;
      try {
        tx.abort();
      } catch {}
    };
    for (const row of rows) {
      pending++;
      const request = target.get(storeName === 'assets' ? recoveryAssetEvidenceKey(row.record.key) : row.record.key);
      request.onsuccess = () => {
        row.current = request.result || null;
        pending--;
        finishLookups();
      };
      request.onerror = () => {
        failure = request.error;
        try {
          tx.abort();
        } catch {}
      };
      if (downloads) {
        pending++;
        const assetRequest = downloads.get(row.record.key);
        assetRequest.onsuccess = () => {
          row.download = assetRequest.result || null;
          pending--;
          finishLookups();
        };
        assetRequest.onerror = () => {
          failure = assetRequest.error;
          try {
            tx.abort();
          } catch {}
        };
      }
      if (opposite) {
        pending++;
        const cross = opposite.get(row.record.key);
        cross.onsuccess = () => {
          row.opposite = cross.result || null;
          pending--;
          finishLookups();
        };
        cross.onerror = () => {
          failure = cross.error;
          try {
            tx.abort();
          } catch {}
        };
      }
    }
    tx.oncomplete = () => {
      if (result?.ok && result.imported && ['tweets', 'trash'].includes(storeName))
        result.changedIds = rows
          .filter(row => !row.current && !row.opposite)
          .map(row => row.record.key)
          .slice(0, 100);
      resolve(
        result || {
          ok: false,
          stale,
          revision,
          imported,
          identical,
          conflicts,
          error: 'Archive recovery batch did not run',
        }
      );
    };
    tx.onabort = () =>
      reject(failure || tx.error || new Error('Archive recovery batch aborted; no partial batch was applied'));
    tx.onerror = () => {
      if (!failure) reject(tx.error || new Error('Archive recovery batch failed'));
    };
  });
}

export function getArchiveImportJob(database, jobId) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('archiveImports', 'readonly');
    const request = tx.objectStore('archiveImports').get(archiveImportJobKey(jobId));
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Archive import checkpoint read failed'));
    tx.onabort = () => reject(tx.error || new Error('Archive import checkpoint read aborted'));
  });
}

export function findArchiveImportJob(database, importId, fingerprint) {
  if (!database.objectStoreNames.contains('archiveImports')) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const tx = database.transaction('archiveImports', 'readonly');
    const index = tx.objectStore('archiveImports').index('importFingerprint');
    const request = index.openCursor(globalThis.IDBKeyRange.only([String(importId), String(fingerprint)]));
    let latest = null;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value.kind === 'job' && (!latest || Number(cursor.value.updatedAt) > Number(latest.updatedAt)))
        latest = cursor.value;
      cursor.continue();
    };
    request.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
    tx.oncomplete = () => resolve(latest);
    tx.onabort = () => reject(tx.error || new Error('Archive import lookup aborted'));
    tx.onerror = () => reject(tx.error || new Error('Archive import lookup failed'));
  });
}

export function completeArchiveImport(
  database,
  jobId,
  fingerprint,
  expectedRevision,
  expectedDownloadRevision = 0,
  footer = null
) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['archiveImports', 'checkpoints'], 'readwrite'),
      imports = tx.objectStore('archiveImports');
    const jobRequest = imports.get(archiveImportJobKey(jobId)),
      checkpoints = tx.objectStore('checkpoints'),
      revisionRequest = checkpoints.get(LIBRARY_REVISION_KEY),
      downloadRevisionRequest = checkpoints.get(LIBRARY_DOWNLOAD_REVISION_KEY);
    let job = null,
      revision = 0,
      downloadRevision = 0,
      pending = 3,
      result = null;
    const finish = () => {
      if (pending) return;
      if (
        !job ||
        job.kind !== 'job' ||
        job.fingerprint !== fingerprint ||
        job.expectedRevision !== Number(expectedRevision) ||
        revision !== Number(expectedRevision) ||
        job.expectedDownloadRevision !== Number(expectedDownloadRevision) ||
        downloadRevision !== Number(expectedDownloadRevision)
      ) {
        result = {
          ok: false,
          stale: true,
          revision,
          downloadRevision,
          error:
            'The archive or file manifest changed before this restore finished. Review the file again before resuming.',
        };
        return;
      }
      if (job.status === 'complete') {
        result = { ok: true, revision, downloadRevision, job };
        return;
      }
      if (
        footer?.type !== 'end' ||
        footer.recordCount !== job.recordCount ||
        footer.archiveRevision !== job.header?.archiveRevision ||
        footer.downloadRevision !== job.header?.downloadRevision
      ) {
        result = {
          ok: false,
          error:
            'The recovery footer does not match the checked file and committed batches. The import remains resumable.',
        };
        return;
      }
      job = { ...job, status: 'complete', completedAt: Date.now(), updatedAt: Date.now(), footer };
      imports.put(job);
      result = { ok: true, revision, downloadRevision, job: structuredClone(job) };
    };
    jobRequest.onsuccess = () => {
      job = jobRequest.result || null;
      pending--;
      finish();
    };
    revisionRequest.onsuccess = () => {
      revision = Number(revisionRequest.result?.revision || 0);
      pending--;
      finish();
    };
    downloadRevisionRequest.onsuccess = () => {
      downloadRevision = Number(downloadRevisionRequest.result?.revision || 0);
      pending--;
      finish();
    };
    jobRequest.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
    revisionRequest.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
    downloadRevisionRequest.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
    tx.oncomplete = () => resolve(result || { ok: false, error: 'Archive restore completion could not be saved' });
    tx.onabort = () => reject(tx.error || new Error('Archive restore completion aborted'));
    tx.onerror = () => reject(tx.error || new Error('Archive restore completion failed'));
  });
}

export function readArchiveImportConflicts(database, importId, afterKey = null, requestedLimit = 50) {
  if (!database.objectStoreNames.contains('archiveImports'))
    return Promise.resolve({ rows: [], nextKey: null, done: true });
  const limit = Math.max(1, Math.min(200, Math.floor(Number(requestedLimit) || 50)));
  return new Promise((resolve, reject) => {
    const tx = database.transaction('archiveImports', 'readonly'),
      index = tx.objectStore('archiveImports').index('importKindKey');
    const rows = [];
    let nextKey = afterKey,
      hasMore = false,
      recordsRead = 0,
      cursorOperations = 0;
    const lower = [String(importId), 'conflict', afterKey == null ? '' : String(afterKey)];
    const request = index.openCursor(globalThis.IDBKeyRange.lowerBound(lower, afterKey != null));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursorOperations++;
      if (cursor.key[0] !== String(importId) || cursor.key[1] !== 'conflict') return;
      recordsRead++;
      if (rows.length === limit) {
        hasMore = true;
        return;
      }
      rows.push(cursor.value);
      nextKey = cursor.primaryKey;
      cursor.continue();
    };
    request.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
    tx.oncomplete = () => resolve({ rows, nextKey, done: !hasMore, hasMore, recordsRead, cursorOperations });
    tx.onabort = () => reject(tx.error || new Error('Archive import conflict read aborted'));
    tx.onerror = () => reject(tx.error || new Error('Archive import conflict read failed'));
  });
}

export function readArchiveAssetReferences(database, importId, afterKey = null, requestedLimit = 100) {
  if (!database.objectStoreNames.contains('archiveImports'))
    return Promise.resolve({ rows: [], nextKey: null, done: true });
  const limit = Math.max(1, Math.min(250, Math.floor(Number(requestedLimit) || 100)));
  return new Promise((resolve, reject) => {
    const tx = database.transaction('archiveImports', 'readonly'),
      index = tx.objectStore('archiveImports').index('importKindKey');
    const rows = [];
    let nextKey = afterKey,
      hasMore = false,
      recordsRead = 0,
      cursorOperations = 0;
    const lower = [String(importId), 'asset-reference', afterKey == null ? '' : String(afterKey)];
    const request = index.openCursor(globalThis.IDBKeyRange.lowerBound(lower, afterKey != null));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursorOperations++;
      if (cursor.key[0] !== String(importId) || cursor.key[1] !== 'asset-reference') return;
      recordsRead++;
      if (rows.length === limit) {
        hasMore = true;
        return;
      }
      rows.push(cursor.value.value);
      nextKey = cursor.primaryKey;
      cursor.continue();
    };
    request.onerror = () => {
      try {
        tx.abort();
      } catch {}
    };
    tx.oncomplete = () => resolve({ rows, nextKey, done: !hasMore, hasMore, recordsRead, cursorOperations });
    tx.onabort = () => reject(tx.error || new Error('Archive file-manifest read aborted'));
    tx.onerror = () => reject(tx.error || new Error('Archive file-manifest read failed'));
  });
}

export function previewLibraryMediaSidecar(database, sidecar) {
  mediaArchive.validateSidecar(sidecar);
  const id = String(sidecar.post.id);
  return new Promise((resolve, reject) => {
    const names = ['tweets', 'trash', 'checkpoints'].filter(name => database.objectStoreNames.contains(name));
    const tx = database.transaction(names, 'readonly');
    let row = null,
      trashed = null,
      revision = 0,
      gotRow = false,
      gotTrash = !names.includes('trash'),
      gotRevision = !names.includes('checkpoints'),
      resolved = false;
    const finish = () => {
      if (resolved || !gotRow || !gotTrash || !gotRevision) return;
      resolved = true;
      const plan = mediaArchive.planSidecarImport(row, sidecar, !row && !!trashed);
      resolve({ ...plan, revision, planId: sidecarPlanFingerprint(plan) });
    };
    const postRequest = tx.objectStore('tweets').get(id);
    postRequest.onsuccess = () => {
      row = postRequest.result || null;
      gotRow = true;
      finish();
    };
    postRequest.onerror = () => {
      reject(postRequest.error || new Error('Sidecar preview could not read the archive'));
      try {
        tx.abort();
      } catch {}
    };
    if (names.includes('trash')) {
      const trashRequest = tx.objectStore('trash').get(id);
      trashRequest.onsuccess = () => {
        trashed = trashRequest.result || null;
        gotTrash = true;
        finish();
      };
      trashRequest.onerror = () => {
        reject(trashRequest.error || new Error('Sidecar preview could not inspect Trash'));
        try {
          tx.abort();
        } catch {}
      };
    } else trashed = null;
    if (names.includes('checkpoints')) {
      const revisionRequest = tx.objectStore('checkpoints').get(LIBRARY_REVISION_KEY);
      revisionRequest.onsuccess = () => {
        revision = Number(revisionRequest.result?.revision) || 0;
        gotRevision = true;
        finish();
      };
      revisionRequest.onerror = () => {
        reject(revisionRequest.error || new Error('Sidecar preview could not read the archive revision'));
        try {
          tx.abort();
        } catch {}
      };
    }
    tx.onabort = () => reject(tx.error || new Error('Sidecar preview aborted'));
    tx.onerror = () => reject(tx.error || new Error('Sidecar preview failed'));
  });
}

export function importLibraryMediaSidecar(database, sidecar, now = Date.now(), expectedRevision, expectedPlanId) {
  mediaArchive.validateSidecar(sidecar);
  if (
    !Number.isSafeInteger(Number(expectedRevision)) ||
    Number(expectedRevision) < 0 ||
    typeof expectedPlanId !== 'string' ||
    !expectedPlanId
  )
    throw new TypeError('Sidecar import requires a current conflict preview');
  const id = String(sidecar.post.id);
  return new Promise((resolve, reject) => {
    const names = ['tweets', 'trash', 'checkpoints'].filter(name => database.objectStoreNames.contains(name));
    const tx = database.transaction(names, 'readwrite');
    const tweets = tx.objectStore('tweets'),
      trash = names.includes('trash') ? tx.objectStore('trash') : null;
    let current = null,
      removed = null,
      currentRevision = 0,
      gotCurrent = false,
      gotRemoved = !trash,
      gotRevision = !names.includes('checkpoints'),
      settled = false,
      revision = null,
      failure = null;
    let result = { ok: false, error: 'Sidecar import did not run' };
    const finish = () => {
      if (settled || !gotCurrent || !gotRemoved || !gotRevision) return;
      settled = true;
      try {
        if (currentRevision !== Number(expectedRevision)) {
          result = {
            ok: false,
            stale: true,
            error: 'The archive changed after this preview. Review the updated sidecar conflicts before importing.',
          };
          return;
        }
        const preview = mediaArchive.planSidecarImport(current, sidecar, !current && !!removed);
        if (sidecarPlanFingerprint(preview) !== expectedPlanId) {
          result = {
            ok: false,
            stale: true,
            error:
              'The sidecar conflict preview no longer matches the current archive. Review it again before importing.',
          };
          return;
        }
        if (preview.action === 'trashed') {
          result = {
            ok: false,
            action: 'trashed',
            error: 'This post is in Trash. Restore or resolve it there before importing a sidecar.',
          };
          return;
        }
        const merged = mediaArchive.applySidecarImport(current, sidecar, now, false);
        if (merged.action === 'already-imported') {
          result = { ok: true, action: merged.action, row: current, conflicts: [], safeChanges: 0, orphans: [] };
          return;
        }
        tweets.put(merged.row);
        const bump = names.includes('checkpoints') ? bumpLibraryRevision(tx) : null;
        if (bump) {
          const success = bump.onsuccess;
          bump.onsuccess = event => {
            success?.call(bump, event);
            revision = Number(bump.result?.revision || 0) + 1;
          };
        }
        result = {
          ok: true,
          action: merged.action,
          row: merged.row,
          conflicts: merged.conflicts,
          safeChanges: merged.safeChanges,
          orphans: merged.orphans,
        };
      } catch (error) {
        failure = error;
        try {
          tx.abort();
        } catch {}
      }
    };
    const postRequest = tweets.get(id);
    postRequest.onsuccess = () => {
      current = postRequest.result || null;
      gotCurrent = true;
      finish();
    };
    postRequest.onerror = () => {
      failure = postRequest.error || new Error('Sidecar import could not read the archive');
      try {
        tx.abort();
      } catch {}
    };
    if (trash) {
      const trashRequest = trash.get(id);
      trashRequest.onsuccess = () => {
        removed = trashRequest.result || null;
        gotRemoved = true;
        finish();
      };
      trashRequest.onerror = () => {
        failure = trashRequest.error || new Error('Sidecar import could not inspect Trash');
        try {
          tx.abort();
        } catch {}
      };
    }
    if (names.includes('checkpoints')) {
      const revisionRequest = tx.objectStore('checkpoints').get(LIBRARY_REVISION_KEY);
      revisionRequest.onsuccess = () => {
        currentRevision = Number(revisionRequest.result?.revision) || 0;
        gotRevision = true;
        finish();
      };
      revisionRequest.onerror = () => {
        failure = revisionRequest.error || new Error('Sidecar import could not validate its preview revision');
        try {
          tx.abort();
        } catch {}
      };
    }
    tx.oncomplete = () => resolve({ ...result, ...(revision == null ? {} : { revision }) });
    tx.onabort = () =>
      reject(failure || tx.error || new Error('Sidecar import aborted; no partial archive change was applied'));
    tx.onerror = () => reject(failure || tx.error || new Error('Sidecar import failed'));
  });
}

const UNDO_KEY = 'library-trash-undo';
export function mergeLibraryCapture(database, snapshot, merge = null) {
  return new Promise((resolve, reject) => {
    const names = ['tweets', 'trash'];
    for (const name of ['checkpoints', 'revisions']) if (database.objectStoreNames.contains(name)) names.push(name);
    const tx = database.transaction(names, 'readwrite'),
      store = tx.objectStore('tweets');
    let result = { stored: false };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('Capture update aborted'));
    tx.onerror = () => reject(tx.error || new Error('Capture update failed'));
    const request = store.get(String(snapshot.id));
    request.onsuccess = () => {
      // Capture/revision preparation may have yielded since its earlier read.
      // Current personal metadata wins over that stale capture snapshot.
      const write = () => {
        let next = merge
          ? merge(request.result || null, snapshot)
          : { ...snapshot, userMeta: request.result ? request.result.userMeta || {} : snapshot.userMeta || {} };
        let revision = null;
        if (next && typeof next === 'object' && Object.hasOwn(next, 'row')) {
          revision = next.revision || null;
          next = next.row;
        }
        store.put({ ...next, userMeta: request.result ? request.result.userMeta || {} : next.userMeta || {} });
        if (revision && tx.objectStoreNames.contains('revisions')) tx.objectStore('revisions').put(revision);
        const revisionRequest = bumpLibraryRevision(tx);
        if (revisionRequest)
          revisionRequest.onsuccess = () => {
            const value = Number(revisionRequest.result?.revision || 0) + 1;
            result = { stored: true, revision: value, row: next, changed: !!request.result };
          };
        else result = { stored: true, row: next, changed: !!request.result };
      };
      if (request.result) {
        write();
        return;
      }
      // A capture prepared before removal must not silently resurrect the post.
      const removed = tx.objectStore('trash').get(String(snapshot.id));
      removed.onsuccess = () => {
        if (removed.result) result = { stored: false, trashed: true };
        else write();
      };
    };
  });
}

export function readTrashUndo(database) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['checkpoints', 'trash']);
    let ids = [],
      total = 0;
    const request = tx.objectStore('checkpoints').get(UNDO_KEY);
    request.onsuccess = () => {
      ids = (request.result?.ids || []).slice(-1000);
    };
    tx.objectStore('trash').count().onsuccess = event => {
      total = event.target.result;
    };
    tx.oncomplete = () => resolve({ ids, limited: total > ids.length, total });
    tx.onabort = () => reject(tx.error || new Error('Undo read aborted'));
    tx.onerror = () => reject(tx.error || new Error('Undo read failed'));
    request.onerror = () => reject(request.error);
  });
}

// Only one bounded page crosses the message boundary. Conflict evidence is
// read in the same snapshot as Trash, never inferred from dashboard memory.
export function readTrashPage(database, afterKey, requestedLimit = 100, query = '') {
  const limit = Math.max(1, Math.min(100, Math.floor(Number(requestedLimit) || 100)));
  const terms = String(query).slice(0, 1000).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return new Promise((resolve, reject) => {
    const tx = database.transaction(['trash', 'tweets']),
      trash = tx.objectStore('trash');
    const rows = [];
    let total = 0,
      done = true,
      nextKey = afterKey ?? null,
      scanned = 0;
    tx.oncomplete = () => resolve({ rows, total, done, nextKey, scanned });
    tx.onabort = () => reject(tx.error || new Error('Trash read aborted'));
    tx.onerror = () => reject(tx.error || new Error('Trash read failed'));
    trash.count().onsuccess = event => {
      total = event.target.result;
    };
    const chronological = trash.indexNames.contains('deletedAt');
    const range =
      afterKey == null ? null : IDBKeyRange.upperBound(chronological ? afterKey.deletedAt : afterKey, !chronological);
    const request = (chronological ? trash.index('deletedAt') : trash).openCursor(range, 'prev');
    const summary = row => ({
      id: row.id,
      text: row.text || '',
      author: row.author || {},
      url: row.url || '',
      deletedAt: row.deletedAt,
      archivedAt: row.archivedAt,
      userMeta: row.userMeta || {},
      mediaCount: row.media?.length || 0,
    });
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (
        chronological &&
        afterKey &&
        cursor.key === afterKey.deletedAt &&
        indexedDB.cmp(cursor.primaryKey, afterKey.id) >= 0
      ) {
        cursor.continue();
        return;
      }
      if (rows.length >= limit || scanned >= 1000) {
        done = false;
        return;
      }
      scanned++;
      nextKey = chronological ? { deletedAt: cursor.key, id: cursor.primaryKey } : cursor.key;
      const source = cursor.value;
      if (terms.length) {
        const haystack = [
          source.id,
          source.text,
          source.author?.handle,
          source.author?.name,
          source.userMeta?.note,
          ...(source.userMeta?.tags || []),
        ]
          .join(' ')
          .toLocaleLowerCase();
        if (!terms.every(term => haystack.includes(term))) {
          cursor.continue();
          return;
        }
      }
      const row = summary(cursor.value);
      rows.push(row);
      const current = tx.objectStore('tweets').get(cursor.primaryKey);
      current.onsuccess = () => {
        row.conflict = !!current.result;
        if (current.result) row.current = summary(current.result);
      };
      cursor.continue();
    };
  });
}

// Recovery enriches the current copy; the older evidence is never retired.
// Compare both notes in the same transaction to reject stale previews.
export function mergeTrashMetadata(database, id, options = {}) {
  const [key] = mutationIds([id]);
  if (!['append-note', 'tags'].includes(options.mode)) throw new TypeError('Choose a recovery merge mode');
  return new Promise((resolve, reject) => {
    const names = ['tweets', 'trash'];
    if (database.objectStoreNames.contains('checkpoints')) names.push('checkpoints');
    const tx = database.transaction(names, 'readwrite');
    let result = { ok: false, error: 'Both copies must still exist' };
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('Recovery merge aborted'));
    tx.onerror = () => reject(tx.error || new Error('Recovery merge failed'));
    const currentRequest = tx.objectStore('tweets').get(key);
    currentRequest.onsuccess = () => {
      const current = currentRequest.result;
      const oldRequest = tx.objectStore('trash').get(key);
      oldRequest.onsuccess = () => {
        const old = oldRequest.result;
        if (!current || !old) return;
        const note = current.userMeta?.note || '',
          older = old.userMeta?.note || '';
        if (note !== options.expectedNote || older !== options.expectedTrashNote) {
          result = {
            ok: false,
            conflict: true,
            error: 'A note changed since this comparison. Reload and review both copies again.',
          };
          return;
        }
        const suffix = `\n\n[Recovered from Trash]\n${older}`;
        const mergedNote =
          options.mode === 'append-note' && older && note !== older && !note.endsWith(suffix)
            ? note
              ? note + suffix
              : older
            : note;
        if (mergedNote.length > 100000) {
          result = { ok: false, error: 'Combined note is too large. Export the older copy first.' };
          return;
        }
        const row = {
          ...current,
          updatedAt: Date.now(),
          userMeta: {
            ...(current.userMeta || {}),
            note: mergedNote,
            tags: [...new Set([...(current.userMeta?.tags || []), ...(old.userMeta?.tags || [])])],
          },
        };
        tx.objectStore('tweets').put(row);
        bumpLibraryRevision(tx);
        result = { ok: true, row };
      };
    };
  });
}

export function updateLibraryMetadata(database, ids, patch = {}) {
  const wanted = mutationIds(ids);
  return new Promise((resolve, reject) => {
    const names = database.objectStoreNames.contains('checkpoints') ? ['tweets', 'checkpoints'] : ['tweets'];
    const tx = database.transaction(names, 'readwrite'),
      store = tx.objectStore('tweets'),
      rows = [];
    let revisionQueued = false;
    tx.oncomplete = () => resolve({ updated: rows.length, rows });
    tx.onabort = () => reject(tx.error || new Error('Library update aborted; this batch was not applied'));
    tx.onerror = () => reject(tx.error || new Error('Library update failed'));
    for (const id of wanted) {
      const request = store.get(id);
      request.onsuccess = () => {
        const row = request.result;
        if (!row) return;
        const meta = { ...(row.userMeta || {}) };
        if (typeof patch.favorite === 'boolean') meta.favorite = patch.favorite;
        if (typeof patch.colorLabel === 'string') meta.colorLabel = patch.colorLabel.slice(0, 24);
        if (typeof patch.reviewed === 'boolean') {
          if (patch.reviewed) meta.reviewedAt = Date.now();
          else delete meta.reviewedAt;
        }
        if (typeof patch.removeTag === 'string' && meta.tags?.length)
          meta.tags = meta.tags.filter(tag => tag !== patch.removeTag.trim().replace(/^#/, ''));
        const tag = typeof patch.addTag === 'string' ? patch.addTag.trim().replace(/^#/, '').trim().slice(0, 40) : '';
        if (tag) meta.tags = [...new Set([...(meta.tags || []), tag])];
        const next = { ...row, userMeta: meta, updatedAt: Date.now() };
        store.put(next);
        rows.push(next);
        if (!revisionQueued) {
          revisionQueued = true;
          bumpLibraryRevision(tx);
        }
      };
    }
  });
}

function transferLibraryRows(database, ids, restoring) {
  const wanted = mutationIds(ids);
  return new Promise((resolve, reject) => {
    // Both stores participate in one transaction: interruption cannot leave
    // a record missing from both stores, or partially overwrite a newer copy.
    const durable = database.objectStoreNames.contains('checkpoints');
    const tx = database.transaction(durable ? ['tweets', 'trash', 'checkpoints'] : ['tweets', 'trash'], 'readwrite');
    const from = tx.objectStore(restoring ? 'trash' : 'tweets');
    const to = tx.objectStore(restoring ? 'tweets' : 'trash');
    const changed = [],
      conflicts = [],
      restoredRows = [];
    let undoIds = new Set(),
      undoLimited = false,
      remaining = wanted.length;
    if (durable) {
      const undo = tx.objectStore('checkpoints').get(UNDO_KEY);
      undo.onsuccess = () => {
        const ids = undo.result?.ids || [];
        undoLimited = !!undo.result?.limited || ids.length > 1000;
        undoIds = new Set(ids.slice(-1000));
      };
    }
    const finished = () => {
      if (--remaining !== 0 || !durable) return;
      for (const id of changed) {
        if (restoring) undoIds.delete(id);
        else undoIds.add(id);
      }
      const ids = [...undoIds];
      tx.objectStore('checkpoints').put({
        key: UNDO_KEY,
        ids: ids.slice(-1000),
        limited: undoLimited || ids.length > 1000,
        updatedAt: Date.now(),
      });
      if (changed.length) bumpLibraryRevision(tx);
    };
    tx.oncomplete = () =>
      resolve({
        [restoring ? 'restored' : 'moved']: changed.length,
        ids: changed,
        conflicts,
        ...(restoring ? { rows: restoredRows } : {}),
      });
    tx.onabort = () => reject(tx.error || new Error('Trash change aborted; this batch was not applied'));
    tx.onerror = () => reject(tx.error || new Error('Trash change failed'));
    for (const id of wanted) {
      const request = from.get(id);
      request.onsuccess = () => {
        const row = request.result;
        if (!row) {
          if (restoring) undoIds.delete(id);
          finished();
          return;
        }
        const existing = to.get(id);
        existing.onsuccess = () => {
          if (existing.result) {
            conflicts.push(id);
            finished();
            return;
          }
          const next = { ...row };
          if (restoring) delete next.deletedAt;
          else next.deletedAt = Date.now();
          to.put(next);
          if (restoring) restoredRows.push(next);
          from.delete(id);
          changed.push(id);
          finished();
        };
      };
    }
  });
}

export const moveLibraryToTrash = (database, ids) => transferLibraryRows(database, ids, false);
export const restoreLibraryFromTrash = (database, ids) => transferLibraryRows(database, ids, true);
