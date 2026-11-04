# XVault overhaul roadmap

This file is the hand-off document: another session should be able to resume from here.

## v20 "Meridian" pass

Branch: `xvault-20-transformation` (from `xvault-19-horizon` @ d0a1152, PR #2 not yet merged, so the v20 PR stacks on
it). Version 20.0.0. Goal: one large pass across search, organisation, reading, import, backups, storage, downloads,
Atlas, accessibility, cross-browser builds, architecture and benchmarks.

| Area | Change |
| --- | --- |
| Router | `sw/router.mjs`: `register(type, handler, { allow })` and `mount(service, { denied })`; `dispatch` runs before the legacy `onMessage` switch and returns `null` for unknown types. Sender capabilities come from the existing `messageCapability`. Routed today: sync, derived jobs, semantic, `FETCH_MISSING_POST`, `RULES_PREVIEW/APPLY`, `BOARD_DELETE/COUNTS`, `STORAGE_REPORT`, `PRUNE_ACTIONS`, `X_ARCHIVE_IMPORT_BATCH`. |
| Meaning search | `sw/semantic.mjs` (Random Indexing: 128-dim int8 post vectors, sparse ±1 index vectors, context vectors trained on up to 200k posts, `buildSemanticIndexAsync` yields every 2,000 posts, incremental `upsert/remove`, `UNKNOWN_MINIMUM` 0.3 for queries with only unknown words). `sw/semantic-service.mjs` stores the index in `xvault-derived/meta` and answers `SEMANTIC_STATUS/SEARCH/SIMILAR/SUGGEST/REBUILD/CLEAR`. Search: `about:`/`meaning:`/`like:`, `similar:`/`related:` (`kind: 'semantic'`), sort `relevance`. The worker joins scores into the search projection only when a semantic clause is present. |
| Library 3.0 | `xv-library3.js/.css` (loaded after `library-workspace.js`): undo stack (`RESTORE_TWEET_META` from snapshots), bulk editor (`XVaultLibraryBulkMeta`), Select by, boards (`settings.boards`, `userMeta.boards`, drag onto facet), context menu, image search (dHash/pHash from `xvault-derived/phash`), rules dialog. `sw/organize.mjs` compiles rules with the search language and plans idempotent patches + undo snapshots. Table layout lives in `library-workspace.js` (`compactMode === 'table'`, 44px rows, sortable header). |
| Reader | `xv-reader.js`: `readLater`/`readAt`/`readProgress {index, total, at}`/`highlights [{id, text, at, note?, color?, start?}]` via `UPDATE_TWEET_META` (validated by `validReadingPatch` in `library-storage.mjs`); keys `L`, `M`, `H`; resume banner; auto-read at 98% for Read-later threads. Search `is:later|read|unread|highlighted`, `later:`, `has:highlight`, `highlight:`. |
| X archive import | `x-archive-import.mjs`: ZIP central-directory reader on a `Blob` (stored + deflate via `DecompressionStream('deflate-raw')`, ZIP64 directories, size caps), `window.YTD.*` parser, mapping to capture shape stamped as an old observation (`observedAt: 1`) so live data wins in `mergeTweetRows`. `importedArchiveRow` in `background.js` re-validates every row (ids, media hosts) and drops `userMeta`. UI on the Storage page (preview → import in batches of 250, cancellable → summary). |
| Backups | `backup-crypto.mjs`: `XVENC1` container, PBKDF2-SHA-256 600k, AES-256-GCM 1 MiB frames, AAD = frame index + final flag, header `meta` nested. `archive-recovery-ui.mjs`: `XVaultCreateRecoveryFile({ passphrase })` (Storage page "Create encrypted backup" form, passphrase entered twice, min. 8 characters), `.xvenc` restore with passphrase retry; `xvault:backup-saved` event → last backup in `localStorage['xv-last-backup']`. |
| Storage | `xv-vault.js` → `#page-vault` (System tab group): `navigator.storage.estimate/persisted/persist`, `STORAGE_REPORT` (per-store counts, derived stores, semantic status, adaptive status), cleanup buttons, last backup, import drop zone, engine readout. |
| Downloads | `sw/adaptive-concurrency.mjs`: AIMD governor (halve on throttle-like interrupt reasons, one cut per cooldown, +1 after a clean streak, user setting is the ceiling); `pump()` uses `downloadGovernor.limit()`; status in `DOWNLOAD_QUEUE_STATS.adaptive`; setting `adaptiveDownloads` (default on). |
| Atlas | `vault-insights.mjs`: per-year buckets, mention edges (capped 120k, graph ≤160 edges among top people), reading/organising totals. `xv-atlas.js`: Review tab (year picker, totals, month chart, topic drift, 14 badges, SVG people graph with keyboard focus). |
| Accessibility | `xv-shortcuts.js`: settings `uiHighContrast`, `uiFocusRings`, `uiFontScale`, `readerFontSize`, `shortcutOverrides` (remap by translating keys in the capture phase; sheet repaints effective keys). `scripts/e2e-a11y.mjs` also audits Storage, Atlas Review, board manager, rules dialog and a keyboard-only bulk edit (`x`, `j`, `x`, `e`). |
| Builds | `scripts/manifest-targets.mjs` + `scripts/build.mjs --target=chrome|edge|firefox|all` (`npm run build:all`); staging zips without directory entries. |
| Bench | `scripts/bench.mjs` (`npm run bench [-- --sizes=…]`): synthetic Zipf/topic vaults; numbers in CHANGELOG. |

