# Native Windows UI only. Queue claims, recovery and drain policy live in
# src/lib/owner-prompt-runner.js on both supported operating systems.
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('native-ui')][string]$Action,
    [Parameter(Mandatory = $true)][string]$InputFile,
    [Parameter(Mandatory = $true)][int]$ParentPid
)
$ErrorActionPreference = 'Stop'

# Shared owner-prompt visual identity. These dialogs previously carried their
# own lavender palette that matched neither the product nor the credential
# form; a third hand-picked palette is the same drift, one surface further on.
. (Join-Path $PSScriptRoot 'owner-prompt-theme.ps1')
$script:OwnerPromptThemeResult = Get-OwnerPromptTheme
$script:OPT = $script:OwnerPromptThemeResult.Theme
$script:cBg = ConvertTo-OwnerPromptColor $script:OPT.bg
$script:cBg2 = ConvertTo-OwnerPromptColor $script:OPT.bg2
$script:cSheet = ConvertTo-OwnerPromptColor $script:OPT.sheet
$script:cInk = ConvertTo-OwnerPromptColor $script:OPT.ink
$script:cInk2 = ConvertTo-OwnerPromptColor $script:OPT.ink2
$script:cInk3 = ConvertTo-OwnerPromptColor $script:OPT.ink3
$script:cAccent = ConvertTo-OwnerPromptColor $script:OPT.accent
# accentFloor carries button fills: white on accent is 3.89:1, under the 4.5:1
# a label needs. See tests/owner-prompt-theme.test.js.
$script:cAccentFloor = ConvertTo-OwnerPromptColor $script:OPT.accentFloor
$script:cOnAccent = ConvertTo-OwnerPromptColor $script:OPT.onAccent
$script:cLine = ConvertTo-OwnerPromptColor -Token $script:OPT.line2 -OverBase $script:OPT.bg
$SecretsScript = Join-Path $PSScriptRoot 'secrets.ps1'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# The Node launcher deliberately hides its console host (launchSpec passes
# windowsHide, and the native-ui child is spawned the same way). A dialog owned
# by that hidden console can stay invisible while ShowDialog blocks, which the
# credential form already solves with ToolsEnabled.CredentialPromptWindow in
# tools/secrets.ps1. The start dialog is launched exactly the same way and
# needs the same explicit restore/show; without it the owner is waited on by a
# window nobody can see.
if ($null -eq ('ToolsEnabled.OwnerPromptQueueWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ToolsEnabled {
    public static class OwnerPromptQueueWindow {
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetWindowPos(
            IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        public static void Present(IntPtr hWnd) {
            const uint SWP_NOSIZE = 0x0001;
            const uint SWP_NOMOVE = 0x0002;
            const uint SWP_SHOWWINDOW = 0x0040;
            ShowWindow(hWnd, 9); // SW_RESTORE
            SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW);
            SetForegroundWindow(hWnd);
        }
    }
}
'@
}

function Invoke-NativeOwnerCapture($Request, [scriptblock]$InvokeForm) {
    # Console.Out writes bypass PowerShell's success stream. Capture both
    # exactly as the maintained vault host does, then return only safe metadata.
    $capture = New-Object System.IO.StringWriter
    $realOut = [Console]::Out
    $output = $null
    try {
        [Console]::SetOut($capture)
        $arguments = @{ Action = 'prompt-set'; Key = [string]$Request.key; PromptLabel = [string]$Request.label }
        if ($Request.kind -eq 'payment_card') { $arguments.Action = 'prompt-payment-card' }
        $promptHint = [string]$Request.message
        if ($Request.kind -eq 'credential' -and -not [string]::IsNullOrWhiteSpace($promptHint)) { $arguments.PromptHint = $promptHint }
        if ($null -eq $InvokeForm) { $null = & $SecretsScript @arguments }
        else { $null = & $InvokeForm @arguments }
        $output = $capture.ToString()
    } finally {
        [Console]::SetOut($realOut)
        $capture.Dispose(); $capture = $null
    }
    try {
        if ([string]::IsNullOrWhiteSpace($output) -or $output.Length -gt 4096) { throw 'Invalid private form result.' }
        $parsed = ($output | ConvertFrom-Json -ErrorAction Stop)
        $shape = @($parsed.PSObject.Properties.Name | Sort-Object) -join ','
        if ($parsed.status -in @('created', 'updated', 'in_progress')) {
            if ($shape -ne 'key,status' -or $parsed.key -ne $Request.key) { throw 'Invalid private form result.' }
        } elseif ($parsed.status -eq 'cancelled') {
            if ($shape -ne 'status') { throw 'Invalid private form result.' }
        } else { throw 'Invalid private form result.' }
        return $parsed
    } finally { $output = $null }
}

