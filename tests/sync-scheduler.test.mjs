import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncScheduler, dueScopes, pickTemplate, intervalFor, failureDelay } from '../sw/sync-scheduler.mjs';

const HOUR = 3600000;

test('due scopes respect opt-in, pause, intervals and failure backoff', () => {
  const settings = { syncEnabled: true, syncBookmarksMinutes: 60, syncLikesMinutes: 0 };
  assert.deepEqual(dueScopes(settings, { lastRun: {} }, 10 * HOUR), ['bookmarks']);
  assert.deepEqual(dueScopes({ ...settings, syncEnabled: false }, { lastRun: {} }, 10 * HOUR), []);
  assert.deepEqual(dueScopes({ ...settings, syncPaused: true }, { lastRun: {} }, 10 * HOUR), []);
  assert.deepEqual(dueScopes(settings, { lastRun: { bookmarks: 9.5 * HOUR } }, 10 * HOUR), []);
  assert.deepEqual(dueScopes(settings, { lastRun: {}, retryAt: { bookmarks: 11 * HOUR } }, 10 * HOUR), []);
  assert.equal(intervalFor({ syncBookmarksMinutes: 5 }, 'bookmarks'), 30 * 60000, 'minimum interval is 30 minutes');
  assert.ok(failureDelay(3, HOUR) > failureDelay(1, HOUR));
});

test('template choice prefers the bookmark operation', () => {
  const templates = {
    a: { operation: 'Likes', pagePath: '/i/history/likes' },
    b: { operation: 'Bookmarks', pagePath: '/i/history' },
  };
  assert.equal(pickTemplate(templates, 'bookmarks').operation, 'Bookmarks');
  assert.equal(pickTemplate(templates, 'likes').operation, 'Likes');
  assert.equal(pickTemplate({}, 'likes'), null);
});

test('a scheduled run opens a background tab, waits for completion, closes it and notifies matches', async () => {
  let clock = 100 * HOUR;
  const local = {},
    removed = [],
    notes = [],
    sent = [];
  const jobs = new Map();
  const chromeApi = {
    storage: { local: { get: async key => ({ [key]: local[key] }), set: async value => Object.assign(local, value) } },
    alarms: { create: async () => {}, clear: async () => {} },
    tabs: {
      create: async info => ({ id: 42, ...info }),
      get: async id => ({ id, status: 'complete' }),
      remove: async id => removed.push(id),
    },
  };
  const settings = {
    syncEnabled: true,
    syncBookmarksMinutes: 60,
    syncLikesMinutes: 0,
    syncMaxPages: 2,
    syncNotifyViews: ['v1'],
    savedViews: [{ id: 'v1', name: 'Cats', query: 'cat' }],
  };
  local.graphqlTemplates = { t: { operation: 'Bookmarks', pagePath: '/i/history' } };
  const scheduler = createSyncScheduler({
    chromeApi,
    now: () => clock,
    sleep: async () => {},
    getSettings: async () => settings,
    setSettings: async patch => Object.assign(settings, patch),
    activeXTab: async () => ({ id: 1, windowId: 7 }),
    sendToX: async (tabId, message) => {
      sent.push(message);
      return message.type === 'XV_GET_TEMPLATES' ? { ok: true, templates: {} } : { ok: true };
    },
    getJob: async id => jobs.get(id),
    postsArchivedSince: async () => [
      { id: '1', text: 'a cat', sourceFlags: ['bookmarks'] },
      { id: '2', text: 'a dog', sourceFlags: ['bookmarks'] },
    ],
    matchesQuery: (post, query) => post.text.includes(query),
    notify: async (title, message) => notes.push(title),
  });
  let status = await scheduler.tick();
  assert.equal(status.current.scope, 'bookmarks');
  const start = sent.find(message => message.type === 'XV_SMART_START');
  assert.equal(start.scheduled, true);
  assert.equal(start.maxPages, 2);
  assert.equal(start.template.operation, 'Bookmarks');
  // Still running: the next tick only checks on it.
  status = await scheduler.tick();
  assert.ok(status.current);
  jobs.set(start.runId, { state: 'complete' });
  clock += 60000;
  status = await scheduler.tick();
  assert.equal(status.current, null);
  assert.deepEqual(removed, [42]);
  assert.equal(status.lastResult.bookmarks.added, 2);
  assert.deepEqual(notes, ['1 new in “Cats”']);
  assert.ok(status.next.bookmarks > clock);
});
