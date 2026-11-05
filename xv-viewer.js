/* XVault 26 "Lumen": the Media Viewer.
   Decorates the lightbox after every render (the `renderLightbox` hook): a filmstrip of the media around the current
   item, a position line (post n of N · media k of K in this post), a Media facts panel (real resolution, aspect,
   duration, variants, what is on disk), cursor-anchored zoom, drag to pan, swipe, double-click to toggle 1:1,
   neighbour preloading, a full-screen mode and a shortcut sheet. Nothing here changes what is archived. */
(() => {
  const hooks = window.XVaultDashboard;
  if (!hooks) return;
  const $ = selector => document.querySelector(selector);
  const escape = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );
  const FILM_SIDE = 12; // thumbnails rendered either side of the current one
  const INFO_KEY = 'xv-viewer-info';
  const viewer = () => $('#lightbox');
  const isOpen = () => !!viewer() && !viewer().classList.contains('hidden');
  const items = () => (typeof lightboxItems !== 'undefined' ? lightboxItems : []);
  const index = () => (typeof lightboxIndex !== 'undefined' ? lightboxIndex : 0);
  const calm = () =>
    ['off', 'reduced'].includes(document.body.dataset.motion) || matchMedia('(prefers-reduced-motion: reduce)').matches;
  let lastIndex = -1;

  function kindOf(media) {
    try {
      return mediaLogical(media);
    } catch {
      return media?.type === 'video' ? 'video' : media?.type === 'animated_gif' ? 'gif' : 'image';
    }
  }
  function thumbFor(media) {
    let src = media?.preview || (media?.type === 'photo' ? media.url : '') || '';
    try {
      const url = new URL(src);
      if (url.hostname === 'pbs.twimg.com') {
        url.searchParams.set('name', 'thumb');
        src = url.href;
      }
    } catch {}
    return src;
  }
  function gcd(a, b) {
    return b ? gcd(b, a % b) : a;
  }
  function aspect(w, h) {
    if (!w || !h) return '';
    const d = gcd(w, h),
      a = w / d,
      b = h / d;
    if (a <= 32 && b <= 32) return `${a}:${b}`;
    return `${(w / h).toFixed(2)}:1`;
  }
  const duration = seconds => {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const s = Math.round(seconds);
    return s >= 3600
      ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
      : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  function sameAsset(a, b) {
    return a === b || Boolean(a && b && window.XVaultMediaAsset?.sameAsset?.(a, b));
  }
  // What is on disk for this one media item (not the whole post).
  function diskState(post, media) {
    const rows = (typeof libraryDownloads !== 'undefined' && libraryDownloads.get(String(post.id))) || [];
    const urls = [media.url, media.playbackUrl, ...(media.variants || []).map(variant => variant.url)].filter(Boolean);
    const mine = rows.filter(
      row =>
        (media.id && row.item?.mediaId && String(media.id) === String(row.item.mediaId)) ||
        urls.some(url => sameAsset(url, row.item?.url))
    );
    const done = mine.find(row => row.state === 'complete');
    if (done) {
      const verification = done.verification?.state || done.verificationState || '';
      if (['mismatch', 'corrupt', 'missing'].includes(verification))
        return { tone: 'bad', text: `Saved file ${verification} — repair from Downloads` };
      return {
        tone: 'good',
        text: verification === 'verified' ? 'Saved · verified' : 'Saved',
        file: done.filename || done.item?.filename || '',
      };
    }
    const failed = mine.find(row => row.state === 'failed');
    if (failed) return { tone: 'bad', text: 'Download failed — retry from Downloads' };
    const pending = mine.find(row => ['queued', 'downloading', 'paused'].includes(row.state));
    if (pending) return { tone: 'busy', text: pending.state === 'downloading' ? 'Downloading…' : 'Queued' };
    return { tone: 'none', text: 'Not saved yet' };
  }

  /* ───────── Chrome: position line, tools, filmstrip ───────── */
  function ensureChrome() {
    const stage = $('#lightbox .lbStage');
    if (!stage) return null;
    let bar = $('#xvViewerBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'xvViewerBar';
      bar.className = 'xv-viewer-bar';
      bar.innerHTML =
        '<div class="xv-viewer-where" aria-live="polite"></div><div class="xv-viewer-tools" role="toolbar" aria-label="Viewer"><button type="button" data-viewer="download" title="Download this media (D)" aria-label="Download this media">↓</button><button type="button" data-viewer="info" title="Show or hide details (I)" aria-label="Show or hide details" aria-pressed="true">i</button><button type="button" data-viewer="fullscreen" title="Full screen (F)" aria-label="Full screen">⤢</button><button type="button" data-viewer="help" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">?</button></div>';
      bar.addEventListener('click', event => {
        const action = event.target.closest('[data-viewer]')?.dataset.viewer;
        if (action) run(action);
      });
      stage.append(bar);
    }
    const close = $('#lbClose');
    if (close && close.parentElement !== bar.querySelector('.xv-viewer-tools')) {
      close.setAttribute('aria-label', 'Close viewer');
      close.title = 'Close (Esc)';
      bar.querySelector('.xv-viewer-tools').append(close);
    }
    let film = $('#xvFilmstrip');
    if (!film) {
      film = document.createElement('nav');
      film.id = 'xvFilmstrip';
      film.className = 'xv-filmstrip';
      film.setAttribute('aria-label', 'Media in this view');
      film.addEventListener('click', event => {
        const target = event.target.closest('[data-film]');
        if (target) jump(Number(target.dataset.film));
      });
      stage.append(film);
    }
    return { bar, film };
  }
  function paintChrome() {
    const chrome = ensureChrome();
    const list = items(),
      current = index(),
      entry = list[current];
    if (!chrome || !entry) return;
    const { bar, film } = chrome;
    const posts = [];
    let postNumber = 0;
    for (let i = 0; i < list.length; i++)
      if (i === 0 || list[i].t !== list[i - 1].t) {
        posts.push(i);
        if (i <= current) postNumber = posts.length;
      }
    const inPost = (entry.t.media || []).indexOf(entry.m),
      mediaCount = entry.t.media?.length || 1;
    bar.querySelector('.xv-viewer-where').innerHTML =
      `<b>@${escape(entry.t.author?.handle || 'unknown')}</b><span>Post ${postNumber} of ${posts.length}</span>${mediaCount > 1 ? `<span>${inPost + 1} of ${mediaCount} in this post</span>` : ''}<span class="xv-viewer-kind">${escape(kindOf(entry.m) === 'gif' ? 'GIF' : kindOf(entry.m) === 'video' ? 'Video' : 'Photo')}</span>`;
    bar
      .querySelector('[data-viewer="info"]')
      .setAttribute('aria-pressed', String(!viewer().classList.contains('xv-info-off')));
    viewer().classList.toggle('xv-has-film', list.length > 1);
    if (list.length <= 1) {
      film.replaceChildren();
      film.hidden = true;
      return;
    }
    film.hidden = false;
    const from = Math.max(0, current - FILM_SIDE),
      to = Math.min(list.length, current + FILM_SIDE + 1);
    let html = from > 0 ? `<span class="xv-film-more" aria-hidden="true">+${from}</span>` : '';
    for (let i = from; i < to; i++) {
      const { t, m } = list[i],
        kind = kindOf(m),
        src = thumbFor(m),
        startsPost = i > 0 && list[i - 1].t !== t;
      html += `${startsPost && i !== from ? '<i class="xv-film-gap" aria-hidden="true"></i>' : ''}<button type="button" class="xv-film${i === current ? ' current' : ''}" data-film="${i}" aria-label="${escape(`${kind === 'video' ? 'Video' : kind === 'gif' ? 'GIF' : 'Photo'} from @${t.author?.handle || 'unknown'}, ${i + 1} of ${list.length}`)}"${i === current ? ' aria-current="true"' : ''}>${src ? `<img src="${escape(src)}" alt="" loading="lazy" decoding="async">` : '<span></span>'}${kind !== 'image' ? `<em>${kind === 'gif' ? 'GIF' : '▶'}</em>` : ''}</button>`;
    }
    if (to < list.length) html += `<span class="xv-film-more" aria-hidden="true">+${list.length - to}</span>`;
    film.innerHTML = html;
    window.XVaultHydrateHelperMedia?.(film);
    const currentThumb = film.querySelector('.xv-film.current');
    // Centre the current thumbnail without scrolling the page (scrollIntoView would move outer scrollers).
    if (currentThumb)
      requestAnimationFrame(() => {
        film.scrollLeft = currentThumb.offsetLeft - film.clientWidth / 2 + currentThumb.offsetWidth / 2;
      });
  }

  /* ───────── Media facts ───────── */
  function paintFacts() {
    const meta = $('#lbMeta'),
      entry = items()[index()];
    if (!meta || !entry) return;
    meta.querySelector('.xv-media-facts')?.remove();
    const { t, m } = entry,
      kind = kindOf(m),
      element = $('#lbContent img, #lbContent video'),
      disk = diskState(t, m),
      variants = (m.variants || []).filter(variant => variant.url),
      best = variants.slice().sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    const section = document.createElement('section');
    section.className = 'xv-media-facts';
    section.setAttribute('aria-label', 'Media facts');
    const recorded = m.width && m.height ? `${m.width} × ${m.height}` : '';
    section.innerHTML = `<h4>Media facts</h4><dl><dt>Resolution</dt><dd data-fact="resolution">${escape(recorded || 'Measuring…')}</dd><dt>Aspect</dt><dd data-fact="aspect">${escape(aspect(m.width, m.height) || '—')}</dd>${kind !== 'image' ? `<dt>Length</dt><dd data-fact="duration">${escape(duration(Number(m.durationMs || m.duration_millis) / 1000) || '—')}</dd>` : ''}${variants.length ? `<dt>Variants</dt><dd>${variants.length}${best?.bitrate ? ` · best ${Math.round(best.bitrate / 1000)} kbps` : ''}</dd>` : ''}<dt>On disk</dt><dd class="xv-disk ${disk.tone}">${escape(disk.text)}</dd>${disk.file ? `<dt>File</dt><dd class="xv-fact-file" title="${escape(disk.file)}">${escape(disk.file.split(/[\\/]/).pop())}</dd>` : ''}${m.alt || m.altText ? `<dt>Alt text</dt><dd>${escape(m.alt || m.altText)}</dd>` : ''}</dl><div class="xv-media-facts-actions"><button type="button" data-viewer="download">Download this</button>${(t.media || []).length > 1 ? `<button type="button" data-viewer="download-post">All ${(t.media || []).length} from post</button>` : ''}</div>`;
    section.addEventListener('click', event => {
      const action = event.target.closest('[data-viewer]')?.dataset.viewer;
      if (action) run(action);
    });
    meta.append(section);
    // The real decoded size, once known (recorded sizes are sometimes the preview's).
    const measure = () => {
      const w = element?.naturalWidth || element?.videoWidth,
        h = element?.naturalHeight || element?.videoHeight;
      if (!w || !h || !section.isConnected) return;
      const megapixels = (w * h) / 1e6;
      section.querySelector('[data-fact="resolution"]').textContent =
        `${w} × ${h}${megapixels >= 0.1 ? ` · ${megapixels.toFixed(1)} MP` : ''}${recorded && recorded !== `${w} × ${h}` ? ` (recorded ${recorded})` : ''}`;
      section.querySelector('[data-fact="aspect"]').textContent = aspect(w, h);
      const length = section.querySelector('[data-fact="duration"]');
      if (length && element.duration) length.textContent = duration(element.duration) || '—';
    };
    if (!element) return;
    if ((element.naturalWidth || element.videoWidth) && (element.complete !== false || element.readyState >= 1))
      measure();
    element.addEventListener(element.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', measure, { once: true });
  }

  /* ───────── Preloading and transitions ───────── */
  const preloaded = new Set();
  function preloadNeighbours() {
    const list = items(),
      current = index();
    for (const offset of [1, -1, 2]) {
      const entry = list[current + offset];
      if (!entry || kindOf(entry.m) === 'video') continue;
      let src = '';
      try {
        const pick = mediaSource(entry.m);
        if (pick?.native || kindOf(entry.m) === 'image') src = pick?.src || '';
      } catch {}
      if (!src || src.includes('#xvhelper=') || preloaded.has(src)) continue;
      preloaded.add(src);
      if (preloaded.size > 60) preloaded.delete(preloaded.values().next().value);
      const image = new Image();
      image.decoding = 'async';
      image.src = src;
    }
  }
  function playTransition() {
    const current = index();
    const element = $('#lbContent img, #lbContent .lbVideoShell');
    if (element && !calm() && lastIndex >= 0 && lastIndex !== current) {
      const forward = current > lastIndex;
      element.animate(
        [
          { opacity: 0.35, transform: `translateX(${forward ? 28 : -28}px) scale(.985)` },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' }
      );
    }
    lastIndex = current;
  }

  /* ───────── Zoom at the cursor, drag to pan, swipe ───────── */
  function zoomAt(nextZoom, clientX, clientY) {
    const box = $('#lbContent'),
      img = box?.querySelector('img');
    if (!box || !img || typeof setLightboxZoom !== 'function') return;
    const max = settings.libraryZoomMax || 1200;
    nextZoom = Math.max(25, Math.min(max, nextZoom));
    const before = img.getBoundingClientRect(),
      area = box.getBoundingClientRect();
    // The image point under the cursor, as a fraction of the image.
    const fx = before.width ? (clientX - before.left) / before.width : 0.5,
      fy = before.height ? (clientY - before.top) / before.height : 0.5;
    setLightboxZoom(nextZoom, false);
    const after = img.getBoundingClientRect();
    const targetLeft = box.scrollLeft + (after.left + fx * after.width - area.left) - (clientX - area.left),
      targetTop = box.scrollTop + (after.top + fy * after.height - area.top) - (clientY - area.top);
    // setLightboxZoom re-centres in the next frame; land on the cursor after it.
    requestAnimationFrame(() =>
      box.scrollTo({ left: Math.max(0, targetLeft), top: Math.max(0, targetTop), behavior: 'auto' })
    );
  }
  function installGestures() {
    const box = $('#lbContent');
    if (!box || box.dataset.xvGestures) return;
    box.dataset.xvGestures = '1';
    box.addEventListener(
      'wheel',
      event => {
        if (!isOpen() || !box.querySelector('img')) return;
        // Ctrl/⌘ + wheel (and trackpad pinch, which arrives as ctrl+wheel) zooms at the cursor.
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const step = Math.max(5, settings.libraryZoomStep || 25) * (Math.abs(event.deltaY) < 20 ? 0.4 : 1);
        zoomAt((lightboxZoom || 100) + (event.deltaY > 0 ? -step : step), event.clientX, event.clientY);
      },
      { passive: false, capture: true }
    );
    let drag = null;
    box.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !box.querySelector('img')) return;
      drag = {
        x: event.clientX,
        y: event.clientY,
        left: box.scrollLeft,
        top: box.scrollTop,
        moved: false,
        id: event.pointerId,
        type: event.pointerType,
      };
    });
    box.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x,
        dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        try {
          box.setPointerCapture(event.pointerId);
        } catch {}
      }
      if (box.classList.contains('isZoomed')) {
        box.classList.add('xv-panning');
        box.scrollLeft = drag.left - dx;
        box.scrollTop = drag.top - dy;
      }
    });
    const end = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x,
        dy = event.clientY - drag.y,
        wasDrag = drag.moved;
      box.classList.remove('xv-panning');
      // A horizontal swipe on an unzoomed image moves to the neighbour.
      if (wasDrag && !box.classList.contains('isZoomed') && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5)
        stepLightbox(dx < 0 ? 1 : -1);
      if (wasDrag) {
        // Swallow the click that follows a drag so it does not toggle zoom.
        box.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => box.removeEventListener('click', swallow, { capture: true }), 0);
      }
      drag = null;
    };
    const swallow = event => {
      event.stopPropagation();
      event.preventDefault();
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', () => {
      drag = null;
      box.classList.remove('xv-panning');
    });
  }

  /* ───────── Commands and keys ───────── */
  function jump(target) {
    const list = items();
    if (!list[target] || target === index()) return;
    lightboxIndex = target;
    lightboxZoom = 100;
    lightboxFit = { w: 0, h: 0 };
    renderLightbox();
  }
  function jumpPost(direction) {
    const list = items(),
      current = index(),
      post = list[current]?.t;
    if (!post) return;
    let i = current;
    if (direction > 0) {
      while (i < list.length && list[i].t === post) i++;
    } else {
      while (i > 0 && list[i - 1].t === post) i--;
      i--;
      if (i < 0) return;
      const previous = list[i].t;
      while (i > 0 && list[i - 1].t === previous) i--;
    }
    if (i >= 0 && i < list.length) jump(i);
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await viewer()?.requestFullscreen();
    } catch {
      window.toast?.('Full screen is unavailable here');
    }
  }
  function setInfo(on) {
    viewer()?.classList.toggle('xv-info-off', !on);
    try {
      localStorage.setItem(INFO_KEY, on ? '1' : '0');
    } catch {}
    $('#xvViewerBar [data-viewer="info"]')?.setAttribute('aria-pressed', String(on));
    // The stage changed size: refit an unzoomed image.
    const img = $('#lbContent img');
    if (img && (lightboxZoom || 100) === 100 && typeof computeFit === 'function')
      requestAnimationFrame(() => {
        computeFit(img);
        setLightboxZoom(100, false);
      });
  }
  function showHelp() {
    let sheet = $('#xvViewerHelp');
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'xvViewerHelp';
      sheet.className = 'xv-viewer-help';
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-label', 'Viewer shortcuts');
      const rows = [
        ['← →', 'Previous / next media'],
        ['Page Up / Page Down', 'Previous / next post'],
        ['Home / End', 'First / last'],
        ['+ − 0 1', 'Zoom in, out, fit, actual size'],
        ['Ctrl + wheel', 'Zoom at the pointer'],
        ['Drag', 'Pan a zoomed image · swipe to move on'],
        ['Space / K', 'Play or pause'],
        ['J / L', 'Back / forward 5 s'],
        ['[ ]', 'Previous / next frame'],
        ['M', 'Mute'],
        ['F', 'Full screen'],
        ['I', 'Details panel'],
        ['D · Shift D', 'Download this · whole post'],
        ['Esc', 'Close'],
      ];
      sheet.innerHTML = `<header><b>Viewer shortcuts</b><button type="button" data-close aria-label="Close shortcuts">×</button></header><dl>${rows.map(([key, text]) => `<dt><kbd>${escape(key)}</kbd></dt><dd>${escape(text)}</dd>`).join('')}</dl>`;
      sheet.querySelector('[data-close]').onclick = () => (sheet.hidden = true);
      viewer().append(sheet);
    } else sheet.hidden = !sheet.hidden;
    if (!sheet.hidden) sheet.querySelector('[data-close]').focus({ preventScroll: true });
  }
  function run(action) {
    const entry = items()[index()];
    if (!entry) return;
    if (action === 'download') downloadOne(entry.t, entry.m, (entry.t.media || []).indexOf(entry.m));
    else if (action === 'download-post') downloadPost(entry.t);
    else if (action === 'info') setInfo(viewer().classList.contains('xv-info-off'));
    else if (action === 'fullscreen') toggleFullscreen();
    else if (action === 'help') showHelp();
  }
  document.addEventListener(
    'keydown',
    event => {
      if (!isOpen() || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target.closest?.('input,textarea,select,[contenteditable]')) return;
      const key = event.key,
        video = $('#lbContent video');
      const handled = () => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      if (key === 'Escape' && !$('#xvViewerHelp')?.hidden && $('#xvViewerHelp')) {
        handled();
        $('#xvViewerHelp').hidden = true;
        return;
      }
      if (key === 'PageDown' || key === 'PageUp') return void (handled(), jumpPost(key === 'PageDown' ? 1 : -1));
      if (key === 'Home' || key === 'End') return void (handled(), jump(key === 'Home' ? 0 : items().length - 1));
      if (key === '?') return void (handled(), showHelp());
      if (key === 'i' || key === 'I') return void (handled(), run('info'));
      if (key === 'd') return void (handled(), run('download'));
      if (key === 'D') return void (handled(), run('download-post'));
      // F is full screen for the whole viewer (the video keeps its own full-screen button).
      if ((key === 'f' || key === 'F') && !video) return void (handled(), toggleFullscreen());
      if ((key === ',' || key === '.') && video) {
        handled();
        video.pause();
        video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (key === '.' ? 1 : -1) / 30));
      }
    },
    true
  );

  hooks.after('renderLightbox', () => {
    if (!isOpen()) return;
    try {
      if (localStorage.getItem(INFO_KEY) === '0') viewer().classList.add('xv-info-off');
    } catch {}
    paintChrome();
    paintFacts();
    installGestures();
    playTransition();
    preloadNeighbours();
  });
  // closeLightbox() is not a hooked function; watch the viewer's hidden class instead.
  const watchClose = () => {
    const node = viewer();
    if (!node) return;
    new MutationObserver(() => {
      if (!node.classList.contains('hidden')) return;
      lastIndex = -1;
      const help = $('#xvViewerHelp');
      if (help) help.hidden = true;
      if (document.fullscreenElement === node) document.exitFullscreen().catch(() => {});
    }).observe(node, { attributes: true, attributeFilter: ['class'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchClose);
  else watchClose();
  window.XVaultViewer = { jump, jumpPost, toggleFullscreen, setInfo, zoomAt, diskState };
})();
