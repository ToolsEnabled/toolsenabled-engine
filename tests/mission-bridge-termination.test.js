// EXECUTABLE CHANGE
//
// Assertion audit (testcanfail-tests-mission-bridge-termination-test-js):
// - STRENGTHENED: rejects() formerly accepted any thrown value whose own `code`
//   matched. Mutation: errors.refuse() threw a plain Error carrying the requested
//   code/status instead of MissionBridgeError. Before this change the mutation
//   stayed green: "mission-bridge-termination: 44 assertions passed". With the
//   strengthened type-and-code predicate it went red:
//   "AssertionError [ERR_ASSERTION]: expected BRIDGE_TERMINATE_IDEMPOTENCY_COLLISION".
// - NOT-FOUND (1): no assertion is inside a loop/forEach over a possibly empty
//   collection; filtered collections are instead checked with exact counts.
// - NOT-FOUND (2): no exit-status or truthy-return assertion is used as evidence
//   about a separately spawned subject. The retained Job Object zero-process
//   receipt and creation-identity refusal are independently asserted.
// - NOT-FOUND (3): no optional chain or catch swallows a subject failure. The
//   cleanup finally blocks do not catch failures; rejects() awaits assert.rejects.
// - NOT-FOUND (4): injected process/action doubles are boundary collaborators;
//   assertions inspect the production termination/server code around them, not
//   behavior implemented by the doubles themselves.
// - NOT-FOUND (5): there are no skips or platform/precondition guards.
// - NOT-FOUND (6): expected values are literals or independently derived fixture
//   facts; none is computed by the production function being checked.
// - RESTORE: src/lib/mission-bridge/errors.js was restored byte-for-byte (SHA-256
//   c49f13c59fbf1aca18d6c160f85abb00fff74e264f494de828396d6d81612b64).
//   Restored run: "mission-bridge-termination: 44 assertions passed".
// - PRECONDITION: the default Node 20 lacks node:sqlite; all executable runs used
//   the installed /root/.nvm/versions/node/v22.22.2/bin/node runtime.

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const agentOrg = require('../src/lib/agent-org');

const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const { MissionBridgeError } = require('../src/lib/mission-bridge/errors');
const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { createMissionBridgeServer } = require('../src/lib/mission-bridge/server');
const {
  COMPLETED_ACTION,
  FAILED_ACTION,
  INTENT_ACTION,
  REQUEST_BODY_SHA256,
  createTerminateAction,
  effectiveRequestSha256,
  terminateWindowsTree
} = require('../src/lib/mission-bridge/termination');

const CONTROLLER = 'controller';
const WORKER = 'worker';
const OUTSIDER = 'outsider';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';
const PID = 42420;
const PROCESS_START_TICKS = '639265824000000000';
const CLOCK_MS = 1_776_000_000_000;

let assertions = 0;
function ok(value, message) { assertions += 1; assert.ok(value, message); }
function equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message); }
function deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message); }
async function rejects(fn, code) {
  assertions += 1;
  await assert.rejects(
    fn,
    error => error instanceof MissionBridgeError && error.code === code,
    `expected ${code}`
  );
}

function org() {
  return agentOrg.normalizeOrg({
    schemaVersion: 1,
    revision: 1,
    agents: [
      { id: CONTROLLER, displayName: 'Controller', role: 'controller', enabled: true, provider: 'codex' },
      { id: WORKER, displayName: 'Worker', role: 'worker', enabled: true, provider: 'codex' },
      { id: OUTSIDER, displayName: 'Outsider', role: 'worker', enabled: true, provider: 'codex' }
    ],
    relationships: [{ from: CONTROLLER, to: WORKER, type: 'manages' }]
  });
}

function record(overrides = {}) {
  return {
    agentId: WORKER,
    runId: RUN_ID,
    role: 'worker',
    reportsTo: CONTROLLER,
    pid: PID,
    processStartTicks: PROCESS_START_TICKS,
    status: 'running',
    exitCode: null,
    terminalAt: null,
    ...overrides
  };
}

function registry(worker = record()) {
  return { schemaVersion: 1, revision: 1, agents: worker ? { [WORKER]: worker } : {} };
}

function presenceSequence(...registries) {
  let index = 0;
  return {
    DEFAULT_STATE_FILE: 'fixture-presence.json',
    readRegistry() {
      const selected = registries[Math.min(index, registries.length - 1)];
      index += 1;
      return selected;
    }
  };
}

