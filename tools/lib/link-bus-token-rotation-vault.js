'use strict';

// Durable, local half of the 8787 token rotation transaction.  The candidate,
// old backup, and any failed-new recovery copy are DPAPI-encrypted vault files.
// The state file contains paths, phases, and SHA-256 fingerprints only.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  TOKEN_VAULT_KEY,
  LinkBusTokenRotationError,
  tokenFingerprint,
  validateFingerprint,
  validateToken,
  validateVerificationReceipt,
  zero
} = require('./link-bus-token-rotation');
const {
  runHiddenProcess
} = require('./hidden-process');

const STATE_SCHEMA =
  'tools-enabled.special-session.link-bus-token-rotation-state.v1';
const ROLES = Object.freeze(['a', 'b']);
const PHASES = Object.freeze([
  'preparing',
  'prepared',
  'committing',
  'committed',
  'verified',
  'finalized',
  'rolling_back',
  'rolled_back',
  'prepare_failed'
]);
const MAX_STATE_BYTES = 64 * 1024;
const PROCESS_TIMEOUT_MS = 120000;
const MAX_CHILD_OUTPUT_BYTES = 8192;

const ACL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$target=[IO.Path]::GetFullPath($args[0])',
  '$item=Get-Item -LiteralPath $target -Force',
  'if($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "ACL target is not a regular file"}',
  '$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User',
  "$system=New-Object Security.Principal.SecurityIdentifier('S-1-5-18')",
  '$acl=New-Object Security.AccessControl.FileSecurity',
  '$acl.SetOwner($owner)',
  '$acl.SetAccessRuleProtection($true,$false)',
  '$none=[Security.AccessControl.InheritanceFlags]::None',
  '$noProp=[Security.AccessControl.PropagationFlags]::None',
  '$allow=[Security.AccessControl.AccessControlType]::Allow',
  '$rights=[Security.AccessControl.FileSystemRights]::FullControl',
  '$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($owner,$rights,$none,$noProp,$allow)))',
  '$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($system,$rights,$none,$noProp,$allow)))',
  'Set-Acl -LiteralPath $target -AclObject $acl'
].join('\n');

const REPLACE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '$source=[IO.Path]::GetFullPath($args[0])',
  '$destination=[IO.Path]::GetFullPath($args[1])',
  '$backup=[IO.Path]::GetFullPath($args[2])',
  '$expectedGeneration=[string]$args[3]',
  '$directory=[IO.Path]::GetDirectoryName($destination)',
  '$comparison=[StringComparison]::OrdinalIgnoreCase',
  'if(-not [String]::Equals([IO.Path]::GetDirectoryName($source),$directory,$comparison)){throw "rotation source escaped the vault directory"}',
  'if(-not [String]::Equals([IO.Path]::GetDirectoryName($backup),$directory,$comparison)){throw "rotation backup escaped the vault directory"}',
  '$directoryItem=Get-Item -LiteralPath $directory -Force',
  'if(-not $directoryItem.PSIsContainer -or (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "vault directory is not a regular directory"}',
  '$lockPath=$destination + ".lock"',
  '$deadline=[DateTime]::UtcNow.AddSeconds(30)',
  '$lock=$null',
  'try {',
  '  while($null -eq $lock){',
  '    try{$lock=New-Object IO.FileStream($lockPath,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}',
  '    catch [IO.IOException]{if([DateTime]::UtcNow -ge $deadline){throw "vault lock timeout"};Start-Sleep -Milliseconds 40}',
  '  }',
  '  $sourceItem=Get-Item -LiteralPath $source -Force',
  '  $destinationItem=Get-Item -LiteralPath $destination -Force',
  '  foreach($item in @($sourceItem,$destinationItem)){if($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw "rotation input is not a regular file"}}',
  '  $stream=[IO.File]::OpenRead($destination)',
  '  try{$sha=[Security.Cryptography.SHA256]::Create();try{$digest=$sha.ComputeHash($stream)}finally{$sha.Dispose()}}finally{$stream.Dispose()}',
  '  try{$actual=([Convert]::ToBase64String($digest)).TrimEnd("=").Replace("+","-").Replace("/","_")}finally{[Array]::Clear($digest,0,$digest.Length)}',
  '  if($actual -cne $expectedGeneration){throw "vault generation conflict"}',
  '  if([IO.File]::Exists($backup) -or [IO.Directory]::Exists($backup)){throw "rotation backup already exists"}',
  '  [IO.File]::Replace($source,$destination,$backup,$true)',
  '} finally {if($null -ne $lock){$lock.Dispose()}}'
].join('\n');

