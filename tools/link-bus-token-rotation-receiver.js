#!/usr/bin/env node
'use strict';

// Recipient-only, one-operation receiver for the 8787 token rotation.  The
// recipient is derived from the customer's exact two-machine registry; no
// machine id is reserved by the product.  It
// never starts on import.  The old token authenticates the offer and each
// sealed command; the new token appears only inside the encrypted stage
// command and B's DPAPI-protected candidate vault.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const {
  MAX_TTL_MS,
  TOKEN_VAULT_KEY,
  LinkBusTokenRotationError,
  computeReplayDigest,
  createAuthenticatedAck,
  createAuthenticatedOfferWrapper,
  createRotationRecipientContext,
  openCommand,
  verifyCommandWithSigner,
  zero
} = require('./lib/link-bus-token-rotation');
const {
  RotationVaultTransaction,
  statePathFor
} = require('./lib/link-bus-token-rotation-vault');
const {
  runHiddenProcess
} = require('./lib/hidden-process');
const { directionalMachinePair } = require('../src/lib/service-registry');

const DEFAULT_PORT = 8792;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 128 * 1024;
const CHILD_OUTPUT_BYTES = 1024;
const OFFER_AUTH_SCRIPT = 'special-session-offer-auth.ps1';

function rotationTopology(serviceRegistryOptions = {}) {
  const pair = directionalMachinePair(serviceRegistryOptions);
  return Object.freeze({
    bindAddress: pair.recipientMachine.address,
    allowedRemoteAddress: pair.coordinatorMachine.address,
    coordinatorMachineId: pair.coordinatorMachine.machineId,
    recipientMachineId: pair.recipientMachine.machineId
  });
}

function fail(code, message, options) {
  throw new LinkBusTokenRotationError(code, message, options);
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

async function signWithDpapiVault(runtime, vaultPath, canonical) {
  let result;
  try {
    const stat = await fs.promises.lstat(vaultPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      fail('OFFER_AUTH_FAILED', 'rotation signer vault is invalid');
    }
    result = await runHiddenProcess({
      file: runtime.powershellPath,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        runtime.offerAuthScriptPath,
        '-VaultPath',
        vaultPath,
        '-KeyId',
        TOKEN_VAULT_KEY
      ],
      cwd: runtime.repoRoot,
      env: minimalEnvironment(),
      stdin: canonical,
      windowsHide: true,
      shell: false,
      timeoutMs: 30000,
      maxOutputBytes: CHILD_OUTPUT_BYTES
    });
    if (
      !result ||
      result.code !== 0 ||
      result.stderr.length !== 0 ||
      !/^[A-Za-z0-9_-]{43}$/.test(result.stdout.toString('ascii'))
    ) {
      fail('OFFER_AUTH_FAILED', 'rotation authentication helper failed');
    }
    return result.stdout.toString('ascii');
  } finally {
    if (result) {
      zero(result.stdout);
      zero(result.stderr);
    }
  }
}

function normalizeRemoteAddress(value, allowedRemoteAddress = rotationTopology().allowedRemoteAddress) {
  if (value === allowedRemoteAddress) return value;
  if (value === `::ffff:${allowedRemoteAddress}`) {
    return allowedRemoteAddress;
  }
  return null;
}

function jsonResponse(response, statusCode, body) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
    connection: 'close'
  });
  response.end(bytes);
}

function rejected(response, statusCode = 400) {
  jsonResponse(response, statusCode, { status: 'rejected' });
}

function requestContentLength(request) {
  const headers = request.headers || {};
  if (
    headers['transfer-encoding'] !== undefined ||
    (
      headers['content-encoding'] !== undefined &&
      headers['content-encoding'] !== 'identity'
    ) ||
    typeof headers['content-type'] !== 'string' ||
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(headers['content-type']) ||
    typeof headers['content-length'] !== 'string' ||
    !/^[1-9][0-9]*$/.test(headers['content-length'])
  ) {
    fail('INVALID_HTTP_SHAPE', 'rotation request shape is invalid');
  }
  const length = Number(headers['content-length']);
  if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) {
    fail('BODY_TOO_LARGE', 'rotation request exceeded its bound', {
      httpStatus: 413
    });
  }
  return length;
}

