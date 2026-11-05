/* XVault 21 — filename and folder templates (window.XVaultFilenameTemplate, CommonJS for tests, imported by the
   service worker). Tokens: {author} {name} {tweetId} {index} {date} {year} {month} {day} {time} {mediaId}
   {type} {source} {width} {height} {quality} {text} {text:N}. Unknown tokens are reported, never left in names. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XVaultFilenameTemplate = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const TOKENS = [
    'author',
    'name',
    'tweetId',
    'index',
    'date',
    'year',
    'month',
    'day',
    'time',
    'mediaId',
    'type',
    'source',
    'width',
    'height',
    'quality',
    'text',
  ];
  const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

  function segment(value, fallback = '_') {
    const out = String(value ?? '')
      .normalize('NFC')
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 120);
    if (!out) return fallback;
    return RESERVED.test(out) ? `_${out}` : out;
  }
  function slug(text, length) {
    return String(text || '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[@#]/g, '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, length)
      .replace(/-+$/g, '');
  }
  function parts(stamp) {
    const date = new Date(stamp || 0);
    if (!Number.isFinite(+date) || +date <= 0) return null;
    const pad = value => String(value).padStart(2, '0');
    return {
      date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      year: String(date.getFullYear()),
      month: pad(date.getMonth() + 1),
      day: pad(date.getDate()),
      time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
    };
  }
  /** Token values for one media item ({ author, name, tweetId, index, createdAt, mediaId, mediaType, source, … }). */
  function values(item = {}) {
    const when = parts(item.createdAt) || { date: 'undated', year: 'undated', month: '00', day: '00', time: '000000' };
    return {
      author: String(item.author || 'x').replace(/^@/, ''),
      name: item.name || item.authorName || item.author || 'x',
      tweetId: String(item.tweetId || '0'),
      index: String(item.index || 1).padStart(2, '0'),
      ...when,
      mediaId: String(item.mediaId || item.tweetId || '0'),
      type: String(item.logicalType || item.mediaType || 'media'),
      source: String(item.source || item.archiveSource || 'archive'),
      width: String(item.width || 0),
      height: String(item.height || 0),
      quality: String(item.videoQuality || item.quality || 'original'),
      text: item.text || '',
    };
  }
  /** Returns { name, issues }. Segments are sanitised; separators inside a filename template are not allowed. */
  function render(template, item, { folder = false } = {}) {
    const issues = [];
    const known = values(item);
    const rendered = String(template || '').replace(/\{([a-zA-Z]+)(?::(\d{1,3}))?\}/g, (match, token, length) => {
      if (!TOKENS.includes(token)) {
        issues.push(`Unknown token {${token}}`);
        return '';
      }
      if (token === 'text') return slug(known.text, Math.max(4, Math.min(120, Number(length) || 40)));
      return known[token];
    });
    if (/\{|\}/.test(rendered)) issues.push('Unbalanced braces');
    const pieces = rendered.split(/[\\/]+/).filter(Boolean);
    if (!folder && pieces.length > 1) issues.push('Filename templates cannot contain folders; use the folder template');
    const name = folder ? pieces.map(piece => segment(piece)).join('/') : segment(pieces.join('_'), 'media');
    if (!folder && !/\{(tweetId|mediaId|index|time)\}/.test(String(template)))
      issues.push('Add {tweetId}, {mediaId} or {index} so files from different posts cannot collide');
    else if (!folder && /\{tweetId\}/.test(String(template)) && !/\{(mediaId|index)\}/.test(String(template)))
      issues.push('Add {index} or {mediaId} so the photos and videos of one post get different names');
    return { name, issues };
  }
  function filename(template, item, ext) {
    return `${render(template, item).name}.${String(ext || 'bin').replace(/^\./, '')}`;
  }
  const SAMPLE = {
    author: 'nasa',
    name: 'NASA',
    tweetId: '1790000000000000001',
    index: 1,
    createdAt: '2024-05-13T17:04:05Z',
    mediaId: '1790000000000000999',
    mediaType: 'image',
    source: 'bookmarks',
    width: 4096,
    height: 2730,
    text: 'Webb’s new view of the Horsehead Nebula 🌌 https://t.co/abc',
  };
  /** Live preview for Settings: example paths for an image, a video and a GIF. */
  function preview(fileTemplate, folderTemplate = '', sample = SAMPLE) {
    const examples = [
      { ...sample, mediaType: 'image', ext: 'jpg' },
      { ...sample, index: 2, mediaType: 'video', videoQuality: '720', width: 1280, height: 720, ext: 'mp4' },
      { ...sample, index: 3, mediaType: 'animated_gif', logicalType: 'animation', ext: 'mp4' },
    ];
    const issues = new Set();
    const paths = examples.map(example => {
      const file = render(fileTemplate, example),
        folderPart = folderTemplate ? render(folderTemplate, example, { folder: true }) : { name: '', issues: [] };
      [...file.issues, ...folderPart.issues].forEach(issue => issues.add(issue));
      return `${folderPart.name ? `${folderPart.name}/` : ''}${file.name}.${example.ext}`;
    });
    if (new Set(paths.map(path => path.replace(/\.[^./]+$/, ''))).size < paths.length)
      issues.add('Two of these example files would get the same name');
    return { paths, issues: [...issues] };
  }
  /**
   * Plans renames of completed files to a new template. rows: [{ key, path, item, ext }] where path is
   * relative to the chosen download folder. Returns moves without collisions and the conflicts found.
   */
  function planRenames(rows, fileTemplate, folderTemplate = '') {
    const taken = new Set(rows.map(row => String(row.path))),
      moves = [],
      conflicts = [];
    for (const row of rows) {
      const folderPart = folderTemplate
        ? render(folderTemplate, row.item, { folder: true }).name
        : String(row.path).split('/').slice(0, -1).join('/');
      const next = `${folderPart ? `${folderPart}/` : ''}${filename(fileTemplate, row.item, row.ext)}`;
      if (next === row.path) continue;
      if (taken.has(next)) {
        conflicts.push({ key: row.key, from: row.path, to: next });
        continue;
      }
      taken.add(next);
      taken.delete(row.path);
      moves.push({ key: row.key, from: row.path, to: next });
    }
    return { moves, conflicts };
  }
  return Object.freeze({ TOKENS, segment, slug, values, render, filename, preview, planRenames, SAMPLE });
});
