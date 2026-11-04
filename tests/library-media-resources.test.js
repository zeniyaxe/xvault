const assert = require('node:assert/strict');
const model = require('../library-model.js');

let next = 0;
const revoked = [];
const pool = model.createMediaResourcePool({
  create: () => `blob:test-${++next}`,
  revoke: url => revoked.push(url)
});

const first = pool.add('GIF/a.webp', { size: 10 });
assert.equal(first, 'blob:test-1');
assert.equal(pool.attach('GIF/a.webp', 'card-a'), first);
assert.equal(pool.attach('GIF/a.webp', 'viewer'), first);
pool.detach('GIF/a.webp', 'card-a');
assert.deepEqual(revoked, [], 'a visible viewer must keep its media URL alive');
pool.detach('GIF/a.webp', 'viewer');
assert.deepEqual(revoked, [first], 'the final consumer releases the URL');
assert.equal(pool.get('GIF/a.webp'), null);

const second = pool.add('GIF/a.webp', { size: 10 });
assert.notEqual(second, first, 'a later visit gets a fresh URL');
pool.collect();
assert.deepEqual(revoked, [first, second], 'unclaimed fetch results are released');

const third = pool.add('GIF/b.webp', { size: 10 });
pool.attach('GIF/b.webp', 'card-b');
pool.clear();
assert.deepEqual(revoked, [first, second, third], 'leaving the dashboard releases mounted media');
console.log('library media resource lifecycle passed');
