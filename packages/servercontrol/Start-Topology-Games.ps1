[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'ServerControl.Common.ps1')
$profile=Get-ServerControlHostProfile
$python=$profile.Python; $work=$profile.Topology; $port=4702
if(-not (Test-Path $python)){ throw "Python missing: $python" }
if(-not (Test-Path $work)){ throw "Topology Games folder missing: $work" }
$existing=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if($existing.Count -gt 0){ [pscustomobject]@{status='already-running';port=$port;pid=$existing[0].OwningProcess}|ConvertTo-Json -Compress; exit 0 }
$log=Join-Path $PSScriptRoot 'logs'; New-Item -ItemType Directory -Path $log -Force|Out-Null
[System.IO.File]::WriteAllText((Join-Path $log 'Topology_Games.out.log'),'')
[System.IO.File]::WriteAllText((Join-Path $log 'Topology_Games.err.log'),'')
$p=Start-Process -FilePath $python -ArgumentList @('-m','http.server','4702','--bind','127.0.0.1') -WorkingDirectory $work -WindowStyle Hidden -RedirectStandardOutput (Join-Path $log 'Topology_Games.out.log') -RedirectStandardError (Join-Path $log 'Topology_Games.err.log') -PassThru
Start-Sleep -Milliseconds 500
if($p.HasExited){ throw "Topology Games exited with code $($p.ExitCode)" }
[pscustomobject]@{status='started';port=$port;pid=$p.Id}|ConvertTo-Json -Compress
