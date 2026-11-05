/* XVault 25 "Vantage" — Library 5.0 feed.
   One renderer for the Feed (timeline), Cards, Grid (gallery) and Wall (masonry) layouts. It replaces the
   string-template renderer that dashboard.js carried since v12 and the per-element click bindings it installed
   on every render. Responsibilities:
     • card markup in four styles (compact · comfortable · media-first · detailed) with one stable contract:
       #list > article.tweet[data-id] and the data-* action attributes other modules already use;
     • incremental mounting: only the posts near the viewport are in the DOM. Cards are appended in blocks as the
       reader approaches the end and blocks far above the viewport are swapped for one measured spacer, so a
       1,500-post window never mounts 1,500 cards;
     • keyed refresh: re-rendering the same query patches cards in place (no image reload, no lost scroll);
     • delegated events: one click, change, keydown and error listener on #list instead of thousands of handlers;
     • media states: aspect-ratio boxes, cover/contain fit, lazy decoding, click-to-play video (no <video> element
       until the reader asks for one), GIF autoplay only while visible, missing-media and broken-avatar fallbacks,
       sensitive media veiled until revealed;
     • layout-switch motion: FLIP from the old card positions, skipped under reduced motion.
   The query, paging and selection state stay in library-workspace.js; this module only draws what it is given. */
