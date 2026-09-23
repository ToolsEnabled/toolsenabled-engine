#requires -Version 5.1
<#
    Register (or remove) the Windows scheduled task that keeps the agentic
    workflow digest running.

    WHY A SCHEDULED TASK AT ALL: the digest must survive a client session
    exiting and a machine rebooting. It is its own Node process calling the
    selected owner-delivery transport in-process, not a tool call behind an
    MCP session.

    WHY S4U: this machine has a standing complaint about console windows
    flashing. An Interactive logon type runs the task on the owner's desktop
    and pops a console. S4U ("run whether user is logged on or not", without
    storing a password) runs it in a non-interactive session with no window at
    all. Hidden is set as well, and nothing in the digest spawns a child
    process. Do not switch this principal to an interactive logon type.

    ELEVATION: registering an S4U principal needs the SeBatchLogonRight
    privilege, so -Register must be run from an ELEVATED PowerShell. Verified
    2026-07-28: a non-elevated Register-ScheduledTask with -LogonType S4U
    returns "Access is denied" (HRESULT 0x80070005) for both AtLogOn and
    AtStartup triggers, while the same registration with an interactive
    principal succeeds non-elevated. Taking the interactive path to avoid the
    UAC prompt would reintroduce the flashing console window, so it is
    deliberately not offered here. Run this once, elevated.

    ASCII ONLY: PowerShell 5.1 on this machine mis-parses non-ASCII characters
    in .ps1 files. Keep every character in this file inside ASCII.

    Usage (from an elevated PowerShell for -Register):
      powershell -ExecutionPolicy Bypass -File tools\agent-digest-task.ps1 -Register
      powershell -ExecutionPolicy Bypass -File tools\agent-digest-task.ps1 -Status
      powershell -ExecutionPolicy Bypass -File tools\agent-digest-task.ps1 -Unregister
#>
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
if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) { throw "Managed process registry not found: $registryPath" }
$registry = (Get-Content -Raw -Path $registryPath | ConvertFrom-Json).processes.'agent-digest'
if ($null -eq $registry) { throw 'Managed process registry has no agent-digest entry.' }

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
        Write-Output "Removed scheduled task '$TaskName'."
    } else {
        Write-Output "Task '$TaskName' was not registered."
    }
    return
}

if ($Status -or (-not $Register)) {
    Show-Status
    if (-not $Register) { return }
}

if (-not (Test-Path $entryPoint)) { throw "Digest entry point not found: $entryPoint" }
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

# The service owns its own 30-second tick, so the task only has to make sure a
# process exists. IgnoreNew means a boot trigger firing while the logon-trigger
# instance is already running is a no-op rather than a second sender.
if (-not ($registry.declaredArgv -contains '--serve')) {
    throw 'Refusing to register: config\managed-processes.json declares agent-digest without --serve, so the task would not run its service loop.'
}
$scriptArgv = @($registry.declaredArgv | ForEach-Object {
    if ($_ -match '\s') { "`"$_`"" } else { $_ }
})
$arguments = ((@("`"$entryPoint`"") + $scriptArgv) -join ' ')
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $repoRoot

. (Join-Path $PSScriptRoot 'lib\StartupPolicy.ps1')
# Boot and sign-in triggers come from the startup.services_at_logon switch
# (owner directive 2026-08-13), never from a literal in this file.
$triggers = New-ToolsEnabledTaskTriggers -OwnerUser ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -IncludeStartup -IncludeLogon

# S4U: run whether the owner is logged on or not, no stored password, and -- the
# point of this whole comment -- no interactive desktop session, so no console
# window ever appears.
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

$description = 'ToolsEnabled agentic-workflow digest. Own process; calls the selected owner-delivery transport in-process, not through an MCP session. Non-interactive by design.'

# -Force replaces atomically. Unregister-then-Register leaves NO task at all if
# the Register step throws, which is how the fleet supervisor and telegram
# bridge tasks went missing entirely on 2026-07-29.
# With the switch off the task is registered but not runnable: the cadence
# trigger would otherwise restart the service minutes after every boot.
if (-not (Test-ToolsEnabledTaskShouldBeEnabled)) { $settings.Enabled = $false }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Principal $principal -Settings $settings -Description $description -Force | Out-Null

Write-Output "Registered scheduled task '$TaskName' (S4U, hidden, at startup and at logon)."

# WHY THIS BLOCK EXISTS: AtStartup/AtLogOn triggers only fire on a FUTURE
# startup or logon event. Registering the task mid-session (the common case --
# nobody reboots or logs off just to install this) leaves it sitting at the
# "task has not yet run" sentinel (LastRunTime 12/30/1899 or 11/30/1999,
# LastTaskResult 267011) until whenever the machine next reboots or the owner
# next logs on, which may be days away. Found in production 2026-07-28: this
# task was correctly registered but sitting at exactly that sentinel, so a
# manually-started `node ... --serve` was carrying live delivery instead --
# which does not survive a reboot and is not tracked by this task's own
# IgnoreNew policy. Delivery must not depend on that coincidence, so kick the
# task once, right now, immediately after registration. This is additive, not
# a replacement: the AtStartup/AtLogOn triggers still provide the
# reboot/logon resilience the task was built for.
#
# Safe to call unconditionally, including if something is already running
# (e.g. started by hand, or a re-run of -Register): src/agent-digest.js takes
# an interprocess lock (src/lib/agent-digest/lock.js) before it ever touches
# the fired-slot store, so a second live process fails fast with a distinct
# non-zero exit code instead of racing the schedule and double-sending.
try {
    Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    Write-Output "Started '$TaskName' immediately so delivery does not wait for the next reboot or logon."
} catch {
    Write-Warning ("Registered '$TaskName' but the immediate start failed: $($_.Exception.Message) " +
        'It will still run at the next AtStartup/AtLogOn trigger.')
}

# Give Task Scheduler a moment to record the launch before reporting status,
# so -Register's own output reflects reality instead of the pre-start sentinel.
Start-Sleep -Seconds 2

Show-Status
