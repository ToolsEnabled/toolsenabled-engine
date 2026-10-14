[CmdletBinding()]
param(
    [ValidateSet('Status', 'Reconcile', 'RotateOnce', 'RetireRolledBackRecovery', 'InstallTask', 'RemoveTask')]
    [string]$Action = 'Status',
    [string]$OperationId = $null,
    [string]$Fingerprint = $null
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$RegistryHelper = Join-Path $Root 'tools\lib\service-registry.ps1'
if (-not (Test-Path -LiteralPath $RegistryHelper -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $RegistryHelper
$ResolveNodeHelper = Join-Path $Root 'tools\lib\resolve-node.ps1'
if (-not (Test-Path -LiteralPath $ResolveNodeHelper -PathType Leaf)) { throw 'NODE_22_19_OR_NEWER_MISSING' }
. $ResolveNodeHelper
# Version-checked, not just a Test-Path binary choice -- see
# tools/lib/resolve-node.ps1's header for why a stale-but-present Program
# Files node must not qualify silently. This was previously an unconditional
# literal with no fallback at all, so on any machine without node installed
# at exactly that path, the required-dependency check below threw
# FRA_LIFECYCLE_DEPENDENCY_MISSING and the whole FRA Lifecycle scheduled task
# hard-failed.
$Node = Resolve-ToolsEnabledNode -Root $Root
$WindowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Controller = Join-Path $Root 'tools\full-remote-access-control.ps1'
$Helper = Join-Path $Root 'tools\fra-token-enrollment-lifecycle.js'
$HeartbeatHelper = Join-Path $Root 'tools\fra-peer-heartbeat.js'
$TunnelProbe = Join-Path $Root 'tools\link-bus-peer-status.js'
$TunnelNotice = Join-Path $Root 'tools\fra-lifecycle-tunnel-notice.js'
$StateFile = Join-Path $Root 'state\full-remote-access-lifecycle.json'
$StopFile = Join-Path $Root 'state\full-remote-access.stop'
$TaskName = 'ToolsEnabled FRA Lifecycle'
$MutexName = 'Global\ToolsEnabledFullRemoteAccessLifecycle'
$EnrollmentPort = 8794
$TransactionStaleMilliseconds = 20 * 60 * 1000
$UnhealthyRestartThreshold = 2
$AddressPolicy = Read-ToolsEnabledServiceRegistry -Root $Root
$RootMatches = @($AddressPolicy.machines | Where-Object {
    -not [string]::IsNullOrWhiteSpace([string]$_.root) -and
    ([IO.Path]::GetFullPath([string]$_.root)).Equals($Root, [StringComparison]::OrdinalIgnoreCase)
})
if ($RootMatches.Count -ne 1) { throw 'FRA_LIFECYCLE_ROOT_INVALID' }
$Topology = Resolve-ServiceRegistryDirectionalTopology -Root $Root
if ($Topology.localMachine.machineId -cne $RootMatches[0].machineId) { throw 'FRA_LIFECYCLE_ROOT_INVALID' }
$HostName = [string]$Topology.localMachine.address
$PeerHost = [string]$Topology.peerMachine.address
$MachineAAddress = [string]$Topology.coordinatorMachine.address
$MachineBAddress = [string]$Topology.recipientMachine.address
$Role = if ($Topology.localRole -ceq 'recipient') { 'b' } else { 'a' }

foreach ($required in @($Node, $WindowsPowerShell, $Controller, $Helper, $HeartbeatHelper, $TunnelProbe, $TunnelNotice)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw 'FRA_LIFECYCLE_DEPENDENCY_MISSING' }
}

function Get-SafeCode {
    param($Value, [string]$Fallback = 'FRA_LIFECYCLE_FAILED')
    $candidate = if ($null -ne $Value -and $null -ne $Value.code) { [string]$Value.code }
        elseif ($null -ne $Value -and $null -ne $Value.errorCode) { [string]$Value.errorCode }
        elseif ($Value -is [string]) { [string]$Value }
        else { '' }
    if ($candidate -match '^[A-Z0-9_.-]{1,100}$') { return $candidate }
    return $Fallback
}

function Invoke-HiddenProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int]$TimeoutMilliseconds = 240000,
        [hashtable]$Environment = @{}
    )
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $FilePath
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.WorkingDirectory = $Root
    foreach ($argument in $Arguments) {
        if ($argument -match '["\r\n]') { throw 'FRA_LIFECYCLE_ARGUMENT_UNSAFE' }
    }
    $start.Arguments = (($Arguments | ForEach-Object { '"' + [string]$_ + '"' }) -join ' ')
    foreach ($key in $Environment.Keys) { $start.EnvironmentVariables[[string]$key] = [string]$Environment[$key] }
    $process = [Diagnostics.Process]::new()
    try {
        $process.StartInfo = $start
        if (-not $process.Start()) { throw 'FRA_LIFECYCLE_PROCESS_START_FAILED' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMilliseconds)) {
            try { $process.Kill() } catch {}
            throw 'FRA_LIFECYCLE_PROCESS_TIMEOUT'
        }
        [void][Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask), 10000)
        if (-not $stdoutTask.IsCompleted -or -not $stderrTask.IsCompleted) {
            # The process itself already exited (WaitForExit above returned
            # true), but a descendant it spawned can inherit the redirected
            # stdout/stderr pipe handle and keep the write end open, so
            # ReadToEndAsync() never sees EOF. Task<T>.Result blocks the
            # calling thread with NO further timeout once that happens, which
            # would silently defeat $TimeoutMilliseconds for every caller.
            # Never touch .Result on a task that is not IsCompleted -- throw a
            # distinct, narrow error instead and let the caller's normal
            # reconcile-and-verify cycle discover and handle whatever
            # real-world condition caused it. No process-tree cleanup here:
            # this same function also backs the intentional long-lived
            # listener Start/Restart paths, and killing descendants on a
            # stream-drain timeout risks killing that listener.
            throw 'FRA_LIFECYCLE_PROCESS_STREAM_DRAIN_TIMEOUT'
        }
        $stdout = [string]$stdoutTask.Result
        $stderr = [string]$stderrTask.Result
        if ([Text.Encoding]::UTF8.GetByteCount($stdout) -gt 262144 -or
            [Text.Encoding]::UTF8.GetByteCount($stderr) -gt 262144) { throw 'FRA_LIFECYCLE_PROCESS_OUTPUT_TOO_LARGE' }
        return [pscustomobject]@{ exitCode = $process.ExitCode; stdout = $stdout; stderr = $stderr }
    } finally { $process.Dispose() }
}

function Convert-LastJson {
    param([string]$Text)
    $lines = @($Text -split "`r?`n" | Where-Object { $_.Trim() })
    for ($index = $lines.Count - 1; $index -ge 0; $index--) {
        try { return ($lines[$index] | ConvertFrom-Json) } catch {}
    }
    return $null
}

function Invoke-Control {
    param(
        [ValidateSet('Status', 'EnrollmentStatus', 'CloseEnrollment', 'Start', 'Stop', 'Restart')][string]$ControlAction,
        [string]$OperationId = $null,
        [string]$Fingerprint = $null
    )
    $arguments = @(
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', $Controller, '-Action', $ControlAction
    )
    if ($ControlAction -eq 'CloseEnrollment') {
        if ($HostName -cne $MachineBAddress -or $OperationId -notmatch '^[A-Za-z0-9_-]{22}$' -or $Fingerprint -notmatch '^[A-Za-z0-9_-]{43}$') {
            throw 'FRA_LIFECYCLE_CLOSE_RECEIVER_CORRELATION_INVALID'
        }
        $arguments += @('-OperationId', $OperationId, '-Fingerprint', $Fingerprint)
    } elseif (-not [string]::IsNullOrEmpty($OperationId) -or -not [string]::IsNullOrEmpty($Fingerprint)) {
        throw 'FRA_LIFECYCLE_CONTROL_ARGUMENT_INVALID'
    }
    $result = Invoke-HiddenProcess -FilePath $WindowsPowerShell -Arguments $arguments -TimeoutMilliseconds 300000
    $parsed = Convert-LastJson $result.stdout
    if ($null -eq $parsed -or $parsed.secretValuesEmitted -ne $false) { throw 'FRA_LIFECYCLE_CONTROL_OUTPUT_INVALID' }
    if ($result.exitCode -ne 0) { throw (Get-SafeCode $parsed 'FRA_LIFECYCLE_CONTROL_FAILED') }
    $expectedSchema = if ($ControlAction -eq 'EnrollmentStatus') { 'full-remote-access-enrollment-status.v1' } else { 'full-remote-access-control.v2' }
    if ($parsed.schemaVersion -ne $expectedSchema -or $parsed.host -ne $HostName) { throw 'FRA_LIFECYCLE_CONTROL_OUTPUT_INVALID' }
    return $parsed
}

function Invoke-Helper {
    param([string[]]$Arguments, [int]$TimeoutMilliseconds = 240000)
    $result = Invoke-HiddenProcess -FilePath $Node -Arguments (@($Helper) + $Arguments) -TimeoutMilliseconds $TimeoutMilliseconds
    $parsed = Convert-LastJson $result.stdout
    if ($null -eq $parsed -or $parsed.secretValuesEmitted -ne $false) {
        return [pscustomobject]@{ ok = $false; code = 'FRA_LIFECYCLE_HELPER_OUTPUT_INVALID'; secretValuesEmitted = $false }
    }
    if ($result.exitCode -ne 0 -and $null -eq $parsed.ok) { $parsed | Add-Member -NotePropertyName ok -NotePropertyValue $false }
    return $parsed
}

