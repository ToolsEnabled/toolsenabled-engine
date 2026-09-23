<#
  ToolsEnabled installer. Every phase is idempotent; Phase 6 installs the whole
  local capability layer. Provider accounts and OAuth credentials are deliberately
  not created or stored by this script.
#>
param(
    [ValidateRange(0, 6)][int]$Phase = 6,
    [switch]$InstallDependencies,
    [switch]$RegisterClients,
    [switch]$SkipEditorPerfConfig
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
function Ensure-Dir([string]$Path) { if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Force -Path $Path | Out-Null } }
function Have-Command([string]$Name) { return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue) }

@('config', 'src', 'src/lib', 'src/lib/providers', 'tests', 'tools', 'vault', 'profiles', 'profiles/chrome', 'logs', 'state', '.claude', '.claude/skills', '.codex', 'adapters/codex') |
    ForEach-Object { Ensure-Dir (Join-Path $Root $_) }

if (-not (Have-Command 'node')) { throw 'Node.js 22.19.0 or newer is required.' }
$NodeVersionText = (& node -p 'process.versions.node').Trim()
try { $NodeVersion = [version]$NodeVersionText } catch { throw "Unable to parse the installed Node.js version '$NodeVersionText'." }
if ($NodeVersion -lt [version]'22.19.0') { throw "Node.js 22.19.0 or newer is required; found $NodeVersionText." }

$ClientHookMerger = Join-Path $Root 'tools/merge-client-hooks.js'
& node $ClientHookMerger `
    --settings (Join-Path $Root '.claude/settings.json') `
    --template (Join-Path $Root 'config/client-hooks/claude-settings.json') `
    --client Claude
if ($LASTEXITCODE -ne 0) { throw "Claude hook installation failed with exit code $LASTEXITCODE." }
& node $ClientHookMerger `
    --settings (Join-Path $Root '.codex/hooks.json') `
    --template (Join-Path $Root 'config/client-hooks/codex-hooks.json') `
    --client Codex
if ($LASTEXITCODE -ne 0) { throw "Codex hook installation failed with exit code $LASTEXITCODE." }

# A committed .vscode/settings.json only helps one checkout. Running this at
# install time makes the same watcher/search excludes a product behavior of
# the installation being configured. Merge-only, idempotent, reversible (see the tool's own
# --undo); disclosed here and again by the tool itself, never silent. This is
# a performance nicety, never a reason to fail the install: a broken merge is
# reported and skipped by the tool itself, and any unexpected failure here is
# caught and downgraded to a warning.
if ($SkipEditorPerfConfig) {
    Write-Host 'Skipping editor performance config (.vscode/settings.json) because -SkipEditorPerfConfig was passed.' -ForegroundColor Yellow
} else {
    Write-Host 'Configuring editor performance (.vscode/settings.json watcher/search excludes only -- no styling, nothing hidden). Skip with -SkipEditorPerfConfig; undo any time with: node tools/configure-editor-perf.js --undo' -ForegroundColor Cyan
    try {
        & node (Join-Path $Root 'tools/configure-editor-perf.js') --path $Root
        if ($LASTEXITCODE -ne 0) { Write-Host "Editor performance config exited $LASTEXITCODE; continuing install (this step is never fatal)." -ForegroundColor Yellow }
    } catch {
        Write-Host "Editor performance config failed non-fatally: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# --- WHOSE COMPUTER DOES THIS INSTALL INTO, AND WHAT IF IT IS REFUSED (R1534) -
#
# These three optional installs decide, by omission, whether they need an
# administrator. `winget install` without --scope takes whatever the package
# manifest defaults to; if that resolves to the machine-scope installer it
# writes under Program Files and raises a UAC prompt. This product's own rule
# (src/lib/setup/machine-record.js) is that it installs with NO elevation, and
# src/lib/providers/workstation.js already pins --scope user for exactly this
# reason. These did not. Pinning it here is the smaller half of the fix.
#
# The larger half is what they SAY when refused. "Google Cloud SDK installation
# failed." names neither elevation nor cancellation, and with
# $ErrorActionPreference = 'Stop' it aborts the entire installer. A person who
# declined a UAC prompt, or whose machine had nowhere to show one, was told only
# that something failed.
function Show-DependencyInstallFailure {
    param([string]$Name, [int]$Code)
    Write-Host ""
    Write-Host ("$Name could not be installed (exit code $Code)." ) -ForegroundColor Yellow
    # 0x8A15005x is the WinGet cancelled family; 1223 is the Windows
    # ERROR_CANCELLED that a refused or unshowable elevation request produces.
    if ($Code -eq 1223 -or $Code -eq -1978335162 -or $Code -eq -1978334971) {
        Write-Host "  What happened: the installer asked Windows for administrator rights and did not get them." -ForegroundColor Yellow
        Write-Host "  If you were not shown a prompt, Windows had nowhere to show one and refused on its own." -ForegroundColor Yellow
        Write-Host "  Windows reports that refusal as 'cancelled by the user' even when nobody was asked." -ForegroundColor Yellow
    }
    Write-Host "  What would enable it: install $Name yourself, from a window you opened, and re-run this script." -ForegroundColor Yellow
    Write-Host "  What it costs to skip: only the features that use $Name. ToolsEnabled itself installs into your own account and needs no administrator." -ForegroundColor Yellow
    Write-Host "  This script will not ask Windows for administrator rights and will not change any Windows security setting." -ForegroundColor Yellow
}

if ($InstallDependencies -and -not (Have-Command 'firebase')) {
    if (-not (Have-Command 'npm')) { throw 'npm is required to install firebase-tools.' }
    & npm install --global firebase-tools
    if ($LASTEXITCODE -ne 0) {
        Show-DependencyInstallFailure -Name 'firebase-tools' -Code $LASTEXITCODE
        throw "firebase-tools installation failed (exit code $LASTEXITCODE). A global npm install writes to npm's prefix; if that prefix is inside Program Files it will be refused, and npm reports that as EPERM or EACCES rather than as an administrator prompt."
    }
}

if ($InstallDependencies -and -not (Have-Command 'gcloud')) {
    if (-not (Have-Command 'winget')) { throw 'winget is required to install Google Cloud SDK automatically.' }
    & winget install --id Google.CloudSDK --exact --scope user --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Show-DependencyInstallFailure -Name 'Google Cloud SDK' -Code $LASTEXITCODE
        throw "Google Cloud SDK installation failed (exit code $LASTEXITCODE)."
    }
}

if ($InstallDependencies -and -not (Have-Command 'terraform')) {
    if (-not (Have-Command 'winget')) { throw 'winget is required to install Terraform automatically.' }
    & winget install --id Hashicorp.Terraform --exact --scope user --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Show-DependencyInstallFailure -Name 'Terraform' -Code $LASTEXITCODE
        throw "Terraform installation failed (exit code $LASTEXITCODE)."
    }
}

