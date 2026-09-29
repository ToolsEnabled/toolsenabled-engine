#!/usr/bin/env node
'use strict';

// Local recovery/finalization command for either machine.  No network request
// and no service mutation occurs here.  A rollback restores the DPAPI backup
// atomically; the coordinator then explicitly requires the exact-PID restart command.

const fs = require('node:fs');
const path = require('node:path');
const {
  LinkBusTokenRotationError,
  validateVerificationReceipt,
  verifyVerificationReceiptWithSigner,
  zero
} = require('./lib/link-bus-token-rotation');
const {
  signCanonicalWithDpapiVault
} = require('./lib/link-bus-token-rotation-hmac');
const {
  openExistingTransaction
} = require('./lib/link-bus-token-rotation-vault');
const {
  runHiddenProcess
} = require('./lib/hidden-process');

const MAX_RECEIPT_BYTES = 64 * 1024;

function fail(code, message) {
  throw new LinkBusTokenRotationError(code, message);
}

function minimalEnvironment() {
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
  return selected;
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

function requireLocalStatus(result, {
  role,
  expectedPid,
  expectedCreationDate
}) {
  if (
    !result ||
    result.valid !== true ||
    result.role !== role ||
    result.port8788Closed !== true ||
    (
      role === 'a' &&
      (
        result.listenerPid !== expectedPid ||
        result.listenerCreationDate !== expectedCreationDate
      )
    )
  ) {
    fail('LOCAL_STATUS_FAILED', 'local port/process verification failed');
  }
  return result;
}

async function inspectLocalStatus({
  repoRoot,
  role,
  expectedPid,
  expectedCreationDate,
  processRunner = runHiddenProcess
}) {
  const script = path.join(
    repoRoot,
    'tools',
    'special-session-link-bus-local-status.ps1'
  );
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Role',
    role,
    '-RepoRoot',
    repoRoot
  ];
  if (role === 'a') {
    args.push(
      '-ExpectedPid',
      String(expectedPid),
      '-ExpectedCreationDate',
      expectedCreationDate
    );
  }
  let result;
  try {
    result = await processRunner({
      file: powerShellPath(),
      args,
      cwd: repoRoot,
      env: minimalEnvironment(),
      stdin: Buffer.alloc(0),
      windowsHide: true,
      shell: false,
      timeoutMs: 15000,
      maxOutputBytes: 4096
    });
    if (!result || result.code !== 0 || result.stderr.length !== 0) {
      fail('LOCAL_STATUS_FAILED', 'local port/process verification failed');
    }
    const parsed = JSON.parse(result.stdout.toString('utf8'));
    return requireLocalStatus(parsed, {
      role,
      expectedPid,
      expectedCreationDate
    });
  } catch (error) {
    if (error instanceof LinkBusTokenRotationError) throw error;
    fail('LOCAL_STATUS_FAILED', 'local port/process verification failed');
  } finally {
    if (result) {
      zero(result.stdout);
      zero(result.stderr);
    }
  }
}

async function readReceipt(receiptPath) {
  let bytes;
  try {
    const stat = await fs.promises.lstat(receiptPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size <= 0 ||
      stat.size > MAX_RECEIPT_BYTES
    ) {
      fail('INVALID_RECEIPT', 'verification receipt file is invalid');
    }
    bytes = await fs.promises.readFile(receiptPath);
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof LinkBusTokenRotationError) throw error;
    fail('INVALID_RECEIPT', 'verification receipt file is invalid');
  } finally {
    zero(bytes);
  }
}

async function authenticateReceiptFromVault({
  receipt,
  state,
  repoRoot
}) {
  return verifyVerificationReceiptWithSigner({
    receipt,
    operationId: state.operationId,
    tokenSha256: state.newTokenSha256,
    signCanonical: canonical => signCanonicalWithDpapiVault({
      repoRoot,
      vaultPath: state.canonicalPath,
      canonical
    })
  });
}

