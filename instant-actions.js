(() => {
  if (window.__XVAULT_INSTANT_V2__) return;
  window.__XVAULT_INSTANT_V2__ = true;

  const LINKS = window.XVaultLinks;
  const PROVIDERS = LINKS?.providers || {};
  const ICON = {
    copy:`<svg viewBox="0 0 24 24"><path d="M8 8h11v11H8z"/><path d="M16 8V5H5v11h3"/></svg>`,
    check:`<svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7"/></svg>`,
    archive:`<svg viewBox="0 0 24 24"><path d="M4 6h16v4H4z"/><path d="M6 10v9h12v-9M10 14h4"/></svg>`,
    more:`<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>`,
    side:`<svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zM15 4v16"/></svg>`
  };
  let settings = {};
  let lastHovered = null;
  let menu = null;
  let scanQueued = false;
  const processed = new WeakSet();
  let dead = false;
  function invalidate(){if(dead)return;dead=true;document.querySelectorAll("#xv2-dock,.xv2-actions,.xv2-menu,#xv2-toast").forEach(x=>x.remove())}
  async function send(msg){if(dead)return null;try{const p=chrome.runtime.sendMessage(msg);return await p}catch(e){if(/context invalidated/i.test(String(e?.message||e)))invalidate();return null}}

  send({type:"GET_SETTINGS"}).then(r => {
    settings = r?.settings || {}; applyMotion();
    scan();
    if (settings.showSideDock === true) mountDock();
  });

  new MutationObserver(() => {
    if (dead || scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => { scanQueued=false; scan(); });
  }).observe(document.documentElement,{subtree:true,childList:true});

  document.addEventListener("mouseover", e => {
    const a = e.target.closest?.('article[data-testid="tweet"]'); if (a) lastHovered=a;
  }, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); else if(menu) menuKeys(e); }, true);
  document.addEventListener("pointerdown", e => { if(menu && !menu.contains(e.target) && !e.target.closest?.(".xv2-more")) closeMenu(); }, true);

  function xEnabled(){return settings.xIntegrationEnabled!==false}
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{if(!dead)applyMotion()});
  function applyMotion(){const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches||settings.safeMode||settings.reducedMotion||settings.animations===false||settings.motionLevel==='off'||settings.motionLevel==='reduced';const level=reduced?'reduced':(settings.motionLevel||'normal'),speed=Math.max(.35,Math.min(2,Number(settings.motionSpeed)||1));const ms=level==='subtle'?140:level==='rich'?240:level==='extreme'?290:level==='reduced'?1:190;document.documentElement.style.setProperty('--xv-motion',`${Math.round(ms*speed)}ms`);document.documentElement.dataset.xvMotion=level}
  function clearInjected(){document.querySelectorAll('.xv2-actions,#xv2-dock,.xv2-menu,#xv2-toast').forEach(x=>x.remove());for(const article of document.querySelectorAll('article[data-testid="tweet"]'))processed.delete(article);closeMenu()}
  function scan() {
    if(!xEnabled())return;
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (processed.has(article)) continue;
      processed.add(article);
      installActions(article);
    }
  }

  function installActions(article) {
    const bar = article.querySelector('[role="group"]'); if (!bar) { processed.delete(article); return; }
    const meta = readTweet(article); if (!meta) { processed.delete(article); return; }
    const host = document.createElement("div"); host.className="xv2-actions";host.dataset.visibility=settings.copyButtonVisibility||'always';

    if (settings.xCopyLinkEnabled !== false && settings.instantCopyButton !== false) {
      const copy = actionButton("xv2-copy","Copy link",ICON.copy);
      const performCopy=async e=>{
        e.preventDefault(); e.stopPropagation();
        const mod=modifierAction(e),provider=mod?.provider||(settings.linkProvider||"fixvx");
        if(mod?.mode==='open'){window.open(linkFor(meta.url,provider),"_blank","noopener");flash(copy,"check");return}
        await writeClipboard(copyText(meta,provider)); flash(copy,"check");
        if(settings.copyToast!==false)toast(`Copied ${providerLabel(provider)} link`);
      };
      copy.addEventListener("click", performCopy);
      copy.addEventListener("auxclick",e=>{if(e.button===1)performCopy(e)});
      copy.addEventListener("contextmenu", e => { e.preventDefault();e.stopPropagation();openMenu(copy,meta); });
      host.append(copy);
    }
    if (settings.xArchiveButtonEnabled === true) {
      const a=actionButton("xv2-archive","Archive locally",ICON.archive);
      a.onclick=async e=>{e.preventDefault();e.stopPropagation();await archive(meta);flash(a,"check");toast("Post archived locally");};
      host.append(a);
    }
    if (settings.xPowerMenuEnabled === true) {
      const m=actionButton("xv2-more","XVault actions",ICON.more);m.classList.add("xv2-more");
      m.onclick=e=>{e.preventDefault();e.stopPropagation();openMenu(m,meta);};host.append(m);
    }
    const share=bar.querySelector('[data-testid="share"]')?.closest('div[role="button"],button')||bar.querySelector('[aria-label*="Share"]')?.parentElement;
    if(settings.copyButtonPosition==='before-share'&&share?.parentElement===bar)bar.insertBefore(host,share);else bar.append(host);
  }

  function actionButton(cls,title,svg){const b=document.createElement("button");b.type="button";b.className=`xv2-action ${cls}`;b.title=title;b.setAttribute("aria-label",title);b.innerHTML=svg;return b;}
  function flash(btn,which){const old=btn.innerHTML;btn.innerHTML=ICON[which]||old;btn.classList.add("ok");setTimeout(()=>{btn.innerHTML=old;btn.classList.remove("ok")},Math.max(300,Number(settings.copySuccessDuration)||900))}

  function readTweet(article) {
    const links=[...article.querySelectorAll('a[href*="/status/"]')];
    const href=(links.find(a=>a.querySelector("time"))||links[0])?.getAttribute("href")||"";
    const m=href.match(/^\/?([^/]+)\/status\/(\d+)/); if(!m)return null;
    const text=article.querySelector('[data-testid="tweetText"]')?.innerText||"";
    const imgs=[...article.querySelectorAll('img[src*="pbs.twimg.com/media"]')].map(i=>orig(i.src));
    return {id:m[2],handle:m[1],url:`https://x.com/${m[1]}/status/${m[2]}`,text,media:[...new Set(imgs)],article};
  }
  function orig(url){try{const u=new URL(url);u.searchParams.set("name","orig");return u.href}catch{return url}}
  function findByUrl(url){
    const p=statusPath(url); if(!p)return null;
    for(const a of document.querySelectorAll('article[data-testid="tweet"]')){const m=readTweet(a);if(m&&statusPath(m.url)===p)return m}return null;
  }
  function centered(){
    if(lastHovered?.isConnected){const m=readTweet(lastHovered);if(m)return m}
    let best=null,score=1e9;for(const a of document.querySelectorAll('article[data-testid="tweet"]')){const r=a.getBoundingClientRect();if(r.bottom<0||r.top>innerHeight)continue;const s=Math.abs((r.top+r.bottom)/2-innerHeight/2);if(s<score){score=s;best=a}}return best?readTweet(best):null;
  }
  function statusPath(url){try{const u=new URL(url,location.href);const m=u.pathname.match(/^\/([^/]+)\/status\/(\d+)/);return m?`/${m[1]}/status/${m[2]}`:null}catch{return null}}
  function linkFor(url,provider=settings.linkProvider||"fixvx"){return LINKS?.transform(url,settings,provider)||url}
  function providerLabel(p){return LINKS?.label(p)||p}
  function modifierAction(e){if(settings.xModifierActions===false)return null;const action=e.shiftKey?settings.copyShiftAction:e.altKey?settings.copyAltAction:e.button===1?settings.copyMiddleAction:null;if(!action)return null;if(action==='copy-original')return{mode:'copy',provider:'x'};if(action==='copy-transformed')return{mode:'copy',provider:settings.linkProvider||'fixvx'};if(action==='open-transformed')return{mode:'open',provider:settings.linkProvider||'fixvx'};if(action==='open-original')return{mode:'open',provider:'x'};return null}
  function copyText(meta,provider){
    let url=linkFor(meta.url,provider);
    if(settings.suppressDiscordEmbed) url=`<${url}>`;
    const fmt=settings.copyFormat||"url";
    const text=(meta.text||"").replace(/\s+/g," ").trim().slice(0,Math.max(20,settings.copiedTextLimit||160));
    if(fmt==="markdown") return `[${text||`@${meta.handle} post`}](${url.replace(/^<|>$/g,"")})`;
    if(fmt==="author-text") return `@${meta.handle}${text?` — ${text}`:""}\n${url}`;
    if(fmt==="id") return meta.id;
    return settings.includeTweetTextOnCopy&&text?`${text}\n${url}`:url;
  }
  async function writeClipboard(text){try{await navigator.clipboard.writeText(text);return true}catch{const ta=document.createElement("textarea");ta.value=text;ta.style.cssText="position:fixed;opacity:0";document.body.append(ta);ta.select();document.execCommand("copy");ta.remove();return true}}
  async function archive(meta){return send({type:"STORE_RECORDS",tweets:[{id:meta.id,text:meta.text,createdAt:meta.article?.querySelector("time")?.dateTime||null,url:meta.url,author:{id:null,handle:meta.handle,name:null,avatar:null},media:(meta.media||[]).map(url=>({type:"photo",url})),metrics:{},sourceFlags:["instant-action"],archivedAt:Date.now()}],users:[]})}
  async function download(meta){
    await archive(meta).catch(()=>{});
    const existing=meta.article?.querySelector(".xvault-download");if(existing){existing.click();return}
    if(meta.media?.length){const r=await send({type:"QUEUE_DOWNLOADS",items:meta.media.map((url,i)=>({url,tweetId:meta.id,author:meta.handle,index:i+1,mediaType:"image"}))});toast(r?.blocked?r.error:r?.added?`Queued ${r.added} media file${r.added===1?"":"s"}`:(r?.skipped?"Already downloaded / queued":"Could not queue media"))} else toast("Open the post first if it contains video/GIF media");
  }

  let menuAnchor=null;
  function openMenu(anchor,meta){closeMenu();menuAnchor=anchor;anchor.setAttribute("aria-expanded","true");menu=document.createElement("div");menu.className="xv2-menu";menu.setAttribute('role','menu');menu.setAttribute('aria-label',`XVault actions for @${meta.handle}`);const custom=LINKS?.customHost(settings.customLinkHost);menu.innerHTML=`
    <div class="xv2-menu-head"><b>XVault</b><span>@${escapeHTML(meta.handle)}</span></div>
    <div class="xv2-provider-grid">${['fixvx','fixupx','fxtwitter','vxtwitter','x'].map(p=>`<button role="menuitem" data-provider="${p}">${PROVIDERS[p].label}</button>`).join("")}${custom?`<button role="menuitem" data-provider="custom">Custom</button>`:""}</div>
    <div class="xv2-menu-sep"></div>
    <button role="menuitem" data-act="archive"><span>◇</span>Archive post</button>
    ${meta.media?.length?'<button role="menuitem" data-act="download"><span>↓</span>Download originals</button>':''}
    <button role="menuitem" data-act="copy-original"><span>↗</span>Copy original X link</button>
    <button role="menuitem" data-act="open"><span>↗</span>Open transformed link</button>
    <button role="menuitem" data-act="dashboard"><span>▦</span>Open in XVault</button>`;
    document.documentElement.append(menu);const r=anchor.getBoundingClientRect();let left=Math.min(innerWidth-menu.offsetWidth-12,Math.max(12,r.left-60));let top=r.top-menu.offsetHeight-10;if(top<8)top=r.bottom+8;menu.style.left=`${left}px`;menu.style.top=`${Math.max(12,Math.min(top,innerHeight-menu.offsetHeight-12))}px`;
    menu.addEventListener("click",async e=>{const b=e.target.closest("button");if(!b)return;e.preventDefault();e.stopPropagation();await runMenuAction(b,meta);});requestAnimationFrame(()=>menu?.querySelector('button')?.focus());
  }
  async function runMenuAction(b,meta){const p=b.dataset.provider;if(p){await writeClipboard(copyText(meta,p));toast(`Copied ${providerLabel(p)} link`);closeMenu();return}const act=b.dataset.act;if(act==='download')await download(meta);if(act==='archive'){await archive(meta);toast('Post archived locally')}if(act==='copy-original'){await writeClipboard(linkFor(meta.url,'x'));toast('Copied original X link')}if(act==='open')window.open(linkFor(meta.url),"_blank","noopener");if(act==='dashboard')send({type:"OPEN_DASHBOARD"});closeMenu()}
  function menuKeys(e){const items=[...menu.querySelectorAll('button:not([disabled])')],at=items.indexOf(document.activeElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();items[(at+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus()}else if(e.key==='Home'){e.preventDefault();items[0]?.focus()}else if(e.key==='End'){e.preventDefault();items.at(-1)?.focus()}else if(e.key==='Enter'||e.key===' '){const b=document.activeElement?.closest?.('.xv2-menu button');if(b){e.preventDefault();b.click()}}}
  function closeMenu(){const focused=menu?.contains(document.activeElement);menu?.remove();menu=null;menuAnchor?.setAttribute("aria-expanded","false");if(focused&&menuAnchor?.isConnected)menuAnchor.focus();menuAnchor=null}
  function escapeHTML(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}

  function mountDock(){
    if(settings.showSideDock!==true||!xEnabled())return;
    if(document.getElementById("xv2-dock"))return;const d=document.createElement("div");d.id="xv2-dock";d.className=settings.sideDockCollapsed!==false?"collapsed":"";d.innerHTML=`<button class="xv2-dock-toggle" title="XVault">XV</button><div class="xv2-dock-body"><b>XVault</b><small>local archive tools</small><button data-q="copy">Copy centered</button><button data-q="archive">Archive centered</button><button data-q="timeline">Archive timeline</button><button data-q="panel">Quick panel</button><button data-q="dash">Dashboard</button></div>`;document.documentElement.append(d);const toggle=d.querySelector(".xv2-dock-toggle"),body=d.querySelector(".xv2-dock-body");body.id="xv2-dock-tools";body.inert=d.classList.contains("collapsed");toggle.setAttribute("aria-label","Toggle XVault archive tools");toggle.setAttribute("aria-controls",body.id);toggle.setAttribute("aria-expanded",String(!body.inert));d.querySelector(".xv2-dock-toggle").onclick=()=>{d.classList.toggle("collapsed");body.inert=d.classList.contains("collapsed");toggle.setAttribute("aria-expanded",String(!body.inert));send({type:"SET_SETTINGS",settings:{sideDockCollapsed:d.classList.contains("collapsed")}})};d.querySelector(".xv2-dock-body").onclick=async e=>{const b=e.target.closest("button");if(!b)return;const q=b.dataset.q;if(q==="copy")return doCopy(centered());if(q==="archive"){const m=centered();if(m){await archive(m);toast("Post archived locally")}}if(q==="timeline")send({type:"SEND_TO_TAB",payload:{type:"XV_SCROLL_START"}});if(q==="panel")send({type:"OPEN_SIDE_PANEL"});if(q==="dash")send({type:"OPEN_DASHBOARD"});};
  }
  async function doCopy(meta,provider){if(!meta)return toast("No visible post found");const chosen=provider||settings.linkProvider||'fixvx';await writeClipboard(copyText(meta,chosen));toast(`Copied ${providerLabel(chosen)} link`)}

  if(!dead) try{chrome.runtime.onMessage.addListener((msg,_s,sendResponse)=>{(async()=>{
    if(msg.type==="XV_INSTANT_COPY"){const m=(msg.url&&findByUrl(msg.url))||centered();if(!m)return {ok:false,error:"No post found"};await doCopy(m,msg.provider);return {ok:true}}
    if(msg.type==="XV_INSTANT_ARCHIVE"||msg.type==="XV_ARCHIVE_CENTERED"){const m=(msg.url&&findByUrl(msg.url))||centered();if(!m)return {ok:false,error:"No post found"};await archive(m);toast("Post archived locally");return {ok:true}}
    if(msg.type==="XV_INSTANT_DOWNLOAD"||msg.type==="XV_DOWNLOAD_CENTERED"){const m=(msg.url&&findByUrl(msg.url))||centered();if(!m)return {ok:false,error:"No post found"};await download(m);return {ok:true}}
    if(msg.type==="XV_COPY_CENTERED"){const m=centered();if(!m)return {ok:false,error:"No post found"};await doCopy(m);return {ok:true}}
    if(msg.type==="XV_REFRESH_INSTANT_SETTINGS"){const r=await send({type:"GET_SETTINGS"});if(r?.settings){settings=r.settings;applyMotion();if(!xEnabled())clearInjected();else{scan();mountDock()}}return {ok:true}}
    return null;
  })().then(sendResponse).catch(e=>sendResponse({ok:false,error:String(e)}));return true;});}catch(e){if(/context invalidated/i.test(String(e?.message||e)))invalidate()}

  function toast(text){let t=document.getElementById("xv2-toast");if(!t){t=document.createElement("div");t.id="xv2-toast";t.setAttribute("role","status");t.setAttribute("aria-live","polite");document.documentElement.append(t)}t.textContent=text;t.classList.remove("show");void t.offsetWidth;t.classList.add("show");clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove("show"),2200)}

  try{chrome.runtime.onMessage.addListener(message=>{if(dead)return;if(message.type==="XV_SETTINGS_CHANGED"){settings=message.settings;applyMotion();if(!xEnabled())clearInjected();else{scan();mountDock()}}})}catch(e){if(/context invalidated/i.test(String(e?.message||e)))invalidate()}
})();
