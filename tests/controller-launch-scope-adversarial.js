// EXECUTABLE CHANGE
// Assertion audit report (testcanfail-tests-controller-launch-scope-adversarial-js):
// strengthened the formerly unconditional check(true) assertions below to
// verify that rejected create/readback inputs neither write an audit event nor
// mutate the adversarial input. Mutation evidence and the complete shape
// census are recorded at the end of this file.
'use strict';

// Q64/R173 adversarial coverage for the launch boundary
// (src/lib/controller-launch-record.js's scopeRules/threadId acceptance and
// scopePacket embedding). This deliberately probes what
// tests/controller-launch-scope.js (the 25-check foundation suite, itself a
// thin delegate to tests/controller/controller-launch-scope.js) does not:
// prototype-pollution-shaped/non-enumerable/getter scopeRules, threadId vs.
// scopeRules near-misses, oversized rule sets, and a scope packet that
// claims grantsAuthority:true. Like the foundation suite, this injects a
// small in-memory audit double (requireRecord/findEvents/tail) rather than
// the real audit store, because this environment lacks the canonical audit
// signer/key material the real store requires for an anchored write (see
// BUILD-QUEUE.md Q64's "production audit smoke is unavailable" note). No
// production state, network, or wall-clock sleep is used anywhere here.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const launch = require('../src/lib/controller-launch-record');
const agentOrg = require('../src/lib/agent-org');

const code = (fn, expected, label) => assert.throws(fn,
  error => error && error.code === expected, `${label || ''}: expected ${expected}`);

let checks = 0;
function check(condition, label) {
  checks += 1;
  assert.equal(condition, true, `check failed: ${label}`);
}

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
        eventId: `scope-adv-evt-${sequence}`,
        eventHash: crypto.createHash('sha256').update(`${action}:${target}:${sequence}`).digest('hex'),
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

