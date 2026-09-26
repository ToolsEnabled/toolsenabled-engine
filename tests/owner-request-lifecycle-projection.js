// EXECUTABLE CHANGE
// Direct contract tests for the lifecycle projection. Refusal cases assert the
// concrete error contract, caller-input immutability, and absence of filesystem
// writes or child-process spawns.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { projectRequestLifecycle } = require('../src/lib/owner-request-lifecycle-projection');

let checks = 0;
function check(name, work) {
  work();
  checks += 1;
  process.stdout.write(`  ok  ${name}\n`);
}
function isLifecycleError(code, message) {
  return error => error instanceof Error
    && error.name === 'OwnerRequestLifecycleError'
    && error.code === code
    && error.message === message;
}
function assertInvalid(input, message) {
  const before = structuredClone(input);
  let writes = 0;
  let spawns = 0;
  const originalWriteFileSync = fs.writeFileSync;
  const originalAppendFileSync = fs.appendFileSync;
  const originalSpawn = childProcess.spawn;
  const originalSpawnSync = childProcess.spawnSync;
  fs.writeFileSync = (...args) => { writes += 1; return originalWriteFileSync(...args); };
  fs.appendFileSync = (...args) => { writes += 1; return originalAppendFileSync(...args); };
  childProcess.spawn = (...args) => { spawns += 1; return originalSpawn(...args); };
  childProcess.spawnSync = (...args) => { spawns += 1; return originalSpawnSync(...args); };
  try {
    assert.throws(
      () => projectRequestLifecycle(input),
      isLifecycleError('OWNER_REQUEST_LIFECYCLE_INVALID', message)
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.appendFileSync = originalAppendFileSync;
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
  }
  assert.deepEqual(input, before, 'refusal must not mutate its caller-owned input');
  assert.equal(writes, 0, 'refusal must not write a file');
  assert.equal(spawns, 0, 'refusal must not spawn a process');
}
function rule(id, key, sourceRequestId, issuedAt, extra = {}) {
  return {
    schemaVersion: 1,
    ruleId: id,
    ruleKey: key,
    scopeKind: extra.scopeKind || 'global',
    threadId: extra.threadId || null,
    sourceRequestId,
    issuedAt,
    expiresAt: null,
    decisionSummary: `${sourceRequestId} ${key}`,
    evidenceRefs: [],
    ownerVerbatim: `${sourceRequestId} owner verbatim`
  };
}
const requests = [
  { id: 'R1', status: 'open', gates: [{ instruction: 'old', met: false, evidence: '' }] },
  { id: 'R2', status: 'open', gates: [{ instruction: 'new', met: false, evidence: '' }] },
  { id: 'R3', status: 'open', gates: [] },
  { id: 'R5', status: 'open', gates: [
    { instruction: 'older clause', met: false, evidence: '' },
    { instruction: 'surviving clause', met: false, evidence: '' }
  ] },
  { id: 'R6', status: 'open', gates: [{ instruction: 'newer clause', met: false, evidence: '' }] },
  { id: 'R25', status: 'open', verbatimAvailable: false },
  { id: 'R25.1', status: 'done', verbatimAvailable: false, versioningDisposition: {
    kind: 'legacy-duplicate-version-merge', activeId: 'R25.1', supersededIds: ['R25']
  } }
];
const retired = [{ id: 'R4', status: 'done', gates: [] }];
const rules = [
  rule('rule_r1_body', 'shared.alpha', 'R1', '2026-08-01T00:00:00.000Z'),
  rule('rule_r2_body', 'shared.alpha', 'R2', '2026-08-02T00:00:00.000Z'),
  rule('rule_r3_shared', 'shared.beta', 'R3', '2026-08-01T00:00:00.000Z'),
  rule('rule_r3_unique', 'request.r3.unique', 'R3', '2026-08-01T00:00:00.000Z'),
  rule('rule_r5_gate_001', 'request.r5.gate.001', 'R5', '2026-08-01T00:00:00.000Z'),
  rule('rule_r5_gate_002', 'request.r5.gate.002', 'R5', '2026-08-01T00:00:00.000Z'),
  rule('rule_r6_gate_001', 'request.r5.gate.001', 'R6', '2026-08-04T00:00:00.000Z'),
  rule('rule_r4_retired', 'request.r4.body', 'R4', '2026-08-03T00:00:00.000Z')
];
const retirements = [
  {
    targetKind: 'request', requestId: 'R4', retiredAt: '2026-08-07T00:00:00.000Z', retiredBy: 'owner',
    reason: { code: 'completed', detail: 'All work verified.', supersedingRequestIds: [] }
  },
  {
    targetKind: 'rule', requestId: 'R3', ruleKey: 'shared.beta', retiredAt: '2026-08-07T01:00:00.000Z', retiredBy: 'owner',
    reason: { code: 'owner-confirmed', detail: 'Only this clause retired.', supersedingRequestIds: ['R2'] }
  }
];
const original = JSON.stringify({ requests, retired, retirements, rules });
const projected = projectRequestLifecycle({
  activeRequests: requests,
  retiredRequests: retired,
  retirements,
  rules,
  nowMs: Date.parse('2026-08-08T00:00:00.000Z')
});

check('every request appears exactly once across active, superseded, and retired', () => {
  const ids = [...projected.active, ...projected.superseded, ...projected.retired].map(item => item.requestId);
  assert.equal(ids.length, requests.length + retired.length);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(projected.preservesEveryRequest, true);
  assert.deepEqual(projected.counts, { active: 5, superseded: 2, retired: 1 });
});

check('a fully losing request is superseded with winner provenance', () => {
  const item = projected.superseded.find(candidate => candidate.requestId === 'R1');
  assert.deepEqual(item.disposition.supersededBy, ['R2']);
  assert.deepEqual(item.disposition.reasons, ['scope-rule-superseded']);
  assert.deepEqual(item.disposition.ruleIds, ['rule_r1_body']);
});

check('P3 duplicate metadata supersedes an unavailable-verbatim root without a scope rule', () => {
  const item = projected.superseded.find(candidate => candidate.requestId === 'R25');
  assert.deepEqual(item.disposition.supersededBy, ['R25.1']);
  assert.deepEqual(item.disposition.reasons, ['legacy-duplicate-version-merge']);
});

check('a request with one surviving clause remains active', () => {
  const item = projected.active.find(candidate => candidate.requestId === 'R3');
  assert.ok(item);
  assert.deepEqual(item.ruleRetirements.map(retirement => retirement.ruleKey), ['shared.beta']);
  assert.equal(projected.ruleResolution.activeRuleIds.includes('rule_r3_shared'), false);
  assert.equal(projected.ruleResolution.activeRuleIds.includes('rule_r3_unique'), true);
  assert.equal(projected.superseded.some(item => item.requestId === 'R3'), false);
});

check('an active request exposes only its losing clause as superseded', () => {
  const item = projected.active.find(candidate => candidate.requestId === 'R5');
  assert.ok(item);
  assert.deepEqual(item.ruleSupersessions.map(value => value.ruleKey), ['request.r5.gate.001']);
  assert.deepEqual(item.ruleSupersessions[0].winners.map(value => value.sourceRequestId), ['R6']);
  assert.equal(item.ruleSupersessions.some(value => value.ruleKey === 'request.r5.gate.002'), false);
});

check('retirement is separate, takes precedence over its scope rule, and keeps metadata', () => {
  const item = projected.retired[0];
  assert.equal(item.requestId, 'R4');
  assert.equal(item.retirement.targetKind, 'request');
  assert.equal(item.retirement.reason.code, 'completed');
  assert.deepEqual(item.request, retired[0], 'archived request payload remains field-preserved');
  assert.equal(projected.ruleResolution.activeRuleIds.includes('rule_r4_retired'), false);
});

check('the resolver output is the single rule-state source', () => {
  assert.ok(projected.ruleResolution.activeRuleIds.includes('rule_r2_body'));
  assert.ok(projected.ruleResolution.supersededRuleIds.includes('rule_r1_body'));
  assert.equal(projected.ruleResolution.contexts.length, 1);
});

check('projection is pure and immutable at its public boundaries', () => {
  assert.equal(JSON.stringify({ requests, retired, retirements, rules }), original);
  assert.equal(projected.readOnly, true);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.active), true);
});

