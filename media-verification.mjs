const SIGNATURE_BYTES = 32;

function readSize(response) {
  const raw = response?.headers?.get?.('content-length');
  const size = Number(raw);
  return Number.isSafeInteger(size) && size >= 0 ? size : 0;
}

export async function readResponsePrefix(response, maxBytes = 262144) {
  const limit = Math.max(1, Math.min(262144, Math.floor(Number(maxBytes) || 1)));
  if (!response?.body || typeof response.body.getReader !== 'function') {
    throw new Error('Streaming file verification is unavailable');
  }
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) break;
      const chunk = value.subarray(0, Math.min(value.length, limit - size));
      chunks.push(chunk);
      size += chunk.length;
      if (chunk.length < value.length) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const prefix = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.length;
  }
  return prefix;
}

export async function readResponseBytesBounded(response, maxBytes) {
  const limit = Math.floor(Number(maxBytes));
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('A positive byte limit is required');
  if (!response?.body || typeof response.body.getReader !== 'function')
    throw new Error('Streaming media reads are unavailable');
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0,
    tooLarge = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) break;
      if (value.length > limit - size) {
        tooLarge = true;
        break;
      }
      chunks.push(value.slice());
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (tooLarge) return null;
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function signatureFormat(bytes) {
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  )
    return 'gif';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'webp';
  return '';
}

export async function verifyDerivativeResponse(response, format, descriptor = {}) {
  const label = String(format || '').toLowerCase();
  if (!['gif', 'webp'].includes(label))
    return { state: 'verification-unavailable', reason: 'Unsupported derivative format' };
  if (descriptor?.state === 'removed') return { state: 'removed', size: Number(descriptor.size) || null };
  if (!response?.ok)
    return {
      state: response?.status === 404 ? 'missing' : 'verification-unavailable',
      reason: `${label.toUpperCase()} output could not be opened`,
    };
  let prefix;
  try {
    prefix = await readResponsePrefix(response, SIGNATURE_BYTES);
  } catch {
    return { state: 'verification-unavailable', reason: 'Streaming file verification is unavailable' };
  }
  const actual = signatureFormat(prefix);
  const headerSize = readSize(response);
  const descriptorSize = Number(descriptor?.size);
  const size = Number.isSafeInteger(descriptorSize) && descriptorSize >= 0 ? descriptorSize : headerSize;
  if (size > 0 && size < 100)
    return { state: 'corrupt', reason: `${label.toUpperCase()} output is implausibly small`, size };
  if (actual && actual !== label)
    return {
      state: 'mismatch',
      reason: `${label.toUpperCase()} output has a ${actual.toUpperCase()} signature`,
      actual,
      size: size || null,
    };
  if (!actual)
    return {
      state: 'mismatch',
      reason: `${label.toUpperCase()} output has an unrecognized file signature`,
      size: size || null,
    };
  return { state: size >= 100 ? 'verified' : 'verified-with-warning', actual, size: size || null };
}
