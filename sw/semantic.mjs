// Local meaning search (XVault 20).
//
// Random Indexing builds distributional word vectors from the archive's own text: every term gets a
// fixed sparse random "index vector", and its "context vector" is the sum of the index vectors of the
// words it shares posts with. A post's embedding mixes exact-term evidence (index vectors) with
// context evidence, so `about:cooking` also finds posts about recipes and dinner when those words keep
// company in this vault. No model download and no network: plain arithmetic, fully rebuildable.
export const SEMANTIC_VERSION = 1;
export const DIM = 128;
const NONZERO = 6;
const MAX_VOCAB = 30000;
const LEXICAL = 0.6;
const CONTEXT = 0.4;
const UNKNOWN_MINIMUM = 0.3;
// Context vectors are trained on every post up to this many, then on an even sample (every post is still
// embedded and searchable). Sampling earlier measurably hurts precision (see scripts/bench.mjs).
const TRAIN_MAX = 200000;
const YIELD_EVERY = 2000;

const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between
  both but by can could did do does doing down during each few for from further had has have having he her
  here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not
  now of off on once only or other our ours ourselves out over own same she should so some such than that the
  their theirs them themselves then there these they this those through to too under until up very was we were
  what when where which while who whom why will with would you your yours yourself yourselves rt amp https http
  co www com via im dont didnt doesnt isnt cant wont ive youre thats theres lol yeah oh ok okay also really
  get got gonna just even still much many lot let one two us its`.split(/\s+/)
);
const SPLIT = /[^\p{L}\p{N}_'’-]+/u;
const PUNCT = /[_'’-]/;
const EDGE = /^[_'’-]+|['’-]+$/g;
const POSSESSIVE = /['’]s$/;
const QUOTES = /['’]/g;
const DIGITS = /^\d+$/;
const WIDE = /[^\u0000-\u2e7f]/;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/** Light, language-agnostic-ish English suffix stripping; only has to be consistent, not correct. */
export function stem(word) {
  if (word.length <= 4 || /\d/.test(word)) return word;
  if (word.endsWith('ies') && word.length > 5) return `${word.slice(0, -3)}y`;
  if (word.endsWith('ing') && word.length > 6) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 5) return word.slice(0, -2);
  if (word.endsWith('ly') && word.length > 5) return word.slice(0, -2);
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function tokenize(text) {
  const clean = String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#$]/g, ' ');
  const terms = [];
  // One split instead of a match iterator, and the cheap tests first: tokenizing is a third of the
  // build time on a 100k-post archive.
  for (let word of clean.split(SPLIT)) {
    if (!word) continue;
    if (PUNCT.test(word)) {
      word = word.replace(POSSESSIVE, '').replace(EDGE, '');
      if (!word) continue;
    }
    if (WIDE.test(word) && CJK.test(word)) {
      // Scripts without spaces: overlapping character bigrams are a robust, dictionary-free unit.
      const chars = [...word];
      if (chars.length === 1) terms.push(word);
      for (let index = 0; index + 1 < chars.length; index++) terms.push(chars[index] + chars[index + 1]);
      continue;
    }
    if (word.length < 2 || word.length > 40) continue;
    const bare = word.includes("'") || word.includes('’') ? word.replace(QUOTES, '') : word;
    if (STOPWORDS.has(bare) || (bare.length < 4 && DIGITS.test(bare))) continue;
    terms.push(stem(bare));
  }
  return terms;
}

function hash32(text, seed = 2166136261) {
  let value = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
const ivCache = new Map();
/** Sparse ±1 index vector for a term: NONZERO (position, sign) pairs, deterministic across runs. */
function indexVector(term) {
  let vector = ivCache.get(term);
  if (vector) return vector;
  vector = new Int16Array(NONZERO);
  let state = hash32(term) || 1;
  for (let index = 0; index < NONZERO; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const position = state % DIM;
    vector[index] = (state >>> 16) & 1 ? position + 1 : -(position + 1);
  }
  if (ivCache.size > 200000) ivCache.clear();
  ivCache.set(term, vector);
  return vector;
}
const IV_NORM = 1 / Math.sqrt(NONZERO);
function addIndex(target, term, weight, offset = 0) {
  const vector = indexVector(term);
  for (let index = 0; index < NONZERO; index++) {
    const signed = vector[index];
    if (signed > 0) target[offset + signed - 1] += weight;
    else target[offset - signed - 1] -= weight;
  }
}
function normalize(vector, offset = 0, length = DIM) {
  let sum = 0;
  for (let index = 0; index < length; index++) sum += vector[offset + index] ** 2;
  const scale = sum > 0 ? 1 / Math.sqrt(sum) : 0;
  for (let index = 0; index < length; index++) vector[offset + index] *= scale;
  return sum > 0;
}
const counted = terms => {
  const counts = new Map();
  for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
  return counts;
};

/**
 * docs: [{ id, text }] → index { version, ids, vectors (Int8Array N×DIM), terms, idf, contexts (Int8Array V×DIM) }.
 * Cost is O(tokens × DIM). Written as a generator that pauses every YIELD_EVERY posts so the service
 * worker can keep answering messages during a large rebuild (see buildSemanticIndexAsync).
 */
function* buildSteps(docs, { now = Date.now(), revision = 0 } = {}) {
  const count = docs.length,
    termCounts = new Array(count),
    frequency = new Map();
  for (let index = 0; index < count; index++) {
    const counts = counted(tokenize(docs[index].text));
    termCounts[index] = counts;
    for (const term of counts.keys()) frequency.set(term, (frequency.get(term) || 0) + 1);
    if (index % YIELD_EVERY === YIELD_EVERY - 1) yield;
  }
  const minimum = count >= 400 ? 2 : 1,
    ceiling = count >= 30 ? count * 0.35 : Infinity;
  const vocabulary = [...frequency]
    .filter(([, df]) => df >= minimum && df <= ceiling)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_VOCAB);
  const terms = vocabulary.map(([term]) => term),
    lookup = new Map(terms.map((term, index) => [term, index])),
    idf = new Float32Array(terms.length),
    context = new Float32Array(terms.length * DIM),
    sum = new Float32Array(DIM),
    stride = Math.max(1, count / TRAIN_MAX);
  vocabulary.forEach(([, df], index) => (idf[index] = Math.log((count + 1) / (df + 0.5))));
  for (let step = 0, index = 0; index < count; step++, index = Math.floor(step * stride)) {
    const known = [];
    sum.fill(0);
    for (const term of termCounts[index].keys()) {
      const position = lookup.get(term);
      if (position === undefined) continue;
      known.push(position);
      addIndex(sum, term, idf[position]);
    }
    if (step % YIELD_EVERY === YIELD_EVERY - 1) yield;
    if (known.length < 2) continue;
    for (const position of known) {
      const offset = position * DIM;
      for (let d = 0; d < DIM; d++) context[offset + d] += sum[d];
      addIndex(context, terms[position], -idf[position], offset); // a word is not its own context
    }
  }
  const contexts = new Int8Array(terms.length * DIM);
  for (let position = 0; position < terms.length; position++) {
    const offset = position * DIM;
    if (!normalize(context, offset)) continue;
    for (let d = 0; d < DIM; d++) contexts[offset + d] = Math.round(context[offset + d] * 127);
  }
  const model = { version: SEMANTIC_VERSION, dim: DIM, terms, idf, contexts, documents: count, builtAt: now, revision };
  const ids = [],
    vectors = new Int8Array(count * DIM);
  const embedder = createEmbedder(model);
  for (let index = 0; index < count; index++) {
    ids.push(String(docs[index].id));
    embedder.embedCounts(termCounts[index], vectors, index * DIM);
    termCounts[index] = null;
    if (index % YIELD_EVERY === YIELD_EVERY - 1) yield;
  }
  return { ...model, ids, vectors };
}

export function buildSemanticIndex(docs, options) {
  const steps = buildSteps(docs, options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Same result as buildSemanticIndex, but gives the event loop a turn every few thousand posts. */
export async function buildSemanticIndexAsync(
  docs,
  options = {},
  pause = () => new Promise(resolve => setTimeout(resolve, 0))
) {
  const steps = buildSteps(docs, options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await pause();
  }
}

/** Shared by documents and queries so both sides land in the same space. */
export function createEmbedder(model) {
  const lookup = new Map(model.terms.map((term, index) => [term, index])),
    unknownIdf = Math.log((Number(model.documents || 0) + 1) / 1.5) || 1,
    scratch = new Float32Array(DIM),
    contexts = model.contexts,
    idf = model.idf;
  function embedCounts(counts, target, offset = 0) {
    scratch.fill(0);
    let used = 0;
    for (const [term, tf] of counts) {
      const position = lookup.get(term),
        weight = (tf === 1 ? 1 : 1 + Math.log(tf)) * (position === undefined ? unknownIdf : idf[position]);
      if (!(weight > 0)) continue;
      used++;
      addIndex(scratch, term, weight * LEXICAL * IV_NORM);
      if (position !== undefined) {
        const base = position * DIM,
          scale = (weight * CONTEXT) / 127;
        for (let d = 0; d < DIM; d++) scratch[d] += contexts[base + d] * scale;
      }
    }
    if (!used || !normalize(scratch)) {
      for (let d = 0; d < DIM; d++) target[offset + d] = 0;
      return false;
    }
    for (let d = 0; d < DIM; d++) target[offset + d] = Math.round(scratch[d] * 127);
    return true;
  }
  return {
    embedCounts,
    embedText(text) {
      const vector = new Int8Array(DIM);
      return embedCounts(counted(tokenize(text)), vector) ? vector : null;
    },
    /** How many of the text's terms the vocabulary knows (0 → only exact-term evidence is available). */
    knownTerms(text) {
      return tokenize(text).filter(term => lookup.has(term)).length;
    },
  };
}

/** Cosine scores (vectors are unit length × 127) against every document. */
export function scoreAll(index, query) {
  const scores = new Float32Array(index.ids.length),
    vectors = index.vectors;
  for (let row = 0, offset = 0; row < scores.length; row++, offset += DIM) {
    let dot = 0;
    for (let d = 0; d < DIM; d++) dot += vectors[offset + d] * query[d];
    scores[row] = dot / 16129;
  }
  return scores;
}

/**
 * Meaning search: ids whose score clears an adaptive floor (a fixed minimum, and a fraction of the best
 * hit so a strong match does not drag in noise). Returns Map id → score.
 */
export function searchIndex(index, text, { limit = 1500, minimum = 0.14, relative = 0.42, exclude = null } = {}) {
  let query = text;
  if (typeof text === 'string') {
    const embedder = createEmbedder(index);
    query = embedder.embedText(text);
    // Words the vocabulary has never seen carry only their random index vector; sparse collisions between
    // index vectors score up to ~0.15, so demand a clear exact-term match instead of returning noise.
    if (!embedder.knownTerms(text)) minimum = Math.max(minimum, UNKNOWN_MINIMUM);
  }
  const found = new Map();
  if (!query || !index.ids.length) return found;
  const scores = scoreAll(index, query);
  const order = [];
  for (let row = 0; row < scores.length; row++)
    if (scores[row] >= minimum && index.ids[row] !== exclude) order.push(row);
  order.sort((a, b) => scores[b] - scores[a]);
  const floor = Math.max(minimum, (scores[order[0]] || 0) * relative);
  for (const row of order.slice(0, limit)) {
    if (scores[row] < floor) break;
    found.set(index.ids[row], Math.round(scores[row] * 1000) / 1000);
  }
  return found;
}

export function vectorFor(index, id) {
  const row = index.ids.indexOf(String(id));
  if (row < 0) return null;
  const vector = index.vectors.subarray(row * DIM, row * DIM + DIM);
  return vector.some(Boolean) ? vector : null;
}

/** Nearest neighbours of an archived post (excluding itself). */
export function similarTo(index, id, { limit = 24, minimum = 0.2 } = {}) {
  const vector = vectorFor(index, id);
  if (!vector) return [];
  return [...searchIndex(index, vector, { limit, minimum, relative: 0, exclude: String(id) })].map(
    ([postId, score]) => ({ id: postId, score })
  );
}

/** Adds or replaces documents using the existing vocabulary (no re-training) — used between rebuilds. */
export function upsertDocuments(index, docs) {
  const embedder = createEmbedder(index),
    positions = new Map(index.ids.map((id, row) => [id, row])),
    fresh = docs.filter(doc => !positions.has(String(doc.id)));
  let vectors = index.vectors;
  if (fresh.length) {
    vectors = new Int8Array((index.ids.length + fresh.length) * DIM);
    vectors.set(index.vectors);
  }
  const ids = [...index.ids];
  for (const doc of docs) {
    const id = String(doc.id);
    let row = positions.get(id);
    if (row === undefined) {
      row = ids.length;
      ids.push(id);
      positions.set(id, row);
    }
    embedder.embedCounts(counted(tokenize(doc.text)), vectors, row * DIM);
  }
  return { ...index, ids, vectors, added: (index.added || 0) + fresh.length };
}

/**
 * Tag suggestions: weighted votes from the nearest tagged neighbours plus tags whose name appears in
 * the post itself. neighbours: [{ score, tags }].
 */
export function suggestTags({ text = '', tags = [] } = {}, neighbours = [], { limit = 6 } = {}) {
  const own = new Set(tags.map(tag => String(tag).toLowerCase())),
    words = new Set(tokenize(text)),
    votes = new Map();
  for (const { score, tags: theirs = [] } of neighbours)
    for (const tag of theirs) {
      const key = String(tag).toLowerCase();
      if (!key || own.has(key)) continue;
      votes.set(key, (votes.get(key) || 0) + Math.max(0, Number(score) || 0));
    }
  for (const key of votes.keys()) if (tokenize(key).some(term => words.has(term))) votes.set(key, votes.get(key) + 0.6);
  return [...votes]
    .filter(([, weight]) => weight >= 0.25)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag, weight]) => ({ tag, confidence: Math.min(1, Math.round(weight * 100) / 100) }));
}

/** Text used to embed a post: what it says, what it quotes, card text, alt text and recognised image text. */
export function documentText(post, ocrText = '') {
  const media = Array.isArray(post?.media) ? post.media : [];
  return [
    post?.text,
    post?.quoted?.text || post?.quote?.text,
    post?.card?.title,
    post?.card?.description,
    ...media.map(item => item?.altText || item?.alt || ''),
    ocrText,
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000);
}
