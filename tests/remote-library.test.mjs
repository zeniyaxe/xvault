import assert from 'node:assert/strict';
import {
  scanRemotePage,
  decodeRemoteCursor,
  createRemotePlanner,
  pageRemotePlan,
  remotePlanIsCurrent,
  encodeRemotePageCursor,
  decodeRemotePageCursor,
} from '../remote-library.mjs';

const posts = [
  {
    id: '100',
    text: 'First archived post',
    archivedAt: 10,
    author: { handle: 'ada', name: 'Ada' },
    metrics: { likes: 2 },
    media: [{ id: 'a', type: 'photo', url: 'https://pbs.twimg.com/private.jpg' }],
  },
  { id: '101', text: 'A second post', archivedAt: 30, author: { handle: 'bo' }, metrics: { likes: 8 }, media: [] },
  { id: '102', text: 'Third post', archivedAt: 20, author: { handle: 'ada' }, metrics: { likes: 5 }, media: [] },
];

const newest = scanRemotePage(posts, { sort: 'new', limit: 2 });
assert.deepEqual(
  newest.rows.map(row => row.id),
  ['101', '102']
);
assert.equal(newest.matched, 3);
assert.ok(newest.nextCursor);
const second = scanRemotePage(posts, { sort: 'new', limit: 2, cursor: newest.nextCursor });
assert.deepEqual(
  second.rows.map(row => row.id),
  ['100']
);
assert.equal(second.nextCursor, null);

const oldest = scanRemotePage(posts, { sort: 'old', limit: 2 });
assert.deepEqual(
  oldest.rows.map(row => row.id),
  ['100', '102']
);
const liked = scanRemotePage(posts, { query: 'from:ada likes:>3', sort: 'likes', limit: 5 });
assert.deepEqual(
  liked.rows.map(row => row.id),
  ['102']
);
assert.equal(liked.matched, 1);
const dated = [{ ...posts[0], createdAt: '2026-09-02T12:00:00Z', archivedAt: Date.UTC(2026, 9, 1) }];
assert.equal(scanRemotePage(dated, { query: 'after:2026-09-01 before:2026-09-03 untagged:true' }).matched, 1);
assert.equal(
  scanRemotePage(dated, { query: 'size:>100mb', knownBytesById: new Map([['100', 150 * 1024 * 1024]]) }).matched,
  1
);
assert.equal(
  scanRemotePage([{ ...dated[0], userMeta: { note: 'Lighting reference' } }], { query: 'note:lighting' }).matched,
  1
);
assert.equal(
  scanRemotePage([{ ...dated[0], userMeta: { note: 'Lighting reference' } }], { query: 'note:portrait' }).matched,
  0
);
assert.equal(
  scanRemotePage(
    [
      {
        ...dated[0],
        media: [{ type: 'video', xvault: { annotations: [{ id: 'a', atMs: 4000, text: 'Doorway detail' }] } }],
      },
    ],
    { query: 'annotation:doorway' }
  ).matched,
  1
);
const inboxPost = { id: '104', text: 'New inbox reference', archivedAt: 20, author: { handle: 'ada' }, userMeta: {} };
assert.equal(
  scanRemotePage([inboxPost], { query: 'inbox:true', inboxSince: 10 }).matched,
  1,
  'Remote query projections must honor the archive Inbox boundary'
);
const inboxPlanner = createRemotePlanner({ query: 'inbox:true', sort: 'likes', inboxSince: 10 });
inboxPlanner.visit(inboxPost);
assert.equal(inboxPlanner.finish().matched, 1, 'ranked Remote plans must honor the same Inbox boundary');
const downloadedPlanner = createRemotePlanner({ query: 'downloaded:true', sort: 'likes' });
downloadedPlanner.visit(
  { ...inboxPost, metrics: { likes: 2 } },
  { downloaded: true, missing: false, knownBytes: 1234 }
);
assert.equal(
  downloadedPlanner.finish().matched,
  1,
  'ranked Remote scans must accept bounded per-post download summaries'
);
const sizePlanner = createRemotePlanner({ query: 'size:>1kb', sort: 'likes' });
sizePlanner.visit({ ...inboxPost, metrics: { likes: 2 } }, { downloaded: false, missing: false, knownBytes: 2048 });
assert.equal(
  sizePlanner.finish().matched,
  1,
  'ranked Remote scans must apply size filters from the current post summary'
);

const malformed = scanRemotePage(
  [
    null,
    { id: '../bad', text: 'Never export an invalid identity', media: [{ url: 'https://example.test/private' }] },
    {
      id: '103',
      text: 'A real identity',
      author: { handle: 'ada' },
      media: [{ id: 'm', type: 'video', url: 'https://pbs.twimg.com/original.mp4' }],
    },
  ],
  { limit: 10 }
);
assert.deepEqual(
  malformed.rows.map(row => row.id),
  ['103']
);
assert.equal(
  JSON.stringify(malformed.rows).includes('pbs.twimg.com'),
  false,
  'phone projections must omit source URLs'
);
assert.equal(JSON.stringify(malformed.rows).includes('original.mp4'), false, 'phone projections must omit media URLs');

