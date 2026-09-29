'use strict';

// Read-only composition for Q44.  The ledger projection decides which gates
// are open; the batch selector decides pagination.  This module only creates
// a stable opaque key joining those two contracts.  It never reads or writes
// the ledger itself.

const { MAX_GATE_ID_BYTES, selectGateBatch } = require('./owner-ledger-gate-batch');

const GATE_ID_PREFIX = 'olgs1.';

function fail(code) {
  throw new TypeError(`OWNER_LEDGER_GATE_SWEEP_${code}`);
}

function makeSweepGateId(requestId, gateIndex) {
  if (typeof requestId !== 'string' || requestId.trim() === '') fail('INVALID_REQUEST_ID');
  if (!Number.isSafeInteger(gateIndex) || gateIndex < 0 || Object.is(gateIndex, -0)) {
    fail('INVALID_GATE_INDEX');
  }

  const requestIdBytes = Buffer.from(requestId, 'utf8');
  if (requestIdBytes.toString('utf8') !== requestId) fail('INVALID_REQUEST_ID');
  const gateId = `${GATE_ID_PREFIX}${requestIdBytes.toString('base64url')}.${gateIndex}`;
  if (Buffer.byteLength(gateId, 'utf8') > MAX_GATE_ID_BYTES) fail('GATE_ID_TOO_LONG');
  return gateId;
}

function selectOpenGatesWithStableInstruction(ledgerOrRequests) {
  const requests = Array.isArray(ledgerOrRequests)
    ? ledgerOrRequests
    : ledgerOrRequests && ledgerOrRequests.requests;
  if (!Array.isArray(requests)) throw new TypeError('OWNER_LEDGER_OPEN_GATES_INVALID_LEDGER');

  const selected = [];
  for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
    const request = requests[requestIndex];
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_REQUEST:${requestIndex}`);
    }
    if (typeof request.id !== 'string' || request.id.trim() === '') {
      throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_REQUEST_ID:${requestIndex}`);
    }
    if (typeof request.status !== 'string' || request.status.trim() === '') {
      throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_REQUEST_STATUS:${request.id}`);
    }
    if (!Array.isArray(request.gates)) {
      throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_GATES:${request.id}`);
    }
    for (let gateIndex = 0; gateIndex < request.gates.length; gateIndex += 1) {
      const gate = request.gates[gateIndex];
      if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
        throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_GATE:${request.id}:${gateIndex}`);
      }
      if (typeof gate.met !== 'boolean') {
        throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_MET:${request.id}:${gateIndex}`);
      }
      if (gate.met !== false) continue;
      const instruction = gate.instruction;
      if (typeof instruction !== 'string' || instruction.trim() === '') {
        throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_INSTRUCTION:${request.id}:${gateIndex}`);
      }
      selected.push(Object.freeze({
        requestId: request.id,
        requestStatus: request.status,
        gateIndex,
        instruction
      }));
    }
  }
  return Object.freeze(selected);
}

/**
 * Convert the canonical open-gate projection into the closed batch schema.
 * `instruction` is carried byte-for-byte from the open-gate projection; no owner
 * instruction is interpreted, redacted, or synthesized here.
 *
 * @param {object[]|{requests: object[]}} ledgerOrRequests
 * @returns {readonly object[]}
 */
function selectOpenGateBatchEntries(ledgerOrRequests) {
  // Validate and copy `instruction` from one read so an accessor cannot change
  // after validation.
  const entries = selectOpenGatesWithStableInstruction(ledgerOrRequests).map(gate => Object.freeze({
    gateId: makeSweepGateId(gate.requestId, gate.gateIndex),
    requestId: gate.requestId,
    requestStatus: gate.requestStatus,
    gateIndex: gate.gateIndex,
    instruction: gate.instruction
  }));
  return Object.freeze(entries);
}

/**
 * Select one bounded, immutable page of canonical unmet gates.
 * Cursor and count intentionally share the strict contract of selectGateBatch:
 * callers pass `null` explicitly for the first page and 1..25 for count.
 *
 * @param {object[]|{requests: object[]}} ledgerOrRequests
 * @param {string|null} cursor
 * @param {number} count
 * @returns {{entries: readonly object[], nextCursor: string|null, total: number}}
 */
function selectOpenGateSweep(ledgerOrRequests, cursor, count) {
  return selectGateBatch({
    entries: selectOpenGateBatchEntries(ledgerOrRequests),
    cursor,
    count
  });
}

module.exports = { GATE_ID_PREFIX, makeSweepGateId, selectOpenGateBatchEntries, selectOpenGateSweep };
