const test = require('node:test');
const assert = require('node:assert/strict');
globalThis.location = { href: 'https://x.com/home' };
require('../link-utils.js');
const L = globalThis.XVaultLinks;

test('status parsing', () => {
  assert.deepEqual(
    { ...L.status('https://x.com/jack/status/20'), query: undefined },
    { handle: 'jack', id: '20', suffix: '', query: undefined }
  );
  assert.equal(L.status('https://x.com/jack'), null);
  assert.equal(L.status('/jack/status/20/photo/1').suffix, '/photo/1');
});

test('provider transforms strip tracking by default', () => {
  assert.equal(L.transform('https://x.com/jack/status/20?s=20&t=abc'), 'https://fixvx.com/jack/status/20');
  assert.equal(L.transform('https://twitter.com/jack/status/20', {}, 'x'), 'https://x.com/jack/status/20');
  assert.equal(
    L.transform('https://x.com/jack/status/20?s=1&lang=en', { copyPreserveQuery: true }),
    'https://fixvx.com/jack/status/20?lang=en'
  );
});

test('custom hosts must be plain https hostnames', () => {
  assert.equal(L.customHost('example.com'), 'example.com');
  assert.equal(L.customHost('http://example.com'), null);
  assert.equal(L.customHost('https://user:pw@example.com'), null);
  assert.equal(L.transform('https://x.com/a/status/1', { customLinkHost: '' }, 'custom'), null);
});