if ($RegisterClients -and (Have-Command 'codex')) {
    # Invoke the CLI directly.  Sending it through cmd.exe makes a console
    # flash in several desktop hosts, even though no shell features are needed.
    & codex mcp get toolsenabled *> $null
    if ($LASTEXITCODE -ne 0) {
        & codex mcp add toolsenabled -- node (Join-Path $Root 'src\mcp-server.js')
        if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration for ToolsEnabled failed.' }
    }
    & codex mcp get toolsenabled-playwright *> $null
    if ($LASTEXITCODE -ne 0) {
        & codex mcp add toolsenabled-playwright -- node (Join-Path $Root 'src\playwright-gateway.js') '@playwright/mcp@0.0.82'
        if ($LASTEXITCODE -ne 0) { throw 'Codex MCP registration for Playwright failed.' }
    }
}

$required = @('package.json', 'config/toolsenabled.policy.json', 'src/mcp-server.js', 'src/lib/state-store.js', 'tools/secrets.ps1', 'tools/browser.ps1', 'tools/playwright-mcp.cmd', 'tools/mcsetup.js')
$missing = $required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Root $_)) }
if ($missing) { throw "ToolsEnabled is incomplete. Missing: $($missing -join ', ')" }

$phaseSummary = @(
    'Phase 0: local scaffold and client hook files ready.',
    'Phase 1: universal MCP server and dedicated browser profile ready.',
    'Phase 2: DPAPI local secret vault ready.',
    'Phase 3: Instagram, Firebase, Chrome Web Store, Gmail, Calendar, and GitHub API adapters ready.',
    'Phase 4: build/test/deploy launch pipeline ready.',
    'Phase 5: daily/hourly/minute scheduler, spend ledger, and Stripe Issuing adapters ready.',
    'Phase 6: validated MCP contracts, transactional state, durable cross-agent task handoff, one-time approval enforcement, vault-sealed HTTP, local-only model completion, fail-closed policy, browser-aware kill switch, audit logging, and diagnostics ready.'
)

Write-Host 'ToolsEnabled installed.' -ForegroundColor Green
0..$Phase | ForEach-Object { Write-Host $phaseSummary[$_] }
Write-Host "MCP command: node `"$Root\src\mcp-server.js`""
Write-Host 'Next setup: node tools/mcsetup.js run (chooses a permission tier and writes the workspace MCP configuration).' -ForegroundColor Cyan
Write-Host 'Next diagnostics: npm test; node src/doctor.js' -ForegroundColor Cyan
if ($InstallDependencies) { Write-Host 'Open a new terminal before using newly installed CLIs so PATH changes are loaded.' -ForegroundColor Cyan }
if ($RegisterClients -and (Have-Command 'codex')) { Write-Host 'Codex CLI MCP servers registered.' -ForegroundColor Cyan }
