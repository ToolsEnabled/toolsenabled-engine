# Idempotent, independently switchable lifecycle control for the Full Remote
# Access lane. This is intentionally separate from tunnel-bridge-control.ps1:
# it must not make an Agent Bridge or tunnel action start an unrestricted
# non-elevated terminal/files/processes surface.
[CmdletBinding()]
param(
    [ValidateSet('Status', 'EnrollmentStatus', 'CloseEnrollment', 'Start', 'Stop', 'Restart', 'Reconcile')]
    [string]$Action = 'Status',
    [string]$OperationId = $null,
    [string]$Fingerprint = $null
)

$ErrorActionPreference = 'Stop'
$PersistProjection = $Action -notin @('Status', 'EnrollmentStatus')
$Root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$RegistryHelper = Join-Path $Root 'tools\lib\service-registry.ps1'
if (-not (Test-Path -LiteralPath $RegistryHelper -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $RegistryHelper
$MinimumNodeVersion = [Version]'22.19.0'
# Ordered: a pinned side-by-side runtime first, the ordinary system install
# second. Both are version-gated below, so the order only decides which of two
# acceptable runtimes wins -- never whether an unacceptable one is used.
$OwnedNodeCandidates = @(
    'C:\agent-apps\node-v22.19.0\node.exe',
    'C:\Program Files\nodejs\node.exe'
)

function Resolve-ApprovedNode {
    foreach ($candidate in $OwnedNodeCandidates) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $rawVersion = [string]([Diagnostics.FileVersionInfo]::GetVersionInfo($candidate).ProductVersion)
            $versionText = ($rawVersion -split '[^0-9.]', 2)[0]
            $parsedVersion = $null
            if ([Version]::TryParse($versionText, [ref]$parsedVersion) -and $parsedVersion -ge $MinimumNodeVersion) {
                return [IO.Path]::GetFullPath($candidate)
            }
        } catch {}
    }
    throw 'NODE_22_19_OR_NEWER_MISSING'
}

$Node = $null
$OwnedNodePaths = @($OwnedNodeCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | ForEach-Object { [IO.Path]::GetFullPath($_) })
$Server = Join-Path $Root 'src\full-remote-access-bridge.js'
$ListenerHost = Join-Path $Root 'tools\full-remote-access-listener-host.js'
$EnrollmentScript = Join-Path $Root 'tools\fra-token-enrollment-lifecycle.js'
$StateDir = Join-Path $Root 'state'
$LogDir = Join-Path $Root 'logs'
$StopFile = Join-Path $StateDir 'full-remote-access.stop'
$StateFile = Join-Path $StateDir 'full-remote-access-state.json'
$PeerReceiptFile = Join-Path $StateDir 'full-remote-access-peer-session.json'
$PeerLivenessFile = Join-Path $StateDir 'full-remote-access-peer-liveness.json'
$InboundPeerReceiptFile = Join-Path $StateDir 'full-remote-access-inbound-session.json'
$PeerOldProofReceiptFile = Join-Path $StateDir 'full-remote-access-peer-old-proof.json'
$InboundPeerOldProofReceiptFile = Join-Path $StateDir 'full-remote-access-inbound-old-proof.json'
$ControlLog = Join-Path $LogDir 'full-remote-access-control.log'
$StdoutLog = Join-Path $LogDir 'full-remote-access.stdout.log'
$StderrLog = Join-Path $LogDir 'full-remote-access.stderr.log'
$EnrollmentStdoutLog = Join-Path $LogDir 'full-remote-access-enroll.stdout.log'
$EnrollmentStderrLog = Join-Path $LogDir 'full-remote-access-enroll.stderr.log'
$Port = 8790
$HealthPort = 8792
$EnrollmentPort = 8794
$PreflightTimeoutMs = 120000
$DispatcherHealthTimeoutMs = 120000
$HealthRequestTimeoutSec = 250
$StartHealthTimeoutMs = 300000
$FirewallRuleName = 'ToolsEnabled Full Remote Access (8790)'
$EnrollmentFirewallRuleName = 'ToolsEnabled FRA Enrollment 8794'
$StartMutexName = 'Global\ToolsEnabledFullRemoteAccessStart'
$EnrollmentMutexName = 'Global\ToolsEnabledFullRemoteAccessEnrollment'

function Resolve-DirectLinkHost {
    if ([string]::IsNullOrWhiteSpace($env:FULL_REMOTE_ACCESS_HOST)) {
        return Resolve-ServiceRegistryTopology -Root $Root
    }
    return Resolve-ServiceRegistryTopology -Root $Root -ConfiguredAddress $env:FULL_REMOTE_ACCESS_HOST
}

$HostName = $null
$PeerHost = $null
$MachineBAddress = $null

function Write-ControlLog {
    param([string]$Line)
    try {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
        Add-Content -LiteralPath $ControlLog -Value ((Get-Date).ToUniversalTime().ToString('o') + '  ' + $Line) -Encoding UTF8
    } catch {}
}

