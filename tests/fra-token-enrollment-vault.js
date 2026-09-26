'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const {
  TARGET_VAULT_KEY,
  generateToken,
  tokenFingerprint,
  validateToken
} = require('../tools/lib/fra-token-enrollment');
const {
  acquirePowerShellTransactionLock,
  cleanupPowerShellTransactionFence,
  FraTokenVaultTransaction,
  minimalEnvironment,
  openExistingTransaction,
  powerShellPath,
  REPLACE_SCRIPT,
  productionDependencies,
  TRANSACTION_OWNER_FENCE_SCHEMA,
  transactionOwnerFencePathFor
} = require('../tools/lib/fra-token-enrollment-vault');

function generation(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('base64url');
}

async function readVault(target) {
  return JSON.parse(await fsp.readFile(target, 'utf8'));
}

function exactTarget(vault) {
  const aliases = Object.keys(vault).filter(key => (
    key.toLowerCase() === TARGET_VAULT_KEY.toLowerCase()
  ));
  if (aliases.length === 0) return { exists: false, fingerprint: null };
  if (aliases.length !== 1 || aliases[0] !== TARGET_VAULT_KEY) {
    const error = new Error('target key alias');
    error.code = 'KEY_BINDING_MISMATCH';
    throw error;
  }
  validateToken(vault[TARGET_VAULT_KEY]);
  return {
    exists: true,
    fingerprint: tokenFingerprint(vault[TARGET_VAULT_KEY])
  };
}

function makeDependencies() {
  let clock = 1_785_620_000_000;
  let sequence = 0;
  const lockTails = new Map();
  return {
    fs: fsp,
    now: () => ++clock,
    randomId: () => (++sequence).toString(16).padStart(24, '0'),
    async acquireTransactionLock(target) {
      const key = path.resolve(target).toLowerCase();
      const previous = lockTails.get(key) || Promise.resolve();
      let releaseGate;
      const gate = new Promise(resolve => { releaseGate = resolve; });
      const tail = previous.then(() => gate);
      lockTails.set(key, tail);
      await previous;
      let held = true;
      return Object.freeze({
        pid: process.pid,
        assertHeld() {
          if (!held) throw new Error('fake transaction lock lost');
        },
        async release() {
          if (!held) throw new Error('fake transaction lock released twice');
          held = false;
          releaseGate();
          if (lockTails.get(key) === tail) lockTails.delete(key);
        }
      });
    },
    async fileDigest(target) {
      return generation(await fsp.readFile(target));
    },
    async restrictAcl() {},
    async inspect({ path: target }) {
      return exactTarget(await readVault(target));
    },
    async setToken({ path: target, token }) {
      validateToken(token);
      const vault = await readVault(target);
      exactTarget(vault);
      vault[TARGET_VAULT_KEY] = token;
      await fsp.writeFile(target, JSON.stringify(vault), { flag: 'w' });
    },
    async atomicReplace(
      source,
      destination,
      backup,
      expectedDestinationGeneration,
      expectedSourceGeneration
    ) {
      const actual = generation(await fsp.readFile(destination));
      assert.equal(actual, expectedDestinationGeneration, 'fake destination generation fence');
      assert.equal(
        generation(await fsp.readFile(source)),
        expectedSourceGeneration,
        'fake source generation fence'
      );
      await assert.rejects(fsp.lstat(backup), error => error.code === 'ENOENT');
      await fsp.copyFile(destination, backup, fs.constants.COPYFILE_EXCL);
      await fsp.copyFile(source, destination);
      await fsp.unlink(source);
    }
  };
}

async function makeRepo(label, vault) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `fra-enroll-${label}-`));
  await fsp.mkdir(path.join(root, 'vault'));
  await fsp.writeFile(
    path.join(root, 'vault', 'secrets.json'),
    JSON.stringify(vault),
    { flag: 'wx' }
  );
  return root;
}

async function removeRepo(root) {
  const resolved = path.resolve(root);
  const temporary = path.resolve(os.tmpdir());
  assert.ok(resolved.startsWith(`${temporary}${path.sep}`));
  assert.ok(path.basename(resolved).startsWith('fra-enroll-'));
  await fsp.rm(resolved, { recursive: true, force: true });
}

