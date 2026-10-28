/* Library workspace: paging, saved views, bulk work, and focused media playback. */
(() => {
  const selected = new Set();
  function compactTagSummary(post) {
    const tags = post.userMeta?.tags || [];
    if (!tags.length) return (post.sourceFlags || post.archiveSources || []).join(' · ');
    const visible = tags.slice(0, 8).map(tag => `#${tag}`).join(' ');
    return tags.length > 8 ? `${visible} · +${tags.length - 8} more` : visible;
  }
  let pageIndex = 0;
  let lastQuery = '';
  let lastSort = '';
  let queryPersistTimer = 0, queryRenderTimer = 0;
  let libraryRevision = 0;
  let libraryLoadGeneration = 0;
  let indexedLibrary = null, indexedLength = -1, recordIndexes = new Map();
  function libraryRecordIndexes() {
    if (indexedLibrary !== library || indexedLength !== library.length) {
      recordIndexes = new Map(library.map((row,index) => [String(row.id),index]));
      indexedLibrary = library; indexedLength = library.length;
    }
    return recordIndexes;
  }
  let randomSeed = freshRandomSeed(0);
  let libraryQueryRevision = null, libraryQueryDownloadRevision = null, libraryTotalRecords = null, libraryQueryHasMore = false, libraryQueryMatched = null, libraryQueryTruncated = false, libraryQueryRetained = null;
  let rankedPlanIdentity = '', rankedPlanId = '';
  let pageCursors = [null], loadedQueryKey = '', activeQueryId = '';
  let queryInputEvents = 0, queryRenderScheduled = 0;
  const libraryQueryMetrics = [];
  let selectionAnchor = '';
  let lastTrashed = [], undoLimited = false;
  let mutationBusy = false;
  let mutationProgress = '';
  let exportWorker = null;
  let exportQueryId = '';
  let exportStreamAck = null;
  let exportBusy = false;
  const helperPool = XVaultLibraryModel.createMediaResourcePool({
    create: blob => URL.createObjectURL(blob),
    revoke: url => URL.revokeObjectURL(url)
  });
  const helperPending = new Map();
  const mediaTimes = new Map();
  let helperObserver = null;
  let helperActive = 0;
  const helperQueue = [];
  const baseRender = renderLib;
  const baseTokenMatch = tokenMatch;
  const baseLightbox = renderLightbox;
  const model = XVaultLibraryModel;
  let compactRows = [];
  let compactKey = '';
  let compactFrame = 0;
  let compactResizeObserver = null;
  let compactStart = -1;
  let compactEnd = -1;

  function paintCompact(force = false, focusIndex = null) {
    const list = $('#list');
    if (!list?.classList.contains('xv-virtual-list')) return;
    const viewportWindow = model.virtualWindow(compactRows.length, list.scrollTop, list.clientHeight || 600);
    if (!force && viewportWindow.start === compactStart && viewportWindow.end === compactEnd) return;
    compactStart = viewportWindow.start;
    compactEnd = viewportWindow.end;
    const focusedId = document.activeElement?.closest('#list .tweet')?.dataset.id;
    list.innerHTML = `<div class="xv-virtual-spacer" aria-hidden="true" style="height:${viewportWindow.before}px"></div>` +
      compactRows.slice(viewportWindow.start, viewportWindow.end).map((post, offset) => {
        const index = viewportWindow.start + offset;
        const media = post.media || [];
        const first = media[0];
        let preview = first?.preview || (first?.type === 'photo' ? first.url : '');
        try { const url = new URL(preview); if (url.hostname === 'pbs.twimg.com') { url.searchParams.set('name', 'small'); preview = url.href; } } catch {}
        const type = !media.length ? 'Text' : media.some(item => item.type === 'video') ? 'Video' : media.some(item => item.type === 'animated_gif') ? 'Animation' : 'Image';
        const rawText = String(post.text || 'Media post');
        const textPreview = rawText.length > 500 ? `${rawText.slice(0, 500)}…` : rawText;
        const date = Number(post.archivedAt) ? new Date(post.archivedAt).toLocaleDateString() : 'Unknown date';
        return `<article class="tweet xv-record-row ${post.userMeta?.favorite ? 'favorite' : ''}" data-id="${esc(post.id)}" data-row-index="${index}" aria-label="Post ${esc(post.id)} by @${esc(post.author?.handle || 'unknown')}" tabindex="0"><div class="xv-record-thumb">${preview ? `<img src="${esc(preview)}" alt="" loading="lazy" decoding="async">` : `<span>${type}</span>`}</div><div class="xv-record-copy"><b>@${esc(post.author?.handle || 'unknown')}</b><p title="Full text is available in Inspector">${esc(textPreview)}</p><small>${esc(compactTagSummary(post))}</small></div><div class="xv-record-facts"><b>${esc(type)}${media.length > 1 ? ' · ' + media.length : ''}</b><time>${esc(date)}</time><span>${model.isDownloaded(post, libraryDownloads) ? 'Local copy' : media.length ? 'Source media' : 'Archived text'}</span></div><div class="xv-record-actions"><button type="button" data-record-preview="${index}" title="Quick Look (Space)" aria-label="Quick Look at post ${esc(post.id)}"><span class="lbl">Preview</span></button><button type="button" data-details="${esc(post.id)}" title="Inspector"><span class="lbl">Details</span></button></div></article>`;
      }).join('') + `<div class="xv-virtual-spacer" aria-hidden="true" style="height:${viewportWindow.after}px"></div>`;
    renderSelection();
    list.querySelectorAll('[data-details]').forEach(button => { button.onclick = () => window.openDetails(button.dataset.details); });
    list.querySelectorAll('[data-record-preview]').forEach(button => { button.onclick = () => openQuickLook(compactRows, Number(button.dataset.recordPreview)); });
    if (focusIndex != null) list.querySelector(`[data-row-index="${focusIndex}"]`)?.focus({ preventScroll: true });
    else if (focusedId) list.querySelector(`.tweet[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
  }

  function renderCompact(rows) {
    const list = $('#list');
    const key = `${currentSearchKey()}|${pageIndex}`;
    const reset = !list.classList.contains('xv-virtual-list') || key !== compactKey;
    compactRows = rows;
    compactKey = key;
    list.dataset.view = 'compact';
    list.classList.add('xv-virtual-list');
    if (reset) list.scrollTop = 0;
    list.onscroll = () => {
      if (compactFrame) return;
      compactFrame = requestAnimationFrame(() => { compactFrame = 0; paintCompact(); });
    };
    compactResizeObserver?.disconnect();
    compactResizeObserver = new ResizeObserver(() => paintCompact(true));
    compactResizeObserver.observe(list);
    paintCompact(true);
  }

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
  window.XVaultQuickLookReturnTarget = () => quickLookReturn?.isConnected ? quickLookReturn : quickLookReturnId ? $(`#list .tweet[data-id="${CSS.escape(quickLookReturnId)}"]`) : null;

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
        if (quickLookDirty) { quickLookDirty = false; renderLib(); }
        dialog.querySelectorAll('video').forEach(video => { video.pause(); video.removeAttribute('src'); video.load(); });
        releaseHelperMedia(dialog);
        dialog.replaceChildren();
        quickLookRows = [];
        const target = quickLookReturn?.isConnected ? quickLookReturn : $('#list')?.querySelector(`.tweet[data-id="${CSS.escape(quickLookReturnId)}"]`);
        if ($('#lightbox').classList.contains('hidden') && $('#detailsDrawer').classList.contains('hidden')) (target || $('#search'))?.focus({ preventScroll: true });
      });
      dialog.addEventListener('click', event => { if (event.target === dialog) closeQuickLook(); });
      dialog.addEventListener('keydown', event => {
        if (event.target.closest('input,textarea,select,[contenteditable],video')) return;
        if (![' ', 'ArrowLeft', 'ArrowRight', 'Enter', 'r', 'R', 'f', 'F', 'Delete'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
        if ((event.key === 'Enter' || event.key === ' ') && event.target.closest('button,a')) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === ' ') closeQuickLook();
        else if (event.key === 'Enter') openQuickLookViewer();
        else if (event.key.toLowerCase() === 'r') reviewAction('keep');
        else if (event.key.toLowerCase() === 'f') reviewAction('favorite');
        else if (event.key === 'Delete') reviewAction('trash');
        else {
          quickLookIndex = Math.max(0, Math.min(quickLookRows.length - 1, quickLookIndex + (event.key === 'ArrowRight' ? 1 : -1)));
          paintQuickLook(event.key === 'ArrowRight' ? 1 : -1);
          hydrateHelperMedia(dialog);
          $('#xvQuickLookTitle')?.focus({preventScroll:true});
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
    if (!dialog.open) dialog.showModal();
    hydrateHelperMedia(dialog);
    $('#xvQuickLookTitle')?.focus({ preventScroll: true });
  }

  function openQuickLookViewer() {
    const rows = quickLookRows, index = quickLookIndex, post = rows[index];
    closeQuickLook();
    if (post?.media?.length) openLightbox(rows, index, 0);
    else if (post) window.openDetails(post.id);
  }

  function paintQuickLook(direction = 0) {
    const dialog = $('#xvQuickLook'), post = quickLookRows[quickLookIndex];
    if (!dialog || !post) return;
    dialog.dataset.postId = String(post.id);
    dialog.dataset.browse = direction > 0 ? 'next' : direction < 0 ? 'previous' : 'open';
    dialog.querySelectorAll('video').forEach(video => video.pause());
    releaseHelperMedia(dialog);
    const media = post.media || [], first = media[0];
    const noteMediaIndex = media.findIndex(item => window.XVaultMediaMetadata.metadataFor(item).annotations.some(annotation => !annotation.deletedAt));
    const videoNoteCount = media.reduce((count, item) => count + window.XVaultMediaMetadata.metadataFor(item).annotations.filter(annotation => !annotation.deletedAt).length, 0);
    const kind = first ? mediaLogical(first) : 'text';
    const pick = first ? mediaSource(first) : null;
    const local = first && kind === 'gif' ? localConvertedFor(post, first) : null;
    const src = local || pick?.src || '';
    const image = kind === 'image' || (kind === 'gif' && (local || pick?.native));
    const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : 'Not recorded';
    const downloaded = (libraryDownloads.get(String(post.id)) || []).filter(row => row.state === 'complete');
    const verified = downloaded.filter(row => row.verification?.state === 'verified' || row.verificationState === 'verified').length;
    const provenance = post.provenance?.at(-1);
    const inbox = model.isInbox(post, settings.inboxSince), reviewed = Boolean(post.userMeta?.reviewedAt);
    const when = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    dialog.innerHTML = `<header><div class="xv-preview-title"><h2 id="xvQuickLookTitle" tabindex="-1">@${esc(post.author?.handle || 'unknown')}</h2><span>${esc([post.author?.name, when(post.createdAt)].filter(Boolean).join(' · '))}</span></div><div class="xv-preview-position">${quickLookIndex + 1} <i>of</i> ${fmt(quickLookRows.length)}${inbox ? '<em>New</em>' : ''}</div><div class="xv-preview-navigation"><button type="button" class="quiet" data-preview="previous" aria-label="Previous post" title="Previous (←)" ${quickLookIndex === 0 ? 'disabled' : ''}>←</button><button type="button" class="quiet" data-preview="next" aria-label="Next post" title="Next (→)" ${quickLookIndex >= quickLookRows.length - 1 ? 'disabled' : ''}>→</button><button type="button" class="quiet" data-preview="close" aria-label="Close Quick Look" title="Close (Esc)">×</button></div></header><div class="xv-preview-body"><div class="xv-preview-stage ${media.length ? '' : 'text-only'}">${!media.length ? `<p>${esc(post.text || 'No post text was recorded.')}</p>` : image ? `<img src="${esc(src)}" alt="${esc(post.text || 'Archived media')}" decoding="async">` : `<video src="${esc(src)}" poster="${esc(first.preview || '')}" controls preload="metadata" playsinline ${kind === 'gif' ? 'loop' : ''}></video>`}${media.length > 1 ? `<span class="xv-preview-media-count">${media.length} media · Open viewer to browse all</span>` : ''}</div><aside>${media.length ? `<p class="tweetText">${esc(post.text || 'No post text recorded.')}</p>` : ''}<dl><dt>Posted</dt><dd>${esc(date(post.createdAt))}</dd><dt>Archived</dt><dd>${esc(date(post.archivedAt))}</dd><dt>Source</dt><dd>${esc(provenance?.source || (post.sourceFlags || post.archiveSources || []).join(', ') || 'Not recorded')}</dd><dt>On disk</dt><dd>${downloaded.length} saved · ${verified} verified</dd>${first ? `<dt>Dimensions</dt><dd>${esc(first.width || '?')} × ${esc(first.height || '?')}</dd>` : ''}<dt>Tags</dt><dd>${esc((post.userMeta?.tags || []).join(', ') || 'Untagged')}</dd><dt>Review</dt><dd>${reviewed ? 'Reviewed ' + esc(when(post.userMeta.reviewedAt)) : inbox ? 'Waiting in Inbox' : 'Not in Inbox'}</dd></dl>${post.userMeta?.note ? `<div class="xv-preview-note"><b>Your note</b><p>${esc(post.userMeta.note)}</p></div>` : ''}<button type="button" class="quiet xv-preview-video-notes" data-preview="notes" ${noteMediaIndex < 0 ? 'hidden' : ''}>Video notes · ${videoNoteCount}</button></aside></div><footer><div class="xv-review" role="group" aria-label="Review this post"><button type="button" class="primary" data-review="keep" title="Mark reviewed and go to the next post (R)">${inbox ? 'Keep' : 'Reviewed'}<kbd>R</kbd></button><button type="button" data-review="favorite" aria-pressed="${post.userMeta?.favorite ? 'true' : 'false'}" title="Favorite (F)">Favorite<kbd>F</kbd></button><button type="button" class="danger" data-review="trash" title="Move to Trash — Undo stays available (Delete)">Trash<kbd>Del</kbd></button></div><div class="xv-preview-actions"><button type="button" class="quiet" data-preview="open">${media.length ? 'Open viewer' : 'Open inspector'}</button><button type="button" class="quiet" data-preview="inspect">Inspector</button><button type="button" class="quiet" data-preview="copy">Copy link</button></div></footer>`;
    dialog.querySelectorAll('[data-preview]').forEach(button => { button.onclick = async () => {
      const action = button.dataset.preview;
      if (action === 'close') closeQuickLook();
      else if (action === 'open') openQuickLookViewer();
      else if (action === 'notes') { const target = post.media?.findIndex(item => window.XVaultMediaMetadata.metadataFor(item).annotations.some(annotation => !annotation.deletedAt)) ?? -1; const mediaItem = target >= 0 ? post.media[target] : null, annotation = mediaItem && window.XVaultMediaMetadata.metadataFor(mediaItem).annotations.find(item => !item.deletedAt); closeQuickLook(); if (target >= 0) { openLightbox([post], 0, target); requestAnimationFrame(() => void window.XVaultSeekMediaAnnotation?.(window.XVaultMediaMetadata.mediaKey(post.id, mediaItem, target), annotation.id)); } }
      else if (action === 'inspect') { closeQuickLook(); window.openDetails(post.id); }
      else if (action === 'copy') {
        const url = window.XVaultLinks?.transform(post.url || `https://x.com/i/status/${post.id}`, settings) || post.url;
        if (!url) return;
        try { await navigator.clipboard.writeText(typeof url === 'string' ? url : url.url); button.textContent = 'Copied'; } catch { button.textContent = 'Copy failed'; }
      } else {
        quickLookIndex += action === 'next' ? 1 : -1;
        paintQuickLook(action === 'next' ? 1 : -1);
        hydrateHelperMedia(dialog);
        $('#xvQuickLookTitle')?.focus({ preventScroll: true });
      }
    }; });
    dialog.querySelectorAll('[data-review]').forEach(button => { button.onclick = () => reviewAction(button.dataset.review); });
    const stage=dialog.querySelector('.xv-preview-stage'),element=stage.querySelector('img,video');
    if(element){
      const notice=document.createElement('div');notice.className='xv-preview-unavailable';notice.hidden=true;notice.setAttribute('role','status');
      notice.innerHTML='<b>Preview unavailable</b><p>The media could not be loaded. Your archived text and metadata are still available.</p><div><button type="button" data-preview-retry>Retry preview</button><button type="button" data-preview-source>Open source post</button></div>';
      stage.append(notice);stage.setAttribute('aria-busy','true');
      const ready=()=>{delete element.dataset.helperFailed;stage.removeAttribute('aria-busy');notice.hidden=true;element.hidden=false;};
      const unavailable=()=>{if(element.getAttribute('src')?.includes('#xvhelper=')&&element.dataset.helperFailed!=='true')return;stage.removeAttribute('aria-busy');notice.hidden=false;element.hidden=true;};
      element.addEventListener('error',unavailable);
      element.addEventListener(element.tagName==='IMG'?'load':'loadedmetadata',ready);
      notice.querySelector('[data-preview-retry]').onclick=()=>{delete element.dataset.helperFailed;notice.hidden=true;element.hidden=false;stage.setAttribute('aria-busy','true');if(element.tagName==='VIDEO')element.load();else{const source=element.getAttribute('src');element.removeAttribute('src');element.setAttribute('src',source)}hydrateHelperMedia(dialog);};
      const source=window.XVaultLinks?.transform(post.url||`https://x.com/i/status/${post.id}`,settings,'x');
      const sourceButton=notice.querySelector('[data-preview-source]');sourceButton.disabled=!source;sourceButton.onclick=()=>source&&chrome.tabs.create({url:source});
      if(element.tagName==='IMG'&&element.complete){if(element.naturalWidth)ready();else unavailable();}
    }
  }

  function mediaRenderSignature(media) {
    return JSON.stringify((Array.isArray(media) ? media : []).map(item => ({ id: item?.id || '', assetId: item?.assetId || '', type: item?.type || '', url: item?.url || '', playbackUrl: item?.playbackUrl || '', preview: item?.preview || '', width: Number(item?.width) || 0, height: Number(item?.height) || 0, duration: Number(item?.duration) || 0, variants: (item?.variants || []).map(variant => [variant?.url || '', variant?.contentType || variant?.type || '', Number(variant?.bitrate) || 0]) })));
  }

  function syncQuickLookRecord(row) {
    const dialog = $('#xvQuickLook'), current = quickLookRows[quickLookIndex];
    if (!dialog?.open || !current || String(current.id) !== String(row?.id)) return;
    if (mediaRenderSignature(current.media) !== mediaRenderSignature(row.media)) {
      closeQuickLook();
      toast('This post’s media changed in another window. Reopen it to view the latest copy.');
      return;
    }
    quickLookRows[quickLookIndex] = row;
    const when = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    const title = dialog.querySelector('#xvQuickLookTitle');
    if (title) title.textContent = `@${row.author?.handle || 'unknown'}`;
    const headerMeta = title?.parentElement?.querySelector('span');
    if (headerMeta) headerMeta.textContent = [row.author?.name, when(row.createdAt)].filter(Boolean).join(' · ');
    const setFact = (label, value) => {
      const term = [...dialog.querySelectorAll('aside dt')].find(node => node.textContent === label);
      if (term?.nextElementSibling) term.nextElementSibling.textContent = value;
    };
    const um = row.userMeta || {}, provenance = row.provenance?.at(-1);
    setFact('Source', provenance?.source || (row.sourceFlags || row.archiveSources || []).join(', ') || 'Not recorded');
    setFact('Tags', (um.tags || []).join(', ') || 'Untagged');
    setFact('Review', um.reviewedAt ? `Reviewed ${when(um.reviewedAt)}` : model.isInbox(row, settings.inboxSince) ? 'Waiting in Inbox' : 'Not in Inbox');
    const button = dialog.querySelector('[data-review="favorite"]');
    if (button) button.setAttribute('aria-pressed', String(!!um.favorite));
    const paragraphs = dialog.querySelectorAll('.tweetText, .xv-preview-stage.text-only p');
    paragraphs.forEach(paragraph => { paragraph.textContent = row.text || 'No post text was recorded.'; });
    const videoNotes = (row.media || []).reduce((count, item) => count + (Array.isArray(item?.xvault?.annotations) ? item.xvault.annotations.filter(annotation => !annotation?.deletedAt).length : 0), 0);
    const notesButton = dialog.querySelector('.xv-preview-video-notes');
    if (notesButton) { notesButton.hidden = videoNotes === 0; notesButton.textContent = `Video notes · ${videoNotes}`; }
    let note = dialog.querySelector('.xv-preview-note');
    if (um.note?.trim()) {
      if (!note) { note = document.createElement('div'); note.className = 'xv-preview-note'; const label = document.createElement('b'); label.textContent = 'Your note'; const text = document.createElement('p'); note.append(label, text); dialog.querySelector('.xv-preview-body aside')?.append(note); }
      const text = note.querySelector('p'); if (text) text.textContent = um.note;
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
      if (existing) { Object.assign(existing, row); changed.add(String(row.id)); }
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
    } catch (error) { toast(`Review failed: ${error.message}`); }
  }

  function currentSearchKey() {
    return `${libraryRevision}|${($('#search')?.value || '').trim()}|${$('#sort')?.value || 'new'}|${library.length}`;
  }
  function freshRandomSeed(previous = randomSeed) {
    const values = new Uint32Array(1);
    try { crypto.getRandomValues(values); } catch { values[0] = Math.floor(Math.random() * 0x100000000) >>> 0; }
    let seed = values[0] >>> 0;
    if (!seed || seed === previous) seed = (previous + 1) >>> 0 || 1;
    return seed;
  }

  function invalidateQueryCache() {
    scheduleFacets();
    if (activeQueryId) void call({ type: 'CANCEL_LIBRARY_QUERY', queryId: activeQueryId }).catch(() => {});
    activeQueryId = '';
    loadedQueryKey = '';
    pageCursors = [null];
    pageIndex = 0;
    libraryQueryDownloadRevision = null;
    libraryTotalRecords = null;
    libraryQueryMatched = null;
    libraryQueryTruncated = false; libraryQueryRetained = null;
    libraryQueryHasMore = false;
    libraryRevision++;
  }

  // ── Query tokens: chips and facets add or remove filters instead of replacing the whole search ──
  const splitQuery = value => String(value || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const normToken = value => String(value || '').replace(/^"|"$/g, '').toLowerCase();
  const makeToken = (key, value) => /\s/.test(value) ? `"${key}:${value}"` : `${key}:${value}`;
  function setQueryTokens(tokens) {
    $('#search').value = tokens.join(' ');
    pageIndex = 0;
    renderLib();
  }
  function toggleToken(token, group = '') {
    const tokens = splitQuery($('#search').value), wanted = normToken(token);
    const at = tokens.findIndex(item => normToken(item) === wanted);
    if (at >= 0) tokens.splice(at, 1);
    else {
      if (group) for (let index = tokens.length - 1; index >= 0; index--) if (normToken(tokens[index]).startsWith(group)) tokens.splice(index, 1);
      tokens.push(token);
    }
    setQueryTokens(tokens);
  }

  let tileDirty = false;
  function syncChrome(query = $('#search')?.value || '') {
    const tokens = splitQuery(query).map(normToken), trimmed = query.trim();
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
      const active = filter ? tokens.includes(normToken(filter)) : !tokens.some(token => token.startsWith('has:') || token.startsWith('type:') || token.startsWith('rating:'));
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
  function scheduleFacets() {
    clearTimeout(facetTimer);
    facetTimer = setTimeout(renderFacets, 300);
  }
  function renderFacets() {
    const root = $('#libraryDestinations');
    if (!root) return;
    const authors = new Map(), tags = new Map();
    let inbox = 0, favorites = 0, untagged = 0;
    for (const post of library) {
      const handle = String(post.author?.handle || '').replace(/^@/, '');
      if (handle) authors.set(handle, (authors.get(handle) || 0) + 1);
      const postTags = [...new Set([...(post.userMeta?.tags || []), ...(post.media || []).flatMap(item => item?.xvault?.tags || [])])];
      for (const tag of postTags) tags.set(tag, (tags.get(tag) || 0) + 1);
      if (!postTags.length) untagged++;
      if (post.userMeta?.favorite) favorites++;
      if (model.isInbox(post, settings.inboxSince)) inbox++;
    }
    const counts = { all: libraryTotalRecords, inbox, favorites, untagged };
    for (const [id, count] of Object.entries(counts)) {
      const target = root.querySelector(`[data-destination="${id}"] .count`);
      if (target) target.textContent = count == null ? '—' : count ? fmt(count) : '';
      const button = root.querySelector(`[data-destination="${id}"]`);
      if (button) button.title = id === 'all'
        ? count == null ? 'Archive total is not calculated to keep Library paging fast.' : `${fmt(count)} posts in the archive.`
        : `${fmt(count || 0)} ${id === 'inbox' ? 'new' : id === 'favorites' ? 'favorite' : 'untagged'} posts on the loaded page.`;
    }
    const draw = (id, entries, key, limit, label) => {
      const target = $(id);
      if (!target) return;
      const sorted = [...entries].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const shown = facetOpen[key] ? sorted.slice(0, 80) : sorted.slice(0, limit);
      target.replaceChildren(...shown.map(([name, count]) => {
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
      }));
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

  function currentPageRows() {
    const filtered = resultRows();
    return filtered ? filtered.slice(0, exportPageSize()) : null;
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

  tokenMatch = (post, token) => {
    const match = /^downloaded:(true|false)$/i.exec(token);
    if (match) {
      const downloaded = model.isDownloaded(post, libraryDownloads);
      return downloaded === (match[1].toLowerCase() === 'true');
    }
    if (/^missing:(true|false)$/i.test(token)) return model.hasMissingMedia(post, libraryDownloads) === token.toLowerCase().endsWith('true');
    if (/^note:(true|false)$/i.test(token)) return Boolean(post.userMeta?.note?.trim() || (post.media || []).some(item => item?.xvault?.note?.trim() || (item?.xvault?.annotations || []).some(annotation => !annotation?.deletedAt && String(annotation?.text || '').trim()))) === token.endsWith('true');
    return baseTokenMatch(post, token);
  };

  function resultRows() {
    if (!loadedQueryKey) return null;
    return library;
  }

  function setPage(delta) {
    pageIndex = Math.max(0, pageIndex + delta);
    if (pageIndex < 0) pageIndex = 0;
    renderLib();
    const list = $('#list');
    if (list) list.scrollTo({ top: 0, behavior: document.body.dataset.motion === 'off' || document.body.dataset.motion === 'reduced' ? 'instant' : 'smooth' });
  }

  // Wall layout: a CSS grid of 4px rows; every tile spans the rows its own height needs.
  let masonryObserver = null;
  function layoutMasonry() {
    const list = $('#list');
    masonryObserver?.disconnect();
    masonryObserver = null;
    if (!list || list.dataset.view !== 'masonry' || list.classList.contains('xv-virtual-list')) return;
    const unit = 4, gap = 6;
    const tiles = [...list.children].filter(element => element.classList.contains('tweet'));
    const heights = tiles.map(tile => tile.getBoundingClientRect().height);
    tiles.forEach((tile, index) => { tile.style.gridRowEnd = `span ${Math.max(1, Math.ceil((heights[index] + gap) / unit))}`; });
    if (typeof ResizeObserver !== 'function') return;
    masonryObserver = new ResizeObserver(entries => {
      const sized = entries.map(entry => [entry.target, entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height]);
      for (const [tile, height] of sized) tile.style.gridRowEnd = `span ${Math.max(1, Math.ceil((height + gap) / unit))}`;
    });
    for (const tile of tiles) masonryObserver.observe(tile);
  }

  let performanceObserver = null;
  let libraryLongTaskObserver = null;
  const libraryLongTasks = [];
  if (typeof PerformanceObserver === 'function') {
    try {
      libraryLongTaskObserver = new PerformanceObserver(list => recordLibraryLongTasks(list.getEntries()));
      libraryLongTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch {}
  }
  function recordLibraryLongTasks(entries = []) {
    for (const entry of entries) libraryLongTasks.push({ startTime: Number(entry.startTime) || 0, duration: Number(entry.duration) || 0, name: entry.name || '', attribution: [...(entry.attribution || [])].slice(0, 3).map(item => ({ containerType: item.containerType || '', containerName: item.containerName || '', containerId: item.containerId || '' })) });
    if (libraryLongTasks.length > 200) libraryLongTasks.splice(0, libraryLongTasks.length - 200);
  }
  function longTasksDuring(startTime, endTime) {
    recordLibraryLongTasks(libraryLongTaskObserver?.takeRecords()?.getEntries?.() || []);
    return libraryLongTasks.filter(task => task.startTime <= endTime && task.startTime + task.duration >= startTime).map(task => ({ ...task }));
  }
  function measureMountedMedia(root) {
    const result = { mounted: 0, ready: 0, pending: 0, failed: 0, truncated: false };
    if (!root) return result;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let visited = 0, element;
    while ((element = walker.nextNode())) {
      if (++visited > 5000) { result.truncated = true; break; }
      if (element.localName !== 'img' && element.localName !== 'video') continue;
      if (++result.mounted > 256) { result.mounted--; result.truncated = true; break; }
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
  window.XVaultLibraryQueryState = () => ({ revision: libraryQueryRevision, totalRecords: libraryTotalRecords, pageIndex, pageSize: exportPageSize(), randomSeed, cursors: pageCursors.slice(0, 4), loaded: Boolean(loadedQueryKey), loadedFor: loadedQueryKey, lastQuery, queryKeyNow: `${libraryRevision}|${($('#search')?.value||'').trim()}|${$('#sort')?.value||'new'}|${pageIndex}|${randomSeed}|${exportPageSize()}`, activeQueryId, rankedPlanId, rankedPlanRetained: libraryQueryRetained, rankedPlanTruncated: libraryQueryTruncated, busy: $('#list')?.hasAttribute('aria-busy') || false, rows: library.length, mutationBusy, queryInputEvents, queryRenderScheduled });
  function exportPageSize() {
    const configuredPageSize = Math.min(1500, Math.max(50, Number(settings.libraryPageSize) || 120));
    return settings.libraryPerformanceMode === 'performance' ? Math.min(configuredPageSize, 80) : configuredPageSize;
  }
  function applyPerformanceHints(root) {
    if (!root) return;
    const containment = settings.libraryContentVisibility !== false && root.dataset.view !== 'masonry';
    root.style.contentVisibility = containment ? 'auto' : 'visible';
    root.style.contain = containment ? 'layout style' : 'none';
    root.querySelectorAll('.tweet').forEach(card => {
      card.style.contentVisibility = containment ? 'auto' : 'visible';
      card.style.contain = containment ? 'layout style' : 'none';
      if (containment) card.style.containIntrinsicSize = '0 360px';
      else card.style.removeProperty('contain-intrinsic-size');
    });
    root.querySelectorAll('img').forEach(image => {
      if (settings.libraryLazyMedia !== false) image.loading = 'lazy';
      image.decoding = 'async';
    });
    root.querySelectorAll('video').forEach(video => {
      if (settings.libraryPerformanceMode === 'performance' || settings.libraryPreloadMedia === 'none') video.preload = 'none';
      else if (settings.libraryPreloadMedia) video.preload = settings.libraryPreloadMedia;
      const source = video.getAttribute('src');
      if (source && !source.includes('#xvhelper=')) {
        video.dataset.mediaSrc = source;
        video.removeAttribute('src');
        video.load();
      }
    });
    performanceObserver?.disconnect();
    if ('IntersectionObserver' in window) {
      performanceObserver = new IntersectionObserver(entries => entries.forEach(entry => {
        const video = entry.target;
        if (entry.isIntersecting) {
          if (!video.getAttribute('src') && video.dataset.mediaSrc) {
            video.src = video.dataset.mediaSrc;
            const resumeAt = Number(video.dataset.resumeAt || 0);
            if (resumeAt) video.addEventListener('loadedmetadata', () => {
              if (resumeAt < video.duration) video.currentTime = resumeAt;
            }, { once: true });
          }
        } else if (settings.libraryPauseOffscreenVideo !== false) {
          video.pause();
          if (video.getAttribute('src')) {
            video.dataset.resumeAt = String(video.currentTime || 0);
            video.removeAttribute('src');
            video.load();
          }
        }
      }), { rootMargin: '240px 0px' });
      root.querySelectorAll('video[data-media-src]').forEach(video => performanceObserver.observe(video));
    } else {
      root.querySelectorAll('video[data-media-src]').forEach(video => { video.src = video.dataset.mediaSrc; });
    }
  }

  renderLib = function (dataReady = false) {
    const q = ($('#search')?.value || '').trim(), sort = $('#sort')?.value || 'new';
    // loadLib calls renderLib(true) immediately after installing a completed
    // page. The first data-ready render must not erase its key merely because
    // lastSort has not been initialized on a fresh dashboard.
    if (!dataReady && (q !== lastQuery || sort !== lastSort)) { pageIndex = 0; pageCursors = [null]; loadedQueryKey = ''; libraryQueryDownloadRevision = null; libraryTotalRecords = null; libraryQueryMatched = null; libraryQueryHasMore = false; libraryQueryTruncated = false; libraryQueryRetained = null; scheduleFacets(); }
    if (q !== lastQuery && settings.rememberLibraryQuery) {
      clearTimeout(queryPersistTimer);
      queryPersistTimer = setTimeout(() => {
        if (settings.lastLibraryQuery !== q) save({ lastLibraryQuery: q }, false);
      }, 650);
    }
    lastQuery = q;
    lastSort = sort;
    const requestKey = `${libraryRevision}|${q}|${sort}|${pageIndex}|${randomSeed}|${exportPageSize()}`;
    if (!dataReady && requestKey !== loadedQueryKey) { void loadLib(); return library; }
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
      if ($('#list') && !$('#list').childElementCount) $('#list').innerHTML = '<div class="empty" role="status">Searching your archive…</div>';
      return library;
    }
    $('#list')?.removeAttribute('aria-busy');
    releaseHelperMedia($('#list'));
    const pageSize = exportPageSize(), rows = filtered.slice(0, pageSize), start = pageIndex * pageSize;
    const exactTotal = libraryQueryMatched ?? (!q ? libraryTotalRecords : null);
    const pageTotal = libraryQueryTruncated ? libraryQueryRetained : exactTotal;
    const pages = pageTotal == null ? pageIndex + (libraryQueryHasMore ? 2 : 1) : Math.max(1, Math.ceil(pageTotal / pageSize));
    const original = library;
    const remember = settings.rememberLibraryQuery;
    settings.rememberLibraryQuery = false;
    try {
      if (settings.libraryView === 'compact' && rows.length) {
        renderCompact(rows);
        $('#libMediaCount').textContent = fmt(rows.reduce((count, post) => count + (post.media?.length || 0), 0));
        $('#libLocalCount').textContent = fmt(rows.reduce((count, post) => count + (libraryDownloads.get(String(post.id)) || []).filter(row => row.state === 'complete').length, 0));
      } else {
        library = rows;
        compactResizeObserver?.disconnect();
        $('#list').classList.remove('xv-virtual-list');
        $('#list').onscroll = null;
        baseRender({ externallyFiltered: true });
      }
    }
    finally { library = original; settings.rememberLibraryQuery = remember; }
    const shown = $('#libShown');
    if (shown) shown.textContent = filtered.length ? libraryQueryTruncated
      ? `${start + 1}–${start + rows.length} / ${fmt(libraryQueryRetained)} retained · top of ${fmt(libraryQueryMatched)} matches`
      : `${start + 1}–${start + rows.length}${exactTotal == null ? (libraryQueryHasMore ? '+' : '') : ` / ${fmt(exactTotal)}`}` : '0';
    if (!filtered.length && libraryTotalRecords !== 0 && q) {
      const empty = $('#list .empty');
      if (empty) {
        empty.replaceChildren(libraryTotalRecords == null ? `No posts match “${q}”. ` : `No posts match “${q}” (${fmt(libraryTotalRecords)} archived). `);
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.textContent = 'Clear search and filters';
        clear.onclick = () => { $('#search').value = ''; renderLib(); };
        empty.append(clear);
      }
    }
    if (!filtered.length && libraryTotalRecords === 0) {
      const empty = $('#list .empty');
      if (empty) {
        empty.className = 'empty xv-first-run';
        empty.innerHTML = '<h3>Your archive starts here</h3><p>Browse X with passive capture on, or pull in what you have already saved.</p><div class="row"><button class="primary" data-first-archive="bookmarks">Archive bookmarks</button><button data-first-archive="likes">Archive likes</button></div>';
        empty.querySelectorAll('[data-first-archive]').forEach(button => { button.onclick = () => { page('archive'); source = button.dataset.firstArchive; selectSource(); }; });
      }
    }
    renderPaging(pages, libraryQueryHasMore);
    scheduleFacets();
    renderSelection();
    applyPerformanceHints($('#list'));
    layoutMasonry();
    hydrateHelperMedia($('#list'));
    return rows;
  };

  loadLib = async function () {
    if (mutationBusy) return toast('Wait for the current Library change to finish');
    const generation = ++libraryLoadGeneration;
    const previous = library;
    if (activeQueryId) void call({ type: 'CANCEL_LIBRARY_QUERY', queryId: activeQueryId }).catch(() => {});
    const queryId = crypto.randomUUID(); activeQueryId = queryId;
    const q = ($('#search')?.value || '').trim(), sort = $('#sort')?.value || 'new', pageSize = exportPageSize();
    const rankedSort = !['new', 'old'].includes(sort),planIdentity=JSON.stringify([q,sort,randomSeed]);
    if(rankedSort&&planIdentity!==rankedPlanIdentity){rankedPlanIdentity=planIdentity;rankedPlanId=crypto.randomUUID()}
    const startedAt = performance.now(), heapBefore = performance.memory?.usedJSHeapSize ?? null;
    const rows = [], downloadRows = [];
        let afterKey = pageCursors[pageIndex] || null, expectedRevision = libraryQueryRevision, expectedDownloadRevision = libraryQueryDownloadRevision, done = false, hasMore = false, matched = null, totalRecords = null, scanned = 0, recordsRead = 0, materialized = 0, cursorOperations = 0, downloadRowsRead = 0, downloadCursorOperations = 0, searchProjectionRows = 0, bytesEstimate = 0, queryMs = 0, openMs = 0, settingsMs = 0, databaseOpenMs = 0, schemaPreparationMs = 0, queryPlanningMs = 0, pageReadMs = 0, downloadLookupMs = 0, requestCount = 0, plan = '', retries = 0, downloadsTruncated = false, truncated = false, retained = null, rankCacheHit = false;
    const list = $('#list');
    if (list) {
      releaseHelperMedia(list);
      performanceObserver?.disconnect();
      helperObserver?.disconnect();
      list.setAttribute('aria-busy', 'true');
      list.innerHTML = '<div class="empty" role="status"><span data-query-progress>Opening a bounded Library page…</span> <button type="button" class="quiet" data-cancel-library-query>Cancel search</button></div>';
      list.querySelector('[data-cancel-library-query]')?.addEventListener('click', () => {
        if(generation!==libraryLoadGeneration)return;
        const requestId=activeQueryId;activeQueryId='';libraryLoadGeneration++;
        if(requestId)void call({type:'CANCEL_LIBRARY_QUERY',queryId:requestId}).catch(()=>{});
        list.setAttribute('aria-busy','false');
        const status=list.querySelector('[data-query-progress]');if(status)status.textContent='Search canceled. ';
        const button=list.querySelector('[data-cancel-library-query]');if(button){button.textContent='Run search again';button.onclick=()=>loadLib()}
      });
    }
    try {
      for (let batch = 0; batch < 10000 && rows.length < pageSize && !done; batch++) {
        const remaining = pageSize - rows.length;
        const request = {
          type: 'QUERY_LIBRARY_PAGE', queryId, query: q, sort, limit: rankedSort ? pageSize : remaining,
          offset: rankedSort ? pageIndex * pageSize : 0,
          after: rankedSort ? null : afterKey, expectedRevision, expectedDownloadRevision, randomSeed, rankPlanId: rankedSort ? rankedPlanId : undefined,
          scanLimit: 10000
        };
        let page;
        if(rankedSort){
          let polling=false;
          const timer=setInterval(async()=>{
            if(polling||generation!==libraryLoadGeneration||activeQueryId!==queryId)return;
            polling=true;
            try{const state=await call({type:'GET_LIBRARY_QUERY_PROGRESS',queryId}),progress=state?.progress,status=list?.querySelector('[data-query-progress]');if(status&&progress?.phase==='scan')status.textContent=`Sorting archive · checked ${fmt(progress.scanned)} posts · ${fmt(progress.matched)} matches`;else if(status&&progress?.phase==='materialize')status.textContent=`Loading ${fmt(progress.matched)} ranked matches…`}catch{}finally{polling=false}
          },180);
          try{page=await call(request)}finally{clearInterval(timer)}
        }else page=await call(request);
        if (generation !== libraryLoadGeneration) return;
        if (!page?.ok) throw Error(page?.error || 'The Library page could not be read');
        if (page.cancelled) return;
        requestCount++;
        if (page.stale) {
          if (retries++) throw Error('The archive kept changing while this page was read. It is still safe; retry the query.');
          libraryQueryRevision = page.revision; pageCursors = [null]; pageIndex = 0; afterKey = null; expectedRevision = page.revision;
          if (page.downloadRevision != null) libraryQueryDownloadRevision = expectedDownloadRevision = page.downloadRevision;
          toast('The Library changed in another window. Restarted this query from the first page.');
          batch = -1; rows.length = 0; downloadRows.length = 0; continue;
        }
        expectedRevision = page.revision;
        libraryQueryRevision = page.revision;
        if (page.downloadRevision != null) libraryQueryDownloadRevision = expectedDownloadRevision = page.downloadRevision;
        if (page.totalRecords != null) totalRecords = Number(page.totalRecords);
        if (page.matched != null) matched = page.matched;
        truncated ||= !!page.truncated;if(page.retained!=null)retained=Number(page.retained);
        rankCacheHit ||= !!page.rankCacheHit;
        rows.push(...(page.rows || []));
        downloadRows.push(...(page.downloads || []));
        downloadsTruncated ||= !!page.downloadsTruncated;
        scanned += Number(page.scanned || 0); materialized += Number(page.materialized || page.recordsRead || 0);
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
        if (list && !done && rows.length < pageSize) {
          const status = list.querySelector('.empty');
          if (status) status.textContent = `Searching indexed records · ${fmt(scanned)} checked · ${fmt(rows.length)} matches`;
        }
        if (rankedSort || rows.length >= pageSize || done) break;
        if (!page.nextKey || page.nextKey === afterKey && !page.scanned) throw Error('The Library cursor stopped advancing. Restart the query.');
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
      library = rows;
      libraryDownloads = nextDownloads;
      libraryTotalRecords = totalRecords;
      libraryQueryMatched = matched;
      libraryQueryTruncated = truncated;libraryQueryRetained = retained;
      libraryQueryHasMore = rankedSort ? hasMore : !done;
      if (!rankedSort) pageCursors[pageIndex + 1] = libraryQueryHasMore ? afterKey : null;
      loadedQueryKey = `${libraryRevision}|${q}|${sort}|${pageIndex}|${randomSeed}|${pageSize}`;
      if (activeQueryId === queryId) activeQueryId = '';
      const renderStartedAt = performance.now();
      renderLib(true);
      const usableAt = performance.now();
      void refreshActiveLibrarySurfaces();
      const endedAt = performance.now(), renderMs = usableAt - renderStartedAt, media = measureMountedMedia(list), heapAfter = performance.memory?.usedJSHeapSize ?? null;
      libraryQueryMetrics.push({ at: Date.now(), queryStartPerformanceMs: startedAt, queryEndPerformanceMs: endedAt, plan, sort, queryLength: q.length, archiveRecords: totalRecords, revision: libraryQueryRevision, downloadRevision: libraryQueryDownloadRevision, queryRequests: requestCount, rankCacheHit, rankedRowsRetained: retained, rankedPlanTruncated: truncated, recordsScanned: scanned, recordsRead, recordsMaterialized: materialized, searchProjectionRows, cursorOperations, recordsReturned: rows.length, dashboardRecordsRetained: rows.length, downloadRowsRead, downloadCursorOperations, responseBytesEstimate: bytesEstimate, openMs, settingsMs, databaseOpenMs, schemaPreparationMs, queryPlanningMs, pageReadMs, downloadLookupMs, queryMs, searchIndexMs: 0, pageRetrievalMs: pageRetrievedAt - startedAt, renderMs, firstRenderMs: renderMs, usableLibraryMs: usableAt - startedAt, mediaMounted: media.mounted, mediaReady: media.ready, mediaPending: media.pending, mediaFailed: media.failed, mediaMeasurementTruncated: media.truncated, mainThreadLongTasks: longTasksDuring(startedAt, endedAt), heapBeforeBytes: heapBefore, heapAfterBytes: heapAfter, heapDeltaBytes: heapBefore != null && heapAfter != null ? heapAfter - heapBefore : null, heapMeasurement: heapBefore != null && heapAfter != null ? 'performance.memory (coarse; not a peak)' : 'unavailable' });
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
        retry.onclick = workerMismatch ? () => {
          retry.disabled = true;
          retry.textContent = 'Reloading XVault…';
          try { chrome.runtime.reload(); } catch { location.reload(); }
        } : () => loadLib();
        warning.append(retry);
        list.prepend(warning);
      }
    }
  };

  function renderPaging(pages, hasMore = false) {
    const target = $('#libraryPages');
    if (!target) return;
    const exact = libraryQueryMatched != null || (!($('#search')?.value || '').trim() && libraryTotalRecords != null);
    const canNext = exact ? pageIndex < pages - 1 : hasMore;
    target.hidden = pageIndex === 0 && !canNext;
    target.innerHTML = `<button id="libraryPrev" class="quiet" ${pageIndex === 0 ? 'disabled' : ''}>← Previous</button><span>${exact ? `Page ${pageIndex + 1} of ${pages}` : `Page ${pageIndex + 1} · ${hasMore ? 'more results' : 'end of results'}`}</span><button id="libraryNext" class="quiet" ${!canNext ? 'disabled' : ''}>Next →</button>`;
    $('#libraryPrev').onclick = () => setPage(-1);
    $('#libraryNext').onclick = () => setPage(1);
  }

  function renderSelection() {
    const cards = $$('#list .tweet');
    const matching = resultRows();
    const visibleRows = matching ? matching.slice(0, exportPageSize()) : [];
    const byId = new Map(visibleRows.map(post => [String(post.id), post]));
    for (const card of cards) {
      card.querySelectorAll('.xv-color-pill,.xv-card-select,.xv-open-player').forEach(element => element.remove());
      const id = card.dataset.id;
      const color = byId.get(id)?.userMeta?.colorLabel || card.dataset.colorLabel;
      if (color && color !== 'none') {
        card.dataset.colorLabel = color;
        const pill = document.createElement('span');
        pill.className = 'xv-color-pill';
        pill.textContent = `${color} label`;
        card.prepend(pill);
      } else delete card.dataset.colorLabel;
      const label = document.createElement('label');
      label.className = 'xv-card-select';
      label.innerHTML = `<input type="checkbox" aria-label="Select post ${esc(id)}" ${selected.has(id) ? 'checked' : ''}><span class="sr">Select</span>`;
      label.onclick = event => event.stopPropagation();
      label.querySelector('input').onclick = event => { event.currentTarget.dataset.shiftSelection = event.shiftKey ? '1' : '0'; };
      label.querySelector('input').onchange = event => {
        if (event.target.dataset.shiftSelection === '1' && selectionAnchor) {
          const matching = resultRows();
          if (matching) model.applySelectionRange(selected, matching, selectionAnchor, id, event.target.checked);
        }
        if (event.target.checked) {
          if (selected.size >= 5000 && !selected.has(id)) { event.target.checked = false; toast('Selection is limited to 5,000 posts at a time.'); return; }
          selected.add(id);
        }
        else selected.delete(id);
        event.target.dataset.shiftSelection = '0';
        selectionAnchor = id;
        updateSelectionBar();
      };
      card.prepend(label);
      card.tabIndex = 0;
      card.classList.toggle('xv-selected', selected.has(id));
      for (const media of [...card.querySelectorAll('.mediaItem')].filter(item => item.querySelector('video'))) {
        const open = document.createElement('button');
        open.className = 'xv-open-player';
        open.type = 'button';
        open.title = 'Open in viewer';
        open.innerHTML = '<span class="sr">Open player</span>';
        open.insertAdjacentHTML('afterbegin', window.XVaultIcons?.svg('quicklook') || '');
        open.onclick = event => {
          event.stopPropagation();
          const matching = resultRows();
          if (!matching) return toast('Wait for the current search to finish');
          const rows = matching.slice(0, exportPageSize());
          const index = rows.findIndex(post => String(post.id) === id);
          if (index >= 0) openLightbox(rows, index, Number(media.dataset.m));
        };
        media.append(open);
      }
    }
    updateSelectionBar();
  }

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
    if (exportBusy) { exportWorker?.terminate(); exportWorker=null; exportBusy=false; }
    if (exportQueryId) { const queryId = exportQueryId; exportQueryId = ''; void call({ type: 'CANCEL_LIBRARY_QUERY', queryId }).catch(() => {}); }
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
    const providerName = window.XVaultLinks?.label(settingProvider) || (settingProvider === 'custom' ? 'Custom' : 'FixVX');
    const host = window.XVaultLinks?.providerHost(settingProvider, settings);
    const dialog = $('#libraryExportDialog');
    dialog.dataset.scope = scope;
    $('#libraryExportQuery').textContent = `Search - ${($('#search')?.value || '').trim() || 'All posts'}`;
    $('#libraryExportProvider').textContent = host ? `${providerName} - ${host}` : 'Invalid custom provider';
    const total = libraryQueryMatched ?? (!($('#search')?.value || '').trim() ? libraryTotalRecords : null);
    const completeInMemory = !libraryQueryHasMore;
    const count = scope === 'selected' ? selected.size : scope === 'page' ? (matching ? Math.min(matching.length, exportPageSize()) : 0) : completeInMemory ? (total ?? matching?.length ?? 0) : (matching?.length || 0);
    const streaming = scope === 'all' && (libraryQueryHasMore || libraryQueryTruncated);
    $('#libraryExportCount').textContent = streaming
      ? `${fmt(matching?.length || 0)} loaded; remaining matches stream newest first in revision-checked pages`
      : `${ready ? fmt(count || 0) : '...'} ${scope === 'all' ? 'matching' : scope === 'page' ? 'on this page' : 'selected'} unique posts${ready ? '' : ' - search pending'}`;
    const disabled = !ready || !count || !host || exportBusy;
    $('#libraryExportTxt').disabled = disabled;
    $('#libraryCopyLinks').disabled = disabled;
  }

  function exportRecords() {
    const matching = resultRows();
    if (!matching) throw new Error('Wait for the current search to finish');
    const scope = $('#libraryExportScope').value;
    if (scope === 'all' && (libraryQueryHasMore || libraryQueryTruncated)) return { posts: [], stream: true };
    const currentPage = matching.slice(0, exportPageSize());
    return { posts: window.XVaultLinkExport.selectScope(matching, scope, selected, currentPage), stream: false };
  }

  function runLinkExport(action) {
    if (exportBusy) return;
    let posts, streamAll;
    try { ({ posts, stream: streamAll } = exportRecords()); } catch (error) { toast(error.message); return; }
    if (!streamAll && !posts.length) return toast('No posts in this export scope');
    if (!window.XVaultLinks?.providerHost(settings.linkProvider || 'fixvx', settings)) return toast('Choose a valid link provider in Settings');
    exportBusy = true;
    const progress = $('#libraryExportProgress');
    progress.hidden = false;
    progress.textContent = streamAll ? 'Starting a revision-checked Library scan...' : `Collecting links... 0 / ${fmt(posts.length)}`;
    $('#libraryCancelExport').hidden = false;
    $('#libraryExportTxt').disabled = $('#libraryCopyLinks').disabled = true;
    const worker = new Worker('library-export-worker.js');
    exportWorker = worker;
    exportQueryId = streamAll ? crypto.randomUUID() : '';
    let abortReason = '';
    const cancelQuery = () => {
      if (!exportQueryId) return;
      const queryId = exportQueryId; exportQueryId = '';
      void call({ type: 'CANCEL_LIBRARY_QUERY', queryId }).catch(() => {});
    };
    const clean = () => {
      worker.terminate();
      if (exportWorker === worker) exportWorker = null;
      cancelQuery(); exportStreamAck = null;
      exportBusy = false; $('#libraryCancelExport').hidden = true;
      refreshLinkExportSummary();
    };
    const chunkSize = 400;
    const sendChunk = start => {
      if (start >= posts.length) { worker.postMessage({ type: 'finish' }); return; }
      const chunk = posts.slice(start, start + chunkSize).map(post => ({ id: post?.id, url: post?.url, handle: post?.author?.handle, author: { handle: post?.author?.handle } }));
      worker.postMessage({ type: 'chunk', posts: chunk, done: Math.min(posts.length, start + chunkSize) });
    };
    const streamAllPages = async () => {
      const queryId = exportQueryId, query = ($('#search')?.value || '').trim(), randomSeedAtStart = randomSeed;
      let after = null, expectedRevision = libraryQueryRevision, expectedDownloadRevision = libraryQueryDownloadRevision;
      let scanned = 0, submitted = 0, done = false;
      while (!done) {
        if (!exportBusy || exportWorker !== worker) return;
        const page = await call({ type: 'QUERY_LIBRARY_PAGE', queryId, query, sort: 'new', limit: chunkSize, after, expectedRevision, expectedDownloadRevision, randomSeed: randomSeedAtStart, scanLimit: 10000, includeDownloads: false });
        if (!exportBusy || exportWorker !== worker) return;
        if (!page?.ok) throw Error(page?.error || 'The Library changed before the export could finish');
        if (page.cancelled) return;
        if (page.stale) throw Error('The archive changed during export. No file was created; restart the export with current results.');
        if (expectedRevision != null && Number(page.revision) !== Number(expectedRevision)) throw Error('The archive revision changed during export. No file was created; restart the export.');
        expectedRevision = page.revision;
        if (page.downloadRevision != null) expectedDownloadRevision = page.downloadRevision;
        const batch = (page.rows || []).map(post => ({ id: post?.id, url: post?.url, handle: post?.author?.handle, author: { handle: post?.author?.handle } }));
        scanned += Number(page.scanned || 0);
        submitted += batch.length;
        done = !!page.done;
        if (batch.length) {
          const ack = new Promise((resolve, reject) => { exportStreamAck = { resolve, reject }; });
          worker.postMessage({ type: 'chunk', posts: batch, done: submitted });
          progress.textContent = `Scanning - ${fmt(scanned)} records checked - ${fmt(submitted)} matching posts queued`;
          await ack;
          exportStreamAck = null;
        } else {
          progress.textContent = `Scanning - ${fmt(scanned)} records checked - ${fmt(submitted)} matching posts queued`;
        }
        if (!done) {
          const next = page.nextKey || null;
          if (!next || JSON.stringify(next) === JSON.stringify(after)) throw Error('The Library cursor did not advance during export. No file was created.');
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
        if (streamAll) void streamAllPages().catch(error => {
          if (!exportBusy || exportWorker !== worker) return;
          abortReason = error.message || 'The Library changed during export';
          progress.textContent = abortReason;
          exportStreamAck?.reject(error); exportStreamAck = null;
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
        clean(); progress.textContent = abortReason ? `Export stopped - ${abortReason}` : 'Export cancelled';
        if (!abortReason) toast('Link export cancelled');
      } else if (message.type === 'complete') {
        try {
          if (!message.unique) { progress.textContent = `No valid post links found - ${message.skipped} skipped`; toast('No valid post links to export'); return; }
          if (action === 'copy') {
            await navigator.clipboard.writeText(message.text);
          } else {
            download(message.text, window.XVaultLinkExport.sanitizeFilename($('#search').value, message.unique), 'text/plain;charset=utf-8');
          }
          progress.textContent = `${fmt(message.unique)} unique links exported - ${fmt(message.duplicates)} duplicates skipped${message.skipped ? ` - ${fmt(message.skipped)} invalid skipped` : ''}`;
          toast(`${fmt(message.unique)} unique links ${action === 'copy' ? 'copied' : 'exported'} - ${fmt(message.duplicates)} duplicates skipped`);
        } catch (error) {
          progress.textContent = action === 'copy' ? 'Clipboard access failed' : 'Could not create the TXT file';
          toast(action === 'copy' ? 'Clipboard access failed' : `Export failed: ${error.message}`);
        } finally { clean(); }
      }
    };
    worker.onerror = error => {
      const failure = Error(error.message || 'Link export worker failed');
      exportStreamAck?.reject(failure); exportStreamAck = null;
      clean(); progress.textContent = 'Export failed'; toast(`Export failed: ${failure.message}`);
    };
    worker.postMessage({ type: 'start', settings, perBlock: Number($('#libraryExportBlock').value), total: streamAll ? 0 : posts.length });
  }

  function updateSelectionBar() {
    for (const card of $$('#list .tweet')) card.classList.toggle('xv-selected', selected.has(card.dataset.id));
    const listEl = $('#list');
    if (listEl) listEl.dataset.selecting = selected.size ? 'true' : 'false';
    const bar = $('#libraryBulk');
    if (!bar) return;
    bar.hidden = selected.size === 0 && lastTrashed.length === 0 && !mutationBusy;
    bar.dataset.undoOnly = selected.size === 0 && !mutationBusy ? 'true' : 'false';
    $('#librarySelectedCount').textContent = mutationProgress || (selected.size ? `${fmt(selected.size)} selected` : `${fmt(lastTrashed.length)} ${undoLimited ? 'recent posts · older copies in Trash' : 'posts awaiting recovery'}`);
    bar.querySelectorAll('button').forEach(button => { button.disabled = mutationBusy; });
    $('#libraryUndoTrash').hidden = lastTrashed.length === 0;
    $('#libraryUndoTrash').textContent = undoLimited ? 'Undo recent Trash' : 'Undo Trash';
    $('#libraryUndoTrash').title = undoLimited ? 'Restore recent removals. Browse Trash to recover older copies.' : 'Restore the pending removals';
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

  function selectVisiblePage() {
    const rows = resultRows();
    if (!rows) return;
    const next = model.addSelection(selected, rows.slice(0, exportPageSize()).map(post => post.id));
    if (next.length > 5000) { toast('Selection is limited to 5,000 posts at a time.'); return; }
    selected.clear();
    for (const id of next) selected.add(id);
    renderSelection();
  }

  function invertVisiblePage() {
    const rows = resultRows();
    if (!rows) return;
    const next = model.invertSelection(selected, rows.slice(0, exportPageSize()).map(post => post.id));
    if (next.length > 5000) { toast('Selection is limited to 5,000 posts at a time.'); return; }
    selected.clear();
    for (const id of next) selected.add(id);
    renderSelection();
  }

  async function bulkMeta(patch, label) {
    if (mutationBusy) return;
    const ids = [...selected];
    if (!ids.length) return;
    mutationBusy = true;
    let updated = 0;
    const changedIds = new Set();
    const byId = new Map(library.map(row => [String(row.id), row]));
    try {
      for (let start = 0; start < ids.length; start += 200) {
        mutationProgress = `${label} · ${fmt(start)} / ${fmt(ids.length)}`;
        updateSelectionBar();
        const result = await call({ type: 'BULK_UPDATE_TWEET_META', ids: ids.slice(start, start + 200), patch });
        if (!result?.ok) throw Error(result?.error || 'Update failed');
        for (const row of result.rows || []) { const existing = byId.get(String(row.id)); if (existing) { Object.assign(existing, row); changedIds.add(String(row.id)); } }
        updated += result.updated || 0;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      toast(`${label} · ${fmt(updated)} posts`);
    } catch (error) { toast(`${label} stopped after ${fmt(updated)} posts: ${error.message}. Retry the remaining selection.`); }
    finally {
      mutationBusy = false; mutationProgress = '';
      invalidateQueryCache(changedIds); renderLib(); updateSelectionBar();
    }
  }

  function trashSelected() { return trashPosts([...selected], { ask: true }); }

  async function refreshTrashUndo() {
    try {
      const result = await call({ type: 'GET_TRASH_UNDO' });
      if (result?.ok && !mutationBusy) { lastTrashed = (result.ids || []).map(String); undoLimited = !!result.limited; updateSelectionBar(); }
    } catch { /* Browsable Trash remains available if the Undo read fails. */ }
  }
  window.XVaultLibraryRefreshUndo = refreshTrashUndo;

  async function applyRestoredRecords(rows) {
    const known = new Set(library.map(row => String(row.id))), added = [];
    for (const row of rows) if (!known.has(String(row.id))) { library.push(row); known.add(String(row.id)); added.push(String(row.id)); }
    try {
      if (added.length) {
        const downloads = await call({ type: 'GET_DOWNLOADS_FOR_TWEETS', ids: added });
        if (!downloads?.ok) throw Error(downloads?.error || 'Download state unavailable');
        for (const id of added) libraryDownloads.set(id, []);
        for (const row of downloads.rows || []) libraryDownloads.get(String(row.item?.tweetId))?.push(row);
      }
    } catch { toast('Posts restored. Reload the Library to retry their download state.'); }
    invalidateQueryCache(); renderLib();
    document.dispatchEvent(new Event('xv:library'));
    await refreshTrashUndo();
  }
  window.XVaultLibraryApplyRestore = applyRestoredRecords;
  // Metadata notifications read only affected records, never the archive index.
  const metadataChannel = new BroadcastChannel('xvault-library-metadata');
  const libraryChangesChannel = new BroadcastChannel('xvault-library-changes');
  const pendingMetadata = new Set(); let metadataTimer, metadataReading = false;
  async function syncMetadata() {
    if (metadataReading) return;
    metadataReading = true;
    const observedIds = new Set();
    try {
      while (pendingMetadata.size) {
        const ids = [...pendingMetadata].slice(0, 128); ids.forEach(id => pendingMetadata.delete(id));
        const result = await call({type:'GET_LIBRARY_METADATA',ids});
        if (!result?.ok) { toast('Metadata synchronization failed. Reload to retry.'); break; }
        for (const row of result.rows || []) observedIds.add(String(row.id));
        const indexes = libraryRecordIndexes();
        const changed = [];
        for (const row of result.rows) {
          const index = indexes.get(String(row.id)), post = index === undefined ? null : library[index];
          if (post && JSON.stringify(post.userMeta || {}) !== JSON.stringify(row.userMeta)) { post.userMeta = row.userMeta; post.updatedAt = row.updatedAt; changed.push(String(post.id)); }
        }
        if (changed.length) scheduleFacets();
      }
      // An off-page record can enter or leave a metadata-backed query even
      // though this window has no cached row to compare. Revalidate once after
      // the bounded ID reads, rather than silently keeping stale query results
      // or restarting the same query once per 128-ID batch.
      if (observedIds.size) window.XVaultLibraryRecordUpdated?.([...observedIds]);
    } catch { toast('Metadata synchronization failed. Reload to retry.'); }
    finally { metadataReading = false; }
  }
  metadataChannel.onmessage = event => {
    if (!Array.isArray(event.data?.ids)) return;
    for (const id of event.data.ids.slice(0,1000)) pendingMetadata.add(String(id));
    clearTimeout(metadataTimer); metadataTimer = setTimeout(syncMetadata, 80);
  };
  let libraryChangeTimer = 0, pendingLibraryKinds = new Set(), pendingLibraryIds = new Set(), pendingLibraryTruncated = false;
  const queryUsesDownloadState = () => /(?:^|\s)(?:downloaded|missing|size):/i.test($('#search')?.value || '');
  function drainLibraryChanges() {
    if (!pendingLibraryKinds.size) return;
    if (mutationBusy) { libraryChangeTimer = setTimeout(drainLibraryChanges, 50); return; }
    const kinds = pendingLibraryKinds, ids = pendingLibraryIds, truncated = pendingLibraryTruncated;
    pendingLibraryKinds = new Set(); pendingLibraryIds = new Set(); pendingLibraryTruncated = false;
    if (kinds.has('remove')) for (const id of ids) selected.delete(id);
    if (kinds.has('clear') || truncated) selected.clear();
    pageCursors = [null]; pageIndex = 0;
    invalidateQueryCache();
    if ($('#page-library')?.classList.contains('show')) renderLib();
    void refreshActiveLibrarySurfaces(ids.size && !truncated ? ids : null).catch(() => toast('An open post could not be refreshed.'));
  }
  function scheduleLibraryChangeDrain() {
    clearTimeout(libraryChangeTimer);
    libraryChangeTimer = setTimeout(drainLibraryChanges, 100);
  }
  async function refreshActiveLibrarySurfaces(changedIds = null) {
    const dialog = $('#xvQuickLook'), drawer = $('#detailsDrawer');
    const activeIds = new Set();
    const qlRowId = dialog?.open ? String(window.XVaultQuickLookPostId?.() || '') : '';
    const inspectorId = drawer && !drawer.classList.contains('hidden') ? String(drawer.dataset.postId || '') : '';
    const lightboxId = !$('#lightbox')?.classList.contains('hidden') ? String(window.XVaultLightboxPostId?.() || '') : '';
    for (const id of [qlRowId, inspectorId, lightboxId]) if (id && (!changedIds || changedIds.has(id))) activeIds.add(id);
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
        if (qlRowId === id) { window.XVaultCloseQuickLook?.(); toast('This post is no longer in the Library. Check Trash or refresh the query.'); }
        if (lightboxId === id) { window.XVaultCloseLightbox?.(); toast('This post is no longer in the Library. Check Trash or refresh the query.'); }
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
        void syncVisibleDownloadRows(ids).catch(() => toast('Download status changed. Reload this page to refresh its visible files.'));
      }
      void refreshActiveLibrarySurfaces(event.data?.truncated ? null : new Set(ids)).catch(() => toast('The open post could not refresh its download status.'));
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
    if (!ids.length || (ask && !confirm(`Move ${ids.length} selected posts to local Trash? Downloaded files stay on disk.`))) return;
    const moved = new Set();
    mutationBusy = true;
    let conflicts = 0;
    try {
      for (let start = 0; start < ids.length; start += 200) {
        mutationProgress = `Moving to Trash · ${fmt(start)} / ${fmt(ids.length)}`; updateSelectionBar();
        const result = await call({ type: 'MOVE_TWEETS_TO_TRASH', ids: ids.slice(start, start + 200) });
        if (!result?.ok) throw Error(result?.error || 'Trash change failed');
        for (const id of result.ids || []) moved.add(String(id));
        conflicts += result.conflicts?.length || 0;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      toast(`${fmt(moved.size)} ${moved.size === 1 ? 'post' : 'posts'} moved to Trash.${conflicts ? ` ${conflicts} existing Trash copies preserved.` : ''} Undo is in the bar below the library.`);
    } catch (error) { toast(`Moved ${fmt(moved.size)} posts before stopping: ${error.message}. Undo remains available.`); }
    finally {
      const undoIds = [...new Set([...lastTrashed, ...moved])]; undoLimited = undoLimited || undoIds.length > 1000; lastTrashed = undoIds.slice(-1000);
      library = library.filter(row => !moved.has(String(row.id)));
      for (const id of moved) selected.delete(id);
      mutationBusy = false; mutationProgress = '';
      invalidateQueryCache(); renderLib(); updateSelectionBar();
      document.dispatchEvent(new Event('xv:trash-updated')); await refreshTrashUndo();
    }
  }

  async function undoTrash() {
    if (!lastTrashed.length || mutationBusy) return;
    mutationBusy = true;
    const ids = [...lastTrashed], restoredIds = new Set(), restoredRows = [];
    let conflicts = 0, errorMessage = '';
    try {
      for (let start = 0; start < ids.length; start += 200) {
        mutationProgress = `Restoring · ${fmt(start)} / ${fmt(ids.length)}`; updateSelectionBar();
        const result = await call({ type: 'RESTORE_TWEETS_FROM_TRASH', ids: ids.slice(start, start + 200) });
        if (!result?.ok) throw Error(result?.error || 'Restore failed');
        for (const id of result.ids || []) restoredIds.add(String(id));
        restoredRows.push(...(result.rows || []));
        conflicts += result.conflicts?.length || 0;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } catch (error) { errorMessage = error.message; }
    finally {
      lastTrashed = lastTrashed.filter(id => !restoredIds.has(id));
      mutationBusy = false; mutationProgress = ''; updateSelectionBar();
      if (restoredRows.length === restoredIds.size) await applyRestoredRecords(restoredRows);
      else await loadLib(); // Compatibility with older message handlers.
      document.dispatchEvent(new Event('xv:trash-updated'));
      toast(`${fmt(restoredIds.size)} posts restored.${conflicts ? ` ${conflicts} newer archive copies preserved; older copies remain in Trash.` : ''}${errorMessage ? ` Stopped: ${errorMessage}. You can retry Undo.` : ''}`);
    }
  }

  async function saveView() {
    const query = $('#search').value.trim();
    if (!query) return toast('Enter a search first');
    const input = $('#libraryViewName');
    const name = input.value.trim();
    if (!name) { input.focus(); return toast('Name the search, then save it'); }
    const collection = { id: crypto.randomUUID(), name: name.slice(0, 48), query, sort: $('#sort').value, view: $('#libraryView').value, icon: $('#libraryCollectionIcon')?.value || 'saved', createdAt: Date.now() };
    try {
      const result = await call({ type: 'UPDATE_SMART_COLLECTIONS', change: { op: 'save', collection } });
      if (!result?.ok) throw Error(result?.error || 'Could not save collection');
      settings.savedViews = result.settings?.savedViews || settings.savedViews || [];
      input.value = '';
      renderSavedViews();
      toast(`${result.updated ? 'Updated' : 'Saved'} Smart Collection · “${collection.name}”`);
    } catch (error) { toast(error.message || 'Could not save collection'); }
  }

  function renderSavedViews() {
    const target = $('#facetViews');
    if (!target) return;
    const views = settings.savedViews || [];
    target.replaceChildren(...views.map((view, index) => {
      const normalized = window.XVaultCollections?.normalizeDefinition?.(view, index) || { id: String(index), icon: 'saved', name: view.name || 'Untitled', query: view.query || '' };
      const row = document.createElement('div');
      row.className = 'facet-row';
      row.dataset.collectionId = normalized.id;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'facet-item';
      open.dataset.viewIndex = String(index);
      open.title = normalized.query;
      const icon = document.createElement('span'); icon.className = 'facet-icon'; icon.innerHTML = window.XVaultIcons?.svg(normalized.icon) || '';
      const label = document.createElement('span'); label.className = 'facet-name'; label.textContent = normalized.name;
      open.append(icon, label);
      const reorder = document.createElement('span'); reorder.className = 'facet-reorder';
      for (const [delta, iconName, labelText] of [[-1, 'previous', 'Move up'], [1, 'next', 'Move down']]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'quiet facet-move'; button.dataset.viewMove = String(delta); button.dataset.viewId = normalized.id;
        button.setAttribute('aria-label', `${labelText} ${normalized.name}`); button.title = labelText;
        button.disabled = index + delta < 0 || index + delta >= views.length;
        button.innerHTML = window.XVaultIcons?.svg(iconName) || (delta < 0 ? '↑' : '↓'); reorder.append(button);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'quiet facet-remove';
      remove.dataset.viewRemove = normalized.id;
      remove.setAttribute('aria-label', `Remove Smart Collection ${normalized.name}`);
      remove.textContent = '×';
      row.append(open, reorder, remove);
      return row;
    }));
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
    const view = settings.savedViews?.find((value, position) => String(value.id || window.XVaultCollections?.normalizeDefinition?.(value, position)?.id || position) === String(index));
    if (!view) return;
    if (!confirm(`Remove the Smart Collection “${view.name}”? Its query definition is removed; your posts are not affected.`)) return;
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
    dialog.innerHTML = '<form method="dialog"><header><div><small>PORTABLE QUERY DEFINITIONS</small><h2 id="xvCollectionImportTitle">Import Smart Collections</h2></div><button type="submit" value="cancel" class="quiet" aria-label="Cancel import">×</button></header><p class="xv-collection-import-explain">Collections contain search rules and display choices. They do not include posts or media. Existing collections will never be replaced.</p><div class="xv-collection-import-counts" role="status"></div><ol class="xv-collection-import-list"></ol><p class="xv-collection-import-error" role="alert" hidden></p><footer><button type="submit" value="cancel" class="quiet">Cancel</button><button type="button" data-import-policy="skip"></button><button type="button" data-import-policy="keep-both" class="primary"></button></footer></form>';
    const counts = dialog.querySelector('.xv-collection-import-counts');
    counts.textContent = `${plan.counts.add} new · ${plan.counts.identical} already present · ${plan.counts.conflict} name/rule conflicts · ${plan.counts.invalid} invalid`;
    const list = dialog.querySelector('.xv-collection-import-list');
    for (const item of plan.items.slice(0, 12)) {
      const li = document.createElement('li'), name = document.createElement('b'), query = document.createElement('code'), state = document.createElement('span');
      name.textContent = item.collection.name; query.textContent = item.collection.query; state.textContent = `${item.action}${item.reason ? ` · ${item.reason}` : ''}`;
      li.dataset.state = item.action; li.append(name, query, state); list.append(li);
    }
    for (const item of plan.invalid.slice(0, 4)) { const li = document.createElement('li'); li.dataset.state = 'invalid'; li.textContent = item.error; list.append(li); }
    if (plan.items.length + plan.invalid.length > 16) { const more = document.createElement('li'); more.className = 'quiet'; more.textContent = `Preview shows 16 of ${plan.items.length + plan.invalid.length} entries.`; list.append(more); }
    const safe = dialog.querySelector('[data-import-policy="skip"]'), keep = dialog.querySelector('[data-import-policy="keep-both"]');
    safe.textContent = `Import ${plan.counts.add} new · skip conflicts`;
    safe.disabled = plan.counts.add === 0;
    keep.textContent = plan.counts.conflict ? `Keep both · ${plan.counts.add + plan.counts.conflict} additions` : `Import ${plan.counts.add} new`;
    keep.disabled = plan.counts.add + plan.counts.conflict === 0;
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    for (const button of [safe, keep]) button.addEventListener('click', async () => {
      button.disabled = true; safe.disabled = true; keep.disabled = true;
      const error = dialog.querySelector('.xv-collection-import-error'); error.hidden = true;
      try {
        const result = await call({ type: 'UPDATE_SMART_COLLECTIONS', change: { op: 'import', fileText, conflicts: button.dataset.importPolicy } });
        if (!result?.ok) throw Error(result?.error || 'Import could not be saved');
        settings.savedViews = result.settings?.savedViews || settings.savedViews || [];
        renderSavedViews();
        dialog.close();
        toast(`${result.added || 0} added · ${result.skipped || 0} skipped${result.invalid ? ` · ${result.invalid} invalid` : ''}`);
      } catch (reason) {
        error.textContent = reason.message || 'Import could not be saved'; error.hidden = false; safe.disabled = plan.counts.add === 0; keep.disabled = plan.counts.add + plan.counts.conflict === 0;
      }
    });
    dialog.showModal();
    (safe.disabled ? keep : safe).focus();
  }

  async function importSmartCollections(event) {
    const input = event.currentTarget, file = input.files?.[0];
    if (!file) return;
    try {
      const fileText = await file.text();
      const plan = window.XVaultCollections.previewImport(fileText, settings.savedViews || []);
      showCollectionImportDialog(plan, fileText);
    } catch (error) { toast(error.message || 'This Smart Collection file could not be read'); }
    finally { input.value = ''; }
  }

  async function bulkDownload() {
    const posts = library.filter(post => selected.has(String(post.id)));
    const items = posts.flatMap(post => (post.media || []).map((media, index) => downloadItem(post, media, index)).filter(Boolean));
    if (!items.length) return toast('Selected posts contain no downloadable media');
    const result = await call({ type: 'DOWNLOAD_URLS', items });
    toast(result?.ok ? `${result.added || 0} media queued · ${result.skipped || 0} skipped` : result?.error || 'Could not queue selected media');
  }

  async function bulkCopy() {
    const urls = library.filter(post => selected.has(String(post.id))).map(post => post.url).filter(Boolean);
    await navigator.clipboard.writeText(urls.join('\n'));
    toast(`${urls.length} links copied`);
  }

  function bulkExport() {
    const posts = library.filter(post => selected.has(String(post.id)));
    download(JSON.stringify({ format: 'xvault-selection-v1', exportedAt: new Date().toISOString(), posts }, null, 2), `xvault-selection-${stamp()}.json`, 'application/json');
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
    try { return await pending; }
    finally { helperPending.delete(path); }
  }

  async function fetchHelperBlob(path) {
    const port = Number(settings.helperPort) || 17843;
    let token = await helperToken();
    let response = await fetch(`http://127.0.0.1:${port}/media?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    if (response.status === 401) {
      await chrome.storage.local.remove('helperAuthToken');
      token = await helperToken();
      response = await fetch(`http://127.0.0.1:${port}/media?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
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
    for (const element of root?.querySelectorAll?.('[data-helper-path]') || []) releaseHelperElement(element);
    helperPool.collect();
  }
  window.XVaultReleaseHelperMedia = releaseHelperMedia;

  function pumpHelperQueue() {
    while (helperActive < 3 && helperQueue.length) {
      const { element, path } = helperQueue.shift();
      if (!element.isConnected || (element.closest('#list') && element.dataset.helperVisible !== '1')) continue;
      helperActive++;
      helperBlob(path).then(() => {
        if (element.isConnected && (!element.closest('#list') || element.dataset.helperVisible === '1')) {
          const ownedUrl = helperPool.attach(path, element);
          if (ownedUrl) element.src = ownedUrl;
          else helperQueue.push({ element, path });
        }
      }).catch(() => {
        if (!element.isConnected) return;
        element.dataset.helperFailed='true';
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
      }).finally(() => { helperActive--; setTimeout(() => helperPool.collect(), 0); pumpHelperQueue(); });
    }
  }

  function hydrateHelperMedia(root) {
    if (root?.id === 'list') {
      helperObserver?.disconnect();
      helperObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) {
            entry.target.dataset.helperVisible = '0';
            releaseHelperElement(entry.target);
            continue;
          }
          entry.target.dataset.helperVisible = '1';
          const path = entry.target.dataset.helperPath;
          if (path && !entry.target.getAttribute('src')?.startsWith('blob:')) helperQueue.push({ element: entry.target, path });
        }
        pumpHelperQueue();
      }, { rootMargin: '320px 0px' });
    }
    for (const element of root?.querySelectorAll?.('img[src*="#xvhelper="],video[src*="#xvhelper="]') || []) {
      const marker = element.getAttribute('src')?.split('#xvhelper=')[1];
      if (!marker) continue;
      const path = decodeURIComponent(marker);
      element.dataset.helperPath = path;
      if (root.id === 'list') helperObserver.observe(element);
      else helperQueue.push({ element, path });
    }
    pumpHelperQueue();
  }
  window.XVaultHydrateHelperMedia = hydrateHelperMedia;

  renderLightbox = function () {
    releaseHelperMedia($('#lbContent'));
    baseLightbox();
    const context = window.XVaultLightboxContext?.();
    const saved = context ? window.XVaultMediaMetadata.metadataFor(context.media) : null;
    let video = $('#lbContent video');
    // An animated derivative may be shown as an <img>. If it has timestamp
    // notes, use the seekable captured video source so those notes stay usable.
    if (!video && context && saved?.annotations?.some(item => !item.deletedAt) && window.XVaultMediaMetadata.canTimestamp(context.media)) {
      const source = bestVariant(context.media) || context.media.playbackUrl || context.media.url;
      if (source) {
        $('#lbContent').className = 'lbContent videoMode';
        $('#lbContent').innerHTML = `<div class="lbVideoShell"><video src="${esc(source)}" controls autoplay loop playsinline></video><div class="playerGlow"></div></div>`;
        video = $('#lbContent video');
      }
    }
    hydrateHelperMedia($('#lbContent'));
    if (video) installPlayer(video);
    renderMediaAnnotations(video);
  };

  function installPlayer(video) {
    const meta = $('#lbMeta');
    if (!meta) return;
    const context = window.XVaultLightboxContext?.(), sourceOptions = context ? mediaSourceOptions(context) : [];
    const initialSource = video.getAttribute('src') || '';
    video.dataset.xvMediaKey = context?.mediaKey || '';
    video.dataset.xvSelectedVariant = !sourceOptions.length || sourceOptions[0].src === initialSource ? 'source' : (sourceOptions.find(item => item.src === initialSource)?.id || 'derivative');
    const toolbar = document.createElement('div');
    toolbar.className = 'xv-player-tools';
    toolbar.innerHTML = `<div class="xv-player-time" id="xvPlayerTime">0:00 / 0:00</div><div class="xv-buffer"><i></i></div><div class="xv-player-buttons"><button type="button" data-player="play" aria-label="Play or pause video">Pause</button><button type="button" data-player="add-annotation" title="Add a timestamp note at the current position (A)">Add video note · A</button><button type="button" data-player="back" title="Previous frame">− frame</button><button type="button" data-player="forward" title="Next frame">+ frame</button><select id="xvPlaybackRate" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select><button type="button" data-player="loop">Loop</button><button type="button" data-player="pip">Picture in picture</button><button type="button" data-player="full">Fullscreen</button></div><small>Space play · J/L seek · K pause · [/] frame · A note · F fullscreen</small>`;
    meta.prepend(toolbar);
    const time = toolbar.querySelector('#xvPlayerTime'), buffer = toolbar.querySelector('.xv-buffer i');
    const format = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    const update = () => {
      time.textContent = `${format(video.currentTime || 0)} / ${format(video.duration || 0)}`;
      toolbar.querySelector('[data-player="play"]').textContent = video.paused ? 'Play' : 'Pause';
      toolbar.querySelector('[data-player="loop"]').classList.toggle('active', video.loop);
      const end = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
      buffer.style.transform = `scaleX(${video.duration ? Math.min(1, end / video.duration) : 0})`;
    };
    video.addEventListener('timeupdate', () => { mediaTimes.set(video.currentSrc || video.src, video.currentTime); update(); });
    video.addEventListener('progress', update);
    video.addEventListener('play', update);
    video.addEventListener('pause', update);
    video.addEventListener('loadedmetadata', () => {
      const saved = mediaTimes.get(video.currentSrc || video.src);
      if (saved > 0 && saved < video.duration - 1) video.currentTime = saved;
      update();
    }, { once: true });
    toolbar.onclick = async event => {
      const action = event.target.closest('[data-player]')?.dataset.player;
      if (action === 'play') video.paused ? video.play().catch(() => {}) : video.pause();
      if (action === 'add-annotation') openAnnotationComposer(video);
      if (action === 'back') video.currentTime = Math.max(0, video.currentTime - 1 / 30);
      if (action === 'forward') video.currentTime = Math.min(video.duration || 0, video.currentTime + 1 / 30);
      if (action === 'loop') video.loop = !video.loop;
      if (action === 'pip') {
        try { await video.requestPictureInPicture(); } catch { toast('Picture in picture is unavailable for this video'); }
      }
      if (action === 'full') {
        try { await video.requestFullscreen(); } catch { toast('Fullscreen is unavailable'); }
      }
      update();
    };
    toolbar.querySelector('#xvPlaybackRate').onchange = event => { video.playbackRate = Number(event.target.value); };
    update();
  }

  function annotationDraftKey(context, id = 'new') {
    return `xv-media-annotation:${encodeURIComponent(context.postId)}:${encodeURIComponent(context.mediaKey)}:${encodeURIComponent(id)}`;
  }
  function readAnnotationDraft(context, id = 'new') {
    try { const draft = JSON.parse(localStorage.getItem(annotationDraftKey(context, id)) || 'null'); return draft && typeof draft === 'object' ? draft : null; } catch { return null; }
  }
  function writeAnnotationDraft(context, draft, id = 'new') {
    try { localStorage.setItem(annotationDraftKey(context, id), JSON.stringify({ ...draft, savedAt: Date.now() })); return true; } catch { return false; }
  }
  function clearAnnotationDraft(context, id = 'new') {
    try { localStorage.removeItem(annotationDraftKey(context, id)); } catch {}
  }

  function mediaSourceOptions(context) {
    const media = context.media, rows = libraryDownloads.get(String(context.postId)) || [], urls = new Set([media.url, media.playbackUrl, ...(media.variants || []).map(item => item.url)].filter(Boolean));
    const matches = rows.filter(row => String(row.item?.tweetId || '') === context.postId && ((media.id && String(row.item?.mediaId || '') === String(media.id)) || [...urls].some(url => url === row.item?.url || window.XVaultMediaAsset?.sameAsset(url, row.item?.url))));
    const original = bestVariant(media) || media.playbackUrl || media.url;
    const sourceKind = String(media.type || '').toLowerCase().includes('video') ? 'video' : String(media.type || 'media');
    const options = original ? [{ id: 'source', label: `Captured original · ${sourceKind}`, src: original, original: true }] : [];
    for (const [index, variant] of (media.variants || []).entries()) {
      const src = variant?.url, type = String(variant?.contentType || variant?.type || '').toLowerCase();
      if (!src || !(type.startsWith('video/') || /\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/i.test(src)) || options.some(item => item.src === src)) continue;
      options.push({ id: `source-variant-${index}`, label: `Captured source variant${variant.bitrate ? ` · ${Math.round(Number(variant.bitrate) / 1000)} kb/s` : ''}`, src, original: true });
    }
    for (const row of matches) {
      const path = row.state === 'complete' && !row.conversionExpected && String(row.target?.kind || row.item?.mediaType || '').toLowerCase() === 'video' ? row.target?.filename || row.filename : '';
      if (!path) continue;
      const src = settings.helperPreferHttpPreview !== false ? helperMediaUrl(path) : row.localFileUrl || row.target?.fileUrl || '';
      if (!src || options.some(item => item.src === src)) continue;
      options.push({ id: `local-original-${String(row.key || options.length)}`, label: `Local original · ${basenameMedia(path)}`, src, original: true, path });
    }
    return options;
  }

  function isOriginalVariant(context, variantId) {
    return variantId === 'source' || mediaSourceOptions(context).some(item => item.id === variantId && item.original);
  }

  function refreshMediaRecord(row, focus = '') {
    const id = String(row?.id || ''), existing = library.find(post => String(post.id) === id);
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
    if (video.readyState >= 1 && (Number.isFinite(video.duration) || video.duration === Infinity)) return Promise.resolve(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; clearTimeout(timer); video.removeEventListener('loadedmetadata', ready); video.removeEventListener('error', failed); resolve(value); };
      const ready = () => finish(Number.isFinite(video.duration) || video.duration === Infinity);
      const failed = () => finish(false);
      const timer = setTimeout(() => finish(false), timeout);
      video.addEventListener('loadedmetadata', ready, { once: true }); video.addEventListener('error', failed, { once: true });
    });
  }

  async function selectMediaSource(video, context, sourceId, sources = mediaSourceOptions(context), keepTime = true) {
    const source = sources.find(item => item.id === sourceId);
    if (!source || !video) return false;
    const previousSource = video.getAttribute('src') || '', previousVariant = video.dataset.xvSelectedVariant || 'source';
    const time = keepTime && Number.isFinite(video.currentTime) ? video.currentTime : 0, wasPlaying = !video.paused, rate = video.playbackRate, muted = video.muted, loop = video.loop;
    video.pause(); video.dataset.xvSelectedVariant = source.id; video.dataset.xvMediaKey = context.mediaKey; video.src = source.src; video.load();
    hydrateHelperMedia($('#lbContent'));
    const ready = await waitForVideoMetadata(video);
    if (!ready) {
      video.dataset.xvSelectedVariant = previousVariant;
      if (previousSource) video.setAttribute('src', previousSource); else video.removeAttribute('src');
      video.load(); hydrateHelperMedia($('#lbContent'));
      const priorReady = await waitForVideoMetadata(video, 3000);
      if (priorReady) {
        video.playbackRate = rate; video.muted = muted; video.loop = loop;
        if (keepTime && Number.isFinite(video.duration) && time < video.duration) try { video.currentTime = time; } catch {}
        if (wasPlaying) video.play().catch(() => {});
      }
      const status = $('#xvAnnotationStatus');
      if (status) status.textContent = priorReady ? `${source.label} is unavailable; the previous preview was restored. Saved notes are unchanged.` : `${source.label} is unavailable. Saved notes are retained.`;
      return false;
    }
    video.playbackRate = rate; video.muted = muted; video.loop = loop;
    if (keepTime && Number.isFinite(video.duration) && time < video.duration) try { video.currentTime = time; } catch {}
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
      if (!await selectMediaSource(video, context, 'source', sources, false)) return false;
      ready = await waitForVideoMetadata(video);
    }
    const target = atMs / 1000;
    if (video.seekable.length && !Array.from({ length: video.seekable.length }, (_, index) => [video.seekable.start(index), video.seekable.end(index)]).some(([start, end]) => target >= start && target <= end)) return false;
    if (!ready || (Number.isFinite(video.duration) && target > video.duration)) return false;
    try {
      if (Math.abs(video.currentTime - target) < 0.002) return true;
      const seeked = new Promise(resolve => { let settled = false; const done = () => { if (settled) return; settled = true; clearTimeout(timer); video.removeEventListener('seeked', done); resolve(true); }; const timer = setTimeout(() => { if (settled) return; settled = true; video.removeEventListener('seeked', done); resolve(false); }, 5000); video.addEventListener('seeked', done, { once: true }); });
      video.currentTime = target;
      return await seeked;
    } catch { return false; }
  }

  async function seekMediaAnnotation(mediaKey, annotationId) {
    const context = window.XVaultLightboxContext?.();
    if (!context || context.mediaKey !== String(mediaKey || '')) return false;
    const annotation = window.XVaultMediaMetadata.metadataFor(context.media).annotations.find(item => String(item.id) === String(annotationId) && !item.deletedAt);
    if (!annotation) return false;
    const video = $('#lbContent video'), sources = mediaSourceOptions(context), status = $('#xvAnnotationStatus');
    const sought = await seekVideoTo(video, context, annotation.atMs, sources);
    if (status) status.textContent = sought ? `Playing from ${window.XVaultMediaMetadata.formatTimestamp(annotation.atMs)}` : 'This timestamp is unavailable in the current source. The annotation remains saved.';
    if (sought) {
      requestAnimationFrame(() => {
        const pane = $('#lbMeta'), row = pane?.querySelector(`[data-annotation-row][data-annotation-id="${CSS.escape(String(annotationId))}"]`);
        if (!pane || !row) return;
        const paneRect = pane.getBoundingClientRect(), rowRect = row.getBoundingClientRect(), inset = 10;
        const delta = rowRect.top < paneRect.top + inset ? rowRect.top - paneRect.top - inset : rowRect.bottom > paneRect.bottom - inset ? rowRect.bottom - paneRect.bottom + inset : 0;
        if (delta) pane.scrollBy({ top: delta, behavior: document.body.dataset.motion === 'normal' ? 'smooth' : 'auto' });
      });
    }
    return sought;
  }
  window.XVaultSeekMediaAnnotation = seekMediaAnnotation;

  function openAnnotationComposer(video) {
    const context = window.XVaultLightboxContext?.(), form = $('#xvMediaAnnotationForm'), editor = form?.querySelector('[name="text"]');
    if (!context || !form || !editor) return;
    const status = $('#xvAnnotationStatus');
    if (!isOriginalVariant(context, video?.dataset.xvSelectedVariant || 'source')) {
      if (status) status.textContent = 'Timestamp notes use the captured original. Switch back to it before adding a note.';
      return;
    }
    const draft = readAnnotationDraft(context);
    const atMs = draft ? Number(draft.atMs) : Math.max(0, Math.round((Number(video?.currentTime) || 0) * 1000));
    form.dataset.atMs = String(atMs);
    const label = form.querySelector('[data-annotation-time]'); if (label) label.textContent = window.XVaultMediaMetadata.formatTimestamp(atMs);
    if (draft) { editor.value = String(draft.text || ''); form.querySelector('[data-annotation-draft-status]').textContent = 'Draft retained on this device'; }
    form.hidden = false; editor.focus();
  }

  function sourceHasVideoTimeline(context, source) {
    const media = context?.media || {};
    const type = String(media.type || '').toLowerCase();
    return type === 'video' || Boolean(media.playbackUrl) || (media.variants || []).some(item => /^video\//i.test(item?.contentType || item?.type || '')) || /\.(?:mp4|m4v|webm|mov)(?:[?#]|$)/i.test(source?.src || '');
  }

  function renderMediaAnnotations(video) {
    const context = window.XVaultLightboxContext?.();
    if (!context) return;
    const metadata = window.XVaultMediaMetadata, mediaMeta = metadata.metadataFor(context.media), timed = metadata.canTimestamp(context.media);
    const notes = [], invalid = [];
    for (const candidate of mediaMeta.annotations) {
      try { notes.push(metadata.validateAnnotation(candidate)); }
      catch { invalid.push(candidate); }
    }
    const active = notes.filter(item => !item.deletedAt).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
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
    const mediaNotePreview = mediaMeta.note ? `${esc(mediaMeta.note.slice(0, 280))}${mediaMeta.note.length > 280 ? '…' : ''}` : '';
    const mediaBlock = mediaHasMetadata ? `<section class="xv-viewer-media-meta" aria-label="Per-media metadata"><b>Media metadata</b>${mediaMeta.note ? `<p class="xv-media-note-preview">${mediaNotePreview}</p>${mediaMeta.note.length > 280 ? `<details><summary>Read full media note · ${fmt(mediaMeta.note.length)} characters</summary><p>${esc(mediaMeta.note)}</p></details>` : ''}` : ''}${tags.length ? `<p class="xv-viewer-tags">${tags.map(tag => `<span>#${esc(tag)}</span>`).join(' ')}${mediaMeta.tags.length > tags.length ? ` <small>+${mediaMeta.tags.length - tags.length} more labels</small>` : ''}</p>` : ''}${mediaMeta.source ? `<small>Credit · ${esc(mediaMeta.source)}</small>` : ''}${sourceHref ? `<a href="${esc(sourceHref)}" target="_blank" rel="noopener noreferrer">Open source credit</a>` : ''}</section>` : '';
    const sourcePicker = video && sources.length > 1 ? `<label class="xv-derivative-switch"><span>Preview file</span><select data-annotation-focus="variant" aria-describedby="xvVariantHint">${sources.map(item => `<option value="${esc(item.id)}" ${item.id === currentVariant ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select><small id="xvVariantHint">Notes use the captured original timeline. Seeking a note switches back to the original.</small></label>` : '';
    const addControl = video ? `<button type="button" data-annotation-add data-annotation-focus="add" ${canAdd ? '' : 'disabled'} title="A · note at the captured original position">${canAdd ? 'Add at current time' : 'Switch to original to add'}</button>` : canOpenSource ? `<button type="button" data-annotation-open-source>Open captured video</button>` : '<button type="button" disabled>Seekable original unavailable</button>';
    const truncatedText = item => item.text.length > 240 ? `<p>${esc(item.text.slice(0, 240))}…</p><details><summary>Read full note · ${fmt(item.text.length)} characters</summary><p>${esc(item.text)}</p></details>` : `<p>${esc(item.text)}</p>`;
    const annotationRows = active.slice(0, 100).map((item, index) => {
      const draft = readAnnotationDraft(context, item.id), stale = draft && Number(draft.expectedUpdatedAt) !== item.updatedAt;
      return `<li data-annotation-row data-annotation-id="${esc(item.id)}"><button type="button" class="xv-annotation-seek" data-annotation-seek="${esc(item.id)}" aria-label="Seek to ${metadata.formatTimestamp(item.atMs)}">${metadata.formatTimestamp(item.atMs)}</button><div class="xv-annotation-copy">${truncatedText(item)}<div class="xv-annotation-actions"><button type="button" data-annotation-edit="${esc(item.id)}" data-annotation-focus="edit-button:${esc(item.id)}">${draft ? 'Continue draft' : 'Edit'}</button><button type="button" data-annotation-up="${esc(item.id)}" data-annotation-focus="move:${esc(item.id)}" aria-label="Move note up" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-annotation-down="${esc(item.id)}" data-annotation-focus="move:${esc(item.id)}" aria-label="Move note down" ${index === active.length - 1 ? 'disabled' : ''}>↓</button><button type="button" class="quiet" data-annotation-delete="${esc(item.id)}" data-annotation-focus="delete:${esc(item.id)}">Remove</button></div><div class="xv-annotation-edit" ${draft ? '' : 'hidden'}><textarea maxlength="10000" rows="2" data-annotation-focus="edit:${esc(item.id)}" aria-label="Edit note at ${metadata.formatTimestamp(item.atMs)}">${esc(draft?.text ?? item.text)}</textarea>${stale ? `<div class="xv-annotation-conflict" role="alert"><b>Changed elsewhere</b><p>Saved: ${esc(item.text.slice(0, 500))}${item.text.length > 500 ? '…' : ''}</p><div><button type="button" class="quiet" data-annotation-use-saved="${esc(item.id)}" data-annotation-focus="use-saved:${esc(item.id)}">Use saved</button><button type="button" data-annotation-overwrite="${esc(item.id)}" data-annotation-focus="overwrite:${esc(item.id)}">Replace saved with my draft</button></div></div>` : ''}<div><span data-annotation-edit-status role="status"></span><button type="button" class="quiet" data-annotation-cancel-edit="${esc(item.id)}" data-annotation-focus="keep-edit:${esc(item.id)}">Keep draft</button><button type="button" class="quiet" data-annotation-discard-edit="${esc(item.id)}">Discard draft</button><button type="button" data-annotation-save-edit="${esc(item.id)}" data-annotation-focus="save-edit:${esc(item.id)}">Save edit</button></div></div></div></li>`;
    }).join('');
    const panel = timed ? `<section class="xv-annotation-panel" aria-labelledby="xvAnnotationTitle"><header><div><h4 id="xvAnnotationTitle">Video notes <span>${active.length}</span></h4><p>Timestamped to the captured original, with millisecond precision.</p></div>${addControl}</header>${sourcePicker}${mediaBlock}<form id="xvMediaAnnotationForm" class="xv-annotation-composer" hidden><label for="xvAnnotationNewText">Note at <time data-annotation-time>0:00.000</time></label><textarea id="xvAnnotationNewText" name="text" maxlength="10000" rows="2" data-annotation-focus="new-text" placeholder="What should you remember at this moment?"></textarea><div><span data-annotation-draft-status role="status"></span><button type="button" class="quiet" data-annotation-cancel data-annotation-focus="keep-new">Keep draft</button><button type="button" class="quiet" data-annotation-discard-new>Discard draft</button><button type="submit" class="primary" data-annotation-focus="save-new">Save note <kbd>Ctrl+Enter</kbd></button></div></form><ol class="xv-annotation-list" aria-label="Timestamped video notes">${annotationRows || '<li class="xv-annotation-empty">No timestamp notes yet. Pause on the captured original and add one.</li>'}${active.length > 100 ? `<li class="xv-annotation-overflow">Showing the first 100 of ${active.length} notes to keep the viewer responsive.</li>` : ''}${invalid.length ? `<li class="xv-annotation-invalid" role="alert">${invalid.length} saved annotation${invalid.length === 1 ? '' : 's'} could not be displayed. Their stored evidence has been left untouched.</li>` : ''}</ol>${removed.length ? `<details class="xv-annotation-removed"><summary>Removed notes · ${removed.length}</summary><ul>${removed.slice(0, 20).map(item => `<li><time>${metadata.formatTimestamp(item.atMs)}</time><span>${esc(item.text.slice(0, 300))}${item.text.length > 300 ? '…' : ''}</span><button type="button" data-annotation-restore="${esc(item.id)}" data-annotation-focus="restore:${esc(item.id)}">Undo</button></li>`).join('')}</ul>${removed.length > 20 ? `<small>Showing the latest 20 removed notes.</small>` : ''}</details>` : ''}<p id="xvAnnotationStatus" class="xv-annotation-status" role="status" aria-live="polite">${currentVariant !== 'source' ? 'Previewing a derivative · notes remain anchored to the captured original.' : ''}</p></section>` : `${mediaBlock}<section class="xv-viewer-media-meta" aria-label="Per-media metadata"><p class="xv-viewer-muted">${mediaHasMetadata ? '' : 'No per-media notes yet.'}</p><button type="button" data-annotation-inspect>Open media metadata in Inspector</button></section>`;
    const meta = $('#lbMeta'); if (!meta) return;
    meta.querySelectorAll('.xv-viewer-media-meta,.xv-annotation-panel').forEach(node => node.remove());
    meta.insertAdjacentHTML('beforeend', panel);
    const form = $('#xvMediaAnnotationForm'), newDraft = form && readAnnotationDraft(context);
    if (form && newDraft) {
      form.hidden = false;
      form.dataset.atMs = String(Number(newDraft.atMs) || 0);
      form.querySelector('[data-annotation-time]').textContent = metadata.formatTimestamp(newDraft.atMs);
      form.querySelector('[name="text"]').value = String(newDraft.text || '');
      form.querySelector('[data-annotation-draft-status]').textContent = 'Draft retained on this device';
      const add = meta.querySelector('[data-annotation-add]'); if (add) add.textContent = `Continue draft · ${metadata.formatTimestamp(newDraft.atMs)}`;
    }
    const status = $('#xvAnnotationStatus');
    let submitting = false;
    const submitNew = async () => {
      if (submitting) return;
      const textValue = String(form?.querySelector('[name="text"]')?.value || ''), atMs = Number(form?.dataset.atMs);
      if (!textValue.trim()) { if (status) status.textContent = 'Write a short note before saving.'; form?.querySelector('[name="text"]')?.focus(); return; }
      if (!Number.isSafeInteger(atMs) || atMs < 0) { if (status) status.textContent = 'The player time is unavailable.'; return; }
      submitting = true;
      const save = form.querySelector('[type="submit"]'); if (save) save.disabled = true;
      const annotation = { id: crypto.randomUUID(), atMs, position: active.length, text: textValue, createdAt: Date.now(), updatedAt: Date.now() };
      try {
        const result = await call({ type: 'UPDATE_MEDIA_METADATA', id: context.postId, mediaKey: context.mediaKey, change: { type: 'annotation-add', annotation } });
        if (!result?.ok) { if (status) status.textContent = result?.error || 'The note was not saved. Your local draft remains available.'; return; }
        clearAnnotationDraft(context); refreshMediaRecord(result.row, 'add'); toast(`Note saved at ${metadata.formatTimestamp(atMs)}`);
      } catch (error) { if (status) status.textContent = `Save failed · ${error.message}. Your local draft remains available.`; }
      finally { submitting = false; if (save?.isConnected) save.disabled = false; }
    };
    form?.addEventListener('input', () => {
      const draft = { text: form.querySelector('[name="text"]').value, atMs: Number(form.dataset.atMs) };
      const stored = writeAnnotationDraft(context, draft);
      form.querySelector('[data-annotation-draft-status]').textContent = stored ? 'Draft saved on this device' : 'Browser storage is full · keep this editor open until saved';
    });
    form?.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void submitNew(); } });
    form?.addEventListener('submit', event => { event.preventDefault(); void submitNew(); });
    meta.querySelector('[data-annotation-add]')?.addEventListener('click', () => openAnnotationComposer(video));
    meta.querySelector('[data-annotation-open-source]')?.addEventListener('click', () => {
      const source = sources[0]; if (!source) return;
      const box = $('#lbContent'); box.className = 'lbContent videoMode';
      box.innerHTML = `<div class="lbVideoShell"><video src="${esc(source.src)}" controls playsinline></video><div class="playerGlow"></div></div>`;
      $('#zoomDock').style.display = 'none'; hydrateHelperMedia(box);
      const nextVideo = box.querySelector('video'); installPlayer(nextVideo); renderMediaAnnotations(nextVideo); nextVideo.focus?.();
    });
    meta.querySelector('[data-annotation-cancel]')?.addEventListener('click', () => { if (form) { form.hidden = true; if (status) status.textContent = 'Draft kept on this device. Choose Continue draft to reopen it.'; } });
    meta.querySelector('[data-annotation-discard-new]')?.addEventListener('click', () => {
      const value = form?.querySelector('[name="text"]')?.value || '';
      if (value.trim() && !confirm('Discard this timestamp note draft?')) return;
      clearAnnotationDraft(context); if (form) { form.querySelector('[name="text"]').value = ''; form.hidden = true; }
      const add = meta.querySelector('[data-annotation-add]'); if (add) add.textContent = 'Add at current time';
      if (status) status.textContent = 'Draft discarded.';
    });
    meta.querySelector('[data-annotation-inspect]')?.addEventListener('click', () => window.openDetails(context.postId));
    meta.querySelector('[data-annotation-focus="variant"]')?.addEventListener('change', event => {
      const picker = event.currentTarget, selected = picker.value, target = sources.find(item => item.id === selected), add = meta.querySelector('[data-annotation-add]');
      if (add) { add.disabled = !isOriginalVariant(context, selected); add.textContent = add.disabled ? 'Switch to original to add' : 'Add at current time'; }
      if (status) status.textContent = target?.path ? `Opening ${target.label}…` : `Using ${target?.label || 'selected source'}`;
      void selectMediaSource(video, context, selected, sources, true).then(ok => {
        if (ok) return;
        picker.value = video.dataset.xvSelectedVariant || 'source';
        if (add) { add.disabled = !isOriginalVariant(context, picker.value); add.textContent = add.disabled ? 'Switch to original to add' : 'Add at current time'; }
      });
    });
    meta.querySelectorAll('[data-annotation-seek]').forEach(button => button.addEventListener('click', () => void seekMediaAnnotation(context.mediaKey, button.dataset.annotationSeek)));
    meta.querySelectorAll('[data-annotation-edit]').forEach(button => button.addEventListener('click', () => {
      const row = button.closest('[data-annotation-row]'), editor = row.querySelector('.xv-annotation-edit'), area = editor.querySelector('textarea'), note = active.find(item => item.id === button.dataset.annotationEdit);
      let draft = readAnnotationDraft(context, note.id);
      if (!draft) { draft = { text: note.text, expectedUpdatedAt: note.updatedAt }; writeAnnotationDraft(context, draft, note.id); }
      editor.hidden = false; area.value = draft.text; area.focus();
    }));
    meta.querySelectorAll('[data-annotation-row] textarea').forEach(area => area.addEventListener('input', () => {
      const id = area.closest('[data-annotation-row]').dataset.annotationId, note = active.find(item => item.id === id), previous = readAnnotationDraft(context, id);
      const stored = writeAnnotationDraft(context, { text: area.value, expectedUpdatedAt: previous?.expectedUpdatedAt ?? note.updatedAt }, id);
      const statusNode = area.closest('[data-annotation-row]').querySelector('[data-annotation-edit-status]');
      if (statusNode && !stored) statusNode.textContent = 'Browser storage is full · keep this editor open until saved';
    }));
    const saveEdit = async (id, overwrite = false) => {
      const draft = readAnnotationDraft(context, id), note = active.find(item => item.id === id), row = meta.querySelector(`[data-annotation-row][data-annotation-id="${CSS.escape(id)}"]`);
      if (!draft || !note || !row) return;
      const area = row.querySelector('textarea'), statusNode = row.querySelector('[data-annotation-edit-status]'), expectedUpdatedAt = overwrite ? note.updatedAt : draft.expectedUpdatedAt;
      const result = await call({ type: 'UPDATE_MEDIA_METADATA', id: context.postId, mediaKey: context.mediaKey, change: { type: 'annotation-edit', annotation: { ...note, text: area.value }, expectedUpdatedAt } });
      if (!result?.ok) { statusNode.textContent = result?.error || 'This edit conflicted; your local draft is retained.'; if (result?.row) refreshMediaRecord(result.row); return; }
      clearAnnotationDraft(context, id); refreshMediaRecord(result.row, `edit-button:${id}`); toast('Video note updated');
    };
    meta.querySelectorAll('[data-annotation-save-edit]').forEach(button => button.addEventListener('click', () => void saveEdit(button.dataset.annotationSaveEdit)));
    meta.querySelectorAll('[data-annotation-overwrite]').forEach(button => button.addEventListener('click', () => void saveEdit(button.dataset.annotationOverwrite, true)));
    meta.querySelectorAll('[data-annotation-use-saved]').forEach(button => button.addEventListener('click', () => {
      const id = button.dataset.annotationUseSaved; clearAnnotationDraft(context, id); refreshMediaRecord(window.XVaultLightboxContext()?.post || context.post, `edit-button:${id}`);
    }));
    meta.querySelectorAll('[data-annotation-cancel-edit]').forEach(button => button.addEventListener('click', () => {
      const id = button.dataset.annotationCancelEdit, editor = button.closest('.xv-annotation-edit'); editor.hidden = true;
      const target = meta.querySelector(`[data-annotation-edit="${CSS.escape(id)}"]`); target?.focus({ preventScroll: true });
      if (status) status.textContent = 'Draft kept on this device. Choose Continue draft to reopen it.';
    }));
    meta.querySelectorAll('[data-annotation-discard-edit]').forEach(button => button.addEventListener('click', () => {
      const id = button.dataset.annotationDiscardEdit, note = active.find(item => item.id === id), draft = readAnnotationDraft(context, id);
      if (draft && draft.text !== note?.text && !confirm('Discard your unsaved video note changes?')) return;
      clearAnnotationDraft(context, id); refreshMediaRecord(context.post, `edit-button:${id}`);
    }));
    meta.querySelectorAll('[data-annotation-delete]').forEach(button => button.addEventListener('click', async () => {
      const note = active.find(item => item.id === button.dataset.annotationDelete); if (!note) return;
      const result = await call({ type: 'UPDATE_MEDIA_METADATA', id: context.postId, mediaKey: context.mediaKey, change: { type: 'annotation-delete', annotationId: note.id, expectedUpdatedAt: note.updatedAt } });
      if (!result?.ok) { if (status) status.textContent = result?.error || 'The note was not removed.'; if (result?.row) refreshMediaRecord(result.row); return; }
      refreshMediaRecord(result.row, 'add'); toast('Note removed · Undo remains available');
    }));
    meta.querySelectorAll('[data-annotation-restore]').forEach(button => button.addEventListener('click', async () => {
      const note = removed.find(item => item.id === button.dataset.annotationRestore); if (!note) return;
      const result = await call({ type: 'UPDATE_MEDIA_METADATA', id: context.postId, mediaKey: context.mediaKey, change: { type: 'annotation-restore', annotationId: note.id, expectedUpdatedAt: note.updatedAt } });
      if (!result?.ok) { if (status) status.textContent = result?.error || 'The note could not be restored.'; if (result?.row) refreshMediaRecord(result.row); return; }
      refreshMediaRecord(result.row, 'add'); toast('Removed note restored');
    }));
    meta.querySelectorAll('[data-annotation-up],[data-annotation-down]').forEach(button => button.addEventListener('click', async () => {
      const order = active.map(item => item.id), id = button.dataset.annotationUp || button.dataset.annotationDown, delta = button.hasAttribute('data-annotation-up') ? -1 : 1;
      const result = await call({ type: 'UPDATE_MEDIA_METADATA', id: context.postId, mediaKey: context.mediaKey, change: { type: 'annotation-move', annotationId: id, delta, expectedOrder: order } });
      if (!result?.ok) { if (status) status.textContent = result?.error || 'The notes changed elsewhere; order was not changed.'; if (result?.row) refreshMediaRecord(result.row); return; }
      refreshMediaRecord(result.row, `edit-button:${id}`);
    }));
  }
  function playerKeys(event) {
    const video = $('#lightbox:not(.hidden) #lbContent video');
    if (!video || event.target.closest('input,textarea,select,[contenteditable]') || event.ctrlKey || event.metaKey || event.altKey) return;
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
        for (let attempt = 0; attempt < 250 && !resultRows(); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
        runLinkExport(action);
      }
    };
    try { Object.defineProperty(window, 'library', { configurable: true, get: () => library }); } catch {}
    window.XVaultLibraryContext = () => ({ query: $('#search')?.value || '', sort: $('#sort')?.value || 'new', view: $('#libraryView')?.value || 'timeline' });
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
    $('.lib-filters').before(queryIssues);
    const help = $('#page-library .booruHelp');
    if (help) help.innerHTML = '<h3>Search syntax</h3><p>Combine filters with spaces. Dates are UTC: <code>after:</code> includes the day, <code>before:</code> excludes it.</p><dl><dt><code>from:name</code></dt><dd>one author</dd><dt><code>has:video</code> <code>has:gif</code> <code>has:image</code></dt><dd>media type</dd><dt><code>tag:name</code> <code>untagged:true</code></dt><dd>post and media labels</dd><dt><code>inbox:true</code></dt><dd>new posts you have not reviewed</dd><dt><code>fav:true</code> <code>note:true</code></dt><dd>favorites, posts with notes or annotations</dd><dt><code>note:lighting</code> <code>note:&quot;rainy stairwell&quot;</code></dt><dd>search post and media notes</dd><dt><code>annotation:door</code> <code>media-note:lighting</code></dt><dd>search timestamp notes or media-only notes</dd><dt><code>downloaded:true</code> <code>missing:true</code></dt><dd>files on disk</dd><dt><code>after:2026-01-01 before:2026-02-01</code></dt><dd>posted between</dd><dt><code>archived-after:2026-10-01</code></dt><dd>archived since</dd><dt><code>likes:&gt;500</code> <code>views:&gt;10k</code></dt><dd>engagement</dd><dt><code>size:&gt;100mb</code></dt><dd>known size of completed downloads</dd></dl>';
    $('#sort')?.setAttribute('aria-label', 'Sort Library');
    $('#libraryView')?.setAttribute('aria-label', 'Library layout');
    const inspector = $('#detailsDrawer');
    if (inspector) libraryPage.append(inspector);

    // Facets
    const facets = document.createElement('aside');
    facets.id = 'libraryDestinations';
    facets.className = 'xv-facets';
    facets.setAttribute('aria-label', 'Library locations');
    const destination = (id, label, icon) => `<button type="button" class="facet-item" data-destination="${id}"><span class="facet-icon" data-facet-icon="${icon}"></span><span>${label}</span><em class="count"></em></button>`;
    facets.innerHTML = `<nav aria-label="Collections">${destination('all', 'All posts', 'library')}${destination('inbox', 'Inbox', 'inbox')}${destination('favorites', 'Favorites', 'favorite')}${destination('untagged', 'Untagged', 'tag')}${destination('local', 'On disk', 'disk')}${destination('missing', 'Missing media', 'missing')}</nav>
<section class="facet" aria-labelledby="facetSourcesTitle"><h3 id="facetSourcesTitle">Sources</h3><div><button type="button" class="facet-item" data-token="source:bookmarks"><span class="facet-icon" data-facet-icon="saved"></span><span>Bookmarks</span></button><button type="button" class="facet-item" data-token="source:likes"><span class="facet-icon" data-facet-icon="heart"></span><span>Likes</span></button><button type="button" class="facet-item" data-token="source:profile"><span class="facet-icon" data-facet-icon="person"></span><span>Profiles</span></button></div></section>
<section class="facet" aria-labelledby="facetAuthorsTitle"><h3 id="facetAuthorsTitle">Authors</h3><div id="facetAuthors"></div></section>
<section class="facet" aria-labelledby="facetTagsTitle"><h3 id="facetTagsTitle">Tags</h3><div id="facetTags"></div></section>
<section class="facet xv-smart-collections" aria-labelledby="facetViewsTitle"><header class="facet-heading"><h3 id="facetViewsTitle">Smart Collections</h3><div><button type="button" class="quiet" id="libraryCollectionsExport" title="Export query definitions">Export</button><button type="button" class="quiet" id="libraryCollectionsImport" title="Preview an imported collection file">Import</button><input id="libraryCollectionsFile" type="file" accept="application/json,.json" hidden></div></header><p class="facet-portable-note">Live search rules · archive rows stay local</p><div id="facetViews"></div><form class="facet-save" id="libraryViewForm"><input id="libraryViewName" maxlength="48" placeholder="Name this collection" aria-label="Smart Collection name"><select id="libraryCollectionIcon" aria-label="Collection icon"><option value="saved">Search</option><option value="video">Video</option><option value="image">Image</option><option value="note">Notes</option><option value="tag">Tags</option><option value="favorite">Favorites</option><option value="thread">Thread</option><option value="quote">Quotes</option><option value="calendar">Dates</option></select><button id="librarySaveView" type="submit" title="Save the current query, sort and layout">Save</button></form></section>`;
    libraryPage.prepend(facets);
    for (const slot of facets.querySelectorAll('[data-facet-icon]')) slot.innerHTML = window.XVaultIcons?.svg(slot.dataset.facetIcon) || '';
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
      if (more) { facetOpen[more.dataset.facetMore] = !facetOpen[more.dataset.facetMore]; renderFacets(); return; }
      const open = event.target.closest('[data-view-index]');
      if (open) return openView(Number(open.dataset.viewIndex));
      const move = event.target.closest('[data-view-move]');
      if (move) return moveView(move.dataset.viewId, Number(move.dataset.viewMove));
      const remove = event.target.closest('[data-view-remove]');
      if (remove) deleteView(remove.dataset.viewRemove);
    });
    $('#libraryViewForm').addEventListener('submit', event => { event.preventDefault(); saveView(); });
    $('#libraryCollectionsExport').addEventListener('click', exportSmartCollections);
    $('#libraryCollectionsImport').addEventListener('click', () => $('#libraryCollectionsFile').click());
    $('#libraryCollectionsFile').addEventListener('change', importSmartCollections);

    // Quick filter chips toggle filters and combine with the rest of the query
    $('#libraryChips').addEventListener('click', event => {
      const chip = event.target.closest('button[data-filter]');
      if (!chip) return;
      event.stopImmediatePropagation();
      const filter = chip.dataset.filter || '';
      if (!filter) {
        setQueryTokens(splitQuery($('#search').value).filter(token => !/^"?(has|type|rating):/i.test(token)));
      } else toggleToken(filter, filter.startsWith('has:') ? 'has:' : '');
    }, true);

    // Layout, tile size and sort
    const layout = $('#libraryLayout');
    let activeLayoutTransition=null,layoutTransitionGeneration=0;
    document.addEventListener('xv:motion-disabled',()=>{layoutTransitionGeneration++;activeLayoutTransition?.skipTransition();activeLayoutTransition=null;libraryPage.classList.remove('vt-list')});
    layout.addEventListener('click', event => {
      const button = event.target.closest('[data-layout]');
      if (!button) return;
      const select = $('#libraryView');
      if (select.value === button.dataset.layout) return;
      select.value = button.dataset.layout;
      settings.libraryView = select.value; // render now; the save below confirms in the background
      const swap = () => select.dispatchEvent(new Event('change', { bubbles: true }));
      const calm = ['off', 'reduced'].includes(document.body.dataset.motion) || matchMedia('(prefers-reduced-motion: reduce)').matches;
      const generation=++layoutTransitionGeneration;activeLayoutTransition?.skipTransition();
      if (!calm && typeof document.startViewTransition === 'function') {
        libraryPage.classList.add('vt-list');
        const transition = activeLayoutTransition=document.startViewTransition(swap);
        transition.finished.catch(()=>{}).finally(() => {if(generation===layoutTransitionGeneration){libraryPage.classList.remove('vt-list');activeLayoutTransition=null}});
      } else {libraryPage.classList.remove('vt-list');activeLayoutTransition=null;swap();}
      syncChrome();
    });
    layout.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const buttons = $$('#libraryLayout [data-layout]'), current = buttons.findIndex(button => button.getAttribute('aria-checked') === 'true');
      const next = buttons[(current + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length];
      event.preventDefault();
      next.click();
      next.focus();
    });
    let tileTimer = 0;
    $('#libraryTile').addEventListener('input', event => {
      tileDirty = true;
      libraryPage.style.setProperty('--tile', `${event.target.value}px`);
      clearTimeout(tileTimer);
      tileTimer = setTimeout(async () => { await save({ libraryTileSize: Number(event.target.value) }, false); tileDirty = false; }, 350);
    });
    const sort = $('#sort');
    if (sort && !sort.querySelector('option[value="random"]')) sort.insertAdjacentHTML('beforeend', '<option value="random">Random order</option>');
    if (sort && settings.librarySort) sort.value = settings.librarySort;
    document.addEventListener('change', event => {
      if (event.target?.id === 'sort') save({ librarySort: event.target.value }, false);
    }, true);

    // Status-line actions
    const quickActions = $('.libraryMiniActions');
    const shuffle = $('#shuffleLibrary');
    if (shuffle) shuffle.onclick = () => { $('#libraryTools').open = false; randomSeed = freshRandomSeed(); invalidateQueryCache(); $('#sort').value = 'random'; save({ librarySort: 'random' }, false); pageIndex = 0; renderLib(); };
    if (quickActions) {
      const review = document.createElement('button');
      review.id = 'libraryReview';
      review.type = 'button';
      review.className = 'primary';
      review.hidden = true;
      review.textContent = 'Review inbox';
      review.title = 'Step through new posts with Quick Look: R keeps, F favorites, Delete trashes';
      review.onclick = () => { const rows = currentPageRows(); if (!rows) return toast('Wait for the current search to finish'); if (!rows.length) return toast('Inbox is clear'); openQuickLook(rows, 0); };
      const selectResults = document.createElement('button');
      selectResults.id = 'librarySelectResultsQuick';
      selectResults.type = 'button';
      selectResults.className = 'quiet';
      selectResults.textContent = 'Select page';
      selectResults.title = 'Select the posts currently loaded for this search page (up to 1,500)';
      selectResults.setAttribute('aria-label', 'Select posts on the current Library page');
      selectResults.onclick = selectAllMatching;
      const exportButton = document.createElement('button');
      exportButton.id = 'libraryExportOpen';
      exportButton.type = 'button';
      exportButton.className = 'quiet xv-export-button';
      exportButton.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5v9m0 0 3.5-3.5M10 11.5 6.5 8M3.5 12.5v4h13v-4"/></svg><span>Export links</span>';
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
      dialog.addEventListener('cancel', event => {event.preventDefault();closeLinkExport();});
      dialog.addEventListener('close', () => {dialog.hidden=true;$('#libraryExportOpen')?.focus({preventScroll:true});});
      $('#libraryExportClose').onclick = closeLinkExport;
      $('#libraryExportScope').onchange = refreshLinkExportSummary;
      $('#libraryExportBlock').value = String([1, 5, 10, 25, 50, 0].includes(Number(settings.libraryExportBlock)) ? Number(settings.libraryExportBlock) : 5);
      if (!window.XVaultLinks?.providerHost(settings.linkProvider || 'fixvx', settings)) $('#libraryExportProvider').textContent = 'Invalid custom provider';
      $('#libraryExportBlock').onchange = () => save({ libraryExportBlock: Number($('#libraryExportBlock').value) }, false);
      $('#libraryCopyLinks').onclick = () => runLinkExport('copy');
      $('#libraryExportTxt').onclick = () => runLinkExport('download');
      $('#libraryCancelExport').onclick = () => { if (exportQueryId) { const queryId = exportQueryId; exportQueryId = ''; void call({ type: 'CANCEL_LIBRARY_QUERY', queryId }).catch(() => {}); } $('#libraryExportProgress').textContent = 'Cancelling export...'; exportWorker?.postMessage({ type: 'cancel' }); };
      document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#libraryExportDialog').hidden) closeLinkExport(); });
    }

    // Selection bar floats above the list; less common actions live in its menu
    const bulk = document.createElement('div');
    bulk.id = 'libraryBulk';
    bulk.className = 'xv-library-bulk';
    bulk.setAttribute('role', 'toolbar');
    bulk.setAttribute('aria-label', 'Selected posts');
    bulk.hidden = true;
    bulk.innerHTML = `<strong id="librarySelectedCount" aria-live="polite">0 selected</strong><button id="libraryClearSelection" class="quiet" title="Clear selection (Esc)">Clear</button><span class="bar-sep"></span><button id="libraryBulkFav">Favorite</button><button id="libraryBulkReviewed" title="Mark selected posts as reviewed">Reviewed</button><span class="bar-field"><input id="libraryBulkTagInput" maxlength="40" placeholder="Add tag" aria-label="Tag for selected posts"><button id="libraryBulkTag">Tag</button></span><button id="libraryBulkDownload">Download</button><button id="libraryBulkCopy">Links</button><details class="menu bar-more"><summary aria-label="More actions for selected posts">More</summary><div class="menu-pop"><button id="librarySelectPage" type="button">Select this page</button><button id="librarySelectResults" type="button" title="Replace selection with posts on the currently loaded page">Select loaded results</button><button id="libraryInvertPage" type="button" title="Toggle selection for posts on this page">Invert this page</button><hr><span class="bar-field"><select id="libraryBulkColorSelect" aria-label="Color label"><option value="none">No color</option><option value="red">Red</option><option value="amber">Amber</option><option value="green">Green</option><option value="blue">Blue</option><option value="violet">Violet</option></select><button id="libraryBulkColor" type="button">Apply color</button></span><button id="libraryBulkExport" type="button">Export selection as JSON</button></div></details><span class="bar-sep"></span><button id="libraryBulkTrash" class="danger">Move to Trash</button><button id="libraryUndoTrash" hidden>Undo Trash</button><button id="libraryBrowseTrash" class="quiet">Browse Trash</button>`;
    $('#list').after(bulk);
    const paging = document.createElement('nav');
    paging.id = 'libraryPages';
    paging.className = 'xv-library-pages';
    paging.setAttribute('aria-label', 'Library pages');
    $('#list').after(paging);
    $('#librarySelectPage').onclick = () => { selectVisiblePage(); bulk.querySelector('details')?.removeAttribute('open'); };
    $('#librarySelectResults').onclick = () => { selectAllMatching(); bulk.querySelector('details')?.removeAttribute('open'); };
    $('#libraryInvertPage').onclick = () => { invertVisiblePage(); bulk.querySelector('details')?.removeAttribute('open'); };
    $('#libraryClearSelection').onclick = () => { selected.clear(); renderSelection(); };
    $('#libraryBulkFav').onclick = () => bulkMeta({ favorite: true }, 'Favorited');
    $('#libraryBulkReviewed').onclick = () => bulkMeta({ reviewed: true }, 'Marked reviewed');
    $('#libraryBulkTag').onclick = () => { const input = $('#libraryBulkTagInput'), tag = input.value.trim(); if (!tag) return input.focus(); bulkMeta({ addTag: tag }, 'Tagged'); input.value = ''; };
    $('#libraryBulkTagInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('#libraryBulkTag').click(); } });
    $('#libraryBulkColor').onclick = () => bulkMeta({ colorLabel: $('#libraryBulkColorSelect').value }, 'Labeled');
    $('#libraryBulkDownload').onclick = bulkDownload;
    $('#libraryBulkCopy').onclick = () => { openLinkExport(); $('#libraryExportScope').value = 'selected'; refreshLinkExportSummary(); };
    $('#libraryBulkExport').onclick = bulkExport;
    $('#libraryBulkTrash').onclick = trashSelected;
    $('#libraryUndoTrash').onclick = undoTrash;
    $('#libraryBrowseTrash').onclick = () => window.XVaultTrash.open();
    document.addEventListener('keydown', playerKeys, true);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !selected.size || document.querySelector('dialog[open]') || !libraryPage.classList.contains('show')) return;
      if (event.target.closest('input,textarea,select,[contenteditable]')) return;
      if (!$('#lightbox').classList.contains('hidden') || !$('#palette').classList.contains('hidden')) return;
      selected.clear();
      renderSelection();
    });
    $('#list').addEventListener('click', event => {
      const button = event.target.closest('[data-quicklook]');
      if (button) openQuickLookById(button.dataset.quicklook);
    });
    $('#list').addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !event.target.closest('button,input,select,textarea,a,[contenteditable]')) {
        event.preventDefault();
        selectAllMatching();
        return;
      }
      if (event.target.closest('button,input,select,textarea,a,[contenteditable]')) return;
      const card = event.target.closest('.tweet');
      if (!card || event.ctrlKey || event.altKey || event.metaKey) return;
      const cards = $$('#list .tweet');
      const position = cards.indexOf(card);
      if ($('#list').classList.contains('xv-virtual-list') && ['j', 'k', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const current = Number(card.dataset.rowIndex);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? compactRows.length - 1 : Math.max(0, Math.min(compactRows.length - 1, current + (event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1)));
        const list = $('#list'), top = next * 76;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (top + 76 > list.scrollTop + list.clientHeight) list.scrollTop = top + 76 - list.clientHeight;
        paintCompact(true, next);
      } else if (event.key === 'j' || event.key === 'k' || event.key.startsWith('Arrow')) {
        event.preventDefault();
        const forward = event.key === 'j' || event.key === 'ArrowDown' || event.key === 'ArrowRight';
        const view = $('#list').dataset.view;
        if ((view === 'gallery' || view === 'masonry' || view === 'cards') && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          // Nearest tile in the row above or below.
          const here = card.getBoundingClientRect(), centre = here.left + here.width / 2;
          const down = event.key === 'ArrowDown';
          const candidates = cards.filter(other => { const box = other.getBoundingClientRect(); return down ? box.top > here.bottom - 8 : box.bottom < here.top + 8; });
          const best = candidates.sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            const vertical = down ? ra.top - rb.top : rb.top - ra.top;
            return Math.abs(vertical) > 16 ? vertical : Math.abs(ra.left + ra.width / 2 - centre) - Math.abs(rb.left + rb.width / 2 - centre);
          })[0];
          best?.focus();
        } else cards[Math.max(0, Math.min(cards.length - 1, position + (forward ? 1 : -1)))]?.focus();
      } else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        const filtered = resultRows();
        if (!filtered) return;
        const rows = filtered.slice(0, exportPageSize());
        const index = rows.findIndex(post => String(post.id) === card.dataset.id);
        if (index >= 0) {
          if (event.key === ' ') openQuickLook(rows, index);
          else if (rows[index].media?.length) openLightbox(rows, index, 0);
          else window.openDetails(rows[index].id);
        }
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault(); toggleFavorite(card.dataset.id);
      } else if (event.key.toLowerCase() === 'x') {
        event.preventDefault(); card.querySelector('.xv-card-select input')?.click();
      }
    });
    renderSavedViews();
    syncChrome();
    document.addEventListener('input', event => {
      if (event.target?.id !== 'search') return;
      queryInputEvents++;
      event.stopImmediatePropagation();
      clearTimeout(queryRenderTimer);
      queryRenderTimer = setTimeout(() => { queryRenderScheduled++; renderLib(); }, Math.max(0, Number(settings.librarySearchDebounce ?? 120)));
    }, true);
  }

  document.addEventListener('DOMContentLoaded', mount, { once: true });
  window.addEventListener('beforeunload', () => helperPool.clear());
})();
