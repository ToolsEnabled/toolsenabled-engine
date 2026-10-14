# THE ACL THE PRODUCT PUTS ON A CUSTOMER'S CREDENTIAL STORE.
#
# THE DEFECT THIS FILE EXISTS TO FIX, measured on 2026-08-11 against the real
# per-user install at %LOCALAPPDATA%\Programs\toolsenabled. Every ACE on the
# installed resources/capability/vault/secrets.json was INHERITED:
#
#     <MACHINE>\CodexSandboxUsers:(I)(RX)
#     NT AUTHORITY\SYSTEM:(I)(F)
#     BUILTIN\Administrators:(I)(F)
#     <MACHINE>\<account>:(I)(F)
#
# (The machine and account names are placeholders on purpose. This file is
# staged into the shipping capability payload, so a real one pasted here is
# owner data in the installer -- `node tools/check-no-owner-data.mjs` counted
# three matches from the two lines above and refused the payload, which is
# exactly the guard working. The ACEs are what matter, not whose box they came
# from.)
#
# -- because nothing in the product had ever set one. tools/secrets.ps1 and
# tools/secrets-manager.ps1 both created the store with a plain
# `New-Item -ItemType Directory` and let it inherit whatever the install
# location happened to grant. The confidentiality of a customer's credential
# store was therefore an accident of WHERE THEY INSTALLED, not a property of
# the product. That is the shipping defect; this file is the fix.
#
# THE INHERITANCE SOURCES ARE NOT HYPOTHETICAL. Measured on this machine:
#     C:\ProgramData    BUILTIN\Users:(OI)(CI)(RX) and (CI)(WD,AD,WEA,WA)
#     C:\Program Files  BUILTIN\Users:(OI)(CI)(IO)(GR,GE)
# So a per-machine or ProgramData-sited install produced a credential store
# readable by every account on the machine, the ProgramData variant also
# letting any user create files inside the vault directory.
#
# DPAPI ENCRYPTS THE VALUES, AND THAT IS NOT A DEFENCE OF THE OLD BEHAVIOUR.
# The store still carries secret NAMES, capture reasons and expiry metadata,
# the access log beside it records what was read and when, and a vault
# directory anyone may write to is a tampering and denial surface. "The values
# happen to be encrypted" is not a reason to hand the file to every account.
#
# THE RULE: the credential store is readable and writable by the account that
# legitimately needs it, plus SYSTEM and Administrators, and by nobody else,
# on a PROTECTED (non-inheriting) DACL so that it no longer matters what the
# parent directory grants.
#
# ADMINISTRATORS IS KEPT DELIBERATELY. On Windows an administrator can take
# ownership of any file regardless, so removing the ACE buys no real
# confidentiality while costing the customer their own backup and recovery
# path. SYSTEM is kept for the same reason.
#
# THE DIRECTORY CARRIES INHERITABLE ACEs ON PURPOSE. Files the vault creates
# later -- the atomic temp file, the .bak, the lock files, the access log --
# then land correct by construction. The alternative is remembering to lock
# each new file by hand, which is the failure mode src/lib/runtime-state-root.js
# already names ("a credential's location should not depend on remembering to
# lock each file"), and it is how this defect survived a file-by-file audit:
# that comment asserted the individual files carried owner-only ACLs, and
# measurement showed all four ACEs inherited.
#
# ----------------------------------------------------------------------------
# THIS IS THE VAULT ONLY. DO NOT WIDEN IT TO THE REPOSITORY ROOT.
# ----------------------------------------------------------------------------
# tools/fra-root-access-control.ps1 DELIBERATELY grants CodexSandboxUsers
# Modify on the repository root with (OI)(CI), and tools/fra-root-access-probe.ps1
# REQUIRES it there with an exact rule count -- Full Remote Access breaks
# without it. Narrowing the vault is the exception to that inheritance, never a
# licence to tighten the tree. tests/vault-live-acl.test.js asserts both
# directions for exactly this reason.
#
# THIS IS A NO-OP ON AN ALREADY-CORRECT STORE. The check runs before the write,
# so a vault that already matches (the developer checkout, hardened on
# 2026-08-11) is measured and left byte-identical rather than rewritten.
#
# No secret value is read, written or logged here. This file touches ACLs only
# and never opens vault file CONTENT.

# The three principals a credential store may grant, and nothing else. Returned
# as SIDs so the comparison never depends on a localized account name.
function Initialize-NativeVaultPermissions {
    if (-not ('ToolsEnabled.VaultPermissionsV1' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'vault-permissions.cs') -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Security.dll') -ErrorAction Stop
    }
}

