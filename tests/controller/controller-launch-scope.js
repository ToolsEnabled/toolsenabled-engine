// EXECUTABLE CHANGE
'use strict';

// Q64: focused launch-boundary coverage.  This deliberately injects a small
// in-memory audit double so it proves scope resolution and record round-trip
// without depending on the production audit signer/key material.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const launch = require('../../src/lib/controller-launch-record');
const agentOrg = require('../../src/lib/agent-org');
const spawnRecord = require('../../tools/spawn-record');

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const code = (fn, expected, label) => assert.throws(fn,
  error => error && error.code === expected, `${label || ''}: expected ${expected}`);

const org = agentOrg.normalizeOrg({
  revision: 1,
  agents: [
    { id: 'claude', displayName: 'Claude', role: 'controller', provider: 'codex', enabled: true },
    { id: 'luna', displayName: 'Luna', role: 'builder', provider: 'codex', enabled: true, phasePriority: [] },
    { id: 'terra', displayName: 'Terra', role: 'reviewer', provider: 'codex', enabled: true, phasePriority: [] }
  ],
  relationships: [
    { from: 'claude', to: 'luna', type: 'manages' },
    { from: 'claude', to: 'terra', type: 'manages' }
  ]
});

function makeAudit(clock) {
  const events = [];
  let sequence = 0;
  return {
    events,
    requireRecord(action, target, details) {
      sequence += 1;
      const entry = {
        sequence,
        eventId: `scope-evt-${sequence}`,
        eventHash: hash(`${action}:${target}:${sequence}`),
        event: { action, target, details, timestamp: new Date(clock()).toISOString() }
      };
      events.push(entry);
      return { durable: true, anchored: true, sequence, eventHash: entry.eventHash };
    },
    findEvents({ action, target, limit = 100 }) {
      return events.filter(entry => entry.event.action === action && entry.event.target === target).slice(0, limit);
    },
    tail(limit = 20) {
      return events.slice(-limit).map(entry => ({ ...entry.event, sequence: entry.sequence,
        eventId: entry.eventId, eventHash: entry.eventHash }));
    }
  };
}

const baseRequest = (overrides = {}) => ({
  requestingActor: 'claude',
  targetAgentId: 'luna',
  tier: 'cheap',
  model: 'luna-cheap-tier',
  objectiveRef: 'Q27',
  cap: { kind: 'turns', value: 20, capMs: 2 * 60 * 60 * 1000 },
  parentLaunchId: null,
  ...overrides
});

const rule = (overrides = {}) => ({
  schemaVersion: 1,
  ruleId: 'rule_global_launch_scope',
  ruleKey: 'work.mode',
  scopeKind: 'global',
  threadId: null,
  sourceRequestId: 'R173',
  issuedAt: '2023-11-14T22:13:18.000Z',
  expiresAt: null,
  decisionSummary: 'Use the bounded launch work mode.',
  evidenceRefs: ['reports/OWNER-REQUEST-LEDGER.json#R173'],
  ownerVerbatim: 'this launch scope is explicit.',
  ...overrides
});

const nowMs = 1_700_000_000_000;
const clock = () => nowMs;
const audit = makeAudit(clock);
const globalRule = rule();
const threadRule = rule({
  ruleId: 'rule_thread_launch_scope',
  scopeKind: 'thread',
  threadId: 'thread-a',
  sourceRequestId: 'R174',
  issuedAt: '2023-11-14T22:13:19.000Z',
  decisionSummary: 'Thread A receives the narrower launch rule.',
  ownerVerbatim: 'this launch rule is only for thread A.'
});

const threadA = launch.createLaunch(baseRequest({ threadId: 'thread-a',
  scopeRules: [globalRule, threadRule] }), { org, audit, clock });
assert.equal(threadA.record.scopePacket.threadId, 'thread-a');
assert.deepEqual(threadA.record.scopePacket.appliedRuleIds, ['rule_thread_launch_scope']);
assert.equal(threadA.record.scopePacket.rules[0].ownerVerbatim, 'this launch rule is only for thread A.');
assert.equal(threadA.record.scopePacket.grantsAuthority, false);
assert.equal(threadA.record.scopePacket.agentId, 'luna');
assert.equal(threadA.record.scopePacket.rules[0].schemaVersion, undefined,
  'nested dispatch rules carry the packet version only once');
const threadAReadBack = launch.launchFromAuditEvent(audit.events[0]);
assert.deepEqual(threadAReadBack.scopePacket, threadA.record.scopePacket,
  'scope packet survives signed launch round-trip');
assert.equal(threadAReadBack.scopePacket.rules[0].decisionSummary, threadRule.decisionSummary,
  'signed launch round-trip preserves the independently supplied decision summary');

