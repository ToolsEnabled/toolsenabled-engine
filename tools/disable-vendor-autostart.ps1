<#
.SYNOPSIS
Disable the machine-wide autostart entries named in config\vendor-autostart.local.json.

.DESCRIPTION
OWNER DIRECTIVE 2026-08-13: "i dont want ANYTHING started on startup i fucking
hate startup[ programs", then the exact keep-set: "turn all these off except
ghelper, powertoys, lidtoggletray, duo, audio. and defender".

WHY THIS IS A SCRIPT AND NOT A COMMAND I HANDED OVER. The entries below live in
HKLM, the all-users Startup folder, and tasks registered by SYSTEM, so an
ordinary owner session gets Access Denied on every one. The repo already has an
elevation path for exactly this shape of problem -- the fixed-allowlist UAC
delegation helper (src\uac-delegation-helper.js) -- and it requires a FIXED
script with FIXED argv and no caller input. That is what this file is. It is
reached through the allowlist id `disable-vendor-autostart`; nothing about the
target list can be supplied by a caller at run time.

WHY THE LIST IS IN A .local.json. It contains this machine's account SID inside
the Zoom and Firefox task names. config\*.local.json is gitignored (.gitignore:16),
which keeps a personal SID out of a repository that ships. The script is the
shared, reviewable part; the machine's targets are not.

NOTHING IS UNINSTALLED AND NO RUNNING PROCESS IS STOPPED. Tasks are disabled,
HKLM Run values are renamed Disabled_<name>, and Startup shortcuts are moved to
Startup\Disabled\. Every change reverses by hand in one step.

.PARAMETER WhatIf
Report what would change and change nothing.
#>
[CmdletBinding()]
param([switch]$WhatIf)

$ErrorActionPreference = 'Continue'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$configPath = Join-Path $repoRoot 'config\vendor-autostart.local.json'

if (-not (Test-Path -LiteralPath $configPath)) {
    Write-Host "VENDOR_AUTOSTART_CONFIG_MISSING: $configPath"
    exit 1
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json

# The keep-set is enforced, not just documented. An entry the owner named as
# KEPT must never be disabled by a later edit to the target list -- a typo in a
# gitignored file should not be able to take out his 2FA or his audio.
$keep = @()
if ($config.PSObject.Properties.Name -contains 'keep') { $keep = @($config.keep) }
function Test-Protected([string]$name) {
    foreach ($k in $keep) { if ($name -and $k -and $name -like "*$k*") { return $true } }
    return $false
}

$results = @()
function Add-Result($item, $action, $detail) {
    $script:results += [pscustomobject]@{ Item = $item; Action = $action; Detail = $detail }
}

foreach ($full in @($config.tasks)) {
    if (-not $full) { continue }
    $leaf = Split-Path $full -Leaf
    if (Test-Protected $leaf) { Add-Result $leaf 'PROTECTED' 'named in keep; refusing'; continue }
    $path = Split-Path $full -Parent
    if (-not $path) { $path = '\' }
    if (-not $path.EndsWith('\')) { $path = "$path\" }
    try { $task = Get-ScheduledTask -TaskName $leaf -TaskPath $path -ErrorAction Stop }
    catch { Add-Result $leaf 'absent' 'no such task'; continue }
    if (-not $task.Settings.Enabled) { Add-Result $leaf 'already-off' ''; continue }
    if ($WhatIf) { Add-Result $leaf 'would-disable' ''; continue }
    try {
        Disable-ScheduledTask -TaskName $leaf -TaskPath $path -ErrorAction Stop | Out-Null
        if ((Get-ScheduledTask -TaskName $leaf -TaskPath $path).Settings.Enabled) { Add-Result $leaf 'FAILED' 'still enabled' }
        else { Add-Result $leaf 'disabled' '' }
    } catch { Add-Result $leaf 'FAILED' $_.Exception.Message.Trim() }
}

$runKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
foreach ($valueName in @($config.hklmRunValues)) {
    if (-not $valueName) { continue }
    if (Test-Protected $valueName) { Add-Result $valueName 'PROTECTED' 'named in keep; refusing'; continue }
    $props = Get-ItemProperty -Path $runKey -ErrorAction SilentlyContinue
    if (-not $props -or -not $props.PSObject.Properties[$valueName]) { Add-Result $valueName 'already-off' 'value absent'; continue }
    if ($WhatIf) { Add-Result $valueName 'would-disable' ''; continue }
    try {
        New-ItemProperty -Path $runKey -Name "Disabled_$valueName" -Value $props.$valueName -PropertyType String -Force -ErrorAction Stop | Out-Null
        Remove-ItemProperty -Path $runKey -Name $valueName -Force -ErrorAction Stop
        Add-Result $valueName 'disabled' "renamed Disabled_$valueName"
    } catch { Add-Result $valueName 'FAILED' $_.Exception.Message.Trim() }
}

$startup = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\Startup'
$parked = Join-Path $startup 'Disabled'
foreach ($linkName in @($config.allUsersStartupLinks)) {
    if (-not $linkName) { continue }
    if (Test-Protected $linkName) { Add-Result $linkName 'PROTECTED' 'named in keep; refusing'; continue }
    $link = Join-Path $startup $linkName
    if (-not (Test-Path -LiteralPath $link)) { Add-Result $linkName 'already-off' 'not present'; continue }
    if ($WhatIf) { Add-Result $linkName 'would-disable' ''; continue }
    try {
        if (-not (Test-Path -LiteralPath $parked)) { New-Item -ItemType Directory -Path $parked -ErrorAction Stop | Out-Null }
        Move-Item -LiteralPath $link -Destination (Join-Path $parked $linkName) -Force -ErrorAction Stop
        Add-Result $linkName 'disabled' 'moved to Startup\Disabled'
    } catch { Add-Result $linkName 'FAILED' $_.Exception.Message.Trim() }
}

$results | Format-Table -AutoSize Item, Action, Detail | Out-String -Width 190 | Write-Host
$failed = @($results | Where-Object { $_.Action -eq 'FAILED' })
Write-Host ("disabled={0} already-off={1} protected={2} failed={3} total={4}" -f
    @($results | Where-Object { $_.Action -eq 'disabled' }).Count,
    @($results | Where-Object { $_.Action -eq 'already-off' }).Count,
    @($results | Where-Object { $_.Action -eq 'PROTECTED' }).Count,
    $failed.Count, $results.Count)
if ($failed.Count -gt 0) { exit 1 }
exit 0
