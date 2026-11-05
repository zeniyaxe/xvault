// XVault 21 "Forge": pure helpers behind capture extras, revisions, filename templates, link snapshots,
// topic clusters, search suggestions and multilingual meaning search.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { htmlToReadable, snapshotKey, snapshotTargets } from '../sw/link-snapshots.mjs';
import { carryNames, kmeans, labelClusters, suggestK } from '../sw/clusters.mjs';
import { createSearchInsights, suggestibleWords } from '../sw/search-insights.mjs';
import { buildSemanticIndex, nearestTerms, tokenize, transliterate } from '../sw/semantic.mjs';
import { buildArchiveIndicators } from '../archive-indicators.mjs';

const require = createRequire(import.meta.url);
const Diff = require('../revision-diff.js');
const Template = require('../filename-template.js');
const Extras = require('../x-post-extras.js');
const Search = require('../library-search-core.js');

test('word diff keeps unchanged text and reports added and removed words', () => {
  const ops = Diff.diffWords('The quick brown fox jumps.', 'The quick red fox leaps today.');
  assert.deepEqual(
    ops.filter(op => op.type !== 'same').map(op => [op.type, op.text.trim()]),
    [
      ['del', 'brown'],
      ['add', 'red'],
      ['del', 'jumps'],
      ['add', 'leaps today'],
    ]
  );
  assert.deepEqual(Diff.diffStats(ops), { added: 3, removed: 2 });
  assert.deepEqual(Diff.diffWords('same', 'same'), [{ type: 'same', text: 'same' }]);
  assert.deepEqual(Diff.diffWords('', 'new'), [{ type: 'add', text: 'new' }]);
  // Before and after can always be rebuilt from the operations.
  const before = 'Ünïcode — “quotes”, numbers 1,234 and emoji 🚀 stay intact',
    after = 'Ünïcode — “quotes”, numbers 1,235 and emoji 🚀🚀 stay';
  const both = Diff.diffWords(before, after);
  assert.equal(
    both
      .filter(op => op.type !== 'add')
      .map(op => op.text)
      .join(''),
    before
  );
  assert.equal(
    both
      .filter(op => op.type !== 'del')
      .map(op => op.text)
      .join(''),
    after
  );
});

test('changed fields and timelines order revisions oldest first', () => {
  const v1 = { text: 'Launch at 9', author: { name: 'Ada', handle: 'ada' }, media: [], metrics: { likes: 1 } };
  const v2 = {
    ...v1,
    text: 'Launch at 10',
    poll: { choices: [{ label: 'a', count: 1 }] },
    metrics: { likes: 5, views: 10 },
  };
  const v3 = { ...v2, communityNote: { text: 'Launch moved' } };
  const fields = Diff.changedFields(v1, v2);
  assert.deepEqual(
    fields.map(field => field.key),
    ['text', 'poll', 'metrics']
  );
  assert.deepEqual(fields.at(-1).deltas, [
    { key: 'likes', from: 1, to: 5 },
    { key: 'views', from: 0, to: 10 },
  ]);
  const line = Diff.timeline(
    [
      { observedAt: 300, before: v2, after: v3, runId: 'r2' },
      { observedAt: 100, before: v1, after: v2 },
      { observedAt: 200 },
    ],
    v3
  );
  assert.deepEqual(
    line.steps.map(step => step.at),
    [100, 300]
  );
  assert.equal(line.first, v1);
  assert.equal(line.latest, v3);
  assert.ok(line.steps[0].textOps, 'text edits carry a word diff');
  assert.equal(line.steps[1].textOps, null, 'note-only changes have no text diff');
  assert.deepEqual(
    line.steps[1].fields.map(field => field.key),
    ['communityNote']
  );
});

