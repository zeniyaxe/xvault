/* One local stroke system for primary navigation. No remote font or script. */
(() => {
  const shapes = {
    home: '<path d="M4 7h16v13H4zM3 4h18v3H3z"/><circle cx="17" cy="17" r="3"/><path d="m15.7 17 1 1 1.8-2"/>',
    archive:
      '<path d="M4 6h16l-1 4H5z"/><path d="M6 10v9a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19v-9"/><path d="M9 14h6"/>',
    library:
      '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M17 13.5 20.5 17 17 20.5 13.5 17z"/>',
    explore:
      '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l-3 2"/><path d="M4 7V3h4"/><path d="M4.8 5.2A9.5 9.5 0 0 1 20 8"/>',
    media: '<path d="M5 6h9M5 11h9M5 16h6"/><path d="M18 5v11m0 0-3-3m3 3 3-3"/>',
    health: '<path d="M4 4h16v16H4z"/><path d="M7 15l3-3 2 2 5-6"/><circle cx="17" cy="8" r="1"/>',
    integrity:
      '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="m5 16 4-4 3 3 2-2 5 4"/><path d="m9 5 2 3-2 2 3 2"/>',
    sessions: '<path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/><path d="m16 15 3 2-3 2z"/>',
    activity:
      '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M7 8h10M7 12h7M7 16h5"/><circle cx="17" cy="16" r="2"/>',
    studio: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M9 10h12"/>',
    settings:
      '<circle cx="12" cy="12" r="8"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="8" cy="14" r="1"/><path d="M12 20c-1.5-2 0-4 2-4h2"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    previous: '<path d="m15 5-7 7 7 7"/>',
    next: '<path d="m9 5 7 7-7 7"/>',
    download: '<path d="M12 3v12m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
    external: '<rect x="4" y="5" width="13" height="14" rx="2"/><path d="M13 3h8v8M21 3l-9 9"/>',
    favorite: '<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z"/>',
    tag: '<path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8" cy="8" r="1"/>',
    heart:
      '<path d="M20.8 4.6a5.3 5.3 0 0 0-7.5 0L12 5.9l-1.3-1.3a5.3 5.3 0 0 0-7.5 7.5L12 21l8.8-8.9a5.3 5.3 0 0 0 0-7.5z"/>',
    repost: '<path d="m7 7 3-3 3 3M10 4v11a3 3 0 0 0 3 3h5"/><path d="m17 17 3 3 3-3" transform="translate(-2 -2)"/>',
    reply: '<path d="M8 7 4 11l4 4"/><path d="M5 11h8a6 6 0 0 1 6 6v2"/><circle cx="17" cy="6" r="2"/>',
    eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
    refresh: '<path d="M20 7v5h-5M4 17v-5h5M20 12a8 8 0 0 0-14-5M4 12a8 8 0 0 0 14 5"/>',
    undo: '<path d="M18 8a7 7 0 1 0 1 6"/><path d="M18 4v4h-4"/><path d="M12 8v4l2 2"/>',
    trash:
      '<path d="M7 7h10l-1 13H8zM5 7h14M9 4h6"/><path d="M11 12a3.5 3.5 0 1 1 1 5"/><path d="m9.5 13.5 1.5-1.5 1.5 1.5"/>',
    explorer:
      '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l-3 2"/><path d="M4 7V3h4"/><path d="M4.8 5.2A9.5 9.5 0 0 1 20 8"/>',
    layoutGrid: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
    layoutMasonry: '<path d="M4 4h7v10H4zM13 4h7v6h-7zM4 16h7v4H4zM13 12h7v8h-7z"/>',
    layoutTimeline:
      '<path d="M7 3v18"/><circle cx="7" cy="7" r="2"/><circle cx="7" cy="14" r="2"/><path d="M10 7h10M10 14h7"/>',
    layoutCompact: '<path d="M4 5h16M4 9h16M4 13h16M4 17h16"/><path d="M4 21h10"/>',
    layoutCards:
      '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/>',
    density: '<path d="M4 6h16M4 12h16M4 18h16"/><path d="M7 4v4M12 10v4M17 16v4"/>',
    keyboard:
      '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M6 10h2M10 10h2M14 10h2M18 10h1M6 14h3M11 14h7"/>',
    inbox: '<path d="M4 14 6.5 5h11L20 14v5H4z"/><path d="M4 14h4.5l1 2.5h5l1-2.5H20"/>',
    note: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/><path d="M17 17l3 3"/>',
    quicklook:
      '<path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5z"/><circle cx="12" cy="12" r="2.5"/><path d="M4 5V3h2M18 3h2v2M20 19v2h-2M6 21H4v-2"/>',
    more: '<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>',
    play: '<path d="M8 5.5v13l11-6.5z"/>',
    check: '<circle cx="12" cy="12" r="8"/><path d="m8 12 2.5 2.5L16 9"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    inspector: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="m11 10 3 2-3 2"/>',
    collapse: '<path d="m14 7-5 5 5 5"/><path d="M19 5v14"/>',
    missing:
      '<rect x="4" y="5" width="16" height="14" rx="2" stroke-dasharray="2 2"/><path d="M9 10a3 3 0 0 1 6 0c0 2-3 2-3 4M12 17h.01"/>',
    saved: '<circle cx="10" cy="10" r="5"/><path d="m14 14 5 5"/><path d="M17 4v6l2-1 2 1V4z"/>',
    person:
      '<circle cx="9" cy="8" r="3"/><path d="M4 18c.7-3 2.4-4.5 5-4.5s4.3 1.5 5 4.5"/><rect x="15" y="4" width="6" height="6" rx="1"/><path d="M18 6v2M17 7h2"/>',
    sensitive: '<path d="M12 3 19 6v6c0 4-2.5 7-7 9-4.5-2-7-5-7-9V6z"/><path d="M8 12h8"/>',
    image:
      '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m5 17 5-5 3 3 2-2 4 4"/><path d="M12 2v3"/>',
    video: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
    gif: '<rect x="3.5" y="6" width="17" height="12" rx="2"/><path d="M9.5 10.5H8a1.5 1.5 0 0 0 0 3h1.5V12H8.7M12.5 10v4M15 14v-4h2.2M15 12h1.6"/>',
    text: '<path d="M5 6h14M5 11h14M5 16h9"/>',
    disk: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
    shield: '<path d="M12 3 19 6v5.5c0 4.2-2.7 7.4-7 9.5-4.3-2.1-7-5.3-7-9.5V6z"/>',
    export: '<path d="M12 21V9m0 0-4 4m4-4 4 4"/><path d="M5 5h14"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    repair: '<path d="M14 5a5 5 0 0 0-6.5 6.5L3 16l5 5 4.5-4.5A5 5 0 0 0 19 10l-3 3-3-3z"/>',
    bell: '<path d="M6 16h12l-2-3V9a4 4 0 0 0-8 0v4z"/><path d="M10 19h4"/>',
    color: '<path d="M12 3 5 10a5 5 0 1 0 7 7l7-7z"/><circle cx="9" cy="14" r="2"/>',
    thread:
      '<circle cx="6" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18" cy="18" r="2"/><path d="M7.5 7.5 10.5 10.5M13.5 13.5l3 3"/><path d="M12 5v3"/>',
    quote: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M7 8h4v4H7zM13 8h4v4h-4zM7 15h10"/>',
    duplicate:
      '<rect x="3" y="6" width="11" height="11" rx="2"/><rect x="10" y="3" width="11" height="11" rx="2"/><path d="M16 17a3 3 0 1 1-3 3"/><path d="M16 17v3h-3"/>',
    cleanup: '<path d="M8 5h8l1 3H7zM6 8h12l-1 12H7z"/><path d="M10 12v5M14 12v5"/><path d="M9 3h6"/>',
    remote:
      '<rect x="3" y="5" width="10" height="8" rx="1.5"/><rect x="16" y="8" width="5" height="10" rx="1"/><path d="M13 9h3M13 12h3"/><path d="m7 17 2 2 4-4"/>',
    perf: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 4-6"/><path d="M7 17h10"/>',
    motion: '<path d="M3 12h4l2-6 3 12 3-9 2 6h4"/><path d="m18 4 3 2-3 2"/>',
    tools: '<path d="M3 5h6l7 7-5 5-8-8z"/><path d="M11 7h5l5 5-5 5"/><circle cx="6" cy="8" r=".8"/>',
    pip: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="12" y="12" width="7" height="5" rx="1"/>',
    calendar:
      '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 9h18"/><path d="M7 13h2M11 13h2M15 13h2M7 17h2M11 17h2"/>',
    file: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v5h4M9 12h6M9 16h6"/>',
    shuffle: '<circle cx="10" cy="10" r="5"/><path d="m14 14 6 6"/><path d="M7 10h6M10 7v6"/>',
  };
  function svg(name) {
    return `<svg class="xv-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${shapes[name] || shapes.file}</svg>`;
  }
  window.XVaultIcons = { svg };
  const ENTRIES = [
    ['#refresh,#load', 'refresh'],
    [
      '#clearSearch,#lbClose,#drawerClose,#notifClose,#libraryExportClose,[data-bulk-close],[data-preview="close"]',
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
    ['[data-addtag],#libraryBulkTag', 'tag'],
    ['#libraryBulkTrash,#browseTrash,#libraryBrowseTrash', 'trash'],
    ['#libraryUndoTrash,#xvTrashRestore', 'undo'],
    ['#libraryBulkExport,#libraryExportLinks', 'file'],
    ['#shuffleLibrary', 'shuffle'],
    ['[data-record-preview],[data-quicklook]', 'quicklook'],
    ['[data-details]', 'inspector'],
    ['[data-layout="timeline"]', 'layoutTimeline'],
    ['[data-layout="cards"]', 'layoutCards'],
    ['[data-layout="gallery"]', 'layoutGrid'],
    ['[data-layout="masonry"]', 'layoutMasonry'],
    ['[data-layout="compact"]', 'layoutCompact'],
    ['#libraryTools > summary', 'more'],
    ['#libraryReview', 'inbox'],
    ['[data-player="pip"]', 'pip'],
    ['#cmdBtn', 'search'],
    ['#openX', 'external'],
    ['#export', 'export'],
    ['[data-review="keep"]', 'check'],
    ['[data-review="favorite"]', 'favorite'],
    ['[data-review="trash"]', 'trash'],
    ['[data-preview="inspect"]', 'inspector'],
  ];
  const COMBINED = ENTRIES.map(([selector]) => selector).join(',') + ',.metricBar:not([data-icons-ready])';
  const METRICS = [
    ['heart', 'Likes'],
    ['repost', 'Reposts'],
    ['reply', 'Replies'],
    ['eye', 'Views'],
    ['bookmark', 'Bookmarks'],
  ];
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
    for (const node of element.childNodes)
      if (node.nodeType === Node.TEXT_NODE) node.textContent = node.textContent.replace(/^\s*[★☆↓↻×‹›+↗⤓⤮⤨←→]\s*/, '');
    element.insertAdjacentHTML('afterbegin', svg(match[1]));
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
    if (!nav) return;
    function update() {
      for (const button of document.querySelectorAll('.rail button.nav[data-page]:not([data-xv-icon-ready])')) {
        const shape = shapes[button.dataset.page];
        if (!shape) continue;
        const name = button.querySelector('span')?.textContent?.trim();
        if (name) button.setAttribute('aria-label', name);
        for (const node of [...button.childNodes]) if (node.nodeType === Node.TEXT_NODE) node.remove();
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '1.7');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        icon.innerHTML = shape;
        button.prepend(icon);
        button.dataset.xvIconReady = '1';
      }
    }
    update();
    new MutationObserver(update).observe(nav, { childList: true });
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
        for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) queued.add(node);
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