check('active/archive overlap and malformed P3 metadata fail closed', () => {
  assert.throws(() => projectRequestLifecycle({
    activeRequests: requests,
    retiredRequests: [{ id: 'R1', status: 'done' }],
    retirements: [],
    rules: [],
    nowMs: 1
  }), isLifecycleError(
    'OWNER_REQUEST_LIFECYCLE_OVERLAP',
    'R1 exists in both active and archive ledgers.'
  ));
  const malformed = structuredClone(requests);
  malformed.find(item => item.id === 'R25.1').versioningDisposition.supersededIds = ['R999'];
  assert.throws(() => projectRequestLifecycle({
    activeRequests: malformed,
    retiredRequests: [],
    retirements: [],
    rules: [],
    nowMs: 1
  }), isLifecycleError(
    'OWNER_REQUEST_LIFECYCLE_P3_INVALID',
    'Legacy superseded id on R25.1 is invalid.'
  ));
});

check('archived payloads and rule retirements require separate complete records', () => {
  assert.throws(() => projectRequestLifecycle({
    activeRequests: requests,
    retiredRequests: retired,
    retirements: [],
    rules,
    nowMs: 1
  }), isLifecycleError(
    'OWNER_REQUEST_LIFECYCLE_RETIREMENT_INVALID',
    'Archived request R4 has no request-level retirement record.'
  ));
  const wrongRule = structuredClone(retirements);
  wrongRule[1].ruleKey = 'shared.alpha';
  assert.throws(() => projectRequestLifecycle({
    activeRequests: requests,
    retiredRequests: retired,
    retirements: wrongRule,
    rules,
    nowMs: Date.parse('2026-08-08T00:00:00.000Z')
  }), isLifecycleError(
    'OWNER_REQUEST_LIFECYCLE_RETIREMENT_INVALID',
    'Rule retirement rule:R3:shared.alpha does not match an active request rule.'
  ));
});

