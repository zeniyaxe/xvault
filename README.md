# XVault

Local-first X/Twitter archive and media manager for Chrome (Manifest V3). Everything you capture stays on your
computer: posts in IndexedDB, media through Chrome downloads with byte-level verification.

## Highlights

- **Capture** — passive capture while you browse, one-click archive/download on posts, bulk Bookmarks / Likes /
  profile / timeline / thread collection with resumable checkpoints.
- **Verified downloads** — one identity per physical media asset (no duplicate files across URL spellings),
  retry with classified failure reasons, crash recovery, content verification, optional GIF/WebP conversion.
- **Library** — fast ranked search with filters (`from:`, `has:`, `tag:`, `likes:>1k`, `after:`, `on:`, `year:`,
  `is:thread`, `#hashtag`, `@mention`, `domain:`, `thread:ID`…), negation (`-from:bot`), alternatives
  (`has:video|gif`), usage-ranked suggestions with inline filter help (`Ctrl`+`Space`), text inside images
  (`ocr:receipt`, `has:ocr`, read on-device by a bundled OCR engine), smart collections, tags, notes, favorites, Inbox review, workspaces,
  Trash with undo, lightbox and inspector.
- **Atlas** — an overview of the whole archive: growth, media mix, rhythm, people, conversations, languages,
  hashtags and linked sites; a posting/archiving calendar (local time or UTC) with streaks; author profiles; and a
  Duplicate Lab whose look-alike scan runs and resumes in the background.
- **Reader** — read any archived thread as one continuous page (author spine, optional replies, media, quotes) and
  copy or save it as Markdown or HTML; edit notes inline and fetch a missing parent on request.
- **Scheduled sync** — optional, off by default: keep Bookmarks/Likes current from a background X tab and get
  notified about new posts matching watched Smart Collections.
- **Export & recovery** — full JSON Lines recovery file (import with conflict review), CSV, Obsidian-compatible
  Markdown notes, single-file offline HTML archive, thread-grouped Markdown/HTML, link lists, integrity scan and file manifest.
- **Remote** — optional phone viewer (PWA) served by the local helper over your LAN, with QR pairing,
  per-device permissions and revocation.

## Install (unpacked)

1. Download `XVault-<version>.zip` from the latest GitHub Release (or the `xvault-extension` CI artifact, or run
   `npm run build`) and unzip it.
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
npm run e2e:a11y   # axe-core accessibility audit of every page (serious/critical fail)
python -m unittest discover -s tests/python   # Remote pairing/security tests
```

`npm install` copies the OCR engine and English model from `node_modules` into `vendor/ocr/` (git-ignored; the build
includes it). Releases: push a `v<version>` tag matching `manifest.json` and the Release workflow verifies, builds and
publishes the zip with its SHA-256 and the CHANGELOG section as notes.

Project layout: `background.js` (service worker: queue, capture, storage orchestration), `library-*.{js,mjs}`
(storage, search, collections, exporters), `sw/` (worker modules: background jobs, OCR host, sync scheduler),
`dashboard.html` + `xv-*.js` (app shell and pages; they extend `dashboard.js` through `dashboard-hooks.js`), `content.js` /
`instant-actions.js` / `page-hook.js` (X integration), `FFmpeg_Helper/` (Python helper + Remote PWA).
See `XVAULT_ROADMAP.md` for architecture notes, decisions and the current plan.

Personal configuration, credentials, state, logs and browser profiles are excluded from the repository.
