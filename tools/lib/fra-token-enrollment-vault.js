'use strict';

// Durable local half of the FRA token enrollment transaction. Candidate,
// backup, and recovery files are complete DPAPI-encrypted vault files. Durable
// state contains only paths, phases, presence bits, and SHA-256 fingerprints.
// Secret values cross the PowerShell boundary only over a random private pipe.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  AUTH_VAULT_KEY,
  TARGET_VAULT_KEY,
  FraTokenEnrollmentError,
  tokenFingerprint,
  validateFingerprint,
  validateKeyBinding,
  validateToken,
  zero
} = require('./fra-token-enrollment');
/* From the shared hidden-process module, not the special-session receiver it
 * was born in: the receiver is a one-shot migration CLI, and durable vault
 * tooling importing a dated one-shot to reach one utility was the wrong
 * direction for that edge. Same function, same guarantees (forced
 * windowsHide/shell:false, stdin-only secrets, bounded output, zeroed on
 * failure). */
const { runHiddenProcess } = require('./hidden-process');

const STATE_SCHEMA = 'tools-enabled.fra-token-enrollment.state.v2';
const LEGACY_STATE_SCHEMA = 'tools-enabled.fra-token-enrollment.state.v1';
const PIPE_SCHEMA = 'tools-enabled.fra-token-enrollment.vault-pipe.v1';
const ROLES = Object.freeze(['a', 'b']);
const PHASES = Object.freeze([
  'preparing',
  'prepared',
  'committing',
  'committed',
  'rolling_back',
  'rolled_back',
  'prepare_failed'
]);
const FINALIZATION_STATES = Object.freeze(['none', 'prepared', 'mutual']);
const MAX_STATE_BYTES = 64 * 1024;
const MAX_PIPE_FRAME_BYTES = 96 * 1024;
const MIN_PIPE_NAME_BYTES = 16;
const MAX_PIPE_NAME_BYTES = 160;
const PIPE_AUTHENTICATOR_BYTES = 32;
const MAX_PIPE_AUTH_ATTEMPTS = 16;
const PIPE_AUTH_TIMEOUT_MS = 2000;
const HELPER_TIMEOUT_MS = 60 * 1000;
const MAX_CHILD_OUTPUT_BYTES = 1024;
const PIPE_CONNECT_RETRY_MS = 25;
const TRANSACTION_LOCK_WAIT_MS = 30 * 1000;
const TRANSACTION_LOCK_START_TIMEOUT_MS = TRANSACTION_LOCK_WAIT_MS + 5 * 1000;
const TRANSACTION_LOCK_RELEASE_TIMEOUT_MS = 5 * 1000;
const TRANSACTION_LOCK_READY = 0xa5;
const TRANSACTION_LOCK_ACK = 0x69;
const TRANSACTION_LOCK_ACKED = 0x96;
const TRANSACTION_LOCK_RELEASE = 0x5a;
const TRANSACTION_LOCK_DONE = 0xc3;
const TRANSACTION_LOCK_BUSY = 0xb0;
const TRANSACTION_LOCK_INVALID = 0xd1;
const TRANSACTION_LOCK_OWNER_NONCE_BYTES = 32;
const TRANSACTION_LOCK_BOOTSTRAP_BYTES = 4 + TRANSACTION_LOCK_OWNER_NONCE_BYTES;
const TRANSACTION_OWNER_FENCE_SCHEMA = 'tools-enabled.fra-token-enrollment.owner-fence.v1';

const ACL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$target=[IO.Path]::GetFullPath($args[0])',
  '$item=Get-Item -LiteralPath $target -Force',
  'if($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "ACL target is not a regular file"}',
  '$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User',
  "$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')",
  '$none=[Security.AccessControl.InheritanceFlags]::None',
  '$noProp=[Security.AccessControl.PropagationFlags]::None',
  '$allow=[Security.AccessControl.AccessControlType]::Allow',
  '$rights=[Security.AccessControl.FileSystemRights]::FullControl',
  '$current=[IO.File]::GetAccessControl($target,([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner))',
  '$rules=@($current.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))',
  '$seen=@{}',
  '$currentOwner=$current.GetOwner([Security.Principal.SecurityIdentifier])',
  '$exact=$current.AreAccessRulesProtected -and $currentOwner.Value -ceq $owner.Value -and $rules.Count -eq 2',
  'foreach($rule in $rules){$identity=$rule.IdentityReference.Value;if($rule.IsInherited -or $rule.AccessControlType -ne $allow -or [int64]$rule.FileSystemRights -ne [int64]$rights -or ($identity -cne $owner.Value -and $identity -cne $system.Value)){$exact=$false}else{$seen[$identity]=$true}}',
  'if($exact -and $seen.ContainsKey($owner.Value) -and $seen.ContainsKey($system.Value)){return}',
  'if($currentOwner.Value -cne $owner.Value){throw "ACL target owner does not match current user"}',
  '$acl=New-Object Security.AccessControl.FileSecurity',
  '$acl.SetAccessRuleProtection($true,$false)',
  '$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($owner,$rights,$none,$noProp,$allow)))',
  '$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system,$rights,$none,$noProp,$allow)))',
  '[IO.File]::SetAccessControl($target,$acl)',
  '$updated=[IO.File]::GetAccessControl($target,([Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner))',
  '$updatedRules=@($updated.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))',
  '$updatedSeen=@{}',
  '$updatedExact=$updated.AreAccessRulesProtected -and $updated.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $owner.Value -and $updatedRules.Count -eq 2',
  'foreach($rule in $updatedRules){$identity=$rule.IdentityReference.Value;if($rule.IsInherited -or $rule.AccessControlType -ne $allow -or [int64]$rule.FileSystemRights -ne [int64]$rights -or ($identity -cne $owner.Value -and $identity -cne $system.Value)){$updatedExact=$false}else{$updatedSeen[$identity]=$true}}',
  'if(-not $updatedExact -or -not $updatedSeen.ContainsKey($owner.Value) -or -not $updatedSeen.ContainsKey($system.Value)){throw "ACL target permissions did not converge"}'
].join('\n');

const REPLACE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'function Get-FileGeneration([string]$path){',
  '  $inputStream=[IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::Read -bor [IO.FileShare]::Delete))',
  '  try {',
  '    $hasher=[Security.Cryptography.SHA256]::Create()',
  '    try{$hashBytes=$hasher.ComputeHash($inputStream)}finally{$hasher.Dispose()}',
  '    try{return ([Convert]::ToBase64String($hashBytes)).TrimEnd("=").Replace("+","-").Replace("/","_")}finally{[Array]::Clear($hashBytes,0,$hashBytes.Length)}',
  '  } finally {$inputStream.Dispose()}',
  '}',
  '$source=[IO.Path]::GetFullPath($args[0])',
  '$destination=[IO.Path]::GetFullPath($args[1])',
  '$backup=[IO.Path]::GetFullPath($args[2])',
  '$expectedDestination=[string]$args[3]',
  '$expectedSource=[string]$args[4]',
  '$directory=[IO.Path]::GetDirectoryName($destination)',
  '$comparison=[StringComparison]::OrdinalIgnoreCase',
  'foreach($candidate in @($source,$backup)){if(-not [String]::Equals([IO.Path]::GetDirectoryName($candidate),$directory,$comparison)){throw "enrollment path escaped the vault directory"}}',
  '$directoryItem=Get-Item -LiteralPath $directory -Force',
  'if(-not $directoryItem.PSIsContainer -or (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "vault directory is not regular"}',
  '$lockPath=$destination + ".lock"',
  '$deadline=[DateTime]::UtcNow.AddSeconds(30)',
  '$lock=$null',
  '$stream=$null',
  'try {',
  '  while($null -eq $lock){',
  '    try{$lock=New-Object IO.FileStream($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}',
  '    catch [IO.IOException]{if([DateTime]::UtcNow -ge $deadline){throw "vault lock timeout"};Start-Sleep -Milliseconds 40}',
  '  }',
  '  foreach($target in @($source,$destination)){',
  '    $item=Get-Item -LiteralPath $target -Force',
  '    if($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "enrollment input is not regular"}',
  '  }',
  '  $stream=[IO.File]::Open($destination,[IO.FileMode]::Open,[IO.FileAccess]::Read,([IO.FileShare]::Read -bor [IO.FileShare]::Delete))',
  '  $sha=[Security.Cryptography.SHA256]::Create()',
  '  try{$digest=$sha.ComputeHash($stream)}finally{$sha.Dispose()}',
  '  try{$actual=([Convert]::ToBase64String($digest)).TrimEnd("=").Replace("+","-").Replace("/","_")}finally{[Array]::Clear($digest,0,$digest.Length)}',
  '  if($actual -cne $expectedDestination){throw "vault generation conflict"}',
  '  if((Get-FileGeneration $source) -cne $expectedSource){throw "vault source generation conflict"}',
  '  if([IO.File]::Exists($backup) -or [IO.Directory]::Exists($backup)){throw "enrollment backup already exists"}',
  '  # TEST-SEAM: the source and destination generations are pinned.',
  '  [IO.File]::Replace($source,$destination,$backup,$true)',
  '  $postBackup=Get-FileGeneration $backup',
  '  $postDestination=Get-FileGeneration $destination',
  '  if($postBackup -cne $expectedDestination -or $postDestination -cne $expectedSource){',
  '    if([IO.File]::Exists($source) -or [IO.Directory]::Exists($source)){throw "vault replacement compensation source is occupied"}',
  '    [IO.File]::Replace($backup,$destination,$source,$true)',
  '    if((Get-FileGeneration $destination) -cne $postBackup){throw "vault replacement compensation destination mismatch"}',
  '    if((Get-FileGeneration $source) -cne $postDestination){throw "vault replacement compensation source mismatch"}',
  '    if([IO.File]::Exists($backup) -or [IO.Directory]::Exists($backup)){throw "vault replacement compensation backup remained"}',
  '    throw "vault generation conflict"',
  '  }',
  '} finally {',
  '  if($null -ne $stream){$stream.Dispose()}',
  '  if($null -ne $lock){$lock.Dispose()}',
  '}'
].join('\n');

