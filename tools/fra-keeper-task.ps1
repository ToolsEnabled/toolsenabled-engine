# Registers the scheduled task that keeps the FRA listener (8790) alive.
#
# WHY THIS EXISTS. This is the on-demand resident keeper used by the single
# direct-link control. It drives tools\fra-keeper.js, whose bounded reconcile
# loop uses the FRA control/lifecycle surfaces and honors the durable stop
# sentinel. Enrollment and rotation authority are still enforced by those
# surfaces from the customer-declared coordinator/recipient topology; this task
# grants no role and contains no deployment-specific machine exception.
#
# Modelled on tools\health-observer-task.ps1. The keeper is JavaScript, so the
# action executes the pinned node rather than powershell.
[CmdletBinding()]
param(
    [switch]$Register,
    [switch]$Unregister,
    [switch]$Status,
    [switch]$StartNow,
    [switch]$StopNow,
    [string]$TaskName
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

$registryPath = Join-Path $repoRoot 'config\managed-processes.json'
if (-not (Test-Path $registryPath)) { throw "Managed process registry not found: $registryPath" }
$registry = (Get-Content -Raw -Path $registryPath | ConvertFrom-Json).processes.'fra-keeper'
if ($null -eq $registry) { throw 'Managed process registry has no fra-keeper entry.' }

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

# -StartNow / -StopNow WITHOUT -Register are how tools\direct-link.ps1 turns the
# keeper on and off. Both are unelevated operations on an already-registered
# task, which is the whole point: registering needs an administrator once, and
# pressing ON afterwards must not.
if (($StartNow -or $StopNow) -and -not $Register) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { throw "FRA_KEEPER_TASK_NOT_REGISTERED: run this script -Register from an elevated prompt first." }
    if ($StopNow) {
        # Stop-ScheduledTask on an instance that is not running is not an error
        # worth failing for; the sentinel is what actually ends the loop, and
        # this is the belt to its braces.
        try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
        Write-Output "Stopped '$TaskName'."
    }
    if ($StartNow) {
        Start-ScheduledTask -TaskName $TaskName
        Write-Output "Started '$TaskName'."
    }
    return
}

if ($Status -or (-not $Register)) {
    Show-Status
    if (-not $Register) { return }
}

if (-not (Test-Path $entryPoint)) { throw "FRA keeper entry point not found: $entryPoint" }
$resolveNodeHelper = Join-Path $PSScriptRoot 'lib\resolve-node.ps1'
if (-not (Test-Path -LiteralPath $resolveNodeHelper -PathType Leaf)) { throw 'NODE_22_19_OR_NEWER_MISSING' }
. $resolveNodeHelper
$nodePath = Resolve-ToolsEnabledNode -Root $repoRoot

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw ('Registering an S4U scheduled task requires an elevated PowerShell (SeBatchLogonRight). ' +
        'Re-run this from an Administrator prompt. The interactive-logon alternative is refused on ' +
        'purpose: it would flash a console window every repetition, forever.')
}

$scriptArgv = @($registry.declaredArgv | ForEach-Object {
    if ($_ -match '\s') { "`"$_`"" } else { $_ }
})
$arguments = ((@("`"$entryPoint`"") + $scriptArgv) -join ' ')

$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $repoRoot

# NO CADENCE TRIGGER, ON PURPOSE -- and this is the fix for the defect that made
# "the link stays on until the user turns it off" impossible.
#
# This task used to carry a 2-minute repetition plus AtStartup/AtLogOn. But a
# repetition combined with -StartWhenAvailable IS a startup trigger: it fires
# within two minutes of every boot no matter which triggers were dropped. So
# honouring startup.services_at_logon (owner directive 2026-08-13, and the owner
# has it off) meant registering this task DISABLED -- and a disabled keeper never
# starts FRA at all. The listener only survived because somebody had enabled the
# task by hand, out of band, and the next run of this very script or of
# tools\apply-startup-policy.ps1 would have silently switched FRA off for good
# while still reporting the task as REGISTERED.
#
# The keeper is now a resident loop (tools\fra-keeper.js --resident) that holds
# its own two-minute cadence in-process, so this task needs no cadence trigger.
# With the switch off it therefore has NO trigger at all: Windows cannot start
# it, only tools\direct-link.ps1 -On can, because a person pressed ON. That is
# what lets it stay ENABLED without contradicting the switch -- see the ON-DEMAND
# section in tools\lib\StartupPolicy.ps1 -- and it is why the link survives a
# crash but does not come back by itself after a restart unless the owner has
# asked for services at sign-in.
#
# A crashed run is retried by Task Scheduler's RestartOnFailure below rather than
# by the next firing, which is what a resident process needs.
. (Join-Path $PSScriptRoot 'lib\StartupPolicy.ps1')
# Sign-in trigger only when the switch is on, and never from a literal here.
# AtStartup is deliberately NOT requested: the keeper reaches the DPAPI vault for
# the FRA credential, and user-scope DPAPI is unavailable to an S4U task before
# the first interactive sign-in -- the same reason
# tools\full-remote-access-lifecycle.ps1 asks for -IncludeLogon alone.
$triggers = New-ToolsEnabledTaskTriggers -OnDemand -IncludeLogon -OwnerUser ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -RepoRoot $repoRoot

$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -Hidden

$description = ('ToolsEnabled FRA listener keeper. Resident loop; measures liveness by BINDING 8790 rather ' +
    'than reading a process table, because an unelevated read returns an empty command line for an S4U ' +
    'task-owned process and would start a second listener. Requires two agreeing negatives before ' +
    'starting anything, and honours state\full-remote-access.stop so a lane switched off stays off. ' +
    'On demand: started by tools\direct-link.ps1 -On, never by Windows unless the owner has turned on ' +
    'services at sign-in. Non-interactive by design (S4U).')

# ENABLED even with the switch off: with no trigger there is nothing for Windows
# to fire, so "enabled" means an ON press may start it, not that it self-starts.
if (-not (Test-ToolsEnabledTaskShouldBeEnabled -OnDemand -RepoRoot $repoRoot)) { $settings.Enabled = $false }

# Register-ScheduledTask REJECTS an empty -Trigger, and with the switch off that
# is exactly what an on-demand task has. Omit the parameter entirely in that
# case: a triggerless registered task is valid, and is what Task Scheduler itself
# calls an "On demand" task.
$registerArgs = @{
    TaskName    = $TaskName
    Action      = $action
    Principal   = $principal
    Settings    = $settings
    Description = $description
    Force       = $true
}
if (@($triggers).Count -gt 0) { $registerArgs['Trigger'] = $triggers }
Register-ScheduledTask @registerArgs | Out-Null

# Verified from what Windows actually stored, not from the register call
# returning without throwing.
$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
if ([string]$registered.Principal.LogonType -ne 'S4U' -or
    [string]$registered.Principal.RunLevel -ne 'Limited' -or
    -not [bool]$registered.Settings.Hidden -or
    [string]$registered.Settings.MultipleInstances -ne 'IgnoreNew') {
    throw 'FRA_KEEPER_TASK_VERIFICATION_FAILED'
}

Write-Output "Registered scheduled task '$TaskName' (S4U, hidden)."
Write-Output "Arguments   : $arguments"

if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Started '$TaskName' once now."
}
