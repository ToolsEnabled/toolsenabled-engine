'use strict';
require('./helpers/isolated-state-root');
const test = require('node:test');
const assert = require('node:assert/strict');
const settings = values => ({ values, provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user' }])), rejected: [] });
const { readWork } = require('../src/lib/agent-ledger-continuation');
const { createLedgerContinuation } = require('../src/lib/ledger-continuation-controller');
const { MinorLedgerAgentControl } = require('../src/lib/minor-ledger-agent-gate');
const { StateStore } = require('../src/lib/state-store');
const launch = require('../src/lib/controller-launch-record');
const outcome = require('../src/lib/launch-outcome');

test('Basic task reads do not open history; explicit verification exposes missing history', () => {
  let verify = false, reads = 0, checks = 0;
  const records = [{ id: 'T1', kind: 'T', status: 'open', history: [], gates: [] }];
  const store = { readAll() { reads++; return { records, revision: 1 }; }, verifyHistory() { checks++; return { ok: false, code: 'R_LEDGER_CHAIN_MISSING' }; } };
  const loadSettings = () => settings({ 'ledger.verify_history': verify });
  const control = new MinorLedgerAgentControl({ store, loadSettings });
  assert.equal(readWork({ store, readSettings: loadSettings }), records);
  assert.equal(control.read().chain.checked, false);
  assert.equal(checks, 0);
  verify = true;
  assert.throws(() => readWork({ store, readSettings: loadSettings }), { code: 'R_LEDGER_CHAIN_MISSING' });
  assert.equal(control.read().chain.code, 'R_LEDGER_CHAIN_MISSING');
  assert.equal(checks, 2);
  verify = false;
  assert.equal(readWork({ store, readSettings: loadSettings }), records);
  assert.equal(checks, 2);
  assert.equal(reads, 5);
});

test('Basic progress bypasses optional signer, while an enabled in-flight write waits for audit', async () => {
  let enabled = false, writes = 0, audits = 0, release;
  const store = { progressTask(args) { writes++; return args; } };
  const control = new MinorLedgerAgentControl({ store, scrub: text => text,
    loadSettings: () => settings({ 'audit.enabled': enabled }),
    auditRequireAsync: () => { audits++; return new Promise(resolve => { release = resolve; }); } });
  const input = { actor: 'codex', id: 'T1', status: 'in-progress', reason: 'Work continues.' };
  await control.progress(input);
  assert.deepEqual([writes, audits], [1, 0]);
  enabled = true;
  const pending = control.progress(input);
  assert.deepEqual([writes, audits], [1, 1]);
  enabled = false;
  await Promise.resolve();
  assert.equal(writes, 1, 'disabling during required admission cannot bypass its pending result');
  release({ durable: true }); await pending;
  assert.equal(writes, 2);
  await control.progress(input);
  assert.deepEqual([writes, audits], [3, 1]);
});

test('host continuation catalogue retries share bounded failure backoff and reconfiguration clears it', () => {
  let now = 0, reads = 0, unavailable = true, disabled = false, revision = 1;
  const controller = createLedgerContinuation({ now: () => now,
    readSettings: () => ({ ...settings({ 'agent.persistent_continuation': !disabled }), revision }),
    readTasks() { reads++; if (unavailable) throw Object.assign(Error('missing history'), { code: 'R_LEDGER_CHAIN_MISSING' }); return []; },
    stateFactory: () => ({ dueRecoveries: () => [], close() {} }), selectTasks: () => [], canSend: () => false, send() { throw Error('not eligible'); } });
  try {
    assert.throws(() => controller.pendingRecoveries(), { code: 'R_LEDGER_CHAIN_MISSING' });
    for (now = 5000; now < 30000; now += 5000) assert.throws(() => controller.pendingRecoveries(), { code: 'R_LEDGER_CHAIN_MISSING' });
    assert.equal(reads, 1);
    assert.throws(() => controller.pendingRecoveries(), { code: 'R_LEDGER_CHAIN_MISSING' });
    assert.equal(reads, 2);
    disabled = true;
    assert.deepEqual(controller.pendingRecoveries(), []);
    controller.tick(); assert.equal(reads, 2);
    disabled = false; unavailable = false; revision++;
    assert.deepEqual(controller.pendingRecoveries(), []);
    assert.equal(reads, 3);
  } finally { controller.close(); }
});

const org = require('../src/lib/agent-org').normalizeOrg({ revision: 1, agents: [
  { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'claude', enabled: true },
  { id: 'worker', displayName: 'Worker', role: 'worker', provider: 'codex', enabled: true }
], relationships: [{ from: 'controller', to: 'worker', type: 'manages' }] });
const request = parentLaunchId => ({ requestingActor: 'controller', targetAgentId: 'worker', tier: 'cheap', model: 'luna-cheap-tier', objectiveRef: 'Q27', cap: { kind: 'turns', value: 20, capMs: 7200000 }, parentLaunchId: parentLaunchId || null });

test('Basic launch custody retains parent limits and terminal binding without audit access', () => {
  const stateStore = new StateStore({ file: ':memory:' });
  const deps = { stateStore, org, loadSettings: () => settings({}), audit: new Proxy({}, { get() { throw Error('Basic must not open audit'); } }) };
  try {
    const parent = launch.createLaunch(request(), deps);
    assert.equal(parent.audit.disposition, 'not-required');
    assert.equal(Object.hasOwn(parent, 'auditSequence'), false);
    assert.deepEqual(launch.getOperationalLaunch(parent.launchId, deps), parent.record);
    for (let index = 0; index < launch.MAX_FAN_OUT; index++) assert.equal(launch.createLaunch(request(parent.launchId), deps).record.depth, 1);
    assert.throws(() => launch.createLaunch(request(parent.launchId), deps), { code: 'LAUNCH_FANOUT_EXCEEDED' });
    const result = outcome.recordTerminal({ launchId: parent.launchId, terminalState: 'completed' }, deps);
    assert.equal(result.audit.disposition, 'not-required');
    assert.equal(result.receipt.launchRecordHash, parent.recordHash);
    assert.deepEqual(outcome.getOperationalTerminal(parent.record, deps), result.receipt);
    assert.throws(() => outcome.recordTerminal({ launchId: parent.launchId, terminalState: 'completed' }, deps), { code: 'LAUNCH_TERMINAL_REPLAY' });
    assert.throws(() => outcome.recordTerminal({ launchId: parent.launchId, terminalState: 'failed' }, deps), { code: 'LAUNCH_TERMINAL_CONFLICT' });
  } finally { stateStore.close(); }
});

const { createTerminateAction, COMPLETED_ACTION, INTENT_ACTION } = require('../src/lib/mission-bridge/termination');
function terminateFixture(overrides = {}) {
  const stateStore = new StateStore({ file: ':memory:' });
  let enabled = false, calls = 0, ended = false, release;
  const input = { idempotencyKey: 'basic-stop-1', agentId: 'worker', expectedRunId: '11111111-1111-4111-8111-111111111111', expectedPid: 4242 };
  const audit = { findEvents: () => [], conditionalRecord: () => ({ recorded: true, durable: true, anchored: true }),
    requireRecord: () => ({ durable: true, anchored: true, sequence: 2, eventHash: 'a'.repeat(64) }) };
  const options = { stateStore, actor: 'controller', org, audit, loadSettings: () => settings({ 'audit.enabled': enabled }),
    hasLegacyOperation: () => false, assertAuthorized() {},
    presence: { readRegistry() { return { agents: { worker: { runId: input.expectedRunId, pid: input.expectedPid, processStartTicks: '12345678', status: ended ? 'finished' : 'running', exitCode: 0, terminalAt: '2026-09-21T00:00:00.000Z' } } }; } },
    isAlive: () => !ended, pollMs: 1, processGoneTimeoutMs: 1, terminalTimeoutMs: 1,
    terminateProcess: () => { calls++; return new Promise(resolve => { release = () => { ended = true; resolve(); }; }); }, ...overrides };
  return { input, stateStore, run: createTerminateAction(options), setEnabled(value) { enabled = value; }, release() { release(); }, get calls() { return calls; } };
}
for (const initiallyEnabled of [false, true]) test(`termination custody preserves one ${initiallyEnabled ? 'audited' : 'Basic'} operation through a mid-flight policy toggle`, async () => {
  const f = terminateFixture();
  try {
    f.setEnabled(initiallyEnabled);
    const first = f.run(f.input);
    assert.equal(f.calls, 1);
    f.setEnabled(!initiallyEnabled);
    await assert.rejects(f.run(f.input), { code: 'BRIDGE_TERMINATE_IN_PROGRESS' });
    assert.equal(f.calls, 1);
    f.release(); const result = await first;
    assert.equal(result.receipt.verifiedGone, true);
    if (initiallyEnabled) assert.equal(result.receipt.auditSequence, 2);
    else assert.deepEqual(result.receipt.audit, require('../src/lib/operation-audit').skippedStatus(COMPLETED_ACTION, f.input.idempotencyKey));
    assert.deepEqual(await f.run(f.input), result);
    assert.equal(f.calls, 1);
    await assert.rejects(f.run({ ...f.input, expectedPid: 4343 }), { code: 'BRIDGE_TERMINATE_IDEMPOTENCY_COLLISION' });
  } finally { f.stateStore.close(); }
});

test('termination unknown outcome stays non-retryable after a toggle and legacy custody never authorizes a kill', async () => {
  let effects = 0;
  const f = terminateFixture({ terminateProcess: async () => { effects++; throw Object.assign(Error('dispatch unknown'), { code: 'UNKNOWN' }); } });
  try {
    await assert.rejects(f.run(f.input), { code: 'UNKNOWN' });
    f.setEnabled(true);
    await assert.rejects(f.run(f.input), { code: 'BRIDGE_TERMINATE_IN_PROGRESS' });
    assert.equal(effects, 1);
    assert.equal(f.stateStore.getOperation({ type: 'mission.bridge.terminate', key: f.input.idempotencyKey }).status, 'uncertain');
  } finally { f.stateStore.close(); }
  for (const probe of [() => true, () => { throw Error('unreadable'); }]) {
    const legacy = terminateFixture({ hasLegacyOperation: probe });
    try {
      await assert.rejects(legacy.run(legacy.input), error => ['BRIDGE_TERMINATE_LEGACY_CUSTODY', 'BRIDGE_TERMINATE_CUSTODY_UNAVAILABLE'].includes(error.code));
      assert.equal(legacy.calls, 0);
      assert.equal(legacy.stateStore.getOperation({ type: 'mission.bridge.terminate', key: legacy.input.idempotencyKey }), null);
    } finally { legacy.stateStore.close(); }
  }
});

test('legacy custody probe uses the shipping exact-selector SQL without signing or verifying history', () => {
  const { createAuditStore, hasLegacyOperation } = require('../src/lib/audit-store');
  const crypto = require('node:crypto');
  const store = createAuditStore({ file: ':memory:' });
  const pair = crypto.generateKeyPairSync('ed25519');
  try {
    store.registerKey({ keyId: 'key-basic-test', publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }) });
    store.appendEvent({ eventId: 'legacy-basic-test', occurredAtMs: 1, event: { action: INTENT_ACTION, target: 'known-key' } }, { keyId: 'key-basic-test', sign: bytes => crypto.sign(null, bytes, pair.privateKey) });
    const db = store._open();
    const deps = { stat: () => ({ isFile: () => true, isSymbolicLink: () => false }), open(file, options) {
      assert.equal(options.readOnly, true);
      return { prepare: (...args) => db.prepare(...args), exec: (...args) => db.exec(...args), close: () => db.exec('ROLLBACK; PRAGMA query_only=OFF;') };
    } };
    const probe = target => hasLegacyOperation({ actions: [INTENT_ACTION], target, file: 'retained-in-memory-boundary' }, deps);
    assert.equal(probe('unknown-key'), false);
    assert.equal(probe('known-key'), true);
    store.setMetadata('archive-boundary-v1', { exists: true });
    assert.throws(() => probe('unknown-key'), { code: 'AUDIT_LEGACY_CUSTODY_UNKNOWN' });
    assert.throws(() => hasLegacyOperation({ actions: [INTENT_ACTION], target: 'key' }, { stat: () => { throw Object.assign(Error('refused'), { code: 'EACCES' }); } }), { code: 'EACCES' });
  } finally { store.close(); }
});