test('filename templates sanitise, warn and preview', () => {
  const item = {
    author: '@ada',
    tweetId: '17',
    index: 2,
    createdAt: new Date(2024, 4, 13, 17, 4, 5).getTime(),
    mediaType: 'video',
    text: 'Héllo, wörld! #space https://t.co/x',
  };
  assert.deepEqual(Template.render('{author}_{date}_{time}_{tweetId}_{index}', item), {
    name: 'ada_2024-05-13_170405_17_02',
    issues: [],
  });
  assert.equal(Template.render('{text:12}_{tweetId}', item).name, 'Hello-world_17');
  assert.equal(Template.filename('{author}-{tweetId}', item, '.mp4'), 'ada-17.mp4');
  const unknown = Template.render('{author}_{nope}_{tweetId}_{index}', item);
  assert.deepEqual(unknown.issues, ['Unknown token {nope}']);
  assert.equal(unknown.name, 'ada__17_02');
  assert.ok(
    Template.render('{author}_{tweetId}', item).issues.some(issue => /photos and videos of one post/.test(issue)),
    'a post id alone does not separate the files of one post'
  );
  assert.ok(
    Template.preview('{author}_{tweetId}').issues.includes('Two of these example files would get the same name')
  );
  assert.ok(
    Template.render('{author}', item).issues.some(issue => /collide/.test(issue)),
    'collision warning'
  );
  assert.ok(Template.render('{author}/{tweetId}', item).issues.some(issue => /folders/.test(issue)));
  assert.equal(Template.render('{year}/{month}/{author}', item, { folder: true }).name, '2024/05/ada');
  assert.equal(Template.segment('con'), '_con', 'Windows device names are escaped');
  assert.equal(Template.segment('a:b*c?.'), 'a_b_c_');
  assert.equal(Template.segment('   '), '_');
  assert.equal(Template.values({}).date, 'undated');
  const preview = Template.preview('{author}_{tweetId}_{index}', '{type}');
  assert.equal(preview.paths.length, 3);
  assert.deepEqual(preview.paths, [
    'image/nasa_1790000000000000001_01.jpg',
    'video/nasa_1790000000000000001_02.mp4',
    'animation/nasa_1790000000000000001_03.mp4',
  ]);
  assert.deepEqual(preview.issues, []);
});

test('rename plans skip unchanged files and never overwrite', () => {
  const rows = [
    { key: 'a', path: 'XVault/ada_1_01.jpg', item: { author: 'ada', tweetId: '1', index: 1 }, ext: 'jpg' },
    { key: 'b', path: 'XVault/1-01.jpg', item: { author: 'ada', tweetId: '1', index: 1 }, ext: 'jpg' },
    { key: 'c', path: 'XVault/2-01.jpg', item: { author: 'bob', tweetId: '2', index: 1 }, ext: 'jpg' },
    { key: 'd', path: 'XVault/bob_2_01.jpg', item: { author: 'zed', tweetId: '9', index: 1 }, ext: 'jpg' },
  ];
  const plan = Template.planRenames(rows, '{author}_{tweetId}_{index}');
  // b's new name belongs to a; c's new name is still d's current file (d moves later), so both wait.
  assert.deepEqual(plan.conflicts, [
    { key: 'b', from: 'XVault/1-01.jpg', to: 'XVault/ada_1_01.jpg' },
    { key: 'c', from: 'XVault/2-01.jpg', to: 'XVault/bob_2_01.jpg' },
  ]);
  assert.deepEqual(plan.moves, [{ key: 'd', from: 'XVault/bob_2_01.jpg', to: 'XVault/zed_9_01.jpg' }]);
  // Planning again after the first moves picks up what was freed.
  const again = Template.planRenames(
    rows.map(row => (row.key === 'd' ? { ...row, path: 'XVault/zed_9_01.jpg' } : row)),
    '{author}_{tweetId}_{index}'
  );
  assert.deepEqual(again.moves, [{ key: 'c', from: 'XVault/2-01.jpg', to: 'XVault/bob_2_01.jpg' }]);
  const foldered = Template.planRenames(rows.slice(2, 3), '{tweetId}', '{author}');
  // The folder template applies inside the file's archive folder (v21 moved files out of XVault/).
  assert.deepEqual(foldered.moves, [{ key: 'c', from: 'XVault/2-01.jpg', to: 'XVault/bob/2.jpg' }]);
});

