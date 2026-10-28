/* XVault command center: searchable actions plus safe, local-first shortcuts. */
(() => {
  const style = document.createElement('style');
  style.textContent = '.paletteCommand{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,160px);align-items:baseline;gap:12px;white-space:normal}.paletteCommand b{font-weight:550;overflow-wrap:anywhere;line-height:1.4}.paletteCommand small{color:var(--muted);font-size:11.5px;line-height:1.4;text-align:right}.paletteEmpty{padding:18px;color:var(--muted)}.paletteEmpty b{color:var(--text);font-weight:550}@media(max-width:520px){.paletteCommand{grid-template-columns:minmax(0,1fr)}.paletteCommand small{display:none}}';
  document.head.append(style);
  let activeIndex = 0;
  let visible = [];
  const execute = command => { closePalette(); command?.run(); };
  const nav = target => { page(target); closePalette(); };
  const staticCommands = [
    { name: 'Archive Bookmarks', hint: 'capture saved posts', run: () => { page('archive'); source = 'bookmarks'; selectSource(); start(); } },
    { name: 'Archive Likes', hint: 'capture liked posts', run: () => { page('archive'); source = 'likes'; selectSource(); start(); } },
    { name: 'Archive current page', hint: 'capture the visible timeline', run: () => { page('archive'); source = 'timeline'; selectSource(); start(); } },
    { name: 'Open Library', hint: 'your archived posts and media', run: () => nav('library') },
    { name: 'Review the Inbox', hint: 'step through new posts: R keeps, F favorites, Delete trashes', run: () => { closePalette(); page('library'); $('#search').value = 'inbox:true'; renderLib(); setTimeout(() => $('#libraryReview')?.click(), 400); } },
    { name: 'Open Explore', hint: 'time machine, media map, archive diff', run: () => nav('explorer') },
    { name: 'Open Capture', hint: 'status, new archive, runs', run: () => nav('home') },
    { name: 'Open Tools', hint: 'work with a single post', run: () => nav('studio') },
    { name: 'Keyboard shortcuts', hint: 'press ? anywhere', run: () => { closePalette(); window.XVaultShortcuts?.(); } },
    { name: 'Open Remote Access', hint: 'pair a phone on this Wi-Fi', run: () => { closePalette(); window.XVaultRemoteSettings?.reveal(false); } },
    { name: 'Pair a phone', hint: 'start XVault Remote and create a one-time QR', run: () => { closePalette(); window.XVaultRemoteSettings?.reveal(true); } },
    { name: 'Open Downloads', hint: 'queue, speed and history', run: () => nav('media') },
    { name: 'Open System health', hint: 'diagnostics and repair', run: () => nav('health') },
    { name: 'Open Integrity Center', hint: 'scan records and files', run: () => nav('integrity') },
    { name: 'Open Activity log', hint: 'recent local events', run: () => nav('activity') },
    { name: 'Open Settings', hint: 'customize XVault', run: () => nav('settings') },
    { name: 'Retry failed downloads', hint: 'queue bounded retries', run: () => call({ type: 'RETRY_FAILED' }).then(queueStats).then(() => { toast('Failed media requeued'); closePalette(); }) },
    { name: 'Run health check', hint: 'check queue, helper, and database', run: () => { closePalette(); page('health'); health(); } },
    { name: 'Run integrity scan', hint: 'find missing or mismatched files', run: () => { closePalette(); page('integrity'); runIntegrity(); } },
    { name: 'Apply Balanced preset', hint: 'recommended defaults', run: () => { closePalette(); preset('balanced'); } },
    { name: 'Test crawler', hint: 'safe diagnostic request', run: () => { closePalette(); testCrawler(); } },
    { name: 'Test download', hint: 'safe local download probe', run: () => { closePalette(); testDownload(); } },
  ];
  function dynamicCommands(query) {
    const q = query.trim(), commands = [];
    const profile = q.match(/^archive\s+@?([a-z0-9_]{1,30})$/i);
    if (profile) commands.push({ name: `Archive profile @${profile[1]}`, hint: 'profile posts + replies', run: () => { page('archive'); source = 'profile'; selectSource(); $('#handle').value = profile[1]; start(); closePalette(); } });
    const repair = q.match(/^repair\s+profile\s+@?([a-z0-9_]{1,30})$/i);
    if (repair) commands.push({ name: `Repair profile @${repair[1]}`, hint: 'open profile archive setup', run: () => { page('archive'); source = 'profile'; selectSource(); $('#handle').value = repair[1]; closePalette(); toast('Profile ready for a safe re-archive'); } });
    const find = q.match(/^(?:find|search|filter)\s+(.+)$/i);
    if (find) commands.push({ name: `Search Library for “${find[1]}”`, hint: 'open filtered offline results', run: () => { page('library'); $('#search').value = find[1]; renderLib(); closePalette(); } });
    if (/^show\s+failed(?:\s+gifs?)?$/i.test(q)) commands.push({ name: 'Show failed media', hint: 'open queue history and recovery actions', run: () => { page('media'); closePalette(); toast('Failed items are highlighted in the queue'); } });
    if (/^videos?\s*>\s*\d+(?:\.\d+)?\s*(?:mb|gb)$/i.test(q)) commands.push({ name: `Find ${q}`, hint: 'videos with known local file sizes', run: () => { page('library'); $('#search').value = 'type:video size:' + q.replace(/^videos?\s*/i, '').replace(/\s/g, ''); renderLib(); closePalette(); } });
    if (/^(?:open|go)\s+(library|media|health|integrity|activity|settings|archive)$/i.test(q)) {
      const target = q.match(/(?:open|go)\s+(library|media|health|integrity|activity|settings|archive)$/i)[1].toLowerCase();
      commands.push({ name: `Open ${target[0].toUpperCase() + target.slice(1)}`, hint: 'navigate dashboard', run: () => nav(target) });
    }
    if (q.length > 1 && !find && !profile && !repair) commands.push({ name: `Search the library for “${q}”`, hint: 'Enter', run: () => { page('library'); $('#search').value = q; renderLib(); closePalette(); } });
    if (q.toLowerCase() === 'clear selection') commands.push({ name: 'Clear Library selection', hint: 'remove selected posts from bulk actions', run: () => { document.querySelector('#libraryClearSelection')?.click(); closePalette(); } });
    return commands;
  }
  function render() {
    const query = $('#paletteInput')?.value || '', dynamic = dynamicCommands(query), normalized = query.trim().toLowerCase();
    visible = [...dynamic, ...staticCommands, ...(window.XVaultWorkspaceCommands?.() || [])].map((command,index)=>({command,index,score:index<dynamic.length?1000:window.XVaultCommandMatch.score(command.name,command.hint,normalized)})).filter(row=>row.score!==null).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,40).map(row=>row.command);
    activeIndex = Math.min(activeIndex, Math.max(0, visible.length - 1));
    $('#paletteList').innerHTML = visible.length ? visible.map((command, index) => `<button type="button" class="paletteCommand ${index === activeIndex ? 'active' : ''}" data-command-index="${index}"><b>${esc(command.name)}</b><small>${esc(command.hint || '')}${command.shortcut?' � '+esc(command.shortcut):''}</small></button>`).join('') : '<div class="paletteEmpty">No matching command. Try <b>archive @name</b>, <b>find tag:art</b>, or <b>show failed gifs</b>.</div>';
    $$('#paletteList [data-command-index]').forEach(button => { button.onclick = () => execute(visible[Number(button.dataset.commandIndex)]); button.onmouseenter = () => { activeIndex = Number(button.dataset.commandIndex); $$('#paletteList [data-command-index]').forEach(item=>item.classList.toggle('active',Number(item.dataset.commandIndex)===activeIndex)); }; });
  }
  const originalOpen = window.openPalette;
  window.openPalette = function () { originalOpen(); activeIndex = 0; render(); };
  window.renderPalette = render;
  $('#paletteInput')?.addEventListener('input', render);
  document.addEventListener('keydown', event => {
    if ($('#palette')?.classList.contains('hidden')) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); activeIndex = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % Math.max(1, visible.length); render(); return; }
    if (event.key === 'Enter' && visible[activeIndex]) { event.preventDefault(); execute(visible[activeIndex]); }
  }, true);
})();
