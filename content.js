try {
  const root = document.documentElement,
    mine = chrome.runtime.id;
  root.dataset.xvInstances = [...new Set([...(root.dataset.xvInstances || '').split(','), mine].filter(Boolean))].join(
    ','
  );
} catch {}
(() => {
  const PAGE = 'XVAULT_PAGE',
    CONTENT = 'XVAULT_CONTENT',
    cache = new Map(),
    templates = new Map(),
    directWait = new Map();
  let settings = {},
    observer = null,
    scrollJob = null,
    dead = false,
    archiveContext = null,
    staleShown = false,
    hoverTimer = null;
  function isContextError(e) {
    return /context invalidated|Extension context invalidated/i.test(String(e?.message || e || ''));
  }
  function invalidate() {
    if (dead) return;
    dead = true;
    try {
      observer?.disconnect();
    } catch {}
    observer = null;
    if (scrollJob) scrollJob.cancelled = true;
    document
      .querySelectorAll('#xvault-corner,#xvault-hover,#xvault-menu,.xvault-download,#xvault-toast')
      .forEach(x => x.remove());
    if (settings.showStaleContextNotice !== false && !staleShown) {
      staleShown = true;
      const n = document.createElement('div');
      n.id = 'xvault-stale';
      n.innerHTML =
        '<b>XVault was updated</b><span>This tab still has the old extension script. Reload once to reconnect.</span><button>Reload X</button>';
      n.querySelector('button').onclick = () => location.reload();
      document.documentElement.append(n);
    }
  }
  async function send(msg) {
    if (dead) return null;
    try {
      const p = chrome.runtime.sendMessage(msg);
      return await p;
    } catch (e) {
      if (isContextError(e)) invalidate();
      return null;
    }
  }
  async function getCaptureTemplates() {
    const result = await send({ type: 'GET_CAPTURE_TEMPLATES' });
    return result?.templates || {};
  }
  async function storeCaptureTemplates(values) {
    for (let offset = 0; offset < values.length; offset += 100) {
      const result = await send({ type: 'STORE_CAPTURE_TEMPLATES', templates: values.slice(offset, offset + 100) });
      if (!result?.ok) return result;
    }
    return { ok: true };
  }
  (async () => {
    const r = await send({ type: 'GET_SETTINGS' });
    if (!r) return;
    settings = r.settings || {};
    await send({ type: 'INJECT_HOOK' });
    setup();
  })();
  window.addEventListener('message', async e => {
    if (dead || e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || m.source !== PAGE) return;
    if (m.type === 'GRAPHQL_TEMPLATE') {
      if (!m.template?.operation) return;
      templates.set(m.template.operation, m.template);
      await storeCaptureTemplates([m.template]);
      updateWidget();
    } else if (m.type === 'TEMPLATE_SNAPSHOT') {
      for (const t of m.templates || []) templates.set(t.operation, t);
      await storeCaptureTemplates([...templates.values()]);
      updateWidget();
    } else if (m.type === 'GRAPHQL_RESPONSE' && settings.captureWhileBrowsing !== false) {
      ingest(m.data, { source: 'passive', operation: m.meta?.operation });
    } else if (m.type === 'DIRECT_DEBUG') {
      debug(m.runId, m);
      signal(m.runId, 'debug', m);
    } else if (m.type === 'DIRECT_CHECKPOINT') {
      await send({
        type: 'STORE_CHECKPOINT',
        checkpoint: { key: checkpointKey(archiveContext), ...m, context: archiveContext },
      });
    } else if (m.type === 'DIRECT_PAGE') {
      const ctx = archiveContext?.runId === m.runId ? archiveContext : null;
      const summary = await ingest(m.data, {
        source: 'direct',
        operation: m.operation,
        runId: m.runId,
        page: m.page,
        context: ctx,
      });
      await send({
        type: 'STORE_JOB',
        job: {
          id: m.runId,
          state: 'running',
          phase: 'direct',
          operation: m.operation,
          page: m.page,
          posts: summary.tweets,
          media: summary.media,
          rateLimit: m.rateLimit,
          updatedAt: Date.now(),
          context: ctx,
        },
      });
      signal(m.runId, 'page', { ...m, summary });
    } else if (m.type === 'DIRECT_RATE_LIMIT') {
      await send({
        type: 'STORE_JOB',
        job: {
          id: m.runId,
          state: 'rate-limit',
          phase: 'direct',
          page: m.page || 0,
          wait: m.wait,
          updatedAt: Date.now(),
          context: archiveContext,
        },
      });
      signal(m.runId, 'rate', m);
    } else if (m.type === 'DIRECT_DONE' || m.type === 'DIRECT_ERROR') {
      const state = m.type === 'DIRECT_DONE' ? 'direct-done' : 'direct-error';
      await send({
        type: 'STORE_JOB',
        job: {
          id: m.runId,
          state,
          phase: 'direct',
          page: m.page || 0,
          error: m.error || null,
          reason: m.reason || null,
          updatedAt: Date.now(),
          context: archiveContext,
        },
      });
      signal(m.runId, m.type === 'DIRECT_DONE' ? 'done' : 'error', m);
    }
  });
  function setup() {
    if (dead) return;
    observer = new MutationObserver(() => {
      clearTimeout(setup.t);
      setup.t = setTimeout(() => {
        if (!dead) scan();
      }, 90);
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'href'],
    });
    scan();
    mountWidget();
    window.postMessage({ source: CONTENT, type: 'GET_TEMPLATES' }, '*');
    try {
      chrome.runtime.onMessage.addListener(m => {
        if (dead) return;
        if (m.type === 'XV_SETTINGS_CHANGED') {
          settings = m.settings;
          applyWidgetSettings();
        }
      });
    } catch (e) {
      if (isContextError(e)) invalidate();
    }
  }
  function metricNumber(v) {
    if (v == null) return null;
    const x = String(v).trim().toLowerCase().replace(/,/g, '');
    const m = x.match(/([0-9]+(?:\.[0-9]+)?)\s*([kmb])?/);
    if (!m) return null;
    let n = Number(m[1]);
    if (m[2] === 'k') n *= 1e3;
    if (m[2] === 'm') n *= 1e6;
    if (m[2] === 'b') n *= 1e9;
    return Math.round(n);
  }
  function domMetric(a, testid, word) {
    const e =
      a.querySelector(`[data-testid="${testid}"]`) ||
      [...a.querySelectorAll('[aria-label]')].find(x => new RegExp(word, 'i').test(x.getAttribute('aria-label') || ''));
    if (!e) return null;
    const label = e.getAttribute('aria-label') || e.textContent || '';
    return metricNumber(label);
  }
  function domTweet(a) {
    const href = [...a.querySelectorAll('a[href*="/status/"]')]
        .filter(link => !link.closest('[data-testid="quoteTweet"]'))
        .map(x => x.getAttribute('href'))
        .find(x => /\/status\/\d+/.test(x || '')),
      id = href?.match(/\/status\/(\d+)/)?.[1];
    if (!id) return null;
    const handle = href.split('/')[1] || '',
      text = a.querySelector('[data-testid="tweetText"]')?.innerText || '',
      createdAt = a.querySelector('time')?.getAttribute('datetime') || null,
      avatar = a.querySelector('img[src*="profile_images"]')?.src || null;
    const labels = [...a.querySelectorAll('div[dir="ltr"] span')].map(x => x.textContent?.trim()).filter(Boolean),
      name = labels.find(x => x !== `@${handle}` && !x.startsWith('@') && x.length < 80) || null;
    const media = [...a.querySelectorAll('img[src*="pbs.twimg.com/media"]')]
      .filter(image => !image.closest('[data-testid="quoteTweet"]'))
      .map(x => ({
        type: 'photo',
        url: orig(x.src),
        preview: x.src,
        width: x.naturalWidth || null,
        height: x.naturalHeight || null,
      }));
    const analytics = [...a.querySelectorAll('a[href$="/analytics"],[aria-label*="Views" i]')][0];
    return {
      id,
      text,
      createdAt,
      url: `https://x.com/${handle}/status/${id}`,
      author: { handle, name, avatar },
      media: uniq(media),
      metrics: {
        replies: domMetric(a, 'reply', 'repl'),
        reposts: domMetric(a, 'retweet', 'repost|retweet'),
        likes: domMetric(a, 'like', 'like'),
        bookmarks: domMetric(a, 'bookmark', 'bookmark'),
        views: metricNumber(analytics?.getAttribute?.('aria-label') || analytics?.textContent),
      },
      sourceFlags: ['dom'],
      archivedAt: Date.now(),
    };
  }
  function scan() {
    if (dead) return;
    const pendingRecords = [];
    for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
      const t = domTweet(a);
      if (!t) continue;
      if (a.dataset.xvault8 === t.id) {
        if (settings.inlineDownloadButton !== false) addDownloadButton(a, t);
        continue;
      }
      a.dataset.xvault8 = t.id;
      cache.set(t.id, merge(cache.get(t.id), t));
      pendingRecords.push(t);
      if ((archiveContext?.fullMirror || settings.fullMirrorMode) && archiveContext) {
        const items = mediaFiles(t, archiveContext);
        if (items.length) send({ type: 'QUEUE_DOWNLOADS', items });
      }
      if (settings.inlineDownloadButton !== false) addDownloadButton(a, t);
    }
    if (pendingRecords.length)
      receiptWrite = receiptWrite
        .catch(() => null)
        .then(() => send({ type: 'STORE_RECORDS', tweets: pendingRecords, users: [], context: currentContext() }));
    updateArchiveIndicators();
    updateWidget();
  }
  function addDownloadButton(a, t) {
    const g = [...a.querySelectorAll('[role="group"]')]
      .filter(group => !group.closest('[data-testid="quoteTweet"]'))
      .at(-1);
    if (!g || a.querySelector('.xvault-download')) return;
    const b = document.createElement('button');
    b.className = 'xvault-download';
    b.dataset.xvOwner = chrome.runtime?.id || '';
    b.title = 'Download media with XVault';
    b.innerHTML =
      '<span class="xvdl-ring"></span><svg viewBox="0 0 24 24"><path d="M12 3v11m0 0 4-4m-4 4-4-4M5 18v2h14v-2"/></svg>';
    b.onclick = async e => {
      e.preventDefault();
      e.stopPropagation();
      if (b.disabled) return;
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
      b.classList.add('busy');
      const live = domTweet(a) || t,
        captured = cache.get(live.id),
        x = {
          ...(captured || {}),
          ...live,
          media: live.media?.length
            ? [...live.media, ...(captured?.media || []).filter(item => !['photo', 'image'].includes(item.type))]
            : captured?.media || live.media,
        };
      receiptWrite = receiptWrite.then(() =>
        send({ type: 'STORE_RECORDS', tweets: [live], users: [], context: currentContext() })
      );
      await receiptWrite;
      const items = mediaFiles(x, currentContext());
      const r = items.length ? await send({ type: 'QUEUE_DOWNLOADS', items }) : null;
      toast(
        r?.blocked
          ? r.error
          : !items.length
            ? 'Open the post once if it contains video/GIF media.'
            : r?.added
              ? `Queued ${r.added} file${r.added === 1 ? '' : 's'}`
              : r?.skipped
                ? 'Already downloaded / queued'
                : 'Could not queue media'
      );
      b.disabled = false;
      b.removeAttribute('aria-busy');
      b.classList.remove('busy');
      b.title = r?.added
        ? 'Media queued in XVault'
        : r?.skipped
          ? 'Already downloaded or queued'
          : 'Download media with XVault';
      updateArchiveIndicators(true);
      setTimeout(() => updateArchiveIndicators(true), 6500);
    };
    g.append(b);
  }
  function currentContext() {
    if (archiveContext) return archiveContext;
    const p = location.pathname;
    if (p === '/i/history') return { scope: 'bookmarks' };
    if (p === '/i/history/likes') return { scope: 'likes' };
    const m = p.match(/^\/([A-Za-z0-9_]{1,15})(?:\/(?:with_replies|media))?\/?$/);
    return m ? { scope: 'profile', profileHandle: m[1] } : { scope: 'timeline' };
  }
  function mediaFiles(t, ctx = {}) {
    let i = 0;
    return (t.media || [])
      .map(m => {
        let url = m.url,
          mediaType = m.type,
          mime = null;
        const native = urlExt(m.url),
          variants = (m.variants || []).filter(x => x.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (m.type === 'animated_gif') {
          mediaType = 'animated_gif';
          if (['gif', 'webp'].includes(native)) {
            url = m.url;
            mime = native === 'gif' ? 'image/gif' : 'image/webp';
          } else {
            const v = variants.find(x => /video\/(mp4|webm)/i.test(x.contentType || '')) || variants[0];
            url = m.playbackUrl || v?.url || url;
            mime = v?.contentType || 'video/mp4';
          }
        } else if (m.type === 'video') {
          mediaType = 'video';
          const v = variants.find(x => /video\/(mp4|webm)/i.test(x.contentType || '')) || variants[0];
          url = m.playbackUrl || v?.url || url;
          mime = v?.contentType || null;
        } else if (m.type === 'photo') mediaType = 'image';
        if (!url) return null;
        return {
          url,
          originalSourceUrl: m.url,
          previewUrl: m.preview || m.url,
          playbackUrl: m.playbackUrl || null,
          tweetId: t.id,
          sourcePostUrl: t.url || `https://x.com/${t.author?.handle || 'i'}/status/${t.id}`,
          author: t.author?.handle,
          index: ++i,
          mediaId: m.id || null,
          mediaType,
          logicalType: m.type === 'animated_gif' ? 'animation' : mediaType,
          sourceMediaType: m.type,
          createdAt: t.createdAt || null,
          mime,
          width: m.width || null,
          height: m.height || null,
          archiveScope: ctx.scope || 'timeline',
          profileHandle: ctx.profileHandle || null,
          profileRelation:
            ctx.scope === 'profile' &&
            ctx.profileHandle &&
            t.author?.handle &&
            t.author.handle.toLowerCase() !== String(ctx.profileHandle).toLowerCase()
              ? 'retweets'
              : 'media',
          runId: ctx.runId || null,
        };
      })
      .filter(Boolean);
  }
  async function ingest(root, meta = {}) {
    if (dead) return { tweets: 0, media: 0 };
    const ctx = meta.context || archiveContext || currentContext(),
      enriched = { ...meta, context: ctx };
    const { tweets, users } = normalize(root, enriched);
    for (const t of tweets) cache.set(t.id, merge(cache.get(t.id), t));
    await send({ type: 'STORE_RECORDS', tweets, users, context: ctx });
    await send({
      type: 'STORE_CAPTURE',
      capture: {
        key: `${meta.source || 'capture'}:${meta.operation || 'unknown'}:${Date.now()}:${Math.random()}`,
        source: meta.source,
        operation: meta.operation,
        runId: meta.runId || ctx.runId || null,
        page: meta.page || null,
        tweetCount: tweets.length,
        userCount: users.length,
        capturedAt: Date.now(),
        context: ctx,
      },
    });
    let media = 0;
    if (ctx?.fullMirror || settings.fullMirrorMode || settings.mirrorMode === 'mirror') {
      const items = tweets.flatMap(t => mediaFiles(t, ctx));
      media = items.length;
      if (items.length) send({ type: 'QUEUE_DOWNLOADS', items });
    }
    updateWidget();
    return { tweets: tweets.length, media };
  }
  function normalize(root, meta) {
    const ts = new Map(),
      us = new Map(),
      q = [root],
      seen = new WeakSet();
    let budget = 500000;
    while (q.length && --budget) {
      const n = q.pop();
      if (!n || typeof n !== 'object' || seen.has(n)) continue;
      seen.add(n);
      const t = parseTweet(n, meta);
      if (t) ts.set(t.id, merge(ts.get(t.id), t));
      const u = parseUser(n);
      if (u) us.set(u.id, { ...us.get(u.id), ...u });
      for (const v of Array.isArray(n) ? n : Object.values(n)) if (v && typeof v === 'object') q.push(v);
    }
    return { tweets: [...ts.values()], users: [...us.values()] };
  }
  function unwrap(x) {
    for (let i = 0; i < 5; i++) {
      if (!x || typeof x !== 'object') break;
      if (x.__typename === 'TweetWithVisibilityResults' && x.tweet) x = x.tweet;
      else if (x.result && typeof x.result === 'object' && (x.result.rest_id || x.result.legacy)) x = x.result;
      else break;
    }
    return x;
  }
  function userInfo(u) {
    u = unwrap(u) || {};
    const l = u.legacy || {},
      c = u.core || {},
      a = u.avatar || {},
      v = u.verification || {};
    return {
      id: u.rest_id || l.id_str || null,
      handle: c.screen_name || l.screen_name || null,
      name: c.name || l.name || null,
      avatar: a.image_url || l.profile_image_url_https || l.profile_image_url || null,
      banner: l.profile_banner_url || u.profile_banner_url || null,
      bio: l.description || '',
      followers: l.followers_count ?? null,
      following: l.friends_count ?? null,
      posts: l.statuses_count ?? null,
      verified: Boolean(v.verified || l.verified || u.is_blue_verified),
    };
  }
  function parseTweet(n, meta) {
    const x = unwrap(n),
      l = x?.legacy,
      id = x?.rest_id || l?.id_str;
    if (!id || !l || (!l.full_text && !x.note_tweet)) return null;
    const u = unwrap(x?.core?.user_results?.result || x?.core?.user_result?.result),
      ui = userInfo(u),
      text = x?.note_tweet?.note_tweet_results?.result?.text || l.full_text || '';
    const media = (l.extended_entities?.media || l.entities?.media || []).map(m => {
      const vars = (m.video_info?.variants || []).map(v => ({
        url: v.url,
        bitrate: v.bitrate || 0,
        contentType: v.content_type || null,
      }));
      const best = vars
        .filter(v => v.url && /video\/(mp4|webm)/i.test(v.contentType || 'video/mp4'))
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      return {
        id: m.id_str,
        type: m.type || 'unknown',
        url: m.type === 'photo' ? orig(m.media_url_https || m.media_url) : m.media_url_https || m.media_url,
        preview: m.media_url_https || m.media_url,
        playbackUrl: m.type === 'video' || m.type === 'animated_gif' ? best?.url || null : null,
        width: m.original_info?.width || null,
        height: m.original_info?.height || null,
        variants: vars,
      };
    });
    return {
      id: String(id),
      text,
      createdAt: l.created_at ? new Date(l.created_at).toISOString() : null,
      url: ui.handle ? `https://x.com/${ui.handle}/status/${id}` : `https://x.com/i/status/${id}`,
      author: ui,
      metrics: {
        replies: metricNumber(l.reply_count ?? x?.reply_count),
        reposts: metricNumber(l.retweet_count ?? x?.retweet_count),
        likes: metricNumber(l.favorite_count ?? x?.favorite_count),
        quotes: metricNumber(l.quote_count ?? x?.quote_count),
        bookmarks: metricNumber(l.bookmark_count ?? x?.bookmark_count),
        views: metricNumber(x?.views?.count ?? x?.view_count ?? l.view_count ?? x?.legacy?.view_count),
      },
      media: uniq(media),
      conversationId: l.conversation_id_str || null,
      replyToId: l.in_reply_to_status_id_str || null,
      language: l.lang || null,
      sensitive: Boolean(l.possibly_sensitive || l.possibly_sensitive_editable || x?.possibly_sensitive),
      sourceFlags: [meta.source, meta.operation].filter(Boolean),
      archiveSources: [meta?.context?.scope, meta.source].filter(Boolean),
      archiveProfile: meta?.context?.profileHandle || null,
      profileRelation:
        meta?.context?.scope === 'profile' &&
        meta?.context?.profileHandle &&
        ui.handle &&
        ui.handle.toLowerCase() !== String(meta.context.profileHandle).toLowerCase()
          ? 'retweets'
          : 'media',
      observedRunId: meta?.context?.runId || meta?.runId || null,
      archivedAt: Date.now(),
    };
  }
  function parseUser(n) {
    const x = unwrap(n),
      ui = userInfo(x);
    if (!ui.id || !ui.handle) return null;
    return { ...ui, id: String(ui.id), archivedAt: Date.now() };
  }
  function merge(a, b) {
    if (!a) return b;
    if (!b) return a;
    return {
      ...a,
      ...b,
      author: { ...(a.author || {}), ...(b.author || {}) },
      metrics: { ...(a.metrics || {}), ...(b.metrics || {}) },
      media: uniq([...(a.media || []), ...(b.media || [])]),
      sourceFlags: [...new Set([...(a.sourceFlags || []), ...(b.sourceFlags || [])])],
      archivedAt: Math.max(a.archivedAt || 0, b.archivedAt || 0),
    };
  }
  function uniq(a) {
    const m = new Map();
    for (const x of a || []) if (x?.url) m.set(`${x.type}:${x.url}`, x);
    return [...m.values()];
  }
  function orig(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'pbs.twimg.com') u.searchParams.set('name', 'orig');
      return u.href;
    } catch {
      return url;
    }
  }
  function urlExt(u) {
    try {
      return new URL(u).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || '';
    } catch {
      return '';
    }
  }
  function checkpointKey(ctx) {
    if (!ctx) return 'archive:unknown';
    return `archive:${ctx.scope || 'unknown'}:${ctx.profileHandle || ''}`;
  }
  function signal(id, type, data) {
    const w = directWait.get(id);
    if (!w) return;
    if (type === 'page' && !w.firstDone) {
      w.firstDone = true;
      w.firstResolve(data);
    }
    if (type === 'done' || type === 'error') {
      w.doneResolve({ type, data });
      directWait.delete(id);
    }
  }
  function debug(id, m) {
    send({
      type: 'STORE_ACTION',
      actionType: 'debug',
      text: m.message || m.phase || 'Direct crawler',
      meta: { runId: id, ...m },
    });
  }
  async function waitDirect(runId) {
    let firstResolve, doneResolve;
    const first = new Promise(r => (firstResolve = r)),
      done = new Promise(r => (doneResolve = r)),
      w = { firstResolve, doneResolve, firstDone: false };
    directWait.set(runId, w);
    return { first, done, w };
  }
  async function smartArchive(opts) {
    const runId = opts.runId || crypto.randomUUID(),
      ctx = {
        scope: opts.source || 'timeline',
        profileHandle: opts.profileHandle || null,
        runId,
        fullMirror: opts.fullMirror ?? settings.fullMirrorMode,
      };
    if (ctx.scope === 'profile') {
      const body = (document.body?.innerText || '').toLowerCase();
      if (
        /this account doesn.?t exist|account doesn.?t exist|try searching for another|пользователь не существует/.test(
          body
        )
      ) {
        toast(`@${ctx.profileHandle || 'profile'} does not exist or is unavailable`);
        await send({
          type: 'STORE_JOB',
          job: {
            id: runId,
            state: 'error',
            phase: 'profile-check',
            page: 0,
            error: 'Profile not found on X',
            updatedAt: Date.now(),
            context: ctx,
          },
        });
        return { ok: false, error: 'Profile not found' };
      }
    }
    archiveContext = ctx;
    await send({
      type: 'STORE_JOB',
      job: { id: runId, state: 'initializing', phase: 'init', page: 0, updatedAt: Date.now(), context: ctx },
    });
    await send({
      type: 'STORE_ACTION',
      actionType: 'archive',
      text: `Starting ${ctx.scope}${ctx.profileHandle ? ` @${ctx.profileHandle}` : ''} archive`,
      meta: { runId },
    });
    if (settings.preventSleepDuringTasks) send({ type: 'WAKE', on: true });
    let directOk = false;
    if (opts.template) {
      const wait = await waitDirect(runId),
        cp = settings.checkpointResume ? await send({ type: 'GET_CHECKPOINT', key: checkpointKey(ctx) }) : null;
      window.postMessage(
        {
          source: CONTENT,
          type: 'DIRECT_START',
          runId,
          template: opts.template,
          settings,
          checkpoint: cp?.checkpoint || null,
        },
        '*'
      );
      const first = await Promise.race([
        wait.first,
        new Promise(r => setTimeout(() => r(null), settings.firstPageTimeout || 12000)),
      ]);
      if (first) {
        directOk = true;
        const end = await Promise.race([
          wait.done,
          new Promise(r =>
            setTimeout(() => r({ type: 'timeout' }), Math.max(60000, (settings.firstPageTimeout || 12000) * 40))
          ),
        ]);
        if (end.type === 'error') directOk = false;
      } else {
        window.postMessage({ source: CONTENT, type: 'DIRECT_CANCEL', runId }, '*');
        await send({
          type: 'STORE_JOB',
          job: {
            id: runId,
            state: 'fallback',
            phase: 'fallback',
            page: 0,
            error: 'Direct crawler did not return page 1 in time',
            updatedAt: Date.now(),
            context: ctx,
          },
        });
      }
    }
    if (!directOk && settings.smartFallback !== false) {
      await send({
        type: 'STORE_ACTION',
        actionType: 'fallback',
        text: 'Direct crawler unavailable — switched to adaptive scroll',
        meta: { runId, scope: ctx.scope },
      });
      await adaptiveScroll({
        runId,
        context: ctx,
        verificationPasses: settings.completionVerification ? settings.verificationPasses : 0,
      });
    } else if (directOk && settings.completionVerification && settings.verificationPasses > 0) {
      await verificationSweep(runId, ctx, settings.verificationPasses);
    }
    await send({
      type: 'STORE_JOB',
      job: {
        id: runId,
        state: 'complete',
        phase: directOk ? 'direct+verify' : 'scroll',
        page: 0,
        updatedAt: Date.now(),
        context: ctx,
      },
    });
    await send({
      type: 'STORE_ACTION',
      actionType: 'complete',
      text: `${ctx.scope} archive complete`,
      meta: { runId },
    });
    if (settings.completionNotifications)
      send({
        type: 'NOTIFY',
        title: 'XVault archive complete',
        message: `${ctx.scope}${ctx.profileHandle ? ` @${ctx.profileHandle}` : ''} finished.`,
      });
    if (settings.preventSleepDuringTasks) send({ type: 'WAKE', on: false });
    archiveContext = null;
    updateWidget();
    return { ok: true, runId, directOk };
  }
  async function adaptiveScroll(o = {}) {
    if (scrollJob) return { ok: false, error: 'Scroll archive already running' };
    const ctx = o.context || archiveContext || currentContext(),
      j = (scrollJob = { cancelled: false, idle: 0, rounds: 0, runId: o.runId || crypto.randomUUID() }),
      delay = settings.scrollDelay || 500,
      maxIdle = settings.scrollIdleRounds || 9;
    let lastH = 0,
      lastCount = cache.size,
      knownStreak = 0;
    const knownStart = settings.incrementalSync
      ? new Set((await send({ type: 'GET_TWEET_IDS' }))?.ids || [])
      : new Set();
    await send({
      type: 'STORE_JOB',
      job: { id: j.runId, state: 'running', phase: 'scroll', page: 0, updatedAt: Date.now(), context: ctx },
    });
    window.scrollTo({ top: 0, behavior: 'instant' });
    await sleep(500);
    while (!j.cancelled && !dead) {
      scan();
      const h = document.documentElement.scrollHeight,
        count = cache.size,
        visible = [...document.querySelectorAll('article[data-testid="tweet"]')]
          .map(domTweet)
          .filter(Boolean)
          .map(x => x.id);
      if (settings.incrementalSync && visible.length && knownStart.size) {
        const ratio = visible.filter(id => knownStart.has(String(id))).length / visible.length;
        knownStreak = ratio > 0.85 ? knownStreak + 1 : 0;
      } else knownStreak = 0;
      j.idle = h === lastH && count === lastCount ? j.idle + 1 : 0;
      lastH = h;
      lastCount = count;
      j.rounds++;
      await send({
        type: 'STORE_JOB',
        job: {
          id: j.runId,
          state: 'running',
          phase: 'scroll',
          page: j.rounds,
          posts: count,
          updatedAt: Date.now(),
          context: ctx,
        },
      });
      await send({
        type: 'STORE_CHECKPOINT',
        checkpoint: {
          key: checkpointKey(ctx),
          runId: j.runId,
          phase: 'scroll',
          round: j.rounds,
          scrollY: scrollY,
          at: Date.now(),
          context: ctx,
        },
      });
      if (j.idle >= maxIdle) break;
      if (settings.incrementalSync && knownStreak >= 3 && j.rounds > 5) break;
      window.scrollBy({ top: Math.max(420, innerHeight * (settings.scrollStep || 0.82)), behavior: 'smooth' });
      await sleep(delay);
    }
    const result = { ok: true, cancelled: j.cancelled, captured: cache.size, rounds: j.rounds };
    scrollJob = null;
    return result;
  }
  async function verificationSweep(runId, ctx, passes = 1) {
    for (let p = 0; p < passes; p++) {
      await send({
        type: 'STORE_JOB',
        job: { id: runId, state: 'verifying', phase: 'verify', page: p + 1, updatedAt: Date.now(), context: ctx },
      });
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      await sleep(700);
      scan();
      window.scrollBy({ top: -Math.max(600, innerHeight * 0.8), behavior: 'smooth' });
      await sleep(500);
      scan();
    }
  }
  async function testCrawler() {
    const before = cache.size;
    scan();
    window.scrollBy({ top: Math.max(500, innerHeight * 0.65), behavior: 'smooth' });
    await sleep(Math.max(400, settings.scrollDelay || 500));
    scan();
    return {
      ok: true,
      before,
      after: cache.size,
      found: cache.size - before,
      route: location.pathname,
      templates: [...templates.keys()],
    };
  }
  function mountWidget() {
    if (dead || settings.showFloatingButton === false || document.getElementById('xvault-corner')) return;
    const b = document.createElement('button');
    b.id = 'xvault-corner';
    b.setAttribute('aria-label', 'Open XVault Library. Press Shift+F10 for archive actions.');
    b.innerHTML =
      '<span class="xv-progress"></span><span class="xv-core"><b>XV</b><small>VAULT</small></span><span class="xv-badge">0</span>';
    document.documentElement.append(b);
    let moved = false,
      start = null;
    b.onpointerdown = e => {
      if (settings.cornerDraggable === false) return;
      start = {
        x: e.clientX,
        y: e.clientY,
        right: parseFloat(getComputedStyle(b).right) || 18,
        bottom: parseFloat(getComputedStyle(b).bottom) || 18,
      };
      moved = false;
      b.setPointerCapture(e.pointerId);
      b.classList.add('dragging');
    };
    b.onpointermove = e => {
      if (!start) return;
      const dx = e.clientX - start.x,
        dy = e.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
      b.style.right = `${Math.max(8, Math.min(innerWidth - b.offsetWidth - 8, start.right - dx))}px`;
      b.style.bottom = `${Math.max(8, Math.min(innerHeight - b.offsetHeight - 8, start.bottom - dy))}px`;
    };
    b.onpointerup = async () => {
      if (!start) return;
      let right = parseFloat(b.style.right) || 18,
        bottom = parseFloat(b.style.bottom) || 18;
      if (settings.cornerSnap !== false) {
        const left = innerWidth - right - b.offsetWidth;
        right = left < right ? Math.max(12, innerWidth - b.offsetWidth - 14) : 14;
      }
      start = null;
      b.classList.remove('dragging');
      await send({ type: 'SET_SETTINGS', settings: { cornerRight: right, cornerBottom: bottom } });
    };
    b.onclick = e => {
      if (moved) {
        moved = false;
        return;
      }
      send({ type: 'OPEN_DASHBOARD' });
    };
    b.onmouseenter = () => {
      clearTimeout(hoverTimer);
      if (settings.floatingHoverPanel !== false) showHover(b);
    };
    b.onmouseleave = () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(hideHover, 450);
    };
    b.oncontextmenu = e => {
      e.preventDefault();
      showMenu(b);
    };
    applyWidgetSettings();
    updateWidget();
  }
  function applyWidgetSettings() {
    const b = document.getElementById('xvault-corner');
    if (!b) {
      mountWidget();
      return;
    }
    b.style.right = `${settings.cornerRight ?? 18}px`;
    b.style.bottom = `${settings.cornerBottom ?? 18}px`;
    b.style.setProperty('--xv-scale', settings.cornerScale || 1);
    b.style.setProperty('--xv-opacity', settings.cornerOpacity ?? 1);
    b.classList.toggle('edge', settings.floatingMode === 'edge');
    b.classList.toggle('autohide', settings.floatingAutoHide !== false);
  }
  let receiptSignature = '',
    receiptRequestedAt = 0,
    receiptGeneration = 0,
    receiptWrite = Promise.resolve();
  async function updateArchiveIndicators(force = false) {
    if (dead) return;
    await receiptWrite;
    if (dead) return;
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, 50),
      entries = articles.map(article => ({ article, tweet: domTweet(article) })).filter(row => row.tweet?.id),
      signature = entries.map(row => row.tweet.id).join(',');
    if (!signature || (!force && signature === receiptSignature && Date.now() - receiptRequestedAt < 5000)) return;
    receiptSignature = signature;
    receiptRequestedAt = Date.now();
    const generation = ++receiptGeneration,
      result = await send({ type: 'GET_ARCHIVE_INDICATORS', ids: [...new Set(entries.map(row => row.tweet.id))] });
    if (dead || generation !== receiptGeneration || !result?.ok) return;
    const labels = {
      'not-archived': 'Not archived',
      archived: 'Archived',
      downloaded: 'Downloaded',
      shared: 'Shared file from another post',
      downloading: 'Downloading',
      partial: 'Partially downloaded',
      missing: 'Not saved for this post',
      failed: 'Download failed',
      unknown: 'Archive status unavailable',
    };
    const states = new Map((result.rows || []).map(row => [String(row.id), row.status]));
    for (const { article, tweet } of entries) {
      if (domTweet(article)?.id !== tweet.id) continue;
      const button = article.querySelector('.xvault-download');
      if (!button) continue;
      const status = states.get(tweet.id);
      if (!status) continue;
      button.dataset.archiveState = status;
      button.setAttribute('aria-label', 'XVault - ' + labels[status]);
      button.title = labels[status] + ' · Download media with XVault';
    }
  }
  async function updateWidget() {
    const b = document.getElementById('xvault-corner');
    if (!b || dead) return;
    const badge = b.querySelector('.xv-badge'),
      p = b.querySelector('.xv-progress');
    const s = await send({ type: 'STATS' });
    if (!s) return;
    const q = s.downloadQueue || {},
      activeQ = (q.queued || 0) + (q.downloading || 0);
    badge.textContent =
      settings.showQueueBadge !== false && activeQ
        ? String(activeQ)
        : s.tweets > 999
          ? `${(s.tweets / 1000).toFixed(s.tweets > 9999 ? 0 : 1)}k`
          : String(s.tweets || 0);
    const pct = q.totalBytes > 0 ? Math.round((q.bytesReceived / q.totalBytes) * 100) : activeQ ? 12 : 0;
    p?.style.setProperty('--p', pct + '%');
    b.classList.toggle('busy', activeQ > 0 || !!archiveContext);
    b.dataset.state = archiveContext ? 'ARC' : activeQ ? 'DL' : 'XV';
  }
  function showHover(b) {
    hideHover();
    const p = document.createElement('div');
    p.id = 'xvault-hover';
    p.innerHTML =
      '<b>XVault</b><small>Quick actions</small><button data-a="smart">Archive this page</button><button data-a="media">Download captured media</button><button data-a="panel">Quick panel</button><button data-a="dash">Dashboard</button>';
    document.documentElement.append(p);
    const r = b.getBoundingClientRect();
    p.style.right = `${Math.max(12, innerWidth - r.left + 8)}px`;
    p.style.bottom = `${Math.max(12, innerHeight - r.bottom - 4)}px`;
    p.onmouseenter = () => clearTimeout(hoverTimer);
    p.onmouseleave = () => (hoverTimer = setTimeout(hideHover, 300));
    p.onclick = async e => {
      const a = e.target.closest('button')?.dataset.a;
      if (!a) return;
      if (a === 'dash') send({ type: 'OPEN_DASHBOARD' });
      if (a === 'panel') send({ type: 'OPEN_SIDE_PANEL' });
      if (a === 'media') {
        const items = [...cache.values()].flatMap(t => mediaFiles(t, currentContext()));
        const r = await send({ type: 'QUEUE_DOWNLOADS', items });
        toast(r?.blocked ? r.error : r?.added ? `Queued ${r.added} media files` : 'Nothing new to queue');
      }
      if (a === 'smart') {
        const ctx = currentContext();
        smartArchive({
          source: ctx.scope,
          profileHandle: ctx.profileHandle,
          template: bestTemplate(ctx.scope),
          fullMirror: settings.fullMirrorMode,
        });
      }
      hideHover();
    };
  }
  function hideHover() {
    document.getElementById('xvault-hover')?.remove();
  }
  function showMenu(b) {
    document.getElementById('xvault-menu')?.remove();
    const m = document.createElement('div');
    m.id = 'xvault-menu';
    m.setAttribute('role', 'menu');
    m.setAttribute('aria-label', 'XVault archive actions');
    m.innerHTML =
      '<button data-a="dash">Dashboard</button><button data-a="pause">Pause all</button><button data-a="media">Media queue</button><button data-a="library">Library</button><button data-a="settings">Settings</button><button data-a="reset">Reset position</button><button data-a="hide">Hide XV</button>';
    document.documentElement.append(m);
    const r = b.getBoundingClientRect();
    m.style.right = `${Math.max(12, Math.min(innerWidth - r.left + 8, innerWidth - m.offsetWidth - 12))}px`;
    m.style.bottom = `${Math.max(12, Math.min(innerHeight - r.bottom, innerHeight - m.offsetHeight - 12))}px`;
    for (const item of m.querySelectorAll('button')) item.setAttribute('role', 'menuitem');
    const close = () => {
      const focused = m.contains(document.activeElement);
      m.remove();
      if (focused && b.isConnected) b.focus();
    };
    m.addEventListener('keydown', event => {
      const items = [...m.querySelectorAll('button')],
        at = items.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        items[
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? items.length - 1
              : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        ]?.focus();
      }
    });
    requestAnimationFrame(() => m.querySelector('button')?.focus());
    m.onclick = async e => {
      const a = e.target.closest('button')?.dataset.a;
      if (!a) return;
      if (a === 'dash') send({ type: 'OPEN_DASHBOARD' });
      if (['media', 'library', 'settings'].includes(a)) send({ type: 'OPEN_DASHBOARD', page: a });
      if (a === 'reset') {
        settings.cornerRight = 18;
        settings.cornerBottom = 18;
        await send({ type: 'RESET_FLOATING_POSITION' });
        applyWidgetSettings();
      }
      if (a === 'hide') {
        settings.showFloatingButton = false;
        await send({ type: 'SET_SETTINGS', settings: { showFloatingButton: false } });
        b.remove();
      }
      if (a === 'pause') {
        if (scrollJob) scrollJob.cancelled = true;
        if (archiveContext?.runId)
          window.postMessage({ source: CONTENT, type: 'DIRECT_PAUSE', runId: archiveContext.runId }, '*');
        send({ type: 'PAUSE_ALL_DOWNLOADS' });
        toast('Archives and active downloads paused');
      }
      close();
    };
    setTimeout(() => document.addEventListener('click', close, { once: true }), 0);
  }
  function bestTemplate(kind) {
    const arr = [...templates.values()]
      .map(t => ({ t, s: score(t, kind) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return arr[0]?.t || null;
  }
  function score(t, k) {
    const op = t.operation || '',
      p = t.pagePath || '';
    let s = 0;
    if (k === 'bookmarks') {
      if (/bookmark/i.test(op)) s += 100;
      if (p === '/i/history') s += 90;
      if (/like/i.test(op)) s -= 100;
    }
    if (k === 'likes') {
      if (/like|favorite/i.test(op)) s += 100;
      if (p === '/i/history/likes') s += 100;
    }
    if (k === 'profile') {
      if (/UserTweetsAndReplies/i.test(op)) s += 180;
      if (/user.*tweet|tweet.*user|UserTweets|UserMedia/i.test(op)) s += 100;
      if (/^\/[A-Za-z0-9_]{1,15}\/?$/.test(p)) s += 40;
    }
    return s;
  }
  if (!dead)
    try {
      chrome.runtime.onMessage.addListener((m, _s, reply) => {
        (async () => {
          if (m.type === 'XV_GET_TEMPLATES') {
            const z = await getCaptureTemplates();
            for (const [k, v] of Object.entries(z)) templates.set(k, v);
            window.postMessage({ source: CONTENT, type: 'GET_TEMPLATES' }, '*');
            return { ok: true, templates: Object.fromEntries(templates) };
          }
          if (m.type === 'XV_SMART_START') {
            smartArchive(m).catch(e =>
              send({
                type: 'STORE_JOB',
                job: { id: m.runId, state: 'error', phase: 'smart', error: String(e), updatedAt: Date.now() },
              })
            );
            return { ok: true, runId: m.runId };
          }
          if (m.type === 'XV_SCROLL_START') {
            archiveContext = m.context || currentContext();
            return adaptiveScroll({ runId: m.runId || crypto.randomUUID(), context: archiveContext });
          }
          if (m.type === 'XV_SCROLL_STOP') {
            if (scrollJob) scrollJob.cancelled = true;
            return { ok: true };
          }
          if (m.type === 'XV_DIRECT_PAUSE' || m.type === 'XV_DIRECT_RESUME' || m.type === 'XV_DIRECT_CANCEL') {
            window.postMessage({ source: CONTENT, type: m.type.replace('XV_', ''), runId: m.runId }, '*');
            return { ok: true };
          }
          if (m.type === 'XV_DOWNLOAD_CURRENT') {
            const items = [...cache.values()].flatMap(t => mediaFiles(t, currentContext()));
            return await send({ type: 'QUEUE_DOWNLOADS', items });
          }
          if (m.type === 'XV_VALIDATE_PROFILE') {
            const body = (document.body?.innerText || '').toLowerCase();
            const missing =
              /this account doesn.?t exist|account doesn.?t exist|try searching for another|пользователь не существует|такой учетной записи не существует/.test(
                body
              );
            const hasProfile = !!document.querySelector(
              '[data-testid="UserName"], [data-testid="UserProfileHeader_Items"], a[href$="/followers"]'
            );
            return {
              ok: true,
              exists: !missing && (hasProfile || document.querySelector('article[data-testid="tweet"]') != null),
              missing,
              hasProfile,
              url: location.href,
            };
          }
          if (m.type === 'XV_TEST_CRAWLER') return await testCrawler();
          if (m.type === 'XV_REFRESH_INSTANT_SETTINGS') {
            const r = await send({ type: 'GET_SETTINGS' });
            if (r?.settings) {
              settings = r.settings;
              applyWidgetSettings();
            }
            return { ok: true };
          }
          return { ok: false };
        })()
          .then(reply)
          .catch(e => reply({ ok: false, error: String(e) }));
        return true;
      });
    } catch (e) {
      if (isContextError(e)) invalidate();
    }
  function toast(text) {
    if (dead) return;
    let t = document.getElementById('xvault-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'xvault-toast';
      t.setAttribute('role', 'status');
      t.setAttribute('aria-live', 'polite');
      document.documentElement.append(t);
    }
    t.textContent = text;
    t.classList.remove('show');
    void t.offsetWidth;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), 2600);
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
})();
