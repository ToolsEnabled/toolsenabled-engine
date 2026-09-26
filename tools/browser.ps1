param(
    [Parameter(Mandatory = $true)][ValidateSet('start-owned', 'inspect-owned', 'open-owned', 'stop-owned', 'recover-owned-launch', 'process-start-key', 'status')][string]$Action,
    [string]$Arg1
)
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

# This helper is deliberately narrow.  It never discovers or adopts an existing
# Chrome process.  A process is owned only when this helper started it with an
# unpredictable nonce and it still matches the durable identity supplied by the
# Node owner module.

function Write-Json([object]$Value) {
    [Console]::Out.Write(($Value | ConvertTo-Json -Compress -Depth 8))
}

function Read-Payload {
    if ([string]::IsNullOrWhiteSpace($Arg1) -or -not (Test-Path -LiteralPath $Arg1 -PathType Leaf)) {
        throw 'owned-browser payload is required.'
    }
    return (Get-Content -LiteralPath $Arg1 -Raw | ConvertFrom-Json)
}

function Get-CanonicalDirectory([string]$Value, [bool]$Create) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'browser profile is required.' }
    $full = [IO.Path]::GetFullPath($Value)
    if ($Create) { [IO.Directory]::CreateDirectory($full) | Out-Null }
    if (-not (Test-Path -LiteralPath $full -PathType Container)) { throw 'browser profile is missing.' }
    return [IO.Path]::GetFullPath($full).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Get-CanonicalFile([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'browser executable is required.' }
    $full = [IO.Path]::GetFullPath($Value)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw 'browser executable is missing.' }
    return $full
}

function Find-Browser {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    if (-not $candidates) { return $null }
    return (Get-CanonicalFile ([string]($candidates | Select-Object -First 1)))
}

function Test-Token([string]$Value) { return $Value -match '^[A-Za-z0-9_-]{43}$' }
function Test-ProcessId([object]$Value) { return ([string]$Value -match '^[1-9][0-9]{0,9}$' -and [UInt64]$Value -le [UInt64][UInt32]::MaxValue) }
function Test-StartKey([string]$Value) { return $Value -match '^[0-9]{1,19}$' }
function Test-Port([object]$Value) { return ([string]$Value -match '^[1-9][0-9]{0,4}$' -and [int]$Value -ge 1024 -and [int]$Value -le 65535) }

function Get-ProcessProbe([int]$ProcessId) {
    try {
        $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    } catch {
        return [pscustomobject]@{ status = 'uncertain'; facts = $null }
    }
    if ($null -eq $process) {
        return [pscustomobject]@{ status = 'absent'; facts = $null }
    }
    if ([string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) {
        return [pscustomobject]@{ status = 'uncertain'; facts = $null }
    }
    try {
        $managed = [Diagnostics.Process]::GetProcessById($ProcessId)
        try {
            $startKey = $managed.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
        } finally { $managed.Dispose() }
        $facts = [pscustomobject]@{
            processId = [int]$ProcessId; processStartKey = $startKey;
            executable = Get-CanonicalFile ([string]$process.ExecutablePath);
            commandLine = [string]$process.CommandLine; parentProcessId = [int]$process.ParentProcessId
        }
        return [pscustomobject]@{ status = 'present'; facts = $facts }
    } catch [ArgumentException] {
        return [pscustomobject]@{ status = 'absent'; facts = $null }
    } catch {
        return [pscustomobject]@{ status = 'uncertain'; facts = $null }
    }
}

function Get-ProcessFacts([int]$ProcessId) {
    $probe = Get-ProcessProbe $ProcessId
    if ($probe.status -eq 'present') { return $probe.facts }
    return $null
}

function Test-ExactArgument([string]$CommandLine, [string]$Argument) {
    if ([string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($Argument)) { return $false }
    $boundaryPrefix = '(?i)(?:^|[\s\"])'
    $boundarySuffix = '(?=$|[\s\"])'
    $pattern = $boundaryPrefix + [regex]::Escape($Argument) + $boundarySuffix
    if ([regex]::IsMatch($CommandLine, $pattern)) { return $true }

    # Start-Process may quote only the value of an argument whose value has
    # spaces, yielding --user-data-dir="C:\..." rather than quoting the whole
    # argument.  Accept that equivalent Windows command-line spelling while
    # keeping the prefix and value exact; a wrong nonce/generation still fails.
    $equals = $Argument.IndexOf('=')
    if ($equals -le 0 -or $equals -ge ($Argument.Length - 1)) { return $false }
    $prefix = $Argument.Substring(0, $equals + 1)
    $value = $Argument.Substring($equals + 1)
    $quotedValuePattern = $boundaryPrefix + [regex]::Escape($prefix) + '"' + [regex]::Escape($value) + '"' + $boundarySuffix
    return [regex]::IsMatch($CommandLine, $quotedValuePattern)
}

function Test-ProfileProcessInUse([string]$Profile) {
    # Chrome's lock is advisory, but treating either it or an exact live command
    # line as busy is intentionally conservative.  We never remove Singleton*
    # files or signal the other process to make progress.
    try {
        $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
            $_.Name -in @('chrome.exe', 'msedge.exe') -and (Test-ExactArgument ([string]$_.CommandLine) "--user-data-dir=$Profile")
        })
        return $processes.Count -gt 0
    } catch { return $true }
}

