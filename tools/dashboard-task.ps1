#requires -Version 5.1
<#
    Register (or remove) the Windows scheduled task that keeps the Agent
    Activity Visualizer dashboard (port 3889) running without a live Claude
    Code / controller session.

    WHY A SCHEDULED TASK AT ALL: today the process is started ad hoc from
    an interactive PowerShell session (verified 2026-07-28: a PID on 3889
    with no owning scheduled task). It does not survive a reboot, and
    nothing restarts it if it crashes. tools/fleet-supervisor-task.ps1
    and tools/agent-digest-task.ps1 already solved exactly this problem for
    their own processes; this script matches their pattern.

    WHY S4U (copied from both reference scripts): an Interactive logon type
    runs the task on the owner's desktop and pops a console window (ledger
    R22 complaint). S4U -- "run whether user is logged on or not", no stored
    password -- runs in a NON-INTERACTIVE session with no desktop to draw a
    console on at all.

    WHY A POWERSHELL WRAPPER INSTEAD OF CALLING node.exe DIRECTLY (the one
    difference from the two reference scripts): the owner asked for a health
    self-check -- on task start, confirm the process actually opens its port
    within a few seconds, not just that node.exe is still alive. A bare
    node.exe action gives Task Scheduler no way to tell "started but never
    bound the port" from "healthy", so RestartCount would never fire for that
    failure mode. The wrapper (this same script, invoked with -RunComponent)
    starts node as a native hidden child process (CreateNoWindow, redirected
    std streams are NOT hooked -- inherited by the hidden process, matching
    the reference scripts' own direct-node pattern), polls the port, and:
      - if the port never opens, kills the child and exits 1 so Task
        Scheduler's RestartCount/RestartInterval retries it;
      - if the port opens, waits for the child and propagates its exit code,
        so a later crash still triggers the same restart path.
    All health-check outcomes are appended to logs\dashboard-task.log, never
    printed to a console (there is none under S4U, but the file is also how
    a human checks what happened without attaching a debugger).
    This is intentionally NOT a second supervisor: it does no unbounded retry
    loop. Task Scheduler's RestartCount/RestartInterval provides the immediate
    burst retry, while the finite repeating trigger is the durable recovery
    path after that budget is exhausted.

    NODE PATH BAKED IN AT REGISTRATION TIME: mirrors the reference scripts'
    own reasoning -- resolve `node` via PATH once, in the interactive
    registering session, and bake the absolute path into the task action
    rather than trusting PATH to be identical inside the S4U session.

    ELEVATION: registering an S4U principal needs SeBatchLogonRight, so
    -Register must be run from an ELEVATED PowerShell (verified against both
    reference scripts and re-confirmed live on this machine 2026-07-28: the
    session that authored this script is NOT elevated, so it built and
    dry-ran this script but did not attempt registration itself). Use
    -DryRun to see and validate the exact plan (task names, action, triggers,
    principal, settings) without touching Task Scheduler or requiring
    elevation. The interactive-principal alternative is refused on purpose:
    it would reintroduce the flashing console.

    ASCII ONLY: PowerShell 5.1 on this machine mis-parses non-ASCII
    characters in .ps1 files. Keep every character in this file inside ASCII.

    Usage:
      powershell -ExecutionPolicy Bypass -File tools\dashboard-task.ps1 -DryRun
      powershell -ExecutionPolicy Bypass -File tools\dashboard-task.ps1 -Status
      (from an elevated PowerShell)
      powershell -ExecutionPolicy Bypass -File tools\dashboard-task.ps1 -Register
      powershell -ExecutionPolicy Bypass -File tools\dashboard-task.ps1 -Register -StartNow
      powershell -ExecutionPolicy Bypass -File tools\dashboard-task.ps1 -Unregister

    Task Scheduler itself invokes this script with -RunComponent dashboard
    -NodePath <resolved node.exe>; that path is internal plumbing, not a
    supported interactive usage.
#>
[CmdletBinding()]
param(
    [switch]$Register,
    [switch]$Unregister,
    [switch]$Status,
    [switch]$StartNow,
    [switch]$DryRun,
    [ValidateSet('dashboard')]
    [string]$RunComponent,
    [ValidateSet('dashboard')]
    [string]$ReapComponent,
    [int]$ExpectedPid,
    [string]$NodePath,
    # Defaults read from config/managed-processes.json (the taskName
    # authority) instead of a second hardcoded copy; a caller may still
    # override either explicitly. NOT resolved here: with [CmdletBinding()]
    # present, $PSScriptRoot is unreliable (empty) while default VALUE
    # expressions in the param() block are evaluated -- every invocation of
    # this script threw "Cannot bind argument to parameter 'Path' because it
    # is an empty string" before a single line of the script body could run.
    # Resolved instead just below, once $repoRoot is available in the body.
    [string]$DashboardTaskName
)

$ErrorActionPreference = 'Stop'

# A Task Scheduler stop terminates this PowerShell wrapper but does not
# automatically terminate a child node.exe process.  Without a job object that
# leaves an orphan listener on 3889: the next task observes the old port,
# falsely passes its health check, and runs stale code forever.  The job below
# owns exactly one child and has KILL_ON_JOB_CLOSE, so both normal exit and a
# scheduler stop close the handle and terminate that child tree.  This is
# intentionally Windows-only because this script itself is Windows-only.
if ($null -eq ('ToolsEnabledDashboardJob' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class ToolsEnabledDashboardJob
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public IntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    public static IntPtr CreateKillOnClose()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed.");
        try
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, buffer, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, (uint)size))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed.");
            }
            finally { Marshal.FreeHGlobal(buffer); }
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
    }

    public static void Assign(IntPtr job, IntPtr process)
    {
        if (!AssignProcessToJobObject(job, process))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed.");
    }

    public static void Close(IntPtr job)
    {
        if (job != IntPtr.Zero) CloseHandle(job);
    }
}
'@
}

