'use strict';

const assert = require('node:assert/strict');
const { resolveFullySupersededRequests } = require('../src/lib/owner-request-scope');

let checks = 0;
function equal(actual, expected, message) { checks += 1; assert.deepEqual(actual, expected, message); }

function rule({ id, key, request, issuedAt, scopeKind = 'global', threadId = null }) {
  return {
    schemaVersion: 1,
    ruleId: id,
    ruleKey: key,
    scopeKind,
    threadId,
    sourceRequestId: request,
    issuedAt,
    expiresAt: null,
    decisionSummary: `${request} ${key}`,
    evidenceRefs: [],
    ownerVerbatim: `${request} verbatim`
  };
}

const rules = [
  rule({ id: 'rule_r1_old', key: 'archive.alpha', request: 'R1', issuedAt: '2026-08-01T00:00:00.000Z' }),
  rule({ id: 'rule_r2_new', key: 'archive.alpha', request: 'R2', issuedAt: '2026-08-02T00:00:00.000Z' }),
  rule({ id: 'rule_r1_other', key: 'archive.beta', request: 'R1', issuedAt: '2026-08-01T00:00:00.000Z' }),
  rule({ id: 'rule_r3_global', key: 'archive.thread-only', request: 'R3', issuedAt: '2026-08-01T00:00:00.000Z' }),
  rule({ id: 'rule_r4_thread', key: 'archive.thread-only', request: 'R4', issuedAt: '2026-08-03T00:00:00.000Z', scopeKind: 'thread', threadId: 'thread-a' }),
  rule({ id: 'rule_r5_thread', key: 'archive.global-later', request: 'R5', issuedAt: '2026-08-01T00:00:00.000Z', scopeKind: 'thread', threadId: 'thread-a' }),
  rule({ id: 'rule_r6_global', key: 'archive.global-later', request: 'R6', issuedAt: '2026-08-04T00:00:00.000Z' }),
  rule({ id: 'rule_r7_equal_a', key: 'archive.equal', request: 'R7', issuedAt: '2026-08-05T00:00:00.000Z' }),
  rule({ id: 'rule_r8_equal_b', key: 'archive.equal', request: 'R8', issuedAt: '2026-08-05T00:00:00.000Z' })
];

const resolved = resolveFullySupersededRequests(rules, { nowMs: Date.parse('2026-08-06T00:00:00.000Z') });
equal(resolved.map(item => item.sourceRequestId), ['R5'], 'only a request with every current rule strictly superseded qualifies');
equal(resolved[0].supersedingRequestIds, ['R6'], 'the later same-ruleKey request is retained as provenance');
equal(resolved[0].ruleIds, ['rule_r5_thread'], 'the complete losing rule set is reported');

const simple = resolveFullySupersededRequests(rules.slice(0, 2), { nowMs: Date.parse('2026-08-06T00:00:00.000Z') });
equal(simple.map(item => item.sourceRequestId), ['R1'], 'a single strict-older same-key loser is fully superseded');
equal(simple[0].supersedingRequestIds, ['R2'], 'simple superseding provenance is exact');

assert.throws(
  () => resolveFullySupersededRequests([rules[0], rules[0]], { nowMs: Date.parse('2026-08-06T00:00:00.000Z') }),
  error => error?.code === 'OWNER_SCOPE_AMBIGUOUS'
);
checks += 1;

process.stdout.write(`owner-request-archive-resolution: ${checks} checks passed\n`);