### Decisions (v20)

- **Meaning search without a model.** A neural embedding model would add tens of MB and a WASM runtime for modest
  gains on tweet-length text; Random Indexing learns this vault's vocabulary in seconds, is deterministic, fully
  local and rebuildable. It is weaker on words the archive barely uses, so unknown-only queries need a higher score.
- **Organisation-only automation.** Rules and bulk edits only touch `userMeta`; every bulk write first snapshots the
  previous `userMeta` so undo is exact, and re-applying a rule changes nothing.
- **Imported posts never overwrite live captures.** X archive rows are older observations with less data (no
  metrics, short author info); `mergeTweetRows` keeps live fields and only fills gaps.
- **Encrypted backups wrap, not replace, recovery files.** The plaintext is the normal JSON Lines recovery file, so
  restore reuses the existing validation and conflict review. Frame AAD makes truncation detectable.
- **Firefox is experimental.** It is built from the same source with a manifest transform; no Firefox-specific code
  paths exist yet, and nothing was run in Firefox.

### Verification log (v20)

- `npm run verify`: integrity OK, ESLint 0 errors (10 pre-existing warnings), 108/108 tests, Prettier clean.
- `npm run e2e` (Chromium via `CHROMIUM_PATH`): every page at four viewports without console errors; seeded Library
  filters + exports 9/9. `npm run e2e:a11y`: 24 audited surfaces, 0 violations.
- Local Playwright smoke (not committed): 53 checks — meaning search, Reader later/highlights, new filters, boards,
  bulk edit + undo, rules preview/apply/idempotence, Table, Storage report, X archive import of a synthetic ZIP (600
  tweets + 40 likes; live data wins; invalid rows skipped), encrypted backup download/header/wrong passphrase/restore
  preview, Year in Review + people graph, adaptive readout, shortcut sheet, remapping, high contrast.
- `npm run build:all`: Chrome, Edge and Firefox zips (162 files each).
- **Not verified:** live X capture with the new features, an archive ZIP issued by X (the reader follows the
  documented `window.YTD` layout; tests use synthetic ZIPs), loading the Firefox build in Firefox, Edge Add-ons
  store submission, adaptive back-off against real X throttling, screen readers.

### Remaining after v20