$repoRoot = Split-Path -Parent $PSScriptRoot

# The single load of config/managed-processes.json (the taskName/port
# authority). Every later reference to $managedRegistry.processes.* -- the
# dashboard port used in -RunComponent, -ReapComponent, and the
# registration plans below -- depends on this variable existing. It did not:
# a prior commit (95d6b261) switched five call sites from hardcoded ports to
# $managedRegistry.processes.*.port on the stated assumption that "$managedRegistry
# [was] already loaded for the taskName fix", but the taskName fix (47e090f5)
# only ever read the file into two param-default expressions, never into a
# script-scope $managedRegistry -- so every one of those five references was
# reading an undefined variable. tests/dashboard-task-port-guard.js could not
# have caught this: it only regex-matches this file's source text, and never
# actually runs it.
$managedRegistry = Get-Content -LiteralPath (Join-Path $repoRoot 'config\managed-processes.json') -Raw | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($DashboardTaskName)) { $DashboardTaskName = $managedRegistry.processes.dashboard.taskName }

# The AgentActivityVisualizer repo location, resolved rather than assumed.
#
# This was `Join-Path (Split-Path -Parent $repoRoot) 'AgentActivityVisualizer'`
# -- i.e. "my sibling". That held on Machine A, where the two repos sat side by
# side on the Desktop. The Machine B migration split them up: ToolsEnabled was
# promoted to C:\ToolsEnabled-live and the visualizer landed in
# C:\agent-apps\AgentActivityVisualizer, so the sibling guess resolved to
# C:\AgentActivityVisualizer and -DryRun failed with "Entry point missing".
# The registrar could therefore no longer register the dashboard at all, while
# the hand-registered live task kept working -- so the breakage was invisible
# until someone tried to re-register. Search known roots and take the first that
# actually contains server\index.js.
$visualizerCandidates = @(
    (Join-Path (Split-Path -Parent $repoRoot) 'AgentActivityVisualizer'),  # sibling (Machine A layout)
    'C:\agent-apps\AgentActivityVisualizer',                               # Machine B layout
    (Join-Path $env:USERPROFILE 'OneDrive\Desktop\AgentActivityVisualizer'),
    (Join-Path $env:USERPROFILE 'Desktop\AgentActivityVisualizer')
)
$visualizerRoot = $visualizerCandidates |
    Where-Object { Test-Path -LiteralPath (Join-Path $_ 'server\index.js') } |
    Select-Object -First 1
if (-not $visualizerRoot) { $visualizerRoot = $visualizerCandidates[0] }  # keep the old value so validation reports it