function fail(code, message, options) {
  throw new LinkBusTokenRotationError(code, message, options);
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

function assertAbsolute(value, label) {
  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    fail('INVALID_CONFIGURATION', `${label} must be an absolute normalized path`);
  }
  return value;
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function validateOperationId(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(value)
  ) {
    fail('INVALID_OPERATION_ID', 'rotation operation id is invalid');
  }
  const decoded = Buffer.from(value, 'base64url');
  try {
    if (decoded.length !== 16 || decoded.toString('base64url') !== value) {
      fail('INVALID_OPERATION_ID', 'rotation operation id is invalid');
    }
  } finally {
    zero(decoded);
  }
  return value;
}

function statePathFor(vaultPath, role) {
  if (!ROLES.includes(role)) {
    fail('INVALID_CONFIGURATION', 'rotation role is invalid');
  }
  const canonical = assertAbsolute(path.resolve(vaultPath), 'vaultPath');
  return path.join(
    path.dirname(canonical),
    `.link-bus-token-rotation-${role}.state.json`
  );
}

function derivedPaths(vaultPath, role, operationId) {
  const canonicalPath = assertAbsolute(path.resolve(vaultPath), 'vaultPath');
  validateOperationId(operationId);
  if (!ROLES.includes(role)) {
    fail('INVALID_CONFIGURATION', 'rotation role is invalid');
  }
  const directory = path.dirname(canonicalPath);
  const basename = path.basename(canonicalPath);
  const stem = `${basename}.link-bus-rotation.${operationId}.${role}`;
  return Object.freeze({
    statePath: statePathFor(canonicalPath, role),
    canonicalPath,
    candidatePath: path.join(directory, `.${stem}.candidate`),
    stagedBackupPath: path.join(
      directory,
      `${stem}.staged-old.encrypted.bak`
    ),
    backupPath: path.join(directory, `${stem}.old.encrypted.bak`),
    failedNewPath: path.join(directory, `${stem}.failed-new.encrypted.bak`),
    restorePath: path.join(directory, `.${stem}.restore`)
  });
}

function safeStateClone(state) {
  return JSON.parse(JSON.stringify(state));
}

