# XVault mark

`xvault-mark.svg` is the editable source for the app and extension icon. Three archive drawers form the silhouette, an X is cut through them, and a small brass index identifies the lower drawer. The geometry is hand-authored locally; no remote font, generated bitmap, or third-party icon asset is required.

Chrome uses the checked-in 16, 32, 48, and 128 pixel PNGs. Reproduce them with:

```powershell
node tools/render-app-icons.mjs $playwrightPackage $chromiumExe
```

The two arguments point to an installed Playwright package and Chromium executable. They are development tools, not extension dependencies. Dashboard navigation, record actions, and media metrics share the local 24-unit stroke system in `app-icons.js`.
