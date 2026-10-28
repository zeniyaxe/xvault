import globals from 'globals';
import { readFileSync } from 'node:fs';
import { collectGlobals, scriptSrcs } from './scripts/script-globals.mjs';

const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const contentScripts = manifest.content_scripts.flatMap(c => c.js);
// bulk-download-* are lazy-loaded into the dashboard by dashboard-island.js.
const dashboardScripts = [
  ...scriptSrcs('dashboard.html'),
  'bulk-download-model.js',
  'bulk-download-ui.js',
  'explorer.js',
  'settings-studio.js',
];
const remoteScripts = scriptSrcs('FFmpeg_Helper/remote-ui/index.html', 'FFmpeg_Helper/remote-ui/');
const sharedModules = [
  'link-utils.js',
  'library-model.js',
  'library-collections.js',
  'library-search-core.js',
  'workspace-model.js',
  'bulk-download-model.js',
  'media-asset.js',
];
const dashboardGlobals = collectGlobals(dashboardScripts);
const cjs = { module: 'writable', define: 'readonly', require: 'readonly' };

const rules = {
  'no-undef': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-dupe-else-if': 'error',
  'no-self-assign': 'error',
  'no-const-assign': 'error',
  'no-redeclare': ['error', { builtinGlobals: false }],
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-unsafe-finally': 'error',
  'no-import-assign': 'error',
  'no-loss-of-precision': 'error',
  'no-unsafe-negation': 'error',
  'no-duplicate-case': 'error',
  'no-dupe-class-members': 'error',
  'getter-return': 'error',
  'no-setter-return': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-sparse-arrays': 'error',
  'no-unused-private-class-members': 'warn',
  'no-self-compare': 'error',
  'no-template-curly-in-string': 'warn',
  eqeqeq: ['warn', 'smart'],
};

export default [
  { ignores: ['node_modules/**', 'dist/**', 'FFmpeg_Helper/remote-ui/qrcode-*.js'] },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions, ...cjs },
    },
    rules,
  },
  { files: dashboardScripts, languageOptions: { globals: dashboardGlobals } },
  { files: contentScripts, languageOptions: { globals: collectGlobals(contentScripts) } },
  {
    files: remoteScripts,
    languageOptions: { globals: { ...collectGlobals(remoteScripts), XVaultRemoteDrafts: 'readonly' } },
  },
  { files: ['sidepanel.js'], languageOptions: { globals: collectGlobals(['sidepanel.js']) } },
  {
    files: ['**/*.mjs', 'background.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        ...globals.serviceworker,
        ...collectGlobals(sharedModules),
      },
    },
    rules,
  },
  {
    files: ['library-export-worker.js'],
    languageOptions: { globals: { ...globals.worker, ...collectGlobals(['link-utils.js', 'link-export.js']) } },
  },
  { files: ['archive-recovery-ui.mjs'], languageOptions: { globals: dashboardGlobals } },
  {
    files: ['scripts/**', 'tests/**', 'eslint.config.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules,
  },
];
