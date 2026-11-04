import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url), pw = require(process.argv[2] || 'playwright');
const browser = await pw.chromium.launch({headless:true,...(process.argv[3]?{executablePath:process.argv[3]}:{})});
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8765/tests/library-storage.html');
  await page.waitForFunction(()=>document.querySelector('#result').textContent==='PASS');
  console.log('PASS real IndexedDB cursor paging and download-row lookup');
  const result = await page.evaluate(async () => {
    const api = await import('/library-storage.mjs');
    if (typeof api.updateLibraryRecord !== 'function') return { missing: 'updateLibraryRecord' };
    const request = indexedDB.open('xvault-mutation-test-' + crypto.randomUUID(), 1);
    request.onupgradeneeded = () => { request.result.createObjectStore('tweets',{keyPath:'id'});request.result.createObjectStore('trash',{keyPath:'id'}).createIndex('deletedAt','deletedAt');request.result.createObjectStore('checkpoints',{keyPath:'key'}); };
    const db = await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
    const write = (name, rows) => new Promise((resolve,reject)=>{const tx=db.transaction(name,'readwrite');for(const row of rows)tx.objectStore(name).put(row);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});
    const get = (name,id) => new Promise((resolve,reject)=>{const r=db.transaction(name).objectStore(name).get(id);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    try {
      const rows = Array.from({length:1501},(_,index)=>({id:String(index),text:'original '+index,userMeta:{tags:['keep']}}));
      await write('tweets',rows);
      let updated=0;
      for(let start=0;start<rows.length;start+=200)updated+=(await api.updateLibraryMetadata(db,rows.slice(start,start+200).map(row=>row.id),{favorite:true,addTag:'new'})).updated;
      const last=await get('tweets','1500');
      await api.updateLibraryMetadata(db,['1500'],{reviewed:true,removeTag:'keep'});
      const reviewed=await get('tweets','1500');
      await api.updateLibraryMetadata(db,['1500'],{reviewed:false});
      const unreviewed=await get('tweets','1500');
      await api.updateLibraryMetadata(db,['1500'],{addTag:'#'});
      const emptyTag=await get('tweets','1500');
      let nullNoteRejected=false;try{await api.updateLibraryRecord(db,'1500',{note:null})}catch{nullNoteRejected=true}
      const notes=await Promise.all([
        api.updateLibraryRecord(db,'1500',{note:'first editor'},''),
        api.updateLibraryRecord(db,'1500',{note:'second editor'},'')
      ]);
      const savedNote=await get('tweets','1500');
      const captureSnapshot={...savedNote,userMeta:{note:'stale capture snapshot',reviewedAt:123}};
      await api.mergeLibraryCapture(db,captureSnapshot);
      const afterCapture=await get('tweets','1500');
      const moved=await api.moveLibraryToTrash(db,['0','1','missing']);
      const undo=await api.readTrashUndo(db);
      await write('tweets',[{id:'0',text:'newer capture',userMeta:{note:'must survive'}}]);
      const restored=await api.restoreLibraryFromTrash(db,['0','1']);
      const current=await get('tweets','0'),retained=await get('trash','0'),returned=await get('tweets','1');
      const trashPage=await api.readTrashPage(db,null,1);
      const undoAfter=await api.readTrashUndo(db);
      await write('trash',[{id:'tie-a',deletedAt:999},{id:'tie-b',deletedAt:999},{id:'tie-c',deletedAt:998}]);
      const pages=[];let after;
      for(;;){const page=await api.readTrashPage(db,after,1);pages.push(...page.rows.map(row=>row.id));if(page.done)break;after=page.nextKey;}
      let abortEvent=false;
      const wrapped={objectStoreNames:db.objectStoreNames,transaction(...args){const tx=db.transaction(...args);tx.addEventListener('abort',()=>{abortEvent=true});queueMicrotask(()=>tx.abort());return tx;}};
      let aborted=false,abortMessage='';
      try{await api.moveLibraryToTrash(wrapped,['2','3'])}catch(error){aborted=true;abortMessage=error.message}
      const safe=!!(await get('tweets','2'))&&!(await get('trash','2'));
      const undoAfterAbort=await api.readTrashUndo(db);
      let oversizedRejected=false;
      try{await api.updateLibraryMetadata(db,rows.map(row=>row.id),{favorite:false})}catch{oversizedRejected=true}
      return {updated,last,reviewed,unreviewed,emptyTag,nullNoteRejected,notes,savedNote,afterCapture,moved,undo,trashPage,undoAfter,pages,restored,current,retained,returned,aborted,abortEvent,undoAfterAbort,safe,oversizedRejected};
    } finally { const name=db.name;db.close();indexedDB.deleteDatabase(name); }
  });
  assert.equal(result.missing,undefined, 'Library needs transactional mutation helpers');
  assert.equal(result.updated,1501);
  assert.equal(result.last.userMeta.favorite,true);
  assert.deepEqual(result.last.userMeta.tags,['keep','new']);
  assert.ok(result.reviewed.userMeta.reviewedAt);
  assert.deepEqual(result.reviewed.userMeta.tags,['new']);
  assert.equal(result.unreviewed.userMeta.reviewedAt,undefined);
  assert.deepEqual(result.emptyTag.userMeta.tags,['new']);
  assert.equal(result.nullNoteRejected,true);
  assert.equal(result.notes.filter(row=>row.ok).length,1,'only one competing editor may save against the same original');
  assert.equal(result.notes.find(row=>!row.ok).conflict,true);
  assert.equal(result.savedNote.userMeta.note,'first editor');
  assert.equal(result.afterCapture.userMeta.note,'first editor','capture writes must preserve metadata saved since their initial read');
  assert.equal(result.afterCapture.userMeta.reviewedAt,undefined,'capture snapshots cannot resurrect removed metadata fields');
  assert.deepEqual(result.undo.ids,['0','1']);
  assert.deepEqual(result.undoAfter.ids,['0']);
  assert.equal(result.trashPage.total,1);
  assert.equal(result.trashPage.rows[0].conflict,true);
  assert.equal(result.trashPage.rows[0].current.text,'newer capture');
  assert.deepEqual(result.pages,['0','tie-b','tie-a','tie-c'],'newest-first pages handle equal removal timestamps without gaps or duplicates');
  assert.equal(result.moved.moved,2);
  assert.equal(result.restored.restored,1);
  assert.equal(result.restored.rows[0].id,'1');
  assert.equal(result.restored.rows[0].deletedAt,undefined);
  assert.deepEqual(result.restored.conflicts,['0']);
  assert.equal(result.current.text,'newer capture');
  assert.equal(result.retained.text,'original 0');
  assert.equal(result.returned.text,'original 1');
  assert.equal(result.aborted,true);
  assert.equal(result.abortEvent,true,'prove an actual transaction abort, not an unrelated setup exception');
  assert.deepEqual(result.undoAfterAbort.ids,['0'],'an aborted move cannot modify durable Undo');
  assert.equal(result.safe,true);
  assert.equal(result.oversizedRejected,true);
  console.log('PASS real IndexedDB: 1501 metadata updates, atomic Trash abort, conflict-preserving restore, oversized request rejection');
} finally { await browser.close(); }
