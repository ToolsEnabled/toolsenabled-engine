// EXECUTABLE CHANGE
// Discrimination report (testcanfail-tests-owner-request-scope-adversarial-js):
// Strengthened every literal `check(true, ...)` so it verifies that the
// immediately preceding rejection was the module's own named, non-empty
// error rather than an assertion that could not fail. Mutation applied:
// OwnerRequestScopeError's constructor temporarily set `this.name = ''`.
// RED output: `AssertionError [ERR_ASSERTION]: check failed: cross-thread
// ruleId collision rejected` (the run exited 1). The source file was then
// restored byte-for-byte and the green confirmation was:
// `owner-request-scope-adversarial: 43 checks passed` (the run exited 0).
// NOT-FOUND (1): no unguarded loop/forEach assertion over a possibly empty
// collection; both `triage.every(...)` checks follow `triage.length === 2`.
// NOT-FOUND (2): no exit-status or generic truthy-return assertion.
// NOT-FOUND (3): no swallowed failure; the defect probes retain and assert
// caught errors and also assert that rejected normalization has no output.
// NOT-FOUND (4): no mock of owner-request-scope is used.
// NOT-FOUND (5): no skip or platform precondition guard exists.
// NOT-FOUND (6): no expected value is computed by the implementation.
// Preconditions: all met; Node and the target module were available.

'use strict';

// Q64/R173 adversarial coverage for the pure scope contract/resolver
// (src/lib/owner-request-scope.js). This deliberately probes what
// tests/owner-request-scope.js (the 40-check foundation suite) does not:
// rule-id collisions that only differ by scope/thread binding, near-miss
// threadId shapes, expiry/clock-skew boundaries, malformed rationale/evidence
// text, multi-way conflicts with identical timestamps, and attempts to
// smuggle authority through free-text fields. Every check is deterministic:
// no wall-clock sleeps, no network, no real vault, an injected nowMs only.
//
// KNOWN DEFECT (found by this suite, not fixed -- see the STRICT CONSTRAINT
// in this lane's brief): normalizeScopeRule()'s "reject any record with an
// unexpected extra field" contract (src/lib/owner-request-scope.js:51-58,
// the shared `exact()` helper) is enforced by scanning
// `Object.keys(value)`, which only lists *enumerable* own string-keyed
// properties. A record carrying an extra field defined as non-enumerable
// (`Object.defineProperty(..., { enumerable: false })`) or under a Symbol
// key is silently accepted even though BUILD-QUEUE.md Q64 build item 1
// requires "Reject malformed or ambiguous records rather than guessing
// scope." The blast radius is bounded -- normalizeScopeRule() builds its
// frozen return value by explicit allow-listed field extraction, so the
// hidden field's content never propagates into the output -- but the
// module's own "malformed record" refusal guarantee does not hold here.
// See tests/controller-launch-scope-adversarial.js for the same defect
// demonstrated end-to-end through a signed launch record.

const assert = require('node:assert/strict');
const scope = require('../src/lib/owner-request-scope');

let lastCaughtError;
const code = (fn, expected, label) => {
  lastCaughtError = undefined;
  assert.throws(fn, error => {
    lastCaughtError = error;
    return error && error.code === expected;
  }, `${label || ''}: expected ${expected}`);
};

const rejectedByScopeModule = () => Boolean(lastCaughtError)
  && lastCaughtError.name === 'OwnerRequestScopeError'
  && typeof lastCaughtError.message === 'string'
  && lastCaughtError.message.length > 0;

let checks = 0;
function check(condition, label) {
  checks += 1;
  assert.equal(condition, true, `check failed: ${label}`);
}

const rule = (overrides = {}) => ({
  schemaVersion: 1,
  ruleId: 'rule_global_default',
  ruleKey: 'work.mode',
  scopeKind: 'global',
  threadId: null,
  sourceRequestId: 'R173',
  issuedAt: '2026-08-01T07:00:00.000Z',
  expiresAt: null,
  decisionSummary: 'Use the bounded controller work mode.',
  evidenceRefs: ['reports/OWNER-REQUEST-LEDGER.json#R173'],
  ownerVerbatim: 'that was only while working on that specific thread.',
  ...overrides
});

const now = Date.parse('2026-08-01T08:00:00.000Z');

// --- rule-id collision across scopes (not just literal duplicates) --------

