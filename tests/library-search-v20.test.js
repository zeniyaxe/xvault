const assert = require('node:assert/strict');
const search = require('../library-search-core.js');

// Projection of the XVault 20 organisation and reading fields.
const base = {
  text: 'Post',
  author: { handle: 'ada' },
  media: [],
  archivedAt: 10,
  createdAt: '2026-01-01T00:00:00Z',
};
const posts = [
  {
    ...base,
    id: '1',
    archivedAt: 30,
    userMeta: {
      readLater: true,
      boards: ['inspo'],
      highlights: [{ text: 'The Analytical Engine', note: 'key idea' }],
    },
  },
  { ...base, id: '2', archivedAt: 20, userMeta: { readAt: 99, boards: ['work', 'inspo'] } },
  { ...base, id: '3', archivedAt: 10, userMeta: {} },
];
const scores = { 1: { 'about:engines': 0.4 }, 2: { 'about:engines': 0.9, 'similar:1': 0.5 } };
const rows = posts.map((post, index) =>
  search.projectPost(post, index, {
    boardNames: { inspo: 'Inspiration', work: 'Work stuff' },
    semanticScores: scores[post.id] || null,
  })
);
assert.equal(rows[0].later, true);
assert.equal(rows[0].highlightCount, 1);
assert.equal(rows[0].highlightText, 'the analytical engine key idea');
assert.deepEqual(rows[1].boardNames, ['work stuff', 'inspiration']);
assert.equal(rows[1].semanticScore, 0.9);
assert.equal(rows[2].semanticScore, 0);

const ids = query => search.searchRecords(rows, query, 'new').map(index => posts[index].id);
assert.deepEqual(ids('is:later'), ['1']);
assert.deepEqual(ids('-is:later'), ['2', '3'], 'negation is applied exactly once');
assert.deepEqual(ids('later:true'), ['1']);
assert.deepEqual(ids('later:false'), ['2', '3']);
assert.deepEqual(ids('-later:false'), ['1']);
assert.deepEqual(ids('later:maybe'), []);
assert.ok(search.queryIssues('later:maybe').length === 1);
assert.deepEqual(ids('is:read'), ['2']);
assert.deepEqual(ids('is:unread'), ['1', '3']);
assert.deepEqual(ids('is:highlighted'), ['1']);
assert.deepEqual(ids('has:highlight'), ['1']);
assert.deepEqual(ids('-has:highlight'), ['2', '3']);
assert.deepEqual(ids('highlight:analytical'), ['1']);
assert.deepEqual(ids('highlight:"key idea"'), ['1']);
assert.deepEqual(ids('has:board'), ['1', '2']);
assert.deepEqual(ids('board:inspo'), ['1', '2']);
assert.deepEqual(ids('board:work'), ['2']);
assert.deepEqual(ids('board:"work stuff"'), ['2'], 'boards match by display name too');
assert.deepEqual(ids('board:inspo -board:work'), ['1']);

// Meaning rules match only posts the worker scored, per rule key, and compose with other filters.
assert.deepEqual(ids('about:engines'), ['1', '2']);
assert.deepEqual(ids('about:engines is:later'), ['1']);
assert.deepEqual(ids('-about:engines'), ['3']);
assert.deepEqual(ids('similar:1'), ['2']);
assert.deepEqual(ids('related:1 about:engines'), ['2']);
assert.deepEqual(ids('meaning:engines'), ['1', '2'], 'meaning: is an alias');
assert.deepEqual(
  search.searchRecords(rows, 'about:engines', 'relevance').map(index => posts[index].id),
  ['2', '1']
);
assert.deepEqual(
  search.searchRecords(rows, '', 'relevance').map(index => posts[index].id),
  ['2', '1', '3'],
  'relevance falls back to newest first for equal scores'
);
const compiled = search.compileQuery('about:cats|dogs similar:9 tag:x');
assert.deepEqual(
  search.semanticRules(compiled).map(rule => search.semanticKey(rule)),
  ['about:cats', 'about:dogs', 'similar:9']
);
assert.equal(search.usesRuleKind(compiled, ['semantic']), true);
assert.equal(search.usesRuleKind(search.compileQuery('tag:x'), ['semantic']), false);

console.log('library search v20 tests passed');
