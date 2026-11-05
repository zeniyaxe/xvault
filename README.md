# XVault

Local-first X/Twitter archive and media manager for Chrome and Edge (Manifest V3; Firefox build in beta, tested in a real Firefox). Everything you capture stays on your
computer: posts in IndexedDB, media through Chrome downloads with byte-level verification.

## Highlights

- **Capture** — passive capture while you browse, one-click archive/download on posts, bulk Bookmarks / Likes /
  profile / timeline / thread collection with resumable checkpoints, presets, live rate/ETA and run history. Polls,
  link cards, Spaces, Community Notes, edit history and alt text are kept as structured data.
- **Archive quality** — a completeness score per post, and polite background queues (daily caps, pause/resume) that
  repair incomplete posts, fill thread gaps and quote chains, and optionally check whether favourites are still on
  X. Edits are tracked with a word-level diff timeline in the Reader; deleted/suspended/withheld posts are marked.
  Opt-in watch lists capture chosen accounts or searches on a schedule; opt-in link snapshots keep the readable
  text of linked pages.
- **Verified downloads** — one identity per physical media asset (no duplicate files across URL spellings),
  retry with classified failure reasons, crash recovery, content verification, optional GIF/WebP conversion, and
  adaptive parallelism that backs off when X's media servers push back. Video quality (globally or per rule), a
  download window, Data Saver/cellular holds and a bandwidth cap; filename and folder templates with a live preview;
  per-host health, duplicate reclaim, scheduled re-verification and safe renames (Downloads › Files & health) —
  with the helper running (Chrome, Edge or Firefox), XVault renames files itself, replaces identical copies with
  hard links and measures real disk use. The Downloads page shows honest progress, live transfers with their own
  controls, a pause that survives restarts, and a filterable history with Retry and Copy reason.
- **Import your X archive** — drop the ZIP from X's "Download an archive of your data" to add every tweet (long posts
  with their full text), like, bookmark, community post and recently deleted post it contains, and save the media
  files inside it as local downloads; read in the browser without unpacking, direct messages are never read, and
  live captures always keep their richer data.
- **Library** — fast ranked search with filters (`from:`, `has:`, `tag:`, `likes:>1k`, `after:`, `on:`, `year:`,
  `is:thread`, `#hashtag`, `@mention`, `domain:`, `thread:ID`…), negation (`-from:bot`), alternatives
  (`has:video|gif`), usage-ranked suggestions with inline filter help (`Ctrl`+`Space`), text inside images
  (`ocr:receipt`, `has:ocr`, read on-device by a bundled OCR engine), **meaning search** (`about:cooking`,
  `similar:<id>`, learned on-device from your own archive, multilingual), typo tolerance (`word~`), your own
  synonyms, "did you mean", a keyword ↔ meaning blend, search history with time travel (`asof:2024-05-01` shows
  the text as it was that day), a clickable/draggable **timeline** of matching posts, filters
  for quality, edits, availability, polls, alt text, duration, resolution, aspect, engagement, weekday and hour, 25+
  sorts, search by image, smart collections with "new since last visit" counts, tags, notes, favorites, Inbox
  review, workspaces, Trash with undo, lightbox and inspector.
- **Organise** — boards (`board:`), a bulk editor with undo (`Ctrl`+`Z`), Select by, a context menu, a sortable
  Table layout and auto-tag rules written in the search language (`from:nasa has:video` → `space`).
- **Atlas** — an overview of the whole archive: growth, media mix, rhythm, people, conversations, languages,
  hashtags and linked sites; a posting/archiving calendar (local time or UTC) with streaks; author profiles; a
  Duplicate Lab whose look-alike scan runs and resumes in the background; **Year in Review** with topic drift,
  achievements and a people graph, exportable as a PNG card or Markdown; and **Topics**, automatic meaning clusters you can name, search, save or turn
  into boards.
- **Reader** — read any archived thread as one continuous page (author spine, optional replies, media, quotes) with
  a **thread map** of replies and quotes beside the column (click to jump), and copy or save it as Markdown or HTML; edit notes inline and fetch a missing parent on request. Read later,
  highlights with notes and reading progress (`is:later`, `has:highlight`, `highlight:<text>`).
- **Scheduled sync** — optional, off by default: keep Bookmarks/Likes current from a background X tab and get
  notified about new posts matching watched Smart Collections.
