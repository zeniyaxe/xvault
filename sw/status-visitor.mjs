// XVault 21: one polite, resumable queue that visits post pages on x.com in a single reused
// background tab so the normal capture path can re-read them. Used by
//   • repair  — re-capture posts whose archived copy is incomplete (quality score below 70);
//   • gaps    — fetch thread parents and quoted posts that are referenced but not archived;
//   • check   — opt-in "is this still on X?" checks for favourites.
// Nothing runs without an x.com tab the user already has open, every job has a daily cap, and the
// tab is closed when the job ends, pauses or fails. Results are detected from the archive itself:
// a post counts as seen when its lastSeenAt moves past the visit, and as gone when X reports a
// tombstone (STORE_AVAILABILITY) for it.
export const VISITOR_KINDS = ['repair', 'gaps', 'check'];
const STATE_KEY = 'xvVisitorState';
const DAY = 86400000;

export function blankVisitorState() {
  return { job: null, history: [], usage: {} };
}
export function dayKey(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
/** Remaining visits today for a kind, given the per-day cap. */
export function remainingToday(state, kind, cap, now = Date.now()) {
  const used = Number(state.usage?.[dayKey(now)]?.[kind] || 0);
  return Math.max(0, Number(cap) - used);
}
/** Classifies one visit from the post record read after the visit. */
export function classifyVisit(post, startedAt) {
  if (!post) return 'missing';
  const checked = Number(post.availability?.checkedAt || 0);
  if (checked >= startedAt && post.availability?.state && post.availability.state !== 'available') return 'gone';
  if (Number(post.lastSeenAt || 0) >= startedAt || Number(post.lastObservationAt || 0) >= startedAt) return 'seen';
  return 'pending';
}
export function estimate(job, now = Date.now()) {
  if (!job) return null;
  const done = job.done || 0,
    total = job.ids.length,
    elapsed = Math.max(0, (job.activeMs || 0) + (job.status === 'running' && job.resumedAt ? now - job.resumedAt : 0));
  const perItem = done ? elapsed / done : job.perItemGuessMs || 9000;
  return {
    done,
    total,
    remaining: total - done,
    etaMs: Math.round(perItem * Math.max(0, total - done)),
    perItemMs: Math.round(perItem),
  };
}

export function createStatusVisitor(deps) {
  const {
    chromeApi = globalThis.chrome,
    activeXTab,
    readPost,
    markChecked = async () => {},
    onFound = async () => {},
    caps = async () => ({ repair: 40, gaps: 40, check: 30 }),
    log = async () => {},
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pollMs = 800,
    visitTimeoutMs = 16000,
    gapMs = [1600, 3200],
  } = deps;
  let running = null;

  async function load() {
    const stored = (await chromeApi.storage.local.get(STATE_KEY))[STATE_KEY];
    return { ...blankVisitorState(), ...(stored && typeof stored === 'object' ? stored : {}) };
  }
  const save = state => chromeApi.storage.local.set({ [STATE_KEY]: state });

  function publicStatus(state) {
    return {
      ok: true,
      job: state.job
        ? {
            id: state.job.id,
            kind: state.job.kind,
            label: state.job.label,
            status: state.job.status,
            error: state.job.error || '',
            results: state.job.results,
            current: state.job.current || null,
            createdAt: state.job.createdAt,
            estimate: estimate(state.job, now()),
          }
        : null,
      history: state.history || [],
      usage: state.usage?.[dayKey(now())] || {},
    };
  }

  async function status() {
    return publicStatus(await load());
  }

  async function start(kind, ids, { label = '', depth = 0 } = {}) {
    if (!VISITOR_KINDS.includes(kind)) throw Error('Unknown visit queue');
    const state = await load();
    if (state.job && ['running', 'paused'].includes(state.job.status))
      return {
        ...publicStatus(state),
        ok: false,
        error: 'Another visit queue is already active. Finish or cancel it first.',
      };
    const clean = [...new Set((ids || []).map(String).filter(id => /^\d{1,32}$/.test(id)))];
    if (!clean.length) return { ...publicStatus(state), ok: false, error: 'Nothing to visit.' };
    // An interrupted queue that is replaced instead of resumed still shows up in the history.
    if (state.job?.status === 'interrupted') await archive(state);
    const cap = Number((await caps())[kind]) || 0,
      left = remainingToday(state, kind, cap, now());
    if (!left)
      return {
        ...publicStatus(state),
        ok: false,
        error: `Today's ${kind} limit (${cap}) is used up. It resets at midnight.`,
      };
    state.job = {
      id: `${kind}-${now()}`,
      kind,
      label: String(label || kind).slice(0, 120),
      ids: clean.slice(0, left),
      skippedByCap: Math.max(0, clean.length - left),
      depth: Math.max(0, Math.min(5, Number(depth) || 0)),
      depthOf: {},
      index: 0,
      done: 0,
      status: 'running',
      createdAt: now(),
      resumedAt: now(),
      activeMs: 0,
      results: { seen: 0, gone: 0, notShown: 0, added: 0 },
      outcomes: {},
    };
    await save(state);
    void run();
    return publicStatus(state);
  }

  async function pause() {
    const state = await load();
    if (state.job?.status === 'running') {
      state.job.status = 'paused';
      state.job.activeMs += now() - (state.job.resumedAt || now());
      await save(state);
    }
    return publicStatus(state);
  }
  async function resume() {
    const state = await load();
    if (state.job?.status === 'paused' || state.job?.status === 'interrupted') {
      state.job.status = 'running';
      state.job.resumedAt = now();
      state.job.error = '';
      await save(state);
      void run();
    }
    return publicStatus(state);
  }
  async function cancel() {
    const state = await load();
    if (state.job && ['running', 'paused', 'interrupted'].includes(state.job.status)) {
      if (state.job.status === 'running') state.job.activeMs += now() - (state.job.resumedAt || now());
      state.job.status = 'cancelled';
      await archive(state);
    }
    return publicStatus(state);
  }
  /** After a service-worker restart a running job cannot still own its tab; mark it resumable. */
  async function recover() {
    const state = await load();
    if (state.job?.status === 'running' && !running) {
      state.job.status = 'interrupted';
      state.job.error = 'XVault restarted while visiting posts. Resume to continue.';
      if (state.job.tabId != null) await chromeApi.tabs.remove(state.job.tabId).catch(() => {});
      state.job.tabId = null;
      await save(state);
    }
    return publicStatus(state);
  }

  async function archive(state) {
    const job = state.job;
    if (job.tabId != null) await chromeApi.tabs.remove(job.tabId).catch(() => {});
    state.history = [
      {
        id: job.id,
        kind: job.kind,
        label: job.label,
        status: job.status,
        at: now(),
        visited: job.done,
        total: job.ids.length,
        skippedByCap: job.skippedByCap || 0,
        error: job.error || '',
        ...job.results,
      },
      ...(state.history || []),
    ].slice(0, 30);
    state.job = { ...job, tabId: null, finishedAt: now() };
    await save(state);
    await log(job).catch(() => {});
  }

  // Writes a few job fields onto the latest stored state, so a pause or cancel that arrived while
  // this worker was busy is never overwritten by an older copy of the job.
  async function patchJob(jobId, patch) {
    const fresh = await load();
    if (fresh.job?.id !== jobId) return null;
    Object.assign(fresh.job, patch);
    await save(fresh);
    return fresh.job;
  }

  async function ensureTab(state) {
    const job = state.job;
    if (job.tabId != null && (await chromeApi.tabs.get(job.tabId).catch(() => null))) return job.tabId;
    const xTab = await activeXTab();
    if (!xTab) throw Error('Open x.com in a tab first — visits use your signed-in X session.');
    const tab = await chromeApi.tabs.create({ url: 'about:blank', active: false, windowId: xTab.windowId });
    job.tabId = tab.id;
    if (!(await patchJob(job.id, { tabId: tab.id }))) {
      await chromeApi.tabs.remove(tab.id).catch(() => {});
      throw Error('The visit queue changed while opening its tab.');
    }
    return tab.id;
  }

  async function visitOne(state, id) {
    const tabId = await ensureTab(state),
      startedAt = now();
    state.job.current = { id, startedAt };
    await patchJob(state.job.id, { current: state.job.current });
    await chromeApi.tabs.update(tabId, { url: `https://x.com/i/status/${id}` });
    let outcome = 'pending';
    while (now() - startedAt < visitTimeoutMs) {
      await sleep(pollMs);
      const post = await readPost(id);
      outcome = classifyVisit(post, startedAt);
      if (outcome === 'seen' || outcome === 'gone') break;
      if (!(await chromeApi.tabs.get(tabId).catch(() => null))) throw Error('The visit tab was closed.');
    }
    return { outcome: outcome === 'pending' || outcome === 'missing' ? 'notShown' : outcome, startedAt };
  }

  async function run() {
    if (running) return running;
    running = (async () => {
      for (;;) {
        const state = await load(),
          job = state.job;
        if (!job || job.status !== 'running') return;
        if (job.index >= job.ids.length) {
          job.status = 'done';
          job.activeMs += now() - (job.resumedAt || now());
          job.current = null;
          await archive(state);
          return;
        }
        const id = job.ids[job.index];
        let result;
        try {
          result = await visitOne(state, id);
        } catch (error) {
          const fresh = await load();
          if (fresh.job?.id === job.id) {
            fresh.job.status = 'interrupted';
            fresh.job.error = error?.message || String(error);
            fresh.job.activeMs += now() - (fresh.job.resumedAt || now());
            if (fresh.job.tabId != null) await chromeApi.tabs.remove(fresh.job.tabId).catch(() => {});
            fresh.job.tabId = null;
            await save(fresh);
          }
          return;
        }
        const fresh = await load();
        if (!fresh.job || fresh.job.id !== job.id) return;
        const current = fresh.job;
        current.index++;
        current.done++;
        current.current = null;
        current.outcomes[id] = result.outcome;
        current.results[result.outcome] = (current.results[result.outcome] || 0) + 1;
        const day = dayKey(now());
        fresh.usage = { [day]: { ...(fresh.usage?.[day] || {}) } };
        fresh.usage[day][current.kind] = Number(fresh.usage[day][current.kind] || 0) + 1;
        await markChecked(current.kind, id, result.outcome, result.startedAt).catch(() => {});
        if (result.outcome === 'seen') {
          const extra = await onFound(current.kind, id, current.depthOf?.[id] || 0).catch(() => []);
          const depth = (current.depthOf?.[id] || 0) + 1;
          for (const next of extra || []) {
            if (depth > current.depth || current.ids.includes(String(next))) continue;
            if (
              current.ids.length - current.index >=
              remainingToday(fresh, current.kind, Number((await caps())[current.kind]) || 0, now())
            )
              break;
            current.ids.push(String(next));
            current.depthOf[String(next)] = depth;
            current.results.added++;
          }
        }
        await save(fresh);
        if (current.status !== 'running') {
          if (current.tabId != null) await chromeApi.tabs.remove(current.tabId).catch(() => {});
          current.tabId = null;
          await save(fresh);
          return;
        }
        const [low, high] = gapMs;
        await sleep(low + Math.random() * Math.max(0, high - low));
      }
    })().finally(() => (running = null));
    return running;
  }

  const MESSAGES = {
    VISIT_STATUS: () => status(),
    VISIT_PAUSE: () => pause(),
    VISIT_RESUME: () => resume(),
    VISIT_CANCEL: () => cancel(),
  };
  return {
    start,
    pause,
    resume,
    cancel,
    recover,
    status,
    run,
    types: Object.keys(MESSAGES),
    handle: message => MESSAGES[message.type](message),
  };
}
export const VISITOR_DAY = DAY;
