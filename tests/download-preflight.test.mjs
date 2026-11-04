import assert from 'node:assert/strict';
import { chooseBrowserDownload, browserDownloadQuery } from '../download-preflight.mjs';
const row = {
    item: { url: 'https://pbs.twimg.com/media/asset?format=jpg&name=orig' },
    target: { filename: 'XVault/post.jpg' },
    requestedIntent: 'new',
  },
  file = {
    id: 10,
    url: 'https://pbs.twimg.com/media/asset.jpg',
    filename: '/Downloads/XVault/post.jpg',
    state: 'complete',
    byExtensionId: 'self',
  };
assert.equal(chooseBrowserDownload(row, [file], 'self').action, 'reuse');
assert.equal(
  chooseBrowserDownload(row, [{ ...file, exists: false }], 'self').action,
  'reuse',
  'cached existence false is not permission to refetch'
);
assert.equal(chooseBrowserDownload(row, [{ ...file, byExtensionId: 'other' }], 'self').code, 'foreign-download');
assert.equal(
  chooseBrowserDownload(
    { ...row, requestedIntent: 'explicit-redownload', target: { filename: 'XVault/post-copy.jpg' } },
    [file],
    'self'
  ).action,
  'start'
);
assert.equal(
  chooseBrowserDownload({ ...row, verifyRetried: true, retiredDownloadIds: [10] }, [file], 'self').action,
  'start',
  'confirmed failed generation may retry while retaining evidence'
);
assert.equal(
  chooseBrowserDownload(
    { ...row, verifyRetried: true, retiredDownloadIds: [10] },
    [{ ...file, state: 'in_progress' }],
    'self'
  ).action,
  'reuse',
  'a live prior attempt never starts another fetch'
);
assert.equal(
  chooseBrowserDownload(row, [{ ...file, url: 'https://pbs.twimg.com/media/unrelated.jpg' }], 'self').code,
  'target-collision'
);
assert.ok(new RegExp(browserDownloadQuery(row.item).urlRegex).test(file.url));
console.log(
  'Download preflight: retained presence, foreign ownership, collisions, intentional copies, and active retries passed'
);