1. Keep moving legacy message types from the `background.js` switch into routed services (queue, capture, library
   API, remote), one commit per move with behavioural tests.
2. Firefox: run the build in Firefox, replace `chrome.offscreen` OCR with a worker-based path, decide on Remote.
3. Meaning search: optional multilingual handling (per-language vocabularies) and incremental context-vector
   retraining instead of periodic rebuilds.
4. Real X archive fixtures (anonymised) for the importer, including `community-tweet.js` and `note-tweet.js`.
5. Year in Review export (image/HTML) and a reply/quote graph alongside mentions.
6. Remaining items from v19: delete superseded `dashboard.js` code, more behavioural tests, OCR languages.

## v19 "Horizon" pass

Branch: `xvault-19-horizon` (from `main` @ 4dba980, the v18 merge). Version 19.0.0. Goal: implement the remaining
roadmap (v18 follow-ups + "Next milestones" below).

| Area | Change |
| --- | --- |
| Background jobs | `sw/derived-store.mjs` (IndexedDB `xvault-derived` v2: `phash`, `ocr` with `postId` index, `meta`), `sw/image-hash.mjs` (dHash compatible with v18 + DCT pHash), `sw/derived-jobs.mjs` (checkpointed runner, alarm `xv-derived-resume`, BroadcastChannel `xvault-derived-jobs`, 429/5xx backoff, unavailable rows, retry cap), `sw/derived-service.mjs` (`DERIVED_JOB_STATUS/START/PAUSE/CANCEL`, `DERIVED_CLEAR`, `OCR_TEXT_FOR_POSTS`, `DERIVED_SUMMARY`). The Duplicate Lab drives the worker job and groups cached fingerprints. |
| OCR | `offscreen-ocr.html/js` hosts tesseract.js 7 (vendored by `scripts/vendor-ocr.mjs` into ignored `vendor/ocr/`), `sw/ocr.mjs` (offscreen lifecycle, medium renditions, index). Search: `ocr:`, `image-text:`, `has:ocr` (`library-search-core.js` `ocrText` projection; the worker joins OCR text only for those queries and includes the OCR revision in the query identity). UI: Settings → Library `#g-ocr` (`xv-background-jobs.js`). |
| Sync | `sw/sync-scheduler.mjs`: alarm `xv-sync-tick` (5 min), background tab on `/i/history` (bookmarks) or `/i/history/likes`, `XV_SMART_START` with `scheduled:true` and `maxPages`, run timeout, failure backoff, notifications for watched Smart Collections; `SYNC_STATUS/RUN_NOW/PAUSE/RESUME/STOP`. `content.js` scheduled runs skip checkpoints, fallback scroll, verification and toasts. Settings → X.com `#g-sync`. |
| Exports | `library-exporters.mjs`: thread grouping (`threadGroups`, `buildThread` via `orderThread`), Markdown note per thread + index, single-file HTML. Buttons `#exportThreadsMarkdown` / `#exportThreadsHtml`. |
| Atlas | `calendarTimeZone` setting (`'local'`/`'utc'`) used by insights (`dayKeyIn`, streaks) and search (`setCalendarTimeZone`); insights persisted in `xvault-derived/meta` and served stale-while-revalidate (`INSIGHTS_READY` on `xvault-insights`); People grid windowed with an IntersectionObserver. |
| Reader | Inline note editor (`UPDATE_TWEET_META` with `expectedNote`), `FETCH_MISSING_POST` (`sw/missing-posts.mjs`, user-initiated only), position indicator, more keys, HTML save, phone CSS. |
| Search assist | `search-ranking.js` (usage map in `localStorage['xv-search-usage']`, decayed frequency × recency), contextual help row, groups, OCR keys, `Ctrl+Space`, paging keys, time-zone-aware dates. |
| Architecture | `dashboard-hooks.js`: `XVaultDashboard.before/after/provide/commands`. `dashboard.js` routes `page, sync, apply, queueStats, loadLib, renderLib, tokenMatch, renderLightbox, openPalette` through `invoke()`; no script reassigns those functions any more. `XVaultExtraCommands` is now an aggregate of registered sources. |
| Accessibility | `scripts/e2e-a11y.mjs` (`npm run e2e:a11y`, CI e2e job): axe-core on all pages and dialogs; currently 0 violations of any impact. |
| Release | `.github/workflows/release.yml` on `v*` tags (version check, verify, Python tests, build, zip check, SHA-256, `gh release`). |

