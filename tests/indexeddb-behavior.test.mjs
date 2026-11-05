// XVault 21: behavioural storage tests against a real IndexedDB implementation (fake-indexeddb),
// replacing source-text assertions for the paths Forge touches: system-field patches (availability,
// revision counters), revision bookkeeping, keyset paging and the derived-store v2 → v3 upgrade.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import {
  patchLibrarySystemFields,
  readLibraryRevision,
  readRevisionCounters,
  readLibraryPage,
  readLibraryRecords,
  validAvailability,
  mergeLibraryCapture,
} from '../library-storage.mjs';
import { createDerivedStore, DERIVED_DB, DERIVED_VERSION } from '../sw/derived-store.mjs';

const request = value =>
  new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
async function openArchive(name, posts = [], revisions = []) {
  const open = indexedDB.open(name, 1);
  open.onupgradeneeded = () => {
    const database = open.result;
    database.createObjectStore('tweets', { keyPath: 'id' });
    database.createObjectStore('checkpoints', { keyPath: 'key' });
    database.createObjectStore('revisions', { keyPath: 'key' });
    database.createObjectStore('trash', { keyPath: 'id' });
  };
  const database = await request(open);
  const tx = database.transaction(['tweets', 'revisions'], 'readwrite');
  posts.forEach(post => tx.objectStore('tweets').put(post));
  revisions.forEach(row => tx.objectStore('revisions').put(row));
  await new Promise(resolve => (tx.oncomplete = resolve));
  return database;
}
const read = (database, id) => request(database.transaction('tweets').objectStore('tweets').get(id));

// ── patchLibrarySystemFields: only system fields, one revision bump per transaction ──
{
  const database = await openArchive('patch', [
    { id: '1', text: 'one' },
    { id: '2', text: 'two', revisionCount: 2 },
    { id: '3', text: 'three' },
  ]);
  assert.equal(await readLibraryRevision(database), 0);
  const result = await patchLibrarySystemFields(database, [
    { id: '1', patch: { availability: { state: 'deleted', checkedAt: 100, reason: 'x'.repeat(500) }, text: 'hacked' } },
    { id: '2', patch: { revisionCount: 2 } }, // unchanged → not written
    { id: '3', patch: { textRevisionCount: 1, lastRevisionAt: 50 } },
    { id: 'not-a-post', patch: { revisionCount: 9 } }, // invalid id is dropped before the transaction
    { id: '99', patch: { revisionCount: 1 } }, // missing post is skipped
  ]);
  assert.deepEqual(result, { ok: true, updated: 2, ids: ['1', '3'] });
  const one = await read(database, '1');
  assert.equal(one.text, 'one', 'non-system fields are never patched');
  assert.equal(one.availability.state, 'deleted');
  assert.equal(one.availability.reason.length, 300, 'reasons are bounded');
  assert.equal((await read(database, '3')).textRevisionCount, 1);
  assert.equal(await readLibraryRevision(database), 1, 'one bump for the whole transaction');

  // null clears a field; an updater function sees the stored post.
  await patchLibrarySystemFields(database, [{ id: '1', patch: { availability: null } }]);
  assert.equal('availability' in (await read(database, '1')), false);
  const counted = await patchLibrarySystemFields(database, [{ id: '2' }, { id: '3' }], post => ({
    revisionCount: (post.revisionCount || 0) + 1,
  }));
  assert.deepEqual(counted.ids, ['2', '3']);
  assert.equal((await read(database, '2')).revisionCount, 3);
  assert.equal(await readLibraryRevision(database), 3);

  // An invalid availability aborts the transaction; nothing is written.
  await assert.rejects(patchLibrarySystemFields(database, [{ id: '2', patch: { availability: { state: 'gone' } } }]));
  assert.equal((await read(database, '2')).availability, undefined);
  assert.equal(await readLibraryRevision(database), 3);
  assert.equal((await patchLibrarySystemFields(database, [])).updated, 0);
  database.close();
}

// ── validAvailability ──
assert.equal(validAvailability(null), null);
assert.throws(() => validAvailability({ state: 'nope' }), /Invalid availability/);
const checked = validAvailability({ state: 'suspended', previous: 'available', since: 5, source: 'visit' });
assert.equal(checked.state, 'suspended');
assert.equal(checked.previous, 'available');
assert.ok(checked.checkedAt > 0);