const TRANSACTION_LOCK_COMMON_SCRIPT = [
  `function Read-ExactBytes([IO.Stream]$stream,[int]$count){$bytes=New-Object byte[] $count;$offset=0;while($offset -lt $count){$read=$stream.Read($bytes,$offset,$count-$offset);if($read -le 0){throw "transaction lock bootstrap closed"};$offset+=$read};return ,$bytes}`,
  'function Get-ProcessStartFileTime([int]$processId){try{$process=[Diagnostics.Process]::GetProcessById($processId)}catch [ArgumentException]{return $null};try{return $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)}finally{$process.Dispose()}}',
  'function Set-OwnerFenceAcl([string]$target){$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User;$system=New-Object Security.Principal.SecurityIdentifier("S-1-5-18");$acl=New-Object Security.AccessControl.FileSecurity;$acl.SetOwner($owner);$acl.SetAccessRuleProtection($true,$false);$none=[Security.AccessControl.InheritanceFlags]::None;$noProp=[Security.AccessControl.PropagationFlags]::None;$allow=[Security.AccessControl.AccessControlType]::Allow;$rights=[Security.AccessControl.FileSystemRights]::FullControl;$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($owner,$rights,$none,$noProp,$allow)));$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system,$rights,$none,$noProp,$allow)));Set-Acl -LiteralPath $target -AclObject $acl}',
  'function Assert-OwnerFenceAcl([string]$target){$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User;$system=New-Object Security.Principal.SecurityIdentifier("S-1-5-18");$acl=[IO.File]::GetAccessControl($target);if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $owner.Value){throw [IO.InvalidDataException]::new("transaction owner fence ACL is invalid")};$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if($rules.Count -ne 2){throw [IO.InvalidDataException]::new("transaction owner fence ACL is invalid")};$seen=@{};$rights=[Security.AccessControl.FileSystemRights]::FullControl;foreach($rule in $rules){if($rule.IsInherited -or $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (([int64]$rule.FileSystemRights -band [int64]$rights) -ne [int64]$rights)){throw [IO.InvalidDataException]::new("transaction owner fence ACL is invalid")};$identity=$rule.IdentityReference.Value;if($identity -cne $owner.Value -and $identity -cne $system.Value){throw [IO.InvalidDataException]::new("transaction owner fence ACL is invalid")};$seen[$identity]=$true};if(-not $seen.ContainsKey($owner.Value) -or -not $seen.ContainsKey($system.Value)){throw [IO.InvalidDataException]::new("transaction owner fence ACL is invalid")}}',
  `function Assert-OwnerFenceRecord($record){$expected=@('nonce','pid','schemaVersion','startFileTimeUtc');$actual=@($record.PSObject.Properties.Name | Sort-Object);if($actual.Count -ne $expected.Count -or [String]::Join(',', $actual) -cne [String]::Join(',', $expected)){throw [IO.InvalidDataException]::new("transaction owner fence fields are invalid")};if($record.schemaVersion -cne '${TRANSACTION_OWNER_FENCE_SCHEMA}' -or ([string]$record.nonce) -notmatch '^[A-Za-z0-9_-]{43}$' -or ([string]$record.startFileTimeUtc) -notmatch '^[1-9][0-9]{0,19}$'){throw [IO.InvalidDataException]::new("transaction owner fence fields are invalid")};[int]$parsedPid=0;[uint64]$parsedStart=0;if(-not [int]::TryParse([string]$record.pid,[ref]$parsedPid) -or $parsedPid -le 0 -or -not [uint64]::TryParse([string]$record.startFileTimeUtc,[ref]$parsedStart)){throw [IO.InvalidDataException]::new("transaction owner fence fields are invalid")};$padding='=' * ((4-([string]$record.nonce).Length%4)%4);try{$nonceBytes=[Convert]::FromBase64String((([string]$record.nonce).Replace('-','+').Replace('_','/'))+$padding)}catch{throw [IO.InvalidDataException]::new("transaction owner fence nonce is invalid")};try{if($nonceBytes.Length -ne ${TRANSACTION_LOCK_OWNER_NONCE_BYTES} -or ([Convert]::ToBase64String($nonceBytes)).TrimEnd('=').Replace('+','-').Replace('/','_') -cne [string]$record.nonce){throw [IO.InvalidDataException]::new("transaction owner fence nonce is invalid")}}finally{[Array]::Clear($nonceBytes,0,$nonceBytes.Length)};return $record}`,
  'function Read-OwnerFence([string]$target){$item=Get-Item -LiteralPath $target -Force;if($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) -or $item.Length -le 0 -or $item.Length -gt 1024){throw [IO.InvalidDataException]::new("transaction owner fence is not a bounded regular file")};Assert-OwnerFenceAcl $target;$stream=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{$bytes=Read-ExactBytes $stream ([int]$stream.Length);try{$utf8=[Text.UTF8Encoding]::new($false,$true);$text=$utf8.GetString($bytes);try{$record=$text | ConvertFrom-Json}catch{throw [IO.InvalidDataException]::new("transaction owner fence JSON is invalid")};return Assert-OwnerFenceRecord $record}finally{[Array]::Clear($bytes,0,$bytes.Length)}}finally{$stream.Dispose()}}',
  `function Read-OwnerBootstrap([IO.Stream]$stdin){$bootstrap=Read-ExactBytes $stdin ${TRANSACTION_LOCK_BOOTSTRAP_BYTES};try{$ownerPid=[BitConverter]::ToInt32($bootstrap,0);if($ownerPid -le 0){throw "transaction lock owner PID is invalid"};$nonceBytes=New-Object byte[] ${TRANSACTION_LOCK_OWNER_NONCE_BYTES};[Array]::Copy($bootstrap,4,$nonceBytes,0,${TRANSACTION_LOCK_OWNER_NONCE_BYTES});try{$nonce=([Convert]::ToBase64String($nonceBytes)).TrimEnd('=').Replace('+','-').Replace('/','_')}finally{[Array]::Clear($nonceBytes,0,$nonceBytes.Length)};$ownerStart=Get-ProcessStartFileTime $ownerPid;if($null -eq $ownerStart){throw "transaction lock owner disappeared"};return [pscustomobject]@{pid=$ownerPid;nonce=$nonce;startFileTimeUtc=$ownerStart}}finally{[Array]::Clear($bootstrap,0,$bootstrap.Length)}}`
].join('\n');

const TRANSACTION_LOCK_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  TRANSACTION_LOCK_COMMON_SCRIPT,
  '$lockPath=[IO.Path]::GetFullPath($args[0])',
  '$ownerFence=$lockPath + ".owner.json"',
  '$directory=[IO.Path]::GetDirectoryName($lockPath)',
  '$directoryItem=Get-Item -LiteralPath $directory -Force',
  'if(-not $directoryItem.PSIsContainer -or (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "transaction lock directory is not regular"}',
  'if([IO.File]::Exists($lockPath) -or [IO.Directory]::Exists($lockPath)){$existing=Get-Item -LiteralPath $lockPath -Force;if($existing.PSIsContainer -or (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "transaction lock path is not regular"}}',
  `$deadline=[DateTime]::UtcNow.AddMilliseconds(${TRANSACTION_LOCK_WAIT_MS})`,
  '$stdin=[Console]::OpenStandardInput()',
  '$owner=Read-OwnerBootstrap $stdin',
  '$lock=$null',
  '$fenceStream=$null',
  '$temporaryFence=$null',
  '$ownsFence=$false',
  '$acknowledged=$false',
  '$completed=$false',
  'try {',
  '  while($null -eq $fenceStream){',
  '    while($null -eq $lock){try{$lock=New-Object IO.FileStream($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None,1,[IO.FileOptions]::DeleteOnClose)}catch [IO.IOException]{if([DateTime]::UtcNow -ge $deadline){$busy=[Console]::OpenStandardOutput();$busy.WriteByte(' + TRANSACTION_LOCK_BUSY + ');$busy.Flush();exit 23};Start-Sleep -Milliseconds 40}}',
  '    if([IO.Directory]::Exists($ownerFence)){throw [IO.InvalidDataException]::new("transaction owner fence is not a regular file")}',
  '    if([IO.File]::Exists($ownerFence)){try{$existingOwner=Read-OwnerFence $ownerFence}catch [IO.InvalidDataException]{$invalid=[Console]::OpenStandardOutput();$invalid.WriteByte(' + TRANSACTION_LOCK_INVALID + ');$invalid.Flush();exit 24};$existingStart=Get-ProcessStartFileTime ([int]$existingOwner.pid);if($null -ne $existingStart -and $existingStart -ceq [string]$existingOwner.startFileTimeUtc){$lock.Dispose();$lock=$null;if([DateTime]::UtcNow -ge $deadline){$busy=[Console]::OpenStandardOutput();$busy.WriteByte(' + TRANSACTION_LOCK_BUSY + ');$busy.Flush();exit 23};Start-Sleep -Milliseconds 40;continue};[IO.File]::Delete($ownerFence)}',
  '    $currentStart=Get-ProcessStartFileTime ([int]$owner.pid);if($null -eq $currentStart -or $currentStart -cne [string]$owner.startFileTimeUtc){throw "transaction lock owner identity changed"}',
  '    $temporaryFence=$ownerFence + "." + [Guid]::NewGuid().ToString("N") + ".tmp"',
  '    $record=[ordered]@{schemaVersion="' + TRANSACTION_OWNER_FENCE_SCHEMA + '";nonce=[string]$owner.nonce;pid=[int]$owner.pid;startFileTimeUtc=[string]$owner.startFileTimeUtc}',
  '    $bytes=[Text.UTF8Encoding]::new($false,$true).GetBytes(($record | ConvertTo-Json -Compress))',
  '    try{$writer=New-Object IO.FileStream($temporaryFence,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough);try{$writer.Write($bytes,0,$bytes.Length);$writer.Flush($true)}finally{$writer.Dispose()};Set-OwnerFenceAcl $temporaryFence;[IO.File]::Move($temporaryFence,$ownerFence);$temporaryFence=$null;$ownsFence=$true}finally{[Array]::Clear($bytes,0,$bytes.Length)}',
  '    $fenceStream=[IO.File]::Open($ownerFence,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)',
  '  }',
  '  $stdout=[Console]::OpenStandardOutput()',
  '  $stdout.WriteByte(' + TRANSACTION_LOCK_READY + ');$stdout.Flush()',
  '  $ack=$stdin.ReadByte()',
  '  if($ack -ne ' + TRANSACTION_LOCK_ACK + '){throw "transaction lock acknowledgement closed"}',
  '  $acknowledged=$true',
  '  $stdout.WriteByte(' + TRANSACTION_LOCK_ACKED + ');$stdout.Flush()',
  '  $control=$stdin.ReadByte()',
  '  if($control -ne ' + TRANSACTION_LOCK_RELEASE + '){throw "transaction lock control closed"}',
  '  $current=Read-OwnerFence $ownerFence',
  '  if([string]$current.nonce -cne [string]$owner.nonce -or [int]$current.pid -ne [int]$owner.pid -or [string]$current.startFileTimeUtc -cne [string]$owner.startFileTimeUtc){throw "transaction owner fence changed"}',
  '  $fenceStream.Dispose();$fenceStream=$null;[IO.File]::Delete($ownerFence);$ownsFence=$false',
  '  $stdout.WriteByte(' + TRANSACTION_LOCK_DONE + ');$stdout.Flush();$completed=$true',
  '} finally {',
  '  if($null -ne $fenceStream){$fenceStream.Dispose()}',
  '  if($null -ne $temporaryFence -and [IO.File]::Exists($temporaryFence)){[IO.File]::Delete($temporaryFence)}',
  '  if($ownsFence -and -not $acknowledged -and [IO.File]::Exists($ownerFence)){[IO.File]::Delete($ownerFence)}',
  '  if($null -ne $lock){$lock.Dispose()}',
  '}'
].join('\n');

