/* XVault 21 "Forge" — dashboard surfaces for the archive-quality, download-health and topic services.
   Capture › Quality: quality report, repair / thread-gap / still-on-X visit queues (one background X tab,
   daily caps, ETA, history), change tracking and watch lists. Downloads › Files & health: hold state,
   bandwidth, per-host health, duplicate reclaim, scheduled re-verification and safe renames. Atlas › Topics:
   meaning clusters that open as cluster:/topic: searches. New archive: presets, live rate/ETA, run history. */
(() => {
  const $ = selector => document.querySelector(selector);
  const html = value => (typeof esc === 'function' ? esc(value) : String(value ?? ''));
  const n = value => (typeof fmt === 'function' ? fmt(Number(value) || 0) : String(Number(value) || 0));
  const say = message => (typeof toast === 'function' ? toast(message) : undefined);
  const hooks = window.XVaultDashboard;
  const bytes = value => {
    const size = Number(value) || 0;
    if (size < 1024) return `${size} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = size / 1024,
      unit = 0;
    while (amount >= 1024 && unit < units.length - 1) ((amount /= 1024), unit++);
    return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
  };
  const duration = ms => {
    const minutes = Math.round((Number(ms) || 0) / 60000);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  };
  const when = stamp =>
    stamp ? new Date(stamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
  const shown = name => !!$(`#page-${name}.show`);
  const openLibrary = (query, sort = null) => {
    page('library');
    if (window.XVaultLibraryRunQuery) window.XVaultLibraryRunQuery(query, sort);
    else window.XVaultOpenLibrarySearch?.(query);
  };
  const ask = async message => {
    try {
      return await call(message);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };

  function ensurePage(id, afterId, label) {
    let node = $(`#page-${id}`);
    if (node) return node;
    node = document.createElement('section');
    node.className = 'page';
    node.id = `page-${id}`;
    node.setAttribute('aria-label', label);
    ($(`#page-${afterId}`) || $('.page:last-of-type'))?.after(node);
    return node;
  }

  /* ───────────── Capture › Quality ───────────── */
  const KIND = {
    repair: ['Repair incomplete posts', 'Revisits posts missing media sizes, authors or text so X fills them in.'],
    gaps: ['Fill thread gaps', 'Fetches parents and quoted posts your archive points to but does not have.'],
    check: ['Still on X?', 'Visits posts to notice deletions, suspensions and withheld posts. Nothing is removed.'],
  };
  const REASONS = {
    text: 'text',
    author: 'author details',
    'author-name': 'author name',
    avatar: 'avatar',
    created: 'post date',
    metrics: 'engagement numbers',
    'media-size': 'media sizes',
    'media-preview': 'media previews',
    'media-video': 'video variants',
    'quoted-missing': 'quoted post',
    'parent-missing': 'parent post',
    links: 'link targets',
    language: 'language',
  };
  const qualityState = { report: null, visit: null, watch: null, timer: 0, loading: null };

  function qualitySkeleton() {
    const root = ensurePage('quality', 'sessions', 'Archive quality');
    if (root.dataset.ready) return root;
    root.dataset.ready = '1';
    root.innerHTML = `<h2 class="xv-sr-only">Archive quality</h2>
<div class="xf-grid">
<section class="panel xf-wide" aria-labelledby="xfQualityTitle"><div class="panelhead"><div><h3 id="xfQualityTitle">How complete is your archive?</h3><p>Every post gets a completeness score from what XVault kept: text, author, dates, engagement, media sizes and previews, quoted and parent posts. Posts under 70 count as incomplete (<code>is:incomplete</code>); search <code>quality:&lt;50</code> for the worst or sort by “Least complete”.</p></div><button type="button" data-fq="refresh">Recount</button></div><div id="xfQuality" class="xf-quality" aria-live="polite"><p class="xf-muted">Counting…</p></div></section>
<section class="panel xf-wide" aria-labelledby="xfQueuesTitle"><div class="panelhead"><div><h3 id="xfQueuesTitle">Background visits</h3><p>One X tab at a time, paced like a person reading, with a daily limit for each kind. Pause or cancel at any time; queues resume after Chrome restarts.</p></div></div><div id="xfVisit" class="xf-visit" aria-live="polite"></div><div id="xfQueues" class="xf-queues"></div></section>
<section class="panel" aria-labelledby="xfChangesTitle"><div class="panelhead"><div><h3 id="xfChangesTitle">Changes and deletions</h3><p>When X shows XVault a different version of a post, the earlier one is kept (open the post in the Reader › History). Posts that disappear stay in your archive, marked.</p></div></div><div id="xfChanges"></div></section>
<section class="panel" aria-labelledby="xfThreadsTitle"><div class="panelhead"><div><h3 id="xfThreadsTitle">Threads with missing posts</h3><p>Conversations you archived part of. “Fetch the rest” queues only that thread.</p></div></div><div id="xfThreads"></div></section>
<section class="panel xf-wide" aria-labelledby="xfWatchTitle"><div class="panelhead"><div><h3 id="xfWatchTitle">Watch lists</h3><p>Accounts and searches XVault checks on a schedule in a background tab, archiving what is new and stopping when it reaches posts it already has.</p></div></div><div id="xfWatch"></div>
<form id="xfWatchForm" class="xf-watch-form" autocomplete="off"><label class="field"><span>Watch</span><select name="kind"><option value="author">Account</option><option value="search">Search on X</option></select></label><label class="field"><span>Handle or search</span><input name="value" required maxlength="200" placeholder="nasa or &quot;james webb&quot; filter:media"></label><label class="field"><span>Every</span><select name="everyHours"><option value="6">6 hours</option><option value="12">12 hours</option><option value="24" selected>day</option><option value="72">3 days</option><option value="168">week</option></select></label><label class="field"><span>Pages</span><input name="maxPages" type="number" min="1" max="10" value="2"></label><button type="submit" class="primary">Add</button></form></section>
<section class="panel xf-wide" aria-labelledby="xfHistoryTitle"><div class="panelhead"><div><h3 id="xfHistoryTitle">Recent visit queues</h3></div></div><div id="xfHistory"></div></section>
</div>`;
    root.addEventListener('click', onQualityClick);
    root.querySelector('#xfWatchForm').addEventListener('submit', addWatch);
    return root;
  }

  async function paintQuality({ force = false } = {}) {
    qualitySkeleton();
    if (qualityState.loading && !force) return qualityState.loading;
    qualityState.loading = (async () => {
      const [report, watch] = await Promise.all([ask({ type: 'QUALITY_REPORT' }), ask({ type: 'WATCH_STATUS' })]);
      qualityState.report = report;
      qualityState.watch = watch;
      paintReport(report);
      paintVisit(report?.visitor || (await ask({ type: 'VISIT_STATUS' })));
      paintWatch(watch);
    })().finally(() => (qualityState.loading = null));
    return qualityState.loading;
  }

  function paintReport(report) {
    const box = $('#xfQuality');
    if (!box) return;
    if (!report?.ok) {
      box.innerHTML = `<p class="xf-muted">${html(report?.error || 'The quality report could not be built.')}</p>`;
      return;
    }
    const quality = report.quality || {},
      buckets = quality.buckets || [],
      peak = Math.max(1, ...buckets);
    const reasons = Object.entries(quality.reasons || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    box.innerHTML = `<div class="xf-quality-head"><div class="xf-big"><b>${n(quality.average)}</b><span>average score</span></div><div class="xf-big"><b>${n(quality.incomplete)}</b><span>incomplete of ${n(quality.total)}</span></div><div class="xf-big"><b>${n(report.repairable)}</b><span>can be repaired</span></div></div>
<div class="xf-histogram" role="group" aria-label="Posts by completeness score; choose a bar to list those posts">${buckets
      .map(
        (count, index) =>
          `<button type="button" class="xf-bar${index * 10 < 70 ? ' is-low' : ''}" data-fq="bucket" data-low="${index * 10}" title="${n(count)} posts scoring ${index * 10}${index < 10 ? `–${index * 10 + 9}` : ''}" aria-label="Score ${index * 10}${index < 10 ? ` to ${index * 10 + 9}` : ''}: ${n(count)} posts" style="--h:${Math.max(2, Math.round((count / peak) * 100))}%"><i></i><span>${index * 10}</span></button>`
      )
      .join('')}</div>
${reasons.length ? `<p class="xf-reasons">Most often missing: ${reasons.map(([reason, count]) => `<span class="pill">${html(REASONS[reason] || reason)} · ${n(count)}</span>`).join(' ')}</p>` : ''}
<div class="row"><button type="button" data-fq="open" data-q="is:incomplete" data-sort="quality-low">Show incomplete posts</button><button type="button" class="quiet" data-fq="open" data-q="" data-sort="quality">Most complete first</button></div>`;
    const changes = report.changes || {};
    $('#xfChanges').innerHTML =
      `<dl class="xv-kv xf-kv"><dt>Edited posts</dt><dd><button type="button" class="quiet" data-fq="open" data-q="is:edited" data-sort="edited">${n(changes.edited)}</button></dd><dt>Recorded changes</dt><dd>${n(changes.revisions)}</dd><dt>Deleted on X</dt><dd><button type="button" class="quiet" data-fq="open" data-q="is:deleted">${n(changes.deleted)}</button></dd><dt>Otherwise unavailable</dt><dd><button type="button" class="quiet" data-fq="open" data-q="is:unavailable">${n(changes.unavailable)}</button></dd><dt>Checked at least once</dt><dd>${n(changes.checked)}</dd></dl>${
        (changes.recent || []).length
          ? `<ul class="xf-list">${changes.recent
              .slice(0, 8)
              .map(
                row =>
                  `<li><button type="button" class="quiet" data-fq="read" data-id="${html(row.id)}"><b>@${html(row.handle || 'unknown')}</b> <span class="pill">${html(row.state)}</span> <span>${html(row.text || 'Media post')}</span></button></li>`
              )
              .join('')}</ul>`
          : '<p class="xf-muted">Nothing has disappeared from what you archived.</p>'
      }`;
    const threads = report.gaps?.threads || [];
    $('#xfThreads').innerHTML = threads.length
      ? `<p class="xf-muted">${n(report.gaps.parents)} missing parents · ${n(report.gaps.quotes)} missing quoted posts</p><ul class="xf-list">${threads
          .slice(0, 12)
          .map(
            thread =>
              `<li><span><b>@${html(thread.handle || 'unknown')}</b> · ${n(thread.posts)} archived, ${n(thread.missing.length)} missing</span><span class="xf-actions"><button type="button" class="quiet" data-fq="open" data-q="thread:${html(thread.conversationId)}" data-sort="thread">Open</button><button type="button" data-fq="thread" data-conversation="${html(thread.conversationId)}">Fetch the rest</button></span></li>`
          )
          .join('')}</ul>`
      : '<p class="xf-muted">Every archived thread is complete.</p>';
    const caps = report.caps || {},
      usage = report.visitor?.usage || {};
    const counts = {
      repair: report.repairable,
      gaps: (report.gaps?.parents || 0) + (report.gaps?.quotes || 0),
      check: report.checkable,
    };
    $('#xfQueues').innerHTML = Object.entries(KIND)
      .map(([kind, [title, text]]) => {
        const disabled = kind === 'check' && !report.checksEnabled;
        return `<article class="xf-queue"><h4>${title}</h4><p>${text}</p><p class="xf-count"><b>${n(counts[kind])}</b> waiting · ${n(usage[kind] || 0)} of ${n(caps[kind])} today</p><div class="row"><button type="button" class="primary" data-fq="start" data-kind="${kind}"${counts[kind] ? '' : ' disabled'}>${kind === 'check' && disabled ? 'Check now (once)' : 'Start'}</button>${kind === 'check' && disabled ? '<button type="button" class="quiet" data-fq="settings" data-group="g-quality">Turn on daily checks</button>' : ''}</div></article>`;
      })
      .join('');
  }

  function paintVisit(status) {
    qualityState.visit = status;
    const box = $('#xfVisit'),
      historyBox = $('#xfHistory');
    if (!box) return;
    const job = status?.job;
    const live = job && ['running', 'paused'].includes(job.status);
    if (!live) box.innerHTML = '';
    else {
      const estimate = job.estimate || {},
        share = estimate.total ? Math.round((estimate.done / estimate.total) * 100) : 0;
      const results = job.results || {};
      box.innerHTML = `<div class="xf-job" data-status="${html(job.status)}"><div><b>${html(job.label)}</b><span>${job.status === 'paused' ? 'Paused' : 'Visiting'} · ${n(estimate.done)} of ${n(estimate.total)}${job.status === 'running' && estimate.remaining ? ` · about ${duration(estimate.etaMs)} left` : ''}${job.current ? ` · now ${html(job.current)}` : ''}</span></div><div class="xv-quota-bar"><i style="width:${Math.max(2, share)}%"></i></div><p class="xf-muted">${n(results.seen)} seen · ${n(results.gone)} gone · ${n(results.notShown)} not shown · ${n(results.added)} new posts</p>${job.error ? `<p class="xv-import-error" role="alert">${html(job.error)}</p>` : ''}<div class="row">${job.status === 'paused' ? '<button type="button" data-fq="resume">Resume</button>' : '<button type="button" data-fq="pause">Pause</button>'}<button type="button" class="quiet danger" data-fq="cancel">Cancel</button></div></div>`;
    }
    if (historyBox) {
      const rows = status?.history || [];
      historyBox.innerHTML = rows.length
        ? `<table class="xf-table"><thead><tr><th scope="col">Queue</th><th scope="col">Finished</th><th scope="col">Visited</th><th scope="col">Seen</th><th scope="col">Gone</th><th scope="col">New</th><th scope="col">Result</th></tr></thead><tbody>${rows
            .slice(0, 12)
            .map(
              row =>
                `<tr><td>${html(row.label || row.kind)}</td><td>${html(when(row.at))}</td><td>${n(row.visited)} / ${n(row.total)}${row.skippedByCap ? ` <small>(+${n(row.skippedByCap)} over today's limit)</small>` : ''}</td><td>${n(row.seen)}</td><td>${n(row.gone)}</td><td>${n(row.added)}</td><td>${html(row.error || row.status)}</td></tr>`
            )
            .join('')}</tbody></table>`
        : '<p class="xf-muted">No visit queue has run yet.</p>';
    }
    clearTimeout(qualityState.timer);
    if (live && shown('quality'))
      qualityState.timer = setTimeout(async () => {
        if (!shown('quality')) return;
        const next = await ask({ type: 'VISIT_STATUS' });
        paintVisit(next);
        if (!(next?.job && ['running', 'paused'].includes(next.job.status))) paintQuality({ force: true });
      }, 2500);
  }

  function paintWatch(status) {
    const box = $('#xfWatch');
    if (!box) return;
    const lists = status?.lists || [];
    box.innerHTML = `${
      lists.length
        ? `<table class="xf-table"><thead><tr><th scope="col">Watching</th><th scope="col">Every</th><th scope="col">Last run</th><th scope="col">Next</th><th scope="col">On</th><th scope="col"><span class="xv-sr-only">Actions</span></th></tr></thead><tbody>${lists
            .map(
              list =>
                `<tr><td><b>${html(list.name)}</b><small>${list.kind === 'author' ? 'account' : 'search'}</small></td><td>${list.everyHours < 24 ? `${n(list.everyHours)} h` : `${n(list.everyHours / 24)} d`}</td><td>${list.lastRunAt ? `${html(when(list.lastRunAt))}${list.lastResult ? ` · ${n(list.lastResult.added)} new${list.lastResult.error ? ` · ${html(list.lastResult.error)}` : ''}` : ''}` : 'never'}</td><td>${list.enabled === false ? '—' : list.nextAt && list.nextAt > Date.now() ? html(when(list.nextAt)) : 'soon'}</td><td><input type="checkbox" data-fq="watch-toggle" data-id="${html(list.id)}" aria-label="Watch ${html(list.name)}"${list.enabled === false ? '' : ' checked'}></td><td class="xf-actions"><button type="button" class="quiet" data-fq="watch-run" data-id="${html(list.id)}">Run now</button><a class="quiet" href="${html(list.url)}" target="_blank" rel="noopener noreferrer">X ↗</a><button type="button" class="quiet" data-fq="watch-remove" data-id="${html(list.id)}" aria-label="Remove ${html(list.name)}">×</button></td></tr>`
            )
            .join('')}</tbody></table>`
        : '<p class="xf-muted">No watch lists yet. Add an account or a search below.</p>'
    }<p class="xf-muted">${n(status?.usedToday)} of ${n(status?.dailyCap)} runs used today${status?.current ? ` · running ${html(status.current.name || status.current.id || '')}` : ''}.</p>`;
  }

  async function writeWatchLists(next) {
    const result = await ask({ type: 'SET_SETTINGS', settings: { watchLists: next } });
    if (result?.settings) settings = result.settings;
    paintWatch(await ask({ type: 'WATCH_STATUS' }));
    return result;
  }
  async function addWatch(event) {
    event.preventDefault();
    const form = event.currentTarget,
      data = new FormData(form),
      kind = data.get('kind') === 'search' ? 'search' : 'author';
    let value = String(data.get('value') || '').trim();
    if (kind === 'author')
      value = value
        .replace(/^@/, '')
        .replace(/^https?:\/\/(x|twitter)\.com\//i, '')
        .split(/[/?#]/)[0];
    if (kind === 'author' && !/^[A-Za-z0-9_]{1,15}$/.test(value))
      return say('Enter an X handle (letters, digits and _)');
    const current = settings.watchLists || [];
    const list = {
      id: `w-${Date.now().toString(36)}`,
      kind,
      value,
      name: kind === 'author' ? `@${value.toLowerCase()}` : value,
      everyHours: Number(data.get('everyHours')) || 24,
      maxPages: Number(data.get('maxPages')) || 2,
      enabled: true,
    };
    await writeWatchLists([...current, list]);
    form.reset();
    say(`Watching ${list.name}`);
  }

  async function onQualityClick(event) {
    const target = event.target.closest('[data-fq]');
    if (!target || target.disabled) return;
    const act = target.dataset.fq;
    if (act === 'refresh') return paintQuality({ force: true });
    if (act === 'open') return openLibrary(target.dataset.q || '', target.dataset.sort || null);
    if (act === 'bucket') {
      const low = Number(target.dataset.low) || 0;
      return openLibrary(low >= 100 ? 'quality:100' : `quality:>=${low} quality:<${low + 10}`, 'quality-low');
    }
    if (act === 'read') return window.XVaultReader?.open(target.dataset.id, { returnTo: target });
    if (act === 'settings') {
      page('settings');
      return setTimeout(() => document.getElementById(target.dataset.group)?.scrollIntoView({ block: 'start' }), 80);
    }
    if (act === 'start' || act === 'thread') {
      target.disabled = true;
      const message =
        act === 'thread'
          ? { type: 'QUALITY_QUEUE', kind: 'gaps', conversationId: target.dataset.conversation }
          : { type: 'QUALITY_QUEUE', kind: target.dataset.kind, manual: true };
      const result = await ask(message);
      target.disabled = false;
      if (!result?.ok) return say(result?.error || 'Could not start');
      say(`Queued ${n(result.job?.estimate?.total || 0)} visits`);
      return paintVisit(result);
    }
    if (['pause', 'resume', 'cancel'].includes(act)) {
      if (act === 'cancel' && !confirm('Cancel this visit queue? Posts already visited keep their results.')) return;
      const result = await ask({ type: `VISIT_${act.toUpperCase()}` });
      return paintVisit(result?.ok ? result : await ask({ type: 'VISIT_STATUS' }));
    }
    if (act === 'watch-run') {
      target.disabled = true;
      target.textContent = 'Running…';
      const result = await ask({ type: 'WATCH_RUN_NOW', id: target.dataset.id });
      say(result?.ok ? `${n(result.added)} new posts` : result?.error || 'Watch list failed');
      return paintWatch(await ask({ type: 'WATCH_STATUS' }));
    }
    if (act === 'watch-remove') {
      const list = (settings.watchLists || []).find(entry => entry.id === target.dataset.id);
      if (!list || !confirm(`Stop watching ${list.name}? Posts it archived stay in your Library.`)) return;
      return writeWatchLists((settings.watchLists || []).filter(entry => entry.id !== list.id));
    }
  }
  document.addEventListener('change', event => {
    const toggle = event.target.closest?.('[data-fq="watch-toggle"]');
    if (!toggle) return;
    writeWatchLists(
      (settings.watchLists || []).map(entry =>
        entry.id === toggle.dataset.id ? { ...entry, enabled: toggle.checked } : entry
      )
    );
  });

  /* ───────────── Downloads › Files & health ───────────── */
  const filesState = { duplicates: null, plan: null };
  function filesSkeleton() {
    const root = ensurePage('files', 'media', 'Download files and health');
    if (root.dataset.ready) {
      const form = root.querySelector('#xfRename');
      if (form && !form.dataset.touched && settings.customFilenameTemplate) {
        form.file.value = settings.customFilenameTemplate;
        previewRename();
      }
      return root;
    }
    root.dataset.ready = '1';
    root.innerHTML = `<h2 class="xv-sr-only">Download files and health</h2>
<div class="xf-grid">
<section class="panel xf-wide" aria-labelledby="xfHoldTitle"><div class="panelhead"><div><h3 id="xfHoldTitle">Queue policy</h3><p>Video quality, the download window, Data Saver and the bandwidth cap are in Settings › Downloads.</p></div><button type="button" data-ff="refresh">Refresh</button></div><div id="xfHold" aria-live="polite"></div></section>
<section class="panel xf-wide" aria-labelledby="xfHostsTitle"><div class="panelhead"><div><h3 id="xfHostsTitle">Host health</h3><p>Success rate, speed and the most common failure for each server XVault downloads from.</p></div></div><div id="xfHosts"></div></section>
<section class="panel" aria-labelledby="xfDupTitle"><div class="panelhead"><div><h3 id="xfDupTitle">Duplicate files</h3><p>Completed downloads with identical bytes (or the same media at the same size). XVault keeps one copy and can delete the rest from disk.</p></div></div><div id="xfDup"></div></section>
<section class="panel" aria-labelledby="xfVerifyTitle"><div class="panelhead"><div><h3 id="xfVerifyTitle">Re-check files</h3><p>Confirms each completed file is still on disk and still the right type. Schedule it in Settings › Downloads.</p></div></div><div id="xfVerify"></div></section>
<section class="panel xf-wide" aria-labelledby="xfRenameTitle"><div class="panelhead"><div><h3 id="xfRenameTitle">Rename files to a template</h3><p>Browsers cannot move finished downloads, so XVault plans every rename (never overwriting anything), gives you a script to run, then updates its records.</p></div></div>
<form id="xfRename" class="xf-rename" autocomplete="off"><label class="field"><span>Filename template</span><input name="file" spellcheck="false" maxlength="300"></label><label class="field"><span>Folder template (optional — empty keeps current folders)</span><input name="folder" spellcheck="false" maxlength="300" placeholder="{author}/{year}"></label><div class="pathpreview" id="xfRenamePreview" aria-live="polite"></div><div class="row"><button type="submit" class="primary">Plan renames</button></div></form><div id="xfRenamePlan"></div></section>
</div>`;
    root.addEventListener('click', onFilesClick);
    const form = root.querySelector('#xfRename');
    form.file.value = settings.customFilenameTemplate || '{author}_{tweetId}_{index}';
    form.addEventListener('input', () => {
      form.dataset.touched = '1';
      previewRename();
    });
    form.addEventListener('submit', planRename);
    previewRename();
    return root;
  }

  function previewRename() {
    const form = $('#xfRename'),
      out = $('#xfRenamePreview'),
      Template = window.XVaultFilenameTemplate;
    if (!form || !out || !Template) return;
    const result = Template.preview(form.file.value, form.folder.value);
    out.innerHTML = `${result.paths.map(path => `<code>${html(path)}</code>`).join('<br>')}${result.issues.length ? `<p class="xf-warn">${result.issues.map(html).join(' · ')}</p>` : ''}`;
  }

  async function paintFiles() {
    filesSkeleton();
    const [health, duplicates, verify] = await Promise.all([
      ask({ type: 'DOWNLOAD_HOST_HEALTH' }),
      ask({ type: 'DUPLICATE_REPORT' }),
      ask({ type: 'INTEGRITY_REVERIFY_STATUS' }),
    ]);
    const hold = health?.hold || null,
      band = health?.bandwidth || {};
    const policy = [
      `Video quality: <b>${html({ highest: 'highest available', 1080: 'up to 1080p', 720: 'up to 720p', 480: 'up to 480p' }[settings.videoQuality] || 'highest available')}</b>`,
      settings.downloadWindowEnabled
        ? `Window: <b>${html(settings.downloadWindowStart)}–${html(settings.downloadWindowEnd)}</b>`
        : 'Window: <b>any time</b>',
      Number(settings.downloadMaxMBps) > 0 ? `Cap: <b>${html(settings.downloadMaxMBps)} MB/s</b>` : 'Cap: <b>none</b>',
      settings.downloadRespectSaveData === false ? 'Data Saver: <b>ignored</b>' : 'Data Saver: <b>respected</b>',
    ];
    $('#xfHold').innerHTML = `<p class="xf-policy">${policy.join(' · ')}</p>${
      hold
        ? `<p class="xf-hold" role="status"><b>Downloads are on hold.</b> ${html(hold.message)}${hold.retryInMs ? ` · next check in ${duration(hold.retryInMs)}` : ''}</p>`
        : '<p class="xf-ok" role="status">The queue is running normally.</p>'
    }${band.rate ? `<p class="xf-muted">Measured ${html((band.rate / 1048576).toFixed(2))} MB/s${band.capped ? ' · throttled to the cap' : ''}</p>` : ''}`;
    const hosts = health?.hosts || [];
    $('#xfHosts').innerHTML = hosts.length
      ? `<table class="xf-table"><thead><tr><th scope="col">Host</th><th scope="col">Status</th><th scope="col">Success</th><th scope="col">Files</th><th scope="col">Avg speed</th><th scope="col">Avg file</th><th scope="col">Retries</th><th scope="col">Top failure</th></tr></thead><tbody>${hosts
          .map(
            host =>
              `<tr><td><code>${html(host.host || 'unknown')}</code></td><td><span class="xf-status is-${html(host.status)}">${html(host.status)}</span></td><td>${html(host.successRate)}%</td><td>${n(host.complete)} done · ${n(host.failed)} failed${host.queued ? ` · ${n(host.queued)} waiting` : ''}</td><td>${host.avgMBps ? `${html(host.avgMBps)} MB/s` : '—'}</td><td>${host.avgFileMB ? `${html(host.avgFileMB)} MB` : '—'}</td><td>${n(host.retries)}</td><td>${host.topReasons?.[0] ? `${html(host.topReasons[0].reason)} (${n(host.topReasons[0].count)})` : '—'}</td></tr>`
          )
          .join('')}</tbody></table>`
      : '<p class="xf-muted">No downloads yet.</p>';
    filesState.duplicates = duplicates;
    const groups = duplicates?.groups || [];
    $('#xfDup').innerHTML = groups.length
      ? `<p><b>${n(duplicates.files)}</b> extra copies · <b>${bytes(duplicates.reclaimable)}</b> reclaimable</p><ul class="xf-list xf-dups">${groups
          .slice(0, 30)
          .map(
            group =>
              `<li><label class="xf-check"><input type="checkbox" data-dup="${html(group.key)}" checked> <span><b>${n(group.remove.length)} extra</b> · ${bytes(group.bytes)} · ${html(group.confidence)}<small>keeps ${html(group.keep.file.split('/').pop())}</small></span></label></li>`
          )
          .join(
            ''
          )}</ul>${groups.length > 30 ? `<p class="xf-muted">and ${n(groups.length - 30)} more groups (all included)</p>` : ''}<div class="row"><button type="button" class="danger" data-ff="reclaim">Delete extra copies</button></div>`
      : '<p class="xf-muted">No duplicate files found.</p>';
    const last = verify?.last;
    $('#xfVerify').innerHTML =
      `<p>${last ? `Last run ${html(when(last.at))}: ${n(last.checked)} files checked, ${n(last.problems)} problems${last.requeued ? `, ${n(last.requeued)} re-queued` : ''}.` : 'Never run.'} ${Number(settings.integrityScheduleDays) > 0 ? `Runs every ${n(settings.integrityScheduleDays)} days.` : 'Not scheduled.'}</p><div class="row"><button type="button" data-ff="reverify">Re-check all files now</button><button type="button" class="quiet" data-ff="settings">Schedule…</button></div>`;
  }

  async function planRename(event) {
    event.preventDefault();
    const form = event.currentTarget,
      box = $('#xfRenamePlan');
    box.innerHTML = '<p class="xf-muted">Planning…</p>';
    const plan = await ask({ type: 'RENAME_PLAN', fileTemplate: form.file.value, folderTemplate: form.folder.value });
    filesState.plan = plan?.ok ? { ...plan, fileTemplate: form.file.value, folderTemplate: form.folder.value } : null;
    if (!plan?.ok) {
      box.innerHTML = `<p class="xv-import-error" role="alert">${html(plan?.error || 'Could not plan renames')}</p>`;
      return;
    }
    if (!plan.total) {
      box.innerHTML = `<p class="xf-ok">All ${n(plan.files)} completed files already follow this template.${plan.conflicts.length ? ` ${n(plan.conflicts.length)} would collide and are left alone.` : ''}</p>`;
      return;
    }
    box.innerHTML = `<p><b>${n(plan.total)}</b> of ${n(plan.files)} files would be renamed${plan.conflicts.length ? ` · ${n(plan.conflicts.length)} skipped because the new name is taken` : ''}.</p><ol class="xf-moves">${plan.moves
      .slice(0, 12)
      .map(move => `<li><code>${html(move.from)}</code> → <code>${html(move.to)}</code></li>`)
      .join('')}</ol>${plan.total > 12 ? `<p class="xf-muted">…and ${n(plan.total - 12)} more.</p>` : ''}
<ol class="xf-steps"><li>Download the script for your system and run it from any folder. It only moves files that exist and never replaces one.<div class="row"><button type="button" data-ff="script" data-os="sh">macOS / Linux script</button><button type="button" data-ff="script" data-os="ps1">Windows PowerShell script</button></div></li><li>Then tell XVault, so the Library, verification and duplicate checks follow the new names.<div class="row"><button type="button" class="primary" data-ff="record">I ran it — update records</button></div></li></ol><p class="xf-muted">Download folder: <code>${html(plan.base || 'unknown — the script asks for it')}</code>${plan.truncated ? ' · the plan shows the first 5,000 files; plan again after renaming for the rest' : ''}. Future downloads use the template set in Settings › Downloads.</p>`;
  }

  function renameScript(plan, os) {
    const moves = plan.moves;
    if (os === 'ps1') {
      const quote = value => `'${String(value).replace(/'/g, "''")}'`;
      return `# XVault safe rename — generated ${new Date().toISOString()}\n# Moves ${moves.length} files inside your download folder. Existing files are never overwritten.\nparam([string]$Base = ${quote(plan.base || `${'$'}HOME\\Downloads`)})\nSet-Location -LiteralPath $Base\n$moved = 0; $skipped = 0\nfunction Move-XV($from, $to) {\n  if (-not (Test-Path -LiteralPath $from)) { $script:skipped++; return }\n  if (Test-Path -LiteralPath $to) { Write-Host "skip (exists): $to"; $script:skipped++; return }\n  $dir = Split-Path -Parent $to\n  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }\n  Move-Item -LiteralPath $from -Destination $to\n  $script:moved++\n}\n${moves.map(move => `Move-XV ${quote(move.from.replace(/\//g, '\\'))} ${quote(move.to.replace(/\//g, '\\'))}`).join('\n')}\nWrite-Host "Moved $moved, skipped $skipped"\n`;
    }
    const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
    return `#!/bin/sh\n# XVault safe rename — generated ${new Date().toISOString()}\n# Moves ${moves.length} files inside your download folder. Existing files are never overwritten.\nset -u\nBASE=\${1:-${quote(plan.base || '$HOME/Downloads')}}\ncd "$BASE" || exit 1\nmoved=0; skipped=0\nmv_xv() {\n  if [ ! -e "$1" ]; then skipped=$((skipped+1)); return; fi\n  if [ -e "$2" ]; then echo "skip (exists): $2"; skipped=$((skipped+1)); return; fi\n  mkdir -p "$(dirname "$2")" && mv -n "$1" "$2" && moved=$((moved+1))\n}\n${moves.map(move => `mv_xv ${quote(move.from)} ${quote(move.to)}`).join('\n')}\necho "Moved $moved, skipped $skipped"\n`;
  }

  async function onFilesClick(event) {
    const target = event.target.closest('[data-ff]');
    if (!target || target.disabled) return;
    const act = target.dataset.ff;
    if (act === 'refresh') return paintFiles();
    if (act === 'settings') {
      page('settings');
      return setTimeout(() => document.getElementById('g-dlpolicy')?.scrollIntoView({ block: 'start' }), 80);
    }
    if (act === 'reverify') {
      target.disabled = true;
      target.textContent = 'Checking…';
      const result = await ask({ type: 'INTEGRITY_REVERIFY', limit: 5000 });
      target.disabled = false;
      say(
        result?.ok
          ? `${n(result.checked)} files checked · ${n(result.problems)} problems`
          : result?.error || 'Re-check failed'
      );
      return paintFiles();
    }
    if (act === 'reclaim') {
      const chosen = new Set(
        [...document.querySelectorAll('#xfDup [data-dup]:checked')].map(input => input.dataset.dup)
      );
      const groups = (filesState.duplicates?.groups || []).filter(
        (group, index) => index >= 30 || chosen.has(group.key)
      );
      const keys = groups.flatMap(group => group.remove.map(entry => entry.key));
      const total = groups.reduce((sum, group) => sum + group.bytes, 0);
      if (!keys.length) return say('Choose at least one group');
      if (!confirm(`Delete ${n(keys.length)} duplicate files (${bytes(total)}) from disk? One copy of each stays.`))
        return;
      target.disabled = true;
      const result = await ask({ type: 'DUPLICATE_RECLAIM', keys });
      target.disabled = false;
      say(
        result?.ok
          ? `Deleted ${n(result.removed)} files · ${bytes(result.bytes)} freed${result.failed?.length ? ` · ${n(result.failed.length)} could not be deleted` : ''}`
          : result?.error || 'Could not delete'
      );
      return paintFiles();
    }
    if (act === 'script') {
      const plan = filesState.plan;
      if (!plan) return;
      const os = target.dataset.os,
        text = renameScript(plan, os),
        url = URL.createObjectURL(new Blob([text], { type: 'text/plain' })),
        link = document.createElement('a');
      link.href = url;
      link.download = os === 'ps1' ? 'xvault-rename.ps1' : 'xvault-rename.sh';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return say(
        os === 'ps1'
          ? 'Run with: powershell -ExecutionPolicy Bypass -File xvault-rename.ps1'
          : 'Run with: sh xvault-rename.sh'
      );
    }
    if (act === 'record') {
      const plan = filesState.plan;
      if (
        !plan ||
        !confirm(`Update ${n(plan.moves.length)} records to the new names? Do this only after the script has run.`)
      )
        return;
      const result = await ask({
        type: 'RENAME_RECORD',
        fileTemplate: plan.fileTemplate,
        folderTemplate: plan.folderTemplate,
        keys: plan.moves.map(move => move.key),
      });
      say(result?.ok ? `${n(result.updated)} records updated` : result?.error || 'Could not update records');
      $('#xfRenamePlan').innerHTML = '';
      filesState.plan = null;
      return result?.ok && save({ fileNaming: 'custom', customFilenameTemplate: plan.fileTemplate }, false);
    }
  }

  /* ───────────── Atlas › Topics ───────────── */
  async function topics(container, { rebuild = false, k = 0 } = {}) {
    if (!container) return;
    container.innerHTML = '<div class="xa-loading" aria-busy="true"><i class="xv-skeleton xa-skel-chart"></i></div>';
    const result = rebuild ? await ask({ type: 'CLUSTERS_BUILD', k }) : await ask({ type: 'CLUSTERS_GET' });
    if (!result?.ok) {
      container.innerHTML = `<div class="empty"><p>${html(result?.error || 'Topics could not be built.')}</p><button type="button" class="primary" data-topic="build">Try again</button></div>`;
      return;
    }
    const clusters = result.clusters || [];
    if (!clusters.length) {
      container.innerHTML = `<div class="empty xa-empty"><h2>Find the topics in your archive</h2><p>XVault groups posts by meaning, using the local meaning index — nothing leaves this browser. Each topic opens as a search (<code>cluster:</code>) and can be saved as a Smart Collection.</p><button type="button" class="primary" data-topic="build">Find topics</button></div>`;
      return;
    }
    container.innerHTML = `<header class="xa-section-head"><h2>${n(clusters.length)} topics in ${n(result.documents)} posts</h2><div class="xf-actions"><label class="xf-inline"><span>Topics</span><select data-topic-k aria-label="Number of topics"><option value="0">Automatic</option>${[6, 10, 16, 24, 36].map(value => `<option value="${value}"${Number(result.k) === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label><button type="button" class="quiet" data-topic="build">Rebuild</button></div></header><p class="xf-muted">Built ${html(when(result.builtAt))}. Names you give topics are kept when they are rebuilt.</p><div class="xf-topics">${clusters
      .map(cluster => {
        const label = cluster.name || cluster.terms.slice(0, 3).join(' · ') || cluster.id;
        return `<article class="xf-topic" data-cluster="${html(cluster.id)}"><header><input class="xf-topic-name" value="${html(cluster.name || '')}" placeholder="${html(cluster.terms.slice(0, 3).join(' · '))}" aria-label="Name topic ${html(label)}" maxlength="80"><span class="pill">${n(cluster.size)}</span></header><p class="xf-terms">${cluster.terms
          .slice(0, 8)
          .map(
            term =>
              `<button type="button" class="quiet" data-topic="term" data-term="${html(term)}">${html(term)}</button>`
          )
          .join(
            ''
          )}</p><div class="xf-cohesion" title="How closely the posts agree"><i style="width:${Math.round(Math.max(0, Math.min(1, cluster.cohesion || 0)) * 100)}%"></i></div><div class="row"><button type="button" data-topic="open">Open</button><button type="button" class="quiet" data-topic="save">Save as collection</button><button type="button" class="quiet" data-topic="board">Make board</button></div></article>`;
      })
      .join('')}</div>`;
  }
  async function onTopicEvent(event) {
    const container = event.target.closest('#xfTopics');
    if (!container) return;
    if (event.type === 'change') {
      const name = event.target.closest('.xf-topic-name');
      if (name) {
        const id = name.closest('[data-cluster]').dataset.cluster;
        const result = await ask({ type: 'CLUSTER_RENAME', id, name: name.value });
        say(result?.ok ? 'Topic renamed' : result?.error || 'Could not rename');
      }
      return;
    }
    const button = event.target.closest('[data-topic]');
    if (!button) return;
    const act = button.dataset.topic,
      card = button.closest('[data-cluster]');
    if (act === 'build') {
      const k = Number(container.querySelector('[data-topic-k]')?.value) || 0;
      return topics(container, { rebuild: true, k });
    }
    if (act === 'term') return openLibrary(button.dataset.term);
    if (!card) return;
    const id = card.dataset.cluster,
      name = card.querySelector('.xf-topic-name');
    if (act === 'open') return openLibrary(`cluster:${id}`);
    if (act === 'board') {
      const label = (name.value.trim() || name.placeholder || id).slice(0, 80);
      const members = await ask({ type: 'CLUSTER_MEMBERS', id });
      if (!members?.ok) return say(members?.error || 'Could not read this topic');
      if (!members.ids.length) return say('This topic has no posts');
      if (
        !confirm(
          `Create the board “${label}” with ${n(members.ids.length)} posts? You can undo adding them with Ctrl+Z.`
        )
      )
        return;
      const board = await window.XVaultLibrary3?.createBoard?.(label, {
        description: `Made from the topic “${members.name}”`,
      });
      if (!board) return say('Could not create the board');
      button.disabled = true;
      try {
        await window.XVaultLibraryBulkMeta?.({ addBoards: [board.id] }, `Added to ${board.name}`, members.ids);
      } finally {
        button.disabled = false;
      }
      return say(`Board “${board.name}” created with ${n(members.ids.length)} posts`);
    }
    if (act === 'save') {
      const label = (name.value || name.placeholder || id).slice(0, 48);
      // A named topic is saved by name (stable across rebuilds); an unnamed one by its id.
      const query = name.value.trim() ? `topic:"${name.value.trim().replace(/"/g, '')}"` : `cluster:${id}`;
      const result = await ask({
        type: 'UPDATE_SMART_COLLECTIONS',
        change: {
          op: 'save',
          collection: {
            id: crypto.randomUUID(),
            name: label,
            query,
            sort: 'new',
            view: 'cards',
            icon: 'saved',
            createdAt: Date.now(),
          },
        },
      });
      if (result?.settings) settings.savedViews = result.settings.savedViews || settings.savedViews;
      say(result?.ok ? `Saved “${label}” as a Smart Collection` : result?.error || 'Could not save');
    }
  }
  document.addEventListener('click', onTopicEvent);
  document.addEventListener('change', onTopicEvent);

  /* ───────────── New archive: presets, rate / ETA, history ───────────── */
  const run = { observer: null, started: 0, base: 0, last: 0, expected: 0, handle: '' };
  function presetsSlot() {
    const panel = $('#page-archive .archivegrid > .panel');
    if (!panel || $('#xfPresets')) return;
    const node = document.createElement('div');
    node.id = 'xfPresets';
    node.className = 'xf-presets';
    panel.querySelector('.method')?.before(node);
    node.addEventListener('click', onPresetClick);
    paintPresets();
    const dl = $('#page-archive .panel.run dl');
    if (dl && !$('#runEta')) {
      const row = document.createElement('div');
      row.innerHTML = '<dt>Speed · ETA</dt><dd id="runEta">—</dd>';
      dl.append(row);
    }
    const posts = $('#runPosts');
    if (posts && !run.observer) {
      run.observer = new MutationObserver(onRunProgress);
      run.observer.observe(posts, { childList: true, characterData: true, subtree: true });
    }
  }
  function paintPresets() {
    const node = $('#xfPresets');
    if (!node) return;
    const list = settings.capturePresets || [];
    node.innerHTML = `<span class="xf-presets-label">Presets</span>${list
      .map(
        preset =>
          `<span class="xf-preset"><button type="button" data-preset-run="${html(preset.id)}" title="${html(preset.source)}${preset.handle ? ` @${html(preset.handle)}` : ''}${preset.mirror ? ' · with media' : ''}">${html(preset.name)}</button><button type="button" class="quiet" data-preset-remove="${html(preset.id)}" aria-label="Remove preset ${html(preset.name)}">×</button></span>`
      )
      .join('')}<button type="button" class="quiet" data-preset-save>Save current…</button>`;
  }
  async function onPresetClick(event) {
    const runButton = event.target.closest('[data-preset-run]'),
      remove = event.target.closest('[data-preset-remove]'),
      saveButton = event.target.closest('[data-preset-save]');
    const list = settings.capturePresets || [];
    if (saveButton) {
      const handle =
        source === 'profile'
          ? String($('#handle')?.value || '')
              .replace(/^@/, '')
              .trim()
          : '';
      if (source === 'profile' && !handle) return say('Enter a profile handle first');
      const name = prompt('Name this preset', source === 'profile' ? `@${handle}` : source);
      if (!name?.trim()) return;
      await save({
        capturePresets: [
          ...list,
          {
            id: `p-${Date.now().toString(36)}`,
            name: name.trim(),
            source,
            handle,
            mirror: !!$('#runMirror')?.checked,
            resume: $('#runResume')?.checked !== false,
          },
        ],
      });
      paintPresets();
      return say('Preset saved');
    }
    if (remove) {
      await save({ capturePresets: list.filter(preset => preset.id !== remove.dataset.presetRemove) });
      return paintPresets();
    }
    if (runButton) {
      const preset = list.find(entry => entry.id === runButton.dataset.presetRun);
      if (!preset) return;
      source = preset.source;
      selectSource(false);
      if ($('#handle')) $('#handle').value = preset.handle || '';
      if ($('#runMirror')) $('#runMirror').checked = !!preset.mirror;
      if ($('#runResume')) $('#runResume').checked = preset.resume !== false;
      method();
      say(`Starting “${preset.name}”`);
      return start();
    }
  }
  async function onRunProgress() {
    const text = $('#runPosts')?.textContent || '',
      posts = Number(text.replace(/[^\d]/g, '')) || 0,
      eta = $('#runEta');
    if (!eta) return;
    if (!activeRun) {
      run.started = 0;
      return;
    }
    const now = Date.now();
    if (!run.started || run.id !== activeRun) {
      Object.assign(run, { id: activeRun, started: now, base: posts, expected: 0, handle: '' });
      if (source === 'profile') {
        const handle = String($('#handle')?.value || '')
          .replace(/^@/, '')
          .trim();
        run.handle = handle;
        const detail = handle ? await ask({ type: 'GET_AUTHOR_DETAIL', handle }) : null;
        if (detail?.ok && Number(detail.profile?.posts) > 0)
          run.expected = Math.max(0, Number(detail.profile.posts) - Number(detail.total || 0));
      }
    }
    const minutes = (now - run.started) / 60000,
      gained = Math.max(0, posts - run.base),
      rate = minutes > 0.1 ? gained / minutes : 0;
    if (now - run.last < 1500) return;
    run.last = now;
    const left = run.expected ? Math.max(0, run.expected - gained) : 0;
    eta.textContent = rate
      ? `${n(Math.round(rate))}/min${left ? ` · about ${duration((left / rate) * 60000)} for ~${n(left)} more` : run.expected ? ' · nearly done' : ''}`
      : '—';
  }

  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-rerun]');
    if (!button) return;
    source = button.dataset.rerun;
    page('archive');
    selectSource(false);
    if ($('#handle')) $('#handle').value = button.dataset.handle || '';
    method();
    start();
  });

  /* ───────────── Settings: live filename preview ───────────── */
  function filenamePreview() {
    const out = $('#filenamePreview'),
      Template = window.XVaultFilenameTemplate;
    if (!out || !Template) return;
    if (settings.fileNaming !== 'custom') return;
    const input = document.querySelector('[data-setting="customFilenameTemplate"]');
    const result = Template.preview(input?.value || settings.customFilenameTemplate || '{author}_{tweetId}_{index}');
    out.innerHTML = `${result.paths.map(path => `<code>${html(path)}</code>`).join(' ')}${result.issues.length ? `<span class="xf-warn"> ${result.issues.map(html).join(' · ')}</span>` : ''}`;
  }
  document.addEventListener('input', event => {
    if (event.target.matches?.('[data-setting="customFilenameTemplate"]')) filenamePreview();
    if (event.target.matches?.('[data-setting="videoQualityRules"]')) videoRulesPreview(event.target.value);
  });

  /* Per-rule video quality: the same "search => quality" grammar as sw/forge-settings.mjs. */
  const QUALITY_WORDS = {
    highest: 'highest',
    best: 'highest',
    max: 'highest',
    original: 'highest',
    '4k': 'highest',
    2160: 'highest',
    1440: 'highest',
    1080: '1080',
    '1080p': '1080',
    720: '720',
    '720p': '720',
    480: '480',
    '480p': '480',
    low: '480',
    small: '480',
  };
  function videoRulesPreview(text = settings.videoQualityRules || '') {
    const out = $('#videoRulesPreview');
    if (!out) return;
    const rules = [],
      issues = [];
    String(text)
      .split(/\r?\n/)
      .forEach((raw, index) => {
        const line = raw.trim();
        if (!line || line.startsWith('#')) return;
        const match = /^(.*?)\s*(?:=>|→|->)\s*([a-z0-9]+)\s*$/i.exec(line);
        const quality = match && QUALITY_WORDS[match[2].toLowerCase()];
        if (!match || !match[1].trim()) issues.push(`line ${index + 1}: use “search => quality”`);
        else if (!quality) issues.push(`line ${index + 1}: unknown quality “${match[2]}”`);
        else rules.push(`${match[1].trim()} → ${quality === 'highest' ? 'highest' : `≤${quality}p`}`);
      });
    const issues2 = issues.slice(0, 3);
    out.innerHTML =
      rules.length || issues.length
        ? `${rules.length ? `${n(rules.length)} rule${rules.length === 1 ? '' : 's'}: ${rules.slice(0, 4).map(html).join(' · ')}${rules.length > 4 ? ' · …' : ''}. Other videos use the quality above.` : ''}${issues2.length ? ` <span class="xf-warn">${issues2.map(html).join(' · ')}</span>` : ''}`
        : 'Optional. Example: <code>source:likes =&gt; 720</code> keeps liked videos small while everything else follows the quality above.';
  }

  /* ───────────── Wiring ───────────── */
  hooks.after('page', (result, name) => {
    if (name === 'quality') paintQuality();
    if (name === 'files') paintFiles();
    if (name === 'archive' || name === 'home') presetsSlot();
  });
  hooks.after('sync', () => {
    filenamePreview();
    videoRulesPreview();
    paintPresets();
  });
  hooks.commands(() => [
    { name: 'Archive quality', hint: 'completeness, repair, thread gaps, still on X', run: () => page('quality') },
    {
      name: 'Watch lists',
      hint: 'accounts and searches checked on a schedule',
      run: () => (page('quality'), setTimeout(() => $('#xfWatchForm input[name="value"]')?.focus(), 80)),
    },
    {
      name: 'Repair incomplete posts',
      hint: 'background visits, daily limit',
      run: () => (
        page('quality'),
        ask({ type: 'QUALITY_QUEUE', kind: 'repair', manual: true }).then(
          result => (
            say(result?.ok ? 'Repair queue started' : result?.error || 'Could not start'),
            paintQuality({ force: true })
          )
        )
      ),
    },
    { name: 'Download files & health', hint: 'hosts, duplicates, re-check, rename', run: () => page('files') },
    {
      name: 'Find duplicate files',
      hint: 'reclaim disk space',
      run: () => (page('files'), setTimeout(() => $('#xfDupTitle')?.scrollIntoView({ block: 'start' }), 120)),
    },
    { name: 'Edited posts', hint: 'is:edited', run: () => openLibrary('is:edited', 'edited') },
    { name: 'Deleted on X', hint: 'is:deleted', run: () => openLibrary('is:deleted') },
  ]);
  function mount() {
    qualitySkeleton();
    filesSkeleton();
    presetsSlot();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  window.XVaultForge = { topics, paintQuality, paintFiles, renameScript };
})();
