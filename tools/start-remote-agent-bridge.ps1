# Starts the remote-agent-bridge (src/remote-agent-bridge.js) hidden, with
# stdout/stderr redirected to files -- same reasoning and pattern as
# tools/start-link-bus.ps1 / tools/start-agent-activity-visualizer.ps1: never
# a flashing console window, never an unredirected long-lived process.
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
$server = Join-Path $RepoRoot 'src\remote-agent-bridge.js'
$serverCommandPattern = '(?i)(?:^|["\s])' + [regex]::Escape([IO.Path]::GetFullPath($server)) + '(?=$|["\s])'
# The bind address is accepted only when the validated registry declares it
# for exactly one known machine. No subnet/default fallback survives.
$Topology = if ([string]::IsNullOrWhiteSpace($HostAddress)) {
  Resolve-ServiceRegistryTopology -Root $RepoRoot
} else {
  Resolve-ServiceRegistryTopology -Root $RepoRoot -ConfiguredAddress $HostAddress
}
$hostName = [string]$Topology.localMachine.address
$port = 8788
$healthHost = '127.0.0.1'
$healthPort = 8789

if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Node executable is missing: $node" }
if (-not (Test-Path -LiteralPath $server -PathType Leaf)) { throw "Remote agent bridge is missing: $server" }

$existing = @(Get-NetTCPConnection -LocalAddress $hostName -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($existing.Count -gt 0) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($existing[0].OwningProcess)" -ErrorAction SilentlyContinue
    $ownerCommandLine = if ($owner) { [string]$owner.CommandLine } else { '' }
    # UNREADABLE IS NOT UNRELATED. An unelevated Win32_Process read returns an
    # EMPTY CommandLine for a process owned by another session -- which is every
    # S4U scheduled task, and this service is now task-managed. Falling through
    # to the "unrelated process" branch would make that the PERMANENT answer and
    # send the reader hunting a foreign process that does not exist.
    if ([string]::IsNullOrWhiteSpace($ownerCommandLine)) {
        throw "Port $port on $hostName is held by pid $($existing[0].OwningProcess), whose command line this privilege level cannot read (empty -- typical of an S4U scheduled task). Refusing to start a second listener. Re-check elevated to confirm ownership."
    }
    if ($owner -and $owner.ExecutablePath -ieq $node -and $ownerCommandLine -match $serverCommandPattern) {
        $health = @(Get-NetTCPConnection -LocalAddress $healthHost -LocalPort $healthPort -State Listen -ErrorAction SilentlyContinue)
        if ($health.Count -eq 1 -and [int]$health[0].OwningProcess -eq [int]$existing[0].OwningProcess) {
            [pscustomobject]@{ status = 'already-running'; pid = $existing[0].OwningProcess; host = $hostName; port = $port; healthHost = $healthHost; healthPort = $healthPort } | ConvertTo-Json -Compress
            return
        }
        throw "The owned bridge listener is present but its local dispatcher-health listener is missing or mismatched; supervisor must restart it."
    }
    throw "Port $port on $hostName is already used by an unrelated process; refusing to attach or replace it."
}

$stateDir = Join-Path $RepoRoot 'state'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
$stdoutPath = Join-Path $stateDir 'remote-agent-bridge.stdout.log'
$stderrPath = Join-Path $stateDir 'remote-agent-bridge.stderr.log'

# Pass the registry-derived bind address to the child, restoring the parent
# environment immediately after the spawn.
$previousBridgeHost = [Environment]::GetEnvironmentVariable('REMOTE_AGENT_BRIDGE_HOST')
[Environment]::SetEnvironmentVariable('REMOTE_AGENT_BRIDGE_HOST', $hostName)
try {
    $child = Start-Process -FilePath $node -ArgumentList @('"' + $server + '"') -WorkingDirectory $RepoRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
} finally {
    [Environment]::SetEnvironmentVariable('REMOTE_AGENT_BRIDGE_HOST', $previousBridgeHost)
}
$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if ($child.HasExited) {
        throw "The remote agent bridge exited during startup (code $($child.ExitCode)). See $stderrPath"
    }
    $listener = @(Get-NetTCPConnection -LocalAddress $hostName -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    $healthListener = @(Get-NetTCPConnection -LocalAddress $healthHost -LocalPort $healthPort -State Listen -ErrorAction SilentlyContinue)
    if ($listener.Count -eq 1 -and [int]$listener[0].OwningProcess -eq $child.Id -and
        $healthListener.Count -eq 1 -and [int]$healthListener[0].OwningProcess -eq $child.Id) {
        [pscustomobject]@{ status = 'started'; pid = $child.Id; host = $hostName; port = $port; healthHost = $healthHost; healthPort = $healthPort } | ConvertTo-Json -Compress
        return
    }
}
if (-not $child.HasExited) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue }
throw "The remote agent bridge did not open $hostName`:$port during startup. See $stderrPath"
