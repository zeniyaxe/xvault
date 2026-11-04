import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createRecoveryHeader, encodeRecoveryLine, scanRecoveryArchive } from '../archive-recovery.mjs';

const require = createRequire(import.meta.url);
const pw = require(process.argv[2] || 'playwright');
const executablePath = process.argv[3] || undefined;
const outputDir = process.argv[4] || path.join(os.tmpdir(), `xvault-recovery-ui-${Date.now()}`);
await fs.mkdir(outputDir, { recursive: true });
const browser = await pw.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [], consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto('http://127.0.0.1:8765/tests/dashboard-harness.html?idb&records=128', { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => !!document.querySelector('iframe')?.contentWindow?.page, { timeout: 10000 });
  const frame = page.frames().find(candidate => candidate.parentFrame());
  assert.ok(frame, 'dashboard harness iframe should be available');
  await frame.locator('#page-integrity').waitFor({ state: 'attached' });
  await frame.evaluate(() => window.page('integrity'));
  await frame.locator('#recoveryExport').waitFor({ state: 'visible' });
  await frame.locator('#recoveryImport').click();

  const header = createRecoveryHeader({ archiveId: 'browser-restore-a', archiveRevision: 0, downloadRevision: 0, exportedAt: '2026-10-06T00:00:00.000Z' });
  const records = [
    { type: 'record', store: 'tweets', key: '900000', value: { id: '900000', text: 'different copy of existing post', archivedAt: 1, media: [], userMeta: { note: 'incoming note' } } },
    ...Array.from({ length: 45 }, (_, index) => ({ type: 'record', store: 'tweets', key: String(910000 + index), value: { id: String(910000 + index), text: `resumable restored post ${index}`, archivedAt: 2 + index, media: [] } })),
    { type: 'record', store: 'tweets', key: '999999', value: { id: '999999', text: 'restored post', archivedAt: 2, media: [], userMeta: { note: 'retained note' } } },
    { type: 'record', store: 'trash', key: '900001', value: { id: '900001', text: 'must remain live', deletedAt: 3, media: [] } },
    { type: 'record', store: 'revisions', key: 'history:900000:1', value: { key: 'history:900000:1', tweetId: '900000', observedAt: 5, text: 'earlier version' } },
    { type: 'record', store: 'assets', key: 'download-from-backup', value: { id: 'download-from-backup', postId: '999999', mediaId: 'video-1', filename: 'recovered.mp4', size: 4096, mime: 'video/mp4', mediaType: 'video', sha256: 'a'.repeat(64), verification: 'verified', completedAt: 6 } }
  ];
  const backup = new Blob([
    encodeRecoveryLine(header),
    ...records.map(encodeRecoveryLine),
    encodeRecoveryLine({ type: 'end', recordCount: records.length, archiveRevision: header.archiveRevision, downloadRevision: header.downloadRevision })
  ], { type: 'application/x-ndjson' });
  await frame.locator('#recoveryFile').setInputFiles({ name: 'recovery.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(await backup.arrayBuffer()) });
  const dialog = frame.locator('#archiveRecoveryDialog');
  await dialog.waitFor({ state: 'visible' });
  await frame.waitForFunction(() => {
    const counts = document.querySelector('#archiveRecoveryCounts');
    const progress = document.querySelector('#archiveRecoveryProgress')?.textContent || '';
    return counts && !counts.hidden || /failed|error|changed|unsupported|exceeds|truncated/i.test(progress);
  }, undefined, { timeout: 10000 }).catch(() => {});
  const previewProgress = await frame.locator('#archiveRecoveryProgress').innerText();
  assert.equal(await frame.locator('#archiveRecoveryCounts').isHidden(), false, `recovery preview failed: ${previewProgress}; status: ${await frame.locator('#recoveryStatus').innerText()}; module errors: ${pageErrors.join(' | ')}`);
  assert.equal(await frame.locator('#recoveryCountNew').innerText(), '48');
  assert.equal(await frame.locator('#recoveryCountConflicts').innerText(), '2');
  assert.equal(await frame.locator('#archiveRecoveryApply').isEnabled(), true);
  assert.equal(await frame.locator('#archiveRecoveryConflictExport').isHidden(), true, 'conflict export must wait until evidence is actually committed');
  assert.equal(await frame.locator('#archiveRecoveryAssetsExport').isHidden(), true, 'file-reference export must wait until recovered references are committed');
  const conflictDetails = frame.locator('#archiveRecoveryConflictSamples');
  assert.equal(await conflictDetails.isVisible(), true);
  await conflictDetails.locator('summary').click();
  assert.equal(await frame.locator('#archiveRecoveryConflictList li').count(), 2);
  await page.screenshot({ path: path.join(outputDir, 'recovery-conflict-preview-390.png') });
  await conflictDetails.locator('summary').click();
  await page.screenshot({ path: path.join(outputDir, 'recovery-preview-390.png') });

  await frame.evaluate(() => {
    const original = chrome.runtime.sendMessage;
    window.__recoveryCommitCount = 0;
    window.__releaseFirstRecoveryCommit = null;
    chrome.runtime.sendMessage = async message => {
      const response = await original(message);
      if (message.type === 'COMMIT_RECOVERY_BATCH') {
        window.__recoveryCommitCount++;
        if (window.__recoveryCommitCount === 1) await new Promise(resolve => { window.__releaseFirstRecoveryCommit = resolve; });
      }
      return response;
    };
  });
  await frame.locator('#archiveRecoveryApply').click();
  await frame.waitForFunction(() => typeof window.__releaseFirstRecoveryCommit === 'function', { timeout: 15000 });
  const interrupted = await frame.evaluate(async () => {
    const open = indexedDB.open(window.__xvMockRealDatabaseName, 1);
    const database = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const read = id => new Promise((resolve, reject) => { const request = database.transaction('tweets').objectStore('tweets').get(id); request.onsuccess = () => resolve(!!request.result); request.onerror = () => reject(request.error); });
    const result = { first: await read('910000'), last: await read('910038'), next: await read('910039') };
    database.close();
    return result;
  });
  assert.deepEqual(interrupted, { first: true, last: true, next: false }, 'completed batches should be durable while the next batch remains untouched');
  await frame.locator('#archiveRecoveryCancel').click();
  await frame.evaluate(() => window.__releaseFirstRecoveryCommit?.());
  await frame.waitForFunction(() => !document.querySelector('#archiveRecoveryDialog')?.open, { timeout: 5000 });
  await frame.locator('#recoveryImport').click();
  await frame.locator('#recoveryFile').setInputFiles({ name: 'recovery.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(await backup.arrayBuffer()) });
  await frame.locator('#archiveRecoveryDialog').waitFor({ state: 'visible' });
  await frame.waitForFunction(() => !document.querySelector('#archiveRecoveryCounts')?.hidden, undefined, { timeout: 15000 });
  assert.match(await frame.locator('#archiveRecoveryApply').innerText(), /Resume/);
  await frame.locator('#archiveRecoveryApply').click();
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('#archiveRecoveryApply')?.textContent.includes('complete'), { timeout: 20000 });
  assert.equal(await frame.locator('#recoveryCountNew').innerText(), '48');
  assert.equal(await frame.locator('#recoveryCountConflicts').innerText(), '2');
  assert.equal(await frame.locator('#recoveryConflictExport').isVisible(), true);

  const verification = await frame.locator('body').evaluate(async body => {
    const databaseName = window.__xvMockRealDatabaseName;
    const open = indexedDB.open(databaseName, 1);
    const database = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
    const read = (store, key) => new Promise((resolve, reject) => {
      const tx = database.transaction(store), request = tx.objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    const existing = await read('tweets', '900000');
    const added = await read('tweets', '999999');
    const wrongTrash = await read('trash', '900001');
    const revision = await read('revisions', 'history:900000:1');
    const manifest = await read('archiveImports', 'asset:browser-restore-a:download-from-backup');
    const imports = await new Promise((resolve, reject) => {
      const tx = database.transaction('archiveImports'), request = tx.objectStore('archiveImports').index('importId').openCursor(IDBKeyRange.only('browser-restore-a'));
      let complete = false;
      request.onsuccess = () => { const cursor = request.result; if (!cursor) return; if (cursor.value.kind === 'job' && cursor.value.status === 'complete') complete = true; cursor.continue(); };
      tx.oncomplete = () => resolve(complete);
      tx.onabort = () => reject(tx.error);
    });
    database.close();
    return { existingText: existing?.text, existingNote: existing?.userMeta?.note, addedText: added?.text, addedNote: added?.userMeta?.note, wrongTrash: !!wrongTrash, revision: revision?.text, manifest: manifest?.value?.filename, imports: !!imports };
  });
  assert.match(verification.existingText, /^Synthetic indexed archive post 0/);
  assert.notEqual(verification.existingNote, 'incoming note');
  assert.equal(verification.addedText, 'restored post');
  assert.equal(verification.addedNote, 'retained note');
  assert.equal(verification.wrongTrash, false);
  assert.equal(verification.revision, 'earlier version');
  assert.equal(verification.manifest, 'recovered.mp4');
  assert.equal(verification.imports, true);
  assert.equal(await frame.locator('#archiveRecoveryAssetsExport').isVisible(), true);
  assert.equal(await frame.locator('#recoveryAssetExport').isVisible(), true);

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: path.join(outputDir, 'recovery-complete-1440.png') });
  await frame.locator('#archiveRecoveryCancel').click();
  await frame.evaluate(() => { window.showSaveFilePicker = undefined; });
  const recoveryDownload = page.waitForEvent('download');
  await frame.locator('#export').click();
  const recoveryFile = await recoveryDownload;
  const recoveryPath = await recoveryFile.path();
  const recoveryText = await fs.readFile(recoveryPath, 'utf8');
  const recoveredLines = recoveryText.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(recoveredLines[0].format, 'xvault-recovery-jsonl');
  assert.equal(recoveredLines.at(-1).type, 'end');
  assert.equal(recoveredLines.at(-1).recordCount, recoveredLines.length - 2);
  assert.equal(recoveredLines.at(-1).downloadRevision, recoveredLines[0].downloadRevision);
  assert.ok(recoveredLines.some(row => row.type === 'record' && row.store === 'tweets' && row.key === '999999'));
  await fs.copyFile(recoveryPath, path.join(outputDir, 'recovery.jsonl'));
  await frame.locator('#archiveRecoveryCancel').click();

  await frame.evaluate(() => window.page('library'));
  await frame.locator('#libraryTools summary').click();
  const csvDownload = page.waitForEvent('download');
  await frame.locator('#csv').click();
  const csvFile = await csvDownload;
  const csvPath = await csvFile.path();
  const csvText = await fs.readFile(csvPath, 'utf8');
  assert.match(csvText, /id,createdAt,author,text,url,likes,reposts,replies,mediaCount/);
  assert.match(csvText, /999999/);
  assert.equal(csvText.trim().split(/\r?\n/).length, 175, 'CSV export should stream every archive post across multiple pages, with one header');
  await fs.copyFile(csvPath, path.join(outputDir, 'archive.csv'));
  await frame.locator('#archiveRecoveryCancel').click();

  await frame.evaluate(() => window.page('integrity'));
  const conflictDownload = page.waitForEvent('download');
  await frame.locator('#recoveryConflictExport').click();
  const downloaded = await conflictDownload;
  const conflictPath = await downloaded.path();
  const conflictText = await fs.readFile(conflictPath, 'utf8');
  assert.match(conflictText, /"type":"conflict"/);
  assert.match(conflictText, /"existing"/);
  assert.match(conflictText, /"incoming"/);
  await fs.copyFile(conflictPath, path.join(outputDir, 'conflicts.jsonl'));
  await frame.locator('#archiveRecoveryCancel').click();

  const assetDownload = page.waitForEvent('download');
  await frame.locator('#recoveryAssetExport').click();
  const assetFile = await assetDownload;
  const assetPath = await assetFile.path();
  const assetText = await fs.readFile(assetPath, 'utf8');
  assert.match(assetText, /recovered\.mp4/);
  assert.doesNotMatch(assetText, /C:\\\\|token=/i, 'portable manifest export must exclude machine paths and signed URLs');
  await fs.copyFile(assetPath, path.join(outputDir, 'file-manifest.jsonl'));
  await frame.locator('#archiveRecoveryCancel').click();

  const readMetrics = await frame.evaluate(() => ({ idb: window.__xvIdbOperations, recoveryPages: window.__xvRecoveryPages, fullReads: window.__xvMessageLog.filter(type => type === 'GET_ALL').length }));
  assert.equal(readMetrics.fullReads, 0, 'recovery and CSV exports must never request the full-store endpoint');
  assert.equal(readMetrics.idb.getAll, 0, 'recovery and CSV exports must not materialize complete IndexedDB stores');
  assert.ok(readMetrics.recoveryPages.length > 0);
  assert.ok(readMetrics.recoveryPages.every(page => !page.stale && page.recordsRead <= Number(page.limit || 25) + 1), 'every export page must stay bounded with one-row look-ahead');
  const measured = {
    backupRecords: recoveredLines.at(-1).recordCount,
    csvPosts: csvText.trim().split(/\r?\n/).length - 1,
    cursorPages: readMetrics.recoveryPages.length,
    recordsRead: readMetrics.recoveryPages.reduce((sum, page) => sum + Number(page.recordsRead || 0), 0),
    cursorOperations: readMetrics.recoveryPages.reduce((sum, page) => sum + Number(page.cursorOperations || 0), 0),
    maxPageRecordsRead: Math.max(...readMetrics.recoveryPages.map(page => Number(page.recordsRead || 0))),
    maxPageLatencyMs: Math.max(...readMetrics.recoveryPages.map(page => Number(page.latencyMs || 0))),
    recoveryBytes: Buffer.byteLength(recoveryText),
    csvBytes: Buffer.byteLength(csvText),
    fullStoreReads: readMetrics.fullReads + readMetrics.idb.getAll
  };

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(consoleErrors, []);
  console.log(`SYNTHETIC bounded-export measurements ${JSON.stringify(measured)}`);
  console.log(`PASS rendered recovery preview, safe interruption/resume and cursor-backed exports at 390px and 1440px · 48 additive records · 2 retained conflicts · screenshots ${outputDir}`);
} finally { await browser.close(); }