function Test-ProfileInUse([string]$Profile) {
    # A leftover lock is treated as in-use too: that can be stale after a crash,
    # but failing closed is preferable to opening the profile concurrently.
    return (Test-Path -LiteralPath (Join-Path $Profile 'SingletonLock')) -or (Test-ProfileProcessInUse $Profile)
}

function Get-LoopbackEndpointProbe([int]$Port) {
    try {
        # Get-NetTCPConnection raises a terminating "no matching objects" error
        # for an unused -LocalPort, which is a known-empty result rather than
        # probe uncertainty. Query the listener table once and filter locally so
        # only a genuine table-query failure becomes `uncertain`.
        $connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { [int]$_.LocalPort -eq $Port })
        return [pscustomobject]@{ status = 'known'; connections = @($connections) }
    } catch {
        return [pscustomobject]@{ status = 'uncertain'; connections = @() }
    }
}

function Add-RestartManagerInterop {
    if ('ToolsEnabledRestartManager' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ToolsEnabledRestartManager {
    [StructLayout(LayoutKind.Sequential)]
    public struct NativeFileTime {
        public UInt32 Low;
        public UInt32 High;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct UniqueProcess {
        public UInt32 ProcessId;
        public NativeFileTime ProcessStartTime;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern Int32 RmStartSession(out UInt32 sessionHandle, Int32 sessionFlags, StringBuilder sessionKey);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern Int32 RmRegisterResources(
        UInt32 sessionHandle,
        UInt32 fileCount,
        String[] fileNames,
        UInt32 applicationCount,
        [In] UniqueProcess[] applications,
        UInt32 serviceCount,
        String[] serviceNames);

    [DllImport("rstrtmgr.dll")]
    private static extern Int32 RmShutdown(UInt32 sessionHandle, UInt32 actionFlags, IntPtr statusCallback);

    [DllImport("rstrtmgr.dll")]
    private static extern Int32 RmEndSession(UInt32 sessionHandle);

    public static Int32 ShutdownExactProcess(UInt32 processId, Int64 processStartTime) {
        UInt32 sessionHandle;
        var key = new StringBuilder(32);
        Int32 result = RmStartSession(out sessionHandle, 0, key);
        if (result != 0) return result;
        try {
            var application = new UniqueProcess {
                ProcessId = processId,
                ProcessStartTime = new NativeFileTime {
                    Low = unchecked((UInt32)processStartTime),
                    High = unchecked((UInt32)((UInt64)processStartTime >> 32))
                }
            };
            result = RmRegisterResources(sessionHandle, 0, null, 1, new[] { application }, 0, null);
            if (result != 0) return result;
            // Zero deliberately omits RmForceShutdown. An unresponsive process is
            // never force-terminated by this helper.
            return RmShutdown(sessionHandle, 0, IntPtr.Zero);
        } finally {
            RmEndSession(sessionHandle);
        }
    }
}
'@
}

function Get-DescendantProcessProbe([int]$ChildProcessId, [int]$AncestorProcessId) {
    if ($ChildProcessId -eq $AncestorProcessId) {
        return [pscustomobject]@{ status = 'known'; isDescendant = $true }
    }
    $current = $ChildProcessId
    for ($depth = 0; $depth -lt 32; $depth++) {
        try { $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $current" -ErrorAction Stop }
        catch { return [pscustomobject]@{ status = 'uncertain'; isDescendant = $false } }
        if ($null -eq $process -or [int]$process.ParentProcessId -le 0) {
            return [pscustomobject]@{ status = 'known'; isDescendant = $false }
        }
        $current = [int]$process.ParentProcessId
        if ($current -eq $AncestorProcessId) {
            return [pscustomobject]@{ status = 'known'; isDescendant = $true }
        }
    }
    return [pscustomobject]@{ status = 'known'; isDescendant = $false }
}

function Test-OwnedRecord([object]$Record) {
    if ($null -eq $Record -or [int]$Record.version -ne 1 -or -not (Test-ProcessId $Record.processId) -or
        -not (Test-StartKey ([string]$Record.processStartKey)) -or -not (Test-Token ([string]$Record.nonce)) -or
        -not (Test-Token ([string]$Record.generation)) -or -not (Test-Port $Record.cdpPort)) {
        return [pscustomobject]@{ status = 'invalid'; code = 'RECORD_INVALID' }
    }
    try {
        $expectedExecutable = Get-CanonicalFile ([string]$Record.executable)
        $expectedProfile = Get-CanonicalDirectory ([string]$Record.profile) $false
    } catch { return [pscustomobject]@{ status = 'invalid'; code = 'PATH_INVALID' } }
    $processProbe = Get-ProcessProbe ([int]$Record.processId)
    if ($processProbe.status -eq 'absent') { return [pscustomobject]@{ status = 'invalid'; code = 'PROCESS_ABSENT' } }
    if ($processProbe.status -ne 'present') { return [pscustomobject]@{ status = 'invalid'; code = 'PROCESS_PROBE_UNCERTAIN' } }
    $facts = $processProbe.facts
    if ($facts.processStartKey -ne [string]$Record.processStartKey) { return [pscustomobject]@{ status = 'invalid'; code = 'PROCESS_START_KEY_MISMATCH' } }
    if ($facts.executable -ine $expectedExecutable) { return [pscustomobject]@{ status = 'invalid'; code = 'EXECUTABLE_MISMATCH' } }
    if (-not (Test-ExactArgument $facts.commandLine "--user-data-dir=$expectedProfile")) { return [pscustomobject]@{ status = 'invalid'; code = 'PROFILE_MISMATCH' } }
    if (-not (Test-ExactArgument $facts.commandLine "--toolsenabled-owner=$([string]$Record.nonce)")) { return [pscustomobject]@{ status = 'invalid'; code = 'NONCE_MISMATCH' } }
    if (-not (Test-ExactArgument $facts.commandLine "--toolsenabled-generation=$([string]$Record.generation)")) { return [pscustomobject]@{ status = 'invalid'; code = 'GENERATION_MISMATCH' } }
    if (-not (Test-ExactArgument $facts.commandLine "--remote-debugging-port=$([int]$Record.cdpPort)")) { return [pscustomobject]@{ status = 'invalid'; code = 'CDP_PORT_MISMATCH' } }
    if (-not (Test-ExactArgument $facts.commandLine '--remote-debugging-address=127.0.0.1')) { return [pscustomobject]@{ status = 'invalid'; code = 'CDP_ADDRESS_MISMATCH' } }
    $listenerProbe = Get-LoopbackEndpointProbe ([int]$Record.cdpPort)
    if ($listenerProbe.status -ne 'known') {
        return [pscustomobject]@{ status = 'invalid'; code = 'CDP_LISTENER_UNCERTAIN' }
    }
    $listeners = @($listenerProbe.connections)
    if ($null -eq $listeners -or $listeners.Count -ne 1 -or
        [string]$listeners[0].LocalAddress -ne '127.0.0.1') {
        $listenerSummary = @($listeners | ForEach-Object { "$(($_.LocalAddress)):$(($_.LocalPort))/pid$(($_.OwningProcess))" }) -join ','
        return [pscustomobject]@{ status = 'invalid'; code = 'CDP_LISTENER_MISMATCH'; listenerSummary = $listenerSummary }
    }
    $cdpProcessId = [int]$listeners[0].OwningProcess
    $cdpProbe = Get-ProcessProbe $cdpProcessId
    if ($cdpProbe.status -ne 'present') {
        return [pscustomobject]@{ status = 'invalid'; code = $(if ($cdpProbe.status -eq 'absent') { 'CDP_OWNER_ABSENT' } else { 'CDP_OWNER_UNCERTAIN' }) }
    }
    $cdpFacts = $cdpProbe.facts
    $ancestryProbe = Get-DescendantProcessProbe $cdpProcessId ([int]$Record.processId)
    if ($ancestryProbe.status -ne 'known') {
        return [pscustomobject]@{ status = 'invalid'; code = 'CDP_OWNER_UNCERTAIN' }
    }
    if ($cdpFacts.executable -ine $expectedExecutable -or -not $ancestryProbe.isDescendant -or
        ($null -ne $Record.cdpProcessId -and [int]$Record.cdpProcessId -ne $cdpProcessId) -or
        ($null -ne $Record.cdpProcessStartKey -and [string]$Record.cdpProcessStartKey -ne $cdpFacts.processStartKey)) {
        return [pscustomobject]@{ status = 'invalid'; code = 'CDP_OWNER_MISMATCH' }
    }
    try {
        $client = New-Object Net.WebClient
        $client.Proxy = $null
        $client.Encoding = [Text.Encoding]::UTF8
        $version = $client.DownloadString("http://127.0.0.1:$([int]$Record.cdpPort)/json/version") | ConvertFrom-Json
        $endpoint = [Uri]([string]$version.webSocketDebuggerUrl)
        if ($endpoint.Scheme -ne 'ws' -or $endpoint.Host -ne '127.0.0.1' -or $endpoint.Port -ne [int]$Record.cdpPort) {
            return [pscustomobject]@{ status = 'invalid'; code = 'CDP_ENDPOINT_MISMATCH' }
        }
    } catch { return [pscustomobject]@{ status = 'invalid'; code = 'CDP_ENDPOINT_UNAVAILABLE' } }
    return [pscustomobject]@{
        status = 'valid'; processId = [int]$Record.processId; processStartKey = [string]$Record.processStartKey;
        executable = $expectedExecutable; profile = $expectedProfile; cdpPort = [int]$Record.cdpPort;
        endpoint = "http://127.0.0.1:$([int]$Record.cdpPort)"; cdpProcessId = $cdpProcessId; cdpProcessStartKey = $cdpFacts.processStartKey
    }
}

function Close-ExactLaunch([object]$Record) {
    # Restart Manager accepts RM_UNIQUE_PROCESS (PID + creation FILETIME) as one
    # identity. That closes the validation-to-signal PID-reuse gap inherent in
    # GetProcessById(...).CloseMainWindow(). No native window message or force
    # termination is used here.
    try {
        $expectedExecutable = Get-CanonicalFile ([string]$Record.executable)
        $expectedProfile = Get-CanonicalDirectory ([string]$Record.profile) $false
        $processProbe = Get-ProcessProbe ([int]$Record.processId)
        if ($processProbe.status -eq 'absent') { return [pscustomobject]@{ status = 'closed' } }
        if ($processProbe.status -ne 'present') { return [pscustomobject]@{ status = 'identity_uncertain' } }
        $facts = $processProbe.facts
        if ($facts.processStartKey -ne [string]$Record.processStartKey -or $facts.executable -ine $expectedExecutable -or
            -not (Test-ExactArgument $facts.commandLine "--user-data-dir=$expectedProfile") -or
            -not (Test-ExactArgument $facts.commandLine "--toolsenabled-owner=$([string]$Record.nonce)") -or
            -not (Test-ExactArgument $facts.commandLine "--toolsenabled-generation=$([string]$Record.generation)") -or
            -not (Test-ExactArgument $facts.commandLine "--remote-debugging-port=$([int]$Record.cdpPort)") -or
            -not (Test-ExactArgument $facts.commandLine '--remote-debugging-address=127.0.0.1')) {
            return [pscustomobject]@{ status = 'identity_uncertain' }
        }
        Add-RestartManagerInterop
        $result = [ToolsEnabledRestartManager]::ShutdownExactProcess([UInt32]$Record.processId, [Int64]$Record.processStartKey)
        if ($result -ne 0) {
            return [pscustomobject]@{ status = 'close_refused'; restartManagerCode = [int]$result }
        }
        $deadline = [DateTime]::UtcNow.AddSeconds(8)
        do {
            $after = Get-ProcessProbe ([int]$Record.processId)
            if ($after.status -eq 'absent' -or
                ($after.status -eq 'present' -and $after.facts.processStartKey -ne [string]$Record.processStartKey)) {
                return [pscustomobject]@{ status = 'closed' }
            }
            if ($after.status -ne 'present') { return [pscustomobject]@{ status = 'identity_uncertain' } }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $deadline)
        return [pscustomobject]@{ status = 'close_requested' }
    } catch { return [pscustomobject]@{ status = 'identity_uncertain' } }
}

function Get-FreshOwnedLaunchCandidates([object]$Payload, [string]$Profile) {
    try {
        $matches = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
            $_.Name -in @('chrome.exe', 'msedge.exe') -and
            (Test-ExactArgument ([string]$_.CommandLine) "--user-data-dir=$Profile") -and
            (Test-ExactArgument ([string]$_.CommandLine) "--toolsenabled-owner=$([string]$Payload.nonce)") -and
            (Test-ExactArgument ([string]$_.CommandLine) "--toolsenabled-generation=$([string]$Payload.generation)") -and
            (Test-ExactArgument ([string]$_.CommandLine) "--remote-debugging-port=$([int]$Payload.cdpPort)") -and
            (Test-ExactArgument ([string]$_.CommandLine) '--remote-debugging-address=127.0.0.1')
        })
    } catch {
        return [pscustomobject]@{ status = 'uncertain'; candidates = @() }
    }
    $candidates = New-Object System.Collections.Generic.List[object]
    foreach ($match in $matches) {
        $probe = Get-ProcessProbe ([int]$match.ProcessId)
        if ($probe.status -eq 'uncertain') {
            return [pscustomobject]@{ status = 'uncertain'; candidates = @() }
        }
        if ($probe.status -eq 'present') { $candidates.Add($probe.facts) }
    }
    # PowerShell 5.1 can throw "Argument types do not match" when a generic
    # List[object] is wrapped directly in @(), especially when it is empty.
    $candidateArray = @($candidates | ForEach-Object { $_ })
    return [pscustomobject]@{ status = 'known'; candidates = $candidateArray }
}

# WHERE THE RUNNING PRODUCT WRITES. The owned browser profile resolved from $PSScriptRoot is the
# INSTALL directory once packaged, which the next update deletes and a
# per-machine install makes unwritable. src/lib/runtime-state-root.js decides
# this once and src/lib/runtime.js publishes it; the <repo> fallback is for a
# source checkout. Same shape as tools/secrets.ps1 and tools/desktop.ps1.
function Get-ToolsEnabledRuntimeRoot {
    $configured = [Environment]::GetEnvironmentVariable('TOOLSENABLED_STATE_ROOT')
    if (-not [string]::IsNullOrWhiteSpace($configured)) {
        return [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($configured))
    }
    return [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
}

function Get-FreeLoopbackPort {
    $listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    } finally { $listener.Stop() }
}

switch ($Action) {
    'status' {
        $profile = if ([string]::IsNullOrWhiteSpace($env:TOOLSENABLED_BROWSER_PROFILE_PATH)) {
            Join-Path (Get-ToolsEnabledRuntimeRoot) 'profiles\chrome'
        } else { [IO.Path]::GetFullPath($env:TOOLSENABLED_BROWSER_PROFILE_PATH) }
        $profileExists = Test-Path -LiteralPath $profile -PathType Container
        $canonical = if ($profileExists) { Get-CanonicalDirectory $profile $false } else { [IO.Path]::GetFullPath($profile) }
        $lockPresent = $profileExists -and (Test-Path -LiteralPath (Join-Path $canonical 'SingletonLock'))
        $processInUse = $profileExists -and (Test-ProfileProcessInUse $canonical)
        Write-Json @{ browser = Find-Browser; profile = $canonical; profileExists = [bool]$profileExists; profileInUse = [bool]($lockPresent -or $processInUse); profileLockPresent = [bool]$lockPresent }
        break
    }
    'process-start-key' {
        $payload = Read-Payload
        if (-not (Test-ProcessId $payload.processId)) { throw 'process identity is invalid.' }
        try {
            $process = [Diagnostics.Process]::GetProcessById([int]$payload.processId)
            try {
                $startKey = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)
                Write-Json @{ status = 'present'; processStartKey = $startKey }
            } finally { $process.Dispose() }
        } catch [ArgumentException] { Write-Json @{ status = 'absent' } }
        catch { Write-Json @{ status = 'uncertain' } }
        break
    }
    'inspect-owned' {
        Write-Json (Test-OwnedRecord (Read-Payload))
        break
    }
    'start-owned' {
        $payload = Read-Payload
        if (-not (Test-Token ([string]$payload.nonce)) -or -not (Test-Token ([string]$payload.generation))) { throw 'owned-browser launch nonce is invalid.' }
        $url = [Uri]([string]$payload.url)
        if ($url.Scheme -ne 'https') { throw 'owned-browser launch requires HTTPS.' }
        if (-not (Test-Port $payload.cdpPort)) { throw 'owned-browser CDP port is invalid.' }
        $browser = Find-Browser
        if ($null -eq $browser) { throw 'Chrome or Edge was not found.' }
        $profile = Get-CanonicalDirectory ([string]$payload.profile) $true
        if (Test-ProfileInUse $profile) {
            throw 'BROWSER_PROFILE_IN_USE: the dedicated profile is already active or locked; no existing browser was changed.'
        }
        $port = [int]$payload.cdpPort
        $portProbe = Get-LoopbackEndpointProbe $port
        if ($portProbe.status -ne 'known') { throw 'BROWSER_CDP_PORT_UNCERTAIN: the selected loopback CDP port could not be inspected; no browser was launched.' }
        if (@($portProbe.connections).Count -ne 0) { throw 'BROWSER_CDP_PORT_IN_USE: the selected owned-browser CDP port is already in use.' }
        # Restores the three anti-throttling flags Playwright sets by default.
        #
        # WHAT IS ESTABLISHED: Playwright passes these whenever IT launches the
        # browser. Here ToolsEnabled launches Chrome itself and Playwright only
        # attaches over CDP afterwards, so those defaults never applied and no
        # code path ever set them -- a repo-wide search found zero occurrences of
        # all three. Automation running against a browser without them is a real
        # gap independent of any particular bug, which is why this is worth
        # closing on its own merits.
        #
        # WHAT IS NOT ESTABLISHED: this is NOT confirmed to be the cause of the
        # click timeouts seen on 2026-08-09, where fill() succeeded while every
        # click timed out at 20s across three unrelated stacks. Chrome throttles
        # non-foreground renderers, requestAnimationFrame stops arriving, and
        # Playwright's click() waits for a bounding box unchanged across two
        # animation frames while fill() skips that check -- so throttling FITS
        # the symptom. But the one test run against it was inconclusive by
        # construction: foreground state was never sampled during the 20s
        # polling window, so the result is equally consistent with throttling
        # and with an unrelated cause. A rAF probe would settle it; the reviewed
        # gateway exposes no evaluate tool, so it could not be run.
        #
        # Do not cite this comment as the fix for that defect unless a later
        # measurement actually confirms it.
        #
        # Focus-based workarounds are dead regardless: a window_focus call was
        # reclaimed by the automating host almost immediately, so foreground
        # state cannot be held from outside. These flags at least remove the
        # dependency on it.
        #
        # Safe for the ownership check: Test-ExactArgument is a bounded regex
        # presence test for specific expected arguments, and nothing asserts an
        # exhaustive or count-based argument set, so extra flags cannot make a
        # genuinely owned browser fail verification.
        # A profile path containing a space must reach the browser as ONE
        # argument. Start-Process -ArgumentList joins the array with plain
        # spaces and does not quote an element whose value contains one, so the
        # value is quoted here, by hand, before the array is built.
        #
        # MEASURED, by running the real start -> status -> stop walk twice
        # against a scratch profile directory whose path contains a space:
        #
        #   WITHOUT the quotes, the browser created a profile directory
        #   truncated at the first space. The scratch root ended up holding
        #   BOTH "a folder with spaces" (the directory that was asked for) and
        #   "a" (the one the browser actually made). start() failed with
        #   BROWSER_OWNER_ORPHAN_UNCERTAIN, retained its pending record, and
        #   left ten live browser processes behind. Those surviving processes
        #   carried --user-data-dir="<scratch root>\a", which does not contain
        #   the requested profile path, so the exact-match probe below cannot
        #   match them.
        #
        #   WITH the quotes, the same walk completed: the launched process's
        #   own command line carried the whole path, start returned owned,
        #   status agreed, and stop closed it gracefully and unforced.
        #
        # WHICH HALF OF T325's CLAIM WAS ACTUALLY REPRODUCED, precisely:
        #   ORPHAN_UNCERTAIN -- YES. The failing walk surfaced
        #   BROWSER_OWNER_ORPHAN_UNCERTAIN and retained its pending record.
        #   FRESH_PROCESS_NOT_FOUND -- NOT OBSERVED. It is set as $verified.code
        #   above and then reported only as the `reason` field inside an
        #   orphan_uncertain result, and the walk did not capture that field. So
        #   this file does not claim it was the code in play; it was not looked
        #   at. That is a different answer from "it does not happen".
        #
        # Also NOT established: exactly which process the probe examines in the
        # failing case. The initial launch's command line still contains the
        # full unquoted path, so more than one process is in play, and this was
        # not instrumented to tell them apart. Do not read the paragraph above
        # as having settled that.
        #
        # Test-ExactArgument above already accepts the quoted spelling (its
        # "Start-Process may quote only the value" branch); only the launch
        # side was never producing it.
        $arguments = @(
            "--user-data-dir=`"$profile`"", "--remote-debugging-port=$port", '--remote-debugging-address=127.0.0.1',
            "--toolsenabled-owner=$([string]$payload.nonce)", "--toolsenabled-generation=$([string]$payload.generation)",
            '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--no-first-run', '--no-default-browser-check', $url.AbsoluteUri
        )
        $started = Start-Process -FilePath $browser -ArgumentList $arguments -PassThru
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        $record = $null; $verified = [pscustomobject]@{ status = 'invalid'; code = 'FRESH_PROCESS_NOT_FOUND' }
        do {
            $candidateProbe = Get-FreshOwnedLaunchCandidates $payload $profile
            $candidates = @($candidateProbe.candidates)
            if ($candidateProbe.status -ne 'known') {
                $verified = [pscustomobject]@{ status = 'invalid'; code = 'FRESH_PROCESS_PROBE_UNCERTAIN' }
            } elseif ($candidates.Count -eq 1) {
                $facts = $candidates[0]
                $record = [pscustomobject]@{
                    version = 1; executable = $facts.executable; profile = $profile; processId = $facts.processId;
                    processStartKey = $facts.processStartKey; nonce = [string]$payload.nonce; generation = [string]$payload.generation; cdpPort = [int]$port
                }
                $verified = Test-OwnedRecord $record
                if ($verified.status -eq 'valid') {
                    Write-Json @{ executable = $verified.executable; profile = $verified.profile; processId = $verified.processId; processStartKey = $verified.processStartKey; cdpPort = $verified.cdpPort; cdpProcessId = $verified.cdpProcessId; cdpProcessStartKey = $verified.cdpProcessStartKey }
                    break
                }
            } elseif ($candidates.Count -gt 1) {
                $verified = [pscustomobject]@{ status = 'invalid'; code = 'FRESH_PROCESS_AMBIGUOUS' }
            } else {
                $verified = [pscustomobject]@{ status = 'invalid'; code = 'FRESH_PROCESS_NOT_FOUND' }
            }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $deadline)
        if ($verified.status -ne 'valid') {
            if ($null -ne $record) {
                $contained = Close-ExactLaunch $record
                if ($contained.status -eq 'closed') {
                    throw "BROWSER_OWNER_START_CONTAINED_$($verified.code) [$($verified.listenerSummary)]: the just-launched owned browser did not become ready and was gracefully closed."
                }
                if ($contained.status -eq 'orphan_uncertain') {
                    Write-Json @{ status = 'orphan_uncertain'; executable = $record.executable; profile = $profile; processId = $record.processId; processStartKey = $record.processStartKey; cdpPort = $port }
                    break
                }
            }
            Write-Json @{ status = 'orphan_uncertain'; reason = [string]$verified.code }
        }
        break
    }
    'recover-owned-launch' {
        # Recovery is allowed to locate only a process carrying the exact fresh
        # nonce + generation reserved by this ToolsEnabled invocation.  It never
        # treats a profile, PID, title, or ordinary Chrome command line as proof
        # of ownership.
        $payload = Read-Payload
        if (-not (Test-Token ([string]$payload.nonce)) -or -not (Test-Token ([string]$payload.generation)) -or -not (Test-Port $payload.cdpPort)) {
            throw 'pending owned-browser launch record is invalid.'
        }
        $profile = Get-CanonicalDirectory ([string]$payload.profile) $false
        $candidateProbe = Get-FreshOwnedLaunchCandidates $payload $profile
        if ($candidateProbe.status -ne 'known') { Write-Json @{ status = 'orphan_uncertain'; reason = 'PROCESS_PROBE_UNCERTAIN' }; break }
        $matches = @($candidateProbe.candidates)
        if ($matches.Count -eq 0) { Write-Json @{ status = 'absent' }; break }
        if ($matches.Count -ne 1) { Write-Json @{ status = 'orphan_uncertain' }; break }
        $facts = $matches[0]
        $record = [pscustomobject]@{
            version = 1; executable = $facts.executable; profile = $profile; processId = $facts.processId;
            processStartKey = $facts.processStartKey; nonce = [string]$payload.nonce; generation = [string]$payload.generation; cdpPort = [int]$payload.cdpPort
        }
        $verified = Test-OwnedRecord $record
        if ($verified.status -eq 'valid') {
            Write-Json @{ status = 'active'; executable = $verified.executable; processId = $verified.processId; processStartKey = $verified.processStartKey; cdpProcessId = $verified.cdpProcessId; cdpProcessStartKey = $verified.cdpProcessStartKey }
            break
        }
        if ([string]$verified.code -in @('PROCESS_PROBE_UNCERTAIN', 'CDP_LISTENER_UNCERTAIN', 'CDP_OWNER_UNCERTAIN')) {
            # A transient/permission failure is not proof of absence. Retain the
            # pending nonce/generation fence and never signal even the exact root
            # process until ownership can be revalidated without uncertainty.
            Write-Json @{ status = 'orphan_uncertain'; reason = [string]$verified.code }
            break
        }
        $contained = Close-ExactLaunch $record
        if ($contained.status -eq 'closed') { Write-Json @{ status = 'absent' } }
        else { Write-Json @{ status = 'orphan_uncertain'; executable = $facts.executable; processId = $facts.processId; processStartKey = $facts.processStartKey } }
        break
    }
    'open-owned' {
        $payload = Read-Payload
        $verified = Test-OwnedRecord $payload
        if ($verified.status -ne 'valid') { Write-Json $verified; break }
        $url = [Uri]([string]$payload.url)
        if ($url.Scheme -ne 'https') { throw 'owned-browser navigation requires HTTPS.' }
        try {
            $request = [Net.WebRequest]::Create("$($verified.endpoint)/json/new?$([Uri]::EscapeDataString($url.AbsoluteUri))")
            $request.Method = 'PUT'; $request.Timeout = 5000; $request.Proxy = $null
            $response = $request.GetResponse()
            try { $null = $response.GetResponseStream() } finally { $response.Close() }
            Write-Json @{ status = 'opened' }
        } catch { Write-Json @{ status = 'open_failed' } }
        break
    }
    'stop-owned' {
        $payload = Read-Payload
        $verified = Test-OwnedRecord $payload
        if ($verified.status -ne 'valid') { Write-Json $verified; break }
        Write-Json (Close-ExactLaunch $payload)
        break
    }
}
