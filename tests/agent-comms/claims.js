// EXECUTABLE CHANGE
/*
Report: testcanfail-tests-agent-comms-claims-js

FOUND (shape 1): collection-derived assertions over conflict claims, conflict-event
claims, and history-chain claims did not state their required cardinality. Added
explicit cardinality assertions before those collections are mapped or indexed.

Mutation evidence (temporary changes to src/lib/agent-comms/claims.js):
- Replaced conflictView's record mapping with an empty array. RED:
  "both conflicting claims must be present\n\n0 !== 2"
  and "freshness must cover both conflicting claims\n\n0 !== 2".
- Replaced historical conflict-event claim mapping with an empty array. RED:
  "the conflict event must retain both claims\n\n0 !== 2".
- Replaced history-chain claim contents with an empty array. RED:
  "the author chain must retain both claims\n\n0 !== 2".

NOT-FOUND (shape 2): no exit-status or bare truthy-return assertion.
NOT-FOUND (shape 3): no try/catch or optional-chain swallowing a failure.
NOT-FOUND (shape 4): no mock of the claims implementation under test; the injected
clock controls time only.
NOT-FOUND (shape 5): no skip or platform precondition guard.
NOT-FOUND (shape 6): no expected value computed by the implementation under test.

Restoration: source SHA-256 before and after every mutation was
82fc9d26a3bd259909a8786bf0de9bdc3301bec37f97cedc85e7bc6eaf9515a6.
No precondition was unmet. After exact restoration, that full-file run was GREEN.
*/
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CLAIM_KINDS,
  ClaimsError,
  DOES_NOT_EXPIRE,
  EVIDENCE_KINDS,
  EVIDENCE_STATUS,
  createClaims
} = require('../../src/lib/agent-comms/claims');

function fixture(startMs = 10_000) {
  let time = startMs;
  const claims = createClaims({ now: () => time });
  return {
    claims,
    advance(ms) { time += ms; },
    setTime(ms) { time = ms; }
  };
}

function finding(reference) {
  return { kind: EVIDENCE_KINDS.COMMAND, reference };
}

function refusal(code, operation) {
  assert.throws(operation, error => {
    assert.ok(error instanceof ClaimsError);
    assert.equal(error.code, code);
    return true;
  });
}

test('a fresh claim reads as CURRENT with its exact age and value', () => {
  const { claims, advance } = fixture();
  const asserted = claims.assert({
    subject: 'machine-b/bridge:8788/reachable',
    kind: CLAIM_KINDS.PORT_PROBE,
    author: 'coordinator',
    value: false,
    asOfMs: 10_000,
    evidence: finding('tcp-probe-receipt-1')
  });
  assert.equal(asserted.status, 'CURRENT');
  assert.equal(asserted.value, false);

  advance(45_678);
  const read = claims.read({ subject: 'machine-b/bridge:8788/reachable' });
  assert.equal(read.status, 'CURRENT');
  assert.equal(read.ageMs, 45_678);
  assert.equal(read.claim.freshness.ageMs, 45_678);
  assert.equal(read.value, false);
});

test('past the validity budget a read is STALE with exact age and no current value shape', () => {
  const { claims, advance } = fixture();
  claims.assert({
    subject: 'machine-b/bridge:8788/reachable',
    kind: CLAIM_KINDS.PORT_PROBE,
    author: 'coordinator',
    value: false,
    asOfMs: 10_000,
    evidence: finding('tcp-probe-receipt-1')
  });

  advance(120_001);
  const stale = claims.read({ subject: 'machine-b/bridge:8788/reachable' });
  assert.equal(stale.status, 'STALE');
  assert.equal(stale.ageMs, 120_001);
  assert.equal(stale.presentation.valueWithheld, true);
  assert.equal(Object.hasOwn(stale, 'value'), false);
  assert.equal(Object.hasOwn(stale, 'claim'), false);
  assert.match(claims.render(stale), /STALE — VALUE WITHHELD/);
});

