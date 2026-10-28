/* Stable per-media metadata and portable, conflict-preserving JSON sidecars. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XVaultMediaMetadata = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SIDECAR_FORMAT = 'xvault-media-sidecar';
  const SIDECAR_VERSION = 1;
  const MAX_MEDIA = 500;
  const MAX_ANNOTATIONS = 2000;
  const MAX_ANNOTATION_TEXT = 10000;

  function text(value, max = 100000) {
    return typeof value === 'string' ? value.slice(0, max) : '';
  }

  function safeMediaUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
      if (url.username || url.password) return '';
      const host = url.hostname.toLowerCase();
      if (host === 'pbs.twimg.com') {
        const format = url.searchParams.get('format');
        return `${host}${url.pathname}${format ? `?format=${encodeURIComponent(format)}` : ''}`;
      }
      if (host === 'video.twimg.com') return `${host}${url.pathname}`;
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:sig|signature|token|access_token|auth|authorization|expires?|expiry|key|policy|hmac|jwt|hdnea|x-amz-.+|x-goog-.+)$/i.test(key)) url.searchParams.delete(key);
      }
      return url.href;
    } catch { return ''; }
  }

  function safeHttpUrl(value, field, max = 4096) {
    if (value == null || value === '') return '';
    if (typeof value !== 'string' || value.length > max) throw new TypeError(`${field} must be an HTTP or HTTPS URL`);
    let url;
    try { url = new URL(value); } catch { throw new TypeError(`${field} must be an HTTP or HTTPS URL`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError(`${field} must be a credential-free HTTP or HTTPS URL`);
    return value;
  }

  function portableMediaUrl(value) {
    const safe = safeMediaUrl(value);
    if (!safe) return '';
    if (/^https?:\/\//i.test(safe)) return safe;
    try { return `${new URL(String(value)).protocol}//${safe}`; } catch { return ''; }
  }

  function portableProvenance(rows = []) {
    return (Array.isArray(rows) ? rows : []).slice(-100).filter(value => value && typeof value === 'object' && !Array.isArray(value)).map(value => ({
      source: text(value.source || value.type, 160), capturedAt: Number(value.capturedAt || value.at) || null,
      runId: text(value.runId, 128) || null, captureId: text(value.captureId, 128) || null, mediaId: text(value.mediaId, 512) || null,
      ...(value.type ? { type: text(value.type, 80) } : {}),
      ...(safeMediaUrl(value.url) ? { url: portableMediaUrl(value.url) } : {}),
      ...(safeMediaUrl(value.playbackUrl) ? { playbackUrl: portableMediaUrl(value.playbackUrl) } : {}),
      ...(Number(value.width) > 0 ? { width: Number(value.width) } : {}), ...(Number(value.height) > 0 ? { height: Number(value.height) } : {})
    }));
  }

  function mediaKey(postId, media = {}, index = 0) {
    const post = encodeURIComponent(String(postId || 'unknown'));
    const stored = text(media?.xvault?.mediaKey, 512);
    if (stored.startsWith(`post/${post}/asset/`)) return stored;
    const identity = media?.assetId ?? media?.id;
    const asset = identity != null && String(identity).trim()
      ? `id/${encodeURIComponent(String(identity).trim())}`
      : safeMediaUrl(media?.url || media?.playbackUrl)
        ? `url/${encodeURIComponent(safeMediaUrl(media?.url || media?.playbackUrl))}`
        : `position/${Math.max(0, Math.floor(Number(index) || 0))}/${encodeURIComponent(text(media?.type || 'media', 40))}`;
    return `post/${post}/asset/${asset}`;
  }

  function metadataFor(media = {}) {
    const meta = media?.xvault && typeof media.xvault === 'object' && !Array.isArray(media.xvault) ? media.xvault : {};
    return {
      mediaKey: text(meta.mediaKey, 512),
      note: text(meta.note),
      tags: Array.isArray(meta.tags) ? meta.tags.filter(value => typeof value === 'string').map(value => value.slice(0, 80)) : [],
      source: text(meta.source, 1000),
      sourceUrl: text(meta.sourceUrl, 2048),
      annotations: Array.isArray(meta.annotations) ? meta.annotations : [],
      provenance: Array.isArray(meta.provenance) ? meta.provenance : [],
      derivatives: Array.isArray(meta.derivatives) ? meta.derivatives : [],
      importConflicts: Array.isArray(meta.importConflicts) ? meta.importConflicts : []
    };
  }

  function canTimestamp(media = {}) {
    return ['video', 'animated_gif', 'animated_webp', 'gif'].includes(String(media?.type || '').toLowerCase()) || Number(media?.duration) > 0;
  }

  function derivativeSourceState(media = {}, sourceUrl = '') {
    const source = safeMediaUrl(sourceUrl);
    if (!source) return 'unknown';
    const current = [media?.url, media?.playbackUrl, ...(Array.isArray(media?.variants) ? media.variants.map(value => value?.url) : [])]
      .map(safeMediaUrl).filter(Boolean);
    return current.includes(source) ? 'current' : 'stale';
  }

  function validateAnnotation(annotation) {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) throw new TypeError('Annotation must be an object');
    const id = text(annotation.id, 128).trim();
    const atMs = Number(annotation.atMs);
    const body = text(annotation.text, MAX_ANNOTATION_TEXT);
    if (!id) throw new TypeError('Annotation ID is required');
    if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs > 315576000000) throw new RangeError('Annotation timestamp must be an exact millisecond offset');
    if (!body.trim()) throw new TypeError('Annotation text cannot be empty');
    if (String(annotation.text || '').length > MAX_ANNOTATION_TEXT) throw new RangeError('Annotation text is too long');
    const position = Number.isFinite(Number(annotation.position)) ? Math.max(0, Math.floor(Number(annotation.position))) : 0;
    return {
      id, atMs, text: body, position,
      createdAt: Number.isFinite(Number(annotation.createdAt)) ? Number(annotation.createdAt) : 0,
      updatedAt: Number.isFinite(Number(annotation.updatedAt)) ? Number(annotation.updatedAt) : 0,
      ...(Number(annotation.deletedAt) > 0 ? { deletedAt: Number(annotation.deletedAt) } : {})
    };
  }

  function formatTimestamp(value) {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const ms = total % 1000;
    const totalSeconds = Math.floor(total / 1000);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60) % 60;
    const hours = Math.floor(totalSeconds / 3600);
    const clock = hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${Math.floor(totalSeconds / 60)}:${String(seconds).padStart(2, '0')}`;
    return `${clock}.${String(ms).padStart(3, '0')}`;
  }

  function baseName(path) {
    return text(String(path || '').replace(/\\/g, '/').split('/').at(-1) || '', 240);
  }

  function same(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }

  function uniqueRows(current = [], incoming = [], key = value => JSON.stringify(value)) {
    const values = Array.isArray(current) ? current.slice() : [];
    const seen = new Set(values.map(key));
    for (const value of Array.isArray(incoming) ? incoming : []) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const identity = key(value);
      if (!seen.has(identity)) { values.push(value); seen.add(identity); }
    }
    return values;
  }

  function groupDownloadsByMedia(postId, mediaRows = [], downloads = []) {
    const mediaById = new Map(), mediaByUrl = new Map();
    const add = (map, value, index) => {
      if (!value) return;
      const key = String(value), indexes = map.get(key) || [];
      indexes.push(index);
      map.set(key, indexes);
    };
    mediaRows.forEach((media, index) => {
      if (media?.id) add(mediaById, media.id, index);
      for (const url of [media?.url, media?.playbackUrl, ...(Array.isArray(media?.variants) ? media.variants.map(value => value?.url) : [])]) add(mediaByUrl, url, index);
    });
    const grouped = mediaRows.map(() => []), id = String(postId || '');
    for (const row of Array.isArray(downloads) ? downloads : []) {
      const item = row?.item;
      if (String(item?.tweetId || '') !== id) continue;
      const matches = new Set();
      if (item?.mediaId) for (const index of mediaById.get(String(item.mediaId)) || []) matches.add(index);
      if (item?.url) for (const index of mediaByUrl.get(String(item.url)) || []) matches.add(index);
      for (const index of matches) grouped[index].push(row);
    }
    return grouped;
  }

  function derivativeEvidence(media, row) {
    const entries = Array.isArray(row?.conversionVerification?.outputs) ? row.conversionVerification.outputs : [];
    const helper = row?.helper || {};
    const specs = [
      ['gif', row?.convertedGifPath || row?.convertedGifFileUrl || helper.gif?.path || helper.gifOutput?.path, row?.convertedGifSize || helper.gif?.size || entries.find(item => item.label === 'gif')?.size],
      ['webp', row?.convertedWebPPath || row?.convertedWebPFileUrl || helper.webp?.path || helper.webpOutput?.path, row?.convertedWebPSize || helper.webp?.size || entries.find(item => item.label === 'webp')?.size]
    ];
    return specs.filter(([, path]) => path).map(([format, path, size]) => {
      const output = entries.find(item => item.label === format) || {};
      const helperOutput = helper[format] || {};
      return {
        id: `${mediaKey(row?.item?.tweetId, media)}:${format}:${Number(size) || 0}:${baseName(path)}`,
        format,
        fileName: baseName(path),
        size: Math.max(0, Number(size || output.size || helperOutput.size) || 0),
        state: text(output.state || helperOutput.state || row?.conversionState || row?.verification?.state || 'available', 48),
        ...(Number(output.removedAt || helperOutput.removedAt) > 0 ? { removedAt: Number(output.removedAt || helperOutput.removedAt) } : {}),
        sourceGeneration: text(row?.sourceGeneration,128),sourceMediaKey: mediaKey(row?.item?.tweetId, media),
        sourceLocator: safeMediaUrl(row?.item?.url)
      };
    });
  }

  function sidecarPost(post) {
    const author = post?.author && typeof post.author === 'object' ? post.author : {};
    const media = (Array.isArray(post?.media) ? post.media : []).slice(0, MAX_MEDIA).map(item => ({
      id: item?.id || null, assetId: item?.assetId || null, type: text(item?.type, 80), url: portableMediaUrl(item?.url), playbackUrl: portableMediaUrl(item?.playbackUrl),
      preview: portableMediaUrl(item?.preview), width: Number(item?.width) || null, height: Number(item?.height) || null, duration: Number(item?.duration) || null,
      codec: text(item?.codec, 120), container: text(item?.container, 120),
      variants: (Array.isArray(item?.variants) ? item.variants : []).slice(0, 100).map(variant => ({ url: portableMediaUrl(variant?.url), contentType: text(variant?.contentType || variant?.type, 120), bitrate: Number(variant?.bitrate) || null })),
      provenance: portableProvenance(item?.provenance)
    }));
    const userMeta = post?.userMeta || {};
    return {
      id: text(String(post?.id || ''), 128), url: safeHttpUrl(post?.url, 'Post URL'), text: text(post?.text),
      author: { id: author.id || null, handle: text(author.handle, 160), name: text(author.name, 500), avatar: portableMediaUrl(author.avatar), verified: !!author.verified },
      createdAt: post?.createdAt || null, archivedAt: Number(post?.archivedAt) || 0, firstSeenAt: Number(post?.firstSeenAt) || 0, lastSeenAt: Number(post?.lastSeenAt) || 0,
      metrics: post?.metrics && typeof post.metrics === 'object' ? { ...post.metrics } : {}, media,
      userMeta: { note: text(userMeta.note), tags: Array.isArray(userMeta.tags) ? userMeta.tags.filter(tag => typeof tag === 'string') : [], favorite: !!userMeta.favorite, colorLabel: text(userMeta.colorLabel, 40), reviewedAt: Number(userMeta.reviewedAt) || null },
      sensitive: !!post?.sensitive, replyToId: post?.replyToId || null, conversationId: post?.conversationId || null, quotedPostId: post?.quotedPostId || null, retweetedPostId: post?.retweetedPostId || null,
      provenance: portableProvenance(post?.provenance), sourceFlags: Array.isArray(post?.sourceFlags) ? post.sourceFlags.map(value => text(value, 160)).slice(0, 100) : [], archiveSources: Array.isArray(post?.archiveSources) ? post.archiveSources.map(value => text(value, 160)).slice(0, 100) : []
    };
  }

  function buildMediaSidecar(post, downloads = [], exportedAt = Date.now()) {
    const rows = Array.isArray(post?.media) ? post.media : [];
    if (rows.length > MAX_MEDIA) throw new RangeError(`This post has more than ${MAX_MEDIA} media items; export smaller sidecars to avoid losing evidence`);
    for (const item of rows) {
      if ((item?.variants || []).length > 100) throw new RangeError('A media item has more than 100 source variants; export is stopped to preserve every variant');
      if (String(item?.xvault?.note || '').length > 100000) throw new RangeError('A media note exceeds the 100,000 character portable limit');
    }
    const snapshot = sidecarPost(post || {});
    if (!snapshot.id) throw new TypeError('A sidecar needs an archived post ID');
    const downloadsByMedia = groupDownloadsByMedia(snapshot.id, rows, downloads);
    const sidecar = {
      format: SIDECAR_FORMAT, version: SIDECAR_VERSION,
      sidecarId: globalThis.crypto?.randomUUID?.() || `xv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      exportedAt: new Date(Number(exportedAt) || Date.now()).toISOString(),
      post: snapshot,
      media: rows.slice(0, MAX_MEDIA).map((item, index) => {
        const key = mediaKey(snapshot.id, item, index), metadata = metadataFor(item);
        const rowsForMedia = downloadsByMedia[index] || [];
        const derivatives = uniqueRows(metadata.derivatives, rowsForMedia.flatMap(row => derivativeEvidence(item, row)), value => String(value.id || JSON.stringify(value)));
        return {
          key, original: { id: item?.id || null, assetId: item?.assetId || null, type: text(item?.type, 80), url: portableMediaUrl(item?.url), playbackUrl: portableMediaUrl(item?.playbackUrl), width: Number(item?.width) || null, height: Number(item?.height) || null, duration: Number(item?.duration) || null, codec: text(item?.codec, 120), container: text(item?.container, 120) },
          metadata: { note: metadata.note, tags: metadata.tags, source: metadata.source, sourceUrl: metadata.sourceUrl, annotations: metadata.annotations.map(validateAnnotation), provenance: portableProvenance(metadata.provenance), derivatives },
          capturedProvenance: portableProvenance(item?.provenance),
          originals: rowsForMedia.filter(row => row.state === 'complete').map(row => ({ sourceGeneration: text(row.sourceGeneration||row.association?.sourceGeneration,128), shared: row.association?.kind==='shared', ownerPostId: text(row.association?.ownerPostId||snapshot.id,32), fileName: baseName(row.filename || row.target?.filename || row.item?.filename), size: Math.max(0, Number(row.totalBytes) || 0), verification: text(row.verification?.state || row.verificationState || 'unknown', 48) })).filter(row => row.fileName || row.size)
        };
      })
    };
    validateSidecar(sidecar);
    return sidecar;
  }

  function validateSidecar(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== SIDECAR_FORMAT || value.version !== SIDECAR_VERSION) throw new TypeError('Unsupported XVault media sidecar format or version');
    if (!value.post || typeof value.post !== 'object' || !String(value.post.id || '').trim() || String(value.post.id).length > 128) throw new TypeError('Sidecar post ID is missing or invalid');
    if (String(value.post.text || '').length > 100000 || String(value.post.userMeta?.note || '').length > 100000 || (value.post.userMeta?.tags || []).length > 500) throw new RangeError('Sidecar post metadata is too large');
    if ((value.post.media || []).length > MAX_MEDIA) throw new RangeError('Sidecar post media list is too large');
    if (!Array.isArray(value.media) || value.media.length > MAX_MEDIA) throw new RangeError('Sidecar media list is missing or too large');
    if (!String(value.sidecarId || '').trim() || String(value.sidecarId).length > 128) throw new TypeError('Sidecar identity is missing or invalid');
    const keys = new Set();
    for (const entry of value.media) {
      if (!entry || typeof entry !== 'object' || typeof entry.key !== 'string' || !entry.key || entry.key.length > 512 || keys.has(entry.key)) throw new TypeError('Sidecar media identity is invalid or duplicated');
      keys.add(entry.key);
      const meta = entry.metadata;
      if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new TypeError('Sidecar media metadata is invalid');
      for (const field of ['note', 'source', 'sourceUrl']) if (meta[field] != null && typeof meta[field] !== 'string') throw new TypeError(`Sidecar ${field} must be text`);
      if (String(meta.note || '').length > 100000 || String(meta.source || '').length > 1000 || String(meta.sourceUrl || '').length > 2048) throw new RangeError('Sidecar metadata field is too long');
      if (meta.sourceUrl) safeHttpUrl(meta.sourceUrl, 'Media source URL', 2048);
      if (!Array.isArray(meta.tags) || meta.tags.length > 200 || meta.tags.some(tag => typeof tag !== 'string' || tag.length > 80)) throw new RangeError('Sidecar tags are invalid or too large');
      if (!Array.isArray(meta.annotations) || meta.annotations.length > MAX_ANNOTATIONS) throw new RangeError('Sidecar annotation list is invalid or too large');
      for (const annotation of meta.annotations) validateAnnotation(annotation);
      for (const field of ['provenance', 'derivatives']) if (meta[field] != null && (!Array.isArray(meta[field]) || meta[field].length > 5000)) throw new RangeError(`Sidecar ${field} is invalid or too large`);
      for (const value of [entry.original?.url, entry.original?.playbackUrl]) if (value) safeHttpUrl(value, 'Media URL');
      for (const field of ['codec', 'container']) if (entry.original?.[field] != null && (typeof entry.original[field] !== 'string' || entry.original[field].length > 120)) throw new RangeError(`Sidecar media ${field} is invalid or too long`);
      if (entry.original?.duration != null && (!Number.isFinite(Number(entry.original.duration)) || Number(entry.original.duration) < 0)) throw new RangeError('Sidecar media duration is invalid');
    }
    safeHttpUrl(value.post.url, 'Post URL');
    safeHttpUrl(value.post.author?.avatar, 'Author avatar URL');
    const snapshotMedia = Array.isArray(value.post.media) ? value.post.media : [];
    for (const media of snapshotMedia) {
      for (const url of [media?.url, media?.playbackUrl, media?.preview, ...(media?.variants || []).map(variant => variant?.url)]) if (url) safeHttpUrl(url, 'Media URL');
      for (const field of ['codec', 'container']) if (media?.[field] != null && (typeof media[field] !== 'string' || media[field].length > 120)) throw new RangeError(`Sidecar media ${field} is invalid or too long`);
      if (media?.duration != null && (!Number.isFinite(Number(media.duration)) || Number(media.duration) < 0)) throw new RangeError('Sidecar media duration is invalid');
    }
    if (JSON.stringify(value).length > 25 * 1024 * 1024) throw new RangeError('Media sidecar exceeds the 25 MB safety limit');
    return value;
  }

  function addConflict(conflicts, mediaKeyValue, field, local, incoming) {
    conflicts.push({ mediaKey: mediaKeyValue || '', field, local, incoming });
  }

  function planSidecarImport(current, sidecar, trashed = false) {
    validateSidecar(sidecar);
    const id = String(sidecar.post.id);
    if (trashed) return { ok: true, action: 'trashed', postId: id, safeChanges: 0, conflicts: [], orphans: [] };
    if (!current) return { ok: true, action: 'reconstruct', postId: id, safeChanges: sidecar.media.length + 1, conflicts: [], orphans: [] };
    if (String(current.id) !== id) throw new TypeError('Sidecar belongs to a different post');
    if ((current.userMeta?.mediaSidecarImports || []).some(item => item?.sidecarId === sidecar.sidecarId)) return { ok: true, action: 'already-imported', postId: id, safeChanges: 0, conflicts: [], orphans: [] };
    const conflicts = [], orphans = [], matched = [];
    const currentMedia = Array.isArray(current.media) ? current.media : [];
    const currentKeys = currentMedia.map((item, index) => mediaKey(id, item, index));
    let safeChanges = 0;
    const localPost = current;
    const localUser = current.userMeta || {}, incomingUser = sidecar.post.userMeta || {};
    const localPostNote = String(localUser.note || ''), incomingPostNote = String(incomingUser.note || '');
    if (localPostNote && incomingPostNote && localPostNote !== incomingPostNote) addConflict(conflicts, '', 'post.userMeta.note', localPostNote, incomingPostNote);
    else if (!localPostNote && incomingPostNote) safeChanges++;
    const localPostTags = new Set(Array.isArray(localUser.tags) ? localUser.tags : []);
    for (const tag of incomingUser.tags || []) if (!localPostTags.has(tag)) safeChanges++;
    if (incomingUser.favorite === true && localUser.favorite !== true) addConflict(conflicts, '', 'post.userMeta.favorite', !!localUser.favorite, true);
    for (const field of ['colorLabel', 'reviewedAt']) {
      const local = localUser[field], incoming = incomingUser[field];
      const hasLocal = field === 'reviewedAt' ? Number(local) > 0 : String(local || '').length > 0;
      const hasIncoming = field === 'reviewedAt' ? Number(incoming) > 0 : String(incoming || '').length > 0;
      if (hasLocal && hasIncoming && String(local) !== String(incoming)) addConflict(conflicts, '', `post.userMeta.${field}`, local, incoming);
      else if (!hasLocal && hasIncoming) safeChanges++;
    }
    const localAuthor = current.author || {}, incomingAuthor = sidecar.post.author || {};
    for (const field of ['id', 'handle', 'name']) if (localAuthor[field] && incomingAuthor[field] && String(localAuthor[field]) !== String(incomingAuthor[field])) addConflict(conflicts, '', `post.author.${field}`, localAuthor[field], incomingAuthor[field]);
    for (const field of ['likes', 'reposts', 'replies', 'views', 'bookmarks']) {
      const local = current.metrics?.[field], incoming = sidecar.post.metrics?.[field];
      if (local != null && incoming != null && Number(local) !== Number(incoming)) addConflict(conflicts, '', `post.metrics.${field}`, local, incoming);
    }
    for (const field of ['text', 'url', 'createdAt']) {
      const local = localPost[field], incoming = sidecar.post[field];
      if (local != null && local !== '' && incoming != null && incoming !== '' && String(local) !== String(incoming)) addConflict(conflicts, '', `post.${field}`, local, incoming);
    }
    for (const entry of sidecar.media) {
      let index = currentKeys.indexOf(entry.key);
      if (index < 0 && entry.original?.id != null) index = currentMedia.findIndex(item => String(item.id || '') === String(entry.original.id));
      if (index < 0) { orphans.push(entry); continue; }
      matched.push({ index, key: currentKeys[index], entry });
      const media = currentMedia[index], local = metadataFor(media), incoming = entry.metadata;
      for (const field of ['note', 'source', 'sourceUrl']) {
        if (local[field] && incoming[field] && local[field] !== incoming[field]) addConflict(conflicts, currentKeys[index], field, local[field], incoming[field]);
        else if (!local[field] && incoming[field]) safeChanges++;
      }
      const localTags = new Set(local.tags);
      for (const tag of incoming.tags) if (!localTags.has(tag)) safeChanges++;
      const byId = new Map(local.annotations.map(annotation => [String(annotation.id), annotation]));
      for (const annotation of incoming.annotations) {
        const found = byId.get(String(annotation.id));
        if (!found) safeChanges++;
        else if (!same(validateAnnotation(found), validateAnnotation(annotation))) addConflict(conflicts, currentKeys[index], `annotation:${annotation.id}`, found, annotation);
      }
      for (const [field, existing, values] of [['provenance', local.provenance, incoming.provenance || []], ['derivatives', local.derivatives, incoming.derivatives || []]]) {
        const seen = new Set(existing.map(value => String(value?.id || JSON.stringify(value))));
        for (const value of values) if (!seen.has(String(value?.id || JSON.stringify(value)))) safeChanges++;
      }
      const captured = Array.isArray(entry.capturedProvenance) ? entry.capturedProvenance : [];
      const seenCapture = new Set((media.provenance || []).map(value => JSON.stringify(value)));
      for (const value of captured) if (!seenCapture.has(JSON.stringify(value))) safeChanges++;
      const source = entry.original || {};
      for (const field of ['type', 'url', 'width', 'height']) {
        const a = media[field], b = source[field];
        const left = field === 'url' ? safeMediaUrl(a) : a, right = field === 'url' ? safeMediaUrl(b) : b;
        if (a != null && a !== '' && b != null && b !== '' && String(left) !== String(right)) addConflict(conflicts, currentKeys[index], `media.${field}`, a, b);
      }
      for (const field of ['codec', 'container', 'duration']) {
        const local = media[field], incoming = source[field];
        if (local != null && local !== '' && incoming != null && incoming !== '' && String(local) !== String(incoming)) addConflict(conflicts, currentKeys[index], `media.${field}`, local, incoming);
        else if ((local == null || local === '') && incoming != null && incoming !== '') safeChanges++;
      }
    }
    if (orphans.length) safeChanges += orphans.length;
    return { ok: true, action: 'merge', postId: id, safeChanges, conflicts, orphans, matchedMedia: matched.length };
  }

  function applySidecarImport(current, sidecar, now = Date.now(), trashed = false) {
    const plan = planSidecarImport(current, sidecar, trashed);
    if (plan.action === 'trashed' || plan.action === 'already-imported') return { row: current || null, action: plan.action, conflicts: plan.conflicts, safeChanges: 0, orphans: plan.orphans || [] };
    if (plan.action === 'reconstruct') {
      const snapshot = sidecarPost(sidecar.post);
      const sourceRows = Array.isArray(sidecar.post.media) ? sidecar.post.media : [];
      const media = sourceRows.map((item, index) => {
        const key = mediaKey(snapshot.id, item, index), incoming = sidecar.media.find(entry => entry.key === key || (entry.original?.id != null && String(entry.original.id) === String(item.id || '')));
        const entryMeta = incoming?.metadata || {};
        return { ...item, xvault: { mediaKey: key, note: text(entryMeta.note), tags: [...new Set(entryMeta.tags || [])], source: text(entryMeta.source, 1000), sourceUrl: text(entryMeta.sourceUrl, 2048), annotations: (entryMeta.annotations || []).map(validateAnnotation), provenance: entryMeta.provenance || [], derivatives: entryMeta.derivatives || [], importConflicts: [] } };
      });
      const userMeta = snapshot.userMeta || {};
      const next = {
        ...snapshot, media, archivedAt: Number(snapshot.archivedAt) || now, firstSeenAt: Number(snapshot.firstSeenAt) || now, lastSeenAt: Number(snapshot.lastSeenAt) || now,
        userMeta: { ...userMeta, mediaSidecarImports: [...(userMeta.mediaSidecarImports || []), { sidecarId: sidecar.sidecarId, importedAt: now, recovered: true }] },
        archiveSources: [...new Set([...(snapshot.archiveSources || []), 'xvault-sidecar'])], sourceFlags: [...new Set([...(snapshot.sourceFlags || []), 'xvault-sidecar'])],
        recoveryStatus: 'reconstructed-from-metadata-sidecar', updatedAt: now,
        provenance: uniqueRows(snapshot.provenance || [], [{ source: 'xvault-media-sidecar', sidecarId: sidecar.sidecarId, capturedAt: now }])
      };
      return { row: next, action: 'reconstructed', conflicts: [], safeChanges: plan.safeChanges, orphans: [] };
    }

    const media = (current.media || []).map(item => ({ ...item }));
    const conflictsByMedia = new Map();
    for (const conflict of plan.conflicts) {
      if (!conflict.mediaKey) continue;
      const list = conflictsByMedia.get(conflict.mediaKey) || [];
      list.push({ id: `${sidecar.sidecarId}:${conflict.field}`, sidecarId: sidecar.sidecarId, importedAt: now, field: conflict.field, local: conflict.local, incoming: conflict.incoming });
      conflictsByMedia.set(conflict.mediaKey, list);
    }
    for (const entry of sidecar.media) {
      const index = media.findIndex((item, itemIndex) => mediaKey(current.id, item, itemIndex) === entry.key || (entry.original?.id != null && String(item.id || '') === String(entry.original.id)));
      if (index < 0) continue;
      const item = media[index], existing = metadataFor(item), incoming = entry.metadata || {}, key = mediaKey(current.id, item, index);
      const annotations = existing.annotations.map(value => validateAnnotation(value));
      const annotationIds = new Map(annotations.map(value => [value.id, value]));
      for (const annotation of incoming.annotations || []) {
        const normalized = validateAnnotation(annotation), old = annotationIds.get(normalized.id);
        if (!old) { normalized.position = annotations.length; annotations.push(normalized); annotationIds.set(normalized.id, normalized); }
      }
      const meta = {
        ...item.xvault, mediaKey: key,
        note: !existing.note && incoming.note ? text(incoming.note) : existing.note,
        tags: [...new Set([...existing.tags, ...(incoming.tags || []).map(value => text(value, 80))])],
        source: !existing.source && incoming.source ? text(incoming.source, 1000) : existing.source,
        sourceUrl: !existing.sourceUrl && incoming.sourceUrl ? text(incoming.sourceUrl, 2048) : existing.sourceUrl,
        annotations,
        provenance: uniqueRows(existing.provenance, incoming.provenance || []),
        derivatives: uniqueRows(existing.derivatives, incoming.derivatives || [], value => String(value?.id || JSON.stringify(value))),
        importConflicts: uniqueRows(existing.importConflicts, conflictsByMedia.get(key) || [], value => String(value?.id || JSON.stringify(value))),
        version: (Number(item.xvault?.version) || 0) + 1, updatedAt: now
      };
      const technical = {};
      for (const field of ['codec', 'container', 'duration']) if ((item[field] == null || item[field] === '') && entry.original?.[field] != null && entry.original[field] !== '') technical[field] = entry.original[field];
      media[index] = { ...item, ...technical, xvault: meta, provenance: uniqueRows(item.provenance || [], entry.capturedProvenance || []) };
    }
    const currentUser = current.userMeta || {};
    const postConflicts = plan.conflicts.filter(conflict => !conflict.mediaKey).map(conflict => ({ id: `${sidecar.sidecarId}:${conflict.field}`, sidecarId: sidecar.sidecarId, importedAt: now, field: conflict.field, local: conflict.local, incoming: conflict.incoming }));
    const orphanEvidence = plan.orphans.map(entry => ({ sidecarId: sidecar.sidecarId, importedAt: now, key: entry.key, original: entry.original, metadata: entry.metadata, capturedProvenance: entry.capturedProvenance }));
    const row = {
      ...current, media,
      userMeta: {
        ...currentUser,
        note: String(currentUser.note || '') || String(sidecar.post.userMeta?.note || ''),
        tags: [...new Set([...(Array.isArray(currentUser.tags) ? currentUser.tags : []), ...(sidecar.post.userMeta?.tags || [])])],
        ...(!currentUser.colorLabel && sidecar.post.userMeta?.colorLabel ? { colorLabel: sidecar.post.userMeta.colorLabel } : {}),
        ...(!currentUser.reviewedAt && sidecar.post.userMeta?.reviewedAt ? { reviewedAt: sidecar.post.userMeta.reviewedAt } : {}),
        mediaSidecarImports: [...(currentUser.mediaSidecarImports || []), { sidecarId: sidecar.sidecarId, importedAt: now, safeChanges: plan.safeChanges, conflictCount: plan.conflicts.length, orphanCount: plan.orphans.length }],
        mediaSidecarConflicts: uniqueRows(currentUser.mediaSidecarConflicts || [], postConflicts, value => String(value?.id || JSON.stringify(value))),
        mediaSidecarOrphans: uniqueRows(currentUser.mediaSidecarOrphans || [], orphanEvidence, value => `${value?.sidecarId || ''}:${value?.key || ''}`)
      },
      provenance: uniqueRows(current.provenance || [], sidecar.post.provenance || []),
      sourceFlags: [...new Set([...(current.sourceFlags || []), ...(sidecar.post.sourceFlags || [])])],
      archiveSources: [...new Set([...(current.archiveSources || []), ...(sidecar.post.archiveSources || [])])],
      updatedAt: now
    };
    return { row, action: 'merged', conflicts: plan.conflicts, safeChanges: plan.safeChanges, orphans: plan.orphans };
  }

  return { SIDECAR_FORMAT, SIDECAR_VERSION, mediaKey, metadataFor, canTimestamp, derivativeSourceState, validateAnnotation, formatTimestamp, buildMediaSidecar, validateSidecar, planSidecarImport, applySidecarImport };
});
