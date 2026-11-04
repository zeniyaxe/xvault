(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const panel = $('#remoteCompanion');
  if (!panel) return;

  let settings = {};
  let listening = false;
  let polling = false;
  let inviteExpiresAt = 0;
  let refreshTimer = 0;
  let connecting = false;
  const permissions = [
    ['library.read', 'Browse Library'],
    ['media.read', 'View local media'],
    ['favorite.write', 'Change Favorites'],
    ['tags.write', 'Edit tags'],
    ['notes.write', 'Edit notes'],
    ['downloads.manage', 'Save archived media to PC'],
  ];

  async function command(name, payload = {}) {
    const response = await call({ type: 'REMOTE_COMMAND', name, payload });
    if (response?.ok === false) throw new Error(response.error || 'Remote command failed');
    return response || {};
  }

  // Chrome's native-messaging errors are terse; say what they mean and what to do next.
  function friendlyError(message) {
    const text = String(message || '');
    if (/native messaging host not found/i.test(text))
      return 'The Remote Companion is not installed for Chrome yet. Double-click setup_remote.bat in the FFmpeg_Helper folder, then reload XVault.';
    if (/Remote controls are available only/i.test(text))
      return 'This dashboard is using an older Remote connection check. Reload XVault on the browser extensions page, close this dashboard, and reopen it.';
    if (/forbidden|not allowed/i.test(text))
      return 'The browser refused the Companion because it was set up for a different extension ID. Run setup_remote.bat again and paste the ID shown below.';
    if (/host has exited|exited|disconnected|connection closed/i.test(text))
      return 'The browser lost its Companion connection. Choose Check connection, then Start pairing to reconnect. No setup window needs to stay open. If it repeats, run check_remote.bat for a diagnosis.';
    if (/did not respond in time/i.test(text))
      return 'The Companion did not answer in time. Press Start pairing again; if it repeats, run check_remote.bat.';
    return text;
  }

  function error(message) {
    let node = $('#remoteError');
    if (!node) {
      node = document.createElement('p');
      node.id = 'remoteError';
      node.className = 'remote-error';
      node.setAttribute('role', 'alert');
      panel.append(node);
    }
    node.textContent = friendlyError(message || 'Remote is unavailable.').slice(0, 260);
  }

  function clearError() {
    $('#remoteError')?.remove();
  }

  function connectionStatus(text) {
    const node = $('#remoteConnectionStatus');
    if (node) node.textContent = text;
  }

  async function checkConnection() {
    if (connecting) return;
    connecting = true;
    clearError();
    const button = $('#remoteCheck');
    button.disabled = true;
    button.textContent = 'Checking…';
    $('#remoteToggle').disabled = true;
    connectionStatus('Checking the installed Companion. This does not start phone access.');
    try {
      await refreshStatus();
      connectionStatus(
        listening
          ? 'Companion connected. Scan a pairing QR to add a phone.'
          : 'Companion installed and connected. Choose Start pairing to create your QR.'
      );
      $('#remoteSetupHint').hidden = true;
    } catch (failure) {
      updateStatus({ listening: false });
      error(failure.message);
      connectionStatus('Connection check failed. Follow the setup steps below, then check again.');
      $('#remoteSetupHint').hidden = false;
    } finally {
      connecting = false;
      button.disabled = false;
      button.textContent = 'Check connection';
      $('#remoteToggle').disabled = false;
    }
  }

  function revealRemote(startPairing = false) {
    page('settings');
    requestAnimationFrame(() => {
      const stickyHeader = panel.closest('.page')?.querySelector('.settingshero');
      const inset =
        stickyHeader && getComputedStyle(stickyHeader).position === 'sticky'
          ? stickyHeader.getBoundingClientRect().height + 14
          : 14;
      const top = window.scrollY + panel.getBoundingClientRect().top - inset;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      if (startPairing) setTimeout(() => $('#remoteToggle')?.click(), 360);
    });
  }

  window.XVaultRemoteSettings = Object.freeze({ reveal: revealRemote });

  function updateStatus(status) {
    listening = !!status?.listening;
    const state = $('#remoteState');
    state.textContent = listening ? 'LISTENING · HTTPS' : 'OFF';
    state.classList.toggle('on', listening);
    $('#remoteToggle').textContent = listening
      ? inviteExpiresAt > Date.now()
        ? 'New pairing QR'
        : 'Make pairing QR'
      : 'Start pairing';
    $('#remoteStop').hidden = !listening;
    $('#remoteSetupHint').hidden = listening;
    $('#remotePort').disabled = listening;
    if (status?.baseUrl && $('#remotePairStage').hidden) $('#remoteAddress').value = status.baseUrl;
    if (status?.certificateFingerprint) $('#remoteFingerprint').textContent = status.certificateFingerprint;
  }

  function permissionSelection() {
    const granted = ['library.read', 'media.read'];
    for (const [key] of permissions.slice(2)) if ($(`[data-remote-permission="${key}"]`)?.checked) granted.push(key);
    return granted;
  }

  function renderQr(invite) {
    const box = $('#remoteQr');
    box.replaceChildren();
    if (typeof qrcode !== 'function') throw new Error('Offline QR generator did not load');
    const code = qrcode(0, 'Q');
    code.addData(String(invite.url || ''), 'Byte');
    code.make();
    const svg = code.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    if (!svg.startsWith('<svg') || svg.length > 300_000) throw new Error('Pairing QR could not be created');
    box.innerHTML = svg;
    const image = box.querySelector('svg');
    image.setAttribute('role', 'img');
    image.setAttribute('aria-label', 'One-time XVault Remote pairing QR code');
    $('#remotePairCode').textContent = String(invite.code || '')
      .replace(/\D/g, '')
      .slice(0, 6)
      .padStart(6, '0');
    $('#remoteAddress').value = invite.url || '';
    inviteExpiresAt = Number(invite.expiresAt || 0) * 1000;
    $('#remotePairExpiry').textContent = 'Waiting for desktop approval · expires in 5 min';
    $('#remotePairStage').hidden = false;
    $('#remotePairCode').title = 'The code is for identifying the request. It does not grant access.';
    const fingerprint = invite.status?.certificateFingerprint;
    if (fingerprint) $('#remoteFingerprint').textContent = fingerprint;
    updateStatus(invite.status || { listening: true, baseUrl: invite.url?.split('/pair')[0] });
  }

  async function startPairing() {
    if (connecting) return;
    connecting = true;
    clearError();
    const button = $('#remoteToggle');
    button.disabled = true;
    button.textContent = 'Connecting…';
    if ($('#remoteCheck')) $('#remoteCheck').disabled = true;
    connectionStatus('Connecting to the Companion and preparing your QR…');
    try {
      const port = Math.max(1024, Math.min(65535, Math.floor(Number($('#remotePort').value) || 18765)));
      const result = await command('remote.start', { port });
      settings = await save({ remoteEnabled: true, remotePort: port }, false);
      updateStatus(result);
      const invite = await command('pairing.start', { port });
      renderQr(invite);
      connectionStatus('Ready. Scan the QR on the same Wi-Fi, then approve your phone below.');
      pollPending();
      clearInterval(refreshTimer);
      refreshTimer = setInterval(() => {
        refreshStatus().catch(() => {});
        if (listening) pollPending();
      }, 1800);
    } catch (failure) {
      error(
        failure.message ||
          'Could not start the Companion. Double-click the setup_remote.bat file in the FFmpeg_Helper folder, then reload XVault. check_remote.bat shows what is missing.'
      );
      $('#remoteSetupHint').hidden = false;
      connectionStatus('Could not create the pairing QR. Follow the recovery message below.');
    } finally {
      connecting = false;
      button.disabled = false;
      button.textContent = listening ? 'Make pairing QR' : 'Start pairing';
      if ($('#remoteCheck')) $('#remoteCheck').disabled = false;
    }
  }

  async function refreshStatus() {
    const status = await command('remote.status');
    updateStatus(status);
    if (listening) await renderDevices();
    else $('#remoteDevices').replaceChildren();
  }

  async function newPairing() {
    if (connecting) return;
    connecting = true;
    $('#remoteToggle').disabled = true;
    clearError();
    try {
      const port = Math.floor(Number($('#remotePort').value) || settings.remotePort || 18765);
      const invite = await command('pairing.regenerate', { port });
      renderQr(invite);
      await pollPending();
    } catch (failure) {
      error(failure.message || 'A new pairing QR could not be made.');
    } finally {
      connecting = false;
      $('#remoteToggle').disabled = false;
    }
  }

  function createRequest(row) {
    const item = document.createElement('article');
    item.className = 'remote-request';
    const info = document.createElement('div');
    const title = document.createElement('b');
    title.textContent = row.name || 'Phone request';
    const detail = document.createElement('small');
    detail.textContent = `${row.address || 'Same Wi-Fi'} · requested ${new Date(Number(row.created || Date.now()) * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    info.append(title, detail);
    const pairingCode = String(row.pairingCode || '')
      .replace(/\D/g, '')
      .slice(0, 6);
    if (/^\d{6}$/.test(pairingCode)) {
      const code = document.createElement('code');
      code.className = 'remote-request-code';
      code.textContent = `Compare code · ${pairingCode}`;
      info.append(code);
    }
    const actions = document.createElement('div');
    actions.className = 'remote-request-actions';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.className = 'approve';
    approve.textContent = 'Approve';
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.textContent = 'Deny';
    approve.addEventListener('click', async () => {
      approve.disabled = deny.disabled = true;
      try {
        await command('pairing.approve', { requestId: row.id, permissions: permissionSelection() });
        await pollPending();
        await renderDevices();
      } catch (failure) {
        error(failure.message || 'Could not approve this device.');
        approve.disabled = deny.disabled = false;
      }
    });
    deny.addEventListener('click', async () => {
      approve.disabled = deny.disabled = true;
      try {
        await command('pairing.deny', { requestId: row.id });
        $('#remotePairStage').hidden = true;
        await pollPending();
      } catch (failure) {
        error(failure.message || 'Could not deny this device.');
      }
    });
    actions.append(approve, deny);
    item.append(info, actions);
    return item;
  }

  async function pollPending() {
    if (!listening || polling) return;
    polling = true;
    try {
      const response = await command('pairing.pending');
      const pending = Array.isArray(response.rows) ? response.rows : [];
      const target = $('#remotePending');
      target.replaceChildren();
      if (pending.length) {
        const title = document.createElement('div');
        title.className = 'remote-pending-title';
        title.textContent = 'Phone waiting for approval';
        target.append(title);
        for (const row of pending.slice(0, 5)) target.append(createRequest(row));
      }
    } catch (failure) {
      if (listening) error(failure.message || 'Pairing requests could not be checked.');
    } finally {
      polling = false;
    }
    if (inviteExpiresAt && Date.now() >= inviteExpiresAt) {
      $('#remotePairExpiry').textContent = 'Pairing QR expired';
      $('#remoteToggle').textContent = listening ? 'Make new pairing QR' : 'Start pairing';
      inviteExpiresAt = 0;
    } else if (inviteExpiresAt) {
      const remaining = Math.max(0, Math.ceil((inviteExpiresAt - Date.now()) / 1000));
      $('#remotePairExpiry').textContent =
        `Waiting for desktop approval · ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} left`;
    }
  }

  function devicePermissionEditor(device) {
    const details = document.createElement('details');
    details.className = 'remote-device-permissions';
    const summary = document.createElement('summary');
    summary.textContent = 'Permissions';
    details.append(summary);
    const grid = document.createElement('div');
    grid.className = 'remote-permissions';
    for (const [key, label] of permissions) {
      const wrapper = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = (device.permissions || []).includes(key);
      input.dataset.devicePermission = key;
      const text = document.createElement('span');
      text.textContent = label;
      wrapper.append(input, text);
      grid.append(wrapper);
    }
    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save access';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        const selected = [...grid.querySelectorAll('[data-device-permission]:checked')].map(
          input => input.dataset.devicePermission
        );
        await command('device.permissions', { deviceId: device.id, permissions: selected });
        await renderDevices();
      } catch (failure) {
        error(failure.message || 'Device permissions could not be updated.');
        save.disabled = false;
      }
    });
    details.append(grid, save);
    return details;
  }

  async function renderDevices() {
    const target = $('#remoteDevices');
    const response = await command('devices.list');
    const rows = Array.isArray(response.rows) ? response.rows : [];
    target.replaceChildren();
    if (!rows.length) return;
    const heading = document.createElement('div');
    heading.className = 'remote-device-heading';
    heading.textContent = `Paired devices · ${rows.length}`;
    target.append(heading);
    for (const device of rows) {
      const item = document.createElement('article');
      item.className = 'remote-device';
      const info = document.createElement('div');
      const name = document.createElement('b');
      name.textContent = device.name || 'Phone';
      const meta = document.createElement('small');
      meta.textContent = `${device.address || 'Same Wi-Fi'} · paired ${new Date(Number(device.pairedAt || 0) * 1000).toLocaleDateString()}`;
      info.append(name, meta);
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.textContent = 'Revoke';
      revoke.setAttribute('aria-label', `Revoke ${device.name || 'paired device'}`);
      revoke.addEventListener('click', async () => {
        revoke.disabled = true;
        try {
          await command('device.revoke', { deviceId: device.id });
          await renderDevices();
        } catch (failure) {
          error(failure.message || 'This device could not be revoked.');
          revoke.disabled = false;
        }
      });
      item.append(info, revoke);
      target.append(item, devicePermissionEditor(device));
    }
  }

  async function stopRemote() {
    clearError();
    $('#remoteStop').disabled = true;
    try {
      await command('remote.stop');
      await save({ remoteEnabled: false }, false);
      listening = false;
      inviteExpiresAt = 0;
      clearInterval(refreshTimer);
      $('#remotePairStage').hidden = true;
      $('#remotePending').replaceChildren();
      $('#remoteDevices').replaceChildren();
      updateStatus({ listening: false });
      toast('XVault Remote stopped');
    } catch (failure) {
      error(failure.message || 'Remote could not be stopped.');
    } finally {
      $('#remoteStop').disabled = false;
    }
  }

  async function copyText(value, success) {
    try {
      await navigator.clipboard.writeText(String(value || ''));
      toast(success);
    } catch {
      error('Clipboard access was blocked. Select and copy the address manually.');
    }
  }

  async function init() {
    $('#remoteExtensionId').textContent = `Extension ID · ${chrome.runtime.id}`;
    $('#remoteCopyExtension').addEventListener('click', () => copyText(chrome.runtime.id, 'Extension ID copied'));
    $('#remoteToggle').addEventListener('click', () => (listening ? newPairing() : startPairing()));
    $('#remoteCheck')?.addEventListener('click', checkConnection);
    $('#remoteStop').addEventListener('click', stopRemote);
    $('#remoteCopyAddress').addEventListener('click', () =>
      copyText($('#remoteAddress').value, 'Pairing address copied')
    );
    $('#remoteQuick')?.addEventListener('click', () => {
      revealRemote();
    });
    $('#remotePort').addEventListener('change', async () => {
      const port = Math.max(1024, Math.min(65535, Math.floor(Number($('#remotePort').value) || 18765)));
      $('#remotePort').value = String(port);
      settings = await save({ remotePort: port }, false);
    });
    const response = await call({ type: 'GET_SETTINGS' });
    settings = response?.settings || {};
    $('#remotePort').value = String(settings.remotePort || 18765);
    if (settings.remoteEnabled) {
      try {
        await refreshStatus();
        if (listening) {
          refreshTimer = setInterval(() => {
            pollPending();
          }, 1800);
        }
      } catch (failure) {
        updateStatus({ listening: false });
        error(
          failure.message ||
            'Remote is enabled but the Companion is unavailable. Double-click the setup_remote.bat file in the FFmpeg_Helper folder.'
        );
      }
    } else {
      updateStatus({ listening: false });
      try {
        await renderDevices();
      } catch {
        /* Native Host may not yet be installed. */
      }
    }
  }

  document.addEventListener(
    'DOMContentLoaded',
    () => {
      init().catch(failure => error(failure.message || 'Remote settings could not load.'));
    },
    { once: true }
  );
})();
