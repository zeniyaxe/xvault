const assert = require('node:assert/strict');
const model = require('../bulk-download-model.js');
assert.equal(model.mediaKind({ url: 'https://example.test/image.avif' }), 'image');
assert.equal(model.isAnimation({ type: 'image', animated: true }), true);
assert.equal(
  model.plan(
    [{ id: 'dated', createdAt: '2026-02-01T12:00:00Z', media: [{ type: 'photo', url: 'https://example.test/p.jpg' }] }],
    new Map(),
    { dateFrom: Date.parse('2026-03-01') }
  ).totals.postsMatched,
  0,
  'ISO posted dates obey bulk date scope'
);

const posts = [
  {
    id: '1',
    author: { handle: 'alice' },
    userMeta: { favorite: true, tags: ['art'] },
    media: [
      { id: 'i1', type: 'photo', size: 1000, url: 'https://pbs.twimg.com/a.jpg' },
      { id: 'g1', type: 'animated_gif', size: 2000, playbackUrl: 'https://video.twimg.com/a.mp4' },
    ],
  },
  {
    id: '2',
    author: { handle: 'bob' },
    media: [{ id: 'v1', type: 'video', size: 4000, playbackUrl: 'https://video.twimg.com/b.mp4' }],
  },
];
assert.equal(model.mediaKind(posts[0].media[1]), 'gif');
assert.deepEqual(model.outputMode('gif-webp'), { keepMp4: false, gif: true, webp: true });
assert.deepEqual(model.outputMode('mp4-gif'), { keepMp4: true, gif: true, webp: false });
assert.equal(model.mediaKind({ type: 'webp', animated: true }), 'gif');
assert.equal(model.isAnimation({ type: 'webp', animated: true }), true);
const all = model.plan(posts, new Map(), { mediaFilter: 'all', animationMode: 'all' });
assert.deepEqual(all.totals, {
  postsScanned: 2,
  postsMatched: 2,
  media: 3,
  images: 1,
  videos: 1,
  animations: 1,
  animatedWebP: 0,
  bytes: 7000,
  knownBytes: 7000,
  alreadyLocal: 0,
  missing: 3,
  failed: 0,
  conversionRequired: 1,
  gifConversions: 1,
  webpConversions: 1,
  selected: 3,
  estimatedBytes: 7000,
  needDownload: 3,
});
const favorite = model.plan(posts, new Map(), { scope: 'favorites', mediaFilter: 'animations', animationMode: 'gif' });
assert.equal(favorite.totals.media, 1);
assert.equal(favorite.totals.gifConversions, 1);
const done = new Map([['1', [{ state: 'complete', verificationState: 'verified' }]]]);
assert.equal(model.plan(posts, done, { scope: 'selected', selectedIds: ['1'], onlyMissing: true }).totals.media, 0);
assert.equal(model.plan(posts, new Map(), { scope: 'tag', tag: 'art', mediaFilter: 'images' }).totals.media, 1);
const existing = model.plan(posts, new Map([['1|i1', [{ state: 'complete', verification: { state: 'verified' } }]]]), {
  existingPolicy: 'skip',
});
assert.equal(existing.totals.alreadyLocal, 1);
assert.equal(existing.totals.needDownload, 2);
assert.equal(existing.items.length, 2);
const failed = model.plan(posts, new Map([['2|v1', [{ state: 'failed', verificationState: 'mismatch' }]]]), {
  onlyFailed: true,
  animationMode: 'mp4',
});
assert.equal(failed.totals.media, 1);
assert.equal(failed.totals.failed, 1);
const selected = model.plan(posts, new Map(), { scope: 'selected', selectedIds: ['2'], mediaFilter: 'videos' });
assert.equal(selected.totals.media, 1);
console.log('bulk download model: scope, type, animation mode, and existing-file planning passed');
