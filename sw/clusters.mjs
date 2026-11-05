// XVault 21: topic clusters over the local meaning index (sw/semantic.mjs). Mini-batch k-means on the
// 128-dimension int8 post vectors (cosine, k-means++ seeding, deterministic seed), then each cluster is
// labelled with the distinctive words of its most central posts. Everything runs on this computer.
const DIM = 128;

function mulberry(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function dot(vectors, row, centroid, offset) {
  let sum = 0;
  const base = row * DIM;
  for (let d = 0; d < DIM; d++) sum += vectors[base + d] * centroid[offset + d];
  return sum;
}
function normalizeRow(target, offset) {
  let norm = 0;
  for (let d = 0; d < DIM; d++) norm += target[offset + d] ** 2;
  norm = Math.sqrt(norm);
  if (!norm) return false;
  for (let d = 0; d < DIM; d++) target[offset + d] /= norm;
  return true;
}

/** Suggested number of clusters for N posts. */
export function suggestK(count) {
  return Math.max(2, Math.min(40, Math.round(Math.sqrt(Math.max(1, count) / 3))));
}

/**
 * vectors: Int8Array N×128 (unit-ish rows). Returns { k, assignments: Int32Array, centroids: Float32Array k×128,
 * sizes, scores: Float32Array (similarity to own centroid) }.
 */
export function kmeans(vectors, count, { k = suggestK(count), iterations = 30, batch = 2048, seed = 7 } = {}) {
  k = Math.max(1, Math.min(k, count));
  const random = mulberry(seed),
    centroids = new Float32Array(k * DIM),
    usable = [];
  for (let row = 0; row < count; row++) {
    let any = 0;
    for (let d = 0; d < DIM && !any; d++) any = vectors[row * DIM + d];
    if (any) usable.push(row);
  }
  const assignments = new Int32Array(count).fill(-1),
    scores = new Float32Array(count);
  if (!usable.length) return { k: 0, assignments, centroids: new Float32Array(0), sizes: [], scores };
  k = Math.min(k, usable.length);
  // k-means++ seeding on a sample.
  const sample =
    usable.length > 20000 ? Array.from({ length: 20000 }, () => usable[Math.floor(random() * usable.length)]) : usable;
  const best = new Float32Array(sample.length).fill(Infinity);
  let first = sample[Math.floor(random() * sample.length)];
  for (let d = 0; d < DIM; d++) centroids[d] = vectors[first * DIM + d];
  normalizeRow(centroids, 0);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < sample.length; i++) {
      const distance = Math.max(0, 1 - dot(vectors, sample[i], centroids, (c - 1) * DIM) / 127);
      if (distance < best[i]) best[i] = distance;
      total += best[i] ** 2;
    }
    let pick = random() * total,
      chosen = sample[sample.length - 1];
    for (let i = 0; i < sample.length; i++) {
      pick -= best[i] ** 2;
      if (pick <= 0) {
        chosen = sample[i];
        break;
      }
    }
    for (let d = 0; d < DIM; d++) centroids[c * DIM + d] = vectors[chosen * DIM + d];
    normalizeRow(centroids, c * DIM);
  }
  const counts = new Float64Array(k);
  const nearest = row => {
    let bestCluster = 0,
      bestScore = -Infinity;
    for (let c = 0; c < k; c++) {
      const score = dot(vectors, row, centroids, c * DIM);
      if (score > bestScore) ((bestScore = score), (bestCluster = c));
    }
    return [bestCluster, bestScore / 127];
  };
  for (let iteration = 0; iteration < iterations; iteration++) {
    const size = Math.min(batch, usable.length);
    for (let i = 0; i < size; i++) {
      const row = usable.length <= batch ? usable[i] : usable[Math.floor(random() * usable.length)];
      const [cluster] = nearest(row);
      counts[cluster]++;
      const rate = 1 / counts[cluster],
        offset = cluster * DIM;
      for (let d = 0; d < DIM; d++)
        centroids[offset + d] += rate * (vectors[row * DIM + d] / 127 - centroids[offset + d]);
    }
    for (let c = 0; c < k; c++) normalizeRow(centroids, c * DIM);
  }
  const sizes = new Array(k).fill(0);
  for (const row of usable) {
    const [cluster, score] = nearest(row);
    assignments[row] = cluster;
    scores[row] = score;
    sizes[cluster]++;
  }
  return { k, assignments, centroids, sizes, scores };
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]{2,}/gu;
/**
 * Distinctive words per cluster: frequency among the cluster's central posts relative to the whole sample.
 * texts: Map(clusterIndex → string[]) ; stop: Set of words to skip.
 */
export function labelClusters(texts, { stop = new Set(), limit = 4 } = {}) {
  const global = new Map(),
    local = new Map();
  for (const [cluster, list] of texts) {
    const counts = new Map();
    for (const text of list) {
      const seen = new Set(
        String(text || '')
          .toLowerCase()
          .replace(/https?:\/\/\S+/g, ' ')
          .match(WORD) || []
      );
      for (const word of seen) {
        if (stop.has(word) || /^\d+$/.test(word)) continue;
        counts.set(word, (counts.get(word) || 0) + 1);
        global.set(word, (global.get(word) || 0) + 1);
      }
    }
    local.set(cluster, { counts, docs: list.length });
  }
  const totalDocs = [...local.values()].reduce((sum, entry) => sum + entry.docs, 0) || 1;
  const out = new Map();
  for (const [cluster, { counts, docs }] of local) {
    const ranked = [...counts]
      .filter(
        ([word, count]) => count >= Math.max(2, docs * 0.08) && (local.size < 3 || global.get(word) <= totalDocs * 0.5)
      )
      .map(([word, count]) => [
        word,
        (count / Math.max(1, docs)) * Math.log((totalDocs + 1) / (global.get(word) + 0.5)),
      ])
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([word]) => word);
    out.set(cluster, ranked);
  }
  return out;
}

/** Carries user-chosen names from a previous clustering to clusters with overlapping top words. */
export function carryNames(previous, next) {
  const used = new Set();
  return next.map(cluster => {
    let match = null,
      bestOverlap = 0;
    for (const old of previous || []) {
      if (!old.name || used.has(old.id)) continue;
      const a = new Set(old.terms || []),
        overlap =
          (cluster.terms || []).filter(term => a.has(term)).length /
          Math.max(1, new Set([...a, ...(cluster.terms || [])]).size);
      if (overlap > bestOverlap) ((bestOverlap = overlap), (match = old));
    }
    if (match && bestOverlap >= 0.4) {
      used.add(match.id);
      return { ...cluster, name: match.name };
    }
    return cluster;
  });
}
