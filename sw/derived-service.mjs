// Service-worker wiring for derived-data jobs: message handling, alarms and progress broadcast.
import { createDerivedStore } from './derived-store.mjs';
import { fingerprintBlob, fromHex, hamming } from './image-hash.mjs';
import { createOcrProcessor, createOcrHost, createOcrIndex } from './ocr.mjs';
import {
  createDerivedJobs,
  createPhashProcessor,
  fetchCdnImage,
  RESUME_ALARM,
  CHANNEL,
  JOB_KINDS,
} from './derived-jobs.mjs';

export function createDerivedService({ listPage, extraProcessors = {}, chromeApi = globalThis.chrome } = {}) {
  const store = createDerivedStore();
  let channel = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {}
  const processors = {
    phash: createPhashProcessor({ store, fetchImage: fetchCdnImage, fingerprintBlob }),
    ocr: createOcrProcessor({ store, host: createOcrHost(chromeApi) }),
    ...Object.fromEntries(Object.entries(extraProcessors).map(([kind, factory]) => [kind, factory({ store })])),
  };
  const jobs = createDerivedJobs({
    storage: chromeApi.storage.local,
    alarms: chromeApi.alarms,
    listPage,
    processors,
    broadcast: message => channel?.postMessage(message),
  });

  const MESSAGES = {
    DERIVED_JOB_STATUS: async () => ({ ok: true, jobs: await jobs.status() }),
    DERIVED_JOB_START: async m => ({
      ok: true,
      job: await jobs.start(kind(m), { restart: !!m.restart, total: m.total }),
    }),
    DERIVED_JOB_PAUSE: async m => ({ ok: true, job: await jobs.pause(kind(m)) }),
    DERIVED_JOB_CANCEL: async m => ({ ok: true, job: await jobs.cancel(kind(m)) }),
    DERIVED_CLEAR: async m => {
      const name = kind(m);
      await jobs.cancel(name);
      await store.clear(name);
      return { ok: true };
    },
  };
  function kind(message) {
    const value = String(message?.kind || '');
    if (!JOB_KINDS.includes(value) || !processors[value]) throw Error('Unknown derived job');
    return value;
  }
  const ocrIndex = createOcrIndex(store);
  MESSAGES.OCR_TEXT_FOR_POSTS = async m => {
    const ids = (Array.isArray(m.ids) ? m.ids : []).slice(0, 500).map(String),
      index = await ocrIndex.map();
    return { ok: true, text: Object.fromEntries(ids.filter(id => index.has(id)).map(id => [id, index.get(id)])) };
  };
  // Search by image (XVault 20): the page fingerprints the uploaded image with the same hashes and the
  // worker compares it against every stored look-alike fingerprint. Nothing leaves the browser.
  MESSAGES.SEARCH_BY_IMAGE = async m => {
    const valid = value => /^[0-9a-f]{16}$/i.test(String(value || ''));
    if (typeof m.key === 'string' && m.key.length <= 128) {
      // "Find look-alikes" for an archived image reuses its stored fingerprint.
      const own = (await store.getMany('phash', [m.key])).get(m.key);
      if (!own?.h)
        throw Error('This image has no fingerprint yet. Run look-alike fingerprinting in Atlas › Duplicate Lab.');
      m = { ...m, p: own.p, h: own.h };
    }
    if (!valid(m.p) && !valid(m.h)) throw Error('Image fingerprint required');
    const wantedP = valid(m.p) ? fromHex(m.p) : null,
      wantedH = valid(m.h) ? fromHex(m.h) : null,
      limit = Math.max(1, Math.min(200, Number(m.limit) || 60)),
      threshold = Math.max(0, Math.min(24, Number(m.threshold) || 14)),
      rows = await store.getAll('phash'),
      hits = [];
    for (const row of rows) {
      if (!row.h) continue;
      const p = wantedP && valid(row.p) ? hamming(wantedP, fromHex(row.p)) : 64,
        h = wantedH && valid(row.h) ? hamming(wantedH, fromHex(row.h)) : 64,
        distance = Math.min(p, h + 2);
      if (distance <= threshold)
        hits.push({ key: row.key, postId: String(row.key).split(':')[0], thumb: row.thumb, distance });
    }
    hits.sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key));
    return { ok: true, fingerprinted: rows.filter(row => row.h).length, hits: hits.slice(0, limit) };
  };
  MESSAGES.DERIVED_SUMMARY = async () => ({
    ok: true,
    jobs: await jobs.status(),
    counts: { phash: await store.count('phash').catch(() => 0), ocr: (await ocrIndex.map()).size },
  });
  return {
    store,
    jobs,
    ocrIndex,
    types: Object.keys(MESSAGES),
    handles: type => Object.hasOwn(MESSAGES, type),
    handle: message => MESSAGES[message.type](message),
    onAlarm: name => (name === RESUME_ALARM ? (jobs.resume(), true) : false),
    resume: () => jobs.resume(),
  };
}