$dashboardEntryPoint = Join-Path $visualizerRoot 'server\index.js'
$logFile = Join-Path $repoRoot 'logs\dashboard-task.log'
$selfPath = $PSCommandPath
$portProbeScript = Join-Path $repoRoot 'tools\port-listener-probe.ps1'

# ---------------------------------------------------------------------------
# RunComponent: this is the branch Task Scheduler's action actually executes.
# Everything below this block is registration/status tooling for a human.
# ---------------------------------------------------------------------------
function Write-TaskLog {
    param([string]$Component, [string]$Message)
    $line = '[{0:yyyy-MM-dd HH:mm:ss}] [{1}] {2}' -f (Get-Date), $Component, $Message
    try {
        $dir = Split-Path -Parent $logFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Add-Content -Path $logFile -Value $line -Encoding UTF8
    } catch {
        # Logging must never throw and mask the health-check outcome itself.
    }
}

# HEALTH CHECK MUST PROVE OWNERSHIP, NOT LIVENESS OF THE PORT.
#
# This function used to return $true as soon as ANYTHING listened on the port.
# On 2026-07-28 an orphaned node.exe held 3889, so every restart logged
# "Health check OK: port 3889 is listening (PID 25836)" one second before
# "Process exited with code 1" -- the child had already died of EADDRINUSE and
# the ORPHAN answered the check. Two deploys shipped nothing, and Task
# Scheduler's RestartCount burned against a condition no restart could fix.
# The header comment at the top of this file predicted exactly that failure
# mode; the check simply did not implement it. It does now: the listener's
# OwningProcess must be the child we just started.
#
# Get-NetTCPConnection alone cannot see every loopback listener from a filtered
# token.  Use the canonical probe, which cross-checks netstat, everywhere this
# wrapper decides whether a port is free or owned.  An unreadable listener is
# still a listener; probe failure must therefore be treated as not proven free.
function Get-PortListeners {
    param([int]$Port)
    if (-not (Test-Path -LiteralPath $portProbeScript -PathType Leaf)) {
        throw "Port listener probe is missing: $portProbeScript"
    }
    $hostPath = Join-Path $PSHOME 'powershell.exe'
    $lines = @(& $hostPath -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $portProbeScript -Port $Port 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw "Port listener probe exited with code $LASTEXITCODE."
    }
    $raw = ($lines -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($raw)) {
        throw 'Port listener probe returned no JSON.'
    }
    try {
        $payload = $raw | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "Port listener probe returned invalid JSON: $($_.Exception.Message)"
    }
    return @($payload.listeners)
}

function Wait-PortOpen {
    param([int]$Port, [int]$OwningProcessId, [int]$TimeoutSeconds = 10)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $conn = @(Get-PortListeners -Port $Port)
            if ($conn.Count -gt 0) {
                if ($OwningProcessId -le 0) { return $true }
                foreach ($entry in $conn) {
                    if ([int]$entry.pid -eq $OwningProcessId) { return $true }
                }
            }
        } catch {}
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Get-PortOwnerSummary {
    param([int]$Port)
    try {
        $conn = @(Get-PortListeners -Port $Port)
        if ($conn.Count -eq 0) { return 'nothing is listening' }
        $parts = foreach ($entry in $conn) {
            $owner = [int]$entry.pid
            $name = if ($entry.processName) { [string]$entry.processName } else { 'unknown' }
            "PID $owner ($name) on $($entry.localAddress)"
        }
        return ($parts -join ', ')
    } catch {
        return 'the listener could not be queried'
    }
}

