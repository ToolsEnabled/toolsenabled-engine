// EXECUTABLE CHANGE
// testcanfail-tests-controller-launch-record-js
//
// Discrimination report:
// - Strengthened the fan-out loop precondition. Mutation: in a scratch edit,
//   changed controller-launch-record.js's MAX_FAN_OUT from 8 to 0. Previously
//   the loop body was empty and the following cap refusal still succeeded.
// - Strengthened the depth loop precondition. Mutation: in a scratch edit,
//   changed controller-launch-record.js's MAX_DEPTH from 3 to 0. Previously
//   the loop body was empty and the following cap refusal still succeeded.
// - RED execution and restored GREEN execution precondition not met: the only
//   installed runtime is Node v20.20.2, which cannot load node:sqlite. The run
//   stopped before this file's assertions with:
//   "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite"
//   Fetching Node 24 was also unavailable (HTTP 403). The product file was
//   restored byte-for-byte (SHA-256 d413f27b312983fac52b38dec304ca7111d809551fca1be7eb38dbeca8c67b4a).
// - NOT-FOUND (2): no child-process exit-status/truthy-return assertion.
// - NOT-FOUND (3): no catch or optional chain swallowing an assertion failure;
//   the real-ledger cleanup uses finally only.
// - NOT-FOUND (4): the deterministic mock-ledger cases are backed by a named
//   real signed-ledger block; no assertion merely compares a mocked subject's
//   output with that same mock.
// - NOT-FOUND (5): no skip or platform precondition guard.
// - NOT-FOUND (6): no expected assertion value is computed by the production
//   operation being checked. MAX_FAN_OUT/MAX_DEPTH only bounded loops and
//   labels; their positivity is now independently required.

'use strict';

// Q27 step 1-2: launch-record tests. Deterministic and offline for the bulk
// of coverage via a mock audit ledger; one dedicated block at the end proves
// the write path against the REAL signed audit ledger, isolated per the
// project rule that any test touching audit must inject
// createAuditStore({file: ':memory:'}) rather than the production ledger.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const launch = require('../src/lib/controller-launch-record');
const outcome = require('../src/lib/launch-outcome');
const { buildControllerProjection } = require('../src/lib/controller-projection');
const terminalCli = require('../tools/launch-terminal-record');
const agentOrg = require('../src/lib/agent-org');
const realAudit = require('../src/lib/audit');
const { createAuditStore } = require('../src/lib/audit-store');

const hash = seed => crypto.createHash('sha256').update(String(seed)).digest('hex');
const code = (fn, expected, label) => assert.throws(fn, error => error && error.code === expected, `${label || ''}: expected ${expected}`);

// --- a small declared org, independent of config/agent-org.json's live content --

const org = agentOrg.normalizeOrg({
  revision: 1,
  agents: [
    { id: 'claude', displayName: 'Claude', role: 'controller', provider: 'claude', enabled: true },
    { id: 'luna', displayName: 'Luna', role: 'builder', provider: 'codex', enabled: true, phasePriority: [] },
    // 'worker', not 'reviewer'. This seat exists to exercise the phasePriority
    // mechanism -- an agent with an explicit list is limited to it -- and its
    // role was incidental to that. It became load-bearing when the five
    // read-only roles started being mechanically refused a claim
    // (agent-org.js NON_CLAIMING_ROLES), because a reviewer can no longer claim
    // ANY phase and the case below would then have passed for the wrong reason.
    // The read-only refusal has its own named seat and assertion further down.
    { id: 'terra', displayName: 'Terra', role: 'worker', provider: 'codex', enabled: true, phasePriority: ['Q99'] },
    { id: 'vera', displayName: 'Vera', role: 'reviewer', provider: 'codex', enabled: true, phasePriority: [] },
    {
      id: 'sol', displayName: 'Sol', role: 'builder', provider: 'codex', enabled: false,
      scopeActivation: { ruleKey: 'agent.model', sourceRequestId: 'R2001', model: 'gpt-5.6-sol', tier: 'premium' }
    }
  ],
  relationships: [
    { from: 'claude', to: 'luna', type: 'manages' },
    { from: 'claude', to: 'terra', type: 'manages' },
    { from: 'claude', to: 'vera', type: 'manages' },
    { from: 'claude', to: 'sol', type: 'manages' }
  ]
});

// --- mock audit ledger: same {requireRecord, findEvents, tail} shape the module needs --

