// XVault 25: dashboard side of the local avatar archive (sw/avatar-archive.mjs writes "xvault-avatars").
// window.XVaultAvatarUrl(handle, remoteUrl) answers synchronously:
//   'blob:…'  the archived image is ready;
//   false     an archived image exists and is loading — render the monogram with data-avatar-handle and it is
//             swapped in place when ready;
//   ''        nothing archived yet — the caller may use the remote URL, and the service worker is asked to keep a copy.
(() => {
  'use strict';
  const DB = 'xvault-avatars',
    STORE = 'avatars',
    LIMIT = 800,
    HANDLE = /^[a-z0-9_]{1,15}$/;
  const urls = new Map();
  const loading = new Set();
  const failed = new Set();
  const asked = new Set();
  const toRemember = new Map();
  let stored = null,
    database = null,
    loadTimer = 0,
    rememberTimer = 0;

  function open() {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const rows = db.createObjectStore(STORE, { keyPath: 'handle' });
          rows.createIndex('fetchedAt', 'fetchedAt');
          rows.createIndex('size', 'size');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        database = null;
        reject(request.error);
      };
    });
    return database;
  }
  async function readKeys() {
    try {
      const db = await open();
      const keys = await new Promise((resolve, reject) => {
        const request = db
          .transaction(STORE, 'readonly')
          .objectStore(STORE)
          .index('size')
          .getAllKeys(IDBKeyRange.lowerBound(1));
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
      stored = new Set(keys.map(String));
    } catch {
      stored = new Set();
    }
    const note = document.getElementById('avatarArchiveStats');
    if (note) {
      note.dataset.base ||= note.textContent.trim();
      note.textContent = stored.size
        ? `${note.dataset.base} ${stored.size.toLocaleString()} saved so far.`
        : note.dataset.base;
    }
    window.dispatchEvent(new CustomEvent('xvault:avatars', { detail: { ready: true, count: stored.size } }));
  }
  function swap(handle, url) {
    const selector = `[data-avatar-handle="${CSS.escape(handle)}"]`;
    for (const element of document.querySelectorAll(selector)) {
      if (element instanceof HTMLImageElement) {
        if (element.src !== url) element.src = url;
        continue;
      }
      const image = document.createElement('img');
      image.className = 'avatar';
      image.alt = '';
      image.decoding = 'async';
      image.dataset.avatarHandle = handle;
      image.dataset.monogram = element.textContent || '?';
      image.src = url;
      element.replaceWith(image);
    }
  }
  async function loadBatch() {
    loadTimer = 0;
    const handles = [...loading].slice(0, 40);
    if (!handles.length) return;
    try {
      const db = await open();
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly'),
          out = [];
        const os = tx.objectStore(STORE);
        for (const handle of handles) {
          const request = os.get(handle);
          request.onsuccess = () => request.result && out.push(request.result);
        }
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => reject(tx.error);
      });
      const found = new Set();
      for (const row of rows) {
        if (!row?.data || !/^image\/(jpeg|png|gif|webp)$/.test(row.mime || '')) continue;
        const url = URL.createObjectURL(new Blob([row.data], { type: row.mime }));
        const old = urls.get(row.handle);
        if (old) URL.revokeObjectURL(old);
        urls.set(row.handle, url);
        found.add(row.handle);
        swap(row.handle, url);
      }
      for (const handle of handles) {
        loading.delete(handle);
        if (!found.has(handle)) {
          failed.add(handle);
          stored?.delete(handle);
        }
      }
      while (urls.size > LIMIT) {
        const [handle, url] = urls.entries().next().value;
        urls.delete(handle);
        URL.revokeObjectURL(url);
      }
    } catch {
      for (const handle of handles) {
        loading.delete(handle);
        failed.add(handle);
      }
    }
    if (loading.size) loadTimer = setTimeout(loadBatch, 0);
  }
  function queueLoad(handle) {
    loading.add(handle);
    if (!loadTimer) loadTimer = setTimeout(loadBatch, 0);
  }
  function flushRemember() {
    rememberTimer = 0;
    const items = [...toRemember].map(([handle, url]) => ({ handle, url })).filter(item => !stored?.has(item.handle));
    toRemember.clear();
    if (!items.length || !chrome?.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: 'AVATARS_REMEMBER', items: items.slice(0, 200) }).catch?.(() => {});
  }
  window.XVaultAvatarUrl = (handle, remote) => {
    const key = String(handle || '')
      .replace(/^@/, '')
      .toLowerCase();
    if (!HANDLE.test(key)) return '';
    const hit = urls.get(key);
    if (hit) {
      urls.delete(key);
      urls.set(key, hit);
      return hit;
    }
    if (stored?.has(key) && !failed.has(key)) {
      queueLoad(key);
      return false;
    }
    if (remote && !asked.has(key) && /^https:\/\/pbs\.twimg\.com\//.test(remote)) {
      asked.add(key);
      toRemember.set(key, remote);
      if (!rememberTimer) rememberTimer = setTimeout(flushRemember, 1500);
    }
    return '';
  };
  window.XVaultAvatars = {
    stats: () => ({ stored: stored?.size ?? null, loaded: urls.size }),
    refresh: readKeys,
  };
  // The service worker announces each newly archived avatar; visible remote images switch to the local copy.
  try {
    const channel = new BroadcastChannel('xvault-avatars');
    channel.onmessage = event => {
      const handle = String(event.data?.handle || '');
      if (handle === '*') {
        for (const url of urls.values()) URL.revokeObjectURL(url);
        urls.clear();
        failed.clear();
        void readKeys();
        return;
      }
      if (!HANDLE.test(handle)) return;
      stored?.add(handle);
      failed.delete(handle);
      if (document.querySelector(`[data-avatar-handle="${CSS.escape(handle)}"]`)) queueLoad(handle);
    };
  } catch {}
  void readKeys();
})();
