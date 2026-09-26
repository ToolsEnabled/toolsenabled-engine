[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [string]$VaultPath,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')]
    [string]$KeyId
)

$ErrorActionPreference = 'Stop'
$ExpectedKeyId = 'custom.link_bus_bridge_token'
if ($KeyId -cne $ExpectedKeyId) {
    throw 'The offer authentication key id is not permitted.'
}

$resolvedVault = [System.IO.Path]::GetFullPath($VaultPath)
if (-not (Test-Path -LiteralPath $resolvedVault -PathType Leaf)) {
    throw 'The DPAPI vault is unavailable.'
}

$canonicalOffer = $null
$vaultText = $null
$vaultObject = $null
$cipherText = $null
$secure = $null
$pointer = [IntPtr]::Zero
$keyText = $null
$keyBytes = $null
$offerBytes = $null
$signatureBytes = $null
$hmac = $null

try {
    $canonicalOffer = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrEmpty($canonicalOffer)) {
        throw 'The canonical offer is unavailable.'
    }

    $vaultText = Get-Content -LiteralPath $resolvedVault -Raw -Encoding UTF8
    $vaultObject = $vaultText | ConvertFrom-Json -ErrorAction Stop
    $property = $vaultObject.PSObject.Properties[$KeyId]
    if ($null -eq $property -or [string]::IsNullOrEmpty([string]$property.Value)) {
        throw 'The offer authentication record is unavailable.'
    }

    $cipherText = [string]$property.Value
    $secure = ConvertTo-SecureString -String $cipherText -ErrorAction Stop
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $keyText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    if ([string]::IsNullOrEmpty($keyText)) {
        throw 'The offer authentication record is empty.'
    }

    $keyBytes = [Text.Encoding]::UTF8.GetBytes($keyText)
    $offerBytes = [Text.Encoding]::UTF8.GetBytes($canonicalOffer)
    $hmac = New-Object Security.Cryptography.HMACSHA256
    $hmac.Key = $keyBytes
    $signatureBytes = $hmac.ComputeHash($offerBytes)
    $signature = ([Convert]::ToBase64String($signatureBytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [Console]::Out.Write($signature)
} finally {
    if ($null -ne $hmac) { $hmac.Dispose() }
    if ($null -ne $keyBytes) { [Array]::Clear($keyBytes, 0, $keyBytes.Length) }
    if ($null -ne $offerBytes) { [Array]::Clear($offerBytes, 0, $offerBytes.Length) }
    if ($null -ne $signatureBytes) { [Array]::Clear($signatureBytes, 0, $signatureBytes.Length) }
    if ($pointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    $keyText = $null
    $secure = $null
    $cipherText = $null
    $vaultObject = $null
    $vaultText = $null
    $canonicalOffer = $null
}
