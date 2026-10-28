// Shared reliability vocabulary used by the service worker and deterministic tests.
export const verificationStates = Object.freeze([
  'verified',
  'verified-with-warning',
  'mismatch',
  'corrupt',
  'missing',
  'verification-unavailable'
]);

export const queueStates = Object.freeze([
  'queued',
  'retry-wait',
  'downloading',
  'paused',
  'verifying',
  'converting',
  'complete',
  'failed',
  'cancelled'
]);

export const archiveStates = Object.freeze(['capturing', 'running', 'finalizing', 'settling', 'complete', 'error']);
const archiveTransitions = Object.freeze({ capturing: ['running', 'finalizing', 'settling', 'error'], running: ['finalizing', 'settling', 'error'], finalizing: ['settling', 'complete', 'error'], settling: ['settling', 'complete', 'error'], complete: [], error: [] });
export function canTransitionArchive(from, to) { return from === to || !!archiveTransitions[from]?.includes(to); }

const transitions = Object.freeze({
  queued: ['downloading', 'retry-wait', 'paused', 'cancelled', 'failed'],
  'retry-wait': ['queued', 'paused', 'cancelled', 'failed'],
  downloading: ['verifying', 'retry-wait', 'paused', 'complete', 'failed', 'cancelled'],
  paused: ['queued', 'retry-wait', 'downloading', 'verifying', 'cancelled', 'failed'],
  verifying: ['complete', 'converting', 'retry-wait', 'failed'],
  converting: ['complete', 'failed', 'cancelled'],
  complete: ['converting', 'queued'],
  failed: ['queued', 'cancelled'],
  cancelled: ['queued']
});

export function canTransition(from, to) {
  return from === to || !!transitions[from]?.includes(to);
}

// Pure restart reconciliation used by tests and by callers that need to explain recovery.
export function reconcileQueueState(row = {}, { downloadState = 'missing', paused = false, autoRepair = true } = {}) {
  const state = String(row.state || 'queued');
  if (state === 'complete' || state === 'failed' || state === 'cancelled') return { state, action: 'preserve-terminal' };
  if (['downloading', 'paused', 'verifying'].includes(state) && downloadState === 'complete') return { state: 'verifying', action: 'resume-verification' };
  if (state === 'paused' || paused) return { state: 'paused', action: 'preserve-paused' };
  if (state === 'retry-wait') return { state: 'retry-wait', action: 'preserve-retry-timing' };
  if (state === 'downloading' && downloadState === 'in_progress') return { state: 'downloading', action: 'resume-observed-download' };
  if (state === 'verifying' && downloadState === 'complete') return { state: 'verifying', action: 'resume-verification' };
  return autoRepair ? { state: 'queued', action: 'requeue-stale-transient' } : { state: 'failed', action: 'fail-stale-transient' };
}

// Match only one exact browser download after the worker dies between download() and ID persistence.
export function matchRecoveryDownload(row = {}, candidates = []) {
  const source = String(row.item?.url || '');
  const expectedFile = String(row.target?.filename || '').split(/[\\/]/).pop().toLowerCase();
  const started = Number(row.downloadAttemptStartedAt || 0);
  if (!source || !started || !expectedFile) return { state: 'unknown', reason: 'Missing recovery identity' };
  const matches = candidates.filter(item => {
    const name = String(item.filename || '').split(/[\\/]/).pop().replace(/ \(\d+\)(?=\.[^.]+$)/, '').toLowerCase();
    const at = Date.parse(item.startTime || '');
    return item.url === source && name === expectedFile && Number.isFinite(at) && at >= started - 3000;
  });
  return matches.length === 1 ? { state: 'matched', item: matches[0] }
    : matches.length > 1 ? { state: 'ambiguous', reason: 'Several browser downloads match the same attempt' }
    : { state: 'unknown', reason: 'No matching browser download was found' };
}

