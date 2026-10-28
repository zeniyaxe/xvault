# Read-only XVault Remote diagnostics. Changes nothing; prints what is missing and the exact next step.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here 'find_python.ps1')
$appRoot = Join-Path $env:LOCALAPPDATA 'XVault\RemoteCompanion'
$port = 18765
$problems = New-Object System.Collections.Generic.List[string]
function Show($ok, $label, $detail) {
  $mark = if ($ok) { '[ OK ]' } else { '[FAIL]' }
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("{0} {1}" -f $mark, $label) -ForegroundColor $color -NoNewline
  if ($detail) { Write-Host "  $detail" -ForegroundColor DarkGray } else { Write-Host '' }
  if (-not $ok) { $problems.Add($label) }
}

Write-Host 'XVault Remote check' -ForegroundColor Cyan
Write-Host ''

$python = Find-RealPython
Show ($null -ne $python) 'Working Python 3.9+' $(if ($python) { "$($python.Version) at $($python.Path)" } else { "Windows' python.exe is only a Store shortcut. Install Python: winget install Python.Python.3.12" })

$ffmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
if (-not $ffmpeg -and (Test-Path -LiteralPath (Join-Path $here 'ffmpeg.exe'))) { $ffmpeg = [pscustomobject]@{ Source = (Join-Path $here 'ffmpeg.exe') } }
Show ($null -ne $ffmpeg) 'FFmpeg (only needed for GIF/WebP conversion)' $(if ($ffmpeg) { $ffmpeg.Source } else { 'winget install Gyan.FFmpeg' })

$exe = Join-Path $appRoot 'xvault_remote_host.exe'
Show (Test-Path -LiteralPath $exe) 'Companion program installed' $exe
Show (Test-Path -LiteralPath (Join-Path $appRoot 'remote-ui\index.html')) 'Phone interface files installed' (Join-Path $appRoot 'remote-ui')

$manifestPath = Join-Path $appRoot 'com.xvault.remote.json'
$allowed = ''
if (Test-Path -LiteralPath $manifestPath) { try { $allowed = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).allowed_origins -join ', ' } catch {} }
Show (Test-Path -LiteralPath $manifestPath) 'Native Messaging manifest' $allowed

foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
  $key = "HKCU:\Software\$browser\NativeMessagingHosts\com.xvault.remote"
  $registered = Test-Path -LiteralPath $key
  $target = if ($registered) { (Get-Item -LiteralPath $key).GetValue('') } else { '' }
  $points = $registered -and ($target -eq $manifestPath)
  if ($browser -eq 'Google\Chrome') { Show $points "Registered for $browser" $(if ($registered -and -not $points) { "points elsewhere: $target" } else { $target }) }
  else { Write-Host ("[ info ] {0}: {1}" -f $browser, $(if ($registered) { 'registered' } else { 'not registered (only needed if you use Edge)' })) -ForegroundColor DarkGray }
}

$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
$lan = $null
if ($route) { $lan = Get-NetIPAddress -InterfaceIndex $route.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1 }
Show ($null -ne $lan) 'Network address phones will use' $(if ($lan) { "$($lan.IPAddress) (interface: $($route.InterfaceAlias))" } else { 'No active network route. Connect to Wi-Fi or Ethernet.' })
if ($route) {
  $profile = Get-NetConnectionProfile -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue
  if ($profile) {
    $isPrivate = $profile.NetworkCategory -ne 'Public'
    Show $isPrivate "Network profile is Private ($($profile.Name))" $(if (-not $isPrivate) { 'Windows blocks incoming phone connections on Public networks. Set it to Private in Settings > Network & internet > Wi-Fi > (your network).' } else { [string]$profile.NetworkCategory })
  }
}

$rule = Get-NetFirewallRule -DisplayName 'XVault Remote (local network)' -ErrorAction SilentlyContinue
Show ($null -ne $rule) 'Firewall rule allows the phone in' $(if ($rule) { "enabled=$($rule.Enabled)" } else { 'Missing. Re-run setup_remote.bat and answer Yes to the firewall question (needs an administrator prompt).' })

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
Write-Host ("[ info ] Remote is {0} on port {1}" -f $(if ($listening) { "running at $($listening.LocalAddress)" } else { 'not running' }), $port) -ForegroundColor DarkGray
if (-not $listening) { Write-Host '         Start it from XVault > Settings > Remote > Start pairing (Chrome must be open with XVault enabled).' -ForegroundColor DarkGray }

Write-Host ''
if ($problems.Count -eq 0) { Write-Host 'Everything needed on this PC is in place.' -ForegroundColor Green }
else { Write-Host ("{0} item(s) need attention. Fix the first [FAIL] line, then run this check again." -f $problems.Count) -ForegroundColor Yellow }
