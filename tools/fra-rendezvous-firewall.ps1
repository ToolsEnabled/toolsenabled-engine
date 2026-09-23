# Run once from an elevated owner PowerShell, on EACH machine.
#
# This permits the mechanical rendezvous listener (TCP 8795) inbound from the
# directly attached peer ONLY. After this one-time step the tray toggle needs
# no elevation and no further owner action: toggle both machines on and they
# exchange keys by themselves.
#
# Deliberately separate from tools/full-remote-access-firewall.ps1: that file
# is one of the 45 files pinned by the FRA runtime integrity anchor, and
# editing it forces a re-anchor on both machines. This script is not pinned, so
# adding the rendezvous rule cannot disturb an in-flight digest reconciliation.
#
# ASCII only. PowerShell 5.1 misparses this file if it picks up non-ASCII
# punctuation such as an em dash.
[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
$RuleName = 'ToolsEnabled FRA Rendezvous (8795)'
$Port = 8795

# THE ADDRESS PAIR COMES FROM THE REGISTRY, NEVER FROM A LITERAL HERE.
#
# This function used to carry '203.0.113.1' and '.2' in five places, matched
# with a regex and flipped with an if/else. That made the file work on exactly
# two computers -- the two on this desk -- and it duplicated, outside
# config/service-registry.json, the one fact the whole product derives machine
# identity from. A customer running this on any other pair of machines would get
# FRA_RENDEZVOUS_HOST_UNRESOLVED with nothing to change but the source.
#
# Resolve-ServiceRegistryTopology is what the seven sibling scripts already use,
# tools/full-remote-access-firewall.ps1 among them, and it fails CLOSED
# (SERVICE_REGISTRY_UNAVAILABLE / SERVICE_MACHINE_ADDRESS_UNSANCTIONED) rather
# than falling back to an interface scan, which is the correct behaviour for a
# script that opens a port.
$Root = Split-Path -Parent $PSScriptRoot
$RegistryHelper = Join-Path $Root 'tools\lib\service-registry.ps1'
if (-not (Test-Path -LiteralPath $RegistryHelper -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $RegistryHelper

function Resolve-DirectLinkAddresses {
    # FRA_RENDEZVOUS_HOST still selects WHICH declared machine this is, for a
    # host that legitimately holds neither address yet; it can no longer invent
    # an address the registry does not declare.
    $topology = if ([string]::IsNullOrWhiteSpace($env:FRA_RENDEZVOUS_HOST)) {
        Resolve-ServiceRegistryTopology -Root $Root
    } else {
        Resolve-ServiceRegistryTopology -Root $Root -ConfiguredAddress $env:FRA_RENDEZVOUS_HOST
    }
    return [pscustomobject]@{
        Local = [string]$topology.localMachine.address
        Peer  = [string]$topology.peerMachine.address
    }
}

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'ADMINISTRATOR_REQUIRED'
}

$binding = Resolve-DirectLinkAddresses
$LocalAddress = $binding.Local
$RemoteAddress = $binding.Peer

# Replace rather than duplicate, so re-running is idempotent and a previously
# over-broad rule cannot survive underneath a newly added narrow one.
foreach ($rule in @(Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)) {
    if ($PSCmdlet.ShouldProcess($rule.DisplayName, 'Remove stale FRA rendezvous firewall rule')) {
        Remove-NetFirewallRule -Name $rule.Name -ErrorAction Stop
    }
}

if ($PSCmdlet.ShouldProcess($RuleName, "Allow inbound TCP $Port only from the direct-link peer")) {
    # The dedicated direct-Ethernet adapter can legitimately be classified as
    # Public, so exact RemoteAddress pinning is what keeps every profile narrow.
    New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -RemoteAddress $RemoteAddress -Profile Any | Out-Null
}

# Role is derived, not literal: the numerically lower of the two declared
# addresses mints, which is how Get-RendezvousRole in
# packages\servercontrol\Mechanical-Connect.ps1 decides it. Comparing the packed
# 32-bit form keeps '192.168.50.9' below '192.168.50.10', which a string compare
# would get backwards.
function Get-AddressOrder([string]$Address) {
    try {
        $bytes = ([System.Net.IPAddress]::Parse($Address)).GetAddressBytes()
        [Array]::Reverse($bytes)
        return [uint32][System.BitConverter]::ToUInt32($bytes, 0)
    } catch { return [uint32]::MaxValue }
}

[ordered]@{
    rule = $RuleName
    port = $Port
    localAddress = $LocalAddress
    remoteAddress = $RemoteAddress
    scope = 'direct-link peer only'
    role = if ((Get-AddressOrder $LocalAddress) -lt (Get-AddressOrder $RemoteAddress)) { 'minter' } else { 'receiver' }
    nextStep = 'Turn the link on with: powershell -ExecutionPolicy Bypass -File tools\direct-link.ps1 -On'
    secretValuesEmitted = $false
} | ConvertTo-Json -Compress
