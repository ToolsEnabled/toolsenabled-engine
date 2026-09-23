# Stops whatever listens on -Port (plus its launcher parent + child tree).
# Run detached by the control panel so the UI never blocks on WMI/taskkill.
#
# THIS SCRIPT USED TO END IN A BARE `exit 0`, ALWAYS.
#
# Every failure mode reached it. Measured on 2026-08-09, both non-elevated and
# without touching a live service:
#   - `-Port 445`: the only listener is owned by PID 4, which the guard below
#     deliberately skips. The script printed nothing and exited 0. Port 445 was
#     still listening. The panel reads that as "stopped".
#   - taskkill.exe made unreachable (SystemRoot redirected in a child shell):
#     Invoke-HiddenTaskKill's `catch {}` swallowed the launch failure, a
#     disposable listener on 127.0.0.1:51987 survived untouched, and the script
#     exited 0 again.
# In both cases the process that was supposed to be gone was still serving the
# port. A stop command that cannot fail is not a stop command; it is a delay.
#
# The fix is a POST-CONDITION, not a tidier return value: after the kill pass,
# the port is measured again, and the exit code reports what was actually
# observed. Discovery that FAILS is reported as its own state, because "I could
# not enumerate the port" and "nothing is listening on the port" are opposite
# facts that this script previously rendered identically.
#
# EXIT CODES (the caller may treat any non-zero as "not stopped"):
#   0  the port is verifiably free: nothing was listening, or every listener
#      that was there is gone.
#   2  DISCOVERY FAILED. Whether anything listens is UNKNOWN. Never 0.
#   3  the port is STILL HELD by a process this script targeted (kill refused,
#      kill tool unavailable, or a protected PID it must not touch).
#   4  an unexpected terminating error.
#   5  every targeted listener is gone but a DIFFERENT process now holds the
#      port, so the port was not released to the caller.
#
# The panel currently launches this detached and does not read the exit code;
# that is a separate gap. Nothing in the repo parses this script's stdout, so
# the verdict line below is additive and breaks no caller.
#
# ASCII ONLY: PowerShell 5.1 mis-parses non-ASCII characters under the OEM
# console codepages this script can be launched with.
param([Parameter(Mandatory=$true)][int]$Port)
$ErrorActionPreference = 'Stop'

$TaskKill = Join-Path $env:SystemRoot 'System32\taskkill.exe'

# Command-line signatures of the long-running server RUNNERS this script may
# follow a listener up to. The parent walk exists because the process holding
# the port is often a worker whose launcher would respawn it immediately, so
# killing the child alone does not free the port. This is deliberately a short
# list of generic runner names rather than an installation's actual app names:
# a parent that does not look like one of these is left alone, so an ordinary
# shell, task host, or editor that happens to be an ancestor is never swept
# into a destructive operation. Widen it only with the same test in mind.
$ParentRunnerPattern = 'uvicorn|server\.js|app\.main'

function Write-Verdict([string]$Verdict, [string]$Detail){
  $line = 'STOP-BY-PORT {0} port={1} {2}' -f $Verdict, $Port, $Detail
  Write-Output $line
  if($Verdict -ne 'released'){ [Console]::Error.WriteLine($line) }
}

# Returns the taskkill outcome instead of swallowing it. 'launch_failed' is a
# distinct answer from a non-zero taskkill exit: the first means the kill was
# never attempted at all, which is exactly what the swallowed catch hid.
function Invoke-HiddenTaskKill([int]$ProcessId){
  if(-not (Test-Path -LiteralPath $TaskKill -PathType Leaf)){
    return [pscustomobject]@{ launched = $false; exitCode = $null; reason = 'taskkill_missing' }
  }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $TaskKill
  $psi.Arguments = "/F /T /PID $ProcessId"
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $p = New-Object System.Diagnostics.Process
  $p.StartInfo = $psi
  try {
    if(-not $p.Start()){
      return [pscustomobject]@{ launched = $false; exitCode = $null; reason = 'taskkill_start_returned_false' }
    }
    [void]$p.StandardOutput.ReadToEndAsync()
    [void]$p.StandardError.ReadToEndAsync()
    if(-not $p.WaitForExit(10000)){
      return [pscustomobject]@{ launched = $true; exitCode = $null; reason = 'taskkill_timeout' }
    }
    return [pscustomobject]@{ launched = $true; exitCode = [int]$p.ExitCode; reason = $null }
  } catch {
    return [pscustomobject]@{ launched = $false; exitCode = $null; reason = ('taskkill_launch_failed:' + ($_.Exception.Message -replace '[^A-Za-z0-9_.:-]', '_')) }
  } finally { $p.Dispose() }
}

# Discovery returns three answers, never two. Get-NetTCPConnection raises a
# non-terminating ObjectNotFound (CmdletizationQuery_NotFound) when the port is
# genuinely free; ANY other error means the inventory could not be read, and
# reporting that as an empty inventory is the defect this file exists to end.
function Get-PortListeners([int]$OnPort){
  $probeErrors = $null
  $rows = @(Get-NetTCPConnection -LocalPort $OnPort -State Listen -ErrorAction SilentlyContinue -ErrorVariable probeErrors)
  $hard = @(@($probeErrors) | Where-Object { $_ -and $_.CategoryInfo.Category -ne [System.Management.Automation.ErrorCategory]::ObjectNotFound })
  if($hard.Count -gt 0){
    return [pscustomobject]@{ ok = $false; rows = @(); reason = ('discovery_failed:' + (($hard[0].FullyQualifiedErrorId) -replace '[^A-Za-z0-9_.:-]', '_')) }
  }
  return [pscustomobject]@{ ok = $true; rows = @($rows); reason = $null }
}

