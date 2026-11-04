// Vault Atlas: pure aggregation over archived posts. One streaming pass builds every
// statistic the Atlas, Calendar, People and Duplicate Lab views need; nothing here
// touches storage, the network or personal metadata beyond counting it.

const DAY = 86400000;

const pad = value => String(value).padStart(2, '0');
// Calendar day keys (YYYY-MM-DD) in UTC or in the computer's local time zone (XVault 19 setting).
export function dayKeyIn(stamp, timeZone = 'utc') {
  const value = Number(stamp);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (timeZone !== 'local') return new Date(value).toISOString().slice(0, 10);
  const local = new Date(value);
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
}
const dayKey = stamp => dayKeyIn(stamp, 'utc');
const postedStamp = post => {
  const value = Date.parse(post?.createdAt || '');
  return Number.isFinite(value) ? value : 0;
};
const bump = (map, key, by = 1) => {
  if (key) map.set(key, (map.get(key) || 0) + by);
};
const topEntries = (map, limit) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
const handleOf = post =>
  String(post?.author?.handle || '')
    .replace(/^@/, '')
    .toLowerCase();
const isRepostWrapper = post => !!post?.retweetedPostId || /^RT @/.test(String(post?.text || ''));
const mediaKind = item => {
  const type = String(item?.type || '').toLowerCase();
  if (type === 'animated_gif' || type.includes('gif')) return 'gif';
  if (type === 'video') return 'video';
  if (type === 'photo' || type === 'image') return 'photo';
  return 'other';
};

// Smaller CDN renditions keep previews light. Only pbs.twimg.com images are rewritten.
export function previewUrl(url, size = 'small') {
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'pbs.twimg.com') return '';
    if (target.pathname.startsWith('/media/')) {
      const format = target.searchParams.get('format') || target.pathname.match(/\.(jpe?g|png|webp)$/i)?.[1] || 'jpg';
      target.pathname = target.pathname.replace(/\.(jpe?g|png|webp)$/i, '');
      target.search = '';
      target.searchParams.set('format', format.toLowerCase() === 'jpeg' ? 'jpg' : format.toLowerCase());
      target.searchParams.set('name', size);
    }
    return target.href;
  } catch {
    return '';
  }
}

export { mediaKind };

export function compactPost(post, textLimit = 280) {
  const media = Array.isArray(post?.media) ? post.media : [];
  const first = media.find(item => item?.url || item?.preview);
  return {
    id: String(post?.id || ''),
    text: String(post?.text || '').slice(0, textLimit),
    createdAt: post?.createdAt || null,
    archivedAt: Number(post?.archivedAt || 0),
    url: post?.url || '',
    handle: handleOf(post),
    name: String(post?.author?.name || ''),
    avatar: String(post?.author?.avatar || ''),
    likes: Number(post?.metrics?.likes || 0),
    views: Number(post?.metrics?.views || 0),
    mediaCount: media.length,
    mediaType: first ? mediaKind(first) : '',
    preview: first ? previewUrl(first.preview || first.url, 'small') : '',
    favorite: !!post?.userMeta?.favorite,
  };
}

const KEEP_TOP = 12;
function keepTop(list, item, score) {
  if (list.length < KEEP_TOP) {
    list.push({ item, score });
    list.sort((a, b) => b.score - a.score);
    return;
  }
  if (score <= list[list.length - 1].score) return;
  list[list.length - 1] = { item, score };
  list.sort((a, b) => b.score - a.score);
}

