import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright');
const browser = await pw.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:8765/tests/library-storage.html');
  const evidence = await page.evaluate(async () => {
    const api = await import('/library-storage.mjs');
    const request = indexedDB.open('recovery-scale-' + crypto.randomUUID(), 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('tweets', { keyPath: 'id' });
      request.result.createObjectStore('trash', { keyPath: 'id' }).createIndex('deletedAt', 'deletedAt');
    };
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const write = (store, rows) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        for (const row of rows) tx.objectStore(store).put(row);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    const get = (store, id) =>
      new Promise(resolve => {
        const r = db.transaction(store).objectStore(store).get(id);
        r.onsuccess = () => resolve(r.result);
      });
    try {
      await write(
        'trash',
        Array.from({ length: 2301 }, (_, i) => ({
          id: String(i).padStart(5, '0'),
          deletedAt: 2301 - i,
          text: 'ordinary',
          userMeta: { note: i === 2300 ? 'rare needle in old annotation' : '', tags: ['old'] },
        }))
      );
      const pages = [];
      let cursor = null;
      const start = performance.now();
      do {
        const result = await api.readTrashPage(db, cursor, 100, 'rare needle');
        pages.push(result);
        cursor = result.nextKey;
        if (result.done) break;
      } while (pages.length < 10);
      await write('tweets', [
        { id: '02300', text: 'current evidence', userMeta: { note: 'current note', tags: ['new'], favorite: true } },
      ]);
      const stale = await api.mergeTrashMetadata(db, '02300', {
        mode: 'append-note',
        expectedNote: 'stale',
        expectedTrashNote: 'rare needle in old annotation',
      });
      const merged = await api.mergeTrashMetadata(db, '02300', {
        mode: 'append-note',
        expectedNote: 'current note',
        expectedTrashNote: 'rare needle in old annotation',
      });
      const repeated = await api.mergeTrashMetadata(db, '02300', {
        mode: 'append-note',
        expectedNote: merged.row.userMeta.note,
        expectedTrashNote: 'rare needle in old annotation',
      });
      const older = await get('trash', '02300');
      await write('trash', [{ ...older, userMeta: { ...older.userMeta, note: 'changed older note' } }]);
      const olderConflict = await api.mergeTrashMetadata(db, '02300', {
        mode: 'tags',
        expectedNote: merged.row.userMeta.note,
        expectedTrashNote: older.userMeta.note,
      });
      const snapshot = {
        id: 'capture-race',
        text: 'original capture',
        userMeta: { note: 'private evidence' },
        media: [],
      };
      await write('tweets', [snapshot]);
      const captureRace = await Promise.all([
        api.moveLibraryToTrash(db, [snapshot.id]),
        api.mergeLibraryCapture(db, { ...snapshot, text: 'late stale capture' }),
      ]);
      const raceCurrent = await get('tweets', snapshot.id),
        raceTrash = await get('trash', snapshot.id);
      return {
        pages,
        ms: performance.now() - start,
        stale,
        merged,
        repeated,
        older,
        olderConflict,
        captureRace,
        raceCurrent,
        raceTrash,
      };
    } finally {
      const name = db.name;
      db.close();
      indexedDB.deleteDatabase(name);
    }
  });
  assert.deepEqual(
    evidence.pages.map(p => p.scanned),
    [1000, 1000, 301]
  );
  assert.deepEqual(
    evidence.pages.flatMap(p => p.rows.map(r => r.id)),
    ['02300']
  );
  assert.equal(evidence.pages.at(-1).done, true);
  assert.equal(evidence.stale.conflict, true);
  assert.equal(evidence.olderConflict.conflict, true);
  assert.equal(evidence.merged.row.text, 'current evidence');
  assert.equal(evidence.merged.row.userMeta.favorite, true);
  assert.deepEqual(evidence.merged.row.userMeta.tags, ['new', 'old']);
  assert.equal(evidence.repeated.row.userMeta.note, evidence.merged.row.userMeta.note);
  assert.equal(evidence.older.userMeta.note, 'rare needle in old annotation');
  assert.equal(evidence.captureRace[1].trashed, true);
  assert.equal(evidence.raceCurrent, undefined, 'a late capture cannot resurrect a removed post');
  assert.equal(evidence.raceTrash.text, 'original capture');
  assert.equal(evidence.raceTrash.userMeta.note, 'private evidence');
  console.log(
    `PASS 2301-record sparse Trash search, 1000-record scan cap, atomic stale-preview rejection, evidence retention, idempotent merge (${Math.round(evidence.ms)}ms synthetic)`
  );
} finally {
  await browser.close();
}
