const assert = require('node:assert/strict');
const exporter = require('../link-export.js');

const sample = (id, handle = 'user') => ({ id: String(id), url: `https://x.com/${handle}/status/${id}`, author: { handle } });
assert.equal(exporter.formatLinks([], 5), '');
const urls = count => exporter.collectLinks(Array.from({length: count}, (_, i) => sample(i + 1))).links;
assert.equal(exporter.formatLinks(urls(1), 5), 'https://fixvx.com/user/status/1');
assert.equal(exporter.formatLinks(urls(5), 5).split('\n\n').length, 1);
assert.equal(exporter.formatLinks(urls(6), 5).split('\n\n').length, 2);
assert.equal(exporter.formatLinks(urls(10), 5).split('\n\n').length, 2);
assert.equal(exporter.formatLinks(urls(11), 5).split('\n\n').length, 3);
assert.equal(exporter.formatLinks(urls(2), 0).includes('\n\n'), false);
assert.equal(exporter.formatLinks(urls(6), 1).split('\n\n').length, 6);
assert.equal(exporter.formatLinks(urls(11), 10).split('\n\n').length, 2);
assert.equal(exporter.formatLinks(urls(2), null), 'https://fixvx.com/user/status/1\nhttps://fixvx.com/user/status/2');

const deduped = exporter.collectLinks([sample(1), sample(1), { url: 'https://x.com/user/status/2' }, { id: 'bad', url: 'https://x.com/nope' }], { linkProvider: 'fixupx' });
assert.equal(deduped.links.length, 1);
assert.equal(deduped.duplicates, 1);
assert.equal(deduped.skipped, 2);
assert.equal(deduped.links[0], 'https://fixupx.com/user/status/1');
const recoveredDuplicate = exporter.collectLinks([{ id: '12', url: 'invalid' }, sample(12)]);
assert.equal(recoveredDuplicate.links[0], 'https://fixvx.com/user/status/12');
assert.equal(recoveredDuplicate.skipped, 1);
assert.equal(exporter.collectLinks([sample(2)], { linkProvider: 'custom', customLinkHost: 'bad host' }).skipped, 1);
assert.equal(exporter.collectLinks([sample(6)], { linkProvider: 'custom', customLinkHost: 'https://links.example/path' }).links[0], 'https://links.example/user/status/6');
const canonicalProvider = {
  status: url => { const match = new URL(url).pathname.match(/\/status\/(\d+)/); return match ? { id: match[1] } : null; },
  transform: (url, settings) => url.replace('x.com', settings.linkProvider === 'fixupx' ? 'fixupx.com' : 'fixvx.com')
};
assert.equal(exporter.canonicalLink(sample(7), { linkProvider: 'fixupx' }, canonicalProvider), 'https://fixupx.com/user/status/7');
assert.equal(exporter.canonicalLink(sample(8), {}, { status: () => ({ id: '9' }), transform: () => 'https://fixvx.com/user/status/8' }), null);
assert.equal(exporter.sanitizeFilename('cats/filter:*? "media"', 284), 'cats filter media — 284 posts.txt');
assert.match(exporter.sanitizeFilename('猫の写真 '.repeat(80), 2), /— 2 posts\.txt$/);
assert.ok(exporter.sanitizeFilename('猫の写真 '.repeat(80), 2).length <= 180);
assert.equal(exporter.collectLinks([sample(3), sample(1), sample(2)]).links[0], 'https://fixvx.com/user/status/3');
assert.equal(exporter.collectLinks([sample(1)], { linkProvider: 'custom', customLinkHost: 'links.example' }).links[0], 'https://links.example/user/status/1');

for (const count of [0, 1, 5, 6, 10, 11, 50000]) {
  const result = exporter.collectLinks(Array.from({length: count}, (_, index) => sample(index + 1)));
  assert.equal(result.links.length, count);
}

const scopeRows = [sample(1), sample(2), sample(3)];
assert.deepEqual(exporter.selectScope(scopeRows, 'all').map(post => post.id), ['1', '2', '3']);
assert.deepEqual(exporter.selectScope(scopeRows, 'selected', new Set(['3', '1'])).map(post => post.id), ['1', '3']);
assert.deepEqual(exporter.selectScope(scopeRows, 'page', [], [scopeRows[1]]).map(post => post.id), ['2']);
const cancelled = new AbortController(); cancelled.abort();
assert.throws(() => exporter.collectLinks([sample(1)], {}, cancelled.signal), /cancel/i);
console.log('link exporter: formatting, identity, provider, filename and bounded large input passed');