function Wait-PortClosed {
    param([int]$Port, [int]$TimeoutSeconds = 10)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $conn = @(Get-PortListeners -Port $Port)
            if (-not $conn) { return $true }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# Drain whatever the child wrote to stderr into the health log. Bounded and
# never throwing: a logging problem must not mask the health-check outcome.
function Write-ChildStandardError {
    param($Component, $StderrTask, $Process)
    try {
        if ($null -eq $StderrTask) { return }
        if (-not $StderrTask.Wait(2000)) { return }
        $text = $StderrTask.Result
        if ([string]::IsNullOrWhiteSpace($text)) { return }
        $flat = ($text -replace '\s+', ' ').Trim()
        if ($flat.Length -gt 1000) { $flat = $flat.Substring(0, 1000) + '...' }
        Write-TaskLog -Component $Component -Message "child stderr: $flat"
    } catch { }
}

# Long-lived children must never inherit an invisible session-0 pipe.  The
# wrapper drains both streams and keeps a short, bounded tail in the same
# operational log so a crash is diagnosable instead of looking like a random
# Task Scheduler result code.
function Write-ChildStream {
    param($Component, $StreamTask, [string]$StreamName)
    try {
        if ($null -eq $StreamTask) { return }
        if (-not $StreamTask.Wait(2000)) { return }
        $text = $StreamTask.Result
        if ([string]::IsNullOrWhiteSpace($text)) { return }
        $flat = ($text -replace '\s+', ' ').Trim()
        if ($flat.Length -gt 1000) { $flat = $flat.Substring(0, 1000) + '...' }
        Write-TaskLog -Component $Component -Message ("child {0}: {1}" -f $StreamName, $flat)
    } catch { }
}

function Test-PortOwnedByProcess {
    param([int]$Port, [int]$OwningProcessId)
    try {
        foreach ($entry in @(Get-PortListeners -Port $Port)) {
            if ([int]$entry.pid -eq $OwningProcessId) { return $true }
        }
    } catch { }
    return $false
}

function Test-PortOwnedByDeclaredComponent {
    param([int]$Port, [string[]]$Arguments)
    $identity = if(@($Arguments).Count -gt 0){ [string]$Arguments[0] } else { '' }
    $leaf = ''
    try { if($identity){ $leaf = [System.IO.Path]::GetFileName($identity) } } catch {}
    if([string]::IsNullOrWhiteSpace($leaf)){ return $false }
    try {
        foreach($entry in @(Get-PortListeners -Port $Port)) {
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$entry.pid)" -ErrorAction SilentlyContinue
            if($owner -and [string]$owner.CommandLine -match [regex]::Escape($leaf)){ return $true }
        }
    } catch { }
    return $false
}

