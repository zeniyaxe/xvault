# Changelog

## XVault 18.0.0 "Atlas" - 2026-11-04

- Added **Atlas**, a new page (nav, `g a`, command center) that turns the archive into an explorable overview: animated totals, an archived/posted growth chart (click a point to open that month or day in the Library), media mix, weekly rhythm, people, conversations, sources, languages, your favorites/notes/tags, hashtag and tag clouds, linked sites, mentions, On this day and Most liked.
- Added the Atlas **Calendar**: a UTC year heatmap of archived or posted days with arrow-key navigation, streaks and month totals; Enter opens that day in the Library.
- Added **People**: a searchable, sortable author grid and an author sheet (posts by month, most liked, recently archived, hashtags) with one-click `from:` searches.
- Added the **Duplicate Lab**: posts that share the same media id, plus an opt-in look-alike scan (perceptual dHash of X thumbnails, cached locally, pausable) with Compare, Tag "duplicate" and confirmed Trash actions.
- Added the **thread Reader**: a full-screen reader for archived threads with the author's spine, optional replies, inline media, quoted posts, missing-parent notes, adjustable type, keyboard navigation and Markdown copy/save. Open it from the post drawer, `t` on a focused post or in Quick Look, or from Atlas.
- Added **search suggestions** to the Library search box (filter keys, values from your archive, dates, recent searches) as an accessible combobox.
- Added search filters: `on:`, `year:`, `within:` (plus `archived-` variants), `#hashtag`, `@mention`, `domain:`/`site:`, `is:reply|quote|repost|thread|original|media|text|favorite|sensitive`, `lang:`, `media:>N`, `thread:ID` and `quotes:ID`.
- Capture now records quote, repost and reply relationships and expanded links, hashtags and mentions, validated at the content boundary. Older posts gain these fields on recapture; their archived text is never rewritten.
- Motion system 2.0: spring easing, interruptible animations, FLIP, count-up, a travelling nav mark and same-document view transitions. Off/Reduced motion, the system setting and Safe Mode still disable movement.
- Worker: IndexedDB schema 16 (`conversationId` index) and new `GET_VAULT_INSIGHTS`, `GET_THREAD`, `GET_AUTHOR_DETAIL` and `GET_MEDIA_FINGERPRINT_PAGE` messages.
- Tests: six structural tests that broke when the source was Prettier-formatted now read formatting-agnostic source views; added an insights unit test. `npm test` passes 75/75 locally.
- Smoke-tested by loading the unpacked extension in Chromium with a synthetic 47-post archive and a mocked X image CDN. Live X capture, real CDN thumbnails and large real archives were not exercised.

## Remote connection fixes - 2026-10-24

- Fixed the phone dropping downloaded media when Chrome supplied absolute Windows filenames. Grants accept confined local archive paths while rejecting outside/network paths. Added missing/not-downloaded/permission/Data Saver states and recovery from thumbnail-less tiles; shell cache advances to v6.

- Fixed legitimate dashboard tabs being rejected by the Remote command boundary.
- Fixed idle cleanup retaining a disconnected Native Messaging port, delayed cleanup killing a newer Start request, and retired-port events affecting new commands.
- Added connection checks, setup/reconnect guidance and narrow-screen control wrapping. Clarified that the installer/firewall window can close and Chrome runs Remote in the background.
- Verified the existing installed Companion through disposable Chromium, including HTTPS shell, pairing QR and rapid Stop/Start; added deterministic lifecycle regressions. Physical-phone approval and certificate trust remain separate validation.

## Unreleased development pass - 2026-10-09

