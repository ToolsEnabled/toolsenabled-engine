# DPAPI-backed local vault. Values never appear in repository files in plaintext.
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('set','set-stdin','set-pair-stdin','set-triple-stdin','get-or-create-stdin','set-monotonic-stdin','prompt-set','prompt-payment-card','scrub-payment-card-cvc','clear-device-credential','get','get-many','del','list','exists','present','verify','audit-pair-inspect','audit-pair-replace')]
    [string]$Action,

    [Parameter(Mandatory = $false, Position = 1)]
    [string]$Key,

    # get-many only: a comma-separated list of key NAMES. Deliberately a single
    # string rather than [string[]] -- powershell.exe -File binds an array
    # parameter from one argv element as a ONE-element array containing the
    # literal "a,b", which then fails Assert-Key on the comma. Splitting here is
    # unambiguous because Assert-Key forbids commas in a key, so no real key can
    # be hidden by the delimiter. Key NAMES travel as arguments exactly as $Key
    # does for 'get'; secret VALUES never do, in either direction.
    [Parameter(Mandatory = $false)]
    [string]$Keys,

    [Parameter(Mandatory = $false)]
    [long]$Sequence,

    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}$')]
    [string]$PromptLabel,

    [Parameter(Mandatory = $false)]
    [ValidateLength(0, 360)]
    [string]$PromptHint
)

$ErrorActionPreference = 'Stop'
# Node's stdin and stdout pipes are UTF-8. Windows PowerShell otherwise uses
# the console's legacy code page: a write stores mojibake, and a later legacy
# read can accidentally hide that corruption. The persistent host's UTF-8
# envelope cannot. Use one lossless codec for both transports, with no BOM;
# reject malformed stdin rather than silently storing replacement characters.
# Setting the encoding preserves a caller's explicit Console.SetOut capture.
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false, $true)
$RepoRoot = Split-Path -Parent $PSScriptRoot

# HOST-MODE STATE, INERT FOR A NORMAL PER-CALL INVOCATION -- AND THE FIX FOR
# A $PSBoundParameters DEFECT THAT MOVING THE DISPATCH INTO A FUNCTION
# INTRODUCED FOR EVERY INVOCATION, HOSTED OR NOT.
#
# $PSBoundParameters IS PER-SCOPE, NOT INHERITED. Confirmed directly: a
# script bound with -Key 'x' reports $PSBoundParameters.ContainsKey('Key') as
# $true at script scope and $false inside a same-file function with no
# parameter of its own, even though $Key itself still carries 'x' there by
# ordinary variable scoping. Invoke-VaultAction below takes no parameters, so
# every '$PSBoundParameters.ContainsKey(...)' check that used to run at
# script scope -- before this dispatch became a function -- silently stopped
# firing the moment it moved inside Invoke-VaultAction, in BOTH a normal
# per-call invocation and a hosted one. This is not host-specific; it broke
# the plain CLI too. Caught 2026-09-04 by tests/secrets/run.js: the
# 'scrub-payment-card-cvc' verb's own key-binding refusal (below, guarding
# against acting on any key but 'payment_card_default') stopped throwing and
# the verb started accepting a different key.
#
# One script-scope flag per such check, seeded from $PSBoundParameters HERE,
# at script scope, before Invoke-VaultAction exists to shadow it -- then
# referenced by that name inside the function instead of $PSBoundParameters.
# For $KeyProvided/$PromptLabelProvided/$PromptHintProvided this is the whole
# fix: none of the actions that read them ('scrub-payment-card-cvc',
# 'prompt-set', 'prompt-payment-card') are ever dispatched through the host
# (see tools/vault-host.ps1's $HostAllowedActions, which excludes all three),
# so the single seed taken from the ORIGINAL -File bind is correct for every
# call these guards can ever see.
#
# $VaultHostSequenceProvided needs one more thing on top of that fix, because
# 'set-monotonic-stdin' IS dispatched through the host: tools/vault-host.ps1
# dot-sources this file once (TOOLSENABLED_VAULT_HOST_LIBRARY set) and then
# calls Invoke-VaultAction once per request, reassigning
# $script:Action/$Key/$Keys/$Sequence between calls -- so a host request
# overrides $VaultHostSequenceProvided itself, per call, rather than relying
# on the one seed below the way the other three flags do.
#
# Read-RequiredStdin has the equivalent problem for the stdin VALUE rather
# than a bound flag: it used to read the whole stdin stream to EOF, which a
# persistent host process never reaches. $VaultHostPendingValue lets a host
# request hand it one value directly instead, still never as an argument.
$script:VaultHostPendingValue = $null
$script:VaultHostSequenceProvided = $PSBoundParameters.ContainsKey('Sequence')
$script:KeyProvided = $PSBoundParameters.ContainsKey('Key')
$script:PromptLabelProvided = $PSBoundParameters.ContainsKey('PromptLabel')
$script:PromptHintProvided = $PSBoundParameters.ContainsKey('PromptHint')

# Create-and-fence the credential store as one act. See tools/lib/vault-acl.ps1:
# before this, the vault was created with a bare New-Item and inherited whatever
# the install location granted -- measured on a real install as
# CodexSandboxUsers:(I)(RX) on secrets.json itself.
. (Join-Path $PSScriptRoot 'lib/vault-acl.ps1')
# WHERE THE VAULT FILE IS, IN PRECEDENCE ORDER.
#   1. TOOLSENABLED_VAULT_PATH. src/lib/runtime.js publishes this into the
#      environment of every spawn of this script whenever the vault has moved,
#      so the JavaScript half and this script always name the same file. That
#      is the branch that runs in the installed product.
#   2. TOOLSENABLED_STATE_ROOT. A safety net for a hand-run invocation under a
#      shell that set the state root but not the vault path. An installed
#      program directory is replaced wholesale by the next update and is not
#      guaranteed writable, so a vault must never be resolved into it when a
#      per-user state root has been named.
#   3. The repository. A source checkout keeps the vault exactly where it has
#      always been.
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
if ([string]::IsNullOrWhiteSpace($VaultDir)) { throw 'Vault path must include a parent directory.' }
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
$configuredLockTimeout = [Environment]::GetEnvironmentVariable('TOOLSENABLED_VAULT_LOCK_TIMEOUT_MS')
$VaultLockTimeoutMs = 30000
if (-not [string]::IsNullOrWhiteSpace($configuredLockTimeout)) {
    $parsedLockTimeout = 0
    if (-not [int]::TryParse($configuredLockTimeout, [ref]$parsedLockTimeout) -or
        $parsedLockTimeout -lt 100 -or $parsedLockTimeout -gt 30000) {
        throw 'TOOLSENABLED_VAULT_LOCK_TIMEOUT_MS must be an integer from 100 through 30000.'
    }
    $VaultLockTimeoutMs = $parsedLockTimeout
}

# THE VAULT ORACLE DENYLIST. Same-user DPAPI decryptability is
# itself an accepted, unavoidable consequence of running as the owner's own
# Windows account -- this list does not and cannot change that.
# What it does close: these two vault entries carry an explicit promise made
# by this very script's own capture dialogs -- the payment-card and owner
# legal-identity prompts each say their record "is never returned to an
# agent, MCP response, log, or report" -- and no legitimate caller anywhere
# in this repository ever fetches either through the generic 'get'/'list'
# actions (both are read only here, directly off Read-Vault, inside this
# script's own interactive prompt flows). Leaving them reachable through the
# generic path made that shipped promise false. Keep this list to entries
# that meet both bars: an explicit prior no-agent-return promise, and zero
# legitimate 'get'/'list' callers.
$VaultOracleDenylist = @('payment_card_default', 'owner_legal_identity_v1')

# A same-user process can still read anything DPAPI will decrypt for it --
# this log does not and cannot prevent that (see the denylist comment above
# above). What it removes is silence: every call is
# recorded locally so it is no longer invisible to the owner or to later
# forensics. Metadata only -- never a secret value.
$VaultAccessLogFile = $VaultFile + '.access.log'

function Write-VaultAccessLog {
    param(
        [Parameter(Mandatory = $true)][string]$Action,
        [string]$Key,
        [Nullable[int]]$ResultCount,
        [Nullable[bool]]$Present,
        [Nullable[bool]]$Replaced,
        [switch]$Denied,
        [switch]$Unreadable
    )
    # Best-effort only. A full disk, a locked log file, or any other logging
    # failure must never turn an otherwise-successful vault read into an
    # outage -- this function swallows its own errors on purpose.
    try {
        $entry = [ordered]@{
            ts     = [DateTime]::UtcNow.ToString('o')
            pid    = $PID
            action = $Action
        }
        if ($PSBoundParameters.ContainsKey('Key')) { $entry.key = $Key }
        if ($null -ne $ResultCount) { $entry.resultCount = $ResultCount }
        if ($Denied) { $entry.denied = $true }
        # Presence-only answers ('present' action). The bit recorded here is
        # whether a record EXISTS, never anything about what it holds -- the
        # same distinction the action itself is built on. Recording the answer
        # and not merely the question is the point of this log: "who asked
        # whether the card is on file, and what were they told" is the forensic
        # question, and half of it is unanswerable without this field.
        if ($null -ne $Present) { $entry.present = [bool]$Present }
        # THE FIELD THAT MAKES A SILENT OVERWRITE VISIBLE.
        # `present` above answers a question somebody asked. `replaced` answers
        # what a mutation did to the record that was already there: $true means
        # a record existed under this key and those bytes are not the bytes any
        # more, $false means the key was new. Like every other
        # field here it is metadata: whether a record was there, never a byte of
        # what was in it, going in or coming out.
        if ($null -ne $Replaced) { $entry.replaced = [bool]$Replaced }
        if ($Unreadable) { $entry.unreadable = $true }
        $line = ($entry | ConvertTo-Json -Compress) + [Environment]::NewLine
        # NEVER CREATE THE STORE FROM THE LOG PATH. This used to call the
        # protected-store initializer before appending, and that one line
        # resurrected the vault directory after the product's own local-data
        # reset had deleted it: every vault verb runs as a synchronous
        # powershell.exe child, the reset kills the parent while it is blocked
        # in that call, the orphaned child finishes its verb, and this trailing
        # log write recreated <vault>\ plus the access log on a tree the sweep
        # had just certified empty (measured 2026-09-02 by
        # uninstall-reset-packaged-qa: the planted secrets.json was gone and only
        # secrets.json.access.log came back). A log line about a vault that no
        # longer exists has nowhere legitimate to go; creating an owner-ACL'd
        # credential directory to record it is the wrong trade. Store creation
        # stays on Write-Vault and the other mutating verbs, where it is the
        # intent. Test-Path, not a cached flag: the directory can disappear
        # between two calls of one process.
        if (-not (Test-Path -LiteralPath $VaultDir -PathType Container)) { return }
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::AppendAllText($VaultAccessLogFile, $line, $utf8NoBom)
    } catch {
        # Swallowed deliberately -- see the function comment above.
    }
}

function Assert-Key {
    param([string]$Candidate)
    if ([string]::IsNullOrWhiteSpace($Candidate) -or $Candidate -notmatch '^[A-Za-z0-9_.-]+$') {
        throw 'Secret keys may contain only letters, digits, dot, underscore, and hyphen.'
    }
}