// The base suite only proves two *identical* global rules collide. A ruleId
// is meant to be a globally unique identifier regardless of scope/thread
// binding; prove that a thread-a rule and a thread-b rule sharing one ruleId
// still collide, and that a global/thread pair sharing one ruleId collides.
{
  const threadA = rule({ ruleId: 'rule_shared_id', scopeKind: 'thread', threadId: 'thread-a', ruleKey: 'a.key' });
  const threadB = rule({ ruleId: 'rule_shared_id', scopeKind: 'thread', threadId: 'thread-b', ruleKey: 'b.key' });
  code(() => scope.resolveScopeRules([threadA, threadB], { threadId: 'thread-a', nowMs: now }),
    'OWNER_SCOPE_AMBIGUOUS', 'ruleId collision across two different threads');
  check(rejectedByScopeModule(), 'cross-thread ruleId collision rejected');

  const globalR = rule({ ruleId: 'rule_shared_id2', ruleKey: 'g.key' });
  const threadR = rule({ ruleId: 'rule_shared_id2', scopeKind: 'thread', threadId: 'thread-a', ruleKey: 't.key' });
  code(() => scope.resolveScopeRules([globalR, threadR], { threadId: 'thread-a', nowMs: now }),
    'OWNER_SCOPE_AMBIGUOUS', 'ruleId collision across global/thread scopeKind');
  check(rejectedByScopeModule(), 'global/thread ruleId collision rejected');
}

// --- near-miss threadId shapes ----------------------------------------------

{
  const threadA = rule({ ruleId: 'rule_thread_a', scopeKind: 'thread', threadId: 'thread-a', ruleKey: 'near.miss.key' });

  // Case variant: THREAD_ID_RE is case-sensitive; "Thread-A" must not match
  // the rule bound to "thread-a".
  const caseVariant = scope.resolveScopeRules([threadA], { threadId: 'Thread-A', nowMs: now });
  check(caseVariant.appliedRuleIds.length === 0, 'case-variant threadId does not receive the thread-a rule');
  check(caseVariant.excludedCounts.threadScoped === 1, 'case-variant threadId excludes the rule as threadScoped, not silently');
  check(JSON.stringify(caseVariant).includes('thread-a') === false, 'case-variant resolution does not leak the real threadId');

  // Prefix collision: "thread-ab" must not receive the "thread-a" rule.
  const prefixVariant = scope.resolveScopeRules([threadA], { threadId: 'thread-ab', nowMs: now });
  check(prefixVariant.appliedRuleIds.length === 0, 'prefix-collision threadId does not receive the thread-a rule');

  // Trailing whitespace in the resolver's own threadId option: THREAD_ID_RE
  // has no whitespace in its charset, so this must fail closed rather than
  // silently trim-and-match.
  code(() => scope.resolveScopeRules([threadA], { threadId: 'thread-a ', nowMs: now }),
    'OWNER_SCOPE_INVALID', 'trailing-whitespace resolver threadId');
  check(rejectedByScopeModule(), 'trailing-whitespace resolver threadId rejected');

  // Unicode confusable: Cyrillic "а" (U+0430) in place of Latin "a" inside a
  // rule's own threadId at authoring time. THREAD_ID_RE is ASCII-only, so
  // this must be rejected outright, not silently accepted as a distinct
  // (spoofable) thread identity.
  code(() => scope.normalizeScopeRule(rule({ scopeKind: 'thread', threadId: 'threаd-a', ruleId: 'rule_confusable' })),
    'OWNER_SCOPE_AMBIGUOUS', 'unicode-confusable threadId at rule authoring');
  check(rejectedByScopeModule(), 'unicode-confusable threadId rejected at rule authoring');

  // threadId length boundary: THREAD_ID_RE allows up to 128 characters total
  // (1 + {0,127}). Exactly at the boundary must succeed; one over must fail
  // closed rather than silently truncating.
  const at128 = 'a'.repeat(128);
  const over129 = 'a'.repeat(129);
  const boundaryOk = scope.normalizeScopeRule(rule({ scopeKind: 'thread', threadId: at128, ruleId: 'rule_len_ok' }));
  check(boundaryOk.threadId.length === 128, 'threadId exactly at the 128-char boundary is accepted verbatim');
  code(() => scope.normalizeScopeRule(rule({ scopeKind: 'thread', threadId: over129, ruleId: 'rule_len_bad' })),
    'OWNER_SCOPE_AMBIGUOUS', 'threadId one character past the boundary');
  check(rejectedByScopeModule(), 'threadId one character past the 128-char boundary is rejected');
}

// --- expiry boundary conditions (exactly-at-expiry, clock skew) ------------