function validateState(state, paths, expectedRole) {
  assertExactKeys(state, [
    'schemaVersion',
    'role',
    'operationId',
    'phase',
    'canonicalPath',
    'candidatePath',
    'stagedBackupPath',
    'backupPath',
    'failedNewPath',
    'oldTokenSha256',
    'newTokenSha256',
    'baseGenerationSha256',
    'candidateGenerationSha256',
    'createdAt',
    'updatedAt',
    'verification'
  ], 'rotation state');
  if (
    state.schemaVersion !== STATE_SCHEMA ||
    state.role !== expectedRole ||
    !PHASES.includes(state.phase) ||
    !Number.isSafeInteger(state.createdAt) ||
    !Number.isSafeInteger(state.updatedAt) ||
    state.createdAt <= 0 ||
    state.updatedAt < state.createdAt
  ) {
    fail('INVALID_STATE', 'rotation state metadata is invalid');
  }
  validateOperationId(state.operationId);
  validateFingerprint(state.oldTokenSha256);
  validateFingerprint(state.newTokenSha256);
  validateFingerprint(state.baseGenerationSha256);
  if (state.candidateGenerationSha256 !== null) {
    validateFingerprint(state.candidateGenerationSha256);
  }
  if (
    ['prepared', 'committing', 'committed', 'verified', 'finalized'].includes(
      state.phase
    ) &&
    state.candidateGenerationSha256 === null
  ) {
    fail('INVALID_STATE', 'rotation state lacks its candidate generation');
  }
  if (state.oldTokenSha256 === state.newTokenSha256) {
    fail('INVALID_STATE', 'rotation state fingerprints must differ');
  }
  for (const [key, expected] of [
    ['canonicalPath', paths.canonicalPath],
    ['candidatePath', paths.candidatePath],
    ['stagedBackupPath', paths.stagedBackupPath],
    ['backupPath', paths.backupPath],
    ['failedNewPath', paths.failedNewPath]
  ]) {
    if (!samePath(state[key], expected)) {
      fail('INVALID_STATE', `rotation state ${key} escaped its derived path`);
    }
  }
  if (state.verification !== null) {
    validateVerificationReceipt(
      state.verification,
      state.operationId,
      state.newTokenSha256
    );
  }
  if (
    ['verified', 'finalized'].includes(state.phase) &&
    state.verification === null
  ) {
    fail('INVALID_STATE', 'verified rotation state lacks its receipt');
  }
  return state;
}

