import assert from 'node:assert/strict';
import { projectRemoteViews } from '../remote-views.mjs';
const projected = projectRemoteViews({ savedViews: [
  { id: 'a', name: 'Lighting', query: 'tag:lighting has:image', sort: 'old', credential: 'secret', note: 'private evidence', theme: 'paper' },
  { id: 'a', name: 'Duplicate', query: '' },
  { id: 'b', query: 'x'.repeat(1001) },
  { id: 'c', query: 'fav:true', sort: 'invalid' }
] });
assert.deepEqual(projected.rows, [{ id: 'a', name: 'Lighting', query: 'tag:lighting has:image', sort: 'old' }, { id: 'c', name: 'Saved view', query: 'fav:true', sort: 'new' }]);
assert.equal(projectRemoteViews({ savedViews: Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })) }).rows.length, 100);
assert.deepEqual(projectRemoteViews({ savedViews: null }), { rows: [] });
console.log('Remote saved views: bounded query definitions, duplicate IDs and private-field projection passed');
