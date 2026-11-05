const $ = s => document.querySelector(s),
  call = m => chrome.runtime.sendMessage(m),
  toTab = payload => call({ type: 'SEND_TO_TAB', payload });
let settings = {};
document.addEventListener('DOMContentLoaded', init);
// Lucide glyphs from the shared vendored set (xv-icon-set.js); decorative, so hidden from assistive tech.
function drawIcons() {
  const set = globalThis.XVaultIconSet || {};
  for (const node of document.querySelectorAll('[data-icon]')) {
    const body = set[node.dataset.icon];
    if (!body || node.querySelector('.sp-icon')) continue;
    const icon = document.createElement('span');
    icon.className = 'sp-icon';
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    node.prepend(icon);
  }
}
async function init() {
  drawIcons();
  try {
    const [st, s] = await Promise.all([call({ type: 'GET_SETTINGS' }), call({ type: 'STATS' })]);
    settings = st?.settings || {};
    setText('#count', new Intl.NumberFormat().format(s?.tweets || 0));
    const provider = $('#provider');
    if (provider) provider.value = settings.linkProvider || 'fixvx';
    const cap = $('#capture');
    if (cap) cap.checked = settings.captureWhileBrowsing !== false;
    const inline = $('#inline');
    if (inline) inline.checked = settings.xCopyLinkEnabled !== false && settings.instantCopyButton !== false;
  } catch (e) {
    toast(`Init error: ${e.message}`);
  }
  on('#dash', 'click', () => call({ type: 'OPEN_DASHBOARD' }));
  const grid = $('.grid');
  if (grid)
    grid.addEventListener('click', async e => {
      const b = e.target.closest('button[data-action]');
      if (!b) return;
      const a = b.dataset.action;
      if (a === 'copy') await toTab({ type: 'XV_COPY_CENTERED' });
      if (a === 'download') await toTab({ type: 'XV_DOWNLOAD_CENTERED' });
      if (a === 'archive') await toTab({ type: 'XV_ARCHIVE_CENTERED' });
      if (a === 'timeline') {
        toast('Timeline archive started');
        await toTab({ type: 'XV_SCROLL_START' });
      } else toast(`${a} action sent`);
    });
  on('#provider', 'change', e => save({ linkProvider: e.target.value }));
  on('#capture', 'change', e => save({ captureWhileBrowsing: e.target.checked }));
  on('#inline', 'change', e => save({ instantCopyButton: e.target.checked, xCopyLinkEnabled: e.target.checked }));
}
function on(sel, event, fn) {
  const e = $(sel);
  if (e) e.addEventListener(event, fn);
}
function setText(sel, t) {
  const e = $(sel);
  if (e) e.textContent = t;
}
async function save(p) {
  await call({ type: 'SET_SETTINGS', settings: p });
  await toTab({ type: 'XV_REFRESH_INSTANT_SETTINGS' }).catch(() => {});
  toast('Saved');
}
function toast(t) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = t;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1600);
}
