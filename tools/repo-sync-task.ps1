# Registers the scheduled task that keeps this clone converged on the canonical
# GitHub trunk.
#
# WHY THIS EXISTS. Owner directive R1120 (2026-08-04): canonical ToolsEnabled
# lives on the private GitHub origin and "the sync fully happens" there, so all
# agents on all computers work on one trunk. Before this keeper existed, the two
# machines diverged 30-vs-13 commits and both minted DIFFERENT owner requests
# under the same ledger id (R1101) -- nobody's fault, nothing reconciled them.
# A trunk nobody reconciles is not canonical; a sync a human must remember to
# run is a comment, not a mechanism (see tunnel-bridge-keeper-task.ps1 for the
# precedent this file copies).
#
# The receiver itself (tools\repo-sync.js) is fail-closed and receive-only:
# fetch/prune, verify the all-ref single-copy result, and fast-forward a clean
# dedicated main checkout with --ff-only. It never publishes, auto-merges,
# rebases, resets, or pushes. Dirty, ahead, diverged, stale, and unknown states
# stop and are written to state\repo-sync.json for the status reader.
#
# Modelled on tools\tunnel-bridge-keeper-task.ps1 / health-observer-task.ps1,
# the canonical registrars in this repo. Entry point is node.
[CmdletBinding()]
param(
    [switch]$Register,
    [switch]$Unregister,
    [switch]$Status,
    [string]$TaskName
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

$registryPath = Join-Path $repoRoot 'config\managed-processes.json'
if (-not (Test-Path $registryPath)) { throw "Managed process registry not found: $registryPath" }
$registry = (Get-Content -Raw -Path $registryPath | ConvertFrom-Json).processes.'repo-sync'
if ($null -eq $registry) { throw 'Managed process registry has no repo-sync entry.' }

if ([string]::IsNullOrWhiteSpace($TaskName)) { $TaskName = $registry.taskName }
$entryPoint = Join-Path $repoRoot ($registry.entryPoint -replace '/', '\')
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source

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
    Write-Output "Repetition  : $($task.Triggers[0].Repetition.Interval)"
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

if (-not (Test-Path $entryPoint)) { throw "Sync entry point not found: $entryPoint" }

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw ('Registering an S4U scheduled task requires an elevated PowerShell (SeBatchLogonRight). ' +
        'Re-run this from an Administrator prompt. The interactive-logon alternative is refused on ' +
        'purpose: it would flash a console window every repetition, forever.')
}

# The interpreter is fixed; the SCRIPT's arguments come from the registry so
# this registrar cannot drift from the declared contract.
$scriptArgv = @($registry.declaredArgv | ForEach-Object {
    if ($_ -match '\s') { "`"$_`"" } else { $_ }
})
$arguments = (@("`"$entryPoint`"") + $scriptArgv) -join ' '

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument $arguments -WorkingDirectory $repoRoot

# AtStartup and AtLogOn give the cold-start guarantee; the repetition is the
# actual protected-main receive cadence. IgnoreNew makes a firing during a slow
# fetch/containment check a no-op.
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
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -Hidden

$description = ('ToolsEnabled protected-main receiver (R1120/R1122/R1162). Fetches with prune, verifies ' +
    'advertised-ref single-copy state, and only fast-forwards a clean dedicated main checkout with ' +
    '--ff-only. It never publishes, auto-merges, rebases, resets, or pushes; dirty, ahead, diverged, ' +
    'stale, or unknown state stops fail-closed. State: state\repo-sync.json. Stop file: state\repo-sync.stop.')

# With the switch off the task is registered but not runnable: the cadence
# trigger would otherwise restart the service minutes after every boot.
if (-not (Test-ToolsEnabledTaskShouldBeEnabled)) { $settings.Enabled = $false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings -Description $description -Force | Out-Null
Write-Output "Registered '$TaskName' (every $($registry.repetitionMinutes) minutes, S4U, hidden)."
Show-Status
