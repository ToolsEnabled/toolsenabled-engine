#requires -Version 5.1
<#
    Register (or remove) the Windows scheduled task that keeps the Gemini fleet
    supervisor running.

    WHY A SCHEDULED TASK AT ALL: before this, every "and then start the next
    lane" step closed through the interactive controller session, which only
    runs when the owner sends a message. So when a batch of lanes finished,
    nothing started more work and the fleet silently went to zero while it was
    still being reported as busy. A scheduled task is an owner for that loop
    that does not depend on anybody being at the keyboard.

    WHY S4U (this is the no-console-window pattern, copied from
    tools/agent-digest-task.ps1 which already solved it here): an Interactive
    logon type runs the task on the owner's desktop and pops a console window.
    The owner has complained about flashing consoles repeatedly (ledger R22).
    S4U -- "run whether user is logged on or not", no stored password -- runs in
    a NON-INTERACTIVE session, which has no desktop to draw a console on at all.
    -Hidden is set as well, and every child process the supervisor spawns uses
    windowsHide:true, shell:false (src/lib/fleet-supervisor/lane-runner.js), so
    no shim console appears either.

    Deliberately NOT used: conhost.exe --headless. Ledger R22 records that it
    works but does not propagate the child exit code, so a failing supervisor
    would report success to Task Scheduler. That tradeoff is unnecessary here
    because S4U already gives a window-free session AND keeps the exit code.

    ELEVATION: registering an S4U principal needs SeBatchLogonRight, so
    -Register must be run from an ELEVATED PowerShell. The non-elevated
    interactive-principal alternative is refused on purpose: it would
    reintroduce the flashing console.

    ASCII ONLY: PowerShell 5.1 on this machine mis-parses non-ASCII characters
    in .ps1 files. Keep every character in this file inside ASCII.

    Usage (from an elevated PowerShell for -Register):
      powershell -ExecutionPolicy Bypass -File tools\fleet-supervisor-task.ps1 -Register
      powershell -ExecutionPolicy Bypass -File tools\fleet-supervisor-task.ps1 -Status
      powershell -ExecutionPolicy Bypass -File tools\fleet-supervisor-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
    [switch]$Register,
    [switch]$Unregister,
    [switch]$Status,
    [switch]$StartNow,
    [string]$TaskName
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

# The declared description of this subsystem lives in
# config\managed-processes.json. argv is ASSEMBLED from it, never written as a
# literal here. On 2026-07-29 this registrar hardcoded
#   --serve --quiet --concurrency N
# with no --project/--backend, while tools\fleet-supervisor.js defaults both to
# null. Combined with a 15-minute unattended repetition trigger, that argv
# turns a visible outage into a permanent invisible one: every lane fails
# instantly and queue items get falsely parked as no-progress (incident #5).
# Sourcing argv from the registry makes the argv Task Scheduler runs and the
# argv the control plane validates the same string by construction.
$registryPath = Join-Path $repoRoot 'config\managed-processes.json'
if (-not (Test-Path $registryPath)) { throw "Managed process registry not found: $registryPath" }
$registry = (Get-Content -Raw -Path $registryPath | ConvertFrom-Json).processes.'fleet-supervisor'
if ($null -eq $registry) { throw 'Managed process registry has no fleet-supervisor entry.' }

if ([string]::IsNullOrWhiteSpace($TaskName)) { $TaskName = $registry.taskName }
$entryPoint = Join-Path $repoRoot ($registry.entryPoint -replace '/', '\')

function Show-Status {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Output "Task '$TaskName' is not registered."
        return
    }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Output "Task        : $($task.TaskName)"
    Write-Output "State       : $($task.State)"
    Write-Output "LogonType   : $($task.Principal.LogonType)"
    Write-Output "RunLevel    : $($task.Principal.RunLevel)"
    Write-Output "Hidden      : $($task.Settings.Hidden)"
    Write-Output "Action      : $($task.Actions[0].Execute) $($task.Actions[0].Arguments)"
    Write-Output "LastRunTime : $($info.LastRunTime)"
    Write-Output "LastResult  : $($info.LastTaskResult)"
    Write-Output ''
    Write-Output 'Live fleet state: node tools\fleet-supervisor.js --status'
}

if ($Unregister) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Removed scheduled task '$TaskName'."
    } else {
        Write-Output "Task '$TaskName' was not registered."
    }
    return
}

if ($Status -or (-not $Register)) {
    Show-Status
    if (-not $Register) { return }
}

if (-not (Test-Path $entryPoint)) { throw "Fleet supervisor entry point not found: $entryPoint" }

$resolveNodeHelper = Join-Path $PSScriptRoot 'lib\resolve-node.ps1'
if (-not (Test-Path -LiteralPath $resolveNodeHelper -PathType Leaf)) { throw 'NODE_22_19_OR_NEWER_MISSING' }
. $resolveNodeHelper
$nodePath = Resolve-ToolsEnabledNode -Root $repoRoot

