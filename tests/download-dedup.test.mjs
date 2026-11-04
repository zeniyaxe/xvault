// Structural guards only. The behavioral proof of deduplication is tests/download-queue-browser.mjs, which drives the
// real service worker and counts requests at a local server. These checks stop the single-authority wiring from eroding.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
assert.match(source, /async function enqueueCore\(/, 'one core enqueue path');
assert.match(source, /function enqueue\(items,force=false,context=\{\}\)\{const run=enqueueTail\.then\(\(\)=>enqueueCore\(items,force,context\)\)/, 'enqueue serializes concurrent callers');
assert.match(source, /decideEnqueue\(\{key,seenInRequest/, 'accept/skip is decided by the shared decision function');
assert.match(source, /const target=await targetFor[\s\S]*?row=\{key,item,target/, 'row key is the canonical identity, so a bug upstream can overwrite one row but never add a second');
assert.equal((source.match(/chrome\.downloads\.download\(/g) || []).length, 2, 'only startOne and the explicit self-test may start a Chrome download');
const startOne = source.slice(source.indexOf('async function startOne('), source.indexOf('function classifyDownloadError('));
assert.match(startOne, /const id=await chrome\.downloads\.download/);
assert.match(startOne, /await putMany\('downloads',\[row\]\)[\s\S]*?chrome\.downloads\.search\(\{id\}\)[\s\S]*?reconcileDownloadChange\(\{id,state:\{current:'complete'\}\},row\)/, 'a completion emitted before the ID write is recovered from Chrome');
assert.match(startOne, /automatic retry suppressed to prevent duplicate files/);
const discard = source.slice(source.indexOf('async function discardPreviousAttempt('), source.indexOf('async function startOne('));
assert.match(discard, /row\.downloadId=null/, 'the previous Chrome id is detached before anything is erased');
assert.match(discard, /item\.state==='complete'&&!knownBad\)return/, 'a good completed file is never deleted by a retry');
const reconcile = source.slice(source.indexOf('async function reconcileDownloadChange('), source.indexOf('chrome.downloads.onChanged.addListener('));
assert.match(reconcile, /retiredDownloadIds\?\.includes/, 'events for retired Chrome downloads are ignored');
assert.match(reconcile, /'retry-wait','queued'\]\.includes\(row\.state\)\)return/, 'rows that are already waiting do not process stale events');
assert.match(source,/source:messageCapability==='content'\?'x.com':'dashboard'/,'trusted extension tabs must not be mislabeled as X content scripts');
console.log('download dedup: single-authority structure intact');
