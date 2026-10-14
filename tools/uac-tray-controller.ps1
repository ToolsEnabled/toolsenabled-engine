# Owner-operated Windows tray icon that toggles Full UAC Bypass on and off.
# Q96 / owner request R1022, verbatim: "make another version that controls
# uac full bypass so i can turn it on and off" ... "forget the 24h thing
# completely, instead send the full icon buildout to the qeue".
#
# WHAT "FULL UAC BYPASS" MEANS HERE. This is Windows' OWN on/off switch --
# the EnableLUA policy value under
# HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System. ON means
# EnableLUA=0: Windows stops prompting for elevation at all, machine-wide.
# OFF (the default) means EnableLUA=1: normal Windows UAC protection. This is
# a SEPARATE, far more permissive posture than
# config\uac-delegation-allowlist.json's fixed-allowlist actuator
# (src\lib\uac-delegation.js), which deliberately keeps Windows UAC fully ON
# and only lets a narrow, owner-authored list of operations run without a
# prompt reaching the owner. This script is never added to that allowlist and
# never talks to its named-pipe helper -- see the "WHY NOT THE ALLOWLIST"
# note below.
#
# NO TIMED OR AUTOMATIC BEHAVIOR, ANYWHERE IN THIS FILE. No timer, no
# schedule, no expiry, no auto-revert, no polling loop. The owner explicitly
# retracted an earlier 24-hour-expiry idea ("forget the 24h thing
# completely"); this script does not implement one, or anything like one.
# Status is only ever recomputed on demand -- when the tray menu is opened or
# right after a toggle -- never on a timer. grep for "Forms.Timer" in this
# file: there is none, on purpose.
#
# WHY NOT THE ALLOWLIST. config\uac-delegation-allowlist.json's own header
# says it is "a closed, owner-curated list of standing elevated capabilities"
# and that "nothing else is added without a new owner decision" / "an agent
# must not widen its own elevated surface beyond what was authorized" --
# tools\link-bus-firewall.ps1 already documents the same reasoning for its
# own one-off elevation. Adding a Full UAC Bypass operation there would let
# the always-on named-pipe helper flip Windows' own UAC posture without the
# owner ever seeing a prompt, which is exactly what R1022 asked NOT to build
# ("the toggle state must be an owner-side control", never agent-writable).
#
# THE ACTUAL SAFETY MECHANISM. Every toggle click below runs
# `Start-Process -Verb RunAs`, which pops one native Windows UAC consent
# dialog. Only the owner's own physical click on that OS-rendered dialog can
# approve it -- nothing in this repo, no agent process, and no stored
# credential is in that loop. That is what makes the posture owner-side by
# construction rather than by policy: it cannot become agent-writable no
# matter what compromises the rest of this codebase.
#
# ENFORCEMENT-POINT INTEGRATION. Immediately before every registry write
# (elevated branch below), this script calls into the SAME
# src\lib\uac-delegation.js used by the fixed-allowlist actuator, for two
# things only: (1) the SAME kill switch every other elevated path in this
# repo already respects (src\lib\kill-switch.js) -- if it is engaged, the
# registry is never touched; (2) a signed decision audit BEFORE the effect
# and a best-effort outcome audit AFTER it, in the SAME tamper-evident ledger
# (src\lib\audit.js) as every other elevated action, using the exact
# gate-then-audit-then-effect ordering handleRequest() uses for the
# fixed-allowlist path. Node is invoked as a one-shot child process (its
# script piped over stdin, arguments passed positionally -- see
# Invoke-FullBypassDecision / Invoke-FullBypassOutcomeAudit below); if Node
# is unavailable, the toggle fails closed and the registry is never touched.
#
# RESTART-REQUIRED, HONESTLY. Windows only re-reads EnableLUA at boot, so a
# toggle does not take live effect until the owner restarts. This script
# never restarts Windows itself (agents/scripts do not get to reboot the
# owner's machine -- STANDING-ORDERS.md's restart authority explicitly
# excludes "the pc"). It only tells the truth about pending-restart state, by
# comparing the last applied-write timestamp (state\uac-full-bypass-state.json)
# against the machine's actual last boot time -- never by trusting its own
# stored intent, per this project's Bucket-A doctrine ("every control's
# displayed state must be read back from what's actually enforced").
#
# ASCII only. PowerShell 5.1 misparses this file if it picks up non-ASCII
# punctuation such as an em dash.
#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Elevated,
    [ValidateSet('on', 'off')]
    [string]$SetBypass
)

