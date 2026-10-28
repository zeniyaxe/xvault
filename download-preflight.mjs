import {assetIdentity} from './download-identity.mjs';
const escapeRegex=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function browserDownloadQuery(item){
 const url=String(item?.url||'');let prefix=url;
 try{const parsed=new URL(url);if(['pbs.twimg.com','video.twimg.com'].includes(parsed.hostname))prefix=parsed.origin+parsed.pathname.split('/').slice(0,parsed.hostname==='pbs.twimg.com'?3:3).join('/').replace(/\.(jpg|jpeg|png|webp|gif)(:.*)?$/i,'')}catch{}
 return{urlRegex:'^'+escapeRegex(prefix),limit:25,orderBy:['-startTime']};
}
export function chooseBrowserDownload(row,candidates,self){
 const asset=assetIdentity(row.item?.url).asset,target=String(row.target?.filename||'').replaceAll('\\','/');
 const intentional=['explicit-redownload','keep-both','new-for-post'].includes(row.requestedIntent);
 for(const item of candidates){
  if(!['complete','in_progress'].includes(item.state))continue;
  const same=assetIdentity(item.url).asset===asset;
  if(same&&item.byExtensionId&&item.byExtensionId!==self)return{action:'block',code:'foreign-download',presence:item.state,owner:item.byExtensionId};
  const knownBad=item.state==='complete'&&row.verifyRetried&&row.retiredDownloadIds?.includes(item.id);
  if(same&&!knownBad&&!intentional)return{action:'reuse',code:'browser-existing',presence:item.state,item};
  const file=String(item.filename||'').replaceAll('\\','/');
  if(target&&(file===target||file.endsWith('/'+target))&&!knownBad)return{action:'block',code:'target-collision',presence:item.state,owner:item.byExtensionId||null};
 }
 return{action:'start',code:'start-preflight',presence:'no-history-match'};
}