function auditFixture() {
  const rows = [];
  const append = (action, target, details, eventId = `audit-${crypto.randomUUID()}`) => {
    const sequence = rows.length + 1;
    const eventHash = crypto.createHash('sha256').update(JSON.stringify({ action, target, details, sequence, eventId })).digest('hex');
    const row = { sequence, eventId, eventHash, event: { action, target, details } };
    rows.push(row);
    return row;
  };
  const findEvents = ({ action, target, limit = 100 }) => rows
    .filter(row => row.event.action === action && row.event.target === target)
    .slice(-limit);
  return {
    rows,
    findEvents,
    conditionalRecord({ action, target, eventId, decide }) {
      const decision = decide({ findEvents, nowMs: CLOCK_MS });
      if (decision.kind === 'refused') return { recorded: false, refusal: decision.refusal };
      const row = append(action, target, decision.details, eventId);
      return { recorded: true, durable: true, anchored: true, sequence: row.sequence, eventHash: row.eventHash, value: decision.value };
    },
    requireRecord(action, target, details) {
      const row = append(action, target, details);
      return { durable: true, anchored: true, sequence: row.sequence, eventHash: row.eventHash };
    }
  };
}

function input({ key = 'terminate-1', digest = 'a'.repeat(64), runId = RUN_ID, pid = PID } = {}) {
  const value = { idempotencyKey: key, agentId: WORKER, expectedRunId: runId, expectedPid: pid };
  Object.defineProperty(value, REQUEST_BODY_SHA256, { value: digest });
  return value;
}

function actionFixture({
  actor = CONTROLLER,
  audit = auditFixture(),
  presence = presenceSequence(registry(), registry(), registry(record({ status: 'failed', exitCode: 1, terminalAt: CLOCK_MS }))),
  isAlive = (() => {
    const values = [true, false];
    return () => values.length ? values.shift() : false;
  })(),
  terminateProcess = async () => ({ exitCode: 0 }),
  overrides = {}
} = {}) {
  return {
    audit,
    terminate: createTerminateAction({
      actor,
      org: org(),
      audit,
      presence,
      isAlive,
      terminateProcess,
      clock: () => CLOCK_MS,
      pollMs: 1,
      processGoneTimeoutMs: 2,
      terminalTimeoutMs: 2,
      delay: async () => {},
      ...overrides
    })
  };
}

async function successAndIdempotency() {
  let kills = 0;
  const fixture = actionFixture({ terminateProcess: async (pid, identity) => {
    equal(pid, PID, 'terminate uses the fenced PID');
    equal(identity.processStartTicks, PROCESS_START_TICKS, 'terminate uses the presence-bound creation identity');
    kills += 1;
    return { exitCode: 0 };
  } });
  const request = input();
  const first = await fixture.terminate(request);
  equal(first.receipt.action, 'terminate', 'success receipt is typed');
  equal(first.receipt.idempotencyKey, 'terminate-1', 'receipt proves the idempotency key');
  equal(first.receipt.actor, CONTROLLER, 'receipt proves the actor');
  equal(first.receipt.agentId, WORKER, 'receipt proves the agent');
  equal(first.receipt.runId, RUN_ID, 'receipt proves the run fence');
  equal(first.receipt.pid, PID, 'receipt proves the PID fence');
  equal(first.receipt.terminalStatus, 'failed', 'receipt carries canonical terminal status');
  equal(first.receipt.exitCode, 1, 'receipt carries canonical terminal exit');
  equal(first.receipt.verifiedGone, true, 'receipt proves the PID was observed gone');
  equal(kills, 1, 'first request invokes exactly one kill');
  equal(fixture.audit.rows.filter(row => row.event.action === INTENT_ACTION).length, 1, 'intent is durably recorded once');
  equal(fixture.audit.rows.filter(row => row.event.action === COMPLETED_ACTION).length, 1, 'outcome is durably recorded once');

  const replay = await fixture.terminate(request);
  deepEqual(replay.receipt, first.receipt, 'byte-identical replay returns the same durable receipt');
  equal(kills, 1, 'replay never kills a second time');
  await rejects(() => fixture.terminate(input({ digest: 'b'.repeat(64) })), 'BRIDGE_TERMINATE_IDEMPOTENCY_COLLISION');

  const racingAudit = auditFixture();
  const racingRequestSha256 = effectiveRequestSha256('c'.repeat(64), CONTROLLER);
  racingAudit.requireRecord(INTENT_ACTION, 'terminate-race', {
    schemaVersion: 1,
    idempotencyKey: 'terminate-race',
    requestSha256: racingRequestSha256,
    actor: CONTROLLER,
    agentId: WORKER,
    runId: RUN_ID,
    pid: PID
  });
  let published = false;
  const racing = actionFixture({
    audit: racingAudit,
    overrides: {
      idempotencyWaitTimeoutMs: 2,
      async delay() {
        if (published) return;
        published = true;
        racingAudit.requireRecord(COMPLETED_ACTION, 'terminate-race', {
          schemaVersion: 1,
          idempotencyKey: 'terminate-race',
          requestSha256: racingRequestSha256,
          actor: CONTROLLER,
          agentId: WORKER,
          runId: RUN_ID,
          pid: PID,
          terminalStatus: 'failed',
          exitCode: 1,
          verifiedGone: true,
          verifiedGoneAt: new Date(CLOCK_MS).toISOString(),
          terminalAt: CLOCK_MS
        });
      }
    }
  });
  const racedReplay = await racing.terminate(input({ key: 'terminate-race', digest: 'c'.repeat(64) }));
  equal(racedReplay.receipt.idempotencyKey, 'terminate-race', 'concurrent identical replay waits for and returns the first durable receipt');
}

