#requires -Version 5.1
<#
    READ-ONLY probe: who is listening on a loopback port, and is it really the
    process we think it is?

    WHY THIS EXISTS. tools\dashboard-task.ps1 asked only "is anything listening
    on 3889" and therefore reported "Health check OK" over an orphaned listener
    twice on 2026-07-28 while the process it had just started died of
    EADDRINUSE one second later. Two deploys were lost to that false success.
    Verifying a restart requires the OWNING PID and its START TIME, not the
    port's open/closed state, so this script returns exactly that.

    It opens no handles beyond what Get-Process / Get-CimInstance need, kills
    nothing, and changes nothing. When the owning process is in a security
    context this session cannot read (the 2026-07-28 orphan was one: a full,
    unfiltered administrator token whose default DACL excludes the filtered
    token of the same user), the entry is still returned with accessible=false
    and the specific error -- an unreadable holder is a DIAGNOSIS, not a blank.

    THE SAME RULE HAD A HOLE AT THE LEVEL ABOVE, fixed 2026-08-09. The two
    inventories were listed in `sources` the moment their block finished, not
    when they SUCCEEDED, and a native non-zero exit is not a PowerShell error:

        $netstatLines = @(& $netstatPath -ano -p tcp 2>$null)   # exits 1, no output
        ...
        $probeSources += 'netstat'                              # claimed anyway

    Measured with a netstat stand-in that exits 1 silently, on a free port:
        {"port":51996,"listeners":[],"sources":["get-nettcp","netstat"],"error":null}
        exit code 0
    A cross-check that never ran was reported as having run, the result was a
    confident empty inventory, and the caller had nothing to tell it apart from
    a genuinely free port -- which is precisely the false "port is free" this
    file was written to prevent, reintroduced one layer up. The whole reason
    netstat is here is that Get-NetTCPConnection alone can miss a listener.

    A source is now recorded only if it completed; a failed one is named in
    failedSources; ok says whether the inventory is complete. AN INDETERMINATE
    ANSWER IS NOT AN EMPTY ANSWER, so the exit code carries it:
        0  the inventory can be trusted -- every source completed, OR a listener
           was positively identified (a holder that was FOUND is found, even if
           the other rung was degraded).
        2  INDETERMINATE: a source failed and nothing was found, so "free" is not
           established. Callers already treat non-zero as unusable
           (tools\dashboard-task.ps1 throws on $LASTEXITCODE; src\lib\service-
           control.js raises SERVICE_PROBE_FAILED), so this needs no caller change.

    Output: one compressed JSON object on stdout. Nothing else is written.

    ASCII ONLY: PowerShell 5.1 on this machine mis-parses non-ASCII characters
    in .ps1 files.

    Usage:
      powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tools\port-listener-probe.ps1 -Port 3889
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int]$Port
)

$ErrorActionPreference = 'Stop'

function Get-ListenerDetail {
    param($Connection)

    $detail = [ordered]@{
        pid           = [int]$Connection.OwningProcess
        localAddress  = [string]$Connection.LocalAddress
        processName   = $null
        executablePath = $null
        commandLine   = $null
        startTime     = $null
        accessible    = $false
        error         = $null
    }

    try {
        $process = Get-Process -Id $detail.pid -ErrorAction Stop
        $detail.processName = $process.ProcessName
        try { $detail.executablePath = $process.Path } catch { }
        try { $detail.startTime = $process.StartTime.ToUniversalTime().ToString('o') } catch { }
        $detail.accessible = $true
    } catch {
        $detail.error = $_.Exception.Message
    }

    # CommandLine identifies WHICH node server holds the port. It is often
    # unreadable across security contexts; that is recorded, never guessed.
    try {
        $cim = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$($detail.pid)" -ErrorAction Stop
        if ($null -ne $cim) {
            if (-not $detail.processName) { $detail.processName = [string]$cim.Name -replace '\.exe$', '' }
            if (-not $detail.commandLine -and $cim.CommandLine) { $detail.commandLine = [string]$cim.CommandLine }
            if (-not $detail.startTime -and $cim.CreationDate) {
                try { $detail.startTime = ([datetime]$cim.CreationDate).ToUniversalTime().ToString('o') } catch { }
            }
        }
    } catch { }

    return [pscustomobject]$detail
}

$listeners = [System.Collections.Generic.List[object]]::new()
$listenerKeys = @{}
$probeSources = @()
$probeErrors = @()