const TRANSACTION_LOCK_CLEANUP_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  TRANSACTION_LOCK_COMMON_SCRIPT,
  '$lockPath=[IO.Path]::GetFullPath($args[0])',
  '$ownerFence=$lockPath + ".owner.json"',
  '$directory=[IO.Path]::GetDirectoryName($lockPath)',
  '$directoryItem=Get-Item -LiteralPath $directory -Force',
  'if(-not $directoryItem.PSIsContainer -or (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "transaction lock directory is not regular"}',
  '$stdin=[Console]::OpenStandardInput()',
  '$owner=Read-OwnerBootstrap $stdin',
  `$deadline=[DateTime]::UtcNow.AddMilliseconds(${TRANSACTION_LOCK_RELEASE_TIMEOUT_MS})`,
  '$lock=$null',
  'try {',
  '  while($null -eq $lock){try{$lock=New-Object IO.FileStream($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None,1,[IO.FileOptions]::DeleteOnClose)}catch [IO.IOException]{if([DateTime]::UtcNow -ge $deadline){throw "transaction lock cleanup timeout"};Start-Sleep -Milliseconds 40}}',
  '  if([IO.Directory]::Exists($ownerFence)){throw [IO.InvalidDataException]::new("transaction owner fence is not a regular file")}',
  '  if([IO.File]::Exists($ownerFence)){$current=Read-OwnerFence $ownerFence;if([string]$current.nonce -ceq [string]$owner.nonce -and [int]$current.pid -eq [int]$owner.pid -and [string]$current.startFileTimeUtc -ceq [string]$owner.startFileTimeUtc){[IO.File]::Delete($ownerFence)}}',
  '  $stdout=[Console]::OpenStandardOutput();$stdout.WriteByte(' + TRANSACTION_LOCK_DONE + ');$stdout.Flush()',
  '} finally {if($null -ne $lock){$lock.Dispose()}}'
].join('\n');

function fail(code, message, options) {
  throw new FraTokenEnrollmentError(code, message, options);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, label) {
  if (!isPlainRecord(value)) fail('INVALID_STATE', `${label} is invalid`);
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail('INVALID_STATE', `${label} has unsupported fields`);
  }
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function assertAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    fail('INVALID_CONFIGURATION', `${label} is invalid`);
  }
  return value;
}

function validateOperationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('INVALID_OPERATION_ID', 'operation identifier is invalid');
  }
  let bytes;
  try {
    bytes = Buffer.from(value, 'base64url');
    if (bytes.length !== 16 || bytes.toString('base64url') !== value) {
      fail('INVALID_OPERATION_ID', 'operation identifier is invalid');
    }
    return value;
  } finally {
    zero(bytes);
  }
}

function validateRole(role) {
  if (!ROLES.includes(role)) fail('INVALID_ROLE', 'enrollment role is invalid');
  return role;
}

function statePathFor(vaultPath, role) {
  validateRole(role);
  return path.join(
    path.dirname(path.resolve(vaultPath)),
    `.${path.basename(vaultPath)}.fra-token-enrollment.${role}.state.json`
  );
}

function transactionLockPathFor(vaultPath, role) {
  return `${statePathFor(vaultPath, role)}.transaction.lock`;
}

function transactionOwnerFencePathFor(lockPath) {
  return `${path.resolve(lockPath)}.owner.json`;
}

function derivedPaths(vaultPath, role, operationId) {
  const canonicalPath = path.resolve(vaultPath);
  validateRole(role);
  validateOperationId(operationId);
  const directory = path.dirname(canonicalPath);
  const stem = `.${path.basename(canonicalPath)}.fra-token-enrollment.${role}.${operationId}`;
  return Object.freeze({
    canonicalPath,
    statePath: statePathFor(canonicalPath, role),
    transactionLockPath: transactionLockPathFor(canonicalPath, role),
    candidatePath: path.join(directory, `${stem}.candidate`),
    stagedBackupPath: path.join(directory, `${stem}.staged-backup`),
    backupPath: path.join(directory, `${stem}.encrypted.bak`),
    restorePath: path.join(directory, `${stem}.restore`),
    failedNewPath: path.join(directory, `${stem}.failed-new`)
  });
}

function safeStateClone(state) {
  return JSON.parse(JSON.stringify(state));
}

function validateNullableFingerprint(value, label) {
  if (value === null) return null;
  return validateFingerprint(value, label);
}

function emptyFinalization() {
  return {
    state: 'none',
    fence: null,
    localReceiptDigest: null,
    peerReceiptDigest: null,
    preparedAt: null,
    mutualAt: null
  };
}

function validateFinalization(value) {
  assertExactKeys(value, [
    'state', 'fence', 'localReceiptDigest', 'peerReceiptDigest', 'preparedAt', 'mutualAt'
  ], 'finalization fence');
  if (!FINALIZATION_STATES.includes(value.state)) {
    fail('INVALID_STATE', 'finalization fence state is invalid');
  }
  validateNullableFingerprint(value.fence, 'finalization fence');
  validateNullableFingerprint(value.localReceiptDigest, 'local finalization receipt digest');
  validateNullableFingerprint(value.peerReceiptDigest, 'peer finalization receipt digest');
  for (const timestamp of [value.preparedAt, value.mutualAt]) {
    if (timestamp !== null && (!Number.isSafeInteger(timestamp) || timestamp <= 0)) {
      fail('INVALID_STATE', 'finalization fence timestamp is invalid');
    }
  }
  if (value.state === 'none' && (value.fence !== null || value.localReceiptDigest !== null
      || value.peerReceiptDigest !== null || value.preparedAt !== null || value.mutualAt !== null)) {
    fail('INVALID_STATE', 'empty finalization fence has values');
  }
  if (value.state === 'prepared' && (value.fence === null || value.localReceiptDigest === null
      || value.peerReceiptDigest !== null || value.preparedAt === null || value.mutualAt !== null)) {
    fail('INVALID_STATE', 'prepared finalization fence is incomplete');
  }
  if (value.state === 'mutual' && (value.fence === null || value.localReceiptDigest === null
      || value.peerReceiptDigest === null || value.preparedAt === null || value.mutualAt === null
      || value.mutualAt < value.preparedAt)) {
    fail('INVALID_STATE', 'mutual finalization fence is incomplete');
  }
  return value;
}

function validateState(state, paths, expectedRole) {
  if (isPlainRecord(state) && state.schemaVersion === LEGACY_STATE_SCHEMA) {
    assertExactKeys(state, [
      'schemaVersion', 'authKeyId', 'targetKey', 'role', 'operationId', 'phase',
      'canonicalPath', 'candidatePath', 'stagedBackupPath', 'backupPath', 'restorePath', 'failedNewPath',
      'previouslyPresent', 'previousFingerprint', 'newFingerprint', 'baseGenerationSha256',
      'candidateGenerationSha256', 'createdAt', 'updatedAt'
    ], 'legacy enrollment state');
    state = { ...state, schemaVersion: STATE_SCHEMA, finalization: emptyFinalization() };
  }
  assertExactKeys(state, [
    'schemaVersion',
    'authKeyId',
    'targetKey',
    'role',
    'operationId',
    'phase',
    'canonicalPath',
    'candidatePath',
    'stagedBackupPath',
    'backupPath',
    'restorePath',
    'failedNewPath',
    'previouslyPresent',
    'previousFingerprint',
    'newFingerprint',
    'baseGenerationSha256',
    'candidateGenerationSha256',
    'finalization',
    'createdAt',
    'updatedAt'
  ], 'enrollment state');
  validateKeyBinding(state.authKeyId, state.targetKey);
  validateRole(state.role);
  validateOperationId(state.operationId);
  if (
    state.schemaVersion !== STATE_SCHEMA ||
    state.role !== expectedRole ||
    !PHASES.includes(state.phase) ||
    typeof state.previouslyPresent !== 'boolean' ||
    !Number.isSafeInteger(state.createdAt) ||
    !Number.isSafeInteger(state.updatedAt) ||
    state.createdAt <= 0 ||
    state.updatedAt < state.createdAt
  ) {
    fail('INVALID_STATE', 'enrollment state fields are invalid');
  }
  if (
    (state.previouslyPresent && state.previousFingerprint === null) ||
    (!state.previouslyPresent && state.previousFingerprint !== null)
  ) {
    fail('INVALID_STATE', 'enrollment prior-presence binding is invalid');
  }
  validateNullableFingerprint(state.previousFingerprint, 'previous token fingerprint');
  validateFingerprint(state.newFingerprint, 'new token fingerprint');
  if (
    state.previouslyPresent &&
    state.previousFingerprint === state.newFingerprint
  ) {
    fail('INVALID_STATE', 'enrollment token was not rotated');
  }
  validateFingerprint(state.baseGenerationSha256, 'base vault generation');
  validateNullableFingerprint(
    state.candidateGenerationSha256,
    'candidate vault generation'
  );
  validateFinalization(state.finalization);
  if (
    ['prepared', 'committing', 'committed'].includes(state.phase) &&
    state.candidateGenerationSha256 === null
  ) {
    fail('INVALID_STATE', 'enrollment candidate generation is missing');
  }
  for (const key of [
    'canonicalPath',
    'candidatePath',
    'stagedBackupPath',
    'backupPath',
    'restorePath',
    'failedNewPath'
  ]) {
    if (!samePath(state[key], paths[key])) {
      fail('INVALID_STATE', 'enrollment state path binding is invalid');
    }
  }
  return state;
}

function minimalEnvironment() {
  const environment = Object.create(null);
  for (const name of [
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'ProgramData'
  ]) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  return environment;
}

function powerShellPath() {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(
    windowsRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
}

function transactionLockBootstrap(ownerNonce) {
  if (
    !Buffer.isBuffer(ownerNonce) ||
    ownerNonce.length !== TRANSACTION_LOCK_OWNER_NONCE_BYTES ||
    !Number.isSafeInteger(process.pid) ||
    process.pid <= 0 ||
    process.pid > 0x7fffffff
  ) {
    fail('TRANSACTION_LOCK_START_FAILED', 'FRA enrollment transaction lock owner identity is invalid');
  }
  const bootstrap = Buffer.alloc(TRANSACTION_LOCK_BOOTSTRAP_BYTES);
  bootstrap.writeInt32LE(process.pid, 0);
  ownerNonce.copy(bootstrap, 4);
  return bootstrap;
}

function cleanupPowerShellTransactionFence({
  lockPath,
  repoRoot,
  ownerNonce,
  executable = powerShellPath(),
  spawnImpl = spawn,
  timeoutMs = TRANSACTION_LOCK_RELEASE_TIMEOUT_MS
}) {
  const resolvedRoot = assertAbsolute(path.resolve(repoRoot), 'repoRoot');
  const resolvedLock = assertAbsolute(path.resolve(lockPath), 'transaction lock path');
  if (!resolvedLock.toLowerCase().startsWith(`${resolvedRoot.toLowerCase()}${path.sep}`)) {
    fail('INVALID_CONFIGURATION', 'transaction lock escaped the repository');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    fail('INVALID_CONFIGURATION', 'transaction lock cleanup timeout is invalid');
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command', `& {\n${TRANSACTION_LOCK_CLEANUP_SCRIPT}\n}`,
        resolvedLock
      ], {
        cwd: resolvedRoot,
        env: minimalEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      fail('TRANSACTION_LOCK_CLEANUP_FAILED', 'FRA enrollment transaction owner fence cleanup could not start');
    }

    let settled = false;
    let stderrBytes = 0;
    const stdoutBytes = [];
    const finishError = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch {}
      reject(new FraTokenEnrollmentError(
        'TRANSACTION_LOCK_CLEANUP_FAILED',
        'FRA enrollment transaction owner fence cleanup failed'
      ));
    };
    const timer = setTimeout(finishError, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', chunk => {
      if (stdoutBytes.length + chunk.length > 1) finishError();
      else for (const byte of chunk) stdoutBytes.push(byte);
      zero(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      zero(chunk);
      finishError();
    });
    child.stdin.on('error', finishError);
    child.once('error', finishError);
    child.once('close', (code, signal) => {
      if (settled) return;
      if (
        code !== 0 || signal !== null || stderrBytes !== 0 ||
        stdoutBytes.length !== 1 || stdoutBytes[0] !== TRANSACTION_LOCK_DONE
      ) {
        finishError();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    });

    let bootstrap;
    try {
      bootstrap = transactionLockBootstrap(ownerNonce);
      child.stdin.end(bootstrap, error => {
        zero(bootstrap);
        bootstrap = null;
        if (error) finishError();
      });
    } catch (error) {
      zero(bootstrap);
      finishError();
    }
  });
}