async function expectCode(action, expected) {
  let caught;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${expected}`);
  assert.equal(caught.code, expected);
}

async function absentTargetRoundTrip() {
  const repoRoot = await makeRepo('absent', { ordinary: 'preserved' });
  const dependencies = makeDependencies();
  const token = generateToken(size => Buffer.alloc(size, 0x11));
  const operationId = Buffer.alloc(16, 0x21).toString('base64url');
  try {
    const transaction = new FraTokenVaultTransaction({
      repoRoot,
      role: 'a',
      operationId,
      dependencies
    });
    const prepared = await transaction.prepare(token);
    assert.equal(prepared.phase, 'prepared');
    assert.equal(prepared.previouslyPresent, false);
    assert.equal(prepared.previousFingerprint, null);
    assert.equal(prepared.newFingerprint, tokenFingerprint(token));
    assert.equal(exactTarget(await readVault(prepared.canonicalPath)).exists, false);
    assert.equal(
      exactTarget(await readVault(prepared.candidatePath)).fingerprint,
      tokenFingerprint(token)
    );

    const committed = await transaction.commit();
    assert.equal(committed.phase, 'committed');
    assert.equal(
      exactTarget(await readVault(committed.canonicalPath)).fingerprint,
      tokenFingerprint(token)
    );
    assert.equal(exactTarget(await readVault(committed.backupPath)).exists, false);

    const rolledBack = await transaction.rollback();
    assert.equal(rolledBack.phase, 'rolled_back');
    assert.equal(exactTarget(await readVault(rolledBack.canonicalPath)).exists, false);
    assert.equal((await readVault(rolledBack.canonicalPath)).ordinary, 'preserved');

    const reopened = await openExistingTransaction({
      repoRoot,
      role: 'a',
      dependencies
    });
    assert.equal((await reopened.status()).phase, 'rolled_back');
  } finally {
    await removeRepo(repoRoot);
  }
}

async function presentTargetRoundTrip() {
  const oldToken = generateToken(size => Buffer.alloc(size, 0x31));
  const newToken = generateToken(size => Buffer.alloc(size, 0x41));
  const repoRoot = await makeRepo('present', {
    ordinary: 'preserved',
    [TARGET_VAULT_KEY]: oldToken
  });
  const dependencies = makeDependencies();
  const operationId = Buffer.alloc(16, 0x22).toString('base64url');
  try {
    const transaction = new FraTokenVaultTransaction({
      repoRoot,
      role: 'b',
      operationId,
      dependencies
    });
    const prepared = await transaction.prepare(newToken);
    assert.equal(prepared.previouslyPresent, true);
    assert.equal(prepared.previousFingerprint, tokenFingerprint(oldToken));
    await transaction.commit();
    assert.equal(
      exactTarget(await readVault(prepared.canonicalPath)).fingerprint,
      tokenFingerprint(newToken)
    );
    await transaction.rollback();
    assert.equal(
      exactTarget(await readVault(prepared.canonicalPath)).fingerprint,
      tokenFingerprint(oldToken)
    );
  } finally {
    await removeRepo(repoRoot);
  }
}

async function stateUpdatesDoNotReapplyAclAfterRestrictedRename() {
  const oldToken = generateToken(size => Buffer.alloc(size, 0x39));
  const newToken = generateToken(size => Buffer.alloc(size, 0x49));
  const repoRoot = await makeRepo('state-acl-rename', {
    ordinary: 'preserved',
    [TARGET_VAULT_KEY]: oldToken
  });
  const dependencies = makeDependencies();
  const operationId = Buffer.alloc(16, 0x29).toString('base64url');
  const transaction = new FraTokenVaultTransaction({
    repoRoot,
    role: 'a',
    operationId,
    dependencies
  });
  let destinationAclCalls = 0;
  dependencies.restrictAcl = async target => {
    if (path.resolve(target).toLowerCase() === transaction.paths.statePath.toLowerCase()) {
      destinationAclCalls += 1;
      if (destinationAclCalls > 1) {
        throw Object.assign(new Error('redundant destination ACL application'), {
          code: 'REDUNDANT_STATE_ACL_APPLICATION'
        });
      }
    }
  };
  try {
    const prepared = await transaction.prepare(newToken);
    assert.equal(prepared.phase, 'prepared');
    const rolledBack = await transaction.rollback();
    assert.equal(rolledBack.phase, 'rolled_back');
    assert.equal(destinationAclCalls, 1,
      'only create-only copy requires a destination ACL application');
    await transaction.retireRolledBackRecovery();
  } finally {
    await removeRepo(repoRoot);
  }
}

async function terminalStateCanBeRetiredForLaterRotation() {
  const originalToken = generateToken(size => Buffer.alloc(size, 0x42));
  const firstToken = generateToken(size => Buffer.alloc(size, 0x43));
  const secondToken = generateToken(size => Buffer.alloc(size, 0x44));
  const thirdToken = generateToken(size => Buffer.alloc(size, 0x45));
  const repoRoot = await makeRepo('repeat', {
    ordinary: 'preserved',
    [TARGET_VAULT_KEY]: originalToken
  });
  const dependencies = makeDependencies();
  let secondBaseBytes;
  try {
    const first = new FraTokenVaultTransaction({
      repoRoot,
      role: 'a',
      operationId: Buffer.alloc(16, 0x32).toString('base64url'),
      dependencies
    });
    const firstPrepared = await first.prepare(firstToken);
    await expectCode(() => first.retireRolledBackRecovery(), 'RECOVERY_RETIREMENT_PHASE_INVALID');
    const activeConflict = new FraTokenVaultTransaction({
      repoRoot,
      role: 'a',
      operationId: Buffer.alloc(16, 0x33).toString('base64url'),
      dependencies
    });
    await expectCode(() => activeConflict.prepare(secondToken), 'ENROLLMENT_ALREADY_EXISTS');
    await first.commit();
    assert.equal(await first._exists(firstPrepared.backupPath), true);

    const second = new FraTokenVaultTransaction({
      repoRoot,
      role: 'a',
      operationId: Buffer.alloc(16, 0x34).toString('base64url'),
      dependencies
    });
    await expectCode(() => second.prepare(secondToken), 'PRIOR_FINALIZATION_REQUIRED');
    const fence = Buffer.alloc(32, 0x61).toString('base64url');
    const localReceiptDigest = Buffer.alloc(32, 0x62).toString('base64url');
    const peerReceiptDigest = Buffer.alloc(32, 0x63).toString('base64url');
    await first.prepareFinalize({ fence, localReceiptDigest });
    await expectCode(() => first.rollback(), 'FINALIZATION_FENCED');
    await expectCode(() => first.finalize({ fence }), 'FINALIZATION_FENCE_REQUIRED');
    await first.confirmPeerFinalize({ fence, peerReceiptDigest });
    await expectCode(() => second.prepare(secondToken), 'PRIOR_FINALIZATION_REQUIRED');
    await first.finalize({ fence });
    secondBaseBytes = await fsp.readFile(first.paths.canonicalPath);
    const secondPrepared = await second.prepare(secondToken);
    assert.equal(secondPrepared.phase, 'prepared');
    assert.equal(secondPrepared.previousFingerprint, tokenFingerprint(firstToken));
    assert.equal(await second._exists(firstPrepared.backupPath), false);
    assert.equal(JSON.parse(await fsp.readFile(second.paths.statePath, 'utf8')).operationId,
      second.operationId);
    await second.rollback();

    const third = new FraTokenVaultTransaction({
      repoRoot,
      role: 'a',
      operationId: Buffer.alloc(16, 0x35).toString('base64url'),
      dependencies
    });
    await expectCode(() => third.prepare(thirdToken), 'PRIOR_RECOVERY_REVIEW_REQUIRED');
    const changed = await readVault(second.paths.canonicalPath);
    changed.ordinary = 'changed-after-rollback';
    await fsp.writeFile(second.paths.canonicalPath, JSON.stringify(changed));
    await expectCode(() => second.retireRolledBackRecovery(), 'VAULT_GENERATION_CONFLICT');
    assert.equal(await second._exists(second.paths.statePath), true,
      'generation mismatch preserves recovery evidence');
    await fsp.writeFile(second.paths.canonicalPath, secondBaseBytes);
    const originalFileDigest = dependencies.fileDigest;
    let raced = false;
    dependencies.fileDigest = async file => {
      const digest = await originalFileDigest(file);
      if (!raced && file === second.paths.canonicalPath) {
        raced = true;
        const concurrent = await readVault(file);
        concurrent.ordinary = 'changed-between-retirement-checks';
        await fsp.writeFile(file, JSON.stringify(concurrent));
      }
      return digest;
    };
    await expectCode(() => second.retireRolledBackRecovery(), 'VAULT_GENERATION_CONFLICT');
    assert.equal(raced, true);
    assert.equal(await second._exists(second.paths.statePath), true,
      'a generation race preserves recovery evidence');
    dependencies.fileDigest = originalFileDigest;
    await fsp.writeFile(second.paths.canonicalPath, secondBaseBytes);
    const retired = await second.retireRolledBackRecovery();
    assert.equal(retired.phase, 'rolled_back');
    assert.equal(await second._exists(second.paths.statePath), false);
    assert.equal(await second._exists(second.paths.stagedBackupPath), false);
    assert.equal(await second._exists(second.paths.candidatePath), false);
    const thirdPrepared = await third.prepare(thirdToken);
    assert.equal(thirdPrepared.phase, 'prepared');
    await third.rollback();
    await third.retireRolledBackRecovery();
  } finally {
    if (secondBaseBytes) secondBaseBytes.fill(0);
    await removeRepo(repoRoot);
  }
}

async function lifecycleMutationsShareOneTransactionLock() {
  const originalToken = generateToken(size => Buffer.alloc(size, 0x46));
  const firstToken = generateToken(size => Buffer.alloc(size, 0x47));
  const secondToken = generateToken(size => Buffer.alloc(size, 0x48));
  const repoRoot = await makeRepo('transaction-lock', {
    ordinary: 'preserved',
    [TARGET_VAULT_KEY]: originalToken
  });
  const dependencies = makeDependencies();
  const originalSetToken = dependencies.setToken;
  let enteredResolve;
  let releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  dependencies.setToken = async options => {
    enteredResolve();
    await release;
    return originalSetToken(options);
  };
  const first = new FraTokenVaultTransaction({
    repoRoot,
    role: 'a',
    operationId: Buffer.alloc(16, 0x36).toString('base64url'),
    dependencies
  });
  const second = new FraTokenVaultTransaction({
    repoRoot,
    role: 'a',
    operationId: Buffer.alloc(16, 0x37).toString('base64url'),
    dependencies
  });
  try {
    const preparing = first.prepare(firstToken);
    await entered;
    let secondSettled = false;
    const secondPreparing = second.prepare(secondToken).finally(() => { secondSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(secondSettled, false, 'a second process-equivalent mutation waits for the OS lock');
    releaseResolve();
    await preparing;
    await expectCode(() => secondPreparing, 'ENROLLMENT_ALREADY_EXISTS');
    await first.rollback();
    assert.equal(await first._exists(first.paths.transactionLockPath), false);
  } finally {
    releaseResolve();
    await removeRepo(repoRoot);
  }
}

async function finalizePreservesUnrelatedCredentialUpdates() {
  const originalToken = generateToken(size => Buffer.alloc(size, 0x49));
  const newToken = generateToken(size => Buffer.alloc(size, 0x4a));
  const repoRoot = await makeRepo('finalize-unrelated', {
    ordinary: 'before',
    [TARGET_VAULT_KEY]: originalToken
  });
  const transaction = new FraTokenVaultTransaction({
    repoRoot,
    role: 'a',
    operationId: Buffer.alloc(16, 0x38).toString('base64url'),
    dependencies: makeDependencies()
  });
  try {
    await transaction.prepare(newToken);
    await transaction.commit();
    const concurrent = await readVault(transaction.paths.canonicalPath);
    concurrent.ordinary = 'updated-after-commit';
    concurrent.unrelatedCredential = 'opaque-other-value';
    await fsp.writeFile(transaction.paths.canonicalPath, JSON.stringify(concurrent));
    const replayed = await transaction.commit();
    assert.equal(replayed.phase, 'committed');
    const firstFence = Buffer.alloc(32, 0x71).toString('base64url');
    await transaction.prepareFinalize({ fence: firstFence, localReceiptDigest: Buffer.alloc(32, 0x72).toString('base64url') });
    await transaction.confirmPeerFinalize({ fence: firstFence, peerReceiptDigest: Buffer.alloc(32, 0x73).toString('base64url') });
    await transaction.finalize({ fence: firstFence });
    const retained = await readVault(transaction.paths.canonicalPath);
    assert.equal(retained.ordinary, 'updated-after-commit');
    assert.equal(retained.unrelatedCredential, 'opaque-other-value');
    assert.equal(exactTarget(retained).fingerprint, tokenFingerprint(newToken));
    assert.equal(await transaction._exists(transaction.paths.statePath), false);

    const nextToken = generateToken(size => Buffer.alloc(size, 0x4b));
    const next = new FraTokenVaultTransaction({
      repoRoot,
      role: 'a',
      operationId: Buffer.alloc(16, 0x39).toString('base64url'),
      dependencies: transaction.deps
    });
    await next.prepare(nextToken);
    await next.commit();
    const nextFence = Buffer.alloc(32, 0x74).toString('base64url');
    await next.prepareFinalize({ fence: nextFence, localReceiptDigest: Buffer.alloc(32, 0x75).toString('base64url') });
    await next.confirmPeerFinalize({ fence: nextFence, peerReceiptDigest: Buffer.alloc(32, 0x76).toString('base64url') });
    await next.finalize({ fence: nextFence });
    const rotated = await readVault(next.paths.canonicalPath);
    assert.equal(rotated.unrelatedCredential, 'opaque-other-value');
    assert.equal(exactTarget(rotated).fingerprint, tokenFingerprint(nextToken));
  } finally {
    await removeRepo(repoRoot);
  }
}

async function finalizeRejectsTargetCredentialChange() {
  const originalToken = generateToken(size => Buffer.alloc(size, 0x4c));
  const newToken = generateToken(size => Buffer.alloc(size, 0x4d));
  const unexpectedToken = generateToken(size => Buffer.alloc(size, 0x4e));
  const repoRoot = await makeRepo('finalize-target-change', {
    ordinary: 'preserved',
    [TARGET_VAULT_KEY]: originalToken
  });
  const transaction = new FraTokenVaultTransaction({
    repoRoot,
    role: 'a',
    operationId: Buffer.alloc(16, 0x3a).toString('base64url'),
    dependencies: makeDependencies()
  });
  try {
    await transaction.prepare(newToken);
    await transaction.commit();
    const fence = Buffer.alloc(32, 0x77).toString('base64url');
    await transaction.prepareFinalize({ fence, localReceiptDigest: Buffer.alloc(32, 0x78).toString('base64url') });
    await transaction.confirmPeerFinalize({ fence, peerReceiptDigest: Buffer.alloc(32, 0x79).toString('base64url') });
    const changed = await readVault(transaction.paths.canonicalPath);
    changed[TARGET_VAULT_KEY] = unexpectedToken;
    await fsp.writeFile(transaction.paths.canonicalPath, JSON.stringify(changed));
    await expectCode(() => transaction.commit(), 'VAULT_FINGERPRINT_MISMATCH');
    await expectCode(() => transaction.finalize({ fence }), 'VAULT_FINGERPRINT_MISMATCH');
    assert.equal(
      exactTarget(await readVault(transaction.paths.canonicalPath)).fingerprint,
      tokenFingerprint(unexpectedToken),
      'a rejected finalize must not overwrite the unexpected target credential'
    );
  } finally {
    await removeRepo(repoRoot);
  }
}

async function concurrentChangeRollsBackWithoutClobbering() {
  const oldToken = generateToken(size => Buffer.alloc(size, 0x51));
  const newToken = generateToken(size => Buffer.alloc(size, 0x61));
  const repoRoot = await makeRepo('concurrent', {
    ordinary: 'before',
    [TARGET_VAULT_KEY]: oldToken
  });
  const dependencies = makeDependencies();
  const operationId = Buffer.alloc(16, 0x23).toString('base64url');
  try {
    const transaction = new FraTokenVaultTransaction({
      repoRoot,
      role: 'a',
      operationId,
      dependencies
    });
    const prepared = await transaction.prepare(newToken);
    const concurrent = await readVault(prepared.canonicalPath);
    concurrent.ordinary = 'concurrent-update';
    await fsp.writeFile(prepared.canonicalPath, JSON.stringify(concurrent));
    await expectCode(() => transaction.commit(), 'VAULT_GENERATION_CONFLICT');
    const current = await readVault(prepared.canonicalPath);
    assert.equal(current.ordinary, 'concurrent-update');
    assert.equal(exactTarget(current).fingerprint, tokenFingerprint(oldToken));
    assert.equal((await transaction.status()).phase, 'rolled_back');
  } finally {
    await removeRepo(repoRoot);
  }
}

async function keyAndStateConfusionAreRejected() {
  const token = generateToken(size => Buffer.alloc(size, 0x71));
  const wrongCase = 'Custom.full_remote_access_token';
  const aliasRoot = await makeRepo('alias', { [wrongCase]: token });
  const dependencies = makeDependencies();
  try {
    const transaction = new FraTokenVaultTransaction({
      repoRoot: aliasRoot,
      role: 'a',
      operationId: Buffer.alloc(16, 0x24).toString('base64url'),
      dependencies
    });
    await expectCode(() => transaction.prepare(
      generateToken(size => Buffer.alloc(size, 0x72))
    ), 'KEY_BINDING_MISMATCH');
  } finally {
    await removeRepo(aliasRoot);
  }

  const stateRoot = await makeRepo('state-confusion', { ordinary: 'x' });
  try {
    const transaction = new FraTokenVaultTransaction({
      repoRoot: stateRoot,
      role: 'a',
      operationId: Buffer.alloc(16, 0x25).toString('base64url'),
      dependencies: makeDependencies()
    });
    const prepared = await transaction.prepare(
      generateToken(size => Buffer.alloc(size, 0x73))
    );
    const state = JSON.parse(await fsp.readFile(transaction.paths.statePath, 'utf8'));
    state.targetKey = 'custom.remote_agent_bridge_token';
    await fsp.writeFile(transaction.paths.statePath, JSON.stringify(state));
    await expectCode(() => transaction.status(), 'KEY_BINDING_MISMATCH');
  } finally {
    await removeRepo(stateRoot);
  }
}

async function unchangedTokenIsRejected() {
  const token = generateToken(size => Buffer.alloc(size, 0x7a));
  const repoRoot = await makeRepo('same', { [TARGET_VAULT_KEY]: token });
  try {
    const transaction = new FraTokenVaultTransaction({
      repoRoot,
      role: 'a',
      operationId: Buffer.alloc(16, 0x26).toString('base64url'),
      dependencies: makeDependencies()
    });
    await expectCode(() => transaction.prepare(token), 'TOKEN_NOT_ROTATED');
  } finally {
    await removeRepo(repoRoot);
  }
}

async function bindFreshFixtureOwner(repoRoot, target) {
    // Elevated Windows creation can assign BUILTIN Administrators as owner,
    // not the current user. Production correctly refuses that foreign-owner
    // descriptor. Bind only this freshly created synthetic file's Owner
    // section; do not relax the production check or alter any Access/DACL
    // bits. The real restriction below must still remove inherited access.
    const resolvedRoot = await fsp.realpath(repoRoot);
    assert.equal(resolvedRoot, path.resolve(repoRoot));
    assert.ok(resolvedRoot.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(resolvedRoot).startsWith('fra-enroll-'));
    assert.equal(await fsp.realpath(path.join(repoRoot, 'vault')), path.join(resolvedRoot, 'vault'));
    assert.equal((await fsp.lstat(target)).isFile(), true);
    assert.equal((await fsp.lstat(target)).isSymbolicLink(), false);
    assert.equal(path.dirname(target), path.join(repoRoot, 'vault'));
    const provision = spawnSync(powerShellPath(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& {
$ErrorActionPreference='Stop'
$target=[IO.Path]::GetFullPath($args[0])
$item=Get-Item -LiteralPath $target -Force
if($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)){throw 'fixture target is not regular'}
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
$access=[Security.AccessControl.AccessControlSections]::Access
$before=[IO.File]::GetAccessControl($target,$access).GetSecurityDescriptorSddlForm($access)
$acl=[IO.File]::GetAccessControl($target,[Security.AccessControl.AccessControlSections]::Owner)
$acl.SetOwner($owner)
[IO.File]::SetAccessControl($target,$acl)
$actual=[IO.File]::GetAccessControl($target)
[ordered]@{
  ownerMatches=($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $owner.Value)
  accessUnchanged=($actual.GetSecurityDescriptorSddlForm($access) -ceq $before)
  protected=$actual.AreAccessRulesProtected
}|ConvertTo-Json -Compress
}`, target
    ], { cwd: repoRoot, env: minimalEnvironment(), encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000 });
    assert.equal(provision.error, undefined);
    assert.equal(provision.status, 0, provision.stderr);
    assert.deepEqual(JSON.parse(provision.stdout), { ownerMatches: true, accessUnchanged: true, protected: false },
      'fixture ownership binding must leave the inherited DACL untouched for the actual restriction to exercise');
}

