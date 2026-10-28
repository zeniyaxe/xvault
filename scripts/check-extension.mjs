// Static integrity check for the unpacked extension: every file the browser will try to load must exist,
// module imports must resolve, and version numbers must agree. Runs in CI before lint/tests.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const problems = [];
const need = (file, from) => {
  const clean = normalize(file.replace(/^\//, '').split(/[?#]/)[0]);
  if (!existsSync(join(root, clean))) problems.push(`${from}: missing ${clean}`);
};

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.manifest_version !== 3) problems.push('manifest: manifest_version must be 3');
if (manifest.version !== pkg.version)
  problems.push(`version mismatch: manifest ${manifest.version} vs package ${pkg.version}`);
need(manifest.background.service_worker, 'manifest.background');
need(manifest.options_page, 'manifest.options_page');
need(manifest.side_panel.default_path, 'manifest.side_panel');
Object.values(manifest.icons).forEach(f => need(f, 'manifest.icons'));
Object.values(manifest.action.default_icon).forEach(f => need(f, 'manifest.action'));
for (const cs of manifest.content_scripts)
  [...(cs.js || []), ...(cs.css || [])].forEach(f => need(f, 'content_scripts'));
for (const war of manifest.web_accessible_resources) war.resources.forEach(f => need(f, 'web_accessible_resources'));
const perms = manifest.permissions;
if (new Set(perms).size !== perms.length) problems.push('manifest: duplicate permissions');

const sources = readdirSync(root).filter(f => /\.(m?js|html|css)$/.test(f) && f !== 'eslint.config.mjs');
for (const file of sources) {
  const text = readFileSync(join(root, file), 'utf8');
  const local = ref => ref && !/^(https?:|data:|blob:|chrome|#|\$\{)/.test(ref);
  if (file.endsWith('.html')) {
    for (const [, ref] of text.matchAll(/<(?:script|link|img)\b[^>]*?\s(?:src|href)="([^"]+)"/g))
      if (local(ref)) need(ref, file);
  }
  if (/\.m?js$/.test(file)) {
    for (const [, ref] of text.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g))
      need(join(dirname(file), ref), file);
    for (const [, ref] of text.matchAll(/(?:loadScript|importScripts|new Worker)\(\s*['"]([^'"]+\.m?js)['"]/g))
      need(ref, file);
    for (const [, ref] of text.matchAll(/\.src\s*=\s*['"]([\w./-]+\.m?js)['"]/g)) need(ref, file);
    for (const [, ref] of text.matchAll(/files:\s*\[\s*['"]([^'"]+)['"]/g)) need(ref, file);
  }
  if (file.endsWith('.css'))
    for (const [, ref] of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) if (local(ref)) need(ref, file);
}

if (problems.length) {
  console.error(`Extension check failed (${problems.length}):\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log(`Extension check passed: manifest v${manifest.version}, ${sources.length} source files verified.`);