const operationAudit = require('../src/lib/operation-audit');
test('ordinary StateStore task mutation in Basic never opens its semantic audit writer', async () => {
  const tasks = require('../src/lib/providers/tasks');
  const state = new StateStore({ file: ':memory:' });
  const policy = operationAudit.capturePolicy({ loadSettings: () => settings({}) });
  let auditCalls = 0;
  try {
    const result = await operationAudit.withPolicy(policy, () => tasks.submit({ queue: 'basic', type: 'fixture', idempotencyKey: 'basic-task-one', payload: { title: 'Test', objective: 'No worker starts.' }, expiryPolicy: 'uncertain', maxAttempts: 1 },
      { state, auditRecord() { auditCalls++; throw Error('Basic opened signer after effect'); } }));
    assert.equal(result.status, 'queued');
    assert.equal(state.listTasks({ queue: 'basic' }).length, 1);
    assert.equal(auditCalls, 0);
  } finally { state.close(); }
});

test('actual mission queue and cloud pairs retain one trusted policy through an effect-boundary toggle', async () => {
  const { createMissionActions } = require('../src/lib/mission-bridge/actions');
  const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
  const declared = declaredOrg();
  for (const enabledAtAdmission of [false, true]) {
    for (const kind of ['queue', 'register', 'disable', 'publish']) {
      let enabled = enabledAtAdmission, effects = 0, auditWrites = 0;
      const boundary = () => { effects++; enabled = !enabled; };
      const project = { cloudRepository: 'fixture/private', mirrorBranch: 'mirror', locallyDisabledAt: 'now' };
      const actions = createMissionActions({ roots: { fixture: process.cwd() }, actor: enabledControllerId(declared), agentOrg: declared,
        permissionSession: { origin: 'local', tier: 'full' }, policy: { assertActive() {} }, researchActions: {}, machinesActions: {},
        loadSettings: () => settings({ 'audit.enabled': enabled }),
        audit: { requireRecord() { auditWrites++; assert.equal(enabledAtAdmission, true); return { durable: true, anchored: true, sequence: auditWrites, eventHash: 'a'.repeat(64) }; } },
        executeTool: async name => { assert.equal(name, 'cloud.account_list'); return { accounts: [], environmentsComplete: true, environments: [{ environmentId: 'env-one', repository: 'fixture/private' }] }; },
        appendQueuePhase(input) { assert.equal(input.expectedHash, 'b'.repeat(64)); boundary(); return { phaseId: 'phase-one', previousHash: input.expectedHash, nextHash: 'c'.repeat(64), queuePath: 'BUILD-QUEUE.md' }; },
        cloudMirror: {
          async registerMirrorProject(input) { assert.equal(input.projectKey, 'fixture'); boundary(); await Promise.resolve(); return { projectKey: input.projectKey, project, registryPath: 'fixture', checks: [] }; },
          disableMirrorProject(input) { boundary(); return { projectKey: input.projectKey, project, registryPath: 'fixture' }; },
          async publishMirror(input) { boundary(); await Promise.resolve(); return { project: input.projectKey, publication: { ...project, sourceCommit: 'd'.repeat(40), publicationCommit: 'e'.repeat(40), mirroredEntries: 2, withheldEntries: 1 } }; }
        } });
      const reply = kind === 'queue' ? await actions.queue({ operation: 'open', rootId: 'fixture', expectedHash: 'b'.repeat(64), title: 'Bound test', authority: 'T781', brief: 'No worker starts' })
        : kind === 'register' ? await actions.cloudMirrorRegister({ projectKey: 'fixture', sourceRoot: process.cwd(), mirrorRemote: 'https://github.com/fixture/private.git', environment: 'env-one' })
        : kind === 'disable' ? await actions.cloudMirrorDisable({ projectKey: 'fixture' }) : await actions.cloudMirrorPublish({ projectKey: 'fixture' });
      assert.equal(reply.ok, true); assert.equal(effects, 1); assert.equal(auditWrites, enabledAtAdmission ? 2 : 0);
      const action = kind === 'queue' ? 'build.queue.open' : `cloud.mirror.${kind}`;
      if (enabledAtAdmission) assert.ok(reply.receipt.audit.sequence > reply.receipt.intentAudit.sequence);
      else {
        assert.equal(operationAudit.isNotRequired(reply.receipt.intentAudit, `${action}.intent`, 'fixture'), true);
        assert.equal(operationAudit.isNotRequired(reply.receipt.audit, action, kind === 'queue' ? 'phase-one' : 'fixture'), true);
      }
      assert.equal(operationAudit.isNotRequired({ ...operationAudit.skippedStatus(action, 'fixture'), forged: true }, action, 'fixture'), false);
    }
  }
});

test('actual persisted settings keep legacy Full dormant and reconfigure explicit audit and verification independently', () => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { runtimePolicy } = require('../src/lib/runtime-policy');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'basic-policy-settings-'));
  const valuesPath = path.join(root, 'settings.json');
  const read = () => runtimePolicy({ valuesPath });
  assert.deepEqual([read().auditEnabled, read().verifyHistory, read().continuationEnabled], [false, false, true]);
  const write = values => fs.writeFileSync(valuesPath, JSON.stringify({ revision: 1, ...settings(values) }));
  write({ 'audit.activity': 'Full' });
  assert.equal(read().auditEnabled, false); assert.equal(read().retainedActivity, 'Full');
  write({ 'audit.enabled': true, 'ledger.verify_history': false, 'audit.activity': 'Full' });
  assert.deepEqual([read().auditEnabled, read().verifyHistory, read().activity], [true, false, 'Full']);
  write({ 'audit.enabled': false, 'ledger.verify_history': true, 'agent.persistent_continuation': false });
  assert.deepEqual([read().auditEnabled, read().verifyHistory, read().continuationEnabled], [false, true, false]);
  fs.writeFileSync(valuesPath, '{unreadable');
  assert.equal(read().configurationAvailable, false);
  assert.equal(read().continuationEnabled, false);
  // Retained fixture: this test never deletes or cleans any state.
});


