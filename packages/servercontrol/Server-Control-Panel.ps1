# ============================================================
#   SERVER CONTROL PANEL  (v4 - non-blocking, GUID tray, reviewed)
#
#   Design rules (v2 locked up by breaking these):
#     - The UI thread NEVER calls WMI/CIM. Port checks use .NET.
#     - Discovery (slow, WMI) runs in a background runspace with a
#       watchdog; results arrive via servers.json.
#     - Stopping a server runs in a detached hidden process.
#     - Shell_NotifyIcon calls (which can block ~4s if Explorer is
#       hung) run on a dedicated worker thread, never the UI thread.
#     - Single instance via mutex; relaunching summons the window.
# ============================================================
param(
  [switch]$Minimized,
  [string]$RenderPreviewPath
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
. (Join-Path $PSScriptRoot 'ServerControl.Common.ps1')
$HostProfile = Get-ServerControlHostProfile
. (Join-Path $PSScriptRoot 'ServerRegistry.ps1')
$LifecycleScript = Join-Path $PSScriptRoot 'Server-Lifecycle.ps1'
$TunnelScript = Join-Path $PSScriptRoot 'Tunnel-Lifecycle.ps1'
$TunnelStatePath = Join-Path $PSScriptRoot 'tunnel-state.json'
$ToolsEnabledRoot = $HostProfile.ToolsEnabledRoot
$MechanicalConnectScript = Join-Path $PSScriptRoot 'Mechanical-Connect.ps1'
$MechanicalConnectStatePath = Join-Path $ToolsEnabledRoot 'state\mechanical-connect-state.json'
$FullRemoteScript = Join-Path $ToolsEnabledRoot 'tools\full-remote-access-control.ps1'
$FullRemoteFirewallScript = Join-Path $PSScriptRoot 'Full-Remote-Access-Firewall.ps1'
$FullRemoteStatePath = Join-Path $ToolsEnabledRoot 'state\full-remote-access-state.json'
$FullRemotePanelOut = Join-Path $PSScriptRoot 'logs\full-remote-control.out.log'
$FullRemotePanelErr = Join-Path $PSScriptRoot 'logs\full-remote-control.err.log'
$IconPath = Join-Path $PSScriptRoot 'ServerControl.ico'
$HeartbeatPath = Join-Path $PSScriptRoot 'panel-heartbeat.json'
$PanelEventLog = Join-Path $PSScriptRoot 'panel-events.log'
$TrayGuid = [guid]'b1e7a9c4-3f2d-4a6e-9c8b-5d7e1f2a3b4c'

# ---- single instance ---------------------------------------------
$created = $false
$instanceSuffix = if($RenderPreviewPath){ "_Preview_$PID" }else{ '' }
$script:mutex   = New-Object System.Threading.Mutex($true, ('Local\ServerControlPanel' + $instanceSuffix), [ref]$created)
$script:showEvt = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, ('Local\ServerControlPanel_Show' + $instanceSuffix))
if(-not $created){
  [void]$script:showEvt.Set()    # ask the running instance to show itself
  exit
}

# The watchdog uses this heartbeat in addition to the single-instance mutex.
# A mutex proves ownership, not responsiveness: a hung WinForms/Explorer path
# can keep it forever.  Writes are atomic so the watchdog never parses a half
# written JSON document.
function Write-PanelHeartbeat {
  try {
    $snapshot = [ordered]@{
      ProcessId = [int]$PID
      UpdatedAt = (Get-Date).ToUniversalTime().ToString('o')
      Version = 6
    }
    $tmp = "$HeartbeatPath.$PID.tmp"
    ($snapshot | ConvertTo-Json -Compress) | Set-Content -LiteralPath $tmp -Encoding UTF8
    Move-Item -LiteralPath $tmp -Destination $HeartbeatPath -Force
  } catch {}
}

function Write-PanelEvent([string]$message) {
  try { Add-Content -LiteralPath $PanelEventLog -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'),$message) -Encoding UTF8 } catch {}
}

if(-not $RenderPreviewPath){
  Write-PanelHeartbeat
  Write-PanelEvent 'panel started'
}

# ---- GUID-based tray icon ----------------------------------------
# All Shell_NotifyIcon sends are queued to ONE background worker
# thread; an unresponsive Explorer can only ever stall that worker.
$script:GuidTrayOk = $false
try {
  if(-not ('GuidTray' -as [type])){
    Add-Type -ReferencedAssemblies System.Windows.Forms -ErrorAction Stop -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
public class GuidTray : NativeWindow {
  const int WM_APP=0x8000, CB=WM_APP+1;
  const int WM_LBUTTONUP=0x0202, WM_RBUTTONUP=0x0205, WM_CONTEXTMENU=0x007B;
  const int NIN_SELECT=0x0400, NIN_KEYSELECT=0x0401;     // WM_USER+0 / +1 (VERSION_4 events)
  static readonly int WM_TBC = RegisterWindowMessage("TaskbarCreated");
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct DATA { public int cbSize; public IntPtr hWnd; public int uID; public int uFlags; public int uCB;
    public IntPtr hIcon; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=128)] public string szTip;
    public int dwState; public int dwStateMask; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string szInfo;
    public int uVer; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] public string szInfoTitle; public int dwInfoFlags;
    public Guid guidItem; public IntPtr hBalloon; }
  [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern bool Shell_NotifyIcon(int m, ref DATA d);
  [DllImport("user32.dll")] static extern int RegisterWindowMessage(string s);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  const int NIM_ADD=0,NIM_MOD=1,NIM_DEL=2,NIM_VER=4;
  const int NIF_MSG=1,NIF_ICON=2,NIF_TIP=4,NIF_INFO=0x10,NIF_GUID=0x20,NIF_SHOWTIP=0x80;
  // single worker drains all tray sends so a hung Explorer never blocks the UI thread
  static readonly BlockingCollection<object[]> _q = new BlockingCollection<object[]>();
  static GuidTray(){ var t=new Thread(Drain); t.IsBackground=true; t.Start(); }
  static void Drain(){ foreach(var it in _q.GetConsumingEnumerable()){ try { var d=(DATA)it[1]; Shell_NotifyIcon((int)it[0], ref d); } catch {} } }
  static void Q(int m, DATA d){ try { _q.Add(new object[]{ m, d }); } catch {} }
  Guid _g; IntPtr _icon; string _tip; bool _v4;
  public int AnchorX; public int AnchorY; public bool HasAnchor;
  public event Action RightClick; public event Action LeftClick;
  public GuidTray(Guid g){ _g=g; CreateHandle(new CreateParams()); }
  DATA B(){ var d=new DATA(); d.cbSize=Marshal.SizeOf(typeof(DATA)); d.hWnd=this.Handle; d.uID=1; d.guidItem=_g; return d; }
  // Synchronous - startup only; its result gates the WinForms fallback.
  public bool Show(IntPtr icon,string tip){ _icon=icon; _tip=tip; var d=B();
    d.uFlags=NIF_MSG|NIF_ICON|NIF_TIP|NIF_GUID|NIF_SHOWTIP; d.uCB=CB; d.hIcon=icon; d.szTip=tip;
    Shell_NotifyIcon(NIM_DEL, ref d);
    bool ok=Shell_NotifyIcon(NIM_ADD, ref d);
    if(ok){ d.uVer=4; _v4=Shell_NotifyIcon(NIM_VER, ref d); } else { _v4=false; }
    return ok; }
  // Async re-registration (TaskbarCreated / promotion re-add).
  public void ShowAsync(IntPtr icon,string tip){ _icon=icon; _tip=tip;
    var del=B(); del.uFlags=NIF_GUID; Q(NIM_DEL,del);
    var add=B(); add.uFlags=NIF_MSG|NIF_ICON|NIF_TIP|NIF_GUID|NIF_SHOWTIP; add.uCB=CB; add.hIcon=icon; add.szTip=tip; Q(NIM_ADD,add);
    var ver=B(); ver.uFlags=NIF_GUID; ver.uVer=4; Q(NIM_VER,ver); }
  public void Update(IntPtr icon,string tip){ _icon=icon; _tip=tip; var d=B();
    d.uFlags=NIF_ICON|NIF_TIP|NIF_GUID|NIF_SHOWTIP; d.hIcon=icon; d.szTip=tip; Q(NIM_MOD,d); }
  public void Balloon(string title,string text){ var d=B();
    d.uFlags=NIF_INFO|NIF_GUID; d.szInfoTitle=title; d.szInfo=text; d.dwInfoFlags=1; Q(NIM_MOD,d); }
  // Destroy: sync DEL (icon must vanish before process exit), clear state,
  // kill the native window so WM_TBC can never resurrect a fallback orphan.
  public void Destroy(){ _icon=IntPtr.Zero; var d=B(); d.uFlags=NIF_GUID; Shell_NotifyIcon(NIM_DEL, ref d);
    if(this.Handle!=IntPtr.Zero) DestroyHandle(); }
  public void Foreground(){ SetForegroundWindow(this.Handle); }
  protected override void WndProc(ref Message m){
    if(m.Msg==CB){
      int lo=(int)((long)m.LParam & 0xFFFF);
      if(_v4){
        // VERSION_4: shell sends raw button-ups AND translated codes for the
        // same click - handle ONLY the translated ones or every click double-fires.
        if(lo==WM_CONTEXTMENU){
          AnchorX=(short)((long)m.WParam & 0xFFFF); AnchorY=(short)(((long)m.WParam>>16) & 0xFFFF); HasAnchor=true;
          var h=RightClick; if(h!=null) h(); }
        else if(lo==NIN_SELECT || lo==NIN_KEYSELECT){ var h=LeftClick; if(h!=null) h(); }
      } else {
        if(lo==WM_RBUTTONUP){ HasAnchor=false; var h=RightClick; if(h!=null) h(); }
        else if(lo==WM_LBUTTONUP){ var h=LeftClick; if(h!=null) h(); }
      }
    }
    else if(m.Msg==WM_TBC){ if(_icon!=IntPtr.Zero) ShowAsync(_icon,_tip); }   // explorer restarted
    base.WndProc(ref m); }
}
'@
  }
  $script:GuidTrayOk = $true
} catch { $script:GuidTrayOk = $false }

