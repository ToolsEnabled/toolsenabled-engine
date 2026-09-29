# Registers the customer-configured direct-link tunnel/bridge keeper.
#
# This is intentionally on demand. A fresh install has one loopback machine,
# no peer endpoints, and no pair tokens; it must remain off. Registration and
# every explicit start run the secret-free preflight first. Once configured,
# the resident supervisor stays alive through Task Scheduler restart-on-failure
# and returns at sign-in only when startup.services_at_logon is enabled.
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
$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$registryPath = Join-Path $repoRoot 'config\managed-processes.json'
if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
    throw 'MANAGED_PROCESS_REGISTRY_UNAVAILABLE'
}
$registry = (Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json).processes.'tunnel-bridge-keeper'
if ($null -eq $registry) { throw 'TUNNEL_BRIDGE_KEEPER_REGISTRY_MISSING' }
if ($registry.onDemand -ne $true -or $null -ne $registry.repetitionMinutes) {
    throw 'TUNNEL_BRIDGE_KEEPER_MUST_BE_ON_DEMAND'
}
$registeredTaskName = [string]$registry.taskName
if ([string]::IsNullOrWhiteSpace($registeredTaskName)) { throw 'TUNNEL_BRIDGE_KEEPER_TASK_NAME_MISSING' }
if (-not [string]::IsNullOrWhiteSpace($TaskName) -and $TaskName -cne $registeredTaskName) {
    throw 'TUNNEL_BRIDGE_KEEPER_TASK_NAME_OVERRIDE_REFUSED'
}
$TaskName = $registeredTaskName

$entryPoint = Join-Path $repoRoot ([string]$registry.entryPoint -replace '/', '\')
$preflight = Join-Path $repoRoot 'tools\tunnel-bridge-preflight.js'
$stopFile = Join-Path $repoRoot 'state\tunnel-bridge-supervisor.stop'
$windowsRoot = [Environment]::GetEnvironmentVariable('SystemRoot', 'Machine')
if ([string]::IsNullOrWhiteSpace($windowsRoot)) { $windowsRoot = $env:SystemRoot }
$windowsPowerShell = Join-Path $windowsRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$scriptArgv = @($registry.declaredArgv | ForEach-Object {
    if ($_ -match '\s') { "`"$_`"" } else { $_ }
})
$arguments = (@('-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-File', "`"$entryPoint`"") + $scriptArgv) -join ' '

function Assert-RegisteredTaskCurrent {
    param([Parameter(Mandatory)]$Task)
    try {
        $registeredAction = @($Task.Actions)[0]
        $current = @($Task.Actions).Count -eq 1 -and
            [IO.Path]::GetFullPath([string]$registeredAction.Execute) -ieq [IO.Path]::GetFullPath($windowsPowerShell) -and
            [string]$registeredAction.Arguments -ceq $arguments -and
            [IO.Path]::GetFullPath([string]$registeredAction.WorkingDirectory) -ieq $repoRoot
    } catch { $current = $false }
    if (-not $current) {
        throw 'TUNNEL_BRIDGE_KEEPER_TASK_STALE'
    }
}

function Start-VerifiedTunnelTask {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds(10)
    do {
        $currentTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        if ([string]$currentTask.State -eq 'Running') { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw 'TUNNEL_BRIDGE_KEEPER_START_UNVERIFIED'
}

function Stop-VerifiedTunnelTask {
    $currentTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $currentTask -or [string]$currentTask.State -ne 'Running') { return }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds(10)
    do {
        $currentTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($null -eq $currentTask -or [string]$currentTask.State -ne 'Running') { return }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw 'TUNNEL_BRIDGE_KEEPER_STOP_UNVERIFIED'
}

function Show-Status {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Output "Task '$TaskName' is not registered."
        return
    }
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
    Write-Output "Task        : $($task.TaskName)"
    Write-Output "State       : $($task.State)"
    Write-Output "Enabled     : $([bool]$task.Settings.Enabled)"
    Write-Output "LogonType   : $($task.Principal.LogonType)"
    Write-Output "RunLevel    : $($task.Principal.RunLevel)"
    Write-Output "Hidden      : $($task.Settings.Hidden)"
    Write-Output "Action      : $($task.Actions[0].Execute) $($task.Actions[0].Arguments)"
    Write-Output "LastRunTime : $($info.LastRunTime)"
    Write-Output "LastResult  : $($info.LastTaskResult)"
}

if ($Unregister) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-VerifiedTunnelTask
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        Write-Output "Unregistered '$TaskName'."
    } else {
        Write-Output "Task '$TaskName' was not registered."
    }
    return
}

if ($StopNow -and -not $Register) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $stopFile) -Force | Out-Null
    New-Item -ItemType File -Path $stopFile -Force | Out-Null
    Stop-VerifiedTunnelTask
    Write-Output "Stopped '$TaskName' and recorded the direct-link off state."
    return
}

if ($Status -or (-not $Register -and -not $StartNow)) {
    Show-Status
    return
}

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) { throw 'TUNNEL_BRIDGE_KEEPER_ENTRYPOINT_MISSING' }
if (-not (Test-Path -LiteralPath $preflight -PathType Leaf)) { throw 'TUNNEL_BRIDGE_PREFLIGHT_MISSING' }
if (-not (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf)) { throw 'WINDOWS_POWERSHELL_MISSING' }
$resolveNodeHelper = Join-Path $PSScriptRoot 'lib\resolve-node.ps1'
if (-not (Test-Path -LiteralPath $resolveNodeHelper -PathType Leaf)) { throw 'NODE_22_19_OR_NEWER_MISSING' }
. $resolveNodeHelper
$nodePath = Resolve-ToolsEnabledNode -Root $repoRoot

