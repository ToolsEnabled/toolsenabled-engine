[CmdletBinding()]
param(
    [string]$RepoRoot
)

# Regression guard for the vault DACL hardening applied on 2026-08-11.
#
# WHAT WAS HARDENED: vault/ and its four children had an explicit
# <COMPUTERNAME>\CodexSandboxUsers ACE removed, leaving SYSTEM + Administrators + the
# owner, all FullControl, on a protected (non-inheriting) DACL. The Codex
# sandbox accounts can therefore no longer read, replace or delete the
# credential store.
#
# WHY THIS FILE EXISTS: nothing checked that it stays that way. tools/
# secret-doctor.js checks inventory and decryptability only, and every
# vault-hardening suite redirects TOOLSENABLED_VAULT_PATH at an mkdtemp
# directory -- which is exactly why none of them can see the live DACL. This
# probe deliberately reads the REAL vault in the checkout, with no redirect.
#
# ----------------------------------------------------------------------------
# THE REPO ROOT IS DIFFERENT ON PURPOSE. DO NOT "FIX" IT.
# ----------------------------------------------------------------------------
# tools/fra-root-access-control.ps1 DELIBERATELY grants CodexSandboxUsers
# Modify on the REPOSITORY ROOT with (OI)(CI), and tools/fra-root-access-
# probe.ps1 REQUIRES that ACE there with an exact rule count. Full Remote
# Access breaks if it is removed. A reflex "tighten everything" pass over this
# repo is therefore a regression, not an improvement.
#
# So this probe reports BOTH halves of that distinction as facts:
#   * vault/ and its children  -> the sandbox ACE MUST be absent
#   * the repository root      -> the sandbox ACE MUST be present
# A caller asserting only the first half would let someone satisfy it by
# tightening the root and taking FRA down. Assert both.
#
# No secret values are read or emitted. This probe reads ACLs only; it never
# opens vault file CONTENT. Security descriptors are reported as SHA-256
# digests rather than raw SDDL so principal SIDs never reach a test log.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sandboxGroupName = 'CodexSandboxUsers'

# vault/ itself plus every child that existed at hardening time. Children are
# enumerated live as well, so a file added to the vault next month is checked
# without anyone remembering to edit this list.
$vaultRelative = 'vault'

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Value)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Stop-Invalid {
    param([string]$Code = 'VAULT_ACCESS_INVALID')
    [pscustomobject]@{
        schemaVersion = 1
        valid = $false
        code = $Code
        secretValuesEmitted = $false
    } | ConvertTo-Json -Compress -Depth 6
    exit 1
}

function Get-AclFor {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][bool]$IsContainer)
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor `
        [Security.AccessControl.AccessControlSections]::Access
    if ($IsContainer) {
        return [IO.Directory]::GetAccessControl($Path, $sections)
    }
    return [IO.File]::GetAccessControl($Path, $sections)
}

try {
    if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
        $RepoRoot = Split-Path -Parent $PSScriptRoot
    }
    if (-not [IO.Path]::IsPathRooted($RepoRoot)) { Stop-Invalid 'VAULT_ACCESS_ROOT_INVALID' }
    $root = [IO.Path]::GetFullPath($RepoRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { Stop-Invalid 'VAULT_ACCESS_ROOT_MISSING' }

    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $systemSid = 'S-1-5-18'
    $administratorsSid = 'S-1-5-32-544'

    # The sandbox group is machine-local. On a machine that never provisioned
    # it there is nothing to fence against, and that is reported honestly
    # rather than being allowed to look like a pass.
    $sandboxSid = $null
    try {
        $sandboxSid = (New-Object Security.Principal.NTAccount($env:COMPUTERNAME, $sandboxGroupName)).Translate(
            [Security.Principal.SecurityIdentifier]
        ).Value
    }
    catch {
        $sandboxSid = $null
    }

    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor `
        [Security.AccessControl.AccessControlSections]::Access

    # --- half 1: the repository root MUST still carry the sandbox ACE (FRA) ---
    $rootAcl = Get-AclFor -Path $root -IsContainer $true
    $rootSandboxAceCount = 0
    if ($sandboxSid) {
        foreach ($rule in $rootAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
            if ($rule.IdentityReference.Value -eq $sandboxSid -and
                $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
                $rootSandboxAceCount++
            }
        }
    }

    # --- half 2: vault/ and every child MUST NOT carry the sandbox ACE -------
    $vaultPath = Join-Path $root $vaultRelative
    $vaultPresent = Test-Path -LiteralPath $vaultPath -PathType Container
    $entries = @()
    if ($vaultPresent) {
        $targets = @([pscustomobject]@{ Path = $vaultPath; Relative = $vaultRelative; Container = $true })
        foreach ($child in (Get-ChildItem -LiteralPath $vaultPath -Force -Recurse)) {
            $targets += [pscustomobject]@{
                Path = $child.FullName
                Relative = ($vaultRelative + '/' + $child.FullName.Substring($vaultPath.Length + 1).Replace('\', '/'))
                Container = $child.PSIsContainer
            }
        }
        foreach ($target in $targets) {
            $item = Get-Item -LiteralPath $target.Path -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Stop-Invalid 'VAULT_ACCESS_REPARSE_REFUSED'
            }
            $acl = Get-AclFor -Path $target.Path -IsContainer $target.Container
            $sandboxAceCount = 0
            $inheritedRuleCount = 0
            $unexpectedPrincipalCount = 0
            $nonFullControlCount = 0
            $expected = @($currentSid, $systemSid, $administratorsSid)
            $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
            foreach ($rule in $rules) {
                $sid = $rule.IdentityReference.Value
                if ($rule.IsInherited) { $inheritedRuleCount++ }
                if ($sandboxSid -and $sid -eq $sandboxSid) { $sandboxAceCount++ }
                if ($expected -notcontains $sid) { $unexpectedPrincipalCount++ }
                if ([int64]$rule.FileSystemRights -ne [int64][Security.AccessControl.FileSystemRights]::FullControl) {
                    $nonFullControlCount++
                }
            }
            $entries += [pscustomobject]@{
                relative = $target.Relative
                container = $target.Container
                protectedDacl = [bool]$acl.AreAccessRulesProtected
                ruleCount = $rules.Count
                sandboxAceCount = $sandboxAceCount
                inheritedRuleCount = $inheritedRuleCount
                unexpectedPrincipalCount = $unexpectedPrincipalCount
                nonFullControlCount = $nonFullControlCount
                descriptorDigest = (Get-Sha256Hex -Value $acl.GetSecurityDescriptorSddlForm($sections))
            }
        }
    }

    [pscustomobject]@{
        schemaVersion = 1
        valid = $true
        sandboxGroup = $sandboxGroupName
        sandboxGroupResolved = [bool]$sandboxSid
        vaultPresent = $vaultPresent
        vaultEntryCount = $entries.Count
        vaultEntries = $entries
        # FRA REQUIRES this to stay 1. See the header: do not tighten the root.
        rootSandboxAceCount = $rootSandboxAceCount
        rootProtectedDacl = [bool]$rootAcl.AreAccessRulesProtected
        secretValuesEmitted = $false
    } | ConvertTo-Json -Compress -Depth 6
}
catch {
    Stop-Invalid 'VAULT_ACCESS_INVALID'
}
