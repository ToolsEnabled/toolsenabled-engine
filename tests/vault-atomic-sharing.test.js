'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const { safeLaunchEnvironment } = require('../src/lib/supervision/launch-environment');

const ROOT = path.resolve(__dirname, '..');
const ACL_SCRIPT = path.join(ROOT, 'tools/lib/vault-acl.ps1');
const WINDOWS = process.platform === 'win32';
const PROBE = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. $env:TOOLSENABLED_ATOMIC_PROBE_SCRIPT
Install-VaultAtomicFileType
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public static class VaultAtomicSharingFixture {
    public static Thread ReleaseLater(FileStream stream, int milliseconds) {
        Thread worker = new Thread(() => { Thread.Sleep(milliseconds); stream.Dispose(); });
        worker.IsBackground = true;
        worker.Start();
        return worker;
    }
}
'@

function New-ProbeFiles([string]$Label) {
    $directory = Join-Path $env:TOOLSENABLED_ATOMIC_PROBE_ROOT $Label
    $null = [IO.Directory]::CreateDirectory($directory)
    $source = Join-Path $directory 'staged.tmp'
    $destination = Join-Path $directory 'canonical.json'
    [IO.File]::WriteAllText($source, 'new-fixture-generation')
    [IO.File]::WriteAllText($destination, 'old-fixture-generation')
    return @{ directory = $directory; source = $source; destination = $destination }
}

function Read-AccessDescriptor([string]$Path) {
    return [IO.File]::GetAccessControl($Path).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
}

function Invoke-ReplaceProbe($Files) {
    $clock = [Diagnostics.Stopwatch]::StartNew()
    try {
        Move-VaultFileAtomically -Source $Files.source -Destination $Files.destination
        return @{ ok = $true; code = 0; elapsedMs = $clock.ElapsedMilliseconds }
    } catch {
        $failure = $_.Exception
        while ($null -ne $failure -and -not ($failure -is [ComponentModel.Win32Exception])) {
            $failure = $failure.InnerException
        }
        $code = if ($null -eq $failure) { -1 } else { $failure.NativeErrorCode }
        return @{ ok = $false; code = $code; elapsedMs = $clock.ElapsedMilliseconds }
    } finally { $clock.Stop() }
}

