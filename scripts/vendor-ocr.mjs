// Copies the local OCR engine (tesseract.js worker + WebAssembly core + English model) out of
// node_modules into vendor/ocr/. XVault never downloads OCR code or language data at runtime:
// the extension only loads these packaged files through chrome.runtime.getURL().
// vendor/ is a build artifact (gitignored); `npm ci` runs this via postinstall and build.mjs re-runs it.
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const root = new URL('..', import.meta.url).pathname;
const require = createRequire(join(root, 'package.json'));
const out = join(root, 'vendor', 'ocr');

function resolvePackage(name) {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

export function vendorOcr({ quiet = false } = {}) {
  const tesseract = resolvePackage('tesseract.js'),
    core = resolvePackage('tesseract.js-core'),
    eng = resolvePackage('@tesseract.js-data/eng');
  if (!tesseract || !core || !eng) {
    if (!quiet)
      console.warn('OCR engine packages are not installed; skipping vendor/ocr (OCR will report "not installed").');
    return { ok: false, files: [] };
  }
  const files = [
    [join(tesseract, 'dist', 'tesseract.min.js'), 'tesseract.min.js'],
    [join(tesseract, 'dist', 'worker.min.js'), 'worker.min.js'],
    ...['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm'].flatMap(name => [
      [join(core, `${name}.wasm.js`), `core/${name}.wasm.js`],
    ]),
    [join(eng, '4.0.0_best_int', 'eng.traineddata.gz'), 'lang/eng.traineddata.gz'],
  ];
  for (const [from, to] of files) {
    if (!existsSync(from)) throw Error(`OCR asset missing: ${from}`);
    mkdirSync(dirname(join(out, to)), { recursive: true });
    copyFileSync(from, join(out, to));
  }
  const versions = {
    tesseract: require(join(tesseract, 'package.json')).version,
    core: require(join(core, 'package.json')).version,
    language: 'eng (4.0.0_best_int)',
    files: files.map(([, to]) => to),
  };
  writeFileSync(join(out, 'engine.json'), `${JSON.stringify(versions, null, 2)}\n`);
  const bytes = files.reduce((sum, [, to]) => sum + statSync(join(out, to)).size, 0);
  if (!quiet) console.log(`Vendored local OCR engine into vendor/ocr (${(bytes / 1048576).toFixed(1)} MiB).`);
  return { ok: true, files: versions.files };
}

if (import.meta.url === `file://${process.argv[1]}`) vendorOcr();
