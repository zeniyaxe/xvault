// Service-worker wiring for derived-data jobs: message handling, alarms and progress broadcast.
import { createDerivedStore } from './derived-store.mjs';
import { fingerprintBlob } from './image-hash.mjs';
import { createOcrProcessor, createOffscreenHost, createOcrIndex } from './ocr.mjs';
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
    ocr: createOcrProcessor({ store, host: createOffscreenHost(chromeApi) }),
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
  MESSAGES.DERIVED_SUMMARY = async () => ({
    ok: true,
    jobs: await jobs.status(),
    counts: { phash: await store.count('phash').catch(() => 0), ocr: (await ocrIndex.map()).size },
  });
  return {
    store,
    jobs,
    ocrIndex,
    handles: type => Object.hasOwn(MESSAGES, type),
    handle: message => MESSAGES[message.type](message),
    onAlarm: name => (name === RESUME_ALARM ? (jobs.resume(), true) : false),
    resume: () => jobs.resume(),
  };
}
