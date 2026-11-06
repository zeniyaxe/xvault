/* Synthetic browser-only data for dashboard interaction tests. */
(() => {
  const svg =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#151a24"/><circle cx="320" cy="180" r="80" fill="#75aaff"/></svg>'
    );
  const recordParam = new URLSearchParams(parent.location.search).get('records');
  const requestedRecords = recordParam === null ? 125 : Math.min(50000, Math.max(0, Number(recordParam) || 0));
  let rows = Array.from({ length: requestedRecords }, (_, index) => ({
    id: String(900000 + index),
    url: `https://x.com/test/status/${900000 + index}`,
    text: index % 3 === 0 ? `Saved artwork number ${index}` : `Synthetic archive post number ${index}`,
    author: { handle: `artist${index % 7}`, name: `Artist ${index % 7}`, avatar: '' },
    archivedAt: Date.now() - index * 100000,
    createdAt: new Date(Date.now() - index * 100000).toISOString(),
    metrics: { likes: index * 10, views: index * 500, bookmarks: index * 2, reposts: index, replies: 0 },
    media:
      index % 4 === 0
        ? []
        : index === 2
          ? [
              {
                id: `m-${index}`,
                type: 'video',
                url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
                playbackUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
                preview: svg,
                width: 960,
                height: 540,
              },
            ]
          : [{ id: `m-${index}`, type: 'photo', url: svg, width: 640, height: 360 }],
    sourceFlags: [index % 2 ? 'likes' : 'bookmarks'],
    userMeta: { tags: [] },
  }));
  let demoInbox = 0;
  // ?demo=1 swaps in varied, photographic-feeling synthetic posts for visual review.
  if (new URLSearchParams(parent.location.search).get('demo')) {
    const rand = seed => {
      let h = 2166136261 ^ seed;
      return () => {
        h = Math.imul(h ^ (h >>> 15), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        h ^= h >>> 16;
        return (h >>> 0) / 4294967296;
      };
    };
    const palettes = [
      ['#1d2b3a', '#e8a35c', '#f2d7a6'],
      ['#2a1f2d', '#d96a6a', '#f3c5b0'],
      ['#16282a', '#5fb7a6', '#d3efe0'],
      ['#2e2a1a', '#d6b24e', '#f4e7b8'],
      ['#1b1e33', '#7d8cf0', '#cfd5ff'],
      ['#2b1d18', '#c9733f', '#f0cfae'],
      ['#202020', '#9aa0a6', '#e9e9e9'],
      ['#10281d', '#6fbf8a', '#d6f0df'],
    ];
    const art = (seed, w, h) => {
      const r = rand(seed),
        p = palettes[seed % palettes.length],
        shapes = [];
      shapes.push(`<rect width="${w}" height="${h}" fill="url(#g)"/>`);
      for (let i = 0; i < 7; i++) {
        const cx = r() * w,
          cy = r() * h,
          rad = (0.08 + r() * 0.34) * Math.min(w, h),
          op = (0.12 + r() * 0.5).toFixed(2);
        shapes.push(
          r() > 0.45
            ? `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${rad.toFixed(0)}" fill="${p[1 + Math.floor(r() * 2)]}" opacity="${op}"/>`
            : `<rect x="${(cx - rad).toFixed(0)}" y="${(cy - rad * 0.6).toFixed(0)}" width="${(rad * 2).toFixed(0)}" height="${(rad * 1.2).toFixed(0)}" rx="${(rad * 0.2).toFixed(0)}" fill="${p[1 + Math.floor(r() * 2)]}" opacity="${op}" transform="rotate(${(r() * 40 - 20).toFixed(0)} ${cx.toFixed(0)} ${cy.toFixed(0)})"/>`
        );
      }
      shapes.push(
        `<path d="M0 ${(h * 0.78).toFixed(0)} Q ${(w * 0.3).toFixed(0)} ${(h * (0.6 + r() * 0.2)).toFixed(0)} ${(w * 0.6).toFixed(0)} ${(h * 0.74).toFixed(0)} T ${w} ${(h * 0.7).toFixed(0)} V ${h} H0Z" fill="${p[0]}" opacity=".7"/>`
      );
      return (
        'data:image/svg+xml,' +
        encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p[0]}"/><stop offset="1" stop-color="${p[1]}" stop-opacity=".55"/></linearGradient></defs>${shapes.join('')}</svg>`
        )
      );
    };
    const people = [
      ['mirrorlake', 'Mirror Lake'],
      ['hanaw', 'Hana Watanabe'],
      ['fieldnotes', 'Field Notes'],
      ['oddarchive', 'The Odd Archive'],
      ['kiln_and_co', 'Kiln & Co'],
      ['pixeltide', 'Pixel Tide'],
      ['nightbus', 'Night Bus Studio'],
      ['ledgerlines', 'Ledger Lines'],
      ['softcrash', 'Soft Crash'],
      ['vera_k', 'Vera Kozlova'],
    ];
    const texts = [
      'The light in the stairwell lasted maybe four minutes. Worth the climb.',
      'New print run is done. Twelve colors, hand-registered, edition of 80.',
      'Nobody tells you the first draft of a map is mostly erasing.',
      'Rainy-day shelf. Everything I own that is ceramic and slightly crooked.',
      'Thread: how a 1974 transit diagram quietly solved a problem we still argue about.',
      'Pinned for later — this color study is going straight into the reference folder.',
      'Slow mornings, fast notebooks.',
      'Three sketches of the same bridge at different hours. Same bridge. Different city.',
      'Found this in a box of unlabeled slides. No idea who shot it.',
      'Update: the font is finished. Download link below, free for personal use.',
      'A very small program that does one thing. I love those.',
      'Studio cat approves of the new drafting table.',
    ];
    const sizes = [
      [1200, 800],
      [800, 1200],
      [1280, 720],
      [1000, 1000],
      [900, 1350],
      [1600, 900],
      [1100, 800],
    ];
    const now = Date.now();
    rows = Array.from({ length: requestedRecords }, (_, index) => {
      const r = rand(index + 7),
        person = people[index % people.length],
        archivedAt = now - index * 3600 * 1000 * (0.4 + (index % 5) * 0.6),
        kind = r();
      const count = kind < 0.2 ? 0 : kind < 0.72 ? 1 : kind < 0.82 ? 2 : kind < 0.9 ? 4 : 1;
      const isVideo = kind >= 0.9 && kind < 0.95,
        isGif = kind >= 0.95;
      const media = Array.from({ length: count }, (_, mi) => {
        const [w, h] = sizes[Math.floor(r() * sizes.length)],
          picture = art(index * 11 + mi * 3, Math.min(w, 900), Math.min(h, 900) * (h / w > 1 ? 1 : 1));
        return isVideo
          ? {
              id: `m-${index}-${mi}`,
              type: 'video',
              url: picture,
              playbackUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
              preview: picture,
              width: w,
              height: h,
            }
          : isGif
            ? {
                id: `m-${index}-${mi}`,
                type: 'animated_gif',
                url: picture,
                playbackUrl: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
                preview: picture,
                width: w,
                height: h,
              }
            : { id: `m-${index}-${mi}`, type: 'photo', url: picture, preview: picture, width: w, height: h };
      });
      return {
        id: String(900000 + index),
        url: `https://x.com/${person[0]}/status/${900000 + index}`,
        text: texts[(index * 7 + Math.floor(r() * 5)) % texts.length],
        author: { handle: person[0], name: person[1], avatar: '' },
        archivedAt,
        createdAt: new Date(archivedAt - 86400000 * (1 + (index % 40))).toISOString(),
        metrics: {
          likes: Math.floor(r() * r() * 24000),
          views: Math.floor(r() * r() * 900000),
          bookmarks: Math.floor(r() * 900),
          reposts: Math.floor(r() * r() * 3000),
          replies: Math.floor(r() * 120),
        },
        media,
        sensitive: index % 23 === 7,
        sourceFlags: [index % 3 ? 'likes' : 'bookmarks'],
        userMeta: {
          tags: index % 6 === 0 ? ['reference'] : index % 9 === 0 ? ['color', 'print'] : [],
          favorite: index % 11 === 0,
          reviewedAt: index > 14 ? archivedAt : undefined,
        },
      };
    });
    demoInbox = now - 14 * 3600 * 1000 * 2;
  }
  const demoDownloads = () =>
    !new URLSearchParams(parent.location.search).get('demo')
      ? []
      : [
          {
            key: 'a',
            state: 'downloading',
            target: { filename: 'Images/mirrorlake/Q4x9tLm.jpg', kind: 'image' },
            item: {},
            totalBytes: 2481920,
          },
          {
            key: 'b',
            state: 'complete',
            target: { filename: 'Videos/hanaw/n3Kp82A.mp4', kind: 'video' },
            item: {},
            totalBytes: 18940211,
            verification: { state: 'verified' },
          },
          {
            key: 'c',
            state: 'complete',
            target: { filename: 'GIFs/pixeltide/xW20pQa.gif', kind: 'gif' },
            item: {},
            totalBytes: 4112000,
            verification: { state: 'verified' },
          },
          {
            key: 'd',
            state: 'failed',
            target: { filename: 'Images/oddarchive/L8s0Zk1.jpg', kind: 'image' },
            item: { url: 'https://pbs.twimg.com/x.jpg' },
            error: 'Media link expired (403)',
            recoveryAction: 'open-source-post',
          },
        ];
  const demoRuns = () =>
    !new URLSearchParams(parent.location.search).get('demo')
      ? []
      : [
          {
            id: 'r3',
            source: 'bookmarks',
            state: 'complete',
            startedAt: Date.now() - 7200000,
            finishedAt: Date.now() - 6900000,
            diff: {
              summary: { postsAdded: 38, postsChanged: 2, notObserved: 1 },
              note: 'Compared with the baseline taken when the run started.',
            },
          },
          {
            id: 'r2',
            source: 'profile',
            profileHandle: 'mirrorlake',
            state: 'complete',
            startedAt: Date.now() - 90000000,
            finishedAt: Date.now() - 89000000,
            diff: { summary: { postsAdded: 211, postsChanged: 0, notObserved: 0 }, note: '' },
          },
          {
            id: 'r1',
            source: 'likes',
            state: 'settling',
            startedAt: Date.now() - 200000000,
            finishedAt: Date.now() - 199000000,
            diff: { summary: { postsAdded: 88, postsChanged: 5, notObserved: 3 }, note: '' },
          },
        ];
  const trash = new Map();
  const trashUndo = new Set();
  const rowById = new Map(rows.map((row, index) => [String(row.id), row]));
  const rowPositionById = new Map(rows.map((row, index) => [String(row.id), index]));
  let activeRowCount = rows.length;
  const activeRows = () => rows.filter(Boolean);
  // The standard fixture is generated newest-first, just like the persisted
  // archivedAt index. Reusing that order keeps the UI harness from sorting a
  // synthetic 50k archive synchronously during its first Library request.
  let sortedSource = null,
    sortedRows = [],
    indexedSource = demoInbox ? null : rows,
    indexedRows = demoInbox ? [] : rows;
  let libraryRevision = 0;
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
    libraryPreloadMedia: 'metadata',
    rememberLibraryQuery: true,
    savedViews: [],
    onboardingComplete: true,
    dashboardActivityIsland: true,
    dashboardIslandPosition: 'right',
    motionLevel: 'normal',
    fullMirrorMode: false,
    captureWhileBrowsing: true,
  };
  if (demoInbox) settings.inboxSince = demoInbox;
  const storage = { settings, graphqlTemplates: {} };
  window.__xvMessageLog = [];
  window.__xvQueryCalls = [];
  window.__xvMutatePost = (id, patch = {}) => {
    const row = rowById.get(String(id));
    if (!row) return false;
    Object.assign(row, structuredClone(patch));
    libraryRevision++;
    indexedSource = null;
    sortedSource = null;
    return true;
  };
  window.chrome = {
    runtime: {
      id: 'a'.repeat(32),
      sendMessage: async message => {
        window.__xvMessageLog.push(message?.type || 'unknown');
        switch (message.type) {
          case 'GET_SETTINGS':
            return {
              ok: true,
              settings: { ...settings },
              defaults: { ...settings, soundVolume: 0.7, uiDensity: 'comfortable' },
            };
          case 'UPDATE_WORKSPACE':
            Object.assign(settings, window.XVaultWorkspaces.mutate(settings, message.change));
            return { ok: true, settings: { ...settings } };
          case 'GET_JOB':
            return { ok: true, job: null };
          case 'SET_SETTINGS':
            Object.assign(settings, message.settings || {});
            return { ok: true, settings: { ...settings } };
          case 'UPDATE_SMART_COLLECTIONS': {
            const mutation = window.XVaultCollections.applyChange(settings.savedViews, message.change || {});
            if (mutation.changed) settings.savedViews = mutation.savedViews;
            return { ok: true, settings: { ...settings }, ...mutation };
          }
          case 'SEMANTIC_SIMILAR': {
            // XVault 26: "similar" in the mock = other posts by the same author first, then posts with media.
            const source = rowById.get(String(message.id));
            if (!source) return { ok: true, results: [] };
            const others = activeRows().filter(row => row.id !== source.id && (row.media || []).length);
            const ranked = [
              ...others.filter(row => row.author?.handle === source.author?.handle),
              ...others.filter(row => row.author?.handle !== source.author?.handle),
            ].slice(0, Math.max(1, Math.min(48, Number(message.limit) || 12)));
            return { ok: true, results: ranked.map((row, index) => ({ id: row.id, score: 0.9 - index * 0.03 })) };
          }
          case 'GET_LIBRARY_RECORDS': {
            const wanted = new Set((message.ids || []).map(String));
            if (wanted.size > 1000) return { ok: false, error: 'Library record reads require at most 1,000 post IDs' };
            return {
              ok: true,
              rows: [...wanted]
                .map(id => rowById.get(id))
                .filter(Boolean)
                .map(row => structuredClone(row)),
            };
          }
          case 'GET_LIBRARY_ROWS':
            return { ok: true, rows: activeRows().map(row => ({ ...row })) };
          case 'GET_LIBRARY_CHUNK': {
            if (sortedSource !== rows) {
              sortedRows = activeRows().sort((a, b) => String(a.id).localeCompare(String(b.id)));
              sortedSource = rows;
            }
            const sorted = sortedRows;
            const offset =
              message.afterKey == null ? 0 : sorted.findIndex(row => String(row.id) > String(message.afterKey));
            const start = offset < 0 ? sorted.length : offset;
            const batch = sorted.slice(start, start + Math.max(1, Number(message.limit) || 500));
            return {
              ok: true,
              rows: batch.map(row => ({ ...row })),
              nextKey: batch.at(-1)?.id ?? message.afterKey ?? null,
              done: start + batch.length >= sorted.length,
            };
          }
          case 'QUERY_LIBRARY_PAGE': {
            window.__xvQueryCalls.push({
              query: message.query,
              sort: message.sort,
              after: message.after,
              expectedRevision: message.expectedRevision,
              revision: libraryRevision,
              limit: message.limit,
              randomSeed: message.randomSeed,
            });
            const sort = ['new', 'old'].includes(message.sort) ? message.sort : 'new';
            const query = String(message.query || ''),
              compiled = window.XVaultLibrarySearch?.compileQuery(query) || [];
            if (message.expectedRevision != null && Number(message.expectedRevision) !== libraryRevision)
              return { ok: true, stale: true, revision: libraryRevision, rows: [] };
            const issues = window.XVaultLibrarySearch?.queryIssues(query) || [];
            if (issues.length)
              return {
                ok: true,
                rows: [],
                downloads: [],
                revision: libraryRevision,
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
                index: 'query-validation',
                plan: 'invalid query rejected before scanning',
                issues,
                metrics: { openMs: 0, queryMs: 0 },
              };
            if (!['new', 'old'].includes(String(message.sort || 'new'))) {
              const requestedSort = String(message.sort || 'new');
              if (requestedSort === 'random') {
                const total = activeRowCount,
                  offset = Math.max(0, Number(message.offset) || 0),
                  limit = Math.min(1500, Number(message.limit) || 120),
                  seed = Number(message.randomSeed) || 1;
                const stride = 1;
                window.__xvRandomShuffleStarts ||= new Map();
                if (!window.__xvRandomShuffleStarts.has(seed))
                  window.__xvRandomShuffleStarts.set(seed, window.__xvRandomShuffleStarts.size % Math.max(1, total));
                const sourceRows = activeRows();
                const start = window.__xvRandomShuffleStarts.get(seed),
                  selected = Array.from(
                    { length: Math.min(limit, Math.max(0, total - offset)) },
                    (_, index) => sourceRows[(start + stride * (offset + index)) % total]
                  );
                return {
                  ok: true,
                  rows: selected.map(row => structuredClone(row)),
                  downloads: [],
                  revision: libraryRevision,
                  totalRecords: total,
                  matched: total,
                  done: true,
                  hasMore: offset + selected.length < total,
                  scanned: total,
                  recordsRead: total,
                  materialized: selected.length,
                  cursorOperations: total,
                  returned: selected.length,
                  bytesEstimate: JSON.stringify(selected).length * 2,
                  index: 'synthetic-random',
                  plan: 'synthetic seeded permutation',
                };
              }
              const ordered = activeRows()
                .map((post, index) => {
                  let stableRandom = 2166136261;
                  for (const character of `${Number(message.randomSeed) || 1}:${post.id}`) {
                    stableRandom ^= character.charCodeAt(0);
                    stableRandom = Math.imul(stableRandom, 16777619);
                  }
                  return {
                    post,
                    index,
                    projected: window.XVaultLibrarySearch?.projectPost(post, index, {
                      inboxSince: settings.inboxSince,
                      randomOrder: stableRandom >>> 0,
                    }),
                  };
                })
                .filter(item => !query || window.XVaultLibrarySearch?.matchesCompiledQuery(item.projected, compiled))
                .sort(
                  (a, b) =>
                    window.XVaultLibrarySearch?.compareRows(a.projected, b.projected, requestedSort) ||
                    a.index - b.index
                );
              const total = ordered.length,
                offset = Math.max(0, Number(message.offset) || 0),
                selected = ordered
                  .slice(offset, offset + Math.min(1500, Number(message.limit) || 120))
                  .map(item => structuredClone(item.post));
              const recordsScanned = activeRowCount;
              return {
                ok: true,
                rows: selected,
                downloads: [],
                revision: libraryRevision,
                totalRecords: recordsScanned,
                matched: total,
                done: true,
                hasMore: offset + selected.length < total,
                scanned: recordsScanned,
                recordsRead: recordsScanned,
                materialized: recordsScanned,
                cursorOperations: recordsScanned,
                returned: selected.length,
                bytesEstimate: JSON.stringify(selected).length * 2,
                index: 'synthetic-rank',
                plan: 'synthetic full-sort fixture',
              };
            }
            const direction = sort === 'new' ? -1 : 1;
            if (indexedSource !== rows) {
              indexedRows = activeRows().sort(
                (a, b) =>
                  (Number(b.archivedAt) || 0) - (Number(a.archivedAt) || 0) || String(b.id).localeCompare(String(a.id))
              );
              indexedSource = rows;
            }
            const ordered = sort === 'new' ? indexedRows : [...indexedRows].reverse(),
              after = message.after;
            let start = 0;
            if (after)
              start = ordered.findIndex(item => {
                const keyOrder = Number(item.archivedAt || 0) - Number(after.key || 0),
                  pair = keyOrder || String(item.id).localeCompare(String(after.id));
                return direction < 0 ? pair < 0 : pair > 0;
              });
            if (start < 0) start = ordered.length;
            const scanLimit = Math.max(1, Math.min(10000, Number(message.scanLimit) || 2500)),
              limit = Math.max(1, Math.min(1500, Number(message.limit) || 120));
            const selected = [],
              end = Math.min(ordered.length, start + scanLimit);
            let scanned = 0,
              cursor = start - 1;
            for (let index = start; index < end && selected.length < limit; index++) {
              cursor = index;
              scanned++;
              const post = ordered[index],
                globalIndex = index;
              if (
                !query ||
                window.XVaultLibrarySearch?.matchesCompiledQuery(
                  window.XVaultLibrarySearch.projectPost(post, globalIndex, { inboxSince: settings.inboxSince }),
                  compiled
                )
              )
                selected.push(post);
            }
            const done = cursor >= ordered.length - 1 || ordered.length === 0;
            const tail = selected.at(-1) || ordered[cursor];
            const response = {
              ok: true,
              rows: selected.map(row => structuredClone(row)),
              downloads: [],
              revision: libraryRevision,
              totalRecords: null,
              scanned,
              recordsRead: scanned,
              materialized: scanned,
              cursorOperations: scanned,
              returned: selected.length,
              bytesEstimate: selected.length ? JSON.stringify(selected).length * 2 : 0,
              index: 'archivedAt',
              nextKey: tail
                ? { key: tail.archivedAt, id: tail.id, phase: 'indexed', sort, revision: libraryRevision }
                : after || null,
              done,
              hasMore: !done,
              metrics: {
                plan: `synthetic ${sort} cursor`,
                openMs: 0,
                settingsMs: 3,
                databaseOpenMs: 2,
                schemaPreparationMs: 0,
                queryPlanningMs: 4,
                pageReadMs: 5,
                downloadLookupMs: 6,
                queryMs: 20,
              },
            };
            window.__xvQueryCalls.at(-1).result = {
              start,
              scanned,
              ids: selected.slice(0, 3).map(row => row.id),
              tail: tail?.id,
              nextKey: response.nextKey,
            };
            return response;
          }
          case 'CANCEL_LIBRARY_QUERY':
            return { ok: true };
          case 'GET_DOWNLOADS_FOR_TWEETS':
            return { ok: true, rows: [] };
          case 'STATS':
            return { ok: true, tweets: activeRowCount, users: 7, captures: 0, stored: { usage: 1024 * 1024 } };
          case 'DOWNLOAD_QUEUE_STATS':
            return {
              ok: true,
              queued: 2,
              downloading: 1,
              complete: 12,
              failed: 0,
              totalBytes: 10000,
              bytesReceived: 4000,
              speedBps: 1000,
              etaSeconds: 6,
            };
          case 'GET_DOWNLOAD_HISTORY':
            return { ok: true, rows: demoDownloads() };
          case 'GET_RECENT_ACTIONS':
            return {
              ok: true,
              rows: demoDownloads().length
                ? [
                    { at: Date.now() - 20000, type: 'archive', text: 'Archive run finished: 214 posts, 38 new' },
                    { at: Date.now() - 410000, type: 'download', text: '12 files verified' },
                    { at: Date.now() - 3600000, type: 'library', text: 'Updated 4 selected posts' },
                  ]
                : [],
            };
          case 'GET_EXPLORER_DATA':
            return { ok: true, data: { tweets: activeRows().slice(0, 600), runs: demoRuns(), revisionCount: 3 } };
          case 'PLAN_LIBRARY_DOWNLOAD': {
            const options = message.options || {},
              query = String(options.query || '').toLowerCase();
            const sourceRows = activeRows();
            const plan = window.XVaultBulkModel?.plan(sourceRows, new Map(), {
              ...options,
              matchesQuery: post =>
                !query ||
                `${post.text || ''} ${post.author?.handle || ''}`.toLowerCase().includes(query.replace(/^text:/, '')),
            }) || {
              totals: {
                postsScanned: sourceRows.length,
                postsMatched: sourceRows.length,
                media: sourceRows.reduce((sum, row) => sum + (row.media || []).length, 0),
                images: sourceRows.reduce(
                  (sum, row) => sum + (row.media || []).filter(media => media.type === 'photo').length,
                  0
                ),
                videos: sourceRows.reduce(
                  (sum, row) => sum + (row.media || []).filter(media => media.type === 'video').length,
                  0
                ),
                animations: 0,
                estimatedBytes: 0,
                alreadyLocal: 0,
                needDownload: sourceRows.reduce((sum, row) => sum + (row.media || []).length, 0),
                failed: 0,
                gifConversions: 0,
                webpConversions: 0,
              },
            };
            return { ok: true, ...plan };
          }
          case 'START_LIBRARY_BULK_DOWNLOAD': {
            const options = message.options || {},
              plan = window.XVaultBulkModel?.plan(activeRows(), new Map(), options) || { totals: {} };
            return { ok: true, added: plan.totals.media || 0, skipped: 0, filtered: 0, totals: plan.totals };
          }
          case 'GET_SESSIONS':
            return {
              ok: true,
              rows: demoRuns()
                .slice(0, message.limit || 80)
                .map((run, index) => ({
                  ...run,
                  posts: run.diff?.summary?.postsAdded + 120,
                  page: 8 + index,
                  updatedAt: run.finishedAt,
                  phase: run.state,
                  context: { scope: run.source, profileHandle: run.profileHandle },
                })),
            };
          case 'ACTIVE_X_TAB':
            return { ok: true, tab: null };
          case 'HEALTH_CHECK':
            return { ok: true, checks: { queue: {}, queueErrors: 0, templates: 0 } };
          case 'GET_INTEGRITY':
            return { ok: true, report: { summary: {} } };
          case 'BULK_UPDATE_TWEET_META': {
            const ids = [...new Set((message.ids || []).map(String))],
              patch = message.patch || {},
              updatedRows = [];
            for (const id of ids) {
              const row = rowById.get(id);
              if (!row) continue;
              const meta = { ...(row.userMeta || {}) };
              if (typeof patch.favorite === 'boolean') meta.favorite = patch.favorite;
              if (typeof patch.colorLabel === 'string') meta.colorLabel = patch.colorLabel.slice(0, 24);
              if (typeof patch.reviewed === 'boolean') {
                if (patch.reviewed) meta.reviewedAt = Date.now();
                else delete meta.reviewedAt;
              }
              if (typeof patch.removeTag === 'string' && meta.tags?.length)
                meta.tags = meta.tags.filter(tag => tag !== patch.removeTag.trim().replace(/^#/, ''));
              const tag =
                typeof patch.addTag === 'string' ? patch.addTag.trim().replace(/^#/, '').trim().slice(0, 40) : '';
              if (tag) meta.tags = [...new Set([...(meta.tags || []), tag])];
              row.userMeta = meta;
              row.updatedAt = Date.now();
              updatedRows.push(row);
            }
            if (updatedRows.length) libraryRevision++;
            return { ok: true, updated: updatedRows.length, rows: updatedRows };
          }
          case 'UPDATE_TWEET_META': {
            const post = rowById.get(String(message.id));
            if (!post) return { ok: false, error: 'Post unavailable' };
            if (
              message.patch?.note != null &&
              message.expectedNote !== undefined &&
              (post.userMeta?.note || '') !== message.expectedNote &&
              post.userMeta?.note !== message.patch.note
            )
              return { ok: false, conflict: true, row: structuredClone(post) };
            post.userMeta = { ...post.userMeta, ...message.patch };
            libraryRevision++;
            return { ok: true, row: { ...post } };
          }
          case 'MOVE_TWEETS_TO_TRASH': {
            const movedIds = [];
            for (const value of message.ids || []) {
              const id = String(value),
                row = rowById.get(id),
                position = rowPositionById.get(id);
              if (!row || position == null) continue;
              trash.set(id, { ...row, deletedAt: Date.now() });
              trashUndo.add(id);
              delete rows[position];
              rowById.delete(id);
              rowPositionById.delete(id);
              activeRowCount--;
              movedIds.push(id);
            }
            if (movedIds.length) {
              libraryRevision++;
              indexedSource = null;
              sortedSource = null;
            }
            return { ok: true, moved: movedIds.length, ids: movedIds, conflicts: [] };
          }
          case 'RESTORE_TWEETS_FROM_TRASH': {
            const restoredIds = [],
              conflicts = [],
              restoredRows = [];
            for (const id of message.ids || [])
              if (trash.has(id)) {
                if (rowById.has(String(id))) {
                  conflicts.push(id);
                  continue;
                }
                const row = { ...trash.get(id) };
                delete row.deletedAt;
                rowPositionById.set(String(id), rows.length);
                rows.push(row);
                rowById.set(String(id), row);
                activeRowCount++;
                restoredRows.push(row);
                trash.delete(id);
                trashUndo.delete(id);
                restoredIds.push(id);
              }
            if (restoredIds.length) libraryRevision++;
            // Restoration changes the source collection after it has been
            // indexed. Force the next synthetic cursor request to rebuild its
            // deterministic ordering just as the browser's IDB index does.
            if (restoredIds.length) {
              indexedSource = null;
              sortedSource = null;
            }
            return { ok: true, restored: restoredIds.length, ids: restoredIds, conflicts, rows: restoredRows };
          }
          case 'GET_TRASH_UNDO':
            return { ok: true, ids: [...trashUndo] };
          case 'GET_LIBRARY_METADATA':
            return {
              ok: true,
              rows: (message.ids || [])
                .map(id => rowById.get(String(id)))
                .filter(Boolean)
                .map(row => ({ id: row.id, userMeta: row.userMeta || {}, updatedAt: row.updatedAt })),
            };
          case 'GET_TRASH_RECORD':
            return { ok: true, row: trash.get(String(message.id)) };
          case 'GET_TRASH_PAGE': {
            const all = [...trash.values()].sort(
              (a, b) => b.deletedAt - a.deletedAt || String(b.id).localeCompare(String(a.id))
            );
            const terms = String(message.query || '')
              .toLowerCase()
              .trim()
              .split(/\s+/)
              .filter(Boolean);
            const matches = all.filter(
              row =>
                (message.afterKey == null ||
                  row.deletedAt < message.afterKey.deletedAt ||
                  (row.deletedAt === message.afterKey.deletedAt && String(row.id) < String(message.afterKey.id))) &&
                terms.every(term =>
                  [
                    row.id,
                    row.text,
                    row.author?.handle,
                    row.author?.name,
                    row.userMeta?.note,
                    ...(row.userMeta?.tags || []),
                  ]
                    .join(' ')
                    .toLowerCase()
                    .includes(term)
                )
            );
            const batch = matches.slice(0, Math.min(100, message.limit || 100)).map(row => {
              const current = rowById.get(String(row.id));
              return {
                ...structuredClone(row),
                mediaCount: row.media?.length || 0,
                conflict: !!current,
                ...(current ? { current: structuredClone(current) } : {}),
              };
            });
            const tail = batch.at(-1);
            return {
              ok: true,
              rows: batch,
              total: all.length,
              done: batch.length === matches.length,
              nextKey: tail ? { id: tail.id, deletedAt: tail.deletedAt } : (message.afterKey ?? null),
            };
          }
          default:
            return { ok: true, rows: [], data: { tweets: activeRows() }, summary: {} };
        }
      },
    },
    storage: {
      local: {
        get: async key => (typeof key === 'string' ? { [key]: storage[key] } : storage),
        set: async patch => Object.assign(storage, patch),
        remove: async key => {
          delete storage[key];
        },
      },
    },
    tabs: { create: async () => ({}), update: async () => ({}) },
  };
})();
