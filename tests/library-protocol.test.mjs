import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// `python` may be the Microsoft Store stub on Windows (it exits non-zero); use whichever interpreter actually runs.
function python(code) {
  const candidates = [['py', ['-3']], ['python3', []], ['python', []]];
  let lastError;
  for (const [command, prefix] of candidates) {
    try { return execFileSync(command, [...prefix, '-c', code], { cwd: new URL('../', import.meta.url), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

const root = new URL('../', import.meta.url);
const dashboard = fs.readFileSync(new URL('library-workspace.js', root), 'utf8');
const worker = fs.readFileSync(new URL('background.js', root), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8'));

assert.match(dashboard, /type: 'QUERY_LIBRARY_PAGE'/, 'the dashboard requests bounded Library pages');
assert.match(worker, /m\.type==='QUERY_LIBRARY_PAGE'/, 'the current worker must serve bounded Library pages');
assert.match(dashboard, /workerMismatch = \/unknown message\/i[\s\S]*Reload XVault extension/i,
  'an old worker response must offer an actionable extension reload instead of only a generic read error');
assert.equal(manifest.background.service_worker, 'background.js');
const archiveEntries = JSON.parse(python('import json,zipfile; print(json.dumps(zipfile.ZipFile("XVault.zip").namelist()))'));
for (const required of ['XVault/background.js', 'XVault/library-workspace.js', 'XVault/library-plan-storage.mjs', 'XVault/media-metadata.js', 'XVault/workspace-model.js','XVault/workspace-service.mjs','XVault/xv-workspaces.js','XVault/xv-motion.js']) {
  assert.ok(archiveEntries.includes(required), `the installable package must contain current runtime file ${required}`);
}
assert.ok(!archiveEntries.some(path => path.includes('/tests/')), 'the installable package must not ship the test harness');
const packagedWorker = python('import zipfile; print(zipfile.ZipFile("XVault.zip").read("XVault/background.js").decode())');
assert.match(packagedWorker, /m\.type==='QUERY_LIBRARY_PAGE'/, 'the packaged worker must match the current dashboard protocol');
console.log('Library protocol: bounded query handler and stale-worker recovery affordance passed');