test('post extras: polls, cards, Spaces, notes, edits, media extras', () => {
  const poll = Extras.parsePoll({
    legacy: {
      name: 'poll3choice_text_only',
      binding_values: [
        { key: 'choice1_label', value: { string_value: 'Yes' } },
        { key: 'choice1_count', value: { string_value: '7' } },
        { key: 'choice2_label', value: { string_value: 'No' } },
        { key: 'choice2_count', value: { string_value: '3' } },
        { key: 'choice3_label', value: { string_value: 'Maybe' } },
        { key: 'counts_are_final', value: { boolean_value: true } },
        { key: 'end_datetime_utc', value: { string_value: '2024-01-02T03:04:05Z' } },
      ],
    },
  });
  assert.deepEqual(poll.choices, [
    { label: 'Yes', count: 7 },
    { label: 'No', count: 3 },
    { label: 'Maybe', count: 0 },
  ]);
  assert.equal(poll.totalVotes, 10);
  assert.equal(poll.final, true);
  assert.equal(poll.endsAt, Date.parse('2024-01-02T03:04:05Z'));
  assert.equal(Extras.parsePoll({ legacy: { name: 'poll2choice_text_only', binding_values: {} } }), null);

  const card = Extras.parseCard({
    legacy: {
      name: 'summary_large_image',
      url: 'https://t.co/abc',
      binding_values: {
        title: { string_value: 'A long read' },
        description: { string_value: 'About engines' },
        card_url: { string_value: 'https://t.co/abc' },
        vanity_url: { string_value: 'Example.COM' },
        thumbnail_image_original: { image_value: { url: 'https://pbs.twimg.com/card_img/1', width: 800, height: 400 } },
      },
    },
  });
  assert.deepEqual(card, {
    name: 'summary_large_image',
    url: 'https://t.co/abc',
    title: 'A long read',
    description: 'About engines',
    domain: 'example.com',
    image: { url: 'https://pbs.twimg.com/card_img/1', width: 800, height: 400 },
  });
  const unified = Extras.parseCard({
    legacy: {
      name: 'unified_card',
      binding_values: {
        unified_card: {
          string_value: JSON.stringify({
            component_objects: { details_1: { type: 'details', data: { title: { content: 'App' } } } },
            destination_objects: {
              d: { data: { url_data: { url: 'https://example.com/app', vanity: 'example.com' } } },
            },
          }),
        },
      },
    },
  });
  assert.equal(unified.title, 'App');
  assert.equal(unified.url, 'https://example.com/app');
  assert.equal(
    Extras.parseCard({ legacy: { name: 'unified_card', binding_values: { unified_card: { string_value: '{bad' } } } }),
    null
  );
  assert.equal(
    Extras.parseCard({
      legacy: { name: 'summary', binding_values: { card_url: { string_value: 'javascript:alert(1)' } } },
    }),
    null
  );

  assert.deepEqual(
    Extras.parseSpace({
      legacy: { name: '3691233323:audiospace', binding_values: { id: { string_value: '1YqKDqWqdPdJV' } } },
    }),
    {
      id: '1YqKDqWqdPdJV',
      url: 'https://x.com/i/spaces/1YqKDqWqdPdJV',
    }
  );
  assert.equal(
    Extras.parseSpace({ legacy: { name: 'x:audiospace', binding_values: { id: { string_value: '../evil' } } } }),
    null
  );

  assert.deepEqual(
    Extras.parseCommunityNote({
      title: 'Readers added context',
      subtitle: { text: 'The photo is from 2019.' },
      destinationUrl: 'https://twitter.com/i/birdwatch/n/1234567890',
    }),
    {
      id: '1234567890',
      title: 'Readers added context',
      text: 'The photo is from 2019.',
      url: 'https://x.com/i/birdwatch/n/1234567890',
    }
  );
  assert.equal(Extras.parseCommunityNote({ title: 'empty' }), null);

  assert.deepEqual(
    Extras.parseEdit({
      edit_control_initial: {
        edit_tweet_ids: ['1', '2', 'x'],
        editable_until_msecs: '1700000000000',
        edits_remaining: '3',
      },
    }),
    {
      ids: ['1', '2'],
      initialId: '1',
      latestId: '2',
      editableUntil: 1700000000000,
      remaining: 3,
      edited: true,
    }
  );
  assert.equal(Extras.parseEdit({ initial_tweet_id: '5', edit_tweet_ids: ['5'] }).edited, false);
  assert.equal(Extras.parseEdit({}), null);

  assert.deepEqual(
    Extras.parseMediaExtras({
      ext_alt_text: '  A cat  ',
      video_info: { duration_millis: 12345, aspect_ratio: [16, 9] },
    }),
    {
      altText: 'A cat',
      durationMs: 12345,
      aspectRatio: [16, 9],
    }
  );
  assert.deepEqual(Extras.parseMediaExtras({ video_info: { aspect_ratio: [0, 9] } }), {});
  const extras = Extras.parseTweetExtras({
    card: {
      legacy: {
        name: 'poll2choice_text_only',
        binding_values: [
          { key: 'choice1_label', value: { string_value: 'A' } },
          { key: 'choice2_label', value: { string_value: 'B' } },
        ],
      },
    },
    birdwatch_pivot: { subtitle: { text: 'Context' } },
    edit_control: { edit_tweet_ids: ['9'] },
  });
  assert.deepEqual(Object.keys(extras), ['poll', 'communityNote', 'edit']);
});

