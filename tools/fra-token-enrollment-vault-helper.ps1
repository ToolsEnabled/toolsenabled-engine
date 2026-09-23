[CmdletBinding(PositionalBinding = $false)]
param()

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PipeSchema = 'tools-enabled.fra-token-enrollment.vault-pipe.v1'
$AuthVaultKey = 'custom.link_bus_bridge_token'
$TargetVaultKey = 'custom.full_remote_access_token'
$FingerprintDomain = 'tools-enabled.fra-token-enrollment.token-fingerprint.v1'
$MaximumFrameBytes = 96 * 1024
$MaximumVaultBytes = 16 * 1024 * 1024
$MinimumPipeNameBytes = 16
$MaximumPipeNameBytes = 160
$AuthenticatorBytes = 32
$PipeName = $null
$pipe = $null
$pipeAuthenticator = $null
$requestBytes = $null
$exitCode = 1

function Read-ExactBytes {
    param(
        [Parameter(Mandatory = $true)][System.IO.Stream]$Stream,
        [Parameter(Mandatory = $true)][int]$Count
    )
    $buffer = New-Object byte[] $Count
    $offset = 0
    try {
        while ($offset -lt $Count) {
            $read = $Stream.Read($buffer, $offset, $Count - $offset)
            if ($read -le 0) { throw 'PIPE_EOF' }
            $offset += $read
        }
        return $buffer
    } catch {
        [Array]::Clear($buffer, 0, $buffer.Length)
        throw
    }
}

function Read-PipeFrame {
    $header = $null
    try {
        $header = Read-ExactBytes -Stream $pipe -Count 4
        if (-not [BitConverter]::IsLittleEndian) { [Array]::Reverse($header) }
        $length = [BitConverter]::ToUInt32($header, 0)
        if ($length -le 0 -or $length -gt $MaximumFrameBytes) {
            throw 'PIPE_FRAME_INVALID'
        }
        return Read-ExactBytes -Stream $pipe -Count ([int]$length)
    } finally {
        if ($null -ne $header) { [Array]::Clear($header, 0, $header.Length) }
    }
}

function Read-StandardInputBootstrap {
    $stream = $null
    $lengthBytes = $null
    $nameBytes = $null
    $authenticator = $null
    try {
        $stream = [Console]::OpenStandardInput()
        $lengthBytes = Read-ExactBytes -Stream $stream -Count 4
        if (-not [BitConverter]::IsLittleEndian) { [Array]::Reverse($lengthBytes) }
        [uint32]$nameLength = [BitConverter]::ToUInt32($lengthBytes, 0)
        if ($nameLength -lt $MinimumPipeNameBytes -or $nameLength -gt $MaximumPipeNameBytes) {
            throw 'PIPE_BOOTSTRAP_INVALID'
        }
        $nameBytes = Read-ExactBytes -Stream $stream -Count ([int]$nameLength)
        $name = (New-Object Text.UTF8Encoding($false, $true)).GetString($nameBytes)
        if ($name -notmatch '^[A-Za-z0-9_.-]{16,160}$') {
            throw 'PIPE_BOOTSTRAP_INVALID'
        }
        $authenticator = Read-ExactBytes -Stream $stream -Count $AuthenticatorBytes
        if ($stream.ReadByte() -ne -1) {
            throw 'PIPE_BOOTSTRAP_INVALID'
        }
        return [pscustomobject]@{
            PipeName = $name
            Authenticator = $authenticator
        }
    } catch {
        if ($null -ne $authenticator) { [Array]::Clear($authenticator, 0, $authenticator.Length) }
        throw
    } finally {
        if ($null -ne $lengthBytes) { [Array]::Clear($lengthBytes, 0, $lengthBytes.Length) }
        if ($null -ne $nameBytes) { [Array]::Clear($nameBytes, 0, $nameBytes.Length) }
        if ($null -ne $stream) { $stream.Dispose() }
    }
}

