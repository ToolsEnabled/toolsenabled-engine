[CmdletBinding()]
param(
  [string]$SourceRoot,
  [switch]$KeepPreview
)

$ErrorActionPreference='Stop'
if([string]::IsNullOrWhiteSpace($SourceRoot)){ $SourceRoot=$PSScriptRoot }
$SourceRoot=[System.IO.Path]::GetFullPath($SourceRoot)
$stopwatch=[System.Diagnostics.Stopwatch]::StartNew()
. (Join-Path $SourceRoot 'ServerControl.Common.ps1')
$profile=Get-ServerControlHostProfile
$profileA=Get-ServerControlHostProfile -MachineId A
$profileB=Get-ServerControlHostProfile -MachineId B
if($profile.MachineId -notin @('A','B')){ throw 'This bundle did not resolve the local host as Machine A or B.' }
if($profileA.MachineId -cne 'A' -or -not $profileA.ConfiguredIp -or $profileA.PeerIp -cne $profileB.ConfiguredIp){ throw 'Machine-A profile contract failed.' }
if($profileB.MachineId -cne 'B' -or -not $profileB.ConfiguredIp -or $profileB.PeerIp -cne $profileA.ConfiguredIp){ throw 'Machine-B profile contract failed.' }

function Get-RuntimeStatePresence([string]$root){
  $values=[ordered]@{}
  foreach($name in @('servers.json','tunnel-state.json','power-policy.json','panel-heartbeat.json','lifecycle-health.json')){
    $path=Join-Path $root $name
    $values[$name]=[bool](Test-Path -LiteralPath $path -PathType Leaf)
  }
  return $values
}

$beforeState=Get-RuntimeStatePresence $SourceRoot
$scriptFiles=@(Get-ChildItem -LiteralPath $SourceRoot -Filter '*.ps1' -File | Sort-Object Name)
$parseErrors=@()
$functionNames=@{}
foreach($file in $scriptFiles){
  $tokens=$null; $errors=$null
  $ast=[System.Management.Automation.Language.Parser]::ParseFile($file.FullName,[ref]$tokens,[ref]$errors)
  foreach($error in @($errors)){ $parseErrors += ("{0}:{1}:{2}" -f $file.Name,$error.Extent.StartLineNumber,$error.Message) }
  $functionNames[$file.Name]=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst]},$true) | ForEach-Object Name)
}
if($parseErrors.Count -gt 0){ throw "PowerShell parse failures: $($parseErrors -join '; ')" }

$requiredFunctions=[ordered]@{
  'Server-Control-Panel.ps1'=@('Build-Cards','Update-Status','Update-TunnelControls','Update-FullRemoteControl','Get-ServerAvailability','Test-FullRemoteControllerEnrollmentCapable','Invoke-FullRemoteSecureSetup')
  'Full-Remote-Access-Firewall.ps1'=@('Resolve-DirectLinkAddresses')
  'ServerControl.Common.ps1'=@('Get-ServerControlHostProfile','Resolve-ServerControlPath','Get-ServerControlDirectLinkAddress','Get-ServerControlMachineIdFromPath','Get-ServerControlAddressContext','Get-ServerControlServiceRegistryHelperPath')
  'ServerRegistry.ps1'=@('Sync-Registry','Set-ServerLifecycleSettings','Test-RegistryParity')
  'Server-Lifecycle.ps1'=@('Start-ServerRow','Write-HealthSnapshot')
  'Tunnel-Lifecycle.ps1'=@('Ensure-Process','Get-PeerBridgeAuth','Invoke-FullRemoteLane')
}
foreach($file in $requiredFunctions.Keys){
  foreach($name in $requiredFunctions[$file]){ if($functionNames[$file] -notcontains $name){ throw "Required function missing: $file::$name" } }
}

