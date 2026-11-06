# XVault architecture

How the pieces of XVault fit together, as of 25.0.0 "Vantage". `DESIGN.md` covers the visual system,
`XVAULT_ROADMAP.md` the decisions and verification history, `FFmpeg_Helper/REMOTE_README.md` the phone Remote setup.

XVault is a Chrome MV3 extension with an optional local helper. Everything runs on the user's computer:

```
 x.com tab                      extension                                   local helper (Python)
 ┌───────────────┐   messages   ┌──────────────────────────────┐  native   ┌────────────────────────┐   HTTPS   ┌──────────────┐
 │ content.js     │ ───────────▶ │ background.js (service worker)│ ◀───────▶ │ remote_companion.py    │ ◀───────▶ │ Phone Remote │
 │ page-hook.js   │  CONTENT cap │  router · IndexedDB · pumps   │ messaging │ (pairing, devices, API)│   (LAN)   │ PWA          │
 └───────────────┘              │  sw/*.mjs feature services    │           │ ffmpeg_helper.py       │           └──────────────┘
                                └──────────────┬───────────────┘           └────────────────────────┘
                                   DESKTOP cap │ messages + BroadcastChannels
                                ┌──────────────▼───────────────┐
                                │ dashboard.html (+ side panel) │
                                │ dashboard.js + xv-*.js        │
                                └──────────────────────────────┘
```

## Service worker (`background.js` + `sw/`)

`background.js` owns the archive database, settings, the download pump and the message router. Feature logic that
can be tested on its own lives in `sw/*.mjs` modules that take their dependencies as arguments (`chromeApi`,
`readPost`, `getSettings`, `now`, `sleep` …) so Node tests can drive them without a browser.

| Module                                                 | Owns                                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `sw/router.mjs`                                        | The message router: every message type is a registered route with allowed capabilities |
| `message-boundary.mjs`                                 | Classifies senders (`desktop` vs `content`) and the `CONTENT_ACTIONS` allow-list         |
| `sw/capture-inbox.mjs`                                 | Capture inbox (v25): queue, one reused background X tab, duplicate detection, outcomes   |
| `sw/avatar-archive.mjs`                                | Local author avatars (v25) in the separate `xvault-avatars` database                     |
| `sw/download-policy.mjs`, `sw/adaptive-concurrency.mjs` | Download admission, retry classes and adaptive parallelism                              |
| `sw/sync-scheduler.mjs`, `sw/status-visitor.mjs`       | Scheduled bookmark/likes sync and the polite post visitor                               |
| `sw/semantic*.mjs`, `sw/ocr.mjs`, `sw/derived-*.mjs`   | Local "related posts" index, OCR and the derived-job queue                              |
| `sw/search-insights.mjs`, `vault-insights.mjs`         | Search analytics and Atlas insights (incl. v25 top conversations and most-quoted posts) |
| `sw/link-snapshots.mjs`, `sw/missing-posts.mjs`        | Link previews and the missing-post list                                                 |
| `sw/auto-backup.mjs`, `sw/organize.mjs`, `sw/watch-lists.mjs` | Backups, organiser rules and watch lists                                         |

### Message boundary

X pages are untrusted. `message-boundary.mjs` labels each sender: extension pages get the `desktop` capability,
content scripts on x.com get `content`. Content scripts may only call the types in `CONTENT_ACTIONS` (store records,
queue downloads, read archive indicators, a few UI settings). Everything else — deleting, exporting, settings,
Remote, the capture inbox controls, per-host download pause — is `desktop` only. Unknown types are rejected.

### Storage

- **`xvault-db`** (IndexedDB, owned by `background.js`): `tweets`, `users`, `downloads`, `mediaAssociations`,
  `actions`, `jobs`, `captures`, `checkpoints`, `sessions`, `trash`, `snapshots`, `integrity`, `manifests`,
  `collections`, `conversions`, `revisions`, `archiveRuns`, `libraryPlans`, `archiveImports`. The dashboard never
  opens it directly; it asks the service worker (`QUERY_LIBRARY_PAGE`, `QUERY_LIBRARY_IDS`, `GET_LIBRARY_RECORDS`, …).