async function refusalMatrix() {
  const valid = input();
  const malformed = actionFixture();
  await rejects(() => malformed.terminate({ idempotencyKey: 'bad', agentId: WORKER, expectedRunId: RUN_ID }), 'BRIDGE_TERMINATE_INPUT_INVALID');

  const unknown = actionFixture({ presence: presenceSequence(registry(null)) });
  await rejects(() => unknown.terminate(valid), 'BRIDGE_TERMINATE_AGENT_UNKNOWN');

  const staleRun = actionFixture({ presence: presenceSequence(registry(record({ runId: OTHER_RUN_ID }))) });
  await rejects(() => staleRun.terminate(valid), 'BRIDGE_TERMINATE_STALE_RUN');

  const stalePid = actionFixture({ presence: presenceSequence(registry(record({ pid: PID + 1 }))) });
  await rejects(() => stalePid.terminate(valid), 'BRIDGE_TERMINATE_STALE_PID');

  const terminal = actionFixture({ presence: presenceSequence(registry(record({ status: 'finished', exitCode: 0, terminalAt: CLOCK_MS }))) });
  await rejects(() => terminal.terminate(valid), 'BRIDGE_TERMINATE_ALREADY_TERMINAL');

  const starting = actionFixture({ presence: presenceSequence(registry(record({ status: 'starting' }))) });
  await rejects(() => starting.terminate(valid), 'BRIDGE_TERMINATE_NOT_ACTIVE');

  const unauthorized = actionFixture({ actor: OUTSIDER });
  await rejects(() => unauthorized.terminate(valid), 'BRIDGE_TERMINATE_ACTOR_REFUSED');

  // A real declared supervisor can have its role's wake capability disabled.
  // This is a definite denial, not an unavailable authorization measurement.
  const declared = org();
  const readOnlyOrg = agentOrg.normalizeOrg(declared, { knownRoles: [{
    id: 'controller',
    capabilities: { ...declared.roleCapabilitiesByRole.controller, mayWakeReports: false }
  }] });
  let forbiddenKills = 0;
  const readOnly = actionFixture({
    overrides: { org: readOnlyOrg },
    terminateProcess: async () => { forbiddenKills += 1; }
  });
  await rejects(() => readOnly.terminate(valid), 'BRIDGE_TERMINATE_ACTOR_REFUSED');
  equal(forbiddenKills, 0, 'read-only role denial happens before process termination');
  equal(readOnly.audit.rows.length, 0, 'read-only role denial cannot create a termination intent');

  let authorizationChecks = 0;
  const busyAudit = auditFixture();
  const busyAuthorization = createTerminateAction({
    actor: CONTROLLER,
    org: org(),
    audit: busyAudit,
    presence: presenceSequence(registry(), registry(), registry(), registry(record({ status: 'failed', exitCode: 1, terminalAt: CLOCK_MS }))),
    assertAuthorized() {
      authorizationChecks += 1;
      if (authorizationChecks === 1) throw Object.assign(new Error('machine busy'), { code: 'EBUSY' });
    },
    isAlive: (() => { const values = [true, false]; return () => values.shift() ?? false; })(),
    terminateProcess: async () => ({ exitCode: 0 }),
    clock: () => CLOCK_MS,
    pollMs: 1,
    processGoneTimeoutMs: 2,
    terminalTimeoutMs: 2,
    delay: async () => {}
  });
  await rejects(() => busyAuthorization(valid), 'BRIDGE_TERMINATE_AUTHORIZATION_UNAVAILABLE');
  equal(busyAudit.rows.length, 0, 'an indeterminate authorization check is not durably latched');
  const retriedAuthorization = await busyAuthorization(valid);
  equal(retriedAuthorization.ok, true, 'a busy authorization check can be retried successfully');

  const managerTarget = {
    idempotencyKey: 'terminate-manager',
    agentId: CONTROLLER,
    expectedRunId: RUN_ID,
    expectedPid: PID
  };
  Object.defineProperty(managerTarget, REQUEST_BODY_SHA256, { value: 'd'.repeat(64) });
  const managerRegistry = {
    schemaVersion: 1,
    revision: 1,
    agents: {
      [CONTROLLER]: record({ agentId: CONTROLLER, role: 'controller', reportsTo: null })
    }
  };
  const workerToManager = actionFixture({ actor: OUTSIDER, presence: presenceSequence(managerRegistry) });
  await rejects(() => workerToManager.terminate(managerTarget), 'BRIDGE_TERMINATE_ACTOR_REFUSED');

  const changed = actionFixture({
    presence: presenceSequence(registry(), registry(record({ runId: OTHER_RUN_ID })))
  });
  await rejects(() => changed.terminate(valid), 'BRIDGE_TERMINATE_STALE_RUN');
  equal(changed.audit.rows.some(row => row.event.action === FAILED_ACTION && row.event.details.code === 'BRIDGE_TERMINATE_STALE_RUN'), true, 'post-intent stale run is durably recorded');

  let killAttempts = 0;
  const killFailure = actionFixture({
    presence: presenceSequence(registry(), registry()),
    terminateProcess: async () => {
      killAttempts += 1;
      throw new MissionBridgeError('BRIDGE_TERMINATE_KILL_FAILURE', 'fixture kill failed', { status: 503 });
    },
    isAlive: () => true
  });
  await rejects(() => killFailure.terminate(valid), 'BRIDGE_TERMINATE_KILL_FAILURE');
  await rejects(() => killFailure.terminate(valid), 'BRIDGE_TERMINATE_KILL_FAILURE');
  equal(killAttempts, 1, 'durable failure replay does not retry the kill');

  const unknownLiveness = actionFixture({
    presence: presenceSequence(registry(), registry()),
    isAlive: () => null
  });
  await rejects(() => unknownLiveness.terminate(valid), 'BRIDGE_TERMINATE_LIVENESS_UNCERTAIN');

  const goneTimeout = actionFixture({
    presence: presenceSequence(registry(), registry()),
    isAlive: () => true
  });
  await rejects(() => goneTimeout.terminate(valid), 'BRIDGE_TERMINATE_LIVENESS_UNCERTAIN');

  const aliveValues = [true, false];
  const terminalTimeout = actionFixture({
    presence: presenceSequence(registry(), registry(), registry(), registry()),
    isAlive: () => aliveValues.length ? aliveValues.shift() : false
  });
  await rejects(() => terminalTimeout.terminate(valid), 'BRIDGE_TERMINATE_TERMINAL_TIMEOUT');
}

