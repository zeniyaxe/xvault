import assert from 'node:assert/strict';
import metadata from '../media-metadata.js';

const original = {
  id: 'media-1',
  type: 'video',
  url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/1280x720/a.mp4?tag=12&sig=old',
  width: 1280,
  height: 720,
  codec: 'h264',
  container: 'mp4',
  provenance: [{ source: 'capture', capturedAt: 10 }],
};
const key = metadata.mediaKey('123456789', original, 0);
assert.equal(
  key,
  metadata.mediaKey(
    '123456789',
    { ...original, url: 'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/1280x720/a.mp4?tag=99&sig=new' },
    0
  ),
  'signed video URLs must resolve to the same archived media'
);
assert.notEqual(key, metadata.mediaKey('123456789', { ...original, id: 'media-2' }, 0));
assert.equal(metadata.formatTimestamp(0), '0:00.000');
assert.equal(metadata.formatTimestamp(3_723_004), '1:02:03.004');

const post = {
  id: '123456789',
  url: 'https://x.com/author/status/123456789',
  text: 'A frame worth keeping',
  author: { handle: 'author', name: 'Archive Artist' },
  createdAt: '2026-10-05T12:00:00.000Z',
  archivedAt: 100,
  media: [
    {
      ...original,
      xvault: {
        mediaKey: key,
        note: 'Warm light',
        tags: ['reference'],
        source: 'Original creator',
        sourceUrl: 'https://example.test/source',
        annotations: [{ id: 'a1', atMs: 4_250, position: 0, text: 'Door opens', createdAt: 20, updatedAt: 20 }],
        derivatives: [{ id: 'd1', format: 'webp', fileName: 'clip.webp', size: 4000 }],
      },
    },
  ],
  userMeta: { note: 'post note', tags: ['archive'] },
  provenance: [{ source: 'bookmarks', capturedAt: 90 }],
};
const sidecar = metadata.buildMediaSidecar(
  post,
  [
    {
      key: 'dl-1',
      state: 'complete',
      totalBytes: 9000,
      filename: 'clip.mp4',
      item: { tweetId: post.id, mediaId: original.id },
      convertedGifPath: 'C:\\private\\XVault\\GIFs\\clip.gif',
      convertedGifSize: 1000,
      conversionState: 'completed',
    },
  ],
  200
);
assert.equal(sidecar.format, 'xvault-media-sidecar');
assert.equal(sidecar.version, 1);
assert.equal(sidecar.media[0].key, key);
assert.equal(sidecar.post.media[0].codec, 'h264', 'portable post snapshots should retain known video codec evidence');
assert.equal(
  sidecar.media[0].original.container,
  'mp4',
  'portable media identity should retain known container evidence'
);
assert.equal(sidecar.media[0].metadata.annotations[0].atMs, 4250);
assert.equal(sidecar.media[0].metadata.derivatives[1].format, 'gif');
assert.equal(
  JSON.stringify(sidecar).includes('C:\\private'),
  false,
  'portable sidecars must never expose local filesystem paths'
);
assert.equal(
  JSON.stringify(sidecar).includes('clip.gif'),
  true,
  'portable sidecars should retain safe derivative filenames'
);
assert.equal(
  JSON.stringify(sidecar).includes('sig=old'),
  false,
  'signed CDN credentials must not escape in portable metadata'
);
assert.equal(
  JSON.stringify(sidecar).includes('tag=12'),
  false,
  'expiring CDN query parameters are not portable media identity'
);
const removedSidecar = metadata.buildMediaSidecar(
  post,
  [
    {
      key: 'dl-2',
      state: 'complete',
      item: { tweetId: post.id, mediaId: original.id, url: original.url },
      convertedGifPath: 'XVault/GIFs/GIF/clip.gif',
      convertedGifSize: 1000,
      conversionState: 'completed',
      conversionVerification: { outputs: [{ label: 'gif', state: 'removed', size: 1000 }] },
    },
  ],
  201
);
assert.equal(
  removedSidecar.media[0].metadata.derivatives.find(value => value.format === 'gif').state,
  'removed',
  'portable metadata must preserve a derivative removal event instead of claiming a local file still exists'
);
assert.equal(
  removedSidecar.media[0].metadata.derivatives.find(value => value.format === 'gif').sourceLocator,
  'video.twimg.com/ext_tw_video/123/pu/vid/avc1/1280x720/a.mp4',
  'derivative evidence must identify its source without signed URL parameters'
);

let downloadPostIdReads = 0;
const bulkMedia = Array.from({ length: 32 }, (_, index) => ({
  id: `asset-${index}`,
  type: 'video',
  url: `https://video.twimg.com/archive/${index}.mp4`,
}));
const bulkDownloads = Array.from({ length: 8000 }, (_, index) => {
  const mediaIndex = index % bulkMedia.length;
  const item = new Proxy(
    { tweetId: post.id, mediaId: bulkMedia[mediaIndex].id, url: bulkMedia[mediaIndex].url },
    {
      get(target, property, receiver) {
        if (property === 'tweetId') downloadPostIdReads++;
        return Reflect.get(target, property, receiver);
      },
    }
  );
  return { state: 'complete', totalBytes: 1000, item, target: { filename: `asset-${mediaIndex}.mp4` } };
});
const bulkSidecar = metadata.buildMediaSidecar({ ...post, media: bulkMedia }, bulkDownloads, 202);
assert.ok(
  downloadPostIdReads < bulkDownloads.length * 4,
  `sidecar association should index download history once instead of rescanning it per media item; read post IDs ${downloadPostIdReads} times`
);
assert.equal(bulkSidecar.media.length, 32);
assert.equal(
  bulkSidecar.media[0].originals.length,
  250,
  'the single-pass association must retain all original download evidence for each media item'
);

