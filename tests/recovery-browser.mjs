// Real MV3 recovery/editing workflows in a disposable profile, never personal data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright');
const artifacts = process.argv[4] || process.env.TEMP;
const profile = await fs.mkdtemp(path.join(path.resolve(process.env.TEMP), 'xvault-recovery-'));
const context = await pw.chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.argv[3],
  viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${path.resolve('.')}`, `--load-extension=${path.resolve('.')}`],
});
try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const url = `chrome-extension://${new URL(worker.url()).hostname}/dashboard.html`;
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://pbs.twimg.com/media/fixture*', route =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=',
        'base64'
      ),
    })
  );
  await page.goto(url);
  assert.match(await page.title(), /XVault/);
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({
      type: 'SET_SETTINGS',
      settings: { onboardingComplete: true, libraryView: 'compact', healthCheckOnStartup: false },
    });
    const tweets = Array.from({ length: 230 }, (_, index) => ({
      id: String(100000 + index),
      text: `Recovery evidence ${index}. Original text and provenance must survive.`,
      author: { handle: 'fieldnotes', name: 'Field Notes' },
      archivedAt: Date.now() - index,
      media: [],
      userMeta: { tags: ['reference'], note: index === 218 ? 'Older note retained in Trash' : '' },
    }));
    await chrome.runtime.sendMessage({ type: 'STORE_RECORDS', tweets, users: [] });
  });
  await page.reload();
  await page.waitForFunction(() => window.XVaultLibraryRows?.().length === 230);
  await page.evaluate(() => openDetails('100229'));
  await page.locator('#dNote').fill('Draft from the first window');
  const second = await context.newPage();
  await second.goto(url);
  const external = await second.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'UPDATE_TWEET_META',
      id: '100229',
      patch: { note: 'Saved in the other window' },
      expectedNote: '',
    })
  );
  assert.equal(external.ok, true);
  await page.bringToFront(); // Measure the user's active window, not a timer-throttled background tab.
  await page.locator('#dNoteConflict:not([hidden])').waitFor();
  assert.equal(await page.locator('#dNote').inputValue(), 'Draft from the first window');
  assert.equal(await page.locator('#dNoteCurrent').innerText(), 'Saved in the other window');
  await page.screenshot({ path: path.join(artifacts, 'note-conflict.png') });
  await page.locator('#dNoteKeepMine').click();
  await page.waitForFunction(() => document.querySelector('#dNoteState').textContent === 'Saved');
  assert.equal(
    (await second.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_LIBRARY_ROWS' }))).rows.find(
      row => row.id === '100229'
    ).userMeta.note,
    'Draft from the first window'
  );
  console.log('PASS two real extension windows: conflict comparison and explicit conditional replacement');

  // Hold the first reply while the user types a second version.
  await page.evaluate(async () => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    let held = false;
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'UPDATE_TWEET_META' && message.patch?.note && !held) {
        held = true;
        const result = await original(message);
        await new Promise(resolve => setTimeout(resolve, 500));
        return result;
      }
      return original(message);
    };
  });
  await page.locator('#dNote').fill('First in-flight version');
  await page.locator('#dNote').press('Control+Enter');
  await page.locator('#dNote').fill('Newer edit while saving');
  await page.waitForFunction(
    () =>
      document.querySelector('#dNoteState').textContent === 'Saved' &&
      window.XVaultLibraryRows().find(row => row.id === '100229').userMeta.note === 'Newer edit while saving'
  );
  assert.equal(await page.locator('#dNote').inputValue(), 'Newer edit while saving');
  console.log('PASS in-flight save cannot erase or lose a newer edit');
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = message =>
      message.type === 'UPDATE_TWEET_META' && message.patch?.note
        ? Promise.reject(Error('Simulated worker unavailable'))
        : original(message);
  });
  await page.locator('#dNote').fill('Retained after a failed save and reload');
  await page.locator('#dNote').press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#dNoteState').textContent.includes('Save failed'));
  await page.reload();
  await page.waitForFunction(() => window.XVaultLibraryRows?.().length === 230);
  await page.evaluate(() => openDetails('100229'));
  assert.equal(await page.locator('#dNote').inputValue(), 'Retained after a failed save and reload');
  await page.locator('#dSaveNote').click();
  await page.waitForFunction(() => document.querySelector('#dNoteState').textContent === 'Saved');
  console.log('PASS failed-save draft survives reload and can be saved after recovery');
  await page.evaluate(() => {
    document.querySelector('#search').value = 'note:"failed save"';
    renderLib();
  });
  await page.waitForFunction(
    () =>
      document.querySelector('#libShown').textContent.includes('/ 1') &&
      !document.querySelector('#list').hasAttribute('aria-busy')
  );
  assert.equal(await page.locator('#list .tweet').count(), 1);
  await page.evaluate(() => {
    document.querySelector('#search').value = '';
    renderLib();
  });
  await page.locator('#dNote').fill('Discard this draft only after reviewing the conflict');
  await second.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'UPDATE_TWEET_META',
      id: '100229',
      patch: { note: 'Reviewed saved version' },
      expectedNote: 'Retained after a failed save and reload',
    })
  );
  await page.locator('#dNoteConflict:not([hidden])').waitFor();
  await page.locator('#dNoteUseSaved').click();
  assert.equal(await page.locator('#dNote').inputValue(), 'Reviewed saved version');
  await page.evaluate(() => openDetails('100229'));
  assert.equal(
    await page.locator('#dNote').inputValue(),
    'Reviewed saved version',
    'resolved drafts must not reappear'
  );
  console.log('PASS worker-backed private-note phrase search and loading the saved conflict version');
  await page.locator('#drawerClose').click();

  // Exercise rejection/loading UI without starting a real CDN download.
  await page.evaluate(async () => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__queueRequests = 0;
    chrome.runtime.sendMessage = async message => {
      if (message.type === 'DOWNLOAD_URLS') {
        window.__queueRequests++;
        await new Promise(resolve => (window.__releaseQueue = resolve));
        return { ok: false, error: 'Synthetic queue rejection' };
      }
      return original(message);
    };
    const record = window.XVaultLibraryRows().find(row => row.id === '100229');
    record.media = [{ id: 'test-media', type: 'photo', url: 'https://pbs.twimg.com/media/fixture?format=png' }];
    await save({ libraryView: 'timeline', lastLibraryQuery: 'id:100229' }, false);
    document.querySelector('#search').value = 'id:100229';
    window.XVaultLibraryRecordUpdated(['100229']);
    renderLib();
  });
  const queueButton = page.locator('[data-download-post="100229"]');
  await queueButton.click();
  await page.waitForFunction(
    () => document.querySelector('[data-download-post="100229"]').getAttribute('aria-busy') === 'true'
  );
  assert.equal(await queueButton.innerText(), 'Queuing…');
  await queueButton.evaluate(button => button.click());
  assert.equal(await page.evaluate(() => window.__queueRequests), 1);
  await page.evaluate(() => window.__releaseQueue());
  await page.waitForFunction(() => !document.querySelector('[data-download-post="100229"]').disabled);
  assert.match(await page.locator('#toast').innerText(), /Could not queue post media: Synthetic queue rejection/);
  assert.ok(
    (await queueButton.locator('svg').count()) > 0,
    'original button icon returns after a failed queue request'
  );
  console.log('PASS visible download loading, repeat-click guard, truthful queue failure, and icon restoration');

  await page.evaluate(async () => {
    for (let start = 0; start < 220; start += 100)
      await chrome.runtime.sendMessage({
        type: 'MOVE_TWEETS_TO_TRASH',
        ids: Array.from({ length: Math.min(100, 220 - start) }, (_, index) => String(100000 + start + index)),
      });
    // Seed a legacy duplicate directly. Current capture deliberately respects Trash.
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('xvault-db');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = database.transaction('tweets', 'readwrite');
      tx.objectStore('tweets').put({
        id: '100218',
        text: 'New capture must never be overwritten',
        author: { handle: 'fieldnotes' },
        userMeta: { note: 'Newer note is protected' },
        media: [],
      });
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    database.close();
  });
  await page.reload();
  await page.locator('#libraryUndoTrash:not([hidden])').waitFor();
  assert.equal(await page.evaluate(() => window.XVaultLibraryRows().length), 11);
  await page.locator('#libraryTools>summary').click();
  await page.locator('#browseTrash').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.xv-trash-row').length === 100 &&
      document.querySelector('#xvTrashRows').getAttribute('aria-busy') === 'false'
  );
  await page.locator('#xvTrashSearch').fill('100000');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.xv-trash-row').length === 1 &&
      document.querySelector('#xvTrashRows').getAttribute('aria-busy') === 'false'
  );
  assert.match(await page.locator('.xv-trash-row input').getAttribute('aria-label'), /100000/);
  await page.locator('#xvTrashSearch').fill('');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.xv-trash-row').length === 100 &&
      document.querySelector('#xvTrashRows').getAttribute('aria-busy') === 'false'
  );
  await page.locator('[data-trash-detail="0"]').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.trashDetail), '1');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.trashDetail), '0');
  await page.locator('.xv-trash-row.conflict button').click();
  assert.match(await page.locator('#xvTrashDetail').innerText(), /Older note retained in Trash/);
  assert.match(await page.locator('#xvTrashDetail').innerText(), /Newer note is protected/);
  assert.equal(await page.locator('.xv-trash-row.conflict input').isDisabled(), true);
  await page.locator('#xvTrashMergeNote').click();
  await page.waitForFunction(() =>
    document.querySelector('#xvTrashMergeStatus')?.textContent.includes('Both post copies')
  );
  const merged = await page.evaluate(() => window.XVaultLibraryRows().find(row => row.id === '100218'));
  assert.match(
    merged.userMeta.note,
    /Newer note is protected\n\n\[Recovered from Trash\]\nOlder note retained in Trash/
  );
  await page.screenshot({ path: path.join(artifacts, 'trash-desktop.png'), animations: 'disabled' });
  assert.ok(await page.locator('#xvTrashDetail>section').first().isVisible());
  const exported = page.waitForEvent('download');
  await page.locator('#xvTrashExport').click();
  const exportedRow = JSON.parse(await fs.readFile(await (await exported).path(), 'utf8'));
  assert.equal(exportedRow.id, '100218');
  assert.equal(exportedRow.userMeta.note, 'Older note retained in Trash');
  await page.locator('#xvTrashNext').click();
  await page.waitForFunction(
    () =>
      document.querySelector('#xvTrashCount').textContent.includes('Page 2') &&
      document.querySelector('#xvTrashRows').getAttribute('aria-busy') === 'false'
  );
  assert.equal(await page.locator('.xv-trash-row').count(), 100);
  await page.locator('#xvTrashPrev').click();
  await page.waitForFunction(
    () =>
      document.querySelector('#xvTrashCount').textContent.includes('Page 1') &&
      document.querySelector('#xvTrashRows').getAttribute('aria-busy') === 'false'
  );
  await page.locator('#xvTrashSelectPage').check();
  assert.equal(await page.locator('#xvTrashRestore').innerText(), 'Restore 99 posts');
  await page.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__fullLibraryReads = 0;
    chrome.runtime.sendMessage = message => {
      if (['GET_LIBRARY_CHUNK', 'GET_LIBRARY_ROWS'].includes(message.type)) window.__fullLibraryReads++;
      return original(message);
    };
  });
  const restoreStarted = performance.now();
  await page.locator('#xvTrashRestore').click();
  await page.waitForFunction(
    () =>
      document.querySelector('#xvTrashCount').textContent.includes('121 posts') &&
      document.querySelector('#xvTrashRows').getAttribute('aria-busy') === 'false'
  );
  assert.equal(await page.evaluate(() => window.XVaultLibraryRows().length), 110);
  assert.equal(
    await page.evaluate(() => window.__fullLibraryReads),
    0,
    'selection restore must not reread the full archive'
  );
  console.log(`99-post transactional restore and refreshed UI: ${Math.round(performance.now() - restoreStarted)}ms`);
  console.log('PASS durable Undo after reload; 100-row paging; 99-post restore protects conflicting copies');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.xv-trash-row.conflict button').click();
  assert.ok(await page.locator('#xvTrash').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await page.screenshot({ path: path.join(artifacts, 'trash-narrow.png'), animations: 'disabled' });
  await page.evaluate(async () => {
    await save({ motionLevel: 'off' }, false);
  });
  assert.equal(await page.locator('#xvTrash').evaluate(element => element.getAnimations({ subtree: true }).length), 0);
  await page.evaluate(async () => {
    await save({ motionLevel: 'reduced' }, false);
  });
  assert.equal(await page.locator('#xvTrash').evaluate(element => element.getAnimations({ subtree: true }).length), 0);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#xvTrash').open);
  await page.waitForFunction(() => document.activeElement.matches('#libraryTools>summary'));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#libraryUndoTrash').click();
  await page.waitForFunction(
    () => window.XVaultLibraryRows().length === 230 && !document.querySelector('#libraryUndoTrash').disabled
  );
  const remaining = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_TRASH_PAGE', limit: 100 }));
  assert.equal(
    await page.evaluate(() => window.__fullLibraryReads),
    0,
    'Undo must apply restored rows without a full reread'
  );
  assert.equal(remaining.total, 1);
  assert.equal(remaining.rows[0].id, '100218');
  assert.equal(remaining.rows[0].current.text, 'New capture must never be overwritten');
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'MOVE_TWEETS_TO_TRASH', ids: ['100002'] });
    localStorage.setItem(
      'xv-note-draft:100002:orphan-fixture',
      JSON.stringify({ value: 'Recover this orphaned annotation', base: '', at: Date.now() })
    );
    localStorage.setItem(
      'xv-note-draft:99999999:absent-fixture',
      JSON.stringify({ value: 'Evidence for an unavailable post', base: '', at: Date.now() })
    );
  });
  await page.reload();
  await page.locator('#libraryTools>summary').click();
  await page.locator('#recoverNoteDrafts').click();
  await page.getByRole('button', { name: /Post 99999999/ }).click();
  await page.waitForFunction(() => document.querySelector('.draft-location')?.textContent.includes('absent from both'));
  assert.equal(await page.locator('#xvDraftSave').isDisabled(), true);
  const draftExport = page.waitForEvent('download');
  await page.locator('#xvDraftExport').click();
  assert.equal(
    JSON.parse(await fs.readFile(await (await draftExport).path(), 'utf8')).value,
    'Evidence for an unavailable post'
  );
  await page.getByRole('button', { name: /Post 100002/ }).click();
  await page.waitForFunction(
    () => document.querySelector('#xvDraftSave')?.textContent === 'Restore post and save draft'
  );
  await page.locator('#xvDraftSave').click();
  await page.waitForFunction(() => !localStorage.getItem('xv-note-draft:100002:orphan-fixture'));
  const recoveredDraft = await page.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'GET_LIBRARY_METADATA', ids: ['100002'] })
  );
  assert.equal(recoveredDraft.rows[0].userMeta.note, 'Recover this orphaned annotation');
  assert.equal(
    await page.evaluate(() => JSON.parse(localStorage.getItem('xv-note-draft:99999999:absent-fixture')).value),
    'Evidence for an unavailable post'
  );
  await page.screenshot({ path: path.join(artifacts, 'draft-recovery.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  console.log(
    'PASS orphan draft browser: missing-post JSON evidence export, Trash restore and conditional note save, unrelated draft preservation'
  );
  assert.deepEqual(errors, []);
  console.log('PASS narrow recovery layout, Escape close, remaining Undo, and zero runtime errors');
} finally {
  await context.close();
  const relative = path.relative(path.resolve(process.env.TEMP), profile);
  if (relative.startsWith('xvault-recovery-') && !relative.includes(path.sep))
    await fs.rm(profile, { recursive: true, force: true });
}
