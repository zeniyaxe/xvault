/* Interface-only workspace definitions. Never include archive data, queries or credentials. */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.XVaultWorkspaces = api;
})(globalThis, function () {
  const enums = {
    theme: [
      'graphite',
      'oled',
      'midnight',
      'slate',
      'forest',
      'ember',
      'violet',
      'terminal',
      'contrast',
      'paper',
      'linen',
      'cloud',
    ],
    railWidth: ['narrow', 'normal', 'wide'],
    facetWidth: ['narrow', 'normal', 'wide'],
    inspectorWidth: ['narrow', 'normal', 'wide'],
    uiFont: ['hanken', 'system'],
    readFont: ['newsreader', 'sans', 'georgia'],
    uiDensity: ['ultra', 'compact', 'comfortable', 'spacious', 'cinema'],
    libraryView: ['timeline', 'cards', 'gallery', 'masonry', 'compact'],
    libraryMediaSize: ['compact', 'comfortable', 'large'],
  };
  const actions = ['refresh', 'openX', 'export', 'downloads', 'inbox', 'workspaces'];
  function toolbar(value) {
    return Array.isArray(value)
      ? [...new Set(value.slice(0, 64).filter(id => actions.includes(id)))]
      : ['refresh', 'openX', 'export'];
  }
  function snapshot(settings = {}) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) settings = {};
    const values = {};
    for (const [key, allowed] of Object.entries(enums))
      if (allowed.includes(settings[key])) values[key] = settings[key];
    for (const key of ['libraryShowNames', 'libraryShowAvatars', 'libraryShowMetrics'])
      if (typeof settings[key] === 'boolean') values[key] = settings[key];
    if (Number.isFinite(settings.libraryTileSize))
      values.libraryTileSize = Math.max(150, Math.min(440, settings.libraryTileSize));
    if (Number.isFinite(settings.inspectorPixels))
      values.inspectorPixels =
        settings.inspectorPixels === 0 ? 0 : Math.max(320, Math.min(600, settings.inspectorPixels));
    if (settings.accentCustom === '' || /^#[0-9a-f]{6}$/i.test(settings.accentCustom || ''))
      values.accentCustom = settings.accentCustom;
    values.toolbarActions = toolbar(settings.toolbarActions);
    return values;
  }
  function normalizeList(value) {
    const ids = new Set();
    return (Array.isArray(value) ? value.slice(0, 64) : [])
      .filter(
        row =>
          row &&
          /^[a-z0-9-]{1,80}$/i.test(row.id || '') &&
          typeof row.name === 'string' &&
          row.name.trim() &&
          !ids.has(row.id) &&
          ids.add(row.id)
      )
      .slice(0, 12)
      .map(row => ({
        id: row.id,
        name: row.name
          .trim()
          .replace(/[\x00-\x1f]/g, '')
          .slice(0, 48),
        values: snapshot(row.values),
      }))
      .filter(row => row.name);
  }
  function previewImport(current, text) {
    if (typeof text !== 'string' || text.length > 262144) throw Error('Workspace file exceeds 256 KB');
    let file;
    try {
      file = JSON.parse(text);
    } catch {
      throw Error('Invalid workspace JSON');
    }
    if (file?.format !== 'xvault-workspaces-v1' || !Array.isArray(file.workspaces) || file.workspaces.length > 12)
      throw Error('Unsupported workspace file');
    const list = normalizeList(current),
      rows = [],
      seen = new Set();
    let invalid = 0,
      added = 0,
      identical = 0,
      conflicts = 0;
    const allowed = new Set([
      ...Object.keys(enums),
      'libraryShowNames',
      'libraryShowAvatars',
      'libraryShowMetrics',
      'libraryTileSize',
      'inspectorPixels',
      'accentCustom',
      'toolbarActions',
    ]);
    for (const row of file.workspaces) {
      if (
        !row ||
        !row.values ||
        typeof row.values !== 'object' ||
        Array.isArray(row.values) ||
        Object.keys(row.values).some(key => !allowed.has(key)) ||
        seen.has(row.id)
      ) {
        invalid++;
        continue;
      }
      const normalized = normalizeList([row])[0];
      if (!normalized) {
        invalid++;
        continue;
      }
      seen.add(row.id);
      const existing = list.find(item => item.id === row.id);
      const equal = list.some(
        item => JSON.stringify(item.values) === JSON.stringify(normalized.values) && item.name === normalized.name
      );
      const kind = equal ? 'identical' : existing ? 'conflict' : 'added';
      if (kind === 'identical') identical++;
      else if (kind === 'conflict') conflicts++;
      else added++;
      rows.push({ ...normalized, kind });
    }
    return { expected: JSON.stringify(list), rows, invalid, added, identical, conflicts };
  }
  function exportFile(list) {
    return JSON.stringify({ format: 'xvault-workspaces-v1', workspaces: normalizeList(list) }, null, 2);
  }
  function mutate(settings, change) {
    const list = normalizeList(settings.workspaces),
      id = String(change?.id || ''),
      index = list.findIndex(row => row.id === id);
    let patch;
    if (change?.op === 'startup') {
      if (id && index < 0) throw Error('Startup workspace no longer exists');
      return { startupWorkspaceId: id };
    }
    if (change?.op === 'import') {
      const preview = previewImport(list, change.fileText);
      if (change.expected !== undefined && change.expected !== preview.expected)
        throw Error('Workspaces changed. Preview the import again.');
      for (const row of preview.rows) {
        if (row.kind === 'identical' || (row.kind === 'conflict' && change.conflicts !== 'keep-both')) continue;
        let next = { id: row.id, name: row.name, values: row.values };
        if (row.kind === 'conflict') {
          const data = JSON.stringify(next);
          let hash = 2166136261;
          for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data.charCodeAt(i), 16777619);
          next.id = `import-${(hash >>> 0).toString(16)}`;
          const prior = list.find(item => item.id === next.id);
          if (prior) {
            if (JSON.stringify(prior.values) === JSON.stringify(next.values) && prior.name === next.name) continue;
            throw Error('Import identity conflict. Export the evidence before retrying.');
          }
        }
        if (list.length >= 12) throw Error('Import exceeds twelve workspaces. No layouts were changed.');
        list.push(next);
      }
      return { workspaces: list };
    }
    if (change?.op === 'save') {
      const name = String(change.name || '')
        .trim()
        .replace(/[\x00-\x1f]/g, '')
        .slice(0, 48);
      if (!name || !/^[a-z0-9-]{1,80}$/i.test(id)) throw Error('Give the workspace a name');
      if (index >= 0 || list.some(row => row.name.toLowerCase() === name.toLowerCase()))
        throw Error('Workspace already exists. Use Update to replace its layout.');
      if (list.length >= 12) throw Error('Twelve workspaces are saved. Remove one before adding another.');
      list.push({ id, name, values: snapshot(settings) });
      patch = { workspaces: list, activeWorkspaceId: id };
    } else {
      if (index < 0) throw Error('Workspace no longer exists. Refresh the list.');
      if (change.op === 'apply') patch = { ...list[index].values, activeWorkspaceId: id };
      else if (change.op === 'update') {
        list[index].values = snapshot(settings);
        patch = { workspaces: list, activeWorkspaceId: id };
      } else if (change.op === 'rename') {
        if (change.expectedName !== undefined && change.expectedName !== list[index].name)
          throw Error('Workspace name changed. Refresh before renaming.');
        const name = String(change.name || '')
          .trim()
          .replace(/[\x00-\x1f]/g, '')
          .slice(0, 48);
        if (!name) throw Error('Give the workspace a name');
        if (list.some((row, i) => i !== index && row.name.toLowerCase() === name.toLowerCase()))
          throw Error('Workspace name already exists');
        list[index].name = name;
        patch = { workspaces: list };
      } else if (change.op === 'duplicate') {
        if (
          list.length >= 12 ||
          !/^[a-z0-9-]{1,80}$/i.test(change.newId || '') ||
          list.some(row => row.id === change.newId)
        )
          throw Error('Cannot duplicate this workspace');
        let name = list[index].name.slice(0, 36) + ' copy',
          suffix = 2;
        while (list.some(row => row.name === name)) name = list[index].name.slice(0, 32) + ` copy ${suffix++}`;
        list.push({ ...list[index], id: change.newId, name });
        patch = { workspaces: list };
      } else if (change.op === 'move') {
        const target = Math.max(0, Math.min(list.length - 1, index + (change.delta === -1 ? -1 : 1)));
        const [row] = list.splice(index, 1);
        list.splice(target, 0, row);
        patch = { workspaces: list };
      } else if (change.op === 'remove') {
        list.splice(index, 1);
        patch = {
          workspaces: list,
          ...(settings.activeWorkspaceId === id ? { activeWorkspaceId: '' } : {}),
          ...(settings.startupWorkspaceId === id ? { startupWorkspaceId: '' } : {}),
        };
      } else throw Error('Unknown workspace action');
    }
    return patch;
  }
  return Object.freeze({ snapshot, toolbar, normalizeList, mutate, previewImport, exportFile });
});
