/* Explicit portable draft exchange. Imports add evidence; they never write archive notes. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XVaultRemoteDrafts = api;
})(globalThis, function () {
  const PREFIX = 'xvault.remote.note-draft:',
    MAX_BYTES = 2 * 1024 * 1024,
    MAX_ROWS = 500;
  const encode = value => JSON.stringify(value),
    digest = async text =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
        .map(value => value.toString(16).padStart(2, '0'))
        .join('');
  function normalize(row) {
    if (
      !row ||
      !/^[0-9]{1,32}$/.test(String(row.postId || '')) ||
      !/^[a-z0-9_-]{1,128}$/i.test(row.pairingId || '') ||
      typeof row.value !== 'string' ||
      typeof row.base !== 'string' ||
      row.value.length > 100000 ||
      row.base.length > 100000 ||
      !Number.isFinite(row.at) ||
      row.at < 0
    )
      throw Error('Draft identity, note or baseline is invalid');
    return { postId: String(row.postId), pairingId: row.pairingId, value: row.value, base: row.base, at: row.at };
  }
  function snapshot(storage) {
    const rows = [];
    let bytes = 0;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const raw = storage.getItem(key);
      bytes += raw?.length || 0;
      if (rows.length >= 5000 || bytes > 8 * 1024 * 1024)
        throw Error(
          'Draft collection exceeds the bounded import preview; export relevant evidence before reducing the collection or importing'
        );
      rows.push({ key, raw });
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }
  function fromEntry(entry) {
    let saved;
    try {
      saved = JSON.parse(entry.raw);
    } catch {
      throw Error('Unreadable draft: export its raw evidence separately');
    }
    const parts = entry.key.slice(PREFIX.length).split(':');
    return normalize({
      postId: saved.postId || parts[1],
      pairingId: saved.deviceId || parts[0],
      value: saved.value,
      base: saved.base,
      at: Number(saved.at) || 0,
    });
  }
  async function exportFile(entries) {
    if (!entries.length || entries.length > MAX_ROWS) throw Error('Select between 1 and 500 drafts');
    const drafts = [];
    for (const entry of entries) {
      const row = fromEntry(entry);
      drafts.push({ ...row, evidenceId: await digest(encode(row)) });
    }
    const text = encode({ format: 'xvault-remote-drafts', version: 1, drafts });
    if (new TextEncoder().encode(text).length > MAX_BYTES)
      throw Error('Draft export exceeds 2 MB; select fewer drafts');
    return text;
  }
  async function preview(entries, text) {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BYTES)
      throw Error('Draft file exceeds 2 MB');
    let file;
    try {
      file = JSON.parse(text);
    } catch {
      throw Error('Invalid draft JSON');
    }
    if (file?.format === 'xvault-remote-note-draft-v1') {
      let saved;
      try {
        saved = JSON.parse(file.raw);
      } catch {
        throw Error('Legacy draft evidence is unreadable');
      }
      file = {
        format: 'xvault-remote-drafts',
        version: 1,
        drafts: [
          {
            postId: file.postId,
            pairingId: saved.deviceId || 'legacy',
            value: saved.value,
            base: saved.base,
            at: Number(saved.at) || 0,
          },
        ],
      };
    }
    if (
      file?.format !== 'xvault-remote-drafts' ||
      file.version !== 1 ||
      !Array.isArray(file.drafts) ||
      !file.drafts.length ||
      file.drafts.length > MAX_ROWS
    )
      throw Error('Unsupported draft format, version or count');
    const current = [];
    for (const entry of entries)
      try {
        const row = fromEntry(entry);
        current.push({ ...row, evidenceId: await digest(encode(row)) });
      } catch {
        /* retain unreadable evidence untouched */
      }
    const known = new Set(current.map(row => row.evidenceId)),
      seen = new Set(),
      rows = [];
    let identical = 0,
      conflicts = 0;
    for (const input of file.drafts) {
      const row = normalize(input),
        evidenceId = await digest(encode(row));
      if (input.evidenceId && input.evidenceId !== evidenceId)
        throw Error('Draft fingerprint does not match its evidence');
      if (seen.has(evidenceId) || known.has(evidenceId)) {
        identical++;
        continue;
      }
      seen.add(evidenceId);
      const prior = current.find(
        existing => existing.postId === row.postId && (existing.value !== row.value || existing.base !== row.base)
      );
      if (prior) conflicts++;
      rows.push({ ...row, evidenceId, conflict: !!prior, prior });
    }
    return {
      rows,
      identical,
      conflicts,
      added: rows.length,
      expected: await digest(encode([...entries].sort((a, b) => a.key.localeCompare(b.key)))),
    };
  }
  async function commit(storage, plan) {
    const baseline = snapshot(storage),
      serialized = encode(baseline);
    if ((await digest(serialized)) !== plan.expected || encode(snapshot(storage)) !== serialized)
      throw Error('Drafts changed after preview. Preview the import again.');
    let imported = 0;
    for (const row of plan.rows) {
      const key = PREFIX + row.pairingId + ':' + row.postId + ':portable:' + row.evidenceId;
      if (storage.getItem(key) !== null) throw Error('Portable draft identity changed after preview');
      try {
        storage.setItem(
          key,
          encode({
            value: row.value,
            base: row.base,
            at: row.at,
            postId: row.postId,
            deviceId: row.pairingId,
            portableEvidenceId: row.evidenceId,
          })
        );
        imported++;
      } catch (error) {
        return {
          imported,
          partial: true,
          error:
            'Draft storage is full. Imported evidence remains retained; export or free space, then import the same file to resume.',
        };
      }
    }
    return { imported, partial: false };
  }
  return Object.freeze({ snapshot, exportFile, preview, commit, MAX_ROWS, MAX_BYTES });
});
