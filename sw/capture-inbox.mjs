// XVault 25: the capture inbox. Post links sent from a paired phone (Remote "Capture"), pasted on the Capture
// page or shared to the Remote web app land here, and one polite worker archives them through the normal
// capture path: it opens each post in a single reused background tab next to the user's signed-in x.com tab,
// lets the content script record the page, and reads the result back from the archive.
//   • Nothing is fetched from X directly and nothing runs without an x.com tab the user already has open.
//   • Duplicates are answered at once: a post already in the archive is reported as "duplicate", a link that is
//     already waiting is not queued twice.
//   • The inbox is small and bounded (chrome.storage.local), survives restarts (an interrupted visit goes back to
//     the queue) and keeps finished items for a while so a phone can show what happened to its links.
export const CAPTURE_STATES = ['queued', 'waiting', 'capturing', 'archived', 'duplicate', 'unavailable', 'failed'];
export const CAPTURE_PENDING = new Set(['queued', 'waiting', 'capturing']);
const STATE_KEY = 'xvCaptureInbox';
const MAX_ITEMS = 400;
const MAX_ATTEMPTS = 3;
// XVault 26: a slow or failed visit is retried later instead of straight away (20 s, then 90 s).
const RETRY_BACKOFF_MS = [20000, 90000];
// X limiting requests pauses the whole inbox: 5 min, doubling per strike, at most 30 min.
const COOLDOWN_MS = 5 * 60000;
const COOLDOWN_MAX_MS = 30 * 60000;
// After X asks for a sign-in, page loads do not restart captures for two minutes (a retry or resume does).
const AUTH_HOLD_MS = 2 * 60000;
const LOG_LIMIT = 6;
export const AUTH_REASON = 'X asked for a sign-in. Sign in to X in this browser, then press Retry — nothing was lost.';
const KEEP_FINISHED_MS = 30 * 86400000;
const HOSTS = /^(?:www\.|mobile\.|m\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx|twittpr)\.com$/i;
const RESERVED = new Set(['i', 'home', 'search', 'explore', 'settings', 'notifications', 'messages']);

/** One X post link → { id, handle, url } (canonical x.com URL), or null. Accepts mirrors such as fxtwitter. */
export function parseCaptureUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !HOSTS.test(url.hostname)) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const at = parts.findIndex(part => part === 'status' || part === 'statuses');
  if (at < 0 || !/^\d{1,25}$/.test(parts[at + 1] || '')) return null;
  const id = String(BigInt(parts[at + 1]));
  const before = parts.slice(0, at);
  let handle = '';
  if (before.length === 1 && /^[A-Za-z0-9_]{1,15}$/.test(before[0]) && !RESERVED.has(before[0].toLowerCase()))
    handle = before[0];
  else if (!(before.length === 0 || (before[0] === 'i' && (before.length === 1 || before[1] === 'web')))) return null;
  return { id, handle, url: `https://x.com/${handle || 'i'}/status/${id}` };
}
/** Every distinct post link in free text (a share sheet's title/text/url, a pasted list). */
export function parseCaptureText(text, limit = 50) {
  const found = new Map();
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s<>"'()]+/gi)) {
    const parsed = parseCaptureUrl(match[0].replace(/[.,;:!?]+$/, ''));
    if (parsed && !found.has(parsed.id)) found.set(parsed.id, parsed);
    if (found.size >= limit) break;
  }
  return [...found.values()];
}
export function blankInbox() {
  return { items: [], paused: false, updatedAt: 0 };
}
/** What a phone or the Capture page may see of one item. */
export function publicItem(item) {
  return {
    id: item.id,
    handle: item.handle || '',
    url: item.url,
    state: item.state,
    error: item.error || '',
    source: item.source || 'desktop',
    device: item.device || '',
    deviceId: item.deviceId || '',
    attempts: item.attempts || 0,
    maxAttempts: MAX_ATTEMPTS,
    nextAttemptAt: item.nextAttemptAt || 0,
    createdAt: item.createdAt || 0,
    updatedAt: item.updatedAt || 0,
    preview: item.preview || null,
    log: Array.isArray(item.log) ? item.log.slice(-LOG_LIMIT) : [],
  };
}
/**
 * What the capture tab shows when the post did not arrive: a sign-in wall, X limiting requests, an unavailable
 * post or X's generic error page. Pure, so the rules are unit-tested; `text` is the page's visible text.
 */
