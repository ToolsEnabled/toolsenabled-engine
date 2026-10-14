#requires -Version 5.1
<#
    Register, inspect, or remove the hidden Resource Alerts scheduled task.

    The task runs in the logged-in owner's Interactive session at Limited
    privilege.  Each invocation samples and evaluates once, then appends the
    bounded JSON result to logs\resource-alerts.log.  It does not register a
    task unless -Register is explicitly supplied.

    Usage:
      powershell -ExecutionPolicy Bypass -File tools\resource-alerts-task.ps1 -DryRun
      powershell -ExecutionPolicy Bypass -File tools\resource-alerts-task.ps1 -Status
      powershell -ExecutionPolicy Bypass -File tools\resource-alerts-task.ps1 -Register
      powershell -ExecutionPolicy Bypass -File tools\resource-alerts-task.ps1 -Unregister
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
$TaskName = 'ToolsEnabled Resource Alerts'
$operationCount = @($Register, $Unregister, $Status, $DryRun, $RunService).Where({ $_.IsPresent }).Count
if ($operationCount -gt 1) {
    throw 'Choose exactly one operation: Register, Unregister, Status, DryRun, or RunService.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = $MyInvocation.MyCommand.Path
$entryPoint = Join-Path $repoRoot 'tools\resource-alerts.js'
$logPath = Join-Path $repoRoot 'logs\resource-alerts.log'
$powerShellPath = Join-Path $PSHOME 'powershell.exe'
$ownerUser = ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)

function Quote-DisplayArgument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '"', '\"') + '"'
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

function Resolve-NodePath([string]$Candidate) {
    if ([string]::IsNullOrWhiteSpace($Candidate)) {
        $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
        if ($null -eq $nodeCommand -or [string]::IsNullOrWhiteSpace($nodeCommand.Source)) {
            throw 'node was not found on PATH during registration.'
        }
        $Candidate = $nodeCommand.Source
    }
    if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
        throw "Node executable not found: $Candidate"
    }
    return $Candidate
}

if ($RunService) {
    $resolvedNode = Resolve-NodePath $NodePath
    if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        throw "Resource alerts entry point not found: $entryPoint"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $writer = New-Object System.IO.StreamWriter($logPath, $true, $utf8)
    $serviceExitCode = 1
    try {
        & $resolvedNode $entryPoint '--sample' '--evaluate' 2>&1 | ForEach-Object {
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
    throw "Resource alerts entry point not found: $entryPoint"
}
if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) {
    throw "Windows PowerShell executable not found: $powerShellPath"
}
$NodePath = Resolve-NodePath $NodePath

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
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
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
$description = 'Samples local CPU and free RAM then evaluates coordinator-managed runtime resource-alert rules every five minutes.'

if ($DryRun) {
    Write-Output 'DRY RUN - no scheduled task was created, changed, started, or removed.'
    Write-Output "RESOURCE_ALERTS_COMMAND=$(Quote-DisplayArgument $NodePath) $(Quote-DisplayArgument $entryPoint) --sample --evaluate"
    Write-Output "TASK_ACTION=$powerShellPath $taskArgumentText"
    Write-Output "TASK_PRINCIPAL=$ownerUser LogonType=Interactive RunLevel=Limited"
    Write-Output 'TASK_SETTINGS=Hidden=True MultipleInstances=IgnoreNew RestartCount=3 RestartInterval=PT1M ExecutionTimeLimit=PT0S'
    Write-Output "REGISTER_COMMAND=Register-ScheduledTask -TaskName '$TaskName' -Action <TASK_ACTION> -Trigger <AtLogOn,PT5M> -Principal <Interactive:$ownerUser> -Settings <Hidden> -Description <resource-alerts> -Force"
    return
}

# With the switch off the task is registered but not runnable: the cadence
# trigger would otherwise restart the service minutes after every boot.
if (-not (Test-ToolsEnabledTaskShouldBeEnabled)) { $settings.Enabled = $false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings -Description $description -Force | Out-Null

Write-Output "Registered '$TaskName' (Interactive, Limited, hidden)."
Show-Status
