// XVault 21: opt-in link snapshots. When the user grants XVault access to websites (optional host
// permission, requested from Settings), linked pages of chosen posts are fetched once and reduced to
// readable text — title, description, site name and the main text — stored in xvault-derived/snapshots.
// No scripts run, no images or styles are fetched, and responses are capped (linkSnapshotMaxKB).
const ENTITY = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
};
const decode = text =>
  String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, code) => {
    const key = code.toLowerCase();
    if (key.startsWith('#x')) return safeChar(parseInt(key.slice(2), 16), match);
    if (key.startsWith('#')) return safeChar(Number(key.slice(1)), match);
    return ENTITY[key] ?? match;
  });
const safeChar = (code, fallback) => (code > 0 && code < 0x110000 ? String.fromCodePoint(code) : fallback);
const clean = text =>
  decode(text)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t\f\r]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function meta(html, names) {
  for (const name of names) {
    const pattern = new RegExp(
      `<meta\\b[^>]*(?:name|property)\\s*=\\s*["']${name.replace(/[:.]/g, '\\$&')}["'][^>]*>`,
      'i'
    );
    const tag = pattern.exec(html)?.[0];
    const content = tag && /content\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag)?.[2];
    if (content) return clean(content);
  }
  return '';
}

/** Reduces an HTML document to { title, description, siteName, canonical, lang, text }. */
export function htmlToReadable(html, { maxText = 20000 } = {}) {
  const source = String(html || '');
  const title =
    clean(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] || '') || meta(source, ['og:title', 'twitter:title']);
  const description = meta(source, ['description', 'og:description', 'twitter:description']);
  const siteName = meta(source, ['og:site_name', 'application-name']);
  const canonical =
    /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i.exec(source)?.[0]?.match(/href\s*=\s*(["'])(.*?)\1/i)?.[2] || '';
  const lang = /<html\b[^>]*\blang\s*=\s*["']?([a-z-]{2,12})/i.exec(source)?.[1]?.toLowerCase() || '';
  let body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(source)?.[1] ?? source;
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body)?.[2];
  if (main && main.replace(/<[^>]+>/g, '').trim().length > 400) body = main;
  const text = clean(
    body
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(
        /<(script|style|noscript|template|svg|canvas|iframe|form|nav|header|footer|aside|button|select)\b[\s\S]*?<\/\1>/gi,
        ' '
      )
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|li|h[1-6]|blockquote|pre|tr|table|ul|ol|figure|figcaption)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<[^>]+>/g, ' ')
  ).slice(0, maxText);
  return {
    title: title.slice(0, 300),
    description: description.slice(0, 600),
    siteName: siteName.slice(0, 120),
    canonical,
    lang,
    text,
  };
}

export function snapshotKey(postId, url) {
  return `${postId}|${url}`;
}
const SKIP_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.co|pbs\.twimg\.com|video\.twimg\.com)$/i;
// A post's links are chosen by whoever wrote the post, so never let them reach this computer or the
// local network (routers, printers, development servers): loopback, private, link-local and .local names.
const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|\[(::1?|f[cd][0-9a-f:]*|fe[89ab][0-9a-f:]*|::ffff:[0-9a-f.:]*)\])$/i;
const skipHost = hostname =>
  SKIP_HOSTS.test(hostname) || PRIVATE_HOST.test(hostname) || (!hostname.includes('.') && !hostname.startsWith('['));
/** External http(s) links of a post that are worth snapshotting. */
export function snapshotTargets(post, limit = 4) {
  const out = [];
  for (const link of Array.isArray(post?.links) ? post.links : []) {
    try {
      const url = new URL(String(link));
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || skipHost(url.hostname)) continue;
      url.hash = '';
      if (!out.includes(url.href)) out.push(url.href);
    } catch {}
    if (out.length >= limit) break;
  }
  if (!out.length && post?.card?.url) {
    try {
      const url = new URL(post.card.url);
      if (/^https?:$/.test(url.protocol) && !url.username && !url.password && !skipHost(url.hostname))
        out.push(url.href);
    } catch {}
  }
  return out;
}

async function readCapped(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    return { text: text.slice(0, maxBytes), bytes: text.length, truncated: text.length > maxBytes };
  }
  const reader = response.body.getReader(),
    chunks = [];
  let bytes = 0,
    truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    chunks.push(value);
    if (bytes >= maxBytes) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const joined = new Uint8Array(Math.min(bytes, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.max(0, joined.length - offset));
    joined.set(slice, offset);
    offset += slice.length;
  }
  const charset = /charset=([\w-]+)/i.exec(response.headers.get('content-type') || '')?.[1] || 'utf-8';
  let decoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return { text: decoder.decode(joined), bytes, truncated };
}

