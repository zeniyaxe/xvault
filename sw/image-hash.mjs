// Perceptual image fingerprints, computed locally from X CDN renditions.
//  - dHash: 9×8 grayscale, one bit per horizontal neighbour comparison (compatible with XVault 18).
//  - pHash: 32×32 grayscale → 2-D DCT-II → 8×8 low frequencies (minus DC) against their median.
// Both are 64-bit and stored as 16 hex characters so the Duplicate Lab can compare them quickly.

export const hex32 = value => (value >>> 0).toString(16).padStart(8, '0');
export const toHex = ([hi, lo]) => hex32(hi) + hex32(lo);
export const fromHex = text => [parseInt(text.slice(0, 8), 16) >>> 0, parseInt(text.slice(8, 16), 16) >>> 0];

export function grayscale(rgba) {
  const out = new Float64Array(rgba.length / 4);
  for (let index = 0; index < out.length; index++)
    out[index] = rgba[index * 4] * 0.299 + rgba[index * 4 + 1] * 0.587 + rgba[index * 4 + 2] * 0.114;
  return out;
}

function pushBits(bits) {
  let hi = 0,
    lo = 0;
  bits.forEach((bit, index) => {
    if (index < 32) hi = ((hi << 1) | bit) >>> 0;
    else lo = ((lo << 1) | bit) >>> 0;
  });
  return [hi, lo];
}

/** gray: 72 values (9 columns × 8 rows). */
export function dHash(gray) {
  const bits = [];
  for (let row = 0; row < 8; row++)
    for (let column = 0; column < 8; column++) bits.push(gray[row * 9 + column] > gray[row * 9 + column + 1] ? 1 : 0);
  return pushBits(bits);
}

const N = 32;
let cosine = null;
function cosineTable() {
  if (cosine) return cosine;
  cosine = new Float64Array(N * N);
  for (let k = 0; k < N; k++) for (let n = 0; n < N; n++) cosine[k * N + n] = Math.cos((Math.PI / N) * (n + 0.5) * k);
  return cosine;
}

/** gray: 1024 values (32 × 32). */
export function pHash(gray) {
  const table = cosineTable(),
    rows = new Float64Array(N * 8);
  // Separable DCT: transform rows, keeping only the 8 lowest frequencies, then columns.
  for (let y = 0; y < N; y++)
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < N; x++) sum += gray[y * N + x] * table[u * N + x];
      rows[y * 8 + u] = sum;
    }
  const low = new Float64Array(64);
  for (let v = 0; v < 8; v++)
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < N; y++) sum += rows[y * 8 + u] * table[v * N + y];
      low[v * 8 + u] = sum;
    }
  const ac = [...low.slice(1)].sort((a, b) => a - b),
    median = (ac[31] + ac[32]) / 2;
  return pushBits([...low].map((value, index) => (index === 0 ? 0 : value > median ? 1 : 0)));
}

export function popcount(value) {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return Math.imul((value + (value >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}
export const hamming = (a, b) => popcount((a[0] ^ b[0]) >>> 0) + popcount((a[1] ^ b[1]) >>> 0);

async function pixels(blob, width, height) {
  const bitmap = await createImageBitmap(blob, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
  try {
    const canvas = new OffscreenCanvas(width, height),
      context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, width, height);
    return context.getImageData(0, 0, width, height).data;
  } finally {
    bitmap.close?.();
  }
}

/** Decodes an image blob (any size) and returns both fingerprints as hex. */
export async function fingerprintBlob(blob) {
  const [small, large] = await Promise.all([pixels(blob, 9, 8), pixels(blob, N, N)]);
  return { h: toHex(dHash(grayscale(small))), p: toHex(pHash(grayscale(large))) };
}
