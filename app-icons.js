/* XVault icons: one Lucide stroke family (xv-icon-set.js, vendored by scripts/vendor-icons.mjs) for every surface.
   XVaultIcons.svg(name) returns inline SVG; buttons matched by ENTRIES are decorated as they appear. No remote assets. */
(() => {
  const set = globalThis.XVaultIconSet || {};
  const FALLBACK = '<path d="M6 3h9l4 4v14H6z"/>';
  const has = name => Object.prototype.hasOwnProperty.call(set, name);
  function svg(name, { size, label, className = '' } = {}) {
    const body = has(name) ? set[name] : set.file || FALLBACK;
    const dims = size ? ` width="${size}" height="${size}"` : '';
    const a11y = label ? ` role="img" aria-label="${String(label).replace(/"/g, '&quot;')}"` : ' aria-hidden="true"';
    return `<svg class="xv-icon${className ? ` ${className}` : ''}" data-icon="${name}" viewBox="0 0 24 24"${dims}${a11y} fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  }
  function element(name, options) {
    const template = document.createElement('template');
    template.innerHTML = svg(name, options);
    return template.content.firstElementChild;
  }
  window.XVaultIcons = { svg, element, has, names: () => Object.keys(set) };

  // selector -> icon. Order matters: the first match wins.
  const ENTRIES = [
    ['#refresh,#load', 'refresh'],
    [
      '#clearSearch,#lbClose,#drawerClose,#notifClose,#libraryExportClose,[data-bulk-close],[data-preview="close"],#libraryClearSelection',
      'close',
    ],
    ['#lbPrev,[data-preview="previous"]', 'previous'],
    ['#lbNext,[data-preview="next"]', 'next'],
    [
      '[data-download-post],[data-dl-one],#libraryBulkDownload,#libraryDownloadAll,#lbDownload,#lbDownloadPost',
      'download',
    ],
    ['[data-copy],#dCopy,#lbCopyLink,#libraryBulkCopy,[data-preview="copy"]', 'link'],
    ['#dCopyImg,#lbCopyImage', 'copy'],
    ['#dOriginal', 'image'],
    ['#dRepair', 'repair'],
    ['[data-open],#dOpen,#lbOpenX', 'external'],
    ['[data-fav],#dFav,#libraryBulkFav', 'favorite'],
    ['#libraryBulkReviewed', 'listChecks'],
    ['[data-addtag],#libraryBulkTag', 'tag'],
    ['#libraryBulkTrash,#browseTrash,#libraryBrowseTrash', 'trash'],
    ['#libraryUndoTrash,#xvTrashRestore', 'undo'],
    ['#libraryBulkExport,#libraryExportLinks', 'file'],
    ['#shuffleLibrary', 'shuffle'],
    ['#surpriseMe', 'sparkle'],
    ['#recoverNoteDrafts', 'note'],
    ['#integrityQuick', 'integrity'],
    ['#manifestQuick', 'listChecks'],
    ['#csv,#exportMarkdown,#exportHtml,#exportThreadsMarkdown,#exportThreadsHtml', 'file'],
    ['#remoteQuick', 'remote'],
    ['#clearLibrary', 'trash'],
    ['[data-record-preview],[data-quicklook]', 'quicklook'],
    ['[data-details]', 'inspector'],
    ['[data-layout="timeline"]', 'layoutTimeline'],
    ['[data-layout="cards"]', 'layoutCards'],
    ['[data-layout="gallery"]', 'layoutGrid'],
    ['[data-layout="masonry"]', 'layoutMasonry'],
    ['[data-layout="compact"]', 'layoutCompact'],
    ['[data-layout="table"]', 'layoutTable'],
    ['#xvImageSearch', 'imageSearch'],
    ['#libraryTools > summary,.bar-more > summary', 'more'],
    ['#libraryReview', 'inbox'],
    ['[data-player="pip"]', 'pip'],
    ['#cmdBtn', 'search'],
    ['#openX', 'external'],
    ['#export', 'export'],
    ['[data-review="keep"]', 'check'],
    ['[data-review="favorite"]', 'favorite'],
    ['[data-review="trash"]', 'trash'],
    ['[data-preview="inspect"]', 'inspector'],
    ['[data-xv-icon]', null],
  ];
  const COMBINED = ENTRIES.map(([selector]) => selector).join(',') + ',.metricBar:not([data-icons-ready])';
  const METRICS = [
    ['heart', 'Likes'],
    ['repost', 'Reposts'],
    ['reply', 'Replies'],
    ['eye', 'Views'],
    ['bookmark', 'Bookmarks'],
  ];
  const GLYPHS = /^\s*[★☆↓↻×‹›+↗⤓⤮⤨←→⋯…?]\s*/;
  function decorate(element) {
    if (element.classList.contains('metricBar')) {
      if (element.dataset.iconsReady) return;
      METRICS.forEach(([name, label], index) => {
        const cell = element.children[index],
          count = cell?.querySelector('b');
        if (!count) return;
        cell.setAttribute('aria-label', `${label}: ${count.textContent}`);
        cell.replaceChildren();
        cell.insertAdjacentHTML('afterbegin', svg(name));
        cell.append(count);
      });
      element.dataset.iconsReady = '1';
      return;
    }
    if (element.querySelector(':scope > svg.xv-icon')) return;
    const match = ENTRIES.find(([selector]) => element.matches(selector));
    if (!match) return;
    const name = match[1] || element.dataset.xvIcon;
    if (!name) return;
    for (const node of element.childNodes)
      if (node.nodeType === Node.TEXT_NODE) node.textContent = node.textContent.replace(GLYPHS, '');
    element.insertAdjacentHTML('afterbegin', svg(name));
    element.classList.add('xv-action-icon');
  }
  // Only the subtree that changed is scanned; a full-document sweep on every mutation was a measurable cost.
  function actions(root = document) {
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE && root.matches(COMBINED)) decorate(root);
    for (const element of root.querySelectorAll(COMBINED)) decorate(element);
  }
  function install() {
    const nav = document.querySelector('.rail nav');
    function update() {
      for (const button of document.querySelectorAll('.rail button.nav[data-page]:not([data-xv-icon-ready])')) {
        const name = button.dataset.page;
        if (!has(name)) continue;
        const label = button.querySelector('span')?.textContent?.trim();
        if (label) button.setAttribute('aria-label', label);
        for (const node of [...button.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
        button.prepend(element(name));
        button.dataset.xvIconReady = '1';
      }
    }
    if (nav) {
      update();
      new MutationObserver(update).observe(nav, { childList: true });
    }
    const brand = document.querySelector('.brand > span');
    if (brand) {
      brand.replaceChildren();
      brand.insertAdjacentHTML('afterbegin', '<img src="icons/xvault-mark.svg" alt="" width="34" height="34">');
    }
    for (const [selector, label] of [
      ['#cmdBtn', 'Open Command Center'],
      ['#refresh', 'Refresh Dashboard'],
      ['#clearSearch', 'Clear Library Search'],
      ['#lbClose', 'Close Viewer'],
      ['#lbPrev', 'Previous Media'],
      ['#lbNext', 'Next Media'],
      ['#drawerClose', 'Close Inspector'],
    ])
      document.querySelector(selector)?.setAttribute('aria-label', label);
    actions();
    let queued = new Set(),
      scheduled = false;
    new MutationObserver(records => {
      for (const record of records)
        for (const node of record.addedNodes)
          // Library 5.0 cards and windowed rows carry their icons inline; scanning every mounted block is waste.
          if (
            node.nodeType === Node.ELEMENT_NODE &&
            !(node.classList.contains('tweet') && node.parentElement?.id === 'list')
          )
            queued.add(node);
      if (scheduled || !queued.size) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        const nodes = [...queued];
        queued = new Set();
        for (const node of nodes) if (node.isConnected) actions(node);
      });
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
