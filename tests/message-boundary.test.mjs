import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeMessage } from '../message-boundary.mjs';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const dash = { id: ID, url: `chrome-extension://${ID}/dashboard.html`, frameId: 0 };
const x = { id: ID, url: 'https://x.com/home', tab: { id: 4 }, frameId: 0 };

test('dashboard is a desktop context', () => {
  assert.equal(authorizeMessage({ type: 'CLEAR_LIBRARY' }, dash, ID), 'desktop');
});

test('foreign extensions and malformed messages are rejected', () => {
  assert.throws(() => authorizeMessage({ type: 'STATS' }, { ...x, id: 'other' }, ID));
  assert.throws(() => authorizeMessage(null, x, ID));
  assert.throws(() => authorizeMessage({ type: 'x'.repeat(81) }, x, ID));
});

test('remote commands only from the top dashboard frame', () => {
  assert.throws(() =>
    authorizeMessage({ type: 'REMOTE_COMMAND' }, { ...dash, url: `chrome-extension://${ID}/sidepanel.html` }, ID)
  );
  assert.throws(() => authorizeMessage({ type: 'REMOTE_COMMAND' }, { ...dash, frameId: 3 }, ID));
});

test('X content scripts are limited to capture actions', () => {
  assert.throws(() => authorizeMessage({ type: 'CLEAR_LIBRARY' }, x, ID), /dashboard/);
  assert.throws(() => authorizeMessage({ type: 'STATS' }, { ...x, url: 'https://evil.example/' }, ID));
  assert.throws(() => authorizeMessage({ type: 'STATS' }, { ...x, frameId: 2 }, ID));
  assert.throws(() => authorizeMessage({ type: 'SET_SETTINGS', settings: { downloadFolder: 'x' } }, x, ID));
  assert.throws(() =>
    authorizeMessage({ type: 'QUEUE_DOWNLOADS', items: [{ url: 'https://evil.example/a.mp4' }] }, x, ID)
  );
  assert.throws(() =>
    authorizeMessage(
      {
        type: 'STORE_CAPTURE_TEMPLATES',
        templates: [{ operation: '__proto__', url: 'https://x.com/i/api/graphql/a/__proto__' }],
      },
      x,
      ID
    )
  );
});

test('captured relationship and entity fields are validated at the content boundary', async () => {
  const { authorizeMessage } = await import('../message-boundary.mjs');
  const sender = { id: 'ext', url: 'https://x.com/home', tab: { id: 1 }, frameId: 0 };
  const row = {
    id: '1',
    text: 'ok',
    quotedPostId: '2',
    retweetedPostId: '3',
    replyToHandle: 'someone_1',
    links: ['https://example.com/a'],
    hashtags: ['space'],
    mentions: ['nasa'],
  };
  assert.equal(authorizeMessage({ type: 'STORE_RECORDS', tweets: [row] }, sender, 'ext'), 'content');
  for (const bad of [
    { quotedPostId: 'abc' },
    { links: ['javascript:alert(1)'] },
    { links: Array.from({ length: 21 }, (_, i) => `https://e.com/${i}`) },
    { hashtags: ['has space'] },
    { mentions: ['bad-handle!'] },
    { replyToHandle: '<script>' },
  ])
    assert.throws(() => authorizeMessage({ type: 'STORE_RECORDS', tweets: [{ ...row, ...bad }] }, sender, 'ext'));
});

test('Firefox extension pages are identified by their per-install moz-extension origin', () => {
  const ff = 'moz-extension://11111111-2222-4333-8444-555555555555/';
  const page = { id: ID, url: `${ff}dashboard.html`, frameId: 0, tab: { id: 9 } };
  assert.equal(authorizeMessage({ type: 'CLEAR_LIBRARY' }, page, ID, ff), 'desktop');
  // Another add-on's page (different UUID) or a page claiming our id in its host is not ours.
  assert.throws(
    () =>
      authorizeMessage(
        { type: 'CLEAR_LIBRARY' },
        { ...page, url: 'moz-extension://99999999-2222-4333-8444-555555555555/dashboard.html' },
        ID,
        ff
      ),
    /content-script origin/
  );
  assert.throws(
    () => authorizeMessage({ type: 'CLEAR_LIBRARY' }, { ...page, url: `moz-extension://${ID}/dashboard.html` }, ID, ff),
    /content-script origin/
  );
  // A chrome-extension URL is not accepted when our own origin is moz-extension (and vice versa).
  assert.throws(() => authorizeMessage({ type: 'CLEAR_LIBRARY' }, dash, ID, ff));
  assert.throws(() => authorizeMessage({ type: 'CLEAR_LIBRARY' }, page, ID, `chrome-extension://${ID}/`));
  assert.throws(() => authorizeMessage({ type: 'CLEAR_LIBRARY' }, page, ID, 'not a url'));
});
