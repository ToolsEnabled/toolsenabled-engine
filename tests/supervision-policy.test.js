// EXECUTABLE CHANGE
/*
Mutation report (testcanfail-tests-supervision-policy-test-js)

STRENGTHENED: the outcome assertions in the killswitch, failed-precondition,
allowed-attempt, initial/subsequent/reloaded/persistent quarantine, backoff, and
not-correctable checks used policy.OUTCOME (or reloaded.OUTCOME) as the expected
value. That expectation came from the same module as the returned outcome. They
now use the policy's externally visible outcome strings independently.

MUTATION: each OUTCOME value in src/lib/supervision/policy.js was temporarily
changed, one at a time, from its published string to MUTATED_<key>. Before this
change, MUTATED_KILLSWITCH left the entire file green: "supervision-policy: 14
checks passed". With these independent expectations, the mutations exited 1:
  KILLSWITCH: "+ 'MUTATED_KILLSWITCH'\n- 'CORRECTION_BLOCKED_BY_KILLSWITCH'"
  PRECONDITION_FAILED: "+ 'MUTATED_PRECONDITION_FAILED'\n- 'CORRECTION_PRECONDITION_FAILED'"
  ATTEMPT: "+ 'MUTATED_ATTEMPT'\n- 'CORRECTION_ATTEMPT'"
  QUARANTINED (all four assertions share this contract):
    "+ 'MUTATED_QUARANTINED'\n- 'CORRECTION_QUARANTINED'"
  BACKOFF: "+ 'MUTATED_BACKOFF'\n- 'CORRECTION_BACKOFF'"
  NOT_CORRECTABLE: "+ 'MUTATED_NOT_CORRECTABLE'\n- 'CORRECTION_NOT_APPLICABLE'"

RESTORE: the source was restored byte-for-byte (cmp exit 0; SHA-256
867fd2e2e8769008a89083df3891b9c752e3067fb5659704ed4cfb0d725399fc), then
`node tests/supervision-policy.test.js` was green again:
"supervision-policy: 14 checks passed".

NOT-FOUND (1): no assertion-only loop can be empty; `blocked` is a three-item
literal and the other assertion loops have fixed nonzero numeric bounds.
NOT-FOUND (2): no exit-status or truthy process-return assertion exists.
NOT-FOUND (3): no test failure is swallowed by try/catch or optional chaining.
NOT-FOUND (4): no assertion measures a mock of policy; injected collaborators
are inputs to the real policy decision function.
NOT-FOUND (5): there are no skips or platform precondition guards.
NOT-FOUND (6), beyond the outcome constants fixed above: no expected value is
computed by the same code it checks.
UNMET PRECONDITIONS: none.
*/
'use strict';

// Phase 5 (R93): correction must be bounded, precondition-gated, durable, and
// killswitch-respecting. The failure this guards against is subtle: a
// self-healer that always retries turns a chronic outage into permanent
// silence, which is worse than no self-healing at all.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const policy = require('../src/lib/supervision/policy.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-'));
  return { dir, file: path.join(dir, 'supervision-policy.json') };
}

const noJitter = () => 0.5;
const downFleet = {
  id: 'fleet-supervisor',
  state: 'DOWN',
  reason: 'scheduled task is not registered',
  correctable: true
};

// A COMPLETE, correctly-declared fleet argv, supplied as values.
//
// These checks used to let policy.decide() resolve the argv out of
// config/managed-processes.json. That file is now the shipped default registry
// and sets declaredArgv to [] for every subsystem on purpose: the
// fleet-supervisor --project value is a real cloud project id and must not
// ship. resolveArgv('fleet-supervisor') therefore returns nothing but the entry
// point, the precondition gate correctly reports missing --project/--backend,
// and every check below that expected a healthy correctable decision failed on
// that instead of on the behaviour it names. The project id here is a
// placeholder; the fixture is proved against the real gate in the positive
// check further down, so it cannot pass by bypassing the gate.
const managedProcesses = require('../src/lib/managed-processes.js');
const DECLARED_FLEET_ARGV = ['tools/fleet-supervisor.js', '--serve', '--quiet',
  '--concurrency', '4', '--project', 'example-vertex-project', '--backend', 'vertex'];

// Defaults first, caller's options last: a check that deliberately supplies its
// own resolveArgv (the incident #5 cases) still overrides these.
function decide(subsystem, options) {
  return policy.decide(subsystem, {
    resolveArgv: () => DECLARED_FLEET_ARGV,
    checkArgvPreconditions: managedProcesses.checkArgvPreconditions,
    ...options
  });
}

