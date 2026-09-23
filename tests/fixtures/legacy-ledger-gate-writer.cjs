'use strict';

// Legacy JSON gate-transition fixture, retained only to test compatibility of
// previously written evidence with current readers. No product entrypoint may
// import this helper. Every invocation must name its disposable ledger path.

const fs = require('node:fs');
const path = require('node:path');

const ownerCapture = require('../../tools/owner-capture');

const MAX_ACTOR_LENGTH = 200;
const MAX_EVIDENCE_LENGTH = 100_000;
const ALLOWED_INPUT_FIELDS = new Set([
  'ledgerFile', 'requestId', 'gateIndex', 'evidence', 'actor', 'timestamp'
]);

class LedgerGateWriterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerGateWriterError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LedgerGateWriterError(code, message);
}

function assertPlainInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.getPrototypeOf(input) !== Object.prototype) {
    fail('LEDGER_GATE_INPUT_INVALID', 'markGateMet input must be a plain object.');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_FIELDS.has(key)) {
      fail('LEDGER_GATE_INPUT_UNKNOWN_FIELD', `Unsupported markGateMet field: ${key}.`);
    }
  }
}

function nonEmptyString(value, code, label, maxLength) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    fail(code, `${label} must be a non-empty string.`);
  }
  if (maxLength && value.length > maxLength) {
    fail(code, `${label} exceeds the ${maxLength}-character limit.`);
  }
  return value;
}

function normalizeInput(input) {
  assertPlainInput(input);

  const ledgerFile = nonEmptyString(input.ledgerFile, 'LEDGER_GATE_FILE_INVALID', 'explicit fixture ledgerFile');
  const resolvedLedgerFile = path.resolve(ledgerFile);

  const requestId = nonEmptyString(
    input.requestId,
    'LEDGER_GATE_REQUEST_ID_INVALID',
    'requestId',
    32
  );
  if (!ownerCapture.ID_PATTERN.test(requestId)) {
    fail('LEDGER_GATE_REQUEST_ID_INVALID', 'requestId must match the ledger R-number format.');
  }

  const gateIndex = input.gateIndex;
  if (!Number.isSafeInteger(gateIndex) || gateIndex < 0 || Object.is(gateIndex, -0)) {
    fail('LEDGER_GATE_INDEX_INVALID', 'gateIndex must be a non-negative safe integer.');
  }

  // Preserve evidence bytes exactly as supplied.  Only its emptiness and
  // bounded size are checked here; runtime-word gates receive the stronger
  // owner-capture destination-query check below after their instruction is
  // read from the ledger.
  const evidence = nonEmptyString(
    input.evidence,
    'LEDGER_GATE_EVIDENCE_REQUIRED',
    'evidence',
    MAX_EVIDENCE_LENGTH
  );
  const actor = nonEmptyString(
    input.actor,
    'LEDGER_GATE_ACTOR_REQUIRED',
    'actor',
    MAX_ACTOR_LENGTH
  );

  let timestamp;
  if (input.timestamp === undefined) {
    timestamp = new Date().toISOString();
  } else {
    timestamp = nonEmptyString(input.timestamp, 'LEDGER_GATE_TIMESTAMP_INVALID', 'timestamp', 64);
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
      fail('LEDGER_GATE_TIMESTAMP_INVALID', 'timestamp must be a canonical ISO-8601 timestamp.');
    }
  }

  return Object.freeze({
    ledgerFile: resolvedLedgerFile,
    requestId,
    gateIndex,
    evidence,
    actor,
    timestamp
  });
}

function wrapOwnerCaptureError(error) {
  if (!error || typeof error !== 'object' || typeof error.code !== 'string') return error;
  return new LedgerGateWriterError(error.code, error.message || error.code);
}