$panelSource=Get-Content -Raw -LiteralPath (Join-Path $SourceRoot 'Server-Control-Panel.ps1')
foreach($token in @("Text='Enabled'","Text='Keep alive'","Text='Start at sign-in'","Text='ToolsEnabled'",'Activity Visualizer (3889) only observes activity.','RenderPreviewPath')){
  if($panelSource.IndexOf($token,[StringComparison]::Ordinal) -lt 0){ throw "UI contract token missing: $token" }
}
foreach($token in @("tools\fra-token-enrollment-lifecycle.js",'$EnrollmentPort = 8794','Full-Remote-Access-Firewall.ps1')){
  if($panelSource.IndexOf($token,[StringComparison]::Ordinal) -lt 0){ throw "FRA enrollment compatibility token missing: $token" }
}
$firewallSource=Get-Content -Raw -LiteralPath (Join-Path $SourceRoot 'Full-Remote-Access-Firewall.ps1')
foreach($token in @("Port = 8790","Port = 8794",'ToolsEnabled FRA Enrollment 8794','Remove retired or peer-inappropriate FRA enrollment rule','-RemoteAddress $RemoteAddress','FULL_REMOTE_ACCESS_HOST_UNRESOLVED')){
  if($firewallSource.IndexOf($token,[StringComparison]::Ordinal) -lt 0){ throw "Peer-only FRA firewall token missing: $token" }
}
if($firewallSource.IndexOf("Port = 8793",[StringComparison]::Ordinal) -ge 0){ throw 'Retired FRA enrollment port 8793 returned to the active rule set.' }
if($panelSource.IndexOf('Stop-Srv $srv $false',[StringComparison]::Ordinal) -lt 0){ throw 'Closing the panel would clear Enabled intent.' }
$lifecycleSource=Get-Content -Raw -LiteralPath (Join-Path $SourceRoot 'Server-Lifecycle.ps1')
$runIntentContract="(Get-Flag `$row 'StartOnRestart') -and (Get-Flag `$row 'RunEnabled'"
if($lifecycleSource.IndexOf($runIntentContract,[StringComparison]::Ordinal) -lt 0){ throw 'Start-at-sign-in does not honor RunEnabled.' }
$tunnelSource=Get-Content -Raw -LiteralPath (Join-Path $SourceRoot 'Tunnel-Lifecycle.ps1')
$bridgeDependency="'EnableBridge' { `$state.TunnelEnabled=`$true; `$state.BridgeEnabled=`$true"
if($tunnelSource.IndexOf($bridgeDependency,[StringComparison]::Ordinal) -lt 0){ throw 'ToolsEnabled no longer enables its required Tunnel tier.' }
foreach($token in @("'EnableFullRemote'","'DisableFullRemote'",'Global\ToolsEnabledDirectAccessLifecycle','MultipleInstances IgnoreNew','ToolsEnabled FRA Lifecycle','custom.link_bus_bridge_token','custom.remote_agent_bridge_token','custom.full_remote_access_token')){
  if($tunnelSource.IndexOf($token,[StringComparison]::Ordinal) -lt 0){ throw "Three-lane lifecycle token missing: $token" }
}
foreach($forbidden in @('LINK_BUS_ENROLL_REPLACE','REMOTE_AGENT_BRIDGE_ENROLL_REPLACE','$RelayBootstrap','$Bootstrap')){
  if($tunnelSource.IndexOf($forbidden,[StringComparison]::Ordinal) -ge 0){ throw "Steady-state raw bootstrap behavior returned: $forbidden" }
}
if(([regex]::Matches($tunnelSource,'Register-ScheduledTask -TaskName \$TaskName')).Count -ne 1){
  throw 'The three-lane lifecycle must install exactly one serialized scheduled task.'
}
if($panelSource.IndexOf("Invoke-TunnelAction (if(`$cbFullRemote.Checked){'EnableFullRemote'}else{'DisableFullRemote'})",[StringComparison]::Ordinal) -lt 0){
  throw 'Full Remote UI no longer routes desired state through the serialized three-lane lifecycle.'
}

