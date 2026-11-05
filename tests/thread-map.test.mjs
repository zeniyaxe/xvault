// XVault 22: thread map layout — replies hang under their parent, the spine keeps lane 0, quotes link.
import assert from 'node:assert/strict';
import test from 'node:test';
await import('../thread-map.js');
const { layout, svg } = globalThis.XVaultThreadMap;

const post = (id, extra = {}) => ({ id, text: `post ${id}`, author: { handle: extra.handle || 'root' }, ...extra });

test('spine stays in lane 0 and replies branch by depth', () => {
  const map = layout([
    post('1', { spine: true }),
    post('2', { spine: true, replyToId: '1' }),
    post('3', { replyToId: '1', handle: 'ann' }),
    post('4', { replyToId: '3', handle: 'bob' }),
    post('5', { spine: true, replyToId: '2' }),
  ]);
  const at = id => map.nodes.find(node => node.id === id);
  assert.deepEqual(
    map.nodes.map(node => node.id),
    ['1', '2', '5', '3', '4'],
    'the spine reads straight down before branches'
  );
  assert.equal(at('5').lane, 0);
  assert.equal(at('3').lane, 1);
  assert.equal(at('4').lane, 2);
  assert.equal(at('4').parentId, '3');
  assert.equal(map.edges.filter(edge => edge.kind === 'reply').length, 4);
  assert.equal(map.lanes, 3);
});

test('quotes inside the conversation become links; missing parents become roots', () => {
  const map = layout([post('1', { spine: true }), post('2', { replyToId: '99', quotedPostId: '1', handle: 'q' })]);
  assert.equal(map.nodes.find(node => node.id === '2').parentId, null, 'an unarchived parent is not invented');
  assert.deepEqual(
    map.edges.filter(edge => edge.kind === 'quote'),
    [{ from: '2', to: '1', kind: 'quote' }]
  );
});

test('cycles and self-replies never loop; size is bounded', () => {
  const map = layout([post('1', { replyToId: '2' }), post('2', { replyToId: '1' }), post('3', { replyToId: '3' })]);
  assert.deepEqual(map.nodes.map(node => node.id).sort(), ['1', '2', '3'], 'posts in a reply cycle are still shown');
  assert.equal(new Set(map.nodes.map(node => node.id)).size, 3, 'each post appears once');
  const big = layout(
    Array.from({ length: 600 }, (_, index) => post(String(index + 1), { replyToId: index ? String(index) : null }))
  );
  assert.equal(big.nodes.length, 400);
  assert.equal(big.truncated, true);
  assert.ok(
    big.nodes.every(node => node.lane <= 6),
    'deep chains are capped to six lanes'
  );
});

test('svg escapes text and marks focus and hidden nodes', () => {
  const map = layout([post('1', { spine: true, text: '<b>"hi"</b>' }), post('2', { replyToId: '1', handle: 'x' })]);
  const markup = svg(map, { focusId: '1', visible: new Set(['1']) });
  assert.ok(!markup.includes('<b>'), 'post text is escaped');
  assert.match(markup, /class="tm-node is-spine is-focus"/);
  assert.match(markup, /class="tm-node is-reply is-hidden"/);
  assert.match(markup, /<text class="tm-label"[^>]*>@x<\/text>/, 'each node carries its handle');
  const long = svg(layout([post('9', { spine: true, handle: 'a_really_long_handle' })]));
  assert.match(long, />@a_really_lon…</, 'long handles are shortened');
});
