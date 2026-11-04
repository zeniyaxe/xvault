import assert from 'node:assert/strict';
import { planRemoteDownload, remoteMediaVersion } from '../remote-download.mjs';
const build = (post, media, index) => ({ url: media.url, tweetId: post.id, index: index + 1 });
const post = {
  id: '123',
  media: Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    type: 'photo',
    url: `https://pbs.twimg.com/media/${i}.jpg`,
  })),
};
const first = await planRemoteDownload(post, {}, build);
const legacySignature = JSON.stringify(
  post.media.map(item => [
    item.id || '',
    item.type || '',
    item.url || '',
    item.playbackUrl || '',
    ...(item.variants || []).map(variant => variant.url || ''),
  ])
);
assert.equal(
  first.mediaVersion,
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(legacySignature))).toString('hex'),
  'bounded signatures preserve existing viewer cursor compatibility'
);
assert.equal(first.items.length, 32);
assert.equal(first.nextOffset, 32);
const next = await planRemoteDownload(post, { offset: 32, mediaVersion: first.mediaVersion }, build);
assert.equal(next.items[0].index, 33);
post.media[32].url = 'https://pbs.twimg.com/media/changed.jpg';
assert.equal((await planRemoteDownload(post, { offset: 32, mediaVersion: first.mediaVersion }, build)).stale, true);
assert.equal(
  (
    await planRemoteDownload(
      {
        id: '123',
        media: [
          { url: 'http://localhost/private' },
          { url: 'file:///private' },
          { url: 'https://video.twimg.com.evil/file.mp4' },
        ],
      },
      {},
      build
    )
  ).unavailable,
  3
);
const video = await planRemoteDownload(
  {
    id: '123',
    media: [
      {
        type: 'video',
        url: 'https://pbs.twimg.com/media/poster.jpg',
        variants: [
          { contentType: 'video/mp4', bitrate: 1, url: 'https://video.twimg.com/low.mp4' },
          { contentType: 'video/mp4', bitrate: 5, url: 'https://video.twimg.com/high.mp4' },
        ],
      },
    ],
  },
  {},
  build
);
assert.equal(video.items[0].url, 'https://video.twimg.com/high.mp4');
await assert.rejects(planRemoteDownload(post, { limit: 33 }, build), /invalid/);
await assert.rejects(planRemoteDownload(post, { offset: -1 }, build), /invalid/);
await assert.rejects(remoteMediaVersion(Array.from({ length: 10001 }, () => ({}))), /too many/);
await assert.rejects(remoteMediaVersion([{ url: 'x'.repeat(32769) }]), /safety limit/);
const unicodeField = 'é'.repeat(16384);
await assert.rejects(
  remoteMediaVersion(Array.from({ length: 150 }, () => ({ url: unicodeField }))),
  /safety limit/,
  'the signature budget limits UTF-8 bytes before final materialization, not only character count'
);
console.log('Remote download plans: captured-only URLs, bounded ranges, generation validation and best MP4 passed');