async function productionAclRestrictionIsIdempotent() {
  if (process.platform !== 'win32') {
    console.log('SKIP fra-token-enrollment-vault: idempotent production ACL restriction (Windows-only check)');
    return;
  }
  const repoRoot = await makeRepo('production-acl-idempotent', { ordinary: 'preserved' });
  const target = path.join(repoRoot, 'vault', 'secrets.json');
  const dependencies = productionDependencies({ repoRoot });
  try {
    await bindFreshFixtureOwner(repoRoot, target);
    await dependencies.restrictAcl(target);
    // The private vault helper preserves the already-restricted descriptor
    // when it atomically replaces a candidate. A second restriction must be a
    // verified no-op for the normal installed user; blindly calling Set-Acl a
    // second time requires SeSecurityPrivilege and breaks every rotation.
    await dependencies.restrictAcl(target);
    assert.equal((await readVault(target)).ordinary, 'preserved');
    const inspected = spawnSync(powerShellPath(), [
      '-NoProfile', '-NonInteractive', '-Command', `& {
$ErrorActionPreference='Stop'
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[IO.File]::GetAccessControl([IO.Path]::GetFullPath($args[0]))
[ordered]@{
  ownerMatches=($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ceq $owner.Value)
  protected=$acl.AreAccessRulesProtected
  rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object {
    [ordered]@{subject=$(if($_.IdentityReference.Value -ceq $owner.Value){'owner'}else{$_.IdentityReference.Value});rights=$_.FileSystemRights.ToString();kind=$_.AccessControlType.ToString();inherited=$_.IsInherited}
  })
}|ConvertTo-Json -Compress -Depth 4
}`, target
    ], { cwd: repoRoot, env: minimalEnvironment(), encoding: 'utf8', windowsHide: true, shell: false, timeout: 10_000 });
    assert.equal(inspected.error, undefined);
    assert.equal(inspected.status, 0, inspected.stderr);
    const descriptor = JSON.parse(inspected.stdout);
    assert.equal(descriptor.ownerMatches, true);
    assert.equal(descriptor.protected, true);
    assert.deepEqual(descriptor.rules.sort((a, b) => a.subject.localeCompare(b.subject)), [
      { subject: 'owner', rights: 'FullControl', kind: 'Allow', inherited: false },
      { subject: 'S-1-5-18', rights: 'FullControl', kind: 'Allow', inherited: false }
    ], 'the actual production restriction must leave only owner and SYSTEM with full control');
  } finally {
    await removeRepo(repoRoot);
  }
}

