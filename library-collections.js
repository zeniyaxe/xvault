/* Portable, query-backed Smart Collection definitions. The collection stores rules, never result IDs. */
(() => {
  const SORTS = new Set(['new', 'old', 'likes', 'views', 'bookmarks', 'reposts', 'replies', 'media', 'author', 'random']);
  const VIEWS = new Set(['timeline', 'cards', 'gallery', 'masonry', 'compact']);
  const ICONS = new Set(['search', 'bookmark', 'favorite', 'tag', 'image', 'video', 'note', 'thread', 'quote', 'calendar', 'inbox', 'media', 'saved']);
  const MAX_FILE_BYTES = 512 * 1024;
  const MAX_COLLECTIONS = 200;
  const MAX_QUERY = 2000;
  const MAX_NAME = 48;

  function stableKey(value) {
    let hash = 2166136261;
    for (const char of String(value)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }

  function normalizeDefinition(value, index = 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`Collection ${index + 1} is not an object`);
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const query = typeof value.query === 'string' ? value.query.trim() : '';
    if (!name || name.length > MAX_NAME) throw Error(`Collection ${index + 1} needs a name of 1–${MAX_NAME} characters`);
    if (!query || query.length > MAX_QUERY) throw Error(`“${name}” needs a query of 1–${MAX_QUERY} characters`);
    const sort = typeof value.sort === 'string' ? value.sort : 'new';
    const view = typeof value.view === 'string' ? value.view : 'timeline';
    const icon = typeof value.icon === 'string' ? value.icon : 'saved';
    if (!SORTS.has(sort)) throw Error(`“${name}” has an unsupported sort order`);
    if (!VIEWS.has(view)) throw Error(`“${name}” has an unsupported Library layout`);
    if (!ICONS.has(icon)) throw Error(`“${name}” has an unsupported icon`);
    const rawId = typeof value.id === 'string' ? value.id : typeof value.portableId === 'string' ? value.portableId : '';
    const id = rawId && rawId.length <= 96 ? rawId : `legacy-${stableKey(`${name}\0${query}\0${sort}\0${view}\0${icon}`)}`;
    return { id, name, query, sort, view, icon };
  }

  function canonical(definition, includeName = true) {
    return JSON.stringify(includeName
      ? [definition.name.trim().toLocaleLowerCase(), definition.query, definition.sort, definition.view, definition.icon]
      : [definition.query, definition.sort, definition.view, definition.icon]);
  }

  function parsePortable(input) {
    const text = (typeof input === 'string' ? input : JSON.stringify(input)).replace(/^\uFEFF/, '');
    if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) throw Error('Collection file exceeds the 512 KB size limit');
    let value;
    try { value = JSON.parse(text); } catch { throw Error('This is not valid JSON'); }
    if (!value || value.format !== 'xvault-collections-v1' || !Array.isArray(value.collections)) throw Error('Unsupported Smart Collection file format');
    if (value.collections.length > MAX_COLLECTIONS) throw Error(`A file may contain at most ${MAX_COLLECTIONS} collections`);
    const collections = [], invalid = [];
    value.collections.forEach((item, index) => {
      try { collections.push({ sourceIndex: index, collection: normalizeDefinition(item, index) }); }
      catch (error) { invalid.push({ sourceIndex: index, error: String(error.message || error) }); }
    });
    return { collections, invalid };
  }

  function exportPortable(views, exportedAt = new Date().toISOString()) {
    const source = Array.isArray(views) ? views.slice(-MAX_COLLECTIONS) : [];
    const collections = source.map((view, index) => {
      const normalized = normalizeDefinition(view, index);
      normalized.id = typeof view.portableId === 'string' && view.portableId ? view.portableId : normalized.id;
      return normalized;
    });
    return JSON.stringify({ format: 'xvault-collections-v1', exportedAt, collections }, null, 2);
  }

  function previewDefinitions(entries, invalid, current) {
    const existing = Array.isArray(current) ? current : [];
    const knownIds = new Map();
    const knownNames = new Map();
    const remember = (definition, value) => {
      const id = String(value.portableId || value.id || definition.id || '');
      if (id) knownIds.set(id, definition);
      const name = definition.name.trim().toLocaleLowerCase();
      if (!knownNames.has(name)) knownNames.set(name, definition);
    };
    for (let i = 0; i < existing.length; i++) {
      try { remember(normalizeDefinition(existing[i], i), existing[i]); } catch {}
    }
    const items = [], seenIds = new Map(), seenNames = new Map();
    for (const entry of entries) {
      const collection = entry.collection;
      const incomingId = String(collection.portableId || collection.id);
      const duplicateById = seenIds.get(incomingId);
      const duplicateByName = seenNames.get(collection.name.toLocaleLowerCase());
      let action = 'add', reason = '';
      const idMatch = knownIds.get(incomingId);
      const nameMatch = knownNames.get(collection.name.toLocaleLowerCase());
      const match = idMatch || nameMatch || duplicateById || duplicateByName;
      if (match) {
        const identical = idMatch || duplicateById
          ? canonical(match, false) === canonical(collection, false)
          : canonical(match) === canonical(collection);
        if (identical) { action = 'identical'; reason = 'Same name and rules already exist'; }
        else { action = 'conflict'; reason = idMatch ? 'This collection ID has different rules' : 'A collection with this name has different rules'; }
      }
      items.push({ sourceIndex: entry.sourceIndex, collection, action, reason });
      if (!duplicateById) seenIds.set(incomingId, collection);
      if (!duplicateByName) seenNames.set(collection.name.toLocaleLowerCase(), collection);
      if (action !== 'conflict') remember(collection, { id: incomingId, portableId: incomingId });
    }
    return {
      items,
      invalid,
      counts: {
        add: items.filter(item => item.action === 'add').length,
        identical: items.filter(item => item.action === 'identical').length,
        conflict: items.filter(item => item.action === 'conflict').length,
        invalid: invalid.length,
      },
    };
  }

  function previewImport(input, current) {
    const parsed = parsePortable(input);
    return previewDefinitions(parsed.collections, parsed.invalid, current);
  }

  function uniqueCopyName(name, reserved) {
    const base = `${name.slice(0, Math.max(1, MAX_NAME - 10)).trimEnd()} (imported)`;
    if (!reserved.has(base.toLocaleLowerCase())) return base;
    for (let suffix = 2; suffix < 10000; suffix++) {
      const ending = ` (imported ${suffix})`;
      const candidate = `${name.slice(0, MAX_NAME - ending.length).trimEnd()}${ending}`;
      if (!reserved.has(candidate.toLocaleLowerCase())) return candidate;
    }
    throw Error('Could not assign a unique collection name');
  }

  function makeId() {
    return globalThis.crypto?.randomUUID?.() || `collection-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  function commitImport(plan, current, options = {}) {
    const latest = Array.isArray(current) ? current.slice() : [];
    const freshPlan = previewDefinitions(
      (plan?.items || []).map(item => ({ sourceIndex: item.sourceIndex, collection: item.collection })),
      plan?.invalid || [], latest,
    );
    const policy = options.conflicts === 'keep-both' ? 'keep-both' : 'skip';
    const reserved = new Set(latest.map(view => String(view?.name || '').trim().toLocaleLowerCase()));
    const eligible = freshPlan.items.filter(item => item.action === 'add' || item.action === 'conflict' && policy === 'keep-both').length;
    if (latest.length + eligible > MAX_COLLECTIONS) throw Error(`Import would exceed the ${MAX_COLLECTIONS}-collection limit`);
    let added = 0, skipped = 0;
    for (const item of freshPlan.items) {
      if (item.action === 'identical' || (item.action === 'conflict' && policy === 'skip')) { skipped++; continue; }
      const source = item.collection;
      const conflict = item.action === 'conflict';
      const incomingId = String(source.portableId || source.id);
      const idInUse = latest.some(view => String(view?.id || '') === incomingId);
      const id = conflict || idInUse ? String((options.idFactory || makeId)()) : incomingId;
      const name = conflict ? uniqueCopyName(source.name, reserved) : source.name;
      const collection = { ...source, id, name, ...(id !== incomingId ? { portableId: incomingId } : {}) };
      latest.push(collection);
      reserved.add(name.toLocaleLowerCase());
      added++;
    }
    return { collections: latest, added, skipped, invalid: freshPlan.counts.invalid, conflicts: freshPlan.counts.conflict };
  }

  function moveCollection(collections, index, delta) {
    const rows = Array.isArray(collections) ? collections.slice() : [];
    if (!Number.isInteger(index) || !Number.isInteger(delta) || Math.abs(delta) !== 1) return rows;
    const next = index + delta;
    if (index < 0 || index >= rows.length || next < 0 || next >= rows.length) return rows;
    [rows[index], rows[next]] = [rows[next], rows[index]];
    return rows;
  }

  function applyChange(current, change) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw Error('Invalid Smart Collection update');
    const views = (Array.isArray(current) ? current : []).map((value, index) => ({ ...value, ...normalizeDefinition(value, index), id: String(value?.id || normalizeDefinition(value, index).id) }));
    const op = String(change.op || '');
    let summary = {}, changed = false;
    if (op === 'save') {
      const item = normalizeDefinition(change.collection, 0);
      const index = views.findIndex(value => value.name.toLocaleLowerCase() === item.name.toLocaleLowerCase());
      if (index >= 0) {
        const existing = views[index];
        const updated = { ...existing, ...item, id: existing.id, createdAt: existing.createdAt || change.collection.createdAt || Date.now(), ...(existing.portableId ? { portableId: existing.portableId } : {}) };
        changed = canonical(existing) !== canonical(updated);
        views[index] = updated;
        summary.updated = 1;
      } else {
        if (views.length >= MAX_COLLECTIONS) throw Error(`A maximum of ${MAX_COLLECTIONS} Smart Collections is supported`);
        views.push({ ...change.collection, ...item }); changed = true; summary.added = 1;
      }
    } else if (op === 'remove') {
      const index = views.findIndex(value => value.id === String(change.id || ''));
      if (index >= 0) { views.splice(index, 1); changed = true; summary.removed = 1; }
    } else if (op === 'move') {
      const id = String(change.id || ''), index = views.findIndex(value => value.id === id), delta = Number(change.delta);
      if (index >= 0) {
        const reordered = moveCollection(views, index, delta);
        changed = reordered.findIndex(value => value.id === id) !== index;
        views.splice(0, views.length, ...reordered); summary.moved = changed;
      }
    } else if (op === 'import') {
      if (typeof change.fileText !== 'string') throw Error('The collection file is missing');
      const plan = previewImport(change.fileText, views);
      const result = commitImport(plan, views, { conflicts: change.conflicts === 'keep-both' ? 'keep-both' : 'skip' });
      views.splice(0, views.length, ...result.collections);
      changed = result.added > 0;
      summary = { added: result.added, skipped: result.skipped, invalid: result.invalid, conflicts: result.conflicts };
    } else throw Error('Unsupported Smart Collection update');
    if (views.length > MAX_COLLECTIONS) throw Error(`A maximum of ${MAX_COLLECTIONS} Smart Collections is supported`);
    return { savedViews: views, changed, ...summary };
  }

  const api = { MAX_FILE_BYTES, MAX_COLLECTIONS, normalizeDefinition, parsePortable, exportPortable, previewImport, commitImport, moveCollection, applyChange };
  globalThis.XVaultCollections = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
