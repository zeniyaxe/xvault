(() => {
  if (window.__XVAULT_V7_HOOKED__) return;
  window.__XVAULT_V7_HOOKED__ = 1;
  const jobs = new Map(),
    templates = new Map(),
    SRC = 'XVAULT_PAGE';
  const post = (type, p = {}) => window.postMessage({ source: SRC, type, ...p }, '*');
  function parseMeta(u) {
    try {
      const x = new URL(u, location.href),
        m = x.pathname.match(/\/i\/api\/graphql\/([^/]+)\/([^/?]+)/);
      if (!m) return null;
      const j = k => {
        try {
          return JSON.parse(x.searchParams.get(k) || 'null');
        } catch {
          return null;
        }
      };
      return {
        queryId: m[1],
        operation: decodeURIComponent(m[2]),
        url: x.href,
        variables: j('variables'),
        features: j('features'),
        fieldToggles: j('fieldToggles'),
      };
    } catch {
      return null;
    }
  }
  function mergeHeaders(input, init) {
    const h = new Headers();
    try {
      if (input instanceof Request) input.headers.forEach((v, k) => h.set(k, v));
    } catch {}
    try {
      new Headers(init?.headers || {}).forEach((v, k) => h.set(k, v));
    } catch {}
    const o = {};
    h.forEach((v, k) => {
      if (!/^(cookie|content-length|host)$/i.test(k)) o[k] = v;
    });
    return o;
  }
  function remember(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url,
      m = parseMeta(url);
    if (!m) return;
    const method = (init.method || (input instanceof Request ? input.method : null) || 'GET').toUpperCase(),
      t = {
        ...m,
        method,
        headers: mergeHeaders(input, init),
        body: typeof init.body === 'string' ? init.body : null,
        capturedAt: Date.now(),
        pageHref: location.href,
        pagePath: location.pathname,
      };
    templates.set(m.operation, t);
    post('GRAPHQL_TEMPLATE', { template: t });
  }
  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, init = {}) {
    remember(input, init);
    const url = typeof input === 'string' ? input : input?.url,
      r = await realFetch(input, init),
      m = parseMeta(url);
    if (m)
      r.clone()
        .json()
        .then(data => post('GRAPHQL_RESPONSE', { meta: m, data, status: r.status, at: Date.now() }))
        .catch(() => {});
    return r;
  };
  const P = XMLHttpRequest.prototype,
    O = P.open,
    S = P.send,
    H = P.setRequestHeader;
  P.open = function (method, url) {
    this.__xv = { method, url, headers: {} };
    return O.apply(this, arguments);
  };
  P.setRequestHeader = function (k, v) {
    if (this.__xv) this.__xv.headers[k] = v;
    return H.apply(this, arguments);
  };
  P.send = function (body) {
    if (this.__xv) {
      remember(this.__xv.url, { method: this.__xv.method, headers: this.__xv.headers, body });
      this.addEventListener(
        'load',
        () => {
          const m = parseMeta(this.__xv.url);
          if (m)
            try {
              post('GRAPHQL_RESPONSE', {
                meta: m,
                data: JSON.parse(this.responseText),
                status: this.status,
                at: Date.now(),
              });
            } catch {}
        },
        { once: true }
      );
    }
    return S.apply(this, arguments);
  };
  function findCursor(root) {
    let fallback = null,
      q = [root],
      seen = new WeakSet();
    while (q.length) {
      const x = q.pop();
      if (!x || typeof x !== 'object' || seen.has(x)) continue;
      seen.add(x);
      const id = x.entryId || x.entry_id || '',
        type = x.cursorType || x.cursor_type || '',
        v = x.value || x?.content?.value;
      if (v && /bottom/i.test(String(type))) return v;
      if (v && /cursor-bottom/i.test(String(id))) return v;
      if (!fallback && v && /cursor/i.test(String(id))) fallback = v;
      for (const y of Object.values(x)) if (y && typeof y === 'object') q.push(y);
    }
    return fallback;
  }
  function withCursor(t, c, count) {
    const u = new URL(t.url),
      v = { ...(t.variables || {}) };
    if (c) v.cursor = c;
    else delete v.cursor;
    if ('count' in v || count) v.count = Math.min(100, Math.max(20, count || 100));
    u.searchParams.set('variables', JSON.stringify(v));
    return u.href;
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function run(m) {
    const { runId, template, settings: s = {}, checkpoint } = m,
      j = { cancelled: false, paused: false };
    jobs.set(runId, j);
    let cursor = checkpoint?.cursor || null,
      page = Number(checkpoint?.page || 0),
      seen = new Set(cursor ? [cursor] : []),
      max = Number(s.maxPages) === 0 ? Infinity : Math.max(1, Number(s.maxPages) || 10000),
      base = Math.max(400, Number(s.directPageDelay) || 1100),
      jitter = Math.max(0, Number(s.directPageJitter) || 450);
    post('DIRECT_DEBUG', { runId, phase: 'init', message: `Preparing ${template.operation}`, page });
    while (!j.cancelled && page < max) {
      while (j.paused && !j.cancelled) await sleep(250);
      if (j.cancelled) break;
      const url = withCursor(template, cursor, s.pageSize || 100),
        headers = new Headers(template.headers || {});
      headers.delete('content-length');
      headers.delete('host');
      // Session CSRF tokens are never persisted with templates; use the live ct0 cookie for each request.
      const csrf = /(?:^|;\s*)ct0=([^;]+)/.exec(document.cookie)?.[1];
      if (csrf) headers.set('x-csrf-token', decodeURIComponent(csrf));
      post('DIRECT_DEBUG', { runId, phase: 'request', message: `Fetching page ${page + 1}`, page: page + 1, url });
      let r;
      try {
        r = await realFetch(url, {
          method: template.method || 'GET',
          headers,
          body: (template.method || 'GET') === 'GET' ? undefined : template.body,
          credentials: 'include',
          cache: 'no-store',
        });
      } catch (e) {
        post('DIRECT_DEBUG', { runId, phase: 'network-error', message: String(e), page });
        throw e;
      }
      post('DIRECT_DEBUG', { runId, phase: 'response', message: `HTTP ${r.status}`, page: page + 1, status: r.status });
      if (r.status === 429) {
        let wait = Number(r.headers.get('retry-after') || 0) * 1000,
          reset = Number(r.headers.get('x-rate-limit-reset') || 0) * 1000;
        if (!wait && reset) wait = Math.max(1000, reset - Date.now() + 3000);
        wait = Math.min(Math.max(wait || 30000, 5000), 900000);
        post('DIRECT_RATE_LIMIT', { runId, wait, page });
        await sleep(wait);
        continue;
      }
      if (!r.ok) {
        let detail = '';
        try {
          detail = (await r.text()).slice(0, 500);
        } catch {}
        throw Error(`HTTP ${r.status}${detail ? ` — ${detail}` : ''}`);
      }
      const data = await r.json();
      page++;
      const next = findCursor(data);
      post('DIRECT_PAGE', {
        runId,
        operation: template.operation,
        page,
        data,
        nextCursor: next,
        rateLimit: {
          remaining: r.headers.get('x-rate-limit-remaining'),
          limit: r.headers.get('x-rate-limit-limit'),
          reset: r.headers.get('x-rate-limit-reset'),
        },
      });
      post('DIRECT_CHECKPOINT', { runId, page, cursor: next, operation: template.operation, at: Date.now() });
      if (!next) {
        post('DIRECT_DONE', { runId, page, reason: 'no-bottom-cursor' });
        break;
      }
      if (seen.has(next)) {
        post('DIRECT_DONE', { runId, page, reason: 'cursor-loop' });
        break;
      }
      seen.add(next);
      cursor = next;
      await sleep(base + Math.random() * jitter);
    }
    if (j.cancelled) post('DIRECT_DONE', { runId, page, reason: 'cancelled' });
    jobs.delete(runId);
  }
  window.addEventListener('message', e => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || m.source !== 'XVAULT_CONTENT') return;
    if (m.type === 'GET_TEMPLATES') post('TEMPLATE_SNAPSHOT', { templates: [...templates.values()] });
    if (m.type === 'DIRECT_START')
      run(m).catch(e => post('DIRECT_ERROR', { runId: m.runId, error: e?.message || String(e) }));
    if (m.type === 'DIRECT_PAUSE' && jobs.get(m.runId)) jobs.get(m.runId).paused = true;
    if (m.type === 'DIRECT_RESUME' && jobs.get(m.runId)) jobs.get(m.runId).paused = false;
    if (m.type === 'DIRECT_CANCEL' && jobs.get(m.runId)) jobs.get(m.runId).cancelled = true;
  });
  post('HOOK_READY', { href: location.href });
})();