async function productionReplacementHoldsTheGenerationHandle() {
  if (process.platform !== 'win32') {
    console.log('SKIP fra-token-enrollment-vault: held-generation File.Replace sharing contract requires native Windows');
    return;
  }
  const repoRoot = await makeRepo('production-replace', { ordinary: 'first' });
  const destination = path.join(repoRoot, 'vault', 'secrets.json');
  const firstSource = path.join(repoRoot, 'vault', '.first-source');
  const firstBackup = path.join(repoRoot, 'vault', '.first-backup');
  const secondSource = path.join(repoRoot, 'vault', '.second-source');
  const secondBackup = path.join(repoRoot, 'vault', '.second-backup');
  const dependencies = productionDependencies({ repoRoot });
  let writer;
  try {
    const firstGeneration = generation(await fsp.readFile(destination));
    await fsp.writeFile(firstSource, JSON.stringify({ ordinary: 'second' }), { flag: 'wx' });
    const firstSourceGeneration = generation(await fsp.readFile(firstSource));
    await dependencies.atomicReplace(
      firstSource,
      destination,
      firstBackup,
      firstGeneration,
      firstSourceGeneration
    );
    assert.equal((await readVault(destination)).ordinary, 'second');
    assert.equal((await readVault(firstBackup)).ordinary, 'first');

    const secondGeneration = generation(await fsp.readFile(destination));
    await fsp.writeFile(secondSource, JSON.stringify({ ordinary: 'third' }), { flag: 'wx' });
    const secondSourceGeneration = generation(await fsp.readFile(secondSource));
    writer = await fsp.open(destination, 'r+');
    await assert.rejects(
      dependencies.atomicReplace(
        secondSource,
        destination,
        secondBackup,
        secondGeneration,
        secondSourceGeneration
      ),
      'replacement must fail closed while a non-cooperating write handle exists'
    );
    assert.equal((await readVault(destination)).ordinary, 'second');
    assert.equal(await fsp.readFile(secondSource, 'utf8'), JSON.stringify({ ordinary: 'third' }));
    await writer.close();
    writer = null;
    await dependencies.atomicReplace(
      secondSource,
      destination,
      secondBackup,
      secondGeneration,
      secondSourceGeneration
    );
    assert.equal((await readVault(destination)).ordinary, 'third');
    assert.equal((await readVault(secondBackup)).ordinary, 'second');
  } finally {
    if (writer) await writer.close().catch(() => {});
    await removeRepo(repoRoot);
  }
}

