// X data-archive import (XVault 20). Reads the ZIP that X sends from "Download an archive of your data"
// entirely in the browser: the central directory is parsed from the end of the file and only the small
// JavaScript data files (tweets, likes, bookmarks, account) are inflated with DecompressionStream, so a
// multi-gigabyte archive full of media never has to fit in memory. Records are mapped to the same shape
// the X capture produces and marked as an old observation, so anything XVault already captured live
// keeps its richer text, author and metrics.
const SIG_EOCD = 0x06054b50,
  SIG_EOCD64 = 0x06064b50,
  SIG_LOCATOR64 = 0x07064b50,
  SIG_CENTRAL = 0x02014b50,
  SIG_LOCAL = 0x04034b50;
const MAX_ENTRY = 512 * 1024 * 1024;
const ID = /^\d{1,32}$/;

async function bytes(blob, start, end) {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}
const u16 = (view, at) => view.getUint16(at, true);
const u32 = (view, at) => view.getUint32(at, true);
const u64 = (view, at) => Number(view.getBigUint64(at, true));

/** Lists the entries of a ZIP Blob/File: [{ name, method, compressedSize, size, offset }]. */
export async function listZip(blob) {
  const tailSize = Math.min(blob.size, 65557 + 20),
    tailStart = blob.size - tailSize,
    tail = await bytes(blob, tailStart, blob.size),
    view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let at = tail.length - 22; at >= 0; at--)
    if (u32(view, at) === SIG_EOCD) {
      eocd = at;
      break;
    }
  if (eocd < 0) throw Error('Not a ZIP file (no end-of-archive record found)');
  let count = u16(view, eocd + 10),
    size = u32(view, eocd + 12),
    offset = u32(view, eocd + 16);
  if (
    (offset === 0xffffffff || count === 0xffff || size === 0xffffffff) &&
    eocd >= 20 &&
    u32(view, eocd - 20) === SIG_LOCATOR64
  ) {
    const at = u64(view, eocd - 20 + 8),
      record = await bytes(blob, at, at + 56),
      view64 = new DataView(record.buffer);
    if (u32(view64, 0) !== SIG_EOCD64) throw Error('Damaged ZIP64 directory');
    count = u64(view64, 32);
    size = u64(view64, 40);
    offset = u64(view64, 48);
  }
  if (offset + size > blob.size) throw Error('The ZIP directory points past the end of the file (truncated download?)');
  const directory = await bytes(blob, offset, offset + size),
    dir = new DataView(directory.buffer),
    decoder = new TextDecoder(),
    entries = [];
  let at = 0;
  for (let index = 0; index < count && at + 46 <= directory.length; index++) {
    if (u32(dir, at) !== SIG_CENTRAL) throw Error('Damaged ZIP directory entry');
    const method = u16(dir, at + 10),
      nameLength = u16(dir, at + 28),
      extraLength = u16(dir, at + 30),
      commentLength = u16(dir, at + 32);
    let compressedSize = u32(dir, at + 20),
      uncompressed = u32(dir, at + 24),
      local = u32(dir, at + 42);
    const name = decoder.decode(directory.subarray(at + 46, at + 46 + nameLength));
    // ZIP64 extra field (0x0001) carries the real sizes/offset when the 32-bit fields are saturated.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const tag = u16(dir, extra),
        length = u16(dir, extra + 2);
      if (tag === 1) {
        let field = extra + 4;
        if (uncompressed === 0xffffffff) ((uncompressed = u64(dir, field)), (field += 8));
        if (compressedSize === 0xffffffff) ((compressedSize = u64(dir, field)), (field += 8));
        if (local === 0xffffffff) local = u64(dir, field);
      }
      extra += 4 + length;
    }
    entries.push({ name, method, compressedSize, size: uncompressed, offset: local });
    at = extraEnd + commentLength;
  }
  return entries;
}