function Invoke-PeerHeartbeat {
    # Same shell-out-and-parse pattern as Invoke-Helper above, pointed at the
    # dedicated heartbeat CLI instead of the enrollment-lifecycle helper: one
    # real secure round trip (handshake + initialize + tools/list + a tiny
    # read-only tools/call, now with one internal retry on a transient
    # transport failure -- see tools/fra-peer-heartbeat.js), never crypto
    # reimplemented here.
    #
    # This wrapper's own kill deadline must exceed the helper's internal
    # TOTAL_TIMEOUT_MS (tools/fra-peer-heartbeat.js) with real margin --
    # otherwise this outer Stop-Process fires first, the helper never gets to
    # return its own structured FRA_HEARTBEAT_TIMEOUT result, and the failure
    # is reported as a generic process-kill rather than the heartbeat's own
    # diagnosis.
    #
    # RAISED 2026-08-04 from 270000 to 450000: TOTAL_TIMEOUT_MS itself was
    # raised from 240s to 420s (now covers the helper's own original attempt
    # PLUS its one retry, combined, under a single shared deadline -- see
    # that file's header comment for the full measured-data rationale). This
    # wrapper deadline keeps the same real margin over it that 270000 kept
    # over the old 240000 (30s here too), so the outer kill still cannot fire
    # before the helper's own structured result is produced.
    $result = Invoke-HiddenProcess -FilePath $Node -Arguments @($HeartbeatHelper,'--host',$HostName) -TimeoutMilliseconds 450000
    $parsed = Convert-LastJson $result.stdout
    if ($null -eq $parsed -or $parsed.secretValuesEmitted -ne $false) {
        return [pscustomobject]@{ ok = $false; code = 'FRA_LIFECYCLE_HEARTBEAT_OUTPUT_INVALID'; secretValuesEmitted = $false }
    }
    if ($result.exitCode -ne 0 -and $null -eq $parsed.ok) { $parsed | Add-Member -NotePropertyName ok -NotePropertyValue $false }
    return $parsed
}

function Invoke-RetireRolledBackRecovery {
    # This is an explicit, correlated operator recovery action. Reconcile never
    # calls it automatically: rolled-back evidence remains preserved until a
    # human-reviewed recovery decision names the exact transaction tuple.
    if ($OperationId -notmatch '^[A-Za-z0-9_-]{22}$' -or $Fingerprint -notmatch '^[A-Za-z0-9_-]{43}$') {
        throw 'FRA_LIFECYCLE_RECOVERY_CORRELATION_INVALID'
    }
    $transaction = Invoke-Helper @('--transaction-status','--host',$HostName,'--port','8794') -TimeoutMilliseconds 120000
    if ($transaction.phase -ne 'rolled_back') { throw 'FRA_LIFECYCLE_RECOVERY_PHASE_INVALID' }
    if ($transaction.operationId -cne $OperationId -or $transaction.newFingerprint -cne $Fingerprint) {
        throw 'FRA_LIFECYCLE_TRANSACTION_MISMATCH'
    }
    $retired = Invoke-Helper @(
        '--retire-rolled-back-recovery','--host',$HostName,'--port','8794',
        '--operation-id',$OperationId,'--fingerprint',$Fingerprint
    ) -TimeoutMilliseconds 120000
    if (-not $retired.ok -or $retired.recoveryRetired -ne $true -or $retired.phase -ne 'rolled_back' -or
        $retired.operationId -cne $OperationId -or $retired.newFingerprint -cne $Fingerprint) {
        throw (Get-SafeCode $retired 'FRA_LIFECYCLE_RECOVERY_RETIREMENT_FAILED')
    }
    return [ordered]@{
        ok = $true
        action = 'retired-rolled-back-recovery'
        host = $HostName
        operationId = $OperationId
        fingerprint = $Fingerprint
        phase = 'rolled_back'
        secretValuesEmitted = $false
    }
}

function Get-TunnelStatus {
    $result = Invoke-HiddenProcess -FilePath $Node -Arguments @($TunnelProbe) -TimeoutMilliseconds 15000 -Environment @{
        LINK_BUS_LOCAL = $HostName
        LINK_BUS_PEER = $PeerHost
    }
    $parsed = Convert-LastJson $result.stdout
    if ($result.exitCode -ne 0 -or $null -eq $parsed) { return [pscustomobject]@{ healthOk = $false; authOk = $false } }
    return [pscustomobject]@{ healthOk = [bool]$parsed.healthOk; authOk = [bool]$parsed.authOk }
}

function Send-RestartNotice {
    param([ValidateSet('unhealthy_listener', 'committed_rotation', 'rollback_recovery')][string]$Reason)
    $result = Invoke-HiddenProcess -FilePath $Node -Arguments @(
        $TunnelNotice, '--host', $HostName, '--reason', $Reason
    ) -TimeoutMilliseconds 30000
    $parsed = Convert-LastJson $result.stdout
    if ($result.exitCode -ne 0 -or $null -eq $parsed -or $parsed.ok -ne $true -or
        $parsed.canonicalRelayNotified -ne $true -or $parsed.relaysNotified -ne 1 -or
        $parsed.secretValuesEmitted -ne $false) {
        throw 'FRA_LIFECYCLE_RESTART_NOTICE_FAILED'
    }
    return $parsed
}

function Test-PortOpen {
    param([string]$Address, [int]$Port, [int]$TimeoutMilliseconds = 1000)
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $task = $client.ConnectAsync($Address, $Port)
        if (-not $task.Wait($TimeoutMilliseconds)) { return $false }
        return $client.Connected
    } catch { return $false }
    finally { $client.Dispose() }
}

function Test-EnrollmentFirewall {
    # Get-NetFirewallRule (and its dependent Port/AddressFilter cmdlets)
    # silently returns an empty result set when this process is not
    # elevated, even though the rule genuinely exists and is correctly
    # scoped -- see the identical fix and full explanation on
    # Get-ExactPeerFirewallReadiness in tools/full-remote-access-control.ps1.
    # netsh advfirewall firewall show rule is the elevation-independent
    # equivalent; this is a pure accuracy fix, the requirement itself
    # (present, enabled, inbound, allow, TCP/8794, scoped to .2 only) is
    # unchanged.
    if ($HostName -cne $MachineBAddress) { return $true }
    try {
        $output = & netsh advfirewall firewall show rule name="ToolsEnabled FRA Enrollment 8794"
        $text = [string]::Join("`n", @($output))
        if ($text -match 'No rules match the specified criteria') { return $false }
        $ruleBlocks = @([regex]::Matches($text, '(?m)^Rule Name:'))
        if ($ruleBlocks.Count -ne 1) { return $false }
        $enabledMatch = [regex]::Match($text, '(?m)^Enabled:\s*(\S+)\s*$')
        $directionMatch = [regex]::Match($text, '(?m)^Direction:\s*(\S+)\s*$')
        $actionMatch = [regex]::Match($text, '(?m)^Action:\s*(\S+)\s*$')
        if (-not $enabledMatch.Success -or $enabledMatch.Groups[1].Value -ne 'Yes' -or
            -not $directionMatch.Success -or $directionMatch.Groups[1].Value -ne 'In' -or
            -not $actionMatch.Success -or $actionMatch.Groups[1].Value -ne 'Allow') {
            return $false
        }
        $protocolMatch = [regex]::Match($text, '(?m)^Protocol:\s*(\S+)\s*$')
        $localPortMatch = [regex]::Match($text, '(?m)^LocalPort:\s*(\S+)\s*$')
        if (-not $protocolMatch.Success -or $protocolMatch.Groups[1].Value -ne 'TCP' -or
            -not $localPortMatch.Success -or $localPortMatch.Groups[1].Value -ne '8794') {
            return $false
        }
        $remoteIpMatch = [regex]::Match($text, '(?m)^RemoteIP:\s*(\S+)\s*$')
        if (-not $remoteIpMatch.Success) { return $false }
        # netsh renders a single address as an identical start-end range
        # (e.g. "203.0.113.2-203.0.113.2"), never a bare address.
        $remoteAddresses = @($remoteIpMatch.Groups[1].Value -split ',' | ForEach-Object {
            $part = $_.Trim()
            $rangeMatch = [regex]::Match($part, '^(?<start>[0-9.]+)-(?<finish>[0-9.]+)$')
            if ($rangeMatch.Success -and $rangeMatch.Groups['start'].Value -eq $rangeMatch.Groups['finish'].Value) {
                $rangeMatch.Groups['start'].Value
            } else { $part }
        })
        return [bool]($remoteAddresses.Count -eq 1 -and $remoteAddresses[0] -ceq $PeerHost)
    } catch { return $false }
}

function New-RotationState {
    param([string]$Trigger = 'none')
    return [ordered]@{
        trigger = $Trigger; state = 'idle'; operationId = $null; newFingerprint = $null
        terminalPhase = $null; receiverPid = $null; committedAt = $null; restartedAt = $null
        receiverClosedAt = $null; peerProofBaseline = $null
        outboundCurrentAt = $null; inboundCurrentAt = $null; freshReceiptAt = $null
        oldProofOperationId = $null; oldTokenRejectedAt = $null; peerOldProofAt = $null; finalizedAt = $null
    }
}

function New-DefaultState {
    return [ordered]@{
        schemaVersion = 'tools-enabled.full-remote-access-lifecycle.v3'
        updatedAt = (Get-Date).ToUniversalTime().ToString('o')
        host = $HostName; peer = $PeerHost; role = $Role; desiredState = 'enabled'; phase = 'waiting_for_peer'
        task = [ordered]@{ installed = $false; lastWakeAt = $null }
        local = [ordered]@{
            listenerState = 'unknown'; listenerPid = $null; localReady = $false; firewallReady = $false
            rootIdentityReady = $false; rootAccessReady = $false; transportBindingReady = $false
            enrollmentState = 'unknown'; enrollmentPid = $null; unhealthyStreak = 0
        }
        tunnel = [ordered]@{ healthReady = $false; authReady = $false }
        mismatch = [ordered]@{
            lastObservedCount = 0; streak = 0; firstObservedAt = $null; lastObservedAt = $null
            authenticatedAfterLastRejection = $false
        }
        rotation = New-RotationState
        retry = [ordered]@{ failureCode = $null; attempts = 0; nextEligibleAt = $null }
        # Own retry/backoff bucket for the outbound liveness heartbeat --
        # same {failureCode,attempts,nextEligibleAt} shape as retry above,
        # kept separate so a heartbeat failure never perturbs the primary
        # phase/retry state machine (see Invoke-Reconcile: it is invoked only
        # as an additional freshness proof once the ordinary peer probe has
        # already succeeded, purely to keep
        # full-remote-access-peer-liveness.json refreshed).
        #
        # lastStage/lastAttempt/lastElapsedMs (required change 3, 2026-08-04
        # review): Get-SanitizedHeartbeatTelemetry's own allowlisted
        # projection of the most recent Invoke-PeerHeartbeat result,
        # persisted every eligible Reconcile cycle (success or failure) so
        # this diagnostic detail survives past the one cycle it was produced
        # in -- previously read off the CLI's JSON result and simply
        # dropped. `code` on a failure is already retained via failureCode
        # above; these three cover exactly the rest of that telemetry.
        #
        # lastAttempts (correction D, 2026-08-04 review round 2): a bounded
        # (max 2), sanitized per-attempt summary mirroring
        # tools/fra-peer-heartbeat.js's own `attemptsHistory` -- so a
        # recovered retry (attempt 1 fails, attempt 2 succeeds) does not
        # silently erase attempt 1's own failure code/stage/elapsedMs from
        # persisted state either. Defaults to an empty array, never $null.
        heartbeat = [ordered]@{
            failureCode = $null; attempts = 0; nextEligibleAt = $null; lastSuccessAt = $null
            lastStage = $null; lastAttempt = $null; lastElapsedMs = $null; lastAttempts = @()
        }
        lastAction = 'none'; lastErrorCode = $null; secretValuesEmitted = $false
    }
}