### Decisions (v19)

- **Derived data is a cache.** Fingerprints and OCR text live in `xvault-derived`, never in the archive DB or in
  recovery/export files, so they cannot corrupt an archive and can be cleared or rebuilt.
- **OCR ships with the extension** (no runtime model download): predictable, offline, nothing leaves the device. The
  cost is ~8 MB in the zip (15 MB unpacked) and `'wasm-unsafe-eval'` in the extension CSP (no remote code).
- **Scheduled sync is conservative:** off by default, only with a signed-in x.com tab available, newest pages only,
  long intervals, backoff on errors; it reuses the existing collector instead of a new X client.
- **Calendar time zone defaults to UTC** so v18 behaviour, saved searches and counts are unchanged until the user opts
  into local time.
- **Hooks over reassignment:** one provider per replaced function, any number of observers; providers receive the
  built-in implementation, so the superseded code in `dashboard.js` stays reachable where the workspace still uses it.

### Verification log (v19)

- `npm run verify`: integrity OK, ESLint 0 errors (10 pre-existing warnings), 99/99 tests, Prettier clean.
- `npm run e2e` (Chromium 153 via `CHROMIUM_PATH`): every page at four viewports without console errors; seeded
  Library filters + exports 9/9. `npm run e2e:a11y`: 0 axe violations; focus ring, Reader focus return and reduced
  motion checks pass.
- Local Playwright smoke (not committed): 42 checks across Atlas, background Duplicate Lab scan, Reader, search
  suggestions (help row, `has:ocr`, `Ctrl+Space`, usage memory), `thread:` filter, phone/tablet overflow. OCR verified
  inside the extension on a generated image ("Hello XVault OCR", confidence 93) and through the job messages.
- **Not verified:** scheduled sync against live X (no account in the sandbox), real X CDN images for OCR/pHash at
  scale, notifications on a desktop OS, screen-reader sessions.

### Remaining after v19

1. Split `background.js` (~6.5k lines) further: the message switch into a handler map/router and queue/capture/remote
   modules. v19 added new features as `sw/` modules but did not move existing code.
2. Delete the parts of `dashboard.js` that providers fully replace (`builtinLoadLib`) once nothing calls them.
3. Convert more structural source-text tests (`tests/library-performance.test.mjs` has ~100 regex assertions) into
   behavioral tests; v19 added behavioral tests for all new modules only.
4. Incremental insights: true per-record deltas instead of stale-while-revalidate full recomputes.
5. OCR languages beyond English (ship or opt-in additional `traineddata`), OCR of video thumbnails.
6. Keyboard-only Library walkthrough test; screen-reader pass (NVDA/VoiceOver).

## v18 "Atlas" pass

Branch: `xvault-18-atlas` (from `main` @ 424b2fb, "Publish current XVault v17.0.0 source"). Version 18.0.0.

