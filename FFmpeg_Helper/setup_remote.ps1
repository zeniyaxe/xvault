$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot = Join-Path $env:LOCALAPPDATA 'XVault\RemoteCompanion'
. (Join-Path $here 'find_python.ps1')
$knownId = ''
$existingConfig = Join-Path $here 'config.json'
if (Test-Path -LiteralPath $existingConfig) { try { $knownId = [string](Get-Content -LiteralPath $existingConfig -Raw | ConvertFrom-Json).extension_id } catch {} }
$prompt = 'Paste the XVault extension ID from XVault Settings > Remote'
if ($knownId -match '^[a-p]{32}$') { $prompt += " [Enter keeps $knownId]" }
$extensionId = (Read-Host $prompt).Trim()
if (-not $extensionId -and $knownId -match '^[a-p]{32}$') { $extensionId = $knownId }
if ($extensionId -notmatch '^[a-p]{32}$') { throw 'The extension ID must contain 32 letters from a through p.' }

$python = Get-RealPythonOrThrow
Write-Host "Using Python $($python.Version) at $($python.Path)" -ForegroundColor DarkGray
$buildRoot = Join-Path $env:TEMP ('xvault-remote-build-' + [guid]::NewGuid().ToString('N'))
$venvPython = Join-Path $buildRoot 'venv\Scripts\python.exe'
New-Item -ItemType Directory -Force -Path $appRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $appRoot 'remote-ui') | Out-Null

Write-Host 'Preparing the local Companion build...' -ForegroundColor Cyan
& $python.Path -m venv (Join-Path $buildRoot 'venv')
if ($LASTEXITCODE -ne 0) { throw 'Could not create the temporary build environment.' }
& $venvPython -m pip install --disable-pip-version-check --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare pip in the temporary build environment.' }
& $venvPython -m pip install --disable-pip-version-check -r (Join-Path $here 'requirements-remote.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install the build requirements.' }

$uiTarget = Join-Path $appRoot 'remote-ui'
Copy-Item -Path (Join-Path $here 'remote-ui\*') -Destination $uiTarget -Recurse -Force
$configTarget = Join-Path $appRoot 'config.json'
$sourceConfig = Join-Path $here 'config.json'
if (-not (Test-Path -LiteralPath $configTarget)) {
  if (Test-Path -LiteralPath $sourceConfig) {
    Copy-Item -LiteralPath $sourceConfig -Destination $configTarget
  } else {
    $config = @{ downloads_root = (Join-Path $env:USERPROFILE 'Downloads'); xvault_folder = 'XVault'; gif_folder = 'GIFs'; original_folder = 'Originals'; gif_output_folder = 'GIF'; webp_output_folder = 'WebP'; server_port = 17843 }
    $json = $config | ConvertTo-Json
    [System.IO.File]::WriteAllText($configTarget, $json, [System.Text.UTF8Encoding]::new($false))
  }
}
foreach ($configPath in @($sourceConfig, $configTarget)) {
  if (-not (Test-Path -LiteralPath $configPath)) { continue }
  $configValue = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  $configValue | Add-Member -NotePropertyName extension_id -NotePropertyValue $extensionId -Force
  $configJson = $configValue | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($configPath, $configJson, [System.Text.UTF8Encoding]::new($false))
}

$exePath = Join-Path $appRoot 'xvault_remote_host.exe'
& $venvPython -m PyInstaller --noconfirm --clean --onefile --name xvault_remote_host --distpath $appRoot --workpath (Join-Path $buildRoot 'work') --specpath $buildRoot --paths $here --hidden-import remote_security --hidden-import remote_companion --hidden-import xvault_ffmpeg_helper --collect-all cryptography --collect-all PIL (Join-Path $here 'remote_native_host.py')
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exePath)) { throw 'The Native Messaging Companion build failed.' }

$manifestPath = Join-Path $appRoot 'com.xvault.remote.json'
$manifest = [ordered]@{ name = 'com.xvault.remote'; description = 'XVault same-Wi-Fi mobile Companion'; path = $exePath; type = 'stdio'; allowed_origins = @("chrome-extension://$extensionId/") }
$manifestJson = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))
foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
  $registryPath = "HKCU:\Software\$browser\NativeMessagingHosts\com.xvault.remote"
  New-Item -Path $registryPath -Force | Out-Null
  Set-Item -LiteralPath $registryPath -Value $manifestPath
}

Remove-Item -LiteralPath $buildRoot -Recurse -Force

# Windows blocks incoming phone connections unless the Companion is allowed through the firewall.
# This is opt-in, limited to the private local subnet, and needs an administrator prompt.
$answer = Read-Host 'Allow phones on your home Wi-Fi to reach XVault Remote through Windows Firewall? (private network, local subnet only) [Y/n]'
if ($answer -notmatch '^[Nn]') {
  $ruleName = 'XVault Remote (local network)'
  $ruleScript = "Remove-NetFirewallRule -DisplayName '$ruleName' -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Action Allow -Program '$exePath' -Protocol TCP -Profile Private -RemoteAddress LocalSubnet | Out-Null"
  try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdmin) { Invoke-Expression $ruleScript }
    else { Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $ruleScript) }
    if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) { Write-Host 'Firewall rule added for the private local network.' -ForegroundColor Green }
    else { Write-Host 'The firewall rule was not created. Re-run this setup and accept the administrator prompt.' -ForegroundColor Yellow }
  } catch { Write-Host "Could not add the firewall rule: $($_.Exception.Message)" -ForegroundColor Yellow }
}
$activeRoute = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
if ($activeRoute) {
  $netProfile = Get-NetConnectionProfile -InterfaceIndex $activeRoute.InterfaceIndex -ErrorAction SilentlyContinue
  if ($netProfile -and $netProfile.NetworkCategory -eq 'Public') {
    Write-Host ''
    Write-Host "Your current network '$($netProfile.Name)' is set to Public, and Windows blocks incoming phone connections on Public networks." -ForegroundColor Yellow
    Write-Host 'Set it to Private (Settings > Network & internet > Wi-Fi > your network > Network profile type > Private) if this is your own home network.' -ForegroundColor Yellow
  }
}
Write-Host ''
Write-Host 'XVault Remote Companion installed for this Windows user.' -ForegroundColor Green
Write-Host 'Setup is finished. This window can close; Chrome starts the Companion in the background when you choose Start pairing.' -ForegroundColor Cyan
Write-Host 'Reload the XVault extension, open Settings > Remote, and choose Start pairing.'
Write-Host 'The first HTTPS visit uses a local certificate. Compare its fingerprint shown in XVault before continuing in the phone browser.' -ForegroundColor Yellow
Write-Host 'Run check_remote.bat any time to see what is missing (it changes nothing).' -ForegroundColor Cyan
Write-Host 'The Companion only binds to one detected private IPv4 interface and can be stopped from XVault at any time.'
