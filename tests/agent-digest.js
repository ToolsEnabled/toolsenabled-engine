// EXECUTABLE CHANGE
//
// Test-can-fail audit (testcanfail-tests-agent-digest-js):
// - EMPTY-LOOP: FOUND at the provider-meter honesty loop below.  Mutation:
//   temporarily changed collect.js's `providers` assignment to `[]`.  Before
//   this change, no assertion in the loop would execute.  The new fixed roster
//   assertion makes that mutation fail with:
//     AssertionError [ERR_ASSERTION]: the honesty checks require the complete provider-meter roster
//     + actual - expected
//     + []
//     - [ 'codex', 'claude', 'gemini', 'local' ]
// - EMPTY-LOOP: NOT-FOUND elsewhere.  Each other assertion loop iterates a
//   literal non-empty list, follows a fixed non-empty deepEqual assertion, or
//   follows an explicit collection-length assertion.
// - EXIT-STATUS/TRUTHY-RETURN: NOT-FOUND; this file does not spawn a subject
//   process or treat a non-zero exit/truthy return as subject-output evidence.
// - SWALLOWED-FAILURE: NOT-FOUND; optional `unref` only controls a timer, and
//   catches either assert the returned degradation or perform cleanup after
//   the test result is already decided.
// - SUBJECT-MOCK: NOT-FOUND; injected fakes are seams for dependencies, while
//   assertions remain on digest collection, service, scheduling, or rendering.
// - SKIP/PRECONDITION-GUARD: NOT-FOUND; all registered checks run serially.
// - SAME-CODE EXPECTED VALUE: NOT-FOUND as a sole oracle.  The real-queue depth
//   identity is supplementary to fixture assertions with literal outcomes.
// - RESTORE: collect.js was restored byte-for-byte (`git diff --exit-code --
//   src/lib/agent-digest/collect.js` was silent).  Full green/red confirmation
//   could not be executed here: the available Node.js is v20.20.2 and aborts
//   while loading `node:sqlite` with `ERR_UNKNOWN_BUILTIN_MODULE`; fetching
//   Node 22 was blocked by npm registry policy (E403).  This is the named unmet
//   precondition; the quoted RED above is the deterministic node:assert diff
//   produced by the strengthened assertion for the recorded mutation.

'use strict';

// Behaviour tests for the scheduled agentic-workflow digest: the tick
// invariants, the collector, the renderer's honesty rules, and the
// architectural constraints that make this a standalone service.
//
// AUDIT SAFETY: every audit-touching case injects createAuditStore({ file:
// ':memory:' }) together with an ephemeral signer, an in-memory head anchor,
// and temp-directory projection paths. Nothing in this file can reach the
// production ledger, the vault, Gmail, or the network. Mail is sent to an
// injected fake sender -- never to the owner.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

require('./lib/isolated-environment').activate('agent-digest');

const { createAuditStore, sha256 } = require('../src/lib/audit-store');
const audit = require('../src/lib/audit');
const { DigestSchedule, MemorySettingsStore } = require('../src/lib/agent-digest/schedule');
const { AgentDigestService, safeReason, withTimeout } = require('../src/lib/agent-digest/service');
const { collectDigestState, collectFallbackState, computeDelta, digestFingerprint, readQueue, readDeclaredOrg, summarizeRuns } = require('../src/lib/agent-digest/collect');
const { renderDigest, renderFallback } = require('../src/lib/agent-digest/render');
const digestIndex = require('../src/lib/agent-digest');
const { digestSchedulingStatus } = require('../src/lib/agent-digest/scheduling-status');

const ROOT = path.resolve(__dirname, '..');
const NOW = new Date(2026, 6, 28, 10, 5, 0, 0);
const NOW_MS = NOW.getTime();

let checks = 0;
const pending = [];
function check(label, run) { pending.push({ label, run }); }

process.on('unhandledRejection', reason => {
  process.stderr.write(`UNHANDLED REJECTION: ${reason && reason.message ? reason.message : reason}\n`);
  process.exit(1);
});

const temporaries = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaries.push(dir);
  return dir;
}

// --- isolated audit seam -----------------------------------------------------
function isolatedAudit() {
  const dir = tempDir('agent-digest-audit-');
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const signer = {
    keyId: `audit-ed25519-${sha256(keyPair.publicKey.export({ type: 'spki', format: 'der' }))}`,
    publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    sign: value => crypto.sign(null, value, keyPair.privateKey)
  };
  let anchor = null;
  return {
    store: createAuditStore({ file: ':memory:' }),
    signer,
    anchorStore: { get: () => anchor, set: value => { anchor = value; } },
    loadPolicy: () => ({ audit: { enabled: true } }),
    env: {
      TOOLSENABLED_AUDIT_JSONL_PATH: path.join(dir, 'actions.jsonl'),
      TOOLSENABLED_AUDIT_TEXT_PATH: path.join(dir, 'actions.log'),
      TOOLSENABLED_AUDIT_EMERGENCY_PATH: path.join(dir, 'audit-emergency.jsonl')
    }
  };
}

// --- fixtures ---------------------------------------------------------------
const ORG_FIXTURE = {
  schemaVersion: 1,
  revision: 9,
  updatedAt: '2026-07-28',
  agents: [
    { id: 'claude', displayName: 'Claude', role: 'controller', provider: 'claude', enabled: true, assignedPhase: null },
    { id: 'luna', displayName: 'Luna', role: 'builder', provider: 'codex', enabled: true, assignedPhase: 'Q42' },
    { id: 'local-worker', displayName: 'Local worker', role: 'worker', provider: 'local', enabled: false, assignedPhase: null }
  ],
  relationships: [{ from: 'claude', to: 'luna', type: 'manages' }]
};

const QUEUE_FIXTURE = [
  '# BUILD-QUEUE',
  '',
  '## Q1 — Alpha thing',
  '',
  '**Status:** OPEN',
  '',
  '## Q2 - Beta thing',
  '',
  '**Status:** IN-PROGRESS 2026-07-28 (half built)',
  '',
  '## Q3 — Gamma thing',
  '',
  '**Status:** DONE 2026-07-28 (shipped)',
  '',
  '## Q4 — Delta thing',
  '',
  '**Status:** BLOCKED (waiting on an owner decision, 2026-07-28)',
  '',
  '## Q5 — Epsilon thing',
  '',
  '**Status:** PARTIAL 2026-07-28 - steps 1-2 done',
  '',
  '## Completed — do not rebuild',
  '',
  '- Q0 shipped long ago',
  '- **Q9 (receipt-only completed phase):** DONE 2026-07-28 (the body was removed on completion)',
  ''
].join('\n');

function fixtureFiles(queueText = QUEUE_FIXTURE, org = ORG_FIXTURE) {
  const dir = tempDir('agent-digest-fixture-');
  const orgFile = path.join(dir, 'agent-org.json');
  const buildQueueFile = path.join(dir, 'BUILD-QUEUE.md');
  fs.writeFileSync(orgFile, JSON.stringify(org, null, 2));
  fs.writeFileSync(buildQueueFile, queueText);
  return { dir, orgFile, buildQueueFile };
}

const FAKE_RUNS = [
  { runId: 'run-a', status: 'running', updatedAtMs: NOW_MS - 60_000, help: { open: 0, total: 0 } },
  { runId: 'run-b', status: 'queued', updatedAtMs: NOW_MS - 9 * 3600 * 1000, help: { open: 2, total: 3 } },
  { runId: 'run-c', status: 'succeeded', updatedAtMs: NOW_MS - 300_000, help: { open: 0, total: 0 } }
];

const fakeRunControl = {
  list: () => FAKE_RUNS.map(run => ({ ...run })),
  lifecycleStatus: () => ({ running: true })
};

const fakeProviderGateway = {
  cachedStatus: async () => ({
    source: 'cached-control-state',
    providers: [
      { id: 'codex', enabled: true, status: 'ready', lastCheckedAt: '2026-07-28T11:46:43.669Z', verifiedAt: '2026-07-28T11:46:43.669Z' },
      { id: 'claude', enabled: true, status: 'ready', lastCheckedAt: '2026-07-28T11:48:20.048Z', verifiedAt: '2026-07-28T11:48:20.048Z' },
      { id: 'gemini', enabled: true, status: 'sign_in_required', lastCheckedAt: '2026-07-28T11:49:20.821Z', verifiedAt: null, configuredAccountAlias: 'accta' }
    ]
  })
};