$ErrorActionPreference = 'Stop'

$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$StateFile = Join-Path $Root 'state\uac-full-bypass-state.json'
$RegPolicyPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$RegValueName = 'EnableLUA'

# Fixed, absolute, signature-verified target for every elevation -- never a
# bare 'powershell.exe' resolved off PATH. Same verification
# the reviewed elevated-action launcher applies for the same
# reason: a tampered PATH must not be able to redirect an elevated launch.
$SystemPowerShell = [IO.Path]::GetFullPath('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe')
$powerShellItem = Get-Item -LiteralPath $SystemPowerShell -Force -ErrorAction Stop
if ($powerShellItem.PSIsContainer -or
    ($powerShellItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
    -not $powerShellItem.FullName.Equals($SystemPowerShell, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'UAC_TRAY_POWERSHELL_PATH_INVALID'
}
$powerShellSignature = Get-AuthenticodeSignature -LiteralPath $SystemPowerShell
if ([string]$powerShellSignature.Status -ne 'Valid' -or
    [string]$powerShellSignature.SignerCertificate.Subject -notmatch '(^|, )CN=Microsoft Windows(,|$)' -or
    [string]$powerShellSignature.SignerCertificate.Subject -notmatch '(^|, )O=Microsoft Corporation(,|$)') {
    throw 'UAC_TRAY_POWERSHELL_SIGNATURE_INVALID'
}

# --- registry read (never requires elevation) --------------------------------

function Get-EnableLuaValue {
    try {
        $prop = Get-ItemProperty -Path $RegPolicyPath -Name $RegValueName -ErrorAction Stop
        return [int]$prop.$RegValueName
    } catch {
        return $null
    }
}

function Get-FullBypassStatus {
    $enableLua = Get-EnableLuaValue
    $known = ($null -ne $enableLua)
    $bypassOn = ($known -and $enableLua -eq 0)

    $bootTimeUtc = $null
    try { $bootTimeUtc = (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime() } catch { $bootTimeUtc = $null }

    $state = $null
    if (Test-Path -LiteralPath $StateFile) {
        try { $state = Get-Content -LiteralPath $StateFile -Raw -ErrorAction Stop | ConvertFrom-Json } catch { $state = $null }
    }

    $restartRequired = $false
    $pendingState = $null
    if ($state -and $state.appliedAtUtc -and $bootTimeUtc) {
        try {
            $appliedAtUtc = [datetime]::Parse([string]$state.appliedAtUtc, [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal)
            # The applied write is still pending exactly when it happened
            # AFTER the machine's current boot -- Windows has not read the
            # new value yet. A reboot since then means it already has.
            if ($appliedAtUtc -gt $bootTimeUtc) {
                $restartRequired = $true
                $pendingState = [string]$state.requestedState
            }
        } catch { }
    }

    $label =
        if (-not $known) { 'Full UAC Bypass: UNKNOWN (registry unreadable)' }
        elseif ($bypassOn -and $restartRequired -and $pendingState -eq 'off') { 'Full UAC Bypass: ON now (turning OFF - restart required)' }
        elseif ($bypassOn) { 'Full UAC Bypass: ON - UAC prompts are disabled machine-wide' }
        elseif ($restartRequired -and $pendingState -eq 'on') { 'Full UAC Bypass: OFF now (turning ON - restart required)' }
        else { 'Full UAC Bypass: OFF - UAC is protecting this machine (default)' }

    $targetState = if ($bypassOn) { 'off' } else { 'on' }
    $targetLabel = if ($bypassOn) { 'Turn Full UAC Bypass OFF (restore UAC protection)...' } else { 'Turn Full UAC Bypass ON (disable UAC machine-wide)...' }
    $iconColor = if (-not $known) { 'gray' } elseif ($bypassOn) { 'red' } else { 'green' }

    return [pscustomobject]@{
        known = $known
        enableLua = $enableLua
        bypassOn = $bypassOn
        restartRequired = $restartRequired
        pendingState = $pendingState
        label = $label
        targetState = $targetState
        targetLabel = $targetLabel
        iconColor = $iconColor
    }
}

function Write-BypassStateFile {
    param(
        [Parameter(Mandatory)][ValidateSet('on', 'off')][string]$RequestedState,
        [Parameter(Mandatory)][int]$AppliedEnableLua
    )
    $stateDir = Split-Path -Parent $StateFile
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    # Non-secret status metadata, not a security boundary: the live registry
    # read above is always the source of truth for whether the bypass is
    # actually on, this file only remembers "was a write applied since the
    # last boot" for the honest restart-required note. No ACL is required for
    # that to be safe -- worst case of a tampered file is a wrong tooltip,
    # never a wrong enforced posture.
    $record = [ordered]@{
        schemaVersion = 1
        requestedState = $RequestedState
        appliedEnableLua = $AppliedEnableLua
        appliedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    }
    $temp = "$StateFile.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    $json = ($record | ConvertTo-Json -Compress)
    [IO.File]::WriteAllText($temp, "$json`n", [Text.Encoding]::UTF8)
    Move-Item -LiteralPath $temp -Destination $StateFile -Force
}

# --- Node integration point (elevated branch only) ---------------------------
# These two functions are the ONLY place this script talks to Node, and Node
# is only ever invoked from the elevated branch, immediately before (decision)
# and immediately after (outcome) the one registry write. Script text is
# piped over stdin (`node -`), arguments passed positionally on argv -- no
# string concatenation into a shell command line, no caller text interpolated
# into the JS source.

# Windows PowerShell 5.1 silently DROPS an empty-string argument when calling
# a native executable -- verified: `& node.exe - 'a' '' 'c'` delivers argv
# ["a","c"], not ["a","","c"], shifting every later positional argument by
# one. That is a correctness bug waiting to happen for any all-positional
# argv protocol like the one below (it corrupted an early draft of
# Invoke-FullBypassOutcomeAudit: a null AppliedEnableLua produced an empty
# $appliedText, which vanished and shifted the sanitized error message into
# the wrong argv slot). The verified fix is the literal two-character string
# '""', which Windows' own argv parser -- and therefore Node -- receives as a
# real empty string in the correct position.
function ConvertTo-NativeArg {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { return '""' }
    return $Value
}

function Invoke-FullBypassDecision {
    param([Parameter(Mandatory)][ValidateSet('on', 'off')][string]$RequestedState)
    $js = @'
"use strict";
const path = require("node:path");
const root = process.argv[2];
const requestedState = process.argv[3];
const mod = require(path.join(root, "src", "lib", "uac-delegation"));
let decision = "accept";
let reason = "allowed";
try {
    mod.checkFullBypassAllowed();
} catch (err) {
    decision = "refuse";
    reason = (err && err.code === "UAC_FULL_BYPASS_BLOCKED") ? "killswitch" : "error";
}
let principal = null;
try { principal = mod.ownerPrincipal(); } catch (e) { principal = null; }
mod.auditFullBypassDecision({ requestedState: requestedState, decision: decision, reason: reason, principal: principal });
process.stdout.write(JSON.stringify({ decision: decision, reason: reason }));
process.exit(decision === "accept" ? 0 : 3);
'@
    $stdout = $js | & $script:NodeExe - (ConvertTo-NativeArg $Root) (ConvertTo-NativeArg $RequestedState)
    $code = $LASTEXITCODE
    $parsed = $null
    if ($stdout) { try { $parsed = ($stdout | Select-Object -Last 1) | ConvertFrom-Json } catch { $parsed = $null } }
    return [pscustomobject]@{
        exitCode = $code
        decision = if ($parsed) { [string]$parsed.decision } else { 'error' }
        reason = if ($parsed) { [string]$parsed.reason } else { 'decision_check_unreadable' }
    }
}

function Invoke-FullBypassOutcomeAudit {
    param(
        [Parameter(Mandatory)][ValidateSet('on', 'off')][string]$RequestedState,
        [Parameter(Mandatory)][bool]$Ok,
        [AllowNull()][object]$AppliedEnableLua,
        [AllowNull()][string]$ErrorMessage
    )
    $js = @'
"use strict";
const path = require("node:path");
const root = process.argv[2];
const requestedState = process.argv[3];
const ok = process.argv[4] === "true";
const appliedRaw = process.argv[5] || "";
const appliedEnableLua = appliedRaw === "" ? null : Number(appliedRaw);
const errorMessage = process.argv[6] || null;
const mod = require(path.join(root, "src", "lib", "uac-delegation"));
mod.auditFullBypassOutcome({ requestedState: requestedState, ok: ok, appliedEnableLua: appliedEnableLua, error: errorMessage });
process.stdout.write("OK");
'@
    $okText = if ($Ok) { 'true' } else { 'false' }
    $appliedText = if ($null -ne $AppliedEnableLua) { [string]$AppliedEnableLua } else { '' }
    $sanitizedError = ''
    if ($ErrorMessage) {
        $sanitizedError = ($ErrorMessage -replace '[\r\n]+', ' ')
        if ($sanitizedError.Length -gt 300) { $sanitizedError = $sanitizedError.Substring(0, 300) }
    }
    $null = $js | & $script:NodeExe - (ConvertTo-NativeArg $Root) (ConvertTo-NativeArg $RequestedState) (ConvertTo-NativeArg $okText) (ConvertTo-NativeArg $appliedText) (ConvertTo-NativeArg $sanitizedError)
}

# ===============================================================================
# ELEVATED BRANCH: runs once per toggle, inside the RunAs-consented child
# process the tray branch below launches. Does exactly one thing: gate, audit,
# write the ONE registry value, record the outcome. No tray UI here.
# ===============================================================================
if ($Elevated) {
    if (-not $SetBypass) { throw 'UAC_TRAY_SETBYPASS_REQUIRED' }

    $currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'UAC_TRAY_NOT_ELEVATED'
    }

    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) {
        # Fail closed: without Node, neither the shared kill-switch check nor
        # the signed audit trail can run, so the registry is not touched.
        exit 5
    }
    $script:NodeExe = $nodeCommand.Source

    $decisionResult = Invoke-FullBypassDecision -RequestedState $SetBypass
    if ($decisionResult.decision -ne 'accept') {
        # Refused (kill switch engaged, or the decision audit itself could
        # not be written) -- the registry is never touched. The non-elevated
        # parent notices nothing changed when it re-reads the live value.
        exit 3
    }

    $desiredEnableLua = if ($SetBypass -eq 'on') { 0 } else { 1 }
    $ok = $false
    $errorMessage = $null
    try {
        Set-ItemProperty -Path $RegPolicyPath -Name $RegValueName -Value $desiredEnableLua -Type DWord -Force -ErrorAction Stop
        Write-BypassStateFile -RequestedState $SetBypass -AppliedEnableLua $desiredEnableLua
        $ok = $true
    } catch {
        $errorMessage = $_.Exception.Message
    }

    $appliedArg = if ($ok) { $desiredEnableLua } else { $null }
    Invoke-FullBypassOutcomeAudit -RequestedState $SetBypass -Ok $ok -AppliedEnableLua $appliedArg -ErrorMessage $errorMessage

    if ($ok) { exit 0 } else { exit 4 }
}

# ===============================================================================
# TRAY BRANCH: the always-visible, owner-clickable icon. Everything here is
# read-only except the one Start-Process -Verb RunAs call the toggle item
# makes. No background timer anywhere in this branch.
# ===============================================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

try {
    Add-Type -Namespace ToolsEnabledUacTray -Name IconApi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool DestroyIcon(System.IntPtr handle);
'@
} catch { }

[System.Windows.Forms.Application]::EnableVisualStyles()

function New-StatusIcon {
    param([ValidateSet('green', 'red', 'gray')][string]$Color)
    $rgb =
        switch ($Color) {
            'green' { [System.Drawing.Color]::FromArgb(255, 46, 160, 67) }
            'red' { [System.Drawing.Color]::FromArgb(255, 218, 54, 51) }
            default { [System.Drawing.Color]::FromArgb(255, 140, 140, 140) }
        }
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $hIcon = [IntPtr]::Zero
    try {
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $g.Clear([System.Drawing.Color]::Transparent)
            $brush = New-Object System.Drawing.SolidBrush $rgb
            try { $g.FillEllipse($brush, 3, 3, 26, 26) } finally { $brush.Dispose() }
            $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(160, 0, 0, 0)), 1.5
            try { $g.DrawEllipse($pen, 3, 3, 26, 26) } finally { $pen.Dispose() }
        } finally { $g.Dispose() }
        $hIcon = $bmp.GetHicon()
        $liveIcon = [System.Drawing.Icon]::FromHandle($hIcon)
        $owned = $liveIcon.Clone()
        return $owned
    } finally {
        if ($hIcon -ne [IntPtr]::Zero) {
            try { [ToolsEnabledUacTray.IconApi]::DestroyIcon($hIcon) | Out-Null } catch { }
        }
        $bmp.Dispose()
    }
}