- **Export & recovery** — full JSON Lines recovery file (import with conflict review), optionally as an encrypted
  `.xvenc` backup (AES-256-GCM, passphrase), CSV, Obsidian-compatible Markdown notes, single-file offline HTML
  archive, thread-grouped Markdown/HTML, link lists, integrity scan and file manifest.
- **Storage & backups** — System → Storage shows quota, persistence, per-store counts, the last backup and safe
  cleanup of derived data, and runs **scheduled automatic backups** (optionally encrypted, with retention).
- **Feel** — animated view changes, notices that stack, count repeats and offer **Undo** (with **Recent notices**
  in the command palette), sliding segmented controls, lightbox zoom from the thumbnail; *Calm motion* turns it off.
- **Accessibility** — high contrast, always-on focus rings, text scaling, remappable shortcuts (`?` lists them).
- **Remote** — optional phone viewer (PWA) served by the local helper over your LAN, with QR pairing,
  per-device permissions and revocation.

## Install (unpacked)

1. Download `XVault-<version>.zip` from the latest GitHub Release (or the `xvault-extension` CI artifact, or run
   `npm run build`) and unzip it.
2. Open `chrome://extensions` (Edge: `edge://extensions`, using `XVault-<version>-edge.zip`), enable **Developer
   mode**, choose **Load unpacked**, select the folder that contains `manifest.json`.
   Firefox (beta, `XVault-<version>-firefox.zip`): `about:debugging` → This Firefox → Load Temporary
   Add-on. OCR runs in the event page; Remote and the FFmpeg helper are unavailable there.
3. To update, replace the files and press **Reload** on the same installation — your archive is preserved.

Optional helpers (Windows): GIF/WebP conversion, in-place renames and hard-linked duplicates — run
`FFmpeg_Helper/setup_helper.bat`, then `run_helper.bat`.
Remote phone viewer — see `FFmpeg_Helper/REMOTE_README.md` (copy `config.example.json` to `config.json`).

## Development

```bash
npm install
npm run verify     # integrity check + ESLint + unit tests + Prettier check
npm run build      # dist/XVault-<version>.zip (release artifacts are never committed)
npm run build:all  # plus -edge.zip and the beta -firefox.zip
npm run bench      # engine benchmarks on synthetic 10k/50k/100k-post vaults
npm run e2e        # loads the real extension in Chromium (needs `npm i --no-save playwright`)
npm run e2e:a11y   # axe-core accessibility audit of every page (serious/critical fail)
npm run e2e:helper # real helper process + real downloads (renames, hard links) and automatic backups
python3 scripts/e2e-firefox.py dist/XVault-<version>-firefox.zip   # real Firefox (FIREFOX_BIN, GECKODRIVER)
python -m unittest discover -s tests/python   # Remote pairing/security and helper file-operation tests
python -m unittest discover -s tests -p 'test_*.py'   # helper/companion tests
```

`npm install` copies the OCR engine and English model from `node_modules` into `vendor/ocr/` (git-ignored; the build
includes it). Releases: push a `v<version>` tag matching `manifest.json` and the Release workflow verifies, builds and
publishes the Chrome, Edge and Firefox zips with SHA-256 checksums and the CHANGELOG section as notes. CI also lints
the Firefox build with Mozilla's `web-ext lint`.

Project layout: `background.js` (service worker: queue, capture, storage orchestration), `library-*.{js,mjs}`
(storage, search, collections, exporters), `sw/` (worker modules: message router, background jobs, OCR host, sync
scheduler, meaning index, boards/rules, adaptive downloads, archive quality and visit queue, watch lists, link
snapshots, topic clusters, download policy, automatic backups, timeline buckets), `x-archive-import.mjs`, `x-post-extras.js`, `revision-diff.js`,
`filename-template.js`, `backup-crypto.mjs` and `recovery-backup-core.mjs` (+ `offscreen-backup.mjs`),
`dashboard.html` + `xv-*.js` (app shell and pages; they extend `dashboard.js` through `dashboard-hooks.js`), `content.js` /
`instant-actions.js` / `page-hook.js` (X integration), `FFmpeg_Helper/` (Python helper + Remote PWA).
See `XVAULT_ROADMAP.md` for architecture notes, decisions and the current plan.

Personal configuration, credentials, state, logs and browser profiles are excluded from the repository.
