import assert from 'node:assert/strict';
import { CONTENT, DESKTOP, createMessageRouter } from '../sw/router.mjs';

const router = createMessageRouter();
const seen = [];
router.register('PING', async (message, sender) => (seen.push([message.type, sender?.id]), 'pong'));
router.register('CAPTURE', message => ({ ok: true, n: message.n }), { allow: [DESKTOP, CONTENT] });
router.mount({ types: ['A_ONE', 'A_TWO'], handle: message => `service:${message.type}` }, { denied: 'Desktop only' });

assert.deepEqual(router.types(), ['A_ONE', 'A_TWO', 'CAPTURE', 'PING']);
assert.equal(router.has('PING'), true);
assert.equal(router.has('NOPE'), false);
assert.deepEqual(router.policy('CAPTURE'), [DESKTOP, CONTENT]);
assert.equal(router.policy('NOPE'), null);

assert.deepEqual(await router.dispatch({ type: 'PING' }, DESKTOP, { id: 'tab' }), { handled: true, value: 'pong' });
assert.deepEqual(seen, [['PING', 'tab']]);
assert.deepEqual(await router.dispatch({ type: 'CAPTURE', n: 2 }, CONTENT), {
  handled: true,
  value: { ok: true, n: 2 },
});
assert.deepEqual(await router.dispatch({ type: 'A_TWO' }, DESKTOP), { handled: true, value: 'service:A_TWO' });

// Unknown types fall through to the legacy handlers; disallowed senders are rejected before the handler runs.
assert.deepEqual(await router.dispatch({ type: 'LEGACY' }, DESKTOP), { handled: false });
assert.deepEqual(await router.dispatch(null, DESKTOP), { handled: false });
await assert.rejects(router.dispatch({ type: 'PING' }, CONTENT), /only available from XVault pages/);
await assert.rejects(router.dispatch({ type: 'A_ONE' }, CONTENT), /Desktop only/);
assert.equal(seen.length, 1);

assert.throws(() => router.register('PING', () => {}), /Duplicate message route: PING/);

console.log('router tests passed');