assert.throws(() => decodeRemoteCursor('not-a-cursor', 'new', ''), /cursor/i);
assert.throws(() => scanRemotePage(posts, { cursor: newest.nextCursor, query: 'different query' }), /cursor/i);

const synthetic = Array.from({ length: 50_000 }, (_, index) => ({
  id: String(1_000_000 + index),
  text: `synthetic ${index}`,
  archivedAt: index,
  author: { handle: `author${index % 100}` },
  metrics: { likes: index % 1000 },
  media: [
    {
      id: `media${index}`,
      type: 'photo',
      url: `https://pbs.twimg.com/${index}.jpg`,
      variants: [{ url: 'large object should not escape' }],
    },
  ],
}));
const large = scanRemotePage(synthetic, { query: 'synthetic', sort: 'new', limit: 48 });
assert.equal(large.matched, 50_000);
assert.equal(large.rows.length, 48);
assert.equal(large.rows[0].id, '1049999');
assert.ok(large.nextCursor);
assert.equal(Object.hasOwn(large.rows[0], 'media'), false, 'query result retains no media objects');
const planner = createRemotePlanner({ query: 'synthetic', sort: 'new' });
for (const post of synthetic) planner.visit(post);
const plan = planner.finish();
assert.equal(plan.rows.length, 5_000, 'ranked Remote plans must retain only a bounded top-N set');
assert.equal(plan.matched, 50_000, 'ranking may still report the exact scan match count');
assert.equal(plan.truncated, true, 'a bounded ranking plan must identify results beyond its retained window');
assert.equal(Object.hasOwn(plan.rows[0], 'text'), false, 'server query cache retains no post text');
assert.equal(Object.hasOwn(plan.rows[0], 'media'), false, 'server query cache retains no media records');
assert.deepEqual(
  pageRemotePlan(plan, 0, 2).rows.map(row => row.id),
  ['1049999', '1049998']
);
assert.deepEqual(
  pageRemotePlan(plan, 4_998, 2).rows.map(row => row.id),
  ['1045001', '1045000']
);
assert.equal(pageRemotePlan(plan, 4_998, 2).hasMore, false);
assert.equal(pageRemotePlan(plan, 4_998, 2).truncated, true);
const remoteCursorSecret = crypto.getRandomValues(new Uint8Array(32));
const revisionBoundary = { key: 30, id: '101', phase: 'indexed', sort: 'new', revision: 12, downloadRevision: 4 };
const signedCursor = await encodeRemotePageCursor(
  '12345678-1234-4234-8234-123456789abc',
  revisionBoundary,
  7,
  2500,
  remoteCursorSecret
);
assert.deepEqual(await decodeRemotePageCursor(signedCursor, remoteCursorSecret), {
  id: '12345678-1234-4234-8234-123456789abc',
  after: revisionBoundary,
  matched: 7,
  scanned: 2500,
});
const signatureStart = signedCursor.lastIndexOf('.') + 1;
const changedSignature =
  signedCursor.slice(0, signatureStart) +
  (signedCursor[signatureStart] === 'A' ? 'B' : 'A') +
  signedCursor.slice(signatureStart + 1);
await assert.rejects(
  decodeRemotePageCursor(changedSignature, remoteCursorSecret),
  /invalid or expired/i,
  'changing actual signature bits must be rejected'
);
await assert.rejects(
  decodeRemotePageCursor(
    signedCursor.replace('12345678-1234-4234-8234-123456789abc', '87654321-1234-4234-8234-123456789abc'),
    remoteCursorSecret
  ),
  /invalid or expired/i,
  'the authenticated boundary must be bound to its query-plan ID'
);
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const noncanonicalSignature = signedCursor.slice(0, -1) + alphabet[alphabet.indexOf(signedCursor.at(-1)) ^ 1];
await assert.rejects(
  decodeRemotePageCursor(noncanonicalSignature, remoteCursorSecret),
  /invalid or expired/i,
  'unused base64 pad bits must not create accepted aliases for one cursor'
);
assert.equal(remotePlanIsCurrent({ revision: 12, downloadRevision: null }, 12), true);
assert.equal(
  remotePlanIsCurrent({ revision: 12, downloadRevision: null }, 13),
  false,
  'metadata changes must invalidate a cached gallery plan'
);
assert.equal(remotePlanIsCurrent({ revision: 12, downloadRevision: 4 }, 12, 4), true);
assert.equal(
  remotePlanIsCurrent({ revision: 12, downloadRevision: 4 }, 12, 5),
  false,
  'download filters must invalidate when verified local files change'
);
console.log('remote library: bounded 50k search, stable cursors, filters, and safe projections passed');