function Test-ConstantTimeBytes {
    param(
        [Parameter(Mandatory = $true)][byte[]]$Left,
        [Parameter(Mandatory = $true)][byte[]]$Right
    )
    if ($Left.Length -ne $Right.Length) { return $false }
    [int]$difference = 0
    for ($index = 0; $index -lt $Left.Length; $index++) {
        $difference = $difference -bor ($Left[$index] -bxor $Right[$index])
    }
    return $difference -eq 0
}

function New-ProtectedPipeSecurity {
    $owner = ([Security.Principal.WindowsIdentity]::GetCurrent()).User
    if ($null -eq $owner) { throw 'PIPE_IDENTITY_INVALID' }
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $administrators = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $security = New-Object IO.Pipes.PipeSecurity
    $security.SetAccessRuleProtection($true, $false)
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $fullControl = [IO.Pipes.PipeAccessRights]::FullControl
    foreach ($identity in @($owner, $system, $administrators)) {
        $security.AddAccessRule((New-Object IO.Pipes.PipeAccessRule($identity, $fullControl, $allow)))
    }
    return $security
}

function New-ProtectedPipeServer {
    $security = New-ProtectedPipeSecurity
    return New-Object IO.Pipes.NamedPipeServerStream(
        $PipeName,
        [IO.Pipes.PipeDirection]::InOut,
        1,
        [IO.Pipes.PipeTransmissionMode]::Byte,
        [IO.Pipes.PipeOptions]::Asynchronous,
        0,
        0,
        $security
    )
}

function Write-PipeFrame {
    param([Parameter(Mandatory = $true)]$Message)
    $json = $null
    $body = $null
    $header = $null
    try {
        $json = $Message | ConvertTo-Json -Compress -Depth 12
        $body = [Text.Encoding]::UTF8.GetBytes($json)
        if ($body.Length -le 0 -or $body.Length -gt $MaximumFrameBytes) {
            throw 'PIPE_FRAME_INVALID'
        }
        $header = [BitConverter]::GetBytes([uint32]$body.Length)
        if (-not [BitConverter]::IsLittleEndian) { [Array]::Reverse($header) }
        $pipe.Write($header, 0, $header.Length)
        $pipe.Write($body, 0, $body.Length)
        $pipe.Flush()
    } finally {
        if ($null -ne $body) { [Array]::Clear($body, 0, $body.Length) }
        if ($null -ne $header) { [Array]::Clear($header, 0, $header.Length) }
        $json = $null
    }
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Names
    )
    if ($null -eq $Value -or $Value -isnot [Management.Automation.PSCustomObject]) {
        throw 'INVALID_SHAPE'
    }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $expected = @($Names | Sort-Object)
    if ($actual.Count -ne $expected.Count) { throw 'INVALID_SHAPE' }
    for ($index = 0; $index -lt $actual.Count; $index += 1) {
        if ($actual[$index] -cne $expected[$index]) { throw 'INVALID_SHAPE' }
    }
}

function Assert-KeyBinding {
    param($Value)
    if ($Value.authKeyId -cne $AuthVaultKey -or
        $Value.targetKey -cne $TargetVaultKey -or
        $Value.authKeyId -ceq $Value.targetKey) {
        throw 'KEY_BINDING_MISMATCH'
    }
}