- **`xvault-avatars`** (IndexedDB, v25): one `avatars` store of small image blobs (≤ 256 KB each, sniffed as
  PNG/JPEG/GIF/WebP). Separate on purpose: it never forces an archive schema upgrade and can be cleared alone. The
  service worker writes it; the dashboard reads it directly (`xv-avatars.js`); the phone reads it through the
  Companion (`/api/avatar/<handle>` → `avatar.read`).
- **`chrome.storage.local`**: settings (incl. `pausedDownloadHosts`), the capture inbox state, Remote device
  metadata, workspace layouts and small UI state.

### Change notification

Long-lived pages listen on BroadcastChannels instead of polling: `xvault-library-changes`,
`xvault-library-metadata`, `xvault-insights`, `xvault-derived-jobs`, `xvault-capture-inbox` and `xvault-avatars`.

### Downloads

The pump in `background.js` keeps a small in-memory buffer of queued rows and admits them up to the adaptive
concurrency limit. v25 adds **per-host pause**: `pausedDownloadHosts` (sanitised, at most 16 hosts) is read by the
pump and the buffer fill, so queued rows for a paused host stay queued (the buffer parks after two wraps instead of
spinning). `SET_DOWNLOAD_HOST_PAUSED` toggles a host, `RETRY_FAILED {host}` retries one host's failures, and
`queueStats` reports `pausedHosts`/`hostHeld`. Single transfers can be paused, resumed or cancelled by
`downloadId` (only rows XVault started). The Downloads page (`xv-downloads.js`) and Phone Remote use the same calls.

v26 adds a **per-host circuit breaker** (`sw/host-breaker.mjs`). The adaptive governor halves parallelism for the
whole queue on push-back; the breaker parks **one** host that keeps refusing: four throttle/server/network failures
in a row (within a minute) open it for 30 s, doubling per trip to at most 5 min. While open, `hostPaused()` treats
the host like a user-paused one (same buffer filter, same parking), a timer re-scans when it closes, the next file
is a probe (success closes it and forgets the level, failure re-opens it at once), and **Resume / Try now** clears
it. `queueStats().coolingHosts` reports `{host, until, level, trips, reason}`. Failures also get a plain-language
`row.errorHelp` from `explainDownloadError()` (`reliability.mjs`) — the raw Chrome code stays in `row.error`.

### Capture inbox

```
 phone paste / share target ─┐
 Capture page paste ─────────┼─▶ capture.enqueue ─▶ sw/capture-inbox.mjs ─▶ one background tab on x.com/<post>
 Remote outbox (offline) ────┘     (dedupe: archived → "duplicate", already queued → same item)       │
                                                                                                      ▼
            Capture page / phone ◀── xvault-capture-inbox channel / capture.list ◀── content.js STORE_RECORDS
```

The worker only runs while the user has a signed-in x.com tab open, visits one post at a time with a 1.5–3 s gap,
times out a visit after 20 s, and classifies the result (`archived`, `duplicate`, `unavailable`, `failed`). State
is bounded and survives restarts; an interrupted visit goes back to the queue. Nothing is fetched from X directly.

v26: when a post does not arrive, the worker reads what the capture tab shows (`probePage`, the tab's URL and visible
text through `chrome.scripting`) and `classifyCapturePage()` decides: **sign-in wall** → every pending item waits
(`authBlockedAt`, no attempt spent, page loads do not restart it for 2 min, Resume/Retry lifts it); **X limiting
requests** → the whole inbox cools down (`cooldownUntil`, 5 min doubling to 30 min per strike, no attempt spent);
**X error page / did not load** → retry after 20 s, then 90 s (`nextAttemptAt`), failed after 3 attempts with a
specific message. Waits longer than ~25 s are not slept in the worker: `wake(when)` creates the
`xv-capture-inbox` alarm so a sleeping service worker resumes. Each item keeps its last 6 attempts (`log`: time,
outcome, duration, detail), shown on the Capture page; `capture.list` carries `cooldownUntil`/`authBlocked`, and
the Companion forwards `maxAttempts`/`nextAttemptAt` to the phone.

