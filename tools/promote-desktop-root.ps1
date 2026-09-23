#requires -Version 5.1
<#
  Makes the OneDrive Desktop ToolsEnabled path the physical repository folder.
  C:\ToolsEnabled-live becomes a compatibility junction to that folder so
  current tools that still resolve the old path continue to work.

  Default mode is read-only. Use -Execute only after the preflight reports OK.
#>
[CmdletBinding()]
param([switch]$Execute)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The OneDrive Desktop checkout, derived from the RUNNING USER instead of a
# hardcoded 'C:\Users\<owner>\...'. A literal username makes this script
# unrunnable by anyone else, which is the stranger-install defect this sweep
# exists to remove.
#
# DERIVED, THEN VALIDATED -- NOT TRUSTED. This script is an elevated one:
# Disable/Stop-ScheduledTask against S4U tasks and Stop-Process -Force both
# require it. $env:USERPROFILE lives in the process environment block and is
# writable by whoever launched us, and an earlier lane in this sweep shipped a
# root derived from that variable with NO validation -- a security regression,
# because the value flows straight into [IO.Directory]::Delete, Move-Item and
# New-Item -ItemType Junction below. A poisoned variable would aim those three
# at an attacker-chosen directory with administrator rights.
#
# So: the profile comes from the USER TOKEN via GetFolderPath, which resolves
# from the logon session rather than reading the environment block at all; the
# environment variable is then only cross-checked, never used as the source.
function Resolve-OwnerDesktopRoot {
  $profileRoot = [Environment]::GetFolderPath('UserProfile')
  if ([string]::IsNullOrWhiteSpace($profileRoot)) {
    throw 'PROFILE_UNRESOLVED: the logon token exposed no profile directory; refusing to guess one.'
  }
  # Reject anything that is not a plain, rooted, local path before it is joined.
  if (-not [IO.Path]::IsPathRooted($profileRoot)) { throw "PROFILE_NOT_ROOTED: '$profileRoot'." }
  if ($profileRoot.StartsWith('\\')) { throw "PROFILE_IS_UNC: '$profileRoot'; refusing a remote profile root." }
  if ($profileRoot.IndexOfAny([IO.Path]::GetInvalidPathChars()) -ge 0) { throw "PROFILE_INVALID_CHARS: '$profileRoot'." }
  $normalized = [IO.Path]::GetFullPath($profileRoot).TrimEnd('\')
  # GetFullPath collapses '..' and redundant separators. If normalizing changed
  # the value, the variable was not a clean path and we do not proceed on it.
  if ($normalized -cne $profileRoot.TrimEnd('\')) {
    throw "PROFILE_NOT_NORMALIZED: '$profileRoot' normalizes to '$normalized'; refusing an unnormalized root."
  }
  if (-not (Test-Path -LiteralPath $normalized -PathType Container)) {
    throw "PROFILE_MISSING: '$normalized' is not an existing directory."
  }
  # Cross-check the environment block against the token. A mismatch is not
  # automatically an attack (runas, a service account, a redirected profile all
  # produce one), but this script mutates the tree with admin rights, so it
  # stops and makes a human look rather than silently preferring one of them.
  $fromEnvironment = $env:USERPROFILE
  if ($fromEnvironment -and ([IO.Path]::GetFullPath($fromEnvironment).TrimEnd('\') -ine $normalized)) {
    throw ("PROFILE_MISMATCH: `$env:USERPROFILE is '$fromEnvironment' but the logon token reports " +
      "'$normalized'. Refusing to promote a repository root while those two disagree.")
  }
  $resolved = [IO.Path]::GetFullPath((Join-Path $normalized 'OneDrive\Desktop\ToolsEnabled'))
  # Containment: the join must still land inside the validated profile.
  if (-not $resolved.ToLowerInvariant().StartsWith(($normalized + '\').ToLowerInvariant())) {
    throw "ROOT_ESCAPES_PROFILE: '$resolved' is not under '$normalized'."
  }
  return $resolved
}

$desktop = Resolve-OwnerDesktopRoot
$compat = 'C:\ToolsEnabled-live'
# Read from config/managed-processes.json, the taskName authority, instead of a
# second hardcoded copy of the same two scheduled-task names.
$repoRoot = Split-Path -Parent $PSScriptRoot
$registryHelper = Join-Path $repoRoot 'tools\lib\service-registry.ps1'
if (-not (Test-Path -LiteralPath $registryHelper -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $registryHelper
$dashboardService = Get-ServiceRegistryServiceById -Root $repoRoot -ServiceId 'dashboard'
if ([string]$dashboardService.resolution -cne 'loopback' -or [string]$dashboardService.transport -cne 'http') {
  throw 'SERVICE_REGISTRY_INVALID'
}
$dashboardPort = [int]$dashboardService.port
$managedRegistry = Get-Content -LiteralPath (Join-Path $repoRoot 'config\managed-processes.json') -Raw | ConvertFrom-Json
$taskNames = @($managedRegistry.processes.dashboard.taskName)

function Get-Listener([int]$Port) {
  @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

function Wait-NoListener([int]$Port, [int]$Seconds = 15) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (@(Get-Listener $Port).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return @(Get-Listener $Port).Count -eq 0
}

function Wait-Listener([int]$Port, [int]$Seconds = 30) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (@(Get-Listener $Port).Count -gt 0) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return @(Get-Listener $Port).Count -gt 0
}

function Stop-KnownListener([int]$Port, [string]$ExpectedFragment) {
  foreach ($listener in (Get-Listener $Port)) {
    $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $listener.OwningProcess)
    if ([string]$process.CommandLine -notmatch [regex]::Escape($ExpectedFragment)) {
      throw "Port $Port is owned by unexpected PID $($listener.OwningProcess); refusing to stop it."
    }
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction Stop
  }
}

function Get-HealthPayload([string]$Uri) {
  $raw = @(& curl.exe -sS --max-time 15 $Uri 2>$null)
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    return [pscustomobject]@{ Uri = $Uri; ProbeOk = $false; CurlExit = $exitCode; Status = $null; Online = $null; Error = "curl exited $exitCode" }
  }
  $text = ($raw -join "`n").Trim()
  if ([string]::IsNullOrWhiteSpace($text)) {
    return [pscustomobject]@{ Uri = $Uri; ProbeOk = $false; CurlExit = $exitCode; Status = $null; Online = $null; Error = 'empty response' }
  }
  try {
    $payload = $text | ConvertFrom-Json
    return [pscustomobject]@{ Uri = $Uri; ProbeOk = $true; CurlExit = $exitCode; Status = $payload.status; Online = $payload.online; Error = $null }
  } catch {
    return [pscustomobject]@{ Uri = $Uri; ProbeOk = $false; CurlExit = $exitCode; Status = $null; Online = $null; Error = 'invalid JSON response' }
  }
}

$desktopItem = Get-Item -LiteralPath $desktop -Force
$compatItem = Get-Item -LiteralPath $compat -Force
$tasks = @($taskNames | ForEach-Object { Get-ScheduledTask -TaskName $_ -ErrorAction Stop })
$taskSnapshot = @($tasks | ForEach-Object {
  [pscustomobject]@{
    Name = $_.TaskName
    WasEnabled = [bool]$_.Settings.Enabled
    WasRunning = ([string]$_.State -eq 'Running')
  }
})
$preflight = [pscustomobject]@{
  DesktopPath = $desktop
  DesktopLinkType = $desktopItem.LinkType
  DesktopTarget = ($desktopItem.Target -join ';')
  CompatibilityPath = $compat
  CompatibilityLinkType = $compatItem.LinkType
  GitHead = (& git -C $compat rev-parse HEAD)
  DirtyEntries = ((& git -C $compat status --porcelain | Measure-Object).Count)
  Tasks = $taskSnapshot
}
$preflight | ConvertTo-Json -Depth 4

if ($desktopItem.LinkType -eq $null -and $compatItem.LinkType -eq 'Junction' -and
    $compatItem.Target -contains $desktop) {
  Write-Output 'ALREADY PROMOTED: Desktop is physical and the compatibility junction is correct.'
  exit 0
}

if ($desktopItem.LinkType -ne 'Junction' -or $desktopItem.Target -notcontains $compat) {
  throw 'Desktop ToolsEnabled is not the expected compatibility junction; refusing to mutate it.'
}
if ($compatItem.LinkType) {
  throw 'C:\ToolsEnabled-live is already a link; refusing to replace an unknown topology.'
}
if (-not $Execute) {
  Write-Output 'DRY RUN OK. Re-run with -Execute to stop the two services and promote the Desktop folder.'
  exit 0
}

$promoted = $false
try {
  foreach ($task in $taskSnapshot) {
    if ($task.WasEnabled) { Disable-ScheduledTask -TaskName $task.Name | Out-Null }
    if ($task.WasRunning) { Stop-ScheduledTask -TaskName $task.Name }
  }

  if (-not (Wait-NoListener $dashboardPort)) { Stop-KnownListener $dashboardPort 'AgentActivityVisualizer\server\index.js' }
  if (-not (Wait-NoListener $dashboardPort)) {
    throw 'A managed listener did not stop; refusing to move the repository.'
  }

  # PowerShell 5.1 can throw NullReferenceException for a OneDrive-hosted
  # directory junction. Directory.Delete without recursion removes the link
  # object itself and never traverses into its verified target.
  [System.IO.Directory]::Delete($desktop)
  if (Test-Path -LiteralPath $desktop) { throw 'The Desktop junction remained after removal.' }
  Move-Item -LiteralPath $compat -Destination $desktop
  if ((Get-Item -LiteralPath $desktop -Force).LinkType) {
    throw 'The Desktop path did not become a physical directory.'
  }
  New-Item -ItemType Junction -Path $compat -Target $desktop | Out-Null
  if ((Get-Item -LiteralPath $compat -Force).Target -notcontains $desktop) {
    throw 'Compatibility junction verification failed.'
  }
  $promoted = $true
} catch {
  if (-not $promoted -and -not (Test-Path -LiteralPath $desktop) -and (Test-Path -LiteralPath $compat)) {
    New-Item -ItemType Junction -Path $desktop -Target $compat -ErrorAction SilentlyContinue | Out-Null
  }
  throw
} finally {
  foreach ($task in $taskSnapshot) {
    if ($task.WasEnabled) { Enable-ScheduledTask -TaskName $task.Name | Out-Null }
  }
  foreach ($task in $taskSnapshot) {
    if ($task.WasRunning) { Start-ScheduledTask -TaskName $task.Name }
  }
}

if (-not (Wait-Listener $dashboardPort)) {
  throw 'One or more managed listeners did not return after promotion.'
}

$probe = Join-Path $desktop ('.write-probe-' + [Guid]::NewGuid().ToString('N') + '.tmp')
[IO.File]::WriteAllText($probe, 'ok', [Text.Encoding]::UTF8)
Remove-Item -LiteralPath $probe -Force
$dashboard = Get-HealthPayload ("http://127.0.0.1:{0}/health" -f $dashboardPort)
[pscustomobject]@{
  DesktopIsPhysical = ((Get-Item -LiteralPath $desktop -Force).LinkType -eq $null)
  CompatibilityTarget = ((Get-Item -LiteralPath $compat -Force).Target -join ';')
  GitHead = (& git -C $desktop rev-parse HEAD)
  DirtyEntries = ((& git -C $desktop status --porcelain | Measure-Object).Count)
  WriteProbe = 'created-and-deleted'
  DashboardProbeOk = $dashboard.ProbeOk
  DashboardStatus = $dashboard.Status
  ProbeErrors = (@($dashboard.Error) | Where-Object { $_ }) -join '; '
} | ConvertTo-Json -Compress