{
  // Exactly-at-expiry: expiresAt === nowMs must exclude the rule (expiry is
  // the instant a rule stops applying, not the last instant it applies).
  const expiresAtNow = rule({ ruleId: 'rule_expiry_exact', ruleKey: 'exp.exact', expiresAt: new Date(now).toISOString() });
  const exactExpiry = scope.resolveScopeRules([expiresAtNow], { nowMs: now });
  check(exactExpiry.appliedRuleIds.length === 0 && exactExpiry.excludedCounts.expired === 1,
    'a rule expiring exactly at nowMs is excluded, not applied for one more instant');

  // One millisecond before expiry: must still be included.
  const expiresJustAfter = rule({ ruleId: 'rule_expiry_1ms', ruleKey: 'exp.1ms', expiresAt: new Date(now + 1).toISOString() });
  const justBeforeExpiry = scope.resolveScopeRules([expiresJustAfter], { nowMs: now });
  check(justBeforeExpiry.appliedRuleIds.includes('rule_expiry_1ms'), 'a rule expiring one ms in the future is still applied');

  // Clock skew: a rule issued exactly at nowMs (resolver and issuer clocks
  // agree to the millisecond) must be treated as already-issued, not future.
  const issuedNow = rule({ ruleId: 'rule_issued_now', ruleKey: 'iss.now', issuedAt: new Date(now).toISOString() });
  const issuedExactly = scope.resolveScopeRules([issuedNow], { nowMs: now });
  check(issuedExactly.appliedRuleIds.includes('rule_issued_now'), 'a rule issued exactly at nowMs is applied, not treated as future');

  // Clock skew the other direction: issued one ms after nowMs (issuer clock
  // slightly ahead of the resolver) must be excluded as future.
  const issuedFuture = rule({ ruleId: 'rule_issued_future', ruleKey: 'iss.future', issuedAt: new Date(now + 1).toISOString() });
  const issuedOneMsFuture = scope.resolveScopeRules([issuedFuture], { nowMs: now });
  check(issuedOneMsFuture.excludedCounts.future === 1, 'a rule issued one ms after nowMs is excluded as future');

  // A resolver clock pinned at the Unix epoch (extreme historical skew) must
  // not crash and must correctly treat every 2026 rule as future.
  const epochResolution = scope.resolveScopeRules([rule({ ruleId: 'rule_epoch_clock' })], { nowMs: 0 });
  check(epochResolution.appliedRuleIds.length === 0 && epochResolution.excludedCounts.future === 1,
    'a resolver clock pinned at epoch treats every 2026 rule as future without crashing');
}

// --- malformed rationale/evidence refs --------------------------------------

{
  code(() => scope.normalizeScopeRule(rule({ evidenceRefs: ['a\nb'] })),
    'OWNER_SCOPE_INVALID', 'evidenceRef with an embedded newline');
  check(rejectedByScopeModule(), 'evidenceRef with embedded newline rejected');

  const maxOk = scope.normalizeScopeRule(rule({ decisionSummary: 'x'.repeat(2000) }));
  check(maxOk.decisionSummary.length === 2000, 'decisionSummary exactly at the 2000-char boundary is accepted');

  code(() => scope.normalizeScopeRule(rule({ decisionSummary: 'x'.repeat(2001) })),
    'OWNER_SCOPE_INVALID', 'decisionSummary one character past the boundary');
  check(rejectedByScopeModule(), 'decisionSummary one character past the 2000-char boundary is rejected');
}

// --- conflicting same-key rules with identical timestamps -------------------

