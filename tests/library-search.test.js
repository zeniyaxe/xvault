const assert = require('node:assert/strict');
const search = require('../library-search-core.js');

const rows = [
  { index: 0, id: 'post-a', text: 'A needle field reference', handle: 'ada', mediaTypes: ['video', 'photo'], sources: ['bookmarks'], sensitive: false, favorite: true, tags: ['art', 'digital'], metrics: { likes: 1200, views: 9000, bookmarks: 14, reposts: 8, replies: 2 }, downloaded: true, missing: false, note: true, archivedAt: 30, mediaCount: 2, randomOrder: 7 },
  { index: 1, id: 'post-b', text: 'Needle city animation', handle: 'bo', mediaTypes: ['animated_gif'], sources: ['likes'], sensitive: true, favorite: false, tags: ['animation'], metrics: { likes: 5, views: 100, bookmarks: 1, reposts: 0, replies: 0 }, downloaded: false, missing: true, note: false, archivedAt: 20, mediaCount: 1, randomOrder: 3 },
  { index: 2, id: 'post-c', text: 'Nothing here', handle: 'ada', mediaTypes: ['photo'], sources: ['likes', 'bookmarks'], sensitive: false, favorite: true, tags: ['digital'], metrics: { likes: 500, views: 400, bookmarks: 3, reposts: 1, replies: 6 }, downloaded: false, missing: false, note: false, archivedAt: 10, mediaCount: 1, randomOrder: 1 }
];

assert.deepEqual(search.tokenizeQuery('artist:ada "needle field"'), ['artist:ada', 'needle field']);
assert.deepEqual(search.searchRecords(rows, 'artist:ada type:video likes:>1k source:bookmarks rating:safe fav:true tag:art downloaded:true missing:false note:true id:post-a', 'new'), [0]);
assert.deepEqual(search.searchRecords(rows, '"needle field"', 'new'), [0]);
assert.deepEqual(search.searchRecords(rows, 'from:@ADA type:image', 'new'), [0, 2]);
assert.deepEqual(search.searchRecords(rows, 'has:gif rating:sensitive', 'new'), [1]);
assert.deepEqual(search.searchRecords(rows, 'source:bookmarks', 'likes'), [0, 2]);
assert.deepEqual(search.searchRecords(rows, 'has:media', 'replies'), [2, 0, 1]);
assert.deepEqual(search.searchRecords(rows, 'likes:>=500', 'new'), [0, 2]);
assert.deepEqual(search.searchRecords(rows, 'tag:dig', 'old'), [2, 0]);
assert.deepEqual(search.searchRecords(rows, 'downloaded:false missing:true note:false', 'new'), [1]);
assert.deepEqual(search.searchRecords(rows, 'fav:invalid', 'new'), []);
assert.deepEqual(search.searchRecords(rows, 'downloaded:invalid', 'new'), [], 'invalid download filters cannot select all posts');
assert.deepEqual(search.searchRecords(rows, 'ada', 'random'), [2, 0]);
assert.equal(search.parseNum('1.5m'), 1500000);
assert.equal(search.matchesQuery(rows[0], 'unknown:value'), false, 'unknown filters must not silently select the entire archive');
const dated = rows.map((row, index) => ({ ...row, postedAt: Date.UTC(2026, 8, index + 1), archivedAt: Date.UTC(2026, 9, index + 1), knownBytes: index === 0 ? 150 * 1024 * 1024 : 0 }));
dated[1].tags = [];
assert.deepEqual(search.searchRecords(dated, 'after:2026-09-02 before:2026-09-03'), [1]);
assert.deepEqual(search.searchRecords(dated, 'archived-after:2026-10-02 archived-before:2026-10-04'), [2, 1]);
assert.deepEqual(search.searchRecords(dated, 'untagged:true'), [1]);
assert.deepEqual(search.searchRecords(dated, 'untagged:false'), [2, 0]);
assert.deepEqual(search.searchRecords(dated, 'size:>100mb'), [0]);
assert.deepEqual(search.searchRecords(dated, 'size:<100mb'), [], 'unknown file sizes cannot be compared as zero');
assert.deepEqual(search.searchRecords(dated, 'before:2026-02-30'), [], 'invalid dates must not roll into another month');
assert.deepEqual(search.searchRecords(dated, 'before:nonsense'), []);
assert.deepEqual(search.searchRecords([{...dated[0],postedAt:0}], 'before:2026-10-01'), [], 'missing post timestamps are not dated results');
assert.ok(search.queryIssues('likes:>100 before:bad typo:true').length === 2);
const projection = search.projectPost({id:'42',createdAt:'2026-09-02T03:00:00Z',text:'Saved video',author:{handle:'Ada'},media:[{id:'m',type:'video'}],userMeta:{tags:[]}},0,{downloads:[{state:'complete',item:{mediaId:'m'},totalBytes:150*1024*1024}]});
assert.equal(search.matchesQuery(projection,'after:2026-09-01 before:2026-09-03 untagged:true downloaded:true missing:false size:>100mb'),true);

