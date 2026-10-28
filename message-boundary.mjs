// The X page and its content scripts cannot invoke desktop/archive-management
// commands. Keep the smaller capture/action capability explicit at this boundary.
const CONTENT_ACTIONS = new Set(['GET_SETTINGS','GET_CAPTURE_TEMPLATES','STORE_CAPTURE_TEMPLATES','STATS','GET_TWEET_IDS','GET_ARCHIVE_INDICATORS','INJECT_HOOK','STORE_RECORDS','STORE_CAPTURE','STORE_JOB','STORE_ACTION','STORE_CHECKPOINT','GET_CHECKPOINT','QUEUE_DOWNLOADS','OPEN_DASHBOARD','OPEN_SIDE_PANEL','PAUSE_ALL_DOWNLOADS','RESET_FLOATING_POSITION','SET_SETTINGS','NOTIFY','WAKE','SEND_TO_TAB']);
const X_HOSTS = new Set(['x.com','twitter.com','mobile.twitter.com']);
const MEDIA_HOSTS = new Set(['pbs.twimg.com','video.twimg.com']);
const CONTENT_SETTINGS = new Set(['showFloatingButton','sideDockCollapsed','cornerRight','cornerBottom','cornerScale','cornerOpacity']);
const SCOPES = new Set(['bookmarks','likes','profile','timeline','thread','capture','passive','dom','direct']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

function mediaUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && MEDIA_HOSTS.has(url.hostname) && !url.port; } catch { return false; }
}
export { mediaUrl as isXMediaUrl };

function context(value) {
  if (value == null) return;
  if (!plain(value) || value.scope && !SCOPES.has(value.scope) || value.profileHandle && !/^[a-z0-9_]{1,30}$/i.test(value.profileHandle)) throw Error('Invalid archive context');
}

export function authorizeMessage(message, sender, extensionId) {
  if (!plain(message) || typeof message.type !== 'string' || message.type.length > 80) throw Error('Invalid extension message');
  if (sender?.id !== extensionId) throw Error('Untrusted extension sender');
  let url;
  try { url = new URL(sender.url); } catch { throw Error('Message origin is unavailable'); }
  if (url.protocol === 'chrome-extension:' && url.hostname === extensionId) {
    if (message.type === 'REMOTE_COMMAND' && (url.pathname !== '/dashboard.html' || sender.frameId && sender.frameId !== 0)) throw Error('Remote controls are available only in the XVault dashboard');
    return 'desktop';
  }
  if (url.protocol !== 'https:' || !X_HOSTS.has(url.hostname) || url.port || !sender.tab?.id || sender.frameId && sender.frameId !== 0) throw Error('Unsupported content-script origin');
  if (!CONTENT_ACTIONS.has(message.type)) throw Error('This action is available only in the XVault dashboard');
  if (message.type === 'GET_CHECKPOINT' && message.key === 'library-trash-undo' || message.type === 'STORE_CHECKPOINT' && message.checkpoint?.key === 'library-trash-undo') throw Error('Private recovery state is available only in the XVault dashboard');
  context(message.context);
  if (message.type === 'GET_ARCHIVE_INDICATORS' && (!Array.isArray(message.ids) || message.ids.length > 50 || message.ids.some(id => !/^\d{1,32}$/.test(String(id))))) throw Error('Archive status lookup requires at most 50 post IDs');
  if (message.type === 'STORE_CAPTURE_TEMPLATES') {
    if (!Array.isArray(message.templates) || message.templates.length > 100) throw Error('Invalid capture template batch');
    for (const template of message.templates) {
      let target;try { target = new URL(template?.url); } catch { throw Error('Invalid capture template URL'); }
      if (!plain(template) || !/^[a-z0-9_]{1,128}$/i.test(template.operation || '') || ['__proto__','constructor','prototype'].includes(template.operation) || target.protocol !== 'https:' || !X_HOSTS.has(target.hostname) || target.port || target.username || target.password || !/^\/i\/api\/graphql\/[^/]+\/[^/]+$/.test(target.pathname) || target.pathname.split('/').at(-1) !== template.operation || JSON.stringify(template).length > 100000) throw Error('Invalid X capture template');
    }
  }
  if (message.type === 'SET_SETTINGS') {
    if (!plain(message.settings) || Object.keys(message.settings).some(key => !CONTENT_SETTINGS.has(key))) throw Error('This setting can be changed only in the XVault dashboard');
    for (const [key,value] of Object.entries(message.settings)) {
      if (['showFloatingButton','sideDockCollapsed'].includes(key) ? typeof value !== 'boolean' : typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10000) throw Error('Invalid content-script setting');
    }
  }
  if (message.type === 'QUEUE_DOWNLOADS') {
    if (!Array.isArray(message.items) || message.items.length > 5000) throw Error('Download batch is too large');
    if (message.items.some(item => !plain(item) || !mediaUrl(item.url))) throw Error('Downloads from X require an HTTPS X CDN URL');
  }
  if (message.type === 'STORE_RECORDS') {
    if (!Array.isArray(message.tweets) || message.tweets.length > 5000 || message.users != null && (!Array.isArray(message.users) || message.users.length > 5000)) throw Error('Capture batch is invalid or too large');
    for (const row of message.tweets) {
      if (row?.userMeta != null) throw Error('Personal archive metadata can be changed only in the XVault dashboard');
      if (!plain(row) || !/^\d{1,32}$/.test(String(row.id || '')) || row.text != null && (typeof row.text !== 'string' || row.text.length > 100000) || row.media != null && (!Array.isArray(row.media) || row.media.length > 32)) throw Error('Invalid captured post');
      for (const media of row.media || []) {
        if (!plain(media) || media.variants != null && (!Array.isArray(media.variants) || media.variants.length > 32)) throw Error('Invalid captured media');
        for (const value of [media.url,media.playbackUrl,media.preview,...(media.variants || []).map(variant => variant?.url)].filter(Boolean)) if (!mediaUrl(value)) throw Error('Captured media requires an HTTPS X CDN URL');
      }
    }
  }
  if (message.type === 'STORE_CAPTURE') {
    if (!plain(message.capture) || message.capture.key != null && (typeof message.capture.key !== 'string' || message.capture.key.length > 512)) throw Error('Invalid capture record');
    context(message.capture.context);
  }
  if (message.type === 'STORE_CHECKPOINT') {
    if (!plain(message.checkpoint) || typeof message.checkpoint.key !== 'string' || message.checkpoint.key.length > 512) throw Error('Invalid archive checkpoint');
    context(message.checkpoint.context);
  }
  if (message.type === 'STORE_JOB') {
    if (!plain(message.job) || typeof message.job.id !== 'string' || message.job.id.length > 128) throw Error('Invalid archive job');
    context(message.job.context);
  }
  if (message.type === 'SEND_TO_TAB') {
    if (message.payload?.type !== 'XV_SCROLL_START' || message.tabId && message.tabId !== sender.tab.id) throw Error('Unsupported content-script tab command');
    context(message.payload.context);
  }
  return 'content';
}
