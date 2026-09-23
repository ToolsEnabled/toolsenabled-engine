#requires -Version 5.1
<#
    Register (or remove) the Windows scheduled task that runs the ToolsEnabled
    UAC delegation helper ELEVATED, HIDDEN, and ON DEMAND.

    WHAT THIS IS FOR (owner-approved 2026-07-28). Windows UAC stays FULLY ON.
    This does not weaken any Windows security posture. Registering this task ONCE
    (the single elevation-prompting step below) lets the coordinator later run a
    FIXED, owner-authored set of elevated operations
    (config\uac-delegation-allowlist.json) without a UAC prompt reaching the
    owner for each one. Starting an already-registered task does not raise a UAC
    prompt; the one prompt is here, at registration, run by the owner.

    RUNLEVEL HIGHEST. The task principal runs with the full administrator token
    (-RunLevel Highest) so the helper can perform the allowlisted elevated
    operations. That is the ONLY elevation: the helper never elevates arbitrary
    work. Every operation it accepts is verified against the allowlist, gated by
    a per-boot token and the kill switch, and written to the signed audit ledger
    on both accept and refuse (src\lib\uac-delegation.js).

    ON DEMAND, NOT A SERVICE. There is deliberately NO trigger: the task cannot
    fire on startup, logon, or a schedule. It only runs when something calls
    Start-ScheduledTask (the coordinator, when it needs an allowlisted elevated
    op). The helper exits after an idle period, so it never lingers as a standing
    admin process.

    NO CONSOLE WINDOW (matches tools\fleet-supervisor-task.ps1 and
    tools\agent-digest-task.ps1). LogonType S4U -- "run whether user is logged on
    or not", no stored password -- runs in a NON-INTERACTIVE session that has no
    desktop to draw a console on. -Hidden is set as well, and every child process
    the helper spawns uses windowsHide:true, shell:false. Interactive-principal
    alternatives are refused on purpose: they would flash a console window, which
    the owner has repeatedly complained about (ledger R22).

    ELEVATION TO REGISTER. Registering an S4U principal needs SeBatchLogonRight,
    and -RunLevel Highest needs an elevated caller; so -Register must be run from
    an ELEVATED PowerShell. That is the intended single owner-run prompt.

    ASCII ONLY: PowerShell 5.1 on this machine mis-parses non-ASCII characters in
    .ps1 files. Keep every character in this file inside ASCII.

    Usage (from an elevated PowerShell for -Register):
      powershell -ExecutionPolicy Bypass -File tools\uac-delegation-task.ps1 -Register
      powershell -ExecutionPolicy Bypass -File tools\uac-delegation-task.ps1 -Status
      powershell -ExecutionPolicy Bypass -File tools\uac-delegation-task.ps1 -Unregister
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
$registry = (Get-Content -Raw -LiteralPath $registryPath | ConvertFrom-Json).processes.'uac-delegation-helper'
if ($null -eq $registry) { throw 'Managed process registry has no uac-delegation-helper entry.' }

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
    Write-Output "Triggers    : $($task.Triggers.Count)  (on-demand: expected 0)"
    Write-Output "Action      : $($task.Actions[0].Execute) $($task.Actions[0].Arguments)"
    Write-Output "LastRunTime : $($info.LastRunTime)"
    Write-Output "LastResult  : $($info.LastTaskResult)"
    Write-Output ''
    Write-Output "Start on demand: Start-ScheduledTask -TaskName '$TaskName'"
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

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) { throw "UAC delegation helper entry point not found: $entryPoint" }
. (Join-Path $PSScriptRoot 'lib\resolve-node.ps1')
$nodePath = Resolve-ToolsEnabledNode -Root $repoRoot
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'NODE_22_19_OR_NEWER_MISSING' }

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw ('Registering this task requires an elevated PowerShell (S4U needs SeBatchLogonRight and ' +
        '-RunLevel Highest needs an elevated caller). Re-run this from an Administrator prompt. This is ' +
        'the single intended owner-run UAC prompt; starting the task afterward does not prompt.')
}

$scriptArgv = @($registry.declaredArgv | ForEach-Object {
    if ($_ -match '\s') { "`"$_`"" } else { $_ }
})
$arguments = ((@("`"$entryPoint`"") + $scriptArgv) -join ' ')
$action = New-ScheduledTaskAction -Execute $nodePath -Argument $arguments -WorkingDirectory $repoRoot

# NO trigger on purpose: on-demand only. The coordinator starts it with
# Start-ScheduledTask when it needs an allowlisted elevated operation.
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -Hidden

$description = ('ToolsEnabled UAC delegation helper. Runs ELEVATED (RunLevel Highest), HIDDEN (S4U, ' +
    'non-interactive, no console), and ON DEMAND (no trigger). Serves a token-gated local named pipe ' +
    'that accepts ONLY operations from config\uac-delegation-allowlist.json; verifies a per-boot token, ' +
    'checks KILLSWITCH, and writes a signed audit event on both accept and refuse. Windows UAC stays ' +
    'fully on; this task is the single owner-authorised elevation.')

# -Force replaces atomically; see tools\agent-digest-task.ps1 for the incident.
# This matters most here: losing the UAC delegation task would remove the only
# elevated repair channel the control plane has.
Register-ScheduledTask -TaskName $TaskName -Action $action `
    -Principal $principal -Settings $settings -Description $description -Force | Out-Null

Write-Output "Registered scheduled task '$TaskName' (S4U, hidden, RunLevel Highest, on-demand / no trigger)."
Write-Output "It does NOT run now and has no trigger. Start it on demand with:"
Write-Output "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Output ''
Show-Status
