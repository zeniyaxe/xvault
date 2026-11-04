// Portable archive exporters. Pure functions: they turn stored post records into CSV rows, Obsidian-compatible
// Markdown notes, or a self-contained offline HTML document. No I/O here — callers stream the output.
import { orderThread } from './vault-insights.mjs';

const POST_URL = post =>
  post?.url || (post?.id ? `https://x.com/${post?.author?.handle || 'i'}/status/${post.id}` : '');
const iso = value => {
  const time = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : '';
};
const meta = post => post?.userMeta || {};
const tagsOf = post => [
  ...new Set((Array.isArray(meta(post).tags) ? meta(post).tags : []).map(String).filter(Boolean)),
];
const mediaUrl = item => item?.playbackUrl || item?.variants?.[0]?.url || item?.url || '';

// ---------------------------------------------------------------- CSV

export const CSV_COLUMNS = [
  'id',
  'url',
  'createdAt',
  'archivedAt',
  'author',
  'authorName',
  'text',
  'likes',
  'reposts',
  'replies',
  'views',
  'mediaCount',
  'mediaUrls',
  'tags',
  'favorite',
  'note',
  'replyToId',
  'quotedPostId',
];

// Spreadsheet apps execute cells starting with = + - @ (and tab/CR) as formulas; neutralise them.
export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvHeader() {
  return `\ufeff${CSV_COLUMNS.join(',')}\r\n`;
}

export function csvRow(post) {
  const m = post?.metrics || {};
  const values = [
    post?.id,
    POST_URL(post),
    iso(post?.createdAt),
    iso(post?.archivedAt),
    post?.author?.handle,
    post?.author?.name,
    post?.text,
    m.likes,
    m.reposts,
    m.replies,
    m.views,
    (post?.media || []).length,
    (post?.media || []).map(mediaUrl).filter(Boolean).join(' '),
    tagsOf(post).join(' '),
    meta(post).favorite ? 'true' : 'false',
    meta(post).note,
    post?.replyToId,
    post?.quotedPostId,
  ];
  return `${values.map(csvCell).join(',')}\r\n`;
}

// ---------------------------------------------------------------- Markdown / Obsidian

const yamlString = value => JSON.stringify(String(value ?? '')); // JSON strings are valid YAML scalars
const obsidianTag = tag =>
  String(tag)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_/-]/gu, '');

export function safeFileName(value, fallback = 'post') {
  const name = String(value || '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
    .trim();
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) || !name ? fallback : name;
}

export function markdownFileName(post) {
  const day = iso(post?.createdAt || post?.archivedAt).slice(0, 10) || 'undated';
  const handle = safeFileName(post?.author?.handle || 'unknown', 'unknown');
  return `${day} @${handle} ${safeFileName(post?.id, 'post')}.md`;
}

export function markdownNote(post) {
  const m = post?.metrics || {};
  const tags = tagsOf(post).map(obsidianTag).filter(Boolean);
  const lines = [
    '---',
    `id: ${yamlString(post?.id)}`,
    `url: ${yamlString(POST_URL(post))}`,
    `author: ${yamlString(post?.author?.handle ? `@${post.author.handle}` : '')}`,
    post?.author?.name ? `author_name: ${yamlString(post.author.name)}` : null,
    iso(post?.createdAt) ? `created: ${iso(post.createdAt)}` : null,
    iso(post?.archivedAt) ? `archived: ${iso(post.archivedAt)}` : null,
    `favorite: ${meta(post).favorite ? 'true' : 'false'}`,
    tags.length ? `tags:\n${tags.map(t => `  - ${yamlString(t)}`).join('\n')}` : 'tags: []',
    m.likes != null ? `likes: ${Number(m.likes) || 0}` : null,
    m.reposts != null ? `reposts: ${Number(m.reposts) || 0}` : null,
    m.views != null ? `views: ${Number(m.views) || 0}` : null,
    post?.replyToId ? `reply_to: ${yamlString(post.replyToId)}` : null,
    post?.quotedPostId ? `quoted: ${yamlString(post.quotedPostId)}` : null,
    'source: xvault',
    '---',
    '',
    escapeMarkdownText(post?.text || ''),
    '',
  ].filter(line => line !== null);
  const media = (post?.media || []).map(mediaUrl).filter(Boolean);
  if (media.length) {
    lines.push('## Media', '');
    for (const [index, url] of media.entries()) {
      const kind = post.media[index]?.type;
      lines.push(kind === 'photo' ? `![media ${index + 1}](${url})` : `- [${kind || 'media'} ${index + 1}](${url})`);
    }
    lines.push('');
  }
  if (meta(post).note) lines.push('## Note', '', String(meta(post).note), '');
  lines.push(`[Open on X](${POST_URL(post)})`, '');
  return lines.join('\n');
}