function minimalEnvironment(extra = {}) {
  const selected = {};
  for (const key of [
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATH',
    'PATHEXT',
    'TEMP',
    'TMP'
  ]) {
    if (typeof process.env[key] === 'string') selected[key] = process.env[key];
  }
  return { ...selected, ...extra };
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

async function checkedProcess(runner, invocation) {
  let result;
  try {
    result = await runner({
      ...invocation,
      shell: false,
      windowsHide: true,
      timeoutMs: PROCESS_TIMEOUT_MS,
      maxOutputBytes: MAX_CHILD_OUTPUT_BYTES
    });
    if (
      !result ||
      result.code !== 0 ||
      !Buffer.isBuffer(result.stdout) ||
      !Buffer.isBuffer(result.stderr)
    ) {
      if (result) {
        zero(result.stdout);
        zero(result.stderr);
      }
      fail('CHILD_PROCESS_FAILED', 'rotation helper failed');
    }
    return result;
  } catch (error) {
    if (error instanceof LinkBusTokenRotationError) throw error;
    fail('CHILD_PROCESS_FAILED', 'rotation helper failed');
  }
}

function productionDependencies({
  repoRoot,
  secretsScriptPath = path.join(repoRoot, 'tools', 'secrets.ps1'),
  fingerprintScriptPath = path.join(
    repoRoot,
    'tools',
    'special-session-vault-key-fingerprint.ps1'
  ),
  powershellExecutable = powerShellPath(),
  processRunner = runHiddenProcess
}) {
  const resolvedRoot = assertAbsolute(path.resolve(repoRoot), 'repoRoot');
  const resolvedSecrets = assertAbsolute(
    path.resolve(secretsScriptPath),
    'secretsScriptPath'
  );
  const resolvedFingerprint = assertAbsolute(
    path.resolve(fingerprintScriptPath),
    'fingerprintScriptPath'
  );
  const resolvedPowerShell = assertAbsolute(
    path.resolve(powershellExecutable),
    'powershellExecutable'
  );

  const invokePowerShell = async ({ args, stdin = Buffer.alloc(0), env }) => {
    return checkedProcess(processRunner, {
      file: resolvedPowerShell,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        ...args
      ],
      cwd: resolvedRoot,
      env: minimalEnvironment(env),
      stdin
    });
  };

  return {
    fs: fs.promises,
    now: () => Date.now(),
    randomId: () => crypto.randomBytes(12).toString('hex'),
    async fileDigest(target) {
      let handle;
      let digest;
      try {
        handle = await fs.promises.open(target, 'r');
        const hash = crypto.createHash('sha256');
        const stream = handle.createReadStream({ autoClose: false });
        for await (const chunk of stream) hash.update(chunk);
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
        result = await invokePowerShell({
          args: ['-Command', ACL_SCRIPT, target]
        });
        if (result.stdout.length !== 0 || result.stderr.length !== 0) {
          fail('ACL_FAILED', 'rotation ACL helper emitted output');
        }
      } finally {
        if (result) {
          zero(result.stdout);
          zero(result.stderr);
        }
      }
    },
    async fingerprint(vaultPath) {
      let result;
      let text;
      try {
        result = await invokePowerShell({
          args: [
            '-File',
            resolvedFingerprint,
            '-VaultPath',
            vaultPath,
            '-KeyId',
            TOKEN_VAULT_KEY
          ]
        });
        if (result.stderr.length !== 0) {
          fail('VAULT_FINGERPRINT_FAILED', 'vault fingerprint helper emitted diagnostics');
        }
        text = result.stdout.toString('ascii');
        validateFingerprint(text);
        return text;
      } finally {
        text = null;
        if (result) {
          zero(result.stdout);
          zero(result.stderr);
        }
      }
    },
    async setToken(vaultPath, token) {
      let stdin;
      let result;
      try {
        validateToken(token);
        stdin = Buffer.from(token, 'utf8');
        result = await invokePowerShell({
          args: ['-File', resolvedSecrets, 'set-stdin', TOKEN_VAULT_KEY],
          env: {
            TOOLSENABLED_VAULT_PATH: vaultPath,
            TOOLSENABLED_VAULT_LOCK_TIMEOUT_MS: '30000'
          },
          stdin
        });
        if (result.stdout.length !== 0 || result.stderr.length !== 0) {
          fail('VAULT_WRITE_FAILED', 'vault writer emitted unexpected output');
        }
      } finally {
        zero(stdin);
        if (result) {
          zero(result.stdout);
          zero(result.stderr);
        }
      }
    },
    async atomicReplace(
      source,
      destination,
      backupPath,
      expectedGenerationSha256
    ) {
      validateFingerprint(expectedGenerationSha256);
      if (typeof backupPath !== 'string' || !path.isAbsolute(backupPath)) {
        fail('INVALID_CONFIGURATION', 'rotation backup path is invalid');
      }
      let result;
      try {
        result = await invokePowerShell({
          args: [
            '-Command',
            REPLACE_SCRIPT,
            source,
            destination,
            backupPath,
            expectedGenerationSha256
          ]
        });
        if (result.stdout.length !== 0 || result.stderr.length !== 0) {
          fail('ATOMIC_REPLACE_FAILED', 'vault replacement helper emitted output');
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

class RotationVaultTransaction {
  constructor({
    repoRoot,
    role,
    operationId,
    vaultPath = path.join(path.resolve(repoRoot), 'vault', 'secrets.json'),
    dependencies
  }) {
    this.repoRoot = assertAbsolute(path.resolve(repoRoot), 'repoRoot');
    this.role = role;
    this.operationId = validateOperationId(operationId);
    this.paths = derivedPaths(path.resolve(vaultPath), role, operationId);
    const requiredVault = path.join(this.repoRoot, 'vault', 'secrets.json');
    if (!samePath(this.paths.canonicalPath, requiredVault)) {
      fail('INVALID_CONFIGURATION', 'rotation vault path is not the fixed repo vault');
    }
    this.deps = dependencies || productionDependencies({
      repoRoot: this.repoRoot
    });
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
      fail(
        'INVALID_VAULT_DIRECTORY',
        'vault directory is not a regular directory'
      );
    }
  }

  async _removeIfPresent(target) {
    try {
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
    try {
      const bytes = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8');
      if (bytes.length > MAX_STATE_BYTES) {
        zero(bytes);
        fail('STATE_TOO_LARGE', 'rotation state exceeded its bound');
      }
      try {
        handle = await this.deps.fs.open(temporary, 'wx', 0o600);
        await this.deps.restrictAcl(temporary);
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        zero(bytes);
        if (handle) await handle.close();
      }
      if (createOnly && await this._exists(this.paths.statePath)) {
        fail('ROTATION_ALREADY_EXISTS', 'an active rotation state already exists');
      }
      if (createOnly) {
        await this.deps.fs.copyFile(
          temporary,
          this.paths.statePath,
          fs.constants.COPYFILE_EXCL
        );
        await this._removeIfPresent(temporary);
      } else {
        await this.deps.fs.rename(temporary, this.paths.statePath);
      }
      await this.deps.restrictAcl(this.paths.statePath);
    } finally {
      await this._removeIfPresent(temporary).catch(() => {});
    }
  }

  async _readState() {
    let bytes;
    try {
      await this._assertVaultDirectory();
      await this._assertRegular(this.paths.statePath, 'rotation state');
      const stat = await this.deps.fs.lstat(this.paths.statePath);
      if (stat.size <= 0 || stat.size > MAX_STATE_BYTES) {
        fail('INVALID_STATE', 'rotation state size is invalid');
      }
      bytes = await this.deps.fs.readFile(this.paths.statePath);
      const state = JSON.parse(bytes.toString('utf8'));
      return validateState(state, this.paths, this.role);
    } catch (error) {
      if (error instanceof LinkBusTokenRotationError) throw error;
      fail('INVALID_STATE', 'rotation state could not be read');
    } finally {
      zero(bytes);
    }
  }

  async _updatePhase(state, phase, verification = state.verification) {
    if (!PHASES.includes(phase)) fail('INVALID_PHASE', 'rotation phase is invalid');
    const updated = {
      ...state,
      phase,
      updatedAt: this.deps.now(),
      verification
    };
    await this._writeState(updated);
    return updated;
  }

  async _assertFingerprint(target, expected, label) {
    await this._assertRegular(target, label);
    const actual = await this.deps.fingerprint(target);
    if (actual !== expected) {
      fail('VAULT_FINGERPRINT_MISMATCH', `${label} fingerprint did not match`);
    }
  }

  async prepare(token) {
    validateToken(token);
    const newTokenSha256 = tokenFingerprint(token);
    await this._assertVaultDirectory();
    if (await this._exists(this.paths.statePath)) {
      fail('ROTATION_ALREADY_EXISTS', 'an active rotation state already exists');
    }
    await this._assertRegular(this.paths.canonicalPath, 'canonical vault');
    const oldTokenSha256 = await this.deps.fingerprint(this.paths.canonicalPath);
    validateFingerprint(oldTokenSha256);
    const baseGenerationSha256 = await this.deps.fileDigest(
      this.paths.canonicalPath
    );
    validateFingerprint(baseGenerationSha256);
    if (oldTokenSha256 === newTokenSha256) {
      fail('TOKEN_NOT_ROTATED', 'new token matches the current token');
    }
    const now = this.deps.now();
    let state = {
      schemaVersion: STATE_SCHEMA,
      role: this.role,
      operationId: this.operationId,
      phase: 'preparing',
      canonicalPath: this.paths.canonicalPath,
      candidatePath: this.paths.candidatePath,
      stagedBackupPath: this.paths.stagedBackupPath,
      backupPath: this.paths.backupPath,
      failedNewPath: this.paths.failedNewPath,
      oldTokenSha256,
      newTokenSha256,
      baseGenerationSha256,
      candidateGenerationSha256: null,
      createdAt: now,
      updatedAt: now,
      verification: null
    };
    await this._writeState(state, true);
    try {
      await this.deps.fs.copyFile(
        this.paths.canonicalPath,
        this.paths.stagedBackupPath,
        fs.constants.COPYFILE_EXCL
      );
      await this.deps.restrictAcl(this.paths.stagedBackupPath);
      await this._assertFingerprint(
        this.paths.stagedBackupPath,
        oldTokenSha256,
        'staged old encrypted backup'
      );
      const stagedGeneration = await this.deps.fileDigest(
        this.paths.stagedBackupPath
      );
      if (stagedGeneration !== baseGenerationSha256) {
        fail(
          'VAULT_GENERATION_MISMATCH',
          'staged old backup generation did not match'
        );
      }

      await this.deps.fs.copyFile(
        this.paths.canonicalPath,
        this.paths.candidatePath,
        fs.constants.COPYFILE_EXCL
      );
      await this.deps.restrictAcl(this.paths.candidatePath);
      await this.deps.setToken(this.paths.candidatePath, token);
      await this._assertFingerprint(
        this.paths.candidatePath,
        newTokenSha256,
        'candidate vault'
      );
      const candidateGenerationSha256 = await this.deps.fileDigest(
        this.paths.candidatePath
      );
      validateFingerprint(candidateGenerationSha256);
      state = {
        ...state,
        candidateGenerationSha256
      };
      state = await this._updatePhase(state, 'prepared');
      return safeStateClone(state);
    } catch (error) {
      try {
        state = await this._updatePhase(state, 'prepare_failed');
        await this.rollback();
      } catch {
        throw new LinkBusTokenRotationError(
          'ROLLBACK_INCOMPLETE',
          'rotation preparation failed and local rollback was incomplete',
          { rollbackIncomplete: true }
        );
      }
      if (error instanceof LinkBusTokenRotationError) throw error;
      fail('VAULT_PREPARE_FAILED', 'rotation vault preparation failed');
    }
  }

  async commit() {
    let state = await this._readState();
    if (state.phase === 'committed' || state.phase === 'verified' || state.phase === 'finalized') {
      await this._assertFingerprint(
        this.paths.canonicalPath,
        state.newTokenSha256,
        'committed vault'
      );
      await this._assertFingerprint(
        this.paths.backupPath,
        state.oldTokenSha256,
        'old encrypted backup'
      );
      if (
        await this.deps.fileDigest(this.paths.canonicalPath) !==
          state.candidateGenerationSha256 ||
        await this.deps.fileDigest(this.paths.backupPath) !==
          state.baseGenerationSha256
      ) {
        fail('VAULT_GENERATION_MISMATCH', 'committed vault generation did not match');
      }
      return safeStateClone(state);
    }
    if (state.phase !== 'prepared') {
      fail('INVALID_PHASE', 'rotation vault is not prepared');
    }
    try {
      await this._assertFingerprint(
        this.paths.canonicalPath,
        state.oldTokenSha256,
        'canonical vault'
      );
      await this._assertFingerprint(
        this.paths.stagedBackupPath,
        state.oldTokenSha256,
        'staged old encrypted backup'
      );
      if (
        await this.deps.fileDigest(this.paths.canonicalPath) !==
          state.baseGenerationSha256 ||
        await this.deps.fileDigest(this.paths.stagedBackupPath) !==
          state.baseGenerationSha256
      ) {
        fail('VAULT_GENERATION_CONFLICT', 'canonical vault changed after staging');
      }
      await this._assertFingerprint(
        this.paths.candidatePath,
        state.newTokenSha256,
        'candidate vault'
      );
      if (
        await this.deps.fileDigest(this.paths.candidatePath) !==
        state.candidateGenerationSha256
      ) {
        fail('VAULT_GENERATION_CONFLICT', 'candidate vault changed after staging');
      }
      state = await this._updatePhase(state, 'committing');
      await this.deps.atomicReplace(
        this.paths.candidatePath,
        this.paths.canonicalPath,
        this.paths.backupPath,
        state.baseGenerationSha256
      );
      await this.deps.restrictAcl(this.paths.canonicalPath);
      await this.deps.restrictAcl(this.paths.backupPath);
      await this._assertFingerprint(
        this.paths.canonicalPath,
        state.newTokenSha256,
        'committed vault'
      );
      await this._assertFingerprint(
        this.paths.backupPath,
        state.oldTokenSha256,
        'old encrypted backup'
      );
      if (
        await this.deps.fileDigest(this.paths.canonicalPath) !==
          state.candidateGenerationSha256 ||
        await this.deps.fileDigest(this.paths.backupPath) !==
          state.baseGenerationSha256
      ) {
        fail('VAULT_GENERATION_MISMATCH', 'committed vault generation did not match');
      }
      state = await this._updatePhase(state, 'committed');
      return safeStateClone(state);
    } catch (error) {
      try {
        await this.rollback();
      } catch {
        throw new LinkBusTokenRotationError(
          'ROLLBACK_INCOMPLETE',
          'rotation commit failed and local rollback was incomplete',
          { rollbackIncomplete: true }
        );
      }
      if (error instanceof LinkBusTokenRotationError) throw error;
      fail('VAULT_COMMIT_FAILED', 'rotation vault commit failed');
    }
  }

  async rollback({ allowFinalized = false } = {}) {
    let state = await this._readState();
    if (state.phase === 'finalized' && !allowFinalized) {
      fail('FINALIZED_ROLLBACK_REFUSED', 'finalized rotation rollback requires explicit override');
    }
    if (state.phase === 'rolled_back') {
      await this._assertFingerprint(
        this.paths.canonicalPath,
        state.oldTokenSha256,
        'rolled-back vault'
      );
      return safeStateClone(state);
    }
    state = await this._updatePhase(state, 'rolling_back');
    await this._assertRegular(this.paths.canonicalPath, 'canonical vault');
    const currentFingerprint = await this.deps.fingerprint(
      this.paths.canonicalPath
    );
    const currentGeneration = await this.deps.fileDigest(
      this.paths.canonicalPath
    );
    const authoritativeBackupExists = await this._exists(
      this.paths.backupPath
    );
    if (
      currentFingerprint === state.newTokenSha256 &&
      currentGeneration === state.candidateGenerationSha256
    ) {
      if (!authoritativeBackupExists) {
        fail(
          'ROLLBACK_RECOVERY_REQUIRED',
          'committed generation has no authoritative old backup'
        );
      }
      await this._assertFingerprint(
        this.paths.backupPath,
        state.oldTokenSha256,
        'old encrypted backup'
      );
      if (
        await this.deps.fileDigest(this.paths.backupPath) !==
        state.baseGenerationSha256
      ) {
        fail(
          'ROLLBACK_RECOVERY_REQUIRED',
          'old encrypted backup generation did not match'
        );
      }
      await this._removeIfPresent(this.paths.restorePath);
      await this.deps.fs.copyFile(
        this.paths.backupPath,
        this.paths.restorePath,
        fs.constants.COPYFILE_EXCL
      );
      await this.deps.restrictAcl(this.paths.restorePath);
      await this._assertFingerprint(
        this.paths.restorePath,
        state.oldTokenSha256,
        'rollback candidate'
      );
      if (await this._exists(this.paths.failedNewPath)) {
        fail(
          'ROLLBACK_RECOVERY_REQUIRED',
          'failed-new recovery file already exists'
        );
      }
      await this.deps.atomicReplace(
        this.paths.restorePath,
        this.paths.canonicalPath,
        this.paths.failedNewPath,
        state.candidateGenerationSha256
      );
      await this.deps.restrictAcl(this.paths.canonicalPath);
      await this.deps.restrictAcl(this.paths.failedNewPath);
    } else if (
      currentFingerprint === state.oldTokenSha256 &&
      !authoritativeBackupExists
    ) {
      // No rotation commit occurred.  A concurrent non-token vault update is
      // preserved rather than overwritten by the staged snapshot.
    } else if (
      currentFingerprint === state.oldTokenSha256 &&
      currentGeneration === state.baseGenerationSha256
    ) {
      // The canonical vault is already the exact old generation.
    } else {
      fail(
        'ROLLBACK_RECOVERY_REQUIRED',
        'canonical vault generation cannot be rolled back automatically'
      );
    }
    await this._assertFingerprint(
      this.paths.canonicalPath,
      state.oldTokenSha256,
      'rolled-back vault'
    );
    await this._removeIfPresent(this.paths.candidatePath);
    await this._removeIfPresent(`${this.paths.candidatePath}.lock`);
    await this._removeIfPresent(this.paths.restorePath);
    state = await this._updatePhase(state, 'rolled_back');
    return safeStateClone(state);
  }

  async markVerified(receipt) {
    let state = await this._readState();
    validateVerificationReceipt(
      receipt,
      state.operationId,
      state.newTokenSha256
    );
    if (state.phase === 'verified' || state.phase === 'finalized') {
      if (JSON.stringify(state.verification) !== JSON.stringify(receipt)) {
        fail('VERIFICATION_CONFLICT', 'rotation verification receipt conflicts');
      }
      return safeStateClone(state);
    }
    if (state.phase !== 'committed') {
      fail('INVALID_PHASE', 'only a committed rotation can be verified');
    }
    await this._assertFingerprint(
      this.paths.canonicalPath,
      state.newTokenSha256,
      'verified vault'
    );
    await this._assertFingerprint(
      this.paths.backupPath,
      state.oldTokenSha256,
      'old encrypted backup'
    );
    if (
      await this.deps.fileDigest(this.paths.canonicalPath) !==
        state.candidateGenerationSha256 ||
      await this.deps.fileDigest(this.paths.backupPath) !==
        state.baseGenerationSha256
    ) {
      fail('VAULT_GENERATION_MISMATCH', 'verified vault generation did not match');
    }
    state = await this._updatePhase(state, 'verified', safeStateClone(receipt));
    return safeStateClone(state);
  }

  async finalize() {
    let state = await this._readState();
    if (state.phase === 'finalized') return safeStateClone(state);
    if (state.phase !== 'verified') {
      fail('INVALID_PHASE', 'rotation must be verified before finalization');
    }
    await this._assertFingerprint(
      this.paths.canonicalPath,
      state.newTokenSha256,
      'finalized vault'
    );
    await this._assertFingerprint(
      this.paths.backupPath,
      state.oldTokenSha256,
      'old encrypted backup'
    );
    if (
      await this.deps.fileDigest(this.paths.canonicalPath) !==
        state.candidateGenerationSha256 ||
      await this.deps.fileDigest(this.paths.backupPath) !==
        state.baseGenerationSha256
    ) {
      fail('VAULT_GENERATION_MISMATCH', 'finalized vault generation did not match');
    }
    state = await this._updatePhase(state, 'finalized');
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
      fail('INVALID_STATE', 'rotation state is not a regular bounded file');
    }
    bytes = await fsPromises.readFile(statePath);
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!isPlainRecord(parsed) || parsed.role !== role) {
      fail('INVALID_STATE', 'rotation state identity is invalid');
    }
    validateOperationId(parsed.operationId);
    const transaction = new RotationVaultTransaction({
      repoRoot: resolvedRoot,
      role,
      operationId: parsed.operationId,
      vaultPath,
      dependencies
    });
    await transaction.status();
    return transaction;
  } catch (error) {
    if (error instanceof LinkBusTokenRotationError) throw error;
    fail('INVALID_STATE', 'rotation state could not be opened');
  } finally {
    zero(bytes);
  }
}

module.exports = {
  ACL_SCRIPT,
  PHASES,
  REPLACE_SCRIPT,
  ROLES,
  STATE_SCHEMA,
  RotationVaultTransaction,
  derivedPaths,
  openExistingTransaction,
  productionDependencies,
  statePathFor,
  validateOperationId,
  validateState
};
