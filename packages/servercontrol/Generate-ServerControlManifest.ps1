[CmdletBinding()]
param(
  [string]$SourceRoot,
  [string]$OutputPath
)

$ErrorActionPreference='Stop'
if([string]::IsNullOrWhiteSpace($SourceRoot)){ $SourceRoot=$PSScriptRoot }
if([string]::IsNullOrWhiteSpace($OutputPath)){ $OutputPath=Join-Path $SourceRoot 'servercontrol.manifest.json' }
$SourceRoot=[System.IO.Path]::GetFullPath($SourceRoot)
$OutputPath=[System.IO.Path]::GetFullPath($OutputPath)
. (Join-Path $SourceRoot 'ServerControl.Common.ps1')

$allowlist=@(
  'AGENT-CARD.txt',
  'Aggregate-Servers.ps1',
  'Deploy-ServerControl.ps1',
  'Full-Remote-Access-Firewall.ps1',
  'Generate-ServerControlManifest.ps1',
  'Launch Control Panel.cmd',
  'Launch Control Panel.vbs',
  # The mechanical key rendezvous engine. One engine, both machines: the panel
  # resolves it as a sibling of itself ($PSScriptRoot) and renders "Auto-connect:
  # not installed" whenever it is absent, so a bundle that ships the panel but
  # not this file deploys a tray switch that can never arm. It dot-sources
  # ServerControl.Common.ps1 (also a bundle member, resolved as a sibling) and
  # shells tools/secrets.ps1 + tools/start-remote-agent-bridge.ps1, which are
  # resolved out of the ToolsEnabled repo root, NOT this bundle -- see the note
  # in Deploy-ServerControl usage; both degrade gracefully when absent.
  'Mechanical-Connect.ps1',
  'Panel-Watchdog.ps1',
  'PowerGuard.ps1',
  'README.txt',
  'Reaper.ps1',
  'Server-Control-Panel.ps1',
  'Server-Lifecycle.ps1',
  'ServerControl.Common.ps1',
  'ServerControl.ico',
  'ServerRegistry.ps1',
  'Start-Server-Hidden.ps1',
  'Start-Topology-Games.ps1',
  'Stop-ServerByPort.ps1',
  'Test-Registry.ps1',
  'Test-ServerControl.ps1',
  'Tunnel-Lifecycle.ps1'
)

$rows=@()
foreach($relative in @($allowlist | Sort-Object)){
  $path=Join-Path $SourceRoot $relative
  if(-not (Test-Path -LiteralPath $path -PathType Leaf)){ throw "Manifest input is missing: $relative" }
  $item=Get-Item -LiteralPath $path
  $rows += [pscustomobject][ordered]@{
    path=$relative.Replace('\','/')
    bytes=[int64]$item.Length
    sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

$manifest=[pscustomobject][ordered]@{
  schema='servercontrol.parity-manifest.v1'
  bundleVersion=$script:ServerControlBundleVersion
  fileCount=$rows.Count
  totalBytes=[int64](($rows | Measure-Object bytes -Sum).Sum)
  runtimeStateExcluded=@('servers.json','tunnel-state.json','power-policy.json','*.log','logs/**','panel-heartbeat.json','lifecycle-health.json')
  files=$rows
}

$parent=Split-Path -Parent $OutputPath
if($parent -and -not (Test-Path -LiteralPath $parent)){ New-Item -ItemType Directory -Path $parent -Force | Out-Null }
$temp="$OutputPath.$PID.tmp"
$json=(($manifest | ConvertTo-Json -Depth 8) -replace "`r`n","`n") + "`n"
$utf8NoBom=New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($temp,$json,$utf8NoBom)
Move-Item -LiteralPath $temp -Destination $OutputPath -Force

$manifestHash=(Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
[pscustomobject][ordered]@{
  ok=$true
  manifest=$OutputPath
  manifestSha256=$manifestHash
  bundleVersion=$manifest.bundleVersion
  fileCount=$manifest.fileCount
  totalBytes=$manifest.totalBytes
} | ConvertTo-Json -Compress
