param([switch]$Native)
$ErrorActionPreference = 'Stop'
$env:TOOLSENABLED_VAULT_HOST_LIBRARY = '1'
. $env:TOOLSENABLED_READER_SCRIPT -Action list
function Check($Condition, $Label) {
    if (-not $Condition) { throw $Label }
    [Console]::WriteLine("PASS $Label")
}
if ($Native) {
    [IO.File]::WriteAllText($VaultFile, '{"pin":"synthetic-ciphertext"}')
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public static class VaultReadLockFixture {
    public static Thread ReleaseLater(FileStream stream) {
        var thread = new Thread(() => { Thread.Sleep(300); stream.Dispose(); });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }
}
'@
    $holder = [IO.File]::Open($VaultFile, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $thread = [VaultReadLockFixture]::ReleaseLater($holder)
    try { $result = Read-Vault }
    finally {
        if (-not $thread.Join(5000)) { throw 'Lock fixture did not close.' }
        $holder.Dispose()
    }
    Check ($result.pin -ceq 'synthetic-ciphertext') 'native sharing denial recovers the complete pin'
    return
}
Check ((Read-Vault).Count -eq 0) 'confirmed missing file is empty'
$unicode = 'unicode-' + [char]0x03bb
[IO.File]::WriteAllText($VaultFile, ('{"alpha":"synthetic-ciphertext","beta":"' + $unicode + '"}'), [Text.UTF8Encoding]::new($false))
$records = Read-Vault
Check ($records.Count -eq 2 -and $records.alpha -ceq 'synthetic-ciphertext' -and $records.beta -ceq $unicode) 'complete UTF-8 generation is preserved'
foreach ($raw in @('', 'null', '[]', '{"alpha":7}', '{"alpha":')) {
    [IO.File]::WriteAllText($VaultFile, $raw)
    $refused = $false
    try { $null = Read-Vault } catch { $refused = $true }
    Check $refused 'invalid vault refuses without replacement'
    Check ([IO.File]::ReadAllText($VaultFile) -ceq $raw) 'invalid original bytes retained'
}
[IO.File]::WriteAllBytes($VaultFile, [byte[]](123,34,97,34,58,34,195,40,34,125))
$refused = $false
try { $null = Read-Vault } catch { $refused = $true }
Check $refused 'invalid UTF-8 refuses instead of altering ciphertext'
$validBom = [byte[]]([byte[]](239,187,191) + [Text.Encoding]::UTF8.GetBytes(('{' + '"alpha":"synthetic-ciphertext","beta":"' + $unicode + '"}')))
[IO.File]::WriteAllBytes($VaultFile, $validBom)
$records = Read-Vault
Check ($records.Count -eq 2 -and $records.alpha -ceq 'synthetic-ciphertext' -and $records.beta -ceq $unicode) 'valid UTF-8 BOM generation remains compatible'
Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($VaultFile)) -ceq [Convert]::ToBase64String($validBom)) 'valid BOM original bytes retained'
foreach ($badEncoding in @(
    [byte[]](239,187,191,123,34,97,34,58,34,195,40,34,125),
    [byte[]]([byte[]](255,254) + [Text.Encoding]::Unicode.GetBytes('{"alpha":"synthetic-ciphertext"}'))
)) {
    [IO.File]::WriteAllBytes($VaultFile, $badEncoding)
    $refused = $false
    try { $null = Read-Vault } catch { $refused = $true }
    Check $refused 'BOM cannot replace strict UTF-8 decoding'
    Check ([Convert]::ToBase64String([IO.File]::ReadAllBytes($VaultFile)) -ceq [Convert]::ToBase64String($badEncoding)) 'rejected encoding original bytes retained'
}
$script:VaultFile = $env:TOOLSENABLED_READER_ROOT
$refused = $false
try { $null = Read-Vault } catch { $refused = $true }
Check $refused 'a directory is unreadable rather than missing'

foreach ($code in @(32,33)) {
    $script:attempts = 0
    $value = Invoke-VaultRead {
        $script:attempts++
        if ($script:attempts -lt 3) { throw [IO.IOException]::new('synthetic sharing failure', (-2147024896 + $code)) }
        return 'complete-generation'
    }
    Check ($value -ceq 'complete-generation' -and $script:attempts -eq 3) 'transient sharing conflict recovers without an empty answer'
}
foreach ($failure in @([UnauthorizedAccessException]::new('synthetic denied'),
    [IO.IOException]::new('synthetic permanent I/O', -2147024891),
    [FormatException]::new('synthetic malformed'))) {
    $script:attempts = 0
    $refused = $false
    try { $null = Invoke-VaultRead { $script:attempts++; throw $failure } } catch { $refused = $true }
    Check ($refused -and $script:attempts -eq 1) 'permanent failure refuses without retry'
}
$script:attempts = 0
$clock = [Diagnostics.Stopwatch]::StartNew()
$refused = $false
try { $null = Invoke-VaultRead { $script:attempts++; throw [IO.IOException]::new('synthetic held lock', -2147024864) } }
catch { $refused = $true }
$clock.Stop()
Check ($refused -and $script:attempts -gt 1 -and $clock.ElapsedMilliseconds -ge 2000 -and $clock.ElapsedMilliseconds -lt 6000) 'persistent sharing conflict refuses within its bound'
Check ((Invoke-VaultRead { 'recovered' }) -ceq 'recovered') 'a prior failure is not latched'