# Invoke the exact validator used by the coordinator before checking elevation
# or constructing/registering a task. Base64 carries the argv JSON without
# PowerShell 5.1 native-argument quote rewriting.
$managedProcessesModule = Join-Path $repoRoot 'src\lib\managed-processes.js'
$resolvedArgv = @($entryPoint) + @($registry.declaredArgv | ForEach-Object { [string]$_ })
$argvJson = ConvertTo-Json -Compress -InputObject $resolvedArgv
$argvBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($argvJson))
$validationExpr = 'const m=require(process.argv[1]);' +
    'const a=JSON.parse(Buffer.from(process.argv[2],`base64`).toString(`utf8`));' +
    'const r=m.checkArgvPreconditions(`fleet-supervisor`,a);' +
    'process.stdout.write(JSON.stringify(r));process.exit(r.ok?0:3);'
$priorPreference = $ErrorActionPreference
try {
    $ErrorActionPreference = 'Continue'
    $validationOutput = & $nodePath '-e' $validationExpr $managedProcessesModule $argvBase64 2>$null
    $validationExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $priorPreference
}
if ($validationExitCode -ne 0) {
    $validationReason = 'declared argv did not satisfy the canonical fleet service contract'
    try {
        $parsedValidation = ($validationOutput | Select-Object -Last 1) | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace([string]$parsedValidation.reason)) {
            $validationReason = [string]$parsedValidation.reason
        }
    } catch { }
    throw "CORRECTION_PRECONDITION_FAILED: $validationReason"
}

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw ('Registering an S4U scheduled task requires an elevated PowerShell (SeBatchLogonRight). ' +
        'Re-run this from an Administrator prompt. The interactive-logon alternative is refused on ' +
        'purpose: it would flash a console window on this machine.')
}

# --quiet keeps stdout off the (non-existent) console and sends every event to
# logs\fleet-supervisor.log instead. The supervisor owns its own poll interval.
# Every token after the entry point comes from declaredArgv in the registry.
$quotedArgv = @("`"$entryPoint`"") + @($registry.declaredArgv | ForEach-Object {
    if ($_ -match '\s') { "`"$_`"" } else { $_ }
})
$arguments = ($quotedArgv -join ' ')

$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $repoRoot

# AtStartup/AtLogOn give reboot and logon resilience. The repeating time
# trigger is the recovery path: if the supervisor process ever dies between
# reboots, the next repetition brings it back within 15 minutes. IgnoreNew
# means a trigger firing while it is already running is a no-op, and the
# supervisor's own PID lock (tools/fleet-supervisor.js) is a second guard
# against two live supervisors racing each other's claims.
# ROOT CAUSE of the "Fleet Supervisor task is not registered" outage:
# [TimeSpan]::MaxValue serializes through the CIM layer to
# P99999999DT23H59M59S, which Task Scheduler rejects outright:
#   "The task XML contains a value which is incorrectly formatted or out of
#    range.  (8,42):Duration:P99999999DT23H59M59S"
# Register-ScheduledTask therefore threw every single time, so this task was
# NEVER registered, so the fleet could never self-restart -- which is exactly
# why it stayed down for 45 minutes on 2026-07-29 with nobody noticing.
# Reproduced and verified: a finite duration registers cleanly. The range check
# happens at Register time, not at build time, so only a real registration
# attempt can catch this (tests/scheduled-task-registrars.test.js round-trips it).
$repeating = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes $registry.repetitionMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 9999)
. (Join-Path $PSScriptRoot 'lib\StartupPolicy.ps1')
# Boot and sign-in triggers come from the startup.services_at_logon switch
# (owner directive 2026-08-13), never from a literal in this file.
$triggers = New-ToolsEnabledTaskTriggers -Repeating $repeating -OwnerUser ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -IncludeStartup -IncludeLogon

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

$description = ('ToolsEnabled Gemini fleet supervisor. Keeps N lanes filled from BUILD-QUEUE.md open phases, ' +
    'claims items atomically, resumes after restart, caps retries, honours KILLSWITCH. Non-interactive by ' +
    'design (S4U): it must never put a console window on the desktop.')

# Register with -Force instead of unregister-then-register. The old sequence
# had a failure mode that this outage demonstrated: Unregister succeeds, then
# Register throws (the Duration bug above), leaving NO task at all where a
# working one used to be. -Force makes replacement atomic -- a failed
# re-registration leaves the previous task standing.
# With the switch off the task is registered but not runnable: the cadence
# trigger would otherwise restart the service minutes after every boot.
if (-not (Test-ToolsEnabledTaskShouldBeEnabled)) { $settings.Enabled = $false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings -Description $description -Force | Out-Null

Write-Output "Registered scheduled task '$TaskName' (S4U, hidden)."
Write-Output "Arguments   : $arguments"

# Registering does NOT start the fleet. AtStartup/AtLogOn only fire on a future
# startup or logon, and the repeating trigger's first repetition is up to 15
# minutes away. That delay is intentional here: the first real launch is the
# controller's call after review, not a side effect of installing the task.
# Pass -StartNow when you actually want it to begin.
if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Started '$TaskName' now."
    Start-Sleep -Seconds 2
} else {
    Write-Output "Not started. Run with -StartNow, or: Start-ScheduledTask -TaskName '$TaskName'"
}

Show-Status
