/* XVault 22 motion layer, part two. Builds on window.XVaultMotion (xv-motion.js) and obeys the same
   rules: Off/Reduced, the system preference and Safe Mode turn every movement into an instant change.
   - Notices: toast() grows a stack, tones, actions, a repeat counter, a progress bar and a history.
   - Segmented controls: one sliding pill follows the selected option instead of jumping.
   - Lightbox: media zooms out of the thumbnail that was clicked.
   - Favourites: a small burst when a post becomes a favourite.
   Scroll reveals are CSS only (scroll-driven animations, xv-motion-plus.css). */
(() => {
  const motion = () => window.XVaultMotion;
  const calm = () => motion()?.calm?.() ?? true;
  const play = (...args) => motion()?.play?.(...args);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  /* ───────── Notices (toast 2.0) ─────────
     toast(message, { tone, action: { label, run }, duration }) — the old one-argument form still works and
     #toast stays the element that holds the newest message. */
  const ERROR =
    /\b(could not|couldn['’]t|cannot|can['’]t|failed|failure|error|unable|refused|denied|invalid|not allowed|blocked)\b/i;
  const SUCCESS =
    /^(saved|copied|done|added|queued|undone|tagged|linked|renamed|imported|exported|restored|moved|created|updated|deleted|removed|archived|downloaded|pinned|cleared|merged|applied|started|finished|backed up)\b|\b(saved|copied|exported|imported)\b/i;
  const history = [];
  let timer = 0,
    deadline = 0,
    remaining = 0;
  function toneOf(text, tone) {
    if (['info', 'success', 'error', 'warn'].includes(tone)) return tone;
    if (ERROR.test(text)) return 'error';
    if (SUCCESS.test(text)) return 'success';
    return 'info';
  }
  function element() {
    let node = document.getElementById('toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'toast';
      document.body.append(node);
    }
    if (!node.hasAttribute('role')) {
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      node.setAttribute('aria-atomic', 'true');
    }
    return node;
  }
  function hide(node) {
    clearTimeout(timer);
    node.classList.remove('show', 'is-paused');
  }
  function arm(node, ms) {
    clearTimeout(timer);
    remaining = ms;
    deadline = performance.now() + ms;
    timer = setTimeout(() => hide(node), ms);
    const bar = node.querySelector('.xt-bar');
    if (bar) {
      // XVault 25: restart the countdown on a fresh element instead of forcing a synchronous layout
      // (`offsetWidth`), which cost ~20 ms with a full Library on screen.
      const fresh = bar.cloneNode(false);
      fresh.style.animation = '';
      fresh.style.animationDuration = `${ms}ms`;
      bar.replaceWith(fresh);
    }
  }
  // The previous notice lifts away instead of being overwritten in place.
  function ghost(node) {
    if (calm() || !node.classList.contains('show')) return;
    // Copy now (the old text), measure in the next frame so the caller's DOM writes are not forced into a layout.
    const copy = node.cloneNode(true);
    copy.removeAttribute('id');
    copy.removeAttribute('role');
    copy.removeAttribute('aria-live');
    copy.setAttribute('aria-hidden', 'true');
    copy.classList.add('xt-ghost');
    // Appending is cheap (no layout); the copy stays invisible until it is placed in the next frame.
    copy.style.visibility = 'hidden';
    document.body.append(copy);
    requestAnimationFrame(() => lift(node, copy));
  }
  // XVault 26: the shown notice is measured once it has settled, in an idle period, so replacing it never forces a
  // layout in the middle of the caller's work (≈20 ms in a full Library when a favorite toggled a notice).
  function rememberRect(node) {
    node._xtRect = null;
    clearTimeout(node._xtMeasure);
    node._xtMeasure = setTimeout(() => {
      const measure = () => {
        if (node.classList.contains('show')) node._xtRect = node.getBoundingClientRect();
      };
      if (window.requestIdleCallback) requestIdleCallback(measure, { timeout: 1000 });
      else measure();
    }, 420);
  }
  function lift(node, copy) {
    const box = node._xtRect;
    if (!box) return void copy.remove();
    Object.assign(copy.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      bottom: 'auto',
      visibility: '',
    });
    const animation = copy.animate(
      [
        { opacity: 0.9, transform: 'translateY(0) scale(1)' },
        { opacity: 0, transform: `translateY(-${Math.round(box.height + 10)}px) scale(.96)` },
      ],
      { duration: motion()?.duration?.(360) || 360, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'forwards' }
    );
    animation.finished.catch(() => {}).finally(() => copy.remove());
  }
  function notify(message, options = {}) {
    if (typeof options === 'string') options = { tone: options };
    const text = String(message ?? ''),
      node = element(),
      tone = toneOf(text, options.tone),
      action = options.action && typeof options.action.run === 'function' ? options.action : null;
    if (!text) return;
    const showing = node.classList.contains('show');
    if (showing && node.dataset.msg === text && !action) {
      // Same notice again: count it instead of flashing it.
      const count = Number(node.dataset.count || 1) + 1;
      node.dataset.count = String(count);
      let badge = node.querySelector('.xt-count');
      if (!badge) {
        badge = document.createElement('b');
        badge.className = 'xt-count';
        node.querySelector('.xt-msg')?.after(badge);
      }
      badge.textContent = `×${count}`;
      play(badge, [{ transform: 'scale(1.5)' }, { transform: 'scale(1)' }], 300, {
        spring: 'bouncy',
        fixedDuration: true,
      });
      if (history[0]) history[0].count = count;
      return arm(node, Math.max(remaining, 2600));
    }
    if (showing) ghost(node);
    node.dataset.msg = text;
    node.dataset.count = '1';
    node.dataset.tone = tone;
    node.classList.toggle('has-action', !!action);
    node.replaceChildren();
    const icon = document.createElement('i');
    icon.className = 'xt-icon';
    icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('span');
    body.className = 'xt-msg';
    body.textContent = text;
    node.append(icon, body);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'xt-action';
      button.textContent = String(action.label || 'Undo');
      button.onclick = () => {
        hide(node);
        Promise.resolve()
          .then(() => action.run())
          .catch(error =>
            notify(`Could not ${String(action.label || 'undo').toLowerCase()}: ${error?.message || error}`)
          );
      };
      node.append(button);
    }
    const bar = document.createElement('i');
    bar.className = 'xt-bar';
    bar.setAttribute('aria-hidden', 'true');
    node.append(bar);
    // The entrance is the WAAPI animation below; no forced reflow to restart a CSS transition.
    node.classList.add('show');
    play(
      node,
      [
        { transform: 'translate(-50%, 14px) scale(.96)', opacity: 0 },
        { transform: 'translate(-50%, 0) scale(1)', opacity: 1 },
      ],
      260,
      { spring: 'snappy' }
    );
    rememberRect(node);
    history.unshift({ text, tone, at: Date.now(), count: 1 });
    history.length = Math.min(history.length, 40);
    const duration =
      Number(options.duration) > 0
        ? Number(options.duration)
        : tone === 'error' || action
          ? 6500
          : Math.min(7000, 2600 + Math.max(0, text.length - 60) * 35);
    arm(node, duration);
  }
  function pause() {
    const node = document.getElementById('toast');
    if (!node?.classList.contains('show') || !timer) return;
    clearTimeout(timer);
    timer = 0;
    remaining = Math.max(800, deadline - performance.now());
    node.classList.add('is-paused');
  }
  function resume() {
    const node = document.getElementById('toast');
    if (!node?.classList.contains('is-paused')) return;
    node.classList.remove('is-paused');
    clearTimeout(timer);
    deadline = performance.now() + remaining;
    timer = setTimeout(() => hide(node), remaining);
  }
  function showHistory() {
    let dialog = document.getElementById('xvNoticeHistory');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'xvNoticeHistory';
      dialog.className = 'xv-sheet xt-history';
      dialog.setAttribute('aria-labelledby', 'xvNoticeHistoryTitle');
      document.body.append(dialog);
      dialog.addEventListener('click', event => {
        if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
      });
    }
    const time = stamp =>
      new Date(stamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const rows = history.length
      ? history
          .map(
            item =>
              `<li data-tone="${item.tone}"><i class="xt-icon" aria-hidden="true"></i><span>${escape(item.text)}${item.count > 1 ? ` <b class="xt-count">×${item.count}</b>` : ''}</span><time>${time(item.at)}</time></li>`
          )
          .join('')
      : '<li class="xt-empty">No notices yet in this tab.</li>';
    dialog.innerHTML = `<header><h2 id="xvNoticeHistoryTitle">Recent notices</h2><button type="button" class="quiet" data-close aria-label="Close">×</button></header><ol class="xt-list">${rows}</ol>`;
    if (!dialog.open) dialog.showModal();
  }
  const escape = value =>
    String(value).replace(
      /[&<>"']/g,
      ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );

  /* ───────── Segmented controls: a sliding pill ───────── */
  const ACTIVE = ':scope > :is([aria-checked="true"], .active, [aria-pressed="true"], [aria-selected="true"])';
  const remembered = new Map(); // seg identity → last pill box, so a re-rendered control still glides
  const watched = new WeakSet();
  let queued = false;
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedulePills()) : null;
  const identity = seg =>
    seg.id || seg.getAttribute('aria-label') || `${seg.className}|${seg.closest('[id]')?.id || ''}`;
  function schedulePills() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(placePills);
  }
  // Reads every box first, then writes: interleaving offsetLeft reads with style writes forced one
  // layout per segmented control (≈16 ms on a busy Library open). One flush covers the instant/glide
  // starting positions for all pills at once.
  function placePills() {
    queued = false;
    const jobs = [];
    for (const seg of document.querySelectorAll('.seg')) {
      if (!seg.offsetParent) continue;
      const active = seg.querySelector(ACTIVE);
      const pill = seg.querySelector(':scope > .xv-seg-pill');
      if (!active) {
        if (pill) pill.style.opacity = '0';
        continue;
      }
      const box = { x: active.offsetLeft, y: active.offsetTop, w: active.offsetWidth, h: active.offsetHeight };
      const key = `${box.x},${box.y},${box.w},${box.h}`;
      if (pill?.dataset.key === key && pill.style.opacity === '1') continue;
      jobs.push({ seg, pill, box, key });
    }
    if (!jobs.length) return;
    const quiet = calm();
    let flush = false;
    for (const job of jobs) {
      const id = identity(job.seg);
      job.id = id;
      job.instant = !job.pill || quiet;
      if (!job.pill) {
        const pill = document.createElement('span');
        pill.className = 'xv-seg-pill';
        pill.setAttribute('aria-hidden', 'true');
        job.seg.append(pill);
        job.seg.classList.add('xv-pilled');
        job.pill = pill;
        if (resize && !watched.has(job.seg)) {
          resize.observe(job.seg);
          watched.add(job.seg);
        }
        // A control that was re-rendered starts from where its pill was, then glides.
        const before = remembered.get(id);
        if (before && !quiet) {
          job.pill.classList.add('is-instant');
          writeBox(job.pill, before);
          job.instant = false;
          job.glide = true;
          flush = true;
        }
      }
      if (job.instant) {
        job.pill.classList.add('is-instant');
        writeBox(job.pill, job.box);
        flush = true;
      }
    }
    if (flush) void document.body.offsetWidth;
    for (const job of jobs) {
      if (job.glide) job.pill.classList.remove('is-instant');
      if (!job.instant) writeBox(job.pill, job.box);
      else job.pill.classList.remove('is-instant');
      job.pill.dataset.key = job.key;
      remembered.set(job.id, job.box);
    }
  }
  function writeBox(pill, box) {
    pill.style.opacity = '1';
    pill.style.width = `${box.w}px`;
    pill.style.height = `${box.h}px`;
    pill.style.transform = `translate(${box.x}px, ${box.y}px)`;
  }
  function watchPills() {
    new MutationObserver(records => {
      for (const record of records) {
        const target = record.target;
        if (record.type === 'attributes') {
          if (target.closest?.('.seg') || target.classList?.contains('page') || target === document.body)
            return schedulePills();
        } else
          for (const node of record.addedNodes)
            if (node.nodeType === 1 && (node.matches('.seg') || node.querySelector('.seg'))) return schedulePills();
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['aria-checked', 'aria-pressed', 'aria-selected', 'class'],
    });
    schedulePills();
  }

  /* ───────── Lightbox: zoom out of the thumbnail ───────── */
  let origin = null;
  function watchLightbox() {
    document.addEventListener(
      'click',
      event => {
        const item = event.target.closest?.('.mediaItem, [data-media-more]');
        if (!item) return;
        const visual = item.querySelector('img, video') || item;
        origin = { rect: visual.getBoundingClientRect(), at: performance.now() };
      },
      true
    );
    const box = document.getElementById('lightbox');
    if (!box) return;
    let open = !box.classList.contains('hidden');
    new MutationObserver(() => {
      const next = !box.classList.contains('hidden');
      if (next && !open && origin && performance.now() - origin.at < 900) zoom(origin.rect);
      if (next !== open) origin = null;
      open = next;
    }).observe(box, { attributes: true, attributeFilter: ['class'] });
  }
  async function zoom(rect) {
    if (calm() || !rect?.width) return;
    const content = document.getElementById('lbContent'),
      target = content?.querySelector('.lbImageCanvas img, .lbVideoShell video');
    if (!target) return;
    // Replace the generic rise with a plain fade; the media itself carries the movement.
    play(content, [{ opacity: 0.2 }, { opacity: 1 }], 200);
    if (target.tagName === 'IMG' && !target.complete)
      await Promise.race([target.decode?.().catch(() => {}), wait(240)]);
    const now = target.getBoundingClientRect();
    if (now.width < 8 || now.height < 8) return;
    const dx = rect.left + rect.width / 2 - (now.left + now.width / 2),
      dy = rect.top + rect.height / 2 - (now.top + now.height / 2),
      sx = rect.width / now.width,
      sy = rect.height / now.height;
    play(
      target,
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, borderRadius: '12px', opacity: 0.85 },
        { transform: 'none', borderRadius: '0px', opacity: 1 },
      ],
      420,
      { spring: 'gentle' }
    );
  }

  /* ───────── Favourite burst ───────── */
  function burst(element, { count = 8, tone = 'accent' } = {}) {
    if (!element || calm()) return;
    motion()?.celebrate?.(element, { tone });
    const box = element.getBoundingClientRect(),
      cx = box.left + box.width / 2,
      cy = box.top + box.height / 2;
    for (let index = 0; index < count; index++) {
      const angle = (index / count) * Math.PI * 2 + Math.random() * 0.4,
        distance = 18 + Math.random() * 14,
        spark = document.createElement('span');
      spark.className = `xv-spark xv-spark-${tone}`;
      Object.assign(spark.style, { left: `${cx - 3}px`, top: `${cy - 3}px` });
      document.body.append(spark);
      spark
        .animate(
          [
            { opacity: 1, transform: 'translate(0, 0) scale(1)' },
            {
              opacity: 0,
              transform: `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px) scale(.3)`,
            },
          ],
          { duration: motion()?.duration?.(560) || 560, easing: 'cubic-bezier(.15,.8,.25,1)' }
        )
        .finished.catch(() => {})
        .finally(() => spark.remove());
    }
  }
  function watchFavourites() {
    document.addEventListener(
      'click',
      event => {
        const button = event.target.closest?.('[data-fav]');
        if (button && button.getAttribute('aria-pressed') !== 'true') burst(button);
      },
      true
    );
  }

  function mount() {
    if (typeof window.toast === 'function' && !window.toast.xvNotices) {
      notify.xvNotices = true;
      window.toast = notify;
    }
    const node = element();
    node.addEventListener('pointerenter', pause);
    node.addEventListener('pointerleave', resume);
    node.addEventListener('focusin', pause);
    node.addEventListener('focusout', resume);
    watchPills();
    watchLightbox();
    watchFavourites();
    window.XVaultDashboard?.commands?.(() => [
      { name: 'Recent notices', hint: 'messages shown at the bottom of the screen in this tab', run: showHistory },
    ]);
    Object.assign(window.XVaultMotion || {}, { burst });
    window.XVaultNotices = { notify, history: () => history.slice(), show: showHistory, pause, resume };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
