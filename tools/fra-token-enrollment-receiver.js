'use strict';

// One-shot recipient for the sealed FRA-token transaction. This
// process never restarts or reloads FRA, Bridge, Tunnel, Cursor, Codex, Claude,
// or any other listener. It only stages/commits/rolls back the fixed vault key.

const http = require('node:http');
const path = require('node:path');
const {
  FraTokenEnrollmentError,
  createAuthenticatedAck,
  createAuthenticatedOfferWrapper,
  createEnrollmentRecipientContext,
  openCommand,
  verifyCommand,
  zero
} = require('./lib/fra-token-enrollment');
const {
  FraTokenVaultTransaction,
  productionDependencies
} = require('./lib/fra-token-enrollment-vault');
const { directionalMachinePair } = require('../src/lib/service-registry');

const REPO_ROOT = path.resolve(__dirname, '..');

// THE TWO ADDRESSES ARE RESOLVED WHERE THEY ARE USED, NOT AT MODULE LOAD.
//
// They used to be module-level consts, which meant `machineForId` ran during
// require(). The registry's real copy is untracked and machine-local, and the
// tracked one declares a single machine, so the throw did not refuse a
// receiver -- it refused the IMPORT, and took every importer down with it.
// Measured on this checkout before the change:
//   require('src/full-remote-access-bridge.js')
//     -> SERVICE_PEER_UNDETERMINED when no two-machine topology is declared
// via src/full-remote-access-bridge.js -> tools/fra-token-enrollment-lifecycle.js
// -> here. `node src/full-remote-access-bridge.js` is a documented run command
// (tools/fra-selfhost.js prints it), so the shipped listener could not start on
// any machine but a builder's.
//
// This is the same shape as the module-level taskName resolution recorded in
// config/managed-processes.json's own header, and the fix is the one
// the other direct-link receivers use for their bind/allow-peer pair: resolve
// through the registry at the point of use. The throw still refuses -- it now refuses to CREATE or START a
// receiver, never an import, and it can never be reached in a way that skips a
// check: normalizeRemoteAddress takes the resolved address as an argument, so
// there is no path where an unresolvable registry yields an admitted peer.
function bindAddress(serviceRegistryOptions = {}) {
  return directionalMachinePair(serviceRegistryOptions).recipientMachine.address;
}

function allowedRemoteAddress(serviceRegistryOptions = {}) {
  return directionalMachinePair(serviceRegistryOptions).coordinatorMachine.address;
}

const DEFAULT_PORT = 8792;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 128 * 1024;
const OFFER_PATH = '/v1/fra-token-enrollment/offer';
const COMMAND_PATH = '/v1/fra-token-enrollment/command';

function fail(code, message, options) {
  throw new FraTokenEnrollmentError(code, message, options);
}

// `allowed` is the address resolved once by the caller that created this
// receiver. It is a required argument on purpose: a default that re-read the
// registry here would put a disk read and a possible throw on the per-request
// path, which is exactly what the sibling receiver's comment forbids.
function normalizeRemoteAddress(value, allowed) {
  if (typeof allowed !== 'string' || !allowed) return null;
  if (value === allowed) return value;
  if (value === `::ffff:${allowed}`) return allowed;
  return null;
}

function jsonResponse(response, statusCode, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    connection: 'close'
  });
  response.end(body);
}

function rejected(response, error) {
  const code = error && typeof error.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code)
    ? error.code
    : 'ENROLLMENT_REJECTED';
  const statusCode = error && Number.isSafeInteger(error.httpStatus)
    ? Math.max(400, Math.min(599, error.httpStatus))
    : 400;
  jsonResponse(response, statusCode, { status: 'rejected', code });
}

function requestContentLength(request) {
  const headers = request.headers || {};
  if (
    headers['transfer-encoding'] !== undefined ||
    (headers['content-encoding'] !== undefined && headers['content-encoding'] !== 'identity')
  ) {
    fail('INVALID_HTTP_SHAPE', 'request encodings are not permitted');
  }
  const contentType = headers['content-type'];
  if (
    typeof contentType !== 'string' ||
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType)
  ) {
    fail('INVALID_HTTP_SHAPE', 'content type is not permitted');
  }
  const value = headers['content-length'];
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    fail('INVALID_HTTP_SHAPE', 'content length is required');
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) {
    fail('BODY_TOO_LARGE', 'request body exceeded its bound', { httpStatus: 413 });
  }
  return length;
}