function Show-OwnerFailureDialog([string]$Message) {
    try {
        $form = New-Object System.Windows.Forms.Form
        $form.Text = 'ToolsEnabled - stopped safely'
        $form.StartPosition = 'CenterScreen'
        $form.TopMost = $true
        $form.ShowInTaskbar = $true
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
        $form.MaximizeBox = $false; $form.MinimizeBox = $false
        $form.ClientSize = New-Object System.Drawing.Size(520, 220)
        $form.BackColor = $script:cBg
        $form.ForeColor = $script:cInk
        $form.Font = (Get-OwnerPromptFont 9.75)

        $hero = New-Object System.Windows.Forms.Panel
        $hero.Location = New-Object System.Drawing.Point(0, 0)
        $hero.Size = New-Object System.Drawing.Size(520, 70)
        $hero.BackColor = $script:cSheet
        $form.Controls.Add($hero)

        $title = New-Object System.Windows.Forms.Label
        $title.Location = New-Object System.Drawing.Point(18, 18)
        $title.Size = New-Object System.Drawing.Size(480, 34)
        $title.Text = 'We stopped safely'
        $title.ForeColor = $script:cInk
        $title.Font = (Get-OwnerPromptFont 16)
        $hero.Controls.Add($title)

        $body = New-Object System.Windows.Forms.Label
        $body.Location = New-Object System.Drawing.Point(20, 94)
        $body.Size = New-Object System.Drawing.Size(480, 62)
        $body.Text = "$Message`r`nNothing was saved or sent. You can try again when you are ready."
        $body.ForeColor = $script:cInk2
        $form.Controls.Add($body)

        $close = New-Object System.Windows.Forms.Button
        $close.Text = 'Close'
        $close.Location = New-Object System.Drawing.Point(420, 174)
        $close.Size = New-Object System.Drawing.Size(80, 30)
        $close.DialogResult = [System.Windows.Forms.DialogResult]::OK
        $form.Controls.Add($close)
        $form.AcceptButton = $close
        $form.Add_Shown({
            $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
            [ToolsEnabled.OwnerPromptQueueWindow]::Present($form.Handle)
            $form.Activate(); $form.BringToFront()
        })
        Set-OwnerPromptDialogScale $form
        [void]$form.ShowDialog()
        $form.Dispose()
    } catch { }
}

function Invoke-OwnerPromptAttentionSound {
    # A queued owner step can be launched from a hidden child PowerShell, so
    # the visible start dialog needs one non-text cue. Guard it in-process:
    # replayed queue entries and any future re-show must stay calm and produce
    # exactly one notification for this prompt batch.
    if ($script:OwnerPromptAttentionSoundPlayed) { return }
    $script:OwnerPromptAttentionSoundPlayed = $true
    try {
        [System.Media.SystemSounds]::Exclamation.Play()
    } catch {
        try { [Console]::Beep(880, 180) } catch { }
    }
}

