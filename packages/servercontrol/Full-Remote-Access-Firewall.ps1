# Run only from an elevated owner PowerShell. This permits the independently
# controlled Full Remote Access listener on the registry-declared peer only.
[CmdletBinding(SupportsShouldProcess)]
param()

$ErrorActionPreference = 'Stop'
function Resolve-DirectLinkAddresses {
    $common = Join-Path $PSScriptRoot 'ServerControl.Common.ps1'
    if (-not (Test-Path -LiteralPath $common -PathType Leaf)) { throw 'SERVICE_REGISTRY_UNAVAILABLE' }
    . $common
    $profile = Get-ServerControlHostProfile
    if (-not $profile.LocalIp -or -not $profile.PeerIp) { throw 'FULL_REMOTE_ACCESS_HOST_UNRESOLVED' }
    return [pscustomobject]@{ Local = [string]$profile.LocalIp; Peer = [string]$profile.PeerIp; MachineId = [string]$profile.MachineId }
}

$binding = Resolve-DirectLinkAddresses
$LocalAddress = $binding.Local
$RemoteAddress = $binding.Peer
$Rules = @(
    [pscustomobject]@{ Name = 'ToolsEnabled Full Remote Access (8790)'; Port = 8790; Purpose = 'encrypted FRA service' }
)
if ($binding.MachineId -eq 'B') {
    $Rules += [pscustomobject]@{ Name = 'ToolsEnabled FRA Enrollment 8794'; Port = 8794; Purpose = 'sealed one-shot FRA credential enrollment' }
}

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'ADMINISTRATOR_REQUIRED'
}

foreach ($retiredName in @('ToolsEnabled Full Remote Access Enrollment (8793)', 'ToolsEnabled FRA Enrollment 8794')) {
    if ($retiredName -eq 'ToolsEnabled FRA Enrollment 8794' -and $binding.MachineId -eq 'B') { continue }
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
    if ($PSCmdlet.ShouldProcess($definition.Name, "Allow inbound TCP $($definition.Port) only from the registry-declared peer")) {
        # The active adapter can legitimately be classified as Public. Exact
        # registry-derived RemoteAddress pinning keeps every profile narrow.
        New-NetFirewallRule -DisplayName $definition.Name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $definition.Port -RemoteAddress $RemoteAddress -Profile Any | Out-Null
    }
}

[ordered]@{
    rules = @($Rules | ForEach-Object { [ordered]@{ name = $_.Name; port = $_.Port; purpose = $_.Purpose } })
    localAddress = $LocalAddress
    remoteAddress = $RemoteAddress
    scope = 'registry-declared peer only'
} | ConvertTo-Json -Compress
