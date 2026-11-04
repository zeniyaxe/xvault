/* XVault Atlas — the archive as a place to look around: growth, rhythm, people, a calendar and a
   duplicate lab. Statistics come from one service-worker pass (GET_VAULT_INSIGHTS). The look-alike
   scan fingerprints small thumbnails in this tab and keeps the fingerprints in a local IndexedDB. */
(() => {
  const DAY = 86400000;
  const VIEWS = [
    ['overview', 'Overview'],
    ['calendar', 'Calendar'],
    ['people', 'People'],
    ['duplicates', 'Duplicates'],
  ];
  const store = {
    get(key, fallback) {
      try {
        return localStorage.getItem(key) ?? fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {}
    },
  };
  const savedView = store.get('xv-atlas-view', 'overview');
  const state = {
    view: VIEWS.some(([key]) => key === savedView) ? savedView : 'overview',
    data: null,
    loadedAt: 0,
    stale: true,
    pending: null,
    rendered: '',
    growth: 'archived',
    growthChosen: false,
    calField: 'archived',
    calYear: '',
    calDay: '',
    peopleQuery: '',
    peopleSort: 'count',
    peopleLimit: 60,
  };
  let root = null,
    growthModel = null,
    resizeWatch = null,
    refreshTimer = 0,
    peopleTimer = 0,
    sheet = null,
    sheetToken = 0;

  const html = value => esc(value);
  const count = value => fmt(Number(value) || 0);
  const short = value =>
    new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) || 0);
  const plural = (value, word, many = `${word}s`) => `${count(value)} ${Number(value) === 1 ? word : many}`;
  const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
  const isoDay = stamp => new Date(stamp).toISOString().slice(0, 10);
  const dayText = (key, options = { dateStyle: 'medium' }) =>
    new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', ...options });
  const monthText = (key, month = 'short') =>
    new Date(`${key}-01T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month, year: 'numeric' });
  const dateText = stamp => (stamp ? new Date(stamp).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Date(Date.UTC(2024, 0, 1 + index)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })
  );
  const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  function relative(stamp) {
    if (!stamp) return '';
    const seconds = (Number(stamp) - Date.now()) / 1000;
    for (const [unit, size] of [
      ['year', 31536000],
      ['month', 2592000],
      ['week', 604800],
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60],
    ])
      if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
    return 'just now';
  }
  const languageNames = (() => {
    let names = null;
    try {
      names = new Intl.DisplayNames(undefined, { type: 'language' });
    } catch {}
    const special = {
      und: 'Undetermined',
      zxx: 'No text',
      qme: 'Media only',
      qht: 'Hashtags only',
      qam: 'Mentions only',
      qst: 'Very short',
      art: 'Emoji and symbols',
    };
    return code => {
      if (special[code]) return special[code];
      try {
        return names?.of(code) || code;
      } catch {
        return code;
      }
    };
  })();
  // Smaller pbs.twimg.com renditions for thumbnails; other hosts are left alone.
  function cdn(url, size = 'small') {
    try {
      const target = new URL(url);
      if (target.protocol !== 'https:') return '';
      if (target.hostname === 'pbs.twimg.com' && target.pathname.startsWith('/media/')) {
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
  const avatar = (url, name, className = 'xa-avatar') =>
    url
      ? `<img class="${className}" src="${html(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="${className} is-empty" aria-hidden="true">${html(
          String(name || '?')
            .slice(0, 1)
            .toUpperCase()
        )}</span>`;
  const body = () => root?.querySelector('#xaBody');
  const shown = () => !!root?.classList.contains('show');
  const openLibrary = query => {
    if (window.XVaultOpenLibrarySearch) return window.XVaultOpenLibrarySearch(query);
    page('library');
    const input = document.querySelector('#search');
    if (input) {
      input.value = query;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  /* ───────── Frame and data ───────── */
  function frame() {
    root = document.querySelector('#page-atlas');
    if (!root) return null;
    if (root.dataset.ready) return root;
    root.dataset.ready = '1';
    root.innerHTML = `<header class="xa-head">
  <div class="xa-title"><h1>Atlas</h1><p id="xaSummary">Reading your archive…</p></div>
  <div class="xa-head-actions">
    <div class="seg" role="radiogroup" aria-label="Atlas view">${VIEWS.map(([key, label]) => `<button type="button" role="radio" data-view="${key}" aria-checked="false">${label}</button>`).join('')}</div>
    <button type="button" class="quiet" id="xaRefresh" data-act="recount" title="Count the archive again">Recount</button>
  </div>
