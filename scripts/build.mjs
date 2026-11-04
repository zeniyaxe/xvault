// Packages the unpacked extension into dist/XVault-<version>.zip, excluding development-only files.
// Release archives are build artifacts (CI uploads them); they are never committed.
import { readFileSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const EXCLUDE = new Set([
  '.git',
  '.github',
  'node_modules',
  'dist',
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
]);
const SKIP = [/\.log$/, /__pycache__/, /^FFmpeg_Helper\/config\.json$/, /^FFmpeg_Helper\/\.xvault/, /\.zip$/];

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
const out = join(root, 'dist', `XVault-${version}.zip`);
rmSync(out, { force: true });
execFileSync('zip', ['-q', '-X', out, ...files], { cwd: root });
console.log(`Built ${out} (${files.length} files, ${(statSync(out).size / 1024).toFixed(0)} KiB)`);
