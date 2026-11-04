import test from 'node:test';
import assert from 'node:assert/strict';
import { assetIdentity, mediaIdentity, decideEnqueue } from '../download-identity.mjs';

test('URL spellings of one image share an identity', () => {
  const a = assetIdentity('https://pbs.twimg.com/media/ABC.jpg').asset;
  assert.equal(assetIdentity('https://pbs.twimg.com/media/ABC.jpg:orig').asset, a);
  assert.equal(assetIdentity('https://pbs.twimg.com/media/ABC?format=jpg&name=small').asset, a);
});

test('video bitrates collapse to one asset; posts stay distinct', () => {
  const lo = 'https://video.twimg.com/ext_tw_video/77/pu/vid/avc1/640x360/x.mp4?tag=12';
  const hi = 'https://video.twimg.com/ext_tw_video/77/pu/vid/avc1/1280x720/y.mp4?tag=12';
  assert.equal(assetIdentity(lo).asset, assetIdentity(hi).asset);
  assert.notEqual(mediaIdentity({ tweetId: '1', url: lo }), mediaIdentity({ tweetId: '2', url: lo }));
});

test('decideEnqueue policies', () => {
  const base = { key: 'k', seenInRequest: false, existing: null, force: false, skipCompletedDuplicates: true };
  assert.equal(decideEnqueue(base).accept, true);
  assert.equal(decideEnqueue({ ...base, seenInRequest: true }).code, 'same-request');
  assert.equal(decideEnqueue({ ...base, existing: { key: 'k', state: 'downloading' } }).code, 'in-flight');
  assert.equal(decideEnqueue({ ...base, existing: { key: 'k', state: 'complete' } }).code, 'already-downloaded');
  assert.equal(
    decideEnqueue({ ...base, force: true, existing: { key: 'k', state: 'complete' } }).code,
    'explicit-redownload'
  );
  assert.equal(
    decideEnqueue({ ...base, skipCompletedDuplicates: false, existing: { key: 'k', state: 'complete' } }).code,
    'keep-both'
  );
});