test('an audited post-mutation refusal preserves the task and a later Basic retry cannot duplicate it', async () => {
  const tasks = require('../src/lib/providers/tasks');
  const state = new StateStore({ file: ':memory:' });
  const input = { queue: 'basic', type: 'fixture', idempotencyKey: 'task-effect-one', payload: { title: 'Test', objective: 'No worker starts.' }, expiryPolicy: 'uncertain', maxAttempts: 1 };
  const on = operationAudit.capturePolicy({ loadSettings: () => settings({ 'audit.enabled': true }) });
  const off = operationAudit.capturePolicy({ loadSettings: () => settings({}) });
  let attempts = 0;
  try {
    await assert.rejects(operationAudit.withPolicy(on, () => tasks.submit(input, { state, auditRecord() { attempts++; throw Error('anchor refused after committed task'); } })), { code: 'COORDINATOR_AUDIT_UNAVAILABLE' });
    assert.equal(state.listTasks({ queue: 'basic' }).length, 1);
    const retried = await operationAudit.withPolicy(off, () => tasks.submit(input, { state, auditRecord() { throw Error('off must not audit'); } }));
    assert.equal(retried.replayed, true);
    assert.equal(state.listTasks({ queue: 'basic' }).length, 1);
    assert.equal(attempts, 1);
  } finally { state.close(); }
});


test('Basic ordinary rule filing still enforces the filing permission and verbatim words before its effect', () => {
  const { RLedgerAgentControl } = require('../src/lib/r-ledger-agent-gate');
  const { RLedgerError } = require('../src/lib/r-ledger');
  let mode = 'off', effects = 0, audits = 0, enabled = false;
  const words = 'Preserve the local fixture.';
  const control = new RLedgerAgentControl({ loadSettings: () => settings({ 'audit.enabled': enabled }),
    gate: () => ({ mode }), turns: () => [words], scrub: text => text,
    auditRequire: () => { audits++; throw Error('audit unavailable'); },
    ledger: { RLedgerError, SCOPE_WORD: { global: 'this computer' }, readLedger: () => ({ entries: [], key: null }),
      fileRequest(args) { effects++; return { ...args, id: 'R1', status: 'open' }; } } });
  const args = { actor: 'codex', scope: 'global', words };
  assert.throws(() => control.file(args), { code: 'R_LEDGER_AGENT_FILING_OFF' });
  mode = 'auto';
  assert.throws(() => control.file({ ...args, words: 'Invented words.' }), { code: 'R_LEDGER_WORDS_NOT_VERBATIM' });
  assert.equal(effects, 0); assert.equal(audits, 0);
  assert.equal(control.file(args).filed, true); assert.equal(effects, 1);
  enabled = true;
  assert.throws(() => control.file(args), /audit unavailable/);
  assert.equal(effects, 1); assert.equal(audits, 1);
});


test('Ledger progress inherits the operation snapshot already admitted by the registry wrapper', async () => {
  let enabled = false, writes = 0, audits = 0;
  const policy = operationAudit.capturePolicy({ loadSettings: () => settings({ 'audit.enabled': enabled }) });
  enabled = true;
  const control = new MinorLedgerAgentControl({ store: { progressTask(args) { writes++; return args; } }, scrub: text => text,
    loadSettings: () => settings({ 'audit.enabled': enabled }), auditRequireAsync() { audits++; throw Error('later policy cannot change this operation'); } });
  await operationAudit.withPolicy(policy, () => control.progress({ id: 'T1', actor: 'codex', status: 'in-progress', reason: 'Bound progress' }));
  assert.equal(writes, 1); assert.equal(audits, 0);
});


test('Basic mission task admission traverses the real registry and provider into one durable task', async () => {
  const { createMissionActions } = require('../src/lib/mission-bridge/actions');
  const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
  const { getStateStore, closeStateStore } = require('../src/lib/state-store');
  const declared = declaredOrg();
  const actions = createMissionActions({ roots: { fixture: process.cwd() }, actor: enabledControllerId(declared), agentOrg: declared,
    permissionSession: { origin: 'local', tier: 'full' }, policy: { assertActive() {} }, researchActions: {}, machinesActions: {},
    loadSettings: () => settings({}) });
  const input = { queue: 'basic-wrapper', type: 'fixture', idempotencyKey: 'basic-wrapper-one', payload: { title: 'Fixture', objective: 'No worker starts.' }, expiryPolicy: 'uncertain', maxAttempts: 1 };
  try {
    const first = await actions.taskSubmit(input);
    assert.equal(first.ok, true);
    const second = await actions.taskSubmit(input);
    assert.equal(second.receipt.taskId, first.receipt.taskId);
    assert.equal(second.receipt.replayed, true);
    assert.equal(getStateStore().listTasks({ queue: input.queue }).length, 1);
  } finally { closeStateStore(); }
});


test('fresh Basic approval settings reach real policy while saved choices and uncertainty remain guarded', () => {
  const fs = require('node:fs'), path = require('node:path');
  const { scratchRoot } = require('./helpers/isolated-state-root');
  const { loadSettings } = require('../src/lib/settings');
  const policy = require('../src/lib/policy');
  const approval = require('../src/lib/agent-approval-policy');
  const tier = require('../src/lib/permission-tier-policy');
  const valuesPath = path.join(scratchRoot, 'approval-settings.json');
  const ids = ['agent.tool_approvals', 'agent.blocked_question', 'agent.blocked_question_per_node'];
  const read = () => loadSettings({ valuesPath, ids });
  const strict = { approvals: { enabled: true, actions: ['host.exec'], externalWrites: true } };
  const request = { tool: 'task.submit', effect: 'local-write' };
  const decisionOptions = { judge: () => ({ approve: true }), tierCheck: entry => tier.assertToolAllowed(entry, tier.installTierSession('standard')) };
  const fresh = read();
  assert.equal(approval.decideFromSettings({ tool: 'host.exec', effect: 'local-write' }, fresh, decisionOptions).decision, 'deny', 'optional confirmation does not bypass Standard tool exclusion');
  assert.equal(fresh.values['agent.tool_approvals'], false);
  assert.equal(fresh.values['agent.blocked_question'], 'Decide for itself');
  assert.equal(policy.requiresApproval('host.exec', 'local-write', strict, { loadSettings: read }), false);
  assert.equal(approval.decideFromSettings(request, fresh, decisionOptions).decision, 'allow');
  assert.notEqual(approval.decideFromSettings(request, fresh, { ...decisionOptions, tierCheck: entry => tier.assertToolAllowed(entry, tier.installTierSession('guided')) }).decision, 'allow');
  const save = values => fs.writeFileSync(valuesPath, JSON.stringify({ revision: 1, values, provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source: 'user' }])) }));
  save({ 'agent.tool_approvals': true, 'agent.blocked_question': 'Stop and wait for me' });
  assert.equal(policy.requiresApproval('host.exec', 'local-write', strict, { loadSettings: read }), true);
  assert.equal(approval.decideFromSettings(request, read(), decisionOptions).decision, 'ask');
  save({ 'agent.tool_approvals': false, 'agent.blocked_question': 'Switch to other work' });
  assert.equal(policy.requiresApproval('host.exec', 'local-write', strict, { loadSettings: read }), false);
  assert.equal(approval.decideFromSettings(request, read(), decisionOptions).decision, 'defer');
  for (const value of ['broken JSON', JSON.stringify({ revision: 2, values: { 'agent.tool_approvals': 'false', 'agent.blocked_question': 'typo' }, provenance: {} })]) {
    fs.writeFileSync(valuesPath, value);
    assert.equal(policy.requiresApproval('host.exec', 'local-write', strict, { loadSettings: read }), true);
    assert.equal(approval.decideFromSettings(request, read(), decisionOptions).decision, 'ask');
  }
  assert.equal(policy.requiresApproval('host.exec', 'local-write', strict, { loadSettings: () => { throw Error('unreadable'); } }), true);
});