async function collectBody(request, expectedLength) {
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of request) {
      const copy = Buffer.from(chunk);
      length += copy.length;
      if (length > expectedLength || length > MAX_BODY_BYTES) {
        zero(copy);
        fail('BODY_TOO_LARGE', 'rotation request exceeded its bound', {
          httpStatus: 413
        });
      }
      chunks.push(copy);
    }
    if (length !== expectedLength) {
      fail('BODY_LENGTH_MISMATCH', 'rotation request length did not match');
    }
    return Buffer.concat(chunks);
  } finally {
    for (const chunk of chunks) zero(chunk);
  }
}

function parseEnvelope(body) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const envelope = JSON.parse(text);
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      fail('INVALID_ENVELOPE', 'rotation envelope is invalid');
    }
    return envelope;
  } catch (error) {
    if (error instanceof LinkBusTokenRotationError) throw error;
    fail('INVALID_ENVELOPE', 'rotation envelope is invalid');
  } finally {
    text = null;
  }
}

async function createRotationReceiver({
  runtime,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
  transaction,
  serviceRegistryOptions = {},
  signCanonicalFromVault = (vaultPath, canonical) => (
    signWithDpapiVault(runtime, vaultPath, canonical)
  )
}) {
  const topology = rotationTopology(serviceRegistryOptions);
  if (
    !runtime ||
    runtime.bindAddress !== topology.bindAddress ||
    runtime.port !== DEFAULT_PORT ||
    !path.isAbsolute(runtime.repoRoot) ||
    !path.isAbsolute(runtime.vaultPath) ||
    !path.isAbsolute(runtime.offerAuthScriptPath) ||
    !path.isAbsolute(runtime.powershellPath)
  ) {
    fail('INVALID_CONFIGURATION', 'rotation receiver runtime is invalid');
  }
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1000 ||
    ttlMs > MAX_TTL_MS
  ) {
    fail('INVALID_CONFIGURATION', 'rotation receiver TTL is invalid');
  }
  const recipientContext = createRotationRecipientContext({ now, ttlMs });
  const vaultTransaction = transaction || new RotationVaultTransaction({
    repoRoot: runtime.repoRoot,
    role: 'b',
    operationId: recipientContext.offer.operationId,
    vaultPath: runtime.vaultPath
  });
  const offerWrapper = await createAuthenticatedOfferWrapper({
    offer: recipientContext.offer,
    signCanonical: canonical => (
      signCanonicalFromVault(runtime.vaultPath, canonical)
    )
  });
  const replayResponses = new Map();
  const completedActions = new Map();
  let phase = 'accepting';

  async function handleEnvelope(expectedAction, envelope) {
    const digest = computeReplayDigest(envelope);
    if (replayResponses.has(digest)) return replayResponses.get(digest);
    if (completedActions.has(digest)) {
      const completed = completedActions.get(digest);
      const retriedAck = await createAuthenticatedAck({
        status: completed.status,
        offer: recipientContext.offer,
        tokenSha256: completed.state.newTokenSha256,
        envelopeReplayDigest: digest,
        oldGenerationSha256: completed.state.baseGenerationSha256,
        signCanonical: canonical => signCanonicalFromVault(
          completed.signerVault,
          canonical
        )
      });
      replayResponses.set(digest, retriedAck);
      return retriedAck;
    }

    const opened = openCommand({
      recipientContext,
      envelope,
      expectedAction,
      now: Date.now()
    });
    const command = opened.command;
    // Every command is authenticated by the old token.  Before commit it
    // lives in the staged DPAPI snapshot; after commit it lives in the
    // authoritative backup.  Never try to authenticate commit with the
    // not-yet-created backup path.
    const signerVault = expectedAction === 'stage_b'
      ? runtime.vaultPath
      : expectedAction === 'commit_b' || phase === 'staged'
        ? vaultTransaction.paths.stagedBackupPath
        : vaultTransaction.paths.backupPath;
    await verifyCommandWithSigner({
      command,
      offer: recipientContext.offer,
      expectedAction,
      signCanonical: canonical => signCanonicalFromVault(
        signerVault,
        canonical
      )
    });

    let state;
    let status;
    let ackSignerVault;
    if (expectedAction === 'stage_b') {
      if (phase !== 'accepting') {
        fail('INVALID_PHASE', 'rotation receiver is not accepting a stage', {
          httpStatus: 409
        });
      }
      state = await vaultTransaction.prepare(command.newTokenBase64Url);
      status = 'staged_b';
      phase = 'staged';
      ackSignerVault = vaultTransaction.paths.candidatePath;
    } else if (expectedAction === 'commit_b') {
      if (phase !== 'staged') {
        fail('INVALID_PHASE', 'rotation receiver is not staged', {
          httpStatus: 409
        });
      }
      state = await vaultTransaction.commit();
      status = 'committed_b';
      phase = 'committed';
      ackSignerVault = runtime.vaultPath;
    } else {
      if (!['staged', 'committed'].includes(phase)) {
        fail('INVALID_PHASE', 'rotation receiver cannot roll back', {
          httpStatus: 409
        });
      }
      state = await vaultTransaction.rollback();
      status = 'rolled_back_b';
      phase = 'rolled_back';
      ackSignerVault = runtime.vaultPath;
    }
    if (state.newTokenSha256 !== command.tokenSha256) {
      fail('STATE_MISMATCH', 'rotation state did not correlate');
    }
    completedActions.set(digest, {
      status,
      state,
      signerVault: ackSignerVault
    });
    const ack = await createAuthenticatedAck({
      status,
      offer: recipientContext.offer,
      tokenSha256: state.newTokenSha256,
      envelopeReplayDigest: digest,
      oldGenerationSha256: state.baseGenerationSha256,
      signCanonical: canonical => signCanonicalFromVault(
        ackSignerVault,
        canonical
      )
    });
    replayResponses.set(digest, ack);
    return ack;
  }

  const handler = async (request, response) => {
    if (
      !request.socket ||
      normalizeRemoteAddress(request.socket.remoteAddress, topology.allowedRemoteAddress) === null ||
      request.headers?.['x-forwarded-for'] !== undefined ||
      request.headers?.forwarded !== undefined
    ) {
      rejected(response, 403);
      return;
    }
    if (request.method === 'GET' && request.url === '/offer') {
      if (phase !== 'accepting') {
        rejected(response, 410);
        return;
      }
      jsonResponse(response, 200, offerWrapper);
      return;
    }
    const routeToAction = {
      '/stage': 'stage_b',
      '/commit': 'commit_b',
      '/rollback': 'rollback_b'
    };
    const expectedAction = routeToAction[request.url];
    if (request.method !== 'POST' || !expectedAction) {
      rejected(response, 404);
      return;
    }
    let body;
    try {
      body = await collectBody(request, requestContentLength(request));
      const ack = await handleEnvelope(expectedAction, parseEnvelope(body));
      jsonResponse(response, 200, ack);
    } catch (error) {
      rejected(
        response,
        error instanceof LinkBusTokenRotationError
          ? error.httpStatus
          : 500
      );
    } finally {
      zero(body);
    }
  };

  return Object.freeze({
    offer: recipientContext.offer,
    offerWrapper,
    handler,
    handleEnvelope,
    transaction: vaultTransaction,
    get phase() {
      return phase;
    },
    destroy() {
      phase = 'terminal';
      replayResponses.clear();
      completedActions.clear();
      return recipientContext.destroy();
    }
  });
}

