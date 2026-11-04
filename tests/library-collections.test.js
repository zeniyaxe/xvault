const assert = require('node:assert/strict');
const { test } = require('node:test');
const collections = require('../library-collections.js');

const current = [
  { id: 'local-1', name: 'Video notes', query: 'annotation:true has:video', sort: 'new', view: 'timeline', icon: 'video' },
  { id: 'local-2', name: 'Favorites', query: 'fav:true', sort: 'old', view: 'compact', icon: 'favorite' },
];
const portable = {
  format: 'xvault-collections-v1',
  collections: [
    { id: 'portable-1', name: 'Favorites', query: 'fav:true', sort: 'old', view: 'compact', icon: 'favorite' },
    { id: 'portable-2', name: 'Favorites', query: 'fav:true from:ada', sort: 'new', view: 'gallery', icon: 'image' },
    { id: 'portable-3', name: 'Video notes', query: 'annotation:true has:video', sort: 'new', view: 'timeline', icon: 'video' },
    { id: 'portable-4', name: 'Recent clips', query: 'has:video after:2026-01-01', sort: 'new', view: 'gallery', icon: 'video' },
  ],
};

test('portable collections contain query definitions only and normalize bounded fields', () => {
  const parsed = collections.parsePortable(JSON.stringify(portable));
  assert.equal(parsed.collections.length, 4);
  assert.equal(parsed.collections[0].collection.query, 'fav:true');
  assert.equal(parsed.collections[0].collection.icon, 'favorite');
  assert.deepEqual(Object.keys(JSON.parse(collections.exportPortable(current)).collections[0]).sort(), ['icon', 'id', 'name', 'query', 'sort', 'view']);
  assert.throws(() => collections.parsePortable(JSON.stringify({ format: 'xvault-collections-v2', collections: [] })), /format/i);
  assert.throws(() => collections.parsePortable('x'.repeat(600_000)), /size/i);
});

test('import preview classifies identical definitions, name collisions and safe additions', () => {
  const plan = collections.previewImport(JSON.stringify(portable), current);
  assert.deepEqual(plan.counts, { add: 1, identical: 2, conflict: 1, invalid: 0 });
  assert.equal(plan.items.find(item => item.collection.id === 'portable-2').action, 'conflict');
  assert.equal(plan.items.find(item => item.collection.id === 'portable-4').action, 'add');
});

test('import commit never overwrites existing data and reimport is idempotent', () => {
  const plan = collections.previewImport(JSON.stringify(portable), current);
  const first = collections.commitImport(plan, current, { conflicts: 'keep-both', idFactory: () => 'import-copy-id' });
  assert.equal(first.added, 2);
  assert.equal(first.collections.find(item => item.id === 'local-2').query, 'fav:true');
  const copy = first.collections.find(item => item.id === 'import-copy-id');
  assert.equal(copy.name, 'Favorites (imported)');
  assert.equal(copy.portableId, 'portable-2');
  const secondPlan = collections.previewImport(JSON.stringify(portable), first.collections);
  const second = collections.commitImport(secondPlan, first.collections, { conflicts: 'keep-both', idFactory: () => 'must-not-be-used' });
  assert.equal(second.added, 0);
  assert.equal(second.skipped, 4);
  assert.equal(second.collections.length, first.collections.length);
});

test('malformed members and same-file name conflicts are reported without applying partial mutations', () => {
  const content = {
    format: 'xvault-collections-v1',
    collections: [
      { id: 'a', name: 'Ideas', query: 'note:true', sort: 'new', view: 'timeline', icon: 'note' },
      { id: 'b', name: 'Ideas', query: 'fav:true', sort: 'new', view: 'timeline', icon: 'favorite' },
      { id: 'bad', name: 'Nope', query: 'x'.repeat(3000), sort: 'new', view: 'timeline', icon: 'file' },
    ],
  };
  const plan = collections.previewImport(JSON.stringify(content), []);
  assert.equal(plan.counts.conflict, 1);
  assert.equal(plan.counts.invalid, 1);
  assert.equal(plan.counts.add, 1);
  const committed = collections.commitImport(plan, [], { conflicts: 'skip', idFactory: () => 'new-id' });
  assert.equal(committed.added, 1);
  assert.equal(committed.collections.length, 1);
});

test('reordering is bounded and preserves every unique collection exactly once', () => {
  const reordered = collections.moveCollection(current, 1, -1);
  assert.deepEqual(reordered.map(item => item.id), ['local-2', 'local-1']);
  assert.deepEqual(collections.moveCollection(current, 0, -1).map(item => item.id), ['local-1', 'local-2']);
});

test('an import at the collection limit fails atomically without dropping existing definitions', () => {
  const full = Array.from({ length: 200 }, (_, index) => ({ id: `id-${index}`, name: `Collection ${index}`, query: `tag:${index}`, sort: 'new', view: 'timeline', icon: 'tag' }));
  const plan = collections.previewImport(JSON.stringify({ format: 'xvault-collections-v1', collections: [{ id: 'extra', name: 'Extra', query: 'fav:true', sort: 'new', view: 'timeline', icon: 'favorite' }] }), full);
  assert.throws(() => collections.commitImport(plan, full, { conflicts: 'keep-both' }), /limit/i);
  assert.equal(full.length, 200);
  assert.equal(full[0].id, 'id-0');
});

test('serialized settings writes merge simultaneous window edits against the latest state', async () => {
  const { createSmartCollectionService } = await import('../smart-collection-service.mjs');
  let state = { settingsVersion: 18, savedViews: [] }, tail = Promise.resolve();
  const enqueue = operation => { const task = tail.then(operation); tail = task.catch(() => {}); return task; };
  const service = createSmartCollectionService({ readSettings: async () => state, writeSettings: async patch => (state = { ...state, ...patch }), enqueue, collectionApi: collections });
  const [first, second] = await Promise.all([
    service({ op: 'save', collection: { id: 'window-a', name: 'Window A', query: 'fav:true', sort: 'new', view: 'timeline', icon: 'favorite' } }),
    service({ op: 'save', collection: { id: 'window-b', name: 'Window B', query: 'has:video', sort: 'old', view: 'gallery', icon: 'video' } }),
  ]);
  assert.ok(first.ok && second.ok);
  assert.deepEqual(state.savedViews.map(view => view.id).sort(), ['window-a', 'window-b']);
});

test('a failed collection settings write does not poison the serialized update queue', async () => {
  const { createSmartCollectionService } = await import('../smart-collection-service.mjs');
  let state = { savedViews: [] }, tail = Promise.resolve(), rejectFirst = true;
  const enqueue = operation => { const task = tail.then(operation); tail = task.catch(() => {}); return task; };
  const service = createSmartCollectionService({
    readSettings: async () => state,
    writeSettings: async patch => { if (rejectFirst) { rejectFirst = false; throw Error('quota'); } state = { ...state, ...patch }; return state; },
    enqueue, collectionApi: collections,
  });
  await assert.rejects(service({ op: 'save', collection: { id: 'failed', name: 'Failed first', query: 'fav:true', sort: 'new', view: 'timeline', icon: 'favorite' } }), /quota/);
  const result = await service({ op: 'save', collection: { id: 'recovered', name: 'Saved second', query: 'has:image', sort: 'new', view: 'timeline', icon: 'image' } });
  assert.equal(result.ok, true);
  assert.deepEqual(state.savedViews.map(view => view.id), ['recovered']);
});
