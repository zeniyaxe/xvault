const test = require('node:test');
const assert = require('node:assert/strict');
const ranking = require('../search-ranking.js');

test('usage is recorded per operator and per filter, once per query', () => {
  const now = Date.UTC(2026, 0, 10);
  let usage = ranking.recordUsage({}, 'from:alice -tag:art from:alice "quoted text" ocr:"menu card"', now);
  assert.equal(usage['from:'].count, 1);
  assert.equal(usage['from:alice'].count, 1);
  assert.equal(usage['tag:art'].count, 1);
  assert.equal(usage['ocr:menu card'].count, 1);
  usage = ranking.recordUsage(usage, 'from:alice', now);
  assert.equal(usage['from:alice'].count, 2);
});

test('frequently and recently used suggestions rank higher within a match tier', () => {
  const now = Date.UTC(2026, 0, 10);
  const usage = { 'tag:': { count: 9, last: now }, 'thread:': { count: 9, last: now - 120 * 86400000 } };
  const entries = [{ value: 'thread:' }, { value: 'tag:' }, { value: 'text:' }];
  assert.deepEqual(
    ranking.rank(entries, { needle: 't', usage, now }).map(entry => entry.value),
    ['tag:', 'thread:', 'text:']
  );
  // A better text match still beats usage.
  assert.equal(ranking.rank(entries, { needle: 'thr', usage, now })[0].value, 'thread:');
  assert.ok(ranking.weight(usage['tag:'], now) > ranking.weight(usage['thread:'], now));
});

test('word-prefix matches in descriptions are found', () => {
  const list = ranking.rank([{ value: 'alice', haystack: 'alice wonder land' }], { needle: 'won' });
  assert.equal(list.length, 1);
  assert.equal(list[0].text, 2.5);
});
