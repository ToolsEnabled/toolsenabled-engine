#requires -Version 5.1
<#
    ELEVATED, REFUSE-BY-DEFAULT reap of an orphaned ToolsEnabled loopback
    listener.

    WHY THIS NEEDS ELEVATION AT ALL (measured 2026-07-28). The dashboard's
    scheduled task ran S4U and, on this machine, produced a FULL unfiltered
    administrator token. A process started that way has a default DACL granting
    BUILTIN\Administrators and SYSTEM -- and the owner's own interactive session
    carries Administrators as "deny only". So the non-elevated session was
    denied even PROCESS_QUERY_LIMITED_INFORMATION on the orphan: Stop-Process
    failed silently, taskkill /F /T reported access denied, and there is no
    non-elevated route (no SeDebugPrivilege in the filtered token, no console to
    attach for CTRL_BREAK, no in-band shutdown route on the server, and the
    socket is a raw bind with no http.sys urlacl to release).

    WHY IT IS SAFE TO DELEGATE. The caller cannot influence what gets killed.
    config\uac-delegation-allowlist.json passes NO caller-supplied arguments:
    the port is a literal there and a [ValidateSet] here, and the target is
    DISCOVERED and verified inside this elevated script. Every one of the
    following must hold or nothing is killed:
      - exactly ONE listener on the port (0 -> nothing to do, >1 -> refuse),
      - it is bound to loopback (127.0.0.1 or ::1), never 0.0.0.0,
      - the owning process is node.exe,
      - its command line is READABLE and names the one entry point fixed for the
        literal port (AgentActivityVisualizer\server\index.js for 3889,
        sidecars\local-coder\bin\server.js for 3888, or
        tools\mission-bridge.js for the bounded 4610-4619 range). An unreadable
        command line is a REFUSAL: being unable to identify the holder is exactly
        when a blind kill is most dangerous, and the refusal itself is the diagnosis,
      - it is not this process, its parent, or the other declared listener.
    The authority granted is therefore "terminate at most one process that is
    provably the requested component's own loopback listener." It starts nothing,
    installs nothing, and touches no ACL, service, policy, or UAC setting. It is
    strictly narrower than the register-*-task operations already allowlisted,
    which can create scheduled tasks elevated.

    Every decision -- including the holder's owning user/SID, which the
    non-elevated session could not read -- is appended to logs\uac-reap.log.

    DISCOVERY THAT FAILS IS NOT DISCOVERY THAT FOUND NOTHING (fixed 2026-08-09).
    Every read here used -ErrorAction SilentlyContinue and then treated an empty
    result as fact, so a broken CIM/WMI provider produced this:

        $listeners = @(Get-NetTCPConnection ... -ErrorAction SilentlyContinue)
        if ($listeners.Count -eq 0) { 'OK: no listener on the port.'; exit 0 }

    Measured with Get-NetTCPConnection shadowed by a function that errors and
    returns nothing, against a port with a listener demonstrably bound:
        OK: no listener on the port.      exit 0
    The listener was still there. The delegation client records that exit 0 as a
    successful step, so the restart ladder above concludes the port is free --
    the one conclusion this elevated helper exists to make trustworthy. The same
    fail-open sat under the sibling-port guard, where an unreadable inventory
    silently WIDENED what may be killed, and under the post-kill release check,
    where it would have reported a release that was never observed.

    Discovery failure is now a refusal. It keeps the documented exit contract
    below: refusing is the safe direction for a kill, and a refusal is the
    diagnosis.

    Exit codes: 0 reaped, or the port was verifiably free. 1 refused or failed,
    which now includes "the port could not be read at all".

    ASCII ONLY: PowerShell 5.1 on this machine mis-parses non-ASCII characters
    in .ps1 files.

    Invoked only as:
      powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File tools\reap-loopback-listener.ps1 -Port 3889
    or a separately authorized fixed Mission Bridge port from 4610 through 4619.
