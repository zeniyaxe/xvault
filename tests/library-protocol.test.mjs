import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { collapseSource, compactSource, readSource } from './source-text.mjs';

// `python` may be the Microsoft Store stub on Windows (it exits non-zero); use whichever interpreter actually runs.
function python(code) {
  const candidates = [
    ['py', ['-3']],
    ['python3', []],
    ['python', []],
  ];
  let lastError;
  for (const [command, prefix] of candidates) {
    try {
      return execFileSync(command, [...prefix, '-c', code], {
        cwd: new URL('../', import.meta.url),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

const root = new URL('../', import.meta.url);
const dashboard = collapseSource(readSource('library-workspace.js'));
const worker = compactSource(readSource('background.js'));
const manifest = JSON.parse(readSource('manifest.json'));

assert.match(dashboard, /type: 'QUERY_LIBRARY_PAGE'/, 'the dashboard requests bounded Library pages');
assert.match(worker, /m\.type==='QUERY_LIBRARY_PAGE'/, 'the current worker must serve bounded Library pages');
assert.match(
  dashboard,
  /workerMismatch = \/unknown message\/i[\s\S]*Reload XVault extension/i,
  'an old worker response must offer an actionable extension reload instead of only a generic read error'
);
assert.equal(manifest.background.service_worker, 'background.js');

// Release archives are build artifacts (scripts/build.mjs → dist/XVault-<version>.zip); check one when it exists.
const archive = `dist/XVault-${manifest.version}.zip`;
if (!fs.existsSync(new URL(archive, root))) {
  console.log(`Library protocol: ${archive} not built; packaged-archive checks skipped (run npm run build first)`);
} else {
  const archiveEntries = JSON.parse(
    python(`import json,zipfile; print(json.dumps(zipfile.ZipFile(${JSON.stringify(archive)}).namelist()))`)
  );
  for (const required of [
    'background.js',
    'library-workspace.js',
    'library-plan-storage.mjs',
    'media-metadata.js',
    'workspace-model.js',
    'workspace-service.mjs',
    'xv-workspaces.js',
    'xv-motion.js',
    'vault-insights.mjs',
    'xv-atlas.js',
    'xv-reader.js',
    'xv-search-assist.js',
  ]) {
    assert.ok(
      archiveEntries.includes(required),
      `the installable package must contain current runtime file ${required}`
    );
  }
  assert.ok(
    !archiveEntries.some(path => /(^|\/)tests\//.test(path)),
    'the installable package must not ship the test harness'
  );
  const packagedWorker = compactSource(
    python(`import zipfile; print(zipfile.ZipFile(${JSON.stringify(archive)}).read("background.js").decode())`)
  );
  assert.match(
    packagedWorker,
    /m\.type==='QUERY_LIBRARY_PAGE'/,
    'the packaged worker must match the current dashboard protocol'
  );
}
console.log('Library protocol: bounded query handler and stale-worker recovery affordance passed');
