/* exported openDetails */
const $ = s => document.querySelector(s),
  $$ = s => [...document.querySelectorAll(s)],
  call = m => {
    const pending = chrome.runtime.sendMessage(m);
    if (m?.type === 'UPDATE_TWEET_META')
      pending
        .then(r => {
          const row = library.find(x => String(x.id) === String(m.id));
          if (r?.ok && row) {
            Object.assign(row, r.row);
            window.XVaultLibraryRecordUpdated?.([m.id]);
          }
        })
        .catch(() => {});
    return pending;
  },
  tab = p => call({ type: 'SEND_TO_TAB', payload: p }),
  sleep = ms => new Promise(r => setTimeout(r, ms));
let settings = {},
  templates = {},
  source = 'bookmarks',
  activeRun = null,
  library = [],
  debugLines = [],
  libraryDownloads = new Map(),
  graphSamples = [],
  activitySamples = [],
  lightboxItems = [],
  lightboxIndex = 0,
  notifications = [],
  lightboxZoom = 100,
  lightboxFit = { w: 0, h: 0 },
  videoSyncLock = false,
  inspectorRecord = null,
  lightboxReturnTarget = null,
  librarySearchInitialized = false;
const fmt = n => (n == null ? '—' : new Intl.NumberFormat().format(n)),
  bytes = n => {
    if (n == null) return '—';
    let v = Number(n) || 0,
      i = 0,
      u = ['B', 'KB', 'MB', 'GB', 'TB'];
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
  },
  eta = s =>
    s == null ? '—' : s < 60 ? `${Math.ceil(s)}s` : s < 3600 ? `${Math.ceil(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
document.addEventListener(
  'DOMContentLoaded',
  () => {
    const s = document.createElement('script');
    s.src = 'explorer.js';
    document.head.append(s);
  },
  { once: true }
);
document.addEventListener('DOMContentLoaded', init);
let clickAudio = null,
  clickAudioUrl = '';
function prepareClickSound() {
  if (clickAudio || settings.dashboardSounds === false || settings.quietMode) return;
  try {
    const rate = 16000,
      duration = 0.055,
      count = Math.ceil(rate * duration),
      wav = new Uint8Array(44 + count * 2),
      view = new DataView(wav.buffer);
    wav.set([82, 73, 70, 70]);
    view.setUint32(4, 36 + count * 2, true);
    wav.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    wav.set([100, 97, 116, 97], 36);
    view.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++) {
      const t = i / rate,
        fade = (1 - t / duration) ** 2,
        sample = Math.sin(2 * Math.PI * (520 * t - (80 * t * t) / duration)) * fade * 0.8;
      view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, sample)) * 32767, true);
    }
    clickAudioUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    clickAudio = new Audio(clickAudioUrl);
    clickAudio.preload = 'auto';
    clickAudio.addEventListener(
      'ended',
      () => {
        try {
          clickAudio.currentTime = 0;
        } catch {}
      },
      { once: false }
    );
  } catch {
    clickAudio = null;
  }
}
function clickSound() {
  if (settings.dashboardSounds === false || settings.quietMode) return;
  if (!clickAudio) prepareClickSound();
  if (!clickAudio) return;
  clickAudio.volume = Math.max(0, Math.min(1, (settings.soundVolume ?? 0.14) * 0.055));
  try {
    clickAudio.currentTime = 0;
    const playing = clickAudio.play();
    playing?.catch(() => {});
  } catch {}
}
function installUX() {
  prepareClickSound();
  window.addEventListener(
    'pagehide',
    () => {
      if (clickAudioUrl) URL.revokeObjectURL(clickAudioUrl);
    },
    { once: true }
  );
  document.addEventListener(
    'pointerdown',
    e => {
      document.body.classList.add('pointerDown');
      const b = e.target.closest('button,.nav,.source');
      if (!b) return;
      clickSound();
    },
    { capture: true }
  );
  document.addEventListener('pointerup', () => document.body.classList.remove('pointerDown'), { capture: true });
  document.addEventListener('pointercancel', () => document.body.classList.remove('pointerDown'), { capture: true });
}
async function init() {
  let r;
  try {
    r = await call({ type: 'GET_SETTINGS' });
  } catch (error) {
    console.error('XVault settings unavailable', error);
  }
  settings = r?.settings || {};
  window.XVaultSettingDefaults = r?.defaults || null;
  if (
    settings.startupWorkspaceId &&
    window.XVaultWorkspaces?.normalizeList(settings.workspaces).some(row => row.id === settings.startupWorkspaceId)
  ) {
    const restored = await call({
      type: 'UPDATE_WORKSPACE',
      change: { op: 'apply', id: settings.startupWorkspaceId },
    }).catch(() => null);
    if (restored?.ok) settings = restored.settings;
  }
  apply();
  bind();
  sync();
  installUX();
  const hash = location.hash.slice(1),
    target =
      hash ||
      (settings.startPage === 'library'
        ? 'library'
        : settings.startPage === 'home'
          ? 'home'
          : settings.rememberLastDashboardPage !== false
            ? settings.lastDashboardPage
            : 'library') ||
      'library';
  page(target);
  if (!settings.onboardingComplete) $('#onboarding').classList.remove('hidden');
  await Promise.allSettled([refresh(), queueStats()]);
  if (settings.healthCheckOnStartup) health().catch(error => console.error('XVault health check unavailable', error));
  setInterval(() => stats().catch(() => {}), 4000);
  setInterval(() => queueStats().catch(() => {}), 1000);
  setInterval(sampleGraphs, 1000);
}
let statsSnapshot = null,
  statsPending = null,
  statsUpdatedAt = 0,
  queueSnapshot = null;
function on(sel, event, fn) {
  const e = typeof sel === 'string' ? $(sel) : sel;
  if (e) e.addEventListener(event, fn);
  return e;
}
function bind() {
  [...$$('.nav'), $('.brand'), ...$$('[data-goto]')]
    .filter(Boolean)
    .forEach(b => (b.onclick = () => page(b.dataset.page || b.dataset.goto)));
  on('#refresh', 'click', refresh);
  on('#openX', 'click', () => chrome.tabs.create({ url: 'https://x.com/home' }));
  on('#heroScroll', 'click', () => {
    page('archive');
    source = smartSourceFromUrl();
    selectSource();
    start();
  });
  on('#archiveEverything', 'click', archiveEverything);
  on('#cmdBtn', 'click', () => window.openPalette());
  document.addEventListener('keydown', e => {
    if (e.defaultPrevented || document.querySelector('dialog[open]')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
    }
    if (e.key === 'Escape') closePalette();
    if (
      e.key === '/' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.target.closest('input,textarea,select,[contenteditable]') &&
      $('#palette').classList.contains('hidden') &&
      $('#lightbox').classList.contains('hidden') &&
      $('#page-library').classList.contains('show')
    ) {
      $('#search').focus();
      e.preventDefault();
    }
  });
  on('#capture', 'change', () => save({ captureWhileBrowsing: $('#capture').checked }));
  $$('.source').forEach(
    b =>
      (b.onclick = () => {
        source = b.dataset.source;
        selectSource();
        save({ lastArchiveSource: source });
      })
  );
  on('#prime', 'click', prime);
  on('#testCrawler', 'click', testCrawler);
  on('#start', 'click', start);
  on('#pause', 'click', () => activeRun && tab({ type: 'XV_DIRECT_PAUSE', runId: activeRun }));
  on('#resume', 'click', () => activeRun && tab({ type: 'XV_DIRECT_RESUME', runId: activeRun }));
  on('#stop', 'click', () => {
    if (activeRun) {
      tab({ type: 'XV_DIRECT_CANCEL', runId: activeRun });
      tab({ type: 'XV_SCROLL_STOP' });
      toast('Stopping archive…');
    }
  });
  on('#saveCollection', 'click', saveCollection);
  on('#archiveCollection', 'click', archiveCollection);
  on('#load', 'click', loadLib);
  on('#search', 'input', () => renderLib());
  on('#sort', 'change', () => renderLib());
  $$('#libraryChips button').forEach(
    b =>
      (b.onclick = () => {
        const f = b.dataset.filter || '';
        $('#search').value = f;
        renderLib();
        $$('#libraryChips button').forEach(x => x.classList.toggle('active', x === b));
      })
  );
  on('#clearLibrary', 'click', clearLibrary);
  on('#clear', 'click', clearLibrary);
  on('#retryFailed', 'click', async () => {
    const r = await call({ type: 'RETRY_FAILED' });
    toast(r?.added ? `Requeued ${r.added} failed files` : 'Nothing to retry');
    queueStats();
  });
  on('#rebuildTargets', 'click', async () => {
    const r = await call({ type: 'REBUILD_QUEUED_TARGETS' });
    toast(`Rebuilt ${r?.rebuilt || 0} targets`);
  });
  on('#clearCompleted', 'click', () => call({ type: 'CLEAR_COMPLETED_DOWNLOADS' }).then(queueStats));
  on('#clearFailed', 'click', () => call({ type: 'CLEAR_FAILED_DOWNLOADS' }).then(queueStats));
  on('#cancelQueued', 'click', async () => {
    if (settings.confirmCancelQueue !== false && !confirm('Cancel all queued downloads?')) return;
    await call({ type: 'CANCEL_QUEUED_DOWNLOADS' });
    queueStats();
  });
  on('#openDownloads', 'click', () => call({ type: 'OPEN_DOWNLOADS' }));
  on('#testDownload', 'click', testDownload);
  on('#healthRun', 'click', health);
  on('#healthPrimeBookmarks', 'click', () => primeKind('bookmarks'));
  on('#healthPrimeLikes', 'click', () => primeKind('likes'));
  on('#healthRetry', 'click', () => call({ type: 'RETRY_FAILED' }).then(health));
  on('#healthRepairAll', 'click', async () => {
    const r = await call({ type: 'REPAIR_DOWNLOADS' });
    toast(`Repair queued ${r?.repaired || 0} · unavailable ${r?.unavailable || 0}`);
    health();
    queueStats();
  });
  on('#healthTestCrawler', 'click', testCrawler);
  on('#healthTestDownload', 'click', testDownload);
  on('#healthRefresh', 'click', refresh);
  on('#activityRefresh', 'click', activity);
  $$('[data-setting]').forEach(
    e =>
      (e.onchange = () =>
        save({
          [e.dataset.setting]: e.type === 'checkbox' ? e.checked : e.type === 'number' ? Number(e.value) : e.value,
        }))
  );
  $$('.swatch').forEach(b => (b.onclick = () => save({ theme: b.dataset.theme })));
  $$('[data-preset]').forEach(b => (b.onclick = () => preset(b.dataset.preset)));
  on('#recommendedAll', 'click', () => preset('balanced'));
  on('#exportSettings', 'click', exportSettings);
  on('#importSettings', 'click', () => $('#settingsFile').click());
  on('#settingsFile', 'change', importSettings);
  on('#resetFloat', 'click', () =>
    call({ type: 'RESET_FLOATING_POSITION' }).then(async r => {
      settings = r.settings;
      sync();
      toast('XV position reset');
    })
  );
  on('#resetCrawler', 'click', () =>
    resetSection([
      'directPageDelay',
      'directPageJitter',
      'firstPageTimeout',
      'pageSize',
      'maxPages',
      'scrollDelay',
      'scrollIdleRounds',
      'smartFallback',
      'checkpointResume',
      'incrementalSync',
      'completionVerification',
      'verificationPasses',
    ])
  );
  on('#resetMedia', 'click', () =>
    resetSection([
      'mediaFolder',
      'imageFolder',
      'videoFolder',
      'gifFolder',
      'otherFolder',
      'organizeByType',
      'organizeByAuthor',
      'organizeByDate',
      'forceProfileSubfolder',
      'fileNaming',
      'randomNameLength',
      'fullMirrorMode',
      'maxConcurrentDownloads',
      'downloadRetries',
      'retryDelay',
    ])
  );
  on('#restorePrevious', 'click', async () => {
    const r = await call({ type: 'RESTORE_PREVIOUS_SETTINGS' });
    if (!r?.ok) return toast(r?.error || 'No previous settings');
    settings = r.settings;
    apply();
    sync();
    toast('Previous settings restored');
  });
  on('#resetSettings', 'click', async () => {
    if (!confirm('Reset every XVault setting?')) return;
    const r = await call({ type: 'RESET_SETTINGS' });
    settings = r.settings;
    apply();
    sync();
    toast('Factory settings restored');
  });
  on('#paletteInput', 'input', renderPalette);
  on('#palette', 'click', e => {
    if (e.target === $('#palette')) closePalette();
  });
  on('#onboardRecommended', 'click', () => preset('balanced'));
  on('#onboardTest', 'click', testCrawler);
  on('#onboardDone', 'click', async () => {
    await save({ onboardingComplete: true });
    $('#onboarding').classList.add('hidden');
  });
  on('#basicMode', 'click', () => save({ uiMode: 'basic' }));
  on('#advancedMode', 'click', () => save({ uiMode: 'advanced' }));
  on('#libraryView', 'change', () => {
    save({ libraryView: $('#libraryView').value }, false);
    renderLib();
  });
  on('#clearSearch', 'click', () => {
    $('#search').value = '';
    save({ lastLibraryQuery: '' }, false);
    renderLib();
  });
  on('#sessionsRefresh', 'click', () => sessions());
  on('#lbClose', 'click', closeLightbox);
  on('#lbPrev', 'click', () => stepLightbox(-1));
  on('#lbNext', 'click', () => stepLightbox(1));
  on('#drawerClose', 'click', closeLightbox);
  on('#notifClose', 'click', () => $('#notificationCenter').classList.add('hidden'));
  on('#toolOpenOriginal', 'click', () => openToolLink('x'));
  on('#toolOpenFixup', 'click', () => openToolLink('fixvx'));
  on('#toolOpenFx', 'click', () => openToolLink('fxtwitter'));
  on('#toolQr', 'click', toolQr);
  on('#toolArchivePost', 'click', toolArchivePost);
  on('#toolArchiveThread', 'click', toolArchiveThread);
  on('#lbFit', 'click', () => setLightboxZoom(100));
  on('#lbMinus', 'click', () =>
    setLightboxZoom(Math.max(25, (lightboxZoom || 100) - (settings.libraryZoomStep || 25)))
  );
  on('#lbPlus', 'click', () =>
    setLightboxZoom(Math.min(settings.libraryZoomMax || 1000, (lightboxZoom || 100) + (settings.libraryZoomStep || 25)))
  );
  on('#lbActual', 'click', setLightboxActual);
  on('#lbZoom', 'input', e => setLightboxZoom(Number(e.target.value)));
  on('#surpriseMe', 'click', surpriseMe);
  on('#integrityQuick', 'click', () => {
    page('integrity');
    runIntegrity();
  });
  on('#manifestQuick', 'click', generateManifest);
  on('#integrityRun', 'click', runIntegrity);
  on('#snapshotNow', 'click', createSnapshotUi);
  on('#manifestNow', 'click', generateManifest);
  document.addEventListener('keydown', libraryKeys);
  on(
    '#lbContent',
    'wheel',
    e => {
      if (!settings.libraryWheelZoom || !e.ctrlKey) return;
      e.preventDefault();
      const d = e.deltaY > 0 ? -1 : 1;
      setLightboxZoom(
        Math.max(
          25,
          Math.min(settings.libraryZoomMax || 1000, (lightboxZoom || 100) + d * (settings.libraryZoomStep || 25))
        )
      );
    },
    { passive: false }
  );
}
function page(n) {
  if (!$('#page-' + n)) n = 'home';
  $$('.page').forEach(x => x.classList.toggle('show', x.id === `page-${n}`));
  $$('.nav').forEach(x => {
    const on = x.dataset.page === n || (x.dataset.pages || '').split(' ').includes(n);
    x.classList.toggle('active', on);
    if (on) x.setAttribute('aria-current', 'page');
    else x.removeAttribute('aria-current');
  });
  if (settings.rememberLastDashboardPage !== false && settings.lastDashboardPage !== n)
    save({ lastDashboardPage: n }, false);
  $('#title').textContent =
    {
      home: 'Capture',
      archive: 'Capture',
      library: 'Library',
      explorer: 'Explore',
      media: 'Downloads',
      health: 'System',
      integrity: 'System',
      activity: 'System',
      sessions: 'Capture',
      studio: 'Tools',
      settings: 'Settings',
    }[n] || 'XVault';
  if (n === 'activity') activity();
  if (n === 'health') health();
  if (n === 'integrity') {
    runIntegrity(false);
    loadSnapshots();
  }
  if (n === 'library') {
    const state = window.XVaultLibraryQueryState?.();
    if (state ? !state.busy && (!state.loaded || state.loadedFor !== state.queryKeyNow) : !library.length) loadLib();
  }
  if (n === 'sessions') sessions();
  if (n === 'home') sessions(true);
}
async function refresh() {
  if (!$('#page-library')?.classList.contains('show')) await stats();
  templates = (await chrome.storage.local.get('graphqlTemplates')).graphqlTemplates || {};
  renderOps();
  const r = await call({ type: 'ACTIVE_X_TAB' });
  $('#dot').classList.toggle('ok', !!r?.tab);
  $('#conn').textContent = r?.tab ? 'Connected to X' : 'Open X to connect';
  $('#ops').textContent = `${Object.keys(templates).length} operations learned`;
  if (settings.smartStart && r?.tab?.url) {
    source = smartSourceFromUrl(r.tab.url);
    selectSource(false);
  }
  method();
}
async function stats(force = false) {
  if (!force && $('#page-library')?.classList.contains('show')) return statsSnapshot;
  if (!force && statsSnapshot && Date.now() - statsUpdatedAt < 30000) return statsSnapshot;
  if (statsPending) return statsPending;
  statsPending = (async () => {
    const value = await call({ type: 'STATS' });
    if (!value?.ok) return null;
    statsSnapshot = value;
    statsUpdatedAt = Date.now();
    $('#stTweets').textContent = $('#radar').textContent = fmt(value.tweets);
    $('#stUsers').textContent = fmt(value.users);
    $('#stCaps').textContent = fmt(value.captures);
    $('#stStore').textContent = bytes(value.stored?.usage);
    return value;
  })();
  try {
    return await statsPending;
  } finally {
    statsPending = null;
  }
}
function renderOps() {
  const o = Object.keys(templates).sort();
  $('#chips').innerHTML = o.length
    ? o
        .slice(0, 40)
        .map(x => `<span>${esc(x)}</span>`)
        .join('')
    : 'Browse X to teach XVault its current operations.';
}
function routePath(t) {
  try {
    return new URL(t?.pageHref || t?.pagePath || '', 'https://x.com').pathname;
  } catch {
    return '';
  }
}
function score(t, k) {
  const op = t?.operation || '',
    p = routePath(t);
  let s = 0;
  if (k === 'bookmarks') {
    if (/bookmark/i.test(op)) s += 120;
    if (p === '/i/history') s += 100;
    if (/like|favorite/i.test(op)) s -= 120;
  }
  if (k === 'likes') {
    if (/like|favorite/i.test(op)) s += 120;
    if (p === '/i/history/likes') s += 120;
  }
  if (k === 'profile') {
    if (/UserTweetsAndReplies/i.test(op)) s += 220;
    if (/UserTweets|UserMedia|user.*tweet|tweet.*user/i.test(op)) s += 120;
    if (/^\/[A-Za-z0-9_]{1,15}\/?$/.test(p)) s += 45;
  }
  return s;
}
function tpl(k = source) {
  return (
    Object.values(templates)
      .map(t => ({ t, s: score(t, k) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)[0]?.t || null
  );
}
function smartSourceFromUrl(url = location.href) {
  try {
    const p = new URL(url).pathname;
    if (p === '/i/history') return 'bookmarks';
    if (p === '/i/history/likes') return 'likes';
    if (
      /^\/[A-Za-z0-9_]{1,15}\/?$/.test(p) &&
      !['home', 'explore', 'search', 'notifications', 'messages', 'compose'].includes(p.slice(1))
    )
      return 'profile';
    return 'timeline';
  } catch {
    return settings.lastArchiveSource || 'bookmarks';
  }
}
function selectSource(update = true) {
  $$('.source').forEach(x => {
    const on = x.dataset.source === source;
    x.classList.toggle('selected', on);
    x.setAttribute('aria-checked', String(on));
  });
  $('#profileWrap').classList.toggle('hidden', source !== 'profile');
  if (update) method();
}
function method() {
  const t = tpl();
  $('#methodTitle').textContent = `Smart — ${source[0].toUpperCase() + source.slice(1)}`;
  $('#methodText').textContent = t
    ? `Direct candidate: ${t.operation}. If page 1 fails, XVault automatically switches to adaptive scrolling.`
    : 'No direct operation is required: XVault can auto-prime and fall back to scrolling.';
  $('#ready').textContent = t ? `Direct ready · ${t.operation}` : 'Fallback ready';
  $('#ready').classList.toggle('ok', true);
  $('#sourceDiag').textContent =
    source === 'bookmarks'
      ? 'Current Bookmarks route: /i/history. Auto-prime knows this route.'
      : source === 'likes'
        ? 'Current Likes route: /i/history/likes.'
        : source === 'profile'
          ? 'Profile archives always force a @handle subfolder for media.'
          : 'Current timeline is archived in place.';
}
function targetUrl(k = source) {
  if (k === 'bookmarks') return 'https://x.com/i/history';
  if (k === 'likes') return 'https://x.com/i/history/likes';
  if (k === 'profile') {
    const h = $('#handle').value.trim().replace(/^@/, '');
    return h ? `https://x.com/${h}${settings.profileArchiveMode === 'complete' ? '/with_replies' : ''}` : null;
  }
  return null;
}
async function prime() {
  return primeKind(source);
}
async function primeKind(k) {
  const url = targetUrl(k);
  if (!url) return toast(k === 'profile' ? 'Enter a profile handle.' : 'Current timeline needs no priming.');
  await call({ type: 'NAVIGATE_X', url });
  toast(`Opened ${k}. XVault will learn its live operation automatically.`);
}
async function ensureRoute() {
  const url = targetUrl();
  if (!url) return true;
  const a = await call({ type: 'ACTIVE_X_TAB' });
  if (a?.tab?.url && new URL(a.tab.url).pathname === new URL(url).pathname) return true;
  await call({ type: 'NAVIGATE_X', url });
  toast(`Auto-prime: opening ${source}…`);
  for (let i = 0; i < 25; i++) {
    await sleep(300);
    const r = await call({ type: 'ACTIVE_X_TAB' });
    if (r?.tab?.status === 'complete') break;
  }
  await sleep(1800);
  templates = (await chrome.storage.local.get('graphqlTemplates')).graphqlTemplates || {};
  return true;
}
async function start() {
  if (source === 'profile' && !$('#handle').value.trim()) return toast('Enter a profile handle.');
  if (settings.autoPrimeHistory !== false) await ensureRoute();
  if (source === 'profile') {
    const v = await tab({ type: 'XV_VALIDATE_PROFILE' });
    if (v?.reply?.ok && v.reply.exists === false) {
      const h = $('#handle').value.trim().replace(/^@/, '');
      $('#runTitle').textContent = 'Profile not found';
      $('#runPhase').textContent = 'error';
      toast(`@${h} does not exist or is unavailable on X.`);
      return { ok: false, error: 'Profile not found' };
    }
  }
  await refresh();
  activeRun = crypto.randomUUID();
  const handle = source === 'profile' ? $('#handle').value.trim().replace(/^@/, '') : null,
    template = tpl(),
    fullMirror = $('#runMirror').checked || settings.fullMirrorMode;
  $('#runTitle').textContent = 'Initializing';
  $('#runPhase').textContent = 'auto-prime';
  $('#runOp').textContent = template?.operation || 'adaptive fallback';
  $('#rid').textContent = activeRun.slice(0, 8);
  $('#pages').textContent = '0';
  $('#prog').style.width = '8%';
  debugLines = [];
  debug(`Run ${activeRun.slice(0, 8)} · ${source}${handle ? ` @${handle}` : ''}`);
  const r = await tab({
    type: 'XV_SMART_START',
    runId: activeRun,
    source,
    profileHandle: handle,
    template,
    fullMirror,
  });
  if (!r?.reply?.ok && r?.reply?.error) return toast(r.reply.error);
  monitor(activeRun);
}
async function monitor(id) {
  const started = Date.now();
  while (activeRun === id) {
    await sleep(750);
    const r = await call({ type: 'GET_JOB', id }),
      j = r?.job;
    if (!j) continue;
    const phase = j.phase || j.state || 'running';
    $('#runTitle').textContent = labelState(j.state);
    $('#runPhase').textContent = phase;
    $('#pages').textContent = j.page || 0;
    $('#runPosts').textContent = j.posts ?? '—';
    $('#rate').textContent = j.rateLimit?.remaining ?? '—';
    $('#prog').style.width = j.state === 'complete' ? '100%' : `${Math.min(94, 10 + ((j.page || 0) % 80))}%`;
    $('#debugState').textContent = phase.toUpperCase();
    if (j.error) debug(`ERROR · ${j.error}`);
    if (['complete', 'error'].includes(j.state)) {
      activeRun = null;
      $('#prog').style.width = '100%';
      toast(j.state === 'complete' ? 'Archive complete' : 'Archive failed');
      stats();
      break;
    }
    if (Date.now() - started > 8 * 60 * 60 * 1000) {
      debug('Monitor timeout after 8h');
      break;
    }
  }
}
function labelState(s) {
  return (
    {
      initializing: 'Initializing',
      running: 'Archiving',
      fallback: 'Switching fallback',
      'direct-done': 'Direct complete',
      'direct-error': 'Direct failed',
      verifying: 'Verifying',
      complete: 'Complete',
      error: 'Error',
      'rate-limit': 'Rate limited',
    }[s] ||
    s ||
    'Archiving'
  );
}
async function testCrawler() {
  const r = await tab({ type: 'XV_TEST_CRAWLER' }),
    x = r?.reply;
  if (x?.ok) toast(`Crawler test: ${x.found} new visible posts · ${x.templates?.length || 0} operations`);
  else toast(x?.error || 'Crawler test failed');
}
async function archiveEverything() {
  page('archive');
  for (const k of ['bookmarks', 'likes']) {
    source = k;
    selectSource();
    await start();
    while (activeRun) await sleep(1000);
  }
  toast('History archive complete');
}
async function saveCollection() {
  const handles = $('#collectionHandles')
    .value.split(/\s+/)
    .map(x => x.replace(/^@/, '').trim())
    .filter(Boolean);
  await save({ profileCollections: handles });
  toast(`Saved ${handles.length} profile handles`);
}
async function archiveCollection() {
  const handles = (
    $('#collectionHandles').value.trim()
      ? $('#collectionHandles').value.split(/\s+/)
      : settings.profileCollections || []
  )
    .map(x => x.replace(/^@/, ''))
    .filter(Boolean);
  for (const h of handles) {
    source = 'profile';
    selectSource();
    $('#handle').value = h;
    await start();
    while (activeRun) await sleep(1000);
  }
  toast('Profile collection complete');
}
function debug(x) {
  debugLines.unshift(`${new Date().toLocaleTimeString()} · ${x}`);
  debugLines = debugLines.slice(0, 80);
  $('#debugLog').innerHTML = debugLines.map(x => `<div>${esc(x)}</div>`).join('');
}
async function loadLib() {
  const limit = Math.max(1, Math.min(1500, Number(settings.libraryPageSize) || 120));
  const r = await call({
    type: 'QUERY_LIBRARY_PAGE',
    query: ($('#search')?.value || '').trim(),
    sort: $('#sort')?.value || 'new',
    limit,
    after: null,
  });
  if (!r?.ok) {
    toast(r?.error || 'Could not open the Library');
    return;
  }
  const videoTimes = new Map([...document.querySelectorAll('#list video')].map(v => [v.src, v.currentTime || 0]));
  library = r.rows || [];
  libraryDownloads = new Map();
  for (const row of r.downloads || []) {
    const id = String(row.item?.tweetId || '');
    if (!libraryDownloads.has(id)) libraryDownloads.set(id, []);
    libraryDownloads.get(id).push(row);
  }
  renderLib();
  $$('#list video').forEach(v => {
    const t = videoTimes.get(v.src);
    if (t > 0)
      v.addEventListener(
        'loadedmetadata',
        () => {
          try {
            if (Math.abs((v.currentTime || 0) - t) > 1) v.currentTime = t;
          } catch {}
        },
        { once: true }
      );
  });
  installAnimatedObserver();
  wireLibraryVideoState();
}
function bestVariant(m) {
  return (
    (m.variants || []).filter(v => v.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url ||
    m.playbackUrl ||
    null
  );
}
function mediaKind(m) {
  const t = String(m.type || '').toLowerCase(),
    u = String(m.url || '').toLowerCase();
  if (
    m.animatedWebP ||
    m.isAnimated ||
    t === 'animated_gif' ||
    t === 'gif' ||
    t === 'animated_webp' ||
    /\.gif(?:\?|$)/.test(u) ||
    (/\.webp(?:\?|$)/.test(u) && t !== 'photo')
  )
    return 'gif';
  if (t === 'video') return 'video';
  return 'image';
}
function animatedNativeUrl(m) {
  const candidates = [
    m.nativeAnimatedUrl,
    m.originalUrl,
    m.url,
    m.playbackUrl,
    ...(m.variants || []).map(v => v.url),
  ].filter(Boolean);
  return candidates.find(u => /\.(gif|webp)(?:[?#]|$)/i.test(String(u))) || null;
}
function mediaSource(m) {
  const kind = mediaKind(m);
  if (kind === 'gif') {
    const native = animatedNativeUrl(m);
    if (native) return { src: native, native: true, kind };
    return { src: bestVariant(m) || m.playbackUrl || m.url, native: false, kind };
  }
  if (kind === 'video') return { src: bestVariant(m) || m.playbackUrl || m.url, native: false, kind };
  return { src: m.url || m.preview, native: true, kind };
}
function helperMediaUrl(path) {
  if (!path) return null;
  return `data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=#xvhelper=${encodeURIComponent(path)}`;
}
function localConvertedFor(t, m) {
  if (settings.preferLocalConvertedAnimationPreviews === false) return null;
  const rows = libraryDownloads.get(String(t.id)) || [];
  const r = rows.find(
    x =>
      x.conversionExpected &&
      (String(x.item?.mediaId || '') === String(m.id || '') || x.item?.url === m.playbackUrl || x.item?.url === m.url)
  );
  if (!r) return null;
  const mode = settings.libraryAnimationMode || 'native';
  if (mode === 'mp4') return null;
  const pick = (path, file) =>
    settings.helperPreferHttpPreview !== false && path ? helperMediaUrl(path) : file || null;
  if (mode === 'webp') return pick(r.convertedWebPPath, r.convertedWebPFileUrl);
  if (mode === 'gif')
    return pick(r.convertedGifPath, r.convertedGifFileUrl) || pick(r.convertedPath, r.convertedFileUrl);
  return (
    pick(r.convertedGifPath, r.convertedGifFileUrl) ||
    pick(r.convertedWebPPath, r.convertedWebPFileUrl) ||
    pick(r.convertedPath, r.convertedFileUrl)
  );
}
function linkifyText(text = '') {
  const escd = esc(text);
  return escd.replace(/((?:https?:\/\/|www\.)[^\s<]+)/gi, raw => {
    let shown = raw,
      href = raw.startsWith('www.') ? 'https://' + raw : raw;
    const trail = (href.match(/[),.!?;:]+$/) || [''])[0];
    if (trail) {
      href = href.slice(0, -trail.length);
      shown = shown.slice(0, -trail.length);
    }
    return `<a class="tweetLink" href="${href}" target="_blank" rel="noopener noreferrer">${shown}</a>${trail}`;
  });
}
function archiveScopeFor(t) {
  const f = [...(t.archiveSources || []), ...(t.sourceFlags || [])].map(x => String(x).toLowerCase());
  if (f.some(x => x.includes('bookmark'))) return 'bookmarks';
  if (f.some(x => x.includes('like') || x.includes('favorite'))) return 'likes';
  if (f.some(x => x.includes('profile'))) return 'profile';
  return 'timeline';
}
const downloadPostBusy = new Set();
function downloadItem(t, m, mi) {
  const logical = mediaLogical(m),
    srcObj = mediaSource(m);
  let src = srcObj.src;
  if (logical === 'gif' && m.type === 'animated_gif') src = bestVariant(m) || m.playbackUrl || src;
  if (!src) return null;
  return {
    url: src,
    tweetId: String(t.id),
    sourcePostUrl: t.url || null,
    mediaId: m.id || `${t.id}-${mi}`,
    index: mi + 1,
    author: t.author?.handle || 'unknown',
    createdAt: t.createdAt || null,
    mediaType: m.type || srcObj.kind,
    sourceMediaType: m.type || srcObj.kind,
    width: m.width || 0,
    height: m.height || 0,
    archiveScope: archiveScopeFor(t),
    profileHandle:
      archiveScopeFor(t) === 'profile' ? t.archiveProfile || t.profileHandle || t.author?.handle || '' : '',
    profileRelation:
      t.profileRelation ||
      (archiveScopeFor(t) === 'profile' &&
      t.archiveProfile &&
      t.author?.handle &&
      String(t.author.handle).toLowerCase() !== String(t.archiveProfile).toLowerCase()
        ? 'retweets'
        : 'media'),
  };
}
async function downloadPost(t) {
  const id = String(t.id);
  if (downloadPostBusy.has(id)) return toast('This post is already being queued');
  const items = (t.media || []).map((m, i) => downloadItem(t, m, i)).filter(Boolean);
  if (!items.length) return toast('This post has no downloadable media');
  downloadPostBusy.add(id);
  const buttons = $$('#list [data-download-post]').filter(button => button.dataset.downloadPost === id);
  const labels = new Map(buttons.map(button => [button, { html: button.innerHTML, title: button.title }]));
  buttons.forEach(button => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Queuing…';
    button.title = 'Queuing post media';
  });
  try {
    const result = await call({ type: 'DOWNLOAD_URLS', items });
    if (!result?.ok) throw Error(result?.error || 'The download queue did not respond');
    toast(`Queued ${result.added || 0} media · ${result.skipped || 0} skipped`);
  } catch (error) {
    toast(`Could not queue post media: ${error.message}`);
  } finally {
    downloadPostBusy.delete(id);
    buttons.forEach(button => {
      const old = labels.get(button);
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.innerHTML = old.html;
      button.title = old.title;
    });
  }
}
async function downloadOne(t, m, mi) {
  const item = downloadItem(t, m, mi);
  if (!item) return toast('No media URL available');
  const r = await call({ type: 'DOWNLOAD_URLS', items: [item] });
  toast(r?.blocked ? r.error : r?.added === 0 ? 'Already queued / downloaded' : 'Media queued');
}

function installAnimatedObserver() {
  if (installAnimatedObserver.io) installAnimatedObserver.io.disconnect();
  const vids = $$('#list .mediaItem.gif video');
  if (!vids.length) return;
  const io = new IntersectionObserver(
    es => {
      for (const e of es) {
        const v = e.target;
        if (e.isIntersecting && settings.libraryAutoplayAnimated !== false) v.play().catch(() => {});
        else v.pause();
      }
    },
    { rootMargin: '220px 0px', threshold: 0.08 }
  );
  vids.forEach(v => {
    v.removeAttribute('autoplay');
    io.observe(v);
  });
  installAnimatedObserver.io = io;
}
function applyVideoState(v) {
  if (!v) return;
  const vol = Math.max(0, Math.min(1, Number(settings.libraryVolume ?? 0.72)));
  v.volume = vol;
  if (settings.libraryVideoMuted === true) v.muted = true;
  else if (v.dataset.xvAnimation !== '1') v.muted = false;
}
function wireLibraryVideoState(scope = document) {
  scope.querySelectorAll?.('video').forEach(v => {
    applyVideoState(v);
    if (v.dataset.xvStateWired) return;
    v.dataset.xvStateWired = '1';
    v.addEventListener('volumechange', () => {
      if (videoSyncLock || !settings.rememberLibraryVolume) return;
      videoSyncLock = true;
      const vol = v.muted ? 0 : v.volume;
      settings.libraryVolume = vol;
      settings.libraryVideoMuted = v.muted;
      save({ libraryVolume: vol, libraryVideoMuted: v.muted }, false);
      document.querySelectorAll('#list video,#lightbox video,#detailsDrawer video').forEach(o => {
        if (o === v) return;
        o.volume = v.volume;
        if (o.dataset.xvAnimation !== '1') o.muted = v.muted;
      });
      setTimeout(() => (videoSyncLock = false), 0);
    });
    v.addEventListener('loadedmetadata', () => applyVideoState(v), { once: true });
  });
}
function parseNum(v) {
  v = String(v || '').toLowerCase();
  const m = v.match(/^([0-9.]+)([kmb])?$/);
  if (!m) return Number(v) || 0;
  let n = Number(m[1]);
  if (m[2] === 'k') n *= 1e3;
  if (m[2] === 'm') n *= 1e6;
  if (m[2] === 'b') n *= 1e9;
  return n;
}
function tokenMatch(t, token) {
  let [k, ...rest] = token.split(':'),
    v = rest.join(':');
  if (!v)
    return (
      (t.text || '').toLowerCase().includes(token.toLowerCase()) ||
      (t.author?.handle || '').toLowerCase().includes(token.toLowerCase())
    );
  k = k.toLowerCase();
  v = v.toLowerCase();
  const media = t.media || [],
    um = t.userMeta || {};
  if (k === 'from' || k === 'artist' || k === 'author')
    return (t.author?.handle || '').toLowerCase() === v.replace(/^@/, '');
  if (k === 'type' || k === 'has') {
    if (v === 'gif' || v === 'animation')
      return media.some(m => m.type === 'animated_gif' || /gif|webp/i.test(m.type || ''));
    if (v === 'video') return media.some(m => m.type === 'video');
    if (v === 'image' || v === 'photo') return media.some(m => m.type === 'photo');
    if (v === 'media') return media.length > 0;
  }
  if (k === 'source')
    return [...(t.sourceFlags || []), ...(t.archiveSources || [])].some(x => String(x).toLowerCase().includes(v));
  if (k === 'rating') return v === 'sensitive' ? !!t.sensitive : !t.sensitive;
  if (k === 'fav' || k === 'favorite') return String(!!um.favorite) === v;
  if (k === 'tag') return (um.tags || []).some(x => x.toLowerCase().includes(v));
  if (['likes', 'views', 'bookmarks', 'reposts'].includes(k)) {
    const raw = Number(t.metrics?.[k] || 0),
      op = v.startsWith('>=') ? '>=' : v.startsWith('<=') ? '<=' : v[0],
      num = parseNum(v.replace(/^[<>]=?/, '') || 0);
    return op === '>'
      ? raw > num
      : op === '<'
        ? raw < num
        : op === '>='
          ? raw >= num
          : op === '<='
            ? raw <= num
            : raw === num;
  }
  if (k === 'id') return String(t.id) === v;
  return true;
}
function mediaLogical(m) {
  if (m.animatedWebP || m.isAnimated || m.type === 'animated_gif' || m.type === 'animated_webp' || m.type === 'gif')
    return 'gif';
  if (m.type === 'video') return 'video';
  if (m.type === 'photo') return 'image';
  return /gif|animated/i.test(m.type || '') ? 'gif' : 'media';
}
function renderLib(options = {}) {
  const box = $('#list');
  if (!box) return;
  const videoTimes = new Map([...box.querySelectorAll('video')].map(v => [v.src, v.currentTime || 0]));
  const q = ($('#search').value || '').trim();
  if (settings.rememberLibraryQuery) save({ lastLibraryQuery: q }, false);
  const tokens = (q.match(/(?:[^\s\"]+|\"[^\"]*\")+/g) || []).map(x => x.replace(/^\"|\"$/g, ''));
  const externallyFiltered = options?.externallyFiltered === true;
  let rows = externallyFiltered ? library.slice() : library.filter(t => tokens.every(tok => tokenMatch(t, tok)));
  const sort = $('#sort').value;
  if (!externallyFiltered)
    rows.sort((a, b) =>
      sort === 'old'
        ? (a.archivedAt || 0) - (b.archivedAt || 0)
        : sort === 'likes'
          ? (b.metrics?.likes || 0) - (a.metrics?.likes || 0)
          : sort === 'views'
            ? (b.metrics?.views || 0) - (a.metrics?.views || 0)
            : sort === 'bookmarks'
              ? (b.metrics?.bookmarks || 0) - (a.metrics?.bookmarks || 0)
              : sort === 'reposts'
                ? (b.metrics?.reposts || 0) - (a.metrics?.reposts || 0)
                : sort === 'replies'
                  ? (b.metrics?.replies || 0) - (a.metrics?.replies || 0)
                  : sort === 'media'
                    ? (b.media?.length || 0) - (a.media?.length || 0)
                    : sort === 'author'
                      ? String(a.author?.handle || '').localeCompare(String(b.author?.handle || ''))
                      : (b.archivedAt || 0) - (a.archivedAt || 0)
    );
  const totalRows = rows.length;
  if (!externallyFiltered) rows = rows.slice(0, settings.libraryPageSize || 300);
  box.dataset.mediaSize = settings.libraryMediaSize || 'comfortable';
  box.dataset.view = settings.libraryView || 'timeline';
  let mediaCount = 0,
    localCount = 0;
  box.innerHTML =
    rows
      .map((t, idx) => {
        const rawText = String(t.text || ''),
          textPreview = rawText.length > 1200 ? rawText.slice(0, 1200) + '…' : rawText,
          um = t.userMeta || {},
          dls = libraryDownloads.get(String(t.id)) || [],
          name = t.author?.name || t.author?.handle || 'Unknown',
          handle = t.author?.handle || 'unknown',
          avatar = t.author?.avatar || '',
          local = dls.filter(x => x.state === 'complete').length;
        localCount += local;
        const allMedia = t.media || [],
          galleryLimit = ['gallery', 'masonry'].includes(box.dataset.view) ? 1 : 4,
          visibleMedia = allMedia.slice(0, galleryLimit);
        mediaCount += allMedia.length;
        const media = visibleMedia
          .map((m, mi) => {
            const kind = mediaLogical(m),
              basePick = mediaSource(m),
              mode = settings.libraryAnimationMode || 'native',
              localGif = kind === 'gif' ? localConvertedFor(t, m) : null,
              forceMp4 = kind === 'gif' && mode === 'mp4',
              pick = forceMp4
                ? { src: bestVariant(m) || m.playbackUrl || basePick.src, native: false, kind }
                : localGif
                  ? { src: localGif, native: true, kind, localConverted: true }
                  : basePick,
              src = pick.src;
            if (!src) return '';
            const ext = (new URL(src, location.href).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1] || kind).toUpperCase(),
              dim = m.width && m.height ? `${m.width}×${m.height}` : '';
            const dl = `<button class="mediaDownload" data-dl-one="${idx}:${mi}" title="Download this media" aria-label="Download this media">↓</button>`;
            if (kind === 'video' || (kind === 'gif' && !pick.native))
              return `<div class="mediaItem ${kind}" data-t="${idx}" data-m="${mi}"${m.width > 0 && m.height > 0 ? ` style="--ar:${Number(m.width)}/${Number(m.height)}"` : ''}><video src="${esc(src)}" poster="${esc(m.preview || m.url || '')}" ${settings.libraryVideoMuted === true ? 'muted' : ''} ${kind === 'gif' && settings.libraryAutoplayAnimated !== false ? 'autoplay loop playsinline' : ''} ${settings.libraryVideoControls !== false ? 'controls' : ''} preload="${esc(settings.libraryPreloadMedia || 'metadata')}"></video>${kind === 'video' ? `<span class="playOverlay"><i>${window.XVaultIcons?.svg('play') || '▶'}</i></span>` : ''}<span class="mediaType">${kind === 'gif' ? 'GIF' : 'Video'}</span><span class="formatBadge">${esc(ext)}${dim ? ' · ' + esc(dim) : ''}</span>${dl}</div>`;
            return `<div class="mediaItem ${kind}" data-t="${idx}" data-m="${mi}"${m.width > 0 && m.height > 0 ? ` style="--ar:${Number(m.width)}/${Number(m.height)}"` : ''}><img loading="lazy" src="${esc(src)}" ${pick.localConverted ? `data-local-converted="1" data-fallback="${esc(basePick.src || '')}"` : ''} alt="Media from @${esc(handle)}"><span class="mediaType">${kind === 'gif' ? 'GIF' : 'Image'}</span><span class="formatBadge">${esc(ext)}${dim ? ' · ' + esc(dim) : ''}</span>${dl}</div>`;
          })
          .join('');
        const metrics =
          settings.libraryShowMetrics === false
            ? ''
            : `<div class="metricBar"><span>♥ <b>${fmt(t.metrics?.likes)}</b></span><span>↻ <b>${fmt(t.metrics?.reposts)}</b></span><span>💬 <b>${fmt(t.metrics?.replies)}</b></span><span>◉ <b>${fmt(t.metrics?.views)}</b></span><span>◆ <b>${fmt(t.metrics?.bookmarks)}</b></span><span class="disk" title="Media files saved to disk"><b>${local}/${(t.media || []).length}</b> on disk</span></div>`;
        const allTags = um.tags || [],
          shownTags = allTags.slice(0, 8),
          tags =
            shownTags
              .map(
                x => `<button type="button" data-tag="${esc(x)}" aria-label="Filter by #${esc(x)}">#${esc(x)}</button>`
              )
              .join('') +
            (allTags.length > shownTags.length
              ? `<button type="button" class="tagOverflow" data-expand-tags="${idx}" aria-expanded="false" aria-label="Show ${allTags.length - shownTags.length} more tags">+${allTags.length - shownTags.length} tags</button>`
              : '');
        return `<article class="tweet ${t.sensitive ? 'sensitive' : ''} ${um.favorite ? 'favorite' : ''}" data-id="${esc(t.id)}"><div class="who">${settings.libraryShowAvatars !== false && avatar ? `<img class="avatar" src="${esc(avatar)}">` : `<div class="avatar fallback">${esc(handle[0]?.toUpperCase() || '?')}</div>`}<div class="identity">${settings.libraryShowNames !== false ? `<b>${esc(name)} ${t.author?.verified ? '✓' : ''}</b>` : ''}<small>@${esc(handle)}</small></div>${t.createdAt && Number.isFinite(new Date(t.createdAt).getTime()) ? `<time datetime="${esc(new Date(t.createdAt).toISOString())}" title="${esc(new Date(t.createdAt).toLocaleString())}">${esc(new Date(t.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))}</time>` : ''}</div><div class="tweetMetaBadges">${window.XVaultLibraryModel?.isInbox?.(t, settings.inboxSince) ? '<span class="new">New</span>' : ''}${t.sensitive ? '<span class="flag">Sensitive</span>' : ''}${
          t.sourceFlags
            ?.slice(0, 2)
            .map(x => `<span>${esc(x)}</span>`)
            .join('') || ''
        }</div><p class="tweetText">${linkifyText(textPreview)}</p>${rawText.length > 1200 ? `<button type="button" class="textOverflow" data-details="${esc(t.id)}" aria-label="Open full post text in Inspector, ${fmt(rawText.length)} characters">Open full post text · ${fmt(rawText.length)} characters</button>` : ''}${media ? `<div class="mediaGrid" data-count="${allMedia.length}" data-visible="${visibleMedia.length}" data-more="${Math.max(0, allMedia.length - (['gallery', 'masonry'].includes(box.dataset.view) ? 1 : visibleMedia.length))}">${media}${allMedia.length > visibleMedia.length && !['gallery', 'masonry'].includes(box.dataset.view) ? `<button type="button" class="mediaOverflow" data-media-more="${idx}" aria-label="Open viewer to browse ${allMedia.length} media items">+${allMedia.length - visibleMedia.length} more media</button>` : ''}</div>` : ''}${metrics}<div class="tweetTags">${tags}<button data-addtag="${esc(t.id)}" title="Add a tag">Tag</button></div><div class="tweetActions"><button data-fav="${esc(t.id)}" aria-pressed="${um.favorite ? 'true' : 'false'}" title="${um.favorite ? 'Remove favorite (F)' : 'Favorite (F)'}"><span class="lbl">${um.favorite ? 'Remove favorite' : 'Favorite'}</span></button><button class="primary" data-download-post="${esc(t.id)}" title="Download media"><span class="lbl">Download post</span></button><button data-quicklook="${esc(t.id)}" title="Quick Look (Space)"><span class="lbl">Quick Look</span></button><button data-details="${esc(t.id)}" title="Inspector"><span class="lbl">Details</span></button><button data-copy="${esc(t.url || '')}" title="Copy link"><span class="lbl">Copy link</span></button><button data-open="${esc(t.url || '')}" title="Open on X"><span class="lbl">Open X</span></button>${dls[0]?.downloadId ? `<button data-show="${dls[0].downloadId}" title="Show file"><span class="lbl">Show file</span></button>` : ''}</div></article>`;
      })
      .join('') || '<div class="empty">No matches. Try removing filters or archive a source first.</div>';
  if ($('#libShown')) $('#libShown').textContent = fmt(totalRows);
  if ($('#libMediaCount')) $('#libMediaCount').textContent = fmt(mediaCount);
  if ($('#libLocalCount')) $('#libLocalCount').textContent = fmt(localCount);
  const shown = rows;
  $$('#list .mediaItem').forEach(
    el =>
      (el.onclick = e => {
        if (e.target.closest('video[controls]') && e.target.tagName === 'VIDEO') return;
        openLightbox(shown, Number(el.dataset.t), Number(el.dataset.m));
      })
  );
  $$('#list [data-media-more]').forEach(
    button =>
      (button.onclick = e => {
        e.stopPropagation();
        openLightbox(shown, Number(button.dataset.mediaMore), 0);
      })
  );
  $$('#list [data-download-post]').forEach(
    b =>
      (b.onclick = e => {
        e.stopPropagation();
        const t = shown.find(x => String(x.id) === String(b.dataset.downloadPost));
        if (t) downloadPost(t);
      })
  );
  $$('#list [data-dl-one]').forEach(
    b =>
      (b.onclick = e => {
        e.stopPropagation();
        const [ti, mi] = b.dataset.dlOne.split(':').map(Number),
          t = shown[ti],
          m = t?.media?.[mi];
        if (t && m) downloadOne(t, m, mi);
      })
  );
  $$('#list [data-open]').forEach(b => (b.onclick = () => chrome.tabs.create({ url: b.dataset.open })));
  $$('#list [data-show]').forEach(
    b => (b.onclick = () => call({ type: 'SHOW_DOWNLOAD', downloadId: Number(b.dataset.show) }))
  );
  $$('#list [data-copy]').forEach(
    b =>
      (b.onclick = async () => {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('Link copied');
      })
  );
  $$('#list [data-details]').forEach(b => (b.onclick = () => window.openDetails(b.dataset.details)));
  $$('#list [data-fav]').forEach(b => (b.onclick = () => toggleFavorite(b.dataset.fav)));
  $$('#list [data-addtag]').forEach(b => (b.onclick = () => addTag(b.dataset.addtag)));
  $$('#list [data-tag]').forEach(
    b =>
      (b.onclick = () => {
        $('#search').value = `tag:${b.dataset.tag}`;
        renderLib();
      })
  );
  $$('#list [data-expand-tags]').forEach(
    button =>
      (button.onclick = () => {
        const post = shown[Number(button.dataset.expandTags)],
          container = button.closest('.tweetTags');
        if (!post || !container) return;
        const expanded = button.getAttribute('aria-expanded') === 'true',
          all = post.userMeta?.tags || [],
          remaining = Math.max(0, all.length - 8);
        if (expanded) {
          container.querySelectorAll('[data-overflow-tag]').forEach(tag => tag.remove());
          button.setAttribute('aria-expanded', 'false');
          button.setAttribute('aria-label', `Show ${remaining} more tags`);
          button.textContent = `+${remaining} tags`;
          return;
        }
        all.slice(8).forEach(tag => {
          const chip = document.createElement('button');
          chip.type = 'button';
          chip.dataset.tag = tag;
          chip.dataset.overflowTag = '';
          chip.setAttribute('aria-label', `Filter by #${tag}`);
          chip.textContent = `#${tag}`;
          chip.onclick = () => {
            $('#search').value = `tag:${tag}`;
            renderLib();
          };
          container.insertBefore(chip, button);
        });
        button.setAttribute('aria-expanded', 'true');
        button.setAttribute('aria-label', 'Show fewer tags');
        button.textContent = 'Show fewer tags';
      })
  );
  $$('#list img[data-local-converted]').forEach(im =>
    im.addEventListener('error', () => {
      const u = im.dataset.fallback;
      if (!u) return;
      const host = im.closest('.mediaItem');
      const v = document.createElement('video');
      v.src = u;
      v.controls = settings.libraryVideoControls !== false;
      v.loop = true;
      v.autoplay = settings.libraryAutoplayAnimated !== false;
      v.muted = settings.libraryVideoMuted === true;
      v.playsInline = true;
      im.replaceWith(v);
      host?.querySelector('.mediaType') &&
        (host.querySelector('.mediaType').textContent = 'X GIF · MP4 FALLBACK (enable file URL access / run helper)');
    })
  );
  if (settings.libraryHoverVideo !== false)
    $$('#list .mediaItem video:not([loop])').forEach(v => {
      v.addEventListener('mouseenter', () => v.play().catch(() => {}));
      v.addEventListener('mouseleave', () => {
        v.pause();
        if (settings.libraryVideoHoverReset === true) v.currentTime = 0;
      });
    });
  $$('#list video').forEach(v => {
    const t = videoTimes.get(v.src);
    if (t > 0)
      v.addEventListener(
        'loadedmetadata',
        () => {
          try {
            if (Math.abs((v.currentTime || 0) - t) > 1) v.currentTime = t;
          } catch {}
        },
        { once: true }
      );
  });
  installAnimatedObserver();
  wireLibraryVideoState();
}
async function clearLibrary() {
  if (settings.confirmClearArchive !== false && !confirm('Clear local XVault library? Downloaded files stay on disk.'))
    return;
  await call({ type: 'CLEAR_LIBRARY' });
  library = [];
  renderLib();
  stats();
  toast('Library cleared');
}
function verificationText(r) {
  const state = r.verification?.state || r.verificationState || '';
  const conversion = r.conversionState
    ? `Conversion ${r.conversionState}${r.conversionProgress != null ? ` ${Math.round(Number(r.conversionProgress) * 100)}%` : ''}`
    : '';
  return (
    conversion ||
    {
      verified: 'Verified',
      'verified-with-warning': 'Verified with warning',
      mismatch: 'Wrong content returned',
      corrupt: 'Corrupt or too small',
      missing: 'Source file missing',
      'verification-unavailable': 'Verification unavailable',
      'verification-pending': 'Verification pending',
    }[state] ||
    state
  );
}
async function queueStats() {
  if (!$('#qQueued')) return;
  const q = await call({ type: 'DOWNLOAD_QUEUE_STATS' });
  if (!q?.ok) return;
  queueSnapshot = q;
  $('#qQueued').textContent = fmt(q.queued);
  $('#qActive').textContent = fmt(q.downloading);
  $('#qDone').textContent = fmt(q.complete);
  $('#qFailed').textContent = fmt(q.failed);
  const pct =
    q.totalBytes > 0
      ? Math.min(100, Math.round((q.bytesReceived / q.totalBytes) * 100))
      : q.downloading
        ? 35
        : q.queued
          ? 8
          : 0;
  $('#qPercent').textContent = `${pct}%`;
  $('#qBar').style.width = `${pct}%`;
  const queueIndexProgress = Number(q.bookkeeping?.assetLookupIndex?.processed) || 0;
  $('#qTitle').textContent = q.downloading
    ? `Downloading ${q.downloading}${q.countsReady ? '' : ' · totals rebuilding'}`
    : !q.countsReady
      ? queueIndexProgress
        ? `Rebuilding queue totals · ${fmt(queueIndexProgress)} scanned`
        : 'Rebuilding queue totals…'
      : q.retryWait
        ? `${q.retryWait} waiting to retry`
        : q.queued
          ? `${q.queued} queued`
          : q.failed
            ? 'Finished with errors'
            : 'Idle';
  $('#qBytes').textContent = `${bytes(q.bytesReceived)} / ${q.totalBytes ? bytes(q.totalBytes) : '—'}`;
  $('#qCount').textContent = q.countsReady
    ? `${q.complete} complete · ${q.failed} failed${q.verificationFailures ? ` · ${q.verificationFailures} verification failures` : ''}`
    : 'Queue history is being indexed; active transfer progress remains live.';
  $('#qSpeed').textContent = `${bytes(q.speedBps)}/s`;
  $('#qEta').textContent = `ETA ${eta(q.etaSeconds)}`;
  queueStats.n = (queueStats.n || 0) + 1;
  if (queueStats.n === 1 || queueStats.n % 3 === 0) {
    const h = await call({ type: 'GET_DOWNLOAD_HISTORY', limit: 60 });
    $('#downloadHistory').innerHTML =
      (h.rows || [])
        .map(r => {
          const source =
            r.recoveryAction === 'open-source-post' && r.item?.sourcePostUrl
              ? `<button class="mini" data-source-post="${esc(r.item.sourcePostUrl)}">Open source post</button>`
              : '';
          const conversionAction =
            r.conversionState === 'failed' ||
            ['mismatch', 'corrupt', 'missing'].includes(r.conversionVerification?.state)
              ? `<button class="mini" data-retry-conversion="${esc(r.key)}">Regenerate derivative</button>`
              : r.conversionState === 'running'
                ? `<button class="mini" data-cancel-conversion="${esc(r.key)}">Cancel conversion</button>`
                : '';
          const reason = r.verification?.reason || r.error;
          return `<div class="dlrow ${r.state}"><div><b>${esc((r.target?.filename || r.item?.url || 'media').split('/').pop())}</b><small>${esc(r.target?.kind || 'media')} · ${esc(r.state)}${verificationText(r) ? ` · ${esc(verificationText(r))}` : ''}${reason ? ` · ${esc(reason).slice(0, 100)}` : ''}</small>${source}${conversionAction}</div><span>${r.totalBytes ? bytes(r.totalBytes) : ''}</span></div>`;
        })
        .join('') || '<div class="empty">No downloads yet.</div>';
    $$('#downloadHistory [data-source-post]').forEach(
      b => (b.onclick = () => call({ type: 'OPEN_DOWNLOAD_SOURCE', url: b.dataset.sourcePost }))
    );
    $$('#downloadHistory [data-cancel-conversion]').forEach(
      b => (b.onclick = () => call({ type: 'CANCEL_CONVERSION', key: b.dataset.cancelConversion }))
    );
    $$('#downloadHistory [data-retry-conversion]').forEach(
      b => (b.onclick = () => call({ type: 'RETRY_CONVERSION', key: b.dataset.retryConversion }))
    );
  }
}
async function health() {
  const h = await call({ type: 'HEALTH_CHECK' });
  if (!h?.ok) return;
  const c = h.checks,
    q = c.queue || {},
    ir = await call({ type: 'GET_INTEGRITY' }),
    is = ir?.report?.summary || {},
    rows = [
      ['X session', c.xTab],
      ['IndexedDB', c.db],
      ['Downloads permission', c.downloads],
      ['FFmpeg Helper bridge', c.helper],
      ['FFmpeg detected', c.ffmpeg],
      ['Notifications permission', c.notifications],
      ['Prevent-sleep permission', c.power],
      ['Bookmarks operation', c.bookmarksTemplate],
      ['Likes operation', c.likesTemplate],
      [`${c.queueErrors} failed downloads`, c.queueErrors === 0],
      [`${q.verificationFailures || 0} verification failures`, !q.verificationFailures],
      [`${is.derivativeIssues || 0} derivative issues`, !is.derivativeIssues],
      [`${c.templates} learned operations`, c.templates > 0],
      [
        c.install?.checked
          ? c.install.ids.length > 1 || c.install.foreignButtons > 0
            ? `Another XVault copy is active on x.com (${
                c.install.ids
                  .filter(x => x !== c.install.extensionId)
                  .map(x => x.slice(0, 8))
                  .join(', ') || 'older version'
              }). Each copy has its own queue and archive, so downloads can repeat. Disable one in chrome://extensions.`
            : 'Single XVault installation on x.com'
          : `This copy: ${c.install?.extensionId || 'unknown'} · v${c.install?.version || '?'} (open x.com to check for a second copy)`,
        !c.install?.checked || !(c.install.ids.length > 1 || c.install.foreignButtons > 0),
      ],
    ];
  $('#healthList').innerHTML = rows
    .map(
      ([n, ok]) =>
        `<div class="healthrow" data-ok="${!!ok}"><span aria-hidden="true">${ok ? '✓' : '!'}</span><b>${esc(n)}</b><small>${ok ? 'Healthy' : 'Needs attention'}</small></div>`
    )
    .join('');
}
async function activity() {
  const r = await call({ type: 'GET_RECENT_ACTIONS', limit: 100 });
  $('#activityList').innerHTML =
    (r.rows || [])
      .map(
        a =>
          `<div class="activityrow"><span>${new Date(a.at).toLocaleTimeString()}</span><b>${esc(a.text)}</b><small>${esc(a.type)}</small></div>`
      )
      .join('') || '<div class="empty">No recent actions.</div>';
}
async function testDownload() {
  const r = await call({ type: 'TEST_DOWNLOAD' });
  toast(r?.ok ? 'Test download queued in XVault/Other' : r?.error || 'Test failed');
}
async function save(p, notify = true) {
  const r = await call({ type: 'SET_SETTINGS', settings: p });
  settings = r?.settings || { ...settings, ...p };
  apply();
  sync();
  tab({ type: 'XV_REFRESH_INSTANT_SETTINGS' }).catch(() => {});
  if (notify) flashSaved();
  return settings;
}
function sync() {
  $$('[data-setting]').forEach(e => {
    const v = settings[e.dataset.setting];
    if (e.type === 'checkbox') e.checked = !!v;
    else if (v != null) e.value = String(v);
  });
  $('#capture').checked = settings.captureWhileBrowsing !== false;
  $('#runMirror').checked = !!settings.fullMirrorMode;
  $('#collectionHandles').value = (settings.profileCollections || []).join('\n');
  const fp = $('#folderPreview');
  if (fp)
    fp.textContent = `Downloads / ${settings.mediaFolder} / ${settings.forceProfileSubfolder ? '@profile / ' : ''}${settings.imageFolder} · ${settings.videoFolder} · ${settings.gifFolder}`;
  const fn = $('#filenamePreview');
  if (fn)
    fn.textContent =
      settings.fileNaming === 'random'
        ? `Example: Mn2Lq5z.${'webp'}`
        : `Template: ${settings.customFilenameTemplate || '{author}_{tweetId}_{index}'}`;
  $('#density').value = settings.uiDensity || 'comfortable';
  if ($('#libraryView')) $('#libraryView').value = settings.libraryView || 'timeline';
  if (!librarySearchInitialized) {
    librarySearchInitialized = true;
    if ($('#search') && settings.rememberLibraryQuery && settings.lastLibraryQuery)
      $('#search').value = settings.lastLibraryQuery;
  }
}
function apply() {
  const level =
    matchMedia('(prefers-reduced-motion: reduce)').matches || settings.safeMode || settings.reducedMotion
      ? 'reduced'
      : settings.animations === false
        ? 'off'
        : settings.motionLevel || 'normal';
  document.body.dataset.motion = level;
  document.body.style.setProperty(
    '--motion-scale',
    String(Math.max(0.35, Math.min(2, Number(settings.motionSpeed) || 1)))
  );
  window.XVaultSettingsChanged?.(settings);
  document.body.dataset.theme = settings.theme || 'graphite';
  document.body.dataset.density = settings.uiDensity || 'comfortable';
  document.body.dataset.uiMode = settings.uiMode || 'basic';
  document.body.dataset.cursor = settings.customCursor === false ? 'system' : settings.cursorStyle || 'dot';
  document.body.classList.toggle('reduce', level === 'off' || level === 'reduced');
  document.body.classList.toggle('customCursor', settings.customCursor !== false);
  document.body.classList.toggle('highContrast', settings.highContrastText !== false);
  document.body.style.setProperty('--scale', 1);
  document.body.style.zoom = String(settings.dashboardScale || 1);
  document.body.style.setProperty('--glassBlur', `${settings.glassBlur ?? 22}px`);
  document.body.style.setProperty('--radius', `${settings.cornerRadius ?? 20}px`);
  $$('.swatch').forEach(b => {
    const on = b.dataset.theme === (settings.theme || 'graphite');
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
}
function flashSaved() {
  const e = $('#saveState');
  if (!e) return;
  e.textContent = 'Saved';
  e.classList.add('saved');
  clearTimeout(e._t);
  e._t = setTimeout(() => {
    e.textContent = '';
    e.classList.remove('saved');
  }, 1600);
}
async function preset(n) {
  const common = {
    smartFallback: true,
    autoPrimeHistory: true,
    checkpointResume: true,
    incrementalSync: true,
    completionVerification: true,
    verificationPasses: 1,
    organizeByType: true,
    forceProfileSubfolder: true,
    detectAnimatedWebP: true,
    skipDuplicateDownloads: true,
    autoRepairQueue: true,
    rebuildTargetOnStart: true,
    cornerDraggable: true,
    cornerSnap: true,
    showQueueBadge: true,
    fileNaming: 'random',
    randomNameLength: 7,
  };
  const p =
    n === 'safe'
      ? {
          ...common,
          directPageDelay: 1800,
          directPageJitter: 700,
          pageSize: 75,
          scrollDelay: 700,
          scrollIdleRounds: 12,
          maxConcurrentDownloads: 3,
          downloadRetries: 5,
          retryDelay: 1800,
        }
      : n === 'fast'
        ? {
            ...common,
            directPageDelay: 650,
            directPageJitter: 260,
            pageSize: 100,
            scrollDelay: 320,
            scrollIdleRounds: 7,
            maxConcurrentDownloads: 6,
            downloadRetries: 3,
            retryDelay: 1000,
          }
        : {
            ...common,
            directPageDelay: 1100,
            directPageJitter: 450,
            pageSize: 100,
            scrollDelay: 500,
            scrollIdleRounds: 9,
            maxConcurrentDownloads: 4,
            downloadRetries: 4,
            retryDelay: 1500,
          };
  await save(p);
  toast(`${n} preset applied`);
}
async function resetSection(keys) {
  const r = await call({ type: 'RESET_SECTION', keys });
  settings = r.settings;
  apply();
  sync();
  toast('Section reset');
}
const commands = [
  [
    'Archive Bookmarks',
    () => {
      page('archive');
      source = 'bookmarks';
      selectSource();
      start();
    },
  ],
  [
    'Archive Likes',
    () => {
      page('archive');
      source = 'likes';
      selectSource();
      start();
    },
  ],
  [
    'Archive current page',
    () => {
      page('archive');
      source = 'timeline';
      selectSource();
      start();
    },
  ],
  ['Open Library', () => page('library')],
  ['Export current search links', () => window.XVaultOpenLinkExport?.('all')],
  ['Copy current search links', () => window.XVaultOpenLinkExport?.('all', 'copy')],
  ['Open Media', () => page('media')],
  ['Health check', () => page('health')],
  ['Retry failed downloads', () => call({ type: 'RETRY_FAILED' }).then(queueStats)],
  ['Clear library', clearLibrary],
  ['Apply Balanced preset', () => preset('balanced')],
  ['Test crawler', testCrawler],
  ['Test download', testDownload],
];
function openPalette() {
  const invoker = document.activeElement;
  $('#palette').classList.remove('hidden');
  $('#paletteInput').value = '';
  renderPalette();
  window.XVaultOpenFocusScope?.('palette', invoker);
  setTimeout(() => $('#paletteInput').focus({ preventScroll: true }), 20);
}
function closePalette() {
  $('#palette').classList.add('hidden');
  window.XVaultCloseFocusScopes?.(['palette']);
}
function renderPalette() {
  const q = $('#paletteInput').value.toLowerCase(),
    rows = commands.filter(([n]) => n.toLowerCase().includes(q));
  $('#paletteList').innerHTML = rows
    .map(([n], i) => `<button data-i="${commands.indexOf(rows[i])}">${esc(n)}</button>`)
    .join('');
  $$('#paletteList button').forEach(
    b =>
      (b.onclick = () => {
        commands[Number(b.dataset.i)][1]();
        closePalette();
      })
  );
}
function exportSettings() {
  download(
    JSON.stringify({ format: 'xvault-settings-10', settings }, null, 2),
    `xvault-settings-${stamp()}.json`,
    'application/json'
  );
}
async function importSettings(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  try {
    const j = JSON.parse(await f.text()),
      r = await call({ type: 'SET_SETTINGS', settings: j.settings || j });
    settings = r.settings;
    apply();
    sync();
    toast('Settings imported');
  } catch {
    toast('Invalid settings file');
  }
  e.target.value = '';
}
function download(s, n, t) {
  const u = URL.createObjectURL(new Blob([s], { type: t })),
    a = document.createElement('a');
  a.href = u;
  a.download = n;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
}
function toast(s) {
  const t =
    $('#toast') ||
    (() => {
      const x = document.createElement('div');
      x.id = 'toast';
      document.body.append(x);
      return x;
    })();
  t.textContent = s;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2600);
}
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
async function sessions(home = false) {
  const r = await call({ type: 'GET_SESSIONS', limit: home ? 6 : 80 }),
    rows = r?.rows || [],
    target = $(home ? '#homeSessions' : '#sessionList');
  if (!target) return;
  target.innerHTML =
    rows
      .map(x => {
        const pct =
          x.state === 'complete' || x.state === 'verified' ? 100 : Math.min(95, Math.max(6, (x.page || 0) % 100));
        return `<article class="sessionCard"><small>${esc((x.context?.scope || x.source || 'archive').toUpperCase())}${x.context?.profileHandle ? ` · @${esc(x.context.profileHandle)}` : ''}</small><strong>${fmt(x.posts || 0)}</strong><b>${esc(x.phase || x.state || 'unknown')}</b><div class="sessionBar"><i style="width:${pct}%"></i></div><small>${x.page || 0} pages/steps · ${new Date(x.updatedAt || Date.now()).toLocaleString()}</small>${x.error ? `<small style="color:#ff7d88">${esc(x.error)}</small>` : ''}</article>`;
      })
      .join('') || '<div class="empty">No archive sessions yet.</div>';
}
async function toggleFavorite(id) {
  const t = library.find(x => String(x.id) === String(id));
  if (!t) return;
  const val = !t.userMeta?.favorite;
  const r = await call({ type: 'UPDATE_TWEET_META', id, patch: { favorite: val } });
  if (r?.ok) {
    Object.assign(t, r.row);
    renderLib();
    toast(val ? 'Added to XVault favorites' : 'Removed from favorites');
  }
}
async function addTag(id) {
  const t = library.find(x => String(x.id) === String(id));
  if (!t) return;
  const tag = prompt('Tag name');
  if (!tag?.trim()) return;
  const r = await call({ type: 'BULK_UPDATE_TWEET_META', ids: [id], patch: { addTag: tag.trim() } });
  if (r?.ok && r.rows?.[0]) {
    Object.assign(t, r.rows[0]);
    window.XVaultLibraryRecordUpdated?.([id]);
    renderLib();
  } else toast(r?.error || 'Could not add tag');
}
function mediaRowsForPost(t) {
  return libraryDownloads.get(String(t.id)) || [];
}
function mediaRowsForItem(t, m) {
  const downloads = mediaRowsForPost(t),
    urls = [m.url, m.playbackUrl, ...(m.variants || []).map(v => v.url)].filter(Boolean);
  return downloads.filter(
    row =>
      String(row.item?.tweetId || '') === String(t.id) &&
      ((m.id && String(row.item?.mediaId || '') === String(m.id)) ||
        urls.some(u => u === row.item?.url || window.XVaultMediaAsset?.sameAsset(u, row.item?.url)))
  );
}
function mediaDraftKey(postId, key) {
  return `xv-media-draft:${encodeURIComponent(String(postId))}:${encodeURIComponent(String(key))}`;
}
function readMediaDraft(postId, key) {
  try {
    const row = JSON.parse(localStorage.getItem(mediaDraftKey(postId, key)) || 'null');
    return row && typeof row === 'object' && row.values && row.expected ? row : null;
  } catch {
    return null;
  }
}
function persistMediaDraft(postId, key, values, expected) {
  try {
    localStorage.setItem(mediaDraftKey(postId, key), JSON.stringify({ values, expected, at: Date.now() }));
    return true;
  } catch {
    return false;
  }
}
function clearMediaDraft(postId, key) {
  try {
    localStorage.removeItem(mediaDraftKey(postId, key));
  } catch {}
}
function basenameMedia(path) {
  return (
    String(path || '')
      .replace(/\\/g, '/')
      .split('/')
      .pop() || ''
  );
}
function mediaDerivativeInfo(item, row, saved, format, currentGeneration = null) {
  const gif = format === 'gif',
    helper = row?.helper?.[format] || {},
    verification =
      (row?.conversionVerification?.outputs || row?.verification?.outputs || []).find(
        value => value?.label === format
      ) || {};
  const path = helper.path || (gif ? row?.convertedGifPath : row?.convertedWebPPath) || '';
  const file = gif ? row?.convertedGifFileUrl : row?.convertedWebPFileUrl;
  const size = Number(verification.size || helper.size || (gif ? row?.convertedGifSize : row?.convertedWebPSize) || 0);
  const reference = (saved?.derivatives || []).find(
    value => String(value?.format || '').toLowerCase() === format && value?.sourceLocator
  );
  const sourceLocator = row?.item?.url || reference?.sourceLocator || '';
  const sourceGeneration = row?.sourceGeneration || reference?.sourceGeneration || null,
    sourceState =
      currentGeneration && sourceGeneration && currentGeneration !== sourceGeneration
        ? 'retained'
        : window.XVaultMediaMetadata.derivativeSourceState(item, sourceLocator);
  const requestedKey = gif ? 'requestedGif' : 'requestedWebP',
    requested =
      typeof row?.helper?.[requestedKey] === 'boolean'
        ? row.helper[requestedKey]
        : typeof row?.[requestedKey] === 'boolean'
          ? row[requestedKey]
          : null,
    jobState = String(row?.conversionState || '');
  const absentState = ['queued', 'running', 'cancel-requested', 'failed', 'interrupted'].includes(jobState)
    ? jobState
    : requested === true && ['complete', 'completed'].includes(jobState)
      ? 'missing'
      : 'not-created';
  let state = String(
    verification.state || helper.state || (path || file ? 'recorded' : reference ? 'metadata-only' : absentState)
  );
  if (
    sourceState === 'stale' &&
    (path || file || reference) &&
    ![
      'removed',
      'missing',
      'corrupt',
      'mismatch',
      'failed',
      'queued',
      'running',
      'cancel-requested',
      'interrupted',
    ].includes(state)
  )
    state = 'stale';
  if (
    sourceState === 'retained' &&
    (path || file) &&
    !['removed', 'missing', 'corrupt', 'mismatch', 'failed'].includes(state)
  )
    state = 'retained-source';
  return {
    format,
    path,
    file,
    size,
    sourceState,
    state,
    fileName: basenameMedia(path),
    recorded: !!(path || file || reference),
  };
}
function derivativeStateLabel(state) {
  return (
    {
      verified: 'Verified',
      'verified-with-warning': 'Verified · limited evidence',
      ready: 'Available',
      'retained-source': 'From an older retained original',
      recorded: 'Recorded · not checked',
      'metadata-only': 'Portable metadata only',
      stale: 'Stale · source changed',
      missing: 'Missing on disk',
      removed: 'Removed · source preserved',
      corrupt: 'Unreadable output',
      mismatch: 'Format mismatch',
      failed: 'Conversion failed',
      queued: 'Queued',
      running: 'Converting',
      'cancel-requested': 'Stopping',
      interrupted: 'Interrupted · check helper',
      'not-created': 'Not created',
      'verification-unavailable': 'Could not verify',
    }[state] || state.replaceAll('-', ' ')
  );
}
function renderMediaMetadataInspector(t) {
  const metadata = window.XVaultMediaMetadata,
    all = t.media || [],
    shown = all.slice(0, 80);
  if (!shown.length)
    return '<section class="insp-section"><h3>Media archive</h3><p class="insp-none">This post has no captured media.</p></section>';
  const entries = shown
    .map((item, index) => {
      const key = metadata.mediaKey(t.id, item, index),
        saved = metadata.metadataFor(item),
        draft = readMediaDraft(t.id, key),
        values = draft?.values || {
          note: saved.note,
          tags: saved.tags.join(', '),
          source: saved.source,
          sourceUrl: saved.sourceUrl,
        };
      const rows = mediaRowsForItem(t, item),
        original = rows
          .filter(
            row =>
              row.state === 'complete' &&
              (row.target?.filename || row.filename) &&
              !['corrupt', 'mismatch', 'missing'].includes(row.verification?.state || row.verificationState)
          )
          .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0];
      const conversion =
        rows
          .filter(
            row => (row.conversionExpected && row.conversionState) || row.convertedGifPath || row.convertedWebPPath
          )
          .sort(
            (a, b) =>
              (Number(b.conversionUpdatedAt || b.updatedAt || b.createdAt) || 0) -
              (Number(a.conversionUpdatedAt || a.updatedAt || a.createdAt) || 0)
          )[0] || rows[0];
      const derivativeInfos = ['gif', 'webp'].map(format =>
          mediaDerivativeInfo(item, conversion, saved, format, original?.sourceGeneration)
        ),
        derivativeManager =
          ['video', 'animated_gif', 'animated_webp', 'gif'].includes(String(item.type || '')) ||
          derivativeInfos.some(info => info.recorded);
      const derivativeRows = derivativeInfos
        .map(info => {
          const available =
            !!(info.path || info.file) && !['removed', 'missing', 'not-created', 'metadata-only'].includes(info.state);
          const removable = !!(
            conversion?.key &&
            info.path &&
            available &&
            !['queued', 'running', 'cancel-requested'].includes(info.state)
          );
          return `<div class="xv-derivative-row" data-derivative-row="${info.format}" data-state="${esc(info.state)}"><div><b>${info.format.toUpperCase()}</b><span>${info.fileName ? `${esc(info.fileName)}${info.size ? ` · ${bytes(info.size)}` : ''}` : info.recorded ? 'No local file is confirmed' : 'No derivative recorded'}</span><small>${esc(derivativeStateLabel(info.state))}${info.sourceState === 'unknown' && info.recorded ? ' · source version unknown' : ''}</small></div><div><button type="button" data-media-compare="${info.format}" ${available ? '' : 'disabled'}>Compare</button><button type="button" class="quiet" data-media-remove-derivative="${info.format}" aria-label="Remove generated ${info.format.toUpperCase()} only" ${removable ? '' : 'disabled'}>${info.state === 'removed' ? 'Removed' : 'Remove file'}</button></div></div>`;
        })
        .join('');
      const dims = item.width && item.height ? `${item.width} × ${item.height}` : 'Dimensions unavailable';
      const annotationCandidates = Array.isArray(saved.annotations) ? saved.annotations : [],
        annotations = [],
        invalidAnnotations = [];
      for (const candidate of annotationCandidates) {
        try {
          annotations.push(metadata.validateAnnotation(candidate));
        } catch {
          invalidAnnotations.push(candidate);
        }
      }
      const removed = annotations.filter(annotation => annotation.deletedAt),
        activeAnnotations = annotations.filter(annotation => !annotation.deletedAt);
      const capturedProvenance = Array.isArray(item.provenance) ? item.provenance : [],
        recordedProvenance = Array.isArray(saved.provenance) ? saved.provenance : [],
        provenanceRows = [
          ...capturedProvenance.map(value => ({ kind: 'Capture', value })),
          ...recordedProvenance.map(value => ({ kind: 'Recorded', value })),
        ];
      const provenanceView = provenanceRows
        .slice(-20)
        .reverse()
        .map(({ kind: label, value }) => {
          const at = value?.capturedAt || value?.at,
            date = at && Number.isFinite(new Date(at).getTime()) ? new Date(at).toLocaleString() : '';
          return `<li><b>${esc(label)}</b><span>${esc(value?.source || value?.type || value?.origin || 'Observation')}${date ? ` · ${esc(date)}` : ''}</span></li>`;
        })
        .join('');
      const provenanceList = provenanceRows.length
        ? `<details class="xv-media-provenance"><summary>Provenance · ${capturedProvenance.length} captured · ${recordedProvenance.length} recorded</summary><ul>${provenanceView}</ul>${provenanceRows.length > 20 ? `<small>Showing the latest 20 of ${provenanceRows.length} observations.</small>` : ''}</details>`
        : '';
      return `<article class="xv-media-entry" data-media-entry data-media-key="${esc(key)}" data-media-index="${index}" data-derivative-manager="${derivativeManager ? 'true' : 'false'}"><header><div><b>${esc(item.type || 'Media')} · ${esc(dims)}</b><small>${activeAnnotations.length} timestamp notes${removed.length ? ` · ${removed.length} removed` : ''}</small></div><button type="button" data-media-view="${index}" aria-label="Open media ${index + 1} in viewer">View</button></header><div class="xv-media-tech">${item.codec ? `<span>Codec · ${esc(item.codec)}</span>` : ''}${item.container ? `<span>Container · ${esc(item.container)}</span>` : ''}${Number(item.duration) > 0 ? `<span>Duration · ${esc(window.XVaultMediaMetadata.formatTimestamp(Math.round(item.duration * 1000)))}</span>` : ''}<span>Provenance · ${capturedProvenance.length} captured · ${recordedProvenance.length} recorded</span></div>${provenanceList}${invalidAnnotations.length ? `<p class="xv-media-metadata-warning" role="alert">${invalidAnnotations.length} saved timestamp note${invalidAnnotations.length === 1 ? '' : 's'} could not be displayed. Their stored evidence is unchanged.</p>` : ''}<label><span>Private media note</span><textarea data-media-field="note" maxlength="100000" rows="2" placeholder="A note just for this image or video">${esc(values.note || '')}</textarea></label><div class="xv-media-meta-grid"><label><span>Labels · comma separated</span><input data-media-field="tags" maxlength="8192" value="${esc(Array.isArray(values.tags) ? values.tags.join(', ') : values.tags || '')}"></label><label><span>Source / credit</span><input data-media-field="source" maxlength="1000" value="${esc(values.source || '')}"></label></div><label><span>Source link</span><input data-media-field="sourceUrl" type="url" maxlength="2048" value="${esc(values.sourceUrl || '')}"></label><div class="xv-media-save-row"><span data-media-status role="status">${draft ? 'Draft retained locally · Save to compare with the archive' : 'Saved on this device'}</span><button type="button" data-media-save>${draft ? 'Save draft' : 'Save metadata'}</button><button type="button" class="quiet" data-media-reload ${draft ? '' : 'hidden'}>Use saved</button></div><div class="xv-media-conflict" data-media-conflict hidden role="alert"><b>Saved in another window</b><p data-media-conflict-current></p><button type="button" data-media-rebase hidden>Save my draft over the saved version</button></div><div class="xv-media-assets"><strong>${derivativeManager ? 'Original and derivatives' : 'Original file'}</strong><span>${original ? `Original · ${esc(basenameMedia(original.filename || original.target?.filename))} · ${bytes(original.totalBytes)}${original.verification?.state === 'verified' ? ' · verified' : ''}` : 'Original file not saved locally'}</span><div class="xv-derivative-list">${derivativeRows}</div><div class="xv-derivative-actions"><button type="button" data-media-generate="${index}" ${!['video', 'animated_gif', 'animated_webp', 'gif'].includes(String(item.type || '')) ? 'disabled' : ''}>${conversion?.conversionState === 'failed' ? 'Regenerate derivatives' : 'Create GIF and WebP copies'}</button>${original?.downloadId ? `<button type="button" data-media-show="${original.downloadId}">Show original file</button>` : ''}${conversion?.conversionState === 'failed' && conversion.key ? `<button type="button" data-media-retry="${esc(conversion.key)}">Retry conversion</button>` : ''}</div><small>Removing a derivative deletes only that generated file. The captured original and its metadata stay in the archive.</small></div>${
        activeAnnotations.length && metadata.canTimestamp(item)
          ? `<div class="xv-inspector-annotation-list"><b>Video notes</b>${activeAnnotations
              .slice(0, 8)
              .map(
                annotation =>
                  `<button type="button" data-media-open-annotation="${index}" data-annotation-id="${esc(annotation.id)}" aria-label="Open ${metadata.formatTimestamp(annotation.atMs)} · ${esc(annotation.text.slice(0, 100))}"><time>${metadata.formatTimestamp(annotation.atMs)}</time><span>${esc(annotation.text.slice(0, 180))}</span></button>`
              )
              .join(
                ''
              )}${activeAnnotations.length > 8 ? `<small>Showing 8 of ${activeAnnotations.length} notes.</small>` : ''}</div>`
          : ''
      }</article>`;
    })
    .join('');
  return `<section class="insp-section xv-media-inspector"><header><h3>Media metadata</h3><div><button type="button" id="dExportMediaSidecar">Export sidecar</button><button type="button" id="dImportMediaSidecar">Import sidecar</button><input type="file" id="dMediaSidecarFile" accept="application/json,.json" hidden></div></header><p class="xv-media-sidecar-help">Per-file notes, labels, timestamp notes and derivative links travel in a versioned JSON sidecar.</p><div class="xv-media-entries">${entries}</div>${all.length > shown.length ? `<p class="xv-media-limit">Showing metadata for the first 80 of ${all.length} files. All files remain available in the viewer.</p>` : ''}</section>`;
}

function openMediaAt(index, annotationId = '') {
  const post = inspectorRecord || library.find(row => String(row.id) === String($('#detailsDrawer')?.dataset.postId));
  if (!post?.media?.[index]) return;
  openLightbox([post], 0, index);
  if (annotationId)
    setTimeout(
      () =>
        window.XVaultSeekMediaAnnotation?.(
          window.XVaultMediaMetadata.mediaKey(post.id, post.media[index], index),
          annotationId
        ),
      0
    );
}

function openMediaDerivativeCompare(post, media, index, row, format) {
  const path =
    format === 'gif'
      ? row?.convertedGifPath || row?.helper?.gif?.path
      : format === 'webp'
        ? row?.convertedWebPPath || row?.helper?.webp?.path
        : '';
  const file = format === 'gif' ? row?.convertedGifFileUrl : row?.convertedWebPFileUrl;
  if (!path && !file) return toast(`${format.toUpperCase()} derivative is not recorded`);
  let dialog = $('#xvDerivativeCompare');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'xvDerivativeCompare';
    dialog.className = 'xv-derivative-compare';
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      dialog.querySelectorAll('video').forEach(video => {
        video.pause();
        video.removeAttribute('src');
        video.load();
      });
      window.XVaultReleaseHelperMedia?.(dialog);
      dialog.replaceChildren();
    });
  }
  window.XVaultReleaseHelperMedia?.(dialog);
  const originalRows = mediaRowsForItem(post, media),
    original = originalRows.find(item => item.state === 'complete' && !item.conversionExpected),
    originalPath = original?.target?.filename || original?.filename || '';
  const originalUrl =
    originalPath && settings.helperPreferHttpPreview !== false
      ? helperMediaUrl(originalPath)
      : media?.playbackUrl || media?.url || media?.variants?.[0]?.url || '';
  const derivativeUrl =
    settings.helperPreferHttpPreview !== false && path
      ? helperMediaUrl(path)
      : file || (path ? helperMediaUrl(path) : '');
  const type = String(media?.type || '').toLowerCase(),
    videoSource = type === 'video' || Boolean(media?.playbackUrl),
    size =
      format === 'gif'
        ? row?.convertedGifSize || row?.helper?.gif?.size
        : row?.convertedWebPSize || row?.helper?.webp?.size;
  dialog.innerHTML = `<header><div><small>DERIVATIVE REVIEW</small><h2>${format.toUpperCase()} copy · media ${index + 1}</h2></div><button type="button" data-compare-close aria-label="Close comparison">×</button></header><div class="xv-derivative-compare-grid"><figure><figcaption><b>Captured original</b><span>${esc(originalPath ? basenameMedia(originalPath) : 'source stream')}${original?.totalBytes ? ` · ${bytes(original.totalBytes)}` : ''}</span></figcaption><div data-compare-stage="original"></div><small data-compare-status="original" role="status">${originalUrl ? 'Loading original preview…' : 'No original preview source is available.'}</small></figure><figure><figcaption><b>Generated ${format.toUpperCase()}</b><span>${esc(basenameMedia(path || file))}${size ? ` · ${bytes(size)}` : ''} · ${esc(row?.conversionState || row?.verification?.state || 'recorded')}</span></figcaption><div data-compare-stage="derivative"></div><small data-compare-status="derivative" role="status">Loading recorded derivative…</small></figure></div><footer><span>Preview only · the original and derivative files are unchanged.</span><button type="button" data-compare-close>Done</button></footer>`;
  const makePreview = (stageSelector, src, isVideo, alt, statusSelector) => {
    const stage = dialog.querySelector(stageSelector),
      status = dialog.querySelector(statusSelector);
    if (!src) {
      status.textContent = 'Preview unavailable · recorded metadata is still available.';
      return;
    }
    const element = document.createElement(isVideo ? 'video' : 'img');
    if (isVideo) {
      element.controls = true;
      element.preload = 'metadata';
      element.playsInline = true;
    } else {
      element.alt = alt;
      element.loading = 'eager';
      element.decoding = 'async';
    }
    element.src = src;
    stage.append(element);
    stage.setAttribute('aria-busy', 'true');
    const ready = () => {
      stage.removeAttribute('aria-busy');
      status.textContent =
        isVideo && Number.isFinite(element.duration)
          ? `Ready · ${window.XVaultMediaMetadata.formatTimestamp(Math.round(element.duration * 1000))}`
          : 'Preview ready';
    };
    const failed = () => {
      stage.removeAttribute('aria-busy');
      status.textContent = 'Preview unavailable · the saved file record was not changed.';
    };
    element.addEventListener(isVideo ? 'loadedmetadata' : 'load', ready, { once: true });
    element.addEventListener('error', failed, { once: true });
  };
  makePreview(
    '[data-compare-stage="original"]',
    originalUrl,
    videoSource,
    'Captured original',
    '[data-compare-status="original"]'
  );
  makePreview(
    '[data-compare-stage="derivative"]',
    derivativeUrl,
    false,
    `${format.toUpperCase()} derivative`,
    '[data-compare-status="derivative"]'
  );
  dialog.querySelectorAll('[data-compare-close]').forEach(button => (button.onclick = () => dialog.close()));
  if (!dialog.open) dialog.showModal();
  window.XVaultHydrateHelperMedia?.(dialog);
  dialog.querySelector('[data-compare-close]')?.focus();
}

function exportPostMediaSidecar(post) {
  try {
    const sidecar = window.XVaultMediaMetadata.buildMediaSidecar(post, mediaRowsForPost(post));
    download(JSON.stringify(sidecar, null, 2), `xvault-${post.id}-media-sidecar.json`, 'application/json');
    toast(`Media sidecar exported · ${(post.media || []).length} files`);
  } catch (error) {
    toast(`Sidecar export failed: ${error.message}`);
  }
}

function openMediaSidecarPreview(sidecar, plan) {
  let dialog = $('#xvMediaSidecarPreview');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'xvMediaSidecarPreview';
    dialog.className = 'xv-sidecar-preview';
    document.body.append(dialog);
  }
  dialog.innerHTML =
    '<header><small>PORTABLE MEDIA METADATA</small><h2>Review sidecar import</h2></header><p class="xv-sidecar-summary"></p><div class="xv-sidecar-conflicts" role="list"></div><p class="xv-sidecar-detail"></p><footer><button type="button" data-sidecar-cancel>Cancel</button><button type="button" class="primary" data-sidecar-apply>Import safe metadata</button></footer>';
  const summary = dialog.querySelector('.xv-sidecar-summary'),
    detail = dialog.querySelector('.xv-sidecar-detail'),
    conflicts = dialog.querySelector('.xv-sidecar-conflicts');
  if (plan.action === 'reconstruct') {
    summary.textContent = `Post ${plan.postId} is missing. Rebuild its text, source links and per-media metadata from this sidecar; local media files are not included.`;
  } else if (plan.action === 'trashed') {
    summary.textContent = `Post ${plan.postId} is in Trash. Restore or resolve that record before importing metadata.`;
    dialog.querySelector('[data-sidecar-apply]').disabled = true;
  } else if (plan.action === 'already-imported') {
    summary.textContent = 'This exact sidecar was already imported. Nothing will be written.';
    dialog.querySelector('[data-sidecar-apply]').disabled = true;
  } else
    summary.textContent = `${plan.matchedMedia} media file${plan.matchedMedia === 1 ? '' : 's'} matched · ${plan.safeChanges} safe field changes · ${plan.conflicts.length} conflict${plan.conflicts.length === 1 ? '' : 's'} · ${plan.orphans.length} media item${plan.orphans.length === 1 ? '' : 's'} not found in the current record.`;
  for (const conflict of (plan.conflicts || []).slice(0, 20)) {
    const row = document.createElement('div');
    row.setAttribute('role', 'listitem');
    const label = document.createElement('b');
    label.textContent = `${conflict.field} · kept current and imported versions`;
    const values = document.createElement('p');
    values.textContent = `Saved: ${String(conflict.local ?? '').slice(0, 220)} · Sidecar: ${String(conflict.incoming ?? '').slice(0, 220)}`;
    row.append(label, values);
    conflicts.append(row);
  }
  if (plan.conflicts?.length > 20) {
    const more = document.createElement('p');
    more.textContent = `and ${plan.conflicts.length - 20} more preserved conflicts`;
    conflicts.append(more);
  }
  detail.textContent = plan.orphans?.length
    ? `${plan.orphans.length} unmatched media record${plan.orphans.length === 1 ? '' : 's'} will remain attached as import evidence.`
    : 'Conflicting values are kept in the per-media conflict log. They are never silently overwritten.';
  dialog.querySelector('[data-sidecar-cancel]').onclick = () => dialog.close();
  dialog.querySelector('[data-sidecar-apply]').onclick = async () => {
    const button = dialog.querySelector('[data-sidecar-apply]');
    button.disabled = true;
    button.textContent = 'Importing…';
    try {
      const result = await call({
        type: 'IMPORT_MEDIA_SIDECAR',
        sidecar,
        expectedRevision: plan.revision,
        expectedPlanId: plan.planId,
      });
      if (result?.stale) {
        dialog.close();
        const refreshed = await call({ type: 'PREVIEW_MEDIA_SIDECAR', sidecar });
        if (!refreshed?.ok) throw Error(refreshed?.error || 'Updated sidecar preview failed');
        openMediaSidecarPreview(sidecar, refreshed);
        toast('The archive changed · review the refreshed conflict preview');
        return;
      }
      if (!result?.ok) throw Error(result?.error || 'Sidecar import failed');
      dialog.close();
      const visible = library.find(row => String(row.id) === String(result.row.id));
      if (visible) Object.assign(visible, result.row);
      inspectorRecord = result.row;
      window.XVaultLibraryRecordUpdated?.([result.row.id]);
      toast(
        result.action === 'reconstructed'
          ? `Recovered archive metadata for post ${result.row.id}; media files remain on disk`
          : `Imported ${result.safeChanges} safe changes · ${result.conflicts?.length || 0} conflicts retained`
      );
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Retry import';
      toast(`Sidecar import failed: ${error.message}`);
    }
  };
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('[data-sidecar-cancel]').focus();
}

async function importPostMediaSidecar(post, file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    toast('Sidecar exceeds the 25 MB safety limit');
    return;
  }
  try {
    const sidecar = JSON.parse(await file.text()),
      preview = await call({ type: 'PREVIEW_MEDIA_SIDECAR', sidecar });
    if (!preview?.ok) throw Error(preview?.error || 'Sidecar preview failed');
    openMediaSidecarPreview(sidecar, preview);
  } catch (error) {
    toast(`Could not preview sidecar: ${error.message}`);
  }
}

