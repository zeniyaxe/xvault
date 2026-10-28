import './media-metadata.js';

const mediaArchive = globalThis.XVaultMediaMetadata;

function nonNull(values = {}) {
  return Object.fromEntries(Object.entries(values || {}).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

function revisionView(row = {}) {
  return {
    text: row.text || '',
    author: { handle: row.author?.handle || '', name: row.author?.name || '', avatar: row.author?.avatar || '' },
    media: (row.media || []).map(item => ({ id: item.id || '', type: item.type || '', url: item.url || '', playbackUrl: item.playbackUrl || '', width: item.width || null, height: item.height || null })),
    replyToId: row.replyToId || null,
    conversationId: row.conversationId || null,
    sensitive: !!row.sensitive
  };
}

function mediaKey(postId, item, index) { return mediaArchive?.mediaKey(postId, item, index) || String(item?.id || item?.url || item?.playbackUrl || `${item?.type || 'media'}:${index}`); }

function mergeProvenance(current = [], incoming = [], event = null, limit = 24) {
  const identity = item => {
    const parts = [item.source || item.type || '', item.capturedAt || item.at || 0, item.runId || '', item.captureId || '', item.mediaId || '', item.url || '', item.playbackUrl || ''];
    return parts.some(Boolean) ? JSON.stringify(parts) : JSON.stringify(item);
  };
  const prior = new Map();
  for (const item of (Array.isArray(current) ? current.slice(-limit) : [])) {
    if (item && typeof item === 'object' && !Array.isArray(item)) prior.set(identity(item), item);
  }
  const eventKey = event && typeof event === 'object' ? identity(event) : null;
  const addEvent = !!eventKey && !prior.has(eventKey);
  const capacity = Math.max(0, limit - prior.size - (addEvent ? 1 : 0));
  const additional = new Map();
  for (const item of (Array.isArray(incoming) ? incoming.slice(-limit) : [])) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const key = identity(item);
    if (!prior.has(key) && key !== eventKey) additional.set(key, item);
  }
  const retainedIncoming = capacity ? [...additional.values()].slice(-capacity) : [];
  return [...prior.values(), ...retainedIncoming, ...(addEvent ? [event] : [])].slice(-limit);
}

function mergeMediaRows(postId, current = [], incoming = [], observedAt = Date.now(), preferIncoming = true) {
  const media = new Map();
  for (let index = 0; index < current.length; index++) media.set(mediaKey(postId, current[index], index), current[index]);
  for (let index = 0; index < incoming.length; index++) {
    const item = incoming[index];
    if (!item) continue;
    const key = mediaKey(postId, item, index), previous = media.get(key);
    const observation = { source: item.archiveScope || item.source || 'capture', capturedAt: observedAt, runId: item.runId || null, mediaId: key, ...(item.type ? { type: item.type } : {}), ...(item.url ? { url: item.url } : {}), ...(item.playbackUrl ? { playbackUrl: item.playbackUrl } : {}), ...(item.width ? { width: item.width } : {}), ...(item.height ? { height: item.height } : {}) };
    const provenance = mergeProvenance(previous?.provenance, item.provenance, observation, 12);
    // An older observation can contribute a newly discovered derivative and
    // provenance, but its payload cannot replace fields committed by a newer
    // capture of the same media identity.
    const payload = previous
      ? (preferIncoming ? { ...nonNull(previous), ...nonNull(item) } : { ...nonNull(item), ...nonNull(previous) })
      : nonNull(item);
    // Capture sources do not own user-authored media metadata. An older or
    // partial snapshot must not replace notes, annotations, tags, or links.
    const xvault = previous?.xvault || item.xvault;
    media.set(key, { ...payload, ...(xvault ? { xvault } : {}), provenance });
  }
  return [...media.values()];
}

function stamp(row, fields, fallback) {
  for (const field of fields) {
    const value = Number(row?.[field]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

export function mergeCapturedRecord(current, incoming, now = Date.now()) {
  const id = String(incoming?.id || current?.id || '');
  if (!id) throw new TypeError('Captured posts require a stable ID');
  const prior = current || null;
  const observedAt = stamp(incoming, ['observedAt', 'capturedAt', 'archiveObservedAt'], now);
  const contentAt = stamp(incoming, ['contentObservedAt', 'observedAt', 'capturedAt', 'archiveObservedAt'], observedAt);
  const profileAt = stamp(incoming, ['profileObservedAt', 'observedAt', 'capturedAt', 'archiveObservedAt'], observedAt);
  const metricsAt = stamp(incoming, ['metricsObservedAt', 'observedAt', 'capturedAt', 'archiveObservedAt'], observedAt);
  const contentIsNewer = !prior || contentAt >= stamp(prior, ['contentObservedAt', 'lastSeenAt', 'archivedAt'], 0);
  const profileIsNewer = !prior || profileAt >= stamp(prior, ['profileObservedAt', 'lastSeenAt', 'archivedAt'], 0);
  const metricsAreNewer = !prior || metricsAt >= stamp(prior, ['metricsObservedAt', 'lastSeenAt', 'archivedAt'], 0);
  const source = String(incoming.archiveSource || incoming.archiveSources?.[0] || incoming.archiveScope || incoming.source || incoming.sourceFlags?.[0] || 'capture');
  const provenance = mergeProvenance(prior?.provenance, incoming.provenance, { source, capturedAt: observedAt, runId: incoming.observedRunId || incoming.runId || null }, 24);
  const rowFields = nonNull(incoming);
  const next = { ...(prior || {}), ...(contentIsNewer ? rowFields : {}), id };
  if (prior && !contentIsNewer) {
    for (const field of ['text', 'url', 'createdAt', 'replyToId', 'conversationId', 'sensitive', 'quotedPostId', 'retweetedPostId']) {
      if (Object.hasOwn(prior, field)) next[field] = prior[field];
    }
  }
  next.author = profileIsNewer ? { ...(prior?.author || {}), ...nonNull(incoming.author || {}) } : { ...(incoming.author || {}), ...(prior?.author || {}) };
  next.profileObservedAt = Math.max(stamp(prior, ['profileObservedAt'], 0), profileAt);
  next.metrics = metricsAreNewer ? { ...(prior?.metrics || {}), ...nonNull(incoming.metrics || {}) } : { ...(incoming.metrics || {}), ...(prior?.metrics || {}) };
  next.metricsObservedAt = Math.max(stamp(prior, ['metricsObservedAt'], 0), metricsAt);
  next.media = mergeMediaRows(id, prior?.media || [], incoming.media || [], contentAt, contentIsNewer);
  next.contentObservedAt = Math.max(stamp(prior, ['contentObservedAt'], 0), contentAt);
  next.userMeta = prior ? (prior.userMeta || {}) : (incoming.userMeta || {});
  next.provenance = provenance;
  next.sourceFlags = [...new Set([...(prior?.sourceFlags || []), ...(incoming.sourceFlags || [])].filter(Boolean))];
  next.archiveSources = [...new Set([...(prior?.archiveSources || []), ...(incoming.archiveSources || [])].filter(Boolean))];
  next.archivedAt = Math.max(Number(prior?.archivedAt || 0), Number(incoming.archivedAt || 0), now);
  next.firstSeenAt = prior?.firstSeenAt || now;
  next.firstSeenRun = prior?.firstSeenRun || incoming.observedRunId || null;
  next.lastSeenAt = Math.max(Number(prior?.lastSeenAt || 0), now);
  if (!prior || observedAt >= stamp(prior, ['lastObservationAt', 'lastSeenAt'], 0)) next.lastSeenRun = incoming.observedRunId || prior?.lastSeenRun || null;
  next.lastObservationAt = Math.max(stamp(prior, ['lastObservationAt'], 0), observedAt);
  next.updatedAt = now;

  let revision = null;
  if (prior && JSON.stringify(revisionView(prior)) !== JSON.stringify(revisionView(next))) {
    revision = {
      key: `${id}:${observedAt}:${globalThis.crypto?.randomUUID?.() || `${now}-${Math.random().toString(36).slice(2)}`}`,
      tweetId: id,
      runId: incoming.observedRunId || null,
      observedAt,
      before: revisionView(prior),
      after: revisionView(next)
    };
  }
  return { row: next, revision };
}