const current = structuredClone(post);
current.userMeta.note = 'Newer post-level note';
current.userMeta.tags.push('local');
current.media[0].xvault.note = 'Newer local note';
current.media[0].container = '';
current.media[0].xvault.annotations[0].text = 'Newer local annotation';
current.media[0].xvault.annotations[0].updatedAt = 300;
const conflicting = structuredClone(sidecar);
conflicting.media[0].metadata.note = 'Older imported note';
conflicting.media[0].metadata.annotations[0].text = 'Older imported annotation';
conflicting.media[0].metadata.annotations[0].updatedAt = 150;
conflicting.media[0].original.codec = 'hevc';
conflicting.media[0].metadata.annotations.push({
  id: 'a2',
  atMs: 4_250,
  position: 1,
  text: 'Second note at the same timestamp',
  createdAt: 151,
  updatedAt: 151,
});
conflicting.media[0].metadata.tags.push('sidecar');
conflicting.media[0].metadata.derivatives.push({ id: 'd2', format: 'gif', fileName: 'clip.gif', size: 1000 });
const preview = metadata.planSidecarImport(current, conflicting);
assert.equal(preview.action, 'merge');
assert.equal(
  preview.conflicts.length,
  4,
  'divergent post notes, media notes, annotations, and technical metadata require conflict evidence'
);
assert.ok(preview.safeChanges >= 3, 'independent tags, new annotations, and derivative evidence remain importable');
const merged = metadata.applySidecarImport(current, conflicting, 400);
assert.equal(merged.row.media[0].xvault.note, 'Newer local note');
assert.equal(merged.row.media[0].xvault.annotations[0].text, 'Newer local annotation');
assert.equal(
  merged.row.media[0].xvault.annotations.length,
  2,
  'a new annotation at a duplicate timestamp must be retained'
);
assert.equal(merged.row.media[0].codec, 'h264', 'a technical metadata conflict must keep the local value');
assert.equal(merged.row.media[0].container, 'mp4', 'missing technical metadata can be filled from a sidecar safely');
assert.deepEqual(merged.row.media[0].xvault.tags, ['reference', 'sidecar']);
assert.equal(
  merged.row.media[0].xvault.importConflicts.length,
  3,
  'technical metadata conflicts must remain attached to their media item'
);
assert.equal(merged.row.userMeta.note, 'Newer post-level note', 'post note conflicts keep the local value');
assert.deepEqual(
  merged.row.userMeta.tags,
  ['archive', 'local'],
  'post tags remain local unless they are safely additive'
);
assert.equal(
  merged.row.userMeta.mediaSidecarConflicts.length,
  1,
  'post-level conflicts must retain both values as evidence'
);
assert.equal(merged.row.userMeta.mediaSidecarImports.length, 1);
assert.equal(metadata.planSidecarImport(merged.row, conflicting).action, 'already-imported');

assert.equal(
  metadata.derivativeSourceState(
    original,
    'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/1280x720/a.mp4?tag=99&sig=new'
  ),
  'current',
  'rotating signed source URLs do not make derivatives stale'
);
assert.equal(
  metadata.derivativeSourceState(
    original,
    'https://video.twimg.com/ext_tw_video/123/pu/vid/avc1/1280x720/replaced.mp4'
  ),
  'stale',
  'a changed source locator must surface as a stale derivative'
);
assert.equal(
  metadata.derivativeSourceState(original, ''),
  'unknown',
  'missing source evidence must never be presented as current'
);

const restored = metadata.applySidecarImport(null, sidecar, 500);
assert.equal(restored.action, 'reconstructed');
assert.equal(restored.row.id, post.id);
assert.equal(restored.row.media[0].xvault.note, 'Warm light');
assert.equal(restored.row.media[0].codec, 'h264', 'recovery snapshots should preserve captured technical metadata');
assert.equal(restored.row.userMeta.note, 'post note');
assert.ok(restored.row.archiveSources.includes('xvault-sidecar'));
assert.equal(
  metadata.planSidecarImport(null, sidecar, true).action,
  'trashed',
  'sidecars may not resurrect a post already present in Trash'
);

for (const invalid of [
  { ...sidecar, version: 2 },
  { ...sidecar, post: { ...sidecar.post, id: '' } },
  { ...sidecar, post: { ...sidecar.post, url: 'javascript:alert(1)' } },
  {
    ...sidecar,
    media: [{ ...sidecar.media[0], original: { ...sidecar.media[0].original, url: 'javascript:alert(1)' } }],
  },
  { ...sidecar, media: [sidecar.media[0], sidecar.media[0]] },
  { ...sidecar, media: [{ ...sidecar.media[0], original: { ...sidecar.media[0].original, codec: 'h'.repeat(121) } }] },
])
  assert.throws(() => metadata.validateSidecar(invalid), /sidecar|media|post|version/i);

console.log(
  `PASS per-media identity, exact timestamps, portable derivative metadata, conflict-aware sidecar merge, and reconstruction invariants · ${bulkDownloads.length} download rows associated with ${downloadPostIdReads} post-ID checks`
);

const actualFileSidecar = globalThis.XVaultMediaMetadata.buildMediaSidecar(
  { id: '77', media: [{ id: 'file', type: 'photo', url: 'https://pbs.twimg.com/media/file.jpg' }] },
  [
    {
      state: 'complete',
      item: { tweetId: '77', mediaId: 'file', url: 'https://pbs.twimg.com/media/file.jpg' },
      filename: 'C:/Downloads/actual.jpg',
      target: { filename: 'planned.jpg' },
    },
  ]
);
assert.equal(
  actualFileSidecar.media[0].originals[0].fileName,
  'actual.jpg',
  'portable evidence must name the actual Chrome file, not the originally requested filename'
);