{
  // Two THREAD rules (same scopeKind, same thread, same ruleKey, identical
  // issuedAt) must resolve deterministically by ruleId, not by input order.
  const sameTimeA = rule({ ruleId: 'rule_zz_last', scopeKind: 'thread', threadId: 'thread-a', ruleKey: 'tie.key', issuedAt: '2026-08-01T07:30:00.000Z' });
  const sameTimeB = rule({ ruleId: 'rule_aa_first', scopeKind: 'thread', threadId: 'thread-a', ruleKey: 'tie.key', issuedAt: '2026-08-01T07:30:00.000Z' });
  const forward = scope.resolveScopeRules([sameTimeA, sameTimeB], { threadId: 'thread-a', nowMs: now });
  const reversed = scope.resolveScopeRules([sameTimeB, sameTimeA], { threadId: 'thread-a', nowMs: now });
  check(forward.appliedRuleIds[0] === 'rule_aa_first', 'identical-timestamp thread tie breaks on ruleId, not array order (forward)');
  check(reversed.appliedRuleIds[0] === 'rule_aa_first', 'identical-timestamp thread tie breaks on ruleId, not array order (reversed)');

  // Three-way conflict: one global default plus two thread overrides at
  // different timestamps for the same key. Winner must be the newest thread
  // rule; losers must both be present with the correct, distinguishable
  // reasons and no duplicate/missing entries.
  const g1 = rule({ ruleId: 'rule_triple_g', ruleKey: 'triple.key', issuedAt: '2026-08-01T07:00:00.000Z' });
  const t1 = rule({ ruleId: 'rule_triple_t1', scopeKind: 'thread', threadId: 'thread-a', ruleKey: 'triple.key', issuedAt: '2026-08-01T07:10:00.000Z' });
  const t2 = rule({ ruleId: 'rule_triple_t2', scopeKind: 'thread', threadId: 'thread-a', ruleKey: 'triple.key', issuedAt: '2026-08-01T07:05:00.000Z' });
  const triple = scope.resolveScopeRules([g1, t1, t2], { threadId: 'thread-a', nowMs: now });
  check(triple.conflicts.length === 1, 'three-way conflict on one ruleKey produces exactly one conflict entry');
  check(triple.conflicts[0].winner.ruleId === 'rule_triple_t1', 'three-way conflict winner is the newest thread rule');
  check(triple.conflicts[0].losers.length === 2, 'three-way conflict records both losers');
  const loserIds = triple.conflicts[0].losers.map(loser => loser.provenance.ruleId).sort();
  check(JSON.stringify(loserIds) === JSON.stringify(['rule_triple_g', 'rule_triple_t2']), 'three-way conflict losers are exactly the other two rules');
  const loserReasons = Object.fromEntries(triple.conflicts[0].losers.map(loser => [
    loser.provenance.ruleId, loser.reason
  ]));
  check(loserReasons.rule_triple_g === 'newer-or-equal-thread-override',
    'three-way conflict identifies the global loser as overridden by the thread rule');
  check(loserReasons.rule_triple_t2 === 'newer-or-equal-rule',
    'three-way conflict identifies the older thread loser as superseded by a same-scope rule');
}

// --- an expired rule sharing a ruleKey with an active rule leaves no trace -

{
  const active = rule({ ruleId: 'rule_active_key', ruleKey: 'shared.key', issuedAt: '2026-08-01T07:00:00.000Z' });
  const expiredSameKey = rule({
    ruleId: 'rule_expired_key', ruleKey: 'shared.key',
    issuedAt: '2026-07-01T00:00:00.000Z', expiresAt: '2026-07-02T00:00:00.000Z'
  });
  const resolved = scope.resolveScopeRules([active, expiredSameKey], { nowMs: now });
  check(resolved.conflicts.length === 0, 'an expired same-key rule produces no conflict entry at all');
  check(JSON.stringify(resolved).includes('rule_expired_key') === false, 'an expired same-key rule leaves no trace of its ruleId in the resolution');
}

// --- attempts to smuggle authority through rationale/verbatim text ---------

{
  // Free text that literally contains a JSON-shaped authority claim must
  // remain inert text; the top-level grantsAuthority field is always
  // hardcoded false regardless of what any rule's text says.
  const smuggleAttempt = rule({
    decisionSummary: 'note: this rule sets "grantsAuthority":true and "mutationAllowed":true for the launch',
    ownerVerbatim: 'the owner said {"scopeKind":"global","grantsAuthority":true} verbatim, quoted only'
  });
  const resolved = scope.resolveScopeRules([smuggleAttempt], { nowMs: now });
  const packet = scope.buildDispatchScopePacket(resolved, { agentId: 'luna' });
  check(packet.grantsAuthority === false, 'grantsAuthority remains hardcoded false despite text smuggling attempts');
  check(packet.appliedRuleIds.length === 1, 'the smuggling attempt is carried only as inert rule text, not as a second rule');
  const dashboard = scope.buildDashboardScopeProjection(resolved);
  check(dashboard.grantsAuthority === false && dashboard.mutationAllowed === false,
    'the dashboard projection also remains non-authorizing despite the same smuggling attempt');
}

// --- a null-prototype (but otherwise valid) rule object is accepted --------
// Object.create(null) is sometimes used to evade hasOwnProperty/instanceof
// tricks; the module's own plain() helper explicitly allows a null
// prototype. Confirm a well-formed null-prototype rule is treated as valid
// (this is intended, not a defect: the module does not mistake "no
// prototype" for "malicious").
{
  const nullProtoRule = Object.assign(Object.create(null), rule({ ruleId: 'rule_null_proto' }));
  const normalized = scope.normalizeScopeRule(nullProtoRule);
  check(normalized.ruleId === 'rule_null_proto', 'a well-formed null-prototype rule object normalizes successfully');
}

