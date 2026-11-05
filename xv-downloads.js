/* XVault 23 Downloads page: one owner for the queue view (replaces dashboard.js builtinQueueStats).
   Honest progress (a percentage only when Chrome knows the sizes, otherwise an indeterminate bar), a pause you
   choose that survives restarts, live transfers with their own controls, a speed history drawn from real
   samples, and a filterable, keyed history list that updates in place instead of being rebuilt every tick. */
(() => {
  const hooks = window.XVaultDashboard;
  if (!hooks) return;
  const $ = selector => document.querySelector(selector);
  const send = async message => {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };
  const html = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );
  const number = value => (value == null ? '—' : new Intl.NumberFormat().format(value));
  const size = value => {
    if (value == null) return '—';
    let amount = Number(value) || 0,
      unit = 0;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    while (amount >= 1024 && unit < units.length - 1) {
      amount /= 1024;
      unit++;
    }
    return `${amount.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  };
  const eta = seconds =>
    seconds == null || !isFinite(seconds)
      ? '—'
      : seconds < 60
        ? `${Math.ceil(seconds)}s`
        : seconds < 3600
          ? `${Math.ceil(seconds / 60)}m`
          : `${(seconds / 3600).toFixed(1)}h`;
  const ago = stamp => {
    const delta = Date.now() - Number(stamp || 0);
    if (!stamp || delta < 0) return '';
    if (delta < 60000) return 'just now';
    if (delta < 3600000) return `${Math.round(delta / 60000)} min ago`;
    if (delta < 86400000) return `${Math.round(delta / 3600000)} h ago`;
    return new Date(Number(stamp)).toLocaleDateString();
  };
  const calm = () => !!window.XVaultMotion?.calm?.();

  const state = {
    tick: 0,
    filter: 'all',
    query: '',
    rows: [],
    speeds: [],
    last: null,
    counts: {},
    busy: false,
  };
  const FILTERS = [
    ['all', 'All'],
    ['active', 'Active'],
    ['failed', 'Failed'],
    ['complete', 'Complete'],
    ['waiting', 'Waiting'],
  ];
  const ACTIVE = new Set(['downloading', 'paused', 'verifying', 'converting']);
  const WAITING = new Set(['queued', 'retry-wait']);
  const matches = (row, filter) =>
    filter === 'all' ||
    (filter === 'active' && ACTIVE.has(row.state)) ||
    (filter === 'waiting' && WAITING.has(row.state)) ||
    row.state === filter;

  function ensureLayout() {
    const page = $('#page-media');
    if (!page || page.dataset.xd === '1') return page;
    page.dataset.xd = '1';
    page.classList.add('xd-page');
    // Stat tiles double as history filters for the pointer; keyboard and screen-reader users have the same
    // filters as buttons above the history (a <dl> cannot hold buttons).
    page.querySelectorAll('.queue-stats > div').forEach((tile, index) => {
      tile.dataset.xdFilter = ['waiting', 'active', 'complete', 'failed'][index];
      tile.title = `Show ${tile.querySelector('dt')?.textContent || 'these'} downloads`;
    });
    const row = page.querySelector('.panelhead .row');
    if (row && !row.querySelector('#xdPause')) {
      const pause = document.createElement('button');
      pause.type = 'button';
      pause.id = 'xdPause';
      pause.className = 'primary';
      pause.textContent = 'Pause queue';
      row.prepend(pause);
      const more = document.createElement('details');
      more.className = 'xd-more';
      more.innerHTML =
        '<summary>More</summary><div class="xd-menu" role="group" aria-label="More queue actions"></div>';
      const menu = more.querySelector('.xd-menu');
      for (const id of ['rebuildTargets', 'clearCompleted', 'clearFailed', 'openDownloads']) {
        const button = row.querySelector(`#${id}`);
        if (button) menu.append(button);
      }
      row.append(more);
      document.addEventListener('click', event => {
        if (more.open && !more.contains(event.target)) more.open = false;
      });
    }
    const head = page.querySelector('.panelhead');
    if (head && !$('#xdHold')) {
      const hold = document.createElement('p');
      hold.id = 'xdHold';
      hold.className = 'xd-hold';
      hold.setAttribute('role', 'status');
      hold.hidden = true;
      head.after(hold);
    }
    const mega = page.querySelector('.mega');
    if (mega && !$('#xdSpark')) {
      mega.insertAdjacentHTML(
        'beforeend',
        '<svg id="xdSpark" class="xd-spark" viewBox="0 0 120 28" preserveAspectRatio="none" role="img" aria-label="Transfer speed, last two minutes"><path class="xd-spark-area" d=""></path><path class="xd-spark-line" d=""></path></svg>'
      );
    }
    const history = $('#downloadHistory');
    if (history && !$('#xdActive')) {
      history.insertAdjacentHTML(
        'beforebegin',
        `<section id="xdActive" class="xd-active" aria-label="Transferring now" hidden></section><section id="xdHosts" class="xd-hosts" aria-labelledby="xdHostsTitle" hidden><header><h3 id="xdHostsTitle">Media hosts</h3><small>Pause one source without stopping the others · counts from the last 200 downloads</small></header><div class="xd-hostlist" role="list"></div></section><div class="xd-historybar"><div class="seg xd-filters" role="group" aria-label="Filter download history">${FILTERS.map(
          ([key, label]) =>
            `<button type="button" data-xd-filter="${key}" aria-pressed="${key === 'all'}">${label}<span class="xd-n"></span></button>`
        ).join(
          ''
        )}</div><input id="xdSearch" type="search" placeholder="File, post or reason" aria-label="Search download history" autocomplete="off"></div>`
      );
      history.setAttribute('role', 'list');
      history.setAttribute('aria-label', 'Download history');
      history.querySelectorAll(':scope > *').forEach(child => child.setAttribute('role', 'listitem'));
    }
    // The older filter/pause strip (bulk-download-ui.js) is superseded by the controls above.
    page.querySelector('#xvQueueTools')?.remove();
    page.addEventListener('click', onClick);
    $('#xdSearch')?.addEventListener('input', event => {
      state.query = event.target.value.trim().toLowerCase();
      paintHistory();
    });
    return page;
  }

  function setFilter(filter) {
    state.filter = filter;
    document
      .querySelectorAll('#page-media [data-xd-filter]')
      .forEach(node =>
        node.matches('button')
          ? node.setAttribute('aria-pressed', String(node.dataset.xdFilter === filter))
          : node.classList.toggle('is-filter', node.dataset.xdFilter === filter)
      );
    paintHistory();
    if (filter !== 'all')
      $('#downloadHistory')?.scrollIntoView({ block: 'nearest', behavior: calm() ? 'auto' : 'smooth' });
  }

  async function onClick(event) {
    const filter = event.target.closest('[data-xd-filter]');
    if (filter)
      return setFilter(
        filter.dataset.xdFilter === state.filter && !filter.matches('button') ? 'all' : filter.dataset.xdFilter
      );
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.xdHost) return hostAction(button);
    if (button.id === 'xdPause') {
      button.disabled = true;
      const resume = state.last?.pausedByUser;
      const result = await send({ type: resume ? 'RESUME_ALL_DOWNLOADS' : 'PAUSE_ALL_DOWNLOADS' });
      button.disabled = false;
      window.toast?.(
        result?.ok
          ? resume
            ? `Queue resumed${result.resumed ? ` · ${result.resumed} ${result.resumed === 1 ? 'transfer continues' : 'transfers continue'}` : ''}`
            : `Queue paused${result.paused ? ` · ${result.paused} ${result.paused === 1 ? 'transfer' : 'transfers'} held` : ''} — it stays paused after a restart`
          : result?.error || 'Could not change the queue',
        { tone: result?.ok ? 'success' : 'error' }
      );
      return refresh();
    }
    const act = button.dataset.xd;
    if (!act) return;
    const id = Number(button.dataset.id) || 0,
      key = button.dataset.key || '';
    const run = {
      pause: () => send({ type: 'PAUSE_DOWNLOAD', downloadId: id }),
      resume: () => send({ type: 'RESUME_DOWNLOAD', downloadId: id }),
      cancel: () => send({ type: 'CANCEL_DOWNLOAD', downloadId: id }),
      retry: () => send({ type: 'FORCE_REDOWNLOAD', key }),
      show: () => send({ type: 'SHOW_DOWNLOAD', downloadId: id }),
      source: () => send({ type: 'OPEN_DOWNLOAD_SOURCE', url: button.dataset.url }),
      'retry-conversion': () => send({ type: 'RETRY_CONVERSION', key }),
      'cancel-conversion': () => send({ type: 'CANCEL_CONVERSION', key }),
      copy: async () => {
        await navigator.clipboard?.writeText(button.dataset.text || '').catch(() => {});
        return { ok: true, silent: true, message: 'Reason copied' };
      },
    }[act];
    if (!run) return;
    button.disabled = true;
    const result = await run();
    button.disabled = false;
    if (result?.ok === false) window.toast?.(result.error || 'That did not work', { tone: 'error' });
    else if (act === 'retry') window.toast?.('Queued again', { tone: 'success' });
    else if (result?.message) window.toast?.(result.message, { tone: 'success' });
    state.tick = 0;
    refresh();
  }

  // ── Progress, speed and live transfers ──
  function paintProgress(q) {
    const known = q.totalBytes > 0 && q.bytesReceived <= q.totalBytes;
    const pct = known ? Math.min(100, Math.round((q.bytesReceived / q.totalBytes) * 100)) : null;
    const bar = $('#qBar'),
      track = bar?.parentElement;
    const moving = q.downloading > 0 || (q.activeRows || []).some(row => row.state === 'downloading');
    $('#qPercent').textContent = pct == null ? (moving ? '…' : q.complete && !q.queued ? '100%' : '—') : `${pct}%`;
    $('#qPercent').classList.toggle('is-empty', pct == null && !moving && !(q.complete && !q.queued));
    $('#qPercent').title =
      pct == null && moving ? 'Some servers do not send file sizes, so no percentage is shown' : '';
    track?.classList.toggle('is-indeterminate', pct == null && moving);
    if (bar) bar.style.width = pct == null ? (moving ? '' : '0%') : `${pct}%`;
    track?.setAttribute('role', 'progressbar');
    track?.setAttribute('aria-label', 'Download queue progress');
    if (pct == null) track?.removeAttribute('aria-valuenow');
    else track?.setAttribute('aria-valuenow', String(pct));
    $('#qSpeed').textContent = moving ? `${size(q.speedBps)}/s` : 'idle';
    $('#qEta').textContent = q.etaSeconds != null && moving ? `ETA ${eta(q.etaSeconds)}` : 'ETA —';
    $('#qBytes').textContent = `${size(q.bytesReceived)} / ${q.totalBytes ? size(q.totalBytes) : '—'}`;
    $('#qCount').textContent = q.countsReady
      ? `${number(q.complete)} complete · ${number(q.failed)} failed${q.verificationFailures ? ` · ${number(q.verificationFailures)} verification failures` : ''}`
      : 'Queue history is being indexed; active transfer progress remains live.';
    // Speed history: one real sample per poll, two minutes, drawn only while something has moved.
    state.speeds.push(moving ? Number(q.speedBps) || 0 : 0);
    if (state.speeds.length > 120) state.speeds.shift();
    const spark = $('#xdSpark');
    if (spark) {
      const max = Math.max(1, ...state.speeds),
        points = state.speeds.map((value, index) => [
          (index / Math.max(1, 119)) * 120 + (120 - ((state.speeds.length - 1) / 119) * 120),
          26 - (value / max) * 24,
        ]);
      const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      spark.querySelector('.xd-spark-line').setAttribute('d', line);
      spark
        .querySelector('.xd-spark-area')
        .setAttribute('d', points.length ? `${line} L120,28 L${points[0][0].toFixed(1)},28 Z` : '');
      spark.classList.toggle('is-idle', !state.speeds.some(Boolean));
      spark.setAttribute('aria-label', `Transfer speed, peak ${size(max)}/s in the last two minutes`);
    }
  }

  function paintHold(q) {
    const node = $('#xdHold'),
      pause = $('#xdPause');
    if (pause) {
      pause.textContent = q.pausedByUser ? 'Resume queue' : 'Pause queue';
      pause.setAttribute('aria-pressed', String(!!q.pausedByUser));
      pause.classList.toggle('is-paused', !!q.pausedByUser);
    }
    if (!node) return;
    const hold = q.hold;
    node.hidden = !hold;
    if (hold)
      node.innerHTML = `<b>${hold.code === 'paused' ? 'Paused' : 'Waiting'}</b> ${html(hold.message)}${hold.since ? ` · since ${html(ago(hold.since))}` : ''}${hold.code === 'paused' ? '' : ' · Settings › Downloads'}`;
    node.dataset.code = hold?.code || '';
  }

  function paintActive(q) {
    const lane = $('#xdActive');
    if (!lane) return;
    const rows = q.activeRows || [];
    lane.hidden = !rows.length;
    const seen = new Set();
    rows.forEach((row, index) => {
      seen.add(row.key);
      let card = lane.querySelector(`[data-key="${CSS.escape(row.key)}"]`);
      if (!card) {
        card = document.createElement('article');
        card.className = 'xd-transfer';
        card.dataset.key = row.key;
        card.innerHTML =
          '<div class="xd-transfer-head"><b></b><span class="xd-transfer-actions"></span></div><div class="xd-meter" role="progressbar"><i></i></div><small></small>';
        lane.append(card);
        if (!calm()) window.XVaultMotion?.enter?.(card, 'rise', { duration: 260, delay: index * 30 });
      }
      const known = row.totalBytes > 0,
        pct = known ? Math.min(100, (row.bytesReceived / row.totalBytes) * 100) : null;
      card.querySelector('b').textContent = row.name || 'media';
      card.querySelector('b').title = row.name || '';
      const meter = card.querySelector('.xd-meter');
      meter.classList.toggle('is-indeterminate', pct == null && row.state === 'downloading');
      meter.setAttribute('aria-label', `${row.name || 'File'} progress`);
      if (pct == null) meter.removeAttribute('aria-valuenow');
      else meter.setAttribute('aria-valuenow', String(Math.round(pct)));
      meter.querySelector('i').style.width = pct == null ? '' : `${pct.toFixed(1)}%`;
      card.dataset.state = row.state;
      card.querySelector('small').textContent = [
        row.state === 'downloading' ? null : row.state,
        known
          ? `${size(row.bytesReceived)} of ${size(row.totalBytes)}`
          : row.bytesReceived
            ? `${size(row.bytesReceived)} so far`
            : 'starting',
        row.state === 'downloading' && row.speedBps > 0 ? `${size(row.speedBps)}/s` : null,
        row.kind || null,
      ]
        .filter(Boolean)
        .join(' · ');
      const actions =
        row.downloadId > 0
          ? `${row.state === 'paused' ? `<button type="button" class="mini" data-xd="resume" data-id="${row.downloadId}">Resume</button>` : row.state === 'downloading' ? `<button type="button" class="mini" data-xd="pause" data-id="${row.downloadId}">Pause</button>` : ''}<button type="button" class="mini quiet" data-xd="cancel" data-id="${row.downloadId}" aria-label="Cancel ${html(row.name)}">Cancel</button>`
          : '';
      const holder = card.querySelector('.xd-transfer-actions');
      if (holder.dataset.sig !== actions) {
        holder.innerHTML = actions;
        holder.dataset.sig = actions;
      }
    });
    lane.querySelectorAll('.xd-transfer').forEach(card => {
      if (seen.has(card.dataset.key)) return;
      if (calm()) return card.remove();
      card.classList.add('is-leaving');
      setTimeout(() => card.remove(), 260);
    });
  }

  function paintCounts(q) {
    const set = (id, value) => {
      const node = $(id);
      if (!node) return;
      const next = Number(value) || 0,
        previous = Number(node.dataset.value || 0);
      node.dataset.value = String(next);
      if (value == null) return (node.textContent = '—');
      if (previous !== next && !calm() && window.XVaultMotion?.countUp && node.dataset.counted === '1')
        window.XVaultMotion.countUp(node, next, { from: previous, duration: 420 });
      else node.textContent = number(next);
      node.dataset.counted = '1';
    };
    set('#qQueued', q.queued == null ? null : (q.queued || 0) + (q.retryWait || 0));
    set('#qActive', q.downloading);
    set('#qDone', q.complete);
    set('#qFailed', q.failed);
    $('#qTitle').textContent = q.pausedByUser
      ? 'Paused'
      : q.downloading
        ? `Downloading ${number(q.downloading)}${q.countsReady ? '' : ' · totals rebuilding'}`
        : !q.countsReady
          ? 'Rebuilding queue totals…'
          : q.hold
            ? 'Waiting'
            : q.retryWait
              ? `${number(q.retryWait)} waiting to retry`
              : q.queued
                ? `${number(q.queued)} queued`
                : q.failed
                  ? 'Finished with errors'
                  : 'Idle';
  }

  // ── History: keyed rows, updated in place ──
  function verification(row) {
    const value = row.verification?.state || row.conversionVerification?.state || '';
    return (
      {
        verified: 'verified',
        'size-match': 'verified',
        mismatch: 'size mismatch',
        corrupt: 'corrupt',
        missing: 'missing on disk',
      }[value] || ''
    );
  }
  function rowMarkup(row) {
    const name = (row.target?.filename || row.item?.url || 'media').split('/').pop();
    // XVault 26: the plain-language explanation first; Chrome's raw code stays available on hover and in Copy.
    const raw = row.verification?.reason || row.error || '',
      reason = row.verification?.reason || row.errorHelp || row.error || '';
    const bits = [
      row.target?.kind || row.item?.mediaType || 'media',
      row.state,
      row.totalBytes ? size(row.totalBytes) : null,
      verification(row) || null,
      ago(row.completedAt || row.updatedAt || row.createdAt) || null,
    ].filter(Boolean);
    const actions = [];
    if (row.state === 'failed' || row.state === 'cancelled')
      actions.push(`<button type="button" class="mini" data-xd="retry" data-key="${html(row.key)}">Retry</button>`);
    if (row.state === 'complete' && Number(row.downloadId) > 0 && !row.reclaimedAt)
      actions.push(
        `<button type="button" class="mini quiet" data-xd="show" data-id="${Number(row.downloadId)}">Show in folder</button>`
      );
    if (row.recoveryAction === 'open-source-post' && row.item?.sourcePostUrl)
      actions.push(
        `<button type="button" class="mini quiet" data-xd="source" data-url="${html(row.item.sourcePostUrl)}">Open source post</button>`
      );
    if (
      row.conversionState === 'failed' ||
      ['mismatch', 'corrupt', 'missing'].includes(row.conversionVerification?.state)
    )
      actions.push(
        `<button type="button" class="mini" data-xd="retry-conversion" data-key="${html(row.key)}">Regenerate derivative</button>`
      );
    else if (row.conversionState === 'running')
      actions.push(
        `<button type="button" class="mini quiet" data-xd="cancel-conversion" data-key="${html(row.key)}">Cancel conversion</button>`
      );
    if (reason)
      actions.push(
        `<button type="button" class="mini quiet" data-xd="copy" data-text="${html(raw && raw !== reason ? `${reason} (${raw})` : reason)}" aria-label="Copy the failure reason">Copy reason</button>`
      );
    return `<span class="xd-dot" aria-hidden="true"></span><div><b title="${html(name)}">${html(name)}</b><small>${html(bits.join(' · '))}${reason ? ` · <span class="xd-reason"${raw && raw !== reason ? ` title="${html(raw)}"` : ''}>${html(reason.slice(0, 160))}</span>` : ''}</small></div><span class="xd-actions">${actions.join('')}</span>`;
  }
  function searchable(row) {
    return [
      row.target?.filename,
      row.item?.url,
      row.item?.tweetId,
      row.item?.author,
      row.error,
      row.verification?.reason,
      row.state,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }
  function paintHistory() {
    const list = $('#downloadHistory');
    if (!list) return;
    const counts = Object.fromEntries(
      FILTERS.map(([key]) => [key, state.rows.filter(row => matches(row, key)).length])
    );
    document.querySelectorAll('#page-media .xd-filters [data-xd-filter]').forEach(button => {
      const count = counts[button.dataset.xdFilter];
      button.querySelector('.xd-n').textContent = count ? ` ${number(count)}` : '';
    });
    const rows = state.rows.filter(
      row => matches(row, state.filter) && (!state.query || searchable(row).includes(state.query))
    );
    list.querySelector(':scope > .empty')?.remove();
    const existing = new Map([...list.querySelectorAll(':scope > .dlrow')].map(node => [node.dataset.key, node]));
    const fresh = [];
    let previous = null;
    for (const row of rows.slice(0, 200)) {
      const key = String(row.key);
      let node = existing.get(key);
      const markup = rowMarkup(row);
      if (!node) {
        node = document.createElement('div');
        node.dataset.key = key;
        node.setAttribute('role', 'listitem');
        fresh.push(node);
      }
      existing.delete(key);
      node.className = `dlrow xd-row ${row.state}`;
      if (node.dataset.sig !== markup) {
        node.innerHTML = markup;
        node.dataset.sig = markup;
      }
      const anchor = previous ? previous.nextSibling : list.firstChild;
      if (anchor !== node) list.insertBefore(node, anchor);
      previous = node;
    }
    existing.forEach(node => node.remove());
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.setAttribute('role', 'listitem');
      empty.textContent = state.rows.length
        ? state.query
          ? 'No downloads match this search.'
          : 'Nothing in this view.'
        : 'No downloads yet.';
      list.append(empty);
    }
    // New rows ease in (only after the first paint, so opening the page does not animate everything).
    if (state.painted && !calm())
      fresh
        .slice(0, 12)
        .forEach((node, index) => window.XVaultMotion?.enter?.(node, 'rise', { duration: 240, delay: index * 25 }));
    state.painted = true;
  }

  // XVault 25: per-host controls. X serves images from pbs.twimg.com and video from video.twimg.com; pausing a host
  // holds its queued files (in-flight transfers finish) while the rest of the queue keeps moving.
  const HOST_LABEL = { 'pbs.twimg.com': 'Images', 'video.twimg.com': 'Video and GIFs' };
  const hostOf = row => {
    try {
      return new URL(String(row?.item?.url || '')).hostname.toLowerCase();
    } catch {
      return '';
    }
  };
  function paintHosts() {
    const section = $('#xdHosts'),
      list = section?.querySelector('.xd-hostlist');
    if (!list) return;
    const paused = new Set(state.last?.pausedHosts || []),
      cooling = new Map((state.last?.coolingHosts || []).map(row => [row.host, row])),
      hosts = new Map();
    const entry = host => {
      if (!hosts.has(host))
        hosts.set(host, { host, active: 0, waiting: 0, complete: 0, failed: 0, reasons: new Map() });
      return hosts.get(host);
    };
    for (const host of paused) entry(host);
    for (const host of cooling.keys()) entry(host);
    for (const row of state.rows) {
      const host = hostOf(row);
      if (!host) continue;
      const item = entry(host);
      if (ACTIVE.has(row.state)) item.active++;
      else if (WAITING.has(row.state)) item.waiting++;
      else if (row.state === 'complete') item.complete++;
      else if (row.state === 'failed') {
        item.failed++;
        const reason = String(row.error || row.failureReason || 'Unknown error')
          .replace(/\s+/g, ' ')
          .slice(0, 80);
        item.reasons.set(reason, (item.reasons.get(reason) || 0) + 1);
      }
    }
    for (const row of state.last?.activeRows || []) if (row.host && !hosts.has(row.host)) entry(row.host).active++;
    section.hidden = !hosts.size;
    const rows = [...hosts.values()].sort(
      (a, b) =>
        Number(paused.has(b.host) || cooling.has(b.host)) - Number(paused.has(a.host) || cooling.has(a.host)) ||
        b.active + b.waiting + b.failed + b.complete - (a.active + a.waiting + a.failed + a.complete)
    );
    const markup = rows
      .map(item => {
        const isPaused = paused.has(item.host),
          [reason, times] = [...item.reasons.entries()].sort((a, b) => b[1] - a[1])[0] || [],
          cool = !isPaused && cooling.get(item.host),
          facts = [
            isPaused ? 'Paused · queued files wait' : null,
            cool
              ? `Refusing downloads · waiting ${Math.max(1, Math.round((cool.until - Date.now()) / 1000))} s, other hosts continue`
              : null,
            item.active ? `${number(item.active)} active` : null,
            item.waiting ? `${number(item.waiting)} waiting` : null,
            item.complete ? `${number(item.complete)} done` : null,
            item.failed ? `${number(item.failed)} failed` : null,
          ].filter(Boolean);
        return `<div class="xd-host${isPaused ? ' is-paused' : cool ? ' is-cooling' : ''}" role="listitem" data-host="${html(item.host)}"><span class="xd-host-name"><b>${html(HOST_LABEL[item.host] || item.host)}</b>${HOST_LABEL[item.host] ? `<small>${html(item.host)}</small>` : ''}</span><span class="xd-host-facts">${html(facts.join(' · ') || 'Nothing recent')}${reason ? `<small title="${html(reason)}">Most common problem: ${html(reason)}${times > 1 ? ` (${number(times)}×)` : ''}</small>` : ''}</span><span class="xd-host-actions">${cool ? `<button type="button" class="quiet" data-xd-host="now" aria-label="Try downloads from ${html(item.host)} now">Try now</button>` : ''}${item.failed ? `<button type="button" class="quiet" data-xd-host="retry">Retry failed</button>` : ''}<button type="button" data-xd-host="toggle" aria-pressed="${isPaused}" aria-label="${isPaused ? 'Resume' : 'Pause'} downloads from ${html(item.host)}">${isPaused ? 'Resume' : 'Pause'}</button></span></div>`;
      })
      .join('');
    if (list.dataset.sig !== markup) {
      list.innerHTML = markup;
      list.dataset.sig = markup;
    }
  }
  async function hostAction(button) {
    const host = button.closest('[data-host]')?.dataset.host;
    if (!host) return;
    button.disabled = true;
    const pausedNow = (state.last?.pausedHosts || []).includes(host);
    const result =
      button.dataset.xdHost === 'retry'
        ? await send({ type: 'RETRY_FAILED', host })
        : await send({
            type: 'SET_DOWNLOAD_HOST_PAUSED',
            host,
            paused: button.dataset.xdHost === 'now' ? false : !pausedNow,
          });
    button.disabled = false;
    if (!result?.ok) return window.toast?.(result?.error || 'That did not work', 'error');
    if (button.dataset.xdHost === 'retry')
      window.toast?.(result.added ? `Retrying ${number(result.added)} from ${host}` : `Nothing to retry from ${host}`);
    else if (button.dataset.xdHost === 'now') {
      if (state.last) state.last.coolingHosts = (state.last.coolingHosts || []).filter(row => row.host !== host);
      window.toast?.(`Trying ${host} again now`);
    } else {
      if (state.last) state.last.pausedHosts = result.pausedHosts || [];
      window.toast?.(pausedNow ? `Downloads from ${host} resumed` : `Downloads from ${host} paused`);
    }
    paintHosts();
    void refresh();
  }

  async function loadHistory() {
    const history = await send({ type: 'GET_DOWNLOAD_HISTORY', limit: 200 });
    if (!history?.ok) return;
    state.rows = history.rows || [];
    paintHistory();
    paintHosts();
  }

  // XVault 26: the dashboard polls queueStats every second for the status pill. Painting the Downloads page
  // (counts, transfers, hosts, and every fifth tick the 200-row history) while another page is open cost a few ms
  // of main thread per second and contended with Library work; it now only paints while the page is visible and
  // catches up the moment it is opened.
  const pageVisible = () => {
    const page = $('#page-media');
    return !!page && !document.hidden && (page.classList.contains('show') || page.classList.contains('active'));
  };
  async function refresh({ force = false } = {}) {
    const q = await send({ type: 'DOWNLOAD_QUEUE_STATS' });
    if (!q?.ok || !$('#qQueued')) return q;
    state.last = q;
    if (!force && !pageVisible()) {
      state.stale = true;
      return q;
    }
    state.stale = false;
    ensureLayout();
    paintCounts(q);
    paintHold(q);
    paintProgress(q);
    paintActive(q);
    paintHosts();
    // The parallelism note (xv-vault.js) reads best under the byte totals rather than between number and bar.
    const engine = $('#qEngine'),
      meta = $('#page-media .qmeta');
    if (engine && meta && engine.previousElementSibling !== meta) meta.after(engine);
    // History is heavier: on the first paint, when the totals move, and every third tick.
    const changed =
      state.counts.complete !== q.complete || state.counts.failed !== q.failed || state.counts.queued !== q.queued;
    state.counts = { complete: q.complete, failed: q.failed, queued: q.queued };
    if (state.tick === 0 || force || changed || state.tick % 3 === 0) await loadHistory();
    state.tick++;
    return q;
  }

  hooks.provide('queueStats', () => async () => {
    if (state.busy) return state.last;
    state.busy = true;
    try {
      return await refresh();
    } finally {
      state.busy = false;
    }
  });
  hooks.after?.('page', (result, name) => {
    if (name === 'media' || name === 'files') void refresh({ force: true }).catch(() => {});
  });
  const openWith = filter => {
    page('media');
    setTimeout(() => setFilter(filter), 60);
  };
  hooks.commands(() => [
    state.last?.pausedByUser
      ? {
          name: 'Resume download queue',
          hint: 'continue held transfers and start waiting files',
          run: () => $('#xdPause')?.click(),
        }
      : {
          name: 'Pause download queue',
          hint: 'hold transfers; stays paused after a restart',
          run: () => $('#xdPause')?.click(),
        },
    { name: 'Failed downloads', hint: 'retry or copy the reason', run: () => openWith('failed') },
    { name: 'Downloads in progress', hint: 'live transfers', run: () => openWith('active') },
  ]);
  window.XVaultDownloads = { refresh, setFilter, state };
})();