async function jobObjectContract() {
  let invocation = null;
  const result = await terminateWindowsTree(PID, {
    platform: 'win32',
    expectedStartTicks: PROCESS_START_TICKS,
    killTimeoutMs: 1000,
    async terminateRegisteredJobImpl(pid, options) {
      invocation = { pid, options };
      return Object.freeze({
        type: 'terminated', exitCode: 124, activeProcesses: 0,
        identity: { wrapperPid: pid, wrapperStartTicks: options.expectedStartTicks }
      });
    }
  });
  equal(result.activeProcesses, 0, 'termination accepts only the Job Object zero-process receipt');
  equal(invocation.pid, PID, 'the registered job lookup uses the fenced presence PID');
  equal(invocation.options.expectedStartTicks, PROCESS_START_TICKS,
    'the terminate control request is bound to the stored kernel creation identity');
  equal(invocation.options.cleanupTimeoutMs, 1000, 'the action keeps its bounded cleanup deadline');

  await rejects(() => terminateWindowsTree(PID, {
    platform: 'win32',
    expectedStartTicks: PROCESS_START_TICKS,
    killTimeoutMs: 1000,
    terminateRegisteredJobImpl() {
      throw Object.assign(new Error('creation identity changed'), { code: 'WINDOWS_JOB_IDENTITY_MISMATCH' });
    }
  }), 'BRIDGE_TERMINATE_STALE_PID');
  await rejects(() => terminateWindowsTree(PID, { platform: 'win32' }), 'BRIDGE_TERMINATE_KILL_FAILURE');
}

