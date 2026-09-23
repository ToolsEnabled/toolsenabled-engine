'use strict';

/* THE ENGINE-HONOURED NO-PROVIDER SWITCH.
 *
 * LIMITATIONS-AND-HANDOFF-1.0.41.md section 2.1 records the incident this file
 * exists to make impossible: `tools/agent-dispatch-packaged-qa.mjs` fenced its
 * paid lanes by ENVIRONMENT ONLY -- it handed the bridge child a cut-down PATH
 * and empty home directories and trusted that no provider CLI could be found.
 * On the builder machine one inherited name (npm_config_prefix) survived that
 * fence, `defaultNpmRoots()` resolved the owner's real signed-in @openai/codex
 * install, and a REAL provider worker started from a QA driver.
 *
 * The app-side fence has since been rebuilt as a structural allowlist, and that
 * closes the one name. It does not change the shape of the guarantee: it is
 * still "the provider could not be FOUND", which is a property of the
 * environment the harness managed to construct. This file measures the other
 * shape -- "the engine REFUSED", which is a property of the engine and holds
 * even on a machine where codex and claude are installed, on PATH, and signed
 * in.
 *
 * So every case below deliberately makes the provider RESOLVABLE (an injected
 * resolveCommand that succeeds, an injected claudeCliPresent that answers true)
 * and then asserts the dispatch is refused anyway. A test that let the provider
 * be missing would pass against the defect.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createMissionActions,
  NO_PAID_PROVIDER_ENV,
  noPaidProviderSwitchEnabled,
  laneKindIsProviderFree
} = require('../src/lib/mission-bridge/actions');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');
const { INSTALL_TIER_SESSIONS } = require('../src/lib/permission-tier-policy');

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

/* A machine where the paid providers ARE installed. Everything the engine would
   use to decide "there is nothing to run" is injected to say the opposite, so a
   refusal below can only have come from the switch. */
