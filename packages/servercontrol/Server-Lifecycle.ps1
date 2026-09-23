[CmdletBinding()]
param(
  [ValidateSet('Persistent','StartOnRestart')]
  [string]$Mode,
  [switch]$Reconcile
)

# ServerControl's lifecycle worker is deliberately separate from the WinForms
# panel.  The panel can be closed or crash; this worker still enforces the
# choices stored in servers.json.  It never touches an unlisted port.
$ErrorActionPreference = 'SilentlyContinue'
$root = $PSScriptRoot
$registryScript = Join-Path $root 'ServerRegistry.ps1'
$logPath = Join-Path $root 'lifecycle-log.txt'
$powershellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$persistentTask = 'ServerControl - Persistent Watchdog'
$restartTask = 'ServerControl - Start on restart'
$lifecycleMutexName = 'Global\ServerControlLifecycle'
$healthPath = Join-Path $root 'lifecycle-health.json'

function Write-LifecycleLog([string]$message) {
  try {
    if((Test-Path -LiteralPath $logPath) -and ((Get-Item -LiteralPath $logPath).Length -gt 512KB)){
      Get-Content -LiteralPath $logPath -Tail 200 | Set-Content -LiteralPath ($logPath + '.tmp') -Encoding UTF8
      Move-Item -LiteralPath ($logPath + '.tmp') -Destination $logPath -Force
    }
    Add-Content -LiteralPath $logPath -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'),$message) -Encoding UTF8
  } catch {}
}

if(-not (Test-Path -LiteralPath $registryScript)){ exit 1 }
. $registryScript

function Get-Flag($row,[string]$name,[bool]$fallback=$false){
  $prop = $row.PSObject.Properties[$name]
  if($null -eq $prop -or $null -eq $prop.Value){ return $fallback }
  return [bool]$prop.Value
}

function Test-Listening([int]$port){
  try {
    return [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
      Where-Object { [int]$_.Port -eq $port } | Select-Object -First 1
  } catch { return $null }
}

function Get-ListenerProcess([int]$port){
  $listener = Test-Listening $port
  if(-not $listener){ return $null }
  try {
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    $row = $connections | Select-Object -First 1
    if(-not $row){ return $null }
    $processId = [int]$row.OwningProcess
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    return [pscustomobject]@{ Port=$port; ProcessId=$processId; Process=$process; Listener=$listener }
  } catch { return $null }
}

function Test-ListenerMatchesRow($row, $listener){
  if(-not $listener -or -not $listener.Process){ return $false }
  $command = [string]$listener.Process.CommandLine
  if([string]::IsNullOrWhiteSpace($command)){ return $false }
  $exeName = ''
  try { $exeName = [System.IO.Path]::GetFileName([string]$row.Exe) } catch {}
  if($exeName -and $command -notmatch [regex]::Escape($exeName)){ return $false }
  $args = @($row.Args | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if($args.Count -eq 0){ return $true }
  # The first meaningful argument identifies the declared server.  Matching
  # one stable token is safer than requiring PowerShell's quoting to be
  # byte-for-byte identical across scheduled and interactive launches.
  $identity = $args[0]
  if($identity -match '^-'){
    $identity = $args | Where-Object { $_ -notmatch '^-' } | Select-Object -First 1
  }
  if($identity -and $command -match [regex]::Escape([string]$identity)){ return $true }
  if($command -match '(?i)-m\s+app\.main|app\.main'){ return $true }
  return $false
}

function Write-HealthSnapshot([string]$status,[string]$detail){
  try {
    $snapshot = [ordered]@{
      updatedAt=(Get-Date).ToUniversalTime().ToString('o')
      status=$status
      detail=$detail
      mode=$Mode
    }
    $tmp = "$healthPath.$PID.tmp"
    ($snapshot | ConvertTo-Json -Compress) | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $healthPath -Force
  } catch {}
}

function ConvertTo-NativeArgumentString([string[]]$values){
  return (@($values | ForEach-Object {
    $value=[string]$_
    if($value.Length -eq 0){ return '""' }
    return '"' + $value.Replace('"','\"') + '"'
  }) -join ' ')
}

function Start-ServerRow($row){
  $port=[int]$row.Port
  $existing = Get-ListenerProcess $port
  if($existing){
    if(Test-ListenerMatchesRow $row $existing){ return $false }
    Write-LifecycleLog ("refused to start '{0}' on port {1}: listener PID {2} does not match the declared command" -f $row.Name,$port,$existing.ProcessId)
    return $false
  }
  $exe=[string]$row.Exe
  $work=[string]$row.WorkDir
  if([string]::IsNullOrWhiteSpace($exe) -or ($work -and -not (Test-Path -LiteralPath $work))){ return $false }
  if($exe -like '\\*'){ return $false }
  $args=@($row.Args | ForEach-Object {[string]$_})
  $argumentLine=if($args.Count -gt 0){ ConvertTo-NativeArgumentString $args } elseif($row.ArgLine){ [string]$row.ArgLine } else { '' }
  if($exe -match '\.(cmd|bat)$'){
    $batch='"' + $exe.Replace('"','\"') + '"'
    $exe=$env:ComSpec
    $argumentLine='/d /s /c call ' + $batch + $(if($argumentLine){' '+$argumentLine}else{''})
  }
  try {
    $logDir = Join-Path $root 'logs'
    if(-not (Test-Path -LiteralPath $logDir)){ New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $safeName = ([string]$row.Name -replace '[^A-Za-z0-9._-]+','_')
    if([string]::IsNullOrWhiteSpace($safeName)){ $safeName = 'server' }
    $stdoutPath = Join-Path $logDir ($safeName + '.out.log')
    $stderrPath = Join-Path $logDir ($safeName + '.err.log')
    $startArgs = if([string]::IsNullOrWhiteSpace($argumentLine)){ @() } else { @($argumentLine) }
    $p = Start-Process -FilePath $exe -ArgumentList $startArgs -WorkingDirectory $work -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru -ErrorAction Stop
    $childId = [int]$p.Id
    $deadline=(Get-Date).AddSeconds(12)
    $verified=$false
    while((Get-Date) -lt $deadline){
      Start-Sleep -Milliseconds 500
      $current = Get-ListenerProcess $port
      if($current -and (Test-ListenerMatchesRow $row $current)) { $verified=$true; break }
      if($p.HasExited){ break }
    }
    if(-not $verified){
      $current = Get-ListenerProcess $port
      $holder = if($current){ "PID $($current.ProcessId)" } else { 'no listener' }
      Write-LifecycleLog ("start verification failed '{0}' on port {1}: {2}" -f $row.Name,$port,$holder)
      return $false
    }
    Write-LifecycleLog ("started and verified '{0}' on port {1} (mode={2}, launcherPid={3})" -f $row.Name,$port,$Mode,$childId)
    return $true
  } catch {
    Write-LifecycleLog ("start failed '{0}' on port {1}: {2}" -f $row.Name,$port,$_.Exception.Message)
    return $false
  }
}

function New-LifecycleAction([string]$mode){
  $arg='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Mode {1}' -f $PSCommandPath,$mode
  return (New-ScheduledTaskAction -Execute $powershellExe -Argument $arg)
}

function Register-LifecycleTask([string]$taskName,[string]$mode,[bool]$repeat){
  try {
    if($repeat){
      # A repeating once-trigger survives reboot and StartWhenAvailable catches
      # a missed interval. Add an AtLogOn trigger as well so a newly signed-in
      # session starts immediately instead of waiting for the next minute.
      $trigger=@(
        (New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name))
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 365))
      )
    } else {
      $trigger=@((New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)))
    }
    $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $taskName -Action (New-LifecycleAction $mode) -Trigger $trigger -Settings $settings -Description 'ServerControl lifecycle preference' -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -RunLevel Limited -Force | Out-Null
    Write-LifecycleLog ("registered task '{0}'" -f $taskName)
  } catch { Write-LifecycleLog ("task register failed '{0}': {1}" -f $taskName,$_.Exception.Message) }
}