| Area | Change |
| --- | --- |
| Capture | Parser records `quotedPostId`, `retweetedPostId`, `replyToHandle` and expanded `links`/`hashtags`/`mentions` (note-tweet entities included). `message-boundary.mjs` validates them (digit ids, http(s) links, bounded arrays). Recapture adds structural fields to older rows without touching archived text. |
| Search | `on:`/`year:`/`within:` (+ `archived-*`), `#tag`, `@user`, `domain:`/`site:`, `is:reply\|quote\|repost\|thread\|original\|media\|text\|favorite\|sensitive`, `lang:`, `media:>N`, `thread:ID`, `quotes:ID` in `library-search-core.js`. `xv-search-assist.js` adds an ARIA combobox with key/value/date/recent suggestions. |
| Insights | `vault-insights.mjs` is pure: one streaming accumulator → totals, UTC day/month series, streaks, rhythm, people, languages, hashtags, mentions, domains, sources, tags, media mix, relationships, shared media ids, top-liked, on-this-day; plus `orderThread`, `readerPost`, `threadMarkdown`. |
| Worker | Schema 16: `tweets.conversationId` index. Messages: `GET_VAULT_INSIGHTS` (cache key = library revision + row count, 15 min TTL, `force` to recompute), `GET_THREAD` (ancestors via `replyToId`, conversation members via the new index, quoted posts), `GET_AUTHOR_DETAIL`, `GET_MEDIA_FINGERPRINT_PAGE`. |
| Atlas | `xv-atlas.js`/`.css`, page `#page-atlas`: Overview, Calendar, People, Duplicate Lab. Look-alike scan: 64-bit dHash of `name=thumb` renditions in the dashboard, cached in IndexedDB `xvault-derived`/`phash`, 4 concurrent fetches, BK-tree clustering with a Hamming threshold slider. |
| Reader | `xv-reader.js`/`.css`: `window.XVaultReader.open(id)`; spine vs. replies, media, quoted cards with back stack, Markdown copy/save, keyboard map; entry points in the drawer, `t`, Quick Look and Atlas. |
| Motion | `xv-motion.js` 2.0 (spring easing via CSS `linear()`, interruptible `play`, `flip`, `stagger`, `countUp`, `transition`) + `xv-motion.css`. Preference gates unchanged. |
| Tests | `tests/source-text.mjs` gives structural tests compact/collapsed source views (the source was Prettier-formatted after those tests were written); `tests/vault-insights.test.mjs`. `npm test` 75/75. |
| Tooling | ESLint models page globals for browser-driven harnesses (`tests/*-browser.mjs`, `*-ui.mjs`, `library-profile.mjs`) and Node globals for `tools/`; tests and tools formatted once with Prettier. `npm run verify` exits 0. |

### Decisions (v18)

- **Insights are computed in the worker, rendered in the page.** One cursor pass over `tweets`; the dashboard never
  materializes the archive. The cache is invalidated by the existing library revision counter.
- **Look-alike detection runs in the dashboard**, not the service worker: it needs image decoding (canvas) and must
  stop when the user leaves. Hashes are cached so later scans only fetch new media.
- **Calendar and streaks use UTC days** so counts agree with `on:`/`archived-on:` searches.
- **Atlas, Reader and suggestions are additive modules** loaded after the Library and reached through small globals
  (`XVaultAtlas`, `XVaultReader`, `XVaultInsights`, `XVaultExtraCommands`), so they can be removed without touching
  the Library.

### Verification log (v18)

- `npm run verify` exits 0: integrity OK, ESLint 0 errors (10 pre-existing warnings), 75/75 tests,
  Prettier clean. `python -m unittest discover -s tests/python` 8/8. `npm run e2e` scripts pass against Chromium 153
  (`CHROMIUM_PATH`): dashboard at four viewports with no console errors, seeded Library filters and exports 9/9.
- Local Playwright smoke (not committed): unpacked extension in Chromium 153, 47 synthetic posts through the real
  message API, X image CDN mocked. Atlas overview/growth/calendar keys/people/author sheet, shared-media and
  look-alike groups, Reader spine/replies/Escape and Markdown module load, suggestions, `thread:` filter, `t` and `g t`; no page
  errors. Atlas views and the Reader re-checked at 820px and 390px for horizontal overflow.
- **Not verified:** live X capture of the new fields, real `pbs.twimg.com` thumbnails (CORS/rate limits) for the
  look-alike scan, archives beyond synthetic size, screen readers.

