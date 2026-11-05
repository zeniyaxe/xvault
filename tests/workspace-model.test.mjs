import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
assert.ok(
  fs.existsSync(new URL('../workspace-model.js', import.meta.url)),
  'workspace snapshots need a bounded, privacy-safe model'
);
const api = createRequire(import.meta.url)('../workspace-model.js');
assert.equal(typeof api.previewImport, 'function', 'portable workspace import needs a bounded, conflict-aware preview');
const portable = {
  format: 'xvault-workspaces-v1',
  workspaces: [{ id: 'portable-a', name: 'Portable desk', values: { theme: 'paper', railWidth: 'wide' } }],
};
const preview = api.previewImport([], JSON.stringify(portable));
assert.equal(preview.added, 1);
let imported = api.mutate(
  { workspaces: [] },
  { op: 'import', fileText: JSON.stringify(portable), expected: preview.expected }
);
assert.equal(imported.workspaces.length, 1);
assert.equal(api.previewImport(imported.workspaces, JSON.stringify(portable)).identical, 1);
const changedFile = JSON.stringify({
  ...portable,
  workspaces: [{ ...portable.workspaces[0], values: { theme: 'oled' } }],
});
assert.equal(api.previewImport(imported.workspaces, changedFile).conflicts, 1);
const kept = api.mutate(imported, { op: 'import', fileText: changedFile, conflicts: 'keep-both' });
assert.equal(kept.workspaces.length, 2);
assert.equal(
  api.mutate(kept, { op: 'import', fileText: changedFile, conflicts: 'keep-both' }).workspaces.length,
  2,
  'reimported conflicts must be idempotent'
);
assert.equal(
  api.previewImport(
    [],
    JSON.stringify({ ...portable, workspaces: [{ ...portable.workspaces[0], values: { helperAuthToken: 'private' } }] })
  ).invalid,
  1
);
assert.throws(
  () => api.mutate(kept, { op: 'import', fileText: JSON.stringify(portable), expected: preview.expected }),
  /changed/i
);
let renamed = api.mutate(kept, { op: 'rename', id: 'portable-a', name: 'Renamed', expectedName: 'Portable desk' });
assert.equal(renamed.workspaces[0].name, 'Renamed');
const duplicated = api.mutate(renamed, { op: 'duplicate', id: 'portable-a', newId: 'copy-a' });
assert.equal(duplicated.workspaces.length, 3);
assert.equal(api.mutate(duplicated, { op: 'move', id: 'copy-a', delta: -1 }).workspaces[1].id, 'copy-a');
const { createWorkspaceService } = await import('../workspace-service.mjs');
const original = {
  theme: 'paper',
  railWidth: 'wide',
  inspectorPixels: 480,
  libraryView: 'compact',
  toolbarActions: ['export', 'inbox'],
  safeMode: true,
  motionLevel: 'off',
  helperAuthToken: 'private',
  lastLibraryQuery: 'private note',
};
const values = api.snapshot(original);
assert.equal(values.theme, 'paper');
assert.equal(values.inspectorPixels, 480);
for (const key of ['safeMode', 'motionLevel', 'helperAuthToken', 'lastLibraryQuery'])
  assert.ok(!(key in values), `${key} is not layout metadata`);
assert.deepEqual(api.toolbar(['export', 'export', 'bad', 'inbox']), ['export', 'inbox']);
assert.deepEqual(api.toolbar([]), [], 'empty custom toolbar remains intentional');
assert.ok(!('theme' in api.snapshot({ theme: '<script>' })));
assert.equal(api.snapshot({ inspectorPixels: 5000 }).inspectorPixels, 880);
assert.doesNotThrow(
  () => api.normalizeList([{ id: 'broken', name: 'Recovered', values: null }]),
  'a malformed saved layout must not block application startup'
);
let state = { ...original, workspaces: [] },
  tail = Promise.resolve();
const enqueue = task => {
  const result = tail.then(task);
  tail = result.catch(() => {});
  return result;
};
const service = createWorkspaceService({
  readSettings: async () => structuredClone(state),
  writeSettings: async patch => (state = { ...state, ...patch }),
  enqueue,
  api,
});
await Promise.all([
  service({ op: 'save', id: 'a', name: 'Reading' }),
  service({ op: 'save', id: 'b', name: 'Review' }),
]);
assert.equal(state.workspaces.length, 2, 'simultaneous saves merge against latest settings');
await assert.rejects(
  service({ op: 'save', id: 'c', name: 'Reading' }),
  /already/i,
  'saving a duplicate name requires an explicit update'
);
state = { ...state, theme: 'oled', railWidth: 'narrow' };
await service({ op: 'apply', id: 'a' });
assert.equal(state.theme, 'paper');
assert.equal(state.safeMode, true);
assert.equal(state.motionLevel, 'off');
assert.equal(state.lastLibraryQuery, 'private note');
state.theme = 'cloud';
await service({ op: 'update', id: 'a' });
assert.equal(state.workspaces[0].values.theme, 'cloud');
await service({ op: 'remove', id: 'a' });
assert.equal(state.workspaces.length, 1);
assert.equal(state.theme, 'cloud', 'removal does not alter active preferences');
assert.ok(
  api.normalizeList([{ id: 'x', name: 'Unsafe', values: { helperAuthToken: 'secret', theme: 'paper' } }])[0].values
    .helperAuthToken === undefined
);
let failWrite = true;
const failing = createWorkspaceService({
  readSettings: async () => state,
  writeSettings: async patch => {
    if (failWrite) throw Error('Synthetic storage failure');
    return (state = { ...state, ...patch });
  },
  enqueue,
  api,
});
await assert.rejects(failing({ op: 'save', id: 'fail-safe', name: 'Retained' }), /storage failure/);
assert.equal(state.workspaces.length, 1, 'failed persistence must not mutate the current workspace list');
failWrite = false;
await failing({ op: 'save', id: 'fail-safe', name: 'Retained' });
assert.equal(state.workspaces.length, 2, 'a failed write must not poison the shared settings queue');
console.log(
  'PASS bounded workspace snapshots, privacy, explicit update, toolbar normalization, and concurrent settings'
);

assert.deepEqual(
  api.mutate(
    { workspaces: [{ id: 'startup', name: 'Desk', values: { theme: 'paper' } }] },
    { op: 'startup', id: 'startup' }
  ),
  { startupWorkspaceId: 'startup' }
);
assert.throws(() => api.mutate({ workspaces: [] }, { op: 'startup', id: 'missing' }), /no longer exists/);