$script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$script:contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
$script:statusItem = New-Object System.Windows.Forms.ToolStripMenuItem('Full UAC Bypass: checking...')
$script:statusItem.Enabled = $false
$script:restartNoticeItem = New-Object System.Windows.Forms.ToolStripMenuItem('Restart Windows to finish applying the last change')
$script:restartNoticeItem.Enabled = $false
$script:restartNoticeItem.Visible = $false
$script:toggleItem = New-Object System.Windows.Forms.ToolStripMenuItem('Toggle')
$script:exitItem = New-Object System.Windows.Forms.ToolStripMenuItem('Exit')

[void]$script:contextMenu.Items.Add($script:statusItem)
[void]$script:contextMenu.Items.Add($script:restartNoticeItem)
[void]$script:contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$script:contextMenu.Items.Add($script:toggleItem)
[void]$script:contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$script:contextMenu.Items.Add($script:exitItem)

$script:notifyIcon.ContextMenuStrip = $script:contextMenu
$script:notifyIcon.Text = 'ToolsEnabled: Full UAC Bypass'
$script:notifyIcon.Visible = $true

function Show-Balloon {
    param(
        [Parameter(Mandatory)][string]$Title,
        [Parameter(Mandatory)][string]$Message,
        [ValidateSet('Info', 'Warning', 'Error', 'None')][string]$Icon = 'Info'
    )
    $script:notifyIcon.BalloonTipTitle = $Title
    $script:notifyIcon.BalloonTipText = $Message
    $script:notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::$Icon
    $script:notifyIcon.ShowBalloonTip(5000)
}