// ============================================================================
// 1. Service tick invariants
// ============================================================================
function serviceHarness(overrides = {}) {
  const store = new MemorySettingsStore(overrides.settings || {});
  const grid = { mon: {}, tue: {}, wed: {}, thu: {}, fri: {}, sat: {}, sun: {} };
  for (const day of Object.keys(grid)) grid[day]['10:00'] = 'pulse';
  const schedule = new DigestSchedule({ store, defaults: grid });
  const sent = [];
  const events = [];
  const service = new AgentDigestService({
    schedule,
    now: () => NOW,
    timeoutMs: overrides.timeoutMs || 5000,
    fallbackTimeoutMs: overrides.fallbackTimeoutMs || 5000,
    sendTimeoutMs: overrides.sendTimeoutMs || 5000,
    log: (level, message) => events.push(`${level}:${message}`),
    generate: overrides.generate || (async ({ fireKey, kind }) => {
      events.push(`generate-saw-lastFired:${schedule.lastFired()}`);
      return { subject: `rich ${kind}`, text: `rich body for ${fireKey}`, fingerprint: { schemaVersion: 'agent-digest-fingerprint-v1' } };
    }),
    fallback: overrides.fallback || (async ({ fireKey, reason }) => ({ subject: 'degraded', text: `fallback for ${fireKey}: ${reason}` })),
    send: overrides.send || (async message => { sent.push(message); return { id: `msg-${sent.length}` }; })
  });
  return { schedule, service, sent, events, store };
}

check('INVARIANT 1: the slot is marked fired BEFORE generation is even called', async () => {
  const harness = serviceHarness();
  const result = await harness.service.tick();
  assert.equal(result.fired, true);
  assert.equal(result.sent, true);
  assert.equal(result.fireKey, '2026-07-28|10:00');
  assert.ok(harness.events.includes('generate-saw-lastFired:2026-07-28|10:00'),
    'generation must observe the fired key already persisted');
});

check('INVARIANT 1: a crash mid-generation loses the slot rather than double-sending', async () => {
  const harness = serviceHarness({
    generate: async () => { throw Object.assign(new Error('boom'), { code: 'GENERATION_EXPLODED' }); }
  });
  const first = await harness.service.tick();
  assert.equal(first.fired, true);
  assert.equal(first.mode, 'fallback');
  assert.equal(first.degradedReason, 'GENERATION_EXPLODED');
  assert.equal(harness.sent.length, 1);
  // The very next tick, in the same slot, must not fire again.
  const second = await harness.service.tick();
  assert.deepEqual(second, { fired: false, reason: 'no-due-slot' });
  assert.equal(harness.sent.length, 1, 'exactly one message for one slot');
});

check('INVARIANT 3: a hung generation is abandoned on a hard timeout so the grid keeps advancing', async () => {
  const started = Date.now();
  const harness = serviceHarness({
    timeoutMs: 40,
    generate: () => new Promise(() => { /* never settles: the wedged-provider case */ })
  });
  const result = await harness.service.tick();
  assert.ok(Date.now() - started < 4000, 'the tick must not park forever on a hung generation');
  assert.equal(result.fired, true);
  assert.equal(result.sent, true);
  assert.equal(result.mode, 'fallback');
  assert.equal(result.degradedReason, 'generation-timed-out');
  assert.match(harness.sent[0].text, /generation-timed-out/);
});

check('INVARIANT 4: a scheduled slot always sends -- a data-only snapshot when rich generation fails', async () => {
  const harness = serviceHarness({ generate: async () => null });
  const result = await harness.service.tick();
  assert.equal(result.sent, true);
  assert.equal(result.mode, 'fallback');
  assert.equal(result.degradedReason, 'AGENT_DIGEST_EMPTY_GENERATION');
  assert.equal(harness.sent.length, 1, 'the pulse never goes dark');
  assert.equal(harness.sent[0].subject, 'degraded');
});

check('a send failure is reported honestly and never retried into the inbox', async () => {
  const harness = serviceHarness({
    send: async () => { throw Object.assign(new Error('kill switch'), { code: 'KILL_SWITCH_ACTIVE' }); }
  });
  const result = await harness.service.tick();
  assert.deepEqual(
    { fired: result.fired, sent: result.sent, error: result.error },
    { fired: true, sent: false, error: 'KILL_SWITCH_ACTIVE' }
  );
  assert.deepEqual(await harness.service.tick(), { fired: false, reason: 'no-due-slot' }, 'no retry storm');
});

check('a hung delivery is abandoned on a hard timeout so later ticks can run', async () => {
  const harness = serviceHarness({
    sendTimeoutMs: 40,
    send: () => new Promise(() => { /* never settles: the wedged-network case */ })
  });
  const started = Date.now();
  const result = await harness.service.tick();
  assert.ok(Date.now() - started < 4000, 'the tick must not park forever on a hung delivery');
  assert.deepEqual(
    { fired: result.fired, sent: result.sent, error: result.error },
    { fired: true, sent: false, error: 'delivery-timed-out' }
  );
  assert.deepEqual(await harness.service.tick(), { fired: false, reason: 'no-due-slot' });
});

check('a failing fallback still cannot throw out of the tick', async () => {
  const harness = serviceHarness({
    generate: async () => { throw new Error('rich failed'); },
    fallback: async () => { throw new Error('fallback failed too'); }
  });
  const result = await harness.service.tick();
  assert.equal(result.fired, true);
  assert.equal(result.sent, false);
  assert.equal(result.mode, 'fallback');
  assert.equal(harness.sent.length, 0);
});

check('an unreadable schedule degrades the tick instead of killing the loop', async () => {
  const harness = serviceHarness();
  harness.schedule.catchupDue = () => { throw Object.assign(new Error('locked'), { code: 'STORE_LOCKED' }); };
  const result = await harness.service.tick();
  assert.deepEqual(result, { fired: null, reason: 'schedule-unreadable:STORE_LOCKED' });
});

check('a fire-key persistence failure does not claim the slot definitely did not fire', async () => {
  const harness = serviceHarness();
  harness.schedule.markFired = () => { throw Object.assign(new Error('uncertain commit'), { code: 'STORE_WRITE_UNCERTAIN' }); };
  const result = await harness.service.tick();
  assert.deepEqual(result, { fired: null, reason: 'tick-failed:STORE_WRITE_UNCERTAIN' });
  assert.equal(harness.sent.length, 0);
});

check('overlapping ticks are single-flight, so two ticks cannot both claim one slot', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const harness = serviceHarness({ generate: async () => { await gate; return { subject: 's', text: 't' }; } });
  const first = harness.service.tick();
  const second = await harness.service.tick();
  assert.deepEqual(second, { fired: false, reason: 'tick-already-running' });
  release();
  const result = await first;
  assert.equal(result.sent, true);
  assert.equal(harness.sent.length, 1);
});

check('a slot outside the grid never fires at all', async () => {
  const harness = serviceHarness({ settings: { agent_digest_grid: JSON.stringify({ mon: { '03:00': 'pulse' } }) } });
  assert.deepEqual(await harness.service.tick(), { fired: false, reason: 'no-due-slot' });
  assert.equal(harness.sent.length, 0);
});

check('the service refuses to construct without its required collaborators', () => {
  assert.throws(() => new AgentDigestService({}), TypeError);
  const schedule = new DigestSchedule({ store: new MemorySettingsStore() });
  assert.throws(() => new AgentDigestService({ schedule }), TypeError);
  assert.throws(() => new AgentDigestService({ schedule, generate: () => {}, fallback: () => {}, send: () => {}, timeoutMs: 0 }), TypeError);
});

