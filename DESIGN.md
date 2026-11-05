# XVault design — "Aurora" system, "Vantage" Library, "Lumen" viewer (26.0)

Aurora is the design system for every XVault surface: the dashboard, the side panel, the Command Center, the X
integration and the Remote phone app. Media carries colour; the interface carries hierarchy and state. It should
feel calm, fast and precise — a tool for people with very large archives, not a marketing page.

## Principles

1. **One system.** Tokens, buttons, fields, icons and motion are defined once and every page uses them. A new
   surface composes primitives; it does not invent its own button.
2. **Content first.** Posts and media are the loudest thing on screen. Chrome recedes (ink surfaces, hairline
   separators, quiet secondary actions); the accent is reserved for the one primary action and for selection.
3. **Honest state.** Loading, empty, error, paused, held and read-only are designed states with real copy. A
   control that cannot work is hidden or disabled with a reason, never faked.
4. **Readable at every size.** 320 px phones to wide desktops, text scaling and 400 % zoom. Nothing overflows
   horizontally; touch targets are at least 44 px on touch layouts.
5. **Motion explains, then gets out of the way.** Short, interruptible, transform/opacity only, and switched off
   by *Calm motion* or `prefers-reduced-motion`.

## Tokens (`xv-aurora.css`)

The default theme (stored value `graphite`, shown as **Aurora**):

| Token | Value | Use |
| --- | --- | --- |
| `--ground` / `--surface` / `--raised` / `--raised-hi` / `--sunk` | `#0b0c0f` / `#101216` / `#16191e` / `#1d2127` / `#08090b` | page, panels, cards and controls, hover, wells |
| `--line` / `--line-soft` | `#242830` / `#1a1d23` | separators and borders |
| `--text` / `--soft` / `--muted` | `#eceef3` / `#b8bdc8` / `#868d99` | primary, secondary and tertiary text (muted ≥ 4.5:1 on `--raised`) |
| `--accent` / `--accent-ink` / `--accent-2` | `#8d7dff` / `#0c0a1d` / `#4cc3e8` | iris accent, text on accent, cyan glow |
| `--ok` / `--warn` / `--danger` | `#47cf89` / `#f1b44c` / `#ff6b6b` | status |
| `--r-xs … --r-xl`, `--r-pill` | 5, 8, 11, 15, 20 px, pill | radii: chips, controls, cards, sheets, dialogs |
| `--sp-1 … --sp-8` | 4–32 px | spacing scale |
| `--fs-2xs … --fs-3xl` | 10.5–30 px | type scale (interface font: Hanken Grotesk; post text follows it unless a reading font is chosen) |
| `--ease`, `--ease-out`, `--ease-in-out`, `--spring` | curves | all transitions |
| `--t-fast` / `--t-med` / `--t-slow` | 120 / 200 / 340 ms × `--motion-k` | durations (`--motion-k` follows the Motion setting: 0.01 when off/reduced, 0.7–1.5 otherwise) |

Other themes only override palette tokens in `[data-theme]` rules, so they inherit the new structure. **Graphite**
(`brass`) keeps the classic matte-brass palette; Paper, Cloud and the other light themes keep their colours.

## Cascade layers (`xv-app.css`)

The dashboard loads one stylesheet with three layers: `base` (element defaults and primitives,
`xv-aurora-base.css`) → `legacy` (pre-24 module styles, being retired file by file) → `aurora` (tokens, shell and
every redesigned surface: `xv-aurora.css`, `xv-library5.css`, `xv-aurora-pages.css`). A later layer wins
whatever the selector specificity, so redesigned surfaces need no `!important`. Inline styles from scripts stay
unlayered. The side panel uses `xv-core.css` (the same layers without the dashboard modules). In 25.0 the Library
left the legacy layer: `xv-library.css`, `xv-library3.css`, `xv-aurora-library.css` and `xv-keystone.css` were
deleted; what the Library opens on top (Quick Look, viewer, dialogs, Trash) lives in `xv-library-panels.css`.

## Buttons

One system for every `<button>` (`xv-aurora-base.css`):

- **Variants:** default (secondary), `.primary` (one per region), `.quiet` / `.ghost`, `.danger` (and solid
  danger for destructive confirmations), `.xv-icon-btn` (icon only — must have a name), `.xv-split`, `.seg`
  (segmented; a sliding pill marks the choice), `.xv-fab`, `.xv-toolbar`; sizes `.sm`, default 32 px, `.lg`.
