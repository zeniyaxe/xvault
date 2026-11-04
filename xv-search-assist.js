/* XVault search suggestions — a small combobox for the Library search box. It completes filter keys
   and their values (people, tags, languages, sites, dates) from the local Atlas insights and remembers
   recent searches on this computer. Keys are only intercepted while the suggestion list is open. */
(() => {
  const RECENT_KEY = 'xv-recent-searches',
    LIMIT = 8;
  const KEYS = [
    ['from:', 'posts by a person'],
    ['tag:', 'one of your tags'],
    ['has:', 'video, gif, image, media, note, tag or download'],
    ['is:', 'reply, quote, repost, thread, original…'],
    ['lang:', 'language'],
    ['domain:', 'linked website'],
    ['source:', 'where it was archived from'],
    ['on:', 'posted on a day'],
    ['archived-on:', 'archived on a day'],
    ['after:', 'posted on or after a day'],
    ['before:', 'posted before a day'],
    ['archived-after:', 'archived on or after a day'],
    ['archived-before:', 'archived before a day'],
    ['within:', 'posted recently'],
    ['archived-within:', 'archived recently'],
    ['year:', 'posted in a year'],
    ['archived-year:', 'archived in a year'],
    ['fav:', 'favorites'],
    ['inbox:', 'not reviewed yet'],
    ['untagged:', 'posts without tags'],
    ['note:', 'has a note, or note text'],
    ['downloaded:', 'files on disk'],
    ['missing:', 'files not downloaded yet'],
    ['likes:', 'likes, e.g. >500'],
    ['views:', 'views, e.g. >10k'],
    ['reposts:', 'reposts, e.g. >100'],
    ['media:', 'number of media files'],
    ['size:', 'download size'],
    ['rating:', 'sensitive posts'],
    ['mention:', 'mentions a person'],
    ['hashtag:', 'uses a hashtag'],
    ['thread:', 'a conversation by post ID'],
    ['quotes:', 'posts quoting a post ID'],
    ['id:', 'a post ID'],
  ];
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
  const ALIASES = { artist: 'from', author: 'from', site: 'domain', language: 'lang', mentions: 'mention' };

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
  function remember(query) {
    const value = String(query || '').trim();
    if (value.length < 2) return;
    const list = [value, ...read().filter(entry => entry !== value)].slice(0, 10);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {}
  }

  async function insights() {
    if (data && Date.now() - dataAt < 120000) return data;
    dataAt = Date.now();
    try {
      data = (await window.XVaultInsights?.()) || data;
    } catch {}
    return data;
  }

  const utcDay = offset => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  function dateValues() {
    const now = new Date();
    return [
      [utcDay(0), 'today (UTC)'],
      [utcDay(1), 'yesterday'],
      [utcDay(7), 'a week ago'],
      [`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`, 'start of this month'],
      [`${now.getUTCFullYear()}-01-01`, 'start of this year'],
    ];
  }
  function yearValues(field) {
    const years = new Set(Object.keys(data?.days?.[field] || {}).map(key => key.slice(0, 4)));
    return [...years].sort().reverse().slice(0, 12);
  }
  const counted = entry => [entry.key, `${fmt(entry.count)} posts`];

  function valuesFor(key, partial) {
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
    const needle = partial.toLowerCase();
    const scored = pool
      .map(([value, hint, haystack]) => {
        const lower = String(value).toLowerCase(),
          extra = haystack || lower;
        const score = !needle ? 1 : lower.startsWith(needle) ? 3 : extra.includes(needle) ? 2 : 0;
        return { value: String(value), hint, score };
      })
      .filter(entry => entry.score);
    return scored.sort((a, b) => b.score - a.score).slice(0, LIMIT);
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

  function compute() {
    const value = input.value,
      caret = input.selectionStart ?? value.length;
    token = tokenAt(value, caret);
    const text = token.text;
    if (!text) return [];
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
        }));
      if (body.startsWith('@'))
        return valuesFor('from', body.slice(1)).map(entry => ({
          insert: `${negate}from:${entry.value}`,
          label: `from:${entry.value}`,
          hint: entry.hint,
        }));
      const lower = body.toLowerCase();
      const keys = KEYS.filter(([key]) => key.startsWith(lower) && key !== lower)
        .slice(0, 5)
        .map(([key, hint]) => ({ insert: negate + key, label: negate + key, hint, open: true }));
      const people =
        lower.length >= 2
          ? valuesFor('from', lower)
              .slice(0, 3)
              .map(entry => ({
                insert: `${negate}from:${entry.value}`,
                label: `from:${entry.value}`,
                hint: entry.hint,
              }))
          : [];
      return [...keys, ...people];
    }
    const rawKey = body.slice(0, colon),
      key = rawKey.toLowerCase(),
      rest = body.slice(colon + 1),
      pipe = rest.lastIndexOf('|');
    const head = pipe >= 0 ? rest.slice(0, pipe + 1) : '',
      tail = rest.slice(pipe + 1);
    return valuesFor(key, tail)
      .filter(entry => entry.value.toLowerCase() !== tail.toLowerCase() || pipe >= 0)
      .map(entry => ({
        insert: `${negate}${rawKey}:${head}${entry.value}`,
        label: `${negate}${rawKey}:${head}${entry.value}`,
        hint: entry.hint,
      }));
  }

  function recentItems() {
    return read()
      .slice(0, LIMIT)
      .map(query => ({ insert: query, label: query, hint: 'recent', recent: true }));
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
    if (!list.length) return hide();
    ensurePopup();
    const recent = list[0]?.recent;
    popup.innerHTML = `${recent ? '<div class="xv-assist-head">Recent searches</div>' : ''}${list
      .map(
        (item, index) =>
          `<div class="xv-assist-item" role="option" id="xvAssist-${index}" data-index="${index}" aria-selected="false"><b>${esc(item.label)}</b>${item.hint ? `<small>${esc(item.hint)}</small>` : ''}</div>`
      )
      .join(
        ''
      )}<div class="xv-assist-foot"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Tab</kbd> or <kbd>Enter</kbd> insert · <kbd>Esc</kbd> close</div>`;
    place();
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.removeAttribute('aria-activedescendant');
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
    if (item.recent) remember(input.value);
    input.focus();
    if (!item.open) hide();
  }

  async function update() {
    if (!input || document.activeElement !== input) return hide();
    await insights();
    if (document.activeElement !== input) return;
    show(compute());
  }
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  };

  function onKeydown(event) {
    if (event.target !== input || event.isComposing) return;
    if (!open()) {
      if (event.key === 'ArrowDown' && !input.value.trim() && read().length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        show(recentItems());
        highlight(0);
      } else if (event.key === 'Enter') remember(input.value);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlight(active < 0 ? (step > 0 ? 0 : items.length - 1) : (active + step + items.length) % items.length);
    } else if ((event.key === 'Enter' || event.key === 'Tab') && active >= 0) {
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
      if (!input.value.trim() && read().length) setTimeout(() => show(recentItems()));
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