function Test-ExactProperties {
    param($Object, [string[]]$Names)
    if ($null -eq $Object) { return $false }
    # An [ordered]@{} is an OrderedDictionary, and PSObject.Properties.Name on one
    # returns the DICTIONARY's own members -- Count, Keys, Values, IsReadOnly and
    # friends -- never the keys the caller means. New-DefaultState builds exactly
    # that shape, so a freshly defaulted state failed its own shape test, Write-State
    # threw, and the lifecycle could never create the state file it needs. It only
    # ever worked where a valid file already existed; on a machine with a missing or
    # older-schema file it could not bootstrap at all, and the 2-minute task simply
    # exited 1 forever.
    # State read back from disk arrives as PSCustomObject via ConvertFrom-Json, so
    # both shapes are legitimate here and both must be understood.
    $actual = if ($Object -is [System.Collections.IDictionary]) {
        @($Object.Keys | ForEach-Object { [string]$_ } | Sort-Object)
    } else {
        @($Object.PSObject.Properties.Name | Sort-Object)
    }
    $expected = @($Names | Sort-Object)
    return [bool](($actual -join "`n") -ceq ($expected -join "`n"))
}

function Test-NullableTimestamp {
    param($Value)
    if ($null -eq $Value) { return $true }
    $parsed = [DateTimeOffset]::MinValue
    return [DateTimeOffset]::TryParse([string]$Value, [ref]$parsed)
}

function Test-StateShape {
    param($State)
    if (-not (Test-ExactProperties $State @('schemaVersion','updatedAt','host','peer','role','desiredState','phase','task','local','tunnel','mismatch','rotation','retry','heartbeat','lastAction','lastErrorCode','secretValuesEmitted'))) { return $false }
    if (-not (Test-ExactProperties $State.task @('installed','lastWakeAt')) -or
        -not (Test-ExactProperties $State.local @('listenerState','listenerPid','localReady','firewallReady','rootIdentityReady','rootAccessReady','transportBindingReady','enrollmentState','enrollmentPid','unhealthyStreak')) -or
        -not (Test-ExactProperties $State.tunnel @('healthReady','authReady')) -or
        -not (Test-ExactProperties $State.mismatch @('lastObservedCount','streak','firstObservedAt','lastObservedAt','authenticatedAfterLastRejection')) -or
        -not (Test-ExactProperties $State.rotation @('trigger','state','operationId','newFingerprint','terminalPhase','receiverPid','committedAt','restartedAt','receiverClosedAt','peerProofBaseline','outboundCurrentAt','inboundCurrentAt','freshReceiptAt','oldProofOperationId','oldTokenRejectedAt','peerOldProofAt','finalizedAt')) -or
        -not (Test-ExactProperties $State.retry @('failureCode','attempts','nextEligibleAt')) -or
        -not (Test-ExactProperties $State.heartbeat @('failureCode','attempts','nextEligibleAt','lastSuccessAt','lastStage','lastAttempt','lastElapsedMs','lastAttempts'))) { return $false }
    if ($State.schemaVersion -ne 'tools-enabled.full-remote-access-lifecycle.v3' -or $State.host -ne $HostName -or
        $State.peer -ne $PeerHost -or $State.role -ne $Role -or $State.secretValuesEmitted -ne $false) { return $false }
    if ($State.desiredState -notin @('enabled','disabled') -or
        $State.phase -notin @('waiting_for_peer','healthy','disabled','blocked','degraded','receiver_open','transaction_in_progress','verification_pending','recovery_wait','recovery_required')) { return $false }
    if ($State.local.listenerState -notin @('unknown','absent','owned','conflict','unverifiable') -or
        $State.local.enrollmentState -notin @('unknown','absent','owned','conflict')) { return $false }
    if ($State.rotation.trigger -notin @('none','explicit','proof_mismatch','peer_receiver') -or
        $State.rotation.state -notin @('idle','receiver_open','transaction_in_progress','verification_pending','finalized','rolled_back','recovery_required')) { return $false }
    if ($null -ne $State.rotation.terminalPhase -and $State.rotation.terminalPhase -notin @('committed','rolled_back')) { return $false }
    if ($null -ne $State.rotation.operationId -and [string]$State.rotation.operationId -notmatch '^[A-Za-z0-9_-]{22}$') { return $false }
    if ($null -ne $State.rotation.oldProofOperationId -and [string]$State.rotation.oldProofOperationId -notmatch '^[A-Za-z0-9_-]{22}$') { return $false }
    if ($null -ne $State.rotation.newFingerprint -and [string]$State.rotation.newFingerprint -notmatch '^[A-Za-z0-9_-]{43}$') { return $false }
    foreach ($stamp in @($State.updatedAt,$State.task.lastWakeAt,$State.mismatch.firstObservedAt,$State.mismatch.lastObservedAt,$State.rotation.committedAt,$State.rotation.restartedAt,$State.rotation.receiverClosedAt,$State.rotation.outboundCurrentAt,$State.rotation.inboundCurrentAt,$State.rotation.freshReceiptAt,$State.rotation.oldTokenRejectedAt,$State.rotation.peerOldProofAt,$State.rotation.finalizedAt,$State.retry.nextEligibleAt,$State.heartbeat.nextEligibleAt,$State.heartbeat.lastSuccessAt)) {
        if (-not (Test-NullableTimestamp $stamp)) { return $false }
    }
    foreach ($flag in @($State.task.installed,$State.local.localReady,$State.local.firewallReady,$State.local.rootIdentityReady,$State.local.rootAccessReady,$State.local.transportBindingReady,$State.tunnel.healthReady,$State.tunnel.authReady,$State.mismatch.authenticatedAfterLastRejection)) {
        if ($flag -isnot [bool]) { return $false }
    }
    foreach ($number in @($State.local.unhealthyStreak,$State.mismatch.lastObservedCount,$State.mismatch.streak,$State.retry.attempts,$State.heartbeat.attempts)) {
        if ($number -isnot [ValueType] -or [int64]$number -lt 0) { return $false }
    }
    if ($null -ne $State.rotation.peerProofBaseline -and
        ($State.rotation.peerProofBaseline -isnot [ValueType] -or [int64]$State.rotation.peerProofBaseline -lt 0)) { return $false }
    foreach ($pidValue in @($State.local.listenerPid,$State.local.enrollmentPid,$State.rotation.receiverPid)) {
        if ($null -ne $pidValue -and ([int64]$pidValue -lt 1 -or [int64]$pidValue -gt [int]::MaxValue)) { return $false }
    }
    if ([string]$State.lastAction -notmatch '^[a-z0-9_.-]{1,100}$') { return $false }
    if ($null -ne $State.lastErrorCode -and [string]$State.lastErrorCode -notmatch '^[A-Z0-9_.-]{1,100}$') { return $false }
    if ($null -ne $State.retry.failureCode -and [string]$State.retry.failureCode -notmatch '^[A-Z0-9_.-]{1,100}$') { return $false }
    if ($null -ne $State.heartbeat.failureCode -and [string]$State.heartbeat.failureCode -notmatch '^[A-Z0-9_.-]{1,100}$') { return $false }
    if ($null -ne $State.heartbeat.lastStage -and
        ([string]$State.heartbeat.lastStage) -notin @('connect', 'initialize', 'tools_list', 'read_only_call', 'liveness_write')) { return $false }
    if ($null -ne $State.heartbeat.lastAttempt -and $State.heartbeat.lastAttempt -notin @(1, 2)) { return $false }
    if ($null -ne $State.heartbeat.lastElapsedMs -and
        ($State.heartbeat.lastElapsedMs -isnot [ValueType] -or [int64]$State.heartbeat.lastElapsedMs -lt 0)) { return $false }
    # lastAttempts (correction D, 2026-08-04 review round 2): a bounded (max
    # 2 -- this file retries at most once), sanitized per-attempt summary.
    # Must always be an array (never $null -- the default is an empty array,
    # not a nullable scalar), and each entry must carry EXACTLY the five
    # allowlisted keys below, each validated against the same rules as the
    # equivalent scalar heartbeat fields above.
    $attemptsHistory = @($State.heartbeat.lastAttempts)
    if ($attemptsHistory.Count -gt 2) { return $false }
    foreach ($entry in $attemptsHistory) {
        if (-not (Test-ExactProperties $entry @('attempt','stage','code','elapsedMs','ok'))) { return $false }
        if ($null -ne $entry.attempt -and $entry.attempt -notin @(1, 2)) { return $false }
        if ($null -ne $entry.stage -and
            ([string]$entry.stage) -notin @('connect', 'initialize', 'tools_list', 'read_only_call', 'liveness_write')) { return $false }
        if ($null -ne $entry.code -and [string]$entry.code -notmatch '^[A-Z0-9_.-]{1,100}$') { return $false }
        if ($null -ne $entry.elapsedMs -and
            ($entry.elapsedMs -isnot [ValueType] -or [int64]$entry.elapsedMs -lt 0)) { return $false }
        if ($entry.ok -isnot [bool]) { return $false }
    }
    return $true
}

