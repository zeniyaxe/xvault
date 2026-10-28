/* Optional presentation-only cleanup. No data is removed and rules fail closed. */
(() => {
  let settings = {},
    queued = false;
  const hidden = 'data-xvault-clean-hidden';
  const apply = () => {
    document.querySelectorAll(`[${hidden}]`).forEach(n => {
      n.style.removeProperty('display');
      n.removeAttribute(hidden);
    });
    if (!settings.xIntegrationEnabled || !settings.xCleanupEnabled) return;
    const hide = (selector, match) =>
      document.querySelectorAll(selector).forEach(node => {
        try {
          if (!match || match(node)) {
            node.style.setProperty('display', 'none', 'important');
            node.setAttribute(hidden, '');
          }
        } catch {}
      });
    if (settings.xHidePromoted)
      hide('[data-testid="placementTracking"]', n =>
        /promoted/i.test(n.innerText || n.getAttribute('aria-label') || '')
      );
    if (settings.xHideTrends)
      hide('aside [aria-label*="Timeline" i],aside [aria-label*="Trending" i]', n =>
        /trend/i.test(n.innerText || n.getAttribute('aria-label') || '')
      );
    if (settings.xHideWhoToFollow) hide('aside [aria-label*="Who to follow" i]');
    if (settings.xHideGrok) hide('a[href*="grok" i],nav a[aria-label*="Grok" i]');
    if (settings.xHidePremium)
      hide('[data-testid="placementTracking"]', n => /premium|subscribe/i.test(n.innerText || ''));
    document.documentElement.classList.toggle('xvault-compact-posts', !!settings.xCompactPosts);
  };
  const refresh = () =>
    chrome.runtime
      .sendMessage({ type: 'GET_SETTINGS' })
      .then(r => {
        settings = r?.settings || {};
        apply();
      })
      .catch(() => {});
  refresh();
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      apply();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  chrome.runtime.onMessage.addListener(m => {
    if (m.type === 'XV_SETTINGS_CHANGED') {
      settings = m.settings;
      apply();
    }
  });
})();
