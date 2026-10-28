$ErrorActionPreference = 'Stop'
foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
  $registryPath = "HKCU:\Software\$browser\NativeMessagingHosts\com.xvault.remote"
  if (Test-Path -LiteralPath $registryPath) { Remove-Item -LiteralPath $registryPath -Force }
}
Write-Host 'XVault Remote was unregistered from Chrome and Edge.' -ForegroundColor Green
Write-Host 'Local archive settings and paired-device records remain in %LOCALAPPDATA%\XVault\RemoteCompanion.'
Write-Host 'Remove that folder manually only if you also want to delete Remote pairing records and the local TLS key.'