test('availability: tombstones and explicit focal-post errors only', () => {
  const tomb = (entryId, typename, text) => ({
    entryId,
    content: { itemContent: { tweet_results: { result: { __typename: typename, tombstone: { text: { text } } } } } },
  });
  assert.deepEqual(
    Extras.tombstoneOf(tomb('tweet-42', 'TweetTombstone', 'This Post was deleted by the Post author.')),
    {
      id: '42',
      state: 'deleted',
      reason: 'This Post was deleted by the Post author.',
    }
  );
  assert.equal(Extras.tombstoneOf(tomb('tweet-42', 'TweetTombstone', 'This account is suspended')).state, 'suspended');
  assert.equal(
    Extras.tombstoneOf(
      tomb(
        'conversationthread-1-tweet-43',
        'TweetUnavailable',
        'You’re unable to view this Post because this account owner limits who can view their Posts. Not authorized'
      )
    ).state,
    'protected'
  );
  assert.equal(Extras.tombstoneOf(tomb('tweet-44', 'TweetTombstone', 'Withheld in your country')).state, 'withheld');
  assert.equal(Extras.tombstoneOf(tomb('tweet-45', 'Tweet', 'normal')), null, 'live posts are not tombstones');
  assert.equal(Extras.tombstoneOf(tomb('cursor-top-1', 'TweetTombstone', 'deleted')), null);

  const meta = { operation: 'TweetDetail', variables: { focalTweetId: '77' } };
  assert.deepEqual(Extras.focalUnavailable({ errors: [{ message: 'No status found with that ID.' }] }, meta), {
    id: '77',
    state: 'deleted',
    reason: 'No status found with that ID.',
  });
  assert.equal(
    Extras.focalUnavailable(
      { data: { tweetResult: {} } },
      { operation: 'TweetResultByRestId', variables: { tweetId: '78' } }
    ).state,
    'unavailable'
  );
  assert.equal(Extras.focalUnavailable({ data: { tweetResult: { result: { __typename: 'Tweet' } } } }, meta), null);
  assert.equal(
    Extras.focalUnavailable(
      { errors: [{ message: 'deleted' }] },
      { operation: 'HomeTimeline', variables: { focalTweetId: '77' } }
    ),
    null,
    'other operations never mark posts gone'
  );
  assert.equal(Extras.focalUnavailable({}, { operation: 'TweetDetail', variables: { focalTweetId: 'abc' } }), null);
});

