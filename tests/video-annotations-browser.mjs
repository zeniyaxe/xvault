import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwright = require(process.argv[2] || 'playwright');
const chromePath = process.argv[3];
const output = process.argv[4] || 'output/video-annotations';
await fs.mkdir(output, { recursive: true });
const browser = await playwright.chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8765/tests/dashboard-harness.html?idb=1&records=1000', { waitUntil: 'load' });
  const frame = page.frames().find(candidate => candidate !== page.mainFrame());
  assert.ok(frame, 'dashboard frame should load');
  await frame.waitForFunction(() => window.__xvMockReadyComplete && window.XVaultMediaMetadata);

  const fixture = await frame.evaluate(async () => {
    const record = async durationMs => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d'), stream = canvas.captureStream(24), chunks = [];
      let frame = 0;
      const draw = () => { context.fillStyle = `hsl(${frame * 17 % 360} 55% 42%)`; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = 'white'; context.font = '28px sans-serif'; context.fillText(`Frame ${frame++}`, 24, 90); };
      draw(); const timer = setInterval(draw, 40);
      const recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? { mimeType: 'video/webm;codecs=vp8' } : undefined);
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise(resolve => recorder.addEventListener('stop', resolve, { once: true }));
      recorder.start(); await new Promise(resolve => setTimeout(resolve, durationMs)); recorder.stop(); await stopped;
      clearInterval(timer); stream.getTracks().forEach(track => track.stop());
      return URL.createObjectURL(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
    };
    const sourceUrl = await record(2800);
    const gif = new Blob([Uint8Array.from(atob('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='), value => value.charCodeAt(0))], { type: 'image/gif' });
    const derivativeUrl = URL.createObjectURL(gif);
    const id = '900000', media = { id: 'annotation-video', type: 'video', url: sourceUrl, playbackUrl: sourceUrl, width: 320, height: 180, duration: 2.8, provenance: [{ source: 'synthetic browser fixture', capturedAt: Date.now() }] };
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open(window.__xvMockRealDatabaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const api = await import('/library-storage.mjs');
    const current = await api.readLibraryRecords(db, [id]);
    if (!current.length) throw Error('Could not find the synthetic archive row in IndexedDB');
    const merged = await api.mergeLibraryCapture(db, { ...current[0], text: 'Timestamp annotation browser fixture', observedAt: Date.now(), media: [...current[0].media, media] }, (saved, snapshot) => ({ ...saved, ...snapshot, media: snapshot.media }));
    if (!merged.stored) throw Error('Could not attach synthetic video through the capture transaction');
    await new Promise((resolve, reject) => {
      const tx = db.transaction('downloads', 'readwrite'), store = tx.objectStore('downloads'), now = Date.now();
      store.put({ key: 'synthetic-video-original', createdAt: now, updatedAt:now+100,sourceGeneration:'source-B',conversionExpected:true,state: 'complete', item: { tweetId: id, mediaId: media.id, mediaType: 'video', url: sourceUrl }, target: { filename: 'Videos/test-capture.webm', kind: 'video' }, totalBytes: 183000, verification: { state: 'verified' } });
      store.put({ key: 'synthetic-video-conversion',sourceGeneration:'source-A',createdAt: now + 1,state: 'complete', conversionExpected: true, conversionState: 'complete', item: { tweetId: id, mediaId: media.id, mediaType: 'video', url: sourceUrl }, convertedGifPath: 'XVault/GIFs/GIF/test-capture.gif', convertedGifFileUrl: derivativeUrl, convertedGifSize: 420 });
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { id, mediaIndex: current[0].media.length, mediaKey: window.XVaultMediaMetadata.mediaKey(id, media, current[0].media.length), sourceUrl, derivativeUrl };
  });

  await frame.locator('.nav[data-page="library"]').click();
  await frame.waitForFunction(() => window.XVaultLibraryQueryState?.().loaded && !document.querySelector('#list')?.hasAttribute('aria-busy'));
  await frame.evaluate(() => { settings.helperPreferHttpPreview = false; });
  await frame.evaluate(({ id, mediaIndex }) => {
    const post = window.XVaultLibraryRows().find(row => String(row.id) === id);
    if (!post) throw Error('Fixture post was not returned in the current Library page');
    window.openLightbox([post], 0, mediaIndex);
  }, fixture);
  await frame.locator('#lbContent video').waitFor({ state: 'attached' });
  await frame.waitForFunction(() => document.querySelector('#lbContent video')?.readyState >= 1, { timeout: 20000 });
  const initial = await frame.evaluate(() => ({ duration: document.querySelector('#lbContent video').duration, sourceOptions: [...(document.querySelector('[data-annotation-focus="variant"]')?.options || [])].map(option => option.textContent), notePanel: !!document.querySelector('.xv-annotation-panel') }));
  assert.ok(initial.duration > 2.5 && initial.duration < 3.2, `MediaRecorder fixture should have a seekable duration; got ${initial.duration}`);
  assert.equal(initial.notePanel, true);
  assert.ok(initial.sourceOptions.every(label => !/GIF|WebP/i.test(label)), `animated image derivatives must not masquerade as seekable video timeline sources: ${initial.sourceOptions.join(', ')}`);

  async function positionAt(ms) {
    await frame.locator('#lbContent video').evaluate(async (video, targetMs) => {
      video.pause(); const target = targetMs / 1000;
      if (Math.abs(video.currentTime - target) < 0.0001) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Synthetic video did not seek')), 5000);
        video.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
        video.currentTime = target;
      });
    }, ms);
  }
  async function addNote(text) {
    await frame.locator('[data-annotation-add]').click();
    await frame.locator('#xvAnnotationNewText').fill(text);
    await frame.locator('#xvAnnotationNewText').press('Control+Enter');
    await frame.waitForFunction(() => Number(document.querySelector('.xv-annotation-panel h4 span')?.textContent) > 0 && document.querySelector('#xvAnnotationNewText')?.closest('form')?.hidden);
  }
  await positionAt(1250);
  await addNote('Door opens at the threshold');
  const longAnnotation = `Same instant marker · ${'scene observation '.repeat(430)}`;
  await positionAt(1250);
  await addNote(longAnnotation);
  let persisted = await frame.evaluate(async id => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open(window.__xvMockRealDatabaseName); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const row = await new Promise((resolve, reject) => { const request = db.transaction('tweets').objectStore('tweets').get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return row;
  }, fixture.id);
  let annotations = persisted.media[fixture.mediaIndex].xvault.annotations.filter(note => !note.deletedAt);
  assert.equal(annotations.length, 2);
  assert.deepEqual(annotations.map(note => note.atMs), [1250, 1250], 'multiple notes must be allowed at the same millisecond offset');
  assert.ok(await frame.locator('.xv-annotation-copy details').count(), 'long note text should be expandable instead of expanding the viewer panel');

  const target = annotations[0];
  await frame.locator(`[data-annotation-edit="${target.id}"]`).click();
  await frame.locator(`[data-annotation-row][data-annotation-id="${target.id}"] textarea`).fill('Door opens slowly · local edit');
  const external = await frame.evaluate(async ({ id, mediaKey, annotation }) => chrome.runtime.sendMessage({ type: 'UPDATE_MEDIA_METADATA', id, mediaKey, change: { type: 'annotation-edit', annotation: { ...annotation, text: 'Door opens from another capture' }, expectedUpdatedAt: annotation.updatedAt } }), { id: fixture.id, mediaKey: fixture.mediaKey, annotation: target });
  assert.equal(external.ok, true, 'a competing window edit should commit against its current baseline');
  await frame.locator(`[data-annotation-save-edit="${target.id}"]`).click();
  await frame.locator(`[data-annotation-overwrite="${target.id}"]`).waitFor({ state: 'visible' });
  assert.match(await frame.locator(`[data-annotation-row][data-annotation-id="${target.id}"]`).innerText(), /Changed elsewhere/);
  await frame.locator(`[data-annotation-overwrite="${target.id}"]`).click();
  await frame.waitForFunction(async ({ id, expected, mediaIndex }) => {
    const db = await new Promise(resolve => { const request = indexedDB.open(window.__xvMockRealDatabaseName); request.onsuccess = () => resolve(request.result); });
    const row = await new Promise(resolve => { const request = db.transaction('tweets').objectStore('tweets').get(id); request.onsuccess = () => resolve(request.result); }); db.close();
    return row.media[mediaIndex].xvault.annotations.find(note => note.id === expected)?.text === 'Door opens slowly · local edit';
  }, { id: fixture.id, expected: target.id, mediaIndex: fixture.mediaIndex });

  // Keep a note draft through closing the viewer, then deliberately discard it.
  await frame.locator('[data-annotation-add]').click();
  await frame.locator('#xvAnnotationNewText').fill('Draft that must survive closing the viewer');
  await frame.locator('[data-annotation-cancel]').click();
  await frame.evaluate(({ id, mediaIndex }) => { window.XVaultCloseLightbox(); const post = window.XVaultLibraryRows().find(row => String(row.id) === id); window.openLightbox([post], 0, mediaIndex); }, fixture);
  await frame.locator('#xvAnnotationNewText').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#xvAnnotationNewText').inputValue(), 'Draft that must survive closing the viewer');
  const discardDialog = page.waitForEvent('dialog').then(dialog => dialog.accept());
  await frame.locator('[data-annotation-discard-new]').click();
  await discardDialog;
  assert.equal(await frame.locator('#xvAnnotationNewText').inputValue(), '');

  // Deletion is a recoverable tombstone with an explicit Undo action.
  const beforeDelete = await frame.evaluate(async ({ id, mediaIndex }) => {
    const db = await new Promise(resolve => { const request = indexedDB.open(window.__xvMockRealDatabaseName); request.onsuccess = () => resolve(request.result); });
    const row = await new Promise(resolve => { const request = db.transaction('tweets').objectStore('tweets').get(id); request.onsuccess = () => resolve(request.result); }); db.close();
    return row.media[mediaIndex].xvault.annotations.find(note => note.text.startsWith('Same instant'));
  }, fixture);
  await frame.locator(`[data-annotation-delete="${beforeDelete.id}"]`).click();
  await frame.locator('.xv-annotation-removed summary').click();
  await frame.locator(`[data-annotation-restore="${beforeDelete.id}"]`).click();
  await frame.waitForFunction(async ({ id, annotationId, mediaIndex }) => {
    const db = await new Promise(resolve => { const request = indexedDB.open(window.__xvMockRealDatabaseName); request.onsuccess = () => resolve(request.result); });
    const row = await new Promise(resolve => { const request = db.transaction('tweets').objectStore('tweets').get(id); request.onsuccess = () => resolve(request.result); }); db.close();
    return !row.media[mediaIndex].xvault.annotations.find(note => note.id === annotationId)?.deletedAt;
  }, { id: fixture.id, annotationId: beforeDelete.id, mediaIndex: fixture.mediaIndex });

  await frame.locator('#lbClose').click();
  await frame.evaluate(id => window.openDetails(id), fixture.id);await frame.locator('.xv-media-assets').filter({hasText:'test-capture.webm'}).waitFor();assert.ok(await frame.locator('.xv-media-assets').filter({hasText:'From an older retained original'}).count()>0,'derivative generation mismatch is visible without deleting the old source');
  const entry = frame.locator(`[data-media-entry][data-media-index="${fixture.mediaIndex}"]`);
  const staticAsset=frame.locator('[data-media-entry][data-media-index="0"]');
  assert.equal(await staticAsset.getAttribute('data-derivative-manager'),'false','static images without derivative evidence should not expose an irrelevant GIF/WebP manager');
  assert.equal(await staticAsset.locator('.xv-derivative-list').evaluate(element=>getComputedStyle(element).display),'none','static image metadata keeps its original-file evidence without derivative placeholder rows');
  assert.equal(await entry.getAttribute('data-derivative-manager'),'true','video metadata keeps the complete derivative lifecycle manager');
  await entry.locator('[data-media-field="note"]').fill(`Blue hour framing · ${'lighting cue '.repeat(120)}`);
  await entry.locator('[data-media-field="tags"]').fill('reference, threshold');
  await entry.locator('[data-media-field="source"]').fill('Field reference');
  await entry.locator('[data-media-field="sourceUrl"]').fill('https://example.test/reference');
  await entry.locator('[data-media-save]').click();
  await frame.waitForFunction(() => document.querySelector('[data-media-entry] [data-media-status]')?.textContent === 'Saved on this device');
  assert.match(await entry.locator('.xv-media-tech').textContent(), /Provenance · 1 captured · 0 recorded/, 'Inspector should distinguish capture provenance from portable supplemental provenance');
  assert.equal(await entry.locator('[data-media-compare="gif"]').isEnabled(), true, 'a recorded derivative should be previewable in the comparison panel');
  await entry.locator('[data-media-compare="gif"]').click();
  await frame.locator('#xvDerivativeCompare[open]').waitFor();
  await frame.locator('[data-compare-stage="derivative"] img').waitFor({ state: 'attached' });
  await frame.waitForFunction(() => document.querySelector('[data-compare-status="original"]')?.textContent !== 'Loading original preview…', { timeout: 10000 }).catch(() => {});
  const compareEvidence = await frame.evaluate(() => {
    const video = document.querySelector('[data-compare-stage="original"] video');
    return { status: document.querySelector('[data-compare-status="original"]')?.textContent, src: video?.getAttribute('src'), currentSrc: video?.currentSrc, readyState: video?.readyState, networkState: video?.networkState, error: video?.error?.code || null, preferHttp: settings.helperPreferHttpPreview };
  });
  assert.match(compareEvidence.status, /^Ready/, `the recorded original should preview when its captured source is available: ${JSON.stringify(compareEvidence)}`);
  await page.screenshot({ path: `${output}/derivative-compare-desktop.png`, fullPage: false });
  await frame.locator('#xvDerivativeCompare [data-compare-close]').last().click();
  const removalPrompt=page.waitForEvent('dialog').then(async dialog=>{assert.match(dialog.message(),/captured original.*untouched/i);await dialog.accept()});
  const removeGif=entry.locator('[data-media-remove-derivative="gif"]');
  assert.equal(await removeGif.isEnabled(),true,'only a recorded generated derivative with a conversion key can be removed');
  await removeGif.click();await removalPrompt;
  await frame.waitForFunction(index=>document.querySelector(`[data-media-entry][data-media-index="${index}"] [data-derivative-row="gif"]`)?.dataset.state==='removed',fixture.mediaIndex);
  assert.equal(await entry.locator('[data-media-compare="gif"]').isEnabled(),false,'removed derivative is no longer offered for comparison');
  assert.equal(await entry.locator('[data-derivative-row="webp"]').count(),1,'the other format remains separately managed');
  const webpStatus=await entry.locator('[data-derivative-row="webp"]').innerText();
  assert.match(webpStatus,/Not created|Missing on disk/,'per-format status must describe the WebP output, not copy the overall conversion job state');
  assert.doesNotMatch(webpStatus,/completed/i,'an overall completed job must not imply that every requested derivative exists');
  assert.match(await entry.locator('.xv-media-assets').innerText(),/Original · test-capture\.webm/,'removing a derivative keeps the archival original visible');
  assert.equal(await entry.locator('[data-media-view]').evaluate(button=>button===document.activeElement),true,'focus returns to the media entry after its removal row rerenders');
  assert.equal(await frame.evaluate(()=>window.__xvMessageLog.filter(type=>type==='REMOVE_CONVERSION_OUTPUT').length),1,'the Inspector uses the dedicated derivative-removal command');
  assert.deepEqual(await frame.evaluate(()=>window.__xvDerivativeRemovalCalls),[{key:'synthetic-video-conversion',format:'gif'}],'the Inspector identifies only the selected generated format for deletion');
  await page.screenshot({path:`${output}/derivative-manager-desktop.png`,fullPage:false});
  await page.setViewportSize({width:390,height:844});
  await frame.waitForFunction(()=>innerWidth===390&&document.querySelector('#detailsDrawer')?.dataset.overlay==='modal');
  const narrowDerivative=await frame.evaluate(index=>{const row=document.querySelector(`[data-media-entry][data-media-index="${index}"] [data-derivative-row="gif"]`),button=row?.querySelector('[data-media-remove-derivative]'),rect=button?.getBoundingClientRect();return{viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,button:rect?{left:rect.left,right:rect.right,width:rect.width}:null} },fixture.mediaIndex);
  assert.ok(narrowDerivative.scrollWidth<=narrowDerivative.viewport,`narrow Inspector derivative controls must not overflow: ${JSON.stringify(narrowDerivative)}`);
  assert.ok(narrowDerivative.button?.width>=36&&narrowDerivative.button.right<=narrowDerivative.viewport,`removed derivative state remains visible at 390px: ${JSON.stringify(narrowDerivative)}`);
  await entry.locator('[data-derivative-row="gif"]').scrollIntoViewIfNeeded();
  await page.screenshot({path:`${output}/derivative-manager-390.png`,fullPage:false});
  await page.setViewportSize({width:1440,height:1000});

  const queryScheduledBefore = await frame.evaluate(() => window.XVaultLibraryQueryState?.().queryRenderScheduled || 0);
  await frame.locator('#search').fill('annotation:"door opens" tag:threshold note:true');
  await frame.waitForFunction(before => (window.XVaultLibraryQueryState?.().queryRenderScheduled || 0) > before, queryScheduledBefore);
  await frame.waitForFunction(id => { const state = window.XVaultLibraryQueryState?.(); return state?.loaded && !state.busy && state.loadedFor === state.queryKeyNow && document.querySelector(`#list .tweet[data-id="${CSS.escape(id)}"]`) && !document.querySelector('#list')?.hasAttribute('aria-busy'); }, fixture.id, { timeout: 8000 }).catch(async error => { const details = await frame.evaluate(() => ({ state: window.XVaultLibraryQueryState?.(), list: document.querySelector('#list')?.innerText.slice(0,500), errors: window.__xvErrors || [] })); throw new Error(`${error.message}; query diagnostics ${JSON.stringify(details)}`); });
  assert.ok(await frame.locator(`#list .tweet[data-id="${fixture.id}"]`).count(), 'annotation, media tag and media note filters should find the same post');
  await frame.locator(`#list .tweet[data-id="${fixture.id}"]`).press('Space');
  await frame.locator('#xvQuickLook[open] .xv-preview-video-notes').waitFor({ state: 'visible' });
  const quickLookOrigin = await frame.evaluate(() => { const target = window.XVaultQuickLookReturnTarget?.(); return { tag: target?.tagName, rowId: target?.closest('.tweet')?.dataset.id || null, targetId: target?.id || null, className: target?.className || '' }; });
  assert.equal(quickLookOrigin.rowId, fixture.id, `Quick Look should retain its Library row as the focus return point: ${JSON.stringify(quickLookOrigin)}`);
  assert.match(await frame.locator('#xvQuickLook .xv-preview-video-notes').textContent(), /Video notes · 2/);
  await page.setViewportSize({ width: 390, height: 844 });
  const quickLookNarrow = await frame.evaluate(() => {
    const dialog = document.querySelector('#xvQuickLook'), header = dialog.querySelector('header'), title = header.querySelector('.xv-preview-title'), position = header.querySelector('.xv-preview-position'), navigation = header.querySelector('.xv-preview-navigation');
    const bounds = dialog.getBoundingClientRect(), footerButtons = [...dialog.querySelectorAll('footer button')].map(button => { const rect = button.getBoundingClientRect(); return { text: button.textContent.trim(), left: rect.left, right: rect.right, width: rect.width, display: getComputedStyle(button).display }; });
    return { viewport: innerWidth, dialog: { left: bounds.left, right: bounds.right }, header: { titleRight: title.getBoundingClientRect().right, positionLeft: position.getBoundingClientRect().left, positionRight: position.getBoundingClientRect().right, navigationLeft: navigation.getBoundingClientRect().left, navigationRight: navigation.getBoundingClientRect().right, positionWhiteSpace: getComputedStyle(position).whiteSpace }, footerButtons };
  });
  await page.screenshot({ path: `${output}/quick-look-390.png`, fullPage: false });
  assert.ok(quickLookNarrow.header.titleRight <= quickLookNarrow.header.positionLeft, `Quick Look title and result position must not overlap at narrow width: ${JSON.stringify(quickLookNarrow.header)}`);
  assert.ok(quickLookNarrow.header.positionRight <= quickLookNarrow.header.navigationLeft, `Quick Look result position and navigation must not overlap at narrow width: ${JSON.stringify(quickLookNarrow.header)}`);
  assert.equal(quickLookNarrow.header.positionWhiteSpace, 'nowrap', 'the current result count should remain on one line');
  assert.equal(quickLookNarrow.footerButtons.length, 6);
  assert.ok(quickLookNarrow.footerButtons.every(button => button.width > 0 && button.left >= quickLookNarrow.dialog.left && button.right <= quickLookNarrow.dialog.right), `all review and navigation actions must remain reachable at narrow width: ${JSON.stringify(quickLookNarrow.footerButtons)}`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await frame.locator('#xvQuickLook [data-preview="notes"]').click();
  await frame.locator('#lbContent video').waitFor({ state: 'attached' });
  assert.equal(await frame.locator('#detailsDrawer').evaluate(element => element.classList.contains('hidden')), true, 'opening a note from Quick Look must close Inspector so it cannot cover the viewer');
  await frame.waitForFunction(() => { const video = document.querySelector('#lbContent video'); return video?.readyState >= 1 && video.currentTime > 1.15 && video.currentTime < 1.8; }, { timeout: 15000 });
  const viewerNotePreview = await frame.locator('.xv-media-note-preview').textContent();
  assert.ok(viewerNotePreview.length <= 281 && await frame.locator('.xv-viewer-media-meta details').count(), 'long media notes should stay compact until explicitly expanded');
  await frame.waitForFunction(annotationId => { const pane = document.querySelector('#lbMeta'), row = pane?.querySelector(`[data-annotation-row][data-annotation-id="${CSS.escape(annotationId)}"]`); if (!pane || !row) return false; const a = pane.getBoundingClientRect(), r = row.getBoundingClientRect(); return r.top >= a.top && r.bottom <= a.bottom; }, target.id);
  assert.deepEqual(await frame.locator('#lightbox').evaluate(element => ({ role: element.getAttribute('role'), modal: element.getAttribute('aria-modal') })), { role: 'dialog', modal: 'true' }, 'the full-screen media viewer must be announced as a modal dialog');
  await frame.locator('#lbClose').focus();
  await frame.locator('#lbClose').press('Shift+Tab');
  assert.equal(await frame.locator('#lightbox').evaluate(element => element.contains(document.activeElement)), true, 'reverse keyboard navigation must stay inside the full-screen viewer');
  await page.keyboard.press('Tab');
  assert.equal(await frame.evaluate(() => document.activeElement?.id), 'lbClose', 'forward keyboard navigation must wrap to the first viewer action');

  const geometry = await frame.evaluate(() => ({ width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, bodyWidth: document.body.scrollWidth, list: document.querySelector('.xv-annotation-list')?.getBoundingClientRect().toJSON() }));
  await frame.evaluate(() => document.querySelector('#toast')?.classList.remove('show'));
  await page.screenshot({ path: `${output}/annotation-viewer-desktop.png`, fullPage: false });
  assert.equal(geometry.width, geometry.client, `desktop viewer overflowed: ${JSON.stringify(geometry)}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.evaluate(({ mediaKey, annotationId }) => window.XVaultSeekMediaAnnotation(mediaKey, annotationId), { mediaKey: fixture.mediaKey, annotationId: target.id });
  await frame.waitForFunction(annotationId => { const pane = document.querySelector('#lbMeta'), row = pane?.querySelector(`[data-annotation-row][data-annotation-id="${CSS.escape(annotationId)}"]`); if (!pane || !row) return false; const a = pane.getBoundingClientRect(), r = row.getBoundingClientRect(); return r.top >= a.top && r.bottom <= a.bottom; }, target.id);
  await page.screenshot({ path: `${output}/annotation-viewer-390.png`, fullPage: false });
  const narrow = await frame.evaluate(() => { const close = document.querySelector('#lbClose'), rect = close.getBoundingClientRect(), style = getComputedStyle(close); return { width: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, viewer: document.querySelector('#lightbox').getBoundingClientRect().toJSON(), aside: document.querySelector('#lbMeta').getBoundingClientRect().toJSON(), close: { rect: rect.toJSON(), display: style.display, visibility: style.visibility, opacity: style.opacity, focused: document.activeElement === close } }; });
  assert.equal(narrow.width, narrow.clientWidth || narrow.client, `narrow viewer overflowed: ${JSON.stringify(narrow)}`);
  assert.ok(narrow.close.rect.width >= 36 && narrow.close.rect.left >= 0 && narrow.close.rect.right <= narrow.client, `narrow viewer close action must remain visible: ${JSON.stringify(narrow.close)}`);
  await frame.locator('#lbClose').press('Escape');
  await frame.locator('#lightbox').waitFor({ state: 'hidden' });
  await page.waitForTimeout(50);
  const restoredFocus = await frame.evaluate(id => ({ id: document.activeElement?.id, tag: document.activeElement?.tagName, className: document.activeElement?.className, rowId: document.activeElement?.closest('.tweet')?.dataset.id || null, rowStillVisible: !!document.querySelector(`#list .tweet[data-id="${CSS.escape(id)}"]`), quickLookOpen: document.querySelector('#xvQuickLook').open, lightbox: document.querySelector('#lightbox').className, shellInert: document.querySelector('.shell').inert }), fixture.id);
  assert.ok(restoredFocus.rowId === fixture.id || (!restoredFocus.rowStillVisible && restoredFocus.id === 'search'), `closing the viewer must restore the row or its safe search fallback if the query removed it: ${JSON.stringify(restoredFocus)}`);
  await frame.evaluate(async ({ id, mediaIndex }) => {
    const db = await new Promise(resolve => { const request = indexedDB.open(window.__xvMockRealDatabaseName); request.onsuccess = () => resolve(request.result); });
    const next = await new Promise(resolve => { const tx = db.transaction('tweets', 'readwrite'), store = tx.objectStore('tweets'), request = store.get(id); request.onsuccess = () => { const row = request.result; row.media[mediaIndex].xvault.annotations.push({ id: 'malformed-legacy-note', atMs: -1, text: null }); store.put(row); }; tx.oncomplete = () => { const request = db.transaction('tweets').objectStore('tweets').get(id); request.onsuccess = () => resolve(request.result); }; });
    db.close(); Object.assign(window.XVaultLibraryRows().find(row => String(row.id) === id), next); window.openDetails(id);
  }, fixture);
  await frame.locator('.xv-media-metadata-warning[role="alert"]').waitFor({ state: 'visible' });
  await frame.locator(`[data-media-entry][data-media-index="${fixture.mediaIndex}"] [data-media-view]`).click();
  await frame.locator('.xv-annotation-invalid[role="alert"]').waitFor({ state: 'visible' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await frame.evaluate(() => ({ bodyMotion: document.body.dataset.motion, systemReduced: matchMedia('(prefers-reduced-motion: reduce)').matches }));
  assert.equal(reduced.systemReduced, true);
  assert.deepEqual(errors, []);
  console.log(`PASS exact video timestamps, duplicate-time notes, edit conflicts, retained drafts, tombstone undo, media metadata search, side-by-side derivative preview, Quick Look jump, and 390px layout · ${JSON.stringify({ duration: initial.duration, annotations: annotations.length, desktopWidth: geometry.width, narrowWidth: narrow.width, close: narrow.close, reducedMotion: reduced.systemReduced })}`);
} finally { await browser.close(); }
