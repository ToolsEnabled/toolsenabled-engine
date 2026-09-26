# A small, idempotent control surface for the direct-Ethernet tunnel and
# remote-agent bridge.  ServerControl calls this file; it deliberately keeps
# lifecycle authority in bridge-session-supervisor.ps1 instead of treating
# 8787/8788 as ordinary dev-server ports.
#
# "STOPPED" USED TO BE A LABEL, NOT AN OBSERVATION.
#
# Invoke-Stop returned action='stopped'/'component_stopped' whatever the
# listeners actually did, and the script exited 0 either way. Reproduced on
# 2026-08-09 in an isolated copy of this file (lab ports 18787/18788 on
# 127.0.0.1, own disposable listener, the live 8787/8788 lanes untouched):
#   operation: {"action":"component_stopped", ...,
#               "listeners":[{"component":"remoteBridge","action":"blocked_conflict"}]}
#   exit code: 0
# while the listener was still bound and serving. The per-listener row was
# truthful and the operation's own verdict contradicted it, so anything reading
# the summary or the exit code -- an operator, a panel, a scheduled task -- was
# told the component had been stopped.
#
# Two things changed. Stop-ExactListeners no longer calls Stop-Process a
# success: it waits, bounded, for the listener to actually go absent. And the
# operation's action/ok/reason are now DERIVED from those measured results
# instead of asserted alongside them.
#
# EXIT CODES. Status is a report and still exits 0 in all cases -- its verdict
# is the overallHealthy field, and turning a read-only status probe into a
# failing command would break the "run it to see" contract. The MUTATING actions
# (Start/Stop/Restart/Reconcile) exit 1 when operation.ok is false, i.e. when the
# thing they were asked to do demonstrably did not happen. 1 is also the existing
# code for control_failed, so a caller that already treats non-zero as "did not
# work" needs no change.
#
# ASCII only: PowerShell 5.1 on this machine mis-parses non-ASCII characters.
[CmdletBinding()]
param(
    [ValidateSet('Status', 'Start', 'Stop', 'Restart', 'Reconcile')]
    [string]$Action = 'Status',
    [ValidateSet('Both', 'Tunnel', 'Bridge')]
    [Alias('Component')]
    [string]$ComponentSelection = 'Both',
    [switch]$Startup
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
$Supervisor = Join-Path $Root 'tools\bridge-session-supervisor.ps1'
$KeeperTask = Join-Path $Root 'tools\tunnel-bridge-keeper-task.ps1'
$ManagedRegistryPath = Join-Path $Root 'config\managed-processes.json'
if (-not (Test-Path -LiteralPath $ManagedRegistryPath -PathType Leaf)) { throw 'MANAGED_PROCESS_REGISTRY_UNAVAILABLE' }
$ManagedKeeper = (Get-Content -Raw -LiteralPath $ManagedRegistryPath | ConvertFrom-Json).processes.'tunnel-bridge-keeper'
$KeeperTaskName = [string]$ManagedKeeper.taskName
if ([string]::IsNullOrWhiteSpace($KeeperTaskName)) { throw 'TUNNEL_BRIDGE_KEEPER_TASK_NAME_MISSING' }
$Preflight = Join-Path $Root 'tools\tunnel-bridge-preflight.js'
$Probe = Join-Path $Root 'tools\tunnel-bridge-health.js'
$StateDir = Join-Path $Root 'state'
$LogDir = Join-Path $Root 'logs'
$StopFile = Join-Path $StateDir 'tunnel-bridge-supervisor.stop'
$ComponentStopFiles = [ordered]@{
    linkBus = Join-Path $StateDir 'tunnel-bridge-linkbus.stop'
    remoteBridge = Join-Path $StateDir 'tunnel-bridge-remote-bridge.stop'
}
$ControlLog = Join-Path $LogDir 'tunnel-bridge-control.log'
$StartMutexName = 'Global\ToolsEnabledTunnelBridgeControlStart'

function Get-TunnelBridgeReadiness {
    if (-not (Test-Path -LiteralPath $Preflight -PathType Leaf)) {
        return [pscustomobject]@{ ok = $false; code = 'TUNNEL_BRIDGE_PREFLIGHT_MISSING'; secretValuesEmitted = $false }
    }
    $raw = @(& $Node $Preflight '--json' 2>$null) -join "`n"
    $exitCode = $LASTEXITCODE
    try { $value = $raw | ConvertFrom-Json -ErrorAction Stop }
    catch { return [pscustomobject]@{ ok = $false; code = 'TUNNEL_BRIDGE_PREFLIGHT_FAILED'; secretValuesEmitted = $false } }
    if ($exitCode -eq 0 -and $value.ok -eq $true) { return $value }
    $code = [string]$value.code
    if ($code -notmatch '^TUNNEL_BRIDGE_[A-Z0-9_]{3,80}$') { $code = 'TUNNEL_BRIDGE_PREFLIGHT_FAILED' }
    return [pscustomobject]@{ ok = $false; code = $code; secretValuesEmitted = $false }
}

$Readiness = Get-TunnelBridgeReadiness
$Topology = $null
try { $Topology = Resolve-ServiceRegistryTopology -Root $Root } catch { }
if ($null -eq $Topology) {
    $stopRequested = $false
    if ($Action -eq 'Stop') {
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
        New-Item -ItemType File -Path $StopFile -Force | Out-Null
        try { & $KeeperTask -StopNow | Out-Null; $stopRequested = $true } catch { }
    }
    [ordered]@{
        schemaVersion = 'tunnel-bridge-control.v1'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        action = $Action
        component = $ComponentSelection
        startup = [bool]$Startup
        configured = $false
        readinessCode = [string]$Readiness.code
        overallHealthy = $false
        stopRequested = $stopRequested
        operation = if ($Action -eq 'Status') { $null } else {
            [ordered]@{
                action = if ($Action -eq 'Stop') { 'stop_recorded_identity_unavailable' } else { 'setup_required' }
                ok = $false
                reason = [string]$Readiness.code
            }
        }
        auditKeyAction = 'none'
        secretValuesEmitted = $false
    } | ConvertTo-Json -Depth 8 -Compress
    if ($Action -eq 'Status') { exit 0 }
    exit 1
}
$HostName = [string]$Topology.localMachine.address

$Components = @(
    [pscustomobject]@{
        Name = 'linkBus'
        Port = 8787
        Script = Join-Path $Root 'sidecars\link-bus\server.js'
    },
    [pscustomobject]@{
        Name = 'remoteBridge'
        Port = 8788
        Script = Join-Path $Root 'src\remote-agent-bridge.js'
    }
)

function Get-SelectedComponentNames {
    switch ($ComponentSelection) {
        'Tunnel' { return @('linkBus') }
        'Bridge' { return @('remoteBridge') }
        default { return @('linkBus', 'remoteBridge') }
    }
}

function Test-ComponentStopRequested {
    param([Parameter(Mandatory)][string]$Name)
    return Test-Path -LiteralPath $ComponentStopFiles[$Name]
}

function Get-ExactListener {
    param([Parameter(Mandatory)][pscustomobject]$Component)

    # Inventory the whole port. Filtering by the expected address hides a
    # wildcard or wrong-address owner and can turn a real conflict into an
    # "absent" status or a false-success stop.
    $listeners = @(Get-NetTCPConnection -LocalPort $Component.Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        return [pscustomobject]@{ state = 'absent'; pid = $null; owned = $false; reason = $null }
    }
    if ($listeners.Count -ne 1 -or [string]$listeners[0].LocalAddress -cne $HostName) {
        return [pscustomobject]@{ state = 'conflict'; pid = $null; owned = $false; reason = 'listener_tuple_mismatch' }
    }

    $ownerPid = [int]$listeners[0].OwningProcess
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
    $commandLine = if ($owner) { [string]$owner.CommandLine } else { '' }
    # UNVERIFIABLE IS A THIRD STATE. An empty CommandLine means an unelevated
    # read could not see into another session (every S4U task), not that this is
    # someone else's listener. Reporting listener_identity_mismatch for it is
    # true of the CODE and false about the WORLD, and callers read the boolean.
    $identityReadable = -not [string]::IsNullOrWhiteSpace($commandLine)
    $nodeOk = [bool]($owner -and
        ([string]$owner.ExecutablePath).Equals([IO.Path]::GetFullPath($Node), [StringComparison]::OrdinalIgnoreCase))
    $owned = [bool]($nodeOk -and $identityReadable -and
        $commandLine.IndexOf([IO.Path]::GetFullPath($Component.Script), [StringComparison]::OrdinalIgnoreCase) -ge 0)
    $unverifiable = [bool]($owner -and -not $identityReadable)
    return [pscustomobject]@{
        state = if ($owned) { 'owned' } elseif ($unverifiable) { 'unverifiable' } else { 'conflict' }
        pid = $ownerPid
        owned = $owned
        reason = if ($owned) { $null } elseif ($unverifiable) { 'listener_identity_unreadable' } else { 'listener_identity_mismatch' }
    }
}

function Get-ExactSupervisor {
    $needle = [IO.Path]::GetFullPath($Supervisor)
    $foundSupervisors = @()
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue)) {
        $commandLine = [string]$process.CommandLine
        if ($commandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $commandLine -match '(?i)(^|\s)-File\s+[^\s]*bridge-session-supervisor\.ps1') {
            $foundSupervisors += [pscustomobject]@{ pid = [int]$process.ProcessId; commandLine = $commandLine }
        }
    }
    return @($foundSupervisors)
}

