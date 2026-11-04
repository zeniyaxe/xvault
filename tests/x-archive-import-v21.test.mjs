// XVault 21: long posts (note-tweet.js), community posts, recently deleted posts and ZIP media.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  attachNotes,
  buildStoredZip,
  deletedFromArchive,
  listZip,
  matchMediaFiles,
  noteFromArchive,
  readXArchive,
  zipEntryBlob,
} from '../x-archive-import.mjs';

const ytd = (name, value) => `window.YTD.${name}.part0 = ${JSON.stringify(value)}`;
const account = [{ account: { accountId: '42', username: 'ada_l', accountDisplayName: 'Ada' } }];
const long =
  `Notes on the Analytical Engine: ${'it weaves algebraic patterns just as the Jacquard loom weaves flowers. '.repeat(6)}`.trim();
const created = 'Wed Oct 10 20:19:24 +0000 2018';
const tweets = [
  {
    tweet: {
      id_str: '1600000000000000001',
      full_text: `${long.slice(0, 250)}… https://t.co/abcdef`,
      created_at: created,
      extended_entities: {
        media: [{ id_str: '77', type: 'photo', media_url_https: 'https://pbs.twimg.com/media/abc.jpg' }],
      },
    },
  },
  { tweet: { id_str: '1600000000000000002', full_text: 'A short one', created_at: created } },
];
const notes = [
  { noteTweet: { noteTweetId: '9001', createdAt: '2018-10-10T20:21:00.000Z', core: { text: long } } },
  {
    noteTweet: {
      noteTweetId: '9002',
      createdAt: '2018-10-10T20:19:00.000Z',
      core: { text: 'Unrelated long text that matches nothing at all' },
    },
  },
  { noteTweet: { noteTweetId: '9003', core: {} } },
];
const community = [
  {
    tweet: {
      id_str: '1600000000000000003',
      full_text: 'In the community',
      created_at: created,
      extended_entities: {
        media: [
          {
            id_str: '88',
            type: 'video',
            media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/88/pu/img/t.jpg',
            video_info: {
              variants: [
                {
                  url: 'https://video.twimg.com/ext_tw_video/88/pu/vid/720x1280/clip.mp4?tag=12',
                  bitrate: '1',
                  content_type: 'video/mp4',
                },
              ],
            },
          },
        ],
      },
    },
  },
];
const deleted = [
  {
    tweet: {
      id_str: '1600000000000000004',
      full_text: 'Regretted',
      created_at: created,
      deleted_at: '2019-01-01T00:00:00.000Z',
    },
  },
];

test('note-tweet.js restores the full text of long posts', () => {
  assert.equal(noteFromArchive(notes[2]), null);
  assert.deepEqual(noteFromArchive(notes[0]), { noteId: '9001', createdAt: '2018-10-10T20:21:00.000Z', text: long });
  const rows = [
    {
      id: '1',
      text: `${long.slice(0, 250)}… https://t.co/abcdef`,
      createdAt: '2018-10-10T20:19:24.000Z',
      sourceFlags: ['x-archive'],
    },
    { id: '2', text: 'A short one', createdAt: '2018-10-10T20:19:24.000Z' },
    { id: '3', text: `${long.slice(0, 250)}…`, createdAt: '2018-10-10T23:00:00.000Z' },
  ];
  const result = attachNotes(rows, notes.map(noteFromArchive).filter(Boolean));
  assert.deepEqual(result, { attached: 1, unmatched: 1 });
  assert.equal(rows[0].text, long);
  assert.equal(rows[0].noteTweetId, '9001');
  assert.deepEqual(rows[0].sourceFlags, ['x-archive', 'x-archive-note']);
  assert.equal(rows[1].text, 'A short one', 'short posts are never replaced');
  assert.ok(rows[2].text.endsWith('…'), 'outside the ten-minute window nothing is attached');
});

test('deleted-tweets.js rows keep when you deleted them', () => {
  const row = deletedFromArchive(deleted[0], account[0].account);
  assert.equal(row.archiveDeletedAt, '2019-01-01T00:00:00.000Z');
  assert.ok(row.sourceFlags.includes('x-archive-deleted'));
  assert.equal(deletedFromArchive({ tweet: { id_str: 'bad' } }), null);
});

