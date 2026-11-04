import assert from 'node:assert/strict';
import { createConcurrencyGovernor } from '../sw/adaptive-concurrency.mjs';

let clock = 1000;
const governor = createConcurrencyGovernor({ now: () => clock, streak: 3, cooldownMs: 5000 });

assert.equal(governor.status().limit, null);
assert.equal(governor.limit(4), 4, 'starts at the user ceiling');
assert.equal(governor.limit(99), 4, 'never grows past the ceiling it settled on without earning it');
assert.equal(governor.limit(0), 4, 'invalid ceilings fall back to 4');
assert.equal(governor.limit(2), 2, 'a lower ceiling clamps immediately');
assert.equal(governor.limit(6), 2);

// Ordinary failures do not slow the queue; throttling does, once per cooldown window.
assert.equal(governor.failure('FILE_NO_SPACE'), false);
assert.equal(governor.failure('SERVER_FAILED'), true);
assert.equal(governor.limit(6), 1);
assert.equal(governor.failure('NETWORK_FAILED'), false, 'already at the floor');
clock += 6000;
assert.equal(governor.failure('HTTP 429'), false, 'cannot go below the floor');
assert.equal(governor.limit(6), 1);

// Additive increase: one slot per clean streak, capped by the ceiling.
for (let index = 0; index < 3; index++) governor.success();
assert.equal(governor.limit(6), 2);
governor.success();
governor.failure('some other error'); // resets the clean streak without cutting
governor.success();
governor.success();
assert.equal(governor.limit(6), 2, 'streak was interrupted');
governor.success();
assert.equal(governor.limit(6), 3);
for (let index = 0; index < 30; index++) governor.success();
assert.equal(governor.limit(6), 6);
assert.equal(governor.limit(5), 5);

const events = governor.status().events;
assert.ok(events.length > 0 && events.length <= 30, 'event history is bounded');
assert.equal(events.find(event => event.kind === 'cut').detail, 'SERVER_FAILED');
assert.ok(events[0].at >= events.at(-1).at, 'newest first');

// Disabled: always the ceiling, state untouched.
assert.equal(governor.limit(3, false), 3);
governor.reset();
assert.equal(governor.status().limit, null);
assert.equal(governor.failure('SERVER_FAILED'), false, 'no limit to cut before the first pump');
assert.equal(governor.limit(8), 8);

console.log('adaptive concurrency tests passed');