test('actual operation policy retires the old Engine lane after settlement and preserves a re-enabled lane', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { createRequire } = require('node:module'), { EventEmitter } = require('node:events');
  const workers = [];
  class HeldWorker extends EventEmitter {
    constructor() { super(); this.requests = []; this.terminated = 0; workers.push(this); }
    unref() {}
    postMessage(message) {
      this.requests.push(message);
      if (message.kind === 'close') queueMicrotask(() => this.emit('message', { id: message.id, result: { closed: true } }));
    }
    async terminate() { this.terminated++; this.emit('exit', 1); }
    answer(status) { const request = this.requests.find(row => row.kind === 'events'); this.emit('message', { id: request.id, statuses: [status] }); }
  }
  function loadSource(file, override) {
    const filename = path.resolve(__dirname, '../src/lib', file), realRequire = createRequire(filename);
    const module = { exports: {} };
    const source = fs.readFileSync(filename, 'utf8');
    vm.runInNewContext('(function(require,module,exports,__dirname) {' + source + '\n})',
      { process, Buffer, setTimeout, clearTimeout, setImmediate, clearImmediate }, { filename })
      (id => override(id) || realRequire(id), module, module.exports, path.dirname(filename));
    return module.exports;
  }
  const admission = loadSource('audit-admission.js', id => id === 'node:worker_threads' ? { isMainThread: true, Worker: HeldWorker }
    : id === './throughput-mode' ? { throughputMode: () => 'fast' }
    : id === './tool-performance-settings' ? { performanceSettings: () => ({ 'tools.audit_batch_window_ms': 0, 'tools.audit_batch_size': 32 }) } : null);
  const operation = loadSource('operation-audit.js', id => id === './audit-admission' ? admission : null);
  let enabled = true;
  const options = { loadSettings: () => settings({ 'audit.enabled': enabled }) };
  const first = operation.requireRecordAsync('test.intent', 'first', {}, options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers.length, 1);
  enabled = false;
  const off = await operation.requireRecordAsync('test.intent', 'off', {}, options);
  assert.equal(off.disposition, 'not-required');
  assert.equal(workers[0].terminated, 0);
  enabled = true;
  const second = operation.requireRecordAsync('test.intent', 'second', {}, options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers.length, 2);
  const status = { ok: true, recorded: true, durable: true, anchored: true, eventId: 'first', sequence: 1, eventHash: 'a'.repeat(64), errors: [] };
  workers[0].answer(status);
  assert.deepEqual(await first, status);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(workers[0].terminated, 1);
  assert.equal(workers[1].terminated, 0);
  enabled = false;
  const refused = assert.rejects(second, /Durable audit intent could not be recorded/);
  workers[1].answer(admission.failedStatus(Object.assign(Error('anchor refused'), { code: 'AUDIT_HEAD_UNAVAILABLE' })));
  await refused;
  await operation.retireIfDisabled(options);
  assert.equal(workers[1].terminated, 1);
  assert.equal((await operation.requireRecordAsync('test.intent', 'still-off', {}, options)).recorded, false);
  assert.equal(workers.length, 2, 'Basic must not recreate the retired infrastructure');
});


for (const required of [false, true]) for (const method of ['ownerPromptPresented', 'ownerPromptDecision']) {
  test(`owner-prompt ${method} keeps operation identity with ${required ? 'required' : 'Basic'} audit evidence`, async () => {
    const { createMissionActions } = require('../src/lib/mission-bridge/actions');
    const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
    const declared = declaredOrg(), calls = [];
    let enabled = required;
    const result = method === 'ownerPromptPresented'
      ? { promptId: 'prompt-fixture', presentedAt: '2026-09-21T00:00:00.000Z', evidenceCount: 1 }
      : { promptId: 'prompt-fixture', kind: 'notice', decision: 'acknowledged' };
    const storeCall = input => { calls.push('store'); assert.equal(input.promptId, result.promptId); enabled = !enabled; return result; };
    const actions = createMissionActions({ roots: { fixture: process.cwd() }, actor: enabledControllerId(declared), agentOrg: declared,
      permissionSession: { origin: 'local', tier: 'full' }, policy: { assertActive() {} }, researchActions: {}, machinesActions: {},
      loadSettings: () => settings({ 'audit.enabled': enabled }), ownerPrompts: { markPresented: storeCall, decide: storeCall },
      audit: { requireRecord(action, target) { calls.push(action); assert.equal(required, true); assert.equal(target, result.promptId);
        return { durable: true, anchored: true, sequence: calls.length, eventHash: 'a'.repeat(64) }; } } });
    const reply = await actions[method]({ promptId: result.promptId, evidence: { visible: true }, decision: 'acknowledged' });
    const operation = method === 'ownerPromptPresented' ? 'owner-prompt-presented' : 'owner-prompt-decision';
    const auditAction = method === 'ownerPromptPresented' ? 'owner-prompt.presented' : 'owner-prompt.decision';
    assert.equal(reply.ok, true);
    assert.equal(reply.receipt.action, operation, 'audit action cannot overwrite the operation action');
    for (const [key, value] of Object.entries(result)) assert.equal(reply.receipt[key], value);
    if (required) {
      assert.equal(reply.receipt.sequence, calls.length); assert.equal(reply.receipt.eventHash, 'a'.repeat(64));
      assert.equal(Object.hasOwn(reply.receipt, 'disposition'), false);
      assert.deepEqual(calls, method === 'ownerPromptPresented' ? ['store', auditAction] : [auditAction + '.intent', 'store', auditAction]);
    } else {
      assert.deepEqual(reply.receipt.audit, operationAudit.skippedStatus(auditAction, result.promptId));
      for (const key of ['sequence', 'eventHash', 'disposition', 'required']) assert.equal(Object.hasOwn(reply.receipt, key), false);
      assert.deepEqual(calls, ['store']);
    }
    if (method === 'ownerPromptDecision') assert.deepEqual(reply.outcome, result);
  });
}

test('owner-prompt required intent refusal precedes decision and outcome refusal never invents a receipt', async () => {
  const { createMissionActions } = require('../src/lib/mission-bridge/actions');
  const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
  const declared = declaredOrg();
  for (const refusedAction of ['owner-prompt.decision.intent', 'owner-prompt.decision', 'owner-prompt.presented']) {
    let effects = 0;
    const commit = () => { effects++; return { promptId: 'prompt-fixture', kind: 'notice', decision: 'acknowledged' }; };
    const actions = createMissionActions({ roots: { fixture: process.cwd() }, actor: enabledControllerId(declared), agentOrg: declared,
      permissionSession: { origin: 'local', tier: 'full' }, policy: { assertActive() {} }, researchActions: {}, machinesActions: {},
      loadSettings: () => settings({ 'audit.enabled': true }), ownerPrompts: { decide: commit, markPresented: commit },
      audit: { requireRecord(action) { if (action === refusedAction) throw Error('retained synthetic audit refusal');
        return { durable: true, anchored: true, sequence: 1, eventHash: 'a'.repeat(64) }; } } });
    const method = refusedAction === 'owner-prompt.presented' ? 'ownerPromptPresented' : 'ownerPromptDecision';
    await assert.rejects(actions[method]({ promptId: 'prompt-fixture', decision: 'acknowledged', evidence: {} }), { code: 'BRIDGE_AUDIT_UNAVAILABLE' });
    assert.equal(effects, refusedAction.endsWith('.intent') ? 0 : 1);
  }
});

