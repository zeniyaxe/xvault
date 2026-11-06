// XVault 25: the capture inbox (phone "Capture", Capture page links, Web Share Target), simulated with a fake
// tabs API and an archive that records a post a moment after its page is opened.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTH_REASON,
  classifyCapture,
  classifyCapturePage,
  createCaptureInbox,
  parseCaptureText,
  parseCaptureUrl,
  prune,
} from '../sw/capture-inbox.mjs';

function harness({
  gone = [],
  hidden = [],
  login = [],
  pageText = {},
  xTab = true,
  archived = {},
  settings = {},
} = {}) {
  let clock = 5_000_000,
    nextTab = 20;
  const store = {},
    tabs = new Map(),
    posts = new Map(Object.entries(archived)),
    visits = [];
  const chromeApi = {
    storage: {
      local: {
        get: async key => ({ [key]: store[key] === undefined ? undefined : structuredClone(store[key]) }),
        set: async value => Object.assign(store, structuredClone(value)),
      },
    },
    tabs: {
      create: async options => {
        const tab = { id: nextTab++, ...options };
        tabs.set(tab.id, tab);
        return tab;
      },
      get: async id => {
        if (!tabs.has(id)) throw Error('No tab');
        return tabs.get(id);
      },
      update: async (id, { url }) => {
        tabs.get(id).url = url;
        const postId = /status\/(\d+)/.exec(url)[1];
        visits.push(postId);
        if (login.includes(postId))
          tabs.get(id).url = `https://x.com/i/flow/login?redirect_after_login=%2Fa%2Fstatus%2F${postId}`;
        else if (pageText[postId]) tabs.get(id).text = pageText[postId];
        else if (gone.includes(postId))
          posts.set(postId, { id: postId, availability: { state: 'deleted', checkedAt: clock + 1 } });
        else if (!hidden.includes(postId))
          posts.set(postId, {
            id: postId,
            archivedAt: clock + 1,
            text: 'Captured from the phone',
            author: { handle: 'ada', name: 'Ada' },
            media: [{ type: 'video' }],
          });
      },
      remove: async id => void tabs.delete(id),
    },
  };
  const inbox = createCaptureInbox({
    chromeApi,
    activeXTab: async () => (xTab ? { id: 1, windowId: 3 } : null),
    readPost: async id => posts.get(id) || null,
    getSettings: async () => settings,
    now: () => clock,
    sleep: async ms => void (clock += ms),
    pollMs: 400,
    visitTimeoutMs: 2000,
    gapMs: [100, 100],
    probePage: async id => ({ url: tabs.get(id)?.url || '', text: tabs.get(id)?.text || '' }),
  });
  return { inbox, store, tabs, visits, posts, advance: ms => (clock += ms) };
}

test('links: X, twitter and mirror URLs normalise to one canonical post; other links are refused', () => {
  assert.deepEqual(parseCaptureUrl('https://x.com/ada/status/123?s=20'), {
    id: '123',
    handle: 'ada',
    url: 'https://x.com/ada/status/123',
  });
  assert.equal(
    parseCaptureUrl('https://mobile.twitter.com/Ada_L/status/0456/photo/1')?.url,
    'https://x.com/Ada_L/status/456'
  );
  assert.equal(parseCaptureUrl('https://fxtwitter.com/ada/status/789')?.id, '789');
  assert.equal(parseCaptureUrl('https://x.com/i/web/status/42')?.url, 'https://x.com/i/status/42');
  assert.equal(parseCaptureUrl('https://x.com/i/status/42')?.handle, '');
  for (const bad of [
    'https://x.com/ada',
    'https://evil.example/ada/status/1',
    'javascript:alert(1)',
    'https://x.com/ada/status/abc',
    'https://x.com/a/b/status/1',
    'https://x.com.evil.example/ada/status/1',
    '',
  ])
    assert.equal(parseCaptureUrl(bad), null, bad);
  const shared = parseCaptureText(
    'Look at this https://x.com/ada/status/1, and https://twitter.com/ada/status/1 again; also (https://x.com/bob/status/2).'
  );
  assert.deepEqual(
    shared.map(link => link.id),
    ['1', '2']
  );
});