async function rawBodyBinding() {
  const directory = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'mission-terminate-http-'));
  const runtimeFile = path.join(directory, 'runtime.json');
  const token = crypto.randomBytes(32);
  let observedDigest = null;
  const actions = {
    async status() { return { ok: true, actions: ['terminate'] }; },
    async terminate(value) {
      observedDigest = value[REQUEST_BODY_SHA256];
      return { ok: true, receipt: { action: 'terminate' } };
    }
  };
  const bridge = createMissionBridgeServer({
    token,
    // Injected, not minted: minting would unlink the live bridge's production
    // bootstrap proof in state/ and lock Mission Control's owner popup out.
    bootstrapProof: crypto.randomBytes(32),
    allowedOrigins: ['http://127.0.0.2:4600'],
    actions,
    runtimeFile,
    allowTestRuntimeFile: true,
    allowTestPortZero: true,
    runtimeDependencies: { platform: 'test', clock: () => CLOCK_MS, pid: 54321 }
  });
  try {
    const address = await bridge.listen(0);
    const raw = `{ "idempotencyKey": "http-1", "agentId": "${WORKER}", "expectedRunId": "${RUN_ID}", "expectedPid": ${PID} }`;
    const response = await fetch(`${address.baseUrl}/v1/actions/terminate`, {
      method: 'POST',
      headers: {
        origin: 'http://127.0.0.2:4600',
        authorization: `Bearer ${token.toString('base64url')}`,
        'content-type': 'application/json'
      },
      body: raw
    });
    equal(response.status, 200, 'terminate HTTP route is reachable');
    equal(observedDigest, crypto.createHash('sha256').update(raw).digest('hex'), 'route binds idempotency to byte-identical raw request bodies');
  } finally {
    if (bridge.server.listening) await bridge.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function actionIntegration() {
  const directory = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'mission-terminate-action-'));
  const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
  const configuredOrg = declaredOrg();
  const actor = enabledControllerId(configuredOrg);
  const target = configuredOrg.agents.find(agent => agent.id === 'luna');
  const running = registry(record({ agentId: target.id, role: target.role, reportsTo: actor }));
  running.agents[target.id] = running.agents[WORKER];
  delete running.agents[WORKER];
  const terminal = registry(record({
    agentId: target.id,
    role: target.role,
    reportsTo: actor,
    status: 'failed',
    exitCode: 1,
    terminalAt: CLOCK_MS
  }));
  terminal.agents[target.id] = terminal.agents[WORKER];
  delete terminal.agents[WORKER];
  const alive = [true, false];
  const policyCalls = [];
  const actions = createMissionActions({
    roots: { primary: directory },
    actor,
    agentOrg: configuredOrg,
    audit: auditFixture(),
    policy: { assertActive(action, options) { policyCalls.push({ action, options }); } },
    terminateDependencies: {
      presence: presenceSequence(running, running, terminal),
      isAlive: () => alive.length ? alive.shift() : false,
      terminateProcess: async () => ({ exitCode: 0 }),
      clock: () => CLOCK_MS,
      pollMs: 1,
      processGoneTimeoutMs: 2,
      terminalTimeoutMs: 2,
      delay: async () => {}
    }
  });
  try {
    const request = {
      idempotencyKey: 'integrated-terminate',
      agentId: target.id,
      expectedRunId: RUN_ID,
      expectedPid: PID
    };
    Object.defineProperty(request, REQUEST_BODY_SHA256, { value: 'e'.repeat(64) });
    const result = await actions.terminate(request);
    equal(result.receipt.agentId, target.id, 'createMissionActions wires terminate to the declared lane');
    deepEqual(policyCalls.at(-1), {
      action: 'mission.bridge.terminate',
      options: { outward: false }
    }, 'terminate passes the canonical local-policy guard without widening dispatch');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  await successAndIdempotency();
  await refusalMatrix();
  await jobObjectContract();
  await rawBodyBinding();
  await actionIntegration();
  console.log(`mission-bridge-termination: ${assertions} assertions passed`);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
