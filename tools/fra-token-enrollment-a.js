'use strict';

// Coordinator for the sealed two-peer FRA token transaction. The validated
// registry's lower-address machine coordinates and the higher-address machine
// receives. Commit order remains recipient then coordinator.

const http = require('node:http');
const path = require('node:path');
const {
  FraTokenEnrollmentError,
  authenticateOfferWrapper,
  computeReplayDigest,
  createCommand,
  generateToken,
  sealCommand,
  tokenFingerprint,
  validateAuthenticatedAck
} = require('./lib/fra-token-enrollment');
const {
  FraTokenVaultTransaction,
  productionDependencies
} = require('./lib/fra-token-enrollment-vault');
const {
  COMMAND_PATH,
  DEFAULT_PORT,
  OFFER_PATH
} = require('./fra-token-enrollment-receiver');
const { directionalMachinePair } = require('../src/lib/service-registry');

const REPO_ROOT = path.resolve(__dirname, '..');

// RESOLVED AT THE POINT OF USE, NOT AT MODULE LOAD -- same reason as the
// matching pair in tools/fra-token-enrollment-receiver.js. As top-level consts
// these turned an unreadable or single-machine registry into a failed require(),
// which took src/full-remote-access-bridge.js down with it through
// tools/fra-token-enrollment-lifecycle.js.
//
// PORTABILITY MUST NOT BECOME "SEND ANYWHERE" (the wording is
// the direct-link transport invariant. The URL pin below is still exact
// hostname equality against one resolved address, and
// directionalMachinePair still THROWS on an unreadable, malformed, or ambiguous registry
// -- it now aborts the handoff rather than the import, and there is no path
// where a failed resolution relaxes the pin.
function coordinatorAddress(serviceRegistryOptions = {}) {
  return directionalMachinePair(serviceRegistryOptions).coordinatorMachine.address;
}

function recipientAddress(serviceRegistryOptions = {}) {
  return directionalMachinePair(serviceRegistryOptions).recipientMachine.address;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function fail(code, message, options) {
  throw new FraTokenEnrollmentError(code, message, options);
}

function pinnedUrl(value, expectedPath, expectedPort = DEFAULT_PORT, serviceRegistryOptions = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('INVALID_URL', 'enrollment URL is invalid');
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.hostname !== recipientAddress(serviceRegistryOptions) ||
    Number(parsed.port || 80) !== expectedPort ||
    parsed.pathname !== expectedPath ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    fail('URL_PIN_MISMATCH', 'enrollment URL is not the pinned direct peer');
  }
  return parsed;
}

function requestJson(url, { method = 'GET', value, timeoutMs = REQUEST_TIMEOUT_MS, serviceRegistryOptions = {} } = {}) {
  return new Promise((resolve, reject) => {
    let requestBody;
    let requestBodyScrubbed = false;
    const scrubRequestBody = () => {
      if (!requestBodyScrubbed && requestBody) requestBody.fill(0);
      requestBodyScrubbed = true;
    };
    if (value !== undefined) requestBody = Buffer.from(JSON.stringify(value), 'utf8');
    const request = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      localAddress: coordinatorAddress(serviceRegistryOptions),
      timeout: timeoutMs,
      headers: requestBody ? {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(requestBody.length),
        connection: 'close'
      } : {
        connection: 'close'
      }
    }, response => {
      const chunks = [];
      let total = 0;
      response.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          chunk.fill(0);
          response.destroy();
          reject(new FraTokenEnrollmentError(
            'RESPONSE_TOO_LARGE',
            'enrollment response exceeded its bound'
          ));
          return;
        }
        chunks.push(Buffer.from(chunk));
        chunk.fill(0);
      });
      response.once('error', () => reject(new FraTokenEnrollmentError(
        'HTTP_RESPONSE_FAILED',
        'enrollment response failed'
      )));
      response.once('end', () => {
        let body;
        let parsed;
        try {
          body = Buffer.concat(chunks, total);
          parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
          if (response.statusCode < 200 || response.statusCode > 299) {
            const code = parsed && typeof parsed.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(parsed.code)
              ? parsed.code
              : 'REMOTE_REJECTED';
            reject(new FraTokenEnrollmentError(code, 'enrollment recipient rejected enrollment'));
            return;
          }
          resolve(parsed);
        } catch (error) {
          if (error instanceof FraTokenEnrollmentError) reject(error);
          else reject(new FraTokenEnrollmentError(
            'INVALID_RESPONSE',
            'enrollment response was invalid'
          ));
        } finally {
          for (const chunk of chunks) chunk.fill(0);
          if (body) body.fill(0);
          parsed = null;
        }
      });
    });
    request.once('timeout', () => request.destroy(new Error('timeout')));
    request.once('close', scrubRequestBody);
    request.once('error', () => reject(new FraTokenEnrollmentError(
      'HTTP_REQUEST_FAILED',
      'enrollment request failed'
    )));
    if (requestBody) {
      request.end(requestBody, scrubRequestBody);
    } else {
      request.end();
    }
  });
}

