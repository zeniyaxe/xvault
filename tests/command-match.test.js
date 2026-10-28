const test = require('node:test');
const assert = require('node:assert/strict');
const { score } = require('../command-match.js');

test('prefix beats substring beats fuzzy; misses are null', () => {
  const prefix = score('Open Library', '', 'open');
  const sub = score('Reopen Library', '', 'open');
  const fuzzy = score('Open Library', '', 'olby');
  assert.ok(prefix > sub && sub > fuzzy && fuzzy > 0);
  assert.equal(score('Open Library', '', 'zzz'), null);
  assert.equal(score('Anything', '', ''), 0);
});