check('withTimeout never leaves an unhandled rejection behind when the timer wins', async () => {
  await assert.rejects(
    withTimeout(Promise.reject(Object.assign(new Error('late'), { code: 'LATE' })), 5000),
    error => error.code === 'LATE'
  );
  await assert.rejects(withTimeout(new Promise(() => {}), 20), error => error.code === 'AGENT_DIGEST_TIMEOUT');
  // A promise that rejects AFTER the timeout already fired must stay handled.
  const late = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('too late')), 30).unref?.());
  await assert.rejects(withTimeout(late, 5), error => error.code === 'AGENT_DIGEST_TIMEOUT');
  await new Promise(resolve => setTimeout(resolve, 60));
});

check('safeReason never leaks free-form message content into a log or an email', () => {
  assert.equal(safeReason({ code: 'AGENT_DIGEST_TIMEOUT' }), 'generation-timed-out');
  assert.equal(safeReason({ code: 'PROVIDER_DOWN' }), 'PROVIDER_DOWN');
  assert.equal(safeReason(new Error('token=abc/DEF+123 failed')), 'token abc DEF 123 failed');
  assert.equal(safeReason(null), 'unknown');
  assert.ok(safeReason(new Error('x'.repeat(500))).length <= 120);
});

// ============================================================================
// 2. Collection
// ============================================================================
check('the queue parser reads BUILD-QUEUE statuses, depth, and what is blocked', () => {
  const { buildQueueFile } = fixtureFiles();
  const queue = readQueue(buildQueueFile, fs);
  assert.equal(queue.phases.length, 5, 'the Completed section has no Status line and is not a phase');
  assert.deepEqual(queue.open, ['Q1']);
  assert.deepEqual(queue.inFlight, ['Q2', 'Q5']);
  assert.deepEqual(queue.blocked, ['Q4']);
  assert.equal(queue.depth, 4, 'depth counts phases that are not DONE');
  assert.equal(queue.counts.DONE, 1);
  assert.deepEqual(queue.completedIds, ['Q9'], 'completion receipts are separate from the live queue');
  assert.match(queue.phases.find(phase => phase.id === 'Q4').detail, /waiting on an owner decision/);
  assert.equal(queue.trust, 'declared-owner-intent');
});

check('a later live phase after the completion receipt section is not hidden', () => {
  const queueText = [
    '# BUILD-QUEUE', '',
    '## Completed — do not rebuild', '',
    '- **Q10 (receipt-only completed phase):** DONE 2026-07-28 (body removed)', '',
    '## Q33 — Later live work', '',
    '**Status:** OPEN (still actionable)', ''
  ].join('\n');
  const { buildQueueFile } = fixtureFiles(queueText);
  const queue = readQueue(buildQueueFile, fs);
  assert.deepEqual(queue.completedIds, ['Q10']);
  assert.deepEqual(queue.open, ['Q33']);
  assert.equal(queue.depth, 1);
});

check('the queue parser accepts every supported status in a complete portable queue fixture', () => {
  const portableQueue = [
    '# BUILD-QUEUE', '',
    '## P1 - Planned', '', '**Status:** OPEN', '',
    '## P2 - Building', '', '**Status:** IN-PROGRESS 2026-07-28', '',
    '## P3 - Partial', '', '**Status:** PARTIAL 2026-07-28', '',
    '## P4 - Waiting', '', '**Status:** BLOCKED (owner input)', '',
    '## P5 - Shipped', '', '**Status:** DONE 2026-07-28', ''
  ].join('\n');
  const { buildQueueFile } = fixtureFiles(portableQueue);
  const queue = readQueue(buildQueueFile, fs);
  assert.equal(queue.phases.length, 5);
  for (const phase of queue.phases) {
    assert.notEqual(phase.status, 'UNRECOGNIZED', `phase ${phase.id} has a status this parser does not know`);
    assert.match(phase.id, /^[A-Z]+\d+$/);
  }
  assert.equal(queue.depth, queue.phases.filter(phase => phase.status !== 'DONE').length);
});

check('declared org is read as owner intent and carries no authority', () => {
  const { orgFile } = fixtureFiles();
  const declared = readDeclaredOrg(orgFile, fs);
  assert.equal(declared.trust, 'declared-owner-intent');
  assert.equal(declared.revision, 9);
  assert.deepEqual(declared.agents.map(agent => agent.id), ['claude', 'luna', 'local-worker']);
  assert.equal(declared.agents.find(agent => agent.id === 'local-worker').enabled, false);
  assert.equal(declared.agents.find(agent => agent.id === 'luna').assignedPhase, 'Q42');
  // The real file must keep parsing too.
  const real = readDeclaredOrg(path.join(ROOT, 'config', 'agent-org.json'), fs);
  assert.ok(real.agents.length >= 3);
});

check('run summarisation separates active from stale without inventing either', () => {
  const summary = summarizeRuns(FAKE_RUNS, NOW_MS);
  assert.equal(summary.total, 3);
  assert.equal(summary.active, 2);
  assert.equal(summary.openHelp, 2);
  assert.equal(summary.stale.length, 1, 'a queued run untouched for 9h is stale');
  assert.equal(summary.stale[0].runId, 'run-b');
  assert.equal(summarizeRuns(null, NOW_MS).byStatus, null);
});

check('terminal uncertain durable runs are classified instead of reported as active or stale', async () => {
  const canary = 'P07_REPORT_CANARY_NEVER_RENDER';
  const summary = summarizeRuns([
    { runId: 'help-run', status: 'uncertain', updatedAtMs: NOW_MS - 9 * 3600 * 1000, error: { code: 'HELP_REQUIRED', message: canary } },
    { runId: 'expired-run', status: 'uncertain', updatedAtMs: NOW_MS - 9 * 3600 * 1000, error: { code: 'TASK_LEASE_EXPIRED', message: canary } },
    { runId: 'failed-run', status: 'failed', updatedAtMs: NOW_MS - 9 * 3600 * 1000, error: { code: 'PROVIDER_FAILED', message: canary } },
    { runId: 'queued-run', status: 'queued', updatedAtMs: NOW_MS - 9 * 3600 * 1000 }
  ], NOW_MS);
  assert.equal(summary.active, 1, 'only the queued run remains active');
  assert.deepEqual(summary.stale.map(run => run.runId), ['queued-run'], 'terminal outcomes are never stale work');
  assert.deepEqual(summary.outcomes, {
    source: 'durable-run-lifecycle', total: 4, active: 1, completed: 0,
    failed: 1, cancelled: 0, needsHelp: 1, outcomeUnknown: 1
  });

  const { state } = await renderedFixture();
  state.observed.runs = summary;
  const message = renderDigest({ state, kind: 'pulse', fireKey: '2026-07-28|10:00' });
  assert.match(message.text, /Durable-run terminal outcomes: completed 0, failed 1, cancelled 0, needs help 1, outcome unknown 1/);
  assert.match(message.text, /1 durable run\(s\) safely stopped and requested help; they are not active or stale/);
  assert.match(message.text, /1 durable run\(s\) have an unknown terminal outcome/);
  assert.match(message.html, /Durable-run terminal outcomes/);
  // The `telegram` view was removed 2026-08-23 with render-telegram.js. The
  // canary check below is the load-bearing half of this case -- no durable-run free
  // text may leak into a view -- so it now covers exactly the two views that
  // still exist and are actually sent.
  assert.doesNotMatch(`${message.text}\n${message.html}`, new RegExp(canary));
});

