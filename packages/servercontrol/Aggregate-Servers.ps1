# ============================================================
#   Aggregate-Servers.ps1
#   Runs hourly (task "ServerAggregator"). Scans for local servers
#   and folds any new ones into servers.json so they appear in the
#   control panel automatically. Logs new discoveries.
# ============================================================
. (Join-Path $PSScriptRoot 'ServerRegistry.ps1')

$log = Join-Path $PSScriptRoot 'aggregator-log.txt'
if((Test-Path $log) -and ((Get-Item $log).Length -gt 512KB)){ Get-Content $log -Tail 200 | Set-Content ($log+'.tmp'); Move-Item ($log+'.tmp') $log -Force }
function Log($m){ Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $m) }

try {
  $beforePorts = @((Read-Registry).Port)
  $list = Sync-Registry
  $new  = @($list | Where-Object { $_.Source -ne 'known' -and $beforePorts -notcontains $_.Port })
  foreach($n in $new){
    Log ("NEW server on port {0}: '{1}'  managed={2}  {3}" -f $n.Port, $n.Name, $n.Managed, ($(if($n.WorkDir){$n.WorkDir}else{'(start cmd unknown)'})))
  }
  # heartbeat once a day-ish is noise; stay quiet unless there's news
}
catch { Log ("ERROR: " + $_.Exception.Message) }
