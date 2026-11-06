/* Library workspace: query paging, the in-flow "load more" window, selection, saved views, bulk work and focused media
   playback. Card markup and incremental mounting live in library-feed.js (Library 5.0). */
(() => {
  const selected = new Set();
  function compactTagSummary(post) {
    const tags = post.userMeta?.tags || [];
    if (!tags.length) return (post.sourceFlags || post.archiveSources || []).join(' · ');
    const visible = tags
      .slice(0, 8)
      .map(tag => `#${tag}`)
      .join(' ');
    return tags.length > 8 ? `${visible} · +${tags.length - 8} more` : visible;
  }
  /* Idle tasks coalesced by key: background UI work (facets, counters) runs in idle periods instead of competing
     with the user's next interaction. */
  const idleJobs = new Map();
  function idleTask(key, fn, timeout = 1000) {
    if (idleJobs.has(key)) return;
    const run = () => {
      idleJobs.delete(key);
      fn();
    };
    idleJobs.set(key, window.requestIdleCallback ? requestIdleCallback(run, { timeout }) : setTimeout(run, 32));
  }
  window.XVaultIdleTask = idleTask;
  let pageIndex = 0;
  let lastQuery = '';
  let lastSort = '';
  let queryPersistTimer = 0,
    queryRenderTimer = 0;
  let libraryRevision = 0;
  let libraryLoadGeneration = 0;
  let indexedLibrary = null,
    indexedLength = -1,
    recordIndexes = new Map();
  function libraryRecordIndexes() {
    if (indexedLibrary !== library || indexedLength !== library.length) {
      recordIndexes = new Map(library.map((row, index) => [String(row.id), index]));
      indexedLibrary = library;
      indexedLength = library.length;
    }
    return recordIndexes;
  }
  let randomSeed = freshRandomSeed(0);
  let libraryQueryRevision = null,
    libraryQueryDownloadRevision = null,
    libraryTotalRecords = null,
    libraryQueryHasMore = false,
    libraryQueryMatched = null,
    libraryQueryTruncated = false,
    libraryQueryRetained = null;
  let rankedPlanIdentity = '',
    rankedPlanId = '';
  let pageCursors = [null],
    loadedQueryKey = '',
    activeQueryId = '';
  // Library 5.0 window: pages windowStart..pageIndex are loaded and concatenated in `library`. "Load more" appends
  // the next page; "Next page" starts a fresh window. A metadata edit reloads the same number of rows so the reader
  // keeps their place. The window never retains more than MAX_RETAINED rows.
  const MAX_RETAINED = 1500;
  let windowStart = 0,
    reloadTarget = 0,
    loadingMore = false,
    loadedBase = '';
  let queryInputEvents = 0,
    queryRenderScheduled = 0;
  const libraryQueryMetrics = [];
  let selectionAnchor = '';
  let lastTrashed = [],
    undoLimited = false;
  let mutationBusy = false;
  let mutationProgress = '';
  let exportWorker = null;
  let exportQueryId = '';
  let exportStreamAck = null;
  let exportBusy = false;
  const helperPool = XVaultLibraryModel.createMediaResourcePool({
    create: blob => URL.createObjectURL(blob),
    revoke: url => URL.revokeObjectURL(url),
  });
  const helperPending = new Map();
  const mediaTimes = new Map();
  let helperObserver = null;
  let helperActive = 0;
  const helperQueue = [];
  // The workspace owns the Library list, search matching and lightbox; dashboard.js keeps the built-in
  // versions, which these providers receive and call where they still apply.
  let baseRender = null,
    baseTokenMatch = null,
    baseLightbox = null;
  const model = XVaultLibraryModel;
  let compactRows = [];
  let compactKey = '';
  let compactFrame = 0;
  let compactResizeObserver = null;
  let compactStart = -1;
  let compactEnd = -1;

  // Table (XVault 20) shares the windowed renderer with List; rows are shorter and carry columns.
  let compactMode = 'compact';
  const rowHeight = () => (compactMode === 'table' ? 44 : 76);
  const TABLE_COLUMNS = [
    ['author', 'Author', 'author'],
    ['text', 'Post', ''],
    ['type', 'Media', 'media'],
    ['posted', 'Posted', ''],
    ['archived', 'Archived', 'new'],
    ['likes', 'Likes', 'likes'],
    ['views', 'Views', 'views'],
    ['tags', 'Tags', ''],
    ['state', 'State', ''],
  ];
  function tableHead() {
    const sort = $('#sort')?.value || 'new';
    return `<div class="xv-table-head" role="presentation"><span class="xv-th xv-th-select"></span><span class="xv-th xv-th-thumb"></span>${TABLE_COLUMNS.map(
      ([key, label, sortKey]) => {
        const active = sortKey && (sort === sortKey || (sortKey === 'new' && sort === 'old'));
        return sortKey
          ? `<button type="button" class="xv-th" data-col="${key}" data-table-sort="${sortKey}" aria-pressed="${active ? 'true' : 'false'}" title="Sort by ${label.toLowerCase()}">${label}${active ? (sort === 'old' ? ' ↑' : ' ↓') : ''}</button>`
          : `<span class="xv-th" data-col="${key}">${label}</span>`;
      }
    ).join('')}<span class="xv-th xv-th-actions"></span></div>`;
  }
  function tableRow(post, index) {
    const media = post.media || [],
      first = media[0];
    let preview = first?.preview || (first?.type === 'photo' ? first.url : '');
    try {
      const url = new URL(preview);
      if (url.hostname === 'pbs.twimg.com') {
        url.searchParams.set('name', 'thumb');
        preview = url.href;
      }
    } catch {}
    const meta = post.userMeta || {},
      type = !media.length
        ? 'Text'
        : media.some(item => item.type === 'video')
          ? 'Video'
          : media.some(item => item.type === 'animated_gif')
            ? 'GIF'
            : 'Image',
      day = value =>
        Number.isFinite(new Date(value || 0).getTime()) && value ? new Date(value).toLocaleDateString() : '—',
      state = [
        meta.favorite ? '★' : '',
        meta.readLater && !meta.readAt ? 'Later' : '',
        meta.highlights?.length ? `${meta.highlights.length} hl` : '',
        model.isDownloaded(post, libraryDownloads) ? 'On disk' : '',
      ]
        .filter(Boolean)
        .join(' · ');
    return `<article class="tweet xv-record-row xv-table-row ${meta.favorite ? 'favorite' : ''}${selected.has(String(post.id)) ? ' xv-selected' : ''}" data-id="${esc(post.id)}" data-row-index="${index}" aria-label="Post ${esc(post.id)} by @${esc(post.author?.handle || 'unknown')}" tabindex="0">${selectBox(post.id, post.author?.handle)}<span class="xv-td xv-td-thumb" draggable="true">${preview ? `<img src="${esc(preview)}" alt="" loading="lazy" decoding="async">` : ''}</span><span class="xv-td" data-col="author"><b>@${esc(post.author?.handle || 'unknown')}</b></span><span class="xv-td" data-col="text" title="${esc(String(post.text || '').slice(0, 300))}">${esc(String(post.text || 'Media post').slice(0, 220))}</span><span class="xv-td" data-col="type">${esc(type)}${media.length > 1 ? ` ×${media.length}` : ''}</span><span class="xv-td" data-col="posted">${esc(day(post.createdAt))}</span><span class="xv-td" data-col="archived">${esc(day(post.archivedAt))}</span><span class="xv-td num" data-col="likes">${fmt(post.metrics?.likes || 0)}</span><span class="xv-td num" data-col="views">${fmt(post.metrics?.views || 0)}</span><span class="xv-td" data-col="tags">${esc((meta.tags || []).map(tag => `#${tag}`).join(' '))}</span><span class="xv-td" data-col="state">${esc(state)}</span><span class="xv-td xv-td-actions"><button type="button" data-record-preview="${index}" title="Quick Look (Space)" aria-label="Quick Look at post ${esc(post.id)}">${window.XVaultIcons?.svg('quicklook') || ''}<span class="lbl">Preview</span></button></span></article>`;
  }

  // List and Table are windowed inside the single Library scroller (#libraryScroll). The visible slice is the part
  // of #list between the sticky header and the bottom of the scroller; only that slice (plus overscan) is mounted.
  const libraryScroller = () => $('#libraryScroll');
  let compactScrollTarget = null;
  function onCompactScroll() {
    if (compactGeom) compactGeom.scrollDirty = true;
    if (compactFrame) return;
    compactFrame = requestAnimationFrame(() => {
      compactFrame = 0;
      paintCompact();
    });
  }
  function detachCompactScroll() {
    compactScrollTarget?.removeEventListener('scroll', onCompactScroll);
    compactScrollTarget = null;
    compactResizeObserver?.disconnect();
    compactResizeObserver = null;
    compactGeom = null;
    compactKey = '';
    compactStart = compactEnd = -1;
  }
  // Height of the sticky header that covers the top of the scroller (phones pin only its last row).
  function pinnedHeadHeight() {
    const head = $('#libraryHead');
    if (!head) return 0;
    return Math.max(0, head.offsetHeight + Math.min(0, parseFloat(getComputedStyle(head).top) || 0));
  }
  /* XVault 26: the scroller geometry is cached. Re-reading it on every forced repaint (a favorite, a tag, a
     selection) forced a synchronous layout of the old rows right before they were replaced — ≈20 ms with a
     1,500-row page. The cache is dropped by the ResizeObserver (scroller, sticky header, everything above the list)
     and the scroll offset is re-read only after a scroll event. */
  let compactGeom = null;
  function compactViewport(list) {
    const box = libraryScroller();
    if (!box || !box.contains(list)) return { top: list.scrollTop, height: list.clientHeight || 600 };
    const tableHead = compactMode === 'table' ? 36 : 0;
    let geom = compactGeom;
    if (!geom || geom.list !== list || geom.box !== box) {
      geom = compactGeom = {
        box,
        list,
        head: pinnedHeadHeight(),
        listTop: list.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop,
        clientHeight: box.clientHeight,
        scrollTop: box.scrollTop,
      };
    } else if (geom.scrollDirty) {
      geom.scrollTop = box.scrollTop;
      geom.scrollDirty = false;
    }
    return {
      top: Math.max(0, geom.scrollTop + geom.head - geom.listTop - tableHead),
      height: Math.max(160, geom.clientHeight - geom.head - tableHead),
    };
  }
  function compactRowHtml(post, index) {
    const media = post.media || [];
    const first = media[0];
    let preview = first?.preview || (first?.type === 'photo' ? first.url : '');
    try {
      const url = new URL(preview);
      if (url.hostname === 'pbs.twimg.com') {
        url.searchParams.set('name', 'small');
        preview = url.href;
      }
    } catch {}
    const type = !media.length
      ? 'Text'
      : media.some(item => item.type === 'video')
        ? 'Video'
        : media.some(item => item.type === 'animated_gif')
          ? 'Animation'
          : 'Image';
    const rawText = String(post.text || 'Media post');
    const textPreview = rawText.length > 500 ? `${rawText.slice(0, 500)}…` : rawText;
    const date = Number(post.archivedAt) ? new Date(post.archivedAt).toLocaleDateString() : 'Unknown date';
    const on = selected.has(String(post.id));
    return `<article class="tweet xv-record-row ${post.userMeta?.favorite ? 'favorite' : ''}${on ? ' xv-selected' : ''}" data-id="${esc(post.id)}" data-row-index="${index}" aria-label="Post ${esc(post.id)} by @${esc(post.author?.handle || 'unknown')}" tabindex="0">${selectBox(post.id, post.author?.handle)}<div class="xv-record-thumb" draggable="true">${preview ? `<img src="${esc(preview)}" alt="" loading="lazy" decoding="async">` : `<span>${type}</span>`}</div><div class="xv-record-copy"><b>@${esc(post.author?.handle || 'unknown')}</b><p title="Full text is available in Inspector">${esc(textPreview)}</p><small>${esc(compactTagSummary(post))}</small></div><div class="xv-record-facts"><b>${esc(type)}${media.length > 1 ? ' · ' + media.length : ''}</b><time>${esc(date)}</time><span>${model.isDownloaded(post, libraryDownloads) ? 'Local copy' : media.length ? 'Source media' : 'Archived text'}</span></div><div class="xv-record-actions"><button type="button" data-record-preview="${index}" title="Quick Look (Space)" aria-label="Quick Look at post ${esc(post.id)}">${window.XVaultIcons?.svg('quicklook') || ''}<span class="lbl">Preview</span></button><button type="button" data-details="${esc(post.id)}" title="Inspector (I)" aria-label="Open post ${esc(post.id)} in the Inspector">${window.XVaultIcons?.svg('inspector') || ''}<span class="lbl">Details</span></button></div></article>`;
  }

  function paintCompact(force = false, focusIndex = null) {
    const list = $('#list');
    if (!list?.classList.contains('xv-virtual-list')) return;
    const view = compactViewport(list);
    const viewportWindow = model.virtualWindow(compactRows.length, view.top, view.height, rowHeight());
    if (!force && viewportWindow.start === compactStart && viewportWindow.end === compactEnd) return;
    compactStart = viewportWindow.start;
    compactEnd = viewportWindow.end;
    const focusedId = document.activeElement?.closest('#list .tweet')?.dataset.id;
    releaseHelperMedia(list);
    list.innerHTML =
      (compactMode === 'table' ? tableHead() : '') +
      `<div class="xv-virtual-spacer" aria-hidden="true" style="height:${viewportWindow.before}px"></div>` +
      compactRows
        .slice(viewportWindow.start, viewportWindow.end)
        .map((post, offset) =>
          compactMode === 'table'
            ? tableRow(post, viewportWindow.start + offset)
            : compactRowHtml(post, viewportWindow.start + offset)
        )
        .join('') +
      `<div class="xv-virtual-spacer" aria-hidden="true" style="height:${viewportWindow.after}px"></div>`;
    renderSelection();
    hydrateHelperMedia(list);
    if (focusIndex != null) list.querySelector(`[data-row-index="${focusIndex}"]`)?.focus({ preventScroll: true });
    else if (focusedId)
      list.querySelector(`.tweet[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
    if (viewportWindow.end >= compactRows.length - 4) loadMore(true);
  }
  // Scroll the single Library scroller so the given windowed row is fully visible below the sticky header.
  function revealCompactRow(index) {
    const box = libraryScroller(),
      list = $('#list');
    if (!box || !list) return;
    const head = pinnedHeadHeight() + (compactMode === 'table' ? 36 : 0),
      listTop = list.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop,
      rowTop = listTop + (compactMode === 'table' ? 36 : 0) + index * rowHeight(),
      rowBottom = rowTop + rowHeight();
    if (rowTop < box.scrollTop + head) box.scrollTop = rowTop - head;
    else if (rowBottom > box.scrollTop + box.clientHeight) box.scrollTop = rowBottom - box.clientHeight + 8;
    if (compactGeom) compactGeom.scrollDirty = true;
  }

  function renderCompact(rows, mode = 'compact') {
    const list = $('#list');
    const key = `${currentBase()}|${windowStart}|${mode}`;
    const reset = !list.classList.contains('xv-virtual-list') || key !== compactKey;
    window.XVaultLibraryFeed?.reset();
    compactRows = rows;
    compactKey = key;
    compactMode = mode;
    list.dataset.view = mode;
    list.classList.add('xv-virtual-list');
    list.classList.remove('masonry');
    if (reset) compactGeom = null;
    if (reset && list.offsetTop < (libraryScroller()?.scrollTop || 0)) scrollToListTop(true);
    const box = libraryScroller() || list;
    if (compactScrollTarget !== box) {
      compactScrollTarget?.removeEventListener('scroll', onCompactScroll);
      box.addEventListener('scroll', onCompactScroll, { passive: true });
      compactScrollTarget = box;
    }
    if (!compactResizeObserver) {
      // A height change (the bulk bar appearing, the window growing) only repaints when the visible window of
      // rows actually changes, measured in the next frame when layout is clean; a width change re-renders at once
      // because row text wraps differently.
      let lastWidth = -1;
      compactResizeObserver = new ResizeObserver(entries => {
        compactGeom = null;
        const width = entries.find(entry => entry.target === box)?.contentRect.width ?? lastWidth;
        const widthChanged = width !== lastWidth;
        lastWidth = width;
        if (widthChanged) return void paintCompact(true);
        if (!compactFrame)
          compactFrame = requestAnimationFrame(() => {
            compactFrame = 0;
            paintCompact();
          });
      });
      compactResizeObserver.observe(box);
      const head = $('#libraryHead');
      if (head) compactResizeObserver.observe(head);
      // Anything above the list inside the scroller moves the list's offset when it changes size.
      for (let node = list; node && node !== box; node = node.parentElement)
        for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling)
          compactResizeObserver.observe(sibling);
    }
    paintCompact(true);
  }

  /* Light modal: a dialog opened with show() instead of showModal(). showModal() makes the whole document inert,
     which costs a full-document style recalculation on open and again on close (≈25 ms + 15 ms with 4,000 nodes in
     the Library). The light modal keeps the dialog's semantics (aria-modal, focus containment, Escape, a click-away
     scrim, focus return) while only touching the dialog and one scrim element. */
  const lightModal = (() => {
    const focusable =
      'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),video[controls],[tabindex]:not([tabindex="-1"])';
    let active = null,
      scrim = null;
    function onKey(event) {
      if (!active?.open) return;
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        const cancel = new Event('cancel', { cancelable: true });
        if (active.dispatchEvent(cancel)) active.close();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = [...active.querySelectorAll(focusable)].filter(node => node.getClientRects().length);
      if (!nodes.length) return void event.preventDefault();
      const first = nodes[0],
        last = nodes.at(-1),
        inside = active.contains(document.activeElement);
      if (event.shiftKey && (!inside || document.activeElement === first || document.activeElement === active)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    }
    function onFocusIn(event) {
      if (!active?.open || active.contains(event.target)) return;
      // A real modal dialog (palette, confirm) stacked on top owns focus; only pull focus back from the page.
      if (event.target.closest?.('dialog[open]')) return;
      (active.querySelector('[tabindex="-1"]') || active.querySelector(focusable) || active).focus({
        preventScroll: true,
      });
    }
    function detach() {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn, true);
      scrim?.classList.remove('show');
      document.documentElement.classList.remove('xv-light-modal-open');
      active = null;
    }
    return {
      open(dialog) {
        if (dialog.open) return;
        if (active && active !== dialog) active.close();
        if (!scrim) {
          scrim = document.createElement('div');
          scrim.className = 'xv-light-scrim';
          scrim.setAttribute('aria-hidden', 'true');
          scrim.addEventListener('pointerdown', event => {
            event.preventDefault();
            active?.close();
          });
          document.body.append(scrim);
        }
        dialog.classList.add('xv-light-modal');
        dialog.setAttribute('aria-modal', 'true');
        if (!dialog.dataset.lightModal) {
          dialog.dataset.lightModal = '1';
          dialog.addEventListener('close', () => {
            if (active === dialog) detach();
          });
        }
        active = dialog;
        if (dialog.parentNode !== document.body || dialog.nextSibling) document.body.append(dialog);
        document.body.insertBefore(scrim, dialog);
        dialog.show();
        scrim.classList.add('show');
        document.documentElement.classList.add('xv-light-modal-open');
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('focusin', onFocusIn, true);
      },
      active: () => (active?.open ? active : null),
    };
  })();
  window.XVaultLightModal = lightModal;

  let quickLookRows = [];
  let quickLookIndex = 0;
  let quickLookReturn = null;
  let quickLookReturnId = '';
  let quickLookDirty = false;

  function closeQuickLook() {
    const dialog = $('#xvQuickLook');
    if (!dialog?.open) return;
    dialog.close();
  }
  window.XVaultCloseQuickLook = closeQuickLook;
  window.XVaultQuickLookPostId = () => String(quickLookRows[quickLookIndex]?.id || '');
  window.XVaultQuickLookReturnTarget = () =>
    quickLookReturn?.isConnected
      ? quickLookReturn
      : quickLookReturnId
        ? $(`#list .tweet[data-id="${CSS.escape(quickLookReturnId)}"]`)
        : null;

  function openQuickLook(rows, index) {
    if (!rows[index]) return;
    let dialog = $('#xvQuickLook');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'xvQuickLook';
      dialog.className = 'xv-quick-look';
      dialog.setAttribute('aria-labelledby', 'xvQuickLookTitle');
      document.body.append(dialog);
      dialog.addEventListener('close', () => {
        if (quickLookDirty) {
          quickLookDirty = false;
          renderLib();
        }
        dialog.querySelectorAll('video').forEach(video => {
          video.pause();
          video.removeAttribute('src');
          video.load();
        });
        releaseHelperMedia(dialog);
        dialog.replaceChildren();
        quickLookRows = [];
        const target = quickLookReturn?.isConnected
          ? quickLookReturn
          : $('#list')?.querySelector(`.tweet[data-id="${CSS.escape(quickLookReturnId)}"]`);
        if ($('#lightbox').classList.contains('hidden') && $('#detailsDrawer').classList.contains('hidden'))
          (target || $('#search'))?.focus({ preventScroll: true });
      });
      dialog.addEventListener('keydown', event => {
        if (event.target.closest('input,textarea,select,[contenteditable],video')) return;
        if (
          ![' ', 'ArrowLeft', 'ArrowRight', 'Enter', 'r', 'R', 'f', 'F', 'Delete'].includes(event.key) ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey
        )
          return;
        if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('button,a')) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === ' ') closeQuickLook();
        else if (event.key === 'Enter') openQuickLookViewer();
        else if (event.key.toLowerCase() === 'r') reviewAction('keep');
        else if (event.key.toLowerCase() === 'f') reviewAction('favorite');
        else if (event.key === 'Delete') reviewAction('trash');
        else {
          quickLookIndex = Math.max(
            0,
            Math.min(quickLookRows.length - 1, quickLookIndex + (event.key === 'ArrowRight' ? 1 : -1))
          );
          paintQuickLook(event.key === 'ArrowRight' ? 1 : -1);
          hydrateHelperMedia(dialog);
          $('#xvQuickLookTitle')?.focus({ preventScroll: true });
        }
      });
    }
    if (!dialog.open) {
      quickLookReturn = document.activeElement;
      quickLookReturnId = document.activeElement?.closest('.tweet')?.dataset.id || String(rows[index].id);
    }
    quickLookRows = rows;
    quickLookIndex = index;
    paintQuickLook();
    if (!dialog.open) lightModal.open(dialog);
    hydrateHelperMedia(dialog);
    $('#xvQuickLookTitle')?.focus({ preventScroll: true });
  }

  function openQuickLookViewer() {
    const rows = quickLookRows,
      index = quickLookIndex,
      post = rows[index];
    closeQuickLook();
    if (post?.media?.length) openLightbox(rows, index, 0);
    else if (post) window.openDetails(post.id);
  }

  function paintQuickLook(direction = 0) {
    const dialog = $('#xvQuickLook'),
      post = quickLookRows[quickLookIndex];
    if (!dialog || !post) return;
    dialog.dataset.postId = String(post.id);
    dialog.dataset.browse = direction > 0 ? 'next' : direction < 0 ? 'previous' : 'open';
    dialog.querySelectorAll('video').forEach(video => video.pause());
    releaseHelperMedia(dialog);
    const media = post.media || [],
      first = media[0];
    const noteMediaIndex = media.findIndex(item =>
      window.XVaultMediaMetadata.metadataFor(item).annotations.some(annotation => !annotation.deletedAt)
    );
    const videoNoteCount = media.reduce(
      (count, item) =>
        count +
        window.XVaultMediaMetadata.metadataFor(item).annotations.filter(annotation => !annotation.deletedAt).length,
      0
    );
    const kind = first ? mediaLogical(first) : 'text';
    const pick = first ? mediaSource(first) : null;
    const local = first && kind === 'gif' ? localConvertedFor(post, first) : null;
    const src = local || pick?.src || '';
    const image = kind === 'image' || (kind === 'gif' && (local || pick?.native));
    const date = value =>
      value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : 'Not recorded';
    const downloaded = (libraryDownloads.get(String(post.id)) || []).filter(row => row.state === 'complete');
    const verified = downloaded.filter(
      row => row.verification?.state === 'verified' || row.verificationState === 'verified'
    ).length;
    const provenance = post.provenance?.at(-1);
    const inbox = model.isInbox(post, settings.inboxSince),
      reviewed = Boolean(post.userMeta?.reviewedAt);
    const when = value =>
      value && Number.isFinite(new Date(value).getTime())
        ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : '';
    dialog.innerHTML = `<header><div class="xv-preview-title"><h2 id="xvQuickLookTitle" tabindex="-1">@${esc(post.author?.handle || 'unknown')}</h2><span>${esc([post.author?.name, when(post.createdAt)].filter(Boolean).join(' · '))}</span></div><div class="xv-preview-position">${quickLookIndex + 1} <i>of</i> ${fmt(quickLookRows.length)}${inbox ? '<em>New</em>' : ''}</div><div class="xv-preview-navigation"><button type="button" class="quiet" data-preview="previous" aria-label="Previous post" title="Previous (←)" ${quickLookIndex === 0 ? 'disabled' : ''}>←</button><button type="button" class="quiet" data-preview="next" aria-label="Next post" title="Next (→)" ${quickLookIndex >= quickLookRows.length - 1 ? 'disabled' : ''}>→</button><button type="button" class="quiet" data-preview="close" aria-label="Close Quick Look" title="Close (Esc)">×</button></div></header><div class="xv-preview-body"><div class="xv-preview-stage ${media.length ? '' : 'text-only'}">${!media.length ? `<p>${esc(post.text || 'No post text was recorded.')}</p>` : image ? `<img src="${esc(src)}" alt="${esc(post.text || 'Archived media')}" decoding="async">` : `<video src="${esc(src)}" poster="${esc(first.preview || '')}" controls preload="metadata" playsinline ${kind === 'gif' ? 'loop' : ''}></video>`}${media.length > 1 ? `<span class="xv-preview-media-count">${media.length} media · Open viewer to browse all</span>` : ''}</div><aside>${media.length ? `<p class="tweetText">${esc(post.text || 'No post text recorded.')}</p>` : ''}<dl><dt>Posted</dt><dd>${esc(date(post.createdAt))}</dd><dt>Archived</dt><dd>${esc(date(post.archivedAt))}</dd><dt>Source</dt><dd>${esc(provenance?.source || (post.sourceFlags || post.archiveSources || []).join(', ') || 'Not recorded')}</dd><dt>On disk</dt><dd>${downloaded.length} saved · ${verified} verified</dd>${first ? `<dt>Dimensions</dt><dd>${esc(first.width || '?')} × ${esc(first.height || '?')}</dd>` : ''}<dt>Tags</dt><dd>${esc((post.userMeta?.tags || []).join(', ') || 'Untagged')}</dd><dt>Review</dt><dd>${reviewed ? 'Reviewed ' + esc(when(post.userMeta.reviewedAt)) : inbox ? 'Waiting in Inbox' : 'Not in Inbox'}</dd></dl>${post.userMeta?.note ? `<div class="xv-preview-note"><b>Your note</b><p>${esc(post.userMeta.note)}</p></div>` : ''}<button type="button" class="quiet xv-preview-video-notes" data-preview="notes" ${noteMediaIndex < 0 ? 'hidden' : ''}>Video notes · ${videoNoteCount}</button></aside></div><footer><div class="xv-review" role="group" aria-label="Review this post"><button type="button" class="primary" data-review="keep" title="Mark reviewed and go to the next post (R)">${inbox ? 'Keep' : 'Reviewed'}<kbd>R</kbd></button><button type="button" data-review="favorite" aria-pressed="${post.userMeta?.favorite ? 'true' : 'false'}" title="Favorite (F)">Favorite<kbd>F</kbd></button><button type="button" class="danger" data-review="trash" title="Move to Trash — Undo stays available (Delete)">Trash<kbd>Del</kbd></button></div><div class="xv-preview-actions"><button type="button" class="quiet" data-preview="open">${media.length ? 'Open viewer' : 'Open inspector'}</button><button type="button" class="quiet" data-preview="inspect">Inspector</button><button type="button" class="quiet" data-preview="copy">Copy link</button></div></footer>`;
    dialog.querySelectorAll('[data-preview]').forEach(button => {
      button.onclick = async () => {
        const action = button.dataset.preview;
        if (action === 'close') closeQuickLook();
        else if (action === 'open') openQuickLookViewer();
        else if (action === 'notes') {
          const target =
            post.media?.findIndex(item =>
              window.XVaultMediaMetadata.metadataFor(item).annotations.some(annotation => !annotation.deletedAt)
            ) ?? -1;
          const mediaItem = target >= 0 ? post.media[target] : null,
            annotation =
              mediaItem && window.XVaultMediaMetadata.metadataFor(mediaItem).annotations.find(item => !item.deletedAt);
          closeQuickLook();
          if (target >= 0) {
            openLightbox([post], 0, target);
            requestAnimationFrame(
              () =>
                void window.XVaultSeekMediaAnnotation?.(
                  window.XVaultMediaMetadata.mediaKey(post.id, mediaItem, target),
                  annotation.id
                )
            );
          }
        } else if (action === 'inspect') {
          closeQuickLook();
          window.openDetails(post.id);
        } else if (action === 'copy') {
          const url =
            window.XVaultLinks?.transform(post.url || `https://x.com/i/status/${post.id}`, settings) || post.url;
          if (!url) return;
          try {
            await navigator.clipboard.writeText(typeof url === 'string' ? url : url.url);
            button.textContent = 'Copied';
          } catch {
            button.textContent = 'Copy failed';
          }
        } else {
          quickLookIndex += action === 'next' ? 1 : -1;
          paintQuickLook(action === 'next' ? 1 : -1);
          hydrateHelperMedia(dialog);
          $('#xvQuickLookTitle')?.focus({ preventScroll: true });
        }
      };
    });
    dialog.querySelectorAll('[data-review]').forEach(button => {
      button.onclick = () => reviewAction(button.dataset.review);
    });
    const stage = dialog.querySelector('.xv-preview-stage'),
      element = stage.querySelector('img,video');
    if (element) {
      const notice = document.createElement('div');
      notice.className = 'xv-preview-unavailable';
      notice.hidden = true;
      notice.setAttribute('role', 'status');
      notice.innerHTML =
        '<b>Preview unavailable</b><p>The media could not be loaded. Your archived text and metadata are still available.</p><div><button type="button" data-preview-retry>Retry preview</button><button type="button" data-preview-source>Open source post</button></div>';
      stage.append(notice);
      stage.setAttribute('aria-busy', 'true');
      const ready = () => {
        delete element.dataset.helperFailed;
        stage.removeAttribute('aria-busy');
        notice.hidden = true;
        element.hidden = false;
      };
      const unavailable = () => {
        if (element.getAttribute('src')?.includes('#xvhelper=') && element.dataset.helperFailed !== 'true') return;
        stage.removeAttribute('aria-busy');
        notice.hidden = false;
        element.hidden = true;
      };
      element.addEventListener('error', unavailable);
      element.addEventListener(element.tagName === 'IMG' ? 'load' : 'loadedmetadata', ready);
      notice.querySelector('[data-preview-retry]').onclick = () => {
        delete element.dataset.helperFailed;
        notice.hidden = true;
        element.hidden = false;
        stage.setAttribute('aria-busy', 'true');
        if (element.tagName === 'VIDEO') element.load();
        else {
          const source = element.getAttribute('src');
          element.removeAttribute('src');
          element.setAttribute('src', source);
        }
        hydrateHelperMedia(dialog);
      };
      const source = window.XVaultLinks?.transform(post.url || `https://x.com/i/status/${post.id}`, settings, 'x');
      const sourceButton = notice.querySelector('[data-preview-source]');
      sourceButton.disabled = !source;
      sourceButton.onclick = () => source && chrome.tabs.create({ url: source });
      if (element.tagName === 'IMG' && element.complete) {
        if (element.naturalWidth) ready();
        else unavailable();
      }
    }
  }

  function mediaRenderSignature(media) {
    return JSON.stringify(
      (Array.isArray(media) ? media : []).map(item => ({
        id: item?.id || '',
        assetId: item?.assetId || '',
        type: item?.type || '',
        url: item?.url || '',
        playbackUrl: item?.playbackUrl || '',
        preview: item?.preview || '',
        width: Number(item?.width) || 0,
        height: Number(item?.height) || 0,
        duration: Number(item?.duration) || 0,
        variants: (item?.variants || []).map(variant => [
          variant?.url || '',
          variant?.contentType || variant?.type || '',
          Number(variant?.bitrate) || 0,
        ]),
      }))
    );
  }

  function syncQuickLookRecord(row) {
    const dialog = $('#xvQuickLook'),
      current = quickLookRows[quickLookIndex];
    if (!dialog?.open || !current || String(current.id) !== String(row?.id)) return;
    if (mediaRenderSignature(current.media) !== mediaRenderSignature(row.media)) {
      closeQuickLook();
      toast('This post’s media changed in another window. Reopen it to view the latest copy.');
      return;
    }
    quickLookRows[quickLookIndex] = row;
    const when = value =>
      value && Number.isFinite(new Date(value).getTime())
        ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
        : '';
    const title = dialog.querySelector('#xvQuickLookTitle');
    if (title) title.textContent = `@${row.author?.handle || 'unknown'}`;
    const headerMeta = title?.parentElement?.querySelector('span');
    if (headerMeta) headerMeta.textContent = [row.author?.name, when(row.createdAt)].filter(Boolean).join(' · ');
    const setFact = (label, value) => {
      const term = [...dialog.querySelectorAll('aside dt')].find(node => node.textContent === label);
      if (term?.nextElementSibling) term.nextElementSibling.textContent = value;
    };
    const um = row.userMeta || {},
      provenance = row.provenance?.at(-1);
    setFact('Source', provenance?.source || (row.sourceFlags || row.archiveSources || []).join(', ') || 'Not recorded');
    setFact('Tags', (um.tags || []).join(', ') || 'Untagged');
    setFact(
      'Review',
      um.reviewedAt
        ? `Reviewed ${when(um.reviewedAt)}`
        : model.isInbox(row, settings.inboxSince)
          ? 'Waiting in Inbox'
          : 'Not in Inbox'
    );
    const button = dialog.querySelector('[data-review="favorite"]');
    if (button) button.setAttribute('aria-pressed', String(!!um.favorite));
    const paragraphs = dialog.querySelectorAll('.tweetText, .xv-preview-stage.text-only p');
    paragraphs.forEach(paragraph => {
      paragraph.textContent = row.text || 'No post text was recorded.';
    });
    const videoNotes = (row.media || []).reduce(
      (count, item) =>
        count +
        (Array.isArray(item?.xvault?.annotations)
          ? item.xvault.annotations.filter(annotation => !annotation?.deletedAt).length
          : 0),
      0
    );
    const notesButton = dialog.querySelector('.xv-preview-video-notes');
    if (notesButton) {
      notesButton.hidden = videoNotes === 0;
      notesButton.textContent = `Video notes · ${videoNotes}`;
    }
    let note = dialog.querySelector('.xv-preview-note');
    if (um.note?.trim()) {
      if (!note) {
        note = document.createElement('div');
        note.className = 'xv-preview-note';
        const label = document.createElement('b');
        label.textContent = 'Your note';
        const text = document.createElement('p');
        note.append(label, text);
        dialog.querySelector('.xv-preview-body aside')?.append(note);
      }
      const text = note.querySelector('p');
      if (text) text.textContent = um.note;
    } else note?.remove();
  }
  window.XVaultRefreshQuickLookRecord = syncQuickLookRecord;

  async function setReviewed(ids, value = true) {
    const result = await call({ type: 'BULK_UPDATE_TWEET_META', ids, patch: { reviewed: value } });
    if (!result?.ok) throw Error(result?.error || 'Update failed');
    const byId = new Map(library.map(row => [String(row.id), row]));
    const changed = new Set();
    for (const row of result.rows || []) {
      const existing = byId.get(String(row.id));
      if (existing) {
        Object.assign(existing, row);
        changed.add(String(row.id));
      }
    }
    invalidateQueryCache(changed);
    return changed.size;
  }

  async function reviewAction(action) {
    const post = quickLookRows[quickLookIndex];
    if (!post || mutationBusy) return;
    const refocus = () => $('#xvQuickLookTitle')?.focus({ preventScroll: true });
    try {
      if (action === 'favorite') {
        await toggleFavorite(post.id);
        quickLookDirty = true;
        paintQuickLook();
        hydrateHelperMedia($('#xvQuickLook'));
        refocus();
      } else if (action === 'keep') {
        await setReviewed([post.id], true);
        quickLookDirty = true;
        if (quickLookIndex < quickLookRows.length - 1) quickLookIndex++;
        paintQuickLook(1);
        hydrateHelperMedia($('#xvQuickLook'));
        refocus();
      } else if (action === 'trash') {
        const id = String(post.id);
        await trashPosts([id], { ask: false });
        const at = quickLookRows.findIndex(row => String(row.id) === id);
        if (at < 0) return;
        quickLookRows = quickLookRows.filter(row => String(row.id) !== id);
        if (!quickLookRows.length) return closeQuickLook();
        quickLookIndex = Math.min(at, quickLookRows.length - 1);
        quickLookDirty = false;
        paintQuickLook(1);
        hydrateHelperMedia($('#xvQuickLook'));
        refocus();
      }
    } catch (error) {
      toast(`Review failed: ${error.message}`);
    }
  }

  function currentBase() {
    return `${($('#search')?.value || '').trim()}|${$('#sort')?.value || 'new'}|${randomSeed}|${exportPageSize()}`;
  }
  function freshRandomSeed(previous = randomSeed) {
    const values = new Uint32Array(1);
    try {
      crypto.getRandomValues(values);
    } catch {
      values[0] = Math.floor(Math.random() * 0x100000000) >>> 0;
    }
    let seed = values[0] >>> 0;
    if (!seed || seed === previous) seed = (previous + 1) >>> 0 || 1;
    return seed;
  }

  function invalidateQueryCache() {
    scheduleFacets();
    if (activeQueryId) void call({ type: 'CANCEL_LIBRARY_QUERY', queryId: activeQueryId }).catch(() => {});
    activeQueryId = '';
    reloadTarget = windowStart === 0 && loadedBase === currentBase() ? Math.min(MAX_RETAINED, library.length) : 0;
    loadedQueryKey = '';
    pageCursors = [null];
    pageIndex = 0;
    windowStart = 0;
    libraryQueryDownloadRevision = null;
    libraryTotalRecords = null;
    libraryQueryMatched = null;
    libraryQueryTruncated = false;
    libraryQueryRetained = null;
    libraryQueryHasMore = false;
    libraryRevision++;
  }

  // ── Query tokens: chips and facets add or remove filters instead of replacing the whole search ──
  const splitQuery = value => String(value || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const normToken = value =>
    String(value || '')
      .replace(/^"|"$/g, '')
      .toLowerCase();
  const makeToken = (key, value) => (/\s/.test(value) ? `"${key}:${value}"` : `${key}:${value}`);
  function setQueryTokens(tokens) {
    $('#search').value = tokens.join(' ');
    pageIndex = 0;
    windowStart = 0;
    renderLib();
  }
  window.XVaultLibraryToggleToken = (token, group = '') => toggleToken(token, group);
  function toggleToken(token, group = '') {
    const tokens = splitQuery($('#search').value),
      wanted = normToken(token);
    const at = tokens.findIndex(item => normToken(item) === wanted);
    if (at >= 0) tokens.splice(at, 1);
    else {
      if (group)
        for (let index = tokens.length - 1; index >= 0; index--)
          if (normToken(tokens[index]).startsWith(group)) tokens.splice(index, 1);
      tokens.push(token);
    }
    setQueryTokens(tokens);
  }

  let tileDirty = false;
  function syncChrome(query = $('#search')?.value || '') {
    const tokens = splitQuery(query).map(normToken),
      trimmed = query.trim();
    for (const button of $$('#libraryDestinations [data-destination]')) {
      const active = model.destinationQuery(button.dataset.destination) === trimmed;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    for (const button of $$('#libraryDestinations [data-token]')) {
      const active = tokens.includes(normToken(button.dataset.token));
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    for (const chip of $$('#libraryChips button')) {
      const filter = chip.dataset.filter || '';
      const active = filter
        ? tokens.includes(normToken(filter))
        : !tokens.some(token => token.startsWith('has:') || token.startsWith('type:') || token.startsWith('rating:'));
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', String(active));
    }
    const view = $('#libraryView')?.value || settings.libraryView || 'timeline';
    const group = $$('#libraryLayout [data-layout]');
    for (const button of group) {
      const on = button.dataset.layout === view;
      button.setAttribute('aria-checked', String(on));
      button.tabIndex = on ? 0 : -1;
    }
    const tile = $('#libraryTile');
    const size = Number(settings.libraryTileSize) || 260;
    if (tile && !tileDirty && document.activeElement !== tile) tile.value = String(size);
    $('#page-library')?.style.setProperty('--tile', `${tile && tileDirty ? tile.value : size}px`);
    $('#page-library')?.setAttribute('data-view', view);
    const review = $('#libraryReview');
    if (review) review.hidden = !tokens.includes('inbox:true');
  }

  // ── Facets: collections, sources, authors and tags drawn from the archive itself ──
  let facetTimer = 0;
  const facetOpen = { authors: false, tags: false };
  let facetsStale = false;
  function scheduleFacets() {
    clearTimeout(facetTimer);
    // XVault 26: facets walk the whole archive. They wait for the page to settle (300 ms) and then for an idle
    // period, so a select / Quick Look straight after a big page mounts never queues behind them. While another
    // page is open they are only marked stale.
    facetTimer = setTimeout(() => {
      if (!$('#page-library')?.classList.contains('show')) return void (facetsStale = true);
      idleTask('facets', renderFacets, 1500);
    }, 300);
  }
  window.XVaultDashboard?.after?.('page', (result, name) => {
    if (name === 'library' && facetsStale) {
      facetsStale = false;
      scheduleFacets();
    }
  });
  function renderFacets() {
    const root = $('#libraryDestinations');
    if (!root) return;
    const authors = new Map(),
      tags = new Map();
    let inbox = 0,
      favorites = 0,
      untagged = 0,
      later = 0,
      highlights = 0;
    for (const post of library) {
      const handle = String(post.author?.handle || '').replace(/^@/, '');
      if (handle) authors.set(handle, (authors.get(handle) || 0) + 1);
      const postTags = [
        ...new Set([...(post.userMeta?.tags || []), ...(post.media || []).flatMap(item => item?.xvault?.tags || [])]),
      ];
      for (const tag of postTags) tags.set(tag, (tags.get(tag) || 0) + 1);
      if (!postTags.length) untagged++;
      if (post.userMeta?.favorite) favorites++;
      if (model.isInbox(post, settings.inboxSince)) inbox++;
      if (post.userMeta?.readLater && !post.userMeta?.readAt) later++;
      if (post.userMeta?.highlights?.length) highlights++;
    }
    const counts = { all: libraryTotalRecords, inbox, favorites, untagged, later, highlights };
    for (const [id, count] of Object.entries(counts)) {
      const target = root.querySelector(`[data-destination="${id}"] .count`);
      if (target) target.textContent = count == null ? '—' : count ? fmt(count) : '';
      const button = root.querySelector(`[data-destination="${id}"]`);
      if (button)
        button.title =
          id === 'all'
            ? count == null
              ? 'Archive total is not calculated to keep Library paging fast.'
              : `${fmt(count)} posts in the archive.`
            : `${fmt(count || 0)} ${{ inbox: 'new', favorites: 'favorite', later: 'read-later', highlights: 'highlighted' }[id] || 'untagged'} posts on the loaded page.`;
    }
    const draw = (id, entries, key, limit, label) => {
      const target = $(id);
      if (!target) return;
      const sorted = [...entries].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const shown = facetOpen[key] ? sorted.slice(0, 80) : sorted.slice(0, limit);
      target.replaceChildren(
        ...shown.map(([name, count]) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'facet-item';
          button.dataset.token = makeToken(key === 'authors' ? 'from' : 'tag', name);
          const text = document.createElement('span');
          text.textContent = key === 'authors' ? `@${name}` : `#${name}`;
          const num = document.createElement('em');
          num.className = 'count';
          num.textContent = fmt(count);
          button.append(text, num);
          button.title = `${fmt(count)} ${key === 'authors' ? 'posts by this author on the loaded page' : 'posts with this tag on the loaded page'}`;
          return button;
        })
      );
      if (!sorted.length) {
        const hint = document.createElement('p');
        hint.className = 'facet-hint';
        hint.textContent = libraryTotalRecords === 0 ? label : 'No matches on this page.';
        target.append(hint);
      } else if (sorted.length > limit) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'quiet facet-more';
        more.dataset.facetMore = key;
        more.textContent = facetOpen[key] ? 'Show fewer' : `Show all ${fmt(sorted.length)}`;
        target.append(more);
      }
    };
    draw('#facetAuthors', authors, 'authors', 10, 'Authors appear as posts are archived.');
    draw('#facetTags', tags, 'tags', 10, 'Tag a post to see it here.');
    syncChrome();
  }

  // Every loaded row of the window (Load more appends to it), not only the first page.
  function currentPageRows() {
    return resultRows();
  }
  function openQuickLookById(id) {
    const rows = currentPageRows();
    if (!rows) return toast('Wait for the current search to finish');
    const index = rows.findIndex(post => String(post.id) === String(id));
    if (index >= 0) openQuickLook(rows, index);
  }
  window.XVaultOpenQuickLookById = openQuickLookById;

  window.XVaultInvalidateLibraryCache = invalidateQueryCache;
  window.XVaultLibraryRecordUpdated = ids => {
    invalidateQueryCache(ids?.length ? new Set(ids.map(String)) : null);
    if ($('#page-library')?.classList.contains('show')) renderLib();
    void refreshActiveLibrarySurfaces(ids?.length ? new Set(ids.map(String)) : null);
  };

  const workspaceTokenMatch = (post, token) => {
    const match = /^downloaded:(true|false)$/i.exec(token);
    if (match) {
      const downloaded = model.isDownloaded(post, libraryDownloads);
      return downloaded === (match[1].toLowerCase() === 'true');
    }
    if (/^missing:(true|false)$/i.test(token))
      return model.hasMissingMedia(post, libraryDownloads) === token.toLowerCase().endsWith('true');
    if (/^note:(true|false)$/i.test(token))
      return (
        Boolean(
          post.userMeta?.note?.trim() ||
          (post.media || []).some(
            item =>
              item?.xvault?.note?.trim() ||
              (item?.xvault?.annotations || []).some(
                annotation => !annotation?.deletedAt && String(annotation?.text || '').trim()
              )
          )
        ) === token.endsWith('true')
      );
    return baseTokenMatch(post, token);
  };
  window.XVaultDashboard.provide('tokenMatch', builtin => {
    baseTokenMatch = builtin;
    return workspaceTokenMatch;
  });

  function resultRows() {
    if (!loadedQueryKey) return null;
    return library;
  }

  function setPage(delta) {
    pageIndex = delta > 0 ? pageIndex + 1 : Math.max(0, windowStart - 1);
    windowStart = pageIndex;
    reloadTarget = 0;
    renderLib();
    // A page change replaces the content, so jump rather than glide through the old page.
    scrollToListTop(true);
  }
  function scrollToListTop(instant = false) {
    const scroller = $('#libraryScroll'),
      list = $('#list');
    if (!scroller || !list) return;
    if (compactGeom) compactGeom.scrollDirty = true;
    scroller.scrollTo({
      top: 0,
      behavior:
        instant || document.body.dataset.motion === 'off' || document.body.dataset.motion === 'reduced'
          ? 'instant'
          : 'smooth',
    });
  }

  let libraryLongTaskObserver = null;
  const libraryLongTasks = [];
  if (typeof PerformanceObserver === 'function') {
    try {
      libraryLongTaskObserver = new PerformanceObserver(list => recordLibraryLongTasks(list.getEntries()));
      libraryLongTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch {}
  }
  function recordLibraryLongTasks(entries = []) {
    for (const entry of entries)
      libraryLongTasks.push({
        startTime: Number(entry.startTime) || 0,
        duration: Number(entry.duration) || 0,
        name: entry.name || '',
        attribution: [...(entry.attribution || [])].slice(0, 3).map(item => ({
          containerType: item.containerType || '',
          containerName: item.containerName || '',
          containerId: item.containerId || '',
        })),
      });
    if (libraryLongTasks.length > 200) libraryLongTasks.splice(0, libraryLongTasks.length - 200);
  }
  function longTasksDuring(startTime, endTime) {
    recordLibraryLongTasks(libraryLongTaskObserver?.takeRecords()?.getEntries?.() || []);
    return libraryLongTasks
      .filter(task => task.startTime <= endTime && task.startTime + task.duration >= startTime)
      .map(task => ({ ...task }));
  }
  function measureMountedMedia(root) {
    const result = { mounted: 0, ready: 0, pending: 0, failed: 0, truncated: false };
    if (!root) return result;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let visited = 0,
      element;
    while ((element = walker.nextNode())) {
      if (++visited > 5000) {
        result.truncated = true;
        break;
      }
      if (element.localName !== 'img' && element.localName !== 'video') continue;
      if (++result.mounted > 256) {
        result.mounted--;
        result.truncated = true;
        break;
      }
      if (element.localName === 'img') {
        if (element.complete && element.naturalWidth > 0) result.ready++;
        else if (element.complete && element.naturalWidth === 0 && element.currentSrc) result.failed++;
        else result.pending++;
      } else if (element.error) result.failed++;
      else if (element.readyState >= 2) result.ready++;
      else result.pending++;
    }
    return result;
  }
  window.XVaultLibraryMetrics = () => libraryQueryMetrics.slice();
  window.XVaultLibraryQueryState = () => ({
    revision: libraryQueryRevision,
    totalRecords: libraryTotalRecords,
    pageIndex,
    pageSize: exportPageSize(),
    randomSeed,
    cursors: pageCursors.slice(0, 4),
    loaded: Boolean(loadedQueryKey),
    loadedFor: loadedQueryKey,
    lastQuery,
    queryKeyNow: `${libraryRevision}|${($('#search')?.value || '').trim()}|${$('#sort')?.value || 'new'}|${pageIndex}|${randomSeed}|${exportPageSize()}`,
    activeQueryId,
    rankedPlanId,
    rankedPlanRetained: libraryQueryRetained,
    rankedPlanTruncated: libraryQueryTruncated,
    busy: $('#list')?.hasAttribute('aria-busy') || false,
    rows: library.length,
    mutationBusy,
    queryInputEvents,
    queryRenderScheduled,
  });
  function exportPageSize() {
    const configuredPageSize = Math.min(1500, Math.max(50, Number(settings.libraryPageSize) || 120));
    return settings.libraryPerformanceMode === 'performance' ? Math.min(configuredPageSize, 80) : configuredPageSize;
  }
  const workspaceRenderLib = function (dataReady = false) {
    const q = ($('#search')?.value || '').trim(),
      sort = $('#sort')?.value || 'new';
    // loadLib calls renderLib(true) immediately after installing a completed
    // page. The first data-ready render must not erase its key merely because
    // lastSort has not been initialized on a fresh dashboard.
    if (!dataReady && (q !== lastQuery || sort !== lastSort)) {
      pageIndex = 0;
      windowStart = 0;
      reloadTarget = 0;
      pageCursors = [null];
      loadedQueryKey = '';
      libraryQueryDownloadRevision = null;
      libraryTotalRecords = null;
      libraryQueryMatched = null;
      libraryQueryHasMore = false;
      libraryQueryTruncated = false;
      libraryQueryRetained = null;
      scheduleFacets();
    }
    if (q !== lastQuery && settings.rememberLibraryQuery) {
      clearTimeout(queryPersistTimer);
      queryPersistTimer = setTimeout(() => {
        if (settings.lastLibraryQuery !== q) save({ lastLibraryQuery: q }, false);
      }, 650);
    }
    lastQuery = q;
    lastSort = sort;
    const requestKey = `${libraryRevision}|${q}|${sort}|${pageIndex}|${randomSeed}|${exportPageSize()}`;
    if (!dataReady && requestKey !== loadedQueryKey) {
      void loadLib();
      return library;
    }
    syncChrome(q);
    const issues = window.XVaultLibrarySearch?.queryIssues(q) || [];
    if ($('#libraryQueryIssues')) {
      $('#libraryQueryIssues').hidden = !issues.length;
      $('#libraryQueryIssues').textContent = issues.join(' · ');
    }
    if ($('#libraryExportDialog') && !$('#libraryExportDialog').hidden) refreshLinkExportSummary();
    const filtered = resultRows();
    if (!filtered) {
      $('#list')?.setAttribute('aria-busy', 'true');
      const shown = $('#libShown');
      if (shown) shown.textContent = `Searching ${fmt(library.length)} posts…`;
      if ($('#list') && !$('#list').childElementCount)
        $('#list').innerHTML = '<div class="empty" role="status">Searching your archive…</div>';
      return library;
    }
    $('#list')?.removeAttribute('aria-busy');
    const pageSize = exportPageSize(),
      rows = filtered,
      start = windowStart * pageSize;
    const exactTotal = libraryQueryMatched ?? (!q ? libraryTotalRecords : null);
    const pageTotal = libraryQueryTruncated ? libraryQueryRetained : exactTotal;
    const pages =
      pageTotal == null ? pageIndex + (libraryQueryHasMore ? 2 : 1) : Math.max(1, Math.ceil(pageTotal / pageSize));
    const original = library;
    const remember = settings.rememberLibraryQuery;
    settings.rememberLibraryQuery = false;
    // A layout switch keeps the reader's place across both renderers (feed layouts and List/Table), and a query
    // the reader returns to restores where they were in it.
    const renderBase = `${currentBase()}|${windowStart}`,
      viewNow = settings.libraryView || 'cards',
      switching = renderedBase === renderBase && renderedView && renderedView !== viewNow;
    const crossAnchor = switching
      ? visibleAnchor()
      : renderedBase !== renderBase
        ? queryAnchors.get(renderBase) || null
        : null;
    renderedBase = renderBase;
    renderedView = viewNow;
    watchAnchorScroll();
    try {
      if (['compact', 'table'].includes(settings.libraryView) && rows.length) {
        releaseHelperMedia($('#list'));
        renderCompact(rows, settings.libraryView);
        if (crossAnchor) scrollCompactToAnchor(rows, crossAnchor);
        $('#libMediaCount').textContent = fmt(rows.reduce((count, post) => count + (post.media?.length || 0), 0));
        $('#libLocalCount').textContent = fmt(
          rows.reduce(
            (count, post) =>
              count + (libraryDownloads.get(String(post.id)) || []).filter(row => row.state === 'complete').length,
            0
          )
        );
      } else {
        compactResizeObserver?.disconnect();
        detachCompactScroll();
        $('#list').classList.remove('xv-virtual-list');
        renderFeed(rows, crossAnchor);
      }
    } finally {
      library = original;
      settings.rememberLibraryQuery = remember;
    }
    const shown = $('#libShown');
    if (shown)
      shown.textContent = filtered.length
        ? libraryQueryTruncated
          ? `${start + 1}–${start + rows.length} / ${fmt(libraryQueryRetained)} retained · top of ${fmt(libraryQueryMatched)} matches`
          : `${fmt(start + 1)}–${fmt(start + rows.length)}${exactTotal == null ? (libraryQueryHasMore ? '+' : '') : ` / ${fmt(exactTotal)}`}`
        : '0';
    if (!filtered.length && libraryTotalRecords !== 0 && q) {
      const empty = $('#list .empty');
      if (empty) {
        empty.replaceChildren(
          libraryTotalRecords == null
            ? `No posts match “${q}”. `
            : `No posts match “${q}” (${fmt(libraryTotalRecords)} archived). `
        );
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.textContent = 'Clear search and filters';
        clear.onclick = () => {
          $('#search').value = '';
          renderLib();
        };
        empty.append(clear);
        // XVault 21: xv-forge-search.js adds "Did you mean" / "Allow typos" / "Search by meaning".
        window.dispatchEvent(new CustomEvent('xvault:no-results', { detail: { query: q, container: empty } }));
      }
    }
    if (filtered.length && q)
      window.dispatchEvent(
        new CustomEvent('xvault:results', { detail: { query: q, count: filtered.length, rows: filtered } })
      );
    if (!filtered.length && libraryTotalRecords === 0) {
      const empty = $('#list .empty');
      if (empty) {
        empty.className = 'empty xv-first-run';
        empty.innerHTML =
          '<h3>Your archive starts here</h3><p>Browse X with passive capture on, or pull in what you have already saved.</p><div class="row"><button class="primary" data-first-archive="bookmarks">Archive bookmarks</button><button data-first-archive="likes">Archive likes</button></div>';
        empty.querySelectorAll('[data-first-archive]').forEach(button => {
          button.onclick = () => {
            page('archive');
            source = button.dataset.firstArchive;
            selectSource();
          };
        });
      }
    }
    renderPaging(pages, libraryQueryHasMore);
    scheduleFacets();
    renderSelection();
    return rows;
  };
  let renderedBase = '',
    renderedView = '';
  // Each query remembers where the reader was (recorded when scrolling settles, because a new search may collapse
  // the list before it renders): clearing a search returns to the same post in All posts.
  const queryAnchors = new Map();
  let anchorTimer = 0;
  function rememberQueryAnchor() {
    clearTimeout(anchorTimer);
    anchorTimer = setTimeout(() => {
      if (!renderedBase || $('#list')?.hasAttribute('aria-busy') || !$('#page-library')?.classList.contains('show'))
        return;
      const anchor = visibleAnchor();
      queryAnchors.delete(renderedBase);
      if (anchor) queryAnchors.set(renderedBase, anchor);
      while (queryAnchors.size > 24) queryAnchors.delete(queryAnchors.keys().next().value);
    }, 180);
  }
  function watchAnchorScroll() {
    const box = libraryScroller();
    if (!box || box.dataset.xvAnchorWatch) return;
    box.dataset.xvAnchorWatch = '1';
    box.addEventListener('scroll', rememberQueryAnchor, { passive: true });
  }
  // The first post under the sticky header and how far below the header it sits (null at the very top).
  function visibleAnchor() {
    const box = libraryScroller(),
      list = $('#list');
    if (!box || !list || box.scrollTop < 4) return null;
    const view = box.getBoundingClientRect(),
      head = $('#libraryHead')?.getBoundingClientRect(),
      top =
        view.top +
        Math.min(head ? Math.max(0, head.bottom - view.top) : 0, view.height / 2) +
        (list.dataset.view === 'table' && list.classList.contains('xv-virtual-list') ? 36 : 0);
    const card = [...list.querySelectorAll('.tweet[data-id]')].find(
      node => node.getBoundingClientRect().bottom > top + 24
    );
    return card ? { id: card.dataset.id, offset: card.getBoundingClientRect().top - top } : null;
  }
  function scrollCompactToAnchor(rows, anchor) {
    const index = rows.findIndex(row => String(row.id) === String(anchor.id)),
      box = libraryScroller(),
      list = $('#list');
    if (index < 0 || !box || !list) return;
    const tableHead = compactMode === 'table' ? 36 : 0,
      listTop = list.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(
      0,
      listTop + tableHead + index * rowHeight() - pinnedHeadHeight() - tableHead - Math.max(0, anchor.offset)
    );
    compactGeom = null;
    paintCompact(true);
  }
  // Card layouts: library-feed.js mounts the window incrementally and patches in place for the same query.
  function renderFeed(rows, anchor = null) {
    const list = $('#list');
    const feed = window.XVaultLibraryFeed;
    if (!feed) return baseRender?.({ externallyFiltered: true });
    const view = ['timeline', 'cards', 'gallery', 'masonry'].includes(settings.libraryView)
      ? settings.libraryView
      : 'cards';
    feed.render({
      rows,
      key: `${currentBase()}|${windowStart}`,
      view,
      selected: () => selected,
      nearEnd: () => loadMore(true),
      anchor,
    });
    let media = 0,
      local = 0;
    for (const post of rows) {
      media += post.media?.length || 0;
      local += (libraryDownloads.get(String(post.id)) || []).filter(row => row.state === 'complete').length;
    }
    if ($('#libMediaCount')) $('#libMediaCount').textContent = fmt(media);
    if ($('#libLocalCount')) $('#libLocalCount').textContent = fmt(local);
    // Settings → Library → Performance: let the browser skip painting mounted cards that are off screen.
    if (list) list.dataset.cv = settings.libraryContentVisibility !== false && view !== 'masonry' ? 'auto' : 'off';
  }
  // Append the next page to the window. Automatic when the reader reaches the end (Settings → Library → "Load
  // more automatically"), explicit through the in-flow button otherwise. Never past MAX_RETAINED rows.
  function loadMore(auto = false) {
    if (loadingMore || mutationBusy || !loadedQueryKey || !libraryQueryHasMore) return false;
    if (auto && settings.libraryAutoLoad === false) return false;
    if (library.length + exportPageSize() > MAX_RETAINED) {
      if (!auto) setPage(1);
      return false;
    }
    loadingMore = true;
    pageIndex++;
    void workspaceLoadLib({ append: true }).finally(() => {
      loadingMore = false;
    });
    return true;
  }
  window.XVaultLibraryLoadMore = () => loadMore(false);
  window.XVaultDashboard.provide('renderLib', builtin => {
    baseRender = builtin;
    return workspaceRenderLib;
  });

  const workspaceLoadLib = async function (options = {}) {
    if (mutationBusy) return toast('Wait for the current Library change to finish');
    const append = options?.append === true && library.length > 0 && loadedBase === currentBase();
    const generation = ++libraryLoadGeneration;
    const previous = library,
      previousDownloads = libraryDownloads,
      startPage = pageIndex,
      base = currentBase(),
      // Same search, same window: keep the rows on screen while the fresh copy is read (no blank flash).
      inPlace = append || (base === loadedBase && library.length > 0 && $('#list')?.querySelector('.tweet'));
    if (activeQueryId) void call({ type: 'CANCEL_LIBRARY_QUERY', queryId: activeQueryId }).catch(() => {});
    const queryId = crypto.randomUUID();
    activeQueryId = queryId;
    const q = ($('#search')?.value || '').trim(),
      sort = $('#sort')?.value || 'new',
      pageSize = exportPageSize(),
      target = append
        ? pageSize
        : Math.max(pageSize, Math.min(MAX_RETAINED, base === loadedBase && !startPage ? reloadTarget : 0));
    reloadTarget = 0;
    const rankedSort = !['new', 'old'].includes(sort),
      planIdentity = JSON.stringify([q, sort, randomSeed]);
    if (rankedSort && planIdentity !== rankedPlanIdentity) {
      rankedPlanIdentity = planIdentity;
      rankedPlanId = crypto.randomUUID();
    }
    const startedAt = performance.now(),
      heapBefore = performance.memory?.usedJSHeapSize ?? null;
    const rows = [],
      downloadRows = [];
    let afterKey = pageCursors[pageIndex] || null,
      expectedRevision = libraryQueryRevision,
      expectedDownloadRevision = libraryQueryDownloadRevision,
      done = false,
      hasMore = false,
      matched = null,
      totalRecords = null,
      scanned = 0,
      recordsRead = 0,
      materialized = 0,
      cursorOperations = 0,
      downloadRowsRead = 0,
      downloadCursorOperations = 0,
      searchProjectionRows = 0,
      bytesEstimate = 0,
      queryMs = 0,
      openMs = 0,
      settingsMs = 0,
      databaseOpenMs = 0,
      schemaPreparationMs = 0,
      queryPlanningMs = 0,
      pageReadMs = 0,
      downloadLookupMs = 0,
      requestCount = 0,
      plan = '',
      retries = 0,
      downloadsTruncated = false,
      truncated = false,
      retained = null,
      rankCacheHit = false;
    const list = $('#list');
    if (list && inPlace) {
      list.setAttribute('aria-busy', 'true');
      list.dataset.refreshing = append ? 'more' : 'refresh';
      if (append) renderPaging(0, true, 'loading');
    } else if (list) {
      releaseHelperMedia(list);
      helperObserver?.disconnect();
      list.setAttribute('aria-busy', 'true');
      delete list.dataset.refreshing;
      window.XVaultLibraryFeed?.reset();
      list.innerHTML =
        '<div class="empty" role="status"><span data-query-progress>Opening a bounded Library page…</span> <button type="button" class="quiet" data-cancel-library-query>Cancel search</button></div>';
      list.querySelector('[data-cancel-library-query]')?.addEventListener('click', () => {
        if (generation !== libraryLoadGeneration) return;
        const requestId = activeQueryId;
        activeQueryId = '';
        libraryLoadGeneration++;
        if (requestId) void call({ type: 'CANCEL_LIBRARY_QUERY', queryId: requestId }).catch(() => {});
        list.setAttribute('aria-busy', 'false');
        const status = list.querySelector('[data-query-progress]');
        if (status) status.textContent = 'Search canceled. ';
        const button = list.querySelector('[data-cancel-library-query]');
        if (button) {
          button.textContent = 'Run search again';
          button.onclick = () => loadLib();
        }
      });
    }
    try {
      for (let batch = 0; batch < 10000 && rows.length < target && !done; batch++) {
        const remaining = target - rows.length;
        const request = {
          type: 'QUERY_LIBRARY_PAGE',
          queryId,
          query: q,
          sort,
          limit: rankedSort ? target : remaining,
          offset: rankedSort ? pageIndex * pageSize : 0,
          after: rankedSort ? null : afterKey,
          expectedRevision,
          expectedDownloadRevision,
          randomSeed,
          rankPlanId: rankedSort ? rankedPlanId : undefined,
          scanLimit: 10000,
        };
        let page;
        if (rankedSort) {
          let polling = false;
          const timer = setInterval(async () => {
            if (polling || generation !== libraryLoadGeneration || activeQueryId !== queryId) return;
            polling = true;
            try {
              const state = await call({ type: 'GET_LIBRARY_QUERY_PROGRESS', queryId }),
                progress = state?.progress,
                status = list?.querySelector('[data-query-progress]');
              if (status && progress?.phase === 'scan')
                status.textContent = `Sorting archive · checked ${fmt(progress.scanned)} posts · ${fmt(progress.matched)} matches`;
              else if (status && progress?.phase === 'materialize')
                status.textContent = `Loading ${fmt(progress.matched)} ranked matches…`;
            } catch {
            } finally {
              polling = false;
            }
          }, 180);
          try {
            page = await call(request);
          } finally {
            clearInterval(timer);
          }
        } else page = await call(request);
        if (generation !== libraryLoadGeneration) return;
        if (!page?.ok) throw Error(page?.error || 'The Library page could not be read');
        if (page.cancelled) return;
        requestCount++;
        if (page.stale) {
          if (retries++)
            throw Error('The archive kept changing while this page was read. It is still safe; retry the query.');
          libraryQueryRevision = page.revision;
          pageCursors = [null];
          pageIndex = 0;
          afterKey = null;
          expectedRevision = page.revision;
          if (page.downloadRevision != null)
            libraryQueryDownloadRevision = expectedDownloadRevision = page.downloadRevision;
          toast('The Library changed in another window. Restarted this query from the first page.');
          batch = -1;
          rows.length = 0;
          downloadRows.length = 0;
          continue;
        }
        expectedRevision = page.revision;
        libraryQueryRevision = page.revision;
        if (page.downloadRevision != null)
          libraryQueryDownloadRevision = expectedDownloadRevision = page.downloadRevision;
        if (page.totalRecords != null) totalRecords = Number(page.totalRecords);
        if (page.matched != null) matched = page.matched;
        truncated ||= !!page.truncated;
        if (page.retained != null) retained = Number(page.retained);
        rankCacheHit ||= !!page.rankCacheHit;
        rows.push(...(page.rows || []));
        downloadRows.push(...(page.downloads || []));
        downloadsTruncated ||= !!page.downloadsTruncated;
        scanned += Number(page.scanned || 0);
        materialized += Number(page.materialized || page.recordsRead || 0);
        recordsRead += Number(page.recordsRead ?? page.scanned ?? 0);
        cursorOperations += Number(page.cursorOperations || 0);
        downloadRowsRead += Number(page.downloadRowsRead ?? page.downloads?.length ?? 0);
        downloadCursorOperations += Number(page.downloadCursorOperations || 0);
        searchProjectionRows += Number(page.searchProjectionRows ?? (q ? page.scanned || 0 : 0));
        bytesEstimate += Number(page.bytesEstimate || 0);
        queryMs += Number(page.metrics?.queryMs || 0);
        openMs += Number(page.metrics?.openMs || 0);
        settingsMs += Number(page.metrics?.settingsMs || 0);
        databaseOpenMs += Number(page.metrics?.databaseOpenMs || 0);
        schemaPreparationMs += Number(page.metrics?.schemaPreparationMs || 0);
        queryPlanningMs += Number(page.metrics?.queryPlanningMs || 0);
        pageReadMs += Number(page.metrics?.pageReadMs || 0);
        downloadLookupMs += Number(page.metrics?.downloadLookupMs || 0);
        plan = page.metrics?.plan || page.plan || plan;
        done = !!page.done;
        hasMore = !!page.hasMore;
        if (done && pageIndex === 0 && !q && !rows.length && totalRecords == null) totalRecords = 0;
        if (!rankedSort) afterKey = page.nextKey || afterKey;
        if (list && !inPlace && !done && rows.length < target) {
          const status = list.querySelector('.empty');
          if (status)
            status.textContent = `Searching indexed records · ${fmt(scanned)} checked · ${fmt(rows.length)} matches`;
        }
        if (rankedSort || rows.length >= target || done) break;
        if (!page.nextKey || (page.nextKey === afterKey && !page.scanned))
          throw Error('The Library cursor stopped advancing. Restart the query.');
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (generation !== libraryLoadGeneration) return;
      const pageRetrievedAt = performance.now();
      const nextDownloads = new Map();
      for (const row of downloadRows) {
        const id = String(row.item?.tweetId || '');
        if (!nextDownloads.has(id)) nextDownloads.set(id, []);
        nextDownloads.get(id).push(row);
      }
      if (append) {
        const known = new Set(previous.map(row => String(row.id)));
        library = previous.concat(rows.filter(row => !known.has(String(row.id))));
        libraryDownloads = new Map([...previousDownloads, ...nextDownloads]);
      } else {
        library = rows;
        libraryDownloads = nextDownloads;
        windowStart = startPage;
        // A same-window reload may read several pages at once; the window still ends on a page boundary.
        if (rows.length > pageSize) pageIndex = startPage + Math.ceil(rows.length / pageSize) - 1;
      }
      loadedBase = base;
      libraryTotalRecords = totalRecords;
      libraryQueryMatched = matched;
      libraryQueryTruncated = truncated;
      libraryQueryRetained = retained;
      libraryQueryHasMore = rankedSort ? hasMore : !done;
      if (!rankedSort) pageCursors[pageIndex + 1] = libraryQueryHasMore ? afterKey : null;
      loadedQueryKey = `${libraryRevision}|${q}|${sort}|${pageIndex}|${randomSeed}|${pageSize}`;
      if (list) delete list.dataset.refreshing;
      if (activeQueryId === queryId) activeQueryId = '';
      const renderStartedAt = performance.now();
      renderLib(true);
      const usableAt = performance.now();
      void refreshActiveLibrarySurfaces();
      const endedAt = performance.now(),
        renderMs = usableAt - renderStartedAt,
        media = measureMountedMedia(list),
        heapAfter = performance.memory?.usedJSHeapSize ?? null;
      libraryQueryMetrics.push({
        at: Date.now(),
        queryStartPerformanceMs: startedAt,
        queryEndPerformanceMs: endedAt,
        plan,
        sort,
        queryLength: q.length,
        archiveRecords: totalRecords,
        revision: libraryQueryRevision,
        downloadRevision: libraryQueryDownloadRevision,
        queryRequests: requestCount,
        rankCacheHit,
        rankedRowsRetained: retained,
        rankedPlanTruncated: truncated,
        recordsScanned: scanned,
        recordsRead,
        recordsMaterialized: materialized,
        searchProjectionRows,
        cursorOperations,
        recordsReturned: rows.length,
        dashboardRecordsRetained: library.length,
        appended: append,
        downloadRowsRead,
        downloadCursorOperations,
        responseBytesEstimate: bytesEstimate,
        openMs,
        settingsMs,
        databaseOpenMs,
        schemaPreparationMs,
        queryPlanningMs,
        pageReadMs,
        downloadLookupMs,
        queryMs,
        searchIndexMs: 0,
        pageRetrievalMs: pageRetrievedAt - startedAt,
        renderMs,
        firstRenderMs: renderMs,
        usableLibraryMs: usableAt - startedAt,
        mediaMounted: media.mounted,
        mediaReady: media.ready,
        mediaPending: media.pending,
        mediaFailed: media.failed,
        mediaMeasurementTruncated: media.truncated,
        mainThreadLongTasks: longTasksDuring(startedAt, endedAt),
        heapBeforeBytes: heapBefore,
        heapAfterBytes: heapAfter,
        heapDeltaBytes: heapBefore != null && heapAfter != null ? heapAfter - heapBefore : null,
        heapMeasurement:
          heapBefore != null && heapAfter != null ? 'performance.memory (coarse; not a peak)' : 'unavailable',
      });
      if (libraryQueryMetrics.length > 80) libraryQueryMetrics.shift();
      document.dispatchEvent(new Event('xv:library'));
      void refreshTrashUndo();
      if (downloadsTruncated && list) {
        const warning = document.createElement('div');
        warning.className = 'empty';
        warning.setAttribute('role', 'status');
        warning.textContent = `Some posts have more than 64 download-history rows. The Library keeps a bounded recent detail sample; the full history remains available in Downloads.`;
        list.prepend(warning);
      }
    } catch (error) {
      if (generation !== libraryLoadGeneration) return;
      library = previous;
      libraryDownloads = previousDownloads;
      if (append) pageIndex = startPage - 1;
      if (list) delete list.dataset.refreshing;
      loadedQueryKey = `${libraryRevision}|${q}|${sort}|${pageIndex}|${randomSeed}|${pageSize}`;
      if (activeQueryId === queryId) activeQueryId = '';
      renderLib(true);
      toast(`Could not load the Library: ${error.message}`);
      if (list) {
        const workerMismatch = /unknown message/i.test(error?.message || String(error));
        const warning = document.createElement('div');
        warning.className = 'empty';
        warning.setAttribute('role', 'alert');
        warning.textContent = workerMismatch
          ? 'This XVault dashboard is newer than its background worker. Reload the extension to reconnect Library; your archive is unchanged. '
          : `Library read failed: ${error.message}. Your stored archive has not been cleared. `;
        const retry = document.createElement('button');
        retry.textContent = workerMismatch ? 'Reload XVault extension' : 'Retry loading';
        retry.onclick = workerMismatch
          ? () => {
              retry.disabled = true;
              retry.textContent = 'Reloading XVault…';
              try {
                chrome.runtime.reload();
              } catch {
                location.reload();
              }
            }
          : () => loadLib();
        warning.append(retry);
        list.prepend(warning);
      }
    }
  };
  window.XVaultDashboard.provide('loadLib', () => workspaceLoadLib);

  // In-flow footer at the end of the results: what is shown, "Load more", page navigation and back to top. It is
  // part of the scrolling content, so it can never cover a post.
  let lastPages = 1;
  function renderPaging(pages, hasMore = false, phase = '') {
    const target = $('#libraryPages');
    if (!target) return;
    if (pages) lastPages = pages;
    const pageSize = exportPageSize(),
      q = ($('#search')?.value || '').trim();
    const exact = libraryQueryMatched != null || (!q && libraryTotalRecords != null);
    const total = libraryQueryTruncated
      ? libraryQueryRetained
      : (libraryQueryMatched ?? (!q ? libraryTotalRecords : null));
    const canNext = exact ? pageIndex < lastPages - 1 : hasMore;
    const canPrev = windowStart > 0;
    const from = windowStart * pageSize + 1,
      to = windowStart * pageSize + library.length,
      capped = library.length + pageSize > MAX_RETAINED,
      remaining = total == null ? pageSize : Math.max(0, Math.min(pageSize, total - to));
    target.hidden = !library.length && !canPrev;
    target.dataset.phase = phase || (canNext ? 'more' : 'end');
    const status =
      phase === 'loading'
        ? 'Loading more posts…'
        : library.length
          ? `Showing ${fmt(from)}–${fmt(to)}${total != null ? ` of ${fmt(total)}` : hasMore ? ' · more available' : ''}${!canNext ? ' · end of results' : ''}`
          : '';
    const pageLabel = `Page ${fmt(windowStart + 1)}${pageIndex > windowStart ? `–${fmt(pageIndex + 1)}` : ''}${exact ? ` of ${fmt(lastPages)}` : ''}`;
    target.innerHTML = `<p class="lib5-pager-status" role="status" aria-live="polite">${esc(status)}</p>${
      canNext && !capped
        ? `<button type="button" id="libraryLoadMore" class="primary" ${phase === 'loading' ? 'disabled aria-busy="true"' : ''}>${phase === 'loading' ? 'Loading…' : `Load ${fmt(remaining || pageSize)} more`}</button>`
        : ''
    }${
      canNext && capped
        ? `<p class="lib5-pager-note">${fmt(library.length)} posts are open in this window. Continue on the next page to keep scrolling light.</p>`
        : ''
    }<span class="lib5-pager-nav" role="group" aria-label="Library pages"><button type="button" id="libraryPrev" class="quiet" ${canPrev ? '' : 'disabled'}>${window.XVaultIcons?.svg('previous') || ''}<span>Previous page</span></button><span class="lib5-pager-page">${esc(pageLabel)}</span><button type="button" id="libraryNext" class="quiet" ${canNext ? '' : 'disabled'}><span>Next page</span>${window.XVaultIcons?.svg('next') || ''}</button></span><button type="button" id="libraryTop" class="quiet">${window.XVaultIcons?.svg('toTop') || ''}<span>Back to top</span></button>`;
    $('#libraryPrev').onclick = () => setPage(-1);
    $('#libraryNext').onclick = () => setPage(1);
    $('#libraryTop').onclick = () => {
      scrollToListTop();
      $('#search')?.focus({ preventScroll: true });
    };
    const more = $('#libraryLoadMore');
    if (more) more.onclick = () => loadMore(false);
  }

  // Selection state is drawn by the renderers (library-feed.js cards, windowed List/Table rows); this only syncs it.
  // One pass over the mounted cards (the feed owns virtualized lists; blocks mounted later read the same Set).
  function paintSelectedCards() {
    const feed = window.XVaultLibraryFeed;
    if (feed?.syncSelection && $('#list.xv-virtual-list')) return void feed.syncSelection(selected);
    for (const card of $$('#list .tweet')) {
      const on = selected.has(card.dataset.id);
      card.classList.toggle('xv-selected', on);
      const box = card.querySelector('.xv-card-select input');
      if (box && box.checked !== on) box.checked = on;
    }
  }
  function renderSelection() {
    paintSelectedCards();
    updateSelectionBar(false);
  }
  // One entry point for checkbox, Shift-click range and Ctrl/Cmd-click toggles from every layout.
  window.XVaultLibrarySelect = (rawId, { range = false, checked = true, toggle = false } = {}) => {
    const id = String(rawId),
      on = toggle ? !selected.has(id) : checked !== false;
    if (range && selectionAnchor) {
      const matching = resultRows();
      if (matching) model.applySelectionRange(selected, matching, selectionAnchor, id, on);
    }
    if (on) {
      if (selected.size >= 5000 && !selected.has(id)) {
        toast('Selection is limited to 5,000 posts at a time.');
        renderSelection();
        return;
      }
      selected.add(id);
    } else selected.delete(id);
    if (selected.size > 5000) {
      for (const extra of [...selected].slice(5000)) selected.delete(extra);
      toast('Selection is limited to 5,000 posts at a time.');
    }
    selectionAnchor = id;
    renderSelection();
  };
  const selectBox = (id, handle) =>
    `<label class="xv-card-select" title="Select (Shift-click for a range)"><input type="checkbox" data-select="${esc(id)}" aria-label="Select post by @${esc(handle || 'unknown')}"${selected.has(String(id)) ? ' checked' : ''}></label>`;

  function openLinkExport() {
    const dialog = $('#libraryExportDialog');
    if (!dialog) return;
    dialog.hidden = false;
    const rememberedBlock = Number(settings.libraryExportBlock);
    $('#libraryExportBlock').value = String([1, 5, 10, 25, 50, 0].includes(rememberedBlock) ? rememberedBlock : 5);
    $('#libraryExportScope').value = selected.size ? 'selected' : 'all';
    refreshLinkExportSummary();
    if (!dialog.open) dialog.showModal();
    $('#libraryExportBlock').focus();
  }

  function closeLinkExport() {
    if (exportBusy) {
      exportWorker?.terminate();
      exportWorker = null;
      exportBusy = false;
    }
    if (exportQueryId) {
      const queryId = exportQueryId;
      exportQueryId = '';
      void call({ type: 'CANCEL_LIBRARY_QUERY', queryId }).catch(() => {});
    }
    exportStreamAck?.reject(Error('Export cancelled'));
    exportStreamAck = null;
    $('#libraryCancelExport').hidden = true;
    $('#libraryExportDialog').close();
    $('#libraryExportDialog').hidden = true;
  }

  function refreshLinkExportSummary() {
    const matching = resultRows();
    const scope = $('#libraryExportScope')?.value || 'all';
    const ready = Boolean(matching);
    const settingProvider = settings.linkProvider || 'fixvx';
    const providerName =
      window.XVaultLinks?.label(settingProvider) || (settingProvider === 'custom' ? 'Custom' : 'FixVX');
    const host = window.XVaultLinks?.providerHost(settingProvider, settings);
    const dialog = $('#libraryExportDialog');
    dialog.dataset.scope = scope;
    $('#libraryExportQuery').textContent = `Search - ${($('#search')?.value || '').trim() || 'All posts'}`;
    $('#libraryExportProvider').textContent = host ? `${providerName} - ${host}` : 'Invalid custom provider';
    const total = libraryQueryMatched ?? (!($('#search')?.value || '').trim() ? libraryTotalRecords : null);
    const completeInMemory = !libraryQueryHasMore;
    const count =
      scope === 'selected'
        ? selected.size
        : scope === 'page'
          ? matching
            ? matching.length
            : 0
          : completeInMemory
            ? (total ?? matching?.length ?? 0)
            : matching?.length || 0;
    const streaming = scope === 'all' && (libraryQueryHasMore || libraryQueryTruncated);
    $('#libraryExportCount').textContent = streaming
      ? `${fmt(matching?.length || 0)} loaded; remaining matches stream newest first in revision-checked pages`
      : `${ready ? fmt(count || 0) : '...'} ${scope === 'all' ? 'matching' : scope === 'page' ? 'loaded in this window' : 'selected'} unique posts${ready ? '' : ' - search pending'}`;
    const disabled = !ready || !count || !host || exportBusy;
    $('#libraryExportTxt').disabled = disabled;
    $('#libraryCopyLinks').disabled = disabled;
  }

  function exportRecords() {
    const matching = resultRows();
    if (!matching) throw new Error('Wait for the current search to finish');
    const scope = $('#libraryExportScope').value;
    if (scope === 'all' && (libraryQueryHasMore || libraryQueryTruncated)) return { posts: [], stream: true };
    return { posts: window.XVaultLinkExport.selectScope(matching, scope, selected, matching), stream: false };
  }

  function runLinkExport(action) {
    if (exportBusy) return;
    let posts, streamAll;
    try {
      ({ posts, stream: streamAll } = exportRecords());
    } catch (error) {
      toast(error.message);
      return;
    }
    if (!streamAll && !posts.length) return toast('No posts in this export scope');
    if (!window.XVaultLinks?.providerHost(settings.linkProvider || 'fixvx', settings))
      return toast('Choose a valid link provider in Settings');
    exportBusy = true;
    const progress = $('#libraryExportProgress');
    progress.hidden = false;
    progress.textContent = streamAll
      ? 'Starting a revision-checked Library scan...'
      : `Collecting links... 0 / ${fmt(posts.length)}`;
    $('#libraryCancelExport').hidden = false;
    $('#libraryExportTxt').disabled = $('#libraryCopyLinks').disabled = true;
    const worker = new Worker('library-export-worker.js');
    exportWorker = worker;
    exportQueryId = streamAll ? crypto.randomUUID() : '';
    let abortReason = '';
    const cancelQuery = () => {
      if (!exportQueryId) return;
      const queryId = exportQueryId;
      exportQueryId = '';
      void call({ type: 'CANCEL_LIBRARY_QUERY', queryId }).catch(() => {});
    };
    const clean = () => {
      worker.terminate();
      if (exportWorker === worker) exportWorker = null;
      cancelQuery();
      exportStreamAck = null;
      exportBusy = false;
      $('#libraryCancelExport').hidden = true;
      refreshLinkExportSummary();
    };
    const chunkSize = 400;
    const sendChunk = start => {
      if (start >= posts.length) {
        worker.postMessage({ type: 'finish' });
        return;
      }
      const chunk = posts.slice(start, start + chunkSize).map(post => ({
        id: post?.id,
        url: post?.url,
        handle: post?.author?.handle,
        author: { handle: post?.author?.handle },
      }));
      worker.postMessage({ type: 'chunk', posts: chunk, done: Math.min(posts.length, start + chunkSize) });
    };
    const streamAllPages = async () => {
      const queryId = exportQueryId,
        query = ($('#search')?.value || '').trim(),
        randomSeedAtStart = randomSeed;
      let after = null,
        expectedRevision = libraryQueryRevision,
        expectedDownloadRevision = libraryQueryDownloadRevision;
      let scanned = 0,
        submitted = 0,
        done = false;
      while (!done) {
        if (!exportBusy || exportWorker !== worker) return;
        const page = await call({
          type: 'QUERY_LIBRARY_PAGE',
          queryId,
          query,
          sort: 'new',
          limit: chunkSize,
          after,
          expectedRevision,
          expectedDownloadRevision,
          randomSeed: randomSeedAtStart,
          scanLimit: 10000,
          includeDownloads: false,
        });
        if (!exportBusy || exportWorker !== worker) return;
        if (!page?.ok) throw Error(page?.error || 'The Library changed before the export could finish');
        if (page.cancelled) return;
        if (page.stale)
          throw Error(
            'The archive changed during export. No file was created; restart the export with current results.'
          );
        if (expectedRevision != null && Number(page.revision) !== Number(expectedRevision))
          throw Error('The archive revision changed during export. No file was created; restart the export.');
        expectedRevision = page.revision;
        if (page.downloadRevision != null) expectedDownloadRevision = page.downloadRevision;
        const batch = (page.rows || []).map(post => ({
          id: post?.id,
          url: post?.url,
          handle: post?.author?.handle,
          author: { handle: post?.author?.handle },
        }));
        scanned += Number(page.scanned || 0);
        submitted += batch.length;
        done = !!page.done;
        if (batch.length) {
          const ack = new Promise((resolve, reject) => {
            exportStreamAck = { resolve, reject };
          });
          worker.postMessage({ type: 'chunk', posts: batch, done: submitted });
          progress.textContent = `Scanning - ${fmt(scanned)} records checked - ${fmt(submitted)} matching posts queued`;
          await ack;
          exportStreamAck = null;
        } else {
          progress.textContent = `Scanning - ${fmt(scanned)} records checked - ${fmt(submitted)} matching posts queued`;
        }
        if (!done) {
          const next = page.nextKey || null;
          if (!next || JSON.stringify(next) === JSON.stringify(after))
            throw Error('The Library cursor did not advance during export. No file was created.');
          after = next;
        }
      }
      if (exportBusy && exportWorker === worker) {
        progress.textContent = `Preparing ${fmt(submitted)} matching links...`;
        worker.postMessage({ type: 'finish' });
      }
    };
    worker.onmessage = async event => {
      const message = event.data || {};
      if (message.type === 'ready') {
        if (streamAll)
          void streamAllPages().catch(error => {
            if (!exportBusy || exportWorker !== worker) return;
            abortReason = error.message || 'The Library changed during export';
            progress.textContent = abortReason;
            exportStreamAck?.reject(error);
            exportStreamAck = null;
            cancelQuery();
            worker.postMessage({ type: 'cancel' });
          });
        else sendChunk(0);
      } else if (message.type === 'progress') {
        if (streamAll) {
          progress.textContent = `Collected ${fmt(message.done)} matching posts; continuing the cursor scan...`;
          exportStreamAck?.resolve();
        } else {
          progress.textContent = `Collecting links... ${fmt(message.done)} / ${fmt(message.total)}`;
          if (message.done < posts.length) sendChunk(message.done);
          else worker.postMessage({ type: 'finish' });
        }
      } else if (message.type === 'cancelled') {
        exportStreamAck?.resolve();
        clean();
        progress.textContent = abortReason ? `Export stopped - ${abortReason}` : 'Export cancelled';
        if (!abortReason) toast('Link export cancelled');
      } else if (message.type === 'complete') {
        try {
          if (!message.unique) {
            progress.textContent = `No valid post links found - ${message.skipped} skipped`;
            toast('No valid post links to export');
            return;
          }
          if (action === 'copy') {
            await navigator.clipboard.writeText(message.text);
          } else {
            download(
              message.text,
              window.XVaultLinkExport.sanitizeFilename($('#search').value, message.unique),
              'text/plain;charset=utf-8'
            );
          }
          progress.textContent = `${fmt(message.unique)} unique links exported - ${fmt(message.duplicates)} duplicates skipped${message.skipped ? ` - ${fmt(message.skipped)} invalid skipped` : ''}`;
          toast(
            `${fmt(message.unique)} unique links ${action === 'copy' ? 'copied' : 'exported'} - ${fmt(message.duplicates)} duplicates skipped`
          );
        } catch (error) {
          progress.textContent = action === 'copy' ? 'Clipboard access failed' : 'Could not create the TXT file';
          toast(action === 'copy' ? 'Clipboard access failed' : `Export failed: ${error.message}`);
        } finally {
          clean();
        }
      }
    };
    worker.onerror = error => {
      const failure = Error(error.message || 'Link export worker failed');
      exportStreamAck?.reject(failure);
      exportStreamAck = null;
      clean();
      progress.textContent = 'Export failed';
      toast(`Export failed: ${failure.message}`);
    };
    worker.postMessage({
      type: 'start',
      settings,
      perBlock: Number($('#libraryExportBlock').value),
      total: streamAll ? 0 : posts.length,
    });
  }

  function updateSelectionBar(paint = true) {
    if (paint) paintSelectedCards();
    const listEl = $('#list');
    if (listEl) listEl.dataset.selecting = selected.size ? 'true' : 'false';
    const bar = $('#libraryBulk');
    if (!bar) return;
    bar.hidden = selected.size === 0 && lastTrashed.length === 0 && !mutationBusy;
    bar.dataset.undoOnly = selected.size === 0 && !mutationBusy ? 'true' : 'false';
    $('#librarySelectedCount').textContent =
      mutationProgress ||
      (selected.size
        ? `${fmt(selected.size)} selected`
        : `${fmt(lastTrashed.length)} ${undoLimited ? 'recent posts · older copies in Trash' : 'posts awaiting recovery'}`);
    bar.querySelectorAll('button').forEach(button => {
      button.disabled = mutationBusy;
    });
    $('#libraryUndoTrash').hidden = lastTrashed.length === 0;
    $('#libraryUndoTrash').textContent = undoLimited ? 'Undo recent Trash' : 'Undo Trash';
    $('#libraryUndoTrash').title = undoLimited
      ? 'Restore recent removals. Browse Trash to recover older copies.'
      : 'Restore the pending removals';
  }

  function selectAllMatching() {
    const rows = resultRows();
    if (!rows) return toast('Wait for the current search to finish');
    const next = model.replaceSelection(rows.map(post => post.id));
    selected.clear();
    for (const id of next) selected.add(id);
    selectionAnchor = rows[0] ? String(rows[0].id) : '';
    renderSelection();
  }

  // Every match of the current search, not only the loaded window: the background resolves the ids (up to the
  // 5,000-post selection limit) without sending records. Download-state rules fall back to the loaded rows.
  let selectingEvery = false;
  async function selectEveryMatch() {
    const q = ($('#search')?.value || '').trim();
    if (selectingEvery) return;
    if (!libraryQueryHasMore && !libraryQueryTruncated && windowStart === 0) return selectAllMatching();
    selectingEvery = true;
    const count = $('#librarySelectedCount');
    if (count) count.textContent = 'Selecting every match…';
    try {
      const response = await call({ type: 'QUERY_LIBRARY_IDS', query: q, limit: 5000 });
      if (!response?.ok || response.unsupported) throw new Error(response?.error || 'unsupported');
      selected.clear();
      for (const id of response.ids || []) selected.add(String(id));
      selectionAnchor = response.ids?.[0] ? String(response.ids[0]) : '';
      toast(
        response.truncated
          ? `Selected the first ${fmt(selected.size)} matches (selection limit 5,000)`
          : `Selected all ${fmt(selected.size)} matches`
      );
    } catch {
      selectAllMatching();
      toast(`Selected the ${fmt(selected.size)} loaded matches`);
    } finally {
      selectingEvery = false;
      renderSelection();
    }
  }
  window.XVaultLibrarySelectEveryMatch = selectEveryMatch;

  function selectVisiblePage() {
    const rows = resultRows();
    if (!rows) return;
    const next = model.addSelection(
      selected,
      rows.map(post => post.id)
    );
    if (next.length > 5000) {
      toast('Selection is limited to 5,000 posts at a time.');
      return;
    }
    selected.clear();
    for (const id of next) selected.add(id);
    renderSelection();
  }

  function invertVisiblePage() {
    const rows = resultRows();
    if (!rows) return;
    const next = model.invertSelection(
      selected,
      rows.map(post => post.id)
    );
    if (next.length > 5000) {
      toast('Selection is limited to 5,000 posts at a time.');
      return;
    }
    selected.clear();
    for (const id of next) selected.add(id);
    renderSelection();
  }

  async function bulkMeta(patch, label, targetIds = null) {
    if (mutationBusy) return;
    const ids = targetIds ? [...targetIds].map(String) : [...selected];
    if (!ids.length) return;
    mutationBusy = true;
    let updated = 0;
    const changedIds = new Set(),
      previous = [];
    const byId = new Map(library.map(row => [String(row.id), row]));
    try {
      for (let start = 0; start < ids.length; start += 200) {
        mutationProgress = `${label} · ${fmt(start)} / ${fmt(ids.length)}`;
        updateSelectionBar();
        const result = await call({ type: 'BULK_UPDATE_TWEET_META', ids: ids.slice(start, start + 200), patch });
        if (!result?.ok) throw Error(result?.error || 'Update failed');
        for (const row of result.rows || []) {
          const existing = byId.get(String(row.id));
          if (existing) {
            Object.assign(existing, row);
            changedIds.add(String(row.id));
          }
        }
        updated += result.updated || 0;
        previous.push(...(result.previous || []));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      if (window.XVaultUndo && previous.length)
        window.XVaultUndo.push({
          label: `${label} · ${fmt(updated)} post${updated === 1 ? '' : 's'}`,
          entries: previous,
        });
      else toast(`${label} · ${fmt(updated)} posts`);
    } catch (error) {
      toast(`${label} stopped after ${fmt(updated)} posts: ${error.message}. Retry the remaining selection.`);
    } finally {
      mutationBusy = false;
      mutationProgress = '';
      invalidateQueryCache(changedIds);
      renderLib();
      updateSelectionBar();
    }
  }

  window.XVaultLibraryBulkMeta = bulkMeta;
  window.XVaultLibraryTrash = ids => trashPosts([...ids].map(String), { ask: true });
  window.XVaultLibraryResultRows = () => resultRows();
  window.XVaultLibrarySetSelection = ids => {
    const next = model.replaceSelection([...ids].slice(0, 5000));
    selected.clear();
    for (const id of next) selected.add(id);
    selectionAnchor = [...next][0] || '';
    renderSelection();
    return selected.size;
  };
  window.XVaultLibraryRunQuery = (query, sort = null) => {
    if (sort && $('#sort') && $('#sort').value !== sort) {
      $('#sort').value = sort;
      settings.librarySort = sort;
    }
    $('#search').value = query;
    pageIndex = 0;
    renderLib();
    syncChrome(query);
  };

  function trashSelected() {
    return trashPosts([...selected], { ask: true });
  }

  async function refreshTrashUndo() {
    try {
      const result = await call({ type: 'GET_TRASH_UNDO' });
      if (result?.ok && !mutationBusy) {
        lastTrashed = (result.ids || []).map(String);
        undoLimited = !!result.limited;
        updateSelectionBar();
      }
    } catch {
      /* Browsable Trash remains available if the Undo read fails. */
    }
  }
  window.XVaultLibraryRefreshUndo = refreshTrashUndo;

  async function applyRestoredRecords(rows) {
    const known = new Set(library.map(row => String(row.id))),
      added = [];
    for (const row of rows)
      if (!known.has(String(row.id))) {
        library.push(row);
        known.add(String(row.id));
        added.push(String(row.id));
      }
    try {
      if (added.length) {
        const downloads = await call({ type: 'GET_DOWNLOADS_FOR_TWEETS', ids: added });
        if (!downloads?.ok) throw Error(downloads?.error || 'Download state unavailable');
        for (const id of added) libraryDownloads.set(id, []);
        for (const row of downloads.rows || []) libraryDownloads.get(String(row.item?.tweetId))?.push(row);
      }
    } catch {
      toast('Posts restored. Reload the Library to retry their download state.');
    }
    invalidateQueryCache();
    renderLib();
    document.dispatchEvent(new Event('xv:library'));
    await refreshTrashUndo();
  }
  window.XVaultLibraryApplyRestore = applyRestoredRecords;
  // Metadata notifications read only affected records, never the archive index.
  const metadataChannel = new BroadcastChannel('xvault-library-metadata');
  const libraryChangesChannel = new BroadcastChannel('xvault-library-changes');
  const pendingMetadata = new Set();
  let metadataTimer,
    metadataReading = false;
  async function syncMetadata() {
    if (metadataReading) return;
    metadataReading = true;
    const observedIds = new Set();
    try {
      while (pendingMetadata.size) {
        const ids = [...pendingMetadata].slice(0, 128);
        ids.forEach(id => pendingMetadata.delete(id));
        const result = await call({ type: 'GET_LIBRARY_METADATA', ids });
        if (!result?.ok) {
          toast('Metadata synchronization failed. Reload to retry.');
          break;
        }
        for (const row of result.rows || []) observedIds.add(String(row.id));
        const indexes = libraryRecordIndexes();
        const changed = [];
        for (const row of result.rows) {
          const index = indexes.get(String(row.id)),
            post = index === undefined ? null : library[index];
          if (post && JSON.stringify(post.userMeta || {}) !== JSON.stringify(row.userMeta)) {
            post.userMeta = row.userMeta;
            post.updatedAt = row.updatedAt;
            changed.push(String(post.id));
          }
        }
        if (changed.length) scheduleFacets();
      }
      // An off-page record can enter or leave a metadata-backed query even
      // though this window has no cached row to compare. Revalidate once after
      // the bounded ID reads, rather than silently keeping stale query results
      // or restarting the same query once per 128-ID batch.
      if (observedIds.size) window.XVaultLibraryRecordUpdated?.([...observedIds]);
    } catch {
      toast('Metadata synchronization failed. Reload to retry.');
    } finally {
      metadataReading = false;
    }
  }
  metadataChannel.onmessage = event => {
    if (!Array.isArray(event.data?.ids)) return;
    for (const id of event.data.ids.slice(0, 1000)) pendingMetadata.add(String(id));
    clearTimeout(metadataTimer);
    metadataTimer = setTimeout(syncMetadata, 80);
  };
  let libraryChangeTimer = 0,
    pendingLibraryKinds = new Set(),
    pendingLibraryIds = new Set(),
    pendingLibraryTruncated = false;
  const queryUsesDownloadState = () => /(?:^|\s)(?:downloaded|missing|size):/i.test($('#search')?.value || '');
  function drainLibraryChanges() {
    if (!pendingLibraryKinds.size) return;
    if (mutationBusy) {
      libraryChangeTimer = setTimeout(drainLibraryChanges, 50);
      return;
    }
    const kinds = pendingLibraryKinds,
      ids = pendingLibraryIds,
      truncated = pendingLibraryTruncated;
    pendingLibraryKinds = new Set();
    pendingLibraryIds = new Set();
    pendingLibraryTruncated = false;
    if (kinds.has('remove')) for (const id of ids) selected.delete(id);
    if (kinds.has('clear') || truncated) selected.clear();
    pageCursors = [null];
    pageIndex = 0;
    invalidateQueryCache();
    if ($('#page-library')?.classList.contains('show')) renderLib();
    void refreshActiveLibrarySurfaces(ids.size && !truncated ? ids : null).catch(() =>
      toast('An open post could not be refreshed.')
    );
  }
  function scheduleLibraryChangeDrain() {
    clearTimeout(libraryChangeTimer);
    libraryChangeTimer = setTimeout(drainLibraryChanges, 100);
  }
  async function refreshActiveLibrarySurfaces(changedIds = null) {
    const dialog = $('#xvQuickLook'),
      drawer = $('#detailsDrawer');
    const activeIds = new Set();
    const qlRowId = dialog?.open ? String(window.XVaultQuickLookPostId?.() || '') : '';
    const inspectorId = drawer && !drawer.classList.contains('hidden') ? String(drawer.dataset.postId || '') : '';
    const lightboxId = !$('#lightbox')?.classList.contains('hidden')
      ? String(window.XVaultLightboxPostId?.() || '')
      : '';
    for (const id of [qlRowId, inspectorId, lightboxId])
      if (id && (!changedIds || changedIds.has(id))) activeIds.add(id);
    if (!activeIds.size) return;
    const ids = [...activeIds].slice(0, 2);
    const result = await call({ type: 'GET_LIBRARY_RECORDS', ids });
    if (!result?.ok) throw Error(result?.error || 'The open record could not be refreshed');
    const records = new Map((result.rows || []).map(row => [String(row.id), row]));
    const files = await call({ type: 'GET_DOWNLOADS_FOR_TWEETS', ids, perPostLimit: 64 });
    if (files?.ok) {
      for (const id of ids) libraryDownloads.set(id, []);
      for (const row of files.rows || []) libraryDownloads.get(String(row.item?.tweetId || ''))?.push(row);
    }
    for (const id of ids) {
      const row = records.get(id);
      if (!row) {
        window.XVaultCloseStaleInspector?.(id);
        if (qlRowId === id) {
          window.XVaultCloseQuickLook?.();
          toast('This post is no longer in the Library. Check Trash or refresh the query.');
        }
        if (lightboxId === id) {
          window.XVaultCloseLightbox?.();
          toast('This post is no longer in the Library. Check Trash or refresh the query.');
        }
        continue;
      }
      const visible = library.find(post => String(post.id) === id);
      if (visible) Object.assign(visible, row);
      window.XVaultRefreshQuickLookRecord?.(row);
      window.XVaultRefreshInspectorRecord?.(row);
      window.XVaultRefreshLightboxRecord?.(row);
    }
  }
  async function syncVisibleDownloadRows(ids) {
    const wanted = new Set(ids.map(String));
    const visible = library.filter(post => wanted.has(String(post.id))).map(post => String(post.id));
    if (!visible.length) return;
    const result = await call({ type: 'GET_DOWNLOADS_FOR_TWEETS', ids: visible, perPostLimit: 64 });
    if (!result?.ok) throw Error(result?.error || 'Download state unavailable');
    const byPost = new Map(visible.map(id => [id, []]));
    for (const row of result.rows || []) byPost.get(String(row.item?.tweetId || ''))?.push(row);
    for (const id of visible) libraryDownloads.set(id, byPost.get(id) || []);
    renderLib(true);
    document.dispatchEvent(new Event('xv:library'));
  }
  libraryChangesChannel.onmessage = event => {
    const kind = String(event.data?.kind || '');
    if (kind === 'download') {
      const ids = Array.isArray(event.data?.ids) ? event.data.ids.map(String) : [];
      if (event.data?.truncated || queryUsesDownloadState()) {
        invalidateQueryCache();
        if ($('#page-library')?.classList.contains('show')) renderLib();
      } else if ($('#page-library')?.classList.contains('show')) {
        void syncVisibleDownloadRows(ids).catch(() =>
          toast('Download status changed. Reload this page to refresh its visible files.')
        );
      }
      void refreshActiveLibrarySurfaces(event.data?.truncated ? null : new Set(ids)).catch(() =>
        toast('The open post could not refresh its download status.')
      );
      return;
    }
    if (!['capture', 'insert', 'remove', 'restore', 'clear'].includes(kind)) return;
    pendingLibraryKinds.add(kind);
    const changedIds = Array.isArray(event.data?.ids) ? event.data.ids.slice(0, 1000) : [];
    for (const id of changedIds) {
      if (pendingLibraryIds.size < 1000 || pendingLibraryIds.has(String(id))) pendingLibraryIds.add(String(id));
      else pendingLibraryTruncated = true;
    }
    pendingLibraryTruncated ||= !!event.data?.truncated;
    scheduleLibraryChangeDrain();
  };

  async function trashPosts(ids, { ask = true } = {}) {
    if (mutationBusy) return;
    if (
      !ids.length ||
      (ask && !confirm(`Move ${ids.length} selected posts to local Trash? Downloaded files stay on disk.`))
    )
      return;
    const moved = new Set();
    mutationBusy = true;
    let conflicts = 0;
    try {
      for (let start = 0; start < ids.length; start += 200) {
        mutationProgress = `Moving to Trash · ${fmt(start)} / ${fmt(ids.length)}`;
        updateSelectionBar();
        const result = await call({ type: 'MOVE_TWEETS_TO_TRASH', ids: ids.slice(start, start + 200) });
        if (!result?.ok) throw Error(result?.error || 'Trash change failed');
        for (const id of result.ids || []) moved.add(String(id));
        conflicts += result.conflicts?.length || 0;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      toast(
        `${fmt(moved.size)} ${moved.size === 1 ? 'post' : 'posts'} moved to Trash.${conflicts ? ` ${conflicts} existing Trash copies preserved.` : ''} Undo is in the bar below the library.`
      );
    } catch (error) {
      toast(`Moved ${fmt(moved.size)} posts before stopping: ${error.message}. Undo remains available.`);
    } finally {
      const undoIds = [...new Set([...lastTrashed, ...moved])];
      undoLimited = undoLimited || undoIds.length > 1000;
      lastTrashed = undoIds.slice(-1000);
      library = library.filter(row => !moved.has(String(row.id)));
      for (const id of moved) selected.delete(id);
      mutationBusy = false;
      mutationProgress = '';
      invalidateQueryCache();
      renderLib();
      updateSelectionBar();
      document.dispatchEvent(new Event('xv:trash-updated'));
      await refreshTrashUndo();
    }
  }

  async function undoTrash() {
    if (!lastTrashed.length || mutationBusy) return;
    mutationBusy = true;
    const ids = [...lastTrashed],
      restoredIds = new Set(),
      restoredRows = [];
    let conflicts = 0,
      errorMessage = '';
    try {
      for (let start = 0; start < ids.length; start += 200) {
        mutationProgress = `Restoring · ${fmt(start)} / ${fmt(ids.length)}`;
        updateSelectionBar();
        const result = await call({ type: 'RESTORE_TWEETS_FROM_TRASH', ids: ids.slice(start, start + 200) });
        if (!result?.ok) throw Error(result?.error || 'Restore failed');
        for (const id of result.ids || []) restoredIds.add(String(id));
        restoredRows.push(...(result.rows || []));
        conflicts += result.conflicts?.length || 0;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } catch (error) {
      errorMessage = error.message;
    } finally {
      lastTrashed = lastTrashed.filter(id => !restoredIds.has(id));
      mutationBusy = false;
      mutationProgress = '';
      updateSelectionBar();
      if (restoredRows.length === restoredIds.size) await applyRestoredRecords(restoredRows);
      else await loadLib(); // Compatibility with older message handlers.
      document.dispatchEvent(new Event('xv:trash-updated'));
      toast(
        `${fmt(restoredIds.size)} posts restored.${conflicts ? ` ${conflicts} newer archive copies preserved; older copies remain in Trash.` : ''}${errorMessage ? ` Stopped: ${errorMessage}. You can retry Undo.` : ''}`
      );
    }
  }

  async function saveView() {
    const query = $('#search').value.trim();
    if (!query) return toast('Enter a search first');
    const input = $('#libraryViewName');
    const name = input.value.trim();
    if (!name) {
      input.focus();
      return toast('Name the search, then save it');
    }
    const collection = {
      id: crypto.randomUUID(),
      name: name.slice(0, 48),
      query,
      sort: $('#sort').value,
      view: $('#libraryView').value,
      icon: $('#libraryCollectionIcon')?.value || 'saved',
      createdAt: Date.now(),
    };
    try {
      const result = await call({ type: 'UPDATE_SMART_COLLECTIONS', change: { op: 'save', collection } });
      if (!result?.ok) throw Error(result?.error || 'Could not save collection');
      settings.savedViews = result.settings?.savedViews || settings.savedViews || [];
      input.value = '';
      renderSavedViews();
      toast(`${result.updated ? 'Updated' : 'Saved'} Smart Collection · “${collection.name}”`);
    } catch (error) {
      toast(error.message || 'Could not save collection');
    }
  }

  function renderSavedViews() {
    const target = $('#facetViews');
    if (!target) return;
    const views = settings.savedViews || [];
    target.replaceChildren(
      ...views.map((view, index) => {
        const normalized = window.XVaultCollections?.normalizeDefinition?.(view, index) || {
          id: String(index),
          icon: 'saved',
          name: view.name || 'Untitled',
          query: view.query || '',
        };
        const row = document.createElement('div');
        row.className = 'facet-row';
        row.dataset.collectionId = normalized.id;
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'facet-item';
        open.dataset.viewIndex = String(index);
        open.title = normalized.query;
        const icon = document.createElement('span');
        icon.className = 'facet-icon';
        icon.innerHTML = window.XVaultIcons?.svg(normalized.icon) || '';
        const label = document.createElement('span');
        label.className = 'facet-name';
        label.textContent = normalized.name;
        open.append(icon, label);
        const reorder = document.createElement('span');
        reorder.className = 'facet-reorder';
        for (const [delta, iconName, labelText] of [
          [-1, 'previous', 'Move up'],
          [1, 'next', 'Move down'],
        ]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'quiet facet-move';
          button.dataset.viewMove = String(delta);
          button.dataset.viewId = normalized.id;
          button.setAttribute('aria-label', `${labelText} ${normalized.name}`);
          button.title = labelText;
          button.disabled = index + delta < 0 || index + delta >= views.length;
          button.innerHTML = window.XVaultIcons?.svg(iconName) || (delta < 0 ? '↑' : '↓');
          reorder.append(button);
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'quiet facet-remove';
        remove.dataset.viewRemove = normalized.id;
        remove.setAttribute('aria-label', `Remove Smart Collection ${normalized.name}`);
        remove.textContent = '×';
        row.append(open, reorder, remove);
        return row;
      })
    );
    if (!views.length) {
      const hint = document.createElement('p');
      hint.className = 'facet-hint';
      hint.textContent = 'Save a query as a live collection. Its membership follows your archive.';
      target.append(hint);
    }
  }

  async function openView(index) {
    const view = settings.savedViews?.[index];
    if (!view) return;
    $('#search').value = view.query;
    $('#sort').value = view.sort || 'new';
    $('#libraryView').value = view.view || 'timeline';
    await save({ libraryView: $('#libraryView').value, librarySort: $('#sort').value }, false);
    renderLib();
  }

  async function deleteView(index) {
    const view = settings.savedViews?.find(
      (value, position) =>
        String(value.id || window.XVaultCollections?.normalizeDefinition?.(value, position)?.id || position) ===
        String(index)
    );
    if (!view) return;
    if (
      !confirm(
        `Remove the Smart Collection “${view.name}”? Its query definition is removed; your posts are not affected.`
      )
    )
      return;
    const id = String(view.id || window.XVaultCollections?.normalizeDefinition?.(view)?.id || index);
    const result = await call({ type: 'UPDATE_SMART_COLLECTIONS', change: { op: 'remove', id } });
    if (!result?.ok) return toast(result?.error || 'Could not remove collection');
    settings.savedViews = result.settings?.savedViews || [];
    renderSavedViews();
    toast(`Removed “${view.name}”`);
  }

  async function moveView(id, delta) {
    const result = await call({ type: 'UPDATE_SMART_COLLECTIONS', change: { op: 'move', id, delta } });
    if (!result?.ok) return toast(result?.error || 'Could not reorder collections');
    settings.savedViews = result.settings?.savedViews || settings.savedViews || [];
    renderSavedViews();
    const row = $('#facetViews [data-collection-id="' + CSS.escape(String(id)) + '"]');
    row?.querySelector('[data-view-index]')?.focus({ preventScroll: true });
  }

  function exportSmartCollections() {
    const rows = settings.savedViews || [];
    if (!rows.length) return toast('There are no Smart Collections to export');
    const text = window.XVaultCollections.exportPortable(rows);
    download(text, `xvault-collections-${stamp()}.json`, 'application/json');
    toast(`${rows.length} query definitions exported · no posts included`);
  }

  function showCollectionImportDialog(plan, fileText) {
    const dialog = document.createElement('dialog');
    dialog.className = 'xv-collection-import';
    dialog.setAttribute('aria-labelledby', 'xvCollectionImportTitle');
    dialog.innerHTML =
      '<form method="dialog"><header><div><small>PORTABLE QUERY DEFINITIONS</small><h2 id="xvCollectionImportTitle">Import Smart Collections</h2></div><button type="submit" value="cancel" class="quiet" aria-label="Cancel import">×</button></header><p class="xv-collection-import-explain">Collections contain search rules and display choices. They do not include posts or media. Existing collections will never be replaced.</p><div class="xv-collection-import-counts" role="status"></div><ol class="xv-collection-import-list"></ol><p class="xv-collection-import-error" role="alert" hidden></p><footer><button type="submit" value="cancel" class="quiet">Cancel</button><button type="button" data-import-policy="skip"></button><button type="button" data-import-policy="keep-both" class="primary"></button></footer></form>';
    const counts = dialog.querySelector('.xv-collection-import-counts');
    counts.textContent = `${plan.counts.add} new · ${plan.counts.identical} already present · ${plan.counts.conflict} name/rule conflicts · ${plan.counts.invalid} invalid`;
    const list = dialog.querySelector('.xv-collection-import-list');
    for (const item of plan.items.slice(0, 12)) {
      const li = document.createElement('li'),
        name = document.createElement('b'),
        query = document.createElement('code'),
        state = document.createElement('span');
      name.textContent = item.collection.name;
      query.textContent = item.collection.query;
      state.textContent = `${item.action}${item.reason ? ` · ${item.reason}` : ''}`;
      li.dataset.state = item.action;
      li.append(name, query, state);
      list.append(li);
    }
    for (const item of plan.invalid.slice(0, 4)) {
      const li = document.createElement('li');
      li.dataset.state = 'invalid';
      li.textContent = item.error;
      list.append(li);
    }
    if (plan.items.length + plan.invalid.length > 16) {
      const more = document.createElement('li');
      more.className = 'quiet';
      more.textContent = `Preview shows 16 of ${plan.items.length + plan.invalid.length} entries.`;
      list.append(more);
    }
    const safe = dialog.querySelector('[data-import-policy="skip"]'),
      keep = dialog.querySelector('[data-import-policy="keep-both"]');
    safe.textContent = `Import ${plan.counts.add} new · skip conflicts`;
    safe.disabled = plan.counts.add === 0;
    keep.textContent = plan.counts.conflict
      ? `Keep both · ${plan.counts.add + plan.counts.conflict} additions`
      : `Import ${plan.counts.add} new`;
    keep.disabled = plan.counts.add + plan.counts.conflict === 0;
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    for (const button of [safe, keep])
      button.addEventListener('click', async () => {
        button.disabled = true;
        safe.disabled = true;
        keep.disabled = true;
        const error = dialog.querySelector('.xv-collection-import-error');
        error.hidden = true;
        try {
          const result = await call({
            type: 'UPDATE_SMART_COLLECTIONS',
            change: { op: 'import', fileText, conflicts: button.dataset.importPolicy },
          });
          if (!result?.ok) throw Error(result?.error || 'Import could not be saved');
          settings.savedViews = result.settings?.savedViews || settings.savedViews || [];
          renderSavedViews();
          dialog.close();
          toast(
            `${result.added || 0} added · ${result.skipped || 0} skipped${result.invalid ? ` · ${result.invalid} invalid` : ''}`
          );
        } catch (reason) {
          error.textContent = reason.message || 'Import could not be saved';
          error.hidden = false;
          safe.disabled = plan.counts.add === 0;
          keep.disabled = plan.counts.add + plan.counts.conflict === 0;
        }
      });
    dialog.showModal();
    (safe.disabled ? keep : safe).focus();
  }

  async function importSmartCollections(event) {
    const input = event.currentTarget,
      file = input.files?.[0];
    if (!file) return;
    try {
      const fileText = await file.text();
      const plan = window.XVaultCollections.previewImport(fileText, settings.savedViews || []);
      showCollectionImportDialog(plan, fileText);
    } catch (error) {
      toast(error.message || 'This Smart Collection file could not be read');
    } finally {
      input.value = '';
    }
  }

  async function bulkDownload() {
    const posts = library.filter(post => selected.has(String(post.id)));
    const items = posts.flatMap(post =>
      (post.media || []).map((media, index) => downloadItem(post, media, index)).filter(Boolean)
    );
    if (!items.length) return toast('Selected posts contain no downloadable media');
    const result = await call({ type: 'DOWNLOAD_URLS', items });
    toast(
      result?.ok
        ? `${result.added || 0} media queued · ${result.skipped || 0} skipped`
        : result?.error || 'Could not queue selected media'
    );
  }

  function bulkExport() {
    const posts = library.filter(post => selected.has(String(post.id)));
    download(
      JSON.stringify({ format: 'xvault-selection-v1', exportedAt: new Date().toISOString(), posts }, null, 2),
      `xvault-selection-${stamp()}.json`,
      'application/json'
    );
    toast(`${posts.length} posts exported`);
  }

  async function helperToken() {
    const port = Number(settings.helperPort) || 17843;
    let token = (await chrome.storage.local.get('helperAuthToken')).helperAuthToken || '';
    if (token) return token;
    const response = await fetch(`http://127.0.0.1:${port}/bootstrap`, { cache: 'no-store' });
    if (!response.ok) throw Error('Helper is unavailable');
    token = (await response.json()).token;
    if (!token) throw Error('Helper token unavailable');
    await chrome.storage.local.set({ helperAuthToken: token });
    return token;
  }

  async function helperBlob(path) {
    if (helperPool.get(path)) return helperPool.get(path);
    if (helperPending.has(path)) return helperPending.get(path);
    const pending = fetchHelperBlob(path);
    helperPending.set(path, pending);
    try {
      return await pending;
    } finally {
      helperPending.delete(path);
    }
  }

  async function fetchHelperBlob(path) {
    const port = Number(settings.helperPort) || 17843;
    let token = await helperToken();
    let response = await fetch(`http://127.0.0.1:${port}/media?path=${encodeURIComponent(path)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (response.status === 401) {
      await chrome.storage.local.remove('helperAuthToken');
      token = await helperToken();
      response = await fetch(`http://127.0.0.1:${port}/media?path=${encodeURIComponent(path)}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
    }
    if (!response.ok) throw Error(`Helper returned ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw Error('Helper returned an empty file');
    return helperPool.add(path, blob);
  }

  function releaseHelperElement(element) {
    const path = element.dataset.helperPath;
    if (!path) return;
    helperPool.detach(path, element);
    if (element.getAttribute('src')?.startsWith('blob:')) {
      if (element.tagName === 'VIDEO') element.pause();
      element.removeAttribute('src');
      if (element.tagName === 'VIDEO') element.load();
    }
  }

  function releaseHelperMedia(root) {
    const elements = root?.matches?.('[data-helper-path]') ? [root] : [];
    for (const element of [...elements, ...(root?.querySelectorAll?.('[data-helper-path]') || [])]) {
      helperObserver?.unobserve(element);
      releaseHelperElement(element);
    }
    helperPool.collect();
  }
  window.XVaultReleaseHelperMedia = releaseHelperMedia;

  function pumpHelperQueue() {
    while (helperActive < 3 && helperQueue.length) {
      const { element, path } = helperQueue.shift();
      if (!element.isConnected || (element.closest('#list') && element.dataset.helperVisible !== '1')) continue;
      helperActive++;
      helperBlob(path)
        .then(() => {
          if (element.isConnected && (!element.closest('#list') || element.dataset.helperVisible === '1')) {
            const ownedUrl = helperPool.attach(path, element);
            if (ownedUrl) element.src = ownedUrl;
            else helperQueue.push({ element, path });
          }
        })
        .catch(() => {
          if (!element.isConnected) return;
          element.dataset.helperFailed = 'true';
          if (element.closest('#lbContent')) {
            const item = lightboxItems[lightboxIndex];
            const source = item && mediaSource(item.m);
            if (source?.src) {
              if (source.native) element.src = source.src;
              else {
                const video = document.createElement('video');
                video.src = source.src;
                video.controls = true;
                video.loop = true;
                video.playsInline = true;
                element.replaceWith(video);
                installPlayer(video);
              }
            }
          } else element.dispatchEvent(new Event('error'));
        })
        .finally(() => {
          helperActive--;
          setTimeout(() => helperPool.collect(), 0);
          pumpHelperQueue();
        });
    }
  }

  // One observer for the whole Library list: blocks mounted by library-feed.js and windowed rows register their
  // helper-served media as they appear and unregister when they are released.
  function listHelperObserver() {
    helperObserver ||= new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            entry.target.dataset.helperVisible = '0';
            releaseHelperElement(entry.target);
            continue;
          }
          entry.target.dataset.helperVisible = '1';
          const path = entry.target.dataset.helperPath;
          if (path && !entry.target.getAttribute('src')?.startsWith('blob:'))
            helperQueue.push({ element: entry.target, path });
        }
        pumpHelperQueue();
      },
      { root: $('#libraryScroll'), rootMargin: '320px 0px' }
    );
    return helperObserver;
  }
  function hydrateHelperMedia(root) {
    const inList = root?.id === 'list' || !!root?.closest?.('#list');
    for (const element of root?.querySelectorAll?.('img[src*="#xvhelper="],video[src*="#xvhelper="]') || []) {
      const marker = element.getAttribute('src')?.split('#xvhelper=')[1];
      if (!marker) continue;
      const path = decodeURIComponent(marker);
      element.dataset.helperPath = path;
      if (inList) listHelperObserver().observe(element);
      else helperQueue.push({ element, path });
    }
    pumpHelperQueue();
  }
  window.XVaultObserveHelperMedia = nodes => {
    for (const node of nodes || []) hydrateHelperMedia(node);
  };
  window.XVaultHydrateHelperMedia = hydrateHelperMedia;

  const workspaceRenderLightbox = function () {
    releaseHelperMedia($('#lbContent'));
    baseLightbox();
    const context = window.XVaultLightboxContext?.();
    const saved = context ? window.XVaultMediaMetadata.metadataFor(context.media) : null;
    let video = $('#lbContent video');
    // An animated derivative may be shown as an <img>. If it has timestamp
    // notes, use the seekable captured video source so those notes stay usable.
    if (
      !video &&
      context &&
      saved?.annotations?.some(item => !item.deletedAt) &&
      window.XVaultMediaMetadata.canTimestamp(context.media)
    ) {
      const source = bestVariant(context.media) || context.media.playbackUrl || context.media.url;
      if (source) {
        $('#lbContent').className = 'lbContent videoMode';
        $('#lbContent').innerHTML =
          `<div class="lbVideoShell"><video src="${esc(source)}" controls autoplay loop playsinline></video><div class="playerGlow"></div></div>`;
        video = $('#lbContent video');
      }
    }
    hydrateHelperMedia($('#lbContent'));
    if (video) installPlayer(video);
    renderMediaAnnotations(video);
  };
  window.XVaultDashboard.provide('renderLightbox', builtin => {
    baseLightbox = builtin;
    return workspaceRenderLightbox;
  });

  function installPlayer(video) {
    const meta = $('#lbMeta');
    if (!meta) return;
    const context = window.XVaultLightboxContext?.(),
      sourceOptions = context ? mediaSourceOptions(context) : [];
    const initialSource = video.getAttribute('src') || '';
    video.dataset.xvMediaKey = context?.mediaKey || '';
    video.dataset.xvSelectedVariant =
      !sourceOptions.length || sourceOptions[0].src === initialSource
        ? 'source'
        : sourceOptions.find(item => item.src === initialSource)?.id || 'derivative';
    const toolbar = document.createElement('div');
    toolbar.className = 'xv-player-tools';
    toolbar.innerHTML = `<div class="xv-player-time" id="xvPlayerTime">0:00 / 0:00</div><div class="xv-buffer"><i></i></div><div class="xv-player-buttons"><button type="button" data-player="play" aria-label="Play or pause video">Pause</button><button type="button" data-player="add-annotation" title="Add a timestamp note at the current position (A)">Add video note · A</button><button type="button" data-player="back" title="Previous frame">− frame</button><button type="button" data-player="forward" title="Next frame">+ frame</button><select id="xvPlaybackRate" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select><button type="button" data-player="loop">Loop</button><button type="button" data-player="pip">Picture in picture</button><button type="button" data-player="full">Fullscreen</button></div><small>Space play · J/L seek · K pause · [/] frame · A note · F fullscreen</small>`;
    meta.prepend(toolbar);
    const time = toolbar.querySelector('#xvPlayerTime'),
      buffer = toolbar.querySelector('.xv-buffer i');
    const format = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    const update = () => {
      time.textContent = `${format(video.currentTime || 0)} / ${format(video.duration || 0)}`;
      toolbar.querySelector('[data-player="play"]').textContent = video.paused ? 'Play' : 'Pause';
      toolbar.querySelector('[data-player="loop"]').classList.toggle('active', video.loop);
      const end = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
      buffer.style.transform = `scaleX(${video.duration ? Math.min(1, end / video.duration) : 0})`;
    };
    video.addEventListener('timeupdate', () => {
      mediaTimes.set(video.currentSrc || video.src, video.currentTime);
      update();
    });
    video.addEventListener('progress', update);
    video.addEventListener('play', update);
    video.addEventListener('pause', update);
    video.addEventListener(
      'loadedmetadata',
      () => {
        const saved = mediaTimes.get(video.currentSrc || video.src);
        if (saved > 0 && saved < video.duration - 1) video.currentTime = saved;
        update();
      },
      { once: true }
    );
    toolbar.onclick = async event => {
      const action = event.target.closest('[data-player]')?.dataset.player;
      if (action === 'play') video.paused ? video.play().catch(() => {}) : video.pause();
      if (action === 'add-annotation') openAnnotationComposer(video);
      if (action === 'back') video.currentTime = Math.max(0, video.currentTime - 1 / 30);
      if (action === 'forward') video.currentTime = Math.min(video.duration || 0, video.currentTime + 1 / 30);
      if (action === 'loop') video.loop = !video.loop;
      if (action === 'pip') {
        try {
          await video.requestPictureInPicture();
        } catch {
          toast('Picture in picture is unavailable for this video');
        }
      }
      if (action === 'full') {
        try {
          await video.requestFullscreen();
        } catch {
          toast('Fullscreen is unavailable');
        }
      }
      update();
    };
    toolbar.querySelector('#xvPlaybackRate').onchange = event => {
      video.playbackRate = Number(event.target.value);
    };
    update();
  }

  function annotationDraftKey(context, id = 'new') {
    return `xv-media-annotation:${encodeURIComponent(context.postId)}:${encodeURIComponent(context.mediaKey)}:${encodeURIComponent(id)}`;
  }
  function readAnnotationDraft(context, id = 'new') {
    try {
      const draft = JSON.parse(localStorage.getItem(annotationDraftKey(context, id)) || 'null');
      return draft && typeof draft === 'object' ? draft : null;
    } catch {
      return null;
    }
  }
  function writeAnnotationDraft(context, draft, id = 'new') {
    try {
      localStorage.setItem(annotationDraftKey(context, id), JSON.stringify({ ...draft, savedAt: Date.now() }));
      return true;
    } catch {
      return false;
    }
  }
  function clearAnnotationDraft(context, id = 'new') {
    try {
      localStorage.removeItem(annotationDraftKey(context, id));
    } catch {}
  }

  function mediaSourceOptions(context) {
    const media = context.media,
      rows = libraryDownloads.get(String(context.postId)) || [],
      urls = new Set([media.url, media.playbackUrl, ...(media.variants || []).map(item => item.url)].filter(Boolean));
    const matches = rows.filter(
      row =>
        String(row.item?.tweetId || '') === context.postId &&
        ((media.id && String(row.item?.mediaId || '') === String(media.id)) ||
          [...urls].some(url => url === row.item?.url || window.XVaultMediaAsset?.sameAsset(url, row.item?.url)))
    );
    const original = bestVariant(media) || media.playbackUrl || media.url;
    const sourceKind = String(media.type || '')
      .toLowerCase()
      .includes('video')
      ? 'video'
      : String(media.type || 'media');
    const options = original
      ? [{ id: 'source', label: `Captured original · ${sourceKind}`, src: original, original: true }]
      : [];
    for (const [index, variant] of (media.variants || []).entries()) {
      const src = variant?.url,
        type = String(variant?.contentType || variant?.type || '').toLowerCase();
      if (
        !src ||
        !(type.startsWith('video/') || /\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/i.test(src)) ||
        options.some(item => item.src === src)
      )
        continue;
      options.push({
        id: `source-variant-${index}`,
        label: `Captured source variant${variant.bitrate ? ` · ${Math.round(Number(variant.bitrate) / 1000)} kb/s` : ''}`,
        src,
        original: true,
      });
    }
    for (const row of matches) {
      const path =
        row.state === 'complete' &&
        !row.conversionExpected &&
        String(row.target?.kind || row.item?.mediaType || '').toLowerCase() === 'video'
          ? row.target?.filename || row.filename
          : '';
      if (!path) continue;
      const src =
        settings.helperPreferHttpPreview !== false
          ? helperMediaUrl(path)
          : row.localFileUrl || row.target?.fileUrl || '';
      if (!src || options.some(item => item.src === src)) continue;
      options.push({
        id: `local-original-${String(row.key || options.length)}`,
        label: `Local original · ${basenameMedia(path)}`,
        src,
        original: true,
        path,
      });
    }
    return options;
  }

  function isOriginalVariant(context, variantId) {
    return variantId === 'source' || mediaSourceOptions(context).some(item => item.id === variantId && item.original);
  }

  function refreshMediaRecord(row, focus = '') {
    const id = String(row?.id || ''),
      existing = library.find(post => String(post.id) === id);
    if (existing) Object.assign(existing, row);
    window.XVaultRefreshQuickLookRecord?.(row);
    window.XVaultRefreshInspectorRecord?.(row);
    if (focus) {
      const active = document.activeElement;
      if (active?.matches?.('[data-annotation-focus]')) active.dataset.annotationFocus = focus;
    }
    window.XVaultRefreshLightboxRecord?.(row);
  }

  function waitForVideoMetadata(video, timeout = 9000) {
    if (video.readyState >= 1 && (Number.isFinite(video.duration) || video.duration === Infinity))
      return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', ready);
        video.removeEventListener('error', failed);
        resolve(value);
      };
      const ready = () => finish(Number.isFinite(video.duration) || video.duration === Infinity);
      const failed = () => finish(false);
      const timer = setTimeout(() => finish(false), timeout);
      video.addEventListener('loadedmetadata', ready, { once: true });
      video.addEventListener('error', failed, { once: true });
    });
  }

  async function selectMediaSource(video, context, sourceId, sources = mediaSourceOptions(context), keepTime = true) {
    const source = sources.find(item => item.id === sourceId);
    if (!source || !video) return false;
    const previousSource = video.getAttribute('src') || '',
      previousVariant = video.dataset.xvSelectedVariant || 'source';
    const time = keepTime && Number.isFinite(video.currentTime) ? video.currentTime : 0,
      wasPlaying = !video.paused,
      rate = video.playbackRate,
      muted = video.muted,
      loop = video.loop;
    video.pause();
    video.dataset.xvSelectedVariant = source.id;
    video.dataset.xvMediaKey = context.mediaKey;
    video.src = source.src;
    video.load();
    hydrateHelperMedia($('#lbContent'));
    const ready = await waitForVideoMetadata(video);
    if (!ready) {
      video.dataset.xvSelectedVariant = previousVariant;
      if (previousSource) video.setAttribute('src', previousSource);
      else video.removeAttribute('src');
      video.load();
      hydrateHelperMedia($('#lbContent'));
      const priorReady = await waitForVideoMetadata(video, 3000);
      if (priorReady) {
        video.playbackRate = rate;
        video.muted = muted;
        video.loop = loop;
        if (keepTime && Number.isFinite(video.duration) && time < video.duration)
          try {
            video.currentTime = time;
          } catch {}
        if (wasPlaying) video.play().catch(() => {});
      }
      const status = $('#xvAnnotationStatus');
      if (status)
        status.textContent = priorReady
          ? `${source.label} is unavailable; the previous preview was restored. Saved notes are unchanged.`
          : `${source.label} is unavailable. Saved notes are retained.`;
      return false;
    }
    video.playbackRate = rate;
    video.muted = muted;
    video.loop = loop;
    if (keepTime && Number.isFinite(video.duration) && time < video.duration)
      try {
        video.currentTime = time;
      } catch {}
    if (wasPlaying) video.play().catch(() => {});
    return true;
  }

  async function seekVideoTo(video, context, atMs, sources) {
    if (!video || !Number.isSafeInteger(atMs) || atMs < 0) return false;
    let ready = await waitForVideoMetadata(video);
    if (!ready) return false;
    // Annotation offsets are anchored to the captured original. A generated
    // GIF/WebP can have a different duration or frame rate, so never seek it
    // as if it shared the source timeline.
    if (!isOriginalVariant(context, video.dataset.xvSelectedVariant || 'source')) {
      if (!(await selectMediaSource(video, context, 'source', sources, false))) return false;
      ready = await waitForVideoMetadata(video);
    }
    const target = atMs / 1000;
    if (
      video.seekable.length &&
      !Array.from({ length: video.seekable.length }, (_, index) => [
        video.seekable.start(index),
        video.seekable.end(index),
      ]).some(([start, end]) => target >= start && target <= end)
    )
      return false;
    if (!ready || (Number.isFinite(video.duration) && target > video.duration)) return false;
    try {
      if (Math.abs(video.currentTime - target) < 0.002) return true;
      const seeked = new Promise(resolve => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          video.removeEventListener('seeked', done);
          resolve(true);
        };
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          video.removeEventListener('seeked', done);
          resolve(false);
        }, 5000);
        video.addEventListener('seeked', done, { once: true });
      });
      video.currentTime = target;
      return await seeked;
    } catch {
      return false;
    }
  }

  async function seekMediaAnnotation(mediaKey, annotationId) {
    const context = window.XVaultLightboxContext?.();
    if (!context || context.mediaKey !== String(mediaKey || '')) return false;
    const annotation = window.XVaultMediaMetadata.metadataFor(context.media).annotations.find(
      item => String(item.id) === String(annotationId) && !item.deletedAt
    );
    if (!annotation) return false;
    const video = $('#lbContent video'),
      sources = mediaSourceOptions(context),
      status = $('#xvAnnotationStatus');
    const sought = await seekVideoTo(video, context, annotation.atMs, sources);
    if (status)
      status.textContent = sought
        ? `Playing from ${window.XVaultMediaMetadata.formatTimestamp(annotation.atMs)}`
        : 'This timestamp is unavailable in the current source. The annotation remains saved.';
    if (sought) {
      requestAnimationFrame(() => {
        const pane = $('#lbMeta'),
          row = pane?.querySelector(`[data-annotation-row][data-annotation-id="${CSS.escape(String(annotationId))}"]`);
        if (!pane || !row) return;
        const paneRect = pane.getBoundingClientRect(),
          rowRect = row.getBoundingClientRect(),
          inset = 10;
        const delta =
          rowRect.top < paneRect.top + inset
            ? rowRect.top - paneRect.top - inset
            : rowRect.bottom > paneRect.bottom - inset
              ? rowRect.bottom - paneRect.bottom + inset
              : 0;
        if (delta)
          pane.scrollBy({ top: delta, behavior: document.body.dataset.motion === 'normal' ? 'smooth' : 'auto' });
      });
    }
    return sought;
  }
  window.XVaultSeekMediaAnnotation = seekMediaAnnotation;

  function openAnnotationComposer(video) {
    const context = window.XVaultLightboxContext?.(),
      form = $('#xvMediaAnnotationForm'),
      editor = form?.querySelector('[name="text"]');
    if (!context || !form || !editor) return;
    const status = $('#xvAnnotationStatus');
    if (!isOriginalVariant(context, video?.dataset.xvSelectedVariant || 'source')) {
      if (status)
        status.textContent = 'Timestamp notes use the captured original. Switch back to it before adding a note.';
      return;
    }
    const draft = readAnnotationDraft(context);
    const atMs = draft ? Number(draft.atMs) : Math.max(0, Math.round((Number(video?.currentTime) || 0) * 1000));
    form.dataset.atMs = String(atMs);
    const label = form.querySelector('[data-annotation-time]');
    if (label) label.textContent = window.XVaultMediaMetadata.formatTimestamp(atMs);
    if (draft) {
      editor.value = String(draft.text || '');
      form.querySelector('[data-annotation-draft-status]').textContent = 'Draft retained on this device';
    }
    form.hidden = false;
    editor.focus();
  }

  function sourceHasVideoTimeline(context, source) {
    const media = context?.media || {};
    const type = String(media.type || '').toLowerCase();
    return (
      type === 'video' ||
      Boolean(media.playbackUrl) ||
      (media.variants || []).some(item => /^video\//i.test(item?.contentType || item?.type || '')) ||
      /\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/i.test(source?.src || '')
    );
  }

  function renderMediaAnnotations(video) {
    const context = window.XVaultLightboxContext?.();
    if (!context) return;
    const metadata = window.XVaultMediaMetadata,
      mediaMeta = metadata.metadataFor(context.media),
      timed = metadata.canTimestamp(context.media);
    const notes = [],
      invalid = [];
    for (const candidate of mediaMeta.annotations) {
      try {
        notes.push(metadata.validateAnnotation(candidate));
      } catch {
        invalid.push(candidate);
      }
    }
    const active = notes
      .filter(item => !item.deletedAt)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
    const removed = notes.filter(item => item.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
    const sources = timed ? mediaSourceOptions(context) : [];
    const currentVariant = video?.dataset.xvSelectedVariant || 'source';
    const canAdd = Boolean(video && isOriginalVariant(context, currentVariant));
    const canOpenSource = !video && sources.length > 0 && sourceHasVideoTimeline(context, sources[0]);
    let sourceHref = '';
    try {
      const url = new URL(mediaMeta.sourceUrl);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) sourceHref = url.href;
    } catch {}
    const tags = mediaMeta.tags.slice(0, 24);
    const mediaHasMetadata = mediaMeta.note || tags.length || mediaMeta.source || sourceHref;
    const mediaNotePreview = mediaMeta.note
      ? `${esc(mediaMeta.note.slice(0, 280))}${mediaMeta.note.length > 280 ? '…' : ''}`
      : '';
    const mediaBlock = mediaHasMetadata
      ? `<section class="xv-viewer-media-meta" aria-label="Per-media metadata"><b>Media metadata</b>${mediaMeta.note ? `<p class="xv-media-note-preview">${mediaNotePreview}</p>${mediaMeta.note.length > 280 ? `<details><summary>Read full media note · ${fmt(mediaMeta.note.length)} characters</summary><p>${esc(mediaMeta.note)}</p></details>` : ''}` : ''}${tags.length ? `<p class="xv-viewer-tags">${tags.map(tag => `<span>#${esc(tag)}</span>`).join(' ')}${mediaMeta.tags.length > tags.length ? ` <small>+${mediaMeta.tags.length - tags.length} more labels</small>` : ''}</p>` : ''}${mediaMeta.source ? `<small>Credit · ${esc(mediaMeta.source)}</small>` : ''}${sourceHref ? `<a href="${esc(sourceHref)}" target="_blank" rel="noopener noreferrer">Open source credit</a>` : ''}</section>`
      : '';
    const sourcePicker =
      video && sources.length > 1
        ? `<label class="xv-derivative-switch"><span>Preview file</span><select data-annotation-focus="variant" aria-describedby="xvVariantHint">${sources.map(item => `<option value="${esc(item.id)}" ${item.id === currentVariant ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select><small id="xvVariantHint">Notes use the captured original timeline. Seeking a note switches back to the original.</small></label>`
        : '';
    const addControl = video
      ? `<button type="button" data-annotation-add data-annotation-focus="add" ${canAdd ? '' : 'disabled'} title="A · note at the captured original position">${canAdd ? 'Add at current time' : 'Switch to original to add'}</button>`
      : canOpenSource
        ? `<button type="button" data-annotation-open-source>Open captured video</button>`
        : '<button type="button" disabled>Seekable original unavailable</button>';
    const truncatedText = item =>
      item.text.length > 240
        ? `<p>${esc(item.text.slice(0, 240))}…</p><details><summary>Read full note · ${fmt(item.text.length)} characters</summary><p>${esc(item.text)}</p></details>`
        : `<p>${esc(item.text)}</p>`;
    const annotationRows = active
      .slice(0, 100)
      .map((item, index) => {
        const draft = readAnnotationDraft(context, item.id),
          stale = draft && Number(draft.expectedUpdatedAt) !== item.updatedAt;
        return `<li data-annotation-row data-annotation-id="${esc(item.id)}"><button type="button" class="xv-annotation-seek" data-annotation-seek="${esc(item.id)}" aria-label="Seek to ${metadata.formatTimestamp(item.atMs)}">${metadata.formatTimestamp(item.atMs)}</button><div class="xv-annotation-copy">${truncatedText(item)}<div class="xv-annotation-actions"><button type="button" data-annotation-edit="${esc(item.id)}" data-annotation-focus="edit-button:${esc(item.id)}">${draft ? 'Continue draft' : 'Edit'}</button><button type="button" data-annotation-up="${esc(item.id)}" data-annotation-focus="move:${esc(item.id)}" aria-label="Move note up" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-annotation-down="${esc(item.id)}" data-annotation-focus="move:${esc(item.id)}" aria-label="Move note down" ${index === active.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="quiet" data-annotation-delete="${esc(item.id)}" data-annotation-focus="delete:${esc(item.id)}">Remove</button></div><div class="xv-annotation-edit" ${draft ? '' : 'hidden'}><textarea maxlength="10000" rows="2" data-annotation-focus="edit:${esc(item.id)}" aria-label="Edit note at ${metadata.formatTimestamp(item.atMs)}">${esc(draft?.text ?? item.text)}</textarea>${stale ? `<div class="xv-annotation-conflict" role="alert"><b>Changed elsewhere</b><p>Saved: ${esc(item.text.slice(0, 500))}${item.text.length > 500 ? '…' : ''}</p><div><button type="button" class="quiet" data-annotation-use-saved="${esc(item.id)}" data-annotation-focus="use-saved:${esc(item.id)}">Use saved</button><button type="button" data-annotation-overwrite="${esc(item.id)}" data-annotation-focus="overwrite:${esc(item.id)}">Replace saved with my draft</button></div></div>` : ''}<div><span data-annotation-edit-status role="status"></span><button type="button" class="quiet" data-annotation-cancel-edit="${esc(item.id)}" data-annotation-focus="keep-edit:${esc(item.id)}">Keep draft</button><button type="button" class="quiet" data-annotation-discard-edit="${esc(item.id)}">Discard draft</button><button type="button" data-annotation-save-edit="${esc(item.id)}" data-annotation-focus="save-edit:${esc(item.id)}">Save edit</button></div></div></div></li>`;
      })
      .join('');
    const panel = timed
      ? `<section class="xv-annotation-panel" aria-labelledby="xvAnnotationTitle"><header><div><h4 id="xvAnnotationTitle">Video notes <span>${active.length}</span></h4><p>Timestamped to the captured original, with millisecond precision.</p></div>${addControl}</header>${sourcePicker}${mediaBlock}<form id="xvMediaAnnotationForm" class="xv-annotation-composer" hidden><label for="xvAnnotationNewText">Note at <time data-annotation-time>0:00.000</time></label><textarea id="xvAnnotationNewText" name="text" maxlength="10000" rows="2" data-annotation-focus="new-text" placeholder="What should you remember at this moment?"></textarea><div><span data-annotation-draft-status role="status"></span><button type="button" class="quiet" data-annotation-cancel data-annotation-focus="keep-new">Keep draft</button><button type="button" class="quiet" data-annotation-discard-new>Discard draft</button><button type="submit" class="primary" data-annotation-focus="save-new">Save note <kbd>Ctrl+Enter</kbd></button></div></form><ol class="xv-annotation-list" aria-label="Timestamped video notes">${annotationRows || '<li class="xv-annotation-empty">No timestamp notes yet. Pause on the captured original and add one.</li>'}${active.length > 100 ? `<li class="xv-annotation-overflow">Showing the first 100 of ${active.length} notes to keep the viewer responsive.</li>` : ''}${invalid.length ? `<li class="xv-annotation-invalid" role="alert">${invalid.length} saved annotation${invalid.length === 1 ? '' : 's'} could not be displayed. Their stored evidence has been left untouched.</li>` : ''}</ol>${
          removed.length
            ? `<details class="xv-annotation-removed"><summary>Removed notes · ${removed.length}</summary><ul>${removed
                .slice(0, 20)
                .map(
                  item =>
                    `<li><time>${metadata.formatTimestamp(item.atMs)}</time><span>${esc(item.text.slice(0, 300))}${item.text.length > 300 ? '…' : ''}</span><button type="button" data-annotation-restore="${esc(item.id)}" data-annotation-focus="restore:${esc(item.id)}">Undo</button></li>`
                )
                .join(
                  ''
                )}</ul>${removed.length > 20 ? `<small>Showing the latest 20 removed notes.</small>` : ''}</details>`
            : ''
        }<p id="xvAnnotationStatus" class="xv-annotation-status" role="status" aria-live="polite">${currentVariant !== 'source' ? 'Previewing a derivative · notes remain anchored to the captured original.' : ''}</p></section>`
      : `${mediaBlock}<section class="xv-viewer-media-meta" aria-label="Per-media metadata"><p class="xv-viewer-muted">${mediaHasMetadata ? '' : 'No per-media notes yet.'}</p><button type="button" data-annotation-inspect>Open media metadata in Inspector</button></section>`;
    const meta = $('#lbMeta');
    if (!meta) return;
    meta.querySelectorAll('.xv-viewer-media-meta,.xv-annotation-panel').forEach(node => node.remove());
    meta.insertAdjacentHTML('beforeend', panel);
    const form = $('#xvMediaAnnotationForm'),
      newDraft = form && readAnnotationDraft(context);
    if (form && newDraft) {
      form.hidden = false;
      form.dataset.atMs = String(Number(newDraft.atMs) || 0);
      form.querySelector('[data-annotation-time]').textContent = metadata.formatTimestamp(newDraft.atMs);
      form.querySelector('[name="text"]').value = String(newDraft.text || '');
      form.querySelector('[data-annotation-draft-status]').textContent = 'Draft retained on this device';
      const add = meta.querySelector('[data-annotation-add]');
      if (add) add.textContent = `Continue draft · ${metadata.formatTimestamp(newDraft.atMs)}`;
    }
    const status = $('#xvAnnotationStatus');
    let submitting = false;
    const submitNew = async () => {
      if (submitting) return;
      const textValue = String(form?.querySelector('[name="text"]')?.value || ''),
        atMs = Number(form?.dataset.atMs);
      if (!textValue.trim()) {
        if (status) status.textContent = 'Write a short note before saving.';
        form?.querySelector('[name="text"]')?.focus();
        return;
      }
      if (!Number.isSafeInteger(atMs) || atMs < 0) {
        if (status) status.textContent = 'The player time is unavailable.';
        return;
      }
      submitting = true;
      const save = form.querySelector('[type="submit"]');
      if (save) save.disabled = true;
      const annotation = {
        id: crypto.randomUUID(),
        atMs,
        position: active.length,
        text: textValue,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      try {
        const result = await call({
          type: 'UPDATE_MEDIA_METADATA',
          id: context.postId,
          mediaKey: context.mediaKey,
          change: { type: 'annotation-add', annotation },
        });
        if (!result?.ok) {
          if (status)
            status.textContent = result?.error || 'The note was not saved. Your local draft remains available.';
          return;
        }
        clearAnnotationDraft(context);
        refreshMediaRecord(result.row, 'add');
        toast(`Note saved at ${metadata.formatTimestamp(atMs)}`);
      } catch (error) {
        if (status) status.textContent = `Save failed · ${error.message}. Your local draft remains available.`;
      } finally {
        submitting = false;
        if (save?.isConnected) save.disabled = false;
      }
    };
    form?.addEventListener('input', () => {
      const draft = { text: form.querySelector('[name="text"]').value, atMs: Number(form.dataset.atMs) };
      const stored = writeAnnotationDraft(context, draft);
      form.querySelector('[data-annotation-draft-status]').textContent = stored
        ? 'Draft saved on this device'
        : 'Browser storage is full · keep this editor open until saved';
    });
    form?.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        void submitNew();
      }
    });
    form?.addEventListener('submit', event => {
      event.preventDefault();
      void submitNew();
    });
    meta.querySelector('[data-annotation-add]')?.addEventListener('click', () => openAnnotationComposer(video));
    meta.querySelector('[data-annotation-open-source]')?.addEventListener('click', () => {
      const source = sources[0];
      if (!source) return;
      const box = $('#lbContent');
      box.className = 'lbContent videoMode';
      box.innerHTML = `<div class="lbVideoShell"><video src="${esc(source.src)}" controls playsinline></video><div class="playerGlow"></div></div>`;
      $('#zoomDock').style.display = 'none';
      hydrateHelperMedia(box);
      const nextVideo = box.querySelector('video');
      installPlayer(nextVideo);
      renderMediaAnnotations(nextVideo);
      nextVideo.focus?.();
    });
    meta.querySelector('[data-annotation-cancel]')?.addEventListener('click', () => {
      if (form) {
        form.hidden = true;
        if (status) status.textContent = 'Draft kept on this device. Choose Continue draft to reopen it.';
      }
    });
    meta.querySelector('[data-annotation-discard-new]')?.addEventListener('click', () => {
      const value = form?.querySelector('[name="text"]')?.value || '';
      if (value.trim() && !confirm('Discard this timestamp note draft?')) return;
      clearAnnotationDraft(context);
      if (form) {
        form.querySelector('[name="text"]').value = '';
        form.hidden = true;
      }
      const add = meta.querySelector('[data-annotation-add]');
      if (add) add.textContent = 'Add at current time';
      if (status) status.textContent = 'Draft discarded.';
    });
    meta
      .querySelector('[data-annotation-inspect]')
      ?.addEventListener('click', () => window.openDetails(context.postId));
    meta.querySelector('[data-annotation-focus="variant"]')?.addEventListener('change', event => {
      const picker = event.currentTarget,
        selected = picker.value,
        target = sources.find(item => item.id === selected),
        add = meta.querySelector('[data-annotation-add]');
      if (add) {
        add.disabled = !isOriginalVariant(context, selected);
        add.textContent = add.disabled ? 'Switch to original to add' : 'Add at current time';
      }
      if (status)
        status.textContent = target?.path ? `Opening ${target.label}…` : `Using ${target?.label || 'selected source'}`;
      void selectMediaSource(video, context, selected, sources, true).then(ok => {
        if (ok) return;
        picker.value = video.dataset.xvSelectedVariant || 'source';
        if (add) {
          add.disabled = !isOriginalVariant(context, picker.value);
          add.textContent = add.disabled ? 'Switch to original to add' : 'Add at current time';
        }
      });
    });
    meta
      .querySelectorAll('[data-annotation-seek]')
      .forEach(button =>
        button.addEventListener(
          'click',
          () => void seekMediaAnnotation(context.mediaKey, button.dataset.annotationSeek)
        )
      );
    meta.querySelectorAll('[data-annotation-edit]').forEach(button =>
      button.addEventListener('click', () => {
        const row = button.closest('[data-annotation-row]'),
          editor = row.querySelector('.xv-annotation-edit'),
          area = editor.querySelector('textarea'),
          note = active.find(item => item.id === button.dataset.annotationEdit);
        let draft = readAnnotationDraft(context, note.id);
        if (!draft) {
          draft = { text: note.text, expectedUpdatedAt: note.updatedAt };
          writeAnnotationDraft(context, draft, note.id);
        }
        editor.hidden = false;
        area.value = draft.text;
        area.focus();
      })
    );
    meta.querySelectorAll('[data-annotation-row] textarea').forEach(area =>
      area.addEventListener('input', () => {
        const id = area.closest('[data-annotation-row]').dataset.annotationId,
          note = active.find(item => item.id === id),
          previous = readAnnotationDraft(context, id);
        const stored = writeAnnotationDraft(
          context,
          { text: area.value, expectedUpdatedAt: previous?.expectedUpdatedAt ?? note.updatedAt },
          id
        );
        const statusNode = area.closest('[data-annotation-row]').querySelector('[data-annotation-edit-status]');
        if (statusNode && !stored)
          statusNode.textContent = 'Browser storage is full · keep this editor open until saved';
      })
    );
    const saveEdit = async (id, overwrite = false) => {
      const draft = readAnnotationDraft(context, id),
        note = active.find(item => item.id === id),
        row = meta.querySelector(`[data-annotation-row][data-annotation-id="${CSS.escape(id)}"]`);
      if (!draft || !note || !row) return;
      const area = row.querySelector('textarea'),
        statusNode = row.querySelector('[data-annotation-edit-status]'),
        expectedUpdatedAt = overwrite ? note.updatedAt : draft.expectedUpdatedAt;
      const result = await call({
        type: 'UPDATE_MEDIA_METADATA',
        id: context.postId,
        mediaKey: context.mediaKey,
        change: { type: 'annotation-edit', annotation: { ...note, text: area.value }, expectedUpdatedAt },
      });
      if (!result?.ok) {
        statusNode.textContent = result?.error || 'This edit conflicted; your local draft is retained.';
        if (result?.row) refreshMediaRecord(result.row);
        return;
      }
      clearAnnotationDraft(context, id);
      refreshMediaRecord(result.row, `edit-button:${id}`);
      toast('Video note updated');
    };
    meta
      .querySelectorAll('[data-annotation-save-edit]')
      .forEach(button => button.addEventListener('click', () => void saveEdit(button.dataset.annotationSaveEdit)));
    meta
      .querySelectorAll('[data-annotation-overwrite]')
      .forEach(button =>
        button.addEventListener('click', () => void saveEdit(button.dataset.annotationOverwrite, true))
      );
    meta.querySelectorAll('[data-annotation-use-saved]').forEach(button =>
      button.addEventListener('click', () => {
        const id = button.dataset.annotationUseSaved;
        clearAnnotationDraft(context, id);
        refreshMediaRecord(window.XVaultLightboxContext()?.post || context.post, `edit-button:${id}`);
      })
    );
    meta.querySelectorAll('[data-annotation-cancel-edit]').forEach(button =>
      button.addEventListener('click', () => {
        const id = button.dataset.annotationCancelEdit,
          editor = button.closest('.xv-annotation-edit');
        editor.hidden = true;
        const target = meta.querySelector(`[data-annotation-edit="${CSS.escape(id)}"]`);
        target?.focus({ preventScroll: true });
        if (status) status.textContent = 'Draft kept on this device. Choose Continue draft to reopen it.';
      })
    );
    meta.querySelectorAll('[data-annotation-discard-edit]').forEach(button =>
      button.addEventListener('click', () => {
        const id = button.dataset.annotationDiscardEdit,
          note = active.find(item => item.id === id),
          draft = readAnnotationDraft(context, id);
        if (draft && draft.text !== note?.text && !confirm('Discard your unsaved video note changes?')) return;
        clearAnnotationDraft(context, id);
        refreshMediaRecord(context.post, `edit-button:${id}`);
      })
    );
    meta.querySelectorAll('[data-annotation-delete]').forEach(button =>
      button.addEventListener('click', async () => {
        const note = active.find(item => item.id === button.dataset.annotationDelete);
        if (!note) return;
        const result = await call({
          type: 'UPDATE_MEDIA_METADATA',
          id: context.postId,
          mediaKey: context.mediaKey,
          change: { type: 'annotation-delete', annotationId: note.id, expectedUpdatedAt: note.updatedAt },
        });
        if (!result?.ok) {
          if (status) status.textContent = result?.error || 'The note was not removed.';
          if (result?.row) refreshMediaRecord(result.row);
          return;
        }
        refreshMediaRecord(result.row, 'add');
        toast('Note removed · Undo remains available');
      })
    );
    meta.querySelectorAll('[data-annotation-restore]').forEach(button =>
      button.addEventListener('click', async () => {
        const note = removed.find(item => item.id === button.dataset.annotationRestore);
        if (!note) return;
        const result = await call({
          type: 'UPDATE_MEDIA_METADATA',
          id: context.postId,
          mediaKey: context.mediaKey,
          change: { type: 'annotation-restore', annotationId: note.id, expectedUpdatedAt: note.updatedAt },
        });
        if (!result?.ok) {
          if (status) status.textContent = result?.error || 'The note could not be restored.';
          if (result?.row) refreshMediaRecord(result.row);
          return;
        }
        refreshMediaRecord(result.row, 'add');
        toast('Removed note restored');
      })
    );
    meta.querySelectorAll('[data-annotation-up],[data-annotation-down]').forEach(button =>
      button.addEventListener('click', async () => {
        const order = active.map(item => item.id),
          id = button.dataset.annotationUp || button.dataset.annotationDown,
          delta = button.hasAttribute('data-annotation-up') ? -1 : 1;
        const result = await call({
          type: 'UPDATE_MEDIA_METADATA',
          id: context.postId,
          mediaKey: context.mediaKey,
          change: { type: 'annotation-move', annotationId: id, delta, expectedOrder: order },
        });
        if (!result?.ok) {
          if (status) status.textContent = result?.error || 'The notes changed elsewhere; order was not changed.';
          if (result?.row) refreshMediaRecord(result.row);
          return;
        }
        refreshMediaRecord(result.row, `edit-button:${id}`);
      })
    );
  }
  function playerKeys(event) {
    const video = $('#lightbox:not(.hidden) #lbContent video');
    if (
      !video ||
      event.target.closest('input,textarea,select,[contenteditable]') ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    const key = event.key.toLowerCase();
    if (![' ', 'j', 'k', 'l', '[', ']', 'f', 'm', 'a'].includes(key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (key === ' ' || key === 'k') video.paused ? video.play().catch(() => {}) : video.pause();
    if (key === 'j') video.currentTime = Math.max(0, video.currentTime - 5);
    if (key === 'l') video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
    if (key === '[') video.currentTime = Math.max(0, video.currentTime - 1 / 30);
    if (key === ']') video.currentTime = Math.min(video.duration || 0, video.currentTime + 1 / 30);
    if (key === 'f') video.requestFullscreen?.().catch(() => {});
    if (key === 'm') video.muted = !video.muted;
    if (key === 'a') openAnnotationComposer(video);
  }

  function mount() {
    window.XVaultLibrarySelection = () => [...selected];
    window.XVaultLibraryRows = () => library;
    window.XVaultOpenLinkExport = async (scope = 'all', action = null) => {
      if (action && !library.length) await loadLib();
      page('library');
      if (!$('#libraryExportDialog')) return;
      openLinkExport();
      $('#libraryExportScope').value = scope;
      refreshLinkExportSummary();
      if (action) {
        for (let attempt = 0; attempt < 250 && !resultRows(); attempt++)
          await new Promise(resolve => setTimeout(resolve, 20));
        runLinkExport(action);
      }
    };
    try {
      Object.defineProperty(window, 'library', { configurable: true, get: () => library });
    } catch {}
    window.XVaultLibraryContext = () => ({
      query: $('#search')?.value || '',
      sort: $('#sort')?.value || 'new',
      view: $('#libraryView')?.value || 'timeline',
    });
    const command = $('#page-library .libraryCommand');
    if (!command) return;
    const libraryPage = $('#page-library');
    $('#search')?.setAttribute('aria-label', 'Search Library');
    $('#search').placeholder = 'Search your archive, or add filters like from:name';
    $('#search').setAttribute('aria-describedby', 'libraryQueryIssues');
    const queryIssues = document.createElement('div');
    queryIssues.id = 'libraryQueryIssues';
    queryIssues.className = 'xv-query-issues';
    queryIssues.setAttribute('role', 'status');
    queryIssues.hidden = true;
    const headMain = $('#libraryHead .lib5-row-main');
    if (headMain) headMain.after(queryIssues);
    else $('.lib-filters').before(queryIssues);
    const help = $('#page-library .booruHelp');
    if (help)
      help.innerHTML =
        '<h3>Search syntax</h3><p>Combine filters with spaces. Dates are UTC: <code>after:</code> includes the day, <code>before:</code> excludes it.</p><dl><dt><code>from:name</code></dt><dd>one author</dd><dt><code>-from:name</code> <code>-cat</code></dt><dd>exclude anything with a leading minus</dd><dt><code>from:a|b</code> <code>has:video|gif</code></dt><dd>match any of several values</dd><dt><code>has:video</code> <code>has:gif</code> <code>has:image</code></dt><dd>media type</dd><dt><code>tag:name</code> <code>untagged:true</code></dt><dd>post and media labels</dd><dt><code>inbox:true</code></dt><dd>new posts you have not reviewed</dd><dt><code>fav:true</code> <code>note:true</code> <code>has:note</code></dt><dd>favorites, posts with notes or annotations</dd><dt><code>note:lighting</code> <code>note:&quot;rainy stairwell&quot;</code></dt><dd>search post and media notes</dd><dt><code>annotation:door</code> <code>media-note:lighting</code></dt><dd>search timestamp notes or media-only notes</dd><dt><code>downloaded:true</code> <code>missing:true</code></dt><dd>files on disk</dd><dt><code>after:2026-01-01 before:2026-02-01</code></dt><dd>posted between</dd><dt><code>archived-after:2026-10-01</code></dt><dd>archived since</dd><dt><code>likes:&gt;500</code> <code>views:&gt;10k</code></dt><dd>engagement</dd><dt><code>size:&gt;100mb</code></dt><dd>known size of completed downloads</dd><dt><code>on:2026-03-14</code> <code>year:2024</code> <code>within:7d</code></dt><dd>posted on a day, in a year or recently (<code>archived-on:</code>, <code>archived-within:</code> for capture time)</dd><dt><code>#hashtag</code> <code>@name</code> <code>domain:github.com</code></dt><dd>hashtags, mentions and linked sites</dd><dt><code>is:reply</code> <code>is:quote</code> <code>is:repost</code> <code>is:thread</code> <code>is:original</code></dt><dd>post relationships</dd><dt><code>lang:en</code> <code>media:&gt;2</code> <code>thread:ID</code> <code>quotes:ID</code></dt><dd>language, media count, a conversation, posts quoting a post</dd></dl>';
    $('#sort')?.setAttribute('aria-label', 'Sort Library');
    $('#libraryView')?.setAttribute('aria-label', 'Library layout');
    const inspector = $('#detailsDrawer');
    if (inspector) libraryPage.append(inspector);

    // Facets
    const facets = document.createElement('aside');
    facets.id = 'libraryDestinations';
    facets.className = 'xv-facets';
    facets.setAttribute('aria-label', 'Library locations');
    const destination = (id, label, icon) =>
      `<button type="button" class="facet-item" data-destination="${id}"><span class="facet-icon" data-facet-icon="${icon}"></span><span>${label}</span><em class="count"></em></button>`;
    facets.innerHTML = `<h2 class="xv-sr-only">Library locations</h2><nav aria-label="Collections">${destination('all', 'All posts', 'library')}${destination('inbox', 'Inbox', 'inbox')}${destination('favorites', 'Favorites', 'favorite')}${destination('untagged', 'Untagged', 'tag')}${destination('later', 'Read later', 'saved')}${destination('highlights', 'Highlights', 'note')}${destination('local', 'On disk', 'disk')}${destination('missing', 'Missing media', 'missing')}</nav>
<section class="facet" aria-labelledby="facetSourcesTitle"><h3 id="facetSourcesTitle">Sources</h3><div><button type="button" class="facet-item" data-token="source:bookmarks"><span class="facet-icon" data-facet-icon="saved"></span><span>Bookmarks</span></button><button type="button" class="facet-item" data-token="source:likes"><span class="facet-icon" data-facet-icon="heart"></span><span>Likes</span></button><button type="button" class="facet-item" data-token="source:profile"><span class="facet-icon" data-facet-icon="person"></span><span>Profiles</span></button></div></section>
<section class="facet" aria-labelledby="facetAuthorsTitle"><h3 id="facetAuthorsTitle">Authors</h3><div id="facetAuthors"></div></section>
<section class="facet" aria-labelledby="facetTagsTitle"><h3 id="facetTagsTitle">Tags</h3><div id="facetTags"></div></section>
<section class="facet xv-smart-collections" aria-labelledby="facetViewsTitle"><header class="facet-heading"><h3 id="facetViewsTitle">Smart collections</h3><details class="menu facet-menu"><summary aria-label="Smart collection actions" title="Export or import collections" data-xv-icon="more"></summary><div class="menu-pop"><button type="button" id="libraryCollectionsExport" title="Export query definitions" data-xv-icon="export">Export definitions</button><button type="button" id="libraryCollectionsImport" title="Preview an imported collection file" data-xv-icon="importFile">Import from file…</button></div></details><input id="libraryCollectionsFile" type="file" accept="application/json,.json" hidden></header><p class="facet-portable-note">Live search rules · archive rows stay local</p><div id="facetViews"></div><form class="facet-save" id="libraryViewForm"><input id="libraryViewName" maxlength="48" placeholder="Name this collection" aria-label="Smart Collection name"><select id="libraryCollectionIcon" aria-label="Collection icon"><option value="saved">Search</option><option value="video">Video</option><option value="image">Image</option><option value="note">Notes</option><option value="tag">Tags</option><option value="favorite">Favorites</option><option value="thread">Thread</option><option value="quote">Quotes</option><option value="calendar">Dates</option></select><button id="librarySaveView" type="submit" title="Save the current query, sort and layout">Save</button></form></section>`;
    libraryPage.prepend(facets);
    for (const slot of facets.querySelectorAll('[data-facet-icon]'))
      slot.innerHTML = window.XVaultIcons?.svg(slot.dataset.facetIcon) || '';
    // Sidebar sections fold (saved per section); sections other modules add later (Boards) fold the same way.
    const collapsedFacets = new Set(Array.isArray(settings.librarySideCollapsed) ? settings.librarySideCollapsed : []);
    const enhanceFacetSections = () => {
      for (const section of facets.querySelectorAll(':scope > section.facet')) {
        const heading = section.querySelector(':scope > h3, :scope > header > h3');
        if (!heading || heading.querySelector('.facet-toggle')) continue;
        const key = heading.id || section.id || heading.textContent.trim();
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'facet-toggle';
        toggle.dataset.facetKey = key;
        toggle.innerHTML = `<span>${esc(heading.textContent.trim())}</span>${window.XVaultIcons?.svg('chevronDown') || ''}`;
        heading.replaceChildren(toggle);
        const collapsed = collapsedFacets.has(key);
        section.dataset.collapsed = collapsed ? 'true' : 'false';
        toggle.setAttribute('aria-expanded', String(!collapsed));
      }
    };
    enhanceFacetSections();
    new MutationObserver(enhanceFacetSections).observe(facets, { childList: true });
    facets.addEventListener('click', event => {
      const toggle = event.target.closest('.facet-toggle');
      if (!toggle) return;
      const section = toggle.closest('section.facet'),
        collapsed = section.dataset.collapsed !== 'true';
      section.dataset.collapsed = collapsed ? 'true' : 'false';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      if (collapsed) collapsedFacets.add(toggle.dataset.facetKey);
      else collapsedFacets.delete(toggle.dataset.facetKey);
      void save({ librarySideCollapsed: [...collapsedFacets].slice(0, 24) }, false);
    });

    // Sidebar: a column on wide windows (shown or hidden, remembered), a drawer over the results below 1100px.
    const sideToggle = $('#librarySideToggle');
    const narrowSide = matchMedia('(max-width: 1099px)');
    const scrim = document.createElement('div');
    scrim.className = 'lib5-scrim';
    scrim.hidden = true;
    libraryPage.append(scrim);
    const syncSidebar = () => {
      const narrow = narrowSide.matches,
        open = narrow ? libraryPage.dataset.drawer === 'open' : settings.librarySidebar !== 'closed';
      libraryPage.dataset.side = narrow ? (open ? 'drawer-open' : 'drawer') : open ? 'open' : 'closed';
      facets.inert = !open;
      scrim.hidden = !(narrow && open);
      if (sideToggle) {
        sideToggle.setAttribute('aria-expanded', String(open));
        sideToggle.title = `${open ? 'Hide' : 'Show'} sidebar (\\)`;
        sideToggle.querySelector('svg.xv-icon')?.remove();
        sideToggle.insertAdjacentHTML(
          'afterbegin',
          window.XVaultIcons?.svg(open ? 'sidebarClose' : 'sidebarOpen') || ''
        );
      }
    };
    const toggleSidebar = force => {
      const narrow = narrowSide.matches,
        open = libraryPage.dataset.side === 'open' || libraryPage.dataset.side === 'drawer-open',
        next = typeof force === 'boolean' ? force : !open;
      if (narrow) libraryPage.dataset.drawer = next ? 'open' : 'closed';
      else {
        settings.librarySidebar = next ? 'open' : 'closed';
        void save({ librarySidebar: settings.librarySidebar }, false);
      }
      syncSidebar();
      if (narrow && next) facets.querySelector('button')?.focus({ preventScroll: true });
      else if (narrow) sideToggle?.focus({ preventScroll: true });
    };
    window.XVaultLibraryToggleSidebar = toggleSidebar;
    sideToggle?.addEventListener('click', () => toggleSidebar());
    scrim.addEventListener('click', () => toggleSidebar(false));
    narrowSide.addEventListener('change', syncSidebar);
    syncSidebar();
    facets.addEventListener('click', event => {
      if (narrowSide.matches && event.target.closest('[data-destination],[data-token],[data-view-index]'))
        setTimeout(() => toggleSidebar(false), 0);
    });
    facets.addEventListener('keydown', event => {
      if (event.key === 'Escape' && narrowSide.matches && libraryPage.dataset.side === 'drawer-open') {
        event.stopPropagation();
        toggleSidebar(false);
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key !== '\\' || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!libraryPage.classList.contains('show') || document.querySelector('dialog[open]')) return;
      if (event.target.closest?.('input,textarea,select,[contenteditable]')) return;
      event.preventDefault();
      toggleSidebar();
    });
    facets.addEventListener('click', event => {
      const destinationButton = event.target.closest('[data-destination]');
      if (destinationButton) {
        const query = model.destinationQuery(destinationButton.dataset.destination);
        if (query === null) return;
        $('#search').value = query;
        pageIndex = 0;
        renderLib();
        return;
      }
      const token = event.target.closest('[data-token]');
      if (token) return toggleToken(token.dataset.token);
      const more = event.target.closest('[data-facet-more]');
      if (more) {
        facetOpen[more.dataset.facetMore] = !facetOpen[more.dataset.facetMore];
        renderFacets();
        return;
      }
      const open = event.target.closest('[data-view-index]');
      if (open) return openView(Number(open.dataset.viewIndex));
      const move = event.target.closest('[data-view-move]');
      if (move) return moveView(move.dataset.viewId, Number(move.dataset.viewMove));
      const remove = event.target.closest('[data-view-remove]');
      if (remove) deleteView(remove.dataset.viewRemove);
    });
    $('#libraryViewForm').addEventListener('submit', event => {
      event.preventDefault();
      saveView();
    });
    $('#libraryCollectionsExport').addEventListener('click', exportSmartCollections);
    $('#libraryCollectionsImport').addEventListener('click', () => $('#libraryCollectionsFile').click());
    $('#libraryCollectionsFile').addEventListener('change', importSmartCollections);

    // Quick filter chips toggle filters and combine with the rest of the query
    $('#libraryChips').addEventListener(
      'click',
      event => {
        const chip = event.target.closest('button[data-filter]');
        if (!chip) return;
        event.stopImmediatePropagation();
        const filter = chip.dataset.filter || '';
        if (!filter) {
          setQueryTokens(splitQuery($('#search').value).filter(token => !/^"?(has|type|rating):/i.test(token)));
        } else toggleToken(filter, filter.startsWith('has:') ? 'has:' : '');
      },
      true
    );

    // Layout, tile size and sort
    const layout = $('#libraryLayout');
    // Layout switches re-render in place; library-feed.js animates cards from their old positions (FLIP) and
    // keeps the first visible post in view. No full-page View Transition snapshot of thousands of nodes.
    layout.addEventListener('click', event => {
      const button = event.target.closest('[data-layout]');
      if (!button) return;
      const select = $('#libraryView');
      if (select.value === button.dataset.layout) return;
      select.value = button.dataset.layout;
      settings.libraryView = select.value; // render now; the save below confirms in the background
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncChrome();
    });
    layout.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      // Arrow keys move between the layouts the toolbar shows (small screens hide Table and Wall).
      const buttons = $$('#libraryLayout [data-layout]').filter(
          button => button.offsetParent || button.getAttribute('aria-checked') === 'true'
        ),
        current = buttons.findIndex(button => button.getAttribute('aria-checked') === 'true');
      const next =
        buttons[
          (current + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : buttons.length - 1)) %
            buttons.length
        ];
      event.preventDefault();
      next.click();
      next.focus();
    });
    let tileTimer = 0;
    $('#libraryTile').addEventListener('input', event => {
      tileDirty = true;
      libraryPage.style.setProperty('--tile', `${event.target.value}px`);
      clearTimeout(tileTimer);
      tileTimer = setTimeout(async () => {
        await save({ libraryTileSize: Number(event.target.value) }, false);
        tileDirty = false;
      }, 350);
    });
    // View menu: card style, media fit and feed width are saved per profile and redraw the mounted cards.
    const viewMenu = $('#libraryViewMenu');
    const VIEW_DEFAULTS = { libraryCardStyle: 'comfortable', libraryMediaFit: 'cover', libraryFeedWidth: 'wide' };
    const syncViewMenu = () => {
      for (const group of viewMenu?.querySelectorAll('[data-setting]') || []) {
        const key = group.dataset.setting,
          value = settings[key] || VIEW_DEFAULTS[key];
        for (const input of group.querySelectorAll('input[type="radio"]')) input.checked = input.value === value;
      }
      // Small screens show every layout here too (the toolbar drops Table and, on small phones, Wall).
      for (const input of viewMenu?.querySelectorAll('[data-layout-choice] input') || [])
        input.checked = input.value === (settings.libraryView || 'timeline');
    };
    syncViewMenu();
    viewMenu?.addEventListener('toggle', syncViewMenu);
    viewMenu?.addEventListener('change', event => {
      const input = event.target.closest('input[type="radio"]');
      if (input?.closest('[data-layout-choice]')) {
        $(`#libraryLayout [data-layout="${CSS.escape(input.value)}"]`)?.click();
        return;
      }
      const key = input?.closest('[data-setting]')?.dataset.setting;
      if (!key || settings[key] === input.value) return;
      settings[key] = input.value;
      void save({ [key]: input.value }, false);
      if (key === 'libraryCardStyle') window.XVaultLibraryFeed?.reset();
      renderLib(true);
    });
    // The sticky header's height feeds scroll-padding, the windowed table head and the sidebar drawer offset.
    const head = $('#libraryHead');
    if (head && 'ResizeObserver' in window)
      new ResizeObserver(() =>
        libraryPage.style.setProperty('--lib-head-h', `${Math.round(head.offsetHeight)}px`)
      ).observe(head);
    const scrollBox = $('#libraryScroll');
    let scrolledFrame = 0;
    scrollBox?.addEventListener(
      'scroll',
      () => {
        if (scrolledFrame) return;
        scrolledFrame = requestAnimationFrame(() => {
          scrolledFrame = 0;
          head?.toggleAttribute('data-scrolled', scrollBox.scrollTop > 4);
        });
      },
      { passive: true }
    );
    // Timeline (xv-keystone.js #xkTimeline) is folded by default; the header chip opens it under the header.
    const timelineToggle = $('#libraryTimelineToggle');
    const syncTimeline = () => {
      const open = window.XVaultTimeline?.isOpen?.() === true;
      timelineToggle?.setAttribute('aria-expanded', String(open));
      timelineToggle?.classList.toggle('active', open);
      if (timelineToggle) timelineToggle.hidden = !window.XVaultTimeline;
    };
    timelineToggle?.addEventListener('click', () => {
      void window.XVaultTimeline?.setOpen(!window.XVaultTimeline.isOpen());
    });
    document.addEventListener('xv:timeline-state', syncTimeline);
    document.addEventListener('xv:timeline-mounted', syncTimeline);
    syncTimeline();
    const sort = $('#sort');
    if (sort && !sort.querySelector('option[value="random"]'))
      sort.insertAdjacentHTML('beforeend', '<option value="random">Random order</option>');
    if (sort && settings.librarySort) sort.value = settings.librarySort;
    document.addEventListener(
      'change',
      event => {
        if (event.target?.id === 'sort') save({ librarySort: event.target.value }, false);
      },
      true
    );

    // Status-line actions
    const quickActions = $('.libraryMiniActions');
    const shuffle = $('#shuffleLibrary');
    if (shuffle)
      shuffle.onclick = () => {
        $('#libraryTools').open = false;
        randomSeed = freshRandomSeed();
        invalidateQueryCache();
        $('#sort').value = 'random';
        save({ librarySort: 'random' }, false);
        pageIndex = 0;
        renderLib();
      };
    if (quickActions) {
      const review = document.createElement('button');
      review.id = 'libraryReview';
      review.type = 'button';
      review.className = 'primary';
      review.hidden = true;
      review.textContent = 'Review inbox';
      review.title = 'Step through new posts with Quick Look: R keeps, F favorites, Delete trashes';
      review.onclick = () => {
        const rows = currentPageRows();
        if (!rows) return toast('Wait for the current search to finish');
        if (!rows.length) return toast('Inbox is clear');
        openQuickLook(rows, 0);
      };
      const selectResults = document.createElement('button');
      selectResults.id = 'librarySelectResultsQuick';
      selectResults.type = 'button';
      selectResults.className = 'quiet';
      selectResults.textContent = 'Select loaded';
      selectResults.title = 'Select the posts loaded in this window (up to 1,500). Ctrl+Shift+A selects every match.';
      selectResults.setAttribute('aria-label', 'Select loaded: select the posts loaded in this Library window');
      selectResults.onclick = selectAllMatching;
      const exportButton = document.createElement('button');
      exportButton.id = 'libraryExportOpen';
      exportButton.type = 'button';
      exportButton.className = 'quiet xv-export-button';
      exportButton.innerHTML =
        '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v9m0 0 3.5-3.5M10 11.5 6.5 8M3.5 12.5v4h13v-4"/></svg><span>Export links</span>';
      exportButton.setAttribute('aria-haspopup', 'dialog');
      exportButton.onclick = openLinkExport;
      quickActions.append(review, selectResults, exportButton);
    }
    if (!$('#libraryExportDialog')) {
      const dialog = document.createElement('dialog');
      dialog.id = 'libraryExportDialog';
      dialog.className = 'xv-export-dialog';
      dialog.hidden = true;
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-labelledby', 'libraryExportTitle');
      dialog.innerHTML = `<div class="xv-export-head"><div><h3 id="libraryExportTitle">Export links</h3><p id="libraryExportQuery">Current Library results</p></div><button type="button" class="quiet" id="libraryExportClose" aria-label="Close export">×</button></div><dl class="xv-export-summary"><div><dt>Results</dt><dd id="libraryExportCount">—</dd></div><div><dt>Provider</dt><dd id="libraryExportProvider">FixVX</dd></div></dl><label class="xv-export-field"><span>Scope</span><select id="libraryExportScope"><option value="all">All matching results</option><option value="selected">Selected posts</option><option value="page">Current page</option></select></label><label class="xv-export-field"><span>Links per block</span><select id="libraryExportBlock"><option value="1">1</option><option value="5">5</option><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="0">No grouping</option></select></label><div id="libraryExportProgress" class="xv-export-progress" role="status" hidden></div><div class="xv-export-actions"><button type="button" id="libraryCancelExport" hidden>Cancel</button><button type="button" id="libraryCopyLinks">Copy links</button><button type="button" id="libraryExportTxt" class="primary">Export TXT</button></div>`;
      command.after(dialog);
      dialog.addEventListener('cancel', event => {
        event.preventDefault();
        closeLinkExport();
      });
      dialog.addEventListener('close', () => {
        dialog.hidden = true;
        $('#libraryExportOpen')?.focus({ preventScroll: true });
      });
      $('#libraryExportClose').onclick = closeLinkExport;
      $('#libraryExportScope').onchange = refreshLinkExportSummary;
      $('#libraryExportBlock').value = String(
        [1, 5, 10, 25, 50, 0].includes(Number(settings.libraryExportBlock)) ? Number(settings.libraryExportBlock) : 5
      );
      if (!window.XVaultLinks?.providerHost(settings.linkProvider || 'fixvx', settings))
        $('#libraryExportProvider').textContent = 'Invalid custom provider';
      $('#libraryExportBlock').onchange = () =>
        save({ libraryExportBlock: Number($('#libraryExportBlock').value) }, false);
      $('#libraryCopyLinks').onclick = () => runLinkExport('copy');
      $('#libraryExportTxt').onclick = () => runLinkExport('download');
      $('#libraryCancelExport').onclick = () => {
        if (exportQueryId) {
          const queryId = exportQueryId;
          exportQueryId = '';
          void call({ type: 'CANCEL_LIBRARY_QUERY', queryId }).catch(() => {});
        }
        $('#libraryExportProgress').textContent = 'Cancelling export...';
        exportWorker?.postMessage({ type: 'cancel' });
      };
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !$('#libraryExportDialog').hidden) closeLinkExport();
      });
    }

    // Selection bar floats above the list; less common actions live in its menu
    const bulk = document.createElement('div');
    bulk.id = 'libraryBulk';
    bulk.className = 'xv-library-bulk';
    bulk.setAttribute('role', 'toolbar');
    bulk.setAttribute('aria-label', 'Selected posts');
    bulk.hidden = true;
    bulk.innerHTML = `<strong id="librarySelectedCount" aria-live="polite">0 selected</strong><button id="libraryClearSelection" class="quiet" title="Clear selection (Esc)">Clear</button><span class="bar-sep"></span><button id="libraryBulkFav">Favorite</button><button id="libraryBulkReviewed" title="Mark selected posts as reviewed">Reviewed</button><span class="bar-field"><input id="libraryBulkTagInput" maxlength="40" placeholder="Add tag" aria-label="Tag for selected posts"><button id="libraryBulkTag">Tag</button></span><button id="libraryBulkDownload">Download</button><button id="libraryBulkCopy">Links</button><details class="menu bar-more"><summary aria-label="More actions for selected posts">More</summary><div class="menu-pop"><button id="librarySelectPage" type="button" title="Add every loaded post to the selection">Add loaded posts</button><button id="librarySelectResults" type="button" title="Replace the selection with the posts loaded in this window">Select loaded results</button><button id="librarySelectEvery" type="button" title="Select every post that matches the search, loaded or not (Ctrl+Shift+A)">Select every match</button><button id="libraryInvertPage" type="button" title="Toggle the selection of every loaded post">Invert loaded</button><hr><span class="bar-field"><select id="libraryBulkColorSelect" aria-label="Color label"><option value="none">No color</option><option value="red">Red</option><option value="amber">Amber</option><option value="green">Green</option><option value="blue">Blue</option><option value="violet">Violet</option></select><button id="libraryBulkColor" type="button">Apply color</button></span><button id="libraryBulkExport" type="button">Export selection as JSON</button></div></details><span class="bar-sep"></span><button id="libraryBulkTrash" class="danger">Move to Trash</button><button id="libraryUndoTrash" hidden>Undo Trash</button><button id="libraryBrowseTrash" class="quiet">Browse Trash</button>`;
    ($('#libraryHead') || $('#list')).append(bulk);
    new MutationObserver(() => {
      head?.toggleAttribute('data-selecting', !bulk.hidden && bulk.dataset.undoOnly !== 'true');
    }).observe(bulk, { attributes: true, attributeFilter: ['hidden', 'data-undo-only'] });
    const paging = document.createElement('nav');
    paging.id = 'libraryPages';
    paging.className = 'xv-library-pages';
    paging.setAttribute('aria-label', 'Library pages');
    $('#list').after(paging);
    $('#librarySelectPage').onclick = () => {
      selectVisiblePage();
      bulk.querySelector('details')?.removeAttribute('open');
    };
    $('#librarySelectResults').onclick = () => {
      selectAllMatching();
      bulk.querySelector('details')?.removeAttribute('open');
    };
    $('#librarySelectEvery').onclick = () => {
      void selectEveryMatch();
      bulk.querySelector('details')?.removeAttribute('open');
    };
    $('#libraryInvertPage').onclick = () => {
      invertVisiblePage();
      bulk.querySelector('details')?.removeAttribute('open');
    };
    $('#libraryClearSelection').onclick = () => {
      selected.clear();
      renderSelection();
    };
    $('#libraryBulkFav').onclick = () => bulkMeta({ favorite: true }, 'Favorited');
    $('#libraryBulkReviewed').onclick = () => bulkMeta({ reviewed: true }, 'Marked reviewed');
    $('#libraryBulkTag').onclick = () => {
      const input = $('#libraryBulkTagInput'),
        tag = input.value.trim();
      if (!tag) return input.focus();
      bulkMeta({ addTag: tag }, 'Tagged');
      input.value = '';
    };
    $('#libraryBulkTagInput').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        $('#libraryBulkTag').click();
      }
    });
    $('#libraryBulkColor').onclick = () => bulkMeta({ colorLabel: $('#libraryBulkColorSelect').value }, 'Labeled');
    $('#libraryBulkDownload').onclick = bulkDownload;
    $('#libraryBulkCopy').onclick = () => {
      openLinkExport();
      $('#libraryExportScope').value = 'selected';
      refreshLinkExportSummary();
    };
    $('#libraryBulkExport').onclick = bulkExport;
    $('#libraryBulkTrash').onclick = trashSelected;
    $('#libraryUndoTrash').onclick = undoTrash;
    $('#libraryBrowseTrash').onclick = () => window.XVaultTrash.open();
    document.addEventListener('keydown', playerKeys, true);
    document.addEventListener('keydown', event => {
      if (
        event.key !== 'Escape' ||
        !selected.size ||
        document.querySelector('dialog[open]') ||
        !libraryPage.classList.contains('show')
      )
        return;
      if (event.target.closest('input,textarea,select,[contenteditable]')) return;
      if (!$('#lightbox').classList.contains('hidden') || !$('#palette').classList.contains('hidden')) return;
      selected.clear();
      renderSelection();
    });
    // Card buttons are delegated by library-feed.js; the windowed List/Table rows add Preview and column sorting.
    $('#list').addEventListener('click', event => {
      const preview = event.target.closest('[data-record-preview]');
      if (preview) return void openQuickLook(compactRows, Number(preview.dataset.recordPreview));
      const sortButton = event.target.closest('[data-table-sort]');
      if (!sortButton) return;
      const sort = $('#sort'),
        wanted = sortButton.dataset.tableSort;
      sort.value = wanted === 'new' && sort.value === 'new' ? 'old' : wanted;
      sort.dispatchEvent(new Event('change', { bubbles: true }));
    });
    $('#list').addEventListener('keydown', event => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'a' &&
        !event.target.closest('button,input,select,textarea,a,[contenteditable]')
      ) {
        event.preventDefault();
        if (event.shiftKey) void selectEveryMatch();
        else selectAllMatching();
        return;
      }
      if (event.target.closest('button,input,select,textarea,a,[contenteditable]')) return;
      const card = event.target.closest('.tweet');
      if (!card || event.ctrlKey || event.altKey || event.metaKey) return;
      const cards = $$('#list .tweet');
      const position = cards.indexOf(card);
      if (
        $('#list').classList.contains('xv-virtual-list') &&
        ['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
      ) {
        event.preventDefault();
        const current = Number(card.dataset.rowIndex);
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? compactRows.length - 1
              : Math.max(
                  0,
                  Math.min(compactRows.length - 1, current + (event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1))
                );
        revealCompactRow(next);
        paintCompact(true, next);
      } else if (event.key === 'j' || event.key === 'k' || event.key.startsWith('Arrow')) {
        event.preventDefault();
        const forward = event.key === 'j' || event.key === 'ArrowDown' || event.key === 'ArrowRight';
        const view = $('#list').dataset.view;
        if (
          (view === 'gallery' || view === 'masonry' || view === 'cards') &&
          (event.key === 'ArrowUp' || event.key === 'ArrowDown')
        ) {
          // Nearest tile in the row above or below.
          const here = card.getBoundingClientRect(),
            centre = here.left + here.width / 2;
          const down = event.key === 'ArrowDown';
          const candidates = cards.filter(other => {
            const box = other.getBoundingClientRect();
            return down ? box.top > here.bottom - 8 : box.bottom < here.top + 8;
          });
          const best = candidates.sort((a, b) => {
            const ra = a.getBoundingClientRect(),
              rb = b.getBoundingClientRect();
            const vertical = down ? ra.top - rb.top : rb.top - ra.top;
            return Math.abs(vertical) > 16
              ? vertical
              : Math.abs(ra.left + ra.width / 2 - centre) - Math.abs(rb.left + rb.width / 2 - centre);
          })[0];
          best?.focus();
        } else {
          const next = cards[position + (forward ? 1 : -1)];
          if (next) next.focus();
          else {
            // At the edge of the mounted blocks: let the feed mount the neighbour, then focus it.
            const rows = resultRows() || [];
            const index = rows.findIndex(post => String(post.id) === card.dataset.id) + (forward ? 1 : -1);
            if (rows[index]) window.XVaultLibraryFeed?.reveal(rows[index].id)?.focus({ preventScroll: true });
            else if (forward) loadMore(true);
          }
        }
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        const rows = resultRows();
        if (!rows) return;
        const index = rows.findIndex(post => String(post.id) === card.dataset.id);
        if (index >= 0) {
          if (event.key === ' ') openQuickLook(rows, index);
          else if (rows[index].media?.length) openLightbox(rows, index, 0);
          else window.openDetails(rows[index].id);
        }
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        toggleFavorite(card.dataset.id);
      } else if (event.key.toLowerCase() === 'x') {
        event.preventDefault();
        card.querySelector('.xv-card-select input')?.click();
      }
    });
    renderSavedViews();
    syncChrome();
    document.addEventListener(
      'input',
      event => {
        if (event.target?.id !== 'search') return;
        queryInputEvents++;
        event.stopImmediatePropagation();
        clearTimeout(queryRenderTimer);
        queryRenderTimer = setTimeout(
          () => {
            queryRenderScheduled++;
            renderLib();
          },
          Math.max(0, Number(settings.librarySearchDebounce ?? 120))
        );
      },
      true
    );
  }

  document.addEventListener('DOMContentLoaded', mount, { once: true });
  window.addEventListener('beforeunload', () => helperPool.clear());
})();