process.stdout.write('supervision-policy\n');

// --- Killswitch -------------------------------------------------------------

check('KILLSWITCH blocks correction', () => {
  const { dir, file } = tempState();
  const decision = decide(downFleet, { file, killSwitchActive: true, random: noJitter });
  assert.equal(decision.action, 'none');
  assert.equal(decision.outcome, 'CORRECTION_BLOCKED_BY_KILLSWITCH');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('KILLSWITCH does NOT block observation', () => {
  // Observation lives in health-invariants/observer and takes no killswitch
  // argument at all. Proving the negative: correction is the only consumer.
  const health = require('../src/lib/health-invariants.js');
  const observer = require('../src/lib/supervision/observer.js');
  const source = fs.readFileSync(require.resolve('../src/lib/health-invariants.js'), 'utf8')
    + fs.readFileSync(require.resolve('../src/lib/supervision/observer.js'), 'utf8');
  assert.doesNotMatch(source, /kill-switch/,
    'the evaluator and observer must not consult the kill switch; suppressing ' +
    'observation would mean activating the switch blinds you');

  // The claim under test is about the KILLSWITCH, so the subsystems are supplied
  // here as values rather than read from config/managed-processes.json. Letting
  // them default coupled this check to that file: the shipped registry declares
  // no `rungs`, so health.evaluate() threw HEALTH_REGISTRY_INVALID
  // ("dashboard declares no rungs") and this check died before it ever reached
  // the killswitch assertion. That registry gap is real and is guarded by
  // tests/health-invariants.test.js, which fails on the same throw; it is not
  // this file's contract, and duplicating it here only hid the killswitch check.
  const observable = (reason) => ({ kind: 'unobservable', reason });
  const fixture = [{
    id: 'fixture-subsystem',
    displayName: 'Fixture Subsystem',
    taskName: 'ToolsEnabled Fixture',
    entryPoint: 'tools/fixture.js',
    cwd: '.',
    rungs: {
      registered: observable('fixture subsystem is never registered on a test machine'),
      alive: observable('fixture subsystem is never started by this test'),
      functioning: observable('fixture subsystem exposes no probe endpoint here'),
      correct: observable('fixture subsystem has no correctness probe in this test')
    }
  }];

  const ctx = health.defaultContext({ getScheduledTask: () => null, fileExists: () => false });
  const snapshot = health.evaluate({ processes: fixture, ctx });
  assert.ok(Object.keys(snapshot.subsystems).length > 0,
    'full verdicts must still be produced regardless of killswitch state');
});

// --- Precondition gate (incident #5) ---------------------------------------

check('INCIDENT 5: an argv missing --project is REPORTED, never attempted', () => {
  const { dir, file } = tempState();
  const managedProcesses = require('../src/lib/managed-processes.js');

  // The EXACT argv the controller used when it restarted the supervisor and
  // caused 9 instant lane failures plus 8 falsely-parked queue items.
  const incidentArgv = ['tools/fleet-supervisor.js', '--serve', '--quiet', '--concurrency', '4'];

  const decision = decide(downFleet, {
    file,
    killSwitchActive: false,
    random: noJitter,
    resolveArgv: () => incidentArgv,
    checkArgvPreconditions: managedProcesses.checkArgvPreconditions
  });

  assert.equal(decision.action, 'none', 'the restart must NOT be attempted');
  assert.equal(decision.outcome, 'CORRECTION_PRECONDITION_FAILED');
  assert.deepEqual(decision.missing, ['--project', '--backend']);
  assert.equal(decision.argv, undefined, 'a refused correction must carry no spawn instruction');
  assert.equal(decision.escalate, true, 'a broken correction channel must be escalated, not swallowed');
  assert.match(decision.reason, /fail every lane/);

  // Nothing was recorded as an attempt, so a precondition failure cannot burn
  // the restart budget and push a healthy-but-misconfigured subsystem into
  // quarantine.
  assert.deepEqual(policy.loadState(file).subsystems, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

check('the correctly-declared fleet argv IS allowed through', () => {
  const { dir, file } = tempState();

  // The positive half of incident #5: a COMPLETE argv must not be refused.
  //
  // Guard the fixture first -- it must genuinely satisfy the real precondition
  // checker. Without this, DECLARED_FLEET_ARGV could drift into something the
  // gate would reject and every check using it would still "pass" by never
  // reaching a decision, which is the failure mode this file exists to catch.
  const precondition = managedProcesses.checkArgvPreconditions('fleet-supervisor', DECLARED_FLEET_ARGV);
  assert.equal(precondition.ok, true,
    `the fixture argv must satisfy the real gate, not bypass it: ${precondition.reason}`);

  const decision = decide(downFleet, { file, killSwitchActive: false, random: noJitter });
  assert.equal(decision.outcome, 'CORRECTION_ATTEMPT',
    `a complete argv should pass the gate: ${decision.reason}`);
  assert.ok(decision.argv.includes('--project'));
  assert.ok(decision.argv.includes('--backend'));
  fs.rmSync(dir, { recursive: true, force: true });
});

check('NO blocked decision ever carries a spawn instruction', () => {
  const { dir, file } = tempState();
  const blocked = [
    decide(downFleet, { file, killSwitchActive: true, random: noJitter }),
    decide(downFleet, { file, killSwitchActive: false, random: noJitter, resolveArgv: () => ['x', '--serve'] }),
    decide({ ...downFleet, correctable: false }, { file, killSwitchActive: false, random: noJitter })
  ];
  for (const decision of blocked) {
    assert.equal(decision.action, 'none', `expected no action for ${decision.outcome}`);
    assert.equal(decision.argv, undefined,
      `a ${decision.outcome} decision must carry no argv; an argv is an invitation to spawn`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Bounded backoff and quarantine ----------------------------------------

check('the 4th correction in 30 minutes yields QUARANTINED with zero attempts', () => {
  const { dir, file } = tempState();
  let now = 1785300000000;

  for (let i = 1; i <= 3; i += 1) {
    const decision = decide(downFleet, { file, nowMs: now, killSwitchActive: false, random: noJitter });
    assert.equal(decision.action, 'correct', `attempt ${i} should be allowed: ${decision.reason}`);
    assert.equal(decision.attempt, i);
    policy.recordAttempt('fleet-supervisor', { file, nowMs: now });
    now += 9 * 60 * 1000;                     // 9 minutes later, past any backoff
  }

  const fourth = decide(downFleet, { file, nowMs: now, killSwitchActive: false, random: noJitter });
  assert.equal(fourth.action, 'quarantine');
  assert.equal(fourth.outcome, 'CORRECTION_QUARANTINED');
  assert.equal(fourth.escalate, true, 'quarantine must raise exactly one escalation');
  assert.equal(policy.isQuarantined('fleet-supervisor', { file }), true,
    'returning a quarantine decision must durably apply it without relying on the caller');

  // Every subsequent sweep must attempt nothing at all.
  for (let i = 0; i < 5; i += 1) {
    now += 60000;
    const later = decide(downFleet, { file, nowMs: now, killSwitchActive: false, random: noJitter });
    assert.equal(later.action, 'none', 'a quarantined subsystem must never be corrected again');
    assert.equal(later.outcome, 'CORRECTION_QUARANTINED');
    assert.equal(later.escalate, false, 'quarantine must not re-escalate on every sweep');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

check('QUARANTINE SURVIVES a simulated observer restart', () => {
  const { dir, file } = tempState();
  policy.applyQuarantine('fleet-supervisor', 'chronic failure', { file, nowMs: 1785300000000 });

  // "Restarting the observer" = discarding all in-memory state and re-reading.
  delete require.cache[require.resolve('../src/lib/supervision/policy.js')];
  const reloaded = require('../src/lib/supervision/policy.js');

  assert.equal(reloaded.isQuarantined('fleet-supervisor', { file }), true,
    'a crash-looping observer that forgets its budgets resets every limit forever, ' +
    'which is exactly how self-healing becomes silence');
  const decision = reloaded.decide(downFleet, { file, killSwitchActive: false, random: noJitter });
  assert.equal(decision.outcome, 'CORRECTION_QUARANTINED');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('quarantine release is explicit and recorded, never automatic', () => {
  const { dir, file } = tempState();
  policy.applyQuarantine('fleet-supervisor', 'chronic failure', { file, nowMs: 1785300000000 });

  // A year later it is STILL quarantined: no timer sets it free.
  const muchLater = 1785300000000 + 365 * 24 * 3600 * 1000;
  assert.equal(policy.isQuarantined('fleet-supervisor', { file }), true);
  const stillBlocked = decide(downFleet, { file, nowMs: muchLater, killSwitchActive: false, random: noJitter });
  assert.equal(stillBlocked.outcome, 'CORRECTION_QUARANTINED');

  const released = policy.releaseQuarantine('fleet-supervisor', { file, releasedBy: 'owner', nowMs: muchLater });
  assert.equal(released.released, true);
  assert.match(released.reason, /released from quarantine by owner/);
  assert.equal(policy.isQuarantined('fleet-supervisor', { file }), false);

  const state = policy.loadState(file);
  assert.equal(state.subsystems['fleet-supervisor'].releasedBy, 'owner',
    'who released a quarantine must be recorded');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('backoff delays a too-soon retry', () => {
  const { dir, file } = tempState();
  const now = 1785300000000;
  decide(downFleet, { file, nowMs: now, killSwitchActive: false, random: noJitter });
  policy.recordAttempt('fleet-supervisor', { file, nowMs: now });

  // 5 seconds later: inside the 30s second-attempt backoff.
  const tooSoon = decide(downFleet, { file, nowMs: now + 5000, killSwitchActive: false, random: noJitter });
  assert.equal(tooSoon.action, 'none');
  assert.equal(tooSoon.outcome, 'CORRECTION_BACKOFF');
  assert.ok(tooSoon.retryAfterMs > 0);

  // 60 seconds later: past it.
  const allowed = decide(downFleet, { file, nowMs: now + 60000, killSwitchActive: false, random: noJitter });
  assert.equal(allowed.action, 'correct');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('attempts outside the 30 minute window do not count', () => {
  const { dir, file } = tempState();
  const now = 1785300000000;
  for (let i = 0; i < 3; i += 1) {
    policy.recordAttempt('fleet-supervisor', { file, nowMs: now - (40 * 60 * 1000) - i });
  }
  const decision = decide(downFleet, { file, nowMs: now, killSwitchActive: false, random: noJitter });
  assert.equal(decision.action, 'correct', 'an old burst must not quarantine a recovered subsystem');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Non-correctable states -------------------------------------------------

check('a STOPPED subsystem is never restarted', () => {
  const { dir, file } = tempState();
  const decision = decide(
    { id: 'fleet-supervisor', state: 'STOPPED', reason: 'stop sentinel present', correctable: false },
    { file, killSwitchActive: false, random: noJitter }
  );
  assert.equal(decision.action, 'none');
  assert.equal(decision.outcome, 'CORRECTION_NOT_APPLICABLE');
  assert.match(decision.reason, /override an owner decision/);
  fs.rmSync(dir, { recursive: true, force: true });
});

check('an UNKNOWN subsystem is not blindly restarted', () => {
  const { dir, file } = tempState();
  const decision = decide(
    { id: 'dashboard', state: 'UNKNOWN', reason: 'cannot read command line', correctable: false },
    { file, killSwitchActive: false, random: noJitter }
  );
  assert.equal(decision.action, 'none',
    'restarting something whose state you cannot determine is guessing, not managing');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- one_for_one ------------------------------------------------------------

check('a decision names exactly one subsystem and never cascades', () => {
  const { dir, file } = tempState();
  const decision = decide(downFleet, { file, killSwitchActive: false, random: noJitter });
  assert.equal(decision.id, 'fleet-supervisor');
  assert.ok(!Array.isArray(decision.action), 'a decision must be for one subsystem only');
  const source = fs.readFileSync(require.resolve('../src/lib/supervision/policy.js'), 'utf8');
  assert.doesNotMatch(source, /for\s*\(.*of\s+.*siblings/i,
    'nothing may restart a sibling because a different subsystem is unhealthy');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- Durability of the state file -------------------------------------------

check('a corrupt policy file refuses to fabricate an empty restart budget', () => {
  const { dir, file } = tempState();
  fs.writeFileSync(file, '{ not json', 'utf8');
  assert.throws(() => policy.loadState(file), error =>
    error && error.code === 'SUPERVISION_POLICY_STATE_MALFORMED');
  assert.throws(() => policy.recordAttempt('fleet-supervisor', { file }), error =>
    error && error.code === 'SUPERVISION_POLICY_STATE_MALFORMED',
  'recordAttempt must not overwrite the only durable state with fabricated history');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  fs.rmSync(dir, { recursive: true, force: true });
});

process.stdout.write(`\nsupervision-policy: ${passed} checks passed\n`);