## Dashboard (`dashboard.html`)

`dashboard.js` is the shell that predates the split: routing between pages, settings forms and the legacy
renderers. Feature scripts (`xv-*.js`) extend it through **`dashboard-hooks.js`** —
`XVaultDashboard.before/after/provide(name, …)` and `commands(source)` — instead of reassigning globals, so script
order is not load-bearing and one failing observer cannot break a page.

### Library 5.0

| File                   | Responsibility                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `library-workspace.js` | Query state, paging (in-flow "load more" window), selection, saved views, bulk work, List/Table windowing |
| `library-feed.js`      | The one card renderer for Feed, Cards, Grid and Wall: incremental mounting, keyed refresh, delegated events, media states |
| `xv-library4.js`       | Heading, active-filter chips, filter builder, quoted-post previews from the archive, result motion       |
| `xv-library3.js`       | Library 3.0 tools still in use: undo center, bulk editor, select-by, boards, context menu |
| `xv-avatars.js`        | Synchronous avatar lookup (`blob:` URL, pending, or remote) with in-place swap                         |
| `library-search-core.js`, `search-ranking.js` | Query parsing and ranking shared with the service worker                       |

v26 also adds **`xv-viewer.js`** (the Media Viewer: filmstrip, position, Media facts, Similar in your vault,
cursor-anchored zoom, pan, swipe, keys, preloading; it decorates the lightbox through the `renderLightbox` hook)
and two shared helpers in `library-workspace.js`: `XVaultLightModal(dialog)` (a non-top-layer modal — `show()` +
scrim + focus trap — used by Quick Look because `showModal()` re-styles the whole page) and
`XVaultIdleTask(key, fn, timeout)` (keyed `requestIdleCallback` for facets and other non-urgent work).

Rules that keep it fast at 50,000 posts:

- **One scroller.** `#page-library` is a three-column frame (sidebar · `.lib-main` · Inspector). `.lib-main` is the
  only element that scrolls; `#libraryHead` is sticky inside it. Nothing listens to `window` scroll for the Library.
- **The DOM is a window.** The feed mounts cards in blocks near the viewport and replaces blocks far above with one
  measured spacer; List and Table render only visible rows. Re-running the same query patches cards by
  `data-id`, so images are not reloaded and scroll position survives.
- **Delegation.** `#list` has one listener each for click, change, keydown and error; cards carry `data-*` actions.
- **Media is lazy.** Aspect-ratio boxes reserve space; images decode lazily; video elements are created only when
  the reader presses play; GIFs autoplay only while visible.
- **No forced reflow in hot paths.** Measurements happen in `requestAnimationFrame`; animations restart by cloning,
  not by reading `offsetWidth`. List/Table geometry is cached (`compactGeom`, invalidated by scroll and
  ResizeObservers) so selecting or favouriting does not read layout; the toast measures itself at idle.
- **Non-urgent work waits.** Facets are computed at idle and only while the Library is visible; the Downloads page
  paints only while it is shown; the queue-stats poll skips hidden documents.
- **Places survive.** A layout switch keeps the first visible post in place (measured before the switch); each
  query remembers its scroll anchor, so returning to a search returns to the same post.

### Other pages

Home (`xv-home.js`), Explorer (`explorer.js`), Atlas (`xv-atlas.js` + `thread-map.js`), Media/Downloads
(`xv-downloads.js`, `download-diagnostics.js`), Studio/Forge (`xv-forge*.js`), Settings (`xv-settings.js`,
`settings-studio.js`), Capture (`xv-capture-inbox.js`), Health/Vault (`xv-vault.js`), workspaces
(`workspace-model.js`, `xv-workspaces.js`), command palette (`command-center.js`, `command-match.js`).