async function collectBody(request, expectedLength) {
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of request) {
      const copy = Buffer.from(chunk);
      total += copy.length;
      if (total > expectedLength || total > MAX_BODY_BYTES) {
        zero(copy);
        fail('BODY_TOO_LARGE', 'request body exceeded its bound', { httpStatus: 413 });
      }
      chunks.push(copy);
    }
    if (total !== expectedLength) {
      fail('BODY_LENGTH_MISMATCH', 'request body length did not match');
    }
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) zero(chunk);
  }
}

function parseEnvelope(body) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail('INVALID_ENVELOPE', 'sealed envelope is invalid');
    }
    return value;
  } catch (error) {
    if (error instanceof FraTokenEnrollmentError) throw error;
    fail('INVALID_ENVELOPE', 'sealed envelope is invalid');
  } finally {
    text = null;
  }
}

function phasePresence(state) {
  if (state.phase === 'committed') return true;
  if (state.phase === 'rolled_back' || state.phase === 'prepared') {
    return state.previouslyPresent;
  }
  fail('INVALID_PHASE', 'transaction is not at a reportable phase');
}

function ackStatusFor(action) {
  if (action === 'stage_b') return 'staged_b';
  if (action === 'commit_b') return 'committed_b';
  if (action === 'rollback_b') return 'rolled_back_b';
  if (action === 'status_b') return 'status_b';
  fail('INVALID_ACTION', 'transaction action is invalid');
}

async function createEnrollmentSession({
  repoRoot = REPO_ROOT,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  signCanonical,
  dependencies,
  transactionFactory,
  serviceRegistryOptions = {}
} = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const production = dependencies || (!signCanonical
    ? productionDependencies({ repoRoot: resolvedRoot })
    : null);
  const signer = signCanonical || production.signCanonical;
  const topology = directionalMachinePair(serviceRegistryOptions);
  const senderIdentity = topology.coordinatorMachine.machineId;
  const recipientIdentity = topology.recipientMachine.machineId;
  const recipientContext = createEnrollmentRecipientContext({ senderIdentity, recipientIdentity, now, ttlMs });
  const offerWrapper = await createAuthenticatedOfferWrapper({
    offer: recipientContext.offer,
    senderIdentity,
    recipientIdentity,
    signCanonical: signer,
    now
  });
  let transaction = null;

  const makeTransaction = () => {
    if (!transaction) {
      transaction = transactionFactory
        ? transactionFactory({
          repoRoot: resolvedRoot,
          role: 'b',
          operationId: recipientContext.offer.operationId,
          dependencies
        })
        : new FraTokenVaultTransaction({
          repoRoot: resolvedRoot,
          role: 'b',
          operationId: recipientContext.offer.operationId,
          dependencies: production
        });
    }
    return transaction;
  };

  return Object.freeze({
    offerWrapper,
    expiresAt: recipientContext.offer.expiresAt,
    async handleEnvelope(envelope, at = Date.now()) {
      const opened = openCommand({
        recipientContext,
        envelope,
        now: at
      });
      const command = opened.command;
      try {
        await verifyCommand({
          command,
          offer: recipientContext.offer,
          expectedAction: command.action,
          signCanonical: signer
        });
        if (!transaction && command.action !== 'stage_b') {
          fail('TRANSACTION_NOT_STARTED', 'FRA token transaction is not staged', {
            httpStatus: 409
          });
        }
        // Whether this session already owns a transaction is the only reliable
        // indication that a stage command is a retry.  In particular,
        // `status()` reports INVALID_STATE both when no state exists and when
        // state exists but could not be read or validated.  Catching that code
        // and calling prepare() turned an unreadable/corrupt retry into the
        // definite answer "not staged yet".  A first stage does not need that
        // ambiguous probe; a retry must refuse if its existing state cannot be
        // established.
        const stageIsRetry = transaction !== null;
        const active = makeTransaction();
        let state;
        if (command.action === 'stage_b') {
          if (stageIsRetry) {
            state = await active.status();
            if (
              state.newFingerprint !== command.tokenFingerprint ||
              state.phase !== 'prepared'
            ) {
              fail('TRANSACTION_CONFLICT', 'FRA token transaction conflicts');
            }
          } else {
            state = await active.prepare(command.newTokenBase64Url);
          }
        } else if (command.action === 'commit_b') {
          state = await active.status();
          if (state.newFingerprint !== command.tokenFingerprint) {
            fail('TRANSACTION_CONFLICT', 'FRA token fingerprint conflicts');
          }
          state = await active.commit();
        } else if (command.action === 'rollback_b') {
          state = await active.status();
          if (state.newFingerprint !== command.tokenFingerprint) {
            fail('TRANSACTION_CONFLICT', 'FRA token fingerprint conflicts');
          }
          state = await active.rollback();
        } else {
          state = await active.status();
          if (state.newFingerprint !== command.tokenFingerprint) {
            fail('TRANSACTION_CONFLICT', 'FRA token fingerprint conflicts');
          }
        }
        return createAuthenticatedAck({
          status: ackStatusFor(command.action),
          offer: recipientContext.offer,
          tokenSha256: state.newFingerprint,
          envelopeReplayDigest: opened.replayDigest,
          phase: state.phase,
          previouslyPresent: state.previouslyPresent,
          currentTargetPresent: phasePresence(state),
          signCanonical: signer
        });
      } finally {
        if (command && typeof command.newTokenBase64Url === 'string') {
          command.newTokenBase64Url = '';
        }
      }
    },
    destroy() {
      return recipientContext.destroy();
    }
  });
}

