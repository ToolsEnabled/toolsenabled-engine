# direct-link.ps1 -- the single control for the cable between two of your computers.
#
#   -On      turn the link on. One press. At most one Windows permission prompt,
#            and none at all once the one-time setup exists.
#   -Off     turn it off. Nothing keeps running, nothing wakes up later.
#   -Status  say exactly what is and is not working, and name the thing to fix.
#
# WHY THIS FILE EXISTS. Turning the link on used to mean running five things in
# the right order across two lanes, each with its own idea of persistence:
# harden the install folder, open 8790, open 8795, register two scheduled tasks,
# arm the rendezvous, start the listener. Miss one and the failure surfaced
# somewhere else entirely -- a missing firewall rule reads exactly like "the
# other computer is switched off". Nothing owned the whole sequence, so nothing
# could report on it, and "is the link on?" had no single answer.
#
# THE TWO LANES. They are separate on purpose and both are needed:
#   8795  rendezvous  packages\servercontrol\Mechanical-Connect.ps1
#         The two machines agree a credential over the cable. Its `armed` flag
#         is the owner's switch and survives restarts.
#   8790  FRA         tools\fra-keeper.js -> tools\full-remote-access-control.ps1
#         The actual service. Its off switch is state\full-remote-access.stop.
#
# ON IS A LATCH MADE OF FILES, not of running processes: `armed` true, the stop
# sentinel absent. Both survive a restart, so OFF stays off and ON stays on
# without this script needing to be running.
#
# WHAT THIS DOES NOT DO. It does not make the link come back after a restart on
# its own. That is governed by the startup.services_at_logon setting (owner
# directive 2026-08-13, "toolsenabled should startup on start if a user chooses
# that setting. i dont."), which is off by default and which this script never
# changes. With it off, press -On again after a restart. With it on, both tasks
# carry a sign-in trigger and the link returns by itself. Between restarts the
# link stays up through crashes and cable re-plugs, which is what the two
# scheduled tasks are for.
#
# ASCII only: PowerShell 5.1 misparses this file if it picks up a non-ASCII dash.
[CmdletBinding()]
param(
  [switch]$On,
  [switch]$Off,
  [switch]$Status,
  [switch]$Json,
  # Internal. The single elevated phase, re-entered via -Verb RunAs by -On.
  # Never run this by hand; it is not the on switch.
  [switch]$ElevatedPhase
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Set by the verbs; read once by the dispatch. See the note there.
$script:ExitCode = 0

$Root            = Split-Path -Parent $PSScriptRoot
$StateDir        = Join-Path $Root 'state'
$StopFile        = Join-Path $StateDir 'full-remote-access.stop'
$SetupResultFile = Join-Path $StateDir 'direct-link-setup-result.json'
$RendezvousState = Join-Path $StateDir 'mechanical-connect-state.json'
$Engine          = Join-Path $Root 'packages\servercontrol\Mechanical-Connect.ps1'
$KeeperTask      = Join-Path $Root 'tools\fra-keeper-task.ps1'
$FraControl      = Join-Path $Root 'tools\full-remote-access-control.ps1'
$FraFirewall     = Join-Path $Root 'tools\full-remote-access-firewall.ps1'
$RvFirewall      = Join-Path $Root 'tools\fra-rendezvous-firewall.ps1'
$RootAccess      = Join-Path $Root 'tools\fra-root-access-control.ps1'
$Doctor          = Join-Path $Root 'tools\fra-doctor.js'

$KeeperTaskName     = 'ToolsEnabled FRA Keeper'
$RendezvousTaskName = 'ServerControl Mechanical Connect'
$FraRuleName        = 'ToolsEnabled Full Remote Access (8790)'
$RendezvousRuleName = 'ToolsEnabled FRA Rendezvous (8795)'

# ---------------------------------------------------------------- helpers --

function Test-Elevated {
  try { return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
  catch { return $false }
}

# The same two candidates tools\full-remote-access-control.ps1 accepts, checked
# by version rather than trusted by path. Never a bare 'node' from PATH: a
# scheduled task runs with a different PATH than the owner's shell.
function Resolve-Node {
  $minimum = [Version]'22.19.0'
  foreach ($candidate in @('C:\agent-apps\node-v22.19.0\node.exe', 'C:\Program Files\nodejs\node.exe')) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      $raw = [string]([Diagnostics.FileVersionInfo]::GetVersionInfo($candidate).ProductVersion)
      $parsed = $null
      if ([Version]::TryParse((($raw -split '[^0-9.]', 2)[0]), [ref]$parsed) -and $parsed -ge $minimum) {
        return [IO.Path]::GetFullPath($candidate)
      }
    } catch { }
  }
  return $null
}

