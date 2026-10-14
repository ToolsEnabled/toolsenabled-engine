# Lifecycle management for the existing ToolsEnabled DPAPI vault.
# Secret values are accepted only on stdin and are never written to output.
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('add','replace','rotate','remove','inventory','history')]
    [string]$Action,

    [Parameter(Mandatory = $false)]
    [string]$Name,

    [Parameter(Mandatory = $false)]
    [string]$Reason,

    [Parameter(Mandatory = $false)]
    [string]$ExpiresAt,

    [Parameter(Mandatory = $false)]
    [int]$StaleAfterDays = -1,

    [Parameter(Mandatory = $false)]
    [ValidateRange(0, 3650)]
    [int]$ExpiringWithinDays = 30,

    [Parameter(Mandatory = $false)]
    [string]$AsOf
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Create-and-fence the credential store as one act. See tools/lib/vault-acl.ps1:
# before this, the vault was created with a bare New-Item and inherited whatever
# the install location granted -- measured on a real install as
# CodexSandboxUsers:(I)(RX) on secrets.json itself.
. (Join-Path $PSScriptRoot 'lib/vault-acl.ps1')
$MetadataKey = 'toolsenabled_secret_lifecycle_v1'
$MetadataSchemaVersion = 1
$HistoryLimit = 64
$ExpirySupplied = $PSBoundParameters.ContainsKey('ExpiresAt')
$StaleAfterDaysSupplied = $PSBoundParameters.ContainsKey('StaleAfterDays')

# WHERE THE VAULT FILE IS, IN PRECEDENCE ORDER. Identical to tools/secrets.ps1,
# and it has to be: that script and this one are the two halves of ONE vault.
#   1. TOOLSENABLED_VAULT_PATH. src/lib/runtime.js and src/lib/secret-store
#      both publish this into the environment of every spawn whenever the vault
#      has moved, so the JavaScript half and this script always name the same
#      file. That is the branch that runs in the installed product.
#   2. TOOLSENABLED_STATE_ROOT. The safety net for a hand-run invocation under a
#      shell that set the state root but not the vault path. This branch was
#      missing here while tools/secrets.ps1 had it, so with only the state root
#      set the write half used <stateRoot>\vault\secrets.json and this half used
#      <programDir>\vault\secrets.json -- two different files. What that looks
#      like to a person is `node tools/secret-doctor.js` reporting every
#      integration "not configured" while the credentials they just entered sit
#      in the vault, and it is the silent direction of the failure: the fallback
#      does not error, it opens and decrypt-tests whatever vault happens to lie
#      beside the program directory. Pinned by tests/secrets/vault-path-agreement.js.
#   3. The repository. A source checkout keeps the vault where it has always been.
$configuredVault = [Environment]::GetEnvironmentVariable('TOOLSENABLED_VAULT_PATH')
$configuredStateRoot = [Environment]::GetEnvironmentVariable('TOOLSENABLED_STATE_ROOT')
if ([string]::IsNullOrWhiteSpace($configuredVault)) {
    if (-not [string]::IsNullOrWhiteSpace($configuredStateRoot)) {
        $resolvedStateRoot = [System.IO.Path]::GetFullPath(
            [Environment]::ExpandEnvironmentVariables($configuredStateRoot)
        )
        $VaultFile = Join-Path (Join-Path $resolvedStateRoot 'vault') 'secrets.json'
    } else {
        $VaultFile = Join-Path (Join-Path $RepoRoot 'vault') 'secrets.json'
    }
} else {
    $VaultFile = [System.IO.Path]::GetFullPath(
        [Environment]::ExpandEnvironmentVariables($configuredVault)
    )
}
$VaultDir = Split-Path -Parent $VaultFile
if ([string]::IsNullOrWhiteSpace($VaultDir)) {
    throw 'Vault path must include a parent directory.'
}
$VaultLockFile = $VaultFile + '.lock'
# WHERE THE COMPILED ATOMIC-REPLACEMENT TYPE IS KEPT BETWEEN PROCESSES.
# See tools/lib/vault-acl.ps1 Install-VaultAtomicFileType. It follows the same
# rule as the vault file above -- the per-user state root when one is named,
# the repository otherwise -- and sits beside the host.exec wrapper's cache
# (state/windows-job-wrapper-cache), never inside the vault directory: a loaded
# DLL cannot be deleted while any vault process maps it, and the vault
# directory must stay removable by the product's own local-data reset.
$VaultAssemblyCacheDirectory = if (-not [string]::IsNullOrWhiteSpace($configuredStateRoot)) {
    Join-Path (Join-Path ([System.IO.Path]::GetFullPath(
        [Environment]::ExpandEnvironmentVariables($configuredStateRoot)
    )) 'state') 'vault-atomic-file-cache'
} else {
    Join-Path (Join-Path $RepoRoot 'state') 'vault-atomic-file-cache'
}
$VaultLockTimeoutMs = 30000
$configuredLockTimeout = [Environment]::GetEnvironmentVariable('TOOLSENABLED_VAULT_LOCK_TIMEOUT_MS')
if (-not [string]::IsNullOrWhiteSpace($configuredLockTimeout)) {
    $parsedLockTimeout = 0
    if (-not [int]::TryParse($configuredLockTimeout, [ref]$parsedLockTimeout) -or
        $parsedLockTimeout -lt 100 -or $parsedLockTimeout -gt 30000) {
        throw 'TOOLSENABLED_VAULT_LOCK_TIMEOUT_MS must be an integer from 100 through 30000.'
    }
    $VaultLockTimeoutMs = $parsedLockTimeout
}

