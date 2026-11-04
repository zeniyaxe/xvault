import assert from 'node:assert/strict';
import { readResponsePrefix, readResponseBytesBounded, verifyDerivativeResponse } from '../media-verification.mjs';

const signature = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
let pulls = 0, cancelled = false, blobReads = 0, fullReads = 0;
const body = new ReadableStream({
  pull(controller) {
    pulls++;
    const chunk = new Uint8Array(128 * 1024);
    chunk.set(signature);
    controller.enqueue(chunk);
  },
  cancel() { cancelled = true; },
}, { highWaterMark: 0 });
const hugeGifResponse = {
  ok: true, status: 200,
  headers: new Headers({ 'content-length': '5368709120' }),
  body,
  blob() { blobReads++; throw new Error('must not buffer the whole file'); },
  arrayBuffer() { fullReads++; throw new Error('must not buffer the whole file'); },
};

const prefix = await readResponsePrefix(hugeGifResponse, 32);
assert.equal(prefix.length, 32, 'the verifier retains only the requested signature prefix');
assert.equal(pulls, 1, 'the verifier cancels the stream after its first bounded read');
await new Promise(resolve => setImmediate(resolve));
assert.equal(cancelled, true);
assert.equal(blobReads + fullReads, 0, 'verification must not fall back to whole-file Blob or ArrayBuffer reads');

let oversizedCancelled = false, oversizedPulls = 0;
const oversized = {
  ok: true, status: 200, headers: new Headers(),
  body: new ReadableStream({
    pull(controller) { oversizedPulls++; controller.enqueue(new Uint8Array(1024)); },
    cancel() { oversizedCancelled = true; },
  }, { highWaterMark: 0 }),
  arrayBuffer() { throw new Error('bounded hashing cannot materialize oversized media'); },
};
assert.equal(await readResponseBytesBounded(oversized, 256), null, 'hashing declines a remote file as soon as the configured byte ceiling is crossed');
await new Promise(resolve => setImmediate(resolve));
assert.equal(oversizedPulls, 1);
assert.equal(oversizedCancelled, true);

const valid = await verifyDerivativeResponse({
  ok: true, status: 200, headers: new Headers({ 'content-length': '5368709120' }),
  body: new ReadableStream({ start(controller) { const bytes = new Uint8Array(32); bytes.set(signature); controller.enqueue(bytes); controller.close(); } }),
}, 'gif');
assert.equal(valid.state, 'verified');
assert.equal(valid.size, 5368709120);

const missing = await verifyDerivativeResponse({ ok: false, status: 404, headers: new Headers(), body: null }, 'webp');
assert.equal(missing.state, 'missing');
const removed = await verifyDerivativeResponse({ ok: true, status: 200, headers: new Headers(), body: null }, 'gif', { state: 'removed', size: 400 });
assert.equal(removed.state, 'removed');
const unstreamable = await verifyDerivativeResponse({ ok: true, status: 200, headers: new Headers(), body: null, blob() { throw new Error('no whole-file fallback'); } }, 'webp');
assert.equal(unstreamable.state, 'verification-unavailable');

console.log('bounded derivative verification reads a signature prefix and preserves missing/removed/unavailable states');
