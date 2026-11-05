// Usage: node tests/auto-backup-browser.mjs [Playwright package] [Chromium executable] [extension root]
// XVault 22 scheduled backups in real Chromium: the service worker asks the real offscreen document to build
// the recovery file, saves it with chrome.downloads into <media folder>/Backups, prunes beyond "keep", and
// writes an encrypted file that decrypts (backup-crypto.mjs) back to the same JSONL. Fresh temporary profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright');
const root = path.resolve(process.argv[4] || '.');
const { decryptBackup } = await import(pathToFileURL(path.join(root, 'backup-crypto.mjs')));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xvault-autobackup-'));
const downloadDir = path.join(profile, 'downloads'),
  folder = 'XVaultBackupTest';
await fs.mkdir(path.join(profile, 'chrome', 'Default'), { recursive: true });
await fs.writeFile(
  path.join(profile, 'chrome', 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true } })
);
const executablePath = process.argv[3] || process.env.CHROMIUM_PATH || undefined;
const context = await pw.chromium.launchPersistentContext(path.join(profile, 'chrome'), {
  headless: true,
  executablePath,
  channel: executablePath ? undefined : 'chromium',
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox'],
});
try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  const send = message => page.evaluate(message => chrome.runtime.sendMessage(message), message);
  await send({ type: 'SET_SETTINGS', settings: { onboardingComplete: true, mediaFolder: folder } });
  const tweets = Array.from({ length: 40 }, (_, index) => ({
    id: String(1900000000000000000n + BigInt(index)),
    text: `backup post ${index} ✓`,
    url: `https://x.com/ada/status/${1900000000000000000n + BigInt(index)}`,
    createdAt: new Date(Date.UTC(2024, index % 12, 1)).toISOString(),
    author: { handle: 'ada', name: 'Ada' },
    media: [],
    sources: ['bookmarks'],
  }));
  assert.equal((await send({ type: 'STORE_RECORDS', tweets, users: [] }))?.ok, true);
  const backups = path.join(downloadDir, folder, 'Backups');
  const list = async () => (await fs.readdir(backups).catch(() => [])).sort();
  const offscreen = () =>
    worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length);

  // Off by default: status says so and no alarm exists.
  let status = await send({ type: 'AUTO_BACKUP_STATUS' });
  assert.equal(status.enabled, false);
  assert.equal(await worker.evaluate(async () => !!(await chrome.alarms.get('xv-auto-backup'))), false);
  await send({ type: 'SET_SETTINGS', settings: { autoBackupDays: 1, autoBackupKeep: 2 } });
  await page.waitForTimeout(200);
  assert.equal(await worker.evaluate(async () => !!(await chrome.alarms.get('xv-auto-backup'))), true, 'alarm set');

  // 1 · plaintext backup through the real offscreen document.
  const first = await send({ type: 'AUTO_BACKUP_RUN' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.state, 'saved');
  assert.equal(await offscreen(), 0, 'the offscreen document is closed afterwards');
  const [name] = await list();
  assert.match(name, /^xvault-auto-\d{4}-\d\d-\d\d-\d{4}\.jsonl$/);
  const lines = (await fs.readFile(path.join(backups, name), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].format, 'xvault-recovery-jsonl');
  assert.equal(lines.at(-1).type, 'end');
  const posts = lines.filter(line => line.type === 'record' && line.store === 'tweets');
  assert.equal(posts.length, 40, 'every post is in the file');
  assert.equal(lines.at(-1).recordCount, first.file.recordCount);
  assert.ok(
    posts.some(line => line.value.text === 'backup post 7 ✓'),
    'text survives byte-exact'
  );

  // 2 · encrypted: paused until unlocked, then a real .xvenc that decrypts to the same records.
  await send({ type: 'SET_SETTINGS', settings: { autoBackupEncrypt: true } });
  const locked = await send({ type: 'AUTO_BACKUP_RUN' });
  assert.equal(locked.state, 'locked');
  assert.equal((await send({ type: 'AUTO_BACKUP_UNLOCK', passphrase: 'correct horse battery staple' })).ok, true);
  const stored = await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  assert.ok(!stored.includes('correct horse battery staple'), 'the passphrase is not in storage.local');
  const encrypted = await send({ type: 'AUTO_BACKUP_RUN' });
  assert.equal(encrypted.state, 'saved', JSON.stringify(encrypted));
  const encName = (await list()).find(file => file.endsWith('.xvenc'));
  assert.ok(encName, 'encrypted file saved');
  const sealed = await fs.readFile(path.join(backups, encName));
  assert.ok(!sealed.includes(Buffer.from('backup post 7')), 'no plaintext in the encrypted file');
  const opened = await decryptBackup(new Blob([sealed]), 'correct horse battery staple');
  const plain = new TextDecoder().decode(opened instanceof Blob ? await opened.arrayBuffer() : opened);
  assert.equal(
    plain
      .trim()
      .split('\n')
      .map(JSON.parse)
      .filter(line => line.store === 'tweets').length,
    40
  );
  await assert.rejects(decryptBackup(new Blob([sealed]), 'wrong passphrase here'));

  // 3 · retention: keep 2 → the oldest file XVault made is deleted from disk.
  await send({ type: 'SET_SETTINGS', settings: { autoBackupEncrypt: false } });
  await page.waitForTimeout(1100); // distinct minute stamps are not needed (uniquify), but keep order clear
  const third = await send({ type: 'AUTO_BACKUP_RUN' });
  assert.equal(third.state, 'saved');
  assert.equal(third.pruned, 1);
  const remaining = await list();
  assert.equal(remaining.length, 2, `two files kept: ${remaining}`);
  assert.ok(!remaining.includes(name), 'the oldest backup was removed');
  status = await send({ type: 'AUTO_BACKUP_STATUS' });
  assert.equal(status.files.length, 2);
  assert.equal(status.status.state, 'saved');

  // 4 · the Storage page renders the panel without errors.
  await page.goto(`chrome-extension://${id}/dashboard.html#vault`);
  await page.reload(); // a hash-only goto is a same-document navigation
  await page.waitForSelector('#xvAutoForm', { state: 'attached', timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('#xvAutoFiles li').length === 2, null, { timeout: 5000 });
  assert.equal(await page.$eval('#xvAutoForm select[name=days]', node => node.value), '1');
  assert.deepEqual(errors, []);
  console.log(
    `auto backup: plaintext + encrypted files saved through the offscreen document, retention kept ${remaining.length}`
  );
} finally {
  await context.close();
  await fs.rm(profile, { recursive: true, force: true });
}