// Keep the author's words literal: neutralise Markdown/HTML syntax that would otherwise render.
function escapeMarkdownText(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/([\\`*_[\]<>|])/g, '\\$1')
    .replace(/^(\s*)([#>+-]|\d+\.)(?=\s)/gm, '$1\\$2')
    .replace(/\n/g, '  \n');
}

export function markdownIndex(entries, generatedAt = Date.now()) {
  const rows = entries.map(
    e => `- [[${e.file.replace(/\.md$/, '')}]] — @${e.handle || 'unknown'}${e.text ? `: ${oneLine(e.text)}` : ''}`
  );
  return [
    '---',
    `generated: ${iso(generatedAt)}`,
    `posts: ${entries.length}`,
    '---',
    '',
    '# XVault archive',
    '',
    ...rows,
    '',
  ].join('\n');
}

const oneLine = text => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return (flat.length > 90 ? `${flat.slice(0, 89)}…` : flat).replace(/[[\]|]/g, ' ');
};

// ---------------------------------------------------------------- Self-contained HTML

const escapeHtml = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const safeHref = value => {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
};

export function htmlHead(title = 'XVault archive', generatedAt = Date.now()) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; media-src https:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#111214;--fg:#e8e6e1;--mut:#9a978f;--line:#2a2b2e;--acc:#d9a441}
@media (prefers-color-scheme:light){:root{--bg:#faf9f6;--fg:#1d1c1a;--mut:#6b6860;--line:#e3e0d8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
h1{font:600 18px/1.2 Georgia,serif;margin:0}input{flex:1;min-width:200px;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit}
main{max-width:760px;margin:0 auto;padding:12px 20px 60px}article{border-bottom:1px solid var(--line);padding:18px 0}
.by{color:var(--mut);font-size:13px}.by b{color:var(--fg)}.text{white-space:pre-wrap;margin:8px 0}.tags span{display:inline-block;font-size:12px;border:1px solid var(--line);border-radius:99px;padding:1px 8px;margin:2px 4px 0 0;color:var(--mut)}
.media{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px;margin-top:8px}.media img,.media video{width:100%;border-radius:8px;background:#0003}
.note{border-left:3px solid var(--acc);padding:4px 10px;color:var(--mut);margin-top:8px}a{color:var(--acc)}.fav{color:var(--acc)}
</style></head><body>
<header><h1>${escapeHtml(title)}</h1><span class="by" id="count"></span><input id="q" type="search" placeholder="Filter posts…" aria-label="Filter posts"></header>
<main id="posts" data-generated="${escapeHtml(iso(generatedAt))}">
`;
}

const poster = (item, src) => {
  const still = safeHref(item?.url);
  return still && still !== src ? ` poster="${escapeHtml(still)}"` : '';
};

export function htmlPost(post) {
  const date = iso(post?.createdAt);
  const media = (post?.media || [])
    .map(item => {
      const src = safeHref(mediaUrl(item));
      if (!src) return '';
      return item?.type === 'photo'
        ? `<img loading="lazy" src="${escapeHtml(src)}" alt="">`
        : `<video controls preload="none"${poster(item, src)} src="${escapeHtml(src)}"></video>`;
    })
    .join('');
  const tags = tagsOf(post)
    .map(t => `<span>#${escapeHtml(t)}</span>`)
    .join('');
  const href = safeHref(POST_URL(post));
  return `<article data-search="${escapeHtml(`${post?.author?.handle || ''} ${post?.text || ''} ${tagsOf(post).join(' ')}`.toLowerCase())}">
<div class="by"><b>${escapeHtml(post?.author?.name || post?.author?.handle || 'Unknown')}</b> @${escapeHtml(post?.author?.handle || 'unknown')}${date ? ` · <time datetime="${date}">${date.slice(0, 10)}</time>` : ''}${meta(post).favorite ? ' · <span class="fav">★</span>' : ''}${href ? ` · <a href="${escapeHtml(href)}" rel="noreferrer noopener" target="_blank">Open</a>` : ''}</div>
<div class="text">${escapeHtml(post?.text || '')}</div>${media ? `<div class="media">${media}</div>` : ''}${tags ? `<div class="tags">${tags}</div>` : ''}${meta(post).note ? `<div class="note">${escapeHtml(meta(post).note)}</div>` : ''}
</article>
`;
}

export function htmlFoot() {
  return `</main><script>
const q=document.getElementById('q'),rows=[...document.querySelectorAll('article')],count=document.getElementById('count');
const show=()=>{const v=q.value.trim().toLowerCase();let n=0;for(const r of rows){const on=!v||v.split(/\\s+/).every(t=>r.dataset.search.includes(t));r.hidden=!on;n+=on}count.textContent=n.toLocaleString()+' posts'};
q.addEventListener('input',show);show();
</script></body></html>
`;
}

// ---------------------------------------------------------------- Thread-grouped exports
// Posts are grouped into conversations (conversationId, else reply chains), ordered chronologically
// with the Reader's orderThread(), and rendered with authors, timestamps, relationships and media.

const postTime = post => Date.parse(post?.createdAt || '') || Number(post?.archivedAt || 0) || 0;

/** Lightweight row kept in memory for grouping (no text or media). */
export function threadKeyRow(post) {
  return {
    id: String(post?.id || ''),
    conversationId: post?.conversationId ? String(post.conversationId) : '',
    replyToId: post?.replyToId ? String(post.replyToId) : '',
    time: postTime(post),
  };
}

/**
 * Groups key rows into threads. Returns [{ key, ids, start, end }] sorted oldest first.
 * Union-find over reply edges joins posts without a conversationId (older captures).
 */
export function threadGroups(rows) {
  const parent = new Map();
  const find = id => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root);
    let cursor = id;
    while (parent.has(cursor) && parent.get(cursor) !== root) {
      const next = parent.get(cursor);
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const row of rows) {
    if (!row.id) continue;
    if (!parent.has(row.id)) parent.set(row.id, row.id);
    if (row.conversationId) union(row.id, `c:${row.conversationId}`);
    if (row.replyToId) union(row.id, row.replyToId);
  }
  const groups = new Map();
  for (const row of rows) {
    if (!row.id) continue;
    const key = find(row.id);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { key, ids: [], start: Infinity, end: 0 }));
    group.ids.push(row.id);
    group.start = Math.min(group.start, row.time || Infinity);
    group.end = Math.max(group.end, row.time || 0);
  }
  return [...groups.values()]
    .map(group => ({ ...group, start: Number.isFinite(group.start) ? group.start : 0 }))
    .sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
}

