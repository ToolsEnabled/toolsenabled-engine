#!/usr/bin/env node
'use strict';

// Recipient verification gate. The DPAPI tokens remain inside a hidden
// PowerShell probe that emits only an HTTP status.  Post-restart success is
// persisted as a secret-free receipt and attached to B's rotation state.

const fs = require('node:fs');
const path = require('node:path');
const {
  TOKEN_VAULT_KEY,
  LinkBusTokenRotationError,
  createAuthenticatedVerificationReceipt,
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
const {
  inspectLocalStatus
} = require('./link-bus-token-rotation-local');

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

async function runProbe({
  repoRoot,
  mode,
  vaultPath,
  processRunner = runHiddenProcess
}) {
  const script = path.join(
    repoRoot,
    'tools',
    'special-session-link-bus-token-probe.ps1'
  );
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Mode',
    mode
  ];
  if (mode === 'Authenticated') {
    args.push('-VaultPath', vaultPath, '-KeyId', TOKEN_VAULT_KEY);
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
      maxOutputBytes: 64
    });
    if (
      !result ||
      result.code !== 0 ||
      result.stderr.length !== 0 ||
      !/^[1-5][0-9]{2}$/.test(result.stdout.toString('ascii'))
    ) {
      fail('PROBE_FAILED', 'link-bus status probe failed');
    }
    return Number(result.stdout.toString('ascii'));
  } finally {
    if (result) {
      zero(result.stdout);
      zero(result.stderr);
    }
  }
}

function receiptPathFor(repoRoot, operationId) {
  return path.join(
    repoRoot,
    'state',
    'special-session',
    `link-bus-token-rotation-verification-${operationId}.json`
  );
}

async function writeReceipt(transaction, receipt) {
  const receiptPath = receiptPathFor(
    transaction.repoRoot,
    receipt.operationId
  );
  await transaction.deps.fs.mkdir(path.dirname(receiptPath), {
    recursive: true
  });
  let handle;
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8');
    try {
      handle = await transaction.deps.fs.open(receiptPath, 'wx', 0o600);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const stat = await transaction.deps.fs.lstat(receiptPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size <= 0 ||
        stat.size > 64 * 1024
      ) {
        fail('INVALID_RECEIPT', 'existing verification receipt is invalid');
      }
      let existingBytes;
      try {
        existingBytes = await transaction.deps.fs.readFile(receiptPath);
        const existing = JSON.parse(existingBytes.toString('utf8'));
        validateVerificationReceipt(
          existing,
          receipt.operationId,
          receipt.tokenSha256
        );
        if (
          existing.listenerPid !== receipt.listenerPid ||
          existing.listenerCreationDate !== receipt.listenerCreationDate
        ) {
          fail(
            'VERIFICATION_CONFLICT',
            'existing verification receipt conflicts'
          );
        }
        return Object.freeze({ receiptPath, receipt: existing });
      } catch (error) {
        if (error instanceof LinkBusTokenRotationError) throw error;
        fail('INVALID_RECEIPT', 'existing verification receipt is invalid');
      } finally {
        zero(existingBytes);
      }
    }
    await transaction.deps.restrictAcl(receiptPath);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    zero(bytes);
    if (handle) await handle.close();
  }
  return Object.freeze({ receiptPath, receipt });
}