# Firewall rules, read WITHOUT elevation.
#
# Get-NetFirewallRule returns an empty set to an unelevated caller, so using it
# here would report "no rule" on a machine whose rules are fine -- and this
# status has to be trustworthy from the ordinary shell a person actually uses.
# netsh reports rules to any caller. (This approach is lifted from
# the retired rendezvous controller, which had no service implementation.)
function Test-FirewallRulePresent {
  param([Parameter(Mandatory=$true)][string]$DisplayName)
  try {
    $output = & netsh advfirewall firewall show rule name="$DisplayName" 2>&1 | Out-String
    return ($LASTEXITCODE -eq 0 -and $output -notmatch 'No rules match')
  } catch { return $false }
}

function Get-TaskFacts {
  param([Parameter(Mandatory=$true)][string]$Name, [string]$RequiredArgument)
  $task = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if (-not $task) { return [pscustomobject]@{ registered = $false; enabled = $false; state = 'absent'; triggers = 0; current = $false } }
  # CURRENT, not merely present.
  #
  # Checking only that a task exists makes an upgrade silently do nothing: the
  # machine already has both tasks, so -On skips its elevated phase and leaves
  # the OLD definitions in place -- a keeper still running the one-shot on a
  # cadence trigger, a rendezvous still capped at three minutes. The task would
  # be reported as installed and the defects it was meant to fix would survive.
  # The action string is the cheapest honest witness that the registration came
  # from this version.
  # Filter nulls before counting. A triggerless task -- which is exactly what an
  # on-demand task is while the startup switch is off -- yields $null here, and
  # @($null).Count is 1, so a bare count would report a trigger that does not
  # exist. The same PowerShell trap bit the trigger-set builder in the registrars.
  $triggerCount = @($task.Triggers | Where-Object { $_ }).Count
  $argument = if (@($task.Actions).Count -gt 0) { [string]$task.Actions[0].Arguments } else { '' }
  $current = if ([string]::IsNullOrWhiteSpace($RequiredArgument)) { $true } else { $argument -like "*$RequiredArgument*" }
  return [pscustomobject]@{
    registered = $true
    enabled    = [bool]$task.Settings.Enabled
    state      = [string]$task.State
    triggers   = $triggerCount
    current    = [bool]$current
  }
}

