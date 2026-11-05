// XVault 22: scheduled automatic backups — due logic, names, retention and the run state machine
// against a fake chrome API (the real offscreen/Chromium path is tests/auto-backup-browser.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTO_BACKUP_LOG,
  autoBackupDue,
  autoBackupName,
  createAutoBackup,
  retentionVictims,
} from '../sw/auto-backup.mjs';
import { normalizeForgeSettings, FORGE_DEFAULTS } from '../sw/forge-settings.mjs';

const DAY = 86_400_000;

test('due: off, first run, interval with slack', () => {
  assert.equal(autoBackupDue({ autoBackupDays: 0 }, {}, 10 * DAY), false);
  assert.equal(autoBackupDue({ autoBackupDays: 1 }, {}, 10 * DAY), true);
  assert.equal(autoBackupDue({ autoBackupDays: 1 }, { lastAttemptAt: 10 * DAY }, 10.5 * DAY), false);
  assert.equal(autoBackupDue({ autoBackupDays: 1 }, { lastAttemptAt: 10 * DAY }, 11 * DAY - 10 * 60_000), true);
  assert.equal(autoBackupDue({ autoBackupDays: 7 }, { lastAttemptAt: 10 * DAY }, 16 * DAY), false);
});

test('names and retention', () => {
  const at = new Date(2025, 0, 2, 3, 4).getTime();
  assert.equal(autoBackupName(at), 'xvault-auto-2025-01-02-0304.jsonl');
  assert.equal(autoBackupName(at, true), 'xvault-auto-2025-01-02-0304.xvenc');
  const files = [1, 5, 3, 4, 2].map(n => ({ at: n, state: 'saved', downloadId: n }));
  files.push({ at: 0, state: 'pruned', downloadId: 9 });
  assert.deepEqual(
    retentionVictims(files, 3).map(file => file.at),
    [2, 1]
  );
  assert.equal(retentionVictims(files, 0).length, 4, 'always keeps at least one');
});

test('settings are normalised', () => {
  assert.equal(FORGE_DEFAULTS.autoBackupDays, 0);
  const out = normalizeForgeSettings({
    ...FORGE_DEFAULTS,
    autoBackupDays: 400,
    autoBackupKeep: 0,
    autoBackupEncrypt: 'yes',
  });
  assert.equal(out.autoBackupDays, 90);
  assert.equal(out.autoBackupKeep, 1);
  assert.equal(out.autoBackupEncrypt, false, 'only a real true enables encryption');
});

function fakeChrome() {
  const local = new Map(),
    session = new Map(),
    downloads = new Map(),
    listeners = new Set(),
    removed = [],
    alarms = new Map();
  let nextId = 100;
  const area = map => ({
    get: async key => (map.has(key) ? { [key]: structuredClone(map.get(key)) } : {}),
    set: async values => Object.entries(values).forEach(([key, value]) => map.set(key, structuredClone(value))),
    remove: async key => map.delete(key),
  });
  return {
    local,
    session,
    downloads,
    removed,
    alarms,
    api: {
      storage: { local: area(local), session: area(session) },
      alarms: {
        create: async (name, info) => alarms.set(name, info),
        clear: async name => alarms.delete(name),
      },
      downloads: {
        async download({ url, filename }) {
          const id = nextId++;
          downloads.set(id, { id, url, filename: `/home/u/Downloads/${filename}`, state: 'in_progress', exists: true });
          setTimeout(() => {
            downloads.get(id).state = 'complete';
            for (const listener of listeners) listener({ id, state: { current: 'complete' } });
          }, 5);
          return id;
        },
        search: async ({ id }) => (downloads.has(id) ? [{ ...downloads.get(id) }] : []),
        removeFile: async id => {
          removed.push(id);
          downloads.get(id).exists = false;
        },
        erase: async ({ id }) => downloads.delete(id),
        onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      },
    },
  };
}

