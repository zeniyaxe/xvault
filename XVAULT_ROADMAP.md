# XVault overhaul roadmap

This file is the hand-off document: another session should be able to resume from here.

## v25 "Vantage" pass

Branch: `xvault-25-vantage`, stacked on `xvault-24-aurora` (PR #7, still open and unmerged — this PR targets that
branch so the diff is only v25). Version 25.0.0. Goal: rebuild the Library at the layout level (one scroller, no
covered posts, use the width), retire the Library legacy CSS and the v12 card renderer, Phone Remote 4.0 with real
phone capture, per-host download control, Atlas thread/quote graphs, and measured performance.

| Area | Change |
| --- | --- |
| Library frame | `dashboard.html` `#page-library` is a three-column grid: sidebar (`#libraryDestinations`, collapsible with `\`, sections collapsible and remembered in `librarySideCollapsed`) · `.lib-main#libraryScroll` (**the only vertical scroller of the page**) · Inspector (`#detailsDrawer`, resizable, `inspectorPixels`). The sidebar no longer scrolls on its own axis horizontally; long names truncate with tooltips. |
| Header | `#libraryHead` (`lib5-head`) is sticky inside `.lib-main`: row 1 = sidebar toggle, title/count slot, search with syntax help, layout switch (Feed, Cards, Grid, Wall, List, Table), **View** menu (layout, card style, media fit, feed width, tile size), sort, actions menu; row 2 = filter chips. ~96 px on desktop. On phones the header is one wrapping flow and only its last row (search, or the selection bar while selecting) stays pinned via a negative sticky top (`--lib-pin-offset`). The Keystone strip is folded by default. |
| Pagination | The fixed bottom pager is removed. `renderPaging` draws an in-flow footer (`#libraryPages`): "Showing a–b of n", **Load N more** (optionally automatic, `libraryAutoLoad`), Previous/Next page, Back to top. It is part of the scrolling content, so it cannot cover a post. Window: pages `windowStart..pageIndex` concatenated, at most `MAX_RETAINED` = 1,500 rows, then "continue on the next page". |
| Renderer | `library-feed.js` (new) draws Feed/Cards/Grid/Wall: four card styles (`libraryCardStyle` compact/comfortable/media/detailed), media fit (`libraryMediaFit`), feed width (`libraryFeedWidth`), block mounting (6 rows per block, ≤ 7 blocks mounted, measured spacer above), keyed in-place refresh, one delegated listener set on `#list`, click-to-play video, visible-only GIF playback, sensitive-media veil (`libraryBlurSensitive`), FLIP layout switches. List and Table stay windowed fixed-height rows in `library-workspace.js`. The v12 string renderer and per-card bindings in `dashboard.js` are gone. |
| CSS | `xv-library5.css` (frame, header, every layout, cards, rows; `aurora` layer) and `xv-library-panels.css` (Quick Look, viewer, Inspector content, dialogs, Trash…; `legacy` layer) replace `xv-library.css`, `xv-library3.css`, `xv-aurora-library.css` and `xv-keystone.css` (deleted). Results grid sized by container queries. |
| Avatars | `sw/avatar-archive.mjs`: own IndexedDB `xvault-avatars` (store `avatars`, key = lowercase handle), `pbs.twimg.com/profile_images` only (normalised to `_x96`), magic-byte sniffing, 2 concurrent fetches, refresh after 30 days, retry misses after 12 h. Fed from `STORE_RECORDS`; `xv-avatars.js` (`XVaultAvatarUrl`) serves blob URLs to the Library/Reader and swaps monograms in place; Remote RPC `avatar.read` → `GET /api/avatar/<handle>`. Setting `archiveAvatars` (Settings › Library). |
| Capture inbox | `sw/capture-inbox.mjs`: bounded inbox in `chrome.storage.local` (`xvCaptureInbox`, ≤ 400 items, finished kept 30 days), canonical link parsing (x.com, twitter.com and common mirrors), duplicate detection against the archive and the queue, one polite worker that opens each post in a single reused background tab next to the user's x.com tab and reads the result back; states queued → waiting → capturing → archived / duplicate / unavailable / failed (2 attempts). Desktop panel on the Capture page (`xv-capture-inbox.js`). |
| Remote 4.0 | `remote-capture.js` (new): Capture tab with paste / clipboard / up to 20 links, per-link live state, preview, Show in Library, Retry, Open on X, Remove/Cancel, filters, nav badge, offline **outbox** (`xvault.remote.capture-outbox.v1`, ≤ 50), 429 handling. **Web Share Target** (`manifest.webmanifest` `share_target` → `/share`, served network-first by `remote-sw.js` v8) and a "Capture a post" shortcut. New device permission `capture.create`; `POST /api/capture` (`via` paste/share), `GET /api/capture`, rate-limited. Real avatars on cards. Downloads: **Up next** with Download next (`prioritize`) and Show post, per-transfer Pause/Resume/Cancel (`pause-item`/`resume-item`/`cancel-item`, only for transfers XVault is running), Images/Video host pause (`pause-host`/`resume-host`, limited to `pbs.twimg.com` and `video.twimg.com`). First paint builds 8 tiles, the rest after the first frame; Intl formatters cached. |
| Downloads | Per-host pause: setting `pausedDownloadHosts` (≤ 16 hostnames). The pump skips rows from paused hosts (they stay `queued` in IndexedDB; running transfers finish); the buffer fill skips them and parks after one full pass with nothing runnable, so a large paused queue is not re-scanned in a loop. `SET_DOWNLOAD_HOST_PAUSED`, `RETRY_FAILED {host}`, `queueStats().pausedHosts`. Downloads › **Media hosts** panel with counts from the last 200 rows, the most common failure, Pause/Resume and Retry failed. |
| Atlas | `vault-insights.mjs` counts conversation members/authors and quoted posts (`topConversations`, `topQuoted`); `xv-atlas.js` "Threads and quotes" draws a spine per conversation and a fan per quoted post, hydrated through `GET_LIBRARY_RECORDS`; a quoted post that is not archived links to X. |
| Motion/perf fixes | `xv-motion-plus.js` notices no longer force synchronous layouts (`offsetWidth`) to restart the countdown/entrance; the old notice lifts away measured in the next frame; Library 4 title swap and the undo toast restart a frame later. Pill placement batched. |
| Tooling | `scripts/ui-gallery.mjs` seeds longer threads and repeatedly quoted posts and screenshots Atlas threads; `tests/library-cards-profile.mjs` (600-row card profile), `tests/remote-perf.mjs` (phone first tile), `tests/remote-capture-browser.mjs` (Remote 4.0, run in CI). |

### Decisions (v25)

- **One scroller.** Sticky header, sidebar and Inspector are siblings of the results inside the page grid; only
  `.lib-main` scrolls. That removes the nested scrollbars and makes keyboard, wheel and scroll restoration behave
  the same in every layout.
- **Footer, not overlay.** Paging is content at the end of the list. Large archives get Load more inside a
  bounded window (1,500 rows) and page navigation beyond it, rather than an unbounded infinite scroll that would
  keep thousands of posts alive.
- **Capture goes through the normal capture path.** The phone never talks to X and the extension never fetches
  X's API directly; the inbox opens the post next to the user's own signed-in tab, so what gets archived is
  exactly what a manual visit would archive. Without an x.com tab, items wait.
- **Per-host pause is a filter on the pump, not a second queue.** Rows keep their stored state, so a restart,
  a retry or a resume needs no migration.
- **Avatars live in their own database.** They are a cache, not archive data: separate DB, separate setting, can
  be cleared without touching posts.

### Verification log (v25)

| Check | Result |
| --- | --- |
| `npm run verify` (structure, ESLint, unit tests, Prettier) | pass, 167 unit tests |
| `npm run e2e` (extension + Library e2e) | pass |
| `npm run e2e:a11y` (axe-core) | 0 serious/critical violations |
| `tests/helper-files-browser.mjs`, `tests/auto-backup-browser.mjs` | pass |
| `tests/downloads-page-browser.mjs` (real Chromium downloads) | pass, now including per-host pause/resume against a real local host |
| `npm run e2e:remote` (aurora, product, shell, editor, connection, **capture**) | 6/6 pass |
| `scripts/e2e-firefox.py` (real Firefox 159 + geckodriver 0.37.1, built package) | 22/22 pass; the filter checks now count the rows a query loaded, because the feed mounts only the cards near the viewport |
| Python `tests/python`, `tests/test_*.py` | 22 + 56 pass (`test_remote_companion.py` 30, 6 new: capture parse/grant/projection, rate limit, share route + manifest, avatars, prioritize, item/host controls) |
| `node --test` new units | `tests/capture-inbox.test.mjs`, `tests/avatar-archive.test.mjs`, `tests/vault-insights.test.mjs` (threads/quotes) |
| Screenshots | `scripts/ui-gallery.mjs` at 1920×1080, 1440×900, 1366×768, 1280×720, 1024×768, 768×1024, 390×844, 320×700 for every Library layout and page; Remote 4.0 at 390, 320 and 768 px. Review found and fixed: the phone tab bar pushed System and Settings off-screen at 320 px (now always fits, icons only below 360 px), small Grid tiles clipped the video label against the "+N" badge |

Performance (same sandbox, headless Chromium 1243, same session, medians of 3; `tests/library-profile.mjs` on
50,000 posts, `tests/library-cards-profile.mjs` on a 600-post page, `tests/remote-perf.mjs` at 390×844):

| Measure | v23 | v24 | v25 |
| --- | --- | --- | --- |
| Library first render (50k) | 24.7 ms | 24.3 ms | **9.5 ms** |
| Library usable (50k) | 33.7 ms | 35.0 ms | **17.3 ms** |
| Media elements mounted at start | 37 | 37 | **4** |
| Select 1.5k (right after the page mounts) | 76 ms | 51 ms | 99 ms (slower; steady-state trace 51 vs 45 ms) |
| Quick Look (right after mount) | 91 ms | 87 ms | 129 ms (slower; steady-state trace 99 vs 120 ms) |
| Latest of rapid searches | 231 ms | 275 ms | 268 ms |
| Favorite one post | 145 ms | 177 ms | 156 ms |
| Cards page (600 posts): first render / re-render | 172 / 596 ms | 203 / 656 ms | **14 / 43 ms** |
| Cards page list nodes | 49,660 | 53,113 | **1,505** |
| Phone first tile (60 posts) | 201–219 ms | 254–282 ms | 210–241 ms |
| Dashboard CSS | 267 KB / 46 KB gz | 345 KB / 61 KB gz | 345 KB / 62 KB gz |

The v25 interaction phases measured immediately after the 1,500-row page mounts are slower than v23/v24: the
compact rows now sit in one page scroller with a taller viewport (≈ 15 mounted rows instead of 9) and avatar /
media work for those rows is still in flight. Steady-state traces show select at parity. CSS did not shrink:
the four deleted Library sheets were replaced by `xv-library5.css` + `xv-library-panels.css`, and capture inbox,
hosts and Atlas styles were added; a scan for rules whose classes or ids appear nowhere in the code found only
116 bytes, so the next saving needs the `legacy` modules merged rather than more deletion.

Not verified: live X (capture inbox against a real signed-in x.com tab), the Web Share Target from a real
Android phone (needs the installed PWA over HTTPS with a trusted certificate; iPhone Safari has no share target),
Windows/NTFS and the PowerShell scripts, Firefox Remote Native Messaging on Windows, screen readers (axe only).

### Remaining after v25

1. Merge the remaining `legacy` CSS modules (`xv-base`, `xv-pages`, `xv-settings`, `xv-library-panels`) into the
   design system to cut the stylesheet below v23.
2. Bring select/Quick Look right after a page load back under v24 (defer avatar/media work for rows that just
   mounted; cheaper sticky-header invalidation).
3. Capture inbox: retry with backoff across browser restarts, a per-item "archive media too" choice, and import of
   many links from a text file.
4. Local neural embeddings (the meaning index is still the on-device learned model), multilingual OCR models,
   Firefox Remote, real X archive edge cases, Windows helper verification, screen-reader passes.

## v24 "Aurora" pass

Branch: `xvault-24-aurora` (from `main` after PR #6 was merged). Version 24.0.0. Goal: a real visual and
interaction redesign — one design system, Library 4.0 (first priority), Phone Remote 3.0 (second), every other
page, motion and accessibility — with real backend routes for the new Remote views, before/after screenshots and
real-browser tests. No fake functionality: a control is shown only when the action works.

| Area | Change |
| --- | --- |
| Design system | `xv-app.css` is the single dashboard stylesheet with cascade layers `base` (`xv-aurora-base.css`: element defaults, the button system, fields, switches, menus) → `legacy` (pre-24 modules) → `aurora` (`xv-aurora.css` tokens, shell, overlays, motion; `xv-aurora-library.css`; `xv-aurora-pages.css`). `xv-core.css` is the side-panel subset. Default theme value `graphite` → Aurora palette (ink `#0b0c0f`, iris `#8d7dff`, cyan `#4cc3e8`); the old palette is the new `brass` theme ("Graphite"); `readFont` default `sans`. See `DESIGN.md`. |
| Icons | `scripts/vendor-icons.mjs` (`npm run vendor:icons`) copies Lucide (ISC) into `xv-icon-set.js` and the Remote sprite; `app-icons.js` maps every XVault glyph name onto it. `THIRD_PARTY_NOTICES.md` (root and `remote-ui/`). |
| Behaviour helpers | `xv-aurora.js`: one positioned tooltip (`[data-tip]`, `[title]`, icon-only buttons), accessible names for icon-only buttons from their tooltip, `XVaultUI.busy(button, work)` loading → success/error. `xv-shell.js`: icon rail (`xv-nav` = `rail`/`wide`), page entry along nav order, shortcuts dialog. |
| Library 4.0 | `xv-library4.js`: `l4-head` title/sub from `describeQuery` (destinations, `from:`, `tag:`, `board:`, saved views), filter builder (`<details>` popover; writes search tokens only), removable chips with Clear / Save view, quoted posts hydrated through `GET_LIBRARY_RECORDS`, author/thread/note shortcuts. `xv-aurora-library.css`: cards, gallery, masonry, compact rows, table, timeline avatar column, facets, inspector, floating bulk bar, phone compaction. |
| Pages | `xv-aurora-pages.css`: Home stat tiles, Capture, Downloads, System, Tools, Atlas, Explorer, Studio, Health and Settings on the shared tokens. Side panel (`sidepanel.*`): Lucide action tiles, `role=switch` toggles, status card. Command Center: family icons (`ICON_RULES`/`commandIcon`), fixed `Â·` separator. |
| Remote backend | `background.js`: `remotePostContext` (verified, reply/thread, quoted post from the archive, link card, later, note), RPC `downloads.status`, `downloads.control` (`pause`/`resume`/`retry`), `library.overview`. `remote_companion.py`: `GET /api/downloads`, `GET /api/overview`, `POST /api/downloads/control` (needs the new `downloads.manage` device permission), sanitizers `_post_context`, `_clean_downloads`, `_clean_overview`. |
| Remote 3.0 | `remote.js`/`remote.css`/`index.html`: feed cards (`createCard`), feed/grid toggle (`xvault.remote.layout.v1`), bottom-sheet preview with Share, Downloads view (3 s polling only while visible, controls only with `canManage`), Overview (month bars → `archived-after:`/`archived-before:`, people → `from:`), viewer gestures (swipe, swipe-down ≥ 110 px, double-tap 2.5×, pinch 1–4×, clamped pan, `#viewerZoom`), themes with `theme-color`, skeletons. Service worker cache `xvault-remote-shell-v7`. |
| Tooling | `scripts/ui-gallery.mjs` seeds a mock vault and screenshots every Library layout and page (`--out`, `--only`, `--themes`, `--viewports`). `tests/remote-aurora-browser.mjs`; `npm run e2e:remote` runs all five Remote browser tests and CI runs them. |
| Fixes | Palette separator mojibake; muted text contrast (`#7e8591` → `#868d99`, 4.9:1 on raised); locale-dependent assertion in `tests/library-profile.mjs`. |

### Decisions (v24)

- **Layers instead of a rewrite of every module.** Legacy module CSS still loads, in a lower layer, so the
  redesign is authoritative without `!important` and without breaking pages that were not restyled; each legacy
  file can be retired independently.
- **The stored theme value is kept.** `graphite` users get Aurora automatically; the classic palette moved to a
  new value (`brass`) so nobody's settings need migrating.
- **Icons are vendored, not fetched.** Lucide SVG paths are copied at build time (ISC notice included); the
  extension and the phone app make no icon requests.
- **The filter builder writes search syntax.** It is a view onto the query, not a second filter model, so chips,
  saved views, history and typed queries all stay in sync.
- **Remote shows only what works.** Download controls appear only for devices with `downloads.manage`; avatars are
  monograms because the phone never contacts X; Share uses the Web Share API for post links (capturing new URLs
  from the phone would need a new permission and was not built).
- **Quoted posts come from the archive.** A quote that is not archived says so instead of fetching it.

### Verification log (v24)

| Check | Result |
| --- | --- |
| `npm run verify` (structure, ESLint, unit tests, Prettier) | pass: 154/154 tests |
| `npm run e2e` | pass (Library 24/24) |
| `node scripts/e2e-a11y.mjs` (axe-core) | 28 surfaces, 0 serious/critical violations |
| `npm run e2e:helper`, `npm run e2e:downloads` | pass |
| `npm run e2e:remote` (aurora, product, shell, editor, connection) | 5/5 pass; `tests/remote-installed-browser.mjs` needs a registered native host (fails the same way on `main`) |
| `tests/library-profile.mjs` (50k posts, v23 → v24, 2 runs) | first render 18–18 → 21–27 ms; usable 22–24 → 28–31 ms; select 1.5k 45–68 → 43–50 ms; Quick Look 74–80 → 73–80 ms; rapid searches 222–226 → 246–253 ms |
| Python: `tests/python` and `tests/test_*.py` | 22 + 50 tests pass (2 new companion tests) |
| `npm run build:all` | Chrome, Edge and Firefox zips (199 files each) |
| `web-ext lint` on the Firefox build | 0 errors, 163 warnings |
| `scripts/e2e-firefox.py` (real Firefox) | 22/22 (live x.com skipped) |
| `scripts/ui-gallery.mjs` | before (v23) and after screenshots of every layout and page, desktop → phone |

Payload: dashboard CSS 267 KB (56 KB gzip) → 344 KB (74 KB gzip) while the legacy layer is still loaded; Remote
`remote.css` 6 → 11 KB gzip, `remote.js` 22 → 31 KB gzip.

Not verified: live X, a real X-issued archive, Windows/NTFS and the PowerShell setup scripts, Firefox Remote
Native Messaging on Windows, the Edge store, and screen readers (axe-core only).

### Remaining after v24

1. Retire the `legacy` CSS layer module by module (Library 3 and dashboard leftovers first) to win back the
   payload, and delete superseded `dashboard.js` renderers.
2. Remote: per-item cancel and priority in the Downloads monitor; sharing a new X link from the phone into the
   capture queue (needs a new device permission and a Web Share Target); real avatars from archived media.
3. Screen-reader passes (NVDA, VoiceOver) on Library 4.0 and Remote 3.0.
4. Everything still open from v23: live X, a real X archive, Windows helper/setup, optional neural embeddings,
   per-host download pause, an Atlas thread graph.

## v23 "Lodestar" pass

Branch: `xvault-23-meridian` (stacked on `xvault-22-keystone`, PR #6 targets that branch; the branch name predates
the release name — "Meridian" was already v20). Version 23.0.0. Goal: close the two helper gaps left by v22
(Firefox, double-counted hard links), make interrupted helper work recoverable, and rebuild the Downloads page
around honest numbers and real controls.

| Area | Change |
| --- | --- |
| Helper pairing | `extension_origins(cfg)` reads `extension_id` and `extension_ids`; Chrome IDs (`[a-p]{32}`) → `chrome-extension://`, Firefox UUIDs (braces stripped, lower-cased) → `moz-extension://`. Status 23.0 adds capabilities `usage`, `recover`, `firefox`; start-up logs the paired browsers. `setup_helper.ps1` takes comma-separated IDs; `setup_remote.ps1` accepts a Firefox add-on ID (`name@domain`) and writes `com.xvault.remote.firefox.json` + `HKCU\Software\Mozilla\NativeMessagingHosts`; the uninstaller removes it. |
| Helper recovery | `file_ops.py`: a rename whose target is already the same inode as the source (link done, unlink not) finishes as `resumed`; `recover()` deletes `*.xvault-link` temporaries only when the file has another link (`st_nlink ≥ 2`), before each operation and at start-up. |
| Disk usage | `GET /files/usage` → `disk_usage()`: apparent vs physical bytes keyed by `(dev, ino)`, linked files/names, folder count, bounded (400k files / 20 s, `truncated`). Background `MEDIA_STORAGE` sums records by kind (images/videos/GIFs/other), excludes linked/reclaimed copies from physical totals, and with `measure: true` asks the helper (cached in `helperDiskUsage`). |
| Files & health | `xv-forge.js` panel `#xfDisk`: status pill (running / paired / refused / unreachable from `helperPairing`), capability chips, pairing ID + Copy, refused-pairing snippet for `config.json`, record bars and measured bars with **Measure on disk**. |
| Firefox | `scripts/manifest-targets.mjs` keeps `nativeMessaging` for Firefox (Remote). `scripts/e2e-firefox.py` starts a real helper copy (temp config, port 17843): refuses an unknown UUID, pairs after adding it, measures a hard link (`savedBytes` 4096). `FF_SKIP_HELPER=1` skips. |
| Downloads page | `xv-downloads.js/.css` own the page through `XVaultDashboard.provide('queueStats')` (dashboard.js keeps a minimal fallback that returns the stats; `queueSnapshot` is set by the wrapper). Background: `manualQueuePause` in `storage.local.downloadQueuePause` (awaited by `pump`, beats window/Data Saver holds, the bandwidth sampler skips while paused); `DOWNLOAD_QUEUE_STATS` returns `hold`, `pausedByUser`, `activeRows`. UI: primary Pause/Resume, **More** menu, hold banner, indeterminate progress when sizes are unknown, sparkline of real speed samples, live transfer cards with per-file controls, keyed in-place history with filters/search/Retry/Show in folder/Open source post/Regenerate/Copy reason, Command Center entries. The older `#xvQueueTools` strip is no longer mounted. |
| Fixes | Invented 35 %/8 % progress; probe without timeout (12 s `AbortController`); bandwidth cap resuming a user pause; linked copies double-counted; interrupted move refused forever; duplicate filter/pause strip. |

### Decisions (v23)

- **IDs, not names, pair a browser.** Firefox gives each install a random internal UUID; the helper accepts that
  (it is what the `Origin` header carries) and the dashboard shows it, rather than guessing from the add-on ID.
- **Unknown sizes stay unknown.** When a server sends no length there is no percentage — an indeterminate bar and
  "N so far" are shown, never an estimate dressed as progress.
- **A pause you choose outranks every automatic hold** and is persisted; automatic holds (window, Data Saver)
  still resume on their own.
- **Recovery only removes what is provably a duplicate name.** A leftover `.xvault-link` is deleted only while
  the same inode has another name; otherwise it is left for the user.
- **Disk usage is measured by the helper, not estimated.** The browser only knows per-path sizes; physical usage
  needs inode identity, so the panel shows records and measurement side by side.

### Verification log (v23)

| Check | Result |
| --- | --- |
| `npm run verify` (structure, ESLint, unit tests, Prettier) | pass: 154/154 tests |
| `npm run e2e` | pass (Library 24/24) |
| `node scripts/e2e-a11y.mjs` (axe-core) | 28 surfaces, 0 serious/critical violations (Downloads page included) |
| `npm run e2e:helper` | pass: link + rename + disk usage counts the link once; automatic backups |
| `npm run e2e:downloads` | pass: no invented percentage, live card with Pause/Cancel, filters/search, persistent pause holds new work, resume, retry |
| `scripts/e2e-firefox.py` on the Firefox zip (real Firefox + geckodriver + real helper) | 22/22 (live x.com check skipped unless `FF_LIVE_X=1`) |
| Python: `tests/python` and `tests/test_*.py` | 22 + 48 tests pass |
| `npm run build:all` | Chrome, Edge and Firefox zips (189 files each) |
| `web-ext lint` on the Firefox build | 0 errors, 157 warnings (minified-code and `innerHTML` notices) |

Not verified: live X, a real X-issued archive, the helper and the PowerShell setup scripts on Windows/NTFS,
Firefox Remote Native Messaging on Windows, the Edge store, and screen readers.

### Remaining after v23

1. Live X: capture of polls/cards/notes/tombstones on real payloads, visit and watch queues, badges; a real
   (anonymised) X-issued archive including ZIP media.
2. Windows: run the helper (renames, links, usage on NTFS) and the setup scripts, including Firefox Remote.
3. Optional neural embeddings (opt-in, local model) as a second meaning engine; OCR languages beyond English.
4. Keep replacing structural source tests with behavioural ones and delete superseded `dashboard.js` paths
   (the Downloads history renderer is gone; health/activity renderers are next).
5. Per-host pause and priority (move a file to the front) on the Downloads page.
6. A reply/quote thread graph view in Atlas.

## v22 "Keystone" pass

Branch: `xvault-22-keystone` (from `main` after PR #4 was merged). Version 22.0.0. Goal: run Firefox for real,
finish the helper file operations from the v21 list, make backups automatic, and add date navigation to the
Library — then fix what the new real-browser tests found.

| Area | Change |
| --- | --- |
| Firefox | `scripts/e2e-firefox.py` drives the real Firefox build through geckodriver/Marionette (install add-on, seed, Library, capture message path, downloads to disk, OCR on the event page, automatic backup) and is a CI job. Fixes: `setAccessLevel` guard, `moz-extension:` origin accepted as the dashboard, one owner per tab message (instant-actions returned `null` for messages it does not own, and that reply won). |
| Helper files | `FFmpeg_Helper/file_ops.py`: no-overwrite rename (`os.link` then unlink — fails if the target exists — or `os.rename` after a check where links are unsupported; both paths inside the watched root) and verified hard-link dedupe (same volume, same size and SHA-256 before linking, atomic `os.replace` from a temporary link so the duplicate's path never disappears). Helper 22.0 reports `rename` / `link-duplicates` capabilities. Worker routes `HELPER_RENAME_APPLY` (≤200 per batch, `recordRenames()` updates only confirmed moves) and `DUPLICATE_LINK` (rows get `linkedAt`/`linkedTo`, excluded from later duplicate reports). Pairing uses `POST /bootstrap` (Chromium sends no `Origin` on extension GETs). |
| Automatic backups | `recovery-backup-core.mjs` (`writeRecoveryBackup`, shared with manual export), `offscreen-backup.mjs` (offscreen target `xv-backup`, build/release with leases shared with OCR), `sw/auto-backup.mjs` (hourly alarm, due logic, `Backups/xvault-auto-*.jsonl|.xvenc`, retention that only deletes downloads it logged itself, after checking the download's filename still matches, skip-unchanged via the library revision, passphrase only in `storage.session`, inline builder on Firefox). Storage page panel in `xv-vault.js`. |
| Timeline | `sw/timeline.mjs` (`timelineBuckets`, day ≤ 92 days, week ≤ 2 years, month ≤ 10 years, else year; Monday weeks; UTC or local). Route `LIBRARY_TIMELINE` scans matching posts in 1,000-record pages (cap 400k), cached per revision/zone/field/query. `xv-keystone.js` renders the strip (buttons with labels, roving tabindex, click/drag brush → `after:`/`before:` or `archived-after:`/`archived-before:`). |
| Timeline polish | `xv-keystone.js`: bars morph from their previous heights (FLIP-style `scaleY`), identical recounts are skipped by signature, a zoom stack (`‹ Back`/`Backspace`) restores the previous range and query, drag preview in the summary, axis labels with the peak bucket. `window.XVaultTimeline`. |
| Thread map | `thread-map.js` (`layout`/`svg`; spine lane 0, replies by depth capped at 6, in-conversation quotes as dashed edges, cycles become roots, ≤ 400 nodes, escaped SVG). `xv-reader.js` paints it beside the column (≥ 1100px), marks the current post, jumps on click/keys (switching to *With replies* for hidden replies); `t` toggles, remembered in `localStorage`. |
| Motion & notices | `xv-motion-plus.js/.css`: `toast(message, {tone, action, duration})` with stacking ghosts, ×N repeats, countdown, history (`XVaultNotices`, "Recent notices" in the palette); sliding pill for every `.seg`; lightbox FLIP zoom from the clicked thumbnail; favourite spark burst; scroll-driven section reveals (transform only, so contrast never dips mid-animation). All off in calm motion. |
| asof | `asof:` cards render the text from the newest revision at or before that day and mark "edited later". |
| Atlas | Year in Review `reviewModel()` feeds the page, a canvas PNG card (text only) and a Markdown summary. |
| Fixes | `mergeLibraryCapture` replaced the revision-bump `onsuccess` instead of chaining it, so captures never advanced the library revision; rename planner folder templates escaped `XVault/`; CI never ran the 28 top-level Python tests; ESLint 10 → 0 warnings. |

### Decisions (v22)

- **The helper does file work only inside its watched folder.** Both ends of every rename and both copies of every
  link must resolve inside the helper's root; anything else is refused and reported. Records follow the helper's
  confirmation, never the plan.
- **Hard links, not deletions.** Linking keeps every path the user (or another app) may rely on and still frees the
  space; the helper re-hashes both files, so a stale XVault record cannot link different content.
- **Backups go through the downloads API.** Chrome extensions cannot write arbitrary paths, so automatic backups
  are downloads into `<media folder>/Backups/`; retention removes only downloads the schedule logged itself, and
  only while the browser's record still has the same filename. Media files are not copied — the recovery file is the archive, media stay where they are.
- **Encrypted schedules need the passphrase once per browser session.** It is kept in `storage.session` (memory),
  never on disk; without it the schedule reports "locked" instead of silently writing plaintext.
- **Notices keep `#toast` as the newest element.** Older code and tests read `#toast`; the stack adds ghosts
  beside it instead of replacing it, and `toast(message)` without options behaves as before.
- **Reveals move, they do not fade.** A half-transparent section fails contrast checks (axe flagged two while
  entering), so scroll reveals only translate and scale.
- **Timeline counts on demand.** One worker scan per (query, revision) is cheap enough at 100k posts and keeps the
  numbers exact for any query; a pre-aggregated index was not worth the write cost.

### Verification log (v22)

| Check | Result |
| --- | --- |
| `npm run verify` (structure check, ESLint, unit tests, Prettier) | pass: ESLint 0 errors / 0 warnings, 154/154 tests |
| `npm run e2e` (all pages at 4 viewports, seeded Library incl. timeline and Year in Review exports) | pass (Library 24/24 incl. timeline zoom stack, notices, sliding pill, lightbox zoom, favourite burst, thread map) |
| `node scripts/e2e-a11y.mjs` (axe-core) | 28 surfaces, 0 violations |
| `npm run e2e:helper` (real Chromium downloads + real Python helper; offscreen automatic backups) | pass: 1 copy linked, differing file untouched; 3 renamed, 1 overwrite refused; plaintext + encrypted backups, retention kept 2 |
| `scripts/e2e-firefox.py` on the Firefox zip (Firefox + geckodriver) | 19/19 (live x.com check skipped unless `FF_LIVE_X=1`) |
| Python: `tests/python` and top-level `tests/test_*.py` | 18 + 46 tests pass |
| `npm run build:all` | Chrome, Edge and Firefox zips built (187 files each) |
| `web-ext lint` on the Firefox build | 0 errors, 153 warnings (minified-code and `innerHTML` notices) |

Not verified: live X (capture paths, visit/watch queues, badges, x.com content scripts in Firefox), a real
X-issued archive, the helper on Windows/NTFS (tests ran on Linux ext4), the Edge store, and screen readers.

### Remaining after v22

1. Live X: capture of polls/cards/notes/tombstones on real GraphQL payloads, visit and watch queues, badges; a
   real (anonymised) X-issued archive including ZIP media.
2. Firefox: the helper only accepts `chrome-extension://` origins, so helper features (conversion, renames, links)
   are unavailable there; Remote needs Native Messaging registration for Firefox.
3. Storage statistics count hard-linked copies twice (the browser reports each path's size).
4. Optional neural embeddings (opt-in, local model) as a second meaning engine; OCR languages beyond English.
5. Keep replacing structural source tests with behavioural ones and delete superseded `dashboard.js` paths.
6. A reply/quote thread graph view (Atlas has the mention graph), and timeline zoom (drill from year to day).

## v21 "Forge" pass

Branch: `xvault-21-forge` (from `main` after PRs #1–#3 were merged). Version 21.0.0. Goal: close the v20 gaps, then
capture quality, downloads and search/discovery (the four-part plan), with everything that talks to X or other sites
opt-in.

| Area | Change |
| --- | --- |
| Router | All 115 legacy `if (m.type === …)` blocks became `route(type, handler)` registrations (converted mechanically via the AST, then reviewed). `route()` derives `allow` from `isContentAction(type)` (`message-boundary.mjs`): content-script actions accept `[DESKTOP, CONTENT]`, everything else `[DESKTOP]`. The `onMessage` listener is now authorize → `router.dispatch` → `unknownMessage`. Removed `GET_ALL`, `GET_LIBRARY_ROWS`, `GET_LIBRARY_CHUNK`, `CLEAR_ALL`. `tests/router-migration.test.mjs` checks there is no switch left and every type has a policy. |
| Archive quality | `library-search-core.js` `postQuality()` (score + missing list, `INCOMPLETE_BELOW = 70`). `sw/forge-candidates.mjs` (quality report, repair/gap/check candidates, thread gaps, change summary), `sw/archive-quality-service.mjs` (`QUALITY_*`, `AVAILABILITY_SET`, `REVISIONS_FOR`), `sw/status-visitor.mjs` (one reused background tab, per-kind daily caps, `patchJob` writes onto fresh state, pause/resume/cancel/recover, history of 30). Results are read back from the archive: `lastSeenAt` after the visit = seen, `availability.checkedAt` after the visit = gone. |
| Change tracking | `library-capture.mjs` keeps `revisionCount`/`textRevisionCount`/`lastRevisionAt` and marks live observations available; `library-storage.mjs` `patchLibrarySystemFields` (only system fields) and a one-time `readRevisionCounters` backfill. `revision-diff.js` (LCS word diff with prefix/suffix trimming and a 4M-cell cap, `changedFields`, `timeline`) drives the Reader timeline. |
| Post extras | `x-post-extras.js` (content script + tests): polls, cards (incl. `unified_card`), Spaces, Community Notes, edit control, media alt/duration/aspect, tombstones and focal-post errors (`TweetDetail`/`TweetResultByRestId` only); `validExtras`/`validAvailability` at the boundary; `STORE_AVAILABILITY`. Badges are booleans only (`archive-indicators.mjs`). |
| Watch lists / snapshots | `sw/watch-lists.mjs` (`chrome.alarms`, due lists, daily cap, log). `sw/link-snapshots.mjs` (optional host permission, `credentials: 'omit'`, streamed size cap, skips X hosts, loopback/private/link-local/CGNAT/`.local`/single-label hosts and redirects to them) → `xvault-derived` v3 `snapshots` store. |
| Downloads | `sw/download-policy.mjs`: `pickVariant`/`applyVideoQuality` (+ per-rule quality from `parseVideoQualityRules`, evaluated with the rule matcher), `holdReason` (window, Data Saver, cellular, 2G), `createBandwidthGovernor` (pauses active downloads to keep the average under the cap — `chrome.downloads` cannot throttle), `hostHealth`, `duplicateReport` (+ `DUPLICATE_RECLAIM` via `downloads.removeFile`, `reclaimedAt`), `integrityDue` (alarm, optional re-download). `filename-template.js` (tokens, preview, `planRenames` conflict-safe, in order) + `RENAME_PLAN/RENAME_RECORD`; the dashboard writes `sh`/`ps1` scripts. |
| Import | `x-archive-import.mjs`: `noteFromArchive`/`attachNotes` (±10 min, prefix match, closest first), `deletedFromArchive`, community tweets, `matchMediaFiles` (folder + file-name match against archived media), `zipEntryBlob` (stored entries are Blob slices). `xv-vault.js` saves ZIP media through the download queue with page-owned `blob:` URLs in batches (the tab must stay open). DMs are skipped and counted. |
| Search | New rule kinds `numeric`, `flag`, `contains`, `cluster`, `label(State)`, `availability`, `aspect`, `weekday`, `hour`, `fuzzy`, `asof` range; `queryNeeds()` tells the worker which joins (archived ids, snapshot ids, cluster ids, sort values) to load; `SORT_VALUES` precompute one number per row. `sw/search-insights.mjs`: `SEARCH_SUGGEST` (vocabulary + edit distance), `SAVED_VIEW_ALERTS/VISITED` (ids from `XVaultCollections.normalizeDefinition`), clusters. `xv-search-assist.js` knows every new key/value; `xv-forge-search.js` adds did-you-mean, history/time travel and the blend slider. |
| Meaning | `sw/semantic.mjs` v2 tokenizer: diacritic folding, Cyrillic/Greek transliteration aliases, multilingual stopwords, surface forms for suggestions (`SEMANTIC_VERSION = 2`; v1 indexes are rebuilt on first use); `nearestTerms`. `sw/clusters.mjs`: k-means++ on a sample, mini-batch updates over the int8 vectors, distinctive-word labels, `carryNames` (≥ 0.4 Jaccard). |
| UI | `xv-forge.js` + `xv-forge.css`: Capture › Quality, Downloads › Files & health, Atlas › Topics, capture presets/ETA/run history, filename and video-rule previews. Reader: extras, availability, revision timeline, snapshots. |
| Firefox / CI | `sw/ocr.mjs` `createOcrHost` (offscreen on Chrome/Edge; in-page engine via `offscreen-ocr.js` → `globalThis.XVaultOcrEngine` on a Firefox event page). `manifest-targets` adds `data_collection_permissions`. CI `firefox` job: build + `web-ext lint` (errors fail). `release.yml`: all three zips, `.sha256` + `SHA256SUMS.txt`, notes from CHANGELOG. |

### Decisions (v21)

- **Nothing new talks to X or other sites unless you turn it on.** Repair, gap filling, still-on-X checks, watch
  lists and link snapshots are opt-in or explicit buttons, capped per day, and visit pages in the user's own
  signed-in X tab session instead of calling private APIs. Results are inferred from what normal capture records.
- **Availability needs an explicit signal.** Only tombstones or "No status found"-style errors on the focal post of
  a status page mark a post gone; timeouts, empty timelines and network errors leave it "not shown".
- **Renames are scripts, not moves.** Chrome cannot move or rename finished downloads, so XVault plans the moves
  (never overwriting) and writes a script; records change only after the user confirms they ran it.
- **Bandwidth caps by duty cycling.** `chrome.downloads` cannot throttle, so the governor pauses and resumes active
  downloads to hold the average rate; short bursts above the cap are expected.
- **`asof:` is about the archive, not X.** It filters by when posts were archived and shows the current archived
  copy (revisions are shown in the Reader), so the search is cheap and needs no snapshot store.
- **No neural model yet.** Optional on-device embeddings (item 4.3) were deferred: the size/runtime cost and the
  extension CSP work did not fit this pass; the multilingual Random Indexing upgrade covers part of the need.
- **Router: content actions stay narrow.** The allow-list is derived from the same `isContentAction` the boundary
  already used, so the migration cannot widen what an x.com page can ask for.

### Verification log (v21)

| Check | Result |
| --- | --- |
| `npm run verify` (structure check, ESLint, unit tests, Prettier) | pass: 96 source files, ESLint 0 errors (10 pre-existing warnings), 140/140 tests |
| `npm run e2e` (all pages at 4 viewports, seeded Library) | pass |
| `node scripts/e2e-a11y.mjs` (axe-core) | 28 surfaces, 0 violations (new: Quality, Files, Atlas Topics, Library history menu + blend slider) |
| Local Forge smoke (seeded Library, 49 checks) | pass: extras and edit capture, new filters/sorts, Reader history diff, availability, Quality, Files, rename plan, host health, duplicates, did-you-mean, time travel, history menu, blend slider, alerts, topics, filename and video-rule previews |
| `npm run build:all` | Chrome, Edge and Firefox zips built (177 files each) |
| `web-ext lint` on the Firefox build | 0 errors (warnings are minified-code and `innerHTML` notices) |

Not verified: live X (new capture fields, tombstones, visit and watch queues, badges), a real X-issued archive
(the importer was tested on synthetic archives, including ZIP media), a real Firefox, the Edge store, and screen
readers.

### Remaining after v21

1. Run the experimental Firefox build in a real Firefox (event page OCR, downloads, sidebar) and fix what breaks.
2. Optional neural embeddings (opt-in, local model, off by default) as a second meaning engine.
3. Test the new capture paths against live X: extras on real GraphQL payloads, tombstones, visit and watch queues,
   badges; and the importer on a real (anonymised) X-issued archive, including ZIP media.
4. Keep replacing regex-based source tests with behavioural ones (some structural tests remain by design), and
   delete superseded `dashboard.js` code paths.
5. Hard links for duplicates via the helper (Chrome can only delete the extra copy); renames through the helper
   instead of scripts.
6. Year in Review export and a reply/quote graph; OCR languages.

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