// Actual registry handlers and both local-model layers; only settings, audit,
// inventory, transport and durable-state/runtime boundaries are inert. Nothing
// here loads a model, starts a worker, or owns a filesystem fixture.
function localProviderPolicyFixture(initial) {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { createRequire } = require('node:module');
  const f = { enabled: initial, calls: [], audits: [], operations: new Map(), tasks: new Map(),
    running: false, allow: true, unknown: false, failAudit: false, loseAck: false, probes: 0, transports: 0 };
  const load = (file, overrides = {}) => {
    const filename = path.resolve(__dirname, '../src/lib', file), fallback = createRequire(filename);
    const module = { exports: {} };
    vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })
      (id => Object.hasOwn(overrides, id) ? overrides[id] : fallback(id), module, module.exports, filename, path.dirname(filename));
    return module.exports;
  };
  const writer = {
    requireRecord(action, target, details) {
      f.audits.push({ action, target, details });
      if (f.failAudit && /^(model\.|overnight_advisory\.)/.test(action)) throw Object.assign(Error('fixture audit unavailable'), { code: 'AUDIT_UNAVAILABLE' });
      return { ok: true, durable: true, anchored: true, signed: true, sequence: f.audits.length, eventHash: 'a'.repeat(64) };
    },
    record(...args) { return this.requireRecord(...args); },
    redact: value => String(value),
    AuditRequiredError: class extends Error {}
  };
  // Providers capture these functions without their object receiver.
  writer.requireRecord = writer.requireRecord.bind(writer); writer.record = writer.record.bind(writer);
  const runtimePolicy = load('runtime-policy.js', { './settings': { loadSettings() {
    if (f.unknown) throw Error('fixture settings unreadable');
    return settings(f.enabled === undefined ? {} : { 'audit.enabled': f.enabled, 'audit.activity': 'Full' });
  } } });
  const operation = load('operation-audit.js', { './runtime-policy': runtimePolicy, './audit': writer,
    './audit-admission': { retireDefaultAdmissionQueue: async () => {} } });
  const state = {
    recordModelUsage(row) { f.calls.push(['usage', row.model]); },
    submitBoundedTask(row) {
      f.calls.push(['submit', row.idempotencyKey]);
      if (f.tasks.has(row.idempotencyKey)) return { task: f.tasks.get(row.idempotencyKey), replayed: true };
      const task = { taskId: 'task-local-policy-1', queue: row.queue, type: row.type, status: 'queued', payload: row.payload };
      f.tasks.set(row.idempotencyKey, task); return { task, replayed: false };
    },
    reserveOperation(row) {
      f.calls.push(['reserve', row.key]);
      const previous = f.operations.get(row.key);
      if (previous) {
        if (previous.inputHash !== row.inputHash) throw Object.assign(Error('different intent'), { code: 'TEST_OPERATION_CONFLICT' });
        return previous.result ? { disposition: 'replay', result: previous.result } : { disposition: 'uncertain' };
      }
      const handle = { key: row.key }; f.operations.set(row.key, { inputHash: row.inputHash, handle });
      return { disposition: 'reserved', handle };
    },
    markOperationExecuting(handle) { f.calls.push(['executing', handle.key]); return { handle }; },
    succeedOperation(handle, { result }) { f.calls.push(['succeed', handle.key]); f.operations.get(handle.key).result = result; },
    markOperationUncertain(handle) { f.calls.push(['uncertain', handle.key]); }
  };
  const resources = () => ({ ollamaReachable: true, installedModels: ['qwen2.5-coder:7b', 'qwen3.5:4b'], residentModels: [],
    freeRamBytes: 32 * 1024 ** 3, freeVramBytes: 24 * 1024 ** 3, totalVramBytes: 24 * 1024 ** 3, onBattery: false });
  const probe = async () => { f.probes++; if (f.atProbe) await f.atProbe(); return { ...resources(), ...f.resources }; };
  const chat = async request => {
    f.transports++; f.calls.push(['chat', request.model]);
    if (f.atChat) await f.atChat();
    return { model: request.model, message: { content: request.format ? JSON.stringify({ replacement: 'const b = 1;', summary: 'Renamed.' }) : 'bounded advice' },
      prompt_eval_count: 3, eval_count: 2, total_duration: 1000000, done: true };
  };
  const providerOverrides = { '../operation-audit': operation, '../audit': writer, '../state-store': { getStateStore: () => state } };
  const realModel = load('providers/model.js', providerOverrides);
  const modelDependencies = { probe, chat, requestJson: (_route, request) => chat(request), state,
    usageAttribution: () => ({ agentId: 'fixture', agentRole: 'worker' }) };
  const model = { ...realModel, probeLocalModel: probe,
    complete: (input, dependencies) => realModel.complete(input, { ...modelDependencies, ...dependencies }),
    quickEdit: (input, dependencies) => realModel.quickEdit(input, { ...modelDependencies, ...dependencies }) };
  const realRole = load('providers/model-role.js', { ...providerOverrides, './model': model });
  const role = { ...realRole, complete: input => realRole.complete(input, { probe, usageAttribution: modelDependencies.usageAttribution }) };
  const policy = load('policy.js', {
    './runtime': { ...require('../src/lib/runtime'), readJson: () => ({ approvals: { enabled: false }, providers: {}, overnightAdvisory: { enabled: f.allow } }) },
    './settings': { loadSettings: () => settings({ 'agent.tool_approvals': false }) }
  });
  const assertEnabled = () => { f.calls.push(['enabled']); policy.assertOvernightAdvisoryAllowed(); };
  const advisory = load('providers/overnight-advisory.js', { ...providerOverrides,
    '../policy': { assertOvernightAdvisoryAllowed: assertEnabled } });
  class InertAdvisoryRuntime {
    start() { f.calls.push(['start']); if (f.loseAck) throw Object.assign(Error('lost start receipt'), { code: 'TEST_LOST_ACK' }); f.running = true; return { accepted: true, status: 'running', running: true }; }
    stop() { f.calls.push(['stop']); f.running = false; return { accepted: true, status: 'stopped', running: false }; }
    status() { return { status: f.running ? 'running' : 'stopped', running: f.running }; }
  }
  const coordinator = require('../src/lib/coordinator-audit-events');
  const registry = load('tool-registry.js', {
    './operation-audit': operation, './audit': writer,
    './throughput-mode': { throughputMode: () => 'strict' },
    './coordinator-audit-events': { ...coordinator,
      write: event => writer.record(event.action || 'fixture.policy', event.target || 'fixture', event),
      writeAsync: async event => writer.record(event.action || 'fixture.policy', event.target || 'fixture', event) },
    './controller-tool-meter': { createToolMeterQueue: () => ({ observe() {} }) },
    './policy': policy,
    './providers/model': model, './providers/model-role': role, './providers/overnight-advisory': advisory,
    './providers/overnight-advisory-runtime': { OvernightAdvisoryWorkerRuntime: InertAdvisoryRuntime }
  });
  f.run = (name, args, context = { permissionSession: { origin: 'local', tier: 'full' } }) => registry.executeTool(name, args, context);
  f.operation = operation; f.advisory = advisory; f.role = realRole; f.state = state;
  return f;
}

const localProviderRequests = [
  ['model.complete', { prompt: 'Explain a small local change.' }],
  ['model.quick_edit', { instruction: 'Rename the local variable.', source: 'const a = 1;', language: 'javascript' }],
  ['model.role_complete', { role: 'reviewer', model: 'qwen2.5-coder:7b', prompt: 'Review a small local change.' }],
  ['overnight_advisory.submit', { actor: 'human', idempotencyKey: 'local-policy-submit-1', title: 'Local advice', prompt: 'Review a small local change.', acceptanceChecklist: ['Give bounded advice.'] }],
  ['overnight_advisory.lifecycle', { actor: 'human', action: 'start', idempotencyKey: 'local-policy-start-1' }]
];

for (const [name, args] of localProviderRequests) {
  test(`local provider policy: ${name} inherits Basic and required admission through the registry`, async () => {
    for (const enabled of [undefined, false, true]) {
      const f = localProviderPolicyFixture(enabled);
      const result = await f.run(name, args);
      assert.ok(result);
      if (name.startsWith('model.')) {
        assert.equal(f.transports, 1);
        assert.equal(f.calls.filter(row => row[0] === 'usage').length, 1);
        assert.equal(result.grantsAuthority, false);
      } else assert.equal(f.calls.filter(row => row[0] === (name.endsWith('submit') ? 'submit' : 'start')).length, 1);
      const events = f.audits.filter(row => /^(model\.|overnight_advisory\.)/.test(row.action));
      if (enabled === true) {
        const expected = name === 'model.role_complete'
          ? ['model.role_complete.intent', 'model.complete.intent', 'model.complete', 'model.role_complete']
          : name.startsWith('model.') ? [name + '.intent', name]
          : [name === 'overnight_advisory.lifecycle' ? name + '.start' : name];
        assert.deepEqual(events.map(row => row.action), expected);
      } else assert.equal(f.audits.length, 0, 'Basic must not reach any canonical audit writer');
    }
  });
  test(`local provider policy: ${name} refuses required audit before dispatch and unknown policy before probing`, async () => {
    const required = localProviderPolicyFixture(true); required.failAudit = true;
    await assert.rejects(required.run(name, args), { code: 'AUDIT_UNAVAILABLE' });
    assert.equal(required.transports, 0);
    assert.equal(required.calls.some(row => ['submit', 'reserve', 'start', 'stop', 'usage'].includes(row[0])), false);
    assert.equal(required.audits.filter(row => /^(model\.|overnight_advisory\.)/.test(row.action)).length, 1);
    const unknown = localProviderPolicyFixture(false); unknown.unknown = true;
    await assert.rejects(unknown.run(name, args), { code: 'AUDIT_POLICY_INVALID' });
    assert.deepEqual([unknown.probes, unknown.transports, unknown.calls.length, unknown.audits.length], [0, 0, 0, 0]);
  });
}

for (const initiallyEnabled of [false, true]) {
  test(`local provider policy: nested role keeps ${initiallyEnabled ? 'required' : 'Basic'} custody through both await boundaries`, async () => {
    const f = localProviderPolicyFixture(initiallyEnabled);
    let releaseProbe, enteredProbe, releaseChat, enteredChat;
    const probing = new Promise(resolve => { enteredProbe = resolve; });
    const chatting = new Promise(resolve => { enteredChat = resolve; });
    f.atProbe = () => { enteredProbe(); return new Promise(resolve => { releaseProbe = resolve; }); };
    f.atChat = () => { enteredChat(); return new Promise(resolve => { releaseChat = resolve; }); };
    const pending = f.run(...localProviderRequests[2]);
    await probing; f.enabled = !initiallyEnabled; releaseProbe();
    await chatting; releaseChat(); await pending;
    const events = f.audits.filter(row => row.action.startsWith('model.')).map(row => row.action);
    assert.deepEqual(events, initiallyEnabled
      ? ['model.role_complete.intent', 'model.complete.intent', 'model.complete', 'model.role_complete'] : []);
    assert.equal(f.transports, 1);
    // The next independent dispatch must use the newly saved policy.
    f.atProbe = null; f.atChat = null; f.audits.length = 0;
    await f.run(...localProviderRequests[0]);
    assert.equal(f.audits.some(row => row.action === 'model.complete.intent'), !initiallyEnabled);
  });
}

test('local provider policy: permission, input and resource refusals survive Basic admission', async () => {
  const f = localProviderPolicyFixture(false);
  await assert.rejects(f.run(...localProviderRequests[0], {}), { code: 'PERMISSION_SESSION_REQUIRED' });
  await assert.rejects(f.run('model.role_complete', { ...localProviderRequests[2][1], role: 'operator' }));
  assert.deepEqual([f.probes, f.transports, f.audits.length], [0, 0, 0]);
  f.resources = { installedModels: [] };
  await assert.rejects(f.run(...localProviderRequests[2]), { code: 'MODEL_ROLE_NOT_INSTALLED' });
  assert.equal(f.transports, 0); assert.equal(f.audits.length, 0);
  f.allow = false;
  await assert.rejects(f.run(...localProviderRequests[3]), { code: 'OVERNIGHT_ADVISORY_DISABLED' });
  await assert.rejects(f.run(...localProviderRequests[4]), { code: 'OVERNIGHT_ADVISORY_DISABLED' });
  assert.equal(f.tasks.size, 0); assert.equal(f.operations.size, 0); assert.equal(f.audits.length, 0);
});