// ── readRevisionCounters: counts all revisions and text-changing ones per post ──
{
  const database = await openArchive(
    'revisions',
    [{ id: '7' }],
    [
      { key: 'a', tweetId: '7', observedAt: 10, before: { text: 'a' }, after: { text: 'b' } },
      { key: 'b', tweetId: '7', observedAt: 30, before: { text: 'b' }, after: { text: 'b' } },
      { key: 'c', tweetId: '8', observedAt: 20, before: {}, after: { text: 'x' } },
      { key: 'd', tweetId: 'bad id', observedAt: 99 },
    ]
  );
  const counters = await readRevisionCounters(database);
  assert.deepEqual(Object.fromEntries(counters), {
    7: { revisionCount: 2, textRevisionCount: 1, lastRevisionAt: 30 },
    8: { revisionCount: 1, textRevisionCount: 1, lastRevisionAt: 20 },
  });
  database.close();
}

// ── readLibraryPage keyset paging and bounded record reads ──
{
  const posts = Array.from({ length: 25 }, (_, index) => ({ id: String(100 + index), text: `post ${index}` }));
  const database = await openArchive('paging', posts);
  const seen = [];
  let afterKey = null,
    pages = 0;
  for (;;) {
    const page = await readLibraryPage(database, afterKey, 10);
    seen.push(...page.rows.map(row => row.id));
    pages++;
    if (page.done) break;
    afterKey = page.nextKey;
  }
  assert.equal(pages, 3);
  assert.deepEqual(
    seen,
    posts.map(post => post.id)
  );
  const records = await readLibraryRecords(database, ['101', '101', '999', '124']);
  assert.deepEqual(records.map(row => row.id).sort(), ['101', '124']);
  assert.throws(
    () =>
      readLibraryRecords(
        database,
        Array.from({ length: 1501 }, (_, i) => String(i))
      ),
    /limited/
  );
  database.close();
}

// ── Derived store: v2 database upgrades to v3 (snapshots) without losing data ──
{
  assert.equal(DERIVED_VERSION, 3);
  const old = indexedDB.open(DERIVED_DB, 2);
  old.onupgradeneeded = () => {
    const database = old.result;
    database.createObjectStore('phash', { keyPath: 'key' });
    database.createObjectStore('ocr', { keyPath: 'key' }).createIndex('postId', 'postId');
    database.createObjectStore('meta', { keyPath: 'key' });
  };
  const v2 = await request(old);
  const tx = v2.transaction(['phash', 'meta'], 'readwrite');
  tx.objectStore('phash').put({ key: 'p1', hash: 'abc' });
  tx.objectStore('meta').put({ key: 'phash:revision', value: 5 });
  await new Promise(resolve => (tx.oncomplete = resolve));
  v2.close();

  const store = createDerivedStore(indexedDB);
  const database = await store.open();
  assert.equal(database.version, 3);
  assert.ok(database.objectStoreNames.contains('snapshots'));
  assert.ok(database.transaction('snapshots').objectStore('snapshots').indexNames.contains('postId'));
  assert.equal((await store.getMany('phash', ['p1'])).get('p1').hash, 'abc', 'v2 data survives the upgrade');
  assert.equal(await store.revision('phash'), 5);
  await store.putMany('snapshots', [
    { key: '1|https://a.example/', postId: '1', url: 'https://a.example/', status: 'ok' },
    { key: '2|https://b.example/', postId: '2', url: 'https://b.example/', status: 'error' },
  ]);
  assert.equal(await store.count('snapshots'), 2);
  const byPost = await request(database.transaction('snapshots').objectStore('snapshots').index('postId').getAll('1'));
  assert.deepEqual(
    byPost.map(row => row.url),
    ['https://a.example/']
  );
  await store.clear('snapshots');
  assert.equal(await store.count('snapshots'), 0);
  assert.ok((await store.revision('snapshots')) > 0, 'clearing bumps the store revision');
}
// ── XVault 22 regression: captures advance the library revision ──
// mergeLibraryCapture used to overwrite bumpLibraryRevision's success handler, so a capture never
// wrote the new revision; stale detection, caches and skip-unchanged backups all missed captures.
{
  const database = await openArchive('capture-revision');
  assert.equal(await readLibraryRevision(database), 0);
  const first = await mergeLibraryCapture(database, { id: '10', text: 'first' });
  assert.equal(first.stored, true);
  assert.equal(await readLibraryRevision(database), 1, 'a new capture bumps the revision');
  const second = await mergeLibraryCapture(database, { id: '10', text: 'edited' });
  assert.equal(second.changed, true);
  assert.equal(second.revision, 2);
  assert.equal(await readLibraryRevision(database), 2, 'an updated capture bumps it again');
  assert.equal((await read(database, '10')).text, 'edited');
}
console.log('IndexedDB behaviour: system-field patches, revision counters, paging and derived v3 upgrade passed');