function Get-VaultAclAllowedSids {
    $allowed = New-Object System.Collections.Generic.List[string]
    $allowed.Add([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
    $allowed.Add('S-1-5-18')        # NT AUTHORITY\SYSTEM
    $allowed.Add('S-1-5-32-544')    # BUILTIN\Administrators
    return $allowed
}

function New-VaultAcl {
    param([Parameter(Mandatory = $true)][bool]$Container)

    if ($Container) {
        $acl = New-Object System.Security.AccessControl.DirectorySecurity
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        $acl = New-Object System.Security.AccessControl.FileSecurity
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }

    # $true  = protect the DACL from inheritance
    # $false = do NOT copy the inherited rules down before protecting it, which
    #          is the whole point: copying them would preserve the very ACE
    #          this file exists to remove.
    $acl.SetAccessRuleProtection($true, $false)

    $propagation = [System.Security.AccessControl.PropagationFlags]::None
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $rights = [System.Security.AccessControl.FileSystemRights]::FullControl
    foreach ($sidValue in (Get-VaultAclAllowedSids)) {
        $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue)
        $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid, $rights, $inheritance, $propagation, $allow)))
    }
    return $acl
}

function Test-VaultPathProtected {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$Container
    )

    if ($env:TOOLSENABLED_VAULT_HOST_LIBRARY -eq '1') {
        Initialize-NativeVaultPermissions
        return [ToolsEnabled.VaultPermissionsV1]::IsProtected($Path, $Container)
    }
    $access = [System.Security.AccessControl.AccessControlSections]::Access
    try {
        if ($Container) {
            $acl = [System.IO.Directory]::GetAccessControl($Path, $access)
        } else {
            $acl = [System.IO.File]::GetAccessControl($Path, $access)
        }
    } catch {
        # An ACL that cannot be read cannot be called safe.
        return $false
    }

    if (-not $acl.AreAccessRulesProtected) { return $false }
    $allowed = Get-VaultAclAllowedSids
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne $allowed.Count) { return $false }
    $required = @{}
    foreach ($sid in $allowed) { $required[$sid] = 0 }
    $fullControl = [int64][System.Security.AccessControl.FileSystemRights]::FullControl
    $expectedInheritance = if ($Container) {
        [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor `
            [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [System.Security.AccessControl.InheritanceFlags]::None
    }
    foreach ($rule in $rules) {
        if ($rule.IsInherited) { return $false }
        if (-not $allowed.Contains($rule.IdentityReference.Value)) { return $false }
        if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { return $false }
        if ([int64]$rule.FileSystemRights -ne $fullControl) { return $false }
        if ($rule.InheritanceFlags -ne $expectedInheritance) { return $false }
        if ($rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { return $false }
        $required[$rule.IdentityReference.Value]++
    }
    return @($required.Values | Where-Object { $_ -ne 1 }).Count -eq 0
}

function Protect-VaultPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        # Tolerate a file another process currently holds with a deny-share
        # handle. The vault's own lock files are held exactly that way while a
        # vault operation is in flight, and they carry no credential material --
        # they are empty rendezvous paths. The DIRECTORY's protected DACL is the
        # guarantee that matters, because anything created inside it inherits;
        # a file busy right now is re-checked on the next call. This switch is
        # never used for the vault file itself.
        [switch]$TolerateInUse
    )

    if ($env:TOOLSENABLED_VAULT_HOST_LIBRARY -eq '1') {
        Initialize-NativeVaultPermissions
        [ToolsEnabled.VaultPermissionsV1]::ProtectPath($Path, [bool]$TolerateInUse)
        return
    }
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue

    # A TRANSIENT READ IS NOT A FINDING ABOUT THE PATH, and this line used to
    # report it as the most alarming finding this function has.
    #
    # Windows answers GetFileAttributes for a file that is being created,
    # replaced or removed underneath the caller with INVALID_FILE_ATTRIBUTES,
    # which .NET surfaces as an Attributes value of -1 -- every bit set. The
    # reparse-point test below is a bitwise AND, so -1 satisfies it, and the
    # function announced that the owner's credential store was a reparse point
    # and refused to harden it. Nothing was wrong with the store.
    #
    # This is reached because Initialize-ProtectedVaultStore enumerates the
    # directory's files and hardens each one, and a vault directory under
    # concurrent writes always has files in flux: secrets.ps1's Write-Vault
    # stages `.secrets.json.<pid>.<guid>.tmp`, atomically replaces the vault,
    # and the access log is appended to. Measured on this machine, 24 parallel
    # `set-stdin` calls: 1 of 4 rounds failed this way before the write half of
    # the access log existed at all, and more often once it did.
    #
    # THE SECURITY PROPERTY IS UNCHANGED. An attribute set that was actually
    # READ and actually carries ReparsePoint still throws, for a directory and
    # for the vault file alike. What is new is that a value which could not be
    # read is treated as exactly what it is -- unknown -- and takes the same
    # route the in-use case already takes: tolerated for a child that will be
    # re-checked on the next call, and a hard refusal anywhere the caller did
    # not say a retry is acceptable. It is never silently treated as safe.
    $attributes = if ($null -eq $item) { -1 } else { [int]$item.Attributes }
    if ($attributes -eq -1) {
        if ($TolerateInUse) { return }
        throw ('SECRET_STORE_ACL_UNSAFE: the credential store path could not be inspected, ' +
            'so it was not hardened.')
    }
    if (($attributes -band [int][System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('SECRET_STORE_ACL_UNSAFE: the credential store path is a reparse point and ' +
            'will not be hardened in place.')
    }
    $container = [bool]$item.PSIsContainer

    # Measure before mutating: an already-correct store is left byte-identical.
    if (Test-VaultPathProtected -Path $Path -Container $container) { return }

    try {
        $acl = New-VaultAcl -Container $container
        if ($container) {
            [System.IO.Directory]::SetAccessControl($Path, $acl)
        } else {
            [System.IO.File]::SetAccessControl($Path, $acl)
        }
    } catch [System.IO.IOException] {
        if ($TolerateInUse) { return }
        throw ('SECRET_STORE_ACL_UNSAFE: the credential store permissions could not be ' +
            'restricted because the file is in use.')
    } catch {
        throw 'SECRET_STORE_ACL_UNSAFE: the credential store permissions could not be restricted.'
    }

    # Applying an ACL and assuming it took is how the original defect reads in
    # source. Confirm against the filesystem.
    if (-not (Test-VaultPathProtected -Path $Path -Container $container)) {
        throw ('SECRET_STORE_ACL_UNSAFE: the credential store still grants access beyond ' +
            'this account, SYSTEM and Administrators after hardening.')
    }
}

# The entry point the vault scripts call wherever they used to call
# `New-Item -ItemType Directory -Force -Path $VaultDir`. Creating the directory
# and fencing it are the same act; separating them is what left a window.
function Initialize-ProtectedVaultStore {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ($env:TOOLSENABLED_VAULT_HOST_LIBRARY -eq '1') {
        Initialize-NativeVaultPermissions
        [ToolsEnabled.VaultPermissionsV1]::InitializeStore($Path)
        return
    }

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        # Directory.CreateDirectory's DirectorySecurity overload applies the
        # protected owner/SYSTEM/Administrators DACL as the directory is
        # created. There is no intermediate inheriting vault directory for a
        # permissive install root to expose.
        $initialAcl = New-VaultAcl -Container $true
        [System.IO.Directory]::CreateDirectory($Path, $initialAcl) | Out-Null
    }

    # Hard failure: without this, nothing created below is safe.
    Protect-VaultPath -Path $Path

    # Existing files predate the fix on an upgraded install and still carry the
    # inherited ACL, so they are corrected rather than left to the next write.
    foreach ($child in (Get-ChildItem -LiteralPath $Path -Force -File -ErrorAction SilentlyContinue)) {
        Protect-VaultPath -Path $child.FullName -TolerateInUse
    }
}

# .NET Framework's File.Replace API insists on a backup filename even though
# the native Windows replacement primitive does not. A backup is inappropriate
# for a secret store: after `remove`, it would retain a complete encrypted copy
# of the pre-removal vault. Keep both vault writers on this one atomic,
# write-through, no-backup replacement path.
#
# THE C# COMPILER RUNS WHEN A VAULT IS BEING REPLACED, AND AT NO OTHER TIME.
#
# `Add-Type -TypeDefinition` compiles source in-process, and it used to run
# HERE, at dot-source scope -- so it ran on every single spawn of
# tools/secrets.ps1 and tools/secrets-manager.ps1, whatever the verb.
#
# MEASURED 2026-09-03 on the owner's machine, this file's Add-Type in
# isolation: 208.5 / 213.8 / 252.7 ms. Against the same private scratch vault,
# one `powershell.exe -File tools/secrets.ps1 get <key>` was 851.8 ms median,
# and it breaks down as ~188 ms powershell.exe start, ~147 ms parse and
# parameter binding, ~240 ms dot-sourcing this file (of which the compile above
# is the great majority), and the rest DPAPI, the access log and file I/O.
#
# NO READ VERB CAN REACH THE TYPE. Move-VaultFileAtomically is called from one
# place, Write-Vault, and 'get', 'get-many', 'list', 'exists', 'present' and
# 'verify' never call Write-Vault and never take the vault lock. They were
# paying a quarter of a second to compile a write primitive they cannot invoke,
# on every read, on a path the bridge polls on a two-second timer.
#
# WHAT A WRITE PAYS. Same guard, same C#, same MoveFileEx with
# REPLACE_EXISTING | WRITE_THROUGH, same Win32Exception carrying
# GetLastWin32Error on failure, still installed at most once per process --
# at the first replacement instead of at dot-source. The `-as [type]` guard is
# what keeps it once-per-process now that the call site is a function body
# rather than file scope.
#
# AND THE COMPILE ITSELF NO LONGER RUNS ON EVERY WRITE. Every vault verb is a
# fresh powershell.exe, and Windows PowerShell keeps no cross-process compile
# cache, so "once per process" for a write meant "once per write": every
# `set-monotonic-stdin` -- the audit head-anchor advance that EVERY
# external-write tool call pays through audit.requireRecord -- spawned csc.exe
# to compile these 20 lines of static C# again, inside the vault lock.
#
# MEASURED 2026-09-03 on the owner's machine, tracing the phases of one
# `set-monotonic-stdin` against a private scratch vault (three runs): the
# Move-VaultFileAtomically step was 465 / 349 / 369 ms of a 1,575 / 1,548 /
# 1,615 ms script body, the single largest phase, and every other phase was
# real work (DPAPI, the ACL check, JSON, the flushed write). A loaded copy of
# the identical type costs 3 ms. Against the live tier's own action ledger the
# same day, host.read_file -- which does one fs read and one requireRecord --
# had a p50 of 1.4-1.8 s over 92 calls; this compile was a fixed quarter of
# that floor, paid again on every call, forever.
#
# Install-VaultAtomicFileType below is the same shape as
# tools/windows-job-wrapper.ps1's Install-WrapperType, which fixed the identical
# defect for host.exec: the compiled assembly is kept on disk, content-addressed
# by the SHA-256 of the C# source, and loaded with Add-Type -Path when present.
# Every step of the cache is best-effort. No cache directory, an unusable one,
# a corrupt or half-written entry, a lost seeding race: each reads as a miss and
# falls through to exactly the unconditional Add-Type -TypeDefinition that ran
# before, so a write can never be LESS reliable than it was without the cache.
# The cache is a pure cost change: what gets loaded is the same compiled code
# either way, just not re-derived from source on every call.
function Move-VaultFileAtomically {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        # Where the compiled type may be kept between processes. Omitted (the
        # direct callers in tests, or a writer that has no state root to name)
        # means compile in-process exactly as before.
        [Parameter(Mandatory = $false)][string]$AssemblyCacheDirectory
    )

    if ($null -eq ('ToolsEnabledVaultAtomicFile' -as [type])) {
        Install-VaultAtomicFileType -AssemblyCacheDirectory $AssemblyCacheDirectory
    }

    [ToolsEnabledVaultAtomicFile]::Replace($Source, $Destination)
}

function Install-VaultAtomicFileType {
    param([Parameter(Mandatory = $false)][string]$AssemblyCacheDirectory)

    $source = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class ToolsEnabledVaultAtomicFile
{
    private const int MoveFileReplaceExisting = 0x1;
    private const int MoveFileWriteThrough = 0x8;
    private const int SharingRetryMilliseconds = 1000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool MoveFileEx(string existingFileName,
                                           string newFileName,
                                           int flags);

    public static void Replace(string source, string destination)
    {
        // The vault lock excludes other writers, not short-lived ACL/read
        // handles opened before that lock. Windows can report access denied
        // (5), sharing violation (32), or lock violation (33) for those handles.
        // Retry only the already-flushed staged-file rename, never a vault
        // command, encryption, or audit event. Permanent denial stays denial.
        Stopwatch clock = Stopwatch.StartNew();
        while (true)
        {
            if (MoveFileEx(source, destination,
                           MoveFileReplaceExisting | MoveFileWriteThrough)) return;
            int error = Marshal.GetLastWin32Error();
            long remaining = SharingRetryMilliseconds - clock.ElapsedMilliseconds;
            if ((error != 5 && error != 32 && error != 33) || remaining <= 0)
                throw new Win32Exception(error);
            Thread.Sleep((int)Math.Min(20, remaining));
            if (clock.ElapsedMilliseconds >= SharingRetryMilliseconds)
                throw new Win32Exception(error);
        }
    }
}
'@

    if ([string]::IsNullOrWhiteSpace($AssemblyCacheDirectory)) {
        Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
        return
    }

    $cacheFile = $null
    try {
        $sha256 = [System.Security.Cryptography.SHA256]::Create()
        try { $hashBytes = $sha256.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($source)) }
        finally { $sha256.Dispose() }
        # The first 128 bits of the digest name the entry. csc.exe refuses an
        # output path past MAX_PATH ("File name ... is too long or invalid",
        # measured with the full 64-hex name under a deep scratch root), and a
        # refusal here is a silent miss on every write, so the name is kept
        # short enough to leave the state root its room.
        $hashHex = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant().Substring(0, 32)
        $null = New-Item -ItemType Directory -Force -Path $AssemblyCacheDirectory -ErrorAction Stop
        $cacheFile = Join-Path $AssemblyCacheDirectory ('atomic-' + $hashHex + '.dll')
    } catch {
        # No cache identity could be established (the directory could not be
        # created, or is a file). Compile exactly as if no directory were named.
        Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
        return
    }

    if (Test-Path -LiteralPath $cacheFile -PathType Leaf) {
        try {
            # Assembly.LoadFrom, not Add-Type -Path: measured in a fresh
            # process, 12-13 ms against 94-103 ms for the cmdlet loading the
            # same file, and the type resolves either way.
            $null = [System.Reflection.Assembly]::LoadFrom($cacheFile)
            if ($null -eq ('ToolsEnabledVaultAtomicFile' -as [type])) { throw 'The cached assembly does not carry the type.' }
            return
        } catch {
            # A present-but-unloadable entry (a partial write from a killed
            # process, a hand-edited file) is a miss, not a failure: fall
            # through to compile-and-seed.
        }
    }

    # The staged name MUST end in .dll: Add-Type -Path decides how to read a
    # file from its extension and refuses anything else, which is exactly how
    # the job wrapper's first cache attempt silently never seeded.
    $tempFile = Join-Path $AssemblyCacheDirectory ('atomic-' + $hashHex + '.' + $PID + '.' +
        [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.dll')
    try {
        # -OutputAssembly compiles and writes the DLL but does not load the type
        # into this session; the -Path load below is required either way.
        Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $tempFile -ErrorAction Stop
        $null = [System.Reflection.Assembly]::LoadFrom($tempFile)
        if ($null -eq ('ToolsEnabledVaultAtomicFile' -as [type])) { throw 'The staged assembly does not carry the type.' }
    } catch {
        try { if (Test-Path -LiteralPath $tempFile) { Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue } } catch {}
        Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
        return
    }
    try {
        # Content-addressed, so whichever concurrent writer lands first is
        # byte-for-byte interchangeable with this one.
        if (-not (Test-Path -LiteralPath $cacheFile)) {
            Move-Item -LiteralPath $tempFile -Destination $cacheFile -ErrorAction Stop
        }
    } catch {
        # The type is already loaded in THIS process from the staged copy, so
        # this write is unaffected; only the on-disk seed was skipped.
    } finally {
        try { if (Test-Path -LiteralPath $tempFile) { Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue } } catch {}
    }
}

# Writers before the no-backup replacement helper named their best-effort
# backup `.secrets.json.<pid>.<guid>.tmp.bak`. A terminated process or failed
# cleanup can leave that complete encrypted pre-mutation vault behind. These
# names are disjoint from the durable FRA/link-bus/special-session recovery
# artifacts, so clean only this exact legacy shape and fail the mutation if an
# orphan cannot be removed.
function Remove-LegacyVaultReplacementBackups {
    param([Parameter(Mandatory = $true)][string]$VaultPath)

    $directory = [System.IO.Path]::GetDirectoryName($VaultPath)
    $leaf = [System.IO.Path]::GetFileName($VaultPath)
    if ([string]::IsNullOrWhiteSpace($directory) -or -not (Test-Path -LiteralPath $directory)) { return }
    $pattern = '^\.' + [Regex]::Escape($leaf) + '\.[0-9]+\.[a-fA-F0-9]{32}\.tmp\.bak$'
    foreach ($candidate in (Get-ChildItem -LiteralPath $directory -Force -File -ErrorAction Stop)) {
        if ($candidate.Name -notmatch $pattern) { continue }
        if (($candidate.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'SECRET_STORE_ACL_UNSAFE: a legacy vault backup path is a reparse point.'
        }
        Remove-Item -LiteralPath $candidate.FullName -Force -ErrorAction Stop
    }
}
