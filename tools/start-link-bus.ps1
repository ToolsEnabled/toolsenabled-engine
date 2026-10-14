# Starts the direct-ethernet link bus (sidecars/link-bus/server.js) hidden,
# with stdout/stderr redirected to files -- never a flashing console window,
# never an unredirected long-lived process (STANDING-ORDERS LOCAL-WORK #3 and
# the coordinator's "always redirect" rule). Mirrors the established native
# ProcessStartInfo pattern already used by
# tools/start-agent-activity-visualizer.ps1 rather than Start-Process/npm,
# which can flash a cmd.exe/npm wrapper window.
[CmdletBinding()]
param([string]$HostAddress)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$RegistryHelper = Join-Path $RepoRoot 'tools\lib\service-registry.ps1'
if (-not (Test-Path -LiteralPath $RegistryHelper -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $RegistryHelper
$ResolveNodeHelper = Join-Path $RepoRoot 'tools\lib\resolve-node.ps1'
if (-not (Test-Path -LiteralPath $ResolveNodeHelper -PathType Leaf)) { throw 'NODE_22_19_OR_NEWER_MISSING' }
. $ResolveNodeHelper
# Version-checked, not a Test-Path binary choice between two hardcoded paths --
# see tools/lib/resolve-node.ps1's header for why a stale-but-present Program
# Files node must not qualify silently.
$node = Resolve-ToolsEnabledNode -Root $RepoRoot
$server = Join-Path $RepoRoot 'sidecars\link-bus\server.js'
$serverCommandPattern = '(?i)(?:^|["\s])' + [regex]::Escape([IO.Path]::GetFullPath($server)) + '(?=$|["\s])'
# The bind address is accepted only when the validated registry declares it
# for exactly one known machine. Missing, malformed, empty, undetectable, and
# ambiguous registries/interfaces all refuse with the helper's named error.
$Topology = if ([string]::IsNullOrWhiteSpace($HostAddress)) {
  Resolve-ServiceRegistryTopology -Root $RepoRoot
} else {
  Resolve-ServiceRegistryTopology -Root $RepoRoot -ConfiguredAddress $HostAddress
}
$hostName = [string]$Topology.localMachine.address
$port = 8787

if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Node executable is missing: $node" }
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw "Link bus server is missing: $server" }

$existing = @(Get-NetTCPConnection -LocalAddress $hostName -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($existing[0].OwningProcess)" -ErrorAction SilentlyContinue
    $ownerCommandLine = if ($owner) { [string]$owner.CommandLine } else { '' }
    # UNREADABLE IS NOT UNRELATED. An unelevated Win32_Process read returns an
    # EMPTY CommandLine for a process owned by another session -- every S4U
    # scheduled task. Falling through to "unrelated process" would make that the
    # permanent answer once this lane is task-managed.
    if ([string]::IsNullOrWhiteSpace($ownerCommandLine)) {
        throw "Port $port on $hostName is held by pid $($existing[0].OwningProcess), whose command line this privilege level cannot read (empty -- typical of an S4U scheduled task). Refusing to start a second listener. Re-check elevated to confirm ownership."
    }
    if ($owner -and $owner.ExecutablePath -ieq $node -and $ownerCommandLine -match $serverCommandPattern) {
        [pscustomobject]@{ status = 'already-running'; pid = $existing[0].OwningProcess; host = $hostName; port = $port } | ConvertTo-Json -Compress
        return
    }
    throw "Port $port on $hostName is already used by an unrelated process; refusing to attach or replace it."
}

$stateDir = Join-Path $RepoRoot 'sidecars\link-bus\state'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$stdoutPath = Join-Path $stateDir 'link-bus.stdout.log'
$stderrPath = Join-Path $stateDir 'link-bus.stderr.log'

# Start-Process is used deliberately here with a hidden window and file
# redirection. The prior ProcessStartInfo/ReadToEndAsync shape waited for the
# stdout pipe of a long-lived server to close, so a successful start could
# leave the caller hung forever. This gives the child durable file handles and
# lets the launcher verify the actual listener instead of merely child birth.
# Pass the registry-derived address explicitly to the child. Start-Process does
# not inherit a scope-local variable, so the parent environment is restored
# immediately after the spawn.
$previousLinkBusHost = [Environment]::GetEnvironmentVariable('LINK_BUS_HOST')
[Environment]::SetEnvironmentVariable('LINK_BUS_HOST', $hostName)
try {
    $child = Start-Process -FilePath $node -ArgumentList @('"' + $server + '"') -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
} finally {
    [Environment]::SetEnvironmentVariable('LINK_BUS_HOST', $previousLinkBusHost)
}
$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if ($child.HasExited) {
        throw "The link bus exited during startup (code $($child.ExitCode)). See $stderrPath"
    }
    $listener = @(Get-NetTCPConnection -LocalAddress $hostName -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listener.Count -eq 1 -and [int]$listener[0].OwningProcess -eq $child.Id) {
        [pscustomobject]@{ status = 'started'; pid = $child.Id; host = $hostName; port = $port } | ConvertTo-Json -Compress
        return
    }
}
if (-not $child.HasExited) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue }
throw "The link bus did not open $hostName`:$port during startup. See $stderrPath"
