# Mechanical keeper for the direct-Ethernet tunnel and remote tool bridge.
#
# This replaces the old handoff-only marker loop. It owns no credentials and
# never creates or rewrites the audit key. Each cycle observes the link-bus
# HTTP health contract and both listener identities, starts a missing service,
# and restarts only a listener whose PID and command line match the exact
# ToolsEnabled entry point. An unrelated listener is reported as a conflict
# and is never terminated.
[CmdletBinding()]
param(
    [ValidateRange(1, 3600)]
    [int]$IntervalSeconds = 15,
    [ValidateRange(0, 10080)]
    [int]$MaxMinutes = 0,
    [switch]$Once,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$RegistryHelper = Join-Path $Root 'tools\lib\service-registry.ps1'
if (-not (Test-Path -LiteralPath $RegistryHelper -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $RegistryHelper
$ResolveNodeHelper = Join-Path $Root 'tools\lib\resolve-node.ps1'
if (-not (Test-Path -LiteralPath $ResolveNodeHelper -PathType Leaf)) { throw 'NODE_22_19_OR_NEWER_MISSING' }
. $ResolveNodeHelper
# Was a single hardcoded literal with no fallback or version check at all --
# see tools/lib/resolve-node.ps1's header for why that silently launches a
# server on a non-qualifying interpreter on any machine where Program Files
# node predates 22.19.0.
$Node = Resolve-ToolsEnabledNode -Root $Root
$Preflight = Join-Path $Root 'tools\tunnel-bridge-preflight.js'
if (-not (Test-Path -LiteralPath $Preflight -PathType Leaf)) { throw 'TUNNEL_BRIDGE_PREFLIGHT_MISSING' }
$preflightRaw = @(& $Node $Preflight '--json' 2>$null) -join "`n"
$preflightExit = $LASTEXITCODE
try { $preflightResult = $preflightRaw | ConvertFrom-Json -ErrorAction Stop }
catch { throw 'TUNNEL_BRIDGE_PREFLIGHT_FAILED' }
if ($preflightExit -ne 0 -or $preflightResult.ok -ne $true) {
    $preflightCode = [string]$preflightResult.code
    if ($preflightCode -notmatch '^TUNNEL_BRIDGE_[A-Z0-9_]{3,80}$') {
        $preflightCode = 'TUNNEL_BRIDGE_PREFLIGHT_FAILED'
    }
    throw $preflightCode
}
$Probe = Join-Path $Root 'tools\tunnel-bridge-health.js'
$StateDir = Join-Path $Root 'state'
$LogFile = Join-Path $Root 'logs\tunnel-bridge-supervisor.log'
$StateFile = Join-Path $StateDir 'tunnel-bridge-supervisor.json'
$StopFile = Join-Path $StateDir 'tunnel-bridge-supervisor.stop'
$ComponentStopFiles = [ordered]@{
    linkBus = Join-Path $StateDir 'tunnel-bridge-linkbus.stop'
    remoteBridge = Join-Path $StateDir 'tunnel-bridge-remote-bridge.stop'
}
# Network identity and checkout identity are independent facts. Resolve the
# customer registry fail-closed, then bind this process to the exact local root
# declared for the detected computer. A sanctioned address from a retired or
# copied checkout is not authority to supervise the installed listeners.
$Topology = Resolve-ServiceRegistryTopology -Root $Root
$HostName = [string]$Topology.localMachine.address
$ExpectedRootForHost = [string]$Topology.localMachine.root
if ([string]::IsNullOrWhiteSpace($ExpectedRootForHost)) { throw 'SERVICE_MACHINE_ROOT_UNAVAILABLE' }
if ($Root -ine $ExpectedRootForHost) { throw 'TUNNEL_BRIDGE_SUPERVISOR_ROOT_HOST_MISMATCH' }
# The registered remote proxy permits one audited call to run for 180 seconds.
# While synchronous audit preparation owns the bridge's Node event loop, its
# loopback HTTP health callback cannot run even though the in-flight request is
# valid. Give only the supervisor probe a slightly larger ceiling so it cannot
# kill that request at the ordinary 10-second observer timeout. A dead socket
# or exited bridge still fails immediately; a genuinely wedged event loop is
# recovered after this bounded ceiling.
$SupervisorDispatcherHealthTimeoutMs = 190000

$Components = @(
    [pscustomobject]@{
        Name = 'linkBus'
        Port = 8787
        Script = Join-Path $Root 'sidecars\link-bus\server.js'
        Starter = Join-Path $Root 'tools\start-link-bus.ps1'
    },
    [pscustomobject]@{
        Name = 'remoteBridge'
        Port = 8788
        Script = Join-Path $Root 'src\remote-agent-bridge.js'
        Starter = Join-Path $Root 'tools\start-remote-agent-bridge.ps1'
    }
)

if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'NODE_MISSING' }
if (-not (Test-Path -LiteralPath $Probe -PathType Leaf)) { throw 'HEALTH_PROBE_MISSING' }
if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw 'TOOLSENABLED_ROOT_MISSING' }

function Get-ListenerIdentity {
    param([Parameter(Mandatory)][pscustomobject]$Component)

    # Inventory the whole port before checking the expected tuple. Looking up
    # only -LocalAddress $HostName would report "absent" when an unrelated
    # wildcard/loopback listener already owns the port and would make the
    # keeper launch a doomed duplicate.
    $listeners = @(Get-NetTCPConnection -LocalPort $Component.Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        return [pscustomobject]@{ state = 'absent'; pid = $null; owned = $false }
    }
    if ($listeners.Count -ne 1 -or [string]$listeners[0].LocalAddress -cne $HostName) {
        return [pscustomobject]@{ state = 'conflict'; pid = $null; owned = $false; reason = 'listener_tuple_mismatch' }
    }

    $ownerPid = [int]$listeners[0].OwningProcess
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
    $expectedNode = [IO.Path]::GetFullPath($Node)
    $expectedScript = [IO.Path]::GetFullPath($Component.Script)
    $scriptCommandPattern = '(?i)(?:^|["\s])' + [regex]::Escape($expectedScript) + '(?=$|["\s])'
    $commandLine = if ($owner) { [string]$owner.CommandLine } else { '' }
    # UNVERIFIABLE IS A THIRD STATE. An unelevated read returns an EMPTY
    # CommandLine for a process owned by another session -- every S4U scheduled
    # task. Reporting that as 'conflict' would make this supervisor refuse to
    # recognise a listener it started itself once these lanes are task-managed,
    # and 'owned' would let it act on a reading it could not make. Neither is
    # honest, so there is a third answer.
    $identityReadable = -not [string]::IsNullOrWhiteSpace($commandLine)
    $nodeOk = [bool]($owner -and ([string]$owner.ExecutablePath).Equals($expectedNode, [StringComparison]::OrdinalIgnoreCase))
    $owned = [bool]($nodeOk -and $identityReadable -and
        $commandLine -match $scriptCommandPattern)
    $state = if ($owned) { 'owned' }
        elseif ($owner -and -not $identityReadable) { 'unverifiable' }
        else { 'conflict' }
    return [pscustomobject]@{
        state = $state
        pid = $ownerPid
        owned = $owned
        # The reason has to match the state it explains. 'unverifiable' was
        # reported as listener_identity_mismatch, which is a claim about the
        # WORLD -- that this is someone else's process -- made from a reading
        # that never happened. tunnel-bridge-control.ps1 already names it
        # correctly; this is the same vocabulary.
        reason = if ($owned) { $null }
            elseif ($state -eq 'unverifiable') { 'listener_identity_unreadable' }
            else { 'listener_identity_mismatch' }
    }
}

function Invoke-HealthProbe {
    $previousDispatcherTimeout = $env:TUNNEL_DISPATCHER_PROBE_TIMEOUT_MS
    try {
        $env:TUNNEL_DISPATCHER_PROBE_TIMEOUT_MS = [string]$SupervisorDispatcherHealthTimeoutMs
        $raw = @(& $Node $Probe 2>$null) -join "`n"
        if ([string]::IsNullOrWhiteSpace($raw)) { return [pscustomobject]@{ overallHealthy = $false; error = 'probe_no_output' } }
        return ($raw | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{ overallHealthy = $false; error = 'probe_failed' }
    } finally {
        if ($null -eq $previousDispatcherTimeout) {
            Remove-Item Env:TUNNEL_DISPATCHER_PROBE_TIMEOUT_MS -ErrorAction SilentlyContinue
        } else {
            $env:TUNNEL_DISPATCHER_PROBE_TIMEOUT_MS = $previousDispatcherTimeout
        }
    }
}

function Get-ComponentHealth {
    param([Parameter(Mandatory)]$ProbeResult, [Parameter(Mandatory)][string]$Name)
    if (-not $ProbeResult.components) { return $false }
    $property = $ProbeResult.components.PSObject.Properties[$Name]
    return [bool]($property -and $property.Value.ok -eq $true)
}

function Test-ComponentStopRequested {
    param([Parameter(Mandatory)][string]$Name)
    return Test-Path -LiteralPath $ComponentStopFiles[$Name]
}

function Stop-OwnedComponent {
    param(
        [Parameter(Mandatory)]$Identity,
        [Parameter(Mandatory)][pscustomobject]$Component
    )
    if (-not $Identity.owned -or -not $Identity.pid) { return 'stop_refused' }
    try {
        Stop-Process -Id ([int]$Identity.pid) -ErrorAction Stop
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            Start-Sleep -Milliseconds 250
            $stillThere = @(Get-NetTCPConnection -LocalAddress $HostName -LocalPort $Component.Port -State Listen -ErrorAction SilentlyContinue)
            if ($stillThere.Count -eq 0) { return 'stopped' }
        }
        return 'stop_timeout'
    } catch {
        return 'stop_failed'
    }
}

function Start-Component {
    param([Parameter(Mandatory)][pscustomobject]$Component)
    if ($DryRun) { return 'would_start' }
    try {
        # Invoke the fixed launcher in this PowerShell process. Spawning a
        # second powershell.exe here made a long-lived child's redirected
        # handles part of the supervisor's own wait graph, so -Once could
        # remain alive after the listener had already recovered.
        & $Component.Starter *> $null
        return 'start_requested'
    } catch {
        return 'start_failed'
    }
}

function Invoke-Cycle {
    $before = Invoke-HealthProbe
    $actions = @()

    foreach ($component in $Components) {
        $identity = Get-ListenerIdentity -Component $component
        $healthy = Get-ComponentHealth -ProbeResult $before -Name $component.Name

        if (Test-ComponentStopRequested -Name $component.Name) {
            if ($identity.state -eq 'conflict') {
                $actions += [pscustomobject]@{ component = $component.Name; action = 'blocked_disabled_conflict' }
            } elseif ($identity.state -eq 'unverifiable') {
                # Something IS bound to this port. Reporting the component as
                # 'disabled' because we could not read the holder would be a
                # claim that nothing is listening.
                $actions += [pscustomobject]@{ component = $component.Name; action = 'blocked_disabled_unverifiable'; pid = $identity.pid }
            } elseif ($identity.state -eq 'owned') {
                if ($DryRun) {
                    $actions += [pscustomobject]@{ component = $component.Name; action = 'would_disable_owned' }
                } else {
                    $stop = Stop-OwnedComponent -Identity $identity -Component $component
                    $actions += [pscustomobject]@{ component = $component.Name; action = "disabled_$stop" }
                }
            } else {
                $actions += [pscustomobject]@{ component = $component.Name; action = 'disabled' }
            }
            continue
        }

        if ($identity.state -eq 'conflict') {
            $actions += [pscustomobject]@{ component = $component.Name; action = 'blocked_conflict' }
            continue
        }

        # UNREADABLE IS NOT ABSENT, AND THE ACTION HAS TO SAY SO.
        #
        # Get-ListenerIdentity has told the truth about this state for a while,
        # but the dispatch below had no branch for it, so 'unverifiable' fell
        # through to the same Start-Component as 'absent'. Measured 2026-08-09 in
        # an isolated copy against a real listener whose owner this token cannot
        # read: listenerState was "unverifiable" with a live pid, and the action
        # was "start_requested" -- byte-identical to the genuinely absent
        # component in the same cycle, and the starter actually ran. In
        # production that starts a second process on a port that is already
        # bound: EADDRINUSE, a restart loop every cycle, and a keeper fighting a
        # listener it cannot identify.
        #
        # Neither starting nor stopping is available here: we cannot prove the
        # holder is ours (so we must not kill it) and the port is taken (so we
        # must not start over it). The correct action is no action plus a name
        # for the state, which is what the two branches below record.
        if ($identity.state -eq 'unverifiable') {
            $actions += [pscustomobject]@{
                component = $component.Name
                action = if ($healthy) { 'unverified_healthy_no_action' } else { 'blocked_unverifiable' }
                pid = $identity.pid
            }
            continue
        }

        if ($healthy -and $identity.state -eq 'owned') {
            $actions += [pscustomobject]@{ component = $component.Name; action = 'steady' }
            continue
        }

        if ($identity.state -eq 'owned') {
            if ($DryRun) {
                $actions += [pscustomobject]@{ component = $component.Name; action = 'would_restart_owned' }
                continue
            }
            $stop = Stop-OwnedComponent -Identity $identity -Component $component
            if ($stop -notin @('stopped')) {
                $actions += [pscustomobject]@{ component = $component.Name; action = "restart_$stop" }
                continue
            }
            $start = Start-Component -Component $component
            $actions += [pscustomobject]@{ component = $component.Name; action = "restart_$start" }
            continue
        }

        $start = Start-Component -Component $component
        $actions += [pscustomobject]@{ component = $component.Name; action = $start }
    }

    $after = Invoke-HealthProbe
    $componentReports = [ordered]@{}
    foreach ($component in $Components) {
        $identity = Get-ListenerIdentity -Component $component
        $stopRequested = Test-ComponentStopRequested -Name $component.Name
        $componentReports[$component.Name] = [ordered]@{
            host = $HostName
            port = $component.Port
            listenerState = $identity.state
            pid = $identity.pid
            owned = [bool]$identity.owned
            healthy = Get-ComponentHealth -ProbeResult $after -Name $component.Name
            desiredState = if ($stopRequested) { 'disabled' } else { 'enabled' }
            stopRequested = $stopRequested
            reason = $identity.reason
        }
    }

    $overall = [bool]($Root -and (Test-Path -LiteralPath $Root -PathType Container) -and
        ($componentReports.Values | Where-Object {
            if ($_.desiredState -eq 'disabled') { $_.listenerState -ne 'absent' }
            else { -not $_.healthy -or -not $_.owned }
        }).Count -eq 0)
    $generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    return [ordered]@{
        schemaVersion = 'tunnel-bridge-supervisor.v1'
        generatedAt = $generatedAt
        ok = $overall
        failureAt = if ($overall) { $null } else { $generatedAt }
        root = $Root
        rootExists = Test-Path -LiteralPath $Root -PathType Container
        once = [bool]$Once
        dryRun = [bool]$DryRun
        overallHealthy = $overall
        components = $componentReports
        actions = @($actions)
        auditKeyAction = 'none'
        secretValuesEmitted = $false
    }
}

function Write-Report {
    param([Parameter(Mandatory)]$Report)
    $json = $Report | ConvertTo-Json -Depth 12 -Compress
    if (-not $DryRun) {
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
        New-Item -ItemType Directory -Path (Split-Path -Parent $LogFile) -Force | Out-Null
        $temp = "$StateFile.$PID.tmp"
        # Set-Content -Encoding UTF8 writes UTF-8 WITH a BOM in Windows PowerShell
        # 5.1 (only BOM-less in PowerShell 7+) -- the same class of bug fixed
        # tonight in full-remote-access-control.ps1. WriteAllText with an
        # explicit no-BOM encoding is the correct idiom. Applied here for
        # consistency even though no current JS reader of this specific file
        # was found (checked directly) -- this closes the risk before a future
        # Node consumer of tunnel-bridge-supervisor.json hits the same wall.
        [IO.File]::WriteAllText($temp, $json, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $StateFile -Force
        Add-Content -LiteralPath $LogFile -Value $json -Encoding UTF8
    }
    Write-Output $json
}

$deadline = if ($MaxMinutes -gt 0) { (Get-Date).AddMinutes($MaxMinutes) } else { $null }
$lastReport = $null
do {
    if (Test-Path -LiteralPath $StopFile) { break }
    $report = Invoke-Cycle
    $lastReport = $report
    Write-Report -Report $report
    if ($Once -or ($deadline -and (Get-Date) -ge $deadline)) { break }
    Start-Sleep -Seconds $IntervalSeconds
} while ($true)

# THE EXIT CODE MUST REFLECT overallHealthy. Before this block, the word "exit"
# did not appear anywhere in this file: the supervisor computed a correct,
# careful health verdict, wrote it to JSON, and then exited 0 unconditionally.
#
# The consequence was not theoretical. The scheduled task that runs this every
# two minutes reported LastTaskResult=0 while port 8787 had no listener at all.
# A keeper whose success signal cannot depend on what it keeps is not a keeper;
# it is a log writer with a reassuring exit code, and every operator and every
# dashboard reading that task result was being told the link was fine.
#
# This is the same defect family as an assertion that cannot fail: the check was
# real, the reporting channel was hollow, and the hollow half is what anything
# downstream actually consumed.
#
# Deliberately NOT gated on a config flag. A health signal that can be switched
# off silently is the defect this fixes, one level up.
#
# 0 = every enabled component present, owned and healthy (and every disabled one
#     genuinely absent). 1 = anything else, including a failed probe. A stop
#     sentinel is a deliberate operator choice, not a fault, so it exits 0.
if ($null -eq $lastReport) {
    # The stop sentinel was present before the first cycle: switched off on
    # purpose, which is a healthy state, not a failure.
    exit 0
}
if ([bool]$lastReport.overallHealthy) { exit 0 }
exit 1
