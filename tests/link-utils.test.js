/* Run: node tests/link-utils.test.js */
const fs = require('fs');
const vm = require('vm');
const context = { window: {}, URL, location: { href: 'https://x.com/home' } };
vm.createContext(context);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'link-utils.js'), 'utf8'), context);
const links = context.XVaultLinks || context.window.XVaultLinks;
const base = { linkProvider: 'fixvx', copyStripTracking: true, copyPreserveQuery: false };
const cases = [
  ['FixVX default', 'https://x.com/alice/status/123?utm_source=x', undefined, 'https://fixvx.com/alice/status/123'],
  ['FixupX', 'https://twitter.com/alice/status/123', 'fixupx', 'https://fixupx.com/alice/status/123'],
  ['FxTwitter', 'https://x.com/alice/status/123', 'fxtwitter', 'https://fxtwitter.com/alice/status/123'],
  ['VXTwitter', 'https://x.com/alice/status/123', 'vxtwitter', 'https://vxtwitter.com/alice/status/123'],
  ['X', 'https://twitter.com/alice/status/123', 'x', 'https://x.com/alice/status/123'],
  ['Twitter', 'https://x.com/alice/status/123', 'twitter', 'https://twitter.com/alice/status/123'],
];
for (const [name, input, provider, expected] of cases) {
  const actual = links.transform(input, base, provider);
  if (actual !== expected) throw Error(`${name}: ${actual} !== ${expected}`);
}
const preserved = links.transform('https://x.com/alice/status/123?ref=x&lang=en', { ...base, copyPreserveQuery: true });
if (preserved !== 'https://fixvx.com/alice/status/123?lang=en') throw Error('Relevant query preservation failed');
const allQuery = links.transform('https://x.com/alice/status/123?lang=en&utm_source=x', {
  ...base,
  copyStripTracking: false,
});
if (allQuery !== 'https://fixvx.com/alice/status/123?lang=en&utm_source=x')
  throw Error('Explicit query preservation failed');
if (
  links.transform('https://x.com/alice/status/123', { ...base, customLinkHost: 'http://unsafe.example' }, 'custom') !==
  null
)
  throw Error('Insecure custom host accepted');
console.log('link-utils: 9 tests passed');
