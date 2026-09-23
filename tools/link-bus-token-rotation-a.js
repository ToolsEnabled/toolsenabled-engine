#!/usr/bin/env node
'use strict';

// Coordinator for the vault portion of the 8787 token rotation.  The lower
// address in the customer's exact two-machine registry is the coordinator;
// the higher address is the recipient.  Machine ids are customer-chosen and
// carry no product meaning.
// It stops after recipient then coordinator have committed and explicitly requires an external
// fenced operator to restart the exact 8787 PID, verify new=200/old=401, and
// finalize (or roll both local vaults back).

const http = require('node:http');
const path = require('node:path');
const {
  LinkBusTokenRotationError,
  authenticateOfferWrapper,
  computeReplayDigest,
  createCommand,
  generateToken,
  sealCommand,
  tokenFingerprint,
  validateAuthenticatedAck,
  zero
} = require('./lib/link-bus-token-rotation');
const {
  RotationVaultTransaction
} = require('./lib/link-bus-token-rotation-vault');
const {
  collectOfferAuthenticationKey,
  loadAuthenticatedOffer
} = require('./lib/link-bus-offer-client');
const { directionalMachinePair } = require('../src/lib/service-registry');

const RECIPIENT_ROTATION_PORT = '8792';
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ENVELOPE_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 30000;

function rotationTopology(serviceRegistryOptions = {}) {
  const pair = directionalMachinePair(serviceRegistryOptions);
  return Object.freeze({
    coordinatorAddress: pair.coordinatorMachine.address,
    recipientAddress: pair.recipientMachine.address,
    coordinatorMachineId: pair.coordinatorMachine.machineId,
    recipientMachineId: pair.recipientMachine.machineId
  });
}

function fail(code, message, options) {
  throw new LinkBusTokenRotationError(code, message, options);
}

function pinnedRecipientUrl(value, expectedPath, { serviceRegistryOptions = {} } = {}) {
  const { recipientAddress } = rotationTopology(serviceRegistryOptions);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('INVALID_URL', 'Recipient URL is invalid');
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== recipientAddress ||
    parsed.port !== RECIPIENT_ROTATION_PORT ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.search !== '' ||
    parsed.pathname !== expectedPath
  ) {
    fail('URL_NOT_PINNED', `Recipient URL must be exact ${expectedPath}`);
  }
  return parsed;
}

function requestBuffer(url, body, timeoutMs = REQUEST_TIMEOUT_MS, { serviceRegistryOptions = {} } = {}) {
  const { coordinatorAddress } = rotationTopology(serviceRegistryOptions);
  return new Promise((resolve, reject) => {
    const request = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname,
      method: 'POST',
      localAddress: coordinatorAddress,
      agent: false,
      headers: {
        accept: 'application/json',
        connection: 'close',
        'content-type': 'application/json',
        'content-length': String(body.length)
      }
    });
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) {
        if (value && value.body) zero(value.body);
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => {
      request.destroy();
      finish(new LinkBusTokenRotationError(
        'HTTP_TIMEOUT',
        'Recipient rotation request timed out'
      ));
    }, timeoutMs);
    request.on('error', () => {
      finish(new LinkBusTokenRotationError(
        'HTTP_REQUEST_FAILED',
        'Recipient rotation request failed'
      ));
    });
    request.on('response', response => {
      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        const copy = Buffer.from(chunk);
        total += copy.length;
        if (total > MAX_RESPONSE_BYTES) {
          zero(copy);
          for (const prior of chunks) zero(prior);
          response.destroy();
          finish(new LinkBusTokenRotationError(
            'HTTP_RESPONSE_TOO_LARGE',
            'Recipient rotation response exceeded its bound'
          ));
          return;
        }
        chunks.push(copy);
      });
      response.on('error', () => {
        for (const chunk of chunks) zero(chunk);
        finish(new LinkBusTokenRotationError(
          'HTTP_RESPONSE_FAILED',
          'Recipient rotation response failed'
        ));
      });
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks, total);
        for (const chunk of chunks) zero(chunk);
        finish(null, {
          statusCode: response.statusCode || 0,
          body: responseBody
        });
      });
    });
    request.end(body);
  });
}

