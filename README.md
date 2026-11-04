# XVault

Local-first X/Twitter archive and media manager for Chrome and Edge (Manifest V3; Firefox build experimental). Everything you capture stays on your
computer: posts in IndexedDB, media through Chrome downloads with byte-level verification.

## Highlights

- **Capture** — passive capture while you browse, one-click archive/download on posts, bulk Bookmarks / Likes /
  profile / timeline / thread collection with resumable checkpoints.
- **Verified downloads** — one identity per physical media asset (no duplicate files across URL spellings),
  retry with classified failure reasons, crash recovery, content verification, optional GIF/WebP conversion, and
  adaptive parallelism that backs off when X's media servers push back.
- **Import your X archive** — drop the ZIP from X's "Download an archive of your data" to add every tweet, like and
  bookmark it contains; read in the browser without unpacking, and live captures always keep their richer data.
- **Library** — fast ranked search with filters (`from:`, `has:`, `tag:`, `likes:>1k`, `after:`, `on:`, `year:`,
  `is:thread`, `#hashtag`, `@mention`, `domain:`, `thread:ID`…), negation (`-from:bot`), alternatives
  (`has:video|gif`), usage-ranked suggestions with inline filter help (`Ctrl`+`Space`), text inside images
  (`ocr:receipt`, `has:ocr`, read on-device by a bundled OCR engine), **meaning search** (`about:cooking`,
  `similar:<id>`, learned on-device from your own archive), search by image, smart collections, tags, notes,
  favorites, Inbox review, workspaces, Trash with undo, lightbox and inspector.
- **Organise** — boards (`board:`), a bulk editor with undo (`Ctrl`+`Z`), Select by, a context menu, a sortable
  Table layout and auto-tag rules written in the search language (`from:nasa has:video` → `space`).
- **Atlas** — an overview of the whole archive: growth, media mix, rhythm, people, conversations, languages,
  hashtags and linked sites; a posting/archiving calendar (local time or UTC) with streaks; author profiles; a
  Duplicate Lab whose look-alike scan runs and resumes in the background; and **Year in Review** with topic drift,
  achievements and a people graph.
- **Reader** — read any archived thread as one continuous page (author spine, optional replies, media, quotes) and
  copy or save it as Markdown or HTML; edit notes inline and fetch a missing parent on request. Read later,
  highlights with notes and reading progress (`is:later`, `has:highlight`, `highlight:<text>`).
- **Scheduled sync** — optional, off by default: keep Bookmarks/Likes current from a background X tab and get
  notified about new posts matching watched Smart Collections.
- **Export & recovery** — full JSON Lines recovery file (import with conflict review), optionally as an encrypted
  `.xvenc` backup (AES-256-GCM, passphrase), CSV, Obsidian-compatible Markdown notes, single-file offline HTML
  archive, thread-grouped Markdown/HTML, link lists, integrity scan and file manifest.
- **Storage & backups** — System → Storage shows quota, persistence, per-store counts, the last backup and safe
  cleanup of derived data.
- **Accessibility** — high contrast, always-on focus rings, text scaling, remappable shortcuts (`?` lists them).
- **Remote** — optional phone viewer (PWA) served by the local helper over your LAN, with QR pairing,
  per-device permissions and revocation.

## Install (unpacked)

1. Download `XVault-<version>.zip` from the latest GitHub Release (or the `xvault-extension` CI artifact, or run
   `npm run build`) and unzip it.
2. Open `chrome://extensions` (Edge: `edge://extensions`, using `XVault-<version>-edge.zip`), enable **Developer
   mode**, choose **Load unpacked**, select the folder that contains `manifest.json`.
   Firefox (experimental, `XVault-<version>-firefox.zip`): `about:debugging` → This Firefox → Load Temporary
   Add-on. Local OCR, Remote and the FFmpeg helper are unavailable there.
3. To update, replace the files and press **Reload** on the same installation — your archive is preserved.

Optional helpers (Windows): GIF/WebP conversion — run `FFmpeg_Helper/setup_helper.bat`, then `run_helper.bat`.
Remote phone viewer — see `FFmpeg_Helper/REMOTE_README.md` (copy `config.example.json` to `config.json`).

## Development

```bash
npm install
npm run verify     # integrity check + ESLint + unit tests + Prettier check
npm run build      # dist/XVault-<version>.zip (release artifacts are never committed)
npm run build:all  # plus -edge.zip and the experimental -firefox.zip
npm run bench      # engine benchmarks on synthetic 10k/50k/100k-post vaults
npm run e2e        # loads the real extension in Chromium (needs `npm i --no-save playwright`)
npm run e2e:a11y   # axe-core accessibility audit of every page (serious/critical fail)
python -m unittest discover -s tests/python   # Remote pairing/security tests
```

`npm install` copies the OCR engine and English model from `node_modules` into `vendor/ocr/` (git-ignored; the build
includes it). Releases: push a `v<version>` tag matching `manifest.json` and the Release workflow verifies, builds and
publishes the zip with its SHA-256 and the CHANGELOG section as notes.

Project layout: `background.js` (service worker: queue, capture, storage orchestration), `library-*.{js,mjs}`
(storage, search, collections, exporters), `sw/` (worker modules: message router, background jobs, OCR host, sync
scheduler, meaning index, boards/rules, adaptive downloads), `x-archive-import.mjs` and `backup-crypto.mjs`,
`dashboard.html` + `xv-*.js` (app shell and pages; they extend `dashboard.js` through `dashboard-hooks.js`), `content.js` /
`instant-actions.js` / `page-hook.js` (X integration), `FFmpeg_Helper/` (Python helper + Remote PWA).
See `XVAULT_ROADMAP.md` for architecture notes, decisions and the current plan.

Personal configuration, credentials, state, logs and browser profiles are excluded from the repository.