function Show-StartDialog([int]$Count, $NextItem) {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'ToolsEnabled - a calm owner step'
    $form.StartPosition = 'CenterScreen'
    $form.TopMost = $true
    $form.ShowInTaskbar = $true
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false; $form.MinimizeBox = $false; $form.ControlBox = $false
    $form.ClientSize = New-Object System.Drawing.Size(560, 410)
    $form.BackColor = $script:cBg
    $form.ForeColor = $script:cInk
    $form.Font = (Get-OwnerPromptFont 9.75)

    $hero = New-Object System.Windows.Forms.Panel
    $hero.Location = New-Object System.Drawing.Point(0, 0)
    $hero.Size = New-Object System.Drawing.Size(560, 82)
    $hero.BackColor = $script:cSheet
    $form.Controls.Add($hero)

    $eyebrow = New-Object System.Windows.Forms.Label
    $eyebrow.Location = New-Object System.Drawing.Point(20, 12)
    $eyebrow.Size = New-Object System.Drawing.Size(520, 18)
    $eyebrow.Text = 'TOOLSENABLED  /  YOU ARE IN CONTROL'
    $eyebrow.ForeColor = $script:cAccent
    $eyebrow.Font = (Get-OwnerPromptFont 8 ([System.Drawing.FontStyle]::Bold))
    $hero.Controls.Add($eyebrow)

    $title = New-Object System.Windows.Forms.Label
    $title.Location = New-Object System.Drawing.Point(18, 30)
    $title.Size = New-Object System.Drawing.Size(522, 38)
    $title.Text = 'A quiet, one-at-a-time check-in'
    $title.ForeColor = $script:cInk
    $title.Font = (Get-OwnerPromptFont 16)
    $hero.Controls.Add($title)

    $summary = New-Object System.Windows.Forms.Label
    $summary.Location = New-Object System.Drawing.Point(22, 102)
    $summary.Size = New-Object System.Drawing.Size(516, 42)
    $summaryText = if ($Count -eq 1) { 'One private step is ready when you are.' } else { "$Count private steps are ready, one at a time." }
    $summary.Text = "$summaryText`r`nYou can pause or stop at any point; nothing is sent to chat."
    $summary.ForeColor = $script:cInk2
    $form.Controls.Add($summary)

    $details = New-Object System.Windows.Forms.Panel
    $details.Location = New-Object System.Drawing.Point(22, 154)
    $details.Size = New-Object System.Drawing.Size(516, 146)
    $details.BackColor = $script:cBg2
    $details.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
    $form.Controls.Add($details)

    $detailsTitle = New-Object System.Windows.Forms.Label
    $detailsTitle.Location = New-Object System.Drawing.Point(14, 12)
    $detailsTitle.Size = New-Object System.Drawing.Size(486, 20)
    $detailsTitle.Text = 'What this request is for'
    $detailsTitle.Font = (Get-OwnerPromptFont 9 ([System.Drawing.FontStyle]::Bold))
    $detailsTitle.ForeColor = $script:cInk
    $details.Controls.Add($detailsTitle)

    $detailsBody = New-Object System.Windows.Forms.Label
    $detailsBody.Location = New-Object System.Drawing.Point(14, 38)
    $detailsBody.Size = New-Object System.Drawing.Size(486, 94)
    $contextHint = [string]$NextItem.message
    $detailsBody.Text = if ([string]::IsNullOrWhiteSpace($contextHint)) {
        'This is a local owner-only step. The next screen will explain exactly what is needed.'
    } else { $contextHint }
    $detailsBody.ForeColor = $script:cInk2
    $details.Controls.Add($detailsBody)

    $comfort = New-Object System.Windows.Forms.Label
    $comfort.Location = New-Object System.Drawing.Point(22, 314)
    $comfort.Size = New-Object System.Drawing.Size(516, 28)
    $comfort.Text = 'Nothing opens until you choose Begin securely. Not now leaves the vault unchanged.'
    $comfort.ForeColor = $script:cInk3
    $form.Controls.Add($comfort)

    $start = New-Object System.Windows.Forms.Button
    $start.Text = 'Begin securely'; $start.Location = New-Object System.Drawing.Point(414, 360); $start.Size = New-Object System.Drawing.Size(124, 32)
    $start.BackColor = $script:cAccentFloor
    $start.ForeColor = $script:cOnAccent
    $start.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $start.FlatAppearance.BorderSize = 0
    $start.UseVisualStyleBackColor = $false
    $start.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $form.Controls.Add($start); $form.AcceptButton = $start
    $later = New-Object System.Windows.Forms.Button
    $later.Text = 'Not now'; $later.Location = New-Object System.Drawing.Point(330, 360); $later.Size = New-Object System.Drawing.Size(74, 32)
    $later.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $later.FlatAppearance.BorderColor = $script:cLine
    $later.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $form.Controls.Add($later); $form.CancelButton = $later
    $form.Add_Shown({
        Invoke-OwnerPromptAttentionSound
        $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
        [ToolsEnabled.OwnerPromptQueueWindow]::Present($form.Handle)
        $form.Activate(); $form.BringToFront()
    })
    Set-OwnerPromptDialogScale $form
    try { return $form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK }
    finally { $form.Dispose() }
}


