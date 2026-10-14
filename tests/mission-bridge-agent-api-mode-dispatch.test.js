'use strict';

/* THE AGENT API MODE IS HONOURED BEFORE A LANE IS RECORDED.
 *
 * codexArgs() refuses a standalone Codex lane under Only -- the shipped
 * default -- and under Optimized, and both lane argv builders refuse when the
 * saved mode cannot be read. Those refusals used to be reached only while the
 * argv was being assembled: after the launch record, the executable
 * resolution and the brief and checkpoint files. laneStartupError() then
 * reported them as BRIDGE_AGENT_LANE_START_FAILED ("failed before reaching
 * running state"), so the caller never learned which setting to change, and
 * every Codex dispatch on a default installation left a failed launch behind.
 *
 * Each refused case below makes the provider RESOLVABLE and the audit
 * REQUIRED, so a launch record or an executable lookup would be visible. The
 * positive controls prove the refusal is only the mode's.
 */

const { activate } = require('./lib/isolated-environment');
activate('mission-bridge-agent-api-mode-dispatch');

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const settings = require('../src/lib/settings');
const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
const { INSTALL_TIER_SESSIONS } = require('../src/lib/permission-tier-policy');

const auditChosen = () => ({ values: { 'audit.enabled': true }, provenance: { 'audit.enabled': { source: 'user' } }, rejected: [] });

function saveMode(value) {
  const file = settings.resolveValuesPath({});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ revision: 1, values: { 'agent.agent_api': value },
    provenance: { 'agent.agent_api': { source: 'user', atMs: 1, directive: null } } }));
}

function auditFixture() {
  const events = [];
  return {
    events,
    requireRecord(action, target, details) {
      const event = { sequence: events.length + 1, action, target, details };
      event.eventHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
      events.push(event);
      return { durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash };
    }
  };
}

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api-mode-dispatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const org = declaredOrg();
  const audit = auditFixture();
  const lanes = [];
  const resolverCalls = [];
  const actions = createMissionActions({
    roots: { isolated: root },
    actor: enabledControllerId(org),
    agentOrg: org,
    audit,
    loadSettings: auditChosen,
    policy: { assertActive() {} },
    permissionSession: INSTALL_TIER_SESSIONS.unrestricted,
    env: { PATH: process.env.PATH },
    processEnv: {},
    resolveCommand: provider => {
      resolverCalls.push(provider);
      return { command: process.execPath, prefixArgs: [] };
    },
    claudeCliPresent: () => true,
    claudeCliVersion: async () => null,
    ensureMcpConfig: () => {},
    laneDependencies: {
      stateFile: path.join(root, 'isolated-state', 'agent-presence.json'),
      mailboxDir: path.join(root, 'isolated-state', 'mailbox'),
      launchDir: path.join(root, 'isolated-state', 'launch'),
      buildOnboardingPacket: () => 'ONBOARDING PACKET STUB (test).\n'
    },
    spawn() { throw new Error('this fixture must never spawn a provider'); },
    async runLane(options) {
      lanes.push(options);
      const runId = crypto.randomUUID();
      return {
        runId,
        taskId: 'api-mode-dispatch-task',
        terminal: {
          agentId: options.agentId, runId, currentTask: 'api-mode-dispatch-task',
          status: 'finished', exitCode: 0, lastVerdict: 'VERDICT: injected terminal; no provider was contacted'
        }
      };
    },
    ...overrides
  });
  return { root, actions, audit, lanes, resolverCalls };
}

function dispatchInput(tier) {
  return {
    rootId: 'isolated',
    tier,
    objectiveRef: 'agent-api-mode-dispatch',
    brief: 'Bounded fixture dispatch for the agent API mode refusal.',
    cap: { kind: 'turns', value: 1, capMs: 60_000 }
  };
}

function assertNothingRecorded(f) {
  assert.deepEqual(f.lanes, [], 'no lane was executed');
  assert.deepEqual(f.resolverCalls, [], 'the refusal happens before the provider executable is resolved');
  assert.deepEqual(f.audit.events, [], 'the refusal happens before any launch record is written');
  assert.deepEqual(fs.readdirSync(f.root), [], 'the refusal happens before any brief, checkpoint or lane file');
}