test('message-boundary validation of extras and availability', () => {
  assert.equal(
    Extras.validExtras({
      poll: {
        choices: [
          { label: 'a', count: 1 },
          { label: 'b', count: 2 },
        ],
      },
      media: [{ altText: 'x', durationMs: 5 }],
    }),
    true
  );
  assert.throws(() => Extras.validExtras({ poll: { choices: [{ label: 'a', count: 1 }] } }), /poll/);
  assert.throws(() => Extras.validExtras({ card: { url: 'javascript:alert(1)' } }), /card/);
  assert.throws(
    () => Extras.validExtras({ card: { url: 'https://a.example', image: { url: 'http://insecure' } } }),
    /card/
  );
  assert.throws(() => Extras.validExtras({ space: { id: '<script>' } }), /Space/);
  assert.throws(() => Extras.validExtras({ communityNote: { text: 'x'.repeat(4001) } }), /Community Note/);
  assert.throws(() => Extras.validExtras({ edit: { ids: ['1', 'drop table'] } }), /edit history/);
  assert.throws(() => Extras.validExtras({ media: [{ altText: 5 }] }), /alt text/);
  assert.throws(() => Extras.validExtras({ media: [{ durationMs: -1 }] }), /duration/);
  assert.equal(Extras.validAvailability({ id: '1', state: 'deleted', reason: 'gone' }), true);
  assert.equal(Extras.validAvailability({ id: '1', state: 'exploded' }), false);
  assert.equal(Extras.validAvailability({ id: '1', state: 'deleted', reason: 'x'.repeat(301) }), false);
  assert.equal(Extras.validAvailability({ id: '../1', state: 'deleted' }), false);
});

test('link snapshots: readable text, metadata and target choice', () => {
  const page = `<!doctype html><html lang="en-GB"><head><title>Engines &amp; thought</title>
    <meta name="description" content="On the &quot;Analytical&quot; engine">
    <meta property="og:site_name" content="Example Press"><link rel="canonical" href="https://example.com/a"></head>
    <body><nav>Menu Home About</nav><script>alert(1)</script><style>.x{}</style>
    <article><h1>Heading</h1><p>${'Lorem ipsum dolor sit amet. '.repeat(20)}</p><ul><li>One</li><li>Two</li></ul></article>
    <footer>© footer</footer></body></html>`;
  const out = htmlToReadable(page);
  assert.equal(out.title, 'Engines & thought');
  assert.equal(out.description, 'On the "Analytical" engine');
  assert.equal(out.siteName, 'Example Press');
  assert.equal(out.canonical, 'https://example.com/a');
  assert.equal(out.lang, 'en-gb');
  assert.ok(out.text.startsWith('Heading'));
  assert.ok(out.text.includes('• One'));
  assert.ok(!/alert|Menu|footer/.test(out.text), 'scripts, navigation and footers are dropped');
  assert.equal(htmlToReadable(page, { maxText: 10 }).text.length, 10);
  assert.equal(htmlToReadable('').title, '');
  assert.equal(snapshotKey('1', 'https://a.example/'), '1|https://a.example/');
  assert.deepEqual(
    snapshotTargets({
      links: [
        'https://t.co/abc',
        'https://x.com/ada/status/1',
        'https://mobile.twitter.com/a',
        'https://user:pw@example.com/secret',
        'ftp://example.com/file',
        'https://example.com/a#section',
        'https://example.com/a',
        'not a url',
        'https://blog.example.org/post',
      ],
    }),
    ['https://example.com/a', 'https://blog.example.org/post']
  );
  assert.deepEqual(snapshotTargets({ links: [], card: { url: 'https://news.example/story' } }), [
    'https://news.example/story',
  ]);
  assert.deepEqual(
    snapshotTargets({ links: ['https://a.example/1', 'https://a.example/2', 'https://a.example/3'] }, 2),
    ['https://a.example/1', 'https://a.example/2']
  );
});

