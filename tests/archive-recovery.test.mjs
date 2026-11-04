import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecoveryHeader, encodeRecoveryLine, scanRecoveryArchive } from '../archive-recovery.mjs';

function fixture(records, overrides = {}) {
  const header = createRecoveryHeader({
    archiveId: 'backup-2026-10-06-a',
    archiveRevision: 7,
    exportedAt: '2026-10-06T00:00:00.000Z',
  });
  const lines = [
    encodeRecoveryLine({ ...header, ...overrides.header }),
    ...records.map(record => encodeRecoveryLine({ type: 'record', ...record })),
    encodeRecoveryLine({
      type: 'end',
      recordCount: records.length,
      archiveRevision: 7,
      downloadRevision: 0,
      ...overrides.end,
    }),
  ];
  return new Blob(lines, { type: 'application/x-ndjson' });
}

test('streams a portable recovery archive in deterministic store/key order', async () => {
  const records = [
    { store: 'tweets', key: '100', value: { id: '100', text: 'one' } },
    { store: 'tweets', key: '200', value: { id: '200', text: 'two' } },
    { store: 'trash', key: '300', value: { id: '300', text: 'retained' } },
    { store: 'revisions', key: 'tweet:100:1', value: { key: 'tweet:100:1', tweetId: '100' } },
    {
      store: 'assets',
      key: 'download-a',
      value: {
        id: 'download-a',
        postId: '100',
        mediaId: 'video-1',
        filename: 'one.mp4',
        size: 1024,
        mime: 'video/mp4',
        sha256: 'a'.repeat(64),
      },
    },
  ];
  const seen = [];
  const result = await scanRecoveryArchive(fixture(records), async record => seen.push(record.key));
  assert.deepEqual(
    seen,
    records.map(record => record.key)
  );
  assert.equal(result.header.format, 'xvault-recovery-jsonl');
  assert.equal(result.footer.recordCount, records.length);
  assert.match(result.fingerprint, /^xvr1-[0-9a-f]{16}$/);
  assert.deepEqual(result.header.stores, ['tweets', 'trash', 'revisions', 'assets']);
});

test('rejects malformed archive identities before they reach durable recovery keys', () => {
  assert.throws(() => createRecoveryHeader({ archiveId: 'bad\uD800identity' }), /unsupported characters/i);
});

test('rejects duplicate and out-of-order keys before a recovery batch can commit', async () => {
  for (const keys of [
    ['100', '100'],
    ['200', '100'],
  ]) {
    const records = keys.map(key => ({ store: 'tweets', key, value: { id: key } }));
    await assert.rejects(
      scanRecoveryArchive(fixture(records), async () => {}),
      /strictly increasing/i
    );
  }
});

test('rejects truncated files, altered counts, unsupported stores and mismatched primary keys', async () => {
  const good = fixture([{ store: 'tweets', key: '100', value: { id: '100' } }]);
  await assert.rejects(
    scanRecoveryArchive(
      new Blob([await good.text().then(text => text.split('\n').slice(0, 2).join('\n'))]),
      async () => {}
    ),
    /end record|truncated/i
  );
  await assert.rejects(
    scanRecoveryArchive(fixture([], { end: { recordCount: 8 } }), async () => {}),
    /record count/i
  );
  await assert.rejects(
    scanRecoveryArchive(fixture([{ store: 'downloads', key: 'd1', value: { key: 'd1' } }]), async () => {}),
    /unsupported store/i
  );
  await assert.rejects(
    scanRecoveryArchive(fixture([{ store: 'tweets', key: '100', value: { id: '200' } }]), async () => {}),
    /primary key/i
  );
});

test('aborts promptly and enforces a bounded single-record line size', async () => {
  const controller = new AbortController();
  await assert.rejects(
    scanRecoveryArchive(
      fixture([{ store: 'tweets', key: '100', value: { id: '100' } }]),
      async () => controller.abort(),
      { signal: controller.signal }
    ),
    /abort/i
  );
  const huge = fixture([{ store: 'tweets', key: '100', value: { id: '100', text: 'x'.repeat(2048) } }]);
  await assert.rejects(
    scanRecoveryArchive(huge, async () => {}, { maxLineBytes: 512 }),
    /exceeds/i
  );
});