function Remove-LifecycleTask([string]$taskName){
  try {
    if(Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue){
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
      Write-LifecycleLog ("removed task '{0}'" -f $taskName)
    }
  } catch { Write-LifecycleLog ("task remove failed '{0}': {1}" -f $taskName,$_.Exception.Message) }
}

if($Reconcile){
  $rows=@(Read-Registry)
  $hasPersistent=@($rows | Where-Object { (Get-Flag $_ 'Persistent') }).Count -gt 0
  $hasRestart=@($rows | Where-Object { (Get-Flag $_ 'StartOnRestart') }).Count -gt 0
  if($hasPersistent){ Register-LifecycleTask $persistentTask 'Persistent' $true } else { Remove-LifecycleTask $persistentTask }
  if($hasRestart){ Register-LifecycleTask $restartTask 'StartOnRestart' $false } else { Remove-LifecycleTask $restartTask }
  exit 0
}

if(-not $Mode){ exit 0 }
$mutex = New-Object System.Threading.Mutex($false,$lifecycleMutexName)
$locked = $false
try {
  try { $locked=$mutex.WaitOne(15000) } catch [System.Threading.AbandonedMutexException] { $locked=$true }
  if(-not $locked){ Write-HealthSnapshot 'busy' 'another lifecycle pass is still running'; exit 0 }
  $rows=@(Read-Registry)
  $started=0; $selectedCount=0
  foreach($row in $rows){
    $selected = if($Mode -eq 'Persistent'){
      (Get-Flag $row 'Persistent') -and (Get-Flag $row 'RunEnabled' $true)
    } else {
      (Get-Flag $row 'StartOnRestart') -and (Get-Flag $row 'RunEnabled' $true)
    }
    if($selected -and [bool]$row.Managed){
      $selectedCount++
      if(Start-ServerRow $row){ $started++ }
    }
  }
  Write-HealthSnapshot 'ok' ("mode={0}; selected={1}; started={2}" -f $Mode,$selectedCount,$started)
} catch {
  Write-LifecycleLog ("lifecycle pass failed (mode={0}): {1}" -f $Mode,$_.Exception.Message)
  Write-HealthSnapshot 'error' $_.Exception.Message
} finally {
  if($locked){ try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
exit 0
