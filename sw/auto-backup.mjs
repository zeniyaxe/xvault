// Scheduled automatic backups (XVault 22 "Keystone"). On a schedule the service worker writes a full
// recovery file (the same revision-checked JSONL as Storage › Backups) into <media folder>/Backups/,
// optionally encrypted, and keeps only the newest N files it made itself. Media binaries are not copied.
//
// Building needs a DOM-like context for Blob URLs: Chrome/Edge use the offscreen document (reason BLOBS),
// Firefox's background event page builds it in place. The encryption passphrase is never written to disk:
// it lives in chrome.storage.session (trusted contexts only) and is gone when the browser closes, so
// encrypted schedules pause with a clear "unlock" state until the user enters it again.
export const AUTO_BACKUP_ALARM = 'xv-auto-backup';
export const AUTO_BACKUP_LOG = 'xvAutoBackups';
export const AUTO_BACKUP_SECRET = 'xvAutoBackupPassphrase';
const DAY = 86_400_000;
const SLACK = 30 * 60_000; // an alarm a little early still counts as due

export function autoBackupDue(settings, log, now = Date.now()) {
  const days = Number(settings?.autoBackupDays) || 0;
  if (days <= 0) return false;
  const last = Number(log?.lastAttemptAt || 0);
  return !last || now - last >= days * DAY - SLACK;
}

export function autoBackupName(now = Date.now(), encrypted = false) {
  const date = new Date(now),
    pad = value => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `xvault-auto-${stamp}${encrypted ? '.xvenc' : '.jsonl'}`;
}

/** Saved auto backups beyond the newest `keep` (only files XVault made and still tracks). */
export function retentionVictims(files, keep) {
  const saved = (files || []).filter(file => file?.state === 'saved' && Number(file.downloadId) > 0);
  saved.sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
  return saved.slice(Math.max(1, Number(keep) || 1));
}