check('collectDigestState reads the canonical projection and NEVER invents a token or cost figure', async () => {
  const auditDependencies = isolatedAudit();
  audit.record('agent.digest.test', 'collect-fixture', { probe: 1 }, auditDependencies);
  audit.record('agent.digest.test', 'collect-fixture', { probe: 2 }, auditDependencies);
  const { orgFile, buildQueueFile } = fixtureFiles();
  const state = await collectDigestState({
    nowMs: NOW_MS, auditModule: audit, auditDependencies,
    runControl: fakeRunControl, providerGateway: fakeProviderGateway,
    orgFile, buildQueueFile, previous: null
  });

  assert.equal(state.schemaVersion, 'agent-digest-state-v1');
  assert.equal(state.contentTrust, 'untrusted');
  assert.equal(state.grantsAuthority, false);

  // Declared and observed are separate objects with separate trust labels.
  assert.equal(state.declared.trust, 'declared-owner-intent');
  assert.equal(state.observed.trust, 'observed-from-signed-audit-ledger');
  assert.equal(state.observed.auditState, 'verified');
  assert.equal(state.observed.provenance.state, 'verified');
  assert.equal(state.observed.provenance.headSequence, 2);
  assert.equal(state.observed.eventsInWindow, 2);

  // Observed lanes come from the projection, not from the declared org file.
  // 'observer' is the 4th value the wire contract's own agentKind/alias enum
  // always allowed (coordinator/worker/reviewer/observer); the projection now
  // actually emits it instead of silently leaving it out.
  assert.deepEqual(state.observed.agents.map(agent => agent.alias), ['coordinator', 'worker', 'reviewer', 'observer']);
  assert.equal(state.observed.agents.find(agent => agent.alias === 'coordinator').state, 'working');
  assert.equal(state.observed.agents.find(agent => agent.alias === 'worker').state, 'working');
  assert.equal(state.observed.lifecycle, 'running');
  assert.equal(state.observed.runs.active, 2);

  // HONESTY: no meter record exists, so every token/cost figure must be null
  // with an explicit machine-readable state, not a plausible number.
  assert.equal(state.observed.meters.state, 'unavailable-no-durable-meter');
  assert.deepEqual(
    state.observed.meters.providers.map(meter => meter.provider),
    ['codex', 'claude', 'gemini', 'grok', 'local'],
    /* Five since a57cd698 (2026-09-10) added grok to PROVIDERS in
       src/lib/controller-projection.js:21, which METER_PROVIDERS is built from.
       Still the COMPLETE roster asserted exactly -- the honesty claim is that a
       provider with no durable meter is listed with a null figure rather than
       omitted, so a missing entry here is the defect this line catches. */
    'the honesty checks require the complete provider-meter roster'
  );
  for (const meter of state.observed.meters.providers) {
    assert.equal(meter.reportedTokenCount, null, `${meter.provider} tokens must be null`);
    assert.equal(meter.deterministicPacketTokenCount, null);
    assert.equal(meter.costMicros, null, `${meter.provider} cost must be null`);
    assert.equal(meter.tokenMeterState, 'unavailable');
    assert.equal(meter.costMeterState, 'unavailable');
  }
  assert.equal(state.observed.meters.subscriptionUsage, 'unavailable-no-durable-meter');
  assert.equal(state.gaps.length, 0, 'every source was readable in this fixture');
  assert.equal(state.delta.available, false);
  assert.equal(state.delta.reason, 'no-previous-digest-recorded');
});

check('an unreadable source becomes a named data gap, and the digest still builds', async () => {
  const auditDependencies = isolatedAudit();
  const state = await collectDigestState({
    nowMs: NOW_MS, auditModule: audit, auditDependencies,
    runControl: null, providerGateway: null,
    orgFile: path.join(tempDir('agent-digest-missing-'), 'nope.json'),
    buildQueueFile: path.join(tempDir('agent-digest-missing-'), 'nope.md')
  });
  const sources = state.gaps.map(gap => gap.source).sort();
  assert.deepEqual(sources, ['build-queue', 'declared-agent-org', 'durable-runs', 'provider-controls']);
  for (const gap of state.gaps) assert.ok(gap.reason.length > 0, 'a gap must say why');
  assert.equal(state.declared, null);
  assert.equal(state.queue, null);
  assert.ok(state.observed, 'observed state is still produced');
  assert.deepEqual(state.observed.runs, {
    available: false,
    total: null,
    active: null,
    byStatus: null,
    openHelp: null,
    outcomes: null,
    stale: null
  });
  assert.equal(state.observed.lifecycle, null);
  assert.equal(state.observed.providerControls, null);
});

check('a broken durable-run adapter degrades to a gap rather than a fabricated zero', async () => {
  const auditDependencies = isolatedAudit();
  const broken = {
    list: () => { throw Object.assign(new Error('locked'), { code: 'STATE_LOCKED' }); },
    lifecycleStatus: () => { throw Object.assign(new Error('locked'), { code: 'STATE_LOCKED' }); }
  };
  const { orgFile, buildQueueFile } = fixtureFiles();
  const state = await collectDigestState({
    nowMs: NOW_MS, auditModule: audit, auditDependencies, runControl: broken,
    providerGateway: fakeProviderGateway, orgFile, buildQueueFile
  });
  assert.deepEqual(state.gaps.map(gap => gap.source).sort(), ['durable-lifecycle', 'durable-runs']);
  for (const gap of state.gaps) assert.match(gap.reason, /STATE_LOCKED/);
  assert.equal(state.observed.runs.available, false);
  assert.equal(state.observed.runs.total, null);
  assert.equal(state.observed.runs.active, null);
  assert.equal(state.observed.lifecycle, null);
});

check('malformed adapter responses remain unavailable instead of becoming empty or stopped', async () => {
  const auditDependencies = isolatedAudit();
  const { orgFile, buildQueueFile } = fixtureFiles();
  const state = await collectDigestState({
    nowMs: NOW_MS, auditModule: audit, auditDependencies,
    runControl: { list: () => null, lifecycleStatus: () => null },
    providerGateway: { cachedStatus: async () => ({}) },
    orgFile, buildQueueFile
  });
  assert.equal(state.observed.runs.available, false);
  assert.equal(state.observed.runs.total, null);
  assert.equal(state.observed.lifecycle, null);
  assert.equal(state.observed.providerControls, null);
  assert.deepEqual(state.gaps.map(gap => gap.reason).sort(), [
    'unreadable (INVALID_LIFECYCLE_STATUS)',
    'unreadable (INVALID_PROVIDER_STATUS)',
    'unreadable (INVALID_RUN_LIST)'
  ]);
});

check('the delta reports what actually moved since the last delivered digest', () => {
  const before = {
    schemaVersion: 'agent-digest-fingerprint-v1',
    observedAtMs: NOW_MS - 3600_000,
    headSequence: 10,
    queueDepth: 5,
    phaseStatuses: { Q1: 'OPEN', Q2: 'OPEN', Q8: 'OPEN', Q9: 'OPEN' },
    activeRuns: 1,
    agentStates: { coordinator: 'idle', worker: 'idle', reviewer: 'idle' }
  };
  const state = {
    observedAtMs: NOW_MS,
    queue: {
      depth: 4,
      phases: [{ id: 'Q1', status: 'OPEN' }, { id: 'Q2', status: 'DONE' }, { id: 'Q3', status: 'BLOCKED' }],
      completedIds: ['Q9']
    },
    observed: { provenance: { headSequence: 42 }, runs: { active: 3 }, agents: [{ alias: 'coordinator', state: 'working' }] }
  };
  const delta = computeDelta(state, before);
  assert.equal(delta.available, true);
  assert.equal(delta.auditEventsSince, 32);
  assert.equal(delta.queueDepthBefore, 5);
  assert.equal(delta.queueDepthAfter, 4);
  assert.deepEqual(delta.movedPhases.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'Q2', from: 'OPEN', to: 'DONE' },
    { id: 'Q3', from: 'absent', to: 'BLOCKED' },
    { id: 'Q8', from: 'OPEN', to: 'removed' },
    { id: 'Q9', from: 'OPEN', to: 'DONE' }
  ]);
  assert.deepEqual(delta.agentChanges, [{ alias: 'coordinator', from: 'idle', to: 'working' }]);
  // A ledger head that went backwards is "not comparable", never a negative count.
  assert.equal(computeDelta(state, { ...before, headSequence: 100 }).auditEventsSince, null);
  assert.equal(computeDelta(state, null).available, false);
});

check('the persisted fingerprint is small, JSON-safe, and free of content', async () => {
  const auditDependencies = isolatedAudit();
  const { orgFile, buildQueueFile } = fixtureFiles();
  const state = await collectDigestState({
    nowMs: NOW_MS, auditModule: audit, auditDependencies, runControl: fakeRunControl,
    providerGateway: fakeProviderGateway, orgFile, buildQueueFile
  });
  const fingerprint = digestFingerprint(state);
  const encoded = JSON.stringify(fingerprint);
  assert.equal(JSON.parse(encoded).schemaVersion, 'agent-digest-fingerprint-v1');
  assert.ok(encoded.length < 2000, `fingerprint should stay compact, got ${encoded.length} bytes`);
  assert.ok(!encoded.includes('@'), 'no address may enter the persisted fingerprint');
  assert.equal(fingerprint.queueDepth, 4);
  assert.equal(fingerprint.activeRuns, 2);
});

