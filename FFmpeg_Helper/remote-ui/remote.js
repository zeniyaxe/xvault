(() => {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const PAIR_KEY = 'xvault.remote.device.v1';
  const SAVER_KEY = 'xvault.remote.data-saver.v1';
  const CLIENT_SESSION = crypto.randomUUID();
  const PAGE_SIZE = 40;
  const CACHE_PAGES = 3;
  let editorId = crypto.randomUUID();
  try {
    editorId = sessionStorage.getItem('xvault.remote.note-editor') || editorId;
    sessionStorage.setItem('xvault.remote.note-editor', editorId);
  } catch {}
  const tabEditorId = crypto.randomUUID();
  const animations = new Map();
  const calm = () =>
    ['off', 'reduced'].includes(document.documentElement.dataset.motion) ||
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  function move(element, frames, duration = 180) {
    if (!element) return;
    animations.get(element)?.cancel();
    animations.delete(element);
    if (calm() || !element.animate) return;
    const animation = element.animate(frames, { duration, easing: 'cubic-bezier(.18,.8,.2,1)' });
    animations.set(element, animation);
    animation.finished
      .catch(() => {})
      .finally(() => {
        if (animations.get(element) === animation) animations.delete(element);
      });
  }
  const state = {
    device: null,
    permissions: new Set(),
    rows: new Map(),
    pageStarts: [null],
    firstPage: 0,
    lastPage: -1,
    beforeCount: 0,
    afterCount: 0,
    hasMore: false,
    matched: 0,
    matchedExact: true,
    truncated: false,
    query: '',
    sort: 'new',
    selectedFilter: '',
    monthQuery: '',
    savedViewName: '',
    remoteViews: [],
    libraryRevision: null,
    observedRevision: null,
    loadingNext: false,
    loadingPrevious: false,
    queryVersion: 0,
    controller: null,
    currentPost: null,
    sheetPost: null,
    currentMediaIndex: 0,
    viewerPageOffset: 0,
    viewerPage: null,
    viewerVersion: '',
    viewerController: null,
    viewerSequence: 0,
    viewerReturn: null,
    captionExpanded: false,
    toastTimer: 0,
    dataSaver: false,
    lastScrollTop: 0,
    scrollScheduled: false,
    pressTimer: 0,
    longPressed: false,
  };

  let browseController = null,
    browseSequence = 0,
    installPrompt = null,
    installBusy = false,
    privacyReturn = null;
  const pcRequests = new Map(),
    pcReceipts = new Map();
  const viewScrollPositions = new Map();
  const receiptKey = (id, index) => `${id}:${index == null ? 'all' : index}`;
  function cancelPCRequests(id = null) {
    for (const [postId, job] of pcRequests)
      if (id == null || String(id) === postId) {
        job.cancelled = true;
        job.controller.abort();
      }
  }
  function rememberPCReceipt(key, value) {
    pcReceipts.delete(key);
    pcReceipts.set(key, {
      added: value.added,
      skipped: value.skipped,
      filtered: value.filtered,
      unavailable: value.unavailable,
      error: value.error,
      message: value.cancelled ? value.message : '',
    });
    while (pcReceipts.size > 128) pcReceipts.delete(pcReceipts.keys().next().value);
  }
  function downloadMessage(job) {
    if (job.error || job.message) return job.error || job.message;
    const parts = [];
    if (job.added) parts.push(`${job.added} queued on PC`);
    if (job.skipped) parts.push(`${job.skipped} already saved or queued`);
    if (job.filtered) parts.push(`${job.filtered} filtered by desktop rules`);
    if (job.unavailable) parts.push(`${job.unavailable} without a downloadable captured source`);
    return parts.join(' · ') || 'No files queued; check the captured media and desktop download rules.';
  }
  function updateDownloadControls() {
    const allowed = state.permissions.has('downloads.manage') && state.permissions.has('library.read');
    for (const button of document.querySelectorAll('[data-pc-post]')) {
      const job = pcRequests.get(button.dataset.pcPost),
        receipt = pcReceipts.get(receiptKey(button.dataset.pcPost, null));
      button.disabled = !allowed || !!job;
      button.setAttribute('aria-busy', String(!!job));
      button.dataset.downloadState = job ? 'pending' : receipt?.error ? 'error' : receipt ? 'accepted' : '';
      button.title = job
        ? 'Queuing captured media on your PC'
        : receipt
          ? downloadMessage(receipt)
          : 'Save all media to PC';
      button.setAttribute('aria-label', button.title);
      button.replaceChildren(makeIcon(receipt && !receipt.error && !job ? 'check' : 'pc-save'));
    }
    const sheet = state.sheetPost,
      job = sheet ? pcRequests.get(String(sheet.id)) : null,
      receipt = sheet ? pcReceipts.get(receiptKey(sheet.id, null)) : null;
    $('#sheetDownloadPC').hidden = !sheet || !Number(sheet.mediaCount || sheet.media?.length);
    $('#sheetDownloadPC').disabled = !allowed || !!job;
    $('#sheetDownloadPC').setAttribute('aria-busy', String(!!job));
    $('#sheetDownloadPC span').textContent = job ? 'Queuing on PC…' : 'Save all media to PC';
    $('#sheetDownloadStatus').textContent = !sheet
      ? ''
      : !allowed
        ? 'Enable “Save archived media to PC” in desktop Remote permissions.'
        : job
          ? job.message
          : receipt
            ? downloadMessage(receipt)
            : 'Captured media saves to the computer’s XVault folder.';
    $('#sheetDownloadStop').hidden = !job || job.single;
    const post = state.currentPost,
      viewerJob = post ? pcRequests.get(String(post.id)) : null,
      viewerReceipt = post ? pcReceipts.get(receiptKey(post.id, state.currentMediaIndex)) : null,
      media = currentViewerMedia();
    $('#viewerSavePC').disabled = !allowed || !!viewerJob || !post;
    $('#viewerSavePC').setAttribute('aria-busy', String(!!viewerJob));
    $('#viewerSavePC span').textContent = viewerJob ? 'Queuing…' : 'Save to PC';
    $('#viewerSavePC').title = allowed
      ? 'Queue this captured media on your computer'
      : 'Enable PC downloads in desktop Remote permissions';
    const phone = $('#viewerSavePhone'),
      path = state.permissions.has('media.read') ? mediaPath(media, 'original') : null;
    phone.setAttribute('aria-disabled', String(!path));
    if (path) {
      const url = new URL(path, location.origin);
      url.searchParams.set('download', '1');
      phone.href = `${url.pathname}${url.search}`;
      phone.download = '';
      phone.title = 'Download the local file through your browser';
    } else {
      phone.removeAttribute('href');
      phone.title = 'Save the file on the computer first, then reopen the viewer';
    }
    $('#viewerDownloadStatus').textContent = viewerJob
      ? viewerJob.message
      : viewerReceipt
        ? downloadMessage(viewerReceipt)
        : path
          ? 'Save to phone uses the local file. Save to PC uses captured source media.'
          : 'The local file is unavailable; Save to PC can queue its captured source.';
  }
  async function saveToPC(post, index = null) {
    if (!post || !state.permissions.has('downloads.manage') || !state.permissions.has('library.read'))
      return toast('Enable PC downloads in desktop Remote permissions');
    const id = String(post.id),
      owner = state.device?.deviceId;
    if (pcRequests.has(id)) return;
    if (pcRequests.size >= 4) return toast('Wait for a current download request to finish');
    const job = {
      owner,
      controller: new AbortController(),
      single: index != null,
      cancelled: false,
      added: 0,
      skipped: 0,
      filtered: 0,
      unavailable: 0,
      message: 'Queuing captured media on PC…',
    };
    pcRequests.set(id, job);
    updateDownloadControls();
    let offset = index ?? 0,
      version = index != null ? state.viewerVersion : '',
      uncertain = false;
    try {
      for (let page = 0; page < 313; page++) {
        if (job.cancelled || owner !== state.device?.deviceId || !state.permissions.has('downloads.manage')) break;
        uncertain = true;
        const result = await request(
          '/api/download',
          { id, offset, limit: job.single ? 1 : 32, mediaVersion: version },
          { signal: job.controller.signal }
        );
        uncertain = false;
        if (owner !== state.device?.deviceId) return;
        for (const key of ['added', 'skipped', 'filtered', 'unavailable'])
          job[key] += Math.max(0, Number(result[key]) || 0);
        version = result.mediaVersion || version;
        if (result.blocked) {
          job.error = `${job.added ? `${job.added} queued; ` : ''}XVault held an uncertain request. Check Downloads on your computer.`;
          break;
        }
        const next = result.nextOffset;
        if (job.single || next == null) break;
        if (!Number.isInteger(next) || next <= offset || next > 10000)
          throw Error('The media range changed unexpectedly');
        offset = next;
        job.message = `${job.added} queued · preparing media ${offset + 1}–${Math.min(offset + 32, Number(result.mediaCount) || offset + 32)}`;
        updateDownloadControls();
      }
      job.message = '';
      if (job.cancelled)
        job.message = `Stopped remaining requests · ${job.added} confirmed queued on PC. A request already sent may still finish.`;
    } catch (error) {
      if (owner !== state.device?.deviceId) return;
      const unknown = uncertain && ![400, 401, 403, 404, 409, 422].includes(error.status);
      job.error =
        error.name === 'AbortError'
          ? `Stopped remaining requests · ${job.added} confirmed queued. Already-sent work may finish.`
          : `${job.added ? `${job.added} confirmed queued; ` : ''}${unknown ? 'request outcome may be unknown. Check PC Downloads before retrying. ' : ''}${error.message}`;
    } finally {
      if (pcRequests.get(id) === job) pcRequests.delete(id);
      if (
        owner === state.device?.deviceId &&
        state.permissions.has('library.read') &&
        state.permissions.has('downloads.manage')
      ) {
        rememberPCReceipt(receiptKey(id, index), job);
        updateDownloadControls();
        toast(downloadMessage(job));
        if (!job.error)
          for (const button of document.querySelectorAll(`[data-pc-post="${id}"]`))
            move(button.querySelector('svg'), [{ transform: 'scale(.88)' }, { transform: 'none' }], 140);
      }
    }
  }
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let installed = standalone();
  const localChoice = (key, fallback = '') => {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  };
  const saveChoice = (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      toast('This phone could not remember that preference');
    }
  };
  function updateInstallUI() {
    const ready = installed || standalone();
    $('#installBanner').hidden = ready || $('#app').hidden || localChoice('xvault.remote.install-dismissed') === '1';
    $('#installBannerAction').textContent = installPrompt ? 'Install' : 'How to install';
    $('#installDeviceHint').textContent = ready
      ? 'Already running as an installed app'
      : 'Open XVault as a standalone companion';
    $('#installApp').disabled = ready;
    $('#installConfirm').hidden = !installPrompt || ready;
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    installPrompt = event;
    updateInstallUI();
  });
  window.addEventListener('appinstalled', () => {
    installed = true;
    installPrompt = null;
    updateInstallUI();
    $('#installStatus').textContent = 'XVault installed.';
  });
  function showInstall() {
    const ios =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    $('#installInstructions').textContent = installPrompt
      ? 'Install XVault to open your Library in its own app window.'
      : ios
        ? 'Open your browser’s Share menu, choose Add to Home Screen, then confirm Add. If the option is missing, open this page in Safari.'
        : 'Open your browser’s menu and look for Install app or Add to Home screen. If the option is unavailable, first trust the computer’s certificate and use a browser that supports web-app installation.';
    $('#installStatus').textContent = '';
    updateInstallUI();
    if (!$('#installSheet').open) {
      $('#installSheet').showModal();
      move($('#installSheet'), [{ transform: 'translateY(24px)' }, { transform: 'none' }], 200);
    }
  }
  async function installApp() {
    if (!installPrompt || installBusy) return;
    const prompt = installPrompt;
    installPrompt = null;
    installBusy = true;
    $('#installConfirm').disabled = true;
    updateInstallUI();
    try {
      const result = await prompt.prompt();
      const choice = result || (await prompt.userChoice);
      $('#installStatus').textContent =
        choice?.outcome === 'accepted'
          ? 'Installation requested. Your browser will finish adding XVault.'
          : 'Installation dismissed. You can use the browser menu later.';
    } catch {
      $('#installStatus').textContent =
        'The browser could not open its installer. Use its Install app or Add to Home screen menu.';
    } finally {
      installBusy = false;
      $('#installConfirm').disabled = false;
      updateInstallUI();
    }
  }
  function coverArchive() {
    if (!state.privacyEnabled || installBusy || $('#app').hidden || $('#privacyCover').open) return;
    if (noteBinding && $('#noteInput').value !== noteBinding.base) retainNote(noteBinding);
    document.querySelectorAll('video').forEach(video => video.pause());
    privacyReturn = document.activeElement;
    $('#privacyCover').showModal();
  }
  async function revealArchive() {
    await refreshSession();
    if ($('#privacyCover').open) $('#privacyCover').close();
    const target = privacyReturn;
    privacyReturn = null;
    requestAnimationFrame(() => {
      if (target?.isConnected && !$('#app').hidden) target.focus({ preventScroll: true });
    });
  }
  function renderSavedViews() {
    const query = $('#viewsSearch').value.trim().toLowerCase(),
      fragment = document.createDocumentFragment();
    for (const view of state.remoteViews.filter(view => `${view.name} ${view.query}`.toLowerCase().includes(query))) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'saved-view';
      const name = document.createElement('b'),
        detail = document.createElement('small');
      name.textContent = view.name;
      detail.textContent = view.query || 'All archived posts';
      button.append(name, detail);
      button.onclick = () => {
        if ([view.query, state.monthQuery].filter(Boolean).join(' ').length > 1000) {
          $('#viewsStatus').textContent = 'This saved view and month exceed the search limit. Choose All dates first.';
          return;
        }
        clearTimeout($('#searchInput')._timer);
        state.selectedFilter = '';
        state.savedViewName = view.name;
        $('#searchInput').value = view.query;
        $('#clearQuery').hidden = !view.query;
        $('#sortSelect').value = view.sort;
        document
          .querySelectorAll('.filter')
          .forEach(item => item.classList.toggle('active', item.dataset.query === ''));
        $('#browseSheet').close();
        void search(true);
      };
      fragment.append(button);
    }
    $('#savedViewList').replaceChildren(fragment);
    if (!$('#savedViewList').childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'privacy-note';
      empty.textContent = state.remoteViews.length
        ? 'No saved views match.'
        : 'Save a search on the desktop to use it here.';
      $('#savedViewList').append(empty);
    }
  }
  async function loadSavedViews() {
    browseController?.abort();
    browseController = new AbortController();
    const sequence = ++browseSequence,
      owner = state.device?.deviceId;
    $('#viewsStatus').textContent = 'Reading desktop saved views…';
    $('#viewsRefresh').disabled = true;
    try {
      const result = await request('/api/views', undefined, { signal: browseController.signal });
      if (sequence !== browseSequence || owner !== state.device?.deviceId || !state.permissions.has('library.read'))
        return;
      state.remoteViews = (Array.isArray(result.rows) ? result.rows : [])
        .slice(0, 100)
        .filter(row => row && typeof row.query === 'string' && row.query.length <= 1000)
        .map(row => ({
          id: String(row.id || '').slice(0, 128),
          name: String(row.name || 'Saved view').slice(0, 120),
          query: row.query,
          sort: [...$('#sortSelect').options].some(option => option.value === row.sort) ? row.sort : 'new',
        }));
      renderSavedViews();
      $('#viewsStatus').textContent = `${state.remoteViews.length} saved views from your computer`;
    } catch (error) {
      if (sequence === browseSequence && error.name !== 'AbortError')
        $('#viewsStatus').textContent = `Could not read saved views. ${error.message}`;
    } finally {
      if (sequence === browseSequence) $('#viewsRefresh').disabled = false;
    }
  }
  function openBrowse() {
    if (!state.permissions.has('library.read')) return toast('Library access is disabled for this phone');
    $('#browseSheet').showModal();
    move($('#browseSheet'), [{ transform: 'translateY(24px)' }, { transform: 'none' }], 200);
    void loadSavedViews();
  }
  function shiftMonth(direction) {
    const input = $('#browseMonth'),
      match = /^(\d{4})-(\d{2})$/.exec(input.value || new Date().toISOString().slice(0, 7));
    if (!match) return;
    const index = Number(match[1]) * 12 + Number(match[2]) - 1 + direction,
      year = Math.floor(index / 12),
      month = (index % 12) + 1;
    if (year < 1 || year > 9998) return;
    input.value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
  }
  function applyMonth(clear = false) {
    const match = /^(\d{4})-(\d{2})$/.exec($('#browseMonth').value);
    let query = '';
    if (!clear) {
      if (!match || Number(match[1]) < 1 || Number(match[1]) > 9998 || Number(match[2]) < 1 || Number(match[2]) > 12) {
        $('#monthStatus').textContent = 'Choose a valid month first.';
        return;
      }
      const year = Number(match[1]),
        month = Number(match[2]),
        prefix = $('#monthBasis').value === 'archived' ? 'archived-' : '';
      query = `${prefix}after:${match[1]}-${match[2]}-01 ${prefix}before:${String(month === 12 ? year + 1 : year).padStart(4, '0')}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`;
    }
    if ([state.selectedFilter, $('#searchInput').value.trim(), query].filter(Boolean).join(' ').length > 1000) {
      $('#monthStatus').textContent = 'Shorten the search before adding a month.';
      return;
    }
    clearTimeout($('#searchInput')._timer);
    state.monthQuery = query;
    $('#monthStatus').textContent = '';
    if (clear) $('#browseMonth').value = '';
    $('#browseSheet').close();
    void search(true);
  }

  function setPairMessage(message, error = false, retry = false) {
    $('#pairScreen').hidden = false;
    $('#app').hidden = true;
    $('#pairApprovalCode').hidden = true;
    $('#pairCode').textContent = '';
    $('#pairStatus').textContent = message;
    $('#pairStatus').classList.toggle('error', error);
    $('#pairRetry').hidden = !retry;
    $('#installBanner').hidden = true;
  }

  function showPairCode(value) {
    const code = String(value || '')
      .replace(/\D/g, '')
      .slice(0, 6);
    const valid = /^\d{6}$/.test(code);
    $('#pairCode').textContent = valid ? code : '';
    $('#pairApprovalCode').hidden = !valid;
  }

  function safeName(value) {
    return (
      String(value || '')
        .replace(/[\u0000-\u001f\u007f<>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 48) || 'Phone'
    );
  }

  async function request(path, body, options = {}) {
    const owner = state.device?.deviceId || null;
    let response;
    try {
      response = await fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: options.signal,
        headers:
          body === undefined
            ? { Accept: 'application/json' }
            : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (error.name !== 'AbortError') setConnection(false);
      throw error;
    }
    let value = {};
    try {
      value = await response.json();
    } catch {
      /* bounded generic error below */
    }
    if (response.status === 401) {
      if (owner === (state.device?.deviceId || null)) {
        clearProtectedViews();
        localStorage.removeItem(PAIR_KEY);
        state.permissions.clear();
        state.device = null;
        setPairMessage(value.error || 'This phone is no longer paired. Scan a new QR code from XVault.', true, true);
      }
      throw new Error(value.error || 'Phone access was revoked');
    }
    setConnection(true);
    if (!response.ok || value.ok === false) {
      const error = new Error(String(value.error || `Remote request failed (${response.status})`).slice(0, 180));
      error.status = response.status;
      error.result = value;
      throw error;
    }
    return value;
  }

  function clearPairFragment() {
    const clean = `${location.pathname}${location.search}`;
    history.replaceState(null, '', clean);
  }

  async function pair(token) {
    const pairCode = decodeURIComponent(token).slice(0, 256);
    clearPairFragment();
    if (!pairCode)
      return setPairMessage('This pairing link is incomplete. Scan a fresh QR code from XVault.', true, true);
    try {
      setPairMessage('Connecting to your computer…');
      const response = await request('/api/pair/request', {
        token: pairCode,
        name: safeName(`${navigator.platform || 'Mobile'} phone`),
      });
      const flow = {
        requestId: response.requestId,
        claimToken: response.claimToken,
        expiresAt: response.expiresAt,
        pairingCode: response.pairingCode,
      };
      sessionStorage.setItem('xvault.remote.pair-flow', JSON.stringify(flow));
      const started = Date.now();
      setPairMessage('Waiting for approval on your computer…');
      showPairCode(flow.pairingCode);
      while (Date.now() < Number(flow.expiresAt) * 1000 && Date.now() - started < 120_000) {
        await new Promise(resolve => setTimeout(resolve, 1200));
        const result = await request('/api/pair/claim', { requestId: flow.requestId, claimToken: flow.claimToken });
        if (!result.deviceId) continue;
        sessionStorage.removeItem('xvault.remote.pair-flow');
        localStorage.setItem(
          PAIR_KEY,
          JSON.stringify({ deviceId: result.deviceId, name: result.name, pairedAt: Date.now() })
        );
        await startApp();
        toast('Phone paired with XVault');
        return;
      }
      sessionStorage.removeItem('xvault.remote.pair-flow');
      setPairMessage('This pairing request expired. Scan a new QR code from XVault.', true, true);
    } catch (error) {
      if ($('#pairScreen').hidden) return;
      setPairMessage(error.message || 'Could not reach XVault on this Wi-Fi.', true, true);
    }
  }

  function showApp() {
    $('#pairScreen').hidden = true;
    $('#app').hidden = false;
  }

  async function startApp() {
    showApp();
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(PAIR_KEY) || '{}');
    } catch {
      localStorage.removeItem(PAIR_KEY);
    }
    state.device = saved;
    $('#deviceName').textContent = saved.name || 'Private device access';
    state.dataSaver = localStorage.getItem(SAVER_KEY) === '1';
    $('#dataSaver').setAttribute('aria-pressed', String(state.dataSaver));
    const session = await request('/api/session');
    state.hostMotion = session.motion || 'off';
    $('#motionSelect').value = localStorage.getItem('xvault.remote.motion') || 'normal';
    applyMotion();
    state.permissions = new Set(Array.isArray(session.permissions) ? session.permissions : []);
    state.device = { ...saved, name: session.name || saved.name, deviceId: session.deviceId };
    $('#deviceName').textContent = session.name || 'Private device access';
    $('#connectionLabel').textContent = `Paired · ${state.device.name || 'phone'}`;
    renderPermissions();
    state.privacyEnabled = localChoice('xvault.remote.privacy-cover') === '1';
    $('#privacyScreen').setAttribute('aria-pressed', String(state.privacyEnabled));
    updateInstallUI();
    observeArchiveRevision(session, true);
    await search(true);
  }

  function applyMotion() {
    const choice = $('#motionSelect').value,
      host = state.hostMotion || 'off';
    document.documentElement.dataset.motion =
      host === 'off' || choice === 'off' ? 'off' : host === 'reduced' || choice === 'reduced' ? 'reduced' : 'normal';
    if (calm()) {
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
    }
  }
  function setConnection(online) {
    document.documentElement.dataset.connection = online ? 'online' : 'offline';
    $('#connectionLabel').textContent = online ? `Paired · ${state.device?.name || 'phone'}` : 'Computer unreachable';
    const banner = $('#offlineBanner');
    if (banner) banner.hidden = online;
  }
  function resetRemoteBrowse() {
    state.libraryRevision = null;
    state.observedRevision = null;
    $('#updatesBanner').hidden = true;
    browseController?.abort();
    browseSequence++;
    state.remoteViews = [];
    state.savedViewName = '';
    state.monthQuery = '';
    state.selectedFilter = '';
    $('#searchInput').value = '';
    $('#browseMonth').value = '';
    $('#savedViewList').replaceChildren();
    for (const id of ['browseSheet', 'privacyCover']) if ($(`#${id}`).open) $(`#${id}`).close();
    privacyReturn = null;
    $('#installBanner').hidden = true;
  }
  function observeArchiveRevision(session, initial = false) {
    const revision = session.libraryRevision;
    if (!Number.isSafeInteger(revision) || revision < 0 || !state.permissions.has('library.read')) return;
    state.observedRevision = revision;
    if (initial || state.libraryRevision === null) state.libraryRevision = revision;
    $('#updatesBanner').hidden = state.libraryRevision === revision;
  }
  function renderPermissions() {
    const list = $('#permissionList');
    if (!list) return;
    list.replaceChildren();
    for (const [key, label] of [
      ['library.read', 'Browse archive'],
      ['media.read', 'View local media'],
      ['notes.write', 'Edit private notes'],
      ['favorite.write', 'Change favorites'],
      ['tags.write', 'Edit tags'],
      ['downloads.manage', 'Save media to PC'],
    ]) {
      const row = document.createElement('li'),
        name = document.createElement('span'),
        value = document.createElement('b');
      name.textContent = label;
      value.textContent = state.permissions.has(key) ? 'Allowed' : 'Off';
      row.append(name, value);
      list.append(row);
    }
  }
  function clearProtectedViews() {
    viewScrollPositions.clear();
    cancelPCRequests();
    pcReceipts.clear();
    resetRemoteBrowse();
    if (noteBinding && $('#noteInput').value !== noteBinding.base) retainNote(noteBinding);
    noteVersion++;
    noteBinding = null;
    $('#noteInput').value = '';
    $('#noteSaved').value = '';
    if ($('#actionSheet').open) $('#actionSheet').close();
    closeViewer();
    state.sheetPost = null;
    state.controller?.abort();
    state.queryVersion++;
    state.rows.clear();
    state.pageStarts = [null];
    state.firstPage = 0;
    state.lastPage = -1;
    state.beforeCount = 0;
    state.afterCount = 0;
    state.hasMore = false;
    $('#gallery').replaceChildren();
  }
  let sessionRefreshing = false;
  async function refreshSession() {
    if (sessionRefreshing || document.hidden || $('#app').hidden) return;
    sessionRefreshing = true;
    try {
      const session = await request('/api/session');
      state.hostMotion = session.motion || 'off';
      applyMotion();
      const permissions = new Set(Array.isArray(session.permissions) ? session.permissions : []);
      const changed = [...permissions].join('|') !== [...state.permissions].join('|');
      state.permissions = permissions;
      observeArchiveRevision(session);
      if (changed) {
        if (!permissions.has('downloads.manage')) cancelPCRequests();
        if (!permissions.has('library.read')) clearProtectedViews();
        renderWindow();
        $('#sheetFavorite').hidden = !permissions.has('favorite.write');
        if (!permissions.has('notes.write')) {
          if (noteBinding && $('#noteInput').value !== noteBinding.base) retainNote(noteBinding);
          noteVersion++;
          noteBinding = null;
          $('#noteEditor').hidden = true;
          $('#noteInput').value = '';
          $('#noteSaved').value = '';
        }
        if (!permissions.has('media.read') && $('#viewer').open) closeViewer();
      }
      renderPermissions();
      updateDownloadControls();
    } catch {
      /* request handles revocation; keep the existing offline view */
    } finally {
      sessionRefreshing = false;
    }
  }

  function formatNumber(value) {
    return new Intl.NumberFormat(undefined, {
      notation: Number(value) > 9999 ? 'compact' : 'standard',
      maximumFractionDigits: 1,
    }).format(Number(value) || 0);
  }
  function formatTime(value) {
    const date = new Date(value || 0);
    if (!Number.isFinite(date.getTime()) || !value) return 'Archived';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  }
  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => element.classList.remove('show'), 2100);
  }

  function combinedQuery() {
    return [state.selectedFilter, $('#searchInput').value.trim(), state.monthQuery]
      .filter(Boolean)
      .join(' ')
      .slice(0, 1000);
  }

  function updateCount() {
    $('#libraryHeading').textContent = state.savedViewName || (state.monthQuery ? 'Time Machine' : 'Library');
    $('#resultCount').textContent = state.matchedExact
      ? `${formatNumber(state.matched)} ${state.matched === 1 ? 'post' : 'posts'}`
      : `${formatNumber(state.matched)} found so far`;
    $('#queryLine').hidden = !state.query;
    $('#queryLine').textContent = state.query ? `Searching · ${state.query}` : '';
  }

  function setLoadStatus(message = '', continueSearch = false) {
    const root = $('#loadStatus');
    root.replaceChildren();
    if (continueSearch) {
      const status = document.createElement('span');
      status.textContent = message;
      const button = document.createElement('button');
      button.id = 'continueSearch';
      button.className = 'continue-search';
      button.type = 'button';
      button.textContent = 'Continue search';
      button.addEventListener('click', () => loadNext().catch(handlePageError));
      root.append(status, button);
    } else root.textContent = message;
  }

  function columns() {
    return Math.max(1, getComputedStyle($('#gallery')).gridTemplateColumns.split(' ').length);
  }
  function estimatedPageHeight(rows) {
    const grid = $('#gallery');
    const cols = columns();
    const gap = parseFloat(getComputedStyle(grid).rowGap) || 9;
    const width = grid.clientWidth;
    const tile = Math.max(100, (width - gap * (cols - 1)) / cols);
    const measured = grid.querySelector('.post-tile')?.getBoundingClientRect().height || 0;
    return Math.ceil(rows / cols) * ((measured || tile + (innerWidth <= 480 ? 90 : 68)) + gap);
  }

  function mediaPath(media, tier = 'thumb') {
    if (!media || typeof media.url !== 'string') return null;
    try {
      const parsed = new URL(media.url, location.origin);
      if (parsed.origin !== location.origin || !/^\/api\/media\/[A-Za-z0-9_-]{32,80}$/.test(parsed.pathname))
        return null;
      parsed.searchParams.set('tier', tier);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return null;
    }
  }

  function postLink(post) {
    try {
      const url = new URL(post?.link || '');
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !/^\/[A-Za-z0-9_]{1,15}\/status\/\d{1,32}\/?$/.test(url.pathname)
      )
        return null;
      return url.href;
    } catch {
      return null;
    }
  }

  function makeIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function makeAction(post, icon, label, callback, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tile-action ${className}`.trim();
    button.setAttribute('aria-label', label);
    button.append(makeIcon(icon));
    button.addEventListener('click', event => {
      event.stopPropagation();
      callback(post);
    });
    return button;
  }

  function createTile(post) {
    const tile = document.createElement('article');
    tile.className = 'post-tile';
    tile.dataset.postId = post.id;
    const media = Array.isArray(post.media) ? post.media[0] : null;
    const path = mediaPath(media);
    if (path && !state.dataSaver) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tile-media has-media';
      button.setAttribute('aria-label', `Open media from @${post.handle || post.name || 'post'}`);
      const image = document.createElement('img');
      image.loading = 'lazy';
      image.decoding = 'async';
      image.fetchPriority = 'low';
      image.alt = '';
      image.src = path;
      image.addEventListener(
        'error',
        () => {
          image.remove();
          button.append(makePlaceholder(post));
        },
        { once: true }
      );
      button.append(image);
      if (/video|gif|animation/i.test(media.type || '')) {
        const play = document.createElement('span');
        play.className = 'tile-play';
        play.append(makeIcon('play'));
        button.append(play);
      }
      button.addEventListener('click', () => openViewer(post, 0));
      tile.append(button);
    } else {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'tile-media';
      open.append(makePlaceholder(post));
      open.setAttribute(
        'aria-label',
        Number(post.mediaCount) > 0 ? 'Open post media and download options' : 'Open post details'
      );
      open.addEventListener('click', () =>
        Number(post.mediaCount) > 0 && state.permissions.has('media.read') ? openViewer(post, 0) : openSheet(post)
      );
      tile.append(open);
    }
    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    const author = document.createElement('div');
    author.className = 'tile-author';
    const handle = document.createElement('b');
    handle.textContent = post.name || (post.handle ? `@${post.handle}` : 'Archived post');
    const date = document.createElement('small');
    date.textContent = `${post.handle ? `@${post.handle} · ` : ''}${formatTime(post.createdAt || post.archivedAt)}`;
    author.append(handle, date);
    const actions = document.createElement('div');
    actions.className = 'tile-actions';
    if (state.permissions.has('favorite.write'))
      actions.append(
        makeAction(
          post,
          'heart',
          post.favorite ? 'Remove from favorites' : 'Save to favorites',
          toggleFavorite,
          post.favorite ? 'is-favorite' : ''
        )
      );
    if (state.permissions.has('downloads.manage') && Number(post.mediaCount || post.media?.length)) {
      const save = makeAction(post, 'pc-save', 'Save all media to PC', saveToPC, 'tile-pc-save');
      save.dataset.pcPost = String(post.id);
      actions.append(save);
    }
    actions.append(makeAction(post, 'more', 'More post actions', openSheet));
    meta.append(author, actions);
    tile.append(meta);
    let holdPoint = null,
      heldAt = 0;
    const holdStart = event => {
      if (event.target.closest('.tile-action') || !event.isPrimary) return;
      holdPoint = { x: event.clientX, y: event.clientY };
      clearTimeout(state.pressTimer);
      state.pressTimer = setTimeout(() => {
        if (tile.isConnected && holdPoint) {
          heldAt = Date.now();
          openSheet(post);
        }
      }, 460);
    };
    const holdEnd = () => clearTimeout(state.pressTimer);
    tile.addEventListener('pointerdown', holdStart, { passive: true });
    tile.addEventListener(
      'pointermove',
      event => {
        if (holdPoint && Math.hypot(event.clientX - holdPoint.x, event.clientY - holdPoint.y) > 12) {
          holdPoint = null;
          clearTimeout(state.pressTimer);
        }
      },
      { passive: true }
    );
    for (const name of ['pointerup', 'pointerleave', 'pointercancel'])
      tile.addEventListener(name, holdEnd, { passive: true });
    tile.addEventListener(
      'click',
      event => {
        if (heldAt && Date.now() - heldAt < 800) {
          event.preventDefault();
          event.stopPropagation();
          heldAt = 0;
        }
      },
      true
    );
    return tile;
  }

  function makePlaceholder(post) {
    const placeholder = document.createElement('span');
    placeholder.className = 'tile-placeholder';
    const excerpt = document.createElement('span');
    excerpt.className = 'placeholder-lines';
    excerpt.textContent = String(post.text || 'Post saved in your local archive.').slice(0, 330);
    const byline = document.createElement('small');
    byline.textContent = post.handle ? `@${post.handle}` : 'XVault archive';
    placeholder.append(excerpt, byline);
    if (Number(post.mediaCount) > 0) {
      const reason = document.createElement('small');
      reason.className = 'media-availability';
      reason.textContent = state.dataSaver
        ? 'Previews paused · Data Saver'
        : post.mediaState === 'permission-required'
          ? 'Media access is off for this phone'
          : post.mediaState === 'missing'
            ? 'Local file unavailable · open to recover'
            : post.mediaState === 'not-downloaded'
              ? 'Media not downloaded to PC yet'
              : 'Preview unavailable · open media';
      placeholder.append(reason);
    }
    return placeholder;
  }

  function renderWindow() {
    const gallery = $('#gallery');
    const fragment = document.createDocumentFragment();
    if (state.beforeCount) {
      const spacer = document.createElement('div');
      spacer.className = 'gallery-spacer';
      spacer.style.height = `${estimatedPageHeight(state.beforeCount)}px`;
      spacer.setAttribute('aria-hidden', 'true');
      fragment.append(spacer);
    }
    for (let pageIndex = state.firstPage; pageIndex <= state.lastPage; pageIndex++) {
      const page = state.rows.get(pageIndex);
      if (!page) continue;
      for (const post of page.rows) fragment.append(createTile(post));
    }
    if (state.afterCount) {
      const spacer = document.createElement('div');
      spacer.className = 'gallery-spacer';
      spacer.style.height = `${estimatedPageHeight(state.afterCount)}px`;
      spacer.setAttribute('aria-hidden', 'true');
      fragment.append(spacer);
    }
    gallery.replaceChildren(fragment);
    updateDownloadControls();
    gallery.setAttribute('aria-busy', String(state.loadingNext || state.loadingPrevious));
    updateCount();
  }

  function renderEmpty(title, message, retry = false) {
    const box = document.createElement('div');
    box.className = 'empty-state';
    const heading = document.createElement('h2');
    heading.textContent = title;
    const copy = document.createElement('p');
    copy.textContent = message;
    box.append(heading, copy);
    if (retry) {
      const button = document.createElement('button');
      button.className = 'text-button';
      button.textContent = 'Try again';
      button.addEventListener('click', () => search(true));
      box.append(button);
    }
    $('#gallery').replaceChildren(box);
    $('#gallery').setAttribute('aria-busy', 'false');
  }

  async function search(reset = false) {
    if (!state.permissions.has('library.read')) {
      renderEmpty(
        'Library access is off',
        'Allow Library access for this phone in XVault Remote settings on your computer.'
      );
      return;
    }
    if (reset) {
      state.libraryRevision = state.observedRevision;
      $('#updatesBanner').hidden = true;
      state.controller?.abort();
      state.controller = new AbortController();
      state.queryVersion++;
      state.query = combinedQuery();
      state.sort = $('#sortSelect').value;
      state.pageStarts = [null];
      state.rows.clear();
      state.firstPage = 0;
      state.lastPage = -1;
      state.beforeCount = 0;
      state.afterCount = 0;
      state.hasMore = false;
      state.matched = 0;
      state.matchedExact = true;
      state.truncated = false;
      state.loadingNext = false;
      state.loadingPrevious = false;
      $('#scrollRegion').scrollTop = 0;
      state.lastScrollTop = 0;
      viewScrollPositions.set('libraryView', 0);
      $('#gallery').replaceChildren(
        Object.assign(document.createElement('div'), {
          className: 'loading-state',
          innerHTML: '<span class="spinner" aria-hidden="true"></span><p>Searching your Library…</p>',
        })
      );
      $('#gallery').setAttribute('aria-busy', 'true');
      setLoadStatus();
    }
    const version = state.queryVersion;
    try {
      await fetchPage(0, version);
    } catch (error) {
      if (error.name === 'AbortError' || version !== state.queryVersion) return;
      renderEmpty(
        'Couldn’t open the Library',
        error.message || 'Check that XVault is running on the same Wi-Fi.',
        true
      );
    }
  }

  async function fetchPage(pageIndex, version = state.queryVersion) {
    const first = pageIndex === 0;
    const continueSearchWasFocused = document.activeElement?.id === 'continueSearch';
    if (!first && state.rows.has(pageIndex)) return;
    if (pageIndex > 0 && !state.pageStarts[pageIndex]) return;
    const isPrevious = pageIndex < state.firstPage;
    const wasLatest = pageIndex >= state.lastPage;
    if (isPrevious) state.loadingPrevious = true;
    else if (!first) state.loadingNext = true;
    $('#gallery').setAttribute('aria-busy', 'true');
    try {
      const cursor = state.pageStarts[pageIndex] ?? null;
      const response = await request(
        '/api/library',
        { query: state.query, sort: state.sort, limit: PAGE_SIZE, cursor, sessionId: CLIENT_SESSION },
        { signal: state.controller?.signal }
      );
      if (version !== state.queryVersion) return;
      if (response.cancelled) {
        void search(true);
        return;
      }
      state.permissions = new Set(Array.isArray(response.permissions) ? response.permissions : [...state.permissions]);
      const rows = (Array.isArray(response.rows) ? response.rows : []).filter(row =>
        /^\d{1,32}$/.test(String(row.id || ''))
      );
      state.rows.set(pageIndex, { rows });
      state.pageStarts[pageIndex + 1] = response.nextCursor || null;
      state.matched = Math.max(0, Number(response.matched) || 0);
      state.matchedExact = response.matchedExact !== false;
      state.truncated = !!response.truncated;
      if (wasLatest) state.hasMore = !!response.hasMore;
      state.firstPage = Math.min(state.firstPage, pageIndex);
      state.lastPage = Math.max(state.lastPage, pageIndex);
      if (isPrevious) state.beforeCount = Math.max(0, state.beforeCount - rows.length);
      if (pageIndex > 0 && pageIndex > state.lastPage - 1)
        state.afterCount = Math.max(0, state.afterCount - rows.length);
      trimWindow(isPrevious);
      renderWindow();
      if (!state.matched) {
        const message = response.hasMore
          ? `Checked ${formatNumber(response.scanned || 0)} archived posts. Continue to search the next window.`
          : state.query
            ? 'Try another word or remove a filter.'
            : 'Archived posts will appear here as you browse X.';
        renderEmpty(response.hasMore ? 'Search continues' : 'Nothing in this search yet', message);
      }
      if (response.hasMore && rows.length < PAGE_SIZE)
        setLoadStatus(
          `Checked ${formatNumber(response.scanned || 0)} records · ${formatNumber(state.matched)} matches so far`,
          true
        );
      else if (response.hasMore) setLoadStatus('Scroll for more');
      else if (response.truncated)
        setLoadStatus(`Top 5,000 of ${formatNumber(state.matched)} · narrow the search for more`);
      else setLoadStatus(state.matched ? 'End of results' : '');
      if (continueSearchWasFocused) ($('#continueSearch') || $('#loadStatus'))?.focus({ preventScroll: true });
    } finally {
      if (version === state.queryVersion) {
        state.loadingNext = false;
        state.loadingPrevious = false;
        $('#gallery').setAttribute('aria-busy', 'false');
      }
    }
  }

  function trimWindow(previous = false) {
    while (state.rows.size > CACHE_PAGES) {
      const older = state.rows.get(state.firstPage);
      if (!previous && older && state.firstPage < state.lastPage) {
        state.beforeCount += older.rows.length;
        state.rows.delete(state.firstPage++);
        continue;
      }
      const newer = state.rows.get(state.lastPage);
      if (newer && state.lastPage > state.firstPage) {
        state.afterCount += newer.rows.length;
        state.rows.delete(state.lastPage--);
        continue;
      }
      break;
    }
  }

  async function loadNext() {
    if (state.loadingNext) return;
    if (state.afterCount) {
      const index = state.lastPage + 1;
      if (!state.pageStarts[index]) return;
      state.loadingNext = true;
      try {
        await fetchPage(index);
      } finally {
        state.loadingNext = false;
      }
      return;
    }
    if (!state.hasMore) return;
    await fetchPage(state.lastPage + 1);
  }

  async function loadPrevious() {
    if (state.loadingPrevious || !state.beforeCount || state.firstPage <= 0) return;
    const previous = state.firstPage - 1;
    state.loadingPrevious = true;
    try {
      await fetchPage(previous);
    } finally {
      state.loadingPrevious = false;
    }
  }

  function onScroll() {
    if ($('#libraryView').hidden) return;
    if (state.scrollScheduled) return;
    state.scrollScheduled = true;
    requestAnimationFrame(() => {
      state.scrollScheduled = false;
      if ($('#libraryView').hidden) return;
      const region = $('#scrollRegion');
      const top = region.scrollTop,
        down = top > state.lastScrollTop;
      const nearBottom = region.scrollHeight - (top + region.clientHeight) < 480;
      if (down && nearBottom) loadNext().catch(handlePageError);
      if (!down && top < 340) loadPrevious().catch(handlePageError);
      state.lastScrollTop = top;
    });
  }

  function handlePageError(error) {
    if (error.status === 410) {
      toast('Search window expired · refreshing');
      search(true);
      return;
    }
    setLoadStatus(error.message || 'Could not load more posts');
  }

  function showView(viewId) {
    const order = ['libraryView', 'recentView', 'settingsView'],
      before = document.querySelector('.view.active')?.id;
    const region = $('#scrollRegion');
    if (before && before !== viewId) viewScrollPositions.set(before, region.scrollTop);
    for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== viewId;
    for (const view of document.querySelectorAll('.view')) view.classList.toggle('active', view.id === viewId);
    if (before !== viewId && viewId === 'libraryView' && (state.beforeCount || state.afterCount)) renderWindow();
    if (before !== viewId) {
      region.scrollTop = viewScrollPositions.get(viewId) || 0;
      if (viewId === 'libraryView') state.lastScrollTop = region.scrollTop;
    }
    if (before !== viewId)
      move($(`#${viewId}`), [
        { opacity: 0.5, transform: `translateX(${order.indexOf(viewId) > order.indexOf(before) ? 12 : -12}px)` },
        { opacity: 1, transform: 'none' },
      ]);
    for (const button of document.querySelectorAll('.nav-item')) {
      const active = button.dataset.view === viewId;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    if (viewId === 'recentView') loadActivity();
  }

  async function loadActivity() {
    if (!state.permissions.has('library.read')) {
      $('#activityList').textContent = 'Allow Library access for this phone in XVault on your computer.';
      return;
    }
    const list = $('#activityList');
    list.replaceChildren();
    try {
      const result = await request('/api/activity');
      const rows = Array.isArray(result.rows) ? result.rows : [];
      if (!rows.length) {
        list.append(makeEmptyActivity());
        return;
      }
      for (const entry of rows) {
        const item = document.createElement('article');
        item.className = 'activity-row';
        const marker = document.createElement('span');
        marker.className = 'activity-marker';
        const body = document.createElement('div');
        const text = document.createElement('p');
        text.textContent = String(entry.text || 'XVault activity').slice(0, 180);
        const time = document.createElement('time');
        time.dateTime = new Date(entry.at || 0).toISOString();
        time.textContent = formatTime(entry.at);
        body.append(text, time);
        item.append(marker, body);
        list.append(item);
      }
    } catch (error) {
      list.textContent = error.message || 'Recent activity is unavailable.';
    }
  }

  function makeEmptyActivity() {
    const box = document.createElement('div');
    box.className = 'empty-state';
    const heading = document.createElement('h2');
    heading.textContent = 'A quiet archive.';
    const copy = document.createElement('p');
    copy.textContent = 'New archive and Library actions will show up here.';
    box.append(heading, copy);
    return box;
  }

  function setQuickFilter(query) {
    state.selectedFilter = query;
    state.savedViewName = '';
    for (const button of document.querySelectorAll('.filter'))
      button.classList.toggle('active', button.dataset.query === query);
    search(true);
  }

  const VIEWER_MEDIA_PAGE = 16;
  function openViewer(post, mediaIndex = 0) {
    const count = Number(post.mediaCount || post.media?.length) || 0;
    if (!count) return openSheet(post);
    state.currentPost = post;
    state.currentMediaIndex = Math.max(0, Math.min(count - 1, mediaIndex));
    state.captionExpanded = false;
    state.viewerVersion = '';
    state.viewerPage = null;
    state.viewerReturn = document.activeElement;
    if (!$('#viewer').open) $('#viewer').showModal();
    void loadViewerMedia(post, Math.floor(state.currentMediaIndex / VIEWER_MEDIA_PAGE) * VIEWER_MEDIA_PAGE);
  }
  function currentViewerMedia() {
    return state.viewerPage?.media?.[state.currentMediaIndex - state.viewerPageOffset] || null;
  }
  async function loadViewerMedia(post, offset) {
    const restoreThumbFocus = $('#viewerThumbs').contains(document.activeElement);
    state.viewerController?.abort();
    const controller = new AbortController(),
      sequence = ++state.viewerSequence;
    state.viewerController = controller;
    state.viewerPageOffset = offset;
    state.viewerPage = null;
    renderViewer();
    try {
      const page = await request(
        '/api/media/page',
        { id: String(post.id), offset, mediaVersion: state.viewerVersion },
        { signal: controller.signal }
      );
      if (sequence !== state.viewerSequence || state.currentPost !== post) return;
      if (state.viewerVersion && state.viewerVersion !== page.mediaVersion) {
        toast('This post media changed. Close and reopen the viewer.');
        return;
      }
      state.viewerVersion = page.mediaVersion;
      state.viewerPage = page;
      move($('#viewerStage'), [
        { opacity: 0.45, transform: 'translateX(14px)' },
        { opacity: 1, transform: 'none' },
      ]);
      renderViewer();
      if (restoreThumbFocus) $('#viewerThumbs [aria-current="true"]')?.focus({ preventScroll: true });
    } catch (error) {
      if (error.name === 'AbortError' || sequence !== state.viewerSequence) return;
      const stage = $('#viewerStage');
      stage.replaceChildren();
      const message = document.createElement('p');
      message.className = 'media-error';
      message.textContent =
        error.status === 410
          ? 'This post changed while the viewer was open. Close and reopen it.'
          : error.message || 'This media page could not load.';
      stage.append(message);
    }
  }
  function renderViewer() {
    const post = state.currentPost;
    if (!post) return;
    const page = state.viewerPage,
      media = currentViewerMedia(),
      stage = $('#viewerStage');
    releaseViewerMedia();
    stage.replaceChildren();
    const mediaIndex = state.currentMediaIndex;
    if (!media) {
      const message = document.createElement('p');
      message.className = 'media-loading';
      message.textContent = 'Loading media ' + (mediaIndex + 1) + '...';
      stage.append(message);
    } else if (!media.url) {
      const message = document.createElement('p');
      message.className = 'media-error';
      message.textContent = 'This file is not available on the paired computer.';
      stage.append(message);
      appendMediaReload(stage, post);
    } else if (/video|gif|animation/i.test(media.type || '')) {
      const video = document.createElement('video');
      video.src = media.url;
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      stage.append(video);
    } else {
      const image = document.createElement('img');
      image.src = media.url;
      image.alt = String(post.text || 'Archived post media').slice(0, 120);
      image.decoding = 'async';
      stage.append(image);
    }
    const count = Number(page?.mediaCount || post.mediaCount || post.media?.length) || 0;
    $('#viewerPosition').textContent = mediaIndex + 1 + ' / ' + count;
    $('#viewerAuthor').textContent = post.name
      ? post.name + (post.handle ? ' · @' + post.handle : '')
      : post.handle
        ? '@' + post.handle
        : 'XVault archive';
    if (media?.shared) $('#viewerAuthor').textContent += ' / Shared from post ' + (media.ownerPostId || 'another post');
    const caption = String(post.text || '');
    $('#viewerCaption').textContent = caption;
    $('#viewerCaption').classList.toggle('expanded', state.captionExpanded);
    $('#viewerCaptionToggle').hidden = caption.length <= 240;
    $('#viewerCaptionToggle').textContent = state.captionExpanded ? 'Hide full post text' : 'Show full post text';
    const thumbs = $('#viewerThumbs');
    thumbs.replaceChildren();
    if (page?.media?.length > 1)
      for (const item of page.media) {
        const thumb = document.createElement('button');
        thumb.type = 'button';
        thumb.className = 'viewer-thumb' + (item.index === mediaIndex ? ' active' : '');
        thumb.setAttribute('aria-label', 'Show media ' + (item.index + 1));
        const preview = state.dataSaver ? null : mediaPath(item, 'contact');
        if (preview) {
          const image = document.createElement('img');
          image.loading = 'lazy';
          image.decoding = 'async';
          image.fetchPriority = 'low';
          image.src = preview;
          image.alt = '';
          image.onerror = () => {
            image.remove();
            thumb.append(makeIcon(/video|gif|animation/i.test(item.type || '') ? 'play' : 'photo'));
          };
          thumb.append(image);
        } else thumb.append(makeIcon(/video|gif|animation/i.test(item.type || '') ? 'play' : 'photo'));
        thumb.setAttribute('aria-current', String(item.index === mediaIndex));
        thumb.addEventListener('click', () => switchMedia(item.index));
        thumbs.append(thumb);
      }
    $('#viewerPrevious').disabled = mediaIndex <= 0;
    $('#viewerNext').disabled = mediaIndex >= count - 1;
    updateDownloadControls();
    const fail = event => {
      if (!stage.contains(event.currentTarget) || state.currentPost !== post || state.currentMediaIndex !== mediaIndex)
        return;
      releaseViewerMedia();
      stage.replaceChildren();
      const message = document.createElement('p');
      message.className = 'media-error';
      message.textContent = 'This local file could not load. Check media permission and file availability.';
      stage.append(message);
      appendMediaReload(stage, post);
    };
    stage.querySelector('img,video')?.addEventListener('error', fail, { once: true });
  }
  function appendMediaReload(stage, post) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'media-reload';
    button.textContent = 'Check local file';
    button.onclick = async () => {
      if (state.currentPost !== post) return;
      const index = state.currentMediaIndex,
        focused = document.activeElement === button;
      await loadViewerMedia(post, Math.floor(index / VIEWER_MEDIA_PAGE) * VIEWER_MEDIA_PAGE);
      if (focused && state.currentPost === post && state.currentMediaIndex === index)
        ($('#viewerStage .media-reload') || $('#viewerSavePhone[href]') || $('#viewerNext'))?.focus({
          preventScroll: true,
        });
    };
    stage.append(button);
  }
  function releaseViewerMedia() {
    for (const video of $('#viewerStage').querySelectorAll('video')) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }
  function switchMedia(index) {
    if (!state.currentPost) return;
    const post = state.currentPost,
      count = Number(post.mediaCount || post.media?.length) || 0,
      next = Math.max(0, Math.min(count - 1, index));
    if (next === state.currentMediaIndex) return;
    const direction = next > state.currentMediaIndex ? 1 : -1;
    state.currentMediaIndex = next;
    if (!state.viewerPage || next < state.viewerPageOffset || next >= state.viewerPageOffset + VIEWER_MEDIA_PAGE)
      void loadViewerMedia(post, Math.floor(next / VIEWER_MEDIA_PAGE) * VIEWER_MEDIA_PAGE);
    else renderViewer();
    move($('#viewerStage'), [
      { opacity: 0.4, transform: 'translateX(' + direction * 18 + 'px)' },
      { opacity: 1, transform: 'none' },
    ]);
    $('#viewerThumbs [aria-current="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  }
  function closeViewer() {
    state.viewerController?.abort();
    state.viewerController = null;
    state.viewerSequence++;
    releaseViewerMedia();
    if ($('#viewer').open) $('#viewer').close();
    $('#viewerStage').replaceChildren();
    state.currentPost = null;
    state.viewerPage = null;
    updateDownloadControls();
  }

  function openExternal(post) {
    const url = postLink(post);
    if (!url) return toast('This post has no valid link');
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) toast('Your browser blocked the new tab');
  }

  async function copyLink(post) {
    const url = postLink(post);
    if (!url) return toast('This post has no valid link');
    try {
      await navigator.clipboard.writeText(url);
      toast('Post link copied');
    } catch {
      toast('Clipboard permission was blocked');
    }
  }

  let noteBinding = null,
    noteVersion = 0;
  const draftKey = id => `xvault.remote.note-draft:${state.device?.deviceId || 'device'}:${id}`;
  const editorFamily = id => `${draftKey(id)}:${editorId}:`;
  const ownerPrefix = id => `${draftKey(id)}:${editorId}:${tabEditorId}:`;
  function retainedDraft(id) {
    const own = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(editorFamily(id)))
        try {
          const row = JSON.parse(localStorage.getItem(key));
          if (typeof row?.value === 'string' && typeof row?.base === 'string') own.push(row);
        } catch {}
    }
    if (own.length) return own.sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    try {
      return JSON.parse(localStorage.getItem(draftKey(id)) || 'null');
    } catch {
      return null;
    }
  }
  // A persisted note value makes identical copies in cloned/reloaded tabs redundant; divergent drafts stay recoverable.
  function clearSavedDrafts(id, value) {
    const keys = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key === draftKey(id) || key?.startsWith(editorFamily(id))) keys.push(key);
    }
    for (const key of keys)
      try {
        const saved = JSON.parse(localStorage.getItem(key));
        if (saved?.value === value) localStorage.removeItem(key);
      } catch {}
  }
  function retainNote(binding) {
    try {
      localStorage.setItem(
        binding.key,
        JSON.stringify({
          value: $('#noteInput').value,
          base: binding.base,
          at: Date.now(),
          postId: binding.id,
          deviceId: state.device?.deviceId || 'device',
        })
      );
      return true;
    } catch {
      $('#noteStatus').textContent = 'Draft storage is full. Keep this screen open or copy your note before leaving.';
      return false;
    }
  }
  function noteConflict(binding, saved) {
    binding.conflict = true;
    binding.latest = saved;
    $('#noteSaved').value = saved;
    $('#noteConflict').hidden = false;
    $('#noteSave').disabled = true;
    $('#noteStatus').textContent = 'Review the saved note before choosing which version to save.';
  }
  async function openNote(post) {
    const version = ++noteVersion;
    noteBinding = null;
    $('#noteEditor').hidden = !state.permissions.has('notes.write');
    if ($('#noteEditor').hidden) return;
    let retained;
    try {
      retained = retainedDraft(post.id);
    } catch {
      /* preserve unreadable drafts */
    }
    $('#noteInput').readOnly = false;
    $('#noteInput').disabled = true;
    $('#noteInput').value = typeof retained?.value === 'string' ? retained.value : '';
    $('#noteSave').disabled = true;
    $('#noteConflict').hidden = true;
    $('#noteRetry').hidden = true;
    $('#noteStatus').textContent = 'Reading saved note…';
    try {
      const result = await request('/api/note/read', { id: post.id });
      if (version !== noteVersion || !$('#actionSheet').open) return;
      let draft;
      try {
        draft = retainedDraft(post.id);
      } catch {
        /* retain corrupt data for manual recovery */
      }
      const saved = String(result.note || '');
      noteBinding = {
        id: post.id,
        key: `${ownerPrefix(post.id)}${crypto.randomUUID()}`,
        base: draft && typeof draft.base === 'string' ? draft.base : saved,
        saving: false,
        conflict: false,
      };
      $('#noteInput').value = draft && typeof draft.value === 'string' ? draft.value : saved;
      $('#noteInput').disabled = false;
      $('#noteSave').disabled = false;
      $('#noteStatus').textContent = draft
        ? 'Retained draft recovered on this device.'
        : 'Notes stay private in your archive.';
      if (draft && noteBinding.base !== saved && $('#noteInput').value !== saved) noteConflict(noteBinding, saved);
      else noteBinding.base = saved;
    } catch (error) {
      if (version !== noteVersion) return;
      $('#noteInput').disabled = false;
      $('#noteInput').readOnly = true;
      $('#noteStatus').textContent = `Could not read the note: ${error.message}`;
      $('#noteRetry').hidden = false;
    }
  }
  async function saveNote() {
    const binding = noteBinding;
    if (!binding || binding.saving || binding.conflict) return;
    const value = $('#noteInput').value;
    if (!retainNote(binding)) return;
    binding.saving = true;
    $('#noteSave').disabled = true;
    $('#noteSave').setAttribute('aria-busy', 'true');
    $('#noteStatus').textContent = 'Saving note…';
    try {
      await request('/api/note', { id: binding.id, note: value, expectedNote: binding.base });
      if (binding !== noteBinding) return;
      binding.base = value;
      if ($('#noteInput').value === value) {
        clearSavedDrafts(binding.id, value);
        $('#noteStatus').textContent = 'Note saved.';
      } else {
        retainNote(binding);
        $('#noteStatus').textContent = 'Previous version saved. Newer edits remain in your draft.';
      }
    } catch (error) {
      if (binding !== noteBinding) return;
      if (error.result?.conflict) noteConflict(binding, String(error.result.note || ''));
      else $('#noteStatus').textContent = `Save failed: ${error.message}. Your draft is retained.`;
    } finally {
      binding.saving = false;
      if (binding === noteBinding) {
        $('#noteSave').disabled = binding.conflict;
        $('#noteSave').removeAttribute('aria-busy');
      }
    }
  }
  function openSheet(post) {
    if (!post) return;
    state.sheetPost = post;
    $('#sheetTitle').textContent = post.handle ? `@${post.handle}` : 'Archived post';
    $('#sheetText').textContent = String(post.text || 'No post text was saved.');
    $('#sheetTags').textContent = (post.tags || []).join(' · ');
    $('#sheetFavorite').hidden = !state.permissions.has('favorite.write');
    updateDownloadControls();
    void openNote(post);
    $('#sheetFavorite span').textContent = post.favorite ? 'Remove from Favorites' : 'Save to Favorites';
    const sheet = $('#actionSheet');
    if (!sheet.open) sheet.showModal();
    move(sheet, [{ transform: 'translateY(28px)' }, { transform: 'none' }]);
  }

  async function toggleFavorite(post) {
    if (!state.permissions.has('favorite.write')) return toast('Favorite access is disabled for this phone');
    try {
      const response = await request('/api/favorite', { id: post.id, favorite: !post.favorite });
      post.favorite = !!response.favorite;
      if (state.selectedFilter === 'fav:true' && !post.favorite) return search(true);
      renderWindow();
      toast(post.favorite ? 'Added to Favorites' : 'Removed from Favorites');
    } catch (error) {
      toast(error.message || 'Favorite could not be saved');
    }
  }

  async function forgetDevice() {
    let confirmed = false;
    try {
      await request('/api/forget', {});
      confirmed = true;
    } catch {
      /* local sign-out remains available if Wi-Fi is gone */
    }
    clearProtectedViews();
    state.permissions.clear();
    state.device = null;
    localStorage.removeItem(PAIR_KEY);
    sessionStorage.removeItem('xvault.remote.pair-flow');
    setPairMessage(
      confirmed
        ? 'This phone has been forgotten. Scan a new QR code from XVault to pair again.'
        : 'Local pairing forgotten. Your computer could not confirm revocation; remove this device in desktop Remote settings.',
      !confirmed,
      true
    );
  }

  async function retryPair() {
    if (localStorage.getItem(PAIR_KEY) && !sessionStorage.getItem('xvault.remote.pair-flow')) {
      try {
        await startApp();
      } catch (error) {
        setPairMessage(error.message || 'Computer unreachable. Keep XVault running on the same network.', true, true);
      }
      return;
    }
    const flowRaw = sessionStorage.getItem('xvault.remote.pair-flow');
    if (flowRaw) {
      try {
        const flow = JSON.parse(flowRaw);
        setPairMessage('Checking your pairing request…');
        showPairCode(flow.pairingCode);
        const result = await request('/api/pair/claim', flow);
        if (result.deviceId) {
          localStorage.setItem(
            PAIR_KEY,
            JSON.stringify({ deviceId: result.deviceId, name: result.name, pairedAt: Date.now() })
          );
          sessionStorage.removeItem('xvault.remote.pair-flow');
          await startApp();
          return;
        }
        setPairMessage('Still waiting for approval on your computer…');
        showPairCode(flow.pairingCode);
        return;
      } catch {
        /* request may have expired; rescan below */
      }
    }
    setPairMessage('Scan a fresh pairing QR code from XVault on your computer.', true, false);
  }

  let draftScan = 0,
    draftPage = 0,
    draftRows = [],
    draftImportPlan = null;
  const draftSelection = new Set();
  async function draftFingerprint(raw) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw || '')))]
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  async function renderDraftRecovery() {
    const version = ++draftScan,
      keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('xvault.remote.note-draft:')) keys.push(key);
    }
    const query = $('#draftSearch').value.trim().toLowerCase(),
      rows = [];
    $('#draftStatus').textContent = 'Searching retained evidence…';
    for (let at = 0; at < keys.length; at++) {
      if (version !== draftScan) return;
      const key = keys[at],
        parts = key.slice('xvault.remote.note-draft:'.length).split(':');
      const raw = localStorage.getItem(key);
      let saved;
      try {
        saved = JSON.parse(raw);
      } catch {}
      const text = typeof saved?.value === 'string' ? saved.value : 'Unreadable draft · export the raw evidence',
        id = parts[1] || 'unknown';
      const pairing = $('#draftPairing').value,
        pairingMatches = pairing === 'all' || (pairing === 'current') === (parts[0] === state.device?.deviceId);
      if (pairingMatches && (!query || `${id} ${parts[0]} ${text}`.toLowerCase().includes(query)))
        rows.push({
          fingerprint: await draftFingerprint(raw),
          key,
          id,
          owner: parts[0],
          at: Number(saved?.at) || 0,
          preview: text.slice(0, 180),
          valid: typeof saved?.value === 'string' && typeof saved?.base === 'string',
        });
      if (at % 16 === 15) await new Promise(resolve => setTimeout(resolve, 0));
    }
    draftRows = rows;
    for (const key of [...draftSelection]) if (!keys.includes(key)) draftSelection.delete(key);
    updateDraftSelection();
    const sort = $('#draftSort').value;
    rows.sort((a, b) => (sort === 'post' ? a.id.localeCompare(b.id) : sort === 'old' ? a.at - b.at : b.at - a.at));
    const list = $('#draftList');
    list.replaceChildren();
    $('#draftStatus').textContent = `${rows.length} matching drafts · ${keys.length} retained on this phone`;
    const pageCount = Math.max(1, Math.ceil(rows.length / 50));
    draftPage = Math.min(draftPage, pageCount - 1);
    for (const row of rows.slice(draftPage * 50, (draftPage + 1) * 50)) {
      const item = document.createElement('article');
      item.className = 'draft-row';
      const title = document.createElement('b'),
        summary = document.createElement('p'),
        meta = document.createElement('small'),
        controls = document.createElement('div');
      const select = document.createElement('input');
      select.type = 'checkbox';
      select.checked = draftSelection.has(row.key);
      select.setAttribute('aria-label', 'Select draft for post ' + row.id);
      select.onchange = () => {
        if (select.checked && draftSelection.size >= 500) {
          select.checked = false;
          toast('Select up to 500 drafts per export');
          return;
        }
        if (select.checked) draftSelection.add(row.key);
        else draftSelection.delete(row.key);
        updateDraftSelection();
      };
      item.append(select);
      title.textContent = `Post ${row.id}`;
      summary.textContent = row.preview;
      meta.textContent = `${row.owner === state.device?.deviceId ? 'This pairing' : 'Previous pairing or tab'} · ${row.at ? new Date(row.at).toLocaleString() : 'Date unknown'}`;
      item.append(title, meta, summary, controls);
      const add = (label, run) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.onclick = run;
        controls.append(button);
        return button;
      };
      add('Export', () => {
        const raw = localStorage.getItem(row.key);
        const blob = new Blob(
            [JSON.stringify({ format: 'xvault-remote-note-draft-v1', postId: row.id, raw }, null, 2)],
            { type: 'application/json' }
          ),
          url = URL.createObjectURL(blob),
          a = document.createElement('a');
        a.href = url;
        a.download = `xvault-note-${/^\d+$/.test(row.id) ? row.id : 'unknown'}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
      const recover = add('Recover', () => {
        let saved;
        try {
          saved = JSON.parse(localStorage.getItem(row.key));
        } catch {
          return;
        }
        if (typeof saved?.value !== 'string' || typeof saved?.base !== 'string') return;
        const retained = retainedDraft(row.id);
        if (retained && retained.value !== saved.value) {
          $('#draftStatus').textContent =
            'Another draft is already active for this post. Export both versions or resolve it first.';
          return;
        }
        const key = `${ownerPrefix(row.id)}recovery-${crypto.randomUUID()}`;
        try {
          localStorage.setItem(key, JSON.stringify({ ...saved, at: Date.now(), recoveredFrom: row.key }));
        } catch {
          $('#draftStatus').textContent = 'Draft storage is full. Export the evidence before proceeding.';
          return;
        }
        $('#draftRecovery').close();
        openSheet({ id: row.id, text: 'Recovered draft · compare with the current archive note before saving' });
      });
      recover.disabled = !row.valid || !/^\d{1,32}$/.test(row.id) || !state.permissions.has('notes.write');
      add('Discard', async () => {
        if (!confirm('Discard this local draft? The saved archive note is not changed.')) return;
        const currentRaw = localStorage.getItem(row.key);
        if ((await draftFingerprint(currentRaw)) !== row.fingerprint || localStorage.getItem(row.key) !== currentRaw) {
          $('#draftStatus').textContent = 'Draft changed elsewhere. Review it again before discarding.';
          return;
        }
        localStorage.removeItem(row.key);
        renderDraftRecovery();
      });
      list.append(item);
    }
    if (pageCount > 1) {
      const navigation = document.createElement('div');
      navigation.className = 'draft-pagination';
      for (const [delta, label] of [
        [-1, 'Previous drafts'],
        [1, 'More drafts'],
      ]) {
        const button = document.createElement('button');
        button.textContent = label;
        button.disabled = draftPage + delta < 0 || draftPage + delta >= pageCount;
        button.onclick = () => {
          draftPage += delta;
          renderDraftRecovery();
        };
        navigation.append(button);
      }
      list.append(navigation);
      $('#draftStatus').textContent += ` - page ${draftPage + 1} of ${pageCount}`;
    }
  }
  function updateDraftSelection() {
    const button = $('#draftExportSelected');
    button.disabled = !draftSelection.size;
    button.textContent = 'Export selected' + (draftSelection.size ? ' (' + draftSelection.size + ')' : '');
    $('#draftSelectMatching').disabled = draftRows.length > 500;
  }
  async function importDraftFile(file) {
    if (!file) return;
    try {
      if (file.size > XVaultRemoteDrafts.MAX_BYTES) throw Error('Draft file exceeds 2 MB');
      const preview = await XVaultRemoteDrafts.preview(XVaultRemoteDrafts.snapshot(localStorage), await file.text());
      draftImportPlan = preview;
      $('#draftImportSummary').textContent =
        preview.added +
        ' new drafts, ' +
        preview.identical +
        ' identical skipped, ' +
        preview.conflicts +
        ' conflicts retained separately. Import changes local drafts only.';
      const list = $('#draftImportConflicts');
      list.replaceChildren();
      for (const row of preview.rows.filter(row => row.conflict).slice(0, 10)) {
        const compare = document.createElement('details'),
          summary = document.createElement('summary'),
          columns = document.createElement('div');
        summary.textContent = 'Compare post ' + row.postId;
        columns.className = 'draft-compare';
        for (const [label, value] of [
          ['Retained draft', row.prior.value + '\n\nSaved baseline:\n' + row.prior.base],
          ['Imported draft', row.value + '\n\nSaved baseline:\n' + row.base],
        ]) {
          const section = document.createElement('section'),
            title = document.createElement('b'),
            text = document.createElement('pre');
          title.textContent = label;
          text.textContent = value;
          section.append(title, text);
          columns.append(section);
        }
        compare.append(summary, columns);
        list.append(compare);
      }
      $('#draftImportPreview').hidden = false;
      $('#draftImportCommit').disabled = !preview.added;
      $('#draftImportCommit').focus();
    } catch (error) {
      $('#draftStatus').textContent = error.message;
    }
  }
  async function commitDraftImport() {
    const plan = draftImportPlan;
    if (!plan) return;
    $('#draftImportCommit').disabled = true;
    try {
      const result = await XVaultRemoteDrafts.commit(localStorage, plan);
      draftImportPlan = null;
      $('#draftImportPreview').hidden = true;
      await renderDraftRecovery();
      $('#draftStatus').textContent = result.partial
        ? result.error
        : 'Imported ' + result.imported + ' drafts. Original evidence and conflicting versions are retained.';
    } catch (error) {
      $('#draftStatus').textContent = error.message;
      $('#draftImportCommit').disabled = false;
    }
  }
  function openDraftRecovery() {
    if (!$('#draftRecovery').open) $('#draftRecovery').showModal();
    renderDraftRecovery();
    move($('#draftRecovery'), [
      { transform: 'translateY(28px)', opacity: 0.6 },
      { transform: 'none', opacity: 1 },
    ]);
  }

  function wireEvents() {
    $('#sheetDownloadPC').onclick = () => saveToPC(state.sheetPost);
    $('#sheetDownloadStop').onclick = () => cancelPCRequests(state.sheetPost?.id);
    $('#viewerSavePC').onclick = () => saveToPC(state.currentPost, state.currentMediaIndex);
    $('#viewerSavePhone').onclick = event => {
      if (event.currentTarget.getAttribute('aria-disabled') === 'true') {
        event.preventDefault();
        toast('This file must be available on the computer first.');
      } else toast('File download requested from your browser. Choose where to save it.');
    };
    $('#refreshArchive').onclick = () => search(true);
    $('#browseOpen').onclick = openBrowse;
    $('#browseClose').onclick = () => $('#browseSheet').close();
    $('#viewsRefresh').onclick = loadSavedViews;
    $('#viewsSearch').oninput = renderSavedViews;
    $('#browseSheet').addEventListener('close', () => {
      browseController?.abort();
      browseSequence++;
      $('#viewsRefresh').disabled = false;
      if (!$('#app').hidden) $('#browseOpen').focus({ preventScroll: true });
    });
    $('#monthPrevious').onclick = () => shiftMonth(-1);
    $('#monthNext').onclick = () => shiftMonth(1);
    $('#monthApply').onclick = () => applyMonth();
    $('#monthClear').onclick = () => applyMonth(true);
    $('#installBannerAction').onclick = showInstall;
    $('#installApp').onclick = showInstall;
    $('#installConfirm').onclick = installApp;
    $('#installClose').onclick = () => $('#installSheet').close();
    $('#installDismiss').onclick = () => {
      saveChoice('xvault.remote.install-dismissed', '1');
      updateInstallUI();
    };
    $('#privacyScreen').onclick = () => {
      state.privacyEnabled = !state.privacyEnabled;
      saveChoice('xvault.remote.privacy-cover', state.privacyEnabled ? '1' : '0');
      $('#privacyScreen').setAttribute('aria-pressed', String(state.privacyEnabled));
    };
    $('#privacyReveal').onclick = revealArchive;
    $('#privacyCover').addEventListener('cancel', event => event.preventDefault());
    window.addEventListener('blur', coverArchive);
    window.addEventListener('pagehide', coverArchive);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) coverArchive();
    });
    $('#remoteTheme').value = localStorage.getItem('xvault.remote.theme') || 'graphite';
    document.documentElement.dataset.theme = $('#remoteTheme').value;
    $('#remoteTheme').onchange = () => {
      document.documentElement.dataset.theme = $('#remoteTheme').value;
      localStorage.setItem('xvault.remote.theme', $('#remoteTheme').value);
    };
    $('#draftPairing').onchange = () => {
      draftPage = 0;
      renderDraftRecovery();
    };
    $('#draftSelectMatching').onclick = () => {
      for (const row of draftRows.slice(0, 500)) draftSelection.add(row.key);
      updateDraftSelection();
      renderDraftRecovery();
    };
    $('#draftExportSelected').onclick = async () => {
      try {
        const entries = [...draftSelection].map(key => ({ key, raw: localStorage.getItem(key) })),
          text = await XVaultRemoteDrafts.exportFile(entries),
          url = URL.createObjectURL(new Blob([text], { type: 'application/json' })),
          link = document.createElement('a');
        link.href = url;
        link.download = 'xvault-remote-drafts.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) {
        $('#draftStatus').textContent = error.message;
      }
    };
    $('#draftImportFile').onchange = event => {
      const file = event.target.files[0];
      event.target.value = '';
      void importDraftFile(file);
    };
    $('#draftImportCommit').onclick = commitDraftImport;
    $('#draftImportCancel').onclick = () => {
      draftImportPlan = null;
      $('#draftImportPreview').hidden = true;
    };
    $('#pairDrafts').onclick = openDraftRecovery;
    $('#deviceDrafts').onclick = openDraftRecovery;
    $('#draftClose').onclick = () => $('#draftRecovery').close();
    $('#draftSearch').oninput = () => {
      draftPage = 0;
      renderDraftRecovery();
    };
    $('#draftSort').onchange = () => {
      draftPage = 0;
      renderDraftRecovery();
    };
    $('#draftRecovery').addEventListener('close', () => draftScan++);
    document.addEventListener('visibilitychange', refreshSession);
    setInterval(refreshSession, 15000);
    $('#motionSelect').onchange = () => {
      localStorage.setItem('xvault.remote.motion', $('#motionSelect').value);
      applyMotion();
    };
    $('#noteInput').addEventListener('input', () => {
      if (noteBinding) retainNote(noteBinding);
    });
    $('#noteInput').addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void saveNote();
      }
    });
    $('#noteSave').onclick = saveNote;
    $('#noteRetry').onclick = () => {
      if (state.sheetPost) void openNote(state.sheetPost);
    };
    $('#noteUseSaved').onclick = () => {
      if (!noteBinding || noteBinding.saving) return;
      $('#noteInput').value = noteBinding.latest;
      noteBinding.base = noteBinding.latest;
      noteBinding.conflict = false;
      $('#noteConflict').hidden = true;
      $('#noteSave').disabled = false;
      $('#noteStatus').textContent = 'Saved note loaded. Retained drafts remain available in Device recovery.';
    };
    $('#noteKeepDraft').onclick = () => {
      if (!noteBinding || noteBinding.saving) return;
      noteBinding.base = noteBinding.latest;
      noteBinding.conflict = false;
      $('#noteConflict').hidden = true;
      void saveNote();
    };
    document
      .querySelectorAll('.nav-item')
      .forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
    document
      .querySelectorAll('.filter')
      .forEach(button => button.addEventListener('click', () => setQuickFilter(button.dataset.query || '')));
    $('#searchInput').addEventListener('input', () => {
      state.savedViewName = '';
      $('#clearQuery').hidden = !$('#searchInput').value;
      clearTimeout($('#searchInput')._timer);
      $('#searchInput')._timer = setTimeout(() => search(true), 260);
    });
    $('#searchInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        clearTimeout($('#searchInput')._timer);
        search(true);
        $('#searchInput').blur();
      }
    });
    $('#clearQuery').addEventListener('click', () => {
      clearTimeout($('#searchInput')._timer);
      state.savedViewName = '';
      $('#searchInput').value = '';
      $('#clearQuery').hidden = true;
      search(true);
    });
    $('#sortSelect').addEventListener('change', () => search(true));
    $('#scrollRegion').addEventListener('scroll', onScroll, { passive: true });
    $('#topMore').addEventListener('click', () => showView('settingsView'));
    $('#dataSaver').addEventListener('click', () => {
      state.dataSaver = !state.dataSaver;
      localStorage.setItem(SAVER_KEY, state.dataSaver ? '1' : '0');
      $('#dataSaver').setAttribute('aria-pressed', String(state.dataSaver));
      renderWindow();
      toast(state.dataSaver ? 'Data Saver on · previews hidden' : 'Previews restored');
    });
    $('#signOut').addEventListener('click', forgetDevice);
    $('#copyCurrentLink').addEventListener('click', () =>
      state.currentPost ? copyLink(state.currentPost) : toast('Open a post first')
    );
    $('#sheetOpen').addEventListener('click', () => {
      openExternal(state.sheetPost);
      $('#actionSheet').close();
    });
    $('#sheetCopy').addEventListener('click', () => {
      copyLink(state.sheetPost);
      $('#actionSheet').close();
    });
    $('#sheetFavorite').addEventListener('click', () => {
      toggleFavorite(state.sheetPost);
      $('#actionSheet').close();
    });
    document
      .querySelectorAll('[data-close-dialog]')
      .forEach(button => button.addEventListener('click', () => $('#actionSheet').close()));
    $('#viewerBack').addEventListener('click', closeViewer);
    $('#viewerPrevious').onclick = () => switchMedia(state.currentMediaIndex - 1);
    $('#viewerNext').onclick = () => switchMedia(state.currentMediaIndex + 1);
    $('#viewerCaptionToggle').onclick = () => {
      state.captionExpanded = !state.captionExpanded;
      $('#viewerCaption').classList.toggle('expanded', state.captionExpanded);
      $('#viewerCaptionToggle').textContent = state.captionExpanded ? 'Hide full post text' : 'Show full post text';
    };
    $('#viewer').addEventListener('keydown', event => {
      if (event.defaultPrevented || event.target.closest('video,input,textarea,select') || $('#actionSheet').open)
        return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        switchMedia(state.currentMediaIndex + (event.key === 'ArrowRight' ? 1 : -1));
      }
    });
    $('#actionSheet').addEventListener('close', () => {
      noteVersion++;
      noteBinding = null;
      state.sheetPost = null;
    });
    $('#reconnect').onclick = async () => {
      await refreshSession();
      if (document.documentElement.dataset.connection === 'online') search(true);
    };
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', applyMotion);
    $('#viewerMore').addEventListener('click', () => openSheet(state.currentPost));
    $('#pairRetry').addEventListener('click', retryPair);
    $('#actionSheet').addEventListener('click', event => {
      if (event.target === $('#actionSheet')) $('#actionSheet').close();
    });
    $('#viewer').addEventListener('click', event => {
      if (event.target === $('#viewer')) closeViewer();
    });
    let swipe = null;
    $('#viewerStage').addEventListener(
      'pointerdown',
      event => {
        swipe =
          event.isPrimary && !event.target.closest('video')
            ? {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                post: state.currentPost,
                index: state.currentMediaIndex,
              }
            : null;
      },
      { passive: true }
    );
    $('#viewerStage').addEventListener('pointercancel', () => (swipe = null), { passive: true });
    $('#viewerStage').addEventListener(
      'pointerup',
      event => {
        const start = swipe;
        swipe = null;
        if (
          !start ||
          start.id !== event.pointerId ||
          start.post !== state.currentPost ||
          start.index !== state.currentMediaIndex ||
          event.target.closest('video')
        )
          return;
        const dx = event.clientX - start.x,
          dy = event.clientY - start.y;
        if (Math.abs(dx) >= 70 && Math.abs(dx) > Math.abs(dy) * 1.3) switchMedia(start.index + (dx < 0 ? 1 : -1));
      },
      { passive: true }
    );
    $('#viewer').addEventListener('close', () => {
      closeViewer();
      const target = state.viewerReturn;
      state.viewerReturn = null;
      requestAnimationFrame(() => {
        if (target?.isConnected) target.focus({ preventScroll: true });
        else $('#gallery').focus({ preventScroll: true });
      });
    });
    window.addEventListener(
      'resize',
      () => {
        if (!$('#libraryView').hidden && (state.beforeCount || state.afterCount)) renderWindow();
      },
      { passive: true }
    );
  }

  async function boot() {
    wireEvents();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/remote-sw.js', { scope: '/' }).catch(() => {});
    const token = location.hash.length > 1 ? location.hash.slice(1) : '';
    if (token) return pair(token);
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(PAIR_KEY) || 'null');
    } catch {
      localStorage.removeItem(PAIR_KEY);
    }
    if (saved?.deviceId) {
      try {
        await startApp();
      } catch (error) {
        if (!$('#pairScreen').hidden) return;
        setPairMessage(error.message || 'XVault is unavailable on this Wi-Fi.', true, true);
      }
      return;
    }
    const flow = sessionStorage.getItem('xvault.remote.pair-flow');
    if (flow) return retryPair();
    setPairMessage('Open this page from the pairing QR code in XVault.', false, false);
  }

  boot().catch(error => setPairMessage(error.message || 'XVault Remote could not start.', true, true));
})();