async function issueAction({
  action,
  offer,
  token,
  tokenSha256,
  senderIdentity,
  recipientIdentity,
  signCanonical,
  postEnvelope,
  now = Date.now
}) {
  const actionNow = typeof now === 'function' ? now() : now;
  const command = await createCommand({
    action,
    offer,
    senderIdentity,
    recipientIdentity,
    token,
    tokenSha256,
    signCanonical,
    now: actionNow
  });
  const envelope = sealCommand({ offer, command, now: actionNow });
  const replayDigest = computeReplayDigest(envelope);
  const response = await postEnvelope({ action, envelope });
  const expectedStatus = action === 'stage_b'
    ? 'staged_b'
    : action === 'commit_b'
      ? 'committed_b'
      : action === 'rollback_b'
        ? 'rolled_back_b'
        : 'status_b';
  const ack = response && response.ack ? response.ack : response;
  await validateAuthenticatedAck({
    ack,
    expectedStatus,
    offer,
    tokenSha256,
    envelopeReplayDigest: replayDigest,
    signCanonical
  });
  return ack;
}

async function compensateRemote({
  offer,
  tokenSha256,
  senderIdentity,
  recipientIdentity,
  signCanonical,
  postEnvelope,
  now
}) {
  let status;
  try {
    status = await issueAction({
      action: 'status_b',
      offer,
      tokenSha256,
      senderIdentity,
      recipientIdentity,
      signCanonical,
      postEnvelope,
      now
    });
  } catch (error) {
    if (error && error.code === 'TRANSACTION_NOT_STARTED') {
      return { ok: true, remotePhase: 'not_started' };
    }
    return { ok: false, remotePhase: 'unknown' };
  }
  if (status.phase === 'rolled_back') {
    return { ok: true, remotePhase: 'rolled_back' };
  }
  if (status.phase !== 'prepared' && status.phase !== 'committed') {
    return { ok: false, remotePhase: status.phase };
  }
  try {
    const rolledBack = await issueAction({
      action: 'rollback_b',
      offer,
      tokenSha256,
      senderIdentity,
      recipientIdentity,
      signCanonical,
      postEnvelope,
      now
    });
    if (rolledBack.phase !== 'rolled_back') {
      return { ok: false, remotePhase: rolledBack.phase };
    }
    return { ok: true, remotePhase: 'rolled_back' };
  } catch {
    return { ok: false, remotePhase: 'unknown' };
  }
}

async function rollbackLocal(transaction) {
  try {
    const state = await transaction.status();
    if (state.phase === 'rolled_back') return state;
    return await transaction.rollback();
  } catch (error) {
    throw new FraTokenEnrollmentError(
      'ROLLBACK_INCOMPLETE',
      'coordinator rollback is incomplete',
      { rollbackIncomplete: true }
    );
  }
}

