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


## Troubleshooting

Double-click `check_remote.bat` at any time. It is read-only and lists what is missing: a working Python, the installed Companion, the Chrome registration, the network address phones use, whether Windows treats the Wi-Fi as Private, the firewall rule, and whether Remote is running. Windows blocks incoming phone connections on networks marked Public, so mark your own home Wi-Fi Private. If you only need GIF/WebP conversion, `run_helper.bat` starts the Animation Helper on its own.