# ---- fast, non-blocking primitives --------------------------------
function Get-ListenPortSet {
  # Pure .NET, ~1ms. NO WMI.
  $set=@{}
  try {
    foreach($ep in [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()){
      $set[[int]$ep.Port]=$true
    }
  } catch {}
  return $set
}

function Test-LocalPath($p){
  # True only for paths on local fixed drives. Reads the mount table only -
  # never touches the network, so it's instant even for dead UNC/mapped paths.
  if(-not $p){ return $true }
  if($p -like '\\*'){ return $false }
  $root=$null; try { $root=[System.IO.Path]::GetPathRoot($p) } catch { return $false }
  if(-not $root -or $root -notmatch '^[A-Za-z]:'){ return $true }
  try { return ((New-Object System.IO.DriveInfo($root)).DriveType -eq 'Fixed') } catch { return $false }
}

function Get-ServerAvailability($server){
  if(-not [bool]$server.Managed){ return [pscustomobject]@{ Available=$false; Reason='start command is not managed' } }
  if(-not $server.Exe -or -not (Test-LocalPath ([string]$server.Exe)) -or -not (Test-Path -LiteralPath ([string]$server.Exe) -PathType Leaf)){
    return [pscustomobject]@{ Available=$false; Reason='executable is missing on this computer' }
  }
  if($server.WorkDir -and (-not (Test-LocalPath ([string]$server.WorkDir)) -or -not (Test-Path -LiteralPath ([string]$server.WorkDir) -PathType Container))){
    return [pscustomobject]@{ Available=$false; Reason='project folder is missing on this computer' }
  }
  return [pscustomobject]@{ Available=$true; Reason=$null }
}

function ConvertTo-NativeArgumentString([string[]]$Values){
  # Windows PowerShell 5.1 does not expose ProcessStartInfo.ArgumentList.
  # Quote each registry-supplied argument before assigning the one native
  # command line string, preserving spaces in paths without using a shell.
  return (@($Values | ForEach-Object {
    $v = [string]$_
    if($v.Length -eq 0){ return '""' }
    $escaped = $v.Replace('"','\"')
    return '"' + $escaped + '"'
  }) -join ' ')
}

function Start-HiddenPowerShellProcess {
  param(
    [Parameter(Mandatory=$true)][string[]]$ArgumentList,
    [string]$ExecutablePath=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'),
    [string]$WorkingDirectory=$PSScriptRoot,
    [string]$StdoutPath,
    [string]$StderrPath
  )

  # `Start-Process -WindowStyle Hidden` still briefly allocates a conhost on
  # some Windows builds.  Every panel-owned PowerShell helper crosses this
  # native boundary instead: no shell, no console allocation, and optional
  # redirected logs for helpers whose result is polled by the panel.
  $psi=New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName=$ExecutablePath
  $psi.Arguments=ConvertTo-NativeArgumentString $ArgumentList
  $psi.WorkingDirectory=$WorkingDirectory
  $psi.UseShellExecute=$false
  $psi.CreateNoWindow=$true
  $psi.WindowStyle=[System.Diagnostics.ProcessWindowStyle]::Hidden
  $capture=($StdoutPath -or $StderrPath)
  $psi.RedirectStandardOutput=[bool]$capture
  $psi.RedirectStandardError=[bool]$capture

  $process=New-Object System.Diagnostics.Process
  $process.StartInfo=$psi
  if(-not $process.Start()){ throw 'Could not start the hidden PowerShell helper.' }
  if($capture){
    foreach($logPath in @($StdoutPath,$StderrPath)){
      if($logPath){
        $logDir=Split-Path -Parent $logPath
        if($logDir){ New-Item -ItemType Directory -Path $logDir -Force -ErrorAction SilentlyContinue | Out-Null }
      }
    }
    $stdoutStream=if($StdoutPath){ [System.IO.File]::Open($StdoutPath,[System.IO.FileMode]::Append,[System.IO.FileAccess]::Write,[System.IO.FileShare]::ReadWrite) }else{ [System.IO.Stream]::Null }
    $stderrStream=if($StderrPath){ [System.IO.File]::Open($StderrPath,[System.IO.FileMode]::Append,[System.IO.FileAccess]::Write,[System.IO.FileShare]::ReadWrite) }else{ [System.IO.Stream]::Null }
    $process | Add-Member -NotePropertyName ServerControlStdoutTask -NotePropertyValue $process.StandardOutput.BaseStream.CopyToAsync($stdoutStream)
    $process | Add-Member -NotePropertyName ServerControlStderrTask -NotePropertyValue $process.StandardError.BaseStream.CopyToAsync($stderrStream)
    $process | Add-Member -NotePropertyName ServerControlStdoutStream -NotePropertyValue $stdoutStream
    $process | Add-Member -NotePropertyName ServerControlStderrStream -NotePropertyValue $stderrStream
  }
  return $process
}

function Complete-HiddenPowerShellCapture([System.Diagnostics.Process]$Process){
  if(-not $Process){ return }
  foreach($property in @('ServerControlStdoutTask','ServerControlStderrTask')){
    try {
      $task=$Process.PSObject.Properties[$property].Value
      if($task){ $task.GetAwaiter().GetResult() }
    } catch {}
  }
  foreach($property in @('ServerControlStdoutStream','ServerControlStderrStream')){
    try {
      $stream=$Process.PSObject.Properties[$property].Value
      if($stream -and $stream -ne [System.IO.Stream]::Null){ $stream.Dispose() }
    } catch {}
  }
}

function Start-HiddenServerProcess($s){
  $executable = [string]$s.Exe
  if([string]::IsNullOrWhiteSpace($executable)){ throw 'Server executable is empty.' }
  $argumentLine = ''
  if($s.Args -and @($s.Args).Count -gt 0){
    $argumentLine = ConvertTo-NativeArgumentString @($s.Args | ForEach-Object { [string]$_ })
  } elseif($s.ArgLine){
    $argumentLine = [string]$s.ArgLine
  }

  # Batch launchers require cmd.exe, but the cmd process itself is created with
  # CREATE_NO_WINDOW and redirected stdio. Direct node/python executables never
  # cross that shell boundary.
  if($executable -match '\.(cmd|bat)$'){
    $batchTarget = '"' + $executable.Replace('"','\"') + '"'
    $executable = $env:ComSpec
    $argumentLine = '/d /s /c call ' + $batchTarget + ($(if($argumentLine){ ' ' + $argumentLine } else { '' }))
  }

  $logDir = Join-Path $PSScriptRoot 'logs'
  New-Item -ItemType Directory -Path $logDir -Force -ErrorAction SilentlyContinue | Out-Null
  $safeName = ([string]$s.Name -replace '[^A-Za-z0-9._-]+','_')
  if([string]::IsNullOrWhiteSpace($safeName)){ $safeName = 'server' }
  $stdoutPath = Join-Path $logDir ($safeName + '.out.log')
  $stderrPath = Join-Path $logDir ($safeName + '.err.log')

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $executable
  $psi.Arguments = $argumentLine
  if($s.WorkDir){ $psi.WorkingDirectory = [string]$s.WorkDir }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  $process.add_OutputDataReceived({ param($sender,$event) if($null -ne $event.Data){ Add-Content -LiteralPath $stdoutPath -Value $event.Data -Encoding UTF8 } })
  $process.add_ErrorDataReceived({ param($sender,$event) if($null -ne $event.Data){ Add-Content -LiteralPath $stderrPath -Value $event.Data -Encoding UTF8 } })
  if(-not $process.Start()){ throw "Could not start $($s.Name)." }
  $process.BeginOutputReadLine()
  $process.BeginErrorReadLine()
  return $process
}

$script:lastStartAt=@{}
$script:stopRequested=@{}
$script:buildingCards=$false
$script:lastLifecycleSchedule=(Get-Date).AddMinutes(-1)
function Schedule-LifecycleReconcile {
  if(-not (Test-Path -LiteralPath $LifecycleScript)){ return }
  if(((Get-Date)-$script:lastLifecycleSchedule).TotalSeconds -lt 2){ return }
  $script:lastLifecycleSchedule=Get-Date
  try {
    Start-HiddenPowerShellProcess -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$LifecycleScript,'-Reconcile') | Out-Null
  } catch {}
}
function Save-ServerSettings($s,[bool]$persistent,[bool]$startOnRestart,[bool]$runEnabled=$true){
  $s.Persistent=$persistent; $s.StartOnRestart=$startOnRestart; $s.RunEnabled=$runEnabled
  try { [void](Set-ServerLifecycleSettings -Port ([int]$s.Port) -Persistent $persistent -StartOnRestart $startOnRestart -RunEnabled $runEnabled) } catch {}
  Schedule-LifecycleReconcile
}

function Start-Srv($s,[bool]$updateSettings=$true){
  if($updateSettings){
    $script:stopRequested[[int]$s.Port]=$false
    Save-ServerSettings $s ([bool]$s.Persistent) ([bool]$s.StartOnRestart) $true
  }
  if((Get-ListenPortSet).ContainsKey([int]$s.Port)){ return }
  if(-not $s.Managed){
    [System.Windows.Forms.MessageBox]::Show("'$($s.Name)' was auto-discovered on port $($s.Port), but I don't know its start command yet.`n`nStart it once yourself from its folder and it will be learned automatically.","Can't start this one") | Out-Null; return
  }
  $availability=Get-ServerAvailability $s
  $s.Available=[bool]$availability.Available; $s.UnavailableReason=$availability.Reason
  if(-not $s.Available){
    [System.Windows.Forms.MessageBox]::Show("$($s.Name) is unavailable on $($HostProfile.MachineLabel):`n$($s.UnavailableReason)","Can't start") | Out-Null; return
  }
  foreach($p in @($s.WorkDir,$s.Exe)){
    if($p -and -not (Test-LocalPath $p)){
      [System.Windows.Forms.MessageBox]::Show("Not on a local drive (would hang the panel waiting on the network):`n$p","Can't start") | Out-Null; return
    }
  }
  if($s.WorkDir -and -not (Test-Path -LiteralPath $s.WorkDir)){
    [System.Windows.Forms.MessageBox]::Show("Folder not found:`n$($s.WorkDir)","Start failed") | Out-Null; return
  }
  try {
    $script:stopRequested[[int]$s.Port]=$false
    Start-HiddenServerProcess $s | Out-Null
    $script:lastStartAt[[int]$s.Port]=Get-Date
  } catch {
    [System.Windows.Forms.MessageBox]::Show("Could not start $($s.Name):`n$($_.Exception.Message)","Start failed") | Out-Null
  }
}

function Stop-Srv($s,[bool]$updateSettings=$true){
  # Detached worker does the WMI walk + taskkill; UI returns instantly.
  $script:stopRequested[[int]$s.Port]=$true
  if($updateSettings){ Save-ServerSettings $s ([bool]$s.Persistent) ([bool]$s.StartOnRestart) $false }
  Start-HiddenPowerShellProcess -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'Stop-ServerByPort.ps1'),'-Port',"$($s.Port)") | Out-Null
}

# ---- server list (fast json read; discovery is backgrounded) ------
function Load-Servers {
  $list = @(Read-Registry)
  if(-not $list -or @($list).Count -eq 0){
    $list = @($script:Curated | ForEach-Object {
      [pscustomobject]@{ Name=$_.Name; Port=$_.Port; Url=$_.Url; Exe=$_.Exe; Args=@($_.Args); ArgLine=$null; WorkDir=$_.WorkDir; Source='known'; Managed=$true }
    })
  }
  @($list | ForEach-Object {
    $entry=@{ Name=$_.Name; Port=[int]$_.Port; Url=$_.Url; Exe=$_.Exe; Args=$_.Args; ArgLine=$_.ArgLine;
       WorkDir=$_.WorkDir; Managed=[bool]$_.Managed; Source=$_.Source;
       Persistent=if($null -eq $_.Persistent){$false}else{[bool]$_.Persistent};
       StartOnRestart=if($null -eq $_.StartOnRestart){$false}else{[bool]$_.StartOnRestart};
       RunEnabled=if($null -eq $_.RunEnabled){$true}else{[bool]$_.RunEnabled} }
    $availability=Get-ServerAvailability $entry
    $entry.Available=[bool]$availability.Available
    $entry.UnavailableReason=$availability.Reason
    $entry
  })
}
$script:Servers = Load-Servers

function Get-ListSignature($list){ (@($list | ForEach-Object { '{0}:{1}:{2}:{3}:{4}:{5}:{6}' -f $_.Port,$_.Managed,$_.Name,$_.Persistent,$_.StartOnRestart,$_.RunEnabled,$_.Available }) | Sort-Object) -join '|' }

