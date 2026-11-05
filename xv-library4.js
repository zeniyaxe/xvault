/* XVault 24 "Library 4.0": the Library's heading, active-filter chips, the filter builder, rich-preview
   interactions (quoted posts from the archive, reply and thread links, note shortcuts) and result motion.
   Builds on library-workspace.js through its public hooks (XVaultLibraryRunQuery, the renderLib observer) and
   never queries more than the posts on screen. No network: quoted posts come from GET_LIBRARY_RECORDS. */
(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const icon = name => window.XVaultIcons?.svg(name) || '';
  const esc = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );
  const split = value => String(value || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const unquote = token => String(token).replace(/^"|"$/g, '');
  const norm = token => unquote(token).toLowerCase();
  const query = () => ($('#search')?.value || '').trim();
  const run = (next, sort) => window.XVaultLibraryRunQuery?.(next.trim(), sort);
  const send = message =>
    new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => {
          void chrome.runtime.lastError;
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });

  /* ───────── Describing a query ───────── */
  const DESTINATIONS = {
    '': ['All posts', 'library'],
    'inbox:true': ['Inbox', 'inbox'],
    'fav:true': ['Favorites', 'favorite'],
    'untagged:true': ['Untagged', 'tag'],
    'is:later is:unread': ['Read later', 'later'],
    'has:highlight': ['Highlights', 'highlight'],
    'downloaded:true': ['On disk', 'disk'],
    'missing:true': ['Missing media', 'missing'],
    'type:image': ['Images', 'image'],
    'type:video': ['Videos', 'video'],
    'type:gif': ['GIFs', 'gif'],
    'source:bookmarks': ['Bookmarks', 'bookmark'],
    'source:likes': ['Likes', 'heart'],
    'source:profile': ['Profiles', 'person'],
  };
  const MEDIA = { image: 'Images', video: 'Videos', gif: 'GIFs', media: 'Media', photo: 'Images' };
  const KINDS = {
    reply: 'Replies',
    quote: 'Quotes',
    repost: 'Reposts',
    thread: 'Threads',
    original: 'Originals',
    later: 'Read later',
    unread: 'Unread',
    read: 'Read',
  };
  const METRIC = {
    likes: 'Likes',
    views: 'Views',
    reposts: 'Reposts',
    replies: 'Replies',
    bookmarks: 'Bookmarks',
    quotes: 'Quotes',
    media: 'Media items',
    size: 'Size',
  };
  const dateLabel = value => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime())
      ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
      : value;
  };
  const comparator = value => {
    const match = String(value).match(/^(>=|<=|>|<|=)?(.+)$/);
    const op = { '>': 'over', '>=': 'at least', '<': 'under', '<=': 'at most', '=': 'exactly' }[match?.[1] || ''] || '';
    return `${op ? `${op} ` : ''}${match?.[2] || value}`;
  };
  function describeToken(token) {
    const negative = /^-/.test(token) && token.length > 1;
    const body = unquote(negative ? token.slice(1) : token);
    const match = body.match(/^([a-z][a-z-]*):(.+)$/i);
    let text = body,
      symbol = 'search',
      kind = 'text';
    if (match) {
      const key = match[1].toLowerCase(),
        value = match[2];
      const values = value.split('|');
      kind = key;
      if (key === 'from') {
        text = `From ${values.map(v => `@${v.replace(/^@/, '')}`).join(' or ')}`;
        symbol = 'person';
      } else if (key === 'has' || key === 'type') {
        const named = values.map(v => MEDIA[v.toLowerCase()] || v);
        text = value === 'note' ? 'Has a note' : value === 'highlight' ? 'Highlights' : `${named.join(' or ')}`;
        symbol =
          { video: 'video', gif: 'gif', image: 'image', photo: 'image', note: 'note', highlight: 'highlight' }[
            values[0].toLowerCase()
          ] || 'images';
      } else if (key === 'tag') {
        text = values.map(v => `#${v}`).join(' or ');
        symbol = 'tag';
      } else if (key === 'untagged') [text, symbol] = ['Untagged', 'tag'];
      else if (key === 'inbox') [text, symbol] = ['Not reviewed', 'inbox'];
      else if (key === 'fav' || key === 'favorite') [text, symbol] = ['Favorites', 'favorite'];
      else if (key === 'note') [text, symbol] = [value === 'true' ? 'Has a note' : `Note mentions “${value}”`, 'note'];
      else if (key === 'downloaded') [text, symbol] = [value === 'false' ? 'Not on disk' : 'On disk', 'disk'];
      else if (key === 'missing') [text, symbol] = ['Missing media', 'missing'];
      else if (key === 'after') [text, symbol] = [`From ${dateLabel(value)}`, 'calendar'];
      else if (key === 'before') [text, symbol] = [`Before ${dateLabel(value)}`, 'calendar'];
      else if (key === 'on') [text, symbol] = [`On ${dateLabel(value)}`, 'calendar'];
      else if (key === 'year') [text, symbol] = [`Posted in ${value}`, 'calendar'];
      else if (key === 'within') [text, symbol] = [`Posted in the last ${value}`, 'calendar'];
      else if (key.startsWith('archived-')) [text, symbol] = [`Archived ${key.slice(9)} ${value}`, 'archive'];
      else if (METRIC[key])
        [text, symbol] = [
          `${METRIC[key]} ${comparator(value)}`,
          key === 'likes' ? 'heart' : key === 'views' ? 'eye' : 'stats',
        ];
      else if (key === 'is')
        [text, symbol] = [
          values.map(v => KINDS[v.toLowerCase()] || v).join(' or '),
          value === 'thread' ? 'thread' : value === 'quote' ? 'quote' : value === 'reply' ? 'replyArrow' : 'layers',
        ];
      else if (key === 'lang') [text, symbol] = [`Language: ${value}`, 'languages'];
      else if (key === 'source') [text, symbol] = [`From your ${value}`, 'bookmark'];
      else if (key === 'rating')
        [text, symbol] = [value === 'sensitive' ? 'Sensitive' : `Rating: ${value}`, 'sensitive'];
      else if (key === 'domain') [text, symbol] = [`Links to ${value}`, 'globe'];
      else if (key === 'thread') [text, symbol] = ['One conversation', 'thread'];
      else if (key === 'quotes') [text, symbol] = ['Quotes of a post', 'quote'];
      else if (key === 'board') [text, symbol] = ['Board', 'board'];
      else if (key === 'color') [text, symbol] = [`${value[0].toUpperCase()}${value.slice(1)} label`, 'color'];
      else [text, symbol] = [`${key}: ${value}`, 'filter'];
    } else if (/^#./.test(body)) [text, symbol, kind] = [body, 'hash', 'hashtag'];
    else if (/^@./.test(body)) [text, symbol, kind] = [`Mentions ${body}`, 'at', 'mention'];
    else text = `“${body}”`;
    return { token, text: negative ? `Not: ${text}` : text, symbol: negative ? 'ban' : symbol, kind, negative };
  }
  function describeQuery(value) {
    const trimmed = value.trim();
    if (Object.hasOwn(DESTINATIONS, trimmed))
      return { title: DESTINATIONS[trimmed][0], symbol: DESTINATIONS[trimmed][1], destination: true };
    const tokens = split(trimmed);
    if (tokens.length === 1) {
      const one = describeToken(tokens[0]);
      if (one.kind === 'from' && !one.negative) return { title: one.text.replace(/^From /, ''), symbol: 'person' };
      if (one.kind === 'tag' && !one.negative) return { title: one.text, symbol: 'tag' };
      if (one.kind === 'board') {
        const id = unquote(tokens[0]).split(':')[1];
        const board = (globalThis.settings?.boards || []).find(item => item.id === id);
        if (board) return { title: board.name, symbol: 'board' };
      }
    }
    const view = (globalThis.settings?.libraryViews || []).find(item => String(item.query || '').trim() === trimmed);
    if (view?.name) return { title: view.name, symbol: 'saved' };
    return { title: 'Search results', symbol: 'search' };
  }

  /* ───────── Heading, chips and the filter builder ───────── */
  let head, chipsRow, builder;
  function mountHeading() {
    const main = $('#page-library .lib-main'),
      command = $('#page-library .libraryCommand');
    if (!main || !command || $('#l4Head')) return;
    head = document.createElement('div');
    head.id = 'l4Head';
    head.className = 'l4-head';
    head.innerHTML = `<div class="l4-title"><span class="l4-glyph" aria-hidden="true"></span><div><h2 id="l4Title">All posts</h2><div class="l4-sub"></div></div></div><div class="l4-head-controls"></div>`;
    // XVault 25: the Library header (dashboard.html #libraryHead) already lays out the controls and the status
    // line; the title only fills its slot. Older markup without the slot keeps the v24 arrangement.
    const slot = $('#libraryTitleSlot');
    if (slot) slot.append(head);
    else {
      main.prepend(head);
      const status = $('#page-library .libraryStatusBar');
      if (status) head.querySelector('.l4-sub').append(status);
      const controls = $('#page-library .lib-controls');
      if (controls) head.querySelector('.l4-head-controls').append(controls);
    }

    // filter builder sits beside the search field
    builder = document.createElement('details');
    builder.className = 'menu l4-filter';
    builder.id = 'l4Filter';
    builder.innerHTML = `<summary data-tip="Build a filter without typing syntax">${icon('filter')}<span>Filter</span><em class="l4-filter-count" hidden></em></summary><form class="menu-pop l4-builder" aria-label="Filter builder"></form>`;
    command.append(builder);
    builder.addEventListener('toggle', () => {
      if (builder.open) paintBuilder();
    });
    builder.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      applyBuilder();
    });

    chipsRow = document.createElement('div');
    chipsRow.id = 'l4Query';
    chipsRow.className = 'l4-query';
    chipsRow.setAttribute('role', 'list');
    chipsRow.setAttribute('aria-label', 'Active filters');
    chipsRow.hidden = true;
    const filters = $('#page-library .lib-filters'),
      activeSlot = $('#libraryActiveSlot');
    if (activeSlot) activeSlot.append(chipsRow);
    else (filters || command).before(chipsRow);
    chipsRow.addEventListener('click', event => {
      const remove = event.target.closest('[data-remove-token]');
      if (remove) {
        const index = Number(remove.dataset.removeToken);
        const tokens = split(query());
        tokens.splice(index, 1);
        run(tokens.join(' '));
        $('#search')?.focus({ preventScroll: true });
        return;
      }
      if (event.target.closest('[data-clear-query]')) {
        run('');
        return;
      }
      if (event.target.closest('[data-save-query]')) {
        const name = $('#libraryViewName');
        if (name) {
          name.value ||= describeQuery(query()).title === 'Search results' ? '' : describeQuery(query()).title;
          name.scrollIntoView({ block: 'center', behavior: 'smooth' });
          name.focus();
        }
      }
    });
    paint();
  }

  function paint() {
    if (!head) return;
    const value = query();
    const info = describeQuery(value);
    const title = $('#l4Title');
    if (title && title.textContent !== info.title) {
      title.textContent = info.title;
      // Restart the swap animation a frame later rather than forcing a layout mid-query (rapid typing).
      title.classList.remove('l4-swap');
      requestAnimationFrame(() => title.classList.add('l4-swap'));
    }
    const glyph = head.querySelector('.l4-glyph');
    if (glyph && glyph.dataset.symbol !== info.symbol) {
      glyph.dataset.symbol = info.symbol;
      glyph.innerHTML = icon(info.symbol);
    }
    const tokens = split(value);
    const filterTokens = info.destination ? [] : tokens;
    chipsRow.hidden = !filterTokens.length;
    chipsRow.innerHTML = filterTokens.length
      ? filterTokens
          .map((token, index) => {
            const chip = describeToken(token);
            return `<span class="l4-chip" role="listitem" data-kind="${esc(chip.kind)}"${chip.negative ? ' data-negative' : ''}>${icon(chip.symbol)}<span>${esc(chip.text)}</span><button type="button" class="l4-chip-x" data-remove-token="${index}" aria-label="Remove filter: ${esc(chip.text)}">${icon('close')}</button></span>`;
          })
          .join('') +
        `<span class="l4-query-tools">${filterTokens.length > 1 ? `<button type="button" class="quiet sm" data-clear-query>${icon('filterClear')}Clear all</button>` : ''}<button type="button" class="quiet sm" data-save-query data-tip="Save this search as a live Smart Collection">${icon('bookmarkPlus')}Save as collection</button></span>`
      : '';
    const count = builder?.querySelector('.l4-filter-count');
    if (count) {
      const n = info.destination ? (value ? 1 : 0) : tokens.length;
      count.hidden = !n;
      count.textContent = String(n);
    }
    $('#page-library')?.toggleAttribute('data-filtered', !!value);
  }

  const BUILDER_GROUPS = {
    media: /^has:(image|video|gif)(\|.*)?$/i,
    posted: /^(after|before|within|year|on):/i,
    likes: /^likes:/i,
  };
  function authorOptions() {
    return $$('#facetAuthors [data-token]')
      .map(button => unquote(button.dataset.token).replace(/^from:/i, ''))
      .filter(Boolean)
      .slice(0, 60);
  }
  function tagOptions() {
    return $$('#facetTags [data-token]')
      .map(button => unquote(button.dataset.token).replace(/^tag:/i, ''))
      .filter(Boolean)
      .slice(0, 60);
  }
  function paintBuilder() {
    const form = builder.querySelector('form');
    const tokens = split(query()).map(norm);
    const has = token => tokens.includes(token);
    const media =
      tokens
        .find(token => BUILDER_GROUPS.media.test(token))
        ?.split(':')[1]
        ?.split('|') || [];
    const after = tokens.find(token => token.startsWith('after:'))?.slice(6) || '';
    const before = tokens.find(token => token.startsWith('before:'))?.slice(7) || '';
    const within = tokens.find(token => token.startsWith('within:'))?.slice(7) || '';
    const likes = tokens.find(token => token.startsWith('likes:>'))?.slice(7) || '';
    const toggle = (token, label, symbol) =>
      `<label class="l4-toggle"><input type="checkbox" name="flag" value="${esc(token)}"${has(token) ? ' checked' : ''}><span>${icon(symbol)}${esc(label)}</span></label>`;
    form.innerHTML = `<header><b>Filter posts</b><small>Combines with your search. Everything runs locally.</small></header>
<fieldset><legend>Media</legend><div class="l4-pills">${['image', 'video', 'gif']
      .map(
        kind =>
          `<label class="l4-pill"><input type="checkbox" name="media" value="${kind}"${media.includes(kind) ? ' checked' : ''}><span>${icon(kind === 'gif' ? 'gif' : kind)}${MEDIA[kind]}</span></label>`
      )
      .join('')}</div></fieldset>
<fieldset><legend>Posted</legend><div class="l4-pills">${[
      ['', 'Any time'],
      ['7d', 'Last 7 days'],
      ['30d', 'Last 30 days'],
      ['365d', 'Last year'],
    ]
      .map(
        ([value, label]) =>
          `<label class="l4-pill"><input type="radio" name="within" value="${value}"${within === value && !(value === '' && (after || before)) ? ' checked' : ''}><span>${label}</span></label>`
      )
      .join(
        ''
      )}</div><div class="l4-dates"><label><span>From</span><input type="date" name="after" value="${esc(after)}"></label><label><span>Through</span><input type="date" name="through" value="${esc(before ? shiftDay(before, -1) : '')}"></label></div></fieldset>
<fieldset class="l4-two"><label><span>Author</span><input name="from" list="l4Authors" placeholder="@handle" autocomplete="off"><datalist id="l4Authors">${authorOptions()
      .map(item => `<option value="${esc(item)}">`)
      .join(
        ''
      )}</datalist></label><label><span>Tag</span><input name="tag" list="l4Tags" placeholder="tag" autocomplete="off"><datalist id="l4Tags">${tagOptions()
      .map(item => `<option value="${esc(item)}">`)
      .join('')}</datalist></label></fieldset>
<fieldset><legend>Engagement</legend><select name="likes" aria-label="Minimum likes"><option value="">Any number of likes</option>${[
      '100',
      '1000',
      '10000',
      '100000',
    ]
      .map(
        value =>
          `<option value="${value}"${likes === value || likes === value.replace('000', 'k') ? ' selected' : ''}>More than ${Number(value).toLocaleString()} likes</option>`
      )
      .join('')}</select></fieldset>
<fieldset><legend>Status</legend><div class="l4-toggles">${toggle('fav:true', 'Favorites', 'favorite')}${toggle('has:note', 'Has a note', 'note')}${toggle('inbox:true', 'Not reviewed', 'inbox')}${toggle('downloaded:true', 'On disk', 'disk')}${toggle('missing:true', 'Missing media', 'missing')}${toggle('rating:sensitive', 'Sensitive', 'sensitive')}</div></fieldset>
<fieldset><legend>Kind</legend><div class="l4-toggles">${toggle('is:original', 'Originals', 'layers')}${toggle('is:reply', 'Replies', 'replyArrow')}${toggle('is:quote', 'Quotes', 'quote')}${toggle('is:thread', 'Threads', 'thread')}</div></fieldset>
<footer><button type="button" class="quiet" data-builder-reset>Reset</button><button type="submit" class="primary">${icon('tick')}Apply filters</button></footer>`;
    form.querySelector('[data-builder-reset]').addEventListener('click', () => {
      form.reset();
      for (const input of form.querySelectorAll('input[type=checkbox]')) input.checked = false;
      for (const input of form.querySelectorAll('input[type=date],input[name=from],input[name=tag]')) input.value = '';
      form.querySelector('input[name=within][value=""]').checked = true;
      form.querySelector('select[name=likes]').value = '';
    });
    for (const input of form.querySelectorAll('input[type=date]'))
      input.addEventListener('input', () => {
        if (input.value) form.querySelector('input[name=within][value=""]').checked = true;
      });
  }
  function shiftDay(value, days) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime())) return '';
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }
  function applyBuilder() {
    const form = builder.querySelector('form');
    const data = new FormData(form);
    const managed = new Set([
      'fav:true',
      'has:note',
      'inbox:true',
      'downloaded:true',
      'missing:true',
      'rating:sensitive',
      'is:original',
      'is:reply',
      'is:quote',
      'is:thread',
    ]);
    let tokens = split(query()).filter(token => {
      const n = norm(token);
      return (
        !managed.has(n) &&
        !BUILDER_GROUPS.media.test(n) &&
        !BUILDER_GROUPS.posted.test(n) &&
        !BUILDER_GROUPS.likes.test(n)
      );
    });
    const media = data.getAll('media');
    if (media.length) tokens.push(`has:${media.join('|')}`);
    const within = data.get('within');
    const after = data.get('after'),
      through = data.get('through');
    if (after || through) {
      if (after) tokens.push(`after:${after}`);
      if (through) tokens.push(`before:${shiftDay(through, 1)}`);
    } else if (within) tokens.push(`within:${within}`);
    const from = String(data.get('from') || '')
      .trim()
      .replace(/^@/, '');
    if (/^[A-Za-z0-9_]{1,30}$/.test(from) && !tokens.some(token => norm(token) === `from:${from.toLowerCase()}`))
      tokens.push(`from:${from}`);
    const tag = String(data.get('tag') || '')
      .trim()
      .replace(/^#/, '');
    if (tag && !tokens.some(token => norm(token) === `tag:${tag.toLowerCase()}`))
      tokens.push(/\s/.test(tag) ? `"tag:${tag}"` : `tag:${tag}`);
    const likes = data.get('likes');
    if (likes) tokens.push(`likes:>${likes}`);
    for (const flag of data.getAll('flag')) tokens.push(String(flag));
    builder.open = false;
    run(tokens.join(' '));
  }

  /* ───────── Rich previews ───────── */
  const quoteCache = new Map();
  let quoteGeneration = 0;
  function monogram(name) {
    const letter = (String(name || '?').replace(/^@/, '')[0] || '?').toUpperCase();
    return `<span class="avatar fallback" aria-hidden="true">${esc(letter)}</span>`;
  }
  function quoteHtml(id, row) {
    if (!row)
      return `<span class="quoteLabel">${icon('quote')}Quoted post</span><p class="quoteMissing">This post isn’t in your archive yet.</p><a class="quoteOpen" href="https://x.com/i/status/${esc(id)}" target="_blank" rel="noopener noreferrer">${icon('external')}Open on X</a>`;
    const author = row.author || {};
    const handle = String(author.handle || 'unknown');
    const avatar =
      author.avatar && /^https:\/\//.test(author.avatar)
        ? `<img class="avatar" src="${esc(author.avatar)}" alt="" loading="lazy">`
        : monogram(author.name || handle);
    const date =
      row.createdAt && Number.isFinite(new Date(row.createdAt).getTime())
        ? new Date(row.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
        : '';
    const media = (row.media || []).find(item => item?.preview || item?.url);
    const thumb = media ? String(media.preview || media.url) : '';
    return `<div class="quoteHead">${avatar}<b>${esc(author.name || handle)}</b><small>@${esc(handle)}${date ? ` · ${esc(date)}` : ''}</small></div><div class="quoteBody"><p>${esc(String(row.text || '').slice(0, 420))}</p>${thumb && /^https:\/\//.test(thumb) ? `<span class="quoteThumb"><img src="${esc(thumb)}" alt="" loading="lazy"></span>` : ''}</div><button type="button" class="linkish quoteShow" data-thread-filter="${esc(row.conversationId || row.id)}">${icon('thread')}Show in Library</button>`;
  }
  async function hydrateQuotes() {
    const slots = $$('#list .quoteEmbed[aria-busy="true"]');
    if (!slots.length) return;
    const generation = ++quoteGeneration;
    const wanted = [...new Set(slots.map(slot => slot.dataset.quoted))].filter(id => !quoteCache.has(id)).slice(0, 200);
    const local = new Map((window.XVaultLibraryRows?.() || []).map(row => [String(row.id), row]));
    const remote = wanted.filter(id => !local.has(id));
    for (const id of wanted) if (local.has(id)) quoteCache.set(id, local.get(id));
    if (remote.length) {
      const response = await send({ type: 'GET_LIBRARY_RECORDS', ids: remote });
      const rows = new Map((response?.rows || []).filter(Boolean).map(row => [String(row.id), row]));
      for (const id of remote) quoteCache.set(id, rows.get(id) || null);
      while (quoteCache.size > 600) quoteCache.delete(quoteCache.keys().next().value);
    }
    if (generation !== quoteGeneration) return;
    for (const slot of slots) {
      if (!slot.isConnected) continue;
      const row = quoteCache.get(slot.dataset.quoted);
      slot.innerHTML = quoteHtml(slot.dataset.quoted, row);
      slot.classList.toggle('missing', !row);
      slot.removeAttribute('aria-busy');
    }
  }

  function wireList() {
    const list = $('#list');
    if (!list || list.dataset.l4) return;
    list.dataset.l4 = '1';
    list.addEventListener('click', event => {
      const author = event.target.closest('[data-author-filter]');
      if (author) {
        event.stopPropagation();
        run(`from:${author.dataset.authorFilter}`);
        return;
      }
      const thread = event.target.closest('[data-thread-filter]');
      if (thread) {
        event.stopPropagation();
        run(`thread:${thread.dataset.threadFilter}`, 'thread');
        return;
      }
      const note = event.target.closest('[data-note-open]');
      if (note) {
        event.stopPropagation();
        note.closest('article')?.querySelector('[data-details]')?.click();
      }
    });
    list.addEventListener('keydown', event => {
      if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('[data-note-open]')) {
        event.preventDefault();
        event.target.click();
      }
    });
  }

  function afterRender() {
    wireList();
    paint();
    void hydrateQuotes();
  }

  function mount() {
    mountHeading();
    wireList();
    $('#search')?.addEventListener('input', () => requestAnimationFrame(paint));
    document.addEventListener('click', event => {
      if (event.target.closest('#libraryDestinations [data-destination], #libraryChips [data-filter]'))
        requestAnimationFrame(paint);
    });
    afterRender();
  }
  window.XVaultDashboard?.after('renderLib', afterRender);
  // Library 5.0 mounts cards in blocks as the reader scrolls; quotes in each new block resolve as it arrives.
  document.addEventListener('xv:library-mounted', () => void hydrateQuotes());
  window.XVaultLibrary4 = Object.freeze({ describeToken, describeQuery, hydrateQuotes });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