#>
[CmdletBinding()]
param(
    [ValidateSet(3888, 3889, 4610, 4611, 4612, 4613, 4614, 4615, 4616, 4617, 4618, 4619)]
    [int]$Port = 3889
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logFile = Join-Path $repoRoot 'logs\uac-reap.log'
switch ($Port) {
    3889 {
        $componentName = 'dashboard'
        $expectedEntryPattern = 'AgentActivityVisualizer[\\/]server[\\/]index\.js'
        $siblingPort = $null
    }
    { $_ -ge 4610 -and $_ -le 4619 } {
        $componentName = 'Mission Bridge'
        $expectedEntryPattern = 'tools[\\/]mission-bridge\.js'
        $siblingPort = $null
        break
    }
    default { throw "Unexpected reap port $Port." }
}

function Write-ReapLog {
    param([string]$Message)
    $line = '[{0:yyyy-MM-dd HH:mm:ss}] [reap:{1}] {2}' -f (Get-Date), $Port, $Message
    try {
        $dir = Split-Path -Parent $logFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Add-Content -Path $logFile -Value $line -Encoding UTF8
    } catch { }
}

function Deny {
    param([string]$Message)
    Write-ReapLog -Message "REFUSED: $Message"
    Write-Output "REFUSED: $Message"
    exit 1
}

# The one place a port is read. It answers with three states, not two:
# ok+rows, ok+no rows (genuinely free), or a failed read. Get-NetTCPConnection
# raises a NON-TERMINATING ObjectNotFound (CmdletizationQuery_NotFound) for a
# free port, which is the only error category that means "nothing is there".
function Get-PortListenerReading {
    param([int]$OnPort)
    $readErrors = $null
    $rows = @(Get-NetTCPConnection -LocalPort $OnPort -State Listen -ErrorAction SilentlyContinue -ErrorVariable readErrors)
    $hard = @(@($readErrors) | Where-Object {
        $_ -and $_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound
    })
    if ($hard.Count -gt 0) {
        return [pscustomobject]@{
            ok = $false
            rows = @()
            error = ("{0}: {1}" -f $hard[0].FullyQualifiedErrorId, ($hard[0].Exception.Message -replace '[\r\n]+', ' '))
        }
    }
    return [pscustomobject]@{ ok = $true; rows = @($rows); error = $null }
}

function Get-ListenerPids {
    param([int]$OnPort)
    $reading = Get-PortListenerReading -OnPort $OnPort
    # FAIL CLOSED: this feeds a guard that decides what may NOT be killed. An
    # unreadable inventory here used to make the guard silently pass.
    if (-not $reading.ok) {
        Deny "the listener inventory for port $OnPort could not be read, so the sibling-port guard cannot be evaluated: $($reading.error)"
    }
    return @($reading.rows | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
}

Write-ReapLog -Message 'Reap requested (elevated, discover-and-verify).'

$reading = Get-PortListenerReading -OnPort $Port
if (-not $reading.ok) {
    Deny "the listener inventory for port $Port could not be read; whether anything holds it is UNKNOWN: $($reading.error)"
}
$listeners = @($reading.rows)
if ($listeners.Count -eq 0) {
    Write-ReapLog -Message 'Nothing to do: no listener on the port.'
    Write-Output 'OK: no listener on the port.'
    exit 0
}
if ($listeners.Count -ne 1) {
    Deny "expected exactly one listener on port $Port but found $($listeners.Count)."
}

$listener = $listeners[0]
$targetProcessId = [int]$listener.OwningProcess
$localAddress = [string]$listener.LocalAddress

if ($localAddress -ne '127.0.0.1' -and $localAddress -ne '::1') {
    Deny "the listener on port $Port is bound to $localAddress, not loopback."
}
if ($targetProcessId -eq $PID) {
    Deny 'the listener is this process.'
}
if ($null -ne $siblingPort -and (Get-ListenerPids -OnPort $siblingPort) -contains $targetProcessId) {
    Deny "PID $targetProcessId also holds the other declared listener port $siblingPort; it is not the $componentName listener."
}

$process = $null
try { $process = Get-Process -Id $targetProcessId -ErrorAction Stop } catch {
    Deny "PID $targetProcessId could not be opened even elevated: $($_.Exception.Message)"
}
if ($process.ProcessName -ne 'node') {
    Deny "PID $targetProcessId is '$($process.ProcessName)', not node."
}

# Record the candidate BEFORE the identity checks, so a refusal is still
# evidence. A refusal here is the most informative outcome available: it means
# even the elevated helper could not identify the holder.
$startedText = 'unknown'
try { $startedText = $process.StartTime.ToUniversalTime().ToString('o') } catch { }
Write-ReapLog -Message "Candidate: PID $targetProcessId name=$($process.ProcessName) started=$startedText bound=$localAddress."

$cim = $null
try { $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$targetProcessId" -ErrorAction Stop } catch { }
if ($null -eq $cim) {
    Deny "the Win32_Process record for PID $targetProcessId is unreadable; the holder cannot be identified."
}
$commandLine = [string]$cim.CommandLine
if ([string]::IsNullOrWhiteSpace($commandLine)) {
    Deny "the command line of PID $targetProcessId is unreadable; refusing to kill an unidentified process."
}
if ($commandLine -notmatch $expectedEntryPattern) {
    Deny "PID $targetProcessId does not run the expected $componentName entry point."
}

# Diagnostics the non-elevated session could not obtain: who actually owns the
# orphan. Recorded before the kill so the log explains the situation even if the
# termination itself fails.
$ownerText = 'unknown'
try {
    $owner = Invoke-CimMethod -InputObject $cim -MethodName GetOwner -ErrorAction Stop
    $ownerSid = Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid -ErrorAction SilentlyContinue
    $ownerText = "$($owner.Domain)\$($owner.User) sid=$($ownerSid.Sid)"
} catch { }
Write-ReapLog -Message ("Verified holder: PID $targetProcessId node, started $startedText, " +
    "owner $ownerText, bound $localAddress" + ":$Port.")

# The 2026-07-28 orphan had a child conhost that taskkill /T could not reach
# non-elevated, so children are terminated explicitly here.
$children = @()
try { $children = @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId=$targetProcessId" -ErrorAction Stop) } catch { }
foreach ($child in $children) {
    try {
        Stop-Process -Id ([int]$child.ProcessId) -Force -ErrorAction Stop
        Write-ReapLog -Message "Stopped child PID $($child.ProcessId) ($($child.Name))."
    } catch {
        Write-ReapLog -Message "Child PID $($child.ProcessId) could not be stopped: $($_.Exception.Message)"
    }
}

try {
    Stop-Process -Id $targetProcessId -Force -ErrorAction Stop
} catch {
    Write-ReapLog -Message "FAILED: Stop-Process on PID $targetProcessId errored: $($_.Exception.Message)"
    Write-Output "FAILED: PID $targetProcessId could not be terminated: $($_.Exception.Message)"
    exit 1
}

$deadline = (Get-Date).AddSeconds(10)
$lastReadError = $null
while ((Get-Date) -lt $deadline) {
    # A release must be OBSERVED. If this read fails, "no rows" would mean
    # "I could not look", and reporting that as a released port is how the whole
    # ladder above learns to trust a reap that never happened.
    $after = Get-PortListenerReading -OnPort $Port
    if ($after.ok -and $after.rows.Count -eq 0) {
        Write-ReapLog -Message "Reaped PID $targetProcessId; port $Port released."
        Write-Output "OK: reaped PID $targetProcessId; port $Port released."
        exit 0
    }
    if (-not $after.ok) { $lastReadError = $after.error }
    Start-Sleep -Milliseconds 500
}

if ($lastReadError) {
    Write-ReapLog -Message "FAILED: PID $targetProcessId was terminated but the release of port $Port could not be observed: $lastReadError"
    Write-Output "FAILED: PID $targetProcessId was terminated but the release of port $Port could not be observed: $lastReadError"
    exit 1
}
Write-ReapLog -Message "FAILED: PID $targetProcessId was terminated but port $Port is still held."
Write-Output "FAILED: port $Port is still held after terminating PID $targetProcessId."
exit 1
