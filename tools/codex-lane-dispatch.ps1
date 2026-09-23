# R1186/R1187: dispatch one bounded Codex build lane in an isolated worktree.
# Claude directs; Codex executes (R1187). Every lane gets its own worktree so
# concurrent lanes cannot collide on files (SPAWN 0a anti-collision rule).
#
#   powershell -File tools/codex-lane-dispatch.ps1 -Lane p0-authf03 -Model gpt-5.6-terra -Brief scratch/briefs/p0-authf03.md -Base r1162/integration
#
# Output: the lane's last message at logs/codex-lanes/<Lane>.last.txt, full
# stream at logs/codex-lanes/<Lane>.jsonl, stderr at <Lane>.err.log.
# Console stays hidden (LOCAL-WORK rule 3: no window flashes).

param(
  [Parameter(Mandatory = $true)][string]$Lane,
  [Parameter(Mandatory = $true)][string]$Model,
  [Parameter(Mandatory = $true)][string]$Brief,
  [string]$Base = 'r1162/integration',
  [string]$Effort = 'max'
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

# WHERE LANE WORKTREES GO, AND WHY NOT BESIDE THE REPO.
#
# This was:
#   Join-Path (Split-Path -Parent (Split-Path -Parent $repo)) "Desktop\wt-$Lane"
# which walked two levels up from the checkout and then appended "Desktop"
# again. From the current layout that resolves to
# C:\Users\example\Desktop\Desktop\wt-<Lane> -- a directory that does not exist,
# because the checkout no longer sits one level deeper than it did when this
# was written. A path built by counting levels breaks the day anything moves.
#
# And the intended path was wrong too: Desktop is ITSELF a git repository, so
# a worktree placed beside the checkout lands INSIDE another repo, where its
# files show up in that repo's status and one `git add -A` sweeps a whole lane
# into an unrelated commit.
#
# So lanes live at a root that is deliberately outside every checkout, and the
# guard below refuses rather than trusting that it still is.
$LaneRoot = if ($env:TOOLSENABLED_LANE_ROOT) { $env:TOOLSENABLED_LANE_ROOT } else { 'C:\lanes' }
# NO `2>$null` HERE. This file already explains the trap twelve lines above and
# the guard walked straight into it: in PowerShell 5.1, redirecting a NATIVE exe's
# stderr wraps each line in an ErrorRecord, which under $ErrorActionPreference =
# 'Stop' THROWS -- and `git rev-parse --is-inside-work-tree` writes "fatal: not a
# git repository" to stderr in exactly the case this guard is built to ALLOW. So
# the redirect made the check fail on its success path and no lane could dispatch.
# Unredirected, stderr goes to the console where it belongs and $LASTEXITCODE is
# read from the exe itself, which is the only thing worth trusting here.
$insideRepo = & git -C $LaneRoot rev-parse --is-inside-work-tree
if ($LASTEXITCODE -eq 0 -and $insideRepo -eq 'true') {
  throw ("Lane root $LaneRoot is inside a git repository. A worktree placed there appears in that " +
         "repository's status, and one 'git add -A' commits an entire lane into it. Set " +
         "TOOLSENABLED_LANE_ROOT to a directory outside every checkout.")
}
if (-not (Test-Path $LaneRoot)) { New-Item -ItemType Directory -Path $LaneRoot -Force | Out-Null }
$wt = Join-Path $LaneRoot "wt-$Lane"
$branch = "r1186/$Lane"

$briefPath = Join-Path $repo $Brief
if (-not (Test-Path $briefPath)) { throw "Brief not found: $briefPath" }
$prompt = Get-Content $briefPath -Raw

# Worktree per lane; reuse if it already exists so a re-dispatch resumes.
if (-not (Test-Path $wt)) {
  # DO NOT `2>&1` A NATIVE EXE HERE. In PowerShell 5.1 that wraps every stderr
  # line in an ErrorRecord (NativeCommandError) and sets $? to $false EVEN WHEN
  # THE EXE RETURNED 0 -- and `git worktree add` writes "Preparing worktree ..."
  # to STDERR ON SUCCESS. Combined with $ErrorActionPreference = 'Stop' at the
  # top of this file, the previous line threw on a successful git call, so THIS
  # SCRIPT COULD NEVER DISPATCH A SINGLE LANE. Measured 2026-08-13: the worktree
  # and branch were both created and the script aborted anyway.
  #
  # That is very likely why the fleet has been idle while the plan of record
  # says four waves are running.
  #
  # $LASTEXITCODE is the exit code of the exe and is the only thing worth
  # reading here. stderr goes to the console, where it belongs.
  & git -C $repo worktree add -b $branch $wt $Base | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "worktree add failed for $Lane (git exit $LASTEXITCODE)" }
}

