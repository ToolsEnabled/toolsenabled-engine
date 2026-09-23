[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$contextPath = Join-Path $repoRoot 'docker\agent-sandbox'
. (Join-Path $PSScriptRoot 'Invoke-NativeHidden.ps1')

$dockerPath = (Get-Command docker.exe -ErrorAction Stop).Source
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$tagResult = Invoke-ToolsEnabledNativeHidden -FilePath $nodePath -ArgumentList @((Join-Path $repoRoot 'tools\lock-agent-sandbox-image.js'), '--image-tag') -WorkingDirectory $repoRoot
if ($tagResult.ExitCode -ne 0) { throw 'This installation could not identify its pinned sandbox image tag.' }
$imageTag = ($tagResult.Stdout | Out-String).Trim()
if ($imageTag -notmatch '^toolsenabled/agent-playwright-sandbox:1\.61\.0-v1-[a-f0-9]{20}-[a-f0-9]{20}$') {
  throw 'This installation returned an invalid sandbox image tag.'
}

function Invoke-DockerHidden {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $result = Invoke-ToolsEnabledNativeHidden -FilePath $dockerPath -ArgumentList $Arguments -WorkingDirectory $repoRoot
  if ($result.ExitCode -ne 0) {
    $detail = ($result.Stderr | Out-String).Trim()
    if ($detail.Length -gt 1000) { $detail = $detail.Substring($detail.Length - 1000) }
    throw "Docker command failed (exit $($result.ExitCode)). $detail"
  }
  return $result.Stdout
}

$serverJson = Invoke-DockerHidden @('version', '--format', '{{json .Server}}')
$server = $serverJson | ConvertFrom-Json
if ($null -eq $server) {
  throw 'Docker Desktop must be running before the pinned sandbox image can be pulled or built.'
}
if ($server.Os -ne 'linux' -or $server.Arch -ne 'amd64') {
  throw "The sandbox image requires a linux/amd64 Docker engine; observed $($server.Os)/$($server.Arch)."
}
$dockerMajor = [int]($server.Version.Split('.')[0])
if ($dockerMajor -lt 28) {
  throw 'Docker Engine 28 or newer is required for isolated bridge gateway mode.'
}

$info = Invoke-DockerHidden @('info', '--format', '{{json .}}') | ConvertFrom-Json
if ($info.MemoryLimit -ne $true -or $info.PidsLimit -ne $true) {
  throw 'Docker must support memory and PIDs limits before building the sandbox image.'
}

# Equivalent native command: docker build --pull --tag <image> <context>.
Invoke-DockerHidden @('build', '--pull', '--tag', $imageTag, $contextPath) | Out-Null

$lockResult = Invoke-ToolsEnabledNativeHidden -FilePath $nodePath -ArgumentList @((Join-Path $repoRoot 'tools\lock-agent-sandbox-image.js'), '--scoped') -WorkingDirectory $repoRoot
if ($lockResult.ExitCode -ne 0) {
  throw 'The built image could not be locked to its immutable local image ID.'
}
