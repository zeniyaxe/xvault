$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Write-Host "XVault FFmpeg Helper setup" -ForegroundColor Cyan
$default = Join-Path $env:USERPROFILE 'Downloads'
$root = Read-Host "Chrome/Edge Downloads folder [$default]"
if ([string]::IsNullOrWhiteSpace($root)) { $root = $default }
$extensionId = (Read-Host 'XVault extension ID (Settings > Remote > Copy extension ID)').Trim()
if ($extensionId -notmatch '^[a-p]{32}$') { throw 'The extension ID must contain 32 letters from a through p.' }
$cfg = @{
  downloads_root = $root
  xvault_folder = 'XVault'
  extension_id = $extensionId
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