test('local provider policy: Basic advisory stop, replay and uncertainty retain operational custody', async () => {
  const f = localProviderPolicyFixture(false), [name, start] = localProviderRequests[4];
  const first = await f.run(name, start); assert.equal(first.running, true);
  const replay = await f.run(name, start); assert.equal(replay.replayed, true);
  assert.equal(f.calls.filter(row => row[0] === 'start').length, 1);
  await assert.rejects(f.run(name, { ...start, action: 'stop' }), { code: 'TEST_OPERATION_CONFLICT' });
  f.allow = false;
  const stopped = await f.run(name, { ...start, action: 'stop', idempotencyKey: 'local-policy-stop-1' });
  assert.equal(stopped.running, false, 'disabling new work must not prevent an owned stop');
  assert.equal(f.calls.filter(row => row[0] === 'stop').length, 1);
  f.allow = true; f.loseAck = true;
  const lost = { ...start, idempotencyKey: 'local-policy-lost-1' };
  await assert.rejects(f.run(name, lost), { code: 'TEST_LOST_ACK' });
  assert.equal(f.calls.filter(row => row[0] === 'uncertain').length, 1);
  await assert.rejects(f.run(name, lost), { code: 'OVERNIGHT_ADVISORY_LIFECYCLE_RESERVATION_FAILED' });
  assert.equal(f.calls.filter(row => row[0] === 'start').length, 2, 'an unknown old operation cannot be replayed');
  assert.equal(f.audits.length, 0);
  const a = await f.run(...localProviderRequests[3]), b = await f.run(...localProviderRequests[3]);
  assert.equal(a.taskId, b.taskId); assert.equal(b.replayed, true); assert.equal(f.tasks.size, 1);
});

test('local provider policy: wrong or required-mode skip receipts cannot authorize advisory work', () => {
  const f = localProviderPolicyFixture(false), input = localProviderRequests[3][1];
  for (const [required, receipt] of [
    [false, { durable: false }],
    [false, f.operation.skippedStatus('overnight_advisory.submit', 'wrong-target')],
    [true, f.operation.skippedStatus('overnight_advisory.submit', 'overnight-local-advisory')]
  ]) {
    f.enabled = required;
    const control = new f.advisory.OvernightAdvisoryControl({ state: f.state, assertEnabled() {}, auditRequire: () => receipt });
    assert.throws(() => f.operation.withPolicy(f.operation.capturePolicy(), () => control.submit(input)), { code: 'OVERNIGHT_ADVISORY_AUDIT_REQUIRED' });
    assert.equal(f.tasks.size, 0);
  }
});

test('local provider policy: advisory Stop retains required audit and rejects unknown policy before reservation', async () => {
  const args = { actor: 'human', action: 'stop', idempotencyKey: 'local-policy-stop-required-1' };
  for (const mode of ['basic', 'required', 'refused', 'unknown']) {
    const f = localProviderPolicyFixture(mode !== 'basic');
    f.running = true; f.allow = false; f.failAudit = mode === 'refused'; f.unknown = mode === 'unknown';
    if (mode === 'refused' || mode === 'unknown') {
      await assert.rejects(f.run('overnight_advisory.lifecycle', args), { code: mode === 'unknown' ? 'AUDIT_POLICY_INVALID' : 'AUDIT_UNAVAILABLE' });
      assert.equal(f.running, true); assert.equal(f.operations.size, 0);
      assert.equal(f.calls.some(row => row[0] === 'stop'), false);
    } else {
      const result = await f.run('overnight_advisory.lifecycle', args);
      assert.equal(result.running, false);
      assert.equal(f.audits.filter(row => row.action === 'overnight_advisory.lifecycle.stop').length, mode === 'basic' ? 0 : 1);
    }
  }
});

test('local provider policy: role rejects mismatched and required-mode skip before its nested model', async () => {
  const f = localProviderPolicyFixture(false), args = localProviderRequests[2][1];
  for (const [required, receipt] of [
    [false, { durable: false }],
    [false, f.operation.skippedStatus('model.role_complete.intent', 'wrong-model')],
    [true, f.operation.skippedStatus('model.role_complete.intent', args.model)]
  ]) {
    f.enabled = required;
    await assert.rejects(f.operation.withPolicy(f.operation.capturePolicy(), () => f.role.complete(args, {
      auditRequire: () => receipt, usageAttribution: () => ({}),
      probe: async () => ({ installedModels: [args.model], residentModels: [], freeVramBytes: 24 * 1024 ** 3 })
    })), { code: 'MODEL_ROLE_AUDIT_UNAVAILABLE' });
    assert.equal(f.transports, 0);
  }
});

test('local provider policy: caller policy-shaped fields cannot disable required registry admission', async () => {
  const f = localProviderPolicyFixture(true); f.failAudit = true;
  await assert.rejects(f.run(...localProviderRequests[0], {
    permissionSession: { origin: 'local', tier: 'full' }, auditPolicy: { required: false }
  }), { code: 'AUDIT_UNAVAILABLE' });
  const before = f.probes;
  await assert.rejects(f.run('model.complete', { ...localProviderRequests[0][1], auditPolicy: { required: false } }), error => error.name === 'SchemaValidationError');
  assert.equal(f.probes, before); assert.equal(f.transports, 0);
});


