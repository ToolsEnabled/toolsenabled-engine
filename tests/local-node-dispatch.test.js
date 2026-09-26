'use strict';

/* Default/strict coverage is offline: actual mission dispatch with an injected
 * resolver and terminal lane, plus fail-closed pre-launch controls. It does not
 * claim GPU/model/process proof. The separate real case retains that proof and
 * requires TOOLSENABLED_LOCAL_NODE_LIVE_TEST=1 outside strict mode. Merely having
 * a serving model, or inheriting that opt-in inside strict mode, grants no load.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const vm = require('node:vm');

const presence = require('../src/lib/agent-presence');
const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { createStateStore } = require('../src/lib/state-store');
const runtime = require('../src/lib/providers/local-node-runtime');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
const { INSTALL_TIER_SESSIONS } = require('../src/lib/permission-tier-policy');

const LIVE_TEST = 'explicit local model dispatch: real child, model reply, and terminal verdict';
const liveEnabled = process.env.TOOLSENABLED_LOCAL_NODE_LIVE_TEST === '1'
  && process.env.TOOLSENABLED_TEST_STRICT !== '1';

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }
function equal(actual, expected, message) { assert.equal(actual, expected, message); checks += 1; }

function auditFixture() {
  const events = [];
  const append = (action, target, details, extra = {}) => {
    const event = { sequence: events.length + 1, action, target, details, ...extra };
    event.eventHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
    events.push(event);
    return event;
  };
  return {
    events,
    requireRecord(action, target, details) {
      const event = append(action, target, details);
      return { durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash };
    },
    findEvents({ action, target, limit = 100 } = {}) {
      return events.filter(event => (!action || event.action === action) && (!target || event.target === target)).slice(-limit);
    },
    conditionalRecord({ action, target, eventId, decide }) {
      const outcome = decide({ findEvents: this.findEvents.bind(this), nowMs: Date.now() });
      if (outcome.kind === 'refused') return { recorded: false, refusal: outcome.refusal };
      const event = append(action, target, outcome.details, { eventId });
      return { recorded: true, durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash, value: outcome.value };
    }
  };
}

async function runLiveDispatch() {
  const live = await runtime.detect({ timeoutMs: 2500 });
  assert.equal(live.ready, true, `explicit local model trial needs a serving runtime: ${live.reason}; ${live.nextCommand}`);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-node-dispatch-'));
  const stateFile = path.join(root, 'isolated-state', 'agent-presence.json');
  const taskFile = path.join(root, 'isolated-state', 'tasks.sqlite3');
  const taskState = createStateStore({ file: taskFile, ownerId: 'local-node-dispatch-test' });
  const auditApi = auditFixture();
  const children = new Set();
  const spawnedChildren = [];
  const org = declaredOrg();

  const actions = createMissionActions({
    roots: { isolated: root },
    actor: enabledControllerId(org), agentOrg: org,
    permissionSession: INSTALL_TIER_SESSIONS.unrestricted,
    audit: auditApi,
    policy: { assertActive() {} },
    // A credential-shaped variable that must never reach a local child. A local
    // model needs no key, so anything key-shaped arriving there is a leak.
    env: { PATH: process.env.PATH, TEST_API_KEY: 'must-not-reach-child' },
    laneDependencies: {
      stateFile,
      mailboxDir: path.join(root, 'isolated-state', 'mailbox'),
      launchDir: path.join(root, 'isolated-state', 'launch'),
      taskDependencies: { state: taskState, auditRecord: () => {} },
      /* THE ONE STUB, AND WHY IT IS NOT CHEATING.
       *
       * The dynamic onboarding packet refuses to build for ANY mutation-capable
       * role unless this checkout can resolve a live owner directive, presence,
       * claims and BUILD-QUEUE (AGENT_ONBOARDING_LIVE_CONTEXT_REQUIRED).
       * Measured 2026-08-12 in this tree: it refuses identically for provider
       * codex, claude and local -- it is an environment precondition on every
       * real dispatch, not something the local path introduced, and it is the
       * same refusal this session's own SubagentStart hook reported.
       *
       * Stubbing it keeps this test measuring the thing it claims to measure:
       * whether a local model can be dispatched, spawned, run and terminalized.
       * Everything downstream -- argv, spawn, seat, child process, HTTP call to
       * the GPU, verdict extraction, terminal state -- is real. */
      buildOnboardingPacket: () => 'ONBOARDING PACKET STUB (test): the packet content is not what this test measures.\n'
    },
    spawn(command, args, options) {
      const child = spawn(command, args, options);
      children.add(child);
      spawnedChildren.push(child);
      child.once('close', () => children.delete(child));
      child.once('error', () => children.delete(child));
      child.__spawnOptions = options;
      return child;
    }
  });

  try {
    const dispatched = await actions.dispatch({
      rootId: 'isolated',
      tier: 'local',
      objectiveRef: 'local-node-end-to-end',
      brief: 'Answer with the single word ACK, then your verdict line. You have no tools.',
      cap: { kind: 'turns', value: 1, capMs: 300_000 }
    });

    equal(dispatched.receipt.action, 'dispatch', 'a local dispatch returns the same typed bridge receipt as a cloud one');
    equal(dispatched.receipt.kind, 'local', 'the receipt reports the local lane kind');
    equal(dispatched.receipt.tier, 'local', 'the receipt echoes the requested tier');
    check(/^local-node-[1-4]$/.test(dispatched.receipt.agentId),
      `the lane must occupy a declared local seat, got ${dispatched.receipt.agentId}`);
    check(dispatched.receipt.reportsTo, 'a local lane has a reporting line like any other');

    // THE LAUNCH RECORD NAMES THE MODEL THAT ACTUALLY RAN. `local/auto` in the
    // record would make it unable to answer the only question it exists for.
    const launchEvent = auditApi.events.find(event => event.action === 'controller.agent.launch');
    check(launchEvent, 'a local dispatch writes a durable launch record like any other');
    const recordedModel = JSON.stringify(launchEvent.details);
    check(/local\/[^"]+/.test(recordedModel) && !/local\/auto/.test(recordedModel),
      `the launch record must name the resolved model, not "auto": ${recordedModel.slice(0, 200)}`);

    const seat = presence.readRegistry(stateFile).agents[dispatched.receipt.agentId];
    check(seat, 'the local lane holds a real presence seat');
    check(['running', 'finished'].includes(seat.status), `the seat is live or already terminal, got ${seat.status}`);
    check(Number.isSafeInteger(seat.pid) && seat.pid > 0, 'a local lane is a real OS process with a real pid');

    // No credential reaches the child: a local model has none to use.
    const spawned = spawnedChildren[0];
    check(spawned, 'a local dispatch must have spawned an observable child');
    check(spawned.__spawnOptions, 'the observed local child must retain its exact spawn options');
    const childEnv = spawned.__spawnOptions.env || {};
    check(!Object.values(childEnv).includes('must-not-reach-child'),
      'a credential-shaped value must not be forwarded to a local lane child');

    // Let the lane finish and read its terminal state.
    const deadline = Date.now() + 240_000;
    let terminal = null;
    while (Date.now() < deadline) {
      const current = presence.readRegistry(stateFile).agents[dispatched.receipt.agentId];
      if (current && presence.TERMINAL.has(current.status)) { terminal = current; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    check(terminal !== null, 'the local lane must reach a terminal presence state within its cap');
    equal(terminal.status, 'finished', `a healthy local lane finishes, got ${terminal.status} / ${terminal.lastVerdict}`);
    equal(terminal.exitCode, 0, `a successful local lane exits 0, got ${terminal.exitCode}`);
    check(/VERDICT:/.test(String(terminal.lastVerdict || '')),
      `the lane runtime must extract a verdict from local output, got ${terminal.lastVerdict}`);

    process.stdout.write(`LIVE: dispatched ${live.selected.displayName} as ${dispatched.receipt.agentId}; terminal verdict = ${String(terminal.lastVerdict).slice(0, 80)}\n`);
    process.stdout.write(`local-node-dispatch: ${checks} checks passed.\n`);
  } finally {
    for (const child of children) { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
    try { taskState.close?.(); } catch { /* best effort */ }
  }
}

test('live dispatch registration never probes an ambient model without explicit non-strict admission', async () => {
  // Evaluate this actual module with a collecting node:test adapter. No fixture
  // body executes unless selected here; provider and spawn doors are tripwires.
  // This catches a detect() moved above the live test, not just a bad predicate.
  const source = fs.readFileSync(__filename, 'utf8');
  for (const scenario of [
    { env: {}, admitted: false },
    { env: { TOOLSENABLED_LOCAL_NODE_LIVE_TEST: 'true' }, admitted: false },
    { env: { TOOLSENABLED_LOCAL_NODE_LIVE_TEST: '1', TOOLSENABLED_TEST_STRICT: '1' }, admitted: false },
    { env: { TOOLSENABLED_LOCAL_NODE_LIVE_TEST: '1' }, admitted: true }
  ]) {
    const registered = [];
    const contacts = [];
    const tripwire = name => () => { contacts.push(name); throw new Error(`ambient ${name} contacted`); };
    const fakeRuntime = { ...runtime,
      detect: async () => { contacts.push('detect'); return { ready: false, reason: 'guard fixture', nextCommand: 'not executed' }; },
      resolveNode: tripwire('resolve'), complete: tripwire('complete'), boundedJsonRequest: tripwire('request')
    };
    const isolatedRequire = name => {
      if (name === 'node:test') return (title, options, body) => registered.push({ title,
        options: typeof options === 'function' ? {} : options, body: typeof options === 'function' ? options : body });
      if (name === '../src/lib/providers/local-node-runtime') return fakeRuntime;
      if (name === 'node:child_process') return { spawn: tripwire('spawn') };
      return require(name);
    };
    const context = { require: isolatedRequire, __filename, __dirname, Buffer, console,
      process: { env: scenario.env, argv: ['node', __filename], execPath: process.execPath } };
    vm.runInNewContext(source, context, { filename: __filename, timeout: 1000 });
    await Promise.resolve();
    assert.deepEqual(contacts, [], 'registering the suite must not discover or call a model');
    const live = registered.find(entry => entry.title === LIVE_TEST);
    assert.ok(live, 'the real case remains a named TAP test, not a whole-file skip');
    assert.equal(!live.options.skip, scenario.admitted);
    if (scenario.admitted) {
      await assert.rejects(() => live.body(), /explicit local model trial needs a serving runtime/);
      assert.deepEqual(contacts, ['detect'], 'positive opt-in control reaches only the fake runtime precondition');
    } else {
      assert.deepEqual(contacts, [], 'strict mode overrules even an inherited real-model opt-in');
    }
  }
});

function offlineFixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-node-dispatch-offline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ambientCalls = [];
  for (const name of ['detect', 'resolveNode', 'complete', 'boundedJsonRequest']) {
    t.mock.method(runtime, name, () => { ambientCalls.push(name); throw new Error(`offline fixture contacted ${name}`); });
  }
  t.after(() => assert.deepEqual(ambientCalls, [], 'offline dispatch never enters the ambient runtime/provider'));
  const org = declaredOrg();
  const audit = auditFixture();
  const lanes = [];
  const resolverCalls = [];
  const spawnCalls = [];
  const resolved = { runtime: 'ollama', model: 'qwen2.5:7b-instruct', host: '127.0.0.1', port: 11434 };
  const actions = createMissionActions({
    roots: { isolated: root }, actor: enabledControllerId(org), agentOrg: org, audit,
    loadSettings: () => ({ values: { 'audit.enabled': true }, provenance: { 'audit.enabled': { source: 'user' } }, rejected: [] }),
    policy: { assertActive() {} }, permissionSession: INSTALL_TIER_SESSIONS.unrestricted,
    env: { PATH: process.env.PATH },
    resolveLocalNode: async input => { resolverCalls.push(input); return resolved; },
    spawn(...args) { spawnCalls.push(args); throw new Error('offline dispatch must not spawn'); },
    async runLane(options) {
      lanes.push(options);
      const runId = crypto.randomUUID();
      return { runId, taskId: 'offline-local-task', terminal: { agentId: options.agentId,
        runId, currentTask: 'offline-local-task', status: 'finished', exitCode: 0,
        lastVerdict: 'VERDICT: injected offline terminal; no model was contacted' } };
    },
    ...overrides
  });
  return { root, actions, audit, lanes, resolverCalls, spawnCalls, resolved };
}

const offlineInput = { rootId: 'isolated', tier: 'local', objectiveRef: 'offline-local-dispatch',
  brief: 'Bounded offline dispatch fixture.', cap: { kind: 'turns', value: 1, capMs: 60_000 } };

test('offline dispatch preserves the local seat, concrete model, durable brief, and terminal receipt', async t => {
  const f = offlineFixture(t);
  const result = await f.actions.dispatch(offlineInput);
  assert.equal(result.ok, true);
  assert.equal(result.receipt.kind, 'local');
  assert.equal(result.receipt.tier, 'local');
  assert.match(result.receipt.agentId, /^local-node-[1-4]$/);
  assert.ok(result.receipt.reportsTo);
  assert.equal(f.resolverCalls.length, 1);
  assert.equal(f.lanes.length, 1);
  assert.deepEqual(f.spawnCalls, []);
  assert.equal(f.lanes[0].agentId, result.receipt.agentId);
  assert.equal(f.lanes[0].command, process.execPath);
  assert.ok(f.lanes[0].childArgs.includes(f.resolved.model), 'the canonical argv carries the resolved model');
  assert.ok(fs.readFileSync(f.lanes[0].brief, 'utf8').includes(offlineInput.brief));
  const launch = f.audit.events.find(event => event.action === 'controller.agent.launch');
  assert.ok(launch, 'actual dispatch writes the canonical launch record into the audit fixture');
  assert.equal(launch.details.record.model, 'local/qwen2.5:7b-instruct');
  const terminal = f.audit.events.filter(event => event.action === 'controller.agent.launch.terminal');
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].details.receipt.terminalState, 'completed');
});

test('offline unavailable runtime refuses before launch, artifacts, or lane execution', async t => {
  const f = offlineFixture(t, { resolveLocalNode: async () => { throw new Error('no model in this offline fixture'); } });
  await assert.rejects(() => f.actions.dispatch(offlineInput), error => error?.code === 'BRIDGE_LOCAL_RUNTIME_UNAVAILABLE');
  assert.deepEqual(f.audit.events, []);
  assert.deepEqual(f.lanes, []);
  assert.deepEqual(f.spawnCalls, []);
  assert.deepEqual(fs.readdirSync(f.root), [], 'runtime refusal occurs before durable lane artifacts');
});

test(LIVE_TEST, { skip: !liveEnabled && 'requires TOOLSENABLED_LOCAL_NODE_LIVE_TEST=1 outside strict mode; real model/process proof is UNEXECUTED' }, runLiveDispatch);