test('a phone link is archived through one background tab, then the tab closes', async () => {
  const { inbox, visits, tabs } = harness();
  const added = await inbox.add('https://x.com/ada/status/100', { source: 'remote', device: 'Pixel', deviceId: 'd1' });
  assert.equal(added.ok, true);
  assert.equal(added.added[0].state, 'queued');
  await inbox.run();
  const state = await inbox.list();
  assert.deepEqual(visits, ['100']);
  assert.equal(state.items[0].state, 'archived');
  assert.equal(state.items[0].source, 'remote');
  assert.equal(state.items[0].device, 'Pixel');
  assert.equal(state.items[0].preview.handle, 'ada');
  assert.equal(state.items[0].preview.video, true);
  assert.equal(tabs.size, 0, 'the capture tab is closed when the inbox is empty');
});

test('duplicates: an archived post answers at once and a waiting link is not queued twice', async () => {
  const { inbox, visits } = harness({
    archived: { 7: { id: '7', text: 'old', author: { handle: 'ada' } } },
    xTab: false,
  });
  const first = await inbox.add('https://x.com/ada/status/7 https://x.com/ada/status/8');
  assert.equal(first.added[0].duplicate, 'archived');
  assert.equal(first.added[0].state, 'duplicate');
  assert.equal(first.added[0].preview.text, 'old');
  await inbox.run();
  const again = await inbox.add('https://twitter.com/ada/status/8');
  assert.equal(again.added[0].duplicate, 'pending');
  assert.equal((await inbox.list()).items.filter(item => item.id === '8').length, 1);
  assert.deepEqual(visits, []);
});

test('without an x.com tab items wait with a reason and start once X is open', async () => {
  const world = harness({ xTab: false });
  await world.inbox.add('https://x.com/ada/status/9');
  await world.inbox.run();
  let item = (await world.inbox.list()).items[0];
  assert.equal(item.state, 'waiting');
  assert.match(item.error, /open X on the computer/);
  const ready = harness();
  Object.assign(ready.store, world.store);
  await ready.inbox.run();
  item = (await ready.inbox.list()).items[0];
  assert.equal(item.state, 'archived');
});

test('outcomes: unavailable posts, retries, failure, retry, remove, clear and pause', async () => {
  const { inbox, visits, advance } = harness({ gone: ['11'], hidden: ['12'] });
  await inbox.add('https://x.com/a/status/11 https://x.com/b/status/12');
  await inbox.run();
  let items = Object.fromEntries((await inbox.list()).items.map(item => [item.id, item]));
  assert.equal(items['11'].state, 'unavailable');
  // XVault 26: the second try came after a 20 s backoff; the third is scheduled 90 s later, not run at once.
  assert.equal(items['12'].state, 'queued');
  assert.match(items['12'].error, /trying again at/);
  assert.ok(items['12'].nextAttemptAt > 0);
  assert.deepEqual(visits, ['11', '12', '12']);
  assert.equal(items['12'].log.length, 2, 'each attempt is logged for diagnostics');
  assert.equal(items['12'].log[0].outcome, 'pending');
  advance(91000);
  await inbox.run();
  items = Object.fromEntries((await inbox.list()).items.map(item => [item.id, item]));
  assert.equal(items['12'].state, 'failed');
  assert.match(items['12'].error, /signed in to X/);
  assert.deepEqual(visits, ['11', '12', '12', '12'], 'a post X did not show is tried three times');
  await inbox.control('pause');
  await inbox.control('retry', '12');
  items = Object.fromEntries((await inbox.list()).items.map(item => [item.id, item]));
  assert.equal(items['12'].state, 'queued');
  assert.equal((await inbox.list()).paused, true);
  await inbox.run();
  assert.equal(visits.length, 4, 'a paused inbox does not visit');
  await inbox.control('remove', '12');
  await inbox.control('clear');
  assert.equal((await inbox.list()).items.length, 0);
  await assert.rejects(() => inbox.control('explode'), /Unknown capture inbox action/);
});

test('restart recovery, stored-post notices and the passive-capture requirement', async () => {
  const { inbox, store, posts } = harness({ settings: { captureWhileBrowsing: false } });
  await inbox.add('https://x.com/a/status/21 https://x.com/a/status/22');
  await inbox.run();
  assert.match((await inbox.list()).items[0].error, /Capture while browsing/);
  store.xvCaptureInbox.items[0].state = 'capturing';
  posts.set('22', { id: '22', text: 'arrived while browsing', author: { handle: 'a' } });
  await inbox.noticeStored(['22']);
  const byId = Object.fromEntries((await inbox.list()).items.map(item => [item.id, item]));
  assert.equal(byId['22'].state, 'archived');
  assert.equal(byId['22'].preview.text, 'arrived while browsing');
  const recovered = await inbox.recover();
  assert.ok(recovered.items.every(item => item.state !== 'capturing'));
});