export function classifyRetryReason(error = '') {
  const e = String(error).toLowerCase();
  if (/429|rate|too many/.test(e)) return 'rate-limit';
  if (/403|forbidden|expired|unauthorized|server_bad_content|server_forbidden/.test(e)) return 'expired-url';
  if (/html\/json error page|wrong content returned|not media/.test(e)) return 'wrong-content';
  if (/404|not found/.test(e)) return 'missing';
  if (/network|failed|timeout|connection|internet/.test(e)) return 'network';
  if (/file|path|disk|filename|access/.test(e)) return 'disk-path';
  return 'unknown';
}

export function expectedKind(target = {}, item = {}) {
  const logical = String(item.logicalType || item.mediaType || item.sourceMediaType || '').toLowerCase();
  if (logical.includes('animated') || logical === 'animation' || logical === 'gif') return 'animation';
  if (logical === 'image' || logical === 'photo' || logical === 'picture') return 'image';
  if (logical === 'video' || logical === 'movie') return 'video';
  if (target.kind) return String(target.kind).toLowerCase();
  if (String(target.ext || '').toLowerCase() === 'gif') return 'animation';
  if (String(target.ext || '').toLowerCase().match(/mp4|webm|mov/)) return 'video';
  if (String(target.ext || '').toLowerCase().match(/jpg|jpeg|png|avif|webp|gif/)) return 'image';
  return 'unknown';
}

export function actualMatchesExpected(expected, actual, ext = '') {
  const a = String(actual || '').toLowerCase(), e = String(expected || '').toLowerCase();
  if (!a || !e || e === 'unknown') return null;
  if (e === 'animation') return a === 'gif' || a === 'webp' || a === 'video' || /mp4|webm/.test(ext);
  if (e === 'image') return a === 'image' || a === 'jpg' || a === 'jpeg' || a === 'png' || a === 'webp' || a === 'avif' || a === 'gif';
  if (e === 'video') return a === 'video' || a === 'mp4' || a === 'webm';
  return a === e;
}

export function classifyVerification({ received = 0, expectedSize = 0, knownContentLength = 0, expected = 'unknown', actual = '', ext = '', expectedExt = '', actualExt = '', fileAccess = null, exists = true } = {}) {
  if (exists === false) return { state: 'missing', reason: 'Chrome reported that the downloaded file is missing.' };
  if (!Number.isFinite(Number(received)) || Number(received) <= 0) return { state: 'corrupt', reason: 'Downloaded file is zero bytes.' };
  if (Number(knownContentLength) > 0 && Number(received) !== Number(knownContentLength)) return { state: 'corrupt', reason: 'Downloaded size does not match the known Content-Length.' };
  if (Number(expectedSize) > 4096 && Number(received) < Math.min(1024, Number(expectedSize) * .01)) return { state: 'corrupt', reason: 'Downloaded file is implausibly smaller than the expected payload.' };
  if (actual === 'html' || actual === 'json') return { state: 'mismatch', reason: 'The response is an HTML/JSON error page, not media.' };
  const normalizeExt = value => String(value || '').toLowerCase().replace(/^\./, '').replace('jpeg', 'jpg');
  const expectedExtension = normalizeExt(expectedExt), actualExtension = normalizeExt(actualExt || ext);
  if (expectedExtension && actualExtension && expectedExtension !== actualExtension && actualExtension !== 'unknown') return { state: 'mismatch', reason: `Detected .${actualExtension} content disagrees with expected .${expectedExtension}.` };
  const match = actualMatchesExpected(expected, actual, ext);
  if (match === false) return { state: 'mismatch', reason: `Detected ${actual || 'unknown'} content does not match expected ${expected}.` };
  if (fileAccess === false || fileAccess === null && !actual) return { state: 'verification-unavailable', reason: 'The browser could not inspect the local file bytes.' };
  if (match === null) return { state: 'verified-with-warning', reason: 'Size and file presence are valid, but the expected media type is unknown.' };
  return { state: 'verified' };
}
