# XVault

Local-first X/Twitter archive and media manager for Chrome (Manifest V3). Everything you capture stays on your
computer: posts in IndexedDB, media through Chrome downloads with byte-level verification.

## Highlights

- **Capture** — passive capture while you browse, one-click archive/download on posts, bulk Bookmarks / Likes /
  profile / timeline / thread collection with resumable checkpoints.
- **Verified downloads** — one identity per physical media asset (no duplicate files across URL spellings),
  retry with classified failure reasons, crash recovery, content verification, optional GIF/WebP conversion.
- **Library** — fast ranked search with filters (`from:`, `has:`, `tag:`, `likes:>1k`, `after:`…), negation
  (`-from:bot`), alternatives (`has:video|gif`), smart collections, tags, notes, favorites, Inbox review,
  workspaces, Trash with undo, lightbox and inspector.
- **Export & recovery** — full JSON Lines recovery file (import with conflict review), CSV, Obsidian-compatible
  Markdown notes, single-file offline HTML archive, link lists, integrity scan and file manifest.
- **Remote** — optional phone viewer (PWA) served by the local helper over your LAN, with QR pairing,
  per-device permissions and revocation.

## Install (unpacked)

1. Download the latest `xvault-extension` artifact from GitHub Actions (or run `npm run build`) and unzip it.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, select the folder that contains
   `manifest.json`.
3. To update, replace the files and press **Reload** on the same installation — your archive is preserved.

Optional helpers (Windows): GIF/WebP conversion — run `FFmpeg_Helper/setup_helper.bat`, then `run_helper.bat`.
Remote phone viewer — see `FFmpeg_Helper/REMOTE_README.md` (copy `config.example.json` to `config.json`).

## Development

```bash
npm install
npm run verify     # integrity check + ESLint + unit tests + Prettier check
npm run build      # dist/XVault-<version>.zip (release artifacts are never committed)
npm run e2e        # loads the real extension in Chromium (needs `npm i --no-save playwright`)
python -m unittest discover -s tests/python   # Remote pairing/security tests
```

Project layout: `background.js` (service worker: queue, capture, storage orchestration), `library-*.{js,mjs}`
(storage, search, collections, exporters), `dashboard.html` + `xv-*.js` (app shell and pages), `content.js` /
`instant-actions.js` / `page-hook.js` (X integration), `FFmpeg_Helper/` (Python helper + Remote PWA).
See `XVAULT_ROADMAP.md` for architecture notes, decisions and the current plan.

Personal configuration, credentials, state, logs and browser profiles are excluded from the repository.