async function verifyRotation({
  repoRoot,
  mode,
  expectedListenerPid,
  expectedListenerCreationDate,
  transaction,
  probe = runProbe,
  inspect = inspectLocalStatus,
  signReceipt,
  now = Date.now()
}) {
  if (!['pre-restart', 'post-restart'].includes(mode)) {
    fail('INVALID_ARGUMENT', 'verification mode is invalid');
  }
  const resolvedRoot = path.resolve(repoRoot);
  const vaultTransaction = transaction || await openExistingTransaction({
    repoRoot: resolvedRoot,
    role: 'b'
  });
  const state = await vaultTransaction.status();
  if (
    mode === 'pre-restart'
      ? state.phase !== 'committed'
      : !['committed', 'verified', 'finalized'].includes(state.phase)
  ) {
    fail('INVALID_PHASE', 'Recipient rotation is not committed');
  }
  const healthStatus = await probe({
    repoRoot: resolvedRoot,
    mode: 'Health'
  });
  const newTokenStatus = await probe({
    repoRoot: resolvedRoot,
    mode: 'Authenticated',
    vaultPath: state.canonicalPath
  });
  const oldTokenStatus = await probe({
    repoRoot: resolvedRoot,
    mode: 'Authenticated',
    vaultPath: state.backupPath
  });
  if (mode === 'pre-restart') {
    if (
      healthStatus !== 200 ||
      newTokenStatus !== 401 ||
      oldTokenStatus !== 200
    ) {
      fail('PRE_RESTART_VERIFICATION_FAILED', 'pre-restart token split did not match');
    }
    return Object.freeze({
      status: 'pre_restart_verified',
      operationId: state.operationId,
      tokenSha256: state.newTokenSha256,
      healthStatus,
      newTokenStatus,
      oldTokenStatus
    });
  }
  if (
    !Number.isSafeInteger(expectedListenerPid) ||
    expectedListenerPid <= 0 ||
    typeof expectedListenerCreationDate !== 'string' ||
    expectedListenerCreationDate.length < 1 ||
    expectedListenerCreationDate.length > 128 ||
    expectedListenerCreationDate.includes('\0') ||
    healthStatus !== 200 ||
    newTokenStatus !== 200 ||
    oldTokenStatus !== 401
  ) {
    fail('POST_RESTART_VERIFICATION_FAILED', 'post-restart token split did not match');
  }
  const localStatus = await inspect({
    repoRoot: resolvedRoot,
    role: 'b'
  });
  if (!localStatus || localStatus.port8788Closed !== true) {
    fail(
      'POST_RESTART_VERIFICATION_FAILED',
      'Recipient local port verification failed'
    );
  }
  const signCanonical = signReceipt || (canonical => (
    signCanonicalWithDpapiVault({
      repoRoot: resolvedRoot,
      vaultPath: state.canonicalPath,
      canonical
    })
  ));
  const proposedReceipt = state.verification ||
    await createAuthenticatedVerificationReceipt({
      operationId: state.operationId,
      tokenSha256: state.newTokenSha256,
      listenerPid: expectedListenerPid,
      listenerCreationDate: expectedListenerCreationDate,
      port8788Closed: localStatus.port8788Closed,
      verifiedAt: now,
      signCanonical
    });
  validateVerificationReceipt(
    proposedReceipt,
    state.operationId,
      state.newTokenSha256
  );
  if (
    proposedReceipt.listenerPid !== expectedListenerPid ||
    proposedReceipt.listenerCreationDate !== expectedListenerCreationDate
  ) {
    fail('VERIFICATION_CONFLICT', 'listener identity conflicts with verification');
  }
  await verifyVerificationReceiptWithSigner({
    receipt: proposedReceipt,
    operationId: state.operationId,
    tokenSha256: state.newTokenSha256,
    signCanonical
  });
  const persisted = await writeReceipt(vaultTransaction, proposedReceipt);
  await verifyVerificationReceiptWithSigner({
    receipt: persisted.receipt,
    operationId: state.operationId,
    tokenSha256: state.newTokenSha256,
    signCanonical
  });
  await vaultTransaction.markVerified(persisted.receipt);
  return Object.freeze({
    status: 'post_restart_verified',
    operationId: state.operationId,
    tokenSha256: state.newTokenSha256,
    listenerPid: expectedListenerPid,
    listenerCreationDate: expectedListenerCreationDate,
    port8788Closed: true,
    receiptPath: persisted.receiptPath
  });
}

function parseCli(argv) {
  const allowed = new Set([
    '--repo-root',
    '--mode',
    '--expected-listener-pid',
    '--expected-listener-creation-date'
  ]);
  const options = Object.create(null);
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--execute-link-bus-token-verification') {
      if (execute) fail('INVALID_ARGUMENT', 'execution flag was repeated');
      execute = true;
      continue;
    }
    if (!allowed.has(flag) || index + 1 >= argv.length) {
      fail('INVALID_ARGUMENT', 'verification arguments are invalid');
    }
    const value = argv[index + 1];
    if (
      value.startsWith('--') ||
      value.includes('\0') ||
      Object.hasOwn(options, flag)
    ) {
      fail('INVALID_ARGUMENT', 'verification arguments are invalid');
    }
    options[flag] = value;
    index += 1;
  }
  if (!execute || !options['--repo-root'] || !options['--mode']) {
    fail('INVALID_ARGUMENT', 'verification arguments are incomplete');
  }
  if (!path.isAbsolute(options['--repo-root'])) {
    fail('INVALID_ARGUMENT', 'repo root must be absolute');
  }
  const expectedListenerPid =
    options['--expected-listener-pid'] === undefined
      ? undefined
      : Number(options['--expected-listener-pid']);
  const expectedListenerCreationDate =
    options['--expected-listener-creation-date'];
  if (
    options['--mode'] === 'post-restart' &&
    (
      !Number.isSafeInteger(expectedListenerPid) ||
      expectedListenerPid <= 0 ||
      typeof expectedListenerCreationDate !== 'string' ||
      expectedListenerCreationDate.length < 1 ||
      expectedListenerCreationDate.length > 128 ||
      expectedListenerCreationDate.includes('\0')
    )
  ) {
    fail(
      'INVALID_ARGUMENT',
      'post-restart verification requires the exact listener PID and creation date'
    );
  }
  return {
    repoRoot: options['--repo-root'],
    mode: options['--mode'],
    expectedListenerPid,
    expectedListenerCreationDate
  };
}

async function main() {
  try {
    const result = await verifyRotation(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof LinkBusTokenRotationError
      ? error.code
      : 'VERIFICATION_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseCli,
  receiptPathFor,
  runProbe,
  verifyRotation,
  writeReceipt
};