# background discovery with watchdog: a hung WMI sync gets abandoned
# after 3 min (BeginStop, never a blocking Stop/Dispose) and retried.
$script:bg = $null
$script:zombies = @()
$script:lastSync = (Get-Date).AddMinutes(-10)
function Start-BgSync {
  if($script:bg){ return }
  try {
    $ps=[powershell]::Create()
    [void]$ps.AddScript(". '$PSScriptRoot\ServerRegistry.ps1'; [void](Sync-Registry)")
    $script:bg=@{ PS=$ps; H=$ps.BeginInvoke(); T=(Get-Date) }
  } catch { $script:bg=$null }
  $script:lastSync = Get-Date
}
function Complete-BgSync {
  # reap abandoned pipelines that have since finished
  if(@($script:zombies).Count -gt 0){
    $keep=@()
    foreach($z in $script:zombies){ if($z.H.IsCompleted){ try { $z.PS.Dispose() } catch {} } else { $keep+=,$z } }
    $script:zombies=$keep
  }
  if(-not $script:bg){ return }
  if(-not $script:bg.H.IsCompleted){
    if(((Get-Date)-$script:bg.T).TotalSeconds -ge 180){
      try { [void]$script:bg.PS.BeginStop($null,$null) } catch {}   # async - never blocks
      $script:zombies+=,$script:bg
      $script:bg=$null
    }
    return
  }
  try { [void]$script:bg.PS.EndInvoke($script:bg.H) } catch {}
  try { $script:bg.PS.Dispose() } catch {}
  $script:bg=$null
  $new = Load-Servers
  if((Get-ListSignature $new) -ne (Get-ListSignature $script:Servers)){
    $script:Servers = $new
    Build-Cards; Build-TrayMenu
    Show-Balloon 'Server list updated' 'A server was added or removed - the panel refreshed itself.'
  }
}

# ---- colors -------------------------------------------------------
$cGreen=[System.Drawing.Color]::FromArgb(46,204,113); $cRed=[System.Drawing.Color]::FromArgb(231,76,60)
$cAmber=[System.Drawing.Color]::FromArgb(243,156,18); $cBlue=[System.Drawing.Color]::FromArgb(52,152,219)
$cGray=[System.Drawing.Color]::FromArgb(90,90,100)
$cCard=[System.Drawing.Color]::FromArgb(44,44,50);   $cBg=[System.Drawing.Color]::FromArgb(28,28,32)

function New-GlyphIcon($color){
  $s=32
  $bmp=New-Object System.Drawing.Bitmap -ArgumentList $s,$s,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g=[System.Drawing.Graphics]::FromImage($bmp); $g.SmoothingMode='AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
  $rect=New-Object System.Drawing.Rectangle 1,1,($s-3),($s-3); $rr=7; $d=$rr*2
  $path=New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc($rect.X,$rect.Y,$d,$d,180,90); $path.AddArc($rect.Right-$d,$rect.Y,$d,$d,270,90)
  $path.AddArc($rect.Right-$d,$rect.Bottom-$d,$d,$d,0,90); $path.AddArc($rect.X,$rect.Bottom-$d,$d,$d,90,90); $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,26,26,34))),$path)
  $cx=$s/2.0; $cy=$s*0.52; $rad=$s*0.26; $stroke=[Math]::Max(2,$s*0.11)
  $pen=New-Object System.Drawing.Pen $color,$stroke; $pen.StartCap='Round'; $pen.EndCap='Round'
  $arc=New-Object System.Drawing.RectangleF ([single]($cx-$rad)),([single]($cy-$rad)),([single]($rad*2)),([single]($rad*2))
  $g.DrawArc($pen,$arc,-60,300); $g.DrawLine($pen,[single]$cx,[single]($cy-$rad*0.95),[single]$cx,[single]($cy-$rad*0.12))
  $g.Dispose()
  [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$icoUp=New-GlyphIcon $cGreen; $icoSome=New-GlyphIcon $cAmber; $icoDown=New-GlyphIcon $cRed

# ---- form ---------------------------------------------------------
$form=New-Object System.Windows.Forms.Form
$form.Text='Server Control Panel'; $form.StartPosition='CenterScreen'
$form.BackColor=$cBg; $form.Font=New-Object System.Drawing.Font('Segoe UI',9)
$form.AutoScaleMode=[System.Windows.Forms.AutoScaleMode]::Dpi
$form.MaximizeBox=$true; $form.FormBorderStyle='Sizable'
$form.MinimumSize=New-Object System.Drawing.Size(640,780); $form.Size=New-Object System.Drawing.Size(700,900)
try { if(Test-Path $IconPath){ $form.Icon = New-Object System.Drawing.Icon $IconPath } } catch {}
$script:reallyExit=$false

$hdr=New-Object System.Windows.Forms.Label; $hdr.Text='DEV SERVERS'; $hdr.ForeColor=[System.Drawing.Color]::White
$hdr.Font=New-Object System.Drawing.Font('Segoe UI',16,[System.Drawing.FontStyle]::Bold)
$hdr.Location=New-Object System.Drawing.Point(24,16); $hdr.AutoSize=$true; $form.Controls.Add($hdr)

$hostBadge=New-Object System.Windows.Forms.Label
$hostBadge.Text=if($HostProfile.LocalIp){ "$($HostProfile.MachineLabel)  /  $($HostProfile.LocalIp)" }else{ $HostProfile.MachineLabel }
$hostBadge.TextAlign='MiddleCenter'; $hostBadge.ForeColor=[System.Drawing.Color]::FromArgb(190,215,240)
$hostBadge.BackColor=[System.Drawing.Color]::FromArgb(44,54,68); $hostBadge.Font=New-Object System.Drawing.Font('Segoe UI',8,[System.Drawing.FontStyle]::Bold)
$hostBadge.Size=New-Object System.Drawing.Size(156,26); $hostBadge.Location=New-Object System.Drawing.Point(504,18)
$hostBadge.Anchor='Top,Right'; $form.Controls.Add($hostBadge)

$sub=New-Object System.Windows.Forms.Label
$sub.Text='Enabled controls desired runtime. Keep alive recovers crashes. Start at sign-in restores after restart.'
$sub.ForeColor=[System.Drawing.Color]::FromArgb(150,150,160)
$sub.Location=New-Object System.Drawing.Point(26,52); $sub.Size=New-Object System.Drawing.Size(634,20); $sub.AutoSize=$false
$sub.AutoEllipsis=$true; $sub.Anchor='Top,Left,Right'; $form.Controls.Add($sub)

$scopeInfo=New-Object System.Windows.Forms.Label
$scopeInfo.Text='This panel changes local dev-server and access lifecycles. Activity Visualizer (3889) only observes activity.'
$scopeInfo.ForeColor=[System.Drawing.Color]::FromArgb(120,175,220)
$scopeInfo.Location=New-Object System.Drawing.Point(26,72); $scopeInfo.Size=New-Object System.Drawing.Size(634,18)
$scopeInfo.AutoEllipsis=$true; $scopeInfo.Anchor='Top,Left,Right'; $form.Controls.Add($scopeInfo)

$cards=New-Object System.Windows.Forms.Panel
$healthSummary=New-Object System.Windows.Forms.Label
$healthSummary.Text='Checking services...'; $healthSummary.ForeColor=[System.Drawing.Color]::FromArgb(160,170,185)
$healthSummary.Location=New-Object System.Drawing.Point(26,94); $healthSummary.Size=New-Object System.Drawing.Size(470,24)
$healthSummary.AutoEllipsis=$true; $healthSummary.Anchor='Top,Left,Right'; $form.Controls.Add($healthSummary)
$btnRefresh=New-Object System.Windows.Forms.Button
$btnRefresh.Text='Refresh status'; $btnRefresh.Size=New-Object System.Drawing.Size(116,28); $btnRefresh.Location=New-Object System.Drawing.Point(544,90)
$btnRefresh.FlatStyle='Flat'; $btnRefresh.BackColor=[System.Drawing.Color]::FromArgb(60,60,72); $btnRefresh.ForeColor=[System.Drawing.Color]::White
$btnRefresh.FlatAppearance.BorderSize=0; $btnRefresh.Cursor='Hand'; $btnRefresh.Anchor='Top,Right'; $form.Controls.Add($btnRefresh)
$cards.Location=New-Object System.Drawing.Point(24,124); $cards.Size=New-Object System.Drawing.Size(636,482)
$cards.AutoScroll=$true; $cards.BackColor=$cBg; $cards.Anchor='Top,Bottom,Left,Right'; $form.Controls.Add($cards)

# bottom bar: three explicit remote-access tiers + power control
$script:tunnelBuilding=$false
function Read-TunnelState {
  if(Test-Path -LiteralPath $TunnelStatePath){ try { return (Get-Content -Raw -LiteralPath $TunnelStatePath | ConvertFrom-Json) } catch {} }
  return [pscustomobject]@{ TunnelEnabled=$false; BridgeEnabled=$false; FullRemoteEnabled=$false; LastStatus='off'; LastError=$null; TunnelError=$null; BridgeError=$null; FullRemoteError=$null; PeerIp=$null; PeerRelay=$false; PeerBridge=$false }
}
function Invoke-TunnelAction([string]$action){
  if(-not (Test-Path -LiteralPath $TunnelScript)){ return }
  try { Start-HiddenPowerShellProcess -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$TunnelScript,'-Action',$action) | Out-Null } catch {}
}
# One tray switch for the mechanical key rendezvous. Mechanical-Connect.ps1
# owns every decision; the panel only reads its small state document (same
# non-blocking pattern as Read-TunnelState) and fires the toggle hidden.
#
# The label is deliberately NOT "Tunnel". The panel already has a checkbox by
# that name driving the 8787 message relay through Tunnel-Lifecycle.ps1, and
# this switch drives neither that relay nor the 8788 bridge - it makes the two
# machines agree on a credential. Two controls with one name, doing different
# things, is how "Auto-connect: connected" and "OFF / message relay disabled"
# end up on screen at the same time.
$script:MechanicalConnectHealAt=[datetime]::MinValue
function Read-MechanicalConnectState {
  # FileShare Delete matters: the engine publishes this document by renaming a
  # temp file over it. A plain Get-Content from this 2s timer does not share
  # DELETE, so a read in flight makes that rename fail on the writer's side.
  # A failure here returns $null, never a fabricated default - "off" and "I
  # could not read the file" must not render identically.
  if(-not (Test-Path -LiteralPath $MechanicalConnectStatePath)){ return $null }
  try {
    $handle=[System.IO.File]::Open($MechanicalConnectStatePath,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    try {
      $reader=New-Object System.IO.StreamReader($handle)
      try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
    } finally { $handle.Dispose() }
  } catch { return $null }
}
function Test-MechanicalConnectEngine { return (Test-Path -LiteralPath $MechanicalConnectScript -PathType Leaf) }
function Invoke-MechanicalConnectAction([ValidateSet('Enable','Disable')][string]$action){
  # Returns $false when the engine is not installed. The panel ships through a
  # manifest that the engine may not be a member of, so "the file is not here"
  # is a real deployment state and must not read as a silent success.
  if(-not (Test-MechanicalConnectEngine)){ return $false }
  try {
    Start-HiddenPowerShellProcess -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$MechanicalConnectScript,"-$action") | Out-Null
    return $true
  } catch { return $false }
}
function Test-MechanicalConnectStale($state){
  # Armed means a loop should be republishing this document every poll. A
  # document that has gone quiet means the loop died, and the tray must not
  # keep showing whatever it last said - usually "connected".
  if($null -eq $state -or -not [bool]$state.armed -or -not $state.updatedAt){ return $false }
  try { $stamp=[datetime]::Parse([string]$state.updatedAt,$null,[System.Globalization.DateTimeStyles]::RoundtripKind) } catch { return $false }
  return (((Get-Date).ToUniversalTime()-$stamp.ToUniversalTime()).TotalSeconds -gt 420)
}
function Get-MechanicalConnectTrayText {
  # Every state the engine can be in has to be distinguishable here. This is
  # the owner's glanceable signal, so a fault must never be rendered as
  # patient waiting. Kept short on purpose: the whole tooltip is prefixed with
  # the server summary and the NotifyIcon fallback rejects a Text over 63
  # characters outright. The sentence explaining a fault goes on the menu.
  if(-not (Test-MechanicalConnectEngine)){ return 'Auto-connect: not installed' }
  $state=Read-MechanicalConnectState
  if($null -eq $state){ return 'Auto-connect: state unavailable' }
  if([string]$state.status -eq 'attention'){ return 'Auto-connect: needs attention' }
  if(-not [bool]$state.armed){ return 'Auto-connect: off' }
  if(Test-MechanicalConnectStale $state){ return 'Auto-connect: stopped' }
  if([bool]$state.connected){ return 'Auto-connect: connected' }
  if([string]$state.status -eq 'no-link'){ return 'Auto-connect: waiting for cable' }
  return 'Auto-connect: waiting for peer'
}
function Get-MechanicalConnectMenuText {
  # The engine's own words, verbatim, one click away. `detail` is the only
  # field that says what actually broke and nothing used to display it.
  if(-not (Test-MechanicalConnectEngine)){ return 'Engine file is not installed on this machine' }
  $state=Read-MechanicalConnectState
  if($null -eq $state){ return 'The connect state file could not be read' }
  if(Test-MechanicalConnectStale $state){ return 'The connect loop stopped - restarting it' }
  $detail=[string]$state.detail
  if($detail){ return $detail }
  if(-not [bool]$state.armed){ return 'Switched off' }
  return [string]$state.status
}
function Update-MechanicalConnectTray {
  # Reconciles the checkmark from disk and restarts a loop that has stopped.
  # Both used to be missing: Checked was set optimistically on click and then
  # only re-read when the SERVER LIST changed, so a toggle that did nothing
  # left a checked menu item next to a tooltip reading "off" indefinitely.
  $state=Read-MechanicalConnectState
  $armed=[bool]($null -ne $state -and [bool]$state.armed)
  if($script:miTunnel){ try { $script:miTunnel.Checked=$armed } catch {} }
  if($script:miTunnelStatus){ try { $script:miTunnelStatus.Text=("   {0}" -f (Get-MechanicalConnectMenuText)) } catch {} }
  if(-not $armed -or -not (Test-MechanicalConnectEngine)){ return }
  if(-not (Test-MechanicalConnectStale $state)){ return }
  # The engine's own reboot survival is a single sign-in task; healing a loop
  # that died mid-session is the panel's job, because the panel is already
  # running and already launches helpers through the windowless native path.
  # A repeating scheduled task doing this would flash a console every few
  # minutes for as long as the switch is on.
  if(((Get-Date)-$script:MechanicalConnectHealAt).TotalSeconds -lt 60){ return }
  $script:MechanicalConnectHealAt=Get-Date
  [void](Invoke-MechanicalConnectAction 'Enable')
}
function Set-AccessStatus($label,[string]$text,[ValidateSet('on','off','waiting','error')][string]$mode='off'){
  $label.Text=$text
  $label.ForeColor=switch($mode){ 'on'{$cGreen} 'waiting'{$cAmber} 'error'{$cRed} default{[System.Drawing.Color]::FromArgb(155,160,172)} }
}
function Update-TunnelControls {
  if(-not $cbTunnel){ return }
  $state=Read-TunnelState; $script:tunnelBuilding=$true
  try { $cbTunnel.Checked=[bool]$state.TunnelEnabled; $cbBridge.Checked=[bool]$state.BridgeEnabled } finally { $script:tunnelBuilding=$false }
  $peer=if($state.PeerIp){"peer $($state.PeerIp)"}else{'no Ethernet peer'}
  if(-not [bool]$state.TunnelEnabled){ Set-AccessStatus $tunnelStatus 'OFF  /  message relay disabled' 'off' }
  elseif([bool]$state.PeerRelay){ Set-AccessStatus $tunnelStatus "ON  /  peer relay reachable ($peer, Ethernet only)" 'on' }
  elseif($state.TunnelError){ Set-AccessStatus $tunnelStatus "ATTENTION  /  $($state.TunnelError) ($peer)" 'error' }
  else { Set-AccessStatus $tunnelStatus "STARTING  /  $($state.LastStatus) ($peer)" 'waiting' }

  if(-not [bool]$state.BridgeEnabled){ Set-AccessStatus $bridgeStatus 'OFF  /  approved tool transport disabled' 'off' }
  elseif([bool]$state.PeerBridge -and [string]$state.LastStatus -eq 'connected'){ Set-AccessStatus $bridgeStatus "ON  /  authenticated approved-tool bridge ($peer)" 'on' }
  elseif([bool]$state.PeerBridge){ Set-AccessStatus $bridgeStatus "VERIFYING  /  peer reachable; safety not confirmed ($peer)" 'waiting' }
  elseif($state.BridgeError){ Set-AccessStatus $bridgeStatus "ATTENTION  /  $($state.BridgeError) ($peer)" 'error' }
  else { Set-AccessStatus $bridgeStatus "WAITING  /  $peer" 'waiting' }
}

