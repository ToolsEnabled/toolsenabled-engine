#requires -Version 5.1
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('a', 'b')]
    [string]$Role,

    [Parameter(Mandatory = $true)]
    [string]$RepoRoot,

    [Parameter(Mandatory = $false)]
    [ValidateRange(1, 2147483647)]
    [int]$ExpectedPid,

    [Parameter(Mandatory = $false)]
    [ValidateLength(1, 128)]
    [string]$ExpectedCreationDate
)

# Read-only, fail-closed identity proof for the 8787 rotation. A listener is
# accepted only when its tuple, PID, owner SID, executable, canonical entry
# point, and (when supplied) creation time all match. Port 8788 must be closed
# for the isolated special-session rotation.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# THE LISTENER ADDRESS IS RESOLVED, NOT HARDCODED (R1116/R1117). This script
# used to map -Role a/b onto two literal IPv4 addresses. That literal is a
# portability bug with a security tail: the tuple check below is what proves
# the 8787 listener is the expected one, and a literal that no longer names
# this machine after a move to a different computer or network makes the check
# either always-fail (best case) or match a listener the operator did not
# mean. -Role now selects the deterministic coordinator/recipient role, and
# the address comes from
# config/service-registry.json through the same fail-closed reader
# tools/restart-link-bus-exact.ps1 already uses. An unreadable, malformed, or
# ambiguous registry throws and lands in the catch below as valid=$false --
# there is no subnet, localhost, or last-known-good fallback.
$localAddress = $null
$fixedNode = $null
$resolvedRoot = $null
$listenerPid = $null
$listenerCreationDate = $null
$port8788Closed = $false
$valid = $false
$reason = 'inspection_failed'

try {
    $resolvedRoot = [IO.Path]::GetFullPath($RepoRoot)
    if (-not [IO.Path]::IsPathRooted($RepoRoot)) {
        throw 'repo_root_not_absolute'
    }
    $registryHelper = Join-Path $resolvedRoot 'tools\lib\service-registry.ps1'
    if (-not (Test-Path -LiteralPath $registryHelper -PathType Leaf)) {
        throw 'SERVICE_REGISTRY_UNAVAILABLE'
    }
    . $registryHelper
    $topology = Resolve-ServiceRegistryDirectionalTopology -Root $resolvedRoot
    $selectedMachine = if ($Role -ceq 'a') {
        $topology.coordinatorMachine
    } else {
        $topology.recipientMachine
    }
    $localAddress = [string]$selectedMachine.address
    if (-not (Test-ServiceRegistryIPv4 -Address $localAddress)) {
        throw 'SERVICE_MACHINE_ADDRESS_INVALID'
    }
    $resolveNodeHelper = Join-Path $resolvedRoot 'tools\lib\resolve-node.ps1'
    if (-not (Test-Path -LiteralPath $resolveNodeHelper -PathType Leaf)) {
        throw 'NODE_22_19_OR_NEWER_MISSING'
    }
    . $resolveNodeHelper
    $fixedNode = Resolve-ToolsEnabledNode -Root $resolvedRoot
    $server = [IO.Path]::GetFullPath(
        (Join-Path $resolvedRoot 'sidecars\link-bus\server.js')
    )
    foreach ($required in @($fixedNode, $server)) {
        $item = Get-Item -LiteralPath $required -Force -ErrorAction Stop
        if ($item.PSIsContainer -or
            (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
            throw 'required_file_invalid'
        }
    }

    $bridgeListeners = @(
        Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue
    )
    $port8788Closed = ($bridgeListeners.Count -eq 0)

    $allRelayListeners = @(
        Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
    )
    if ($allRelayListeners.Count -ne 1 -or
        [string]$allRelayListeners[0].LocalAddress -cne $localAddress) {
        throw 'listener_tuple_mismatch'
    }
    $listenerPid = [int]$allRelayListeners[0].OwningProcess
    if ($listenerPid -le 0) {
        throw 'listener_pid_invalid'
    }
    if ($Role -ceq 'a' -and
        (-not $PSBoundParameters.ContainsKey('ExpectedPid') -or
         $listenerPid -ne $ExpectedPid)) {
        throw 'listener_pid_mismatch'
    }

    $process = Get-CimInstance -ClassName Win32_Process `
        -Filter "ProcessId=$listenerPid" -ErrorAction Stop
    if ($null -eq $process -or
        [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath) -or
        -not [string]::Equals(
            [IO.Path]::GetFullPath([string]$process.ExecutablePath),
            [IO.Path]::GetFullPath($fixedNode),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'listener_executable_mismatch'
    }

    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid `
        -ErrorAction Stop
    $expectedOwnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($null -eq $owner -or
        [string]::IsNullOrWhiteSpace([string]$owner.Sid) -or
        [string]$owner.Sid -cne $expectedOwnerSid) {
        throw 'listener_owner_mismatch'
    }

    $commandLine = [string]$process.CommandLine
    if ([string]::IsNullOrWhiteSpace($commandLine)) {
        throw 'listener_command_unreadable'
    }
    $nodePattern = [Regex]::Escape([IO.Path]::GetFullPath($fixedNode))
    $serverPattern = [Regex]::Escape($server)
    $commandPattern = '^\s*"?' + $nodePattern + '"?\s+"?' +
        $serverPattern + '"?\s*$'
    if ($commandLine -notmatch $commandPattern) {
        throw 'listener_command_mismatch'
    }

    if ($process.CreationDate -is [DateTime]) {
        $listenerCreationDate =
            [Management.ManagementDateTimeConverter]::ToDmtfDateTime(
                [DateTime]$process.CreationDate
            )
    } else {
        $listenerCreationDate = [string]$process.CreationDate
    }
    if ([string]::IsNullOrWhiteSpace($listenerCreationDate)) {
        throw 'listener_creation_time_unreadable'
    }
    if ($PSBoundParameters.ContainsKey('ExpectedCreationDate') -and
        $listenerCreationDate -cne $ExpectedCreationDate) {
        throw 'listener_creation_time_mismatch'
    }
    if (-not $port8788Closed) {
        throw 'port_8788_open'
    }

    $valid = $true
    $reason = $null
} catch {
    $reason = [string]$_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($reason) -or $reason.Length -gt 128) {
        $reason = 'inspection_failed'
    }
}

[pscustomobject]@{
    valid = $valid
    role = $Role
    localAddress = $localAddress
    listenerPid = $listenerPid
    listenerCreationDate = $listenerCreationDate
    port8788Closed = $port8788Closed
    reason = $reason
} | ConvertTo-Json -Compress