async function postEnvelope({
  url,
  envelope,
  requestImpl = requestBuffer,
  timeoutMs = REQUEST_TIMEOUT_MS,
  serviceRegistryOptions = {}
}) {
  let body;
  let responseBody;
  try {
    body = Buffer.from(JSON.stringify(envelope), 'utf8');
    if (body.length > MAX_ENVELOPE_BYTES) {
      fail('ENVELOPE_TOO_LARGE', 'rotation envelope exceeded its bound');
    }
    // Reuse exact sealed bytes for a lost response. B caches the replay digest.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response;
      try {
        response = await requestImpl(url, body, timeoutMs, { serviceRegistryOptions });
      } catch (error) {
        if (attempt < 2) continue;
        throw error;
      }
      responseBody = response.body;
      if (response.statusCode < 200 || response.statusCode > 299) {
        fail('HTTP_STATUS_REJECTED', 'Recipient rejected the rotation command');
      }
      try {
        return JSON.parse(responseBody.toString('utf8'));
      } catch {
        fail('INVALID_ACK', 'Recipient returned invalid acknowledgement JSON');
      } finally {
        zero(responseBody);
        responseBody = null;
      }
    }
    fail('HTTP_RETRY_EXHAUSTED', 'Recipient rotation request did not complete');
  } finally {
    zero(body);
    zero(responseBody);
  }
}

async function runRotation({
  repoRoot,
  offerUrl,
  stageUrl,
  commitUrl,
  rollbackUrl,
  helperTimeoutMs = 30000,
  httpTimeoutMs = REQUEST_TIMEOUT_MS,
  transaction,
  collectAuthenticationKey = collectOfferAuthenticationKey,
  loadOffer = loadAuthenticatedOffer,
  post = postEnvelope,
  randomBytes,
  serviceRegistryOptions = {}
}) {
  const resolvedRoot = path.resolve(repoRoot);
  const vaultPath = path.join(resolvedRoot, 'vault', 'secrets.json');
  const parsedOfferUrl = pinnedRecipientUrl(offerUrl, '/offer', { serviceRegistryOptions });
  const parsedStageUrl = pinnedRecipientUrl(stageUrl, '/stage', { serviceRegistryOptions });
  const parsedCommitUrl = pinnedRecipientUrl(commitUrl, '/commit', { serviceRegistryOptions });
  const parsedRollbackUrl = pinnedRecipientUrl(rollbackUrl, '/rollback', { serviceRegistryOptions });
  const origins = new Set([
    parsedOfferUrl.origin,
    parsedStageUrl.origin,
    parsedCommitUrl.origin,
    parsedRollbackUrl.origin
  ]);
  if (origins.size !== 1) {
    fail('URL_NOT_PINNED', 'all recipient rotation URLs must share one origin');
  }

  let oldKey;
  let newKey;
  let newToken;
  let offerWrapper;
  let offer;
  let tokenSha256;
  let vaultTransaction = transaction;
  let stageSubmitted = false;
  let bOldGenerationSha256 = null;
  let stageEnvelope;
  try {
    oldKey = await collectAuthenticationKey({
      vaultPath,
      timeoutMs: helperTimeoutMs
    });
    offerWrapper = await loadOffer({
      offerUrl,
      timeoutMs: httpTimeoutMs,
      serviceRegistryOptions
    });
    offer = authenticateOfferWrapper({
      wrapper: offerWrapper,
      authenticationKey: oldKey
    });

    newToken = generateToken(randomBytes);
    newKey = Buffer.from(newToken, 'utf8');
    tokenSha256 = tokenFingerprint(newToken);
    vaultTransaction = vaultTransaction || new RotationVaultTransaction({
      repoRoot: resolvedRoot,
      role: 'a',
      operationId: offer.operationId,
      vaultPath
    });
    const aPrepared = await vaultTransaction.prepare(newToken);
    if (aPrepared.newTokenSha256 !== tokenSha256) {
      fail('STATE_MISMATCH', 'Coordinator staged fingerprint did not correlate');
    }

    const stageCommand = createCommand({
      action: 'stage_b',
      offer,
      token: newToken,
      tokenSha256,
      authenticationKey: oldKey
    });
    stageEnvelope = sealCommand({ offer, command: stageCommand });
    const stageReplayDigest = computeReplayDigest(stageEnvelope);
    stageSubmitted = true;
    const stageAck = await post({
      url: parsedStageUrl,
      envelope: stageEnvelope,
      timeoutMs: httpTimeoutMs,
      serviceRegistryOptions
    });
    bOldGenerationSha256 = stageAck.oldGenerationSha256;
    validateAuthenticatedAck({
      ack: stageAck,
      expectedStatus: 'staged_b',
      offer,
      tokenSha256,
      envelopeReplayDigest: stageReplayDigest,
      oldGenerationSha256: bOldGenerationSha256,
      authenticationKey: newKey
    });

    const commitCommand = createCommand({
      action: 'commit_b',
      offer,
      tokenSha256,
      authenticationKey: oldKey
    });
    const commitEnvelope = sealCommand({ offer, command: commitCommand });
    const commitReplayDigest = computeReplayDigest(commitEnvelope);
    const commitAck = await post({
      url: parsedCommitUrl,
      envelope: commitEnvelope,
      timeoutMs: httpTimeoutMs,
      serviceRegistryOptions
    });
    validateAuthenticatedAck({
      ack: commitAck,
      expectedStatus: 'committed_b',
      offer,
      tokenSha256,
      envelopeReplayDigest: commitReplayDigest,
      oldGenerationSha256: bOldGenerationSha256,
      authenticationKey: newKey
    });

    const aCommitted = await vaultTransaction.commit();
    if (aCommitted.newTokenSha256 !== tokenSha256) {
      fail('STATE_MISMATCH', 'Coordinator committed fingerprint did not correlate');
    }
    return Object.freeze({
      status: 'restart_required',
      operationId: offer.operationId,
      tokenSha256,
      coordinatorStatePath: vaultTransaction.paths.statePath
    });
  } catch (error) {
    let bRolledBack = !stageSubmitted;
    let aRolledBack = false;
    if (stageSubmitted && offer && tokenSha256 && oldKey) {
      try {
        const rollbackCommand = createCommand({
          action: 'rollback_b',
          offer,
          tokenSha256,
          authenticationKey: oldKey
        });
        const rollbackEnvelope = sealCommand({
          offer,
          command: rollbackCommand
        });
        const rollbackReplayDigest = computeReplayDigest(rollbackEnvelope);
        const rollbackAck = await post({
          url: parsedRollbackUrl,
          envelope: rollbackEnvelope,
          timeoutMs: httpTimeoutMs,
          serviceRegistryOptions
        });
        validateAuthenticatedAck({
          ack: rollbackAck,
          expectedStatus: 'rolled_back_b',
          offer,
          tokenSha256,
          envelopeReplayDigest: rollbackReplayDigest,
          oldGenerationSha256: bOldGenerationSha256,
          authenticationKey: oldKey
        });
        bRolledBack = true;
      } catch {
        bRolledBack = false;
      }
    }
    if (vaultTransaction) {
      try {
        const state = await vaultTransaction.status();
        if (state.phase === 'rolled_back') {
          aRolledBack = true;
        } else {
          await vaultTransaction.rollback();
          aRolledBack = true;
        }
      } catch {
        aRolledBack = false;
      }
    } else {
      aRolledBack = true;
    }
    if (!aRolledBack || !bRolledBack) {
      throw new LinkBusTokenRotationError(
        'ROLLBACK_INCOMPLETE',
        'rotation failed and both-machine rollback requires local recovery',
        { rollbackIncomplete: true }
      );
    }
    if (error instanceof LinkBusTokenRotationError) throw error;
    fail('ROTATION_FAILED', 'link-bus token rotation failed');
  } finally {
    zero(oldKey);
    zero(newKey);
    newToken = null;
    tokenSha256 = null;
    stageEnvelope = null;
    if (offerWrapper && typeof offerWrapper.signature === 'string') {
      offerWrapper.signature = '';
    }
  }
}

