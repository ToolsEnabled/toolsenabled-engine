#requires -Version 5.1
<#
    Register the hidden, interactive Agent Sweep scheduled task.

    The sweep is one bounded Node invocation every ten minutes. It must use
    the logged-in owner's Interactive token: Codex child processes cannot be
    respawned from S4U/session-0 parents. Both Node output streams are always
    appended to logs\agent-sweep.log so a failed wakeup has evidence.

    Usage:
      powershell -ExecutionPolicy Bypass -File tools\agent-sweep-task.ps1 -DryRun
      powershell -ExecutionPolicy Bypass -File tools\agent-sweep-task.ps1 -Status
      powershell -ExecutionPolicy Bypass -File tools\agent-sweep-task.ps1 -Register
      powershell -ExecutionPolicy Bypass -File tools\agent-sweep-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
    [switch]$Register,
    [switch]$Unregister,
    [switch]$Status,
    [switch]$DryRun,
    [switch]$RunService,
    [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$taskNameParts = @('ToolsEnabled', 'Agent Sweep')
$TaskName = $taskNameParts -join ' '
$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = $MyInvocation.MyCommand.Path
$entryPoint = Join-Path $repoRoot 'tools\agent-sweep.js'
$logPath = Join-Path $repoRoot 'logs\agent-sweep.log'
$powerShellPath = Join-Path $PSHOME 'powershell.exe'
$ownerUser = ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)

$operationCount = @($Register, $Unregister, $Status, $DryRun, $RunService).Where({ $_.IsPresent }).Count
if ($operationCount -gt 1) {
    throw 'Choose exactly one operation: Register, Unregister, Status, DryRun, or RunService.'
}

function Quote-DisplayArgument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Resolve-NodePath {
    param([string]$Candidate)
    if (-not [string]::IsNullOrWhiteSpace($Candidate)) {
        if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
            throw "Node executable not found: $Candidate"
        }
        return $Candidate
    }
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand -or [string]::IsNullOrWhiteSpace($nodeCommand.Source)) {
        throw 'node was not found on PATH during registration.'
    }
    if (-not (Test-Path -LiteralPath $nodeCommand.Source -PathType Leaf)) {
        throw "Node executable not found: $($nodeCommand.Source)"
    }
    return $nodeCommand.Source
}

function Get-SweepArguments {
    # The Node entrypoint resolves the enabled role-defined root through the
    # installed organisation store on every pass. Registration-time role ids
    # go stale when the operator edits a role or moves the root seat.
    return @($entryPoint, '--auto-wake', 'checkpointed')
}

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

function Get-ElevatedRegisterCommand {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath, '-Register')
    return ('powershell.exe ' + (($arguments | ForEach-Object { Quote-DisplayArgument $_ }) -join ' '))
}

if ($RunService) {
    if ([string]::IsNullOrWhiteSpace($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        throw 'RunService requires the absolute registered Node executable path.'
    }
    if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        throw "Agent sweep entry point not found: $entryPoint"
    }
    $sweepArguments = Get-SweepArguments
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $writer = New-Object System.IO.StreamWriter($logPath, $true, $utf8)
    $serviceExitCode = 1
    try {
        & $NodePath @sweepArguments 2>&1 | ForEach-Object {
            $writer.WriteLine($_.ToString())
            $writer.Flush()
        }
        $serviceExitCode = $LASTEXITCODE
    } finally {
        $writer.Dispose()
    }
    exit $serviceExitCode
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

if ($Status -and -not $Register -and -not $DryRun) {
    Show-Status
    return
}

if (-not $Register -and -not $DryRun) {
    Show-Status
    return
}

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "Agent sweep entry point not found: $entryPoint"
}
if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) {
    throw "Windows PowerShell executable not found: $powerShellPath"
}
if ([string]::IsNullOrWhiteSpace($ownerUser) -or $ownerUser -eq '\') {
    throw 'Interactive task owner identity is unavailable.'
}
$NodePath = Resolve-NodePath -Candidate $NodePath
$sweepArguments = Get-SweepArguments

$taskArguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', $scriptPath,
    '-RunService',
    '-NodePath', $NodePath
)
$taskArgumentText = ($taskArguments | ForEach-Object { Quote-DisplayArgument $_ }) -join ' '
$action = New-ScheduledTaskAction -Execute $powerShellPath -Argument $taskArgumentText -WorkingDirectory $repoRoot
$repeating = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes 10) `
    -RepetitionDuration (New-TimeSpan -Days 9999)
. (Join-Path $PSScriptRoot 'lib\StartupPolicy.ps1')
# Boot and sign-in triggers come from the startup.services_at_logon switch
# (owner directive 2026-08-13), never from a literal in this file.
$triggers = New-ToolsEnabledTaskTriggers -Repeating $repeating -OwnerUser $ownerUser -IncludeLogon
$principal = New-ScheduledTaskPrincipal -UserId $ownerUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -Hidden
$description = 'ToolsEnabled bounded Agent Sweep. Interactive owner session, hidden, ten-minute recovery cadence, output appended to logs/agent-sweep.log.'

if ($DryRun) {
    $sweepCommand = (@($NodePath) + @($sweepArguments) | ForEach-Object { Quote-DisplayArgument $_ }) -join ' '
    Write-Output 'DRY RUN - no scheduled task was created, changed, started, or removed.'
    Write-Output "SWEEP_COMMAND=$sweepCommand"
    Write-Output "TASK_ACTION=$powerShellPath $taskArgumentText"
    Write-Output "TASK_PRINCIPAL=$ownerUser LogonType=Interactive RunLevel=Limited"
    Write-Output 'TASK_SETTINGS=Hidden=True MultipleInstances=IgnoreNew RestartCount=3 RestartInterval=PT1M ExecutionTimeLimit=PT0S'
    Write-Output "REGISTER_COMMAND=Register-ScheduledTask -TaskName '$TaskName' -Action <TASK_ACTION> -Trigger <AtLogOn,PT10M> -Principal <Interactive:$ownerUser> -Settings <Hidden> -Description <bounded> -Force"
    return
}

try {
    # With the switch off the task is registered but not runnable: the cadence
    # trigger would otherwise restart the service minutes after every boot.
    if (-not (Test-ToolsEnabledTaskShouldBeEnabled)) { $settings.Enabled = $false }
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
        -Principal $principal -Settings $settings -Description $description -Force | Out-Null
} catch {
    if ($_.Exception.Message -match '(?i)access is denied|0x80070005') {
        throw "Elevation required. Run this exact command elevated: $(Get-ElevatedRegisterCommand)"
    }
    throw
}

Write-Output "Registered '$TaskName' (Interactive, Limited, hidden, every 10 minutes)."
Show-Status
