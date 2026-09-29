param(
    [Parameter(Mandatory = $true)][ValidateSet('notify', 'clipboard-get', 'clipboard-set', 'screenshot', 'capture-region', 'monitor-list', 'capture-monitor', 'window-list', 'window-focus', 'window-focus-fenced', 'window-close', 'window-close-test', 'capture-window', 'thumbnail', 'ocr', 'tts', 'sound', 'ask')][string]$Verb,
    [string]$Arg1
)
# Local desktop helper for the ToolsEnabled MCP `desktop` capability. Arbitrary text
# (notify payload, clipboard content) is passed via a file path in $Arg1 so nothing is
# interpolated into a command line. stdout carries the machine-readable result.
$ErrorActionPreference = 'Stop'

# PowerShell 5 otherwise inherits the launch host's legacy console code page.
# The Node caller always decodes helper stdout as UTF-8, so make that contract
# explicit for background/service launches as well as interactive terminals.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

function Add-WindowInterop {
    if ('ToolsEnabledNativeWindow' -as [type]) { return }
    Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ToolsEnabledNativeWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct MONITORINFOEX {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szDevice;
  }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT point, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int valueSize);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
}
'@
}

function Enable-PerMonitorDpiAwareness {
    Add-WindowInterop
    # PER_MONITOR_AWARE_V2 (-4) makes all bounds/CopyFromScreen coordinates physical
    # pixels. It can legitimately fail when the host already chose an awareness mode.
    try {
        if ([ToolsEnabledNativeWindow]::SetProcessDpiAwarenessContext([IntPtr](-4))) { return }
    } catch { }
    try { [void][ToolsEnabledNativeWindow]::SetProcessDPIAware() } catch { }
}

function Get-NativeWindowRect([IntPtr]$Handle) {
    $rect = New-Object ToolsEnabledNativeWindow+RECT
    if (-not [ToolsEnabledNativeWindow]::GetWindowRect($Handle, [ref]$rect)) { throw 'The requested window no longer exists.' }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 1 -or $height -lt 1) { throw 'The requested window has invalid bounds.' }
    return [pscustomobject]@{ x = $rect.Left; y = $rect.Top; width = $width; height = $height }
}

function Get-MonitorDpi([IntPtr]$Monitor) {
    [UInt32]$dpiX = 96; [UInt32]$dpiY = 96
    if ($Monitor -ne [IntPtr]::Zero) {
        try {
            [UInt32]$reportedX = 0; [UInt32]$reportedY = 0
            if ([ToolsEnabledNativeWindow]::GetDpiForMonitor($Monitor, 0, [ref]$reportedX, [ref]$reportedY) -eq 0 -and $reportedX -gt 0 -and $reportedY -gt 0) {
                $dpiX = $reportedX; $dpiY = $reportedY
            }
        } catch { }
    }
    return [pscustomobject]@{ dpiX = [int]$dpiX; dpiY = [int]$dpiY }
}

function Get-MonitorId([IntPtr]$Monitor) {
    if ($Monitor -eq [IntPtr]::Zero) { return $null }
    $info = New-Object ToolsEnabledNativeWindow+MONITORINFOEX
    $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
    if (-not [ToolsEnabledNativeWindow]::GetMonitorInfo($Monitor, [ref]$info)) { return $null }
    return [string]$info.szDevice
}

function Get-DesktopMonitors {
    Enable-PerMonitorDpiAwareness
    Add-Type -AssemblyName System.Windows.Forms
    $monitors = New-Object System.Collections.Generic.List[object]
    foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
        $bounds = $screen.Bounds; $work = $screen.WorkingArea
        $point = New-Object ToolsEnabledNativeWindow+POINT
        $point.X = [int]([Int64]$bounds.Left + [Int64][Math]::Floor($bounds.Width / 2))
        $point.Y = [int]([Int64]$bounds.Top + [Int64][Math]::Floor($bounds.Height / 2))
        $monitor = [ToolsEnabledNativeWindow]::MonitorFromPoint($point, 2)
        $dpi = Get-MonitorDpi $monitor
        $monitors.Add([pscustomobject]@{
            monitorId = [string]$screen.DeviceName; x = [int]$bounds.Left; y = [int]$bounds.Top; width = [int]$bounds.Width; height = [int]$bounds.Height;
            workX = [int]$work.Left; workY = [int]$work.Top; workWidth = [int]$work.Width; workHeight = [int]$work.Height;
            dpiX = $dpi.dpiX; dpiY = $dpi.dpiY; primary = [bool]$screen.Primary
        })
    }
    return $monitors.ToArray()
}

function Get-WindowDisplayState([object]$Rect, [object[]]$Monitors) {
    [Int64]$total = [Int64]$Rect.width * [Int64]$Rect.height
    [Int64]$covered = 0; [Int64]$largest = -1; $monitorId = $null
    foreach ($monitor in $Monitors) {
        [Int64]$left = [Math]::Max([Int64]$Rect.x, [Int64]$monitor.x)
        [Int64]$top = [Math]::Max([Int64]$Rect.y, [Int64]$monitor.y)
        [Int64]$right = [Math]::Min(([Int64]$Rect.x + [Int64]$Rect.width), ([Int64]$monitor.x + [Int64]$monitor.width))
        [Int64]$bottom = [Math]::Min(([Int64]$Rect.y + [Int64]$Rect.height), ([Int64]$monitor.y + [Int64]$monitor.height))
        if ($right -gt $left -and $bottom -gt $top) {
            [Int64]$area = ($right - $left) * ($bottom - $top)
            $covered += $area
            if ($area -gt $largest) { $largest = $area; $monitorId = [string]$monitor.monitorId }
        }
    }
    return [pscustomobject]@{
        monitorId = $monitorId; isOffscreen = ($covered -eq 0); isPartial = ($covered -gt 0 -and $covered -lt $total)
    }
}