function makeMockAudit(clock) {
  const events = [];
  let seq = 0;
  return {
    events,
    requireRecord(action, target, details) {
      seq += 1;
      const record = { sequence: seq, eventId: `evt-${seq}`, eventHash: hash(`${action}:${target}:${seq}`),
        event: { action, target, details, timestamp: new Date(clock()).toISOString() } };
      events.push(record);
      return { durable: true, anchored: true, sequence: record.sequence, eventHash: record.eventHash };
    },
    findEvents({ action, target, limit = 100 }) {
      return events.filter(entry => entry.event.action === action && entry.event.target === target).slice(0, limit);
    },
    // The production implementation serializes this decision under the audit
    // store's BEGIN IMMEDIATE lock.  This small deterministic fake preserves
    // the same callback contract for unit tests; the separate terminal-race
    // test exercises the real two-process lock.
    conditionalRecord({ action, target, decide }) {
      const decision = decide({
        findEvents: selector => this.findEvents(selector),
        nowMs: clock()
      });
      if (decision.kind === 'refused') return { recorded: false, refusal: decision.refusal };
      const written = this.requireRecord(action, target, decision.details);
      return {
        recorded: true,
        value: decision.value,
        durable: written.durable,
        anchored: written.anchored,
        sequence: written.sequence,
        eventHash: written.eventHash
      };
    },
    tail(limit = 20) {
      return events.slice(-limit).map(entry => ({ ...entry.event, sequence: entry.sequence, eventId: entry.eventId, eventHash: entry.eventHash }));
    },
    // Test-only: inject a raw signal event (e.g. coordinator.run.claim) without
    // going through createLaunch, representing activity this module never
    // sees as a launch.
    pushRaw(action, target, details, atMs) {
      seq += 1;
      events.push({ sequence: seq, eventId: `evt-${seq}`, eventHash: hash(`${action}:${target}:${seq}:raw`),
        event: { action, target, details, timestamp: new Date(atMs).toISOString() } });
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

const scopeRule = (overrides = {}) => ({
  schemaVersion: 1,
  ruleId: 'rule_global_launch',
  ruleKey: 'work.mode',
  scopeKind: 'global',
  threadId: null,
  sourceRequestId: 'R173',
  issuedAt: '2026-08-01T07:00:00.000Z',
  expiresAt: null,
  decisionSummary: 'Use the bounded launch work mode.',
  evidenceRefs: ['reports/OWNER-REQUEST-LEDGER.json#R173'],
  ownerVerbatim: 'this launch scope is explicit.',
  ...overrides
});

// --- 1. successful launch for an enabled, claimable agent -------------------

(() => {
  let now = 1_700_000_000_000;
  const clock = () => now;
  const audit = makeMockAudit(clock);

  const result = launch.createLaunch(baseRequest(), { org, audit, clock });
  assert.equal(result.record.terminalState, 'pending', 'a new launch starts pending');
  assert.equal(result.record.tierProposed, false, 'the default cheap tier is not flagged as proposed');
  assert.equal(result.record.depth, 0, 'a root launch has depth 0');
  assert.match(result.launchId, /^launch_[A-Za-z0-9_-]{16,64}$/);
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0].event.action, launch.LAUNCH_ACTION);
  assert.equal(audit.events[0].event.target, result.launchId, 'the audit target is the launch id, matching the meter-ledger convention');
  code(() => launch.createLaunch(baseRequest({ effort: 'medium' }), { org, audit, clock }),
    'LAUNCH_REASONING_EFFORT_REFUSED', 'enabled target cannot acquire an undeclared reasoning effort');
  console.log('OK: successful launch for an enabled/claimable agent');

  // --- 1b. explicit owner scope resolves at the launch boundary ------------
  const globalScope = scopeRule({ issuedAt: new Date(now - 2_000).toISOString() });
  const threadScope = scopeRule({
    ruleId: 'rule_thread_launch',
    scopeKind: 'thread',
    threadId: 'thread-a',
    sourceRequestId: 'R174',
    issuedAt: new Date(now - 1_000).toISOString(),
    decisionSummary: 'Thread A receives the narrower launch rule.',
    ownerVerbatim: 'this launch rule is only for thread A.'
  });
  const scoped = launch.createLaunch(baseRequest({ threadId: 'thread-a', scopeRules: [globalScope, threadScope] }), { org, audit, clock });
  assert.equal(scoped.record.scopePacket.threadId, 'thread-a');
  assert.deepEqual(scoped.record.scopePacket.appliedRuleIds, ['rule_thread_launch']);
  assert.equal(scoped.record.scopePacket.rules[0].ownerVerbatim, 'this launch rule is only for thread A.');
  assert.equal(scoped.record.scopePacket.grantsAuthority, false);
  const scopedReadBack = launch.launchFromAuditEvent(audit.events.find(entry => entry.event.target === scoped.launchId));
  assert.deepEqual(scopedReadBack.scopePacket, scoped.record.scopePacket, 'scope packet survives signed launch round-trip');
  const eventsBeforeScopeRefusal = audit.events.length;
  code(() => launch.createLaunch(baseRequest({ threadId: 'thread-a', scopeRules: [scopeRule({ scopeKind: 'thread', threadId: null, ruleId: 'rule_bad_scope' })] }), { org, audit, clock }),
    'LAUNCH_SCOPE_INVALID', 'malformed explicit scope');
  code(() => launch.createLaunch(baseRequest({ threadId: 'thread-a' }), { org, audit, clock }),
    'LAUNCH_SCOPE_INVALID', 'thread without explicit scope rules');
  assert.equal(audit.events.length, eventsBeforeScopeRefusal, 'scope refusal writes no launch audit event');
  console.log('OK: explicit global/thread scope resolves and persists at launch boundary');

  // --- 2. scoped activation for a disabled-by-default agent -----------------
  code(() => launch.createLaunch(baseRequest({
    targetAgentId: 'sol', model: 'gpt-5.6-sol', tier: 'premium'
  }), { org, audit, clock }), 'LAUNCH_SCOPE_ACTIVATION_REQUIRED', 'missing scoped activation');
  const solScope = scopeRule({
    ruleId: 'rule_current_install_agent_model',
    ruleKey: 'agent.model',
    sourceRequestId: 'R2001',
    issuedAt: new Date(now - 500).toISOString(),
    decisionSummary: 'This installation permits the declared premium builder model.',
    ownerVerbatim: 'permit the declared premium builder model for this installation.'
  });
  const solScopeStore = { schemaVersion: 1, revision: 11, rules: [solScope] };
  const readOwnerRequest = id => id === 'R2001'
    ? { id, verbatim: 'permit the declared premium builder model for this installation.' }
    : null;
  const solLaunch = launch.createLaunch(baseRequest({
    targetAgentId: 'sol', model: 'gpt-5.6-sol', tier: 'premium', scopeStoreRevision: 11
  }), { org, audit, clock, readScopeStore: () => solScopeStore, readOwnerRequest });
  assert.equal(solLaunch.record.targetAgentId, 'sol');
  assert.equal(solLaunch.record.model, 'gpt-5.6-sol');
  assert.equal(solLaunch.record.tier, 'premium');
  assert.deepEqual(solLaunch.record.scopePacket.appliedRuleIds, ['rule_current_install_agent_model']);
  assert.deepEqual(solLaunch.record.targetActivation, {
    kind: 'owner-scope-rule', ruleId: 'rule_current_install_agent_model', ruleKey: 'agent.model',
    sourceRequestId: 'R2001', scopeKind: 'global', threadId: null, scopeStoreRevision: 11
  }, 'a disabled-target activation identifies the stored owner rule that permitted it');
  code(() => launch.createLaunch(baseRequest({
    targetAgentId: 'sol', model: 'gpt-5.6-terra', tier: 'premium', scopeStoreRevision: 11
  }), { org, audit, clock, readScopeStore: () => solScopeStore, readOwnerRequest }), 'LAUNCH_SCOPE_ACTIVATION_REQUIRED', 'wrong scoped model');
  code(() => launch.createLaunch(baseRequest({
    targetAgentId: 'sol', model: 'gpt-5.6-sol', tier: 'standard', scopeStoreRevision: 11
  }), { org, audit, clock, readScopeStore: () => solScopeStore, readOwnerRequest }), 'LAUNCH_SCOPE_ACTIVATION_REQUIRED', 'wrong scoped tier');
  code(() => launch.createLaunch(baseRequest({
    targetAgentId: 'sol', model: 'gpt-5.6-sol', tier: 'premium', effort: 'xhigh', scopeStoreRevision: 11
  }), { org, audit, clock, readScopeStore: () => solScopeStore, readOwnerRequest }),
  'LAUNCH_SCOPE_ACTIVATION_REQUIRED', 'explicit activation cannot inherit an undeclared effort field');
  code(() => launch.createLaunch(baseRequest({
    targetAgentId: 'sol', model: 'gpt-5.6-sol', tier: 'premium', scopeRules: [solScope]
  }), { org, audit, clock, readOwnerRequest }), 'LAUNCH_SCOPE_PROVENANCE_REQUIRED', 'caller-supplied scoped activation');
  console.log('OK: disabled-by-default Sol activates only from a durable owner scope with the exact premium model tuple');

  // Historical request numbers are ordinary customer ledger ids. Neither can
  // activate a disabled target unless the current installation explicitly
  // declares that exact sourceRequestId in agent.scopeActivation.
  for (const historicalId of ['R1065', 'R1135']) {
    const historicalScope = scopeRule({
      ruleId: `rule_${historicalId.toLowerCase()}_fixture`,
      ruleKey: 'agent.model',
      sourceRequestId: historicalId,
      issuedAt: new Date(now - 250).toISOString(),
      decisionSummary: 'Historical-id collision fixture.',
      ownerVerbatim: 'historical request numbers have no built-in authority.'
    });
    code(() => launch.createLaunch(baseRequest({
      targetAgentId: 'sol', model: 'gpt-5.6-sol', tier: 'premium', scopeStoreRevision: 12
    }), {
      org, audit, clock,
      readScopeStore: () => ({ schemaVersion: 1, revision: 12, rules: [historicalScope] }),
      readOwnerRequest: id => ({ id, verbatim: 'historical request numbers have no built-in authority.' })
    }), 'LAUNCH_SCOPE_ACTIVATION_REQUIRED', `${historicalId} has no implicit launch authority`);
  }
  console.log('OK: historical request-id collisions confer no implicit launch authority');

  // --- 3. refusal for an unknown agent ----------------------------------------
  code(() => launch.createLaunch(baseRequest({ targetAgentId: 'ghost' }), { org, audit, clock }), 'LAUNCH_UNKNOWN_AGENT', 'unknown agent');
  console.log('OK: refusal for an unknown agent');

  // --- 4. refusal for a phase the agent may not claim -------------------------
  code(() => launch.createLaunch(baseRequest({ targetAgentId: 'terra', objectiveRef: 'Q27' }), { org, audit, clock }), 'LAUNCH_PHASE_REJECTED', 'phase rejected');
  // Sanity: terra CAN claim its own listed phase.
  const terraOk = launch.createLaunch(baseRequest({ targetAgentId: 'terra', objectiveRef: 'Q99' }), { org, audit, clock });
  assert.equal(terraOk.record.targetAgentId, 'terra');
  console.log('OK: refusal for a phase the agent may not claim (and acceptance of one it may)');

  // --- 4b. a read-only role may not claim ANY phase ---------------------------
  //
  // 'vera' is a reviewer with an EMPTY phasePriority, which is the case that
  // means "unrestricted" for a claiming role -- so if this launch succeeded it
  // would prove the read-only restriction is not being applied at all, rather
  // than being masked by a priority list. The reviewer's own mustNot in
  // src/lib/agent-roles.js promises exactly this refusal, and before
  // NON_CLAIMING_ROLES existed the product did not deliver it.
  code(() => launch.createLaunch(baseRequest({ targetAgentId: 'vera', objectiveRef: 'Q99' }), { org, audit, clock }),
    'LAUNCH_PHASE_REJECTED', 'a reviewer may not claim work');
  console.log('OK: a read-only role (reviewer) is refused a phase claim even with no phasePriority limit');

  // --- 5. the signed audit event is written and readable back -----------------
  const storedEvent = audit.events.find(entry => entry.event.target === result.launchId);
  const readBack = launch.launchFromAuditEvent(storedEvent);
  assert.equal(readBack.launchId, result.launchId);
  assert.equal(readBack.recordHash, result.recordHash);
  assert.deepEqual(readBack, result.record);
  // Also readable through the flattened tail() shape.
  const tailed = audit.tail(50).find(entry => entry.target === result.launchId);
  const readBackFromTail = launch.launchFromAuditEvent(tailed);
  assert.equal(readBackFromTail.recordHash, result.recordHash);
  console.log('OK: the signed audit event is written and readable back (nested and flattened shapes)');

  // --- 5b. executor authority binding is separate, canonical, and signed ---
  const authority = launch.executorPayloadHash({
    repoRoot: 'C:\\repo', baseCommit: 'a'.repeat(40), laneId: 'q66-lane', itemId: 'Q66',
    allowedPaths: ['src/q66.js'], verificationCommand: { command: process.execPath, args: ['--check', 'src/q66.js'] },
    taskBrief: 'Bound Q66 executor lane.', timeoutMs: 60_000, outputBudgetBytes: 65_536, evidenceRoot: 'C:\\evidence'
  });
  const bound = launch.createLaunch(baseRequest({ objectiveRef: 'Q66', executorPayloadHash: authority }), { org, audit, clock });
  assert.equal(bound.record.executorPayloadHash, authority, 'the explicit executor authority hash is part of the signed record');
  assert.equal(audit.events.at(-1).event.details.record.executorPayloadHash, authority,
    'the audit payload carries the authority binding, not the non-authorizing scope packet');
  const { recordHash: ignoredHash, ...unsignedBound } = bound.record;
  const reordered = Object.fromEntries(Object.entries(unsignedBound).reverse());
  const reorderedRead = launch.launchFromAuditEvent({
    event: { action: launch.LAUNCH_ACTION, target: bound.launchId, details: { schemaVersion: 1, record: reordered } }
  });
  assert.equal(reorderedRead.recordHash, bound.recordHash,
    'record hashing is canonical even when a signed event is decoded with reordered keys');
  const changedBinding = launch.normalizeRecord({ ...unsignedBound, executorPayloadHash: 'b'.repeat(64) });
  assert.notEqual(changedBinding.recordHash, bound.recordHash, 'changing authority binding changes the record digest');
  code(() => launch.createLaunch(baseRequest({ executorPayloadHash: 'A'.repeat(64) }), { org, audit, clock }),
    'LAUNCH_INVALID', 'uppercase executor authority hash');
  console.log('OK: executor authority hash is explicit, canonical, and covered by the signed record digest');

  // --- 6. staleness is correctly derived at read time past the cap ------------
  const shortCapResult = launch.createLaunch(baseRequest({ cap: { kind: 'turns', value: 5, capMs: 60_000 } }), { org, audit, clock });
  const stillFresh = launch.projectLaunch(shortCapResult.record, { nowMs: now + 30_000 });
  assert.equal(stillFresh.terminalState, 'pending');
  assert.equal(stillFresh.stale, false);
  const pastCap = launch.projectLaunch(shortCapResult.record, { nowMs: now + 120_000 });
  assert.equal(pastCap.terminalState, 'stale', 'terminal state is derived as stale once past the cap, at read time');
  assert.equal(pastCap.stale, true);
  assert.equal(pastCap.storedTerminalState, 'pending', 'the stored record itself is never rewritten to stale -- read-time only, no sweeper');
  console.log('OK: staleness is correctly derived at read time past the cap, without mutating the stored record');

  // --- 7. a costlier-tier request is flagged rather than silently applied -----
  const premium = launch.createLaunch(baseRequest({ tier: 'premium', model: 'sol-high-tier' }), { org, audit, clock });
  assert.equal(premium.record.tier, 'premium');
  assert.equal(premium.record.tierProposed, true, 'a tier above the cheap default is flagged, not silently applied');
  console.log('OK: a costlier-tier request is flagged (tierProposed) rather than silently applied');

  // --- 8. fan-out and depth cap enforcement ------------------------------------
  {
    const fanoutRoot = launch.createLaunch(baseRequest({ objectiveRef: 'fanout-root' }), { org, audit, clock });
    assert.ok(Number.isInteger(launch.MAX_FAN_OUT) && launch.MAX_FAN_OUT > 0,
      'fan-out coverage requires at least one successful child assertion');
    for (let i = 0; i < launch.MAX_FAN_OUT; i += 1) {
      const child = launch.createLaunch(baseRequest({ objectiveRef: 'fanout-child', parentLaunchId: fanoutRoot.launchId }), { org, audit, clock });
      assert.equal(child.record.depth, 1);
    }
    code(() => launch.createLaunch(baseRequest({ objectiveRef: 'fanout-child', parentLaunchId: fanoutRoot.launchId }), { org, audit, clock }),
      'LAUNCH_FANOUT_EXCEEDED', `child ${launch.MAX_FAN_OUT + 1}`);
  }
  {
    let chain = launch.createLaunch(baseRequest({ objectiveRef: 'depth-root' }), { org, audit, clock });
    assert.ok(Number.isInteger(launch.MAX_DEPTH) && launch.MAX_DEPTH > 0,
      'depth coverage requires at least one successful nested-launch assertion');
    for (let depth = 1; depth <= launch.MAX_DEPTH; depth += 1) {
      chain = launch.createLaunch(baseRequest({ objectiveRef: 'depth-child', parentLaunchId: chain.launchId }), { org, audit, clock });
      assert.equal(chain.record.depth, depth);
    }
    code(() => launch.createLaunch(baseRequest({ objectiveRef: 'depth-child', parentLaunchId: chain.launchId }), { org, audit, clock }),
      'LAUNCH_DEPTH_EXCEEDED', `depth ${launch.MAX_DEPTH + 1}`);
  }
  console.log('OK: fan-out and depth caps are enforced');

  // --- 9. the unattributed counter runs and discloses its own precision -------
  {
    const windowStart = now + 10_000;
    const windowEnd = now + 20_000;
    // One out-of-window event so the tail scan demonstrably reaches back past
    // windowStartMs (proves windowCoverageComplete can be true, not just default).
    audit.pushRaw('coordinator.run.claim', 'codex', { actor: 'codex' }, now);
    // Two in-window "agent did something" signals with no matching launch record.
    audit.pushRaw('coordinator.run.claim', 'codex', { actor: 'codex' }, windowStart + 1000);
    audit.pushRaw('coordinator.run.claim', 'codex', { actor: 'codex' }, windowStart + 2000);
    // One in-window attributed launch.
    now = windowStart + 3000;
    launch.createLaunch(baseRequest({ objectiveRef: 'unattributed-probe' }), { org, audit, clock });

    const report = launch.computeUnattributedWindow({ startMs: windowStart, endMs: windowEnd }, { audit });
    assert.equal(report.attributedLaunchCount, 1);
    assert.equal(report.activitySignalCount, 2);
    assert.equal(report.unattributedEstimate, 1, 'two signals minus one launch leaves one unattributed');
    assert.equal(report.windowCoverageComplete, true);
    assert.equal(report.confidence, 'low');
    assert.equal(typeof report.method, 'string');
    assert.ok(Array.isArray(report.limitations) && report.limitations.length > 0, 'limitations must be disclosed, not just a bare number');
    assert.ok(report.limitations.some(line => /per-event join/.test(line)));

    // A tiny scan window loses coverage of the requested range: confidence
    // must downgrade rather than silently reporting the same number.
    const narrowReport = launch.computeUnattributedWindow({ startMs: windowStart, endMs: windowEnd }, { audit, scanLimit: 1 });
    assert.equal(narrowReport.windowCoverageComplete, false);
    assert.equal(narrowReport.confidence, 'very-low');

    const unavailableReport = launch.computeUnattributedWindow(
      { startMs: windowStart, endMs: windowEnd },
      { audit: { tail() { throw new Error('ledger unavailable'); } } }
    );
    assert.equal(unavailableReport.available, false);
    assert.equal(unavailableReport.scannedEventCount, null);
    assert.equal(unavailableReport.windowCoverageComplete, null);
    assert.equal(unavailableReport.attributedLaunchCount, null);
    assert.equal(unavailableReport.activitySignalCount, null);
    assert.equal(unavailableReport.unattributedEstimate, null,
      'an unreadable ledger is an unmeasured estimate, not a definite zero');
    assert.equal(unavailableReport.confidence, 'unavailable');
    console.log('OK: the unattributed counter runs, returns a real count, and discloses confidence/method/limitations');
  }
})();

// --- 10. invalid request shapes are refused, not coerced --------------------

(() => {
  let now = 1_700_000_500_000;
  const clock = () => now;
  const audit = makeMockAudit(clock);
  code(() => launch.createLaunch(baseRequest({ objectiveRef: 'this looks like a whole raw prompt sentence not a label' }), { org, audit, clock }),
    'LAUNCH_INVALID', 'prose-shaped objectiveRef');
  code(() => launch.createLaunch(baseRequest({ tier: 'ultra' }), { org, audit, clock }), 'LAUNCH_INVALID', 'unknown tier');
  code(() => launch.createLaunch(baseRequest({ cap: { kind: 'turns', value: 20 } }), { org, audit, clock }), 'LAUNCH_INVALID', 'missing capMs');
  console.log('OK: invalid request shapes are refused rather than coerced');

  // A crafted request object carrying an extra field as a NON-ENUMERABLE
  // property must be rejected by exact()'s Reflect.ownKeys guard, the same
  // hidden-key class 9a05e02 closed for scope rules.
  const sneaky = baseRequest();
  Object.defineProperty(sneaky, 'hiddenBudgetOverride', { value: true, enumerable: false, configurable: true });
  code(() => launch.createLaunch(sneaky, { org, audit, clock }), 'LAUNCH_INVALID', 'non-enumerable extra request field');
  console.log('OK: a non-enumerable extra request field is rejected (Reflect.ownKeys guard)');
})();

// --- 10b. accountLane funding attribution: optional, validated, surfaced ----

(() => {
  let now = 1_700_000_600_000;
  const clock = () => now;
  const audit = makeMockAudit(clock);

  // Absent: existing callers are untouched and no accountLane key appears in
  // the signed record.
  const absent = launch.createLaunch(baseRequest(), { org, audit, clock });
  assert.equal(Object.hasOwn(absent.record, 'accountLane'), false, 'a launch without accountLane records no accountLane key at all');

  // Accepted: recorded at dispatch time, covered by the record digest, and
  // surfaced on every read path (audit readback and read-time projection).
  const funded = launch.createLaunch(baseRequest({ accountLane: 'anthropic-pool.primary' }), { org, audit, clock });
  assert.equal(funded.record.accountLane, 'anthropic-pool.primary', 'accountLane is recorded at dispatch time');
  const fundedEvent = audit.events.find(entry => entry.event.target === funded.launchId);
  assert.equal(launch.launchFromAuditEvent(fundedEvent).accountLane, 'anthropic-pool.primary', 'accountLane survives signed audit readback');
  assert.equal(launch.projectLaunch(funded.record, { nowMs: now }).accountLane, 'anthropic-pool.primary', 'accountLane is surfaced by the read-time projection');
  const { recordHash: ignoredLaneHash, ...unsignedFunded } = funded.record;
  assert.notEqual(launch.normalizeRecord({ ...unsignedFunded, accountLane: 'other-pool' }).recordHash, funded.recordHash,
    'changing accountLane changes the record digest');

  // Rejected: wrong type, explicit null, empty, oversized, bad charset, and
  // credential-shaped values must all refuse, never coerce.
  for (const [bad, label] of [
    [42, 'non-string accountLane'],
    [null, 'explicit null accountLane'],
    ['', 'empty accountLane'],
    ['x'.repeat(65), 'oversized accountLane'],
    ['has spaces inside', 'accountLane with spaces'],
    ['secret-pool', 'sensitive-word accountLane'],
    [`ghp_${'a'.repeat(20)}`, 'credential-shaped accountLane']
  ]) {
    code(() => launch.createLaunch(baseRequest({ accountLane: bad }), { org, audit, clock }), 'LAUNCH_INVALID', label);
  }

  // A stored record tampered after signing to carry an invalid accountLane is
  // refused on readback, not trusted because it was already durable.
  const tampered = JSON.parse(JSON.stringify(fundedEvent));
  tampered.event.details.record.accountLane = 'not a lane id';
  code(() => launch.launchFromAuditEvent(tampered), 'LAUNCH_INVALID', 'tampered stored accountLane');
  console.log('OK: accountLane is optional, dispatch-recorded, digest-covered, surfaced on read, and validated everywhere');
})();

// --- 11. terminal receipts are append-only, bound, and projection-safe -----

(() => {
  let now = 1_700_000_700_000;
  const clock = () => now;
  const audit = makeMockAudit(clock);
  const result = launch.createLaunch(baseRequest(), { org, audit, clock });
  const originalRecord = result.record;

  now += 5_000;
  const completed = terminalCli.recordTerminal({ launchId: result.launchId, terminalState: 'completed' }, { audit, clock });
  assert.equal(completed.terminalState, 'completed');
  assert.equal(audit.events.length, 2, 'completion is a second audit event, not a rewrite');
  assert.equal(audit.events[1].event.action, outcome.TERMINAL_ACTION);
  assert.equal(audit.events[1].event.target, result.launchId);
  assert.equal(result.record, originalRecord, 'the immutable launch record object is retained');
  assert.equal(result.record.terminalState, 'pending', 'the original signed launch record remains pending forever');
  const readBack = outcome.terminalReceiptFromAuditEvent(audit.events[1]);
  assert.equal(readBack.launchRecordHash, result.recordHash);
  assert.equal(outcome.terminalReceiptForRecord(result.record, [audit.events[1]]).terminalState, 'completed');

  // No text/evidence channel exists in either the public writer or receipt.
  code(() => outcome.normalizeTerminalRequest({ launchId: result.launchId, terminalState: 'completed', message: 'do not store this' }),
    'LAUNCH_TERMINAL_INVALID', 'extra terminal request data');
  assert.throws(() => terminalCli.parseArgs(['--launch', result.launchId, '--state', 'completed', '--message', 'nope']), /unknown option/,
    'the completion CLI rejects arbitrary text flags rather than ignoring them');
  code(() => terminalCli.recordTerminal({ launchId: result.launchId, terminalState: 'completed' }, { audit, clock }),
    'LAUNCH_TERMINAL_REPLAY', 'duplicate terminal receipt');
  code(() => terminalCli.recordTerminal({ launchId: result.launchId, terminalState: 'failed' }, { audit, clock }),
    'LAUNCH_TERMINAL_CONFLICT', 'conflicting terminal receipt');
  code(() => terminalCli.recordTerminal({ launchId: `launch_${'Q'.repeat(24)}`, terminalState: 'completed' }, { audit, clock }),
    'LAUNCH_TERMINAL_UNKNOWN_LAUNCH', 'unknown launch');

  const other = launch.createLaunch(baseRequest({ objectiveRef: 'terminal-cross-launch' }), { org, audit, clock });
  audit.requireRecord(outcome.TERMINAL_ACTION, other.launchId, outcome.terminalPayload(readBack));
  assert.equal(outcome.terminalReceiptForRecord(other.record, [audit.events.at(-1)]), null,
    'a signed receipt cannot be replayed onto another launch id');
  code(() => terminalCli.recordTerminal({ launchId: other.launchId, terminalState: 'completed' }, { audit, clock }),
    'LAUNCH_TERMINAL_MISMATCH', 'cross-launch receipt replay');

  const projected = buildControllerProjection({
    nowMs: now + 10_000,
    auditVerification: { valid: true, headSequence: 2, headHash: 'a'.repeat(64), headKeyId: 'audit-key-0001', signaturesValid: true },
    auditEvents: audit.events.map(entry => ({ sequence: entry.sequence, ...entry.event }))
  });
  const lane = projected.agentRoster.lanes.find(entry => entry.id === result.launchId);
  assert.equal(lane.state, 'completed', 'the projection applies the matching signed terminal receipt before staleness');

  // The projection worker may add a parent record older than its normal
  // 200-event metrics tail so a fresh terminal receipt remains intelligible.
  // Regression: slice(-200) inside observedLaunchLanes() used to throw this
  // parent away again, making an honestly completed old lane disappear.
  const terminalAtHead = { ...audit.events[1], sequence: 203 };
  const enrichedWindow = [
    audit.events[0],
    ...Array.from({ length: 200 }, (_, index) => ({
      sequence: index + 3,
      event: { action: 'filler.action', target: `filler-${index}`, details: {}, timestamp: new Date(now + index).toISOString() }
    })),
    terminalAtHead
  ];
  const enrichedProjection = buildControllerProjection({
    nowMs: now + 10_000,
    auditVerification: { valid: true, headSequence: 203, headHash: 'c'.repeat(64), headKeyId: 'audit-key-0001', signaturesValid: true },
    auditEvents: enrichedWindow
  });
  assert.equal(enrichedProjection.agentRoster.lanes.find(entry => entry.id === result.launchId).state, 'completed',
    'an injected immutable parent remains available to pair a terminal receipt after the normal 200-event tail advances');
  console.log('OK: terminal receipt is separate, hash-bound, replay/conflict-safe, and projects completed');
})();

// --- 12. malformed or mismatched receipts fail closed to pending/stale ------

(() => {
  let now = 1_700_000_800_000;
  const clock = () => now;
  const audit = makeMockAudit(clock);
  const result = launch.createLaunch(baseRequest({ cap: { kind: 'turns', value: 2, capMs: 60_000 } }), { org, audit, clock });
  const mismatched = outcome.normalizeReceipt({
    schemaVersion: 1, launchId: result.launchId, launchRecordHash: 'f'.repeat(64), terminalState: 'completed', terminalAt: new Date(now + 1).toISOString()
  });
  audit.requireRecord(outcome.TERMINAL_ACTION, result.launchId, outcome.terminalPayload(mismatched));
  assert.equal(outcome.terminalReceiptForRecord(result.record, [audit.events[1]]), null,
    'a receipt bound to another record hash is never authoritative');
  code(() => terminalCli.recordTerminal({ launchId: result.launchId, terminalState: 'completed' }, { audit, clock }),
    'LAUNCH_TERMINAL_MISMATCH', 'mismatched existing terminal receipt');

  const projected = buildControllerProjection({
    nowMs: now + 120_000,
    auditVerification: { valid: true, headSequence: 2, headHash: 'b'.repeat(64), headKeyId: 'audit-key-0001', signaturesValid: true },
    auditEvents: audit.events.map(entry => ({ sequence: entry.sequence, ...entry.event }))
  });
  const lane = projected.agentRoster.lanes.find(entry => entry.id === result.launchId);
  assert.equal(lane.state, 'unknown', 'a mismatched receipt cannot hide the launch cap expiry');
  console.log('OK: mismatched terminal receipt is refused and projection remains honest pending/stale');
})();

// --- 13. end-to-end against the REAL signed audit ledger, isolated in memory --
// Per project rule: any test touching audit must inject
// createAuditStore({file: ':memory:'}) -- never the production ledger. This
// mirrors tests/controller-meter-ledger.js's own isolated e2e block.

function memoryAnchor() {
  let value = null;
  return {
    get: () => value,
    set(next, sequence) {
      const parsed = JSON.parse(next);
      assert.equal(parsed.sequence, sequence);
      if (value !== null) {
        const prior = JSON.parse(value);
        if (sequence < prior.sequence) throw new Error('anchor cannot move backward');
      }
      value = next;
    }
  };
}

(() => {
  const isolatedStore = createAuditStore({ file: ':memory:' });
  const projectionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-launch-e2e-'));
  const keys = crypto.generateKeyPairSync('ed25519');
  let nextId = 0;
  const isolatedAuditDeps = {
    store: isolatedStore,
    signer: {
      keyId: 'launch-e2e-key-0001',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      sign: value => crypto.sign(null, value, keys.privateKey)
    },
    loadPolicy: () => ({ audit: { enabled: true, jsonlFile: 'actions.jsonl', textFile: 'actions.log', emergencyFile: 'emergency.jsonl' } }),
    rootPath: value => path.join(projectionDirectory, value),
    env: {},
    eventIdFactory: () => `launch-e2e-${String(++nextId).padStart(6, '0')}`,
    clock: () => 1_700_000_900_000 + nextId,
    reportError: () => {},
    anchorStore: memoryAnchor()
  };
  const isolatedAudit = {
    requireRecord: (action, target, details) => realAudit.requireRecord(action, target, details, isolatedAuditDeps),
    conditionalRecord: request => realAudit.conditionalRecord(request, isolatedAuditDeps),
    findEvents: query => realAudit.findEvents(query, isolatedAuditDeps),
    tail: limit => realAudit.tail(limit, isolatedAuditDeps),
    tailWithReferencedParents: options => realAudit.tailWithReferencedParents(options, isolatedAuditDeps)
  };

  try {
    const result = launch.createLaunch(baseRequest({ objectiveRef: 'Q27' }), { org, audit: isolatedAudit });
    assert.equal(result.record.terminalState, 'pending');

    const viaFindEvents = isolatedAudit.findEvents({ action: launch.LAUNCH_ACTION, target: result.launchId, limit: 1 });
    assert.equal(viaFindEvents.length, 1);
    const fromFindEvents = launch.launchFromAuditEvent(viaFindEvents[0]);
    assert.equal(fromFindEvents.recordHash, result.recordHash);

    const viaTail = isolatedAudit.tail(50).find(entry => entry.target === result.launchId);
    const fromTail = launch.launchFromAuditEvent(viaTail);
    assert.equal(fromTail.recordHash, result.recordHash);

    const terminal = outcome.recordTerminal({ launchId: result.launchId, terminalState: 'cancelled' }, { audit: isolatedAudit });
    const terminalEvents = isolatedAudit.findEvents({ action: outcome.TERMINAL_ACTION, target: result.launchId, limit: 1 });
    assert.equal(terminalEvents.length, 1);
    assert.equal(outcome.terminalReceiptFromAuditEvent(terminalEvents[0]).receiptHash, terminal.receiptHash);
    assert.equal(outcome.terminalReceiptForRecord(result.record, terminalEvents).terminalState, 'cancelled');
    const enrichedTail = isolatedAudit.tailWithReferencedParents({
      limit: 1,
      childAction: outcome.TERMINAL_ACTION,
      parentAction: launch.LAUNCH_ACTION,
      perTargetLimit: 2,
      maxTargets: 20
    });
    assert.equal(enrichedTail.length, 2, 'a one-event terminal tail receives its exact immutable parent, not a broad history scan');
    assert.ok(enrichedTail.some(event => event.action === launch.LAUNCH_ACTION && event.target === result.launchId));
    assert.ok(enrichedTail.some(event => event.action === outcome.TERMINAL_ACTION && event.target === result.launchId));

    // A refusal never even reaches the audit ledger: the launch-event count
    // must not change across the refused attempt.
    const launchEventsBefore = isolatedAudit.tail(50).filter(entry => entry.action === launch.LAUNCH_ACTION).length;
    code(() => launch.createLaunch(baseRequest({ targetAgentId: 'sol' }), { org, audit: isolatedAudit }), 'LAUNCH_SCOPE_ACTIVATION_REQUIRED');
    const launchEventsAfter = isolatedAudit.tail(50).filter(entry => entry.action === launch.LAUNCH_ACTION).length;
    assert.equal(launchEventsAfter, launchEventsBefore, 'a refused launch writes no audit event');

    console.log('OK: launch and terminal receipt end-to-end against the real signed audit ledger (isolated in-memory store)');
  } finally {
    isolatedStore.close();
  }
})();

// A dispatcher puts the brief at the top of the text a spawned agent reads.
// Measured 2026-08-16 by driving the installed 1.0.17: every lane brief began
// with the literal "[object Object]" because the frozen object went into a
// string join, so no child ever received its launch id, agent id, objective,
// or the owner rules the packet exists to carry.
(() => {
  // A real record from the ordinary path, so this proves what a lane actually
  // hands its child, not a hand-made object.
  const briefClock = () => 1_700_000_000_000;
  const brief = launch.buildDispatchBrief(
    launch.createLaunch(baseRequest(), { org, audit: makeMockAudit(briefClock), clock: briefClock }).record);
  const text = launch.renderDispatchBrief(brief);
  assert.equal(typeof text, 'string');
  assert.ok(!text.includes('[object Object]'), 'the brief must never stringify as an object');
  assert.ok(!['x', text, 'y'].join(String.fromCharCode(10)).includes('[object Object]'),
    'and not when joined, which is exactly how a dispatcher uses it');
  assert.match(text, /launch id: /);
  assert.match(text, /agent id: /);
  assert.ok(text.includes(brief.launchId), 'the launch id must survive into the text the agent reads');
  assert.match(text, /grants no authority/i, 'the text carries what the object claimed in a field no reader sees');
  const bare = launch.renderDispatchBrief({ launchId: 'launch_x', agentId: 'a', objectiveRef: null, scopePacket: null });
  assert.match(bare, /objective: none recorded/, 'absence is stated, never an empty line');
  assert.match(bare, /owner rules applied: none recorded/);
  assert.equal(launch.renderDispatchBrief(null), '');
  console.log('OK: the dispatch brief renders as readable text');
})();

console.log('Controller launch record tests passed.');
