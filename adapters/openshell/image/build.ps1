param(
  [string]$Tag
)

# Build the same committed-source image as build.sh from a Windows host.
$ErrorActionPreference = 'Stop'
$repoRoot = (& git -C $PSScriptRoot rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) { throw 'This script needs a Git checkout.' }
$commit = (& git -C $repoRoot rev-parse --short=12 HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not read the source commit.' }
if (-not $Tag) { $Tag = "toolsenabled-openshell:windows-$commit" }
$docker = (Get-Command docker.exe -ErrorAction Stop).Source

$stage = Join-Path $repoRoot '.openshell-build'
[void][System.IO.Directory]::CreateDirectory($stage)
$archivePath = Join-Path $stage "source-$PID.tar"
try {
  & git -C $repoRoot archive --format=tar "--output=$archivePath" HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Could not archive committed source.' }

  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $docker
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  foreach ($argument in @('build', '--file', 'adapters/openshell/image/Dockerfile', '--tag', $Tag, '-')) {
    [void]$start.ArgumentList.Add($argument)
  }
  $build = [System.Diagnostics.Process]::Start($start)
  if (-not $build) { throw 'Docker build did not start.' }
  try {
    $archive = [System.IO.File]::OpenRead($archivePath)
    try { $archive.CopyTo($build.StandardInput.BaseStream) }
    finally { $archive.Dispose(); $build.StandardInput.Close() }
    $build.WaitForExit()
    if ($build.ExitCode -ne 0) { throw "Docker build failed with exit code $($build.ExitCode)." }
  } finally { $build.Dispose() }

  Write-Output "built $Tag from $commit"
} finally {
  if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
}
