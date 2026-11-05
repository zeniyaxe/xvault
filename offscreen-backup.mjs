// Builds a recovery file in memory for scheduled backups (XVault 22). Chrome/Edge load this module into
// the offscreen document (a service worker has no URL.createObjectURL, and chrome.downloads needs a URL);
// Firefox imports it into its background event page and calls buildBackupBlob directly.
import { writeRecoveryBackup } from './recovery-backup-core.mjs';
import { encryptingWriter } from './backup-crypto.mjs';

const PART = 1024 * 1024;

/** Returns { blob, recordCount, archiveRevision, downloadRevision, bytes, encrypted }. */
export async function buildBackupBlob({ request, passphrase = '', meta = {}, signal } = {}) {
  const parts = [],
    encoder = new TextEncoder();
  let pending = [],
    pendingBytes = 0;
  const flush = () => {
    if (pending.length) parts.push(new Blob(pending));
    pending = [];
    pendingBytes = 0;
  };
  // Lines are coalesced into ~1 MiB Blob parts so a large archive is not millions of tiny arrays.
  const inner = {
    write: value => {
      const bytes = typeof value === 'string' ? encoder.encode(value) : value;
      pending.push(bytes);
      pendingBytes += bytes.byteLength;
      if (pendingBytes >= PART) flush();
    },
    close: () => flush(),
    abort: () => {
      parts.length = 0;
      pending = [];
    },
  };
  const writer = passphrase
    ? encryptingWriter(inner, passphrase, { meta: { contains: 'xvault-recovery-jsonl', ...meta } })
    : inner;
  try {
    const result = await writeRecoveryBackup({ request, signal, write: value => writer.write(value) });
    await writer.close();
    const blob = new Blob(parts, { type: passphrase ? 'application/octet-stream' : 'application/x-ndjson' });
    return { ...result, blob, bytes: blob.size, encrypted: !!passphrase };
  } catch (error) {
    await writer.abort?.(error);
    throw error;
  }
}

// Offscreen-document side: answer { target: 'xv-backup' } messages from the service worker.
if (globalThis.chrome?.runtime?.onMessage && /offscreen-ocr\.html$/.test(globalThis.location?.pathname || '')) {
  const urls = new Set();
  const request = async (type, payload = {}) => {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response || response.ok === false) throw Error(response?.error || 'XVault could not read the archive');
    return response;
  };
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.target !== 'xv-backup' || sender.id !== chrome.runtime.id) return;
    (async () => {
      if (message.action === 'release') {
        if (urls.delete(message.url)) URL.revokeObjectURL(message.url);
        return { ok: true };
      }
      if (message.action === 'busy') return { ok: true, busy: urls.size > 0 };
      if (message.action !== 'build') return { ok: false, error: 'Unknown backup action' };
      const { blob, ...built } = await buildBackupBlob({ request, passphrase: String(message.passphrase || '') });
      const url = URL.createObjectURL(blob);
      urls.add(url);
      return { ok: true, url, ...built };
    })().then(reply, error => reply({ ok: false, error: String(error?.message || error) }));
    return true;
  });
}