function Throw-ManagerError {
    param(
        [string]$Code,
        [string]$Message,
        [string]$SecretName
    )
    $exception = New-Object System.Exception($Message)
    $exception.Data['Code'] = $Code
    if (-not [string]::IsNullOrWhiteSpace($SecretName)) {
        $exception.Data['SecretName'] = $SecretName
    }
    throw $exception
}

function Assert-SecretName {
    param([string]$Candidate)
    if ([string]::IsNullOrWhiteSpace($Candidate) -or
        $Candidate -notmatch '^[A-Za-z0-9_.-]+$') {
        Throw-ManagerError 'SECRET_NAME_INVALID' 'Secret name may contain only letters, digits, dot, underscore, and hyphen.' $Candidate
    }
    if ($Candidate -eq $MetadataKey) {
        Throw-ManagerError 'SECRET_RESERVED_NAME' 'The requested name is reserved for lifecycle metadata.' $Candidate
    }
}

function Assert-Reason {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) {
        Throw-ManagerError 'SECRET_REASON_REQUIRED' 'A non-empty reason is required for this lifecycle operation.' $Name
    }
    if ($Value.Length -gt 500 -or [regex]::IsMatch($Value, '[\x00-\x1F\x7F]')) {
        Throw-ManagerError 'SECRET_REASON_INVALID' 'The reason must be at most 500 characters and contain no control characters.' $Name
    }
}

function ConvertTo-Hashtable {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        $result = @{}
        foreach ($key in $Value.Keys) { $result[[string]$key] = ConvertTo-Hashtable $Value[$key] }
        return $result
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $result = @{}
        foreach ($property in $Value.PSObject.Properties) {
            $result[$property.Name] = ConvertTo-Hashtable $property.Value
        }
        return $result
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return @($Value | ForEach-Object { ConvertTo-Hashtable $_ })
    }
    return $Value
}

