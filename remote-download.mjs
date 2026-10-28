import { isXMediaUrl } from './message-boundary.mjs';

export async function remoteMediaVersion(media) {
  if (media.length > 10000) throw Error('This post has too many media entries for one Remote session');
  const encoder = new TextEncoder(),
    chunks = ['['];
  let bytes = 1,
    fields = 0;
  const append = value => {
    bytes += encoder.encode(value).byteLength;
    if (bytes > 4 * 1024 * 1024) throw Error('This post media evidence exceeds the Remote safety limit');
    chunks.push(value);
  };
  for (let index = 0; index < media.length; index++) {
    const item = media[index],
      variants = Array.isArray(item?.variants) ? item.variants : [];
    if (variants.length > 1000) throw Error('This post media evidence exceeds the Remote safety limit');
    if (index) append(',');
    append('[');
    let position = 0;
    const field = value => {
      if (
        ++fields > 100000 ||
        !['string', 'number', 'boolean'].includes(typeof value) ||
        (typeof value === 'string' && value.length > 32768)
      )
        throw Error('This post media evidence exceeds the Remote safety limit');
      if (position++) append(',');
      append(JSON.stringify(value));
    };
    for (const value of [item?.id || '', item?.type || '', item?.url || '', item?.playbackUrl || '']) field(value);
    for (const variant of variants) field(variant?.url || '');
    append(']');
  }
  append(']');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(chunks.join('')));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Resolve only captured evidence. Phones provide an ID/range, never a URL,
// filesystem target, force flag or conversion policy.
export async function planRemoteDownload(post, options = {}, buildItem) {
  const offset = options.offset ?? 0,
    limit = options.limit ?? 32;
  if (
    !/^\d{1,32}$/.test(String(post?.id || '')) ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 10000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 32
  )
    throw Error('Download range is invalid');
  const media = Array.isArray(post.media) ? post.media : [],
    version = await remoteMediaVersion(media);
  if (options.mediaVersion && options.mediaVersion !== version)
    return { stale: true, mediaVersion: version, items: [] };
  const items = [];
  let unavailable = 0;
  for (let index = offset; index < Math.min(media.length, offset + limit); index++) {
    const entry = media[index] || {},
      variants = Array.isArray(entry.variants) ? entry.variants : [];
    const video =
      /video|gif|animation/i.test(String(entry.type || '')) ||
      variants.some(variant => /^video\//i.test(variant?.contentType || ''));
    const best = video
      ? variants
          .filter(variant => /^video\/mp4$/i.test(variant?.contentType || '') && isXMediaUrl(variant.url))
          .reduce(
            (chosen, variant) =>
              !chosen || Number(variant.bitrate || 0) > Number(chosen.bitrate || 0) ? variant : chosen,
            null
          )
      : null;
    const source = video ? best?.url || entry.playbackUrl || entry.url : entry.url || entry.playbackUrl;
    if (!isXMediaUrl(source)) {
      unavailable++;
      continue;
    }
    const item = buildItem(post, { ...entry, url: source, playbackUrl: video ? source : entry.playbackUrl }, index);
    if (item && isXMediaUrl(item.url)) items.push(item);
    else unavailable++;
  }
  const nextOffset = offset + limit < media.length ? offset + limit : null;
  return { items, unavailable, mediaVersion: version, mediaCount: media.length, nextOffset };
}