function ConvertFrom-CanonicalBase64Url {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][int]$ExpectedBytes
    )
    if ($Value -notmatch '^[A-Za-z0-9_-]+$') { throw 'INVALID_BASE64URL' }
    $standard = $Value.Replace('-', '+').Replace('_', '/')
    while (($standard.Length % 4) -ne 0) { $standard += '=' }
    $bytes = [Convert]::FromBase64String($standard)
    $canonical = $null
    try {
        $canonical = ([Convert]::ToBase64String($bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        if ($bytes.Length -ne $ExpectedBytes -or $canonical -cne $Value) {
            throw 'INVALID_BASE64URL'
        }
        return $bytes
    } catch {
        [Array]::Clear($bytes, 0, $bytes.Length)
        throw
    } finally {
        $canonical = $null
        $standard = $null
    }
}

function ConvertTo-Base64Url {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    return ([Convert]::ToBase64String($Bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Unprotect-VaultValue {
    param([Parameter(Mandatory = $true)][string]$CipherText)
    $secure = $null
    $pointer = [IntPtr]::Zero
    try {
        $secure = ConvertTo-SecureString -String $CipherText
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
        if ($null -ne $secure) { $secure.Dispose() }
    }
}

function Protect-VaultValue {
    param([Parameter(Mandatory = $true)][string]$PlainText)
    $secure = $null
    try {
        $secure = ConvertTo-SecureString -String $PlainText -AsPlainText -Force
        return ConvertFrom-SecureString -SecureString $secure
    } finally {
        if ($null -ne $secure) { $secure.Dispose() }
    }
}

function Get-ExactVaultProperty {
    param(
        [Parameter(Mandatory = $true)]$Vault,
        [Parameter(Mandatory = $true)][string]$Name,
        [switch]$Optional
    )
    $matches = @($Vault.PSObject.Properties | Where-Object { $_.Name -ieq $Name })
    if ($matches.Count -eq 0) {
        if ($Optional) { return $null }
        throw 'VAULT_KEY_NOT_FOUND'
    }
    if ($matches.Count -ne 1 -or $matches[0].Name -cne $Name) {
        throw 'KEY_BINDING_MISMATCH'
    }
    return $matches[0]
}

function Assert-RegularFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or
        (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or
        $item.Length -le 0 -or
        $item.Length -gt $MaximumVaultBytes) {
        throw 'VAULT_FILE_INVALID'
    }
}

function Read-Vault {
    param([Parameter(Mandatory = $true)][string]$Path)
    Assert-RegularFile -Path $Path
    $raw = [IO.File]::ReadAllText($Path, (New-Object Text.UTF8Encoding($false, $true)))
    try {
        if ([string]::IsNullOrWhiteSpace($raw)) { throw 'VAULT_EMPTY' }
        $vault = $raw | ConvertFrom-Json
        if ($null -eq $vault -or $vault -isnot [Management.Automation.PSCustomObject]) {
            throw 'VAULT_INVALID'
        }
        foreach ($property in $vault.PSObject.Properties) {
            if ($property.Name -notmatch '^[A-Za-z0-9_.-]+$' -or
                $property.Value -isnot [string] -or
                [string]::IsNullOrEmpty([string]$property.Value)) {
                throw 'VAULT_RECORD_INVALID'
            }
        }
        return $vault
    } finally {
        $raw = $null
    }
}

function Get-TokenFingerprint {
    param(
        [Parameter(Mandatory = $true)][string]$Token,
        [switch]$AllowLegacyPrior
    )
    $tokenBytes = $null
    $domainBytes = $null
    $combined = $null
    $digest = $null
    $sha = $null
    try {
        try {
            $tokenBytes = ConvertFrom-CanonicalBase64Url -Value $Token -ExpectedBytes 32
        } catch {
            # The pre-transaction FRA bootstrap minted a canonical 30-byte
            # token.  It is accepted only while inspecting a slot that can
            # contain the prior value, so it can be fingerprinted, backed up,
            # and rolled back during the one-time migration.  Candidate writes
            # and every newly committed token remain strictly 32 bytes.
            if (-not $AllowLegacyPrior -or $Token.Length -ne 40) { throw }
            $tokenBytes = ConvertFrom-CanonicalBase64Url -Value $Token -ExpectedBytes 30
        }
        $domainBytes = [Text.Encoding]::UTF8.GetBytes($FingerprintDomain + [char]0)
        $combined = New-Object byte[] ($domainBytes.Length + $Token.Length)
        [Array]::Copy($domainBytes, 0, $combined, 0, $domainBytes.Length)
        $ascii = [Text.Encoding]::ASCII.GetBytes($Token)
        try {
            [Array]::Copy($ascii, 0, $combined, $domainBytes.Length, $ascii.Length)
        } finally {
            [Array]::Clear($ascii, 0, $ascii.Length)
        }
        $sha = [Security.Cryptography.SHA256]::Create()
        $digest = $sha.ComputeHash($combined)
        return ConvertTo-Base64Url -Bytes $digest
    } finally {
        if ($null -ne $sha) { $sha.Dispose() }
        foreach ($value in @($tokenBytes, $domainBytes, $combined, $digest)) {
            if ($null -ne $value) { [Array]::Clear($value, 0, $value.Length) }
        }
    }
}

function Resolve-VaultSlot {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][string]$OperationId,
        [Parameter(Mandatory = $true)][string]$Slot
    )
    if ($Role -notin @('a', 'b') -or $OperationId -notmatch '^[A-Za-z0-9_-]{22}$') {
        throw 'TRANSACTION_CONTEXT_INVALID'
    }
    $repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
    $vaultDirectory = [IO.Path]::GetFullPath((Join-Path $repoRoot 'vault'))
    $directoryItem = Get-Item -LiteralPath $vaultDirectory -Force
    if (-not $directoryItem.PSIsContainer -or
        (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'VAULT_DIRECTORY_INVALID'
    }
    $basename = 'secrets.json'
    switch ($Slot) {
        'canonical' { $leaf = $basename }
        'candidate' { $leaf = ".$basename.fra-token-enrollment.$Role.$OperationId.candidate" }
        'stagedBackup' { $leaf = ".$basename.fra-token-enrollment.$Role.$OperationId.staged-backup" }
        'backup' { $leaf = ".$basename.fra-token-enrollment.$Role.$OperationId.encrypted.bak" }
        'restore' { $leaf = ".$basename.fra-token-enrollment.$Role.$OperationId.restore" }
        'failedNew' { $leaf = ".$basename.fra-token-enrollment.$Role.$OperationId.failed-new" }
        default { throw 'VAULT_SLOT_INVALID' }
    }
    $resolved = [IO.Path]::GetFullPath((Join-Path $vaultDirectory $leaf))
    if (-not [string]::Equals(
        [IO.Path]::GetDirectoryName($resolved),
        $vaultDirectory,
        [StringComparison]::OrdinalIgnoreCase
    )) { throw 'VAULT_PATH_ESCAPE' }
    return $resolved
}

function Inspect-Target {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [switch]$AllowLegacyPrior
    )
    $vault = Read-Vault -Path $Path
    $property = Get-ExactVaultProperty -Vault $vault -Name $TargetVaultKey -Optional
    if ($null -eq $property) {
        return [ordered]@{ exists = $false; fingerprint = $null }
    }
    $plainText = $null
    try {
        $plainText = Unprotect-VaultValue -CipherText ([string]$property.Value)
        if ($null -eq $plainText) { throw 'VAULT_DECRYPT_FAILED' }
        return [ordered]@{
            exists = $true
            fingerprint = Get-TokenFingerprint -Token $plainText -AllowLegacyPrior:$AllowLegacyPrior
        }
    } finally {
        $plainText = $null
    }
}

function Set-CandidateToken {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Token
    )
    $validatedToken = $null
    $random = $null
    $rng = $null
    $validatedToken = ConvertFrom-CanonicalBase64Url -Value $Token -ExpectedBytes 32
    $vault = Read-Vault -Path $Path
    $property = Get-ExactVaultProperty -Vault $vault -Name $TargetVaultKey -Optional
    $cipherText = $null
    $json = $null
    $bytes = $null
    $temporary = $null
    $replaceBackup = $null
    $stream = $null
    $phase = 'VALIDATE'
    try {
        $phase = 'PROTECT'
        $cipherText = Protect-VaultValue -PlainText $Token
        if ($null -eq $property) {
            $vault | Add-Member -MemberType NoteProperty -Name $TargetVaultKey -Value $cipherText
        } else {
            $property.Value = $cipherText
        }
        $phase = 'ENCODE'
        $json = $vault | ConvertTo-Json -Compress -Depth 4
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes($json)
        if ($bytes.Length -le 0 -or $bytes.Length -gt $MaximumVaultBytes) {
            throw 'VAULT_WRITE_INVALID'
        }
        $phase = 'TEMP_NAME'
        $random = New-Object byte[] 12
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($random)
        $suffix = -join ($random | ForEach-Object { $_.ToString('x2') })
        $temporary = "$Path.fra-pipe-write.$suffix"
        $replaceBackup = "$Path.fra-pipe-old.$suffix"
        $suffix = $null
        $phase = 'TEMP_WRITE'
        $stream = New-Object IO.FileStream(
            $temporary,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::None,
            4096,
            [IO.FileOptions]::WriteThrough
        )
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        $stream.Dispose()
        $stream = $null
        $phase = 'ACL'
        Set-Acl -LiteralPath $temporary -AclObject (Get-Acl -LiteralPath $Path)
        $phase = 'REPLACE'
        [IO.File]::Replace($temporary, $Path, $replaceBackup, $true)
        $temporary = $null
        [IO.File]::Delete($replaceBackup)
        $replaceBackup = $null
        $phase = 'FINGERPRINT'
        return Get-TokenFingerprint -Token $Token
    } catch {
        if ($_.Exception.Message -match '^[A-Z0-9_]{1,80}$') { throw }
        throw "SET_CANDIDATE_$phase"
    } finally {
        if ($null -ne $rng) { $rng.Dispose() }
        foreach ($value in @($validatedToken, $random)) {
            if ($null -ne $value) { [Array]::Clear($value, 0, $value.Length) }
        }
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        if ($null -ne $temporary -and [IO.File]::Exists($temporary)) {
            [IO.File]::Delete($temporary)
        }
        if ($null -ne $replaceBackup -and [IO.File]::Exists($replaceBackup)) {
            [IO.File]::Delete($replaceBackup)
        }
        $cipherText = $null
        $json = $null
    }
}