test('DOES_NOT_EXPIRE is explicit and a non-expiring config fact never goes stale', () => {
  const { claims, advance } = fixture();
  claims.assert({
    subject: 'bridge/config/listen-port',
    kind: CLAIM_KINDS.CONFIG,
    author: 'machine-b',
    value: 8788,
    asOfMs: 10_000,
    evidence: { kind: EVIDENCE_KINDS.LOG_LINE, reference: 'config-snapshot#line-18' }
  });
  advance(Number.MAX_SAFE_INTEGER - 20_000);

  const read = claims.read({ subject: 'bridge/config/listen-port' });
  assert.equal(read.status, 'CURRENT');
  assert.equal(read.claim.validity.mode, DOES_NOT_EXPIRE);
  assert.equal(read.claim.freshness.validity.mode, DOES_NOT_EXPIRE);
  assert.equal(read.value, 8788);
});

test('different claim kinds carry different default validity budgets', () => {
  const { claims, advance } = fixture();
  claims.assert({
    subject: 'bridge/health',
    kind: CLAIM_KINDS.HEALTH,
    author: 'machine-b',
    value: 'ok',
    asOfMs: 10_000,
    evidence: finding('health-receipt-1')
  });
  claims.assert({
    subject: 'bridge/status',
    kind: CLAIM_KINDS.STATUS,
    author: 'machine-b',
    value: 'running',
    asOfMs: 10_000,
    evidence: finding('status-receipt-1')
  });
  advance(90_000);

  assert.equal(claims.read({ subject: 'bridge/health' }).status, 'STALE');
  assert.equal(claims.read({ subject: 'bridge/status' }).status, 'CURRENT');
});

test('conflicting agents raise CONFLICT carrying both claims, times, authors, and evidence', () => {
  const { claims, setTime } = fixture();
  claims.assert({
    subject: 'machine-b/bridge:8788/reachable',
    kind: CLAIM_KINDS.PORT_PROBE,
    author: 'coordinator',
    value: false,
    asOfMs: 10_000,
    evidence: finding('tcp-probe-receipt-closed')
  });
  setTime(11_000);
  const conflict = claims.assert({
    subject: 'machine-b/bridge:8788/reachable',
    kind: CLAIM_KINDS.PORT_PROBE,
    author: 'machine-b',
    value: true,
    asOfMs: 11_000,
    evidence: { kind: EVIDENCE_KINDS.RECEIPT, reference: 'bridge-start-receipt-open' }
  });

  assert.equal(conflict.status, 'CONFLICT');
  assert.equal(conflict.adjudication, 'NONE');
  assert.equal(conflict.claims.length, 2, 'both conflicting claims must be present');
  assert.deepEqual(conflict.claims.map(claim => claim.author), ['coordinator', 'machine-b']);
  assert.deepEqual(conflict.claims.map(claim => claim.asOfMs), [10_000, 11_000]);
  assert.deepEqual(conflict.claims.map(claim => claim.value), [false, true]);
  assert.deepEqual(conflict.claims.map(claim => claim.evidence.reference), [
    'tcp-probe-receipt-closed', 'bridge-start-receipt-open'
  ]);
});

test('conflict is not auto-resolved by freshness and no API returns a winner', () => {
  const { claims, advance, setTime } = fixture();
  claims.assert({
    subject: 'machine-b/bridge:8788/reachable',
    kind: CLAIM_KINDS.PORT_PROBE,
    author: 'coordinator',
    value: false,
    asOfMs: 10_000,
    evidence: finding('tcp-probe-receipt-closed')
  });
  setTime(11_000);
  claims.assert({
    subject: 'machine-b/bridge:8788/reachable',
    kind: CLAIM_KINDS.PORT_PROBE,
    author: 'machine-b',
    value: true,
    asOfMs: 11_000,
    evidence: finding('tcp-probe-receipt-open')
  });
  advance(200_000);

  const conflict = claims.read({ subject: 'machine-b/bridge:8788/reachable' });
  assert.equal(conflict.status, 'CONFLICT');
  assert.match(conflict.freshnessHint.label, /HINT ONLY — NOT A VERDICT/);
  assert.match(conflict.freshnessHint.explanation, /not automatically correct/);
  assert.equal(Object.hasOwn(conflict, 'winner'), false);
  assert.equal(Object.hasOwn(conflict, 'preferredClaim'), false);
  assert.equal(Object.hasOwn(conflict, 'value'), false);
  assert.equal(conflict.claims.length, 2, 'freshness must cover both conflicting claims');
  assert.deepEqual(conflict.claims.map(claim => claim.freshness.status), ['STALE', 'STALE']);
  assert.match(claims.render(conflict), /CONFLICT — NOT ADJUDICATED/);

  const events = claims.conflicts({ subject: 'machine-b/bridge:8788/reachable' });
  assert.equal(events.conflicts.length, 1);
  assert.equal(events.conflicts[0].claims.length, 2, 'the conflict event must retain both claims');
  assert.equal(events.conflicts[0].adjudication, 'NONE');
  assert.equal(Object.hasOwn(events.conflicts[0], 'winner'), false);
});