function Read-Vault {
    if (-not (Test-Path -LiteralPath $VaultFile)) { return @{} }
    $raw = Get-Content -LiteralPath $VaultFile -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($raw)) { throw 'The existing encrypted vault is empty or malformed; no record was changed.' }
    $object = $raw | ConvertFrom-Json
    if ($null -eq $object -or $object -isnot [System.Management.Automation.PSCustomObject]) {
        throw 'The existing encrypted vault is not a record map; no record was changed.'
    }
    $result = @{}
    foreach ($property in $object.PSObject.Properties) {
        if ($property.Value -isnot [string]) {
            throw 'The existing encrypted vault contains a malformed record; no record was changed.'
        }
        $result[$property.Name] = $property.Value
    }
    return $result
}

function Read-AuditRepairVault {
    # This action is restricted to the actual token's profile, independently
    # of inherited HOME/USERPROFILE and the JavaScript caller's path check.
    $ownedProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    $ownedPrefix = [IO.Path]::GetFullPath($ownedProfile).TrimEnd('\') + '\'
    if (-not $VaultFile.StartsWith($ownedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Audit repair requires the current account profile.' }
    $currentPath = $VaultFile
    while ($currentPath.Length -ge $ownedPrefix.Length - 1) {
        $item = Get-Item -LiteralPath $currentPath -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Audit repair refuses reparse paths.' }
        $currentPath = [IO.Path]::GetDirectoryName($currentPath)
        if ([string]::IsNullOrEmpty($currentPath)) { break }
    }
    $fileInfo = Get-Item -LiteralPath $VaultFile -Force
    if ($fileInfo.PSIsContainer -or $fileInfo.Length -gt 4194304) { throw 'The audit vault is not a bounded regular file.' }
    if (-not (Test-VaultPathProtected -Path $VaultDir -Container $true) -or -not (Test-VaultPathProtected -Path $VaultFile -Container $false)) {
        throw 'The audit vault ownership and access control could not be verified.'
    }
    $raw = ([Text.UTF8Encoding]::new($false, $true)).GetString([IO.File]::ReadAllBytes($VaultFile)).TrimStart([char]0xfeff)
    # Parse the flat string map without ConvertFrom-Json's duplicate-key
    # last-wins behavior. Repair must not erase an ambiguous unrelated record.
    $stringToken = '"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"'
    $pairPattern = '\G\s*(?<key>' + $stringToken + ')\s*:\s*(?<value>' + $stringToken + ')\s*'
    $start = [regex]::Match($raw, '\A\s*\{\s*')
    if (-not $start.Success) { throw 'The encrypted vault is not a record map.' }
    $position = $start.Length
    $result = @{}
    if ($position -lt $raw.Length -and $raw[$position] -ne '}') {
        while ($true) {
            # \G is anchored at the supplied start, not at a previous match.
            $matcher = [regex]::new($pairPattern, [Text.RegularExpressions.RegexOptions]::None, [TimeSpan]::FromSeconds(1))
            $match = $matcher.Match($raw, $position)
            if (-not $match.Success) { throw 'The encrypted vault contains a malformed record.' }
            $entryKey = $match.Groups['key'].Value | ConvertFrom-Json
            $entryValue = $match.Groups['value'].Value | ConvertFrom-Json
            Assert-Key $entryKey
            if ($result.ContainsKey($entryKey)) { throw 'The encrypted vault contains duplicate record names.' }
            $result[$entryKey] = [string]$entryValue
            $position = $match.Index + $match.Length
            if ($position -lt $raw.Length -and $raw[$position] -eq ',') { $position++; continue }
            break
        }
    }
    if (-not [regex]::IsMatch($raw.Substring($position), '\A\}\s*\z')) { throw 'The encrypted vault contains malformed trailing data.' }
    return $result
}

function Get-AuditPairState {
    param([hashtable]$Data)
    $fixedKeys = @('toolsenabled_audit_signing_key_v1', 'toolsenabled_audit_head_v1')
    $values = @()
    $states = @()
    foreach ($entryKey in $fixedKeys) {
        if (-not $Data.ContainsKey($entryKey)) { $values += $null; $states += 'missing'; continue }
        $values += $Data[$entryKey]
        try { $null = Unprotect-CipherText $Data[$entryKey]; $states += 'readable' }
        catch { $states += 'unreadable' }
    }
    # A read-only in-memory round trip proves this token can create current
    # DPAPI custody. No unrelated record is decrypted as a test.
    $sentinel = [guid]::NewGuid().ToString()
    if ((Unprotect-CipherText (Protect-PlainText $sentinel)) -cne $sentinel) { throw 'Current DPAPI custody is unavailable.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    $sid = $identity.User.Value
    if ([string]::IsNullOrWhiteSpace($sid)) { throw 'The current owner identity is unavailable.' }
    $material = ConvertTo-Json -InputObject @('toolsenabled.audit-pair.v1', $values[0], $values[1]) -Compress
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($material)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return [ordered]@{ version = 1; digest = $digest; signing = $states[0]; head = $states[1]; owner = [ordered]@{
        platform = 'win32'; id = $sid; elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } }
}

function Write-Vault {
    param([hashtable]$Data)

    Initialize-ProtectedVaultStore -Path $VaultDir
    Remove-LegacyVaultReplacementBackups -VaultPath $VaultFile
    $temporary = Join-Path $VaultDir ('.' + [System.IO.Path]::GetFileName($VaultFile) + '.' +
        $PID + '.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    try {
        $json = ($Data | ConvertTo-Json -Depth 5) + [Environment]::NewLine
        # Flush the DATA to disk before the write-through rename below. Measured
        # 2026-09-02: a hard power loss after WriteAllText + MoveFileEx left the
        # vault as 4,352 bytes of NUL (directory entry durable, pages not), and a
        # session .mcp.json two seconds later the same way. Flush($true) is
        # FlushFileBuffers; the rename's MOVEFILE_WRITE_THROUGH covers only the
        # name, never the bytes.
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
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        }
    }
}

function Write-VaultContentDigest {
    # SHA-256 of the vault file's bytes, the same value src/lib/runtime.js
    # vaultContentDigest() computes, printed as one stdout line.
    if (-not (Test-Path -LiteralPath $VaultFile)) { return }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::Open($VaultFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try { $hash = $sha.ComputeHash($stream) } finally { $stream.Dispose() }
    } finally { $sha.Dispose() }
    $hex = ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    [Console]::Out.WriteLine('vault-sha256=' + $hex)
}

function Invoke-WithVaultLock {
    param([scriptblock]$Operation)

    # Windows file-sharing denial is enforced by the filesystem across logon
    # sessions, including an interactive agent and a same-user Task Scheduler
    # process in session 0. The persistent empty file is not the lock: ownership
    # is the live FileStream handle, which the kernel releases if a process dies.
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
                    throw 'Timed out waiting for exclusive access to the secret vault.'
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
    if ($env:TOOLSENABLED_VAULT_HOST_LIBRARY -eq '1') {
        Initialize-NativeVaultPermissions
        return [ToolsEnabled.VaultDataProtectionV1]::Protect($PlainText)
    }
    $secure = ConvertTo-SecureString -String $PlainText -AsPlainText -Force
    return ConvertFrom-SecureString -SecureString $secure
}

function Unprotect-CipherText {
    param([string]$CipherText)
    if ($env:TOOLSENABLED_VAULT_HOST_LIBRARY -eq '1') {
        Initialize-NativeVaultPermissions
        return [ToolsEnabled.VaultDataProtectionV1]::Unprotect($CipherText)
    }
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

function Read-RequiredStdin {
    # A host request hands its value here directly (see the host-mode state
    # comment above); a normal per-call invocation still reads stdin to EOF,
    # exactly as before. Either way the value never crosses as an argument.
    if ($null -ne $script:VaultHostPendingValue) {
        $plain = $script:VaultHostPendingValue
        if ([string]::IsNullOrEmpty($plain)) { throw 'Secret value from stdin must not be empty.' }
        return $plain
    }
    try { $plain = [Console]::In.ReadToEnd() } catch {
        # Decoder exceptions may carry input bytes; never relay those details.
        throw 'Secret stdin must be valid UTF-8.'
    }
    if ([string]::IsNullOrEmpty($plain)) { throw 'Secret value from stdin must not be empty.' }
    return $plain
}

function Read-EmbeddedSequence {
    param([string]$PlainText)

    try { $object = $PlainText | ConvertFrom-Json } catch {
        throw 'Monotonic secret value must be a JSON object with an integer sequence.'
    }
    if ($null -eq $object -or $null -eq $object.PSObject.Properties['sequence']) {
        throw 'Monotonic secret value must contain an integer sequence.'
    }
    $parsed = 0L
    $sequenceText = [Convert]::ToString(
        $object.PSObject.Properties['sequence'].Value,
        [Globalization.CultureInfo]::InvariantCulture
    )
    if (-not [long]::TryParse(
        $sequenceText,
        [Globalization.NumberStyles]::None,
        [Globalization.CultureInfo]::InvariantCulture,
        [ref]$parsed
    ) -or $parsed -lt 0) {
        throw 'Monotonic secret sequence must be a non-negative integer.'
    }
    return $parsed
}

function Assert-InteractiveDesktop {
    # Scheduled tasks and services normally run in session 0.  Do not attempt
    # to show a credential dialog there: it cannot be seen or answered, and a
    # caller must fail closed instead of silently continuing without a secret.
    if (-not [Environment]::UserInteractive -or
        [System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
        throw 'CREDENTIAL_INTERACTION_REQUIRED: an interactive Windows desktop session is required to enter a credential.'
    }
}

function Open-CredentialPromptLock {
    # A vault-wide share-deny handle serializes interactive prompts across all
    # MCP processes. The empty file is only a rendezvous path; ownership is the
    # live kernel handle and is released automatically if the process exits.
    $promptLockFile = $VaultFile + '.prompt.lock'
    Initialize-ProtectedVaultStore -Path $VaultDir
    try {
        $stream = New-Object System.IO.FileStream(
            $promptLockFile,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        return $stream
    } catch {
        $lockError = $_.Exception
        while ($null -ne $lockError.InnerException) {
            $lockError = $lockError.InnerException
        }
        $nativeCode = $lockError.HResult -band 0xffff
        if ($nativeCode -eq 32 -or $nativeCode -eq 33) { return $null }
        throw
    }
}

function Invoke-CredentialPrompt {
    param(
        [string]$VaultKey,
        [string]$DisplayName,
        [string]$PromptHint
    )

    $promptLock = Open-CredentialPromptLock
    if ($null -eq $promptLock) {
        [Console]::Out.Write((@{ key = $VaultKey; status = 'in_progress' } | ConvertTo-Json -Compress))
        return
    }

    try {
        Assert-InteractiveDesktop
        try {
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            if ($null -eq ('ToolsEnabled.CredentialPromptWindow' -as [type])) {
                Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ToolsEnabled {
    public static class CredentialPromptWindow {
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetWindowPos(
            IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        public static void Present(IntPtr hWnd) {
            const uint SWP_NOSIZE = 0x0001;
            const uint SWP_NOMOVE = 0x0002;
            const uint SWP_SHOWWINDOW = 0x0040;
            ShowWindow(hWnd, 9); // SW_RESTORE
            SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW);
            SetForegroundWindow(hWnd);
        }
    }
}
'@

function Test-LuhnCardNumber {
    param([string]$Value)
    $digits = ($Value -replace '[^0-9]', '')
    if ($digits.Length -lt 12 -or $digits.Length -gt 19) { return $false }
    $sum = 0
    $alternate = $false
    for ($index = $digits.Length - 1; $index -ge 0; $index -= 1) {
        $digit = [int][string]$digits[$index]
        if ($alternate) {
            $digit *= 2
            if ($digit -gt 9) { $digit -= 9 }
        }
        $sum += $digit
        $alternate = -not $alternate
    }
    return ($sum % 10) -eq 0
}

function Invoke-PaymentCardPrompt {
    param(
        [string]$VaultKey,
        [string]$DisplayName
    )

    $promptLock = Open-CredentialPromptLock
    if ($null -eq $promptLock) {
        [Console]::Out.Write((@{ key = $VaultKey; status = 'in_progress' } | ConvertTo-Json -Compress))
        return
    }

    try {
        Assert-InteractiveDesktop
        try {
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            if ($null -eq ('ToolsEnabled.PaymentCardPromptWindow' -as [type])) {
                Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ToolsEnabled {
    public static class PaymentCardPromptWindow {
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetWindowPos(
            IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        public static void Present(IntPtr hWnd) {
            const uint SWP_NOSIZE = 0x0001;
            const uint SWP_NOMOVE = 0x0002;
            const uint SWP_SHOWWINDOW = 0x0040;
            ShowWindow(hWnd, 9);
            SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW);
            SetForegroundWindow(hWnd);
        }
    }
}
'@
            }
        } catch {
            throw 'CREDENTIAL_INTERACTION_REQUIRED: the local Windows payment-card dialog is unavailable in this session.'
        }

        $form = $null
        $boxes = @()
        $plain = $null
        try {
            $form = New-Object System.Windows.Forms.Form
            $form.Text = 'ToolsEnabled payment method'
            $form.Size = New-Object System.Drawing.Size 600, 500
            $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
            $form.TopMost = $true
            $form.ShowInTaskbar = $true
            $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
            $form.MaximizeBox = $false
            $form.MinimizeBox = $false

            $description = New-Object System.Windows.Forms.Label
            $description.Location = New-Object System.Drawing.Point 18, 16
            $description.Size = New-Object System.Drawing.Size 550, 62
            $description.Text = "Enter $DisplayName. This encrypted local vault record is never returned to an agent, MCP response, log, or report. It is only for owner-authorized checkout forms on verified payment providers."
            $form.Controls.Add($description)

            $keyLabel = New-Object System.Windows.Forms.Label
            $keyLabel.Location = New-Object System.Drawing.Point 18, 80
            $keyLabel.Size = New-Object System.Drawing.Size 550, 20
            $keyLabel.Text = "Vault key: $VaultKey"
            $form.Controls.Add($keyLabel)

            function Add-Field {
                param([string]$Label, [int]$Y, [int]$Width, [bool]$Masked = $false)
                $labelControl = New-Object System.Windows.Forms.Label
                $labelControl.Location = New-Object System.Drawing.Point 18, $Y
                $labelControl.Size = New-Object System.Drawing.Size $Width, 20
                $labelControl.Text = $Label
                $form.Controls.Add($labelControl)
                $box = New-Object System.Windows.Forms.TextBox
                $box.Location = New-Object System.Drawing.Point 18, ($Y + 21)
                $box.Size = New-Object System.Drawing.Size $Width, 24
                $box.UseSystemPasswordChar = $Masked
                $form.Controls.Add($box)
                $boxes += $box
                return $box
            }

            # No security-code field, here or in the live form below: the code
            # is never collected at capture and never stored (built-in product
            # policy; PCI DSS 3.2). See the record-shape comment above the live
            # Invoke-PaymentCardPrompt definition.
            $cardholder = Add-Field 'Cardholder name' 112 540 $false
            $number = Add-Field 'Card number' 168 540 $true
            $expiry = Add-Field 'Expiration (MM/YY)' 224 260 $true
            $postal = Add-Field 'Billing postal code' 280 260 $true

            $note = New-Object System.Windows.Forms.Label
            $note.Location = New-Object System.Drawing.Point 18, 394
            $note.Size = New-Object System.Drawing.Size 550, 22
            $note.Text = 'Save validates basic card structure before encrypting. Cancel leaves the vault unchanged.'
            $form.Controls.Add($note)

            $save = New-Object System.Windows.Forms.Button
            $save.Text = 'Save payment method'
            $save.Location = New-Object System.Drawing.Point 328, 426
            $save.Size = New-Object System.Drawing.Size 130, 30
            $save.Add_Click({
                $normalizedNumber = ($number.Text -replace '[^0-9]', '')
                $expiryMatch = [regex]::Match($expiry.Text, '^\s*(0[1-9]|1[0-2])\s*\/\s*([0-9]{2}|[0-9]{4})\s*$')
                $normalizedPostal = $postal.Text.Trim()
                if ([string]::IsNullOrWhiteSpace($cardholder.Text) -or -not (Test-LuhnCardNumber $normalizedNumber) -or
                    -not $expiryMatch.Success -or
                    [string]::IsNullOrWhiteSpace($normalizedPostal) -or $normalizedPostal.Length -gt 32) {
                    [System.Windows.Forms.MessageBox]::Show(
                        $form,
                        'Enter a valid cardholder name, card number, expiration, and billing postal code, or choose Cancel.',
                        'ToolsEnabled payment method',
                        [System.Windows.Forms.MessageBoxButtons]::OK,
                        [System.Windows.Forms.MessageBoxIcon]::Information
                    ) | Out-Null
                    return
                }
                $yearText = $expiryMatch.Groups[2].Value
                $year = if ($yearText.Length -eq 2) { 2000 + [int]$yearText } else { [int]$yearText }
                $month = [int]$expiryMatch.Groups[1].Value
                $lastDay = [DateTime]::DaysInMonth($year, $month)
                if ($year -lt 2000 -or ([DateTime]::new($year, $month, $lastDay) -lt [DateTime]::Today)) {
                    [System.Windows.Forms.MessageBox]::Show(
                        $form,
                        'Enter a card expiration date that has not passed, or choose Cancel.',
                        'ToolsEnabled payment method',
                        [System.Windows.Forms.MessageBoxButtons]::OK,
                        [System.Windows.Forms.MessageBoxIcon]::Information
                    ) | Out-Null
                    return
                }
                # This definition is shadowed by the later top-level one and is
                # not reachable from the 'prompt-payment-card' action; it keeps
                # its own record label. Whatever the label, no payload written
                # by this file carries the security code.
                $script:paymentCardPayload = [ordered]@{
                    version = 1
                    cardholderName = $cardholder.Text.Trim()
                    cardNumber = $normalizedNumber
                    expMonth = $month
                    expYear = $year
                    postalCode = $normalizedPostal
                } | ConvertTo-Json -Compress
                $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
                $form.Close()
            })
            $form.Controls.Add($save)

            $cancel = New-Object System.Windows.Forms.Button
            $cancel.Text = 'Cancel'
            $cancel.Location = New-Object System.Drawing.Point 468, 426
            $cancel.Size = New-Object System.Drawing.Size 100, 30
            $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
            $form.Controls.Add($cancel)
            $form.AcceptButton = $save
            $form.CancelButton = $cancel
            $form.Add_Shown({
                $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
                [ToolsEnabled.PaymentCardPromptWindow]::Present($form.Handle)
                $form.BringToFront()
                $form.Activate()
                $cardholder.Focus()
            })

            $dialogResult = $form.ShowDialog()
            if ($dialogResult -ne [System.Windows.Forms.DialogResult]::OK -or [string]::IsNullOrWhiteSpace($script:paymentCardPayload)) {
                [Console]::Out.Write('{"status":"cancelled"}')
                return
            }
            $plain = $script:paymentCardPayload
            $script:paymentCardPayload = $null
            $status = Invoke-WithVaultLock {
                $data = Read-Vault
                $prior = $data.ContainsKey($VaultKey)
                $data[$VaultKey] = Protect-PlainText $plain
                Write-Vault $data
                if ($prior) { return 'updated' }
                return 'created'
            }
            [Console]::Out.Write((@{ key = $VaultKey; status = [string]$status } | ConvertTo-Json -Compress))
        } finally {
            foreach ($box in $boxes) {
                if ($null -ne $box) {
                    $box.Clear()
                    $box.Dispose()
                }
            }
            if ($null -ne $form) { $form.Dispose() }
            $script:paymentCardPayload = $null
            $plain = $null
        }
    } finally {
        $promptLock.Dispose()
    }
}
            }
        } catch {
            throw 'CREDENTIAL_INTERACTION_REQUIRED: the local Windows credential dialog is unavailable in this session.'
        }

        $form = $null
        $valueBox = $null
        $plain = $null
        try {
            $form = New-Object System.Windows.Forms.Form
        $form.Text = 'ToolsEnabled - private owner step'
        $form.ClientSize = New-Object System.Drawing.Size 620, 460
        $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
        $form.TopMost = $true
        $form.ShowInTaskbar = $true
        $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
        $form.MaximizeBox = $false
        $form.MinimizeBox = $false
        $form.BackColor = [System.Drawing.Color]::FromArgb(248, 248, 252)
        $form.ForeColor = [System.Drawing.Color]::FromArgb(39, 42, 58)
        $form.Font = [System.Drawing.Font]::new('Segoe UI', 10)

        $header = New-Object System.Windows.Forms.Panel
        $header.Location = New-Object System.Drawing.Point 0, 0
        $header.Size = New-Object System.Drawing.Size 620, 78
        $header.BackColor = [System.Drawing.Color]::FromArgb(235, 233, 250)
        $form.Controls.Add($header)

        $eyebrow = New-Object System.Windows.Forms.Label
        $eyebrow.Location = New-Object System.Drawing.Point 22, 12
        $eyebrow.Size = New-Object System.Drawing.Size 570, 18
        $eyebrow.Text = 'TOOLSENABLED  /  PRIVATE OWNER STEP'
        $eyebrow.ForeColor = [System.Drawing.Color]::FromArgb(92, 81, 150)
        $eyebrow.Font = [System.Drawing.Font]::new('Segoe UI', 8, [System.Drawing.FontStyle]::Bold)
        $header.Controls.Add($eyebrow)

        $title = New-Object System.Windows.Forms.Label
        $title.Location = New-Object System.Drawing.Point 20, 30
        $title.Size = New-Object System.Drawing.Size 575, 36
        $title.Text = 'One private step at a time'
        $title.ForeColor = [System.Drawing.Color]::FromArgb(42, 39, 76)
        $title.Font = [System.Drawing.Font]::new('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
        $header.Controls.Add($title)

        $description = New-Object System.Windows.Forms.Label
        $description.Location = New-Object System.Drawing.Point 22, 96
        $description.Size = New-Object System.Drawing.Size 576, 116
        $purpose = if ([string]::IsNullOrWhiteSpace($PromptHint)) { "Enter the complete $DisplayName from its trusted provider page." } else { $PromptHint.Trim() }
        $description.Text = "$purpose`r`nStored locally in your encrypted vault; never returned to the agent."
        $description.ForeColor = [System.Drawing.Color]::FromArgb(65, 68, 84)
            $form.Controls.Add($description)

        $step = New-Object System.Windows.Forms.Label
        $step.Location = New-Object System.Drawing.Point 22, 226
        $step.Size = New-Object System.Drawing.Size 576, 20
        $step.Text = 'STEP 1 OF 1   /   PRIVATE LOCAL ENTRY'
        $step.ForeColor = [System.Drawing.Color]::FromArgb(112, 106, 145)
        $step.Font = [System.Drawing.Font]::new('Segoe UI', 8, [System.Drawing.FontStyle]::Bold)
        $form.Controls.Add($step)

        $valueLabel = New-Object System.Windows.Forms.Label
        $valueLabel.Location = New-Object System.Drawing.Point 22, 256
        $valueLabel.Size = New-Object System.Drawing.Size 576, 20
        $valueLabel.Text = $DisplayName
        $valueLabel.Font = [System.Drawing.Font]::new('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
        $form.Controls.Add($valueLabel)

        $valueBox = New-Object System.Windows.Forms.TextBox
        $valueBox.Location = New-Object System.Drawing.Point 22, 281
        $valueBox.Size = New-Object System.Drawing.Size 576, 30
        $valueBox.UseSystemPasswordChar = $true
        $valueBox.BackColor = [System.Drawing.Color]::White
        $valueBox.Font = [System.Drawing.Font]::new('Consolas', 10)
        $form.Controls.Add($valueBox)

        $note = New-Object System.Windows.Forms.Label
        $note.Location = New-Object System.Drawing.Point 22, 324
        $note.Size = New-Object System.Drawing.Size 576, 42
        $note.Text = 'No quotes or extra words. Save securely stores it here; Cancel leaves the vault unchanged.'
        $note.ForeColor = [System.Drawing.Color]::FromArgb(92, 95, 111)
        $form.Controls.Add($note)

        $save = New-Object System.Windows.Forms.Button
        $save.Text = 'Save securely'
        $save.Location = New-Object System.Drawing.Point 390, 414
        $save.Size = New-Object System.Drawing.Size 112, 32
        $save.BackColor = [System.Drawing.Color]::FromArgb(102, 91, 176)
        $save.ForeColor = [System.Drawing.Color]::White
        $save.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
        $save.FlatAppearance.BorderSize = 0
        $save.UseVisualStyleBackColor = $false
        $save.Add_Click({
            if ([string]::IsNullOrEmpty($valueBox.Text)) {
                [System.Windows.Forms.MessageBox]::Show(
                    $form,
                    'Paste the complete value or choose Cancel. Nothing has been changed.',
                    'One small step',
                    [System.Windows.Forms.MessageBoxButtons]::OK,
                    [System.Windows.Forms.MessageBoxIcon]::Information
                ) | Out-Null
                return
            }
            $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
            $form.Close()
        })
        $form.Controls.Add($save)

        $cancel = New-Object System.Windows.Forms.Button
        $cancel.Text = 'Not now'
        $cancel.Location = New-Object System.Drawing.Point 512, 414
        $cancel.Size = New-Object System.Drawing.Size 86, 32
        $cancel.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
        $cancel.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(190, 190, 204)
        $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
        $form.Controls.Add($cancel)
        $form.AcceptButton = $save
        $form.CancelButton = $cancel
        $form.Add_Shown({
            # The Node launcher deliberately hides its console host. Explicitly
            # restore/show this owned dialog so a hidden console cannot leave a
            # live credential prompt invisible to the interactive user.
            $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
            [ToolsEnabled.CredentialPromptWindow]::Present($form.Handle)
            $form.BringToFront()
            $form.Activate()
            $valueBox.Focus()
        })

        $dialogResult = $form.ShowDialog()
        if ($dialogResult -ne [System.Windows.Forms.DialogResult]::OK) {
            [Console]::Out.Write('{"status":"cancelled"}')
            return
        }

        $plain = $valueBox.Text
        $status = Invoke-WithVaultLock {
            $data = Read-Vault
            $prior = $data.ContainsKey($VaultKey)
            $data[$VaultKey] = Protect-PlainText $plain
            Write-Vault $data
            if ($prior) { return 'updated' }
            return 'created'
        }
            [Console]::Out.Write((@{ key = $VaultKey; status = [string]$status } | ConvertTo-Json -Compress))
        } finally {
            if ($null -ne $valueBox) {
                $valueBox.Clear()
                $valueBox.Dispose()
            }
            if ($null -ne $form) { $form.Dispose() }
            $plain = $null
        }
    } finally {
        $promptLock.Dispose()
    }
}

function Test-ToolsEnabledPaymentCardNumber {
    param([string]$Value)
    $digits = ($Value -replace '[^0-9]', '')
    if ($digits.Length -lt 12 -or $digits.Length -gt 19) { return $false }
    $sum = 0
    $alternate = $false
    for ($index = $digits.Length - 1; $index -ge 0; $index -= 1) {
        $digit = [int][string]$digits[$index]
        if ($alternate) {
            $digit *= 2
            if ($digit -gt 9) { $digit -= 9 }
        }
        $sum += $digit
        $alternate = -not $alternate
    }
    return ($sum % 10) -eq 0
}

function Get-OwnerLegalIdentityForPaymentPrompt {
    # This helper deliberately stays inside the interactive DPAPI process. It
    # never writes the identity profile to stdout/stderr or passes it to MCP.
    $plain = $null
    $record = $null
    try {
        $data = Read-Vault
        if (-not $data.ContainsKey('owner_legal_identity_v1')) { return $null }
        $plain = Unprotect-CipherText $data['owner_legal_identity_v1']
        $record = $plain | ConvertFrom-Json -ErrorAction Stop
        if ($record.schemaVersion -ne 1 -or $record.purpose -ne 'owner_legal_identity' -or
            $null -eq $record.fields -or $record.fields.givenName -isnot [string] -or $record.fields.familyName -isnot [string]) {
            return $null
        }
        $givenName = (($record.fields.givenName -replace '\s+', ' ').Trim())
        $familyName = (($record.fields.familyName -replace '\s+', ' ').Trim())
        if ($givenName.Length -lt 2 -or $familyName.Length -lt 2 -or $givenName.Length -gt 160 -or $familyName.Length -gt 160) { return $null }
        return [ordered]@{ givenName = $givenName; familyName = $familyName }
    }
    catch { return $null }
    finally {
        $plain = $null
        $record = $null
    }
}

# Shared owner-prompt visual identity, used by every owner-facing dialog.
#
# LOADED FOR THE VERBS THAT CAN OPEN A WINDOW, AND FOR NO OTHERS.
#
# owner-prompt-theme.ps1 is not a palette file that costs a Test-Path. At
# script scope it loads System.Windows.Forms and System.Drawing, compiles a
# SetProcessDPIAware P/Invoke with `Add-Type -MemberDefinition`, and calls it.
# MEASURED 2026-09-03 on the owner's machine, dot-sourcing it: 258.9 / 283.6 /
# 292.3 ms, of which the WinForms assembly load is 69.8 / 74.8 / 87.8 ms and
# most of the rest is the C# compiler.
#
# It used to be dot-sourced here unconditionally, so a `get` -- a verb that
# opens no window, builds no control and reads no colour -- paid a quarter of a
# second to load a GUI stack and declare DPI awareness for a process that was
# about to print one string and exit. That is a third of what `get` cost end to
# end, on a path src/full-remote-access-bridge.js polls every two seconds.
#
# THE GATE IS A LIST OF VERBS THAT CAN PUT A FORM ON THE OWNER'S SCREEN, and it
# stays at SCRIPT scope so every function below still resolves the theme
# helpers exactly as before -- dot-sourcing inside a function would bind them to
# that function's scope instead, which is a different program.
#   * 'prompt-payment-card' -> Invoke-PaymentCardPrompt, the only caller of
#     Get-OwnerPromptTheme / ConvertTo-OwnerPromptColor / Get-OwnerPromptFont.
#   * 'prompt-set' -> Invoke-CredentialPrompt. It reads no theme token, but it
#     does build a System.Windows.Forms.Form, and DPI awareness must be declared
#     before any window exists in the process or Windows virtualizes it and the
#     dialog paints letterboxed inside its own frame. It kept that awareness by
#     accident of the unconditional load; it keeps it on purpose now.
# 'set' uses Read-Host on the console and 'scrub-payment-card-cvc' is headless,
# so neither creates a window. ADD A VERB HERE THE MOMENT IT CAN OPEN ONE.
if ($Action -eq 'prompt-set' -or $Action -eq 'prompt-payment-card') {
    . (Join-Path $PSScriptRoot 'owner-prompt-theme.ps1')
}

# THE STORED CARD RECORD ('payment_card_default'), AND WHAT IS NOT IN IT.
#
# The record this dialog writes is one DPAPI-sealed JSON document:
#
#   version 3  { version, cardholder { givenName, familyName }, cardholderName,
#                cardNumber, expMonth, expYear, postalCode }
#
# THE CARD SECURITY CODE (CVC / CVV) IS NOT A FIELD OF THIS RECORD, IS NOT ASKED
# FOR BY THIS DIALOG, AND IS NEVER STORED ANYWHERE BY ANY PATH IN THIS PRODUCT.
# Built-in product policy makes that an invariant, and PCI DSS Requirement 3.2 bars storing the code
# categorically -- encrypted or not. A spend path that needs the code must ask
# the owner for it live, at the moment of spend, hold it only for that
# authorisation, and discard it. It is not written to the vault, a file, a log,
# a report or an MCP result, ever. tests/secrets/payment-card-security-code-
# never-stored.js is the source fence that holds this line: it fails if any
# payload literal in this file gains a security-code key, if any argument that
# reaches Protect-PlainText can be traced to one, or if either capture form
# grows a field that asks for one.
#
# EARLIER SHAPES. Records labelled version 1 (a flat cardholderName, written
# by the shadowed dialog above) and version 2 (the cardholder object) were
# captured with a `cvc` field before this invariant existed. A record captured
# then still carries it until it is cleaned: the 'scrub-payment-card-cvc'
# action below removes the field in place, under the vault lock, and leaves the
# version label alone -- it did not capture the record and does not pretend to
# have. The next successful capture through this dialog replaces the whole
# record with a version 3 one, which never had the field.
function Invoke-PaymentCardPrompt {
    param([string]$VaultKey, [string]$DisplayName)

    $promptLock = Open-CredentialPromptLock
    if ($null -eq $promptLock) {
        [Console]::Out.Write((@{ key = $VaultKey; status = 'in_progress' } | ConvertTo-Json -Compress))
        return
    }

    try {
        Assert-InteractiveDesktop
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing

        # Declare DPI awareness BEFORE the first window exists, or Windows
        # virtualizes this process: it reports a window larger than the form
        # actually paints, so the dialog sits letterboxed in its own frame while
        # every fixed-width label clips its text mid-word. Both were visible on
        # this machine at 125% scaling. With awareness declared, layout units are
        # real pixels and AutoScaleMode::Dpi scales the layout from the 96dpi
        # baseline it is written against.
        if ($null -eq ('ToolsEnabled.DpiAwareness' -as [type])) {
            Add-Type -Namespace 'ToolsEnabled' -Name 'DpiAwareness' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@
        }
        # Best effort: a host that already set an awareness context makes this a
        # no-op, and that is fine. It must never stop the owner seeing the form.
        try { [void][ToolsEnabled.DpiAwareness]::SetProcessDPIAware() } catch { }

        $form = $null; $givenName = $null; $familyName = $null; $number = $null; $expiry = $null; $postal = $null
        $plain = $null
        $ownerIdentity = Get-OwnerLegalIdentityForPaymentPrompt
        try {
            $themeResult = Get-OwnerPromptTheme
            $t = $themeResult.Theme
            $cBg = ConvertTo-OwnerPromptColor $t.bg
            $cSheet = ConvertTo-OwnerPromptColor $t.sheet
            $cInk = ConvertTo-OwnerPromptColor $t.ink
            $cInk2 = ConvertTo-OwnerPromptColor $t.ink2
            $cInk25 = ConvertTo-OwnerPromptColor $t.ink25
            $cInk3 = ConvertTo-OwnerPromptColor $t.ink3
            $cAccent = ConvertTo-OwnerPromptColor $t.accent
            # accentFloor, not accent, carries the button fill: the role palette
            # is built to a 3:1 non-text floor, so white on accent measures about
            # 3.9:1 and misses the 4.5:1 needed for a label. accentFloor clears
            # it. tests/owner-prompt-theme.test.js holds that line.
            $cAccentFloor = ConvertTo-OwnerPromptColor $t.accentFloor
            $cOnAccent = ConvertTo-OwnerPromptColor $t.onAccent
            $cLine = ConvertTo-OwnerPromptColor -Token $t.line2 -OverBase $t.bg
            $cSerious = ConvertTo-OwnerPromptColor $t.serious

            $form = New-Object System.Windows.Forms.Form
            $form.Text = 'ToolsEnabled payment method'
            $form.AutoScaleDimensions = New-Object System.Drawing.SizeF(96, 96)
            $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
            # Every height below
            # is a TextRenderer.MeasureText measurement at this font and 572px,
            # not an estimate: description 119px (given 136), note 51px
            # (given 56).
            $form.ClientSize = New-Object System.Drawing.Size 620, 598
            $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
            $form.TopMost = $true
            $form.ShowInTaskbar = $true
            $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
            $form.MaximizeBox = $false; $form.MinimizeBox = $false
            $form.BackColor = $cBg
            $form.ForeColor = $cInk
            $form.Font = Get-OwnerPromptFont 9.75

            $header = New-Object System.Windows.Forms.Panel
            $header.Location = New-Object System.Drawing.Point 0, 0
            $header.Size = New-Object System.Drawing.Size 620, 88
            $header.BackColor = $cSheet
            $form.Controls.Add($header)

            $eyebrow = New-Object System.Windows.Forms.Label
            $eyebrow.Location = New-Object System.Drawing.Point 24, 18
            $eyebrow.Size = New-Object System.Drawing.Size 572, 16
            $eyebrow.Text = 'TOOLSENABLED'
            $eyebrow.ForeColor = $cAccent
            $eyebrow.BackColor = $cSheet
            $eyebrow.Font = Get-OwnerPromptFont 8 ([System.Drawing.FontStyle]::Bold)
            $header.Controls.Add($eyebrow)

            $title = New-Object System.Windows.Forms.Label
            $title.Location = New-Object System.Drawing.Point 24, 38
            $title.Size = New-Object System.Drawing.Size 572, 34
            $title.Text = 'Add your payment method'
            $title.ForeColor = $cInk
            $title.BackColor = $cSheet
            $title.Font = Get-OwnerPromptFont 16
            $header.Controls.Add($title)

            $rule = New-Object System.Windows.Forms.Panel
            $rule.Location = New-Object System.Drawing.Point 0, 88
            $rule.Size = New-Object System.Drawing.Size 620, 1
            $rule.BackColor = $cLine
            $form.Controls.Add($rule)

            $description = New-Object System.Windows.Forms.Label
            $description.Location = New-Object System.Drawing.Point 24, 104
            $description.Size = New-Object System.Drawing.Size 572, 136
            # Only claim the pre-fill when it actually happened.
            $prefillSentence = if ($null -ne $ownerIdentity) {
                ' Your name is pre-filled from your private identity profile.'
            } else {
                ' No private identity profile is stored yet, so enter the name exactly as it appears on the card.'
            }
            # DPAPI here is CurrentUser scope, so the lock on this record is the
            # current Windows sign-in and any process under that sign-in can ask
            # Windows to open it. That is an unavoidable property of storing a card locally (the
            # $VaultOracleDenylist comment at the top of this file says the same
            # thing to engineers), and the dialog states it before collection.
            #
            # AND WHAT IS NOT BEING ASKED FOR. The security code has no field
            # on this window and is never stored (see the record-shape comment
            # above this function). The user is told so here, in the sentence
            # before the format hints, so the missing field reads as a promise
            # kept and not as a form that forgot something.
            $description.Text = "Enter $DisplayName. It is sealed with Windows DPAPI and stored only in the local vault file on this computer -- never uploaded, and never returned to an agent, an MCP response, a log or a report. Any program running under your Windows sign-in can ask Windows to open it, so your Windows account is the lock. The card's security code is not asked for here and is never stored: a purchase asks you for it at the moment of spend and discards it.$prefillSentence Card number accepts spaces; expiration takes MM/YY, for example 12/29."
            $description.ForeColor = $cInk2
            $form.Controls.Add($description)

            $keyLabel = New-Object System.Windows.Forms.Label
            $keyLabel.Location = New-Object System.Drawing.Point 24, 248
            $keyLabel.Size = New-Object System.Drawing.Size 572, 18
            $keyLabel.Text = "Vault key: $VaultKey"
            $keyLabel.ForeColor = $cInk3
            $form.Controls.Add($keyLabel)

            $field = {
                param([string]$Label, [int]$X, [int]$Y, [int]$Width, [bool]$Masked)
                $labelControl = New-Object System.Windows.Forms.Label
                $labelControl.Location = New-Object System.Drawing.Point $X, $Y
                $labelControl.Size = New-Object System.Drawing.Size $Width, 18
                $labelControl.Text = $Label
                $labelControl.ForeColor = $cInk25
                # If a label ever does outgrow its column, end it with an
                # ellipsis rather than a hard cut. A field labelled
                # "Expiration (MM/YY - include /, for example 12/" reads as a
                # broken instruction; "..." at least reads as truncation.
                $labelControl.AutoEllipsis = $true
                $form.Controls.Add($labelControl)
                $box = New-Object System.Windows.Forms.TextBox
                $box.Location = New-Object System.Drawing.Point $X, ($Y + 21)
                # A single-line TextBox derives its height from the font, so only
                # the width is set; forcing a height here is silently discarded.
                $box.Width = $Width
                $box.UseSystemPasswordChar = $Masked
                $box.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
                $box.BackColor = $cSheet
                $box.ForeColor = $cInk
                $form.Controls.Add($box)
                return $box
            }
            # Labels stay short and the guidance moved into the description
            # above. Packing format instructions into a field label is what made
            # them overrun their column in the first place, and a one-or-two word
            # label is the product's register anyway.
            $givenName = & $field 'First / given name' 24 278 284 $false
            $familyName = & $field 'Last / family name' 320 278 276 $false
            if ($null -ne $ownerIdentity) {
                $givenName.Text = $ownerIdentity.givenName
                $familyName.Text = $ownerIdentity.familyName
            }
            $number = & $field 'Card number' 24 334 572 $true
            $expiry = & $field 'Expiration (MM/YY)' 24 390 284 $true
            # The slot beside Expiration used to ask for the security code. It
            # is not asked for at all now (record-shape comment above); the
            # postal code takes the slot so the window carries no hole.
            $postal = & $field 'Billing postal code' 320 390 276 $true

            $note = New-Object System.Windows.Forms.Label
            $note.Location = New-Object System.Drawing.Point 24, 446
            $note.Size = New-Object System.Drawing.Size 572, 56
            # The dialog states current behavior before collection. No code path reads
            # 'payment_card_default'. The only two actions that touch the record
            # are 'present', which reads no content, and 'verify', which
            # decrypts and immediately discards. No checkout, no provider, no
            # tool consumes it. A window that asks for a card number while
            # implying a purchase will follow is collecting card data for
            # nothing, which is the worst of both worlds -- the storage risk
            # without the feature. Until something reads it, the window says so.
            $note.Text = 'Nothing in ToolsEnabled reads this record yet, so saving a card here does not enable a purchase on its own. Save validates basic card structure before encrypting; Cancel leaves the vault unchanged.'
            $note.ForeColor = $cInk3
            $form.Controls.Add($note)

            # If the shared palette could not be loaded the window still opens,
            # but it must not pretend to be the finished article. Say it on the
            # face of the window; an unexplained off-brand prompt asking for a
            # card is the exact thing being fixed here.
            if ($themeResult.Degraded) {
                $degraded = New-Object System.Windows.Forms.Label
                $degraded.Location = New-Object System.Drawing.Point 24, 506
                $degraded.Size = New-Object System.Drawing.Size 572, 18
                $degraded.Text = 'The shared visual theme could not be loaded, so these are fallback colours.'
                $degraded.ForeColor = $cSerious
                $form.Controls.Add($degraded)
            }

            $save = New-Object System.Windows.Forms.Button
            $save.Text = 'Save payment method'
            $save.Location = New-Object System.Drawing.Point 406, 542
            $save.Size = New-Object System.Drawing.Size 190, 34
            $save.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
            $save.FlatAppearance.BorderSize = 0
            $save.BackColor = $cAccentFloor
            $save.ForeColor = $cOnAccent
            $save.Font = Get-OwnerPromptFont 9.75 ([System.Drawing.FontStyle]::Bold)
            $save.Cursor = [System.Windows.Forms.Cursors]::Hand
            $save.Add_Click({
                $normalizedNumber = ($number.Text -replace '[^0-9]', '')
                $expiryMatch = [regex]::Match($expiry.Text, '^\s*(0[1-9]|1[0-2])\s*\/\s*([0-9]{2}|[0-9]{4})\s*$')
                $normalizedPostal = $postal.Text.Trim()
                $normalizedGivenName = (($givenName.Text -replace '\s+', ' ').Trim())
                $normalizedFamilyName = (($familyName.Text -replace '\s+', ' ').Trim())
                if ([string]::IsNullOrWhiteSpace($normalizedGivenName) -or [string]::IsNullOrWhiteSpace($normalizedFamilyName) -or
                    $normalizedGivenName.Length -gt 160 -or $normalizedFamilyName.Length -gt 160 -or
                    -not (Test-ToolsEnabledPaymentCardNumber $normalizedNumber) -or
                    -not $expiryMatch.Success -or
                    [string]::IsNullOrWhiteSpace($normalizedPostal) -or $normalizedPostal.Length -gt 32) {
                    [System.Windows.Forms.MessageBox]::Show($form, 'Enter valid card details or choose Cancel.', 'ToolsEnabled payment method', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
                    return
                }
                $yearText = $expiryMatch.Groups[2].Value
                $year = if ($yearText.Length -eq 2) { 2000 + [int]$yearText } else { [int]$yearText }
                $month = [int]$expiryMatch.Groups[1].Value
                if ($year -lt 2000 -or ([DateTime]::new($year, $month, [DateTime]::DaysInMonth($year, $month)) -lt [DateTime]::Today)) {
                    [System.Windows.Forms.MessageBox]::Show($form, 'Enter a card expiration date that has not passed, or choose Cancel.', 'ToolsEnabled payment method', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
                    return
                }
                # Version 3: the shape documented above this function. It has
                # no security-code key and must never gain one.
                $script:ToolsEnabledPaymentCardPayload = [ordered]@{
                    version = 3
                    cardholder = [ordered]@{ givenName = $normalizedGivenName; familyName = $normalizedFamilyName }
                    cardholderName = (($normalizedGivenName + ' ' + $normalizedFamilyName).Trim())
                    cardNumber = $normalizedNumber
                    expMonth = $month; expYear = $year; postalCode = $normalizedPostal
                } | ConvertTo-Json -Compress
                $form.DialogResult = [System.Windows.Forms.DialogResult]::OK
                $form.Close()
            })
            $form.Controls.Add($save)
            $cancel = New-Object System.Windows.Forms.Button
            $cancel.Text = 'Cancel'
            $cancel.Location = New-Object System.Drawing.Point 294, 542
            $cancel.Size = New-Object System.Drawing.Size 100, 34
            $cancel.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
            $cancel.FlatAppearance.BorderSize = 1
            $cancel.FlatAppearance.BorderColor = $cLine
            $cancel.BackColor = $cSheet
            $cancel.ForeColor = $cInk2
            $cancel.Cursor = [System.Windows.Forms.Cursors]::Hand
            $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
            $form.Controls.Add($cancel); $form.AcceptButton = $save; $form.CancelButton = $cancel
            # Every coordinate above is written against a 96dpi baseline. Now
            # that the process is DPI-aware those are real pixels, so on a 125%
            # display the geometry would stay small while the point-sized fonts
            # grew into it -- which is what clipped the description and cut the
            # Save label to "Save payment m".
            #
            # Scale the GEOMETRY ONLY. Fonts are specified in points and Windows
            # already renders them larger at higher DPI; scaling them here too
            # would apply the factor twice.
            $graphics = $form.CreateGraphics()
            try {
                $scaleFactor = [double]$graphics.DpiX / 96.0
                if ([Math]::Abs($scaleFactor - 1.0) -gt 0.01) {
                    $form.Scale((New-Object System.Drawing.SizeF([single]$scaleFactor, [single]$scaleFactor)))
                }
            }
            finally { $graphics.Dispose() }

            $form.Add_Shown({ $form.BringToFront(); $form.Activate(); $givenName.Focus() })

            $dialogResult = $form.ShowDialog()
            if ($dialogResult -ne [System.Windows.Forms.DialogResult]::OK -or [string]::IsNullOrWhiteSpace($script:ToolsEnabledPaymentCardPayload)) {
                [Console]::Out.Write('{"status":"cancelled"}')
                return
            }
            $plain = $script:ToolsEnabledPaymentCardPayload
            $script:ToolsEnabledPaymentCardPayload = $null
            $status = Invoke-WithVaultLock {
                $data = Read-Vault; $prior = $data.ContainsKey($VaultKey)
                # The interactive dialog is still a write and records whether it
                # replaced an existing record.
                Write-VaultAccessLog -Action 'prompt-payment-card' -Key $VaultKey -Replaced $prior
                $data[$VaultKey] = Protect-PlainText $plain
                Write-Vault $data
                if ($prior) { return 'updated' }; return 'created'
            }
            [Console]::Out.Write((@{ key = $VaultKey; status = [string]$status } | ConvertTo-Json -Compress))
        } finally {
            foreach ($box in @($givenName, $familyName, $number, $expiry, $postal)) { if ($null -ne $box) { $box.Clear(); $box.Dispose() } }
            if ($null -ne $form) { $form.Dispose() }
            $script:ToolsEnabledPaymentCardPayload = $null; $plain = $null; $ownerIdentity = $null
        }
    } finally {
        $promptLock.Dispose()
    }
}

# EVERYTHING BELOW THIS LINE RUNS ONCE PER REQUEST.
#
# A normal per-call invocation (`powershell.exe -File secrets.ps1 <action>`)
# calls this exactly once, at the bottom of this file, and the process exits
# right after -- identical to this code sitting inline at script scope, which
# is what it did before this function existed.
#
# tools/vault-host.ps1 is the other caller: it dot-sources this file once
# with TOOLSENABLED_VAULT_HOST_LIBRARY set (which skips the call at the
# bottom) and then calls Invoke-VaultAction directly, once per line read from
# its own stdin, reassigning $script:Action/$Key/$Keys/$Sequence and
# $script:VaultHostPendingValue before each call. The vault's cross-process
# file lock (Invoke-WithVaultLock above) is untouched by either caller: every
# request, hosted or not, still takes it before touching the vault file.
function Invoke-VaultAction {
if ($Action -eq 'set-monotonic-stdin') {
    if (-not $script:VaultHostSequenceProvided) {
        throw "Action '$Action' requires -Sequence."
    }
} elseif ($script:VaultHostSequenceProvided) {
    throw "-Sequence is valid only with action 'set-monotonic-stdin'."
}

if ($script:PromptLabelProvided -and $Action -notin @('prompt-set', 'prompt-payment-card')) {
    throw "-PromptLabel is valid only with action 'prompt-set' or 'prompt-payment-card'."
}

# -PromptHint is read ONLY by prompt-set and prompt-payment-card (Invoke-Credential-
# Prompt), exactly like -PromptLabel above -- but unlike -PromptLabel and -Sequence
# it was accepted on EVERY action and silently ignored. A parameter that binds,
# carries an arbitrary 360-character string, and is never looked at is a free slot
# on the command line: PowerShell binds -PromptHint:<value> and -PromptHint <value>
# identically, and a command line is readable by any local process through
# Win32_Process. An unused bound parameter would create an argument-smuggling slot.
# An unused parameter that still binds is an argument-smuggling slot; refuse it
# where it means nothing, the way the two beside it already do.
if ($script:PromptHintProvided -and $Action -notin @('prompt-set', 'prompt-payment-card')) {
    throw "-PromptHint is valid only with action 'prompt-set' or 'prompt-payment-card'."
}

switch ($Action) {
    'audit-pair-inspect' {
        if ($script:KeyProvided -or $Keys) { throw 'Audit maintenance has no caller-selected keys.' }
        Get-AuditPairState (Read-AuditRepairVault) | ConvertTo-Json -Compress -Depth 5
    }
    'audit-pair-replace' {
        if ($script:KeyProvided -or $Keys) { throw 'Audit maintenance has no caller-selected keys.' }
        $payload = Read-RequiredStdin
        $request = $payload | ConvertFrom-Json
        if ($null -eq $request -or (@($request.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'anchor,expectedDigest,privateKey' -or
            $request.expectedDigest -notmatch '^[a-f0-9]{64}$' -or $request.privateKey -isnot [string] -or
            $request.anchor -isnot [string] -or [string]::IsNullOrEmpty($request.privateKey) -or [string]::IsNullOrEmpty($request.anchor)) {
            throw 'The audit pair replacement request is invalid.'
        }
        $null = Read-AuditRepairVault
        Invoke-WithVaultLock {
            $data = Read-AuditRepairVault
            $before = Get-AuditPairState $data
            if ($before.digest -cne $request.expectedDigest) {
                [Console]::Out.WriteLine('{"code":"AUDIT_REKEY_VAULT_CHANGED"}')
                return
            }
            $data['toolsenabled_audit_signing_key_v1'] = Protect-PlainText $request.privateKey
            $data['toolsenabled_audit_head_v1'] = Protect-PlainText $request.anchor
            Write-Vault $data
            Write-VaultAccessLog -Action 'audit-pair-replace' -Key 'toolsenabled_audit_signing_key_v1' -Replaced $true
            Write-VaultAccessLog -Action 'audit-pair-replace' -Key 'toolsenabled_audit_head_v1' -Replaced $true
            Get-AuditPairState $data | ConvertTo-Json -Compress -Depth 5
        }
    }
    'set' {
        Assert-Key $Key
        if ([Console]::IsInputRedirected) {
            throw "Action 'set' requires an interactive hidden prompt; automation must use 'set-stdin'."
        }
        $secure = Read-Host -Prompt "Enter value for '$Key'" -AsSecureString
        if ($secure.Length -eq 0) { throw 'Secret value must not be empty.' }
        Invoke-WithVaultLock {
            $data = Read-Vault
            Write-VaultAccessLog -Action 'set' -Key $Key -Replaced $data.ContainsKey($Key)
            $data[$Key] = ConvertFrom-SecureString -SecureString $secure
            Write-Vault $data
        }
        [Console]::Error.WriteLine("stored '$Key'")
    }
    'set-stdin' {
        # THE INVERTED POSTURE, AND THIS IS THE LINE THAT RIGHTS IT.
        # Every action that reads a payment-card record leaves a line in
        # the access log -- 'get' (and its denial), 'list',
        # 'exists', 'present', 'verify' -- and 'del' was added when the same
        # argument was made about destroying a record. This verb, the one that
        # REPLACES the record, left nothing. So a card silently overwritten
        # with another value was invisible while merely looking at it was not,
        # which is the security posture upside down: reading a secret is
        # recoverable, having yours quietly swapped for someone else's is not.
        # Logged INSIDE the lock and BEFORE the assignment, exactly as 'del'
        # is, so `replaced` states what was actually on file at the instant it
        # was overwritten rather than what a later reader could guess. The
        # value on stdin is never touched, measured, hashed or described here.
        Assert-Key $Key
        $plain = Read-RequiredStdin
        Invoke-WithVaultLock {
            $data = Read-Vault
            Write-VaultAccessLog -Action 'set-stdin' -Key $Key -Replaced $data.ContainsKey($Key)
            $data[$Key] = Protect-PlainText $plain
            Write-Vault $data
        }
        [Console]::Error.WriteLine("stored '$Key'")
    }
    'set-pair-stdin' {
        # A pair must become visible as one vault generation.  This is used for
        # coupled OAuth refresh/access credentials: writing either separately
        # could leave a failed authorization with a half-new credential state.
        $payload = Read-RequiredStdin
        try { $pair = $payload | ConvertFrom-Json } catch { throw 'Secret pair input must be valid JSON.' }
        if ($null -eq $pair -or $null -eq $pair.PSObject.Properties['first'] -or $null -eq $pair.PSObject.Properties['second']) {
            throw 'Secret pair input must contain first and second entries.'
        }
        $firstKey = [string]$pair.first.key
        $firstValue = [string]$pair.first.value
        $secondKey = [string]$pair.second.key
        $secondValue = [string]$pair.second.value
        Assert-Key $firstKey
        Assert-Key $secondKey
        if ($firstKey -eq $secondKey -or [string]::IsNullOrEmpty($firstValue) -or [string]::IsNullOrEmpty($secondValue)) {
            throw 'Secret pair keys must be distinct and values must not be empty.'
        }
        Invoke-WithVaultLock {
            $data = Read-Vault
            # One line per KEY, not one per action: the pair is atomic in the
            # vault but a reader of this log is asking about a key, and a single
            # line naming two of them cannot answer "was my card replaced".
            Write-VaultAccessLog -Action 'set-pair-stdin' -Key $firstKey -Replaced $data.ContainsKey($firstKey)
            Write-VaultAccessLog -Action 'set-pair-stdin' -Key $secondKey -Replaced $data.ContainsKey($secondKey)
            $data[$firstKey] = Protect-PlainText $firstValue
            $data[$secondKey] = Protect-PlainText $secondValue
            Write-Vault $data
        }
        [Console]::Error.WriteLine('stored credential pair')
    }
    'set-triple-stdin' {
        # The Chrome Web Store API client, its secret, and publisher identity
        # are one authorization binding. A partial update would make future
        # API authorization ambiguous, so commit all three atomically.
        $payload = Read-RequiredStdin
        try { $triple = $payload | ConvertFrom-Json } catch { throw 'Secret triple input must be valid JSON.' }
        if ($null -eq $triple -or $null -eq $triple.PSObject.Properties['first'] -or $null -eq $triple.PSObject.Properties['second'] -or $null -eq $triple.PSObject.Properties['third']) {
            throw 'Secret triple input must contain first, second, and third entries.'
        }
        $firstKey = [string]$triple.first.key
        $firstValue = [string]$triple.first.value
        $secondKey = [string]$triple.second.key
        $secondValue = [string]$triple.second.value
        $thirdKey = [string]$triple.third.key
        $thirdValue = [string]$triple.third.value
        Assert-Key $firstKey
        Assert-Key $secondKey
        Assert-Key $thirdKey
        if ($firstKey -eq $secondKey -or $firstKey -eq $thirdKey -or $secondKey -eq $thirdKey -or [string]::IsNullOrEmpty($firstValue) -or [string]::IsNullOrEmpty($secondValue) -or [string]::IsNullOrEmpty($thirdValue)) {
            throw 'Secret triple keys must be distinct and values must not be empty.'
        }
        Invoke-WithVaultLock {
            $data = Read-Vault
            foreach ($tripleKey in @($firstKey, $secondKey, $thirdKey)) {
                Write-VaultAccessLog -Action 'set-triple-stdin' -Key $tripleKey -Replaced $data.ContainsKey($tripleKey)
            }
            $data[$firstKey] = Protect-PlainText $firstValue
            $data[$secondKey] = Protect-PlainText $secondValue
            $data[$thirdKey] = Protect-PlainText $thirdValue
            Write-Vault $data
        }
        [Console]::Error.WriteLine('stored credential triple')
    }
    'get-or-create-stdin' {
        Assert-Key $Key
        # THE FOURTH DOOR ONTO A DENYLISTED RECORD, and it was open.
        #
        # 'get' refuses these keys, and so do 'get-many' and 'list'. This verb
        # did not -- and its read branch below DECRYPTS AND RETURNS an existing
        # record, which the comment there already concedes is "a read by every
        # definition the log already uses for 'get' and 'verify'". The product
        # policy promise -- that this record is never returned to an agent, MCP
        # response, log or report -- was true of three doors out of four.
        #
        # REFUSED BEFORE THE VAULT IS OPENED, not after the lookup. Refusing only
        # when the record is present would answer "does this record exist"
        # through the refusal itself: a smaller oracle of exactly the same kind.
        # 'present' is the action that answers that question, on purpose.
        #
        # Callers checked before this landed: getOrCreateSecret is reached from
        # src/lib/audit.js (the audit signing key) and
        # src/lib/providers/agent-sandbox.js (a sandbox encryption secret).
        # Neither is a denylisted key, so this refuses nothing that exists.
        if ($VaultOracleDenylist -contains $Key) {
            Write-VaultAccessLog -Action 'get-or-create-stdin' -Key $Key -Denied
            throw "ACCESS_DENIED_ORACLE_SCOPE: '$Key' is never returned through the generic vault 'get-or-create-stdin' action under the built-in vault policy. Its capture dialog promised this record is never returned to an agent, MCP response, log, or report. Use the 'present' action to learn only whether a record exists."
        }
        $candidate = Read-RequiredStdin
        $selected = Invoke-WithVaultLock {
            $data = Read-Vault
            if ($data.ContainsKey($Key)) {
                # BOTH BRANCHES LEAVE A LINE, because this verb is two actions
                # wearing one name. Here it DECRYPTS AND RETURNS an existing
                # record -- a read by every definition the log already uses for
                # 'get' and 'verify' -- and it was the one read path in this
                # file that never said so. `present` alone marks the read; the
                # create branch below adds `replaced` so the two lines can never
                # be confused for each other by a later reader.
                Write-VaultAccessLog -Action 'get-or-create-stdin' -Key $Key -Present $true
                return Unprotect-CipherText $data[$Key]
            }
            Write-VaultAccessLog -Action 'get-or-create-stdin' -Key $Key -Present $false -Replaced $false
            $data[$Key] = Protect-PlainText $candidate
            Write-Vault $data
            return $candidate
        }
        [Console]::Out.Write($selected)
    }
    'set-monotonic-stdin' {
        Assert-Key $Key
        if ($Sequence -lt 0) { throw 'Sequence must be a non-negative integer.' }
        $plain = Read-RequiredStdin
        $embeddedSequence = Read-EmbeddedSequence $plain
        if ($embeddedSequence -ne $Sequence) {
            throw 'The JSON sequence does not match the -Sequence argument.'
        }
        Invoke-WithVaultLock {
            $data = Read-Vault
            # Logged before the monotonic guard runs, not after it: a REFUSED
            # advance is a caller that tried to move the audit anchor backward
            # or fork it, and that attempt is more interesting than an accepted
            # one, not less. A line written only on success would be silent for
            # exactly the case worth investigating. The sequence numbers are
            # deliberately absent -- the key and the fact of the attempt are
            # metadata, an anchor value is content.
            Write-VaultAccessLog -Action 'set-monotonic-stdin' -Key $Key -Replaced $data.ContainsKey($Key)
            if ($data.ContainsKey($Key)) {
                $current = Unprotect-CipherText $data[$Key]
                $currentSequence = Read-EmbeddedSequence $current
                if ($Sequence -lt $currentSequence) {
                    throw "Monotonic secret '$Key' cannot move backward."
                }
                if ($Sequence -eq $currentSequence) {
                    if ($plain -cne $current) {
                        throw "Monotonic secret '$Key' has a conflicting value at sequence $Sequence."
                    }
                    Write-VaultContentDigest
                    return
                }
            }
            $data[$Key] = Protect-PlainText $plain
            Write-Vault $data
            # Reported from INSIDE the lock, so the digest names a vault that
            # holds exactly this anchor and nothing a later writer added. The
            # caller pairs it with the anchor it just stored (audit.js
            # writeAnchor) and can serve its own head from cache until the
            # bytes change, instead of paying a helper process to re-read
            # what it wrote. Measured 2026-09-02: that re-read was one of two
            # powershell.exe spawns per audited tool call.
            Write-VaultContentDigest
        }
        [Console]::Error.WriteLine("stored monotonic '$Key' at sequence $Sequence")
    }
    'prompt-set' {
        Assert-Key $Key
        $displayName = if ([string]::IsNullOrWhiteSpace($PromptLabel)) { 'a local credential' } else { $PromptLabel }
        Invoke-CredentialPrompt -VaultKey $Key -DisplayName $displayName -PromptHint $PromptHint
    }
    'prompt-payment-card' {
        Assert-Key $Key
        $displayName = if ([string]::IsNullOrWhiteSpace($PromptLabel)) { 'a local payment card' } else { $PromptLabel }
        Invoke-PaymentCardPrompt -VaultKey $Key -DisplayName $displayName
    }
    'scrub-payment-card-cvc' {
        # REMOVE THE SECURITY CODE FROM A CARD RECORD CAPTURED BEFORE THE
        # INVARIANT EXISTED. See the record-shape comment above the live
        # Invoke-PaymentCardPrompt: version 1 and 2 records were written with a
        # `cvc` field; nothing may hold one now under built-in product policy and
        # PCI DSS 3.2. This verb opens the record inside the vault lock, drops that
        # field if it is there, re-seals and rewrites the record in place, and
        # answers on stdout with exactly one of:
        #   {"key":"payment_card_default","status":"scrubbed"}  a field was removed
        #   {"key":"payment_card_default","status":"clean"}     nothing to remove
        #   {"key":"payment_card_default","status":"absent"}    no record on file
        # It never prints, measures or logs anything from inside the record.
        # Every other field, and the version label, survive byte-for-byte in
        # meaning: the scrub did not capture this record and does not relabel
        # it. It is bound to the one key that can hold a card; it is not a
        # generic "delete a property" tool, so any other -Key is refused.
        #
        # This is the verb an app-side reset / hygiene surface calls (through
        # src/lib/runtime.js scrubPaymentCardSecurityCode); it opens no window
        # and is safe to run unattended. Running it against a real vault is the
        # owner's call, never an agent's.
        $scrubKey = 'payment_card_default'
        if ($script:KeyProvided -and $Key -ne $scrubKey) {
            throw "Action 'scrub-payment-card-cvc' only ever operates on '$scrubKey'."
        }
        $outcome = Invoke-WithVaultLock {
            $data = Read-Vault
            if (-not $data.ContainsKey($scrubKey)) {
                Write-VaultAccessLog -Action 'scrub-payment-card-cvc' -Key $scrubKey -Present $false
                return 'absent'
            }
            $plain = $null; $record = $null; $rewritten = $null
            try {
                $plain = Unprotect-CipherText $data[$scrubKey]
                $record = $plain | ConvertFrom-Json -ErrorAction Stop
                $carried = @($record.PSObject.Properties | Where-Object { $_.Name -in @('cvc', 'cvv', 'securityCode', 'security_code') })
                if ($carried.Count -eq 0) {
                    # Opened and found clean is still a READ of the record.
                    Write-VaultAccessLog -Action 'scrub-payment-card-cvc' -Key $scrubKey -Present $true -Replaced $false
                    return 'clean'
                }
                foreach ($property in $carried) { $record.PSObject.Properties.Remove($property.Name) }
                $rewritten = $record | ConvertTo-Json -Compress -Depth 5
                # Logged BEFORE the rewrite, like every other mutation here.
                Write-VaultAccessLog -Action 'scrub-payment-card-cvc' -Key $scrubKey -Present $true -Replaced $true
                $data[$scrubKey] = Protect-PlainText $rewritten
                Write-Vault $data
                return 'scrubbed'
            } finally {
                $plain = $null; $record = $null; $rewritten = $null; $carried = $null
            }
        }
        [Console]::Out.Write((@{ key = $scrubKey; status = [string]$outcome } | ConvertTo-Json -Compress))
    }
    'get' {
        Assert-Key $Key
        if ($VaultOracleDenylist -contains $Key) {
            Write-VaultAccessLog -Action 'get' -Key $Key -Denied
            throw "ACCESS_DENIED_ORACLE_SCOPE: '$Key' is never returned through the generic vault 'get' action under the built-in vault policy. Its capture dialog promised this record is never returned to an agent, MCP response, log, or report. Use the 'present' action to learn only whether a record exists."
        }
        Write-VaultAccessLog -Action 'get' -Key $Key
        $data = Read-Vault
        if (-not $data.ContainsKey($Key)) { throw "key not found: $Key" }
        [Console]::Out.Write((Unprotect-CipherText $data[$Key]))
    }
    # EXACTLY N x 'get', IN ONE PROCESS. NO MORE AUTHORITY THAN THAT.
    #
    # The saving is process starts, not checks. Every per-key control 'get'
    # applies is applied here too, per key, deliberately duplicated rather than
    # factored away so a reader can see they are all present:
    #   * Assert-Key on each name
    #   * $VaultOracleDenylist refusal. Denylisted keys are refused here exactly as in 'get'.
    #   * Write-VaultAccessLog per key, so batching removes spawns, never the
    #     record of what was read.
    #
    # A missing key is reported per key rather than failing the batch, so the
    # SECRET_NOT_CONFIGURED distinction 'get' provides survives -- collapsing
    # them into one generic failure would be the same diagnosis erasure already
    # fixed twice in the audit path.
    'get-many' {
        if ([string]::IsNullOrWhiteSpace($Keys)) { throw 'get-many requires at least one key.' }
        $KeyList = @($Keys.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
        if ($KeyList.Count -eq 0) { throw 'get-many requires at least one key.' }
        foreach ($Candidate in $KeyList) {
            Assert-Key $Candidate
            if ($VaultOracleDenylist -contains $Candidate) {
                Write-VaultAccessLog -Action 'get-many' -Key $Candidate -Denied
                throw "ACCESS_DENIED_ORACLE_SCOPE: '$Candidate' is never returned through the generic vault 'get' action under the built-in vault policy. Its capture dialog promised this record is never returned to an agent, MCP response, log, or report. Use the 'present' action to learn only whether a record exists."
            }
        }
        $data = Read-Vault
        $result = [ordered]@{}
        foreach ($Candidate in $KeyList) {
            Write-VaultAccessLog -Action 'get-many' -Key $Candidate
            if ($data.ContainsKey($Candidate)) {
                $result[$Candidate] = [ordered]@{ found = $true; value = (Unprotect-CipherText $data[$Candidate]) }
            } else {
                $result[$Candidate] = [ordered]@{ found = $false }
            }
        }
        [Console]::Out.Write(($result | ConvertTo-Json -Compress -Depth 4))
    }
    'clear-device-credential' {
        # A fixed transaction for Disconnect, never a generic key selector.
        # Presence and removal share the existing cross-process vault lock.
        # No ciphertext or plaintext is returned, and unrelated ciphertext is
        # copied unchanged through the normal protected Windows vault writer.
        $transaction = @{ outcome = 'NOT_ATTEMPTED'; cause = 'SECRET_INPUT_INVALID'; result = $null }
        try {
            if ($KeyProvided) { throw 'The fixed operation does not accept a key.' }
            $fixedKey = 'custom.online_fra_device_credential_v1'
            $transaction.cause = 'SECRET_VAULT_PATH_UNSAFE'
            Invoke-WithVaultLock {
                $transaction.cause = 'SECRET_VAULT_UNREADABLE'
                $data = @{}
                if (Test-Path -LiteralPath $VaultFile) {
                    # Existing damaged data is unknown, never an empty store.
                    # Do not coerce arrays, nulls or non-string records through
                    # the generic Read-Vault compatibility path while deleting.
                    $item = Get-Item -LiteralPath $VaultFile -Force
                    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
                        throw 'The store is not a regular file.'
                    }
                    $raw = [IO.File]::ReadAllText($VaultFile, [Text.UTF8Encoding]::new($false, $true))
                    if ([string]::IsNullOrWhiteSpace($raw) -or -not $raw.TrimStart().StartsWith('{')) {
                        throw 'The store is not a record object.'
                    }
                    $object = $raw | ConvertFrom-Json
                    if ($null -eq $object -or $object -isnot [pscustomobject]) { throw 'The store is not a record object.' }
                    foreach ($property in $object.PSObject.Properties) {
                        Assert-Key $property.Name
                        if ($property.Value -isnot [string] -or $data.ContainsKey($property.Name)) { throw 'The store has an invalid record.' }
                        $data[$property.Name] = $property.Value
                    }
                }
                $existed = $data.ContainsKey($fixedKey)
                Write-VaultAccessLog -Action 'clear-device-credential' -Key $fixedKey -Present $existed
                if ($existed) {
                    $data.Remove($fixedKey) | Out-Null
                    # From the write attempt onward, any lost completion is
                    # uncertain. Write-Vault flushes the staged bytes, performs
                    # the stock write-through replacement, and checks the ACL.
                    # REMOVED_SYNCED names those Windows calls completing; it
                    # does not assert POSIX directory-fsync or power-loss parity.
                    $transaction.outcome = 'UNCERTAIN'
                    $transaction.cause = 'SECRET_VAULT_WRITE_UNCERTAIN'
                    Write-Vault $data
                    $transaction.result = [ordered]@{ key = $fixedKey; status = 'cleared'; mutationOutcome = 'REMOVED_SYNCED' }
                } else {
                    $transaction.result = [ordered]@{ key = $fixedKey; status = 'absent'; mutationOutcome = 'NOT_ATTEMPTED' }
                }
            }
            [Console]::Out.WriteLine(([ordered]@{ ok = $true; result = $transaction.result } | ConvertTo-Json -Compress -Depth 4))
        } catch {
            # Fixed metadata only. Never copy a parser, filesystem or DPAPI
            # diagnostic, since it may quote a path or stored record.
            [Console]::Out.WriteLine(([ordered]@{ ok = $false; code = $transaction.cause; mutationOutcome = $transaction.outcome } | ConvertTo-Json -Compress))
            exit 1
        }
    }
    'del' {
        # DESTROYING A RECORD IS AT LEAST AS INTERESTING AS READING ONE.
        # Before this line existed, the owner's payment card could be removed
        # from the vault with no trace anywhere -- the same silence the access
        # log was built to remove for 'get'. Logged INSIDE the lock and BEFORE
        # the removal, so the line records what was actually on file at the
        # moment it was taken away rather than what a later reader can infer.
        Assert-Key $Key
        Invoke-WithVaultLock {
            $data = Read-Vault
            $existed = $data.ContainsKey($Key)
            Write-VaultAccessLog -Action 'del' -Key $Key -Present $existed
            if ($existed) {
                $data.Remove($Key) | Out-Null
                Write-Vault $data
            }
        }
        [Console]::Error.WriteLine("deleted '$Key'")
    }
    'list' {
        # Denylisted keys (see $VaultOracleDenylist above) are omitted from
        # enumeration too -- there is no legitimate reason for the generic
        # oracle to even confirm their existence, let alone their value.
        $visibleKeys = @((Read-Vault).Keys | Where-Object { $VaultOracleDenylist -notcontains $_ } | Sort-Object)
        Write-VaultAccessLog -Action 'list' -ResultCount $visibleKeys.Count
        $visibleKeys | ForEach-Object { [Console]::Out.WriteLine($_) }
    }
    'exists' {
        # THE SAME QUESTION AS 'present', SO IT MUST LEAVE THE SAME TRACE.
        # This action predates $VaultOracleDenylist and the access log, and the
        # 'present' comment below says so out loud: it "has answered this same
        # question for every key since before the denylist, SILENTLY". That was
        # a measured hole -- `secrets.ps1 exists payment_card_default` told a
        # caller whether the owner's card was on file and left nothing behind.
        # Same-user access cannot be prevented here (see the denylist comment at
        # the top of this file); the product policy makes it visible
        # instead, and an unlogged twin of a logged action defeats exactly that.
        # Exit codes are deliberately unchanged -- 0 exists, 1 does not -- so
        # every existing caller behaves identically; only the silence is gone.
        Assert-Key $Key
        $data = $null
        try { $data = Read-Vault }
        catch {
            Write-VaultAccessLog -Action 'exists' -Key $Key -Unreadable
            throw
        }
        if ($data.ContainsKey($Key)) {
            Write-VaultAccessLog -Action 'exists' -Key $Key -Present $true
            exit 0
        }
        Write-VaultAccessLog -Action 'exists' -Key $Key -Present $false
        exit 1
    }
    'present' {
        # IS THERE A RECORD UNDER THIS KEY -- and nothing else, ever.
        #
        # WHY THIS EXISTS AND WHY IT IS NOT A HOLE IN $VaultOracleDenylist.
        # The denylist bars two records from being RETURNED through the generic
        # 'get'/'list' path, because this script's own capture dialogs promise
        # each record "is never returned to an agent, MCP response, log, or
        # report". That promise is about CONTENT. It was never a promise that
        # the product may not know whether the owner has a card on file -- and
        # reading it that way produced a real defect: payment_method.card_status
        # routed through the denied 'get', so the product told the owner he had
        # no card while his card sat in the vault. A product that cannot see its
        # own payment method is not more secure, it is wrong.
        #
        # This action therefore answers ONE BIT, through the exit code, with no
        # value, no length, no digest, no ciphertext and nothing on stdout. It
        # does not call Unprotect-CipherText, so it cannot fail in a way that
        # depends on the record's content, and a caller learns nothing from it
        # that it could not already learn from 'exists' -- which has answered
        # this same question for every key since before the denylist, silently.
        # Unlike 'exists' this one is logged: same-user presence cannot be prevented, so it is made
        # visible instead.
        #
        # EXIT CODES, and the distinction the caller must not collapse:
        #   0  a record exists under this key
        #   3  the vault was read and holds no record under this key
        #   4  the vault EXISTS AND COULD NOT BE READ -- neither true nor false
        #   5  this computer has no vault store at all
        # 4 is the one that matters. An unreadable vault reported as "absent"
        # renders on the owner's screen as "no card on file", which is a false
        # statement about his money made out of a permissions error.
        Assert-Key $Key
        if (-not (Test-Path -LiteralPath $VaultFile)) {
            Write-VaultAccessLog -Action 'present' -Key $Key -Present $false
            exit 5
        }
        $data = $null
        try {
            $data = Read-Vault
        } catch {
            # The reason is deliberately not carried out of this process: a
            # parse error can quote the file it failed on. The log line records
            # that the question was asked and could not be answered.
            Write-VaultAccessLog -Action 'present' -Key $Key -Unreadable
            exit 4
        }
        if ($null -eq $data) {
            Write-VaultAccessLog -Action 'present' -Key $Key -Unreadable
            exit 4
        }
        if ($data.ContainsKey($Key)) {
            Write-VaultAccessLog -Action 'present' -Key $Key -Present $true
            exit 0
        }
        Write-VaultAccessLog -Action 'present' -Key $Key -Present $false
        exit 3
    }
    'verify' {
        # Verify a single DPAPI record without emitting the plaintext, its
        # length, or the encrypted blob. Exit 0 means the current desktop can
        # read it; exit 3 means it is absent. A decryption/format failure is a
        # terminal diagnostic error rather than a false-positive presence.
        #
        # AND IT IS LOGGED, because this action really does OPEN the record.
        # 'present' is careful never to call Unprotect-CipherText; this one does,
        # which means `secrets.ps1 verify payment_card_default` proved to its
        # caller that this desktop's DPAPI can decrypt the owner's card -- and,
        # before this line, proved it with no trace at all. That is the one
        # thing the access log exists to prevent. The line goes BEFORE the
        # decrypt, on the same principle as 'get': an attempt that crashes the
        # process must still have left evidence that it was made. What is
        # recorded stays metadata -- the action, the key name, and whether a
        # record was there -- never the plaintext, its length, or the blob.
        Assert-Key $Key
        $data = Read-Vault
        if (-not $data.ContainsKey($Key)) {
            Write-VaultAccessLog -Action 'verify' -Key $Key -Present $false
            exit 3
        }
        Write-VaultAccessLog -Action 'verify' -Key $Key -Present $true
        $plain = $null
        try { $plain = Unprotect-CipherText $data[$Key] }
        finally { $plain = $null }
        exit 0
    }
}
}

# A normal per-call invocation still dispatches immediately and exits, exactly
# as this code did before it moved inside Invoke-VaultAction above.
# tools/vault-host.ps1 sets TOOLSENABLED_VAULT_HOST_LIBRARY before dot-sourcing
# this file so it can call Invoke-VaultAction itself, once per request, instead.
if (-not $env:TOOLSENABLED_VAULT_HOST_LIBRARY) {
    Invoke-VaultAction
}