# Tunnel-Lifecycle.ps1 owns the three desired-state toggles and schedules one
# serialized top-level reconcile. The independent FRA controller still owns
# only its encrypted exact-peer listener and credential transaction; the top-
# level lifecycle never treats either lower tier as FRA readiness evidence.
# Serialize hidden controller calls so a slow health probe cannot
# pile up or race an owner's Start/Stop click.
$script:fullRemoteBuilding=$false
$script:fullRemoteControlProcess=$null
$script:fullRemoteActiveAction=$null
$script:fullRemoteQueuedAction=$null
$script:lastFullRemoteProbe=(Get-Date).AddMinutes(-1)
function Read-FullRemoteState {
  if(Test-Path -LiteralPath $FullRemoteStatePath){ try { return (Get-Content -Raw -LiteralPath $FullRemoteStatePath | ConvertFrom-Json) } catch {} }
  return $null
}
function Start-FullRemoteControlProcess([string]$action){
  if(-not (Test-Path -LiteralPath $FullRemoteScript -PathType Leaf)){
    Set-AccessStatus $fullRemoteStatus 'UNAVAILABLE  /  controller is missing' 'error'
    return
  }
  try {
    $logDir=Split-Path -Parent $FullRemotePanelOut
    New-Item -ItemType Directory -Path $logDir -Force -ErrorAction SilentlyContinue | Out-Null
    $script:fullRemoteActiveAction=$action
    $script:lastFullRemoteProbe=Get-Date
    $script:fullRemoteControlProcess=Start-HiddenPowerShellProcess -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$FullRemoteScript,'-Action',$action) -WorkingDirectory $ToolsEnabledRoot -StdoutPath $FullRemotePanelOut -StderrPath $FullRemotePanelErr
  } catch {
    $script:fullRemoteControlProcess=$null
    $script:fullRemoteActiveAction=$null
    Set-AccessStatus $fullRemoteStatus 'ATTENTION  /  controller launch failed' 'error'
  }
}
function Test-FullRemoteControllerEnrollmentCapable {
  if(-not (Test-Path -LiteralPath $FullRemoteScript -PathType Leaf)){ return $false }
  try {
    $source=Get-Content -Raw -LiteralPath $FullRemoteScript
    return [bool]($source.Contains("`$EnrollmentScript = Join-Path `$Root 'tools\fra-token-enrollment-lifecycle.js'") -and
      $source.Contains('$EnrollmentPort = 8794') -and
      $source.Contains('function Start-FraEnrollment') -and
      $source.Contains('FRA_PREFLIGHT_FAILED_FRA_TOKEN_UNAVAILABLE'))
  } catch { return $false }
}
function Invoke-FullRemoteAction([string]$action){
  if($action -notin @('Status','Start','Stop')){ return }
  if($script:fullRemoteControlProcess){
    $running=$false
    try { $running=-not $script:fullRemoteControlProcess.HasExited } catch {}
    if($running){
      if($action -ne 'Status'){ $script:fullRemoteQueuedAction=$action }
      return
    }
  }
  if($action -eq 'Start' -and -not (Test-FullRemoteControllerEnrollmentCapable)){
    Set-AccessStatus $fullRemoteStatus 'UNAVAILABLE  /  secure 8794 enrollment controller is missing' 'error'
    return
  }
  Start-FullRemoteControlProcess $action
}
function Invoke-FullRemoteSecureSetup {
  if(-not (Test-Path -LiteralPath $FullRemoteFirewallScript -PathType Leaf)){
    [System.Windows.Forms.MessageBox]::Show('The Full Remote Access firewall setup script is missing.','Secure setup unavailable') | Out-Null
    return
  }
  try {
    $quotedScript='"' + $FullRemoteFirewallScript.Replace('"','""') + '"'
    # The native UAC consent dialog remains visible for the owner, while the
    # elevated PowerShell process itself is created hidden and cannot flash a
    # console behind that consent prompt.
    Start-Process -FilePath $HostProfile.PowerShell -Verb RunAs -WindowStyle Hidden -ArgumentList ("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quotedScript") -WorkingDirectory $ToolsEnabledRoot | Out-Null
    Set-AccessStatus $fullRemoteStatus 'SETUP  /  approve the Windows security prompt' 'waiting'
  } catch {
    Set-AccessStatus $fullRemoteStatus 'ATTENTION  /  secure setup was cancelled or failed' 'error'
  }
}
function Complete-FullRemoteAction {
  if($script:fullRemoteControlProcess){
    $done=$false
    try { $done=[bool]$script:fullRemoteControlProcess.HasExited } catch { $done=$true }
    if(-not $done){ return }
    Complete-HiddenPowerShellCapture $script:fullRemoteControlProcess
    try { $script:fullRemoteControlProcess.Dispose() } catch {}
    $script:fullRemoteControlProcess=$null
    $script:fullRemoteActiveAction=$null
    if($script:fullRemoteQueuedAction){
      $next=$script:fullRemoteQueuedAction
      $script:fullRemoteQueuedAction=$null
      Start-FullRemoteControlProcess $next
      return
    }
  }
  if(((Get-Date)-$script:lastFullRemoteProbe).TotalSeconds -ge 30){ Invoke-FullRemoteAction 'Status' }
}
function Update-FullRemoteControl {
  if(-not $cbFullRemote){ return }
  if(-not (Test-Path -LiteralPath $FullRemoteScript -PathType Leaf)){
    $cbFullRemote.Enabled=$false
    Set-AccessStatus $fullRemoteStatus 'UNAVAILABLE  /  controller is missing' 'error'
    return
  }
  $cbFullRemote.Enabled=$true
  if($script:fullRemoteControlProcess){
    $running=$false
    try { $running=-not $script:fullRemoteControlProcess.HasExited } catch {}
    if($running){
      $verb=switch($script:fullRemoteActiveAction){ 'Start'{'starting'} 'Stop'{'stopping'} default{'checking status'} }
      Set-AccessStatus $fullRemoteStatus (([string]$verb).ToUpperInvariant() + '...') 'waiting'
      return
    }
  }
  $state=Read-FullRemoteState
  if(-not $state){ Set-AccessStatus $fullRemoteStatus 'UNKNOWN  /  no controller status yet' 'waiting'; return }
  $desired=[string]$state.desiredState
  if($desired -in @('enabled','disabled')){
    $script:fullRemoteBuilding=$true
    try { $cbFullRemote.Checked=($desired -eq 'enabled') } finally { $script:fullRemoteBuilding=$false }
  }
  $checked=''
  try { if($state.generatedAt){ $checked='; checked ' + ([datetime]$state.generatedAt).ToLocalTime().ToString('HH:mm:ss') } } catch {}
  if($desired -eq 'disabled'){ Set-AccessStatus $fullRemoteStatus "OFF  /  independently disabled$checked" 'off' }
  elseif([bool]$state.operational){ Set-AccessStatus $fullRemoteStatus "ON  /  healthy owned listener on port $($state.port)$checked" 'on' }
  elseif([bool]$state.enrollmentReady){ Set-AccessStatus $fullRemoteStatus "WAITING  /  encrypted credential enrollment ready on port $($state.enrollmentPort)$checked" 'waiting' }
  elseif(([string]$state.enrollmentState -eq 'owned') -and -not [bool]$state.enrollmentFirewallReady){ Set-AccessStatus $fullRemoteStatus "SETUP NEEDED  /  install peer-only firewall rules$checked" 'error' }
  elseif([bool]$state.owned -and -not [bool]$state.healthy){ Set-AccessStatus $fullRemoteStatus "ATTENTION  /  owned listener health check failed$checked" 'error' }
  elseif([string]$state.errorCode -match 'FRA_TOKEN_UNAVAILABLE|FULL_REMOTE_ACCESS_TOKEN_UNAVAILABLE'){
    Set-AccessStatus $fullRemoteStatus "ATTENTION  /  credential required: custom.full_remote_access_token$checked" 'error'
  }
  elseif($state.errorCode){ Set-AccessStatus $fullRemoteStatus "ATTENTION  /  controller error $($state.errorCode)$checked" 'error' }
  else { Set-AccessStatus $fullRemoteStatus "WAITING  /  listener $($state.listenerState), not operational$checked" 'waiting' }
}