(() => {
  const $ = selector => document.querySelector(selector);
  const ICONS = new Map();
  const icon = name => {
    if (ICONS.has(name)) return ICONS.get(name);
    const markup = window.XVaultIcons?.svg(name) || '';
    if (markup) ICONS.set(name, markup);
    return markup;
  };
  const BLOCK_ROWS = 6; // rows of cards per mount block
  const MAX_MOUNTED_BLOCKS = 7; // blocks kept in the DOM around the viewport
  const TILE_LAYOUTS = new Set(['gallery', 'masonry']);
  const state = {
    rows: [],
    key: '',
    scrolled: false,
    view: 'cards',
    variant: 'comfortable',
    block: 24,
    cols: 1,
    start: 0, // first mounted row index (multiple of block)
    end: 0, // one past the last mounted row index
    spacer: 0, // height of the spacer that stands in for unmounted blocks above
    heights: [], // measured height of each unmounted block (index = block number)
    frame: 0,
    gifObserver: null,
    playObserver: null,
    endObserver: null,
    resizeObserver: null,
    nearEnd: null,
    selected: () => new Set(),
  };
  const reducedMotion = () =>
    document.body.dataset.motion === 'off' ||
    document.body.dataset.motion === 'reduced' ||
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scroller = () => $('#libraryScroll') || $('#page-library');
  const list = () => $('#list');

  /* ───────── Markup ───────── */
  const dateText = value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? {
          iso: date.toISOString(),
          title: date.toLocaleString(),
          text: date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }),
        }
      : null;
  };
  const duration = ms => {
    const seconds = Math.round(Number(ms) / 1000);
    if (!(seconds > 0)) return '';
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const monogram = (name, handle) => esc((String(name || handle || '?').trim()[0] || '?').toUpperCase());
  function avatarHtml(t, handle) {
    const avatar = String(t.author?.avatar || '');
    const mono = monogram(t.author?.name, handle);
    const key = esc(String(handle || '').toLowerCase());
    if (settings.libraryShowAvatars === false) return `<span class="avatar fallback" aria-hidden="true">${mono}</span>`;
    // XVault 25: false = a locally archived avatar is loading; the monogram is swapped for it in place.
    const local = window.XVaultAvatarUrl?.(handle, avatar);
    const src = local || (local !== false && /^https:\/\//.test(avatar) ? avatar : '');
    if (!src) return `<span class="avatar fallback" aria-hidden="true" data-avatar-handle="${key}">${mono}</span>`;
    return `<img class="avatar" src="${esc(src)}" alt="" loading="lazy" decoding="async" data-avatar-handle="${key}" data-monogram="${mono}">`;
  }
  function mediaPick(t, m) {
    const kind = mediaLogical(m),
      basePick = mediaSource(m),
      mode = settings.libraryAnimationMode || 'native',
      localGif = kind === 'gif' ? localConvertedFor(t, m) : null;
    if (kind === 'gif' && mode === 'mp4')
      return { src: bestVariant(m) || m.playbackUrl || basePick.src, native: false, kind };
    if (localGif) return { src: localGif, native: true, kind, localConverted: true, fallback: basePick.src };
    return { ...basePick, kind };
  }
  function mediaItemHtml(t, m, idx, mi, handle, tile) {
    const pick = mediaPick(t, m);
    if (!pick.src) return '';
    const kind = pick.kind,
      ratio = m.width > 0 && m.height > 0 ? ` style="--ar:${Number(m.width)}/${Number(m.height)}"` : '',
      moving = kind === 'video' || (kind === 'gif' && !pick.native),
      poster = moving ? String(m.preview || m.url || '') : pick.src,
      label = kind === 'video' ? 'Video' : kind === 'gif' ? 'GIF' : 'Image',
      time = kind === 'video' ? duration(m.durationMs || m.duration_ms) : '',
      dims = m.width && m.height ? `${m.width}×${m.height}` : '';
    const still = poster
      ? `<img src="${esc(poster)}" alt="${esc(`${label} from @${handle}`)}" loading="lazy" decoding="async"${pick.localConverted ? ` data-local-converted="1" data-fallback="${esc(pick.fallback || '')}"` : ''}>`
      : `<span class="mediaPoster" aria-hidden="true">${icon(kind === 'video' ? 'video' : 'image')}</span>`;
    return `<figure class="mediaItem ${kind}" data-t="${idx}" data-m="${mi}"${ratio}${moving ? ` data-src="${esc(pick.src)}"` : ''}>${still}${
      kind === 'video'
        ? `<button type="button" class="playOverlay" data-play="${idx}:${mi}" aria-label="Play video${time ? `, ${time}` : ''}"><i>${icon('play')}</i></button>`
        : ''
    }<span class="mediaType">${tile && time ? time : `${label}${time ? ` · ${time}` : ''}`}</span>${tile ? '' : `<span class="formatBadge">${esc(dims)}</span>`}<button type="button" class="mediaDownload" data-dl-one="${idx}:${mi}" title="Download this media" aria-label="Download this media">${icon('download')}</button></figure>`;
  }
  function mediaGridHtml(t, idx, handle, tile) {
    const all = (t.media || []).filter(Boolean);
    if (!all.length) return '';
    const limit = tile ? 1 : 4,
      shown = all.slice(0, limit),
      body = shown.map((m, mi) => mediaItemHtml(t, m, idx, mi, handle, tile)).join('');
    if (!body) return '';
    const more = all.length - shown.length;
    return `<div class="mediaGrid" data-count="${Math.min(all.length, limit)}" data-total="${all.length}"${
      t.sensitive && settings.libraryBlurSensitive !== false ? ' data-veiled="true"' : ''
    }>${body}${
      more > 0
        ? `<button type="button" class="mediaOverflow" data-media-more="${idx}" aria-label="Open viewer to browse all ${all.length} media items">+${more}</button>`
        : ''
    }${t.sensitive && settings.libraryBlurSensitive !== false ? `<button type="button" class="mediaVeil" data-reveal="${idx}" aria-label="Show sensitive media">${icon('eyeOff') || icon('eye')}<span>${tile ? 'Sensitive' : 'Sensitive media · Show'}</span></button>` : ''}</div>`;
  }
  function badgesHtml(t, um, detailed) {
    const out = [];
    if (window.XVaultLibraryModel?.isInbox?.(t, settings.inboxSince))
      out.push('<span class="new" title="New since your last review">New</span>');
    if (um.readLater && !um.readAt) out.push('<span class="later" title="Saved for later">Later</span>');
    if (um.highlights?.length)
      out.push(
        `<span class="hl">${fmt(um.highlights.length)} highlight${um.highlights.length === 1 ? '' : 's'}</span>`
      );
    for (const board of (um.boards || [])
      .slice(0, 2)
      .map(id => (settings.boards || []).find(item => item.id === id))
      .filter(Boolean))
      out.push(`<span class="board" style="--board:${esc(board.color || 'var(--accent)')}">${esc(board.name)}</span>`);
    if (t.sensitive) out.push('<span class="flag">Sensitive</span>');
    if (detailed) for (const flag of (t.sourceFlags || []).slice(0, 2)) out.push(`<span>${esc(flag)}</span>`);
    return out.length ? `<div class="tweetMetaBadges">${out.join('')}</div>` : '';
  }
  const METRICS = [
    ['likes', 'heart', 'Likes'],
    ['reposts', 'repost', 'Reposts'],
    ['replies', 'reply', 'Replies'],
    ['views', 'eye', 'Views'],
    ['bookmarks', 'bookmark', 'Bookmarks'],
  ];
  function metricsHtml(t, local, total, variant) {
    if (settings.libraryShowMetrics === false) return '';
    const wanted = variant === 'compact' ? METRICS.slice(0, 1) : METRICS;
    const cells = wanted
      .map(([key, name, label]) => {
        const value = t.metrics?.[key];
        return `<span aria-label="${label}: ${esc(fmt(value))}" title="${label}: ${esc(fmt(value))}">${icon(name)}<b>${esc(fmtCompact(value))}</b></span>`;
      })
      .join('');
    const disk = total
      ? `<span class="disk${local >= total ? ' complete' : ''}" title="Media files saved to disk">${icon('disk')}<b>${local}/${total}</b><i> on disk</i></span>`
      : '';
    return `<div class="metricBar" data-icons-ready="1">${cells}${disk}</div>`;
  }
  function tagsHtml(t, um, idx) {
    const all = um.tags || [],
      shown = all.slice(0, 6);
    return `<div class="tweetTags">${shown
      .map(
        tag => `<button type="button" data-tag="${esc(tag)}" aria-label="Filter by #${esc(tag)}">#${esc(tag)}</button>`
      )
      .join('')}${
      all.length > shown.length
        ? `<button type="button" class="tagOverflow" data-expand-tags="${idx}" aria-expanded="false" aria-label="Show ${all.length - shown.length} more tags">+${all.length - shown.length}</button>`
        : ''
    }<button type="button" class="tagAdd" data-addtag="${esc(t.id)}" title="Add a tag" aria-label="Add a tag">${icon('tag')}<span class="lbl">Tag</span></button></div>`;
  }
  function actionsHtml(t, um, dls) {
    const id = esc(t.id);
    const button = (attr, value, name, label, extra = '') =>
      `<button type="button" ${attr}="${value}" title="${label}" aria-label="${label}"${extra}>${icon(name)}<span class="lbl">${label}</span></button>`;
    return `<div class="tweetActions" role="group" aria-label="Post actions">${button('data-fav', id, 'favorite', um.favorite ? 'Remove favorite' : 'Favorite', ` aria-pressed="${um.favorite ? 'true' : 'false'}"`)}${
      (t.media || []).length ? button('data-download-post', id, 'download', 'Download media') : ''
    }${button('data-quicklook', id, 'quicklook', 'Quick Look')}${button('data-details', id, 'inspector', 'Details')}${button('data-copy', esc(t.url || ''), 'link', 'Copy link')}${button('data-open', esc(t.url || ''), 'external', 'Open on X')}${
      dls[0]?.downloadId ? button('data-show', esc(dls[0].downloadId), 'folder', 'Show file') : ''
    }</div>`;
  }
  const TEXT_LIMIT = { compact: 180, comfortable: 480, media: 140, detailed: 1200 };
  function cardHtml(t, idx, ctx) {
    const um = t.userMeta || {},
      dls = libraryDownloads.get(String(t.id)) || [],
      handle = String(t.author?.handle || 'unknown'),
      name = String(t.author?.name || handle),
      total = (t.media || []).length,
      local = dls.filter(row => row.state === 'complete').length,
      tile = TILE_LAYOUTS.has(ctx.view),
      variant = tile ? 'media' : ctx.variant,
      detailed = variant === 'detailed',
      when = t.createdAt ? dateText(t.createdAt) : null,
      raw = String(t.text || ''),
      limit = TEXT_LIMIT[variant] || 480,
      long = raw.length > limit,
      text = raw.length > 1200 ? `${raw.slice(0, 1200)}…` : raw,
      selected = ctx.selected.has(String(t.id)),
      color = um.colorLabel && um.colorLabel !== 'none' ? um.colorLabel : '';
    const classes = ['tweet', `v-${variant}`];
    if (t.sensitive) classes.push('sensitive');
    if (um.favorite) classes.push('favorite');
    if (selected) classes.push('xv-selected');
    if (!total) classes.push('textOnly');
    const who = `<header class="who">${avatarHtml(t, handle)}<div class="identity">${
      settings.libraryShowNames !== false
        ? `<b class="name" title="${esc(name)}">${esc(name)}</b>${t.author?.verified ? `<span class="verified" role="img" aria-label="Verified">${icon('verified') || '✓'}</span>` : ''}`
        : ''
    }<small title="@${esc(handle)}">@${esc(handle)}</small></div>${when ? `<time datetime="${esc(when.iso)}" title="${esc(when.title)}">${esc(when.text)}</time>` : ''}</header>`;
    const select = `<label class="xv-card-select" title="Select (Shift-click for a range)"><input type="checkbox" data-select="${esc(t.id)}" aria-label="Select post by @${esc(handle)}"${selected ? ' checked' : ''}></label>${
      color ? `<span class="xv-color-pill" data-color="${esc(color)}">${esc(color)} label</span>` : ''
    }`;
    const textHtml = raw
      ? `<p class="tweetText${long ? ' clamped' : ''}">${linkifyText(text)}</p>${long ? `<button type="button" class="textMore" data-more-text="${idx}" aria-expanded="false">Show more</button>` : ''}`
      : '';
    if (tile) {
      const media = mediaGridHtml(t, idx, handle, true);
      return `<article class="${classes.join(' ')} tile" data-id="${esc(t.id)}" data-idx="${idx}" tabindex="0"${color ? ` data-color-label="${esc(color)}"` : ''} aria-label="${esc(`Post by @${handle}${raw ? `: ${raw.slice(0, 80)}` : ''}`)}">${select}${
        media || `<div class="tileText"><p class="tweetText">${linkifyText(raw.slice(0, 320) || 'Text post')}</p></div>`
      }<div class="tileVeil">${who}${media && raw ? `<p class="tileCaption">${esc(raw.slice(0, 140))}</p>` : ''}${actionsHtml(t, um, dls)}</div></article>`;
    }
    return `<article class="${classes.join(' ')}" data-id="${esc(t.id)}" data-idx="${idx}" tabindex="0"${color ? ` data-color-label="${esc(color)}"` : ''}>${select}${who}${
      variant === 'compact' ? '' : badgesHtml(t, um, detailed)
    }${postContextHtml(t, handle)}${variant === 'media' ? mediaGridHtml(t, idx, handle, false) + textHtml : textHtml + mediaGridHtml(t, idx, handle, false)}${
      variant === 'compact' ? '' : postExtrasHtml(t, um, total, ctx.view)
    }<footer class="cardFoot">${metricsHtml(t, local, total, variant)}${actionsHtml(t, um, dls)}</footer>${
      variant === 'compact' || (!detailed && !(um.tags || []).length) ? '' : tagsHtml(t, um, idx)
    }</article>`;
  }

  /* ───────── Mounting ───────── */
  const context = () => ({ view: state.view, variant: state.variant, selected: state.selected() });
  function columns(root) {
    if (state.view === 'timeline') return 1;
    const template = getComputedStyle(root).gridTemplateColumns;
    return Math.max(1, template && template !== 'none' ? template.split(' ').filter(Boolean).length : 1);
  }
  function html(from, to) {
    const ctx = context();
    let out = '';
    for (let index = from; index < to && index < state.rows.length; index++)
      out += cardHtml(state.rows[index], index, ctx);
    return out;
  }
  function spacerElement() {
    let spacer = list()?.querySelector(':scope > .lib5-spacer');
    if (!spacer) {
      spacer = document.createElement('div');
      spacer.className = 'lib5-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      list()?.prepend(spacer);
    }
    return spacer;
  }
  function cards(root = list()) {
    return root ? [...root.children].filter(element => element.classList.contains('tweet')) : [];
  }
  function afterMount(nodes) {
    if (!nodes.length) return;
    if (state.view === 'masonry') sizeMasonry(nodes);
    observeGifs(nodes);
    const root = list();
    if (root) window.XVaultObserveHelperMedia?.(nodes);
    document.dispatchEvent(new CustomEvent('xv:library-mounted', { detail: { cards: nodes } }));
  }
  function appendBlock() {
    const root = list();
    if (!root || state.end >= state.rows.length) return false;
    const to = Math.min(state.rows.length, state.end + state.block);
    const template = document.createElement('template');
    template.innerHTML = html(state.end, to);
    const nodes = [...template.content.children];
    root.querySelector(':scope > .lib5-end')?.before(template.content) || root.append(template.content);
    state.end = to;
    afterMount(nodes);
    return true;
  }
  function unmountTopBlock() {
    const root = list();
    if (!root || state.view === 'masonry') return false;
    const nodes = cards(root).slice(0, state.block);
    if (nodes.length < state.block) return false;
    const first = nodes[0].getBoundingClientRect(),
      next = cards(root)[state.block]?.getBoundingClientRect();
    if (!next) return false;
    const height = next.top - first.top;
    state.heights[state.start / state.block] = height;
    for (const node of nodes) releaseNode(node);
    nodes.forEach(node => node.remove());
    state.start += state.block;
    state.spacer += height;
    spacerElement().style.height = `${state.spacer}px`;
    return true;
  }
  function remountTopBlock() {
    const root = list();
    if (!root || state.start <= 0) return false;
    const blockIndex = state.start / state.block - 1,
      from = blockIndex * state.block,
      height = state.heights[blockIndex] || 0;
    const template = document.createElement('template');
    template.innerHTML = html(from, state.start);
    const nodes = [...template.content.children];
    spacerElement().after(template.content);
    state.start = from;
    state.spacer = Math.max(0, state.spacer - height);
    spacerElement().style.height = `${state.spacer}px`;
    if (!state.start) spacerElement().remove();
    afterMount(nodes);
    return true;
  }
  function releaseNode(node) {
    for (const item of node.querySelectorAll('.mediaItem')) {
      state.gifObserver?.unobserve(item);
      state.playObserver?.unobserve(item);
    }
    for (const video of node.querySelectorAll('video')) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    window.XVaultReleaseHelperMedia?.(node);
  }
  // The visible part of the scroller starts below the sticky Library header — on phones only its last row stays
  // pinned (a negative sticky top), so the covered height is the header height plus that offset.
  function headHeight() {
    const head = $('#libraryHead');
    if (!head) return 0;
    return Math.max(0, head.offsetHeight + Math.min(0, parseFloat(getComputedStyle(head).top) || 0));
  }
  function viewportFacts() {
    const scroll = scroller(),
      root = list();
    if (!scroll || !root) return null;
    const view = scroll.getBoundingClientRect(),
      box = root.getBoundingClientRect(),
      // The part of the scroller the sticky header covers right now (all of it at the top, the pinned rows later).
      headBox = $('#libraryHead')?.getBoundingClientRect(),
      cover = headBox ? Math.max(0, headBox.bottom - view.top) : 0,
      top = view.top + Math.min(cover, view.height / 2);
    return { top, bottom: view.bottom, height: Math.max(1, view.bottom - top) || innerHeight, list: box };
  }
  // Scroll position at which the first post sits just below the sticky header.
  function listTopScroll(root) {
    const scroll = scroller();
    if (!scroll || !root) return 0;
    return Math.max(
      0,
      root.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop - headHeight()
    );
  }
  // Keep the mounted window around the viewport: append toward the end, swap far-above blocks for the spacer,
  // and bring blocks back as the reader scrolls up.
  function settle() {
    state.frame = 0;
    const root = list(),
      facts = viewportFacts();
    if (!root || !facts || !state.rows.length || root.classList.contains('xv-virtual-list')) return;
    let guard = 0;
    while (guard++ < 12) {
      const items = cards(root),
        last = items.at(-1)?.getBoundingClientRect();
      if (!last || last.bottom < facts.bottom + facts.height * 1.5) {
        if (!appendBlock()) break;
      } else break;
    }
    guard = 0;
    while (guard++ < 12 && cards(root).length > state.block * MAX_MOUNTED_BLOCKS) {
      const boundary = cards(root)[state.block]?.getBoundingClientRect();
      if (!boundary || boundary.top > facts.top - facts.height * 2.5) break;
      if (!unmountTopBlock()) break;
    }
    guard = 0;
    while (guard++ < 12 && state.start > 0) {
      const spacer = root.querySelector(':scope > .lib5-spacer')?.getBoundingClientRect();
      if (!spacer || spacer.bottom < facts.top - facts.height * 1.2) break;
      if (!remountTopBlock()) break;
    }
    if (state.end >= state.rows.length) {
      const items = cards(root),
        last = items.at(-1)?.getBoundingClientRect();
      if (last && last.bottom < facts.bottom + facts.height * 1.2) state.nearEnd?.();
    }
  }
  const schedule = () => {
    if (!state.frame) state.frame = requestAnimationFrame(settle);
  };

  function sizeMasonry(nodes) {
    const unit = 4,
      gap = 12;
    for (const node of nodes) {
      const height = node.getBoundingClientRect().height;
      node.style.gridRowEnd = `span ${Math.max(1, Math.ceil((height + gap) / unit))}`;
    }
    if (!state.resizeObserver && 'ResizeObserver' in window)
      state.resizeObserver = new ResizeObserver(entries => {
        if (state.view !== 'masonry') return;
        for (const entry of entries) {
          const height = entry.target.getBoundingClientRect().height;
          entry.target.style.gridRowEnd = `span ${Math.max(1, Math.ceil((height + gap) / unit))}`;
        }
      });
    for (const node of nodes) state.resizeObserver?.observe(node);
  }
  function observeGifs(nodes) {
    if (settings.libraryAutoplayAnimated === false || !('IntersectionObserver' in window)) return;
    state.gifObserver ||= new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          const item = entry.target;
          if (entry.isIntersecting) startInline(item, { loop: true, muted: true, controls: false });
          else item.querySelector('video')?.pause();
        }
      },
      { root: null, rootMargin: '120px 0px' }
    );
    for (const node of nodes)
      for (const item of node.querySelectorAll('.mediaItem.gif[data-src]')) state.gifObserver.observe(item);
  }
  function startInline(item, { loop = false, muted = settings.libraryVideoMuted === true, controls = true } = {}) {
    let video = item.querySelector('video');
    if (video) {
      void video.play?.().catch(() => {});
      return video;
    }
    const src = item.dataset.src;
    if (!src) return null;
    video = document.createElement('video');
    video.src = src;
    video.playsInline = true;
    video.preload = 'auto';
    video.loop = loop;
    video.muted = muted;
    video.controls = controls;
    const poster = item.querySelector('img')?.getAttribute('src');
    if (poster) video.poster = poster;
    video.addEventListener('error', () => item.classList.add('is-missing'), { once: true });
    item.querySelector('img')?.replaceWith(video);
    // Remembered volume / mute (Settings → Library → Video) and the shared volume sync across players.
    if (typeof wireLibraryVideoState === 'function') wireLibraryVideoState(item);
    item.querySelector('.playOverlay')?.remove();
    item.classList.add('is-playing');
    void video.play?.().catch(() => {});
    // Settings → Library → "Pause videos that scroll out of view".
    if (controls && settings.libraryPauseOffscreenVideo !== false && 'IntersectionObserver' in window) {
      state.playObserver ||= new IntersectionObserver(
        entries => {
          for (const entry of entries) if (!entry.isIntersecting) entry.target.querySelector('video')?.pause();
        },
        { root: null, rootMargin: '0px' }
      );
      state.playObserver.observe(item);
    }
    window.XVaultObserveHelperMedia?.([item]);
    return video;
  }

  /* ───────── Rendering ───────── */
  function flipFirst(root) {
    if (reducedMotion()) return null;
    const facts = viewportFacts();
    if (!facts) return null;
    const first = new Map();
    for (const card of cards(root)) {
      const box = card.getBoundingClientRect();
      if (box.bottom < facts.top || box.top > facts.bottom) continue;
      first.set(card.dataset.id, box);
      if (first.size >= 40) break;
    }
    return first;
  }
  function flipPlay(root, first) {
    if (!first?.size) return;
    for (const card of cards(root)) {
      const before = first.get(card.dataset.id);
      if (!before) continue;
      const after = card.getBoundingClientRect();
      if (!after.width || !after.height) continue;
      const dx = before.left - after.left,
        dy = before.top - after.top,
        sx = before.width / after.width,
        sy = before.height / after.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01) continue;
      card.animate(
        [
          { transformOrigin: '0 0', transform: `translate(${dx}px,${dy}px) scale(${sx},${sy})`, opacity: 0.6 },
          { transformOrigin: '0 0', transform: 'none', opacity: 1 },
        ],
        { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' }
      );
    }
  }
  function configure(root, view) {
    state.view = view;
    state.variant = ['compact', 'comfortable', 'media', 'detailed'].includes(settings.libraryCardStyle)
      ? settings.libraryCardStyle
      : 'comfortable';
    root.dataset.view = view;
    root.dataset.card = TILE_LAYOUTS.has(view) ? 'media' : state.variant;
    root.dataset.fit = settings.libraryMediaFit === 'contain' ? 'contain' : 'cover';
    root.dataset.width = ['reading', 'wide', 'full'].includes(settings.libraryFeedWidth)
      ? settings.libraryFeedWidth
      : 'wide';
    root.classList.remove('xv-virtual-list');
    root.onscroll = null;
    if (view !== 'masonry') {
      state.resizeObserver?.disconnect();
      state.resizeObserver = null;
    }
  }
  // Reconcile the mounted cards with fresh rows for the same query: cards whose markup did not change keep
  // their element (and decoded images, playing video, focus); changed cards are replaced in place.
  function patch(root) {
    const ctx = context();
    const existing = new Map(cards(root).map(card => [card.dataset.id, card]));
    const template = document.createElement('template');
    const fresh = [];
    const anchor = root.querySelector(':scope > .lib5-end');
    let cursor = root.querySelector(':scope > .lib5-spacer');
    const focusId = document.activeElement?.closest?.('#list .tweet')?.dataset.id;
    for (let index = state.start; index < state.end && index < state.rows.length; index++) {
      const row = state.rows[index],
        markup = cardHtml(row, index, ctx),
        id = String(row.id);
      let node = existing.get(id);
      if (!node || node.dataset.sig !== String(markup.length) + hash(markup)) {
        template.innerHTML = markup;
        const next = template.content.firstElementChild;
        next.dataset.sig = String(markup.length) + hash(markup);
        if (node) {
          releaseNode(node);
          node.replaceWith(next);
        }
        node = next;
        fresh.push(node);
      }
      existing.delete(id);
      const expected = cursor ? cursor.nextElementSibling : root.firstElementChild;
      if (expected !== node) cursor ? cursor.after(node) : root.prepend(node);
      cursor = node;
    }
    for (const node of existing.values()) {
      releaseNode(node);
      node.remove();
    }
    if (state.end > state.rows.length) state.end = state.rows.length;
    if (anchor && anchor !== root.lastElementChild) root.append(anchor);
    afterMount(fresh);
    if (focusId) root.querySelector(`.tweet[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
  }
  function hash(text) {
    let value = 2166136261;
    for (let index = 0; index < text.length; index += 3) value = Math.imul(value ^ text.charCodeAt(index), 16777619);
    return (value >>> 0).toString(36);
  }
  function stamp(root) {
    for (const card of cards(root)) if (!card.dataset.sig) card.dataset.sig = 'x';
  }

  /**
   * Draw rows into #list.
   * @param {object} options
   * @param {object[]} options.rows     every loaded row of the current window, in order
   * @param {string}   options.key      query identity; the same key re-renders in place
   * @param {string}   options.view     timeline | cards | gallery | masonry
   * @param {Function} options.selected returns the selected-id Set
   * @param {Function} options.nearEnd  called when the reader reaches the last loaded row
   */
  function render({ rows, key, view, selected, nearEnd, anchor = null }) {
    const root = list();
    if (!root) return;
    const scroll = scroller();
    const previousView = state.view,
      sameQuery = key === state.key && root.querySelector(':scope > .tweet'),
      layoutChanged = previousView !== view || state.variant !== settings.libraryCardStyle;
    const first = sameQuery && layoutChanged ? flipFirst(root) : null;
    // Rows shrank below the mounted window (posts trashed elsewhere): start over instead of patching nothing.
    const stale = sameQuery && state.start > 0 && state.start >= rows.length;
    state.selected = selected || state.selected;
    state.nearEnd = nearEnd || null;
    const grown =
      sameQuery &&
      rows.length >= state.rows.length &&
      rows.slice(0, state.rows.length).every((row, i) => String(row.id) === String(state.rows[i]?.id));
    // XVault 26: the reader's place is measured before the new layout's classes apply. Measuring after configure()
    // read the new geometry, so a Cards → Timeline switch anchored on a post far above the one on screen. A switch
    // from List or Table passes the anchor in (`anchor`), because those layouts are not mounted by this feed.
    const remount = !(sameQuery && !layoutChanged && !stale);
    const anchorCard = remount && sameQuery ? firstVisibleCard(root) : null,
      anchorId = anchorCard?.dataset.id || (remount && anchor?.id ? String(anchor.id) : ''),
      // Where the anchor sat under the header: a card that was fully in view stays exactly there (so a switch at
      // the top of the Library does not scroll the header away); one cut off at the top is aligned just below it.
      anchorOffset = anchorCard
        ? anchorCard.getBoundingClientRect().top - viewportFacts().top
        : Number.isFinite(anchor?.offset)
          ? anchor.offset
          : 8;
    state.rows = rows;
    configure(root, view);
    if (!root.querySelector(':scope > .lib5-end')) {
      const end = document.createElement('div');
      end.className = 'lib5-end';
      end.setAttribute('aria-hidden', 'true');
      root.append(end);
    }
    if (!remount) {
      patch(root);
      if (grown) schedule();
    } else {
      for (const node of cards(root)) releaseNode(node);
      state.key = key;
      state.cols = 1;
      state.start = 0;
      state.end = 0;
      state.spacer = 0;
      state.heights = [];
      root.replaceChildren(root.querySelector(':scope > .lib5-end') || document.createElement('div'));
      if (!rows.length) {
        root.insertAdjacentHTML(
          'afterbegin',
          '<div class="empty">No matches. Try removing filters or archive a source first.</div>'
        );
        return;
      }
      // The grid's track count is known before any card exists (auto-fill keeps empty tracks), so blocks are
      // whole rows from the start. A layout switch keeps the reader's place: mounting starts at the block that
      // holds the first visible post and a measured spacer stands in for everything above it.
      state.cols = columns(root);
      state.block = Math.max(state.cols, state.cols * BLOCK_ROWS);
      const anchorIndex = anchorId
          ? Math.max(
              0,
              rows.findIndex(row => String(row.id) === anchorId)
            )
          : 0,
        alignedStart = state.view === 'masonry' ? 0 : Math.floor(anchorIndex / state.block) * state.block;
      state.start = state.end = alignedStart;
      appendBlock();
      if (alignedStart > 0) {
        const mounted = cards(root),
          firstBox = mounted[0]?.getBoundingClientRect(),
          lastBox = mounted.at(-1)?.getBoundingClientRect(),
          estimate = firstBox && lastBox ? Math.max(1, lastBox.bottom - firstBox.top + 12) : 0;
        const blocks = alignedStart / state.block;
        for (let index = 0; index < blocks; index++) state.heights[index] = estimate;
        state.spacer = estimate * blocks;
        spacerElement().style.height = `${state.spacer}px`;
      }
      while (state.end < Math.min(rows.length, anchorIndex + state.block)) if (!appendBlock()) break;
      stamp(root);
      if (anchorId) {
        const target = root.querySelector(`.tweet[data-id="${CSS.escape(anchorId)}"]`);
        if (target && scroll)
          scroll.scrollTop += target.getBoundingClientRect().top - viewportFacts().top - Math.max(8, anchorOffset);
        flipPlay(root, first);
        settle();
      } else {
        // A new query starts at its first post. Nothing is measured while the fresh cards are still unstyled
        // (that would force a synchronous layout of the whole block); the rest of the viewport is filled in the
        // next animation frame, before anything is painted.
        if (!sameQuery && scroll && state.scrolled) scroll.scrollTop = Math.min(scroll.scrollTop, listTopScroll(root));
        flipPlay(root, first);
        schedule();
      }
    }
  }
  function firstVisibleCard(root) {
    const facts = viewportFacts();
    if (!facts) return null;
    return cards(root).find(card => card.getBoundingClientRect().bottom > facts.top + 24) || null;
  }
  // Re-render only the card of one record (favorite toggles, tag edits) without touching its neighbours.
  function refresh(id) {
    const root = list(),
      index = state.rows.findIndex(row => String(row.id) === String(id));
    if (!root || index < state.start || index >= state.end) return;
    const card = root.querySelector(`.tweet[data-id="${CSS.escape(String(id))}"]`);
    if (!card) return;
    const template = document.createElement('template');
    template.innerHTML = cardHtml(state.rows[index], index, context());
    const next = template.content.firstElementChild;
    releaseNode(card);
    card.replaceWith(next);
    afterMount([next]);
  }
  function syncSelection(selected) {
    for (const card of cards()) {
      const on = selected.has(card.dataset.id);
      card.classList.toggle('xv-selected', on);
      const box = card.querySelector('.xv-card-select input');
      if (box && box.checked !== on) box.checked = on;
    }
  }
  // Scroll so a row is mounted and visible (keyboard navigation, "reveal in Library").
  function reveal(id) {
    const index = state.rows.findIndex(row => String(row.id) === String(id));
    if (index < 0) return null;
    let guard = 0;
    while (index >= state.end && guard++ < 200) if (!appendBlock()) break;
    while (index < state.start && guard++ < 400) if (!remountTopBlock()) break;
    const card = list()?.querySelector(`.tweet[data-id="${CSS.escape(String(id))}"]`);
    card?.scrollIntoView({ block: 'nearest' });
    schedule();
    return card;
  }

  /* ───────── Events ───────── */
  const rowAt = element => state.rows[Number(element.closest('[data-idx]')?.dataset.idx)];
  function onClick(event) {
    const target = event.target;
    const button = target.closest('button, a, [data-note-open], [data-select], label.xv-card-select');
    const card = target.closest('.tweet');
    if (!card) return;
    if (!button) {
      // Modifier clicks on a card select without opening anything.
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        event.preventDefault();
        window.XVaultLibrarySelect?.(card.dataset.id, { range: event.shiftKey, toggle: true });
        return;
      }
      const item = target.closest('.mediaItem');
      if (item && !(target.tagName === 'VIDEO' && target.controls)) {
        if (item.classList.contains('is-missing')) return;
        if (item.closest('[data-veiled="true"]')) return;
        openLightbox(state.rows, Number(item.dataset.t), Number(item.dataset.m));
        return;
      }
      if (card.classList.contains('tile') && !target.closest('.tileVeil .tweetActions')) {
        const media = card.querySelector('.mediaItem');
        if (media && !media.classList.contains('is-missing') && !media.closest('[data-veiled="true"]'))
          openLightbox(state.rows, Number(media.dataset.t), Number(media.dataset.m));
        else window.openDetails?.(card.dataset.id);
      }
      return;
    }
    const data = button.dataset;
    if (button.matches('label.xv-card-select') || data.select != null) {
      event.stopPropagation();
      if (event.shiftKey && data.select != null) button.dataset.shiftSelection = '1';
      return;
    }
    if (data.play) {
      event.stopPropagation();
      const item = button.closest('.mediaItem');
      if (item) startInline(item, { controls: true });
      return;
    }
    if (data.reveal != null) {
      event.stopPropagation();
      button.closest('.mediaGrid')?.removeAttribute('data-veiled');
      button.remove();
      return;
    }
    if (data.moreText != null) {
      const text = card.querySelector('.tweetText');
      const open = button.getAttribute('aria-expanded') !== 'true';
      text?.classList.toggle('clamped', !open);
      button.setAttribute('aria-expanded', String(open));
      button.textContent = open ? 'Show less' : 'Show more';
      return;
    }
    if (data.mediaMore != null) {
      event.stopPropagation();
      openLightbox(state.rows, Number(data.mediaMore), 0);
      return;
    }
    if (data.dlOne) {
      event.stopPropagation();
      const [ti, mi] = data.dlOne.split(':').map(Number),
        row = state.rows[ti],
        media = row?.media?.[mi];
      if (row && media) downloadOne(row, media, mi);
      return;
    }
    if (data.downloadPost) {
      event.stopPropagation();
      const row = rowAt(button);
      if (row) downloadPost(row);
      return;
    }
    if (data.fav) return void toggleFavorite(data.fav);
    if (data.quicklook) return void window.XVaultOpenQuickLookById?.(data.quicklook);
    if (data.details) return void window.openDetails?.(data.details);
    if (data.addtag) return void addTag(data.addtag);
    if (data.open) return void chrome.tabs.create({ url: data.open });
    if (data.show) return void call({ type: 'SHOW_DOWNLOAD', downloadId: Number(data.show) });
    if (data.copy != null) {
      void navigator.clipboard.writeText(data.copy).then(
        () => toast('Link copied'),
        () => toast('Copy failed')
      );
      return;
    }
    if (data.tag) {
      window.XVaultLibraryToggleToken
        ? window.XVaultLibraryToggleToken(/\s/.test(data.tag) ? `"tag:${data.tag}"` : `tag:${data.tag}`, '')
        : ((($('#search') || {}).value = `tag:${data.tag}`), renderLib());
      return;
    }
    if (data.expandTags != null) {
      const row = rowAt(button),
        box = button.closest('.tweetTags');
      if (!row || !box) return;
      const open = button.getAttribute('aria-expanded') !== 'true';
      box.querySelectorAll('[data-overflow-tag]').forEach(node => node.remove());
      if (open)
        for (const tag of (row.userMeta?.tags || []).slice(6)) {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.dataset.tag = tag;
          chip.dataset.overflowTag = '';
          chip.textContent = `#${tag}`;
          button.before(chip);
        }
      button.setAttribute('aria-expanded', String(open));
      button.textContent = open ? 'Fewer' : `+${Math.max(0, (row.userMeta?.tags || []).length - 6)}`;
    }
  }
  function onChange(event) {
    const box = event.target.closest?.('input[data-select]');
    if (!box) return;
    const range = box.dataset.shiftSelection === '1';
    box.dataset.shiftSelection = '0';
    window.XVaultLibrarySelect?.(box.dataset.select, { range, checked: box.checked });
  }
  function onError(event) {
    const element = event.target;
    if (!(element instanceof HTMLImageElement || element instanceof HTMLVideoElement)) return;
    if (element.classList.contains('avatar')) {
      const fallback = document.createElement('span');
      fallback.className = 'avatar fallback';
      fallback.setAttribute('aria-hidden', 'true');
      fallback.textContent = element.dataset.monogram || '?';
      if (element.dataset.avatarHandle) fallback.dataset.avatarHandle = element.dataset.avatarHandle;
      element.replaceWith(fallback);
      return;
    }
    if (element.dataset.localConverted && element.dataset.fallback) {
      const fallback = element.dataset.fallback;
      delete element.dataset.localConverted;
      element.src = fallback;
      return;
    }
    const item = element.closest('.mediaItem, .linkCardMedia, .quoteThumb');
    if (!item || item.classList.contains('is-missing')) return;
    item.classList.add('is-missing');
    if (item.classList.contains('mediaItem'))
      item.insertAdjacentHTML(
        'beforeend',
        `<span class="mediaMissing" role="img" aria-label="Media unavailable">${icon('missing') || icon('image')}<span>Not available</span></span>`
      );
  }
  function install() {
    const root = list();
    if (!root || root.dataset.feed) return;
    root.dataset.feed = '5';
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('error', onError, true);
    const scroll = scroller();
    scroll?.addEventListener(
      'scroll',
      () => {
        // Remembered here (layout is clean inside a scroll event) so render() never has to read scrollTop.
        state.scrolled = scroll.scrollTop > 0;
        schedule();
      },
      { passive: true }
    );
    addEventListener('resize', () => {
      const node = list();
      if (!node || node.classList.contains('xv-virtual-list') || !state.rows.length) return;
      const cols = columns(node);
      if (cols !== state.cols && state.start > 0) {
        state.key = '';
        renderLib(true);
      } else schedule();
    });
  }
  window.XVaultLibraryFeed = {
    render,
    refresh,
    reveal,
    syncSelection,
    schedule,
    cardHtml: (row, index = 0, view = 'cards') =>
      cardHtml(row, index, { view, variant: 'comfortable', selected: new Set() }),
    mounted: () => ({
      start: state.start,
      end: state.end,
      rows: state.rows.length,
      block: state.block,
      cols: state.cols,
    }),
    rows: () => state.rows,
    reset: () => {
      state.key = '';
    },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