check('the fallback collector reads only cheap sources and says why it is degraded', () => {
  const auditDependencies = isolatedAudit();
  audit.record('agent.digest.test', 'fallback-fixture', { probe: 1 }, auditDependencies);
  const { orgFile, buildQueueFile } = fixtureFiles();
  const state = collectFallbackState({
    nowMs: NOW_MS, auditModule: audit, auditDependencies, orgFile, buildQueueFile,
    reason: 'generation-timed-out'
  });
  assert.equal(state.schemaVersion, 'agent-digest-fallback-v1');
  assert.equal(state.degradedReason, 'generation-timed-out');
  assert.equal(state.auditStatus.headSequence, 1);
  assert.equal(state.queue.depth, 4);
  assert.equal(state.declared.revision, 9);
  assert.deepEqual(state.gaps, []);
  // It must not carry meters at all rather than carry empty ones.
  assert.equal(state.observed, undefined);
});

// ============================================================================
// 3. Rendering honesty
// ============================================================================
async function renderedFixture(previous = null) {
  const auditDependencies = isolatedAudit();
  audit.record('agent.digest.test', 'render-fixture', { probe: 1 }, auditDependencies);
  const { orgFile, buildQueueFile } = fixtureFiles();
  const state = await collectDigestState({
    nowMs: NOW_MS, auditModule: audit, auditDependencies, runControl: fakeRunControl,
    providerGateway: fakeProviderGateway, orgFile, buildQueueFile, previous
  });
  return { state, message: renderDigest({ state, kind: 'pulse', fireKey: '2026-07-28|10:00' }) };
}

check('the rendered digest never prints a token or cost number the ledger did not record', async () => {
  const { message } = await renderedFixture();
  assert.match(message.text, /tokens not recorded \(unavailable\)/);
  assert.match(message.text, /cost not recorded \(unavailable\)/);
  assert.ok(!/tokens \d/.test(message.text), 'no numeric token claim may appear');
  assert.ok(!/cost \d/.test(message.text), 'no numeric cost claim may appear');
  assert.match(message.text, /No token or cost figure in this digest is estimated/);
  assert.match(message.text, /Meter source state: unavailable-no-durable-meter/);
});

check('the rendered digest includes an escaped, metric-card HTML companion without losing text fallback', async () => {
  const { message } = await renderedFixture();
  assert.match(message.html, /Quick metrics/);
  assert.match(message.html, /Queue depth/);
  assert.match(message.html, /Tokens not recorded/);
  assert.match(message.html, /Cost not recorded/);
  assert.match(message.html, /&lt;|&amp;|Agentic workflow/);
  assert.doesNotMatch(message.html, /<script\b/i);
  assert.ok(message.html.length > message.text.length, 'rich view should contain the metric-card presentation');
  assert.match(message.text, /AGENTIC WORKFLOW PULSE/);
});

