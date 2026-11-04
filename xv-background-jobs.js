/* Background jobs panel: local OCR controls (Settings → Library) and live job status.
   Jobs run in the service worker (sw/derived-jobs.mjs) and broadcast progress on
   BroadcastChannel('xvault-derived-jobs'), so this panel is only a remote control. */
(() => {
  const jobs = { ocr: null, phash: null };
  const counts = { ocr: 0, phash: 0 };
  const number = value => fmt(Number(value) || 0);
  const active = job => ['running', 'waiting'].includes(job?.state);

  function host() {
    return document.getElementById('xvOcrPanel');
  }
  function describe(job) {
    if (!job || job.state === 'idle')
      return counts.ocr
        ? `${number(counts.ocr)} posts have searchable image text.`
        : 'Not run yet. Images are read on this computer by the bundled engine — nothing is uploaded.';
    const parts = [
      job.state === 'waiting'
        ? job.message || 'Waiting for X to allow more image requests'
        : active(job)
          ? 'Reading images in the background'
          : job.state === 'done'
            ? 'Up to date'
            : job.state === 'error'
              ? 'Stopped'
              : job.state === 'cancelled'
                ? 'Cancelled'
                : 'Paused',
      job.seen ? `${number(job.seen)} images checked` : '',
      job.processed ? `${number(job.processed)} read` : '',
      job.cached ? `${number(job.cached)} already read` : '',
      job.failed + job.skipped ? `${number(job.failed + job.skipped)} unavailable` : '',
      counts.ocr ? `${number(counts.ocr)} posts searchable with ocr:` : '',
    ];
    return parts.filter(Boolean).join(' · ') + (job.error ? ` · ${job.error}` : '');
  }
  function paint() {
    const panel = host();
    if (!panel) return;
    const job = jobs.ocr,
      running = active(job);
    panel.querySelector('[data-ocr-status]').textContent = describe(job);
    const start = panel.querySelector('[data-ocr="start"]');
    start.textContent = running
      ? 'Pause'
      : job?.state === 'paused'
        ? 'Resume'
        : job?.state === 'done'
          ? 'Read new images'
          : 'Read text in images';
    start.setAttribute('aria-pressed', String(running));
    panel.querySelector('[data-ocr="cancel"]').hidden = !running && job?.state !== 'paused';
    const meter = panel.querySelector('[data-ocr-meter]'),
      total = Math.max(1, Number(job?.total || 0), Number(job?.seen || 0));
    meter.style.transform = `scaleX(${job?.state === 'done' ? 1 : job?.seen ? Math.min(0.99, job.seen / total) : 0})`;
  }
  async function refresh() {
    const result = await call({ type: 'DERIVED_SUMMARY' }).catch(() => null);
    if (!result?.ok) return;
    Object.assign(jobs, result.jobs);
    Object.assign(counts, result.counts);
    paint();
  }
  async function act(kind) {
    const job = jobs.ocr;
    let result;
    if (kind === 'start' && active(job)) result = await call({ type: 'DERIVED_JOB_PAUSE', kind: 'ocr' });
    else if (kind === 'start') {
      const insights = await window.XVaultInsights?.().catch(() => null);
      result = await call({
        type: 'DERIVED_JOB_START',
        kind: 'ocr',
        restart: job?.state === 'done',
        total: Number(insights?.media?.photo || insights?.media?.items || 0),
      });
    } else if (kind === 'cancel') result = await call({ type: 'DERIVED_JOB_CANCEL', kind: 'ocr' });
    else if (kind === 'clear') {
      if (!confirm('Forget all recognised image text? Your archive is not changed; you can read the images again.'))
        return;
      result = await call({ type: 'DERIVED_CLEAR', kind: 'ocr' });
      counts.ocr = 0;
    }
    if (!result?.ok) toast(result?.error || 'The OCR job could not be changed');
    if (result?.job) jobs.ocr = result.job;
    paint();
  }
  function mount() {
    const panel = host();
    if (!panel || panel.dataset.ready) return;
    panel.dataset.ready = '1';
    panel.addEventListener('click', event => {
      const button = event.target.closest('[data-ocr]');
      if (button) act(button.dataset.ocr);
    });
    refresh();
  }
  /* ───────── Scheduled sync ───────── */
  let sync = null,
    syncTimer = 0;
  const when = stamp =>
    stamp ? new Date(stamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  function syncText(status) {
    if (!status) return 'Checking…';
    if (status.current)
      return `Syncing ${status.current.scope} in a background tab (${status.current.phase || 'running'}) since ${when(status.current.startedAt)}`;
    if (!status.enabled) return 'Scheduled sync is off. “Sync now” still works whenever an X tab is open.';
    if (status.paused) return 'Paused — no scheduled runs until you resume.';
    const parts = ['bookmarks', 'likes'].map(scope => {
      const last = status.lastResult?.[scope],
        next = status.next?.[scope];
      if (!next && !last) return '';
      const lastText = last
        ? last.ok
          ? `last ${when(last.at)} (+${number(last.added)})`
          : `last attempt failed: ${last.error}`
        : 'not run yet';
      return `${scope[0].toUpperCase()}${scope.slice(1)}: ${lastText}${next ? ` · next ${when(next)}` : ''}`;
    });
    if (status.waitingForTab) parts.push('Waiting for an open x.com tab');
    return parts.filter(Boolean).join(' · ') || 'Choose how often to sync Bookmarks or Likes.';
  }
  function paintSync() {
    const panel = document.getElementById('xvSyncPanel');
    if (!panel) return;
    panel.querySelector('[data-sync-status]').textContent = syncText(sync);
    const pause = panel.querySelector('[data-sync="pause"]');
    pause.textContent = sync?.paused ? 'Resume schedule' : 'Pause schedule';
    pause.setAttribute('aria-pressed', String(!!sync?.paused));
    pause.hidden = !sync?.enabled;
    panel.querySelector('[data-sync="stop"]').hidden = !sync?.current;
    panel
      .querySelectorAll('[data-sync="bookmarks"],[data-sync="likes"]')
      .forEach(button => (button.disabled = !!sync?.current));
  }
  async function refreshSync() {
    clearTimeout(syncTimer);
    const result = await call({ type: 'SYNC_STATUS' }).catch(() => null);
    if (result?.ok) sync = result;
    paintSync();
    paintViews();
    if (document.getElementById('xvSyncPanel')?.isConnected)
      syncTimer = setTimeout(refreshSync, sync?.current ? 4000 : 30000);
  }
  function paintViews() {
    const box = document.getElementById('xvSyncViews');
    if (!box) return;
    const views = window.settings?.savedViews || (typeof settings !== 'undefined' ? settings.savedViews : []) || [],
      watched = new Set(((typeof settings !== 'undefined' && settings.syncNotifyViews) || []).map(String));
    box.querySelectorAll('label').forEach(label => label.remove());
    box.querySelector('.settingHint').hidden = views.length > 0;
    for (const view of views) {
      if (!view?.id) continue;
      const label = document.createElement('label'),
        input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(view.id);
      input.checked = watched.has(String(view.id));
      input.dataset.syncView = '1';
      label.append(input, ` ${view.name || 'Untitled'} `);
      const hint = document.createElement('small');
      hint.textContent = view.query || '';
      label.append(hint);
      box.append(label);
    }
  }
  async function syncAction(kind) {
    let result;
    if (kind === 'bookmarks' || kind === 'likes') {
      toast(`Opening ${kind} in a background tab…`);
      result = await call({ type: 'SYNC_RUN_NOW', scope: kind });
    } else if (kind === 'pause') result = await call({ type: sync?.paused ? 'SYNC_RESUME' : 'SYNC_PAUSE' });
    else if (kind === 'stop') result = await call({ type: 'SYNC_STOP' });
    if (result && result.ok === false) toast(result.error || 'Sync could not start');
    await refreshSync();
  }
  function mountSync() {
    const panel = document.getElementById('xvSyncPanel');
    if (!panel || panel.dataset.ready) return;
    panel.dataset.ready = '1';
    panel.addEventListener('click', event => {
      const button = event.target.closest('[data-sync]');
      if (button) syncAction(button.dataset.sync);
    });
    document.getElementById('xvSyncViews')?.addEventListener('change', async event => {
      if (!event.target.matches('[data-sync-view]')) return;
      const ids = [...document.querySelectorAll('#xvSyncViews [data-sync-view]:checked')].map(input => input.value);
      await save({ syncNotifyViews: ids });
    });
    document.querySelector('#g-sync')?.addEventListener('change', event => {
      if (event.target.matches('[data-setting]')) setTimeout(refreshSync, 400);
    });
    refreshSync();
  }

  try {
    new BroadcastChannel('xvault-derived-jobs').onmessage = event => {
      const message = event.data || {};
      if (message.type !== 'DERIVED_JOB') return;
      const before = jobs[message.kind]?.state;
      jobs[message.kind] = message.job;
      if (message.kind === 'ocr' && message.job.state !== before) refresh();
      else paint();
    };
  } catch {}
  const mountAll = () => {
    mount();
    mountSync();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll, { once: true });
  else mountAll();

  window.XVaultDashboard.commands(() => [
    {
      name: 'Read text in images (local OCR)',
      hint: 'makes ocr: searches work · runs in the background',
      run: () => act('start'),
    },
    {
      name: 'Sync bookmarks now',
      hint: 'reads the newest bookmarks in a background X tab',
      run: () => syncAction('bookmarks'),
    },
    { name: 'Sync likes now', hint: 'reads the newest likes in a background X tab', run: () => syncAction('likes') },
  ]);
  window.XVaultBackgroundJobs = { refresh, refreshSync, jobs, counts };
})();
