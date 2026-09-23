'use strict';

// A deliberately small, shared projection of the owner ledger's unmet gates.
// It has no filesystem or mutation authority so dashboard/API callers and the
// command-line digest cannot disagree about which gates are still open.

function assertRequest(request, requestIndex) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_REQUEST:${requestIndex}`);
  }
  if (typeof request.id !== 'string' || request.id.trim() === '') {
    throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_REQUEST_ID:${requestIndex}`);
  }
  if (typeof request.status !== 'string' || request.status.trim() === '') {
    throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_REQUEST_STATUS:${request.id}`);
  }
}

/**
 * Select every gate whose canonical `met` value is exactly false, in the
 * ledger's request/gate order.  `instruction` is intentionally returned
 * byte-for-byte; callers must not summarize an owner instruction.
 *
 * @param {object[]|{requests: object[]}} ledgerOrRequests
 * @returns {{requestId:string, requestStatus:string, gateIndex:number, instruction:string}[]}
 */
function selectOpenGates(ledgerOrRequests) {
  const requests = Array.isArray(ledgerOrRequests)
    ? ledgerOrRequests
    : ledgerOrRequests && ledgerOrRequests.requests;
  if (!Array.isArray(requests)) throw new TypeError('OWNER_LEDGER_OPEN_GATES_INVALID_LEDGER');

  const selected = [];
  for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
    const request = requests[requestIndex];
    assertRequest(request, requestIndex);
    if (!Array.isArray(request.gates)) {
      throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_GATES:${request.id}`);
    }
    for (let gateIndex = 0; gateIndex < request.gates.length; gateIndex += 1) {
      const gate = request.gates[gateIndex];
      if (!gate || typeof gate !== 'object' || Array.isArray(gate)) {
        throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_GATE:${request.id}:${gateIndex}`);
      }
      // `met` must be a strict boolean, like every sibling field here. The
      // previous `gate.met !== false` treated a missing/null/malformed value
      // as SATISFIED and silently dropped the gate from reports/OPEN-GATES.md
      // -- the digest every agent reads at SESSION-BOOT -- so a single bad
      // ledger write could hide an owner gate from the whole fleet while
      // egress-preflight's assertGatesMet still (correctly) refused it.
      if (typeof gate.met !== 'boolean') {
        throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_MET:${request.id}:${gateIndex}`);
      }
      if (gate.met !== false) continue;
      if (typeof gate.instruction !== 'string' || gate.instruction.trim() === '') {
        throw new TypeError(`OWNER_LEDGER_OPEN_GATES_INVALID_INSTRUCTION:${request.id}:${gateIndex}`);
      }
      selected.push(Object.freeze({
        requestId: request.id,
        requestStatus: request.status,
        gateIndex,
        instruction: gate.instruction
      }));
    }
  }
  return Object.freeze(selected);
}

module.exports = { selectOpenGates };