function Get-WindowProcessIdentity([UInt32]$ProcessId) {
    $name = 'unknown'; $label = 'unknown'; $startKey = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById([int]$ProcessId)
        if ($process.ProcessName) { $name = [string]$process.ProcessName; $label = $name }
        try {
            $product = [string]$process.MainModule.FileVersionInfo.ProductName
            if (-not [string]::IsNullOrWhiteSpace($product)) { $label = $product }
        } catch { }
        try { $startKey = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture) } catch { }
        $process.Dispose()
    } catch { }
    return [pscustomobject]@{ processName = $name; appLabel = $label; processStartKey = $startKey }
}

function Test-WindowCloaked([IntPtr]$Handle) {
    [int]$value = 0
    try { return ([ToolsEnabledNativeWindow]::DwmGetWindowAttribute($Handle, 14, [ref]$value, 4) -eq 0 -and $value -ne 0) } catch { return $false }
}

function Get-WindowSnapshot([IntPtr]$Handle, [object[]]$Monitors) {
    if (-not [ToolsEnabledNativeWindow]::IsWindow($Handle)) { return $null }
    [UInt32]$processId = 0
    [void][ToolsEnabledNativeWindow]::GetWindowThreadProcessId($Handle, [ref]$processId)
    if ($processId -eq 0) { return $null }
    try { $rect = Get-NativeWindowRect $Handle } catch { return $null }
    $identity = Get-WindowProcessIdentity $processId
    $text = New-Object System.Text.StringBuilder 4096
    [void][ToolsEnabledNativeWindow]::GetWindowText($Handle, $text, $text.Capacity)
    $state = Get-WindowDisplayState $rect $Monitors
    return [pscustomobject]@{
        windowId = [string]$Handle.ToInt64(); processId = [int64]$processId; processStartKey = $identity.processStartKey;
        processName = $identity.processName; appLabel = $identity.appLabel; title = $text.ToString();
        x = $rect.x; y = $rect.y; width = $rect.width; height = $rect.height; monitorId = $state.monitorId;
        isMinimized = [bool][ToolsEnabledNativeWindow]::IsIconic($Handle); isOffscreen = [bool]$state.isOffscreen;
        isPartial = [bool]$state.isPartial; isCloaked = [bool](Test-WindowCloaked $Handle);
        captureEligible = [bool](-not [string]::IsNullOrWhiteSpace($identity.processStartKey))
    }
}

function Test-WindowCloseTarget([object]$Snapshot, [string]$WindowId, [Int64]$ProcessId, [string]$ProcessStartKey, [string]$ProcessName, [string]$Title) {
    return $null -ne $Snapshot -and $Snapshot.windowId -eq $WindowId -and $Snapshot.processId -eq $ProcessId -and
        $Snapshot.processStartKey -eq $ProcessStartKey -and $Snapshot.processName -ceq $ProcessName -and $Snapshot.title -ceq $Title
}

function Test-SameWindowGeometry([object]$Before, [object]$After) {
    return $null -ne $Before -and $null -ne $After -and $Before.windowId -eq $After.windowId -and
        $Before.processId -eq $After.processId -and $Before.processStartKey -eq $After.processStartKey -and
        $Before.x -eq $After.x -and $Before.y -eq $After.y -and
        $Before.width -eq $After.width -and $Before.height -eq $After.height
}

function Test-BitmapSampledUniform([System.Drawing.Bitmap]$Bitmap) {
    $reference = $Bitmap.GetPixel(0, 0).ToArgb()
    $samplesX = [Math]::Min(64, $Bitmap.Width); $samplesY = [Math]::Min(64, $Bitmap.Height)
    for ($ix = 0; $ix -lt $samplesX; $ix++) {
        $x = [int][Math]::Floor(([Int64]$ix * ($Bitmap.Width - 1)) / [Math]::Max(1, ($samplesX - 1)))
        for ($iy = 0; $iy -lt $samplesY; $iy++) {
            $y = [int][Math]::Floor(([Int64]$iy * ($Bitmap.Height - 1)) / [Math]::Max(1, ($samplesY - 1)))
            if ($Bitmap.GetPixel($x, $y).ToArgb() -ne $reference) { return $false }
        }
    }
    return $true
}

# WHERE THE RUNNING PRODUCT WRITES, ASKED THE SAME WAY THE JAVASCRIPT HALF
# ANSWERS IT.
#
# This resolved captures/ from $PSScriptRoot, which packaged is the INSTALL
# directory -- the directory the next update deletes, that a per-machine
# install makes unwritable, and that is world-readable by default. It was the
# worse half of a disagreement: src/lib/runtime.js had already moved captures/
# to the per-user state root and passed a path there, so this script created a
# captures/ under the program, compared the two, and threw. Every screen
# capture on an installed build both wrote where it must not and then failed.
#
# src/lib/runtime-state-root.js is the one place the decision is made, and
# src/lib/runtime.js publishes the result into TOOLSENABLED_STATE_ROOT for
# every helper spawn -- including the case with no Electron shell to set it,
# where the root is derived from the PAYLOAD.json marker. The <repo> fallback
# stays for a source checkout, which is why the rule tools/secrets.ps1 follows
# is "ask first", not "never join onto your own location".
function Get-ToolsEnabledRuntimeRoot {
    $configured = [Environment]::GetEnvironmentVariable('TOOLSENABLED_STATE_ROOT')
    if (-not [string]::IsNullOrWhiteSpace($configured)) {
        return [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($configured))
    }
    return [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
}

function Assert-CapturePath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'capture path is required.' }
    $root = [IO.Path]::GetFullPath((Join-Path (Get-ToolsEnabledRuntimeRoot) 'captures')).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    [IO.Directory]::CreateDirectory($root) | Out-Null
    $full = [IO.Path]::GetFullPath($Value)
    if ([IO.Path]::GetDirectoryName($full) -ine $root -or [IO.Path]::GetExtension($full) -ine '.png') {
        throw 'capture path must be a PNG directly inside the ToolsEnabled captures directory.'
    }
    if ([IO.File]::Exists($full)) {
        throw 'capture output already exists; choose a new capture name.'
    }
    return $full
}