export function classifyCapturePage({ url = '', text = '' } = {}) {
  let path = '';
  try {
    path = new URL(String(url)).pathname;
  } catch {}
  const body = String(text || '').slice(0, 6000);
  if (/^\/(?:i\/flow\/(?:login|signup)|login|account\/access|i\/jf\/onboarding)/i.test(path)) return 'auth';
  if (
    /rate limit exceeded|you are over the daily limit|temporarily limited|too many requests|try again in a few minutes/i.test(
      body
    )
  )
    return 'rate-limited';
  if (
    /this (?:post|tweet) (?:is unavailable|was deleted|has been deleted|is from an account that no longer exists)|this page doesn[’']t exist|account (?:is suspended|doesn[’']t exist|has been suspended)|these posts are protected|(?:post|tweet) (?:is|has been) withheld/i.test(
      body
    )
  )
    return 'unavailable';
  if (/something went wrong\.?\s*try reloading/i.test(body)) return 'x-error';
  if (
    /(?:sign in to x|log in to x|sign in to twitter|don[’']t miss what[’']s happening|sign up now to get your own)/i.test(
      body
    )
  )
    return 'auth';
  return 'unknown';
}
const clock = at => {
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};
/** A short, display-only preview of an archived post. */
export function previewOf(post) {
  if (!post) return null;
  const media = Array.isArray(post.media) ? post.media : [];
  return {
    name: String(post.author?.name || '').slice(0, 80),
    handle: String(post.author?.handle || '').slice(0, 30),
    text: String(post.text || '').slice(0, 280),
    createdAt: post.createdAt || null,
    mediaCount: media.length,
    video: media.some(item => item?.type === 'video' || item?.type === 'animated_gif'),
  };
}
/** Drops the oldest finished items beyond the bound and anything finished long ago. */
export function prune(items, now = Date.now()) {
  const kept = items.filter(item => CAPTURE_PENDING.has(item.state) || now - (item.updatedAt || 0) < KEEP_FINISHED_MS);
  if (kept.length <= MAX_ITEMS) return kept;
  const finished = kept.filter(item => !CAPTURE_PENDING.has(item.state)).sort((a, b) => a.updatedAt - b.updatedAt);
  const drop = new Set(finished.slice(0, kept.length - MAX_ITEMS));
  return kept.filter(item => !drop.has(item));
}
/** Classifies a visit from the record read afterwards (same rules as the status visitor). */
export function classifyCapture(post, startedAt) {
  if (!post) return 'pending';
  const checked = Number(post.availability?.checkedAt || 0);
  if (checked >= startedAt && post.availability?.state && post.availability.state !== 'available') return 'unavailable';
  if (
    Number(post.archivedAt || 0) >= startedAt ||
    Number(post.lastSeenAt || 0) >= startedAt ||
    Number(post.lastObservationAt || 0) >= startedAt
  )
    return 'archived';
  return 'pending';
}