check('invalid projection envelope refuses before side effects', () => {
  assertInvalid({
    activeRequests: [], retiredRequests: [], retirements: [], rules: [], nowMs: -1
  }, 'Lifecycle projection input is invalid.');
});

check('oversized request ledgers refuse before side effects', () => {
  assertInvalid({
    activeRequests: Array(5001).fill(null), retiredRequests: [], retirements: [], rules: [], nowMs: 0
  }, 'active ledger requests are invalid.');
});

check('invalid and duplicate request records refuse before side effects', () => {
  assertInvalid({
    activeRequests: [{ id: 'not-a-request-id' }], retiredRequests: [], retirements: [], rules: [], nowMs: 0
  }, 'active ledger contains an invalid or duplicate request.');
  assertInvalid({
    activeRequests: [{ id: 'R40' }, { id: 'R40' }], retiredRequests: [], retirements: [], rules: [], nowMs: 0
  }, 'active ledger contains an invalid or duplicate request.');
});

check('duplicate normalized rule ids refuse before side effects', () => {
  const duplicate = rule('rule_duplicate', 'request.r41.body', 'R41', '2026-08-01T00:00:00.000Z');
  assertInvalid({
    activeRequests: [{ id: 'R41' }], retiredRequests: [], retirements: [],
    rules: [duplicate, { ...duplicate, ruleKey: 'request.r41.gate.001' }], nowMs: 0
  }, 'Duplicate rule id rule_duplicate.');
});

check('a global rule overridden only in one thread remains active and visible', () => {
  const global = rule('rule_r7_global', 'thread.override', 'R7', '2026-08-01T00:00:00.000Z');
  const thread = rule('rule_r8_thread', 'thread.override', 'R8', '2026-08-02T00:00:00.000Z', {
    scopeKind: 'thread', threadId: 'thread-a'
  });
  const result = projectRequestLifecycle({
    activeRequests: [
      { id: 'R7', status: 'open', gates: [{ instruction: 'global remains', met: false, evidence: '' }] },
      { id: 'R8', status: 'open', gates: [{ instruction: 'thread override', met: false, evidence: '' }] }
    ],
    retiredRequests: [],
    retirements: [],
    rules: [global, thread],
    nowMs: Date.parse('2026-08-08T00:00:00.000Z')
  });
  const globalItem = result.active.find(item => item.requestId === 'R7');
  assert.ok(globalItem);
  assert.deepEqual(globalItem.ruleSupersessions, []);
  assert.ok(result.ruleResolution.activeRuleIds.includes('rule_r7_global'));
});

check('an unsafe body slot can be superseded while safe body and gate slots stay active', () => {
  const result = projectRequestLifecycle({
    activeRequests: [{ id: 'R219', status: 'open', gates: [{ instruction: 'safe mechanical reset', met: false, evidence: '' }] },
      { id: 'R1163', status: 'open', gates: [] }],
    retiredRequests: [],
    retirements: [],
    rules: [
      rule('rule_r219_unsafe', 'request.r219.body.unsafe', 'R219', '2026-08-01T00:00:00.000Z'),
      rule('rule_r219_safe', 'request.r219.body.safe.001', 'R219', '2026-08-01T00:00:00.000Z'),
      rule('rule_r219_gate', 'request.r219.gate.001', 'R219', '2026-08-01T00:00:00.000Z'),
      rule('rule_r1163_winner', 'request.r219.body.unsafe', 'R1163', '2026-08-07T00:00:00.000Z')
    ],
    nowMs: Date.parse('2026-08-08T00:00:00.000Z')
  });
  const mixed = result.active.find(item => item.requestId === 'R219');
  assert.ok(mixed);
  assert.deepEqual(mixed.ruleSupersessions.map(value => value.ruleKey), ['request.r219.body.unsafe']);
  assert.ok(result.ruleResolution.activeRuleIds.includes('rule_r219_safe'));
  assert.ok(result.ruleResolution.activeRuleIds.includes('rule_r219_gate'));
  assert.equal(result.superseded.some(item => item.requestId === 'R219'), false);
});

console.log(`owner-request-lifecycle-projection: ${checks} checks passed`);