function Invoke-HealthProbe {
    if (-not (Test-Path -LiteralPath $Node -PathType Leaf) -or -not (Test-Path -LiteralPath $Probe -PathType Leaf)) {
        return [pscustomobject]@{ overallHealthy = $false; error = 'probe_missing' }
    }
    try {
        $raw = @(& $Node $Probe 2>$null) -join "`n"
        if ([string]::IsNullOrWhiteSpace($raw)) { return [pscustomobject]@{ overallHealthy = $false; error = 'probe_no_output' } }
        return ($raw | ConvertFrom-Json)
    } catch {
        return [pscustomobject]@{ overallHealthy = $false; error = 'probe_failed' }
    }
}

function Get-StatusReport {
    $health = Invoke-HealthProbe
    $supervisors = @(Get-ExactSupervisor)
    $keeperTask = Get-ScheduledTask -TaskName $KeeperTaskName -ErrorAction SilentlyContinue
    $keeperRunning = [bool]($keeperTask -and [string]$keeperTask.State -eq 'Running')
    $componentReports = [ordered]@{}
    foreach ($component in $Components) {
        $identity = Get-ExactListener -Component $component
        $probeProperty = if ($health.components) { $health.components.PSObject.Properties[$component.Name] } else { $null }
        $stopRequested = [bool](Test-Path -LiteralPath $ComponentStopFiles[$component.Name]) -or
            [bool](Test-Path -LiteralPath $StopFile)
        $desiredState = if ($stopRequested) { 'disabled' } else { 'enabled' }
        $healthy = [bool]($probeProperty -and $probeProperty.Value.ok -eq $true)
        $operational = if ($desiredState -eq 'disabled') {
            $identity.state -eq 'absent'
        } else {
            [bool]($identity.owned -and $healthy)
        }
        $componentReports[$component.Name] = [ordered]@{
            host = $HostName
            port = $component.Port
            listenerState = $identity.state
            pid = $identity.pid
            owned = [bool]$identity.owned
            healthy = $healthy
            desiredState = $desiredState
            stopRequested = $stopRequested
            operational = $operational
            reason = $identity.reason
        }
    }
    $globalStopRequested = Test-Path -LiteralPath $StopFile
    $overall = [bool]($Readiness.ok -eq $true -and -not $globalStopRequested -and $keeperRunning -and
        ($componentReports.Values | Where-Object { -not $_.operational }).Count -eq 0)
    return [ordered]@{
        schemaVersion = 'tunnel-bridge-control.v1'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        action = $Action
        component = $ComponentSelection
        startup = [bool]$Startup
        root = $Root
        rootExists = Test-Path -LiteralPath $Root -PathType Container
        configured = [bool]($Readiness.ok -eq $true)
        readinessCode = [string]$Readiness.code
        supervisor = [ordered]@{
            count = $supervisors.Count
            running = $keeperRunning
            taskState = if ($keeperTask) { [string]$keeperTask.State } else { 'NotRegistered' }
            pids = @($supervisors | ForEach-Object { $_.pid })
        }
        components = $componentReports
        health = [ordered]@{
            overallHealthy = [bool]($health.overallHealthy -eq $true)
            error = if ($health.error) { [string]$health.error } else { $null }
        }
        overallHealthy = $overall
        stopRequested = $globalStopRequested
        componentStopFiles = [ordered]@{
            linkBus = [bool](Test-Path -LiteralPath $ComponentStopFiles.linkBus)
            remoteBridge = [bool](Test-Path -LiteralPath $ComponentStopFiles.remoteBridge)
        }
        auditKeyAction = 'none'
        secretValuesEmitted = $false
    }
}

