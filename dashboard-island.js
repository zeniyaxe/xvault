/* Compact queue status for the dashboard. Reuses the existing queue poll. */
(() => {
  const baseQueueStats = queueStats;
  const basePage = page;
  let latestQueue = null;

  function updateIsland() {
    const island = document.querySelector('#xvQueueIsland');
    if (!island) return;
    island.hidden =
      settings.dashboardActivityIsland === false ||
      Boolean(document.querySelector('#page-library.show,#page-media.show,#page-settings.show'));
    island.dataset.position = settings.dashboardIslandPosition === 'left' ? 'left' : 'right';
    const queued = Number(document.querySelector('#qQueued')?.textContent?.replace(/\D/g, '') || 0);
    const active = Number(document.querySelector('#qActive')?.textContent?.replace(/\D/g, '') || 0);
    const failed = Number(document.querySelector('#qFailed')?.textContent?.replace(/\D/g, '') || 0);
    const converting = Number(latestQueue?.converting || 0);
    const state = converting ? 'converting' : active ? 'active' : failed ? 'attention' : queued ? 'queued' : 'ready';
    island.dataset.state = state;
    island.querySelector('.xv-island-title').textContent = converting
      ? `${converting} converting`
      : active
        ? `${active} downloading`
        : failed
          ? `${failed} need attention`
          : queued
            ? `${queued} queued`
            : 'Vault ready';
    island.querySelector('.xv-island-detail').textContent = converting
      ? `${latestQueue.complete || 0} complete · helper active`
      : active
        ? document.querySelector('#qSpeed')?.textContent || ''
        : failed
          ? 'Review the download queue'
          : queued
            ? 'Waiting for download slots'
            : 'All clear';
    island.querySelector('.xv-island-count').textContent = converting || active || failed || queued || '✓';
  }

  queueStats = async function () {
    const result = await baseQueueStats();
    latestQueue = result;
    updateIsland();
    return result;
  };

  page = function (name) {
    const result = basePage(name);
    updateIsland();
    return result;
  };

  function mount() {
    const island = document.createElement('aside');
    island.id = 'xvQueueIsland';
    island.className = 'xv-queue-island';
    island.setAttribute('aria-label', 'XVault queue status');
    island.innerHTML = `<button type="button" class="xv-island-main" aria-label="Open the download queue"><span class="xv-island-count">✓</span><span><b class="xv-island-title">Vault ready</b><small class="xv-island-detail">All clear</small></span><span class="xv-island-arrow">↗</span></button>`;
    document.body.append(island);
    island.querySelector('button').onclick = () => page('media');

    const grid = document.querySelector('#page-settings .settingsgrid');
    if (grid) {
      const section = document.createElement('section');
      section.className = 'panel settinggroup';
      section.innerHTML = `<small>DASHBOARD WORKSPACE</small><h3>Activity Island</h3><p>Keep queue health one click away without opening the Media page.</p><div class="toggles"><label><span><b>Show Activity Island</b><small>Compact queue status in the corner of the dashboard.</small></span><input type="checkbox" id="xvIslandEnabled"></label></div><label class="field"><span>Dock position</span><select id="xvIslandPosition"><option value="right">Right</option><option value="left">Left</option></select></label>`;
      grid.append(section);
      const enabled = section.querySelector('#xvIslandEnabled'),
        position = section.querySelector('#xvIslandPosition');
      const sync = () => {
        enabled.checked = settings.dashboardActivityIsland !== false;
        position.value = settings.dashboardIslandPosition === 'left' ? 'left' : 'right';
        updateIsland();
      };
      enabled.onchange = () => save({ dashboardActivityIsland: enabled.checked }).then(sync);
      position.onchange = () => save({ dashboardIslandPosition: position.value }).then(sync);
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }).then(response => {
        if (response?.settings) {
          settings = response.settings;
          sync();
        }
      });
    }
    updateIsland();
  }

  // Command Center is already loaded by dashboard.html. Keep one installation
  // and load only the planner's model/UI here.
  const loadScript = source =>
    new Promise(resolve => {
      const script = document.createElement('script');
      script.src = source;
      script.onload = resolve;
      script.onerror = resolve;
      document.head.append(script);
    });
  loadScript('bulk-download-model.js').then(() => loadScript('bulk-download-ui.js'));
  document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