### CSS

`xv-app.css` is the only stylesheet the dashboard links. It declares `@layer base, legacy, aurora;` and imports:

- `base` — `xv-aurora-base.css`: element defaults, buttons, fields, menus.
- `legacy` — pre-24 module styles still being retired (`xv-base.css`, `xv-library-panels.css`, `xv-pages.css`, …).
- `aurora` — tokens, shell and every redesigned surface (`xv-aurora.css`, `xv-library5.css`, `xv-aurora-pages.css`).

A later layer wins regardless of specificity, so redesigned surfaces need neither `!important` nor long selectors.
v25 deleted `xv-library.css`, `xv-library3.css`, `xv-aurora-library.css` and `xv-keystone.css`. Because of that
rule, a `legacy` declaration is dead whenever an `aurora` rule with the same selector (and no narrower `@media`)
sets the same property; v26 removed all 213 such declarations (and two rules for classes no code uses), checked
with 83 before/after screenshots that differ only in clock text and loading timing.

## Phone Remote

```
 phone PWA (remote-ui/)  ──HTTPS + device token──▶  remote_companion.py  ──native messaging (com.xvault.remote)──▶  background.js
   remote.js, remote-capture.js                     pairing, devices, permissions,                                   handleRemoteBridgeRequest
   remote-sw.js (shell cache v8)                    request validation, media files                                  → library.*, downloads.*, capture.*, avatar.read
```

- **Pairing and permissions** (`remote_security.py`): a QR/short-code pairing creates a device with permissions
  from `library.read`, `media.read`, `favorite.write`, `tags.write`, `notes.write`, `downloads.manage` and
  `capture.create` (defaults: read-only). Every API route checks the permission it needs before calling the
  extension.
- **Validation in two places.** The Companion validates payload shape (ids, actions, host names limited to
  `pbs.twimg.com`/`video.twimg.com`) and the service worker validates again before acting.
- **Routes** include `/api/library`, `/api/media/…`, `/api/downloads` + `/api/downloads/control`, `/api/capture` +
  `/api/capture/control`, `/api/avatar/<handle>`, `/api/favorite`, `/api/tag`, `/api/note`.
- **Offline.** `remote-sw.js` caches the app shell; captures that cannot be sent wait in a small on-phone outbox.
  Media is never cached by the service worker. v26: losing the computer starts a reconnect loop (2 s doubling to
  30 s while visible, immediately on `online`/wake, countdown in the banner) and coming back fires
  `xvault-remote-reconnected` (the outbox flushes, an empty Library reloads). The outbox is re-read before it is
  written (no link lost to a concurrent flush), syncs across tabs through `storage` events, retries with a 5 s →
  2 min backoff, records `tries`/`lastTry`/`lastError` per link and says when the computer refused one for good.
  Sending is idempotent on the computer (one inbox item per post id). Recent searches (8, this phone only, cleared
  on unpair) live in `xvault.remote.recent-searches.v1`.
- **Share target.** `manifest.webmanifest` registers `/share` so an installed Remote on Android can receive links
  from the X app's share sheet.

## Tests

- `tests/*.test.mjs` — Node unit tests for pure modules (`npm test`).
- `tests/*-browser.mjs`, `scripts/e2e-*.mjs` — Playwright against the real extension or the dashboard with a
  mocked runtime (`npm run e2e`, `npm run e2e:a11y`, `npm run e2e:remote`).
- `tests/python`, `tests/test_*.py` — the helper and Companion (`python -m unittest`).
- `scripts/ui-gallery.mjs` — screenshots of every page, theme and viewport (1920×1080 down to 320×700).
- `npm run verify` — manifest/asset checks, lint, unit tests and the format check CI runs.
