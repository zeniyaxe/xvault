/* Pure bulk-download planning rules. Kept independent of IndexedDB and DOM. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XVaultBulkModel = api;
  if (typeof window !== 'undefined') window.XVaultBulkModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const mediaKind = media => {
    const type = String(media?.type || media?.mediaType || '').toLowerCase();
    if (/animated[_ -]?gif|animation/.test(type)) return 'gif';
    if (/gif/.test(type) || /\.gif(?:$|\?)/i.test(media?.url || '')) return 'gif';
    if (/webp/.test(type) || /\.webp(?:$|\?)/i.test(media?.url || '')) return media?.animated ? 'gif' : 'image';
    if (/video|mp4|webm/.test(type) || media?.playbackUrl || media?.variants?.some?.(v => /video\//i.test(v?.contentType || ''))) return 'video';
    if (/image|photo|jpg|jpeg|png|avif/.test(type) || /\.(?:jpe?g|png|webp|avif)(?:$|\?)/i.test(media?.url || '')) return 'image';
    return 'other';
  };
  const isAnimation = media => !!media?.animated || mediaKind(media) === 'gif' || /animated[_ -]?webp|animation|gif/i.test(String(media?.type || media?.mediaType || ''));
  const outputMode = mode => ({
    mp4: { keepMp4: true, gif: false, webp: false },
    gif: { keepMp4: false, gif: true, webp: false },
    webp: { keepMp4: false, gif: false, webp: true },
    'gif-webp': { keepMp4: false, gif: true, webp: true },
    'mp4-gif': { keepMp4: true, gif: true, webp: false },
    'mp4-webp': { keepMp4: true, gif: false, webp: true },
    all: { keepMp4: true, gif: true, webp: true },
  }[mode] || { keepMp4: true, gif: true, webp: true });
  const typeAllowed = (media, filter = 'all') => {
    const kind = mediaKind(media), animation = isAnimation(media);
    return filter === 'all' || (filter === 'images' && kind === 'image' && !animation) || (filter === 'videos' && kind === 'video' && !animation) || (filter === 'animations' && animation) || (filter === 'animated-webp' && /webp/i.test(String(media?.type || media?.mediaType || '')) && animation) || (filter === 'gif-webp' && animation) || (filter === 'images-animation' && (kind === 'image' || animation)) || (filter === 'videos-animation' && (kind === 'video' || animation));
  };
  const mediaKey = (post, media, index = 0) => `${post?.id || ''}|${media?.id || media?.url || media?.playbackUrl || index}`;
  const requestedOutputs = (media, mode = 'all') => isAnimation(media) ? outputMode(mode) : { keepMp4: false, gif: false, webp: false };
  const matchesScope = (post, options = {}) => {
    const scope = options.scope || 'all', id = String(post?.id || '');
    if (scope === 'selected' && !(options.selectedSet || new Set((options.selectedIds || []).map(String))).has(id)) return false;
    if (scope === 'favorites' && !post?.userMeta?.favorite) return false;
    if (scope === 'author' && String(post?.author?.handle || '').replace(/^@/, '').toLowerCase() !== String(options.author || '').replace(/^@/, '').toLowerCase()) return false;
    if (scope === 'tag' && !(post?.userMeta?.tags || []).some(tag => String(tag).toLowerCase() === String(options.tag || '').replace(/^#/, '').toLowerCase())) return false;
    const date = post?.createdAt || post?.archivedAt || 0;
    const at = typeof date === 'number' ? date : Number(date) || Date.parse(date) || 0;
    if (options.dateFrom && at < Number(options.dateFrom)) return false;
    if (options.dateTo && at > Number(options.dateTo)) return false;
    return typeof options.matchesQuery === 'function' ? options.matchesQuery(post) : true;
  };
  function plan(posts = [], downloads = new Map(), options = {}) {
    options = { ...options, selectedSet: new Set((options.selectedIds || []).map(String)) };
    const totals = { postsScanned: 0, postsMatched: 0, media: 0, images: 0, videos: 0, animations: 0, animatedWebP: 0, bytes: 0, knownBytes: 0, alreadyLocal: 0, missing: 0, failed: 0, conversionRequired: 0, gifConversions: 0, webpConversions: 0, selected: 0 };
    const items = [];
    const policy = options.existingPolicy || 'skip', mode = options.animationMode || 'all';
    for (const post of posts) {
      totals.postsScanned++;
      if (!matchesScope(post, options)) continue;
      totals.postsMatched++;
      for (const [index, media] of (post.media || []).entries()) {
        if (!typeAllowed(media, options.mediaFilter || 'all')) continue;
        const key = mediaKey(post, media, index), rows = downloads.get(key) || downloads.get(`${post.id}|${media.id || media.url || media.playbackUrl || index}`) || downloads.get(String(post.id)) || [];
        const complete = rows.some(row => row.state === 'complete' && !['mismatch', 'corrupt', 'missing'].includes(row.verification?.state || row.verificationState));
        const failed = rows.some(row => row.state === 'failed' || ['mismatch', 'corrupt', 'missing'].includes(row.verification?.state || row.verificationState));
        const outputs = requestedOutputs(media, mode), hasConversion = outputs.gif || outputs.webp;
        if (options.onlyMissing && complete) continue;
        if (options.onlyFailed && !failed) continue;
        if (options.onlyDownloaded && !complete) continue;
        totals.media++; totals.selected++;
        const kind = mediaKind(media); if (kind === 'image' && !isAnimation(media)) totals.images++; else if (kind === 'video' && !isAnimation(media)) totals.videos++; else if (isAnimation(media)) totals.animations++;
        if (/webp/i.test(String(media?.type || media?.mediaType || '')) && isAnimation(media)) totals.animatedWebP++;
        const size = Number(media?.size || media?.bytes || media?.contentLength || 0); totals.bytes += size; totals.knownBytes += size > 0 ? size : 0;
        if (complete) totals.alreadyLocal++; if (!complete && !failed) totals.missing++; if (failed) totals.failed++;
        if (hasConversion) { totals.conversionRequired++; if (outputs.gif) totals.gifConversions++; if (outputs.webp) totals.webpConversions++; }
        if (complete && policy === 'skip') continue;
        items.push({ post, media, index, key, outputs, complete, failed, size });
      }
    }
    totals.estimatedBytes = totals.bytes || null;
    totals.needDownload = Math.max(0, totals.media - totals.alreadyLocal);
    return { totals, items };
  }
  return Object.freeze({ mediaKind, isAnimation, outputMode, typeAllowed, mediaKey, requestedOutputs, matchesScope, plan });
});