test('bounds: classification and pruning keep pending items and drop old finished ones', () => {
  assert.equal(classifyCapture(null, 10), 'pending');
  assert.equal(classifyCapture({ archivedAt: 5, lastSeenAt: 11 }, 10), 'archived');
  assert.equal(classifyCapture({ availability: { state: 'suspended', checkedAt: 12 } }, 10), 'unavailable');
  const now = 100 * 86400000;
  const items = [
    { id: '1', state: 'queued', updatedAt: 0 },
    { id: '2', state: 'archived', updatedAt: 0 },
    { id: '3', state: 'archived', updatedAt: now - 1000 },
  ];
  assert.deepEqual(
    prune(items, now).map(item => item.id),
    ['1', '3']
  );
  const many = Array.from({ length: 450 }, (_, index) => ({
    id: String(index),
    state: 'archived',
    updatedAt: now - index,
  }));
  assert.equal(prune(many, now).length, 400);
  assert.equal(prune(many, now).at(-1).id, '399', 'the oldest finished items go first');
});

test('page classification: sign-in walls, rate limits, unavailable posts and X errors', () => {
  assert.equal(classifyCapturePage({ url: 'https://x.com/i/flow/login?redirect_after_login=%2Fa' }), 'auth');
  assert.equal(
    classifyCapturePage({ url: 'https://x.com/a/status/1', text: 'Sign in to X\nDon’t miss what’s happening' }),
    'auth'
  );
  assert.equal(classifyCapturePage({ url: 'https://x.com/a/status/1', text: 'Rate limit exceeded' }), 'rate-limited');
  assert.equal(
    classifyCapturePage({ text: 'Hmm...this page doesn’t exist. Try searching for something else.' }),
    'unavailable'
  );
  assert.equal(classifyCapturePage({ text: 'This post is unavailable.' }), 'unavailable');
  assert.equal(classifyCapturePage({ text: 'Something went wrong. Try reloading.' }), 'x-error');
  assert.equal(classifyCapturePage({ url: 'https://x.com/a/status/1', text: 'Ada @ada Hello world' }), 'unknown');
  assert.equal(classifyCapturePage({}), 'unknown');
});

test('a sign-in wall holds the whole inbox without spending attempts; Retry starts again', async () => {
  const { inbox, visits, tabs } = harness({ login: ['31'] });
  await inbox.add('https://x.com/a/status/31 https://x.com/a/status/32');
  await inbox.run();
  let list = await inbox.list();
  const items = Object.fromEntries(list.items.map(item => [item.id, item]));
  assert.deepEqual(visits, ['31'], 'nothing else is opened once X asks for a sign-in');
  assert.equal(items['31'].state, 'waiting');
  assert.equal(items['31'].attempts, 0, 'a sign-in wall does not count against the post');
  assert.equal(items['31'].error, AUTH_REASON);
  assert.equal(items['32'].state, 'waiting');
  assert.equal(list.authBlocked, true);
  assert.equal(items['31'].log.at(-1).detail, 'Sign-in wall');
  await inbox.run();
  assert.deepEqual(visits, ['31'], 'page loads do not hammer the sign-in wall');
  assert.equal(tabs.size, 0, 'the capture tab is closed');
  await inbox.control('retry-all');
  await inbox.run();
  list = await inbox.list();
  assert.ok(visits.length >= 2, 'Retry lifts the hold');
});

test('X limiting requests pauses every capture until the cooldown ends', async () => {
  const pageText = { 41: 'Rate limit exceeded' };
  const { inbox, visits, advance } = harness({ pageText });
  await inbox.add('https://x.com/a/status/41 https://x.com/a/status/42');
  await inbox.run();
  let list = await inbox.list();
  let items = Object.fromEntries(list.items.map(item => [item.id, item]));
  assert.deepEqual(visits, ['41']);
  assert.ok(list.cooldownUntil > 0, 'a cooldown is reported');
  assert.match(items['42'].error, /limiting requests/);
  assert.equal(items['41'].attempts, 0);
  await inbox.run();
  assert.deepEqual(visits, ['41'], 'nothing runs during the cooldown');
  // X stops limiting: the next visit to 41 loads normally.
  delete pageText[41];
  advance(5 * 60000 + 1000);
  await inbox.run();
  list = await inbox.list();
  items = Object.fromEntries(list.items.map(item => [item.id, item]));
  assert.ok(visits.includes('42'), 'captures resume after the cooldown');
  assert.equal(items['42'].state, 'archived');
  assert.equal(items['41'].state, 'archived', 'the limited capture is retried without spending an attempt');
  assert.equal(list.cooldownUntil || 0, 0, 'the cooldown clears after a success');
});
