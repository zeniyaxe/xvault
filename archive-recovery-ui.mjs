import { RECOVERY_STORES, encodeRecoveryLine, scanRecoveryArchive } from './archive-recovery.mjs';
import { writeRecoveryBackup } from './recovery-backup-core.mjs';
import * as exporters from './library-exporters.mjs';
import { BACKUP_EXTENSION, decryptBackup, encryptingWriter, isEncryptedBackup } from './backup-crypto.mjs';

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

  const setText = (selector, value) => {
    const node = $(selector);
    if (node) node.textContent = String(value ?? '');
  };
  const renderConflictSamples = samples => {
    const disclosure = $('#archiveRecoveryConflictSamples'),
      list = $('#archiveRecoveryConflictList');
    if (!disclosure || !list) return;
    list.replaceChildren();
    const describe = value => {
      if (!value) return 'No local copy';
      return (
        [
          value.text ? `“${value.text}”` : '',
          value.note ? `Note: ${value.note}` : '',
          value.filename ? `${value.filename} · ${bytesLabel(value.size || 0)}` : '',
          value.mediaCount ? `${value.mediaCount} media files` : '',
          value.tags?.length ? `Tags: ${value.tags.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' · ') || 'Metadata differs'
      );
    };
    for (const sample of (samples || []).slice(0, 5)) {
      const item = document.createElement('li'),
        title = document.createElement('strong'),
        detail = document.createElement('span');
      title.textContent = `${sample.store} · ${sample.key} · ${sample.reason}`;
      detail.textContent = `Saved: ${describe(sample.existing)}. File: ${describe(sample.incoming)}.`;
      item.append(title, detail);
      list.append(item);
    }
    disclosure.hidden = !samples?.length;
  };
  const bytesLabel = value =>
    value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
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
    if (!response || response.ok === false)
      throw new Error(response?.error || 'XVault could not complete the recovery request');
    return response;
  };
  const showError = error => {
    const message =
      error?.name === 'AbortError'
        ? 'Stopped. Any completed batch is saved and can be resumed from this same file.'
        : error?.message || String(error);
    setProgress(message);
    applyButton.disabled = true;
    cancelButton.textContent = 'Close';
    status.textContent = message;
  };
  const makeBatchReader = async (file, controller, onBatch, onProgress) => {
    let store = null,
      archiveId = null,
      rows = [],
      bytes = 0;
    const flush = async () => {
      if (!rows.length) return;
      const current = rows;
      rows = [];
      bytes = 0;
      await onBatch(store, current, archiveId);
    };
    const result = await scanRecoveryArchive(
      file,
      async (record, context) => {
        if (controller.signal.aborted)
          throw controller.signal.reason || new DOMException('Recovery operation stopped', 'AbortError');
        if (store !== record.store) {
          await flush();
          store = record.store;
        }
        archiveId = context.header.archiveId;
        const estimate = encoderLength(encodeRecoveryLine(record));
        if (rows.length && (rows.length >= BATCH_ROWS || bytes + estimate > BATCH_BYTES)) await flush();
        rows.push(record);
        bytes += estimate;
        if (rows.length >= BATCH_ROWS || bytes >= BATCH_BYTES) await flush();
      },
      {
        signal: controller.signal,
        onProgress: value => onProgress?.(value),
      }
    );
    await flush();
    return result;
  };
  const encoderLength = text => new TextEncoder().encode(text).byteLength;
  const makeWriter = async (
    suggestedName,
    { description = 'XVault archive export', mime = 'application/x-ndjson', extension = '.jsonl' } = {}
  ) => {
    if (typeof window.showSaveFilePicker === 'function') {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description, accept: { [mime]: [extension] } }],
      });
      const stream = await handle.createWritable();
      return {
        write: value => stream.write(value),
        close: () => stream.close(),
        abort: reason => stream.abort(reason),
        streaming: true,
      };
    }
    const chunks = [];
    let size = 0;
    return {
      write: value => {
        size += typeof value === 'string' ? encoderLength(value) : value.byteLength;
        if (size > FALLBACK_FILE_LIMIT) {
          chunks.length = 0;
          throw new RangeError(
            'This archive is too large for the bounded browser download fallback. Use a Chromium version with the recovery-file save picker.'
          );
        }
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
      abort: () => {
        chunks.length = 0;
      },
      streaming: false,
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

  // options.passphrase (XVault 20) wraps the same JSONL stream in the AES-GCM container from backup-crypto.mjs.
  async function exportRecoveryFile(options = {}) {
    let writer;
    const passphrase = typeof options?.passphrase === 'string' ? options.passphrase : '';
    try {
      // Open the save picker first while the click still carries user activation.
      const day = new Date().toISOString().slice(0, 10);
      writer = passphrase
        ? encryptingWriter(
            await makeWriter(`xvault-recovery-${day}${BACKUP_EXTENSION}`, {
              description: 'Encrypted XVault recovery file',
              mime: 'application/octet-stream',
              extension: BACKUP_EXTENSION,
            }),
            passphrase,
            { meta: { contains: 'xvault-recovery-jsonl' } }
          )
        : await makeWriter(`xvault-recovery-${day}.jsonl`, {
            description: 'XVault recovery file',
            mime: 'application/x-ndjson',
            extension: '.jsonl',
          });
    } catch (error) {
      if (error?.name !== 'AbortError') {
        status.textContent = error?.message || String(error);
      }
      return;
    }
    const controller = new AbortController();
    openDialog(
      'Create recovery file',
      'Writing post metadata, Trash, revision history, and file manifests. Media binaries remain in their current folders.'
    );
    startOperation(controller);
    operation = 'export';
    let bytes = 0,
      recordCount = 0;
    const write = async value => {
      await writer.write(value);
      bytes += encoderLength(value);
    };
    try {
      ({ recordCount } = await writeRecoveryBackup({
        request,
        write,
        signal: controller.signal,
        pageSize: EXPORT_PAGE_SIZE,
        onProgress: progress =>
          setProgress(`Read ${progress.recordCount.toLocaleString()} records · wrote ${bytesLabel(bytes)}`, null),
      }));
      await writer.close();
      status.textContent = `${passphrase ? 'Encrypted recovery file' : 'Recovery file'} saved · ${recordCount.toLocaleString()} records · ${bytesLabel(passphrase ? writer.bytesWritten : bytes)}. Media files were not copied.`;
      window.dispatchEvent(
        new CustomEvent('xvault:backup-saved', { detail: { encrypted: !!passphrase, recordCount, bytes } })
      );
      setProgress(`Saved ${recordCount.toLocaleString()} records · ${bytesLabel(bytes)}`, 1);
    } catch (error) {
      try {
        await writer.abort(error);
      } catch {}
      showError(error);
    } finally {
      operation = null;
      finishOperation(controller);
    }
  }

  // Streams every archived post through `emit` in bounded pages, aborting if the archive changes mid-export.
  async function streamArchivePosts(controller, label, emit) {
    let afterKey = null,
      expectedRevision = null,
      count = 0,
      hasMore = true;
    const stale = when =>
      new Error(`The archive changed ${when} ${label} export. Run the export again for a consistent copy.`);
    while (hasMore) {
      if (controller.signal.aborted)
        throw controller.signal.reason || new DOMException(`${label} export stopped`, 'AbortError');
      const page = await request('READ_RECOVERY_BACKUP_PAGE', {
        store: 'tweets',
        afterKey,
        limit: 100,
        expectedRevision,
      });
      if (page.stale) throw stale('during');
      if (expectedRevision == null)
        expectedRevision = { archiveRevision: page.revision, downloadRevision: page.downloadRevision };
      for (const post of page.rows || []) {
        await emit(post);
        count++;
      }
      afterKey = page.nextKey;
      hasMore = !!page.hasMore;
      setProgress(`Wrote ${count.toLocaleString()} posts`, null);
    }
    const verified = await request('READ_RECOVERY_BACKUP_PAGE', { store: 'tweets', limit: 1, expectedRevision });
    if (verified.stale) throw stale('before');
    return count;
  }

  // Single-file exports (CSV, HTML) share one streaming writer path.
  async function exportArchiveFile({ label, extension, mime, head, row, foot }) {
    const day = new Date().toISOString().slice(0, 10);
    let writer;
    try {
      writer = await makeWriter(`xvault-archive-${day}${extension}`, {
        description: `XVault archive ${label}`,
        mime,
        extension,
      });
    } catch (error) {
      if (error?.name !== 'AbortError') status.textContent = error?.message || String(error);
      return;
    }
    const controller = new AbortController();
    openDialog(
      `Export archive ${label}`,
      'Writing every archived post in bounded IndexedDB pages. The export stops if the archive changes.'
    );
    startOperation(controller);
    operation = label.toLowerCase();
    let bytes = 0;
    const write = async value => {
      await writer.write(value);
      bytes += encoderLength(value);
    };
    try {
      await write(head());
      const count = await streamArchivePosts(controller, label, post => write(row(post)));
      await write(foot());
      await writer.close();
      setProgress(`Saved ${count.toLocaleString()} posts · ${bytesLabel(bytes)}`, 1);
      status.textContent = `${label} saved · ${count.toLocaleString()} posts.`;
    } catch (error) {
      try {
        await writer.abort(error);
      } catch {}
      showError(error);
    } finally {
      operation = null;
      finishOperation(controller);
    }
  }

  const exportArchiveCsv = () =>
    exportArchiveFile({
      label: 'CSV',
      extension: '.csv',
      mime: 'text/csv',
      head: exporters.csvHeader,
      row: exporters.csvRow,
      foot: () => '',
    });
  const exportArchiveHtml = () =>
    exportArchiveFile({
      label: 'HTML',
      extension: '.html',
      mime: 'text/html',
      head: () => exporters.htmlHead('XVault archive'),
      row: exporters.htmlPost,
      foot: exporters.htmlFoot,
    });

  // Obsidian-compatible export: one Markdown note per post plus an index note, written into a folder.
  async function exportArchiveMarkdown() {
    if (typeof window.showDirectoryPicker !== 'function') {
      status.textContent = 'Markdown folder export needs a Chromium version with folder access.';
      return;
    }
    let parent;
    try {
      parent = await window.showDirectoryPicker({ id: 'xvault-markdown', mode: 'readwrite' });
    } catch (error) {
      if (error?.name !== 'AbortError') status.textContent = error?.message || String(error);
      return;
    }
    const controller = new AbortController();
    openDialog(
      'Export Markdown notes',
      'Writing one Obsidian-compatible note per post. Existing notes with the same name are updated in place.'
    );
    startOperation(controller);
    operation = 'markdown';
    const writeText = async (dir, name, text) => {
      const handle = await dir.getFileHandle(name, { create: true });
      const stream = await handle.createWritable();
      await stream.write(text);
      await stream.close();
    };
    try {
      const root = await parent.getDirectoryHandle('XVault', { create: true });
      const posts = await root.getDirectoryHandle('posts', { create: true });
      const entries = [];
      const count = await streamArchivePosts(controller, 'Markdown', async post => {
        const file = exporters.markdownFileName(post);
        await writeText(posts, file, exporters.markdownNote(post));
        entries.push({ file: `posts/${file}`, handle: post?.author?.handle, text: post?.text });
      });
      entries.sort((a, b) => b.file.localeCompare(a.file));
      await writeText(root, 'XVault Index.md', exporters.markdownIndex(entries));
      setProgress(`Saved ${count.toLocaleString()} notes`, 1);
      status.textContent = `Markdown saved · ${count.toLocaleString()} notes in ${parent.name}/XVault.`;
    } catch (error) {
      showError(error);
    } finally {
      operation = null;
      finishOperation(controller);
    }
  }

  // Thread-grouped export. Pass 1 streams lightweight keys to group conversations; pass 2 reads each
  // thread's records in bounded batches so memory stays proportional to IDs, not post bodies.
  async function exportThreads(format) {
    const markdown = format === 'markdown';
    let parent = null,
      writer = null;
    const day = new Date().toISOString().slice(0, 10);
    try {
      if (markdown) {
        if (typeof window.showDirectoryPicker !== 'function') {
          status.textContent = 'Markdown folder export needs a Chromium version with folder access.';
          return;
        }
        parent = await window.showDirectoryPicker({ id: 'xvault-markdown', mode: 'readwrite' });
      } else
        writer = await makeWriter(`xvault-threads-${day}.html`, {
          description: 'XVault threads HTML',
          mime: 'text/html',
          extension: '.html',
        });
    } catch (error) {
      if (error?.name !== 'AbortError') status.textContent = error?.message || String(error);
      return;
    }
    const controller = new AbortController();
    openDialog(
      markdown ? 'Export threads as Markdown' : 'Export threads as HTML',
      'Grouping every archived post into conversations, then writing each thread in chronological order.'
    );
    startOperation(controller);
    operation = 'threads';
    const writeText = async (dir, name, text) => {
      const handle = await dir.getFileHandle(name, { create: true });
      const stream = await handle.createWritable();
      await stream.write(text);
      await stream.close();
    };
    try {
      const keys = [];
      await streamArchivePosts(controller, 'thread', post => keys.push(exporters.threadKeyRow(post)));
      const groups = exporters.threadGroups(keys);
      keys.length = 0;
      let root = null,
        folder = null;
      if (markdown) {
        root = await parent.getDirectoryHandle('XVault', { create: true });
        folder = await root.getDirectoryHandle('threads', { create: true });
      } else await writer.write(exporters.htmlThreadHead('XVault threads'));
      const entries = [];
      let written = 0,
        batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const ids = [...new Set(batch.flatMap(group => group.ids))];
        const rows = [];
        for (let index = 0; index < ids.length; index += 900) {
          const page = await request('GET_LIBRARY_RECORDS', { ids: ids.slice(index, index + 900) });
          rows.push(...(page.rows || []).filter(Boolean));
        }
        const byId = new Map(rows.map(row => [String(row.id), row]));
        const quotedIds = [...new Set(rows.map(row => row.quotedPostId).filter(id => id && !byId.has(String(id))))];
        const quoted = new Map();
        for (let index = 0; index < quotedIds.length; index += 900) {
          const page = await request('GET_LIBRARY_RECORDS', { ids: quotedIds.slice(index, index + 900).map(String) });
          for (const row of page.rows || []) if (row) quoted.set(String(row.id), row);
        }
        for (const group of batch) {
          if (controller.signal.aborted)
            throw controller.signal.reason || new DOMException('Export stopped', 'AbortError');
          const posts = group.ids.map(id => byId.get(id)).filter(Boolean);
          if (!posts.length) continue;
          const quotes = posts
            .map(
              post =>
                post.quotedPostId && (byId.get(String(post.quotedPostId)) || quoted.get(String(post.quotedPostId)))
            )
            .filter(Boolean);
          const thread = exporters.buildThread(posts, quotes);
          if (markdown) {
            const file = exporters.threadFileName(thread);
            await writeText(folder, file, exporters.threadMarkdownNote(thread));
            entries.push({
              file: `threads/${file}`,
              handle: thread.rootHandle,
              text: thread.posts[0]?.text,
              posts: thread.posts.length,
              start: thread.start,
            });
          } else await writer.write(exporters.htmlThread(thread));
          written++;
        }
        batch = [];
        setProgress(
          `Wrote ${written.toLocaleString()} of ${groups.length.toLocaleString()} threads`,
          written / groups.length
        );
      };
      for (const group of groups) {
        batch.push(group);
        if (batch.reduce((sum, item) => sum + item.ids.length, 0) >= 400) await flush();
      }
      await flush();
      if (markdown) {
        await writeText(root, 'XVault Threads.md', exporters.threadMarkdownIndex(entries.reverse()));
        status.textContent = `Threads saved · ${written.toLocaleString()} conversations in ${parent.name}/XVault/threads.`;
      } else {
        await writer.write(exporters.htmlThreadFoot());
        await writer.close();
        status.textContent = `Threads HTML saved · ${written.toLocaleString()} conversations.`;
      }
      setProgress(`Saved ${written.toLocaleString()} threads`, 1);
    } catch (error) {
      try {
        await writer?.abort(error);
      } catch {}
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
    openDialog(
      'Review recovery file',
      `Checking ${file.name} · ${bytesLabel(file.size)}. Existing posts and Trash will not be overwritten.`
    );
    startOperation(controller);
    operation = 'preview';
    let localRevision = null,
      downloadRevision = 0,
      counts = { missing: 0, identical: 0, conflict: 0 },
      countsByStore = Object.fromEntries(RECOVERY_STORES.map(store => [store, 0])),
      conflictSamples = [],
      checked = 0;
    try {
      const baseline = await request('READ_RECOVERY_BACKUP_PAGE', { store: 'tweets', limit: 1 });
      localRevision = baseline.revision;
      downloadRevision = baseline.downloadRevision;
      const scanned = await makeBatchReader(
        file,
        controller,
        async (store, records, archiveId) => {
          const result = await request('PREVIEW_RECOVERY_BATCH', {
            records,
            importId: archiveId,
            expectedRevision: localRevision,
            expectedDownloadRevision: downloadRevision,
          });
          if (result.stale)
            throw new Error(
              'Your archive changed while this file was being checked. Choose the file again to rebuild its preview.'
            );
          for (const key of Object.keys(counts)) counts[key] += Number(result.counts?.[key] || 0);
          for (const sample of result.conflictSamples || [])
            if (conflictSamples.length < 5) conflictSamples.push(sample);
          countsByStore[store] += records.length;
          checked += records.length;
        },
        value => {
          const ratio = value.totalBytes ? value.bytesRead / value.totalBytes : null;
          setProgress(
            `Checking ${bytesLabel(value.bytesRead)} of ${bytesLabel(file.size)} · ${checked.toLocaleString()} records compared`,
            ratio
          );
        }
      );
      const proposedJobId = `${scanned.header.archiveId}|${scanned.fingerprint}|${localRevision}|${downloadRevision}`;
      const existing = await request('FIND_RECOVERY_IMPORT_JOB', {
        importId: scanned.header.archiveId,
        fingerprint: scanned.fingerprint,
      });
      const job =
        existing.job &&
        existing.job.expectedRevision === localRevision &&
        existing.job.expectedDownloadRevision === downloadRevision
          ? existing.job
          : null;
      const jobId = job?.jobId || proposedJobId;
      preview = {
        file,
        header: scanned.header,
        footer: scanned.footer,
        fingerprint: scanned.fingerprint,
        jobId,
        importId: scanned.header.archiveId,
        localRevision,
        downloadRevision,
        counts,
        countsByStore,
        conflictSamples,
        job,
      };
      renderConflictSamples(conflictSamples);
      setText('#recoveryCountNew', counts.missing.toLocaleString());
      setText('#recoveryCountSame', counts.identical.toLocaleString());
      setText('#recoveryCountConflicts', counts.conflict.toLocaleString());
      setText('#recoveryCountAssets', countsByStore.assets.toLocaleString());
      $('#archiveRecoveryCounts').hidden = false;
      $('#archiveRecoveryNotice').hidden = counts.conflict === 0;
      if (counts.conflict)
        setText(
          '#archiveRecoveryNotice',
          'No local data will be overwritten. If you continue, both versions of each conflict will be saved as evidence.'
        );
      if (job?.status === 'complete') {
        applyButton.disabled = true;
        applyButton.textContent = 'Already restored';
        setProgress(`This recovery file was already applied · ${job.importedCount.toLocaleString()} records added`, 1);
        status.textContent = `Already restored from ${file.name}.`;
      } else {
        const nothingToAdd = !job?.recordCount && counts.missing === 0 && counts.conflict === 0;
        applyButton.disabled = nothingToAdd;
        applyButton.textContent = job?.recordCount
          ? `Resume · ${Number(job.recordCount).toLocaleString()} checked`
          : nothingToAdd
            ? 'Already present'
            : counts.missing === 0 && counts.conflict > 0
              ? 'Keep conflict evidence'
              : 'Import missing records';
        setProgress(
          `${counts.missing.toLocaleString()} new · ${counts.identical.toLocaleString()} already present · ${counts.conflict.toLocaleString()} conflicts`,
          1
        );
        status.textContent = nothingToAdd
          ? `${file.name} reviewed · all records are already present with no conflicts.`
          : `${file.name} reviewed · ${counts.missing.toLocaleString()} missing records can be added.`;
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
    const started = await request('BEGIN_RECOVERY_IMPORT', {
      options: {
        jobId: current.jobId,
        importId: current.importId,
        fingerprint: current.fingerprint,
        expectedRevision: current.localRevision,
        expectedDownloadRevision: current.downloadRevision,
        header: current.header,
      },
    }).catch(error => {
      showError(error);
      return null;
    });
    if (!started) {
      finishOperation(controller);
      operation = null;
      return;
    }
    if (started.stale) {
      showError(
        new Error(started.error || 'The archive changed after preview. Review the file again before restoring.')
      );
      finishOperation(controller);
      operation = null;
      return;
    }
    let job = started.job,
      expectedRevision = started.revision,
      expectedDownloadRevision = started.downloadRevision;
    if (job.status === 'complete') {
      setProgress(`Already restored · ${job.importedCount.toLocaleString()} records added`, 1);
      finishOperation(controller);
      operation = null;
      return;
    }
    cancelButton.textContent = 'Stop safely';
    setText('#archiveRecoveryTitle', 'Restore archive records');
    setText(
      '#archiveRecoveryDescription',
      'New rows commit in small transactions. Conflicts remain in a separate evidence ledger.'
    );
    const resumeStoreIndex = Number(job.storeIndex ?? -1),
      resumeKey = job.lastKey == null ? null : String(job.lastKey);
    try {
      const scanned = await makeBatchReader(
        activeFile,
        controller,
        async (store, records) => {
          const index = RECOVERY_STORES.indexOf(store);
          let remaining = records;
          if (index < resumeStoreIndex) return;
          if (index === resumeStoreIndex && resumeKey != null)
            remaining = records.filter(record => record.key > resumeKey);
          if (!remaining.length) return;
          const result = await request('COMMIT_RECOVERY_BATCH', {
            batch: {
              jobId: current.jobId,
              importId: current.importId,
              fingerprint: current.fingerprint,
              store,
              records: remaining,
              expectedRevision,
              expectedDownloadRevision,
            },
          });
          if (result.stale)
            throw new Error(
              result.error ||
                'The archive changed during restore. Its completed batches are safe; review the file again to resume.'
            );
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
          if (hasStoredConflicts)
            setText(
              '#archiveRecoveryNotice',
              'Both versions are saved as conflict evidence. Nothing already in your archive was overwritten or moved out of Trash.'
            );
          setProgress(
            `Added ${job.importedCount.toLocaleString()} · retained ${job.conflictCount.toLocaleString()} conflicts · ${job.recordCount.toLocaleString()} records checked`,
            null
          );
        },
        value => {
          const ratio = value.totalBytes ? value.bytesRead / value.totalBytes : null;
          setProgress(
            `Reading ${bytesLabel(value.bytesRead)} of ${bytesLabel(activeFile.size)} · ${job.importedCount.toLocaleString()} added`,
            ratio
          );
        }
      );
      if (scanned.fingerprint !== current.fingerprint)
        throw new Error(
          'The recovery file changed between preview and restore. Completed additive batches remain safe; review the file again.'
        );
      const completed = await request('COMPLETE_RECOVERY_IMPORT', {
        jobId: current.jobId,
        fingerprint: current.fingerprint,
        expectedRevision,
        expectedDownloadRevision,
        footer: scanned.footer,
      });
      if (completed.stale)
        throw new Error(completed.error || 'The archive changed before restore finished. Review this file again.');
      job = completed.job;
      setText('#recoveryCountNew', Number(job.importedCount || 0).toLocaleString());
      setText('#recoveryCountSame', Number(job.identicalCount || 0).toLocaleString());
      setText('#recoveryCountConflicts', Number(job.conflictCount || 0).toLocaleString());
      setText('#recoveryCountAssets', Number(current.countsByStore.assets || 0).toLocaleString());
      $('#archiveRecoveryNotice').hidden = !job.conflictCount;
      if (job.conflictCount)
        setText(
          '#archiveRecoveryNotice',
          'Both versions are saved as conflict evidence. Nothing already in your archive was overwritten or moved out of Trash.'
        );
      conflictButton.hidden = !job.conflictCount;
      if (dialogConflictButton) dialogConflictButton.hidden = !job.conflictCount;
      if (dialogAssetsButton) dialogAssetsButton.hidden = !(job.assetReferenceCount > 0);
      if (externalAssetsButton) externalAssetsButton.hidden = dialogAssetsButton?.hidden !== false;
      applyButton.disabled = true;
      applyButton.textContent = 'Restore complete';
      setProgress(
        `Restored ${job.importedCount.toLocaleString()} new records · ${job.conflictCount.toLocaleString()} conflicts retained`,
        1
      );
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
    try {
      writer = await makeWriter(`xvault-recovery-conflicts-${new Date().toISOString().slice(0, 10)}.jsonl`, {
        description: 'XVault conflict evidence',
        mime: 'application/x-ndjson',
        extension: '.jsonl',
      });
    } catch (error) {
      if (error?.name !== 'AbortError') status.textContent = error?.message || String(error);
      return;
    }
    const controller = new AbortController();
    openDialog('Export conflict evidence', 'Saving both local and incoming versions as reviewable JSON Lines.');
    startOperation(controller);
    operation = 'conflicts';
    let count = 0,
      bytes = 0,
      afterKey = null;
    const write = async value => {
      if (controller.signal.aborted) throw controller.signal.reason;
      await writer.write(value);
      bytes += encoderLength(value);
    };
    try {
      await write(
        encodeRecoveryLine({
          type: 'header',
          format: 'xvault-recovery-conflicts',
          version: 1,
          importId: preview.importId,
          exportedAt: new Date().toISOString(),
        })
      );
      let hasMore = true;
      while (hasMore) {
        const page = await request('READ_RECOVERY_IMPORT_CONFLICTS', {
          importId: preview.importId,
          afterKey,
          limit: 50,
        });
        for (const row of page.rows || []) {
          await write(encodeRecoveryLine({ type: 'conflict', ...row }));
          count++;
        }
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
    } catch (error) {
      try {
        await writer.abort(error);
      } catch {}
      showError(error);
    } finally {
      operation = null;
      finishOperation(controller);
    }
  }

  async function exportAssetManifest() {
    if (!preview?.importId) return;
    let writer;
    try {
      writer = await makeWriter(`xvault-local-file-manifest-${new Date().toISOString().slice(0, 10)}.jsonl`, {
        description: 'XVault local file manifest',
        mime: 'application/x-ndjson',
        extension: '.jsonl',
      });
    } catch (error) {
      if (error?.name !== 'AbortError') status.textContent = error?.message || String(error);
      return;
    }
    const controller = new AbortController();
    openDialog(
      'Export local file manifest',
      'Saving portable filename, size, digest, media identity, and verification state. Machine-specific paths and signed URLs are excluded.'
    );
    startOperation(controller);
    operation = 'assets';
    let count = 0,
      bytes = 0,
      afterKey = null,
      hasMore = true;
    const write = async value => {
      if (controller.signal.aborted) throw controller.signal.reason;
      await writer.write(value);
      bytes += encoderLength(value);
    };
    try {
      await write(
        encodeRecoveryLine({
          type: 'header',
          format: 'xvault-local-file-manifest',
          version: 1,
          importId: preview.importId,
          exportedAt: new Date().toISOString(),
        })
      );
      while (hasMore) {
        const page = await request('READ_RECOVERY_ASSET_REFERENCES', {
          importId: preview.importId,
          afterKey,
          limit: 100,
        });
        for (const value of page.rows || []) {
          await write(encodeRecoveryLine({ type: 'asset', ...value }));
          count++;
        }
        afterKey = page.nextKey;
        hasMore = !!page.hasMore;
        setProgress(`Saved ${count.toLocaleString()} file references · ${bytesLabel(bytes)}`);
      }
      await write(encodeRecoveryLine({ type: 'end', records: count }));
      await writer.close();
      setProgress(`Saved ${count.toLocaleString()} file references · ${bytesLabel(bytes)}`, 1);
      status.textContent = `File manifest saved · ${count.toLocaleString()} references. Paths and signed URLs were excluded.`;
      if (dialogAssetsButton) dialogAssetsButton.hidden = false;
    } catch (error) {
      try {
        await writer.abort(error);
      } catch {}
      showError(error);
    } finally {
      operation = null;
      finishOperation(controller);
    }
  }

  $('#recoveryExport')?.addEventListener('click', exportRecoveryFile);
  $('#export')?.addEventListener('click', exportRecoveryFile);
  $('#csv')?.addEventListener('click', exportArchiveCsv);
  $('#exportMarkdown')?.addEventListener('click', exportArchiveMarkdown);
  $('#exportHtml')?.addEventListener('click', exportArchiveHtml);
  $('#exportThreadsMarkdown')?.addEventListener('click', () => exportThreads('markdown'));
  $('#exportThreadsHtml')?.addEventListener('click', () => exportThreads('html'));
  window.XVaultCreateRecoveryFile = exportRecoveryFile;
  $('#recoveryImport')?.addEventListener('click', () => fileInput.click());
  // Encrypted backups are decrypted in memory first; the decrypted JSONL then follows the normal preview.
  const askPassphrase = name =>
    new Promise(resolve => {
      const ask = document.createElement('dialog');
      ask.className = 'xv-sheet xv-l3-dialog is-compact';
      ask.setAttribute('aria-labelledby', 'xvDecryptTitle');
      ask.innerHTML = `<form method="dialog"><header><h2 id="xvDecryptTitle">Unlock encrypted backup</h2></header><p class="xv-l3-hint"></p><label class="xv-field"><span>Passphrase</span><input type="password" name="passphrase" autocomplete="current-password" required minlength="8"></label><footer><button type="button" class="quiet" value="cancel" data-cancel>Cancel</button><button type="submit" class="primary" value="ok">Unlock</button></footer></form>`;
      ask.querySelector('.xv-l3-hint').textContent =
        `${name} is protected with a passphrase. Nothing is uploaded; decryption happens on this device.`;
      document.body.append(ask);
      const finish = value => {
        ask.close();
        ask.remove();
        resolve(value);
      };
      ask.querySelector('[data-cancel]').onclick = () => finish(null);
      ask.addEventListener('cancel', () => finish(null));
      ask.querySelector('form').onsubmit = event => {
        event.preventDefault();
        finish(ask.querySelector('input').value);
      };
      ask.showModal();
      ask.querySelector('input').focus();
    });
  async function openRecoveryFile(file) {
    if (!(await isEncryptedBackup(file).catch(() => false))) return previewRecoveryFile(file);
    for (;;) {
      const passphrase = await askPassphrase(file.name);
      if (passphrase == null) return;
      try {
        status.textContent = 'Decrypting backup…';
        const plain = await decryptBackup(file, passphrase);
        status.textContent = '';
        return previewRecoveryFile(
          new File([plain], file.name.replace(/\.xvenc$/i, '') || 'xvault-recovery.jsonl', {
            type: 'application/x-ndjson',
          })
        );
      } catch (error) {
        status.textContent = error?.message || String(error);
        if (!/passphrase/i.test(status.textContent)) return;
      }
    }
  }
  window.XVaultOpenRecoveryFile = openRecoveryFile;
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0] || null;
    fileInput.value = '';
    if (file) void openRecoveryFile(file);
  });
  applyButton.addEventListener('click', () => {
    if (operation === 'preview') return;
    if (activeFile && preview) void applyRecoveryFile();
  });
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
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    cancel();
  });
}