function Write-ControlLog {
    param([string]$Line)
    try {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
        Add-Content -LiteralPath $ControlLog -Value ("{0}  {1}" -f (Get-Date).ToUniversalTime().ToString('o'), $Line) -Encoding UTF8
    } catch {}
}

function Start-ExactSupervisor {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    if (-not (Test-Path -LiteralPath $Supervisor -PathType Leaf)) { throw 'SUPERVISOR_MISSING' }
    if (-not (Test-Path -LiteralPath $KeeperTask -PathType Leaf)) { throw 'TUNNEL_BRIDGE_KEEPER_REGISTRAR_MISSING' }

    $mutex = New-Object System.Threading.Mutex($false, $StartMutexName)
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'START_CONTROL_BUSY' }
        $taskBefore = Get-ScheduledTask -TaskName $KeeperTaskName -ErrorAction SilentlyContinue
        if ($taskBefore -and [string]$taskBefore.State -eq 'Running') {
            return [pscustomobject]@{ action = 'already_running'; pids = @() }
        }
        & $KeeperTask -StartNow | Out-Null
        $deadline = (Get-Date).AddSeconds(10)
        do {
            $taskAfter = Get-ScheduledTask -TaskName $KeeperTaskName -ErrorAction SilentlyContinue
            if ($taskAfter -and [string]$taskAfter.State -eq 'Running') {
                Write-ControlLog 'started managed tunnel-bridge keeper task'
                return [pscustomobject]@{ action = 'started'; pids = @() }
            }
            Start-Sleep -Milliseconds 250
        } while ((Get-Date) -lt $deadline)
        return [pscustomobject]@{ action = 'start_unverified'; pids = @() }
    } finally {
        if ($locked) { try { $mutex.ReleaseMutex() } catch {} }
        $mutex.Dispose()
    }
}