function Sign-Canonical {
    param([Parameter(Mandatory = $true)][string]$CanonicalBase64Url)
    $canonical = $null
    $vault = $null
    $plainText = $null
    $keyBytes = $null
    $hmac = $null
    $proof = $null
    try {
        if ($CanonicalBase64Url -notmatch '^[A-Za-z0-9_-]+$') {
            throw 'SIGN_INPUT_INVALID'
        }
        $standard = $CanonicalBase64Url.Replace('-', '+').Replace('_', '/')
        while (($standard.Length % 4) -ne 0) { $standard += '=' }
        $canonical = [Convert]::FromBase64String($standard)
        if ($canonical.Length -le 0 -or $canonical.Length -gt 32 * 1024 -or
            (ConvertTo-Base64Url -Bytes $canonical) -cne $CanonicalBase64Url) {
            throw 'SIGN_INPUT_INVALID'
        }
        $canonicalPath = Resolve-VaultSlot -Role 'a' -OperationId ('A' * 22) -Slot 'canonical'
        $vault = Read-Vault -Path $canonicalPath
        $property = Get-ExactVaultProperty -Vault $vault -Name $AuthVaultKey
        $plainText = Unprotect-VaultValue -CipherText ([string]$property.Value)
        if ([string]::IsNullOrEmpty($plainText) -or $plainText.Length -lt 16 -or $plainText.Length -gt 4096) {
            throw 'AUTH_KEY_INVALID'
        }
        $keyBytes = [Text.Encoding]::UTF8.GetBytes($plainText)
        $hmac = New-Object Security.Cryptography.HMACSHA256 -ArgumentList (, $keyBytes)
        $proof = $hmac.ComputeHash($canonical)
        return ConvertTo-Base64Url -Bytes $proof
    } finally {
        if ($null -ne $hmac) { $hmac.Dispose() }
        foreach ($value in @($canonical, $keyBytes, $proof)) {
            if ($null -ne $value) { [Array]::Clear($value, 0, $value.Length) }
        }
        $plainText = $null
    }
}

