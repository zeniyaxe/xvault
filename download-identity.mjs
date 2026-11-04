// Download identity model — the single authority for "is this the same download?".
//
// Every entry point (X.com buttons, passive capture, Library, bulk, Remote, recovery) reaches the
// queue through enqueue(), which asks this module two questions:
//   1. mediaIdentity(item): which file does this request describe?
//   2. decideEnqueue(...): given what already exists, do we accept or skip, and why?
//
// An identity is `<postId>|<asset>`; an asset is the physical media object on X's CDN, independent of
// the URL spelling that a particular code path happened to produce:
//   pbs.twimg.com/media/ID.jpg      ┐
//   pbs.twimg.com/media/ID.jpg:orig │  all one asset  →  img:ID
//   pbs.twimg.com/media/ID?format=jpg&name=small ┘
//   video.twimg.com/ext_tw_video/<mid>/pu/vid/avc1/1280x720/<hash>.mp4?tag=12  → vid:<mid> (every bitrate)
//   video.twimg.com/tweet_video/<name>.mp4 → gif:<name>
// Signatures, size names, bitrate ladders and file-extension spellings never change an identity.
//
// Deliberately NOT part of identity: mediaId (callers disagree about it), index, author, folder,
// signature, and derivative choices (GIF/WebP copies are scheduled against the source's identity).
// The same asset on a different post (quote/repost) is a different identity: each post keeps its own file.

import './media-asset.js';

export const assetIdentity = url => globalThis.XVaultMediaAsset.assetIdentity(url);

export function mediaIdentity(item = {}) {
  return `${String(item.tweetId || '')}|${assetIdentity(item.url).asset}`;
}

export function isExistingDownload(row) {
  return Boolean(
    row && ['complete', 'queued', 'downloading', 'retry-wait', 'paused', 'verifying', 'converting'].includes(row.state)
  );
}

/**
 * Decide what enqueue() does with one requested item.
 * @param {{ key: string, seenInRequest: boolean, existing: object|null, force: boolean, skipCompletedDuplicates: boolean, sibling?: object|null, crossPostPolicy?: 'keep'|'skip' }} input
 * @returns {{ accept: boolean, code: string, reason: string, matchKey: string|null, matchState: string|null }}
 */
export function decideEnqueue({
  key,
  seenInRequest,
  existing,
  force,
  skipCompletedDuplicates,
  sibling = null,
  crossPostPolicy = 'keep',
}) {
  const matchKey = existing?.key || null,
    matchState = existing?.state || null;
  if (seenInRequest)
    return {
      accept: false,
      code: 'same-request',
      reason: 'The same file appears twice in this request',
      matchKey: key,
      matchState: null,
    };
  if (existing && isExistingDownload(existing) && existing.state !== 'complete') {
    return { accept: false, code: 'in-flight', reason: `Already ${existing.state}`, matchKey, matchState };
  }
  if (existing?.state === 'complete') {
    if (force)
      return {
        accept: true,
        code: 'explicit-redownload',
        reason: 'Explicit redownload of a completed file',
        matchKey,
        matchState,
      };
    if (skipCompletedDuplicates)
      return { accept: false, code: 'already-downloaded', reason: 'Already downloaded', matchKey, matchState };
    return {
      accept: true,
      code: 'keep-both',
      reason: 'Duplicate skipping is off; keeping a second copy',
      matchKey,
      matchState,
    };
  }
  if (existing)
    return {
      accept: true,
      code: 'retry-failed',
      reason: `Previous attempt ${existing.state}; queued again`,
      matchKey,
      matchState,
    };
  if (sibling && crossPostPolicy === 'skip' && !force)
    return {
      accept: false,
      code: 'same-asset-other-post',
      reason: 'This exact file is already saved for another post',
      matchKey: sibling.key,
      matchState: sibling.state,
    };
  return {
    accept: true,
    code: sibling ? 'new-for-post' : 'new',
    reason: sibling ? 'Same file exists for another post; each post keeps its own copy' : 'No matching download',
    matchKey: null,
    matchState: null,
  };
}