test('an unevidenced assertion is visibly distinct from an evidenced finding', () => {
  const { claims } = fixture();
  const assertion = claims.assert({
    subject: 'bridge/claimed-status',
    kind: CLAIM_KINDS.STATUS,
    author: 'agent-a',
    value: 'running',
    asOfMs: 10_000
  });
  const findingResult = claims.assert({
    subject: 'bridge/measured-status',
    kind: CLAIM_KINDS.STATUS,
    author: 'agent-a',
    value: 'running',
    asOfMs: 10_000,
    evidence: finding('status-command-receipt')
  });

  assert.equal(assertion.claim.evidence.status, EVIDENCE_STATUS.UNEVIDENCED);
  assert.equal(assertion.claim.evidence.label, 'UNEVIDENCED ASSERTION');
  assert.match(claims.render(assertion), /^\[UNEVIDENCED ASSERTION\]/);
  assert.equal(findingResult.claim.evidence.status, EVIDENCE_STATUS.EVIDENCED);
  assert.equal(findingResult.claim.evidence.label, 'EVIDENCED FINDING');
  assert.match(claims.render(findingResult), /^\[EVIDENCED FINDING\]/);
});

test('configuration, argument, validity, value, and evidence refusals happen before a claim is written', () => {
  refusal('CLAIMS_CONFIGURATION_INVALID', () => createClaims({ now: 12 }));
  refusal('CLAIMS_CONFIGURATION_INVALID', () => createClaims({ validityBudgets: [] }));

  let idCalls = 0;
  const claims = createClaims({
    now: () => 10_000,
    idFactory(type, sequence) {
      idCalls += 1;
      return `${type}-${sequence}`;
    }
  });
  const base = {
    subject: 'bridge/refusal', author: 'agent-a', kind: CLAIM_KINDS.STATUS, asOfMs: 10_000, value: 'ok'
  };
  const cases = [
    ['CLAIMS_INVALID_ARGUMENT', { ...base, value: undefined }, input => { delete input.value; }],
    ['CLAIMS_VALIDITY_REQUIRED', { ...base, kind: 'custom-kind' }],
    ['CLAIMS_VALIDITY_INVALID', { ...base, validity: -1 }],
    ['CLAIMS_VALUE_INVALID', { ...base, value: Number.NaN }],
    ['CLAIMS_EVIDENCE_INVALID', { ...base, evidence: { kind: 'guess', reference: 'none' } }]
  ];
  for (const [code, original, prepare] of cases) {
    const input = { ...original };
    if (prepare) prepare(input);
    refusal(code, () => claims.assert(input));
    assert.equal(claims.read({ subject: base.subject }).status, 'ABSENT', `${code} must not write a claim`);
    assert.equal(idCalls, 0, `${code} must not allocate an id`);
  }
});

test('clock and supersession refusals preserve the prior active claim', () => {
  let time = 10_000;
  let idCalls = 0;
  const claims = createClaims({ now: () => time, idFactory: type => `${type}-${++idCalls}` });
  const base = {
    subject: 'bridge/clock', author: 'agent-a', kind: CLAIM_KINDS.STATUS, asOfMs: 10_000, value: 'first'
  };

  claims.assert(base);
  refusal('CLAIMS_OBSERVATION_IN_FUTURE', () => claims.assert({ ...base, asOfMs: 10_001, value: 'future' }));
  refusal('CLAIMS_SUPERSESSION_NOT_NEWER', () => claims.assert({ ...base, value: 'not-newer' }));
  assert.equal(idCalls, 1, 'refused assertions must not allocate another claim id');
  assert.equal(claims.read({ subject: base.subject }).value, 'first');
  assert.equal(claims.history({ subject: base.subject }).chains[0].claims.length, 1);

  time = Number.NaN;
  refusal('CLAIMS_CLOCK_INVALID', () => claims.read({ subject: base.subject }));
  time = 9_999;
  refusal('CLAIMS_CLOCK_BEFORE_OBSERVATION', () => claims.read({ subject: base.subject }));
  time = 10_000;
  assert.equal(claims.read({ subject: base.subject }).value, 'first');
  assert.equal(idCalls, 1);
});

