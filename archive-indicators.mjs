// Small, privacy-safe status projection for the X content script. Keep it separate
// from archive records so the page can never receive notes, tags, filenames or URLs.
const ACTIVE_STATES = new Set([
  'queued',
  'downloading',
  'paused',
  'retry-wait',
  'verifying',
  'converting',
  'waiting-conversion',
]);

export function buildArchiveIndicators(
  ids,
  posts,
  history,
  {
    truncated = false,
    verified = row =>
      row?.state === 'complete' &&
      !['mismatch', 'corrupt', 'missing'].includes(row.verification?.state || row.verificationState),
    matches = (media, row) =>
      Boolean(media?.id && row?.item?.mediaId && String(media.id) === String(row.item.mediaId)) ||
      Boolean(media?.url && row?.item?.url && media.url === row.item.url),
  } = {}
) {
  const postById = new Map((posts || []).map(post => [String(post.id), post]));
  const rowsByPost = new Map();
  for (const row of history || []) {
    const id = String(row.item?.tweetId || '');
    if (!rowsByPost.has(id)) rowsByPost.set(id, []);
    rowsByPost.get(id).push(row);
  }
  // XVault 21: two booleans for the optional x.com badges — never text, notes or file paths.
  const extra = post => {
    const out = {};
    if (Number(post.textRevisionCount) > 0) out.edited = true;
    const availability = post.availability?.state;
    if (availability && availability !== 'available') out.gone = true;
    return out;
  };
  return [...new Set((ids || []).map(String))].slice(0, 50).map(id => {
    const post = postById.get(id);
    if (!post) return { id, status: 'not-archived' };
    if (truncated) return { id, status: 'unknown', ...extra(post) };
    const media = Array.isArray(post.media) ? post.media : [];
    if (!media.length) return { id, status: 'archived', ...extra(post) };
    const downloads = rowsByPost.get(id) || [];
    const savedCount = media.reduce(
      (count, item) => count + (downloads.some(row => verified(row) && matches(item, row)) ? 1 : 0),
      0
    );
    let status;
    if (savedCount === media.length)
      status = downloads.some(row => row.association?.kind === 'shared' && verified(row)) ? 'shared' : 'downloaded';
    else if (savedCount) status = 'partial';
    else if (downloads.some(row => ACTIVE_STATES.has(row.state))) status = 'downloading';
    else if (downloads.some(row => row.state === 'failed')) status = 'failed';
    else status = 'missing';
    return { id, status, ...extra(post) };
  });
}
