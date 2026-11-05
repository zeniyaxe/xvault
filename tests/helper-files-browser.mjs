// Usage: node tests/helper-files-browser.mjs [Playwright package] [Chromium executable] [extension root]
// Real unpacked MV3 service worker + real Chromium downloads + the real Python helper process (v22 file
// operations). Proves, on disk: HELPER_RENAME_APPLY moves files without overwriting and records only confirmed
// moves; DUPLICATE_LINK turns byte-identical copies into one inode and leaves different bytes alone.
// Uses a fresh profile, a temporary download folder and a temporary helper install; needs python3.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright');
const root = path.resolve(process.argv[4] || '.');
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xvault-helperfiles-'));
const downloadDir = path.join(profile, 'downloads'),
  helperDir = path.join(profile, 'helper'),
  folder = 'XVaultHelperTest';
await fs.mkdir(downloadDir, { recursive: true });
await fs.mkdir(helperDir, { recursive: true });

const bodies = {
  '/same-1.jpg': Buffer.alloc(30_000, 7),
  '/same-2.jpg': Buffer.alloc(30_000, 7),
  '/other.jpg': Buffer.alloc(30_000, 9),
  '/blocked.jpg': Buffer.alloc(20_000, 3),
};
const server = http.createServer((request, response) => {
  const body = bodies[new URL(request.url, 'http://x').pathname];
  if (!body) return response.writeHead(404).end();
  response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length });
  response.end(request.method === 'HEAD' ? undefined : body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const helperPort = await new Promise(resolve => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// Chrome must apply the extension's chosen filename (CDP download overrides would rename files), so the
// download folder comes from profile preferences and Playwright's download interception is switched off below.
await fs.mkdir(path.join(profile, 'chrome', 'Default'), { recursive: true });
await fs.writeFile(
  path.join(profile, 'chrome', 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true } })
);
const context = await pw.chromium.launchPersistentContext(path.join(profile, 'chrome'), {
  headless: true,
  executablePath: process.argv[3] || process.env.CHROMIUM_PATH || undefined,
  channel: process.argv[3] || process.env.CHROMIUM_PATH ? undefined : 'chromium', // headless-shell cannot load extensions
  acceptDownloads: true,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox'],
});
let helper;
try {
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).hostname;
  for (const file of ['xvault_ffmpeg_helper.py', 'file_ops.py'])
    await fs.copyFile(path.join(root, 'FFmpeg_Helper', file), path.join(helperDir, file));
  await fs.writeFile(
    path.join(helperDir, 'config.json'),
    JSON.stringify({ downloads_root: downloadDir, xvault_folder: folder, extension_id: id, server_port: helperPort })
  );
  helper = spawn('python3', [path.join(helperDir, 'xvault_ffmpeg_helper.py')], { stdio: 'ignore' });

  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  const send = message => page.evaluate(message => chrome.runtime.sendMessage(message), message);
  await send({
    type: 'SET_SETTINGS',
    settings: {
      onboardingComplete: true,
      mediaFolder: folder,
      organizeByType: false,
      organizeByAuthor: false,
      organizeByDate: false,
      skipDuplicateDownloads: false,
      helperPort,
    },
  });
  const rows = () =>
    page.evaluate(
      () =>
        new Promise(resolve => {
          const open = indexedDB.open('xvault-db');
          open.onsuccess = () => {
            const query = open.result.transaction('downloads').objectStore('downloads').getAll();
            query.onsuccess = () => {
              resolve(query.result);
              open.result.close();
            };
          };
        })
    );
  const items = Object.keys(bodies).map((name, index) => ({
    url: origin + name,
    tweetId: String(1000 + index),
    author: 'ada',
    index: 1,
    mediaType: 'image',
  }));
  await send({ type: 'QUEUE_DOWNLOADS', items });
  const until = Date.now() + 20000;
  let current = [];
  while (Date.now() < until) {
    current = await rows();
    if (current.filter(row => row.state === 'complete').length >= items.length) break;
    await page.waitForTimeout(150);
  }
  assert.equal(current.filter(row => row.state === 'complete').length, items.length, 'all four files downloaded');
  const byUrl = name => current.find(row => row.item?.url === origin + name);
  const onDisk = relative => path.join(downloadDir, relative);
  for (const name of Object.keys(bodies)) {
    const stat = await fs.stat(onDisk(byUrl(name).target.filename));
    assert.equal(stat.size, bodies[name].length, `${name} is on disk`);
  }

  // The helper is found through the extension's own bootstrap (origin-checked) and advertises its operations.
  let status;
  for (let attempt = 0; attempt < 40; attempt++) {
    status = await send({ type: 'HELPER_STATUS' });
    if (status?.connected) break;
    await page.waitForTimeout(250);
  }
  assert.equal(status?.connected, true, `helper connected: ${JSON.stringify(status)}`);
  assert.ok(status.capabilities.includes('rename') && status.capabilities.includes('link-duplicates'));

  // Duplicates: the two identical downloads (and, as a trap, the different one) are reported as one group.
  // The test marks them as the same media at the same size; the helper must still compare bytes itself.
  await page.evaluate(
    keys =>
      new Promise(resolve => {
        const open = indexedDB.open('xvault-db');
        open.onsuccess = () => {
          const tx = open.result.transaction('downloads', 'readwrite'),
            store = tx.objectStore('downloads');
          keys.forEach(
            (key, order) =>
              (store.get(key).onsuccess = event =>
                store.put({ ...event.target.result, sha256: 'f'.repeat(64), updatedAt: order + 1 }))
          );
          tx.oncomplete = () => (open.result.close(), resolve());
        };
      }),
    ['/same-1.jpg', '/same-2.jpg', '/other.jpg'].map(name => byUrl(name).key)
  );
  const report = await send({ type: 'DUPLICATE_REPORT' });
  assert.equal(report.groups.length, 1);
  assert.equal(report.groups[0].remove.length, 2);
  const preview = await send({ type: 'DUPLICATE_LINK', dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(report.groups[0].keep.file, byUrl('/same-1.jpg').target.filename, 'the oldest copy is kept');
  // Exactly the byte-identical partner qualifies; the file with different bytes is refused by the helper.
  assert.equal(preview.counts['would-link'], 1, JSON.stringify(preview));
  assert.equal(preview.counts.skipped, 1, JSON.stringify(preview));
  const linked = await send({ type: 'DUPLICATE_LINK' });
  assert.equal(linked.ok, true, JSON.stringify(linked));
  const [a, b, c] = await Promise.all(
    ['/same-1.jpg', '/same-2.jpg', '/other.jpg'].map(name => fs.stat(onDisk(byUrl(name).target.filename)))
  );
  assert.equal(linked.linked, 1);
  assert.equal(linked.bytes, bodies['/same-1.jpg'].length);
  assert.equal(a.ino, b.ino, 'identical copies now share one inode');
  assert.equal(a.nlink, 2);
  assert.notEqual(c.ino, a.ino, 'different bytes are never linked');
  assert.deepEqual(await fs.readFile(onDisk(byUrl('/other.jpg').target.filename)), bodies['/other.jpg']);
  assert.deepEqual(await fs.readFile(onDisk(byUrl('/same-2.jpg').target.filename)), bodies['/same-2.jpg']);
  const afterLink = await rows();
  assert.equal(afterLink.filter(row => row.linkedAt).length, 1, 'the linked row is marked');
  const reportAfter = await send({ type: 'DUPLICATE_REPORT' });
  assert.equal(reportAfter.groups[0]?.remove.length || 0, 1, 'only the differing file is still reported');
  console.log(`helper files: linked ${linked.linked} identical copy, left the differing file alone`);

  // Rename: one destination is occupied by a stranger's file; it must survive and its move must not be recorded.
  const plan = await send({ type: 'RENAME_PLAN', fileTemplate: 'renamed_{tweetId}', folderTemplate: '{author}' });
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.total, 4);
  assert.ok(
    plan.moves.every(move => move.to.startsWith(`${folder}/ada/`)),
    'moves stay inside the archive folder'
  );
  const blockedMove = plan.moves.find(move => move.key === byUrl('/blocked.jpg').key);
  await fs.mkdir(path.dirname(onDisk(blockedMove.to)), { recursive: true });
  await fs.writeFile(onDisk(blockedMove.to), 'not yours');
  const dry = await send({
    type: 'HELPER_RENAME_APPLY',
    fileTemplate: 'renamed_{tweetId}',
    folderTemplate: '{author}',
    dryRun: true,
  });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.equal(dry.counts['would-move'], 3);
  assert.equal(dry.updated, 0);
  await fs.stat(onDisk(byUrl('/same-1.jpg').target.filename)); // a dry run moves nothing
  const applied = await send({
    type: 'HELPER_RENAME_APPLY',
    fileTemplate: 'renamed_{tweetId}',
    folderTemplate: '{author}',
  });
  assert.equal(applied.ok, true, JSON.stringify(applied));
  assert.equal(applied.updated, 3);
  assert.equal(applied.problems.length, 1);
  assert.equal(applied.problems[0].state, 'skipped');
  assert.equal(await fs.readFile(onDisk(blockedMove.to), 'utf8'), 'not yours', 'an existing file is never replaced');
  const renamed = await rows();
  for (const name of Object.keys(bodies)) {
    const row = renamed.find(entry => entry.item?.url === origin + name);
    const move = plan.moves.find(entry => entry.key === row.key);
    if (name === '/blocked.jpg') {
      assert.equal(row.target.filename, move.from, 'a refused move keeps its record');
      assert.deepEqual(await fs.readFile(onDisk(move.from)), bodies[name]);
      continue;
    }
    assert.equal(row.target.filename, move.to);
    assert.ok(row.filename.endsWith(move.to.split('/').join(path.sep)), 'absolute path follows the move');
    assert.deepEqual(await fs.readFile(onDisk(move.to)), bodies[name], `${name} moved intact`);
    await assert.rejects(fs.stat(onDisk(move.from)), `${name} left its old path`);
  }
  // Running it again is harmless: nothing left to move, nothing re-recorded.
  const again = await send({
    type: 'HELPER_RENAME_APPLY',
    fileTemplate: 'renamed_{tweetId}',
    folderTemplate: '{author}',
  });
  assert.equal(again.updated, 0);
  assert.deepEqual(errors, []);
  console.log('helper files: renamed 3 files on disk, refused to overwrite 1, records follow the files');
} finally {
  helper?.kill();
  await context.close();
  server.close();
  await fs.rm(profile, { recursive: true, force: true });
}