- Added one-tap Remote Save to PC with explicit device permission, captured-only bounded/revision-aware ranges, centralized skip-existing, partial/unknown feedback and cancellation of future batches. Added native Save to phone using protected streamed attachments.
- Replaced original-media contact thumbnails with 160px previews and Data Saver fallbacks; added in-place local-file retry with keyboard focus return.
- Fixed Device/Recent scrolling triggering hidden Library queries and sharing its scroll position. Mobile actions now keep stable 44px hit areas while icons animate, with corrected narrow author/action layout.
- Added Remote's Browse sheet with bounded desktop saved views, searchable definitions, posted/archive month filters and explicit idle-update refresh.
- Added home-screen install guidance, a single-use native prompt adapter, local PNG install icons and an optional opaque privacy cover that pauses playback and retains drafts.
- Fixed the service-worker shell omitting draft recovery, and the ZIP builder omitting `.webmanifest`; real Chromium offline-shell and package-dependency tests cover both regressions.
- Rendered new Remote surfaces at 320/390/768/1440 and in Graphite, True Black and Paper. New sheets use opaque interruptible spatial entry; Off/Reduced/system motion remain authoritative. Physical-phone installation/TLS and OS snapshot behavior remain unverified.
- Fixed a Library search restoration race: a delayed settings sync can no longer put a stale remembered query back after Clear Search. Search rendering and saved-query persistence now have independent debounce timers.
- Added a sparse canonical-asset index for Save Once; exact same-post identity remains a direct key read, while optional content-hash matching stays an explicitly bounded scan.
- Replaced eight repeated queue-history index counts per refresh with transactionally updated checkpoint totals. Schema 15 backfills existing counters and asset keys in resumable cursor pages; status stays explicitly unavailable until the migration completes.
- Measured a synthetic 50,000-row Chromium history across two consecutive queue-suite runs: normal enqueue moved from 26.1 s to 104–140 ms; indexed Save Once moved from 13.4 s to 26 ms. The tests observed zero unrelated reads for normal enqueue and one matching index row for Save Once.
- Made IndexedDB asset/hash scans reject safely if their cancellation predicate throws; added real Chromium regressions for cancellation, budget limits and stale conditional writes.
- Fixed the 50k browser fixture to settle its own request before reusing the worker for API-stubbed cross-post checks. Added state-counter assertions for backfill, transitions, retained Redownload history, deletion, verified cleanup and clear.
- Improved blocked-check feedback and inspected Downloads diagnostics at desktop and 390px widths. Fresh MV3 integration now asserts that exact queue totals come from one checkpoint read and issue zero index-count queries. See CONTINUE.md for validation boundaries.
- Rebuilt the final `XVault.zip`: all 114 packaged runtime/document entries byte-match source with no missing or extra files, including the Remote install manifest and shared download planner. Live X, personal Chrome and real FFmpeg remain unverified.

## Unreleased development pass - 2026-10-08

- Reproduced cross-installation and lost-history download duplication; added guarded refusal, bounded browser preflight and atomic canonical admission. A no-marker cross-copy race remains explicitly unresolved.
- Fixed retired-attempt reinsertion during delayed Chrome ID binding, canonical bulk downloaded counts, and same-post X widget rerender/late-media/quote ownership.
- Added generation-pinned shared-file associations with atomic retained-history remapping and targeted synchronization.
- Added portable Remote draft selection/export/import with version/fingerprint bounds, legacy support, retained conflicts, stale previews and quota recovery.
- Added the workspace quick switcher/startup selection, fuzzy Command Center search and high-scale dialog fixes.
- Fixed missing converted originals, labeled older derivative generations, and exported actual physical file names.
- Expanded disposable Chromium/IndexedDB tests and rebuilt the verified local ZIP. See the authoritative continuation for negative tests and validation boundaries.

## Recovery and editing — 2026-10-05

- Added a paged Trash workbench with keyboard browsing, selection/restore, conflict comparison, individual full-record JSON export, and a narrow-window layout.
- Persisted Undo atomically with Trash changes; restored recovery state after reload and protected its private checkpoint from X content scripts.
- Made selected restore and Undo update records/download state incrementally instead of rereading the whole Library.
- Rebuilt Inspector note saves with retained per-editor drafts, serialized pending edits, atomic cross-window comparisons, explicit conflict choices, and Ctrl+Enter saving.
- Made desktop/Remote metadata writes transactional and preserved current personal metadata during capture writes.
- Added annotation-content and phrase search; invalid download/missing filters now fail safely with an explanation.
- Fixed post-download loading feedback and false-success messages for rejected queue requests.
- Added real MV3 recovery/editing tests and expanded IndexedDB, search, and message-boundary coverage. See CONTINUE.md for current validation and remaining work.