test('topic clusters: k-means separates groups, labels them and keeps names', () => {
  assert.equal(suggestK(0), 2);
  assert.equal(suggestK(300), 10);
  assert.equal(suggestK(1e7), 40);
  const DIM = 128,
    count = 60,
    vectors = new Int8Array(count * DIM);
  for (let row = 0; row < count; row++) {
    const group = row % 3;
    for (let d = 0; d < DIM; d++) vectors[row * DIM + d] = d % 3 === group ? 100 + ((row * 7 + d) % 20) : (row + d) % 5;
  }
  // Row 59 stays empty (posts without a vector are left unassigned).
  vectors.fill(0, 59 * DIM);
  const result = kmeans(vectors, count, { k: 3, seed: 3 });
  assert.equal(result.k, 3);
  assert.equal(result.assignments[59], -1);
  for (let row = 3; row < 59; row++)
    assert.equal(result.assignments[row], result.assignments[row % 3], `row ${row} joins its group`);
  assert.equal(new Set([result.assignments[0], result.assignments[1], result.assignments[2]]).size, 3);
  assert.deepEqual([...result.sizes].sort(), [19, 20, 20]);
  assert.ok(result.scores[0] > 0.9);
  assert.equal(kmeans(new Int8Array(DIM * 2), 2).k, 0, 'no vectors, no clusters');

  const labels = labelClusters(
    new Map([
      [0, ['rocket launch today', 'rocket engines and launch pads', 'launch window opens', 'the rocket is ready']],
      [1, ['sourdough bread recipe', 'bread flour and water', 'baking bread at home', 'recipe for rye bread']],
      [2, ['the market opens', 'market news', 'stocks and the market', 'market close']],
    ]),
    { stop: new Set(['the', 'and', 'for']) }
  );
  assert.deepEqual(labels.get(0).slice(0, 2).sort(), ['launch', 'rocket']);
  assert.equal(labels.get(1)[0], 'bread');
  assert.equal(labels.get(2)[0], 'market');

  const carried = carryNames(
    [
      { id: 'c0', name: 'Space', terms: ['rocket', 'launch', 'nasa'] },
      { id: 'c1', name: 'Food', terms: ['pasta', 'cheese'] },
    ],
    [
      { id: 'c0', terms: ['bread', 'recipe'] },
      { id: 'c1', terms: ['rocket', 'launch', 'orbit'] },
    ]
  );
  assert.equal(carried[0].name, undefined, 'no overlap, no name');
  assert.equal(carried[1].name, 'Space', 'half the words in common carries the name');
});

test('multilingual meaning search: transliteration, diacritics and did-you-mean vocabulary', () => {
  assert.equal(transliterate('москва'), 'moskva');
  assert.equal(transliterate('αθήνα'), '', 'accented Greek is folded before transliteration in tokenize');
  assert.equal(transliterate('paris'), '');
  const cyrillic = tokenize('Москва зимой');
  assert.ok(cyrillic.includes('moskva'), 'Cyrillic words also index their Latin spelling');
  assert.ok(cyrillic.includes('москва'));
  assert.deepEqual(tokenize('Café crème'), tokenize('cafe creme'), 'diacritics fold');
  const surfaces = new Map();
  tokenize('Launching rockets', surfaces);
  assert.equal(surfaces.get('launch'), 'launching');
  const index = buildSemanticIndex(
    [
      { id: '1', text: 'Telescope images of the nebula' },
      { id: '2', text: 'A new telescope mirror' },
      { id: '3', text: 'Nebula colours explained' },
    ],
    { dimensions: 128 }
  );
  const nearest = nearestTerms(index, 'telescpe', { distance: 2, editDistance: Search.editDistance });
  assert.equal(nearest[0], 'telescope');
  assert.deepEqual(
    nearestTerms(index, 'telescope', { distance: 2, editDistance: Search.editDistance }),
    [],
    'known words have no suggestion'
  );
  assert.deepEqual(nearestTerms(index, 'ab', { editDistance: Search.editDistance }), []);
});

