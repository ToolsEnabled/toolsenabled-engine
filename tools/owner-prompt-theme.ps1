# Shared visual identity for every owner-facing native dialog.
#
# Dot-sourced by tools/secrets.ps1 (the credential form) and by
# tools/owner-prompt-queue.ps1 (the start and failure dialogs). It lives in one
# file because the alternative is a copy per script, and a copied palette is
# exactly how the credential form ended up lavender while the product was teal.
#
# Colours are resolved from src/lib/owner-prompt-theme.js, the same manifest
# Mission Control pins its in-app owner popup to, and that manifest is checked
# against the app stylesheet by tests/owner-prompt-theme.test.js.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
function Get-OwnerPromptTheme {
    $module = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\lib\owner-prompt-theme.js'
    try {
        if (-not (Test-Path -LiteralPath $module -PathType Leaf)) { throw 'theme module missing' }
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        # One resolver reads the requesting runtime's current mc.theme value,
        # using the same account fence as the engine. LIVE and relocated user
        # data must not inherit a stale theme from the packaged app's cache.
        $script = 'process.stdout.write(JSON.stringify(require(process.argv[1]).resolveRuntimeTheme()))'
        $json = & $node -e $script $module 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) { throw 'theme resolve failed' }
        $resolved = $json | ConvertFrom-Json -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace([string]$resolved.ink)) { throw 'theme payload incomplete' }
        $script:ResolvedOwnerPromptFontFamilies = @($resolved.fonts.nativeUiFamilies)
        return [pscustomobject]@{ Theme = $resolved; Degraded = $false }
    }
    catch {
        # Render anyway. The owner is mid-purchase and a readable dialog beats
        # no dialog. But say so on the face of the window rather than quietly
        # showing unknown colours -- an unstyled prompt asking for a card is
        # exactly what must never appear without explanation.
        $fallback = [pscustomobject]@{
            name = 'white'; bg = '#f7f8fa'; bg2 = '#eef1f5'; surface = '#f7f8fa'; sheet = '#ffffff'
            ink = '#0e1726'; ink2 = '#4f5f70'; ink25 = '#5a6876'; ink3 = '#64727f'
            line = 'rgba(14, 23, 38, 0.07)'; line2 = 'rgba(14, 23, 38, 0.12)'
            good = '#198038'; serious = '#da1e28'
            accent = '#41859c'; accentFloor = '#007892'; focus = '#007d98'; onAccent = '#ffffff'
        }
        return [pscustomobject]@{ Theme = $fallback; Degraded = $true }
    }
}

function ConvertTo-OwnerPromptColor {
    # Accepts '#rrggbb' and 'rgba(r, g, b, a)'. WinForms controls cannot
    # composite a translucent border against their parent, so an rgba token is
    # flattened over the surface it will sit on rather than dropped.
    param([string]$Token, [string]$OverBase = '#ffffff')
    if ([string]::IsNullOrWhiteSpace($Token)) { return [System.Drawing.Color]::Black }
    $text = $Token.Trim()
    if ($text.StartsWith('#')) {
        $hex = $text.TrimStart('#')
        if ($hex.Length -eq 3) { $hex = ($hex.ToCharArray() | ForEach-Object { "$_$_" }) -join '' }
        if ($hex.Length -ne 6) { return [System.Drawing.Color]::Black }
        return [System.Drawing.Color]::FromArgb(
            [Convert]::ToInt32($hex.Substring(0, 2), 16),
            [Convert]::ToInt32($hex.Substring(2, 2), 16),
            [Convert]::ToInt32($hex.Substring(4, 2), 16))
    }
    $match = [regex]::Match($text, '^rgba?\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*(?:,\s*([0-9.]+)\s*)?\)$')
    if (-not $match.Success) { return [System.Drawing.Color]::Black }
    $r = [int]$match.Groups[1].Value; $g = [int]$match.Groups[2].Value; $b = [int]$match.Groups[3].Value
    $alpha = if ($match.Groups[4].Success) { [double]$match.Groups[4].Value } else { 1.0 }
    $base = ConvertTo-OwnerPromptColor -Token $OverBase
    return [System.Drawing.Color]::FromArgb(
        [int][Math]::Round(($r * $alpha) + ($base.R * (1 - $alpha))),
        [int][Math]::Round(($g * $alpha) + ($base.G * (1 - $alpha))),
        [int][Math]::Round(($b * $alpha) + ($base.B * (1 - $alpha))))
}

function Get-OwnerPromptFont {
    # The app's IBM Plex/JetBrains faces are bundled webfonts a native dialog
    # cannot load, so the manifest carries an installed-font ladder. Walk it
    # and take the first face this machine actually has; Segoe UI anchors it.
    param([double]$Size = 9.75, [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular)
    $ladder = if (@($script:ResolvedOwnerPromptFontFamilies).Count -gt 0) {
        @($script:ResolvedOwnerPromptFontFamilies)
    } else { @('IBM Plex Sans', 'Segoe UI Variable Text', 'Segoe UI', 'Tahoma') }
    foreach ($family in $ladder) {
        try {
            $font = New-Object System.Drawing.Font($family, $Size, $Style)
            # WinForms silently substitutes a default face for an absent family,
            # so trust the resolved name rather than the request.
            if ($font.Name -eq $family) { return $font }
            $font.Dispose()
        }
        catch { continue }
    }
    return New-Object System.Drawing.Font('Segoe UI', $Size, $Style)
}


# Declare DPI awareness at module load, before any dot-sourcing script has had
# a chance to create a window. Without it Windows virtualizes the process:
# it reports a larger window than the form paints, so dialogs sit letterboxed
# in their own frame and fixed-width labels clip mid-word.
if ($null -eq ('ToolsEnabled.DpiAwareness' -as [type])) {
    Add-Type -Namespace 'ToolsEnabled' -Name 'DpiAwareness' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@
}
# Best effort: a host that already set an awareness context makes this a no-op.
# It must never stop an owner prompt from appearing.
try { [void][ToolsEnabled.DpiAwareness]::SetProcessDPIAware() } catch { }

function Set-OwnerPromptDialogScale {
    # Dialog layouts are written against a 96dpi baseline. With DPI awareness
    # declared those are real pixels, so on a 125% display the geometry would
    # stay small while the point-sized fonts grew into it. Scale the GEOMETRY
    # ONLY -- fonts are in points and Windows already renders them larger at
    # higher DPI, so scaling them here too would apply the factor twice.
    param([System.Windows.Forms.Form]$Form)
    $graphics = $Form.CreateGraphics()
    try {
        $scaleFactor = [double]$graphics.DpiX / 96.0
        if ([Math]::Abs($scaleFactor - 1.0) -gt 0.01) {
            $Form.Scale((New-Object System.Drawing.SizeF([single]$scaleFactor, [single]$scaleFactor)))
        }
    }
    finally { $graphics.Dispose() }
}