for (const tier of ['astra', 'luna', 'terra', 'sol']) {
  test(`Only refuses the standalone Codex ${tier} lane by name, before anything is recorded`, async t => {
    saveMode('Only');
    const f = fixture(t);
    await assert.rejects(() => f.actions.dispatch(dispatchInput(tier)), error => {
      assert.equal(error?.code, 'BRIDGE_API_ONLY_UNAVAILABLE');
      assert.equal(error?.status, 409);
      assert.match(error.message, /no ToolsEnabled API connection/);
      assert.deepEqual(error.details, { kind: 'codex', agentApiMode: 'Only' });
      return true;
    });
    assertNothingRecorded(f);
  });
}

test('Optimized refuses the standalone Codex lane by name, before anything is recorded', async t => {
  saveMode('Optimized');
  const f = fixture(t);
  await assert.rejects(() => f.actions.dispatch(dispatchInput('luna')), error => {
    assert.equal(error?.code, 'AGENT_OPTIMIZED_TOOLS_UNSUPPORTED');
    assert.equal(error?.status, 409);
    assert.match(error.message, /Optimized works with Claude only/);
    return true;
  });
  assertNothingRecorded(f);
});

for (const tier of ['luna', 'claude-sonnet']) {
  test(`an unreadable mode refuses the ${tier} lane as unreadable, before anything is recorded`, async t => {
    saveMode('not-a-mode');
    const f = fixture(t);
    await assert.rejects(() => f.actions.dispatch(dispatchInput(tier)), error => {
      assert.equal(error?.code, 'AGENT_API_MODE_UNAVAILABLE');
      assert.equal(error?.status, 503);
      assert.match(error.message, /Agent API setting could not be read/);
      return true;
    });
    assertNothingRecorded(f);
  });
}

test('a mode changed after the early check still reaches the caller by name', async t => {
  // The argv builder is the last reader of the setting. Simulate the setting
  // moving to Only between the early check and the argv.
  saveMode('Enabled');
  const f = fixture(t, {
    codexArgs: () => {
      const error = new Error('This standalone Codex lane has no ToolsEnabled API connection. Start an app-managed agent session for API-only work.');
      error.code = 'BRIDGE_API_ONLY_UNAVAILABLE';
      error.agentApiMode = 'Only';
      throw error;
    }
  });
  await assert.rejects(() => f.actions.dispatch(dispatchInput('luna')), error => {
    assert.equal(error?.code, 'BRIDGE_API_ONLY_UNAVAILABLE', 'not the generic BRIDGE_AGENT_LANE_START_FAILED');
    assert.equal(error?.status, 409);
    assert.match(error.message, /no ToolsEnabled API connection/);
    assert.deepEqual(error.details, { kind: 'codex', agentApiMode: 'Only' });
    return true;
  });
});

/* ---------- positive controls ---------- */

test('Enabled dispatches the same Codex lane through the real argv builder', async t => {
  saveMode('Enabled');
  const f = fixture(t);
  const result = await f.actions.dispatch(dispatchInput('luna'));
  assert.equal(result.ok, true);
  assert.equal(f.lanes.length, 1, 'the refusals above are the mode, not the fixture');
  assert.ok(f.lanes[0].childArgs.includes('exec'));
  assert.ok(f.audit.events.some(event => event.action === 'controller.agent.launch'));
});

test('Only still dispatches a Claude lane, whose argv carries the Only bound', async t => {
  saveMode('Only');
  const f = fixture(t);
  const result = await f.actions.dispatch(dispatchInput('claude-sonnet'));
  assert.equal(result.ok, true);
  assert.equal(f.lanes.length, 1);
  const args = f.lanes[0].childArgs;
  assert.equal(args[args.indexOf('--tools') + 1], '', 'Only removes native tools from the Claude lane');
});