</header>
<div id="xaBody" class="xa-body"></div>`;
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('input', onInput);
    root.addEventListener('focusin', onFocus);
    root.addEventListener('pointerover', onHover);
    root.addEventListener(
      'error',
      event => {
        if (event.target?.tagName === 'IMG') event.target.classList.add('is-broken');
      },
      true
    );
    resizeWatch = new ResizeObserver(() => {
      if (!shown() || state.view !== 'overview') return;
      cancelAnimationFrame(resizeWatch.frame);
      resizeWatch.frame = requestAnimationFrame(() => drawGrowth(false));
    });
    resizeWatch.observe(root);
    return root;
  }

  function paintTabs() {
    for (const button of root.querySelectorAll('[data-view]'))
      button.setAttribute('aria-checked', String(button.dataset.view === state.view));
  }

  function summary() {
    const data = state.data,
      line = root?.querySelector('#xaSummary');
    if (!line || !data) return;
    line.textContent = data.total
      ? `${count(data.total)} posts from ${count(data.authorsTotal)} people · archiving since ${dateText(data.range?.firstArchived)} · ${state.refreshing ? 'updating in the background…' : `counted locally in ${count(data.computeMs || 0)} ms`} · days in ${data.timeZone === 'utc' ? 'UTC' : 'local time'}`
      : 'Nothing archived yet';
  }

  function skeleton() {
    body().innerHTML = `<div class="xa-loading" aria-busy="true"><div class="xa-kpis">${'<div class="xa-kpi"><i class="xv-skeleton"></i><i class="xv-skeleton"></i></div>'.repeat(5)}</div><i class="xv-skeleton xa-skel-chart"></i></div>`;
  }

  function load(force = false, { quiet = false } = {}) {
    if (state.pending) return state.pending;
    const button = root.querySelector('#xaRefresh');
    if (button) button.disabled = true;
    state.pending = (async () => {
      try {
        const result = await call({ type: 'GET_VAULT_INSIGHTS', force });
        if (!result?.ok || !result.insights) throw Error(result?.error || 'The archive could not be read.');
        const first = !state.data;
        state.data = result.insights;
        state.loadedAt = Date.now();
        // A stale result is last session's numbers; fresh ones arrive via 'xvault-insights'.
        state.stale = !!result.insights.stale;
        state.refreshing = !!result.insights.stale;
        summary();
        if (!shown()) state.rendered = '';
        else if (!quiet || state.view === 'overview' || state.view === 'calendar') {
          const day = document.activeElement?.closest?.('.xa-cal-grid .xa-day')?.dataset.day;
          render({ animate: first || force });
          if (day) root.querySelector(`.xa-cal-grid .xa-day[data-day="${day}"]`)?.focus({ preventScroll: true });
        }
        return state.data;
      } catch (error) {
        if (!state.data)
          body().innerHTML = `<div class="empty">Atlas could not read the archive. ${html(error?.message || '')}<button type="button" data-act="recount">Try again</button></div>`;
        else toast('Atlas could not refresh');
        return state.data;
      } finally {
        state.pending = null;
        if (button) button.disabled = false;
      }
    })();
    return state.pending;
  }

  async function show(force = false) {
    if (!frame()) return;
    paintTabs();
    if (!state.data) skeleton();
    else if (state.rendered !== state.view) render({ animate: false });
    if (force || state.stale || !state.data || Date.now() - state.loadedAt > 5 * 60000) await load(force);
  }

  function setView(next) {
    if (!VIEWS.some(([key]) => key === next)) return;
    const previous = VIEWS.findIndex(([key]) => key === state.view);
    state.view = next;
    store.set('xv-atlas-view', next);
    paintTabs();
    if (!state.data) return;
    const update = () => render({ animate: false });
    const direction = VIEWS.findIndex(([key]) => key === next) - previous;
    if (window.XVaultMotion?.transition) window.XVaultMotion.transition(update, { direction });
    else update();
  }

  // On narrow screens the year scrolls sideways; bring the selected day into view.
  function revealDay(target) {
    const scroller = target.querySelector('.xa-cal-scroll'),
      day = scroller?.querySelector('[aria-current="date"]');
    if (!scroller || !day || scroller.scrollWidth <= scroller.clientWidth) return;
    const offset = day.getBoundingClientRect().left - scroller.getBoundingClientRect().left;
    scroller.scrollLeft += offset - scroller.clientWidth / 2;
  }

  function render({ animate = false } = {}) {
    const target = body(),
      data = state.data;
    if (!target || !data) return;
    growthModel = null;
    if (!data.total) {
      target.innerHTML = `<div class="empty xa-empty"><h2>Your Atlas fills in as you archive</h2><p>Archive bookmarks, likes or a profile and this page maps who you keep, when you keep it and what repeats.</p><button type="button" class="primary" data-page-go="home">Start capturing</button></div>`;
      state.rendered = state.view;
      return;
    }
    target.innerHTML = { overview, calendar, people, duplicates }[state.view](data);
    state.rendered = state.view;
    if (state.view === 'overview') {
      drawGrowth(animate);
      if (animate)
        for (const element of target.querySelectorAll('[data-count]'))
          window.XVaultMotion?.countUp(element, Number(element.dataset.count), { from: 0 });
      window.XVaultMotion?.stagger(target.querySelectorAll('.xa-kpi,.xa-section'), 'rise', { step: 26, max: 14 });
    }
    if (state.view === 'calendar') {
      paintDay(state.calDay);
      revealDay(target);
    }
    if (state.view === 'people') paintPeople();
    if (state.view === 'duplicates') {
      hydrateShared();
      paintLab();
    }
  }

  /* ───────── Overview ───────── */
  // "Today" in the same calendar the statistics were bucketed in (local time or UTC).
  function todayKey() {
    if (state.data?.timeZone === 'utc') return isoDay(Date.now());
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
  function recent(days, span) {
    const today = Date.parse(`${todayKey()}T00:00:00Z`);
    let total = 0;
    for (let offset = 0; offset < span; offset++) total += days?.[isoDay(today - offset * DAY)] || 0;
    return total;
  }
  const kpi = (label, value, note) =>
    `<div class="xa-kpi"><span>${html(label)}</span><strong data-count="${Number(value) || 0}">${count(value)}</strong><small>${html(note)}</small></div>`;

  function bars(items, { query, label = item => item.key, empty = 'Nothing yet.' } = {}) {
    if (!items?.length) return `<p class="xa-quiet">${html(empty)}</p>`;
    const max = Math.max(1, ...items.map(item => item.count));
    return `<ol class="xa-bars">${items
      .map(item => {
        const tag = query ? 'button' : 'div',
          attrs = query ? ` type="button" data-q="${html(query(item))}"` : '';
        return `<li><${tag} class="xa-barrow"${attrs}><span class="xa-bar-label">${html(label(item))}</span><span class="xa-bar-track"><i style="--w:${(item.count / max).toFixed(4)}"></i></span><b>${count(item.count)}</b></${tag}></li>`;
      })
      .join('')}</ol>`;
  }

  function chips(items, query, prefix = '') {
    if (!items?.length) return '<p class="xa-quiet">Nothing yet.</p>';
    const max = Math.sqrt(Math.max(1, ...items.map(item => item.count)));
    return `<div class="xa-cloud">${items
      .map(
        item =>
          `<button type="button" class="xa-chip" style="--s:${(Math.sqrt(item.count) / max).toFixed(3)}" data-q="${html(query(item))}" title="${count(item.count)} posts">${html(prefix + item.key)}<small>${short(item.count)}</small></button>`
      )
      .join('')}</div>`;
  }

  function postCard(post, label) {
    const visual = post.preview
      ? `<img src="${html(post.preview)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="xa-card-text">${html(post.text.slice(0, 170) || 'Media post')}</span>`;
    return `<button type="button" class="xa-card${post.preview ? '' : ' is-text'}" data-read="${html(post.id)}" title="Read in the Reader">${visual}<span class="xa-card-meta"><b>@${html(post.handle)}</b><small>${html(label)}</small></span></button>`;
  }

  function donut(media) {
    const parts = [
      ['photo', 'Images', 'has:image'],
      ['video', 'Videos', 'has:video'],
      ['gif', 'GIFs', 'has:gif'],
      ['other', 'Other', ''],
    ]
      .map(([key, label, query]) => ({ key, label, query, value: Number(media?.[key] || 0) }))
      .filter(part => part.value);
    const total = parts.reduce((sum, part) => sum + part.value, 0);
    let offset = 0;
    const rings = parts
      .map(part => {
        const share = total ? (part.value / total) * 100 : 0,
          gap = parts.length > 1 ? Math.min(0.8, share / 3) : 0;
        const ring = `<circle class="xa-ring is-${part.key}" r="15.9155" cx="18" cy="18" pathLength="100" stroke-dasharray="${Math.max(0, share - gap).toFixed(3)} ${(100 - share + gap).toFixed(3)}" stroke-dashoffset="${(-offset).toFixed(3)}"/>`;
        offset += share;
        return ring;
      })
      .join('');
    return `<div class="xa-donut">
<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="xa-ring-track" r="15.9155" cx="18" cy="18"/><g transform="rotate(-90 18 18)">${rings}</g></svg>
<div class="xa-donut-label"><strong>${short(total)}</strong><small>files</small></div>
</div>
<ul class="xa-legend">${parts
      .map(
        part =>
          `<li>${part.query ? `<button type="button" data-q="${part.query}">` : '<div>'}<i class="xa-swatch is-${part.key}"></i><span>${part.label}</span><b>${count(part.value)}</b><small>${percent(part.value, total)}%</small>${part.query ? '</button>' : '</div>'}</li>`
      )
      .join('')}
<li class="xa-legend-note">${count(media?.postsWithMedia)} posts with media · ${count(media?.textOnly)} text only</li></ul>`;
  }

  function rhythm(grid) {
    const order = [1, 2, 3, 4, 5, 6, 0],
      values = (grid || []).flat(),
      max = Math.max(0, ...values);
    if (!max) return '<p class="xa-quiet">Posting times appear once posts with dates are archived.</p>';
    let peak = { row: 0, hour: 0, value: -1 };
    const rows = order
      .map((day, row) => {
        const cells = (grid[day] || [])
          .map((value, hour) => {
            if (value > peak.value) peak = { row, hour, value };
            return `<i style="--v:${Math.sqrt(value / max).toFixed(3)}" title="${html(weekdays[row])} ${String(hour).padStart(2, '0')}:00 · ${count(value)} posts"></i>`;
          })
          .join('');
        return `<div class="xa-rhythm-row"><span>${html(weekdays[row])}</span>${cells}</div>`;
      })
      .join('');
    return `<div class="xa-rhythm" role="img" aria-label="Posting times by weekday and hour. Busiest: ${html(weekdays[peak.row])} at ${peak.hour}:00.">${rows}<div class="xa-rhythm-hours" aria-hidden="true"><span></span>${[0, 6, 12, 18].map(hour => `<b style="grid-column:${hour + 2}">${String(hour).padStart(2, '0')}</b>`).join('')}</div></div>
<p class="xa-note">Busiest: ${html(weekdays[peak.row])} around ${String(peak.hour).padStart(2, '0')}:00, in your time zone.</p>`;
  }

  function peopleRows(authors) {
    if (!authors.length) return '<p class="xa-quiet">No authors yet.</p>';
    const max = Math.max(1, ...authors.map(author => author.count));
    return `<ol class="xa-rank">${authors
      .map(
        author =>
          `<li><button type="button" class="xa-rank-row" data-person="${html(author.handle)}" data-raw="${html(author.raw || author.handle)}">${avatar(author.avatar, author.name || author.handle)}<span class="xa-rank-name"><b>${html(author.name || author.raw || author.handle)}</b><small>@${html(author.raw || author.handle)}</small></span><span class="xa-bar-track"><i style="--w:${(author.count / max).toFixed(4)}"></i></span><b>${count(author.count)}</b></button></li>`
      )
      .join('')}</ol>`;
  }

  function overview(data) {
    const archived = data.days?.archived || {},
      streak = data.streaks?.archived || { current: 0, longest: 0, activeDays: Object.keys(archived).length },
      week = recent(archived, 7),
      regulars = data.authors.filter(author => author.count >= 5).length,
      relation = data.relationships || {},
      personal = data.personal || {},
      usage = data.storage?.usage;
    const relationRows = [
      { key: 'Replies', count: relation.replies || 0, q: 'is:reply' },
      { key: 'Quotes', count: relation.quotes || 0, q: 'is:quote' },
      { key: 'Reposts', count: relation.reposts || 0, q: 'is:repost' },
      { key: 'Self-threads', count: relation.selfThreads || 0, q: 'is:thread' },
    ].filter(row => row.count);
    const personalRows = [
      { key: 'Favorites', count: personal.favorites || 0, q: 'fav:true' },
      { key: 'Tagged', count: personal.tagged || 0, q: 'has:tag' },
      { key: 'With notes', count: personal.notes || 0, q: 'has:note' },
      { key: 'Reviewed', count: personal.reviewed || 0, q: 'inbox:false' },
      { key: 'Sensitive', count: data.sensitive || 0, q: 'rating:sensitive' },
    ].filter(row => row.count);
    const thisYear = new Date().getFullYear();
    if (
      !state.growthChosen &&
      state.growth === 'archived' &&
      growthSeries('archived').series.length < 2 &&
      growthSeries('posted').series.length > 1
    )
      state.growth = 'posted';
    return `<section class="xa-kpis" aria-label="Archive totals">
${kpi('Posts', data.total, week ? `+${count(week)} in the last 7 days` : 'Nothing new in the last 7 days')}
${kpi('People', data.authorsTotal, `${count(regulars)} with five or more posts`)}
${kpi('Media files', data.media?.items, `${percent(data.media?.postsWithMedia, data.total)}% of posts carry media`)}
${kpi('Active days', streak.activeDays, streak.current > 1 ? `${count(streak.current)}-day streak running` : `Longest streak ${count(streak.longest)} ${streak.longest === 1 ? 'day' : 'days'}`)}
<div class="xa-kpi"><span>On this computer</span><strong>${html(bytes(usage))}</strong><small>${data.storage?.quota ? `${Math.max(usage ? 1 : 0, percent(usage, data.storage.quota))}% of the space the browser allows` : 'Browser storage'}</small></div>
</section>
<section class="xa-section xa-growth">
  <header class="xa-section-head"><h2>Growth</h2><div class="seg" role="radiogroup" aria-label="Growth measure"><button type="button" role="radio" data-growth="archived" aria-checked="${state.growth === 'archived'}">Archive size</button><button type="button" role="radio" data-growth="posted" aria-checked="${state.growth === 'posted'}">When posts were written</button></div></header>
  <div class="xa-chart" id="xaGrowth"></div>
</section>
<div class="xa-split">
  <section class="xa-section"><header class="xa-section-head"><h2>Media mix</h2></header><div class="xa-media-mix">${donut(data.media)}</div></section>
  <section class="xa-section"><header class="xa-section-head"><h2>When they post</h2></header>${rhythm(data.rhythm)}</section>
</div>
<div class="xa-split">
  <section class="xa-section"><header class="xa-section-head"><h2>People you keep</h2><button type="button" class="quiet" data-view="people">All ${count(data.authorsTotal)} →</button></header>${peopleRows(data.authors.slice(0, 8))}</section>
  <section class="xa-section"><header class="xa-section-head"><h2>Conversations</h2></header>${bars(relationRows, { query: row => row.q, empty: 'No replies, quotes or reposts recorded yet.' })}<p class="xa-note">${plural(relation.conversations, 'conversation')} · ${plural(data.total - (relation.replies || 0) - (relation.reposts || 0), 'standalone post')}</p></section>
</div>
<div class="xa-split is-three">
  <section class="xa-section"><header class="xa-section-head"><h2>Where posts came from</h2></header>${bars(data.sources?.slice(0, 8), { query: item => `source:${item.key}`, label: item => item.key.replace(/-/g, ' ') })}</section>
  <section class="xa-section"><header class="xa-section-head"><h2>Languages</h2></header>${bars(data.languages?.slice(0, 8), { query: item => `lang:${item.key}`, label: item => languageNames(item.key) })}</section>
  <section class="xa-section"><header class="xa-section-head"><h2>Your layer</h2></header>${bars(personalRows, { query: row => row.q, empty: 'Favorites, tags and notes you add show up here.' })}</section>
</div>
<section class="xa-section"><header class="xa-section-head"><h2>Hashtags</h2></header>${chips(data.hashtags?.slice(0, 48), item => `#${item.key}`, '#')}</section>
<div class="xa-split">
  <section class="xa-section"><header class="xa-section-head"><h2>Linked sites</h2></header>${bars(data.domains?.slice(0, 10), { query: item => `domain:${item.key}`, empty: 'No outbound links recorded yet.' })}</section>
  <section class="xa-section"><header class="xa-section-head"><h2>Mentioned most</h2></header>${bars(data.mentions?.slice(0, 10), { query: item => `@${item.key}`, label: item => `@${item.key}`, empty: 'No mentions recorded yet.' })}</section>
</div>
${data.tags?.length ? `<section class="xa-section"><header class="xa-section-head"><h2>Your tags</h2></header>${chips(data.tags.slice(0, 40), item => `tag:${item.key}`)}</section>` : ''}
${data.onThisDay?.length ? `<section class="xa-section"><header class="xa-section-head"><h2>On this day</h2><small>${html(new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric' }))} in earlier years</small></header><div class="xa-strip">${data.onThisDay.map(post => postCard(post, `${thisYear - new Date(post.createdAt).getFullYear()} ${thisYear - new Date(post.createdAt).getFullYear() === 1 ? 'year' : 'years'} ago`)).join('')}</div></section>` : ''}
${data.topLiked?.length ? `<section class="xa-section"><header class="xa-section-head"><h2>Most liked in your archive</h2></header><div class="xa-strip">${data.topLiked.map(post => postCard(post, `${short(post.likes)} likes`)).join('')}</div></section>` : ''}
<p class="xa-foot">Counted from ${count(data.total)} archived posts on this computer${data.cached ? ' · reused the last count because nothing changed' : ''}. Dates in the calendar use UTC, matching Library date filters.</p>`;
  }

  const monthIndex = key => {
    const [year, month] = key.split('-').map(Number);
    return year * 12 + month - 1;
  };
  // Short archives read better by day; everything else by month. Gaps are filled with zeros.
  function growthSeries(field = state.growth) {
    const months = state.data?.months?.[field] || {},
      keys = Object.keys(months)
        .filter(key => key >= '2006-01')
        .sort();
    if (!keys.length) return { series: [], unit: 'month' };
    const series = [];
    let total = 0;
    if (field === 'archived' && monthIndex(keys.at(-1)) - monthIndex(keys[0]) < 2) {
      const days = state.data?.days?.archived || {},
        dayKeys = Object.keys(days).sort();
      const first = Date.parse(`${dayKeys[0]}T00:00:00Z`),
        last = Date.parse(`${dayKeys.at(-1)}T00:00:00Z`);
      for (let stamp = first; stamp <= last && series.length < 120; stamp += DAY) {
        const key = isoDay(stamp),
          value = days[key] || 0;
        total += value;
        series.push({ key, value, total });
      }
      return { series, unit: 'day' };
    }
    for (let index = monthIndex(keys[0]); index <= monthIndex(keys.at(-1)) && series.length < 1200; index++) {
      const key = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`,
        value = months[key] || 0;
      total += value;
      series.push({ key, value, total });
    }
    return { series, unit: 'month' };
  }

  function drawGrowth(animate) {
    const host = root?.querySelector('#xaGrowth');
    if (!host) return;
    const { series, unit } = growthSeries(),
      cumulative = state.growth === 'archived',
      daily = unit === 'day';
    const label = (key, month = 'short') =>
      daily ? dayText(key, { month, day: 'numeric', year: 'numeric' }) : monthText(key, month);
    if (series.length < 2) {
      growthModel = null;
      host.innerHTML = `<p class="xa-quiet">${cumulative ? 'Growth draws once your archive spans more than one day.' : 'This chart draws once posts span more than one month.'}</p>`;
      return;
    }
    const width = Math.max(320, Math.round(host.clientWidth || 720)),
      height = 210,
      pad = { top: 16, right: 10, bottom: 24, left: 10 };
    const values = series.map(point => (cumulative ? point.total : point.value)),
      max = Math.max(1, ...values),
      plotWidth = width - pad.left - pad.right,
      slot = plotWidth / series.length;
    const x = index =>
      cumulative ? pad.left + (index / (series.length - 1)) * plotWidth : pad.left + slot * (index + 0.5);
    const y = value => pad.top + (1 - value / max) * (height - pad.top - pad.bottom);
    let shapes;
    if (cumulative) {
      const line = values
        .map((value, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`)
        .join('');
      shapes = `<path class="xa-area" d="${line}L${x(values.length - 1).toFixed(1)},${height - pad.bottom}L${x(0).toFixed(1)},${height - pad.bottom}Z"/><path class="xa-line${animate ? ' is-drawing' : ''}" d="${line}" pathLength="1"/>`;
    } else {
      const bar = Math.max(1, Math.min(18, slot * 0.7));
      shapes = values
        .map(
          (value, index) =>
            `<rect class="xa-bar${animate ? ' is-growing' : ''}" style="--i:${Math.min(index, 80)}" x="${(x(index) - bar / 2).toFixed(1)}" y="${y(value).toFixed(1)}" width="${bar.toFixed(1)}" height="${Math.max(0, height - pad.bottom - y(value)).toFixed(1)}" rx="1.5"/>`
        )
        .join('');
    }
    const ticks = [];
    let lastTick = -Infinity;
    const monthly = !daily && series.length <= 18;
    series.forEach((point, index) => {
      const january = point.key.endsWith('-01');
      if (!daily && !monthly && index && !january) return;
      const px = x(index);
      if (px - lastTick < (daily ? 64 : monthly ? 34 : 44)) return;
      lastTick = px;
      const text = daily
        ? dayText(point.key, { month: 'short', day: 'numeric' })
        : monthly
          ? new Date(`${point.key}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })
          : point.key.slice(0, 4);
      ticks.push(
        `<text x="${px.toFixed(1)}" y="${height - 7}" text-anchor="${index ? 'middle' : 'start'}">${html(text)}</text>`
      );
    });
    const grid = [0.5, 1]
      .map(
        fraction =>
          `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(max * fraction).toFixed(1)}" y2="${y(max * fraction).toFixed(1)}"/><text x="${pad.left + 2}" y="${(y(max * fraction) - 5).toFixed(1)}">${html(short(max * fraction))}</text>`
      )
      .join('');
    const first = series[0],
      last = series.at(-1);
    host.setAttribute('role', 'img');
    host.setAttribute(
      'aria-label',
      cumulative
        ? `Archive grew to ${count(last.total)} posts between ${label(first.key)} and ${label(last.key)}.`
        : `Posts by the month they were written, ${label(first.key)} to ${label(last.key)}. Busiest month has ${count(max)} posts.`
    );
    host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><g class="xa-grid">${grid}</g>${shapes}<g class="xa-ticks">${ticks.join('')}</g><circle class="xa-dot" r="4" cx="-10" cy="-10"/></svg><div class="xa-guide" hidden></div><div class="xa-tip" hidden></div>`;
    growthModel = { series, values, cumulative, daily, label, x, y, width, slot, pad };
    host.onpointermove = event => hoverGrowth(host, event);
    host.onpointerleave = () => {
      host.querySelector('.xa-guide').hidden = true;
      host.querySelector('.xa-tip').hidden = true;
      host.querySelector('.xa-dot').setAttribute('cx', '-10');
    };
    host.onclick = () => {
      const point = growthModel?.series[growthModel.hover];
      if (!point) return;
      if (growthModel.daily) return openLibrary(`archived-on:${point.key}`);
      const [year, month] = point.key.split('-').map(Number),
        next = month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, '0')}`,
        prefix = cumulative ? 'archived-' : '';
      openLibrary(`${prefix}after:${point.key}-01 ${prefix}before:${next}-01`);
    };
  }

  function hoverGrowth(host, event) {
    const model = growthModel;
    if (!model) return;
    const box = host.getBoundingClientRect(),
      px = ((event.clientX - box.left) / box.width) * model.width;
    const index = Math.max(
      0,
      Math.min(
        model.series.length - 1,
        model.cumulative
          ? Math.round(
              ((px - model.pad.left) / (model.width - model.pad.left - model.pad.right)) * (model.series.length - 1)
            )
          : Math.floor((px - model.pad.left) / model.slot)
      )
    );
    model.hover = index;
    const point = model.series[index],
      cx = model.x(index),
      cy = model.y(model.values[index]);
    const guide = host.querySelector('.xa-guide'),
      tip = host.querySelector('.xa-tip'),
      dot = host.querySelector('.xa-dot');
    guide.hidden = false;
    guide.style.left = `${(cx / model.width) * 100}%`;
    dot.setAttribute('cx', cx.toFixed(1));
    dot.setAttribute('cy', cy.toFixed(1));
    tip.hidden = false;
    const when = html(model.label(point.key, 'long')),
      hint = `<small>Click to see that ${model.daily ? 'day' : 'month'}</small>`;
    tip.innerHTML = model.cumulative
      ? `<b>${when}</b><span>+${count(point.value)} archived · ${count(point.total)} total</span>${hint}`
      : `<b>${when}</b><span>${count(point.value)} ${point.value === 1 ? 'post' : 'posts'} written</span>${hint}`;
    const left = Math.max(0, Math.min(box.width - tip.offsetWidth, (cx / model.width) * box.width + 12));
    tip.style.left = `${left}px`;
  }

  /* ───────── Calendar ───────── */
  function quantiles(values) {
    const sorted = values.filter(value => value > 0).sort((a, b) => a - b);
    const at = fraction => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] || 0;
    return [at(0.25), at(0.5), at(0.75), at(0.92)];
  }

  function calendar(data) {
    const field = state.calField,
      days = data.days?.[field] || {};
    const years = [...new Set(Object.keys(days).map(key => key.slice(0, 4)))].filter(year => year >= '2006').sort();
    const zone = data.timeZone === 'utc' ? 'utc' : 'local';
    const toggle = `<div class="seg" role="radiogroup" aria-label="Calendar dates"><button type="button" role="radio" data-cal-field="archived" aria-checked="${field === 'archived'}">Archived</button><button type="button" role="radio" data-cal-field="posted" aria-checked="${field === 'posted'}">Posted</button></div><div class="seg" role="radiogroup" aria-label="Calendar days in"><button type="button" role="radio" data-cal-zone="local" aria-checked="${zone === 'local'}" title="Days and streaks follow this computer's time zone">Local</button><button type="button" role="radio" data-cal-zone="utc" aria-checked="${zone === 'utc'}" title="Days and streaks follow UTC">UTC</button></div>`;
    if (!years.length)
      return `<section class="xa-section"><header class="xa-section-head"><h2>Calendar</h2>${toggle}</header><p class="xa-quiet">No dated posts yet.</p></section>`;
    if (!years.includes(state.calYear)) state.calYear = years.at(-1);
    const year = Number(state.calYear),
      start = Date.UTC(year, 0, 1),
      end = Date.UTC(year, 11, 31);
    const lead = (new Date(start).getUTCDay() + 6) % 7,
      gridStart = start - lead * DAY,
      weeks = Math.ceil((lead + (end - start) / DAY + 1) / 7);
    const yearKeys = Object.keys(days).filter(key => key.startsWith(`${state.calYear}-`) && days[key] > 0);
    const levels = quantiles(yearKeys.map(key => days[key]));
    const level = value =>
      value <= 0
        ? 0
        : value <= levels[0]
          ? 1
          : value <= levels[1]
            ? 2
            : value <= levels[2]
              ? 3
              : value <= levels[3]
                ? 4
                : 5;
    const yearTotal = yearKeys.reduce((sum, key) => sum + days[key], 0);
    const busiest = yearKeys.reduce((best, key) => (days[key] > (days[best] || 0) ? key : best), '');
    if (!state.calDay || !state.calDay.startsWith(`${state.calYear}-`))
      state.calDay = busiest || `${state.calYear}-01-01`;
    const verb = field === 'archived' ? 'archived' : 'posted';
    const cells = [];
    for (let index = 0; index < weeks * 7; index++) {
      const stamp = gridStart + index * DAY;
      if (stamp < start || stamp > end) {
        cells.push('<span class="xa-day is-out" aria-hidden="true"></span>');
        continue;
      }
      const key = isoDay(stamp),
        value = days[key] || 0;
      cells.push(
        `<button type="button" class="xa-day" data-day="${key}" data-level="${level(value)}" tabindex="${key === state.calDay ? 0 : -1}" aria-label="${html(dayText(key, { dateStyle: 'full' }))}: ${count(value)} ${verb}"${key === state.calDay ? ' aria-current="date"' : ''}></button>`
      );
    }
    const monthLabels = Array.from({ length: 12 }, (_, month) => {
      const week = Math.floor((Date.UTC(year, month, 1) - gridStart) / DAY / 7);
      return `<span style="grid-column:${week + 1}">${html(new Date(Date.UTC(year, month, 1)).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }))}</span>`;
    }).join('');
    const months = data.months?.[field] || {},
      monthValues = Array.from(
        { length: 12 },
        (_, month) => months[`${state.calYear}-${String(month + 1).padStart(2, '0')}`] || 0
      ),
      monthMax = Math.max(1, ...monthValues);
    const prefix = field === 'archived' ? 'archived-' : '';
    const monthBars = monthValues
      .map((value, month) => {
        const from = `${state.calYear}-${String(month + 1).padStart(2, '0')}-01`,
          to = month === 11 ? `${year + 1}-01-01` : `${state.calYear}-${String(month + 2).padStart(2, '0')}-01`;
        return `<button type="button" class="xa-month" data-q="${prefix}after:${from} ${prefix}before:${to}" title="${html(monthText(from.slice(0, 7), 'long'))}: ${count(value)} ${verb}" ${value ? '' : 'disabled'}><i style="--h:${(value / monthMax).toFixed(4)}"></i><span>${html(new Date(Date.UTC(year, month, 1)).toLocaleDateString(undefined, { month: 'narrow', timeZone: 'UTC' }))}</span></button>`;
      })
      .join('');
    const streak = data.streaks?.[field] || { longest: 0, current: 0, activeDays: 0, longestEnd: '' };
    const index = years.indexOf(state.calYear);
    return `<section class="xa-section xa-calendar">
<header class="xa-section-head"><h2>Calendar</h2>${toggle}
  <div class="xa-year" role="group" aria-label="Year"><button type="button" class="quiet" data-cal-year="${html(years[index - 1] || '')}" aria-label="Previous year" ${index > 0 ? '' : 'disabled'}>‹</button><b>${html(state.calYear)}</b><button type="button" class="quiet" data-cal-year="${html(years[index + 1] || '')}" aria-label="Next year" ${index < years.length - 1 ? '' : 'disabled'}>›</button></div>
</header>
<div class="xa-cal-wrap">
  <div class="xa-cal-scroll"><div class="xa-cal" style="--weeks:${weeks}">
    <div class="xa-cal-months" aria-hidden="true">${monthLabels}</div>
    <div class="xa-cal-days" aria-hidden="true"><span>${html(weekdays[0])}</span><span></span><span>${html(weekdays[2])}</span><span></span><span>${html(weekdays[4])}</span><span></span><span></span></div>
    <div class="xa-cal-grid" role="grid" aria-label="${html(state.calYear)} by day, ${verb}">${cells.join('')}</div>
  </div></div>
  <div class="xa-cal-scale" aria-hidden="true"><small>Less</small>${[0, 1, 2, 3, 4, 5].map(value => `<i class="xa-day" data-level="${value}"></i>`).join('')}<small>More</small></div>
</div>
<div class="xa-cal-foot">
  <div class="xa-dayinfo" id="xaDayInfo" aria-live="polite"></div>
  <dl class="xa-facts">
    <div><dt>${html(state.calYear)}</dt><dd>${count(yearTotal)} ${verb}</dd></div>
    <div><dt>Active days</dt><dd>${count(yearKeys.length)}</dd></div>
    <div><dt>Busiest day</dt><dd>${busiest ? `${html(dayText(busiest))} · ${count(days[busiest])}` : '—'}</dd></div>
    <div><dt>Longest streak</dt><dd>${count(streak.longest)} ${streak.longest === 1 ? 'day' : 'days'}${streak.longestEnd ? ` · ended ${html(dayText(streak.longestEnd))}` : ''}</dd></div>
    <div><dt>Current streak</dt><dd>${streak.current ? `${count(streak.current)} ${streak.current === 1 ? 'day' : 'days'}` : 'None'}</dd></div>
  </dl>
</div>
<div class="xa-months" aria-label="Months of ${html(state.calYear)}">${monthBars}</div>
<p class="xa-note">Days are UTC, matching <code>${field === 'archived' ? 'archived-on:' : 'on:'}</code> in Library search. Arrow keys move between days; Enter opens the day in the Library.</p>
</section>`;
  }

  function paintDay(key) {
    const info = root?.querySelector('#xaDayInfo');
    if (!info || !key) return;
    const days = state.data?.days?.[state.calField] || {},
      value = days[key] || 0,
      verb = state.calField === 'archived' ? 'archived' : 'posted';
    info.innerHTML = `<b>${html(dayText(key, { dateStyle: 'full' }))}</b><span>${value ? `${plural(value, 'post')} ${verb}` : `Nothing ${verb}`}</span>${value ? `<button type="button" class="primary" data-q="${state.calField === 'archived' ? 'archived-on' : 'on'}:${key}">Show in Library</button>` : ''}`;
  }

  function selectDay(button, focus = true) {
    if (!button?.dataset.day) return;
    for (const cell of root.querySelectorAll('.xa-cal-grid .xa-day[tabindex="0"]')) {
      cell.tabIndex = -1;
      cell.removeAttribute('aria-current');
    }
    button.tabIndex = 0;
    button.setAttribute('aria-current', 'date');
    state.calDay = button.dataset.day;
    paintDay(state.calDay);
    if (focus) button.focus({ preventScroll: true });
  }

  /* ───────── People ───────── */
  function people() {
    const sorts = [
      ['count', 'Most posts'],
      ['media', 'Most media'],
      ['latest', 'Recently archived'],
      ['name', 'Name'],
    ];
    return `<section class="xa-section xa-people">
<header class="xa-people-bar">
  <input type="search" id="xaPeopleSearch" placeholder="Find a person by name or handle" value="${html(state.peopleQuery)}" aria-label="Find a person" autocomplete="off" spellcheck="false">
  <div class="seg" role="radiogroup" aria-label="Sort people">${sorts.map(([key, label]) => `<button type="button" role="radio" data-sort="${key}" aria-checked="${state.peopleSort === key}">${label}</button>`).join('')}</div>
  <small id="xaPeopleCount"></small>
</header>
<div class="xa-people-grid" id="xaPeopleGrid"></div>
<div class="xa-more" id="xaPeopleMore"></div>
</section>`;
  }

  function filteredPeople() {
    const query = state.peopleQuery.trim().toLowerCase().replace(/^@/, '');
    const list = (state.data?.authors || []).filter(
      author =>
        !query ||
        author.handle.includes(query) ||
        String(author.name || '')
          .toLowerCase()
          .includes(query)
    );
    const sorters = {
      count: (a, b) => b.count - a.count,
      media: (a, b) => b.media - a.media || b.count - a.count,
      latest: (a, b) => b.latest - a.latest,
      name: (a, b) => String(a.name || a.handle).localeCompare(String(b.name || b.handle)),
    };
    return list.sort(sorters[state.peopleSort] || sorters.count);
  }

  function personTile(author) {
    return `<button type="button" class="xa-person" data-person="${html(author.handle)}" data-raw="${html(author.raw || author.handle)}">${avatar(author.avatar, author.name || author.handle)}<span class="xa-person-name"><b>${html(author.name || author.raw || author.handle)}${author.verified ? ' <i class="xa-verified" title="Verified">✓</i>' : ''}</b><small>@${html(author.raw || author.handle)}</small></span><span class="xa-person-stats"><b>${count(author.count)}</b><small>${author.media ? `${count(author.media)} media · ` : ''}${html(relative(author.latest))}</small></span></button>`;
  }

  // Windowed rendering: tiles are appended in pages (never re-rendered) and the next page loads
  // automatically when the sentinel scrolls into view; off-screen tiles skip layout via
  // content-visibility (xv-atlas.css).
  let peopleObserver = null;
  function paintPeople(reset = false) {
    const grid = root?.querySelector('#xaPeopleGrid');
    if (!grid) return;
    if (reset) state.peopleLimit = 60;
    const list = filteredPeople(),
      slice = list.slice(0, state.peopleLimit),
      painted = Number(grid.dataset.painted || 0),
      sameQuery = grid.dataset.query === `${state.peopleQuery}|${state.peopleSort}`;
    if (!slice.length) grid.innerHTML = `<p class="xa-quiet">No one matches “${html(state.peopleQuery)}”.</p>`;
    else if (!reset && sameQuery && painted && painted <= slice.length && grid.querySelector('.xa-person'))
      grid.insertAdjacentHTML('beforeend', slice.slice(painted).map(personTile).join(''));
    else grid.innerHTML = slice.map(personTile).join('');
    grid.dataset.painted = String(slice.length);
    grid.dataset.query = `${state.peopleQuery}|${state.peopleSort}`;
    const data = state.data;
    root.querySelector('#xaPeopleCount').textContent =
      `${count(list.length)} ${list.length === 1 ? 'person' : 'people'}${data.authorsTotal > data.authors.length ? ` · the ${count(data.authors.length)} most archived of ${count(data.authorsTotal)}` : ''}`;
    const rest = list.length - slice.length,
      more = root.querySelector('#xaPeopleMore');
    more.innerHTML = rest
      ? `<button type="button" class="quiet" data-act="more-people">Show ${count(Math.min(120, rest))} more</button>`
      : '';
    if ('IntersectionObserver' in window) {
      peopleObserver ||= new IntersectionObserver(
        entries => {
          if (entries.some(entry => entry.isIntersecting) && root?.querySelector('[data-act="more-people"]')) {
            state.peopleLimit += 120;
            paintPeople();
          }
        },
        { rootMargin: '600px 0px' }
      );
      peopleObserver.disconnect();
      if (rest) peopleObserver.observe(more);
    }
  }

  function ensureSheet() {
    if (sheet) return sheet;
    sheet = document.createElement('dialog');
    sheet.className = 'xa-sheet';
    sheet.setAttribute('aria-labelledby', 'xaSheetTitle');
    document.body.append(sheet);
    sheet.addEventListener('click', event => {
      if (event.target === sheet) return sheet.close();
      onClick(event);
    });
    sheet.addEventListener(
      'error',
      event => {
        if (event.target?.tagName === 'IMG') event.target.classList.add('is-broken');
      },
      true
    );
    sheet.addEventListener('close', () => {
      sheetToken++;
      const back = sheet.returnTo;
      sheet.returnTo = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
    });
    return sheet;
  }

  function monthStrip(months) {
    const keys = Object.keys(months || {}).sort();
    if (!keys.length) return '<p class="xa-quiet">No dated posts.</p>';
    const series = [];
    let [year, month] = keys[0].split('-').map(Number);
    const [lastYear, lastMonth] = keys.at(-1).split('-').map(Number);
    for (let guard = 0; guard < 400 && (year < lastYear || (year === lastYear && month <= lastMonth)); guard++) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      series.push([key, months[key] || 0]);
      month++;
      if (month > 12) {
        month = 1;
        year++;
      }
    }
    const max = Math.max(1, ...series.map(([, value]) => value));
    return `<div class="xa-strip-bars" role="img" aria-label="Posts by month from ${html(monthText(keys[0]))} to ${html(monthText(keys.at(-1)))}">${series.map(([key, value]) => `<i style="--h:${(value / max).toFixed(4)}" title="${html(monthText(key))}: ${count(value)}"></i>`).join('')}</div><div class="xa-strip-axis"><small>${html(monthText(keys[0]))}</small><small>${html(monthText(keys.at(-1)))}</small></div>`;
  }

  function personSheet(detail) {
    const profile = detail.profile || {},
      handle = profile.handle || detail.handle;
    const mediaTotal = Object.values(detail.media || {}).reduce((sum, value) => sum + value, 0);
    const span =
      detail.firstPosted && detail.lastPosted
        ? `${dateText(detail.firstPosted)} – ${dateText(detail.lastPosted)}`
        : '—';
    const follow = [
      profile.followers != null ? `<b>${short(profile.followers)}</b> followers` : '',
      profile.following != null ? `<b>${short(profile.following)}</b> following` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `<div class="xa-sheet-inner">
<header class="xa-sheet-head">${profile.banner ? `<img class="xa-banner" src="${html(profile.banner)}" alt="" referrerpolicy="no-referrer">` : ''}
  <button type="button" class="quiet xa-sheet-close" data-act="close-sheet" aria-label="Close">×</button>
  <div class="xa-sheet-id">${avatar(profile.avatar, profile.name || handle, 'xa-sheet-avatar')}<div><h2 id="xaSheetTitle">${html(profile.name || handle)}${profile.verified ? ' <i class="xa-verified" title="Verified">✓</i>' : ''}</h2><p>@${html(handle)}</p></div></div>
  ${profile.bio ? `<p class="xa-bio">${html(profile.bio)}</p>` : ''}
  ${follow ? `<p class="xa-follow">${follow}</p>` : ''}
  <div class="xa-sheet-actions"><button type="button" class="primary" data-q="from:${html(handle)}">Show ${count(detail.total)}${detail.truncated ? '+' : ''} posts in Library</button>${mediaTotal ? `<button type="button" data-q="from:${html(handle)} has:media">Their media</button>` : ''}<a class="xa-linkbutton" href="https://x.com/${html(handle)}" target="_blank" rel="noopener noreferrer">Open on X ↗</a></div>
</header>
<dl class="xa-facts is-grid">
  <div><dt>Archived posts</dt><dd>${count(detail.total)}${detail.truncated ? '+' : ''}</dd></div>
  <div><dt>Media files</dt><dd>${count(mediaTotal)}</dd></div>
  <div><dt>Likes on these posts</dt><dd>${short(detail.likes)}</dd></div>
  <div><dt>Posted between</dt><dd>${html(span)}</dd></div>
</dl>
<section class="xa-sheet-section"><h3>By month posted</h3>${monthStrip(detail.months)}</section>
${detail.hashtags?.length ? `<section class="xa-sheet-section"><h3>Their hashtags</h3>${chips(detail.hashtags, item => `from:${handle} #${item.key}`, '#')}</section>` : ''}
${detail.topLiked?.length ? `<section class="xa-sheet-section"><h3>Most liked</h3><div class="xa-strip is-compact">${detail.topLiked.map(post => postCard(post, `${short(post.likes)} likes`)).join('')}</div></section>` : ''}
<section class="xa-sheet-section"><h3>Recently archived</h3><ol class="xa-recent">${(detail.recent || [])
      .map(
        post =>
          `<li><button type="button" data-read="${html(post.id)}"><span>${html(post.text.slice(0, 200) || (post.mediaCount ? 'Media post' : 'Post'))}</span><small>${html(dateText(post.archivedAt))}${post.mediaCount ? ` · ${count(post.mediaCount)} media` : ''}</small></button></li>`
      )
      .join('')}</ol></section>
</div>`;
  }

  async function openPerson(handle, raw, returnTo) {
    const dialog = ensureSheet(),
      ticket = ++sheetToken;
    dialog.returnTo = returnTo || document.activeElement;
    dialog.innerHTML = `<div class="xa-sheet-inner"><button type="button" class="quiet xa-sheet-close" data-act="close-sheet" aria-label="Close">×</button><div class="xa-loading">${'<i class="xv-skeleton"></i>'.repeat(6)}</div></div>`;
    if (!dialog.open) {
      dialog.showModal();
      window.XVaultMotion?.enter(dialog, 'sheet', { spring: 'snappy', duration: 280 });
    }
    let detail;
    try {
      detail = await call({ type: 'GET_AUTHOR_DETAIL', handle, raw });
    } catch (error) {
      detail = { ok: false, error: error?.message };
    }
    if (ticket !== sheetToken || !dialog.open) return;
    dialog.innerHTML = detail?.ok
      ? personSheet(detail)
      : `<div class="xa-sheet-inner"><button type="button" class="quiet xa-sheet-close" data-act="close-sheet" aria-label="Close">×</button><div class="empty">${html(detail?.error || 'This person could not be loaded.')}</div></div>`;
    dialog.querySelector('.xa-sheet-close')?.focus({ preventScroll: true });
  }

  /* ───────── Duplicates ───────── */
  const scan = {
    job: null,
    collecting: null,
    items: [],
    pending: 0,
    failed: 0,
    flat: 0,
    groups: [],
    shown: 30,
    grouped: 0,
    lastGroupAt: 0,
    error: '',
    threshold: Math.max(0, Math.min(12, Number(store.get('xv-atlas-threshold', 5)) || 5)),
  };
  let derived = null;

  // Same schema as sw/derived-store.mjs (v2: phash + ocr + meta). The service worker does the
  // fetching and hashing; this page only reads fingerprints and groups them.
  function openDerived() {
    derived ||= new Promise((resolve, reject) => {
      const request = indexedDB.open('xvault-derived', 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('phash')) database.createObjectStore('phash', { keyPath: 'key' });
        if (!database.objectStoreNames.contains('ocr'))
          database.createObjectStore('ocr', { keyPath: 'key' }).createIndex('postId', 'postId', { unique: false });
        if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' });
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          derived = null;
        };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    }).catch(error => {
      derived = null;
      throw error;
    });
    return derived;
  }
  async function cachedHashes(keys) {
    const database = await openDerived().catch(() => null),
      found = new Map();
    if (!database || !keys.length) return found;
    return new Promise(resolve => {
      const transaction = database.transaction('phash', 'readonly'),
        hashes = transaction.objectStore('phash');
      for (const key of keys) {
        const request = hashes.get(key);
        request.onsuccess = () => request.result && found.set(key, request.result);
      }
      transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve(found);
    });
  }

  const popcount = value => {
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    return Math.imul((value + (value >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  };
  const distance = (a, b) => popcount((a.hi ^ b.hi) >>> 0) + popcount((a.lo ^ b.lo) >>> 0);
  const pDistance = (a, b) => popcount((a.phi ^ b.phi) >>> 0) + popcount((a.plo ^ b.plo) >>> 0);
  const parseHex = (text, at) => parseInt(text.slice(at, at + 8), 16) >>> 0;

  // Reads every remembered fingerprint (no network). Uncached media is left to the background job.
  async function collect() {
    if (scan.collecting) return scan.collecting;
    scan.collecting = (async () => {
      const items = [];
      let cursor = null,
        pending = 0,
        failed = 0;
      for (;;) {
        const result = await call({ type: 'GET_MEDIA_FINGERPRINT_PAGE', afterKey: cursor, limit: 800 });
        if (!result?.ok) throw Error(result?.error || 'Media could not be listed');
        const cache = await cachedHashes(result.items.map(item => item.key));
        for (const item of result.items) {
          const hit = cache.get(item.key);
          if (hit?.thumb === item.thumb && hit.h) {
            item.hi = parseHex(hit.h, 0);
            item.lo = parseHex(hit.h, 8);
            if (hit.p) {
              item.phi = parseHex(hit.p, 0);
              item.plo = parseHex(hit.p, 8);
              item.hasP = true;
            }
            items.push(item);
          } else if (hit?.thumb === item.thumb) failed++;
          else pending++;
        }
        cursor = result.nextKey ?? null;
        if (result.done || cursor == null) break;
      }
      scan.items = items;
      scan.pending = pending;
      scan.failed = failed;
      await regroup();
    })()
      .catch(error => {
        scan.error = error?.message || 'Fingerprints could not be read';
      })
      .finally(() => {
        scan.collecting = null;
        paintLab();
      });
    return scan.collecting;
  }

  const jobActive = () => ['running', 'waiting'].includes(scan.job?.state);
  async function refreshJob() {
    const result = await call({ type: 'DERIVED_JOB_STATUS' }).catch(() => null);
    if (result?.ok) scan.job = result.jobs.phash;
    return scan.job;
  }
  async function runScan({ restart = false } = {}) {
    scan.error = '';
    const result = await call({
      type: 'DERIVED_JOB_START',
      kind: 'phash',
      restart,
      total: Number(state.data?.media?.items || 0),
    });
    if (!result?.ok) scan.error = result?.error || 'The scan could not start';
    else scan.job = result.job;
    paintLab();
  }
  try {
    new BroadcastChannel('xvault-derived-jobs').onmessage = event => {
      const message = event.data || {};
      if (message.type !== 'DERIVED_JOB' || message.kind !== 'phash') return;
      const before = scan.job?.state;
      scan.job = message.job;
      if (message.job.state === 'done' && before !== 'done') {
        collect().then(() => {
          if (shown() && state.view === 'duplicates')
            toast(
              scan.groups.length ? `Found ${plural(scan.groups.length, 'look-alike group')}` : 'No look-alikes found'
            );
        });
      } else if (jobActive() && Date.now() - scan.lastGroupAt > 45000 && !scan.collecting) collect();
      paintLab();
    };
  } catch {}

  async function regroup() {
    const usable = scan.items.filter(item => {
      const bits = popcount(item.hi) + popcount(item.lo);
      return bits > 2 && bits < 62;
    });
    scan.flat = scan.items.length - usable.length;
    const threshold = scan.threshold,
      parent = Int32Array.from({ length: usable.length }, (_, index) => index);
    const find = index => {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    };
    let tree = null;
    for (let index = 0; index < usable.length; index++) {
      const item = usable[index];
      if (tree) {
        const stack = [tree];
        while (stack.length) {
          const node = stack.pop(),
            other = usable[node.index],
            gap = distance(item, other);
          if (
            gap <= threshold &&
            other.postId !== item.postId &&
            !(item.mediaId && item.mediaId === other.mediaId) &&
            // When both images have a DCT fingerprint, require it to agree too (fewer false matches).
            (!item.hasP || !other.hasP || pDistance(item, other) <= threshold + 6)
          ) {
            const a = find(index),
              b = find(node.index);
            if (a !== b) parent[a] = b;
          }
          for (const [edge, child] of node.children)
            if (edge >= gap - threshold && edge <= gap + threshold) stack.push(child);
        }
        let cursor = tree;
        for (;;) {
          const gap = distance(item, usable[cursor.index]),
            child = cursor.children.get(gap);
          if (child) cursor = child;
          else {
            cursor.children.set(gap, { index, children: new Map() });
            break;
          }
        }
      } else tree = { index, children: new Map() };
      if (index % 2500 === 2499) await new Promise(resolve => setTimeout(resolve));
    }
    const groups = new Map();
    usable.forEach((item, index) => {
      const key = find(index);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    });
    const posted = item => Date.parse(item.createdAt || '') || item.archivedAt || 0;
    scan.groups = [...groups.values()]
      .filter(members => new Set(members.map(item => item.postId)).size > 1)
      .map(members => {
        members.sort((a, b) => posted(a) - posted(b));
        let spread = 0;
        for (let a = 0; a < members.length && a < 12; a++)
          for (let b = a + 1; b < members.length && b < 12; b++)
            spread = Math.max(spread, distance(members[a], members[b]));
        return { members, spread };
      })
      .sort((a, b) => b.members.length - a.members.length || a.spread - b.spread);
    scan.grouped = scan.items.length;
    scan.lastGroupAt = Date.now();
  }

  const thresholdLabel = value =>
    value <= 2 ? 'Near-identical' : value <= 5 ? 'Close' : value <= 8 ? 'Loose' : 'Very loose';

  function duplicates(data) {
    const shared = data.sharedMedia || [];
    return `<section class="xa-section">
<header class="xa-section-head"><h2>Same file in several posts</h2><small>${plural(shared.length, 'group')}${shared.length >= 400 ? '+' : ''}</small></header>
<p class="xa-note">One media file archived under more than one post — usually quotes, re-shares or the same artwork posted twice. Nothing is removed unless you choose to.</p>
<div id="xaShared">${shared.length ? `<div class="xa-loading">${'<i class="xv-skeleton"></i>'.repeat(3)}</div>` : '<p class="xa-quiet">No shared files. Every media file belongs to one post.</p>'}</div>
</section>
<section class="xa-section xa-lab">
<header class="xa-section-head"><h2>Look-alike images</h2></header>
<p class="xa-note">Finds re-uploads, recompressed copies and light edits by comparing two 64-bit fingerprints (difference + DCT) of each image. XVault's background worker fetches images from X's CDN at a gentle pace and backs off when X asks it to; fingerprints stay on this computer, so later scans only look at new media.</p>
<div class="xa-lab-controls">
  <button type="button" class="primary" data-act="scan" id="xaScanButton">Find look-alikes</button>
  <button type="button" class="quiet" data-act="scan-reset" id="xaScanReset" hidden>Start over</button>
  <label class="xa-threshold">Match <input type="range" id="xaThreshold" min="0" max="12" step="1" value="${scan.threshold}" aria-describedby="xaThresholdLabel"><output id="xaThresholdLabel">${thresholdLabel(scan.threshold)}</output></label>
</div>
<div class="xa-meter" aria-hidden="true"><i id="xaLabMeter"></i></div>
<p class="xa-lab-status" id="xaLabStatus" role="status"></p>
<div id="xaLookalikes"></div>
</section>`;
  }

  function groupMarkup(posts, { label, note }) {
    const ids = posts.map(post => post.id),
      keep = ids[0],
      extra = ids.slice(1);
    return `<article class="xa-group">
<div class="xa-group-media">${posts
      .slice(0, 8)
      .map(
        (post, index) =>
          `<button type="button" class="xa-thumb${index ? '' : ' is-first'}" data-read="${html(post.id)}" title="@${html(post.handle)} · ${html(post.when)}"><img src="${html(post.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"><small>@${html(post.handle)}</small></button>`
      )
      .join('')}${posts.length > 8 ? `<span class="xa-thumb-more">+${posts.length - 8}</span>` : ''}</div>
<div class="xa-group-info"><b>${html(label)}</b><small>${html(note)}</small></div>
<div class="xa-group-actions">
  <button type="button" class="quiet" data-q="id:${ids.join('|')}">Compare in Library</button>
  <button type="button" class="quiet" data-dup="tag" data-ids="${ids.join(',')}">Tag “duplicate”</button>
  <button type="button" class="quiet xa-danger" data-dup="trash" data-ids="${extra.join(',')}" data-keep="${html(keep)}">Trash ${extra.length} ${extra.length === 1 ? 'copy' : 'copies'}</button>
</div>
</article>`;
  }

  async function hydrateShared() {
    const host = root?.querySelector('#xaShared'),
      groups = (state.data?.sharedMedia || []).slice(0, 60);
    if (!host || !groups.length) return;
    const ids = [...new Set(groups.flatMap(group => group.posts))].slice(0, 1000);
    let rows = [];
    try {
      const result = await call({ type: 'GET_LIBRARY_RECORDS', ids });
      rows = result?.rows || [];
    } catch {}
    if (!host.isConnected) return;
    const byId = new Map(rows.filter(Boolean).map(row => [String(row.id), row]));
    const posted = row => Date.parse(row.createdAt || '') || Number(row.archivedAt || 0);
    const markup = groups
      .map(group => {
        const posts = group.posts
          .map(id => byId.get(String(id)))
          .filter(Boolean)
          .sort((a, b) => posted(a) - posted(b))
          .map(row => {
            const item = (row.media || []).find(media => String(media.id) === group.mediaId) || row.media?.[0] || {};
            return {
              id: String(row.id),
              handle: row.author?.handle || 'unknown',
              thumb: cdn(item.preview || item.url || '', 'thumb'),
              when: row.createdAt
                ? `posted ${dateText(Date.parse(row.createdAt))}`
                : `archived ${dateText(row.archivedAt)}`,
            };
          });
        if (posts.length < 2) return '';
        return groupMarkup(posts, {
          label: `${posts.length} posts share one file`,
          note: `The earliest post (first) is kept if you trash copies.`,
        });
      })
      .filter(Boolean);
    host.innerHTML = markup.length
      ? `${markup.join('')}${(state.data.sharedMedia || []).length > groups.length ? `<p class="xa-note">Showing the first ${count(groups.length)} groups.</p>` : ''}`
      : '<p class="xa-quiet">The posts sharing files are no longer in the archive.</p>';
  }

  function paintLab() {
    const status = root?.querySelector('#xaLabStatus');
    if (!status) return;
    const button = root.querySelector('#xaScanButton'),
      reset = root.querySelector('#xaScanReset'),
      meter = root.querySelector('#xaLabMeter');
    const job = scan.job || {},
      active = jobActive(),
      done = job.state === 'done',
      started = Number(job.seen || 0) > 0 || scan.items.length > 0 || active;
    if (!scan.job && !scan.jobRequested) {
      scan.jobRequested = true;
      refreshJob().then(current => {
        if (current && (current.seen || current.processed) && !scan.grouped) collect();
        paintLab();
      });
    }
    button.textContent = active ? 'Pause' : done ? 'Scan again for new media' : started ? 'Resume' : 'Find look-alikes';
    button.setAttribute('aria-pressed', String(active));
    reset.hidden = !started || active;
    const expected = Math.max(1, Number(job.total || 0), Number(state.data?.media?.items || 0), Number(job.seen || 0));
    const progress = done ? 1 : Math.min(0.99, Number(job.seen || 0) / expected);
    meter.style.transform = `scaleX(${started ? progress : 0})`;
    const unavailable = Number(job.failed || 0) + Number(job.skipped || 0);
    const parts = started
      ? [
          job.state === 'waiting'
            ? job.message || 'Waiting for X to allow more image requests'
            : active
              ? 'Scanning in the background — you can leave this page'
              : done
                ? 'Done'
                : job.state === 'error'
                  ? 'Stopped'
                  : 'Paused',
          `${count(Number(job.seen || 0))} of ~${count(expected)} images checked`,
          job.processed ? `${count(job.processed)} newly fingerprinted` : '',
          job.cached ? `${count(job.cached)} remembered` : '',
          unavailable ? `${count(unavailable)} unavailable` : '',
          scan.collecting ? 'grouping…' : '',
          scan.flat ? `${count(scan.flat)} blank or flat skipped` : '',
        ]
      : ['Not scanned yet. The scan runs in the background, survives closing this tab and can be paused at any time.'];
    status.textContent =
      parts.filter(Boolean).join(' · ') + (job.error ? ` · ${job.error}` : '') + (scan.error ? ` · ${scan.error}` : '');
    const results = root.querySelector('#xaLookalikes');
    if (!results) return;
    if (!scan.groups.length) {
      results.innerHTML =
        started && !active && scan.grouped
          ? `<p class="xa-quiet">No look-alikes at “${html(thresholdLabel(scan.threshold))}”. Try a looser match.</p>`
          : '';
      return;
    }
    const visibleGroups = scan.groups.slice(0, scan.shown);
    results.innerHTML = `<p class="xa-note">${plural(scan.groups.length, 'group')}${active ? ' so far' : ''}.</p>${visibleGroups
      .map(group => {
        const posts = [];
        const seen = new Set();
        for (const item of group.members) {
          if (seen.has(item.postId)) continue;
          seen.add(item.postId);
          posts.push({
            id: item.postId,
            handle: item.handle || 'unknown',
            thumb: item.thumb,
            when: item.createdAt
              ? `posted ${dateText(Date.parse(item.createdAt))}`
              : `archived ${dateText(item.archivedAt)}`,
          });
        }
        return groupMarkup(posts, {
          label: `${posts.length} posts look alike`,
          note:
            group.spread <= 2
              ? 'Near-identical images'
              : group.spread <= 5
                ? 'Close match'
                : 'Loose match — check before acting',
        });
      })
      .join(
        ''
      )}${scan.groups.length > scan.shown ? `<div class="xa-more"><button type="button" class="quiet" data-act="more-groups">Show more groups</button></div>` : ''}`;
  }

  async function duplicateAction(button) {
    const ids = String(button.dataset.ids || '')
      .split(',')
      .filter(Boolean);
    if (!ids.length) return;
    button.disabled = true;
    try {
      if (button.dataset.dup === 'tag') {
        const result = await call({ type: 'BULK_UPDATE_TWEET_META', ids, patch: { addTag: 'duplicate' } });
        if (!result?.ok) throw Error(result?.error || 'Tagging failed');
        toast(`Tagged ${count(ids.length)} posts “duplicate” · search tag:duplicate`);
        button.textContent = 'Tagged';
        return;
      }
      if (
        !confirm(
          `Move ${ids.length} ${ids.length === 1 ? 'post' : 'posts'} to Trash and keep the earliest one? You can restore them from Trash.`
        )
      ) {
        button.disabled = false;
        return;
      }
      const result = await call({ type: 'MOVE_TWEETS_TO_TRASH', ids });
      if (!result?.ok) throw Error(result?.error || 'Moving to Trash failed');
      toast(`Moved ${count(ids.length)} to Trash`);
      const group = button.closest('.xa-group');
      if (group) {
        group.classList.add('is-resolved');
        group.querySelector('.xa-group-actions').innerHTML = '<small>Copies moved to Trash</small>';
      }
      const gone = new Set(ids);
      scan.items = scan.items.filter(item => !gone.has(item.postId));
      for (const entry of scan.groups) entry.members = entry.members.filter(item => !gone.has(item.postId));
      scan.groups = scan.groups.filter(entry => new Set(entry.members.map(item => item.postId)).size > 1);
      state.stale = true;
    } catch (error) {
      button.disabled = false;
      toast(error?.message || 'That did not work');
    }
  }

  /* ───────── Events ───────── */
  function onClick(event) {
    const target = event.target.closest(
      '[data-view],[data-q],[data-read],[data-person],[data-growth],[data-cal-field],[data-cal-zone],[data-cal-year],[data-day],[data-sort],[data-act],[data-dup],[data-page-go]'
    );
    if (!target || target.disabled) return;
    const set = target.dataset;
    if (set.view && target.closest('.xa-head, .xa-section-head')) return setView(set.view);
    if (set.q) {
      if (sheet?.open) sheet.close();
      return openLibrary(set.q);
    }
    if (set.read) return window.XVaultReader?.open(set.read, { returnTo: target });
    if (set.person) return openPerson(set.person, set.raw, target);
    if (set.growth && set.growth !== state.growth) {
      state.growth = set.growth;
      state.growthChosen = true;
      for (const button of root.querySelectorAll('[data-growth]'))
        button.setAttribute('aria-checked', String(button.dataset.growth === state.growth));
      return drawGrowth(true);
    }
    if (set.calZone && set.calZone !== (state.data?.timeZone === 'utc' ? 'utc' : 'local')) {
      return call({ type: 'SET_SETTINGS', settings: { calendarTimeZone: set.calZone } }).then(() => {
        if (typeof settings === 'object' && settings) settings.calendarTimeZone = set.calZone;
        window.XVaultLibrarySearch?.setCalendarTimeZone?.(set.calZone);
        toast(set.calZone === 'utc' ? 'Calendar days now follow UTC' : 'Calendar days now follow local time');
        return load(true);
      });
    }
    if (set.calField && set.calField !== state.calField) {
      state.calField = set.calField;
      return render();
    }
    if (set.calYear) {
      state.calYear = set.calYear;
      state.calDay = '';
      return render();
    }
    if (set.day) return selectDay(target);
    if (set.sort) {
      state.peopleSort = set.sort;
      for (const button of root.querySelectorAll('[data-sort]'))
        button.setAttribute('aria-checked', String(button.dataset.sort === state.peopleSort));
      return paintPeople(true);
    }
    if (set.dup) return duplicateAction(target);
    if (set.pageGo) return page(set.pageGo);
    const act = set.act;
    if (act === 'recount') return load(true);
    if (act === 'close-sheet') return sheet?.close();
    if (act === 'more-people') {
      state.peopleLimit += 120;
      return paintPeople();
    }
    if (act === 'more-groups') {
      scan.shown += 30;
      return paintLab();
    }
    if (act === 'scan') {
      if (jobActive())
        return call({ type: 'DERIVED_JOB_PAUSE', kind: 'phash' }).then(result => {
          if (result?.ok) scan.job = result.job;
          paintLab();
          collect();
        });
      // A finished scan restarts from the top but re-uses every remembered fingerprint.
      return runScan({ restart: scan.job?.state === 'done' });
    }
    if (act === 'scan-reset') return runScan({ restart: true });
  }

  function onInput(event) {
    if (event.target.id === 'xaPeopleSearch') {
      state.peopleQuery = event.target.value;
      clearTimeout(peopleTimer);
      peopleTimer = setTimeout(() => paintPeople(true), 90);
    }
    if (event.target.id === 'xaThreshold') {
      scan.threshold = Number(event.target.value) || 0;
      store.set('xv-atlas-threshold', String(scan.threshold));
      root.querySelector('#xaThresholdLabel').textContent = thresholdLabel(scan.threshold);
      clearTimeout(event.target.timer);
      event.target.timer = setTimeout(async () => {
        if (!scan.items.length || scan.collecting) return;
        await regroup();
        scan.shown = 30;
        paintLab();
      }, 160);
    }
  }

  function onKeydown(event) {
    const cell = event.target.closest?.('.xa-cal-grid .xa-day');
    if (!cell || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if ((state.data?.days?.[state.calField] || {})[cell.dataset.day])
        openLibrary(`${state.calField === 'archived' ? 'archived-on' : 'on'}:${cell.dataset.day}`);
      return;
    }
    const step = { ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7 }[event.key];
    let key = '';
    if (step) key = isoDay(Date.parse(`${cell.dataset.day}T00:00:00Z`) + step * DAY);
    else if (event.key === 'Home') key = `${state.calYear}-01-01`;
    else if (event.key === 'End') key = `${state.calYear}-12-31`;
    else return;
    event.preventDefault();
    const next = root.querySelector(`.xa-cal-grid .xa-day[data-day="${key}"]`);
    if (next) selectDay(next);
  }

  function onFocus(event) {
    const cell = event.target.closest?.('.xa-cal-grid .xa-day');
    if (cell) paintDay(cell.dataset.day);
  }
  function onHover(event) {
    const cell = event.target.closest?.('.xa-cal-grid .xa-day');
    if (cell) paintDay(cell.dataset.day);
  }

  // Keep the numbers honest: archive changes mark Atlas stale and refresh it if it is on screen.
  function changed() {
    state.stale = true;
    if (!shown()) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => shown() && load(false, { quiet: true }), 4000);
  }
  try {
    new BroadcastChannel('xvault-insights').onmessage = event => {
      if (event.data?.type !== 'INSIGHTS_READY') return;
      state.refreshing = false;
      state.stale = true;
      if (shown()) load(false, { quiet: true });
    };
  } catch {}
  try {
    new BroadcastChannel('xvault-library-changes').onmessage = changed;
    new BroadcastChannel('xvault-library-metadata').onmessage = changed;
  } catch {}

  // Shared, deduplicated insight loader for other dashboard modules (search suggestions).
  window.XVaultInsights = async () => {
    if (state.data && !state.stale) return state.data;
    if (!root) frame();
    if (root) return load(false);
    const result = await call({ type: 'GET_VAULT_INSIGHTS' });
    return result?.insights || null;
  };

  const openView = view => {
    state.view = view;
    store.set('xv-atlas-view', view);
    page('atlas');
  };
  const previousCommands = window.XVaultExtraCommands;
  window.XVaultExtraCommands = query => [
    ...(previousCommands?.(query) || []),
    { name: 'Open Atlas', hint: 'growth, rhythm and people in your archive', run: () => openView('overview') },
    { name: 'Atlas: Calendar', hint: 'every archived day as a heatmap', run: () => openView('calendar') },
    { name: 'Atlas: People', hint: 'everyone you have archived', run: () => openView('people') },
    { name: 'Atlas: Duplicate Lab', hint: 'shared files and look-alike images', run: () => openView('duplicates') },
  ];

  window.XVaultAtlas = { show, open: openView, person: openPerson };
})();
