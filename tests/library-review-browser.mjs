// Usage: node tests/library-review-browser.mjs [playwright package path] [Chromium executable] [artifact directory]
// Needs the repository served at http://127.0.0.1:8765 (python tools/dev-server.py). Synthetic data only.
// Covers the redesigned Library: layouts, faceted filters, Inbox review in Quick Look, menus, and settings search.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require(process.argv[2] || 'playwright');
const output = process.argv[4];
const browser = await pw.chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto('http://127.0.0.1:8765/tests/dashboard-harness.html?records=240&demo=1');
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('#libraryView'));
  const frame = page.frames().find(item => item !== page.mainFrame());
  await frame.waitForFunction(() => { const state = window.XVaultLibraryQueryState?.(); return state?.rows === 50 && state.loadedFor === state.queryKeyNow && !state.busy; });
  assert.equal(await frame.evaluate(() => window.XVaultLibraryRows().length),50,'Library startup should retain one bounded page');
  assert.equal(await frame.evaluate(() => document.querySelector('.page.show').id), 'page-library', 'Library is the landing page');

  // Layouts take effect immediately and tiles never overlap (regression: rows once shared the scroller height).
  for (const layout of ['gallery', 'masonry', 'cards', 'compact', 'timeline']) {
    await frame.locator(`[data-layout="${layout}"]`).click();
    await frame.waitForFunction(view => document.querySelector('#list').dataset.view === view, layout);
    assert.equal(await frame.locator(`[data-layout="${layout}"]`).getAttribute('aria-checked'), 'true');
    if (layout === 'compact' || layout === 'timeline') continue;
    await frame.waitForTimeout(250);
    const rects = await frame.locator('#list .tweet').evaluateAll(tiles => tiles.slice(0, 18).map(tile => { const box = tile.getBoundingClientRect(); return [box.left, box.top, box.right, box.bottom]; }));
    assert.ok(rects.every(([left, top, right, bottom]) => right - left > 100 && bottom - top > 60), `${layout}: tiles must have real size`);
    for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) {
      const overlap = Math.min(rects[a][2], rects[b][2]) - Math.max(rects[a][0], rects[b][0]) > 4 && Math.min(rects[a][3], rects[b][3]) - Math.max(rects[a][1], rects[b][1]) > 4;
      assert.equal(overlap, false, `${layout}: tiles ${a} and ${b} overlap`);
    }
  }
  console.log('PASS five layouts apply immediately; grid and wall tiles do not overlap');

  // Faceted filters add and remove tokens instead of replacing the query.
  await frame.locator('[data-layout="gallery"]').click();
  await frame.locator('#libraryChips [data-filter="has:video"]').click();
  assert.equal(await frame.locator('#search').inputValue(), 'has:video');
  const author = frame.locator('#facetAuthors .facet-item').first();
  const token = await author.getAttribute('data-token');
  await author.click();
  assert.equal(await frame.locator('#search').inputValue(), `has:video ${token}`);
  await frame.locator('#libraryChips [data-filter="has:gif"]').click();
  assert.equal(await frame.locator('#search').inputValue(), `${token} has:gif`, 'has: filters replace each other and keep other tokens');
  await author.click();
  assert.equal(await frame.locator('#search').inputValue(), 'has:gif', 'clicking an active facet removes only its token');
  await frame.locator('#libraryChips [data-filter=""]').click();
  assert.equal(await frame.locator('#search').inputValue(), '');
  console.log('PASS chips and facets combine and toggle query tokens');

  // Inbox review through Quick Look.
  const inboxCount = await frame.evaluate(() => window.XVaultLibraryRows().filter(post => XVaultLibraryModel.isInbox(post, settings.inboxSince)).length);
  assert.ok(inboxCount > 3, 'the fixture has unreviewed posts');
  assert.equal(Number((await frame.locator('[data-destination="inbox"] .count').innerText()).replace(/\D/g, '')), inboxCount);
  await frame.locator('[data-destination="inbox"]').click();
  await frame.waitForFunction(count => document.querySelector('#libShown').textContent.includes(String(count)) && !document.querySelector('#list').hasAttribute('aria-busy'), inboxCount);
  await frame.locator('#libraryReview').click();
  await frame.locator('#xvQuickLook[open]').waitFor();
  const firstId = await frame.evaluate(() => document.querySelector('#xvQuickLook .xv-preview-title h2').textContent);
  await page.keyboard.press('r');
  await frame.waitForFunction(() => /^2 of/.test(document.querySelector('.xv-preview-position').textContent.replace(/\s+/g, ' ').trim().replace(' of', ' of')) || document.querySelector('.xv-preview-position').textContent.trim().startsWith('2'));
  assert.equal(await frame.evaluate(() => window.XVaultLibraryRows().filter(post => XVaultLibraryModel.isInbox(post, settings.inboxSince)).length), inboxCount - 1, 'R marks the post reviewed');
  await page.keyboard.press('f');
  await frame.waitForFunction(() => document.querySelector('[data-review="favorite"]').getAttribute('aria-pressed') === 'true');
  const trashedId = await frame.evaluate(() => window.XVaultLibraryRows().find(post => post.userMeta?.favorite && !post.userMeta?.reviewedAt && XVaultLibraryModel.isInbox(post, settings.inboxSince)).id);
  await page.keyboard.press('Delete');
  await frame.waitForFunction(id => !window.XVaultLibraryRows().some(post => String(post.id) === String(id)), trashedId);
  assert.equal(await frame.locator('#libraryUndoTrash').isVisible(), true, 'Trash from Quick Look stays undoable');
  await page.keyboard.press('Escape');
  await frame.waitForFunction(() => !document.querySelector('#xvQuickLook').open);
  await frame.locator('#libraryUndoTrash').click();
  await frame.waitForFunction(id => window.XVaultLibraryRows().some(post => String(post.id) === String(id)), trashedId);
  console.log(`PASS Inbox review: keep, favorite, trash and undo (${firstId})`);

  // Menus: Escape closes and returns focus; outside press closes.
  await frame.locator('#libraryTools > summary').click();
  assert.equal(await frame.locator('#libraryTools').evaluate(element => element.open), true);
  await page.keyboard.press('Escape');
  assert.equal(await frame.locator('#libraryTools').evaluate(element => element.open), false);
  assert.equal(await frame.evaluate(() => document.activeElement.parentElement.id), 'libraryTools');
  await frame.locator('#libraryTools > summary').click();
  await frame.locator('#search').click();
  assert.equal(await frame.locator('#libraryTools').evaluate(element => element.open), false, 'outside press closes menus');
  console.log('PASS menus dismiss with Escape and outside press');

  // Shortcut sheet and go-to chords.
  await frame.locator('#title').click();
  await page.keyboard.press('?');
  await frame.locator('#xvShortcuts[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.keyboard.press('g'); await page.keyboard.press('s');
  await frame.waitForFunction(() => document.querySelector('.page.show').id === 'page-settings');
  console.log('PASS shortcut sheet and g-then-key navigation');

  // Settings search works across sections at row level.
  await frame.locator('#settingsSearch').fill('volume');
  await frame.waitForFunction(() => document.body.classList.contains('settings-searching'));
  const visibleGroups = await frame.locator('#settingsContent .settinggroup:not(.search-hidden) > h3').allInnerTexts();
  assert.ok(visibleGroups.length >= 1 && visibleGroups.length < 8, `search narrows to matching groups (${visibleGroups.join(', ')})`);
  assert.ok(await frame.locator('#settingsContent .settinggroup:not(.search-hidden) .search-miss').count() > 0, 'non-matching rows inside a matching group are hidden');
  await frame.locator('#settingsSearch').fill('zzzzzz');
  await frame.waitForFunction(() => !document.querySelector('#settingsEmpty').hidden);
  await frame.locator('#settingsSearch').fill('');
  await frame.locator('#settingsSearch').press('Escape');
  console.log('PASS settings search filters rows and shows an empty state');

  // "Changed from default" shows only rows whose saved value differs from the shipped default.
  const chip = frame.locator('#settingsChanged');
  await chip.waitFor({ state: 'visible' });
  const before = Number(await frame.locator('#settingsChangedCount').innerText());
  assert.ok(before >= 1, 'the fixture has at least one non-default setting');
  await chip.click();
  assert.equal(await chip.getAttribute('aria-pressed'), 'true');
  await frame.waitForFunction(() => document.body.classList.contains('settings-changed-only'));
  const changedGroups = await frame.locator('#settingsContent .settinggroup:not(.search-hidden)').count();
  assert.ok(changedGroups >= 1 && changedGroups < 8, `the filter narrows to groups with changed settings (${changedGroups})`);
  assert.equal(await frame.locator('#settingsContent [data-setting="soundVolume"]').evaluate(element => !element.closest('.search-miss')), true, 'the changed Volume row stays visible');
  await frame.evaluate(() => save({ soundVolume: 0.7 }, false));
  await frame.waitForFunction(count => Number(document.querySelector('#settingsChangedCount').textContent) === count - 1, before);
  await chip.click();
  assert.equal(await chip.getAttribute('aria-pressed'), 'false');
  await frame.waitForFunction(() => !document.body.classList.contains('settings-changed-only'));
  console.log('PASS Changed-from-default filter counts, narrows, and clears');

  if (output) await page.screenshot({ path: `${output}/review-final.png`, animations: 'disabled' });
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
