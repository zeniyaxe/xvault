// XVault 21: every service-worker message type is a router route, with the same sender policy
// authorizeMessage enforces (content scripts reach only CONTENT_ACTIONS types).
import assert from 'node:assert/strict';
import { readSource } from './source-text.mjs';
import { createMessageRouter, DESKTOP, CONTENT } from '../sw/router.mjs';
import { isContentAction } from '../message-boundary.mjs';

const worker = readSource('background.js');
const listener = worker.slice(worker.indexOf('chrome.runtime.onMessage.addListener('));
const body = listener.slice(0, listener.indexOf('\n});') + 4);
assert.doesNotMatch(body, /m\.type\s*===/, 'the onMessage listener no longer branches on message types');
assert.match(body, /router\.dispatch\(m, messageCapability, s\)/);
assert.match(body, /routed\.handled \? routed\.value : unknownMessage\(\)/);

const routed = [...worker.matchAll(/^route\(\s*(?:'([A-Z0-9_]+)'|\[([^\]]+)\])/gm)].flatMap(match =>
  match[1] ? [match[1]] : match[2].split(',').map(part => part.trim().replace(/'/g, ''))
);
assert.ok(routed.length >= 110, `legacy handlers were migrated (${routed.length})`);
assert.equal(new Set(routed).size, routed.length, 'no message type is routed twice');
for (const type of [
  'QUERY_LIBRARY_PAGE',
  'STORE_RECORDS',
  'QUEUE_DOWNLOADS',
  'DOWNLOAD_URLS',
  'GET_SETTINGS',
  'HEALTH_CHECK',
])
  assert.ok(routed.includes(type), `${type} is a route`);

// Unbounded whole-archive reads and the unauthenticated erase-everything message had no callers; removed.
for (const type of ['GET_ALL', 'GET_LIBRARY_ROWS', 'GET_LIBRARY_CHUNK', 'CLEAR_ALL'])
  assert.ok(!routed.includes(type), `${type} is no longer served`);

// Router semantics: capability is passed through and the allow-list is enforced.
const router = createMessageRouter();
router.register('A', (message, sender, capability) => ({ ok: true, capability, tab: sender?.tab?.id }), {
  allow: [DESKTOP, CONTENT],
});
router.register('B', () => ({ ok: true }));
assert.deepEqual(await router.dispatch({ type: 'A' }, CONTENT, { tab: { id: 4 } }), {
  handled: true,
  value: { ok: true, capability: CONTENT, tab: 4 },
});
await assert.rejects(router.dispatch({ type: 'B' }, CONTENT, {}), /only available from XVault pages/);
assert.deepEqual(await router.dispatch({ type: 'C' }, DESKTOP, {}), { handled: false });
assert.throws(() => router.register('A', () => {}), /Duplicate message route/);

// Content-script types keep their content access; dashboard-only types do not gain it.
assert.equal(isContentAction('STORE_RECORDS'), true);
assert.equal(isContentAction('QUERY_LIBRARY_PAGE'), false);
console.log('Router migration: all message types routed with the content-action policy passed');
