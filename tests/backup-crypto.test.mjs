import assert from 'node:assert/strict';
import {
  BACKUP_EXTENSION,
  decryptBackup,
  encryptingWriter,
  isEncryptedBackup,
  readBackupHeader,
} from '../backup-crypto.mjs';

const ITERATIONS = 2000; // the product default is 600,000; tests only need the format.
async function encrypt(chunks, passphrase = 'correct horse battery', meta = { records: 3 }) {
  const parts = [];
  let closed = false;
  const writer = encryptingWriter(
    {
      write: async part => parts.push(new Uint8Array(part)),
      close: async () => (closed = true),
      abort: async () => {},
    },
    passphrase,
    { iterations: ITERATIONS, meta }
  );
  for (const chunk of chunks) await writer.write(chunk);
  await writer.close();
  assert.equal(closed, true);
  const blob = new Blob(parts);
  assert.equal(writer.bytesWritten, blob.size);
  return blob;
}

assert.equal(BACKUP_EXTENSION, '.xvenc');

// Round trip across several 1 MiB frames, mixing strings and bytes.
const big = new Uint8Array(2.5 * 1024 * 1024).map((_, index) => (index * 31) % 251);
const backup = await encrypt(['{"format":"xvault-recovery"}\n', big, 'tail']);
assert.equal(await isEncryptedBackup(backup), true);
assert.equal(await isEncryptedBackup(new Blob(['{"plain":true}'])), false);
const { header } = await readBackupHeader(backup);
assert.equal(header.cipher, 'AES-256-GCM');
assert.equal(header.iterations, ITERATIONS);
assert.equal(header.meta.records, 3, 'public metadata is readable without the passphrase');
assert.ok(
  !new TextDecoder().decode(await backup.arrayBuffer()).includes('xvault-recovery'),
  'content is not in the clear'
);
const plain = new Uint8Array(await (await decryptBackup(backup, 'correct horse battery')).arrayBuffer());
const expected = new Uint8Array([
  ...new TextEncoder().encode('{"format":"xvault-recovery"}\n'),
  ...big,
  ...new TextEncoder().encode('tail'),
]);
assert.equal(plain.length, expected.length);
assert.ok(plain.every((value, index) => value === expected[index]));

// Two encryptions of the same data differ (random salt and IV prefix).
const again = await encrypt(['same'], 'correct horse battery');
const twice = await encrypt(['same'], 'correct horse battery');
assert.notDeepEqual(new Uint8Array(await again.arrayBuffer()), new Uint8Array(await twice.arrayBuffer()));

// Wrong passphrase, short passphrase, tampering, truncation, frame removal and trailing data all fail loudly.
await assert.rejects(decryptBackup(backup, 'wrong horse battery'), /Wrong passphrase/);
await assert.rejects(encrypt(['x'], 'short'), /at least 8 characters/);
const bytes = new Uint8Array(await backup.arrayBuffer());
const tampered = bytes.slice();
tampered[tampered.length - 100] ^= 1;
await assert.rejects(decryptBackup(new Blob([tampered]), 'correct horse battery'), /damaged|modified/);
await assert.rejects(
  decryptBackup(new Blob([bytes.slice(0, bytes.length - 10)]), 'correct horse battery'),
  /truncated|damaged/
);
// Drop the final frame entirely: the remaining last frame was not sealed as final.
const { offset } = await readBackupHeader(backup);
const frames = [];
for (let at = offset; at < bytes.length;) {
  const length = new DataView(bytes.buffer, at, 4).getUint32(0, false);
  frames.push([at, at + 4 + length]);
  at += 4 + length;
}
assert.equal(frames.length, 3);
await assert.rejects(
  decryptBackup(new Blob([bytes.slice(0, frames[1][1])]), 'correct horse battery'),
  /damaged|truncated/
);
// Swap two frames.
const swapped = new Blob([
  bytes.slice(0, offset),
  bytes.slice(frames[1][0], frames[1][1]),
  bytes.slice(frames[0][0], frames[0][1]),
  bytes.slice(frames[2][0], frames[2][1]),
]);
await assert.rejects(decryptBackup(swapped, 'correct horse battery'), /Wrong passphrase|damaged|modified/);
await assert.rejects(
  decryptBackup(new Blob([bytes, new Uint8Array(40)]), 'correct horse battery'),
  /Unexpected data|damaged/
);
await assert.rejects(readBackupHeader(new Blob(['nope'])), /Not an encrypted XVault backup/);

// Empty plaintext still produces one authenticated final frame.
const empty = await encrypt([]);
assert.equal((await decryptBackup(empty, 'correct horse battery')).size, 0);

console.log('backup crypto tests passed');
