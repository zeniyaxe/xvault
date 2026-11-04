# XVault overhaul roadmap

Branch: `overhaul/v17` (from `main` @ 21e6d74, "Publish XVault v16.0.0 extension build"). Version 17.0.0.
This file is the hand-off document: another session should be able to resume from here.

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

## Next milestones (not yet implemented)

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
