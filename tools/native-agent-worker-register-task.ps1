# Registers the cold-start reconciler for the durable native-agent worker.
#
# The scheduled task runs the short reconcile entrypoint every two minutes;
# that entrypoint owns the create-only PID/start-time record and starts the
# detached worker only when absence is proved.  This is a normal background
# service, not an on-demand transport: startup.services_at_logon decides
# whether Windows may run its cadence after a reboot.  With the setting off the
# task remains registered but disabled, matching every other ordinary keeper.
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
if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
    throw "Managed process registry not found: $registryPath"
}
$registry = (Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json).processes.'native-agent-worker'
if ($null -eq $registry) { throw 'Managed process registry has no native-agent-worker entry.' }
$registeredTaskName = [string]$registry.taskName
if ([string]::IsNullOrWhiteSpace($registeredTaskName)) { throw 'NATIVE_AGENT_WORKER_TASK_NAME_MISSING' }
if (-not [string]::IsNullOrWhiteSpace($TaskName) -and $TaskName -cne $registeredTaskName) {
    throw 'NATIVE_AGENT_WORKER_TASK_NAME_OVERRIDE_REFUSED'
}
$TaskName = $registeredTaskName
$entryPoint = Join-Path $repoRoot ([string]$registry.entryPoint -replace '/', '\')
$scriptArgv = @($registry.declaredArgv | ForEach-Object {
    if ($_ -match '\s') { "`"$_`"" } else { $_ }
})
$arguments = ((@("`"$entryPoint`"") + $scriptArgv) -join ' ')

function Resolve-NativeAgentNode {
    $resolveNodeHelper = Join-Path $PSScriptRoot 'lib\resolve-node.ps1'
    if (-not (Test-Path -LiteralPath $resolveNodeHelper -PathType Leaf)) {
        throw 'NODE_22_19_OR_NEWER_MISSING'
    }
    . $resolveNodeHelper
    return (Resolve-ToolsEnabledNode -Root $repoRoot)
}

function Assert-RegisteredTaskCurrent {
    param(
        [Parameter(Mandatory)]$Task,
        [Parameter(Mandatory)][string]$NodePath
    )
    try {
        $registeredAction = @($Task.Actions)[0]
        $current = @($Task.Actions).Count -eq 1 -and
            [IO.Path]::GetFullPath([string]$registeredAction.Execute) -ieq [IO.Path]::GetFullPath($NodePath) -and
            [string]$registeredAction.Arguments -ceq $arguments -and
            [IO.Path]::GetFullPath([string]$registeredAction.WorkingDirectory) -ieq [IO.Path]::GetFullPath($repoRoot)
    } catch { $current = $false }
    if (-not $current) { throw 'NATIVE_AGENT_WORKER_TASK_STALE' }
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
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Unregistered '$TaskName'."
    } else {
        Write-Output "Task '$TaskName' was not registered."
    }
    return
}

if ($StartNow -and -not $Register) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { throw 'NATIVE_AGENT_WORKER_TASK_NOT_REGISTERED' }
    $nodePath = Resolve-NativeAgentNode
    Assert-RegisteredTaskCurrent -Task $task -NodePath $nodePath
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-Output "Started '$TaskName' once now."
    return
}

if ($Status -or (-not $Register)) {
    Show-Status
    if (-not $Register) { return }
}

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw "Native-agent reconcile entry point not found: $entryPoint"
}
$nodePath = Resolve-NativeAgentNode

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw ('Registering an S4U scheduled task requires an elevated PowerShell (SeBatchLogonRight). ' +
        'Re-run this from an Administrator prompt.')
}

$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $repoRoot

$repetitionMinutes = 0
if (-not [int]::TryParse([string]$registry.repetitionMinutes, [ref]$repetitionMinutes) -or
    $repetitionMinutes -lt 1 -or $repetitionMinutes -gt 60) {
    throw 'NATIVE_AGENT_WORKER_REPETITION_INVALID'
}
$repeating = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
    -RepetitionInterval (New-TimeSpan -Minutes $repetitionMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 9999)
. (Join-Path $PSScriptRoot 'lib\StartupPolicy.ps1')
$triggers = New-ToolsEnabledTaskTriggers -Repeating $repeating `
    -OwnerUser ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -IncludeStartup -IncludeLogon -RepoRoot $repoRoot

$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -Hidden `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -DontStopIfGoingOnBatteries:$false `
    -AllowStartIfOnBatteries:$false
$settings.Compatibility = 'Win7'
if (-not (Test-ToolsEnabledTaskShouldBeEnabled -RepoRoot $repoRoot)) { $settings.Enabled = $false }

$description = ('Keeps the ToolsEnabled native-agent durable claimant running. The task executes only ' +
    'the bounded reconcile; worker ownership remains in the PID/start-time record. Startup follows the ' +
    'startup.services_at_logon setting. Non-interactive, limited, and hidden.')
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings -Description $description -Force | Out-Null

$registered = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
Assert-RegisteredTaskCurrent -Task $registered -NodePath $nodePath
if ([string]$registered.Principal.LogonType -ne 'S4U' -or
    [string]$registered.Principal.RunLevel -ne 'Limited' -or
    -not [bool]$registered.Settings.Hidden -or
    [string]$registered.Settings.MultipleInstances -ne 'IgnoreNew') {
    throw 'NATIVE_AGENT_WORKER_TASK_VERIFICATION_FAILED'
}

Write-Output "Registered scheduled task '$TaskName' (S4U, hidden)."
Write-Output "Arguments   : $arguments"
if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-Output "Started '$TaskName' once now."
}
