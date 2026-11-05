$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "XVault FFmpeg Helper setup" -ForegroundColor Cyan
$default = Join-Path $env:USERPROFILE 'Downloads'
$root = Read-Host "Chrome/Edge Downloads folder [$default]"
if ([string]::IsNullOrWhiteSpace($root)) { $root = $default }
# XVault 23: Downloads > Files & health shows the pairing ID for each browser. Chrome/Edge: 32 letters a-p.
# Firefox: the profile's internal UUID (8-4-4-4-12 hex). Separate several with commas to pair them all.
$answer = (Read-Host 'Pairing ID(s) from XVault Downloads > Files & health (comma-separated for several browsers)').Trim()
$ids = @($answer -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { $_.Trim().Trim('{}').ToLowerInvariant() })
if (-not $ids.Count) { throw 'Paste at least one pairing ID.' }
foreach ($id in $ids) {
  if ($id -notmatch '^[a-p]{32}$' -and $id -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw "Not a pairing ID: $id" }
}
$extensionId = @($ids | Where-Object { $_ -match '^[a-p]{32}$' } | Select-Object -First 1)[0]
if (-not $extensionId) { $extensionId = '' }
$cfg = @{
  downloads_root = $root
  xvault_folder = 'XVault'
  extension_id = $extensionId
  extension_ids = $ids
  gif_folder = 'GIFs'
  original_folder = 'Originals'
  gif_output_folder = 'GIF'
  webp_output_folder = 'WebP'
  make_gif = $true
  make_webp = $true
  webp_quality = 90
  fps = 20
  max_width = 1280
  poll_seconds = 1.5
  delete_source = $false
}
$cfg | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $here 'config.json')
$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ff) {
  Write-Host "FFmpeg was not found in PATH." -ForegroundColor Yellow
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $ans = Read-Host "Install FFmpeg using winget (Gyan.FFmpeg)? [Y/n]"
    if ($ans -notmatch '^[Nn]') { winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements }
  } else {
    Write-Host "Install FFmpeg, then rerun setup. You can also put ffmpeg.exe inside this FFmpeg_Helper folder." -ForegroundColor Yellow
  }
} else { Write-Host "FFmpeg found: $($ff.Source)" -ForegroundColor Green }
$startup = [Environment]::GetFolderPath('Startup')
$ans = Read-Host "Start XVault FFmpeg Helper automatically with Windows? [Y/n]"
if ($ans -notmatch '^[Nn]') {
  $shortcut = Join-Path $startup 'XVault FFmpeg Helper.cmd'
  "@echo off`r`ncall `"$here\run_helper.bat`"" | Set-Content -Encoding ASCII $shortcut
  Write-Host "Startup entry installed: $shortcut" -ForegroundColor Green
}
& (Join-Path $here 'run_helper.bat')
Write-Host "Done. Originals go to GIFs\Originals; converted copies go to GIFs\GIF and GIFs\WebP." -ForegroundColor Green