const clean = value =>
  String(value || 'XVault')
    .replace(/\\/g, '/')
    .split('/')
    .map(part => part.replace(/[<>:"|?*\u0000-\u001f]/g, '_').trim())
    .filter(part => part && part !== '.' && part !== '..')
    .join('/') || 'XVault';

export function createAutoBackup({
  chromeApi = globalThis.chrome,
  getSettings,
  builder,
  currentRevision = async () => '',
  now = () => Date.now(),
  notify = () => {},
}) {
  let running = null;
  const local = chromeApi.storage.local,
    session = chromeApi.storage.session;
  async function readLog() {
    const log = (await local.get(AUTO_BACKUP_LOG))[AUTO_BACKUP_LOG];
    return log && typeof log === 'object' ? { files: [], ...log } : { files: [] };
  }
  const writeLog = log => local.set({ [AUTO_BACKUP_LOG]: { ...log, files: (log.files || []).slice(0, 80) } });
  async function passphrase() {
    return String((await session?.get?.(AUTO_BACKUP_SECRET))?.[AUTO_BACKUP_SECRET] || '');
  }
  async function schedule() {
    const settings = await getSettings();
    if (Number(settings.autoBackupDays) > 0)
      await chromeApi.alarms.create(AUTO_BACKUP_ALARM, { periodInMinutes: 60, delayInMinutes: 5 }).catch(() => {});
    else await chromeApi.alarms.clear(AUTO_BACKUP_ALARM).catch(() => {});
  }
  function waitForDownload(id, timeoutMs = 120_000) {
    return new Promise(resolve => {
      let done = false;
      const finish = state => {
        if (done) return;
        done = true;
        chromeApi.downloads.onChanged.removeListener(listener);
        clearTimeout(timer);
        resolve(state);
      };
      const listener = delta => {
        if (delta.id !== id || !delta.state?.current) return;
        if (delta.state.current === 'complete') finish('complete');
        else if (delta.state.current === 'interrupted') finish(delta.error?.current || 'interrupted');
      };
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      chromeApi.downloads.onChanged.addListener(listener);
      chromeApi.downloads
        .search({ id })
        .then(([item]) => {
          if (item?.state === 'complete') finish('complete');
          else if (item?.state === 'interrupted') finish(item.error || 'interrupted');
        })
        .catch(() => {});
    });
  }
  async function prune(log, keep) {
    const victims = retentionVictims(log.files, keep);
    for (const file of victims) {
      // Only delete what is still the very file XVault saved (same id and path in the download history).
      const [item] = await chromeApi.downloads.search({ id: Number(file.downloadId) }).catch(() => []);
      if (item && item.filename === file.filename && item.exists !== false) {
        try {
          await chromeApi.downloads.removeFile(Number(file.downloadId));
        } catch {}
      }
      if (item) await chromeApi.downloads.erase({ id: Number(file.downloadId) }).catch(() => {});
      file.state = 'pruned';
      file.prunedAt = now();
    }
    return victims.length;
  }
  async function runOnce({ reason = 'schedule', force = false } = {}) {
    const settings = await getSettings(),
      log = await readLog(),
      startedAt = now();
    if (!force && !autoBackupDue(settings, log, startedAt)) return { ok: true, state: 'not-due' };
    const encrypted = settings.autoBackupEncrypt === true,
      secret = encrypted ? await passphrase() : '';
    if (encrypted && !secret) {
      log.status = {
        state: 'locked',
        at: startedAt,
        message: 'Enter the backup passphrase to resume encrypted backups',
      };
      await writeLog(log);
      return { ok: false, state: 'locked', error: log.status.message };
    }
    log.lastAttemptAt = startedAt;
    // Unchanged archive (same archive + download revision as the newest kept file): skip the work.
    const lastSaved = (log.files || []).find(file => file.state === 'saved');
    const before = await currentRevision().catch(() => '');
    if (
      !force &&
      settings.autoBackupSkipUnchanged !== false &&
      before &&
      lastSaved?.revision === before &&
      lastSaved.encrypted === encrypted
    ) {
      log.status = { state: 'unchanged', at: startedAt, message: 'Nothing changed since the last backup', reason };
      await writeLog(log);
      return { ok: true, state: 'unchanged' };
    }
    let built;
    try {
      built = await builder.build({ passphrase: secret });
    } catch (error) {
      log.status = { state: 'failed', at: startedAt, message: String(error?.message || error), reason };
      await writeLog(log);
      notify('XVault backup failed', log.status.message);
      return { ok: false, state: 'failed', error: log.status.message };
    }
    const revision = `${built.archiveRevision ?? ''}:${built.downloadRevision ?? ''}`;
    const filename = `${clean(settings.mediaFolder)}/Backups/${autoBackupName(startedAt, encrypted)}`;
    let downloadId = 0,
      outcome = 'failed';
    try {
      downloadId = await chromeApi.downloads.download({
        url: built.url,
        filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      outcome = await waitForDownload(downloadId);
    } catch (error) {
      outcome = String(error?.message || error);
    } finally {
      await builder.release(built.url);
    }
    if (outcome !== 'complete') {
      log.status = {
        state: 'failed',
        at: startedAt,
        message: `The backup file could not be saved (${outcome})`,
        reason,
      };
      await writeLog(log);
      notify('XVault backup failed', log.status.message);
      return { ok: false, state: 'failed', error: log.status.message };
    }
    const [item] = await chromeApi.downloads.search({ id: downloadId }).catch(() => []);
    const entry = {
      at: startedAt,
      state: 'saved',
      downloadId,
      filename: item?.filename || filename,
      relative: filename,
      encrypted,
      recordCount: built.recordCount,
      bytes: built.bytes,
      revision,
      reason,
    };
    log.files = [entry, ...(log.files || [])];
    const pruned = await prune(log, settings.autoBackupKeep);
    log.status = { state: 'saved', at: startedAt, message: '', reason };
    log.lastSavedAt = startedAt;
    await writeLog(log);
    return { ok: true, state: 'saved', file: entry, pruned };
  }
  return {
    schedule,
    async run(options) {
      // One backup at a time; a second request joins the one in flight.
      running ||= runOnce(options).finally(() => (running = null));
      return running;
    },
    onAlarm(name) {
      if (name !== AUTO_BACKUP_ALARM) return false;
      void this.run({ reason: 'schedule' }).catch(() => {});
      return true;
    },
    async status() {
      const settings = await getSettings(),
        log = await readLog();
      const kept = (log.files || []).filter(file => file.state === 'saved');
      const days = Number(settings.autoBackupDays) || 0;
      return {
        ok: true,
        enabled: days > 0,
        days,
        keep: settings.autoBackupKeep,
        encrypted: settings.autoBackupEncrypt === true,
        unlocked: !!(await passphrase()),
        running: !!running,
        status: log.status || null,
        lastSavedAt: log.lastSavedAt || 0,
        nextDueAt: days > 0 ? Number(log.lastAttemptAt || 0) + days * DAY : 0,
        files: kept.slice(0, 20),
      };
    },
    async unlock(secret) {
      const value = String(secret || '');
      if (value.length < 8) return { ok: false, error: 'Use a passphrase of at least 8 characters' };
      await session.set({ [AUTO_BACKUP_SECRET]: value });
      return { ok: true };
    },
    async lock() {
      await session.remove(AUTO_BACKUP_SECRET);
      return { ok: true };
    },
  };
}

/** Chrome/Edge: the offscreen document builds the file and hands back a blob: URL for chrome.downloads. */
export function createOffscreenBackupBuilder(chromeApi = globalThis.chrome, host, hold = () => () => {}) {
  const leases = new Map();
  return {
    async build({ passphrase }) {
      const token = Symbol('backup'),
        drop = hold(token);
      try {
        await host.ensure();
        const out = await chromeApi.runtime.sendMessage({ target: 'xv-backup', action: 'build', passphrase });
        if (!out?.ok) throw Error(out?.error || 'The backup could not be built');
        leases.set(out.url, drop);
        return out;
      } catch (error) {
        drop();
        throw error;
      }
    },
    async release(url) {
      await chromeApi.runtime.sendMessage({ target: 'xv-backup', action: 'release', url }).catch(() => {});
      leases.get(url)?.();
      leases.delete(url);
      await host.close().catch(() => {});
    },
  };
}

/** Firefox: the background event page has a DOM, so it builds the file itself. */
export function createInlineBackupBuilder(request, load = () => import('../offscreen-backup.mjs')) {
  return {
    async build({ passphrase }) {
      const { buildBackupBlob } = await load();
      const { blob, ...built } = await buildBackupBlob({ request, passphrase });
      return { ...built, url: URL.createObjectURL(blob) };
    },
    release: async url => URL.revokeObjectURL(url),
  };
}