function acquirePowerShellTransactionLock({
  lockPath,
  repoRoot,
  executable = powerShellPath(),
  spawnImpl = spawn,
  cleanupImpl = cleanupPowerShellTransactionFence,
  startTimeoutMs = TRANSACTION_LOCK_START_TIMEOUT_MS,
  releaseTimeoutMs = TRANSACTION_LOCK_RELEASE_TIMEOUT_MS
}) {
  const resolvedRoot = assertAbsolute(path.resolve(repoRoot), 'repoRoot');
  const resolvedLock = assertAbsolute(path.resolve(lockPath), 'transaction lock path');
  const rootPrefix = `${resolvedRoot.toLowerCase()}${path.sep}`;
  if (!resolvedLock.toLowerCase().startsWith(rootPrefix)) {
    fail('INVALID_CONFIGURATION', 'transaction lock escaped the repository');
  }
  if (
    !Number.isSafeInteger(startTimeoutMs) || startTimeoutMs <= 0 ||
    !Number.isSafeInteger(releaseTimeoutMs) || releaseTimeoutMs <= 0 ||
    typeof cleanupImpl !== 'function'
  ) {
    fail('INVALID_CONFIGURATION', 'transaction lock timeout is invalid');
  }

  let ownerNonce;
  try {
    ownerNonce = crypto.randomBytes(TRANSACTION_LOCK_OWNER_NONCE_BYTES);
  } catch {
    fail('TRANSACTION_LOCK_START_FAILED', 'FRA enrollment transaction lock owner nonce could not be created');
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command', `& {\n${TRANSACTION_LOCK_SCRIPT}\n}`,
        resolvedLock
      ], {
        cwd: resolvedRoot,
        env: minimalEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch {
      zero(ownerNonce);
      fail('TRANSACTION_LOCK_START_FAILED', 'FRA enrollment transaction lock helper could not start');
    }

    let acquisitionSettled = false;
    let acquired = false;
    let acknowledgementPending = false;
    let acknowledgementWriteComplete = false;
    let helperAcknowledged = false;
    let bootstrapStarted = false;
    let releaseRequested = false;
    let releasePromise = null;
    let protocolError = null;
    let stderrBytes = 0;
    const stdoutBytes = [];
    let closed = null;
    let closeResolve;
    const closePromise = new Promise(resolveClose => { closeResolve = resolveClose; });
    const rejectAfterChildExit = error => {
      let timeout;
      Promise.race([
        closePromise,
        new Promise(resolveTimeout => {
          timeout = setTimeout(resolveTimeout, TRANSACTION_LOCK_RELEASE_TIMEOUT_MS);
          timeout.unref?.();
        })
      ]).then(async () => {
        if (timeout) clearTimeout(timeout);
        const firstControl = stdoutBytes[0];
        const cleanupEligible = bootstrapStarted
          && firstControl !== TRANSACTION_LOCK_BUSY
          && firstControl !== TRANSACTION_LOCK_INVALID;
        if (cleanupEligible) {
          try {
            await cleanupImpl({
              lockPath: resolvedLock,
              repoRoot: resolvedRoot,
              ownerNonce,
              executable,
              spawnImpl,
              timeoutMs: releaseTimeoutMs
            });
          } catch {}
        }
        zero(ownerNonce);
        reject(error);
      });
    };
    const startTimer = setTimeout(() => {
      const error = new FraTokenEnrollmentError(
        'ENROLLMENT_BUSY',
        'another FRA token enrollment operation holds the transaction lock'
      );
      protocolError = protocolError || error;
      try { child.kill(); } catch {}
      if (!acquisitionSettled) {
        acquisitionSettled = true;
        rejectAfterChildExit(error);
      }
    }, startTimeoutMs);
    startTimer.unref?.();

    const failProtocol = (code, message) => {
      const error = new FraTokenEnrollmentError(code, message);
      protocolError = protocolError || error;
      try { child.kill(); } catch {}
      if (!acquisitionSettled) {
        acquisitionSettled = true;
        clearTimeout(startTimer);
        rejectAfterChildExit(protocolError);
      }
    };

    const assertHeld = () => {
      if (protocolError || closed || !acquired || acknowledgementPending || releaseRequested) {
        throw protocolError || new FraTokenEnrollmentError(
          'TRANSACTION_LOCK_LOST',
          'FRA enrollment transaction lock was lost'
        );
      }
    };

    const release = async () => {
      if (releasePromise) return releasePromise;
      releasePromise = (async () => {
        releaseRequested = true;
        let releaseFailure = null;
        let control = Buffer.from([TRANSACTION_LOCK_RELEASE]);
        try {
          if (protocolError || closed || !acquired || acknowledgementPending) {
            throw protocolError || new FraTokenEnrollmentError(
              'TRANSACTION_LOCK_LOST',
              'FRA enrollment transaction lock was lost'
            );
          }
          await new Promise((resolveWrite, rejectWrite) => {
            child.stdin.write(control, error => error
              ? rejectWrite(new FraTokenEnrollmentError(
                'TRANSACTION_LOCK_RELEASE_FAILED',
                'FRA enrollment transaction lock helper rejected release'
              ))
              : resolveWrite());
          });
          child.stdin.end();
          let timeout;
          try {
            await Promise.race([
              closePromise,
              new Promise((resolveTimeout, rejectTimeout) => {
                timeout = setTimeout(() => rejectTimeout(new FraTokenEnrollmentError(
                  'TRANSACTION_LOCK_RELEASE_FAILED',
                  'FRA enrollment transaction lock helper did not release'
                )), releaseTimeoutMs);
                timeout.unref?.();
              })
            ]);
          } finally { if (timeout) clearTimeout(timeout); }
          if (
            protocolError || !closed || closed.code !== 0 || closed.signal !== null ||
            stderrBytes !== 0 || stdoutBytes.length !== 3 ||
            stdoutBytes[0] !== TRANSACTION_LOCK_READY ||
            stdoutBytes[1] !== TRANSACTION_LOCK_ACKED || stdoutBytes[2] !== TRANSACTION_LOCK_DONE
          ) {
            throw protocolError || new FraTokenEnrollmentError(
              'TRANSACTION_LOCK_RELEASE_FAILED',
              'FRA enrollment transaction lock helper exited unexpectedly'
            );
          }
        } catch (error) {
          releaseFailure = error instanceof FraTokenEnrollmentError
            ? error
            : new FraTokenEnrollmentError(
              'TRANSACTION_LOCK_RELEASE_FAILED',
              'FRA enrollment transaction lock could not be released'
            );
          try { child.kill(); } catch {}
          await Promise.race([
            closePromise,
            new Promise(resolveWait => {
              const timer = setTimeout(resolveWait, releaseTimeoutMs);
              timer.unref?.();
            })
          ]);
          try {
            await cleanupImpl({
              lockPath: resolvedLock,
              repoRoot: resolvedRoot,
              ownerNonce,
              executable,
              spawnImpl,
              timeoutMs: releaseTimeoutMs
            });
          } catch (cleanupError) {
            cleanupError.cause = releaseFailure;
            throw cleanupError;
          }
          throw releaseFailure;
        } finally {
          zero(control);
          control = null;
          zero(ownerNonce);
        }
      })();
      return releasePromise;
    };

    const resolveAcknowledgedLease = () => {
      if (
        acquired || acquisitionSettled || protocolError || closed ||
        !acknowledgementWriteComplete || !helperAcknowledged
      ) return;
      acknowledgementPending = false;
      acquired = true;
      acquisitionSettled = true;
      clearTimeout(startTimer);
      resolve(Object.freeze({
        pid: child.pid,
        ownerFencePath: transactionOwnerFencePathFor(resolvedLock),
        assertHeld,
        release,
        waitForExit: () => closePromise
      }));
    };

    child.stdout.on('data', chunk => {
      try {
        if (stdoutBytes.length + chunk.length > 3) {
          failProtocol('TRANSACTION_LOCK_PROTOCOL_ERROR', 'transaction lock helper emitted excess control data');
          return;
        }
        for (const byte of chunk) stdoutBytes.push(byte);
        if (stdoutBytes.length > 0) {
          if (stdoutBytes[0] === TRANSACTION_LOCK_BUSY) {
            failProtocol('ENROLLMENT_BUSY', 'another FRA token enrollment operation holds the transaction lock');
            return;
          }
          if (stdoutBytes[0] === TRANSACTION_LOCK_INVALID) {
            failProtocol('TRANSACTION_LOCK_INVALID', 'transaction owner fence is invalid');
            return;
          }
          if (stdoutBytes[0] !== TRANSACTION_LOCK_READY) {
            failProtocol('TRANSACTION_LOCK_PROTOCOL_ERROR', 'transaction lock helper returned an invalid control frame');
            return;
          }
        }
        if (!acknowledgementPending && !acknowledgementWriteComplete && stdoutBytes.length >= 1) {
          acknowledgementPending = true;
          let acknowledgement = Buffer.from([TRANSACTION_LOCK_ACK]);
          child.stdin.write(acknowledgement, error => {
            zero(acknowledgement);
            acknowledgement = null;
            if (error || protocolError || closed) {
              failProtocol('TRANSACTION_LOCK_LOST', 'transaction lock acknowledgement failed');
              return;
            }
            acknowledgementWriteComplete = true;
            resolveAcknowledgedLease();
          });
        }
        if (stdoutBytes.length >= 2) {
          if (stdoutBytes[1] !== TRANSACTION_LOCK_ACKED) {
            failProtocol('TRANSACTION_LOCK_PROTOCOL_ERROR', 'transaction lock helper acknowledgement is invalid');
            return;
          }
          helperAcknowledged = true;
          resolveAcknowledgedLease();
        }
        if (stdoutBytes.length >= 3 && (!acquired || !releaseRequested || stdoutBytes[2] !== TRANSACTION_LOCK_DONE)) {
          failProtocol('TRANSACTION_LOCK_PROTOCOL_ERROR', 'transaction lock helper released without authorization');
        }
      } finally {
        zero(chunk);
      }
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      zero(chunk);
      failProtocol('TRANSACTION_LOCK_HELPER_FAILED', 'transaction lock helper failed');
    });
    child.stdin.on('error', () => {
      if (!releaseRequested) {
        failProtocol('TRANSACTION_LOCK_LOST', 'transaction lock helper control channel failed');
      }
    });
    child.once('error', () => {
      failProtocol('TRANSACTION_LOCK_START_FAILED', 'transaction lock helper could not start');
    });
    child.once('close', (code, signal) => {
      closed = { code, signal };
      closeResolve(closed);
      if (!acquisitionSettled) {
        clearTimeout(startTimer);
        acquisitionSettled = true;
        const error = stdoutBytes.length === 1 && stdoutBytes[0] === TRANSACTION_LOCK_BUSY
          ? new FraTokenEnrollmentError(
            'ENROLLMENT_BUSY',
            'another FRA token enrollment operation holds the transaction lock'
          )
          : protocolError || new FraTokenEnrollmentError(
            'TRANSACTION_LOCK_START_FAILED',
            'FRA enrollment transaction lock helper exited before acquisition'
          );
        rejectAfterChildExit(error);
      }
    });

    let bootstrap;
    try {
      bootstrap = transactionLockBootstrap(ownerNonce);
      bootstrapStarted = true;
      child.stdin.write(bootstrap, error => {
        zero(bootstrap);
        bootstrap = null;
        if (error) failProtocol('TRANSACTION_LOCK_START_FAILED', 'transaction lock owner bootstrap failed');
      });
    } catch {
      zero(bootstrap);
      failProtocol('TRANSACTION_LOCK_START_FAILED', 'transaction lock owner bootstrap failed');
    }
  });
}

