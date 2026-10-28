/* Focus ownership for desktop overlays; native Quick Look keeps native focus. */
(() => {
  const opened = new Map();
  const modalIds = ['lightbox', 'palette', 'detailsDrawer'];
  const focusable =
    'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]';
  const visible = id => !document.getElementById(id)?.classList.contains('hidden');
  const isModal = id => id !== 'detailsDrawer' || innerWidth < 1100 || visible('lightbox');
  function top() {
    return [...opened.keys()].reverse().find(id => visible(id) && isModal(id));
  }
  function sync() {
    const id = top();
    const drawer = document.getElementById('detailsDrawer');
    // A modal descendant of an inert shell cannot receive focus.
    const drawerModal = isModal('detailsDrawer');
    const host = drawerModal ? document.body : document.getElementById('page-library');
    if (drawer.parentElement !== host) host.append(drawer);
    drawer.dataset.overlay = drawerModal ? 'modal' : 'docked';
    document.querySelector('.shell').inert = !!id;
    for (const name of modalIds) {
      const element = document.getElementById(name),
        modal = isModal(name);
      element.inert = !!id && name !== id;
      element.setAttribute('role', modal ? 'dialog' : 'complementary');
      if (modal) element.setAttribute('aria-modal', 'true');
      else element.removeAttribute('aria-modal');
    }
  }
  function enter(id, invoker) {
    if (['lightbox', 'detailsDrawer'].includes(id) && invoker?.closest?.('#xvQuickLook'))
      invoker = window.XVaultQuickLookReturnTarget?.() || document.querySelector('#search');
    const returnPoint = { element: invoker, recordId: invoker?.closest?.('.tweet')?.dataset.id || '' };
    if (!opened.has(id)) opened.set(id, returnPoint);
    else {
      const old = opened.get(id);
      opened.delete(id);
      opened.set(id, old);
    }
    sync();
    const target = document.getElementById(id);
    (
      target.querySelector(id === 'palette' ? '#paletteInput' : id === 'lightbox' ? '#lbClose' : '#drawerClose') ||
      target
    ).focus({ preventScroll: true });
  }
  function leave(ids) {
    let restore,
      hadScope = false;
    for (const id of ids)
      if (opened.has(id)) {
        hadScope = true;
        restore = opened.get(id);
        opened.delete(id);
      }
    sync();
    const original = restore?.element;
    const record = restore?.recordId
      ? [...document.querySelectorAll('#list .tweet')].find(row => row.dataset.id === restore.recordId)
      : null;
    const usable = element => element?.isConnected && element.getClientRects().length > 0;
    const target = usable(original) ? original : usable(record) ? record : document.querySelector('#search');
    if (hadScope)
      requestAnimationFrame(() => {
        const active = top();
        if (active && !document.getElementById(active).contains(target))
          document.getElementById(active).querySelector(focusable)?.focus({ preventScroll: true });
        else target?.focus({ preventScroll: true });
      });
    return hadScope ? { target } : null;
  }
  window.XVaultOpenFocusScope = enter;
  window.XVaultCloseFocusScopes = leave;
  function install() {
    for (const [id, label] of [
      ['lightbox', 'Archived media viewer'],
      ['palette', 'Command Center'],
      ['detailsDrawer', 'Post inspector'],
    ]) {
      const element = document.getElementById(id);
      element.setAttribute('aria-label', label);
      element.tabIndex = -1;
    }
    document.querySelector('#paletteInput').setAttribute('aria-label', 'Search commands');
    document.querySelector('#lbZoom').setAttribute('aria-label', 'Image zoom percentage');
    document.addEventListener(
      'keydown',
      event => {
        const id = top();
        if (document.querySelector('dialog[open]')) return;
        if (!id) {
          if (event.key === 'Escape' && visible('detailsDrawer')) closeLightbox();
          return;
        }
        const box = document.getElementById(id);
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (id === 'palette') closePalette();
          else closeLightbox();
          return;
        }
        if (event.key !== 'Tab') return;
        const controls = [...box.querySelectorAll(focusable)].filter(
          element => element.getClientRects().length && !element.closest('[inert]')
        );
        if (!controls.length) {
          event.preventDefault();
          box.focus();
          return;
        }
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      },
      true
    );
    document.addEventListener('focusin', event => {
      const id = top();
      if (id && !document.querySelector('dialog[open]') && !document.getElementById(id).contains(event.target))
        document.getElementById(id).querySelector(focusable)?.focus({ preventScroll: true });
    });
    addEventListener('resize', sync);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