function Get-ExactListener {
    $listeners = @(Get-NetTCPConnection -LocalAddress $HostName -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        return [pscustomobject]@{ state = 'absent'; pid = $null; owned = $false; reason = $null }
    }
    if ($listeners.Count -ne 1) {
        return [pscustomobject]@{ state = 'conflict'; pid = $null; owned = $false; reason = 'multiple_listeners' }
    }
    $listenerPid = [int]$listeners[0].OwningProcess
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue
    $commandLine = if ($owner) { [string]$owner.CommandLine } else { '' }
    $ownedNode = [bool]($owner -and ($OwnedNodePaths | Where-Object {
        ([string]$owner.ExecutablePath).Equals($_, [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1))
    # UNVERIFIABLE IS A THIRD STATE, NOT A MISMATCH. An unelevated
    # Get-CimInstance returns an EMPTY CommandLine for a process owned by
    # another session -- which is every S4U scheduled task, and this listener is
    # now task-managed by the FRA keeper. The previous code compared that empty
    # string, found no match, and reported state=conflict with owned=false,
    # which then made healthy and operational false as well: three false
    # booleans about a listener that was serving traffic.
    #
    # The reason code was the only honest field, because the code really could
    # not match the identity -- it just had no way to say so. So say so.
    # 'unverifiable' is deliberately NOT 'owned': callers must not act on a
    # reading this privilege level could not make. It is also not 'conflict',
    # which sends the reader hunting a foreign process that does not exist.
    # BOTH identity fields go dark together. An unelevated read of a process in
    # another session returns an empty ExecutablePath AND an empty CommandLine,
    # so guarding only the command line is not enough: $ownedNode is already
    # false by then and the check falls through to 'conflict' anyway. Measured on
    # the live task-owned listener, which reported ExecutablePath '' and
    # CommandLine ''. Treat EITHER being blank as "cannot verify".
    $identityReadable = -not ([string]::IsNullOrWhiteSpace($commandLine) -or
        [string]::IsNullOrWhiteSpace([string]$owner.ExecutablePath))
    $owned = [bool]($owner -and $ownedNode -and $identityReadable -and
        $commandLine.IndexOf([IO.Path]::GetFullPath($ListenerHost), [StringComparison]::OrdinalIgnoreCase) -ge 0)
    $state = if ($owned) { 'owned' }
        elseif ($owner -and -not $identityReadable) { 'unverifiable' }
        else { 'conflict' }
    return [pscustomobject]@{
        state = $state
        pid = $listenerPid
        owned = $owned
        # 'mismatch' and 'unreadable' are different facts and must not share a
        # code: one sends the reader hunting a foreign process, the other tells
        # them to re-check elevated.
        reason = if ($owned) { $null }
            elseif ($state -eq 'unverifiable') { 'listener_identity_unreadable' }
            else { 'listener_identity_mismatch' }
    }
}

function Get-EnrollmentListener {
    $listeners = @(Get-NetTCPConnection -LocalAddress $HostName -LocalPort $EnrollmentPort -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        return [pscustomobject]@{ state = 'absent'; pid = $null; owned = $false; reason = $null }
    }
    if ($listeners.Count -ne 1) {
        return [pscustomobject]@{ state = 'conflict'; pid = $null; owned = $false; reason = 'multiple_enrollment_listeners' }
    }
    $listenerPid = [int]$listeners[0].OwningProcess
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue
    $commandLine = if ($owner) { [string]$owner.CommandLine } else { '' }
    $ownedNode = [bool]($owner -and ($OwnedNodePaths | Where-Object {
        ([string]$owner.ExecutablePath).Equals($_, [StringComparison]::OrdinalIgnoreCase)
    } | Select-Object -First 1))
    # Same third state as the listener check above: an empty command line means
    # this privilege level could not read the process, not that it is a foreign
    # one. See Get-ExactListener for the full reasoning.
    $identityReadable = -not [string]::IsNullOrWhiteSpace($commandLine)
    $owned = [bool]($owner -and $ownedNode -and $identityReadable -and
        $commandLine.IndexOf([IO.Path]::GetFullPath($EnrollmentScript), [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $commandLine.IndexOf('--receiver', [StringComparison]::Ordinal) -ge 0 -and
        $commandLine -match '(?i)(?:^|\s)"?--port"?\s+"?8794"?(?:\s|$)')
    $state = if ($owned) { 'owned' }
        elseif ($owner -and $ownedNode -and -not $identityReadable) { 'unverifiable' }
        else { 'conflict' }
    return [pscustomobject]@{
        state = $state
        pid = $listenerPid
        owned = $owned
        reason = if ($owned) { $null } else { 'enrollment_listener_identity_mismatch' }
    }
}

function Start-FraEnrollment {
    if ($HostName -cne $MachineBAddress) { throw 'FRA_ENROLLMENT_RECEIVER_B_ONLY' }
    if (-not (Test-Path -LiteralPath $EnrollmentScript -PathType Leaf)) { throw 'FRA_ENROLLMENT_SCRIPT_MISSING' }
    $mutex = New-Object System.Threading.Mutex($false, $EnrollmentMutexName)
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'FRA_ENROLLMENT_BUSY' }
        $identity = Get-EnrollmentListener
        if ($identity.state -eq 'conflict') { throw 'FRA_ENROLLMENT_PORT_CONFLICT' }
        if ($identity.owned) {
            return [pscustomobject]@{ action = 'enrollment_already_ready'; pid = $identity.pid; port = $EnrollmentPort; peer = $PeerHost }
        }
        if ($identity.state -eq 'unverifiable') {
            # Same principle as the main 8790 listener in Start-OwnedListener:
            # a bound-but-unidentifiable process on $EnrollmentPort must never
            # be treated as absent. Unlike 8790, this one-shot receiver has no
            # sibling health endpoint to cross-check by PID, so there is no
            # proof available that could make it safe to say "ready" -- only
            # refuse, never spawn a second receiver against a live port.
            throw 'FRA_ENROLLMENT_LISTENER_UNVERIFIABLE'
        }
        $enrollmentFirewall = Get-EnrollmentFirewallReadiness
        if (-not $enrollmentFirewall.ready) { throw 'FRA_ENROLLMENT_FIREWALL_NOT_READY' }
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
        $hadHost = Test-Path Env:FULL_REMOTE_ACCESS_ENROLL_HOST
        $priorHost = $env:FULL_REMOTE_ACCESS_ENROLL_HOST
        try {
            $env:FULL_REMOTE_ACCESS_ENROLL_HOST = $HostName
            $child = Start-Process -FilePath $Node -ArgumentList @(
                $EnrollmentScript, '--receiver', '--host', $HostName, '--port', [string]$EnrollmentPort
            ) -WorkingDirectory $Root `
                -WindowStyle Hidden -RedirectStandardOutput $EnrollmentStdoutLog -RedirectStandardError $EnrollmentStderrLog -PassThru
        } finally {
            if ($hadHost) { $env:FULL_REMOTE_ACCESS_ENROLL_HOST = $priorHost }
            else { Remove-Item Env:FULL_REMOTE_ACCESS_ENROLL_HOST -ErrorAction SilentlyContinue }
        }
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep -Milliseconds 125
            $identity = Get-EnrollmentListener
            if ($identity.owned) {
                Write-ControlLog ('FRA one-shot enrollment ready pid=' + $identity.pid + ' peer=' + $PeerHost)
                return [pscustomobject]@{ action = 'enrollment_ready'; pid = $identity.pid; port = $EnrollmentPort; peer = $PeerHost }
            }
            if ($child.HasExited) { throw 'FRA_ENROLLMENT_START_FAILED' }
        }
        throw 'FRA_ENROLLMENT_START_TIMEOUT'
    } finally {
        if ($locked) { try { $mutex.ReleaseMutex() } catch {} }
        $mutex.Dispose()
    }
}

function Stop-FraEnrollment {
    $identity = Get-EnrollmentListener
    if (-not $identity.owned) {
        return [pscustomobject]@{ action = if ($identity.state -eq 'absent') { 'enrollment_already_stopped' } else { 'enrollment_stop_refused' }; pid = $identity.pid }
    }
    Stop-Process -Id $identity.pid -Force -ErrorAction Stop
    try { Wait-Process -Id $identity.pid -Timeout 5 -ErrorAction SilentlyContinue } catch {}
    Write-ControlLog ('stopped FRA one-shot enrollment pid=' + $identity.pid)
    return [pscustomobject]@{ action = 'enrollment_stopped'; pid = $identity.pid }
}

function Test-EnrollmentCloseAuthorization {
    param([string]$ExpectedOperationId, [string]$ExpectedFingerprint)
    if ($HostName -cne $MachineBAddress -or -not (Test-Path -LiteralPath $Node -PathType Leaf) -or
        -not (Test-Path -LiteralPath $EnrollmentScript -PathType Leaf)) { return $false }
    $output = @()
    $child = $null
    $timedOut = $false
    $tag = ([guid]::NewGuid().ToString('N'))
    $statusOut = Join-Path $LogDir ('full-remote-access-enrollment-status.' + $PID + '.' + $tag + '.stdout.tmp')
    $statusErr = Join-Path $LogDir ('full-remote-access-enrollment-status.' + $PID + '.' + $tag + '.stderr.tmp')
    try {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
        $child = Start-Process -FilePath $Node -ArgumentList @(
            $EnrollmentScript, '--transaction-status', '--host', $HostName, '--port', [string]$EnrollmentPort
        ) -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $statusOut -RedirectStandardError $statusErr -PassThru
        if (-not $child.WaitForExit(30000)) {
            $timedOut = $true
            Stop-Process -Id ([int]$child.Id) -ErrorAction SilentlyContinue
            try { $child.WaitForExit(5000) | Out-Null } catch {}
        } else {
            $child.Refresh()
            if (Test-Path -LiteralPath $statusOut -PathType Leaf) { $output = @(Get-Content -LiteralPath $statusOut -ErrorAction SilentlyContinue) }
        }
    } catch {
        return $false
    } finally {
        if ($child -and -not $child.HasExited) { Stop-Process -Id ([int]$child.Id) -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $statusOut,$statusErr -Force -ErrorAction SilentlyContinue
    }
    if ($timedOut -or -not $child -or $child.ExitCode -ne 0) { return $false }
    try { $transaction = [string]($output | Select-Object -Last 1) | ConvertFrom-Json -ErrorAction Stop } catch { return $false }
    return [bool]($transaction.secretValuesEmitted -eq $false -and $transaction.phase -eq 'committed' -and
        $transaction.operationId -eq $ExpectedOperationId -and $transaction.newFingerprint -eq $ExpectedFingerprint)
}

function Close-FraEnrollment {
    if ($HostName -cne $MachineBAddress) { throw 'FRA_ENROLLMENT_RECEIVER_B_ONLY' }
    if (-not (Test-EnrollmentCloseAuthorization -ExpectedOperationId $OperationId -ExpectedFingerprint $Fingerprint)) {
        throw 'FRA_ENROLLMENT_CLOSE_TRANSACTION_UNVERIFIED'
    }
    $identity = Get-EnrollmentListener
    if ($identity.state -eq 'conflict') { throw 'FRA_ENROLLMENT_PORT_CONFLICT' }
    $result = Stop-FraEnrollment
    $after = Get-EnrollmentListener
    if ($after.state -ne 'absent') { throw 'FRA_ENROLLMENT_CLOSE_FAILED' }
    Write-ControlLog ('closed only FRA enrollment receiver action=' + $result.action)
    return [ordered]@{ enrollment = $result; receiverClosed = $true }
}

function Get-EmptyServiceHealthReport {
    return [pscustomobject]@{
        localReady = $false
        dispatcherReady = $false
        secureTransportReady = $false
        runtimeIntegrityReady = $false
        runtimeDigest = $null
        rootIdentityReady = $false
        rootAccessReady = $false
        transportBindingReady = $false
        rootAccessPolicyDigest = $null
        policyDigest = $null
        capabilityManifestReady = $false
        credentialBoundaryReady = $false
        desktopPolicyReady = $false
        desktopObservationReady = $false
        peerSessionReady = $false
        peerSessionAgeSeconds = $null
        credentialProofRejections = 0
        lastCredentialProofRejectionAgeSeconds = $null
        protocolVersion = $null
        capabilityManifestVersion = $null
    }
}

function Get-ServiceHealthReport {
    $failed = Get-EmptyServiceHealthReport
    try {
        # The loopback health server shares the FRA dispatcher event loop. A
        # previously admitted tools/list can legitimately occupy that loop for
        # almost 100 seconds, after which the health request performs its own
        # bounded 120-second dispatcher probe. Cover both measured phases so a
        # healthy owned listener is not recycled on a false 10-second timeout.
        $response = Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:' + $HealthPort + '/health') -TimeoutSec $HealthRequestTimeoutSec
        $body = $response.Content | ConvertFrom-Json
        $dispatcherReady = [bool]($response.StatusCode -eq 200 -and $body.ok -eq $true -and $body.dispatcherHealthy -eq $true)
        return [pscustomobject]@{
            localReady = $dispatcherReady
            dispatcherReady = $dispatcherReady
            secureTransportReady = [bool]($body.protocolVersion -eq 2 -and $body.encryptedTransport -eq $true)
            runtimeIntegrityReady = [bool]($body.runtimeIntegrityReady -eq $true -and [string]$body.runtimeDigest -match '^[a-f0-9]{64}$')
            runtimeDigest = if ([string]$body.runtimeDigest -match '^[a-f0-9]{64}$') { [string]$body.runtimeDigest } else { $null }
            rootIdentityReady = [bool]($body.rootIdentityReady -eq $true)
            rootAccessReady = [bool]($body.rootAccessReady -eq $true -and [string]$body.rootAccessPolicyDigest -match '^[a-f0-9]{64}$')
            transportBindingReady = [bool]($body.transportBindingReady -eq $true -and [string]$body.policyDigest -match '^[a-f0-9]{64}$')
            rootAccessPolicyDigest = if ([string]$body.rootAccessPolicyDigest -match '^[a-f0-9]{64}$') { [string]$body.rootAccessPolicyDigest } else { $null }
            policyDigest = if ([string]$body.policyDigest -match '^[a-f0-9]{64}$') { [string]$body.policyDigest } else { $null }
            capabilityManifestReady = [bool]($body.capabilityManifestReady -eq $true)
            credentialBoundaryReady = [bool]($body.credentialBoundaryReady -eq $true)
            desktopPolicyReady = [bool]($body.desktopPolicyReady -eq $true)
            desktopObservationReady = [bool]($body.desktopObservationReady -eq $true)
            peerSessionReady = [bool]($body.peerSessionReady -eq $true)
            peerSessionAgeSeconds = if ($null -ne $body.peerSessionAgeSeconds) { [int]$body.peerSessionAgeSeconds } else { $null }
            credentialProofRejections = if ($null -ne $body.credentialProofRejections) { [int64]$body.credentialProofRejections } else { 0 }
            lastCredentialProofRejectionAgeSeconds = if ($null -ne $body.lastCredentialProofRejectionAgeSeconds) { [int]$body.lastCredentialProofRejectionAgeSeconds } else { $null }
            protocolVersion = if ($null -ne $body.protocolVersion) { [int]$body.protocolVersion } else { $null }
            capabilityManifestVersion = if ($null -ne $body.capabilityManifestVersion) { [int]$body.capabilityManifestVersion } else { $null }
        }
    } catch {
        return $failed
    }
}

function Test-ServiceHealth {
    return [bool](Get-ServiceHealthReport).localReady
}

# Pure identity-match predicate, deliberately separated from the live
# Get-NetTCPConnection call below so it can be exercised directly against
# fabricated listener rows -- including the health-endpoint-PID-mismatch
# case -- without needing a real socket bound anywhere.
function Test-HealthListenerPidMatch {
    param($Listeners, [int]$ExpectedPid)
    $rows = @($Listeners)
    if ($rows.Count -ne 1) { return $false }
    return [bool]([int]$rows[0].OwningProcess -eq $ExpectedPid)
}

function Get-HealthListenerPidMatch {
    param([int]$ExpectedPid)
    $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $HealthPort -State Listen -ErrorAction SilentlyContinue)
    return Test-HealthListenerPidMatch -Listeners $listeners -ExpectedPid $ExpectedPid
}

# The single source of truth for "is this listener ready to be treated as
# operational," shared by Get-StatusReport's projection AND Start-OwnedListener's
# decision not to spawn a second process. 'owned' stays a strict positive
# identification (see Get-ExactListener) and this function does not change
# what that means -- it only recognises a SECOND, independent way to reach
# readiness: an 'unverifiable' listener (this privilege level could not read
# its command line -- the S4U/elevation observability gap) whose loopback
# health listener on $HealthPort is proven to be the SAME process via PID,
# and whose full health gates all pass. Absent that proof, an unverifiable
# listener is never ready -- it is treated exactly like a genuinely unhealthy
# one, never like an owned one.
function Test-ListenerReady {
    param($Identity, [bool]$SameProcessHealthListener, $Health)
    if ([bool]$Identity.owned) { return $true }
    if ([string]$Identity.state -ne 'unverifiable') { return $false }
    if (-not $SameProcessHealthListener) { return $false }
    return [bool]($Health.localReady -and $Health.secureTransportReady -and $Health.runtimeIntegrityReady -and
        $Health.rootIdentityReady -and $Health.rootAccessReady -and $Health.transportBindingReady -and
        $Health.capabilityManifestReady -and $Health.credentialBoundaryReady -and $Health.desktopPolicyReady)
}

# Runs the same identity-match-plus-health-gates proof Get-StatusReport uses,
# for a caller (Start-OwnedListener) that only needs the final verdict, not
# the full status projection. Kept as a thin composition of the primitives
# above rather than a third copy of the same logic, so the projection and the
# start-refusal decision can never drift apart.
function Get-UnverifiableListenerReadiness {
    param($Identity)
    $sameProcess = [bool]($Identity.state -eq 'unverifiable' -and $Identity.pid -and
        (Get-HealthListenerPidMatch -ExpectedPid ([int]$Identity.pid)))
    $health = if ($sameProcess) { Get-ServiceHealthReport } else { Get-EmptyServiceHealthReport }
    return [pscustomobject]@{
        sameProcessHealthListener = $sameProcess
        health = $health
        ready = (Test-ListenerReady -Identity $Identity -SameProcessHealthListener $sameProcess -Health $health)
    }
}

function Get-ExactPeerFirewallReadiness {
    # Get-NetFirewallRule (and the Get-NetFirewallPortFilter/
    # -AddressFilter cmdlets that depend on it) silently returns an EMPTY
    # result set when this process is not elevated, even though the rule
    # genuinely exists and is correctly scoped -- confirmed live via `netsh
    # advfirewall firewall show rule`, which does not require elevation and
    # correctly shows all four FRA-related rules present, enabled, and
    # correctly peer-scoped. The scheduled tasks that run this code are
    # deliberately unelevated (RunLevel Limited), so this false negative is
    # masked today only because listener_not_owned already reports first in
    # the priority chain; once the listener starts, the exact same false
    # negative would block operational=true with a misleading
    # firewall_rule_missing reason even though the firewall is fine. This is
    # a pure accuracy fix -- the rule-presence requirement itself is
    # unchanged, only how it is measured, via the elevation-independent
    # `netsh advfirewall firewall show rule` text output instead.
    param([string]$RuleName, [int]$ExpectedPort, [string]$ReasonPrefix)
    try {
        $output = & netsh advfirewall firewall show rule name="$RuleName"
        $text = [string]::Join("`n", @($output))
        if ($text -match 'No rules match the specified criteria') {
            return [pscustomobject]@{ ready = $false; reason = ($ReasonPrefix + '_missing') }
        }
        $ruleBlocks = @([regex]::Matches($text, '(?m)^Rule Name:'))
        if ($ruleBlocks.Count -eq 0) {
            return [pscustomobject]@{ ready = $false; reason = ($ReasonPrefix + '_missing') }
        }
        if ($ruleBlocks.Count -ne 1) {
            return [pscustomobject]@{ ready = $false; reason = ($ReasonPrefix + '_not_unique') }
        }
        $enabledMatch = [regex]::Match($text, '(?m)^Enabled:\s*(\S+)\s*$')
        $directionMatch = [regex]::Match($text, '(?m)^Direction:\s*(\S+)\s*$')
        $actionMatch = [regex]::Match($text, '(?m)^Action:\s*(\S+)\s*$')
        if (-not $enabledMatch.Success -or $enabledMatch.Groups[1].Value -ne 'Yes' -or
            -not $directionMatch.Success -or $directionMatch.Groups[1].Value -ne 'In' -or
            -not $actionMatch.Success -or $actionMatch.Groups[1].Value -ne 'Allow') {
            return [pscustomobject]@{ ready = $false; reason = ($ReasonPrefix + '_policy_mismatch') }
        }
        $protocolMatch = [regex]::Match($text, '(?m)^Protocol:\s*(\S+)\s*$')
        $localPortMatch = [regex]::Match($text, '(?m)^LocalPort:\s*(\S+)\s*$')
        if (-not $protocolMatch.Success -or $protocolMatch.Groups[1].Value -ne 'TCP' -or
            -not $localPortMatch.Success -or $localPortMatch.Groups[1].Value -ne [string]$ExpectedPort) {
            return [pscustomobject]@{ ready = $false; reason = ($ReasonPrefix + '_port_mismatch') }
        }
        $remoteIpMatch = [regex]::Match($text, '(?m)^RemoteIP:\s*(\S+)\s*$')
        if (-not $remoteIpMatch.Success) {
            return [pscustomobject]@{ ready = $false; reason = ($ReasonPrefix + '_peer_mismatch') }
        }
        # netsh renders a single address as an identical start-end range
        # (e.g. "192.0.2.2-192.0.2.2"), never a bare address -- so a
        # genuinely single-peer scope must be unwrapped before comparison,
        # while anything that is NOT that exact same-start-end shape (a real
        # range, a list, "Any") is correctly rejected as not exactly
        # peer-scoped.
        $remoteAddresses = @($remoteIpMatch.Groups[1].Value -split ',' | ForEach-Object {
            $part = $_.Trim()
            $rangeMatch = [regex]::Match($part, '^(?<start>[0-9.]+)-(?<finish>[0-9.]+)$')
            if ($rangeMatch.Success -and $rangeMatch.Groups['start'].Value -eq $rangeMatch.Groups['finish'].Value) {
                $rangeMatch.Groups['start'].Value
            } else { $part }
        })
        if ($remoteAddresses.Count -ne 1 -or $remoteAddresses[0] -ne $PeerHost) {
            return [pscustomobject]@{ ready = $false; reason = ($ReasonPrefix + '_peer_mismatch') }
        }
        return [pscustomobject]@{ ready = $true; reason = $null }
    } catch {
        return [pscustomobject]@{ ready = $false; reason = ($ReasonPrefix + '_unverifiable') }
    }
}

function Get-FirewallReadiness {
    return Get-ExactPeerFirewallReadiness -RuleName $FirewallRuleName -ExpectedPort $Port -ReasonPrefix 'firewall_rule'
}

function Get-EnrollmentFirewallReadiness {
    return Get-ExactPeerFirewallReadiness -RuleName $EnrollmentFirewallRuleName -ExpectedPort $EnrollmentPort -ReasonPrefix 'enrollment_firewall_rule'
}

function Get-PeerReceiptReadiness {
    param(
        [string]$ReceiptPath = $PeerReceiptFile,
        [string]$ExpectedSchema = 'full-remote-access-peer-session.v4',
        [string]$ReasonPrefix = 'peer_receipt',
        # The receipt is a write-once continuity pin: it proves "this is the
        # binding we are pinned to," not "we succeeded recently." IgnoreAge
        # lets a caller ask the first question without also asking the
        # second, which is a different question with its own answer now
        # covered by Get-OutboundLivenessReadiness below. The 600-second
        # bound itself is untouched -- IgnoreAge only decides whether this
        # call can fail on it.
        [switch]$IgnoreAge
    )
    if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) {
        return [pscustomobject]@{ ready = $false; ageSeconds = $null; authenticatedAt = $null; reason = ($ReasonPrefix + '_missing'); registryNameDigest = $null; allowedToolNamesDigest = $null; transportContextDigest = $null }
    }
    try {
        $receipt = Get-Content -LiteralPath $ReceiptPath -Raw -ErrorAction Stop | ConvertFrom-Json
        if ([string]$receipt.schemaVersion -ne $ExpectedSchema -or
            [int]$receipt.protocolVersion -ne 2 -or [string]$receipt.localHost -ne $HostName -or
            [string]$receipt.peerHost -ne $PeerHost -or $receipt.secretValuesEmitted -ne $false -or
            [int]$receipt.generation -lt 1 -or
            $null -ne $receipt.PSObject.Properties['bridgeRoot'] -or
            $null -ne $receipt.PSObject.Properties['workingDirectory'] -or
            [string]$receipt.registryNameDigest -notmatch '^[a-f0-9]{64}$' -or
            [string]$receipt.allowedToolNamesDigest -notmatch '^[a-f0-9]{64}$' -or
            # The parentheses are load-bearing. A pipeline binds looser than
            # -or, so without them PowerShell evaluates the whole -or chain
            # first, finds a non-empty array as its last operand, yields $true,
            # and pipes THAT into Where-Object -- which then tests
            # $receipt.True, a property no receipt has. Every receipt, valid or
            # not, was reported peer_receipt_invalid, so operational could
            # never become true on either machine no matter what was fixed
            # upstream. Verified: without the parentheses a receipt whose
            # fields all pass still returns INVALID; with them it returns valid
            # and a receipt with one bad digest is still rejected.
            ($('contextDigest', 'deviceIdentityDigest', 'rootIdentityDigest', 'rootAclDigest',
               'runtimeDigest', 'policyDigest', 'capabilityProfileDigest', 'resultProjectorDigest') |
                Where-Object { [string]$receipt.$_ -notmatch '^[a-f0-9]{64}$' })) {
            return [pscustomobject]@{ ready = $false; ageSeconds = $null; authenticatedAt = $null; reason = ($ReasonPrefix + '_invalid'); registryNameDigest = $null; allowedToolNamesDigest = $null; transportContextDigest = $null }
        }
        $rotationEmpty = $null -eq $receipt.rotationKind -and $null -eq $receipt.rotationOperationId -and
            $null -eq $receipt.rotationPreviousFingerprint -and $null -eq $receipt.rotationCurrentFingerprint -and
            $null -eq $receipt.rotationRejectionCode -and $null -eq $receipt.rotationNonce
        $rotationBound = [string]$receipt.rotationKind -in @('current','old-token-rejected') -and
            [string]$receipt.rotationOperationId -match '^[A-Za-z0-9_-]{22}$' -and
            ($null -eq $receipt.rotationPreviousFingerprint -or [string]$receipt.rotationPreviousFingerprint -match '^[A-Za-z0-9_-]{43}$') -and
            [string]$receipt.rotationCurrentFingerprint -match '^[A-Za-z0-9_-]{43}$' -and
            [string]$receipt.rotationNonce -match '^[A-Za-z0-9_-]{22}$' -and
            (([string]$receipt.rotationKind -eq 'current' -and $null -eq $receipt.rotationRejectionCode) -or
             ([string]$receipt.rotationKind -eq 'old-token-rejected' -and [string]$receipt.rotationRejectionCode -match '^[A-Z0-9_.-]{1,100}$'))
        if (-not ($rotationEmpty -or $rotationBound)) {
            return [pscustomobject]@{ ready = $false; ageSeconds = $null; authenticatedAt = $null; reason = ($ReasonPrefix + '_rotation_invalid'); registryNameDigest = $null; allowedToolNamesDigest = $null; transportContextDigest = $null }
        }
        $authenticatedAt = [DateTimeOffset]::Parse([string]$receipt.authenticatedAt).ToUniversalTime()
        $age = [int][Math]::Floor(((Get-Date).ToUniversalTime() - $authenticatedAt.UtcDateTime).TotalSeconds)
        if (-not $IgnoreAge -and ($age -lt -30 -or $age -gt 600)) {
            return [pscustomobject]@{ ready = $false; ageSeconds = $age; authenticatedAt = $authenticatedAt.UtcDateTime.ToString('o'); reason = ($ReasonPrefix + '_stale'); registryNameDigest = [string]$receipt.registryNameDigest; allowedToolNamesDigest = [string]$receipt.allowedToolNamesDigest; transportContextDigest = [string]$receipt.contextDigest; rotationKind = $receipt.rotationKind; rotationOperationId = $receipt.rotationOperationId; rotationPreviousFingerprint = $receipt.rotationPreviousFingerprint; rotationCurrentFingerprint = $receipt.rotationCurrentFingerprint; rotationRejectionCode = $receipt.rotationRejectionCode; rotationNonce = $receipt.rotationNonce }
        }
        return [pscustomobject]@{ ready = $true; ageSeconds = [Math]::Max(0, $age); authenticatedAt = $authenticatedAt.UtcDateTime.ToString('o'); reason = $null; registryNameDigest = [string]$receipt.registryNameDigest; allowedToolNamesDigest = [string]$receipt.allowedToolNamesDigest; transportContextDigest = [string]$receipt.contextDigest; rotationKind = $receipt.rotationKind; rotationOperationId = $receipt.rotationOperationId; rotationPreviousFingerprint = $receipt.rotationPreviousFingerprint; rotationCurrentFingerprint = $receipt.rotationCurrentFingerprint; rotationRejectionCode = $receipt.rotationRejectionCode; rotationNonce = $receipt.rotationNonce }
    } catch {
        return [pscustomobject]@{ ready = $false; ageSeconds = $null; authenticatedAt = $null; reason = ($ReasonPrefix + '_unreadable'); registryNameDigest = $null; allowedToolNamesDigest = $null; transportContextDigest = $null }
    }
}

function Get-InboundPeerReceiptReadiness {
    return Get-PeerReceiptReadiness -ReceiptPath $InboundPeerReceiptFile -ExpectedSchema 'full-remote-access-inbound-session.v2' -ReasonPrefix 'inbound_peer_receipt'
}

function Get-PeerOldProofReceiptReadiness {
    return Get-PeerReceiptReadiness -ReceiptPath $PeerOldProofReceiptFile -ExpectedSchema 'full-remote-access-peer-session.v4' -ReasonPrefix 'peer_old_proof_receipt'
}

function Get-InboundPeerOldProofReceiptReadiness {
    return Get-PeerReceiptReadiness -ReceiptPath $InboundPeerOldProofReceiptFile -ExpectedSchema 'full-remote-access-inbound-session.v2' -ReasonPrefix 'inbound_peer_old_proof_receipt'
}

function Get-OutboundLivenessReadiness {
    # Sibling to Get-PeerReceiptReadiness, not a fifth call through it: this
    # file carries no continuity/digest/rotation fields, only an identity
    # pair and a timestamp, so it needs none of that validation -- only the
    # same -30..600s freshness bound the receipt's own age check used to
    # gate readiness on before that responsibility moved here.
    param(
        [string]$LivenessPath = $PeerLivenessFile,
        [string]$ExpectedSchema = 'full-remote-access-peer-liveness.v1',
        [string]$ReasonPrefix = 'outbound_liveness'
    )
    if (-not (Test-Path -LiteralPath $LivenessPath -PathType Leaf)) {
        return [pscustomobject]@{ ready = $false; ageSeconds = $null; authenticatedAt = $null; reason = ($ReasonPrefix + '_missing') }
    }
    try {
        $liveness = Get-Content -LiteralPath $LivenessPath -Raw -ErrorAction Stop | ConvertFrom-Json
        if ([string]$liveness.schemaVersion -ne $ExpectedSchema -or
            [string]$liveness.localHost -ne $HostName -or [string]$liveness.peerHost -ne $PeerHost -or
            $liveness.secretValuesEmitted -ne $false) {
            return [pscustomobject]@{ ready = $false; ageSeconds = $null; authenticatedAt = $null; reason = ($ReasonPrefix + '_invalid') }
        }
        $authenticatedAt = [DateTimeOffset]::Parse([string]$liveness.authenticatedAt).ToUniversalTime()
        $age = [int][Math]::Floor(((Get-Date).ToUniversalTime() - $authenticatedAt.UtcDateTime).TotalSeconds)
        if ($age -lt -30 -or $age -gt 600) {
            return [pscustomobject]@{ ready = $false; ageSeconds = $age; authenticatedAt = $authenticatedAt.UtcDateTime.ToString('o'); reason = ($ReasonPrefix + '_stale') }
        }
        return [pscustomobject]@{ ready = $true; ageSeconds = [Math]::Max(0, $age); authenticatedAt = $authenticatedAt.UtcDateTime.ToString('o'); reason = $null }
    } catch {
        return [pscustomobject]@{ ready = $false; ageSeconds = $null; authenticatedAt = $null; reason = ($ReasonPrefix + '_unreadable') }
    }
}

function Get-StatusReport {
    $identity = Get-ExactListener
    $enrollment = Get-EnrollmentListener
    $disabled = Test-Path -LiteralPath $StopFile
    # An 'unverifiable' listener earns the SAME health probe an owned one
    # gets, but only once its identity is cross-checked against the loopback
    # health listener by PID -- never on the strength of "unverifiable" alone.
    # See Test-ListenerReady for why this, and only this, is enough to treat
    # it as ready without ever calling it 'owned'.
    $sameProcessHealthListener = [bool]($identity.state -eq 'unverifiable' -and $identity.pid -and -not $disabled -and
        (Get-HealthListenerPidMatch -ExpectedPid ([int]$identity.pid)))
    $health = if (($identity.owned -or $sameProcessHealthListener) -and -not $disabled) {
        Get-ServiceHealthReport
    } else {
        Get-EmptyServiceHealthReport
    }
    $listenerReady = Test-ListenerReady -Identity $identity -SameProcessHealthListener $sameProcessHealthListener -Health $health
    $firewall = Get-FirewallReadiness
    $enrollmentFirewall = Get-EnrollmentFirewallReadiness
    # -IgnoreAge: this call now answers only "is the continuity receipt a
    # structurally valid, correctly bound pin" (unbounded in time). Whether
    # the outbound session is FRESH is a separate question, answered below by
    # Get-OutboundLivenessReadiness against its own always-refreshed file --
    # the receipt's own age is no longer part of the outbound readiness gate.
    $peerReceipt = Get-PeerReceiptReadiness -IgnoreAge
    $inboundPeerReceipt = Get-InboundPeerReceiptReadiness
    $peerOldProofReceipt = Get-PeerOldProofReceiptReadiness
    $inboundPeerOldProofReceipt = Get-InboundPeerOldProofReceiptReadiness
    $outboundLiveness = Get-OutboundLivenessReadiness
    $outboundPeerReceiptReady = [bool]($peerReceipt.ready -and $outboundLiveness.ready)
    $inboundPeerReceiptReady = [bool]$inboundPeerReceipt.ready
    $peerSessionReady = [bool]($health.peerSessionReady -or $outboundPeerReceiptReady -or $inboundPeerReceiptReady)
    $peerSessionAgeSeconds = if ($outboundPeerReceiptReady) { $peerReceipt.ageSeconds } elseif ($inboundPeerReceiptReady) { $inboundPeerReceipt.ageSeconds } else { $health.peerSessionAgeSeconds }
    $peerSessionSource = if ($outboundPeerReceiptReady) { 'outbound_authenticated_receipt' } elseif ($inboundPeerReceiptReady) { 'inbound_authenticated_receipt' } elseif ($health.peerSessionReady) { 'inbound_authenticated_session' } else { 'none' }
    $operational = [bool](-not $disabled -and $listenerReady -and $health.localReady -and
        $health.secureTransportReady -and $health.runtimeIntegrityReady -and $health.rootIdentityReady -and
        $health.rootAccessReady -and $health.transportBindingReady -and $health.capabilityManifestReady -and
        $health.credentialBoundaryReady -and $health.desktopPolicyReady -and
        $firewall.ready -and $peerSessionReady)
    $readinessReason = if ($disabled) { 'disabled' }
        elseif ($enrollment.owned -and $enrollmentFirewall.ready) { 'credential_enrollment_ready' }
        elseif ($enrollment.owned) { $enrollmentFirewall.reason }
        elseif ($enrollment.state -eq 'conflict') { if ($enrollment.reason) { $enrollment.reason } else { 'enrollment_listener_conflict' } }
        elseif (-not $listenerReady) { if ($identity.reason) { $identity.reason } else { 'listener_not_owned' } }
        elseif (-not $health.localReady) { 'dispatcher_not_ready' }
        elseif (-not $health.secureTransportReady) { 'secure_transport_not_ready' }
        elseif (-not $health.runtimeIntegrityReady) { 'runtime_integrity_not_ready' }
        elseif (-not $health.rootIdentityReady) { 'root_identity_not_ready' }
        elseif (-not $health.rootAccessReady) { 'root_access_not_ready' }
        elseif (-not $health.transportBindingReady) { 'transport_binding_not_ready' }
        elseif (-not $health.capabilityManifestReady) { 'capability_manifest_not_ready' }
        elseif (-not $health.credentialBoundaryReady) { 'credential_boundary_not_ready' }
        elseif (-not $health.desktopPolicyReady) { 'desktop_policy_not_ready' }
        elseif (-not $firewall.ready) { $firewall.reason }
        elseif (-not $peerSessionReady) { if ($peerReceipt.reason) { $peerReceipt.reason } elseif ($outboundLiveness.reason) { $outboundLiveness.reason } else { 'peer_session_not_verified' } }
        else { $null }
    return [ordered]@{
        schemaVersion = 'full-remote-access-control.v2'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        action = $Action
        host = $HostName
        peer = $PeerHost
        port = $Port
        healthPort = $HealthPort
        dispatcherHealthTimeoutMs = $DispatcherHealthTimeoutMs
        healthRequestTimeoutSeconds = $HealthRequestTimeoutSec
        enrollmentPort = $EnrollmentPort
        root = $Root
        rootExists = Test-Path -LiteralPath $Root -PathType Container
        desiredState = if ($disabled) { 'disabled' } else { 'enabled' }
        stopRequested = [bool]$disabled
        listenerState = $identity.state
        enrollmentState = $enrollment.state
        enrollmentPid = $enrollment.pid
        enrollmentReady = [bool]($enrollment.owned -and $enrollmentFirewall.ready)
        enrollmentFirewallReady = [bool]$enrollmentFirewall.ready
        enrollmentFirewallReason = $enrollmentFirewall.reason
        pid = $identity.pid
        owned = [bool]$identity.owned
        healthy = [bool]$health.localReady
        listenerReady = [bool]$listenerReady
        dispatcherReady = [bool]$health.dispatcherReady
        secureTransportReady = [bool]$health.secureTransportReady
        runtimeIntegrityReady = [bool]$health.runtimeIntegrityReady
        runtimeDigest = $health.runtimeDigest
        rootIdentityReady = [bool]$health.rootIdentityReady
        rootAccessReady = [bool]$health.rootAccessReady
        transportBindingReady = [bool]$health.transportBindingReady
        rootAccessPolicyDigest = $health.rootAccessPolicyDigest
        policyDigest = $health.policyDigest
        capabilityManifestReady = [bool]$health.capabilityManifestReady
        capabilityManifestVersion = $health.capabilityManifestVersion
        credentialBoundaryReady = [bool]$health.credentialBoundaryReady
        desktopPolicyReady = [bool]$health.desktopPolicyReady
        desktopObservationReady = [bool]$health.desktopObservationReady
        firewallReady = [bool]$firewall.ready
        firewallReason = $firewall.reason
        peerSessionReady = $peerSessionReady
        peerSessionAgeSeconds = $peerSessionAgeSeconds
        outboundPeerReceiptReady = $outboundPeerReceiptReady
        outboundPeerReceiptAuthenticatedAt = $peerReceipt.authenticatedAt
        outboundLivenessReady = [bool]$outboundLiveness.ready
        outboundLivenessAuthenticatedAt = $outboundLiveness.authenticatedAt
        outboundLivenessAgeSeconds = $outboundLiveness.ageSeconds
        outboundLivenessReason = $outboundLiveness.reason
        outboundPeerReceiptRotationKind = $peerReceipt.rotationKind
        outboundPeerReceiptRotationOperationId = $peerReceipt.rotationOperationId
        outboundPeerReceiptRotationPreviousFingerprint = $peerReceipt.rotationPreviousFingerprint
        outboundPeerReceiptRotationCurrentFingerprint = $peerReceipt.rotationCurrentFingerprint
        outboundPeerReceiptRotationRejectionCode = $peerReceipt.rotationRejectionCode
        outboundPeerReceiptRotationNonce = $peerReceipt.rotationNonce
        inboundPeerReceiptReady = $inboundPeerReceiptReady
        inboundPeerReceiptAuthenticatedAt = $inboundPeerReceipt.authenticatedAt
        inboundPeerReceiptRotationKind = $inboundPeerReceipt.rotationKind
        inboundPeerReceiptRotationOperationId = $inboundPeerReceipt.rotationOperationId
        inboundPeerReceiptRotationPreviousFingerprint = $inboundPeerReceipt.rotationPreviousFingerprint
        inboundPeerReceiptRotationCurrentFingerprint = $inboundPeerReceipt.rotationCurrentFingerprint
        inboundPeerReceiptRotationRejectionCode = $inboundPeerReceipt.rotationRejectionCode
        inboundPeerReceiptRotationNonce = $inboundPeerReceipt.rotationNonce
        outboundPeerOldProofReceiptReady = [bool]$peerOldProofReceipt.ready
        outboundPeerOldProofReceiptAuthenticatedAt = $peerOldProofReceipt.authenticatedAt
        outboundPeerOldProofReceiptRotationKind = $peerOldProofReceipt.rotationKind
        outboundPeerOldProofReceiptRotationOperationId = $peerOldProofReceipt.rotationOperationId
        outboundPeerOldProofReceiptRotationPreviousFingerprint = $peerOldProofReceipt.rotationPreviousFingerprint
        outboundPeerOldProofReceiptRotationCurrentFingerprint = $peerOldProofReceipt.rotationCurrentFingerprint
        outboundPeerOldProofReceiptRotationRejectionCode = $peerOldProofReceipt.rotationRejectionCode
        outboundPeerOldProofReceiptRotationNonce = $peerOldProofReceipt.rotationNonce
        inboundPeerOldProofReceiptReady = [bool]$inboundPeerOldProofReceipt.ready
        inboundPeerOldProofReceiptAuthenticatedAt = $inboundPeerOldProofReceipt.authenticatedAt
        inboundPeerOldProofReceiptRotationKind = $inboundPeerOldProofReceipt.rotationKind
        inboundPeerOldProofReceiptRotationOperationId = $inboundPeerOldProofReceipt.rotationOperationId
        inboundPeerOldProofReceiptRotationPreviousFingerprint = $inboundPeerOldProofReceipt.rotationPreviousFingerprint
        inboundPeerOldProofReceiptRotationCurrentFingerprint = $inboundPeerOldProofReceipt.rotationCurrentFingerprint
        inboundPeerOldProofReceiptRotationRejectionCode = $inboundPeerOldProofReceipt.rotationRejectionCode
        inboundPeerOldProofReceiptRotationNonce = $inboundPeerOldProofReceipt.rotationNonce
        credentialProofRejections = [int64]$health.credentialProofRejections
        lastCredentialProofRejectionAgeSeconds = $health.lastCredentialProofRejectionAgeSeconds
        peerSessionSource = $peerSessionSource
        peerRegistryNameDigest = $peerReceipt.registryNameDigest
        peerAllowedToolNamesDigest = $peerReceipt.allowedToolNamesDigest
        peerTransportContextDigest = $peerReceipt.transportContextDigest
        protocolVersion = $health.protocolVersion
        operational = $operational
        reason = $readinessReason
        capability = 'FRA: complete secure agentic control within the ToolsEnabled policy and credential boundary; direct-Ethernet encrypted session required'
        secretValuesEmitted = $false
    }
}

function Write-State {
    param($Report)
    try {
        New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
        # Set-Content -Encoding UTF8 writes UTF-8 WITH a BOM in Windows PowerShell
        # 5.1 (only BOM-less in PowerShell 7+); every Node JSON.parse reader of
        # this file failed on the leading 0xEF 0xBB 0xBF. WriteAllText with an
        # explicit no-BOM encoding is the correct idiom, already used three
        # files away at full-remote-access-lifecycle.ps1.
        $json = $Report | ConvertTo-Json -Depth 8
        [IO.File]::WriteAllText($StateFile, $json, [Text.UTF8Encoding]::new($false))
    } catch {}
}

function Stop-OwnedListener {
    $identity = Get-ExactListener
    if ($identity.state -eq 'absent') { return [pscustomobject]@{ action = 'already_absent' } }
    if (-not $identity.owned) { return [pscustomobject]@{ action = 'blocked_conflict'; reason = $identity.reason } }
    Stop-Process -Id ([int]$identity.pid) -ErrorAction Stop
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
        if ((Get-ExactListener).state -eq 'absent') { return [pscustomobject]@{ action = 'stopped'; pid = [int]$identity.pid } }
    }
    return [pscustomobject]@{ action = 'stop_timeout'; pid = [int]$identity.pid }
}

function Invoke-FraPreflight {
    if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'NODE_MISSING' }
    if (-not (Test-Path -LiteralPath $Server -PathType Leaf)) { throw 'FULL_REMOTE_ACCESS_SERVER_MISSING' }

    # The child validates the exact manifest, credential configuration, and a
    # cold audit-admission witness. It never binds 8790/8792. Run it before any
    # stop path so a stale manifest or unavailable audit ledger cannot turn a
    # healthy listener into an avoidable outage.
    $hadHost = Test-Path Env:FULL_REMOTE_ACCESS_HOST
    $priorHost = $env:FULL_REMOTE_ACCESS_HOST
    $output = @()
    $exitCode = $null
    $timedOut = $false
    $child = $null
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    $tag = ([guid]::NewGuid().ToString('N'))
    $preflightOut = Join-Path $LogDir ('full-remote-access-preflight.' + $PID + '.' + $tag + '.stdout.tmp')
    $preflightErr = Join-Path $LogDir ('full-remote-access-preflight.' + $PID + '.' + $tag + '.stderr.tmp')
    try {
        $env:FULL_REMOTE_ACCESS_HOST = $HostName
        $child = Start-Process -FilePath $Node -ArgumentList @($Server, '--preflight') -WorkingDirectory $Root `
            -WindowStyle Hidden -RedirectStandardOutput $preflightOut -RedirectStandardError $preflightErr -PassThru
        if (-not $child.WaitForExit($PreflightTimeoutMs)) {
            $timedOut = $true
            Stop-Process -Id ([int]$child.Id) -ErrorAction SilentlyContinue
            try { $child.WaitForExit(5000) | Out-Null } catch {}
        } else {
            $child.Refresh()
            $exitCode = [int]$child.ExitCode
            if (Test-Path -LiteralPath $preflightOut -PathType Leaf) {
                $output = @(Get-Content -LiteralPath $preflightOut -ErrorAction SilentlyContinue)
            }
        }
    } finally {
        if ($child -and -not $child.HasExited) {
            Stop-Process -Id ([int]$child.Id) -ErrorAction SilentlyContinue
        }
        if ($hadHost) { $env:FULL_REMOTE_ACCESS_HOST = $priorHost }
        else { Remove-Item Env:FULL_REMOTE_ACCESS_HOST -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $preflightOut,$preflightErr -Force -ErrorAction SilentlyContinue
    }

    if ($timedOut) { throw 'FRA_PREFLIGHT_TIMEOUT' }

    $payload = $null
    try { $payload = [string]($output | Select-Object -Last 1) | ConvertFrom-Json -ErrorAction Stop } catch {}
    if ($exitCode -ne 0 -or $null -eq $payload -or $payload.ok -ne $true) {
        $code = if ($payload -and [string]$payload.code -match '^[A-Z0-9_.-]{1,80}$') { [string]$payload.code } else { 'FRA_PREFLIGHT_FAILED' }
        throw ('FRA_PREFLIGHT_FAILED_' + $code)
    }
    return [pscustomobject]@{ action = 'preflight_passed' }
}

function Start-OwnedListener {
    param([switch]$PreflightValidated)
    if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw 'NODE_MISSING' }
    if (-not (Test-Path -LiteralPath $Server -PathType Leaf)) { throw 'FULL_REMOTE_ACCESS_SERVER_MISSING' }
    if (-not (Test-Path -LiteralPath $ListenerHost -PathType Leaf)) { throw 'FULL_REMOTE_ACCESS_LISTENER_HOST_MISSING' }
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

    $mutex = New-Object System.Threading.Mutex($false, $StartMutexName)
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(5000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'FULL_REMOTE_ACCESS_START_BUSY' }
        if (-not $PreflightValidated) { Invoke-FraPreflight | Out-Null }
        $identity = Get-ExactListener
        if ($identity.state -eq 'conflict') { throw 'FULL_REMOTE_ACCESS_PORT_CONFLICT' }
        if ($identity.owned -and (Test-ServiceHealth)) { return [pscustomobject]@{ action = 'already_healthy'; pid = $identity.pid } }
        if ($identity.owned) {
            $stopped = Stop-OwnedListener
            if ($stopped.action -ne 'stopped') { throw 'FULL_REMOTE_ACCESS_RESTART_REFUSED' }
        } elseif ($identity.state -eq 'unverifiable') {
            # A listener is already bound on $Port and this privilege level
            # cannot positively identify it (the S4U/elevation observability
            # gap -- see Get-ExactListener). Falling through to Start-Process
            # here would either doom-fail against an already-bound port (if
            # this is a genuine foreign process) or silently duplicate the
            # live listener (if it is ours, just unreadable). Neither is
            # acceptable, so this MUST be proven one way or the other first,
            # via the SAME identity-match-plus-health-gates proof the status
            # projection's listenerReady field uses -- never assumed either
            # way, and never treated as 'owned' even when the proof holds.
            $readiness = Get-UnverifiableListenerReadiness -Identity $identity
            if ($readiness.ready) { return [pscustomobject]@{ action = 'already_healthy'; pid = $identity.pid } }
            throw 'FULL_REMOTE_ACCESS_LISTENER_UNVERIFIABLE'
        }
        # RedirectStandardOutput/RedirectStandardError forces Start-Process
        # onto the inheriting CreateProcess path.  The long-lived child then
        # retains the lifecycle caller's redirected pipe handles, and wrappers
        # waiting on ReadToEndAsync() see EOF only when the listener exits.
        # Launch without Start-Process redirection; the anchored listener host
        # redirects its own JavaScript streams to the same log files before it
        # loads the service module.
        $child = Start-Process -FilePath $Node -ArgumentList @($ListenerHost) -WorkingDirectory $Root -WindowStyle Hidden -PassThru
        $healthDeadline = [DateTime]::UtcNow.AddMilliseconds($StartHealthTimeoutMs)
        while ([DateTime]::UtcNow -lt $healthDeadline) {
            Start-Sleep -Milliseconds 250
            $startedIdentity = Get-ExactListener
            if ($startedIdentity.owned) {
                if (Test-ServiceHealth) {
                    Write-ControlLog ('started full remote access pid=' + $child.Id)
                    return [pscustomobject]@{ action = 'started'; pid = [int]$child.Id }
                }
                # One coherent health observation already consumed the full
                # dispatcher bound. Preserve the owned process for explicit
                # inspection instead of multiplying that bound in a loop.
                return [pscustomobject]@{ action = 'start_requested'; pid = [int]$child.Id }
            }
            if ($child.HasExited) { throw 'FULL_REMOTE_ACCESS_START_FAILED' }
        }
        return [pscustomobject]@{ action = 'start_requested'; pid = [int]$child.Id }
    } finally {
        if ($locked) { try { $mutex.ReleaseMutex() } catch {} }
        $mutex.Dispose()
    }
}

function Invoke-Start {
    param([switch]$PreflightValidated)
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    if (Test-Path -LiteralPath $StopFile) { Remove-Item -LiteralPath $StopFile -Force -ErrorAction Stop }
    if (-not $PreflightValidated) {
        try { Invoke-FraPreflight | Out-Null }
        catch {
            if ([string]$_.Exception.Message -eq 'FRA_PREFLIGHT_FAILED_FRA_TOKEN_UNAVAILABLE') {
                return Start-FraEnrollment
            }
            throw
        }
    }
    return Start-OwnedListener -PreflightValidated
}

function Invoke-Stop {
    # During enrollment, stopping 8790 changes the recovery state while 8794
    # remains bound to the pending transaction.  Refuse before touching either
    # listener; only the dedicated correlated close path may change 8794.
    $enrollmentIdentity = Get-EnrollmentListener
    if ($enrollmentIdentity.owned) { throw 'FRA_ENROLLMENT_ACTIVE_STOP_REFUSED' }
    if ($enrollmentIdentity.state -eq 'conflict') { throw 'FRA_ENROLLMENT_PORT_CONFLICT' }
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    New-Item -ItemType File -Path $StopFile -Force | Out-Null
    $result = Stop-OwnedListener
    $enrollmentResult = [pscustomobject]@{
        action = 'enrollment_absent'
        pid = $enrollmentIdentity.pid
        state = $enrollmentIdentity.state
    }
    Write-ControlLog ('stop requested action=' + $result.action)
    return [ordered]@{ listener = $result; enrollment = $enrollmentResult }
}

function Invoke-Reconcile {
    if (Test-Path -LiteralPath $StopFile) { return [pscustomobject]@{ action = 'disabled' } }
    $status = Get-StatusReport
    if ($status.operational) { return [pscustomobject]@{ action = 'healthy' } }
    return Start-OwnedListener
}

function Invoke-Restart {
    try { Invoke-FraPreflight | Out-Null }
    catch {
        if ([string]$_.Exception.Message -eq 'FRA_PREFLIGHT_FAILED_FRA_TOKEN_UNAVAILABLE') {
            return Start-FraEnrollment
        }
        throw
    }
    return [ordered]@{ stop = Invoke-Stop; start = Invoke-Start -PreflightValidated }
}

try {
    # Resolve fallible host/runtime prerequisites inside the projection-aware
    # boundary. Status remains observational, while lifecycle failures retain
    # a bounded state projection for recovery and diagnosis.
    $Node = Resolve-ApprovedNode
    $Topology = Resolve-DirectLinkHost
    $HostName = [string]$Topology.localMachine.address
    $PeerHost = [string]$Topology.peerMachine.address
    $DirectionalTopology = Resolve-ServiceRegistryDirectionalTopology -Root $Root -ConfiguredAddress $HostName
    $MachineBAddress = [string]$DirectionalTopology.recipientMachine.address
    if ($Action -eq 'CloseEnrollment') {
        if ($HostName -cne $MachineBAddress -or $OperationId -notmatch '^[A-Za-z0-9_-]{22}$' -or $Fingerprint -notmatch '^[A-Za-z0-9_-]{43}$') {
            throw 'FRA_ENROLLMENT_CLOSE_CORRELATION_INVALID'
        }
    } elseif (-not [string]::IsNullOrWhiteSpace($OperationId) -or -not [string]::IsNullOrWhiteSpace($Fingerprint)) {
        throw 'FRA_CONTROL_ARGUMENT_INVALID'
    }
    if ($Action -eq 'EnrollmentStatus') {
        $identity = Get-EnrollmentListener
        $firewall = Get-EnrollmentFirewallReadiness
        [ordered]@{
            schemaVersion = 'full-remote-access-enrollment-status.v1'
            action = $Action
            host = $HostName
            peer = $PeerHost
            enrollmentPort = $EnrollmentPort
            enrollmentState = $identity.state
            enrollmentPid = $identity.pid
            enrollmentReady = [bool]($identity.owned -and $firewall.ready)
            enrollmentFirewallReady = [bool]$firewall.ready
            enrollmentFirewallReason = $firewall.reason
            secretValuesEmitted = $false
        } | ConvertTo-Json -Depth 4 -Compress
        return
    }
    $operation = switch ($Action) {
        'Status' { $null }
        'CloseEnrollment' { Close-FraEnrollment }
        'Start' { Invoke-Start }
        'Stop' { Invoke-Stop }
        'Restart' { Invoke-Restart }
        'Reconcile' { Invoke-Reconcile }
    }
    $result = Get-StatusReport
    if ($null -ne $operation) { $result.operation = $operation }
    if ($PersistProjection) { Write-State $result }
    $result | ConvertTo-Json -Depth 12 -Compress
} catch {
    $result = [ordered]@{
        schemaVersion = 'full-remote-access-control.v2'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        action = $Action
        host = $HostName
        port = $Port
        operational = $false
        error = 'control_failed'
        errorCode = if ($_.Exception.Message) { $_.Exception.Message -replace '[^A-Za-z0-9_.-]', '_' } else { 'unknown' }
        secretValuesEmitted = $false
    }
    if ($PersistProjection) { Write-State $result }
    $result | ConvertTo-Json -Depth 8 -Compress
    exit 1
}