- **States:** hover, press (`:active` scale), `:focus-visible` ring, disabled / `aria-disabled`, loading
  (`aria-busy="true"`: the label stays in place, a spinner overlays it — no layout shift), success / error
  (`data-state`). `XVaultUI.busy(button, work)` runs async work and shows loading, then success or error.
- Toggle buttons use `aria-pressed`; on/off settings use a switch (`role="switch"`, `aria-checked`).

## Icons and tooltips

Icons are **Lucide** (ISC licence), vendored by `scripts/vendor-icons.mjs` into `xv-icon-set.js` (dashboard, side
panel, Command Center via `app-icons.js`) and an inline SVG sprite in the Remote page. 24 px grid, 1.75–2 px
stroke, `currentColor`, `aria-hidden="true"` when decorative. No emoji as icons, no runtime requests.

`xv-aurora.js` draws one positioned tooltip for icon-only controls, `[data-tip]` and `[title]` (the native title
is held back so it does not double up). Icon-only buttons without a name get `aria-label` from their tooltip
text; a visible label always stays inside the accessible name.

## Shell

A 76 px **icon rail** (expandable to labels, remembered as `xv-nav`) with a tooltip on every destination, a
glass top bar (search, Command Center, view controls) and page headers with a title, a one-line description and
the page's primary action. Pages enter along the navigation direction.

## Library 5.0 (`library-feed.js`, `library-workspace.js`, `xv-library5.css`)

