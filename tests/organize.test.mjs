import assert from 'node:assert/strict';
import {
  planRules,
  ruleIsSatisfied,
  rulePatch,
  sanitizeAutoTagRules,
  sanitizeBoards,
  slugId,
} from '../sw/organize.mjs';

assert.equal(slugId('Café Reading List!'), 'cafe-reading-list');
assert.equal(slugId('Art', new Set(['art', 'art-2'])), 'art-3');
assert.equal(slugId('***'), 'board');

// Boards: invalid entries dropped, ids made unique, unsafe fields cleaned, pinned first, order renumbered.
const boards = sanitizeBoards([
  { id: 'inspo', name: '  Inspiration ', color: '#AABBCC', cover: '123', order: 5 },
  { id: 'inspo', name: 'Duplicate id', color: 'red', cover: 'javascript:alert(1)', order: 1 },
  { name: '', id: 'empty' },
  null,
  'nope',
  { name: 'Pinned', pinned: true, order: 9, createdAt: 77, description: 'x'.repeat(500) },
]);
assert.deepEqual(
  boards.map(board => [board.id, board.name, board.order, board.pinned]),
  [
    ['pinned', 'Pinned', 0, true],
    ['duplicate-id', 'Duplicate id', 1, false],
    ['inspo', 'Inspiration', 2, false],
  ]
);
assert.equal(boards[1].color, '', 'non-hex colours are dropped');
assert.equal(boards[1].cover, '', 'covers must be post ids');
assert.equal(boards[2].color, '#AABBCC');
assert.equal(boards[0].description.length, 400);
assert.equal(boards[0].createdAt, 77);
assert.deepEqual(sanitizeBoards('x'), []);
assert.equal(sanitizeBoards(Array.from({ length: 300 }, (_, i) => ({ name: `b${i}` }))).length, 200);

// Rules: need a query and at least one action; tags are trimmed/deduped; labels and boards validated.
const rules = sanitizeAutoTagRules([
  {
    name: 'NASA video',
    query: 'from:nasa has:video',
    actions: { addTags: '#space, space , video', favorite: true, addBoards: ['inspo', 'bad id!'], colorLabel: 'blue' },
  },
  { query: 'is:thread', actions: { readLater: true }, enabled: false, onCapture: false, lastMatched: 3.7 },
  { query: 'nothing to do', actions: { colorLabel: 'pink' } },
  { query: '   ', actions: { favorite: true } },
]);
assert.equal(rules.length, 2);
assert.deepEqual(rules[0].actions, {
  addTags: ['space', 'video'],
  favorite: true,
  readLater: false,
  addBoards: ['inspo'],
  colorLabel: 'blue',
});
assert.equal(rules[0].id, 'nasa-video');
assert.equal(rules[0].enabled, true);
assert.equal(rules[1].name, 'is:thread');
assert.equal(rules[1].enabled, false);
assert.equal(rules[1].onCapture, false);
assert.equal(rules[1].lastMatched, 3);

assert.deepEqual(rulePatch(rules[0]), {
  addTags: ['space', 'video'],
  favorite: true,
  addBoards: ['inspo'],
  colorLabel: 'blue',
});
assert.deepEqual(rulePatch(rules[1]), { readLater: true });

// Idempotence: a post that already has everything the rule adds is "satisfied".
const done = {
  id: '1',
  userMeta: { tags: ['space', 'video', 'extra'], favorite: true, boards: ['inspo'], colorLabel: 'blue' },
};
const partial = { id: '2', userMeta: { tags: ['space'], favorite: true, boards: ['inspo'], colorLabel: 'blue' } };
assert.equal(ruleIsSatisfied(rules[0], done), true);
assert.equal(ruleIsSatisfied(rules[0], partial), false);
assert.equal(ruleIsSatisfied(rules[1], {}), false);

// Planning groups only posts that match and would change.
const posts = [done, partial, { id: '3', author: 'nasa' }, { id: '4', author: 'esa' }];
const plan = planRules(posts, rules, (post, rule) => (rule.id === 'nasa-video' ? post.id !== '4' : post.id === '4'));
assert.deepEqual(
  plan.map(entry => [entry.rule.id, entry.ids]),
  [
    ['nasa-video', ['2', '3']],
    ['is-thread', ['4']],
  ]
);
assert.deepEqual(
  planRules(posts, rules, () => false),
  []
);

console.log('organize tests passed');
