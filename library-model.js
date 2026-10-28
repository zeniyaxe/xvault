/* Pure Library rules shared by the dashboard and regression tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XVaultLibraryModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const _asset = (typeof globalThis !== 'undefined' && globalThis.XVaultMediaAsset) || (typeof require === 'function' ? (() => { try { return require('./media-asset.js'); } catch { return null; } })() : null);
  const sameMedia = (a, b) => a === b || Boolean(a && b && _asset && _asset.sameAsset(a, b));
  function isDownloaded(post, downloadMap) {
    return (downloadMap.get(String(post.id)) || []).some(row => row.state === 'complete' &&
      !['mismatch', 'corrupt', 'missing'].includes(row.verification?.state || row.verificationState));
  }

  function downloadedMediaCount(post, downloadMap) {
    const media = post.media || [];
    if (!media.length) return 0;
    const rows = downloadMap.get(String(post.id)) || [];
    return media.filter(item => rows.some(row => {
      if (row.state !== 'complete' || ['mismatch', 'corrupt', 'missing'].includes(row.verification?.state || row.verificationState)) return false;
      if (item.id && row.item?.mediaId && String(item.id) === String(row.item.mediaId)) return true;
      const urls = [item.url, item.playbackUrl, ...(item.variants || []).map(variant => variant.url)].filter(Boolean);
      return urls.some(url => sameMedia(url, row.item?.url));
    })).length;
  }
  function hasMissingMedia(post,downloadMap){return(post.media||[]).length>downloadedMediaCount(post,downloadMap)}

  // Inbox: posts archived after the cut-off that the user has not yet reviewed.
  function isInbox(post, since) {
    const cutoff = Number(since) || 0;
    return cutoff > 0 && Number(post?.archivedAt || 0) >= cutoff && !post?.userMeta?.reviewedAt;
  }

  function paginate(rows, index, requestedSize) {
    // Honor the existing Settings control (50–1500) instead of silently
    // rendering fewer rows than the user requested.
    const size = Math.max(50, Math.min(1500, Number(requestedSize) || 300));
    const pages = Math.max(1, Math.ceil(rows.length / size));
    const pageIndex = Math.max(0, Math.min(pages - 1, Number(index) || 0));
    const start = pageIndex * size;
    return { rows: rows.slice(start, start + size), start, pageIndex, pages, total: rows.length };
  }

  function sortPosts(rows, value) {
    const metric = { likes: 'likes', views: 'views', bookmarks: 'bookmarks', reposts: 'reposts', replies: 'replies' }[value];
    return [...rows].sort((a, b) => metric ? Number(b.metrics?.[metric] || 0) - Number(a.metrics?.[metric] || 0)
      : value === 'old' ? Number(a.archivedAt || 0) - Number(b.archivedAt || 0)
      : value === 'media' ? (b.media?.length || 0) - (a.media?.length || 0)
      : value === 'author' ? String(a.author?.handle || '').localeCompare(String(b.author?.handle || ''))
      : value === 'random' ? Number(a.randomOrder ?? 0) - Number(b.randomOrder ?? 0)
      : Number(b.archivedAt || 0) - Number(a.archivedAt || 0));
  }

  function virtualWindow(count, scrollTop, viewportHeight, rowHeight = 76, overscan = 3) {
    const total = Math.max(0, Math.floor(Number(count) || 0));
    const height = Math.max(1, Number(rowHeight) || 76);
    const viewport = Math.max(0, Number(viewportHeight) || 0);
    const top = Math.max(0, Math.min(Math.max(0, total * height - viewport), Number(scrollTop) || 0));
    const extra = Math.max(0, Math.floor(Number(overscan) || 0));
    const start = Math.max(0, Math.floor(top / height) - extra);
    const end = Math.min(total, Math.ceil((top + viewport) / height) + extra);
    return { start, end, before: start * height, after: (total - end) * height };
  }

  function replaceSelection(ids) {
    return new Set([...(ids || [])].filter(id => id != null).map(String));
  }

  function addSelection(current, ids) {
    const next = new Set([...(current || [])].filter(id => id != null).map(String));
    for (const id of ids || []) if (id != null) next.add(String(id));
    return next;
  }

  function invertSelection(current, ids) {
    const next = new Set([...(current || [])].filter(id => id != null).map(String));
    for (const id of new Set([...(ids || [])].filter(id => id != null).map(String))) {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    }
    return next;
  }

  function applySelectionRange(selection, rows, anchorId, targetId, checked) {
    const anchor = String(anchorId), target = String(targetId);
    let start = -1, end = -1;
    for (let index = 0; index < rows.length; index++) {
      const id = rows[index]?.id;
      if (id == null) continue;
      const normalized = String(id);
      if (normalized === anchor) start = index;
      if (normalized === target) end = index;
      if (start >= 0 && end >= 0) break;
    }
    if (start < 0 || end < 0) return false;
    for (let index = Math.min(start, end), last = Math.max(start, end); index <= last; index++) {
      const id = rows[index]?.id;
      if (id == null) continue;
      if (checked) selection.add(String(id));
      else selection.delete(String(id));
    }
    return true;
  }

  function createMediaResourcePool({ create, revoke }) {
    const entries = new Map();
    return Object.freeze({
      get(path) { return entries.get(path)?.url || null; },
      add(path, blob) {
        if (entries.has(path)) return entries.get(path).url;
        const url = create(blob);
        entries.set(path, { url, owners: new Set() });
        return url;
      },
      attach(path, owner) {
        const entry = entries.get(path);
        if (!entry) return null;
        entry.owners.add(owner);
        return entry.url;
      },
      detach(path, owner) {
        const entry = entries.get(path);
        if (!entry) return;
        entry.owners.delete(owner);
        if (entry.owners.size) return;
        revoke(entry.url);
        entries.delete(path);
      },
      collect() {
        for (const [path, entry] of entries) {
          if (entry.owners.size) continue;
          revoke(entry.url);
          entries.delete(path);
        }
      },
      clear() {
        for (const entry of entries.values()) revoke(entry.url);
        entries.clear();
      }
    });
  }

  function destinationQuery(id) {
    const queries = {
      all: '', inbox: 'inbox:true', favorites: 'fav:true', untagged: 'untagged:true', images: 'type:image', videos: 'type:video',
      animations: 'type:gif', local: 'downloaded:true', missing: 'missing:true'
    };
    return Object.hasOwn(queries, id) ? queries[id] : null;
  }

  return Object.freeze({ isInbox, isDownloaded, hasMissingMedia, downloadedMediaCount, paginate, sortPosts, virtualWindow, replaceSelection, addSelection, invertSelection, applySelectionRange, createMediaResourcePool, destinationQuery });
});