// Actual registry and provider bodies with in-memory persistence and inert OS
// adapters. These tests never set up a host, start a CLI or open a secret store.
function infrastructurePolicyFixture(enabled, { legacy = false } = {}) {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { createRequire } = require('node:module');
  const f = { enabled, audits: [], effects: 0, probes: 0, commits: 0, unknown: false, failAudit: false,
    badReceipt: false, flip: false, elevated: false, uncertain: false, killed: false, completions: [], files: new Map() };
  const load = (file, overrides = {}, mockProcess = process) => {
    const filename = path.resolve(__dirname, '../src/lib', file), fallback = createRequire(filename), module = { exports: {} };
    vm.runInThisContext('(function(require,module,exports,__filename,__dirname,process){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename })
      (id => Object.hasOwn(overrides, id) ? overrides[id] : fallback(id), module, module.exports, filename, path.dirname(filename), mockProcess);
    return module.exports;
  };
  const writer = {
    redact: String,
    requireRecord(action, target, details) {
      f.audits.push({ action, target, details });
      if (/^(sandbox|scheduler|workstation)\./.test(action)) {
        if (f.failAudit) throw Object.assign(Error('inert signer refusal'), { code: 'AUDIT_UNAVAILABLE' });
        if (f.badReceipt) return f.operation.skippedStatus(action, target);
      }
      return { ok: true, durable: true, anchored: true, signed: true, sequence: f.audits.length, eventHash: 'b'.repeat(64) };
    },
    record(action, target, details) { return writer.requireRecord(action, target, details); },
    AuditRequiredError: class extends Error {}
  };
  const runtimePolicy = load('runtime-policy.js', { './settings': { loadSettings() {
    if (f.unknown) throw Error('inert unreadable settings');
    return settings(f.enabled === undefined ? {} : { 'audit.enabled': f.enabled, 'audit.activity': 'Full' });
  } } });
  const operation = load('operation-audit.js', { './runtime-policy': runtimePolicy, './audit': writer,
    './audit-admission': { retireDefaultAdmissionQueue: async () => {} } });
  f.operation = operation;
  const runtime = require('../src/lib/runtime');
  const policy = load('policy.js', {
    'node:fs': { statSync: () => f.killed ? {} : undefined },
    './runtime': { ...runtime, readJson: () => ({ mode: 'autonomous', approvals: { enabled: false }, providers: {} }) },
    './settings': { loadSettings: () => settings({ 'agent.tool_approvals': false }) }
  });
  const effect = () => { f.effects++; if (f.flip) f.enabled = !f.enabled; };
  const directories = new Set(), descriptors = new Map();
  let descriptor = 100;
  const missing = () => Object.assign(Error('inert file absent'), { code: 'ENOENT' });
  const memoryFs = {
    existsSync: name => f.files.has(name) || directories.has(name),
    lstatSync(name) {
      if (!f.files.has(name) && !directories.has(name)) throw missing();
      return { isDirectory: () => directories.has(name), isSymbolicLink: () => false };
    },
    mkdirSync(name, options = {}) {
      if (directories.has(name) && !options.recursive) throw Object.assign(Error('exists'), { code: 'EEXIST' });
      directories.add(name);
    },
    openSync(name, flags) {
      assert.equal(flags, 'wx');
      if (f.files.has(name)) throw Object.assign(Error('exists'), { code: 'EEXIST' });
      f.files.set(name, ''); descriptors.set(++descriptor, name); return descriptor;
    },
    writeFileSync(name, value) { f.files.set(typeof name === 'number' ? descriptors.get(name) : name, String(value)); },
    readFileSync(name, encoding) {
      const data = name.includes('/docker/agent-sandbox/') ? 'inert pinned context' : f.files.get(name);
      if (data === undefined) throw missing();
      return encoding ? data : Buffer.from(data);
    },
    readdirSync(name) { return [...f.files.keys()].filter(file => path.dirname(file) === name).map(file => path.basename(file)); },
    closeSync(fd) { assert.equal(descriptors.delete(fd), true); },
    unlinkSync(name) { if (!f.files.delete(name)) throw missing(); },
    rmdirSync(name) { assert.equal(memoryFs.readdirSync(name).length, 0); directories.delete(name); }
  };
  const virtualRoot = '/virtual/t816-sandbox';
  const sandboxRuntime = {
    ...runtime, rootPath: (...parts) => path.join(virtualRoot, ...parts),
    ensureDir: name => directories.add(name),
    readJson: (name, fallback) => f.files.has(name) ? JSON.parse(f.files.get(name)) : fallback,
    writeJsonAtomic(name, value) { f.commits++; f.files.set(name, JSON.stringify(value)); },
    getOrCreateSecret() { effect(); return Buffer.alloc(32, 7).toString('base64url'); }
  };
  const docker = args => {
    f.probes++;
    if (args[0] === 'version') return { status: 0, stdout: JSON.stringify({ Os: 'linux', Arch: 'amd64', Version: '28.0.0' }) };
    if (args[0] === 'info') return { status: 0, stdout: JSON.stringify({ MemoryLimit: true, PidsLimit: true }) };
    if (args[0] === 'image' && args[1] === 'inspect') return { status: 1, stderr: 'No such image' };
    assert.fail('No Docker mutation belongs to this fixture');
  };
  const sandboxModule = load('providers/agent-sandbox.js', {
    '../audit': writer, '../operation-audit': operation, '../runtime': sandboxRuntime,
  });
  f.sandbox = sandboxModule.createSandboxProvider({
    fs: memoryFs, audit: writer, now: () => 1700000000000,
    authRoot: path.join(virtualRoot, 'auth'), disposableRoot: path.join(virtualRoot, 'disposable'),
    getOrCreateSecret: sandboxRuntime.getOrCreateSecret, runDocker: docker,
    linuxWorkspace: { runDocker: docker }, platform: 'linux',
    onImageBuildStart() { assert.fail('Unrecorded image build must not start'); }
  });
  const { SchedulerAdapterError } = require('../src/lib/scheduler-adapter');
  const taskSpec = { jobId: 'fixture-job', generation: 1, taskName: '\\ToolsEnabled-fixture', name: 'fixture',
    principalId: 'S-1-5-21-111111111-222222222-333333333-1001' };
  let claimed = false;
  const schedulerState = {
    importLegacyScheduler: () => legacy
      ? { status: 'imported', digest: 'd'.repeat(64), path: 'inert-jobs.json',
        legacyTasks: [{ name: 'fixture', schedule: 'daily', createdAtMs: 1700000000000 }] }
      : { status: 'missing' },
    claimSchedulerOutbox() {
      if (claimed || legacy) return { claimed: false };
      claimed = true;
      return { claimed: true, handle: { outboxId: 'outbox', fence: 7 },
        work: { outbox: { outboxId: 'outbox', operation: 'ensure', attempt: 0 }, registration: { jobId: 'fixture-job', generation: 1, spec: taskSpec } } };
    },
    completeSchedulerOutbox(handle, result) {
      assert.equal(handle.fence, 7); f.completions.push(result); return { job: null };
    },
    removeSchedulerJob: () => ({ job: null })
  };
  const schedulerAdapter = {
    ensure(spec, { beforeMutation }) {
      beforeMutation({ operation: 'create', spec }); effect();
      if (f.uncertain) throw new SchedulerAdapterError('SCHEDULER_TEST_UNKNOWN', 'inert unknown result', { uncertain: true });
      return { changed: true, observation: { state: 'present', exact: true } };
    },
    removeLegacy(spec, { beforeMutation }) {
      beforeMutation({ operation: 'delete', observation: { evidenceHash: 'e'.repeat(64) } }); effect();
      return { changed: true };
    }
  };
  const schedulerModule = load('providers/scheduler.js', { '../audit': writer, '../operation-audit': operation });
  f.scheduler = schedulerModule.createSchedulerProvider({
    audit: writer, state: schedulerState, adapter: schedulerAdapter,
    policy: { assertActive: policy.assertActive, load: policy.loadPolicy },
    nodePath: '/virtual/t816-node', runnerPath: '/virtual/t816-job-runner', principalId: taskSpec.principalId,
    principalName: 'ToolsEnabled-Dev', validateAction() { assert.fail('No scheduled external action is invoked'); }
  });
  const home = 'C:\\Users\\ToolsEnabled-Dev', windowsRoot = path.win32.join(home, 'ToolsEnabled');
  const locations = { LOCALAPPDATA: path.win32.join(home, 'AppData', 'Local'), APPDATA: path.win32.join(home, 'AppData', 'Roaming') };
  const workstation = load('providers/workstation.js', {
    '../audit': writer, '../operation-audit': operation, '../policy': policy, 'node:path': path.win32,
    'node:os': { homedir: () => home },
    'node:fs': { existsSync: file => /[\\/]cursor(?:\.cmd|\.exe)$/i.test(file) },
    '../runtime': { ...runtime, ROOT: windowsRoot, run(command, args) {
      f.probes++;
      if (command === 'reg.exe') return { status: f.elevated ? 0 : 1, stdout: f.elevated ? '    REG_SZ RUNASADMIN' : '' };
      assert.ok(command.endsWith('cursor.cmd')); assert.deepEqual(args, ['--reuse-window', windowsRoot]); effect();
      return { status: 0, stdout: '', stderr: '' };
    } }
  }, { ...process, platform: 'win32', env: locations });
  f.workstation = workstation;
  const coordinator = require('../src/lib/coordinator-audit-events');
  const registry = load('tool-registry.js', {
    './operation-audit': operation, './audit': writer, './policy': policy,
    './throughput-mode': { throughputMode: () => 'strict' },
    './coordinator-audit-events': { ...coordinator,
      write: event => writer.record(event.action || 'fixture.registry', event.target || 'fixture', event),
      writeAsync: async event => writer.record(event.action || 'fixture.registry', event.target || 'fixture', event) },
    './controller-tool-meter': { createToolMeterQueue: () => ({ observe() {} }) },
    './providers/agent-sandbox': f.sandbox, './providers/scheduler': f.scheduler, './providers/workstation': workstation
  });
  f.run = (name, args, context = { permissionSession: { origin: 'local', tier: 'full' } }) => registry.executeTool(name, args, context);
  return f;
}
const infrastructureRequests = [
  ['sandbox.auth_profile_create', { account: 'fixture@example.invalid', purpose: 'browser' }, 'sandbox.auth_profile.create.intent'],
  ['scheduler.reconcile', {}, 'scheduler.adapter.intent'],
  ['workstation.launch_cursor', {}, 'workstation.launch_cursor.intent']
];
for (const [name, args, intent] of infrastructureRequests) {
  test('infrastructure audit policy: ' + name + ' keeps Basic free of canonical intent and outcome records', async () => {
    for (const enabled of [undefined, false]) {
      const f = infrastructurePolicyFixture(enabled);
      await f.run(name, args);
      assert.equal(f.effects, 1); assert.deepEqual(f.audits, []);
      if (name.startsWith('sandbox')) assert.equal(f.commits, 2);
      if (name.startsWith('scheduler')) assert.equal(f.completions[0].disposition, 'succeeded');
    }
  });
  test('infrastructure audit policy: ' + name + ' retains required intent and refuses unknown settings', async () => {
    const on = infrastructurePolicyFixture(true);
    await on.run(name, args);
    assert.equal(on.effects, 1);
    assert.equal(on.audits.filter(row => row.action === intent).length, 1);
    const unknown = infrastructurePolicyFixture(false); unknown.unknown = true;
    await assert.rejects(unknown.run(name, args), { code: 'AUDIT_POLICY_INVALID' });
    assert.equal(unknown.effects, 0); assert.equal(unknown.probes, 0); assert.equal(unknown.commits, 0);
  });
  test('infrastructure audit policy: ' + name + ' keeps captured policy through adapter-side changes', async () => {
    for (const enabled of [false, true]) {
      const f = infrastructurePolicyFixture(enabled); f.flip = true;
      await f.run(name, args);
      assert.equal(f.enabled, !enabled); assert.equal(f.effects, 1);
      assert.equal(f.audits.filter(row => row.action === intent).length, enabled ? 1 : 0);
      if (!enabled) assert.deepEqual(f.audits, []);
      else if (name.startsWith('workstation')) assert.equal(f.audits.filter(row => row.action === 'workstation.launch_cursor.result').length, 1);
      else if (name.startsWith('scheduler')) assert.equal(f.audits.filter(row => row.action === 'scheduler.reconcile').length, 1);
    }
  });
}
test('infrastructure audit policy: required provider intents refuse before effect dispatch', async () => {
  for (const [name, args] of infrastructureRequests) {
    const f = infrastructurePolicyFixture(true); f.failAudit = true;
    if (name === 'scheduler.reconcile') {
      const result = await f.run(name, args).catch(error => {
        assert.equal(error.code, 'AUDIT_UNAVAILABLE'); return null;
      });
      if (result) assert.equal(result.outcomes[0].code, 'AUDIT_UNAVAILABLE');
      assert.equal(f.completions[0].disposition, 'retry');
    } else await assert.rejects(f.run(name, args), { code: 'AUDIT_UNAVAILABLE' });
    assert.equal(f.effects, 0); assert.equal(f.commits, 0);
  }
});
test('infrastructure audit policy: legacy scheduler intent and all cleanup results share Basic and required policy', async () => {
  for (const enabled of [false, true]) {
    const f = infrastructurePolicyFixture(enabled, { legacy: true }); f.flip = true;
    const result = await f.run('scheduler.reconcile', {});
    assert.equal(result.legacyCleanup.removed, 1); assert.equal(f.effects, 1);
    assert.equal(f.audits.filter(row => row.action === 'scheduler.legacy.adapter.intent').length, enabled ? 1 : 0);
    if (!enabled) assert.deepEqual(f.audits, []);
    else for (const event of ['scheduler.legacy.cleanup.result', 'scheduler.legacy.cleanup', 'scheduler.reconcile'])
      assert.equal(f.audits.filter(row => row.action === event).length, 1);
  }
});
test('infrastructure audit policy: absent scheduler removal records only when required', async () => {
  for (const enabled of [false, true]) {
    const f = infrastructurePolicyFixture(enabled);
    const result = await f.run('scheduler.remove', { name: 'absent' });
    assert.equal(result.removed, false); assert.equal(result.replayed, true); assert.equal(f.effects, 0);
    assert.equal(f.audits.filter(row => row.action === 'scheduler.remove').length, enabled ? 1 : 0);
    if (!enabled) assert.deepEqual(f.audits, []);
  }
});
test('infrastructure audit policy: required skip-shaped evidence cannot authorize sandbox or scheduler effects', async () => {
  for (const [name, args] of infrastructureRequests.slice(0, 2)) {
    const f = infrastructurePolicyFixture(true); f.badReceipt = true;
    if (name.startsWith('sandbox')) await assert.rejects(f.run(name, args), { code: 'SANDBOX_AUDIT_UNAVAILABLE' });
    else {
      const result = await f.run(name, args);
      assert.equal(result.succeeded, 0); assert.equal(f.completions[0].disposition, 'retry');
      assert.match(f.completions[0].message, /Durable scheduler mutation intent was not recorded/);
    }
    assert.equal(f.effects, 0); assert.equal(f.commits, 0);
  }
});
test('infrastructure audit policy: image preparation retains its canonical anchor under Basic', () => {
  const f = infrastructurePolicyFixture(false); f.failAudit = true;
  assert.throws(() => f.sandbox.prepareImage({ allowBuild: true }), { code: 'AUDIT_UNAVAILABLE' });
  assert.equal(f.audits.filter(row => row.action === 'sandbox.image.prepare.intent').length, 1);
  assert.equal(f.effects, 0); assert.equal(f.commits, 0);
});
test('infrastructure audit policy: ownership, elevation and input refusals remain independent', async () => {
  const f = infrastructurePolicyFixture(false); f.elevated = true;
  await assert.rejects(f.run('workstation.launch_cursor', {}), { code: 'WORKSTATION_CURSOR_ELEVATION_BLOCKED' });
  assert.equal(f.effects, 0); assert.deepEqual(f.audits, []);
  await assert.rejects(f.run('sandbox.auth_profile_create', { account: 'fixture@example.invalid', purpose: 'browser', auditPolicy: { required: false } }),
    error => error.name === 'SchemaValidationError');
  await assert.rejects(f.run('workstation.launch_cursor', {}, { permissionSession: { origin: 'local', tier: 'confined', profile: 'workspace' } }),
    { code: 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED' });
  assert.equal(f.effects, 0);
  assert.throws(() => f.sandbox.revokeAuthProfile({ profileId: 'auth-' + 'a'.repeat(20), confirmProfileId: 'auth-' + 'b'.repeat(20) }),
    { code: 'SANDBOX_CONFIRMATION_MISMATCH' });
});

test('infrastructure audit policy: uncertain scheduler completion preserves custody without replay', async () => {
  for (const enabled of [false, true]) {
    const f = infrastructurePolicyFixture(enabled); f.uncertain = true;
    const result = await f.run('scheduler.reconcile', {});
    assert.equal(result.outcomes[0].outcome, 'uncertain');
    assert.equal(result.outcomes[0].code, 'SCHEDULER_TEST_UNKNOWN');
    assert.equal(f.completions[0].disposition, 'uncertain');
    assert.equal(f.effects, 1); assert.equal(f.completions.length, 1);
    const replay = await f.run('scheduler.reconcile', {});
    assert.equal(replay.processed, 0);
    assert.equal(f.effects, 1); assert.equal(f.completions.length, 1);
    if (!enabled) assert.deepEqual(f.audits, []);
  }
});
test('infrastructure audit policy: Basic never bypasses scheduler or workstation kill switches', async () => {
  for (const name of ['scheduler.reconcile', 'workstation.launch_cursor']) {
    const f = infrastructurePolicyFixture(false); f.killed = true;
    await assert.rejects(f.run(name, {}), { code: 'KILLSWITCH_ACTIVE' });
    assert.equal(f.effects, 0); assert.equal(f.probes, 0); assert.equal(f.commits, 0);
    assert.deepEqual(f.audits, []);
  }
});

// ONE AUDIT-POLICY RESOLUTION PER OPERATION (AE-7).
//
// Every operationAudit call resolves the audit setting for itself, and
// resolving it calls loadSettings() -> loadRegistry(), which stats the 142 KB
// settings catalogue. Engine 8c908d6b caches the PARSE by file stamp, so what
// is still paid per call is the stamp itself: one statSync of
// config/settings-registry.json for every audit call an operation makes. That
// is the measurement below -- and it is also the TOCTOU, because a second
// resolution is a second chance to get a different answer partway through one
// operation. scheduler.js and agent-sandbox.js already capture one frozen
// policy per operation; these three providers did not.
//
// SCOPE THIS CASE DOES NOT CLAIM. The providers are driven here DIRECTLY, which
// is what a caller outside an open operationAudit.withPolicy() scope does.
// tool-registry.js#executeTool() opens such a scope around every MCP dispatch,
// and inside it capturePolicy() returns the AsyncLocalStorage policy without
// touching the registry at all -- so on that path the counts below are already
// zero and this case measures neither a saving nor a race there. What it pins is
// that each provider now resolves once on its own, instead of depending on a
// caller having held a policy open.
test('one local model or advisory operation stamps the settings registry once, not once per audit call', async () => {
  const fs = require('node:fs'), path = require('node:path');
  const registryFile = path.resolve(__dirname, '../config/settings-registry.json');
  const { runtimePolicy } = require('../src/lib/runtime-policy');
  // Warm the parse cache first: this measures re-resolution, not first load.
  runtimePolicy();
  const stamps = async run => {
    const original = fs.statSync;
    let seen = 0;
    fs.statSync = function counted(target, ...rest) {
      if (typeof target === 'string' && path.resolve(target) === registryFile) seen += 1;
      return original.call(this, target, ...rest);
    };
    try { await run(); } finally { fs.statSync = original; }
    return seen;
  };
  assert.equal(await stamps(() => { runtimePolicy(); }), 1, 'one resolution is one stamp, so the count below counts resolutions');

  // model.complete(): the intent, then the transport-failure record.
  const localModel = require('../src/lib/providers/model');
  const decision = { available: true, model: 'luna-cheap-tier', tier: 'cheap', resident: true, reason: 'fixture' };
  const modelStamps = await stamps(async () => {
    await assert.rejects(() => localModel.complete({ prompt: 'one line' }, {
      probe: async () => ({ freeVramBytes: 1, models: [] }),
      pickModel: () => decision,
      state: { recordModelUsage() {} },
      chat: async () => { throw new Error('local transport down'); }
    }), { code: 'MODEL_EXECUTION_FAILED' });
  });
  assert.equal(modelStamps, 1, 'a completion that records an intent and a failure must resolve the audit setting once');

  // OvernightAdvisoryControl._audit(): the intent, then the refusal test.
  const { OvernightAdvisoryControl, OvernightAdvisoryError } = require('../src/lib/providers/overnight-advisory');
  const control = new OvernightAdvisoryControl({
    assertEnabled: () => {},
    state: { submitBoundedTask() { throw new OvernightAdvisoryError('OVERNIGHT_ADVISORY_QUEUE_UNAVAILABLE', 'fixture stops after the audit decision'); } }
  });
  const advisoryStamps = await stamps(() => {
    assert.throws(() => control.submit({
      actor: 'human', idempotencyKey: 'epr-ae7-one-policy-per-operation', title: 'Advisory fixture', prompt: 'Audit policy capture fixture.', acceptanceChecklist: ['one'],
      maxOutputTokens: 64, allowStrong: false
    }), { code: 'OVERNIGHT_ADVISORY_QUEUE_UNAVAILABLE' }, 'the fixture must reach the queue, i.e. past the audit decision');
  });
  assert.equal(advisoryStamps, 1, 'an advisory action must not resolve the audit setting again to decide its own refusal');
});
