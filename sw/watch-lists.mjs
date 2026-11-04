// XVault 21: watch lists — scheduled, capped captures of an author's newest posts or a live search.
// Each due list opens its page (x.com/<handle> or x.com/search?f=live) in a background tab of a
// window that already has x.com open, reads the newest few screens through the normal capture
// path (incremental: stops at posts already archived), closes the tab and records what was added.
export const WATCH_ALARM = 'xv-watch-tick';
const STATE_KEY = 'xvWatchState';
const HOUR = 3600000;

export function watchUrl(list) {
  return list.kind === 'author'
    ? `https://x.com/${encodeURIComponent(list.value)}`
    : `https://x.com/search?q=${encodeURIComponent(list.value)}&src=typed_query&f=live`;
}
export function blankWatchState() {
  return { lists: {}, history: [], usage: {}, current: null };
}
const dayKey = now => new Date(now).toISOString().slice(0, 10);

/** Enabled lists that are due, least recently run first, limited by today's remaining runs. */
export function dueLists(settings, state, now = Date.now()) {
  const used = Number(state.usage?.[dayKey(now)] || 0),
    left = Math.max(0, Number(settings.watchDailyCap || 0) - used);
  if (!left) return [];
  return (settings.watchLists || [])
    .filter(list => list.enabled !== false)
    .filter(list => now - Number(state.lists?.[list.id]?.lastRunAt || 0) >= Number(list.everyHours || 24) * HOUR)
    .sort((a, b) => Number(state.lists?.[a.id]?.lastRunAt || 0) - Number(state.lists?.[b.id]?.lastRunAt || 0))
    .slice(0, left);
}
/** Posts in `fresh` that belong to a list. */
export function matchesList(list, post, matchesQuery) {
  if (list.kind === 'author')
    return (
      String(post?.author?.handle || '')
        .replace(/^@/, '')
        .toLowerCase() === String(list.value).toLowerCase()
    );
  return matchesQuery(post, list.value);
}

export function createWatchLists(deps) {
  const {
    chromeApi = globalThis.chrome,
    getSettings,
    activeXTab,
    sendToX,
    postsArchivedSince,
    matchesQuery,
    notify = async () => {},
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    loadTimeoutMs = 45000,
    runTimeoutMs = 90000,
  } = deps;
  let ticking = null;
  const load = async () => ({
    ...blankWatchState(),
    ...((await chromeApi.storage.local.get(STATE_KEY))[STATE_KEY] || {}),
  });
  const save = state => chromeApi.storage.local.set({ [STATE_KEY]: state });

  async function schedule(settings) {
    try {
      if ((settings.watchLists || []).some(list => list.enabled !== false))
        await chromeApi.alarms.create(WATCH_ALARM, { periodInMinutes: 15, delayInMinutes: 2 });
      else await chromeApi.alarms.clear(WATCH_ALARM);
    } catch {}
  }

  async function waitForTab(tabId) {
    const started = now();
    while (now() - started < loadTimeoutMs) {
      const tab = await chromeApi.tabs.get(tabId).catch(() => null);
      if (!tab) throw Error('The watch tab was closed');
      if (tab.status === 'complete') {
        const ping = await sendToX(tabId, { type: 'XV_GET_TEMPLATES' }).catch(() => null);
        if (ping?.ok) return;
      }
      await sleep(1000);
    }
    throw Error('X did not finish loading in time');
  }

  async function runList(list, state, settings, { manual = false } = {}) {
    const xTab = await activeXTab();
    if (!xTab) return { ok: false, error: 'Open x.com in a tab first — watch lists use your signed-in X session.' };
    const startedAt = now(),
      runId = crypto.randomUUID();
    const tab = await chromeApi.tabs.create({ url: watchUrl(list), active: false, windowId: xTab.windowId });
    state.current = { id: list.id, tabId: tab.id, startedAt, runId };
    await save(state);
    let error = '';
    try {
      await waitForTab(tab.id);
      await sleep(2500);
      const context =
        list.kind === 'author' ? { scope: 'profile', profileHandle: list.value, runId } : { scope: 'timeline', runId };
      await Promise.race([
        sendToX(tab.id, {
          type: 'XV_SCROLL_START',
          runId,
          context,
          maxRounds: Math.max(1, Math.min(10, Number(list.maxPages) || 2)) * 3,
          watch: true,
        }),
        sleep(runTimeoutMs).then(() => sendToX(tab.id, { type: 'XV_SCROLL_STOP' }).catch(() => {})),
      ]);
      await sleep(1500);
    } catch (caught) {
      error = caught?.message || String(caught);
    } finally {
      await chromeApi.tabs.remove(tab.id).catch(() => {});
    }
    const fresh = error ? [] : await postsArchivedSince(startedAt).catch(() => []);
    const added = fresh.filter(post => matchesList(list, post, matchesQuery)).length;
    const result = { at: now(), ok: !error, added, seen: fresh.length, error, manual };
    const day = dayKey(now());
    state.current = null;
    state.lists = { ...(state.lists || {}), [list.id]: { lastRunAt: now(), lastResult: result } };
    state.usage = { [day]: Number(state.usage?.[day] || 0) + 1 };
    state.history = [{ id: list.id, name: list.name, ...result }, ...(state.history || [])].slice(0, 60);
    await save(state);
    if (added && settings.syncNotifications !== false && !manual)
      await notify(`${added} new from ${list.name}`, `Watch list “${list.name}” archived ${added} new posts`).catch(
        () => {}
      );
    return { ok: !error, id: list.id, added, error };
  }

  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const settings = await getSettings(),
        state = await load();
      await schedule(settings);
      if (state.current) {
        if (now() - Number(state.current.startedAt || 0) < runTimeoutMs * 3) return status();
        await chromeApi.tabs.remove(state.current.tabId).catch(() => {});
        state.current = null;
        await save(state);
      }
      const [list] = dueLists(settings, state, now());
      if (list) await runList(list, state, settings);
      return status();
    })().finally(() => (ticking = null));
    return ticking;
  }

  async function status() {
    const [settings, state] = await Promise.all([getSettings(), load()]);
    return {
      ok: true,
      lists: (settings.watchLists || []).map(list => ({
        ...list,
        url: watchUrl(list),
        lastRunAt: Number(state.lists?.[list.id]?.lastRunAt || 0),
        lastResult: state.lists?.[list.id]?.lastResult || null,
        nextAt:
          list.enabled === false
            ? 0
            : Number(state.lists?.[list.id]?.lastRunAt || 0) + Number(list.everyHours || 24) * HOUR,
      })),
      current: state.current,
      history: state.history || [],
      usedToday: Number(state.usage?.[dayKey(now())] || 0),
      dailyCap: Number(settings.watchDailyCap || 0),
    };
  }

  async function runNow(id) {
    const settings = await getSettings(),
      state = await load(),
      list = (settings.watchLists || []).find(entry => entry.id === String(id));
    if (!list) throw Error('Unknown watch list');
    if (state.current) return { ok: false, error: 'A watch list is already running' };
    return runList(list, state, settings, { manual: true });
  }

  const MESSAGES = {
    WATCH_STATUS: () => status(),
    WATCH_RUN_NOW: message => runNow(message.id),
  };
  return {
    tick,
    status,
    schedule: async () => schedule(await getSettings()),
    types: Object.keys(MESSAGES),
    handle: message => MESSAGES[message.type](message),
    onAlarm: name => (name === WATCH_ALARM ? (tick().catch(() => {}), true) : false),
  };
}