function installedProviderFixture(t, { processEnv = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'no-paid-provider-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const org = declaredOrg();
  const audit = auditFixture();
  const lanes = [];
  const spawnCalls = [];
  const resolverCalls = [];
  const actions = createMissionActions({
    roots: { isolated: root },
    actor: enabledControllerId(org),
    agentOrg: org,
    audit,
    policy: { assertActive() {} },
    permissionSession: INSTALL_TIER_SESSIONS.unrestricted,
    env: { PATH: process.env.PATH },
    processEnv,
    /* THE PROVIDER IS PRESENT. This is the condition section 2.1 was measured
       under: a real, resolvable, signed-in CLI on the builder's own machine. */
    resolveCommand: (provider, environment) => {
      resolverCalls.push({ provider, environment });
      return { command: process.execPath, prefixArgs: [] };
    },
    claudeCliPresent: () => true,
    ensureMcpConfig: () => {},
    codexArgs: () => ['--no-paid-provider-switch-fixture'],
    claudeArgs: () => ['--no-paid-provider-switch-fixture'],
    resolveLocalNode: async () => ({ runtime: 'ollama', model: 'qwen2.5:7b-instruct', host: '127.0.0.1', port: 11434 }),
    localArgs: () => ['--no-paid-provider-switch-fixture', 'qwen2.5:7b-instruct'],
    laneDependencies: {
      stateFile: path.join(root, 'isolated-state', 'agent-presence.json'),
      mailboxDir: path.join(root, 'isolated-state', 'mailbox'),
      launchDir: path.join(root, 'isolated-state', 'launch'),
      buildOnboardingPacket: () => 'ONBOARDING PACKET STUB (test).\n'
    },
    spawn(...args) { spawnCalls.push(args); throw new Error('this fixture must never spawn a provider'); },
    async runLane(options) {
      lanes.push(options);
      const runId = crypto.randomUUID();
      return {
        runId,
        taskId: 'no-paid-provider-task',
        terminal: {
          agentId: options.agentId, runId, currentTask: 'no-paid-provider-task',
          status: 'finished', exitCode: 0, lastVerdict: 'VERDICT: injected terminal; no provider was contacted'
        }
      };
    }
  });
  return { root, actions, audit, lanes, spawnCalls, resolverCalls };
}

function dispatchInput(tier) {
  return {
    rootId: 'isolated',
    tier,
    objectiveRef: 'no-paid-provider-switch',
    brief: 'Bounded fixture dispatch for the no-paid-provider switch.',
    cap: { kind: 'turns', value: 1, capMs: 60_000 }
  };
}

/* ---------- the refusal itself, for both paid kinds ---------- */

for (const tier of ['luna', 'terra', 'sol', 'claude-fable', 'claude-sonnet', 'claude-opus']) {
  test(`the switch refuses the ${tier} lane on a machine where the provider is installed`, async t => {
    const f = installedProviderFixture(t, { processEnv: { [NO_PAID_PROVIDER_ENV]: '1' } });
    await assert.rejects(
      () => f.actions.dispatch(dispatchInput(tier)),
      error => error?.code === 'BRIDGE_PAID_PROVIDER_DISABLED' && error?.status === 503
    );
    assert.deepEqual(f.spawnCalls, [], 'no provider process was spawned');
    assert.deepEqual(f.lanes, [], 'no lane was executed');
    assert.deepEqual(f.resolverCalls, [], 'the refusal happens before the provider executable is even resolved');
    assert.deepEqual(f.audit.events, [], 'the refusal happens before any launch record is written');
    assert.deepEqual(fs.readdirSync(f.root), [], 'the refusal happens before any durable lane artifact');
  });
}

/* ---------- the positive control: the same fixture WITHOUT the switch ---------- */

test('without the switch the same paid dispatch really does start a lane', async t => {
  const f = installedProviderFixture(t, { processEnv: {} });
  const result = await f.actions.dispatch(dispatchInput('luna'));
  assert.equal(result.ok, true, 'the fixture is capable of a successful paid dispatch');
  assert.equal(f.lanes.length, 1, 'the paid lane executed, so the refusal above is caused by the switch and nothing else');
  assert.equal(f.resolverCalls.length, 1, 'the provider executable was resolved');
  assert.ok(
    f.audit.events.some(event => event.action === 'controller.agent.launch'),
    'a launch record exists without the switch'
  );
});

/* ---------- the switch bounds PAID lanes, it does not disable the product ----------
   A switch that refused everything would pass every assertion above and would
   also make the free local worker unmeasurable, which is exactly the coverage
   the packaged QA driver depends on. */

test('the switch leaves the provider-free local lane dispatchable', async t => {
  const f = installedProviderFixture(t, { processEnv: { [NO_PAID_PROVIDER_ENV]: '1' } });
  const result = await f.actions.dispatch(dispatchInput('local'));
  assert.equal(result.ok, true, 'the free local lane is not a paid provider and must still dispatch');
  assert.equal(result.receipt.kind, 'local');
  assert.equal(f.lanes.length, 1, 'the local lane executed under the switch');
});

/* ---------- fail closed on a kind nobody has thought of yet ---------- */

test('provider-free is an allowlist, so an unknown lane kind counts as paid', () => {
  assert.equal(laneKindIsProviderFree('local'), true);
  assert.equal(laneKindIsProviderFree('codex'), false);
  assert.equal(laneKindIsProviderFree('claude'), false);
  assert.equal(laneKindIsProviderFree('some-provider-added-next-year'), false,
    'a kind this list has never heard of must be treated as paid, not waved through');
  assert.equal(laneKindIsProviderFree(''), false);
  assert.equal(laneKindIsProviderFree(undefined), false);
  assert.equal(laneKindIsProviderFree(null), false);
});

/* ---------- how the switch reads its own value ----------
   The dangerous direction is "someone meant to turn the fence ON and it stayed
   off", so an unrecognised non-empty value turns it ON. Only the explicit
   off-words and an empty value leave it off. */

test('the switch reads its value fail-safe', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ', 'ture', 'enabled']) {
    assert.equal(noPaidProviderSwitchEnabled({ [NO_PAID_PROVIDER_ENV]: value }), true, `"${value}" enables the switch`);
  }
  for (const value of ['', '  ', '0', 'false', 'FALSE', 'no', 'off']) {
    assert.equal(noPaidProviderSwitchEnabled({ [NO_PAID_PROVIDER_ENV]: value }), false, `"${value}" leaves the switch off`);
  }
  assert.equal(noPaidProviderSwitchEnabled({}), false, 'an unset variable leaves the switch off');
  assert.equal(noPaidProviderSwitchEnabled(undefined), false, 'a missing environment leaves the switch off');
  assert.equal(noPaidProviderSwitchEnabled({ [NO_PAID_PROVIDER_ENV]: 1 }), false,
    'a non-string value is not a set environment variable and must not be guessed at');
});

test('the switch variable is named on the product prefix', () => {
  assert.equal(NO_PAID_PROVIDER_ENV, 'TOOLSENABLED_NO_PAID_PROVIDER');
});
