// XVault 26: the per-host download circuit breaker.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHostBreaker } from '../sw/host-breaker.mjs';

test('a streak of throttle failures parks only that host, then a probe decides', () => {
  let clock = 1_000_000;
  const breaker = createHostBreaker({ now: () => clock });
  for (let i = 0; i < 3; i++) assert.equal(breaker.failure('video.twimg.com', 'SERVER_FAILED').opened, false);
  assert.equal(breaker.isOpen('video.twimg.com'), false);
  const trip = breaker.failure('video.twimg.com', 'NETWORK_FAILED');
  assert.equal(trip.opened, true);
  assert.equal(trip.until, clock + 30000);
  assert.equal(breaker.isOpen('video.twimg.com'), true);
  assert.equal(breaker.isOpen('pbs.twimg.com'), false, 'other hosts keep downloading');
  assert.deepEqual(
    breaker.snapshot().map(row => row.host),
    ['video.twimg.com']
  );
  assert.equal(breaker.nextChange(), clock + 30000);
  clock += 30001;
  assert.equal(breaker.isOpen('video.twimg.com'), false, 'the cooldown ends');
  // The probe fails: the breaker re-opens at once at the next level (60 s).
  const again = breaker.failure('video.twimg.com', 'SERVER_FAILED');
  assert.equal(again.opened, true);
  assert.equal(again.until, clock + 60000);
  clock += 60001;
  breaker.success('video.twimg.com');
  assert.equal(breaker.isOpen('video.twimg.com'), false);
  for (let i = 0; i < 3; i++) breaker.failure('video.twimg.com', 'SERVER_FAILED');
  assert.equal(breaker.isOpen('video.twimg.com'), false, 'a success forgets the streak and the level');
});

test('only push-back counts; old failures fall out of the window; cooldown is capped', () => {
  let clock = 0;
  const breaker = createHostBreaker({ now: () => clock, threshold: 2 });
  assert.equal(breaker.failure('pbs.twimg.com', 'FILE_NO_SPACE').opened, false);
  assert.equal(breaker.failure('pbs.twimg.com', 'HTTP 404').opened, false);
  assert.equal(breaker.isOpen('pbs.twimg.com'), false, 'a full disk or a missing file is not the host');
  breaker.failure('pbs.twimg.com', 'HTTP 429');
  clock += 61000;
  assert.equal(breaker.failure('pbs.twimg.com', 'HTTP 429').opened, false, 'the streak restarts after the window');
  let last;
  for (let i = 0; i < 20; i++) {
    last = breaker.failure('pbs.twimg.com', 'HTTP 503');
    if (last.opened) clock = last.until + 1;
  }
  assert.ok(breaker.snapshot().length <= 1);
  assert.ok(last.until - (clock - 1) <= 5 * 60000 || !last.opened, 'never longer than 5 minutes');
  breaker.reset();
  assert.equal(breaker.snapshot().length, 0);
  assert.equal(breaker.nextChange(), 0);
});
