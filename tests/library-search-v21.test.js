// XVault 21 "Forge" search: new filters, sorts, typo tolerance and time travel.
const assert = require('node:assert/strict');
const search = require('../library-search-core.js');

search.setCalendarTimeZone('utc');
const day = text => Date.parse(`${text}T00:00:00Z`);
const complete = {
  author: { handle: 'ada', name: 'Ada Lovelace', avatar: 'https://pbs.twimg.com/a.jpg' },
  createdAt: '2024-05-13T09:30:00Z', // a Monday
  metrics: { likes: 10, reposts: 2, replies: 1, views: 100 },
  sourceFlags: ['graphql'],
  language: 'en',
};
const posts = [
  {
    ...complete,
    id: '1',
    text: 'Telescope images of the Horsehead nebula',
    archivedAt: day('2024-05-14'),
    media: [
      {
        id: 'm1',
        type: 'photo',
        url: 'https://pbs.twimg.com/1.jpg',
        width: 4096,
        height: 2160,
        altText: 'A dark horse-shaped cloud',
      },
    ],
    textRevisionCount: 2,
    revisionCount: 3,
    lastRevisionAt: 50,
    availability: { state: 'available', checkedAt: 20 },
    userMeta: { colorLabel: 'blue' },
    links: ['https://www.esa.int/webb'],
    hashtags: ['space'],
  },
  {
    ...complete,
    id: '2',
    text: 'Which café is best?',
    createdAt: '2024-05-18T23:15:00Z', // a Saturday
    archivedAt: day('2024-06-01'),
    media: [
      {
        id: 'm2',
        type: 'video',
        url: 'https://pbs.twimg.com/2.jpg',
        playbackUrl: 'https://video.twimg.com/2.mp4',
        width: 720,
        height: 1280,
        durationMs: 95000,
      },
    ],
    poll: {
      choices: [
        { label: 'Flat white', count: 3 },
        { label: 'Espresso', count: 5 },
      ],
    },
    availability: { state: 'deleted', checkedAt: 10 },
    replyToId: '99',
    metrics: { likes: 50, reposts: 0, replies: 0, views: 100 },
  },
  {
    id: '3',
    text: 'rt https://t.co/abc',
    archivedAt: day('2024-07-01'),
    author: {},
    media: [],
    card: { title: 'Sourdough guide', domain: 'bread.example', url: 'https://bread.example/guide' },
    communityNote: { text: 'This recipe needs more salt' },
    quotedPostId: '1',
  },
];
const archivedIds = new Set(posts.map(post => post.id));
const project = (sort = '') =>
  posts.map((post, index) =>
    search.projectPost(post, index, {
      archivedIds,
      snapshotIds: new Set(['3']),
      clusterIds: new Map([
        ['1', 'space|nebula telescope'],
        ['2', 'coffee|cafe espresso'],
      ]),
      sort,
    })
  );
const rows = project();
const ids = (query, sort = 'new') =>
  search.searchRecords(sort === 'new' ? rows : project(sort), query, sort).map(index => posts[index].id);

// Completeness.
assert.ok(search.postQuality(posts[0]).score >= 90);
assert.ok(search.postQuality(posts[2]).score < search.INCOMPLETE_BELOW);
assert.ok(search.postQuality(posts[2]).missing.includes('post date'));
assert.deepEqual(ids('is:incomplete'), ['3']);
assert.deepEqual(ids('is:broken'), ['3'], 'alias');
assert.deepEqual(ids('is:complete'), ['2', '1']);
assert.deepEqual(ids('quality:<70'), ['3']);
assert.deepEqual(
  ids('quality:>=90'),
  ids('is:complete').filter(id => search.postQuality(posts[id - 1]).score >= 90)
);
assert.ok(search.queryIssues('quality:great').length === 1);

// Change tracking and availability.
assert.deepEqual(ids('is:edited'), ['1']);
assert.deepEqual(ids('edits:>1'), ['1']);
assert.deepEqual(ids('revisions:3'), ['1']);
assert.deepEqual(ids('has:revisions'), ['1']);
assert.deepEqual(ids('is:deleted'), ['2']);
assert.deepEqual(ids('is:removed'), ['2']);
assert.deepEqual(ids('is:unavailable'), ['2']);
assert.deepEqual(ids('is:available'), ['1']);
assert.deepEqual(ids('is:unchecked'), ['3']);
assert.deepEqual(ids('status:deleted'), ['2']);
assert.deepEqual(ids('status:unchecked'), ['3']);
assert.ok(search.queryIssues('status:sleeping').length === 1);

// Structured extras.
assert.deepEqual(ids('has:poll'), ['2']);
assert.deepEqual(ids('is:poll'), ['2']);
assert.deepEqual(ids('poll:espresso'), ['2']);
assert.deepEqual(ids('has:card'), ['3']);
assert.deepEqual(ids('card:sourdough'), ['3']);
assert.deepEqual(ids('has:community-note'), ['3']);
assert.deepEqual(ids('cnote:salt'), ['3']);
assert.deepEqual(ids('has:alt'), ['1']);
assert.deepEqual(ids('alt:horse'), ['1']);
assert.deepEqual(ids('has:link'), ['1']);
assert.deepEqual(ids('link:esa.int'), ['1']);
assert.deepEqual(ids('has:hashtag'), ['1']);
assert.deepEqual(ids('name:lovelace'), ['2', '1']);
assert.deepEqual(ids('has:snapshot'), ['3']);
assert.ok(search.queryIssues('has:unicorn').length === 1);

