import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
  buildStoredZip,
  listZip,
  parseYtd,
  readXArchive,
  readZipEntry,
  savedFromArchive,
  tweetFromArchive,
} from '../x-archive-import.mjs';

const account = [{ account: { accountId: '42', username: 'ada_l', accountDisplayName: 'Ada' } }];
const tweets = [
  {
    tweet: {
      id_str: '1600000000000000001',
      full_text: 'Engines of thought #Math with @Charles https://t.co/x',
      created_at: 'Wed Oct 10 20:19:24 +0000 2018',
      favorite_count: '12',
      retweet_count: '3',
      lang: 'en',
      in_reply_to_status_id_str: '1599999999999999999',
      in_reply_to_screen_name: 'charles',
      entities: {
        hashtags: [{ text: 'Math' }],
        user_mentions: [{ screen_name: 'Charles' }, { screen_name: 'bad handle!' }],
        urls: [{ expanded_url: 'https://example.com/notes' }, { expanded_url: 'javascript:alert(1)' }],
      },
      extended_entities: {
        media: [
          {
            id_str: '77',
            type: 'photo',
            media_url_https: 'https://pbs.twimg.com/media/abc.jpg',
            original_info: { width: 1200, height: 800 },
          },
          {
            id_str: '78',
            type: 'video',
            media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/78/pu/img/t.jpg',
            video_info: {
              variants: [
                {
                  url: 'https://video.twimg.com/ext_tw_video/78/low.mp4',
                  bitrate: '256000',
                  content_type: 'video/mp4',
                },
                {
                  url: 'https://video.twimg.com/ext_tw_video/78/high.mp4',
                  bitrate: '2176000',
                  content_type: 'video/mp4',
                },
                { url: 'https://evil.example/steal.mp4', bitrate: '9999999', content_type: 'video/mp4' },
                { url: 'https://video.twimg.com/ext_tw_video/78/pl.m3u8', content_type: 'application/x-mpegURL' },
              ],
            },
          },
        ],
      },
    },
  },
  { tweet: { id_str: '1600000000000000002', full_text: 'RT @someone: shared thing', created_at: 'nonsense' } },
  { tweet: { id_str: 'not-a-number', full_text: 'dropped' } },
];
const likes = [
  { like: { tweetId: '1500', fullText: 'Liked post', expandedUrl: 'https://twitter.com/Grace/status/1500' } },
  { like: { tweetId: '1501', expandedUrl: 'https://twitter.com/i/web/status/1501' } },
  { like: { tweetId: '' } },
];
const bookmarks = [{ bookmark: { tweetId: '1700', fullText: 'Saved for later' } }];
const ytd = (name, value) => `window.YTD.${name}.part0 = ${JSON.stringify(value, null, 1)}`;

// parseYtd accepts the assignment wrapper, a BOM and plain JSON.
assert.equal(parseYtd(`\uFEFF${ytd('tweets', tweets)}`).length, 3);
assert.deepEqual(parseYtd('{"a":1}'), [{ a: 1 }]);
assert.deepEqual(parseYtd('nothing here'), []);

// Mapping.
const row = tweetFromArchive(tweets[0], account[0].account);
assert.equal(row.id, '1600000000000000001');
assert.equal(row.url, 'https://x.com/ada_l/status/1600000000000000001');
assert.deepEqual(row.author, { id: '42', handle: 'ada_l', name: 'Ada' });
assert.equal(row.createdAt, '2018-10-10T20:19:24.000Z');
assert.deepEqual(row.metrics, { likes: 12, reposts: 3 });
assert.equal(row.replyToId, '1599999999999999999');
assert.deepEqual(row.hashtags, ['math']);
assert.deepEqual(row.mentions, ['charles']);
assert.deepEqual(row.links, ['https://example.com/notes']);
assert.equal(row.media.length, 2);
assert.equal(row.media[0].url, 'https://pbs.twimg.com/media/abc.jpg?name=orig', 'photos ask for the original size');
assert.equal(row.media[0].width, 1200);
assert.equal(row.media[1].playbackUrl, 'https://video.twimg.com/ext_tw_video/78/high.mp4', 'best X-hosted MP4 wins');
assert.ok(
  row.media[1].variants.every(variant => variant.url.startsWith('https://video.twimg.com/')),
  'foreign hosts dropped'
);
assert.deepEqual(row.sourceFlags, ['x-archive', 'x-archive-post']);
assert.equal(row.observedAt, 1, 'imports are an old observation so live captures win');
const retweet = tweetFromArchive(tweets[1], account[0].account);
assert.equal(retweet.createdAt, null);
assert.deepEqual(retweet.sourceFlags, ['x-archive', 'x-archive-repost']);
assert.equal(tweetFromArchive(tweets[2]), null);
assert.equal(
  tweetFromArchive(tweets[0]).url,
  'https://x.com/i/status/1600000000000000001',
  'no account → i/status link'
);

