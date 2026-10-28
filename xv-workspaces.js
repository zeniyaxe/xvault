/* Named layouts, one toolbar action registry, and a keyboard/pointer resizable Inspector. */
(() => {
  const $ = selector => document.querySelector(selector);
  let busy=false,toolbarKey='';
  const icons={downloads:'M4 17v4h16v-4M12 3v12m-5-5 5 5 5-5',inbox:'M4 4h16v16H4zM4 14h5l1 3h4l1-3h5',workspaces:'M3 4h18v16H3zM8 4v16m8-16v16M8 10h8'};
  function openSettings(){page('settings');$('#settingsSearch').value='';$('#settingsSearch').dispatchEvent(new Event('input'));$('[data-section-link="appearance"]')?.click();requestAnimationFrame(()=>{const group=$('#g-workspaces'),content=$('#settingsContent');if(group&&content)content.scrollTo({top:group.getBoundingClientRect().top-content.getBoundingClientRect().top+content.scrollTop,behavior:['off','reduced'].includes(document.body.dataset.motion)?'auto':'smooth'})})}
  const actions=new Map([
    ['refresh',{name:'Refresh',run:()=>refresh()}],['openX',{name:'Open X',run:()=>chrome.tabs.create({url:'https://x.com/home'})}],['export',{name:'Export recovery archive',run:()=>$('#export')?.click()}],
    ['downloads',{name:'Downloads',run:()=>page('media')}],['inbox',{name:'Inbox',run:()=>{page('library');$('#search').value='inbox:true';renderLib()}}],['workspaces',{name:'Workspaces',shortcut:'Ctrl+Alt+W',run:openSwitcher}]
  ]);
  window.XVaultActionRegistry=actions;
  window.XVaultWorkspaceCommands=()=>[
    {name:'Switch workspace',shortcut:'Ctrl+Alt+W',hint:'quick switch saved appearance and layout',run:openSwitcher},
    {name:'Customize toolbar and workspaces',hint:'appearance, layout, saved desks',run:openSettings},
    ...XVaultWorkspaces.normalizeList(settings.workspaces).map(row=>({name:`Workspace: ${row.name}`,hint:'restore appearance and pane layout',run:()=>change({op:'apply',id:row.id})}))
  ];
  async function change(request){
    if(busy)return false;const invoker=document.activeElement,returnId=invoker?.closest('[data-workspace]')?.dataset.workspace,returnAction=invoker?.dataset.workspaceAction;busy=true;renderProfiles();
    try{
      const result=await call({type:'UPDATE_WORKSPACE',change:request});
      if(!result?.ok)throw Error(result?.error||'Workspace was not saved');
      settings=result.settings;apply();sync();
      if(request.op==='apply'){if($('#page-library').classList.contains('show'))renderLib();}
      $('#workspaceState').textContent=request.op==='remove'?'Workspace removed':request.op==='apply'?'Workspace restored':request.op==='update'?'Saved layout updated':request.op==='startup'?(request.id?'Startup workspace selected':'Startup workspace cleared'):'Workspace saved';
      toast($('#workspaceState').textContent);
      if(request.op==='save')$('#workspaceName').value='';if(request.op==='apply')window.XVaultMotion?.play(document.querySelector('.page.show'),[{opacity:.65,transform:'translateX(10px)'},{opacity:1,transform:'none'}],170);return true;
    }catch(error){$('#workspaceState').textContent=error.message;return false;}
    finally{busy=false;renderProfiles();if(returnId&&returnAction){const target=$(`[data-workspace="${CSS.escape(returnId)}"] [data-workspace-action="${returnAction}"]`)||$('#workspaceName');target?.focus({preventScroll:true})}}
  }
  function renderProfiles(){
    const list=$('#workspaceList');if(!list)return;
    const focused=document.activeElement?.closest('[data-workspace]'),focusId=focused?.dataset.workspace,focusAction=document.activeElement?.dataset.workspaceAction;
    list.replaceChildren();
    const rows=XVaultWorkspaces.normalizeList(settings.workspaces);
    if(!rows.length){const empty=document.createElement('p');empty.className='settingHint';empty.textContent='Save a reading desk, media grid, or review layout to return to it in one action.';list.append(empty)}
    for(const row of rows){
      const item=document.createElement('div');item.className='workspace-row';item.dataset.workspace=row.id;
      const text=document.createElement('div'),name=document.createElement('b'),detail=document.createElement('small');name.textContent=row.name+(row.id===settings.activeWorkspaceId?' - Current':'');detail.textContent=[row.values.libraryView||'Library',row.values.theme||'current theme',row.values.inspectorPixels?`${row.values.inspectorPixels}px inspector`:row.values.inspectorWidth||'standard inspector'].join(' · ');text.append(name,detail);item.append(text);
      const menu=document.createElement('details'),summary=document.createElement('summary');menu.className='workspace-actions';summary.textContent='Actions';menu.append(summary);
      for(const [op,label]of [['apply','Restore'],['update','Update'],['rename','Rename'],['duplicate','Duplicate'],['startup','Use on startup'],['move','Move up'],['remove','Remove']]){
        const button=document.createElement('button');button.type='button';button.dataset.workspaceAction=op;button.disabled=busy;button.textContent=label;button.setAttribute('aria-label',`${label} workspace ${row.name}`);
        if(op==='apply')button.className='quiet';if(op==='remove')button.className='quiet danger';
        button.onclick=()=>{if(op==='startup'){change({op,id:settings.startupWorkspaceId===row.id?'':row.id});return}if(op==='rename'){const name=prompt('Workspace name',row.name);if(name!==null)change({op,id:row.id,name,expectedName:row.name});return}if(op==='duplicate'){change({op,id:row.id,newId:crypto.randomUUID()});return}if(op==='move'){change({op,id:row.id,delta:-1});return}if(op!=='remove'||confirm(`Remove saved workspace “${row.name}”? Your current layout remains applied.`))change({op,id:row.id})};(op==='apply'?item:menu).append(button);
      }item.append(menu);list.append(item);
    }
    $('#workspaceSave').disabled=busy;
    if(focusId&&focusAction)list.querySelector(`[data-workspace="${CSS.escape(focusId)}"] [data-workspace-action="${focusAction}"]`)?.focus({preventScroll:true});
  }
  function renderToolbarSettings(){
    const list=$('#toolbarChoices');if(!list)return;
    const selected=XVaultWorkspaces.toolbar(settings.toolbarActions),order=[...selected,...[...actions.keys()].filter(id=>!selected.includes(id))];
    const active=document.activeElement?.closest('[data-toolbar]'),activeId=active?.dataset.toolbar,activePart=document.activeElement?.dataset.toolbarPart;
    list.replaceChildren();
    for(const id of order){const row=document.createElement('div');row.className='toolbar-choice';row.dataset.toolbar=id;
      const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.checked=selected.includes(id);input.dataset.toolbarPart='enabled';input.onchange=()=>save({toolbarActions:input.checked?[...selected,id]:selected.filter(value=>value!==id)},false);label.append(input,document.createTextNode(actions.get(id).name));row.append(label);
      for(const [delta,title]of [[-1,'Move earlier'],[1,'Move later']]){const button=document.createElement('button');button.type='button';button.className='quiet';button.textContent=delta<0?'↑':'↓';button.dataset.toolbarPart=String(delta);const index=selected.indexOf(id);button.disabled=index<0||index+delta<0||index+delta>=selected.length;button.setAttribute('aria-label',`${title}: ${actions.get(id).name}`);button.onclick=()=>{const next=[...selected];[next[index],next[index+delta]]=[next[index+delta],next[index]];save({toolbarActions:next},false)};row.append(button)}list.append(row);
    }
    if(activeId&&activePart)list.querySelector(`[data-toolbar="${activeId}"] [data-toolbar-part="${activePart}"]`)?.focus({preventScroll:true});
  }
  function applyToolbar(){
    const host=$('.topactions');if(!host)return;
    const selected=XVaultWorkspaces.toolbar(settings.toolbarActions);
    for(const id of actions.keys()){
      let button=$(`#${id}`);
      if(!button){button=document.createElement('button');button.id=id;button.type='button';button.title=actions.get(id).name;button.setAttribute('aria-label',actions.get(id).name);button.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[id]}"></path></svg><span class="tl"></span>`;button.querySelector('.tl').textContent=actions.get(id).name;button.onclick=actions.get(id).run;host.append(button)}
      button.classList.toggle('xv-toolbar-hidden',!selected.includes(id));
    }
    const key=selected.join('|');if(key!==toolbarKey){toolbarKey=key;for(const id of selected)host.append($(`#${id}`));}
  }
  let switcherReturn=null;
  function renderSwitcher(){const list=$('#workspaceSwitcherList'),query=$('#workspaceSwitcherSearch').value.trim().toLowerCase();list.replaceChildren();const rows=XVaultWorkspaces.normalizeList(settings.workspaces).filter(row=>row.name.toLowerCase().includes(query));for(const row of rows){const button=document.createElement('button'),name=document.createElement('b'),detail=document.createElement('small');button.type='button';button.dataset.workspaceId=row.id;button.setAttribute('aria-current',String(row.id===settings.activeWorkspaceId));name.textContent=row.name;detail.textContent=[row.values.theme||'Current theme',row.values.libraryView||'Library',row.id===settings.startupWorkspaceId?'Startup workspace':'',row.id===settings.activeWorkspaceId?'Current':''].filter(Boolean).join(' / ');button.append(name,detail);button.onclick=async()=>{if(await change({op:'apply',id:row.id}))$('#workspaceSwitcher').close()};list.append(button)}if(!rows.length){const text=document.createElement('p');text.className='settingHint';text.textContent=query?'No workspace matches this name.':'Save a workspace in Appearance to switch between layouts.';list.append(text)}}
  function openSwitcher(){const dialog=$('#workspaceSwitcher');if(!dialog)return;dialog.style.setProperty('--workspace-zoom',String(Number(settings.dashboardScale)||1));if(dialog.open){$('#workspaceSwitcherSearch').focus();return}switcherReturn=document.activeElement;$('#workspaceSwitcherSearch').value='';renderSwitcher();if(!dialog.open)dialog.showModal();$('#workspaceSwitcherSearch').focus();window.XVaultMotion?.play(dialog,[{opacity:.6,transform:'translateY(-10px) scale(.985)'},{opacity:1,transform:'none'}],180)}
  window.XVaultOpenWorkspaceSwitcher=openSwitcher;
  function mountSwitcher(){const dialog=document.createElement('dialog');dialog.id='workspaceSwitcher';dialog.className='xv-workspace-switcher';dialog.setAttribute('aria-labelledby','workspaceSwitcherTitle');dialog.innerHTML='<header><h2 id="workspaceSwitcherTitle">Switch workspace</h2><button type="button" id="workspaceSwitcherClose" aria-label="Close workspace switcher">Close</button></header><label class="field"><span>Find a saved workspace</span><input id="workspaceSwitcherSearch" type="search" placeholder="Reading desk" autocomplete="off"></label><div id="workspaceSwitcherList"></div><footer><span>Appearance changes preserve your Library search and open media.</span><button id="workspaceSwitcherManage" type="button">Manage workspaces</button></footer>';document.body.append(dialog);$('#workspaceSwitcherSearch').oninput=renderSwitcher;$('#workspaceSwitcherClose').onclick=()=>dialog.close();$('#workspaceSwitcherManage').onclick=()=>{dialog.close();openSettings()};dialog.addEventListener('close',()=>{const target=switcherReturn;switcherReturn=null;requestAnimationFrame(()=>{if(target?.isConnected)target.focus({preventScroll:true})})});dialog.addEventListener('keydown',event=>{const buttons=[...dialog.querySelectorAll('[data-workspace-id]')],index=buttons.indexOf(document.activeElement);if(event.target.id==='workspaceSwitcherSearch'&&['Home','End'].includes(event.key))return;if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:index<0?(event.key==='ArrowDown'?0:buttons.length-1):(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus()}else if(event.key==='Enter'&&event.target.id==='workspaceSwitcherSearch'){event.preventDefault();buttons[0]?.click()}});document.addEventListener('keydown',event=>{if(event.ctrlKey&&event.altKey&&!event.metaKey&&event.key.toLowerCase()==='w'&&!event.defaultPrevented){event.preventDefault();openSwitcher()}})}
  function mountResize(){
    const drawer=$('#detailsDrawer');if(!drawer)return;
    const handle=document.createElement('div');handle.className='xv-inspector-resize';handle.tabIndex=0;handle.setAttribute('role','separator');handle.setAttribute('aria-orientation','vertical');handle.setAttribute('aria-label','Inspector width. Arrow keys resize; double-click resets.');handle.setAttribute('aria-valuemin','320');handle.setAttribute('aria-valuemax','600');drawer.prepend(handle);
    const setWidth=width=>{document.body.style.setProperty('--insp-w',`${width}px`);handle.setAttribute('aria-valuenow',String(width))};
    new ResizeObserver(()=>{const width=Math.round(drawer.getBoundingClientRect().width);if(width){handle.setAttribute('aria-valuenow',String(width));handle.setAttribute('aria-valuetext',`${width} pixels`)}}).observe(drawer);
    let gesture=null,frame=0,nextWidth=380;
    const stop=(commit=true)=>{if(!gesture)return;cancelAnimationFrame(frame);const original=gesture.width;gesture=null;document.body.classList.remove('xv-resizing');if(commit){setWidth(nextWidth);void save({inspectorPixels:nextWidth},false)}else setWidth(original)};
    handle.addEventListener('pointerdown',event=>{if(event.button!==0||drawer.dataset.overlay!=='docked')return;event.preventDefault();gesture={x:event.clientX,width:Math.round(drawer.getBoundingClientRect().width)};nextWidth=gesture.width;handle.setPointerCapture(event.pointerId);document.body.classList.add('xv-resizing');handle.focus()});
    handle.addEventListener('pointermove',event=>{if(!gesture)return;nextWidth=Math.max(320,Math.min(600,gesture.width+gesture.x-event.clientX));if(!frame)frame=requestAnimationFrame(()=>{frame=0;setWidth(nextWidth)})});
    handle.addEventListener('pointerup',()=>stop());handle.addEventListener('pointercancel',()=>stop(false));handle.addEventListener('lostpointercapture',()=>stop(false));
    handle.addEventListener('dblclick',()=>save({inspectorPixels:0},false));
    handle.addEventListener('keydown',event=>{if(event.key==='Escape'){stop(false);return}if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const width=event.key==='Home'?320:event.key==='End'?600:Math.max(320,Math.min(600,Math.round(drawer.getBoundingClientRect().width)+(event.key==='ArrowLeft'?1:-1)*(event.shiftKey?40:10)));setWidth(width);void save({inspectorPixels:width},false)});
  }
  function mount(){
    const group=document.createElement('section');group.id='g-workspaces';group.className='settinggroup';group.innerHTML='<h3>Workspaces</h3><p class="settingHint">Remember appearance, pane widths, fonts and Library layout. Searches, motion/accessibility preferences and download settings stay independent.</p><form id="workspaceForm" class="workspace-save"><label class="field"><span>Save current workspace as</span><input id="workspaceName" maxlength="48" placeholder="Reading desk" required></label><button type="submit" id="workspaceSave">Save workspace</button></form><div class="workspace-portable"><button type="button" id="workspaceExport" class="quiet">Export layouts</button><label class="quiet">Import layouts<input type="file" id="workspaceImport" accept="application/json,.json"></label></div><div id="workspaceList"></div><p id="workspaceState" class="settingHint" role="status" aria-live="polite"></p><details class="workspace-toolbar"><summary>Arrange the top toolbar</summary><p class="settingHint">Command Center stays available. Check actions to show them, then use the arrows to arrange them.</p><div id="toolbarChoices"></div><button type="button" id="toolbarReset" class="quiet">Restore default toolbar</button></details>';
    $('#g-layout-type')?.after(group);
    $('#workspaceExport').onclick=()=>{const url=URL.createObjectURL(new Blob([XVaultWorkspaces.exportFile(settings.workspaces)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='xvault-workspaces.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
    $('#workspaceImport').onchange=async event=>{const file=event.target.files[0];event.target.value='';if(!file)return;try{if(file.size>262144)throw Error('Workspace file exceeds 256 KB');const text=await file.text(),preview=XVaultWorkspaces.previewImport(settings.workspaces,text);if(preview.invalid)throw Error(`${preview.invalid} unsafe or malformed layouts. Import cancelled.`);if(!confirm(`Import ${preview.added} new layouts and preserve ${preview.conflicts} conflicting layouts as separate copies? ${preview.identical} identical layouts will be skipped. Archive data and global accessibility preferences are excluded.`))return;await change({op:'import',fileText:text,expected:preview.expected,conflicts:'keep-both'})}catch(error){$('#workspaceState').textContent=error.message}};
    $('#workspaceForm').onsubmit=event=>{event.preventDefault();change({op:'save',id:crypto.randomUUID(),name:$('#workspaceName').value})};$('#toolbarReset').onclick=()=>save({toolbarActions:['refresh','openX','export']},false);
    const baseApply=apply;apply=function(){const result=baseApply();applyToolbar();renderProfiles();renderToolbarSettings();return result};
    applyToolbar();renderProfiles();renderToolbarSettings();mountResize();mountSwitcher();
    const width=$('[data-setting="inspectorWidth"]');if(width)width.onchange=()=>save({inspectorWidth:width.value,inspectorPixels:0},false);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(mount,0),{once:true});else setTimeout(mount,0);
})();
