import {mediaIdentity,assetIdentity} from './download-identity.mjs';
const generation=row=>String(row?.sourceGeneration||(row?.downloadId||row?.lastDownloadId?`chrome:${row.downloadId||row.lastDownloadId}`:'unidentified'));
const storeName='mediaAssociations';

// A link identifies a physical source generation, not whichever row later reuses its queue key.
export function linkSharedFile(database,item,ownerKey){
 if(!database.objectStoreNames.contains(storeName))return Promise.reject(Error('Shared files require the current storage schema'));
 return new Promise((resolve,reject)=>{
  const names=['downloads',storeName,...(database.objectStoreNames.contains('checkpoints')?['checkpoints']:[])],tx=database.transaction(names,'readwrite'),links=tx.objectStore(storeName);let result={linked:false};
  const id=mediaIdentity(item),request=tx.objectStore('downloads').get(ownerKey);request.onsuccess=()=>{
   const owner=request.result;if(!owner||!['complete','queued','downloading','paused','retry-wait','verifying','converting'].includes(owner.state)||assetIdentity(owner.item?.url).asset!==assetIdentity(item.url).asset)return;
   if(!owner.sourceGeneration){owner.sourceGeneration=crypto.randomUUID();owner.assetKey=assetIdentity(owner.item.url).asset;owner.usableAssetKey=owner.assetKey;tx.objectStore('downloads').put(owner)}
   const prior=links.get(id);prior.onsuccess=()=>{const old=prior.result,sourceGeneration=generation(owner);
    if(old){result={linked:old.downloadKey===ownerKey&&old.sourceGeneration===sourceGeneration,conflict:old.downloadKey!==ownerKey||old.sourceGeneration!==sourceGeneration,id};return}
    links.add({id,tweetId:String(item.tweetId),mediaId:String(item.mediaId||''),asset:assetIdentity(item.url).asset,sourceUrl:item.url,downloadKey:ownerKey,ownerPostId:String(owner.item?.tweetId||''),sourceGeneration,linkedAt:Date.now()});
    if(names.includes('checkpoints')){const revision=tx.objectStore('checkpoints').get('library-download-query-revision');revision.onsuccess=()=>tx.objectStore('checkpoints').put({key:'library-download-query-revision',revision:Number(revision.result?.revision||0)+1,updatedAt:Date.now()})}result={linked:true,id};
   };
  };
  tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error||Error('Shared-file association aborted'));tx.onerror=()=>reject(tx.error||Error('Shared-file association failed'));
 });
}

export function remapSharedFile(transaction,oldKey,newKey){
 if(!transaction.db.objectStoreNames.contains(storeName))return;
 const links=transaction.objectStore(storeName),request=links.index('downloadKey').openCursor(IDBKeyRange.only(oldKey));
 request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;cursor.update({...cursor.value,downloadKey:newKey});cursor.continue()};
}

export function collectSharedPostIds(transaction,downloadKey,ids){
 if(!transaction.db.objectStoreNames.contains(storeName))return;
 const request=transaction.objectStore(storeName).index('downloadKey').openCursor(IDBKeyRange.only(downloadKey));
 request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(ids.size>=1000){ids.truncated=true;return}ids.add(String(cursor.value.tweetId));cursor.continue()};
}

export function readSharedFiles(database,ids,{limit=3200,perPostLimit=64}={}){
 if(!database.objectStoreNames.contains(storeName))return Promise.resolve([]);
 return new Promise((resolve,reject)=>{
  const tx=database.transaction([storeName,'downloads'],'readonly'),index=tx.objectStore(storeName).index('tweetId'),downloads=tx.objectStore('downloads'),rows=[];let requested=0;
  for(const id of new Set(ids.map(String))){let count=0;const request=index.openCursor(IDBKeyRange.only(id));request.onsuccess=()=>{rows.cursorOperations=(rows.cursorOperations||0)+1;const cursor=request.result;if(!cursor)return;if(count>=perPostLimit||requested>=limit){rows.truncated=true;return}count++;requested++;const link=cursor.value,owner=downloads.get(link.downloadKey);owner.onsuccess=()=>{
    const row=owner.result,valid=row&&generation(row)===link.sourceGeneration;
    rows.push(valid?{...row,key:'shared:'+link.id,item:{...row.item,tweetId:link.tweetId,mediaId:link.mediaId||row.item?.mediaId,url:link.sourceUrl},association:{kind:'shared',downloadKey:link.downloadKey,ownerPostId:link.ownerPostId,sourceGeneration:link.sourceGeneration}}:{key:'shared:'+link.id,state:'missing',verificationState:'missing',item:{tweetId:link.tweetId,mediaId:link.mediaId,url:link.sourceUrl},association:{kind:'shared',downloadKey:link.downloadKey,ownerPostId:link.ownerPostId,sourceGeneration:link.sourceGeneration,unavailable:true}});
   };cursor.continue()};
  }
  tx.oncomplete=()=>resolve(rows);tx.onabort=()=>reject(tx.error||Error('Shared-file read aborted'));tx.onerror=()=>reject(tx.error||Error('Shared-file read failed'));
 });
}