function Get-FileIdentity([string]$path){
  if(-not (Test-Path -LiteralPath $path -PathType Leaf)){ return 'absent' }
  $item=Get-Item -LiteralPath $path
  return ('{0}|{1}|{2}' -f $item.Length,$item.LastWriteTimeUtc.Ticks,(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash)
}
function Get-AccessListenerIdentity {
  return [string]::Join("`n",@(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { [int]$_.LocalPort -in @(8787,8788,8790,8791,8792,8793,8794) } |
      ForEach-Object { '{0}|{1}|{2}' -f $_.LocalAddress,$_.LocalPort,$_.OwningProcess } |
      Sort-Object
  ))
}
$tunnelStatePath=Join-Path $SourceRoot 'tunnel-state.json'
$tunnelStatusReadOnly=$false
for($statusAttempt=0;$statusAttempt -lt 3 -and -not $tunnelStatusReadOnly;$statusAttempt++){
  $beforeTunnelState=Get-FileIdentity $tunnelStatePath
  $beforeAccessListeners=Get-AccessListenerIdentity
  $tunnelStatusOutput=@(& powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File (Join-Path $SourceRoot 'Tunnel-Lifecycle.ps1') -Action Status 2>&1)
  if($LASTEXITCODE -ne 0){ throw "Tunnel Status failed: $($tunnelStatusOutput -join ' ')" }
  $tunnelStatusJson=$tunnelStatusOutput | ForEach-Object { [string]$_ } | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1
  if(-not $tunnelStatusJson){ throw 'Tunnel Status did not return JSON.' }
  $tunnelStatus=$tunnelStatusJson | ConvertFrom-Json
  if($tunnelStatus.PSObject.Properties.Name -notcontains 'Busy' -and $tunnelStatus.PSObject.Properties.Name -notcontains 'TunnelEnabled'){
    throw 'Tunnel Status returned an unknown projection.'
  }
  $tunnelStatusReadOnly=((Get-FileIdentity $tunnelStatePath) -ceq $beforeTunnelState -and
    (Get-AccessListenerIdentity) -ceq $beforeAccessListeners)
}
if(-not $tunnelStatusReadOnly){ throw 'Tunnel Status could not prove a read-only stable window after three bounded attempts.' }

$registryOutput=& powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File (Join-Path $SourceRoot 'Test-Registry.ps1') 2>&1
if($LASTEXITCODE -ne 0){ throw "Registry smoke failed: $($registryOutput -join ' ')" }

$previewPath=Join-Path ([System.IO.Path]::GetTempPath()) ("servercontrol-preview-{0}.png" -f [guid]::NewGuid().ToString('N'))
try {
  $previewOutput=@(& powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File (Join-Path $SourceRoot 'Server-Control-Panel.ps1') -RenderPreviewPath $previewPath 2>&1)
  if($LASTEXITCODE -ne 0){ throw "UI preview failed: $($previewOutput -join ' ')" }
  $previewJson=$previewOutput | Where-Object { $_ -is [string] -and $_.TrimStart().StartsWith('{') } | Select-Object -Last 1
  if(-not $previewJson){ throw 'UI preview did not return its contract.' }
  $preview=$previewJson | ConvertFrom-Json
  if(-not $preview.ok -or [int]$preview.serverCount -ne 8){ throw 'UI preview contract is incomplete.' }
  $tiers=@($preview.accessTiers | ForEach-Object {[string]$_})
  if(($tiers -join '|') -cne 'Tunnel|ToolsEnabled|Full remote'){ throw 'Remote-access tier order or naming drifted.' }
  if(-not (Test-Path -LiteralPath $previewPath -PathType Leaf)){ throw 'UI preview PNG was not created.' }
  Add-Type -AssemblyName System.Drawing
  $image=[System.Drawing.Image]::FromFile($previewPath)
  try {
    if($image.Width -lt 620 -or $image.Height -lt 740){ throw "UI preview is too small: $($image.Width)x$($image.Height)" }
    $previewWidth=$image.Width; $previewHeight=$image.Height
  } finally { $image.Dispose() }
  $previewBytes=(Get-Item -LiteralPath $previewPath).Length
  if($previewBytes -lt 20000){ throw "UI preview appears blank or incomplete ($previewBytes bytes)." }
} finally {
  if(-not $KeepPreview -and $previewPath -and (Test-Path -LiteralPath $previewPath)){ Remove-Item -LiteralPath $previewPath -Force }
}

# A SELF-TEST WHOSE INPUT CAN BE ABSENT IS A SELF-TEST THAT CAN PASS WITHOUT
# RUNNING. The manifest block used to be wrapped in `if(Test-Path ...)`, so a
# bundle with NO parity manifest at all skipped the entire check and still
# emitted ok=true with exit 0 -- only the manifestChecked flag said otherwise,
# and nothing reads a flag when the verdict says ok. Measured 2026-08-09 on an
# isolated copy of this bundle with the manifest moved aside:
#   {"ok":true,...,"manifestChecked":false,...}   exit 0
# The absence is never legitimate here: Generate-ServerControlManifest.ps1
# always writes the manifest into SourceRoot, and Deploy-ServerControl.ps1
# refuses to run without one and copies it into every target. So a missing
# manifest means the bundle under test was never validated for parity, which is
# exactly what this check exists to establish, and README.txt tells the operator
# to compare the manifest SHA-256 across both targets after a promotion -- a
# comparison the self-test could not support because it never reported one.
$manifestPath=Join-Path $SourceRoot 'servercontrol.manifest.json'
if(-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)){
  throw "Parity manifest is missing: $manifestPath. Generate it with Generate-ServerControlManifest.ps1 before self-testing; an unverified bundle is not a passing bundle."
}
$manifest=Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if([string]$manifest.schema -cne 'servercontrol.parity-manifest.v1'){ throw "Unsupported parity manifest schema: $([string]$manifest.schema)" }
$manifestRows=@($manifest.files)
if($manifestRows.Count -lt 1){ throw 'Parity manifest declares no files; it cannot establish parity for anything.' }
if([int]$manifest.fileCount -ne $manifestRows.Count){ throw "Parity manifest fileCount ($([int]$manifest.fileCount)) does not match its rows ($($manifestRows.Count))." }
foreach($row in $manifestRows){
  $path=Join-Path $SourceRoot ([string]$row.path).Replace('/','\')
  if(-not (Test-Path -LiteralPath $path -PathType Leaf)){ throw "Manifest file missing: $($row.path)" }
  $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if($hash -cne [string]$row.sha256){ throw "Manifest hash mismatch: $($row.path)" }
}
$manifestChecked=$true
$manifestSha256=(Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()

$afterState=Get-RuntimeStatePresence $SourceRoot
$stateChanged=@($beforeState.Keys | Where-Object { $beforeState[$_] -cne $afterState[$_] })
if($stateChanged.Count -gt 0){ throw "Self-test created or removed runtime state: $($stateChanged -join ', ')" }

$curatedPorts=@(3888,3889,4599,4610,4702,8123,8420,8765)
$listening=[System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
$runningCount=@($curatedPorts | Where-Object { $port=$_; $listening | Where-Object { [int]$_.Port -eq $port } | Select-Object -First 1 }).Count
$stopwatch.Stop()

[pscustomobject][ordered]@{
  ok=$true
  schema='servercontrol.self-test.v1'
  bundleVersion=$script:ServerControlBundleVersion
  machine=$profile.MachineId
  parsedScripts=$scriptFiles.Count
  parseErrors=0
  requiredFunctions=($requiredFunctions.Values | ForEach-Object { @($_).Count } | Measure-Object -Sum).Sum
  curatedServers=8
  currentlyListening=$runningCount
  registrySmoke=$true
  previewWidth=$previewWidth
  previewHeight=$previewHeight
  previewBytes=$previewBytes
  accessTiers=$tiers
  manifestChecked=$manifestChecked
  manifestFiles=$manifestRows.Count
  # README.txt asks the operator to compare this value across both targets after
  # a promotion. It could not be compared while the self-test never reported it.
  manifestSha256=$manifestSha256
  tunnelStatusReadOnly=$tunnelStatusReadOnly
  runtimeStateTouched=$false
  durationMs=$stopwatch.ElapsedMilliseconds
} | ConvertTo-Json -Compress