function Read-Vault {
    if (-not (Test-Path -LiteralPath $VaultFile)) { return @{} }
    try {
        $raw = Get-Content -LiteralPath $VaultFile -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($raw)) { return @{} }
        $object = $raw | ConvertFrom-Json
        if ($null -eq $object -or
            ($object -isnot [System.Management.Automation.PSCustomObject] -and
             $object -isnot [System.Collections.IDictionary])) {
            Throw-ManagerError 'SECRET_STORE_INVALID' 'The local secret store must contain a JSON object.' $null
        }
        $result = @{}
        foreach ($property in $object.PSObject.Properties) {
            $result[$property.Name] = [string]$property.Value
        }
        return $result
    } catch {
        Throw-ManagerError 'SECRET_STORE_INVALID' 'The local secret store could not be parsed.' $null
    }
}

function Write-Vault {
    param([hashtable]$Data)
    Initialize-ProtectedVaultStore -Path $VaultDir
    Remove-LegacyVaultReplacementBackups -VaultPath $VaultFile
    $temporary = Join-Path $VaultDir ('.' + [System.IO.Path]::GetFileName($VaultFile) + '.' +
        $PID + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    try {
        $json = ($Data | ConvertTo-Json -Depth 16) + [Environment]::NewLine
        # Flush the DATA to disk before the write-through rename below -- this is
        # the OTHER half of the same vault file tools/secrets.ps1 writes, and it
        # must be crash-safe the same way. Measured 2026-09-02: a hard power loss
        # after WriteAllText + MoveFileEx left vault/secrets.json as 4,352 bytes
        # of NUL (directory entry durable, pages not). Flush($true) is
        # FlushFileBuffers; the rename's MOVEFILE_WRITE_THROUGH (in
        # Move-VaultFileAtomically below) covers only the name, never the bytes.
        # That fix landed in tools/secrets.ps1 (commit 9a6c79c) but was never
        # ported here, so every lifecycle mutation -- add, replace, rotate,
        # remove -- still risked leaving the exact same all-NUL vault behind on
        # a crash mid-write.
        $bytes = $utf8WithoutBom.GetBytes($json)
        $stream = New-Object System.IO.FileStream($temporary, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }
        if (Test-Path -LiteralPath $VaultFile) {
            # The shared native helper atomically replaces without creating a
            # full pre-mutation vault backup beside the canonical store.
            Move-VaultFileAtomically -Source $temporary -Destination $VaultFile `
                -AssemblyCacheDirectory $VaultAssemblyCacheDirectory
        } else {
            [System.IO.File]::Move($temporary, $VaultFile)
        }
        # Explicit, not inherited: see tools/lib/vault-acl.ps1.
        Protect-VaultPath -Path $VaultFile
    } catch {
        Throw-ManagerError 'SECRET_STORE_IO_FAILED' 'The local secret store could not be updated atomically.' $Name
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Invoke-WithVaultLock {
    param([scriptblock]$Operation)
    Initialize-ProtectedVaultStore -Path $VaultDir
    $deadline = [DateTime]::UtcNow.AddMilliseconds($VaultLockTimeoutMs)
    $lockStream = $null
    try {
        while ($null -eq $lockStream) {
            try {
                $lockStream = New-Object System.IO.FileStream(
                    $VaultLockFile,
                    [System.IO.FileMode]::OpenOrCreate,
                    [System.IO.FileAccess]::ReadWrite,
                    [System.IO.FileShare]::None
                )
            } catch [System.IO.IOException] {
                if ([DateTime]::UtcNow -ge $deadline) {
                    Throw-ManagerError 'SECRET_STORE_LOCK_TIMEOUT' 'Timed out waiting for exclusive access to the local secret store.' $Name
                }
                Start-Sleep -Milliseconds (Get-Random -Minimum 20 -Maximum 61)
            }
        }
        & $Operation
    } finally {
        if ($null -ne $lockStream) { $lockStream.Dispose() }
    }
}

function Protect-PlainText {
    param([string]$PlainText)
    $secure = ConvertTo-SecureString -String $PlainText -AsPlainText -Force
    return ConvertFrom-SecureString -SecureString $secure
}

function Unprotect-CipherText {
    param([string]$CipherText)
    $secure = ConvertTo-SecureString -String $CipherText
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        }
    }
}

function New-Metadata {
    return @{
        schemaVersion = $MetadataSchemaVersion
        revision = 0
        entries = @{}
    }
}

function Read-Metadata {
    param([hashtable]$Data)
    if (-not $Data.ContainsKey($MetadataKey)) { return New-Metadata }
    $plain = $null
    try {
        $plain = Unprotect-CipherText $Data[$MetadataKey]
        $parsed = ConvertTo-Hashtable ($plain | ConvertFrom-Json)
    } catch {
        Throw-ManagerError 'SECRET_METADATA_INVALID' 'Lifecycle metadata could not be decrypted or parsed.' $null
    } finally {
        $plain = $null
    }
    if ($null -eq $parsed -or $parsed.schemaVersion -ne $MetadataSchemaVersion -or
        $parsed.revision -isnot [int] -and $parsed.revision -isnot [long] -or
        $parsed.revision -lt 0 -or $parsed.entries -isnot [hashtable]) {
        Throw-ManagerError 'SECRET_METADATA_INVALID' 'Lifecycle metadata has an unsupported or invalid shape.' $null
    }
    return $parsed
}

function Write-MetadataIntoVault {
    param(
        [hashtable]$Data,
        [hashtable]$Metadata
    )
    $Metadata.revision = [long]$Metadata.revision + 1
    $json = $Metadata | ConvertTo-Json -Depth 16 -Compress
    $Data[$MetadataKey] = Protect-PlainText $json
}

function Parse-UtcTimestamp {
    param(
        [string]$Value,
        [string]$ErrorCode,
        [string]$Message
    )
    $parsed = [DateTimeOffset]::MinValue
    if ([string]::IsNullOrWhiteSpace($Value) -or
        -not [DateTimeOffset]::TryParse(
            $Value,
            [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::AssumeUniversal,
            [ref]$parsed
        )) {
        Throw-ManagerError $ErrorCode $Message $Name
    }
    return $parsed.ToUniversalTime()
}

function Utc-Text {
    param([DateTimeOffset]$Value)
    return $Value.ToUniversalTime().ToString('o', [Globalization.CultureInfo]::InvariantCulture)
}

function Resolve-Expiry {
    param(
        [bool]$Supplied,
        $Existing,
        [DateTimeOffset]$Now
    )
    if (-not $Supplied) { return $Existing }
    $parsed = Parse-UtcTimestamp $ExpiresAt 'SECRET_EXPIRY_INVALID' 'Expiry must be a valid future timestamp.'
    if ($parsed -le $Now) {
        Throw-ManagerError 'SECRET_EXPIRY_INVALID' 'Expiry must be a valid future timestamp.' $Name
    }
    return Utc-Text $parsed
}

function Resolve-StaleDays {
    param(
        [bool]$Supplied,
        $Existing
    )
    if (-not $Supplied) { return $Existing }
    if ($StaleAfterDays -lt 0 -or $StaleAfterDays -gt 3650) {
        Throw-ManagerError 'SECRET_STALENESS_INVALID' 'Stale-after days must be from 0 through 3650.' $Name
    }
    if ($StaleAfterDays -eq 0) { return $null }
    return $StaleAfterDays
}

function Add-History {
    param(
        [hashtable]$Record,
        [string]$Operation,
        [string]$At,
        [string]$Why
    )
    $history = @()
    if ($Record.ContainsKey('history') -and $null -ne $Record.history) {
        $history = @($Record.history)
    }
    $history += @{
        operation = $Operation
        at = $At
        reason = $Why
    }
    if ($history.Count -gt $HistoryLimit) {
        $history = @($history[($history.Count - $HistoryLimit)..($history.Count - 1)])
    }
    $Record.history = $history
}

function Record-ForMutation {
    param(
        [hashtable]$Metadata,
        [string]$SecretName,
        [string]$At
    )
    if ($Metadata.entries.ContainsKey($SecretName)) {
        $existing = ConvertTo-Hashtable $Metadata.entries[$SecretName]
        if ($existing -isnot [hashtable]) {
            Throw-ManagerError 'SECRET_METADATA_INVALID' 'Lifecycle metadata contains an invalid secret record.' $SecretName
        }
        return $existing
    }
    return @{
        state = 'present'
        createdAt = $At
        updatedAt = $At
        history = @()
        legacyOrigin = $true
    }
}

function Read-RequiredSecretInput {
    $value = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrEmpty($value)) {
        Throw-ManagerError 'SECRET_VALUE_REQUIRED' 'A non-empty secret value is required on stdin.' $Name
    }
    return $value
}

function View-Time {
    if ([string]::IsNullOrWhiteSpace($AsOf)) { return [DateTimeOffset]::UtcNow }
    return Parse-UtcTimestamp $AsOf 'SECRET_AS_OF_INVALID' 'As-of time must be a valid timestamp.'
}

function Test-Readable {
    param([string]$CipherText)
    $plain = $null
    try {
        $plain = Unprotect-CipherText $CipherText
        return $true
    } catch {
        return $false
    } finally {
        $plain = $null
    }
}

function Build-InventoryItem {
    param(
        [string]$SecretName,
        [bool]$Present,
        [bool]$Readable,
        $Record,
        [DateTimeOffset]$Now
    )
    $managed = $Record -is [hashtable]
    $state = 'unmanaged'
    $warnings = @()
    $error = $null
    $createdAt = $null
    $updatedAt = $null
    $lastRotatedAt = $null
    $expires = $null
    $staleDays = $null

    if (-not $managed) {
        if (-not $Readable) {
            $state = 'unreadable'
            $error = @{ code = 'SECRET_UNREADABLE'; name = $SecretName }
        } else {
            $warnings += @{ code = 'SECRET_LIFECYCLE_UNMANAGED'; name = $SecretName }
        }
    } else {
        $createdAt = $Record.createdAt
        $updatedAt = $Record.updatedAt
        $lastRotatedAt = $Record.lastRotatedAt
        $expires = $Record.expiresAt
        $staleDays = $Record.staleAfterDays
        $metadataPresent = $Record.state -eq 'present'
        if ($metadataPresent -ne $Present) {
            $state = 'conflict'
            $error = @{ code = 'SECRET_METADATA_CONFLICT'; name = $SecretName }
        } elseif (-not $Present) {
            $state = 'removed'
        } elseif (-not $Readable) {
            $state = 'unreadable'
            $error = @{ code = 'SECRET_UNREADABLE'; name = $SecretName }
        } else {
            $state = 'ready'
            if (-not [string]::IsNullOrWhiteSpace([string]$expires)) {
                $expiryTime = Parse-UtcTimestamp ([string]$expires) 'SECRET_METADATA_INVALID' 'Lifecycle metadata contains an invalid expiry timestamp.'
                if ($Now -ge $expiryTime) {
                    $state = 'expired'
                    $error = @{ code = 'SECRET_EXPIRED'; name = $SecretName }
                } elseif ($Now.AddDays($ExpiringWithinDays) -ge $expiryTime) {
                    $state = 'expiring'
                    $warnings += @{ code = 'SECRET_EXPIRING'; name = $SecretName }
                }
            }
            if ($state -ne 'expired' -and $null -ne $staleDays -and [int]$staleDays -gt 0) {
                $basisText = if (-not [string]::IsNullOrWhiteSpace([string]$lastRotatedAt)) { $lastRotatedAt } else { $updatedAt }
                $basis = Parse-UtcTimestamp ([string]$basisText) 'SECRET_METADATA_INVALID' 'Lifecycle metadata contains an invalid staleness timestamp.'
                if ($Now -ge $basis.AddDays([int]$staleDays)) {
                    if ($state -eq 'ready') { $state = 'stale' }
                    $warnings += @{ code = 'SECRET_STALE'; name = $SecretName }
                }
            }
        }
    }

    return [ordered]@{
        name = $SecretName
        present = $Present
        readable = $Readable
        managed = $managed
        state = $state
        createdAt = $createdAt
        updatedAt = $updatedAt
        lastRotatedAt = $lastRotatedAt
        expiresAt = $expires
        staleAfterDays = $staleDays
        warnings = @($warnings)
        error = $error
    }
}

function Invoke-Mutation {
    $now = [DateTimeOffset]::UtcNow
    $at = Utc-Text $now
    $value = $null
    if ($Action -in @('add','replace','rotate')) { $value = Read-RequiredSecretInput }
    try {
        return Invoke-WithVaultLock {
            $data = Read-Vault
            $metadata = Read-Metadata $data
            $present = $data.ContainsKey($Name)
            if ($Action -eq 'add' -and $present) {
                Throw-ManagerError 'SECRET_ALREADY_CONFIGURED' 'The secret is already configured.' $Name
            }
            if ($Action -in @('replace','rotate','remove') -and -not $present) {
                Throw-ManagerError 'SECRET_NOT_CONFIGURED' 'The secret is not configured.' $Name
            }

            $record = Record-ForMutation $metadata $Name $at
            if ($Action -eq 'add') {
                $record = @{
                    state = 'present'
                    createdAt = $at
                    updatedAt = $at
                    history = @()
                    legacyOrigin = $false
                }
                $record.expiresAt = Resolve-Expiry $ExpirySupplied $null $now
                $record.staleAfterDays = Resolve-StaleDays $StaleAfterDaysSupplied $null
                $data[$Name] = Protect-PlainText $value
            } elseif ($Action -in @('replace','rotate')) {
                $record.state = 'present'
                $record.updatedAt = $at
                if ($Action -eq 'rotate') { $record.lastRotatedAt = $at }
                $record.expiresAt = Resolve-Expiry $ExpirySupplied $record.expiresAt $now
                $record.staleAfterDays = Resolve-StaleDays $StaleAfterDaysSupplied $record.staleAfterDays
                $data[$Name] = Protect-PlainText $value
            } else {
                $record.state = 'removed'
                $record.updatedAt = $at
                $record.removedAt = $at
                $data.Remove($Name) | Out-Null
            }
            Add-History $record $Action $at $Reason
            $metadata.entries[$Name] = $record
            Write-MetadataIntoVault $data $metadata
            Write-Vault $data
            return [ordered]@{
                ok = $true
                operation = $Action
                name = $Name
                at = $at
                state = $record.state
                expiresAt = $record.expiresAt
                staleAfterDays = $record.staleAfterDays
                metadataRevision = $metadata.revision
            }
        }
    } finally {
        $value = $null
    }
}

function Invoke-Inventory {
    $now = View-Time
    # Writers replace the one vault file atomically, so one unlocked file read is a
    # consistent snapshot and keeps inventory strictly free of filesystem writes.
    $data = Read-Vault
    $metadata = Read-Metadata $data
    $names = @($data.Keys | Where-Object { $_ -ne $MetadataKey })
    foreach ($entryName in $metadata.entries.Keys) {
        if ($names -notcontains $entryName) { $names += $entryName }
    }
    $items = @()
    foreach ($secretName in @($names | Sort-Object -Unique)) {
        $present = $data.ContainsKey($secretName)
        $readable = $false
        if ($present) { $readable = Test-Readable $data[$secretName] }
        $record = if ($metadata.entries.ContainsKey($secretName)) {
            ConvertTo-Hashtable $metadata.entries[$secretName]
        } else { $null }
        $items += Build-InventoryItem $secretName $present $readable $record $now
    }
    return [ordered]@{
        schemaVersion = 1
        generatedAt = Utc-Text $now
        metadataRevision = $metadata.revision
        expiringWithinDays = $ExpiringWithinDays
        secrets = @($items)
    }
}

function Invoke-History {
    $now = View-Time
    # History uses the same atomic single-file snapshot as inventory.
    $data = Read-Vault
    $metadata = Read-Metadata $data
    if (-not $metadata.entries.ContainsKey($Name)) {
        Throw-ManagerError 'SECRET_LIFECYCLE_METADATA_MISSING' 'No lifecycle history is recorded for this secret.' $Name
    }
    $record = ConvertTo-Hashtable $metadata.entries[$Name]
    return [ordered]@{
        schemaVersion = 1
        generatedAt = Utc-Text $now
        name = $Name
        state = $record.state
        history = @($record.history)
    }
}

try {
    if ($Action -in @('add','replace','rotate','remove','history')) {
        Assert-SecretName $Name
    }
    if ($Action -in @('add','replace','rotate','remove')) {
        Assert-Reason $Reason
    }
    if ($Action -notin @('add','replace','rotate') -and
        ($PSBoundParameters.ContainsKey('ExpiresAt') -or $PSBoundParameters.ContainsKey('StaleAfterDays'))) {
        Throw-ManagerError 'SECRET_ARGUMENT_INVALID' 'Expiry and staleness settings are valid only for add, replace, or rotate.' $Name
    }
    if ($Action -in @('add','replace','rotate','remove')) {
        $result = Invoke-Mutation
    } elseif ($Action -eq 'inventory') {
        $result = Invoke-Inventory
    } else {
        $result = Invoke-History
    }
    [Console]::Out.Write(($result | ConvertTo-Json -Depth 16 -Compress))
    exit 0
} catch {
    $caught = $_.Exception
    $code = if ($null -ne $caught.Data['Code']) { [string]$caught.Data['Code'] } else { 'SECRET_MANAGER_FAILED' }
    $secretName = if ($null -ne $caught.Data['SecretName']) { [string]$caught.Data['SecretName'] } else { $null }
    $safeMessage = switch ($code) {
        'SECRET_NAME_INVALID' { 'Secret name is invalid.' }
        'SECRET_RESERVED_NAME' { 'Secret name is reserved.' }
        'SECRET_REASON_REQUIRED' { 'A lifecycle reason is required.' }
        'SECRET_REASON_INVALID' { 'Lifecycle reason is invalid.' }
        'SECRET_VALUE_REQUIRED' { 'A secret value is required on stdin.' }
        'SECRET_ALREADY_CONFIGURED' { 'Secret is already configured.' }
        'SECRET_NOT_CONFIGURED' { 'Secret is not configured.' }
        'SECRET_EXPIRY_INVALID' { 'Secret expiry is invalid.' }
        'SECRET_STALENESS_INVALID' { 'Secret staleness setting is invalid.' }
        'SECRET_AS_OF_INVALID' { 'Inventory as-of time is invalid.' }
        'SECRET_METADATA_INVALID' { 'Lifecycle metadata is invalid.' }
        'SECRET_METADATA_CONFLICT' { 'Secret state conflicts with lifecycle metadata.' }
        'SECRET_LIFECYCLE_METADATA_MISSING' { 'Lifecycle metadata is not configured for this secret.' }
        'SECRET_STORE_INVALID' { 'Secret store is invalid.' }
        'SECRET_STORE_LOCK_TIMEOUT' { 'Secret store lock timed out.' }
        'SECRET_STORE_IO_FAILED' { 'Secret store update failed.' }
        'SECRET_ARGUMENT_INVALID' { 'Secret manager arguments are invalid.' }
        default { 'Secret manager operation failed.' }
    }
    $failure = [ordered]@{
        ok = $false
        error = [ordered]@{
            code = $code
            message = $safeMessage
            name = $secretName
        }
    }
    [Console]::Error.Write(($failure | ConvertTo-Json -Depth 8 -Compress))
    exit 1
}
