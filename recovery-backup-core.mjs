// The recovery-file writer shared by the Storage page (manual backups) and scheduled automatic backups
// (XVault 22). It reads the archive in revision-checked pages through `request(type, payload)` and writes
// JSONL lines through `write(text)`, so a backup that races an edit is discarded instead of half-written.
import { RECOVERY_STORES, createRecoveryHeader, encodeRecoveryLine } from './archive-recovery.mjs';

export const RECOVERY_PAGE_SIZE = 25;

export async function writeRecoveryBackup({ request, write, signal, pageSize = RECOVERY_PAGE_SIZE, onProgress }) {
  let recordCount = 0,
    archiveRevision = null,
    downloadRevision = null;
  const check = () => {
    if (signal?.aborted) throw signal.reason || new DOMException('Recovery export stopped', 'AbortError');
  };
  for (const store of RECOVERY_STORES) {
    let afterKey = null,
      hasMore = true;
    while (hasMore) {
      check();
      const expected = archiveRevision == null ? null : { archiveRevision, downloadRevision };
      const page = await request('READ_RECOVERY_BACKUP_PAGE', {
        store,
        afterKey,
        limit: pageSize,
        expectedRevision: expected,
      });
      if (!page || page.ok === false) throw new Error(page?.error || 'XVault could not read an archive backup page');
      if (page.stale)
        throw new Error('The archive changed during backup. The partial file was discarded; run the backup again.');
      if (archiveRevision == null) {
        archiveRevision = page.revision;
        downloadRevision = page.downloadRevision;
        await write(encodeRecoveryLine(createRecoveryHeader({ archiveRevision, downloadRevision })));
      }
      for (const value of page.rows || []) {
        check();
        const key = store === 'revisions' ? value.key : value.id;
        await write(encodeRecoveryLine({ type: 'record', store, key: String(key), value }));
        recordCount++;
      }
      afterKey = page.nextKey;
      hasMore = !!page.hasMore;
      onProgress?.({ store, recordCount });
    }
  }
  if (archiveRevision == null) throw new Error('XVault could not read an archive backup page');
  const verified = await request('READ_RECOVERY_BACKUP_PAGE', {
    store: 'tweets',
    limit: 1,
    expectedRevision: { archiveRevision, downloadRevision },
  });
  if (verified?.stale)
    throw new Error(
      'The archive changed while the backup was being written. The partial file was discarded; run the backup again.'
    );
  await write(encodeRecoveryLine({ type: 'end', recordCount, archiveRevision, downloadRevision }));
  return { recordCount, archiveRevision, downloadRevision };
}