async function createHttpReceiver(options = {}) {
  // Resolved once, here, so an unreadable or incomplete registry refuses to
  // create the receiver rather than being re-asked on every request.
  const peerAddress = allowedRemoteAddress(options.serviceRegistryOptions || {});
  const session = await createEnrollmentSession(options);
  const server = http.createServer(async (request, response) => {
    let body;
    try {
      if (!normalizeRemoteAddress(request.socket.remoteAddress, peerAddress)) {
        fail('REMOTE_ADDRESS_REJECTED', 'remote address is not permitted', { httpStatus: 403 });
      }
      const pathname = new URL(request.url, 'http://fra-enrollment.invalid').pathname;
      if (request.method === 'GET' && pathname === OFFER_PATH) {
        jsonResponse(response, 200, session.offerWrapper);
        return;
      }
      if (request.method !== 'POST' || pathname !== COMMAND_PATH) {
        fail('ROUTE_REJECTED', 'request route is not permitted', { httpStatus: 404 });
      }
      const length = requestContentLength(request);
      body = await collectBody(request, length);
      const envelope = parseEnvelope(body);
      const ack = await session.handleEnvelope(envelope);
      jsonResponse(response, 200, { status: 'accepted', ack });
    } catch (error) {
      if (!response.headersSent) rejected(response, error);
      else response.destroy();
    } finally {
      zero(body);
    }
  });
  server.on('close', () => session.destroy());
  return { server, session };
}

function parseCli(argv) {
  let execute = false;
  let port = DEFAULT_PORT;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--execute-fra-token-enrollment-receiver') {
      if (execute) fail('INVALID_ARGUMENT', 'execution flag was repeated');
      execute = true;
    } else if (value === '--port' && index + 1 < argv.length) {
      port = Number(argv[++index]);
    } else {
      fail('INVALID_ARGUMENT', 'command line is invalid');
    }
  }
  if (!execute) fail('EXECUTION_CONFIRMATION_REQUIRED', 'explicit receiver confirmation is required');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail('INVALID_ARGUMENT', 'receiver port is invalid');
  }
  return { port };
}

async function startCli(argv) {
  const { port } = parseCli(argv);
  const bind = bindAddress();
  const peer = allowedRemoteAddress();
  const { server, session } = await createHttpReceiver();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, resolve);
  });
  const timeout = Math.max(1000, session.expiresAt - Date.now() + 1000);
  const timer = setTimeout(() => server.close(), timeout);
  timer.unref();
  process.stdout.write(`${JSON.stringify({
    status: 'listening',
    bindAddress: bind,
    allowedRemoteAddress: peer,
    offerUrl: `http://${bind}:${port}${OFFER_PATH}`,
    commandUrl: `http://${bind}:${port}${COMMAND_PATH}`,
    expiresAt: session.expiresAt,
    listenerReloaded: false
  })}\n`);
  return new Promise(resolve => server.once('close', resolve));
}

if (require.main === module) {
  startCli(process.argv.slice(2)).catch(error => {
    const code = error && typeof error.code === 'string'
      ? error.code
      : 'FRA_TOKEN_RECEIVER_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'failed', code })}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  allowedRemoteAddress,
  bindAddress,
  COMMAND_PATH,
  DEFAULT_TTL_MS,
  DEFAULT_PORT,
  OFFER_PATH,
  ackStatusFor,
  collectBody,
  createEnrollmentSession,
  createHttpReceiver,
  normalizeRemoteAddress,
  parseCli,
  phasePresence,
  requestContentLength,
  startCli
};