function Stop-ExactSupervisor {
    # Returns what was stopped AND what refused. The refusals used to exist only
    # in the log, so the caller could not tell a clean stop from a partial one.
    try {
        & $KeeperTask -StopNow | Out-Null
        Write-ControlLog 'stopped managed tunnel-bridge keeper task'
        return [pscustomobject]@{ stopped = @(); failed = @() }
    } catch {
        Write-ControlLog 'managed tunnel-bridge keeper stop refused'
        return [pscustomobject]@{ stopped = @(); failed = @('task') }
    }
}

# The only two listener outcomes that mean "this component is not listening any
# more". Everything else is a refusal or an unverified attempt.
$Script:ListenerStopSucceeded = @('already_absent', 'stopped')

function Stop-ExactListeners {
    param([string[]]$ComponentNames)
    if (-not $ComponentNames -or $ComponentNames.Count -eq 0) {
        $ComponentNames = @(Get-SelectedComponentNames)
    }
    $results = @()
    foreach ($component in ($Components | Where-Object { $ComponentNames -contains $_.Name })) {
        $identity = Get-ExactListener -Component $component
        if ($identity.state -eq 'absent') {
            $results += [pscustomobject]@{ component = $component.Name; action = 'already_absent' }
            continue
        }
        if (-not $identity.owned) {
            # UNREADABLE AND WRONG-OWNER ARE DIFFERENT REFUSALS. Get-ExactListener
            # already separates them; collapsing both into 'blocked_conflict' told
            # the operator "someone else's process" about a listener whose identity
            # merely could not be read from this token.
            $blocked = if ($identity.state -eq 'unverifiable') { 'blocked_unverifiable' } else { 'blocked_conflict' }
            $results += [pscustomobject]@{ component = $component.Name; action = $blocked; pid = $identity.pid; reason = $identity.reason }
            continue
        }
        try {
            Stop-Process -Id ([int]$identity.pid) -ErrorAction Stop
        } catch {
            $results += [pscustomobject]@{ component = $component.Name; action = 'stop_failed'; pid = [int]$identity.pid }
            continue
        }
        # Stop-Process returning is not the port going quiet. Wait, bounded, for
        # the listener to actually disappear before calling this a stop.
        $released = $false
        $deadline = (Get-Date).AddSeconds(5)
        while ($true) {
            if ((Get-ExactListener -Component $component).state -eq 'absent') { $released = $true; break }
            if ((Get-Date) -ge $deadline) { break }
            Start-Sleep -Milliseconds 250
        }
        $results += [pscustomobject]@{
            component = $component.Name
            action = if ($released) { 'stopped' } else { 'stop_timeout' }
            pid = [int]$identity.pid
        }
    }
    return @($results)
}

