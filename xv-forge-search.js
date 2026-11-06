/* XVault 21 "Forge" — search quality-of-life in the Library.
   • "Did you mean", "Allow typos" and "Search by meaning" when a search finds nothing (SEARCH_SUGGEST);
   • search history with result counts, pins, filtering, re-run and "as it was on" time travel (asof:);
   • "new since your last visit" badges on Smart Collections (SAVED_VIEW_ALERTS / SAVED_VIEW_VISITED);
   • the Forge filters in the search-syntax help.
   History lives in this browser's localStorage only and follows Settings › Library › Search history. */
(() => {
  const $ = selector => document.querySelector(selector);
  const HISTORY_KEY = 'xv-search-history';
  const html = value =>
    typeof esc === 'function' ? esc(value) : String(value ?? '').replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
  const n = value => (typeof fmt === 'function' ? fmt(Number(value) || 0) : String(Number(value) || 0));
  const say = message => (typeof toast === 'function' ? toast(message) : undefined);
  const current = () => (typeof settings === 'object' && settings ? settings : {});
  const enabled = name => current()[name] !== false;
  const historyLimit = () => Math.max(10, Math.min(500, Number(current().searchHistoryLimit) || 80));
  const hooks = window.XVaultDashboard;
  const ask = async message => {
    try {
      return await call(message);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };
  const run = (query, sort = null) => {
    if (typeof page === 'function' && !$('#page-library.show')) page('library');
    window.XVaultLibraryRunQuery?.(query, sort);
  };
  const pad = value => String(value).padStart(2, '0');
  const dayKey = stamp => {
    const date = new Date(stamp);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };

  /* ───────────── History store ───────────── */
  function readHistory() {
    try {
      const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(list)
        ? list
            .filter(entry => entry && typeof entry.q === 'string' && entry.q.length <= 500)
            .map(entry => ({
              q: entry.q,
              at: Number(entry.at) || 0,
              count: Number.isFinite(Number(entry.count)) ? Number(entry.count) : null,
              runs: Math.max(1, Number(entry.runs) || 1),
              pinned: !!entry.pinned,
            }))
        : [];
    } catch {
      return [];
    }
  }
  function writeHistory(list) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch {}
  }
  /** Most recent first; pinned entries never age out; the rest keep to the history limit. */
  function trimHistory(list, limit = historyLimit()) {
    let kept = 0;
    return list.filter(entry => entry.pinned || kept++ < limit);
  }
  let lastRecorded = { q: '', at: 0 };
  function record(query, count) {
    if (!enabled('searchHistoryEnabled')) return;
    const q = String(query || '').trim();
    if (q.length < 2 || q.length > 500) return;
    const list = readHistory(),
      existing = list.find(entry => entry.q === q),
      now = Date.now();
    // Paging through results or re-rendering the same search is not a new run.
    const again = lastRecorded.q === q && now - lastRecorded.at < 10 * 60000;
    lastRecorded = { q, at: now };
    const entry = {
      q,
      at: now,
      count,
      runs: (existing?.runs || 0) + (again && existing ? 0 : 1),
      pinned: !!existing?.pinned,
    };
    writeHistory(trimHistory([entry, ...list.filter(item => item.q !== q)]));
    if ($('.xf-history-menu[open]')) paintHistory();
  }
  let pending = 0;
  function settle(query, count) {
    clearTimeout(pending);
    // Wait until typing settles so "c", "ca", "cat" record once as "cat".
    pending = setTimeout(() => {
      if (($('#search')?.value || '').trim() === String(query || '').trim()) record(query, count);
    }, 1600);
  }

  /* ───────────── History panel ───────────── */
  function mountHistory() {
    const wrap = $('#page-library .searchWrap');
    if (!wrap || wrap.querySelector('.xf-history-menu')) return;
    const menu = document.createElement('details');
    menu.className = 'menu xf-history-menu';
    menu.innerHTML = `<summary aria-label="Search history and time travel" title="Search history · time travel">${window.XVaultIcons?.svg?.('undo') || '⟲'}</summary><div class="menu-pop xf-history" role="dialog" aria-label="Search history"></div>`;
    (wrap.querySelector('.search-help') || wrap.lastElementChild).before(menu);
    menu.addEventListener('toggle', () => {
      if (menu.open) paintHistory();
    });
    menu.addEventListener('click', onHistoryClick);
    menu.addEventListener('input', event => {
      if (event.target.matches('[data-history-filter]')) paintHistory({ keepFilter: true });
    });
    menu.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        menu.open = false;
        menu.querySelector('summary')?.focus();
      }
    });
  }
  function dayLabel(stamp) {
    const key = dayKey(stamp),
      today = dayKey(Date.now()),
      yesterday = dayKey(Date.now() - 86400000);
    if (key === today) return 'Today';
    if (key === yesterday) return 'Yesterday';
    return new Date(stamp).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }
  function asOfIn(query) {
    return /(?:^|\s)as-?of:(\d{4}-\d{2}-\d{2})(?=\s|$)/.exec(query)?.[1] || '';
  }
  function withAsOf(query, day) {
    const stripped = String(query || '')
      .replace(/(?:^|\s)-?as-?of:\S+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return day ? `${stripped} asof:${day}`.trim() : stripped;
  }
  function paintHistory({ keepFilter = false } = {}) {
    const box = $('.xf-history');
    if (!box) return;
    const filterInput = box.querySelector('[data-history-filter]'),
      filter = keepFilter ? String(filterInput?.value || '').toLowerCase() : '';
    const list = readHistory(),
      pinned = list.filter(entry => entry.pinned),
      recent = list.filter(entry => !entry.pinned && (!filter || entry.q.toLowerCase().includes(filter)));
    const query = ($('#search')?.value || '').trim(),
      asOf = asOfIn(query);
    const row = entry => `<li>
        <button type="button" class="xf-h-run" data-history-run="${html(entry.q)}" title="Run this search"><code>${html(entry.q)}</code></button>
        <span class="xf-h-meta">${entry.count == null ? '' : `${n(entry.count)}${entry.count >= 1000 ? '+' : ''} · `}${new Date(entry.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}${entry.runs > 1 ? ` · ${entry.runs}×` : ''}</span>
        <button type="button" class="quiet xf-h-pin" data-history-pin="${html(entry.q)}" aria-pressed="${entry.pinned}" aria-label="${entry.pinned ? 'Unpin' : 'Pin'} ${html(entry.q)}" title="${entry.pinned ? 'Unpin' : 'Pin'}">${entry.pinned ? '★' : '☆'}</button>
        <button type="button" class="quiet xf-h-remove" data-history-remove="${html(entry.q)}" aria-label="Remove ${html(entry.q)} from history" title="Remove">×</button>
      </li>`;
    const groups = new Map();
    for (const entry of recent) {
      const label = dayLabel(entry.at);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(entry);
    }
    const off = !enabled('searchHistoryEnabled');
    box.innerHTML = `
      <section class="xf-asof" aria-labelledby="xfAsOfTitle">
        <h3 id="xfAsOfTitle">Time travel</h3>
        <p>Show only what your vault held at the end of a day. Posts archived later are hidden; the text shown is the current version — open a post's History for older wording.</p>
        <form class="xf-asof-form" data-asof-form>
          <input type="date" name="day" value="${html(asOf)}" max="${dayKey(Date.now())}" aria-label="Vault as it was on">
          <button type="submit">${asOf ? 'Change day' : 'Apply to this search'}</button>
          ${asOf ? '<button type="button" class="quiet" data-asof-clear>Back to now</button>' : ''}
        </form>
      </section>
      <section aria-labelledby="xfHistoryTitle">
        <header class="xf-h-head"><h3 id="xfHistoryTitle">Search history</h3>${list.length ? '<button type="button" class="quiet" data-history-clear>Clear</button>' : ''}</header>
        ${off ? '<p class="xf-muted">History is off (Settings › Library › Search). Pinned searches stay.</p>' : ''}
        ${list.length > 8 ? `<input type="search" data-history-filter placeholder="Filter history" aria-label="Filter search history" value="${html(filter)}">` : ''}
        ${pinned.length ? `<h4>Pinned</h4><ul class="xf-h-list">${pinned.map(row).join('')}</ul>` : ''}
        ${[...groups].map(([label, entries]) => `<h4>${html(label)}</h4><ul class="xf-h-list">${entries.map(row).join('')}</ul>`).join('')}
        ${!list.length ? `<p class="xf-muted">${off ? 'Nothing saved.' : 'Searches you run appear here with their result counts.'}</p>` : !recent.length && filter ? '<p class="xf-muted">No history entries match.</p>' : ''}
      </section>`;
    if (keepFilter) {
      const input = box.querySelector('[data-history-filter]');
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
    box.querySelector('[data-asof-form]')?.addEventListener('submit', event => {
      event.preventDefault();
      const day = event.target.elements.day.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return say('Pick a day first');
      run(withAsOf($('#search')?.value || '', day));
      paintHistory();
    });
  }
  function onHistoryClick(event) {
    const target = event.target.closest('button');
    if (!target) return;
    const list = readHistory();
    if (target.dataset.historyRun != null) {
      const menu = target.closest('details');
      if (menu) menu.open = false;
      return run(target.dataset.historyRun);
    }
    if (target.dataset.historyPin != null) {
      const entry = list.find(item => item.q === target.dataset.historyPin);
      if (entry) entry.pinned = !entry.pinned;
      writeHistory(trimHistory(list));
      return paintHistory({ keepFilter: true });
    }
    if (target.dataset.historyRemove != null) {
      writeHistory(list.filter(item => item.q !== target.dataset.historyRemove));
      return paintHistory({ keepFilter: true });
    }
    if (target.hasAttribute('data-history-clear')) {
      const pins = list.filter(item => item.pinned);
      if (
        !confirm(
          `Clear ${list.length - pins.length} searches from history?${pins.length ? ` ${pins.length} pinned searches stay.` : ''}`
        )
      )
        return;
      writeHistory(pins);
      return paintHistory();
    }
    if (target.hasAttribute('data-asof-clear')) {
      run(withAsOf($('#search')?.value || '', ''));
      return paintHistory();
    }
  }

  /* ───────────── "As of" banner ───────────── */
  function asOfBanner(query) {
    const filters = $('#page-library .lib-filters');
    if (!filters) return;
    let banner = $('#xfAsOfBanner');
    const day = asOfIn(query || '');
    if (!day) return banner?.remove();
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'xfAsOfBanner';
      banner.className = 'xf-asof-banner';
      banner.setAttribute('role', 'status');
      // XVault 25: under the sticky Library header, in the scrolling flow (like the board banner).
      ($('#list') || filters).before(banner);
      banner.addEventListener('click', event => {
        if (event.target.closest('[data-asof-clear]')) run(withAsOf($('#search')?.value || '', ''));
      });
    }
    const label = new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { dateStyle: 'long' });
    banner.innerHTML = `<span>Viewing your vault as it was on <strong>${html(label)}</strong> — posts archived later are hidden and edited posts show the text they had that day.</span><button type="button" class="quiet" data-asof-clear>Back to now</button>`;
  }
  // XVault 22: cards whose text changed after the asof: day get a marker with today's text.
  let asOfChanged = new Map();
  function markAsOfCards() {
    if (!asOfChanged.size) return;
    for (const card of document.querySelectorAll('#list [data-id]')) {
      const entry = asOfChanged.get(String(card.dataset.id));
      if (!entry || card.querySelector('.xf-asof-mark')) continue;
      const mark = document.createElement('span');
      mark.className = 'xf-asof-mark';
      mark.textContent = 'Text as it was then · edited later';
      mark.title = `Current text: ${entry.current.slice(0, 400)}`;
      mark.setAttribute(
        'aria-label',
        `Shown as it was then; edited later. Current text: ${entry.current.slice(0, 200)}`
      );
      (card.querySelector('.tweetText, .xv-record-copy p, [data-col="text"], p') || card).after?.(mark);
    }
  }
  const listObserver = new MutationObserver(() => markAsOfCards());
  function trackAsOf(rows, query) {
    asOfChanged = new Map(
      asOfIn(query || '') && Array.isArray(rows)
        ? rows.filter(row => row?.asOfText).map(row => [String(row.id), row.asOfText])
        : []
    );
    const list = $('#list');
    listObserver.disconnect();
    if (asOfChanged.size && list) {
      markAsOfCards();
      listObserver.observe(list, { childList: true, subtree: true });
    }
  }

  /* ───────────── Did you mean ───────────── */
  let suggestToken = 0;
  async function didYouMean(query, container) {
    if (!enabled('searchDidYouMean') || !container || !query) return;
    const token = ++suggestToken;
    const result = await ask({ type: 'SEARCH_SUGGEST', query });
    if (token !== suggestToken || ($('#search')?.value || '').trim() !== String(query).trim()) return;
    if (!result?.ok || !result.suggestions?.length || !container.isConnected) return;
    container.querySelector('.xf-dym')?.remove();
    const box = document.createElement('div');
    box.className = 'xf-dym';
    const spelled = result.suggestions.find(entry => entry.kind === 'spelling');
    box.innerHTML = `${result.suggestions
      .map(
        entry =>
          `<button type="button" class="${entry.kind === 'spelling' ? 'primary' : 'quiet'}" data-suggest="${html(entry.query)}" data-suggest-kind="${html(entry.kind)}"><span>${html(entry.label)}</span> <code>${html(entry.query)}</code></button>`
      )
      .join('')}${
      spelled && result.alternatives?.some(entry => entry.options.length > 1)
        ? `<p class="xf-muted">Other close words: ${result.alternatives
            .flatMap(entry =>
              entry.options
                .slice(1)
                .map(
                  option =>
                    `<button type="button" class="link" data-suggest="${html(String(query).replace(entry.word, option))}">${html(option)}</button>`
                )
            )
            .join(', ')}</p>`
        : ''
    }`;
    box.addEventListener('click', event => {
      const button = event.target.closest('[data-suggest]');
      if (button) run(button.dataset.suggest, button.dataset.suggestKind === 'meaning' ? 'relevance' : null);
    });
    container.append(box);
  }

  /* ───────────── Smart Collection alerts ───────────── */
  let alertCounts = {},
    alertsAt = 0,
    alertsBusy = false;
  async function refreshAlerts(force = false) {
    if (alertsBusy || (!force && Date.now() - alertsAt < 60000)) return paintAlerts();
    alertsBusy = true;
    try {
      const result = await ask({ type: 'SAVED_VIEW_ALERTS' });
      if (result?.ok) {
        alertCounts = result.counts || {};
        alertsAt = Date.now();
      }
    } finally {
      alertsBusy = false;
    }
    paintAlerts();
  }
  function paintAlerts() {
    for (const row of document.querySelectorAll('#facetViews .facet-row[data-collection-id]')) {
      const count = Number(alertCounts[row.dataset.collectionId] || 0),
        button = row.querySelector('.facet-item');
      if (!button) continue;
      let badge = button.querySelector('.xf-new');
      if (!count) {
        badge?.remove();
        continue;
      }
      if (!badge) {
        badge = document.createElement('em');
        badge.className = 'count xf-new';
        button.append(badge);
      }
      badge.textContent = count >= 5000 ? '5000+' : n(count);
      badge.title = `${n(count)} new since your last visit`;
      badge.setAttribute('aria-label', `${n(count)} new since your last visit`);
    }
  }
  let observed = null;
  function watchCollections() {
    const target = $('#facetViews');
    if (!target || observed === target) return;
    observed = target;
    new MutationObserver(() => paintAlerts()).observe(target, { childList: true });
    target.addEventListener('click', event => {
      const open = event.target.closest('.facet-item[data-view-index]'),
        row = open?.closest('.facet-row');
      if (!row?.dataset.collectionId) return;
      const id = row.dataset.collectionId;
      alertCounts[id] = 0;
      paintAlerts();
      ask({ type: 'SAVED_VIEW_VISITED', id });
    });
    refreshAlerts(true);
  }

  /* ───────────── Search help ───────────── */
  const HELP = [
    ['quality:<50 is:incomplete', 'archive completeness; incomplete is under 70 (Capture › Quality)'],
    ['is:edited edits:>1 has:revisions', 'posts whose text changed, with History'],
    ['is:deleted status:suspended', 'still on X? (after a check)'],
    ['asof:2026-01-01', 'what the vault held on a day'],
    ['has:poll has:card has:space has:community-note', 'post extras'],
    ['alt:diagram poll:yes card:"release" cnote:misleading', 'search inside extras'],
    ['duration:>2m res:>=1080 aspect:portrait', 'video length, resolution, shape'],
    ['engagement:>5% words:>200', 'interaction rate, long posts'],
    ['weekday:weekend hour:22-6', 'when it was posted (calendar zone)'],
    ['label:red name:"jane"', 'color labels and display names'],
    ['topic:c3', 'an Atlas › Topics cluster'],
    ['cat~ photgraphy', 'typo-tolerant word (~); "Did you mean" on no results'],
  ];
  function extendHelp(details) {
    const box = details.querySelector('.booruHelp');
    if (!box || box.querySelector('.xf-help')) return;
    const section = document.createElement('section');
    section.className = 'xf-help';
    section.innerHTML = `<h3>Forge filters</h3><dl>${HELP.map(
      ([code, text]) =>
        `<dt>${code
          .split(' ')
          .map(part => `<code>${html(part)}</code>`)
          .join(' ')}</dt><dd>${html(text)}</dd>`
    ).join(
      ''
    )}</dl><p class="xf-muted">Synonyms (Settings › Library › Search) expand words — e.g. <code>ml = machine learning</code>. Accents are folded unless you turn it off.</p>`;
    box.append(section);
  }

  /* ───────────── Wiring ───────────── */
  window.addEventListener('xvault:no-results', event => {
    const { query, container } = event.detail || {};
    settle(query, 0);
    asOfBanner(query);
    trackAsOf([], query);
    didYouMean(query, container);
  });
  window.addEventListener('xvault:results', event => {
    const { query, count, rows } = event.detail || {};
    settle(query, count);
    asOfBanner(query);
    trackAsOf(rows, query);
  });
  document.addEventListener(
    'toggle',
    event => {
      if (event.target.matches?.('.search-help') && event.target.open) extendHelp(event.target);
    },
    true
  );
  /* ───────────── Best match blend, tunable next to the sort menu ───────────── */
  const blendText = value => {
    const weight = Number(value);
    return weight <= 0
      ? 'keywords only'
      : weight >= 1
        ? 'meaning only'
        : `${Math.round((1 - weight) * 100)}% keywords, ${Math.round(weight * 100)}% meaning`;
  };
  function mountBlend() {
    const sort = $('#sort');
    if (!sort) return;
    let box = $('#xfBlend');
    if (!box) {
      box = document.createElement('label');
      box.id = 'xfBlend';
      box.className = 'xf-blend';
      box.title = 'Best match blend: how much meaning counts next to keywords';
      box.innerHTML =
        '<span aria-hidden="true">Keywords</span><input type="range" min="0" max="1" step="0.05" aria-label="Best match blend, keywords to meaning"><span aria-hidden="true">Meaning</span>';
      sort.after(box);
      const input = box.querySelector('input');
      input.addEventListener('input', () => input.setAttribute('aria-valuetext', blendText(input.value)));
      input.addEventListener('change', async () => {
        if (typeof save === 'function') await save({ searchHybridWeight: Number(input.value) }, false);
        say(`Best match: ${blendText(input.value)}`);
        window.XVaultLibraryRunQuery?.($('#search')?.value || '');
      });
      sort.addEventListener('change', mountBlend);
    }
    box.hidden = sort.value !== 'relevance';
    const input = box.querySelector('input');
    if (document.activeElement !== input) input.value = String(Number(current().searchHybridWeight ?? 0.35));
    input.setAttribute('aria-valuetext', blendText(input.value));
  }

  function mount() {
    mountHistory();
    mountBlend();
    watchCollections();
    asOfBanner($('#search')?.value || '');
  }
  hooks?.after('page', (result, name) => {
    if (name !== 'library') return;
    mount();
    refreshAlerts();
  });
  hooks?.after('renderLib', () => {
    mount();
    if (!($('#search')?.value || '').trim()) asOfBanner('');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && $('#page-library.show')) refreshAlerts();
  });
  hooks?.commands(() => [
    {
      name: 'Search history',
      hint: 'recent and pinned searches, with result counts',
      run: () => {
        if (typeof page === 'function') page('library');
        mount();
        const menu = $('.xf-history-menu');
        if (menu) ((menu.open = true), setTimeout(() => menu.querySelector('button, input')?.focus(), 40));
      },
    },
    {
      name: 'Time travel: vault as of a day',
      hint: 'asof:YYYY-MM-DD',
      run: () => {
        if (typeof page === 'function') page('library');
        mount();
        const menu = $('.xf-history-menu');
        if (menu) ((menu.open = true), setTimeout(() => menu.querySelector('input[type="date"]')?.focus(), 40));
      },
    },
    {
      name: 'Clear search history',
      hint: 'pinned searches stay',
      run: () => {
        const list = readHistory(),
          pins = list.filter(item => item.pinned);
        writeHistory(pins);
        say(`Cleared ${list.length - pins.length} searches`);
      },
    },
    {
      name: 'Smart Collections: check for new posts',
      hint: 'new since your last visit',
      run: () => refreshAlerts(true).then(() => say('Smart Collection counts updated')),
    },
  ]);
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => setTimeout(mount, 0), { once: true });
  else setTimeout(mount, 0);
  window.XVaultForgeSearch = { readHistory, record, trimHistory, withAsOf, asOfIn, refreshAlerts };
})();