async function runEnrollment({
  offerWrapper,
  signCanonical,
  postEnvelope,
  repoRoot = REPO_ROOT,
  dependencies,
  transactionFactory,
  tokenGenerator = generateToken,
  now = Date.now,
  serviceRegistryOptions = {}
}) {
  if (typeof postEnvelope !== 'function') {
    fail('INVALID_PEER', 'enrollment recipient is unavailable');
  }
  const topology = directionalMachinePair(serviceRegistryOptions);
  const senderIdentity = topology.coordinatorMachine.machineId;
  const recipientIdentity = topology.recipientMachine.machineId;
  const offer = await authenticateOfferWrapper({
    wrapper: offerWrapper,
    senderIdentity,
    recipientIdentity,
    signCanonical,
    now: typeof now === 'function' ? now() : now
  });
  let token = tokenGenerator();
  const fingerprint = tokenFingerprint(token);
  const transaction = transactionFactory
    ? transactionFactory({
      repoRoot: path.resolve(repoRoot),
      role: 'a',
      operationId: offer.operationId,
      dependencies
    })
    : new FraTokenVaultTransaction({
      repoRoot: path.resolve(repoRoot),
      role: 'a',
      operationId: offer.operationId,
      dependencies
    });
  let localPrepared = false;
  try {
    const localState = await transaction.prepare(token);
    localPrepared = true;
    if (localState.phase !== 'prepared' || localState.newFingerprint !== fingerprint) {
      fail('LOCAL_STAGE_MISMATCH', 'coordinator staging did not match');
    }

    let stagedAck;
    try {
      stagedAck = await issueAction({
        action: 'stage_b',
        offer,
        senderIdentity,
        recipientIdentity,
        token,
        tokenSha256: fingerprint,
        signCanonical,
        postEnvelope,
        now
      });
      if (stagedAck.phase !== 'prepared') {
        fail('REMOTE_STAGE_MISMATCH', 'recipient did not remain prepared');
      }
    } catch (error) {
      const remote = await compensateRemote({
        offer,
        senderIdentity,
        recipientIdentity,
        tokenSha256: fingerprint,
        signCanonical,
        postEnvelope,
        now
      });
      await rollbackLocal(transaction);
      if (!remote.ok) {
        throw new FraTokenEnrollmentError(
          'ROLLBACK_INCOMPLETE',
          'stage failed and recipient state is uncertain',
          { rollbackIncomplete: true }
        );
      }
      throw new FraTokenEnrollmentError(
        'REMOTE_STAGE_FAILED_ROLLED_BACK',
        'recipient staging failed and both sides were rolled back'
      );
    }

    // Stage-both-before-commit invariant: no commit call occurs above this line.
    let committedAck;
    try {
      committedAck = await issueAction({
        action: 'commit_b',
        offer,
        senderIdentity,
        recipientIdentity,
        tokenSha256: fingerprint,
        signCanonical,
        postEnvelope,
        now
      });
      if (committedAck.phase !== 'committed' || !committedAck.currentTargetPresent) {
        fail('REMOTE_COMMIT_MISMATCH', 'recipient commit did not match');
      }
    } catch (error) {
      const remote = await compensateRemote({
        offer,
        senderIdentity,
        recipientIdentity,
        tokenSha256: fingerprint,
        signCanonical,
        postEnvelope,
        now
      });
      await rollbackLocal(transaction);
      if (!remote.ok) {
        throw new FraTokenEnrollmentError(
          'ROLLBACK_INCOMPLETE',
          'commit acknowledgement was lost and recipient rollback is uncertain',
          { rollbackIncomplete: true }
        );
      }
      throw new FraTokenEnrollmentError(
        'REMOTE_COMMIT_UNCONFIRMED_ROLLED_BACK',
        'recipient commit was unconfirmed and both sides were rolled back'
      );
    }

    try {
      const committedLocal = await transaction.commit();
      if (committedLocal.phase !== 'committed' || committedLocal.newFingerprint !== fingerprint) {
        fail('LOCAL_COMMIT_MISMATCH', 'coordinator commit did not match');
      }
    } catch (error) {
      const remote = await compensateRemote({
        offer,
        senderIdentity,
        recipientIdentity,
        tokenSha256: fingerprint,
        signCanonical,
        postEnvelope,
        now
      });
      await rollbackLocal(transaction);
      if (!remote.ok) {
        throw new FraTokenEnrollmentError(
          'ROLLBACK_INCOMPLETE',
          'coordinator commit failed and recipient rollback is uncertain',
          { rollbackIncomplete: true }
        );
      }
      throw new FraTokenEnrollmentError(
        'LOCAL_COMMIT_FAILED_ROLLED_BACK',
        'coordinator commit failed and both sides were rolled back'
      );
    }

    return Object.freeze({
      status: 'committed',
      operationId: offer.operationId,
      tokenFingerprint: fingerprint,
      machineAPhase: 'committed',
      machineBPhase: 'committed',
      listenerReloaded: false
    });
  } finally {
    token = null;
    if (!localPrepared) {
      // No candidate exists to compensate when local preparation never finished.
    }
  }
}

function parseCli(argv) {
  let execute = false;
  let port = DEFAULT_PORT;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--execute-fra-token-enrollment') {
      if (execute) fail('INVALID_ARGUMENT', 'execution flag was repeated');
      execute = true;
    } else if (value === '--port' && index + 1 < argv.length) {
      port = Number(argv[++index]);
    } else {
      fail('INVALID_ARGUMENT', 'command line is invalid');
    }
  }
  if (!execute) fail('EXECUTION_CONFIRMATION_REQUIRED', 'explicit enrollment confirmation is required');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail('INVALID_ARGUMENT', 'enrollment port is invalid');
  }
  return { port };
}

async function startCli(argv) {
  const { port } = parseCli(argv);
  const peer = recipientAddress();
  const offerUrl = pinnedUrl(
    `http://${peer}:${port}${OFFER_PATH}`,
    OFFER_PATH,
    port
  );
  const commandUrl = pinnedUrl(
    `http://${peer}:${port}${COMMAND_PATH}`,
    COMMAND_PATH,
    port
  );
  const offerWrapper = await requestJson(offerUrl);
  const dependencies = productionDependencies({ repoRoot: REPO_ROOT });
  const result = await runEnrollment({
    offerWrapper,
    signCanonical: dependencies.signCanonical,
    postEnvelope: async ({ envelope }) => {
      const response = await requestJson(commandUrl, {
        method: 'POST',
        value: envelope
      });
      if (!response || response.status !== 'accepted' || !response.ack) {
        fail('INVALID_RESPONSE', 'recipient acknowledgement was invalid');
      }
      return response.ack;
    },
    dependencies
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) {
  startCli(process.argv.slice(2)).catch(error => {
    const code = error && typeof error.code === 'string'
      ? error.code
      : 'FRA_TOKEN_ENROLLMENT_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  coordinatorAddress,
  recipientAddress,
  REQUEST_TIMEOUT_MS,
  compensateRemote,
  issueAction,
  parseCli,
  pinnedUrl,
  requestJson,
  rollbackLocal,
  runEnrollment,
  startCli
};