const liked = savedFromArchive(likes[0], 'likes');
assert.equal(liked.url, 'https://x.com/Grace/status/1500');
assert.deepEqual(liked.author, { handle: 'Grace' });
assert.deepEqual(liked.archiveSources, ['likes', 'x-archive']);
assert.deepEqual(savedFromArchive(likes[1], 'likes').author, {}, 'i/web links carry no handle');
assert.equal(savedFromArchive(likes[2]), null);
assert.deepEqual(savedFromArchive(bookmarks[0], 'bookmarks').sourceFlags, ['x-archive', 'x-archive-bookmark']);

// A stored ZIP laid out like X's archive.
const files = {
  'data/manifest.js': ytd('manifest', { archiveInfo: { generationDate: '2026-05-01T00:00:00.000Z' } }),
  'data/account.js': ytd('account', account),
  'data/tweets.js': ytd('tweets', tweets),
  'data/like.js': ytd('like', likes),
  'data/bookmark.js': ytd('bookmark', bookmarks),
  'data/tweets_media/1600000000000000001-abc.jpg': new Uint8Array([1, 2, 3]),
  'Your archive.html': '<html></html>',
};
const stored = new File([await buildStoredZip(files).arrayBuffer()], 'twitter-2026.zip');
const entries = await listZip(stored);
assert.deepEqual(
  entries.map(entry => entry.name),
  Object.keys(files)
);
assert.equal(new TextDecoder().decode(await readZipEntry(stored, entries[6])), '<html></html>');
const progress = [];
const archive = await readXArchive(stored, { onProgress: event => progress.push(event.phase) });
assert.equal(archive.account.username, 'ada_l');
assert.equal(archive.generatedAt, '2026-05-01T00:00:00.000Z');
assert.equal(archive.tweets.length, 2);
assert.equal(archive.tweets[0].author.handle, 'ada_l', 'account is read before tweets');
assert.equal(archive.likes.length, 2);
assert.equal(archive.bookmarks.length, 1);
assert.equal(archive.mediaFiles, 1);
assert.equal(progress.at(-1), 'parsed');
const onlyLikes = await readXArchive(stored, { include: ['likes'] });
assert.equal(onlyLikes.tweets.length, 0);
assert.equal(onlyLikes.likes.length, 2);

// A deflated ZIP (how X actually ships it), built with zlib.
function deflatedZip(entries) {
  const parts = [],
    central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text),
      packed = deflateRawSync(data),
      nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, packed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return new File([...parts, ...central, end], 'archive.zip');
}
const many = Array.from({ length: 3000 }, (_, index) => ({
  tweet: {
    id_str: String(1e15 + index),
    full_text: `post number ${index} `.repeat(4),
    created_at: '2020-01-01T00:00:00Z',
  },
}));
const deflated = deflatedZip({ 'data/account.js': ytd('account', account), 'data/tweets.js': ytd('tweets', many) });
assert.ok(deflated.size < JSON.stringify(many).length / 5, 'the fixture really is compressed');
const big = await readXArchive(deflated);
assert.equal(big.tweets.length, 3000);
assert.equal(big.tweets[2999].text, 'post number 2999 '.repeat(4));

// A single extracted tweets.js works too; junk is rejected with a helpful message.
const single = await readXArchive(new File([ytd('tweets', tweets)], 'tweets.js'));
assert.equal(single.tweets.length, 2);
const noData = new File([await buildStoredZip({ 'readme.txt': 'hi' }).arrayBuffer()], 'other.zip');
await assert.rejects(readXArchive(noData), /No tweets\.js, like\.js or bookmark\.js/);
await assert.rejects(listZip(new Blob(['not a zip at all'])), /Not a ZIP file/);
const truncated = new File([(await stored.arrayBuffer()).slice(0, stored.size - 400)], 'cut.zip');
await assert.rejects(readXArchive(truncated), /ZIP/);

console.log('x archive import tests passed');
