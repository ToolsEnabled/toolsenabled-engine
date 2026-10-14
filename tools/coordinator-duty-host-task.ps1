<#
    Registers the ToolsEnabled Coordinator Duty Host as a hidden S4U scheduled task.

    WHY THIS TASK EXISTS: coordinator duties must survive agent-session handoffs.
    Durable process observation, agent-comms intake detection, wake-signal
    monitoring, registration checks and pulse batching belong to a product
    process rather than whichever interactive agent happens to be active.

    Registering this host is the whole point: a duty that only runs while some
    agent session happens to be alive is a duty that will be dropped again at
    the next handoff, and dropped silently.

    ARGV AND TASK NAME COME FROM config\managed-processes.json. Nothing about
    this launch is written as a literal here, so the argv Task Scheduler runs
    and the argv the control plane validates cannot drift apart. That rule is
    not decorative: on 2026-07-29 the live fleet supervisor was running
    `--serve --quiet` while the registry declared `--project`/`--backend`, and
    every lane failed one at a time for hours.

    THE DURATION TRAP: do not "simplify" -RepetitionDuration to
    [TimeSpan]::MaxValue. It serializes to P99999999DT23H59M59S, Task Scheduler
    REJECTS it, Register-ScheduledTask throws, and the task silently never
    exists. Measured on this machine, unelevated, 2026-07-29:
      MaxValue    -> ERROR:The task XML contains a value which is incorrectly
                     formatted or out of range.  (8,42):Duration:P99999999DT23H59M59S
      -Days 9999  -> ERROR:Access is denied.
    The second error comes from a LATER stage than the first, which is what
    shows the duration value itself is accepted. tests/scheduled-task-registrars.test.js
    round-trips both so the trap cannot come back.

    ON LOGGING: there is deliberately no cmd.exe redirection wrapper here. A
    scheduled task launched with no console has no inherited pipe to wedge, and
    wrapping the launch in `cmd /c "node ... >> log 2>&1"` would make the live
    command line cmd.exe rather than node.exe -- which would break both the
    argv-match rung and src\lib\argv-drift.js, the two things that check this
    task is running what it declared. tools\coordinator-duty-host.js writes
    logs\coordinator-duty-host.log itself with appendFileSync instead.

    ELEVATION: registering an S4U principal needs SeBatchLogonRight, so
    -Register must be run from an ELEVATED PowerShell. This script CANNOT
    self-elevate and will not pretend to; see tools\register-managed-tasks.js
    for the tool that reports which tasks are missing and prints the exact
    elevated command.

    ASCII ONLY: PowerShell 5.1 on this machine mis-parses non-ASCII characters
    in .ps1 files. Keep every character in this file inside ASCII.

    Usage (from an elevated PowerShell for -Register):
      powershell -ExecutionPolicy Bypass -File tools\coordinator-duty-host-task.ps1 -Register
      powershell -ExecutionPolicy Bypass -File tools\coordinator-duty-host-task.ps1 -Status
      powershell -ExecutionPolicy Bypass -File tools\coordinator-duty-host-task.ps1 -Unregister
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

$registryPath = Join-Path $repoRoot 'config\managed-processes.json'
if (-not (Test-Path $registryPath)) { throw "Managed process registry not found: $registryPath" }
$registry = (Get-Content -Raw -Path $registryPath | ConvertFrom-Json).processes.'coordinator-duty-host'
if ($null -eq $registry) { throw 'Managed process registry has no coordinator-duty-host entry.' }

if ([string]::IsNullOrWhiteSpace($TaskName)) { $TaskName = $registry.taskName }
$entryPoint = Join-Path $repoRoot ($registry.entryPoint -replace '/', '\')
$resolveNodeHelper = Join-Path $PSScriptRoot 'lib\resolve-node.ps1'
if (-not (Test-Path -LiteralPath $resolveNodeHelper -PathType Leaf)) { throw "Node resolver not found: $resolveNodeHelper" }
. $resolveNodeHelper
$nodePath = Resolve-ToolsEnabledNode -Root $repoRoot

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
    Write-Output "Repetition  : $($task.Triggers[0].Repetition.Duration)"
    Write-Output "LastRunTime : $($info.LastRunTime)"
    Write-Output "LastResult  : $($info.LastTaskResult)"
}

if ($Unregister) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Unregistered '$TaskName'."
    } else {
        Write-Output "Task '$TaskName' was not registered."
    }
    return
}

if ($StartNow -and -not $Register) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Started '$TaskName'."
    return
}

if ($Status -or (-not $Register)) {
    Show-Status
    if (-not $Register) { return }
}

if (-not (Test-Path $entryPoint)) { throw "Coordinator duty host entry point not found: $entryPoint" }
if ([string]::IsNullOrWhiteSpace($nodePath)) { throw 'node was not found on PATH.' }

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw ('Registering an S4U scheduled task requires an elevated PowerShell (SeBatchLogonRight). ' +
        'Re-run this from an Administrator prompt. The interactive-logon alternative is refused on ' +
        'purpose: it would flash a console window on this machine.')
}

$quotedArgv = @("`"$entryPoint`"") + @($registry.declaredArgv | ForEach-Object {
    if ($_ -match '\s') { "`"$_`"" } else { $_ }
})
$arguments = ($quotedArgv -join ' ')

if ($registry.declaredArgv.Count -eq 0) {
    throw ("Refusing to register '$TaskName': declaredArgv is empty, so the task would launch the " +
        'duty host with no mode flag and it would exit immediately. Fix config\managed-processes.json first.')
}

$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $repoRoot

# AtStartup/AtLogOn give reboot and logon resilience. The repeating trigger is
# the recovery path: if the host dies, the next repetition brings it back --
# which is the entire reason this duty set was moved off an agent session.
# IgnoreNew makes a trigger firing while it already runs a no-op, and the
# host's own pid lock is a second guard against two hosts racing the inbox.
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

$description = ('ToolsEnabled coordinator duty host. Runs MECHANICAL coordinator duties outside ' +
    'interactive agent sessions: agent-comms intake DETECTION, wake-signal ' +
    'monitoring, argv drift detection, scheduled-task registration checks, pulse batching, and the ' +
    'end-of-cycle heartbeat. It never composes a reply to the owner and never decides anything; ' +
    'judgement duties are declared without a run() function so this process cannot execute one. ' +
    'Non-interactive by design (S4U).')

# -Force replaces atomically: a failed re-registration leaves the previous task
# standing instead of leaving nothing at all.
# With the switch off the task is registered but not runnable: the cadence
# trigger would otherwise restart the service minutes after every boot.
if (-not (Test-ToolsEnabledTaskShouldBeEnabled)) { $settings.Enabled = $false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings -Description $description -Force | Out-Null

Write-Output "Registered scheduled task '$TaskName' (S4U, hidden)."
Write-Output "Arguments   : $arguments"

if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Started '$TaskName' now."
} else {
    Write-Output "Not started. Run with -StartNow, or: Start-ScheduledTask -TaskName '$TaskName'"
}
