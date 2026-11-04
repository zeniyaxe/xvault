import assert from 'node:assert/strict';
import { buildInsights, dayStreaks, orderThread, previewUrl, threadMarkdown } from '../vault-insights.mjs';

const DAY = 86400000;
const at = iso => Date.parse(iso);
const post = (id, handle, createdAt, extra = {}) => ({
  id,
  author: { handle, name: handle.toUpperCase() },
  text: `post ${id}`,
  createdAt,
  archivedAt: at('2026-03-01T12:00:00Z'),
  url: `https://x.com/${handle}/status/${id}`,
  media: [],
  ...extra,
});

const root = post('100', 'ann', '2025-01-01T10:00:00Z', { conversationId: '100', hashtags: ['Art'], language: 'en' });
const second = post('101', 'ann', '2025-01-01T10:05:00Z', {
  conversationId: '100',
  replyToId: '100',
  replyToHandle: 'ann',
});
const reply = post('102', 'bob', '2025-01-01T11:00:00Z', {
  conversationId: '100',
  replyToId: '100',
  replyToHandle: 'ann',
});
const third = post('103', 'ann', '2025-01-02T09:00:00Z', {
  conversationId: '100',
  replyToId: '101',
  replyToHandle: 'ann',
});
const quote = post('104', 'cy', '2025-01-03T09:00:00Z', {
  quotedPostId: '100',
  links: [{ url: 'https://example.com/a', domain: 'example.com' }],
  media: [{ id: 'm1', type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg' }],
});
const copy = post('105', 'dee', '2025-01-04T09:00:00Z', {
  media: [{ id: 'm1', type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg' }],
});

const insights = buildInsights([root, second, reply, third, quote, copy], { now: at('2026-03-01T13:00:00Z') });
assert.equal(insights.total, 6);
assert.equal(insights.authorsTotal, 4);
assert.equal(insights.authors[0].handle, 'ann', 'the most archived author ranks first');
assert.equal(insights.relationships.replies, 3);
assert.equal(insights.relationships.quotes, 1);
assert.ok(insights.relationships.selfThreads >= 1, 'self-replies by the root author form a thread');
assert.deepEqual(
  insights.sharedMedia.map(group => [group.mediaId, group.posts.map(String).sort()]),
  [['m1', ['104', '105']]],
  'the same media id archived from two posts is reported once'
);
assert.equal(insights.days.posted['2025-01-01'], 3);
assert.equal(insights.streaks.posted.longest, 4, 'four consecutive posting days');

assert.deepEqual(
  dayStreaks({ '2026-02-27': 1, '2026-02-28': 2, '2026-03-01': 1, '2026-02-20': 1 }, at('2026-03-01T08:00:00Z')),
  { longest: 3, longestEnd: '2026-03-01', current: 3, activeDays: 4 }
);
assert.equal(dayStreaks({ '2026-02-20': 1 }, at('2026-03-01T08:00:00Z')).current, 0, 'old streaks are not current');
assert.equal(
  dayStreaks({ '2026-02-28': 1 }, at('2026-02-28T00:00:00Z') + DAY + 5).current,
  1,
  'yesterday still counts'
);

const thread = orderThread(third, [root, second], [reply], [quote]);
assert.equal(thread.rootId, '100');
assert.deepEqual(
  thread.posts.map(item => [item.id, item.spine]),
  [
    ['100', true],
    ['101', true],
    ['102', false],
    ['103', true],
  ],
  'posts are ordered by time and only the root author chain is the spine'
);
assert.equal(thread.missingParent, null);
assert.equal(orderThread(reply, [], [], []).missingParent, '100', 'an unarchived parent is reported');

const markdown = threadMarkdown(thread);
assert.match(markdown, /^# Thread by @ann \(ANN\)/);
assert.ok(markdown.includes('post 103') && !markdown.includes('post 102'), 'replies are excluded by default');
assert.ok(threadMarkdown(thread, { includeReplies: true }).includes('> post 102'), 'replies are quoted when included');

assert.match(previewUrl('https://pbs.twimg.com/media/A.jpg?format=jpg&name=orig'), /name=small/);
assert.equal(previewUrl('https://pbs.twimg.com/media/A.png'), 'https://pbs.twimg.com/media/A?format=png&name=small');
assert.equal(previewUrl('https://example.com/a.jpg'), '', 'previews only load from the X image CDN');
assert.equal(previewUrl('not a url'), '');
console.log('Vault insights: aggregation, shared media, streaks, thread ordering, markdown, previews passed');
