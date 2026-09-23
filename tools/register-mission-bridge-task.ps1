#requires -Version 5.1
<#
    Register, inspect, or remove the hidden Mission Bridge scheduled task.

    The task uses the logged-in owner's Interactive token because app-spawned
    Codex processes require the same interactive parent context as Codex and
    Claude Code. The task remains Limited and Hidden. The task action re-enters
    this script in -RunService mode, which invokes Node without a visible shell
    and streams both output channels to logs\mission-bridge.log.

    There is deliberately no AtStartup trigger. An Interactive task cannot run
    before the owner logs on; AtLogOn plus the repeating recovery trigger is the
    honest application lifecycle.

    This file is ASCII-only for Windows PowerShell 5.1.

    Usage:
      powershell -ExecutionPolicy Bypass -File tools\register-mission-bridge-task.ps1 -DryRun
      powershell -ExecutionPolicy Bypass -File tools\register-mission-bridge-task.ps1 -Status
      powershell -ExecutionPolicy Bypass -File tools\register-mission-bridge-task.ps1 -Register
      powershell -ExecutionPolicy Bypass -File tools\register-mission-bridge-task.ps1 -Unregister
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
$TaskName = 'ToolsEnabled Mission Bridge'

$operationCount = @($Register, $Unregister, $Status, $DryRun, $RunService).Where({ $_.IsPresent }).Count
if ($operationCount -gt 1) {
    throw 'Choose exactly one operation: Register, Unregister, Status, DryRun, or RunService.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$scriptPath = $MyInvocation.MyCommand.Path
$entryPoint = Join-Path $repoRoot 'tools\mission-bridge.js'
$registryPath = Join-Path $repoRoot 'config\managed-processes.json'
$logPath = Join-Path $repoRoot 'logs\mission-bridge.log'
$powerShellPath = Join-Path $PSHOME 'powershell.exe'
$ownerUser = ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$browserOrigins = @(
    'http://localhost:4600',
    'http://127.0.0.1:4600'
)
$appOrigins = @(4601..4609 | ForEach-Object { "http://127.0.0.1:$_" })
$requiredOrigins = @($browserOrigins) + @($appOrigins)
$declaredArguments = @(
    '--origin', $browserOrigins[0],
    '--origin', $browserOrigins[1]
)
foreach ($appOrigin in $appOrigins) {
    $declaredArguments += @('--origin', $appOrigin)
}
$declaredArguments += @('--root', "canonical=$repoRoot")
$registryDeclarationError = $null

# The shared registry addition is proposal-only in this phase. Once the
# coordinator applies it, this registrar automatically uses that single argv
# declaration and refuses a mismatched task identity or entry point.
if (Test-Path -LiteralPath $registryPath -PathType Leaf) {
    $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
    $property = $registry.processes.PSObject.Properties['mission-bridge']
    if ($null -ne $property) {
        $managed = $property.Value
        if ($managed.taskName -ne $TaskName) {
            throw 'Managed process mission-bridge has an unexpected task name.'
        }
        if ($managed.entryPoint -ne 'tools/mission-bridge.js') {
            throw 'Managed process mission-bridge has an unexpected entry point.'
        }
        $entryPoint = Join-Path $repoRoot $managed.entryPoint
        $declaredArguments = @($managed.declaredArgv | ForEach-Object { [string]$_ })
        if ($declaredArguments -contains '--port') {
            $registryDeclarationError = 'Managed process mission-bridge must omit --port so the bounded 4610-4619 startup scan remains active.'
        } else {
            $declaredOrigins = @()
            for ($index = 0; $index -lt $declaredArguments.Count; $index++) {
                if ($declaredArguments[$index] -eq '--origin' -and $index + 1 -lt $declaredArguments.Count) {
                    $declaredOrigins += $declaredArguments[$index + 1]
                }
            }
            $missingOrigins = @($requiredOrigins | Where-Object { $declaredOrigins -notcontains $_ })
            if ($missingOrigins.Count -gt 0) {
                $registryDeclarationError = 'Managed process mission-bridge is missing one or more required bounded browser/app origins.'
            }
        }
    }
}

function Quote-DisplayArgument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Get-BridgeArguments {
    return @($entryPoint) + @($declaredArguments)
}

function Stop-StaleMissionBridgeListeners {
    $stalePids = @()
    foreach ($port in 4610..4619) {
        $expectedBaseUrl = "http://127.0.0.1:$port"
        try {
            $runtime = Invoke-RestMethod -Method Get -Uri "$expectedBaseUrl/v1/runtime" `
                -Headers @{ Origin = 'http://127.0.0.1:4600' } -TimeoutSec 1
        } catch {
            continue
        }
        $runtimePid = 0
        if ($runtime.ok -ne $true `
                -or [string]$runtime.baseUrl -ne $expectedBaseUrl `
                -or [int]$runtime.port -ne $port `
                -or -not [int]::TryParse([string]$runtime.pid, [ref]$runtimePid) `
                -or $runtimePid -le 0) {
            continue
        }
        try {
            Stop-Process -Id $runtimePid -Force -ErrorAction Stop
            $stalePids += $runtimePid
        } catch {
            throw "Verified stale Mission Bridge PID $runtimePid on loopback port $port could not be stopped."
        }
    }
    $deadline = (Get-Date).AddSeconds(5)
    foreach ($runtimePid in $stalePids) {
        while ((Get-Process -Id $runtimePid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 100
        }
        if (Get-Process -Id $runtimePid -ErrorAction SilentlyContinue) {
            throw "Verified stale Mission Bridge PID $runtimePid remained alive after stop."
        }
    }
    return @($stalePids)
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

if ($RunService) {
    if ($null -ne $registryDeclarationError) {
        throw $registryDeclarationError
    }
    if ([string]::IsNullOrWhiteSpace($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        throw 'RunService requires the absolute registered Node executable path.'
    }
    if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
        throw "Mission Bridge entry point not found: $entryPoint"
    }
    $reapedPids = @(Stop-StaleMissionBridgeListeners)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $writer = New-Object System.IO.StreamWriter($logPath, $true, $utf8)
    $serviceExitCode = 1
    $bridgeArguments = Get-BridgeArguments
    try {
        if ($reapedPids.Count -gt 0) {
            $writer.WriteLine("REAPED_STALE_MISSION_BRIDGE_PIDS=$($reapedPids -join ',')")
            $writer.Flush()
        }
        & $NodePath @bridgeArguments 2>&1 | ForEach-Object {
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

if ($null -ne $registryDeclarationError) {
    throw $registryDeclarationError
}

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "Mission Bridge entry point not found: $entryPoint"
}
if (-not (Test-Path -LiteralPath $powerShellPath -PathType Leaf)) {
    throw "Windows PowerShell executable not found: $powerShellPath"
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand -or [string]::IsNullOrWhiteSpace($nodeCommand.Source)) {
        throw 'node was not found on PATH during registration.'
    }
    $NodePath = $nodeCommand.Source
}
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw "Node executable not found: $NodePath"
}

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
$description = 'ToolsEnabled Mission Bridge on the bounded loopback range 4610-4619. Interactive owner session, hidden, bounded origins, owner-only runtime discovery.'

if ($DryRun) {
    $bridgeCommand = (@($NodePath) + @(Get-BridgeArguments) | ForEach-Object { Quote-DisplayArgument $_ }) -join ' '
    Write-Output 'DRY RUN - no scheduled task was created, changed, started, or removed.'
    Write-Output "BRIDGE_COMMAND=$bridgeCommand"
    Write-Output "TASK_ACTION=$powerShellPath $taskArgumentText"
    Write-Output "TASK_PRINCIPAL=$ownerUser LogonType=Interactive RunLevel=Limited"
    Write-Output 'TASK_SETTINGS=Hidden=True MultipleInstances=IgnoreNew RestartCount=3 RestartInterval=PT1M ExecutionTimeLimit=PT0S'
    Write-Output "REGISTER_COMMAND=Register-ScheduledTask -TaskName '$TaskName' -Action <TASK_ACTION> -Trigger <AtLogOn,PT5M> -Principal <Interactive:$ownerUser> -Settings <Hidden> -Description <bounded> -Force"
    return
}

# With the switch off the task is registered but not runnable: the cadence
# trigger would otherwise restart the service minutes after every boot.
if (-not (Test-ToolsEnabledTaskShouldBeEnabled)) { $settings.Enabled = $false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings -Description $description -Force | Out-Null

Write-Output "Registered '$TaskName' (Interactive, Limited, hidden)."
Show-Status