$timer = $null
try {
    $metadata = Get-Item -LiteralPath $InputFile -ErrorAction Stop
    if ($metadata.Length -lt 1 -or $metadata.Length -gt 131072 -or $metadata.PSIsContainer) { throw 'Invalid public request.' }
    $request = Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json -ErrorAction Stop
    if ($request.mode -notin @('start', 'capture') -or $request.kind -notin @('credential', 'payment_card') -or
        [string]$request.key -notmatch '^[A-Za-z0-9_.-]{1,100}$' -or
        [string]$request.label -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$' -or
        [string]$request.message -eq '' -or ([string]$request.message).Length -gt 360 -or
        $request.timeoutSeconds -lt 5 -or $request.timeoutSeconds -gt 900) { throw 'Invalid public request.' }
    $script:PromptParent = [System.Diagnostics.Process]::GetProcessById($ParentPid)
    $script:PromptParentTicks = $script:PromptParent.StartTime.ToUniversalTime().Ticks
    $script:PromptDeadline = [DateTime]::UtcNow.AddSeconds([int]$request.timeoutSeconds)
    $script:PromptInterrupted = $false
    $timer = New-Object System.Windows.Forms.Timer
    $timer.Interval = 250
    $timer.Add_Tick({
        $alive = $false
        try {
            $p = [System.Diagnostics.Process]::GetProcessById($ParentPid)
            $alive = $p.StartTime.ToUniversalTime().Ticks -eq $script:PromptParentTicks
        } catch { }
        if (-not $alive -or [DateTime]::UtcNow -ge $script:PromptDeadline) {
            $script:PromptInterrupted = $true
            [System.Windows.Forms.Application]::Exit()
        }
    })
    $timer.Start()
    if ($request.mode -eq 'start') {
        $outcome = if (Show-StartDialog ([int]$request.count) $request) { 'begin' } else { 'cancelled' }
    } else {
        # Invoke the existing masked DPAPI form in this process so the parent
        # lifetime timer also closes it. Only its safe metadata is returned.
        $parsed = Invoke-NativeOwnerCapture -Request $request
        $outcome = if ($parsed.status -in @('created', 'updated')) { 'completed' } elseif ($parsed.status -eq 'in_progress') { 'deferred' } else { 'cancelled' }
    }
    if ($script:PromptInterrupted) { $outcome = 'timeout' }
    @{ ok = $true; outcome = $outcome } | ConvertTo-Json -Compress
} catch {
    @{ ok = $false; code = 'OWNER_PROMPT_RUNNER_UNAVAILABLE' } | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($null -ne $timer) { $timer.Stop(); $timer.Dispose() }
    $output = $null; $parsed = $null
}
