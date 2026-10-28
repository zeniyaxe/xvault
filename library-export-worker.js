importScripts('link-utils.js', 'link-export.js');

let ids = new Set();
let urls = [];
let duplicates = 0;
let skipped = 0;
let settings = {};
let perBlock = 5;
let cancelled = false;
const pending = [];
let total = 0;

self.onmessage = event => {
  const message = event.data || {};
  if (message.type === 'start') {
    ids = new Set();
    urls = [];
    duplicates = 0;
    skipped = 0;
    cancelled = false;
    settings = message.settings || {};
    perBlock = message.perBlock ?? 5;
    total = Number(message.total) || 0;
    self.postMessage({ type: 'ready' });
    return;
  }
  if (message.type === 'cancel') {
    cancelled = true;
    pending.length = 0;
    self.postMessage({ type: 'cancelled' });
    return;
  }
  if (message.type === 'chunk' && !cancelled) {
    pending.push(message);
    void drain();
  }
  if (message.type === 'finish' && !cancelled) {
    pending.push(message);
    void drain();
  }
};

let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (pending.length && !cancelled) {
      const message = pending.shift();
      if (cancelled) return;
      if (message.type === 'chunk') {
        const posts = message.posts || [];
        for (let start = 0; start < posts.length; start += 100) {
          if (cancelled) return;
          for (const post of posts.slice(start, start + 100)) {
            if (post?.id == null || !/^\d+$/.test(String(post.id))) {
              skipped++;
              continue;
            }
            const id = String(post.id);
            const url = XVaultLinkExport.canonicalLink(post, settings, self.XVaultLinks);
            if (!url) {
              skipped++;
              continue;
            }
            if (ids.has(id)) {
              duplicates++;
              continue;
            }
            ids.add(id);
            urls.push(url);
          }
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        self.postMessage({ type: 'progress', done: message.done, total });
      } else {
        const text = XVaultLinkExport.formatLinks(urls, perBlock);
        self.postMessage({ type: 'complete', text, unique: urls.length, duplicates, skipped });
      }
    }
  } finally {
    draining = false;
  }
}
