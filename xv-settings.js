/* Settings: section navigation, scroll-spy, and row-level search across every group. */
(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  let rows = [];
  let changedOnly = false;

  const norm = text =>
    String(text || '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

  // A "row" is the smallest unit a person looks for: one toggle, one field, one action button group.
  function collectRows() {
    rows = [];
    for (const group of $$('#settingsContent .settinggroup')) {
      const items = [
        ...group.querySelectorAll(
          '.toggles > label, .formgrid > .field, .swatch, .theme-card, .toolbar-choice, .workspace-row, .workspace-save, .row > button, .seg > button, .settingHint, .remote-heading, .remote-toolbar'
        ),
      ];
      rows.push({
        group,
        section: group.closest('.settings-section'),
        items: items.map(element => ({
          element,
          text: norm(
            element.textContent +
              ' ' +
              (element.getAttribute('title') || '') +
              ' ' +
              (element.querySelector('input,select')?.dataset.setting || '')
          ),
        })),
      });
    }
  }

  // A setting counts as changed when its saved value differs from the shipped default.
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function changedKeys() {
    const defaults = window.XVaultSettingDefaults,
      current = typeof settings === 'object' ? settings : null;
    if (!defaults || !current) return null;
    const keys = new Set();
    for (const element of $$('#settingsContent [data-setting]')) {
      const key = element.dataset.setting;
      if (key in defaults && !same(current[key], defaults[key])) keys.add(key);
    }
    return keys;
  }
  const isChanged = (element, keys) =>
    !keys ||
    [element, ...element.querySelectorAll('[data-setting]')].some(
      node => node.dataset?.setting && keys.has(node.dataset.setting)
    );
  function refreshChangedChip() {
    const chip = $('#settingsChanged');
    if (!chip) return;
    const keys = changedKeys();
    chip.hidden = !keys;
    if (keys) $('#settingsChangedCount').textContent = String(keys.size);
  }

  function filter(query) {
    const q = norm(query);
    const keys = changedOnly ? changedKeys() : null;
    const active = !!q || (changedOnly && !!keys);
    const sections = $$('#settingsContent .settings-section');
    if (!rows.length) collectRows();
    let any = false;
    for (const entry of rows) {
      const heading = norm(entry.group.querySelector('h3')?.textContent);
      const headingHit = q && heading.includes(q) && !keys;
      let hits = 0;
      for (const item of entry.items) {
        const textHit = !q || headingHit || item.text.includes(q);
        const hit = textHit && (!keys || isChanged(item.element, keys));
        item.element.classList.toggle('search-miss', !hit);
        if (hit && active) hits++;
      }
      const show = !active || headingHit || hits > 0;
      entry.group.classList.toggle('search-hidden', !show);
      if (show) any = true;
    }
    for (const section of sections) {
      const visible = section.querySelector('.settinggroup:not(.search-hidden)');
      section.classList.toggle('search-hidden', !visible && active);
      $(`[data-section-link="${section.dataset.section}"]`)?.classList.toggle('dim', !visible && active);
    }
    document.body.classList.toggle('settings-searching', active);
    document.body.classList.toggle('settings-changed-only', changedOnly && !!keys);
    const empty = $('#settingsEmpty');
    if (empty) {
      empty.hidden = any || !active;
      empty.textContent =
        changedOnly && keys && !q ? 'Every setting is at its default.' : 'No setting matches that search.';
    }
  }

  function mount() {
    const page = $('#page-settings');
    if (!page) return;
    $('#settingsSearch')?.addEventListener('input', event => filter(event.target.value));
    $('#settingsChanged')?.addEventListener('click', event => {
      changedOnly = !changedOnly;
      event.currentTarget.setAttribute('aria-pressed', String(changedOnly));
      refreshChangedChip();
      filter($('#settingsSearch')?.value || '');
    });
    // The count follows saves made anywhere in the app, not only on this page.
    page.addEventListener('change', () => setTimeout(refreshChangedChip, 150));
    page.addEventListener('click', () => setTimeout(refreshChangedChip, 300));
    setTimeout(refreshChangedChip, 600);
    $('#settingsSearch')?.addEventListener('keydown', event => {
      if (event.key === 'Escape' && event.target.value) {
        event.target.value = '';
        filter('');
        event.stopPropagation();
      }
    });
    $('#settingsLinks')?.addEventListener('click', event => {
      const link = event.target.closest('[data-section-link]');
      if (!link) return;
      const search = $('#settingsSearch');
      if (search?.value) {
        search.value = '';
        filter('');
      }
      const target = $(`#set-${link.dataset.sectionLink}`);
      const reduced = ['off', 'reduced'].includes(document.body.dataset.motion);
      const content = $('#settingsContent');
      if (target && content)
        content.scrollTo({
          top: target.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop,
          behavior: reduced ? 'auto' : 'smooth',
        });
    });
    // Scroll-spy: the section nearest the top of the scroller owns the nav highlight.
    const sections = $$('#settingsContent .settings-section');
    const visibleNow = new Map();
    const mark = () => {
      const top = [...visibleNow.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];
      for (const link of $$('#settingsLinks [data-section-link]'))
        link.setAttribute('aria-current', String(link.dataset.sectionLink === top?.dataset.section));
    };
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(
        entries => {
          for (const entry of entries) {
            if (entry.isIntersecting) visibleNow.set(entry.target, entry.boundingClientRect.top);
            else visibleNow.delete(entry.target);
          }
          mark();
        },
        { root: page, rootMargin: '0px 0px -62% 0px', threshold: [0, 1] }
      );
      sections.forEach(section => observer.observe(section));
      page.addEventListener(
        'scroll',
        () => {
          for (const section of visibleNow.keys()) visibleNow.set(section, section.getBoundingClientRect().top);
          mark();
        },
        { passive: true }
      );
    }
    $('#inboxReviewed')?.addEventListener('click', async () => {
      if (
        !confirm(
          'Mark every post currently in the Inbox as reviewed? Nothing is deleted or changed except the Inbox marker.'
        )
      )
        return;
      await save({ inboxSince: Date.now() }, false);
      window.XVaultLibraryRecordUpdated?.([]);
      toast('Inbox cleared. New captures will arrive here again.');
    });
    $('#inboxAll')?.addEventListener('click', async () => {
      await save({ inboxSince: 1 }, false);
      window.XVaultLibraryRecordUpdated?.([]);
      toast('Every unreviewed post is back in the Inbox.');
    });
    // Late-injected groups (X.com, Motion) join the search index when they arrive.
    new MutationObserver(() => {
      rows = [];
    }).observe($('#settingsContent'), { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
