import test from 'node:test';
import assert from 'node:assert/strict';
import { createMissingPostFetcher } from '../sw/missing-posts.mjs';

function fakeChrome() {
  const tabs = new Map(),
    removed = [];
  let next = 10;
  return {
    removed,
    tabs,
    api: {
      tabs: {
        create: async info => {
          const tab = { id: next++, ...info };
          tabs.set(tab.id, tab);
          return tab;
        },
        get: async id => tabs.get(id) || Promise.reject(Error('gone')),
        remove: async id => (removed.push(id), tabs.delete(id)),
      },
    },
  };
}

test('fetches a missing parent through a background X tab and closes it', async () => {
  const chrome = fakeChrome();
  let polls = 0;
  const fetcher = createMissingPostFetcher({
    chromeApi: chrome.api,
    activeXTab: async () => ({ id: 1, windowId: 3 }),
    hasPost: async () => ++polls > 2,
    sleep: async () => {},
  });
  const result = await fetcher.fetchPost('123');
  assert.equal(result.found, true);
  assert.deepEqual(chrome.removed, [10]);
  assert.equal([...chrome.tabs.values()].length, 0);
});

test('requires an open X tab and validates IDs', async () => {
  const chrome = fakeChrome();
  const fetcher = createMissingPostFetcher({
    chromeApi: chrome.api,
    activeXTab: async () => null,
    hasPost: async () => false,
    sleep: async () => {},
  });
  assert.equal((await fetcher.fetchPost('5')).ok, false);
  await assert.rejects(fetcher.fetchPost('abc'));
});
