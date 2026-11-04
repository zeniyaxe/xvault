const assert = require('node:assert/strict');
const model = require('../library-model.js');

// A broken clamp or overscan would hide records or let DOM grow with the archive.
assert.equal(typeof model.virtualWindow, 'function', 'Compact view needs a bounded viewport window');
for (const count of [0, 1, 100, 1000, 10000, 50000]) {
  for (const top of [0, 375, count * 76, -100]) {
    const window = model.virtualWindow(count, top, 600, 76, 3);
    assert.ok(window.start >= 0 && window.end <= count && window.start <= window.end);
    assert.ok(window.end - window.start <= 15, 'viewport DOM must stay bounded');
    assert.equal(window.before + (window.end - window.start) * 76 + window.after, count * 76);
  }
}
assert.deepEqual(model.virtualWindow(100, 760, 380, 76, 2), { start: 8, end: 17, before: 608, after: 6308 });
console.log('Library viewport windows: bounds, empty, overscan, and 50k passed');