try {
  $initial = Get-PortListeners $Port
  if(-not $initial.ok){
    Write-Verdict 'discovery_failed' ('reason=' + $initial.reason + ' note=UNKNOWN_not_free')
    exit 2
  }
  if($initial.rows.Count -eq 0){
    Write-Verdict 'released' 'reason=nothing_was_listening'
    exit 0
  }

  $targeted = @($initial.rows | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
  $notes = @()
  foreach($procId in $targeted){
    if($procId -le 4){
      # Never touch System/idle. Skipping is correct; reporting the skip as a
      # successful stop is not, so the post-condition below still runs.
      $notes += "pid$($procId)=protected_system_pid_skipped"
      continue
    }
    # Walk up through node/python/cmd launchers (e.g. uvicorn's --reload parent).
    # A parent link is only trusted when the parent predates the child - a
    # recycled PID's new occupant necessarily started AFTER the child, so this
    # guard prevents killing an unrelated process tree.
    $root = $procId
    $cur  = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    $guard = 0
    while($cur -and $guard -lt 10){
      $guard++
      $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
      # A reviewed exception; its marker is the LAST line of this block, not the
      # first. The rule it exempts is that a value which could not be READ must
      # never be reported as a confident negative. Here an unreadable
      # CommandLine gives the SAFE answer, so the usual guard does not apply. If
      # the parent's command line cannot be read the match fails, the loop
      # breaks, and we kill only the original pid instead of walking further up
      # the tree. Unreadable therefore NARROWS the kill scope rather than
      # widening it, which is the direction we want for a destructive operation.
      # The rule this exempts exists to stop "cannot read" becoming a confident
      # negative that causes harm; a conservative refusal to escalate is the
      # opposite of harm.
      #
      # Marker placement is load-bearing: tests/measurement-honesty.js#exempt
      # searches only the ten lines above the flagged line. Written at the top
      # of an eleven-line rationale the marker sat twelve lines above the
      # `-match` below and was never seen, so the reviewed exception read as an
      # unreviewed violation. MEASUREMENT-HONESTY-OK
      if($parent -and $parent.Name -match '^(node|python|pythonw|cmd)\.exe$' -and
         ($parent.CommandLine -match $ParentRunnerPattern) -and
         $parent.CreationDate -and $cur.CreationDate -and
         $parent.CreationDate -le $cur.CreationDate){
        $root = $parent.ProcessId; $cur = $parent
      } else { break }
    }
    $kill = Invoke-HiddenTaskKill $root
    if(-not $kill.launched){ $notes += "pid$($root)=$($kill.reason)" }
    elseif($null -eq $kill.exitCode){ $notes += "pid$($root)=$($kill.reason)" }
    elseif($kill.exitCode -ne 0){ $notes += "pid$($root)=taskkill_exit_$($kill.exitCode)" }
    # Self-verify: if we killed a walked-up root but the listener survived
    # (ancestry edge case), kill the listening PID directly.
    if($root -ne $procId){
      Start-Sleep -Milliseconds 400
      $recheck = Get-PortListeners $Port
      if($recheck.ok -and @($recheck.rows | Where-Object { [int]$_.OwningProcess -eq $procId }).Count -gt 0){
        $direct = Invoke-HiddenTaskKill $procId
        if(-not $direct.launched -or $null -eq $direct.exitCode){ $notes += "pid$($procId)=$($direct.reason)" }
        elseif($direct.exitCode -ne 0){ $notes += "pid$($procId)=taskkill_exit_$($direct.exitCode)" }
      }
    }
  }

  # THE POST-CONDITION. A socket does not always disappear the instant its owner
  # is terminated, so this is a bounded wait, not a single glance. What it must
  # never do is assume.
  $final = $null
  $deadline = (Get-Date).AddSeconds(5)
  while($true){
    $final = Get-PortListeners $Port
    if(-not $final.ok){ break }
    $survivors = @($final.rows | Where-Object { $targeted -contains [int]$_.OwningProcess })
    if($survivors.Count -eq 0){ break }
    if((Get-Date) -ge $deadline){ break }
    Start-Sleep -Milliseconds 250
  }

  if(-not $final.ok){
    Write-Verdict 'discovery_failed' ('reason=' + $final.reason + ' note=stop_outcome_UNKNOWN attempted=' + ($targeted -join ','))
    exit 2
  }
  $survivors = @($final.rows | Where-Object { $targeted -contains [int]$_.OwningProcess } | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
  if($survivors.Count -gt 0){
    Write-Verdict 'still_held' ('survivingPids=' + ($survivors -join ',') + ' targeted=' + ($targeted -join ',') + ' detail=' + (($notes -join ';') -replace '\s', '_'))
    exit 3
  }
  if($final.rows.Count -gt 0){
    $others = @($final.rows | ForEach-Object { [int]$_.OwningProcess } | Select-Object -Unique)
    Write-Verdict 'reacquired' ('targeted=' + ($targeted -join ',') + ' nowHeldBy=' + ($others -join ',') + ' detail=' + (($notes -join ';') -replace '\s', '_'))
    exit 5
  }
  $detail = if($notes.Count -gt 0){ ' detail=' + (($notes -join ';') -replace '\s', '_') } else { '' }
  Write-Verdict 'released' ('stoppedPids=' + ($targeted -join ',') + $detail)
  exit 0
} catch {
  Write-Verdict 'error' ('reason=' + (($_.Exception.Message) -replace '[^A-Za-z0-9_.:-]', '_'))
  exit 4
}
