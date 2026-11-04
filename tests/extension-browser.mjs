// Fresh-profile MV3 integration. Never opens the user's browser profile.
// node tests/extension-browser.mjs [Playwright package] [Chromium] [artifact directory]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), pw = require(process.argv[2] || 'playwright');
const root = path.resolve('.'), artifacts = process.argv[4];
const profileRoot=path.resolve(artifacts||process.env.TEMP);
const profile = await fs.mkdtemp(path.join(profileRoot, 'xvault-extension-'));
const relativeProfile=path.relative(profileRoot,profile);
if(!relativeProfile||relativeProfile.startsWith('..')||path.isAbsolute(relativeProfile)||!path.basename(profile).startsWith('xvault-extension-'))throw Error('Unsafe test-profile path');
const context = await pw.chromium.launchPersistentContext(profile, {
  headless: true, executablePath: process.argv[3], viewport: {width:1440,height:1000},
  args: [`--disable-extensions-except=${root}`,`--load-extension=${root}`]
});
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage(), errors = [];
  await page.addInitScript(() => {
    window.__libraryRequests = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = message => { window.__libraryRequests.push(message.type); return send(message); };
  });
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  const remoteBoundary = await page.evaluate(()=>chrome.runtime.sendMessage({type:'REMOTE_COMMAND',name:'unsupported-test-command'}));
  assert.match(remoteBoundary.error,/Unsupported Remote command/,'a real dashboard tab must reach Remote command validation without starting an installed host');
  await page.evaluate(async () => {
    await chrome.runtime.sendMessage({type:'SET_SETTINGS',settings:{onboardingComplete:true,libraryView:'compact',libraryPageSize:1500,healthCheckOnStartup:false}});
    const records=Array.from({length:1501},(_,i)=>({id:String(100000+i),text:`Integration record ${i}`,author:{handle:'fixture',name:'Fixture'},createdAt:'2026-02-10T00:00:00Z',archivedAt:Date.now()-i,media:i===1?[{id:'fixture-media',type:'photo',url:'https://pbs.twimg.com/media/fixture?format=png'}]:[],userMeta:{tags:[]}}));
    const result=await chrome.runtime.sendMessage({type:'STORE_RECORDS',tweets:records,users:[]});
    if(!result.ok)throw Error(result.error);
    const database=await new Promise((resolve,reject)=>{const request=indexedDB.open('xvault-db');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
    await new Promise((resolve,reject)=>{const tx=database.transaction(['downloads','checkpoints'],'readwrite');tx.objectStore('downloads').put({key:'fixture-download',state:'complete',countedStateVersion:1,assetKey:'img:fixture',usableAssetKey:'img:fixture',item:{tweetId:'100001',mediaId:'fixture-media',url:'https://pbs.twimg.com/media/fixture?format=png'},totalBytes:125829120,verificationState:'verified'});const checkpoints=tx.objectStore('checkpoints'),request=checkpoints.get('download-asset-index-v1');request.onsuccess=()=>checkpoints.put({...request.result,stateCounts:{...(request.result?.stateCounts||{}),complete:(Number(request.result?.stateCounts?.complete)||0)+1}});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});database.close();
    const queue=await chrome.runtime.sendMessage({type:'DOWNLOAD_QUEUE_STATS'});if(!queue.countsReady||queue.complete!==1||queue.bookkeeping.indexCountRequests!==0)throw Error(`Queue checkpoint counters are not readable without an index count: ${JSON.stringify(queue)}`);
  });
  await page.reload();
  await page.locator('.nav[data-page="library"]').click();
  const waitForPage = () => page.waitForFunction(() => {
    const state=window.XVaultLibraryQueryState?.();
    return state?.loaded && state.loadedFor===state.queryKeyNow && !document.querySelector('#list').hasAttribute('aria-busy');
  });
  await waitForPage();
  const firstIds=await page.evaluate(()=>window.XVaultLibraryRows().map(row=>row.id));
  assert.equal(firstIds.length,1500,'dashboard memory contains one configured query page');
  assert.equal((await page.evaluate(()=>chrome.runtime.sendMessage({type:'STATS'}))).tweets,1501,'the archive contains the off-page record');
  assert.ok(!(await page.evaluate(()=>window.__libraryRequests)).some(type=>['GET_ALL','GET_LIBRARY_ROWS','GET_LIBRARY_CHUNK'].includes(type)),'Library startup must use query pages');
  await page.locator('#libraryNext').click();await waitForPage();
  const lastIds=await page.evaluate(()=>window.XVaultLibraryRows().map(row=>row.id));
  assert.equal(lastIds.length,1,'the final cursor page contains the remaining archive record');
  assert.deepEqual([...firstIds,...lastIds].sort(),Array.from({length:1501},(_,i)=>String(100000+i)).sort(),'paging reaches every persisted fixture exactly once regardless of capture ordering');
  assert.ok(!firstIds.includes(lastIds[0]),'cursor pages do not overlap');
  await page.locator('#libraryPrev').click();await waitForPage();
  assert.ok(await page.locator('#list .tweet').count()<=15);
  await page.evaluate(()=>document.querySelector('#librarySelectPage').click());
  await page.locator('#libraryBulkFav').click();
  await page.waitForFunction(()=>!document.querySelector('#libraryBulkFav').disabled);
  const persistedFavoriteCount=await page.evaluate(()=>new Promise((resolve,reject)=>{const opened=indexedDB.open('xvault-db');opened.onerror=()=>reject(opened.error);opened.onsuccess=()=>{const database=opened.result,tx=database.transaction('tweets','readonly'),request=tx.objectStore('tweets').openCursor();let count=0;request.onerror=()=>reject(request.error);request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(cursor.value.userMeta?.favorite)count++;cursor.continue()};tx.oncomplete=()=>{database.close();resolve(count)};tx.onabort=()=>reject(tx.error)}}));assert.equal(persistedFavoriteCount,1500,'all selected favorites persist even though the dashboard retains only its current cursor page');
  page.on('dialog',dialog=>dialog.accept());
  await page.locator('#libraryBulkTrash').click();
  await page.waitForFunction(()=>window.XVaultLibraryRows().length===1 && !document.querySelector('#libraryUndoTrash').disabled);
  await page.locator('#libraryUndoTrash').click();
  await page.waitForFunction(()=>window.XVaultLibraryRows().length===1001 && !document.querySelector('#list').hasAttribute('aria-busy'));
  const olderRecovery=await page.evaluate(async()=>{
    const undo=await chrome.runtime.sendMessage({type:'GET_TRASH_UNDO'});
    const result=await chrome.runtime.sendMessage({type:'RESTORE_TRASH'});
    await loadLib();return{undo,restored:result.restored};
  });
  assert.equal(olderRecovery.undo.ids.length,0);assert.equal(olderRecovery.undo.total,500);assert.equal(olderRecovery.undo.limited,true);
  assert.equal(olderRecovery.restored,500);
  const favoriteCountAfterRecovery=await page.evaluate(()=>new Promise((resolve,reject)=>{const opened=indexedDB.open('xvault-db');opened.onerror=()=>reject(opened.error);opened.onsuccess=()=>{const database=opened.result,tx=database.transaction('tweets','readonly'),request=tx.objectStore('tweets').openCursor();let count=0;request.onerror=()=>reject(request.error);request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(cursor.value.userMeta?.favorite)count++;cursor.continue()};tx.oncomplete=()=>{database.close();resolve(count)};tx.onabort=()=>reject(tx.error)}}));assert.equal(favoriteCountAfterRecovery,1500,'all selected favorites persist even though the dashboard retains only its current cursor page');
  console.log('PASS real MV3/IndexedDB: 1500-post Favorite, Trash, Undo preserve records');
  const cdp=await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  const stats=await page.evaluate(()=>chrome.runtime.sendMessage({type:'STATS'}));
  assert.equal(stats.tweets,1501);
  console.log('PASS service-worker termination and restart retain archive');
  const settingsReads=await page.evaluate(async()=>{
    await new Promise(resolve=>setTimeout(resolve,80));let writes=0;
    const listener=(changes,area)=>{if(area==='local'&&changes.settings)writes++};chrome.storage.onChanged.addListener(listener);
    const versions=[];for(let count=0;count<5;count++)versions.push((await chrome.runtime.sendMessage({type:'GET_SETTINGS'})).settings.settingsVersion);
    await new Promise(resolve=>setTimeout(resolve,80));chrome.storage.onChanged.removeListener(listener);return{versions,writes};
  });
  assert.deepEqual(settingsReads,{versions:[18,18,18,18,18],writes:0});
  console.log('PASS real extension settings reads preserve schema 18 without storage writes');
  const collectionWindow=await context.newPage();await collectionWindow.goto(`chrome-extension://${id}/dashboard.html`);
  const definitions=[
    {id:'fixture-smart-a',name:'Fixture A',query:'fav:true annotation:door',sort:'new',view:'timeline',icon:'note'},
    {id:'fixture-smart-b',name:'Fixture B',query:'has:video tag:reference',sort:'old',view:'gallery',icon:'video'}
  ];
  const concurrentSaves=await Promise.all(definitions.map((collection,index)=>(index?collectionWindow:page).evaluate(collection=>chrome.runtime.sendMessage({type:'UPDATE_SMART_COLLECTIONS',change:{op:'save',collection}}),collection)));
  assert.ok(concurrentSaves.every(result=>result.ok));
  let collectionSettings=await page.evaluate(()=>chrome.runtime.sendMessage({type:'GET_SETTINGS'}));
  assert.deepEqual(collectionSettings.settings.savedViews.filter(row=>row.id.startsWith('fixture-smart-')).map(row=>row.id).sort(),['fixture-smart-a','fixture-smart-b'],'concurrent windows should merge against the latest saved definitions');
  const portableCollections=JSON.stringify({format:'xvault-collections-v1',collections:[
    {id:'fixture-smart-a',name:'Fixture A',query:'fav:false',sort:'new',view:'timeline',icon:'note'},
    {id:'fixture-smart-c',name:'Fixture C',query:'annotation:detail',sort:'new',view:'compact',icon:'note'}
  ]});
  const safeImport=await page.evaluate(fileText=>chrome.runtime.sendMessage({type:'UPDATE_SMART_COLLECTIONS',change:{op:'import',fileText,conflicts:'skip'}}),portableCollections);
  assert.equal(safeImport.added,1);assert.equal(safeImport.conflicts,1);
  const keepBoth=await collectionWindow.evaluate(fileText=>chrome.runtime.sendMessage({type:'UPDATE_SMART_COLLECTIONS',change:{op:'import',fileText,conflicts:'keep-both'}}),portableCollections);
  assert.equal(keepBoth.added,1);assert.equal(keepBoth.skipped,1);
  const repeatImport=await page.evaluate(fileText=>chrome.runtime.sendMessage({type:'UPDATE_SMART_COLLECTIONS',change:{op:'import',fileText,conflicts:'keep-both'}}),portableCollections);
  assert.equal(repeatImport.added,0,'a repeated import should not add another conflict copy');
  assert.ok(repeatImport.settings.savedViews.some(row=>row.name==='Fixture A'&&row.query==='fav:true annotation:door'));
  assert.ok(repeatImport.settings.savedViews.some(row=>row.name==='Fixture A (imported)'&&row.query==='fav:false'));
  const beforeMove=repeatImport.settings.savedViews.map(row=>row.id);
  const moveResult=await collectionWindow.evaluate(()=>chrome.runtime.sendMessage({type:'UPDATE_SMART_COLLECTIONS',change:{op:'move',id:'fixture-smart-b',delta:-1}}));
  assert.equal(moveResult.settings.savedViews.findIndex(row=>row.id==='fixture-smart-b'),beforeMove.indexOf('fixture-smart-b')-1);
  const removeResult=await page.evaluate(()=>chrome.runtime.sendMessage({type:'UPDATE_SMART_COLLECTIONS',change:{op:'remove',id:'fixture-smart-c'}}));
  assert.ok(!removeResult.settings.savedViews.some(row=>row.id==='fixture-smart-c'));
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'SET_SETTINGS',settings:{theme:'paper'}}));
  const workspaceResults=await Promise.all([page,collectionWindow].map((window,index)=>window.evaluate(index=>chrome.runtime.sendMessage({type:'UPDATE_WORKSPACE',change:{op:'save',id:`desk-${index}`,name:`Desk ${index}`}}),index)));
  assert.ok(workspaceResults.every(result=>result.ok));
  assert.equal(workspaceResults.at(-1).settings.workspaces.length,2,'concurrent windows must retain both workspace snapshots');
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'SET_SETTINGS',settings:{theme:'oled',motionLevel:'off'}}));
  const restoredWorkspace=await collectionWindow.evaluate(()=>chrome.runtime.sendMessage({type:'UPDATE_WORKSPACE',change:{op:'apply',id:'desk-0'}}));
  assert.equal(restoredWorkspace.settings.theme,'paper');assert.equal(restoredWorkspace.settings.motionLevel,'off','workspace restore must preserve independent motion/accessibility preferences');
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'UPDATE_WORKSPACE',change:{op:'startup',id:'desk-0'}}));await page.evaluate(()=>chrome.runtime.sendMessage({type:'SET_SETTINGS',settings:{theme:'oled'}}));await page.reload();await page.waitForFunction(()=>settings.theme==='paper'&&settings.motionLevel==='off','startup applies visual layout while preserving global motion');
  for(const id of ['desk-0','desk-1'])await page.evaluate(id=>chrome.runtime.sendMessage({type:'UPDATE_WORKSPACE',change:{op:'remove',id}}),id);
  await collectionWindow.close();
  console.log('PASS real MV3 concurrent workspace saves and restore with independent motion preferences');
  console.log('PASS real MV3 settings: concurrent collection edits, collision-safe/idempotent import, ordering, and removal');
  const jobRead=await page.evaluate(async()=>{
    const database=await new Promise((resolve,reject)=>{const request=indexedDB.open('xvault-db');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
    await new Promise((resolve,reject)=>{const tx=database.transaction('jobs','readwrite');tx.objectStore('jobs').put({id:'monitor-fixture',state:'running',page:42,posts:1200,updatedAt:Date.now()});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
    const found=await chrome.runtime.sendMessage({type:'GET_JOB',id:'monitor-fixture'});
    await new Promise((resolve,reject)=>{const tx=database.transaction('jobs','readwrite');tx.objectStore('jobs').delete('monitor-fixture');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});database.close();
    return found;
  });
  assert.equal(jobRead.job?.page,42);assert.equal(jobRead.job?.posts,1200);
  assert.equal((await page.evaluate(()=>chrome.runtime.sendMessage({type:'GET_JOB',id:'missing-monitor-fixture'}))).job,null);
  console.log('PASS archive monitor reads one primary-key job instead of cloning archive stores');
  const query='after:2026-02-01 before:2026-03-01 size:>100mb';
  await page.locator('#search').fill(query);
  await waitForPage();
  assert.deepEqual(await page.evaluate(()=>window.XVaultLibraryRows().map(row=>row.id)),['100001'],'known-size/date query reaches its exact indexed result');
  const plan=await page.evaluate(query=>chrome.runtime.sendMessage({type:'PLAN_LIBRARY_DOWNLOAD',options:{scope:'query',query}}),query);
  assert.equal(plan.totals.postsMatched,1);assert.equal(plan.totals.media,1);
  assert.equal((await page.evaluate(()=>chrome.runtime.sendMessage({type:'PLAN_LIBRARY_DOWNLOAD',options:{scope:'query',query:'unsupported:value'}}))).totals.postsMatched,0);
  await page.locator('#clearSearch').click();
  try{await page.waitForFunction(()=>{const state=window.XVaultLibraryQueryState?.();return document.querySelector('#search')?.value===''&&state?.loaded&&state.loadedFor===state.queryKeyNow&&!state.busy})}catch(error){const debug=await page.evaluate(()=>({search:document.querySelector('#search')?.value,state:window.XVaultLibraryQueryState?.(),rows:window.XVaultLibraryRows().length,ids:window.XVaultLibraryRows().slice(0,3).map(row=>row.id),list:document.querySelector('#list')?.innerText?.slice(0,300),toast:document.querySelector('#toast')?.textContent}));console.log('After clear search',JSON.stringify(debug),JSON.stringify(errors));throw error}
  assert.equal((await page.evaluate(()=>window.XVaultLibraryRows().length)),1500,'the cross-window synchronization scenario starts from the complete visible cursor page');
  console.log('PASS installed Library and download planner agree on date/known-size and unknown filters');
  const cancellation=await page.evaluate(async()=>{
    const requestId=crypto.randomUUID();
    const pending=chrome.runtime.sendMessage({type:'PLAN_LIBRARY_DOWNLOAD',requestId,options:{scope:'all'}});
    await chrome.runtime.sendMessage({type:'CANCEL_LIBRARY_PLAN',requestId});
    return pending;
  });
  assert.equal(cancellation.cancelled,true,'cancelled bulk preview must stop its IndexedDB scan');
  const other=await context.newPage();await other.goto(page.url());
  await other.waitForFunction(()=>{const state=window.XVaultLibraryQueryState?.();return state?.rows===1500&&state.loadedFor===state.queryKeyNow&&!state.busy});
  assert.equal((await other.evaluate(()=>chrome.runtime.sendMessage({type:'STATS'}))).tweets,1501,'second window retains a bounded page while the archive remains complete');
  await page.bringToFront();
  const syncId=await page.evaluate(()=>{
    window.__syncFullReads=0;const original=chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage=message=>{if(['GET_ALL','GET_LIBRARY_ROWS','GET_LIBRARY_CHUNK'].includes(message.type))window.__syncFullReads++;return original(message)};
    return window.XVaultLibraryRows()[0].id;
  });
  const targetedRecord=await page.evaluate(id=>chrome.runtime.sendMessage({type:'GET_LIBRARY_RECORDS',ids:[id]}),syncId);
  assert.equal(targetedRecord.rows?.[0]?.id,syncId,'active surfaces can refresh one selected record by primary key');
  assert.equal((await page.evaluate(()=>chrome.runtime.sendMessage({type:'GET_LIBRARY_RECORDS',ids:Array.from({length:1001},(_,i)=>String(i))}))).ok,false,'targeted record reads must reject oversized batches');
  await other.evaluate(id=>chrome.runtime.sendMessage({type:'UPDATE_TWEET_META',id,patch:{note:'Cross-window synchronized annotation'}}),syncId);
  await page.waitForFunction(id=>window.XVaultLibraryRows().find(row=>row.id===id)?.userMeta?.note==='Cross-window synchronized annotation',syncId);
  try{await page.waitForFunction(id=>{const state=window.XVaultLibraryQueryState?.(),card=document.querySelector(`.tweet[data-id="${CSS.escape(id)}"]`);return state?.loaded&&state.loadedFor===state.queryKeyNow&&!state.busy&&!!card?.querySelector('[data-details]')},syncId)}catch(error){console.log('Cross-window Library repaint state',JSON.stringify(await page.evaluate(id=>({targetId:id,state:window.XVaultLibraryQueryState?.(),ids:window.XVaultLibraryRows().slice(0,4).map(row=>row.id),target:window.XVaultLibraryRows().find(row=>row.id===id)?.userMeta?.note,listText:document.querySelector('#list')?.innerText?.slice(0,500),toast:document.querySelector('#toast')?.innerText||document.querySelector('#toast')?.textContent,requests:window.__libraryRequests?.slice(-12)}),syncId)),JSON.stringify(errors));throw error}
  await page.locator(`.tweet[data-id="${syncId}"] [data-details]`).click();
  try { await page.waitForFunction(()=>document.querySelector('#dNote')?.value==='Cross-window synchronized annotation'); }
  catch(error){console.log(JSON.stringify({errors,inspector:await page.evaluate(()=>({note:document.querySelector('#dNote')?.value,drawer:document.querySelector('#drawerBody')?.innerText.slice(0,800),id:document.querySelector('#detailsDrawer')?.dataset.postId,rows:window.XVaultLibraryRows().slice(0,2).map(row=>({id:row.id,note:row.userMeta?.note}))}))}));throw error}
  await page.locator('#drawerClose').click();
  await page.locator(`.tweet[data-id="${syncId}"] [data-record-preview],.tweet[data-id="${syncId}"] [data-quicklook]`).click();
  await page.waitForFunction(()=>document.querySelector('#xvQuickLook')?.open===true);
  const quickLookEdit=await other.evaluate(id=>chrome.runtime.sendMessage({type:'BULK_UPDATE_TWEET_META',ids:[id],patch:{favorite:true,addTag:'shared-window'}}),syncId);
  assert.equal(quickLookEdit.rows?.[0]?.userMeta?.tags?.includes('shared-window'),true,'the real tag mutation API must commit before observing synchronization');
  await page.waitForFunction(()=>document.querySelector('#xvQuickLook [data-review="favorite"]')?.getAttribute('aria-pressed')==='true'&&[...document.querySelectorAll('#xvQuickLook aside dt')].find(node=>node.textContent==='Tags')?.nextElementSibling?.textContent==='shared-window');
  await page.keyboard.press('Escape');
  await page.locator(`.tweet[data-id="${syncId}"] [data-details]`).click();
  await other.evaluate(id=>chrome.runtime.sendMessage({type:'MOVE_TWEETS_TO_TRASH',ids:[id]}),syncId);
  await page.waitForFunction(()=>document.querySelector('#detailsDrawer')?.classList.contains('hidden'));
  await other.evaluate(id=>chrome.runtime.sendMessage({type:'RESTORE_TWEETS_FROM_TRASH',ids:[id]}),syncId);
  await page.waitForFunction(id=>window.XVaultLibraryRows().some(row=>row.id===id),syncId);
  assert.equal(await page.evaluate(()=>window.__syncFullReads),0);
  await other.close();
  console.log('PASS cancellable bulk planning, targeted Inspector/Quick Look updates, and cross-window remove/restore without full-Library reads');
  const xpage=await context.newPage();
  await xpage.route('https://x.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated X fixture</title><main>Capture fixture</main>'}));
  const xcdp=await context.newCDPSession(xpage), worlds=[];
  xcdp.on('Runtime.executionContextCreated',event=>worlds.push(event.context));
  await xcdp.send('Runtime.enable');
  await xpage.goto('https://x.com/home');
  await xpage.waitForFunction(()=>document.querySelector('#xv2-dock,#xvault-corner'));
  const world=worlds.find(world=>world.origin===`chrome-extension://${id}` || world.name===id);
  assert.ok(world,'extension isolated execution context must exist');
  const send=async message=>{
    const result=await xcdp.send('Runtime.evaluate',{contextId:world.id,expression:`chrome.runtime.sendMessage(${JSON.stringify(message)})`,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.text);
    return result.result.value;
  };
  assert.equal((await send({type:'GET_SETTINGS'})).ok,true);
  const denied=await send({type:'CLEAR_LIBRARY'});
  assert.equal(denied.ok,false);assert.match(denied.error,/dashboard/i);
  assert.equal((await page.evaluate(()=>chrome.runtime.sendMessage({type:'STATS'}))).tweets,1501);
  assert.equal((await send({type:'QUEUE_DOWNLOADS',items:[{url:'http://127.0.0.1/private'}]})).ok,false);
  const storageRead=await xcdp.send('Runtime.evaluate',{contextId:world.id,expression:'chrome.storage.local.get(null).then(()=>false,()=>true)',awaitPromise:true,returnByValue:true});
  assert.equal(storageRead.result.value,true,'content scripts cannot read private storage');
  const captureTemplate={operation:'Bookmarks',url:'https://x.com/i/api/graphql/fixture/Bookmarks',headers:{},variables:{}};
  assert.equal((await send({type:'STORE_CAPTURE_TEMPLATES',templates:[captureTemplate]})).ok,true);
  assert.equal((await send({type:'GET_CAPTURE_TEMPLATES'})).templates.Bookmarks.operation,'Bookmarks');
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'SET_SETTINGS',settings:{xCleanupEnabled:true,xHideGrok:true}}));
  await xpage.evaluate(()=>{const link=document.createElement('a');link.href='/i/grok';link.textContent='Grok';document.body.append(link);});
  await xpage.waitForFunction(()=>document.querySelector('a[href="/i/grok"]').hasAttribute('data-xvault-clean-hidden'));
  console.log('PASS trusted storage, capture-template gateway, live content settings updates');
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'SET_SETTINGS',settings:{showSideDock:true,sideDockCollapsed:true,showFloatingButton:true,motionLevel:'normal'}}));
  await xpage.bringToFront();
  await xpage.locator('#xv2-dock .xv2-dock-toggle').waitFor({state:'visible'});
  assert.equal(await xpage.locator('.xv2-dock-body').evaluate(el=>el.inert),true);
  await xpage.locator('.xv2-dock-toggle').click();
  assert.equal(await xpage.locator('.xv2-dock-toggle').getAttribute('aria-expanded'),'true');
  assert.equal(await xpage.locator('.xv2-dock-body').evaluate(el=>el.inert),false);
  await xpage.locator('.xv2-dock-toggle').click();
  assert.equal(await xpage.locator('.xv2-dock-body').evaluate(el=>el.inert),true);
  await xpage.setViewportSize({width:320,height:480});
  await xpage.locator('#xvault-corner').click({button:'right'});
  await xpage.getByRole('menu',{name:'XVault archive actions'}).waitFor({state:'visible'});
  await xpage.waitForFunction(()=>document.activeElement?.getAttribute('role')==='menuitem');
  await xpage.keyboard.press('ArrowDown');assert.equal(await xpage.evaluate(()=>document.activeElement.dataset.a),'pause');
  assert.equal(await xpage.locator('#xvault-menu').evaluate(el=>{const rect=el.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight}),true);
  if(artifacts)await xpage.screenshot({path:path.join(artifacts,'x-widget-narrow.png'),animations:'disabled'});
  await xpage.keyboard.press('Escape');assert.equal(await xpage.evaluate(()=>document.activeElement.id),'xvault-corner');
  await xpage.setViewportSize({width:1440,height:1000});await page.bringToFront();
  console.log('PASS injected widget fixture: inert collapsed controls, menu keyboard/focus ownership, 320px viewport bounds');
  await page.evaluate(()=>chrome.runtime.sendMessage({type:'SET_SETTINGS',settings:{motionLevel:'off'}}));
  await xpage.waitForFunction(()=>document.documentElement.dataset.xvMotion==='reduced');
  console.log('PASS real content-script boundary rejects archive clear and non-CDN download');
  await xpage.waitForFunction(()=>window.__XVAULT_V7_HOOKED__===1);
  await xpage.route('https://x.com/i/api/graphql/fixture/UserTweets',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({data:{tweetResult:{result:{rest_id:'200002',legacy:{id_str:'200002',full_text:'Captured fixture through page hook',created_at:'Tue Feb 10 00:00:00 +0000 2026'},core:{user_results:{result:{rest_id:'300001',legacy:{screen_name:'fixture',name:'Fixture'}}}}}}}})}));
  await xpage.evaluate(()=>fetch('https://x.com/i/api/graphql/fixture/UserTweets').then(response=>response.json()));
  await page.waitForFunction(async()=>{const result=await chrome.runtime.sendMessage({type:'HAS_TWEETS',ids:['200002']});return result.found?.includes('200002')});
  assert.equal((await send({type:'GET_CAPTURE_TEMPLATES'})).templates.UserTweets.operation,'UserTweets');
  console.log('PASS isolated fixture fetch → page hook → content validation → real archive storage');
  assert.deepEqual(errors,[]);
  if(artifacts)await page.screenshot({path:path.join(artifacts,'installed-extension.png'),animations:'disabled'});
} finally {
  await context.close();
  await fs.rm(profile,{recursive:true,force:true});
}