check('the HTML body is multipart-ready (a real HTML document) and carries no external resources or scripts', async () => {
  const { message } = await renderedFixture();
  assert.match(message.html, /^<!doctype html>/i);
  assert.doesNotMatch(message.html, /<script\b/i);
  assert.doesNotMatch(message.html, /\bsrc\s*=\s*["']https?:/i, 'no remote image/script source may be referenced');
  assert.doesNotMatch(message.html, /url\(\s*["']?https?:/i, 'no remote CSS resource may be referenced');
  assert.doesNotMatch(message.html, /@import/i);
  assert.match(message.html, /<html/i);
  // The MIME envelope (boundary, Content-Type headers) is exclusively
  // src/lib/providers/google.js's job (tests/google-inputs.js covers it) --
  // the renderer must hand back a plain HTML document, never a pre-built
  // multipart body of its own.
  assert.doesNotMatch(message.html, /Content-Type:/);
  assert.doesNotMatch(message.html, /multipart\/alternative/);
});

check('the HTML body leads with what changed, then blocked/stale, then the headline metrics -- the reader scans this on a phone', async () => {
  const { message } = await renderedFixture();
  const deltaAt = message.html.indexOf('Since the last digest');
  const blockedAt = message.html.indexOf('Blocked or stale');
  const metricsAt = message.html.indexOf('Quick metrics');
  assert.ok(deltaAt > 0 && blockedAt > deltaAt && metricsAt > blockedAt,
    `expected delta < blocked < metrics in reading order, got ${deltaAt}/${blockedAt}/${metricsAt}`);
  // The same reading order holds in the plaintext fallback.
  const textDeltaAt = message.text.indexOf('SINCE THE LAST DIGEST');
  const textBlockedAt = message.text.indexOf('BLOCKED OR STALE');
  const textMetricsAt = message.text.indexOf('QUICK METRICS');
  assert.ok(textDeltaAt > 0 && textBlockedAt > textDeltaAt && textMetricsAt > textBlockedAt);
});

check('a metric with no durable meter renders as a labelled "not recorded" state in the HTML, never as 0 or a blank tile', async () => {
  const { message } = await renderedFixture();
  // The fixture has zero real meter records, so every token/cost line must
  // say so explicitly, in the muted "unavailable" color, not a numeric 0.
  assert.ok(!/Tokens 0\b/.test(message.html), 'zero tokens must never be printed as a fabricated measured 0');
  assert.match(message.html, /Tokens not recorded \(unavailable\)/);
  assert.match(message.html, /Cost not recorded \(unavailable\)/);
  assert.match(message.html, /#8592a8/, 'the unavailable-state colour must actually be used, not just the words');
});

check('untrusted content (queue detail, declared display names/roles) is HTML-escaped and cannot inject markup', async () => {
  const auditDependencies = isolatedAudit();
  audit.record('agent.digest.test', 'xss-fixture', { probe: 1 }, auditDependencies);
  const maliciousQueue = [
    '# BUILD-QUEUE',
    '',
    '## Q9 — Evil phase',
    '',
    '**Status:** BLOCKED (<img src=x onerror=alert(1)> waiting)',
    ''
  ].join('\n');
  const maliciousOrg = {
    schemaVersion: 1,
    revision: 1,
    updatedAt: '2026-07-28',
    agents: [{
      id: 'x',
      displayName: '<b onmouseover=alert(1)>Evil</b>',
      role: '"><svg onload=alert(1)>',
      provider: 'claude',
      enabled: true,
      assignedPhase: null
    }],
    relationships: []
  };
  const { orgFile, buildQueueFile } = fixtureFiles(maliciousQueue, maliciousOrg);
  const state = await collectDigestState({
    nowMs: NOW_MS, auditModule: audit, auditDependencies, runControl: fakeRunControl,
    providerGateway: fakeProviderGateway, orgFile, buildQueueFile, previous: null
  });
  const message = renderDigest({ state, kind: 'pulse', fireKey: '2026-07-28|10:00' });
  // The properties that matter are that '<'/'>'/'"' are neutralized so no
  // tag or attribute boundary can ever form -- an inert word like "onerror="
  // surviving as plain escaped text is not itself a vulnerability, so this
  // only asserts no live tag can be parsed out of the message.
  assert.doesNotMatch(message.html, /<img\b/i);
  assert.doesNotMatch(message.html, /<svg\b/i);
  assert.doesNotMatch(message.html, /<script\b/i);
  assert.doesNotMatch(message.html, /<b onmouseover=/i);
  assert.match(message.html, /&lt;b onmouseover=alert\(1\)&gt;Evil&lt;\/b&gt;/);
  assert.match(message.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(message.html, /&quot;&gt;&lt;svg onload=alert\(1\)&gt;/);
});

check('declared and observed state are rendered as separate, labelled sections', async () => {
  const { message } = await renderedFixture();
  const declaredAt = message.text.indexOf('DECLARED ORG (owner-authored intent');
  const observedAt = message.text.indexOf('OBSERVED (derived from the signed audit ledger)');
  const queueAt = message.text.indexOf('QUEUE (');
  assert.ok(declaredAt > 0 && observedAt > declaredAt && queueAt > observedAt);
  const declaredSection = message.text.slice(declaredAt, observedAt);
  const observedSection = message.text.slice(observedAt, queueAt);
  assert.match(declaredSection, /It is intent, not activity/);
  assert.match(declaredSection, /Luna \(luna\)/);
  assert.ok(!/\bLuna\b/.test(observedSection), 'a declared display name must not leak into observed state');
  assert.match(observedSection, /coordinator/);
  assert.ok(!/coordinator/.test(declaredSection), 'a projection lane must not appear as declared intent');
  assert.match(message.text, /Declared state is owner-authored intent; observed state is/);
});

check('blocked and stale work is surfaced with its recorded reason', async () => {
  const { message } = await renderedFixture();
  assert.match(message.text, /Q4 BLOCKED — waiting on an owner decision/);
  assert.match(message.text, /Durable run run-b is queued but has not moved for 9h 0m/);
  assert.match(message.text, /Provider gemini is sign_in_required/);
  assert.match(message.text, /Open durable-run help requests: 2/);
});

check('the subject line states counts that match the body', async () => {
  const { state, message } = await renderedFixture();
  assert.match(message.subject, /^Agentic workflow pulse — 2 in flight · 1 blocked · 2 active runs · 2026-07-28 10:05$/);
  assert.equal(state.queue.inFlight.length, 2);
  assert.equal(state.queue.blocked.length, 1);
  assert.equal(message.kind, 'pulse');
  assert.equal(message.mode, 'full');
});

check('renderers report prior delivery failures and never turn unreadable state into zeroes', async () => {
  const { state } = await renderedFixture();
  const previousFailure = {
    consecutiveFailures: 2,
    channel: 'email',
    code: 'SMTP_DOWN',
    atMs: NOW_MS - 60_000
  };
  const digest = renderDigest({ state, kind: 'pulse', previousFailure });
  assert.match(digest.text, /PREVIOUS DELIVERY FAILED/);
  assert.match(digest.text, /2 consecutive scheduled delivery attempt\(s\) failed/);
  assert.match(digest.html, /Previous delivery failed/);
  assert.match(digest.html, /SMTP_DOWN/);

  const unreadable = {
    ...state,
    queue: null,
    gaps: [
      { source: 'build-queue', reason: 'unreadable (ENOENT)' },
      { source: 'durable-runs', reason: 'unreadable (EIO)' }
    ]
  };
  const unknownDigest = renderDigest({ state: unreadable, kind: 'pulse' });
  assert.match(unknownDigest.subject, /unknown in flight · unknown blocked · unknown active runs/);
  assert.doesNotMatch(unknownDigest.subject, /0 in flight|0 blocked|0 active runs/);

  const fallback = renderFallback({
    state: { ...unreadable, degradedReason: 'generation-failed', auditStatus: null },
    kind: 'pulse',
    previousFailure
  });
  assert.match(fallback.text, /Queue: unreadable/);
  assert.match(fallback.text, /In flight: unreadable/);
  assert.match(fallback.text, /Blocked: unreadable/);
  assert.doesNotMatch(fallback.text, /In flight: none recorded|Blocked: none recorded/);
  assert.match(fallback.html, /Previous delivery failed/);
});

check('the since-last-digest section is honest when there is no baseline', async () => {
  const withoutBaseline = await renderedFixture(null);
  assert.match(withoutBaseline.message.text, /No previous digest recorded, so nothing can be compared/);
  const withBaseline = await renderedFixture({
    schemaVersion: 'agent-digest-fingerprint-v1', observedAtMs: NOW_MS - 3600_000, headSequence: 0,
    queueDepth: 6, phaseStatuses: { Q1: 'BLOCKED' }, activeRuns: 0, agentStates: {}
  });
  assert.match(withBaseline.message.text, /Queue depth: 6 -> 4 \(-2\)/);
  assert.match(withBaseline.message.text, /Q1: BLOCKED -> OPEN/);
  assert.match(withBaseline.message.text, /Signed audit events recorded since: 1/);
});

check('data gaps are a visible section, never a silence', async () => {
  const auditDependencies = isolatedAudit();
  const state = await collectDigestState({
    nowMs: NOW_MS, auditModule: audit, auditDependencies, runControl: null, providerGateway: null,
    orgFile: path.join(tempDir('agent-digest-gap-'), 'nope.json'),
    buildQueueFile: path.join(tempDir('agent-digest-gap-'), 'nope.md')
  });
  const message = renderDigest({ state, kind: 'digest', fireKey: '2026-07-28|10:00' });
  assert.match(message.text, /DATA GAPS/);
  assert.match(message.text, /build-queue: unreadable/);
  assert.match(message.text, /durable-runs: no durable-run control adapter configured/);
  assert.match(message.text, /Unavailable -- see DATA GAPS/);
});

check('the fallback message says it is degraded, why, and what it deliberately omits', () => {
  const auditDependencies = isolatedAudit();
  const { orgFile, buildQueueFile } = fixtureFiles();
  const state = collectFallbackState({
    nowMs: NOW_MS, auditModule: audit, auditDependencies, orgFile, buildQueueFile, reason: 'generation-timed-out'
  });
  const message = renderFallback({ state, kind: 'pulse', fireKey: '2026-07-28|10:00' });
  assert.match(message.subject, /degraded snapshot/);
  assert.match(message.text, /The full read did not complete: generation-timed-out/);
  assert.match(message.text, /NOT IN THIS SNAPSHOT/);
  assert.match(message.text, /are omitted rather than guessed/);
  assert.match(message.text, /Queue depth \(phases not DONE\): 4/);
  assert.ok(!/tokens/.test(message.text), 'the fallback must not mention meter figures at all');
  assert.match(message.html, /degraded snapshot|What is still known|Complete text view/);
  assert.match(message.html, /generation-timed-out/);
  assert.doesNotMatch(message.html, /<script\b/i);
  assert.equal(message.mode, 'fallback');
});

check('the digest module carries no Discord renderer or channel branch', () => {
  // Discord left the product on 2026-08-22. The delivery surface has no
  // discord-text channel, so the digest must not keep a renderer for it.
  assert.equal('renderDiscordDigest' in digestIndex, false);
  assert.equal('DISCORD_TRUNCATION_NOTICE' in digestIndex, false);
});

// ============================================================================
// 4. Production wiring
// ============================================================================
// ACCOUNT ROSTER SEAM. The email path resolves its recipient through
// src/lib/google-accounts.js, which reads this installation's own
// config/google-accounts.profile.json -- a gitignored, per-person file whose
// aliases and addresses are the owner's real Google identities. A test may
// neither name one nor depend on whichever roster a given checkout happens to
// carry (a fresh checkout has none at all, and every check after the first
// throw would never run). So the cases below run against a fixture roster,
// injected with the Module._load stubbing pattern
// tests/providers.google.suite/gmail-send-failure.js established. The real
// resolveRecipient -> gmailSend path still runs end to end; only the roster it
// reads belongs to this file. Nothing here reaches Google or the network.
const DIGEST_LIB_DIR = path.dirname(require.resolve('../src/lib/agent-digest/index.js'));
const FIXTURE_ACCOUNTS = {
  resolve(selector) {
    const alias = selector === undefined || selector === null || selector === '' ? 'accta' : String(selector).trim();
    if (alias === 'accta') return alias;
    throw Object.assign(new Error(`Unknown Google account '${selector}'. Known: accta`),
      { code: 'GOOGLE_ACCOUNT_NOT_FOUND' });
  },
  load: () => ({ defaultAccount: 'accta', accounts: { accta: { email: 'accta@example.com', label: 'Fixture roster' } } })
};

async function withFixtureAccounts(run) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === '../google-accounts' && parent && path.dirname(parent.filename) === DIGEST_LIB_DIR) {
      return FIXTURE_ACCOUNTS;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return await run(); } finally { Module._load = originalLoad; }
}

// R84 moved the DEFAULT owner channel to Telegram. That channel was removed on
// 2026-08-23 and email is now the only one, so these two cases pin channel:'email'
// explicitly -- which is no longer a road-not-taken but the road -- and keep
// proving the Gmail wiring works. The channel-selection behaviour
// itself is covered in tests/owner-delivery.js.
check('the wired service sends through the injected sender and only then advances the delta baseline', async () => {
  const store = new MemorySettingsStore();
  const sent = [];
  const wiring = digestIndex.createAgentDigestService({
    config: { enabled: true, account: 'accta', tickMs: 30000, generationTimeoutMs: 5000, grid: { mon: { '10:00': 'pulse' }, tue: { '10:00': 'pulse' }, wed: { '10:00': 'pulse' }, thu: { '10:00': 'pulse' }, fri: { '10:00': 'pulse' }, sat: { '10:00': 'pulse' }, sun: { '10:00': 'pulse' } } },
    store,
    runControl: fakeRunControl,
    providerGateway: fakeProviderGateway,
    auditModule: audit,
    auditDependencies: isolatedAudit(),
    channelOptions: { channel: 'email' },
    deliveryDependencies: { recordFile: path.join(tempDir('agent-digest-delivery-'), 'owner-delivery.json') },
    gmail: { gmailSend: async input => { sent.push(input); return { id: 'fake-message-id' }; } }
  });
  wiring.service.now = () => NOW;
  const result = await withFixtureAccounts(() => wiring.service.tick());
  assert.equal(result.sent, true);
  assert.equal(result.mode, 'full');
  assert.equal(result.messageId, 'fake-message-id');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].account, 'accta');
  assert.match(sent[0].to, /@/, 'the recipient resolves from the existing account registry');
  assert.match(sent[0].subject, /^Agentic workflow pulse/);
  assert.ok(sent[0].text.length > 500);
  const fingerprint = digestIndex.readFingerprint(store);
  assert.equal(fingerprint.schemaVersion, 'agent-digest-fingerprint-v1');
});

check('a failed send does not advance the delta baseline', async () => {
  const store = new MemorySettingsStore();
  const wiring = digestIndex.createAgentDigestService({
    config: { enabled: true, account: 'accta', tickMs: 30000, generationTimeoutMs: 5000, grid: { mon: { '10:00': 'pulse' }, tue: { '10:00': 'pulse' }, wed: { '10:00': 'pulse' }, thu: { '10:00': 'pulse' }, fri: { '10:00': 'pulse' }, sat: { '10:00': 'pulse' }, sun: { '10:00': 'pulse' } } },
    store,
    runControl: fakeRunControl,
    providerGateway: fakeProviderGateway,
    auditModule: audit,
    auditDependencies: isolatedAudit(),
    channelOptions: { channel: 'email' },
    deliveryDependencies: { recordFile: path.join(tempDir('agent-digest-delivery-'), 'owner-delivery.json') },
    gmail: { gmailSend: async () => { throw Object.assign(new Error('offline'), { code: 'NETWORK_DOWN' }); } }
  });
  wiring.service.now = () => NOW;
  const result = await withFixtureAccounts(() => wiring.service.tick());
  assert.equal(result.sent, false);
  assert.equal(result.error, 'NETWORK_DOWN');
  assert.equal(digestIndex.readFingerprint(store), null,
    'the next digest must still compare against the last digest the owner actually received');
});

check('the recipient resolves from the existing account registry and is never a literal in this feature', async () => {
  // No accounts argument is passed here: resolveRecipient must reach for the
  // account registry module itself. Only the roster that module returns is a
  // fixture (see the ACCOUNT ROSTER SEAM above).
  await withFixtureAccounts(() => {
    const resolved = digestIndex.resolveRecipient({ account: 'accta' });
    assert.equal(resolved.alias, 'accta');
    assert.match(resolved.email, /@/);
    assert.throws(() => digestIndex.resolveRecipient({ account: 'nobody' }), /Unknown Google account/);
  });
  assert.throws(
    () => digestIndex.resolveRecipient({ account: 'ghost' }, { resolve: () => 'ghost', load: () => ({ accounts: {} }) }),
    error => error.code === 'AGENT_DIGEST_RECIPIENT_UNRESOLVED'
  );
  const sources = ['schedule.js', 'collect.js', 'render.js', 'render-image.js', 'service.js', 'index.js']
    .map(name => fs.readFileSync(path.join(ROOT, 'src', 'lib', 'agent-digest', name), 'utf8'))
    .concat(fs.readFileSync(path.join(ROOT, 'src', 'agent-digest.js'), 'utf8'))
    .concat(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'owner-delivery.js'), 'utf8'))
    .concat(fs.readFileSync(path.join(ROOT, 'src', 'lib', 'duo-owner-relay.js'), 'utf8'));
  for (const source of sources) {
    assert.ok(!/[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(source), 'no email address may be hard-coded in the digest');
  }
  const executablePreviewSources = [
    fs.readFileSync(path.join(ROOT, 'src', 'lib', 'agent-digest', 'index.js'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src', 'agent-digest.js'), 'utf8')
  ].join('\n');
  assert.doesNotMatch(executablePreviewSources, /message\.telegram(?:Caption)?/,
    'digest generation must not recreate removed provider-shaped preview aliases');
  assert.doesNotMatch(executablePreviewSources, /--- TELEGRAM/,
    'the manual preview must use provider-neutral headings');
});

check('config loading applies safe defaults and validates the grid', () => {
  const dir = tempDir('agent-digest-config-');
  const file = path.join(dir, 'agent-digest.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: false, account: 'x', tickSeconds: 15, generationTimeoutMs: 1000, grid: { mon: { '10:00': 'pulse' } } }));
  const config = digestIndex.loadConfig(file);
  assert.equal(config.enabled, false);
  assert.equal(config.tickMs, 15000);
  assert.equal(config.generationTimeoutMs, 1000);
  assert.deepEqual(config.grid, { mon: { '10:00': 'pulse' } });
  // THE ABSENCE CASE, ASSERTED BEFORE THE PRESENCE CASE.
  //
  // This assertion previously read `assert.equal(missing.enabled, true)` -- the
  // suite PINNED the defect: deleting the configuration for an emailing
  // subsystem switched it on. A test that pins absence-read-as-consent is worse
  // than no test, because it is quoted as proof the behaviour is intended.
  const missing = digestIndex.loadConfig(path.join(dir, 'absent.json'));
  assert.equal(missing.enabled, false,
    'a MISSING config/agent-digest.json enabled an emailing subsystem: absence was read as consent');
  assert.match(missing.enabledReason, /no configuration file/,
    'the reason must name the missing file, not claim the file disabled it');
  assert.equal(missing.tickMs, 30000);
  assert.equal(missing.grid, undefined);
  // A file that EXISTS but never says enabled:true is the same absence wearing
  // a different shape, and must resolve the same way.
  const silentFile = path.join(dir, 'silent.json');
  fs.writeFileSync(silentFile, JSON.stringify({ tickSeconds: 15 }));
  const silent = digestIndex.loadConfig(silentFile);
  assert.equal(silent.enabled, false, 'a config that omits `enabled` must not enable the digest');
  assert.match(silent.enabledReason, /not enabled by silence/);
  // And no near-miss value may stand in for the literal true.
  for (const value of ['true', 1, {}, [], 'yes']) {
    const nearMiss = path.join(dir, 'near-miss.json');
    fs.writeFileSync(nearMiss, JSON.stringify({ enabled: value }));
    assert.equal(digestIndex.loadConfig(nearMiss).enabled, false,
      `enabled: ${JSON.stringify(value)} must not switch on an outward-sending subsystem`);
  }
  fs.writeFileSync(file, JSON.stringify({ grid: { mon: { '10:15': 'pulse' } } }));
  assert.throws(() => digestIndex.loadConfig(file), /bad time/);
  // The shipped config must load.
  const shipped = digestIndex.loadConfig(path.join(ROOT, 'config', 'agent-digest.json'));
  assert.equal(shipped.enabled, true);
  assert.ok(shipped.generationTimeoutMs > 0);
});

check('scheduling status keeps Windows-task registration and scheduler ownership separate', () => {
  const status = digestSchedulingStatus({
    getProcess: id => ({ id, taskName: 'ToolsEnabled Agent Digest' }),
    collectScheduledTasks: () => new Map([['ToolsEnabled Agent Digest', { state: 'Running' }]]),
    listSchedulerJobs: () => []
  });
  assert.equal(status.declared, true);
  assert.deepEqual(status.task, {
    registration: 'registered', taskName: 'ToolsEnabled Agent Digest', state: 'Running'
  });
  assert.equal(status.scheduler.ownership, 'not-scheduler-owned');
  assert.match(status.scheduler.reason, /does not change the Windows-task observation/);
});

check('scheduling status never turns an unreadable scheduler inventory into an absent job', () => {
  const status = digestSchedulingStatus({
    getProcess: id => ({ id, taskName: 'ToolsEnabled Agent Digest' }),
    collectScheduledTasks: () => undefined,
    listSchedulerJobs: () => { throw Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }); }
  });
  assert.equal(status.task.registration, 'unknown');
  assert.equal(status.scheduler.ownership, 'unknown');
  assert.equal(status.scheduler.code, 'SQLITE_BUSY');
});

// ============================================================================
// 5. Architectural constraints
// ============================================================================
check('the digest calls the Gmail provider in-process and never through an MCP client session', () => {
  const files = ['src/agent-digest.js', 'src/lib/agent-digest/index.js', 'src/lib/agent-digest/service.js',
    'src/lib/agent-digest/collect.js', 'src/lib/agent-digest/render.js', 'src/lib/agent-digest/schedule.js'];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    for (const forbidden of ['modelcontextprotocol', 'StdioClientTransport', 'mcp-server', 'tools/call', 'mcp-call']) {
      assert.ok(!source.includes(forbidden), `${relative} must not reach for an MCP client session (${forbidden})`);
    }
  }
  const wiring = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'agent-digest', 'index.js'), 'utf8');
  assert.match(wiring, /require\('\.\.\/providers\/google'\)/, 'the Gmail provider must be required directly');
  assert.match(wiring, /gmail\.gmailSend\(/);
  // The provider itself keeps the kill switch and the signed audit record.
  const provider = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'providers', 'google.js'), 'utf8');
  assert.match(provider, /assertActive\('gmail\.send'\)/);
  assert.match(provider, /record\('gmail\.send'/);
});

