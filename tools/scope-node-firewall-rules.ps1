# Scope the blanket "Node.js JavaScript Runtime" inbound firewall rules down from
# RemoteAddress=Any to only the machine addresses this deployment actually declares.
#
# THE HOLE THIS CLOSES (SHIPMENT-PLAN B24, measured 2026-08-10).
# Windows carries two enabled inbound ALLOW rules named "Node.js JavaScript
# Runtime" -- Program=node.exe, TCP and UDP, LocalPort=Any, LocalAddress=Any,
# RemoteAddress=Any, Profile=Public. Every interface on this host is on the
# Public profile, including a Wi-Fi adapter with live Internet connectivity.
# So the firewall permits any node process, on any port, from any remote
# address, on every network. It is the classic "Node.js wants to accept
# connections -> Allow" click.
#
# Nothing is currently exposed, and that is worth stating precisely: measured,
# 0 node listeners sit on 0.0.0.0/::/an internet-facing IP -- every one is
# loopback or the direct-link address. The bind address is doing all of the
# work and the firewall is contributing nothing behind it. That is one layer
# with no backstop, sitting exactly where the ground is about to move: the
# owner has said this machine will be moved to another computer and network
# before red-team testing, and the bind address is read from
# config/service-registry.json. On a network where that address is routable,
# every service publishes the instant it binds. The bind is not even a
# constant -- tools/release-packager/serve-candidate.mjs takes --bind as a CLI
# flag.
#
# WHY THIS SCOPES BY REMOTE ADDRESS AND NOT BY PORT.
# A port-scoped rule looks tighter and is a trap. config/service-registry.json
# DELIBERATELY excludes the FRA credential enrollment/rotation ports (8793,
# 8794, and the 8795 rendezvous listener are called out as out of scope in the
# full-remote-access notes). A rule built from the registry's structured port
# fields would therefore be missing exactly the ports Machine B needs DURING
# ENROLLMENT, and would break FRA the first time it mattered -- while looking
# correct in review. Scoping RemoteAddress instead needs no port list at all:
# it removes the entire Internet from the allowed set while leaving every
# peer-to-peer function working on every port, enrolled or not.
#
# WHY IT DOES NOT DELETE THE RULES.
# Those blanket rules are what currently permits Machine B's inbound
# connections to 8787/8788/8790. Deleting or disabling them severs the direct
# link. This narrows them in place instead, so the peer keeps working.
#
# NOT A REPLACEMENT FOR THE BIND ADDRESS. This is the second layer. Services
# should still bind their own declared address rather than 0.0.0.0.
#
# ASCII only: PowerShell 5.1 on this machine mis-parses non-ASCII characters.

[CmdletBinding()]
param(
    # Default is a DRY RUN. Nothing is changed without -Apply.
    [switch]$Apply,
    # Put the rules back to RemoteAddress=Any (undo).
    [switch]$Revert
)

