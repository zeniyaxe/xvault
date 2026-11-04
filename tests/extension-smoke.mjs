// Run against a fresh Chromium profile with XVault already loaded unpacked.
// Usage: node tests/extension-smoke.mjs <debug-port> <extension-id>
const [port, extensionId] = process.argv.slice(2);
if (!port || !extensionId) throw Error('Expected debug port and extension ID');
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = targets.find(row => row.url === `chrome-extension://${extensionId}/dashboard.html`);
if (!target) throw Error('Dashboard target not found');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let id = 0;
const pending = new Map();
const errors = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error')
    errors.push(message.params.entry.text);
};
function send(method, params = {}) {
  const requestId = ++id;
  return new Promise(resolve => {
    pending.set(requestId, resolve);
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await new Promise(resolve => setTimeout(resolve, 1000));
const evaluation = await send('Runtime.evaluate', {
  expression: `(async () => {
    const stats = await chrome.runtime.sendMessage({ type: 'STATS' });
    const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
    document.querySelector('[data-page="library"]')?.click();
    await new Promise(resolve => setTimeout(resolve, 200));
    const initialLibraryRows = document.querySelectorAll('#list .tweet').length;
    const stored = await chrome.runtime.sendMessage({
      type: 'STORE_RECORDS',
      tweets: [{ id: 'smoke-archive-1', text: 'Synthetic smoke fixture', author: { handle: 'fixture' }, media: [] }],
      users: []
    });
    document.querySelector('#load')?.click();
    const waitFor = async test => {
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        if (test()) return true;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return false;
    };
    const loaded = await waitFor(() => document.querySelector('#list .tweet[data-id="smoke-archive-1"]'));
    const search = document.querySelector('#search');
    search.value = 'artist:fixture';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await waitFor(() => document.querySelector('#libShown')?.textContent.startsWith('Searching'));
    const searched = await waitFor(() => document.querySelector('#list .tweet[data-id="smoke-archive-1"]') && document.querySelector('#libShown')?.textContent === '1–1 / 1');
    const firstPage = await chrome.runtime.sendMessage({ type: 'QUERY_LIBRARY_PAGE', query: 'artist:fixture', sort: 'new', limit: 2, scanLimit: 10, queryId: 'smoke-library-query' });
    return {
      ready: document.readyState,
      title: document.title,
      posts: stats.tweets,
      motion: settings.settings?.motionLevel,
      libraryRows: initialLibraryRows,
      loadedCardCount: document.querySelectorAll('#list .tweet[data-id="smoke-archive-1"]').length,
      libraryVisible: document.querySelector('#page-library')?.classList.contains('show'),
      navIcons: document.querySelectorAll('.rail .nav svg').length,
      inserted: stored.tweets,
      loaded,
      searched,
      searchWorker: window.__xvLibrarySearchWorker || null,
      firstPageIds: firstPage.rows.map(row => row.id),
      queryPlan: firstPage.metrics?.plan,
      queryReadCount: firstPage.recordsRead
    };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
const result = evaluation.result?.result?.value;
socket.close();
if (evaluation.error || evaluation.result?.exceptionDetails) throw Error(JSON.stringify(evaluation));
if (
  !result ||
  result.posts !== 0 ||
  result.libraryRows !== 0 ||
  !result.libraryVisible ||
  result.motion !== 'normal' ||
  result.navIcons < 10 ||
  result.inserted !== 1 ||
  !result.loaded ||
  !result.searched ||
  result.searchWorker !== null ||
  !result.queryPlan ||
  result.queryReadCount > 10 ||
  !result.firstPageIds.includes('smoke-archive-1') ||
  errors.length
) {
  throw Error(JSON.stringify({ result, errors }));
}
console.log(JSON.stringify({ result, errors }));