function Get-ListenerStopFailures {
    param($Results)
    return @(@($Results) | Where-Object { $Script:ListenerStopSucceeded -notcontains $_.action } |
        ForEach-Object { "{0}:{1}" -f $_.component, $_.action })
}

function Invoke-Start {
    if ($ComponentSelection -eq 'Both') {
        if (Test-Path -LiteralPath $StopFile) { Remove-Item -LiteralPath $StopFile -Force -ErrorAction Stop }
        foreach ($stopPath in $ComponentStopFiles.Values) {
            if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath -Force -ErrorAction Stop }
        }
    } else {
        if (Test-Path -LiteralPath $StopFile) { throw 'GLOBAL_STOP_REQUESTED_USE_BOTH_START' }
        foreach ($name in (Get-SelectedComponentNames)) {
            $stopPath = $ComponentStopFiles[$name]
            if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath -Force -ErrorAction Stop }
        }
    }
    $started = Start-ExactSupervisor
    return [pscustomobject]@{
        action = $started.action
        pids = @($started.pids)
        ok = [bool]($started.action -in @('started', 'already_running'))
        reason = if ($started.action -in @('started', 'already_running')) { $null } else { [string]$started.action }
    }
}

function Invoke-Stop {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    if ($ComponentSelection -eq 'Both') {
        New-Item -ItemType File -Path $StopFile -Force | Out-Null
        $supervisorStop = Stop-ExactSupervisor
        $listeners = Stop-ExactListeners -ComponentNames (Get-SelectedComponentNames)
        Write-ControlLog 'stop requested for exact supervisor/listener identities'
        $failures = @(Get-ListenerStopFailures -Results $listeners)
        if ($supervisorStop.failed.Count -gt 0) { $failures += ("supervisor:refused_pids_" + ($supervisorStop.failed -join '_')) }
        $ok = ($failures.Count -eq 0)
        Write-ControlLog ("stop outcome ok={0} detail={1}" -f $ok, (($failures -join ',') -replace '\s', '_'))
        return [pscustomobject]@{
            action = if ($ok) { 'stopped' } else { 'stop_incomplete' }
            ok = $ok
            reason = if ($ok) { $null } else { $failures -join ',' }
            component = 'Both'
            supervisorPids = @($supervisorStop.stopped)
            supervisorStopFailedPids = @($supervisorStop.failed)
            listeners = @($listeners)
        }
    }

    if (Test-Path -LiteralPath $StopFile) { throw 'GLOBAL_STOP_REQUESTED_USE_BOTH_START' }
    $stopPaths = @()
    foreach ($name in (Get-SelectedComponentNames)) {
        $stopPath = $ComponentStopFiles[$name]
        New-Item -ItemType File -Path $stopPath -Force | Out-Null
        $stopPaths += $stopPath
    }
    $listeners = Stop-ExactListeners -ComponentNames (Get-SelectedComponentNames)
    $supervisor = Start-ExactSupervisor
    Write-ControlLog ("stop requested for component={0}" -f $ComponentSelection)
    # The stop file is written either way -- the desired state IS recorded, and
    # the supervisor will keep trying. What must not be claimed is that the
    # selected listener is down when it is still bound.
    $failures = @(Get-ListenerStopFailures -Results $listeners)
    $ok = ($failures.Count -eq 0)
    Write-ControlLog ("stop outcome component={0} ok={1} detail={2}" -f $ComponentSelection, $ok, (($failures -join ',') -replace '\s', '_'))
    return [pscustomobject]@{
        action = if ($ok) { 'component_stopped' } else { 'component_stop_incomplete' }
        ok = $ok
        reason = if ($ok) { $null } else { $failures -join ',' }
        component = $ComponentSelection
        supervisor = $supervisor
        stopFiles = @($stopPaths)
        listeners = @($listeners)
    }
}

