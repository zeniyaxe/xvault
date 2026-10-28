/* Capture › Overview: a small, independent cursor page for the newest posts. */
(() => {
  const $ = selector => document.querySelector(selector);
  const basePage = page;
  let timer = 0, latestRows = [], latestLoaded = false, latestDirty = true, latestRequest = 0, latestPending = null;

  function thumb(post) {
    const first = (post.media || [])[0];
    let source = first?.preview || (first?.type === 'photo' ? first.url : '');
    try {
      const url = new URL(source);
      if (url.hostname === 'pbs.twimg.com') { url.searchParams.set('name', 'small'); source = url.href; }
    } catch {}
    return source;
  }

  function render() {
    const target = $('#homeRecent');
    if (!target) return;
    const rows = latestRows;
    if (!rows.length) {
      target.innerHTML = latestLoaded
        ? '<div class="empty">Nothing has been archived yet. Open Library to browse or start a capture.</div>'
        : '<div class="empty" role="status">Loading the latest archived posts…</div>';
      return;
    }
    target.replaceChildren(...rows.map(post => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'recent-tile';
      button.dataset.handle = `@${post.author?.handle || 'unknown'}`;
      button.setAttribute('aria-label', `Open post by @${post.author?.handle || 'unknown'}`);
      const source = thumb(post);
      if (source) {
        const image = document.createElement('img');
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.src = source;
        button.append(image);
      } else {
        const text = document.createElement('span');
        text.textContent = (post.text || 'No text').slice(0, 140);
        button.append(text);
      }
      button.onclick = () => {
        if (post.media?.length) openLightbox([post], 0, 0);
        else { page('library'); window.openDetails(post.id); }
      };
      return button;
    }));
  }

  async function refreshLatest() {
    if (!$('#page-home')?.classList.contains('show') || latestPending) return latestPending;
    const request = ++latestRequest;
    latestDirty = false;
    const task = (async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await chrome.runtime.sendMessage({ type: 'QUERY_LIBRARY_PAGE', query: '', sort: 'new', limit: 16, scanLimit: 16, queryId: `home-recent:${request}:${attempt}` });
          if (request !== latestRequest) return;
          if (result?.stale) continue;
          if (!result?.ok) throw Error(result?.error || 'Recent posts are unavailable');
          latestRows = (result.rows || []).slice(0, 16);
          latestLoaded = true;
          render();
          return;
        }
        throw Error('The archive changed while recent posts were loading. Try again.');
      } catch {
        if (request !== latestRequest) return;
        latestLoaded = false;
        const target = $('#homeRecent');
        if (target) {
          const retry = document.createElement('button');
          retry.type = 'button'; retry.textContent = 'Retry'; retry.onclick = () => { latestPending = null; refreshLatest(); };
          const message = document.createElement('div'); message.className = 'empty'; message.setAttribute('role', 'status'); message.append('Could not load recent posts. ', retry);
          target.replaceChildren(message);
        }
      }
    })();
    latestPending = task;
    try { await task; } finally {
      if (latestPending === task) latestPending = null;
      if (latestDirty && $('#page-home')?.classList.contains('show')) {
        clearTimeout(timer);
        timer = setTimeout(() => { void refreshLatest(); }, 0);
      }
    }
  }

  page = function (name) {
    const result = basePage(name);
    if (name === 'home') {
      if (latestDirty || !latestLoaded) void refreshLatest();
      else render();
    }
    return result;
  };

  document.addEventListener('xv:library', () => {
    latestDirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => { if ($('#page-home')?.classList.contains('show')) void refreshLatest(); }, 200);
  });
})();
