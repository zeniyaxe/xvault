/* XVault 20 — accessibility preferences and remappable single-key shortcuts.
   Accessibility: high contrast tokens, always-on focus rings, reading-text scale and Reader text size.
   Shortcuts: every handler in the app keeps listening for its default key. This layer translates a
   remapped key into the default one (capture phase, before any other listener) and blocks the old key,
   so remapping never touches individual handlers. Overrides live in settings.shortcutOverrides. */
(() => {
  const ACTIONS = [
    { id: 'global.sheet', scope: 'global', key: '?', label: 'Show keyboard shortcuts' },
    { id: 'global.nav', scope: 'global', key: '[', label: 'Collapse or expand navigation' },
    { id: 'global.goto', scope: 'global', key: 'g', label: 'Go-to prefix (g then l, a, e…)' },
    { id: 'library.search', scope: 'library', key: '/', label: 'Focus search' },
    { id: 'library.next', scope: 'library', key: 'j', label: 'Next post' },
    { id: 'library.prev', scope: 'library', key: 'k', label: 'Previous post' },
    { id: 'library.select', scope: 'library', key: 'x', label: 'Select the focused post' },
    { id: 'library.favorite', scope: 'library', key: 'f', label: 'Favorite' },
    { id: 'library.thread', scope: 'library', key: 't', label: 'Read the thread' },
    { id: 'library.edit', scope: 'library', key: 'e', label: 'Edit tags & more' },
    { id: 'library.board', scope: 'library', key: 'b', label: 'Add to board' },
    { id: 'library.later', scope: 'library', key: 'l', label: 'Toggle Read later' },
    { id: 'review.reviewed', scope: 'review', key: 'r', label: 'Quick Look: mark reviewed and advance' },
    { id: 'review.favorite', scope: 'review', key: 'f', label: 'Quick Look: favorite' },
    { id: 'reader.later', scope: 'reader', key: 'l', label: 'Reader: Read later' },
    { id: 'reader.read', scope: 'reader', key: 'm', label: 'Reader: mark read' },
    { id: 'reader.highlight', scope: 'reader', key: 'h', label: 'Reader: highlight the selection' },
  ];
  const SCOPES = { global: 'Anywhere', library: 'Library', review: 'Quick Look', reader: 'Reader' };
  const RESERVED = new Set([
    ' ',
    'Enter',
    'Escape',
    'Tab',
    'Delete',
    'Backspace',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
  ]);
  const byId = new Map(ACTIONS.map(action => [action.id, action]));
  const synthetic = new WeakSet();
  const $ = selector => document.querySelector(selector);
  const html = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );
  const overrides = () => {
    const raw = settings?.shortcutOverrides;
    return raw && typeof raw === 'object' ? raw : {};
  };
  const keyFor = id => {
    const custom = overrides()[id];
    return typeof custom === 'string' && custom.length === 1 ? custom : byId.get(id)?.key || '';
  };
  const label = key => (key === ' ' ? 'Space' : key);

  // ── Scope detection: which handlers would receive this key right now? ──
  function activeScopes() {
    if ($('#xvReader[open]')) return ['reader'];
    if ($('#xvQuickLook[open]')) return ['review'];
    if (document.querySelector('dialog[open]')) return [];
    if (!$('#lightbox')?.classList.contains('hidden') || !$('#palette')?.classList.contains('hidden')) return [];
    return $('#page-library.show') ? ['library', 'global'] : ['global'];
  }
  function translation(scopes) {
    const map = new Map(),
      blocked = new Set();
    for (const action of ACTIONS) {
      if (!scopes.includes(action.scope)) continue;
      const key = keyFor(action.id);
      if (key && key !== action.key) {
        map.set(key, action.key);
        blocked.add(action.key);
      }
    }
    for (const key of map.keys()) blocked.delete(key);
    return { map, blocked };
  }
  function onKey(event) {
    if (synthetic.has(event) || event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
    if (event.target?.closest?.('input,textarea,select,[contenteditable],[contenteditable=""]')) return;
    if (!Object.keys(overrides()).length) return;
    const { map, blocked } = translation(activeScopes());
    const target = map.get(event.key);
    if (target) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const copy = new KeyboardEvent('keydown', {
        key: target,
        bubbles: true,
        cancelable: true,
        composed: true,
        shiftKey: target !== target.toLowerCase() || target === '?',
      });
      synthetic.add(copy);
      (event.target || document).dispatchEvent(copy);
    } else if (blocked.has(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  window.addEventListener('keydown', onKey, true);

  // ── Shortcut sheet: repaint kbd hints with the effective keys ──
  function paintSheet(root = document) {
    for (const kbd of root.querySelectorAll('kbd[data-shortcut]')) {
      const key = keyFor(kbd.dataset.shortcut);
      if (key) kbd.textContent = label(key);
    }
  }

  // ── Settings editor ──
  let capturing = '';
  function conflicts(id, key) {
    const action = byId.get(id);
    const related = action.scope === 'global' ? Object.keys(SCOPES) : [action.scope, 'global'];
    return ACTIONS.find(other => other.id !== id && related.includes(other.scope) && keyFor(other.id) === key);
  }
  function renderEditor() {
    const root = $('#xvShortcutEditor');
    if (!root) return;
    const groups = Object.entries(SCOPES)
      .map(
        ([scope, title]) =>
          `<fieldset class="xv-keys"><legend>${title}</legend>${ACTIONS.filter(action => action.scope === scope)
            .map(action => {
              const key = keyFor(action.id),
                changed = key !== action.key;
              return `<div class="xv-key-row${capturing === action.id ? ' is-capturing' : ''}"><span>${html(action.label)}</span><button type="button" class="xv-key" data-capture="${action.id}" aria-label="${html(action.label)}: ${html(label(key))}. Press to change">${capturing === action.id ? 'Press a key…' : `<kbd>${html(label(key))}</kbd>`}</button>${changed ? `<button type="button" class="quiet" data-reset-key="${action.id}" aria-label="Reset ${html(action.label)} to ${html(action.key)}">Reset</button>` : '<span></span>'}</div>`;
            })
            .join('')}</fieldset>`
      )
      .join('');
    root.innerHTML = `<h4>Keyboard shortcuts</h4><p class="settingHint">Choose a key, then press the new one. Single characters only; Esc cancels. Conflicts within the same place are refused.</p><div class="xv-keys-grid">${groups}</div><p class="xv-keys-status" role="status" aria-live="polite"></p>${Object.keys(overrides()).length ? '<button type="button" class="quiet" data-reset-all-keys>Reset all shortcuts</button>' : ''}`;
    if (capturing) root.querySelector(`[data-capture="${capturing}"]`)?.focus();
  }
  async function store(next, message) {
    await save({ shortcutOverrides: next }, false);
    capturing = '';
    renderEditor();
    const status = $('#xvShortcutEditor .xv-keys-status');
    if (status) status.textContent = message;
  }
  document.addEventListener('click', event => {
    const capture = event.target.closest('#xvShortcutEditor [data-capture]');
    if (capture) {
      capturing = capturing === capture.dataset.capture ? '' : capture.dataset.capture;
      renderEditor();
      return;
    }
    const reset = event.target.closest('#xvShortcutEditor [data-reset-key]');
    if (reset) {
      const next = { ...overrides() };
      delete next[reset.dataset.resetKey];
      store(
        next,
        `${byId.get(reset.dataset.resetKey).label} is back to ${label(byId.get(reset.dataset.resetKey).key)}`
      );
      return;
    }
    if (event.target.closest('#xvShortcutEditor [data-reset-all-keys]'))
      store({}, 'All shortcuts reset to their defaults');
  });
  document.addEventListener(
    'keydown',
    event => {
      if (!capturing || !event.target.closest?.('#xvShortcutEditor')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const status = $('#xvShortcutEditor .xv-keys-status');
      if (event.key === 'Escape') {
        capturing = '';
        renderEditor();
        return;
      }
      if (event.key.length !== 1 || RESERVED.has(event.key) || event.ctrlKey || event.metaKey || event.altKey) {
        if (status) status.textContent = 'Use a single letter, digit or symbol without Ctrl, Alt or ⌘.';
        return;
      }
      const action = byId.get(capturing),
        clash = conflicts(capturing, event.key);
      if (clash) {
        if (status)
          status.textContent = `“${label(event.key)}” already does “${clash.label}”. Pick another key or change that one first.`;
        return;
      }
      const next = { ...overrides() };
      if (event.key === action.key) delete next[action.id];
      else next[action.id] = event.key;
      store(next, `${action.label} is now ${label(event.key)}`);
    },
    true
  );

  // ── Accessibility preferences ──
  let lastReaderSize = null;
  function applyAccessibility() {
    const s = settings || {},
      body = document.body;
    if (!body) return;
    if (s.uiHighContrast) body.dataset.contrast = 'high';
    else delete body.dataset.contrast;
    body.dataset.focus = s.uiFocusRings === 'always' ? 'always' : 'auto';
    const scale = Math.min(1.5, Math.max(0.85, Number(s.uiFontScale) || 1));
    document.documentElement.style.setProperty('--xv-read-scale', String(scale));
    const readerSize = Number(s.readerFontSize) || 19;
    if (lastReaderSize !== null && readerSize !== lastReaderSize) window.XVaultReader?.setSize?.(readerSize);
    lastReaderSize = readerSize;
    const out = document.querySelector('[data-setting="uiFontScale"]')?.closest('label')?.querySelector('output');
    if (out) out.textContent = `${Math.round(scale * 100)}%`;
  }
  function mountScaleOutput() {
    const input = document.querySelector('[data-setting="uiFontScale"]');
    if (!input || input.closest('label').querySelector('output')) return;
    const out = document.createElement('output');
    out.className = 'xv-range-value';
    input.after(out);
    input.addEventListener('input', () => {
      out.textContent = `${Math.round(Number(input.value) * 100)}%`;
      document.documentElement.style.setProperty('--xv-read-scale', input.value);
    });
  }
  const hooks = window.XVaultDashboard;
  hooks?.after?.('apply', () => {
    applyAccessibility();
    renderEditor();
  });
  hooks?.after?.('sync', () => {
    applyAccessibility();
    if (!capturing) renderEditor();
  });
  hooks?.commands?.(() => [
    {
      name: 'Toggle high contrast',
      hint: 'Accessibility',
      run: () => save({ uiHighContrast: !settings?.uiHighContrast }),
    },
    {
      name: 'Remap keyboard shortcuts',
      hint: 'Settings · Accessibility',
      run: () => {
        page('settings');
        setTimeout(() => $('#g-accessibility')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
      },
    },
  ]);
  function mount() {
    mountScaleOutput();
    applyAccessibility();
    renderEditor();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  window.XVaultKeymap = { actions: ACTIONS, keyFor, paintSheet, activeScopes, translation };
})();
