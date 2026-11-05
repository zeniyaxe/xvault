// Per-browser manifest transforms for scripts/build.mjs (XVault 20).
// Chrome is the reference build. Edge runs the same Chromium MV3 code; only the store listing differs.
// Firefox support is BETA (XVault 22: exercised in a real headless Firefox by scripts/e2e-firefox.py in CI).
// Firefox MV3 has no extension service workers (background scripts run as an event page), no chrome.offscreen (since XVault 21 local OCR runs inside the event page, which has a
// DOM — sw/ocr.mjs createInlineHost), no chrome.sidePanel (sidebar_action is
// used instead) and no "power" permission. Native Messaging works (Remote's host manifest lists the add-on
// ID under allowed_extensions), and the helper pairs with the moz-extension:// UUID (XVault 23). Capture, Library, search, downloads and exports are expected
// to work; every Firefox-only gap is listed in the build output.
export const TARGETS = {
  chrome: { suffix: '' },
  edge: { suffix: '-edge' },
  firefox: { suffix: '-firefox' },
};
// nativeMessaging stays (XVault 23): Firefox supports it; setup_remote registers the host for the add-on ID.
const FIREFOX_UNSUPPORTED = ['offscreen', 'sidePanel', 'power'];

export function manifestFor(base, target) {
  const manifest = structuredClone(base),
    notes = [];
  if (target === 'chrome') return { manifest, notes };
  if (target === 'edge') {
    manifest.minimum_chrome_version = base.minimum_chrome_version;
    notes.push('Chromium build; publish through Microsoft Partner Center (Edge Add-ons).');
    return { manifest, notes };
  }
  if (target !== 'firefox') throw Error(`Unknown target ${target}`);
  delete manifest.minimum_chrome_version;
  manifest.background = { scripts: [base.background.service_worker], type: 'module' };
  manifest.permissions = base.permissions.filter(permission => !FIREFOX_UNSUPPORTED.includes(permission));
  notes.push(
    `removed permissions not available in Firefox: ${FIREFOX_UNSUPPORTED.filter(p => base.permissions.includes(p)).join(', ')}`
  );
  manifest.host_permissions = base.host_permissions.filter(host => !host.startsWith('file:'));
  notes.push('removed file:/// host access (Firefox does not grant it to extensions)');
  if (base.side_panel?.default_path) {
    manifest.sidebar_action = {
      default_panel: base.side_panel.default_path,
      default_title: 'XVault',
      default_icon: base.action?.default_icon,
    };
    delete manifest.side_panel;
    notes.push('side panel → sidebar_action');
  }
  manifest.browser_specific_settings = {
    gecko: {
      id: 'xvault@zeniyaxe.github.io',
      strict_min_version: '128.0',
      // XVault is local-first: nothing is collected or transmitted to the developer (AMO data consent).
      data_collection_permissions: { required: ['none'] },
    },
  };
  notes.push('background service worker → event page; local OCR runs in the event page (no offscreen document)');
  return { manifest, notes };
}
