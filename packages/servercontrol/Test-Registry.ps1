[CmdletBinding()]
param([string]$RegistryPath)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ServerRegistry.ps1')

$temporary=$false
if([string]::IsNullOrWhiteSpace($RegistryPath)){
  $livePath=Join-Path $PSScriptRoot 'servers.json'
  if(Test-Path -LiteralPath $livePath){ $RegistryPath=$livePath }
  else {
    $RegistryPath=Join-Path ([System.IO.Path]::GetTempPath()) ("servercontrol-registry-{0}.json" -f [guid]::NewGuid().ToString('N'))
    $temporary=$true
    $originalRegPath=$script:RegPath
    try { $script:RegPath=$RegistryPath; [void](Sync-Registry -Listeners @()) }
    finally { $script:RegPath=$originalRegPath }
  }
}

if(-not (Test-RegistryParity -RegistryPath $RegistryPath)){
  throw 'Registry parity smoke did not return success.'
}

# Exercise the real persistence setter against an isolated eight-row registry.
$settingsFixture=Join-Path ([System.IO.Path]::GetTempPath()) ("servercontrol-settings-{0}.json" -f [guid]::NewGuid().ToString('N'))
$settingsOriginal=$script:RegPath
try {
  $script:RegPath=$settingsFixture
  [void](Sync-Registry -Listeners @())
  $updated=Set-ServerLifecycleSettings -Port 3888 -Persistent $true -StartOnRestart $true -RunEnabled $false
  if(-not $updated){ throw 'Lifecycle settings write did not return the updated row.' }
  $persisted=@(Read-Registry | Where-Object { [int]$_.Port -eq 3888 }) | Select-Object -First 1
  if(-not $persisted -or -not [bool]$persisted.Persistent -or -not [bool]$persisted.StartOnRestart -or [bool]$persisted.RunEnabled){
    throw 'Lifecycle settings did not round-trip all three independent fields.'
  }
} finally {
  $script:RegPath=$settingsOriginal
  foreach($path in @($settingsFixture,($settingsFixture + '.candidates.json'))){
    if(Test-Path -LiteralPath $path){ Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  }
}

$originalRegPath=$script:RegPath
try {
  $script:RegPath=$RegistryPath
  $rows=@(Read-Registry)
  foreach($row in $rows){
    foreach($field in @('Persistent','StartOnRestart','RunEnabled')){
      if(-not $row.PSObject.Properties[$field]){
        throw "Lifecycle field '$field' is missing from port $($row.Port)."
      }
    }
  }
} finally {
  $script:RegPath=$originalRegPath
  if($temporary){
    foreach($path in @($RegistryPath,($RegistryPath + '.candidates.json'))){
      if(Test-Path -LiteralPath $path){ Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  }
}

Write-Output 'Server registry parity and settings round-trip passed (8 curated ports; 3 lifecycle fields).'
