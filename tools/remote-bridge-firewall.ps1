#requires -Version 5.1
<#
    ONE-TIME, IDEMPOTENT firewall rule for the remote-agent-bridge (owner
    request R117, "get the other computer complete access to the
    toolsenabled system"). Same reasoning as tools/link-bus-firewall.ps1:
    this needs elevation because creating an inbound Windows Firewall rule is
    admin-only, and the owner's interactive session carries
    BUILTIN\Administrators as deny-only.

    Deliberately a SEPARATE script and a SEPARATE allowlist entry from the
    link-bus firewall rule, even though both are "add one inbound rule for
    this project" -- config/uac-delegation-allowlist.json keeps one entry per
    distinct, reviewed action so each can be understood and audited on its
    own, rather than one entry quietly widening to cover more later.

    What it does, and nothing else: adds one inbound Allow rule scoped to
    TCP 8788 and the EXACT peer address. Idempotent: if the exact rule already
    exists, it does nothing and exits 0; a stale broader rule with this display
    name is replaced.

    The remote address used to be the 203.0.113.0/24 subnet. It is now the
    single peer, derived from this machine's own direct-link address, because
    "a connection is accepted only from the exact peer address, firewall-pinned"
    is one of the two rules that never bend, and because this lane carries MORE
    authority than FRA -- host.write_file, repo.write_file and sandbox.exec --
    while the FRA rules on 8790 and 8794 were already pinned to a single host.
    The narrower lane was the tighter one, which is backwards. Deriving the peer
    from the local address also means the identical script is correct on both
    machines, with nothing to configure per host.
#>

$ErrorActionPreference = 'Stop'
$RuleName = 'ToolsEnabled Remote Agent Bridge (8788)'
$Port = 8788
$Root = Split-Path -Parent $PSScriptRoot
$RegistryHelper = Join-Path $Root 'tools\lib\service-registry.ps1'
if (-not (Test-Path -LiteralPath $RegistryHelper -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $RegistryHelper
$Topology = Resolve-ServiceRegistryTopology -Root $Root
$RemotePeer = [string]$Topology.peerMachine.address

# SAY IT BEFORE THE READ THAT CANNOT SEE, NOT AFTER THE WRITE THAT FAILS (R1534).
#
# Same defect and same fix as tools/link-bus-firewall.ps1, and it matters more
# here because this lane carries the higher authority: host.write_file,
# repo.write_file and sandbox.exec. Get-NetFirewallRule answers "none" rather
# than failing when the caller is not elevated, so the idempotency check below
# would decide the rule was absent and try to create it, turning "you are not an
# administrator" into a misleading "the rule was missing".
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
    -Description 'Inbound allow for the ToolsEnabled remote-agent tool-execution bridge (owner request R117). Scoped to the exact direct-link peer address only.' `
    -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port `
    -RemoteAddress $RemotePeer -Profile Any -Enabled True | Out-Null

Write-Output "created or replaced: $RuleName (TCP $Port from $RemotePeer)"
exit 0
