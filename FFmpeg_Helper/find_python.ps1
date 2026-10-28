# Shared by the setup scripts: find a Python that actually runs.
# The Microsoft Store "python.exe" alias in WindowsApps exists on most PCs but only opens the Store (exit code 49),
# so a candidate is accepted only if it executes and reports Python 3.9 or newer.
function Test-PythonCandidate {
  param([string]$Exe, [string[]]$Prefix = @())
  try {
    $out = & $Exe @Prefix -c "import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)" 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
    $lines = @($out)
    $ver = [version]($lines[0].Trim())
    if ($ver -lt [version]'3.9') { return $null }
    return [pscustomobject]@{ Path = $lines[1].Trim(); Version = $ver }
  } catch { return $null }
}

function Find-RealPython {
  $found = $null
  $py = Get-Command py.exe -ErrorAction SilentlyContinue
  if ($py) { $found = Test-PythonCandidate -Exe $py.Source -Prefix @('-3') }
  if (-not $found) {
    foreach ($cmd in @(Get-Command python.exe, python3.exe -All -ErrorAction SilentlyContinue)) {
      $found = Test-PythonCandidate -Exe $cmd.Source
      if ($found) { break }
    }
  }
  if (-not $found) {
    $roots = @("$env:LOCALAPPDATA\Python", "$env:LOCALAPPDATA\Programs\Python", "$env:ProgramFiles\Python*", "$env:ProgramFiles\Python")
    foreach ($root in $roots) {
      foreach ($exe in @(Get-ChildItem -Path $root -Filter python.exe -Recurse -Depth 2 -ErrorAction SilentlyContinue | Sort-Object FullName -Descending)) {
        $found = Test-PythonCandidate -Exe $exe.FullName
        if ($found) { break }
      }
      if ($found) { break }
    }
  }
  return $found
}

function Get-RealPythonOrThrow {
  $found = Find-RealPython
  if (-not $found) {
    throw "No working Python 3.9+ was found. Windows' built-in 'python.exe' is only a Microsoft Store shortcut. Install Python from https://www.python.org/downloads/ (tick 'Add python.exe to PATH') or run: winget install Python.Python.3.12"
  }
  return $found
}