function openDetails(id) {
  const invokingElement = document.activeElement;
  const t =
    library.find(x => String(x.id) === String(id)) ||
    (String(inspectorRecord?.id) === String(id) ? inspectorRecord : null);
  if (!t) return;
  inspectorRecord = t;
  const d = libraryDownloads.get(String(id)) || [],
    box = $('#detailsDrawer'),
    body = $('#drawerBody'),
    um = t.userMeta || {};
  const done = window.XVaultLibraryModel.downloadedMediaCount(t, libraryDownloads),
    total = (t.media || []).length;
  const when = v => (v && Number.isFinite(new Date(v).getTime()) ? new Date(v).toLocaleString() : '—');
  const provenance = t.provenance?.at?.(-1),
    source = provenance?.source || [...(t.sourceFlags || []), ...(t.archiveSources || [])].join(', ') || '—';
  const metrics = [
    ['Likes', t.metrics?.likes],
    ['Reposts', t.metrics?.reposts],
    ['Replies', t.metrics?.replies],
    ['Views', t.metrics?.views],
    ['Bookmarks', t.metrics?.bookmarks],
  ]
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${fmt(v)} ${k.toLowerCase()}`)
    .join(' · ');
  const allMedia = t.media || [],
    media = allMedia
      .slice(0, 6)
      .map((m, index) =>
        m.type === 'video' || m.type === 'animated_gif'
          ? `<video data-media-preview-index="${index}" src="${esc(m.playbackUrl || m.variants?.[0]?.url || m.url || '')}" controls loop preload="metadata"></video>`
          : `<img src="${esc(m.url || '')}" alt="" loading="lazy">`
      )
      .join('');
  body.innerHTML = `<header class="insp-head"><h2>${esc(t.author?.name || t.author?.handle || 'Unknown')}</h2><p>@${esc(t.author?.handle || 'unknown')}</p></header>
<div class="drawerActions"><button id="dFav" aria-pressed="${um.favorite ? 'true' : 'false'}" title="Favorite"><span class="lbl">${um.favorite ? 'Remove favorite' : 'Favorite'}</span></button><button id="dOpen" title="Open on X"><span class="lbl">Open X</span></button><button id="dCopy" title="Copy link"><span class="lbl">Copy link</span></button><button id="dOriginal" title="Open original media"><span class="lbl">Original media</span></button><button id="dCopyImg" title="Copy first image"><span class="lbl">Copy first image</span></button><button id="dRepair" title="Re-resolve expired media"><span class="lbl">Repair media</span></button></div>
${media ? `<div class="drawerMedia">${media}</div>${allMedia.length > 6 ? `<p class="xv-media-limit">Previewing 6 of ${allMedia.length} files. Open any file below for full view.</p>` : ''}` : ''}
<p class="tweetText">${linkifyText(t.text || '')}</p>
<dl class="insp-facts"><dt>Posted</dt><dd>${esc(when(t.createdAt))}</dd><dt>Archived</dt><dd>${esc(when(t.archivedAt))}</dd><dt>Source</dt><dd>${esc(source)}</dd><dt>On disk</dt><dd>${done} of ${total} media</dd><dt>Rating</dt><dd>${t.sensitive ? 'Sensitive' : 'Not marked sensitive'}</dd>${metrics ? `<dt>Engagement</dt><dd>${esc(metrics)}</dd>` : ''}<dt>Review</dt><dd>${um.reviewedAt ? 'Reviewed ' + esc(when(um.reviewedAt)) : window.XVaultLibraryModel?.isInbox?.(t, settings.inboxSince) ? 'In Inbox' : '—'}</dd><dt>Post ID</dt><dd>${esc(t.id)}</dd></dl>
<section class="insp-section"><h3>Tags</h3><div class="insp-taglist" id="dTags">${(um.tags || []).map(tag => `<span class="insp-tag">#${esc(tag)}<button type="button" data-remove-tag="${esc(tag)}" aria-label="Remove tag ${esc(tag)}">×</button></span>`).join('') || '<span class="insp-none">No tags yet</span>'}</div><form id="dTagForm" class="insp-tagform"><input id="dTagInput" maxlength="40" placeholder="Add a tag" aria-label="Add a tag"><button type="submit">Add</button></form></section>
<section class="insp-section"><h3><label for="dNote">Private note</label></h3><textarea id="dNote" rows="5" maxlength="100000" placeholder="Stays on this computer" aria-describedby="dNoteState"></textarea><div class="insp-notefoot"><span id="dNoteState" role="status"></span><button id="dSaveNote" type="button" title="Save note (Ctrl+Enter)">Save note</button></div><div id="dNoteConflict" class="insp-note-conflict" hidden><h4>Saved in another window</h4><p id="dNoteCurrent"></p><div><button id="dNoteUseSaved" type="button">Use saved note</button><button id="dNoteKeepMine" type="button">Save my draft instead</button></div></div></section>
${renderMediaMetadataInspector(t)}`;
  box.dataset.postId = String(t.id);
  box.classList.remove('hidden');
  $('#dOpen').onclick = () => chrome.tabs.create({ url: t.url });
  $('#dCopy').onclick = () => navigator.clipboard.writeText(t.url || '').then(() => toast('Link copied'));
  $('#dOriginal').onclick = () => {
    const u = (t.media || [])[0]?.url;
    if (u) chrome.tabs.create({ url: u });
  };
  $('#dCopyImg').onclick = () => copyImage(t);
  $('#dRepair').onclick = () => repairTweet(t);
  $('#dFav').onclick = () => toggleFavorite(t.id);
  const exportSidecarButton = $('#dExportMediaSidecar'),
    importSidecarButton = $('#dImportMediaSidecar'),
    sidecarFileInput = $('#dMediaSidecarFile');
  if (exportSidecarButton) exportSidecarButton.onclick = () => exportPostMediaSidecar(t);
  if (importSidecarButton && sidecarFileInput) importSidecarButton.onclick = () => sidecarFileInput.click();
  if (sidecarFileInput)
    sidecarFileInput.onchange = event => {
      const file = event.target.files?.[0];
      void importPostMediaSidecar(t, file);
      event.target.value = '';
    };
  body
    .querySelectorAll('[data-media-view]')
    .forEach(button => (button.onclick = () => openMediaAt(Number(button.dataset.mediaView))));
  body
    .querySelectorAll('[data-media-open-annotation]')
    .forEach(
      button =>
        (button.onclick = () => openMediaAt(Number(button.dataset.mediaOpenAnnotation), button.dataset.annotationId))
    );
  body.querySelectorAll('[data-media-open-source]').forEach(
    button =>
      (button.onclick = () => {
        const item = t.media?.[Number(button.dataset.mediaOpenSource)];
        if (item?.url) chrome.tabs.create({ url: item.url });
      })
  );
  body.querySelectorAll('[data-media-entry]').forEach(entry => {
    const key = entry.dataset.mediaKey,
      index = Number(entry.dataset.mediaIndex),
      item = t.media?.[index],
      saved = window.XVaultMediaMetadata.metadataFor(item),
      initialDraft = readMediaDraft(t.id, key),
      mediaRows = mediaRowsForItem(t, item),
      conversion = mediaRows.find(row => row.conversionExpected) || mediaRows[0];
    let expected = initialDraft?.expected || {
        note: saved.note,
        tags: saved.tags,
        source: saved.source,
        sourceUrl: saved.sourceUrl,
      },
      conflictExpected = null;
    const collect = () => ({
      note: entry.querySelector('[data-media-field="note"]').value,
      tags: entry
        .querySelector('[data-media-field="tags"]')
        .value.split(/[,;\n]/)
        .map(value => value.trim().replace(/^#/, ''))
        .filter(Boolean),
      source: entry.querySelector('[data-media-field="source"]').value,
      sourceUrl: entry.querySelector('[data-media-field="sourceUrl"]').value.trim(),
    });
    entry.querySelectorAll('[data-media-field]').forEach(field =>
      field.addEventListener('input', () => {
        const ok = persistMediaDraft(t.id, key, collect(), expected),
          status = entry.querySelector('[data-media-status]');
        status.textContent = ok
          ? 'Draft retained locally · Save to compare with the archive'
          : 'Draft is only in this window · Save it before leaving';
        status.dataset.state = 'draft';
        entry.querySelector('[data-media-save]').textContent = 'Save draft';
        entry.querySelector('[data-media-reload]').hidden = false;
      })
    );
    const saveMediaDraft = async overwrite => {
      const button = entry.querySelector('[data-media-save]'),
        status = entry.querySelector('[data-media-status]'),
        values = collect(),
        baseline = overwrite ? conflictExpected : expected;
      let keepDisabled = false;
      button.disabled = true;
      status.textContent = 'Saving media metadata…';
      try {
        const result = await call({
          type: 'UPDATE_MEDIA_METADATA',
          id: t.id,
          mediaKey: key,
          change: { type: 'fields', values, expected: baseline },
        });
        if (!result?.ok) {
          status.textContent = result?.error || 'Media metadata was not saved';
          status.dataset.state = 'conflict';
          entry.querySelector('[data-media-reload]').hidden = false;
          if (result?.conflict && result.row) {
            Object.assign(t, result.row);
            const latest = window.XVaultMediaMetadata.metadataFor(result.row.media?.[index] || {});
            conflictExpected = {
              note: latest.note,
              tags: latest.tags,
              source: latest.source,
              sourceUrl: latest.sourceUrl,
            };
            persistMediaDraft(t.id, key, values, expected);
            const summary = entry.querySelector('[data-media-conflict-current]');
            summary.textContent = `Saved note: ${latest.note.slice(0, 500) || '—'} · Labels: ${latest.tags.join(', ').slice(0, 300) || '—'} · Credit: ${latest.source || '—'} · Link: ${latest.sourceUrl || '—'}`;
            entry.querySelector('[data-media-conflict]').hidden = false;
            entry.querySelector('[data-media-rebase]').hidden = false;
            button.textContent = 'Draft conflicted';
            keepDisabled = true;
            status.textContent = 'Saved values differ · your draft is retained. Choose an explicit resolution.';
          }
          return;
        }
        clearMediaDraft(t.id, key);
        Object.assign(t, result.row);
        window.XVaultLibraryRecordUpdated?.([t.id]);
        refreshOpenInspectorRecord(result.row);
        toast('Media metadata saved');
      } catch (error) {
        status.textContent = `Save failed · ${error.message}`;
        entry.querySelector('[data-media-reload]').hidden = false;
      } finally {
        if (button.isConnected) button.disabled = keepDisabled;
      }
    };
    entry.querySelector('[data-media-save]').onclick = () => void saveMediaDraft(false);
    entry.querySelector('[data-media-rebase]').onclick = () => void saveMediaDraft(true);
    entry.querySelector('[data-media-reload]').onclick = () => {
      clearMediaDraft(t.id, key);
      window.openDetails(t.id);
    };
    entry
      .querySelectorAll('[data-media-compare]')
      .forEach(
        button =>
          (button.onclick = () => openMediaDerivativeCompare(t, item, index, conversion, button.dataset.mediaCompare))
      );
    entry.querySelectorAll('[data-media-remove-derivative]').forEach(
      button =>
        (button.onclick = async () => {
          if (button.dataset.busy === 'true') return;
          const format = button.dataset.mediaRemoveDerivative;
          if (!conversion?.key) return toast('This derivative has no removable XVault conversion record');
          if (
            !confirm(
              `Remove the generated ${format.toUpperCase()} file from disk? The captured original and all XVault notes will remain untouched.`
            )
          )
            return;
          button.dataset.busy = 'true';
          button.setAttribute('aria-busy', 'true');
          button.textContent = 'Removing…';
          try {
            const result = await call({ type: 'REMOVE_CONVERSION_OUTPUT', key: conversion.key, format });
            if (!result?.ok) throw Error(result?.error || 'The derivative was not removed');
            if (result.conversion)
              Object.assign(conversion, {
                conversionState: result.conversion.state,
                conversionVerification: result.conversion.verification,
                helper: result.conversion.helper,
              });
            button.dataset.busy = 'false';
            button.removeAttribute('aria-busy');
            refreshOpenInspectorRecord(t);
            toast(
              result.state === 'removed'
                ? `${format.toUpperCase()} removed · original preserved`
                : `${format.toUpperCase()} was already missing · original preserved`
            );
          } catch (error) {
            button.dataset.busy = 'false';
            button.removeAttribute('aria-busy');
            button.textContent = 'Remove file';
            toast(error.message || 'The derivative could not be removed');
          }
        })
    );
    entry.querySelector('[data-media-generate]').onclick = async () => {
      const source = downloadItem(t, item, index);
      if (!source) return toast('No source media is available for derivative generation');
      source.conversionGif = true;
      source.conversionWebP = true;
      const result = await call({ type: 'DOWNLOAD_URLS', items: [source] });
      toast(
        result?.added ? `Derivative work queued for media ${index + 1}` : result?.error || 'No conversion was queued'
      );
    };
    entry
      .querySelector('[data-media-show]')
      ?.addEventListener('click', event =>
        call({ type: 'SHOW_DOWNLOAD', downloadId: Number(event.currentTarget.dataset.mediaShow) })
      );
    entry.querySelector('[data-media-retry]')?.addEventListener('click', async event => {
      const result = await call({ type: 'RETRY_CONVERSION', key: event.currentTarget.dataset.mediaRetry });
      toast(result?.ok ? 'Derivative regeneration queued' : result?.error || 'Could not retry conversion');
    });
  });
  wireLibraryVideoState(body);
  const setTags = async (patch, refocus) => {
    const r = await call({ type: 'BULK_UPDATE_TWEET_META', ids: [t.id], patch });
    if (!r?.ok) {
      toast(r?.error || 'Could not update tags');
      return;
    }
    const row = r.rows?.[0];
    if (row) Object.assign(t, row);
    window.XVaultLibraryRecordUpdated?.([t.id]);
    window.openDetails(t.id);
    if (refocus) $('#dTagInput')?.focus();
  };
  $('#dTagForm').onsubmit = e => {
    e.preventDefault();
    const tag = $('#dTagInput').value.trim().replace(/^#/, '');
    if (tag) setTags({ addTag: tag }, true);
  };
  $$('#dTags [data-remove-tag]').forEach(b => (b.onclick = () => setTags({ removeTag: b.dataset.removeTag }, false)));
  window.XVaultNotes.bind(t, body);
  window.XVaultOpenFocusScope?.('detailsDrawer', invokingElement);
}

function refreshOpenInspectorRecord(row) {
  const box = $('#detailsDrawer'),
    id = String(row?.id || '');
  if (!box || box.classList.contains('hidden') || box.dataset.postId !== id) return;
  const body = $('#drawerBody'),
    active = body.contains(document.activeElement) ? document.activeElement : null;
  const focusId = active?.id || '',
    tagValue = focusId === 'dTagInput' ? active.value : null;
  const start = active && 'selectionStart' in active ? active.selectionStart : null,
    end = active && 'selectionEnd' in active ? active.selectionEnd : null,
    scrollTop = body.scrollTop;
  const mediaEntryKey = active?.closest?.('[data-media-entry]')?.dataset.mediaKey || '',
    mediaField = active?.dataset.mediaField || '',
    mediaAction = active?.matches?.('[data-media-save]')
      ? 'save'
      : active?.matches?.('[data-media-reload]')
        ? 'reload'
        : active?.matches?.('[data-media-rebase]')
          ? 'rebase'
          : active?.matches?.('[data-media-remove-derivative]')
            ? 'remove-derivative'
            : '';
  const videos = [...body.querySelectorAll('video[data-media-preview-index]')].map(video => {
    const index = Number(video.dataset.mediaPreviewIndex);
    return {
      index,
      key: window.XVaultMediaMetadata.mediaKey(id, inspectorRecord?.media?.[index], index),
      time: video.currentTime || 0,
      paused: video.paused,
    };
  });
  const visible = library.find(post => String(post.id) === id);
  if (visible) Object.assign(visible, row);
  inspectorRecord = visible || row;
  window.openDetails(id);
  body.scrollTop = scrollTop;
  videos.forEach(state => {
    const video = body.querySelector(`video[data-media-preview-index="${state.index}"]`);
    if (!video || window.XVaultMediaMetadata.mediaKey(id, row.media?.[state.index], state.index) !== state.key) return;
    video.addEventListener(
      'loadedmetadata',
      () => {
        try {
          video.currentTime = state.time;
          if (!state.paused) void video.play().catch(() => {});
        } catch {}
      },
      { once: true }
    );
  });
  let target = focusId ? body.querySelector(`#${CSS.escape(focusId)}`) : null;
  if (mediaEntryKey) {
    const entry = [...body.querySelectorAll('[data-media-entry]')].find(
      item => item.dataset.mediaKey === mediaEntryKey
    );
    target = mediaField
      ? entry?.querySelector(`[data-media-field="${CSS.escape(mediaField)}"]`)
      : mediaAction === 'save'
        ? entry?.querySelector('[data-media-save]')
        : mediaAction === 'reload'
          ? entry?.querySelector('[data-media-reload]')
          : mediaAction === 'rebase'
            ? entry?.querySelector('[data-media-rebase]')
            : mediaAction === 'remove-derivative'
              ? entry?.querySelector('[data-media-view]')
              : target;
  }
  if (target) {
    if (focusId === 'dTagInput') target.value = tagValue ?? '';
    target.focus({ preventScroll: true });
    if (start != null && end != null)
      try {
        target.setSelectionRange(start, end);
      } catch {}
  }
}
function closeStaleInspector(id) {
  const box = $('#detailsDrawer');
  if (!box || box.classList.contains('hidden') || box.dataset.postId !== String(id)) return;
  const hadFocus = box.contains(document.activeElement);
  $('#dNote')?.blur();
  $('#drawerBody')
    ?.querySelectorAll('video')
    .forEach(video => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    });
  box.classList.add('hidden');
  box.dataset.postId = '';
  inspectorRecord = null;
  if (hadFocus) $('#search')?.focus({ preventScroll: true });
  toast('This post moved to Trash in another window. Its saved copy is available in Trash.');
}
window.XVaultRefreshInspectorRecord = refreshOpenInspectorRecord;
window.XVaultCloseStaleInspector = closeStaleInspector;
async function copyImage(t) {
  const m = (t.media || []).find(x => x.type === 'photo');
  if (!m?.url) return toast('No image on this post');
  try {
    const b = await fetch(m.url).then(r => r.blob()),
      png = b.type === 'image/png' ? b : await imageBlobToPng(b);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('Image copied');
  } catch (e) {
    toast('Clipboard image copy was blocked');
  }
}
async function imageBlobToPng(blob) {
  const bm = await createImageBitmap(blob),
    cv = document.createElement('canvas');
  cv.width = bm.width;
  cv.height = bm.height;
  cv.getContext('2d').drawImage(bm, 0, 0);
  return await new Promise(r => cv.toBlob(r, 'image/png'));
}
async function repairTweet(t) {
  const d = libraryDownloads.get(String(t.id)) || [],
    doneRows = d.filter(x => x.state === 'complete'),
    isDone = m =>
      doneRows.some(
        x =>
          (m.id && String(x.item?.mediaId || '') === String(m.id)) ||
          [m.url, m.playbackUrl]
            .filter(Boolean)
            .some(u => u === x.item?.url || window.XVaultMediaAsset?.sameAsset(u, x.item?.url))
      ),
    items = (t.media || [])
      .filter(m => !isDone(m))
      .map((m, i) => ({
        url: mediaSource(m).src,
        previewUrl: m.preview || m.url,
        tweetId: t.id,
        author: t.author?.handle,
        index: i + 1,
        mediaId: m.id,
        mediaType: m.type,
        sourceMediaType: m.type,
        archiveScope: archiveScopeFor(t),
        profileHandle: t.archiveProfile || '',
        profileRelation: t.profileRelation || 'media',
      }))
      .filter(x => x.url);
  const r = await call({ type: 'QUEUE_DOWNLOADS', items, force: true });
  toast(r?.added ? `Queued ${r.added} missing media` : 'Nothing missing / repair unavailable');
}
function openLightbox(rows, ti, mi) {
  const invokingElement = document.activeElement,
    t = rows[ti],
    m = t?.media?.[mi];
  if (!m) return;
  const card = $(`#list .tweet[data-id="${CSS.escape(String(t.id))}"]`);
  lightboxReturnTarget =
    card?.querySelector('[data-record-preview],[data-details],[data-quicklook]') || card || $('#search');
  $('#detailsDrawer')?.classList.add('hidden');
  lightboxItems = [];
  for (const tt of rows) for (const mm of tt.media || []) lightboxItems.push({ t: tt, m: mm });
  lightboxIndex = lightboxItems.findIndex(x => x.t === t && x.m === m);
  lightboxZoom = 100;
  $('#lightbox').classList.remove('hidden');
  renderLightbox();
  window.XVaultOpenFocusScope?.('lightbox', invokingElement);
}
function renderLightbox() {
  const x = lightboxItems[lightboxIndex];
  if (!x) return;
  const { t, m } = x,
    basePick = mediaSource(m),
    kind = mediaLogical(m),
    mode = settings.libraryAnimationMode || 'native',
    localAnim = kind === 'gif' ? localConvertedFor(t, m) : null,
    forceMp4 = kind === 'gif' && mode === 'mp4',
    pick = forceMp4
      ? { src: bestVariant(m) || m.playbackUrl || basePick.src, native: false, kind }
      : localAnim
        ? { src: localAnim, native: true, kind, localConverted: true }
        : basePick,
    u = pick.src,
    isImage = kind === 'image' || (kind === 'gif' && pick.native);
  const box = $('#lbContent');
  box.className = 'lbContent ' + (isImage ? 'imageMode' : 'videoMode');
  box.innerHTML = isImage
    ? `<div class="lbImageCanvas"><img src="${esc(u)}" alt="Media from @${esc(t.author?.handle || 'unknown')}"></div>`
    : `<div class="lbVideoShell"><video src="${esc(u)}" controls autoplay ${kind === 'gif' ? 'loop data-xv-animation="1"' : ''}></video><div class="playerGlow"></div></div>`;
  $('#lbMeta').innerHTML =
    `<small>${lightboxIndex + 1}/${lightboxItems.length}</small><h3>${esc(t.author?.name || '')}</h3><p>@${esc(t.author?.handle || '')}</p><p class="tweetText">${linkifyText(t.text || '')}</p><div class="lbQuickActions"><button id="lbCopyLink">Copy link</button><button id="lbCopyImage" ${isImage ? '' : 'disabled'}>Copy image</button><button id="lbDownload">Download media</button><button id="lbDownloadPost">Download post</button><button id="lbOpenX">Open X</button></div><div class="drawerKv"><b>Type</b><span>${esc(kind === 'gif' ? (pick.native ? 'GIF / Animated WebP' : 'X animation · MP4') : m.type || 'unknown')}</span></div><div class="drawerKv"><b>Dimensions</b><span>${m.width || '?'}×${m.height || '?'}</span></div><div class="drawerKv"><b>Likes</b><span>${fmt(t.metrics?.likes)}</span></div><div class="drawerKv"><b>Views</b><span>${fmt(t.metrics?.views)}</span></div><div class="drawerKv"><b>Bookmarks</b><span>${fmt(t.metrics?.bookmarks)}</span></div><button id="lbDetails">Post details</button>`;
  $('#lbDetails').onclick = () => window.openDetails(t.id);
  $('#lbCopyLink').onclick = async () => {
    await navigator.clipboard.writeText(t.url || '');
    toast('Link copied');
  };
  $('#lbCopyImage').onclick = () => copySpecificImage(t, m, u);
  $('#lbDownload').onclick = () => downloadOne(t, m, (t.media || []).indexOf(m));
  $('#lbDownloadPost').onclick = () => downloadPost(t);
  $('#lbOpenX').onclick = () => chrome.tabs.create({ url: t.url });
  $('#zoomDock').style.display = isImage ? 'flex' : 'none';
  if (isImage) {
    const im = box.querySelector('img');
    const init = () => {
      computeFit(im);
      setLightboxZoom(100, false);
    };
    if (im.complete) init();
    else im.addEventListener('load', init, { once: true });
    im.onclick = () =>
      setLightboxZoom(
        lightboxZoom > 100 ? 100 : Math.min(settings.libraryClickZoom || 200, settings.libraryZoomMax || 1200)
      );
    im.ondblclick = e => {
      e.preventDefault();
      setLightboxActual();
    };
  } else {
    const v = box.querySelector('video');
    applyVideoState(v);
    wireLibraryVideoState(box);
  }
}
window.XVaultLightboxContext = () => {
  const entry = lightboxItems[lightboxIndex];
  if (!entry) return null;
  const index = (entry.t.media || []).indexOf(entry.m);
  return {
    postId: String(entry.t.id),
    post: entry.t,
    media: entry.m,
    index: Math.max(0, index),
    mediaKey: window.XVaultMediaMetadata.mediaKey(entry.t.id, entry.m, Math.max(0, index)),
  };
};
window.XVaultLightboxPostId = () => window.XVaultLightboxContext()?.postId || '';
window.XVaultRefreshLightboxRecord = row => {
  const before = window.XVaultLightboxContext();
  if (!before || String(row?.id) !== before.postId) return false;
  const video = $('#lbContent video'),
    time = video && Number.isFinite(video.currentTime) ? video.currentTime : null,
    focus = document.activeElement?.closest?.('#lbMeta [data-annotation-focus]')?.dataset.annotationFocus || '',
    start = document.activeElement?.selectionStart,
    end = document.activeElement?.selectionEnd;
  const refreshed = [];
  let current = -1;
  for (const entry of lightboxItems) {
    if (String(entry.t.id) !== before.postId) {
      refreshed.push(entry);
      continue;
    }
    const oldIndex = (entry.t.media || []).indexOf(entry.m),
      key = window.XVaultMediaMetadata.mediaKey(entry.t.id, entry.m, Math.max(0, oldIndex)),
      newIndex = (row.media || []).findIndex(
        (item, index) => window.XVaultMediaMetadata.mediaKey(row.id, item, index) === key
      );
    if (newIndex < 0) continue;
    refreshed.push({ t: row, m: row.media[newIndex] });
    if (key === before.mediaKey) current = refreshed.length - 1;
  }
  lightboxItems = refreshed;
  if (current < 0) {
    closeLightbox();
    toast('The open media changed or was removed. Its annotations remain in the archive.');
    return false;
  }
  lightboxIndex = current;
  renderLightbox();
  const nextVideo = $('#lbContent video');
  if (nextVideo && time != null) {
    const restore = () => {
      if (Number.isFinite(nextVideo.duration) && time < nextVideo.duration)
        try {
          nextVideo.currentTime = time;
        } catch {}
    };
    if (nextVideo.readyState >= 1) restore();
    else nextVideo.addEventListener('loadedmetadata', restore, { once: true });
  }
  if (focus) {
    const target = [...($('#lbMeta')?.querySelectorAll('[data-annotation-focus]') || [])].find(
      node => node.dataset.annotationFocus === focus
    );
    target?.focus({ preventScroll: true });
    if (target && Number.isInteger(start) && Number.isInteger(end))
      try {
        target.setSelectionRange(start, end);
      } catch {}
  }
  return true;
};
function computeFit(img) {
  const box = $('#lbContent');
  if (!img || !box) return;
  const nw = img.naturalWidth || 1,
    nh = img.naturalHeight || 1,
    pad = 48,
    aw = Math.max(100, box.clientWidth - pad),
    ah = Math.max(100, box.clientHeight - pad),
    scale = Math.min(1, aw / nw, ah / nh);
  lightboxFit = { w: Math.max(1, nw * scale), h: Math.max(1, nh * scale), naturalW: nw, naturalH: nh, scale };
}
function setLightboxZoom(v, animate = true) {
  const box = $('#lbContent'),
    img = box?.querySelector('img');
  if (!box || !img) return;
  const max = settings.libraryZoomMax || 1200;
  v = Math.max(25, Math.min(max, Number(v) || 100));
  if (!lightboxFit.w) computeFit(img);
  const oldW = img.getBoundingClientRect().width || lightboxFit.w,
    oldH = img.getBoundingClientRect().height || lightboxFit.h,
    oldL = box.scrollLeft,
    oldT = box.scrollTop,
    cx = oldL + box.clientWidth / 2,
    cy = oldT + box.clientHeight / 2,
    rx = oldW ? cx / oldW : 0.5,
    ry = oldH ? cy / oldH : 0.5;
  lightboxZoom = v;
  box.classList.toggle('isZoomed', v > 100);
  const w = lightboxFit.w * (v / 100),
    h = lightboxFit.h * (v / 100);
  img.style.width = `${w}px`;
  img.style.height = `${h}px`;
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  animate =
    animate &&
    !['off', 'reduced'].includes(document.body.dataset.motion) &&
    !matchMedia('(prefers-reduced-motion: reduce)').matches;
  img.style.transition = animate
    ? 'width .26s cubic-bezier(.2,.85,.2,1),height .26s cubic-bezier(.2,.85,.2,1)'
    : 'none';
  $('#lbZoomLabel').textContent = `${Math.round(v)}%`;
  $('#lbZoom').value = String(Math.round(v));
  requestAnimationFrame(() => {
    const nl = Math.max(0, rx * w - box.clientWidth / 2),
      nt = Math.max(0, ry * h - box.clientHeight / 2);
    box.scrollTo({ left: nl, top: nt, behavior: animate ? 'smooth' : 'auto' });
  });
}
function setLightboxActual() {
  const img = $('#lbContent img');
  if (!img) return;
  if (!lightboxFit.w) computeFit(img);
  const actual = Math.min(settings.libraryZoomMax || 1200, Math.max(25, 100 / (lightboxFit.scale || 1)));
  setLightboxZoom(actual);
}
function stepLightbox(d) {
  if (!lightboxItems.length) return;
  lightboxIndex = (lightboxIndex + d + lightboxItems.length) % lightboxItems.length;
  lightboxZoom = 100;
  lightboxFit = { w: 0, h: 0 };
  renderLightbox();
}
function libraryKeys(e) {
  if (e.defaultPrevented || e.target.closest('input,textarea,select,[contenteditable]')) return;
  if ($('#lightbox')?.classList.contains('hidden')) return;
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    stepLightbox(1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    stepLightbox(-1);
  } else if (e.key === 'Escape') {
    closeLightbox();
  } else if (e.key === '+' || e.key === '=') {
    setLightboxZoom(
      Math.min(settings.libraryZoomMax || 1200, (lightboxZoom || 100) + (settings.libraryZoomStep || 20))
    );
  } else if (e.key === '-') {
    setLightboxZoom(Math.max(25, (lightboxZoom || 100) - (settings.libraryZoomStep || 20)));
  } else if (e.key === '0') {
    setLightboxZoom(100);
  } else if (e.key === '1') {
    setLightboxActual();
  }
}
async function copySpecificImage(t, m, url) {
  if (mediaLogical(m) !== 'image' && !(mediaLogical(m) === 'gif' && /\.(gif|webp)(?:\?|$)/i.test(url || '')))
    return toast('This media is not an image');
  try {
    const b = await fetch(url).then(r => r.blob()),
      png = b.type === 'image/png' ? b : await imageBlobToPng(b);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    toast('Image copied');
  } catch {
    toast('Clipboard image copy was blocked');
  }
}
function surpriseMe() {
  if (!library.length) return toast('Load the Library first');
  const t = library[Math.floor(Math.random() * library.length)];
  if (t?.media?.length) {
    openLightbox([t], 0, Math.floor(Math.random() * t.media.length));
  } else window.openDetails(t.id);
}
async function runIntegrity(showToast = true) {
  const r = await call({ type: 'INTEGRITY_SCAN' }),
    x = r?.report;
  if (!x) return;
  const vals = [x.summary.missing, x.summary.zeroByte, x.summary.wrongFormat, x.summary.orphaned, x.summary.duplicates];
  $$('#integrityStats strong').forEach((e, i) => (e.textContent = fmt(vals[i] || 0)));
  const rows = [
    ...x.missing.slice(0, 30).map(z => `${z.confidence || 'DETECTED'} · Missing · ${z.tweetId} · ${z.type}`),
    ...x.zeroByte.slice(0, 10).map(z => `${z.confidence || 'DETECTED'} · Zero-byte · ${z.file || z.key}`),
    ...x.orphaned.slice(0, 10).map(z => `${z.confidence || 'DETECTED'} · Orphan · ${z.file || z.key}`),
    ...(x.derivativeIssues || []).slice(0, 10).map(z => `${z.confidence || 'DETECTED'} · Derivative · ${z.reason}`),
    ...(x.missingSidecars || []).slice(0, 10).map(z => `${z.confidence || 'UNKNOWN'} · Sidecar · ${z.file || z.key}`),
  ];
  if ($('#integrityList'))
    $('#integrityList').innerHTML =
      rows.map(x => `<div>${esc(x)}</div>`).join('') ||
      '<div class="diag ok">No integrity problems detected from XVault metadata.</div>';
  if (showToast)
    toast(
      `Integrity: ${x.summary.missing} missing · ${x.summary.zeroByte} zero-byte · ${x.summary.derivativeIssues || 0} derivative issues`
    );
}
async function createSnapshotUi() {
  const r = await call({ type: 'CREATE_SNAPSHOT', source: 'all' });
  toast(r?.snapshot ? `Snapshot saved · ${r.snapshot.count} posts` : 'Snapshot failed');
  loadSnapshots();
}
async function loadSnapshots() {
  const r = await call({ type: 'GET_SNAPSHOTS', limit: 12 });
  if ($('#snapshotList'))
    $('#snapshotList').innerHTML =
      (r?.rows || [])
        .map(x => `<div>${new Date(x.createdAt).toLocaleString()} · ${fmt(x.count)} posts · ${esc(x.source)}</div>`)
        .join('') || '<div>No snapshots yet.</div>';
}
async function generateManifest() {
  const r = await call({ type: 'GENERATE_MANIFEST', scope: 'all' });
  if (!r?.manifest) return toast('Manifest failed');
  download(JSON.stringify(r.manifest, null, 2), `xvault-manifest-${stamp()}.json`, 'application/json');
  toast(`Manifest created · ${r.manifest.rows.length} posts`);
}

