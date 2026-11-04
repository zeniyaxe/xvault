export const RECOVERY_FORMAT = 'xvault-recovery-jsonl';
export const RECOVERY_VERSION = 1;
export const RECOVERY_STORES = Object.freeze(['tweets', 'trash', 'revisions', 'assets']);
export const DEFAULT_MAX_RECOVERY_LINE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_RECOVERY_RECORDS = 5_000_000;

const encoder = new TextEncoder();
const keyFieldByStore = Object.freeze({ tweets: 'id', trash: 'id', revisions: 'key', assets: 'id' });
const ARCHIVE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function createRecoveryHeader({
  archiveId,
  archiveRevision = 0,
  downloadRevision = 0,
  exportedAt = new Date().toISOString(),
} = {}) {
  const id = String(
    archiveId || globalThis.crypto?.randomUUID?.() || `xv-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  if (!ARCHIVE_ID_PATTERN.test(id))
    throw new TypeError('Recovery archive ID contains unsupported characters or is too long');
  const revision = Number(archiveRevision);
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new TypeError('Recovery archive revision must be a nonnegative integer');
  const filesRevision = Number(downloadRevision);
  if (!Number.isSafeInteger(filesRevision) || filesRevision < 0)
    throw new TypeError('Recovery file-manifest revision must be a nonnegative integer');
  if (!Number.isFinite(Date.parse(exportedAt))) throw new TypeError('Recovery export time is invalid');
  return {
    type: 'header',
    format: RECOVERY_FORMAT,
    version: RECOVERY_VERSION,
    archiveId: id,
    exportedAt: new Date(exportedAt).toISOString(),
    archiveRevision: revision,
    downloadRevision: filesRevision,
    stores: [...RECOVERY_STORES],
  };
}

export function encodeRecoveryLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function abortIfNeeded(signal) {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new DOMException('Recovery file scan aborted', 'AbortError');
}

function updateHash(hash, bytes) {
  let value = hash;
  for (const byte of bytes) {
    value ^= byte;
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value;
}

function parseJsonLine(line, lineNumber, maxLineBytes) {
  const bytes = encoder.encode(line);
  if (bytes.byteLength > maxLineBytes)
    throw new RangeError(`Recovery line ${lineNumber} exceeds the ${maxLineBytes}-byte safety limit`);
  if (!line.trim()) throw new TypeError(`Recovery line ${lineNumber} is empty`);
  try {
    return { value: JSON.parse(line), bytes };
  } catch (error) {
    throw new SyntaxError(`Recovery line ${lineNumber} is not valid JSON: ${error.message}`);
  }
}

function validateHeader(value) {
  if (!value || value.type !== 'header' || value.format !== RECOVERY_FORMAT || value.version !== RECOVERY_VERSION) {
    throw new TypeError(`Unsupported recovery archive format; expected ${RECOVERY_FORMAT} v${RECOVERY_VERSION}`);
  }
  if (typeof value.archiveId !== 'string' || !ARCHIVE_ID_PATTERN.test(value.archiveId))
    throw new TypeError('Recovery archive ID is missing or invalid');
  if (!Number.isSafeInteger(value.archiveRevision) || value.archiveRevision < 0)
    throw new TypeError('Recovery archive revision is invalid');
  if (!Number.isSafeInteger(value.downloadRevision) || value.downloadRevision < 0)
    throw new TypeError('Recovery file-manifest revision is invalid');
  if (!Number.isFinite(Date.parse(value.exportedAt))) throw new TypeError('Recovery export time is invalid');
  if (
    !Array.isArray(value.stores) ||
    value.stores.length !== RECOVERY_STORES.length ||
    value.stores.some((store, index) => store !== RECOVERY_STORES[index])
  ) {
    throw new TypeError('Recovery archive store list is unsupported or out of order');
  }
  return value;
}

function validateRecord(value, state) {
  if (!value || value.type !== 'record' || !RECOVERY_STORES.includes(value.store))
    throw new TypeError('Recovery archive contains an unsupported store record');
  const storeIndex = RECOVERY_STORES.indexOf(value.store);
  if (storeIndex < state.storeIndex) throw new TypeError('Recovery records are not grouped in store order');
  if (storeIndex !== state.storeIndex) {
    state.storeIndex = storeIndex;
    state.lastKey = null;
  }
  const field = keyFieldByStore[value.store];
  if (
    typeof value.key !== 'string' ||
    !value.key ||
    value.key.length > 1024 ||
    !value.value ||
    typeof value.value !== 'object' ||
    Array.isArray(value.value)
  ) {
    throw new TypeError(`Recovery ${value.store} record is malformed`);
  }
  if (String(value.value[field] ?? '') !== value.key)
    throw new TypeError(`Recovery ${value.store} primary key does not match its record`);
  if (state.lastKey != null && value.key <= state.lastKey)
    throw new TypeError(
      `Recovery ${value.store} keys must be strictly increasing; duplicate or out-of-order key ${value.key}`
    );
  state.lastKey = value.key;
  return value;
}

/**
 * Read and validate a JSON Lines recovery file one record at a time. The
 * callback is awaited before the next record is read, so storage writes apply
 * backpressure to the file stream and callers never need to retain the archive.
 */
export async function scanRecoveryArchive(source, onRecord = async () => {}, options = {}) {
  if (typeof onRecord !== 'function') throw new TypeError('Recovery record callback must be a function');
  const maxLineBytes = Math.max(256, Math.floor(Number(options.maxLineBytes) || DEFAULT_MAX_RECOVERY_LINE_BYTES));
  const maxRecords = Math.max(1, Math.floor(Number(options.maxRecords) || DEFAULT_MAX_RECOVERY_RECORDS));
  const signal = options.signal;
  const stream = typeof source?.getReader === 'function' ? source : source?.stream?.();
  if (!stream || typeof stream.getReader !== 'function')
    throw new TypeError('Recovery source must be a File, Blob, or ReadableStream');
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '',
    lineNumber = 0,
    bytesRead = 0,
    hashA = 2166136261,
    hashB = 3339675911,
    header = null,
    footer = null,
    records = 0,
    ended = false;
  const state = { storeIndex: 0, lastKey: null };
  const feedLine = async rawLine => {
    abortIfNeeded(signal);
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const { value, bytes } = parseJsonLine(line, ++lineNumber, maxLineBytes);
    hashA = updateHash(hashA, bytes);
    hashB = updateHash(hashB, bytes);
    hashA = updateHash(hashA, Uint8Array.of(10));
    hashB = updateHash(hashB, Uint8Array.of(10));
    if (!header) {
      header = validateHeader(value);
      return;
    }
    if (ended) throw new TypeError('Recovery file contains data after its end record');
    if (value?.type === 'end') {
      if (!Number.isSafeInteger(value.recordCount) || value.recordCount !== records)
        throw new TypeError(`Recovery footer record count does not match (${records} records read)`);
      if (value.archiveRevision !== header.archiveRevision)
        throw new TypeError('Recovery footer revision does not match its header');
      if (value.downloadRevision !== header.downloadRevision)
        throw new TypeError('Recovery footer file-manifest revision does not match its header');
      footer = value;
      ended = true;
      return;
    }
    const record = validateRecord(value, state);
    if (++records > maxRecords) throw new RangeError(`Recovery archive exceeds the ${maxRecords}-record safety limit`);
    await onRecord(record, { records, bytesRead, lineNumber, header });
  };

  try {
    while (true) {
      abortIfNeeded(signal);
      const { value, done } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        await feedLine(line);
      }
      if (encoder.encode(buffer).byteLength > maxLineBytes)
        throw new RangeError(`Recovery line ${lineNumber + 1} exceeds the ${maxLineBytes}-byte safety limit`);
      options.onProgress?.({ bytesRead, totalBytes: Number(source?.size) || null, records, lineNumber });
    }
    buffer += decoder.decode();
    if (buffer) await feedLine(buffer);
    if (!header) throw new TypeError('Recovery file is empty');
    if (!footer) throw new TypeError('Recovery file is truncated; the final end record is missing');
    return {
      header,
      footer,
      records,
      bytesRead,
      // This deterministic dual 32-bit digest binds resumable checkpoints to
      // the same selected file. It is not an authenticity signature.
      fingerprint: `xvr1-${(hashA >>> 0).toString(16).padStart(8, '0')}${(hashB >>> 0).toString(16).padStart(8, '0')}`,
    };
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
}