function Invoke-Restart {
    if ($ComponentSelection -eq 'Both') {
        $stop = Invoke-Stop
        $start = Invoke-Start
        $restartFailures = @()
        if (-not $stop.ok) { $restartFailures += ("stop:" + [string]$stop.reason) }
        if (-not $start.ok) { $restartFailures += ("start:" + [string]$start.reason) }
        return [ordered]@{
            action = if ($restartFailures.Count -eq 0) { 'restarted' } else { 'restart_incomplete' }
            ok = ($restartFailures.Count -eq 0)
            reason = if ($restartFailures.Count -eq 0) { $null } else { $restartFailures -join ',' }
            stop = $stop
            start = $start
        }
    }
    if (Test-Path -LiteralPath $StopFile) { throw 'GLOBAL_STOP_REQUESTED_USE_BOTH_START' }
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    $stopPaths = @()
    foreach ($name in (Get-SelectedComponentNames)) {
        $stopPath = $ComponentStopFiles[$name]
        New-Item -ItemType File -Path $stopPath -Force | Out-Null
        $stopPaths += $stopPath
    }
    try {
        $listeners = Stop-ExactListeners -ComponentNames (Get-SelectedComponentNames)
    } finally {
        foreach ($stopPath in $stopPaths) {
            if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue }
        }
    }
    $start = Start-ExactSupervisor
    Write-ControlLog ("restart requested for component={0}" -f $ComponentSelection)
    $failures = @(Get-ListenerStopFailures -Results $listeners)
    if ($start.action -notin @('started', 'already_running')) { $failures += ("start:" + [string]$start.action) }
    $ok = ($failures.Count -eq 0)
    Write-ControlLog ("restart outcome component={0} ok={1} detail={2}" -f $ComponentSelection, $ok, (($failures -join ',') -replace '\s', '_'))
    return [ordered]@{
        action = if ($ok) { 'component_restarted' } else { 'component_restart_incomplete' }
        ok = $ok
        reason = if ($ok) { $null } else { $failures -join ',' }
        component = $ComponentSelection
        listeners = @($listeners)
        start = $start
    }
}

function Invoke-Reconcile {
    if (Test-Path -LiteralPath $StopFile) {
        # A stop sentinel is a deliberate operator choice, not a fault, so this
        # is ok:true with the reason named -- the same rule the supervisor's own
        # exit code uses. It is reported, not silently swallowed.
        return [pscustomobject]@{ action = 'blocked_stop_requested'; ok = $true; reason = 'stop_requested' }
    }
    $keeperTask = Get-ScheduledTask -TaskName $KeeperTaskName -ErrorAction SilentlyContinue
    if ($keeperTask -and [string]$keeperTask.State -eq 'Running') {
        return [pscustomobject]@{ action = 'supervisor_already_running'; ok = $true; reason = $null; pids = @() }
    }
    $started = Start-ExactSupervisor
    $ok = $started.action -in @('started', 'already_running')
    return [pscustomobject]@{
        action = if ($ok) { 'reconcile_started' } else { 'reconcile_start_unverified' }
        ok = $ok
        reason = if ($ok) { $null } else { [string]$started.action }
    }
}

try {
    if ($Action -in @('Start', 'Restart', 'Reconcile') -and $Readiness.ok -ne $true) {
        throw [string]$Readiness.code
    }
    switch ($Action) {
        'Status' { $result = Get-StatusReport }
        'Start' {
            $operation = Invoke-Start
            $result = Get-StatusReport
            $result.operation = $operation
        }
        'Stop' {
            $operation = Invoke-Stop
            $result = Get-StatusReport
            $result.operation = $operation
        }
        'Restart' {
            $operation = Invoke-Restart
            $result = Get-StatusReport
            $result.operation = $operation
        }
        'Reconcile' {
            $operation = Invoke-Reconcile
            $result = Get-StatusReport
            $result.operation = $operation
        }
    }
    # THE EXIT CODE FOLLOWS THE OPERATION, NOT THE FACT THAT WE REACHED THIS LINE.
    # Status keeps its unconditional 0 on purpose: it is a report, its verdict is
    # in overallHealthy, and a status probe that exits non-zero when the thing it
    # reports on is down cannot be distinguished from a status probe that failed
    # to run -- which is this very defect, one layer up.
    $operationFailed = ($Action -ne 'Status' -and $null -ne $result.operation -and $result.operation.ok -ne $true)
    $result | ConvertTo-Json -Depth 12 -Compress
    if ($operationFailed) { exit 1 }
} catch {
    [ordered]@{
        schemaVersion = 'tunnel-bridge-control.v1'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        action = $Action
        startup = [bool]$Startup
        overallHealthy = $false
        error = 'control_failed'
        errorCode = if ($_.Exception.Message) { ($_.Exception.Message -replace '[^A-Za-z0-9_.-]', '_') } else { 'unknown' }
        errorLine = if ($_.InvocationInfo.ScriptLineNumber) { [int]$_.InvocationInfo.ScriptLineNumber } else { $null }
        auditKeyAction = 'none'
        secretValuesEmitted = $false
    } | ConvertTo-Json -Depth 8 -Compress
    exit 1
}
