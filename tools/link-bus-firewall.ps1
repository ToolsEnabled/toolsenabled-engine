#requires -Version 5.1
<#
    ONE-TIME, IDEMPOTENT firewall rule for the direct-ethernet link bus
    (owner request R117). This script needs elevation because creating an
    inbound Windows Firewall rule is an admin-only operation; the owner's
    interactive session carries BUILTIN\Administrators as deny-only.

    Deliberately NOT added to config\uac-delegation-allowlist.json: that file
    is a closed, owner-curated list of standing elevated capabilities, and its
    own header says "nothing else is added without a new owner decision" and
    "an agent must not widen its own elevated surface beyond what was
    authorized." Adding an entry there would let any future agent silently
    re-run this. Instead this script is launched via a single ad hoc
    `Start-Process -Verb RunAs`, which pops one native UAC consent dialog --
    only the owner's own physical click can approve it, every time.

    What it does, and nothing else: adds one inbound Allow rule scoped to
    TCP 8787 and the exact registry-declared peer address. It touches no other
    port, no other named rule, no service, no policy. Idempotent: if the rule
    already has the exact secure shape, it does nothing and exits 0; a stale
    broader rule with this display name is replaced.
#>

$ErrorActionPreference = 'Stop'
$RuleName = 'ToolsEnabled Link Bus (8787)'
$Port = 8787
$Root = Split-Path -Parent $PSScriptRoot
$RegistryHelper = Join-Path $Root 'tools\lib\service-registry.ps1'
if (-not (Test-Path -LiteralPath $RegistryHelper -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $RegistryHelper
$Topology = Resolve-ServiceRegistryTopology -Root $Root
$RemotePeer = [string]$Topology.peerMachine.address

# SAY IT BEFORE THE READ THAT CANNOT SEE, NOT AFTER THE WRITE THAT FAILS (R1534).
#
# Creating a firewall rule needs an administrator on every Windows machine at
# its default settings, and this script had no check for it. That was not merely
# a late error: Get-NetFirewallRule below returns an EMPTY result set to an
# unelevated process even when the rule exists, so the idempotency check
# concluded "not present" and fell through to New-NetFirewallRule, which then
# failed with a raw access-denied. The reported story was "the rule was missing
# and could not be created"; the truth was often "the rule is already correct
# and this shell cannot see it". tools/full-remote-access-firewall.ps1 already
# had this guard; this file did not.
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'ADMINISTRATOR_REQUIRED: creating a firewall rule needs an elevated PowerShell. Nothing was read and nothing was changed. Run this from a window opened with "Terminal (Admin)". Note that an unelevated shell cannot even SEE these rules, so a report of "missing" from one is not evidence that the rule is absent.'
}

$existing = @(Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)
$exact = $false
if ($existing.Count -eq 1) {
    $portFilter = @($existing[0] | Get-NetFirewallPortFilter)
    $addressFilter = @($existing[0] | Get-NetFirewallAddressFilter)
    $remoteAddresses = if ($addressFilter.Count -eq 1) { @($addressFilter[0].RemoteAddress) } else { @() }
    $exact = (
        [string]$existing[0].Direction -eq 'Inbound' -and
        [string]$existing[0].Action -eq 'Allow' -and
        [string]$existing[0].Enabled -eq 'True' -and
        [string]$existing[0].Profile -eq 'Any' -and
        $portFilter.Count -eq 1 -and
        [string]$portFilter[0].Protocol -eq 'TCP' -and
        [string]$portFilter[0].LocalPort -eq [string]$Port -and
        $remoteAddresses.Count -eq 1 -and
        [string]$remoteAddresses[0] -eq $RemotePeer
    )
}
if ($exact) {
    Write-Output "already present: $RuleName"
    exit 0
}
foreach ($rule in $existing) { $rule | Remove-NetFirewallRule }

New-NetFirewallRule -DisplayName $RuleName `
    -Description 'Inbound allow for the ToolsEnabled link bus (owner request R117). Scoped to the exact registry-declared peer only.' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
    -RemoteAddress $RemotePeer -Profile Any -Enabled True | Out-Null

Write-Output "created or replaced: $RuleName (TCP $Port from $RemotePeer)"
exit 0
