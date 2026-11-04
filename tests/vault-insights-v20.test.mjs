import assert from 'node:assert/strict';
import { buildInsights } from '../vault-insights.mjs';

const at = iso => Date.parse(iso);
let next = 1;
const post = (handle, createdAt, extra = {}) => ({
  id: String(next++),
  author: { handle },
  text: 'x',
  createdAt,
  archivedAt: at('2026-03-01T12:00:00Z'),
  media: [],
  metrics: { likes: 10 },
  ...extra,
});
const posts = [
  post('ann', '2024-02-01T00:00:00Z', { hashtags: ['Art'], mentions: ['bob', 'ann'], media: [{ id: 'm1' }] }),
  post('ann', '2024-05-01T00:00:00Z', { hashtags: ['art'], mentions: ['bob'] }),
  post('bob', '2024-06-01T00:00:00Z', { mentions: ['ann', 'zed'], userMeta: { tags: ['keep'], readLater: true } }),
  post('cat', '2025-01-01T00:00:00Z', {
    hashtags: ['ml'],
    mentions: ['ann'],
    userMeta: { highlights: [{ text: 'a' }, { text: 'b' }], readAt: 5, boards: ['inspo'] },
  }),
  post('ann', '2025-07-01T00:00:00Z', { userMeta: { readLater: true, readAt: 9 } }),
];
const insights = buildInsights(posts, { now: at('2026-03-02T00:00:00Z'), timeZone: 'utc' });

assert.equal(insights.version, 2);
assert.deepEqual(
  insights.years.map(year => year.year),
  ['2026', '2025', '2024'],
  'newest year first (2026 holds the archive dates only)'
);
const byYear = Object.fromEntries(insights.years.map(year => [year.year, year]));
assert.equal(byYear['2026'].posted, 0);
assert.equal(byYear['2026'].archived, 5);
assert.equal(byYear['2024'].posted, 3);
assert.equal(byYear['2024'].media, 1);
assert.equal(byYear['2024'].likes, 30);
assert.equal(byYear['2024'].authors, 2);
assert.equal(byYear['2024'].newAuthors, 2, 'ann and bob first appear in 2024');
assert.equal(byYear['2025'].newAuthors, 1, 'only cat is new in 2025');
assert.equal(byYear['2025'].highlights, 2);
assert.deepEqual(byYear['2024'].hashtags, [{ key: 'art', count: 2 }], 'hashtags are case-folded per year');
assert.deepEqual(byYear['2024'].tags, [{ key: 'keep', count: 1 }]);
assert.deepEqual(byYear['2024'].topAuthors, [
  { key: 'ann', count: 2 },
  { key: 'bob', count: 1 },
]);

// Mention graph: only between archived authors, no self-loops, weights add up.
const edge = (from, to) => insights.graph.edges.find(entry => entry.from === from && entry.to === to);
assert.equal(edge('ann', 'bob').weight, 2);
assert.equal(edge('bob', 'ann').weight, 1);
assert.equal(edge('cat', 'ann').weight, 1);
assert.equal(edge('ann', 'ann'), undefined, 'self mentions are not edges');
assert.equal(edge('bob', 'zed'), undefined, 'people never archived are not nodes');
assert.deepEqual([...insights.graph.nodes].sort(), ['ann', 'bob', 'cat']);
assert.equal(insights.graph.edges[0].from, 'ann', 'heaviest edge first');

// Reading and organising totals.
assert.deepEqual(insights.reading, { later: 1, read: 2, highlights: 2, highlighted: 1, boarded: 1 });

console.log('vault insights v20 tests passed');