const threadB = launch.createLaunch(baseRequest({ threadId: 'thread-b',
  scopeRules: [globalRule, threadRule] }), { org, audit, clock });
assert.equal(threadB.record.scopePacket.threadId, 'thread-b');
assert.deepEqual(threadB.record.scopePacket.appliedRuleIds, ['rule_global_launch_scope'],
  'thread A rule does not leak to thread B');
assert.equal(threadB.record.scopePacket.rules[0].ownerVerbatim, globalRule.ownerVerbatim);

const unknownThread = launch.createLaunch(baseRequest({ threadId: 'unknown-thread',
  scopeRules: [globalRule, threadRule] }), { org, audit, clock });
assert.deepEqual(unknownThread.record.scopePacket.appliedRuleIds, ['rule_global_launch_scope'],
  'an unknown thread id receives only the global rule');

const handoff = launch.createLaunch(baseRequest({ requestingActor: 'luna', targetAgentId: 'terra',
  objectiveRef: 'handoff', threadId: 'thread-a', scopeRules: [globalRule, threadRule] }), { org, audit, clock });
assert.equal(handoff.record.scopePacket.agentId, 'terra');
assert.deepEqual(handoff.record.scopePacket.appliedRuleIds, ['rule_thread_launch_scope'],
  'a same-thread handoff preserves the exact thread-local rule without widening it');

const unbound = launch.createLaunch(baseRequest({ scopeRules: [globalRule, threadRule] }), { org, audit, clock });
assert.equal(unbound.record.scopePacket.threadId, null);
assert.deepEqual(unbound.record.scopePacket.appliedRuleIds, ['rule_global_launch_scope'],
  'missing thread identity receives global scope only');

const legacy = launch.createLaunch(baseRequest(), { org, audit, clock });
assert.equal(Object.hasOwn(legacy.record, 'scopePacket'), false,
  'legacy launch shape remains unscoped when no explicit rules are supplied');

const helperLaunch = spawnRecord.recordSpawn({
  requestingActor: 'claude', targetAgentId: 'luna', objectiveRef: 'Q27', model: 'luna-cheap-tier',
  threadId: 'thread-a', scopeRules: [globalRule, threadRule]
}, { org, audit, clock });
assert.equal(helperLaunch.record.scopePacket.threadId, 'thread-a',
  'the standard spawn helper forwards explicit thread identity');
assert.deepEqual(helperLaunch.record.scopePacket.appliedRuleIds, ['rule_thread_launch_scope'],
  'the standard spawn helper forwards explicit scope rules');

const eventsBeforeRefusal = audit.events.length;
code(() => launch.createLaunch(baseRequest({ threadId: 'thread-a' }), { org, audit, clock }),
  'LAUNCH_SCOPE_INVALID', 'thread identity without explicit rules');
code(() => launch.createLaunch(baseRequest({ threadId: 'thread-a', scopeRules: [
  rule({ ruleId: 'rule_bad_scope', scopeKind: 'thread', threadId: null })
] }), { org, audit, clock }), 'LAUNCH_SCOPE_INVALID', 'ambiguous scope rule');
assert.equal(audit.events.length, eventsBeforeRefusal, 'scope refusal writes no audit event');

const tampered = JSON.parse(JSON.stringify(audit.events[0]));
tampered.event.details.record.scopePacket.rules[0].schemaVersion = 1;
code(() => launch.launchFromAuditEvent(tampered), 'LAUNCH_SCOPE_INVALID',
  'nested scope version cannot be smuggled into a dispatch packet');

// Discrimination report (testcanfail-tests-controller-controller-launch-scope-js):
// - COMPUTED-BY-SAME-CODE: the round-trip deep equality above compared one
//   product-produced packet with another view of that packet. Mutating
//   buildDispatchScopePacket() to emit "MUTATED dispatch summary" stayed green:
//     controller-launch-scope: 25 checks passed
//   The independent decisionSummary assertion now catches that mutation (RED):
//     AssertionError [ERR_ASSERTION]: signed launch round-trip preserves the independently supplied decision summary
//     + actual - expected
//     + 'MUTATED dispatch summary'
//     - 'Thread A receives the narrower launch rule.'
// - NOT-FOUND: empty loop/forEach assertion bodies; exit-status/truthy-return
//   process assertions; swallowed failures in try/catch or optional chains;
//   assertions against a mock of the subject under test; file-wide skips or
//   platform precondition guards.
// - PRECONDITIONS: none unmet. The temporary product mutation was restored
//   byte-for-byte (matching SHA-256), then this file passed again.

console.log('controller-launch-scope: 26 checks passed');
