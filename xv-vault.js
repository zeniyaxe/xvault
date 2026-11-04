/* XVault 20 — System › Storage & backups.
   Storage manager (browser quota, persistence, per-store counts, derived-data cleanup), meaning index,
   encrypted backups (archive-recovery-ui.mjs + backup-crypto.mjs), X data-archive import
   (x-archive-import.mjs) and the adaptive download engine readout on the Downloads page. */
(() => {
  const $ = selector => document.querySelector(selector);
  const html = value =>
    String(value ?? '').replace(
      /[&<>"']/g,
      char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
    );
  const bytes = value => {
    const n = Number(value) || 0;
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = n / 1024,
      unit = 0;
    while (size >= 1024 && unit < units.length - 1) ((size /= 1024), unit++);
    return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
  };
  const when = value =>
    value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';
  const ago = value => {
    if (!value) return 'never';
    const days = Math.floor((Date.now() - value) / 86400000);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  };
  const STORE_LABELS = {
    tweets: 'Archived posts',
    downloads: 'Download records',
    mediaAssociations: 'Media links',
    trash: 'Trash',
    revisions: 'Edit history (revisions)',
    snapshots: 'Profile snapshots',
    users: 'Profiles',
    actions: 'Activity log',
    archiveRuns: 'Capture runs',
    sessions: 'Sessions',
    collections: 'Smart collections',
    manifests: 'File manifests',
    integrity: 'Integrity reports',
    checkpoints: 'Change checkpoints',
    captures: 'Capture templates',
    jobs: 'Jobs',
    conversions: 'Conversions',
    libraryPlans: 'Library plans',
    archiveImports: 'Recovery imports',
  };
  const LAST_BACKUP = 'xv-last-backup';
  const store = {
    get(key) {
      try {
        return JSON.parse(localStorage.getItem(key) || 'null');
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };
  window.addEventListener('xvault:backup-saved', event => {
    store.set(LAST_BACKUP, { at: Date.now(), ...event.detail });
    paintBackup();
  });

  function ensurePage() {
    let page = $('#page-vault');
    if (page) return page;
    page = document.createElement('section');
    page.className = 'page';
    page.id = 'page-vault';
    $('#page-activity')?.after(page);
    return page;
  }
  function skeleton() {
    const page = ensurePage();
    if (page.querySelector('.xv-vault')) return page;
    page.innerHTML = `<h2 class="xv-sr-only">Storage and backups</h2><div class="xv-vault">
<section class="panel" aria-labelledby="xvStorageTitle"><div class="panelhead"><div><h3 id="xvStorageTitle">Storage</h3><p>Everything XVault keeps lives in this browser profile. Derived data (fingerprints, OCR, the meaning index) can be cleared and rebuilt at any time; your archive cannot.</p></div><button type="button" data-vault="refresh">Refresh</button></div>
<div class="xv-quota" id="xvQuota" aria-live="polite"><div class="xv-quota-bar"><i></i></div><p>Measuring…</p></div>
<div class="xv-vault-grid"><div><h4>Archive</h4><dl class="xv-kv" id="xvStores"></dl></div><div><h4>Derived &amp; rebuildable</h4><dl class="xv-kv" id="xvDerived"></dl><div class="xv-vault-actions">
<button type="button" data-vault="rebuild-semantic">Rebuild meaning index</button>
<button type="button" class="quiet" data-vault="clear-semantic">Clear meaning index</button>
<button type="button" class="quiet" data-vault="clear-phash">Clear fingerprints</button>
<button type="button" class="quiet" data-vault="clear-ocr">Clear OCR text</button>
<button type="button" class="quiet" data-vault="prune-actions">Trim activity log</button>
</div></div></div>
<p class="xv-vault-status" id="xvStorageStatus" role="status" aria-live="polite"></p></section>
<section class="panel" aria-labelledby="xvBackupTitle"><div class="panelhead"><div><h3 id="xvBackupTitle">Backups</h3><p>A recovery file holds every post, note, tag, board, highlight, Trash item and edit history entry — not the media files. Encrypted backups use AES-256-GCM with a key derived from your passphrase (PBKDF2, 600,000 rounds). XVault cannot recover a lost passphrase.</p></div></div>
<div class="xv-backup-state" id="xvBackupState"></div>
<form class="xv-backup-form" id="xvBackupForm" autocomplete="off">
<label class="xv-field"><span>Passphrase</span><input type="password" name="pass" minlength="8" autocomplete="new-password" required aria-describedby="xvPassHint"></label>
<label class="xv-field"><span>Repeat passphrase</span><input type="password" name="again" minlength="8" autocomplete="new-password" required></label>
<p class="xv-pass-hint" id="xvPassHint">At least 8 characters. Four random words beat one clever word.</p>
<div class="xv-vault-actions"><button type="submit" class="primary">Create encrypted backup</button><button type="button" class="quiet" data-vault="plain-backup">Unencrypted recovery file</button><button type="button" class="quiet" data-vault="restore">Restore from a backup…</button></div>
</form></section>
<section class="panel" aria-labelledby="xvImportTitle"><div class="panelhead"><div><h3 id="xvImportTitle">Import your X data archive</h3><p>Bring years of history in at once: choose the ZIP that X emails from <em>Settings › Your account › Download an archive of your data</em> (or an extracted <code>tweets.js</code> / <code>like.js</code>). It is read on this device; only your posts, likes and bookmarks are imported. Posts XVault already captured keep their richer live data.</p></div></div>
<div class="xv-import" id="xvImport"><label class="xv-drop" tabindex="0"><input type="file" accept=".zip,.js,application/zip" id="xvImportFile" hidden><b>Choose your X archive</b><span>or drop the .zip here</span></label></div></section>
</div>`;
    page.addEventListener('click', onClick);
    page.querySelector('#xvBackupForm').addEventListener('submit', onBackup);
    page.querySelector('#xvBackupForm').addEventListener('input', strength);
    const file = page.querySelector('#xvImportFile'),
      drop = page.querySelector('.xv-drop');
    drop.addEventListener(
      'keydown',
      event => (event.key === 'Enter' || event.key === ' ') && (event.preventDefault(), file.click())
    );
    file.addEventListener(
      'change',
      () => file.files?.[0] && readArchive(file.files[0]).finally(() => (file.value = ''))
    );
    drop.addEventListener('dragover', event => {
      event.preventDefault();
      drop.classList.add('is-drop');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-drop'));
    drop.addEventListener('drop', event => {
      event.preventDefault();
      drop.classList.remove('is-drop');
      const chosen = event.dataTransfer?.files?.[0];
      if (chosen) readArchive(chosen);
    });
    return page;
  }

  // ── Storage ──
  async function paintStorage() {
    const quota = $('#xvQuota');
    if (!quota) return;
    const [estimate, persisted, report] = await Promise.all([
      navigator.storage?.estimate?.().catch(() => null),
      navigator.storage?.persisted?.().catch(() => null),
      call({ type: 'STORAGE_REPORT' }).catch(error => ({ ok: false, error: error?.message })),
    ]);
    if (estimate) {
      const ratio = estimate.quota ? estimate.usage / estimate.quota : 0;
      quota.querySelector('i').style.width = `${Math.max(0.5, Math.min(100, ratio * 100)).toFixed(1)}%`;
      quota.querySelector('i').dataset.level = ratio > 0.8 ? 'high' : ratio > 0.5 ? 'mid' : 'low';
      quota.querySelector('p').innerHTML =
        `<b>${bytes(estimate.usage)}</b> used of ${bytes(estimate.quota)} available to XVault${estimate.usageDetails?.indexedDB ? ` · database ${bytes(estimate.usageDetails.indexedDB)}` : ''} · settings ${bytes(report?.settingsBytes)}`;
    } else quota.querySelector('p').textContent = 'This browser does not report storage usage.';
    let persist = quota.querySelector('.xv-persist');
    if (!persist) {
      persist = document.createElement('div');
      persist.className = 'xv-persist';
      quota.append(persist);
    }
    persist.innerHTML = persisted
      ? '<span class="ok">Persistent storage — the browser will not evict your archive</span>'
      : '<span class="warn">Best-effort storage — the browser may clear it under disk pressure</span><button type="button" class="quiet" data-vault="persist">Make persistent</button>';
    if (!report?.ok) {
      $('#xvStores').innerHTML = `<dt>Unavailable</dt><dd>${html(report?.error || 'No response')}</dd>`;
      return;
    }
    // Archived posts first, then whatever holds data (largest first); empty stores fold into one line.
    const label = name => STORE_LABELS[name] || name,
      entries = Object.entries(report.stores || {}),
      filled = entries
        .filter(([, count]) => count > 0)
        .sort((a, b) => (b[0] === 'tweets') - (a[0] === 'tweets') || b[1] - a[1]),
      empty = entries.filter(([, count]) => !(count > 0)).map(([name]) => label(name));
    $('#xvStores').innerHTML =
      filled.map(([name, count]) => `<dt>${html(label(name))}</dt><dd>${fmt(count)}</dd>`).join('') +
      (empty.length
        ? `<dt class="is-muted" title="${html(empty.join(', '))}">${fmt(empty.length)} empty store${empty.length === 1 ? '' : 's'}</dt><dd class="is-muted">${html(empty.slice(0, 3).join(', '))}${empty.length > 3 ? '…' : ''}</dd>`
        : '');
    const semantic = report.semantic;
    $('#xvDerived').innerHTML =
      `<dt>Look-alike fingerprints</dt><dd>${fmt(report.derived?.phash || 0)}</dd><dt>OCR text</dt><dd>${fmt(report.derived?.ocr || 0)}</dd><dt>Meaning index</dt><dd>${
        semantic
          ? `${fmt(semantic.documents)} posts · ${fmt(semantic.vocabulary)} terms · built ${ago(semantic.builtAt)}${semantic.lastBuild ? ` in ${fmt(semantic.lastBuild.ms)} ms` : ''}`
          : 'not built yet (builds on first about: or similar: search)'
      }</dd>`;
  }
  const say = text => {
    const node = $('#xvStorageStatus');
    if (node) node.textContent = text;
  };
  async function onClick(event) {
    const button = event.target.closest('[data-vault]');
    if (!button) return;
    const act = button.dataset.vault;
    if (act === 'refresh') return paintStorage();
    if (act === 'persist') {
      const granted = await navigator.storage?.persist?.().catch(() => false);
      say(
        granted
          ? 'Storage is now persistent.'
          : 'The browser declined. Chrome grants persistence to installed or frequently used extensions — try again later.'
      );
      return paintStorage();
    }
    if (act === 'restore') return $('#recoveryFile')?.click();
    if (act === 'plain-backup') return window.XVaultCreateRecoveryFile?.();
    const run = async (label, message, confirmText) => {
      if (confirmText && !confirm(confirmText)) return;
      button.disabled = true;
      say(`${label}…`);
      const started = performance.now();
      try {
        const result = await call(message);
        if (result?.ok === false) throw Error(result.error || 'Failed');
        say(
          `${label} — done in ${fmt(Math.round(performance.now() - started))} ms${result?.removed != null ? ` · ${fmt(result.removed)} removed` : ''}.`
        );
      } catch (error) {
        say(`${label} failed: ${error?.message || error}`);
      } finally {
        button.disabled = false;
        paintStorage();
      }
    };
    if (act === 'rebuild-semantic') return run('Rebuilding the meaning index', { type: 'SEMANTIC_REBUILD' });
    if (act === 'clear-semantic')
      return run(
        'Clearing the meaning index',
        { type: 'SEMANTIC_CLEAR' },
        'Clear the meaning index? It rebuilds automatically on the next about: or similar: search.'
      );
    if (act === 'clear-phash')
      return run(
        'Clearing look-alike fingerprints',
        { type: 'DERIVED_CLEAR', kind: 'phash' },
        'Clear every look-alike fingerprint? Duplicate Lab and image search need them to be rebuilt (Atlas › Duplicate Lab).'
      );
    if (act === 'clear-ocr')
      return run(
        'Clearing OCR text',
        { type: 'DERIVED_CLEAR', kind: 'ocr' },
        'Clear text recognised in images? ocr: searches return nothing until OCR runs again.'
      );
    if (act === 'prune-actions')
      return run(
        'Trimming the activity log',
        { type: 'PRUNE_ACTIONS', keep: 50 },
        'Keep only the 50 most recent activity entries?'
      );
  }

  // ── Backups ──
  function paintBackup() {
    const node = $('#xvBackupState');
    if (!node) return;
    const last = store.get(LAST_BACKUP),
      overdue = !last || Date.now() - last.at > 14 * 86400000;
    node.className = `xv-backup-state${overdue ? ' is-overdue' : ''}`;
    node.innerHTML = last
      ? `<b>Last backup ${ago(last.at)}</b><span>${when(last.at)} · ${fmt(last.recordCount || 0)} records · ${last.encrypted ? 'encrypted' : 'unencrypted'}</span>${overdue ? '<em>It has been a while — make a fresh one.</em>' : ''}`
      : '<b>No backup made from this browser yet</b><span>Make one now and keep it somewhere other than this computer.</span>';
  }
  function strength() {
    const form = $('#xvBackupForm'),
      pass = form.elements.pass.value,
      again = form.elements.again.value,
      hint = $('#xvPassHint');
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(pass)).length,
      score = pass.length >= 20 ? 3 : pass.length >= 14 ? 2 + (classes > 2) : pass.length >= 8 ? 1 + (classes > 2) : 0;
    hint.dataset.score = String(score);
    hint.textContent = !pass
      ? 'At least 8 characters. Four random words beat one clever word.'
      : again && again !== pass
        ? 'The passphrases do not match yet.'
        : ['Too short', 'Weak — longer is better', 'Good', 'Strong'][Math.min(3, score)];
  }
  function onBackup(event) {
    event.preventDefault();
    const form = event.currentTarget,
      pass = form.elements.pass.value;
    if (pass.length < 8) return strength();
    if (pass !== form.elements.again.value) {
      $('#xvPassHint').textContent = 'The passphrases do not match.';
      form.elements.again.focus();
      return;
    }
    if (!window.XVaultCreateRecoveryFile) return toast('Backups are still loading — try again in a moment');
    // Called synchronously inside the submit so the save picker keeps the user gesture.
    window.XVaultCreateRecoveryFile({ passphrase: pass });
    form.reset();
    strength();
  }

  // ── X data-archive import ──
  let importer = null,
    parsed = null,
    cancelImport = false;
  const loadImporter = () => (importer ||= import(chrome.runtime.getURL('x-archive-import.mjs')));
  async function readArchive(file) {
    const box = $('#xvImport');
    box.innerHTML = `<div class="xv-import-progress" aria-live="polite"><b>Reading ${html(file.name)}</b><span>${bytes(file.size)} · looking for tweets, likes and bookmarks…</span><div class="xv-quota-bar"><i style="width:8%"></i></div></div>`;
    try {
      const { readXArchive } = await loadImporter();
      const started = performance.now();
      parsed = await readXArchive(file, {
        onProgress: ({ done, total, file: name }) => {
          const span = box.querySelector('span'),
            bar = box.querySelector('i');
          if (span && name) span.textContent = `Reading ${name}…`;
          if (bar && total) bar.style.width = `${Math.max(8, (done / total) * 100)}%`;
        },
      });
      parsed.readMs = Math.round(performance.now() - started);
      parsed.fileName = file.name;
      paintImportPreview();
    } catch (error) {
      box.innerHTML = `<p class="xv-import-error" role="alert">${html(error?.message || error)}</p><button type="button" data-import="again">Choose another file</button>`;
      box.querySelector('[data-import="again"]').onclick = resetImport;
    }
  }
  function resetImport() {
    parsed = null;
    const box = $('#xvImport');
    box.innerHTML = `<label class="xv-drop" tabindex="0"><input type="file" accept=".zip,.js,application/zip" id="xvImportFile" hidden><b>Choose your X archive</b><span>or drop the .zip here</span></label>`;
    const file = box.querySelector('#xvImportFile'),
      drop = box.querySelector('.xv-drop');
    drop.addEventListener(
      'keydown',
      event => (event.key === 'Enter' || event.key === ' ') && (event.preventDefault(), file.click())
    );
    file.addEventListener('change', () => file.files?.[0] && readArchive(file.files[0]));
  }
  function paintImportPreview() {
    const box = $('#xvImport'),
      account = parsed.account || {},
      sets = [
        ['tweets', 'Your posts & reposts', parsed.tweets.length],
        ['likes', 'Likes', parsed.likes.length],
        ['bookmarks', 'Bookmarks', parsed.bookmarks.length],
      ].filter(([, , count]) => count);
    box.innerHTML = `<div class="xv-import-summary"><div><b>${account.username ? `@${html(account.username)}` : html(parsed.fileName)}</b><span>${parsed.generatedAt ? `Archive generated ${when(Date.parse(parsed.generatedAt))} · ` : ''}read in ${fmt(parsed.readMs)} ms${parsed.mediaFiles ? ` · ${fmt(parsed.mediaFiles)} media files left in the ZIP (XVault re-downloads originals from X on demand)` : ''}</span></div>
<fieldset class="xv-import-sets"><legend>Import</legend>${sets
      .map(
        ([key, label, count]) =>
          `<label class="xv-check"><input type="checkbox" name="${key}" checked> ${label} <em>${fmt(count)}</em></label>`
      )
      .join('')}</fieldset>
<p class="xv-l3-hint">Imported posts are tagged with the source <code>x-archive</code> (search <code>source:x-archive</code>). Likes and bookmarks in X's export only carry the post text and link; open them on X later and XVault fills in authors and media.</p>
<div class="xv-vault-actions"><button type="button" class="primary" data-import="start">Import</button><button type="button" class="quiet" data-import="cancel">Choose another file</button></div></div>`;
    box.querySelector('[data-import="cancel"]').onclick = resetImport;
    box.querySelector('[data-import="start"]').onclick = runImport;
  }
  async function runImport() {
    const box = $('#xvImport'),
      chosen = [...box.querySelectorAll('.xv-import-sets input:checked')].map(input => input.name),
      rows = chosen.flatMap(kind => parsed[kind].map(row => ({ row, kind })));
    if (!rows.length) return toast('Choose at least one set to import');
    cancelImport = false;
    box.innerHTML = `<div class="xv-import-progress" aria-live="polite"><b>Importing ${fmt(rows.length)} records</b><span>Starting…</span><div class="xv-quota-bar"><i style="width:1%"></i></div><button type="button" class="quiet" data-import="stop">Stop</button></div>`;
    box.querySelector('[data-import="stop"]').onclick = () => (cancelImport = true);
    const totals = { stored: 0, created: 0, updated: 0, skipped: 0 },
      started = performance.now(),
      BATCH = 250;
    try {
      for (let at = 0; at < rows.length && !cancelImport; at += BATCH) {
        const slice = rows.slice(at, at + BATCH),
          result = await call({
            type: 'X_ARCHIVE_IMPORT_BATCH',
            tweets: slice.map(item => item.row),
            final: at + BATCH >= rows.length,
            label: chosen.join(', '),
          });
        if (!result?.ok) throw Error(result?.error || 'Import failed');
        for (const key of Object.keys(totals)) totals[key] += Number(result[key] || 0);
        const done = Math.min(rows.length, at + BATCH),
          rate = done / Math.max(0.001, (performance.now() - started) / 1000);
        box.querySelector('span').textContent =
          `${fmt(done)} of ${fmt(rows.length)} · ${fmt(totals.created)} new · ${fmt(Math.round(rate))}/s · about ${fmt(Math.ceil((rows.length - done) / Math.max(1, rate)))} s left`;
        box.querySelector('i').style.width = `${(done / rows.length) * 100}%`;
      }
      box.innerHTML = `<div class="xv-import-summary is-done"><div><b>${cancelImport ? 'Import stopped' : 'Import complete'}</b><span>${fmt(totals.created)} new posts · ${fmt(totals.updated)} already in your vault${totals.skipped ? ` · ${fmt(totals.skipped)} skipped (invalid)` : ''} · ${fmt(Math.round((performance.now() - started) / 1000))} s</span></div><div class="xv-vault-actions"><button type="button" class="primary" data-import="open">Open in Library</button><button type="button" class="quiet" data-import="again">Import another</button></div></div>`;
      box.querySelector('[data-import="open"]').onclick = () => {
        page('library');
        window.XVaultLibraryRunQuery?.('source:x-archive');
      };
      box.querySelector('[data-import="again"]').onclick = resetImport;
      window.XVaultInvalidateLibraryCache?.();
      toast(`Imported ${fmt(totals.created)} new posts from your X archive`);
      paintStorage();
    } catch (error) {
      box.insertAdjacentHTML(
        'beforeend',
        `<p class="xv-import-error" role="alert">${html(error?.message || error)} — ${fmt(totals.stored)} records were saved before the error; running the import again is safe.</p>`
      );
    }
  }

  // ── Downloads page: adaptive engine readout ──
  function paintEngine() {
    const anchor = $('#page-media .mega');
    if (!anchor) return;
    let node = $('#qEngine');
    if (!node) {
      node = document.createElement('p');
      node.id = 'qEngine';
      node.className = 'xv-engine';
      node.setAttribute('aria-live', 'polite');
      anchor.after(node);
    }
    const adaptive = queueSnapshot?.adaptive,
      ceiling = Math.max(1, Math.min(8, Number(settings.maxConcurrentDownloads) || 4));
    if (settings.adaptiveDownloads === false) {
      node.innerHTML = `<b>Fixed parallelism</b> · ${ceiling} at a time · <button type="button" class="quiet" data-engine="on">Use adaptive</button>`;
    } else {
      const limit = adaptive?.limit ?? ceiling,
        last = adaptive?.events?.[0];
      node.innerHTML = `<b>Adaptive</b> · ${limit} of ${ceiling} parallel${limit < ceiling ? ' — backed off after server pressure, earning slots back' : ''}${last ? ` · last ${last.kind === 'cut' ? 'slowdown' : 'speed-up'} ${new Date(last.at).toLocaleTimeString()}` : ''} · <button type="button" class="quiet" data-engine="off">Fixed</button>`;
    }
    node.querySelector('[data-engine]').onclick = event =>
      save({ adaptiveDownloads: event.currentTarget.dataset.engine === 'on' });
  }

  const hooks = window.XVaultDashboard;
  hooks.after('page', (result, name) => {
    if (name !== 'vault') return;
    skeleton();
    paintStorage();
    paintBackup();
  });
  hooks.after('queueStats', () => paintEngine());
  hooks.after('apply', () => paintEngine());
  hooks.commands(() => [
    { name: 'Storage & backups', hint: 'quota, cleanup, encrypted backups', run: () => page('vault') },
    {
      name: 'Create encrypted backup',
      hint: 'passphrase-protected recovery file',
      run: () => (page('vault'), setTimeout(() => $('#xvBackupForm input')?.focus(), 80)),
    },
    {
      name: 'Import X data archive',
      hint: 'tweets, likes, bookmarks from X’s ZIP',
      run: () => (page('vault'), setTimeout(() => $('#xvImportFile')?.click(), 80)),
    },
  ]);
  function mount() {
    ensurePage();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
  window.XVaultVault = { paintStorage, readArchive };
})();