function parseCli(argv, { serviceRegistryOptions = {} } = {}) {
  const topology = rotationTopology(serviceRegistryOptions);
  const allowed = new Set([
    '--bind',
    '--port',
    '--repo-root',
    '--ttl-ms'
  ]);
  const options = Object.create(null);
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--execute-link-bus-token-rotation-receiver') {
      if (execute) fail('INVALID_ARGUMENT', 'execution flag was repeated');
      execute = true;
      continue;
    }
    if (!allowed.has(flag) || index + 1 >= argv.length) {
      fail('INVALID_ARGUMENT', 'rotation receiver arguments are invalid');
    }
    const value = argv[index + 1];
    if (
      value.startsWith('--') ||
      value.includes('\0') ||
      Object.hasOwn(options, flag)
    ) {
      fail('INVALID_ARGUMENT', 'rotation receiver arguments are invalid');
    }
    options[flag] = value;
    index += 1;
  }
  if (!execute) {
    fail('EXECUTION_CONFIRMATION_REQUIRED', 'explicit receiver confirmation is required');
  }
  if (
    options['--bind'] !== topology.bindAddress ||
    !options['--repo-root']
  ) {
    fail('INVALID_ARGUMENT', 'rotation receiver arguments are incomplete');
  }
  const repoRoot = path.resolve(options['--repo-root']);
  if (!path.isAbsolute(options['--repo-root'])) {
    fail('INVALID_ARGUMENT', 'repo root must be absolute');
  }
  const port = options['--port'] === undefined
    ? DEFAULT_PORT
    : Number(options['--port']);
  const ttlMs = options['--ttl-ms'] === undefined
    ? DEFAULT_TTL_MS
    : Number(options['--ttl-ms']);
  if (
    port !== DEFAULT_PORT ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1000 ||
    ttlMs > MAX_TTL_MS
  ) {
    fail('INVALID_ARGUMENT', 'rotation receiver port or TTL is invalid');
  }
  const runtime = {
    bindAddress: topology.bindAddress,
    port,
    repoRoot,
    vaultPath: path.join(repoRoot, 'vault', 'secrets.json'),
    offerAuthScriptPath: path.join(
      repoRoot,
      'tools',
      OFFER_AUTH_SCRIPT
    ),
    powershellPath: powerShellPath()
  };
  return { runtime, ttlMs };
}