- **Frame:** sidebar · results · Inspector side by side in one page grid; `.lib-main` is the only scroller. The
  sidebar collapses (`\`), its sections fold and remember, long names truncate with a tooltip; the Inspector is
  optional and resizable and never replaces the results.
- **Header (two rows, ~96 px):** sidebar toggle, title and count, search, layout switch, View menu, sort and
  actions; then the filter chips. Nothing else is permanent: the timeline strip is folded, the filter builder and
  View options are popovers. On phones only the search (or the selection bar) stays pinned.
- **Layouts with a purpose:** Feed (one reading column; Reading 620 px / Wide 760 px / Full), Cards (fluid columns from
  container width), Grid (even tiles), Wall (natural proportions), List (76 px rows) and Table (44 px rows,
  sortable). The View menu sets card style (Compact, Comfortable, Media first, Detailed), media Fill or Whole
  image, feed width and tile size; every choice is remembered.
- **Cards:** flat surfaces with a hairline, not boxes in boxes. Avatar (archived copy or monogram), name,
  handle, verified badge and date on one line; reply/thread context; text; media in an aspect-ratio box (1–4
  grid, `+N`, video poster with a play badge, GIF badge, missing-media and sensitive states); quoted post; link
  card; poll; Community Note; note and tags. Actions appear on hover/focus and are always visible on touch.
- **Selection:** a check on every card, Shift-click ranges, Select loaded / every match; the bulk bar is part of
  the sticky header (on phones it is the pinned row) instead of floating over posts.
- **Paging:** an in-flow footer — status, Load more, Previous/Next page, Back to top. No bar ever overlaps a post.

## Media Viewer (26.0, `xv-viewer.js`, `xv-viewer.css`)

- **Stage first.** The image or video owns the dark stage; chrome is a thin top bar (author · "Post n of N" ·
  "k of K in this post" · kind chip, then Download, Info, Full screen, Shortcuts and Close as 36 px icon buttons
  with tooltips) and a filmstrip at the bottom.
- **Filmstrip:** 56 px thumbnails, ±12 around the current item, a small gap between posts, the current item
  ringed in the accent and centred; "+N" at either end; video and GIF marks on the thumbnail.
- **Info panel:** the existing post details plus **Media facts** (decoded resolution and megapixels, aspect,
  length, variants and best bitrate, what is on disk and the file name, alt text; Download this / All N from post)
  and **Similar in your vault** — up to six square thumbnails of semantically similar posts with media. `I` hides
  the panel and the choice is remembered.
- **Direct manipulation:** Ctrl/⌘ + wheel or pinch zooms at the pointer, drag pans a zoomed image, swipe changes
  media, double-click toggles 1:1. Moving between items slides 28 px with a slight fade (skipped with Calm motion or
  reduced motion). `?` opens a shortcut sheet; `Esc` closes the sheet before the viewer.

## Capture inbox (26.0)

- **One banner for what holds everything:** "X is asking you to sign in…" or "X is limiting requests… (in 4 min).
  Nothing is lost." in a warning tint with **Resume now**; the status pill reads *Sign-in needed* or *Cooling down*.
- **Progress:** a 4 px accent bar for the current batch (finished / finished + pending).
- **Rows:** state chip, author, text or link, then one line of facts — reason, "next try in 1 min", "attempt 1 of 3",
  origin, time — and a folded **Attempt history** (time, outcome, seconds, detail) for unfinished items.

## Downloads and Atlas additions (25.0)

- **Cooling hosts (26.0):** a host whose breaker is open shows "Refusing downloads · waiting 40 s, other hosts
  continue" in the warning colour, sorts to the top and offers **Try now**. Failure reasons are sentences ("The
  disk is full. Free some space, then retry."); the browser's code is in the tooltip and in Copy reason.

- **Media hosts:** one row per source with a label (Images, Video and GIFs, or the host name), facts in one line
  ("Paused · queued files wait · 3 waiting · 120 done"), the most common problem in small text, and Pause/Resume as
  a toggle button (`aria-pressed`). A paused row gets a faint warning tint.
- **Threads and quotes:** a thread is drawn as a spine (one dot per archived post, root larger and in the accent),
  a quoted post as a fan (one spoke per quoting post). Text beside each shape names the post; a post outside the
  archive reads "Not in your archive · open on X".

## Phone Remote 4.0 (`FFmpeg_Helper/remote-ui`)

- **Navigation:** five tabs — Library, Capture, Downloads (badge while transfers run), Overview, Phone — with
  labels that shrink rather than overflow down to 300 px; a compact connection header stays on top.
- **Feed / grid:** feed cards mirror the Library card with the **archived avatar** (fetched once per author per
  session from the computer, monogram until then, none in Data Saver); the grid is a media contact sheet.
- **Capture:** a paste field with a Paste button, one row per link with a state chip (Waiting, Opening, Saved,
  Already archived, Problem), a preview once saved, and 44 px icon actions (Show in Library, Retry, Open on X,
  Remove/Cancel). Filters with counts, Retry problems, Clear finished. Offline links wait in an outbox card with
  Send now. Without the permission the view explains how to allow it.
- **Downloads:** hero status, stat tiles, queue controls, Images / Video host toggles, transfers with Pause/Resume
  and Cancel, Up next with Download next, Recent. Controls only for devices with `downloads.manage`.
- **Connection (26.0):** the offline banner counts down to the next reconnect try ("Trying again in 8 s") or says the
  phone itself is offline; a short "Reconnected to your computer" toast after a real outage. The outbox card shows
  the last try and why it failed. **Recent searches** appear as chips under the focused, empty search box with
  Clear.
- **Sheets, viewer and themes:** as in 3.0 (bottom sheets with Share; swipe, swipe-down, double-tap, pinch; Aurora,
  True black and Paper).

## Motion

View changes slide 14 px along the navigation order; sheets rise from their edge; menus and dialogs rise 10 px and scale from
0.97; the Library heading and chips fade; the selection bar lifts in. Durations come from `--t-*` and curves from
`--ease*` / `--spring`. With *Calm motion* (Motion off/reduced) `--motion-k` drops to 0.01, and with
`prefers-reduced-motion: reduce` animations and view transitions are skipped — state still changes, instantly.

## Accessibility rules

- Contrast: body text ≥ 4.5:1 on every surface it sits on, including `--muted` on `--raised`.
- Every control has a name; icon-only controls have a tooltip and `aria-label`; decorative icons are hidden.
- Focus is always visible (`:focus-visible` ring, never removed); dialogs and sheets are modal `<dialog>`
  elements, so focus stays inside while open and returns to the opener when closed.
- Touch targets ≥ 44 px on touch layouts; no hover-only actions on touch.
- `npm run e2e:a11y` (axe-core, 28 dashboard surfaces) and the Remote browser test's axe audit must report no
  serious or critical issues.

## X integration

The content script uses the same geometry and icon stroke in a compact utility language, with colours derived
from X's light or dark background. It is recognisably XVault and never covers or imitates X's own controls.
