// Optional retrieval of a post that is referenced but not archived (a thread's missing parent).
// Only on explicit request, only through an x.com tab the user already has open: XVault opens the
// status page in a background tab of that window, lets the normal capture path store what X
// shows, and closes the tab. No credentials are read and nothing runs unattended.
export function createMissingPostFetcher({ chromeApi = globalThis.chrome, activeXTab, hasPost, sleep, now }) {
  sleep ||= ms => new Promise(resolve => setTimeout(resolve, ms));
  now ||= () => Date.now();
  const inflight = new Map();
  async function fetchPost(id, { timeout = 20000 } = {}) {
    id = String(id || '');
    if (!/^\d{1,32}$/.test(id)) throw Error('Invalid post ID');
    if (await hasPost(id)) return { ok: true, id, found: true, already: true };
    if (inflight.has(id)) return inflight.get(id);
    const task = (async () => {
      const xTab = await activeXTab();
      if (!xTab) return { ok: false, id, error: 'Open x.com in a tab first, then try again.' };
      const tab = await chromeApi.tabs.create({
        url: `https://x.com/i/status/${id}`,
        active: false,
        windowId: xTab.windowId,
      });
      try {
        const started = now();
        while (now() - started < timeout) {
          await sleep(1000);
          if (await hasPost(id)) return { ok: true, id, found: true };
          if (!(await chromeApi.tabs.get(tab.id).catch(() => null))) break;
        }
        return {
          ok: true,
          id,
          found: false,
          error: 'X did not show this post (it may be deleted, protected, or capture-while-browsing is off).',
        };
      } finally {
        await chromeApi.tabs.remove(tab.id).catch(() => {});
      }
    })().finally(() => inflight.delete(id));
    inflight.set(id, task);
    return task;
  }
  return { fetchPost };
}