$answer = [ordered]@{}
$files = New-ProbeFiles 'released-reader'
$aclBefore = Read-AccessDescriptor $files.destination
$reader = [IO.File]::Open($files.destination, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
$releaser = [VaultAtomicSharingFixture]::ReleaseLater($reader, 250)
try {
    $result = Invoke-ReplaceProbe $files
} finally {
    if (-not $releaser.Join(5000)) { throw 'Fixture reader did not settle within its bound.' }
    $reader.Dispose()
}
$result.newGeneration = [IO.File]::ReadAllText($files.destination) -eq 'new-fixture-generation'
$result.stagedGone = -not [IO.File]::Exists($files.source)
$result.aclUnchanged = (Read-AccessDescriptor $files.destination) -eq $aclBefore
$result.noBackup = @([IO.Directory]::GetFiles($files.directory, '*.bak')).Count -eq 0
$answer.releasedReader = $result

$files = New-ProbeFiles 'persistent-reader'
$aclBefore = Read-AccessDescriptor $files.destination
$reader = [IO.File]::Open($files.destination, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
try { $result = Invoke-ReplaceProbe $files } finally { $reader.Dispose() }
$result.oldGeneration = [IO.File]::ReadAllText($files.destination) -eq 'old-fixture-generation'
$result.stagedIntact = [IO.File]::ReadAllText($files.source) -eq 'new-fixture-generation'
$result.aclUnchanged = (Read-AccessDescriptor $files.destination) -eq $aclBefore
$result.recoveredAfterRelease = (Invoke-ReplaceProbe $files).ok
$answer.persistentReader = $result

$files = New-ProbeFiles 'delete-shared-reader'
$reader = [IO.File]::Open($files.destination, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
try {
    $result = Invoke-ReplaceProbe $files
    $textReader = [IO.StreamReader]::new($reader)
    try { $result.oldReaderGeneration = $textReader.ReadToEnd() -eq 'old-fixture-generation' }
    finally { $textReader.Dispose() }
    $result.newReaderGeneration = [IO.File]::ReadAllText($files.destination) -eq 'new-fixture-generation'
    $result.canonicalOldGeneration = [IO.File]::ReadAllText($files.destination) -eq 'old-fixture-generation'
    $result.stagedGone = -not [IO.File]::Exists($files.source)
} finally { $reader.Dispose() }
if (-not $result.ok) { $result.recoveredAfterRelease = (Invoke-ReplaceProbe $files).ok }
$result.finalNewGeneration = [IO.File]::ReadAllText($files.destination) -eq 'new-fixture-generation'
$result.finalStagedGone = -not [IO.File]::Exists($files.source)
$answer.sharedReader = $result

$files = New-ProbeFiles 'missing-source'
[IO.File]::Delete($files.source)
$result = Invoke-ReplaceProbe $files
$result.oldGeneration = [IO.File]::ReadAllText($files.destination) -eq 'old-fixture-generation'
$answer.missingSource = $result

$files = New-ProbeFiles 'readonly-destination'
$aclBefore = Read-AccessDescriptor $files.destination
[IO.File]::SetAttributes($files.destination, [IO.FileAttributes]::ReadOnly)
try {
    $result = Invoke-ReplaceProbe $files
    $result.readonlyUnchanged = ([IO.File]::GetAttributes($files.destination) -band [IO.FileAttributes]::ReadOnly) -ne 0
} finally { [IO.File]::SetAttributes($files.destination, [IO.FileAttributes]::Normal) }
$result.oldGeneration = [IO.File]::ReadAllText($files.destination) -eq 'old-fixture-generation'
$result.stagedIntact = [IO.File]::ReadAllText($files.source) -eq 'new-fixture-generation'
$result.aclUnchanged = (Read-AccessDescriptor $files.destination) -eq $aclBefore
$answer.readonlyDestination = $result

# Only booleans, native error codes and durations leave the fixture. It never
# invokes a vault verb or loads/decrypts real credential state.
[Console]::Out.Write(($answer | ConvertTo-Json -Depth 5 -Compress))
`;

let measured;
test.before(() => {
  if (!WINDOWS) return;
  const scratch = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'vault-atomic-sharing-'));
  const environment = safeLaunchEnvironment(process.env);
  environment.TOOLSENABLED_ATOMIC_PROBE_ROOT = scratch;
  environment.TOOLSENABLED_ATOMIC_PROBE_SCRIPT = ACL_SCRIPT;
  let confirmedNormalExit = false;
  try {
    const result = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      Buffer.from(PROBE, 'utf16le').toString('base64')
    ], { cwd: ROOT, env: environment, encoding: 'utf8', windowsHide: true,
      timeout: 20000, maxBuffer: 16384, stdio: ['ignore', 'pipe', 'pipe'] });
    confirmedNormalExit = !result.error && !result.signal && result.status === 0;
    assert.equal(result.error, undefined, 'the bounded native fixture must launch and settle');
    assert.equal(result.status, 0, `native fixture failed: ${result.stderr}`);
    assert.equal(result.stderr, '', 'native diagnostics must not leak fixture contents');
    measured = JSON.parse(result.stdout);
  } finally {
    if (confirmedNormalExit) {
      const relative = path.relative(path.resolve(isolatedTemporaryRoot()), path.resolve(scratch));
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      fs.rmSync(scratch, { recursive: true, force: true });
    } else {
      process.stderr.write(`Native atomic-rename probe did not confirm normal exit; retained owned fixture for cleanup review: ${scratch}\n`);
    }
  }
});

test('a briefly held native no-DELETE reader does not lose an atomic vault replacement', { skip: !WINDOWS }, t => {
  t.diagnostic(`Native replacement measurements: ${JSON.stringify(measured)}`);
  const result = measured.releasedReader;
  assert.equal(result.ok, true, `replacement refused instead of surviving the held reader: ${JSON.stringify(result)}`);
  assert.equal(result.code, 0);
  assert.equal(result.newGeneration, true);
  assert.equal(result.stagedGone, true);
  assert.equal(result.noBackup, true);
  assert.equal(result.aclUnchanged, true);
  assert.ok(result.elapsedMs < 2500, 'transient rename recovery must stay bounded');
});

test('a persistent native sharing denial fails boundedly without changing either generation or ACL', { skip: !WINDOWS }, () => {
  const result = measured.persistentReader;
  assert.equal(result.ok, false);
  assert.ok([5, 32, 33].includes(result.code), `the actual sharing-related Win32 error must survive: ${result.code}`);
  assert.ok(result.elapsedMs < 2500, 'the primitive cannot retry a held reader indefinitely');
  assert.equal(result.oldGeneration, true);
  assert.equal(result.stagedIntact, true);
  assert.equal(result.aclUnchanged, true);
  assert.equal(result.recoveredAfterRelease, true);
});

test('a DELETE-sharing reader never sees a partial generation and release permits replacement', { skip: !WINDOWS }, () => {
  const result = measured.sharedReader;
  assert.equal(result.oldReaderGeneration, true, 'the retained reader must see the complete old document');
  if (result.ok) {
    assert.equal(result.newReaderGeneration, true);
    assert.equal(result.stagedGone, true);
  } else {
    // Some Windows filesystems still refuse replacement of the open target,
    // even with DELETE sharing. That is not permission to delete first or
    // weaken the atomic primitive. Its refusal must leave both files intact.
    assert.ok([5, 32, 33].includes(result.code));
    assert.ok(result.elapsedMs < 2500);
    assert.equal(result.canonicalOldGeneration, true);
    assert.equal(result.stagedGone, false);
    assert.equal(result.recoveredAfterRelease, true);
  }
  assert.equal(result.finalNewGeneration, true);
  assert.equal(result.finalStagedGone, true);
});

test('permanent native errors retain their codes and do not delete or weaken the destination', { skip: !WINDOWS }, () => {
  assert.equal(measured.missingSource.ok, false);
  assert.equal(measured.missingSource.code, 2);
  assert.ok(measured.missingSource.elapsedMs < 500, 'missing-source errors are not transient sharing and must not consume the retry window');
  assert.equal(measured.missingSource.oldGeneration, true);
  const denied = measured.readonlyDestination;
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 5);
  assert.ok(denied.elapsedMs < 2500);
  assert.equal(denied.oldGeneration, true);
  assert.equal(denied.stagedIntact, true);
  assert.equal(denied.readonlyUnchanged, true);
  assert.equal(denied.aclUnchanged, true);
});
