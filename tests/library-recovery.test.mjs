import assert from 'node:assert/strict';
import { collapseSource, compactSource, readSource } from './source-text.mjs';
const dashboard = compactSource(readSource('dashboard.js'));
const workspace = collapseSource(readSource('library-workspace.js'));
assert.match(
  dashboard,
  /const downloadPostBusy=new Set\(\)/,
  'a post should have at most one in-flight Library queue request'
);
assert.match(dashboard, /downloadPostBusy\.has\(id\)/, 'repeat post clicks should be ignored while queueing');
assert.match(
  dashboard,
  /button\.setAttribute\('aria-busy','true'\);button\.textContent='Queuing…'/,
  'the Library action should announce and show its in-flight state'
);
assert.match(
  dashboard,
  /Promise\.allSettled\(\[refresh\(\),queueStats\(\)\]\)/,
  'optional startup diagnostics must not block navigation'
);
assert.doesNotMatch(
  workspace,
  /GET_LIBRARY_ROWS|GET_LIBRARY_CHUNK/,
  'normal Library paging must never fall back to a complete records read'
);
assert.doesNotMatch(
  workspace,
  /new Worker\('library-search-worker\.js'\)|dataset-chunk|searchIndexRows\(/,
  'the dashboard must not retain a dormant full-page search projection pipeline'
);
assert.match(
  dashboard,
  /type:'QUERY_LIBRARY_PAGE'.{0,180}after:null/,
  'the base dashboard Library loader must also remain bounded if the workspace module is delayed'
);
assert.match(dashboard, /type:'GET_JOB',id/, 'archive monitoring should fetch only its active job record');
assert.doesNotMatch(
  dashboard.slice(dashboard.indexOf('async function monitor('), dashboard.indexOf('function labelState(')),
  /GET_ALL/,
  'the 750ms monitor loop must not clone every store'
);
assert.match(workspace, /Download state unavailable/, 'download metadata failure must not hide archived posts');
assert.match(workspace, /Clear search and filters/, 'filtered archive should offer a visible way back to all posts');
assert.match(
  workspace,
  /const q = \(\$\('#search'\)\?\.value \|\| ''\)\.trim\(\), sort = \$\('#sort'\)\?\.value \|\| 'new', pageSize = exportPageSize\(\)/,
  'query workers receive the selected sort string rather than the named #sort element'
);
console.log('library recovery wiring passed');