export function createLinkSnapshots(deps) {
  const {
    store,
    readPosts,
    getSettings,
    hasPermission = async () => false,
    fetchImpl = (...args) => globalThis.fetch(...args),
    now = () => Date.now(),
    announce = () => {},
  } = deps;
  const pending = [],
    busy = new Set();
  let worker = null,
    idCache = { revision: -1, ids: null };

  async function postIds() {
    const revision = await store.revision('snapshots');
    if (idCache.ids && idCache.revision === revision) return idCache.ids;
    const rows = await store.getAll('snapshots');
    idCache = { revision, ids: new Set(rows.filter(row => row.status === 'ok').map(row => String(row.postId))) };
    return idCache.ids;
  }

  async function snapshotOne(postId, url, settings) {
    const started = now(),
      controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 20000);
    const row = { key: snapshotKey(postId, url), postId, url, fetchedAt: started };
    try {
      const response = await fetchImpl(url, {
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal,
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5' },
      });
      row.httpStatus = response.status;
      row.finalUrl = response.url || url;
      // fetch follows redirects itself; never keep what a redirect to a local address returned.
      if (skipHost(new URL(row.finalUrl).hostname) && !skipHost(new URL(url).hostname))
        throw Error('Redirected to a local or X address; not kept');
      row.contentType = String(response.headers.get('content-type') || '').slice(0, 120);
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      if (!/text\/html|application\/xhtml|text\/plain/i.test(row.contentType))
        throw Error(`Not a web page (${row.contentType || 'unknown type'})`);
      const body = await readCapped(response, Math.max(32, Number(settings.linkSnapshotMaxKB) || 512) * 1024);
      Object.assign(
        row,
        /text\/plain/i.test(row.contentType)
          ? {
              title: '',
              description: '',
              siteName: '',
              canonical: '',
              lang: '',
              text: clean(body.text).slice(0, 20000),
            }
          : htmlToReadable(body.text)
      );
      row.bytes = body.bytes;
      row.truncated = body.truncated;
      row.status = 'ok';
    } catch (error) {
      row.status = 'error';
      row.error = controller.signal.aborted ? 'Timed out' : String(error?.message || error).slice(0, 200);
    } finally {
      clearTimeout(timer);
    }
    row.ms = now() - started;
    await store.putMany('snapshots', [row]);
    await store.bump('snapshots');
    return row;
  }

  function drain() {
    worker ||= (async () => {
      const settings = await getSettings();
      while (pending.length) {
        const { postId, url } = pending.shift(),
          key = snapshotKey(postId, url);
        busy.add(key);
        try {
          await snapshotOne(postId, url, settings);
        } finally {
          busy.delete(key);
        }
        announce([postId], 'snapshot');
      }
    })().finally(() => (worker = null));
    return worker;
  }

  async function enqueue(ids, { force = false } = {}) {
    if (!(await hasPermission()))
      return { ok: false, error: 'Allow XVault to read linked websites first (Settings › Capture).' };
    const posts = await readPosts(ids.slice(0, 200).map(String));
    const existing = await store.getMany(
      'snapshots',
      posts.flatMap(post => snapshotTargets(post).map(url => snapshotKey(String(post.id), url)))
    );
    let queued = 0;
    for (const post of posts)
      for (const url of snapshotTargets(post)) {
        const key = snapshotKey(String(post.id), url);
        if (!force && existing.get(key)?.status === 'ok') continue;
        if (busy.has(key) || pending.some(entry => entry.postId === String(post.id) && entry.url === url)) continue;
        pending.push({ postId: String(post.id), url });
        queued++;
      }
    void drain();
    return { ok: true, queued, pending: pending.length };
  }

  async function forPost(postId) {
    const rows = await store.getAll('snapshots');
    return rows.filter(row => String(row.postId) === String(postId)).sort((a, b) => b.fetchedAt - a.fetchedAt);
  }

  const MESSAGES = {
    SNAPSHOT_LINKS: message => enqueue(Array.isArray(message.ids) ? message.ids : [], { force: !!message.force }),
    SNAPSHOT_FOR_POST: async message => ({ ok: true, snapshots: await forPost(String(message.id || '')) }),
    SNAPSHOT_STATUS: async () => ({
      ok: true,
      count: await store.count('snapshots'),
      pending: pending.length,
      permission: await hasPermission(),
    }),
    SNAPSHOT_CLEAR: async () => {
      pending.length = 0;
      await worker?.catch(() => {});
      await store.clear('snapshots');
      idCache = { revision: -1, ids: null };
      return { ok: true };
    },
  };
  return {
    postIds,
    enqueue,
    forPost,
    snapshotOne,
    types: Object.keys(MESSAGES),
    handle: message => MESSAGES[message.type](message),
  };
}