$accessPanel=New-Object System.Windows.Forms.Panel
$accessPanel.Location=New-Object System.Drawing.Point(24,620); $accessPanel.Size=New-Object System.Drawing.Size(636,210)
$accessPanel.BackColor=$cCard; $accessPanel.Anchor='Bottom,Left,Right'; $form.Controls.Add($accessPanel)

$linkHeader=New-Object System.Windows.Forms.Label; $linkHeader.Text='REMOTE ACCESS'; $linkHeader.ForeColor=[System.Drawing.Color]::White
$linkHeader.Font=New-Object System.Drawing.Font('Segoe UI',11,[System.Drawing.FontStyle]::Bold); $linkHeader.Location=New-Object System.Drawing.Point(16,12); $linkHeader.AutoSize=$true; $accessPanel.Controls.Add($linkHeader)
$linkSub=New-Object System.Windows.Forms.Label; $linkSub.Text='Three explicit, opt-in capability tiers'; $linkSub.ForeColor=[System.Drawing.Color]::FromArgb(145,155,170)
$linkSub.Location=New-Object System.Drawing.Point(138,15); $linkSub.Size=New-Object System.Drawing.Size(278,20); $linkSub.AutoEllipsis=$true; $accessPanel.Controls.Add($linkSub)

$cbTunnel=New-Object System.Windows.Forms.CheckBox; $cbTunnel.Text='Tunnel'; $cbTunnel.ForeColor=[System.Drawing.Color]::White; $cbTunnel.BackColor=$cCard; $cbTunnel.AutoSize=$true; $cbTunnel.Location=New-Object System.Drawing.Point(18,52); $accessPanel.Controls.Add($cbTunnel)
$tier1=New-Object System.Windows.Forms.Label; $tier1.Text='TIER 1'; $tier1.ForeColor=[System.Drawing.Color]::FromArgb(110,180,235); $tier1.Font=New-Object System.Drawing.Font('Segoe UI',7,[System.Drawing.FontStyle]::Bold); $tier1.Location=New-Object System.Drawing.Point(132,55); $tier1.Size=New-Object System.Drawing.Size(46,18); $accessPanel.Controls.Add($tier1)
$tunnelStatus=New-Object System.Windows.Forms.Label; $tunnelStatus.ForeColor=[System.Drawing.Color]::FromArgb(170,175,185); $tunnelStatus.Location=New-Object System.Drawing.Point(184,53); $tunnelStatus.Size=New-Object System.Drawing.Size(430,22); $tunnelStatus.AutoEllipsis=$true; $tunnelStatus.Anchor='Top,Left,Right'; $accessPanel.Controls.Add($tunnelStatus)

$cbBridge=New-Object System.Windows.Forms.CheckBox; $cbBridge.Text='ToolsEnabled'; $cbBridge.ForeColor=[System.Drawing.Color]::White; $cbBridge.BackColor=$cCard; $cbBridge.AutoSize=$true; $cbBridge.Location=New-Object System.Drawing.Point(18,94); $accessPanel.Controls.Add($cbBridge)
$tier2=New-Object System.Windows.Forms.Label; $tier2.Text='TIER 2'; $tier2.ForeColor=[System.Drawing.Color]::FromArgb(110,180,235); $tier2.Font=New-Object System.Drawing.Font('Segoe UI',7,[System.Drawing.FontStyle]::Bold); $tier2.Location=New-Object System.Drawing.Point(132,97); $tier2.Size=New-Object System.Drawing.Size(46,18); $accessPanel.Controls.Add($tier2)
$bridgeStatus=New-Object System.Windows.Forms.Label; $bridgeStatus.ForeColor=[System.Drawing.Color]::FromArgb(170,175,185); $bridgeStatus.Location=New-Object System.Drawing.Point(184,95); $bridgeStatus.Size=New-Object System.Drawing.Size(430,22); $bridgeStatus.AutoEllipsis=$true; $bridgeStatus.Anchor='Top,Left,Right'; $accessPanel.Controls.Add($bridgeStatus)

$cbFullRemote=New-Object System.Windows.Forms.CheckBox; $cbFullRemote.Text='Full remote'; $cbFullRemote.ForeColor=[System.Drawing.Color]::White; $cbFullRemote.BackColor=$cCard; $cbFullRemote.AutoSize=$true; $cbFullRemote.Location=New-Object System.Drawing.Point(18,136); $accessPanel.Controls.Add($cbFullRemote)
$tier3=New-Object System.Windows.Forms.Label; $tier3.Text='TIER 3'; $tier3.ForeColor=[System.Drawing.Color]::FromArgb(110,180,235); $tier3.Font=New-Object System.Drawing.Font('Segoe UI',7,[System.Drawing.FontStyle]::Bold); $tier3.Location=New-Object System.Drawing.Point(132,139); $tier3.Size=New-Object System.Drawing.Size(46,18); $accessPanel.Controls.Add($tier3)
$fullRemoteStatus=New-Object System.Windows.Forms.Label; $fullRemoteStatus.ForeColor=[System.Drawing.Color]::FromArgb(170,175,185); $fullRemoteStatus.Location=New-Object System.Drawing.Point(184,137); $fullRemoteStatus.Size=New-Object System.Drawing.Size(326,22); $fullRemoteStatus.AutoEllipsis=$true; $fullRemoteStatus.Anchor='Top,Left'; $accessPanel.Controls.Add($fullRemoteStatus)
$btnFullRemoteSetup=New-Object System.Windows.Forms.Button; $btnFullRemoteSetup.Text='Secure setup'; $btnFullRemoteSetup.Size=New-Object System.Drawing.Size(98,26); $btnFullRemoteSetup.Location=New-Object System.Drawing.Point(518,132); $btnFullRemoteSetup.FlatStyle='Flat'; $btnFullRemoteSetup.FlatAppearance.BorderSize=0; $btnFullRemoteSetup.BackColor=[System.Drawing.Color]::FromArgb(60,60,72); $btnFullRemoteSetup.ForeColor=[System.Drawing.Color]::White; $btnFullRemoteSetup.Cursor='Hand'; $btnFullRemoteSetup.Anchor='Top,Right'; $btnFullRemoteSetup.Enabled=(Test-Path -LiteralPath $FullRemoteFirewallScript -PathType Leaf); $btnFullRemoteSetup.Add_Click({ Invoke-FullRemoteSecureSetup }.GetNewClosure()); $accessPanel.Controls.Add($btnFullRemoteSetup)

$accessFoot=New-Object System.Windows.Forms.Label; $accessFoot.Text='ToolsEnabled requires Tunnel; Full remote remains separately controlled.'
$accessFoot.ForeColor=[System.Drawing.Color]::FromArgb(125,130,142); $accessFoot.Location=New-Object System.Drawing.Point(18,178); $accessFoot.Size=New-Object System.Drawing.Size(596,20)
$accessFoot.AutoEllipsis=$true; $accessFoot.Anchor='Bottom,Left,Right'; $accessPanel.Controls.Add($accessFoot)
$toolTip=New-Object System.Windows.Forms.ToolTip
$toolTip.SetToolTip($cbTunnel,'Ethernet-only message relay (8787). It carries coordination messages, not tool or terminal access.')
$toolTip.SetToolTip($cbBridge,'Directional approved ToolsEnabled tool transport (8788). Enabling it also enables Tunnel for peer coordination; it is not shell, desktop, or Full Remote Access.')
$toolTip.SetToolTip($cbFullRemote,'Encrypted exact-peer agentic control through the reviewed FRA manifest. Audit, credential, policy, non-elevation, and kill-switch boundaries remain active.')
$toolTip.SetToolTip($btnFullRemoteSetup,'One-time UAC setup: allow FRA service and one-shot encrypted enrollment only from the exact direct-Ethernet peer.')
$cbTunnel.Add_CheckedChanged({ if($script:tunnelBuilding){return}; Invoke-TunnelAction (if($cbTunnel.Checked){'EnableTunnel'}else{'DisableTunnel'}) }.GetNewClosure())
$cbBridge.Add_CheckedChanged({ if($script:tunnelBuilding){return}; Invoke-TunnelAction (if($cbBridge.Checked){'EnableBridge'}else{'DisableBridge'}) }.GetNewClosure())
$cbFullRemote.Add_CheckedChanged({ if($script:fullRemoteBuilding){return}; Invoke-TunnelAction (if($cbFullRemote.Checked){'EnableFullRemote'}else{'DisableFullRemote'}) }.GetNewClosure())