### Next (v18 follow-ups)

1. Run the look-alike scan in an offscreen document so it continues when the dashboard closes.
2. Group threads in Markdown/HTML exports using the Reader's `orderThread`.
3. Scheduled Bookmarks sync / saved-search alerts (`chrome.alarms`) — still not implemented.
4. Axe-core pass over Atlas and the Reader in the e2e job.

## v17 overhaul

Branch: `overhaul/v17` (from `main` @ 21e6d74, "Publish XVault v16.0.0 extension build"). Version 17.0.0.

## State of the codebase (assessment, pass 1)

- ~2.5 MB of hand-written JS with no build step. Before this branch the large files were effectively single-line
  (e.g. `background.js` 1,073 lines / 178 KB, `content.js` 45 lines / 33 KB) — unreviewable diffs.
- Architecture is already reasonably modular in places: pure, testable modules for identity (`download-identity.mjs`),
  reliability state machines (`reliability.mjs`), the message trust boundary (`message-boundary.mjs`), search
  (`library-search-core.js`), recovery files (`archive-recovery.mjs`), Remote paging (`remote-library.mjs`).
- Dashboard pages are classic scripts sharing one global scope; later scripts override earlier globals
  (e.g. `library-workspace.js` replaces `loadLib`). Lint now models this explicitly (see Decisions).
- The author's own tests were excluded by `.gitignore` (`tests/`), so the repository had no tests or CI.
- `XVault.zip` (680 KB release build) was committed alongside the source.

## Completed in this branch

| Area | Change |
| --- | --- |
| Repo hygiene | Removed tracked `XVault.zip`; `.gitignore` now blocks `*.zip`, `dist/`, `*.crx`, `*.pem`, `node_modules/` and no longer hides `tests/`. |
| Tooling | `package.json`, Prettier (all sources formatted, 120 cols), ESLint 9 flat config, `npm run verify`. |
| Lint model | `scripts/script-globals.mjs` parses each classic-script context (dashboard, content scripts, Remote PWA, side panel, export worker) and feeds its real top-level globals to `no-undef`, so cross-file references are checked instead of ignored. 0 errors. |
| Integrity | `scripts/check-extension.mjs`: every manifest file, HTML `<script>/<link>`, ES import, `importScripts`, lazy `loadScript`, `executeScript` file and CSS `url()` must exist; manifest/package versions must match. |
| Packaging | `scripts/build.mjs` → `dist/XVault-<version>.zip` (runtime files only). CI uploads it as the `xvault-extension` artifact. |
| CI | `.github/workflows/ci.yml`: integrity → lint → unit tests → format check → Python compile + tests → build; second job loads the real extension in Chromium and runs the Library/export e2e. |
| Tests | 25 Node tests (search syntax, link transforms, download identity/enqueue policy, message boundary, command matching, exporters) + 8 Python tests (pairing flow, one-time claims, revocation, rate limit, fail-closed registry, Host/Origin checks, byte ranges). |
| E2E | `scripts/e2e-extension.mjs` (MV3 service worker boots, every page at 4 viewports, console/page errors, horizontal overflow, screenshots) and `scripts/e2e-library.mjs` (seeds 60 posts through the real message API, verifies filters/negation/OR, runs HTML + CSV export). |
| Security | GraphQL templates no longer persist `x-csrf-token` (a session credential) to `chrome.storage.local`; existing stored templates are scrubbed at startup; the page hook supplies the live `ct0` token at replay time (also fixes stale-token 403s after X rotates ct0). webRequest template capture now goes through the serialized write queue (previous read-modify-write could lose concurrent updates). |
| Security | CSV export neutralises spreadsheet formula injection (`=`, `+`, `-`, `@`, tab, CR). HTML export escapes all text, allows only `https:` links/media and ships a strict CSP. |
| Security (Remote) | Pairing rate-limit table is bounded under address churn; byte ranges accept ASCII digits only. |
| Search | Negation (`-from:bot`, `-cat`), alternatives (`from:a|b`, `has:video|gif`), URLs searched as text (previously `https://…` was rejected as an unknown filter and matched nothing), `has:note`, `has:tag`, `has:download`, clearer errors for unknown `has:` values. `usesRuleKind()` keeps download-revision invalidation correct for nested rules. Help popover documents the new syntax. |
| Export | New `library-exporters.mjs`: Obsidian-compatible Markdown (one note per post, YAML frontmatter with tags/favorite/metrics/reply/quote ids, index note, OS-safe filenames, literal-text escaping), single-file offline HTML archive with live filter, richer CSV (18 columns incl. tags, favorite, note, media URLs, archivedAt). One streaming pipeline (`streamArchivePosts`) aborts if the archive changes mid-export. Exposed in Library tools and the command palette. |
| Refactors | Folded the three "assign over a function declaration" reliability layers in `background.js` into explicit `*Core` + wrapper functions. Removed dead code (`mediaPreview`, `filterSettings`, `mediaDerivativeStates`, `bulkCopy`, unused imports). Fixed latent `videoTimes` ReferenceError in the legacy `loadLib`. |
| Branding | Manifest name `XVault`, version 17.0.0; page titles no longer hard-code "v16 — Chronicle". |