## Unreleased source — interface and workflow redesign

- Rebuilt the dashboard visual system ("light table"): local Hanken Grotesk + Newsreader fonts, one brass accent, matte neutral grounds, small radii, no glass/glow/tilt/ripple. Old CSS (`dashboard.css`, `library-workspace.css`, island/workspace/remote/settings-studio CSS) replaced by `xv-base.css`, `xv-library.css`, `xv-pages.css`, `xv-settings.css`.
- New navigation: Library (landing page), Explore, Capture (Overview · New archive · Runs), Downloads, Tools, System (Health · Integrity · Activity), Settings. Collapsible rail, `g`-then-key shortcuts, `?` shortcut sheet.
- Library: five layouts (Timeline, Cards, Grid, Wall with deterministic row-span masonry, List), tile-size slider, hover-revealed actions, faceted sidebar (collections, sources, authors, tags, saved searches) and combinable filter chips, floating selection bar, redesigned Quick Look, inspector with tag editing and autosaved notes.
- New **Inbox + review** workflow: new captures wait in an Inbox (`inbox:true`); Quick Look keys R keep, F favorite, Delete trash (undoable). Settings can reset the Inbox cut-off.
- Settings reorganised into searchable sections (row-level search); duplicate and no-longer-functional controls removed; download rules/folders moved out of the Downloads page.
- Fixed: lightbox fitted images against a hidden container; layout switch rendered one step late; app-icons rescanned the whole document on every mutation.
- Tests: new `tests/library-review-browser.mjs`; destination/search/performance tests updated.

## Unreleased source — 2026-10-05

- Added windowed Compact Library and native keyboard Quick Look with provenance, media cleanup, focus return, and failed-preview recovery.
- Added shared date/untagged/known-size query semantics, invalid-filter feedback, streamed search indexing, work-budget cancellation, and incremental metadata index patches.
- Made bulk metadata/Trash/restore bounded and atomic; restore preserves newer records and reports conflicts.
- Added content-script capability/payload validation, trusted-only storage, projected live settings, and a validated capture-template gateway.
- Fixed repeated settings migrations and concurrent preference overwrites while retaining intentional page sizes.
- Refined Library tools/saved views, modal and editing focus, motion preferences, planner race/empty-plan guards, keyboard media menus, true original-URL copying, command loading, and custom SVG/PNG icons.
- Added real-browser IndexedDB, 50k UI/interaction profiling, workflow, and isolated MV3 capture/restart regression coverage. See CONTINUE.md for evidence and remaining scope.

## v16.0.0 — Chronicle

- Added canonical FixVX-default X post-link transformation and nine local transformation tests.
- Added toggleable Copy Link, keyboard-navigable Power Menu, optional safe cleanup module, and migrated X.com integration settings.
- Added Motion Studio settings and shared motion behavior for dashboard/X.com surfaces.
- Added post-download metadata and optional magic-byte verification with zero-byte recovery.
- Added alarm-backed retry scheduling, startup queue reconciliation, and verification-gated completed-file cleanup.
- Added active-tab stale CDN URL refresh, late archive-run diff settling, bounded tweet provenance, daily profile snapshots, and persisted helper conversion state.

## v15.0.0 — Chronicle

- Added schema-7 non-destructive archival history: per-run baselines, diffs, and content/media revisions.
- Added Explore with Time Machine, a local spatial Media Map, and a conservative availability signal.
- Preserved the v14 queue, FFmpeg bridge, integrity tools, and existing IndexedDB records without destructive migration.
