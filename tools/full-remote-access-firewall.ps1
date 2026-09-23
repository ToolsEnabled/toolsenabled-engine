# Run only from an elevated owner PowerShell. This permits the independently
# controlled Full Remote Access listener on the directly attached peer only.
[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$RegistryHelper = Join-Path $Root 'tools\lib\service-registry.ps1'
if (-not (Test-Path -LiteralPath $RegistryHelper -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
. $RegistryHelper
$Topology = if ([string]::IsNullOrWhiteSpace($env:FULL_REMOTE_ACCESS_HOST)) {
    Resolve-ServiceRegistryTopology -Root $Root
} else {
    Resolve-ServiceRegistryTopology -Root $Root -ConfiguredAddress $env:FULL_REMOTE_ACCESS_HOST
}
$LocalAddress = [string]$Topology.localMachine.address
$RemoteAddress = [string]$Topology.peerMachine.address
$DirectionalTopology = Resolve-ServiceRegistryDirectionalTopology -Root $Root -ConfiguredAddress $LocalAddress
$EnrollmentRecipient = $DirectionalTopology.recipientMachine
$Rules = @(
    [pscustomobject]@{ Name = 'ToolsEnabled Full Remote Access (8790)'; Port = 8790; Purpose = 'encrypted FRA service' }
)
if ($LocalAddress -ceq $EnrollmentRecipient.address) {
    $Rules += [pscustomobject]@{ Name = 'ToolsEnabled FRA Enrollment 8794'; Port = 8794; Purpose = 'sealed one-shot FRA credential enrollment' }
}

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'ADMINISTRATOR_REQUIRED'
}

foreach ($retiredName in @('ToolsEnabled Full Remote Access Enrollment (8793)', 'ToolsEnabled FRA Enrollment 8794')) {
    if ($retiredName -eq 'ToolsEnabled FRA Enrollment 8794' -and $LocalAddress -ceq $EnrollmentRecipient.address) { continue }
    foreach ($retired in @(Get-NetFirewallRule -DisplayName $retiredName -ErrorAction SilentlyContinue)) {
        if ($PSCmdlet.ShouldProcess($retired.DisplayName, 'Remove retired or peer-inappropriate FRA enrollment rule')) {
            Remove-NetFirewallRule -Name $retired.Name -ErrorAction Stop
        }
    }
}

foreach ($definition in $Rules) {
    $existing = @(Get-NetFirewallRule -DisplayName $definition.Name -ErrorAction SilentlyContinue)
    foreach ($rule in $existing) {
        if ($PSCmdlet.ShouldProcess($rule.DisplayName, 'Remove stale Full Remote Access firewall rule')) {
            Remove-NetFirewallRule -Name $rule.Name -ErrorAction Stop
        }
    }
    if ($PSCmdlet.ShouldProcess($definition.Name, "Allow inbound TCP $($definition.Port) only from the direct-link peer")) {
        # The dedicated direct-Ethernet adapter can legitimately be classified
        # as Public. Exact RemoteAddress pinning keeps every profile narrow.
        New-NetFirewallRule -DisplayName $definition.Name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $definition.Port -RemoteAddress $RemoteAddress -Profile Any | Out-Null
    }
}

[ordered]@{
    rules = @($Rules | ForEach-Object { [ordered]@{ name = $_.Name; port = $_.Port; purpose = $_.Purpose } })
    localAddress = $LocalAddress
    remoteAddress = $RemoteAddress
    scope = 'direct-link peer only'
} | ConvertTo-Json -Compress
