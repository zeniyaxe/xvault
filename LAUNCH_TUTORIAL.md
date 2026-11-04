# XVault launch tutorial

This project is a Chrome/Chromium extension. There is no `npm start` command or local web server for the desktop dashboard. The extension opens the dashboard and keeps its archive in the browser's IndexedDB storage.

## 1. Load XVault in Chrome

1. Use a current Chrome version (the extension manifest requires Chrome 120 or newer). Keep this project folder in a stable location.
2. In Chrome, open `chrome://extensions`. In Edge, use `edge://extensions`.
3. Turn on **Developer mode**.
4. Choose **Load unpacked** and select the XVault project root—the folder containing `manifest.json`, `background.js`, and `dashboard.html`. Do not select `FFmpeg_Helper`.
5. Pin **XVault** from the Extensions menu if you want one-click dashboard access.
6. Click the XVault toolbar icon. It opens the dashboard. You can also open the extension's **Details** page and choose **Extension options**.

When you change source files, return to the extensions page and click XVault's **Reload** button, then close and reopen any dashboard tab. Reloading the same extension preserves its existing archive. Avoid removing it and installing a different copy to troubleshoot; a different extension ID has a different browser storage origin.

## 2. Start collecting posts

1. Sign into X in the same Chrome profile where XVault is installed. Reload any X tabs that were already open when you installed the extension.
2. Open XVault. Complete the short onboarding if it appears.
3. To passively capture supported posts, leave the dashboard's **Passive capture** switch on and browse X normally.
4. To collect a source deliberately, open **Archive**, choose **Bookmarks**, **Likes**, **Profile**, or **Timeline**, then use **Open source** or **Start smart archive**. For a Profile run, enter its handle. X must be signed in and allowed to show the source.
5. To review saved posts, open **Library** and expand **Library tools** and choose **Load / refresh Library**. Search, filters, sorting, and paging work on the local archive; they do not send your saved archive to a server.

The Library's stuck worker-search bug is fixed in this source. If an older dashboard tab still says “Loading local archive…”, reload XVault at `chrome://extensions`, close that dashboard tab, and open a new one from the extension icon. Your stored posts are not cleared by this reload.

## 3. Optional: run the FFmpeg Helper

The Helper supports local animation conversion and related local media previews. XVault's Library and archive do not require it.

1. Run `FFmpeg_Helper\setup_helper.bat` once. The setup asks for the browser Downloads folder and XVault extension ID. Copy the ID from **Settings → Remote** in the dashboard; the same ID is used for the Helper's extension-origin allowlist.
2. Setup checks for FFmpeg. If it is missing, it may offer to install it with `winget`; you can also install FFmpeg separately and make `ffmpeg.exe` available on `PATH`.
3. Choose whether the Helper should start with Windows. Setup then starts `run_helper.bat`.
4. Keep the Helper console open while using it. Its local status endpoint is `http://127.0.0.1:17843/status`.
5. In XVault, open **Health** and confirm **FFmpeg Helper bridge** and **FFmpeg detected** are healthy.

To launch it later, double-click `FFmpeg_Helper\run_helper.bat`. Press Ctrl+C in its console to stop it. The Helper uses `FFmpeg_Helper\config.json`; its default download layout keeps originals and converted GIF/WebP files in separate folders. Check that file before running setup if you have customized an existing installation.

## 4. Optional: pair the phone over the same Wi-Fi

Remote serves the same local Library through the opt-in Companion. It is for a private home/local network, not public internet hosting.

### One-time installation

