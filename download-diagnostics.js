/* Downloads › Download decisions: a readable view of the queue's accept/skip log. */
(() => {
  const $ = selector => document.querySelector(selector);
  const LABEL = {
    new: 'Queued',
    'new-for-post': 'Queued (same file exists for another post)',
    'in-flight': 'Skipped: already in progress',
    'already-downloaded': 'Skipped: already downloaded',
    'same-request': 'Skipped: listed twice in one request',
    'explicit-redownload': 'Queued: redownload you asked for',
    'keep-both': 'Queued: second copy (duplicate skipping is off)',
    'retry-failed': 'Queued: retry of a failed download',
    'same-asset-other-post': 'Skipped: file saved for another post',
    'same-bytes': 'Skipped: identical content',
    filtered: 'Filtered by your rules',
  };
  LABEL['multiple-installations'] = 'Blocked: competing XVault copies';
  LABEL['browser-existing'] = 'Reused retained browser file';
  LABEL['foreign-download'] = 'Blocked: another installation owns this file';
  LABEL['target-collision'] = 'Blocked: target filename already recorded';
  LABEL['start-preflight'] = 'Browser file check';
  LABEL['derivatives-only'] = 'Queued: derivatives from a saved original';
  LABEL['asset-check-limit'] = 'Blocked: Save Once check reached its safety limit';
  LABEL['asset-index-building'] = 'Blocked: Save Once index is building';
  LABEL['hash-check-limit'] = 'Blocked: hash check reached its safety limit';
  let rows = [],
    generation = 0;
  const visibleRows = () => {
    const query = ($('#decisionSearch')?.value || '').trim().toLowerCase(),
      outcome = $('#decisionOutcome')?.value || 'all';
    return rows.filter(
      row =>
        (outcome === 'all' || row.outcome === outcome) &&
        (!query ||
          text(row).toLowerCase().includes(query) ||
          String(row.reason || '')
            .toLowerCase()
            .includes(query))
    );
  };
  const text = row =>
    `${new Date(row.at).toLocaleTimeString()}  ${row.source}  installation ${row.installationId || 'unknown'}  browser ${row.browserPresence || 'not-checked'}  post ${row.tweetId || '?'}  ${row.asset}  →  ${LABEL[row.code] || row.code}${row.matchKey ? `  (matches ${row.matchKey})` : ''}`;
  function render() {
    const list = $('#decisionList');
    if (!list) return;
    const visible = visibleRows();
    $('#decisionCount').textContent = rows.length ? `${visible.length} / ${rows.length}` : '';
    if (!visible.length) {
      list.innerHTML = `<div class="empty">${rows.length ? 'No decisions match these filters.' : 'No recorded download requests in this browser session.'}</div>`;
      return;
    }
    list.replaceChildren(
      ...visible.map(row => {
        const item = document.createElement('div');
        item.className = 'decision';
        item.dataset.outcome = row.outcome;
        const head = document.createElement('b');
        head.textContent = LABEL[row.code] || row.code;
        const meta = document.createElement('small');
        meta.textContent = `${new Date(row.at).toLocaleTimeString()} · from ${row.source} · post ${row.tweetId || '?'} · ${row.asset}`;
        const why = document.createElement('span');
        why.textContent =
          row.reason + (row.matchKey ? ` Matches ${row.matchKey} (${row.matchState || 'unknown'}).` : '');
        item.append(head, meta, why);
        return item;
      })
    );
  }
  async function load() {
    const current = ++generation;
    $('#decisionState').textContent = 'Reading recent download decisions…';
    try {
      const [decisions, queue] = await Promise.allSettled([
        chrome.runtime.sendMessage({ type: 'GET_DOWNLOAD_DECISIONS', limit: 200 }),
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_QUEUE_STATS' }),
      ]);
      if (current !== generation) return;
      if (decisions.status !== 'fulfilled' || !decisions.value?.ok)
        throw Error(decisions.reason?.message || decisions.value?.error || 'Download decisions are unavailable');
      rows = decisions.value.rows || [];
      render();
      $('#decisionState').textContent =
        'Recent requests in this browser session · signatures and query parameters are omitted.';
      const status = $('#decisionQueueState');
      if (status) {
        if (queue.status !== 'fulfilled' || !queue.value?.ok)
          status.textContent = 'Queue bookkeeping details are unavailable.';
        else {
          const state = queue.value.bookkeeping || {},
            recovery = state.lastRecovery || {},
            assetIndex = state.assetLookupIndex || {},
            indexLabel = assetIndex.complete
              ? 'Save Once index ready'
              : `Save Once index building · ${Number(assetIndex.processed || 0).toLocaleString()} records${assetIndex.error ? ` · ${assetIndex.error}` : ''}`;
          status.textContent = state.pumpFailure
            ? `Queue worker needs attention: ${state.pumpFailure.reason} · ${state.queuedRowsBuffered || 0}/${state.queueBufferLimit || 0} rows buffered.`
            : `Persisted backlog ${queue.value.countsReady ? queue.value.queued : 'rebuilding'} · ${state.queuedRowsBuffered || 0}/${state.queueBufferLimit || 0} buffered · ${indexLabel} · recovery read ${recovery.recordsRead || 0} rows in ${recovery.pages || 0} pages.`;
        }
      }
    } catch (error) {
      if (current === generation)
        $('#decisionState').textContent =
          `Could not read decisions: ${error.message}. Your previous view is retained. Try Refresh.`;
    }
  }
  function mount() {
    $('#downloadDecisions')?.addEventListener('toggle', event => {
      if (event.target.open) load();
    });
    $('#decisionsRefresh')?.addEventListener('click', load);
    $('#decisionSearch')?.addEventListener('input', render);
    $('#decisionOutcome')?.addEventListener('change', render);
    $('#decisionsCopy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(visibleRows().map(text).join('\n'));
        toast('Visible decisions copied');
      } catch {
        toast('Clipboard access failed');
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