# Get-NetTCPConnection is normally richer than netstat, but an S4U/full-admin
# listener can be invisible to a filtered interactive token even though the
# socket is still present.  The 2026-07-28 dashboard orphan was exactly that
# case: the cmdlet returned no rows while `netstat -ano` correctly named the
# listener PID.  Merge the two read-only inventories so an invisible holder is
# a diagnosis, never mistaken for a free port.
function Add-Listener {
    param($Connection)

    $listenerPid = 0
    try { $listenerPid = [int]$Connection.OwningProcess } catch { return }
    $address = [string]$Connection.LocalAddress
    if ($listenerPid -le 0 -or [string]::IsNullOrWhiteSpace($address)) { return }
    $key = "$listenerPid|$address"
    if ($listenerKeys.ContainsKey($key)) { return }
    $listenerKeys[$key] = $true
    # A mutable list is intentional: `+=` inside this function would create a
    # function-local array and silently leave the caller's result empty.
    [void]$listeners.Add((Get-ListenerDetail -Connection $Connection))
}

try {
    # Get-NetTCPConnection raises a NON-TERMINATING ObjectNotFound
    # (CmdletizationQuery_NotFound) when the port is simply free, which is why
    # -ErrorAction SilentlyContinue is correct here. Any OTHER error means the
    # inventory could not be read, and silence would turn that into "free".
    $tcpErrors = $null
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue -ErrorVariable tcpErrors)
    $tcpHardErrors = @(@($tcpErrors) | Where-Object {
        $_ -and $_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound
    })
    if ($tcpHardErrors.Count -gt 0) {
        throw ("query failed ({0}): {1}" -f $tcpHardErrors[0].FullyQualifiedErrorId, $tcpHardErrors[0].Exception.Message)
    }
    foreach ($connection in $connections) { Add-Listener -Connection $connection }
    $probeSources += 'get-nettcp'
} catch {
    $probeErrors += "Get-NetTCPConnection: $($_.Exception.Message)"
}

try {
    $netstatPath = Join-Path $env:SystemRoot 'System32\netstat.exe'
    if (-not (Test-Path -LiteralPath $netstatPath -PathType Leaf)) {
        throw 'netstat.exe was not found under SystemRoot\\System32.'
    }
    $netstatLines = @(& $netstatPath -ano -p tcp 2>$null)
    # Read on the very next line, and never through a pipe: $LASTEXITCODE after a
    # pipeline reports the pipeline's last command. A native tool's failure is an
    # exit code, not a PowerShell error, so nothing above would have raised.
    $netstatExit = $LASTEXITCODE
    if ($netstatExit -ne 0) { throw "netstat exited with code $netstatExit." }
    $tcpLinePattern = [regex]'^\s*TCP\s+(?<endpoint>\S+)\s+\S+\s+LISTENING\s+(?<pid>\d+)\s*$'
    $endpointPattern = [regex]'^(?<address>\[[^\]]+\]|[^:]+):(?<port>\d+)$'
    foreach ($line in $netstatLines) {
        $tcpLine = $tcpLinePattern.Match([string]$line)
        if (-not $tcpLine.Success) { continue }
        $netstatPid = [int]$tcpLine.Groups['pid'].Value
        $endpoint = [string]$tcpLine.Groups['endpoint'].Value
        $endpointMatch = $endpointPattern.Match($endpoint)
        if (-not $endpointMatch.Success) { continue }
        if ([int]$endpointMatch.Groups['port'].Value -ne $Port) { continue }
        $address = [string]$endpointMatch.Groups['address'].Value
        if ($address.StartsWith('[') -and $address.EndsWith(']')) { $address = $address.Substring(1, $address.Length - 2) }
        Add-Listener -Connection ([pscustomobject]@{
            OwningProcess = $netstatPid
            LocalAddress = $address
        })
    }
    $probeSources += 'netstat'
} catch {
    $probeErrors += "netstat: $($_.Exception.Message)"
}

$attemptedSources = @('get-nettcp', 'netstat')
$completedSources = @($probeSources | Sort-Object -Unique)
$failedSources = @($attemptedSources | Where-Object { $completedSources -notcontains $_ })
$inventoryComplete = ($failedSources.Count -eq 0)

$result = [ordered]@{
    port          = $Port
    queriedAt     = (Get-Date).ToUniversalTime().ToString('o')
    listeners     = @($listeners)
    sources       = $completedSources
    failedSources = $failedSources
    ok            = $inventoryComplete
    error         = if ($probeErrors.Count) { $probeErrors -join ' | ' } else { $null }
}

# -Compress keeps this to one line; the JS caller parses stdout as a whole.
Write-Output ((New-Object psobject -Property $result) | ConvertTo-Json -Depth 5 -Compress)

# An empty list from a degraded inventory is not a finding, it is a gap. Say so
# in the one channel every current caller already checks.
if ($inventoryComplete -or $listeners.Count -gt 0) { exit 0 }
exit 2
