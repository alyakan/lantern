# Start the cockpit (AionUi fork) in dev mode on Windows.
# The AionCore backend binary lives outside the repo, in $env:USERPROFILE\cockpit-core\bin.
$env:Path = "$env:USERPROFILE\cockpit-core\bin;$env:USERPROFILE\.local\bin;$env:APPDATA\npm;$env:Path"
Set-Location (Join-Path $PSScriptRoot '..')
# Port 9333 (or COCKPIT_CDP_PORT) lets local scripts drive and screenshot the window over CDP (localhost only).
$port = if ($env:COCKPIT_CDP_PORT) { $env:COCKPIT_CDP_PORT } else { '9333' }
bun.cmd run start -- --remoteDebuggingPort $port
