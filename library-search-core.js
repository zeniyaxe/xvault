/* Small, serializable Library search rules shared by the dashboard worker and tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XVaultLibrarySearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const METRICS = new Set(['likes', 'views', 'bookmarks', 'reposts', 'replies']);

  function tokenizeQuery(query) {
    return (String(query || '').match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(value => value.replace(/^"|"$/g, ''));
  }

  function parseNum(value) {
    const match = String(value || '')
      .toLowerCase()
      .match(/^([0-9.]+)([kmb])?$/);
    if (!match) return Number(value) || 0;
    const scales = { k: 1e3, m: 1e6, b: 1e9 };
    return Number(match[1]) * (scales[match[2]] || 1);
  }

  // Search syntax (all terms are ANDed):
  //   word "exact phrase"        text / handle match
  //   key:value                  structured filter (see compileSingle)
  //   key:a|b|c                  any of several values for the same filter
  //   -word / -key:value         negation of any term
  //   https://x.com/...          URLs are matched as text, never treated as filters
  function compileToken(token) {
    const raw = String(token);
    if (raw.length > 1 && raw[0] === '-' && raw[1] !== '-') {
      const inner = compileToken(raw.slice(1));
      return inner.kind === 'never' && inner.issue ? inner : { ...inner, negate: true };
    }
    const [rawKey, ...rest] = raw.split(':');
    const value = rest.join(':');
    if (rest.length && /^https?$/i.test(rawKey) && value.startsWith('//'))
      return { kind: 'text', value: raw.toLowerCase() };
    if (rest.length && value.includes('|') && !value.startsWith('"')) {
      const rules = value
        .split('|')
        .filter(Boolean)
        .map(part => compileSingle(`${rawKey}:${part}`));
      const issue = rules.find(rule => rule.issue)?.issue;
      if (issue) return { kind: 'never', issue };
      if (rules.length === 1) return rules[0];
      return { kind: 'any', rules };
    }
    return compileSingle(raw);
  }

  const DAY = 86400000;
  const RELATIVE_UNITS = { h: 3600000, d: DAY, w: 7 * DAY, m: 30 * DAY, y: 365 * DAY };
  const IS_VALUES = ['reply', 'quote', 'repost', 'original', 'thread', 'favorite', 'sensitive', 'media', 'text'];

  // Day filters follow the calendar setting (XVault 19): 'utc' (XVault 18 behaviour) or 'local'.
  let calendarZone = 'utc';
  function setCalendarTimeZone(zone) {
    calendarZone = zone === 'local' ? 'local' : 'utc';
  }
  function dayStamp(value) {
    const stamp = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) return NaN;
    if (calendarZone !== 'local') return stamp;
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day).getTime();
  }
  function nextDay(stamp) {
    if (calendarZone !== 'local') return stamp + DAY;
    const date = new Date(stamp);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  }
  function yearStart(year) {
    return calendarZone === 'local' ? new Date(year, 0, 1).getTime() : Date.UTC(year, 0, 1);
  }

  function compileSingle(token) {
    const [rawKey, ...rest] = String(token).split(':');
    const value = rest.join(':').replace(/^"|"$/g, '').toLowerCase();
    if (!value) {
      const plain = String(token).toLowerCase();
      if (/^#[^\s#]{1,140}$/u.test(plain)) return { kind: 'hashtag', value: plain.slice(1) };
      if (/^@[a-z0-9_]{1,30}$/.test(plain)) return { kind: 'mention', value: plain.slice(1) };
      return { kind: 'text', value: plain };
    }
    const key = rawKey.toLowerCase();
    if (key === 'on' || key === 'archived-on') {
      const stamp = dayStamp(value);
      if (!Number.isFinite(stamp)) return { kind: 'never', issue: `${key}: use a valid YYYY-MM-DD date` };
      return { kind: 'range', field: key === 'on' ? 'postedAt' : 'archivedAt', start: stamp, end: nextDay(stamp) };
    }
    if (key === 'year' || key === 'archived-year') {
      if (!/^\d{4}$/.test(value)) return { kind: 'never', issue: `${key}: use a four-digit year` };
      return {
        kind: 'range',
        field: key === 'year' ? 'postedAt' : 'archivedAt',
        start: yearStart(Number(value)),
        end: yearStart(Number(value) + 1),
      };
    }
    if (key === 'within' || key === 'archived-within') {
      const match = /^(\d{1,4})([hdwmy])$/.exec(value);
      if (!match) return { kind: 'never', issue: `${key}: use a span such as 24h, 7d, 2w, 3m or 1y` };
      return {
        kind: 'range',
        field: key === 'within' ? 'postedAt' : 'archivedAt',
        start: Date.now() - Number(match[1]) * RELATIVE_UNITS[match[2]],
        end: Number.MAX_SAFE_INTEGER,
      };
    }
    if (key === 'lang' || key === 'language') return { kind: 'language', value };
    if (key === 'is') {
      const wanted = value === 'retweet' || value === 'rt' ? 'repost' : value === 'self-thread' ? 'thread' : value;
      return IS_VALUES.includes(wanted)
        ? { kind: 'is', value: wanted }
        : { kind: 'never', issue: `is: use ${IS_VALUES.join(', ')}` };
    }
    if (key === 'domain' || key === 'site') return { kind: 'domain', value: value.replace(/^www\./, '') };
    if (key === 'hashtag') return { kind: 'hashtag', value: value.replace(/^#/, '') };
    if (key === 'mention' || key === 'mentions') return { kind: 'mention', value: value.replace(/^@/, '') };
    if (key === 'thread' || key === 'conversation') {
      if (!/^\d{1,32}$/.test(value)) return { kind: 'never', issue: `${key}: use a post ID` };
      return { kind: 'conversation', value };
    }
    if (key === 'quotes' || key === 'quoting') {
      if (!/^\d{1,32}$/.test(value)) return { kind: 'never', issue: `${key}: use a post ID` };
      return { kind: 'quotes', value };
    }
    if (key === 'media' || key === 'items') {
      const match = /^(>=|<=|>|<|=)?(\d{1,3})$/.exec(value);
      if (!match) return { kind: 'never', issue: `${key}: use a count such as >2` };
      return { kind: 'mediaCount', operator: match[1] || '=', number: Number(match[2]) };
    }
    if (['before', 'after', 'archived-before', 'archived-after'].includes(key)) {
      const stamp = dayStamp(value);
      if (!Number.isFinite(stamp)) return { kind: 'never', issue: `${key}: use a valid YYYY-MM-DD date` };
      return {
        kind: 'date',
        field: key.startsWith('archived-') ? 'archivedAt' : 'postedAt',
        after: key.endsWith('after'),
        value: stamp,
      };
    }
    if (key === 'inbox')
      return value === 'true' || value === 'false'
        ? { kind: 'inbox', value: value === 'true' }
        : { kind: 'never', issue: 'inbox: use true or false' };
    if (key === 'untagged')
      return value === 'true' || value === 'false'
        ? { kind: 'untagged', value: value === 'true' }
        : { kind: 'never', issue: 'untagged: use true or false' };
    if (key === 'size') {
      const match = /^(>=|<=|>|<|=)?(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/.exec(value);
      if (!match) return { kind: 'never', issue: 'size: use a comparison such as >100mb' };
      return {
        kind: 'size',
        operator: match[1] || '=',
        number: Number(match[2]) * { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[match[3] || 'b'],
      };
    }
    if (key === 'from' || key === 'artist' || key === 'author')
      return { kind: 'author', value: value.replace(/^@/, '') };
    if (key === 'type' || key === 'has') {
      if (value === 'gif' || value === 'animation') return { kind: 'animation' };
      if (value === 'video') return { kind: 'mediaType', value: 'video' };
      if (value === 'image' || value === 'photo') return { kind: 'mediaType', value: 'photo' };
      if (value === 'media') return { kind: 'hasMedia' };
      if (key === 'has' && (value === 'note' || value === 'notes')) return { kind: 'note', value: true };
      if (key === 'has' && (value === 'tag' || value === 'tags')) return { kind: 'untagged', value: false };
      if (key === 'has' && (value === 'download' || value === 'file')) return { kind: 'downloaded', value: true };
      if (key === 'has' && (value === 'ocr' || value === 'text-in-image')) return { kind: 'ocr' };
      return {
        kind: 'never',
        issue: `${key}: use video, gif, image, media${key === 'has' ? ', note, tag, download or ocr' : ''}`,
      };
    }
    if (key === 'source') return { kind: 'source', value };
    if (key === 'rating') return { kind: 'rating', value: value === 'sensitive' };
    if (key === 'fav' || key === 'favorite')
      return value === 'true' || value === 'false' ? { kind: 'favorite', value: value === 'true' } : { kind: 'never' };
    if (key === 'tag') return { kind: 'tag', value };
    if (METRICS.has(key)) {
      const operator = value.startsWith('>=') ? '>=' : value.startsWith('<=') ? '<=' : value[0];
      return { kind: 'metric', key, operator, number: parseNum(value.replace(/^[<>]=?/, '') || 0) };
    }
    if (key === 'id') return { kind: 'id', value };
    if (key === 'annotation') return { kind: 'annotationText', value };
    if (key === 'ocr' || key === 'image-text') return { kind: 'ocrText', value };
    if (key === 'media-note' || key === 'medianote') return { kind: 'mediaNoteText', value };
    if (key === 'note' && value !== 'true' && value !== 'false') return { kind: 'noteText', value };
    if (key === 'downloaded' || key === 'missing' || key === 'note') {
      if (value !== 'true' && value !== 'false') return { kind: 'never', issue: `${key}: use true or false` };
      return { kind: key, value: value === 'true' };
    }
    return { kind: 'never', issue: `Unsupported filter: ${rawKey}` };
  }

  function compileQuery(query) {
    return tokenizeQuery(query).map(compileToken);
  }

  function matchesCompiledToken(row, rule) {
    const result = rule.kind === 'any' ? rule.rules.some(sub => matchRule(row, sub)) : matchRule(row, rule);
    return rule.negate ? !result : result;
  }

  // True when any compiled rule (including alternatives) has one of the given kinds.
  function usesRuleKind(compiled, kinds) {
    const wanted = new Set(kinds);
    const visit = rule => wanted.has(rule.kind) || (rule.kind === 'any' && rule.rules.some(visit));
    return (compiled || []).some(visit);
  }

  function compareNumber(value, operator, number) {
    if (operator === '>') return value > number;
    if (operator === '<') return value < number;
    if (operator === '>=') return value >= number;
    if (operator === '<=') return value <= number;
    return value === number;
  }

  function matchIs(row, value) {
    if (value === 'reply') return !!row.isReply;
    if (value === 'quote') return !!row.isQuote;
    if (value === 'repost') return !!row.isRepost;
    if (value === 'original') return !row.isReply && !row.isRepost;
    if (value === 'thread') return !!row.isSelfThread;
    if (value === 'favorite') return !!row.favorite;
    if (value === 'sensitive') return !!row.sensitive;
    if (value === 'media') return row.mediaCount > 0;
    if (value === 'text') return !row.mediaCount;
    return false;
  }

  function matchRule(row, rule) {
    if (rule.kind === 'range') {
      const value = Number(row[rule.field]);
      return Number.isFinite(value) && value > 0 && value >= rule.start && value < rule.end;
    }
    if (rule.kind === 'language') return String(row.language || '') === rule.value;
    if (rule.kind === 'is') return matchIs(row, rule.value);
    if (rule.kind === 'hashtag')
      return (row.hashtags || []).includes(rule.value) || String(row.text || '').includes(`#${rule.value}`);
    if (rule.kind === 'mention')
      return (row.mentions || []).includes(rule.value) || String(row.text || '').includes(`@${rule.value}`);
    if (rule.kind === 'domain')
      return (
        (row.domains || []).some(domain => domain === rule.value || domain.endsWith(`.${rule.value}`)) ||
        String(row.text || '').includes(rule.value)
      );
    if (rule.kind === 'conversation') return row.conversationId === rule.value || row.id === rule.value;
    if (rule.kind === 'quotes') return row.quotedPostId === rule.value;
    if (rule.kind === 'mediaCount') return compareNumber(Number(row.mediaCount) || 0, rule.operator, rule.number);
    if (rule.kind === 'ocr') return !!row.ocrText;
    if (rule.kind === 'ocrText') return String(row.ocrText || '').includes(rule.value);
    if (rule.kind === 'date') {
      const value = Number(row[rule.field]);
      return Number.isFinite(value) && value > 0 && (rule.after ? value >= rule.value : value < rule.value);
    }
    if (rule.kind === 'inbox') return row.inbox === rule.value;
    if (rule.kind === 'untagged') return !(row.tags || []).length === rule.value;
    if (rule.kind === 'size') {
      const value = Number(row.knownBytes);
      if (!(value > 0)) return false;
      return rule.operator === '>'
        ? value > rule.number
        : rule.operator === '<'
          ? value < rule.number
          : rule.operator === '>='
            ? value >= rule.number
            : rule.operator === '<='
              ? value <= rule.number
              : value === rule.number;
    }
    if (rule.kind === 'text') return row.text.includes(rule.value) || row.handle.includes(rule.value);
    if (rule.kind === 'author') return row.handle === rule.value;
    if (rule.kind === 'animation')
      return row.mediaTypes.some(type => type === 'animated_gif' || type.includes('gif') || type.includes('webp'));
    if (rule.kind === 'mediaType') return row.mediaTypes.includes(rule.value);
    if (rule.kind === 'hasMedia') return row.mediaCount > 0;
    if (rule.kind === 'never') return false;
    if (rule.kind === 'source') return row.sources.some(source => source.includes(rule.value));
    if (rule.kind === 'rating') return rule.value ? row.sensitive : !row.sensitive;
    if (rule.kind === 'favorite') return row.favorite === rule.value;
    if (rule.kind === 'tag') return row.tags.some(tag => tag.includes(rule.value));
    if (rule.kind === 'metric') {
      const raw = Number(row.metrics[rule.key] || 0);
      if (rule.operator === '>') return raw > rule.number;
      if (rule.operator === '<') return raw < rule.number;
      if (rule.operator === '>=') return raw >= rule.number;
      if (rule.operator === '<=') return raw <= rule.number;
      return raw === rule.number;
    }
    if (rule.kind === 'id') return row.id === rule.value;
    if (rule.kind === 'downloaded') return row.downloaded === rule.value;
    if (rule.kind === 'missing') return row.missing === rule.value;
    if (rule.kind === 'note') return row.note === rule.value;
    if (rule.kind === 'noteText') return String(row.noteText || '').includes(rule.value);
    if (rule.kind === 'annotationText') return String(row.annotationText || '').includes(rule.value);
    if (rule.kind === 'mediaNoteText') return String(row.mediaNoteText || '').includes(rule.value);
    return true;
  }

  function matchesCompiledQuery(row, query) {
    return query.every(rule => matchesCompiledToken(row, rule));
  }

  function matchesToken(row, token) {
    return matchesCompiledToken(row, compileToken(token));
  }

  function matchesQuery(row, query) {
    return matchesCompiledQuery(row, compileQuery(query));
  }

  function matchesTokens(row, tokens) {
    return matchesCompiledQuery(row, tokens.map(compileToken));
  }

  function compareRows(a, b, sort) {
    const metric = METRICS.has(sort) ? sort : null;
    let result;
    if (metric) result = Number(b.metrics[metric] || 0) - Number(a.metrics[metric] || 0);
    else if (sort === 'old') result = sortableArchiveTime(a.archivedAt, true) - sortableArchiveTime(b.archivedAt, true);
    else if (sort === 'media') result = b.mediaCount - a.mediaCount;
    else if (sort === 'author') result = a.handle.localeCompare(b.handle);
    else if (sort === 'random') result = Number(a.randomOrder || 0) - Number(b.randomOrder || 0);
    else result = sortableArchiveTime(b.archivedAt, false) - sortableArchiveTime(a.archivedAt, false);
    return result || a.index - b.index;
  }

  function sortableArchiveTime(value, oldFirst) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
    return oldFirst ? Number.MAX_SAFE_INTEGER : 0;
  }

  function searchRecords(rows, query, sort = 'new') {
    const compiled = compileQuery(query);
    return rows
      .filter(row => matchesCompiledQuery(row, compiled))
      .sort((a, b) => compareRows(a, b, sort))
      .map(row => row.index);
  }

  function queryIssues(query) {
    return compileQuery(query)
      .filter(rule => rule.issue)
      .map(rule => rule.issue);
  }

  const _asset =
    (typeof globalThis !== 'undefined' && globalThis.XVaultMediaAsset) ||
    (typeof require === 'function'
      ? (() => {
          try {
            return require('./media-asset.js');
          } catch {
            return null;
          }
        })()
      : null);
  const sameMedia = (a, b) => a === b || Boolean(a && b && _asset && _asset.sameAsset(a, b));

  function projectPost(post, index = 0, options = {}) {
    const meta = post.userMeta || {},
      media = post.media || [];
    const mediaNotes = media.map(item => String(item?.xvault?.note || '').toLowerCase()).filter(Boolean);
    const annotationTexts = media.flatMap(item =>
      (Array.isArray(item?.xvault?.annotations) ? item.xvault.annotations : [])
        .filter(annotation => !annotation?.deletedAt)
        .map(annotation => String(annotation?.text || '').toLowerCase())
        .filter(Boolean)
    );
    const mediaTags = media.flatMap(item => (Array.isArray(item?.xvault?.tags) ? item.xvault.tags : []));
    const tags = [
      ...new Set(
        [...(Array.isArray(meta.tags) ? meta.tags : []), ...mediaTags]
          .filter(value => typeof value === 'string')
          .map(value => value.toLowerCase())
      ),
    ];
    const downloads = options.downloads || [];
    const complete = downloads.filter(
      row =>
        row.state === 'complete' &&
        !['mismatch', 'corrupt', 'missing'].includes(row.verification?.state || row.verificationState)
    );
    return {
      index,
      id: String(post.id || '').toLowerCase(),
      text: String(post.text || '').toLowerCase(),
      handle: String(post.author?.handle || '')
        .replace(/^@/, '')
        .toLowerCase(),
      mediaTypes: media.map(item => String(item.type || '').toLowerCase()),
      mediaCount: media.length,
      sources: [...(post.sourceFlags || []), ...(post.archiveSources || [])].map(value => String(value).toLowerCase()),
      sensitive: !!post.sensitive,
      favorite: !!meta.favorite,
      tags,
      metrics: post.metrics || {},
      downloaded: complete.length > 0,
      missing: media.some(
        item =>
          !complete.some(row => {
            if (item.id && row.item?.mediaId && String(item.id) === String(row.item.mediaId)) return true;
            return [item.url, item.playbackUrl, ...(item.variants || []).map(variant => variant.url)]
              .filter(Boolean)
              .some(url => sameMedia(url, row.item?.url));
          })
      ),
      inbox:
        Number(options.inboxSince) > 0 &&
        Number(post.archivedAt || 0) >= Number(options.inboxSince) &&
        !meta.reviewedAt,
      note: !![meta.note, ...mediaNotes, ...annotationTexts].some(value => String(value || '').trim()),
      noteText: [String(meta.note || '').toLowerCase(), ...mediaNotes, ...annotationTexts].join(' '),
      mediaNoteText: mediaNotes.join(' '),
      annotationText: annotationTexts.join(' '),
      // Text recognised locally in images (xvault-derived/ocr), joined only for ocr:/has:ocr queries.
      ocrText: String(options.ocrText || '')
        .toLowerCase()
        .replace(/\s+/g, ' '),
      archivedAt: Number(post.archivedAt || 0),
      postedAt: new Date(post.createdAt || 0).getTime(),
      language: String(post.language || '').toLowerCase(),
      hashtags: Array.isArray(post.hashtags) ? post.hashtags.map(value => String(value).toLowerCase()) : [],
      mentions: Array.isArray(post.mentions) ? post.mentions.map(value => String(value).toLowerCase()) : [],
      domains: linkDomains(post.links),
      conversationId: String(post.conversationId || ''),
      quotedPostId: String(post.quotedPostId || ''),
      isReply: !!post.replyToId,
      isQuote: !!post.quotedPostId,
      isRepost: !!post.retweetedPostId || /^rt @/i.test(String(post.text || '')),
      isSelfThread:
        !!post.replyToId &&
        !!post.replyToHandle &&
        String(post.replyToHandle).toLowerCase() ===
          String(post.author?.handle || '')
            .replace(/^@/, '')
            .toLowerCase(),
      knownBytes: downloads
        .filter(row => row.state === 'complete')
        .reduce((total, row) => total + Math.max(0, Number(row.totalBytes) || 0), 0),
      randomOrder: options.randomOrder || 0,
    };
  }

  function linkDomains(links) {
    if (!Array.isArray(links) || !links.length) return [];
    const domains = [];
    for (const link of links) {
      const match = /^https?:\/\/([^/?#:]+)/i.exec(String(link || ''));
      if (match) domains.push(match[1].toLowerCase().replace(/^www\./, ''));
    }
    return domains;
  }

  // Non-indexed sorts with no filters need only the values used by the
  // comparator. Avoid lowercasing/copying post text, tags, notes and sources
  // for every record in a large archive scan.
  function projectRankPost(post, index = 0, options = {}) {
    const metrics = post?.metrics && typeof post.metrics === 'object' ? post.metrics : {};
    const media = Array.isArray(post?.media) ? post.media : [];
    return {
      index,
      id: String(post?.id || '').toLowerCase(),
      handle: String(post?.author?.handle || '')
        .replace(/^@/, '')
        .toLowerCase(),
      metrics,
      archivedAt: Number(post?.archivedAt || 0),
      mediaCount: media.length,
      randomOrder: Number(options.randomOrder) || 0,
    };
  }

  return Object.freeze({
    setCalendarTimeZone,
    tokenizeQuery,
    parseNum,
    compileQuery,
    queryIssues,
    usesRuleKind,
    projectPost,
    projectRankPost,
    matchesToken,
    matchesTokens,
    matchesQuery,
    matchesCompiledQuery,
    compareRows,
    searchRecords,
    linkDomains,
  });
});