async function productionReplacementCompensatesPathSwap() {
  if (process.platform !== 'win32') {
    console.log('SKIP fra-token-enrollment-vault: production replacement path-swap compensation (Windows-only check)');
    return;
  }
  const repoRoot = await makeRepo('production-path-swap', { ordinary: 'first' });
  const destination = path.join(repoRoot, 'vault', 'secrets.json');
  const source = path.join(repoRoot, 'vault', '.candidate');
  const backup = path.join(repoRoot, 'vault', '.backup');
  const attacker = `${destination}.attacker`;
  const attackerDisplaced = `${destination}.attacker-displaced`;
  const marker = '  # TEST-SEAM: the source and destination generations are pinned.';
  const injection = [
    marker,
    '  $attacker=$destination + ".attacker"',
    '  $attackerDisplaced=$destination + ".attacker-displaced"',
    '  [IO.File]::Replace($attacker,$destination,$attackerDisplaced,$true)'
  ].join('\n');
  const faultScript = REPLACE_SCRIPT.replace(marker, injection);
  assert.notEqual(faultScript, REPLACE_SCRIPT, 'the pathname-swap fault seam must remain pinned');
  let result;
  try {
    const originalBytes = await fsp.readFile(destination);
    await fsp.writeFile(source, JSON.stringify({ ordinary: 'candidate' }), { flag: 'wx' });
    await fsp.writeFile(attacker, JSON.stringify({ ordinary: 'attacker' }), { flag: 'wx' });
    const expectedGeneration = generation(originalBytes);
    const expectedSourceGeneration = generation(await fsp.readFile(source));
    originalBytes.fill(0);
    result = spawnSync(powerShellPath(), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', `& {\n${faultScript}\n}`,
      source, destination, backup, expectedGeneration, expectedSourceGeneration
    ], {
      cwd: repoRoot,
      env: minimalEnvironment(),
      windowsHide: true,
      shell: false,
      maxBuffer: 1024,
      timeout: 60 * 1000
    });
    assert.equal(result.error, undefined);
    assert.equal(Buffer.isBuffer(result.stdout), true);
    assert.equal(Buffer.isBuffer(result.stderr), true);
    assert.equal(result.stdout.length, 0, 'the private replacement helper must emit no stdout');
    assert.notEqual(result.status, 0, 'the detected pathname swap must make replacement fail closed');
    assert.match(
      result.stderr.toString('utf8'),
      /vault generation conflict/,
      'replacement must fail because it detected its own generation conflict'
    );
    assert.equal((await readVault(destination)).ordinary, 'attacker',
      'inverse compensation restores the concurrent writer at the destination');
    assert.equal((await readVault(source)).ordinary, 'candidate',
      'inverse compensation restores the candidate at its source path');
    assert.equal(await fsp.stat(backup).then(() => true, error => error.code !== 'ENOENT'), false,
      'inverse compensation consumes the unexpected backup path');
    assert.equal((await readVault(attackerDisplaced)).ordinary, 'first',
      'the injected competing replacement preserves the displaced original generation');
  } finally {
    if (result) {
      if (Buffer.isBuffer(result.stdout)) result.stdout.fill(0);
      if (Buffer.isBuffer(result.stderr)) result.stderr.fill(0);
    }
    await removeRepo(repoRoot);
  }
}

