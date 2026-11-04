/* Small, deterministic helpers for exporting canonical Library post links. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XVaultLinkExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PROVIDERS = Object.freeze({
    fixvx: 'fixvx.com',
    fixupx: 'fixupx.com',
    fxtwitter: 'fxtwitter.com',
    vxtwitter: 'vxtwitter.com',
    x: 'x.com',
    twitter: 'twitter.com',
  });

  function validHost(value) {
    try {
      const raw = String(value || '').trim();
      if (!raw) return null;
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
      return url.hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  function providerHost(settings = {}) {
    const provider = settings.linkProvider || 'fixvx';
    return provider === 'custom' ? validHost(settings.customLinkHost) : PROVIDERS[provider] || PROVIDERS.fixvx;
  }

  function canonicalLink(post, settings = {}, linkProvider = null) {
    if (!post || post.id == null || !/^\d+$/.test(String(post.id))) return null;
    const source = String(post.url || `https://x.com/${post.author?.handle || post.handle || ''}/status/${post.id}`);
    if (typeof linkProvider?.transform === 'function') {
      const result = linkProvider.transform(source, settings);
      return result && linkProvider.status(source)?.id === String(post.id) ? result : null;
    }
    const host = providerHost(settings);
    if (!host) return null;
    let parsed;
    try {
      parsed = new URL(source);
    } catch {
      return null;
    }
    const match = parsed.pathname.match(/^\/([^/?#]+)\/status\/(\d+)(\/[^?#]*)?$/);
    if (!match || match[2] !== String(post.id)) return null;
    const out = new URL(
      `https://${host}/${encodeURIComponent(decodeURIComponent(match[1]))}/status/${match[2]}${match[3] || ''}`
    );
    if (settings.copyPreserveQuery === true || settings.copyStripTracking === false) {
      const tracking = /^(utm_|ref$|ref_src$|s$|t$|cxt$|cn$)/i;
      for (const [key, value] of parsed.searchParams)
        if (settings.copyStripTracking === false || !tracking.test(key)) out.searchParams.append(key, value);
    }
    return out.href;
  }

  function collectLinks(posts, settings = {}, signal, linkProvider = null) {
    const ids = new Set(),
      links = [];
    let duplicates = 0,
      skipped = 0;
    for (const post of posts || []) {
      if (signal?.aborted) throw new Error('Export cancelled');
      const id = post?.id == null ? '' : String(post.id);
      if (!id || !/^\d+$/.test(id)) {
        skipped++;
        continue;
      }
      const url = canonicalLink(post, settings, linkProvider);
      if (!url) {
        skipped++;
        continue;
      }
      if (ids.has(id)) {
        duplicates++;
        continue;
      }
      ids.add(id);
      links.push(url);
    }
    return { links, duplicates, skipped };
  }

  function formatLinks(links, perBlock = 5) {
    const blockSize = Number(perBlock);
    if (!links?.length) return '';
    const lines = links.map(url => String(url));
    if (!Number.isFinite(blockSize) || blockSize <= 0) return lines.join('\n');
    const blocks = [];
    for (let index = 0; index < lines.length; index += Math.floor(blockSize))
      blocks.push(lines.slice(index, index + Math.floor(blockSize)).join('\n'));
    return blocks.join('\n\n');
  }

  function selectScope(matching, scope = 'all', selectedIds = [], currentPage = []) {
    if (scope === 'selected') {
      const selected = new Set([...selectedIds].map(String));
      return matching.filter(post => selected.has(String(post?.id)));
    }
    if (scope === 'page') return currentPage;
    return matching;
  }

  function sanitizeFilename(query, count) {
    const safeQuery =
      String(query || 'Library search')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .replace(/[. ]+$/g, '')
        .replace(/\s+/gu, ' ')
        .trim() || 'Library search';
    const suffix = ` — ${Number(count) || 0} posts.txt`;
    const maxQueryLength = Math.max(1, 180 - suffix.length);
    let prefix = safeQuery;
    if (prefix.length > maxQueryLength) prefix = `${prefix.slice(0, maxQueryLength - 1).trimEnd()}…`;
    return `${prefix}${suffix}`;
  }

  return Object.freeze({
    validHost,
    providerHost,
    canonicalLink,
    collectLinks,
    formatLinks,
    selectScope,
    sanitizeFilename,
  });
});