export function createCaptureInbox(deps) {
  const {
    chromeApi = globalThis.chrome,
    activeXTab,
    readPost,
    getSettings = async () => ({}),
    log = async () => {},
    onChange = () => {},
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pollMs = 700,
    visitTimeoutMs = 20000,
    gapMs = [1500, 3000],
    // Asks to be run again at `when` (background.js uses chrome.alarms so a sleeping worker wakes up).
    wake = null,
    // Reads what the capture tab shows ({ url, text }) when a post did not arrive; null when it cannot be read.
    probePage = null,
  } = deps;
  let wakeTimer = 0;
  function scheduleWake(when) {
    clearTimeout(wakeTimer);
    const delay = Math.max(1000, when - now());
    wakeTimer = setTimeout(() => void run(), delay);
    wakeTimer?.unref?.();
    try {
      wake?.(now() + delay);
    } catch {}
  }
  async function readPage(tab) {
    try {
      if (probePage) return await probePage(tab);
      const [result] =
        (await chromeApi.scripting?.executeScript?.({
          target: { tabId: tab },
          func: () => ({ url: location.href, text: (document.body?.innerText || '').slice(0, 6000) }),
        })) || [];
      return result?.result || null;
    } catch {
      return null;
    }
  }
  const entry = (outcome, startedAt, detail = '') => ({
    at: now(),
    outcome,
    ms: Math.max(0, now() - startedAt),
    detail: String(detail || '').slice(0, 140),
  });
  const withLog = (item, record) => [...(Array.isArray(item.log) ? item.log : []), record].slice(-LOG_LIMIT);
  let running = null,
    tabId = null,
    chain = Promise.resolve(),
    // Ids still waiting to be captured, kept in memory so the hot STORE_RECORDS path can skip storage reads.
    pendingIds = null;
  const remember = state => {
    pendingIds = new Set(state.items.filter(item => CAPTURE_PENDING.has(item.state)).map(item => item.id));
    return state;
  };

  async function load() {
    const stored = (await chromeApi.storage.local.get(STATE_KEY))[STATE_KEY];
    const state = { ...blankInbox(), ...(stored && typeof stored === 'object' ? stored : {}) };
    state.items = Array.isArray(state.items) ? state.items.filter(item => item && /^\d{1,25}$/.test(item.id)) : [];
    return remember(state);
  }
  // Every read-modify-write goes through one chain so a phone request never overwrites the worker's update.
  function mutate(change) {
    const next = chain.then(async () => {
      const state = await load();
      const result = await change(state);
      state.items = prune(state.items, now());
      state.updatedAt = now();
      await chromeApi.storage.local.set({ [STATE_KEY]: state });
      remember(state);
      return { state, result };
    });
    chain = next.catch(() => {});
    return next;
  }
  function summary(state) {
    const counts = {};
    for (const item of state.items) counts[item.state] = (counts[item.state] || 0) + 1;
    return {
      ok: true,
      paused: !!state.paused,
      counts,
      pending: state.items.filter(item => CAPTURE_PENDING.has(item.state)).length,
      items: [...state.items].sort((a, b) => b.createdAt - a.createdAt).map(publicItem),
      updatedAt: state.updatedAt,
      cooldownUntil: Number(state.cooldownUntil) > now() ? Number(state.cooldownUntil) : 0,
      authBlocked: Number(state.authBlockedAt || 0) > 0,
    };
  }
  async function list({ limit = 100 } = {}) {
    const result = summary(await load());
    result.items = result.items.slice(0, Math.max(1, Math.min(MAX_ITEMS, Number(limit) || 100)));
    return result;
  }

  /** Adds links (text with one or more post URLs). Answers duplicates immediately. */
  async function add(text, { source = 'desktop', device = '', deviceId = '' } = {}) {
    const links = parseCaptureText(text);
    if (!links.length)
      return { ok: false, error: 'No X post link found. Share or paste a link like x.com/name/status/123.' };
    const existing = new Map();
    for (const link of links) existing.set(link.id, await readPost(link.id).catch(() => null));
    const { state, result } = await mutate(state => {
      const added = [];
      for (const link of links) {
        const at = now(),
          known = state.items.find(item => item.id === link.id),
          archived = existing.get(link.id);
        if (known && CAPTURE_PENDING.has(known.state)) {
          added.push({ ...publicItem(known), duplicate: 'pending' });
          continue;
        }
        const item = {
          id: link.id,
          handle: link.handle || archived?.author?.handle || '',
          url: link.url,
          source: String(source).slice(0, 16),
          device: String(device || '').slice(0, 48),
          deviceId: String(deviceId || '').slice(0, 64),
          createdAt: at,
          updatedAt: at,
          attempts: 0,
          state: archived ? 'duplicate' : 'queued',
          error: '',
          preview: archived ? previewOf(archived) : null,
        };
        state.items = state.items.filter(row => row.id !== link.id);
        state.items.push(item);
        added.push({ ...publicItem(item), duplicate: archived ? 'archived' : null });
      }
      return added;
    });
    onChange();
    if (result.some(item => item.state === 'queued')) void run();
    return { ...summary(state), ok: true, added: result };
  }

  async function control(action, id = '') {
    const { state } = await mutate(state => {
      const item = id ? state.items.find(row => row.id === String(id)) : null;
      // An explicit retry or resume is the reader saying "try now": it lifts a sign-in hold and a cooldown.
      if (['retry', 'retry-all', 'resume'].includes(action)) {
        state.authBlockedAt = 0;
        state.cooldownUntil = 0;
      }
      if (action === 'retry' && item && (!CAPTURE_PENDING.has(item.state) || item.state === 'waiting')) {
        Object.assign(item, { state: 'queued', error: '', attempts: 0, nextAttemptAt: 0, updatedAt: now() });
      } else if (action === 'retry-all') {
        for (const row of state.items)
          if (['failed', 'unavailable', 'waiting'].includes(row.state) || (row.state === 'queued' && row.nextAttemptAt))
            Object.assign(row, { state: 'queued', error: '', attempts: 0, nextAttemptAt: 0, updatedAt: now() });
      } else if (action === 'remove' && item && item.state !== 'capturing') {
        state.items = state.items.filter(row => row !== item);
      } else if (action === 'clear') {
        state.items = state.items.filter(row => CAPTURE_PENDING.has(row.state));
      } else if (action === 'pause') state.paused = true;
      else if (action === 'resume') state.paused = false;
      else if (!['retry', 'remove'].includes(action)) throw Error('Unknown capture inbox action');
    });
    onChange();
    if (!state.paused) void run();
    return summary(state);
  }

  /** A post arrived through any capture path: settle matching inbox items without waiting for the poll. */
  async function noticeStored(ids) {
    const wanted = new Set((ids || []).map(String));
    if (pendingIds && ![...wanted].some(id => pendingIds.has(id))) return;
    const current = await load();
    if (
      !current.items.some(item => wanted.has(item.id) && CAPTURE_PENDING.has(item.state) && item.state !== 'capturing')
    )
      return;
    const posts = new Map();
    for (const id of wanted)
      if (current.items.some(item => item.id === id)) posts.set(id, await readPost(id).catch(() => null));
    await mutate(state => {
      for (const item of state.items)
        if (wanted.has(item.id) && ['queued', 'waiting'].includes(item.state) && posts.get(item.id))
          Object.assign(item, {
            state: 'archived',
            error: '',
            preview: previewOf(posts.get(item.id)),
            updatedAt: now(),
          });
    });
    onChange();
  }

  async function closeTab() {
    if (tabId != null) await chromeApi.tabs.remove(tabId).catch(() => {});
    tabId = null;
  }
  async function ensureTab(xTab) {
    if (tabId != null && (await chromeApi.tabs.get(tabId).catch(() => null))) return tabId;
    const tab = await chromeApi.tabs.create({ url: 'about:blank', active: false, windowId: xTab.windowId });
    tabId = tab.id;
    return tabId;
  }
  async function setItem(id, patch) {
    await mutate(state => {
      const item = state.items.find(row => row.id === id);
      if (item) Object.assign(item, patch, { updatedAt: now() });
    });
    onChange();
  }
  // Items wait (instead of failing) while capture cannot run; they start by themselves once it can.
  async function holdAll(reason) {
    await mutate(state => {
      for (const item of state.items)
        if (item.state === 'queued' || (item.state === 'waiting' && item.error !== reason))
          Object.assign(item, { state: 'waiting', error: reason, updatedAt: now() });
    });
    onChange();
  }

  async function visit(item, xTab) {
    const id = item.id,
      tab = await ensureTab(xTab),
      startedAt = now();
    await setItem(id, { state: 'capturing', error: '', attempts: (item.attempts || 0) + 1, startedAt });
    await chromeApi.tabs.update(tab, { url: item.url });
    let outcome = 'pending';
    while (now() - startedAt < visitTimeoutMs) {
      await sleep(pollMs);
      outcome = classifyCapture(await readPost(id).catch(() => null), startedAt);
      if (outcome !== 'pending') break;
      const current = await chromeApi.tabs.get(tab).catch(() => null);
      if (!current) {
        tabId = null;
        throw Error('The capture tab was closed.');
      }
      // X redirecting the post to its sign-in flow is known at once; no need to wait for the timeout.
      if (current.url && classifyCapturePage({ url: current.url }) === 'auth') return { outcome: 'auth', startedAt };
    }
    if (outcome !== 'pending') return { outcome, startedAt };
    // The post never arrived: look at what X is showing instead.
    const page = await readPage(tab);
    const seen = page ? classifyCapturePage(page) : 'unknown';
    return { outcome: seen === 'unknown' ? 'pending' : seen, startedAt };
  }

  async function run() {
    if (running) return running;
    running = (async () => {
      try {
        for (;;) {
          const state = await load();
          if (state.paused) return;
          const at = now();
          if (Number(state.cooldownUntil) > at) return scheduleWake(Number(state.cooldownUntil));
          if (Number(state.authBlockedAt) > 0 && at - Number(state.authBlockedAt) < AUTH_HOLD_MS) return;
          const pending = state.items.filter(item => item.state === 'queued' || item.state === 'waiting');
          const next = pending
            .filter(item => !(Number(item.nextAttemptAt) > at))
            .sort((a, b) => a.createdAt - b.createdAt)[0];
          if (!next) {
            const later = pending.map(item => Number(item.nextAttemptAt) || 0).filter(Boolean);
            if (!later.length) return;
            const when = Math.min(...later);
            // A short backoff is waited out here; a long one asks for a wake-up (the worker may sleep meanwhile).
            if (when - at <= 25000) {
              await sleep(Math.max(0, when - at));
              continue;
            }
            return scheduleWake(when);
          }
          const settings = await getSettings();
          if (settings.captureWhileBrowsing === false)
            return holdAll('Turn on “Capture while browsing” in XVault so opened posts are recorded.');
          const xTab = await activeXTab();
          if (!xTab) return holdAll('Waiting for x.com — open X on the computer; captures use your signed-in session.');
          let outcome, startedAt;
          try {
            ({ outcome, startedAt } = await visit(next, xTab));
          } catch (error) {
            const attempts = (next.attempts || 0) + 1,
              failed = attempts >= MAX_ATTEMPTS,
              message = String(error?.message || error).slice(0, 160);
            await setItem(next.id, {
              state: failed ? 'failed' : 'queued',
              error: failed ? message : `${message} Trying again at ${clock(now() + RETRY_BACKOFF_MS[attempts - 1])}.`,
              nextAttemptAt: failed ? 0 : now() + (RETRY_BACKOFF_MS[attempts - 1] || 90000),
              log: withLog(next, entry('error', now(), message)),
            });
            await sleep(gapMs[0]);
            continue;
          }
          const post = outcome === 'archived' ? await readPost(next.id).catch(() => null) : null;
          const attempts = (next.attempts || 0) + 1;
          const record = entry(outcome, startedAt);
          if (outcome === 'archived') {
            await setItem(next.id, {
              state: 'archived',
              error: '',
              nextAttemptAt: 0,
              preview: previewOf(post),
              log: withLog(next, record),
            });
            await mutate(state => {
              state.rateStrikes = 0;
              state.authBlockedAt = 0;
            });
          } else if (outcome === 'unavailable')
            await setItem(next.id, {
              state: 'unavailable',
              error: 'X says this post is unavailable (deleted, protected or withheld).',
              nextAttemptAt: 0,
              log: withLog(next, record),
            });
          else if (outcome === 'auth') {
            // Not the post's fault: keep its attempts, hold everything, and wait for the reader to sign in.
            await setItem(next.id, {
              state: 'waiting',
              error: AUTH_REASON,
              attempts: next.attempts || 0,
              log: withLog(next, { ...record, detail: 'Sign-in wall' }),
            });
            await mutate(state => {
              state.authBlockedAt = now();
            });
            await holdAll(AUTH_REASON);
            await log(next, outcome).catch(() => {});
            return;
          } else if (outcome === 'rate-limited') {
            let until = 0;
            await mutate(state => {
              const strikes = Number(state.rateStrikes || 0);
              until = now() + Math.min(COOLDOWN_MAX_MS, COOLDOWN_MS * 2 ** strikes);
              state.rateStrikes = strikes + 1;
              state.cooldownUntil = until;
            });
            const reason = `X is limiting requests right now. Capture resumes by itself at ${clock(until)}.`;
            await setItem(next.id, {
              state: 'waiting',
              error: reason,
              attempts: next.attempts || 0,
              log: withLog(next, { ...record, detail: 'Rate limited' }),
            });
            await holdAll(reason);
            await log(next, outcome).catch(() => {});
            scheduleWake(until);
            return;
          } else if (attempts < MAX_ATTEMPTS) {
            const retryAt = now() + (RETRY_BACKOFF_MS[attempts - 1] || 90000);
            await setItem(next.id, {
              state: 'queued',
              error: `${outcome === 'x-error' ? 'X showed “Something went wrong”' : 'X did not show the post in time'}; trying again at ${clock(retryAt)}.`,
              nextAttemptAt: retryAt,
              log: withLog(next, record),
            });
          } else
            await setItem(next.id, {
              state: 'failed',
              error:
                outcome === 'x-error'
                  ? `X showed “Something went wrong” on ${MAX_ATTEMPTS} tries. Retry later; the link is kept.`
                  : `X did not show this post after ${MAX_ATTEMPTS} tries. Check that you are signed in to X on the computer, then retry.`,
              nextAttemptAt: 0,
              log: withLog(next, record),
            });
          await log(next, outcome).catch(() => {});
          const [low, high] = gapMs;
          await sleep(low + Math.random() * Math.max(0, high - low));
        }
      } finally {
        await closeTab();
      }
    })().finally(() => (running = null));
    return running;
  }

  /** After a service-worker restart no visit is in flight: an item caught mid-visit goes back to the queue. */
  async function recover() {
    const { state } = await mutate(state => {
      for (const item of state.items)
        if (item.state === 'capturing') Object.assign(item, { state: 'queued', updatedAt: now() });
    });
    if (state.items.some(item => item.state === 'queued' || item.state === 'waiting') && !state.paused) void run();
    return summary(state);
  }

  const MESSAGES = {
    CAPTURE_INBOX_LIST: message => list(message),
    CAPTURE_INBOX_ADD: message => add(message.text, { source: 'desktop' }),
    CAPTURE_INBOX_CONTROL: message => control(String(message.action || ''), String(message.id || '')),
  };
  return {
    add,
    list,
    control,
    run,
    recover,
    noticeStored,
    /** True when items are queued or waiting (from memory; null until the inbox was read once). */
    hasPending: () => (pendingIds ? pendingIds.size > 0 : null),
    types: Object.keys(MESSAGES),
    handle: message => MESSAGES[message.type](message),
  };
}
