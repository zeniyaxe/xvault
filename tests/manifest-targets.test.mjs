import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TARGETS, manifestFor } from '../scripts/manifest-targets.mjs';

const base = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
assert.deepEqual(Object.keys(TARGETS), ['chrome', 'edge', 'firefox']);

const chrome = manifestFor(base, 'chrome');
assert.deepEqual(chrome.manifest, base, 'the Chrome build ships the reference manifest unchanged');
assert.notEqual(chrome.manifest, base, 'callers get a copy');

const edge = manifestFor(base, 'edge').manifest;
assert.equal(edge.background.service_worker, base.background.service_worker);
assert.deepEqual(edge.permissions, base.permissions);

const { manifest: firefox, notes } = manifestFor(base, 'firefox');
assert.equal(firefox.background.service_worker, undefined);
assert.deepEqual(firefox.background.scripts, [base.background.service_worker]);
for (const permission of ['offscreen', 'sidePanel', 'power', 'nativeMessaging'])
  assert.ok(!firefox.permissions.includes(permission), `${permission} is removed for Firefox`);
assert.ok(firefox.permissions.includes('storage') && firefox.permissions.includes('downloads'));
assert.ok(!firefox.host_permissions.some(host => host.startsWith('file:')));
assert.ok(firefox.browser_specific_settings.gecko.id.includes('@'));
assert.equal(firefox.minimum_chrome_version, undefined);
if (base.side_panel) {
  assert.equal(firefox.side_panel, undefined);
  assert.equal(firefox.sidebar_action.default_panel, base.side_panel.default_path);
}
assert.ok(notes.length >= 2 && notes.every(note => typeof note === 'string'));
assert.deepEqual(
  base.permissions,
  JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')).permissions
);
assert.throws(() => manifestFor(base, 'safari'), /Unknown target safari/);

console.log('manifest target tests passed');
