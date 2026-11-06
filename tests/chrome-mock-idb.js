/* Real IndexedDB dashboard fixture. The synthetic archive stays on disk and is seeded in bounded batches. */
(() => {
  const params = new URLSearchParams(parent.location.search);
  const requestedRecords = Math.min(50000, Math.max(1, Number(params.get('records')) || 10000));
  const databaseName = `xvault-dashboard-idb-${crypto.randomUUID()}`;
  const now = Date.now(),
    image =
      'data:image/svg+xml,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48"><rect width="64" height="48" fill="#25364b"/><circle cx="32" cy="24" r="12" fill="#81aef6"/></svg>'
      );
  const settings = {
    railWidth: 'normal',
    facetWidth: 'normal',
    inspectorWidth: 'normal',
    inspectorPixels: 0,
    uiFont: 'hanken',
    readFont: 'sans',
    startPage: 'last',
    accentCustom: '',
    workspaces: [],
    toolbarActions: ['refresh', 'openX', 'export'],
    theme: 'graphite',
    uiDensity: 'comfortable',
    libraryPageSize: 50,
    libraryView: 'timeline',
    libraryMediaSize: 'compact',
    libraryShowMetrics: true,
    libraryVideoControls: true,
    libraryPreloadMedia: 'none',
    rememberLibraryQuery: false,
    savedViews: [],
    onboardingComplete: true,
    dashboardActivityIsland: true,
    dashboardIslandPosition: 'right',
    motionLevel: 'normal',
    fullMirrorMode: false,
    captureWhileBrowsing: true,
    lastDashboardPage: 'home',
    inboxSince: 0,
  };
  const storage = { settings, graphqlTemplates: {} };
  const operations = { getAll: 0, getAllKeys: 0, count: 0, indexCount: 0 };
  const dbReady = (async () => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('tweets', { keyPath: 'id' }).createIndex('archivedAt', 'archivedAt');
      db.createObjectStore('trash', { keyPath: 'id' }).createIndex('deletedAt', 'deletedAt');
      db.createObjectStore('checkpoints', { keyPath: 'key' });
      const downloads = db.createObjectStore('downloads', { keyPath: 'key' });
      downloads.createIndex('tweetId', 'item.tweetId');
      downloads.createIndex('stateKey', ['state', 'key']);
      downloads.createIndex('downloadId', 'downloadId');
      db.createObjectStore('libraryPlans', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
      db.createObjectStore('revisions', { keyPath: 'key' }).createIndex('tweetId', 'tweetId');
      db.createObjectStore('manifests', { keyPath: 'id' });
      const imports = db.createObjectStore('archiveImports', { keyPath: 'id' });
      imports.createIndex('importId', 'importId');
      imports.createIndex('importFingerprint', ['importId', 'fingerprint']);
      imports.createIndex('importKindKey', ['importId', 'kind', 'id']);
      imports.createIndex('at', 'at');
    };
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const makePost = index => ({
      id: String(900000 + index),
      url: `https://x.com/test/status/${900000 + index}`,
      text: `Synthetic indexed archive post ${index}${index % 997 === 0 ? ` ${'long-post-marker '.repeat(400)}` : ''}`,
      author: index % 13 === 0 ? undefined : { handle: `artist${index % 97}`, name: `Artist ${index % 97}` },
      archivedAt: index > 0 && index % 997 === 0 ? undefined : now - index * 1000,
      createdAt: new Date(now - index * 1000).toISOString(),
      metrics: {
        likes: index * 3,
        views: index * 17,
        bookmarks: index % 1200,
        reposts: index % 701,
        replies: index % 201,
      },
      media:
        index % 5 === 0 && index % 997 !== 0
          ? []
          : [
              { id: `m-${index}`, type: 'photo', url: image, width: 64, height: 48 },
              ...(index % 997 === 0
                ? Array.from({ length: 24 }, (_, mediaIndex) => ({
                    id: `extra-${index}-${mediaIndex}`,
                    type: 'photo',
                    url: image,
                  }))
                : []),
            ],
      sourceFlags: [index % 2 ? 'likes' : 'bookmarks'],
      userMeta: {
        tags:
          index % 997 === 0
            ? Array.from({ length: 80 }, (_, tag) => `tag-${tag}`)
            : index % 7 === 0
              ? ['reference']
              : [],
        favorite: index % 11 === 0,
        note: index % 997 === 0 ? 'Adversarial long note. '.repeat(1200) : '',
      },
      provenance:
        index % 997 === 0
          ? Array.from({ length: 60 }, (_, revision) => ({ source: `capture-${revision}`, capturedAt: now - revision }))
          : [],
    });
    for (let offset = 0; offset < requestedRecords; offset += 200) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('tweets', 'readwrite'),
          store = tx.objectStore('tweets');
        for (let index = offset; index < Math.min(requestedRecords, offset + 200); index++) store.put(makePost(index));
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error('Synthetic archive seed aborted'));
      });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return db;
  })();
  window.__xvMockRealDatabaseName = databaseName;
  window.__xvMockReadyComplete = false;
  const ready = dbReady.then(db => {
    window.__xvMockReadyComplete = true;
    return db;
  });
  window.__xvMutatePost = async (id, patch = {}) => {
    const database = await ready,
      api = await import('/library-storage.mjs');
    const result = await api.updateLibraryRecord(database, String(id), patch);
    return result.ok;
  };
  const activeQueries = new Map();
  const rankedProgress = new Map(),
    rankedPlans = import('/library-ranked-query.mjs').then(
      module => new module.LibraryRankPlanCache({ maxPlans: 3, maxRanks: module.MAX_LIBRARY_RANKS })
    );
  window.__xvRankMetrics = [];
  window.__xvSimulateWorkerRestart = async () => (await rankedPlans).clear();
  window.__xvIdbOperations = operations;
  window.__xvCloseMockDB = async () => (await ready).close();
  window.__xvMessageLog = [];
  window.__xvRecoveryPages = [];
  window.__xvDerivativeRemovalCalls = [];
  window.__xvQueryCalls = [];
  window.chrome = {
    runtime: {
      id: 'a'.repeat(32),
      sendMessage: async message => {
        const type = message?.type || 'unknown';
        window.__xvMessageLog.push(type);
        if (type === 'GET_SETTINGS')
          return {
            ok: true,
            settings: { ...settings },
            defaults: { ...settings, soundVolume: 0.7, uiDensity: 'comfortable' },
          };
        if (type === 'UPDATE_WORKSPACE') {
          Object.assign(settings, window.XVaultWorkspaces.mutate(settings, message.change));
          return { ok: true, settings: { ...settings } };
        }
        if (type === 'SET_SETTINGS') {
          Object.assign(settings, message.settings || {});
          return { ok: true, settings: { ...settings } };
        }
        if (type === 'UPDATE_SMART_COLLECTIONS') {
          const mutation = window.XVaultCollections.applyChange(settings.savedViews, message.change || {});
          if (mutation.changed) settings.savedViews = mutation.savedViews;
          return { ok: true, settings: { ...settings }, ...mutation };
        }
        if (type === 'REMOVE_CONVERSION_OUTPUT') {
          window.__xvDerivativeRemovalCalls.push({
            key: String(message.key || ''),
            format: String(message.format || ''),
          });
          const format = String(message.format || 'gif');
          return {
            ok: true,
            state: 'removed',
            format,
            size: 420,
            originalPreserved: true,
            conversion: {
              state: 'completed',
              helper: { [format]: { state: 'removed', path: 'XVault/GIFs/GIF/test-capture.gif', size: 420 } },
              verification: {
                state: 'verified-with-warning',
                outputs: [{ label: format, state: 'removed', size: 420 }],
              },
            },
          };
        }
        if (type === 'ACTIVE_X_TAB') return { ok: true, tab: null };
        if (type === 'STATS')
          return {
            ok: true,
            tweets: requestedRecords,
            users: 97,
            captures: 0,
            stored: { usage: requestedRecords * 1024 },
          };
        if (type === 'DOWNLOAD_QUEUE_STATS')
          return {
            ok: true,
            queued: 0,
            downloading: 0,
            complete: 0,
            failed: 0,
            totalBytes: 0,
            bytesReceived: 0,
            speedBps: 0,
            etaSeconds: null,
          };
        if (type === 'GET_DOWNLOAD_HISTORY') return { ok: true, rows: [] };
        if (type === 'GET_JOB') return { ok: true, job: null };
        if (type === 'CANCEL_LIBRARY_QUERY') {
          const query = activeQueries.get(String(message.queryId || ''));
          if (query) query.cancelled = true;
          return { ok: true };
        }
        if (type === 'GET_LIBRARY_QUERY_PROGRESS')
          return { ok: true, progress: rankedProgress.get(String(message.queryId || '')) || null };
        const db = await ready;
        const api = await import('/library-storage.mjs');
        if (type === 'QUERY_LIBRARY_PAGE') {
          const queryId = String(message.queryId || crypto.randomUUID()),
            control = { cancelled: false };
          activeQueries.set(queryId, control);
          window.__xvQueryCalls.push({
            queryId,
            sort: message.sort,
            query: message.query,
            after: message.after,
            limit: message.limit,
            scanLimit: message.scanLimit,
          });
          const started = performance.now(),
            planningStarted = performance.now(),
            query = String(message.query || ''),
            issues = window.XVaultLibrarySearch.queryIssues(query);
          if (issues.length)
            return {
              ok: true,
              rows: [],
              downloads: [],
              revision: 0,
              totalRecords: null,
              matched: 0,
              done: true,
              hasMore: false,
              scanned: 0,
              recordsRead: 0,
              materialized: 0,
              cursorOperations: 0,
              returned: 0,
              bytesEstimate: 0,
              issues,
              index: 'query-validation',
              plan: 'invalid query rejected before scanning',
            };
          const compiled = window.XVaultLibrarySearch.compileQuery(query),
            queryPlanningMs = performance.now() - planningStarted;
          if (!['new', 'old'].includes(String(message.sort || 'new'))) {
            try {
              const rankModule = await import('/library-ranked-query.mjs'),
                cache = await rankedPlans,
                planStorage = await import('/library-plan-storage.mjs');
              const revision = await api.readLibraryRevision(db),
                randomSeed = Number(message.randomSeed) || 1,
                sort = String(message.sort),
                planId = String(message.rankPlanId || queryId),
                identityKey = JSON.stringify([query, sort, randomSeed, revision, Number(settings.inboxSince) || 0]);
              const pageStarted = performance.now(),
                ranked = await rankModule.buildLibraryRankPlan({
                  cache,
                  planId,
                  identityKey,
                  readPage: (afterKey, limit) => api.readLibraryPage(db, afterKey, limit),
                  project: (post, index) =>
                    compiled.length
                      ? window.XVaultLibrarySearch.projectPost(post, index, {
                          inboxSince: settings.inboxSince,
                          randomOrder: index,
                        })
                      : window.XVaultLibrarySearch.projectRankPost(post, index, { randomOrder: index }),
                  matches: projection => window.XVaultLibrarySearch.matchesCompiledQuery(projection, compiled),
                  toRank: (projection, post, index) => ({
                    id: post.id,
                    index,
                    metrics: Object.fromEntries(
                      ['likes', 'views', 'bookmarks', 'reposts', 'replies'].map(key => [
                        key,
                        Number(projection.metrics?.[key] || 0),
                      ])
                    ),
                    archivedAt: projection.archivedAt,
                    mediaCount: projection.mediaCount,
                    handle: projection.handle,
                    randomOrder: projection.randomOrder,
                  }),
                  compare: (a, b) =>
                    window.XVaultLibrarySearch.compareRows(a, b, sort) || String(a.id).localeCompare(String(b.id)),
                  cancelled: () => control.cancelled,
                  onProgress: progress => rankedProgress.set(queryId, { phase: 'scan', ...progress }),
                  loadPlan: id => planStorage.readStoredLibraryPlan(db, id),
                  savePlan: (id, identity, plan) => planStorage.writeStoredLibraryPlan(db, id, identity, plan, 3),
                  deletePlan: id => planStorage.deleteStoredLibraryPlan(db, id),
                  isCurrent: async () => (await api.readLibraryRevision(db)) === revision,
                });
              if (ranked.cancelled || control.cancelled) return { ok: true, cancelled: true, rows: [] };
              if (ranked.stale) return { ok: true, stale: true, revision: await api.readLibraryRevision(db), rows: [] };
              const rankedPage = rankModule.pageLibraryRankPlan(
                ranked.plan,
                Math.max(0, Number(message.offset) || 0),
                Math.min(1500, Number(message.limit) || 50)
              );
              rankedProgress.set(queryId, {
                phase: 'materialize',
                scanned: ranked.plan.scanned,
                matched: ranked.plan.matched,
              });
              const rows = await api.readLibraryRecords(
                db,
                rankedPage.ranks.map(row => row.id)
              );
              const currentRevision = await api.readLibraryRevision(db);
              if (currentRevision !== revision) {
                cache.delete(planId);
                return { ok: true, stale: true, revision: currentRevision, rows: [] };
              }
              const metric = {
                sort,
                records: requestedRecords,
                scanned: ranked.cached ? 0 : ranked.plan.scanned,
                recordsRead: (ranked.cached ? 0 : ranked.plan.scanned) + rankedPage.ranks.length,
                cacheHit: ranked.cached,
                durableHit: ranked.durableHit,
                persisted: ranked.persisted,
                retained: ranked.plan.ranks.length,
                cancelled: false,
                pageMs: performance.now() - pageStarted,
              };
              window.__xvRankMetrics.push(metric);
              return {
                ok: true,
                rows,
                downloads: [],
                revision,
                totalRecords: ranked.plan.scanned,
                matched: ranked.plan.matched,
                retained: ranked.plan.ranks.length,
                truncated: ranked.plan.truncated,
                rankCacheHit: ranked.cached,
                done: !rankedPage.hasMore,
                hasMore: rankedPage.hasMore,
                scanned: metric.scanned,
                recordsRead: metric.recordsRead,
                materialized: (ranked.cached ? 0 : ranked.plan.scanned) + rows.length,
                searchProjectionRows: metric.scanned,
                cursorOperations: 0,
                returned: rows.length,
                bytesEstimate: JSON.stringify(rows).length * 2,
                index: 'ranked-stream-cache',
                plan: ranked.cached ? 'revision-matched rank cache' : 'bounded IndexedDB rank scan',
              };
            } finally {
              rankedProgress.delete(queryId);
              if (activeQueries.get(queryId) === control) activeQueries.delete(queryId);
            }
          }
          const pageReadStarted = performance.now();
          try {
            const page = await api.readLibraryQueryPage(db, {
              sort: message.sort,
              limit: Math.min(1500, Number(message.limit) || 50),
              after: message.after || null,
              expectedRevision: message.expectedRevision,
              scanLimit: Math.min(10000, Math.max(1, Number(message.scanLimit) || 2500)),
              cancelled: () => control.cancelled,
              match: post =>
                !query ||
                window.XVaultLibrarySearch.matchesCompiledQuery(
                  window.XVaultLibrarySearch.projectPost(post, 0, { inboxSince: settings.inboxSince }),
                  compiled
                ),
            });
            const pageReadMs = performance.now() - pageReadStarted;
            if (page.stale || page.cancelled)
              return {
                ok: true,
                ...page,
                downloads: [],
                metrics: {
                  databaseOpenMs: 0,
                  schemaPreparationMs: 0,
                  queryPlanningMs,
                  pageReadMs,
                  downloadLookupMs: 0,
                  queryMs: performance.now() - started,
                },
              };
            const lookupStarted = performance.now(),
              downloads = await api.readDownloadRows(
                db,
                page.rows.map(row => row.id),
                { perPostLimit: 64, totalLimit: 5000 }
              ),
              downloadLookupMs = performance.now() - lookupStarted;
            const result = {
              ok: true,
              ...page,
              downloads,
              metrics: {
                databaseOpenMs: 0,
                schemaPreparationMs: 0,
                queryPlanningMs,
                pageReadMs,
                downloadLookupMs,
                queryMs: performance.now() - started,
                plan: `real IndexedDB ${message.sort === 'old' ? 'ascending' : 'descending'} archivedAt cursor`,
              },
            };
            window.__xvQueryCalls.at(-1).result = {
              recordsRead: page.recordsRead,
              materialized: page.materialized,
              cursorOperations: page.cursorOperations,
              index: page.index,
            };
            return result;
          } finally {
            if (activeQueries.get(queryId) === control) activeQueries.delete(queryId);
          }
        }
        if (type === 'GET_LIBRARY_RECORDS')
          return { ok: true, rows: await api.readLibraryRecords(db, message.ids || []) };
        if (type === 'GET_LIBRARY_METADATA')
          return { ok: true, rows: await api.readLibraryMetadata(db, message.ids || []) };
        if (type === 'GET_DOWNLOADS_FOR_TWEETS')
          return {
            ok: true,
            rows: await api.readDownloadRows(db, message.ids || [], {
              perPostLimit: message.perPostLimit || 64,
              totalLimit: message.totalLimit || 5000,
            }),
          };
        if (type === 'UPDATE_MEDIA_METADATA')
          return api.updateLibraryMediaMetadata(db, message.id, message.mediaKey, message.change || {});
        if (type === 'READ_RECOVERY_BACKUP_PAGE') {
          const started = performance.now(),
            page = await api.readLibraryBackupPage(
              db,
              message.store,
              message.afterKey ?? null,
              message.limit,
              message.expectedRevision
            );
          window.__xvRecoveryPages.push({
            store: message.store,
            limit: message.limit,
            recordsRead: page.recordsRead,
            cursorOperations: page.cursorOperations,
            latencyMs: performance.now() - started,
            stale: page.stale,
          });
          return { ok: true, ...page };
        }
        if (type === 'PREVIEW_RECOVERY_BATCH')
          return {
            ok: true,
            ...(await api.previewArchiveImportBatch(
              db,
              message.records,
              message.expectedRevision,
              message.expectedDownloadRevision,
              message.importId
            )),
          };
        if (type === 'BEGIN_RECOVERY_IMPORT') return api.beginArchiveImport(db, message.options || {});
        if (type === 'COMMIT_RECOVERY_BATCH') return api.commitArchiveImportBatch(db, message.batch || {});
        if (type === 'COMPLETE_RECOVERY_IMPORT')
          return api.completeArchiveImport(
            db,
            message.jobId,
            message.fingerprint,
            message.expectedRevision,
            message.expectedDownloadRevision,
            message.footer
          );
        if (type === 'GET_RECOVERY_IMPORT_JOB')
          return { ok: true, job: await api.getArchiveImportJob(db, message.jobId) };
        if (type === 'FIND_RECOVERY_IMPORT_JOB')
          return { ok: true, job: await api.findArchiveImportJob(db, message.importId, message.fingerprint) };
        if (type === 'READ_RECOVERY_IMPORT_CONFLICTS')
          return {
            ok: true,
            ...(await api.readArchiveImportConflicts(db, message.importId, message.afterKey ?? null, message.limit)),
          };
        if (type === 'READ_RECOVERY_ASSET_REFERENCES')
          return {
            ok: true,
            ...(await api.readArchiveAssetReferences(db, message.importId, message.afterKey ?? null, message.limit)),
          };
        return { ok: true, rows: [] };
      },
    },
    storage: {
      local: {
        get: async key => (key ? { [key]: storage[key] } : { ...storage }),
        set: async values => Object.assign(storage, values),
      },
    },
    tabs: { create: async () => ({}), query: async () => [], sendMessage: async () => ({ ok: true }) },
    permissions: { contains: async () => false },
    downloads: { show: async () => {}, open: async () => {} },
  };
  const originals = {
    getAll: IDBObjectStore.prototype.getAll,
    getAllKeys: IDBObjectStore.prototype.getAllKeys,
    count: IDBObjectStore.prototype.count,
    indexCount: IDBIndex.prototype.count,
  };
  IDBObjectStore.prototype.getAll = function (...args) {
    if (this.transaction.db.name === databaseName) operations.getAll++;
    return originals.getAll.apply(this, args);
  };
  IDBObjectStore.prototype.getAllKeys = function (...args) {
    if (this.transaction.db.name === databaseName) operations.getAllKeys++;
    return originals.getAllKeys.apply(this, args);
  };
  IDBObjectStore.prototype.count = function (...args) {
    if (this.transaction.db.name === databaseName) operations.count++;
    return originals.count.apply(this, args);
  };
  IDBIndex.prototype.count = function (...args) {
    if (this.objectStore.transaction.db.name === databaseName) operations.indexCount++;
    return originals.indexCount.apply(this, args);
  };
})();
