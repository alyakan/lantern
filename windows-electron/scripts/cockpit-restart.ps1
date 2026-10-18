# Stop the running dev cockpit (its Electron, the vite dev server and aioncore), then start it again.
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Get-Process electron, aioncore -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "$repo*" -or $_.Path -like "$env:USERPROFILE\cockpit-core\bin*" } |
  Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='bun.exe'" |
  Where-Object { $_.CommandLine -like '*electron-vite*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
& (Join-Path $PSScriptRoot 'cockpit-dev.ps1')
