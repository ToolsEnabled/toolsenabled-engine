[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$policyJson = '{"schemaVersion":1,"protectedDacl":true,"reparseRoot":false,"owner":["CURRENT_USER","BUILTIN_ADMINISTRATORS"],"rules":[{"principal":"CURRENT_USER","rights":"FullControl","inheritance":"ContainerAndObject"},{"principal":"LOCAL_SYSTEM","rights":"FullControl","inheritance":"ContainerAndObject"},{"principal":"BUILTIN_ADMINISTRATORS","rights":"FullControl","inheritance":"ContainerAndObject"},{"principal":"CODEX_SANDBOX_USERS_IF_PRESENT","rights":"Modify","inheritance":"ContainerAndObject"}],"inheritedRules":"refused","unknownPrincipals":"refused"}'

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
        if ($Bytes) { [Array]::Clear($Bytes, 0, $Bytes.Length) }
    }
}

function Get-DomainDigest {
    param(
        [Parameter(Mandatory = $true)][string]$Domain,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $bytes = [Text.Encoding]::UTF8.GetBytes($Domain + [char]0 + $Value)
    return Get-Sha256Hex -Bytes $bytes
}

function Stop-Invalid {
    param([string]$Code = 'FRA_ROOT_ACCESS_INVALID')
    [pscustomobject]@{
        schemaVersion = 1
        valid = $false
        code = $Code
        secretValuesEmitted = $false
    } | ConvertTo-Json -Compress
    exit 1
}

try {
    $target = [Environment]::GetEnvironmentVariable('TOOLSENABLED_FRA_ROOT_ACCESS_TARGET', 'Process')
    if ([string]::IsNullOrWhiteSpace($target) -or -not [IO.Path]::IsPathRooted($target)) {
        Stop-Invalid 'FRA_ROOT_ACCESS_TARGET_INVALID'
    }
    $full = [IO.Path]::GetFullPath($target).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $item = Get-Item -LiteralPath $full -Force
    if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        Stop-Invalid 'FRA_ROOT_ACCESS_REPARSE_REFUSED'
    }

    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $systemSid = 'S-1-5-18'
    $administratorsSid = 'S-1-5-32-544'
    $codexSid = $null
    try {
        $codexSid = (New-Object Security.Principal.NTAccount($env:COMPUTERNAME, 'CodexSandboxUsers')).Translate(
            [Security.Principal.SecurityIdentifier]
        ).Value
    }
    catch {
        $codexSid = $null
    }

    $acl = [IO.Directory]::GetAccessControl(
        $full,
        [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
    )
    if (-not $acl.AreAccessRulesProtected) {
        Stop-Invalid 'FRA_ROOT_ACCESS_DACL_INHERITED'
    }
    $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -cne $currentSid -and $ownerSid -cne $administratorsSid) {
        Stop-Invalid 'FRA_ROOT_ACCESS_OWNER_INVALID'
    }

    $expected = @{
        $currentSid = [int64][Security.AccessControl.FileSystemRights]::FullControl
        $systemSid = [int64][Security.AccessControl.FileSystemRights]::FullControl
        $administratorsSid = [int64][Security.AccessControl.FileSystemRights]::FullControl
    }
    if ($codexSid) {
        # FileSystemAccessRule canonicalizes directory Modify by adding the
        # Synchronize bit. Compare the resulting access mask, not the shorter
        # enum label supplied to the constructor.
        $expected[$codexSid] = [int64](
            [Security.AccessControl.FileSystemRights]::Modify -bor
            [Security.AccessControl.FileSystemRights]::Synchronize
        )
    }
    $rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne $expected.Count) {
        Stop-Invalid 'FRA_ROOT_ACCESS_RULE_COUNT_INVALID'
    }
    $seen = @{}
    $requiredInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        if ($rule.IsInherited) { Stop-Invalid 'FRA_ROOT_ACCESS_RULE_INHERITED' }
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            Stop-Invalid 'FRA_ROOT_ACCESS_RULE_TYPE_INVALID'
        }
        if (-not $expected.ContainsKey($sid)) { Stop-Invalid 'FRA_ROOT_ACCESS_PRINCIPAL_INVALID' }
        if ($seen.ContainsKey($sid)) { Stop-Invalid 'FRA_ROOT_ACCESS_RULE_DUPLICATE' }
        if ($rule.InheritanceFlags -ne $requiredInheritance -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
            Stop-Invalid 'FRA_ROOT_ACCESS_INHERITANCE_INVALID'
        }
        if ([int64]$rule.FileSystemRights -ne [int64]$expected[$sid]) {
            Stop-Invalid 'FRA_ROOT_ACCESS_RIGHTS_INVALID'
        }
        $seen[$sid] = $true
    }
    foreach ($sid in $expected.Keys) {
        if (-not $seen.ContainsKey($sid)) {
            Stop-Invalid 'FRA_ROOT_ACCESS_PRINCIPAL_MISSING'
        }
    }

    $policyDigest = Get-DomainDigest -Domain 'ToolsEnabled/FRA/root-access-policy/v1' -Value $policyJson
    $sddl = $acl.GetSecurityDescriptorSddlForm(
        [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
    )
    $descriptorDigest = Get-DomainDigest -Domain 'ToolsEnabled/FRA/root-acl/v1' -Value $sddl
    [pscustomobject]@{
        schemaVersion = 1
        valid = $true
        policyDigest = $policyDigest
        descriptorDigest = $descriptorDigest
        secretValuesEmitted = $false
    } | ConvertTo-Json -Compress
}
catch {
    Stop-Invalid 'FRA_ROOT_ACCESS_INVALID'
}
