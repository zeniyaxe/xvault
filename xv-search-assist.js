/* XVault search suggestions — a combobox for the Library search box. It completes filter keys and
   their values (people, tags, languages, sites, dates) from the local Atlas insights, ranks them by how
   often and how recently you used them (XVault 19, stored only in this browser), shows help for the
   filter being typed and remembers recent searches. Keys are only intercepted while the list is open,
   except Ctrl+Space, which opens it. */
(() => {
  const RECENT_KEY = 'xv-recent-searches',
    USAGE_KEY = 'xv-search-usage',
    LIMIT = 8;
  const Ranking = window.XVaultSearchRanking;
  // [key, short description, example]
  const KEYS = [
    ['from:', 'posts by a person', 'from:alice'],
    ['tag:', 'one of your tags', 'tag:recipes|travel'],
    ['has:', 'video, gif, image, media, note, tag, download or ocr', 'has:video'],
    ['is:', 'reply, quote, repost, thread, original…', 'is:thread'],
    ['ocr:', 'text recognised in images (Settings → Library → OCR)', 'ocr:receipt'],
    ['image-text:', 'same as ocr:', 'image-text:"menu"'],
    ['lang:', 'language', 'lang:ja'],
    ['domain:', 'linked website', 'domain:github.com'],
    ['source:', 'where it was archived from', 'source:likes'],
    ['on:', 'posted on a day', 'on:2026-03-14'],
    ['archived-on:', 'archived on a day', 'archived-on:2026-03-14'],
    ['after:', 'posted on or after a day', 'after:2026-01-01'],
    ['before:', 'posted before a day', 'before:2026-01-01'],
    ['archived-after:', 'archived on or after a day', 'archived-after:2026-01-01'],
    ['archived-before:', 'archived before a day', 'archived-before:2026-01-01'],
    ['within:', 'posted recently', 'within:7d'],
    ['archived-within:', 'archived recently', 'archived-within:30d'],
    ['year:', 'posted in a year', 'year:2025'],
    ['archived-year:', 'archived in a year', 'archived-year:2026'],
    ['fav:', 'favorites', 'fav:true'],
    ['inbox:', 'not reviewed yet', 'inbox:true'],
    ['untagged:', 'posts without tags', 'untagged:true'],
    ['note:', 'has a note, or note text', 'note:"to read"'],
    ['downloaded:', 'files on disk', 'downloaded:false'],
    ['missing:', 'files not downloaded yet', 'missing:true'],
    ['likes:', 'likes, e.g. >500', 'likes:>500'],
    ['views:', 'views, e.g. >10k', 'views:>10k'],
    ['reposts:', 'reposts, e.g. >100', 'reposts:>100'],
    ['media:', 'number of media files', 'media:>1'],
    ['size:', 'download size', 'size:>100mb'],
    ['rating:', 'sensitive posts', 'rating:sensitive'],
    ['mention:', 'mentions a person', 'mention:bob'],
    ['hashtag:', 'uses a hashtag', 'hashtag:art'],
    ['thread:', 'a conversation by post ID', 'thread:1234567890'],
    ['quotes:', 'posts quoting a post ID', 'quotes:1234567890'],
    ['id:', 'a post ID', 'id:1234567890'],
  ];
  const KEY_INFO = new Map(KEYS.map(([key, hint, example]) => [key.slice(0, -1), { hint, example }]));
  const BOOL = ['true', 'false'];
  const STATIC = {
    has: [
      ['video', 'videos'],
      ['gif', 'GIFs'],
      ['image', 'images'],
      ['media', 'any media'],
      ['note', 'posts with notes'],
      ['tag', 'tagged posts'],
      ['download', 'downloaded files'],
      ['ocr', 'images with recognised text'],
    ],
    type: [
      ['video', 'videos'],
      ['gif', 'GIFs'],
      ['image', 'images'],
      ['media', 'any media'],
    ],
    is: [
      ['reply', 'replies'],
      ['quote', 'quote posts'],
      ['repost', 'reposts'],
      ['thread', 'self-threads'],
      ['original', 'not a reply or repost'],
      ['favorite', 'your favorites'],
      ['sensitive', 'marked sensitive'],
      ['media', 'with media'],
      ['text', 'text only'],
    ],
    fav: BOOL,
    favorite: BOOL,
    inbox: BOOL,
    untagged: BOOL,
    downloaded: BOOL,
    missing: BOOL,
    note: BOOL,
    rating: [['sensitive', 'marked sensitive']],
    within: [
      ['24h', 'last day'],
      ['7d', 'last week'],
      ['30d', 'last month'],
      ['1y', 'last year'],
    ],
    media: [
      ['>1', 'more than one file'],
      ['>3', 'more than three files'],
      ['1', 'exactly one file'],
    ],
    likes: ['>100', '>1k', '>10k'],
    views: ['>1k', '>10k', '>100k'],
    reposts: ['>10', '>100', '>1k'],
    size: ['>10mb', '>100mb', '>1gb'],
  };
  STATIC['archived-within'] = STATIC.within;
  const DATE_KEYS = new Set(['on', 'archived-on', 'after', 'before', 'archived-after', 'archived-before']);
  const ALIASES = {
    artist: 'from',
    author: 'from',
    site: 'domain',
    language: 'lang',
    mentions: 'mention',
    'image-text': 'ocr',
  };

  let input = null,
    popup = null,
    items = [],
    active = -1,
    token = null,
    data = null,
    dataAt = 0,
    frame = 0;

  const read = () => {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(list) ? list.filter(value => typeof value === 'string') : [];
    } catch {
      return [];
    }
  };
  let usageCache = null,
    lastRemembered = '';
  function usage() {
    if (usageCache) return usageCache;
    try {
      const value = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
      usageCache = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      usageCache = {};
    }
    return usageCache;
  }
  function remember(query) {
    const value = String(query || '').trim();
    if (value.length < 2) return;
    const list = [value, ...read().filter(entry => entry !== value)].slice(0, 10);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {}
    // Count each distinct search once per session-burst, so blur + Enter don't double count.
    if (value === lastRemembered || !Ranking) return;
    lastRemembered = value;
    usageCache = Ranking.recordUsage(usage(), value);
    try {
      localStorage.setItem(USAGE_KEY, JSON.stringify(usageCache));
    } catch {}
  }
  const zone = () => window.XVaultLibrarySearch?.getCalendarTimeZone?.() || 'utc';

  async function insights() {
    if (data && Date.now() - dataAt < 120000) return data;
    dataAt = Date.now();
    try {
      data = (await window.XVaultInsights?.()) || data;
    } catch {}
    return data;
  }

  const pad = value => String(value).padStart(2, '0');
  // Day suggestions follow the Calendar setting so "today" matches what on:/after: will filter.
  function dayIn(offset, local) {
    const date = new Date(Date.now() - offset * 86400000);
    return local
      ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      : date.toISOString().slice(0, 10);
  }
  function dateValues() {
    const local = zone() === 'local',
      now = new Date(),
      year = local ? now.getFullYear() : now.getUTCFullYear(),
      month = (local ? now.getMonth() : now.getUTCMonth()) + 1;
    return [
      [dayIn(0, local), local ? 'today' : 'today (UTC)'],
      [dayIn(1, local), 'yesterday'],
      [dayIn(7, local), 'a week ago'],
      [`${year}-${pad(month)}-01`, 'start of this month'],
      [`${year}-01-01`, 'start of this year'],
    ];
  }
  function yearValues(field) {
    const years = new Set(Object.keys(data?.days?.[field] || {}).map(key => key.slice(0, 4)));
    return [...years].sort().reverse().slice(0, 12);
  }
  const counted = entry => [entry.key, `${fmt(entry.count)} posts`];

  function valuesFor(key, partial, limit = LIMIT) {
    const name = ALIASES[key] || key;
    let pool;
    if (name === 'from')
      pool = (data?.authors || []).map(author => [
        author.raw || author.handle,
        `${author.name ? `${author.name} · ` : ''}${fmt(author.count)} posts`,
        `${author.handle} ${String(author.name || '').toLowerCase()}`,
      ]);
    else if (name === 'tag') pool = (data?.tags || []).map(counted);
    else if (name === 'lang')
      pool = (data?.languages || []).map(entry => [entry.key, `${languageName(entry.key)} · ${fmt(entry.count)}`]);
    else if (name === 'domain') pool = (data?.domains || []).map(counted);
    else if (name === 'source') pool = (data?.sources || []).map(counted);
    else if (name === 'mention') pool = (data?.mentions || []).map(counted);
    else if (name === 'hashtag') pool = (data?.hashtags || []).map(counted);
    else if (DATE_KEYS.has(name)) pool = dateValues();
    else if (name === 'year') pool = yearValues('posted').map(year => [year, 'posted that year']);
    else if (name === 'archived-year') pool = yearValues('archived').map(year => [year, 'archived that year']);
    else pool = (STATIC[name] || []).map(entry => (Array.isArray(entry) ? entry : [entry, '']));
    const entries = pool.map(([value, hint, haystack]) => ({
      value: String(value),
      hint,
      haystack,
      usageKey: `${name}:${String(value).toLowerCase()}`,
    }));
    if (Ranking) return Ranking.rank(entries, { needle: partial, usage: usage(), limit });
    const needle = partial.toLowerCase();
    return entries
      .map(entry => {
        const lower = entry.value.toLowerCase(),
          extra = entry.haystack || lower;
        return { ...entry, score: !needle ? 1 : lower.startsWith(needle) ? 3 : extra.includes(needle) ? 2 : 0 };
      })
      .filter(entry => entry.score)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  function keyEntries(lower, negate, limit) {
    const pool = KEYS.filter(([key]) => key !== lower).map(([key, hint]) => ({
      value: key,
      hint,
      haystack: `${key} ${hint}`,
      usageKey: key,
    }));
    const ranked = Ranking
      ? Ranking.rank(pool, { needle: lower, usage: usage(), limit: limit * 2 }).filter(
          entry => entry.value.startsWith(lower) || lower.length >= 3
        )
      : pool.filter(entry => entry.value.startsWith(lower));
    return ranked.slice(0, limit).map(entry => ({
      insert: negate + entry.value,
      label: negate + entry.value,
      hint: entry.hint,
      open: true,
      group: 'Filters',
    }));
  }

  const languageName = (() => {
    let names = null;
    try {
      names = new Intl.DisplayNames(undefined, { type: 'language' });
    } catch {}
    return code => {
      try {
        return names?.of(code) || code;
      } catch {
        return code;
      }
    };
  })();

  function tokenAt(value, caret) {
    let start = caret,
      end = caret;
    while (start > 0 && !/\s/.test(value[start - 1])) start--;
    while (end < value.length && !/\s/.test(value[end])) end++;
    return { start, end, text: value.slice(start, caret) };
  }

  let help = null;

  function compute({ force = false } = {}) {
    const value = input.value,
      caret = input.selectionStart ?? value.length;
    token = tokenAt(value, caret);
    help = null;
    const text = token.text;
    if (!text) return force || !value.trim() ? startItems() : [];
    if (text.includes('"')) return [];
    const negate = text.startsWith('-') ? '-' : '',
      body = negate ? text.slice(1) : text;
    const colon = body.indexOf(':');
    if (colon < 0) {
      if (body.startsWith('#'))
        return valuesFor('hashtag', body.slice(1)).map(entry => ({
          insert: `${negate}#${entry.value}`,
          label: `#${entry.value}`,
          hint: entry.hint,
          group: 'Hashtags',
        }));
      if (body.startsWith('@'))
        return valuesFor('from', body.slice(1)).map(entry => ({
          insert: `${negate}from:${entry.value}`,
          label: `from:${entry.value}`,
          hint: entry.hint,
          group: 'People',
        }));
      const lower = body.toLowerCase();
      const keys = keyEntries(lower, negate, 5);
      const people =
        lower.length >= 2
          ? valuesFor('from', lower, 3).map(entry => ({
              insert: `${negate}from:${entry.value}`,
              label: `from:${entry.value}`,
              hint: entry.hint,
              group: 'People',
            }))
          : [];
      return [...keys, ...people];
    }
    const rawKey = body.slice(0, colon),
      key = rawKey.toLowerCase(),
      rest = body.slice(colon + 1),
      pipe = rest.lastIndexOf('|');
    const info = KEY_INFO.get(key) || KEY_INFO.get(ALIASES[key] || '');
    if (info) help = { key: `${negate}${rawKey}:`, ...info, negate: !!negate };
    const head = pipe >= 0 ? rest.slice(0, pipe + 1) : '',
      tail = rest.slice(pipe + 1);
    return valuesFor(key, tail)
      .filter(entry => entry.value.toLowerCase() !== tail.toLowerCase() || pipe >= 0)
      .map(entry => ({
        insert: `${negate}${rawKey}:${head}${entry.value}`,
        label: `${negate}${rawKey}:${head}${entry.value}`,
        hint: entry.hint,
        group: 'Values',
      }));
  }

  function recentItems() {
    return read()
      .slice(0, LIMIT)
      .map(query => ({ insert: query, label: query, hint: '', recent: true, group: 'Recent searches' }));
  }

  // Empty box: recent searches first, then the filters you reach for most.
  function startItems() {
    const recent = recentItems().slice(0, 5);
    const map = usage(),
      now = Date.now();
    const favourites = Object.keys(map)
      .filter(key => /^[a-z-]+:./.test(key) || key.startsWith('#'))
      .map(key => ({ key, weight: Ranking ? Ranking.weight(map[key], now) : map[key]?.count || 0 }))
      .filter(entry => entry.weight > 0.2)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 4)
      .map(({ key }) => {
        const info = KEY_INFO.get(key.slice(0, key.indexOf(':')));
        return { insert: key, label: key, hint: info?.hint || '', group: 'Frequently used' };
      });
    const known = new Set(favourites.map(item => item.key));
    const tips =
      recent.length + favourites.length
        ? []
        : ['from:', 'has:', 'tag:', 'within:', 'ocr:']
            .filter(key => !known.has(key))
            .map(key => {
              const info = KEY_INFO.get(key.slice(0, -1));
              return { insert: key, label: key, hint: info.hint, open: true, group: 'Try a filter' };
            });
    return [...recent, ...favourites, ...tips];
  }

  function ensurePopup() {
    if (popup) return popup;
    popup = document.createElement('div');
    popup.id = 'xvSearchAssist';
    popup.className = 'xv-assist';
    popup.setAttribute('role', 'listbox');
    popup.setAttribute('aria-label', 'Search suggestions');
    popup.hidden = true;
    popup.addEventListener('pointerdown', event => {
      const option = event.target.closest('[data-index]');
      event.preventDefault();
      if (option) accept(items[Number(option.dataset.index)]);
    });
    document.body.append(popup);
    return popup;
  }

  function place() {
    const anchor = input.closest('.searchWrap') || input,
      box = anchor.getBoundingClientRect();
    popup.style.left = `${Math.round(box.left)}px`;
    popup.style.top = `${Math.round(box.bottom + 4)}px`;
    popup.style.width = `${Math.round(Math.max(280, box.width))}px`;
  }

  function show(list) {
    items = list;
    active = -1;
    if (!list.length && !help) return hide();
    ensurePopup();
    let group = null;
    const rows = list
      .map((item, index) => {
        const heading =
          item.group && item.group !== group
            ? `<div class="xv-assist-head" role="presentation">${esc(item.group)}</div>`
            : '';
        group = item.group;
        return `${heading}<div class="xv-assist-item${item.recent ? ' is-recent' : ''}" role="option" id="xvAssist-${index}" data-index="${index}" aria-selected="false"><b>${esc(item.label)}</b>${item.hint ? `<small>${esc(item.hint)}</small>` : ''}</div>`;
      })
      .join('');
    const helpRow = help
      ? `<div class="xv-assist-help" role="note"><b>${esc(help.key)}</b> ${esc(help.negate ? `excludes ${help.hint}` : help.hint)}${help.example ? ` <span>e.g. <code>${esc(help.example)}</code></span>` : ''}${help.negate ? '' : ' <span>· put <code>-</code> in front to exclude</span>'}</div>`
      : '';
    popup.innerHTML = `${helpRow}${rows}<div class="xv-assist-foot"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Tab</kbd> or <kbd>Enter</kbd> insert · <kbd>Esc</kbd> close · <kbd>Ctrl</kbd>+<kbd>Space</kbd> suggest</div>`;
    place();
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
    announce(list.length);
  }

  let live = null;
  function announce(count) {
    if (!live) {
      live = document.createElement('div');
      live.className = 'xv-sr-only';
      live.setAttribute('aria-live', 'polite');
      document.body.append(live);
    }
    live.textContent = count ? `${count} suggestion${count === 1 ? '' : 's'}` : '';
  }

  function hide() {
    items = [];
    active = -1;
    if (popup) popup.hidden = true;
    input?.setAttribute('aria-expanded', 'false');
    input?.removeAttribute('aria-activedescendant');
  }
  const open = () => !!popup && !popup.hidden;

  function highlight(index) {
    active = index;
    popup.querySelectorAll('[data-index]').forEach(option => {
      const on = Number(option.dataset.index) === active;
      option.setAttribute('aria-selected', String(on));
      if (on) option.scrollIntoView({ block: 'nearest' });
    });
    if (active >= 0) input.setAttribute('aria-activedescendant', `xvAssist-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function accept(item) {
    if (!item) return;
    let caret;
    if (item.recent) {
      input.value = item.insert;
      caret = input.value.length;
    } else {
      const current = token || tokenAt(input.value, input.selectionStart ?? input.value.length);
      const before = input.value.slice(0, current.start),
        rest = input.value.slice(current.end).replace(/^\s+/, ''),
        text = item.insert + (item.open ? '' : ' ');
      input.value = before + text + rest;
      caret = (before + text).length;
    }
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // A completed filter is a deliberate choice: count it (and keep it in Recent) right away.
    if (item.recent || !item.open) remember(input.value);
    input.focus();
    if (!item.open) hide();
  }

  async function update(force = false) {
    if (!input || document.activeElement !== input) return hide();
    await insights();
    if (document.activeElement !== input) return;
    show(compute({ force }));
  }
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  };

  function onKeydown(event) {
    if (event.target !== input || event.isComposing) return;
    if (event.key === ' ' && event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      update(true).then(() => open() && items.length && highlight(0));
      return;
    }
    if (!open()) {
      if (event.key === 'ArrowDown' && !input.value.trim()) {
        help = null;
        const list = startItems();
        if (!list.length) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        show(list);
        highlight(0);
      } else if (event.key === 'Enter') remember(input.value);
      return;
    }
    const last = items.length - 1;
    const move = index => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (items.length) highlight(Math.max(0, Math.min(last, index)));
    };
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!items.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlight(active < 0 ? (step > 0 ? 0 : last) : (active + step + items.length) % items.length);
    } else if (event.key === 'PageDown') move(active + 5);
    else if (event.key === 'PageUp') move(active - 5);
    else if ((event.key === 'Home' || event.key === 'End') && active >= 0) move(event.key === 'Home' ? 0 : last);
    else if ((event.key === 'Enter' || event.key === 'Tab') && active >= 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      accept(items[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      hide();
    } else if (event.key === 'Enter') {
      hide();
      remember(input.value);
    }
  }

  function mount() {
    input = document.querySelector('#search');
    if (!input) return;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'xvSearchAssist');
    input.setAttribute('aria-expanded', 'false');
    // The Library listens for input in the document capture phase and stops propagation, so listen on window.
    window.addEventListener(
      'input',
      event => {
        if (event.target === input) schedule();
      },
      true
    );
    window.addEventListener('keydown', onKeydown, true);
    input.addEventListener('pointerdown', () => {
      if (!input.value.trim())
        setTimeout(() => {
          // Typing may have started before this runs; only show the start list for a still-empty box.
          if (input.value.trim() || document.activeElement !== input) return;
          help = null;
          const list = startItems();
          if (list.length) show(list);
        });
    });
    input.addEventListener('focus', () => insights());
    input.addEventListener('blur', () => {
      hide();
      remember(input.value);
    });
    window.addEventListener('resize', () => open() && place());
    document.addEventListener('scroll', () => open() && place(), true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
