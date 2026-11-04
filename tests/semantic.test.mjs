import assert from 'node:assert/strict';
import {
  DIM,
  buildSemanticIndex,
  documentText,
  searchIndex,
  similarTo,
  stem,
  suggestTags,
  tokenize,
  upsertDocuments,
  vectorFor,
} from '../sw/semantic.mjs';

// A deterministic three-topic corpus: each post draws five words from its topic's vocabulary.
const topics = {
  cooking: ['recipe', 'dinner', 'garlic', 'oven', 'pasta', 'sauce', 'bake', 'kitchen', 'tomato', 'chef'],
  space: ['telescope', 'galaxy', 'nebula', 'orbit', 'planet', 'astronomy', 'stars', 'rocket', 'launch', 'moon'],
  cars: ['engine', 'turbo', 'racing', 'track', 'tyres', 'gearbox', 'horsepower', 'drift', 'garage', 'exhaust'],
};
let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const docs = [];
for (const [topic, words] of Object.entries(topics))
  for (let index = 0; index < 40; index++) {
    const picked = Array.from({ length: 5 }, () => words[Math.floor(random() * words.length)]);
    docs.push({ id: `${topic}-${index}`, text: `Today ${picked.join(' ')} thoughts` });
  }
const topicOf = id => id.split('-')[0];
const index = buildSemanticIndex(docs, { now: 5, revision: 9 });

// Tokenizer: URLs, mentions/hashtags markers and stop words go; CJK becomes overlapping bigrams.
assert.deepEqual(tokenize('The ovens are baking https://t.co/abc @chef #Recipes'), [
  'oven',
  'baking',
  'chef',
  'recipe',
]);
assert.deepEqual(tokenize('東京タワー'), ['東京', '京タ', 'タワ', 'ワー']);
assert.equal(stem('dishes'), 'dish');
assert.equal(stem('glass'), 'glass', 'double-s words are not plural');
assert.equal(stem('a1s'), 'a1s', 'tokens with digits are not stemmed');

// Index shape.
assert.equal(index.ids.length, docs.length);
assert.equal(index.vectors.length, docs.length * DIM);
assert.equal(index.builtAt, 5);
assert.equal(index.revision, 9);
assert.ok(index.terms.includes('dinner') && !index.terms.includes('today'), 'corpus-wide words are not vocabulary');

// Precision: every one of the top 20 results for a topic word belongs to that topic.
for (const [query, topic] of [
  ['dinner', 'cooking'],
  ['telescope', 'space'],
  ['gearbox', 'cars'],
]) {
  const hits = [...searchIndex(index, query)];
  assert.ok(hits.length >= 20, `${query} finds at least 20 posts`);
  assert.ok(
    hits.slice(0, 20).every(([id]) => topicOf(id) === topic),
    `${query}: top 20 are all ${topic}`
  );
  assert.ok(
    hits.every(([, score], position) => position === 0 || score <= hits[position - 1][1]),
    'scores are sorted descending'
  );
}

// Meaning, not keywords: "dinner" also finds cooking posts that never say "dinner".
const withoutWord = [...searchIndex(index, 'dinner')].filter(
  ([id]) => !docs.find(doc => doc.id === id).text.includes('dinner')
);
assert.ok(withoutWord.length >= 5, 'context vectors surface related posts without the query word');
assert.ok(withoutWord.every(([id]) => topicOf(id) === 'cooking'));

// Words the archive has never seen must not return random collisions.
assert.equal(searchIndex(index, 'quantum zebra').size, 0);
assert.equal(searchIndex(index, '').size, 0);
const rare = buildSemanticIndex([...docs, { id: 'rare-1', text: 'a zebra crossing near the kitchen' }]);
assert.deepEqual(
  [...searchIndex(rare, 'zebra')].map(([id]) => id),
  ['rare-1'],
  'an exact rare word still matches'
);

// Limit and exclusion.
assert.equal(searchIndex(index, 'galaxy', { limit: 3 }).size, 3);
assert.ok(!searchIndex(index, 'galaxy', { exclude: 'space-0' }).has('space-0'));

// Nearest neighbours stay on topic and never include the post itself.
const neighbours = similarTo(index, 'space-3', { limit: 10 });
assert.equal(neighbours.length, 10);
assert.ok(neighbours.every(hit => hit.id !== 'space-3' && topicOf(hit.id) === 'space'));
assert.deepEqual(similarTo(index, 'missing-id'), []);
assert.ok(vectorFor(index, 'cars-1') instanceof Int8Array);

// Incremental upserts embed new posts with the existing vocabulary and replace changed ones in place.
const updated = upsertDocuments(index, [
  { id: 'new-1', text: 'garlic pasta sauce in the oven' },
  { id: 'space-0', text: 'engine turbo drift on the track' },
]);
assert.equal(updated.ids.length, docs.length + 1);
assert.equal(updated.added, 1);
assert.equal(index.ids.length, docs.length, 'the original index is not mutated');
assert.ok(similarTo(updated, 'new-1', { limit: 5 }).every(hit => topicOf(hit.id) === 'cooking'));
assert.ok(similarTo(updated, 'space-0', { limit: 5 }).every(hit => topicOf(hit.id) === 'cars'));

// Tag suggestions: neighbour votes weighted by similarity, a bonus when the tag appears in the text,
// never the post's own tags, and weak votes are dropped.
assert.deepEqual(
  suggestTags({ text: 'pasta night with garlic', tags: ['Food'] }, [
    { score: 0.8, tags: ['food', 'pasta'] },
    { score: 0.5, tags: ['italian'] },
    { score: 0.1, tags: ['noise'] },
  ]),
  [
    { tag: 'pasta', confidence: 1 },
    { tag: 'italian', confidence: 0.5 },
  ]
);
assert.deepEqual(suggestTags({ text: 'x' }, []), []);

// Embedded text includes quotes, cards, alt text and OCR.
assert.equal(
  documentText({ text: 'a', quoted: { text: 'b' }, card: { title: 'c' }, media: [{ altText: 'd' }] }, 'e'),
  'a\nb\nc\nd\ne'
);

console.log('semantic tests passed');