async function writeProductionOwnerFence(repoRoot, lockPath, content) {
  const fencePath = transactionOwnerFencePathFor(lockPath);
  await fsp.writeFile(fencePath, content, { flag: 'wx' });
  await bindFreshFixtureOwner(repoRoot, fencePath);
  await productionDependencies({ repoRoot }).restrictAcl(fencePath);
  return fencePath;
}

function preAcknowledgementHelper(mode) {
  const child = new EventEmitter();
  child.pid = mode === 'graceful' ? 41001 : 41002;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let closed = false;
  let frame = 0;
  const close = (code, signal) => {
    if (closed) return;
    closed = true;
    child.emit('close', code, signal);
  };
  child.kill = () => {
    setImmediate(() => close(null, 'SIGTERM'));
    return true;
  };
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      frame += 1;
      if (frame === 1) {
        assert.equal(chunk.length, 36);
        callback();
        setImmediate(() => child.stdout.write(Buffer.from([0xa5])));
        return;
      }
      assert.equal(frame, 2);
      assert.deepEqual([...chunk], [0x69]);
      if (mode === 'violent') {
        close(null, 'SIGKILL');
        callback();
      } else {
        callback();
        setImmediate(() => close(0, null));
      }
    }
  });
  return child;
}

async function preAcknowledgementFailureCleansMatchingFence() {
  if (process.platform !== 'win32') {
    console.log('SKIP fra-token-enrollment-vault: pre-acknowledgement fence cleanup (Windows-only check)');
    return;
  }
  const repoRoot = await makeRepo('pre-ack-cleanup', { ordinary: 'preserved' });
  const lockPath = path.join(repoRoot, 'vault', '.fra-enrollment-transaction.lock');
  const unhandled = [];
  const onUnhandled = reason => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const mode of ['graceful', 'violent']) {
      let cleanupCalls = 0;
      await assert.rejects(
        acquirePowerShellTransactionLock({
          lockPath,
          repoRoot,
          spawnImpl: () => preAcknowledgementHelper(mode),
          cleanupImpl: async options => {
            cleanupCalls += 1;
            assert.equal(options.lockPath, path.resolve(lockPath));
            assert.equal(Buffer.isBuffer(options.ownerNonce), true);
            assert.equal(options.ownerNonce.length, 32);
          },
          startTimeoutMs: 2000,
          releaseTimeoutMs: 1000
        }),
        error => error && ['TRANSACTION_LOCK_START_FAILED', 'TRANSACTION_LOCK_LOST'].includes(error.code)
      );
      assert.equal(cleanupCalls, 1,
        `${mode} helper death before ACKED must retire only its matching bootstrap fence`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(unhandled, [], 'pre-ACK failure cleanup must not create unhandled rejections');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    await removeRepo(repoRoot);
  }
}