function Invoke-MonitoredComponent {
    param(
        [string]$Component,
        [string]$WorkingDirectory,
        [string[]]$Arguments,
        [int]$Port
    )
    if ([string]::IsNullOrWhiteSpace($NodePath) -or -not (Test-Path $NodePath)) {
        Write-TaskLog -Component $Component -Message "FATAL: node path '$NodePath' was not passed or does not exist."
        exit 1
    }

    # A manual StartNow or a scheduler retry can race an already healthy
    # instance.  Treat the exact declared listener as success instead of
    # launching a duplicate child, waiting for a port it can never own, and
    # burning the task's finite RestartCount.
    $existing = @(Get-PortListeners -Port $Port)
    if($existing.Count -gt 0){
        if(Test-PortOwnedByDeclaredComponent -Port $Port -Arguments $Arguments){
            Write-TaskLog -Component $Component -Message "Already healthy: the declared component already owns port $Port; no duplicate was started."
            exit 0
        }
        Write-TaskLog -Component $Component -Message ("FAILED preflight: port {0} is held by an unrelated listener ({1})." -f $Port,(Get-PortOwnerSummary -Port $Port))
        exit 1
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $NodePath
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    # Capture both streams. Previously the child's stderr was inherited by a
    # session-0 process with no console and nobody draining it, so the two
    # failed deploys on 2026-07-28 exited 1 with their EADDRINUSE message going
    # nowhere. ReadToEndAsync is used (not a synchronous read) so either pipe
    # can never fill and deadlock the child while we poll the port.
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardOutput = $true
    $quoted = foreach ($raw in $Arguments) {
        $value = [string]$raw
        if ($value -match '[\s"]') { '"' + $value.Replace('"', '\"') + '"' } else { $value }
    }
    $psi.Arguments = ($quoted -join ' ')

    $job = [IntPtr]::Zero
    try {
        $job = [ToolsEnabledDashboardJob]::CreateKillOnClose()
        $process = New-Object System.Diagnostics.Process
        $process.StartInfo = $psi
        if (-not $process.Start()) {
            Write-TaskLog -Component $Component -Message 'FATAL: process failed to start.'
            exit 1
        }
        [ToolsEnabledDashboardJob]::Assign($job, $process.Handle)
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        Write-TaskLog -Component $Component -Message "Started PID $($process.Id) in a kill-on-close job, waiting up to 10s for port $Port to be owned by that PID..."

        $opened = Wait-PortOpen -Port $Port -OwningProcessId $process.Id -TimeoutSeconds 10
        if (-not $opened) {
            $owner = Get-PortOwnerSummary -Port $Port
            Write-TaskLog -Component $Component -Message ("FAILED health check: PID $($process.Id) does not own port $Port within 10s (currently $owner). " +
                "Killing PID $($process.Id) so Task Scheduler's RestartCount applies.")
            Write-ChildStream -Component $Component -StreamTask $stderrTask -StreamName 'stderr'
            Write-ChildStream -Component $Component -StreamTask $stdoutTask -StreamName 'stdout'
            try { $process.Kill() } catch {}
            try { $process.WaitForExit(5000) } catch {}
            exit 1
        }
        Write-TaskLog -Component $Component -Message "Health check OK: port $Port is listening AND owned by PID $($process.Id)."

        # A child can remain alive after its listener disappears (for example
        # after an internal server error).  Do not leave the wrapper waiting
        # forever in that state: two consecutive failed ownership probes make
        # the child exit non-zero, and the repeating trigger below starts it
        # again on the next minute boundary.
        $missingOwnership = 0
        while (-not $process.HasExited) {
            Start-Sleep -Seconds 5
            if (Test-PortOwnedByProcess -Port $Port -OwningProcessId $process.Id) {
                $missingOwnership = 0
                continue
            }
            $missingOwnership++
            if ($missingOwnership -lt 2) { continue }
            Write-TaskLog -Component $Component -Message "FAILED liveness check: PID $($process.Id) no longer owns port $Port. Restarting through the durable trigger."
            try { $process.Kill() } catch {}
            break
        }
        try { $process.WaitForExit(5000) } catch {}
        $code = $process.ExitCode
        Write-ChildStream -Component $Component -StreamTask $stderrTask -StreamName 'stderr'
        Write-ChildStream -Component $Component -StreamTask $stdoutTask -StreamName 'stdout'
        Write-TaskLog -Component $Component -Message "Process exited with code $code."
        exit $code
    } catch {
        Write-TaskLog -Component $Component -Message "FATAL: $($_.Exception.Message)"
        exit 1
    } finally {
        # Closing the job after a normal child exit is harmless. If the task is
        # stopped externally, Windows closes this handle as the wrapper exits
        # and applies the same kill-on-close policy to the child process tree.
        [ToolsEnabledDashboardJob]::Close($job)
    }
}

# NOTE: the parameter is deliberately NOT named $Pid -- that is a read-only
# PowerShell automatic variable, and shadowing it inside a function that then
# calls Stop-Process is exactly the kind of aliasing that turns a guarded reap
# into a self-kill.
function Invoke-ExactListenerReap {
    param([string]$Component, [int]$Port, [int]$TargetProcessId)
    if ($TargetProcessId -le 0) { throw 'ExpectedPid must be a positive process id.' }
    if ($TargetProcessId -eq $PID) { throw 'Reap refused: the expected PID is this process.' }
    $listeners = @(Get-PortListeners -Port $Port)
    if ($listeners.Count -eq 0) {
        Write-TaskLog -Component $Component -Message "Reap: port $Port was already closed."
        return
    }
    if ($listeners.Count -ne 1 -or [int]$listeners[0].pid -ne $TargetProcessId) {
        throw "Reap refused: port $Port no longer belongs to exact PID $TargetProcessId."
    }
    $process = Get-Process -Id $TargetProcessId -ErrorAction Stop
    if ($process.ProcessName -ne 'node') {
        throw "Reap refused: exact PID $TargetProcessId is not node.exe."
    }
    Stop-Process -Id $TargetProcessId -Force -ErrorAction Stop
    if (-not (Wait-PortClosed -Port $Port -TimeoutSeconds 10)) {
        throw "Reap failed: exact node PID $TargetProcessId did not release port $Port. It is very likely running under a token this session cannot terminate; escalate to the allowlisted elevated reap."
    }
    Write-TaskLog -Component $Component -Message "Reap: stopped exact orphan node PID $TargetProcessId on port $Port."
}

if ($RunComponent -eq 'dashboard') {
    Invoke-MonitoredComponent -Component 'dashboard' -WorkingDirectory $visualizerRoot `
        -Arguments (@($dashboardEntryPoint, '--host', '127.0.0.1', '--port', "$($managedRegistry.processes.dashboard.port)") + @($managedRegistry.processes.dashboard.declaredArgv)) -Port $managedRegistry.processes.dashboard.port
}
if ($ReapComponent) {
    $reapPort = $managedRegistry.processes.dashboard.port
    try {
        Invoke-ExactListenerReap -Component $ReapComponent -Port $reapPort -TargetProcessId $ExpectedPid
        exit 0
    } catch {
        Write-TaskLog -Component $ReapComponent -Message "FATAL reap: $($_.Exception.Message)"
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Human-facing tooling: -DryRun / -Status / -Register / -Unregister / -StartNow
# ---------------------------------------------------------------------------
# Resolved via tools/resolve-node.js's probed, capability-checked search
# (explicit TOOLSENABLED_NODE override, then common install locations
# including the historical C:\agent-apps pin, then PATH -- each candidate is
# verified with a real node:sqlite DatabaseSync.isOpen probe, not just a
# version string) instead of a hardcoded machine-specific path with an
# unverified PATH-only fallback.
#
# This was `(Get-Command node ...).Source`, which on this machine resolves to
# C:\Program Files\nodejs\node.exe -- v22.14.0, where node:sqlite's DatabaseSync
# has no .isOpen. src\lib\state-store.js then recurses forever
# (_open -> _migrate -> transaction -> _open) and every task.list dies with
# "Maximum call stack size exceeded", which reads like database corruption
# rather than a runtime mismatch. See AGENT-GUIDE.md section 7, landmine 0.
# A hardcoded C:\agent-apps pin with that same unverified PATH fallback only
# moves the landmine: on any machine other than the one it was written for,
# the pin misses and this silently falls back to whatever `node` is first on
# PATH, with no version or sqlite-capability check -- exactly the failure
# just described. tools/resolve-node.js's own interpreter does not need to
# qualify itself (it only inspects candidates in child processes), so bare
# PATH node can safely run it even when that PATH node is the very
# interpreter that would not qualify.
$resolveNodeScript = Join-Path $repoRoot 'tools\resolve-node.js'
$bootstrapNode = (Get-Command node -ErrorAction SilentlyContinue).Source
$resolvedNodePath = $null
if ($bootstrapNode -and (Test-Path -LiteralPath $resolveNodeScript)) {
    # No quote characters inside this JS on purpose: PowerShell 5.1's native
    # argv quoting mangles an embedded "" (empty-string literal) when this
    # string crosses into node.exe's argument list, so the check below
    # branches instead of ever needing one. stderr is deliberately left
    # unredirected -- this block only runs on the human-facing -DryRun /
    # -Status / -Register / -Unregister path (see the header comment above:
    # "NODE PATH BAKED IN AT REGISTRATION TIME ... in the interactive
    # registering session"), never inside the -RunComponent S4U task, and
    # redirecting a native command's stderr under $ErrorActionPreference =
    # 'Stop' turns each line into a terminating NativeCommandError even on a
    # clean exit 1 (resolve-node.js's own itemized failure report included).
    $probeExpr = 'const{resolveQualifyingNode}=require(process.argv[1]);' +
                 'const r=resolveQualifyingNode();' +
                 'if(r.node){process.stdout.write(r.node);process.exit(0);}' +
                 'process.exit(1);'
    $probeOutput = & $bootstrapNode '-e' $probeExpr $resolveNodeScript
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($probeOutput)) {
        $resolvedNodePath = ($probeOutput | Select-Object -Last 1).ToString().Trim()
    }
}
if ([string]::IsNullOrWhiteSpace($resolvedNodePath)) {
    # Safe working default: nothing on this machine passed the node:sqlite
    # capability probe (or tools/resolve-node.js itself is missing). Fall
    # back to bare PATH node rather than hard-failing here -- -DryRun and
    # -Status still need to run and report the gap; the -Register and
    # -RunComponent paths below already refuse with a clear message when
    # this stays blank or names a non-qualifying interpreter.
    $resolvedNodePath = $bootstrapNode
}
$pwshPath = (Get-Command powershell -ErrorAction SilentlyContinue).Source

function New-ComponentPlan {
    param([string]$TaskName, [string]$Component, [int]$Port, [string]$EntryPoint)
    $argString = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$selfPath`" -RunComponent $Component -NodePath `"$resolvedNodePath`""
    [pscustomobject]@{
        TaskName   = $TaskName
        Component  = $Component
        Port       = $Port
        EntryPoint = $EntryPoint
        Execute    = $pwshPath
        Arguments  = $argString
        WorkingDir = $repoRoot
    }
}

$dashboardPlan = New-ComponentPlan -TaskName $DashboardTaskName -Component 'dashboard' -Port $managedRegistry.processes.dashboard.port -EntryPoint $dashboardEntryPoint
$plans = @($dashboardPlan)

function Show-Plan {
    param($Plan)
    Write-Output "Task        : $($Plan.TaskName)"
    Write-Output "EntryPoint  : $($Plan.EntryPoint) $(if (Test-Path $Plan.EntryPoint) { '[exists]' } else { '[MISSING]' })"
    Write-Output "Execute     : $($Plan.Execute)"
    Write-Output "Arguments   : $($Plan.Arguments)"
    Write-Output "WorkingDir  : $($Plan.WorkingDir)"
    Write-Output 'Triggers    : AtStartup, AtLogOn (current user), every 1 minute while enabled'
    Write-Output "Principal   : $([System.Security.Principal.WindowsIdentity]::GetCurrent().Name), LogonType=S4U, RunLevel=Limited"
    Write-Output 'Settings    : Hidden, MultipleInstances=IgnoreNew, RestartCount=3, RestartInterval=5min, durable 1min recovery trigger, ExecutionTimeLimit=None'
    Write-Output ''
}

function Show-Status {
    foreach ($plan in $plans) {
        $task = Get-ScheduledTask -TaskName $plan.TaskName -ErrorAction SilentlyContinue
        if ($null -eq $task) {
            Write-Output "Task '$($plan.TaskName)' is not registered."
        } else {
            $info = Get-ScheduledTaskInfo -TaskName $plan.TaskName
            Write-Output "Task        : $($task.TaskName)"
            Write-Output "State       : $($task.State)"
            Write-Output "LogonType   : $($task.Principal.LogonType)"
            Write-Output "RunLevel    : $($task.Principal.RunLevel)"
            Write-Output "Hidden      : $($task.Settings.Hidden)"
            Write-Output "RestartCount: $($task.Settings.RestartCount)  RestartInterval: $($task.Settings.RestartInterval)"
            Write-Output "Action      : $($task.Actions[0].Execute) $($task.Actions[0].Arguments)"
            Write-Output "LastRunTime : $($info.LastRunTime)"
            Write-Output "LastResult  : $($info.LastTaskResult)"
        }
        try {
            $listeners = @(Get-PortListeners -Port $plan.Port)
            if ($listeners.Count -eq 0) {
                Write-Output "Port $($plan.Port) listening now: false"
            } else {
                $holder = $listeners | ForEach-Object {
                    $name = if ($_.processName) { [string]$_.processName } else { 'unknown' }
                    "PID $($_.pid) ($name) on $($_.localAddress)"
                }
                Write-Output "Port $($plan.Port) listening now: true ($($holder -join ', '))"
            }
        } catch {
            Write-Output "Port $($plan.Port) listening now: unknown (probe failed: $($_.Exception.Message))"
        }
        Write-Output ''
    }
    Write-Output "Health log: $logFile"
}

if ($DryRun) {
    Write-Output 'DRY RUN -- no scheduled task will be created or modified.'
    Write-Output ''
    foreach ($plan in $plans) { Show-Plan -Plan $plan }
    $missing = @()
    if ([string]::IsNullOrWhiteSpace($resolvedNodePath)) { $missing += 'node was not found on PATH.' }
    if ([string]::IsNullOrWhiteSpace($pwshPath)) { $missing += 'powershell.exe was not found on PATH.' }
    foreach ($plan in $plans) {
        if (-not (Test-Path $plan.EntryPoint)) { $missing += "Entry point missing: $($plan.EntryPoint)" }
    }
    if (-not (Test-Path (Split-Path -Parent $logFile))) {
        Write-Output "Note: log directory $(Split-Path -Parent $logFile) will be created on first health-check write."
    }
    if ($missing.Count -gt 0) {
        Write-Output 'VALIDATION FAILED:'
        $missing | ForEach-Object { Write-Output "  - $_" }
    } else {
        Write-Output 'VALIDATION OK: node, powershell, and both entry points resolved.'
    }
    return
}

if ($Unregister) {
    foreach ($plan in $plans) {
        if (Get-ScheduledTask -TaskName $plan.TaskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $plan.TaskName -Confirm:$false
            Write-Output "Removed scheduled task '$($plan.TaskName)'."
        } else {
            Write-Output "Task '$($plan.TaskName)' was not registered."
        }
    }
    return
}

if ($Status -or (-not $Register)) {
    Show-Status
    if (-not $Register) { return }
}

if ([string]::IsNullOrWhiteSpace($resolvedNodePath)) { throw 'node was not found on PATH.' }
if ([string]::IsNullOrWhiteSpace($pwshPath)) { throw 'powershell.exe was not found on PATH.' }
foreach ($plan in $plans) {
    if (-not (Test-Path $plan.EntryPoint)) { throw "Entry point not found: $($plan.EntryPoint)" }
}

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw ('Registering an S4U scheduled task requires an elevated PowerShell (SeBatchLogonRight). ' +
        'Re-run this from an Administrator prompt: powershell -ExecutionPolicy Bypass -File tools\dashboard-task.ps1 -Register -StartNow. ' +
        'Use -DryRun (no elevation needed) to inspect the exact plan first. The interactive-logon alternative is ' +
        'refused on purpose: it would flash a console window on this machine.')
}

foreach ($plan in $plans) {
    $action = New-ScheduledTaskAction -Execute $plan.Execute -Argument $plan.Arguments -WorkingDirectory $plan.WorkingDir
    # RestartCount is a useful burst retry, but it is finite.  The repeating
    # trigger is the durable recovery path: after the wrapper exits for a
    # crash, the next minute starts it again; while healthy, IgnoreNew leaves
    # the single existing instance alone.  A finite duration is mandatory --
    # Task Scheduler rejects TimeSpan::MaxValue and then silently leaves no
    # task registered.
    $repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes 1) `
        -RepetitionDuration (New-TimeSpan -Days 3650)
    . (Join-Path $PSScriptRoot 'lib\StartupPolicy.ps1')
    # Boot and sign-in triggers come from the startup.services_at_logon switch
    # (owner directive 2026-08-13), never from a literal in this file.
    $triggers = New-ToolsEnabledTaskTriggers -Repeating $repeatTrigger -OwnerUser ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -IncludeStartup -IncludeLogon
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 5) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -Hidden
    $description = "ToolsEnabled dashboard handoff ($($plan.Component), port $($plan.Port)). Durable health-checked hidden wrapper: " +
        'starts the child, confirms the port is owned by that exact PID, monitors ownership while it runs, and retries at the next minute boundary after a crash. ' +
        'Non-interactive by design (S4U).'

    # -Force replaces atomically. Unregister-then-Register leaves NO task at all
    # if Register throws; see tools\fleet-supervisor-task.ps1 for the outage.
    # With the switch off the task is registered but not runnable: the cadence
    # trigger would otherwise restart the service minutes after every boot.
    if (-not (Test-ToolsEnabledTaskShouldBeEnabled)) { $settings.Enabled = $false }
    Register-ScheduledTask -TaskName $plan.TaskName -Action $action -Trigger $triggers `
        -Principal $principal -Settings $settings -Description $description -Force | Out-Null
    Write-Output "Registered scheduled task '$($plan.TaskName)' (S4U, hidden, health-checked, durable 1min recovery)."
}

# Registering does not start either process: AtStartup/AtLogOn only fire on a
# future startup/logon. Pass -StartNow to begin immediately (mirrors
# agent-digest-task.ps1's "kick once so delivery does not wait for a reboot").
if ($StartNow) {
    foreach ($plan in $plans) {
        try {
            Start-ScheduledTask -TaskName $plan.TaskName -ErrorAction Stop
            Write-Output "Started '$($plan.TaskName)' now."
        } catch {
            Write-Warning "Registered '$($plan.TaskName)' but the immediate start failed: $($_.Exception.Message)"
        }
    }
    Start-Sleep -Seconds 2
} else {
    Write-Output 'Not started. Run with -StartNow, or Start-ScheduledTask for each task name above.'
}

Show-Status
