import test from 'node:test';
import assert from 'node:assert/strict';
import * as exporters from '../library-exporters.mjs';

const post = (id, at, extra = {}) => ({
  id,
  text: `post ${id}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, at)).toISOString(),
  author: { handle: 'alice', name: 'Alice' },
  ...extra,
});
const posts = [
  post('3', 3, { replyToId: '2', conversationId: '1' }),
  post('1', 1, { conversationId: '1' }),
  post('2', 2, {
    replyToId: '1',
    conversationId: '1',
    media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/x.jpg' }],
  }),
  post('4', 4, { replyToId: '2', author: { handle: 'bob' }, conversationId: '1', userMeta: { note: 'good point' } }),
  post('9', 0),
  // Older captures without conversationId still group through reply edges.
  post('20', 10),
  post('21', 11, { replyToId: '20' }),
  post('30', 12, { replyToId: '999', replyToHandle: 'carol' }),
];

test('threads group by conversation and reply chains, oldest first', () => {
  const groups = exporters.threadGroups(posts.map(exporters.threadKeyRow));
  assert.deepEqual(
    groups.map(group => [...group.ids].sort()),
    [['9'], ['1', '2', '3', '4'], ['20', '21'], ['30']]
  );
});

test('thread rendering keeps chronology, relationships, media, notes and missing parents', () => {
  const thread = exporters.buildThread(posts.slice(0, 4));
  assert.deepEqual(
    thread.posts.map(item => item.id),
    ['1', '2', '3', '4']
  );
  assert.equal(thread.rootId, '1');
  assert.deepEqual(thread.participants, ['alice', 'bob']);
  const markdown = exporters.threadMarkdownNote(thread);
  assert.match(markdown, /thread_id: "1"/);
  assert.match(markdown, /posts: 4/);
  assert.match(markdown, /## ↳ @bob/);
  assert.match(markdown, /reply to @alice/);
  assert.match(markdown, /!\[media 1\]\(https:\/\/pbs\.twimg\.com\/media\/x\.jpg\)/);
  assert.match(markdown, /\*\*Note:\*\* good point/);
  const html = exporters.htmlThreadHead() + exporters.htmlThread(thread) + exporters.htmlThreadFoot();
  assert.match(html, /<section class="thread"/);
  assert.match(html, /class="reply"/);
  assert.match(html, /' threads'/);
  const orphan = exporters.buildThread([posts[7]]);
  assert.equal(orphan.missingParent, '999');
  assert.match(exporters.threadMarkdownNote(orphan), /missing_parent: "999"/);
  assert.match(exporters.threadFileName(thread), /^2026-01-01 @alice thread 1\.md$/);
  assert.match(
    exporters.threadMarkdownIndex([{ file: 'threads/a.md', handle: 'alice', posts: 4, start: 0, text: 'hi' }]),
    /\| 4 \|/
  );
});