/** Orders one group of full post records (plus any archived quoted posts) like the Reader does. */
export function buildThread(posts, quoted = []) {
  const sorted = [...posts].sort((a, b) => postTime(a) - postTime(b));
  const ids = new Set(sorted.map(post => String(post.id)));
  const root = sorted.find(post => !post.replyToId || !ids.has(String(post.replyToId))) || sorted[0];
  const thread = orderThread(root, [], sorted, quoted);
  const byId = new Map(sorted.map(post => [String(post.id), post]));
  // Keep fields the Reader projection drops but exports need (tags, notes, full media variants).
  thread.posts = thread.posts.map(post => ({ ...post, record: byId.get(post.id) || null }));
  thread.participants = [...new Set(thread.posts.map(post => post.author.handle))];
  thread.start = postTime(sorted[0]);
  thread.end = postTime(sorted[sorted.length - 1]);
  return thread;
}

const stamp = value => {
  const text = iso(value);
  return text ? text.slice(0, 16).replace('T', ' ') + ' UTC' : 'undated';
};
function relation(post, thread) {
  const byId = new Map(thread.posts.map(item => [item.id, item]));
  if (post.replyToId) {
    const parent = byId.get(post.replyToId);
    return parent
      ? `reply to @${parent.author.handle}`
      : `reply to ${post.replyToHandle ? `@${post.replyToHandle}` : 'a post'} (not archived)`;
  }
  return post.id === thread.rootId ? 'thread start' : '';
}

