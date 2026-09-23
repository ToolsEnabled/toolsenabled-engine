# Shared fail-closed PowerShell reader for sanctioned machine addresses.
# The address set comes only from config/service-registry.json. There is no
# subnet fallback, localhost fallback, or accept-all path.

function Test-ServiceRegistryIPv4 {
    param([AllowNull()][string]$Address)
    if ([string]::IsNullOrEmpty($Address) -or
        $Address -notmatch '^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$') {
        return $false
    }
    foreach ($part in $Address.Split('.')) {
        if ([int]$part -gt 255) { return $false }
    }
    return $true
}

function Read-ToolsEnabledServiceRegistry {
    param([Parameter(Mandatory)][string]$Root)
    $registryPath = Join-Path ([IO.Path]::GetFullPath($Root)) 'config\service-registry.json'
    try {
        if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
            throw 'SERVICE_REGISTRY_UNAVAILABLE'
        }
        $raw = [IO.File]::ReadAllText($registryPath, [Text.Encoding]::UTF8)
    } catch {
        if ([string]$_.Exception.Message -eq 'SERVICE_REGISTRY_UNAVAILABLE') { throw }
        throw 'SERVICE_REGISTRY_UNAVAILABLE'
    }
    try { $registry = $raw | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'SERVICE_REGISTRY_INVALID' }
    if (-not $registry -or [int]$registry.schemaVersion -ne 1 -or
        $null -eq $registry.machines -or $null -eq $registry.services) {
        throw 'SERVICE_REGISTRY_INVALID'
    }
    $machineProperties = @($registry.machines.PSObject.Properties)
    if ($machineProperties.Count -eq 0) { throw 'SERVICE_REGISTRY_EMPTY' }
    $seen = @{}
    $machines = @()
    foreach ($property in $machineProperties) {
        $machine = $property.Value
        $address = [string]$machine.address
        if (-not $machine -or -not (Test-ServiceRegistryIPv4 -Address $address)) {
            throw 'SERVICE_REGISTRY_INVALID'
        }
        if ($seen.ContainsKey($address)) { throw 'SERVICE_REGISTRY_INVALID' }
        $seen[$address] = $true
        $machines += [pscustomobject]@{
            machineId = [string]$property.Name
            address = $address
            root = if ($null -ne $machine.root) { [string]$machine.root } else { $null }
            role = if ($null -ne $machine.role) { [string]$machine.role } else { $null }
        }
    }
    $resolutionKinds = @('fixed', 'peer', 'self', 'loopback')
    foreach ($property in @($registry.services.PSObject.Properties)) {
        $service = $property.Value
        $resolution = [string]$service.resolution
        $port = 0
        if (-not $service -or $resolution -cnotin $resolutionKinds -or
            -not [int]::TryParse([string]$service.port, [ref]$port) -or
            $port -lt 1 -or $port -gt 65535 -or [double]$service.port -ne [double]$port) {
            throw 'SERVICE_REGISTRY_INVALID'
        }
        if ($resolution -ceq 'fixed' -and -not ($machineProperties.Name -ccontains [string]$service.fixedMachine)) {
            throw 'SERVICE_REGISTRY_INVALID'
        }
        if ($service.PSObject.Properties.Name -ccontains 'healthPort') {
            $healthPort = 0
            if (-not [int]::TryParse([string]$service.healthPort, [ref]$healthPort) -or
                $healthPort -lt 1 -or $healthPort -gt 65535 -or
                [double]$service.healthPort -ne [double]$healthPort) {
                throw 'SERVICE_REGISTRY_INVALID'
            }
        }
    }
    return [pscustomobject]@{
        path = $registryPath
        registry = $registry
        machines = @($machines)
        addresses = @($machines | ForEach-Object { $_.address })
    }
}

function Get-ServiceRegistryMachineById {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$MachineId
    )
    $policy = Read-ToolsEnabledServiceRegistry -Root $Root
    $matches = @($policy.machines | Where-Object { $_.machineId -ceq $MachineId })
    if ($matches.Count -ne 1) { throw 'SERVICE_MACHINE_UNKNOWN' }
    return $matches[0]
}

function Get-ServiceRegistryServiceById {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$ServiceId
    )
    $policy = Read-ToolsEnabledServiceRegistry -Root $Root
    $matches = @($policy.registry.services.PSObject.Properties | Where-Object { $_.Name -ceq $ServiceId })
    if ($matches.Count -ne 1) { throw 'SERVICE_UNKNOWN' }
    return $matches[0].Value
}

function Resolve-ServiceRegistryTopology {
    param(
        [Parameter(Mandatory)][string]$Root,
        [AllowNull()][string]$ConfiguredAddress = $null,
        [AllowNull()][string[]]$NetworkAddresses = $null
    )
    $policy = Read-ToolsEnabledServiceRegistry -Root $Root
    if (-not [string]::IsNullOrEmpty($ConfiguredAddress)) {
        if (-not (Test-ServiceRegistryIPv4 -Address $ConfiguredAddress)) {
            throw 'SERVICE_MACHINE_ADDRESS_INVALID'
        }
        $localMatches = @($policy.machines | Where-Object { $_.address -ceq $ConfiguredAddress })
        if ($localMatches.Count -ne 1) { throw 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED' }
    } else {
        if ($null -eq $NetworkAddresses) {
            $NetworkAddresses = @(
                Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                    Select-Object -ExpandProperty IPAddress -Unique
            )
        }
        $localMatches = @($policy.machines | Where-Object { $NetworkAddresses -ccontains $_.address })
        if ($localMatches.Count -ne 1) { throw 'SERVICE_LOCAL_MACHINE_UNKNOWN' }
    }
    $localMachine = $localMatches[0]
    $peerMatches = @($policy.machines | Where-Object { $_.machineId -cne $localMachine.machineId })
    if ($peerMatches.Count -ne 1) { throw 'SERVICE_PEER_UNDETERMINED' }
    return [pscustomobject]@{
        policy = $policy
        localMachine = $localMachine
        peerMachine = $peerMatches[0]
    }
}

function Convert-ServiceRegistryIPv4ToUInt64 {
    param([Parameter(Mandatory)][string]$Address)
    if (-not (Test-ServiceRegistryIPv4 -Address $Address)) { throw 'SERVICE_MACHINE_ADDRESS_INVALID' }
    $parts = @($Address.Split('.') | ForEach-Object { [uint64][int]$_ })
    return $parts[0] * 16777216 + $parts[1] * 65536 + $parts[2] * 256 + $parts[3]
}

function Resolve-ServiceRegistryDirectionalTopology {
    param(
        [Parameter(Mandatory)][string]$Root,
        [AllowNull()][string]$ConfiguredAddress = $null,
        [AllowNull()][string[]]$NetworkAddresses = $null
    )
    $topology = Resolve-ServiceRegistryTopology -Root $Root -ConfiguredAddress $ConfiguredAddress -NetworkAddresses $NetworkAddresses
    $machines = @($topology.policy.machines)
    if ($machines.Count -ne 2) { throw 'SERVICE_PEER_UNDETERMINED' }
    $ordered = @($machines | Sort-Object @{ Expression = { Convert-ServiceRegistryIPv4ToUInt64 -Address $_.address } })
    $coordinator = $ordered[0]
    $recipient = $ordered[1]
    return [pscustomobject]@{
        policy = $topology.policy
        localMachine = $topology.localMachine
        peerMachine = $topology.peerMachine
        coordinatorMachine = $coordinator
        recipientMachine = $recipient
        localRole = if ($topology.localMachine.machineId -ceq $coordinator.machineId) { 'coordinator' } else { 'recipient' }
    }
}
