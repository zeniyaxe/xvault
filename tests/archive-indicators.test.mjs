import assert from 'node:assert/strict';
import { buildArchiveIndicators } from '../archive-indicators.mjs';

const posts = [
  { id: '1', media: [] },
  { id: '2', userMeta: { note: 'private' }, media: [{ id: 'a', url: 'asset-a' }, { id: 'b', url: 'asset-b' }] },
  { id: '3', media: [{ id: 'c', url: 'asset-c' }] },
  { id: '4', media: [{ id: 'd', url: 'asset-d' }] },
  { id: '5', media: [{ id: 'e', url: 'asset-e' }] },
];
const history = [
  { item: { tweetId: '2', mediaId: 'a', url: 'asset-a' }, state: 'complete' },
  { item: { tweetId: '2', mediaId: 'b', url: 'asset-b' }, state: 'failed' },
  { item: { tweetId: '3', mediaId: 'c', url: 'asset-c' }, state: 'downloading' },
  { item: { tweetId: '4', mediaId: 'd', url: 'asset-d' }, state: 'failed' },
  { item: { tweetId: '5', mediaId: 'e', url: 'asset-e' }, state: 'complete', verification: { state: 'corrupt' } },
];
const statuses = buildArchiveIndicators(['1', '2', '3', '4', '5', '6'], posts, history);
assert.deepEqual(statuses.map(row => row.status), ['archived', 'partial', 'downloading', 'failed', 'missing', 'not-archived']);
assert.deepEqual(Object.keys(statuses[1]).sort(), ['id', 'status'], 'receipt projection exposes no notes, tags, filenames, or source URLs');
assert.equal(buildArchiveIndicators(['2'], posts, history, { truncated: true })[0].status, 'unknown', 'bounded-history truncation never claims complete state');
assert.equal(buildArchiveIndicators(Array.from({ length: 60 }, (_, i) => String(i)), posts, history).length, 50, 'projection has a hard batch cap');
console.log('Archive receipts: bounded, status-only projection and incomplete-history safety passed');

assert.equal(buildArchiveIndicators(['3'],posts,[{item:{tweetId:'3',mediaId:'c'},state:'complete',association:{kind:'shared',ownerPostId:'1'}}])[0].status,'shared');
