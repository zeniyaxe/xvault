import { RECOVERY_STORES, createRecoveryHeader, encodeRecoveryLine, scanRecoveryArchive } from './archive-recovery.mjs';

const $ = selector => document.querySelector(selector);
const BATCH_ROWS = 40;
const BATCH_BYTES = 512 * 1024;
const EXPORT_PAGE_SIZE = 25;
const FALLBACK_FILE_LIMIT = 32 * 1024 * 1024;
const dialog = $('#archiveRecoveryDialog');
const fileInput = $('#recoveryFile');
const status = $('#recoveryStatus');
const meter = $('#archiveRecoveryMeter');
const progress = $('#archiveRecoveryProgress');
const applyButton = $('#archiveRecoveryApply');
const cancelButton = $('#archiveRecoveryCancel');
const conflictButton = $('#recoveryConflictExport');
const externalAssetsButton = $('#recoveryAssetExport');
const dialogConflictButton = $('#archiveRecoveryConflictExport');
const dialogAssetsButton = $('#archiveRecoveryAssetsExport');

if (dialog && fileInput && typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
  let activeController = null;
  let activeFile = null;
  let preview = null;
  let operation = null;

  const setText = (selector, value) => { const node = $(selector); if (node) node.textContent = String(value ?? ''); };
  const renderConflictSamples = samples => {
    const disclosure = $('#archiveRecoveryConflictSamples'), list = $('#archiveRecoveryConflictList');
    if (!disclosure || !list) return;
    list.replaceChildren();
    const describe = value => {
      if (!value) return 'No local copy';
      return [value.text ? `“${value.text}”` : '', value.note ? `Note: ${value.note}` : '',
        value.filename ? `${value.filename} · ${bytesLabel(value.size || 0)}` : '',
        value.mediaCount ? `${value.mediaCount} media files` : '', value.tags?.length ? `Tags: ${value.tags.join(', ')}` : '']
        .filter(Boolean).join(' · ') || 'Metadata differs';
    };
    for (const sample of (samples || []).slice(0, 5)) {
      const item = document.createElement('li'), title = document.createElement('strong'), detail = document.createElement('span');
      title.textContent = `${sample.store} · ${sample.key} · ${sample.reason}`;
      detail.textContent = `Saved: ${describe(sample.existing)}. File: ${describe(sample.incoming)}.`;
      item.append(title, detail);
      list.append(item);
    }
    disclosure.hidden = !samples?.length;
  };
  const bytesLabel = value => value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
  const setProgress = (label, ratio = null) => {
    progress.textContent = label;
    meter.style.width = ratio == null ? '0%' : `${Math.max(0, Math.min(100, ratio * 100))}%`;
  };
  const openDialog = (title, description) => {
    setText('#archiveRecoveryTitle', title);
    setText('#archiveRecoveryDescription', description);
    setProgress('Preparing…');
    $('#archiveRecoveryCounts').hidden = true;
    $('#archiveRecoveryNotice').hidden = true;
    applyButton.disabled = true;
    applyButton.textContent = 'Import missing records';
    cancelButton.textContent = 'Cancel';
    const hasConflicts = !!preview && (preview.counts.conflict > 0 || preview.job?.conflictCount > 0);
    const hasAssets = Number(preview?.job?.assetReferenceCount || 0) > 0;
    conflictButton.hidden = !hasConflicts;
    if (externalAssetsButton) externalAssetsButton.hidden = !hasAssets;
    if (dialogConflictButton) dialogConflictButton.hidden = !hasConflicts;
    if (dialogAssetsButton) dialogAssetsButton.hidden = !hasAssets;
    if (!preview) renderConflictSamples([]);
    if (!dialog.open) dialog.showModal();
  };
  const request = async (type, properties = {}) => {
    const response = await chrome.runtime.sendMessage({ type, ...properties });
    if (!response || response.ok === false) throw new Error(response?.error || 'XVault could not complete the recovery request');
    return response;
  };
  const showError = error => {
    const message = error?.name === 'AbortError' ? 'Stopped. Any completed batch is saved and can be resumed from this same file.' : error?.message || String(error);
    setProgress(message);
    applyButton.disabled = true;
    cancelButton.textContent = 'Close';
    status.textContent = message;
  };
  const makeBatchReader = async (file, controller, onBatch, onProgress) => {
    let store = null, archiveId = null, rows = [], bytes = 0;
    const flush = async () => {
      if (!rows.length) return;
      const current = rows;
      rows = [];
      bytes = 0;
      await onBatch(store, current, archiveId);
    };
    const result = await scanRecoveryArchive(file, async (record, context) => {
      if (controller.signal.aborted) throw controller.signal.reason || new DOMException('Recovery operation stopped', 'AbortError');
      if (store !== record.store) { await flush(); store = record.store; }
      archiveId = context.header.archiveId;
      const estimate = encoderLength(encodeRecoveryLine(record));
      if (rows.length && (rows.length >= BATCH_ROWS || bytes + estimate > BATCH_BYTES)) await flush();
      rows.push(record);
      bytes += estimate;
      if (rows.length >= BATCH_ROWS || bytes >= BATCH_BYTES) await flush();
    }, {
      signal: controller.signal,
      onProgress: value => onProgress?.(value)
    });
    await flush();
    return result;
  };
  const encoderLength = text => new TextEncoder().encode(text).byteLength;
  const makeWriter = async (suggestedName, { description = 'XVault archive export', mime = 'application/x-ndjson', extension = '.jsonl' } = {}) => {
    if (typeof window.showSaveFilePicker === 'function') {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description, accept: { [mime]: [extension] } }]
      });
      const stream = await handle.createWritable();
      return { write: value => stream.write(value), close: () => stream.close(), abort: reason => stream.abort(reason), streaming: true };
    }
    const chunks = [];
    let size = 0;
    return {
      write: value => {
        size += encoderLength(value);
        if (size > FALLBACK_FILE_LIMIT) { chunks.length = 0; throw new RangeError('This archive is too large for the bounded browser download fallback. Use a Chromium version with the recovery-file save picker.'); }
        chunks.push(value);
      },
      close: () => {
        const url = URL.createObjectURL(new Blob(chunks, { type: mime }));
        const link = document.createElement('a');
        link.href = url;
        link.download = suggestedName;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      },
      abort: () => { chunks.length = 0; },
      streaming: false
    };
  };
  const startOperation = controller => {
    activeController = controller;
    cancelButton.textContent = 'Stop safely';
  };
  const finishOperation = controller => {
    if (activeController === controller) activeController = null;
    cancelButton.textContent = 'Close';
  };

  async function exportRecoveryFile() {
    let writer;
    try {
      // Open the save picker first while the click still carries user activation.
      writer = await makeWriter(`xvault-recovery-${new Date().toISOString().slice(0, 10)}.jsonl`, { description: 'XVault recovery file', mime: 'application/x-ndjson', extension: '.jsonl' });
    } catch (error) {
      if (error?.name !== 'AbortError') { status.textContent = error?.message || String(error); }
      return;
    }
    const controller = new AbortController();
    openDialog('Create recovery file', 'Writing post metadata, Trash, revision history, and file manifests. Media binaries remain in their current folders.');
    startOperation(controller);
    operation = 'export';
    let bytes = 0, recordCount = 0, archiveRevision = null, downloadRevision = null, wroteHeader = false;
    const write = async value => {
      if (controller.signal.aborted) throw controller.signal.reason || new DOMException('Recovery export stopped', 'AbortError');
      await writer.write(value);
      bytes += encoderLength(value);
    };
    try {
      for (const store of RECOVERY_STORES) {
        let afterKey = null, hasMore = true;
        while (hasMore) {
          const expected = archiveRevision == null ? null : { archiveRevision, downloadRevision };
          const page = await request('READ_RECOVERY_BACKUP_PAGE', { store, afterKey, limit: EXPORT_PAGE_SIZE, expectedRevision: expected });
          if (page.stale) throw new Error('The archive changed during backup. The partial file was discarded; run the backup again.');
          if (archiveRevision == null) {
            archiveRevision = page.revision;
            downloadRevision = page.downloadRevision;
            await write(encodeRecoveryLine(createRecoveryHeader({ archiveRevision, downloadRevision })));
            wroteHeader = true;
          }
          for (const value of page.rows || []) {
            const key = store === 'revisions' ? value.key : value.id;
            await write(encodeRecoveryLine({ type: 'record', store, key: String(key), value }));
            recordCount++;
          }
          afterKey = page.nextKey;
          hasMore = !!page.hasMore;
          setProgress(`Read ${recordCount.toLocaleString()} records · wrote ${bytesLabel(bytes)}`, null);
        }
      }
      if (!wroteHeader) throw new Error('XVault could not read an archive backup page');
      const verified = await request('READ_RECOVERY_BACKUP_PAGE', { store: 'tweets', limit: 1, expectedRevision: { archiveRevision, downloadRevision } });
      if (verified.stale) throw new Error('The archive changed while the backup was being written. The partial file was discarded; run the backup again.');
      await write(encodeRecoveryLine({ type: 'end', recordCount, archiveRevision, downloadRevision }));
      await writer.close();
      status.textContent = `Recovery file saved · ${recordCount.toLocaleString()} records · ${bytesLabel(bytes)}. Media files were not copied.`;
      setProgress(`Saved ${recordCount.toLocaleString()} records · ${bytesLabel(bytes)}`, 1);
    } catch (error) {
      try { await writer.abort(error); } catch {}
      showError(error);
    } finally {
      operation = null;
      finishOperation(controller);
    }
  }

  async function exportArchiveCsv() {
    let writer;
    try { writer = await makeWriter(`xvault-archive-${new Date().toISOString().slice(0, 10)}.csv`, { description: 'XVault archive CSV', mime: 'text/csv', extension: '.csv' }); }
    catch (error) { if (error?.name !== 'AbortError') status.textContent = error?.message || String(error); return; }
    const controller = new AbortController();
    openDialog('Export archive CSV', 'Writing every archived post in bounded IndexedDB pages. The export stops if the archive changes.');
    startOperation(controller);
    operation = 'csv';
    let afterKey = null, expectedRevision = null, count = 0, bytes = 0, hasMore = true;
    const encoder = new TextEncoder();
    const write = async value => {
      if (controller.signal.aborted) throw controller.signal.reason || new DOMException('CSV export stopped', 'AbortError');
      await writer.write(value);
      bytes += encoder.encode(value).byteLength;
    };
    const cell = value => {
      const text = String(value ?? '');
      return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    try {
      await write('\ufeffid,createdAt,author,text,url,likes,reposts,replies,mediaCount\r\n');
      while (hasMore) {
        const page = await request('READ_RECOVERY_BACKUP_PAGE', { store: 'tweets', afterKey, limit: 100, expectedRevision });
        if (page.stale) throw new Error('The archive changed during CSV export. The partial file was discarded; run the export again.');
        if (expectedRevision == null) expectedRevision = { archiveRevision: page.revision, downloadRevision: page.downloadRevision };
        for (const tweet of page.rows || []) {
          const values = [tweet.id, tweet.createdAt, tweet.author?.handle, tweet.text, tweet.url, tweet.metrics?.likes, tweet.metrics?.reposts, tweet.metrics?.replies, tweet.media?.length];
          await write(`${values.map(cell).join(',')}\r\n`);
          count++;
        }
        afterKey = page.nextKey;
        hasMore = !!page.hasMore;
        setProgress(`Wrote ${count.toLocaleString()} posts · ${bytesLabel(bytes)}`, null);
      }
      const verified = await request('READ_RECOVERY_BACKUP_PAGE', { store: 'tweets', limit: 1, expectedRevision });
      if (verified.stale) throw new Error('The archive changed before CSV export finished. The partial file was discarded; run the export again.');
      await writer.close();
      setProgress(`Saved ${count.toLocaleString()} posts · ${bytesLabel(bytes)}`, 1);
      status.textContent = `CSV saved · ${count.toLocaleString()} posts.`;
    } catch (error) {
      try { await writer.abort(error); } catch {}
      showError(error);
    } finally {
      operation = null;
      finishOperation(controller);
    }
  }

  async function previewRecoveryFile(file) {
    if (!file) return;
    activeFile = file;
    preview = null;
    const controller = new AbortController();
    openDialog('Review recovery file', `Checking ${file.name} · ${bytesLabel(file.size)}. Existing posts and Trash will not be overwritten.`);
    startOperation(controller);
    operation = 'preview';
    let localRevision = null, downloadRevision = 0, counts = { missing: 0, identical: 0, conflict: 0 }, countsByStore = Object.fromEntries(RECOVERY_STORES.map(store => [store, 0])), conflictSamples = [], checked = 0;
    try {
      const baseline = await request('READ_RECOVERY_BACKUP_PAGE', { store: 'tweets', limit: 1 });
      localRevision = baseline.revision;
      downloadRevision = baseline.downloadRevision;
      const scanned = await makeBatchReader(file, controller, async (store, records, archiveId) => {
        const result = await request('PREVIEW_RECOVERY_BATCH', { records, importId: archiveId, expectedRevision: localRevision, expectedDownloadRevision: downloadRevision });
        if (result.stale) throw new Error('Your archive changed while this file was being checked. Choose the file again to rebuild its preview.');
        for (const key of Object.keys(counts)) counts[key] += Number(result.counts?.[key] || 0);
        for (const sample of result.conflictSamples || []) if (conflictSamples.length < 5) conflictSamples.push(sample);
        countsByStore[store] += records.length;
        checked += records.length;
      }, value => {
        const ratio = value.totalBytes ? value.bytesRead / value.totalBytes : null;
        setProgress(`Checking ${bytesLabel(value.bytesRead)} of ${bytesLabel(file.size)} · ${checked.toLocaleString()} records compared`, ratio);
      });
      const proposedJobId = `${scanned.header.archiveId}|${scanned.fingerprint}|${localRevision}|${downloadRevision}`;
      const existing = await request('FIND_RECOVERY_IMPORT_JOB', { importId: scanned.header.archiveId, fingerprint: scanned.fingerprint });
      const job = existing.job && existing.job.expectedRevision === localRevision && existing.job.expectedDownloadRevision === downloadRevision ? existing.job : null;
      const jobId = job?.jobId || proposedJobId;
      preview = { file, header: scanned.header, footer: scanned.footer, fingerprint: scanned.fingerprint, jobId, importId: scanned.header.archiveId, localRevision, downloadRevision, counts, countsByStore, conflictSamples, job };
      renderConflictSamples(conflictSamples);
      setText('#recoveryCountNew', counts.missing.toLocaleString());
      setText('#recoveryCountSame', counts.identical.toLocaleString());
      setText('#recoveryCountConflicts', counts.conflict.toLocaleString());
      setText('#recoveryCountAssets', countsByStore.assets.toLocaleString());
      $('#archiveRecoveryCounts').hidden = false;
      $('#archiveRecoveryNotice').hidden = counts.conflict === 0;
      if (counts.conflict) setText('#archiveRecoveryNotice', 'No local data will be overwritten. If you continue, both versions of each conflict will be saved as evidence.');
      if (job?.status === 'complete') {
        applyButton.disabled = true;
        applyButton.textContent = 'Already restored';
        setProgress(`This recovery file was already applied · ${job.importedCount.toLocaleString()} records added`, 1);
        status.textContent = `Already restored from ${file.name}.`;
      } else {
        const nothingToAdd = !job?.recordCount && counts.missing === 0 && counts.conflict === 0;
        applyButton.disabled = nothingToAdd;
        applyButton.textContent = job?.recordCount ? `Resume · ${Number(job.recordCount).toLocaleString()} checked` : nothingToAdd ? 'Already present' : counts.missing === 0 && counts.conflict > 0 ? 'Keep conflict evidence' : 'Import missing records';
        setProgress(`${counts.missing.toLocaleString()} new · ${counts.identical.toLocaleString()} already present · ${counts.conflict.toLocaleString()} conflicts`, 1);
        status.textContent = nothingToAdd ? `${file.name} reviewed · all records are already present with no conflicts.` : `${file.name} reviewed · ${counts.missing.toLocaleString()} missing records can be added.`;
      }
      conflictButton.hidden = !(job?.conflictCount > 0);
      if (dialogConflictButton) dialogConflictButton.hidden = conflictButton.hidden;
      if (dialogAssetsButton) dialogAssetsButton.hidden = !(job?.assetReferenceCount > 0);
      if (externalAssetsButton) externalAssetsButton.hidden = dialogAssetsButton?.hidden !== false;
      cancelButton.textContent = 'Close';
    } catch (error) {
      showError(error);
    } finally {
      operation = null;
      finishOperation(controller);
    }
  }

  async function applyRecoveryFile() {
    if (!preview || !activeFile) return;
    const current = preview;
    const controller = new AbortController();
    startOperation(controller);
    operation = 'import';
    applyButton.disabled = true;
    const started = await request('BEGIN_RECOVERY_IMPORT', { options: {
      jobId: current.jobId, importId: current.importId, fingerprint: current.fingerprint,
      expectedRevision: current.localRevision, expectedDownloadRevision: current.downloadRevision, header: current.header
    } }).catch(error => { showError(error); return null; });
    if (!started) { finishOperation(controller); operation = null; return; }
    if (started.stale) {
      showError(new Error(started.error || 'The archive changed after preview. Review the file again before restoring.'));
      finishOperation(controller); operation = null; return;
    }
    let job = started.job, expectedRevision = started.revision, expectedDownloadRevision = started.downloadRevision;
    if (job.status === 'complete') {
      setProgress(`Already restored · ${job.importedCount.toLocaleString()} records added`, 1);
      finishOperation(controller); operation = null; return;
    }
    cancelButton.textContent = 'Stop safely';
    setText('#archiveRecoveryTitle', 'Restore archive records');
    setText('#archiveRecoveryDescription', 'New rows commit in small transactions. Conflicts remain in a separate evidence ledger.');
    const resumeStoreIndex = Number(job.storeIndex ?? -1), resumeKey = job.lastKey == null ? null : String(job.lastKey);
    try {
      const scanned = await makeBatchReader(activeFile, controller, async (store, records) => {
        const index = RECOVERY_STORES.indexOf(store);
        let remaining = records;
        if (index < resumeStoreIndex) return;
        if (index === resumeStoreIndex && resumeKey != null) remaining = records.filter(record => record.key > resumeKey);
        if (!remaining.length) return;
        const result = await request('COMMIT_RECOVERY_BATCH', { batch: {
          jobId: current.jobId, importId: current.importId, fingerprint: current.fingerprint,
          store, records: remaining, expectedRevision, expectedDownloadRevision
        } });
        if (result.stale) throw new Error(result.error || 'The archive changed during restore. Its completed batches are safe; review the file again to resume.');
        expectedRevision = result.revision;
        expectedDownloadRevision = result.downloadRevision;
        job = result.job;
        current.job = job;
        const hasStoredConflicts = Number(job.conflictCount || 0) > 0;
        const hasRecoveredAssets = Number(job.assetReferenceCount || 0) > 0;
        conflictButton.hidden = !hasStoredConflicts;
        if (dialogConflictButton) dialogConflictButton.hidden = !hasStoredConflicts;
        if (dialogAssetsButton) dialogAssetsButton.hidden = !hasRecoveredAssets;
        if (externalAssetsButton) externalAssetsButton.hidden = !hasRecoveredAssets;
        if (hasStoredConflicts) setText('#archiveRecoveryNotice', 'Both versions are saved as conflict evidence. Nothing already in your archive was overwritten or moved out of Trash.');
        setProgress(`Added ${job.importedCount.toLocaleString()} · retained ${job.conflictCount.toLocaleString()} conflicts · ${job.recordCount.toLocaleString()} records checked`, null);
      }, value => {
        const ratio = value.totalBytes ? value.bytesRead / value.totalBytes : null;
        setProgress(`Reading ${bytesLabel(value.bytesRead)} of ${bytesLabel(activeFile.size)} · ${job.importedCount.toLocaleString()} added`, ratio);
      });
      if (scanned.fingerprint !== current.fingerprint) throw new Error('The recovery file changed between preview and restore. Completed additive batches remain safe; review the file again.');
      const completed = await request('COMPLETE_RECOVERY_IMPORT', { jobId: current.jobId, fingerprint: current.fingerprint, expectedRevision, expectedDownloadRevision, footer: scanned.footer });
      if (completed.stale) throw new Error(completed.error || 'The archive changed before restore finished. Review this file again.');
      job = completed.job;
      setText('#recoveryCountNew', Number(job.importedCount || 0).toLocaleString());
      setText('#recoveryCountSame', Number(job.identicalCount || 0).toLocaleString());
      setText('#recoveryCountConflicts', Number(job.conflictCount || 0).toLocaleString());
      setText('#recoveryCountAssets', Number(current.countsByStore.assets || 0).toLocaleString());
      $('#archiveRecoveryNotice').hidden = !job.conflictCount;
      if (job.conflictCount) setText('#archiveRecoveryNotice', 'Both versions are saved as conflict evidence. Nothing already in your archive was overwritten or moved out of Trash.');
      conflictButton.hidden = !job.conflictCount;
      if (dialogConflictButton) dialogConflictButton.hidden = !job.conflictCount;
      if (dialogAssetsButton) dialogAssetsButton.hidden = !(job.assetReferenceCount > 0);
      if (externalAssetsButton) externalAssetsButton.hidden = dialogAssetsButton?.hidden !== false;
      applyButton.disabled = true;
      applyButton.textContent = 'Restore complete';
      setProgress(`Restored ${job.importedCount.toLocaleString()} new records · ${job.conflictCount.toLocaleString()} conflicts retained`, 1);
      status.textContent = `Recovery complete · ${job.importedCount.toLocaleString()} new records added. Existing archive rows were preserved.`;
    } catch (error) {
      showError(error);
    } finally {
      operation = null;
      finishOperation(controller);
    }
  }

  async function exportConflictEvidence() {
    if (!preview?.importId) return;
    let writer;
    try { writer = await makeWriter(`xvault-recovery-conflicts-${new Date().toISOString().slice(0, 10)}.jsonl`, { description: 'XVault conflict evidence', mime: 'application/x-ndjson', extension: '.jsonl' }); }
    catch (error) { if (error?.name !== 'AbortError') status.textContent = error?.message || String(error); return; }
    const controller = new AbortController();
    openDialog('Export conflict evidence', 'Saving both local and incoming versions as reviewable JSON Lines.');
    startOperation(controller);
    operation = 'conflicts';
    let count = 0, bytes = 0, afterKey = null;
    const write = async value => { if (controller.signal.aborted) throw controller.signal.reason; await writer.write(value); bytes += encoderLength(value); };
    try {
      await write(encodeRecoveryLine({ type: 'header', format: 'xvault-recovery-conflicts', version: 1, importId: preview.importId, exportedAt: new Date().toISOString() }));
      let hasMore = true;
      while (hasMore) {
        const page = await request('READ_RECOVERY_IMPORT_CONFLICTS', { importId: preview.importId, afterKey, limit: 50 });
        for (const row of page.rows || []) { await write(encodeRecoveryLine({ type: 'conflict', ...row })); count++; }
        afterKey = page.nextKey;
        hasMore = !!page.hasMore;
        setProgress(`Saved ${count.toLocaleString()} conflict records · ${bytesLabel(bytes)}`);
      }
      await write(encodeRecoveryLine({ type: 'end', records: count }));
      await writer.close();
      setProgress(`Saved ${count.toLocaleString()} conflict records · ${bytesLabel(bytes)}`, 1);
      status.textContent = `Conflict evidence saved · ${count.toLocaleString()} versions retained.`;
      conflictButton.hidden = false;
      if (dialogConflictButton) dialogConflictButton.hidden = false;
    } catch (error) { try { await writer.abort(error); } catch {} showError(error); }
    finally { operation = null; finishOperation(controller); }
  }

  async function exportAssetManifest() {
    if (!preview?.importId) return;
    let writer;
    try { writer = await makeWriter(`xvault-local-file-manifest-${new Date().toISOString().slice(0, 10)}.jsonl`, { description: 'XVault local file manifest', mime: 'application/x-ndjson', extension: '.jsonl' }); }
    catch (error) { if (error?.name !== 'AbortError') status.textContent = error?.message || String(error); return; }
    const controller = new AbortController();
    openDialog('Export local file manifest', 'Saving portable filename, size, digest, media identity, and verification state. Machine-specific paths and signed URLs are excluded.');
    startOperation(controller);
    operation = 'assets';
    let count = 0, bytes = 0, afterKey = null, hasMore = true;
    const write = async value => { if (controller.signal.aborted) throw controller.signal.reason; await writer.write(value); bytes += encoderLength(value); };
    try {
      await write(encodeRecoveryLine({ type: 'header', format: 'xvault-local-file-manifest', version: 1, importId: preview.importId, exportedAt: new Date().toISOString() }));
      while (hasMore) {
        const page = await request('READ_RECOVERY_ASSET_REFERENCES', { importId: preview.importId, afterKey, limit: 100 });
        for (const value of page.rows || []) { await write(encodeRecoveryLine({ type: 'asset', ...value })); count++; }
        afterKey = page.nextKey;
        hasMore = !!page.hasMore;
        setProgress(`Saved ${count.toLocaleString()} file references · ${bytesLabel(bytes)}`);
      }
      await write(encodeRecoveryLine({ type: 'end', records: count }));
      await writer.close();
      setProgress(`Saved ${count.toLocaleString()} file references · ${bytesLabel(bytes)}`, 1);
      status.textContent = `File manifest saved · ${count.toLocaleString()} references. Paths and signed URLs were excluded.`;
      if (dialogAssetsButton) dialogAssetsButton.hidden = false;
    } catch (error) { try { await writer.abort(error); } catch {} showError(error); }
    finally { operation = null; finishOperation(controller); }
  }

  $('#recoveryExport')?.addEventListener('click', exportRecoveryFile);
  $('#export')?.addEventListener('click', exportRecoveryFile);
  $('#csv')?.addEventListener('click', exportArchiveCsv);
  window.XVaultCreateRecoveryFile = exportRecoveryFile;
  $('#recoveryImport')?.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0] || null;
    fileInput.value = '';
    if (file) void previewRecoveryFile(file);
  });
  applyButton.addEventListener('click', () => { if (operation === 'preview') return; if (activeFile && preview) void applyRecoveryFile(); });
  conflictButton.addEventListener('click', exportConflictEvidence);
  externalAssetsButton?.addEventListener('click', exportAssetManifest);
  dialogConflictButton?.addEventListener('click', exportConflictEvidence);
  dialogAssetsButton?.addEventListener('click', exportAssetManifest);
  const cancel = () => {
    if (activeController) {
      activeController.abort(new DOMException('Recovery operation stopped', 'AbortError'));
      activeController = null;
    }
    if (dialog.open) dialog.close();
  };
  cancelButton.addEventListener('click', cancel);
  $('#archiveRecoveryClose')?.addEventListener('click', cancel);
  dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
}
