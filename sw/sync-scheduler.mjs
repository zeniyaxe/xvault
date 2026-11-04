// Scheduled Bookmarks / Likes sync. Opt-in, and only when an X tab is already open (so the user's
// own signed-in session is used and XVault never signs in or stores credentials).
//
// Each run opens the source in a background tab of the same window, asks the content script for a
// short, capped direct-crawler pass (newest pages only — earlier posts are deduplicated by the
// normal merge path), then closes the tab. State is checkpointed so a terminated service worker
// picks up the run on the next alarm. Failures back off exponentially; a run never overlaps another.

export const SYNC_ALARM = 'xv-sync-tick';
export const SYNC_SCOPES = ['bookmarks', 'likes'];
export const SCOPE_URLS = { bookmarks: 'https://x.com/i/history', likes: 'https://x.com/i/history/likes' };
const STATE_KEY = 'xvSyncState';
const MINUTE = 60000;
const RUN_TIMEOUT = 20 * MINUTE;

export function intervalFor(settings, scope) {
  const minutes = Number(settings[scope === 'likes' ? 'syncLikesMinutes' : 'syncBookmarksMinutes']) || 0;
  return minutes > 0 ? Math.max(30, minutes) * MINUTE : 0;
}

export function scoreTemplate(template, kind) {
  const operation = template?.operation || '',
    path = template?.pagePath || '';
  let score = 0;
  if (kind === 'bookmarks') {
    if (/bookmark/i.test(operation)) score += 100;
    if (path === '/i/history' || path === '/i/bookmarks') score += 90;
    if (/like/i.test(operation)) score -= 100;
  }
  if (kind === 'likes') {
    if (/like|favorite/i.test(operation)) score += 100;
    if (path === '/i/history/likes') score += 100;
  }
  return score;
}
export function pickTemplate(templates, kind) {
  return (
    Object.values(templates || {})
      .map(template => ({ template, score: scoreTemplate(template, kind) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)[0]?.template || null
  );
}

export function blankSyncState() {
  return { lastRun: {}, lastResult: {}, failures: {}, retryAt: {}, current: null, history: [], waitingForTab: false };
}

/** Which scopes are due now, oldest first. */
export function dueScopes(settings, state, now = Date.now()) {
  if (!settings.syncEnabled || settings.syncPaused) return [];
  return SYNC_SCOPES.filter(scope => {
    const interval = intervalFor(settings, scope);
    if (!interval) return false;
    if (Number(state.retryAt?.[scope] || 0) > now) return false;
    return now - Number(state.lastRun?.[scope] || 0) >= interval;
  }).sort((a, b) => Number(state.lastRun?.[a] || 0) - Number(state.lastRun?.[b] || 0));
}

export function failureDelay(failures, interval) {
  return Math.min(Math.max(interval, 30 * MINUTE), 15 * MINUTE * 2 ** Math.max(0, failures - 1));
}

export function createSyncScheduler(deps) {
  const {
    chromeApi = globalThis.chrome,
    getSettings,
    setSettings,
    activeXTab,
    sendToX,
    getJob,
    postsArchivedSince,
    matchesQuery,
    notify,
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = deps;
  let ticking = null;

  async function load() {
    const stored = (await chromeApi.storage.local.get(STATE_KEY))[STATE_KEY];
    return { ...blankSyncState(), ...(stored || {}) };
  }
  const save = state => chromeApi.storage.local.set({ [STATE_KEY]: state });

  async function schedule(settings) {
    try {
      if (settings.syncEnabled) await chromeApi.alarms.create(SYNC_ALARM, { periodInMinutes: 5, delayInMinutes: 1 });
      else await chromeApi.alarms.clear(SYNC_ALARM);
    } catch {}
  }

  async function waitForTab(tabId, timeout = 45000) {
    const started = now();
    while (now() - started < timeout) {
      const tab = await chromeApi.tabs.get(tabId).catch(() => null);
      if (!tab) throw Error('The sync tab was closed');
      if (tab.status === 'complete') {
        const ping = await sendToX(tabId, { type: 'XV_GET_TEMPLATES' });
        if (ping?.ok) return ping;
      }
      await sleep(1000);
    }
    throw Error('X did not finish loading in time');
  }

  async function start(scope, state, settings, { manual = false } = {}) {
    const xTab = await activeXTab();
    if (!xTab) {
      state.waitingForTab = true;
      await save(state);
      return { ok: false, error: 'Open x.com in a tab first — scheduled sync uses your signed-in X session.' };
    }
    state.waitingForTab = false;
    const runId = crypto.randomUUID(),
      startedAt = now();
    const tab = await chromeApi.tabs.create({ url: SCOPE_URLS[scope], active: false, windowId: xTab.windowId });
    state.current = { scope, runId, tabId: tab.id, startedAt, manual, phase: 'loading' };
    await save(state);
    try {
      const ready = await waitForTab(tab.id);
      const stored = (await chromeApi.storage.local.get('graphqlTemplates')).graphqlTemplates || {};
      const template = pickTemplate({ ...stored, ...(ready.templates || {}) }, scope);
      if (!template)
        throw Error(
          `XVault has not learned the ${scope} request yet. Open your ${scope} on X once and scroll a little.`
        );
      const reply = await sendToX(tab.id, {
        type: 'XV_SMART_START',
        runId,
        source: scope,
        template,
        fullMirror: false,
        scheduled: true,
        maxPages: Math.max(1, Math.min(20, Number(settings.syncMaxPages) || 3)),
      });
      if (reply && reply.ok === false) throw Error(reply.error || 'The X tab refused the sync');
      state.current.phase = 'running';
      await save(state);
      return { ok: true, runId, scope };
    } catch (error) {
      await finish(state, settings, { state: 'error', error: error?.message || String(error) });
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async function finish(state, settings, job) {
    const current = state.current;
    if (!current) return;
    state.current = null;
    if (current.tabId != null) await chromeApi.tabs.remove(current.tabId).catch(() => {});
    const scope = current.scope,
      ok = job?.state === 'complete';
    const fresh = ok ? await postsArchivedSince(current.startedAt).catch(() => []) : [];
    const inScope = fresh.filter(post =>
      [...(post.sourceFlags || []), ...(post.archiveSources || [])].some(source => String(source) === scope)
    );
    const added = inScope.length || fresh.length;
    state.lastRun[scope] = now();
    state.lastResult[scope] = { at: now(), ok, added, error: ok ? '' : job?.error || 'Sync did not finish' };
    if (ok) {
      state.failures[scope] = 0;
      delete state.retryAt[scope];
    } else {
      state.failures[scope] = Number(state.failures[scope] || 0) + 1;
      state.retryAt[scope] = now() + failureDelay(state.failures[scope], intervalFor(settings, scope));
    }
    state.history = [{ scope, ...state.lastResult[scope], manual: !!current.manual }, ...(state.history || [])].slice(
      0,
      20
    );
    await save(state);
    if (ok && added && settings.syncNotifications !== false)
      await notifyMatches(settings, scope, fresh, added).catch(() => {});
  }

  async function notifyMatches(settings, scope, fresh, added) {
    const watched = new Set((settings.syncNotifyViews || []).map(String));
    const views = (settings.savedViews || []).filter(view => watched.has(String(view.id)) && view.query);
    let notified = false;
    for (const view of views.slice(0, 5)) {
      const hits = fresh.filter(post => matchesQuery(post, view.query)).length;
      if (hits) {
        notified = true;
        await notify(`${hits} new in “${view.name}”`, `Scheduled ${scope} sync found posts matching ${view.query}`);
      }
    }
    if (!notified && settings.syncNotifyAll)
      await notify('XVault sync', `${added} new ${scope === 'likes' ? 'liked posts' : 'bookmarks'} archived`);
  }

  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const settings = await getSettings(),
        state = await load();
      await schedule(settings);
      if (state.current) {
        const job = await getJob(state.current.runId).catch(() => null);
        const expired = now() - state.current.startedAt > RUN_TIMEOUT;
        if (job && ['complete', 'error', 'cancelled'].includes(job.state)) await finish(state, settings, job);
        else if (expired) await finish(state, settings, { state: 'error', error: 'Timed out' });
        else if (!(await chromeApi.tabs.get(state.current.tabId).catch(() => null)))
          await finish(state, settings, { state: 'error', error: 'The sync tab was closed' });
        return status();
      }
      const [scope] = dueScopes(settings, state, now());
      if (scope) await start(scope, state, settings);
      return status();
    })().finally(() => (ticking = null));
    return ticking;
  }

  async function status() {
    const [settings, state] = await Promise.all([getSettings(), load()]);
    const next = Object.fromEntries(
      SYNC_SCOPES.map(scope => {
        const interval = intervalFor(settings, scope);
        if (!settings.syncEnabled || !interval) return [scope, 0];
        return [scope, Math.max(Number(state.retryAt[scope] || 0), Number(state.lastRun[scope] || 0) + interval)];
      })
    );
    return {
      ok: true,
      enabled: !!settings.syncEnabled,
      paused: !!settings.syncPaused,
      current: state.current,
      lastResult: state.lastResult,
      history: state.history,
      waitingForTab: state.waitingForTab,
      next,
    };
  }

  async function runNow(scope) {
    if (!SYNC_SCOPES.includes(scope)) throw Error('Unknown sync source');
    const settings = await getSettings(),
      state = await load();
    if (state.current) return { ok: false, error: 'A sync is already running' };
    return start(scope, state, settings, { manual: true });
  }
  async function setPaused(paused) {
    await setSettings({ syncPaused: !!paused });
    return status();
  }
  async function stop() {
    const settings = await getSettings(),
      state = await load();
    if (state.current) {
      await sendToX(state.current.tabId, { type: 'XV_DIRECT_CANCEL', runId: state.current.runId }).catch(() => {});
      await finish(state, settings, { state: 'cancelled', error: 'Stopped' });
    }
    return status();
  }

  const MESSAGES = {
    SYNC_STATUS: () => status(),
    SYNC_RUN_NOW: m => runNow(String(m.scope || '')),
    SYNC_PAUSE: () => setPaused(true),
    SYNC_RESUME: () => setPaused(false),
    SYNC_STOP: () => stop(),
  };
  return {
    tick,
    status,
    schedule: async () => schedule(await getSettings()),
    handles: type => Object.hasOwn(MESSAGES, type),
    handle: message => MESSAGES[message.type](message),
    onAlarm: name => (name === SYNC_ALARM ? (tick().catch(() => {}), true) : false),
  };
}
