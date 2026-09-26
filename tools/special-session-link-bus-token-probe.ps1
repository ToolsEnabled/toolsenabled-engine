#requires -Version 5.1
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Health', 'Authenticated')]
    [string]$Mode,

    [Parameter(Mandatory = $false)]
    [string]$VaultPath,

    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')]
    [string]$KeyId
)

# Secret-contained recipient -> coordinator relay probe. The DPAPI plaintext is
# used only in this process and the only successful stdout is a three-digit
# HTTP status code.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expectedKeyId = 'custom.link_bus_bridge_token'
$repoRoot = Split-Path -Parent $PSScriptRoot
$vaultDirectory = [IO.Path]::GetFullPath((Join-Path $repoRoot 'vault'))
$response = $null
$request = $null
$secure = $null
$pointer = [IntPtr]::Zero
$token = $null
$vaultText = $null
$vaultObject = $null
$cipherText = $null
$statusCode = 0
$exitCode = 2

try {
    # THE PROBE TARGET IS RESOLVED, NOT HARDCODED (R1116/R1117). Both URIs
    # below used to embed one builder machine's direct-link address as an IPv4 literal.
    # This probe runs on the recipient and deliberately dials the coordinator's
    # 8787 listener, so the target is the directional registry role -- not the
    # 'self' or 'fixed' link-bus service roles, which resolve to the wrong end
    # here.
    # config/service-registry.json is the only source; the reader fails closed,
    # so an unreadable/malformed registry or an unknown machine id throws into
    # the catch below and exits 2 with no probe attempted. The port stays a
    # literal: it is a protocol constant, not a property of the network this
    # machine happens to be plugged into.
    $registryHelper = Join-Path $repoRoot 'tools\lib\service-registry.ps1'
    if (-not (Test-Path -LiteralPath $registryHelper -PathType Leaf)) {
        throw 'SERVICE_REGISTRY_UNAVAILABLE'
    }
    . $registryHelper
    $topology = Resolve-ServiceRegistryDirectionalTopology -Root $repoRoot
    if ([string]$topology.localRole -cne 'recipient') {
        throw 'LINK_BUS_ROTATION_RECIPIENT_REQUIRED'
    }
    $coordinatorAddress = [string]$topology.coordinatorMachine.address
    if (-not (Test-ServiceRegistryIPv4 -Address $coordinatorAddress)) {
        throw 'SERVICE_MACHINE_ADDRESS_INVALID'
    }
    $relayOrigin = 'http://' + $coordinatorAddress + ':8787'
    if ($Mode -ceq 'Health') {
        if ($PSBoundParameters.ContainsKey('VaultPath') -or
            $PSBoundParameters.ContainsKey('KeyId')) {
            throw 'health_probe_forbids_vault_arguments'
        }
        $uri = $relayOrigin + '/health'
    } else {
        if ([string]::IsNullOrWhiteSpace($VaultPath) -or
            $KeyId -cne $expectedKeyId) {
            throw 'authenticated_probe_arguments_invalid'
        }
        $resolvedVault = [IO.Path]::GetFullPath($VaultPath)
        if (-not [string]::Equals(
            [IO.Path]::GetDirectoryName($resolvedVault),
            $vaultDirectory,
            [StringComparison]::OrdinalIgnoreCase
        )) {
            throw 'vault_path_outside_fixed_directory'
        }
        $vaultItem = Get-Item -LiteralPath $resolvedVault -Force -ErrorAction Stop
        if ($vaultItem.PSIsContainer -or
            (($vaultItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
            $vaultItem.Length -le 0 -or
            $vaultItem.Length -gt (12 * 1024 * 1024)) {
            throw 'vault_file_invalid'
        }
        $vaultText = [IO.File]::ReadAllText(
            $resolvedVault,
            (New-Object Text.UTF8Encoding($false, $true))
        )
        $vaultObject = $vaultText | ConvertFrom-Json -ErrorAction Stop
        $property = $vaultObject.PSObject.Properties[$KeyId]
        if ($null -eq $property -or
            [string]::IsNullOrEmpty([string]$property.Value)) {
            throw 'vault_key_unavailable'
        }
        $cipherText = [string]$property.Value
        $secure = ConvertTo-SecureString -String $cipherText -ErrorAction Stop
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ([string]::IsNullOrEmpty($token) -or
            $token.Length -lt 16 -or $token.Length -gt 4096 -or
            $token.Contains("`r") -or $token.Contains("`n")) {
            throw 'vault_token_invalid'
        }
        $uri = $relayOrigin + '/v1/messages?channel=rotation-probe&cursor=0&limit=1'
    }

    $request = [Net.HttpWebRequest]::Create($uri)
    $request.Method = 'GET'
    $request.Proxy = $null
    $request.KeepAlive = $false
    $request.Timeout = 5000
    $request.ReadWriteTimeout = 5000
    if ($Mode -ceq 'Authenticated') {
        $request.Headers[[Net.HttpRequestHeader]::Authorization] = 'Bearer ' + $token
    }
    try {
        $response = $request.GetResponse()
        $statusCode = [int]$response.StatusCode
    } catch [Net.WebException] {
        if ($null -eq $_.Exception.Response) { throw }
        $response = $_.Exception.Response
        $statusCode = [int]$response.StatusCode
    }
    if ($statusCode -lt 100 -or $statusCode -gt 599) {
        throw 'http_status_invalid'
    }
    [Console]::Out.Write($statusCode.ToString('D3', [Globalization.CultureInfo]::InvariantCulture))
    $exitCode = 0
} catch {
    $exitCode = 2
} finally {
    if ($null -ne $response) { $response.Dispose() }
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    if ($null -ne $secure) { $secure.Dispose() }
    $token = $null
    $cipherText = $null
    $vaultObject = $null
    $vaultText = $null
    $request = $null
}

exit $exitCode