test('a full archive ZIP imports community, deleted, notes and matching media but never DMs', async () => {
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const mp4 = new Uint8Array(64).fill(7);
  const files = {
    'data/account.js': ytd('account', account),
    'data/tweets.js': ytd('tweets', tweets),
    'data/note-tweet.js': ytd('note_tweet', notes),
    'data/community-tweet.js': ytd('community_tweet', community),
    'data/deleted-tweets.js': ytd('deleted_tweets', deleted),
    'data/direct-messages.js': ytd('direct_messages', [{ dmConversation: { messages: [{ text: 'private' }] } }]),
    'data/direct_messages_media/123-secret.jpg': new Uint8Array(10),
    'data/tweets_media/1600000000000000001-abc.jpg': jpg,
    'data/tweets_media/1600000000000000001-unknown.jpg': new Uint8Array(3),
    'data/tweets_media/1999-orphan.jpg': new Uint8Array(3),
    'data/community_tweet_media/1600000000000000003-clip.mp4': mp4,
    'data/deleted_tweets_media/1600000000000000004-empty.jpg': new Uint8Array(0),
  };
  const zip = new File([await buildStoredZip(files).arrayBuffer()], 'twitter-archive.zip');
  const archive = await readXArchive(zip);
  assert.deepEqual(
    archive.tweets.map(row => row.id),
    ['1600000000000000001', '1600000000000000002']
  );
  assert.equal(archive.tweets[0].text, long, 'long post text comes from note-tweet.js');
  assert.deepEqual(archive.notes, { found: 2, attached: 1, unmatched: 1 });
  assert.equal(archive.community.length, 1);
  assert.ok(archive.community[0].sourceFlags.includes('x-archive-community'));
  assert.equal(archive.deleted.length, 1);
  assert.equal(archive.deleted[0].archiveDeletedAt, '2019-01-01T00:00:00.000Z');
  assert.deepEqual(archive.skippedPrivate, { files: 2, bytes: archive.skippedPrivate.bytes });
  assert.ok(archive.skippedPrivate.bytes >= 10);
  assert.ok(!archive.files.some(file => /direct/.test(file.name)), 'direct messages are never read');
  assert.equal(archive.mediaFiles, 5, 'counts post, community and deleted media folders only');
  assert.deepEqual(
    archive.media.map(item => [item.tweetId, item.index, item.type, item.ext]),
    [
      ['1600000000000000001', 1, 'photo', 'jpg'],
      ['1600000000000000003', 1, 'video', 'mp4'],
    ]
  );
  assert.equal(archive.media[0].url, archive.tweets[0].media[0].url, 'the download identity is the X CDN address');
  assert.ok(archive.media[1].url.startsWith('https://video.twimg.com/'));

  const photo = await zipEntryBlob(zip, archive.media[0].entry);
  assert.equal(photo.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), jpg, 'stored entries are a slice of the ZIP');
  const video = await zipEntryBlob(zip, archive.media[1].entry);
  assert.equal(video.type, 'video/mp4');
  assert.equal(video.size, 64);

  const onlyTweets = await readXArchive(zip, { include: ['tweets'] });
  assert.equal(onlyTweets.community.length, 0);
  assert.equal(onlyTweets.notes.found, 0);
  assert.ok(onlyTweets.tweets[0].text.endsWith('https://t.co/abcdef'), 'without notes the truncated text stays');
});

test('media matching needs the post and a matching file name', async () => {
  const entries = await listZip(
    buildStoredZip({
      'data/tweets_media/5-a.jpg': new Uint8Array(2),
      'data/tweets_media/5-b.png': new Uint8Array(2),
      'elsewhere/5-a.jpg': new Uint8Array(2),
    })
  );
  const matched = matchMediaFiles(entries, [
    { id: '5', media: [{ id: 'm', type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg?name=orig' }] },
  ]);
  assert.deepEqual(
    matched.map(item => [item.name, item.mediaId]),
    [['a.jpg', 'm']]
  );
});
