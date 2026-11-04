# XVault

## Product and platform
XVault is a local-first X archive and personal media library delivered as a Chromium MV3 extension, with optional local Python media/Remote companions. It serves a person browsing, preserving, organizing, annotating and recovering their own archive. Remote is mobile web on the local network, not a separate cloud archive.

## Confirmed constraints
Preserve archive evidence, personal metadata, retained drafts and explicit conflict handling. Library and Remote query pages remain cursor-backed and bounded. Download identity and decisions remain centralized. No archive data, notes, credentials or download policy belong in visual workspaces. Motion/accessibility preferences stay global; Off, Reduced, system reduced motion and Safe Mode override presentation choices.

## Product direction supplied by the user
Purpose-built, dense desktop media software and a usable phone companion. Compact X widgets must preserve click-time post ownership and native X controls. Avoid SaaS cards/pills, decorative gradients, glass, glow and oversized headings. Improve actual workflows and validate the rendered product, not just source code.

## Validation boundaries
Fresh-profile Chromium, real IndexedDB, local HTTP downloads and synthetic browser fixtures are available. Logged-in X, the personal browser profile, real FFmpeg outputs and hardware screen readers remain separate, unverified integrations.

## Phone companion workflows - 2026-10-09
Remote now applies desktop saved query definitions through Library → Browse and adds month navigation over post/archive dates. An idle revision banner offers a refresh while preserving the loaded gallery until requested. Install guidance adapts to native browser support; local icon assets and the packaged manifest support installability. Optional Privacy cover is immediate presentation shielding, not a security lock. The actual offline shell includes note-draft recovery and excludes private API/media caching. Inbox mutation, phone Trash/history, offline pins, overlay networks and encrypted collection locks remain future work requiring explicit permission/recovery design.

Save to PC is now an optional granted workflow over captured post IDs and media ranges; it cannot submit arbitrary URLs or force copies. One shared client command feeds gallery/sheet/viewer adapters and the central queue decision system. Save to phone uses an already-local grant with native attachment streaming. Status never calls queued work completed and preserves partial/unknown outcomes. Contact previews, explicit Data Saver and in-place media retry reduce accidental original-file loads. View-specific scroll prevents hidden Library work. Real phone/native-host end-to-end transfer remains outside fixture validation.

## Implemented workflow evidence - 2026-10-08
Portable Remote drafts use explicit local files, versioned bounded import previews, retained conflicting text and baselines, and resumable partial imports after quota failures. Visual workspaces have a native keyboard switcher and an optional startup reference, with globally authoritative motion/accessibility. Save Once creates a durable reference to an owning physical source generation; it does not fabricate another local copy. Unresolved ownership remains explicit. A remaining two-installation race without shared discovery is documented rather than called fixed.

## Reliability and responsiveness evidence - 2026-10-09
Normal download enqueue reads only requested identity keys; Save Once uses a sparse asset index, and optional content-hash matching remains a read-capped scan that refuses uncertain negatives. In a synthetic 10,000-row history, unrelated enqueue reads/materializes zero history rows. A separate real Chromium IndexedDB fixture checked 6,002 rows, cursor paging, 10-row scan limits, cancellation, and stale-write rejection. The Library Clear Search race caused by delayed settings restoration is fixed and passed two consecutive disposable MV3 integration runs. Queue retry/rebuild and conversion-recovery scans remain cursor-paged and memory-bounded but can still require work proportional to the relevant state range; no user-archive performance claim is made.

## Queue totals and Save Once scale - 2026-10-09
Save Once now resolves through the sparse `usableAssetKey` index. Schema 15 stores exact per-state totals beside that checkpoint and updates them in the same IndexedDB transaction as admission, retries/transitions, retained Redownload history and supported deletes. A per-row counter version makes the resumable old-archive backfill idempotent across concurrent changes; queue statistics return an explicit rebuilding state until the cursor completes. Synthetic 50,000-row Chromium evidence across two consecutive runs: normal enqueue read 0 unrelated rows and measured 104–140 ms; Save Once read one matching row and measured 26 ms, down from 26.1 s and 13.4 s when eight range counts ran on each refresh. This is test-fixture evidence only; it is not a real-user archive measurement.
