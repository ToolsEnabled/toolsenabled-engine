# Keeps the Server Control Panel ALWAYS ON. Runs every couple of minutes (scheduled task
# "ServerPanelWatchdog") + at logon. Liveness = the panel's single-instance mutex; if it's not
# held, the panel isn't running, so relaunch it hidden-to-tray. Cheap and idempotent: if the panel
# is up, this exits in ~1ms without touching anything.
#
# THE RECLAIM USED TO BE AN ASSERTION, NOT A MEASUREMENT.
#
# The stale-heartbeat branch below called Stop-Process with the error stream
# silenced and then executed `$held = $false` UNCONDITIONALLY -- i.e. it declared
# the single-instance slot reclaimed without ever looking again. Reproduced in an
# isolated lab (a stub panel and a stub victim process, no real panel
# involved): the mutex was held by one process while the heartbeat named a
# different one. The watchdog killed the process it could kill, assumed the slot
# was free, and logged
#     panel heartbeat stale; stopping PID 47456 before relaunch
#     panel was down or heartbeat was stale -> relaunched
# while the mutex was STILL HELD -- so what it actually did was start a SECOND
# panel, which is the precise outcome the "never kill an unrelated PowerShell"
# rule and the "no duplicate instance started" branch exist to prevent. Exit code
# was 0, so the scheduled task recorded a clean run.
#
# A failed termination now reports itself. The reclaim is confirmed against the
# authority the relaunch decision actually depends on -- the mutex -- and the
# exit code follows the outcome instead of the fact that the script reached its
# last line.
#
# EXIT CODES: 0 = the panel is healthy, or a relaunch was started because the
# slot was genuinely free. 1 = unresolved: the slot is held by something that is
# not a healthy panel and could not be reclaimed, the panel file is missing, or
# the relaunch itself failed. Nothing parses this script's stdout.
#
# ASCII ONLY: Windows PowerShell 5.1 can mis-parse non-ASCII script characters under some host codepages.
$ErrorActionPreference = 'SilentlyContinue'
$panel = Join-Path $PSScriptRoot 'Server-Control-Panel.ps1'
$mutexName = 'Local\ServerControlPanel'
$log = Join-Path $PSScriptRoot 'watchdog-log.txt'
$heartbeatPath = Join-Path $PSScriptRoot 'panel-heartbeat.json'
$heartbeatMaxAgeSeconds = 12

function Write-WatchdogLog([string]$message) {
    try {
        Add-Content -LiteralPath $log -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message) -Encoding UTF8
    } catch {}
}

function Read-Heartbeat {
    if(-not (Test-Path -LiteralPath $heartbeatPath)){ return $null }
    try { return (Get-Content -Raw -LiteralPath $heartbeatPath | ConvertFrom-Json) } catch { return $null }
}

function Test-Heartbeat($heartbeat) {
    if(-not $heartbeat -or -not $heartbeat.ProcessId -or -not $heartbeat.UpdatedAt){ return $false }
    try {
        # Heartbeats are written with a trailing Z.  DateTime.Parse in
        # Windows PowerShell can materialize that value as local time; use
        # DateTimeOffset so the age calculation stays in one (UTC) frame.
        $updatedUtc = [DateTimeOffset]::Parse([string]$heartbeat.UpdatedAt).UtcDateTime
        $age = ((Get-Date).ToUniversalTime() - $updatedUtc).TotalSeconds
        if($age -lt 0 -or $age -gt $heartbeatMaxAgeSeconds){ return $false }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$heartbeat.ProcessId)" -ErrorAction SilentlyContinue
        if(-not ($process -and $process.Name -ieq 'powershell.exe')){ return $false }
        # UNREADABLE IS NOT UNHEALTHY. An unelevated Win32_Process read returns
        # an EMPTY CommandLine for a process in another session, so if the panel
        # is ever started by a scheduled task this match fails forever and the
        # watchdog treats a HEALTHY panel as dead -- then kills and relaunches it
        # on every cycle. That is the harmful direction, unlike the stale-PID
        # branch below where an unreadable line correctly means "do not kill".
        # Two agreeing positives stand in for the unreadable field: the recorded
        # pid is alive AND it is powershell.exe AND its heartbeat is fresh, which
        # was already checked above.
        $commandLine = [string]$process.CommandLine
        if([string]::IsNullOrWhiteSpace($commandLine)){ return $true }
        return [bool]($commandLine -match 'Server-Control-Panel\.ps1')
    } catch { return $false }
}

# The single authority on "is a panel instance occupying the slot". It is read
# here, and re-read after any reclaim attempt, because the reclaim's whole
# purpose is to change this answer and only a second read can show that it did.
function Test-PanelMutexHeld {
    try { $m = [System.Threading.Mutex]::OpenExisting($mutexName); $m.Dispose(); return $true }
    catch { return $false }
}