try {
    $bootstrap = Read-StandardInputBootstrap
    $PipeName = [string]$bootstrap.PipeName
    $pipeAuthenticator = $bootstrap.Authenticator
    $bootstrap = $null
    $pipe = New-ProtectedPipeServer
    $pipe.WaitForConnection()
    $receivedAuthenticator = Read-PipeFrame
    try {
        if ($receivedAuthenticator.Length -ne $AuthenticatorBytes -or
            -not (Test-ConstantTimeBytes -Left $receivedAuthenticator -Right $pipeAuthenticator)) {
            throw 'PIPE_AUTH_INVALID'
        }
    } finally {
        if ($null -ne $receivedAuthenticator) { [Array]::Clear($receivedAuthenticator, 0, $receivedAuthenticator.Length) }
        [Array]::Clear($pipeAuthenticator, 0, $pipeAuthenticator.Length)
        $pipeAuthenticator = $null
    }
    $requestBytes = Read-PipeFrame
    $requestText = (New-Object Text.UTF8Encoding($false, $true)).GetString($requestBytes)
    try {
        $request = $requestText | ConvertFrom-Json
    } finally {
        $requestText = $null
        [Array]::Clear($requestBytes, 0, $requestBytes.Length)
        $requestBytes = $null
    }
    if ($request.schemaVersion -cne $PipeSchema) { throw 'SCHEMA_MISMATCH' }

    switch ([string]$request.action) {
        'sign' {
            Assert-ExactProperties -Value $request -Names @(
                'schemaVersion', 'action', 'authKeyId', 'targetKey', 'canonicalBase64Url'
            )
            Assert-KeyBinding -Value $request
            $proof = Sign-Canonical -CanonicalBase64Url ([string]$request.canonicalBase64Url)
            Write-PipeFrame -Message ([ordered]@{
                schemaVersion = $PipeSchema
                ok = $true
                action = 'sign'
                authKeyId = $AuthVaultKey
                proof = $proof
            })
            $proof = $null
        }
        'inspect' {
            Assert-ExactProperties -Value $request -Names @(
                'schemaVersion', 'action', 'authKeyId', 'targetKey', 'role', 'operationId', 'slot'
            )
            Assert-KeyBinding -Value $request
            $slot = [string]$request.slot
            $targetPath = Resolve-VaultSlot -Role ([string]$request.role) -OperationId ([string]$request.operationId) -Slot $slot
            $allowLegacyPrior = $slot -in @('canonical', 'stagedBackup', 'backup', 'restore')
            $inspection = Inspect-Target -Path $targetPath -AllowLegacyPrior:$allowLegacyPrior
            Write-PipeFrame -Message ([ordered]@{
                schemaVersion = $PipeSchema
                ok = $true
                action = 'inspect'
                targetKey = $TargetVaultKey
                exists = $inspection.exists
                fingerprint = $inspection.fingerprint
            })
            $inspection = $null
        }
        'set_candidate' {
            Assert-ExactProperties -Value $request -Names @(
                'schemaVersion', 'action', 'authKeyId', 'targetKey', 'role', 'operationId', 'tokenBase64Url'
            )
            Assert-KeyBinding -Value $request
            $candidatePath = Resolve-VaultSlot -Role ([string]$request.role) -OperationId ([string]$request.operationId) -Slot 'candidate'
            $fingerprint = Set-CandidateToken -Path $candidatePath -Token ([string]$request.tokenBase64Url)
            $request.tokenBase64Url = ''
            Write-PipeFrame -Message ([ordered]@{
                schemaVersion = $PipeSchema
                ok = $true
                action = 'set_candidate'
                targetKey = $TargetVaultKey
                fingerprint = $fingerprint
            })
            $fingerprint = $null
        }
        default { throw 'ACTION_INVALID' }
    }
    $exitCode = 0
} catch {
    $safeErrorCode = 'VAULT_HELPER_FAILED'
    if ($_.Exception.Message -match '^[A-Z0-9_]{1,80}$') {
        $safeErrorCode = $_.Exception.Message
    }
    try {
        if ($null -ne $pipe -and $pipe.IsConnected) {
            Write-PipeFrame -Message ([ordered]@{
                schemaVersion = $PipeSchema
                ok = $false
                errorCode = $safeErrorCode
            })
        }
    } catch {
        # Parent treats a missing/malformed response as a terminal failure.
    }
    $safeErrorCode = $null
    $exitCode = 2
} finally {
    if ($null -ne $pipeAuthenticator) {
        [Array]::Clear($pipeAuthenticator, 0, $pipeAuthenticator.Length)
    }
    if ($null -ne $requestBytes) {
        [Array]::Clear($requestBytes, 0, $requestBytes.Length)
    }
    $request = $null
    if ($null -ne $pipe) { $pipe.Dispose() }
}

exit $exitCode
