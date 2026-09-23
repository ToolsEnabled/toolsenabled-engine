# Opt-in direct-Ethernet tunnel/bridge controller for ServerControl.
# Secrets stay in the ToolsEnabled DPAPI vault and in child-process stdin;
# this file only persists booleans and non-sensitive health state.
[CmdletBinding()]
param(
  [ValidateSet('Status','EnableTunnel','DisableTunnel','EnableBridge','DisableBridge','EnableFullRemote','DisableFullRemote','Reconcile')]
  [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$StatePath = Join-Path $PSScriptRoot 'tunnel-state.json'
$commonScript=Join-Path $PSScriptRoot 'ServerControl.Common.ps1'
if(-not (Test-Path -LiteralPath $commonScript -PathType Leaf)){ throw 'ServerControl.Common.ps1 is missing.' }
. $commonScript
$HostProfile=Get-ServerControlHostProfile
$RepoRoot=$HostProfile.ToolsEnabledRoot
$StartBus = Join-Path $RepoRoot 'tools\start-link-bus.ps1'
$StartBridge = Join-Path $RepoRoot 'tools\start-remote-agent-bridge.ps1'
$BridgePeerStatus = Join-Path $RepoRoot 'tools\remote-bridge-peer-status.js'
$RelayStatus = Join-Path $RepoRoot 'tools\link-bus-peer-status.js'
$FullRemoteLifecycle = Join-Path $RepoRoot 'tools\full-remote-access-lifecycle.ps1'
$FullRemoteControl = Join-Path $RepoRoot 'tools\full-remote-access-control.ps1'
$FullRemoteStatePath = Join-Path $RepoRoot 'state\full-remote-access-state.json'
$FullRemoteStopPath = Join-Path $RepoRoot 'state\full-remote-access.stop'
$Node = $HostProfile.Node
$TaskName = 'ServerControl Tunnel Lifecycle'
$LegacyFraTaskName = 'ToolsEnabled FRA Lifecycle'
$MutexName = 'Global\ToolsEnabledDirectAccessLifecycle'

function Read-State {
  $state=$null
  if(Test-Path -LiteralPath $StatePath){ try { $state=(Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json) } catch {} }
  if(-not $state){
    $state=[pscustomobject]@{ TunnelEnabled=$false; BridgeEnabled=$false; FullRemoteEnabled=$false; LocalIp=$null; PeerIp=$null; PeerRelay=$false; PeerBridge=$false; LastStatus='off'; LastAttempt=$null; LastError=$null; TunnelError=$null; BridgeError=$null; FullRemoteError=$null }
  }
  if($state.PSObject.Properties.Name -notcontains 'FullRemoteEnabled'){
    $fraDesired=$false
    try {
      if(Test-Path -LiteralPath $FullRemoteStatePath -PathType Leaf){
        $fraState=Get-Content -Raw -LiteralPath $FullRemoteStatePath | ConvertFrom-Json
        $fraDesired=([string]$fraState.desiredState -eq 'enabled')
      } elseif(-not (Test-Path -LiteralPath $FullRemoteStopPath -PathType Leaf)) {
        # A missing legacy stop marker is not enough to opt in a fresh install.
        $fraDesired=$false
      }
    } catch { $fraDesired=$false }
    $state | Add-Member -NotePropertyName FullRemoteEnabled -NotePropertyValue $fraDesired
  }
  foreach($name in @('TunnelError','BridgeError','FullRemoteError')){
    if($state.PSObject.Properties.Name -notcontains $name){ $state | Add-Member -NotePropertyName $name -NotePropertyValue $null }
  }
  return $state
}
function Write-State($state){ $tmp="$StatePath.$PID.tmp"; ($state | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $tmp -Encoding UTF8; Move-Item -LiteralPath $tmp -Destination $StatePath -Force }
function Find-Link {
  $profile=Get-ServerControlHostProfile
  [pscustomobject]@{
    LocalIp=if($profile.LocalIp){[string]$profile.LocalIp}else{$null}
    PeerIp=if($profile.LocalIp -and $profile.PeerIp){[string]$profile.PeerIp}else{$null}
  }
}
function Test-Port([string]$hostName,[int]$port){
  if(-not $hostName){ return $false }
  $client=New-Object System.Net.Sockets.TcpClient
  try {
    $async=$client.BeginConnect($hostName,$port,$null,$null)
    if(-not $async.AsyncWaitHandle.WaitOne(800)){ return $false }
    $client.EndConnect($async)
    return [bool]$client.Connected
  } catch { return $false } finally { $client.Close() }
}
function Secret-Exists([ValidateSet('Tunnel','Bridge','FullRemote')][string]$Lane) {
  $key=switch($Lane){
    'Tunnel'{'custom.link_bus_bridge_token'}
    'Bridge'{'custom.remote_agent_bridge_token'}
    default{'custom.full_remote_access_token'}
  }
  try { & powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File (Join-Path $RepoRoot 'tools\secrets.ps1') verify $key *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}
function Get-PeerBridgeAuth([string]$peer) {
  if(-not $peer -or -not (Test-Path -LiteralPath $BridgePeerStatus)){ return $null }
  $priorPeer=$env:REMOTE_AGENT_BRIDGE_PEER
  try {
    $env:REMOTE_AGENT_BRIDGE_PEER=$peer
    $raw=& $Node $BridgePeerStatus 2>$null
    if($raw){ return ($raw|ConvertFrom-Json) }
  } catch {} finally {
    if($null -eq $priorPeer){ Remove-Item Env:REMOTE_AGENT_BRIDGE_PEER -ErrorAction SilentlyContinue }else{$env:REMOTE_AGENT_BRIDGE_PEER=$priorPeer}
  }
  return $null
}
function Start-Hidden([string]$file,[string[]]$argumentList,[hashtable]$env=@{}) {
  $psi=New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName=$file; $psi.Arguments=($argumentList | ForEach-Object { if($_ -match '[\s"]'){ '"'+($_ -replace '"','\"')+'"' } else { $_ } }) -join ' '; $psi.WorkingDirectory=$RepoRoot; $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.WindowStyle='Hidden'
  foreach($k in $env.Keys){ $psi.EnvironmentVariables[$k]=[string]$env[$k] }
  $p=New-Object System.Diagnostics.Process; $p.StartInfo=$psi; if($p.Start()){ return $p.Id }; return $null
}
function Get-ExpectedEntry([int]$port){
  switch($port){
    8787 { return (Join-Path $RepoRoot 'sidecars\link-bus\server.js') }
    8788 { return (Join-Path $RepoRoot 'src\remote-agent-bridge.js') }
    8791 { return (Join-Path $RepoRoot 'tools\remote-bridge-enroll-token.js') }
    8792 { return (Join-Path $RepoRoot 'tools\link-bus-enroll-token.js') }
    default { return $null }
  }
}
function Test-OwnedProcess($owner,[int]$port,[string]$pattern){
  if(-not $owner){ return $false }
  $allowedNodes=@(@($Node,'C:\Program Files\nodejs\node.exe','C:\agent-apps\node-v22.19.0\node.exe') | Where-Object { $_ } | Select-Object -Unique)
  $nodeOk=[bool]($allowedNodes | Where-Object { [string]$owner.ExecutablePath -ieq [string]$_ } | Select-Object -First 1)
  $entry=Get-ExpectedEntry $port
  $commandLine=[string]$owner.CommandLine
  # UNREADABLE IS NOT FOREIGN. An unelevated Win32_Process read returns an EMPTY
  # CommandLine for a process owned by another session -- every S4U scheduled
  # task. Once these lanes are task-managed that is the NORMAL reading, and
  # falling through to $false reports a healthy listener as down, which then
  # drives a restart of something that is already running.
  # Two agreeing positives are accepted in place of the unreadable field: the
  # executable is one of the allowed node binaries AND it holds the declared
  # port for this service. A foreign process satisfying both is a far narrower
  # risk than reporting every task-owned lane dead.
  if([string]::IsNullOrWhiteSpace($commandLine)){
    return [bool]($nodeOk -and $entry)
  }
  return [bool]($nodeOk -and $entry -and $commandLine -match $pattern -and
    ($commandLine).IndexOf([IO.Path]::GetFullPath($entry),[StringComparison]::OrdinalIgnoreCase) -ge 0)
}
function Ensure-Process([string]$localIp,[int]$port,[string]$pattern,[string]$script,[string[]]$argumentList,[hashtable]$env=@{}) {
  $listener=@(Get-NetTCPConnection -LocalAddress $localIp -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
  if($listener.Count -gt 0){
    if($port -eq 8787){
      # A single missed health check is not proof of death: the process's own
      # periodic vault-token poll can briefly delay its response under load,
      # which used to read as "down" on the very next Reconcile tick and get
      # force-killed mid-blip, dropping every open connection for no reason.
      # Three quick attempts with a short gap tell a transient stall apart
      # from an actually-unresponsive process while staying well inside this
      # loop's own budget (worst case ~7s against a 2-minute cadence and a
      # 3-minute task execution limit).
      $healthy=$false
      for($healthAttempt=0; $healthAttempt -lt 3; $healthAttempt++){
        try {
          $health=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ("http://{0}:{1}/health" -f $localIp,$port)
          if($health.StatusCode -eq 200){ $healthy=$true; break }
        } catch {}
        if($healthAttempt -lt 2){ Start-Sleep -Milliseconds 500 }
      }
      if($healthy){ return $true }
      # A listener that fails its own health endpoint across repeated checks
      # (not a single blip) is not healthy merely because its command line
      # happens to look familiar. Reclaim only the exact declared process;
      # unrelated listeners remain protected.
      Stop-Owned $localIp $port $pattern
      $listener=@(Get-NetTCPConnection -LocalAddress $localIp -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
      if($listener.Count -gt 0){ return $false }
    }
    foreach($row in $listener){ $owner=Get-CimInstance Win32_Process -Filter "ProcessId=$($row.OwningProcess)" -ErrorAction SilentlyContinue; if(Test-OwnedProcess $owner $port $pattern){ return $true } }
    return $false
  }
  if(-not (Test-Path -LiteralPath $script)){ return $false }
  if($script -match '\.ps1$'){
    $launchFile='powershell.exe'
    $launchArgs=@('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$script)
    $launchArgs += @($argumentList)
  } else {
    $launchFile=$script
    $launchArgs=@($argumentList)
  }
  [void](Start-Hidden -file $launchFile -argumentList $launchArgs -env $env)
  for($attempt=0;$attempt -lt 10;$attempt++){
    if(@(Get-NetTCPConnection -LocalAddress $localIp -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -gt 0){ return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function Stop-Owned([string]$localIp,[int]$port,[string]$pattern){
  foreach($c in @(Get-NetTCPConnection -LocalAddress $localIp -LocalPort $port -State Listen -ErrorAction SilentlyContinue)){
    $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
    if(Test-OwnedProcess $p $port $pattern){ try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } catch {} }
  }
}
function Ensure-LifecycleTask {
  try {
    $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Action Reconcile"
    $trigger=New-ScheduledTaskTrigger -AtLogOn
    # A logon trigger handles reboot; a second trigger keeps enabled lanes
    # looking for a cable/peer that appears later without polling from the UI.
    $repeat=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigger,$repeat) -Settings $settings -Description 'ServerControl isolated Tunnel, ToolsEnabled, and Full Remote reconcile' -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -RunLevel Limited -Force | Out-Null
    # There is exactly one top-level reconciler. The former FRA task is removed
    # only after this replacement task is registered successfully.
    Unregister-ScheduledTask -TaskName $LegacyFraTaskName -Confirm:$false -ErrorAction SilentlyContinue
  } catch {}
}
function Remove-LifecycleTask {
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  try { Unregister-ScheduledTask -TaskName $LegacyFraTaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
}

function Invoke-FullRemoteLane([ValidateSet('Start','Reconcile','Stop')][string]$LaneAction) {
  $script=if($LaneAction -eq 'Reconcile' -and (Test-Path -LiteralPath $FullRemoteLifecycle -PathType Leaf)){$FullRemoteLifecycle}else{$FullRemoteControl}
  $action=if($script -eq $FullRemoteLifecycle){'Reconcile'}else{$LaneAction}
  if(-not (Test-Path -LiteralPath $script -PathType Leaf)){ return $false }
  try {
    [void](Start-Hidden -file 'powershell.exe' -argumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$script,'-Action',$action))
    return $true
  } catch { return $false }
}

$mutex=$null
$held=$false
try {
  $mutex=New-Object System.Threading.Mutex($false,$MutexName)
  try { $held=$mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held=$true }
  if(-not $held){
    [pscustomobject]@{ Busy=$true; Status='busy'; Error=$null } | ConvertTo-Json -Compress
    exit 0
  }

  $state=Read-State
  $link=Find-Link
  $state.LocalIp=$link.LocalIp; $state.PeerIp=$link.PeerIp

  if($Action -eq 'Status'){
    [pscustomobject]@{
      TunnelEnabled=[bool]$state.TunnelEnabled; BridgeEnabled=[bool]$state.BridgeEnabled; FullRemoteEnabled=[bool]$state.FullRemoteEnabled
      LocalIp=$state.LocalIp; PeerIp=$state.PeerIp; PeerRelay=[bool]$state.PeerRelay; PeerBridge=[bool]$state.PeerBridge
      Status=$state.LastStatus; Error=$state.LastError; TunnelError=$state.TunnelError; BridgeError=$state.BridgeError; FullRemoteError=$state.FullRemoteError; LastAttempt=$state.LastAttempt
    } | ConvertTo-Json -Compress
    exit 0
  }

  switch($Action){
    'EnableTunnel' { $state.TunnelEnabled=$true; $state.LastStatus='starting'; $state.TunnelError=$null }
    'DisableTunnel' { $state.TunnelEnabled=$false; $state.BridgeEnabled=$false; $state.LastStatus='disabled' }
    'EnableBridge' { $state.TunnelEnabled=$true; $state.BridgeEnabled=$true; $state.LastStatus='starting-bridge'; $state.BridgeError=$null }
    'DisableBridge' { $state.BridgeEnabled=$false; $state.LastStatus='bridge-disabled' }
    'EnableFullRemote' { $state.FullRemoteEnabled=$true; $state.LastStatus='starting-full-remote'; $state.FullRemoteError=$null }
    'DisableFullRemote' { $state.FullRemoteEnabled=$false; $state.LastStatus='full-remote-disabled' }
  }

  # Legacy raw bootstrap listeners are never a steady-state dependency. Only a
  # future explicit, fenced one-shot bootstrap action may open them.
  if($link.LocalIp){
    Stop-Owned $link.LocalIp 8791 'remote-bridge-enroll-token\.js'
    Stop-Owned $link.LocalIp 8792 'link-bus-enroll-token\.js'
  }

  $state.TunnelError=$null
  $state.BridgeError=$null
  $state.FullRemoteError=$null
  $peerAuthOk=$false
  $peerBridgeReady=$false
  $peerBridgeAuth=$false

  if($state.TunnelEnabled){
    if(-not $link.LocalIp){
      $state.PeerRelay=$false
      $state.TunnelError='direct Ethernet address is unavailable'
    } elseif(-not (Secret-Exists 'Tunnel')){
      Stop-Owned $link.LocalIp 8787 'link-bus[\\/]server\.js'
      $state.PeerRelay=$false
      $state.TunnelError='credential required: custom.link_bus_bridge_token'
    } else {
      $bus=Ensure-Process $link.LocalIp 8787 'link-bus[\\/]server\.js' $StartBus @('-HostAddress',$link.LocalIp)
      $localBusListening=(@(Get-NetTCPConnection -LocalAddress $link.LocalIp -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue).Count -gt 0)
      if(-not $bus -and -not $localBusListening){ $state.TunnelError='local Tunnel listener did not start' }
      $state.PeerRelay=Test-Port $link.PeerIp 8787
      if($state.PeerRelay -and (Test-Path -LiteralPath $RelayStatus -PathType Leaf)){
        $priorPeer=$env:LINK_BUS_PEER; $priorLocal=$env:LINK_BUS_LOCAL
        try {
          $env:LINK_BUS_PEER=$link.PeerIp; $env:LINK_BUS_LOCAL=$link.LocalIp
          $peerRaw=& $Node $RelayStatus 2>$null
          if($peerRaw){ $peerCheck=$peerRaw|ConvertFrom-Json; $peerAuthOk=[bool]$peerCheck.authOk }
        } catch {} finally {
          if($null -eq $priorPeer){ Remove-Item Env:LINK_BUS_PEER -ErrorAction SilentlyContinue }else{$env:LINK_BUS_PEER=$priorPeer}
          if($null -eq $priorLocal){ Remove-Item Env:LINK_BUS_LOCAL -ErrorAction SilentlyContinue }else{$env:LINK_BUS_LOCAL=$priorLocal}
        }
        if(-not $peerAuthOk -and -not $state.TunnelError){ $state.TunnelError='peer Tunnel credential generation is not synchronized' }
      }
    }
  } else {
    $state.PeerRelay=$false
    if($link.LocalIp){ Stop-Owned $link.LocalIp 8787 'link-bus[\\/]server\.js' }
  }

  if($state.BridgeEnabled){
    if(-not $link.LocalIp){
      $state.PeerBridge=$false
      $state.BridgeError='direct Ethernet address is unavailable'
    } elseif(-not (Secret-Exists 'Bridge')){
      Stop-Owned $link.LocalIp 8788 'remote-agent-bridge\.js'
      $state.PeerBridge=$false
      $state.BridgeError='credential required: custom.remote_agent_bridge_token'
    } else {
      [void](Ensure-Process $link.LocalIp 8788 'remote-agent-bridge\.js' $StartBridge @('-HostAddress',$link.LocalIp))
      $state.PeerBridge=Test-Port $link.PeerIp 8788
      $peerBridgeCheck=if($state.PeerBridge){ Get-PeerBridgeAuth $link.PeerIp } else { $null }
      $peerBridgeReady=[bool]($peerBridgeCheck -and $peerBridgeCheck.authOk -and $peerBridgeCheck.toolsOk -and $peerBridgeCheck.rootMatches)
      $peerBridgeAuth=[bool]($peerBridgeReady -and $peerBridgeCheck.safetyOk)
      $peerKillSwitch=[bool]($peerBridgeCheck -and $peerBridgeCheck.killSwitchActive)
      if($peerKillSwitch){ $state.BridgeError='peer kill switch is active' }
      elseif($state.PeerBridge -and -not $peerBridgeReady){ $state.BridgeError='peer ToolsEnabled credential or runtime identity is not synchronized' }
      elseif($peerBridgeReady -and -not $peerBridgeAuth){ $state.BridgeError='peer kill-switch status is unavailable' }
    }
  } else {
    $state.PeerBridge=$false
    if($link.LocalIp){ Stop-Owned $link.LocalIp 8788 'remote-agent-bridge\.js' }
  }

  if($state.FullRemoteEnabled){
    if(-not (Secret-Exists 'FullRemote')){
      # The dedicated FRA controller may open only its bounded, sealed 8794
      # enrollment window. It never falls back to either lower-tier secret.
      $state.FullRemoteError='credential required: custom.full_remote_access_token'
    }
    $fraAction=if($Action -eq 'EnableFullRemote'){'Start'}else{'Reconcile'}
    if(-not (Invoke-FullRemoteLane $fraAction) -and -not $state.FullRemoteError){ $state.FullRemoteError='Full Remote controller is unavailable' }
  } else {
    $fraNeedsStop=$false
    try {
      if(Test-Path -LiteralPath $FullRemoteStatePath -PathType Leaf){
        $fraState=Get-Content -Raw -LiteralPath $FullRemoteStatePath | ConvertFrom-Json
        $fraNeedsStop=[bool]($fraState.owned -or [string]$fraState.desiredState -ne 'disabled')
      }
    } catch { $fraNeedsStop=$true }
    if($Action -eq 'DisableFullRemote' -or $fraNeedsStop){
      if(-not (Invoke-FullRemoteLane 'Stop')){ $state.FullRemoteError='Full Remote stop controller is unavailable' }
    }
  }

  if($Action -eq 'DisableTunnel' -and $link.LocalIp){
    Stop-Owned $link.LocalIp 8788 'remote-agent-bridge\.js'
    Stop-Owned $link.LocalIp 8787 'link-bus[\\/]server\.js'
  }
  if($Action -eq 'DisableBridge' -and $link.LocalIp){ Stop-Owned $link.LocalIp 8788 'remote-agent-bridge\.js' }

  $errors=@(@($state.TunnelError,$state.BridgeError,$state.FullRemoteError) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
  $state.LastError=if($errors.Count -gt 0){[string]$errors[0]}else{$null}
  if($errors.Count -gt 0){ $state.LastStatus='attention' }
  elseif($state.BridgeEnabled -and $peerBridgeAuth){ $state.LastStatus='connected' }
  elseif($state.TunnelEnabled -and $peerAuthOk){ $state.LastStatus='tunnel-connected' }
  elseif($state.TunnelEnabled -or $state.BridgeEnabled -or $state.FullRemoteEnabled){ $state.LastStatus='waiting-for-peer' }
  else { $state.LastStatus='off' }
  $state.LastAttempt=(Get-Date).ToUniversalTime().ToString('o')

  if($state.TunnelEnabled -or $state.BridgeEnabled -or $state.FullRemoteEnabled){ Ensure-LifecycleTask } else { Remove-LifecycleTask }
  Write-State $state
  [pscustomobject]@{
    TunnelEnabled=[bool]$state.TunnelEnabled; BridgeEnabled=[bool]$state.BridgeEnabled; FullRemoteEnabled=[bool]$state.FullRemoteEnabled
    LocalIp=$state.LocalIp; PeerIp=$state.PeerIp; PeerRelay=[bool]$state.PeerRelay; PeerBridge=[bool]$state.PeerBridge
    Status=$state.LastStatus; Error=$state.LastError; TunnelError=$state.TunnelError; BridgeError=$state.BridgeError; FullRemoteError=$state.FullRemoteError; LastAttempt=$state.LastAttempt
  } | ConvertTo-Json -Compress
} finally {
  if($held -and $mutex){ try { $mutex.ReleaseMutex() } catch {} }
  if($mutex){ $mutex.Dispose() }
}