# Correction A (2026-08-04 review round 2): 3d7080b3 changed the exact
# heartbeat bucket shape (added lastStage/lastAttempt/lastElapsedMs; this
# pass adds lastAttempts too -- correction D) while leaving schemaVersion at
# the SAME 'tools-enabled.full-remote-access-lifecycle.v3'. A state file
# written by any build of this script from BEFORE that change has the OLD,
# narrower 4-key heartbeat shape ({failureCode,attempts,nextEligibleAt,
# lastSuccessAt}) -- and without this step, that genuinely-valid old-shape
# state fails Test-StateShape's strict property-set check, Read-State's
# catch silently swallows the failure, and New-DefaultState is returned in
# its place -- discarding real phase/rotation/retry evidence along with the
# heartbeat bucket that was never actually wrong, just narrower.
#
# This step runs BEFORE Test-StateShape, detects EXACTLY the old 4-key
# heartbeat shape, and upgrades it IN PLACE: every existing field's value
# (failureCode/attempts/nextEligibleAt/lastSuccessAt) is preserved verbatim,
# and the newer fields are added as safe (null, or -- for the array --
# empty) defaults, matching exactly what New-DefaultState itself defaults a
# brand-new heartbeat bucket to. Anything that is not EXACTLY the recognized
# old shape is left untouched; Test-StateShape remains the one authority on
# whether the (possibly now-migrated) state is valid overall.
function ConvertTo-MigratedState {
    param($State)
    if ($null -eq $State -or $null -eq $State.heartbeat) { return $State }
    if (Test-ExactProperties $State.heartbeat @('failureCode','attempts','nextEligibleAt','lastSuccessAt')) {
        $old = $State.heartbeat
        $State.heartbeat = [ordered]@{
            failureCode = $old.failureCode
            attempts = $old.attempts
            nextEligibleAt = $old.nextEligibleAt
            lastSuccessAt = $old.lastSuccessAt
            lastStage = $null
            lastAttempt = $null
            lastElapsedMs = $null
            lastAttempts = @()
        }
    }
    return $State
}

