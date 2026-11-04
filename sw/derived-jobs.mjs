// Resumable background jobs that derive data from archived media (look-alike fingerprints, OCR).
//
// MV3 lifecycle: the service worker can be terminated at any time. Job state is checkpointed to
// chrome.storage.local after every page, the media cursor only advances once a page is complete,
// and a one-minute alarm restarts the pump after termination. Nothing assumes a long-lived page.
//
// X CDN etiquette: bounded concurrency, exponential backoff on 429/5xx (honouring Retry-After),
// permanent "unavailable" records for 404/410 so they are not refetched for a week, and a retry cap.

export const JOB_KINDS = ['phash', 'ocr'];
export const RESUME_ALARM = 'xv-derived-resume';
export const CHANNEL = 'xvault-derived-jobs';
const STATE_KEY = 'xvDerivedJobs';
const WEEK = 7 * 86400000;
const MAX_ATTEMPTS = 4;

export class HttpStatusError extends Error {
  constructor(status, retryAfterMs = 0) {
    super(`HTTP ${status}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
export const transient = error =>
  !(error instanceof HttpStatusError) || error.status === 429 || error.status === 408 || error.status >= 500;

export function retryAfterMs(response, now = Date.now()) {
  const header = response?.headers?.get?.('retry-after');
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

export function backoffDelay(failures, retryAfter = 0) {
  const exponential = Math.min(15 * 60000, 30000 * 2 ** Math.max(0, failures - 1));
  return Math.max(retryAfter, exponential);
}

export function blankJob(kind, now = Date.now()) {
  return {
    kind,
    state: 'idle',
    cursor: null,
    exhausted: false,
    seen: 0,
    processed: 0,
    cached: 0,
    failed: 0,
    skipped: 0,
    pages: 0,
    total: 0,
    startedAt: 0,
    updatedAt: now,
    finishedAt: 0,
    backoffUntil: 0,
    failures: 0,
    attempts: {},
    error: '',
    message: '',
  };
}

/**
 * @param {object} deps
 *  - storage: { get(key), set(object) } (chrome.storage.local shape)
 *  - alarms: chrome.alarms-like { create(name, info), clear(name) }
 *  - listPage(cursor, limit) → { items, nextKey, done }
 *  - processors: { [kind]: { eligible(item), isFresh(row, item, now), lookup(keys) → Map, process(item, signal) → row, save(rows), concurrency, onPageSaved? } }
 *  - broadcast(message)
 *  - now()
 */
export function createDerivedJobs(deps) {
  const { storage, alarms, listPage, processors, broadcast = () => {}, now = () => Date.now() } = deps;
  const running = new Map();
  let states = null;

  async function load() {
    if (states) return states;
    const stored = (await storage.get(STATE_KEY))?.[STATE_KEY] || {};
    states = Object.fromEntries(JOB_KINDS.map(kind => [kind, { ...blankJob(kind, now()), ...(stored[kind] || {}) }]));
    return states;
  }
  async function persist(kind) {
    const all = await load();
    all[kind].updatedAt = now();
    await storage.set({ [STATE_KEY]: all });
    broadcast({ type: 'DERIVED_JOB', kind, job: publicJob(all[kind]) });
  }
  const publicJob = job => {
    const { attempts, ...rest } = job;
    return { ...rest, retrying: Object.keys(attempts || {}).length };
  };

  async function ensureAlarm() {
    const all = await load();
    const active = JOB_KINDS.some(kind => ['running', 'waiting'].includes(all[kind].state));
    try {
      if (active) await alarms.create(RESUME_ALARM, { periodInMinutes: 1 });
      else await alarms.clear(RESUME_ALARM);
    } catch {}
  }

  async function status() {
    const all = await load();
    return Object.fromEntries(JOB_KINDS.map(kind => [kind, publicJob(all[kind])]));
  }

  async function start(kind, { restart = false, total = 0 } = {}) {
    if (!processors[kind]) throw Error(`Unknown derived job: ${kind}`);
    const all = await load(),
      job = all[kind];
    if (restart || ['done', 'cancelled', 'error', 'idle'].includes(job.state)) {
      // A finished scan restarted from the top re-uses every cached result, so it only does new work.
      all[kind] = { ...blankJob(kind, now()), state: 'running', startedAt: now(), total: Number(total) || job.total };
    } else {
      job.state = 'running';
      job.error = '';
      if (total) job.total = Number(total);
    }
    await persist(kind);
    await ensureAlarm();
    pump(kind);
    return publicJob(all[kind]);
  }
  async function pause(kind) {
    const all = await load();
    if (['running', 'waiting'].includes(all[kind].state)) all[kind].state = 'paused';
    running.get(kind)?.abort();
    await persist(kind);
    await ensureAlarm();
    return publicJob(all[kind]);
  }
  async function cancel(kind) {
    const all = await load();
    running.get(kind)?.abort();
    all[kind] = { ...blankJob(kind, now()), state: 'cancelled', total: all[kind].total };
    await persist(kind);
    await ensureAlarm();
    return publicJob(all[kind]);
  }

  /** Called from the resume alarm and on service-worker start-up. */
  async function resume() {
    const all = await load();
    for (const kind of JOB_KINDS) if (['running', 'waiting'].includes(all[kind].state)) pump(kind);
    await ensureAlarm();
  }

  function pump(kind) {
    if (running.has(kind)) return running.get(kind).promise;
    const controller = new AbortController();
    const promise = loop(kind, controller.signal)
      .catch(async error => {
        const all = await load();
        all[kind].state = 'error';
        all[kind].error = error?.message || String(error);
        await persist(kind);
      })
      .finally(async () => {
        running.delete(kind);
        await ensureAlarm();
      });
    controller.promise = promise;
    running.set(kind, controller);
    return promise;
  }

  async function loop(kind, signal) {
    const processor = processors[kind],
      all = await load();
    for (;;) {
      const job = all[kind];
      if (signal.aborted || !['running', 'waiting'].includes(job.state)) return;
      if (job.backoffUntil > now()) {
        job.state = 'waiting';
        job.message = `X is rate-limiting media; resuming ${new Date(job.backoffUntil).toLocaleTimeString()}`;
        await persist(kind);
        try {
          await alarms.create(RESUME_ALARM, { when: job.backoffUntil, periodInMinutes: 1 });
        } catch {}
        return;
      }
      job.state = 'running';
      job.message = '';
      if (processor.ready) {
        const ready = await processor.ready();
        if (!ready.ok) {
          job.state = 'error';
          job.error = ready.error;
          await persist(kind);
          return;
        }
      }
      const page = await listPage(job.cursor, processor.pageSize || 400);
      const items = (page.items || []).filter(item => processor.eligible(item));
      const cache = await processor.lookup(items.map(item => item.key));
      const stamp = now(),
        queue = [];
      let cached = 0,
        skipped = 0;
      for (const item of items) {
        const hit = cache.get(item.key);
        if (hit && processor.isFresh(hit, item, stamp, WEEK)) {
          if (processor.isMissing?.(hit)) skipped++;
          else cached++;
        } else queue.push(item);
      }
      const result = await processQueue(kind, processor, queue, signal);
      if (result.saved.length) await processor.save(result.saved);
      job.processed += result.processed;
      job.failed += result.failed;
      if (result.rateLimited) {
        // Keep the cursor on this page; cached results make the retry cheap.
        job.failures += 1;
        job.backoffUntil = now() + backoffDelay(job.failures, result.retryAfter);
        await persist(kind);
        continue;
      }
      if (signal.aborted) {
        await persist(kind);
        return;
      }
      job.failures = 0;
      job.seen += items.length;
      job.cached += cached;
      job.skipped += skipped;
      job.pages += 1;
      job.cursor = page.nextKey ?? null;
      job.exhausted = !!page.done || job.cursor == null;
      if (result.saved.length) await processor.onPageSaved?.();
      if (job.exhausted) {
        job.state = 'done';
        job.finishedAt = now();
        job.attempts = {};
        await persist(kind);
        await processor.onDone?.(job);
        return;
      }
      await persist(kind);
    }
  }

  async function processQueue(kind, processor, queue, signal) {
    const job = states[kind],
      saved = [];
    let next = 0,
      processed = 0,
      failed = 0,
      rateLimited = false,
      retryAfter = 0;
    const worker = async () => {
      while (!signal.aborted && !rateLimited && next < queue.length) {
        const item = queue[next++];
        try {
          const row = await processor.process(item, signal);
          if (row) saved.push(row);
          processed++;
          delete job.attempts[item.key];
        } catch (error) {
          if (signal.aborted) return;
          const attempts = (job.attempts[item.key] || 0) + 1;
          if (transient(error) && attempts < MAX_ATTEMPTS) {
            job.attempts[item.key] = attempts;
            if (error?.status === 429 || error?.status >= 500) {
              rateLimited = true;
              retryAfter = Math.max(retryAfter, Number(error.retryAfterMs) || 0);
            } else queue.push(item); // network hiccup: retry later in this batch
          } else {
            delete job.attempts[item.key];
            failed++;
            const missing = processor.missingRow?.(item, error, now());
            if (missing) saved.push(missing);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, processor.concurrency || 3) }, worker));
    // Keep the attempt map bounded even on pathological archives.
    const keys = Object.keys(job.attempts);
    if (keys.length > 2000) for (const key of keys.slice(0, keys.length - 2000)) delete job.attempts[key];
    return { saved, processed, failed, rateLimited, retryAfter };
  }

  return { start, pause, cancel, resume, status, pump, _states: () => states };
}

/** Look-alike fingerprints from the larger `small` rendition, falling back to the thumbnail. */
export function createPhashProcessor({ store, fetchImage, fingerprintBlob, concurrency = 3 }) {
  return {
    concurrency,
    eligible: item => !!item.thumb,
    lookup: keys => store.getMany('phash', keys),
    isFresh: (row, item, stamp, week) =>
      row.thumb === item.thumb && (row.h ? true : stamp - Number(row.at || 0) < week),
    isMissing: row => !row.h,
    async process(item, signal) {
      let blob;
      try {
        blob = await fetchImage(item.fallback || item.thumb, signal);
      } catch (error) {
        if (!item.fallback || item.fallback === item.thumb || (error?.status && transient(error))) throw error;
        blob = await fetchImage(item.thumb, signal);
      }
      const prints = await fingerprintBlob(blob);
      return { key: item.key, thumb: item.thumb, ...prints, src: 'small', at: Date.now() };
    },
    missingRow: (item, error, at) => ({
      key: item.key,
      thumb: item.thumb,
      h: '',
      error: String(error?.message || ''),
      at,
    }),
    save: rows => store.putMany('phash', rows),
    onPageSaved: () => store.bump('phash'),
  };
}

export async function fetchCdnImage(url, signal, fetcher = fetch) {
  const response = await fetcher(url, { credentials: 'omit', cache: 'force-cache', signal });
  if (!response.ok) throw new HttpStatusError(response.status, retryAfterMs(response));
  const type = response.headers.get('content-type') || '';
  if (type && !/^image\//i.test(type)) throw new HttpStatusError(415);
  return response.blob();
}
