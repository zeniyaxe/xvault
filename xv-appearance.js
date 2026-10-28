/* Appearance: the theme gallery (live preview, keyboard, revert), accent override, and layout/type preferences.
   Theme tokens live only in xv-base.css; the gallery reads them from a probe element, so previews cannot drift. */
(() => {
  const $ = selector => document.querySelector(selector);
  const THEMES = [
    { id: 'graphite', name: 'Graphite', note: 'The default. Matte dark with a brass accent.' },
    { id: 'oled', name: 'True black', note: 'Pure black ground for OLED screens and viewing media.' },
    { id: 'midnight', name: 'Midnight', note: 'Blue-ink dark with a cool accent.' },
    { id: 'slate', name: 'Slate', note: 'Neutral cool gray, low saturation.' },
    { id: 'forest', name: 'Forest', note: 'Deep green dark, easy on long sessions.' },
    { id: 'ember', name: 'Ember', note: 'Warm brown-black with an orange accent.' },
    { id: 'violet', name: 'Plum', note: 'Dusky purple dark.' },
    { id: 'terminal', name: 'Terminal', note: 'Restrained phosphor green on near-black.' },
    { id: 'contrast', name: 'High contrast', note: 'White on black, strong borders, yellow accent.' },
    { id: 'paper', name: 'Paper', note: 'Light, neutral paper.', light: true },
    { id: 'linen', name: 'Linen', note: 'Warm light with a rust accent.', light: true },
    { id: 'cloud', name: 'Cloud', note: 'Cool light gray with a blue accent.', light: true }
  ];
  const ALIASES = { glacier: 'slate', aurora: 'forest', rose: 'violet' };
  const ACCENTS = ['#d6a84e', '#e48a4a', '#e0675c', '#e58aa3', '#b69cf0', '#6ea8fe', '#64cfae', '#a3d35f'];
  const WIDTHS = { rail: { narrow: 176, normal: 208, wide: 248 }, facet: { narrow: 200, normal: 232, wide: 284 }, inspector: { narrow: 340, normal: 380, wide: 460 } };
  const reduced = () => ['off', 'reduced'].includes(document.body.dataset.motion) || matchMedia('(prefers-reduced-motion: reduce)').matches;
  const meta = id => THEMES.find(theme => theme.id === (ALIASES[id] || id)) || THEMES[0];
  const committed = () => meta(settings.theme).id;
  let previewTimer = 0, revertTimer = 0, fadeTimer = 0, previewTheme = '', pendingTheme = '', commitTail = Promise.resolve(), commitGeneration = 0, cards = new Map();

  function tokens(id) {
    const probe = document.createElement('div');
    probe.hidden = true;
    probe.dataset.theme = id;
    document.body.append(probe);
    const style = getComputedStyle(probe), read = name => style.getPropertyValue(name).trim();
    const out = { g: read('--ground'), s: read('--surface'), r: read('--raised'), rh: read('--raised-hi'), l: read('--line'), t: read('--text'), m: read('--muted'), a: read('--accent'), ai: read('--accent-ink'), mb: read('--media-bg'), d: read('--danger'), ok: read('--ok') };
    probe.remove();
    return out;
  }

  function showTheme(id) {
    const body = document.body;
    if (body.dataset.theme === id) return;
    clearTimeout(fadeTimer);body.classList.remove('theme-fade');
    if (!reduced()) { body.classList.add('theme-fade'); fadeTimer = setTimeout(() => body.classList.remove('theme-fade'), (window.XVaultMotion?.duration(190)||190)+20); }
    body.dataset.theme = id;
    body.classList.toggle('light', !!meta(id).light);
  }

  function mini(values) {
    const style = Object.entries(values).map(([key, value]) => `--${key}:${value}`).join(';');
    const frames=[
      '<rect width="80" height="70" fill="#ded2bb"/><circle cx="58" cy="17" r="8" fill="#f6e7c6"/><path d="M0 46Q24 18 80 47V70H0" fill="#b58a67"/><path d="M0 58Q32 32 80 62V70H0" fill="#6c594d"/>',
      '<rect width="80" height="70" fill="#b7c1b6"/><path d="M0 64 30 14 49 46 60 30 80 61V70H0" fill="#4e675e"/><path d="m0 70 33-26 21 26" fill="#233c37"/>',
      '<rect width="80" height="70" fill="#d7d3c9"/><path d="M10 8h60v62H10z" fill="#8e8d84"/><path d="M25 16h30v54H25z" fill="#383f3f"/><path d="M0 70 25 50v20m55 0L55 50v20" fill="#bbb6a9"/>',
      '<rect width="80" height="70" fill="#232a2c"/><text x="8" y="44" fill="#e4dfd1" font-size="34" font-family="Georgia,serif">Aa</text><path d="M9 55h58" stroke="#b18d58" stroke-width="2"/>'
    ].map(frame=>`<svg viewBox="0 0 80 70" preserveAspectRatio="xMidYMid slice">${frame}</svg>`);
    return `<span class="tc-mini" style="${style}" aria-hidden="true"><i class="tc-rail"><b class="tc-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="m5 5 5 5h4l5-5M5 19l5-5h4l5 5M6 12h12"/></svg></b><b class="on"></b><b></b><b></b><b></b></i><i class="tc-facet"><span>LIBRARY</span><span class="tc-current">All posts</span><span>Inbox</span><s class="h"></s><span>Collections</span><s></s><s></s></i><span class="tc-main"><span class="tc-bar"><span class="tc-search">Search</span><span class="tc-chip"></span></span><span class="tc-grid">${frames.map((frame,index)=>`<u class="${index===1?'sel':''}">${frame}</u>`).join('')}</span><span class="tc-caption">4 archived references</span></span><i class="tc-insp"><span>INSPECTOR</span><span class="tc-inspector-image">${frames[1]}</span><s></s><s class="m"></s><span>Source · X</span><s class="m"></s><span>Private note</span><s></s><s></s></i></span>`;
  }

  function buildGallery() {
    const gallery = $('#themeGallery');
    if (!gallery || gallery.childElementCount) return;
    cards = new Map();
    for (const theme of THEMES) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'theme-card';
      card.dataset.themeId = theme.id;
      card.setAttribute('role', 'radio');
      card.setAttribute('aria-checked', 'false');
      card.innerHTML = `${mini(tokens(theme.id))}<span class="tc-name"><b>${theme.name}</b>${theme.light ? '<em>Light</em>' : ''}</span><span class="tc-note">${theme.note}</span><span class="tc-check" aria-hidden="true"></span>`;
      gallery.append(card);
      cards.set(theme.id, card);
    }
    const hint = document.createElement('p');
    hint.className = 'settingHint theme-hint';
    hint.textContent = 'Point at or focus a theme to preview it. Click, Enter or Space applies it. Escape or moving away restores the current theme.';
    gallery.after(hint);
    const preview = id => { clearTimeout(revertTimer); clearTimeout(previewTimer); previewTimer = setTimeout(() => { previewTheme=id;showTheme(id); }, 70); };
    const revert = () => { clearTimeout(previewTimer); clearTimeout(revertTimer); revertTimer = setTimeout(() => { previewTheme='';showTheme(pendingTheme||committed()); }, 100); };
    let keyboardBrowsing=false;gallery.addEventListener('pointermove',()=>{keyboardBrowsing=false},{passive:true});
    gallery.addEventListener('pointerover', event => { const card = event.target.closest('.theme-card'); if (card&&!keyboardBrowsing) preview(card.dataset.themeId); });
    gallery.addEventListener('pointerleave', revert);
    gallery.addEventListener('focusin', event => { const card = event.target.closest('.theme-card'); if (card) {markCards();preview(card.dataset.themeId);} });
    gallery.addEventListener('focusout', event => { if (!gallery.contains(event.relatedTarget)) {markCards();revert();} });
    gallery.addEventListener('click', async event => {
      const card = event.target.closest('.theme-card');
      if (!card) return;
      clearTimeout(previewTimer); clearTimeout(revertTimer);
      const id=card.dataset.themeId,generation=++commitGeneration;previewTheme='';pendingTheme=id;showTheme(id);
      const task=commitTail.then(()=>save({ theme:id }));commitTail=task.catch(()=>{});
      try{await task;toast(`Theme: ${meta(id).name}`)}catch(error){toast(error.message||'Theme could not be saved')}
      finally{if(generation===commitGeneration){pendingTheme='';showTheme(previewTheme||committed());markCards()}}
    });
    gallery.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault();clearTimeout(previewTimer);clearTimeout(revertTimer);previewTheme='';showTheme(pendingTheme||committed());return; }
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();keyboardBrowsing=true;
      const list = [...gallery.children].filter(node => node.classList.contains('theme-card'));
      const at = Math.max(0, list.indexOf(document.activeElement));
      const columns = Math.max(1, Math.round(gallery.clientWidth / (list[0]?.offsetWidth || 1)));
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : Math.max(0, Math.min(list.length - 1, at + ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns })[event.key]));
      list[next].focus();
    });
  }

  function markCards() {
    const focusId=document.activeElement?.closest('.theme-card')?.dataset.themeId;
    for (const [id, card] of cards) {
      const on = id === committed();
      card.setAttribute('aria-checked', String(on));
      card.tabIndex = (focusId ? focusId===id : on) ? 0 : -1;
    }
  }

  const luminance = hex => { const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
  function applyAccent() {
    const hex = /^#[0-9a-f]{6}$/i.test(settings.accentCustom || '') ? settings.accentCustom : '';
    const style = document.body.style;
    if (hex) { const dark='#17120a',light='#fffaf0',l=luminance(hex);style.setProperty('--accent', hex);style.setProperty('--accent-ink',(l+.05)/(luminance(dark)+.05)>=(luminance(light)+.05)/(l+.05)?dark:light); }
    else { style.removeProperty('--accent'); style.removeProperty('--accent-ink'); }
    for (const swatch of document.querySelectorAll('#accentSwatches button')) swatch.setAttribute('aria-checked', String(swatch.dataset.color === hex));
    const custom = $('#accentCustom');
    if (custom && hex) custom.value = hex;
    $('#accentReset')?.toggleAttribute('hidden', !hex);
  }

  function applyLayout() {
    const style = document.body.style, pick = (table, key) => table[settings[key]] || table.normal;
    style.setProperty('--rail-w', `${pick(WIDTHS.rail, 'railWidth')}px`);
    style.setProperty('--facet-w', `${pick(WIDTHS.facet, 'facetWidth')}px`);
    style.setProperty('--insp-w', `${Number(settings.inspectorPixels)>0?Math.min(600,Math.max(320,Number(settings.inspectorPixels))):pick(WIDTHS.inspector, 'inspectorWidth')}px`);
    if (settings.uiFont === 'system') style.setProperty('--font-ui', '"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif');
    else if(settings.uiFont==='hanken')style.setProperty('--font-ui','"Hanken Grotesk Variable","Segoe UI",system-ui,sans-serif');
    else style.removeProperty('--font-ui');
    if (settings.readFont === 'sans') style.setProperty('--font-read', 'var(--font-ui)');
    else if (settings.readFont === 'georgia') style.setProperty('--font-read', 'Georgia,"Times New Roman",serif');
    else style.removeProperty('--font-read');
  }

  function applyAll() {
    const id = committed();
    const body = document.body;
    const visible=previewTheme||pendingTheme||id;body.dataset.theme=visible;body.classList.toggle('light',!!meta(visible).light);
    if(reduced()){clearTimeout(fadeTimer);body.classList.remove('theme-fade')}
    markCards();
    applyAccent();
    applyLayout();
  }

  function mount() {
    const swatches = $('#accentSwatches');
    if (swatches) {
      for (const color of ACCENTS) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.color = color;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-label', `Accent ${color}`);
        button.style.setProperty('--c', color);
        button.onclick = () => save({ accentCustom: color });
        swatches.append(button);
      }
    }
    $('#accentCustom')?.addEventListener('change', event => save({ accentCustom: event.target.value }));
    $('#accentReset')?.addEventListener('click', () => save({ accentCustom: '' }));
    $('#resetLayoutType')?.addEventListener('click', async () => { await save({ railWidth: 'normal', facetWidth: 'normal', inspectorWidth: 'normal', inspectorPixels:0, uiFont: 'hanken', readFont: 'newsreader', startPage: 'last' }); toast('Layout and type reset'); });
    buildGallery();
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&previewTheme){clearTimeout(previewTimer);clearTimeout(revertTimer);previewTheme='';showTheme(pendingTheme||committed())}});
    const baseApply = apply;
    apply = function () { const result = baseApply(); applyAll(); return result; };
    if (settings && Object.keys(settings).length) applyAll();
    if (ALIASES[settings.theme]) save({ theme: ALIASES[settings.theme] }, false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(mount, 0), { once: true }); else setTimeout(mount, 0);
})();
