# Shared, side-effect-free host discovery for the ServerControl bundle.
#
# The same code bundle is deployed to both directly connected computers.  Only
# runtime state (servers.json, tunnel-state.json, logs, and power policy) remains
# machine-local.  Path discovery is intentionally limited to local fixed drives;
# opening the panel must never block on a dead UNC or mapped drive.

$script:ServerControlBundleVersion = '6.1.1'
$script:ServerControlBundleSchema = 'servercontrol.bundle.v1'

function Test-ServerControlFixedPath {
  param([string]$Path)
  if([string]::IsNullOrWhiteSpace($Path) -or $Path -like '\\*'){ return $false }
  $root=$null
  try { $root=[System.IO.Path]::GetPathRoot($Path) } catch { return $false }
  if(-not $root -or $root -notmatch '^[A-Za-z]:'){ return $false }
  try { return ((New-Object System.IO.DriveInfo($root)).DriveType -eq 'Fixed') } catch { return $false }
}

function Resolve-ServerControlCanonicalIdentityRoot {
  param([Parameter(Mandatory=$true)][string]$Path)
  if(-not (Test-ServerControlFixedPath -Path $Path)){ throw 'SERVICE_LOCAL_MACHINE_UNKNOWN' }
  try {
    $full=[IO.Path]::GetFullPath($Path)
    $pathRoot=[IO.Path]::GetPathRoot($full)
  } catch { throw 'SERVICE_LOCAL_MACHINE_UNKNOWN' }
  if([string]::IsNullOrWhiteSpace($pathRoot)){ throw 'SERVICE_LOCAL_MACHINE_UNKNOWN' }
  $cursor=$pathRoot
  $tail=$full.Substring($pathRoot.Length)
  foreach($segment in @($tail.Split([char]'\',[StringSplitOptions]::RemoveEmptyEntries))){
    $cursor=[IO.Path]::Combine($cursor,$segment)
    try { $item=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop }
    catch { throw 'SERVICE_LOCAL_MACHINE_UNKNOWN' }
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){
      throw 'SERVICE_LOCAL_MACHINE_UNKNOWN'
    }
  }
  try { $final=Get-Item -LiteralPath $full -Force -ErrorAction Stop }
  catch { throw 'SERVICE_LOCAL_MACHINE_UNKNOWN' }
  if(-not $final.PSIsContainer -or (($final.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){
    throw 'SERVICE_LOCAL_MACHINE_UNKNOWN'
  }
  if($full.Length -gt $pathRoot.Length){ return $full.TrimEnd('\') }
  return $pathRoot
}

function Get-ServerControlServiceRegistryHelperPath {
  param([Parameter(Mandatory=$true)][string]$ToolsEnabledRoot)
  $helper=Join-Path $ToolsEnabledRoot 'tools\lib\service-registry.ps1'
  if(-not (Test-Path -LiteralPath $helper -PathType Leaf)){ throw 'SERVICE_REGISTRY_UNAVAILABLE' }
  return $helper
}

function Get-ServerControlAddressContext {
  param([Parameter(Mandatory=$true)][string]$ToolsEnabledRoot)
  . (Get-ServerControlServiceRegistryHelperPath -ToolsEnabledRoot $ToolsEnabledRoot)
  $policy=Read-ToolsEnabledServiceRegistry -Root $ToolsEnabledRoot
  # Pure .NET: unlike Get-NetIPAddress this does not start a CIM/WMI provider on
  # the UI thread. Only registry-sanctioned IPv4 addresses are candidates.
  $found=@()
  try {
    foreach($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()){
      foreach($address in $nic.GetIPProperties().UnicastAddresses){
        $value=[string]$address.Address
        if($policy.addresses -ccontains $value -and $found -cnotcontains $value){ $found += $value }
      }
    }
  } catch { throw 'SERVICE_LOCAL_MACHINE_UNKNOWN' }
  if($found.Count -gt 1){ throw 'SERVICE_LOCAL_MACHINE_UNKNOWN' }
  $localMachine=if($found.Count -eq 1){ @($policy.machines | Where-Object { $_.address -ceq $found[0] })[0] }else{$null}
  # The registry helper was dot-sourced inside this function, so its functions
  # belong to this function scope and disappear when we return. Sort here while
  # Convert-ServiceRegistryIPv4ToUInt64 is actually available; calling it later
  # from Get-ServerControlHostProfile made every two-machine profile fail before
  # Mechanical Connect could assign a role.
  $directionalMachines=@($policy.machines | Sort-Object @{Expression={Convert-ServiceRegistryIPv4ToUInt64 -Address $_.address}})
  return [pscustomobject]@{
    Policy=$policy
    LocalMachine=$localMachine
    DirectionalMachines=$directionalMachines
  }
}

function Get-ServerControlDirectLinkAddress {
  param([Parameter(Mandatory=$true)][string]$ToolsEnabledRoot)
  $context=Get-ServerControlAddressContext -ToolsEnabledRoot $ToolsEnabledRoot
  if($context.LocalMachine){ return [string]$context.LocalMachine.address }
  return $null
}

function Get-ServerControlMachineIdFromPath {
  # The Ethernet address is authoritative while the link is up. This fallback
  # keeps A/B path selection deterministic when the cable or interface is down.
  $root=$PSScriptRoot
  $oneDriveDesktop=Join-Path $env:USERPROFILE 'OneDrive\Desktop'
  $plainDesktop=Join-Path $env:USERPROFILE 'Desktop'
  if($root.StartsWith('C:\agent-apps\ServerControl',[StringComparison]::OrdinalIgnoreCase) -or
     $root.StartsWith($oneDriveDesktop.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)){ return 'B' }
  if($root.StartsWith($plainDesktop.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)){ return 'A' }
  if($env:TOOLSENABLED_ROOT){
    $hint=[string]$env:TOOLSENABLED_ROOT
    if($hint.StartsWith($oneDriveDesktop.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)){ return 'B' }
    if($hint.StartsWith($plainDesktop.TrimEnd('\') + '\',[StringComparison]::OrdinalIgnoreCase)){ return 'A' }
  }
  return 'LOCAL'
}

function Resolve-ServerControlPath {
  param(
    [Parameter(Mandatory=$true)][string[]]$Candidates,
    [string[]]$RequiredChildren=@(),
    [switch]$Leaf
  )
  $fallback=$null
  foreach($candidate in @($Candidates)){
    if([string]::IsNullOrWhiteSpace($candidate)){ continue }
    $full=$null
    try { $full=[System.IO.Path]::GetFullPath($candidate) } catch { continue }
    if(-not (Test-ServerControlFixedPath $full)){ continue }
    if(-not $fallback){ $fallback=$full }
    $exists=if($Leaf){ Test-Path -LiteralPath $full -PathType Leaf }else{ Test-Path -LiteralPath $full -PathType Container }
    if(-not $exists){ continue }
    $valid=$true
    foreach($child in @($RequiredChildren)){
      if(-not (Test-Path -LiteralPath (Join-Path $full $child))){ $valid=$false; break }
    }
    if($valid){ return $full }
  }
  return $fallback
}

function Get-ServerControlHostProfile {
  param([ValidateSet('A','B','LOCAL')][string]$MachineId)
  # The legacy path classification is only a search-order hint. It must not
  # decide this computer's registry role: customer installs are not required
  # to put the lower-address machine on the plain Desktop or the higher one in
  # OneDrive/C:\agent-apps.
  $pathMachineId=if($MachineId){$MachineId}else{Get-ServerControlMachineIdFromPath}
  $resolvedMachineId=if($MachineId){$MachineId}else{'LOCAL'}
  $desktopOneDrive=Join-Path $env:USERPROFILE 'OneDrive\Desktop'
  $desktopPlain=Join-Path $env:USERPROFILE 'Desktop'

  $toolsCandidates=@()
  if($env:TOOLSENABLED_ROOT){ $toolsCandidates += [string]$env:TOOLSENABLED_ROOT }
  # THE INSTALL THIS FILE IS PART OF, BEFORE ANY GUESS ABOUT WHERE INSTALLS LIVE.
  #
  # Every candidate below this line is a guess at a conventional location:
  # Desktop\ToolsEnabled, OneDrive\Desktop\ToolsEnabled, C:\agent-apps\...,
  # C:\ToolsEnabled-live. A checkout that is not at one of those paths could not
  # be found at all, so this package threw SERVICE_REGISTRY_UNAVAILABLE while
  # sitting inside a perfectly good tree -- measured 2026-08-18 on the canonical
  # checkout at Desktop\engine-checkout, which is on none of the lists. The
  # scheduled task inherited the same failure and had never once run.
  #
  # This file is at <root>\packages\servercontrol\, so the root is two levels up
  # and needs no convention at all. That is how tools\fra-keeper-task.ps1 has
  # always resolved it. It also makes the package work from wherever a peer
  # extracts it, which is the difference between a setup that needs a documented
  # environment variable and one that just runs.
  #
  # $env:TOOLSENABLED_ROOT still wins, so an explicit override -- which the test
  # suite injects into every spawn -- keeps working unchanged.
  $selfRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  if($selfRoot){ $toolsCandidates += [string]$selfRoot }
  if($pathMachineId -eq 'A'){
    $toolsCandidates += @((Join-Path $desktopPlain 'ToolsEnabled'),(Join-Path $desktopOneDrive 'ToolsEnabled'))
  } else {
    $toolsCandidates += @((Join-Path $desktopOneDrive 'ToolsEnabled'),(Join-Path $desktopPlain 'ToolsEnabled'))
  }
  $toolsCandidates += @('C:\agent-apps\ToolsEnabled','C:\ToolsEnabled-live')
  $toolsEnabled=Resolve-ServerControlPath $toolsCandidates @('AGENTS.md','tools')

  # Address authority is the ToolsEnabled registry, including while the
  # configured interface is down. A missing or malformed registry is fatal;
  # it never degrades to the old subnet or to an unverified path guess.
  $addressContext=Get-ServerControlAddressContext -ToolsEnabledRoot $toolsEnabled
  $policy=$addressContext.Policy
  $localMachine=$addressContext.LocalMachine
  $directionalMachines=@($addressContext.DirectionalMachines)
  if($directionalMachines.Count -notin @(1,2)){ throw 'SERVICE_PEER_UNDETERMINED' }
  # A registry root is the authoritative offline identity when the direct-link
  # interface is down. Require one exact match, and refuse a disagreement with
  # a live address match instead of letting install-path folklore choose a peer.
  $toolsEnabledFull=Resolve-ServerControlCanonicalIdentityRoot -Path $toolsEnabled
  $rootMatches=@()
  foreach($candidateMachine in @($policy.machines)){
    if([string]::IsNullOrWhiteSpace([string]$candidateMachine.root)){ continue }
    try { $candidateRoot=[IO.Path]::GetFullPath([string]$candidateMachine.root).TrimEnd('\') }
    catch { throw 'SERVICE_REGISTRY_INVALID' }
    if($candidateRoot.Equals($toolsEnabledFull,[StringComparison]::OrdinalIgnoreCase)){ $rootMatches += $candidateMachine }
  }
  if($rootMatches.Count -gt 1){ throw 'SERVICE_LOCAL_MACHINE_UNKNOWN' }
  $rootMachine=if($rootMatches.Count -eq 1){$rootMatches[0]}else{$null}
  if($localMachine -and $rootMachine -and $localMachine.machineId -cne $rootMachine.machineId){
    throw 'SERVICE_LOCAL_MACHINE_UNKNOWN'
  }
  $identityMachine=if($localMachine){$localMachine}else{$rootMachine}
  $directionalMachineId=if($identityMachine -and $directionalMachines.Count -eq 2 -and $identityMachine.machineId -ceq $directionalMachines[0].machineId){'A'}elseif($identityMachine -and $directionalMachines.Count -eq 2 -and $identityMachine.machineId -ceq $directionalMachines[1].machineId){'B'}else{'LOCAL'}
  if($directionalMachineId -ne 'LOCAL'){
    if($MachineId){
      # An explicit profile request is a read-only projection used by parity
      # checks and UI path selection. Never represent this host's address as
      # belonging to that other projected machine.
      if($MachineId -cne $directionalMachineId){ $localMachine=$null }
    }else{
      $resolvedMachineId=$directionalMachineId
    }
  }
  $registryMachineId=if($resolvedMachineId -eq 'A' -and $directionalMachines.Count -eq 2){[string]$directionalMachines[0].machineId}elseif($resolvedMachineId -eq 'B' -and $directionalMachines.Count -eq 2){[string]$directionalMachines[1].machineId}else{$null}
  $configuredMachine=@(if($registryMachineId){ $policy.machines | Where-Object { $_.machineId -ceq $registryMachineId } })
  if($registryMachineId -and $configuredMachine.Count -ne 1){ throw 'SERVICE_MACHINE_UNKNOWN' }
  $peerMachine=@(if($registryMachineId){ $policy.machines | Where-Object { $_.machineId -cne $registryMachineId } })
  if($registryMachineId -and $peerMachine.Count -ne 1){ throw 'SERVICE_PEER_UNDETERMINED' }
  $localIp=if($localMachine){[string]$localMachine.address}else{$null}

  $node=Resolve-ServerControlPath @(
    'C:\agent-apps\node-v22.19.0\node.exe',
    'C:\Program Files\nodejs\node.exe'
  ) -Leaf
  $python=Resolve-ServerControlPath @('C:\Python313\python.exe','C:\Python312\python.exe','C:\Python311\python.exe') -Leaf
  $visualizer=Resolve-ServerControlPath @(
    'C:\agent-apps\AgentActivityVisualizer',
    'C:\AgentActivityVisualizer',
    (Join-Path $desktopOneDrive 'AgentActivityVisualizer'),
    (Join-Path $desktopPlain 'AgentActivityVisualizer')
  ) @('server\index.js')
  $presentation=Resolve-ServerControlPath @(
    (Join-Path $desktopOneDrive 'Presentation'),
    (Join-Path $desktopPlain 'Presentation')
  ) @('suite\server.js')
  $portfolio=Resolve-ServerControlPath @(
    (Join-Path $desktopOneDrive 'Portfolio Dashboard'),
    (Join-Path $desktopPlain 'Portfolio Dashboard'),
    'C:\AtoB-staging\20260730-073902\runtime\Portfolio Dashboard'
  ) @('app\main.py')
  $mcnair=Resolve-ServerControlPath @(
    (Join-Path $desktopOneDrive 'McNair organizer'),
    (Join-Path $desktopPlain 'McNair organizer'),
    'C:\AtoB-staging\20260730-073902\runtime\McNair organizer'
  ) @('Start Organizer Review.bat')
  $leanQuest=Resolve-ServerControlPath @(
    (Join-Path $desktopOneDrive 'LEAN-Bench Quest'),
    (Join-Path $desktopPlain 'LEAN-Bench Quest')
  ) @('server.py')
  $topology=Resolve-ServerControlPath @(
    (Join-Path $desktopOneDrive 'Topology Games'),
    (Join-Path $desktopPlain 'Topology Games')
  )

  return [pscustomobject][ordered]@{
    Schema=$script:ServerControlBundleSchema
    BundleVersion=$script:ServerControlBundleVersion
    MachineId=$resolvedMachineId
    RegistryMachineId=$registryMachineId
    MachineLabel=if($resolvedMachineId -in @('A','B')){"MACHINE $resolvedMachineId"}else{'THIS PC'}
    LocalIp=$localIp
    ConfiguredIp=if($configuredMachine.Count -eq 1){[string]$configuredMachine[0].address}else{$null}
    PeerIp=if($peerMachine.Count -eq 1){[string]$peerMachine[0].address}else{$null}
    ToolsEnabledRoot=$toolsEnabled
    Node=$node
    Python=$python
    Visualizer=$visualizer
    Presentation=$presentation
    Portfolio=$portfolio
    McNair=$mcnair
    LeanQuest=$leanQuest
    Topology=$topology
    PowerShell=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
  }
}