function Read-JsonFile {
  param([Parameter(Mandatory=$true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $raw = Get-Content -Raw -LiteralPath $Path
    # PowerShell writes a UTF-8 BOM; ConvertFrom-Json chokes on it.
    if ($raw.Length -gt 0 -and [int]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
    return $raw | ConvertFrom-Json
  } catch { return $null }
}

function Test-PortListening {
  param([Parameter(Mandatory=$true)][int]$Port)
  try { return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) }
  catch { return $false }
}

function Get-LinkFacts {
  $node = Resolve-Node
  $identity = $null
  if ($node -and (Test-Path -LiteralPath $Doctor -PathType Leaf)) {
    try { $identity = (& $node $Doctor --json 2>$null | Out-String | ConvertFrom-Json) } catch { $identity = $null }
  }
  $rv = Read-JsonFile -Path $RendezvousState
  $liveness = Read-JsonFile -Path (Join-Path $StateDir 'full-remote-access-peer-liveness.json')

  $livenessAgeSec = $null
  if ($liveness -and $liveness.authenticatedAt) {
    try { $livenessAgeSec = [int]((Get-Date).ToUniversalTime() - ([datetime]$liveness.authenticatedAt).ToUniversalTime()).TotalSeconds } catch { }
  }

  return [pscustomobject]@{
    node               = $node
    host               = if ($identity) { [string]$identity.host } else { $null }
    peer               = if ($rv) { [string]$rv.peerIp } else { $null }
    stopSentinel       = (Test-Path -LiteralPath $StopFile)
    armed              = if ($rv) { [bool]$rv.armed } else { $false }
    generation         = if ($rv) { [int]$rv.generation } else { 0 }
    rendezvousStatus   = if ($rv) { [string]$rv.status } else { 'unknown' }
    rendezvousDetail   = if ($rv) { [string]$rv.detail } else { '' }
    rendezvousServing  = (Test-PortListening -Port 8795)
    fraListening       = (Test-PortListening -Port 8790)
    fraRule            = (Test-FirewallRulePresent -DisplayName $FraRuleName)
    rendezvousRule     = (Test-FirewallRulePresent -DisplayName $RendezvousRuleName)
    keeperTask         = (Get-TaskFacts -Name $KeeperTaskName -RequiredArgument '--resident')
    rendezvousTask     = (Get-TaskFacts -Name $RendezvousTaskName -RequiredArgument '-Serve')
    peerLivenessAgeSec = $livenessAgeSec
  }
}

# Everything the one elevated phase installs. -On skips the prompt entirely when
# all of it is already there, which is what makes a second press silent.
function Test-SetupComplete {
  param($Facts)
  return ($Facts.fraRule -and $Facts.rendezvousRule -and
          $Facts.keeperTask.registered -and $Facts.keeperTask.current -and
          $Facts.rendezvousTask.registered -and $Facts.rendezvousTask.current)
}

function Write-Line { param([string]$Text) Write-Output $Text }

# "yes" and "no" are not the only two answers. A task registered by an older
# version is present and running and still wrong, and reporting that as "yes"
# next to "setup done: no" reads as a contradiction rather than as the one
# instruction it is.
function Format-TaskFact {
  param($Fact)
  if (-not $Fact.registered) { return 'no' }
  if (-not $Fact.current) { return "needs updating (installed by an older version, $($Fact.state))" }
  return "yes ($($Fact.state))"
}

# ------------------------------------------------------------ the reports --

function Get-Report {
  param($Facts)
  $on = ($Facts.armed -and -not $Facts.stopSentinel)
  $working = ($on -and $Facts.fraListening -and $Facts.rendezvousServing -and
              $Facts.generation -gt 0 -and $Facts.rendezvousStatus -eq 'connected')

  # Name the FIRST thing that is wrong, in the order a person would fix it.
  # A list of eight booleans is not an answer; "the cable is not connected" is.
  $problem = $null
  if (-not $Facts.node)                        { $problem = 'Node 22.19.0 or newer is not installed on this computer.' }
  elseif (-not $Facts.host)                    { $problem = 'This computer does not hold one of the two addresses in config\service-registry.json. Connect the cable, or give this computer its fixed address.' }
  elseif (-not (Test-SetupComplete $Facts))    {
    $stale = (($Facts.keeperTask.registered -and -not $Facts.keeperTask.current) -or
              ($Facts.rendezvousTask.registered -and -not $Facts.rendezvousTask.current))
    $problem = if ($stale) {
      'This computer was set up by an older version, so the link will not restart itself if something stops. Run this with -On and approve the Windows prompt to update it.'
    } else {
      'The one-time setup has not been done on this computer. Run this with -On and approve the Windows prompt.'
    }
  }
  elseif ($Facts.stopSentinel)                 { $problem = 'The link is switched off. Run this with -On.' }
  elseif (-not $Facts.armed)                   { $problem = 'The link is switched off. Run this with -On.' }
  elseif (-not $Facts.rendezvousServing)       { $problem = 'This computer is not listening for the other one. Run this with -On.' }
  elseif ($Facts.generation -le 0 -or $Facts.rendezvousStatus -ne 'connected') {
                                                 $problem = "The two computers have not agreed a key yet ($($Facts.rendezvousDetail)). If the other computer is off, turn it on and this finishes by itself." }
  elseif (-not $Facts.fraListening)            { $problem = 'The key is agreed but the service is not listening yet. This normally clears within two minutes.' }

  return [pscustomobject]@{
    on              = $on
    working         = $working
    problem         = $problem
    thisComputer    = $Facts.host
    otherComputer   = $Facts.peer
    setupComplete   = (Test-SetupComplete $Facts)
    firewall8790    = $Facts.fraRule
    firewall8795    = $Facts.rendezvousRule
    keeperTask      = $Facts.keeperTask
    rendezvousTask  = $Facts.rendezvousTask
    rendezvous      = [pscustomobject]@{
      armed = $Facts.armed; serving = $Facts.rendezvousServing
      generation = $Facts.generation; status = $Facts.rendezvousStatus; detail = $Facts.rendezvousDetail
    }
    fraListening    = $Facts.fraListening
    peerProvenSecondsAgo = $Facts.peerLivenessAgeSec
  }
}

function Show-Report {
  param($Report)
  if ($Json) { $Report | ConvertTo-Json -Depth 6 -Compress; return }

  $headline = if ($Report.working) { 'The direct link is ON and working.' }
              elseif ($Report.on)  { 'The direct link is ON, but not working yet.' }
              else                 { 'The direct link is OFF.' }
  Write-Line ''
  Write-Line $headline
  if ($Report.problem) { Write-Line "  -> $($Report.problem)" }
  Write-Line ''
  Write-Line ("  This computer          : " + $(if ($Report.thisComputer) { $Report.thisComputer } else { 'unknown (no cable, or no fixed address)' }))
  Write-Line ("  The other computer     : " + $(if ($Report.otherComputer) { $Report.otherComputer } else { 'not recorded yet' }))
  Write-Line ("  One-time setup done    : " + $(if ($Report.setupComplete) { 'yes' } else { 'no' }))
  Write-Line ("    port 8790 allowed    : " + $(if ($Report.firewall8790) { 'yes' } else { 'no' }))
  Write-Line ("    port 8795 allowed    : " + $(if ($Report.firewall8795) { 'yes' } else { 'no' }))
  Write-Line ("    keeper installed     : " + (Format-TaskFact $Report.keeperTask))
  Write-Line ("    rendezvous installed : " + (Format-TaskFact $Report.rendezvousTask))
  Write-Line ("  Agreeing keys          : " + $(if ($Report.rendezvous.serving) { 'listening' } else { 'not listening' }) +
              ", " + $Report.rendezvous.status + " (key #" + $Report.rendezvous.generation + ")")
  Write-Line ("  Service listening      : " + $(if ($Report.fraListening) { 'yes' } else { 'no' }))
  if ($null -ne $Report.peerProvenSecondsAgo) {
    Write-Line ("  Last proven end to end : " + $Report.peerProvenSecondsAgo + "s ago")
  }
  Write-Line ''
}

# ------------------------------------------------------- the elevated part --

# ONE prompt, and every step is attempted even if an earlier one fails.
#
# The packet's CONNECT.ps1 wrapped only the first of these in try/catch, so a
# failure opening 8790 meant 8795 was never opened either -- and the person saw
# one error about the wrong thing. Each step here records its own outcome, and
# the parent reads them back from a file because -Verb RunAs forces
# UseShellExecute, which makes the child's stdout physically uncapturable.
function Invoke-ElevatedPhase {
  $steps = @()
  function Step {
    param([string]$Name, [scriptblock]$Body)
    try { & $Body; return [pscustomobject]@{ step = $Name; ok = $true; error = $null } }
    catch { return [pscustomobject]@{ step = $Name; ok = $false; error = [string]$_.Exception.Message } }
  }

  $steps += Step 'harden-install-folder' {
    if (Test-Path -LiteralPath $RootAccess -PathType Leaf) {
      try { & $RootAccess -Action Harden | Out-Null }
      catch {
        # Re-running Harden after a previous run refuses unless the recorded
        # pre-image is cleared first; that is the documented recovery, not a
        # failure worth stopping the whole setup for.
        if ([string]$_.Exception.Message -match 'PREIMAGE_EXISTS') {
          Remove-Item -LiteralPath (Join-Path $StateDir 'fra-root-access-preimage.json') -Force -ErrorAction SilentlyContinue
          & $RootAccess -Action Harden | Out-Null
        } else { throw }
      }
    }
  }
  $steps += Step 'allow-port-8790'      { & $FraFirewall | Out-Null }
  $steps += Step 'allow-port-8795'      { & $RvFirewall  | Out-Null }
  $steps += Step 'install-keeper'       { & $KeeperTask -Register | Out-Null }
  $steps += Step 'install-rendezvous'   { & $Engine -RegisterTask | Out-Null }

  try {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    ([pscustomobject]@{
      completedAt = (Get-Date).ToUniversalTime().ToString('o')
      steps = $steps
    } | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $SetupResultFile -Encoding utf8
  } catch { }

  $failed = @($steps | Where-Object { -not $_.ok })
  if ($failed.Count -gt 0) { exit 1 }
  exit 0
}

# ------------------------------------------------------------------- verbs --

function Invoke-On {
  $facts = Get-LinkFacts

  if (-not $facts.node) { Write-Line 'Node 22.19.0 or newer is not installed. Install it, reopen this window, and run this again.'; $script:ExitCode = 1; return }
  if (-not $facts.host) {
    Write-Line 'This computer does not hold either of the two addresses in config\service-registry.json.'
    Write-Line 'Connect the cable between the two computers and give each one its fixed address, then run this again.'
    $script:ExitCode = 1; return
  }

  if (-not (Test-SetupComplete $facts)) {
    Write-Line 'One-time setup is needed. Windows will ask for permission once.'
    if (Test-Elevated) {
      Invoke-ElevatedPhase
    } else {
      Remove-Item -LiteralPath $SetupResultFile -Force -ErrorAction SilentlyContinue
      $psi = @{
        FilePath     = (Get-Process -Id $PID).Path
        ArgumentList = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-ElevatedPhase')
        Verb         = 'RunAs'
        WindowStyle  = 'Hidden'
        PassThru     = $true
      }
      $child = $null
      try { $child = Start-Process @psi } catch {
        Write-Line 'Setup needs permission, and the prompt was refused or dismissed. Nothing was changed.'
        $script:ExitCode = 1; return
      }
      $child.WaitForExit()
      $result = Read-JsonFile -Path $SetupResultFile
      if (-not $result) { Write-Line 'Setup did not report a result. Nothing is assumed to have worked; run this again.'; $script:ExitCode = 1; return }
      foreach ($step in $result.steps) {
        if (-not $step.ok) { Write-Line ("  setup step failed: " + $step.step + " -- " + $step.error) }
      }
      if (@($result.steps | Where-Object { -not $_.ok }).Count -gt 0) { $script:ExitCode = 1; return }
    }
    $facts = Get-LinkFacts
  }

  # Clearing the stop sentinel BEFORE arming: the keeper reads it first and
  # exits on it, so arming with it still present starts a loop that immediately
  # stops itself.
  if (Test-Path -LiteralPath $StopFile) { Remove-Item -LiteralPath $StopFile -Force }

  & $Engine -Enable | Out-Null

  if ($facts.keeperTask.registered) {
    try { & $KeeperTask -StartNow | Out-Null } catch { Write-Line ("  note: the keeper did not start -- " + $_.Exception.Message) }
  }

  # PROVE IT, do not assume it. Bounded: the other computer may simply not be on
  # yet, and that is a legitimate, reportable outcome rather than a failure --
  # the two tasks finish the job whenever the peer appears, in either order.
  $deadline = (Get-Date).AddSeconds(180)
  $report = Get-Report -Facts (Get-LinkFacts)
  while (-not $report.working -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $report = Get-Report -Facts (Get-LinkFacts)
  }

  Show-Report -Report $report
  if ($report.working) { $script:ExitCode = 0; return }
  if ($report.on) {
    Write-Line 'This computer is on and waiting. When the other computer is turned on, they finish connecting by themselves.'
    $script:ExitCode = 0; return
  }
  $script:ExitCode = 1; return
}

function Invoke-Off {
  # Rendezvous first: -Disable sets armed=false and signals the loop, so the
  # loop ends deliberately rather than being killed.
  try { & $Engine -Disable | Out-Null } catch { Write-Line ("  note: " + $_.Exception.Message) }

  # This writes the stop sentinel AND stops the listener -- but only one it can
  # prove it owns. A listener started by the S4U task cannot have its command
  # line read by an unelevated caller, so ownership is "unverifiable" and the
  # control script answers blocked_conflict rather than killing a process it
  # cannot identify. That refusal is correct and must NOT be treated as success:
  # observed live on 2026-08-19, OFF printed "the direct link is OFF" while 8790
  # was still listening.
  try { & $FraControl -Action Stop | Out-Null } catch { Write-Line ("  note: " + $_.Exception.Message) }

  try { & $KeeperTask -StopNow | Out-Null } catch { }

  # Give the loops a moment to notice; both poll rather than being killed.
  $deadline = (Get-Date).AddSeconds(20)
  $facts = Get-LinkFacts
  while (($facts.fraListening -or $facts.rendezvousServing) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $facts = Get-LinkFacts
  }

  $report = Get-Report -Facts $facts
  Show-Report -Report $report
  if ($report.on) { Write-Line 'The link did not switch off cleanly. Run -Status to see what is still up.'; $script:ExitCode = 1; return }
  if ($facts.fraListening -or $facts.rendezvousServing) {
    # The latch is off -- nothing will restart, and it stays off across a
    # restart -- but something is still holding a port right now, and saying
    # "off" while that is true is the failure this check exists to prevent.
    Write-Line 'Switched off, but a service that was started with administrator rights is still listening.'
    Write-Line 'It cannot be stopped from an ordinary window, and nothing will restart it. To close it now,'
    Write-Line 'run this again from an Administrator window; otherwise it goes away at the next restart.'
    $script:ExitCode = 1; return
  }
  $script:ExitCode = 0; return
}

# --------------------------------------------------------------- dispatch --

if ($ElevatedPhase) { Invoke-ElevatedPhase; return }

$verbs = @()
if ($On) { $verbs += 'On' }
if ($Off) { $verbs += 'Off' }
if ($Status) { $verbs += 'Status' }
if ($verbs.Count -gt 1) { throw 'Choose exactly one of -On, -Off, or -Status.' }
$verb = if ($verbs.Count -eq 1) { $verbs[0] } else { 'Status' }

# CALL, THEN EXIT -- never `exit (Invoke-On)`.
#
# Wrapping the call in exit() makes PowerShell collect EVERYTHING the function
# wrote as that expression's value, so every Write-Output line is consumed as
# part of the return value and the person sees an empty screen. Observed live on
# 2026-08-19: -On succeeded in 13 seconds and printed nothing at all. The report
# is the whole point of the verb, so the exit code travels in a script-scoped
# variable and the output travels down the pipeline where it belongs.
switch ($verb) {
  'On'  { Invoke-On;  exit $script:ExitCode }
  'Off' { Invoke-Off; exit $script:ExitCode }
  default { Show-Report -Report (Get-Report -Facts (Get-LinkFacts)); exit 0 }
}
