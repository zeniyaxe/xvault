// Usage: node tests/library-browser.mjs [playwright package path] [Chromium executable] [artifact directory]
// The localhost server must serve the repository at http://127.0.0.1:8765.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require(process.argv[2] || 'playwright');
const output = process.argv[4];
const browser = await pw.chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(6000);
  const errors = [], longTasks = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.addInitScript(() => {
    window.__longTasks = [];
    window.__xvPerfPhase = 'startup';
    new PerformanceObserver(list => window.__longTasks.push(...list.getEntries().map(entry => ({ duration: entry.duration, startTime: entry.startTime, phase: window.__xvPerfPhase }))))
      .observe({ type: 'longtask', buffered: true });
  });
  await page.goto('http://127.0.0.1:8765/tests/dashboard-harness.html?records=50000');
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('#libraryView'));
  const frame = page.frames().find(frame => frame !== page.mainFrame());
  const setPhase = phase => frame.evaluate(value => { window.__xvPerfPhase = value; }, phase);
  await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const started = await frame.evaluate(() => { window.__longTasks.length = 0; return performance.now(); });
  await frame.locator('.nav[data-page="library"]').click();
  try { await frame.waitForFunction(() => document.querySelectorAll('#list .tweet').length > 0 && !document.querySelector('#list').hasAttribute('aria-busy')); }
  catch (error) { console.log(JSON.stringify({ errors, status: await frame.locator('#libShown').innerText(), list: (await frame.locator('#list').innerText()).slice(0,500), messages: await frame.evaluate(() => window.__xvMessageLog?.slice(-30)), metrics: await frame.evaluate(() => window.XVaultLibraryMetrics?.()) })); throw error; }
  const loadedMs = await frame.evaluate(start => performance.now() - start, started);
  const firstPage = await frame.evaluate(() => ({ state: window.XVaultLibraryQueryState?.(), metrics: window.XVaultLibraryMetrics?.().at(-1), requests: window.__xvMessageLog?.slice() }));
  const startupLongTasks = await frame.evaluate(() => window.__longTasks.splice(0));
  assert.equal(firstPage.metrics?.dashboardRecordsRetained, 50, 'dashboard should retain the bounded first page only');
  assert.ok(firstPage.metrics?.recordsRead <= 50, `newest-index first page read ${firstPage.metrics?.recordsRead} records`);
  assert.equal(firstPage.state?.rows, 50);
  assert.ok(!firstPage.requests?.some(type => ['GET_ALL', 'GET_LIBRARY_ROWS', 'GET_LIBRARY_CHUNK'].includes(type)), 'normal Library startup must not use a full-load endpoint');
  await frame.evaluate(() => { window.__longTasks.length = 0; });
  await setPhase('compact-page-render');
  await frame.evaluate(async () => { await save({ libraryPageSize: 1500, libraryView: 'compact' }, false); renderLib(); });
  await frame.waitForFunction(() => window.XVaultLibraryQueryState?.().rows === 1500 && !document.querySelector('#list').hasAttribute('aria-busy'));
  assert.ok(await frame.locator('#list .tweet').count() <= 15);
  assert.match(await frame.locator('#libShown').innerText(), /^1–1500/);
  console.log('PASS bounded compact viewport');
  await setPhase('keyboard-navigation-and-quick-look');
  await frame.locator('#list .tweet').first().press('End');
  assert.equal(await frame.evaluate(() => document.activeElement.dataset.id), '901499');
  assert.ok(await frame.locator('#list').evaluate(element => element.scrollTop) > 100000);
  assert.ok(await frame.locator('#list .tweet').count() <= 15);
  console.log('PASS keyboard navigation to unmounted last record');
  await frame.locator('.tweet[data-id="901499"]').press('Space');
  await frame.locator('#xvQuickLook[open]').waitFor();
  assert.equal(await frame.evaluate(() => document.activeElement.id), 'xvQuickLookTitle');
  await page.keyboard.press('Tab');
  assert.ok(await frame.evaluate(() => document.activeElement.closest('#xvQuickLook') != null));
  await page.keyboard.press('Escape');
  await frame.waitForFunction(() => !document.querySelector('#xvQuickLook').open && !document.querySelector('#xvQuickLook').childElementCount);
  assert.equal(await frame.evaluate(() => document.activeElement.dataset.id), '901499');
  assert.equal(await frame.locator('#xvQuickLook img,#xvQuickLook video').count(), 0);
  console.log('PASS Quick Look focus, close, and media release');
  await setPhase('selection');
  await frame.locator('#librarySelectResultsQuick').click();
  assert.equal(await frame.evaluate(() => window.XVaultLibrarySelection().length), 1500);
  await frame.locator('.bar-more > summary').click();
  await frame.locator('#libraryInvertPage').click();
  assert.equal(await frame.evaluate(() => window.XVaultLibrarySelection().length), 0, 'inverting the only loaded page should clear that page selection');
  console.log('PASS selection operates on all page records, not mounted rows');
  await frame.locator('#librarySelectResultsQuick').click();
  await frame.locator('#libraryClearSelection').click();
  await frame.evaluate(() => document.querySelector('#librarySelectPage').click());
  const queryCallsBeforeConcurrentChange=await frame.evaluate(()=>window.__xvMessageLog.filter(type=>type==='QUERY_LIBRARY_PAGE').length);
  await setPhase('bulk-favorite');
  const favoriteAction=frame.locator('#libraryBulkFav').click();
  await frame.waitForFunction(() => document.querySelector('#libraryBulkFav').disabled);
  await frame.evaluate(() => { const changes=new BroadcastChannel('xvault-library-changes');changes.postMessage({kind:'capture',ids:['external-change-during-bulk']});changes.close(); });
  await favoriteAction;
  await frame.waitForFunction(() => !document.querySelector('#libraryBulkFav').disabled);
  await frame.waitForFunction(before=>window.__xvMessageLog.filter(type=>type==='QUERY_LIBRARY_PAGE').length>=before+2,queryCallsBeforeConcurrentChange);
  assert.equal(await frame.evaluate(() => window.XVaultLibraryRows().filter(row=>row.userMeta?.favorite).length),1500);
  await setPhase('bulk-trash-and-undo');
  page.on('dialog',dialog=>dialog.accept());
  await frame.locator('#libraryBulkTrash').click();
  await frame.waitForFunction(() => !document.querySelector('#libraryUndoTrash').hidden && !document.querySelector('#libraryUndoTrash').disabled);
  assert.equal(await frame.evaluate(() => window.XVaultLibraryRows().length),1500);
  assert.equal(await frame.locator('#libraryUndoTrash').isVisible(),true,'Undo must remain reachable after selection clears');
  await frame.locator('#libraryUndoTrash').click();
  await frame.waitForFunction(() => window.XVaultLibraryRows().length === 1500 && !document.querySelector('#list').hasAttribute('aria-busy'));
  console.log('PASS 1500-post bulk Favorite, Trash, visible Undo, and restoration');
  await setPhase('quick-look-and-command-navigation');
  await frame.locator('#list').evaluate(element => element.scrollTop = 0);
  try { await frame.locator('.tweet[data-id="900000"]').waitFor(); }
  catch (error) { console.log(JSON.stringify({ state: await frame.evaluate(() => ({ query: window.XVaultLibraryQueryState?.(), ids: window.XVaultLibraryRows?.().slice(0,3).map(row=>row.id), metrics: window.XVaultLibraryMetrics?.().slice(-2), messages: window.__xvMessageLog?.slice(-20) })), list: (await frame.locator('#list').innerText()).slice(0,300) })); throw error; }
  await frame.locator('.tweet[data-id="900000"]').press('Space');
  assert.match(await frame.locator('#xvQuickLook').innerText(), /Saved artwork number 0/);
  await frame.evaluate(() => {
    const id = window.XVaultQuickLookPostId(), current = window.XVaultLibraryRows().find(row => String(row.id) === id), update = structuredClone(current);
    update.userMeta = { ...update.userMeta, favorite: false, tags: ['shared-window'], note: 'Refreshed note' };
    window.XVaultRefreshQuickLookRecord(update);
  });
  assert.equal(await frame.locator('#xvQuickLook [data-review="favorite"]').getAttribute('aria-pressed'), 'false');
  assert.equal(await frame.locator('#xvQuickLook aside dt').evaluateAll(nodes => nodes.find(node => node.textContent === 'Tags')?.nextElementSibling?.textContent), 'shared-window');
  assert.equal(await frame.locator('#xvQuickLook .xv-preview-note p').textContent(), 'Refreshed note');
  await page.keyboard.press('Escape');
  await frame.locator('#search').fill('path');
  await frame.locator('#search').evaluate(input => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); });
  await page.keyboard.press('/');
  assert.equal(await frame.locator('#search').inputValue(),'path/','slash must remain editable in search');
  await frame.locator('#clearSearch').click();
  await frame.locator('#cmdBtn').click();
  await frame.waitForFunction(()=>document.activeElement.id==='paletteInput');
  assert.equal(await frame.locator('.shell').evaluate(element=>element.inert),true);
  await frame.locator('#paletteInput').press('Shift+Tab');
  assert.equal(await frame.evaluate(()=>document.activeElement.closest('#palette')!=null),true);
  await page.keyboard.press('Escape');
  await frame.waitForFunction(()=>document.activeElement.id==='cmdBtn');
  assert.equal(await frame.evaluate(()=>document.activeElement.id),'cmdBtn');
  await frame.locator('#list').evaluate(element=>element.scrollTop=0);
  await frame.locator('.tweet[data-id="900001"]').press('Space');
  await frame.locator('#xvQuickLookTitle').press('Enter');
  await frame.waitForFunction(()=>!document.querySelector('#lightbox').classList.contains('hidden'));
  assert.equal(await frame.evaluate(()=>document.activeElement.closest('#lightbox')!=null),true);
  await frame.locator('#lbClose').press('Shift+Tab');
  assert.equal(await frame.evaluate(()=>document.activeElement.closest('#lightbox')!=null),true);
  await page.keyboard.press('Escape');
  assert.equal(await frame.locator('.shell').evaluate(element=>element.inert),false);
  const viewerReturn = await frame.evaluate(() => ({ id: document.activeElement.dataset?.id, active: document.activeElement.outerHTML.slice(0,220), focusedRow: document.activeElement.closest('.tweet')?.dataset.id || '', quickLookReturn: window.XVaultQuickLookReturnTarget?.()?.dataset?.id || '', lightbox: document.querySelector('#lightbox').className, shellInert: document.querySelector('.shell').inert }));
  assert.equal(viewerReturn.id || viewerReturn.focusedRow,'900001',`viewer must return to its Library record: ${JSON.stringify(viewerReturn)}`);
  console.log('PASS editable slash, command focus/return, Quick Look → viewer modal focus');
  await setPhase('search-filter-and-sorting');
  await frame.locator('#search').fill('unknown:value');
  try { await frame.waitForFunction(()=>document.querySelector('#libShown').textContent === '0'); }
  catch (error) { console.log(JSON.stringify({ query: await frame.evaluate(()=>({state:window.XVaultLibraryQueryState?.(),metrics:window.XVaultLibraryMetrics?.().slice(-2),search:document.querySelector('#search').value,shown:document.querySelector('#libShown').textContent,issues:document.querySelector('#libraryQueryIssues').textContent,busy:document.querySelector('#list').getAttribute('aria-busy'),count:document.querySelectorAll('#list .tweet').length})),list:(await frame.locator('#list').innerText()).slice(0,200) })); throw error; }
  assert.match(await frame.locator('#libraryQueryIssues').innerText(),/Unsupported filter/);
  await frame.locator('#search').fill('fav:true untagged:true');
  try { await frame.waitForFunction(()=>!document.querySelector('#list').hasAttribute('aria-busy') && document.querySelector('#libShown').textContent.replace(/\D/g,'').endsWith('1500')); }
  catch (error) { console.log(JSON.stringify({ query: await frame.evaluate(()=>({state:window.XVaultLibraryQueryState?.(), metrics:window.XVaultLibraryMetrics?.().slice(-2), search:document.querySelector('#search').value, shown:document.querySelector('#libShown').textContent, issues:document.querySelector('#libraryQueryIssues').textContent, busy:document.querySelector('#list').getAttribute('aria-busy')})), list:(await frame.locator('#list').innerText()).slice(0,200) })); throw error; }
  assert.equal(await frame.locator('#libraryQueryIssues').isVisible(),false);
  await frame.locator('#search').fill('after:2100-01-01');
  try { await frame.waitForFunction(()=>document.querySelector('#libShown').textContent === '0'); }
  catch (error) { console.log(JSON.stringify({ dateQuery: await frame.evaluate(()=>({ state: window.XVaultLibraryQueryState?.(), metrics: window.XVaultLibraryMetrics?.().slice(-2), search: document.querySelector('#search').value, shown: document.querySelector('#libShown').textContent, busy: document.querySelector('#list').getAttribute('aria-busy'), calls: window.__xvQueryCalls?.slice(-8) })) })); throw error; }
  await frame.locator('#clearSearch').click();
  await frame.waitForSelector('#list .tweet');
  await frame.locator('#libraryTools>summary').click();
  const priorRandomSeed = await frame.evaluate(() => window.XVaultLibraryQueryState?.().randomSeed || 0);
  await frame.locator('#shuffleLibrary').click();
  await frame.waitForFunction(() => { const state = window.XVaultLibraryQueryState?.(); return state?.randomSeed > 0 && state.loadedFor === state.queryKeyNow && !document.querySelector('#list').hasAttribute('aria-busy'); });
  const firstShuffle = await frame.evaluate(() => ({ seed: window.XVaultLibraryQueryState().randomSeed, ids: [...document.querySelectorAll('#list .tweet')].map(row => row.dataset.id) }));
  assert.notEqual(firstShuffle.seed, priorRandomSeed, 'Shuffle should choose a new stable seed');
  await frame.locator('#libraryNext').click();
  await frame.waitForFunction(() => window.XVaultLibraryQueryState?.().pageIndex === 1 && !document.querySelector('#list').hasAttribute('aria-busy'));
  await frame.locator('#libraryPrev').click();
  await frame.waitForFunction(() => window.XVaultLibraryQueryState?.().pageIndex === 0 && !document.querySelector('#list').hasAttribute('aria-busy'));
  assert.deepEqual(await frame.locator('#list .tweet').evaluateAll(nodes => nodes.map(node => node.dataset.id)), firstShuffle.ids, 'a random cursor should keep the same seeded ordering across pages');
  await frame.locator('#libraryTools>summary').click();
  await frame.locator('#shuffleLibrary').click();
  await frame.waitForFunction(seed => { const state = window.XVaultLibraryQueryState?.(); return state?.randomSeed !== seed && state.loadedFor === state.queryKeyNow && !document.querySelector('#list').hasAttribute('aria-busy'); }, firstShuffle.seed);
  const secondShuffle = await frame.locator('#list .tweet').evaluateAll(nodes => nodes.map(node => node.dataset.id));
  assert.notDeepEqual(secondShuffle, firstShuffle.ids, 'Shuffle should change the order instead of reusing the default seed');
  console.log('PASS random sort uses a changing but page-stable seed');
  await setPhase('responsive-layout');
  await frame.evaluate(() => { document.querySelector('#sort').value = 'new'; renderLib(); });
  await frame.waitForFunction(() => {
    const state = window.XVaultLibraryQueryState?.();
    return document.querySelector('#sort').value === 'new' && state?.loadedFor === state.queryKeyNow && !document.querySelector('#list').hasAttribute('aria-busy');
  });
  await frame.waitForFunction(() => document.querySelector('[data-destination="all"] .count')?.textContent === '—');
  assert.equal(await frame.locator('[data-destination="all"]').getAttribute('title'), 'Archive total is not calculated to keep Library paging fast.');
  assert.match(await frame.locator('[data-destination="favorites"]').getAttribute('title'), /on the loaded page\.$/);
  await frame.evaluate(()=>scrollTo(0,0));
  if (output) {
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ path: `${output}/after-compact.png`, animations: 'disabled' });
  }
  for (const width of [320, 390, 760, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await frame.evaluate(() => document.body.scrollWidth <= innerWidth + 1), `overflow at ${width}px`);
    if (width <= 390) {
      const layout = await frame.evaluate(() => {
        const toast = document.querySelector('#toast'), pages = document.querySelector('#libraryPages');
        toast.textContent = 'The Library changed in another window. Restarted this query from the first page.';
        toast.classList.add('show');
        const toastRect = toast.getBoundingClientRect(), pageRect = pages.getBoundingClientRect();
        return { gap: pageRect.top - toastRect.bottom, toast: { top: toastRect.top, bottom: toastRect.bottom }, pages: { top: pageRect.top, bottom: pageRect.bottom }, bottomCss: getComputedStyle(toast).bottom };
      });
      assert.ok(layout.gap >= 8, `Library toast must leave pagination usable at ${width}px: ${JSON.stringify(layout)}`);
      await frame.evaluate(() => document.querySelector('#toast')?.classList.remove('show'));
    } else {
      const layout = await frame.evaluate(() => {
        const toast = document.querySelector('#toast'), pages = document.querySelector('#libraryPages');
        toast.textContent = 'Changes saved';
        toast.classList.add('show');
        const toastRect = toast.getBoundingClientRect(), pageRect = pages.getBoundingClientRect();
        return { gap: pageRect.top - toastRect.bottom, toast: { top: toastRect.top, bottom: toastRect.bottom }, pages: { top: pageRect.top, bottom: pageRect.bottom }, bottomCss: getComputedStyle(toast).bottom };
      });
      assert.ok(layout.gap >= 8, `Library toast must leave desktop pagination usable at ${width}px: ${JSON.stringify(layout)}`);
      await frame.evaluate(() => document.querySelector('#toast')?.classList.remove('show'));
    }
    if(width===390){
      await frame.locator('#list .tweet').first().press('Enter');
      await frame.waitForFunction(()=>!document.querySelector('#detailsDrawer').classList.contains('hidden'));
      const inspectorFocus = await frame.evaluate(() => ({ id: document.activeElement.id, tag: document.activeElement.tagName, drawerRole: document.querySelector('#detailsDrawer').getAttribute('role'), drawerModal: document.querySelector('#detailsDrawer').getAttribute('aria-modal'), drawerParent: document.querySelector('#detailsDrawer').parentElement?.id, shellInert: document.querySelector('.shell').inert, openDialogCount: document.querySelectorAll('dialog[open]').length }));
      assert.equal(inspectorFocus.id,'drawerClose', `keyboard-opened Inspector must receive focus: ${JSON.stringify(inspectorFocus)} · page errors: ${JSON.stringify(errors)}`);
      assert.equal(await frame.locator('#detailsDrawer').evaluate(element=>element.parentElement===document.body),true,'modal inspector must escape the inert shell');
      assert.equal(await frame.locator('#dExportMediaSidecar').count(),0,'no-media Inspector must omit media-only sidecar controls without aborting its other controls');
      if(output)await page.screenshot({path:`${output}/inspector-narrow.png`,animations:'disabled'});
      await page.keyboard.press('Tab');
      assert.ok(await frame.evaluate(()=>document.querySelector('#detailsDrawer').contains(document.activeElement)),'Tab must move within the Inspector');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await frame.evaluate(()=>document.activeElement.id),'drawerClose','Shift+Tab must return to the Inspector close control');
      const invokingPostId=await frame.locator('#list .tweet').first().getAttribute('data-id');
      const replacedFocus=await frame.evaluate(()=>{window.__staleInspectorInvoker=document.querySelector('#list .tweet');const recordId=window.__staleInspectorInvoker?.dataset.id;renderLib();return{oldDisconnected:!window.__staleInspectorInvoker.isConnected,recordId,matchingRows:[...document.querySelectorAll('#list .tweet')].filter(item=>item.dataset.id===recordId).length}});
      assert.equal(replacedFocus.oldDisconnected,true,`test should replace the invoking row while Inspector is open: ${JSON.stringify(replacedFocus)}`);
      await frame.locator('#drawerClose').click();
      await frame.waitForFunction(()=>document.querySelector('#detailsDrawer').classList.contains('hidden'));
      await frame.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      assert.equal(await frame.locator('.shell').evaluate(element=>element.inert),false,'closing Inspector by button must release modal inert state');
      const restoredFocus=await frame.evaluate(()=>({id:document.activeElement.id,tag:document.activeElement.tagName,postId:document.activeElement.dataset.id,insideList:Boolean(document.activeElement.closest('#list')),shellInert:document.querySelector('.shell').inert}));
      assert.equal(restoredFocus.postId,invokingPostId,`closing Inspector must restore focus to its invoking post: ${JSON.stringify({restoredFocus,replacedFocus,invokingPostId})}`);
      await frame.locator('#list .tweet').first().press('Enter');
      await frame.waitForFunction(()=>!document.querySelector('#detailsDrawer').classList.contains('hidden'));
      assert.equal(await frame.evaluate(()=>document.activeElement.id),'drawerClose','keyboard reopen must restore initial focus');
      await frame.locator('#dTagInput').fill('unsaved-label');
      await frame.evaluate(() => {
        const id = document.querySelector('#detailsDrawer').dataset.postId, current = window.XVaultLibraryRows().find(row => String(row.id) === id), update = structuredClone(current);
        update.userMeta = { ...update.userMeta, favorite: false, tags: ['remote-label'] };
        window.XVaultRefreshInspectorRecord(update);
      });
      assert.equal(await frame.locator('#dFav').getAttribute('aria-pressed'), 'false');
      assert.equal(await frame.locator('#dTagInput').inputValue(), 'unsaved-label');
      assert.equal(await frame.evaluate(()=>document.activeElement.id),'dTagInput','Inspector refresh should preserve keyboard focus');
      await frame.locator('#dNote').fill('note');await frame.locator('#dNote').press('/');
      assert.equal(await frame.locator('#dNote').inputValue(),'note/');
      await page.keyboard.press('Escape');
      assert.equal(await frame.locator('.shell').evaluate(element=>element.inert),false);
      await frame.evaluate(()=>scrollTo(0,0));
      console.log('PASS narrow inspector focus and editable notes');
    }
    if (output && width === 390) await page.screenshot({ path: `${output}/after-narrow.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const zoom of [200, 300, 400]) {
    const effectiveWidth = Math.round(1440 / (zoom / 100));
    await page.setViewportSize({ width: effectiveWidth, height: 1000 });
    await frame.waitForTimeout(80);
    const layout = await frame.evaluate(() => {
      const html = document.documentElement, body = document.body, search = document.querySelector('#search').getBoundingClientRect(), pager = document.querySelector('#libraryPages').getBoundingClientRect();
      return { viewport: innerWidth, documentWidth: html.scrollWidth, bodyWidth: body.scrollWidth, clientWidth: html.clientWidth, search: { left: search.left, right: search.right, width: search.width }, pager: { left: pager.left, right: pager.right, width: pager.width } };
    });
    assert.ok(layout.documentWidth <= layout.clientWidth + 1 && layout.bodyWidth <= layout.clientWidth + 1 && layout.search.left >= -1 && layout.search.right <= layout.clientWidth + 1, `horizontal overflow at ${zoom}% zoom: ${JSON.stringify(layout)}`);
    if (output) await page.screenshot({ path: `${output}/zoom-${zoom}.png`, animations: 'disabled' });
    await frame.evaluate(() => { document.querySelector('#search').focus(); });
    await page.keyboard.press('Tab');
    assert.ok(await frame.evaluate(() => document.activeElement?.getBoundingClientRect().width > 0), `keyboard focus should remain visible at ${zoom}% zoom`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  console.log('PASS 200%, 300%, and 400% zoom overflow and keyboard focus checks');
  assert.deepEqual(errors, []);
  longTasks.push(...await frame.evaluate(() => window.__longTasks));
  const blockingTasks = [...startupLongTasks, ...longTasks].filter(task => task.duration >= 100);
  assert.deepEqual(blockingTasks, [], `The synthetic indexed UI workflow should not run 100ms main-thread tasks: ${JSON.stringify(blockingTasks)}`);
  console.log(JSON.stringify({ loadedMs: Math.round(loadedMs), firstPage: { plan: firstPage.metrics?.plan, recordsRead: firstPage.metrics?.recordsRead, recordsMaterialized: firstPage.metrics?.recordsMaterialized, dashboardRecordsRetained: firstPage.metrics?.dashboardRecordsRetained, cursorOperations: firstPage.metrics?.cursorOperations, responseBytesEstimate: firstPage.metrics?.responseBytesEstimate, queryMs: firstPage.metrics?.queryMs, usableLibraryMs: firstPage.metrics?.usableLibraryMs, mainThreadLongTasks: firstPage.metrics?.mainThreadLongTasks }, startupLongTasks, interactionLongTasks: longTasks, mountedRows: await frame.locator('#list .tweet').count(), errors }));
} finally { await browser.close(); }
