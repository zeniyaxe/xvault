// XVault 25 — Phone Remote "Capture": send X post links from this phone to the capture inbox on the computer.
// Links arrive by paste, the Paste button, or the Web Share Target (/share?url=…, installed app on Android).
// The computer opens each post in one background X tab and archives it; this view shows the live inbox.
// Links that cannot reach the computer wait in a small on-phone outbox and are sent when XVault is reachable.
(() => {
  'use strict';
  const OUTBOX_KEY = 'xvault.remote.capture-outbox.v1';
  const SHARE_KEY = 'xvault.remote.share.v1';
  const MAX_OUTBOX = 50;
  const MAX_LINKS = 20;
  const HOSTS = /^(?:www\.|mobile\.|m\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx|twittpr)\.com$/i;
  const BARE = /(^|[\s(])((?:www\.|mobile\.|m\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx|twittpr)\.com\/\S+)/gi;
  const RESERVED = new Set(['i', 'home', 'search', 'explore', 'settings', 'notifications', 'messages']);
  const PENDING = new Set(['queued', 'waiting', 'capturing']);
  const DONE = new Set(['archived', 'duplicate']);
  const PROBLEM = new Set(['unavailable', 'failed']);
  const LABEL = {
    queued: 'Queued',
    waiting: 'Waiting',
    capturing: 'Capturing',
    archived: 'Saved',
    duplicate: 'Already saved',
    unavailable: 'Unavailable',
    failed: 'Failed',
  };
  const ICON = {
    queued: 'hourglass',
    waiting: 'clock',
    capturing: 'capture',
    archived: 'check',
    duplicate: 'check',
    unavailable: 'alert',
    failed: 'alert',
  };
  const $ = selector => document.querySelector(selector);
  let api = null;
  const view = {
    items: [],
    counts: {},
    pending: 0,
    paused: false,
    filter: 'all',
    timer: 0,
    busy: false,
    loaded: false,
    sending: false,
    denied: false,
    offline: false,
    fresh: new Set(),
    flushing: false,
  };

  // ── link parsing (mirrors sw/capture-inbox.mjs; the computer parses again) ──
  function parseUrl(input) {
    let url;
    try {
      url = new URL(String(input || '').trim());
    } catch {
      return null;
    }
    if (!/^https?:$/.test(url.protocol) || !HOSTS.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const at = parts.findIndex(part => part === 'status' || part === 'statuses');
    if (at < 0 || !/^\d{1,25}$/.test(parts[at + 1] || '')) return null;
    const id = String(BigInt(parts[at + 1]));
    const before = parts.slice(0, at);
    let handle = '';
    if (before.length === 1 && /^[A-Za-z0-9_]{1,15}$/.test(before[0]) && !RESERVED.has(before[0].toLowerCase()))
      handle = before[0];
    else if (!(before.length === 0 || (before[0] === 'i' && (before.length === 1 || before[1] === 'web')))) return null;
    return { id, handle, url: `https://x.com/${handle || 'i'}/status/${id}` };
  }
  function parseText(text, limit = MAX_LINKS) {
    const normalised = String(text || '').replace(BARE, (all, lead, link) => `${lead}https://${link}`);
    const found = new Map();
    for (const match of normalised.matchAll(/https?:\/\/[^\s<>"'()]+/gi)) {
      const parsed = parseUrl(match[0].replace(/[.,;:!?]+$/, ''));
      if (parsed && !found.has(parsed.id)) found.set(parsed.id, parsed);
      if (found.size >= limit) break;
    }
    return [...found.values()];
  }

  // ── on-phone outbox (only link text; nothing from the archive) ──
  function readOutbox() {
    try {
      const rows = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
      return Array.isArray(rows) ? rows.filter(row => parseUrl(row?.url)).slice(0, MAX_OUTBOX) : [];
    } catch {
      return [];
    }
  }
  function writeOutbox(rows) {
    try {
      if (rows.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(rows.slice(0, MAX_OUTBOX)));
      else localStorage.removeItem(OUTBOX_KEY);
    } catch {}
    renderOutbox();
  }
  function keepOffline(links, via) {
    const rows = readOutbox();
    const known = new Set(rows.map(row => parseUrl(row.url)?.id));
    for (const link of links) if (!known.has(link.id)) rows.push({ url: link.url, via, at: Date.now() });
    writeOutbox(rows);
  }
  function renderOutbox() {
    const box = $('#captureOutbox');
    if (!box) return;
    const rows = readOutbox();
    box.hidden = !rows.length;
    if (!rows.length) return box.replaceChildren();
    const icon = api.makeIcon('wifi-off');
    const copy = api.el('div', 'capture-outbox-copy');
    copy.append(
      api.el(
        'b',
        '',
        rows.length === 1 ? '1 link waiting on this phone' : `${rows.length} links waiting on this phone`
      ),
      api.el(
        'small',
        '',
        (() => {
          const last = rows.reduce((max, row) => Math.max(max, Number(row.lastTry) || 0), 0);
          const error = rows.find(row => row.lastError)?.lastError;
          return last
            ? `Sent automatically when your computer is reachable · last try ${api.relativeTime(last) === 'now' ? 'just now' : `${api.relativeTime(last)} ago`}${error ? ` (${error.toLowerCase()})` : ''}`
            : 'Sent automatically when your computer is reachable.';
        })()
      )
    );
    const retry = api.el('button', 'ghost-button small', 'Send now');
    retry.type = 'button';
    retry.addEventListener('click', () => void flushOutbox(true));
    const drop = api.el('button', 'icon-button', '');
    drop.type = 'button';
    drop.setAttribute('aria-label', 'Discard waiting links');
    drop.append(api.makeIcon('close'));
    drop.addEventListener('click', () => {
      writeOutbox([]);
      api.toast('Waiting links discarded');
    });
    box.replaceChildren(icon, copy, retry, drop);
  }

  // ── sending ──
  function setNotice(message = '', tone = '') {
    const notice = $('#captureNotice');
    if (!notice) return;
    notice.hidden = !message;
    notice.dataset.tone = tone;
    notice.textContent = message;
  }
  const isNetwork = error => error instanceof TypeError || error?.name === 'TypeError';
  async function send(links, via = 'paste') {
    if (!links.length) {
      updateComposer('No X post link found. Paste a link like x.com/name/status/123.', true);
      return false;
    }
    if (!api.hasPermission('capture.create')) {
      setNotice(
        'This phone may not send posts yet. On your computer open XVault → Phone Remote, choose this phone and turn on “Send posts to capture”.',
        'warn'
      );
      keepOffline(links, via);
      return false;
    }
    view.sending = true;
    updateComposer();
    let sent = 0,
      duplicates = 0;
    const offline = [],
      refused = [];
    let limited = false;
    for (const [index, link] of links.entries()) {
      if (limited) {
        offline.push(link);
        continue;
      }
      try {
        const result = await api.request('/api/capture', { url: link.url, via });
        apply(result, false);
        sent++;
        view.fresh.add(link.id);
        if (result.added?.[0]?.duplicate) duplicates++;
      } catch (error) {
        if (isNetwork(error)) offline.push(...links.slice(index));
        else if (error.status === 429) {
          limited = true;
          offline.push(link);
        } else if (error.status === 403) {
          refused.push(link);
          view.denied = true;
        } else refused.push({ ...link, error: error.message });
        if (isNetwork(error)) break;
      }
    }
    view.sending = false;
    if (offline.length) {
      keepOffline(offline, via);
      if (!limited) view.offline = true;
      retryOutboxLater();
    }
    if (sent) render();
    if (sent && !offline.length && !refused.length) {
      setNotice('');
      api.toast(
        sent === 1
          ? duplicates
            ? 'Already in your Library'
            : 'Saved to XVault — your computer is capturing it'
          : `${sent} links sent to XVault`
      );
    } else if (offline.length) {
      // Unreachable: the outbox card says it all; pacing needs its own explanation.
      setNotice(
        limited ? 'XVault is pacing links from this phone. The rest are kept here and sent in a few minutes.' : '',
        'warn'
      );
      render();
    } else if (refused.length)
      setNotice(refused[0].error || 'XVault did not accept this link. Check it opens a single post on X.', 'error');
    updateComposer();
    schedule();
    return offline.length === 0 && refused.length === 0;
  }
  // XVault 26: the outbox is safe to flush from several tabs and while new links arrive. Sending is idempotent on
  // the computer (one inbox item per post id), so a link sent twice by a race is answered as already queued; the
  // outbox itself is re-read before it is written so a link added mid-flush is never lost. A computer that stays
  // unreachable is retried with a backoff (5 s doubling to 2 min) while the page is visible.
  const outboxRetry = { timer: 0, delay: 0 };
  function retryOutboxLater() {
    clearTimeout(outboxRetry.timer);
    outboxRetry.timer = 0;
    if (!readOutbox().length || document.hidden) return;
    outboxRetry.delay = Math.min(120000, outboxRetry.delay ? outboxRetry.delay * 2 : 5000);
    outboxRetry.timer = setTimeout(() => void flushOutbox(), outboxRetry.delay);
  }
  async function flushOutbox(manual = false) {
    if (view.flushing || !api?.hasPermission('capture.create')) return;
    const rows = readOutbox();
    if (!rows.length) return;
    view.flushing = true;
    clearTimeout(outboxRetry.timer);
    const done = new Set(),
      tried = new Map(),
      refused = [];
    let sent = 0,
      blocked = false;
    for (const row of rows) {
      const id = parseUrl(row.url)?.id;
      try {
        apply(await api.request('/api/capture', { url: row.url, via: row.via === 'share' ? 'share' : 'paste' }), false);
        sent++;
        done.add(id);
      } catch (error) {
        if (isNetwork(error) || error.status === 429 || error.status === 403 || error.status >= 500) {
          tried.set(id, isNetwork(error) ? 'Computer unreachable' : error.message || `HTTP ${error.status}`);
          blocked = true;
          break;
        }
        // A link the computer refuses for good is dropped rather than retried forever — but the phone says so.
        done.add(id);
        refused.push(error.message || 'XVault did not accept this link');
      }
    }
    view.flushing = false;
    const at = Date.now();
    writeOutbox(
      readOutbox()
        .filter(row => !done.has(parseUrl(row.url)?.id))
        .map(row => {
          const id = parseUrl(row.url)?.id;
          return tried.has(id)
            ? { ...row, tries: (Number(row.tries) || 0) + 1, lastTry: at, lastError: tried.get(id) }
            : row;
        })
    );
    if (blocked) retryOutboxLater();
    else outboxRetry.delay = 0;
    if (sent) {
      render();
      api.toast(sent === 1 ? 'Waiting link sent to XVault' : `${sent} waiting links sent to XVault`);
      if (!readOutbox().length) setNotice('');
    } else if (manual && blocked) api.toast('Still cannot reach XVault — trying again shortly');
    if (refused.length)
      setNotice(
        refused.length === 1
          ? `A waiting link was not accepted: ${refused[0]}`
          : `${refused.length} waiting links were not accepted (${refused[0]}).`,
        'error'
      );
  }

  // ── inbox ──
  function apply(result, paint = true) {
    if (!result || typeof result !== 'object') return;
    view.items = Array.isArray(result.items) ? result.items : [];
    view.counts = result.counts || {};
    view.pending = Number(result.pending) || 0;
    view.paused = result.paused === true;
    view.cooldownUntil = Number(result.cooldownUntil) || 0;
    view.authBlocked = result.authBlocked === true;
    view.loaded = true;
    view.denied = false;
    view.offline = false;
    updateBadge();
    if (paint) render();
  }
  async function load(quiet = false) {
    if (!api || view.busy) return;
    if (!api.hasPermission('capture.create')) {
      view.denied = true;
      // Drawn when the view opens (show() renders); not on every start-up while the tab is hidden.
      if (visible()) render();
      return;
    }
    view.busy = true;
    try {
      apply(await api.request('/api/capture'));
      void flushOutbox();
    } catch (error) {
      if (error.status === 403) view.denied = true;
      else view.offline = true;
      if (!quiet || !view.loaded) render();
    } finally {
      view.busy = false;
      schedule();
    }
  }
  function visible() {
    return !document.hidden && !$('#app')?.hidden && $('#captureView') && !$('#captureView').hidden;
  }
  function schedule() {
    clearTimeout(view.timer);
    view.timer = 0;
    if (document.hidden || !api?.hasPermission('capture.create')) return;
    // Fast while something is being captured and the view is open; slow in the background for the tab badge.
    const delay = visible() ? (view.pending ? 2500 : 12000) : view.pending ? 8000 : 0;
    if (delay) view.timer = setTimeout(() => load(true), delay);
  }
  function updateBadge() {
    const badge = $('#navCaptureBadge');
    if (!badge) return;
    const count = view.pending + readOutbox().length;
    badge.hidden = !count;
    badge.textContent = count > 9 ? '9+' : count ? String(count) : '';
  }
  function filtered() {
    if (view.filter === 'pending') return view.items.filter(item => PENDING.has(item.state));
    if (view.filter === 'done') return view.items.filter(item => DONE.has(item.state));
    if (view.filter === 'problem') return view.items.filter(item => PROBLEM.has(item.state));
    return view.items;
  }
  function itemTitle(item) {
    const preview = item.preview || {};
    return preview.name || (item.handle ? `@${item.handle}` : preview.handle ? `@${preview.handle}` : 'X post');
  }
  function stateLine(item) {
    if (item.state === 'waiting') return item.error || 'Waiting for an X tab on your computer';
    if (item.state === 'capturing') return 'Opening the post on your computer…';
    if (item.state === 'queued') return item.error || (view.paused ? 'Inbox paused on your computer' : 'Next in line');
    if (item.state === 'duplicate') return 'Already in your Library';
    if (item.state === 'archived') return 'Archived';
    return item.error || (item.state === 'unavailable' ? 'X shows this post as unavailable' : 'Capture failed');
  }
  function actionButton(icon, label, action, id, className = 'icon-button') {
    const button = api.el('button', className, '');
    button.type = 'button';
    button.dataset.captureAction = action;
    button.dataset.id = id;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(api.makeIcon(icon));
    return button;
  }
  function renderItem(item) {
    const row = api.el('li', 'capture-item');
    row.dataset.state = item.state;
    row.dataset.id = item.id;
    if (view.fresh.has(item.id)) row.classList.add('is-new');
    const handle = item.preview?.handle || item.handle || '';
    row.append(api.makeAvatar(item.preview?.name || handle, handle, 'sm'));
    const body = api.el('div', 'capture-copy');
    const head = api.el('div', 'capture-head');
    head.append(api.el('b', 'capture-name', itemTitle(item)));
    if (handle && item.preview?.name) head.append(api.el('span', 'capture-handle', `@${handle}`));
    head.append(api.el('time', 'capture-time', api.relativeTime(item.updatedAt || item.createdAt)));
    body.append(head);
    const text = item.preview?.text || '';
    body.append(api.el('p', `capture-text${text ? '' : ' is-link'}`, text || item.url.replace(/^https:\/\//, '')));
    const meta = api.el('div', 'capture-meta');
    const chip = api.el('span', `capture-state is-${item.state}`);
    chip.append(api.makeIcon(ICON[item.state] || 'info'), api.el('span', '', LABEL[item.state] || 'Queued'));
    const facts = [];
    if (!DONE.has(item.state)) facts.push(stateLine(item));
    // XVault 26: when the next try happens and how many the computer allows.
    if (item.state === 'queued' && item.nextAttemptAt > Date.now())
      facts.push(`next try in ${Math.max(1, Math.round((item.nextAttemptAt - Date.now()) / 60000))} min`);
    if (!DONE.has(item.state) && item.attempts) facts.push(`attempt ${item.attempts} of ${item.maxAttempts || 3}`);
    if (item.preview?.mediaCount)
      facts.push(
        item.preview.video
          ? item.preview.mediaCount === 1
            ? 'video'
            : `${item.preview.mediaCount} media with video`
          : `${item.preview.mediaCount} media`
      );
    facts.push(
      item.mine
        ? 'from this phone'
        : item.source === 'desktop'
          ? 'from the computer'
          : `from ${item.device || 'another phone'}`
    );
    meta.append(chip, api.el('span', 'capture-reason', facts.join(' · ')));
    const foot = api.el('div', 'capture-foot');
    const actions = api.el('div', 'capture-row-actions');
    foot.append(meta, actions);
    body.append(foot);
    if (DONE.has(item.state) && api.hasPermission('library.read'))
      actions.append(actionButton('library', 'Show in Library', 'open', item.id));
    if (PROBLEM.has(item.state) || item.state === 'waiting')
      actions.append(actionButton('retry', 'Try again', 'retry', item.id));
    actions.append(actionButton('external', 'Open on X', 'x', item.id));
    if (item.state !== 'capturing')
      actions.append(
        actionButton('close', PENDING.has(item.state) ? 'Cancel' : 'Remove from inbox', 'remove', item.id)
      );
    row.append(body);
    if (item.state === 'capturing') row.append(api.el('i', 'capture-progress'));
    return row;
  }
  function renderEmpty(list, title, message, icon = 'inbox') {
    const empty = api.el('li', 'capture-empty');
    const badge = api.el('span', 'capture-empty-icon');
    badge.append(api.makeIcon(icon));
    empty.append(badge, api.el('b', '', title), api.el('p', '', message));
    list.replaceChildren(empty);
  }
  function render() {
    const list = $('#captureList');
    if (!list || !api) return;
    renderOutbox();
    for (const button of document.querySelectorAll('[data-capture-filter]')) {
      const key = button.dataset.captureFilter;
      button.setAttribute('aria-pressed', String(key === view.filter));
      const count =
        key === 'all'
          ? view.items.length
          : key === 'pending'
            ? view.pending
            : key === 'done'
              ? (view.counts.archived || 0) + (view.counts.duplicate || 0)
              : (view.counts.unavailable || 0) + (view.counts.failed || 0);
      button.dataset.count = count ? String(count) : '';
    }
    const updated = $('#captureUpdated');
    if (updated)
      updated.textContent = view.offline
        ? 'Offline'
        : view.paused
          ? 'Paused on computer'
          : view.authBlocked && view.pending
            ? 'Sign-in needed on computer'
            : view.cooldownUntil > Date.now()
              ? 'X cooldown — waiting'
              : view.pending
                ? `${view.pending} in progress`
                : view.loaded
                  ? 'Up to date'
                  : '';
    if (view.denied) {
      renderEmpty(
        list,
        'Capture is off for this phone',
        'On your computer open XVault → Phone Remote, choose this phone and turn on “Send posts to capture”. Links you paste meanwhile wait here.',
        'lock'
      );
    } else if (view.offline && !view.items.length) {
      renderEmpty(
        list,
        'Computer unreachable',
        'Links you paste are kept on this phone until XVault is back.',
        'wifi-off'
      );
    } else if (!view.loaded) {
      list.replaceChildren(api.el('li', 'capture-skeleton'), api.el('li', 'capture-skeleton'));
    } else {
      const rows = filtered();
      if (!rows.length)
        renderEmpty(
          list,
          view.items.length ? 'Nothing in this filter' : 'Your inbox is empty',
          view.items.length
            ? 'Switch to All to see every link.'
            : 'Paste a link above, or share a post from the X app to XVault. Your computer archives it in the background.'
        );
      else list.replaceChildren(...rows.map(renderItem));
    }
    const problems = (view.counts.unavailable || 0) + (view.counts.failed || 0);
    const finished = (view.counts.archived || 0) + (view.counts.duplicate || 0) + problems;
    $('#captureRetryAll').hidden = !problems || view.denied;
    $('#captureClearDone').hidden = !finished || view.denied;
    view.fresh.clear();
  }
  async function control(action, id = '') {
    try {
      apply(await api.request('/api/capture/control', id ? { action, id } : { action }));
      if (action === 'retry' || action === 'retry-all') api.toast('Trying again on your computer');
      if (action === 'clear') api.toast('Finished links cleared');
    } catch (error) {
      api.toast(error.message || 'XVault could not update the inbox');
    }
    schedule();
  }

  // ── composer ──
  function updateComposer(message = '', error = false) {
    const input = $('#captureInput');
    if (!input) return;
    const links = parseText(input.value);
    const send = $('#captureSend');
    send.disabled = view.sending || !links.length;
    send.setAttribute('aria-busy', String(view.sending));
    $('#captureSendLabel').textContent = view.sending
      ? 'Sending…'
      : links.length > 1
        ? `Save ${links.length} posts`
        : 'Save to XVault';
    $('#captureClear').hidden = !input.value;
    const hint = $('#captureHint');
    hint.dataset.tone = error ? 'error' : links.length ? 'ok' : '';
    hint.textContent =
      message ||
      (links.length
        ? links.length === 1
          ? `Ready: ${links[0].handle ? `@${links[0].handle}` : 'post'} · ${links[0].id}`
          : `${links.length} posts ready${links.length >= MAX_LINKS ? ` (first ${MAX_LINKS})` : ''}`
        : input.value.trim()
          ? 'No X post link found yet. Links look like x.com/name/status/123.'
          : 'x.com, twitter.com and fxtwitter/vxtwitter links work. Paste several at once.');
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight)}px`;
  }
  async function pasteFromClipboard() {
    const input = $('#captureInput');
    if (!navigator.clipboard?.readText) {
      input.focus();
      updateComposer('Long-press the box and choose Paste.');
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return updateComposer('The clipboard is empty. In X tap Share → Copy link first.', true);
      input.value = input.value.trim() ? `${input.value.trim()}\n${text.trim()}` : text.trim();
      updateComposer();
      if (parseText(input.value).length) $('#captureSend').focus();
    } catch {
      input.focus();
      updateComposer('This browser blocked clipboard access. Long-press the box and choose Paste.');
    }
  }
  async function submit(event) {
    event?.preventDefault();
    const input = $('#captureInput');
    const links = parseText(input.value);
    if (await send(links, 'paste')) {
      input.value = '';
      updateComposer();
    } else if (
      readOutbox().length &&
      links.every(link => readOutbox().some(row => parseUrl(row.url)?.id === link.id))
    ) {
      input.value = '';
      updateComposer();
    }
  }

  // ── Web Share Target: /share?url=&text=&title= ──
  function takeShare() {
    if (!/^\/share\/?$/.test(location.pathname)) return null;
    const params = new URLSearchParams(location.search);
    const text = ['url', 'text', 'title']
      .map(key => params.get(key) || '')
      .join(' ')
      .trim();
    history.replaceState(null, '', '/');
    try {
      sessionStorage.setItem(SHARE_KEY, JSON.stringify({ text: text.slice(0, 4000) }));
    } catch {}
    return text;
  }
  async function handleShare() {
    let shared = null;
    try {
      shared = JSON.parse(sessionStorage.getItem(SHARE_KEY) || 'null');
      sessionStorage.removeItem(SHARE_KEY);
    } catch {}
    if (!shared) return;
    api.showView('captureView');
    const text = String(shared.text || '');
    if (!text) {
      // The home-screen shortcut opens Capture ready for a paste.
      $('#captureInput').focus();
      return;
    }
    const links = parseText(text);
    if (!links.length) {
      $('#captureInput').value = text.trim().slice(0, 600);
      updateComposer('That share did not include an X post link.', true);
      return;
    }
    await send(links, 'share');
  }

  function wire() {
    const input = $('#captureInput');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    input.addEventListener('input', () => updateComposer());
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        if (!$('#captureSend').disabled) void submit();
      }
    });
    $('#captureForm').addEventListener('submit', submit);
    $('#capturePaste').addEventListener('click', () => void pasteFromClipboard());
    $('#captureClear').addEventListener('click', () => {
      input.value = '';
      updateComposer();
      input.focus();
    });
    for (const button of document.querySelectorAll('[data-capture-filter]'))
      button.addEventListener('click', () => {
        view.filter = button.dataset.captureFilter;
        render();
      });
    $('#captureRetryAll').addEventListener('click', () => void control('retry-all'));
    $('#captureClearDone').addEventListener('click', () => void control('clear'));
    $('#captureList').addEventListener('click', event => {
      const button = event.target.closest('[data-capture-action]');
      if (!button) return;
      const item = view.items.find(row => row.id === button.dataset.id);
      if (!item) return;
      const action = button.dataset.captureAction;
      if (action === 'open') api.applySearchQuery(`id:${item.id}`);
      else if (action === 'x') window.open(item.url, '_blank', 'noopener,noreferrer');
      else void control(action, item.id);
    });
    addEventListener('online', () => void flushOutbox());
    addEventListener('xvault-remote-reconnected', () => void flushOutbox());
    // Another tab of the Remote changed the outbox (sent it, or kept a new link).
    addEventListener('storage', event => {
      if (event.key !== OUTBOX_KEY) return;
      renderOutbox();
      updateBadge();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return schedule();
      void load(true);
    });
    updateComposer();
  }

  window.XVaultCapture = {
    parseText,
    takeShare,
    attach(remote) {
      api = remote;
      wire();
      renderOutbox();
      updateBadge();
    },
    async started() {
      if (!api) return;
      await handleShare();
      void load(true);
    },
    show() {
      render();
      void load();
    },
    hide() {
      schedule();
    },
    permissionsChanged() {
      if (!api) return;
      view.denied = !api.hasPermission('capture.create');
      if (!view.denied) void load(true);
      else render();
    },
    reset() {
      clearTimeout(view.timer);
      Object.assign(view, { items: [], counts: {}, pending: 0, loaded: false, denied: false, offline: false });
      updateBadge();
      render();
    },
  };
})();
