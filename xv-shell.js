/* Shell behavior: grouped section tabs, collapsible navigation, go-to shortcuts and the shortcut sheet. */
(() => {
  const GROUPS = [
    { pages: ['home', 'archive', 'sessions'], labels: { home: 'Overview', archive: 'New archive', sessions: 'Runs' } },
    { pages: ['health', 'integrity', 'activity'], labels: { health: 'Health', integrity: 'Integrity', activity: 'Activity' } }
  ];
  const basePage = page;
  const $ = selector => document.querySelector(selector);

  function renderSubnav(name) {
    const nav = $('#subnav');
    if (!nav) return;
    const group = GROUPS.find(entry => entry.pages.includes(name));
    if (!group) { nav.replaceChildren(); return; }
    const existing = [...nav.children].map(button => button.dataset.subpage).join();
    if (existing !== group.pages.join()) {
      nav.replaceChildren(...group.pages.map(target => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.subpage = target;
        button.textContent = group.labels[target];
        button.onclick = () => page(target);
        return button;
      }));
    }
    for (const button of nav.children) {
      if (button.dataset.subpage === name) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  }

  page = function (name) {
    const previous=document.querySelector('.page.show')?.id;
    const result = basePage(name);
    const shown = document.querySelector('.page.show')?.id?.replace('page-', '') || name;
    renderSubnav(shown);
    document.title = `${$('#title')?.textContent || 'XVault'} · XVault`;
    if(previous&&previous!==`page-${shown}`){const order=['library','explorer','home','archive','sessions','media','studio','health','integrity','activity','settings'],direction=order.indexOf(shown)>=order.indexOf(previous.replace('page-',''))?1:-1;window.XVaultMotion?.play($(`#page-${shown}`),[{opacity:.45,transform:`translateX(${direction*10}px)`},{opacity:1,transform:'none'}],170)}
    return result;
  };

  function setNav(mode, persist = true) {
    document.body.dataset.nav = mode;
    const button = $('#railCollapse');
    if (button) {
      button.setAttribute('aria-pressed', String(mode === 'compact'));
      button.setAttribute('aria-label', mode === 'compact' ? 'Expand navigation' : 'Collapse navigation');
    }
    if (persist) try { localStorage.setItem('xv-nav', mode); } catch {}
  }

  function shortcutSheet() {
    let dialog = $('#xvShortcuts');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'xvShortcuts';
      dialog.className = 'xv-sheet';
      dialog.setAttribute('aria-labelledby', 'xvShortcutsTitle');
      dialog.innerHTML = `<header><h2 id="xvShortcutsTitle">Keyboard shortcuts</h2><button type="button" class="quiet" data-close aria-label="Close shortcuts">✕</button></header>
<div class="xv-sheet-cols">
<section><h3>Anywhere</h3><dl>
<dt><kbd>Ctrl</kbd> <kbd>K</kbd></dt><dd>Command center</dd>
<dt><kbd>g</kbd> then <kbd>l</kbd></dt><dd>Library</dd>
<dt><kbd>g</kbd> then <kbd>e</kbd></dt><dd>Explore</dd>
<dt><kbd>g</kbd> then <kbd>c</kbd></dt><dd>Capture</dd>
<dt><kbd>g</kbd> then <kbd>d</kbd></dt><dd>Downloads</dd>
<dt><kbd>g</kbd> then <kbd>s</kbd></dt><dd>Settings</dd>
<dt><kbd>[</kbd></dt><dd>Collapse or expand navigation</dd>
<dt><kbd>?</kbd></dt><dd>This sheet</dd>
</dl></section>
<section><h3>Library</h3><dl>
<dt><kbd>/</kbd></dt><dd>Search</dd>
<dt><kbd>j</kbd> <kbd>k</kbd> or arrows</dt><dd>Move between posts</dd>
<dt><kbd>Space</kbd></dt><dd>Quick Look</dd>
<dt><kbd>Enter</kbd></dt><dd>Open viewer or inspector</dd>
<dt><kbd>x</kbd></dt><dd>Select the focused post</dd>
<dt><kbd>f</kbd></dt><dd>Favorite</dd>
<dt><kbd>Ctrl</kbd> <kbd>A</kbd></dt><dd>Select all results</dd>
</dl></section>
<section><h3>Quick Look and review</h3><dl>
<dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Previous or next</dd>
<dt><kbd>r</kbd></dt><dd>Mark reviewed and advance</dd>
<dt><kbd>f</kbd></dt><dd>Favorite</dd>
<dt><kbd>Delete</kbd></dt><dd>Move to Trash (Undo stays available)</dd>
<dt><kbd>Esc</kbd></dt><dd>Close</dd>
</dl></section>
</div>`;
      document.body.append(dialog);
      dialog.addEventListener('click', event => { if (event.target === dialog || event.target.closest('[data-close]')) dialog.close(); });
    }
    if (!dialog.open) dialog.showModal();
  }
  window.XVaultShortcuts = shortcutSheet;

  let chord = 0;
  const targets = { l: 'library', e: 'explorer', c: 'home', d: 'media', t: 'studio', y: 'health', s: 'settings' };
  function keys(event) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest('input,textarea,select,[contenteditable],video')) return;
    if (document.querySelector('dialog[open]') || !$('#lightbox')?.classList.contains('hidden') || !$('#palette')?.classList.contains('hidden')) return;
    if (event.key === '?') { event.preventDefault(); shortcutSheet(); return; }
    if (event.key === '[') { event.preventDefault(); setNav(document.body.dataset.nav === 'compact' ? 'wide' : 'compact'); return; }
    if (chord && Date.now() < chord && targets[event.key]) {
      event.preventDefault();
      chord = 0;
      page(targets[event.key]);
      return;
    }
    chord = event.key === 'g' ? Date.now() + 1100 : 0;
  }

  // Range inputs show their fill with a custom property the track gradient reads.
  function paintRange(input) {
    const min = Number(input.min || 0), max = Number(input.max || 100), value = Number(input.value || 0);
    input.style.setProperty('--fill', `${max > min ? Math.max(0, Math.min(100, (value - min) / (max - min) * 100)) : 0}%`);
  }
  function paintRanges(root = document) { for (const input of root.querySelectorAll('input[type=range]')) paintRange(input); }
  window.XVaultPaintRanges = paintRanges;
  const baseSync = sync;
  sync = function () { const result = baseSync(); paintRanges(); return result; };

  function mount() {
    paintRanges();
    document.addEventListener('input', event => { if (event.target?.type === 'range') paintRange(event.target); }, true);
    let saved = 'wide';
    try { saved = localStorage.getItem('xv-nav') || 'wide'; } catch {}
    setNav(saved === 'compact' ? 'compact' : 'wide', false);
    $('#railCollapse')?.addEventListener('click', () => setNav(document.body.dataset.nav === 'compact' ? 'wide' : 'compact'));
    document.addEventListener('keydown', keys);
    // Menus built on <details> dismiss on outside press, Escape and after an action.
    document.addEventListener('pointerdown', event => {
      for (const menu of document.querySelectorAll('details.menu[open]')) if (!menu.contains(event.target)) menu.open = false;
    }, true);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const menu = [...document.querySelectorAll('details.menu[open]')].find(item => item.contains(document.activeElement));
      if (!menu) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }, true);
    document.addEventListener('click', event => {
      const action = event.target.closest('.menu-pop button');
      if (action) action.closest('details.menu')?.removeAttribute('open');
    });
    renderSubnav(document.querySelector('.page.show')?.id?.replace('page-', '') || '');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