export function createInsightsAccumulator(options = {}) {
  const now = Number(options.now) || Date.now();
  const timeZone = options.timeZone === 'local' ? 'local' : 'utc';
  const keyOf = stamp => dayKeyIn(stamp, timeZone);
  const today = new Date(now);
  const monthDay = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const state = {
    total: 0,
    archivedDays: new Map(),
    postedDays: new Map(),
    archivedMonths: new Map(),
    postedMonths: new Map(),
    rhythm: Array.from({ length: 7 }, () => new Array(24).fill(0)),
    authors: new Map(),
    languages: new Map(),
    hashtags: new Map(),
    mentions: new Map(),
    domains: new Map(),
    sources: new Map(),
    tags: new Map(),
    media: { photo: 0, video: 0, gif: 0, other: 0, items: 0, postsWithMedia: 0, textOnly: 0 },
    relationships: { replies: 0, quotes: 0, reposts: 0, selfThreads: 0, conversations: new Set() },
    personal: { favorites: 0, tagged: 0, notes: 0, reviewed: 0 },
    sensitive: 0,
    likes: 0,
    views: 0,
    oldestPosted: 0,
    newestPosted: 0,
    firstArchived: 0,
    lastArchived: 0,
    topLiked: [],
    onThisDay: [],
    mediaOwners: new Map(),
    // XVault 20: per-year review, mention graph and reading/organising totals.
    years: new Map(),
    edges: new Map(),
    reading: { later: 0, read: 0, highlights: 0, highlighted: 0, boarded: 0 },
  };
  const yearOf = stamp => {
    if (!stamp) return '';
    const date = new Date(stamp);
    return String(timeZone === 'utc' ? date.getUTCFullYear() : date.getFullYear());
  };
  function yearBucket(year) {
    let bucket = state.years.get(year);
    if (!bucket) {
      bucket = {
        posted: 0,
        archived: 0,
        media: 0,
        likes: 0,
        authors: new Map(),
        hashtags: new Map(),
        tags: new Map(),
        highlights: 0,
      };
      state.years.set(year, bucket);
    }
    return bucket;
  }
  const capped = (map, key, limit = 6000) => {
    if (map.has(key) || map.size < limit) bump(map, key);
  };

  function add(post) {
    if (!post || typeof post !== 'object' || !post.id) return;
    state.total++;
    const archivedAt = Number(post.archivedAt || 0),
      postedAt = postedStamp(post),
      handle = handleOf(post),
      media = Array.isArray(post.media) ? post.media : [],
      meta = post.userMeta || {};
    const archivedDay = keyOf(archivedAt),
      postedDay = keyOf(postedAt);
    bump(state.archivedDays, archivedDay);
    bump(state.postedDays, postedDay);
    bump(state.archivedMonths, archivedDay.slice(0, 7));
    bump(state.postedMonths, postedDay.slice(0, 7));
    if (postedAt) {
      const local = new Date(postedAt);
      if (timeZone === 'utc') state.rhythm[local.getUTCDay()][local.getUTCHours()]++;
      else state.rhythm[local.getDay()][local.getHours()]++;
      if (!state.oldestPosted || postedAt < state.oldestPosted) state.oldestPosted = postedAt;
      if (postedAt > state.newestPosted) state.newestPosted = postedAt;
    }
    if (archivedAt) {
      if (!state.firstArchived || archivedAt < state.firstArchived) state.firstArchived = archivedAt;
      if (archivedAt > state.lastArchived) state.lastArchived = archivedAt;
    }
    if (handle) {
      let author = state.authors.get(handle);
      if (!author) {
        author = {
          handle,
          raw: String(post.author?.handle || handle).replace(/^@/, ''),
          count: 0,
          media: 0,
          likes: 0,
          latest: 0,
          firstPosted: 0,
          lastPosted: 0,
          profile: null,
        };
        state.authors.set(handle, author);
      }
      author.count++;
      author.media += media.length;
      author.likes += Number(post.metrics?.likes || 0);
      if (postedAt && (!author.firstPosted || postedAt < author.firstPosted)) author.firstPosted = postedAt;
      if (postedAt > author.lastPosted) author.lastPosted = postedAt;
      if (archivedAt >= author.latest || !author.profile) {
        author.latest = Math.max(author.latest, archivedAt);
        const a = post.author || {};
        author.profile = {
          name: String(a.name || ''),
          avatar: String(a.avatar || ''),
          verified: !!a.verified,
          followers: Number.isFinite(Number(a.followers)) && a.followers != null ? Number(a.followers) : null,
          bio: String(a.bio || '').slice(0, 320),
        };
      }
    }
    bump(state.languages, String(post.language || '').toLowerCase());
    for (const tag of Array.isArray(post.hashtags) ? post.hashtags : [])
      bump(state.hashtags, String(tag).toLowerCase());
    for (const name of Array.isArray(post.mentions) ? post.mentions : [])
      bump(state.mentions, String(name).toLowerCase());
    for (const link of Array.isArray(post.links) ? post.links : []) {
      const match = /^https?:\/\/([^/?#:]+)/i.exec(String(link || ''));
      if (match) bump(state.domains, match[1].toLowerCase().replace(/^www\./, ''));
    }
    for (const source of new Set([...(post.archiveSources || []), ...(post.sourceFlags || [])].map(String)))
      if (/^[a-z-]{2,24}$/i.test(source)) bump(state.sources, source.toLowerCase());
    for (const tag of Array.isArray(meta.tags) ? meta.tags : []) bump(state.tags, String(tag).toLowerCase());
    const postedYear = yearOf(postedAt),
      archivedYear = yearOf(archivedAt);
    if (archivedYear) yearBucket(archivedYear).archived++;
    if (postedYear) {
      const bucket = yearBucket(postedYear);
      bucket.posted++;
      bucket.media += media.length;
      bucket.likes += Number(post.metrics?.likes || 0);
      bucket.highlights += Array.isArray(meta.highlights) ? meta.highlights.length : 0;
      if (handle) capped(bucket.authors, handle);
      for (const tag of Array.isArray(post.hashtags) ? post.hashtags.slice(0, 30) : [])
        capped(bucket.hashtags, String(tag).toLowerCase());
      for (const tag of Array.isArray(meta.tags) ? meta.tags.slice(0, 30) : []) capped(bucket.tags, String(tag));
    }
    if (handle)
      for (const mention of Array.isArray(post.mentions) ? post.mentions.slice(0, 12) : []) {
        const target = String(mention).toLowerCase();
        if (target && target !== handle) capped(state.edges, `${handle}>${target}`, 120000);
      }
    if (meta.readLater && !meta.readAt) state.reading.later++;
    if (meta.readAt) state.reading.read++;
    if (Array.isArray(meta.highlights) && meta.highlights.length) {
      state.reading.highlighted++;
      state.reading.highlights += meta.highlights.length;
    }
    if (Array.isArray(meta.boards) && meta.boards.length) state.reading.boarded++;
    if (meta.favorite) state.personal.favorites++;
    if (Array.isArray(meta.tags) && meta.tags.length) state.personal.tagged++;
    if (String(meta.note || '').trim()) state.personal.notes++;
    if (meta.reviewedAt) state.personal.reviewed++;
    if (post.sensitive) state.sensitive++;
    if (media.length) state.media.postsWithMedia++;
    else state.media.textOnly++;
    const wrapper = isRepostWrapper(post);
    media.forEach(item => {
      state.media[mediaKind(item)]++;
      state.media.items++;
      const id = String(item?.id || '');
      if (!id || wrapper) return;
      const owners = state.mediaOwners.get(id);
      if (!owners) state.mediaOwners.set(id, [String(post.id)]);
      else if (owners.length < 24 && !owners.includes(String(post.id))) owners.push(String(post.id));
    });
    if (post.replyToId) state.relationships.replies++;
    if (post.quotedPostId) state.relationships.quotes++;
    if (wrapper) state.relationships.reposts++;
    if (post.replyToId && String(post.replyToHandle || '').toLowerCase() === handle) state.relationships.selfThreads++;
    if (post.conversationId && state.relationships.conversations.size < 200000)
      state.relationships.conversations.add(String(post.conversationId));
    const likes = Number(post.metrics?.likes || 0);
    state.likes += likes;
    state.views += Number(post.metrics?.views || 0);
    if (!wrapper && likes > 0) keepTop(state.topLiked, post, likes);
    if (postedAt && !wrapper) {
      const local = new Date(postedAt);
      const md = `${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
      if (md === monthDay && local.getFullYear() < today.getFullYear())
        keepTop(state.onThisDay, post, likes + (today.getFullYear() - local.getFullYear()) * 1e-3);
    }
  }

  function finish(extra = {}) {
    const authors = [...state.authors.values()]
      .sort((a, b) => b.count - a.count || b.latest - a.latest || a.handle.localeCompare(b.handle))
      .slice(0, Math.max(1, Number(options.authorLimit) || 2000))
      .map(author => ({
        handle: author.handle,
        raw: author.raw,
        name: author.profile?.name || '',
        avatar: author.profile?.avatar || '',
        verified: !!author.profile?.verified,
        followers: author.profile?.followers ?? null,
        bio: author.profile?.bio || '',
        count: author.count,
        media: author.media,
        likes: author.likes,
        latest: author.latest,
        firstPosted: author.firstPosted,
        lastPosted: author.lastPosted,
      }));
    const sharedMedia = [];
    for (const [mediaId, owners] of state.mediaOwners) {
      const posts = owners;
      if (posts.length > 1) sharedMedia.push({ mediaId, posts });
      if (sharedMedia.length >= 400) break;
    }
    // Year in Review: newest year first; authors new that year are those first posted in it.
    const firstYear = new Map();
    for (const author of state.authors.values()) {
      const year = yearOf(author.firstPosted);
      if (year) firstYear.set(year, (firstYear.get(year) || 0) + 1);
    }
    const years = [...state.years]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 30)
      .map(([year, bucket]) => ({
        year,
        posted: bucket.posted,
        archived: bucket.archived,
        media: bucket.media,
        likes: bucket.likes,
        highlights: bucket.highlights,
        authors: bucket.authors.size,
        newAuthors: firstYear.get(year) || 0,
        topAuthors: topEntries(bucket.authors, 10),
        hashtags: topEntries(bucket.hashtags, 40),
        tags: topEntries(bucket.tags, 24),
      }));
    // People graph: who mentions whom among the most archived people.
    const nodeSet = new Set(authors.slice(0, 36).map(author => author.handle));
    const graph = [];
    for (const [key, weight] of state.edges) {
      const [from, to] = key.split('>');
      if (from !== to && nodeSet.has(from) && nodeSet.has(to)) graph.push({ from, to, weight });
    }
    graph.sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from));
    return {
      version: 2,
      computedAt: now,
      years,
      graph: { nodes: [...nodeSet], edges: graph.slice(0, 160) },
      reading: { ...state.reading },
      timeZone,
      total: state.total,
      authorsTotal: state.authors.size,
      days: {
        archived: Object.fromEntries(state.archivedDays),
        posted: Object.fromEntries(state.postedDays),
      },
      streaks: {
        archived: dayStreaks(Object.fromEntries(state.archivedDays), now, timeZone),
        posted: dayStreaks(Object.fromEntries(state.postedDays), now, timeZone),
      },
      months: {
        archived: Object.fromEntries([...state.archivedMonths].sort()),
        posted: Object.fromEntries([...state.postedMonths].sort()),
      },
      rhythm: state.rhythm,
      authors,
      languages: topEntries(state.languages, 24),
      hashtags: topEntries(state.hashtags, 80),
      mentions: topEntries(state.mentions, 40),
      domains: topEntries(state.domains, 40),
      sources: topEntries(state.sources, 16),
      tags: topEntries(state.tags, 80),
      media: { ...state.media },
      relationships: {
        replies: state.relationships.replies,
        quotes: state.relationships.quotes,
        reposts: state.relationships.reposts,
        selfThreads: state.relationships.selfThreads,
        conversations: state.relationships.conversations.size,
      },
      personal: { ...state.personal },
      sensitive: state.sensitive,
      engagement: { likes: state.likes, views: state.views },
      range: {
        oldestPosted: state.oldestPosted || null,
        newestPosted: state.newestPosted || null,
        firstArchived: state.firstArchived || null,
        lastArchived: state.lastArchived || null,
      },
      topLiked: state.topLiked.map(entry => compactPost(entry.item)),
      onThisDay: state.onThisDay.map(entry => compactPost(entry.item)),
      sharedMedia,
      ...extra,
    };
  }

  return { add, finish, state };
}

export function buildInsights(posts, options = {}) {
  const accumulator = createInsightsAccumulator(options);
  for (const post of posts || []) accumulator.add(post);
  return accumulator.finish();
}

// Streaks over calendar day keys. A streak still counts as current if it ended yesterday.
export function dayStreaks(days = {}, now = Date.now(), timeZone = 'utc') {
  const keys = Object.keys(days)
    .filter(key => days[key] > 0)
    .sort();
  let longest = 0,
    run = 0,
    previous = 0,
    longestEnd = '';
  for (const key of keys) {
    const stamp = Date.parse(`${key}T00:00:00Z`);
    run = previous && stamp - previous === DAY ? run + 1 : 1;
    if (run > longest) {
      longest = run;
      longestEnd = key;
    }
    previous = stamp;
  }
  const todayKey = dayKeyIn(now, timeZone),
    yesterdayKey =
      timeZone === 'local' ? dayKeyIn(new Date(now).setDate(new Date(now).getDate() - 1), 'local') : dayKey(now - DAY);
  let current = 0;
  const last = keys.at(-1);
  if (last === todayKey || last === yesterdayKey) {
    current = 1;
    for (let index = keys.length - 2; index >= 0; index--) {
      if (Date.parse(`${keys[index + 1]}T00:00:00Z`) - Date.parse(`${keys[index]}T00:00:00Z`) === DAY) current++;
      else break;
    }
  }
  return { longest, longestEnd, current, activeDays: keys.length };
}

const compareIds = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

// Orders a conversation: the ancestor chain of the focused post first, then every other
// archived member by time. Posts by the root author are marked as the thread spine.
export function orderThread(focus, ancestors = [], members = [], quoted = []) {
  const byId = new Map();
  for (const post of [...ancestors, focus, ...members]) if (post?.id) byId.set(String(post.id), post);
  const root = ancestors.find(post => post && !post.replyToId) || ancestors[0] || focus;
  const rootHandle = handleOf(root);
  const time = post => postedStamp(post) || Number(post.archivedAt || 0);
  const posts = [...byId.values()].sort((a, b) => time(a) - time(b) || compareIds(String(a.id), String(b.id)));
  const spine = new Set();
  // Spine: the root and replies by the root author that chain back to an earlier spine post.
  for (const post of posts) {
    const id = String(post.id);
    if (id === String(root.id)) spine.add(id);
    else if (handleOf(post) === rootHandle && post.replyToId && spine.has(String(post.replyToId))) spine.add(id);
  }
  const quotedById = new Map(quoted.filter(Boolean).map(post => [String(post.id), post]));
  return {
    rootId: String(root.id),
    rootHandle,
    missingParent:
      ancestors.length && ancestors[0]?.replyToId && !byId.has(String(ancestors[0].replyToId))
        ? String(ancestors[0].replyToId)
        : focus?.replyToId && !byId.has(String(focus.replyToId))
          ? String(focus.replyToId)
          : null,
    posts: posts.map(post => ({
      ...readerPost(post),
      spine: spine.has(String(post.id)),
      quoted:
        post.quotedPostId && quotedById.has(String(post.quotedPostId))
          ? readerPost(quotedById.get(String(post.quotedPostId)))
          : null,
    })),
  };
}

export function readerPost(post) {
  return {
    id: String(post.id),
    text: String(post.text || ''),
    createdAt: post.createdAt || null,
    archivedAt: Number(post.archivedAt || 0),
    url: post.url || '',
    author: {
      handle: handleOf(post),
      name: String(post.author?.name || ''),
      avatar: String(post.author?.avatar || ''),
      verified: !!post.author?.verified,
    },
    metrics: post.metrics || {},
    media: (Array.isArray(post.media) ? post.media : []).slice(0, 8).map(item => ({
      id: item?.id ? String(item.id) : '',
      type: mediaKind(item),
      url: String(item?.url || ''),
      preview: previewUrl(item?.preview || item?.url || '', 'medium') || String(item?.preview || item?.url || ''),
      playbackUrl: String(item?.playbackUrl || ''),
      width: Number(item?.width) || null,
      height: Number(item?.height) || null,
    })),
    replyToId: post.replyToId ? String(post.replyToId) : null,
    replyToHandle: post.replyToHandle ? String(post.replyToHandle).toLowerCase() : null,
    quotedPostId: post.quotedPostId ? String(post.quotedPostId) : null,
    links: Array.isArray(post.links) ? post.links.slice(0, 20) : [],
    language: post.language || null,
    favorite: !!post.userMeta?.favorite,
    note: String(post.userMeta?.note || '').slice(0, 4000),
    // XVault 20 reading state.
    tags: Array.isArray(post.userMeta?.tags) ? post.userMeta.tags.slice(0, 50) : [],
    readLater: Number(post.userMeta?.readLater) || 0,
    readAt: Number(post.userMeta?.readAt) || 0,
    readProgress: post.userMeta?.readProgress || null,
    highlights: Array.isArray(post.userMeta?.highlights) ? post.userMeta.highlights.slice(0, 200) : [],
  };
}

// Markdown rendering of a thread for copy/export. Text is kept literal.
export function threadMarkdown(thread, { includeReplies = false } = {}) {
  const posts = (thread?.posts || []).filter(post => includeReplies || post.spine);
  if (!posts.length) return '';
  const first = posts[0];
  const lines = [
    `# Thread by @${first.author.handle}${first.author.name ? ` (${first.author.name})` : ''}`,
    '',
    `Source: ${first.url || `https://x.com/i/status/${first.id}`}`,
    '',
  ];
  for (const post of posts) {
    if (!post.spine) lines.push(`> **@${post.author.handle}** replied:`, '>');
    const body = post.text.replace(/\r\n?/g, '\n');
    lines.push(...(post.spine ? body.split('\n') : body.split('\n').map(line => `> ${line}`)));
    for (const item of post.media) if (item.url) lines.push('', `![${item.type}](${item.url})`);
    if (post.quoted) lines.push('', `> Quoting @${post.quoted.author.handle}: ${post.quoted.text.split('\n')[0]}`);
    for (const highlight of post.highlights || [])
      lines.push(
        '',
        `> ==${String(highlight.text).replace(/\s+/g, ' ')}==${highlight.note ? ` — ${highlight.note}` : ''}`
      );
    lines.push(
      '',
      `<sub>${post.createdAt ? new Date(post.createdAt).toISOString().slice(0, 16).replace('T', ' ') : ''} · ${post.url}</sub>`,
      '',
      '---',
      ''
    );
  }
  return lines.join('\n').replace(/\n---\n\n$/, '\n');
}
