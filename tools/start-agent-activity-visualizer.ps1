[CmdletBinding()]
param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$toolsEnabledRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Join-Path (Split-Path -Parent $toolsEnabledRoot) 'AgentActivityVisualizer'
$node = 'C:\Program Files\nodejs\node.exe'
$registryHelper = Join-Path $toolsEnabledRoot 'tools\lib\service-registry.ps1'
if (-not (Test-Path -LiteralPath $registryHelper -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $registryHelper
$dashboardService = Get-ServiceRegistryServiceById -Root $toolsEnabledRoot -ServiceId 'dashboard'
if ([string]$dashboardService.resolution -cne 'loopback' -or [string]$dashboardService.transport -cne 'http') {
    throw 'SERVICE_REGISTRY_INVALID'
}
$port = [int]$dashboardService.port
$hostName = '127.0.0.1'
$upstream = 'http://127.0.0.1:3888'

if (-not (Test-Path -LiteralPath $repoRoot -PathType Container)) {
    throw "Agent Activity Visualizer checkout is missing: $repoRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'server\index.js') -PathType Leaf)) {
    throw "Agent Activity Visualizer server is missing: $repoRoot\server\index.js"
}
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    throw "Node executable is missing: $node"
}

$existing = @(Get-NetTCPConnection -LocalAddress $hostName -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($existing[0].OwningProcess)" -ErrorAction SilentlyContinue
    $ownerCommandLine = if ($owner) { [string]$owner.CommandLine } else { '' }
    # UNREADABLE IS NOT UNRELATED. An unelevated Win32_Process read returns an
    # EMPTY CommandLine for a process owned by another session -- every S4U
    # scheduled task -- and reporting that as a foreign process sends the reader
    # hunting something that does not exist.
    if ([string]::IsNullOrWhiteSpace($ownerCommandLine)) {
        throw "Port $port is held by pid $($existing[0].OwningProcess), whose command line this privilege level cannot read (empty -- typical of an S4U scheduled task). Refusing to start a second listener. Re-check elevated to confirm ownership."
    }
    if ($owner -and $owner.ExecutablePath -ieq $node -and $ownerCommandLine -match 'server[\\/]index\.js') {
        if (-not $NoBrowser) { Start-Process "http://$hostName`:$port/" -WindowStyle Hidden }
        return
    }
    throw "Port $port is already used by an unrelated process; refusing to attach or replace it."
}

$server = Join-Path $repoRoot 'server\index.js'
$preferredLogRoot = Join-Path $repoRoot 'logs'
$logRoot = $preferredLogRoot
$logWritable = $false
try {
    New-Item -ItemType Directory -Path $preferredLogRoot -Force -ErrorAction Stop | Out-Null
    # The checkout may be owner-ACL protected even when the server itself is
    # readable. Probe one uniquely named file before committing to that path.
    $probe = Join-Path $preferredLogRoot ('.toolsenabled-write-probe-' + $PID + '-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [System.IO.File]::WriteAllText($probe, '')
    Remove-Item -LiteralPath $probe -Force -ErrorAction Stop
    $logWritable = $true
} catch {
    $logRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'scratch\visualizer-runtime-logs'
    New-Item -ItemType Directory -Path $logRoot -Force -ErrorAction Stop | Out-Null
}
$stdoutPath = Join-Path $logRoot 'visualizer.stdout.log'
$stderrPath = Join-Path $logRoot 'visualizer.stderr.log'
$arguments = '"' + $server.Replace('"', '\"') + '" --host ' + $hostName + ' --port ' + $port + ' --upstream ' + $upstream

# Do not use Start-Process or npm here.  The native process boundary avoids the
# cmd.exe/npm/Git-Bash wrapper chain that was flashing terminal windows.
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = $arguments
$psi.WorkingDirectory = $repoRoot
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$child = New-Object System.Diagnostics.Process
$child.StartInfo = $psi
if (-not $child.Start()) { throw 'The visualizer process could not be started.' }
$outTask = $child.StandardOutput.ReadToEndAsync()
$errTask = $child.StandardError.ReadToEndAsync()
$child.WaitForExit(3000) | Out-Null
if ($child.HasExited) {
    $outTask.GetAwaiter().GetResult() | Set-Content -LiteralPath $stdoutPath -Encoding UTF8
    $errTask.GetAwaiter().GetResult() | Set-Content -LiteralPath $stderrPath -Encoding UTF8
    throw "The visualizer exited during startup (code $($child.ExitCode))."
}

if (-not $NoBrowser) { Start-Process "http://$hostName`:$port/" -WindowStyle Hidden }
[pscustomobject]@{ status = 'started'; pid = $child.Id; host = $hostName; port = $port; launch = 'native-hidden-node' } | ConvertTo-Json -Compress