$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$RegistryHelper = Join-Path $Root 'tools\lib\service-registry.ps1'
if (-not (Test-Path -LiteralPath $RegistryHelper -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $RegistryHelper

$RULE_NAME = 'Node.js JavaScript Runtime'

if ($Apply -and $Revert) { throw 'Pass -Apply or -Revert, not both.' }

# The sanctioned address set comes only from the registry. No subnet guess, no
# hardcoded literal, and it keeps working after this machine moves networks --
# update the registry and re-run.
$policy = Read-ToolsEnabledServiceRegistry -Root $Root
$declared = @($policy.addresses | Sort-Object -Unique)
if ($declared.Count -eq 0) { throw 'SERVICE_REGISTRY_EMPTY' }

Write-Output '=== Declared machine addresses (from config/service-registry.json) ==='
foreach ($m in $policy.machines) { Write-Output ("  {0}  {1}" -f $m.address, $m.machineId) }

$rules = @(Get-NetFirewallRule -DisplayName $RULE_NAME -ErrorAction SilentlyContinue |
    Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' })
if ($rules.Count -eq 0) {
    # "NOTHING TO SCOPE" WAS BEING PRINTED BY A READ THAT COULD NOT SEE (R1534).
    #
    # Get-NetFirewallRule returns an EMPTY result set to an unelevated process
    # even when the rules exist. It does not fail and it does not warn: it
    # answers "none". So an unelevated dry run printed "Nothing to scope" and
    # exited 0 while blanket Any-address rules were sitting there wide open --
    # a green result produced by blindness, which is the worst kind.
    #
    # netsh reads the same policy without elevation, so it can tell the two
    # cases apart. Absence is only reported when netsh actually said so.
    $netshText = ''
    try {
        $netshText = [string]::Join("`n", @(& netsh advfirewall firewall show rule name="$RULE_NAME"))
    } catch {
        $netshText = ''
    }
    $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    $elevated = $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

    if ($netshText -match '(?m)^Rule Name:') {
        Write-Output ''
        Write-Output ("UNREADABLE, NOT ABSENT: rules named '{0}' DO exist -- netsh can see them and Get-NetFirewallRule returned nothing." -f $RULE_NAME)
        if (-not $elevated) {
            Write-Output 'This shell is not elevated, which is why the read came back empty. Nothing has been checked and nothing has been changed.'
        }
        Write-Output 'Re-run this from an elevated PowerShell to see and scope them. Do NOT treat this host as scoped.'
        exit 2
    }
    if ([string]::IsNullOrWhiteSpace($netshText)) {
        Write-Output ''
        Write-Output ("COULD NOT CHECK: neither Get-NetFirewallRule nor netsh could report on rules named '{0}'." -f $RULE_NAME)
        Write-Output 'This is not the same as there being none. Do NOT treat this host as scoped.'
        exit 2
    }
    Write-Output ''
    Write-Output ("No inbound Allow rules named '{0}' found, confirmed by netsh as well. Nothing to scope." -f $RULE_NAME)
    Write-Output 'If node services still accept peer connections, some OTHER rule is permitting them -- find it before assuming this host is scoped.'
    return
}

Write-Output ''
Write-Output '=== Current state ==='
foreach ($rule in $rules) {
    $af = $rule | Get-NetFirewallAddressFilter
    $pf = $rule | Get-NetFirewallPortFilter
    Write-Output ("  [{0}] {1}  Profile={2}  LocalPort={3}  RemoteAddress={4}  Enabled={5}" -f `
        $pf.Protocol, $rule.DisplayName, $rule.Profile, ($pf.LocalPort -join ','), ($af.RemoteAddress -join ','), $rule.Enabled)
}

$target = if ($Revert) { @('Any') } else { $declared }
$targetText = $target -join ','

Write-Output ''
if (-not $Apply -and -not $Revert) {
    Write-Output '=== DRY RUN -- nothing changed ==='
    Write-Output ("Would set RemoteAddress to: {0}" -f $targetText)
    Write-Output 'LocalPort stays Any on purpose (see the header: the registry omits the FRA enrollment ports).'
    Write-Output 'Re-run with -Apply to make the change. Needs an elevated shell.'
    return
}

# Applying needs admin. Say so plainly rather than failing halfway through and
# leaving one protocol scoped and the other wide open.
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'NOT_ELEVATED: changing firewall rules needs an elevated PowerShell. Nothing was changed.'
}

$verb = if ($Revert) { 'REVERTING to' } else { 'SCOPING to' }
Write-Output ("=== {0} RemoteAddress={1} ===" -f $verb, $targetText)
foreach ($rule in $rules) {
    Set-NetFirewallRule -Name $rule.Name -RemoteAddress $target -ErrorAction Stop
    Write-Output ("  updated: {0} ({1})" -f $rule.DisplayName, $rule.Name)
}

# Read the rules back rather than trusting that Set- worked. A firewall change
# that silently did not take is worse than one that failed loudly.
Write-Output ''
Write-Output '=== Verified state (read back) ==='
$after = @(Get-NetFirewallRule -DisplayName $RULE_NAME -ErrorAction SilentlyContinue |
    Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' })
$bad = 0
foreach ($rule in $after) {
    $af = $rule | Get-NetFirewallAddressFilter
    $pf = $rule | Get-NetFirewallPortFilter
    $actual = @($af.RemoteAddress)
    Write-Output ("  [{0}] RemoteAddress={1}" -f $pf.Protocol, ($actual -join ','))
    $missing = @($target | Where-Object { $actual -notcontains $_ })
    if ($missing.Count -gt 0) { $bad++ }
}
if ($bad -gt 0) {
    throw ("FIREWALL_SCOPE_NOT_APPLIED: {0} rule(s) did not read back with the requested addresses." -f $bad)
}

Write-Output ''
if ($Revert) {
    Write-Output 'Reverted. These rules are blanket-open again (RemoteAddress=Any).'
} else {
    Write-Output 'Scoped. node.exe now accepts inbound only from the declared machine addresses.'
    Write-Output 'CHECK THE PEER LINK before considering this done: run tools/bridge-status.js and confirm the'
    Write-Output 'tunnel/bridge lanes still reach Machine B. If they do not, re-run this script with -Revert.'
}