const inboxRows = [
  search.projectPost({ id: '1', archivedAt: 500, userMeta: {} }, 0, { inboxSince: 400 }),
  search.projectPost({ id: '2', archivedAt: 300, userMeta: {} }, 1, { inboxSince: 400 }),
  search.projectPost({ id: '3', archivedAt: 600, userMeta: { reviewedAt: 650 } }, 2, { inboxSince: 400 }),
  search.projectPost({ id: '4', archivedAt: 700, userMeta: {} }, 3, {})
];
assert.deepEqual(search.searchRecords(inboxRows, 'inbox:true', 'old'), [0], 'only unreviewed posts archived since the cut-off are in the Inbox');
assert.deepEqual(search.searchRecords(inboxRows, 'inbox:false', 'old'), [1, 2, 3]);
assert.deepEqual(search.queryIssues('inbox:maybe'), ['inbox: use true or false']);
console.log('library search: token grammar and stable sorting passed');
const annotated = search.projectPost({id:'notes',text:'A post without the search phrase',userMeta:{note:'Lighting reference: rainy stairwell study.'}});
assert.equal(search.matchesQuery(annotated,'note:lighting'),true);
assert.equal(search.matchesQuery(annotated,'note:"rainy stairwell"'),true);
assert.equal(search.matchesQuery(annotated,'note:portrait'),false);
assert.equal(search.matchesQuery(annotated,'note:true'),true);
assert.equal(search.matchesQuery(annotated,'downloaded:maybe'),false);
assert.equal(search.matchesQuery(annotated,'missing:maybe'),false);
console.log('private note content search and malformed boolean safety passed');
const mediaNotes = search.projectPost({ id: 'media-notes', userMeta: {}, media: [{ id: 'frame-a', xvault: { note: 'Rainy hallway', annotations: [{ text: 'Door opens at 00:04' }, { text: 'Camera pans left' }] } }, { id: 'frame-b', xvault: { note: 'Backlit sign' } }] });
assert.equal(search.matchesQuery(mediaNotes, 'annotation:"door opens"'), true);
assert.equal(search.matchesQuery(mediaNotes, 'annotation:camera'), true);
assert.equal(search.matchesQuery(mediaNotes, 'media-note:backlit'), true);
assert.equal(search.matchesQuery(mediaNotes, 'note:"rainy hallway"'), true, 'note search spans post and per-media notes');
assert.equal(search.matchesQuery(mediaNotes, 'annotation:missing'), false);
console.log('per-media notes and timestamp annotation text are searchable');
const mediaLabels = search.projectPost({ id: 'media-labels', userMeta: { tags: ['archive'] }, media: [{ id: 'image-a', xvault: { tags: ['reference', 'blue-hour'] } }] });
assert.equal(search.matchesQuery(mediaLabels, 'tag:blue'), true, 'tag search should include per-media labels');
assert.equal(search.matchesQuery(mediaLabels, 'untagged:true'), false, 'a post with a labeled media item is not untagged');
assert.equal(search.matchesQuery(mediaNotes, 'note:true'), true, 'note:true includes per-media notes and annotations');
console.log('per-media labels participate in tags, facets and note presence');