function encodeFrame(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length === 0 || body.length > MAX_PIPE_FRAME_BYTES) {
    zero(body);
    fail('PIPE_FRAME_INVALID', 'private helper frame is invalid');
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  zero(body);
  return frame;
}

function encodeRawFrame(value) {
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > MAX_PIPE_FRAME_BYTES) {
    fail('PIPE_FRAME_INVALID', 'private helper raw frame is invalid');
  }
  const frame = Buffer.allocUnsafe(4 + value.length);
  frame.writeUInt32LE(value.length, 0);
  value.copy(frame, 4);
  return frame;
}

function encodePipeBootstrap(pipeName, pipeAuthenticator) {
  if (typeof pipeName !== 'string') {
    fail('PIPE_BOOTSTRAP_INVALID', 'private helper pipe name is invalid');
  }
  const nameBytes = Buffer.from(pipeName, 'utf8');
  if (
    nameBytes.length < MIN_PIPE_NAME_BYTES
    || nameBytes.length > MAX_PIPE_NAME_BYTES
    || !/^[A-Za-z0-9_.-]+$/.test(pipeName)
    || !Buffer.isBuffer(pipeAuthenticator)
    || pipeAuthenticator.length !== PIPE_AUTHENTICATOR_BYTES
  ) {
    zero(nameBytes);
    fail('PIPE_BOOTSTRAP_INVALID', 'private helper bootstrap is invalid');
  }
  const bootstrap = Buffer.alloc(4 + nameBytes.length + pipeAuthenticator.length);
  bootstrap.writeUInt32LE(nameBytes.length, 0);
  nameBytes.copy(bootstrap, 4);
  pipeAuthenticator.copy(bootstrap, 4 + nameBytes.length);
  zero(nameBytes);
  return bootstrap;
}

function readFrame(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) {
        zero(value);
        return;
      }
      settled = true;
      for (const chunk of chunks) zero(chunk);
      if (error) reject(error);
      else resolve(value);
    };
    socket.on('data', chunk => {
      total += chunk.length;
      if (total > MAX_PIPE_FRAME_BYTES + 4) {
        zero(chunk);
        socket.destroy();
        finish(new FraTokenEnrollmentError(
          'PIPE_FRAME_TOO_LARGE',
          'private helper frame exceeded its bound'
        ));
        return;
      }
      chunks.push(Buffer.from(chunk));
      zero(chunk);
    });
    socket.once('error', () => finish(new FraTokenEnrollmentError(
      'PIPE_READ_FAILED',
      'private helper pipe read failed'
    )));
    socket.once('end', () => {
      let combined;
      let body;
      try {
        combined = Buffer.concat(chunks, total);
        if (combined.length < 4) fail('PIPE_PROTOCOL_ERROR', 'private helper frame is incomplete');
        const declared = combined.readUInt32LE(0);
        if (declared === 0 || declared > MAX_PIPE_FRAME_BYTES || declared !== combined.length - 4) {
          fail('PIPE_PROTOCOL_ERROR', 'private helper frame length is invalid');
        }
        body = Buffer.from(combined.subarray(4));
        finish(null, body);
        body = null;
      } catch (error) {
        finish(error);
      } finally {
        zero(combined);
        zero(body);
      }
    });
  });
}

function readSingleFrame(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
    };
    const finish = (error, value) => {
      if (settled) {
        zero(value);
        return;
      }
      settled = true;
      cleanup();
      for (const chunk of chunks) zero(chunk);
      if (error) reject(error);
      else resolve(value);
    };
    const onError = () => finish(new FraTokenEnrollmentError(
      'PIPE_AUTH_FAILED',
      'private helper authentication failed'
    ));
    const onEnd = () => finish(new FraTokenEnrollmentError(
      'PIPE_AUTH_FAILED',
      'private helper authentication was incomplete'
    ));
    const onData = chunk => {
      let combined;
      let body;
      try {
        total += chunk.length;
        if (total > MAX_PIPE_FRAME_BYTES + 4) {
          finish(new FraTokenEnrollmentError(
            'PIPE_AUTH_FAILED',
            'private helper authentication exceeded its bound'
          ));
          return;
        }
        chunks.push(Buffer.from(chunk));
        zero(chunk);
        if (total < 4) return;
        combined = Buffer.concat(chunks, total);
        const declared = combined.readUInt32LE(0);
        if (declared === 0 || declared > MAX_PIPE_FRAME_BYTES) {
          finish(new FraTokenEnrollmentError(
            'PIPE_AUTH_FAILED',
            'private helper authentication frame is invalid'
          ));
          return;
        }
        if (total < declared + 4) return;
        if (total !== declared + 4) {
          finish(new FraTokenEnrollmentError(
            'PIPE_AUTH_FAILED',
            'private helper authentication frame has trailing bytes'
          ));
          return;
        }
        body = Buffer.from(combined.subarray(4));
        finish(null, body);
        body = null;
      } catch (error) {
        finish(error);
      } finally {
        zero(combined);
        zero(body);
      }
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('end', onEnd);
  });
}

function connectPrivatePipe({ pipeName, timeoutMs = HELPER_TIMEOUT_MS, connectImpl = net.createConnection }) {
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let socket;
    let retryTimer;
    let deadlineTimer;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (error) reject(error);
      else resolve(value);
    };
    const retry = () => {
      if (Date.now() >= deadline) {
        finish(new FraTokenEnrollmentError('PIPE_CONNECT_FAILED', 'private helper pipe did not open'));
        return;
      }
      retryTimer = setTimeout(open, PIPE_CONNECT_RETRY_MS);
      retryTimer.unref?.();
    };
    const open = () => {
      if (settled) return;
      socket = connectImpl(pipePath);
      socket.once('connect', () => finish(null, socket));
      socket.once('error', error => {
        if (socket && !socket.destroyed) socket.destroy();
        if (error && ['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) retry();
        else finish(new FraTokenEnrollmentError('PIPE_CONNECT_FAILED', 'private helper pipe connection failed'));
      });
    };
    deadlineTimer = setTimeout(() => finish(
      new FraTokenEnrollmentError('PIPE_CONNECT_FAILED', 'private helper pipe did not open')
    ), timeoutMs);
    deadlineTimer.unref?.();
    open();
  });
}

function launchPowerShellHelper({
  executable,
  helperPath,
  pipeName,
  pipeAuthenticator,
  repoRoot,
  spawnImpl = spawn,
  timeoutMs = HELPER_TIMEOUT_MS
}) {
  if (typeof pipeName !== 'string') {
    fail('PIPE_BOOTSTRAP_INVALID', 'private helper pipe name is invalid');
  }
  if (!Buffer.isBuffer(pipeAuthenticator) || pipeAuthenticator.length !== PIPE_AUTHENTICATOR_BYTES) {
    fail('PIPE_AUTH_INVALID', 'private helper authenticator is invalid');
  }
  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let bootstrap = encodePipeBootstrap(pipeName, pipeAuthenticator);
    const child = spawnImpl(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helperPath
    ], {
      cwd: repoRoot,
      env: minimalEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let settled = false;
    const rejectStart = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      zero(bootstrap);
      bootstrap = null;
      try { child.kill(); } catch {}
      reject(new FraTokenEnrollmentError(
        'HELPER_START_FAILED',
        'private vault helper could not receive its authenticator'
      ));
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      zero(bootstrap);
      bootstrap = null;
      child.kill();
      reject(new FraTokenEnrollmentError(
        'HELPER_TIMEOUT',
        'private vault helper timed out'
      ));
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      zero(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      zero(chunk);
    });
    child.stdin.once('error', rejectStart);
    child.stdin.write(bootstrap, error => {
      zero(bootstrap);
      bootstrap = null;
      if (error) {
        rejectStart();
        return;
      }
      child.stdin.end();
    });
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      zero(bootstrap);
      bootstrap = null;
      reject(new FraTokenEnrollmentError(
        'HELPER_START_FAILED',
        'private vault helper could not start'
      ));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      zero(bootstrap);
      bootstrap = null;
      resolve({ code, signal, stdoutBytes, stderrBytes });
    });
  });
}