$held = Test-PanelMutexHeld
$heartbeat = Read-Heartbeat
$healthy = $held -and (Test-Heartbeat $heartbeat)

# The old watchdog trusted the mutex alone.  A hung WinForms/Explorer path can
# keep that mutex while the UI is no longer processing timer ticks, so the
# watchdog would report success forever.  A stale heartbeat is actionable only
# when its PID still names our panel; never kill an unrelated PowerShell.
$reclaimFailure = $null
if($held -and -not $healthy -and $heartbeat -and $heartbeat.ProcessId){
    try {
        $stalePid = [int]$heartbeat.ProcessId
        $stale = Get-CimInstance Win32_Process -Filter "ProcessId=$stalePid" -ErrorAction SilentlyContinue
        # MEASUREMENT-HONESTY-OK: unreadable gives the SAFE answer on this path.
        # If the command line cannot be read the match fails and we do NOT kill,
        # which is exactly the "never kill an unrelated PowerShell" rule above.
        # The health check has the opposite polarity and is guarded there.
        if($stale -and [string]$stale.CommandLine -match 'Server-Control-Panel\.ps1'){
            Write-WatchdogLog ('panel heartbeat stale; stopping PID {0} before relaunch' -f $stalePid)
            $stopError = $null
            try { Stop-Process -Id $stalePid -Force -ErrorAction Stop }
            catch { $stopError = ($_.Exception.Message -replace '[\r\n]+', ' ') }

            # POST-CONDITION, NOT ASSUMPTION. Terminating a process is not the
            # same event as the slot becoming free: the mutex can be owned by a
            # different process entirely, and a handle takes a moment to close
            # even when it is the right one. Both are measured, with a bound.
            $processGone = $false
            $slotFree = $false
            $deadline = (Get-Date).AddSeconds(5)
            while($true){
                $processGone = -not [bool](Get-Process -Id $stalePid -ErrorAction SilentlyContinue)
                $slotFree = -not (Test-PanelMutexHeld)
                if($processGone -and $slotFree){ break }
                if((Get-Date) -ge $deadline){ break }
                Start-Sleep -Milliseconds 250
            }

            if($processGone -and $slotFree){
                Write-WatchdogLog ('reclaimed the panel slot: PID {0} is gone and the single-instance mutex is free' -f $stalePid)
                $held = $false
            } else {
                $reclaimFailure = ('reclaim FAILED for PID {0}: processGone={1} mutexFree={2}{3}' -f
                    $stalePid, $processGone, $slotFree,
                    $(if($stopError){ " stopError=$stopError" } else { '' }))
                Write-WatchdogLog $reclaimFailure
                # $held deliberately keeps its measured value. Relaunching over a
                # slot that is still occupied is how a duplicate panel is born.
            }
        }
    } catch {
        $reclaimFailure = ('reclaim FAILED with an unexpected error: {0}' -f ($_.Exception.Message -replace '[\r\n]+', ' '))
        Write-WatchdogLog $reclaimFailure
    }
}

if ($healthy) { exit 0 }

if (-not $held) {
    if (-not (Test-Path -LiteralPath $panel)) {
        Write-WatchdogLog ('panel is down and CANNOT be relaunched: {0} is missing' -f $panel)
        exit 1
    }
    # Do not use Start-Process here.  On some Windows builds it briefly
    # allocates a console host even when -WindowStyle Hidden is supplied,
    # which is exactly the terminal flash this watchdog is meant to avoid.
    # Native ProcessStartInfo keeps the relaunch detached and console-free.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    $psi.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $panel + '" -Minimized'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $psi
    # A relaunch that never started must not be logged as one. The old code had
    # no guard here at all, so a failed Start() aborted the script before its
    # "-> relaunched" line, leaving the log silent about the whole cycle.
    $started = $false
    $startError = $null
    try { $started = $child.Start() } catch { $startError = ($_.Exception.Message -replace '[\r\n]+', ' ') }
    $childId = if ($started) { [int]$child.Id } else { $null }
    $child.Dispose()
    if (-not $started) {
        Write-WatchdogLog ('panel was down but the relaunch FAILED to start{0}' -f $(if($startError){ ": $startError" } else { '' }))
        exit 1
    }
    Write-WatchdogLog ('panel was down or heartbeat was stale -> relaunched as PID {0}' -f $childId)
    exit 0
}

Write-WatchdogLog ('panel mutex is held but the stale heartbeat owner could not be safely reclaimed; no duplicate instance started{0}' -f
    $(if($reclaimFailure){ " ($reclaimFailure)" } else { '' }))
exit 1