$btnPower=New-Object System.Windows.Forms.Button
$btnPower.Text=([char]0x26A1 + ' Power settings')
$btnPower.Size=New-Object System.Drawing.Size(154,30); $btnPower.Location=New-Object System.Drawing.Point(462,10)
$btnPower.FlatStyle='Flat'; $btnPower.BackColor=[System.Drawing.Color]::FromArgb(60,60,72); $btnPower.ForeColor=[System.Drawing.Color]::White
$btnPower.FlatAppearance.BorderSize=0; $btnPower.Cursor='Hand'; $btnPower.Font=New-Object System.Drawing.Font('Segoe UI',9,[System.Drawing.FontStyle]::Bold); $btnPower.Anchor='Top,Right'
$btnPower.Add_Click({ Show-PowerDialog })
$accessPanel.Controls.Add($btnPower)

function New-FlatButton($text,$color,$x){
  $b=New-Object System.Windows.Forms.Button; $b.Text=$text
  $b.Size=New-Object System.Drawing.Size(78,34); $b.Location=New-Object System.Drawing.Point($x,20)
  $b.FlatStyle='Flat'; $b.BackColor=$color; $b.ForeColor=[System.Drawing.Color]::White
  $b.Font=New-Object System.Drawing.Font('Segoe UI',9,[System.Drawing.FontStyle]::Bold)
  $b.FlatAppearance.BorderSize=0; $b.Cursor='Hand'; $b.Anchor='Top,Right'; return $b
}

function Build-Cards {
  $script:buildingCards=$true
  $cards.SuspendLayout()
  $old=@($cards.Controls)
  $cards.Controls.Clear()
  foreach($c in $old){ try { $c.Dispose() } catch {} }     # no handle/GDI leak on rebuild
  $y=0
  foreach($s in $script:Servers){
    $cardWidth=[Math]::Max(560,($cards.ClientSize.Width-20))
    $openX=$cardWidth-94; $stopX=$openX-86; $startX=$stopX-86
    $card=New-Object System.Windows.Forms.Panel
    $card.Size=New-Object System.Drawing.Size($cardWidth,104); $card.Location=New-Object System.Drawing.Point(0,$y); $card.BackColor=$cCard
    $card.Anchor='Top,Left,Right'
    $nl=New-Object System.Windows.Forms.Label; $nl.Text=$s.Name; $nl.ForeColor=[System.Drawing.Color]::White
    $nl.Font=New-Object System.Drawing.Font('Segoe UI',12,[System.Drawing.FontStyle]::Bold)
    $nl.Location=New-Object System.Drawing.Point(16,10); $nl.Size=New-Object System.Drawing.Size(([Math]::Max(160,$startX-28)),26); $nl.AutoEllipsis=$true; $card.Controls.Add($nl)
    if($s.Source -ne 'known'){
      $tag=New-Object System.Windows.Forms.Label; $tag.Text='AUTO-FOUND'; $tag.ForeColor=$cAmber
      $tag.Font=New-Object System.Drawing.Font('Segoe UI',7,[System.Drawing.FontStyle]::Bold); $tag.Location=New-Object System.Drawing.Point(16,35); $tag.AutoSize=$true; $card.Controls.Add($tag)
    }
    $dot=New-Object System.Windows.Forms.Label; $dot.Text=[char]0x25CF
    $dot.Font=New-Object System.Drawing.Font('Segoe UI',13); $dot.ForeColor=[System.Drawing.Color]::Gray
    $dot.Location=New-Object System.Drawing.Point(16,38); $dot.AutoSize=$true; $card.Controls.Add($dot)
    $stt=New-Object System.Windows.Forms.Label; $stt.Text='checking...'
    $stt.ForeColor=[System.Drawing.Color]::FromArgb(200,200,210)
    $stt.Location=New-Object System.Drawing.Point(40,43); $stt.Size=New-Object System.Drawing.Size(([Math]::Max(150,$startX-48)),22); $stt.AutoEllipsis=$true; $card.Controls.Add($stt)
    $bStart=New-FlatButton 'Start' $cGreen $startX
    $bStop =New-FlatButton 'Stop'  $cRed   $stopX
    $bOpen =New-FlatButton 'Open'  $cBlue  $openX
    if(-not $s.Available){ $bStart.BackColor=$cGray; $bStart.Enabled=$false }
    $bOpen.Enabled=-not [string]::IsNullOrWhiteSpace([string]$s.Url)

    $cbEnabled=New-Object System.Windows.Forms.CheckBox; $cbEnabled.Text='Enabled'; $cbEnabled.ForeColor=[System.Drawing.Color]::White
    $cbEnabled.BackColor=$cCard; $cbEnabled.AutoSize=$true; $cbEnabled.Location=New-Object System.Drawing.Point(16,76)
    $cbEnabled.Checked=([bool]$s.RunEnabled); $cbEnabled.Enabled=[bool]$s.Managed
    $cbPersist=New-Object System.Windows.Forms.CheckBox; $cbPersist.Text='Keep alive'; $cbPersist.ForeColor=[System.Drawing.Color]::White
    $cbPersist.BackColor=$cCard; $cbPersist.AutoSize=$true; $cbPersist.Location=New-Object System.Drawing.Point(110,76)
    $cbPersist.Checked=([bool]$s.Persistent); $cbPersist.Enabled=[bool]$s.Managed
    $cbRestart=New-Object System.Windows.Forms.CheckBox; $cbRestart.Text='Start at sign-in'; $cbRestart.ForeColor=[System.Drawing.Color]::White
    $cbRestart.BackColor=$cCard; $cbRestart.AutoSize=$true; $cbRestart.Location=New-Object System.Drawing.Point(214,76)
    $cbRestart.Checked=([bool]$s.StartOnRestart); $cbRestart.Enabled=[bool]$s.Managed
    $toolTip.SetToolTip($cbEnabled,'Desired runtime state. Turning this off stops the service and prevents lifecycle recovery.')
    $toolTip.SetToolTip($cbPersist,'While Enabled, recover the service automatically if its listener disappears.')
    $toolTip.SetToolTip($cbRestart,'While Enabled, start this service automatically when you sign in.')
    $s.Dot=$dot; $s.Status=$stt; $s.StartBtn=$bStart; $s.StopBtn=$bStop
    $s.RunEnabledBox=$cbEnabled; $s.PersistentBox=$cbPersist; $s.StartOnRestartBox=$cbRestart
    $bStart.Add_Click({
      $script:buildingCards=$true; try { $cbEnabled.Checked=$true } finally { $script:buildingCards=$false }
      Start-Srv $s; $s.Status.Text='STARTING...'; $s.Dot.ForeColor=$cAmber
    }.GetNewClosure())
    $bStop.Add_Click({
      $script:buildingCards=$true; try { $cbEnabled.Checked=$false } finally { $script:buildingCards=$false }
      Stop-Srv $s; $s.Status.Text='STOPPING...'; $s.Dot.ForeColor=$cAmber
    }.GetNewClosure())
    $bOpen.Add_Click( { Start-Process $s.Url }.GetNewClosure())
    $cbEnabled.Add_CheckedChanged({
      if($script:buildingCards){ return }
      $enabled=[bool]$cbEnabled.Checked
      Save-ServerSettings $s ([bool]$cbPersist.Checked) ([bool]$cbRestart.Checked) $enabled
      if($enabled -and $s.Available){ Start-Srv $s $false }elseif(-not $enabled){ Stop-Srv $s $false }
    }.GetNewClosure())
    $cbPersist.Add_CheckedChanged({
      if($script:buildingCards){ return }
      Save-ServerSettings $s ([bool]$cbPersist.Checked) ([bool]$cbRestart.Checked) ([bool]$cbEnabled.Checked)
      if($cbPersist.Checked -and $cbEnabled.Checked -and $s.Available){ Start-Srv $s $false }
    }.GetNewClosure())
    $cbRestart.Add_CheckedChanged({
      if($script:buildingCards){ return }
      Save-ServerSettings $s ([bool]$cbPersist.Checked) ([bool]$cbRestart.Checked) ([bool]$cbEnabled.Checked)
    }.GetNewClosure())
    [void]$card.Controls.Add($bStart); [void]$card.Controls.Add($bStop); [void]$card.Controls.Add($bOpen)
    [void]$card.Controls.Add($cbEnabled); [void]$card.Controls.Add($cbPersist); [void]$card.Controls.Add($cbRestart)
    [void]$cards.Controls.Add($card); $y+=112
  }
  $cards.ResumeLayout()
  $script:buildingCards=$false
}

