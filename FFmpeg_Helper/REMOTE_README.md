# XVault Remote

XVault Remote serves a small, phone-first view of the same IndexedDB Library and local media archive. The phone receives one bounded result page at a time; the Native Messaging Companion reads later pages from the existing Library store.

## One-time setup

1. Open **XVault → Settings → Remote** and copy the extension ID shown there.
2. Double-click `setup_remote.bat` in this folder (it runs `setup_remote.ps1` with the right settings) and paste that extension ID. It finds a working Python itself; Windows' built-in `python.exe` is only a Microsoft Store shortcut and is skipped. Answer Yes to the firewall question so your phone can connect. The script builds the Native Messaging executable in a temporary environment and registers it for the current Windows user in Chrome and Edge.
3. Reload the XVault extension, return to **Settings → Remote**, and select **Start pairing**.
4. Scan the QR code while the phone and computer are on the same Wi-Fi. Compare the six-digit code on the phone with the request shown in XVault, then approve it on the computer.
5. On the phone's first visit, inspect the browser certificate details and compare its SHA-256 fingerprint with XVault's pairing panel before continuing. The local certificate is self-signed and is stored beside the Companion; it is not a public certificate authority.

The six-digit code confirms that the phone request shown on the computer matches the scanned invitation; it is not a credential. Pairing issues an HttpOnly, Secure, same-site device cookie only after desktop approval. Device permissions are enforced by the Companion on every request. New devices receive Library and media read access by default; write permissions are opt-in. Revoke a paired device from the desktop at any time.

The listener binds to one detected private IPv4 address, uses HTTPS, exact Host/Origin checks, request limits, per-device opaque media grants, byte-range streaming, a bounded request pool, and a restrictive content security policy. It does not expose arbitrary paths or the existing conversion helper token.

Use **Stop Remote** when a phone should no longer connect. Run `uninstall_remote.ps1` to remove the Chrome and Edge Native Messaging registrations. Uninstall leaves the local config, TLS private key, and paired-device registry in `%LOCALAPPDATA%\XVault\RemoteCompanion` so existing archive settings are preserved; delete that folder manually only when you want to remove those Remote credentials too.


## Sending posts from the phone (Remote 4.0, XVault 25)

The **Capture** tab sends single X posts to the computer's capture inbox. Allow **Send posts to capture** for the phone (pairing panel, or the phone's row under paired devices); it is never granted by default.

- **Paste:** copy a post link in the X app (Share → Copy link), open XVault Remote, tap **Paste** and **Save to XVault**. Several links at once are fine (up to 20 per paste; at most 30 links per phone every five minutes).
- **Share sheet (Android):** add XVault Remote to the home screen. Chrome then lists it in the share sheet, so X → Share → XVault sends the post at once. Chrome only installs web apps whose certificate it trusts; with the self-signed Companion certificate this needs the certificate to be trusted on the phone. Without that, use Paste.
- **iPhone / iPad:** Safari does not let web apps receive shares; use Paste.
- **Offline:** links that cannot reach the computer stay in a small outbox on the phone (link text only, at most 50) and are sent when XVault is reachable again.

The computer opens each post in one reused background tab inside an existing X window (never a new window), waits for the archive to record it and moves on; items wait with a reason when no x.com tab is open or **Capture while browsing** is off. The phone sees the state (queued, waiting, capturing, saved, already saved, unavailable, failed), a short preview of saved posts, and can retry or remove its items. The Capture page on the computer shows the same inbox with pause/resume.

**Avatars.** With Library access the phone shows authors' pictures from the copies XVault keeps on the computer (**Settings → Library → Keep local copies of avatars**, on by default; 96 px, fetched from pbs.twimg.com without cookies, at most 256 KB, type-checked). The phone itself never contacts X; Data Saver keeps monograms.

**Downloads.** The Downloads tab lists the next files in the queue; with **Save archived media to PC** a phone can move one post's queued files to the front (best effort — the order resets if the browser restarts the service worker).

## Troubleshooting

Double-click `check_remote.bat` at any time. It is read-only and lists what is missing: a working Python, the installed Companion, the Chrome registration, the network address phones use, whether Windows treats the Wi-Fi as Private, the firewall rule, and whether Remote is running. Windows blocks incoming phone connections on networks marked Public, so mark your own home Wi-Fi Private. If you only need GIF/WebP conversion, `run_helper.bat` starts the Animation Helper on its own.
