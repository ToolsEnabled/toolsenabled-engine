# Registers the scheduled task that keeps logs/ from growing without bound.
#
# WHY THIS EXISTS. logs/ reached 783 MB on this machine with nothing anywhere
# that prunes it. A cleanup script that reclaims disk once is not retention --
# it is a mechanism wired to nothing, which is the failure this repo keeps
# repeating. This is the wire.
#
# The task runs tools\audit-logs-retention.js with the argv the registry
# declares (--apply --heartbeat), on the install policy: a per-class age table
# plus a total-size budget. Live audit sinks, the emergency spool and every
# referenced rotation segment are protected inside the tool and are not
# candidates under any argv this task could carry.
#
# Modelled on tools\fra-keeper-task.ps1. The pass is JavaScript, so the action
# executes the pinned node rather than powershell. It is a one-shot: each
# firing runs to completion and exits, so a failed run is retried by the next
# firing rather than leaving a dead resident loop nobody notices.
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
$registry = (Get-Content -Raw -Path $registryPath | ConvertFrom-Json).processes.'logs-retention'
if ($null -eq $registry) { throw 'Managed process registry has no logs-retention entry.' }

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

if ($Status -or (-not $Register)) {
    Show-Status
    if (-not $Register) { return }
}

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) { throw "Logs retention entry point not found: $entryPoint" }
# Resolve and functionally probe Node at registration time, then bake that
# absolute path into the unattended action.  The old developer-machine literal
# made registration impossible on every otherwise-valid customer installation
# whose qualifying Node lived elsewhere.
. (Join-Path $PSScriptRoot 'lib\resolve-node.ps1')
$nodePath = Resolve-ToolsEnabledNode -Root $repoRoot
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'NODE_22_19_OR_NEWER_MISSING' }

# A retention task registered without an applying argv would be the same defect
# in a new costume: a scheduled job that reports and never acts.
if (-not ($registry.declaredArgv -contains '--apply')) {
    throw 'Refusing to register: config\managed-processes.json declares logs-retention without --apply, so the task would prune nothing forever.'
}

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

# AtStartup is the cold-start guarantee: a machine that was off for a month
# still gets a pass on the way back up. The repetition is the steady state.
$repeating = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes $registry.repetitionMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 9999)
. (Join-Path $PSScriptRoot 'lib\StartupPolicy.ps1')
# Boot and sign-in triggers come from the startup.services_at_logon switch
# (owner directive 2026-08-13), never from a literal in this file.
$triggers = New-ToolsEnabledTaskTriggers -Repeating $repeating -IncludeStartup

$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -Hidden

$description = ('ToolsEnabled logs retention. Prunes logs\ on a declared per-class age table with a ' +
    'total-size budget, so an install cannot silently grow to hundreds of megabytes of logs. Live audit ' +
    'sinks, the emergency spool, and every rotation segment the rotation record references are protected ' +
    'unconditionally and are never candidates; an unreadable rotation record protects every segment. ' +
    'Never follows a symlink or junction. Honours state\logs-retention.stop. Non-interactive by design (S4U).')

# With the switch off the task is registered but not runnable: the cadence
# trigger would otherwise restart the service minutes after every boot.
if (-not (Test-ToolsEnabledTaskShouldBeEnabled)) { $settings.Enabled = $false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings -Description $description -Force | Out-Null

# Verified from what Windows actually stored, not from the register call
# returning without throwing.
$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
if ([string]$registered.Principal.LogonType -ne 'S4U' -or
    [string]$registered.Principal.RunLevel -ne 'Limited' -or
    -not [bool]$registered.Settings.Hidden -or
    [string]$registered.Settings.MultipleInstances -ne 'IgnoreNew') {
    throw 'LOGS_RETENTION_TASK_VERIFICATION_FAILED'
}

Write-Output "Registered scheduled task '$TaskName' (S4U, hidden)."
Write-Output "Arguments   : $arguments"

if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Started '$TaskName' once now."
}