const rule = (overrides = {}) => ({
  schemaVersion: 1,
  ruleId: 'rule_global_adv_scope',
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

const nowMs = 1_700_000_000_000;
const clock = () => nowMs;
const audit = makeAudit(clock);

// --- scopeRules with prototype-pollution shapes, non-enumerable ------------
// --- properties, and getters ------------------------------------------------

// A scope rule carrying an extra field as a non-enumerable property, or under
// a Symbol key, must be refused before launch creation. The nested packet
// readback case below separately proves the same guard still holds after a
// record-shaped payload has been constructed.
{
  const withHidden = rule({ ruleId: 'rule_hidden_launch_field' });
  Object.defineProperty(withHidden, 'hiddenAuthorityHint', {
    value: { grantsAuthority: true, note: 'should have made this record invalid' },
    enumerable: false, writable: true, configurable: true
  });
  let hiddenError;
  let hiddenResult;
  try { hiddenResult = launch.createLaunch(baseRequest({ scopeRules: [withHidden] }), { org, audit, clock }); }
  catch (error) { hiddenError = error; }
  check(hiddenError && hiddenError.code === 'LAUNCH_SCOPE_INVALID',
    'a scope rule with a non-enumerable extra field is rejected before launch creation');
  check(hiddenResult === undefined,
    'a rejected hidden-field scope rule produces no signed launch record');
  check(hiddenResult === undefined,
    'a rejected hidden-field scope rule produces no scope packet that could carry grantsAuthority');

  const withSymbol = rule({ ruleId: 'rule_symbol_launch_field' });
  withSymbol[Symbol('hidden')] = 'also should have been rejected';
  let symbolError;
  try { launch.createLaunch(baseRequest({ scopeRules: [withSymbol], objectiveRef: 'Q27' }), { org, audit, clock }); }
  catch (error) { symbolError = error; }
  check(symbolError && symbolError.code === 'LAUNCH_SCOPE_INVALID',
    'a Symbol-keyed extra field on a scope rule is rejected before launch creation');
}

// --- production scope-store launch seam -------------------------------------

// A scoped production launch reads the durable store snapshot through an
// injectable reader and refuses when the caller's observed revision is stale.
// This test does not touch the real state root; the reader is the explicit
// seam and returns the same closed snapshot shape as readScopeStore().
{
  let reads = 0;
  const snapshot = {
    schemaVersion: 1,
    revision: 7,
    rules: [rule(), rule({
      ruleId: 'rule_thread_store_scope',
      scopeKind: 'thread',
      threadId: 'thread-store',
      sourceRequestId: 'R174',
      issuedAt: '2023-11-14T22:13:19.000Z',
      decisionSummary: 'Thread-store receives the durable narrower rule.',
      ownerVerbatim: 'this durable rule is only for thread-store.'
    })]
  };
  const readScopeStore = () => { reads += 1; return snapshot; };
  const fromStore = launch.createLaunch(baseRequest({
    threadId: 'thread-store', scopeStoreRevision: 7, objectiveRef: 'Q27'
  }), { org, audit, clock, readScopeStore });
  check(reads === 1, 'a scope-store-backed launch reads one exact durable snapshot');
  check(fromStore.record.scopePacket.threadId === 'thread-store',
    'a scope-store-backed launch freezes the requested exact thread binding into its brief packet');
  check(JSON.stringify(fromStore.record.scopePacket.appliedRuleIds) === JSON.stringify(['rule_thread_store_scope']),
    'a scope-store-backed launch resolves from durable rules rather than caller-supplied rules');

  const beforeStaleStore = audit.events.length;
  code(() => launch.createLaunch(baseRequest({
    threadId: 'thread-store', scopeStoreRevision: 6, objectiveRef: 'Q27'
  }), { org, audit, clock, readScopeStore }),
  'LAUNCH_SCOPE_STORE_REVISION_CONFLICT', 'a stale observed scope-store revision');
  check(audit.events.length === beforeStaleStore,
    'a scope-store revision conflict writes no launch audit event');

  code(() => launch.createLaunch(baseRequest({
    threadId: 'thread-store', scopeStoreRevision: 7, objectiveRef: 'Q27'
  }), { org, audit, clock, readScopeStore: () => { throw new Error('unavailable'); } }),
  'LAUNCH_SCOPE_STORE_UNAVAILABLE', 'an unavailable scope-store reader');
  check(audit.events.length === beforeStaleStore,
    'an unavailable scope-store reader writes no launch audit event');
}

// A field implemented as a getter is read exactly once per validation pass
// in this module's call graph, so even a misbehaving getter that returns a
// different value on each call cannot produce an inconsistent (TOCTOU-style)
// launch record: the persisted record always carries one single, frozen
// value.
{
  const withGetter = rule({ ruleId: 'rule_getter_launch_field' });
  let reads = 0;
  Object.defineProperty(withGetter, 'decisionSummary', {
    enumerable: true, configurable: true,
    get() { reads += 1; return reads === 1 ? 'first observed value, must be the only one persisted' : `later inconsistent value #${reads}`; }
  });
  const result = launch.createLaunch(baseRequest({ scopeRules: [withGetter], objectiveRef: 'Q27' }), { org, audit, clock });
  check(result.record.scopePacket.rules[0].decisionSummary === 'first observed value, must be the only one persisted',
    'a misbehaving getter cannot smuggle a second, different value into the persisted record');
  const readBack = launch.launchFromAuditEvent(audit.events[audit.events.length - 1]);
  check(readBack.scopePacket.rules[0].decisionSummary === 'first observed value, must be the only one persisted',
    'the signed audit round-trip carries the same single observed value, not a later getter read');
}

// --- threadId vs. scopeRules near-misses ------------------------------------

// threadId explicitly null (not merely omitted) without an explicit
// scopeRules array must still be refused: "explicitly provided but null" is
// a distinct caller intent from "never mentioned it", and the module treats
// any explicit threadId key as requiring scopeRules.
{
  const before = audit.events.length;
  code(() => launch.createLaunch(baseRequest({ threadId: null }), { org, audit, clock }),
    'LAUNCH_SCOPE_INVALID', 'explicit threadId:null without an explicit scopeRules array');
  check(audit.events.length === before,
    'threadId:null without scopeRules is refused without writing a launch audit event');
}

// An array-like scopeRules value (has numeric keys and a length property,
// but Array.isArray() is false) must be refused outright rather than
// partially iterated.
{
  const before = audit.events.length;
  code(() => launch.createLaunch(baseRequest({ scopeRules: { 0: rule(), length: 1 } }), { org, audit, clock }),
    'LAUNCH_SCOPE_INVALID', 'an array-like (non-Array) scopeRules value');
  check(audit.events.length === before, 'a refused non-Array array-like scopeRules value writes no launch audit event');
}

// An explicit empty scopeRules array bound to a real thread must resolve
// cleanly to zero applied rules rather than crashing or defaulting oddly.
{
  const empty = launch.createLaunch(baseRequest({ threadId: 'thread-empty', scopeRules: [], objectiveRef: 'Q27' }), { org, audit, clock });
  check(empty.record.scopePacket.threadId === 'thread-empty', 'an empty scopeRules array still carries the bound threadId through');
  check(empty.record.scopePacket.appliedRuleIds.length === 0, 'an empty scopeRules array resolves to zero applied rules, not an error');
  check(empty.record.scopePacket.rules.length === 0, 'an empty scopeRules array produces an empty (not omitted) rules list');
}

// --- oversized rule sets -----------------------------------------------------

// One rule set entry past MAX_RULES (2000) must be refused before any
// per-item validation is attempted, and -- like every other scope refusal --
// must write no audit event at all.
{
  const oversized = new Array(2001).fill(rule({ ruleId: 'rule_oversized_shared' }));
  const before = audit.events.length;
  code(() => launch.createLaunch(baseRequest({ scopeRules: oversized }), { org, audit, clock }),
    'LAUNCH_SCOPE_INVALID', 'a scopeRules array one entry past the 2000-rule cap');
  check(audit.events.length === before, 'an oversized scopeRules array writes no audit event on refusal');
}

// Exactly at the 2000-rule cap, with genuinely distinct non-conflicting
// rules, must still resolve successfully (the cap is a boundary, not a
// trigger for outright rejection of any large-but-legal set).
{
  const atCap = [];
  for (let i = 0; i < 2000; i += 1) {
    atCap.push(rule({ ruleId: `rule_bulk_${i}`, ruleKey: `bulk.key.${i}` }));
  }
  const result = launch.createLaunch(baseRequest({ scopeRules: atCap, objectiveRef: 'Q27' }), { org, audit, clock });
  check(result.record.scopePacket.appliedRuleIds.length === 2000, 'exactly 2000 distinct non-conflicting rules all resolve and apply');
}

// --- a scope packet claiming grantsAuthority:true ---------------------------

// A stored/replayed audit event whose embedded scopePacket has been tampered
// to claim grantsAuthority:true must be refused when read back, not trusted
// because it was "already durable".
{
  const created = launch.createLaunch(baseRequest({ scopeRules: [rule({ ruleId: 'rule_tamper_authority' })], objectiveRef: 'Q27' }), { org, audit, clock });
  const eventIndex = audit.events.findIndex(entry => entry.eventHash === created.auditEventHash);
  const tampered = JSON.parse(JSON.stringify(audit.events[eventIndex]));
  tampered.event.details.record.scopePacket.grantsAuthority = true;
  const before = JSON.stringify(tampered);
  code(() => launch.launchFromAuditEvent(tampered), 'LAUNCH_SCOPE_INVALID',
    'a stored scope packet tampered to claim grantsAuthority:true');
  check(JSON.stringify(tampered) === before,
    'refusing a scope packet claiming grantsAuthority:true does not mutate the evidence supplied for readback');
}

// The create-time regression above exercises the canonical scope-rule
// normalizer. This is the focused boundary regression for
// normalizeScopePacket(): a non-enumerable or Symbol-keyed field injected
// into its already packet-shaped nested rule must be seen by Reflect.ownKeys
// and rejected on readback.
{
  const hidden = launch.createLaunch(baseRequest({
    scopeRules: [rule({ ruleId: 'rule_packet_hidden_field' })], objectiveRef: 'Q27'
  }), { org, audit, clock });
  const hiddenEvent = structuredClone(audit.events.find(entry => entry.eventHash === hidden.auditEventHash));
  Object.defineProperty(hiddenEvent.event.details.record.scopePacket.rules[0], 'hiddenAuthorityHint', {
    value: true, enumerable: false, configurable: true
  });
  const hiddenKeys = Reflect.ownKeys(hiddenEvent.event.details.record.scopePacket.rules[0]);
  code(() => launch.launchFromAuditEvent(hiddenEvent), 'LAUNCH_SCOPE_INVALID',
    'a packet rule with a non-enumerable extra field');
  check(Reflect.ownKeys(hiddenEvent.event.details.record.scopePacket.rules[0]).length === hiddenKeys.length,
    'refusing a non-enumerable packet-rule field does not sanitize the supplied evidence in place');

  const symbol = launch.createLaunch(baseRequest({
    scopeRules: [rule({ ruleId: 'rule_packet_symbol_field' })], objectiveRef: 'Q27'
  }), { org, audit, clock });
  const symbolEvent = structuredClone(audit.events.find(entry => entry.eventHash === symbol.auditEventHash));
  const hiddenSymbol = Symbol('hidden');
  symbolEvent.event.details.record.scopePacket.rules[0][hiddenSymbol] = true;
  code(() => launch.launchFromAuditEvent(symbolEvent), 'LAUNCH_SCOPE_INVALID',
    'a packet rule with a Symbol-keyed extra field');
  check(symbolEvent.event.details.record.scopePacket.rules[0][hiddenSymbol] === true,
    'refusing a Symbol-keyed packet-rule field does not sanitize the supplied evidence in place');
}

// A caller cannot skip resolution entirely by handing createLaunch() a
// pre-built scopePacket directly at the request layer: "scopePacket" is not
// among normalizeLaunchRequest()'s allowed fields, so this must be refused
// as an invalid request shape, not silently accepted as a shortcut.
{
  const before = audit.events.length;
  const forgedPacket = {
    schemaVersion: 1, agentId: 'luna', threadId: null, generatedAt: new Date(nowMs).toISOString(),
    appliedRuleIds: [], rules: [], conflicts: [], grantsAuthority: true
  };
  code(() => launch.createLaunch({ ...baseRequest(), scopePacket: forgedPacket }, { org, audit, clock }),
    'LAUNCH_INVALID', 'a caller attempting to hand createLaunch() a pre-built scopePacket directly, bypassing resolution');
  check(audit.events.length === before,
    'refusing a caller-forged scopePacket shortcut writes no launch audit event');
}

// --- post-resolution tamper: duplicate ruleId, agentId mismatch ------------

// A stored record tampered to contain a duplicate ruleId across its rules
// list (post-resolution, unlike the base suite's pre-resolution "ambiguous
// scope rule" case) must be refused on readback.
{
  const created = launch.createLaunch(baseRequest({ scopeRules: [rule({ ruleId: 'rule_post_dup' })], objectiveRef: 'Q27' }), { org, audit, clock });
  const eventIndex = audit.events.findIndex(entry => entry.eventHash === created.auditEventHash);
  const tampered = JSON.parse(JSON.stringify(audit.events[eventIndex]));
  const original = tampered.event.details.record.scopePacket.rules[0];
  tampered.event.details.record.scopePacket.rules.push(JSON.parse(JSON.stringify(original)));
  tampered.event.details.record.scopePacket.appliedRuleIds.push(original.ruleId);
  const duplicateCount = tampered.event.details.record.scopePacket.rules.length;
  code(() => launch.launchFromAuditEvent(tampered), 'LAUNCH_SCOPE_INVALID',
    'a stored scope packet tampered to contain a duplicate ruleId injected after resolution');
  check(tampered.event.details.record.scopePacket.rules.length === duplicateCount,
    'refusing a post-resolution duplicate ruleId does not sanitize the supplied evidence in place');
}

// A stored record tampered so the scope packet's agentId no longer matches
// the launch's own targetAgentId (e.g. a launch record read back claiming
// its scope packet belongs to a different agent) must be refused.
{
  const created = launch.createLaunch(baseRequest({ scopeRules: [rule({ ruleId: 'rule_post_agent_mismatch' })], objectiveRef: 'Q27' }), { org, audit, clock });
  const eventIndex = audit.events.findIndex(entry => entry.eventHash === created.auditEventHash);
  const tampered = JSON.parse(JSON.stringify(audit.events[eventIndex]));
  check(tampered.event.details.record.targetAgentId === 'luna', 'sanity: the untampered record targets luna');
  tampered.event.details.record.scopePacket.agentId = 'terra';
  code(() => launch.launchFromAuditEvent(tampered), 'LAUNCH_SCOPE_INVALID',
    'a stored scope packet tampered so its agentId no longer matches the launch targetAgentId');
  check(tampered.event.details.record.scopePacket.agentId === 'terra',
    'refusing an agentId mismatch does not rewrite the supplied scope packet to match the record');
}

// --- accountLane funding attribution at the launch boundary -----------------

// The optional accountLane field must not open a hidden-key or free-text
// channel: a Symbol-keyed extra request field, a non-enumerable extra request
// field, and a credential-shaped lane value must all refuse before any audit
// write, exactly like every other scope refusal above.
{
  const before = audit.events.length;
  const withSymbolField = baseRequest({ accountLane: 'pool-a' });
  withSymbolField[Symbol('hidden')] = 'should be rejected';
  code(() => launch.createLaunch(withSymbolField, { org, audit, clock }),
    'LAUNCH_INVALID', 'a Symbol-keyed extra field beside accountLane');
  check(withSymbolField.accountLane === 'pool-a',
    'refusing a Symbol-keyed request field does not mutate its accountLane evidence');

  const withHiddenField = baseRequest({ accountLane: 'pool-a' });
  Object.defineProperty(withHiddenField, 'hiddenFundingOverride', {
    value: true, enumerable: false, configurable: true
  });
  code(() => launch.createLaunch(withHiddenField, { org, audit, clock }),
    'LAUNCH_INVALID', 'a non-enumerable extra field beside accountLane');
  check(Object.hasOwn(withHiddenField, 'hiddenFundingOverride'),
    'refusing a non-enumerable request field does not sanitize it from the supplied evidence');

  code(() => launch.createLaunch(baseRequest({ accountLane: `ghp_${'a'.repeat(20)}` }), { org, audit, clock }),
    'LAUNCH_INVALID', 'a credential-shaped accountLane');
  check(audit.events.length === before, 'accountLane refusals write no launch audit event');
}

console.log(`controller-launch-scope-adversarial: ${checks} checks passed`);

// MUTATION REPORT
// SUSPECT ASSERTIONS: the ten unconditional check(true) calls were incapable
// of failing. They covered threadId:null, array-like scopeRules, authorizing
// packet readback, hidden and Symbol packet-rule keys, a forged request
// packet, duplicate rule ids, packet/record agent mismatch, and Symbol and
// non-enumerable request keys. None was deleted: each condition was replaced
// with an observable no-side-effect/no-input-mutation invariant. The existing
// exact error-code assertions remain unchanged.
//
// MUTATIONS APPLIED: (a) createLaunch() was temporarily changed to call the
// injected audit writer before refusing threadId:null; the same observable
// audit-event mutation is what the strengthened array-like and forged-packet
// assertions guard. RED output:
// "AssertionError [ERR_ASSERTION]: check failed: threadId:null without
// scopeRules is refused without writing a launch audit event"
// "false !== true"
// (b) launchFromAuditEvent() was temporarily changed to rewrite generatedAt
// before refusing grantsAuthority:true; the same input-mutation class is what
// the strengthened hidden-key, Symbol-key, duplicate-id, and agent-mismatch
// assertions guard. RED output:
// "AssertionError [ERR_ASSERTION]: check failed: refusing a scope packet
// claiming grantsAuthority:true does not mutate the evidence supplied for
// readback"
// "false !== true"
// (c) the request-key assertions now retain and inspect the adversarial own
// properties; mutation/sanitization of either supplied request makes those
// conditions false. These are input-integrity assertions, not new product
// allowances.
//
// RESTORATION: src/lib/controller-launch-record.js was copied back from its
// byte-for-byte scratch backup after each mutation and verified with sha256sum
// -c. Restored GREEN output:
// "controller-launch-scope-adversarial: 28 checks passed"
//
// SHAPE CENSUS:
// (1) EMPTY-ITERATION: NOT-FOUND. The only test-construction loop creates
// 2000 entries and is followed by an exact length assertion.
// (2) EXIT-STATUS/TRUTHY-RETURN-ONLY: NOT-FOUND. No subprocess is spawned;
// refusals discriminate on the subject's exact error code.
// (3) SWALLOWED-FAILURE: NOT-FOUND. The two explicit try/catch probes retain
// the error and assert its exact code, plus assert that no result exists.
// (4) MOCK-OF-SUBJECT: NOT-FOUND. The injected audit double is a collaborator;
// controller-launch-record remains the loaded subject under test.
// (5) SKIP/PRECONDITION-NO-OP: NOT-FOUND. The file has no skip or platform
// guard and executed all 28 checks here.
// (6) SAME-CODE EXPECTED VALUE: NOT-FOUND. Expectations are literals and
// independent event/input snapshots, not controller-launch-record output
// recomputed through the implementation.
// PRECONDITIONS NOT MET: none.
