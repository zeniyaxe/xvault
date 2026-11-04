// Portable archive exporters. Pure functions: they turn stored post records into CSV rows, Obsidian-compatible
// Markdown notes, or a self-contained offline HTML document. No I/O here — callers stream the output.

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