function readLedger(ledgerFile) {
  let raw;
  try {
    raw = fs.readFileSync(ledgerFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      fail('LEDGER_GATE_LEDGER_NOT_FOUND', `No ledger file at ${ledgerFile}; refusing to create one.`);
    }
    fail('LEDGER_GATE_LEDGER_READ_FAILED', `Could not read ${ledgerFile}: ${error.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail('LEDGER_GATE_LEDGER_INVALID_JSON', `${ledgerFile} is not valid JSON; refusing to modify it.`);
  }
  try {
    ownerCapture.validateLedgerShape(data, ledgerFile);
  } catch (error) {
    throw wrapOwnerCaptureError(error);
  }
  return { raw, data };
}

function validateGateShape(gate, requestId, gateIndex) {
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
    fail('LEDGER_GATE_SHAPE_INVALID', `${requestId}.gates[${gateIndex}] is not an object.`);
  }
  if (typeof gate.instruction !== 'string' || gate.instruction.trim() === '') {
    fail('LEDGER_GATE_SHAPE_INVALID', `${requestId}.gates[${gateIndex}] has no instruction.`);
  }
  if (typeof gate.met !== 'boolean') {
    fail('LEDGER_GATE_SHAPE_INVALID', `${requestId}.gates[${gateIndex}] has a non-boolean met value.`);
  }
  if (typeof gate.evidence !== 'string') {
    fail('LEDGER_GATE_SHAPE_INVALID', `${requestId}.gates[${gateIndex}] has non-string evidence.`);
  }
}

function validateRequestGateState(entry, requestId, gateIndex) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail('LEDGER_GATE_REQUEST_SHAPE_INVALID', `${requestId} is not a request object.`);
  }
  if (!Array.isArray(entry.gates)) {
    fail('LEDGER_GATE_REQUEST_HAS_NO_GATES', `${requestId} has no gates array.`);
  }
  if (gateIndex >= entry.gates.length) {
    fail('LEDGER_GATE_INDEX_NOT_FOUND', `${requestId}.gates[${gateIndex}] does not exist.`);
  }
  const gate = entry.gates[gateIndex];
  validateGateShape(gate, requestId, gateIndex);
  if (gate.met === true) {
    fail('LEDGER_GATE_ALREADY_MET', `${requestId}.gates[${gateIndex}] is already met; evidence is first-write-wins.`);
  }
  if (gate.evidence !== '') {
    fail('LEDGER_GATE_STATE_INVALID', `${requestId}.gates[${gateIndex}] is unmet but already carries evidence.`);
  }
  if (entry.captureLog !== undefined && !Array.isArray(entry.captureLog)) {
    fail('LEDGER_GATE_CAPTURE_LOG_INVALID', `${requestId}.captureLog is not an array.`);
  }
  return gate;
}

function comparableRequest(entry) {
  const copy = { ...entry };
  delete copy.gates;
  delete copy.captureLog;
  return JSON.stringify(copy);
}

function assertRequestPreserved(before, after, requestId) {
  if (comparableRequest(before) !== comparableRequest(after)) {
    fail('LEDGER_GATE_REQUEST_MUTATED', `markGateMet changed fields other than gates/captureLog on ${requestId}.`);
  }
}

function verifyPersistedWrite(ledgerFile, expectedRaw, requestId, gateIndex, evidence) {
  let persistedRaw;
  let persisted;
  try {
    persistedRaw = fs.readFileSync(ledgerFile, 'utf8');
    persisted = JSON.parse(persistedRaw);
    ownerCapture.validateLedgerShape(persisted, ledgerFile);
  } catch (error) {
    throw new LedgerGateWriterError(
      'LEDGER_GATE_WRITE_VERIFY_FAILED',
      `The ledger could not be read back and validated after replacement: ${error.message || error}`
    );
  }
  if (persistedRaw !== expectedRaw) {
    fail('LEDGER_GATE_WRITE_VERIFY_FAILED', 'Ledger bytes differed after atomic replacement.');
  }
  const entry = persisted.requests.find(candidate => candidate && candidate.id === requestId);
  if (!entry || !Array.isArray(entry.gates) || !entry.gates[gateIndex]
      || entry.gates[gateIndex].met !== true
      || entry.gates[gateIndex].evidence !== evidence) {
    fail('LEDGER_GATE_WRITE_VERIFY_FAILED', 'The written gate did not round-trip to the requested met/evidence state.');
  }
}

/**
 * Mark one existing unmet gate as met with caller-supplied evidence.
 *
 * All tests and callers should pass a fixture path unless they are the
 * explicitly authorized live ledger mutation path.  The default is the real
 * ledger for the eventual route, but this function never creates it and has
 * no batch or sweep mode.
 */
function markGateMet(input) {
  const request = normalizeInput(input);
  let lock;
  try {
    lock = ownerCapture.acquireLedgerLock(request.ledgerFile);
  } catch (error) {
    if (error && error.code === 'OWNER_CAPTURE_LEDGER_LOCKED') {
      throw new LedgerGateWriterError('LEDGER_GATE_LOCKED', error.message);
    }
    throw error;
  }

  try {
    const { raw, data } = readLedger(request.ledgerFile);
    const requestIndex = data.requests.findIndex(candidate => candidate && candidate.id === request.requestId);
    if (requestIndex === -1) {
      fail('LEDGER_GATE_REQUEST_NOT_FOUND', `No request ${request.requestId} exists in the ledger.`);
    }

    const existingEntry = data.requests[requestIndex];
    const existingGate = validateRequestGateState(existingEntry, request.requestId, request.gateIndex);
    try {
      ownerCapture.assertRuntimeGateEvidence(existingGate.instruction, request.evidence, { required: true });
    } catch (error) {
      throw wrapOwnerCaptureError(error);
    }

    const nextGate = { ...existingGate, met: true, evidence: request.evidence };
    const nextGates = [...existingEntry.gates];
    nextGates[request.gateIndex] = nextGate;
    const nextCaptureLog = [
      ...(Array.isArray(existingEntry.captureLog) ? existingEntry.captureLog : []),
      {
        at: request.timestamp,
        actor: request.actor,
        mode: 'gate-met',
        gateIndex: request.gateIndex,
        evidenceLength: Buffer.byteLength(request.evidence, 'utf8')
      }
    ];
    const nextEntry = { ...existingEntry, gates: nextGates, captureLog: nextCaptureLog };
    assertRequestPreserved(existingEntry, nextEntry, request.requestId);

    const nextRequests = [...data.requests];
    nextRequests[requestIndex] = nextEntry;
    const nextData = ownerCapture.finalizeLedger(data, nextRequests);
    const expectedRaw = JSON.stringify(nextData, null, 2);

    try {
      ownerCapture.atomicWriteLedgerWithBackup(request.ledgerFile, raw, nextData);
    } catch (error) {
      throw wrapOwnerCaptureError(error);
    }
    verifyPersistedWrite(request.ledgerFile, expectedRaw, request.requestId, request.gateIndex, request.evidence);

    return Object.freeze({
      ok: true,
      requestId: request.requestId,
      gateIndex: request.gateIndex,
      ledgerFile: request.ledgerFile,
      backupFile: `${request.ledgerFile}.bak`,
      revision: nextData.revision,
      evidenceLength: Buffer.byteLength(request.evidence, 'utf8'),
      captureLogMode: 'gate-met'
    });
  } finally {
    lock.release();
  }
}

module.exports = {
  LedgerGateWriterError,
  markGateMet,
  normalizeInput,
  validateGateShape,
  validateRequestGateState,
  verifyPersistedWrite,
  MAX_ACTOR_LENGTH,
  MAX_EVIDENCE_LENGTH
};
