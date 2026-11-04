// XVault 21: the background visit queue (repair / thread gaps / still-on-X), simulated end to end with a
// fake tabs API and an archive that "captures" posts when their page is opened.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyVisit, createStatusVisitor, dayKey, estimate, remainingToday } from '../sw/status-visitor.mjs';

function harness({ gone = [], hidden = [], xTab = true, found = {}, caps = { repair: 40, gaps: 40, check: 30 } } = {}) {
  let clock = 1_000_000,
    nextTab = 10;
  const store = {},
    tabs = new Map(),
    posts = new Map(),
    visits = [],
    checked = [];
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
        // The content script would capture the page a moment later.
        if (gone.includes(postId))
          posts.set(postId, { id: postId, availability: { state: 'deleted', checkedAt: clock + 1 } });
        else if (!hidden.includes(postId)) posts.set(postId, { id: postId, lastSeenAt: clock + 1 });
      },
      remove: async id => void tabs.delete(id),
    },
  };
  const visitor = createStatusVisitor({
    chromeApi,
    activeXTab: async () => (xTab ? { id: 1, windowId: 3 } : null),
    readPost: async id => posts.get(id) || null,
    markChecked: async (kind, id, outcome) => void checked.push([kind, id, outcome]),
    onFound: async (kind, id) => found[id] || [],
    caps: async () => caps,
    now: () => clock,
    sleep: async ms => void (clock += ms),
    pollMs: 500,
    visitTimeoutMs: 2000,
    gapMs: [100, 100],
  });
  return { visitor, store, tabs, visits, checked, advance: ms => (clock += ms), clock: () => clock };
}

test('helpers: classification, daily caps and ETA', () => {
  assert.equal(classifyVisit(null, 5), 'missing');
  assert.equal(classifyVisit({ lastSeenAt: 6 }, 5), 'seen');
  assert.equal(classifyVisit({ lastSeenAt: 4 }, 5), 'pending');
  assert.equal(classifyVisit({ availability: { state: 'suspended', checkedAt: 7 } }, 5), 'gone');
  assert.equal(
    classifyVisit({ availability: { state: 'deleted', checkedAt: 4 }, lastSeenAt: 2 }, 5),
    'pending',
    'old checks do not count'
  );
  const now = Date.parse('2026-03-04T12:00:00');
  assert.equal(remainingToday({ usage: { [dayKey(now)]: { repair: 30 } } }, 'repair', 40, now), 10);
  assert.equal(
    remainingToday({ usage: { '2000-01-01': { repair: 99 } } }, 'repair', 40, now),
    40,
    'yesterday does not count'
  );
  assert.deepEqual(estimate({ ids: [1, 2, 3, 4], done: 2, activeMs: 10000, status: 'paused' }, now), {
    done: 2,
    total: 4,
    remaining: 2,
    etaMs: 10000,
    perItemMs: 5000,
  });
});

test('a repair queue visits each post once in one background tab, then closes it', async () => {
  const h = harness({ gone: ['2'], hidden: ['3'] });
  const started = await h.visitor.start('repair', ['1', '2', '3', '1', 'bad'], { label: 'Repair 3' });
  assert.equal(started.ok, true);
  await h.visitor.run();
  assert.deepEqual(h.visits, ['1', '2', '3']);
  assert.equal(h.tabs.size, 0, 'the visit tab is closed at the end');
  const status = await h.visitor.status();
  assert.equal(status.job.status, 'done');
  assert.deepEqual(status.job.results, { seen: 1, gone: 1, notShown: 1, added: 0 });
  assert.equal(status.history[0].visited, 3);
  assert.equal(status.usage.repair, 3);
  assert.deepEqual(h.checked, [
    ['repair', '1', 'seen'],
    ['repair', '2', 'gone'],
    ['repair', '3', 'notShown'],
  ]);
});

test('daily caps trim the queue and block a second run', async () => {
  const h = harness({ caps: { repair: 2, gaps: 40, check: 30 } });
  await h.visitor.start('repair', ['1', '2', '3']);
  await h.visitor.run();
  const status = await h.visitor.status();
  assert.equal(status.history[0].visited, 2);
  assert.equal(status.history[0].skippedByCap, 1);
  const again = await h.visitor.start('repair', ['4']);
  assert.equal(again.ok, false);
  assert.match(again.error, /limit \(2\) is used up/);
  assert.equal((await h.visitor.start('gaps', ['4'])).ok, true, 'caps are per queue');
});

test('thread gaps follow newly found parents up to the chosen depth', async () => {
  const h = harness({ found: { 10: ['11'], 11: ['12'], 12: ['13'] } });
  await h.visitor.start('gaps', ['10'], { depth: 2 });
  await h.visitor.run();
  assert.deepEqual(h.visits, ['10', '11', '12'], 'depth 2 stops before the third hop');
  assert.equal((await h.visitor.status()).job.results.added, 2);
});

test('pause, resume, cancel and restart recovery', async () => {
  const h = harness();
  await h.visitor.start('check', ['1', '2', '3']);
  await h.visitor.pause();
  await h.visitor.run();
  let status = await h.visitor.status();
  assert.equal(status.job.status, 'paused');
  assert.ok(h.visits.length <= 1, 'a paused queue stops after the post it was on');
  assert.equal(h.tabs.size, 0, 'pausing closes the tab');
  await h.visitor.resume();
  await h.visitor.run();
  status = await h.visitor.status();
  assert.equal(status.job.status, 'done');
  assert.deepEqual([...new Set(h.visits)], ['1', '2', '3']);
  assert.equal((await h.visitor.start('check', ['1', '2'])).ok, true);
  const before = (await h.visitor.status()).job;
  assert.equal(before.status, 'running');
  // Simulate a worker restart: the stored job says "running" but nothing owns it.
  const fresh = createStatusVisitor({
    chromeApi: {
      storage: {
        local: {
          get: async key => ({ [key]: structuredClone(h.store[key]) }),
          set: async value => Object.assign(h.store, value),
        },
      },
      tabs: { remove: async () => {} },
    },
    activeXTab: async () => null,
    readPost: async () => null,
  });
  const recovered = await fresh.recover();
  assert.equal(recovered.job.status, 'interrupted');
  assert.match(recovered.job.error, /restarted/);
  const cancelled = await fresh.cancel();
  assert.equal(cancelled.job.status, 'cancelled');
  assert.equal(cancelled.history[0].status, 'cancelled');
});

test('without an x.com tab the queue stops with a clear message', async () => {
  const h = harness({ xTab: false });
  await h.visitor.start('repair', ['1']);
  await h.visitor.run();
  const status = await h.visitor.status();
  assert.equal(status.job.status, 'interrupted');
  assert.match(status.job.error, /Open x\.com in a tab first/);
  assert.equal(h.visits.length, 0);
  const replaced = await h.visitor.start('repair', ['2']);
  assert.equal(replaced.ok, true, 'a new queue may replace an interrupted one');
  assert.equal(replaced.history[0].status, 'interrupted', '…which is kept in the history');
  await assert.rejects(h.visitor.start('nope', ['1']), /Unknown visit queue/);
});
