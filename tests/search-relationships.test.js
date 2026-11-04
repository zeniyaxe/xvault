const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../library-search-core.js');

const day = Date.UTC(2025, 4, 10);
const posts = [
  {
    id: '100',
    text: 'Launch thread #space with @nasa https://t.co/a',
    author: { handle: 'astro' },
    createdAt: '2025-05-10T08:00:00Z',
    archivedAt: day + 3600000,
    hashtags: ['space'],
    mentions: ['nasa'],
    links: ['https://www.github.com/xvault/releases'],
    language: 'en',
    conversationId: '100',
    media: [{ type: 'photo' }, { type: 'photo' }, { type: 'video' }],
  },
  {
    id: '101',
    text: 'Part two of the thread',
    author: { handle: 'astro' },
    createdAt: '2025-05-10T08:05:00Z',
    archivedAt: day + 7200000,
    replyToId: '100',
    replyToHandle: 'Astro',
    conversationId: '100',
    language: 'en',
    media: [],
  },
  {
    id: '102',
    text: 'Quoting this beautiful launch',
    author: { handle: 'fan' },
    createdAt: '2024-01-02T00:00:00Z',
    archivedAt: day - 86400000 * 30,
    quotedPostId: '100',
    language: 'fr',
    media: [{ type: 'photo' }],
  },
  { id: '103', text: 'RT @astro: Launch thread', author: { handle: 'fan' }, retweetedPostId: '100', media: [] },
];
const rows = posts.map((post, index) => S.projectPost(post, index));
const ids = query => S.searchRecords(rows, query).map(index => posts[index].id);

test('hashtags, mentions and linked domains', () => {
  assert.deepEqual(ids('#space'), ['100']);
  assert.deepEqual(ids('@nasa'), ['100']);
  assert.deepEqual(ids('domain:github.com'), ['100']);
  assert.deepEqual(ids('-#space is:original'), ['102']);
});

test('relationships: replies, self-threads, quotes and reposts', () => {
  assert.deepEqual(ids('is:reply'), ['101']);
  assert.deepEqual(ids('is:thread'), ['101']);
  assert.deepEqual(ids('is:quote'), ['102']);
  assert.deepEqual(ids('is:repost'), ['103']);
  assert.deepEqual(ids('is:rt'), ['103']);
  assert.deepEqual(ids('quotes:100'), ['102']);
  assert.deepEqual(new Set(ids('thread:100')), new Set(['100', '101']));
});

test('calendar filters and media counts', () => {
  assert.deepEqual(new Set(ids('on:2025-05-10')), new Set(['100', '101']));
  assert.deepEqual(ids('year:2024'), ['102']);
  assert.deepEqual(new Set(ids('archived-on:2025-05-10')), new Set(['100', '101']));
  assert.deepEqual(ids('media:>2'), ['100']);
  assert.deepEqual(ids('lang:fr'), ['102']);
});

test('invalid new filters explain themselves', () => {
  assert.match(S.queryIssues('on:2025-13-01')[0], /YYYY-MM-DD/);
  assert.match(S.queryIssues('is:everything')[0], /is: use/);
  assert.match(S.queryIssues('within:soon')[0], /24h/);
  assert.match(S.queryIssues('thread:abc')[0], /post ID/);
  assert.deepEqual(ids('is:everything'), []);
});

test('link domains are parsed without URL objects', () => {
  assert.deepEqual(S.linkDomains(['https://www.Example.com/a?b', 'http://sub.site.org:8080/x', 'mailto:x']), [
    'example.com',
    'sub.site.org',
  ]);
});