# Recomputes status ONLY when called -- from the menu Opening event and right
# after a toggle attempt. Never from a timer.
function Update-TrayState {
    $status = Get-FullBypassStatus
    $oldIcon = $script:notifyIcon.Icon
    $script:notifyIcon.Icon = New-StatusIcon -Color $status.iconColor
    if ($oldIcon) { try { $oldIcon.Dispose() } catch { } }

    $shortTip =
        switch ($status.iconColor) {
            'green' { 'Full UAC Bypass: OFF (protected)' }
            'red' { 'Full UAC Bypass: ON (bypassed)' }
            default { 'Full UAC Bypass: status unknown' }
        }
    if ($status.restartRequired) { $shortTip = "$shortTip - restart pending" }
    if ($shortTip.Length -gt 63) { $shortTip = $shortTip.Substring(0, 63) }
    $script:notifyIcon.Text = $shortTip

    $script:statusItem.Text = $status.label
    $script:toggleItem.Text = $status.targetLabel
    $script:restartNoticeItem.Visible = [bool]$status.restartRequired
    return $status
}

$script:contextMenu.add_Opening({ [void](Update-TrayState) })

$script:toggleItem.add_Click({
    $before = Update-TrayState
    $target = $before.targetState
    $proc = $null
    try {
        $proc = Start-Process -FilePath $SystemPowerShell -Verb RunAs -WindowStyle Hidden -WorkingDirectory $Root `
            -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Elevated', '-SetBypass', $target) `
            -PassThru
    } catch {
        # The owner did not approve the native UAC dialog (or it could not be
        # shown). This is a normal, expected outcome, not a failure to
        # investigate -- nothing was touched.
        Show-Balloon -Title 'Full UAC Bypass' -Message 'The UAC prompt was not approved. Nothing was changed.' -Icon Warning
        return
    }
    if (-not $proc) {
        Show-Balloon -Title 'Full UAC Bypass' -Message 'The elevated step did not start. Nothing was changed.' -Icon Warning
        return
    }
    $proc.WaitForExit()
    # Truth comes from re-reading the live registry, never from the elevated
    # child's exit code alone -- matches Bucket-A doctrine (displayed state
    # is read back from what is actually enforced).
    $after = Update-TrayState
    if ($after.bypassOn -eq ($target -eq 'on')) {
        $msg = if ($target -eq 'on') { 'Full UAC Bypass turned ON.' } else { 'Full UAC Bypass turned OFF (UAC protection restored).' }
        if ($after.restartRequired) { $msg = "$msg Restart Windows for this to take effect." }
        Show-Balloon -Title 'Full UAC Bypass' -Message $msg -Icon Info
    } else {
        Show-Balloon -Title 'Full UAC Bypass' -Message 'The toggle did not apply (still unchanged). It may have been blocked by the kill switch -- check the audit log.' -Icon Warning
    }
})

$script:exitItem.add_Click({
    $script:notifyIcon.Visible = $false
    $script:notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

[void](Update-TrayState)

$appContext = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($appContext)
