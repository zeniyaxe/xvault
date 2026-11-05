// Packages the unpacked extension into dist/, excluding development-only files.
//   npm run build                      → dist/XVault-<version>.zip            (Chrome; the release artifact)
//   npm run build -- --target=edge     → dist/XVault-<version>-edge.zip       (Microsoft Edge Add-ons)
//   npm run build -- --target=firefox  → dist/XVault-<version>-firefox.zip    (experimental, see below)
//   npm run build -- --target=all      → all three
// Release archives are build artifacts (CI uploads them); they are never committed.
import { readFileSync, readdirSync, mkdirSync, rmSync, statSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { vendorOcr } from './vendor-ocr.mjs';
import { manifestFor, TARGETS } from './manifest-targets.mjs';

const root = new URL('..', import.meta.url).pathname;
const base = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const { version } = base;
const EXCLUDE = new Set([
  '.git',
  '.github',
  'node_modules',
  'dist',
  'output',
  'tests',
  'scripts',
  'package.json',
  'package-lock.json',
  'eslint.config.mjs',
  '.prettierrc.json',
  '.prettierignore',
  '.gitignore',
  'XVAULT_ROADMAP.md',
  '.editorconfig',
  '.local',
]);
const SKIP = [/\.log$/, /__pycache__/, /^FFmpeg_Helper\/config\.json$/, /^FFmpeg_Helper\/\.xvault/, /\.zip$/];

const wanted = (process.argv.find(arg => arg.startsWith('--target=')) || '--target=chrome').slice(9);
const targets = wanted === 'all' ? Object.keys(TARGETS) : wanted.split(',');
for (const target of targets)
  if (!TARGETS[target]) throw Error(`Unknown build target "${target}" (chrome, edge, firefox, all)`);

// The local OCR engine ships inside the ZIP; refresh it from node_modules when available.
vendorOcr({ quiet: true });

const files = [];
(function walk(dir) {
  for (const name of readdirSync(join(root, dir))) {
    const rel = dir ? `${dir}/${name}` : name;
    if (!dir && EXCLUDE.has(name)) continue;
    if (SKIP.some(re => re.test(rel))) continue;
    statSync(join(root, rel)).isDirectory() ? walk(rel) : files.push(rel);
  }
})('');

mkdirSync(join(root, 'dist'), { recursive: true });
for (const target of targets) {
  const out = join(root, 'dist', `XVault-${version}${TARGETS[target].suffix}.zip`);
  rmSync(out, { force: true });
  if (target === 'chrome') {
    execFileSync('zip', ['-q', '-X', out, ...files], { cwd: root });
  } else {
    // Other browsers get a transformed manifest; stage a copy so the source tree is untouched.
    const stage = join(root, 'dist', `.stage-${target}`);
    rmSync(stage, { recursive: true, force: true });
    for (const file of files) cpSync(join(root, file), join(stage, file), { recursive: true });
    const { manifest, notes } = manifestFor(base, target);
    writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync('zip', ['-q', '-X', '-D', '-r', out, '.'], { cwd: stage });
    rmSync(stage, { recursive: true, force: true });
    for (const note of notes) console.log(`  ${target}: ${note}`);
  }
  console.log(`Built ${out} (${files.length} files, ${(statSync(out).size / 1024).toFixed(0)} KiB)`);
}