$logDir = Join-Path $repo 'logs\codex-lanes'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force $logDir | Out-Null }
$lastMsg = Join-Path $logDir "$Lane.last.txt"
$outLog = Join-Path $logDir "$Lane.jsonl"
$errLog = Join-Path $logDir "$Lane.err.log"

$codex = Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
if (-not (Test-Path $codex)) { $codex = 'codex' }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $codex
$psi.WorkingDirectory = $wt
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
# THE BRIEF IS PIPED IN ON STDIN AND MUST BE UTF-8. Without these three lines
# PowerShell writes the prompt in the console codepage, and codex refuses the
# whole lane with "Failed to read prompt from stdin: input is not valid UTF-8
# (invalid byte at offset N)". Measured 2026-08-13: offset 8 -- an em-dash in a
# brief's TITLE. Every document in this project is written with em-dashes, so in
# practice no brief could be dispatched at all.
#
# UTF8Encoding($false) = no BOM. A BOM at the head of the prompt is itself an
# invalid leading byte for the reader, so the obvious fix would have replaced one
# failure with another.
#
# StandardInputEncoding IS NOT AVAILABLE HERE. It was added in .NET Core 3.0;
# Windows PowerShell 5.1 runs on .NET Framework, where setting it throws
# "The property 'StandardInputEncoding' cannot be found on this object."
# (Learned the hard way -- that was the second failed dispatch tonight.)
#
# So the prompt is written as RAW UTF-8 BYTES straight to the base stream
# further down, which works on both runtimes. Output encodings ARE settable on
# .NET Framework and are set here so codex's own JSON comes back intact.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$psi.StandardOutputEncoding = $utf8NoBom
$psi.StandardErrorEncoding = $utf8NoBom
$psi.Arguments = @(
  'exec', '--json', '--skip-git-repo-check',
  '--sandbox', 'workspace-write', '--cd', ('"' + $wt + '"'),
  '--model', $Model, '-c', ('"model_reasoning_effort=' + $Effort + '"'),
  '--output-last-message', ('"' + $lastMsg + '"'), '-'
) -join ' '

# Subscription lane only, never an API key (owner R1178: "cli only").
$env:OPENAI_API_KEY = $null
$env:CODEX_API_KEY = $null

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $psi
if (-not $process.Start()) { throw "Unable to start codex lane $Lane" }
# RAW UTF-8 BYTES, not StandardInput.Write($prompt).
#
# The TextWriter uses the console codepage on .NET Framework, so a brief
# containing any non-ASCII character reached codex mangled and it refused the
# whole lane: "Failed to read prompt from stdin: input is not valid UTF-8
# (invalid byte at offset 8)" -- offset 8 being an em-dash in a brief's title.
# Every document in this project is written with em-dashes, so in practice no
# brief could be dispatched at all.
$promptBytes = [System.Text.Encoding]::UTF8.GetBytes($prompt)
$process.StandardInput.BaseStream.Write($promptBytes, 0, $promptBytes.Length)
$process.StandardInput.BaseStream.Flush()
$process.StandardInput.Close()

$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
# 45 minutes: a bounded lane that overruns is a failure to report, not to wait on.
if (-not $process.WaitForExit(2700000)) {
  try { & taskkill /PID $process.Id /T /F 2>&1 | Out-Null } catch { }
  $stdoutTask.Result | Out-File -FilePath $outLog -Encoding utf8
  $stderrTask.Result | Out-File -FilePath $errLog -Encoding utf8
  Write-Output "{`"lane`":`"$Lane`",`"ok`":false,`"reason`":`"LANE_TIMEOUT_2700000MS`",`"worktree`":`"$wt`"}"
  exit 3
}
$stdoutTask.Result | Out-File -FilePath $outLog -Encoding utf8
$stderrTask.Result | Out-File -FilePath $errLog -Encoding utf8

$changed = (& git -C $wt status --porcelain --untracked-files=all | Measure-Object -Line).Lines
Write-Output "{`"lane`":`"$Lane`",`"ok`":$(if ($process.ExitCode -eq 0) { 'true' } else { 'false' }),`"exitCode`":$($process.ExitCode),`"changedFiles`":$changed,`"worktree`":`"$wt`",`"branch`":`"$branch`",`"lastMessage`":`"$($lastMsg -replace '\\','/')`"}"
exit $process.ExitCode
