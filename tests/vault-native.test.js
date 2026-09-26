'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('native Windows vault preserves DPAPI format and rechecks changed DACLs and reparse points',
  { skip: process.platform !== 'win32' }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-native-'));
    const literal = value => "'" + value.replaceAll("'", "''") + "'";
    const helper = path.resolve(__dirname, '../tools/lib/vault-acl.ps1');
    const script = `
$ErrorActionPreference = 'Stop'
$env:TOOLSENABLED_VAULT_HOST_LIBRARY = '1'
. ${literal(helper)}
Initialize-NativeVaultPermissions
function Assert-Equal($a, $b, $label) {
  if (-not [String]::Equals([string]$a, [string]$b, [StringComparison]::Ordinal)) { throw $label }
}
function Read-OldCipher($cipher) {
  $secure = ConvertTo-SecureString -String $cipher
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
}
$values = @('synthetic-ascii', ('synthetic' + [char]0 + [char]0x03bb + [char]0xd83d + [char]0xde80 + [char]0xd800 + [char]10))
foreach ($value in $values) {
  $secure = ConvertTo-SecureString -String $value -AsPlainText -Force
  try { $old = ConvertFrom-SecureString -SecureString $secure } finally { $secure.Dispose() }
  Assert-Equal ([ToolsEnabled.VaultDataProtectionV1]::Unprotect($old)) $value 'Old-to-native DPAPI mismatch'
  $native = [ToolsEnabled.VaultDataProtectionV1]::Protect($value)
  Assert-Equal (Read-OldCipher $native) $value 'Native-to-old DPAPI mismatch'
  foreach ($bad in @('x', 'zz', ($native.Substring(0, $native.Length - 2) + $(if ($native.EndsWith('00')) { '01' } else { '00' })))) {
    $refused = $false
    try { [void][ToolsEnabled.VaultDataProtectionV1]::Unprotect($bad) } catch { $refused = $true }
    if (-not $refused) { throw 'Malformed or tampered DPAPI accepted' }
  }
}
$root = ${literal(root)}
$store = Join-Path $root 'store'
Initialize-ProtectedVaultStore $store
$file = Join-Path $store 'synthetic.json'
[IO.File]::WriteAllText($file, '{}')
Initialize-ProtectedVaultStore $store
foreach ($entry in @($store, $file)) {
  $acl = Get-Acl -LiteralPath $entry
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $expected = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
  if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 3) { throw 'DACL was not protected with exactly three rules' }
  foreach ($rule in $rules) {
    if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or [long]$rule.FileSystemRights -ne 2032127 -or $expected -notcontains $rule.IdentityReference.Value) { throw 'DACL grants differed' }
  }
}
$acl = Get-Acl -LiteralPath $file
$sid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'Read', 'Allow')))
[IO.File]::SetAccessControl($file, $acl)
if ([ToolsEnabled.VaultPermissionsV1]::IsProtected($file, $false)) { throw 'A cached verdict accepted a changed DACL' }
Initialize-ProtectedVaultStore $store
$rules = @((Get-Acl -LiteralPath $file).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (@($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-32-545' }).Count -ne 0) { throw 'Changed DACL was not repaired' }
$target = Join-Path $root 'target'
[void][IO.Directory]::CreateDirectory($target)
$junction = Join-Path $root 'junction'
New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
foreach ($tolerate in @($false, $true)) {
  $refused = $false
  try { [ToolsEnabled.VaultPermissionsV1]::ProtectPath($junction, $tolerate) } catch { $refused = $_.Exception.Message.Contains('SECRET_STORE_ACL_UNSAFE') }
  if (-not $refused) { throw 'A real reparse point was accepted' }
}
Write-Output 'PASS native DPAPI interoperability, tamper refusal, current DACL inspection and reparse refusal'
`;
    try {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, encoding: 'utf8', timeout: 60000 });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /PASS native DPAPI/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
