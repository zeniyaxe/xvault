import assert from 'node:assert/strict';
import {
  canTransition,
  canTransitionArchive,
  classifyRetryReason,
  explainDownloadError,
  classifyVerification,
  expectedKind,
  matchRecoveryDownload,
  reconcileQueueState,
  verificationStates,
} from '../reliability.mjs';

const check = (condition, message) => assert.equal(condition, true, message);

// Queue state-machine invariants: stale async callbacks must not move terminal work backwards.
check(canTransition('queued', 'downloading'), 'queued starts');
check(canTransition('downloading', 'verifying'), 'download completion enters verification');
check(canTransition('retry-wait', 'queued'), 'retry alarm releases retry-wait');
check(canTransition('paused', 'downloading'), 'resume is valid');
check(!canTransition('complete', 'downloading'), 'completed work cannot restart from a stale callback');
check(!canTransition('cancelled', 'complete'), 'cancelled work cannot complete from a stale callback');
check(!canTransition('failed', 'verifying'), 'terminal failure cannot enter verification');
assert.deepEqual(reconcileQueueState({ state: 'queued' }, { downloadState: 'none' }), {
  state: 'queued',
  action: 'requeue-stale-transient',
});
assert.deepEqual(reconcileQueueState({ state: 'downloading' }, { downloadState: 'in_progress' }), {
  state: 'downloading',
  action: 'resume-observed-download',
});
assert.deepEqual(reconcileQueueState({ state: 'downloading' }, { downloadState: 'none' }), {
  state: 'queued',
  action: 'requeue-stale-transient',
});
assert.deepEqual(reconcileQueueState({ state: 'paused' }, { downloadState: 'in_progress' }), {
  state: 'paused',
  action: 'preserve-paused',
});
assert.deepEqual(reconcileQueueState({ state: 'retry-wait' }, { downloadState: 'none' }), {
  state: 'retry-wait',
  action: 'preserve-retry-timing',
});
assert.deepEqual(reconcileQueueState({ state: 'complete' }, { downloadState: 'none' }), {
  state: 'complete',
  action: 'preserve-terminal',
});
assert.deepEqual(reconcileQueueState({ state: 'verifying' }, { downloadState: 'complete' }), {
  state: 'verifying',
  action: 'resume-verification',
});
assert.deepEqual(reconcileQueueState({ state: 'paused' }, { downloadState: 'complete' }), {
  state: 'verifying',
  action: 'resume-verification',
});
check(
  canTransition('downloading', 'retry-wait') && canTransition('verifying', 'retry-wait'),
  'stale transients enter recovery before requeue'
);
const attempt = {
  item: { url: 'https://video.twimg.com/sample.mp4' },
  target: { filename: 'XVault/GIFs/sample.mp4' },
  downloadAttemptStartedAt: Date.parse('2026-09-19T10:00:00Z'),
};
const browserItem = {
  id: 7,
  url: attempt.item.url,
  filename: 'C:\\Users\\zeni\\Downloads\\XVault\\GIFs\\sample.mp4',
  startTime: '2026-09-19T10:00:01Z',
};
assert.equal(matchRecoveryDownload(attempt, [browserItem]).item.id, 7);
assert.equal(matchRecoveryDownload(attempt, [browserItem, { ...browserItem, id: 8 }]).state, 'ambiguous');
assert.equal(matchRecoveryDownload(attempt, [{ ...browserItem, url: 'https://wrong.example/media' }]).state, 'unknown');
check(canTransitionArchive('capturing', 'settling'), 'archive enters settling after terminal capture');
check(canTransitionArchive('settling', 'complete'), 'archive settles only after reconciliation');
check(!canTransitionArchive('complete', 'settling'), 'completed archive cannot be reopened by a late callback');
assert.equal(classifyRetryReason('server_bad_content'), 'expired-url');
assert.equal(classifyRetryReason('The response is an HTML/JSON error page, not media.'), 'wrong-content');
assert.equal(classifyRetryReason('404 Not Found'), 'missing');
assert.equal(classifyRetryReason('network timeout'), 'network');
assert.equal(classifyRetryReason('disk access denied'), 'disk-path');

// Expected media type and extension are kept separate so unknown APIs remain explainable.
assert.equal(expectedKind({ ext: 'mp4' }, { mediaType: 'video' }), 'video');
assert.equal(expectedKind({ ext: 'gif' }, { mediaType: 'animated_gif' }), 'animation');
assert.equal(expectedKind({}, { mediaType: 'image' }), 'image');

assert.deepEqual(classifyVerification({ received: 0, expected: 'image' }).state, 'corrupt');
assert.deepEqual(
  classifyVerification({ received: 3000, expected: 'image', actual: 'html', fileAccess: true }).state,
  'mismatch'
);
assert.deepEqual(
  classifyVerification({
    received: 3000,
    expected: 'video',
    actual: 'video',
    expectedExt: 'mp4',
    actualExt: 'html',
    fileAccess: true,
  }).state,
  'mismatch'
);
assert.deepEqual(
  classifyVerification({
    received: 3000,
    expected: 'image',
    actual: 'png',
    expectedExt: 'jpg',
    actualExt: 'png',
    fileAccess: true,
  }).state,
  'mismatch'
);
assert.deepEqual(
  classifyVerification({
    received: 3000,
    expected: 'image',
    actual: 'image',
    expectedExt: 'jpg',
    actualExt: 'jpg',
    fileAccess: true,
  }).state,
  'verified'
);
assert.deepEqual(
  classifyVerification({
    received: 3000,
    knownContentLength: 3200,
    expected: 'image',
    actual: 'image',
    fileAccess: true,
  }).state,
  'corrupt'
);
assert.deepEqual(
  classifyVerification({ received: 3000, expected: 'unknown', fileAccess: null }).state,
  'verification-unavailable'
);
assert.deepEqual(
  classifyVerification({ received: 3000, expected: 'unknown', fileAccess: true }).state,
  'verified-with-warning'
);
assert.deepEqual(
  classifyVerification({ received: 3000, expected: 'image', actual: 'image', fileAccess: false }).state,
  'verification-unavailable'
);
assert.deepEqual(classifyVerification({ received: 3000, expected: 'image', exists: false }).state, 'missing');
assert.deepEqual(verificationStates.length, 6);

console.log('reliability: state, retry, verification, and settling tests passed');

// XVault 26: plain-language download errors.
assert.match(explainDownloadError('FILE_NO_SPACE'), /disk is full/);
assert.match(explainDownloadError('NETWORK_FAILED'), /connection to X’s media server failed/);
assert.match(explainDownloadError('HTTP 429 Too Many Requests'), /limiting downloads/);
assert.match(explainDownloadError('SERVER_FORBIDDEN'), /no longer accepts this media link/);
assert.match(explainDownloadError('HTTP 404'), /no longer exists/);
assert.match(explainDownloadError('FILE_NAME_TOO_LONG'), /too long/);
assert.equal(explainDownloadError(''), '');
assert.equal(explainDownloadError('something odd'), '');
