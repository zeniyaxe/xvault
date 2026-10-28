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
