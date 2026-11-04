import assert from'node:assert/strict';import{createRequire}from'node:module';const api=createRequire(import.meta.url)('../FFmpeg_Helper/remote-ui/remote-drafts.js');
const entries=[{key:'xvault.remote.note-draft:old:123:owner',raw:JSON.stringify({value:'Original note',base:'saved',at:1})}],text=await api.exportFile(entries),plan=await api.preview([],text);
const values=new Map(),storage={get length(){return values.size},key:i=>[...values.keys()][i],getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
assert.equal((await api.commit(storage,plan)).imported,1);assert.equal((await api.preview(api.snapshot(storage),text)).identical,1,'repeated imports are idempotent');
const divergent=await api.exportFile([{...entries[0],raw:JSON.stringify({value:'Other note',base:'other baseline',at:2})}]),conflict=await api.preview(api.snapshot(storage),divergent);assert.equal(conflict.conflicts,1);assert.equal((await api.commit(storage,conflict)).imported,1);assert.equal(values.size,2,'conflicting notes remain separately recoverable');
const stale=await api.preview(api.snapshot(storage),text);values.set('xvault.remote.note-draft:new:999',JSON.stringify({value:'Concurrent',base:'',at:3}));await assert.rejects(()=>api.commit(storage,stale),/changed after preview/);
await assert.rejects(()=>api.preview([],JSON.stringify({format:'xvault-remote-drafts',version:2,drafts:[]})),/Unsupported/);await assert.rejects(()=>api.preview([],text.replace('Original note','Tampered note')),/fingerprint/);
const quota={length:0,key(){},getItem(){return null},setItem(){throw Error('QuotaExceededError')}};assert.equal((await api.commit(quota,plan)).partial,true,'quota failures preserve existing evidence and report resumable partial work');
console.log('Portable Remote drafts: round-trip, duplicate import, separate conflict evidence, stale preview, fingerprint, quota and versions passed');

assert.equal((await api.preview([],JSON.stringify({format:'xvault-remote-note-draft-v1',postId:'123',raw:entries[0].raw}))).added,1,'older individual exports remain importable without inventing a device pairing');
