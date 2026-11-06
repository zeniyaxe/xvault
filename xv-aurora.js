/* XVault 24 "Aurora" interaction layer, shared by every dashboard surface:
   - Tooltips: one positioned tooltip for icon-only controls, [data-tip] and [title] (the native title is held
     back while ours shows, then restored). Keyboard focus shows it too; Escape, press and scroll hide it.
   - Accessible names: icon-only buttons without a name borrow it from their tooltip text.
   - Button feedback: XVaultUI.busy(button, work) shows loading, then success or error, without layout shift.
   Pure presentation: no storage, no network, no new permissions. */
(() => {
  const DELAY = 420,
    WARM = 380;
  let tip = null,
    target = null,
    timer = 0,
    lastHide = 0;
  const calm = () =>
    ['off', 'reduced'].includes(document.body?.dataset.motion) ||
    matchMedia('(prefers-reduced-motion: reduce)').matches;

  function visibleText(element) {
    let text = '';
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
      else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches('svg, .sr, .lbl-sr, .xv-sr-only, [hidden]')) continue;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (style.position === 'absolute' && style.clip?.startsWith('rect(0')) continue;
        text += visibleText(node);
      }
    }
    return text.trim();
  }
  function tipText(element) {
    const own = element.dataset.tip || element.dataset.xvTitle || element.getAttribute('title') || '';
    if (own) return own;
    if (element.matches('button, summary, [role="button"], a') && !visibleText(element))
      return element.getAttribute('aria-label') || '';
    return '';
  }
  function candidate(node) {
    const element = node?.closest?.('[data-tip], [title], [data-xv-title], button[aria-label], summary[aria-label]');
    if (!element || element.closest('.xv-tip, [data-no-tip]')) return null;
    if (element === document.body || element === document.documentElement) return null;
    const text = tipText(element);
    if (!text) return null;
    // A label that already reads the same as the tooltip adds nothing.
    if (!element.dataset.tip && visibleText(element).toLowerCase() === text.toLowerCase()) return null;
    return element;
  }
  function ensure() {
    if (tip) return tip;
    tip = document.createElement('div');
    tip.className = 'xv-tip';
    tip.setAttribute('role', 'tooltip');
    tip.id = 'xvTip';
    document.body.append(tip);
    return tip;
  }
  function place(element) {
    const box = element.getBoundingClientRect(),
      node = ensure();
    node.style.transform = 'none';
    const width = node.offsetWidth,
      height = node.offsetHeight,
      gap = 8;
    const rail = element.closest('.rail') && getComputedStyle(element.closest('.rail')).flexDirection === 'column';
    let x, y;
    if (rail) {
      x = box.right + gap + 2;
      y = box.top + box.height / 2 - height / 2;
    } else {
      x = box.left + box.width / 2 - width / 2;
      y = box.top - height - gap;
      if (y < 6) y = box.bottom + gap;
    }
    x = Math.max(6, Math.min(innerWidth - width - 6, x));
    y = Math.max(6, Math.min(innerHeight - height - 6, y));
    node.style.left = `${Math.round(x)}px`;
    node.style.top = `${Math.round(y)}px`;
    node.style.transform = '';
  }
  function show(element) {
    const text = tipText(element);
    if (!text) return;
    const node = ensure();
    if (element.hasAttribute('title')) {
      element.dataset.xvTitle = element.getAttribute('title');
      element.removeAttribute('title');
    }
    const shortcut = element.dataset.shortcut || element.getAttribute('aria-keyshortcuts') || '';
    node.textContent = text;
    if (shortcut) {
      const kbd = document.createElement('kbd');
      kbd.textContent = shortcut;
      node.append(kbd);
    }
    target = element;
    if (!element.hasAttribute('aria-describedby') && !element.getAttribute('aria-label')) {
      element.setAttribute('aria-describedby', 'xvTip');
      element.dataset.xvDescribed = '1';
    }
    place(element);
    node.toggleAttribute('data-show', true);
  }
  function restore(element) {
    if (!element) return;
    if (element.dataset.xvTitle) {
      element.setAttribute('title', element.dataset.xvTitle);
      delete element.dataset.xvTitle;
    }
    if (element.dataset.xvDescribed) {
      element.removeAttribute('aria-describedby');
      delete element.dataset.xvDescribed;
    }
  }
  function hide() {
    clearTimeout(timer);
    if (target) lastHide = performance.now();
    restore(target);
    target = null;
    tip?.removeAttribute('data-show');
  }
  function schedule(element) {
    clearTimeout(timer);
    if (element === target) return;
    const warm = performance.now() - lastHide < WARM || (target && tip?.hasAttribute('data-show'));
    if (target) {
      restore(target);
      target = null;
    }
    timer = setTimeout(() => show(element), warm || calm() ? 40 : DELAY);
  }
  function install() {
    document.addEventListener(
      'pointerover',
      event => {
        if (event.pointerType === 'touch') return;
        const element = candidate(event.target);
        if (element) schedule(element);
        else if (target && !target.contains(event.target)) hide();
      },
      true
    );
    document.addEventListener(
      'pointerout',
      event => {
        if (target && (!event.relatedTarget || !target.contains(event.relatedTarget))) hide();
        else if (!target) clearTimeout(timer);
      },
      true
    );
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('scroll', hide, true);
    addEventListener('blur', hide);
    document.addEventListener(
      'keydown',
      event => {
        if (event.key === 'Escape' && target) hide();
      },
      true
    );
    document.addEventListener('focusin', event => {
      const element = candidate(event.target);
      if (element && element === event.target && element.matches(':focus-visible')) schedule(element);
    });
    document.addEventListener('focusout', () => target && hide());
    nameIconButtons(document);
    let queued = new Set(),
      scheduled = false;
    new MutationObserver(records => {
      for (const record of records)
        for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) queued.add(node);
      if (scheduled || !queued.size) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const nodes = [...queued];
        queued = new Set();
        for (const node of nodes) if (node.isConnected) nameIconButtons(node);
        if (target && !target.isConnected) hide();
      });
    }).observe(document.body, { childList: true, subtree: true });
  }
  // Icon-only buttons need a name; borrow it from the tooltip text the author already wrote.
  function nameIconButtons(root) {
    const list = root.matches?.('button')
      ? [root]
      : root.querySelectorAll?.('button:not([aria-label]):not([aria-labelledby])') || [];
    for (const button of list) {
      if (button.hasAttribute('aria-label') || button.hasAttribute('aria-labelledby')) continue;
      const text = button.dataset.tip || button.getAttribute('title');
      if (!text || button.textContent.trim()) continue;
      button.setAttribute('aria-label', text);
    }
  }

  /** Loading → success/error feedback for an async action. Returns the work's result (or rethrows). */
  async function busy(button, work, { success = 1400, error = 1800 } = {}) {
    if (!button) return typeof work === 'function' ? work() : work;
    clearTimeout(button._xvStateTimer);
    button.setAttribute('aria-busy', 'true');
    button.removeAttribute('data-state');
    try {
      const result = await (typeof work === 'function' ? work() : work);
      button.removeAttribute('aria-busy');
      if (result && result.ok === false) throw new Error(result.error || 'failed');
      button.dataset.state = 'success';
      button._xvStateTimer = setTimeout(() => button.removeAttribute('data-state'), success);
      return result;
    } catch (failure) {
      button.removeAttribute('aria-busy');
      button.dataset.state = 'error';
      button._xvStateTimer = setTimeout(() => button.removeAttribute('data-state'), error);
      throw failure;
    }
  }

  window.XVaultUI = Object.freeze({ busy, hideTip: hide, showTip: show });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