// Thread gaps: a reply whose parent is not archived; a quote whose quoted post is.
assert.deepEqual(ids('has:gap'), ['2']);
assert.deepEqual(ids('is:gap'), ['2']);
assert.deepEqual(ids('has:missing-quote'), []);

// Media shape.
assert.deepEqual(ids('duration:>60'), ['2']);
assert.deepEqual(ids('duration:>1m'), ['2']);
assert.deepEqual(ids('duration:<1m'), ['3', '1']);
assert.deepEqual(ids('res:4k'), ['1']);
assert.deepEqual(ids('res:>=720'), ['2', '1']);
assert.deepEqual(ids('aspect:portrait'), ['2']);
assert.deepEqual(ids('aspect:wide'), ['1']);
assert.deepEqual(ids('aspect:tall'), ['2']);
assert.ok(search.queryIssues('aspect:round').length === 1);

// Engagement, length, time of day.
assert.equal(search.engagementRate({ likes: 10, reposts: 2, replies: 1, views: 100 }), 13);
assert.equal(search.engagementRate({ likes: 10 }), 0);
assert.deepEqual(ids('engagement:>20%'), ['2']);
assert.deepEqual(ids('words:>5'), ['1']);
assert.deepEqual(ids('chars:>30'), ['1']);
assert.deepEqual(ids('chars:19'), ['3', '2']);
assert.deepEqual(ids('weekday:mon'), ['1']);
assert.deepEqual(ids('weekday:weekend'), ['2']);
assert.deepEqual(ids('weekday:weekday'), ['1']);
assert.deepEqual(ids('hour:9'), ['1']);
assert.deepEqual(ids('hour:22-6'), ['2'], 'hour spans wrap past midnight');
assert.ok(search.queryIssues('weekday:someday').length === 1);
assert.ok(search.queryIssues('hour:25').length === 1);

// Colour labels and topics.
assert.deepEqual(ids('label:blue'), ['1']);
assert.deepEqual(ids('color:blue'), ['1']);
assert.deepEqual(ids('label:any'), ['1']);
assert.deepEqual(ids('label:none'), ['3', '2']);
assert.deepEqual(ids('is:labeled'), ['1']);
assert.ok(search.queryIssues('label:pink').length === 1);
assert.deepEqual(ids('topic:space'), ['1']);
assert.deepEqual(ids('cluster:espresso'), ['2']);

// Typo tolerance and diacritic folding.
assert.deepEqual(ids('telescpe~'), ['1']);
assert.deepEqual(ids('nebual~'), ['1']);
assert.deepEqual(ids('telescpe'), [], 'without ~ the spelling must match');
assert.deepEqual(ids('cafe'), ['2'], 'diacritics fold');

// Time travel: posts archived on or before the day.
assert.deepEqual(ids('asof:2024-06-01'), ['2', '1']);
assert.deepEqual(ids('as-of:2024-05-13'), []);
assert.ok(search.queryIssues('asof:2024-02-31').length === 1);

// Joins the worker has to provide.
const needs = search.queryNeeds(search.compileQuery('has:gap topic:space has:snapshot'), 'quality');
assert.deepEqual(needs, { archivedIds: true, snapshotIds: true, clusterIds: true, sortValue: true });
assert.deepEqual(search.queryNeeds(search.compileQuery('cats'), 'new'), {
  archivedIds: false,
  snapshotIds: false,
  clusterIds: false,
  sortValue: false,
});

// New sorts.
for (const key of [
  'posted',
  'posted-old',
  'engagement',
  'longest',
  'shortest',
  'quality',
  'quality-low',
  'edited',
  'duration',
  'resolution',
  'checked-old',
])
  assert.ok(search.SORT_KEYS.includes(key), key);
assert.deepEqual(ids('', 'posted'), ['2', '1', '3']);
assert.deepEqual(ids('', 'posted-old'), ['1', '2', '3']);
assert.deepEqual(ids('', 'engagement').slice(0, 2), ['2', '1']);
assert.deepEqual(ids('', 'longest'), ['1', '3', '2']);
assert.deepEqual(ids('', 'shortest'), ['3', '2', '1'], 'equal lengths fall back to newest archived first');
assert.equal(ids('', 'quality-low')[0], '3');
assert.equal(ids('', 'quality').at(-1), '3');
assert.equal(ids('', 'edited')[0], '1');
assert.equal(ids('', 'duration')[0], '2');
assert.equal(ids('', 'resolution')[0], '1');
assert.deepEqual(ids('', 'checked-old'), ['3', '2', '1']);
// Rank rows (no filters) compute the same sort value.
assert.equal(search.projectRankPost(posts[1], 1, { sort: 'duration' }).sortValue, 95000);

console.log('library search v21 tests passed');