test('retraction and render refusals do not alter the active claim', () => {
  const claims = createClaims({ now: () => 10_000 });
  const current = claims.assert({
    subject: 'bridge/retract', author: 'agent-a', kind: CLAIM_KINDS.STATUS, asOfMs: 10_000, value: 'active'
  });
  const claimId = current.claim.claimId;

  refusal('CLAIMS_RETRACTION_NOT_OWN_ACTIVE_CLAIM', () => claims.retract({
    subject: 'bridge/retract', author: 'agent-a', claimId: 'claim-someone-else'
  }));
  refusal('CLAIMS_RETRACTION_TIME_INVALID', () => claims.retract({
    subject: 'bridge/retract', author: 'agent-a', claimId, retractedAtMs: 9_999
  }));
  refusal('CLAIMS_RENDER_INVALID', () => claims.render({ status: 'HISTORY', subject: 'bridge/retract' }));

  const after = claims.read({ subject: 'bridge/retract' });
  assert.equal(after.status, 'CURRENT');
  assert.equal(after.claim.claimId, claimId);
  assert.equal(claims.history({ subject: 'bridge/retract' }).chains[0].claims[0].lifecycle, 'ACTIVE');
});

test('self-supersession preserves a readable author chain', () => {
  const { claims, setTime } = fixture();
  const first = claims.assert({
    subject: 'machine-b/bridge:8788/reachable',
    kind: CLAIM_KINDS.PORT_PROBE,
    author: 'coordinator',
    value: false,
    asOfMs: 10_000,
    evidence: finding('tcp-probe-receipt-closed')
  });
  setTime(20_000);
  const second = claims.assert({
    subject: 'machine-b/bridge:8788/reachable',
    kind: CLAIM_KINDS.PORT_PROBE,
    author: 'coordinator',
    value: true,
    asOfMs: 20_000,
    evidence: finding('tcp-probe-receipt-open')
  });

  assert.equal(second.status, 'CURRENT');
  assert.equal(second.value, true);
  assert.equal(second.claim.supersedes, first.claim.claimId);

  const history = claims.history({ subject: 'machine-b/bridge:8788/reachable' });
  assert.equal(history.status, 'HISTORY');
  assert.match(history.warning, /not current observations/);
  assert.equal(history.chains.length, 1);
  assert.equal(history.chains[0].author, 'coordinator');
  assert.equal(history.chains[0].claims.length, 2, 'the author chain must retain both claims');
  assert.deepEqual(history.chains[0].claims.map(claim => claim.value), [false, true]);
  assert.deepEqual(history.chains[0].claims.map(claim => claim.lifecycle), ['SUPERSEDED', 'ACTIVE']);
  assert.equal(history.chains[0].claims[0].supersededBy, second.claim.claimId);
  assert.equal(history.chains[0].claims[1].supersedes, first.claim.claimId);
});

test('retraction is explicit and limited to the author own active claim', () => {
  const { claims, setTime } = fixture();
  const current = claims.assert({
    subject: 'bridge/health',
    kind: CLAIM_KINDS.HEALTH,
    author: 'machine-b',
    value: 'ok',
    asOfMs: 10_000,
    evidence: finding('health-receipt')
  });
  assert.throws(
    () => claims.retract({
      subject: 'bridge/health',
      author: 'coordinator',
      claimId: current.claim.claimId
    }),
    error => error instanceof ClaimsError && error.code === 'CLAIMS_RETRACTION_NOT_FOUND'
  );

  setTime(11_000);
  const retracted = claims.retract({
    subject: 'bridge/health',
    author: 'machine-b',
    claimId: current.claim.claimId,
    retractedAtMs: 11_000,
    reason: 'probe invalidated'
  });
  assert.equal(retracted.status, 'RETRACTED');
  assert.equal(claims.read({ subject: 'bridge/health' }).status, 'ABSENT');
  assert.equal(claims.history({ subject: 'bridge/health' }).chains[0].claims[0].lifecycle, 'RETRACTED');
});