test('search suggestions and Smart Collection alerts', async () => {
  assert.deepEqual(
    suggestibleWords('telescpe from:nasa "exact phrase" -noise #tag @user nebula~ ok images').map(word => word.token),
    ['telescpe', 'images']
  );
  const store = {};
  const chromeApi = {
    storage: {
      local: {
        get: async key => ({ [key]: store[key] }),
        set: async value => Object.assign(store, value),
      },
    },
  };
  const index = buildSemanticIndex(
    [
      { id: '1', text: 'Telescope images of the nebula' },
      { id: '2', text: 'Telescope mirrors' },
    ],
    { dimensions: 128 }
  );
  let clock = 1000;
  const posts = [
    { id: 'a', text: 'cats', archivedAt: 1500 },
    { id: 'b', text: 'dogs', archivedAt: 1600 },
    { id: 'c', text: 'cats again', archivedAt: 900 },
  ];
  const insights = createSearchInsights({
    chromeApi,
    semanticIndex: async () => index,
    editDistance: Search.editDistance,
    readRecords: async () => [],
    postsArchivedSince: async since => posts.filter(post => post.archivedAt > since),
    matcherFor: async query => post => post.text.includes(query),
    getSettings: async () => ({ savedViews: [{ query: 'cats', name: 'Cats' }, null, { query: 'dogs' }] }),
    meta: { get: async () => null, set: async () => {} },
    collectionId: view => `view-${view.query}`,
    now: () => clock,
  });
  const suggestions = await insights.suggest({ query: 'telescpe imagess' });
  assert.equal(suggestions.suggestions[0].query, 'telescope images');
  assert.deepEqual(
    suggestions.suggestions.map(entry => entry.kind),
    ['spelling', 'fuzzy', 'meaning']
  );
  assert.equal(suggestions.suggestions[1].query, 'telescpe~ imagess~');
  assert.deepEqual((await insights.suggest({ query: 'from:nasa' })).suggestions, []);

  await insights.initVisits();
  assert.deepEqual(
    Object.keys(store.xvViewVisits).sort(),
    ['view-cats', 'view-dogs'],
    'collection ids match the Library rows'
  );
  clock = 2000;
  const alerts = await insights.alerts();
  assert.deepEqual(alerts.counts, { 'view-cats': 1, 'view-dogs': 1 });
  await insights.handle({ type: 'SAVED_VIEW_VISITED', id: 'view-cats' });
  assert.equal((await insights.alerts()).counts['view-cats'], 0);
  await assert.rejects(insights.handle({ type: 'SAVED_VIEW_VISITED', id: '' }), /Invalid collection/);
});

test('x.com badges carry only edited / gone booleans', () => {
  const rows = buildArchiveIndicators(
    ['1', '2', '3'],
    [
      { id: '1', textRevisionCount: 2, availability: { state: 'available' } },
      { id: '2', availability: { state: 'deleted' }, text: 'secret', userMeta: { note: 'private' } },
    ],
    []
  );
  assert.deepEqual(rows, [
    { id: '1', status: 'archived', edited: true },
    { id: '2', status: 'archived', gone: true },
    { id: '3', status: 'not-archived' },
  ]);
  assert.ok(!JSON.stringify(rows).includes('secret'));
});

test('link snapshots never target this computer or the local network', () => {
  const local = [
    'http://localhost:8080/admin',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://10.1.2.3/',
    'http://192.168.1.1/',
    'http://172.20.0.5/',
    'http://169.254.169.254/latest/meta-data',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://printer.local/',
    'http://router/',
    'http://dev.localhost/',
  ];
  assert.deepEqual(snapshotTargets({ links: local }), []);
  assert.deepEqual(snapshotTargets({ links: ['http://172.32.0.1/', 'https://[2001:db8::1]/'] }), [
    'http://172.32.0.1/',
    'https://[2001:db8::1]/',
  ]);
  assert.deepEqual(snapshotTargets({ links: [], card: { url: 'http://192.168.0.1/' } }), []);
});

