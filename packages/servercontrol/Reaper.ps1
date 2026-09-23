<#
  Reaper.ps1  -  safely sweeps leaked / orphaned helper processes.

  Runs automatically via the "OrphanReaper" scheduled task (every 30 min).
  You should never need to run this by hand.

  It KILLS only:
    (A) node/python scripts running out of a Temp folder  (test scaffolds), or
    (B) Playwright / MCP helper processes whose launching agent
        (Claude, Codex, or the VS Code window) is no longer alive.

  It NEVER kills:
    - anything listening on a TCP port            (your running servers)
    - anything matching a protected pattern       (-ProtectedPatterns, or one
                                                   regex per line in
                                                   reaper-protected.txt beside
                                                   this script)
    - anything still reachable from a live         VS Code / Claude / Codex / terminal
    - anything younger than -MinAgeMinutes         (won't race a fresh spawn)

  Every action is written to reaper-log.txt next to this file.
  Preview without killing:   powershell -File Reaper.ps1 -WhatIf
#>
param([switch]$WhatIf, [int]$MinAgeMinutes = 5, [string[]]$ProtectedPatterns = @())

$ErrorActionPreference = 'SilentlyContinue'
$log = Join-Path $PSScriptRoot 'reaper-log.txt'
# rotate log if it gets big
if((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)){ Get-Content $log -Tail 300 | Set-Content ($log+'.tmp'); Move-Item ($log+'.tmp') $log -Force }
function Log($m){ Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $m) }

try {
  $all  = Get-CimInstance Win32_Process
  $byId = @{}
  foreach($p in $all){ $byId[[int64]$p.ProcessId] = $p }

  # a live process of one of these names = a real, in-use context
  $anchors = 'explorer.exe','claude.exe','codex.exe','Code.exe','WindowsTerminal.exe',
             'OpenConsole.exe','powershell.exe','pwsh.exe','bash.exe','wt.exe','sihost.exe'

  # PIDs listening on a TCP port => protected servers
  $listen = @{}
  Get-NetTCPConnection -State Listen | ForEach-Object { $listen[[int64]$_.OwningProcess] = $true }

  # Known-server protection is CONFIGURATION, not code. Listening processes are
  # already protected unconditionally above; these patterns exist for the
  # long-lived helpers that can be observed without their listen socket (a dev
  # server mid-reload, a worker that binds late). Each entry is a regex matched
  # against the full command line. 'uvicorn' ships as the one default because
  # its reload supervisor is exactly such a helper; add your own via
  # -ProtectedPatterns or reaper-protected.txt (one regex per line, # comments
  # allowed) next to this script.
  $protected = @('uvicorn') + @($ProtectedPatterns)
  $protectedFile = Join-Path $PSScriptRoot 'reaper-protected.txt'
  if(Test-Path $protectedFile){
    $protected += @(Get-Content $protectedFile | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' -and -not $_.StartsWith('#') })
  }
  $protectedRe = ($protected | Where-Object { $_ }) -join '|'

  # CIM already returns CreationDate as [datetime]; ConvertToDateTime only
  # exists on legacy WMI objects and would silently null every timestamp,
  # killing both the MinAge guard and the PID-reuse check.
  function StartTime($c){ $c.CreationDate }

  # true if the parent chain reaches a LIVE anchor via only-live, time-consistent links
  function ReachesLiveAnchor($start){
    $cur=[int64]$start; $seen=@{}
    for($i=0;$i -lt 40;$i++){
      if(-not $byId.ContainsKey($cur)){ return $false }
      if($seen.ContainsKey($cur)){ return $false }
      $seen[$cur]=$true
      if($listen.ContainsKey($cur)){ return $true }   # descendant of a live listening server
      $o=$byId[$cur]
      if($anchors -contains $o.Name){ return $true }
      $pp=[int64]$o.ParentProcessId
      if($pp -eq 0 -or $pp -eq $cur -or -not $byId.ContainsKey($pp)){ return $false }
      $ct=StartTime $o; $pt=StartTime $byId[$pp]
      if($ct -and $pt -and $pt -gt $ct){ return $false }   # PID-reuse: not the real parent
      $cur=$pp
    }
    return $false
  }

  $now=Get-Date; $killed=0
  foreach($p in $all){
    if(@('node.exe','python.exe','pythonw.exe') -notcontains $p.Name){ continue }
    $cmd=[string]$p.CommandLine
    if([string]::IsNullOrEmpty($cmd)){ continue }
    $id=[int64]$p.ProcessId

    if($listen.ContainsKey($id)){ continue }                                   # a live server
    if($protectedRe -and $cmd -match $protectedRe){ continue }                 # configured protected pattern

    $st=StartTime $p
    if($st -and ($now-$st).TotalMinutes -lt $MinAgeMinutes){ continue }        # too fresh

    $temp = $cmd -match '\\AppData\\Local\\Temp\\|[/\\]Temp[/\\].*(test|beacon)'
    $mcp  = $cmd -match '@playwright[/\\]mcp|playwright-mcp|playwright-gateway\.js|mcp-server\.js|@playwright\\mcp\\cli\.js'
    if(-not ($temp -or $mcp)){ continue }

    if(ReachesLiveAnchor $id){ continue }                                      # still owned by a live agent

    $cpu=[math]::Round(($p.UserModeTime+$p.KernelModeTime)/10000000,0)
    $short=($cmd -replace '"',''); if($short.Length -gt 130){ $short=$short.Substring(0,130)+'...' }
    $why= if($temp){'temp-leftover'} else {'abandoned-mcp'}
    if($WhatIf){ Log ("WHATIF kill PID {0} [{1}] cpu={2}s : {3}" -f $id,$why,$cpu,$short) }
    else {
      Stop-Process -Id $id -Force
      if($?){ Log ("KILLED PID {0} [{1}] cpu={2}s : {3}" -f $id,$why,$cpu,$short); $killed++ }
    }
  }
  if(-not $WhatIf -and $killed -gt 0){ Log ("sweep complete: reaped $killed process(es)") }
}
catch { Log ("ERROR: " + $_.Exception.Message) }
