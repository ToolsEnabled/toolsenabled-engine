# ============================================================
#   MECHANICAL CONNECT  -  direct-Ethernet key rendezvous
#
#   One tray toggle. Turn it on here and on the other machine and the two
#   computers connect themselves: they agree on a fresh bridge credential
#   without the owner typing, pasting, or approving anything.
#
#   The same file runs unmodified on both machines. Identity comes from the
#   registry-sanctioned local address at runtime. The accepted-address set is
#   read from config/service-registry.json and never falls back to a subnet.
#
#   Wire contract (fixed):
#     port 8795, bound to the local direct-link IP only
#     GET  /v1/rendezvous/state     -> {"armed":b,"ready":b,"generation":n,...}
#     POST /v1/rendezvous/exchange  {"token":"<43>","generation":n}
#                                    -> {"ok":true,"accepted":true,"generation":n}
#   `armed`/`ok` and `ready`/`accepted` are compatibility spellings. A peer may
#   send either literal boolean, but a successful receipt must echo the exact
#   numeric generation offered before the minter may touch its own vault.
#
#   Roles are deterministic, so there is nothing to negotiate: the numerically
#   LOWER registry-declared address mints; the higher address receives.
#   The role is ENFORCED, not just documented: a machine whose own role is
#   `minter` refuses an inbound exchange outright, so a pushed credential can
#   only ever be installed by the one machine that is supposed to receive it.
#
#   COMMIT ORDERING IS THE SAFETY PROPERTY.  The receiver writes its vault
#   before it answers with an acceptance receipt; the minter writes its own
#   vault only after it reads a literal acceptance plus the offered generation.
#   If the peer is not armed, refuses, or cannot be reached,
#   the minter writes nothing.  Nothing here ever deletes a vault key.
#
#   THE ORDERING HAS ONE HONEST GAP, AND IT IS HANDLED RATHER THAN DENIED.
#   Between the receiver's write and the minter reading ok:true the pair is
#   briefly split: the receiver already holds generation N, the minter does
#   not.  A lost reply or a failed local write leaves it that way.  Recovery is
#   automatic and needs no second round trip: the minter deliberately does NOT
#   advance its generation, so the next poll sees a mismatch and mints a
#   strictly higher generation which the receiver accepts.  A split is
#   therefore transient by construction.  Two things make it safe rather than
#   merely likely to heal: a split is reported as `attention` with a detail the
#   tray shows (it is never laundered into "waiting for peer"), and that
#   attention status survives the switch being turned off, so a split that
#   happens during a Disable cannot vanish into `off`.
#
#   TIMEOUTS ARE SIZED FOR THIS LINK, NOT FOR LOOPBACK.  Peer latency measured
#   on a real two-machine deployment runs 15-75 SECONDS.  Localhost-sized
#   deadlines caused two real outages there: a 4s socket timeout invented a
#   phantom "peer kill-switch unavailable" fault, and a 10s enrollment deadline
#   killed a valid handshake mid-write.  Every cross-machine deadline below is
#   therefore >= 90s.
#
#   The arithmetic that matters is ADDITIVE, not merely ordered.  An earlier
#   version of this header argued that exchange (120s) > probe (90s) was
#   sufficient because "the probe returns first".  That was wrong: it ignored
#   the receiver's own commit cost.  A peer that is 90s deep in its own probe
#   only starts serving our exchange at t=90s and may then spend up to
#   VaultWriteTimeoutMs on the DPAPI write, so the real constraint is
#     PeerExchangeTimeoutMs >= PeerProbeTimeoutMs + VaultWriteTimeoutMs + margin
#   and it is asserted by a test.  Independently, an outstanding probe or
#   exchange no longer starves the accept path at all: both pump the listener
#   while they wait (see -Pump), so neither machine can be blocked by the other
#   and two loops cannot phase-lock into mutual timeout.  The poll interval is
#   jittered for the same reason.  Every request also carries an absolute
#   deadline, so a peer that dribbles one byte per read timeout cannot hold the
#   loop open forever.
#
#   The secret never reaches argv, a console, a log, a state file, or an error
#   message.  It exists as a string in memory, as bytes on one stdin pipe, and
#   as one JSON field in one HTTP request body on the direct cable.  That last
#   hop is PLAINTEXT: this is a point-to-point cable with no router and no
#   third host, and the exact-peer check plus the Ethernet-only link check
#   below are what stand in for transport security.  Anyone who can passively
#   tap the cable, or who can make one of these two addresses appear on a
#   shared segment, can read the credential.  That is the accepted trade for a
#   handshake with no owner step; it is not a claim of confidentiality.
# ============================================================
[CmdletBinding()]
param(
  [switch]$Enable,
  [switch]$Disable,
  [switch]$Status,
  [switch]$Serve,
  [switch]$RegisterTask,
  [switch]$UnregisterTask,
  [switch]$LoadOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$commonScript = Join-Path $PSScriptRoot 'ServerControl.Common.ps1'
if(-not (Test-Path -LiteralPath $commonScript -PathType Leaf)){ throw 'ServerControl.Common.ps1 is missing.' }
. $commonScript

$script:HostProfile      = Get-ServerControlHostProfile
$script:RepoRoot         = $script:HostProfile.ToolsEnabledRoot
$registryHelper          = if($script:RepoRoot){ Join-Path $script:RepoRoot 'tools\lib\service-registry.ps1' }else{$null}
if(-not $registryHelper -or -not (Test-Path -LiteralPath $registryHelper -PathType Leaf)){ throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $registryHelper
$script:MachineAddressPolicy = Read-ToolsEnabledServiceRegistry -Root $script:RepoRoot
$script:PowerShellPath   = $script:HostProfile.PowerShell
$script:Schema           = 'servercontrol.mechanical-connect.v1'
$script:WireSchema       = 'fra-rendezvous.v1'
$script:RendezvousPort   = 8795
$script:BridgePort       = 8788
# The FRA credential, fixed by the canonical spec. This engine used to converge
# the remote-agent bridge key instead, and ran through several generations
# before anyone noticed -- real convergence, wrong lane. The FRA listener reads
# the key below and had never seen a converged value, so both machines refused
# each other's credential proof while the generation counter said they agreed.
# The bridge key keeps its own separate enrollment path; this engine carries
# the credential the one-toggle promise is actually about. Pinned by
# tests/servercontrol-mechanical-connect.test.js.
$script:VaultKey         = 'custom.full_remote_access_token'
$script:TokenBytes       = 32
$script:TokenLength      = 43
$script:StatePath        = if($script:RepoRoot){ Join-Path (Join-Path $script:RepoRoot 'state') 'mechanical-connect-state.json' } else { $null }
$script:TaskName         = 'ServerControl Mechanical Connect'
# GLOBAL\, NOT LOCAL\ -- these three names must cross session boundaries.
#
# The loop now runs as an S4U scheduled task, which puts it in session 0, while
# -Status, -Disable and the tray panel run in the owner's interactive session. A
# Local\ name is per-session, so the interactive side could not see the session-0
# loop at all: Test-RendezvousLoopAlive would answer "no loop" with the loop
# plainly running, -Enable would start a SECOND one whose TcpListener.Start()
# fails on the port the first already holds, and -Disable's Stop event would be
# set in a namespace nothing was listening to -- an off switch that silently does
# nothing. Global\ is the same namespace tools\full-remote-access-control.ps1
# already uses for Global\ToolsEnabledFullRemoteAccessStart, and for the same
# reason.
$script:LoopMutexName    = 'Global\ServerControlMechanicalConnectLoop'
$script:StateMutexName   = 'Global\ServerControlMechanicalConnectState'
$script:StopEventName    = 'Global\ServerControlMechanicalConnectStop'

# --- deadlines (see the header) -------------------------------------------
# Cross-machine, so >= 90s. A read-only probe gets 90s; the exchange gets more
# because the far side does a DPAPI vault write and a listener restart inside
# the same request, and it must never be cut off mid-commit.
$script:PeerProbeTimeoutMs      = 90000
# ADDITIVE, not merely greater: the peer may be a full probe deep before it
# even sees this request, and may then spend a whole vault-write budget on the
# DPAPI commit. 90000 + 60000 + 30000 margin. Asserted by a test.
$script:PeerExchangeTimeoutMs   = 180000
# An accepted connection is also a cross-machine request; the peer client
# writes its whole request immediately after connecting, so this is headroom,
# not an expected wait.
$script:ConnectionTimeoutMs     = 90000
# Local, single-process work: a DPAPI write through tools/secrets.ps1.
$script:VaultWriteTimeoutMs     = 60000
# How often an armed machine looks for its peer. Small enough that two owners
# toggling minutes apart still connect promptly, large enough not to hammer.
$script:PollIntervalMs          = 10000
# Two loops that start together would otherwise poll in lockstep forever. A
# plus-or-minus 40% jitter breaks any phase lock within a round or two.
$script:PollJitterFraction      = 0.4
# How often an outstanding request stops waiting to serve the peer's own
# queued connections. Small enough that the peer never perceives a stall.
$script:PumpIntervalMs          = 250
# Consecutive failed mints before the poll interval starts backing off. A
# permanently broken local vault must not rotate the peer's key 6x a minute.
$script:MintFailureBackoffAfter = 3
$script:PollIntervalMaxMs       = 300000
# How long a writer waits for the state document's lock before giving up. The
# read-modify-write must never proceed unlocked, so this is a real deadline.
$script:StateLockTimeoutMs      = 10000
$script:MaxRequestBytes         = 8192
$script:MaxResponseBytes        = 65536
# The receiver accepts a strictly higher generation, but only within a window.
# An unbounded ceiling let one request pin the counter at its maximum and wedge
# rotation permanently; the minter only ever offers max(local,peer)+1, so a
# window this wide cannot refuse a legitimate offer.
$script:GenerationWindow        = 4096
$script:GenerationCeiling       = 2147483000

# ---------------------------------------------------------------- identity --

function ConvertTo-RendezvousIpNumber {
  param([string]$Address)
  if([string]::IsNullOrWhiteSpace($Address)){ return $null }
  if($Address -notmatch '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\z'){ return $null }
  $value = 0L
  foreach($part in $Address.Split('.')){
    $octet = [int]$part
    if($octet -lt 0 -or $octet -gt 255){ return $null }
    $value = ($value * 256) + $octet
  }
  return $value
}

function Test-RendezvousLinkInterface {
  # A direct-link candidate must be a real, live Ethernet port. The shared
  # helper in ServerControl.Common.ps1 answers "does ANY adapter on this box
  # hold a registry address", which is the right question for choosing
  # a file path and the wrong question for deciding who may install a
  # credential: a rogue DHCP server, a hostile guest network, or an
  # attacker-configured Hyper-V switch can hand a machine a registered IP on a
  # SHARED broadcast domain, and the whole exact-peer guarantee then rests on
  # an address anyone on that segment can take.
  param($Interface)
  if($null -eq $Interface){ return $false }
  if($Interface.NetworkInterfaceType -ne [System.Net.NetworkInformation.NetworkInterfaceType]::Ethernet){ return $false }
  if($Interface.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up){ return $false }
  $text = "$($Interface.Description) $($Interface.Name)"
  # Not a whitelist of hardware, just a refusal of the adapter classes that can
  # be created or reconfigured without touching the cable.
  if($text -imatch 'hyper-v|virtual|vmware|virtualbox|vethernet|tap-|tap adapter|vpn|wintun|wireguard|loopback|bluetooth|npcap'){ return $false }
  return $true
}

function Get-RendezvousLinkAddress {
  # Returns the one direct-link address this machine legitimately owns, or
  # $null. Two registered addresses present at once is a HARD FAULT, not a first-match
  # win: which one wins would otherwise depend on adapter enumeration order,
  # so the role could silently flip between processes and both machines could
  # believe they are the minter.
  $found = @()
  try {
    foreach($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()){
      if(-not (Test-RendezvousLinkInterface $nic)){ continue }
      foreach($address in $nic.GetIPProperties().UnicastAddresses){
        $value = [string]$address.Address
        if($script:MachineAddressPolicy.addresses -ccontains $value){
          if($found -notcontains $value){ $found += $value }
        }
      }
    }
  } catch { return $null }
  if($found.Count -ne 1){ return $null }
  return [string]$found[0]
}

function Get-RendezvousPeer {
  param([string]$LocalIp)
  if(-not (Test-ServiceRegistryIPv4 -Address $LocalIp)){ return $null }
  $local=@($script:MachineAddressPolicy.machines | Where-Object { $_.address -ceq $LocalIp })
  if($local.Count -ne 1){ return $null }
  $peers=@($script:MachineAddressPolicy.machines | Where-Object { $_.machineId -cne $local[0].machineId })
  if($peers.Count -ne 1){ throw 'SERVICE_PEER_UNDETERMINED' }
  return [string]$peers[0].address
}

function Get-RendezvousRole {
  # Zero negotiation: the numerically lower direct-link address mints. Both
  # machines run this same line and reach opposite, complementary answers.
  param([string]$LocalIp)
  $peer = Get-RendezvousPeer $LocalIp
  if(-not $peer){ return $null }
  $mine = ConvertTo-RendezvousIpNumber $LocalIp
  $theirs = ConvertTo-RendezvousIpNumber $peer
  if($null -eq $mine -or $null -eq $theirs){ return $null }
  if($mine -lt $theirs){ return 'minter' }
  return 'receiver'
}

function Test-RendezvousPeerAddress {
  # Exact single address. Never a subnet, never a prefix, never a range.
  param([string]$Address,[string]$PeerIp)
  if([string]::IsNullOrEmpty($Address) -or [string]::IsNullOrEmpty($PeerIp)){ return $false }
  if(-not (Test-ServiceRegistryIPv4 -Address $PeerIp)){ return $false }
  if($script:MachineAddressPolicy.addresses -cnotcontains $PeerIp){ return $false }
  return ($Address -ceq $PeerIp)
}

function Test-RendezvousToken {
  # Mechanical Connect is a token-creation path, so it accepts only the current
  # canonical 32-byte format. Legacy canonical 30-byte values remain readable
  # solely at the enrollment/lifecycle persisted-token compatibility boundary;
  # they must never re-enter through a new rendezvous write.
  param([string]$Token)
  if($null -eq $Token -or $Token -cnotmatch ('^[A-Za-z0-9_-]{' + $script:TokenLength + '}\z')){ return $false }
  $bytes=$null
  try {
    $standard=$Token.Replace('-','+').Replace('_','/') + '='
    $bytes=[Convert]::FromBase64String($standard)
    if($bytes.Length -ne $script:TokenBytes){ return $false }
    $canonical=([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+','-').Replace('/','_')
    return ($canonical -ceq $Token)
  } catch { return $false }
  finally { if($null -ne $bytes){ [Array]::Clear($bytes,0,$bytes.Length) } }
}

# ------------------------------------------------------------------ secret --

function New-RendezvousToken {
  # CSPRNG only. Get-Random is a seeded PRNG and must never mint a credential.
  # Encode exactly 32 random bytes canonically; generating 43 independent text
  # characters would admit non-canonical final sextets and sometimes decode to
  # 33 bytes.
  $buffer = New-Object byte[] $script:TokenBytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
    return ([Convert]::ToBase64String($buffer)).TrimEnd('=').Replace('+','-').Replace('/','_')
  } finally {
    $rng.Dispose()
    [Array]::Clear($buffer,0,$buffer.Length)
  }
}

function ConvertTo-RendezvousArgumentString {
  param([string[]]$Arguments)
  return (($Arguments | ForEach-Object {
    $value = [string]$_
    if($value.Length -eq 0){ return '""' }
    if($value -match '[\s"]'){ return '"' + $value.Replace('"','\"') + '"' }
    return $value
  }) -join ' ')
}

function Save-RendezvousCredential {
  # The vault KEY is an argument. The SECRET is not, and never can be: it
  # crosses one stdin pipe into tools/secrets.ps1 and is never echoed back.
  param([Parameter(Mandatory=$true)][string]$Token)
  if(-not (Test-RendezvousToken $Token)){ return $false }
  if(-not $script:RepoRoot){ return $false }
  $secrets = Join-Path $script:RepoRoot 'tools\secrets.ps1'
  if(-not (Test-Path -LiteralPath $secrets -PathType Leaf)){ return $false }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:PowerShellPath
  $psi.Arguments = ConvertTo-RendezvousArgumentString @(
    '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass',
    '-File',$secrets,'set-stdin',$script:VaultKey
  )
  $psi.WorkingDirectory = $script:RepoRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  try {
    if(-not $process.Start()){ return $false }
    # Raw bytes on the base stream, never the TextWriter. secrets.ps1 stores
    # stdin verbatim, so two things would silently become part of the stored
    # credential: a trailing newline (hence never WriteLine), and whatever
    # preamble the writer's ambient Console.InputEncoding decides to emit. A
    # host or locale that makes that encoding UTF-8-with-BOM would store
    # "BOM+<token>" on one machine and the bare token on the other; both
    # sides would report success and every later bridge handshake would fail
    # with nothing but "authorization failed" in a log. The alphabet is
    # [A-Za-z0-9], so ASCII bytes are exact and identical on both machines.
    $tokenBytes = [System.Text.Encoding]::ASCII.GetBytes($Token)
    try {
      $process.StandardInput.BaseStream.Write($tokenBytes,0,$tokenBytes.Length)
      $process.StandardInput.BaseStream.Flush()
    } finally {
      [Array]::Clear($tokenBytes,0,$tokenBytes.Length)
    }
    $process.StandardInput.Close()
    # Drain both pipes so a full buffer cannot deadlock the child. The text is
    # discarded rather than logged: nothing from this transaction is persisted.
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errTask = $process.StandardError.ReadToEndAsync()
    if(-not $process.WaitForExit($script:VaultWriteTimeoutMs)){
      try { $process.Kill() } catch {}
      return $false
    }
    [void]$outTask.GetAwaiter().GetResult()
    [void]$errTask.GetAwaiter().GetResult()
    return ($process.ExitCode -eq 0)
  } catch {
    return $false
  } finally {
    try { $process.Dispose() } catch {}
  }
}

$script:CommitCredential = { param([string]$Token) Save-RendezvousCredential -Token $Token }

# ------------------------------------------------------------------- state --

function ConvertTo-RendezvousInt {
  # A peer, or a half-written local file, can put "abc", 2147483647, or a
  # float where an integer belongs. A raw [int] cast throws, and every call
  # site here sits on a path with $ErrorActionPreference='Stop', so one bad
  # field used to unwind the whole serve loop and exit the process.
  param($Value,[int]$Default = 0)
  if($null -eq $Value){ return $Default }
  $parsed = 0L
  if(-not [long]::TryParse([string]$Value,[ref]$parsed)){ return $Default }
  if($parsed -lt 0){ return $Default }
  if($parsed -gt $script:GenerationCeiling){ return $script:GenerationCeiling }
  return [int]$parsed
}

function New-RendezvousState {
  return [pscustomobject][ordered]@{
    schema     = $script:Schema
    armed      = $false
    generation = 0
    connected  = $false
    role       = $null
    localIp    = $null
    peerIp     = $null
    status     = 'off'
    detail     = ''
    loopPid    = 0
    updatedAt  = $null
  }
}

function Read-RendezvousState {
  $state = $null
  if($script:StatePath -and (Test-Path -LiteralPath $script:StatePath -PathType Leaf)){
    try { $state = (Get-Content -Raw -LiteralPath $script:StatePath | ConvertFrom-Json) } catch { $state = $null }
  }
  if($null -eq $state){ return New-RendezvousState }
  $template = New-RendezvousState
  foreach($property in $template.PSObject.Properties){
    if($state.PSObject.Properties.Name -notcontains $property.Name){
      $state | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
    }
  }
  $state.generation = ConvertTo-RendezvousInt $state.generation 0
  $state.armed = [bool]$state.armed
  $state.connected = [bool]$state.connected
  return $state
}

function Write-RendezvousState {
  param($State)
  if(-not $script:StatePath){ return }
  $directory = Split-Path -Parent $script:StatePath
  if($directory -and -not (Test-Path -LiteralPath $directory)){
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  $State.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
  $temporary = "$($script:StatePath).$PID.tmp"
  ($State | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $temporary -Encoding UTF8
  # The panel reads this same file every 2s from its UI thread, and an install
  # can easily sit under a folder a cloud sync client also keeps open. A reader
  # that does not share DELETE makes the replace fail; that used to be a
  # terminating error that unwound the whole serve loop and exited the process,
  # leaving the tray frozen on whatever it last said. Retry briefly, then give
  # up quietly: the loop rewrites this document on its very next poll anyway.
  $moved = $false
  for($attempt = 0; $attempt -lt 10; $attempt++){
    try {
      Move-Item -LiteralPath $temporary -Destination $script:StatePath -Force
      $moved = $true
      break
    } catch {
      Start-Sleep -Milliseconds 100
    }
  }
  if(-not $moved){ try { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue } catch {} }
  return $moved
}

# GLOBAL\ OBJECTS NEED AN EXPLICIT DACL, or only their creator can reach them.
#
# The loop runs as an S4U task in session 0; -Status, -Enable, -Disable and the
# tray run in the owner's interactive session. Global\ is what lets them name the
# same object -- but an object created from session 0 gets a default DACL that
# does NOT grant the interactive user, so the owner's own shell gets refused
# with "Access to the path 'Global\ServerControlMechanicalConnectStop' is
# denied." Observed live on a real deployment: the rename to Global\ fixed the
# namespace and broke the permission, which is a worse failure than the one it
# replaced, because the off switch is what stops working.
#
# Both processes run as the SAME user, so granting that user explicitly is
# sufficient and grants nothing to anybody else. These helpers are the only
# place any of the three named objects may be constructed.
function New-RendezvousObjectIdentity {
  # SSH and service environments may name a workgroup instead of the local
  # computer. Kernel object ownership must come from the actual process token.
  return [System.Security.Principal.WindowsIdentity]::GetCurrent().User
}

function New-RendezvousNamedMutex {
  param([Parameter(Mandatory=$true)][string]$Name)
  $security = New-Object System.Security.AccessControl.MutexSecurity
  $security.AddAccessRule((New-Object System.Security.AccessControl.MutexAccessRule(
    (New-RendezvousObjectIdentity),
    [System.Security.AccessControl.MutexRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow)))
  $created = $false
  try {
    return New-Object System.Threading.Mutex($false, $Name, [ref]$created, $security)
  } catch [System.UnauthorizedAccessException] {
    # An object already exists whose DACL refuses us -- created before this fix,
    # or by another account. Opening with only the rights we actually use is the
    # honest fallback; if that is refused too, the caller's own catch decides.
    return [System.Threading.Mutex]::OpenExisting($Name, [System.Security.AccessControl.MutexRights]::Synchronize -bor [System.Security.AccessControl.MutexRights]::Modify)
  }
}

function New-RendezvousStopEvent {
  $security = New-Object System.Security.AccessControl.EventWaitHandleSecurity
  $security.AddAccessRule((New-Object System.Security.AccessControl.EventWaitHandleAccessRule(
    (New-RendezvousObjectIdentity),
    [System.Security.AccessControl.EventWaitHandleRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow)))
  $created = $false
  try {
    return New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::ManualReset, $script:StopEventName, [ref]$created, $security)
  } catch [System.UnauthorizedAccessException] {
    return [System.Threading.EventWaitHandle]::OpenExisting($script:StopEventName, [System.Security.AccessControl.EventWaitHandleRights]::Modify -bor [System.Security.AccessControl.EventWaitHandleRights]::Synchronize)
  }
}

function Invoke-RendezvousStateUpdate {
  # Read-modify-write under one named mutex: the toggle and the loop both write
  # this file, and each owns different fields.
  param([Parameter(Mandatory=$true)][scriptblock]$Update)
  $mutex = New-RendezvousNamedMutex -Name $script:StateMutexName
  $held = $false
  try {
    try { $held = $mutex.WaitOne($script:StateLockTimeoutMs) } catch [System.Threading.AbandonedMutexException] { $held = $true }
    # An unsynchronised read-modify-write here is how the owner's OFF gets
    # silently undone: the toggle takes the lock and writes armed=false while
    # the loop, having timed out, writes back its pre-disable read. Refuse to
    # write at all rather than resurrect a switch the owner turned off.
    if(-not $held){ throw 'The mechanical-connect state lock could not be taken.' }
    $current = Read-RendezvousState
    $next = & $Update $current
    if($null -eq $next){ $next = $current }
    [void](Write-RendezvousState $next)
    return $next
  } finally {
    if($held){ try { $mutex.ReleaseMutex() } catch {} }
    $mutex.Dispose()
  }
}

# -------------------------------------------------------------- http server --

function Find-RendezvousHeaderEnd {
  param([byte[]]$Bytes,[int]$Length)
  if($Length -lt 4){ return -1 }
  for($index = 0; $index -le ($Length - 4); $index++){
    if($Bytes[$index] -eq 13 -and $Bytes[$index+1] -eq 10 -and $Bytes[$index+2] -eq 13 -and $Bytes[$index+3] -eq 10){
      return $index
    }
  }
  return -1
}

function Get-RendezvousContentLength {
  param([string]$HeaderText)
  foreach($line in ($HeaderText -split "`r`n")){
    if($line -imatch '^Content-Length:\s*(\d{1,7})\s*\z'){ return [int]$Matches[1] }
  }
  return 0
}

function Read-RendezvousRequest {
  # Deliberately minimal HTTP/1.1: one request, no keep-alive, no chunking.
  # Works over any Stream so the whole handler is testable without a socket.
  param([Parameter(Mandatory=$true)][System.IO.Stream]$Stream,[int]$MaxBytes = 0)
  if($MaxBytes -le 0){ $MaxBytes = $script:MaxRequestBytes }
  $memory = New-Object System.IO.MemoryStream
  $chunk = New-Object byte[] 1024
  try {
    while($true){
      $bytes = $memory.ToArray()
      $headerEnd = Find-RendezvousHeaderEnd $bytes $bytes.Length
      if($headerEnd -ge 0){
        $headerText = [System.Text.Encoding]::ASCII.GetString($bytes,0,$headerEnd)
        $contentLength = Get-RendezvousContentLength $headerText
        $available = $bytes.Length - ($headerEnd + 4)
        if($contentLength -gt $MaxBytes){ return $null }
        if($available -ge $contentLength){
          $lines = $headerText -split "`r`n"
          $requestLine = [string]$lines[0]
          $parts = $requestLine -split ' '
          if($parts.Count -lt 2){ return $null }
          $path = [string]$parts[1]
          $query = $path.IndexOf('?')
          if($query -ge 0){ $path = $path.Substring(0,$query) }
          $body = ''
          if($contentLength -gt 0){
            $body = [System.Text.Encoding]::UTF8.GetString($bytes,$headerEnd + 4,$contentLength)
          }
          return [pscustomobject][ordered]@{
            Method = ([string]$parts[0]).ToUpperInvariant()
            Path   = $path
            Body   = $body
          }
        }
      }
      if($memory.Length -ge $MaxBytes){ return $null }
      $read = $Stream.Read($chunk,0,$chunk.Length)
      if($read -le 0){ return $null }
      $memory.Write($chunk,0,$read)
    }
  } catch {
    return $null
  } finally {
    $memory.Dispose()
    [Array]::Clear($chunk,0,$chunk.Length)
  }
}

function Write-RendezvousResponse {
  param(
    [Parameter(Mandatory=$true)][System.IO.Stream]$Stream,
    [Parameter(Mandatory=$true)][int]$StatusCode,
    [Parameter(Mandatory=$true)][string]$ReasonPhrase,
    [Parameter(Mandatory=$true)]$Payload
  )
  $json = ($Payload | ConvertTo-Json -Compress -Depth 4)
  $body = [System.Text.Encoding]::UTF8.GetBytes($json)
  $header = "HTTP/1.1 $StatusCode $ReasonPhrase`r`n" +
            "Content-Type: application/json`r`n" +
            "Content-Length: $($body.Length)`r`n" +
            "Cache-Control: no-store`r`n" +
            "Connection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $Stream.Write($headerBytes,0,$headerBytes.Length)
  if($body.Length -gt 0){ $Stream.Write($body,0,$body.Length) }
  $Stream.Flush()
}

function Invoke-RendezvousConnection {
  # Serves exactly one connection. The vault write is injected as $Commit so
  # this decision path can be exercised with no vault and no network at all.
  param(
    [Parameter(Mandatory=$true)][System.IO.Stream]$Stream,
    [Parameter(Mandatory=$true)][AllowEmptyString()][string]$RemoteAddress,
    [Parameter(Mandatory=$true)]$State,
    [scriptblock]$Commit
  )
  $result = [pscustomobject][ordered]@{
    Responded  = $false
    Committed  = $false
    Generation = [int]$State.generation
    Reason     = ''
  }

  if(-not (Test-RendezvousPeerAddress -Address $RemoteAddress -PeerIp ([string]$State.peerIp))){
    # Silence, not a refusal banner: an address that is not the one peer gets
    # no bytes back at all, so nothing about this host is disclosed.
    $result.Reason = 'foreign-address'
    return $result
  }

  $request = Read-RendezvousRequest -Stream $Stream
  if($null -eq $request){
    $result.Reason = 'malformed-request'
    Write-RendezvousResponse $Stream 400 'Bad Request' ([ordered]@{ ok = $false; reason = 'malformed-request' })
    $result.Responded = $true
    return $result
  }

  if($request.Method -eq 'GET' -and $request.Path -eq '/v1/rendezvous/state'){
    $result.Reason = 'state'
    Write-RendezvousResponse $Stream 200 'OK' ([ordered]@{
      schemaVersion       = $script:WireSchema
      armed      = [bool]$State.armed
      ready      = [bool]$State.armed
      generation = [int]$State.generation
      role       = [string]$State.role
      peer       = [string]$State.peerIp
      secretValuesEmitted = $false
    })
    $result.Responded = $true
    return $result
  }

  if($request.Method -eq 'POST' -and $request.Path -eq '/v1/rendezvous/exchange'){
    $token = $null
    try {
      $payload = $null
      try { $payload = $request.Body | ConvertFrom-Json } catch { $payload = $null }
      $token = if($null -ne $payload){ [string]$payload.token } else { $null }
      $rawGeneration = if($null -ne $payload){ $payload.generation } else { $null }
      $generation = -1
      if($rawGeneration -is [int] -or $rawGeneration -is [long]){ $generation = [int]$rawGeneration }

      if(-not [bool]$State.armed){
        # Not armed: refuse before looking at the credential at all. Nothing is
        # written, and the minter learns to keep waiting.
        $result.Reason = 'not-armed'
        Write-RendezvousResponse $Stream 409 'Conflict' ([ordered]@{ ok = $false; reason = 'not-armed' })
        $result.Responded = $true
        return $result
      }
      if(([string]$State.role) -cne 'receiver'){
        # ROLE IS ENFORCED HERE, not merely documented in the header. Only the
        # machine whose own address is the higher of the two may have a
        # credential pushed into it. Without this, the minter would also
        # install whatever it was handed, so two hosts that both computed
        # `minter` (a duplicate address on a second adapter is enough) would
        # each commit the other's token, land on the same generation holding
        # DIFFERENT credentials, and then report `connected` forever with a
        # dead bridge. Refusing here makes that state loudly unreachable.
        $result.Reason = 'role-conflict'
        Write-RendezvousResponse $Stream 409 'Conflict' ([ordered]@{ ok = $false; reason = 'role-conflict' })
        $result.Responded = $true
        return $result
      }
      if(-not (Test-RendezvousToken $token)){
        $result.Reason = 'invalid-token'
        Write-RendezvousResponse $Stream 400 'Bad Request' ([ordered]@{ ok = $false; reason = 'invalid-token' })
        $result.Responded = $true
        return $result
      }
      if($generation -le [int]$State.generation){
        # Strictly increasing. A replay of a generation already committed is
        # refused, which pushes the minter to mint a fresh one instead.
        $result.Reason = 'stale-generation'
        Write-RendezvousResponse $Stream 409 'Conflict' ([ordered]@{ ok = $false; reason = 'stale-generation' })
        $result.Responded = $true
        return $result
      }
      if($generation -gt ([int]$State.generation + $script:GenerationWindow) -or $generation -gt $script:GenerationCeiling){
        # A WINDOW, not just a ceiling. Accepting anything up to int-max let a
        # single request pin the counter at the top; every later mint then
        # computed ceiling+1, threw, was swallowed, and the pair could never
        # rotate again while still reporting "waiting for peer". The minter
        # only ever offers max(local,peer)+1, so this can only refuse a jump
        # no honest minter would make.
        $result.Reason = 'generation-out-of-window'
        Write-RendezvousResponse $Stream 409 'Conflict' ([ordered]@{ ok = $false; reason = 'generation-out-of-window' })
        $result.Responded = $true
        return $result
      }
      if($null -eq $Commit){
        $result.Reason = 'no-committer'
        Write-RendezvousResponse $Stream 500 'Internal Server Error' ([ordered]@{ ok = $false; reason = 'unavailable' })
        $result.Responded = $true
        return $result
      }

      $stored = $false
      try { $stored = [bool](& $Commit $token) } catch { $stored = $false }
      if(-not $stored){
        # Fail closed: the peer is told no, so the peer does not commit either.
        $result.Reason = 'vault-write-failed'
        Write-RendezvousResponse $Stream 500 'Internal Server Error' ([ordered]@{ ok = $false; reason = 'vault-write-failed' })
        $result.Responded = $true
        return $result
      }

      # Committed locally BEFORE the acceptance receipt is sent. That ordering
      # is what lets the minter treat a matching receipt as proof the far side
      # already holds this exact generation.
      $result.Committed = $true
      $result.Generation = $generation
      $result.Reason = 'committed'
      Write-RendezvousResponse $Stream 200 'OK' ([ordered]@{
        schemaVersion       = $script:WireSchema
        ok                  = $true
        accepted            = $true
        generation          = [int]$generation
        secretValuesEmitted = $false
      })
      $result.Responded = $true
      return $result
    } finally {
      $token = $null
    }
  }

  $result.Reason = 'not-found'
  Write-RendezvousResponse $Stream 404 'Not Found' ([ordered]@{ ok = $false; reason = 'not-found' })
  $result.Responded = $true
  return $result
}

# -------------------------------------------------------------- http client --

function Invoke-RendezvousHttpRequest {
  # $Pump is the whole answer to "the loop is single-threaded". Every wait in
  # here is a short poll with the pump run between iterations, so an
  # outstanding probe or exchange no longer stops this machine answering its
  # peer. That removes both the mutual-probe livelock (two loops each blocked
  # on the other, both timing out at exactly the same instant, forever) and
  # the additive-timeout trap where the far side only begins serving us after
  # its own probe expires. $TimeoutMs is an ABSOLUTE budget for the whole
  # request, not a per-read one: a hostile or broken peer that dribbles a byte
  # just inside every read timeout used to be able to hold this open forever.
  param(
    [Parameter(Mandatory=$true)][string]$Address,
    [Parameter(Mandatory=$true)][int]$Port,
    [Parameter(Mandatory=$true)][string]$Method,
    [Parameter(Mandatory=$true)][string]$Path,
    [AllowEmptyString()][string]$Body = '',
    [Parameter(Mandatory=$true)][int]$TimeoutMs,
    [scriptblock]$Pump
  )
  $client = New-Object System.Net.Sockets.TcpClient
  $stream = $null
  $memory = $null
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $remaining = { [int][Math]::Max(0,$TimeoutMs - $watch.ElapsedMilliseconds) }
  $wait = {
    param($Handle)
    # Poll in pump-sized slices until the operation completes or the absolute
    # deadline passes. Returns $true only when the handle actually signalled.
    while($true){
      $left = & $remaining
      if($left -le 0){ return $false }
      $slice = [Math]::Min($script:PumpIntervalMs,$left)
      if($Handle.WaitOne($slice)){ return $true }
      if($Pump){ try { [void](& $Pump) } catch {} }
    }
  }
  try {
    $client.SendTimeout = $TimeoutMs
    $client.ReceiveTimeout = $TimeoutMs
    $connect = $client.BeginConnect($Address,$Port,$null,$null)
    if(-not (& $wait $connect.AsyncWaitHandle)){ return $null }
    $client.EndConnect($connect)
    $stream = $client.GetStream()
    $stream.ReadTimeout = $TimeoutMs
    $stream.WriteTimeout = $TimeoutMs

    $bodyBytes = if([string]::IsNullOrEmpty($Body)){ New-Object byte[] 0 } else { [System.Text.Encoding]::UTF8.GetBytes($Body) }
    $header = "$Method $Path HTTP/1.1`r`n" +
              "Host: ${Address}:${Port}`r`n" +
              "Content-Type: application/json`r`n" +
              "Content-Length: $($bodyBytes.Length)`r`n" +
              "Connection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $stream.Write($headerBytes,0,$headerBytes.Length)
    if($bodyBytes.Length -gt 0){ $stream.Write($bodyBytes,0,$bodyBytes.Length) }
    $stream.Flush()
    [Array]::Clear($bodyBytes,0,$bodyBytes.Length)

    $memory = New-Object System.IO.MemoryStream
    $chunk = New-Object byte[] 1024
    while($true){
      if((& $remaining) -le 0){ return $null }
      $pending = $stream.BeginRead($chunk,0,$chunk.Length,$null,$null)
      if(-not (& $wait $pending.AsyncWaitHandle)){ return $null }
      $read = $stream.EndRead($pending)
      if($read -le 0){ break }
      $memory.Write($chunk,0,$read)
      if($memory.Length -ge $script:MaxResponseBytes){ break }
    }
    $bytes = $memory.ToArray()
    $headerEnd = Find-RendezvousHeaderEnd $bytes $bytes.Length
    if($headerEnd -lt 0){ return $null }
    $headerText = [System.Text.Encoding]::ASCII.GetString($bytes,0,$headerEnd)
    $statusLine = ([string](($headerText -split "`r`n")[0]))
    if($statusLine -notmatch '^HTTP/1\.[01] (\d{3})'){ return $null }
    $statusCode = [int]$Matches[1]
    $responseBody = [System.Text.Encoding]::UTF8.GetString($bytes,$headerEnd + 4,$bytes.Length - ($headerEnd + 4))
    return [pscustomobject][ordered]@{ StatusCode = $statusCode; Body = $responseBody }
  } catch {
    return $null
  } finally {
    if($memory){ $memory.Dispose() }
    if($stream){ try { $stream.Dispose() } catch {} }
    try { $client.Close() } catch {}
  }
}

function Get-RendezvousPeerState {
  param([Parameter(Mandatory=$true)][string]$Address,[int]$Port = 0,[scriptblock]$Pump)
  if($Port -le 0){ $Port = $script:RendezvousPort }
  $response = Invoke-RendezvousHttpRequest -Address $Address -Port $Port -Method 'GET' `
    -Path '/v1/rendezvous/state' -Body '' -TimeoutMs $script:PeerProbeTimeoutMs -Pump $Pump
  if($null -eq $response -or $response.StatusCode -ne 200){ return $null }
  $parsed = $null
  try { $parsed = $response.Body | ConvertFrom-Json } catch { return $null }
  if($null -eq $parsed){ return $null }
  # The first implementation of this end shipped `armed`; the agreed peer
  # contract settled on `ready`. Accept either spelling only when it is a
  # literal boolean true so a string or number cannot silently arm a peer.
  $peerArmed = (($parsed.armed -is [bool]) -and [bool]$parsed.armed) -or
    (($parsed.ready -is [bool]) -and [bool]$parsed.ready)
  return [pscustomobject][ordered]@{
    Armed      = [bool]$peerArmed
    Generation = ConvertTo-RendezvousInt $parsed.generation 0
    Role       = [string]$parsed.role
    Peer       = [string]$parsed.peer
  }
}

# ------------------------------------------------------------------- policy --

function Get-RendezvousPlan {
  # The whole decision, with no I/O, so it can be proved exhaustively.
  param(
    [string]$LocalIp,
    [int]$LocalGeneration = 0,
    [bool]$PeerReachable = $false,
    [bool]$PeerArmed = $false,
    [int]$PeerGeneration = 0,
    [AllowEmptyString()][string]$PeerRole = '',
    [bool]$MintBlocked = $false
  )
  $role = Get-RendezvousRole $LocalIp
  if(-not $role){
    return [pscustomobject][ordered]@{
      Action = 'wait-link'; Role = $null; NextGeneration = [int]$LocalGeneration; Connected = $false
      Status = 'no-link'; Detail = 'waiting for the direct Ethernet link'
    }
  }
  if($PeerReachable -and $PeerRole -and $PeerRole -ceq $role){
    # The peer advertises the same role we computed. That is only possible if
    # one of us is reading a direct-link address it does not really own, so
    # neither machine may act: minting here would push a key to a host that
    # believes it is also the minter. Say so instead of quietly proceeding.
    return [pscustomobject][ordered]@{
      Action = 'wait-peer'; Role = $role; NextGeneration = [int]$LocalGeneration; Connected = $false
      Status = 'attention'; Detail = 'both machines claim the same direct-link address'
    }
  }
  if(-not $PeerReachable){
    return [pscustomobject][ordered]@{
      Action = 'wait-peer'; Role = $role; NextGeneration = [int]$LocalGeneration; Connected = $false
      Status = 'waiting-for-peer'; Detail = 'peer is not answering on 8795'
    }
  }
  if(-not $PeerArmed){
    return [pscustomobject][ordered]@{
      Action = 'wait-peer'; Role = $role; NextGeneration = [int]$LocalGeneration; Connected = $false
      Status = 'waiting-for-peer'; Detail = 'peer is reachable but not switched on'
    }
  }
  if($LocalGeneration -gt 0 -and $PeerGeneration -eq $LocalGeneration){
    # Generation idempotency: already agreed, so do NOT mint. Re-minting on
    # every poll would thrash a working credential several times a minute.
    return [pscustomobject][ordered]@{
      Action = 'idle'; Role = $role; NextGeneration = [int]$LocalGeneration; Connected = $true
      Status = 'connected'; Detail = 'keys exchanged'
    }
  }
  if($role -eq 'minter'){
    # [long], then clamped, then cast. [Math]::Max on two int-maxes promotes to
    # Double and the [int] cast used to throw out of the whole serve loop.
    $next = [long][Math]::Max([long]$LocalGeneration,[long]$PeerGeneration) + 1L
    if($next -gt [long]$script:GenerationCeiling){
      return [pscustomobject][ordered]@{
        Action = 'wait-peer'; Role = $role; NextGeneration = [int]$LocalGeneration; Connected = $false
        Status = 'attention'; Detail = 'the key counter is exhausted and cannot advance'
      }
    }
    if($MintBlocked){
      # Repeated failures already rotated the peer's key more than once with
      # nothing to show for it. Keep saying so rather than minting again on
      # this tick; the caller is backing the poll interval off.
      return [pscustomobject][ordered]@{
        Action = 'wait-peer'; Role = $role; NextGeneration = [int]$next; Connected = $false
        Status = 'attention'; Detail = 'this machine cannot store a new key - retrying slowly'
      }
    }
    return [pscustomobject][ordered]@{
      Action = 'mint'; Role = $role; NextGeneration = [int]$next; Connected = $false
      Status = 'exchanging'; Detail = 'minting a new key for the peer'
    }
  }
  return [pscustomobject][ordered]@{
    Action = 'await-mint'; Role = $role; NextGeneration = [int]$LocalGeneration; Connected = $false
    Status = 'waiting-for-peer'; Detail = 'waiting for the minter to send a key'
  }
}

function Invoke-RendezvousExchange {
  # Minter side. Mint -> push -> ONLY on a literal acceptance whose numeric
  # generation exactly matches the offer write our own vault.
  # There is no path here that writes locally first.
  param(
    [Parameter(Mandatory=$true)][string]$Address,
    [Parameter(Mandatory=$true)][int]$Generation,
    [int]$Port = 0,
    [scriptblock]$Commit,
    [scriptblock]$Pump,
    [switch]$SelfTest
  )
  if($Port -le 0){ $Port = $script:RendezvousPort }
  if($SelfTest){
    # The only address a self-test may target is this machine's own loopback,
    # so the escape hatch can never be aimed at a real host.
    if($Address -cne '127.0.0.1'){ throw 'A self-test exchange may only target 127.0.0.1.' }
  } else {
    $peer = Get-RendezvousPeer (Get-RendezvousLinkAddress)
    if(-not (Test-RendezvousPeerAddress -Address $Address -PeerIp $peer)){
      throw 'An exchange may only target the exact direct-link peer address.'
    }
  }
  if($Generation -le 0 -or $Generation -gt $script:GenerationCeiling){ throw 'Generation must be a positive integer.' }
  if($null -eq $Commit){ $Commit = $script:CommitCredential }

  $result = [pscustomobject][ordered]@{
    Pushed = $false; Committed = $false; Generation = [int]$Generation; Reason = ''
  }
  $token = $null
  try {
    $token = New-RendezvousToken
    $payload = ([ordered]@{ token = $token; generation = [int]$Generation } | ConvertTo-Json -Compress)
    $response = Invoke-RendezvousHttpRequest -Address $Address -Port $Port -Method 'POST' `
      -Path '/v1/rendezvous/exchange' -Body $payload -TimeoutMs $script:PeerExchangeTimeoutMs -Pump $Pump
    $payload = $null
    if($null -eq $response){ $result.Reason = 'peer-unreachable'; return $result }
    if($response.StatusCode -ne 200){ $result.Reason = 'peer-refused'; return $result }
    $parsed = $null
    try { $parsed = $response.Body | ConvertFrom-Json } catch { $parsed = $null }
    # A LITERAL boolean true, checked by type. `$parsed.ok -ne $true` coerces
    # the right operand to the left's type, so {"ok":"true"} and {"ok":1} both
    # compared equal and unlocked the local write. `accepted` is the peer's
    # original spelling; `ok` is retained for compatibility.
    $accepted = $false
    if($null -ne $parsed){
      $accepted = (($parsed.ok -is [bool]) -and [bool]$parsed.ok) -or
        (($parsed.accepted -is [bool]) -and [bool]$parsed.accepted)
    }
    if(-not $accepted){ $result.Reason = 'peer-refused'; return $result }

    # Acceptance alone is not enough: without an exact generation receipt a
    # stale or unrelated 200 response could authorize a different local write.
    # Reject doubles, numeric strings, a missing field, and any mismatch.
    $receiptGeneration = if($null -ne $parsed){ $parsed.generation } else { $null }
    $generationMatches = (($receiptGeneration -is [int]) -or ($receiptGeneration -is [long])) -and
      ([long]$receiptGeneration -eq [long]$Generation)
    if(-not $generationMatches){ $result.Reason = 'peer-generation-mismatch'; return $result }
    $result.Pushed = $true

    # ---- the peer already holds this key; only now may we store it ----
    $stored = $false
    try { $stored = [bool](& $Commit $token) } catch { $stored = $false }
    if(-not $stored){
      # The peer moved to this generation and we did not. We deliberately do
      # NOT advance our generation, so the next poll sees the mismatch and
      # mints a fresh, strictly higher generation. The pair re-converges by
      # itself and the credential currently in use was never destroyed.
      $result.Reason = 'local-vault-write-failed'
      return $result
    }
    $result.Committed = $true
    $result.Reason = 'committed'
    return $result
  } finally {
    $token = $null
  }
}

# ------------------------------------------------------------ local plumbing --

function Test-RendezvousLocalListener {
  # Pure .NET, no CIM: this runs inside the poll loop.
  param([Parameter(Mandatory=$true)][string]$Address,[Parameter(Mandatory=$true)][int]$Port)
  try {
    foreach($endpoint in [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()){
      if([int]$endpoint.Port -ne $Port){ continue }
      $text = $endpoint.Address.ToString()
      if($text -eq $Address -or $text -eq '0.0.0.0' -or $text -eq '::'){ return $true }
    }
  } catch {}
  return $false
}

function Stop-RendezvousBridgeProcess {
  # Only the exact declared bridge process is ever stopped. An unrelated
  # listener on that port is left completely alone.
  param([Parameter(Mandatory=$true)][string]$LocalIp)
  $entry = if($script:RepoRoot){ Join-Path $script:RepoRoot 'src\remote-agent-bridge.js' } else { $null }
  if(-not $entry){ return $false }
  $stopped = $false
  try {
    foreach($connection in @(Get-NetTCPConnection -LocalAddress $LocalIp -LocalPort $script:BridgePort -State Listen -ErrorAction SilentlyContinue)){
      $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
      if(-not $owner){ continue }
      $executable = [string]$owner.ExecutablePath
      $commandLine = [string]$owner.CommandLine
      if($executable -notmatch '\\node\.exe\z'){ continue }
      if($commandLine -notmatch 'remote-agent-bridge\.js'){ continue }
      try { Stop-Process -Id $connection.OwningProcess -Force -ErrorAction SilentlyContinue; $stopped = $true } catch {}
    }
  } catch {}
  return $stopped
}

function Restart-RendezvousBridgeListener {
  # A bridge that is ALREADY listening is restarted so it picks up the key that
  # was just committed. Whether the bridge should run at all is not this
  # toggle's decision, so a bridge that is not running is left off.
  #
  # Returns 'skipped' (nothing of ours was running), 'restarted' (it came back)
  # or 'down' (we stopped it and it did not return). The last one has to reach
  # the tray: an unverified fire-and-forget respawn is how "Tunnel: connected"
  # ends up on screen with nothing at all listening on 8788.
  param([Parameter(Mandatory=$true)][string]$LocalIp)
  if(-not $script:RepoRoot){ return 'skipped' }
  if(-not (Test-RendezvousLocalListener -Address $LocalIp -Port $script:BridgePort)){ return 'skipped' }
  $starter = Join-Path $script:RepoRoot 'tools\start-remote-agent-bridge.ps1'
  if(-not (Test-Path -LiteralPath $starter -PathType Leaf)){ return 'skipped' }
  # Only claim a restart if the process we stopped was OUR bridge. Something
  # else holding 8788 must not cause us to spawn a second bridge that can
  # never bind.
  if(-not (Stop-RendezvousBridgeProcess -LocalIp $LocalIp)){ return 'skipped' }
  for($attempt = 0; $attempt -lt 40; $attempt++){
    if(-not (Test-RendezvousLocalListener -Address $LocalIp -Port $script:BridgePort)){ break }
    Start-Sleep -Milliseconds 250
  }
  [void](Start-RendezvousHiddenProcess -File $script:PowerShellPath -Arguments @(
    '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass',
    '-File',$starter,'-HostAddress',$LocalIp
  ))
  for($attempt = 0; $attempt -lt 40; $attempt++){
    if(Test-RendezvousLocalListener -Address $LocalIp -Port $script:BridgePort){ return 'restarted' }
    Start-Sleep -Milliseconds 250
  }
  return 'down'
}

function Start-RendezvousHiddenProcess {
  # R193: no console window, ever. No shell, no window, nothing to flash.
  #
  # The pipes are redirected and drained into the bit bucket, not left
  # inherited. This launches the long-lived -Serve loop, and an unredirected
  # child inherits its parent's stdout handle and keeps it open for its whole
  # life - so anything that waits for -Enable to finish waits for the SERVE
  # LOOP instead, which is days. Redirecting also satisfies the package's own
  # "never an unredirected long-lived process" rule; the output is discarded
  # rather than logged because nothing this process prints is a secret and
  # nothing it prints is worth making the owner read a file for. Faults are
  # published to the state document, which the tray renders.
  param([Parameter(Mandatory=$true)][string]$File,[string[]]$Arguments = @())
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $File
  $psi.Arguments = ConvertTo-RendezvousArgumentString $Arguments
  $psi.WorkingDirectory = if($script:RepoRoot){ $script:RepoRoot } else { $PSScriptRoot }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  try {
    if($process.Start()){
      # Asynchronous, so a full pipe buffer can never block the child and this
      # function never waits for it.
      [void]$process.StandardOutput.BaseStream.CopyToAsync([System.IO.Stream]::Null)
      [void]$process.StandardError.BaseStream.CopyToAsync([System.IO.Stream]::Null)
      return $process.Id
    }
  } catch {}
  return $null
}

function Test-RendezvousLoopAlive {
  $existing = $null
  try {
    if([System.Threading.Mutex]::TryOpenExisting($script:LoopMutexName,[ref]$existing)){
      $existing.Dispose()
      return $true
    }
  } catch {}
  return $false
}

function Test-RendezvousTaskPresent {
  try { return ($null -ne (Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue)) } catch { return $false }
}

function Register-RendezvousTask {
  # THE TASK RUNS THE LOOP ITSELF, HIDDEN, WITH NO TIME LIMIT.
  #
  # History, because the constraints that shaped this are still the constraints.
  # This once carried a second trigger that ran -Enable every 5 minutes for 3650
  # days. Two things were wrong with it. Task Scheduler launches powershell.exe
  # itself, so none of this package's careful native CreateNoWindow path applies
  # and -WindowStyle Hidden only takes effect after the console has already been
  # allocated -- a flash on the owner's desktop every five minutes, forever,
  # which is exactly what R193 exists to prevent. And because -Enable re-arms
  # unconditionally, a Disable whose unregister failed would silently switch the
  # machine back on minutes later. Both objections were correct. Healing was
  # handed to the tray panel instead.
  #
  # That left the loop with no keeper at all whenever the panel is not running,
  # which is an entirely ordinary state -- ServerPanelWatchdog can be disabled
  # and nothing obliges the panel to be open -- so nothing restarted the
  # rendezvous after a crash, and a live listener could only be a hand-started
  # orphan. Three changes make the task the keeper without reviving either
  # fault:
  #
  #   S4U. The task runs in session 0 with no desktop, so it CANNOT flash a
  #   console. R193's objection was to a visible window; a session-0 task has
  #   nowhere to draw one. (This is also why the named objects above are Global\.)
  #
  #   The action is -Serve, not -Enable. -Serve honours `armed` and exits when it
  #   is false, so the task can never re-arm a machine the owner switched off --
  #   the second objection, answered by construction rather than by removing the
  #   trigger.
  #
  #   ExecutionTimeLimit Zero. The old PT3M would have killed the loop's own job
  #   object three minutes after the first real logon fire. It was never observed
  #   only because the task had never once run. Every other long-lived task in
  #   this repo uses Zero for the same reason.
  #
  # No cadence trigger: a repetition plus StartWhenAvailable is a startup trigger
  # in disguise, and this product does not start itself with Windows unless the
  # owner asked. The sign-in trigger comes from that switch alone, via
  # tools\lib\StartupPolicy.ps1 -- with it off this task has NO trigger and is
  # started only by tools\direct-link.ps1 -On, i.e. because a person pressed ON.
  try {
    $argument = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Serve"
    $action = New-ScheduledTaskAction -Execute $script:PowerShellPath -Argument $argument

    $startupPolicy = if($script:RepoRoot){ Join-Path $script:RepoRoot 'tools\lib\StartupPolicy.ps1' } else { $null }
    $triggers = @()
    $enabled = $true
    if($startupPolicy -and (Test-Path -LiteralPath $startupPolicy -PathType Leaf)){
      . $startupPolicy
      # ASSIGN, THEN COUNT. @(New-ToolsEnabledTaskTriggers ...) around the CALL
      # would report 1 for an empty set: the helper returns ,$triggers so the
      # empty array survives as a single pipeline object, and @() then collects
      # that one object. `$x = f` binds the array itself, so an empty set counts
      # as 0. Getting this wrong passes Register-ScheduledTask an empty -Trigger,
      # which it rejects -- registration would fail on exactly the machines where
      # the startup switch is off, i.e. the default.
      $triggers = New-ToolsEnabledTaskTriggers -OnDemand -IncludeLogon -OwnerUser ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -RepoRoot $script:RepoRoot
      $enabled = [bool](Test-ToolsEnabledTaskShouldBeEnabled -OnDemand -RepoRoot $script:RepoRoot)
    }

    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
      -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Hidden `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit ([TimeSpan]::Zero)
    if(-not $enabled){ $settings.Enabled = $false }

    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited

    # Register-ScheduledTask rejects an empty -Trigger, which is exactly what an
    # on-demand task has while the switch is off. Omit the parameter entirely
    # then: a triggerless task is valid and is what Task Scheduler calls "On
    # demand".
    $registerArgs = @{
      TaskName    = $script:TaskName
      Action      = $action
      Settings    = $settings
      Principal   = $principal
      Description = 'ServerControl mechanical key rendezvous on the direct Ethernet link. Resident loop, started on demand by tools\direct-link.ps1 -On.'
      Force       = $true
    }
    if(@($triggers).Count -gt 0){ $registerArgs['Trigger'] = $triggers }
    # -ErrorAction Stop, and then VERIFY.
    #
    # Register-ScheduledTask is a CIM cmdlet: an "Access is denied" from it
    # arrives as a non-terminating error that does NOT honour the script's
    # $ErrorActionPreference, so without this the failure printed a raw error
    # to whatever console was attached and then fell through to `return $true` --
    # reporting a keeper it had not installed. Observed live when an unelevated
    # -Enable followed an elevated setup.
    Register-ScheduledTask @registerArgs -ErrorAction Stop | Out-Null
    # Registration is a claim about Windows, so read it back from Windows.
    return (Test-RendezvousTaskPresent)
  } catch { return $false }
}

# Starting the loop: prefer the task, fall back to the direct spawn.
#
# The task is what makes a crashed loop come back (RestartOnFailure), so a loop
# started outside it is strictly weaker. The fallback exists because registering
# needs an administrator and arming must not: on a machine where the task is not
# registered yet, -Enable still brings the lane up for this session and -Status
# reports taskRegistered=false so the weakness is visible rather than assumed.
function Start-RendezvousServeProcess {
  if(Test-RendezvousTaskPresent){
    try {
      Start-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop
      return 'task'
    } catch { }
  }
  [void](Start-RendezvousHiddenProcess -File $script:PowerShellPath -Arguments @(
    '-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass',
    '-File',$PSCommandPath,'-Serve'
  ))
  return 'process'
}

function Unregister-RendezvousTask {
  # Checked, not hoped for. A surviving task is the difference between "the
  # owner turned it off" and "the owner turned it off and it comes back at the
  # next sign-in", so the result has to be reportable.
  for($attempt = 0; $attempt -lt 3; $attempt++){
    try { Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
    if(-not (Test-RendezvousTaskPresent)){ return $true }
    Start-Sleep -Milliseconds 250
  }
  return (-not (Test-RendezvousTaskPresent))
}

# --------------------------------------------------------------- serve loop --

function Invoke-RendezvousPendingConnections {
  param($Listener,$State)
  $committed = $false
  if($null -eq $Listener){ return $false }
  while($true){
    $pending = $false
    try { $pending = $Listener.Pending() } catch { $pending = $false }
    if(-not $pending){ break }
    $client = $null
    try {
      $client = $Listener.AcceptTcpClient()
      $client.ReceiveTimeout = $script:ConnectionTimeoutMs
      $client.SendTimeout = $script:ConnectionTimeoutMs
      $remote = ''
      $endpoint = $client.Client.RemoteEndPoint
      if($endpoint -and $endpoint.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork){
        $remote = $endpoint.Address.ToString()
      }
      $stream = $client.GetStream()
      $stream.ReadTimeout = $script:ConnectionTimeoutMs
      $stream.WriteTimeout = $script:ConnectionTimeoutMs
      $outcome = Invoke-RendezvousConnection -Stream $stream -RemoteAddress $remote -State $State -Commit $script:CommitCredential
      if($outcome.Committed){
        $State.generation = [int]$outcome.Generation
        $State.connected = $true
        $committed = $true
      }
    } catch {
    } finally {
      if($client){ try { $client.Close() } catch {} }
    }
  }
  return $committed
}

function Start-RendezvousLoop {
  $mutex = New-RendezvousNamedMutex -Name $script:LoopMutexName
  $held = $false
  try { $held = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $held = $true }
  if(-not $held){ $mutex.Dispose(); return }

  # A DEAD LOOP USED TO LEAVE "connected: true" ON DISK FOREVER.
  #
  # Nothing cleared this field when the loop stopped, at a reboot, or on entry,
  # so a machine whose loop had been killed kept publishing the last thing it
  # managed to say -- normally `connected: true, status: connected`. Every reader
  # believed it: the packet's CONNECT.ps1 gates on exactly that and SKIPS
  # re-enabling, and the tray's only contradiction was a 420-second staleness
  # check that runs inside the panel, which is not running. The one state that
  # must never be inferred is the one that says the link is fine.
  #
  # Clearing it here means the claim can only ever be made by a loop that is
  # actually turning: the first successful exchange sets it true again within a
  # poll. `armed` and `generation` are untouched -- the owner's switch and the
  # agreed credential both survive a restart, which is the point of keeping them
  # in this file at all.
  [void](Invoke-RendezvousStateUpdate -Update {
    param($current)
    $current.connected = $false
    $current.loopPid = $PID
    if([string]$current.status -eq 'connected'){
      $current.status = 'starting'
      $current.detail = 'checking the link'
    }
    return $current
  })

  $stop = New-RendezvousStopEvent
  $listener = $null
  $bound = $null
  $mintFailures = 0
  $random = New-Object System.Random
  try {
    while($true){
      # One iteration must never be able to kill the loop. A peer that reports
      # a non-numeric generation, a corrupt local state file, or a state write
      # that loses a race with the panel's 2s read all used to unwind out of
      # here and exit the process, leaving the tray frozen on its last text
      # with nothing running behind it.
      try {
      $state = Read-RendezvousState
      if(-not [bool]$state.armed){ break }
      if($stop.WaitOne(0)){ break }

      $localIp = Get-RendezvousLinkAddress
      $state.localIp = $localIp
      $state.peerIp = Get-RendezvousPeer $localIp
      $state.role = Get-RendezvousRole $localIp
      $state.loopPid = [int]$PID

      if($listener -and $bound -cne $localIp){
        try { $listener.Stop() } catch {}
        $listener = $null; $bound = $null
      }
      if(-not $listener -and $localIp){
        try {
          # Bound to this one address. Never 0.0.0.0, never a wildcard.
          $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Parse($localIp)),$script:RendezvousPort
          $listener.Start()
          $bound = $localIp
        } catch {
          $listener = $null; $bound = $null
        }
      }

      # Handed to every outstanding request so the peer is served while we
      # wait on it. Captured by reference: $state, $listener and $pumpResult
      # are the same objects the loop body reads. A commit that happens inside
      # a pumped wait still has to restart the bridge - otherwise a key
      # accepted during a probe leaves the bridge running on the old one while
      # the pair reports connected.
      $pumpResult = @{ Committed = $false }
      $pump = {
        if($listener -and (Invoke-RendezvousPendingConnections $listener $state)){ $pumpResult.Committed = $true }
      }.GetNewClosure()

      $restartBridge = $false
      if(-not $localIp){
        $state.connected = $false
        $state.status = 'no-link'
        $state.detail = 'waiting for the direct Ethernet link'
      } elseif(-not $listener){
        $state.connected = $false
        $state.status = 'attention'
        $state.detail = "port $($script:RendezvousPort) on $localIp could not be opened"
      } else {
        if(Invoke-RendezvousPendingConnections $listener $state){ $restartBridge = $true }
        $peerState = Get-RendezvousPeerState -Address $state.peerIp -Pump $pump
        $plan = Get-RendezvousPlan -LocalIp $localIp -LocalGeneration ([int]$state.generation) `
          -PeerReachable ([bool]($null -ne $peerState)) `
          -PeerArmed ([bool]($null -ne $peerState -and $peerState.Armed)) `
          -PeerGeneration ([int]$(if($peerState){ $peerState.Generation } else { 0 })) `
          -PeerRole ([string]$(if($peerState){ $peerState.Role } else { '' })) `
          -MintBlocked ([bool]($mintFailures -ge $script:MintFailureBackoffAfter))
        $state.connected = [bool]$plan.Connected
        $state.status = [string]$plan.Status
        $state.detail = [string]$plan.Detail
        if([bool]$plan.Connected){ $mintFailures = 0 }
        if($plan.Action -eq 'mint'){
          # LAST CHANCE TO OBEY THE OWNER. The probe above can take a minute
          # and a half, and pushing now would rotate the peer's credential and
          # restart its bridge after the switch was already turned off. Re-read
          # the persisted switch rather than trusting the copy this iteration
          # started with.
          $stillArmed = $false
          try { $stillArmed = [bool](Read-RendezvousState).armed } catch { $stillArmed = $false }
          if((-not $stillArmed) -or $stop.WaitOne(0)){ break }

          $exchange = $null
          try {
            $exchange = Invoke-RendezvousExchange -Address $state.peerIp -Generation ([int]$plan.NextGeneration) -Pump $pump
          } catch { $exchange = $null }
          if($exchange -and $exchange.Committed){
            $mintFailures = 0
            $state.generation = [int]$exchange.Generation
            $state.connected = $true
            $state.status = 'connected'
            $state.detail = 'keys exchanged'
            $restartBridge = $true
          } elseif($exchange -and $exchange.Pushed){
            # THE SPLIT. The peer stored this key and restarted its bridge; we
            # did not. Do not launder this into "waiting for peer" - the two
            # machines are genuinely out of step and the owner is entitled to
            # know. Our generation is deliberately left behind, so the next
            # poll mints a strictly higher one and the pair re-converges.
            $mintFailures += 1
            $state.connected = $false
            $state.status = 'attention'
            $state.detail = "the other machine took a new key and this one could not store it ($($exchange.Reason))"
          } else {
            $mintFailures += 1
            $state.connected = $false
            $state.status = 'waiting-for-peer'
            $state.detail = if($exchange){ "exchange did not complete ($($exchange.Reason))" } else { 'exchange did not complete' }
          }
        }
      }

      if($pumpResult.Committed){ $restartBridge = $true }
      if($restartBridge -and $localIp){
        if((Restart-RendezvousBridgeListener -LocalIp $localIp) -ceq 'down'){
          $state.status = 'attention'
          $state.detail = "the key was exchanged but the bridge on port $($script:BridgePort) did not come back"
        }
      }
      Save-RendezvousLoopState $state

      # Jittered, and backed off while mints keep failing. Without jitter two
      # loops that once timed out together stay in lockstep and re-probe
      # within milliseconds of each other forever; without backoff a
      # permanently unwritable local vault rotates the peer's credential and
      # kills its bridge six times a minute.
      $interval = [double]$script:PollIntervalMs
      if($mintFailures -gt 0){
        $interval = $interval * [Math]::Pow(2,[Math]::Min($mintFailures,6))
        $interval = [Math]::Min($interval,[double]$script:PollIntervalMaxMs)
      }
      $interval = $interval * (1.0 + ($script:PollJitterFraction * ((2.0 * $random.NextDouble()) - 1.0)))
      $deadline = (Get-Date).AddMilliseconds([Math]::Max(1000.0,$interval))
      while((Get-Date) -lt $deadline){
        if($stop.WaitOne(200)){ break }
        if($listener -and (Invoke-RendezvousPendingConnections $listener $state)){
          if($localIp){
            if((Restart-RendezvousBridgeListener -LocalIp $localIp) -ceq 'down'){
              $state.status = 'attention'
              $state.detail = "the key was exchanged but the bridge on port $($script:BridgePort) did not come back"
            }
          }
          Save-RendezvousLoopState $state
          break
        }
      }
      } catch {
        # Report the fault WITHOUT touching the generation. Going through
        # Save-RendezvousLoopState here would write this iteration's
        # in-memory copy, and if the fault happened before the state was even
        # read that copy is a fresh zero - which would silently reset the
        # credential epoch and force a needless rotation on both machines.
        try {
          [void](Invoke-RendezvousStateUpdate {
            param($current)
            $current.loopPid = [int]$PID
            if([bool]$current.armed){
              $current.connected = $false
              $current.status = 'attention'
              $current.detail = 'the connect loop hit an unexpected fault and is retrying'
            }
            return $current
          })
        } catch {}
        Start-Sleep -Milliseconds $script:PollIntervalMs
      }
    }
  } finally {
    if($listener){ try { $listener.Stop() } catch {} }
    $stop.Dispose()
    try { $mutex.ReleaseMutex() } catch {}
    $mutex.Dispose()
  }
}

function Save-RendezvousLoopState {
  # The loop owns every field except `armed`, which is the owner's switch and
  # must never be resurrected by a stale in-memory copy.
  param($State)
  try {
    [void](Invoke-RendezvousStateUpdate {
      param($current)
      $current.generation = [int]$State.generation
      $current.connected  = [bool]$State.connected
      $current.role       = $State.role
      $current.localIp    = $State.localIp
      $current.peerIp     = $State.peerIp
      $current.loopPid    = [int]$State.loopPid
      if(-not [bool]$current.armed){
        $current.connected = $false
        # A FAULT OUTLIVES THE SWITCH. Everything else collapses to 'off',
        # because a stale loop copy must never make a disabled machine look
        # busy - but a split credential or a dead bridge discovered during the
        # disable is the one thing the owner most needs to see, and blanking it
        # to 'off' is how the only evidence used to disappear.
        if([string]$State.status -ceq 'attention'){
          $current.status = 'attention'
          $current.detail = [string]$State.detail
        } else {
          $current.status = 'off'
          $current.detail = ''
        }
      } else {
        $current.status = [string]$State.status
        $current.detail = [string]$State.detail
      }
      return $current
    }.GetNewClosure())
  } catch {
    # The state lock was unavailable, so nothing was written. Never fall
    # through to an unsynchronised write: that is how the owner's OFF gets
    # overwritten by a pre-disable read. The next poll rewrites this anyway.
  }
}

# ------------------------------------------------------------------ actions --

function Test-RendezvousVaultToolPresent {
  if(-not $script:RepoRoot){ return $false }
  return (Test-Path -LiteralPath (Join-Path $script:RepoRoot 'tools\secrets.ps1') -PathType Leaf)
}

function Get-RendezvousStatusObject {
  $state = Read-RendezvousState
  $localIp = Get-RendezvousLinkAddress
  $serving = $false
  if($localIp){ $serving = Test-RendezvousLocalListener -Address $localIp -Port $script:RendezvousPort }
  # `serving`, `loopAlive` and `taskRegistered` are EVIDENCE, not the switch's
  # own opinion of itself. Without them a caller cannot tell "armed and
  # running" from "armed and nothing is behind it", which is precisely the
  # state the tray used to render as healthy.
  return [pscustomobject][ordered]@{
    schema         = $script:Schema
    armed          = [bool]$state.armed
    generation     = [int]$state.generation
    connected      = [bool]$state.connected
    serving        = [bool]$serving
    loopAlive      = [bool](Test-RendezvousLoopAlive)
    taskRegistered = [bool](Test-RendezvousTaskPresent)
    role           = Get-RendezvousRole $localIp
    local          = $localIp
    peer           = Get-RendezvousPeer $localIp
    port           = [int]$script:RendezvousPort
    status         = [string]$state.status
    detail         = [string]$state.detail
    updatedAt      = $state.updatedAt
  }
}

function Enable-Rendezvous {
  if(-not $script:StatePath){ throw 'The ToolsEnabled repository root could not be resolved on this machine.' }
  $localIp = Get-RendezvousLinkAddress
  # Computed outside the closure purely for readability; both forms resolve.
  # (An audit claimed GetNewClosure() rebinds the block to a module scope that
  # cannot see script-level functions and that -Enable therefore always threw
  # CommandNotFoundException. That was checked against a real `-File` run of
  # this script and is false: the state file is written and the switch arms.
  # The pre-computation is kept anyway because it reads better.)
  $peerIp = Get-RendezvousPeer $localIp
  $role = Get-RendezvousRole $localIp

  # Refuse to arm a machine that physically cannot store a key. Arming anyway
  # would make the minter push a fresh credential to the peer every poll,
  # rotating the far side's key and restarting its bridge over and over while
  # never being able to hold its own end of the pair.
  if(-not (Test-RendezvousVaultToolPresent)){
    [void](Invoke-RendezvousStateUpdate {
      param($current)
      $current.armed = $false
      $current.connected = $false
      $current.status = 'attention'
      $current.detail = 'the ToolsEnabled key store could not be found on this machine'
      return $current
    })
    return Get-RendezvousStatusObject
  }

  [void](Invoke-RendezvousStateUpdate {
    param($current)
    $current.armed = $true
    $current.localIp = $localIp
    $current.peerIp = $peerIp
    $current.role = $role
    if([bool]$current.connected){
      $current.status = 'connected'; $current.detail = 'keys exchanged'
    } elseif($localIp){
      $current.status = 'waiting-for-peer'; $current.detail = 'waiting for the other machine'
    } else {
      $current.status = 'no-link'; $current.detail = 'waiting for the direct Ethernet link'
    }
    return $current
  }.GetNewClosure())

  $stop = New-RendezvousStopEvent
  try { [void]$stop.Reset() } finally { $stop.Dispose() }

  # REGISTRATION FAILURE IS REPORTED, NOT SWALLOWED.
  #
  # This was [void](Register-RendezvousTask), so an -Enable that could not
  # register the task returned a cheerful "armed" with no keeper installed --
  # the machine would work until the first crash and then stay down, and nothing
  # said so. Registration needs an administrator, and arming deliberately does
  # not, so an unelevated -Enable failing here is the ORDINARY case rather than
  # an error: it arms, it starts the loop directly, and it records that the loop
  # has no keeper. tools\direct-link.ps1 -On registers the task in its one
  # elevated phase, which is what makes that path fully durable.
  #
  # Compare Unregister-RendezvousTask, which has always been checked and
  # reported (a surviving task is the difference between "off" and "off until
  # the next sign-in"). The asymmetry ran the wrong way for a switch whose whole
  # promise is that ON stays on.
  # Only register if it is not already there. Re-registering needs an
  # administrator every single time, so an -Enable that always tried it turned
  # the ordinary unelevated ON press into a guaranteed "Access is denied" on a
  # machine that was already set up correctly. Registration is the one-time
  # elevated step (tools\direct-link.ps1 -On); arming is the everyday one.
  $taskOk = if(Test-RendezvousTaskPresent){ $true } else { Register-RendezvousTask }
  if(-not $taskOk){
    $elevated = $false
    try {
      $elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { }
    $reason = if($elevated){ 'the sign-in task could not be registered' } else { 'the sign-in task needs an administrator; run tools\direct-link.ps1 -On' }
    [void](Invoke-RendezvousStateUpdate -Update ({
      param($current)
      $current.detail = "$($current.detail) - $reason"
      return $current
    }.GetNewClosure()))
  }

  if(-not (Test-RendezvousLoopAlive)){
    [void](Start-RendezvousServeProcess)
  }
  return Get-RendezvousStatusObject
}

function Disable-Rendezvous {
  # Stops advertising. Never revokes, deletes, or overwrites a credential, and
  # deliberately keeps the generation so switching back on reconnects with the
  # key both machines already hold instead of minting a new one.
  if(-not $script:StatePath){ throw 'The ToolsEnabled repository root could not be resolved on this machine.' }
  [void](Invoke-RendezvousStateUpdate {
    param($current)
    $current.armed = $false
    $current.connected = $false
    $current.status = 'off'
    $current.detail = ''
    return $current
  })
  $stop = New-RendezvousStopEvent
  try { [void]$stop.Set() } finally { $stop.Dispose() }

  # STOP THE TASK, DO NOT UNREGISTER IT.
  #
  # This used to unregister, and the reason was sound at the time: the task's
  # action was -Enable, which re-arms unconditionally, so a surviving task really
  # would have switched the machine back on at the next sign-in. The action is
  # now -Serve, which reads `armed` on entry and on every iteration and exits
  # when it is false -- so a surviving task cannot turn anything on, and the
  # unregister has become pure cost: registering needs an administrator, so every
  # off-and-on cycle would have demanded a UAC prompt to put back something that
  # never needed removing. Stopping the instance is what "off" actually means.
  $stopped = $true
  if(Test-RendezvousTaskPresent){
    try { Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction Stop } catch { $stopped = $false }
  }

  $localIp = Get-RendezvousLinkAddress
  if($localIp){
    for($attempt = 0; $attempt -lt 12; $attempt++){
      if(-not (Test-RendezvousLocalListener -Address $localIp -Port $script:RendezvousPort)){ break }
      Start-Sleep -Milliseconds 250
    }
  }
  # An off switch that reports success while something is still listening is
  # worse than one that admits it failed. The listener is the thing to check,
  # not the task: `armed` is already false, so even a task instance that has not
  # noticed yet will exit on its next iteration.
  $stillServing = if($localIp){ Test-RendezvousLocalListener -Address $localIp -Port $script:RendezvousPort } else { $false }
  if($stillServing -or -not $stopped){
    [void](Invoke-RendezvousStateUpdate {
      param($current)
      $current.status = 'attention'
      $current.detail = 'switched off, but the key exchange is still listening'
      return $current
    })
  }
  return Get-RendezvousStatusObject
}

# ----------------------------------------------------------------- dispatch --

if($LoadOnly){ return }

$requested = @()
if($Enable){ $requested += 'Enable' }
if($Disable){ $requested += 'Disable' }
if($Status){ $requested += 'Status' }
if($Serve){ $requested += 'Serve' }
if($RegisterTask){ $requested += 'RegisterTask' }
if($UnregisterTask){ $requested += 'UnregisterTask' }
if($requested.Count -gt 1){ throw 'Choose exactly one of -Enable, -Disable, -Status, -Serve, -RegisterTask, or -UnregisterTask.' }
$action = if($requested.Count -eq 1){ $requested[0] } else { 'Status' }

switch($action){
  'Enable'  { (Enable-Rendezvous) | ConvertTo-Json -Compress }
  'Disable' { (Disable-Rendezvous) | ConvertTo-Json -Compress }
  'Serve'   { Start-RendezvousLoop }
  # Registering and unregistering the sign-in task, separated from arming so the
  # one elevated phase of tools\direct-link.ps1 can do them without also arming
  # (and so -Enable stays an unelevated operation). Both report what actually
  # happened rather than whether the call threw.
  'RegisterTask'   { [pscustomobject]@{ ok = [bool](Register-RendezvousTask); taskRegistered = (Test-RendezvousTaskPresent) } | ConvertTo-Json -Compress }
  'UnregisterTask' { [pscustomobject]@{ ok = [bool](Unregister-RendezvousTask); taskRegistered = (Test-RendezvousTaskPresent) } | ConvertTo-Json -Compress }
  default   { (Get-RendezvousStatusObject) | ConvertTo-Json -Compress }
}
