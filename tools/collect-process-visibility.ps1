<#
  Fixed, elevated, read-only Q39 collector.

  It has no parameters and is reachable only through the named UAC delegation
  allowlist operation.  The only machine reads are the bounded ToolsEnabled
  task names below and node.exe/powershell.exe process metadata.  It never
  starts, stops, edits, or registers a task.  It writes exactly one minimized
  snapshot through the Node writer, which revalidates and atomically replaces
  state\process-visibility.json.

  Keep ASCII-only for Windows PowerShell 5.1.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$writerPath = Join-Path $PSScriptRoot 'process-visibility-snapshot-writer.js'
$programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)

if (-not (Test-Path $writerPath)) { throw 'Process visibility snapshot writer was not found.' }
if ([string]::IsNullOrWhiteSpace($programFiles)) { throw 'the OS Program Files folder could not be resolved.' }
$nodePath = Join-Path $programFiles 'nodejs\node.exe'
if (-not (Test-Path $nodePath)) { throw 'the fixed Program Files node.exe was not found.' }

# Fixed coverage.  Adding a task requires a source review and a matching
# JS-target update; callers cannot ask the elevated helper to inspect another
# scheduler entry.
#
# The block below is GENERATED from src/lib/supervision/process-visibility-targets.js
# BASE_TASK_NAMES by tools/generate-mirrors.js, which is itself derived from
# config/managed-processes.json (every scheduled process with a taskName,
# except owner-host -- see the comment above BASE_TASK_NAMES for why). Hand-editing between the
# markers will be silently overwritten the next time the generator runs, and
# CI (`node tools/generate-mirrors.js --check`) fails on any drift in the
# meantime.
# GENERATE-MIRRORS:BEGIN process-visibility-task-names
# GENERATED -- do not edit. Produced by tools/generate-mirrors.js; edit the authority it reads, then re-run this script.
$TargetTaskNames = @(
  'ToolsEnabled Agent Digest',
  'ToolsEnabled Coordinator Duty Host',
  'ToolsEnabled Dashboard',
  'ToolsEnabled Fleet Supervisor',
  'ToolsEnabled FRA Keeper',
  'ToolsEnabled Health Observer',
  'ToolsEnabled Logs Retention',
  'ToolsEnabled Native Agent Worker',
  'ToolsEnabled Tunnel Bridge Keeper',
  'ToolsEnabled UAC Delegation Helper'
)
# GENERATE-MIRRORS:END process-visibility-task-names

function Test-SensitiveText {
  param([AllowNull()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
  return $Text -match '(?i)(password|passwd|secret|token|api[_-]?key|authorization|access[_-]?token|refresh[_-]?token)|AIza[\w-]{20,}|sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|ya29\.[\w-]{12,}'
}

function ConvertTo-SafeArgv {
  param([AllowNull()][string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
  # A whole-command redaction avoids trying to guess which later token is a
  # secret.  The JS contract repeats the credential check before persistence.
  if (Test-SensitiveText $Text) { return @('[redacted]') }
  $matches = [regex]::Matches($Text, '"([^"\\]|\\.)*"|''([^''\\]|\\.)*''|\S+')
  $result = @()
  foreach ($match in $matches) {
    $token = $match.Value.Trim(@([char]'"', [char]"'"))
    # MINIMIZE TO WHAT THE WRITER WILL ACCEPT.
    #
    # process-visibility-snapshot.js string() refuses any token that is empty,
    # longer than MAX_STRING (4096), or contains a control character
    # (U+0000-U+001F or U+007F). ONE bad token refuses the WHOLE snapshot, and
    # that refusal is fatal below, so nothing is written and every subsystem
    # reads UNKNOWN.
    #
    # MEASURED 2026-07-30: 55 of 106 in-scope processes on this machine carried
    # a control character in their command line. Every multi-line
    # powershell.exe -Command <script> produces one, and those are constant here
    # (agent tool calls, hooks, the observer's own probes). One process also
    # carried a 25,920-character token. The collector was therefore emitting
    # input the writer could never accept, so health observation had been blind
    # for every subsystem CONTINUOUSLY, not intermittently. Suppressing the
    # resulting UNKNOWN escalation storm treated the symptom; this is the cause.
    #
    # Sanitizing here rather than loosening the writer is deliberate: this file
    # is the minimizer, the writer is the contract, and a control character in
    # an observed argv carries no diagnostic value worth widening a validator
    # for.
    $token = [regex]::Replace($token, '[\x00-\x1F\x7F]', ' ')
    $token = $token.Trim()
    if ($token.Length -gt 4096) { $token = $token.Substring(0, 4093) + '...' }
    if (-not [string]::IsNullOrWhiteSpace($token)) { $result += $token }
  }
  return $result
}

$tasks = @()
foreach ($taskName in $TargetTaskNames) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    $tasks += [pscustomobject]@{ taskName = $taskName; state = 'NotFound'; executable = $null; argv = @(); workingDirectory = $null }
    continue
  }
  $action = @($task.Actions)[0]
  if ($null -eq $action) {
    $tasks += [pscustomobject]@{ taskName = $taskName; state = 'Unknown'; executable = $null; argv = @(); workingDirectory = $null }
    continue
  }
  $tasks += [pscustomobject]@{
    taskName = $taskName
    state = [string]$task.State
    executable = [string]$action.Execute
    argv = @(ConvertTo-SafeArgv ([string]$action.Arguments))
    workingDirectory = [string]$action.WorkingDirectory
  }
}

$processes = @()
$rows = @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='powershell.exe'" -ErrorAction Stop)
foreach ($row in $rows) {
  $startedAtMs = $null
  if ($row.CreationDate) {
    try { $startedAtMs = [DateTimeOffset]([System.Management.ManagementDateTimeConverter]::ToDateTime($row.CreationDate)).ToUniversalTime() }
    catch { $startedAtMs = $null }
    if ($null -ne $startedAtMs) { $startedAtMs = $startedAtMs.ToUnixTimeMilliseconds() }
  }
  $processes += [pscustomobject]@{
    pid = [int64]$row.ProcessId
    imageName = [string]$row.Name
    startedAtMs = $startedAtMs
    argv = @(ConvertTo-SafeArgv ([string]$row.CommandLine))
  }
}

$inputSnapshot = [pscustomobject]@{
  capturedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  tasks = $tasks
  processes = $processes
}

$result = $inputSnapshot | ConvertTo-Json -Compress -Depth 8 | & $nodePath $writerPath
if ($LASTEXITCODE -ne 0) { throw 'Process visibility snapshot writer refused the minimized collector output.' }
Write-Output $result
