# ============================================================
#   ServerRegistry.ps1  -  shared brain for the Server Control Panel
#
#   Both the control panel and the hourly aggregator dot-source this.
#   It owns the fixed curated server set used identically on both computers.
#   Incidental local listeners are deliberately excluded from the UI.
#
#   Registry is stored as servers.json next to this file.
# ============================================================

$script:RegDir  = $PSScriptRoot
$script:RegPath = Join-Path $PSScriptRoot 'servers.json'
$commonScript=Join-Path $PSScriptRoot 'ServerControl.Common.ps1'
if(-not (Test-Path -LiteralPath $commonScript -PathType Leaf)){ throw 'ServerControl.Common.ps1 is missing.' }
. $commonScript
$script:HostProfile=Get-ServerControlHostProfile
# 22.19, NOT the system 22.14 in C:\Program Files\nodejs. On 22.14 node:sqlite's
# DatabaseSync has no .isOpen, so ToolsEnabled's state-store.js recurses until the
# stack blows (AGENT-GUIDE §7 landmine 0). The visualizer reads that
# state and would have died on first start. Same major version, so the non-
# ToolsEnabled entries (Scribe, Presentation Editor) are unaffected by the change.
$NODE = $script:HostProfile.Node
# Host paths come from the shared fixed-drive-only resolver.  This registry is
# intentionally byte-identical on A and B; only the resolved values persisted
# into each host's servers.json differ.
$TOOLS_ENABLED = $script:HostProfile.ToolsEnabledRoot
$VISUALIZER = $script:HostProfile.Visualizer
$PRESENTATION = $script:HostProfile.Presentation
$PORTFOLIO = $script:HostProfile.Portfolio
$MCNAIR = $script:HostProfile.McNair
$PYTHON = $script:HostProfile.Python
$POWERSHELL = $script:HostProfile.PowerShell
$LEANQUEST  = $script:HostProfile.LeanQuest
$TOPOLOGY   = $script:HostProfile.Topology
$TOPOLOGY_START = Join-Path $PSScriptRoot 'Start-Topology-Games.ps1'
$script:ExpectedCuratedPorts = @(3888,3889,4599,4610,4702,8123,8420,8765)

# Auto-discovery DISABLED (owner request 2026-07-31). It was promoting incidental
# loopback listeners into the panel as "Port 8137"/"Port 8931"/"Port 11435" -
# agent scratch processes and the gpu-gateway, none of which are dev servers you
# would ever start or stop from here. Curated entries above are unaffected.
$script:AutoDiscoveryEnabled = $false

# ---- discovery tuning -----------------------------------------------
# A raw listener is recorded as a discovered ('auto') server only after it
# has been seen listening, on the SAME port+PID, across this many
# consecutive Sync-Registry calls. Short-lived agent/test processes (a test
# script that binds a port for a few seconds) never survive one scan
# interval and so never get promoted; a real dev server the owner starts
# and leaves running does. Candidates that drop out between scans are
# discarded rather than accumulated (see servers.json.candidates.json).
$script:MinConsecutiveScans = 3
# Discovered ('auto') entries that have not been seen listening again for
# this long are evicted on the next sync instead of being carried forward
# forever. Curated ('known') entries are never subject to this.
$script:AutoEvictAfterHours = 48

