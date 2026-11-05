// XVault 25/26: the Capture page's inbox panel — the desktop view of sw/capture-inbox.mjs. Links pasted here, sent
// from Phone Remote (paste or Web Share Target) or shared to XVault are listed with their live state; the
// service worker announces every change on the "xvault-capture-inbox" BroadcastChannel.
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const LABEL = {
    queued: 'Queued',
    waiting: 'Waiting',
    capturing: 'Capturing',
    archived: 'Saved',
    duplicate: 'Already saved',
    unavailable: 'Unavailable',
    failed: 'Failed',
  };
  const DONE = new Set(['archived', 'duplicate']);
  const PROBLEM = new Set(['unavailable', 'failed']);
  let data = null,
    timer = 0,
    busy = false;
  const send = message => chrome.runtime.sendMessage(message);
  const esc = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );
  const when = at => {
    const ms = Date.now() - Number(at || 0);
    if (!(at > 0)) return '';
    if (ms < 60e3) return 'just now';
    if (ms < 3600e3) return `${Math.floor(ms / 60e3)} min ago`;
    if (ms < 86400e3) return `${Math.floor(ms / 3600e3)} h ago`;
    return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const origin = item =>
    item.source === 'share'
      ? `Shared from ${item.device || 'a phone'}`
      : item.source === 'remote'
        ? `From ${item.device || 'a phone'}`
        : 'Added here';
  const until = at => {
    const ms = Number(at || 0) - Date.now();
    if (!(ms > 0)) return 'soon';
    if (ms < 60e3) return `in ${Math.max(1, Math.round(ms / 1e3))} s`;
    if (ms < 3600e3) return `in ${Math.round(ms / 60e3)} min`;
    return `at ${new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  };
  const OUTCOME = {
    archived: 'Saved',
    duplicate: 'Already saved',
    unavailable: 'Unavailable',
    auth: 'Sign-in needed',
    'rate-limited': 'X limited requests',
    'x-error': 'X error page',
    pending: 'Did not load in time',
    error: 'Error',
  };
  // XVault 26: the last attempts of one capture — when, what happened and how long it took.
  function attemptLog(item) {
    const log = Array.isArray(item.log) ? item.log : [];
    if (!log.length || DONE.has(item.state)) return '';
    return `<details class="capture-inbox-log"><summary>Attempt history (${log.length})</summary><ol>${log
      .slice()
      .reverse()
      .map(
        entry =>
          `<li><time>${esc(new Date(entry.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }))}</time> ${esc(OUTCOME[entry.outcome] || entry.outcome)}${entry.ms ? ` · ${esc((entry.ms / 1000).toFixed(1))} s` : ''}${entry.detail ? ` · ${esc(entry.detail)}` : ''}</li>`
      )
      .join('')}</ol></details>`;
  }
  function row(item) {
    const preview = item.preview || {};
    const who = preview.name || (item.handle ? `@${item.handle}` : 'X post');
    const reason =
      item.state === 'waiting'
        ? item.error || 'Waiting for an open x.com tab'
        : item.state === 'queued'
          ? item.error || (data?.paused ? 'Inbox paused' : 'Next in line')
          : item.state === 'capturing'
            ? 'Opening the post in a background tab…'
            : PROBLEM.has(item.state)
              ? item.error || 'Capture failed'
              : '';
    const actions = [
      DONE.has(item.state) ? `<button type="button" data-inbox="open" data-id="${esc(item.id)}">Open</button>` : '',
      PROBLEM.has(item.state) || item.state === 'waiting'
        ? `<button type="button" data-inbox="retry" data-id="${esc(item.id)}">Retry</button>`
        : '',
      item.state === 'capturing'
        ? ''
        : `<button type="button" class="quiet" data-inbox="remove" data-id="${esc(item.id)}" aria-label="Remove ${esc(who)} from the inbox">Remove</button>`,
    ].join('');
    return `<li class="capture-inbox-row" data-state="${esc(item.state)}">
      <span class="capture-inbox-chip is-${esc(item.state)}">${esc(LABEL[item.state] || item.state)}</span>
      <div class="capture-inbox-copy">
        <b>${esc(who)}${preview.name && (preview.handle || item.handle) ? ` <small>@${esc(preview.handle || item.handle)}</small>` : ''}</b>
        <p>${esc(preview.text || item.url)}</p>
        <small>${[
          reason,
          item.state === 'queued' && item.nextAttemptAt > Date.now() ? `next try ${until(item.nextAttemptAt)}` : '',
          !DONE.has(item.state) && item.attempts ? `attempt ${item.attempts} of ${item.maxAttempts || 3}` : '',
          preview.mediaCount ? `${preview.mediaCount} media` : '',
          origin(item),
          when(item.updatedAt || item.createdAt),
        ]
          .filter(Boolean)
          .map(esc)
          .join(' · ')}</small>
        ${attemptLog(item)}
      </div>
      <div class="capture-inbox-actions">${actions}</div>
    </li>`;
  }
  function render() {
    const list = $('captureInboxList');
    if (!list || !data) return;
    const counts = data.counts || {};
    const problems = (counts.unavailable || 0) + (counts.failed || 0);
    const finished = (counts.archived || 0) + (counts.duplicate || 0) + problems;
    const state = $('captureInboxState');
    const cooling = data.cooldownUntil > Date.now(),
      blocked = !!data.authBlocked && data.pending > 0;
    state.textContent = data.paused
      ? 'Paused'
      : blocked
        ? 'Sign-in needed'
        : cooling
          ? 'Cooling down'
          : data.pending
            ? `${data.pending} in progress`
            : 'Idle';
    state.dataset.tone = data.paused || blocked || cooling ? 'warn' : data.pending ? 'busy' : '';
    // XVault 26: one plain-language banner for whatever holds the whole inbox.
    const notice = $('captureInboxNotice');
    if (notice) {
      const message = blocked
        ? 'X is asking you to sign in. Sign in to x.com in this browser, then choose Resume — no attempts were used.'
        : cooling
          ? `X is limiting requests, so captures wait until the cooldown ends (${until(data.cooldownUntil)}). Nothing is lost.`
          : '';
      notice.hidden = !message;
      notice.textContent = message;
      $('captureInboxResume').hidden = !(blocked || cooling);
      notice.parentElement?.toggleAttribute('hidden', !message);
    }
    // Progress through the current batch: finished items over everything still listed as part of it.
    const bar = $('captureInboxProgress');
    if (bar) {
      const total = data.pending + finished;
      bar.hidden = !data.pending;
      bar.max = Math.max(1, total);
      bar.value = finished;
      bar.setAttribute('aria-label', `${finished} of ${total} captures finished`);
    }
    $('captureInboxSummary').textContent = data.items.length
      ? `${data.items.length} link${data.items.length === 1 ? '' : 's'} · ${(counts.archived || 0) + (counts.duplicate || 0)} saved${problems ? ` · ${problems} need attention` : ''}`
      : '';
    $('captureInboxPause').textContent = data.paused ? 'Resume' : 'Pause';
    $('captureInboxRetry').hidden = !problems;
    $('captureInboxClear').hidden = !finished;
    list.innerHTML = data.items.length
      ? data.items.slice(0, 60).map(row).join('')
      : '<li class="capture-inbox-empty">No links yet. Paste one above, or send posts from Phone Remote → Capture.</li>';
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const result = await send({ type: 'CAPTURE_INBOX_LIST' });
      if (result && result.ok !== false) {
        data = { items: [], ...result };
        render();
      }
    } catch {
      /* the service worker restarts; the next broadcast or visibility change refreshes */
    } finally {
      busy = false;
    }
  }
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  };
  async function control(action, id = '') {
    try {
      const result = await send({ type: 'CAPTURE_INBOX_CONTROL', action, id });
      if (result && result.ok !== false && Array.isArray(result.items)) {
        data = { ...data, ...result };
        render();
      } else soon();
    } catch (error) {
      window.toast?.(error.message || 'The inbox could not be updated');
    }
  }
  function init() {
    const form = $('captureInboxForm');
    if (!form) return;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const input = $('captureInboxInput');
      const text = input.value.trim();
      if (!text) return input.focus();
      try {
        const result = await send({ type: 'CAPTURE_INBOX_ADD', text });
        if (result?.ok === false) throw Error(result.error || 'No X post link found');
        const added = Array.isArray(result?.added) ? result.added.length : 0;
        input.value = '';
        window.toast?.(added === 1 ? 'Added to the capture inbox' : `${added} links added to the capture inbox`);
      } catch (error) {
        window.toast?.(error.message || 'No X post link found');
      }
      soon();
    });
    $('captureInboxPause').addEventListener('click', () => control(data?.paused ? 'resume' : 'pause'));
    $('captureInboxRetry').addEventListener('click', () => control('retry-all'));
    $('captureInboxClear').addEventListener('click', () => control('clear'));
    $('captureInboxResume')?.addEventListener('click', () => control('resume'));
    // Countdowns ("next try in 40 s", the cooldown) stay current while the page is visible.
    setInterval(() => {
      if (document.hidden || !data || !(data.pending > 0)) return;
      if (!document.getElementById('captureInboxPanel')?.offsetParent) return;
      render();
    }, 15000);
    $('captureInboxList').addEventListener('click', event => {
      const button = event.target.closest('[data-inbox]');
      if (!button) return;
      if (button.dataset.inbox === 'open') {
        if (window.XVaultReader?.open) window.XVaultReader.open(button.dataset.id);
        return;
      }
      void control(button.dataset.inbox, button.dataset.id);
    });
    try {
      new BroadcastChannel('xvault-capture-inbox').onmessage = soon;
    } catch {}
    document.addEventListener('visibilitychange', () => !document.hidden && soon());
    void refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