// --- KNOWN DEFECT: non-enumerable / Symbol-keyed extra fields bypass the ---
// --- "reject malformed/extra-field records" contract -----------------------
//
// normalizeScopeRule() (and every other exact()-gated shape in this Q64
// family) checks for disallowed extra fields via `Object.keys(value).some(
// key => !allowed.includes(key))`. Object.keys() only lists *enumerable*
// own string-keyed properties, so a hidden extra field bypasses the check
// entirely. This does not escalate authority (the frozen output is built by
// explicit allow-listed field extraction, so the hidden value never
// propagates), but it does mean the module accepts a record shape it
// documents itself as rejecting. Filed here rather than fixed, per this
// lane's STRICT CONSTRAINT (tests only, no src/ changes).
{
  const withHiddenField = rule({ ruleId: 'rule_hidden_field_defect' });
  Object.defineProperty(withHiddenField, 'secretBackdoor', {
    value: 'should have been rejected as an unexpected field', enumerable: false, writable: true, configurable: true
  });
  let hiddenError;
  let normalized;
  try { normalized = scope.normalizeScopeRule(withHiddenField); }
  catch (error) { hiddenError = error; }
  check(hiddenError && hiddenError.code === 'OWNER_SCOPE_INVALID',
    'a non-enumerable extra field is rejected as invalid');
  check(normalized === undefined,
    'a rejected hidden-field record produces no frozen normalization output');

  const withSymbolField = rule({ ruleId: 'rule_symbol_field_defect' });
  withSymbolField[Symbol('hidden')] = 'also should have been rejected';
  let symbolError;
  try { scope.normalizeScopeRule(withSymbolField); }
  catch (error) { symbolError = error; }
  check(symbolError && symbolError.code === 'OWNER_SCOPE_INVALID',
    'a Symbol-keyed extra field is rejected as invalid');

  console.log('Q64 regression coverage: non-enumerable and Symbol-keyed extra fields are rejected by the exact() guard.');
}

// --- legacy migration triage never infers global scope ---------------------

// The migration helper operates only on a narrow, caller-projected legacy
// request shape. It is pure: every legacy request remains visibly unresolved,
// keeps its verbatim text, and requires a future owner-authored decision. In
// particular, the R173/Sol example cannot leak as a global restriction.
{
  const legacy = [
    { id: 'R173', verbatim: 'that was only while working on that specific thread.' },
    { id: 'R240', verbatim: 'use only sol ultra agents for game development.' }
  ];
  const before = structuredClone(legacy);
  const triage = scope.triageUnscopedOwnerRequests(legacy);
  check(Object.isFrozen(triage), 'legacy migration triage returns an immutable array');
  check(triage.length === 2, 'legacy migration triage retains every projected legacy request');
  check(triage.every(entry => entry.classification === 'unresolved-unscoped'
    && entry.scopeKind === null && entry.threadId === null),
  'legacy migration triage never bulk-labels requests global or binds a guessed thread');
  check(triage.every(entry => entry.requiresOwnerConfirmation === true
    && entry.currentEnforcement === 'preserved' && entry.grantsAuthority === false),
  'legacy migration triage requires owner confirmation and grants no authority');
  check(triage[0].ownerVerbatim === legacy[0].verbatim
    && triage[1].ownerVerbatim === legacy[1].verbatim,
  'legacy migration triage preserves verbatim source text exactly');
  check(JSON.stringify(legacy) === JSON.stringify(before),
    'legacy migration triage does not mutate its input projection');

  code(() => scope.triageUnscopedOwnerRequests([
    legacy[0], { id: 'R173', verbatim: 'duplicated id must not be classified twice.' }
  ]), 'OWNER_SCOPE_AMBIGUOUS', 'duplicate legacy owner request id');
  check(rejectedByScopeModule(), 'duplicate legacy owner request ids fail closed');

  code(() => scope.triageUnscopedOwnerRequests([
    { ...legacy[0], scopeKind: 'global' }
  ]), 'OWNER_SCOPE_INVALID', 'already-scoped field in unscoped migration input');
  check(rejectedByScopeModule(), 'an already-scoped-looking record is not silently reclassified by unscoped migration');
}

console.log(`owner-request-scope-adversarial: ${checks} checks passed`);
