// Two real unpacked copies, one shared browser download directory, no personal profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
const pw=createRequire(import.meta.url)(process.argv[2]||'playwright');
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'xvault-installations-'));
const copies=[path.join(scratch,'copy-a'),path.join(scratch,'copy-b')],downloadDir=path.join(scratch,'downloads');
for(const copy of copies)await fs.cp(path.resolve('.'),copy,{recursive:true,filter:source=>!['tests','tools','output','.playwright-mcp','XVault.zip'].includes(path.relative(path.resolve('.'),source).split(path.sep)[0])});
await fs.mkdir(downloadDir);
await fs.mkdir(path.join(scratch,'profile','Default'),{recursive:true});await fs.writeFile(path.join(scratch,'profile','Default','Preferences'),JSON.stringify({download:{default_directory:downloadDir,prompt_for_download:false,directory_upgrade:true}}));
let hits=0;
const server=http.createServer((req,res)=>{if(!req.headers.range)hits++;const body=Buffer.alloc(40000);body.set([255,216,255]);res.writeHead(200,{'content-type':'image/jpeg','content-length':body.length});res.end(body)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const context=await pw.chromium.launchPersistentContext(path.join(scratch,'profile'),{headless:true,executablePath:process.argv[3],acceptDownloads:true,downloadsPath:downloadDir,args:[`--disable-extensions-except=${copies.join(',')}`,`--load-extension=${copies.join(',')}`]});
try{
 const until=Date.now()+30000;while(context.serviceWorkers().length<2&&Date.now()<until)await new Promise(r=>setTimeout(r,100));
 const workers=context.serviceWorkers();assert.equal(workers.length,2,'both unpacked copies really loaded');
 const ids=workers.map(w=>new URL(w.url()).hostname),pages=[];
 for(const id of ids){const page=await context.newPage();await page.goto(`chrome-extension://${id}/dashboard.html`);await page.evaluate(()=>chrome.runtime.sendMessage({type:'SET_SETTINGS',settings:{onboardingComplete:true,healthCheckOnStartup:false,fileNaming:'id',mediaFolder:'CopyTest',organizeByType:false,organizeByAuthor:false,organizeByDate:false,skipDuplicateDownloads:true}}));pages.push(page)}
 await context.route('https://x.com/**',route=>route.fulfill({contentType:'text/html',body:'<html><body><article data-testid="tweet"><a href="https://x.com/fixture/status/9900001"><time>Now</time></a><div data-testid="tweetText">Synthetic post</div><div role="group"></div></article></body></html>'}));
 if(!process.argv.includes('--no-marker')){const x=await context.newPage();await x.goto('https://x.com/xvault-fixture');await x.waitForFunction(()=>document.documentElement.dataset.xvInstances?.split(',').filter(Boolean).length===2)}
 if(process.argv.includes('--race-preflight'))for(const worker of workers)await worker.evaluate(()=>{const search=chrome.downloads.search.bind(chrome.downloads);chrome.downloads.search=async query=>{const rows=await search(query);if(query.urlRegex||query.filenameRegex)await new Promise(resolve=>setTimeout(resolve,500));return rows}});
 for(const worker of workers)await worker.evaluate(()=>{globalThis.__downloadEvents=[];chrome.downloads.onCreated.addListener(row=>__downloadEvents.push({type:'created',id:row.id,installation:row.byExtensionId}));chrome.downloads.onChanged.addListener(row=>__downloadEvents.push({type:'changed',id:row.id,state:row.state?.current}));chrome.downloads.onErased.addListener(id=>__downloadEvents.push({type:'erased',id}))});
 const url=`http://127.0.0.1:${server.address().port}/asset.jpg`;
 const requests=await Promise.all(pages.map(p=>p.evaluate(url=>chrome.runtime.sendMessage({type:'QUEUE_DOWNLOADS',items:[{url,tweetId:'9900001',index:1,mediaType:'image'}]}),url)));
 await new Promise(r=>setTimeout(r,1800));
 const files=(await fs.readdir(downloadDir,{recursive:true})).filter(name=>!name.endsWith('.crdownload'));
 const decisions=await Promise.all(pages.map(p=>p.evaluate(()=>chrome.runtime.sendMessage({type:'GET_DOWNLOAD_DECISIONS',limit:30}))));
 const events=await Promise.all(workers.map(w=>w.evaluate(()=>__downloadEvents)));
 const evidence={ids,hits,files,uniquified:files.filter(name=>/ \(\d+\)/.test(name)).length,requests,codes:decisions.map(result=>result.rows?.map(row=>row.code)),events};
 await fs.writeFile(path.join(scratch,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify({scratch,hits,files,uniquified:evidence.uniquified,codes:evidence.codes}));
 assert.equal(hits,process.argv.includes('--no-marker')?1:0,'competing installations must never fetch the same physical asset twice');
 assert.equal(files.length,process.argv.includes('--no-marker')?1:0);if(!process.argv.includes('--no-marker'))assert.ok(requests.every(result=>result.blocked&&result.code==='multiple-installations'));
 if(!process.argv.includes('--no-marker'))assert.ok(decisions.every(result=>result.rows.some(row=>row.code==='multiple-installations'&&row.installationId)));
 console.log(process.argv.includes('--no-marker')?'PASS browser-history foreign-file guard (not an atomic cross-install lock)':'PASS two real unpacked installations refuse ambiguous queue requests without modifying either archive');
}finally{await context.close();await new Promise(resolve=>server.close(resolve))}
