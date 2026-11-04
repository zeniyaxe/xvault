// Encrypted backups (XVault 20). A passphrase-protected container for recovery files:
//   "XVENC1\n" | u32 header length | header JSON | frames…
//   frame = u32 ciphertext length | AES-256-GCM ciphertext (+16-byte tag)
// The key comes from PBKDF2-SHA-256 (600,000 iterations by default) over a random 16-byte salt.
// Every frame uses a unique IV (8 random prefix bytes + u32 frame index) and binds its index and a
// "final" flag as additional authenticated data, so reordered, dropped or truncated frames fail to
// decrypt instead of silently producing a shorter backup. Plaintext is processed 1 MiB at a time.
const MAGIC = new TextEncoder().encode('XVENC1\n');
export const BACKUP_EXTENSION = '.xvenc';
const CHUNK = 1024 * 1024;
const subtle = () => {
  const api = globalThis.crypto?.subtle;
  if (!api) throw Error('Encrypted backups need Web Crypto (a secure extension page)');
  return api;
};
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = text => Uint8Array.from(atob(String(text || '')), char => char.charCodeAt(0));
const aad = (index, final) => new TextEncoder().encode(`xvault-backup|v1|${index}|${final ? 1 : 0}`);
const ivFor = (prefix, index) => {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, index, false);
  return iv;
};

export async function deriveBackupKey(passphrase, salt, iterations) {
  if (String(passphrase || '').length < 8) throw Error('Use a passphrase of at least 8 characters');
  const material = await subtle().importKey('raw', new TextEncoder().encode(String(passphrase)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Starts an encrypted container; returns { header, encrypt(plain, final) → frame bytes }. */
export async function createBackupEncryptor(passphrase, { iterations = 600000, meta = {} } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    prefix = crypto.getRandomValues(new Uint8Array(8)),
    key = await deriveBackupKey(passphrase, salt, iterations);
  const json = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      app: 'XVault',
      kdf: 'PBKDF2-SHA-256',
      iterations,
      salt: b64(salt),
      prefix: b64(prefix),
      cipher: 'AES-256-GCM',
      chunk: CHUNK,
      createdAt: new Date().toISOString(),
      meta: meta && typeof meta === 'object' ? meta : {},
    })
  );
  const header = new Uint8Array(MAGIC.length + 4 + json.length);
  header.set(MAGIC, 0);
  new DataView(header.buffer).setUint32(MAGIC.length, json.length, false);
  header.set(json, MAGIC.length + 4);
  let index = 0,
    finished = false;
  return {
    header,
    async encrypt(plain, final = false) {
      if (finished) throw Error('This backup is already finalised');
      if (index >= 0xffffffff) throw Error('Backup is too large');
      const sealed = new Uint8Array(
        await subtle().encrypt(
          { name: 'AES-GCM', iv: ivFor(prefix, index), additionalData: aad(index, final) },
          key,
          plain
        )
      );
      index++;
      finished = final;
      const frame = new Uint8Array(4 + sealed.length);
      new DataView(frame.buffer).setUint32(0, sealed.length, false);
      frame.set(sealed, 4);
      return frame;
    },
  };
}

/**
 * Wraps an export writer ({ write, close, abort }) so everything written to it is encrypted.
 * Accepts strings or bytes; key derivation happens on first use (after any save picker opened).
 */
export function encryptingWriter(inner, passphrase, options = {}) {
  let encryptor = null,
    buffer = new Uint8Array(CHUNK),
    used = 0,
    written = 0;
  const encoder = new TextEncoder();
  async function ready() {
    if (!encryptor) {
      encryptor = await createBackupEncryptor(passphrase, options);
      await inner.write(encryptor.header);
      written += encryptor.header.length;
    }
    return encryptor;
  }
  async function emit(final) {
    const frame = await (await ready()).encrypt(buffer.slice(0, used), final);
    used = 0;
    await inner.write(frame);
    written += frame.length;
  }
  return {
    streaming: inner.streaming,
    get bytesWritten() {
      return written;
    },
    async write(value) {
      let bytes = typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
      await ready();
      while (bytes.length) {
        const take = Math.min(CHUNK - used, bytes.length);
        buffer.set(bytes.subarray(0, take), used);
        used += take;
        bytes = bytes.subarray(take);
        if (used === CHUNK) await emit(false);
      }
    },
    async close() {
      await emit(true);
      buffer = null;
      await inner.close();
    },
    abort: reason => {
      buffer = null;
      return inner.abort(reason);
    },
  };
}

export async function isEncryptedBackup(blob) {
  if (!blob || blob.size < MAGIC.length) return false;
  const head = new Uint8Array(await blob.slice(0, MAGIC.length).arrayBuffer());
  return head.every((value, index) => value === MAGIC[index]);
}

/** Reads the public header (no passphrase needed). */
export async function readBackupHeader(blob) {
  if (!(await isEncryptedBackup(blob))) throw Error('Not an encrypted XVault backup');
  const lengthBytes = new Uint8Array(await blob.slice(MAGIC.length, MAGIC.length + 4).arrayBuffer()),
    length = new DataView(lengthBytes.buffer).getUint32(0, false);
  if (length > 64 * 1024) throw Error('Damaged backup header');
  const header = JSON.parse(
    new TextDecoder().decode(await blob.slice(MAGIC.length + 4, MAGIC.length + 4 + length).arrayBuffer())
  );
  if (header.v !== 1 || header.cipher !== 'AES-256-GCM') throw Error('This backup was made by a newer XVault');
  return { header, offset: MAGIC.length + 4 + length };
}

/** Decrypts an encrypted backup Blob into a plaintext Blob. Wrong passphrase or tampering throws. */
export async function decryptBackup(blob, passphrase, { onProgress = () => {} } = {}) {
  const { header, offset } = await readBackupHeader(blob);
  const iterations = Math.max(1000, Math.min(10_000_000, Number(header.iterations) || 600000));
  const key = await deriveBackupKey(passphrase, unb64(header.salt), iterations),
    prefix = unb64(header.prefix),
    parts = [];
  let at = offset,
    index = 0,
    final = false;
  while (at < blob.size) {
    if (final) throw Error('Unexpected data after the end of the backup');
    const length = new DataView(await blob.slice(at, at + 4).arrayBuffer()).getUint32(0, false);
    if (length < 16 || length > CHUNK + 16 || at + 4 + length > blob.size)
      throw Error('The backup is truncated or damaged');
    const sealed = new Uint8Array(await blob.slice(at + 4, at + 4 + length).arrayBuffer()),
      last = at + 4 + length >= blob.size;
    let plain;
    try {
      plain = await subtle().decrypt(
        { name: 'AES-GCM', iv: ivFor(prefix, index), additionalData: aad(index, last) },
        key,
        sealed
      );
    } catch {
      throw Error(
        index === 0
          ? 'Wrong passphrase, or the backup was modified'
          : 'The backup is damaged, truncated or was modified'
      );
    }
    parts.push(new Uint8Array(plain));
    final = last;
    at += 4 + length;
    index++;
    onProgress({ bytesRead: at, totalBytes: blob.size });
  }
  if (!final) throw Error('The backup is truncated');
  return new Blob(parts);
}
