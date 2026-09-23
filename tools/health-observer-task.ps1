<#
    Registers the ToolsEnabled Health Observer as a hidden S4U scheduled task.

    WHY THIS TASK EXISTS: on 2026-07-29 the fleet supervisor was down for 45
    minutes and the only reason anyone found out was that the owner asked. A
    monitor armed at 05:20 detected the same condition in under 60 seconds --
    the signal was always available and simply unobserved. This task is what
    keeps something looking.

    It must survive reboot, which is the entire point of registering it rather
    than launching it by hand.

    ARGV AND TASK NAME COME FROM config\managed-processes.json. Nothing about
    this launch is written as a literal here, so the argv Task Scheduler runs
    and the argv the control plane validates cannot drift apart.

    THE DURATION TRAP: do not "simplify" -RepetitionDuration to
    [TimeSpan]::MaxValue. It serializes to P99999999DT23H59M59S, Task Scheduler
    REJECTS it, Register-ScheduledTask throws, and the task silently never
    exists -- which is exactly why the fleet supervisor and telegram bridge
    could not self-restart. tests/scheduled-task-registrars.test.js round-trips
    a real registration to keep that from coming back.

    ELEVATION: registering an S4U principal needs SeBatchLogonRight, so
    -Register must be run from an ELEVATED PowerShell.

    ASCII ONLY: PowerShell 5.1 on this machine mis-parses non-ASCII characters
    in .ps1 files. Keep every character in this file inside ASCII.

    Usage (from an elevated PowerShell for -Register):
      powershell -ExecutionPolicy Bypass -File tools\health-observer-task.ps1 -Register
      powershell -ExecutionPolicy Bypass -File tools\health-observer-task.ps1 -Status
      powershell -ExecutionPolicy Bypass -File tools\health-observer-task.ps1 -Unregister
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
$registry = (Get-Content -Raw -Path $registryPath | ConvertFrom-Json).processes.'health-observer'
if ($null -eq $registry) { throw 'Managed process registry has no health-observer entry.' }

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

if ($Status -or (-not $Register)) {
    Show-Status
    if (-not $Register) { return }
}

if (-not (Test-Path $entryPoint)) { throw "Health observer entry point not found: $entryPoint" }
$resolveNodeHelper = Join-Path $PSScriptRoot 'lib\resolve-node.ps1'
if (-not (Test-Path -LiteralPath $resolveNodeHelper -PathType Leaf)) { throw 'NODE_22_19_OR_NEWER_MISSING' }
. $resolveNodeHelper
$nodePath = Resolve-ToolsEnabledNode -Root $repoRoot

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

$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $repoRoot

# AtStartup/AtLogOn give reboot and logon resilience. The repeating trigger is
# the recovery path: if the observer dies, the next repetition brings it back.
# IgnoreNew makes a trigger firing while it already runs a no-op, and the
# observer's own pid lock is a second guard against two observers racing.
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

$description = ('ToolsEnabled health observer. Watches every managed subsystem against declared ' +
    'four-rung health invariants, writes state\health-snapshot.json, and escalates state ' +
    'TRANSITIONS into the owner directive inbox. Observes only; it never corrects anything and ' +
    'never makes a network or model call. Non-interactive by design (S4U).')

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