function Read-State {
    if (-not (Test-Path -LiteralPath $StateFile -PathType Leaf)) { return New-DefaultState }
    try {
        $file = Get-Item -LiteralPath $StateFile -Force
        if ($file.Length -le 0 -or $file.Length -gt 65536 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid' }
        $parsed = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
        $parsed = ConvertTo-MigratedState $parsed
        if (-not (Test-StateShape $parsed)) { throw 'invalid' }
        return $parsed
    } catch { return New-DefaultState }
}

function Write-State {
    param($State)
    $State.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    $State.secretValuesEmitted = $false
    if (-not (Test-StateShape $State)) { throw 'FRA_LIFECYCLE_STATE_INVALID' }
    $directory = Split-Path -Parent $StateFile
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $directoryItem = Get-Item -LiteralPath $directory -Force
    if ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'FRA_LIFECYCLE_STATE_PATH_INVALID' }
    if (Test-Path -LiteralPath $StateFile) {
        $stateItem = Get-Item -LiteralPath $StateFile -Force
        if ($stateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'FRA_LIFECYCLE_STATE_PATH_INVALID' }
    }
    $temporary = $StateFile + '.' + $PID + '.' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + '.tmp'
    try {
        $json = ($State | ConvertTo-Json -Depth 20 -Compress) + "`n"
        if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 65536) { throw 'FRA_LIFECYCLE_STATE_TOO_LARGE' }
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
        # [NullString]::Value, NOT $null. PowerShell 5.1 binds a bare $null to a
        # .NET String parameter as [string]::Empty, so File.Replace received ""
        # as destinationBackupFileName and Path.GetFullPathInternal("") threw
        # "The path is not of a legal form."
        #
        # The Move branch below only runs when the state file is ABSENT, so the
        # lifecycle could CREATE its state file exactly once and could never
        # update it again. Every exit path of Invoke-Reconcile ends in
        # Write-State, which made Reconcile unconditionally fatal while Status,
        # InstallTask and RemoveTask kept working -- none of those three write
        # state. Get-SafeCode then rejected the exception text (lowercase and
        # quotes fail its ^[A-Z0-9_.-]{1,100}$ pattern) and substituted the
        # generic FRA_LIFECYCLE_FAILED, so the error named nothing.
        #
        # Preferred over a Delete-then-Move fallback, which would open a window
        # with no state file at all and give up the atomic replace.
        if (Test-Path -LiteralPath $StateFile -PathType Leaf) { [IO.File]::Replace($temporary, $StateFile, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $StateFile) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Get-TaskInstalled { return [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) }

function Test-SamePrincipal {
    # Register-ScheduledTask is given a qualified account name such as
    # MACHINE\user, but Windows NORMALISES the stored S4U principal to the bare
    # account name. Comparing the stored value against the qualified name it was
    # registered with therefore NEVER matches, so verification failed on every
    # install: the task was registered correctly, every other property was right,
    # and InstallTask still returned FRA_LIFECYCLE_TASK_VERIFICATION_FAILED.
    # Anyone reading that exit code concluded autostart was not installed when it
    # was.
    # Compared by SID so the check is not weakened -- matching only the leaf name
    # would accept a same-named account from a different authority.
    param([string]$Stored, [string]$Expected)
    if ([string]::IsNullOrWhiteSpace($Stored) -or [string]::IsNullOrWhiteSpace($Expected)) { return $false }
    if ($Stored -ceq $Expected) { return $true }
    $resolve = {
        param([string]$account, [string]$fallbackAuthority)
        try { return (New-Object Security.Principal.NTAccount($account)).Translate([Security.Principal.SecurityIdentifier]).Value }
        catch {}
        # A BARE account name does not resolve on its own -- NTAccount('user')
        # throws "Some or all identity references could not be translated", while
        # NTAccount('MACHINE\user') resolves fine. Since the bare form is exactly
        # what Windows stores for the S4U principal, it must be qualified with the
        # authority from the expected qualified account before it can be compared.
        # Do not depend on COMPUTERNAME being present: non-interactive runners may
        # omit it even though the Windows identity and its SID are available.
        if ($account -notmatch '\\') {
            try { return (New-Object Security.Principal.NTAccount($fallbackAuthority, $account)).Translate([Security.Principal.SecurityIdentifier]).Value }
            catch {}
        }
        return $null
    }
    $expectedParts = $Expected -split '\\', 2
    $expectedAuthority = if ($expectedParts.Count -eq 2) { [string]$expectedParts[0] } else { '' }
    $storedSid = & $resolve $Stored $expectedAuthority
    $expectedSid = & $resolve $Expected $expectedAuthority
    # Refuse rather than guess if either side cannot be resolved to a SID; an
    # unverifiable principal must not read as verified.
    if ($null -eq $storedSid -or $null -eq $expectedSid) { return $false }
    return [bool]($storedSid -ceq $expectedSid)
}

function Install-LifecycleTask {
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action Reconcile'
    $actionSpec = New-ScheduledTaskAction -Execute $WindowsPowerShell -Argument $arguments
    $periodic = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 2)
    # The sign-in trigger comes from the startup.services_at_logon switch (owner
    # directive 2026-08-13), never from a literal here. Named $triggerSet rather
    # than $triggers because $triggers below is the READ-BACK from Windows, and
    # the verification under it is only worth anything if the two stay distinct.
    . (Join-Path $PSScriptRoot 'lib\StartupPolicy.ps1')
    $triggerSet = @(New-ToolsEnabledTaskTriggers -Repeating $periodic -IncludeLogon)
    $expectedTriggerCount = $triggerSet.Count
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -Hidden -ExecutionTimeLimit (New-TimeSpan -Minutes 25)
    # With the switch off the task is registered but not runnable: the two-minute
    # repetition would otherwise restart FRA minutes after every boot.
    if (-not (Test-ToolsEnabledTaskShouldBeEnabled)) { $settings.Enabled = $false }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType S4U -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $actionSpec -Trigger $triggerSet -Settings $settings -Principal $principal -Force | Out-Null
    $registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $actions = @($registered.Actions); $triggers = @($registered.Triggers)
    $repetition = @($triggers | Where-Object { $_.Repetition.Interval -eq 'PT2M' })
    if ($actions.Count -ne 1 -or -not ([IO.Path]::GetFullPath([string]$actions[0].Execute)).Equals([IO.Path]::GetFullPath($WindowsPowerShell), [StringComparison]::OrdinalIgnoreCase) -or
        [string]$actions[0].Arguments -ne $arguments -or -not (Test-SamePrincipal $registered.Principal.UserId $identity) -or
        [string]$registered.Principal.LogonType -ne 'S4U' -or [string]$registered.Principal.RunLevel -ne 'Limited' -or
        [string]$registered.Settings.MultipleInstances -ne 'IgnoreNew' -or -not [bool]$registered.Settings.Hidden -or
        [string]$registered.Settings.ExecutionTimeLimit -ne 'PT25M' -or $triggers.Count -ne $expectedTriggerCount -or $repetition.Count -ne 1) {
        throw 'FRA_LIFECYCLE_TASK_VERIFICATION_FAILED'
    }
    return [ordered]@{ ok = $true; action = 'task_installed'; taskName = $TaskName; configurationVerified = $true; runtimeProofPending = $true; secretValuesEmitted = $false }
}

function Remove-LifecycleTask {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -ne $task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { throw 'FRA_LIFECYCLE_TASK_REMOVE_FAILED' }
    return [ordered]@{ ok = $true; action = 'task_removed'; taskName = $TaskName; secretValuesEmitted = $false }
}

function Set-LocalObservation {
    param($State, $Status, [bool]$CountUnhealthy = $true)
    $State.local.listenerState = if ($Status.listenerState -in @('absent','owned','conflict','unverifiable')) { [string]$Status.listenerState } else { 'unknown' }
    $State.local.listenerPid = $Status.pid
    $State.local.firewallReady = [bool]$Status.firewallReady
    $State.local.rootIdentityReady = [bool]$Status.rootIdentityReady
    $State.local.rootAccessReady = [bool]$Status.rootAccessReady
    $State.local.transportBindingReady = [bool]$Status.transportBindingReady
    $State.local.enrollmentState = if ($Status.enrollmentState -in @('absent','owned','conflict')) { [string]$Status.enrollmentState } else { 'unknown' }
    $State.local.enrollmentPid = $Status.enrollmentPid
    # listenerReady, not owned: a positively-identified owned listener and a
    # health-listener-PID-proven 'unverifiable' one are both real, currently
    # serving readiness -- see Test-ListenerReady in the control script. owned
    # alone would make every reconcile cycle against a healthy-but-unverifiable
    # listener (the common case for the S4U-run lifecycle task observing an
    # elevated listener) read as not-ready and retry a doomed duplicate Start.
    $State.local.localReady = [bool]($Status.listenerReady -and $Status.healthy -and $Status.secureTransportReady -and
        $Status.runtimeIntegrityReady -and $Status.rootIdentityReady -and $Status.rootAccessReady -and
        $Status.transportBindingReady -and $Status.capabilityManifestReady -and $Status.credentialBoundaryReady -and
        $Status.desktopPolicyReady -and $Status.firewallReady)
    if ($State.local.localReady) { $State.local.unhealthyStreak = 0 }
    elseif ($CountUnhealthy -and $Status.owned) { $State.local.unhealthyStreak = [int]$State.local.unhealthyStreak + 1 }
}

# Invoke-Reconcile's not-owned decision, pulled out as a small pure function
# so it has one tested definition instead of being reasoned about only where
# it is inlined. Called only once $status.owned is already known false (the
# owned-but-unhealthy Invoke-ReviewedRestart path is a completely separate,
# unchanged branch in the caller).
#
#   'start'                -> the port is genuinely empty; Start is the only
#                              case in which attempting it can succeed.
#   'proceed'               -> an 'unverifiable' listener already proven
#                               ready (see Test-ListenerReady in the control
#                               script); skip Start and fall through to the
#                               tunnel/heartbeat logic exactly as an
#                               owned-and-healthy listener would.
#   'degraded_unverifiable' -> 'unverifiable' but not (yet) proven ready;
#                               record it and return without mutating
#                               anything -- Start would just repeat the
#                               doomed duplicate-bind this whole change
#                               exists to stop.
#   'degraded_unknown'      -> genuinely unresolved local observation; same
#                               conservative no-mutation return.
function Get-NotOwnedReconcileAction {
    param([string]$ListenerState, [bool]$LocalReady)
    if ($ListenerState -eq 'absent') { return 'start' }
    if ($ListenerState -eq 'unverifiable') {
        if ($LocalReady) { return 'proceed' }
        return 'degraded_unverifiable'
    }
    return 'degraded_unknown'
}

# Strict allowlisted projection of Invoke-PeerHeartbeat's own
# stage/attempt/elapsedMs (+ attemptsHistory, correction D) telemetry -- the
# PowerShell-side half of required change 3 (2026-08-04 review). Before this,
# Invoke-Reconcile read $probe.stage/.attempt/.elapsedMs off the heartbeat
# CLI's own JSON result and then simply never persisted them into
# $state.heartbeat: they were parsed and dropped on every single Reconcile
# cycle, so the newest, most diagnostic failure detail (WHICH stage, WHICH
# attempt, HOW long) never survived past one 2-minute cycle, even though
# $state.heartbeat.failureCode/attempts already survive indefinitely.
#
# This mirrors tools/fra-peer-heartbeat.js's own safeStage/safeAttempt/
# safeElapsedMs/safeAttemptsHistory sanitizers exactly (same allowlist, same
# fixed five-stage enum, same 1-or-2 attempt range, same non-negative-integer
# elapsedMs rule, same max-2-entries bound) -- a deliberately PARALLEL
# implementation, not a shared module, because a PowerShell caller cannot
# require() that JS file directly and shelling out to node just to sanitize
# a few fields would be a heavier, slower dependency than re-stating the same
# checks natively. See tools/fra-peer-heartbeat.js's sanitizeHeartbeatTelemetry()
# for its own (JS-side) twin, used by tools/fra-keeper.js. The attemptsHistory
# sanitization is inlined here rather than split into a separate helper
# function so this remains the one self-contained function the tests lift and
# run standalone (tests/fra-lifecycle-guards.js).
#
# Reads ONLY these named properties off $Probe (and off each attemptsHistory
# entry) -- never anything else, so an extra/unexpected property on $Probe or
# on any entry (a future field, a malformed or hostile result) can never be
# persisted through this function, whatever else is on the object.
function Get-SanitizedHeartbeatTelemetry {
    param($Probe)
    $stage = $null
    if ($null -ne $Probe.stage -and ([string]$Probe.stage) -in @('connect', 'initialize', 'tools_list', 'read_only_call', 'liveness_write')) {
        $stage = [string]$Probe.stage
    }
    $attempt = $null
    if ($Probe.attempt -eq 1 -or $Probe.attempt -eq 2) { $attempt = [int]$Probe.attempt }
    $elapsedMs = $null
    if ($null -ne $Probe.elapsedMs -and ($Probe.elapsedMs -is [ValueType]) -and [int64]$Probe.elapsedMs -ge 0) {
        $elapsedMs = [int64]$Probe.elapsedMs
    }
    $attemptsHistory = @()
    foreach ($entry in @($Probe.attemptsHistory)) {
        if ($attemptsHistory.Count -ge 2) { break }
        if ($null -eq $entry) { continue }
        $entryStage = $null
        if ($null -ne $entry.stage -and ([string]$entry.stage) -in @('connect', 'initialize', 'tools_list', 'read_only_call', 'liveness_write')) {
            $entryStage = [string]$entry.stage
        }
        $entryAttempt = $null
        if ($entry.attempt -eq 1 -or $entry.attempt -eq 2) { $entryAttempt = [int]$entry.attempt }
        $entryOk = [bool]($entry.ok -eq $true)
        $entryCode = $null
        if (-not $entryOk -and $null -ne $entry.code -and ([string]$entry.code) -match '^[A-Z0-9_.-]{1,100}$') {
            $entryCode = [string]$entry.code
        }
        $entryElapsedMs = $null
        if ($null -ne $entry.elapsedMs -and ($entry.elapsedMs -is [ValueType]) -and [int64]$entry.elapsedMs -ge 0) {
            $entryElapsedMs = [int64]$entry.elapsedMs
        }
        $attemptsHistory += [ordered]@{ attempt = $entryAttempt; stage = $entryStage; code = $entryCode; elapsedMs = $entryElapsedMs; ok = $entryOk }
    }
    return [ordered]@{ stage = $stage; attempt = $attempt; elapsedMs = $elapsedMs; attemptsHistory = $attemptsHistory }
}

function Set-Failure {
    # Bucket lets a second, independent {failureCode,attempts,nextEligibleAt}
    # tuple (e.g. $State.heartbeat) reuse this exact backoff formula without
    # perturbing the primary $State.retry / $State.lastErrorCode that drives
    # the main phase state machine. Every existing call site omits it and is
    # unaffected: default $null keeps targeting $State.retry exactly as
    # before.
    param($State, [string]$Code, $Bucket = $null)
    $target = if ($null -ne $Bucket) { $Bucket } else { $State.retry }
    $safe = Get-SafeCode $Code
    if ($target.failureCode -eq $safe) { $target.attempts = [int]$target.attempts + 1 }
    else { $target.failureCode = $safe; $target.attempts = 1 }
    $exponent = [Math]::Min(6, [Math]::Max(0, [int]$target.attempts - 1))
    $seconds = [Math]::Min(1800, 30 * [Math]::Pow(2, $exponent))
    $target.nextEligibleAt = (Get-Date).ToUniversalTime().AddSeconds($seconds).ToString('o')
    if ($null -eq $Bucket) { $State.lastErrorCode = $safe }
}

function Clear-Failure {
    param($State, $Bucket = $null)
    $target = if ($null -ne $Bucket) { $Bucket } else { $State.retry }
    $target.failureCode = $null; $target.attempts = 0; $target.nextEligibleAt = $null
    if ($null -eq $Bucket) { $State.lastErrorCode = $null }
}

function Test-RetryEligible {
    param($State, $Bucket = $null)
    $target = if ($null -ne $Bucket) { $Bucket } else { $State.retry }
    if (-not $target.nextEligibleAt) { return $true }
    return (Get-Date).ToUniversalTime() -ge [DateTimeOffset]::Parse([string]$target.nextEligibleAt).UtcDateTime
}

function Get-TransactionAgeMilliseconds {
    param($Transaction)
    if ($null -eq $Transaction.updatedAtMs) { return 0 }
    return [Math]::Max(0, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$Transaction.updatedAtMs)
}

function Test-TimestampAtOrAfter {
    param($Value, $Floor)
    if ($null -eq $Value -or $null -eq $Floor) { return $false }
    try {
        $observed = [DateTimeOffset]::Parse([string]$Value).ToUniversalTime()
        $minimum = [DateTimeOffset]::Parse([string]$Floor).ToUniversalTime()
        return [bool]($observed -ge $minimum)
    } catch { return $false }
}

function Test-RotationReceipt {
    param(
        [bool]$Ready,
        [string]$AuthenticatedAt,
        [string]$Kind,
        [string]$ExpectedKind,
        [string]$OperationId,
        $PreviousFingerprint,
        [string]$CurrentFingerprint,
        [string]$ExpectedOperationId,
        $ExpectedPreviousFingerprint,
        [string]$ExpectedCurrentFingerprint,
        [string]$CommittedAt
    )
    if (-not $Ready -or -not (Test-TimestampAtOrAfter $AuthenticatedAt $CommittedAt) -or
        $OperationId -ne $ExpectedOperationId -or $CurrentFingerprint -ne $ExpectedCurrentFingerprint) { return $false }
    if ($null -eq $ExpectedPreviousFingerprint) {
        if ($null -ne $PreviousFingerprint) { return $false }
    } elseif ([string]$PreviousFingerprint -ne [string]$ExpectedPreviousFingerprint) { return $false }
    return [bool]($Kind -eq $ExpectedKind)
}

function Set-RotationProofBaseline {
    param($State, [int64]$ProofCount)
    if ($null -eq $State.rotation.peerProofBaseline) {
        $State.rotation.peerProofBaseline = [int64][Math]::Max(0, $ProofCount)
    }
}

function Invoke-ReviewedRestart {
    param($State, [string]$Reason)
    $null = Send-RestartNotice $Reason
    $status = Invoke-Control 'Restart'
    Set-LocalObservation $State $status $false
    if (-not $State.local.localReady) { throw 'FRA_LIFECYCLE_RESTART_NOT_READY' }
    return $status
}

function Sync-RotationTransaction {
    param($State, $Transaction, [int64]$ProofCount)
    if ($null -eq $Transaction.operationId) { return }
    if ($State.rotation.operationId -ne $Transaction.operationId) {
        $trigger = [string]$State.rotation.trigger
        $State.rotation = New-RotationState $trigger
        $State.rotation.operationId = [string]$Transaction.operationId
        Set-RotationProofBaseline $State $ProofCount
    }
    $State.rotation.newFingerprint = $Transaction.newFingerprint
    if ($Transaction.phase -in @('committed','rolled_back')) { $State.rotation.terminalPhase = [string]$Transaction.phase }
}

function Get-LiveStatusProjection {
    $state = Read-State
    $state.task.installed = Get-TaskInstalled
    $control = $null; $tunnel = $null; $code = $null
    try { $control = Invoke-Control 'Status'; Set-LocalObservation $state $control $false }
    catch { $code = Get-SafeCode $_.Exception.Message }
    try {
        $tunnel = Get-TunnelStatus
        $state.tunnel.healthReady = [bool]$tunnel.healthOk; $state.tunnel.authReady = [bool]$tunnel.authOk
    } catch { if (-not $code) { $code = 'FRA_LIFECYCLE_TUNNEL_STATUS_FAILED' } }
    return [ordered]@{
        schemaVersion = 'tools-enabled.full-remote-access-lifecycle.status.v1'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        host = $HostName; peer = $PeerHost; persistedState = $state
        liveReady = [bool]($state.local.localReady -and $state.tunnel.healthReady -and $state.tunnel.authReady)
        observationErrorCode = $code; secretValuesEmitted = $false
    }
}

function Invoke-Reconcile {
    param([bool]$ForceRotate = $false)
    $state = Read-State
    $state.task.installed = Get-TaskInstalled
    $state.task.lastWakeAt = (Get-Date).ToUniversalTime().ToString('o')
    $state.desiredState = if (Test-Path -LiteralPath $StopFile) { 'disabled' } else { 'enabled' }
    $status = Invoke-Control 'Status'
    Set-LocalObservation $state $status $true

    if ($state.desiredState -eq 'disabled') {
        if ($status.owned) { $null = Invoke-Control 'Stop'; $state.lastAction = 'stopped_disabled_listener' }
        else { $state.lastAction = 'disabled_noop' }
        $state.phase = 'disabled'; Clear-Failure $state; Write-State $state; return $state
    }
    if ($status.listenerState -eq 'conflict' -or $status.enrollmentState -eq 'conflict') {
        $state.phase = 'blocked'; Set-Failure $state 'FRA_LIFECYCLE_LISTENER_CONFLICT'; Write-State $state; return $state
    }

    if ($status.owned) {
        # Owned-but-unhealthy: entirely unchanged by this pass. Restart is
        # attempted only after the same unhealthy streak has persisted past
        # $UnhealthyRestartThreshold, exactly as before.
        if (-not $state.local.localReady) {
            if ([int]$state.local.unhealthyStreak -ge $UnhealthyRestartThreshold -and (Test-RetryEligible $state)) {
                try {
                    $status = Invoke-ReviewedRestart $state 'unhealthy_listener'
                    $state.lastAction = 'restarted_locally_unhealthy_listener'; Clear-Failure $state
                } catch {
                    $state.phase = 'degraded'; Set-Failure $state (Get-SafeCode $_.Exception.Message); Write-State $state; return $state
                }
            } else {
                $state.phase = 'degraded'; $state.lastAction = 'observed_unhealthy_listener'; Write-State $state; return $state
            }
        }
    } else {
        # Not owned covers THREE different observations that used to be
        # collapsed into one "attempt Start" branch: a genuinely empty port,
        # an 'unverifiable' listener (this privilege level could not read its
        # command line -- see Get-ExactListener), and a truly unresolved
        # observation. Only the first can make Start succeed; the other two
        # made every 2-minute reconcile cycle against a healthy-but-elevated
        # listener retry a doomed duplicate Start and never reach heartbeat
        # that cycle. Start-OwnedListener itself now also refuses a
        # duplicate spawn against an unverifiable listener (defense in
        # depth for every OTHER caller that reaches it -- rollback recovery,
        # transaction sync, coordinated rotation); this switch additionally
        # keeps the steady-state cycle from even attempting the call, and
        # gives it the accurate degraded/observed_unverifiable record instead
        # of a start-attempt failure code.
        switch (Get-NotOwnedReconcileAction -ListenerState $state.local.listenerState -LocalReady $state.local.localReady) {
            'start' {
                try {
                    $status = Invoke-Control 'Start'
                    Set-LocalObservation $state $status $false
                    $state.lastAction = if ($status.owned) { 'started_local_listener' } elseif ($status.enrollmentState -eq 'owned') { 'opened_missing_token_receiver' } else { 'listener_start_pending' }
                } catch {
                    $startCode = Get-SafeCode $_.Exception.Message
                    if (-not ($HostName -ceq $MachineAAddress -and $startCode -eq 'FRA_ENROLLMENT_RECEIVER_B_ONLY')) {
                        $state.phase = 'degraded'; Set-Failure $state $startCode; Write-State $state; return $state
                    }
                }
            }
            'proceed' {
                # 'unverifiable' but already proven ready (same-pid health
                # listener plus every health gate passing): skip Start
                # entirely and fall through to the tunnel/heartbeat logic
                # below exactly as an owned-and-healthy listener would.
            }
            'degraded_unverifiable' {
                $state.phase = 'degraded'; $state.lastAction = 'observed_unverifiable'; Write-State $state; return $state
            }
            default {
                $state.phase = 'degraded'; $state.lastAction = 'observed_unknown'; Write-State $state; return $state
            }
        }
    }

    $tunnel = Get-TunnelStatus
    $state.tunnel.healthReady = [bool]$tunnel.healthOk; $state.tunnel.authReady = [bool]$tunnel.authOk
    $proofCount = [int64]$status.credentialProofRejections
    if ($proofCount -lt [int64]$state.mismatch.lastObservedCount) {
        $state.mismatch.lastObservedCount = $proofCount; $state.mismatch.streak = 0
    } elseif ($proofCount -gt [int64]$state.mismatch.lastObservedCount) {
        $delta = $proofCount - [int64]$state.mismatch.lastObservedCount
        $state.mismatch.streak = [int]$state.mismatch.streak + [int]$delta
        if (-not $state.mismatch.firstObservedAt) { $state.mismatch.firstObservedAt = (Get-Date).ToUniversalTime().ToString('o') }
        $state.mismatch.lastObservedAt = (Get-Date).ToUniversalTime().ToString('o')
        $state.mismatch.authenticatedAfterLastRejection = $false
        $state.mismatch.lastObservedCount = $proofCount
    }

    $transaction = Invoke-Helper @('--transaction-status','--host',$HostName,'--port','8794') -TimeoutMilliseconds 120000
    $transactionPhase = if ($transaction.phase) { [string]$transaction.phase } else { $null }
    Sync-RotationTransaction $state $transaction $proofCount
    $transactionAge = Get-TransactionAgeMilliseconds $transaction
    if ($transactionPhase -in @('preparing','prepared','committing','rolling_back','prepare_failed')) {
        $receiverActive = [bool]($HostName -ceq $MachineBAddress -and $status.enrollmentState -eq 'owned')
        if ($receiverActive -or $transactionAge -lt $TransactionStaleMilliseconds) {
            $state.phase = if ($receiverActive) { 'transaction_in_progress' } else { 'recovery_wait' }
            $state.rotation.state = 'transaction_in_progress'; $state.lastAction = 'waiting_for_transaction_grace'
            Write-State $state; return $state
        }
        if (-not (Test-RetryEligible $state)) { $state.phase = 'recovery_wait'; Write-State $state; return $state }
        $rolled = Invoke-Helper @('--rollback','--host',$HostName,'--port','8794','--operation-id',[string]$transaction.operationId,'--fingerprint',[string]$transaction.newFingerprint) -TimeoutMilliseconds 240000
        if (-not $rolled.ok) {
            $state.phase = 'recovery_required'; $state.rotation.state = 'recovery_required'
            Set-Failure $state (Get-SafeCode $rolled); Write-State $state; return $state
        }
        $transaction = $rolled; $transactionPhase = 'rolled_back'; Sync-RotationTransaction $state $transaction $proofCount
        try {
            if ($status.owned) { $status = Invoke-ReviewedRestart $state 'rollback_recovery' }
            else { $status = Invoke-Control 'Start'; Set-LocalObservation $state $status $false }
            $state.rotation.restartedAt = (Get-Date).ToUniversalTime().ToString('o')
            $state.rotation.state = 'rolled_back'; $state.lastAction = 'rolled_back_stale_transaction'
        } catch {
            $state.phase = 'recovery_required'; Set-Failure $state (Get-SafeCode $_.Exception.Message); Write-State $state; return $state
        }
    }

    if ($transactionPhase -in @('committed','rolled_back')) {
        if ($HostName -ceq $MachineBAddress -and $status.enrollmentState -eq 'owned') {
            if ($transactionPhase -ne 'committed' -or $transaction.operationId -ne $state.rotation.operationId -or
                $transaction.newFingerprint -ne $state.rotation.newFingerprint) {
                $state.phase = 'recovery_required'; Set-Failure $state 'FRA_LIFECYCLE_CLOSE_RECEIVER_TRANSACTION_MISMATCH'
                Write-State $state; return $state
            }
            try {
                $status = Invoke-Control 'CloseEnrollment' -OperationId ([string]$transaction.operationId) -Fingerprint ([string]$transaction.newFingerprint)
                Set-LocalObservation $state $status $false
                if ($status.enrollmentState -ne 'absent') { throw 'FRA_LIFECYCLE_CLOSE_RECEIVER_NOT_ABSENT' }
                $state.rotation.receiverClosedAt = (Get-Date).ToUniversalTime().ToString('o')
                $state.lastAction = 'closed_committed_receiver'
            } catch {
                $state.phase = 'recovery_required'; Set-Failure $state (Get-SafeCode $_.Exception.Message)
                Write-State $state; return $state
            }
        }
        if ($transactionPhase -eq 'rolled_back') {
            # A rollback can retain credential recovery material. Its disposal
            # needs a separately correlated recovery protocol; never send a
            # rollback through the committed-rotation finalizer.
            $state.rotation.state = 'recovery_required'; $state.phase = 'recovery_required'
            Set-Failure $state 'FRA_LIFECYCLE_ROLLBACK_FINALIZATION_REQUIRES_REVIEW'
            Write-State $state; return $state
        }
        if (-not $state.rotation.restartedAt) {
            try {
                if ($status.owned) {
                    $reason = if ($transactionPhase -eq 'committed') { 'committed_rotation' } else { 'rollback_recovery' }
                    $status = Invoke-ReviewedRestart $state $reason
                } else {
                    $status = Invoke-Control 'Start'; Set-LocalObservation $state $status $false
                    if (-not $state.local.localReady) { throw 'FRA_LIFECYCLE_START_NOT_READY' }
                }
                $state.rotation.restartedAt = (Get-Date).ToUniversalTime().ToString('o')
                if ($transactionPhase -eq 'committed') { $state.rotation.committedAt = (Get-Date).ToUniversalTime().ToString('o') }
                $state.rotation.state = 'verification_pending'; $state.lastAction = 'synchronized_terminal_transaction'
            } catch {
                $state.phase = 'recovery_required'; Set-Failure $state (Get-SafeCode $_.Exception.Message); Write-State $state; return $state
            }
        }
        $expectedCurrentFingerprint = if ($transactionPhase -eq 'committed') { $transaction.newFingerprint }
            elseif ($transaction.previouslyPresent) { $transaction.previousFingerprint } else { $null }
        $probe = if ($state.local.localReady -and $state.tunnel.authReady -and $expectedCurrentFingerprint) {
            Invoke-Helper @('--probe-peer','--host',$HostName,'--port','8794') -TimeoutMilliseconds 240000
        } else { [pscustomobject]@{ ok = $false; code = 'FRA_LIFECYCLE_TERMINAL_PROBE_GATE_NOT_READY' } }
        $correlated = [bool]($probe.ok -and $probe.localTokenFingerprint -eq $expectedCurrentFingerprint -and
            $probe.rotationProofRecorded -eq $true -and $probe.rotationProofKind -eq 'current')
        $verificationStatus = $null
        try {
            $verificationStatus = Invoke-Control 'Status'
            Set-LocalObservation $state $verificationStatus $false
        } catch {
            $state.phase = 'recovery_required'; Set-Failure $state (Get-SafeCode $_.Exception.Message)
            Write-State $state; return $state
        }
        $outboundCurrent = [bool]($correlated -and (Test-RotationReceipt `
            -Ready ([bool]$verificationStatus.outboundPeerReceiptReady) `
            -AuthenticatedAt ([string]$verificationStatus.outboundPeerReceiptAuthenticatedAt) `
            -Kind ([string]$verificationStatus.outboundPeerReceiptRotationKind) -ExpectedKind 'current' `
            -OperationId ([string]$verificationStatus.outboundPeerReceiptRotationOperationId) `
            -PreviousFingerprint $verificationStatus.outboundPeerReceiptRotationPreviousFingerprint `
            -CurrentFingerprint ([string]$verificationStatus.outboundPeerReceiptRotationCurrentFingerprint) `
            -ExpectedOperationId ([string]$transaction.operationId) -ExpectedPreviousFingerprint $transaction.previousFingerprint `
            -ExpectedCurrentFingerprint ([string]$transaction.newFingerprint) -CommittedAt $state.rotation.committedAt))
        $inboundCurrent = [bool](Test-RotationReceipt `
            -Ready ([bool]$verificationStatus.inboundPeerReceiptReady) `
            -AuthenticatedAt ([string]$verificationStatus.inboundPeerReceiptAuthenticatedAt) `
            -Kind ([string]$verificationStatus.inboundPeerReceiptRotationKind) -ExpectedKind 'current' `
            -OperationId ([string]$verificationStatus.inboundPeerReceiptRotationOperationId) `
            -PreviousFingerprint $verificationStatus.inboundPeerReceiptRotationPreviousFingerprint `
            -CurrentFingerprint ([string]$verificationStatus.inboundPeerReceiptRotationCurrentFingerprint) `
            -ExpectedOperationId ([string]$transaction.operationId) -ExpectedPreviousFingerprint $transaction.previousFingerprint `
            -ExpectedCurrentFingerprint ([string]$transaction.newFingerprint) -CommittedAt $state.rotation.committedAt)
        if ($outboundCurrent) { $state.rotation.outboundCurrentAt = [string]$verificationStatus.outboundPeerReceiptAuthenticatedAt }
        if ($inboundCurrent) { $state.rotation.inboundCurrentAt = [string]$verificationStatus.inboundPeerReceiptAuthenticatedAt }

        if ($transactionPhase -eq 'committed' -and $outboundCurrent -and $inboundCurrent) {
            $state.rotation.freshReceiptAt = (Get-Date).ToUniversalTime().ToString('o')
            if ($state.rotation.oldProofOperationId -ne $transaction.operationId) {
                $oldProof = Invoke-Helper @('--prove-old-rejected','--host',$HostName,'--port','8794','--operation-id',[string]$transaction.operationId,'--fingerprint',[string]$transaction.newFingerprint) -TimeoutMilliseconds 300000
                if (-not $oldProof.ok -or ($oldProof.notApplicable -ne $true -and $oldProof.oldTokenRejected -ne $true) -or
                    ($oldProof.oldTokenRejected -eq $true -and ($oldProof.currentTokenReverified -ne $true -or
                        $oldProof.rotationProofRecorded -ne $true -or $oldProof.rotationProofKind -ne 'old-token-rejected'))) {
                    $state.phase = 'recovery_required'; Set-Failure $state (Get-SafeCode $oldProof 'FRA_LIFECYCLE_OLD_TOKEN_PROOF_FAILED')
                    Write-State $state; return $state
                }
                $state.rotation.oldProofOperationId = [string]$transaction.operationId
                $state.rotation.oldTokenRejectedAt = (Get-Date).ToUniversalTime().ToString('o')
            }
            try {
                $verificationStatus = Invoke-Control 'Status'
                Set-LocalObservation $state $verificationStatus $false
            } catch {
                $state.phase = 'recovery_required'; Set-Failure $state (Get-SafeCode $_.Exception.Message)
                Write-State $state; return $state
            }
            $peerOldProof = Test-RotationReceipt `
                -Ready ([bool]$verificationStatus.inboundPeerOldProofReceiptReady) `
                -AuthenticatedAt ([string]$verificationStatus.inboundPeerOldProofReceiptAuthenticatedAt) `
                -Kind ([string]$verificationStatus.inboundPeerOldProofReceiptRotationKind) -ExpectedKind 'old-token-rejected' `
                -OperationId ([string]$verificationStatus.inboundPeerOldProofReceiptRotationOperationId) `
                -PreviousFingerprint $verificationStatus.inboundPeerOldProofReceiptRotationPreviousFingerprint `
                -CurrentFingerprint ([string]$verificationStatus.inboundPeerOldProofReceiptRotationCurrentFingerprint) `
                -ExpectedOperationId ([string]$transaction.operationId) -ExpectedPreviousFingerprint $transaction.previousFingerprint `
                -ExpectedCurrentFingerprint ([string]$transaction.newFingerprint) -CommittedAt $state.rotation.committedAt
            if ($transaction.previouslyPresent -and $peerOldProof) { $state.rotation.peerOldProofAt = [string]$verificationStatus.inboundPeerOldProofReceiptAuthenticatedAt }
            $localOldProofReady = [bool]($state.rotation.oldProofOperationId -eq $transaction.operationId)
            $peerOldProofReady = [bool](-not $transaction.previouslyPresent -or $null -ne $state.rotation.peerOldProofAt)
            if (-not ($localOldProofReady -and $peerOldProofReady)) {
                $state.phase = 'verification_pending'; $state.rotation.state = 'verification_pending'
                $state.lastAction = 'waiting_for_peer_rotation_proof'; Clear-Failure $state
                Write-State $state; return $state
            }
            $fence = Invoke-Helper @('--fence-peer-finalization','--host',$HostName,'--port','8794','--operation-id',[string]$transaction.operationId,'--fingerprint',[string]$transaction.newFingerprint) -TimeoutMilliseconds 300000
            if (-not $fence.ok -or [string]$fence.fence -notmatch '^[A-Za-z0-9_-]{43}$') {
                $state.phase = 'recovery_required'; Set-Failure $state (Get-SafeCode $fence 'FRA_LIFECYCLE_FINALIZATION_FENCE_FAILED')
                Write-State $state; return $state
            }
            $final = Invoke-Helper @('--finalize','--host',$HostName,'--port','8794','--operation-id',[string]$transaction.operationId,'--fingerprint',[string]$transaction.newFingerprint,'--fence',[string]$fence.fence) -TimeoutMilliseconds 120000
            if ($final.ok) {
                $state.rotation.state = 'finalized'; $state.rotation.finalizedAt = (Get-Date).ToUniversalTime().ToString('o')
                $state.rotation.trigger = 'none'; $state.phase = 'healthy'; $state.lastAction = 'finalized_dual_proof_rotation'
                $state.mismatch.streak = 0; $state.mismatch.firstObservedAt = $null
                $state.mismatch.authenticatedAfterLastRejection = $true; Clear-Failure $state
                Write-State $state; return $state
            }
            $state.phase = 'recovery_required'; Set-Failure $state (Get-SafeCode $final); Write-State $state; return $state
        }
        if ($transactionPhase -eq 'committed' -and -not ($outboundCurrent -and $inboundCurrent) -and $transactionAge -ge $TransactionStaleMilliseconds -and (Test-RetryEligible $state)) {
            $rolled = Invoke-Helper @('--rollback','--host',$HostName,'--port','8794','--operation-id',[string]$transaction.operationId,'--fingerprint',[string]$transaction.newFingerprint) -TimeoutMilliseconds 240000
            if ($rolled.ok) {
                try { $status = Invoke-ReviewedRestart $state 'rollback_recovery'; $state.rotation.restartedAt = (Get-Date).ToUniversalTime().ToString('o') }
                catch { Set-Failure $state (Get-SafeCode $_.Exception.Message) }
                $state.rotation.state = 'rolled_back'; $state.rotation.terminalPhase = 'rolled_back'
                $state.phase = 'verification_pending'; $state.lastAction = 'compensated_split_rotation'
                Write-State $state; return $state
            }
        }
        $state.phase = if ($transactionPhase -eq 'rolled_back' -and -not $transaction.previouslyPresent) { 'recovery_required' } else { 'verification_pending' }
        $state.lastErrorCode = Get-SafeCode $probe 'FRA_LIFECYCLE_PEER_PROBE_FAILED'
        Write-State $state; return $state
    }

    # Steady-state freshness proof: ONE real round trip per reconcile cycle,
    # via the dedicated heartbeat CLI (connect + initialize + tools/list +
    # kill_switch_status) rather than running --probe-peer and a second
    # heartbeat back to back. The sealed enrollment helper still owns
    # transaction-correlated rotation proof. Its persisted-token verifier
    # accepts exactly the current 32-byte format and Mechanical-Connect's
    # legacy canonical 30-byte format, while creation and candidate writes
    # remain pinned to 32 bytes. Running both probes here would therefore add
    # no authentication coverage and would double per-cycle audit load.
    # state.heartbeat keeps its own success/failure bookkeeping below purely
    # as an observability record of this specific round trip; it is no
    # longer a secondary gate on whether the call runs, since this call IS
    # now the steady-state probe and must be attempted every eligible cycle
    # exactly like --probe-peer was.
    $probe = if ($state.local.localReady -and $state.tunnel.authReady) {
        Invoke-PeerHeartbeat
    } else { [pscustomobject]@{ ok = $false; code = 'FRA_LIFECYCLE_LOCAL_GATE_NOT_READY' } }
    # Required change 3 (2026-08-04 review): retain the heartbeat's own
    # stage/attempt/elapsedMs telemetry every eligible cycle -- success or
    # failure -- instead of reading $probe.stage/.attempt/.elapsedMs and
    # dropping them. Strict allowlist via Get-SanitizedHeartbeatTelemetry
    # above: nothing else from $probe is ever persisted here.
    #
    # lastAttempts (correction D, 2026-08-04 review round 2): the bounded
    # per-attempt summary, persisted alongside the three scalar fields above
    # so a recovered retry's masked attempt-1 failure survives in persisted
    # state too, not just in the in-process result.
    $heartbeatTelemetry = Get-SanitizedHeartbeatTelemetry $probe
    $state.heartbeat.lastStage = $heartbeatTelemetry.stage
    $state.heartbeat.lastAttempt = $heartbeatTelemetry.attempt
    $state.heartbeat.lastElapsedMs = $heartbeatTelemetry.elapsedMs
    $state.heartbeat.lastAttempts = $heartbeatTelemetry.attemptsHistory
    if ($probe.ok) {
        $state.phase = 'healthy'; $state.mismatch.streak = 0; $state.mismatch.firstObservedAt = $null
        $state.mismatch.authenticatedAfterLastRejection = $true; $state.lastAction = 'verified_existing_session'; Clear-Failure $state
        $state.heartbeat.lastSuccessAt = (Get-Date).ToUniversalTime().ToString('o')
        Clear-Failure $state $state.heartbeat
    } else {
        $state.phase = 'waiting_for_peer'; $state.lastErrorCode = Get-SafeCode $probe 'FRA_LIFECYCLE_PEER_PROBE_FAILED'
        if ($state.local.localReady -and $state.tunnel.authReady) {
            Set-Failure $state (Get-SafeCode $probe 'FRA_LIFECYCLE_HEARTBEAT_FAILED') $state.heartbeat
        }
    }

    if ($ForceRotate) { $state.rotation.trigger = 'explicit' }
    elseif ([int]$state.mismatch.streak -ge 2 -and $state.rotation.trigger -eq 'none') { $state.rotation.trigger = 'proof_mismatch' }
    $bRotationGate = [bool]($HostName -ceq $MachineBAddress -and $state.local.localReady -and
        $state.local.firewallReady -and $state.tunnel.healthReady -and $state.tunnel.authReady -and
        $state.rotation.trigger -ne 'none' -and (Test-RetryEligible $state))
    if ($bRotationGate) {
        if (-not (Test-EnrollmentFirewall)) {
            $state.phase = 'blocked'; Set-Failure $state 'FRA_LIFECYCLE_ENROLLMENT_FIREWALL_NOT_READY'
        } else {
            $enrollment = Invoke-Control 'EnrollmentStatus'
            if ($enrollment.enrollmentState -eq 'conflict') {
                $state.phase = 'blocked'; Set-Failure $state 'FRA_LIFECYCLE_ENROLLMENT_LISTENER_CONFLICT'
            } elseif ($enrollment.enrollmentState -eq 'owned') {
                $state.phase = 'receiver_open'; $state.rotation.state = 'receiver_open'; $state.rotation.receiverPid = $enrollment.enrollmentPid
            } else {
                $receiver = Invoke-Helper @('--start-receiver','--host',$HostName,'--port','8794') -TimeoutMilliseconds 30000
                if ($receiver.ok -and $receiver.status -eq 'ready') {
                    $trigger = [string]$state.rotation.trigger; $state.rotation = New-RotationState $trigger
                    $state.rotation.state = 'receiver_open'; $state.rotation.receiverPid = $receiver.pid
                    $state.phase = 'receiver_open'; $state.lastAction = 'opened_sealed_receiver'; Clear-Failure $state
                } else { $state.phase = 'degraded'; Set-Failure $state (Get-SafeCode $receiver) }
            }
        }
    }

    $aCoordinationGate = [bool]($HostName -ceq $MachineAAddress -and $state.tunnel.healthReady -and
        $state.tunnel.authReady -and (Test-RetryEligible $state) -and
        (Test-PortOpen -Address $PeerHost -Port $EnrollmentPort))
    if ($aCoordinationGate) {
        $coordinated = Invoke-Helper @('--coordinate','--host',$HostName,'--port','8794') -TimeoutMilliseconds 420000
        if ($coordinated.ok) {
            $state.rotation = New-RotationState 'peer_receiver'
            $state.rotation.operationId = $coordinated.operationId; $state.rotation.newFingerprint = $coordinated.tokenFingerprint
            Set-RotationProofBaseline $state $proofCount
            $state.rotation.terminalPhase = 'committed'; $state.rotation.committedAt = (Get-Date).ToUniversalTime().ToString('o')
            try {
                $status = Invoke-ReviewedRestart $state 'committed_rotation'
                $state.rotation.restartedAt = (Get-Date).ToUniversalTime().ToString('o')
                $state.rotation.state = 'verification_pending'; $state.phase = 'verification_pending'
                $state.lastAction = 'coordinated_and_restarted_rotation'; Clear-Failure $state
            } catch {
                $state.phase = 'recovery_required'; Set-Failure $state (Get-SafeCode $_.Exception.Message)
            }
        } else {
            $state.phase = 'recovery_required'; Set-Failure $state (Get-SafeCode $coordinated 'FRA_LIFECYCLE_COORDINATION_FAILED')
        }
    }
    Write-State $state
    return $state
}

$mutex = $null; $held = $false
try {
    # Both declared machines run the same customer lifecycle. Role-specific
    # authority remains enforced at the actual operations below: only the
    # recipient may open/force the enrollment receiver, and only the
    # coordinator may coordinate. A deployment-era whole-host block here made
    # the coordinator's own reconciliation and task-install paths unreachable.
    if ($Action -ne 'RetireRolledBackRecovery' -and
        (-not [string]::IsNullOrEmpty($OperationId) -or -not [string]::IsNullOrEmpty($Fingerprint))) {
        throw 'FRA_LIFECYCLE_ARGUMENT_INVALID'
    }
    $mutex = [Threading.Mutex]::new($false, $MutexName)
    try { $held = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $held = $true }
    if (-not $held) {
        [ordered]@{ ok = $true; action = 'busy'; secretValuesEmitted = $false } | ConvertTo-Json -Compress
        exit 0
    }
    $result = switch ($Action) {
        'InstallTask' { Install-LifecycleTask }
        'RemoveTask' { Remove-LifecycleTask }
        'Reconcile' { Invoke-Reconcile }
        'RetireRolledBackRecovery' { Invoke-RetireRolledBackRecovery }
        'RotateOnce' {
            if ($HostName -cne $MachineBAddress) { throw 'FRA_LIFECYCLE_ROTATE_B_ONLY' }
            Invoke-Reconcile -ForceRotate $true
        }
        default { Get-LiveStatusProjection }
    }
    $result | ConvertTo-Json -Depth 20 -Compress
} catch {
    [ordered]@{ ok = $false; action = $Action; code = Get-SafeCode $_.Exception.Message; secretValuesEmitted = $false } | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($held -and $null -ne $mutex) { try { $mutex.ReleaseMutex() } catch {} }
    if ($null -ne $mutex) { $mutex.Dispose() }
}
