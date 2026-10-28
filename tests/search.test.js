const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../library-search-core.js');

const posts = [
  {
    id: '1',
    text: 'Sunset over the bay https://x.com/alice/status/1',
    author: { handle: 'alice' },
    archivedAt: 30,
    media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg' }],
    userMeta: { tags: ['Nature'], favorite: true },
    metrics: { likes: 1500 },
    createdAt: '2024-03-01T00:00:00Z',
  },
  {
    id: '2',
    text: 'Cat video',
    author: { handle: 'bob' },
    archivedAt: 20,
    media: [{ type: 'video', url: 'https://video.twimg.com/ext_tw_video/9/pu/vid/a.mp4' }],
    userMeta: { tags: ['cats'] },
    metrics: { likes: 20 },
  },
  { id: '3', text: 'Plain words, no media', author: { handle: 'carol' }, archivedAt: 10, media: [] },
];
const rows = posts.map((p, i) => S.projectPost(p, i));
const ids = q => S.searchRecords(rows, q).map(i => posts[i].id);

test('text and phrase search', () => {
  assert.deepEqual(ids('cat'), ['2']);
  assert.deepEqual(ids('"no media"'), ['3']);
  assert.deepEqual(ids(''), ['1', '2', '3']);
});

test('structured filters', () => {
  assert.deepEqual(ids('from:@Bob'), ['2']);
  assert.deepEqual(ids('type:video'), ['2']);
  assert.deepEqual(ids('has:media'), ['1', '2']);
  assert.deepEqual(ids('tag:nature'), ['1']);
  assert.deepEqual(ids('fav:true'), ['1']);
  assert.deepEqual(ids('likes:>1k'), ['1']);
  assert.deepEqual(ids('likes:<=20'), ['2', '3']);
});

test('negation excludes matches', () => {
  assert.deepEqual(ids('-from:alice'), ['2', '3']);
  assert.deepEqual(ids('has:media -type:video'), ['1']);
  assert.deepEqual(ids('-cat'), ['1', '3']);
});

test('alternatives with | match any value', () => {
  assert.deepEqual(ids('from:alice|carol'), ['1', '3']);
  assert.deepEqual(ids('type:video|image'), ['1', '2']);
  assert.deepEqual(ids('-from:alice|bob'), ['3']);
});

test('URLs are searched as text rather than rejected as filters', () => {
  assert.deepEqual(ids('https://x.com/alice/status/1'), ['1']);
  assert.deepEqual(S.queryIssues('https://x.com/alice'), []);
});

test('invalid filters report actionable issues', () => {
  assert.equal(S.queryIssues('before:2024-02-31').length, 1);
  assert.equal(S.queryIssues('bogus:1').length, 1);
  assert.equal(S.queryIssues('type:video|nope').length, 1);
  assert.deepEqual(ids('bogus:1'), []);
});

test('date filters use UTC day boundaries', () => {
  assert.deepEqual(ids('after:2024-02-29'), ['1']);
  assert.deepEqual(ids('before:2024-03-01'), []);
});

test('usesRuleKind sees kinds nested in alternatives', () => {
  assert.equal(S.usesRuleKind(S.compileQuery('downloaded:true|false'), ['downloaded']), true);
  assert.equal(S.usesRuleKind(S.compileQuery('-missing:true'), ['missing']), true);
  assert.equal(S.usesRuleKind(S.compileQuery('cat from:bob'), ['downloaded', 'size']), false);
});

test('sorts: newest first by default, oldest, author', () => {
  assert.deepEqual(
    S.searchRecords(rows, '', 'old').map(i => posts[i].id),
    ['3', '2', '1']
  );
  assert.deepEqual(
    S.searchRecords(rows, '', 'author').map(i => posts[i].id),
    ['1', '2', '3']
  );
});