function normalizeToolUrl(provider = 'x') {
  const raw = $('#toolPostUrl').value.trim();
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const m = u.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
  if (!m) return null;
  const host =
    provider === 'fixvx'
      ? 'fixvx.com'
      : provider === 'fixupx'
        ? 'fixupx.com'
        : provider === 'fxtwitter'
          ? 'fxtwitter.com'
          : provider === 'vxtwitter'
            ? 'vxtwitter.com'
            : 'x.com';
  return `https://${host}/${m[1]}/status/${m[2]}`;
}
function openToolLink(p) {
  const u = normalizeToolUrl(p);
  if (!u) return toast('Enter a valid X post URL');
  chrome.tabs.create({ url: u });
}
function toolQr() {
  const u = normalizeToolUrl('x');
  if (!u) return toast('Enter a valid X post URL');
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=440x440&data=${encodeURIComponent(u)}`;
  $('#qrBox').innerHTML = `<img src="${src}" alt="QR code"><small>QR for ${esc(u)}</small>`;
}
async function toolArchivePost() {
  const u = normalizeToolUrl('x');
  if (!u) return toast('Enter a valid X post URL');
  const r = await call({ type: 'ACTIVE_X_TAB' });
  if (!r?.tab) return toast('Open X first');
  await chrome.tabs.update(r.tab.id, { url: u, active: true });
  toast('Opened post. XVault passive capture will archive it as X loads it.');
}
async function toolArchiveThread() {
  const u = normalizeToolUrl('x');
  if (!u) return toast('Enter a valid X post URL');
  const r = await call({ type: 'ACTIVE_X_TAB' });
  if (!r?.tab) return toast('Open X first');
  await chrome.tabs.update(r.tab.id, { url: u, active: true });
  setTimeout(() => tab({ type: 'XV_SCROLL_START', context: { scope: 'thread' } }), 1800);
  toast('Thread capture armed; X will open the post and XVault will capture visible conversation context.');
}
async function sampleGraphs() {
  if (document.hidden || !$('#page-home')?.classList.contains('show')) return;
  const q = queueSnapshot,
    s = statsSnapshot;
  if (q?.ok) {
    graphSamples.push(q.speedBps || 0);
    if (graphSamples.length > 60) graphSamples.shift();
  }
  if (s?.ok) {
    activitySamples.push({
      posts: s.tweets || 0,
      queue: (q?.queued || 0) + (q?.downloading || 0),
      failed: q?.failed || 0,
    });
    if (activitySamples.length > 60) activitySamples.shift();
  }
  drawGraph($('#bandwidthGraph'), graphSamples, 'speed');
  drawActivity($('#activityGraph'), activitySamples);
  updatePipeline(q);
}
function drawGraph(cv, arr) {
  if (!cv || !arr.length) return;
  const ctx = cv.getContext('2d'),
    w = cv.width,
    h = cv.height,
    max = Math.max(1, ...arr);
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  arr.forEach((v, i) => {
    const x = (i / Math.max(1, arr.length - 1)) * w,
      y = h - 10 - (v / max) * (h - 24);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.strokeStyle = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#fff';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.globalAlpha = 0.1;
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fill();
  ctx.globalAlpha = 1;
}
function drawActivity(cv, arr) {
  if (!cv || arr.length < 2) return;
  const deltas = arr.map((x, i) => (i ? Math.max(0, x.posts - arr[i - 1].posts) : 0));
  drawGraph(cv, deltas);
}
function updatePipeline(q) {
  const state = activeRun ? 'graphql' : q?.downloading ? 'media' : 'x',
    nodes = ['x', 'graphql', 'normalize', 'library', 'media', 'disk'];
  nodes.forEach((n, i) => {
    const el = $(`#archiveMap [data-node="${n}"]`);
    if (!el) return;
    const ix = nodes.indexOf(state);
    el.classList.toggle('active', n === state);
    el.classList.toggle('done', i < ix);
  });
  if ($('#pipelineState'))
    $('#pipelineState').textContent = activeRun ? 'ARCHIVING' : q?.downloading ? 'DOWNLOADING' : 'IDLE';
}
// Keep the drawer close affordance safe when a shared handler routes to the lightbox.
function closeLightbox() {
  $('#lightbox').classList.add('hidden');
  $('#lbContent').replaceChildren();
  $('#lbMeta').replaceChildren();
  $('#detailsDrawer').classList.add('hidden');
  lightboxItems = [];
  lightboxIndex = 0;
  lightboxZoom = 100;
  lightboxFit = { w: 0, h: 0 };
  const target = lightboxReturnTarget;
  lightboxReturnTarget = null;
  const restored = window.XVaultCloseFocusScopes?.(['detailsDrawer', 'lightbox']);
  requestAnimationFrame(() => {
    if (target?.isConnected && target.getClientRects().length) target.focus({ preventScroll: true });
    else if (!restored) $('#search')?.focus({ preventScroll: true });
  });
}
window.XVaultCloseLightbox = closeLightbox;
setTimeout(() => {
  const b = $('#toolOpenFixup');
  if (b) b.textContent = 'Open FixVX';
}, 250);
document.addEventListener(
  'DOMContentLoaded',
  () =>
    setTimeout(() => {
      const panel = $('#integrityRun');
      if (!panel || $('#integrityRepair')) return;
      const b = document.createElement('button');
      b.id = 'integrityRepair';
      b.textContent = 'Repair preview';
      panel.parentElement?.append(b);
      b.onclick = async () => {
        const r = await call({ type: 'INTEGRITY_REPAIR_PREVIEW' });
        const list = (r.suggestions || []).slice(0, 20);
        if (!list.length) return toast('No repairable integrity findings.');
        const text = list.map((x, i) => `${i + 1}. ${x.problem} → ${x.action}`).join('\n');
        if (!confirm(`Review safe repair proposals:\n\n${text}\n\nApply only safe re-download repairs?`)) return;
        const ids = list.filter(x => !x.destructive && x.action === 're-download').map(x => x.id);
        const out = await call({ type: 'INTEGRITY_REPAIR_APPLY', ids, confirm: true });
        toast(`Integrity repair queued ${out?.repaired || 0}`);
        runIntegrity();
      };
    }, 120),
  { once: true }
);

matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => apply());
