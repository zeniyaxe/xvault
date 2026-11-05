// XVault 25: the Capture page's inbox panel — the desktop view of sw/capture-inbox.mjs. Links pasted here, sent
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
          preview.mediaCount ? `${preview.mediaCount} media` : '',
          origin(item),
          when(item.updatedAt || item.createdAt),
        ]
          .filter(Boolean)
          .map(esc)
          .join(' · ')}</small>
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
    state.textContent = data.paused ? 'Paused' : data.pending ? `${data.pending} in progress` : 'Idle';
    state.dataset.tone = data.paused ? 'warn' : data.pending ? 'busy' : '';
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