## Decisions

- **No framework / bundler yet.** The extension loads unbundled files directly; a bundler would add a build step to
  every reload without a measured benefit. Revisit when splitting `background.js` into ES modules (MV3 module SW
  already supports `import`).
- **Format once, then enforce.** The one-time Prettier commit is isolated so `git blame --ignore-rev` can skip it.
- **Templates stay in `storage.local`** (needed across restarts) but without session secrets; the public web bearer
  token is not user-specific.
- **`file:///*` host permission kept**: download verification reads magic bytes of finished files. All other
  permissions were checked for live call sites.
- **Markdown export writes to a user-picked folder** (File System Access) rather than a ZIP, so it can target an
  Obsidian vault directly and re-exports update notes in place.

## Verification log

- `npm run verify` — integrity OK, ESLint 0 errors (4 benign unused-var warnings), 25/25 tests, Prettier clean.
- `python -m unittest discover -s tests/python` — 8/8.
- Real Chromium (system build, headless) with the unpacked extension: service worker boots; dashboard at
  1440/1180/820/390 px and side panel render with no console or page errors and no horizontal overflow;
  seeded Library search + HTML/CSV export e2e 9/9.
- **Not verified here:** authenticated X capture (no X account in the sandbox), real downloads from X CDNs
  (sandbox has no access to X media), the Windows helper/Remote scripts (`.bat`/`.ps1`), Markdown export through a
  real folder picker (needs a user gesture + native dialog).

## Next milestones (from pass 1 — items 2–8 done in v19, see "Remaining after v19")

1. Split `background.js` (6k lines) into modules: `queue/`, `capture/`, `remote/`, `storage-api/`, `messages.mjs`
   router. Start with the message switch (one handler map keyed by type) — it is the main merge-conflict hotspot.
2. Replace dashboard global-override layering (`loadLib = …` in `library-workspace.js`) with one owner per
   function; delete the superseded implementations in `dashboard.js`.
3. Thread/conversation export: group posts by `conversationId`, render threads in Markdown/HTML exports.
4. Perceptual-hash duplicate media detection (dHash on thumbnails) in a worker; "Duplicates" smart view.
5. Local OCR (Tesseract WASM, opt-in download) → `ocr:` search filter; never sends media off-device.
6. Saved-search alerts in Inbox; scheduled Bookmarks sync via `chrome.alarms` when an X tab is open.
7. Accessibility pass with axe-core in the e2e job; keyboard-only Library walkthrough test.
8. GitHub Release workflow on tags (attach `dist/XVault-<version>.zip`).
