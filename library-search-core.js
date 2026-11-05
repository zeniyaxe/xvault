/* Small, serializable Library search rules shared by the dashboard worker and tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XVaultLibrarySearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const METRICS = new Set(['likes', 'views', 'bookmarks', 'reposts', 'replies', 'quotes']);

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
  const IS_VALUES = [
    'reply',
    'quote',
    'repost',
    'original',
    'thread',
    'favorite',
    'sensitive',
    'media',
    'text',
    'later',
    'read',
    'unread',
    'highlighted',
    // XVault 21
    'edited',
    'deleted',
    'unavailable',
    'available',
    'unchecked',
    'incomplete',
    'complete',
    'gap',
    'poll',
    'space',
    'labeled',
  ];
  const IS_ALIASES = { removed: 'deleted', missing: 'unavailable', broken: 'incomplete', 'has-gap': 'gap' };
  const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const COLOR_LABELS = ['red', 'amber', 'green', 'blue', 'violet'];

  // XVault 21 search options: user synonyms (ml = machine learning) and diacritic folding (cafe = café).
  let searchOptions = { synonyms: new Map(), fold: true };
  function setSearchOptions(options = {}) {
    const synonyms = new Map();
    const source = options.synonyms && typeof options.synonyms === 'object' ? options.synonyms : {};
    for (const [key, values] of Object.entries(source)) {
      const term = foldText(String(key).trim().toLowerCase());
      if (!term || term.includes(' ') || term.includes(':')) continue;
      const list = (Array.isArray(values) ? values : String(values).split(','))
        .map(value => foldText(String(value).trim().toLowerCase()))
        .filter(value => value && value !== term)
        .slice(0, 12);
      if (list.length) synonyms.set(term, [...new Set(list)]);
    }
    searchOptions = { synonyms, fold: options.fold !== false };
  }
  function getSearchOptions() {
    return { synonyms: Object.fromEntries(searchOptions.synonyms), fold: searchOptions.fold };
  }
  // Parses "ml = machine learning, ai = artificial intelligence | a.i." style text from Settings.
  function parseSynonyms(text) {
    const out = {};
    for (const line of String(text || '').split(/\n|;/)) {
      const [key, ...rest] = line.split('=');
      const term = String(key || '')
        .trim()
        .toLowerCase();
      const values = rest
        .join('=')
        .split(/[,|]/)
        .map(value => value.trim().toLowerCase())
        .filter(Boolean);
      if (term && !/[\s:]/.test(term) && values.length) out[term] = [...new Set([...(out[term] || []), ...values])];
    }
    return out;
  }
  const NON_ASCII = /[^\u0000-\u007f]/;
  function foldText(value) {
    const text = String(value || '');
    if (!NON_ASCII.test(text)) return text;
    return text
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/ß/g, 'ss')
      .replace(/[æ]/g, 'ae')
      .replace(/[œ]/g, 'oe')
      .replace(/[ø]/g, 'o')
      .replace(/[ł]/g, 'l')
      .replace(/[đ]/g, 'd');
  }

  // has:<flag> values added in XVault 21; each maps to a boolean on the projection's flags.
  const HAS_FLAGS = {
    poll: 'poll',
    card: 'card',
    space: 'space',
    'community-note': 'communityNote',
    cnote: 'communityNote',
    context: 'communityNote',
    alt: 'alt',
    'alt-text': 'alt',
    revisions: 'revisions',
    history: 'revisions',
    link: 'link',
    links: 'link',
    hashtag: 'hashtag',
    hashtags: 'hashtag',
    mention: 'mention',
    mentions: 'mention',
    gap: 'gap',
    'missing-parent': 'gap',
    'missing-quote': 'missingQuote',
    label: 'label',
    snapshot: 'snapshot',
    'link-snapshot': 'snapshot',
    'imported-media': 'importedMedia',
  };
  const HAS_HELP =
    'poll, card, space, community-note, alt, revisions, link, hashtag, mention, gap, missing-quote, label, snapshot';

  // Day filters follow the calendar setting (XVault 19): 'utc' (XVault 18 behaviour) or 'local'.
  let calendarZone = 'utc';
  function setCalendarTimeZone(zone) {
    calendarZone = zone === 'local' ? 'local' : 'utc';
  }
  function getCalendarTimeZone() {
    return calendarZone;
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
      const folded = searchOptions.fold ? foldText(plain) : plain;
      // term~ tolerates typos: one edit for short words, two from eight characters.
      if (folded.length >= 4 && folded.endsWith('~') && !folded.slice(0, -1).includes('~')) {
        const term = folded.slice(0, -1);
        if (term.length >= 3) return { kind: 'fuzzy', value: term, distance: term.length >= 8 ? 2 : 1 };
      }
      const synonyms = searchOptions.synonyms.get(folded);
      if (synonyms)
        return {
          kind: 'any',
          rules: [folded, ...synonyms].map(term => ({ kind: 'text', value: term, folded: searchOptions.fold })),
          synonymOf: folded,
        };
      return { kind: 'text', value: folded, folded: searchOptions.fold };
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
    // ---- XVault 21 filters ----
    if (key === 'asof' || key === 'as-of') {
      const stamp = dayStamp(value);
      if (!Number.isFinite(stamp)) return { kind: 'never', issue: `${key}: use a valid YYYY-MM-DD date` };
      return { kind: 'range', field: 'archivedAt', start: 1, end: nextDay(stamp), asOf: stamp };
    }
    if (key === 'quality' || key === 'completeness') {
      const match = /^(>=|<=|>|<|=)?(\d{1,3})%?$/.exec(value);
      if (!match) return { kind: 'never', issue: `${key}: use a score such as <60 or >=90` };
      return { kind: 'numeric', field: 'quality', operator: match[1] || '=', number: Number(match[2]) };
    }
    if (key === 'revisions' || key === 'edits' || key === 'words' || key === 'chars' || key === 'length') {
      const match = /^(>=|<=|>|<|=)?(\d{1,6})$/.exec(value);
      if (!match) return { kind: 'never', issue: `${key}: use a count such as >2` };
      const field = { revisions: 'revisionCount', edits: 'textRevisionCount', words: 'wordCount' }[key] || 'charCount';
      return { kind: 'numeric', field, operator: match[1] || '=', number: Number(match[2]) };
    }
    if (key === 'duration' || key === 'length-seconds') {
      const match = /^(>=|<=|>|<|=)?(\d{1,6})(s|m|h)?$/.exec(value);
      if (!match) return { kind: 'never', issue: `${key}: use seconds or minutes such as >60 or <2m` };
      const scale = { s: 1, m: 60, h: 3600 }[match[3] || 's'];
      return { kind: 'numeric', field: 'durationSeconds', operator: match[1] || '=', number: Number(match[2]) * scale };
    }
    if (key === 'res' || key === 'resolution') {
      const match = /^(>=|<=|>|<|=)?(\d{2,5})p?$/.exec(value) || (value === '4k' ? [0, '>=', '2160'] : null);
      if (!match) return { kind: 'never', issue: `${key}: use a height such as >=1080 or 4k` };
      return { kind: 'numeric', field: 'resolution', operator: match[1] || '>=', number: Number(match[2]) };
    }
    if (key === 'engagement' || key === 'er') {
      const match = /^(>=|<=|>|<|=)?(\d{1,3}(?:\.\d+)?)%?$/.exec(value);
      if (!match) return { kind: 'never', issue: `${key}: use a rate such as >5%` };
      return { kind: 'numeric', field: 'engagement', operator: match[1] || '>=', number: Number(match[2]) };
    }
    if (key === 'aspect' || key === 'orientation') {
      if (!['portrait', 'landscape', 'square', 'wide', 'tall'].includes(value))
        return { kind: 'never', issue: `${key}: use portrait, landscape, square, wide or tall` };
      return { kind: 'aspect', value };
    }
    if (key === 'weekday' || key === 'day') {
      const index = WEEKDAYS.findIndex(day => value.startsWith(day));
      if (index < 0 && value !== 'weekend' && value !== 'weekday')
        return { kind: 'never', issue: `${key}: use mon, tue, … sun, weekday or weekend` };
      return { kind: 'weekday', days: value === 'weekend' ? [0, 6] : value === 'weekday' ? [1, 2, 3, 4, 5] : [index] };
    }
    if (key === 'hour') {
      const match = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(value);
      if (!match || Number(match[1]) > 23 || Number(match[2] ?? 0) > 24)
        return { kind: 'never', issue: 'hour: use an hour such as 9 or a span such as 22-6' };
      return { kind: 'hour', from: Number(match[1]), to: match[2] == null ? Number(match[1]) + 1 : Number(match[2]) };
    }
    if (key === 'label' || key === 'color' || key === 'colour') {
      if (value === 'none' || value === 'any') return { kind: 'labelState', value: value === 'any' };
      if (!COLOR_LABELS.includes(value))
        return { kind: 'never', issue: `${key}: use ${COLOR_LABELS.join(', ')}, any or none` };
      return { kind: 'label', value };
    }
    if (key === 'availability' || key === 'status') {
      if (!['available', 'deleted', 'suspended', 'protected', 'withheld', 'unavailable', 'unchecked'].includes(value))
        return {
          kind: 'never',
          issue: `${key}: use available, deleted, suspended, protected, withheld, unavailable or unchecked`,
        };
      return { kind: 'availability', value };
    }
    if (key === 'cluster' || key === 'topic') return { kind: 'cluster', value: foldText(value) };
    if (key === 'alt' || key === 'alt-text') return { kind: 'contains', field: 'altText', value: foldText(value) };
    if (key === 'poll') return { kind: 'contains', field: 'pollText', value: foldText(value) };
    if (key === 'card') return { kind: 'contains', field: 'cardText', value: foldText(value) };
    if (key === 'cnote' || key === 'community-note' || key === 'context')
      return { kind: 'contains', field: 'communityNoteText', value: foldText(value) };
    if (key === 'link' || key === 'url') return { kind: 'contains', field: 'linkText', value };
    if (key === 'name' || key === 'display-name')
      return { kind: 'contains', field: 'authorName', value: foldText(value) };
    if (key === 'lang' || key === 'language') return { kind: 'language', value };
    if (key === 'is') {
      const aliased = IS_ALIASES[value] || value;
      const wanted =
        aliased === 'retweet' || aliased === 'rt' ? 'repost' : aliased === 'self-thread' ? 'thread' : aliased;
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
    if (key === 'quotes' && /^[<>=]/.test(value)) {
      const operator = value.startsWith('>=') ? '>=' : value.startsWith('<=') ? '<=' : value[0];
      return { kind: 'metric', key, operator, number: parseNum(value.replace(/^[<>]=?|^=/, '') || 0) };
    }
    if (key === 'quote-count') {
      const operator = value.startsWith('>=')
        ? '>='
        : value.startsWith('<=')
          ? '<='
          : /^[<>=]/.test(value)
            ? value[0]
            : '=';
      return { kind: 'metric', key: 'quotes', operator, number: parseNum(value.replace(/^[<>]=?|^=/, '') || 0) };
    }
    if (key === 'quotes' || key === 'quoting') {
      if (!/^\d{1,32}$/.test(value)) return { kind: 'never', issue: `${key}: use a post ID, or a count such as >10` };
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
      if (key === 'has' && (value === 'highlight' || value === 'highlights'))
        return { kind: 'is', value: 'highlighted' };
      if (key === 'has' && (value === 'board' || value === 'boards')) return { kind: 'boardAny' };
      if (key === 'has' && HAS_FLAGS[value]) return { kind: 'flag', value: HAS_FLAGS[value] };
      return {
        kind: 'never',
        issue: `${key}: use video, gif, image, media${key === 'has' ? `, note, tag, download, ocr, highlight, board, ${HAS_HELP}` : ''}`,
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
    if (key === 'highlight' || key === 'highlights') return { kind: 'highlightText', value };
    if (key === 'board') return { kind: 'board', value };
    if (key === 'later' || key === 'read-later')
      return value === 'true' || value === 'false'
        ? { kind: 'is', value: value === 'true' ? 'later' : 'not-later' }
        : { kind: 'never', issue: `${key}: use true or false` };
    // Meaning search (XVault 20): the worker scores posts with the local semantic index and passes the
    // score in as options.semanticScores; posts without a score did not match.
    if (key === 'about' || key === 'meaning' || key === 'like') return { kind: 'semantic', value };
    if (key === 'similar' || key === 'related') return { kind: 'semantic', value, similarTo: value };
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

  // Meaning rules are scored by the worker; each rule gets its own key so AND/OR/NOT stay exact.
  function semanticKey(rule) {
    return `${rule.similarTo ? 'similar' : 'about'}:${rule.value}`;
  }
  function semanticRules(compiled) {
    const found = [];
    const visit = rule => {
      if (rule.kind === 'semantic') found.push(rule);
      else if (rule.kind === 'any') rule.rules.forEach(visit);
    };
    (compiled || []).forEach(visit);
    return found;
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
    if (value === 'later') return !!row.later;
    if (value === 'not-later') return !row.later;
    if (value === 'read') return !!row.readAt;
    if (value === 'unread') return !row.readAt;
    if (value === 'highlighted') return row.highlightCount > 0;
    if (value === 'edited') return !!row.edited;
    if (value === 'deleted') return row.availability === 'deleted';
    if (value === 'unavailable') return !!row.availability && row.availability !== 'available';
    if (value === 'available') return row.availability === 'available';
    if (value === 'unchecked') return !row.availability;
    if (value === 'incomplete') return Number(row.quality) < INCOMPLETE_BELOW;
    if (value === 'complete') return Number(row.quality) >= INCOMPLETE_BELOW;
    if (value === 'gap') return !!row.flags?.gap;
    if (value === 'poll') return !!row.flags?.poll;
    if (value === 'space') return !!row.flags?.space;
    if (value === 'labeled') return !!row.colorLabel;
    return false;
  }
  const INCOMPLETE_BELOW = 70;
  const WORD_SPLIT = /[^\p{L}\p{N}_]+/u;
  function rowWords(row) {
    if (!row.__words) {
      const words = new Set(String(row.foldedText ?? row.text ?? '').split(WORD_SPLIT));
      words.delete('');
      Object.defineProperty(row, '__words', { value: [...words], enumerable: false });
    }
    return row.__words;
  }
  /** Bounded Damerau–Levenshtein distance; returns limit + 1 once the bound is exceeded. */
  function editDistance(a, b, limit = 2) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    let previous2 = null,
      previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
      const current = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
        if (previous2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
          value = Math.min(value, previous2[j - 2] + 1);
        current[j] = value;
        if (value < best) best = value;
      }
      if (best > limit) return limit + 1;
      previous2 = previous;
      previous = current;
    }
    return previous[b.length];
  }
  function fuzzyContains(row, term, distance) {
    if (String(row.foldedText ?? row.text ?? '').includes(term) || String(row.handle || '').includes(term)) return true;
    for (const word of rowWords(row)) {
      if (Math.abs(word.length - term.length) > distance) continue;
      if (editDistance(word, term, distance) <= distance) return true;
    }
    return false;
  }
  /** Keyword relevance in [0, 1]: saturating term frequency, phrase and handle boosts, field coverage. */
  function keywordScore(row, compiled) {
    const terms = [];
    const visit = rule => {
      if (rule.negate) return;
      if (rule.kind === 'text') terms.push(rule.value);
      else if (rule.kind === 'fuzzy') {
        const near = String(row.foldedText ?? row.text ?? '').includes(rule.value)
          ? rule.value
          : rowWords(row).find(
              word =>
                Math.abs(word.length - rule.value.length) <= rule.distance &&
                editDistance(word, rule.value, rule.distance) <= rule.distance
            );
        terms.push(near || rule.value);
      } else if (rule.kind === 'any') rule.rules.forEach(visit);
      else if (rule.kind === 'hashtag') terms.push(`#${rule.value}`);
    };
    compiled.forEach(visit);
    if (!terms.length) return 0;
    const text = String(row.foldedText ?? row.text ?? ''),
      length = Math.max(1, text.length);
    let total = 0;
    for (const term of terms) {
      let count = 0,
        at = text.indexOf(term);
      while (at >= 0 && count < 8) {
        count++;
        at = text.indexOf(term, at + term.length);
      }
      let score = count ? count / (count + 1.2) : 0;
      if (
        count &&
        new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(
          text
        )
      )
        score += 0.25;
      if (String(row.handle || '').includes(term)) score += 0.35;
      if (String(row.authorName || '').includes(term)) score += 0.15;
      if ((row.tags || []).includes(term)) score += 0.3;
      total += Math.min(1, score);
    }
    // Shorter posts that contain every term are more focused matches.
    const focus = 1 / (1 + Math.log10(1 + length / 280));
    return Math.min(1, (total / terms.length) * (0.75 + 0.25 * focus));
  }
  /** Hybrid relevance: keyword score blended with the meaning score (weight = share of meaning). */
  function relevanceScore(row, compiled, weight = 0.35) {
    const keyword = keywordScore(row, compiled),
      meaning = Number(row.semanticScore) || 0,
      hasMeaning = semanticRules(compiled).length > 0,
      hasKeyword = compiled.some(rule => !rule.negate && ['text', 'fuzzy', 'any', 'hashtag'].includes(rule.kind));
    if (hasMeaning && hasKeyword) {
      const share = Math.min(1, Math.max(0, Number(weight)));
      return (1 - share) * keyword + share * meaning;
    }
    return hasMeaning ? meaning : keyword;
  }
  /** Which joins a compiled query (and sort) needs from the worker. */
  function queryNeeds(compiled, sort = '') {
    let archivedIds = false,
      snapshotIds = false;
    const visit = rule => {
      if (rule.kind === 'any') return rule.rules.forEach(visit);
      if (rule.kind === 'flag' && (rule.value === 'gap' || rule.value === 'missingQuote')) archivedIds = true;
      if (rule.kind === 'is' && rule.value === 'gap') archivedIds = true;
      if (rule.kind === 'flag' && rule.value === 'snapshot') snapshotIds = true;
      if (rule.kind === 'cluster') clusterIds = true;
    };
    let clusterIds = false;
    compiled.forEach(visit);
    return { archivedIds, snapshotIds, clusterIds, sortValue: !!SORT_VALUES[sort] };
  }
  function hourIn(hour, from, to) {
    return from < to ? hour >= from && hour < to : hour >= from || hour < to;
  }
  function localParts(stamp) {
    const date = new Date(stamp);
    return calendarZone === 'local'
      ? { day: date.getDay(), hour: date.getHours() }
      : { day: date.getUTCDay(), hour: date.getUTCHours() };
  }

  function matchRule(row, rule) {
    if (rule.kind === 'range') {
      const value = Number(row[rule.field]);
      return Number.isFinite(value) && value > 0 && value >= rule.start && value < rule.end;
    }
    if (rule.kind === 'language') return String(row.language || '') === rule.value;
    if (rule.kind === 'is') return matchIs(row, rule.value);
    if (rule.kind === 'highlightText') return String(row.highlightText || '').includes(rule.value);
    if (rule.kind === 'numeric') return compareNumber(Number(row[rule.field]) || 0, rule.operator, rule.number);
    if (rule.kind === 'flag') return !!row.flags?.[rule.value];
    if (rule.kind === 'contains') return String(row[rule.field] || '').includes(rule.value);
    if (rule.kind === 'cluster')
      return !!row.clusterKey && (row.clusterKey.split('|')[0] === rule.value || row.clusterKey.includes(rule.value));
    if (rule.kind === 'label') return row.colorLabel === rule.value;
    if (rule.kind === 'labelState') return !!row.colorLabel === rule.value;
    if (rule.kind === 'availability')
      return rule.value === 'unchecked' ? !row.availability : row.availability === rule.value;
    if (rule.kind === 'aspect') return (row.aspects || []).includes(rule.value);
    if (rule.kind === 'weekday' || rule.kind === 'hour') {
      if (!(row.postedAt > 0)) return false;
      const parts = localParts(row.postedAt);
      return rule.kind === 'weekday' ? rule.days.includes(parts.day) : hourIn(parts.hour, rule.from, rule.to);
    }
    if (rule.kind === 'boardAny') return (row.boards || []).length > 0;
    if (rule.kind === 'board')
      return (row.boards || []).includes(rule.value) || (row.boardNames || []).includes(rule.value);
    if (rule.kind === 'semantic') return Number.isFinite(row.semanticScores?.[semanticKey(rule)]);
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
    if (rule.kind === 'fuzzy') return fuzzyContains(row, rule.value, rule.distance);
    if (rule.kind === 'text')
      return (
        (rule.folded ? (row.foldedText ?? row.text) : row.text).includes(rule.value) || row.handle.includes(rule.value)
      );
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
    else if (sort === 'relevance')
      result =
        Number(b.relevance ?? b.semanticScore ?? 0) - Number(a.relevance ?? a.semanticScore ?? 0) ||
        sortableArchiveTime(b.archivedAt, false) - sortableArchiveTime(a.archivedAt, false);
    else if (SORT_VALUES[sort])
      result =
        (SORT_VALUES[sort].order === 'asc'
          ? Number(a.sortValue || 0) - Number(b.sortValue || 0)
          : Number(b.sortValue || 0) - Number(a.sortValue || 0)) ||
        sortableArchiveTime(b.archivedAt, false) - sortableArchiveTime(a.archivedAt, false);
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

  // Capture quality (XVault 21): how complete an archived record is, 0–100, with what is missing.
  // Used by quality:, is:incomplete, the Quality sort and "Repair incomplete posts".
  function postQuality(post) {
    const missing = [];
    let score = 0;
    const author = post?.author || {};
    if (author.handle) score += 8;
    else missing.push('author');
    if (author.name) score += 4;
    else missing.push('author name');
    if (author.avatar) score += 3;
    else missing.push('avatar');
    if (post?.createdAt && Number.isFinite(new Date(post.createdAt).getTime())) score += 12;
    else missing.push('post date');
    const media = Array.isArray(post?.media) ? post.media : [];
    if (String(post?.text || '').trim() || media.length) score += 15;
    else missing.push('text');
    const metrics = post?.metrics || {};
    const known = ['likes', 'reposts', 'replies'].filter(key => metrics[key] != null && metrics[key] !== '').length;
    score += known * 5;
    if (known < 3) missing.push('metrics');
    if (!media.length) score += 20;
    else {
      const playable = media.every(
        item =>
          (item.type !== 'video' && item.type !== 'animated_gif') ||
          !!item.playbackUrl ||
          (Array.isArray(item.variants) && item.variants.some(variant => variant?.url))
      );
      const sized = media.every(item => Number(item?.width) > 0 && Number(item?.height) > 0);
      const located = media.every(item => item?.url);
      score += (located ? 8 : 0) + (playable ? 8 : 0) + (sized ? 4 : 0);
      if (!located) missing.push('media URL');
      if (!playable) missing.push('video file');
      if (!sized) missing.push('media size');
    }
    const graph = (post?.sourceFlags || []).some(flag => String(flag) !== 'dom');
    if (graph || post?.conversationId) score += 10;
    else missing.push('thread info');
    const shortLinks = /https:\/\/t\.co\//.test(String(post?.text || ''));
    if (!shortLinks || (Array.isArray(post?.links) && post.links.length) || media.length) score += 8;
    else missing.push('expanded links');
    if (post?.language) score += 5;
    else missing.push('language');
    return { score: Math.min(100, score), missing };
  }

  function mediaShape(media) {
    let resolution = 0,
      durationMs = 0;
    const aspects = new Set();
    for (const item of media) {
      const width = Number(item?.width) || 0,
        height = Number(item?.height) || 0;
      if (width && height) {
        resolution = Math.max(resolution, Math.min(width, height));
        const ratio = width / height;
        aspects.add(ratio > 1.05 ? 'landscape' : ratio < 0.95 ? 'portrait' : 'square');
        if (ratio >= 1.7) aspects.add('wide');
        if (ratio <= 0.6) aspects.add('tall');
      }
      durationMs = Math.max(durationMs, Number(item?.durationMs) || 0);
    }
    return { resolution, durationMs, aspects: [...aspects] };
  }

  function engagementRate(metrics) {
    const views = Number(metrics?.views) || 0;
    if (views <= 0) return 0;
    const total = ['likes', 'reposts', 'replies', 'quotes', 'bookmarks'].reduce(
      (sum, key) => sum + (Number(metrics?.[key]) || 0),
      0
    );
    return Math.round((total / views) * 10000) / 100;
  }

  // Sorts added in XVault 21 compare one precomputed number (rank rows stay small).
  const SORT_VALUES = {
    posted: { value: post => Date.parse(post?.createdAt || '') || 0, order: 'desc' },
    'posted-old': { value: post => Date.parse(post?.createdAt || '') || Number.MAX_SAFE_INTEGER, order: 'asc' },
    engagement: { value: post => engagementRate(post?.metrics), order: 'desc' },
    longest: { value: post => String(post?.text || '').length, order: 'desc' },
    shortest: { value: post => String(post?.text || '').length || Number.MAX_SAFE_INTEGER, order: 'asc' },
    quality: { value: post => postQuality(post).score, order: 'desc' },
    'quality-low': { value: post => postQuality(post).score, order: 'asc' },
    edited: {
      value: post => (Number(post?.textRevisionCount) || 0) * 1e13 + (Number(post?.lastRevisionAt) || 0),
      order: 'desc',
    },
    'read-recent': { value: post => Number(post?.userMeta?.readAt) || 0, order: 'desc' },
    highlights: {
      value: post => (Array.isArray(post?.userMeta?.highlights) ? post.userMeta.highlights.length : 0),
      order: 'desc',
    },
    duration: { value: post => mediaShape(post?.media || []).durationMs, order: 'desc' },
    resolution: { value: post => mediaShape(post?.media || []).resolution, order: 'desc' },
    seen: { value: post => Number(post?.lastObservationAt || post?.lastSeenAt) || 0, order: 'desc' },
    'checked-old': {
      value: post => Number(post?.availability?.checkedAt) || 0,
      order: 'asc',
    },
    thread: { value: post => Number(String(post?.conversationId || post?.id || '0').slice(-15)) || 0, order: 'asc' },
  };
  const SORT_KEYS = ['new', 'old', ...METRICS, 'media', 'author', 'random', 'relevance', ...Object.keys(SORT_VALUES)];
  function sortValueFor(post, sort) {
    const entry = SORT_VALUES[sort];
    return entry ? entry.value(post) : 0;
  }

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
      later: !!meta.readLater,
      readAt: Number(meta.readAt) || 0,
      highlightCount: Array.isArray(meta.highlights) ? meta.highlights.length : 0,
      highlightText: Array.isArray(meta.highlights)
        ? meta.highlights
            .map(entry => `${entry?.text || ''} ${entry?.note || ''}`)
            .join(' ')
            .toLowerCase()
        : '',
      boards: Array.isArray(meta.boards) ? meta.boards.map(String) : [],
      boardNames: Array.isArray(meta.boards)
        ? meta.boards.map(id => String(options.boardNames?.[id] || '').toLowerCase()).filter(Boolean)
        : [],
      semanticScores: options.semanticScores || null,
      semanticScore: options.semanticScores
        ? Math.max(0, ...Object.values(options.semanticScores).filter(Number.isFinite))
        : 0,
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
      ...projectExtras(post, options),
    };
  }

  // XVault 21 projection: change tracking, availability, quality, structured extras and media shape.
  function projectExtras(post, options = {}) {
    const media = Array.isArray(post.media) ? post.media : [],
      meta = post.userMeta || {},
      text = String(post.text || '').toLowerCase(),
      shape = mediaShape(media),
      quality = postQuality(post);
    const alt = media
      .map(item => String(item?.altText || ''))
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const poll = post.poll && Array.isArray(post.poll.choices) ? post.poll : null;
    const card = post.card && typeof post.card === 'object' ? post.card : null;
    const note = post.communityNote && typeof post.communityNote === 'object' ? post.communityNote : null;
    const links = Array.isArray(post.links) ? post.links.map(String) : [];
    const archived = options.archivedIds instanceof Set ? options.archivedIds : null;
    const availability = post.availability?.state || (post.deletedAt ? 'deleted' : '');
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    return {
      foldedText: searchOptions.fold ? foldText(text) : text,
      quality: quality.score,
      qualityMissing: quality.missing,
      edited: Number(post.textRevisionCount) > 0 || !!post.edit?.edited,
      revisionCount: Number(post.revisionCount) || 0,
      textRevisionCount: Number(post.textRevisionCount) || 0,
      availability,
      colorLabel: String(meta.colorLabel || '').toLowerCase(),
      altText: foldText(alt),
      pollText: poll
        ? foldText(
            poll.choices
              .map(choice => String(choice.label || ''))
              .join(' ')
              .toLowerCase()
          )
        : '',
      cardText: card
        ? foldText([card.title, card.description, card.domain, card.url].filter(Boolean).join(' ').toLowerCase())
        : '',
      communityNoteText: note ? foldText(String(note.text || '').toLowerCase()) : '',
      linkText: links.join(' ').toLowerCase(),
      authorName: foldText(String(post.author?.name || '').toLowerCase()),
      wordCount: words,
      charCount: text.length,
      durationSeconds: Math.round(shape.durationMs / 1000),
      resolution: shape.resolution,
      aspects: shape.aspects,
      engagement: engagementRate(post.metrics),
      flags: {
        poll: !!poll,
        card: !!card,
        space: !!post.space,
        communityNote: !!note,
        alt: !!alt,
        revisions: (Number(post.revisionCount) || 0) > 0,
        link: links.length > 0,
        hashtag: Array.isArray(post.hashtags) && post.hashtags.length > 0,
        mention: Array.isArray(post.mentions) && post.mentions.length > 0,
        gap: !!(archived && post.replyToId && !archived.has(String(post.replyToId))),
        missingQuote: !!(archived && post.quotedPostId && !archived.has(String(post.quotedPostId))),
        label: !!meta.colorLabel,
        snapshot: !!(options.snapshotIds instanceof Set && options.snapshotIds.has(String(post.id))),
        importedMedia: Array.isArray(post.importedMedia) && post.importedMedia.length > 0,
      },
      clusterKey: options.clusterIds instanceof Map ? options.clusterIds.get(String(post.id)) || '' : '',
      sortValue: options.sort ? sortValueFor(post, options.sort) : 0,
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
      // Derived sort keys (quality, duration, …) are only computed when that sort is active.
      ...(options.sort ? { sortValue: sortValueFor(post, options.sort) } : {}),
    };
  }

  return Object.freeze({
    editDistance,
    keywordScore,
    relevanceScore,
    queryNeeds,
    setSearchOptions,
    getSearchOptions,
    parseSynonyms,
    foldText,
    postQuality,
    engagementRate,
    sortValueFor,
    SORT_KEYS,
    INCOMPLETE_BELOW,
    setCalendarTimeZone,
    getCalendarTimeZone,
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
    semanticKey,
    semanticRules,
    searchRecords,
    linkDomains,
  });
});