check('nothing in the digest spawns a visible console window', () => {
  const files = ['src/agent-digest.js', 'src/lib/agent-digest/index.js', 'src/lib/agent-digest/service.js',
    'src/lib/agent-digest/collect.js', 'src/lib/agent-digest/render.js', 'src/lib/agent-digest/schedule.js'];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    for (const spawner of ['child_process', 'spawnSync(', 'execFile(', 'execSync(']) {
      assert.ok(!source.includes(spawner), `${relative} must not spawn a process (${spawner}); this machine flashes consoles`);
    }
  }
});

check('the CLI guards only the two ticking modes with the cross-process lock, never dry-run/status', () => {
  // Real production finding, 2026-07-28: a manually-started `--serve` was
  // still alive when this repo's registered Scheduled Task existed but had
  // never fired. Had the task's trigger fired at that moment, Windows would
  // not have recognised the manual process as a duplicate of ITS task, and
  // two ticking processes reading the same JsonSettingsStore could both have
  // seen an unfired slot and both sent -- a real double-send. This asserts
  // the CLI wires the lock (tests/agent-digest-lock.js proves the lock module
  // itself) around exactly the code paths that can mark a slot fired.
  const source = fs.readFileSync(path.join(ROOT, 'src', 'agent-digest.js'), 'utf8');
  assert.match(source, /require\('\.\/lib\/process-claim-lock'\)/);
  const lockCallIndex = source.indexOf('acquireLock(LOCK_FILE())');
  assert.ok(lockCallIndex > 0, 'the CLI must call acquireLock');
  const dryRunReturnIndex = source.indexOf("mode === '--dry-run'");
  const statusReturnIndex = source.indexOf("mode === '--status'");
  assert.ok(dryRunReturnIndex > 0 && dryRunReturnIndex < lockCallIndex,
    '--dry-run must return before the lock is ever acquired (it never touches the fired-slot marker)');
  assert.ok(statusReturnIndex > 0 && statusReturnIndex < lockCallIndex,
    '--status must return before the lock is ever acquired (it is read-only)');
  const onceTickIndex = source.indexOf("mode === '--once'", lockCallIndex);
  const serveStartIndex = source.indexOf('service.start()');
  assert.ok(onceTickIndex > lockCallIndex, '--once must tick only after the lock is held');
  assert.ok(serveStartIndex > lockCallIndex, '--serve must start ticking only after the lock is held');
  assert.match(source, /lock\.release\(\)/, 'the CLI must release the lock it acquires');
  assert.match(source, /AgentDigestLockError/, 'a lock conflict must be reported by name, not as a generic fatal error');
});