async function inflateRaw(data) {
  if (typeof DecompressionStream !== 'function')
    throw Error('This browser cannot unpack ZIP files (DecompressionStream missing)');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads one entry's uncompressed bytes. */
export async function readZipEntry(blob, entry) {
  if (entry.size > MAX_ENTRY) throw Error(`${entry.name} is too large to read (${entry.size} bytes)`);
  const header = await bytes(blob, entry.offset, entry.offset + 30),
    view = new DataView(header.buffer);
  if (u32(view, 0) !== SIG_LOCAL) throw Error(`Damaged ZIP entry ${entry.name}`);
  const start = entry.offset + 30 + u16(view, 26) + u16(view, 28),
    raw = await bytes(blob, start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw Error(`${entry.name} uses an unsupported ZIP compression method (${entry.method})`);
}

/** Parses `window.YTD.tweets.part0 = [...]` (or plain JSON) into an array. */
export function parseYtd(text) {
  const source = String(text || '').replace(/^\uFEFF/, ''),
    start = source.search(/[[{]/);
  if (start < 0) return [];
  const value = JSON.parse(source.slice(start));
  return Array.isArray(value) ? value : [value];
}

function iso(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function photoUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'pbs.twimg.com') parsed.searchParams.set('name', 'orig');
    return parsed.href;
  } catch {
    return url;
  }
}
const metric = value => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null);

function mediaFrom(tweet) {
  const list = tweet.extended_entities?.media || tweet.entities?.media || [];
  const seen = new Set();
  return list
    .filter(item => item && (item.media_url_https || item.media_url) && !seen.has(item.id_str) && seen.add(item.id_str))
    .slice(0, 32)
    .map(item => {
      const variants = (item.video_info?.variants || [])
        .filter(variant => /^https:\/\/video\.twimg\.com\//.test(String(variant.url || '')))
        .map(variant => ({
          url: variant.url,
          bitrate: Number(variant.bitrate) || 0,
          contentType: variant.content_type || null,
        }));
      const best = variants
        .filter(variant => /video\/(mp4|webm)/i.test(variant.contentType || 'video/mp4'))
        .sort((a, b) => b.bitrate - a.bitrate)[0];
      const preview = item.media_url_https || item.media_url;
      return {
        id: item.id_str || null,
        type: item.type || 'photo',
        url: item.type === 'photo' ? photoUrl(preview) : preview,
        preview,
        playbackUrl: item.type === 'video' || item.type === 'animated_gif' ? best?.url || null : null,
        width: Number(item.original_info?.width || item.sizes?.large?.w) || null,
        height: Number(item.original_info?.height || item.sizes?.large?.h) || null,
        variants,
      };
    });
}
function entitiesFrom(tweet) {
  const entities = tweet.entities || {},
    out = {};
  const links = (entities.urls || [])
    .map(item => String(item?.expanded_url || ''))
    .filter(href => /^https?:\/\/\S{1,2040}$/i.test(href))
    .slice(0, 20);
  const hashtags = (entities.hashtags || [])
    .map(item =>
      String(item?.text || '')
        .toLowerCase()
        .slice(0, 140)
    )
    .filter(Boolean)
    .slice(0, 30);
  const mentions = (entities.user_mentions || [])
    .map(item => String(item?.screen_name || '').toLowerCase())
    .filter(handle => /^[a-z0-9_]{1,30}$/.test(handle))
    .slice(0, 50);
  if (links.length) out.links = [...new Set(links)];
  if (hashtags.length) out.hashtags = [...new Set(hashtags)];
  if (mentions.length) out.mentions = [...new Set(mentions)];
  return out;
}
// Imported rows are an *old* observation (stamp 1 ms after the epoch) so live captures always win.
const OLD = { observedAt: 1, contentObservedAt: 1, profileObservedAt: 1, metricsObservedAt: 1 };

/** Maps one tweets.js item to a capture-shaped record. */
export function tweetFromArchive(item, account = {}) {
  const tweet = item?.tweet || item;
  const id = String(tweet?.id_str || tweet?.id || '');
  if (!ID.test(id)) return null;
  const handle = /^[a-z0-9_]{1,30}$/i.test(String(account.username || '')) ? String(account.username) : null;
  const reply = String(tweet.in_reply_to_status_id_str || '');
  const replyHandle = String(tweet.in_reply_to_screen_name || '');
  const retweet = /^RT @[A-Za-z0-9_]{1,30}:/.test(String(tweet.full_text || ''));
  return {
    id,
    text: String(tweet.full_text || tweet.text || '').slice(0, 100000),
    createdAt: iso(tweet.created_at),
    url: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`,
    author: {
      id: account.accountId ? String(account.accountId) : null,
      handle,
      name: account.accountDisplayName || null,
    },
    metrics: { likes: metric(tweet.favorite_count), reposts: metric(tweet.retweet_count) },
    media: mediaFrom(tweet),
    replyToId: ID.test(reply) ? reply : null,
    replyToHandle: /^[a-z0-9_]{1,30}$/i.test(replyHandle) ? replyHandle : null,
    conversationId: null,
    ...entitiesFrom(tweet),
    language: tweet.lang && tweet.lang !== 'und' ? String(tweet.lang).slice(0, 12) : null,
    sensitive: Boolean(tweet.possibly_sensitive),
    sourceFlags: ['x-archive', retweet ? 'x-archive-repost' : 'x-archive-post'],
    archiveSources: ['profile', 'x-archive'],
    archiveProfile: handle,
    profileRelation: retweet ? 'retweets' : 'media',
    ...OLD,
  };
}
/** Maps one like.js / bookmark.js item to a minimal record (X only exports id, text and link). */
export function savedFromArchive(item, kind = 'likes') {
  const row = item?.like || item?.bookmark || item;
  const id = String(row?.tweetId || row?.id || '');
  if (!ID.test(id)) return null;
  const match = String(row.expandedUrl || '').match(/^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,30})\/status\/\d+/);
  const handle = match && match[1].toLowerCase() !== 'i' ? match[1] : null;
  return {
    id,
    text: String(row.fullText || '').slice(0, 100000),
    url: handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`,
    author: handle ? { handle } : {},
    media: [],
    sourceFlags: ['x-archive', `x-archive-${kind === 'bookmarks' ? 'bookmark' : 'like'}`],
    archiveSources: [kind, 'x-archive'],
    ...OLD,
  };
}

const kindOf = name => {
  const base = String(name).split('/').pop().toLowerCase();
  if (/^(tweets?|tweet)(-part\d+)?\.js$/.test(base)) return 'tweets';
  if (/^like(-part\d+)?\.js$/.test(base)) return 'likes';
  if (/^bookmarks?(-part\d+)?\.js$/.test(base)) return 'bookmarks';
  if (base === 'account.js') return 'account';
  if (base === 'manifest.js') return 'manifest';
  return '';
};

/**
 * Reads an X archive (the .zip, or an extracted tweets.js / like.js) and returns
 * { account, generatedAt, tweets, likes, bookmarks, mediaFiles, files }.
 * onProgress({ phase, done, total, file }) is called between files.
 */
export async function readXArchive(file, { onProgress = () => {}, include = ['tweets', 'likes', 'bookmarks'] } = {}) {
  const out = { account: {}, generatedAt: null, tweets: [], likes: [], bookmarks: [], mediaFiles: 0, files: [] };
  const decoder = new TextDecoder();
  const sources = [];
  const isZip =
    /\.zip$/i.test(file.name || '') ||
    (await bytes(file, 0, 4)).every((value, index) => value === [0x50, 0x4b, 0x03, 0x04][index]);
  if (isZip) {
    const entries = await listZip(file);
    out.mediaFiles = entries.filter(entry =>
      /\/(tweets?|community_tweet|direct_messages?)_media\//i.test(entry.name)
    ).length;
    for (const entry of entries) {
      const kind = kindOf(entry.name);
      if (kind && (kind === 'account' || kind === 'manifest' || include.includes(kind)))
        sources.push({ kind, name: entry.name, read: () => readZipEntry(file, entry) });
    }
    if (!sources.some(source => source.kind === 'tweets' || source.kind === 'likes' || source.kind === 'bookmarks'))
      throw Error('No tweets.js, like.js or bookmark.js inside this ZIP. Is it the archive X emailed you?');
  } else {
    const kind = kindOf(file.name || 'tweets.js') || 'tweets';
    sources.push({ kind, name: file.name || 'tweets.js', read: async () => new Uint8Array(await file.arrayBuffer()) });
  }
  sources.sort(
    (a, b) =>
      (a.kind === 'account' || a.kind === 'manifest' ? -1 : 0) -
      (b.kind === 'account' || b.kind === 'manifest' ? -1 : 0)
  );
  let done = 0;
  for (const source of sources) {
    onProgress({ phase: 'reading', done, total: sources.length, file: source.name });
    const items = parseYtd(decoder.decode(await source.read()));
    out.files.push({ name: source.name, kind: source.kind, items: items.length });
    if (source.kind === 'account') Object.assign(out.account, items[0]?.account || {});
    else if (source.kind === 'manifest') out.generatedAt = items[0]?.archiveInfo?.generationDate || null;
    else if (source.kind === 'tweets')
      for (const item of items) {
        const row = tweetFromArchive(item, out.account);
        if (row) out.tweets.push(row);
      }
    else
      for (const item of items) {
        const row = savedFromArchive(item, source.kind);
        if (row) out[source.kind].push(row);
      }
    done++;
  }
  onProgress({ phase: 'parsed', done, total: sources.length });
  return out;
}

/** Builds a tiny stored (uncompressed) ZIP — used by tests and the sample-archive generator. */
export function buildStoredZip(files) {
  const encoder = new TextEncoder(),
    locals = [],
    centrals = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = data => {
    let c = 0xffffffff;
    for (const value of data) c = crcTable[(c ^ value) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? encoder.encode(content) : content,
      nameBytes = encoder.encode(name),
      crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    locals.push(new Uint8Array(local.buffer), nameBytes, data);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, SIG_CENTRAL, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, offset, true);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0),
    end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIG_EOCD, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...locals, ...centrals, new Uint8Array(end.buffer)]);
}