# A screen/monitor capture is only possible while Windows exposes an
# interactive desktop DC to this process.  Locked, disconnected, secure,
# service-hosted, and some RDP sessions legitimately do not.  Keep that state
# machine-readable instead of leaking a GDI exception or making callers treat
# an expected environment limitation as a broker failure.  Window capture via
# PrintWindow remains available for a specific eligible app in those sessions.
function Emit-CaptureUnavailable([hashtable]$Metadata) {
    $payload = @{
        status = 'unavailable'; captured = $false; usable = $false; method = 'copy_from_screen'
        limitations = @('Windows did not expose an interactive screen surface for this request; no image was written.')
    }
    if ($null -ne $Metadata) {
        foreach ($entry in $Metadata.GetEnumerator()) { $payload[$entry.Key] = $entry.Value }
    }
    [Console]::Out.Write(($payload | ConvertTo-Json -Compress))
}

function Get-WindowHandle([string]$Value) {
    if ($Value -notmatch '^[1-9][0-9]{0,18}$') { throw 'windowId is invalid.' }
    $number = [Int64]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture)
    if ($number -le 0) { throw 'windowId is invalid.' }
    return [IntPtr]$number
}

function Focus-WindowHandle([IntPtr]$Handle) {
    Add-WindowInterop
    # Joining another input queue makes its stalled message pump our stall.
    # Request activation asynchronously, then check the actual foreground HWND
    # for a bounded interval. Windows may legitimately decline this request.
    if (-not [ToolsEnabledNativeWindow]::IsWindow($Handle)) { return $false }
    [void][ToolsEnabledNativeWindow]::ShowWindowAsync($Handle, 9) # SW_RESTORE
    [void][ToolsEnabledNativeWindow]::SetForegroundWindow($Handle)
    $focusWait = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ([ToolsEnabledNativeWindow]::GetForegroundWindow() -eq $Handle) { return $true }
        Start-Sleep -Milliseconds 25
    } while ($focusWait.ElapsedMilliseconds -lt 500)
    return $false
}

function Await-WinRt([object]$Operation, [Type]$ResultType) {
    $method = @([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.ToString() -like 'Windows.Foundation.IAsyncOperation*'
    }) | Select-Object -First 1
    if ($null -eq $method) { throw 'Windows Runtime task bridge is unavailable.' }
    $task = $method.MakeGenericMethod($resultType).Invoke($null, @($Operation))
    return $task.GetAwaiter().GetResult()
}

