import assert from 'node:assert/strict';
import { mergeCapturedRecord } from '../library-capture.mjs';

const current = {
  id: 'post-1', text: 'newer saved text', contentObservedAt: 300, profileObservedAt: 280, metricsObservedAt: 290, lastSeenAt: 310,
  author: { handle: 'new-name', name: 'Current profile' }, metrics: { likes: 90, views: 900 },
  media: [{ id: 'media-1', url: 'https://media/newer.jpg', type: 'photo' }],
  userMeta: { note: 'keep this note', favorite: true, tags: ['reference'] }, provenance: [{ source: 'bookmarks', capturedAt: 300 }]
};
const older = {
  id: 'post-1', text: 'stale prepared text', observedAt: 150, contentObservedAt: 150, profileObservedAt: 160, metricsObservedAt: 140,
  author: { handle: 'old-name', name: 'Older profile' }, metrics: { likes: 2, replies: 1 },
  media: [{ id: 'media-1', url: 'https://media/old.jpg', type: 'photo' }], userMeta: { note: 'stale note', favorite: false, tags: ['old'] },
  archiveSource: 'likes'
};

const late = mergeCapturedRecord(current, older, 400);
assert.equal(late.row.text, 'newer saved text', 'a prepared older capture must not replace newer post content');
assert.equal(late.row.author.handle, 'new-name', 'older profile evidence must not overwrite a newer profile');
assert.equal(late.row.metrics.likes, 90, 'older metrics must not overwrite newer metrics');
assert.equal(late.row.media[0].url, 'https://media/newer.jpg', 'older capture must not replace the same media identity');
assert.deepEqual(late.row.userMeta, current.userMeta, 'capture must preserve all current personal metadata');
assert.ok(late.row.provenance.some(item => item.capturedAt === 150), 'older evidence remains in provenance');
assert.equal(late.revision, null, 'stale evidence cannot manufacture a newer content revision');

const newer = mergeCapturedRecord(current, { ...older, text: 'new saved text', observedAt: 450, contentObservedAt: 450, profileObservedAt: 455, metricsObservedAt: 460, author: { handle: 'latest', name: 'Latest profile' }, metrics: { likes: 120 }, media: [{ id: 'media-1', url: 'https://media/latest.jpg', type: 'photo' }] }, 470);
assert.equal(newer.row.text, 'new saved text');
assert.equal(newer.row.author.handle, 'latest');
assert.equal(newer.row.metrics.likes, 120);
assert.equal(newer.row.media[0].url, 'https://media/latest.jpg');
assert.deepEqual(newer.row.userMeta, current.userMeta);
assert.equal(newer.revision.before.text, 'newer saved text');
assert.equal(newer.revision.after.text, 'new saved text');
console.log('capture merge: stale snapshots preserve newer evidence and personal metadata');
