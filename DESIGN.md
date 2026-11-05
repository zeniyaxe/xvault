# XVault design — "Aurora" (24.0)

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
every redesigned surface: `xv-aurora.css`, `xv-aurora-library.css`, `xv-aurora-pages.css`). A later layer wins
whatever the selector specificity, so redesigned surfaces need no `!important`. Inline styles from scripts stay
unlayered. The side panel uses `xv-core.css` (the same layers without the dashboard modules).

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

## Library 4.0 (`xv-library4.js`, `xv-aurora-library.css`)

- **Heading:** names the destination, author, tag, board or saved view; a sub-line describes the active filters
  in words. It swaps with a short fade when the query changes.
- **Filter builder:** a popover (`<details>`) with Media (image / video / GIF), Posted (any, 7 / 30 / 365 days or
  From–Through dates), Author and Tag with suggestions, minimum likes, Status (favourite, note, inbox, later…)
  and Kind (original, reply, quote…). It only writes ordinary search syntax, so everything it does can be typed.
- **Chips:** each filter in the query is a removable chip; **Clear** and **Save view** sit at the end of the row.
- **Cards:** avatar, name, handle, verified badge, date; reply/thread context; text; a 1–4 media grid with
  `+N`; quoted post (hydrated from the archive, or "not archived"); link card; poll; Community Note; your note;
  tags; metrics; actions revealed on hover/focus and always visible on touch. Author, thread and note are
  shortcuts that narrow the search.
- **Layouts:** Cards, Gallery, Masonry, Compact (rows), Table and Timeline (avatar column with day separators)
  share the same card anatomy at different densities. Facets and the inspector use the same section headers.
- **Selection:** a floating bulk bar with count, primary actions and More; selection is visible on the card
  (accent ring + check).

## Phone Remote 3.0 (`FFmpeg_Helper/remote-ui`)

- **Navigation:** bottom bar with Library, Downloads (badge while transfers run), Overview and Settings; a
  compact connection header stays on top.
- **Feed / grid:** feed cards mirror the Library card (monogram avatar — the phone never contacts X); the grid is a
  media contact sheet. The choice persists (`xvault.remote.layout.v1`) and switches inside a view transition.
- **Sheets:** preview, extras and actions open as bottom sheets with a grab handle; Share uses the Web Share API
  and falls back to copying the link.
- **Downloads:** hero status, progress bar, stat tiles, transfers and recent files. Pause / Resume / Retry appear
  only when the device has `downloads.manage`; polling (3 s) runs only while the view is visible.
- **Overview:** stat tiles, 12 month bars and top people that open as searches, recent activity.
- **Viewer:** swipe left/right, swipe down (≥ 110 px) to close, double-tap to 2.5×, pinch 1–4×, clamped pan, a
  zoom button with `aria-pressed`, keys `+`/`-`/`0`.
- **Themes:** Aurora, True black and Paper with a matching `theme-color`; switching themes suppresses transitions.

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