check('the Windows task registration is non-interactive (S4U) and hidden', () => {
  const script = fs.readFileSync(path.join(ROOT, 'tools', 'agent-digest-task.ps1'), 'utf8');
  assert.match(script, /-LogonType\s+S4U/, 'an Interactive logon type would flash a console window');
  assert.ok(!/-LogonType\s+Interactive/.test(script));
  assert.ok(!/InteractiveToken/.test(script));
  assert.match(script, /-Hidden/);
  assert.match(script, /AtStartup/, 'the digest must come back after a reboot');
  assert.match(script, /agent-digest\.js/);
  // PowerShell 5.1 on this machine mis-parses non-ASCII in .ps1 files.
  const nonAscii = script.split('').find(character => character.charCodeAt(0) > 127);
  assert.equal(nonAscii, undefined, `the task script must stay ASCII-only, found '${nonAscii}'`);
});

check('the Windows task starts itself immediately instead of waiting for a future reboot/logon', () => {
  // Real production finding, 2026-07-28: the task was registered but its
  // AtStartup/AtLogOn triggers only fire on a FUTURE startup or logon event.
  // Registered mid-session (the normal case), Get-ScheduledTaskInfo sat at
  // the "never run" sentinel (LastRunTime 11/30/1999, LastTaskResult 267011)
  // indefinitely -- every observed send only happened because someone started
  // a process by hand. -Register must kick the task once itself so delivery
  // does not depend on a reboot, a logon, or a human remembering to start it.
  const script = fs.readFileSync(path.join(ROOT, 'tools', 'agent-digest-task.ps1'), 'utf8');
  const registerCallIndex = script.indexOf('Register-ScheduledTask -TaskName $TaskName');
  assert.ok(registerCallIndex > 0, 'must call Register-ScheduledTask');
  const startCallIndex = script.indexOf('Start-ScheduledTask -TaskName $TaskName', registerCallIndex);
  assert.ok(startCallIndex > registerCallIndex,
    '-Register must call Start-ScheduledTask right after Register-ScheduledTask so the task runs now, ' +
    'not only after some future reboot/logon');
  // The immediate start must not be allowed to abort the whole -Register run:
  // a start failure (e.g. a manual process already holding the digest lock)
  // should degrade to "will run at the next trigger", not throw past
  // ErrorActionPreference = Stop and skip the final Show-Status.
  const tryIndex = script.indexOf('try {', startCallIndex - 40);
  assert.ok(tryIndex > 0 && tryIndex < startCallIndex, 'the immediate Start-ScheduledTask must be wrapped in try/catch');
  const catchIndex = script.indexOf('} catch {', startCallIndex);
  assert.ok(catchIndex > startCallIndex, 'a failed immediate start must be caught, not fatal');
});

// ============================================================================
(async () => {
  try {
    for (const { label, run } of pending) {
      await run();
      checks += 1;
      process.stdout.write(`  ok ${label}\n`);
    }
    process.stdout.write(`Agent digest tests passed (${checks} checks: tick invariants, honest meters, declared-vs-observed, in-process Gmail).\n`);
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  } finally {
    for (const dir of temporaries) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }); } catch { /* best effort */ }
    }
  }
})();