async function productionDeadNodeOwnerIsReclaimed() {
  if (process.platform !== 'win32') {
    console.log('SKIP fra-token-enrollment-vault: dead Node owner reclamation (Windows-only check)');
    return;
  }
  const repoRoot = await makeRepo('production-dead-node-owner', { ordinary: 'preserved' });
  const lockPath = path.join(repoRoot, 'vault', '.fra-enrollment-transaction.lock');
  const modulePath = require.resolve('../tools/lib/fra-token-enrollment-vault');
  const childSource = [
    `'use strict';`,
    `const { acquirePowerShellTransactionLock } = require(${JSON.stringify(modulePath)});`,
    `(async()=>{await acquirePowerShellTransactionLock({lockPath:${JSON.stringify(lockPath)},repoRoot:${JSON.stringify(repoRoot)}});process.stdout.write(Buffer.from([0xa5]));await new Promise(()=>{});})().catch(()=>process.exit(23));`
  ].join('');
  const child = spawn(process.execPath, ['-e', childSource], {
    cwd: repoRoot,
    env: minimalEnvironment(),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let successor;
  let stderrBytes = 0;
  const childClosed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  child.stderr.on('data', chunk => {
    stderrBytes += chunk.length;
    chunk.fill(0);
  });
  try {
    await new Promise((resolve, reject) => {
      let ready = false;
      const timeout = setTimeout(() => reject(new Error('dead-owner fixture readiness timeout')), 20_000);
      child.once('error', reject);
      childClosed.then(({ code }) => {
        if (!ready) reject(new Error(`dead-owner fixture exited before readiness: ${code}`));
      });
      child.stdout.once('data', chunk => {
        try {
          assert.equal(chunk.length, 1);
          assert.equal(chunk[0], 0xa5);
          ready = true;
          clearTimeout(timeout);
          resolve();
        } finally { chunk.fill(0); }
      });
    });
    assert.equal(stderrBytes, 0);
    child.kill();
    await childClosed;
    successor = await acquirePowerShellTransactionLock({ lockPath, repoRoot });
    successor.assertHeld();
    await successor.release();
    successor = null;
    assert.equal(await fsp.stat(transactionOwnerFencePathFor(lockPath))
      .then(() => true, error => error.code !== 'ENOENT'), false,
    'a successor reclaims a fence after the owning Node process dies');
  } finally {
    try { child.kill(); } catch {}
    await Promise.race([
      childClosed,
      new Promise(resolve => setTimeout(resolve, 5000))
    ]);
    if (successor) await successor.release().catch(() => {});
    await removeRepo(repoRoot);
  }
}

async function productionOwnerFenceRecoveryAndInvalidState() {
  if (process.platform !== 'win32') {
    console.log('SKIP fra-token-enrollment-vault: owner-fence recovery and invalid-state handling (Windows-only check)');
    return;
  }
  const repoRoot = await makeRepo('production-owner-fence-state', { ordinary: 'preserved' });
  const lockPath = path.join(repoRoot, 'vault', '.fra-enrollment-transaction.lock');
  const nonce = Buffer.alloc(32, 0x7c).toString('base64url');
  let lease;
  try {
    const currentPidReused = {
      schemaVersion: TRANSACTION_OWNER_FENCE_SCHEMA,
      nonce,
      pid: process.pid,
      startFileTimeUtc: '1'
    };
    await writeProductionOwnerFence(repoRoot, lockPath, JSON.stringify(currentPidReused));
    lease = await acquirePowerShellTransactionLock({ lockPath, repoRoot });
    lease.assertHeld();
    const successorFence = await fsp.readFile(lease.ownerFencePath, 'utf8');
    await lease.release();
    lease = null;
    assert.equal(await fsp.stat(transactionOwnerFencePathFor(lockPath))
      .then(() => true, error => error.code !== 'ENOENT'), false,
    'a PID-reuse/reboot-equivalent fence is reclaimed by process-start identity');

    const missingOwner = {
      schemaVersion: TRANSACTION_OWNER_FENCE_SCHEMA,
      nonce,
      pid: 2147483646,
      startFileTimeUtc: '1'
    };
    await writeProductionOwnerFence(repoRoot, lockPath, JSON.stringify(missingOwner));
    lease = await acquirePowerShellTransactionLock({ lockPath, repoRoot });
    await lease.release();
    lease = null;

    const successorFencePath = await writeProductionOwnerFence(repoRoot, lockPath, successorFence);
    await cleanupPowerShellTransactionFence({
      lockPath,
      repoRoot,
      ownerNonce: Buffer.alloc(32, 0x7d)
    });
    assert.equal(await fsp.readFile(successorFencePath, 'utf8'), successorFence,
      'cleanup for an old nonce must not remove a successor owner fence');
    await fsp.unlink(successorFencePath);

    const malformedPath = await writeProductionOwnerFence(repoRoot, lockPath, '{"schemaVersion":"invalid"}');
    await assert.rejects(
      acquirePowerShellTransactionLock({ lockPath, repoRoot }),
      error => error && error.code === 'TRANSACTION_LOCK_INVALID'
    );
    assert.equal(await fsp.readFile(malformedPath, 'utf8'), '{"schemaVersion":"invalid"}',
      'a malformed owner fence fails closed and is not deleted');
    await fsp.unlink(malformedPath);

    const oversizedPath = await writeProductionOwnerFence(repoRoot, lockPath, Buffer.alloc(1025, 0x41));
    await assert.rejects(
      acquirePowerShellTransactionLock({ lockPath, repoRoot }),
      error => error && error.code === 'TRANSACTION_LOCK_INVALID'
    );
    assert.equal((await fsp.stat(oversizedPath)).size, 1025,
      'an oversized owner fence fails closed and is not deleted');
  } finally {
    if (lease) await lease.release().catch(() => {});
    await removeRepo(repoRoot);
  }
}

async function productionHolderDeathDoesNotOverlapLifecycleCallback() {
  if (process.platform !== 'win32') {
    console.log('SKIP fra-token-enrollment-vault: holder-death lifecycle exclusion (Windows-only check)');
    return;
  }
  const repoRoot = await makeRepo('production-holder-fence', { ordinary: 'preserved' });
  const leases = [];
  let finishFirst;
  let firstActionEnded = false;
  let secondEntered = false;
  const firstMayFinish = new Promise(resolve => { finishFirst = resolve; });
  const dependencies = {
    async acquireTransactionLock(lockPath) {
      const lease = await acquirePowerShellTransactionLock({ lockPath, repoRoot });
      leases.push(lease);
      return lease;
    }
  };
  const first = new FraTokenVaultTransaction({
    repoRoot,
    role: 'a',
    operationId: Buffer.alloc(16, 0x5a).toString('base64url'),
    dependencies
  });
  const second = new FraTokenVaultTransaction({
    repoRoot,
    role: 'a',
    operationId: Buffer.alloc(16, 0x5b).toString('base64url'),
    dependencies
  });
  let firstWork;
  let secondWork;
  try {
    let firstEnteredResolve;
    const firstEntered = new Promise(resolve => { firstEnteredResolve = resolve; });
    firstWork = first._withTransactionLock(async () => {
      firstEnteredResolve();
      await firstMayFinish;
      firstActionEnded = true;
    });
    await firstEntered;
    assert.equal(leases.length, 1);
    secondWork = second._withTransactionLock(async () => {
      secondEntered = true;
      assert.equal(firstActionEnded, true,
        'the successor callback may enter only after the original callback has ended');
      return 'second-complete';
    });
    process.kill(leases[0].pid);
    await leases[0].waitForExit();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(secondEntered, false,
      'holder-only death must not admit an overlapping lifecycle callback');
    finishFirst();
    await assert.rejects(firstWork, error => error && error.code === 'TRANSACTION_LOCK_LOST');
    assert.equal(await secondWork, 'second-complete');
    assert.equal(secondEntered, true);
  } finally {
    finishFirst();
    if (firstWork) await firstWork.catch(() => {});
    if (secondWork) await secondWork.catch(() => {});
    for (const lease of leases) {
      try { process.kill(lease.pid); } catch {}
      await lease.waitForExit().catch(() => {});
    }
    await removeRepo(repoRoot);
  }
}

async function productionTransactionLockQueuesAndAutoReleases() {
  if (process.platform !== 'win32') {
    console.log('SKIP fra-token-enrollment-vault: transaction-lock queue and auto-release (Windows-only check)');
    return;
  }
  const repoRoot = await makeRepo('production-transaction-lock', { ordinary: 'preserved' });
  const lockPath = path.join(repoRoot, 'vault', '.fra-enrollment-transaction.lock');
  let first;
  let second;
  let crashed;
  let recovered;
  try {
    first = await acquirePowerShellTransactionLock({ lockPath, repoRoot });
    let secondAcquired = false;
    const secondPromise = acquirePowerShellTransactionLock({ lockPath, repoRoot })
      .then(lease => {
        secondAcquired = true;
        return lease;
      });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(secondAcquired, false, 'a separate helper process must wait on FileShare.None');
    await first.release();
    first = null;
    second = await secondPromise;
    second.assertHeld();
    await second.release();
    second = null;
    assert.equal(await fsp.stat(lockPath).then(() => true, error => error.code !== 'ENOENT'), false,
      'DeleteOnClose removes a normally released transaction lock');

    crashed = await acquirePowerShellTransactionLock({ lockPath, repoRoot });
    process.kill(crashed.pid);
    await crashed.waitForExit();
    let recoveredAcquired = false;
    const recoveredPromise = acquirePowerShellTransactionLock({ lockPath, repoRoot })
      .then(lease => {
        recoveredAcquired = true;
        return lease;
      });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(recoveredAcquired, false,
      'a live Node owner fence must survive holder-only death and keep successors queued');
    await assert.rejects(
      crashed.release(),
      error => error && error.code === 'TRANSACTION_LOCK_LOST',
      'killing the holder must invalidate its lease'
    );
    crashed = null;
    recovered = await recoveredPromise;
    recovered.assertHeld();
    await recovered.release();
    recovered = null;
    assert.equal(await fsp.stat(lockPath).then(() => true, error => error.code !== 'ENOENT'), false,
      'process death auto-releases and removes the transaction lock');
  } finally {
    if (first) await first.release().catch(() => {});
    if (second) await second.release().catch(() => {});
    if (crashed) {
      try { process.kill(crashed.pid); } catch {}
      await crashed.waitForExit().catch(() => {});
    }
    if (recovered) await recovered.release().catch(() => {});
    await removeRepo(repoRoot);
  }
}

async function run() {
  await absentTargetRoundTrip();
  await presentTargetRoundTrip();
  await stateUpdatesDoNotReapplyAclAfterRestrictedRename();
  await terminalStateCanBeRetiredForLaterRotation();
  await lifecycleMutationsShareOneTransactionLock();
  await finalizePreservesUnrelatedCredentialUpdates();
  await finalizeRejectsTargetCredentialChange();
  await concurrentChangeRollsBackWithoutClobbering();
  await keyAndStateConfusionAreRejected();
  await unchangedTokenIsRejected();
  await productionAclRestrictionIsIdempotent();
  await productionReplacementHoldsTheGenerationHandle();
  await productionReplacementCompensatesPathSwap();
  await preAcknowledgementFailureCleansMatchingFence();
  await productionDeadNodeOwnerIsReclaimed();
  await productionOwnerFenceRecoveryAndInvalidState();
  await productionHolderDeathDoesNotOverlapLifecycleCallback();
  await productionTransactionLockQueuesAndAutoReleases();
  console.log('fra-token enrollment vault tests passed');
}

run().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
