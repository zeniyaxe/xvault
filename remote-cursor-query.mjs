import { readLibraryQueryPage } from './library-storage.mjs';
import './library-search-core.js';

const search = globalThis.XVaultLibrarySearch;

// Remote's common chronological sorts should use the archive index directly.
// One request examines a bounded cursor window and retains only its requested
// result page, so sparse searches can continue from the returned key later.
export async function readRemoteCursorPage(database, options = {}) {
  if (!search) throw new Error('The shared Library search rules are unavailable');
  const query = String(options.query || '').trim();
  if (query.length > 1000) throw new RangeError('Search query is too long');
  const sort = options.sort === 'old' ? 'old' : 'new';
  const limit = Math.max(1, Math.min(50, Math.floor(Number(options.limit) || 40)));
  const scanLimit = Math.max(limit, Math.min(2500, Math.floor(Number(options.scanLimit) || 2500)));
  const compiled = search.compileQuery(query);
  const needsDownloads = compiled.some(rule => ['downloaded', 'missing', 'size'].includes(rule.kind));
  const page = await readLibraryQueryPage(database, {
    sort,
    limit,
    after: options.after || null,
    expectedRevision: options.expectedRevision,
    expectedDownloadRevision: options.expectedDownloadRevision,
    scanLimit,
    downloads: needsDownloads,
    cancelled: options.cancelled,
    match(post, download) {
      if (!query) return true;
      const projection = search.projectPost(post, 0, { inboxSince: options.inboxSince });
      if (download) {
        projection.downloaded = !!download.downloaded;
        projection.missing = !!download.missing;
        projection.knownBytes = Number(download.bytes) || 0;
      }
      return search.matchesCompiledQuery(projection, compiled);
    }
  });
  return {
    ...page,
    matched: page.rows.length,
    scannedThisPage: page.scanned,
    hasMore: page.hasMore && !page.stale && !page.cancelled
  };
}
