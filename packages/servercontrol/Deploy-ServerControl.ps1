[CmdletBinding()]
param(
  [string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$TargetRoot,
  [string]$ManifestPath,
  [switch]$Promote
)

$ErrorActionPreference='Stop'
if([string]::IsNullOrWhiteSpace($SourceRoot)){ $SourceRoot=$PSScriptRoot }
if([string]::IsNullOrWhiteSpace($ManifestPath)){ $ManifestPath=Join-Path $SourceRoot 'servercontrol.manifest.json' }
$SourceRoot=[System.IO.Path]::GetFullPath($SourceRoot)
$TargetRoot=[System.IO.Path]::GetFullPath($TargetRoot)
$ManifestPath=[System.IO.Path]::GetFullPath($ManifestPath)
. (Join-Path $SourceRoot 'ServerControl.Common.ps1')
$runtimeStateNames=@('servers.json','tunnel-state.json','power-policy.json','panel-heartbeat.json','lifecycle-health.json')

if(-not (Test-ServerControlFixedPath $TargetRoot)){ throw 'TargetRoot must be on a local fixed drive.' }
if((Split-Path -Leaf $TargetRoot) -cne 'ServerControl'){ throw 'TargetRoot leaf must be exactly ServerControl.' }
if($TargetRoot.TrimEnd('\').Equals($SourceRoot.TrimEnd('\'),[StringComparison]::OrdinalIgnoreCase)){ throw 'SourceRoot and TargetRoot must be different.' }
$sourcePrefix=$SourceRoot.TrimEnd('\') + '\'
$targetPrefix=$TargetRoot.TrimEnd('\') + '\'
if($TargetRoot.StartsWith($sourcePrefix,[StringComparison]::OrdinalIgnoreCase) -or $SourceRoot.StartsWith($targetPrefix,[StringComparison]::OrdinalIgnoreCase)){
  throw 'SourceRoot and TargetRoot must be disjoint directories.'
}
if(-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)){ throw 'Parity manifest is missing; generate it before validation or promotion.' }

$manifest=Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
if($manifest.schema -ne 'servercontrol.parity-manifest.v1'){ throw 'Unsupported parity manifest schema.' }
if([int]$manifest.fileCount -ne @($manifest.files).Count){ throw 'Manifest file count does not match its rows.' }

function Resolve-BundleFile([string]$root,[string]$relative){
  if([string]::IsNullOrWhiteSpace($relative) -or [System.IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)'){
    throw "Unsafe manifest path: $relative"
  }
  $native=$relative.Replace('/',[System.IO.Path]::DirectorySeparatorChar)
  $full=[System.IO.Path]::GetFullPath((Join-Path $root $native))
  $prefix=$root.TrimEnd('\') + '\'
  if(-not $full.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){ throw "Manifest path escapes the bundle root: $relative" }
  return $full
}

function Get-StatePresence([string]$root){
  $result=[ordered]@{}
  foreach($name in $runtimeStateNames){
    $path=Join-Path $root $name
    $result[$name]=[bool](Test-Path -LiteralPath $path -PathType Leaf)
  }
  return $result
}

$sourceRows=@()
foreach($row in @($manifest.files)){
  $relative=[string]$row.path
  $leaf=[System.IO.Path]::GetFileName($relative)
  if($leaf -in $runtimeStateNames -or $relative -match '(^|[\\/])deploy-backups([\\/]|$)'){
    throw "Runtime state or deployment backups cannot be manifest members: $relative"
  }
  $source=Resolve-BundleFile $SourceRoot $relative
  if(-not (Test-Path -LiteralPath $source -PathType Leaf)){ throw "Source bundle file is missing: $($row.path)" }
  $item=Get-Item -LiteralPath $source
  $hash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
  if($hash -cne [string]$row.sha256 -or [int64]$item.Length -ne [int64]$row.bytes){ throw "Source bundle does not match its manifest: $($row.path)" }
  $sourceRows += [pscustomobject]@{ Relative=[string]$row.path; Source=$source; Hash=$hash; Bytes=[int64]$item.Length }
}

$beforeState=Get-StatePresence $TargetRoot
$mismatches=@()
foreach($row in $sourceRows){
  $target=Resolve-BundleFile $TargetRoot $row.Relative
  if(-not (Test-Path -LiteralPath $target -PathType Leaf)){
    $mismatches += [pscustomobject]@{ path=$row.Relative; reason='missing'; actualSha256=$null; expectedSha256=$row.Hash }
    continue
  }
  $actual=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  if($actual -cne $row.Hash){ $mismatches += [pscustomobject]@{ path=$row.Relative; reason='hash_mismatch'; actualSha256=$actual; expectedSha256=$row.Hash } }
}

if(-not $Promote){
  [pscustomobject][ordered]@{
    ok=($mismatches.Count -eq 0)
    mode='validate-only'
    target=$TargetRoot
    bundleVersion=[string]$manifest.bundleVersion
    expectedFiles=$sourceRows.Count
    matchingFiles=$sourceRows.Count-$mismatches.Count
    mismatchCount=$mismatches.Count
    mismatches=$mismatches
    runtimeStateTouched=$false
  } | ConvertTo-Json -Depth 8 -Compress
  exit $(if($mismatches.Count -eq 0){0}else{2})
}

if(-not (Test-Path -LiteralPath $TargetRoot)){ New-Item -ItemType Directory -Path $TargetRoot -Force | Out-Null }
$manifestHash=(Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
$backupRoot=Join-Path $TargetRoot ('deploy-backups\{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmssfff'),$manifestHash.Substring(0,12))
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
$touched=@()
$stagedPaths=@()
$targetManifest=Join-Path $TargetRoot 'servercontrol.manifest.json'
$previousManifest=Join-Path $backupRoot 'servercontrol.manifest.previous.json'
$manifestExisted=Test-Path -LiteralPath $targetManifest -PathType Leaf
try {
  if($manifestExisted){ Copy-Item -LiteralPath $targetManifest -Destination $previousManifest -Force }
  foreach($row in $sourceRows){
    $target=Resolve-BundleFile $TargetRoot $row.Relative
    $targetParent=Split-Path -Parent $target
    if(-not (Test-Path -LiteralPath $targetParent)){ New-Item -ItemType Directory -Path $targetParent -Force | Out-Null }
    $existed=Test-Path -LiteralPath $target -PathType Leaf
    if($existed){
      $backup=Resolve-BundleFile $backupRoot $row.Relative
      $backupParent=Split-Path -Parent $backup
      if(-not (Test-Path -LiteralPath $backupParent)){ New-Item -ItemType Directory -Path $backupParent -Force | Out-Null }
      Copy-Item -LiteralPath $target -Destination $backup -Force
    }
    $newPath=$target + ".servercontrol-new-$PID"
    $stagedPaths += $newPath
    Copy-Item -LiteralPath $row.Source -Destination $newPath -Force
    $stagedHash=(Get-FileHash -LiteralPath $newPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if($stagedHash -cne $row.Hash){ throw "Staged hash mismatch: $($row.Relative)" }
    Move-Item -LiteralPath $newPath -Destination $target -Force
    $touched += [pscustomobject]@{ Relative=$row.Relative; Target=$target; Existed=$existed }
  }
  Copy-Item -LiteralPath $ManifestPath -Destination $targetManifest -Force

  $postMismatch=@()
  foreach($row in $sourceRows){
    $target=Resolve-BundleFile $TargetRoot $row.Relative
    $actual=(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if($actual -cne $row.Hash){ $postMismatch += $row.Relative }
  }
  if($postMismatch.Count -gt 0){ throw "Post-promotion hash mismatch: $($postMismatch -join ', ')" }
} catch {
  foreach($stagePath in $stagedPaths){
    if(Test-Path -LiteralPath $stagePath -PathType Leaf){ Remove-Item -LiteralPath $stagePath -Force -ErrorAction SilentlyContinue }
  }
  for($index=$touched.Count-1; $index -ge 0; $index--){
    $entry=$touched[$index]
    $backup=Resolve-BundleFile $backupRoot $entry.Relative
    if($entry.Existed -and (Test-Path -LiteralPath $backup)){ Copy-Item -LiteralPath $backup -Destination $entry.Target -Force }
    elseif(-not $entry.Existed -and (Test-Path -LiteralPath $entry.Target)){ Remove-Item -LiteralPath $entry.Target -Force }
  }
  if($manifestExisted -and (Test-Path -LiteralPath $previousManifest -PathType Leaf)){
    Copy-Item -LiteralPath $previousManifest -Destination $targetManifest -Force
  }elseif(-not $manifestExisted -and (Test-Path -LiteralPath $targetManifest -PathType Leaf)){
    Remove-Item -LiteralPath $targetManifest -Force
  }
  throw
}

$afterState=Get-StatePresence $TargetRoot
$stateChanged=@($beforeState.Keys | Where-Object { $beforeState[$_] -cne $afterState[$_] })

[pscustomobject][ordered]@{
  ok=$true
  mode='promote'
  target=$TargetRoot
  bundleVersion=[string]$manifest.bundleVersion
  manifestSha256=$manifestHash
  promotedFiles=$sourceRows.Count
  promotedBytes=[int64](($sourceRows | Measure-Object Bytes -Sum).Sum)
  backup=$backupRoot
  runtimeStateTouched=$false
  runtimeStatePresenceChangesObserved=$stateChanged
  panelRestarted=$false
} | ConvertTo-Json -Compress
