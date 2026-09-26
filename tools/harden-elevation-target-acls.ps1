# Remove non-administrator write access from the programs this machine runs
# WITH ADMINISTRATOR RIGHTS, and from the directories that contain them.
#
# THE HOLE THIS CLOSES (SHIPMENT-PLAN B27, measured 2026-08-11).
# A scheduled task registered at RunLevel=Highest is an elevation door. Its
# strength is the NTFS permissions on the program it runs, and nothing else. If
# a non-administrator can rewrite that program, every gate inside it -- a
# per-boot token, a fixed operation allowlist, a kill switch, a signed audit
# trail -- is bypassed by replacing the code that enforces them and then asking
# Windows to run it elevated.
#
# WHY THE DIRECTORY MATTERS AS MUCH AS THE FILE.
# Modify on a FOLDER includes DeleteSubdirectoriesAndFiles. A principal with
# Modify on the containing folder can delete the program and write their own in
# its place even when the program's own ACL denies them everything. Hardening
# the file alone looks correct in review and closes nothing. This script always
# treats the file and its directory as one unit, and refuses to do only half.
#
# WHAT IT DOES NOT DECIDE.
# On this deployment the offending principals are not only BUILTIN\Users but
# also the agent sandbox group, which holds Modify on the source tree BY
# DESIGN so that agents can edit source. Removing it here stops sandboxed
# agents editing the elevated helper -- which is the point -- but it is a
# policy change, not a typo fix, and the owner decides it. That is why this
# script does nothing without -Apply, and why it prints the exact principals it
# would remove before removing anything.
#
# ASCII only: PowerShell 5.1 on this machine mis-parses non-ASCII characters.

[CmdletBinding()]
param(
    # Default is a DRY RUN. Nothing is changed without -Apply.
    [switch]$Apply,
    # Restrict to targets whose path contains this substring. Use it to harden
    # this product's own elevation door without touching unrelated third-party
    # tasks that the same check also reports.
    [string]$PathFilter = ''
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$Checker = Join-Path $Root 'tools\check-elevation-writability.js'
if (-not (Test-Path -LiteralPath $Checker -PathType Leaf)) { throw 'ELEVATION_CHECKER_UNAVAILABLE' }

# Targets come from the checker, never from a list typed into this file. That
# keeps the two in step and keeps this script portable to a machine with
# different paths, a different account, and different tasks.
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw 'NODE_UNAVAILABLE: node must be on PATH to enumerate elevation targets.' }

$raw = & $node.Source $Checker --json 2>$null
if (-not $raw) { throw 'ELEVATION_CHECK_PRODUCED_NO_OUTPUT' }
$report = $raw | ConvertFrom-Json

$offending = @($report.results | Where-Object { -not $_.ok })
if ($PathFilter) { $offending = @($offending | Where-Object { $_.path -like "*$PathFilter*" }) }

if ($offending.Count -eq 0) {
    Write-Output 'No elevation target needs hardening (with the current filter).'
    Write-Output 'If you expected some, re-run tools/check-elevation-writability.js and read its output first.'
    return
}

Write-Output '=== Elevation targets a non-administrator can rewrite ==='
foreach ($t in $offending) {
    Write-Output ("  {0}" -f $t.path)
    if ($t.reason) { Write-Output ("      {0}" -f $t.reason) }
    foreach ($o in $t.offenders) {
        Write-Output ("      remove: {0}  [{1}]" -f $o.principal, ($o.rights -join ','))
    }
}

# The principals that must KEEP access. Resolved at runtime from well-known
# SIDs and from the current user, never spelled as a literal account name, so
# this behaves the same on a machine with a different owner and locale.
function Resolve-WellKnownAccount([string]$sid) {
    try { return (New-Object System.Security.Principal.SecurityIdentifier($sid)).Translate([System.Security.Principal.NTAccount]).Value }
    catch { return $null }
}
$AdminsAccount = Resolve-WellKnownAccount 'S-1-5-32-544'
$SystemAccount = Resolve-WellKnownAccount 'S-1-5-18'
$OwnerAccount  = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if (-not $AdminsAccount -or -not $SystemAccount) { throw 'WELL_KNOWN_SIDS_UNRESOLVABLE' }

Write-Output ''
Write-Output '=== Principals that will KEEP full control ==='
Write-Output ("  {0}" -f $SystemAccount)
Write-Output ("  {0}" -f $AdminsAccount)
Write-Output ("  {0}   (the account the elevated task runs as)" -f $OwnerAccount)

Write-Output ''
if (-not $Apply) {
    Write-Output '=== DRY RUN -- nothing changed ==='
    Write-Output 'For each target above this would run, in order:'
    foreach ($t in $offending) {
        Write-Output ("  icacls ""{0}"" /inheritance:r" -f $t.path)
        Write-Output ("  icacls ""{0}"" /grant:r ""{1}"":(OI)(CI)F ""{2}"":(OI)(CI)F ""{3}"":(OI)(CI)F" -f $t.path, $SystemAccount, $AdminsAccount, $OwnerAccount)
    }
    Write-Output ''
    Write-Output 'READ THIS BEFORE -Apply:'
    Write-Output '  1. Breaking inheritance means later changes to the parent no longer reach these paths.'
    Write-Output '  2. If a sandbox or agent principal is listed above, agents lose write access to that'
    Write-Output '     path. For a source directory that is a WORKFLOW CHANGE, not a cleanup -- it is the'
    Write-Output '     owner''s call, because an agent that can rewrite code which later runs elevated can'
    Write-Output '     escalate by construction.'
    Write-Output '  3. Re-run tools/check-elevation-writability.js afterwards and confirm it exits 0.'
    Write-Output '  4. Confirm the elevated task still runs. If it does not, restore inheritance with:'
    Write-Output '       icacls "<path>" /inheritance:e'
    return
}

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    # Not strictly required for a path the current user owns, but a partially
    # applied ACL change is worse than none: some targets tightened, others not,
    # and a checker that now reports a mixture nobody can reason about.
    throw 'NOT_ELEVATED: run this from an elevated PowerShell so every target is changed or none is. Nothing was changed.'
}

foreach ($t in $offending) {
    Write-Output ("--- hardening {0}" -f $t.path)
    & icacls "$($t.path)" /inheritance:r | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ("ICACLS_INHERITANCE_FAILED: {0}" -f $t.path) }
    & icacls "$($t.path)" /grant:r "$($SystemAccount):(OI)(CI)F" "$($AdminsAccount):(OI)(CI)F" "$($OwnerAccount):(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ("ICACLS_GRANT_FAILED: {0}" -f $t.path) }
}

# Read the verdict back from the checker rather than trusting that icacls did
# what was asked. An ACL change that silently did not take is worse than one
# that failed loudly.
Write-Output ''
Write-Output '=== Verified state (re-running the check) ==='
& $node.Source $Checker
if ($LASTEXITCODE -ne 0) {
    Write-Output ''
    Write-Output 'STILL FAILING. Some elevation target is still writable by a non-administrator.'
    Write-Output 'Read the output above; do not treat this run as complete.'
    exit 1
}
Write-Output ''
Write-Output 'Clean. Now confirm the elevated task still runs before considering this done.'