1. Install Python 3 and ensure `python.exe` is on PATH. The setup script creates a temporary environment, installs the pinned Remote build dependencies, builds the Native Messaging executable, and registers it for the current Windows user. Internet access is needed for those first-time package downloads.
2. Open **Settings → Remote** in XVault and copy the extension ID.
3. In a normal PowerShell window (administrator rights are not normally required), run:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\FFmpeg_Helper\setup_remote.ps1
   # or simply double-click FFmpeg_Helper\setup_remote.bat; run check_remote.bat if anything fails
   ```

   When prompted, paste the extension ID. The script installs the Native Messaging registration for Chrome and Edge for your Windows user; it does not require the FFmpeg Helper to be running.
4. Reload XVault from the extensions page and reopen the dashboard.

### Pair and connect

If Settings → Remote says “Remote controls are available only in the XVault dashboard” while you are already in the dashboard, reload the updated extension, close that dashboard tab and reopen it. Older builds mistakenly rejected dashboard tabs. Use **Check connection** to verify the installed Companion before creating a QR; a successful check does not open phone access.

The Remote installer and its firewall PowerShell window can close when finished. Chrome starts the Companion in the background; no Remote console needs to remain open. If an installed Companion disconnects after a connection check, reload the latest extension and reopen the dashboard: older builds retained a disconnected native port after idle cleanup. Reinstalling the Companion does not fix that older extension bug.

1. Connect the computer and phone to the same non-guest Wi-Fi network. Avoid client-isolated guest networks and, during setup, VPNs that hide the computer's local address.
2. In XVault, open **Settings → Remote** and choose **Start pairing**. XVault starts the listener and displays a QR invitation with an expiration timer.
3. Scan the QR code with the phone camera. The phone opens the local HTTPS address in its browser.
4. The Companion uses a self-signed local TLS certificate. Inspect the certificate and compare the displayed SHA-256 fingerprint with the fingerprint in XVault before continuing. Do not accept a fingerprint mismatch.
5. Compare the six-digit code shown on the phone with the pending request in XVault, then approve that request on the desktop. The code identifies the request; approval grants the device access.
6. The phone Library opens after approval. Use the home-screen hint or **Device → Add to home screen**. Chromium can offer an install prompt; iOS uses the browser's Share → Add to Home Screen flow. Trusting the local certificate is still required, and installation does not make the full archive available offline.
7. Use the desktop Remote panel to change available permissions, revoke a device, or choose **Stop Remote** when the phone should no longer connect.

Windows Firewall may ask about the local listener; allow it only on a trusted **Private** network. XVault Remote binds to a detected private IPv4 address and applies server-side permissions. It does not expose arbitrary computer paths.

On the phone, open **Library → Browse** for desktop saved searches and **Time Machine** months. Choose post date or archive date, then Browse month; All dates removes that date constraint. If the archive changes on the computer, Refresh results updates the current query when you choose. **Device → Privacy cover** hides the screen when you switch apps and requires a tap to reveal it on return. The cover is not a PIN lock or encryption; physical OS snapshot timing varies. Retained note drafts remain recoverable from the offline shell, but posts and media are not pinned offline.

For phone-controlled PC downloads, enable **Save archived media to PC** for the device in desktop **Settings → Remote → device permissions**. A post's monitor-arrow button queues all its captured media; the viewer's Save to PC queues only the selected file. Stop remaining requests prevents later ranges, while accepted queue work stays on the computer. Save to phone streams a file already available locally; if it is missing, queue it on PC and use Check local file after the PC finishes. A lost queue reply can have an unknown outcome: inspect desktop Downloads rather than assuming nothing was queued. Data Saver disables automatic gallery/contact previews, not explicitly opened media.

### Remove Remote registration

If the phone shows only post text, turn off **Device → Data Saver** and check **View local media** permission. Remote displays files downloaded into the configured XVault folder. Updated Companion builds support Chrome's full Windows filenames; older builds could silently omit every downloaded file. For posts without a local file, use Save to PC and then Check local file after the download finishes.

Run `FFmpeg_Helper\uninstall_remote.ps1` from PowerShell to remove the Chrome and Edge Native Messaging registry entries. It intentionally leaves the Remote config, device records, and local TLS key in `%LOCALAPPDATA%\XVault\RemoteCompanion` so they can be reused. Remove that folder only if you also want to discard those Remote credentials and certificate.

## 5. Updating and troubleshooting

- **Dashboard did not update:** reload XVault at `chrome://extensions` (or `edge://extensions`), close the old dashboard tab, and reopen it from the toolbar icon.
- **Library appears stuck:** use the latest source, reload the extension, then expand **Library tools** and use **Load / refresh Library**. If it recurs, open the extension's **Errors** or **service worker → Inspect** page and note the first console error; do not clear site or extension storage as a first step.
- **No new captured posts:** verify that X is signed in in the same browser profile, reload the X tab, and browse posts that actually load in the page. Use **Archive** for supported historical sources.
- **Animation conversion unavailable:** start `run_helper.bat`, check the Helper status endpoint, verify FFmpeg is on PATH, and check **Health** in XVault.
- **Phone cannot connect:** confirm Remote is running, both devices are on the same private Wi-Fi, the computer address and fingerprint match the desktop panel, and the Windows network is marked Private. Some guest Wi-Fi routers block device-to-device traffic.
- **Pairing request expired or the code differs:** discard that request, start a new pairing invitation, scan its new QR, and compare the new code before approving.
- **Archive preservation:** the archive is kept by the browser extension's storage origin. Do not use **Clear Library**, reset browser data, or remove the extension when only a source update is needed. Prefer **Reload**.

## Verified status

The current source is checked with a synthetic 50,000-post browser Library, viewport-windowed Compact rows, search, selection, keyboard Quick Look, modal focus, motion, export, and download-planner workflows. An isolated unpacked Chromium extension also verifies real IndexedDB mutations, synthetic capture, private storage boundaries, stable settings, and worker-restart archive persistence. These checks do not access a live installed Chrome profile or prove real downloads/conversions.

Remote pairing/media flows were browser-tested on localhost with synthetic records. A physical phone, external same-Wi-Fi/LAN connection, and installed Native Messaging handshake have not been verified in this environment.