export function threadFileName(thread) {
  const first = thread.posts[0];
  const day = iso(thread.start || first?.archivedAt).slice(0, 10) || 'undated';
  return `${day} @${safeFileName(thread.rootHandle || 'unknown', 'unknown')} thread ${safeFileName(thread.rootId, 'thread')}.md`;
}

export function threadMarkdownNote(thread) {
  const first = thread.posts[0];
  const tags = [...new Set(thread.posts.flatMap(post => tagsOf(post.record)))].map(obsidianTag).filter(Boolean);
  const lines = [
    '---',
    `thread_id: ${yamlString(thread.rootId)}`,
    `url: ${yamlString(first?.url || `https://x.com/i/status/${thread.rootId}`)}`,
    `author: ${yamlString(`@${thread.rootHandle}`)}`,
    `participants:\n${thread.participants.map(handle => `  - ${yamlString(`@${handle}`)}`).join('\n')}`,
    `posts: ${thread.posts.length}`,
    iso(thread.start) ? `started: ${iso(thread.start)}` : null,
    iso(thread.end) ? `last_post: ${iso(thread.end)}` : null,
    thread.missingParent ? `missing_parent: ${yamlString(thread.missingParent)}` : null,
    tags.length ? `tags:\n${tags.map(t => `  - ${yamlString(t)}`).join('\n')}` : 'tags: []',
    'source: xvault',
    '---',
    '',
    `# Thread by @${thread.rootHandle}${first?.author?.name ? ` (${escapeMarkdownText(first.author.name)})` : ''}`,
    '',
  ].filter(line => line !== null);
  if (thread.missingParent)
    lines.push(`> Starts with a reply to a post that is not in the archive (${thread.missingParent}).`, '');
  for (const post of thread.posts) {
    const rel = relation(post, thread);
    lines.push(
      `## ${post.spine ? '' : '↳ '}@${post.author.handle} · ${stamp(post.createdAt || post.archivedAt)}`,
      '',
      `<small>${[rel, post.quoted ? `quoting @${post.quoted.author.handle}` : '', `id ${post.id}`].filter(Boolean).join(' · ')}</small>`,
      ''
    );
    const body = escapeMarkdownText(post.text).replace(/\r\n?/g, '\n');
    lines.push(...(post.spine ? body.split('\n') : body.split('\n').map(line => `> ${line}`)), '');
    const media = (post.record?.media || post.media || [])
      .map(item => [item?.type, mediaUrl(item)])
      .filter(([, url]) => url);
    for (const [index, [kind, url]] of media.entries())
      lines.push(kind === 'photo' ? `![media ${index + 1}](${url})` : `- [${kind || 'media'} ${index + 1}](${url})`);
    if (media.length) lines.push('');
    if (post.quoted)
      lines.push(
        ...escapeMarkdownText(`@${post.quoted.author.handle}: ${post.quoted.text}`)
          .split('\n')
          .map(line => `> > ${line}`),
        ''
      );
    if (meta(post.record).note) lines.push(`**Note:** ${String(meta(post.record).note)}`, '');
    lines.push(`[Open on X](${post.url || `https://x.com/${post.author.handle}/status/${post.id}`})`, '');
  }
  return lines.join('\n');
}

export function threadMarkdownIndex(entries, generatedAt = Date.now()) {
  const lines = [
    '# XVault threads',
    '',
    `Exported ${iso(generatedAt)} · ${entries.length} conversations`,
    '',
    '| Started | Author | Posts | Thread |',
    '| --- | --- | --- | --- |',
  ];
  for (const entry of entries)
    lines.push(
      `| ${iso(entry.start).slice(0, 10) || '—'} | @${oneLine(entry.handle || 'unknown')} | ${entry.posts} | [[${entry.file.replace(/\.md$/, '')}\\|${oneLine(entry.text || entry.file).slice(0, 80)}]] |`
    );
  return `${lines.join('\n')}\n`;
}

export function htmlThreadHead(title = 'XVault threads', generatedAt = Date.now()) {
  return htmlHead(title, generatedAt)
    .replace(
      '</style>',
      `section.thread{border-bottom:1px solid var(--line);padding:14px 0 18px}section.thread>h2{font:600 16px/1.3 Georgia,serif;margin:6px 0 2px}
section.thread article{border:0;padding:10px 0 4px}section.thread article.reply{margin-left:18px;padding-left:14px;border-left:2px solid var(--line)}
.rel{font-size:12px;color:var(--mut)}.quote{border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-top:8px;font-size:14px}
</style>`
    )
    .replace(
      'placeholder="Filter posts…" aria-label="Filter posts"',
      'placeholder="Filter threads…" aria-label="Filter threads"'
    );
}

export function htmlThread(thread) {
  const search = thread.posts
    .map(post => `${post.author.handle} ${post.text}`)
    .join(' ')
    .toLowerCase();
  const articles = thread.posts
    .map(post => {
      const media = (post.record?.media || post.media || [])
        .map(item => {
          const src = safeHref(mediaUrl(item));
          if (!src) return '';
          return item?.type === 'photo'
            ? `<img loading="lazy" src="${escapeHtml(src)}" alt="">`
            : `<video controls preload="none"${poster(item, src)} src="${escapeHtml(src)}"></video>`;
        })
        .join('');
      const href = safeHref(post.url || `https://x.com/${post.author.handle}/status/${post.id}`);
      const date = iso(post.createdAt);
      const rel = relation(post, thread);
      return `<article class="${post.spine ? 'spine' : 'reply'}" id="p${escapeHtml(post.id)}">
<div class="by"><b>${escapeHtml(post.author.name || post.author.handle)}</b> @${escapeHtml(post.author.handle)}${date ? ` · <time datetime="${date}">${escapeHtml(stamp(date))}</time>` : ''}${href ? ` · <a href="${escapeHtml(href)}" rel="noreferrer noopener" target="_blank">Open</a>` : ''}</div>
${rel ? `<div class="rel">${escapeHtml(rel)}</div>` : ''}<div class="text">${escapeHtml(post.text)}</div>${media ? `<div class="media">${media}</div>` : ''}${post.quoted ? `<div class="quote"><div class="by">@${escapeHtml(post.quoted.author.handle)}</div><div class="text">${escapeHtml(post.quoted.text)}</div></div>` : ''}${meta(post.record).note ? `<div class="note">${escapeHtml(meta(post.record).note)}</div>` : ''}
</article>`;
    })
    .join('\n');
  const date = iso(thread.start).slice(0, 10);
  return `<section class="thread" data-search="${escapeHtml(search)}">
<h2>@${escapeHtml(thread.rootHandle)}${date ? ` · ${escapeHtml(date)}` : ''} <span class="by">${thread.posts.length} ${thread.posts.length === 1 ? 'post' : 'posts'}${thread.participants.length > 1 ? ` · ${thread.participants.length} people` : ''}</span></h2>
${thread.missingParent ? `<div class="rel">Begins with a reply to a post that is not in the archive.</div>` : ''}${articles}
</section>
`;
}

export function htmlThreadFoot() {
  return htmlFoot()
    .replace("querySelectorAll('article')", "querySelectorAll('section.thread')")
    .replace("' posts'", "' threads'");
}