async function startCli(argv, { serviceRegistryOptions = {} } = {}) {
  const { runtime, ttlMs } = parseCli(argv, { serviceRegistryOptions });
  const activeState = statePathFor(runtime.vaultPath, 'b');
  let rotationStateExists = false;
  try {
    fs.lstatSync(activeState);
    rotationStateExists = true;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  if (rotationStateExists) {
    fail('ROTATION_ALREADY_EXISTS', 'The recipient already has rotation state');
  }
  const receiver = await createRotationReceiver({ runtime, ttlMs, serviceRegistryOptions });
  const server = http.createServer((request, response) => {
    receiver.handler(request, response).catch(() => {
      if (!response.headersSent) rejected(response, 500);
      else response.destroy();
    });
  });
  server.maxConnections = 2;
  server.headersTimeout = 10000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 1000;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('error', () => {
    process.stderr.write('link-bus-token-rotation-receiver: failed\n');
    process.exitCode = 1;
  });
  server.listen(runtime.port, runtime.bindAddress, () => {
    process.stdout.write('link-bus-token-rotation-receiver: ready\n');
  });
  const expiryTimer = setTimeout(() => {
    receiver.destroy();
    server.close();
  }, receiver.offer.expiresAt - Date.now());
  expiryTimer.unref();
  return { receiver, server };
}

if (require.main === module) {
  startCli(process.argv.slice(2)).catch(() => {
    process.stderr.write('link-bus-token-rotation-receiver: failed\n');
    process.exitCode = 1;
  });
}

module.exports = {
  get ALLOWED_REMOTE_ADDRESS() { return rotationTopology().allowedRemoteAddress; },
  get BIND_ADDRESS() { return rotationTopology().bindAddress; },
  DEFAULT_PORT,
  collectBody,
  createRotationReceiver,
  normalizeRemoteAddress,
  parseCli,
  rotationTopology,
  signWithDpapiVault,
  startCli
};
