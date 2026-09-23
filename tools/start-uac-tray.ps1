# Non-elevated launcher for tools\uac-tray-controller.ps1 (Q96 / R1022).
#
# Deliberately NOT elevated and deliberately NOT a scheduled task here: the
# tray icon itself needs no admin rights (it only reads the registry until
# the owner clicks Toggle, at which point the toggle item pops its own
# `Start-Process -Verb RunAs` consent dialog). Logon-time autostart wiring
# (a scheduled task, config\managed-processes.json) is intentionally left OUT
# of this script -- that registry is Stage 1b scaffolding territory this
# change does not touch; run this manually, or from whatever process the
# owner chooses, whenever the icon should appear. Idempotent: running it
# again while the tray is already up is a no-op, same shape as
# the active direct-link controller's already_on result.
#
# ASCII only. PowerShell 5.1 misparses this file if it picks up non-ASCII
# punctuation such as an em dash.
#requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$TrayScript = Join-Path $PSScriptRoot 'uac-tray-controller.ps1'
$SystemPowerShell = [IO.Path]::GetFullPath('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')

function Get-RunningTrayProcess {
    # Match the persistent tray, not a short-lived elevated toggle child (that
    # invocation also names this script but carries -Elevated).
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue)
    $candidates = @()
    $unverifiable = $false
    foreach ($process in $processes) {
        $commandLine = [string]$process.CommandLine
        if ([string]::IsNullOrWhiteSpace($commandLine)) {
            $unverifiable = $true
            continue
        }
        if ($commandLine.IndexOf('uac-tray-controller.ps1', [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
            $commandLine.IndexOf('-Elevated', [StringComparison]::OrdinalIgnoreCase) -lt 0) {
            $candidates += $process
        }
    }
    if ($candidates.Count -ge 1) { return [int]$candidates[0].ProcessId }
    if ($unverifiable) { throw 'UAC_TRAY_PROCESS_UNVERIFIABLE' }
    return $null
}

try {
    if (-not (Test-Path -LiteralPath $TrayScript -PathType Leaf)) { throw 'UAC_TRAY_SCRIPT_MISSING' }

    $existingPid = Get-RunningTrayProcess
    if ($existingPid) {
        [ordered]@{
            schemaVersion = 'start-uac-tray.v1'
            generatedAt = (Get-Date).ToUniversalTime().ToString('o')
            action = 'already_running'
            pid = $existingPid
            secretValuesEmitted = $false
        } | ConvertTo-Json -Compress
        exit 0
    }

    # windowsHide + STA: WinForms needs STA (Windows PowerShell 5.1 defaults
    # to STA already, but this is explicit rather than relied upon), and a
    # console must never flash per STANDING-ORDERS.md's LOCAL-WORK class.
    $proc = Start-Process -FilePath $SystemPowerShell -WorkingDirectory $Root -WindowStyle Hidden `
        -ArgumentList @('-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', $TrayScript) `
        -PassThru

    Start-Sleep -Milliseconds 300
    [ordered]@{
        schemaVersion = 'start-uac-tray.v1'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        action = 'started'
        pid = [int]$proc.Id
        secretValuesEmitted = $false
    } | ConvertTo-Json -Compress
} catch {
    [ordered]@{
        schemaVersion = 'start-uac-tray.v1'
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
        action = 'start_failed'
        error = 'start_failed'
        errorCode = if ($_.Exception.Message) { $_.Exception.Message -replace '[^A-Za-z0-9_.-]', '_' } else { 'unknown' }
        secretValuesEmitted = $false
    } | ConvertTo-Json -Compress
    exit 1
}