async function runPrivateVaultHelper({
  request,
  repoRoot,
  helperPath = path.join(path.resolve(repoRoot), 'tools', 'fra-token-enrollment-vault-helper.ps1'),
  executable = powerShellPath(),
  launchHelper = launchPowerShellHelper,
  connectPipe = connectPrivatePipe,
  timeoutMs = HELPER_TIMEOUT_MS
}) {
  if (!isPlainRecord(request)) fail('PIPE_REQUEST_INVALID', 'private helper request is invalid');
  const pipeName = `toolsenabled-fra-enroll-${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
  let pipeAuthenticator = crypto.randomBytes(PIPE_AUTHENTICATOR_BYTES);
  let socket;
  let requestFrame;
  let responseFrame;
  let timeout;
  try {
    const helperPromise = launchHelper({
      executable,
      helperPath,
      pipeName,
      pipeAuthenticator,
      repoRoot: path.resolve(repoRoot)
    });
    const activeSocket = await Promise.race([
      connectPipe({ pipeName, timeoutMs }),
      helperPromise.then(() => {
        throw new FraTokenEnrollmentError(
          'HELPER_EXITED_EARLY',
          'private vault helper exited before opening its pipe'
        );
      }),
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new FraTokenEnrollmentError(
          'HELPER_TIMEOUT',
          'private vault helper timed out'
        )), timeoutMs);
      })
    ]);
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    const responsePromise = readFrame(activeSocket);
    const authenticationFrame = encodeRawFrame(pipeAuthenticator);
    const requestBodyFrame = encodeFrame(request);
    requestFrame = Buffer.concat([authenticationFrame, requestBodyFrame]);
    zero(authenticationFrame);
    zero(requestBodyFrame);
    zero(pipeAuthenticator);
    pipeAuthenticator = null;
    await new Promise((resolve, reject) => {
      activeSocket.write(requestFrame, error => {
        if (error) reject(new FraTokenEnrollmentError(
          'PIPE_WRITE_FAILED',
          'private helper pipe write failed'
        ));
        else resolve();
      });
    });
    requestFrame.fill(0);
    requestFrame = null;
    responseFrame = await Promise.race([
      responsePromise,
      new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new FraTokenEnrollmentError(
          'HELPER_TIMEOUT',
          'private vault helper timed out'
        )), timeoutMs);
      })
    ]);
    const exit = await helperPromise;
    let response;
    try {
      response = JSON.parse(responseFrame.toString('utf8'));
    } catch {
      fail('PIPE_PROTOCOL_ERROR', 'private vault helper returned invalid JSON');
    }
    if (
      exit.stdoutBytes !== 0 ||
      exit.stderrBytes !== 0 ||
      exit.stdoutBytes > MAX_CHILD_OUTPUT_BYTES ||
      exit.stderrBytes > MAX_CHILD_OUTPUT_BYTES
    ) {
      fail('HELPER_CONSOLE_OUTPUT', 'private vault helper emitted console output');
    }
    if (
      exit.code !== 0 ||
      exit.signal !== null ||
      !isPlainRecord(response) ||
      response.schemaVersion !== PIPE_SCHEMA ||
      response.ok !== true
    ) {
      const safeCode = isPlainRecord(response) &&
        typeof response.errorCode === 'string' &&
        /^[A-Z0-9_]{1,80}$/.test(response.errorCode)
        ? response.errorCode
        : 'HELPER_FAILED';
      fail(safeCode, 'private vault helper rejected the operation');
    }
    return response;
  } finally {
    if (timeout) clearTimeout(timeout);
    zero(requestFrame);
    zero(responseFrame);
    zero(pipeAuthenticator);
    pipeAuthenticator = null;
    if (socket && !socket.destroyed) socket.destroy();
  }
}

async function checkedProcess(runner, invocation) {
  let result;
  try {
    result = await runner({
      ...invocation,
      timeoutMs: HELPER_TIMEOUT_MS,
      maxOutputBytes: MAX_CHILD_OUTPUT_BYTES
    });
    if (
      !result ||
      result.code !== 0 ||
      (result.signal !== undefined && result.signal !== null) ||
      !Buffer.isBuffer(result.stdout) ||
      !Buffer.isBuffer(result.stderr)
    ) {
      fail('CHILD_PROCESS_FAILED', 'enrollment filesystem helper failed');
    }
    return result;
  } catch (error) {
    if (error instanceof FraTokenEnrollmentError) throw error;
    fail('CHILD_PROCESS_FAILED', 'enrollment filesystem helper failed');
  }
}

function productionDependencies({
  repoRoot,
  helperPath = path.join(path.resolve(repoRoot), 'tools', 'fra-token-enrollment-vault-helper.ps1'),
  powershellExecutable = powerShellPath(),
  processRunner = runHiddenProcess,
  launchHelper = launchPowerShellHelper
}) {
  const resolvedRoot = assertAbsolute(path.resolve(repoRoot), 'repoRoot');
  const invokePowerShell = async args => checkedProcess(processRunner, {
    file: powershellExecutable,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      ...args
    ],
    cwd: resolvedRoot,
    env: minimalEnvironment(),
    stdin: Buffer.alloc(0)
  });
  const privateRequest = request => runPrivateVaultHelper({
    request,
    repoRoot: resolvedRoot,
    helperPath,
    executable: powershellExecutable,
    launchHelper
  });
  return {
    fs: fs.promises,
    now: () => Date.now(),
    randomId: () => crypto.randomBytes(12).toString('hex'),
    async acquireTransactionLock(lockPath) {
      return acquirePowerShellTransactionLock({
        lockPath,
        repoRoot: resolvedRoot,
        executable: powershellExecutable
      });
    },
    async fileDigest(target) {
      let handle;
      let digest;
      try {
        handle = await fs.promises.open(target, 'r');
        const before = await handle.stat();
        if (!before.isFile()) fail('INVALID_VAULT_FILE', 'vault generation target is not regular');
        const hash = crypto.createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        const after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          fail('VAULT_GENERATION_CONFLICT', 'vault changed while hashing');
        }
        digest = hash.digest();
        return digest.toString('base64url');
      } finally {
        zero(digest);
        if (handle) await handle.close();
      }
    },
    async restrictAcl(target) {
      let result;
      try {
        result = await invokePowerShell(['-Command', `& {\n${ACL_SCRIPT}\n}`, target]);
        if (result.stdout.length !== 0 || result.stderr.length !== 0) {
          fail('ACL_FAILED', 'enrollment ACL helper emitted output');
        }
      } finally {
        if (result) {
          zero(result.stdout);
          zero(result.stderr);
        }
      }
    },
    async inspect({ role, operationId, slot }) {
      const response = await privateRequest({
        schemaVersion: PIPE_SCHEMA,
        action: 'inspect',
        authKeyId: AUTH_VAULT_KEY,
        targetKey: TARGET_VAULT_KEY,
        role,
        operationId,
        slot
      });
      assertExactKeys(response, [
        'schemaVersion', 'ok', 'action', 'targetKey', 'exists', 'fingerprint'
      ], 'private inspect response');
      validateKeyBinding(AUTH_VAULT_KEY, response.targetKey);
      if (
        response.action !== 'inspect' ||
        typeof response.exists !== 'boolean' ||
        (response.exists ? typeof response.fingerprint !== 'string' : response.fingerprint !== null)
      ) {
        fail('PIPE_PROTOCOL_ERROR', 'private inspect response is invalid');
      }
      if (response.exists) validateFingerprint(response.fingerprint);
      return { exists: response.exists, fingerprint: response.fingerprint };
    },
    async setToken({ role, operationId, token }) {
      validateToken(token);
      const response = await privateRequest({
        schemaVersion: PIPE_SCHEMA,
        action: 'set_candidate',
        authKeyId: AUTH_VAULT_KEY,
        targetKey: TARGET_VAULT_KEY,
        role,
        operationId,
        tokenBase64Url: token
      });
      assertExactKeys(response, [
        'schemaVersion', 'ok', 'action', 'targetKey', 'fingerprint'
      ], 'private set response');
      validateKeyBinding(AUTH_VAULT_KEY, response.targetKey);
      validateFingerprint(response.fingerprint);
      if (response.action !== 'set_candidate' || response.fingerprint !== tokenFingerprint(token)) {
        fail('VAULT_FINGERPRINT_MISMATCH', 'private set response did not match');
      }
    },
    async signCanonical(keyId, canonical) {
      validateKeyBinding(keyId, TARGET_VAULT_KEY);
      if (!(canonical instanceof Uint8Array) || canonical.byteLength > 32 * 1024) {
        fail('SIGN_INPUT_INVALID', 'signing input is invalid');
      }
      const response = await privateRequest({
        schemaVersion: PIPE_SCHEMA,
        action: 'sign',
        authKeyId: keyId,
        targetKey: TARGET_VAULT_KEY,
        canonicalBase64Url: Buffer.from(canonical).toString('base64url')
      });
      assertExactKeys(response, [
        'schemaVersion', 'ok', 'action', 'authKeyId', 'proof'
      ], 'private sign response');
      if (response.action !== 'sign' || response.authKeyId !== AUTH_VAULT_KEY) {
        fail('KEY_BINDING_MISMATCH', 'private signer key binding did not match');
      }
      validateFingerprint(response.proof, 'private signer proof');
      return response.proof;
    },
    async atomicReplace(
      source,
      destination,
      backup,
      expectedDestinationGeneration,
      expectedSourceGeneration
    ) {
      validateFingerprint(expectedDestinationGeneration, 'expected destination vault generation');
      validateFingerprint(expectedSourceGeneration, 'expected source vault generation');
      let result;
      try {
        result = await invokePowerShell([
          '-Command', `& {\n${REPLACE_SCRIPT}\n}`,
          source,
          destination,
          backup,
          expectedDestinationGeneration,
          expectedSourceGeneration
        ]);
        if (result.stdout.length !== 0 || result.stderr.length !== 0) {
          fail('ATOMIC_REPLACE_FAILED', 'enrollment replacement helper emitted output');
        }
      } finally {
        if (result) {
          zero(result.stdout);
          zero(result.stderr);
        }
      }
    }
  };
}

function targetMatches(actual, present, fingerprint) {
  return actual.exists === present &&
    (present ? actual.fingerprint === fingerprint : actual.fingerprint === null);
}

class FraTokenVaultTransaction {
  constructor({
    repoRoot,
    role,
    operationId,
    dependencies
  }) {
    this.repoRoot = assertAbsolute(path.resolve(repoRoot), 'repoRoot');
    this.role = validateRole(role);
    this.operationId = validateOperationId(operationId);
    const canonicalPath = path.join(this.repoRoot, 'vault', 'secrets.json');
    this.paths = derivedPaths(canonicalPath, this.role, this.operationId);
    this.deps = dependencies || productionDependencies({ repoRoot: this.repoRoot });
  }

  async _exists(target) {
    try {
      await this.deps.fs.lstat(target);
      return true;
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async _withTransactionLock(action) {
    let lease;
    let operationError;
    let value;
    let releaseError;
    try {
      if (!this.deps || typeof this.deps.acquireTransactionLock !== 'function') {
        fail('INVALID_CONFIGURATION', 'transaction lock dependency is unavailable');
      }
      lease = await this.deps.acquireTransactionLock(this.paths.transactionLockPath);
      if (!lease || typeof lease.release !== 'function' || typeof lease.assertHeld !== 'function') {
        fail('INVALID_CONFIGURATION', 'transaction lock dependency returned an invalid lease');
      }
      lease.assertHeld();
      value = await action();
      lease.assertHeld();
    } catch (error) {
      operationError = error;
    } finally {
      if (lease) {
        try {
          await lease.release();
        } catch (error) {
          releaseError = error instanceof FraTokenEnrollmentError
            ? error
            : new FraTokenEnrollmentError(
              'TRANSACTION_LOCK_RELEASE_FAILED',
              'FRA enrollment transaction lock could not be released'
            );
        }
      }
    }
    if (releaseError) {
      if (operationError) releaseError.cause = operationError;
      throw releaseError;
    }
    if (operationError) throw operationError;
    return value;
  }

  async _assertRegular(target, label) {
    const stat = await this.deps.fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('INVALID_VAULT_FILE', `${label} is not a regular file`);
    }
  }

  async _assertVaultDirectory() {
    const directory = path.dirname(this.paths.canonicalPath);
    const stat = await this.deps.fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('INVALID_VAULT_DIRECTORY', 'vault directory is not regular');
    }
  }

  async _removeIfPresent(target) {
    try {
      await this.deps.fs.unlink(target);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  async _removeRegularIfPresent(target, label) {
    try {
      const stat = await this.deps.fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail('INVALID_VAULT_FILE', `${label} is not a regular file`);
      }
      await this.deps.fs.unlink(target);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }

  async _writeState(state, createOnly = false) {
    await this._assertVaultDirectory();
    validateState(state, this.paths, this.role);
    const suffix = this.deps.randomId();
    if (!/^[a-f0-9]{16,64}$/i.test(suffix)) {
      fail('INVALID_RANDOM_ID', 'state temporary identifier is invalid');
    }
    const temporary = `${this.paths.statePath}.${suffix}.tmp`;
    let handle;
    let bytes;
    try {
      bytes = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
      if (bytes.length > MAX_STATE_BYTES) fail('STATE_TOO_LARGE', 'enrollment state is too large');
      handle = await this.deps.fs.open(temporary, 'wx', 0o600);
      await this.deps.restrictAcl(temporary);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      if (createOnly) {
        if (await this._exists(this.paths.statePath)) {
          fail('ENROLLMENT_ALREADY_EXISTS', 'an active enrollment state already exists');
        }
        await this.deps.fs.copyFile(
          temporary,
          this.paths.statePath,
          fs.constants.COPYFILE_EXCL
        );
        // copyFile creates a distinct destination whose inherited ACL must be
        // narrowed before the create-only state is admitted.
        await this.deps.restrictAcl(this.paths.statePath);
        await this._removeIfPresent(temporary);
      } else {
        // The temporary file was already ACL-restricted above. A same-directory
        // atomic rename preserves that security descriptor. Reapplying Set-Acl
        // after the durable rename can throw after the phase has already been
        // committed, falsely turning a successful update into
        // ROLLBACK_INCOMPLETE and making every recovery update repeat-fail.
        await this.deps.fs.rename(temporary, this.paths.statePath);
      }
    } finally {
      zero(bytes);
      if (handle) await handle.close().catch(() => {});
      await this._removeIfPresent(temporary).catch(() => {});
    }
  }

  async _readState() {
    let bytes;
    try {
      await this._assertRegular(this.paths.statePath, 'enrollment state');
      const stat = await this.deps.fs.lstat(this.paths.statePath);
      if (stat.size <= 0 || stat.size > MAX_STATE_BYTES) {
        fail('INVALID_STATE', 'enrollment state size is invalid');
      }
      bytes = await this.deps.fs.readFile(this.paths.statePath);
      return validateState(JSON.parse(bytes.toString('utf8')), this.paths, this.role);
    } catch (error) {
      if (error instanceof FraTokenEnrollmentError) throw error;
      fail('INVALID_STATE', 'enrollment state could not be read');
    } finally {
      zero(bytes);
    }
  }

  async _updatePhase(state, phase) {
    if (!PHASES.includes(phase)) fail('INVALID_PHASE', 'enrollment phase is invalid');
    const updated = {
      ...state,
      phase,
      updatedAt: this.deps.now()
    };
    await this._writeState(updated);
    return updated;
  }

  async _inspect(slot) {
    return this.deps.inspect({
      path: this.paths[`${slot}Path`] || this.paths.canonicalPath,
      role: this.role,
      operationId: this.operationId,
      slot
    });
  }

  async _assertTarget(slot, present, fingerprint, label) {
    const actual = await this._inspect(slot);
    if (!targetMatches(actual, present, fingerprint)) {
      fail('VAULT_FINGERPRINT_MISMATCH', `${label} target did not match`);
    }
  }

  async _assertTerminalArtifact(slot, present, fingerprint, generation, label) {
    const target = this.paths[`${slot}Path`];
    if (!await this._exists(target)) return;
    await this._assertRegular(target, label);
    await this._assertTarget(slot, present, fingerprint, label);
    if (await this.deps.fileDigest(target) !== generation) {
      fail('VAULT_GENERATION_MISMATCH', `${label} generation did not match`);
    }
  }

  async _retirePriorTerminalState() {
    if (!await this._exists(this.paths.statePath)) return;
    let bytes;
    try {
      await this._assertRegular(this.paths.statePath, 'prior enrollment state');
      const stat = await this.deps.fs.lstat(this.paths.statePath);
      if (stat.size <= 0 || stat.size > MAX_STATE_BYTES) {
        fail('INVALID_STATE', 'prior enrollment state size is invalid');
      }
      bytes = await this.deps.fs.readFile(this.paths.statePath);
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!isPlainRecord(parsed) || parsed.role !== this.role) {
        fail('INVALID_STATE', 'prior enrollment state identity is invalid');
      }
      const priorOperationId = validateOperationId(parsed.operationId);
      if (priorOperationId === this.operationId) {
        fail('ENROLLMENT_ALREADY_EXISTS', 'this enrollment operation already exists');
      }
      const prior = new FraTokenVaultTransaction({
        repoRoot: this.repoRoot,
        role: this.role,
        operationId: priorOperationId,
        dependencies: this.deps
      });
      const state = await prior.status();
      if (state.phase !== 'committed' && state.phase !== 'rolled_back') {
        fail('ENROLLMENT_ALREADY_EXISTS', 'an active enrollment state already exists');
      }
      if (state.phase === 'committed') {
        fail('PRIOR_FINALIZATION_REQUIRED', 'prior committed enrollment must be finalized through the lifecycle barrier');
      }
      // A rolled-back transaction can retain recovery material. It likewise
      // requires an explicit recovery review; automatic enrollment must never
      // dispose of it while starting a successor transaction.
      fail('PRIOR_RECOVERY_REVIEW_REQUIRED', 'prior rolled-back enrollment requires explicit recovery review');
    } catch (error) {
      if (error instanceof FraTokenEnrollmentError) throw error;
      fail('INVALID_STATE', 'prior enrollment state could not be retired');
    } finally {
      zero(bytes);
    }
  }

  async prepare(token) {
    validateToken(token);
    return this._withTransactionLock(() => this._prepareUnlocked(token));
  }

  async _prepareUnlocked(token) {
    validateToken(token);
    const newFingerprint = tokenFingerprint(token);
    await this._assertVaultDirectory();
    await this._retirePriorTerminalState();
    await this._assertRegular(this.paths.canonicalPath, 'canonical vault');
    const previous = await this._inspect('canonical');
    if (previous.exists && previous.fingerprint === newFingerprint) {
      fail('TOKEN_NOT_ROTATED', 'new FRA token matches the current token');
    }
    const baseGenerationSha256 = await this.deps.fileDigest(this.paths.canonicalPath);
    validateFingerprint(baseGenerationSha256, 'base vault generation');
    const now = this.deps.now();
    let state = {
      schemaVersion: STATE_SCHEMA,
      authKeyId: AUTH_VAULT_KEY,
      targetKey: TARGET_VAULT_KEY,
      role: this.role,
      operationId: this.operationId,
      phase: 'preparing',
      canonicalPath: this.paths.canonicalPath,
      candidatePath: this.paths.candidatePath,
      stagedBackupPath: this.paths.stagedBackupPath,
      backupPath: this.paths.backupPath,
      restorePath: this.paths.restorePath,
      failedNewPath: this.paths.failedNewPath,
      previouslyPresent: previous.exists,
      previousFingerprint: previous.fingerprint,
      newFingerprint,
      baseGenerationSha256,
      candidateGenerationSha256: null,
      finalization: emptyFinalization(),
      createdAt: now,
      updatedAt: now
    };
    await this._writeState(state, true);
    try {
      await this.deps.fs.copyFile(
        this.paths.canonicalPath,
        this.paths.stagedBackupPath,
        fs.constants.COPYFILE_EXCL
      );
      await this.deps.restrictAcl(this.paths.stagedBackupPath);
      if (await this.deps.fileDigest(this.paths.stagedBackupPath) !== baseGenerationSha256) {
        fail('VAULT_GENERATION_MISMATCH', 'staged backup generation did not match');
      }
      await this._assertTarget(
        'stagedBackup',
        previous.exists,
        previous.fingerprint,
        'staged backup'
      );

      await this.deps.fs.copyFile(
        this.paths.canonicalPath,
        this.paths.candidatePath,
        fs.constants.COPYFILE_EXCL
      );
      await this.deps.restrictAcl(this.paths.candidatePath);
      await this.deps.setToken({
        path: this.paths.candidatePath,
        role: this.role,
        operationId: this.operationId,
        token
      });
      await this.deps.restrictAcl(this.paths.candidatePath);
      await this._assertTarget('candidate', true, newFingerprint, 'candidate vault');
      const candidateGenerationSha256 = await this.deps.fileDigest(this.paths.candidatePath);
      validateFingerprint(candidateGenerationSha256, 'candidate vault generation');
      state = { ...state, candidateGenerationSha256 };
      state = await this._updatePhase(state, 'prepared');
      return safeStateClone(state);
    } catch (error) {
      try {
        state = await this._updatePhase(state, 'prepare_failed');
        await this._rollbackUnlocked();
      } catch {
        throw new FraTokenEnrollmentError(
          'ROLLBACK_INCOMPLETE',
          'enrollment preparation failed and rollback was incomplete',
          { rollbackIncomplete: true }
        );
      }
      if (error instanceof FraTokenEnrollmentError) throw error;
      fail('VAULT_PREPARE_FAILED', 'FRA token preparation failed');
    }
  }

  async commit() {
    return this._withTransactionLock(() => this._commitUnlocked());
  }

  async _commitUnlocked() {
    let state = await this._readState();
    if (state.phase === 'committed') {
      await this._assertTarget('canonical', true, state.newFingerprint, 'committed vault');
      return safeStateClone(state);
    }
    if (state.phase !== 'prepared') {
      fail('INVALID_PHASE', 'FRA token vault is not prepared');
    }
    try {
      await this._assertTarget(
        'canonical',
        state.previouslyPresent,
        state.previousFingerprint,
        'canonical vault'
      );
      await this._assertTarget(
        'stagedBackup',
        state.previouslyPresent,
        state.previousFingerprint,
        'staged backup'
      );
      await this._assertTarget('candidate', true, state.newFingerprint, 'candidate vault');
      if (
        await this.deps.fileDigest(this.paths.canonicalPath) !== state.baseGenerationSha256 ||
        await this.deps.fileDigest(this.paths.stagedBackupPath) !== state.baseGenerationSha256 ||
        await this.deps.fileDigest(this.paths.candidatePath) !== state.candidateGenerationSha256
      ) {
        fail('VAULT_GENERATION_CONFLICT', 'vault changed after staging');
      }
      state = await this._updatePhase(state, 'committing');
      await this.deps.atomicReplace(
        this.paths.candidatePath,
        this.paths.canonicalPath,
        this.paths.backupPath,
        state.baseGenerationSha256,
        state.candidateGenerationSha256
      );
      await this.deps.restrictAcl(this.paths.canonicalPath);
      await this.deps.restrictAcl(this.paths.backupPath);
      await this._assertTarget('canonical', true, state.newFingerprint, 'committed vault');
      await this._assertTarget(
        'backup',
        state.previouslyPresent,
        state.previousFingerprint,
        'old encrypted backup'
      );
      if (
        await this.deps.fileDigest(this.paths.canonicalPath) !== state.candidateGenerationSha256 ||
        await this.deps.fileDigest(this.paths.backupPath) !== state.baseGenerationSha256
      ) {
        fail('VAULT_GENERATION_MISMATCH', 'committed vault generation did not match');
      }
      state = await this._updatePhase(state, 'committed');
      return safeStateClone(state);
    } catch (error) {
      try {
        await this._rollbackUnlocked();
      } catch {
        throw new FraTokenEnrollmentError(
          'ROLLBACK_INCOMPLETE',
          'enrollment commit failed and rollback was incomplete',
          { rollbackIncomplete: true }
        );
      }
      if (error instanceof FraTokenEnrollmentError) throw error;
      fail('VAULT_COMMIT_FAILED', 'FRA token vault commit failed');
    }
  }

  async rollback() {
    return this._withTransactionLock(() => this._rollbackUnlocked());
  }

  async _rollbackUnlocked() {
    let state = await this._readState();
    if (state.phase === 'committed' && state.finalization.state !== 'none') {
      fail('FINALIZATION_FENCED', 'a prepared finalization fence prevents rollback');
    }
    if (state.phase === 'rolled_back') {
      await this._assertTarget(
        'canonical',
        state.previouslyPresent,
        state.previousFingerprint,
        'rolled-back vault'
      );
      return safeStateClone(state);
    }
    state = await this._updatePhase(state, 'rolling_back');
    await this._assertRegular(this.paths.canonicalPath, 'canonical vault');
    const current = await this._inspect('canonical');
    const currentGeneration = await this.deps.fileDigest(this.paths.canonicalPath);
    const backupExists = await this._exists(this.paths.backupPath);
    if (
      targetMatches(current, true, state.newFingerprint) &&
      currentGeneration === state.candidateGenerationSha256
    ) {
      if (!backupExists) {
        fail('ROLLBACK_RECOVERY_REQUIRED', 'committed vault has no old backup');
      }
      await this._assertTarget(
        'backup',
        state.previouslyPresent,
        state.previousFingerprint,
        'old encrypted backup'
      );
      if (await this.deps.fileDigest(this.paths.backupPath) !== state.baseGenerationSha256) {
        fail('ROLLBACK_RECOVERY_REQUIRED', 'old backup generation did not match');
      }
      await this._removeIfPresent(this.paths.restorePath);
      await this.deps.fs.copyFile(
        this.paths.backupPath,
        this.paths.restorePath,
        fs.constants.COPYFILE_EXCL
      );
      await this.deps.restrictAcl(this.paths.restorePath);
      if (await this._exists(this.paths.failedNewPath)) {
        fail('ROLLBACK_RECOVERY_REQUIRED', 'failed-new recovery file already exists');
      }
      await this.deps.atomicReplace(
        this.paths.restorePath,
        this.paths.canonicalPath,
        this.paths.failedNewPath,
        state.candidateGenerationSha256,
        state.baseGenerationSha256
      );
      await this.deps.restrictAcl(this.paths.canonicalPath);
      await this.deps.restrictAcl(this.paths.failedNewPath);
    } else if (
      targetMatches(current, state.previouslyPresent, state.previousFingerprint) &&
      (!backupExists || currentGeneration === state.baseGenerationSha256)
    ) {
      // No commit occurred, or the exact old generation is already canonical.
      // If a non-target field changed before commit and no authoritative backup
      // exists, preserve it rather than overwriting the concurrent update.
    } else {
      fail('ROLLBACK_RECOVERY_REQUIRED', 'vault generation cannot be rolled back automatically');
    }
    await this._assertTarget(
      'canonical',
      state.previouslyPresent,
      state.previousFingerprint,
      'rolled-back vault'
    );
    for (const target of [
      this.paths.candidatePath,
      `${this.paths.candidatePath}.lock`,
      this.paths.stagedBackupPath,
      this.paths.restorePath
    ]) {
      await this._removeIfPresent(target);
    }
    state = await this._updatePhase(state, 'rolled_back');
    return safeStateClone(state);
  }

  async prepareFinalize({ fence, localReceiptDigest } = {}) {
    return this._withTransactionLock(() => this._prepareFinalizeUnlocked({ fence, localReceiptDigest }));
  }

  async _prepareFinalizeUnlocked({ fence, localReceiptDigest }) {
    validateFingerprint(fence, 'finalization fence');
    validateFingerprint(localReceiptDigest, 'local finalization receipt digest');
    const state = await this._readState();
    if (state.phase !== 'committed') {
      fail('FINALIZATION_FENCE_REQUIRED', 'only a committed enrollment may prepare finalization');
    }
    await this._assertTarget('canonical', true, state.newFingerprint, 'committed vault');
    if (state.finalization.state === 'mutual') {
      if (state.finalization.fence !== fence || state.finalization.localReceiptDigest !== localReceiptDigest) {
        fail('FINALIZATION_FENCE_MISMATCH', 'mutual finalization fence did not match');
      }
      return safeStateClone(state);
    }
    if (state.finalization.state === 'prepared') {
      if (state.finalization.fence !== fence || state.finalization.localReceiptDigest !== localReceiptDigest) {
        fail('FINALIZATION_FENCE_MISMATCH', 'prepared finalization fence did not match');
      }
      return safeStateClone(state);
    }
    const updated = {
      ...state,
      finalization: {
        state: 'prepared', fence, localReceiptDigest, peerReceiptDigest: null,
        preparedAt: this.deps.now(), mutualAt: null
      },
      updatedAt: this.deps.now()
    };
    await this._writeState(updated);
    return safeStateClone(updated);
  }

  async confirmPeerFinalize({ fence, peerReceiptDigest } = {}) {
    return this._withTransactionLock(() => this._confirmPeerFinalizeUnlocked({ fence, peerReceiptDigest }));
  }

  async _confirmPeerFinalizeUnlocked({ fence, peerReceiptDigest }) {
    validateFingerprint(fence, 'finalization fence');
    validateFingerprint(peerReceiptDigest, 'peer finalization receipt digest');
    const state = await this._readState();
    if (state.phase !== 'committed' || state.finalization.state === 'none') {
      fail('FINALIZATION_FENCE_REQUIRED', 'local finalization fence was not prepared');
    }
    if (state.finalization.fence !== fence) {
      fail('FINALIZATION_FENCE_MISMATCH', 'peer finalization fence did not match');
    }
    if (state.finalization.state === 'mutual') {
      if (state.finalization.peerReceiptDigest !== peerReceiptDigest) {
        fail('FINALIZATION_FENCE_MISMATCH', 'peer finalization receipt did not match');
      }
      return safeStateClone(state);
    }
    const updated = {
      ...state,
      finalization: {
        ...state.finalization,
        state: 'mutual', peerReceiptDigest, mutualAt: this.deps.now()
      },
      updatedAt: this.deps.now()
    };
    await this._writeState(updated);
    return safeStateClone(updated);
  }

  async finalize({ fence } = {}) {
    return this._withTransactionLock(() => this._finalizeUnlocked({ fence }));
  }

  async retireRolledBackRecovery() {
    return this._withTransactionLock(() => this._retireRolledBackRecoveryUnlocked());
  }

  async _retireRolledBackRecoveryUnlocked() {
    const state = await this._readState();
    if (state.phase !== 'rolled_back') {
      fail('RECOVERY_RETIREMENT_PHASE_INVALID', 'only rolled-back recovery may be retired');
    }
    if (state.finalization.state !== 'none') {
      fail('RECOVERY_RETIREMENT_FINALIZATION_INVALID', 'rolled-back recovery has a finalization fence');
    }
    await this._assertTarget(
      'canonical',
      state.previouslyPresent,
      state.previousFingerprint,
      'rolled-back vault'
    );
    if (await this.deps.fileDigest(this.paths.canonicalPath) !== state.baseGenerationSha256) {
      fail('VAULT_GENERATION_CONFLICT', 'rolled-back vault generation changed');
    }
    return this._finalizeUnlocked({
      allowRolledBack: true,
      expectedCanonicalGeneration: state.baseGenerationSha256
    });
  }

  async _finalizeUnlocked({
    fence = null,
    allowRolledBack = false,
    expectedCanonicalGeneration = null
  } = {}) {
    const state = await this._readState();
    if (state.phase !== 'committed' && !(allowRolledBack && state.phase === 'rolled_back')) {
      fail('FINALIZATION_FENCE_REQUIRED', 'only a mutually fenced committed enrollment may be finalized');
    }
    if (state.phase === 'committed') {
      await this._assertTarget('canonical', true, state.newFingerprint, 'committed vault');
      validateFingerprint(fence, 'finalization fence');
      if (state.finalization.state !== 'mutual' || state.finalization.fence !== fence) {
        fail('FINALIZATION_FENCE_REQUIRED', 'mutual finalization fence is required');
      }
    } else {
      await this._assertTarget(
        'canonical',
        state.previouslyPresent,
        state.previousFingerprint,
        'rolled-back vault'
      );
    }
    await this._assertTerminalArtifact(
      'candidate', true, state.newFingerprint, state.candidateGenerationSha256, 'candidate vault'
    );
    await this._assertTerminalArtifact(
      'failedNew', true, state.newFingerprint, state.candidateGenerationSha256, 'failed-new vault'
    );
    for (const slot of ['stagedBackup', 'backup', 'restore']) {
      await this._assertTerminalArtifact(
        slot,
        state.previouslyPresent,
        state.previousFingerprint,
        state.baseGenerationSha256,
        `${slot} vault`
      );
    }
    if (allowRolledBack) {
      if (expectedCanonicalGeneration !== state.baseGenerationSha256 ||
          await this.deps.fileDigest(this.paths.canonicalPath) !== expectedCanonicalGeneration) {
        fail('VAULT_GENERATION_CONFLICT', 'rolled-back vault generation changed before retirement');
      }
      await this._assertTarget(
        'canonical',
        state.previouslyPresent,
        state.previousFingerprint,
        'rolled-back vault'
      );
    }
    for (const target of [
      this.paths.candidatePath,
      `${this.paths.candidatePath}.lock`,
      this.paths.stagedBackupPath,
      this.paths.backupPath,
      this.paths.restorePath,
      this.paths.failedNewPath
    ]) {
      await this._removeRegularIfPresent(target, 'terminal enrollment artifact');
    }
    await this._removeRegularIfPresent(this.paths.statePath, 'terminal enrollment state');
    return safeStateClone(state);
  }

  async status() {
    return safeStateClone(await this._readState());
  }
}

async function openExistingTransaction({
  repoRoot,
  role,
  dependencies
}) {
  const resolvedRoot = path.resolve(repoRoot);
  const vaultPath = path.join(resolvedRoot, 'vault', 'secrets.json');
  const statePath = statePathFor(vaultPath, role);
  const fsPromises = dependencies ? dependencies.fs : fs.promises;
  let bytes;
  try {
    const stat = await fsPromises.lstat(statePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
      fail('INVALID_STATE', 'enrollment state is not a bounded regular file');
    }
    bytes = await fsPromises.readFile(statePath);
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!isPlainRecord(parsed) || parsed.role !== role) {
      fail('INVALID_STATE', 'enrollment state identity is invalid');
    }
    const transaction = new FraTokenVaultTransaction({
      repoRoot: resolvedRoot,
      role,
      operationId: validateOperationId(parsed.operationId),
      dependencies
    });
    await transaction.status();
    return transaction;
  } catch (error) {
    if (error instanceof FraTokenEnrollmentError) throw error;
    fail('INVALID_STATE', 'enrollment state could not be opened');
  } finally {
    zero(bytes);
  }
}

module.exports = {
  ACL_SCRIPT,
  HELPER_TIMEOUT_MS,
  MAX_PIPE_FRAME_BYTES,
  PHASES,
  PIPE_SCHEMA,
  REPLACE_SCRIPT,
  ROLES,
  STATE_SCHEMA,
  TRANSACTION_LOCK_CLEANUP_SCRIPT,
  TRANSACTION_LOCK_SCRIPT,
  TRANSACTION_OWNER_FENCE_SCHEMA,
  acquirePowerShellTransactionLock,
  cleanupPowerShellTransactionFence,
  FraTokenVaultTransaction,
  derivedPaths,
  launchPowerShellHelper,
  minimalEnvironment,
  openExistingTransaction,
  powerShellPath,
  productionDependencies,
  runPrivateVaultHelper,
  statePathFor,
  transactionLockPathFor,
  transactionOwnerFencePathFor,
  targetMatches,
  validateOperationId,
  validateState
};
