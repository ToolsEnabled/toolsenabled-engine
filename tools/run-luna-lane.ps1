param(
  [Parameter(Mandatory = $true)][string]$PromptFile,
  [Parameter(Mandatory = $true)][string]$OutputFile,
  [Parameter(Mandatory = $true)][string]$StdoutFile,
  [Parameter(Mandatory = $true)][string]$StderrFile
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
foreach ($path in @($PromptFile, $OutputFile, $StdoutFile, $StderrFile)) {
  if (-not [System.IO.Path]::IsPathRooted($path)) {
    throw "Luna lane paths must be absolute"
  }
}

$prompt = [System.IO.File]::ReadAllText($PromptFile)
$codex = (Get-Command codex.exe -ErrorAction Stop).Source
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $codex
$psi.WorkingDirectory = $repo
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.Arguments = @(
  'exec', '--json', '--ephemeral', '--skip-git-repo-check',
  '--sandbox', 'read-only', '--cd', ('"' + $repo + '"'),
  '--model', 'gpt-5.6-luna', '-c', '"model_reasoning_effort=max"',
  '--output-last-message', ('"' + $OutputFile + '"'), '-'
) -join ' '

# Luna must use the signed-in Codex/ChatGPT subscription lane, never an API key.
$env:OPENAI_API_KEY = $null
$env:CODEX_API_KEY = $null

$process = New-Object System.Diagnostics.Process
$process.StartInfo = $psi
if (-not $process.Start()) { throw 'Unable to start codex Luna lane' }
$process.StandardInput.Write($prompt)
$process.StandardInput.Close()
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
$stderrTask = $process.StandardError.ReadToEndAsync()
if (-not $process.WaitForExit(1800000)) {
  # Kill the whole tree, not just codex.exe: a bare Kill() strands child
  # processes after timeout (same fix as run-luna-worktree-lane.ps1's
  # Stop-ProcessTree). taskkill runs hidden per the quiet-desktop order.
  try {
    $taskkill = Join-Path -Path ([Environment]::SystemDirectory) -ChildPath 'taskkill.exe'
    $killInfo = New-Object System.Diagnostics.ProcessStartInfo
    $killInfo.FileName = $taskkill
    $killInfo.Arguments = ('/PID {0} /T /F' -f $process.Id)
    $killInfo.UseShellExecute = $false
    $killInfo.CreateNoWindow = $true
    $killInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $killer = [System.Diagnostics.Process]::Start($killInfo)
    if ($null -ne $killer) { $killer.WaitForExit(15000) | Out-Null }
  } catch { }
  try { if (-not $process.HasExited) { $process.Kill() } } catch { }
  $process.WaitForExit()
  $stdout = $stdoutTask.Result
  $stderr = ($stderrTask.Result + "`nLUNA_LANE_TIMEOUT")
  [System.IO.File]::WriteAllText($StdoutFile, $stdout)
  [System.IO.File]::WriteAllText($StderrFile, $stderr)
  exit 124
}
$stdout = $stdoutTask.Result
$stderr = $stderrTask.Result

[System.IO.File]::WriteAllText($StdoutFile, $stdout)
[System.IO.File]::WriteAllText($StderrFile, $stderr)
exit $process.ExitCode
