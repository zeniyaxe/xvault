// XVault 21: dashboard helpers that run without the extension — the safe-rename scripts (executed for
// real with /bin/sh) and the search-history / time-travel helpers.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

function load(file, extra = {}) {
  const storage = new Map();
  const document = {
    // "loading" defers the DOM mounting these files do at start-up; the helpers under test need no DOM.
    readyState: 'loading',
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener: () => {},
    createElement: () => ({
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener() {},
      setAttribute() {},
    }),
  };
  const window = {
    XVaultDashboard: { after() {}, before() {}, commands() {} },
    addEventListener() {},
  };
  const context = vm.createContext({
    window,
    document,
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    console,
    settings: {},
    ...extra,
  });
  vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), context, { filename: file });
  return { window, context, storage };
}

test('safe-rename shell script moves only existing files and never overwrites', () => {
  const { window } = load('xv-forge.js');
  const plan = {
    base: '',
    moves: [
      { from: 'XVault/a.jpg', to: 'XVault/ada/1 one.jpg' },
      { from: "XVault/it's.jpg", to: "XVault/quote's $(touch pwned).jpg" },
      { from: 'XVault/missing.jpg', to: 'XVault/never.jpg' },
      { from: 'XVault/b.jpg', to: 'XVault/taken.jpg' },
    ],
  };
  const script = window.XVaultForge.renameScript(plan, 'sh');
  assert.match(script, /^#!\/bin\/sh/);
  const dir = mkdtempSync(join(tmpdir(), 'xv-rename-'));
  try {
    mkdirSync(join(dir, 'XVault'));
    for (const name of ['a.jpg', "it's.jpg", 'b.jpg', 'taken.jpg']) writeFileSync(join(dir, 'XVault', name), name);
    writeFileSync(join(dir, 'rename.sh'), script);
    const output = execFileSync('sh', [join(dir, 'rename.sh'), dir], { cwd: dir, encoding: 'utf8' });
    assert.match(output, /Moved 2, skipped 2/);
    assert.equal(readFileSync(join(dir, 'XVault', 'ada', '1 one.jpg'), 'utf8'), 'a.jpg');
    assert.equal(readFileSync(join(dir, 'XVault', "quote's $(touch pwned).jpg"), 'utf8'), "it's.jpg");
    assert.ok(
      !existsSync(join(dir, 'pwned')) && !existsSync(join(dir, 'XVault', 'pwned')),
      'names are never evaluated'
    );
    assert.equal(readFileSync(join(dir, 'XVault', 'taken.jpg'), 'utf8'), 'taken.jpg', 'existing files are kept');
    assert.ok(existsSync(join(dir, 'XVault', 'b.jpg')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const ps1 = window.XVaultForge.renameScript(
    { base: "C:\\Users\\o'neil\\Downloads", moves: [{ from: 'XVault/a.jpg', to: "XVault/it's.jpg" }] },
    'ps1'
  );
  assert.match(ps1, /param\(\[string\]\$Base = 'C:\\Users\\o''neil\\Downloads'\)/);
  assert.match(ps1, /Move-XV 'XVault\\a\.jpg' 'XVault\\it''s\.jpg'/);
  assert.match(ps1, /Test-Path -LiteralPath \$to/);
});

test('search history keeps pins and time travel edits only the asof: token', () => {
  const { window, storage } = load('xv-forge-search.js');
  const api = window.XVaultForgeSearch;
  assert.equal(api.asOfIn('cats asof:2024-05-01 from:ada'), '2024-05-01');
  assert.equal(api.asOfIn('cats as-of:2024-05-01'), '2024-05-01');
  assert.equal(api.asOfIn('cats'), '');
  assert.equal(api.withAsOf('cats asof:2024-05-01 from:ada', '2025-01-02'), 'cats from:ada asof:2025-01-02');
  assert.equal(api.withAsOf('cats -as-of:2024-05-01', ''), 'cats');
  assert.equal(api.withAsOf('', '2025-01-02'), 'asof:2025-01-02');
  const list = [
    { q: 'a', pinned: false },
    { q: 'b', pinned: true },
    { q: 'c', pinned: false },
    { q: 'd', pinned: false },
  ];
  assert.equal(
    api
      .trimHistory(list, 2)
      .map(entry => entry.q)
      .join(),
    'a,b,c'
  );
  api.record('nebula images', 12);
  api.record('nebula images', 14);
  const saved = JSON.parse(storage.get('xv-search-history'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].count, 14);
  assert.equal(saved[0].runs, 1, 're-rendering the same search is not a new run');
  api.record('x', 1);
  assert.equal(api.readHistory().length, 1, 'one-character searches are not kept');
  storage.set('xv-search-history', '{not json');
  assert.equal(api.readHistory().length, 0);
});

test('search history can be switched off', () => {
  const { window, storage } = load('xv-forge-search.js', { settings: { searchHistoryEnabled: false } });
  window.XVaultForgeSearch.record('nebula images', 3);
  assert.equal(storage.has('xv-search-history'), false);
});
