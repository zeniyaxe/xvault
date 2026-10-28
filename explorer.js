/* Local-only archive explorer. Deliberately avoids network requests and source mutation. */
(() => {
  document.title = 'XVault';
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = 'explorer.css';
  document.head.append(style);
  const studio = document.createElement('script');
  studio.src = 'settings-studio.js';
  document.head.append(studio);
  let rows = [],
    runs = [],
    transform = { x: 0, y: 0, scale: 1 },
    drag = null;
  const byId = id => document.getElementById(id),
    q = s => document.querySelector(s),
    qa = s => [...document.querySelectorAll(s)];
  const esc = s =>
    String(s ?? '').replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const number = n => new Intl.NumberFormat().format(n || 0);
  const boot = () => {
    if (byId('page-explorer')) return;
    const media = byId('page-media'),
      nav = q('.rail nav');
    if (!media || !nav) return;
    if (!q('[data-page="explorer"]'))
      q('[data-page="library"]')?.insertAdjacentHTML(
        'afterend',
        '<button class="nav" data-page="explorer"><span>Explore</span></button>'
      );
    media.insertAdjacentHTML(
      'beforebegin',
      `<section class="page" id="page-explorer"><div class="explorerBar"><div class="explorerTabs seg" role="tablist" aria-label="Explore"><button class="active" role="tab" data-xv-tab="time">Time machine</button><button role="tab" data-xv-tab="map">Media map</button><button role="tab" data-xv-tab="diff">Archive diff</button></div><p class="explorerNote">Local records only; nothing here touches X.</p></div><section class="explorerPane show" id="xv-time"><div class="timelineControl panel"><div class="panelhead"><div><h3 id="xv-time-label">Loading archive dates…</h3></div><b id="xv-time-count">0 posts</b></div><input id="xv-time-slider" type="range" min="0" max="0" value="0" disabled aria-label="Archive timeline"><div id="xv-time-markers" class="timeMarkers"></div></div><div id="xv-time-grid" class="timeMachineGrid"><div class="empty">Loading the local archive…</div></div></section><section class="explorerPane" id="xv-map"><div class="panel mapToolbar"><div><div><h3>Spatial archive</h3><p id="xv-map-summary">Loading media…</p></div><div class="row"><button id="xv-map-out">−</button><button id="xv-map-fit">Fit</button><button id="xv-map-in">+</button></div></div><div id="xv-map-stage" class="mapStage" aria-label="Zoomable archive media map"><div id="xv-map-world" class="mapWorld"></div><div class="mapHint">Scroll to zoom · drag empty space to pan · click media to open it</div></div></section><section class="explorerPane" id="xv-diff"><div class="grid"><section class="panel"><div class="panelhead"><div><h3>What each run found</h3></div><button id="xv-diff-refresh">Refresh</button></div><div id="xv-diff-list" class="diffList"><div class="empty">No completed archive run has been recorded yet.</div></div></section><section class="panel"><h3>Not observed is not deleted</h3><p>When a completed run no longer encounters a baseline post, XVault records it as <b>not observed</b>—never “deleted” without proof. Partial timelines and access changes are not evidence of deletion.</p><div id="xv-revision-summary" class="revisionSummary">Revision history is loading…</div></section></div></section></section>`
    );
    q('[data-page="explorer"]').onclick = () => {
      page('explorer');
      byId('title').textContent = 'Explore';
      load();
    };
    qa('[data-xv-tab]').forEach(b => (b.onclick = () => tab(b.dataset.xvTab)));
    byId('xv-time-slider').oninput = time;
    byId('xv-map-in').onclick = () => zoom(transform.scale * 1.25);
    byId('xv-map-out').onclick = () => zoom(transform.scale / 1.25);
    byId('xv-map-fit').onclick = fit;
    byId('xv-diff-refresh').onclick = load;
    wireMap();
    if (location.hash.slice(1) === 'explorer') {
      page('explorer');
      byId('title').textContent = 'Explore';
      load();
    }
  };
  const tab = name => {
    qa('[data-xv-tab]').forEach(x => {
      x.classList.toggle('active', x.dataset.xvTab === name);
      x.setAttribute('aria-selected', String(x.dataset.xvTab === name));
    });
    qa('.explorerPane').forEach(x => x.classList.toggle('show', x.id === `xv-${name}`));
    if (name === 'map') requestAnimationFrame(map);
    if (name === 'diff') diff();
  };
  async function load() {
    const r = await call({ type: 'GET_EXPLORER_DATA' });
    if (!r?.ok) {
      toast('Explorer could not read local archive data');
      return;
    }
    rows = r.data?.tweets || [];
    runs = r.data?.runs || [];
    time();
    diff(r.data?.revisionCount || 0);
    if (byId('xv-map').classList.contains('show')) map();
  }
  const dates = () =>
    rows
      .map(t => Date.parse(t.createdAt || t.archivedAt || 0))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
  function time() {
    const slider = byId('xv-time-slider'),
      ds = dates();
    if (!ds.length) {
      byId('xv-time-label').textContent = 'No dated posts in the local archive';
      byId('xv-time-count').textContent = '0 posts';
      byId('xv-time-grid').innerHTML = '<div class="empty">Archive posts with dates will appear here.</div>';
      slider.disabled = true;
      return;
    }
    const months = [...new Set(ds.map(d => new Date(d).toISOString().slice(0, 7)))],
      value = Math.min(Number(slider.value) || months.length - 1, months.length - 1);
    slider.max = String(months.length - 1);
    slider.value = String(value);
    slider.disabled = false;
    const limit = Date.parse(`${months[value]}-31T23:59:59.999Z`),
      subset = rows
        .filter(t => Date.parse(t.createdAt || t.archivedAt || 0) <= limit)
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    byId('xv-time-label').textContent =
      `Through ${new Date(limit).toLocaleString(undefined, { month: 'long', year: 'numeric' })}`;
    byId('xv-time-count').textContent = `${number(subset.length)} posts`;
    byId('xv-time-markers').innerHTML = months
      .filter((m, i) => i === 0 || i === months.length - 1 || m.endsWith('-01'))
      .map(m => `<span>${m.slice(0, 4)}</span>`)
      .join('');
    byId('xv-time-grid').innerHTML =
      subset.slice(0, 120).map(card).join('') || '<div class="empty">No matching local posts.</div>';
    qa('[data-xv-open]').forEach(b => (b.onclick = () => open(b.dataset.xvOpen)));
  }
  function card(t) {
    const m = t.media?.[0],
      src = m && (m.preview || m.url || m.playbackUrl);
    return `<article class="timeCard" data-xv-open="${esc(t.id)}">${src ? `<img loading="lazy" src="${esc(src)}" alt="">` : '<div class="timeNoMedia">Text</div>'}<div><b>${esc(t.author?.name || t.author?.handle || 'Unknown')}</b><small>@${esc(t.author?.handle || 'unknown')} · ${new Date(t.createdAt || t.archivedAt).toLocaleDateString()}</small><p>${esc((t.text || '').slice(0, 150))}</p></div></article>`;
  }
  function open(id) {
    const post = rows.find(x => String(x.id) === String(id));
    if (post?.media?.length) openLightbox([post], 0, 0);
    else {
      page('library');
      q('#search').value = String(id);
      loadLib();
    }
  }
  function diff(revisionCount) {
    const complete = runs.filter(r => r.diff);
    byId('xv-diff-list').innerHTML =
      complete
        .map(r => {
          const d = r.diff.summary || {};
          return `<article class="diffRun"><header><div><b>${esc(r.profileHandle ? `@${r.profileHandle}` : r.source || 'archive')}</b><small>${new Date(r.finishedAt || r.startedAt).toLocaleString()}</small></div><span>${esc(r.state || 'complete')}</span></header><div><strong>+${number(d.postsAdded || 0)}</strong><small>new posts</small><strong>${number(d.postsChanged || 0)}</strong><small>revised</small><strong>${number(d.notObserved || 0)}</strong><small>not observed</small></div><p>${esc(r.diff.note || '')}</p></article>`;
        })
        .join('') || '<div class="empty">Diffs appear after a new archive run completes.</div>';
    byId('xv-revision-summary').innerHTML =
      `<b>${number(revisionCount ?? 0)} retained revision${revisionCount === 1 ? '' : 's'}</b><span>Content, author and media changes are stored as historical snapshots. Engagement counters remain live metadata.</span>`;
  }
  function seed(id) {
    let h = 2166136261;
    for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return (h >>> 0) / 4294967295;
  }
  function map() {
    const world = byId('xv-map-world');
    if (!world) return;
    const media = [];
    rows.forEach(t =>
      (t.media || []).forEach(m => {
        if (m.preview || m.url || m.playbackUrl) media.push({ t, m });
      })
    );
    const max = Math.max(100, Math.min(Number(settings.mediaMapLimit) || 900, 1500)),
      shown = media.slice(0, max),
      size = Math.max(1800, Math.ceil(Math.sqrt(shown.length || 1)) * 180);
    world.style.width = `${size}px`;
    world.style.height = `${size}px`;
    world.innerHTML = shown
      .map(({ t, m }, i) => {
        const a = seed(`${t.id}:${m.id || i}`) * Math.PI * 2,
          r = Math.sqrt(seed(`${m.id || i}:${t.id}`)) * (size * 0.44),
          x = size / 2 + Math.cos(a) * r,
          y = size / 2 + Math.sin(a) * r,
          src = m.preview || m.url || m.playbackUrl;
        return `<button class="mapTile" data-xv-open="${esc(t.id)}" style="left:${x}px;top:${y}px"><img loading="lazy" src="${esc(src)}" alt="${esc(t.text || 'Archived media')}"><span>@${esc(t.author?.handle || 'unknown')}</span></button>`;
      })
      .join('');
    byId('xv-map-summary').textContent =
      `${number(media.length)} media · showing ${number(shown.length)} local thumbnails`;
    qa('.mapTile').forEach(
      b =>
        (b.onclick = e => {
          e.stopPropagation();
          open(b.dataset.xvOpen);
        })
    );
    fit();
  }
  function wireMap() {
    const stage = byId('xv-map-stage');
    stage.onwheel = e => {
      e.preventDefault();
      zoom(transform.scale * (e.deltaY > 0 ? 0.86 : 1.16));
    };
    stage.onpointerdown = e => {
      if (e.target.closest('.mapTile')) return;
      drag = { x: e.clientX, y: e.clientY, ox: transform.x, oy: transform.y };
      stage.setPointerCapture(e.pointerId);
    };
    stage.onpointermove = e => {
      if (!drag) return;
      transform.x = drag.ox + e.clientX - drag.x;
      transform.y = drag.oy + e.clientY - drag.y;
      paint();
    };
    stage.onpointerup = stage.onpointercancel = () => (drag = null);
  }
  function zoom(scale) {
    transform.scale = Math.max(0.18, Math.min(3, scale));
    paint();
  }
  function fit() {
    const stage = byId('xv-map-stage'),
      world = byId('xv-map-world');
    if (!stage || !world) return;
    const w = world.offsetWidth || 1800,
      h = world.offsetHeight || 1800;
    transform.scale = Math.min(0.72, Math.max(0.18, Math.min(stage.clientWidth / w, stage.clientHeight / h) * 0.92));
    transform.x = (stage.clientWidth - w * transform.scale) / 2;
    transform.y = (stage.clientHeight - h * transform.scale) / 2;
    paint();
  }
  function paint() {
    const world = byId('xv-map-world');
    if (world) world.style.transform = `translate(${transform.x}px,${transform.y}px) scale(${transform.scale})`;
  }
  const _diffSettlingAware = diff;
  diff = function (revisionCount) {
    _diffSettlingAware(revisionCount);
    const el = byId('xv-diff-list');
    if (el && runs.some(r => r.state === 'settling' || r.state === 'finalizing'))
      el.insertAdjacentHTML('afterbegin', '<div class="diag">Archive run is settling late records…</div>');
  };
  boot();
})();