async function runLocalControl({
  repoRoot,
  role,
  action,
  receiptPath,
  allowFinalizedRollback = false,
  transaction,
  inspect = inspectLocalStatus,
  authenticateReceipt = authenticateReceiptFromVault
}) {
  if (!['a', 'b'].includes(role)) {
    fail('INVALID_ARGUMENT', 'local rotation role is invalid');
  }
  if (!['status', 'accept-verification', 'finalize', 'rollback'].includes(action)) {
    fail('INVALID_ARGUMENT', 'local rotation action is invalid');
  }
  const resolvedRoot = path.resolve(repoRoot);
  const vaultTransaction = transaction || await openExistingTransaction({
    repoRoot: resolvedRoot,
    role
  });
  if (action === 'status') {
    const state = await vaultTransaction.status();
    return Object.freeze({
      status: state.phase,
      role,
      operationId: state.operationId,
      tokenSha256: state.newTokenSha256,
      statePath: vaultTransaction.paths.statePath
    });
  }
  if (action === 'rollback') {
    const state = await vaultTransaction.rollback({
      allowFinalized: allowFinalizedRollback
    });
    return Object.freeze({
      status: role === 'a'
        ? 'rolled_back_restart_required'
        : 'rolled_back',
      role,
      operationId: state.operationId,
      tokenSha256: state.newTokenSha256,
      oldBackupPath: state.backupPath,
      failedNewPath: state.failedNewPath
    });
  }

  let state = await vaultTransaction.status();
  if (action === 'accept-verification') {
    if (role !== 'a' || !receiptPath || !path.isAbsolute(receiptPath)) {
      fail('INVALID_ARGUMENT', 'The coordinator requires an absolute verification receipt path');
    }
    const receipt = await readReceipt(receiptPath);
    validateVerificationReceipt(
      receipt,
      state.operationId,
      state.newTokenSha256
    );
    await authenticateReceipt({
      receipt,
      state,
      repoRoot: resolvedRoot
    });
    const localStatus = await inspect({
      repoRoot: resolvedRoot,
      role: 'a',
      expectedPid: receipt.listenerPid,
      expectedCreationDate: receipt.listenerCreationDate
    });
    requireLocalStatus(localStatus, {
      role: 'a',
      expectedPid: receipt.listenerPid,
      expectedCreationDate: receipt.listenerCreationDate
    });
    state = await vaultTransaction.markVerified(receipt);
    return Object.freeze({
      status: 'verification_accepted',
      role,
      operationId: state.operationId,
      tokenSha256: state.newTokenSha256,
      listenerPid: receipt.listenerPid
    });
  }

  if (state.phase !== 'verified' && state.phase !== 'finalized') {
    fail('INVALID_PHASE', 'rotation is not verified');
  }
  await authenticateReceipt({
    receipt: state.verification,
    state,
    repoRoot: resolvedRoot
  });
  const localStatus = await inspect({
    repoRoot: resolvedRoot,
    role,
    expectedPid: role === 'a'
      ? state.verification.listenerPid
      : undefined,
    expectedCreationDate: role === 'a'
      ? state.verification.listenerCreationDate
      : undefined
  });
  requireLocalStatus(localStatus, {
    role,
    expectedPid: role === 'a'
      ? state.verification.listenerPid
      : undefined,
    expectedCreationDate: role === 'a'
      ? state.verification.listenerCreationDate
      : undefined
  });
  state = await vaultTransaction.finalize();
  return Object.freeze({
    status: 'finalized',
    role,
    operationId: state.operationId,
    tokenSha256: state.newTokenSha256,
    oldBackupPath: state.backupPath
  });
}

function parseCli(argv) {
  const valueOptions = new Set([
    '--repo-root',
    '--role',
    '--action',
    '--receipt-path'
  ]);
  const options = Object.create(null);
  let execute = false;
  let allowFinalizedRollback = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--execute-link-bus-token-local-control') {
      if (execute) fail('INVALID_ARGUMENT', 'execution flag was repeated');
      execute = true;
      continue;
    }
    if (flag === '--allow-finalized-rollback') {
      if (allowFinalizedRollback) {
        fail('INVALID_ARGUMENT', 'finalized rollback flag was repeated');
      }
      allowFinalizedRollback = true;
      continue;
    }
    if (!valueOptions.has(flag) || index + 1 >= argv.length) {
      fail('INVALID_ARGUMENT', 'local control arguments are invalid');
    }
    const value = argv[index + 1];
    if (
      value.startsWith('--') ||
      value.includes('\0') ||
      Object.hasOwn(options, flag)
    ) {
      fail('INVALID_ARGUMENT', 'local control arguments are invalid');
    }
    options[flag] = value;
    index += 1;
  }
  for (const required of ['--repo-root', '--role', '--action']) {
    if (!options[required]) {
      fail('INVALID_ARGUMENT', 'local control arguments are incomplete');
    }
  }
  if (!path.isAbsolute(options['--repo-root'])) {
    fail('INVALID_ARGUMENT', 'repo root must be absolute');
  }
  if (options['--action'] !== 'status' && !execute) {
    fail('EXECUTION_CONFIRMATION_REQUIRED', 'explicit local control confirmation is required');
  }
  if (
    allowFinalizedRollback &&
    options['--action'] !== 'rollback'
  ) {
    fail('INVALID_ARGUMENT', 'finalized rollback flag is valid only for rollback');
  }
  return {
    repoRoot: options['--repo-root'],
    role: options['--role'],
    action: options['--action'],
    receiptPath: options['--receipt-path'],
    allowFinalizedRollback
  };
}

async function main() {
  try {
    const result = await runLocalControl(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof LinkBusTokenRotationError
      ? error.code
      : 'LOCAL_CONTROL_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  authenticateReceiptFromVault,
  inspectLocalStatus,
  parseCli,
  readReceipt,
  runLocalControl
};