# ---- Your curated servers (authoritative; always present) ---------
$script:Curated = @(
  # The panel already owns a native hidden process boundary. Starting the
  # PowerShell readiness wrapper here made every watchdog/restart hop create a
  # short-lived console host on some Windows builds. Ollama is supervised by
  # the ToolsEnabled launcher; the server itself is a direct Node entry
  # point so panel starts remain console-free and idempotent.
  [ordered]@{ Name='Agent Activity Visualizer'; Port=3889; Url='http://127.0.0.1:3889/'; Exe=$NODE; Args=@('server/index.js','--host','127.0.0.1','--port','3889'); WorkDir=$VISUALIZER }
  [ordered]@{ Name='Presentation Editor'; Port=4599; Url='http://127.0.0.1:4599/'; Exe=$NODE; Args=@('suite\server.js');       WorkDir=$PRESENTATION }
  [ordered]@{ Name='Scribe';              Port=4610; Url='http://127.0.0.1:4610/'; Exe=$NODE; Args=@('server.js');             WorkDir=(Join-Path $PRESENTATION 'scribe') }
  [ordered]@{ Name='Portfolio Dashboard'; Port=8420; Url='http://127.0.0.1:8420/'; Exe=(Join-Path $PORTFOLIO '.venv\Scripts\python.exe'); Args=@('-m','app.main'); WorkDir=$PORTFOLIO }
  [ordered]@{ Name='Organizer Review';    Port=8765; Url='http://127.0.0.1:8765/'; Exe=(Join-Path $MCNAIR 'Start Organizer Review.bat'); Args=@(); WorkDir=$MCNAIR }
  # --- games (added 2026-07-31) -------------------------------------------
  # LEAN-Bench Quest ships its own server.py; the other two are static bundles
  # served by python's stdlib http server, so they need no per-project deps.
  # server.py takes its port from $env:LBQ_PORT (default 8123) and ignores argv,
  # so register it on its native port rather than passing one it would discard.
  [ordered]@{ Name='LEAN-Bench Quest';    Port=8123; Url='http://127.0.0.1:8123/'; Exe=$PYTHON; Args=@('server.py');                          WorkDir=$LEANQUEST }
  [ordered]@{ Name='Topology Games';      Port=4702; Url='http://127.0.0.1:4702/'; Exe=$POWERSHELL; Args=@('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$TOPOLOGY_START); WorkDir=$TOPOLOGY }
)

# Dev runtimes we treat as "a server" when they listen on loopback.
$script:DevRuntimes = 'node','python','pythonw','deno','bun','ruby','dotnet','go','php','java','gunicorn','uvicorn','flask','cargo','next-server'

# ---- best-effort: read a process's current working directory ------
if(-not ('ProcCwd' -as [type])){
  try {
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ProcCwd {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, byte[] info, int len, out int ret);
  public static string Get(int pid){
    IntPtr h = OpenProcess(0x1010, false, pid);      // QUERY_INFORMATION | VM_READ
    if(h==IntPtr.Zero) return null;
    try {
      byte[] pbi = new byte[48]; int rl;
      if(NtQueryInformationProcess(h,0,pbi,pbi.Length,out rl)!=0) return null;
      long peb = BitConverter.ToInt64(pbi,8);         // PebBaseAddress (x64)
      IntPtr rd; byte[] p8 = new byte[8];
      if(!ReadProcessMemory(h,(IntPtr)(peb+0x20),p8,8,out rd)) return null;  // ProcessParameters
      long pp = BitConverter.ToInt64(p8,0);
      byte[] us = new byte[2];
      if(!ReadProcessMemory(h,(IntPtr)(pp+0x38),us,2,out rd)) return null;   // CurrentDirectory.Length
      int len = BitConverter.ToUInt16(us,0);
      if(len<=0 || len>1000) return null;
      byte[] bp = new byte[8];
      if(!ReadProcessMemory(h,(IntPtr)(pp+0x40),bp,8,out rd)) return null;   // CurrentDirectory.Buffer
      long addr = BitConverter.ToInt64(bp,0);
      byte[] str = new byte[len];
      if(!ReadProcessMemory(h,(IntPtr)addr,str,len,out rd)) return null;
      return Encoding.Unicode.GetString(str).TrimEnd('\\','\0');
    } catch { return null; } finally { CloseHandle(h); }
  }
}
'@
  } catch { }
}
function Get-ProcCwd([int]$procId){ try { if('ProcCwd' -as [type]){ return [ProcCwd]::Get($procId) } } catch {}; return $null }

# ---- discover local servers currently listening -------------------
function Get-DevListeners {
  $out = @{}
  $curatedPorts = $script:Curated.Port
  $conns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
           Where-Object { $_.LocalAddress -in @('127.0.0.1','::1') -and $_.LocalPort -ge 1024 -and $_.LocalPort -le 60000 }
  foreach($c in $conns){
    $port = [int]$c.LocalPort
    if($out.ContainsKey($port)){ continue }
    $procId = [int]$c.OwningProcess
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if(-not $p){ continue }
    $pname = ($p.Name -replace '\.exe$','')
    $isCurated = $curatedPorts -contains $port
    if(-not $isCurated -and ($script:DevRuntimes -notcontains $pname)){ continue }

    $cmd = [string]$p.CommandLine
    $work = Get-ProcCwd $procId
    if(-not $work){
      # fall back: directory of an absolute script path in the command line
      $m = [regex]::Match($cmd, '([A-Za-z]:\\[^"]+\.(?:js|py|mjs|cjs|ts))')
      if($m.Success){ $work = Split-Path $m.Groups[1].Value -Parent }
    }
    # Agent/test scratch processes are never "a server" worth recording,
    # curated ports are always trusted regardless of where they run from.
    if(-not $isCurated -and ((Test-EphemeralWorkPath $work) -or (Test-EphemeralWorkPath $cmd))){ continue }
    # split exe vs arg-line from the command line
    # MEASUREMENT-HONESTY-OK: this PARSES a command line, it does not decide
    # identity from one. The `if($cmd)` below already skips an empty or
    # unreadable value, leaving $exe as ExecutablePath and $argLine empty --
    # a display fallback, not a "this is not our process" verdict. The rule
    # being exempted exists to stop an unreadable command line becoming a
    # confident negative about ownership; nothing here decides ownership.
    $exe = $p.ExecutablePath; $argLine = ''
    if($cmd){
      if($cmd.StartsWith('"')){ $i=$cmd.IndexOf('"',1); if($i -gt 0){ $exe=$cmd.Substring(1,$i-1); $argLine=$cmd.Substring($i+1).Trim() } }
      else { $i=$cmd.IndexOf(' '); if($i -gt 0){ $exe=$cmd.Substring(0,$i); $argLine=$cmd.Substring($i+1).Trim() } }
    }
    $name = if($work){ Split-Path $work -Leaf } elseif($p.ExecutablePath){ "$pname on $port" } else { "Port $port" }
    $out[$port] = [pscustomobject]@{
      Port=$port; ProcessId=$procId; Exe=$exe; ArgLine=$argLine; WorkDir=$work; Proc=$pname; Name=$name
    }
  }
  return $out.Values
}

# ---- load / save the json registry --------------------------------
function Test-EphemeralWorkPath($p){
  # True for paths that belong to agent/test scratch space rather than a
  # real project a human would want listed as "a server": OS temp dirs,
  # any 'scratchpad' folder, and Claude/Codex agent temp working dirs.
  # These processes are almost always short-lived test harnesses, sandbox
  # scripts, or throwaway tool servers, never something to Start/Stop from
  # the panel.
  if(-not $p){ return $false }
  foreach($root in @($env:TEMP, $env:TMP)){
    if($root -and $p.StartsWith($root.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)){ return $true }
  }
  if($p -match '(?i)\\AppData\\Local\\Temp\\' -or $p -match '(?i)\\scratchpad(\\|$)'){ return $true }
  return $false
}

function Test-LocalFixedPath($p){
  # True only for paths on local fixed drives; reads the mount table only,
  # never the network, so it's instant even for dead UNC/mapped paths.
  if(-not $p){ return $false }
  if($p -like '\\*'){ return $false }
  $root=$null; try { $root=[System.IO.Path]::GetPathRoot($p) } catch { return $false }
  if(-not $root -or $root -notmatch '^[A-Za-z]:'){ return $false }
  try { return ((New-Object System.IO.DriveInfo($root)).DriveType -eq 'Fixed') } catch { return $false }
}

function Read-Registry {
  # Brief retry: a concurrent atomic replace can still make one read attempt
  # fail to open; never mistake that for a genuinely empty registry.
  for($try=0; $try -lt 3; $try++){
    if(-not (Test-Path $script:RegPath)){ break }
    try { $j = Get-Content $script:RegPath -Raw -ErrorAction Stop | ConvertFrom-Json; if($j){ return @($j) } ; break } catch { Start-Sleep -Milliseconds 60 }
  }
  return @()
}
function Save-Registry($list){
  # Per-process tmp name (panel bg sync + hourly aggregator write concurrently)
  # and an ATOMIC swap: readers always see either old or new complete content.
  $tmp = "$($script:RegPath).$PID.tmp"
  $backup = "$($script:RegPath).$PID.bak"
  for($try=0; $try -lt 5; $try++){
    try {
      ConvertTo-Json -InputObject ([object[]]@($list)) -Depth 6 | Set-Content -Path $tmp -Encoding UTF8 -ErrorAction Stop
      if(Test-Path $script:RegPath){
        if(Test-Path $backup){ Remove-Item -LiteralPath $backup -ErrorAction Stop }
        [System.IO.File]::Replace($tmp, $script:RegPath, $backup, $true)
        try { if(Test-Path $backup){ Remove-Item -LiteralPath $backup -ErrorAction SilentlyContinue } } catch {}
      }
      else { Move-Item $tmp $script:RegPath -Force -ErrorAction Stop }
      return $true
    } catch { Start-Sleep -Milliseconds 150 }
  }
  try { if(Test-Path $tmp){ Remove-Item $tmp -Force -ErrorAction SilentlyContinue } } catch {}
  try { if(Test-Path $backup){ Remove-Item $backup -Force -ErrorAction SilentlyContinue } } catch {}
  return $false
}

function Set-ServerLifecycleSettings {
  param(
    [Parameter(Mandatory=$true)][int]$Port,
    [Parameter(Mandatory=$true)][bool]$Persistent,
    [Parameter(Mandatory=$true)][bool]$StartOnRestart,
    [bool]$RunEnabled = $true
  )
  # Panel clicks and the hourly aggregator can land together. Reuse the same
  # named mutex as Sync-Registry so a checkbox can never be lost to a stale
  # discovery write.
  $mtx=New-Object System.Threading.Mutex($false,'Global\ServerControlRegistry_JP')
  $got=$false
  try {
    try { $got=$mtx.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $got=$true }
    if(-not $got){ return $null }
    $rows=@(Read-Registry)
    $row=$rows | Where-Object { [int]$_.Port -eq $Port } | Select-Object -First 1
    if(-not $row){ return $null }
    foreach($pair in @{
      Persistent=$Persistent
      StartOnRestart=$StartOnRestart
      RunEnabled=$RunEnabled
    }.GetEnumerator()){
      if($row.PSObject.Properties[$pair.Key]){ $row.($pair.Key)=$pair.Value }
      else { Add-Member -InputObject $row -NotePropertyName $pair.Key -NotePropertyValue $pair.Value -Force }
    }
    if(Save-Registry $rows){ return $row }
    return $null
  } finally {
    if($got){ try { $mtx.ReleaseMutex() } catch {} }
    $mtx.Dispose()
  }
}

function ConvertTo-RegistryStructure($list){
  # Deliberately omit FirstSeen/LastSeen. They are observational timestamps and
  # should not turn every listener refresh into a registry rewrite. Lifecycle
  # flags are user choices, so they are part of the normalized shape and must
  # survive every discovery/aggregation pass.
  $rows = @(
    foreach($entry in @($list)){
      [pscustomobject][ordered]@{
        Name      = if($null -eq $entry.Name){ $null } else { [string]$entry.Name }
        Port      = [int]$entry.Port
        Url       = if($null -eq $entry.Url){ $null } else { [string]$entry.Url }
        Exe       = if($null -eq $entry.Exe){ $null } else { [string]$entry.Exe }
        Args      = @($entry.Args | ForEach-Object { [string]$_ })
        ArgLine   = if($null -eq $entry.ArgLine){ $null } else { [string]$entry.ArgLine }
        WorkDir   = if($null -eq $entry.WorkDir){ $null } else { [string]$entry.WorkDir }
        Source    = if($null -eq $entry.Source){ $null } else { [string]$entry.Source }
        Managed   = [bool]$entry.Managed
        Persistent = [bool]$entry.Persistent
        StartOnRestart = [bool]$entry.StartOnRestart
        RunEnabled = if($null -eq $entry.RunEnabled){ $true } else { [bool]$entry.RunEnabled }
      }
    }
  )
  return (ConvertTo-Json -InputObject ([object[]]$rows) -Depth 6 -Compress)
}

function Test-RegistryStructureEqual($left,$right){
  return ((ConvertTo-RegistryStructure $left) -eq (ConvertTo-RegistryStructure $right))
}

function Assert-RegistryParity([object[]]$registry){
  $expectedPorts = @($script:ExpectedCuratedPorts | Sort-Object)
  $curatedPorts = @($script:Curated | ForEach-Object { [int]$_.Port } | Sort-Object)
  if(@(Compare-Object -ReferenceObject $expectedPorts -DifferenceObject $curatedPorts).Count -ne 0){
    throw "Curated ports drifted from the required set: $($script:ExpectedCuratedPorts -join ', ')."
  }

  $allPorts = @($registry | ForEach-Object { [int]$_.Port })
  if($allPorts.Count -ne @($allPorts | Select-Object -Unique).Count){
    throw 'Registry contains duplicate ports.'
  }

  $known = @($registry | Where-Object { $_.Source -eq 'known' })
  $knownPorts = @($known | ForEach-Object { [int]$_.Port } | Sort-Object)
  if(@(Compare-Object -ReferenceObject $expectedPorts -DifferenceObject $knownPorts).Count -ne 0){
    throw 'Persisted known ports do not match the curated port set.'
  }

  foreach($curated in $script:Curated){
    # NOT $matches -- that is the automatic variable -match writes into, so any
    # later -match in this loop would silently clobber it.
    $portRows = @($known | Where-Object { [int]$_.Port -eq [int]$curated.Port })
    if($portRows.Count -ne 1){ throw "Expected exactly one known row on port $($curated.Port)." }
    $actual = $portRows[0]
    foreach($field in @('Name','Url','Exe','WorkDir')){
      if([string]$actual.$field -cne [string]$curated.$field){
        throw "Known row on port $($curated.Port) has the wrong $field."
      }
    }
    if(-not [bool]$actual.Managed){ throw "Known row on port $($curated.Port) is not managed." }
    $actualArgs = @($actual.Args | ForEach-Object { [string]$_ })
    $expectedArgs = @($curated.Args | ForEach-Object { [string]$_ })
    if($actualArgs.Count -ne $expectedArgs.Count -or @(Compare-Object -ReferenceObject $expectedArgs -DifferenceObject $actualArgs -SyncWindow 0).Count -ne 0){
      throw "Known row on port $($curated.Port) has the wrong Args."
    }
  }
}

# ---- merge curated + stored + live discovery ----------------------
# Returns the full server list; writes json if anything changed.
function Sync-Registry {
  param([object[]]$Listeners)
  # Cross-process lock: the panel's background sync and the hourly aggregator
  # both do read-merge-write here; unserialized, the slower writer would
  # revert the other's learned entries. Global\ covers non-interactive tasks.
  $mtx = New-Object System.Threading.Mutex($false,'Global\ServerControlRegistry_JP')
  $got = $false
  try {
  try { $got = $mtx.WaitOne(10000) } catch [System.Threading.AbandonedMutexException] { $got = $true }
  if(-not $got){ return (Read-Registry) }              # busy: skip this sync, don't race

  $now = (Get-Date).ToString('s')
  $stored = Read-Registry
  $storedByPort = @{}
  foreach($s in $stored){
    $storedPort = [int]$s.Port
    if(-not $storedByPort.ContainsKey($storedPort)){ $storedByPort[$storedPort] = $s }
  }
  $byPort = @{}

  # 1) curated servers are always present & authoritative
  foreach($c in $script:Curated){
    $previous = $storedByPort[[int]$c.Port]
    $firstSeen = if($previous -and $previous.FirstSeen){ [string]$previous.FirstSeen } else { $now }
    $lastSeen = if($previous -and $previous.LastSeen){ [string]$previous.LastSeen } else { $now }
    $persistent = if($previous -and $null -ne $previous.Persistent){ [bool]$previous.Persistent } else { $false }
    $startOnRestart = if($previous -and $null -ne $previous.StartOnRestart){ [bool]$previous.StartOnRestart } else { $false }
    $runEnabled = if($previous -and $null -ne $previous.RunEnabled){ [bool]$previous.RunEnabled } else { $true }
    $byPort[[int]$c.Port] = [pscustomobject]@{
      Name=$c.Name; Port=[int]$c.Port; Url=$c.Url; Exe=$c.Exe; Args=@($c.Args); ArgLine=$null;
      WorkDir=$c.WorkDir; Source='known'; Managed=$true; Persistent=$persistent; StartOnRestart=$startOnRestart; RunEnabled=$runEnabled;
      FirstSeen=$firstSeen; LastSeen=$lastSeen
    }
  }
  # 2) carry over previously-discovered (non-curated) entries, but evict any
  #    auto entry that hasn't been re-confirmed listening in a bounded
  #    window instead of carrying it forward forever.
  $evictCutoff = (Get-Date).AddHours(-$script:AutoEvictAfterHours)
  foreach($s in $stored){
    $pt=[int]$s.Port
    if($byPort.ContainsKey($pt)){ continue }
    $srcType = $(if($s.Source){[string]$s.Source}else{'auto'})
    # A stored 'known' row whose port is no longer curated is a ghost left by an
    # earlier definition (curated entry re-ported or renamed). Step 1 already
    # emitted the current truth, so drop it rather than carrying it forever.
    if($srcType -eq 'known' -and $pt -notin $script:ExpectedCuratedPorts){ continue }
    if($srcType -ne 'known' -and -not $script:AutoDiscoveryEnabled){ continue }  # discovery off: purge stored auto rows
    if($srcType -ne 'known'){
      $lastSeenVal = $null
      try { if($s.LastSeen){ $lastSeenVal = [datetime]$s.LastSeen } } catch {}
      if(-not $lastSeenVal -or $lastSeenVal -lt $evictCutoff){ continue }   # stale: drop, don't carry forward
    }
    $byPort[$pt] = [pscustomobject]@{
      Name=$s.Name; Port=$pt; Url=$s.Url; Exe=$s.Exe; Args=@($s.Args); ArgLine=$s.ArgLine;
      WorkDir=$s.WorkDir; Source=$srcType; Managed=[bool]$s.Managed;
      Persistent=if($null -eq $s.Persistent){$false}else{[bool]$s.Persistent};
      StartOnRestart=if($null -eq $s.StartOnRestart){$false}else{[bool]$s.StartOnRestart};
      RunEnabled=if($null -eq $s.RunEnabled){$true}else{[bool]$s.RunEnabled};
      FirstSeen=($(if($s.FirstSeen){$s.FirstSeen}else{$now})); LastSeen=$s.LastSeen
    }
  }
  # 3) fold in whatever is listening right now. New (non-curated, not yet
  #    stored) listeners are not recorded immediately: they must first
  #    persist as a candidate across $script:MinConsecutiveScans consecutive
  #    Sync-Registry calls on the same port+PID. This is what keeps a
  #    short-lived test/agent process off the registry entirely, without
  #    needing to know anything about who launched it.
  $listenerSet = if($PSBoundParameters.ContainsKey('Listeners')){ @($Listeners) } else { @(Get-DevListeners) }
  $candidatePath = "$($script:RegPath).candidates.json"
  $priorCandidates = @{}
  try {
    if(Test-Path $candidatePath){
      $raw = Get-Content $candidatePath -Raw -ErrorAction Stop | ConvertFrom-Json
      foreach($c in @($raw)){ if($c -and $c.Port){ $priorCandidates[[int]$c.Port] = $c } }
    }
  } catch { $priorCandidates = @{} }
  $nextCandidates = @()
  foreach($l in $listenerSet){
    $pt=$l.Port
    if($byPort.ContainsKey($pt)){
      $byPort[$pt].LastSeen = $now                       # refresh known/seen
      if($byPort[$pt].Source -ne 'known' -and -not $byPort[$pt].WorkDir -and $l.WorkDir){
        $byPort[$pt].WorkDir=$l.WorkDir; $byPort[$pt].Exe=$l.Exe; $byPort[$pt].ArgLine=$l.ArgLine
        # local fixed drives only: a network WorkDir would hang the panel's Start
        $byPort[$pt].Managed=[bool]($l.WorkDir -and (Test-LocalFixedPath $l.WorkDir) -and (Test-Path $l.WorkDir))
      }
      continue
    }
    if(Test-EphemeralWorkPath $l.WorkDir){ continue }   # belt-and-suspenders: never candidate, regardless of caller
    $prior = $priorCandidates[[int]$pt]
    $samePid = $prior -and $prior.ProcessId -and ([int]$prior.ProcessId -eq [int]$l.ProcessId)
    $count = if($samePid){ [int]$prior.Count + 1 } else { 1 }
    $firstSeenCandidate = if($samePid -and $prior.FirstSeen){ [string]$prior.FirstSeen } else { $now }
    if(-not $script:AutoDiscoveryEnabled){ continue }   # never promote a listener into the panel
    if($count -ge $script:MinConsecutiveScans){
      $managed = [bool]($l.WorkDir -and (Test-LocalFixedPath $l.WorkDir) -and (Test-Path $l.WorkDir) -and $l.Exe)
        $byPort[$pt] = [pscustomobject]@{
          Name=$l.Name; Port=$pt; Url=("http://127.0.0.1:{0}/" -f $pt); Exe=$l.Exe; Args=@(); ArgLine=$l.ArgLine;
          WorkDir=$l.WorkDir; Source='auto'; Managed=$managed; Persistent=$false; StartOnRestart=$false; RunEnabled=$true;
          FirstSeen=$firstSeenCandidate; LastSeen=$now
      }
      # promoted: no longer a candidate
    } else {
      $nextCandidates += [pscustomobject]@{ Port=[int]$pt; ProcessId=[int]$l.ProcessId; Count=$count; FirstSeen=$firstSeenCandidate }
    }
  }
  # Candidates not seen again this round (process already gone) are simply
  # not re-added to $nextCandidates above, so they fall out here.
  try {
    $tmp = "$candidatePath.$PID.tmp"
    ConvertTo-Json -InputObject ([object[]]@($nextCandidates)) -Depth 3 | Set-Content -Path $tmp -Encoding UTF8 -ErrorAction Stop
    Move-Item -LiteralPath $tmp -Destination $candidatePath -Force -ErrorAction Stop
  } catch { try { if(Test-Path $tmp){ Remove-Item $tmp -Force -ErrorAction SilentlyContinue } } catch {} }

  $list = @($byPort.Values | Sort-Object Port)
  # Persist any structural normalization: curated upserts replace stale auto
  # rows, duplicates collapse by port, and learned discovery fields survive.
  $missingLifecycleFields=@($stored | Where-Object {
    -not $_.PSObject.Properties['Persistent'] -or
    -not $_.PSObject.Properties['StartOnRestart'] -or
    -not $_.PSObject.Properties['RunEnabled']
  }).Count -gt 0
  if(-not (Test-Path $script:RegPath) -or $missingLifecycleFields -or -not (Test-RegistryStructureEqual $stored $list)){ Save-Registry $list | Out-Null }
  return $list

  } finally {
    if($got){ try { $mtx.ReleaseMutex() } catch {} }
    $mtx.Dispose()
  }
}

function Test-RegistryParity {
  [CmdletBinding()]
  param([string]$RegistryPath = $script:RegPath)

  $originalRegPath = $script:RegPath
  $fixturePath = $null
  try {
    # The real registry is read only; normalization runs against an isolated
    # fixture with discovery explicitly disabled.
    $script:RegPath = $RegistryPath
    Assert-RegistryParity @(Read-Registry)

    $fixturePath = Join-Path ([System.IO.Path]::GetTempPath()) ("server-control-registry-smoke-{0}.json" -f [guid]::NewGuid().ToString('N'))
    $script:RegPath = $fixturePath
    $syntheticAuto = @(
      [pscustomobject]@{
        Name='Visualizer on 3889'; Port=3889; Url='http://127.0.0.1:3889/'; Exe='C:\temp\node.exe'; Args=@(); ArgLine='server.js';
        WorkDir='C:\temp'; Source='auto'; Managed=$false; FirstSeen='2000-01-01T00:00:00'; LastSeen='2000-01-01T00:00:00'
      },
      [pscustomobject]@{
        Name='Duplicate Visualizer'; Port=3889; Url='http://127.0.0.1:3889/'; Exe='C:\temp\node.exe'; Args=@(); ArgLine='server.js';
        WorkDir='C:\temp'; Source='auto'; Managed=$false; FirstSeen='2000-01-01T00:00:00'; LastSeen='2000-01-01T00:00:00'
      }
    )
    if(-not (Save-Registry $syntheticAuto)){ throw 'Could not create the isolated registry fixture.' }

    $normalized = @(Sync-Registry -Listeners @())
    $persisted = @(Read-Registry)
    if(-not (Get-Content -Raw -LiteralPath $fixturePath).TrimStart().StartsWith('[')){
      throw 'Normalized fixture did not preserve the root-array registry schema.'
    }
    Assert-RegistryParity $persisted
    if(-not (Test-RegistryStructureEqual $normalized $persisted)){
      throw 'Normalized fixture was not persisted.'
    }
    $repairedVisualizer = @($persisted | Where-Object { [int]$_.Port -eq 3889 })
    if($repairedVisualizer.Count -ne 1 -or $repairedVisualizer[0].Source -ne 'known' -or $repairedVisualizer[0].Name -ne 'Agent Activity Visualizer'){
      throw 'Synthetic auto rows on port 3889 were not collapsed and replaced by the curated row.'
    }
    return $true
  } finally {
    $script:RegPath = $originalRegPath
    if($fixturePath -and (Test-Path -LiteralPath $fixturePath)){ Remove-Item -LiteralPath $fixturePath -ErrorAction SilentlyContinue }
    if($fixturePath -and (Test-Path -LiteralPath ($fixturePath + '.candidates.json'))){ Remove-Item -LiteralPath ($fixturePath + '.candidates.json') -ErrorAction SilentlyContinue }
  }
}