function parseCli(argv) {
  const allowed = new Set([
    '--repo-root',
    '--offer-url',
    '--stage-url',
    '--commit-url',
    '--rollback-url'
  ]);
  const options = Object.create(null);
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--execute-link-bus-token-rotation') {
      if (execute) fail('INVALID_ARGUMENT', 'execution flag was repeated');
      execute = true;
      continue;
    }
    if (!allowed.has(flag) || index + 1 >= argv.length) {
      fail('INVALID_ARGUMENT', 'rotation arguments are invalid');
    }
    const value = argv[index + 1];
    if (
      value.startsWith('--') ||
      value.includes('\0') ||
      Object.hasOwn(options, flag)
    ) {
      fail('INVALID_ARGUMENT', 'rotation arguments are invalid');
    }
    options[flag] = value;
    index += 1;
  }
  if (!execute) {
    fail('EXECUTION_CONFIRMATION_REQUIRED', 'explicit rotation confirmation is required');
  }
  for (const required of allowed) {
    if (!options[required]) {
      fail('INVALID_ARGUMENT', 'rotation arguments are incomplete');
    }
  }
  if (!path.isAbsolute(options['--repo-root'])) {
    fail('INVALID_ARGUMENT', 'repo root must be absolute');
  }
  return {
    repoRoot: options['--repo-root'],
    offerUrl: options['--offer-url'],
    stageUrl: options['--stage-url'],
    commitUrl: options['--commit-url'],
    rollbackUrl: options['--rollback-url']
  };
}

async function main() {
  try {
    const result = await runRotation(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof LinkBusTokenRotationError
      ? error.code
      : 'ROTATION_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  get COORDINATOR_ADDRESS() { return rotationTopology().coordinatorAddress; },
  get RECIPIENT_ADDRESS() { return rotationTopology().recipientAddress; },
  RECIPIENT_ROTATION_PORT,
  parseCli,
  pinnedRecipientUrl,
  postEnvelope,
  requestBuffer,
  rotationTopology,
  runRotation
};