function Assert-TunnelBridgeReady {
    $raw = @(& $nodePath $preflight '--json' 2>$null) -join "`n"
    $exitCode = $LASTEXITCODE
    try { $readiness = $raw | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'TUNNEL_BRIDGE_PREFLIGHT_FAILED' }
    if ($exitCode -ne 0 -or $readiness.ok -ne $true) {
        $code = [string]$readiness.code
        if ($code -notmatch '^TUNNEL_BRIDGE_[A-Z0-9_]{3,80}$') { $code = 'TUNNEL_BRIDGE_PREFLIGHT_FAILED' }
        throw $code
    }
}

Assert-TunnelBridgeReady

if ($StartNow -and -not $Register) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { throw 'TUNNEL_BRIDGE_KEEPER_TASK_NOT_REGISTERED' }
    Assert-RegisteredTaskCurrent -Task $task
    if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile -Force -ErrorAction Stop }
    Start-VerifiedTunnelTask
    Write-Output "Started '$TaskName'."
    return
}

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw ('Registering an S4U scheduled task requires an elevated PowerShell ' +
        '(SeBatchLogonRight). Re-run this from an Administrator prompt.')
}

$action = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument $arguments -WorkingDirectory $repoRoot

. (Join-Path $PSScriptRoot 'lib\StartupPolicy.ps1')
$triggers = New-ToolsEnabledTaskTriggers -OnDemand -IncludeLogon `
    -OwnerUser ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -RepoRoot $repoRoot
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -Hidden
if (-not (Test-ToolsEnabledTaskShouldBeEnabled -OnDemand -RepoRoot $repoRoot)) { $settings.Enabled = $false }

$description = ('ToolsEnabled direct-link tunnel and bridge keeper. It is registered only after a ' +
    'validated two-computer service registry and two distinct local vault tokens exist. The task is ' +
    'resident and on demand; it has no cadence trigger, and gains a sign-in trigger only when the ' +
    'customer enables services at sign-in. Non-interactive, limited, and hidden.')
$registerArgs = @{
    TaskName = $TaskName
    Action = $action
    Principal = $principal
    Settings = $settings
    Description = $description
    Force = $true
}
if (@($triggers).Count -gt 0) { $registerArgs['Trigger'] = $triggers }
Register-ScheduledTask @registerArgs | Out-Null

$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Assert-RegisteredTaskCurrent -Task $registered
if ([string]$registered.Principal.LogonType -ne 'S4U' -or
    [string]$registered.Principal.RunLevel -ne 'Limited' -or
    -not [bool]$registered.Settings.Hidden -or
    [string]$registered.Settings.MultipleInstances -ne 'IgnoreNew') {
    throw 'TUNNEL_BRIDGE_KEEPER_TASK_VERIFICATION_FAILED'
}

Write-Output "Registered scheduled task '$TaskName' (on demand, S4U, hidden)."
Write-Output "Arguments   : $arguments"
if ($StartNow) {
    if (Test-Path -LiteralPath $stopFile) { Remove-Item -LiteralPath $stopFile -Force -ErrorAction Stop }
    Start-VerifiedTunnelTask
    Write-Output "Started '$TaskName'."
}