switch ($Verb) {
    'clipboard-get' {
        $text = Get-Clipboard -Raw -ErrorAction SilentlyContinue
        if ($null -eq $text) { $text = '' }
        [Console]::Out.Write([string]$text)
    }
    'clipboard-set' {
        $text = [System.IO.File]::ReadAllText($Arg1)
        Set-Clipboard -Value $text
        [Console]::Out.Write('OK')
    }
    'notify' {
        $p = Get-Content -Path $Arg1 -Raw | ConvertFrom-Json
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $ni = New-Object System.Windows.Forms.NotifyIcon
        try {
            $ni.Icon = [System.Drawing.SystemIcons]::Information
            $ni.Visible = $true
            $dur = [int]$p.durationSeconds; if ($dur -le 0) { $dur = 5 }
            $ni.ShowBalloonTip($dur * 1000, [string]$p.title, [string]$p.message, [System.Windows.Forms.ToolTipIcon]::Info)
            Start-Sleep -Milliseconds 1200
        } finally { $ni.Dispose() }
        [Console]::Out.Write('OK')
    }
    'screenshot' {
        Enable-PerMonitorDpiAwareness
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $destination = Assert-CapturePath $Arg1
        $copyUnavailable = $false
        $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
        try {
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            try {
                try { $g.CopyFromScreen($vs.Location, [System.Drawing.Point]::Empty, $vs.Size) } catch { $copyUnavailable = $true }
            } finally { $g.Dispose() }
            if (-not $copyUnavailable) {
                $bmp.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
            }
        } finally { $bmp.Dispose() }
        if ($copyUnavailable) {
            Emit-CaptureUnavailable @{ x = $vs.Left; y = $vs.Top; width = $vs.Width; height = $vs.Height }
        } else {
            [Console]::Out.Write((@{ status = 'captured'; method = 'copy_from_screen'; x = $vs.Left; y = $vs.Top; width = $vs.Width; height = $vs.Height } | ConvertTo-Json -Compress))
        }
    }
    'capture-region' {
        $p = Get-Content -Path $Arg1 -Raw | ConvertFrom-Json
        Enable-PerMonitorDpiAwareness
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
        $right = [Int64]$p.x + [Int64]$p.width
        $bottom = [Int64]$p.y + [Int64]$p.height
        if ($p.width -lt 1 -or $p.height -lt 1 -or $p.x -lt $vs.Left -or $p.y -lt $vs.Top -or $right -gt $vs.Right -or $bottom -gt $vs.Bottom) {
            throw 'The capture region must be fully inside the virtual screen.'
        }
        $destination = Assert-CapturePath ([string]$p.path)
        $copyUnavailable = $false
        $bmp = New-Object System.Drawing.Bitmap ([int]$p.width), ([int]$p.height)
        try {
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            try {
                try { $g.CopyFromScreen([int]$p.x, [int]$p.y, 0, 0, $bmp.Size) } catch { $copyUnavailable = $true }
            } finally { $g.Dispose() }
            if (-not $copyUnavailable) {
                $bmp.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
            }
        } finally { $bmp.Dispose() }
        if ($copyUnavailable) {
            Emit-CaptureUnavailable @{ x = [int]$p.x; y = [int]$p.y; width = [int]$p.width; height = [int]$p.height }
        } else {
            [Console]::Out.Write((@{ status = 'captured'; method = 'copy_from_screen'; width = [int]$p.width; height = [int]$p.height } | ConvertTo-Json -Compress))
        }
    }
    'monitor-list' {
        [Console]::Out.Write((@{ monitors = @(Get-DesktopMonitors) } | ConvertTo-Json -Compress -Depth 5))
    }
    'capture-monitor' {
        $p = Get-Content -Path $Arg1 -Raw | ConvertFrom-Json
        if ([string]$p.monitorId -notmatch '^[A-Za-z0-9_.\\:-]{1,128}$') { throw 'monitorId is invalid.' }
        $monitor = @(Get-DesktopMonitors | Where-Object { $_.monitorId -eq [string]$p.monitorId } | Select-Object -First 1)
        if ($monitor.Count -ne 1) {
            [Console]::Out.Write((@{ status = 'monitor_not_found'; monitorId = [string]$p.monitorId; method = 'copy_from_screen' } | ConvertTo-Json -Compress))
            break
        }
        Add-Type -AssemblyName System.Drawing
        $destination = Assert-CapturePath ([string]$p.path)
        $copyUnavailable = $false
        $bmp = New-Object System.Drawing.Bitmap $monitor[0].width, $monitor[0].height
        try {
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            try {
                try { $g.CopyFromScreen($monitor[0].x, $monitor[0].y, 0, 0, $bmp.Size) } catch { $copyUnavailable = $true }
            } finally { $g.Dispose() }
            if (-not $copyUnavailable) {
                $bmp.Save($destination, [System.Drawing.Imaging.ImageFormat]::Png)
            }
        } finally { $bmp.Dispose() }
        if ($copyUnavailable) {
            Emit-CaptureUnavailable @{ monitorId = [string]$monitor[0].monitorId; x = $monitor[0].x; y = $monitor[0].y; width = $monitor[0].width; height = $monitor[0].height }
        } else {
            [Console]::Out.Write((@{ status = 'captured'; monitorId = [string]$monitor[0].monitorId; method = 'copy_from_screen'; x = $monitor[0].x; y = $monitor[0].y; width = $monitor[0].width; height = $monitor[0].height } | ConvertTo-Json -Compress))
        }
    }
    'window-list' {
        $monitors = @(Get-DesktopMonitors)
        $windows = New-Object System.Collections.Generic.List[object]
        $callback = [ToolsEnabledNativeWindow+EnumWindowsProc]{
            param([IntPtr]$Handle, [IntPtr]$Unused)
            if (-not [ToolsEnabledNativeWindow]::IsWindowVisible($Handle)) { return $true }
            $snapshot = Get-WindowSnapshot $Handle $monitors
            # Keep actual named app windows (including minimized ones), not the
            # compositor's unnamed/cloaked helper surfaces. Titles remain untrusted
            # data in the Node layer; they are only a usability filter here.
            if ($null -ne $snapshot -and ($snapshot.isMinimized -or (-not $snapshot.isCloaked -and -not [string]::IsNullOrWhiteSpace($snapshot.title)))) {
                $windows.Add($snapshot)
            }
            return $true
        }
        [void][ToolsEnabledNativeWindow]::EnumWindows($callback, [IntPtr]::Zero)
        [Console]::Out.Write((@{ windows = @($windows | Select-Object -First 500) } | ConvertTo-Json -Compress -Depth 5))
    }
    'window-focus' {
        $handle = Get-WindowHandle $Arg1
        $focused = Focus-WindowHandle $handle
        [Console]::Out.Write((@{ focused = [bool]$focused; windowId = $Arg1 } | ConvertTo-Json -Compress))
    }
    'window-focus-fenced' {
        # The generic focus helper takes only an HWND.  This narrow internal
        # variant proves the HWND still belongs to the expected process and
        # title immediately before foregrounding it, preventing an owned
        # browser operation from ever focusing a recycled or other-profile
        # Chrome window.
        $p = Get-Content -Path $Arg1 -Raw | ConvertFrom-Json
        $expectedProcessName = [string]$p.expectedProcessName
        $expectedTitle = [string]$p.expectedTitle
        if ([string]$p.expectedProcessId -notmatch '^[1-9][0-9]{0,9}$' -or
            [UInt64]$p.expectedProcessId -gt [UInt64][UInt32]::MaxValue -or
            [string]$p.expectedProcessStartKey -notmatch '^[0-9]{1,19}$' -or
            $expectedProcessName -notmatch '^[A-Za-z0-9_.-]{1,128}$' -or
            [string]::IsNullOrWhiteSpace($expectedTitle) -or $expectedTitle.Length -gt 1000 -or $expectedTitle -match '[\x00-\x1F\x7F]') {
            throw 'expected window identity is invalid.'
        }
        $monitors = @(Get-DesktopMonitors)
        $handle = Get-WindowHandle ([string]$p.windowId)
        $before = Get-WindowSnapshot $handle $monitors
        if (-not (Test-WindowCloseTarget $before ([string]$p.windowId) ([Int64]$p.expectedProcessId) ([string]$p.expectedProcessStartKey) $expectedProcessName $expectedTitle)) {
            [Console]::Out.Write((@{ status = 'target_changed'; focused = $false; windowId = [string]$p.windowId } | ConvertTo-Json -Compress))
            break
        }
        $focused = Focus-WindowHandle $handle
        $after = Get-WindowSnapshot $handle $monitors
        $unchanged = Test-WindowCloseTarget $after ([string]$p.windowId) ([Int64]$p.expectedProcessId) ([string]$p.expectedProcessStartKey) $expectedProcessName $expectedTitle
        [Console]::Out.Write((@{
            status = if ($unchanged -and $focused) { 'focused' } elseif (-not $unchanged) { 'target_changed' } else { 'focus_failed' }
            focused = [bool]($unchanged -and $focused); windowId = [string]$p.windowId
        } | ConvertTo-Json -Compress))
    }
    'window-close' {
        $p = Get-Content -Path $Arg1 -Raw | ConvertFrom-Json
        $expectedProcessName = [string]$p.expectedProcessName
        $expectedTitle = [string]$p.expectedTitle
        if ([string]$p.expectedProcessId -notmatch '^[1-9][0-9]{0,9}$' -or
            [UInt64]$p.expectedProcessId -gt [UInt64][UInt32]::MaxValue -or
            [string]$p.expectedProcessStartKey -notmatch '^[0-9]{1,19}$' -or
            $expectedProcessName -notmatch '^[A-Za-z0-9_.-]{1,128}$' -or
            [string]::IsNullOrWhiteSpace($expectedTitle) -or $expectedTitle.Length -gt 1000 -or
            $expectedTitle -match '[\x00-\x1F\x7F]' -or
            [string]$p.timeoutSeconds -notmatch '^[1-9][0-9]{1,2}$' -or
            [int]$p.timeoutSeconds -lt 30 -or [int]$p.timeoutSeconds -gt 900) {
            throw 'expected process identity is invalid.'
        }
        $monitors = @(Get-DesktopMonitors)
        $handle = Get-WindowHandle ([string]$p.windowId)
        $before = Get-WindowSnapshot $handle $monitors
        if (-not (Test-WindowCloseTarget $before ([string]$p.windowId) ([Int64]$p.expectedProcessId) ([string]$p.expectedProcessStartKey) $expectedProcessName $expectedTitle)) {
            [Console]::Out.Write((@{
                status = 'target_changed'; requested = $false; windowId = [string]$p.windowId
            } | ConvertTo-Json -Compress))
            break
        }
        # Windows has no atomic validate-and-close primitive for an unowned HWND.
        # Never send WM_CLOSE. The owner closes the visibly identified window,
        # while this dialog's message loop continuously revalidates the original
        # HWND/process/title and completes only after observing disappearance.
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $form = New-Object System.Windows.Forms.Form
        $timer = New-Object System.Windows.Forms.Timer
        $script:closeWaitStatus = 'manual_timeout'
        $script:closeWaitCompleted = $false
        try {
            $form.Text = 'ToolsEnabled safe browser handoff'
            $form.Size = New-Object System.Drawing.Size 620, 270
            $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
            $form.TopMost = $true
            $form.ShowInTaskbar = $true
            $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
            $form.MaximizeBox = $false
            $form.MinimizeBox = $false

            $label = New-Object System.Windows.Forms.Label
            $label.Location = New-Object System.Drawing.Point 18, 18
            $label.Size = New-Object System.Drawing.Size 570, 155
            $shownTitle = if ($expectedTitle.Length -gt 180) { $expectedTitle.Substring(0, 177) + '...' } else { $expectedTitle }
            $label.Text = "ToolsEnabled will not send a close command to an unowned app.`r`n`r`nPlease close this exact window yourself using its X button:`r`n$expectedProcessName - $shownTitle`r`n`r`nThis dialog will detect the closure automatically and continue."

            $cancel = New-Object System.Windows.Forms.Button
            $cancel.Text = 'Cancel'
            $cancel.Size = New-Object System.Drawing.Size 110, 34
            $cancel.Location = New-Object System.Drawing.Point 478, 185
            $cancel.Add_Click({
                $script:closeWaitStatus = 'manual_cancelled'
                $script:closeWaitCompleted = $true
                $form.Close()
            })
            $form.Controls.Add($label)
            $form.Controls.Add($cancel)

            $deadline = [DateTime]::UtcNow.AddSeconds([int]$p.timeoutSeconds)
            $timer.Interval = 250
            $timer.Add_Tick({
                $current = Get-WindowSnapshot $handle $monitors
                if ($null -eq $current) {
                    $script:closeWaitStatus = 'closed'
                    $script:closeWaitCompleted = $true
                    $form.Close()
                } elseif (-not (Test-WindowCloseTarget $current ([string]$p.windowId) ([Int64]$p.expectedProcessId) ([string]$p.expectedProcessStartKey) $expectedProcessName $expectedTitle)) {
                    $script:closeWaitStatus = 'target_changed'
                    $script:closeWaitCompleted = $true
                    $form.Close()
                } elseif ([DateTime]::UtcNow -ge $deadline) {
                    $script:closeWaitStatus = 'manual_timeout'
                    $script:closeWaitCompleted = $true
                    $form.Close()
                }
            })
            $form.Add_FormClosing({
                if (-not $script:closeWaitCompleted) {
                    $script:closeWaitStatus = 'manual_cancelled'
                    $script:closeWaitCompleted = $true
                }
            })
            $timer.Start()
            [void]$form.ShowDialog()
        } finally {
            $timer.Stop()
            $timer.Dispose()
            $form.Dispose()
        }
        [Console]::Out.Write((@{
            status = $script:closeWaitStatus; requested = $false;
            ownerPerformed = ($script:closeWaitStatus -eq 'closed'); windowId = [string]$p.windowId
        } | ConvertTo-Json -Compress))
    }
    'window-close-test' {
        # Test-only seam for the cooperative close observer. Production contains
        # no PostMessage/WM_CLOSE call, so every outcome has zero native sends.
        $p = Get-Content -Path $Arg1 -Raw | ConvertFrom-Json
        $matched = Test-WindowCloseTarget $p.snapshot ([string]$p.windowId) ([Int64]$p.expectedProcessId) ([string]$p.expectedProcessStartKey) ([string]$p.expectedProcessName) ([string]$p.expectedTitle)
        $status = if (-not $matched) { 'target_changed' }
            elseif ($null -eq $p.afterSnapshot) { 'closed' }
            elseif (Test-WindowCloseTarget $p.afterSnapshot ([string]$p.windowId) ([Int64]$p.expectedProcessId) ([string]$p.expectedProcessStartKey) ([string]$p.expectedProcessName) ([string]$p.expectedTitle)) { 'manual_timeout' }
            else { 'target_changed' }
        [Console]::Out.Write((@{ matched = [bool]$matched; status = $status; postMessageCalls = 0 } | ConvertTo-Json -Compress))
    }
    'capture-window' {
        $p = Get-Content -Path $Arg1 -Raw | ConvertFrom-Json
        if ([string]$p.expectedProcessId -notmatch '^[1-9][0-9]{0,9}$' -or [UInt64]$p.expectedProcessId -gt [UInt64][UInt32]::MaxValue -or [string]$p.expectedProcessStartKey -notmatch '^[0-9]{1,19}$') {
            throw 'expected process identity is invalid.'
        }
        $monitors = @(Get-DesktopMonitors)
        Add-Type -AssemblyName System.Drawing
        $handle = Get-WindowHandle ([string]$p.windowId)
        $before = Get-WindowSnapshot $handle $monitors
        if ($null -eq $before -or $before.processId -ne [int64]$p.expectedProcessId -or $before.processStartKey -ne [string]$p.expectedProcessStartKey) {
            [Console]::Out.Write((@{ status = 'target_changed'; method = 'printwindow_renderfullcontent'; window = $before; limitations = @('The HWND no longer belongs to the listed process identity, so no image was saved.') } | ConvertTo-Json -Compress -Depth 5))
            break
        }
        $stateLimitations = New-Object System.Collections.Generic.List[string]
        if ($before.isMinimized) { $stateLimitations.Add('The target is minimized. PrintWindow may return stale or incomplete content even when it succeeds.') }
        if ($before.isOffscreen) { $stateLimitations.Add('The target is fully off-screen. PrintWindow may return stale or incomplete content even when it succeeds.') }
        if ($before.isCloaked) { $stateLimitations.Add('The target is cloaked by Windows. PrintWindow may return stale or incomplete content even when it succeeds.') }
        $bmp = New-Object System.Drawing.Bitmap $before.width, $before.height
        try {
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            [IntPtr]$hdc = [IntPtr]::Zero
            try {
                $g.Clear([System.Drawing.Color]::Transparent)
                $hdc = $g.GetHdc()
                $rendered = [ToolsEnabledNativeWindow]::PrintWindow($handle, $hdc, 2)
            } finally {
                if ($hdc -ne [IntPtr]::Zero) { $g.ReleaseHdc($hdc) }
                $g.Dispose()
            }
            if (-not $rendered) {
                [Console]::Out.Write((@{ status = 'unavailable'; method = 'printwindow_renderfullcontent'; window = $before; limitations = @($stateLimitations.ToArray() + @('Windows refused PrintWindow background rendering. No visible-screen fallback was used.')) } | ConvertTo-Json -Compress -Depth 5))
                break
            }
            $after = Get-WindowSnapshot $handle $monitors
            if (-not (Test-SameWindowGeometry $before $after)) {
                [Console]::Out.Write((@{ status = 'target_changed'; method = 'printwindow_renderfullcontent'; window = $after; limitations = @('The target changed identity or size during rendering, so no image was saved.') } | ConvertTo-Json -Compress -Depth 5))
                break
            }
            $uniform = Test-BitmapSampledUniform $bmp
            $bmp.Save((Assert-CapturePath ([string]$p.path)), [System.Drawing.Imaging.ImageFormat]::Png)
            if ($uniform) {
                [Console]::Out.Write((@{ status = 'blank_or_uniform'; method = 'printwindow_renderfullcontent'; window = $after; width = $after.width; height = $after.height; limitations = @($stateLimitations.ToArray() + @('The rendered image is sampled-uniform. This can be a blank app surface, protected content, or a hardware overlay; the exact cause is not knowable from the bitmap.')) } | ConvertTo-Json -Compress -Depth 5))
            } else {
                [Console]::Out.Write((@{ status = 'captured'; method = 'printwindow_renderfullcontent'; window = $after; width = $after.width; height = $after.height; limitations = @($stateLimitations.ToArray()) } | ConvertTo-Json -Compress -Depth 5))
            }
        } finally { $bmp.Dispose() }
    }
    'thumbnail' {
        $p = Get-Content -Path $Arg1 -Raw | ConvertFrom-Json
        Add-Type -AssemblyName System.Drawing
        $source = [string]$p.source
        $target = [string]$p.path
        $maxWidth = [Math]::Min(1024, [Math]::Max(32, [int]$p.maxWidth))
        $maxHeight = [Math]::Min(1024, [Math]::Max(32, [int]$p.maxHeight))
        $image = [System.Drawing.Image]::FromFile($source)
        try {
            $scale = [Math]::Min(($maxWidth / [double]$image.Width), ($maxHeight / [double]$image.Height))
            $scale = [Math]::Min(1.0, $scale)
            $width = [Math]::Max(1, [int][Math]::Round($image.Width * $scale))
            $height = [Math]::Max(1, [int][Math]::Round($image.Height * $scale))
            $bitmap = New-Object System.Drawing.Bitmap $width, $height
            try {
                $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
                try {
                    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                    $graphics.DrawImage($image, 0, 0, $width, $height)
                    $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
                } finally { $graphics.Dispose() }
            } finally { $bitmap.Dispose() }
            [Console]::Out.Write((@{ status = 'captured'; width = $width; height = $height } | ConvertTo-Json -Compress))
        } finally { $image.Dispose() }
    }
    'ocr' {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        $null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
        $null = [Windows.Storage.Streams.RandomAccessStreamReference,Windows.Storage.Streams,ContentType=WindowsRuntime]
        $null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
        $null = [Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]
        $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime]
        $null = [Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
        $null = [Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
        $null = [Windows.Media.Ocr.OcrResult,Windows.Media.Ocr,ContentType=WindowsRuntime]
        $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Arg1)) ([Windows.Storage.StorageFile])
        $stream = Await-WinRt ([Windows.Storage.Streams.RandomAccessStreamReference]::CreateFromFile($file).OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        $createDecoder = @([Windows.Graphics.Imaging.BitmapDecoder].GetMethods() | Where-Object {
            $_.Name -eq 'CreateAsync' -and $_.GetParameters().Count -eq 1
        }) | Select-Object -First 1
        if ($null -eq $createDecoder) { throw 'Windows image decoding is unavailable.' }
        $decoder = Await-WinRt ($createDecoder.Invoke($null, @($stream))) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
        if ($null -eq $engine) { throw 'Windows OCR is unavailable because no OCR language is installed for this profile.' }
        $recognize = @([Windows.Media.Ocr.OcrEngine].GetMethods() | Where-Object {
            $_.Name -eq 'RecognizeAsync' -and $_.GetParameters().Count -eq 1
        }) | Select-Object -First 1
        if ($null -eq $recognize) { throw 'Windows OCR recognition is unavailable.' }
        $result = Await-WinRt ($recognize.Invoke($engine, @($bitmap))) ([Windows.Media.Ocr.OcrResult])
        [Console]::Out.Write((@{ text = [string]$result.Text; language = [string]$engine.RecognizerLanguage.LanguageTag } | ConvertTo-Json -Compress))
    }
    'tts' {
        $p = Get-Content -Path $Arg1 -Raw | ConvertFrom-Json
        Add-Type -AssemblyName System.Speech
        $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
            if ($p.voice) { $speaker.SelectVoice([string]$p.voice) }
            $speaker.Rate = [int]$p.rate
            $speaker.Volume = [int]$p.volume
            $speaker.Speak([string]$p.text)
        } finally { $speaker.Dispose() }
        [Console]::Out.Write('OK')
    }
    'sound' {
        $p = Get-Content -LiteralPath $Arg1 -Raw | ConvertFrom-Json
        Add-Type -AssemblyName System.Windows.Forms
        switch ([string]$p.sound) {
            'asterisk' { [System.Media.SystemSounds]::Asterisk.Play() }
            'beep' { [System.Media.SystemSounds]::Beep.Play() }
            'exclamation' { [System.Media.SystemSounds]::Exclamation.Play() }
            'hand' { [System.Media.SystemSounds]::Hand.Play() }
            'question' { [System.Media.SystemSounds]::Question.Play() }
            'generic-ramp' {
                # A short, generic four-tone alert with a bounded PCM amplitude
                # ramp. It respects the user's Windows output-volume setting and
                # never changes system volume or writes a sound file to disk.
                $sampleRate = 44100
                $toneMs = 170
                $gapMs = 45
                $frequencies = @(440.0, 554.37, 659.25, 880.0)
                $amplitudes = @(0.12, 0.24, 0.42, 0.68)
                $toneSamples = [int]($sampleRate * $toneMs / 1000)
                $gapSamples = [int]($sampleRate * $gapMs / 1000)
                $fadeSamples = [int]($sampleRate * 0.012)
                $samples = New-Object 'System.Collections.Generic.List[int16]'
                for ($tone = 0; $tone -lt $frequencies.Count; $tone++) {
                    for ($index = 0; $index -lt $toneSamples; $index++) {
                        $envelope = 1.0
                        if ($index -lt $fadeSamples) { $envelope = $index / [double]$fadeSamples }
                        elseif ($index -ge ($toneSamples - $fadeSamples)) { $envelope = ($toneSamples - 1 - $index) / [double]$fadeSamples }
                        $phase = 2.0 * [Math]::PI * $frequencies[$tone] * $index / $sampleRate
                        $value = [int16]([Math]::Round(32767.0 * $amplitudes[$tone] * $envelope * [Math]::Sin($phase)))
                        $samples.Add($value)
                    }
                    if ($tone -lt ($frequencies.Count - 1)) {
                        for ($index = 0; $index -lt $gapSamples; $index++) { $samples.Add([int16]0) }
                    }
                }
                $memory = New-Object System.IO.MemoryStream
                $writer = New-Object System.IO.BinaryWriter($memory)
                try {
                    $dataBytes = $samples.Count * 2
                    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
                    $writer.Write([int](36 + $dataBytes))
                    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('WAVE'))
                    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('fmt '))
                    $writer.Write([int]16)
                    $writer.Write([int16]1)
                    $writer.Write([int16]1)
                    $writer.Write([int]$sampleRate)
                    $writer.Write([int]($sampleRate * 2))
                    $writer.Write([int16]2)
                    $writer.Write([int16]16)
                    $writer.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
                    $writer.Write([int]$dataBytes)
                    foreach ($sample in $samples) { $writer.Write([int16]$sample) }
                    $writer.Flush()
                    $memory.Position = 0
                    $player = New-Object System.Media.SoundPlayer($memory)
                    try { $player.PlaySync() } finally { $player.Dispose() }
                } finally {
                    $writer.Dispose()
                    $memory.Dispose()
                }
            }
            default { throw 'sound is invalid.' }
        }
        [Console]::Out.Write('OK')
    }
    'ask' {
        $p = Get-Content -Path $Arg1 -Raw | ConvertFrom-Json
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $form = New-Object System.Windows.Forms.Form
        $script:answer = 'timeout'
        $timer = New-Object System.Windows.Forms.Timer
        try {
            $form.Text = [string]$p.title
            $form.Size = New-Object System.Drawing.Size 660, 460
            $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
            $form.TopMost = $true
            $form.ShowInTaskbar = $true
            $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
            $form.MaximizeBox = $false
            $form.MinimizeBox = $false
            $label = New-Object System.Windows.Forms.TextBox
            $label.Location = New-Object System.Drawing.Point 18, 18
            $label.Size = New-Object System.Drawing.Size 608, 340
            $label.Text = [string]$p.message
            $label.Multiline = $true
            $label.ReadOnly = $true
            $label.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
            $label.WordWrap = $true
            $form.Controls.Add($label)
            $yes = New-Object System.Windows.Forms.Button
            $yes.Text = 'Yes'; $yes.Location = New-Object System.Drawing.Point 536, 375; $yes.Size = New-Object System.Drawing.Size 90, 30
            $no = New-Object System.Windows.Forms.Button
            $no.Text = 'No'; $no.Location = New-Object System.Drawing.Point 430, 375; $no.Size = New-Object System.Drawing.Size 90, 30
            $yes.Add_Click({ $script:answer = 'yes'; $form.Close() })
            $no.Add_Click({ $script:answer = 'no'; $form.Close() })
            $form.AcceptButton = $no; $form.CancelButton = $no
            $form.Controls.Add($yes); $form.Controls.Add($no)
            $timer.Interval = [Math]::Min(900000, [Math]::Max(5000, ([int]$p.timeoutSeconds * 1000)))
            $timer.Add_Tick({ $script:answer = 'timeout'; $form.Close() })
            $timer.Start()
            # THE APPROVAL PROMPT MUST ACTUALLY BE ON THE SCREEN.
            #
            # MEASURED 2026-08-11 on the packaged build: this dialog was created
            # but never shown, so every approval-gated external write raised an
            # invisible window, waited its full timeout, and was recorded as
            # DENIED. The owner was never asked. `Activate()` alone could not fix
            # it, because the window was not visible to begin with.
            #
            # THE CAUSE IS THE CALLER, WHICH IS WHY THE FIX IS HERE. Every helper
            # invocation goes through run() in src/lib/runtime.js, which spawns
            # with `windowsHide: true` to stop a console flashing for each short
            # helper -- correct for the fifteen verbs above, and fatal for this
            # one. On Windows that sets STARTF_USESHOWWINDOW with SW_HIDE, and a
            # process's FIRST top-level window inherits that show state. WinForms
            # honours it, so ShowDialog() displayed nothing.
            #
            # Fixing it in the caller would mean the one visible verb having to
            # be remembered at a boundary shared by everything, so this window
            # asserts its own visibility instead: SW_SHOW overrides the inherited
            # hidden state, and it is harmless when the state was never hidden.
            # A confirmation prompt is the last place to rely on a default.
            # The interop type is compiled BEFORE the form exists, not inside the
            # Shown handler. Add-Type inside a WinForms event handler is compiled
            # while the message pump is running, and under $ErrorActionPreference
            # = 'Stop' any hiccup there tears down the dialog instead of the
            # handler: measured, the prompt closed after ~2s with no controls
            # realised. Compiling first keeps the handler to two static calls.
            Add-WindowInterop
            $form.Add_Shown({
                [void][ToolsEnabledNativeWindow]::ShowWindowAsync($form.Handle, 5) # SW_SHOW
                [void][ToolsEnabledNativeWindow]::SetForegroundWindow($form.Handle)
                $form.Activate()
            })
            [void]$form.ShowDialog()
        } finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
        [Console]::Out.Write($script:answer)
    }
}