test('run: saves into <media>/Backups, skips unchanged, prunes old files, pauses when locked', async () => {
  const fake = fakeChrome();
  let settings = { mediaFolder: 'XVault', autoBackupDays: 1, autoBackupKeep: 2, autoBackupSkipUnchanged: true };
  let revision = 1,
    clock = 1_000 * DAY,
    builds = 0;
  const released = [];
  const backup = createAutoBackup({
    chromeApi: fake.api,
    getSettings: async () => settings,
    now: () => clock,
    currentRevision: async () => `${revision}:0`,
    builder: {
      build: async ({ passphrase }) => (
        builds++,
        { url: `blob:${builds}`, recordCount: 3, bytes: 99, archiveRevision: revision, downloadRevision: 0, passphrase }
      ),
      release: async url => released.push(url),
    },
  });
  await backup.schedule();
  assert.ok(fake.alarms.has('xv-auto-backup'));
  const first = await backup.run();
  assert.equal(first.state, 'saved');
  assert.match(first.file.relative, /^XVault\/Backups\/xvault-auto-\d{4}-\d\d-\d\d-\d{4}\.jsonl$/);
  assert.deepEqual(released, ['blob:1'], 'the blob URL is released after the download');
  assert.equal((await backup.run()).state, 'not-due');
  clock += DAY;
  assert.equal((await backup.run()).state, 'unchanged', 'same revision: nothing is built');
  assert.equal(builds, 1);
  for (let index = 0; index < 3; index++) {
    clock += DAY;
    revision++;
    assert.equal((await backup.run()).state, 'saved');
  }
  const log = fake.local.get(AUTO_BACKUP_LOG);
  assert.equal(log.files.filter(file => file.state === 'saved').length, 2, 'keeps the newest two');
  assert.equal(fake.removed.length, 2, 'older files are deleted from disk');
  // Encryption without the session passphrase pauses instead of writing plaintext.
  settings = { ...settings, autoBackupEncrypt: true };
  clock += DAY;
  revision++;
  const locked = await backup.run();
  assert.equal(locked.state, 'locked');
  assert.equal((await backup.status()).status.state, 'locked');
  assert.equal((await backup.unlock('short')).ok, false);
  assert.equal((await backup.unlock('correct horse battery')).ok, true);
  assert.equal(fake.local.has('xvAutoBackupPassphrase'), false, 'the passphrase never reaches storage.local');
  const encrypted = await backup.run();
  assert.equal(encrypted.state, 'saved');
  assert.match(encrypted.file.relative, /\.xvenc$/);
  const status = await backup.status();
  assert.equal(status.unlocked, true);
  await backup.lock();
  assert.equal((await backup.status()).unlocked, false);
  // A manual run is forced (no due / unchanged checks).
  assert.equal((await backup.run({ force: true, reason: 'manual' })).state, 'locked');
  settings = { ...settings, autoBackupEncrypt: false };
  assert.equal((await backup.run({ force: true, reason: 'manual' })).state, 'saved');
});

test('run: a failed build or download is recorded, notified and does not prune', async () => {
  const fake = fakeChrome();
  const notes = [];
  const backup = createAutoBackup({
    chromeApi: fake.api,
    getSettings: async () => ({ mediaFolder: '../evil/..', autoBackupDays: 1, autoBackupKeep: 1 }),
    notify: (title, message) => notes.push(message),
    builder: {
      build: async () => {
        throw Error('The archive changed during backup');
      },
      release: async () => {},
    },
  });
  const failed = await backup.run();
  assert.equal(failed.state, 'failed');
  assert.match(notes[0], /archive changed/);
  const ok = createAutoBackup({
    chromeApi: fake.api,
    getSettings: async () => ({ mediaFolder: '../evil/..', autoBackupDays: 1, autoBackupKeep: 1 }),
    builder: { build: async () => ({ url: 'blob:x', recordCount: 0, bytes: 1 }), release: async () => {} },
  });
  const saved = await ok.run({ force: true });
  assert.match(saved.file.relative, /^evil\/Backups\//, 'path traversal segments are dropped');
});