test('link snapshot service: permission, caps, errors and de-duplication (simulated fetch)', async () => {
  const { createLinkSnapshots } = await import('../sw/link-snapshots.mjs');
  const rows = new Map();
  let revision = 0;
  const store = {
    revision: async () => revision,
    bump: async () => void revision++,
    getAll: async () => [...rows.values()],
    getMany: async (_, keys) => new Map(keys.filter(key => rows.has(key)).map(key => [key, rows.get(key)])),
    putMany: async (_, list) => list.forEach(row => rows.set(row.key, row)),
    count: async () => rows.size,
    clear: async () => rows.clear(),
  };
  const pages = {
    'https://ok.example/a': {
      status: 200,
      type: 'text/html; charset=utf-8',
      body: '<title>OK</title><body><p>Hello world</p></body>',
    },
    'https://big.example/': { status: 200, type: 'text/html', body: `<body>${'x'.repeat(100000)}</body>` },
    'https://pdf.example/file': { status: 200, type: 'application/pdf', body: '%PDF' },
    'https://gone.example/': { status: 404, type: 'text/html', body: 'nope' },
    'https://redirect.example/': { status: 200, type: 'text/html', body: 'router page', url: 'http://192.168.1.1/' },
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push([url, options.credentials]);
    const page = pages[url];
    const bytes = new TextEncoder().encode(page.body);
    let sent = false;
    return {
      status: page.status,
      ok: page.status < 400,
      url: page.url || url,
      headers: { get: () => page.type },
      body: {
        getReader: () => ({
          read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })),
          cancel: async () => {},
        }),
      },
    };
  };
  let allowed = false;
  const announced = [];
  const service = createLinkSnapshots({
    store,
    readPosts: async ids =>
      ids.map(id => ({
        id,
        links:
          {
            1: ['https://ok.example/a', 'https://pdf.example/file'],
            2: ['https://gone.example/', 'https://big.example/'],
            3: ['https://redirect.example/'],
          }[id] || [],
      })),
    getSettings: async () => ({ linkSnapshotMaxKB: 32 }),
    hasPermission: async () => allowed,
    fetchImpl,
    announce: ids => announced.push(...ids),
  });
  assert.match((await service.enqueue(['1'])).error, /Allow XVault to read linked websites/);
  allowed = true;
  const queued = await service.enqueue(['1', '2', '3']);
  assert.equal(queued.queued, 5);
  while ((await service.handle({ type: 'SNAPSHOT_STATUS' })).pending)
    await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(
    requests.every(([, credentials]) => credentials === 'omit'),
    'cookies are never sent'
  );
  const byUrl = Object.fromEntries([...rows.values()].map(row => [row.url, row]));
  assert.equal(byUrl['https://ok.example/a'].status, 'ok');
  assert.equal(byUrl['https://ok.example/a'].title, 'OK');
  assert.equal(byUrl['https://ok.example/a'].text, 'Hello world');
  assert.match(byUrl['https://pdf.example/file'].error, /Not a web page/);
  assert.equal(byUrl['https://gone.example/'].error, 'HTTP 404');
  assert.equal(byUrl['https://big.example/'].truncated, true);
  assert.ok(byUrl['https://big.example/'].text.length <= 32 * 1024);
  assert.match(byUrl['https://redirect.example/'].error, /Redirected to a local/);
  assert.ok(!byUrl['https://redirect.example/'].text, 'nothing from the redirect target is kept');
  assert.deepEqual([...(await service.postIds())].sort(), ['1', '2']);
  assert.deepEqual(new Set(announced), new Set(['1', '2', '3']));
  // Successful snapshots are not fetched again unless forced; failures are retried.
  requests.length = 0;
  assert.equal((await service.enqueue(['1'])).queued, 1);
  const forced = await service.enqueue(['1'], { force: true });
  assert.equal(forced.queued, 1, 'pending or in-flight entries are not queued twice');
  const forPost = await service.handle({ type: 'SNAPSHOT_FOR_POST', id: '1' });
  assert.equal(forPost.snapshots.length, 2);
  await service.handle({ type: 'SNAPSHOT_CLEAR' });
  assert.equal(rows.size, 0);
});