# ---- Power settings popup (user-invoked ONLY; the powercfg calls here never run on the 2s timer) ----
$script:powerPolicyPath = Join-Path $PSScriptRoot 'power-policy.json'
$script:powerGuard      = Join-Path $PSScriptRoot 'PowerGuard.ps1'
$script:powerOpts       = @(0,1,2,5,10,15,20,30,45,60,90,120)
function Get-PgScheme { $s=powercfg /getactivescheme; if($s -match 'GUID:\s*([0-9a-fA-F-]{36})'){ return $Matches[1] }; return $null }
function Get-PgMin($g,$sub,$set,$ac){
  if(-not $g){ return $null }
  $q=powercfg /q $g $sub $set; $pat=if($ac){'Current AC Power Setting Index'}else{'Current DC Power Setting Index'}
  $l=($q | Select-String $pat | Select-Object -First 1).Line
  if($l -and $l -match ':\s*0x([0-9a-fA-F]+)'){ return [int]([Convert]::ToInt32($Matches[1],16)/60) }
  return $null
}
function New-MinCombo($parent,$x,$y,$valMin){
  $c=New-Object System.Windows.Forms.ComboBox; $c.DropDownStyle='DropDownList'
  $c.Location=New-Object System.Drawing.Point([int]$x,[int]$y); $c.Width=96
  $c.BackColor=$cCard; $c.ForeColor=[System.Drawing.Color]::White; $c.FlatStyle='Flat'
  foreach($o in $script:powerOpts){ [void]$c.Items.Add($(if($o -eq 0){'Never'}else{"$o min"})) }
  $idx=[array]::IndexOf($script:powerOpts,[int]$valMin); if($idx -lt 0){ $idx=0 }
  $c.SelectedIndex=$idx; $parent.Controls.Add($c); return $c
}
function Show-PowerDialog {
  $pol=$null; try { $pol=Get-Content -LiteralPath $script:powerPolicyPath -Raw -EA Stop | ConvertFrom-Json } catch {}
  $g=$null; if(-not $pol){ $g=Get-PgScheme }
  $dAC = if($pol){[int]$pol.displayOffAC}else{ $t=Get-PgMin $g 'SUB_VIDEO' 'VIDEOIDLE' $true;  if($null -eq $t){0}else{$t} }
  $dDC = if($pol){[int]$pol.displayOffDC}else{ $t=Get-PgMin $g 'SUB_VIDEO' 'VIDEOIDLE' $false; if($null -eq $t){0}else{$t} }
  $sAC = if($pol){[int]$pol.sleepAC}else{ $t=Get-PgMin $g 'SUB_SLEEP' 'STANDBYIDLE' $true;  if($null -eq $t){0}else{$t} }
  $sDC = if($pol){[int]$pol.sleepDC}else{ $t=Get-PgMin $g 'SUB_SLEEP' 'STANDBYIDLE' $false; if($null -eq $t){0}else{$t} }
  $enf = if($pol){[bool]$pol.enforce}else{$true}

  $dlg=New-Object System.Windows.Forms.Form
  $dlg.Text='Power - locked settings'; $dlg.BackColor=$cBg; $dlg.ForeColor=[System.Drawing.Color]::White
  $dlg.Font=New-Object System.Drawing.Font('Segoe UI',9); $dlg.FormBorderStyle='FixedDialog'
  $dlg.MaximizeBox=$false; $dlg.MinimizeBox=$false; $dlg.StartPosition='CenterScreen'
  $dlg.Size=New-Object System.Drawing.Size(452,392)
  try { if(Test-Path $IconPath){ $dlg.Icon=New-Object System.Drawing.Icon $IconPath } } catch {}

  $t1=New-Object System.Windows.Forms.Label; $t1.Text='POWER - locked settings'; $t1.ForeColor=[System.Drawing.Color]::White
  $t1.Font=New-Object System.Drawing.Font('Segoe UI',13,[System.Drawing.FontStyle]::Bold); $t1.Location=New-Object System.Drawing.Point(20,14); $t1.AutoSize=$true; $dlg.Controls.Add($t1)
  $t2=New-Object System.Windows.Forms.Label; $t2.Text='Windows/OEM utility changes get reverted automatically (re-checked every minute + at login).'
  $t2.ForeColor=[System.Drawing.Color]::FromArgb(150,150,160); $t2.Location=New-Object System.Drawing.Point(22,46); $t2.Size=New-Object System.Drawing.Size(410,34); $dlg.Controls.Add($t2)

  $hAC=New-Object System.Windows.Forms.Label; $hAC.Text='Plugged in'; $hAC.ForeColor=$cGreen; $hAC.Font=New-Object System.Drawing.Font('Segoe UI',9,[System.Drawing.FontStyle]::Bold); $hAC.Location=New-Object System.Drawing.Point(212,92); $hAC.AutoSize=$true; $dlg.Controls.Add($hAC)
  $hDC=New-Object System.Windows.Forms.Label; $hDC.Text='On battery'; $hDC.ForeColor=$cAmber; $hDC.Font=New-Object System.Drawing.Font('Segoe UI',9,[System.Drawing.FontStyle]::Bold); $hDC.Location=New-Object System.Drawing.Point(324,92); $hDC.AutoSize=$true; $dlg.Controls.Add($hDC)

  $l1=New-Object System.Windows.Forms.Label; $l1.Text='Turn off display after'; $l1.ForeColor=[System.Drawing.Color]::White; $l1.Location=New-Object System.Drawing.Point(22,120); $l1.AutoSize=$true; $dlg.Controls.Add($l1)
  $cDispAC=New-MinCombo $dlg 206 116 $dAC
  $cDispDC=New-MinCombo $dlg 318 116 $dDC
  $l2=New-Object System.Windows.Forms.Label; $l2.Text='Sleep after'; $l2.ForeColor=[System.Drawing.Color]::White; $l2.Location=New-Object System.Drawing.Point(22,160); $l2.AutoSize=$true; $dlg.Controls.Add($l2)
  $cSleepAC=New-MinCombo $dlg 206 156 $sAC
  $cSleepDC=New-MinCombo $dlg 318 156 $sDC

  $chk=New-Object System.Windows.Forms.CheckBox; $chk.Text='Enforce - auto-revert Windows/OEM utility changes'; $chk.ForeColor=[System.Drawing.Color]::White; $chk.Location=New-Object System.Drawing.Point(22,206); $chk.AutoSize=$true; $chk.Checked=$enf; $dlg.Controls.Add($chk)
  $note=New-Object System.Windows.Forms.Label; $note.Text='"Never" keeps the display/PC on - on battery that uses more power.'; $note.ForeColor=[System.Drawing.Color]::FromArgb(130,130,140); $note.Location=New-Object System.Drawing.Point(22,236); $note.Size=New-Object System.Drawing.Size(410,30); $dlg.Controls.Add($note)

  $apply=New-Object System.Windows.Forms.Button; $apply.Text='Apply & Lock'; $apply.BackColor=$cGreen; $apply.ForeColor=[System.Drawing.Color]::White; $apply.FlatStyle='Flat'; $apply.FlatAppearance.BorderSize=0; $apply.Size=New-Object System.Drawing.Size(122,34); $apply.Location=New-Object System.Drawing.Point(206,296); $apply.Font=New-Object System.Drawing.Font('Segoe UI',9,[System.Drawing.FontStyle]::Bold); $apply.DialogResult=[System.Windows.Forms.DialogResult]::OK; $dlg.Controls.Add($apply)
  $cancel=New-Object System.Windows.Forms.Button; $cancel.Text='Cancel'; $cancel.BackColor=$cGray; $cancel.ForeColor=[System.Drawing.Color]::White; $cancel.FlatStyle='Flat'; $cancel.FlatAppearance.BorderSize=0; $cancel.Size=New-Object System.Drawing.Size(90,34); $cancel.Location=New-Object System.Drawing.Point(340,296); $cancel.DialogResult=[System.Windows.Forms.DialogResult]::Cancel; $dlg.Controls.Add($cancel)
  $dlg.AcceptButton=$apply; $dlg.CancelButton=$cancel

  $res=$dlg.ShowDialog()
  if($res -eq [System.Windows.Forms.DialogResult]::OK){
    $newPol=[ordered]@{
      enforce      = [bool]$chk.Checked
      displayOffAC = $script:powerOpts[$cDispAC.SelectedIndex]
      displayOffDC = $script:powerOpts[$cDispDC.SelectedIndex]
      sleepAC      = $script:powerOpts[$cSleepAC.SelectedIndex]
      sleepDC      = $script:powerOpts[$cSleepDC.SelectedIndex]
      updated      = (Get-Date).ToString('o')
    }
    try { ($newPol | ConvertTo-Json) | Set-Content -LiteralPath $script:powerPolicyPath -Encoding UTF8 } catch {}
    try { Start-HiddenPowerShellProcess -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',$script:powerGuard) | Out-Null } catch {}
    Show-Balloon 'Power settings locked' 'Applied - and auto-reverted if Windows changes them.'
  }
  try { $dlg.Dispose() } catch {}
}

# ---- tray (GUID icon, WinForms NotifyIcon fallback) ---------------
$script:tray=$null; $script:notify=$null; $script:menu=$null; $script:trayState=''
$script:miTunnel=$null; $script:miTunnelStatus=$null
function Stop-NonPersistentServers {
  foreach($srv in @($script:Servers)){
    # Hiding or exiting the panel stops this session without silently clearing
    # Enabled. That preserves an independent Start-at-sign-in preference.
    if(-not [bool]$srv.Persistent){ Stop-Srv $srv $false }
  }
}
function Build-TrayMenu {
  $oldMenu=$script:menu
  $m=New-Object System.Windows.Forms.ContextMenuStrip
  foreach($s in $script:Servers){
    $mi=New-Object System.Windows.Forms.ToolStripMenuItem($s.Name)
    $miStart=New-Object System.Windows.Forms.ToolStripMenuItem('Start'); $miStart.Enabled=[bool]$s.Managed; $miStart.Add_Click({ Start-Srv $s }.GetNewClosure())
    $miStop =New-Object System.Windows.Forms.ToolStripMenuItem('Stop');  $miStop.Add_Click({ Stop-Srv $s }.GetNewClosure())
    $miOpen =New-Object System.Windows.Forms.ToolStripMenuItem('Open in browser'); $miOpen.Add_Click({ Start-Process $s.Url }.GetNewClosure())
    [void]$mi.DropDownItems.Add($miStart); [void]$mi.DropDownItems.Add($miStop); [void]$mi.DropDownItems.Add($miOpen)
    [void]$m.Items.Add($mi)
  }
  [void]$m.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $miTunnel=New-Object System.Windows.Forms.ToolStripMenuItem('Auto-connect keys')
  $miTunnel.CheckOnClick=$false
  $miTunnel.Enabled=(Test-MechanicalConnectEngine)
  $miTunnel.Checked=[bool]((Read-MechanicalConnectState).armed)
  $miTunnel.Add_Click({
    # Toggle from the persisted switch, not from the menu's own Checked flag,
    # so the tray always acts on what the engine actually recorded. Checked is
    # NOT set optimistically here: the engine writes the switch, and
    # Update-MechanicalConnectTray reads it back on the next 2s tick. Guessing
    # produced a checkmark that disagreed with the tooltip for as long as the
    # panel stayed open.
    $state=Read-MechanicalConnectState
    $armed=[bool]($null -ne $state -and [bool]$state.armed)
    [void](Invoke-MechanicalConnectAction $(if($armed){'Disable'}else{'Enable'}))
  }.GetNewClosure())
  $script:miTunnel=$miTunnel
  [void]$m.Items.Add($miTunnel)
  # A non-clickable line carrying the engine's own `detail`. Without it the
  # only way to find out why the switch is unhappy is to open the state file
  # by hand, which is exactly the outcome this feature exists to avoid.
  $miTunnelStatus=New-Object System.Windows.Forms.ToolStripMenuItem("   $(Get-MechanicalConnectMenuText)")
  $miTunnelStatus.Enabled=$false
  $script:miTunnelStatus=$miTunnelStatus
  [void]$m.Items.Add($miTunnelStatus)
  $miShow=New-Object System.Windows.Forms.ToolStripMenuItem('Show control panel'); $miShow.Add_Click({ Show-Panel }); [void]$m.Items.Add($miShow)
  $miPower=New-Object System.Windows.Forms.ToolStripMenuItem('Power settings...'); $miPower.Add_Click({ Show-PowerDialog }); [void]$m.Items.Add($miPower)
  $miStopAll=New-Object System.Windows.Forms.ToolStripMenuItem('Stop ALL servers'); $miStopAll.Add_Click({ foreach($s in $script:Servers){ Stop-Srv $s } }); [void]$m.Items.Add($miStopAll)
  [void]$m.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $miExit=New-Object System.Windows.Forms.ToolStripMenuItem('Exit panel (stop non-persistent servers)'); $miExit.Add_Click({ Stop-NonPersistentServers; $script:reallyExit=$true; $timer.Stop(); Remove-Tray; $form.Close() }); [void]$m.Items.Add($miExit)
  $script:menu=$m
  if($script:notify){ $script:notify.ContextMenuStrip=$m }
  if($oldMenu){ try { if($oldMenu.Visible){ $oldMenu.Close() }; $oldMenu.Dispose() } catch {} }
}
function Show-Panel { $form.Show(); $form.WindowState='Normal'; $form.Activate() }
function Show-Menu {
  if($script:menu -and $script:tray){
    $script:tray.Foreground()
    # VERSION_4 delivers the icon's anchor point (keyboard-invoked menus
    # open at the icon, not wherever the mouse happens to sit)
    if($script:tray.HasAnchor){ $pt=New-Object System.Drawing.Point -ArgumentList ([int]$script:tray.AnchorX),([int]$script:tray.AnchorY) }
    else { $pt=[System.Windows.Forms.Cursor]::Position }
    $script:menu.Show($pt)
  }
}
function Set-Tray($icon,$text,$state){
  $key = "$state|$text"
  if($key -eq $script:trayState){ return }             # only touch the shell on change
  $script:trayState=$key
  if($script:tray){ try{ $script:tray.Update($icon.Handle,$text) }catch{} }   # enqueued, non-blocking
  elseif($script:notify){ $script:notify.Icon=$icon; $script:notify.Text=$text }
}
function Show-Balloon($title,$text){ try { if($script:tray){ $script:tray.Balloon($title,$text) } elseif($script:notify){ $script:notify.ShowBalloonTip(1800,$title,$text,[System.Windows.Forms.ToolTipIcon]::Info) } } catch {} }
function Remove-Tray {
  if($script:tray){ try { $script:tray.Destroy() } catch {}; $script:tray=$null }
  elseif($script:notify){ try { $script:notify.Visible=$false; $script:notify.Dispose() } catch {}; $script:notify=$null }
}

if(-not $RenderPreviewPath){
  if($script:GuidTrayOk){
    try {
      $script:tray=New-Object GuidTray $TrayGuid
      $script:tray.add_LeftClick({ Show-Panel })
      $script:tray.add_RightClick({ Show-Menu })
      if(-not $script:tray.Show($icoDown.Handle,'Server Control Panel')){
        # GUID slot unavailable: fully destroy the native window so a later
        # TaskbarCreated can't resurrect a duplicate icon next to the fallback.
        try { $script:tray.Destroy() } catch {}
        $script:tray=$null
      }
    } catch { if($script:tray){ try { $script:tray.Destroy() } catch {} }; $script:tray=$null }
  }
  if(-not $script:tray){
    $script:notify=New-Object System.Windows.Forms.NotifyIcon; $script:notify.Icon=$icoDown; $script:notify.Text='Server Control Panel'; $script:notify.Visible=$true
    $script:notify.Add_MouseClick({ if($_.Button -eq [System.Windows.Forms.MouseButtons]::Left){ Show-Panel } })
  }
}

# ---- keep the tray icon in the always-visible area (Win11) ---------
$script:promoKey=$null
$script:promoMiss=0
function Promote-Tray {
  if(-not $script:tray){ return }                      # meaningless for the fallback icon
  if($script:promoMiss -ge 6){ return }                # stop scanning if it never appears
  try {
    $base='HKCU:\Control Panel\NotifyIconSettings'
    if(-not (Test-Path $base)){ return }
    if($script:promoKey){
      if((Get-ItemProperty $script:promoKey -Name IsPromoted -ErrorAction SilentlyContinue).IsPromoted -eq 1){ return }
    }
    $target = $TrayGuid.ToString()
    foreach($k in (Get-ChildItem $base -ErrorAction SilentlyContinue)){
      $g=(Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue).IconGuid
      if($g -and (($g -replace '[{}]','') -ieq $target)){
        $script:promoKey=$k.PSPath
        $cur=(Get-ItemProperty $k.PSPath -Name IsPromoted -ErrorAction SilentlyContinue).IsPromoted
        if($cur -ne 1){
          Set-ItemProperty -Path $k.PSPath -Name IsPromoted -Value 1 -Type DWord -ErrorAction SilentlyContinue
          try { $script:tray.ShowAsync($icoDown.Handle,'Server Control Panel'); $script:trayState='' } catch {}
        }
        return
      }
    }
    $script:promoMiss++
  } catch {}
}

# ---- status refresh (all fast ops) --------------------------------
function Update-Status {
  $ports = Get-ListenPortSet
  $upCount=0
  $now=Get-Date
  foreach($s in $script:Servers){
    $script:buildingCards=$true
    try {
      if($s.RunEnabledBox -and $s.RunEnabledBox.Checked -ne [bool]$s.RunEnabled){ $s.RunEnabledBox.Checked=[bool]$s.RunEnabled }
      if($s.PersistentBox -and $s.PersistentBox.Checked -ne [bool]$s.Persistent){ $s.PersistentBox.Checked=[bool]$s.Persistent }
      if($s.StartOnRestartBox -and $s.StartOnRestartBox.Checked -ne [bool]$s.StartOnRestart){ $s.StartOnRestartBox.Checked=[bool]$s.StartOnRestart }
    } finally { $script:buildingCards=$false }
    if($ports.ContainsKey([int]$s.Port)){
      $upCount++
      $script:lastStartAt.Remove([int]$s.Port)
      $s.Dot.ForeColor=$cGreen
      $s.Status.Text=("RUNNING  /  localhost:{0}" -f $s.Port)
      $s.Status.ForeColor=[System.Drawing.Color]::FromArgb(205,210,220)
      $s.StartBtn.Enabled=$false
      $s.StopBtn.Enabled=$true
    } else {
      $intentionalStop=$script:stopRequested.ContainsKey([int]$s.Port) -and $script:stopRequested[[int]$s.Port] -eq $true
      $shouldRestart=[bool]$s.Available -and [bool]$s.Persistent -and [bool]$s.RunEnabled -and -not $intentionalStop
      if(-not [bool]$s.Available){
        $s.Dot.ForeColor=$cGray; $s.Status.ForeColor=[System.Drawing.Color]::FromArgb(145,150,160)
        $s.Status.Text=("UNAVAILABLE  /  {0}" -f $s.UnavailableReason)
      } elseif(-not [bool]$s.RunEnabled){
        $s.Dot.ForeColor=$cGray; $s.Status.ForeColor=[System.Drawing.Color]::FromArgb(155,160,172); $s.Status.Text='DISABLED'
      } elseif((-not $RenderPreviewPath) -and $shouldRestart -and (-not $script:lastStartAt.ContainsKey([int]$s.Port) -or (($now-$script:lastStartAt[[int]$s.Port]).TotalSeconds -ge 10))){
        $s.Dot.ForeColor=$cAmber; $s.Status.ForeColor=$cAmber
        $s.Status.Text='RESTARTING...'
        Start-Srv $s $false
      } else {
        $s.Dot.ForeColor=$cRed; $s.Status.ForeColor=[System.Drawing.Color]::FromArgb(205,210,220); $s.Status.Text='STOPPED'
      }
      $s.StartBtn.Enabled=([bool]$s.Available -and [bool]$s.Managed)
      $s.StopBtn.Enabled=$false
    }
  }
  $total=@($script:Servers).Count
  $persistentCount=@($script:Servers | Where-Object { [bool]$_.Persistent -and [bool]$_.RunEnabled }).Count
  $unavailableCount=@($script:Servers | Where-Object { -not [bool]$_.Available }).Count
  $healthSummary.Text=("{0}/{1} running  /  {2} recovery-protected  /  {3} unavailable  /  checked {4}" -f $upCount,$total,$persistentCount,$unavailableCount,(Get-Date -Format 'HH:mm:ss'))
  $healthSummary.ForeColor=if($upCount -eq $total){$cGreen}elseif($upCount -gt 0){$cAmber}else{$cRed}
  Update-MechanicalConnectTray
  $mech=Get-MechanicalConnectTrayText
  if($total -gt 0 -and $upCount -eq $total){ Set-Tray $icoUp "Servers: all running  /  $mech" 'up' }
  elseif($upCount -eq 0){ Set-Tray $icoDown "Servers: all stopped  /  $mech" 'down' }
  else { Set-Tray $icoSome ("Servers: {0}/{1} running  /  {2}" -f $upCount,$total,$mech) 'some' }
}

Build-Cards

if($RenderPreviewPath){
  # Deterministic, non-interactive visual QA: render the complete WinForms tree
  # without touching the shared tray, heartbeat, lifecycle tasks, or services.
  $previewFull=[System.IO.Path]::GetFullPath($RenderPreviewPath)
  if(-not (Test-ServerControlFixedPath $previewFull)){ throw 'RenderPreviewPath must be on a local fixed drive.' }
  $previewDir=Split-Path -Parent $previewFull
  if($previewDir -and -not (Test-Path -LiteralPath $previewDir)){ New-Item -ItemType Directory -Path $previewDir -Force | Out-Null }
  Update-Status
  Update-TunnelControls
  Update-FullRemoteControl
  $form.StartPosition='Manual'; $form.Location=New-Object System.Drawing.Point(-10000,-10000); $form.ShowInTaskbar=$false
  $form.Show(); [System.Windows.Forms.Application]::DoEvents(); $form.Refresh(); [System.Windows.Forms.Application]::DoEvents()
  $bitmap=New-Object System.Drawing.Bitmap $form.ClientSize.Width,$form.ClientSize.Height
  try {
    $form.DrawToBitmap($bitmap,(New-Object System.Drawing.Rectangle 0,0,$bitmap.Width,$bitmap.Height))
    $bitmap.Save($previewFull,[System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bitmap.Dispose() }
  [pscustomobject][ordered]@{
    ok=$true
    schema='servercontrol.preview.v1'
    bundleVersion=$script:ServerControlBundleVersion
    machine=$HostProfile.MachineId
    path=$previewFull
    width=$form.ClientSize.Width
    height=$form.ClientSize.Height
    serverCount=@($script:Servers).Count
    accessTiers=@('Tunnel','ToolsEnabled','Full remote')
    runtimeStateMutated=$false
  } | ConvertTo-Json -Compress
  try { $script:mutex.ReleaseMutex() } catch {}
  try { $script:mutex.Dispose() } catch {}
  $form.Dispose()
  exit 0
}

Build-TrayMenu

$form.Add_FormClosing({
  # Never veto an OS-initiated close - vetoing shows the full-screen
  # "this app is preventing shutdown" blocker at every shutdown/logoff.
  if($_.CloseReason -eq [System.Windows.Forms.CloseReason]::WindowsShutDown -or
      $_.CloseReason -eq [System.Windows.Forms.CloseReason]::TaskManagerClosing){ return }
  if(-not $script:reallyExit){
    Stop-NonPersistentServers
    $_.Cancel=$true; $form.Hide()
    Show-Balloon 'Panel hidden to tray' 'Non-persistent servers stopped. Persistent servers remain alive and self-restart.'
  }
})

# ---- timer: every op in here must be milliseconds-fast ------------
$script:tick=0
$script:inTick=$false
$timer=New-Object System.Windows.Forms.Timer; $timer.Interval=2000
$timer.Add_Tick({
  if($script:inTick){ return }
  $script:inTick=$true
  try {
    Write-PanelHeartbeat
    if($script:showEvt.WaitOne(0)){ Show-Panel }       # second launch asked us to appear
    Update-Status
    Update-TunnelControls
    Complete-FullRemoteAction
    Update-FullRemoteControl
    $script:tick++
    if($script:tick -le 5 -or ($script:tick % 60) -eq 0){ Promote-Tray }
    Complete-BgSync                                     # harvest finished discovery / watchdog
    if(-not $script:bg -and ((Get-Date)-$script:lastSync).TotalSeconds -ge 30){ Start-BgSync }
  } catch {}
  finally { $script:inTick=$false }
})
$btnRefresh.Add_Click({ Update-Status; Update-TunnelControls; Invoke-FullRemoteAction 'Status'; Update-FullRemoteControl; Write-PanelHeartbeat }.GetNewClosure())
$timer.Start()

if($Minimized){ $form.Add_Shown({ $form.Hide() }) }
Update-Status
Update-TunnelControls
Update-FullRemoteControl
Invoke-FullRemoteAction 'Status'
Promote-Tray
Start-BgSync
Write-PanelHeartbeat
Schedule-LifecycleReconcile
try {
  [System.Windows.Forms.Application]::Run($form)
} finally {
  Remove-Tray
  # Mutex FIRST: even if a background pipeline is wedged in hung WMI, a
  # relaunch must find the mutex free. Then only ASYNC stops - a synchronous
  # Dispose on a running pipeline blocks until the pipeline yields.
  try { $script:mutex.ReleaseMutex() } catch {}
  try { $script:mutex.Dispose() } catch {}
  if($script:bg){ try { [void]$script:bg.PS.BeginStop($null,$null) } catch {} }
  foreach($z in $script:zombies){ try { [void]$z.PS.BeginStop($null,$null) } catch {} }
}
