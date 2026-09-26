[CmdletBinding()]
param(
    [ValidateSet('Status', 'Harden')]
    [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$Probe = Join-Path $PSScriptRoot 'fra-root-access-probe.ps1'
$StateDir = Join-Path $Root 'state'
$PreimageFile = Join-Path $StateDir 'fra-root-access-preimage.json'
$MutexName = 'Global\ToolsEnabledFraRootAccessControl'

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][string]$Value)
    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function Invoke-RootProbe {
    $prior = [Environment]::GetEnvironmentVariable('TOOLSENABLED_FRA_ROOT_ACCESS_TARGET', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('TOOLSENABLED_FRA_ROOT_ACCESS_TARGET', $Root, 'Process')
        $output = & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
            -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Probe 2>$null
        $exitCode = $LASTEXITCODE
        if ([string]::IsNullOrWhiteSpace([string]$output)) {
            return [pscustomobject]@{ valid = $false; code = 'FRA_ROOT_ACCESS_PROBE_UNAVAILABLE' }
        }
        $parsed = ([string]$output) | ConvertFrom-Json
        if ($exitCode -eq 0 -and $parsed.valid -eq $true) { return $parsed }
        return [pscustomobject]@{
            valid = $false
            code = if ([string]$parsed.code -match '^FRA_ROOT_ACCESS_[A-Z_]+$') { [string]$parsed.code } else { 'FRA_ROOT_ACCESS_INVALID' }
        }
    }
    catch {
        return [pscustomobject]@{ valid = $false; code = 'FRA_ROOT_ACCESS_PROBE_UNAVAILABLE' }
    }
    finally {
        [Environment]::SetEnvironmentVariable('TOOLSENABLED_FRA_ROOT_ACCESS_TARGET', $prior, 'Process')
    }
}

function Set-PrivateFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetOwner($current)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($current, $system)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    [IO.File]::SetAccessControl($Path, $acl)
}

function Write-Preimage {
    param(
        [Parameter(Mandatory = $true)][string]$Sddl,
        [Parameter(Mandatory = $true)][string]$Digest
    )
    if (Test-Path -LiteralPath $PreimageFile) { throw 'FRA_ROOT_ACCESS_PREIMAGE_EXISTS' }
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
    $temporary = $PreimageFile + '.' + $PID + '.tmp'
    try {
        $stream = New-Object IO.FileStream(
            $temporary,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
        $stream.Dispose()
        Set-PrivateFileAcl -Path $temporary
        [ordered]@{
            schemaVersion = 'fra-root-access-preimage.v1'
            capturedAt = (Get-Date).ToUniversalTime().ToString('o')
            descriptorSddl = $Sddl
            descriptorDigest = $Digest
            secretValuesEmitted = $false
        } | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8 -NoNewline
        Move-Item -LiteralPath $temporary -Destination $PreimageFile -ErrorAction Stop
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function New-HardenedAcl {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $administrators = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $codex = $null
    try {
        $codex = (New-Object Security.Principal.NTAccount($env:COMPUTERNAME, 'CodexSandboxUsers')).Translate(
            [Security.Principal.SecurityIdentifier]
        )
    }
    catch { $codex = $null }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($current)
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    foreach ($entry in @(
        [pscustomobject]@{ Sid = $current; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
        [pscustomobject]@{ Sid = $system; Rights = [Security.AccessControl.FileSystemRights]::FullControl },
        [pscustomobject]@{ Sid = $administrators; Rights = [Security.AccessControl.FileSystemRights]::FullControl }
    )) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $entry.Sid,
            $entry.Rights,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    if ($codex) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $codex,
            [Security.AccessControl.FileSystemRights]::Modify,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        [void]$acl.AddAccessRule($rule)
    }
    return $acl
}

function Write-Result {
    param([bool]$Ok, [string]$Outcome, [string]$Code, $ProbeResult)
    [ordered]@{
        schemaVersion = 'fra-root-access-control.v1'
        ok = $Ok
        action = $Action
        outcome = $Outcome
        code = $Code
        valid = [bool]($ProbeResult -and $ProbeResult.valid -eq $true)
        policyDigest = if ($ProbeResult -and $ProbeResult.valid -eq $true) { [string]$ProbeResult.policyDigest } else { $null }
        descriptorDigest = if ($ProbeResult -and $ProbeResult.valid -eq $true) { [string]$ProbeResult.descriptorDigest } else { $null }
        preimageRecorded = Test-Path -LiteralPath $PreimageFile -PathType Leaf
        secretValuesEmitted = $false
    } | ConvertTo-Json -Compress
}

$mutex = New-Object Threading.Mutex($false, $MutexName)
$held = $false
try {
    $held = $mutex.WaitOne(15000)
    if (-not $held) { throw 'FRA_ROOT_ACCESS_CONTROL_BUSY' }
    $before = Invoke-RootProbe
    if ($Action -eq 'Status') {
        if ($before.valid -eq $true) {
            Write-Result -Ok $true -Outcome 'already_hardened' -Code $null -ProbeResult $before
            exit 0
        }
        Write-Result -Ok $false -Outcome 'not_hardened' -Code ([string]$before.code) -ProbeResult $before
        exit 1
    }
    if ($before.valid -eq $true) {
        Write-Result -Ok $true -Outcome 'already_hardened' -Code $null -ProbeResult $before
        exit 0
    }
    if (-not (Test-Path -LiteralPath $Probe -PathType Leaf)) { throw 'FRA_ROOT_ACCESS_PROBE_MISSING' }
    $item = Get-Item -LiteralPath $Root -Force
    if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
        throw 'FRA_ROOT_ACCESS_REPARSE_REFUSED'
    }
    $sections = [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access
    $original = [IO.Directory]::GetAccessControl($Root, $sections)
    $preimageSddl = $original.GetSecurityDescriptorSddlForm($sections)
    $preimageDigest = Get-Sha256Hex -Value ('ToolsEnabled/FRA/root-acl-preimage/v1' + [char]0 + $preimageSddl)
    Write-Preimage -Sddl $preimageSddl -Digest $preimageDigest
    try {
        [IO.Directory]::SetAccessControl($Root, (New-HardenedAcl))
        $after = Invoke-RootProbe
        if ($after.valid -ne $true) {
            $postCode = [string]$after.code
            if ($postCode -match '^FRA_ROOT_ACCESS_[A-Z_]+$') { throw $postCode }
            throw 'FRA_ROOT_ACCESS_POSTCONDITION_FAILED'
        }
        Write-Result -Ok $true -Outcome 'hardened' -Code $null -ProbeResult $after
        exit 0
    }
    catch {
        try { [IO.Directory]::SetAccessControl($Root, $original) } catch {}
        throw
    }
}
catch {
    $candidate = [string]$_.Exception.Message
    $code = if ($candidate -match '^FRA_ROOT_ACCESS_[A-Z_]+$') { $candidate } else { 'FRA_ROOT_ACCESS_CONTROL_FAILED' }
    Write-Result -Ok $false -Outcome 'failed' -Code $code -ProbeResult $null
    exit 1
}
finally {
    if ($held) { try { $mutex.ReleaseMutex() } catch {} }
    $mutex.Dispose()
}
