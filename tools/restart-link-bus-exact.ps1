[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [switch]$ExecuteLinkBusTokenRotationRestart,

    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$ExpectedPid,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedCreationDate
)

# This is the only process-mutating step in the rotation.  It terminates one
# exact listener identity (tuple + PID + creation time + owner + executable +
# canonical script), launches through the fixed shell-free launcher, and proves
# the returned child PID owns exactly the registry-declared coordinator address
# on port 8787. No process-name kill
# or wildcard selection exists.
$ErrorActionPreference = 'Stop'
if (-not $ExecuteLinkBusTokenRotationRestart) {
    throw 'Explicit link-bus rotation restart confirmation is required.'
}
$resolvedRoot = [IO.Path]::GetFullPath($RepoRoot)
$RegistryHelper = Join-Path $resolvedRoot 'tools\lib\service-registry.ps1'
if (-not (Test-Path -LiteralPath $RegistryHelper -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $RegistryHelper
$Topology = Resolve-ServiceRegistryDirectionalTopology -Root $resolvedRoot
if ([string]$Topology.localRole -cne 'coordinator') { throw 'LINK_BUS_ROTATION_COORDINATOR_REQUIRED' }
$CoordinatorAddress = [string]$Topology.coordinatorMachine.address
$ResolveNodeHelper = Join-Path $resolvedRoot 'tools\lib\resolve-node.ps1'
if (-not (Test-Path -LiteralPath $ResolveNodeHelper -PathType Leaf)) { throw 'NODE_22_19_OR_NEWER_MISSING' }
. $ResolveNodeHelper
$node = Resolve-ToolsEnabledNode -Root $resolvedRoot
$statusScript = Join-Path $resolvedRoot 'tools\special-session-link-bus-local-status.ps1'
$launcher = Join-Path $resolvedRoot 'tools\link-bus-exact-launch.js'
foreach ($required in @($node, $statusScript, $launcher)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required exact-restart component is missing: $required"
    }
}

# Revalidate immediately before termination to close PID-reuse and bind-race
# ambiguity as tightly as this local boundary allows.
$beforeText = & $statusScript `
    -Role a `
    -RepoRoot $resolvedRoot `
    -ExpectedPid $ExpectedPid `
    -ExpectedCreationDate $ExpectedCreationDate
if ($LASTEXITCODE -ne 0) { throw 'Exact listener pre-restart validation failed.' }
$before = $beforeText | ConvertFrom-Json -ErrorAction Stop
if ($before.valid -ne $true -or $before.listenerPid -ne $ExpectedPid) {
    throw 'Exact listener pre-restart validation failed.'
}

Stop-Process -Id $ExpectedPid -ErrorAction Stop
$closed = $false
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ([DateTime]::UtcNow -lt $deadline) {
    $listeners = @(
        Get-NetTCPConnection `
            -LocalAddress $CoordinatorAddress `
            -LocalPort 8787 `
            -State Listen `
            -ErrorAction SilentlyContinue
    )
    if ($listeners.Count -eq 0) {
        $closed = $true
        break
    }
    Start-Sleep -Milliseconds 100
}
if (-not $closed) {
    throw 'The exact old listener did not release the registry-declared coordinator endpoint.'
}

$launchText = & $node `
    $launcher `
    --execute-exact-link-bus-launch `
    --repo-root $resolvedRoot
if ($LASTEXITCODE -ne 0) { throw 'The exact link-bus launcher failed.' }
$launch = $launchText | ConvertFrom-Json -ErrorAction Stop
if (
    $launch.status -cne 'launched' -or
    $launch.host -cne $CoordinatorAddress -or
    $launch.port -ne 8787 -or
    $launch.pid -le 0
) {
    throw 'The exact link-bus launcher returned an invalid receipt.'
}

$ready = $false
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while ([DateTime]::UtcNow -lt $deadline) {
    $listeners = @(
        Get-NetTCPConnection `
            -LocalAddress $CoordinatorAddress `
            -LocalPort 8787 `
            -State Listen `
            -ErrorAction SilentlyContinue
    )
    if (
        $listeners.Count -eq 1 -and
        $listeners[0].OwningProcess -eq [int]$launch.pid
    ) {
        $ready = $true
        break
    }
    if ($null -eq (Get-Process -Id ([int]$launch.pid) -ErrorAction SilentlyContinue)) {
        break
    }
    Start-Sleep -Milliseconds 100
}
if (-not $ready) {
    throw 'The newly launched exact listener did not become ready.'
}

$afterText = & $statusScript `
    -Role a `
    -RepoRoot $resolvedRoot `
    -ExpectedPid ([int]$launch.pid)
if ($LASTEXITCODE -ne 0) { throw 'Exact listener post-restart validation failed.' }
$after = $afterText | ConvertFrom-Json -ErrorAction Stop
if ($after.valid -ne $true -or $after.listenerPid -ne [int]$launch.pid) {
    throw 'Exact listener post-restart validation failed.'
}

[pscustomobject]@{
    status = 'restarted_exact'
    replacedPid = $ExpectedPid
    listenerPid = [int]$launch.pid
    listenerCreationDate = [string]$after.listenerCreationDate
    host = $CoordinatorAddress
    port = 8787
    port8788Closed = $true
} | ConvertTo-Json -Compress
