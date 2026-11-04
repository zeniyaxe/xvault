// Local OCR orchestration for the service worker. Recognition runs in an offscreen document
// (WebAssembly + a dedicated worker need a DOM context in MV3); this module owns its lifecycle and
// exposes a derived-jobs processor that stores text in xvault-derived/ocr, never in archive records.
import { HttpStatusError } from './derived-jobs.mjs';

export const OFFSCREEN_URL = 'offscreen-ocr.html';

export function createOffscreenHost(chromeApi = globalThis.chrome) {
  let creating = null;
  async function has() {
    try {
      const contexts = await chromeApi.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chromeApi.runtime.getURL(OFFSCREEN_URL)],
      });
      return contexts.length > 0;
    } catch {
      return false;
    }
  }
  async function ensure() {
    if (await has()) return;
    creating ||= chromeApi.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: 'Run the bundled OCR engine locally on archived images',
      })
      .catch(error => {
        if (!/single offscreen|already/i.test(String(error?.message))) throw error;
      })
      .finally(() => (creating = null));
    await creating;
  }
  async function send(message) {
    await ensure();
    return chromeApi.runtime.sendMessage({ target: 'xv-ocr', ...message });
  }
  async function close() {
    if (await has()) await chromeApi.offscreen.closeDocument().catch(() => {});
  }
  return { ensure, send, close, has };
}

/** Pick the rendition OCR reads: 'medium' (≈1200px) reads small print far better than thumbnails. */
export function ocrSource(item) {
  const url = String(item.fallback || item.thumb || '');
  return url.replace(/([?&]name=)(small|thumb)\b/, '$1medium');
}

export function createOcrProcessor({ store, host }) {
  return {
    concurrency: 1,
    pageSize: 200,
    eligible: item => item.type === 'photo' && !!(item.fallback || item.thumb),
    async ready() {
      const ping = await host.send({ type: 'OCR_PING' }).catch(error => ({ ok: false, error: error?.message }));
      return ping?.ok ? { ok: true } : { ok: false, error: ping?.error || 'The local OCR engine could not start' };
    },
    lookup: keys => store.getMany('ocr', keys),
    isFresh: (row, item, stamp, week) =>
      row.thumb === item.thumb && (row.state === 'ok' ? true : stamp - Number(row.at || 0) < week),
    isMissing: row => row.state !== 'ok',
    async process(item) {
      const result = await host.send({ type: 'OCR_RECOGNIZE', url: ocrSource(item) });
      if (!result?.ok) {
        if (result?.status) throw new HttpStatusError(result.status, result.retryAfterMs || 0);
        throw Error(result?.error || 'OCR failed');
      }
      return {
        key: item.key,
        postId: item.postId,
        thumb: item.thumb,
        state: 'ok',
        text: result.text,
        confidence: result.confidence,
        at: Date.now(),
      };
    },
    missingRow: (item, error, at) => ({
      key: item.key,
      postId: item.postId,
      thumb: item.thumb,
      state: 'unavailable',
      text: '',
      error: String(error?.message || ''),
      at,
    }),
    save: rows => store.putMany('ocr', rows),
    onPageSaved: () => store.bump('ocr'),
    onDone: () => host.close(),
  };
}

/**
 * In-memory postId → OCR text map for search, rebuilt only when the OCR revision changes.
 * Only queries that use ocr:/has:ocr pay for it.
 */
export function createOcrIndex(store) {
  let cached = { revision: -1, map: new Map(), loading: null };
  async function map() {
    const revision = await store.revision('ocr').catch(() => 0);
    if (revision === cached.revision) return cached.map;
    if (cached.loading) return cached.loading;
    cached.loading = (async () => {
      const next = new Map();
      for (const row of await store.getAll('ocr').catch(() => []))
        if (row.state === 'ok' && row.text) {
          const id = String(row.postId);
          next.set(id, next.has(id) ? `${next.get(id)}\n${row.text}` : row.text);
        }
      cached = { revision, map: next, loading: null };
      return next;
    })();
    return cached.loading;
  }
  return { map, revision: () => store.revision('ocr').catch(() => 0) };
}
