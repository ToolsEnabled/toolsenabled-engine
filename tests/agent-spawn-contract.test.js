'use strict';

const { activate } = require('./lib/isolated-environment');
activate('agent-spawn-contract');

const assert = require('node:assert/strict');
const registry = require('../src/lib/tool-registry');
const {
  confinedWorkspaceRoots, executeTool, getTool, p13PolicyActionCatalog, spawnSubagent
} = registry;
const IDENTITIES = Object.freeze([
  Object.freeze({ agentActor: 'codex', agentId: 'root-alpha' }),
  Object.freeze({ agentActor: 'codex', agentId: 'worker-alpha' }),
  Object.freeze({ agentActor: 'claude', agentId: 'root-beta' }),
  Object.freeze({ agentActor: 'claude', agentId: 'worker-beta' })
]);

const VALID_CONTRACT = [
  'CONTRACT/1',
  'role      IMPLEMENTER',
  'target    src/lib/tool-registry.js',
  'do        add a bounded behavior probe',
  'because   measured zero launch probes',
  'done      a caller observes one launch receipt',
  'report    REPORT-agent-spawn-probe.md'
].join('\n');

async function main() {
  // CONTROL: preserve Node's existing registry-module cache; avoiding all
  // caching would make this pass at the cost of rebuilding the large registry.
  assert.strictEqual(require('../src/lib/tool-registry'), registry);

  const absentMachineRecord = {
    resolveServicesRoot: () => '/fixture/services',
    readMachineRecord: () => null
  };
  assert.deepEqual(confinedWorkspaceRoots({}, { machineRecord: absentMachineRecord }), [],
    'an established missing machine record remains the existing absent answer');

  for (const code of ['EMFILE', 'EAGAIN', 'EIO', 'EBUSY', 'ETIMEDOUT']) {
    const unavailableMachineRecord = {
      resolveServicesRoot: () => '/fixture/services',
      readMachineRecord() {
        const error = new Error(`fixture ${code}`);
        error.code = code;
        throw error;
      }
    };
    assert.throws(
      () => confinedWorkspaceRoots({}, { machineRecord: unavailableMachineRecord }),
      error => error && error.code === 'AGENT_WORKSPACE_ROOTS_COULD_NOT_CHECK'
        && error.machineErrorCode === code
        && /does NOT claim that no workspace roots are configured/.test(error.message)
    );
  }

  const tool = getTool('agent.spawn');
  assert.ok(tool, 'agent.spawn is registered');
  assert.equal(tool.effect, 'local-write');
  const tierHelp = tool.inputSchema.properties.tier.description;
  assert.match(tierHelp, /Codex: astra, luna, terra, sol/);
  assert.match(tierHelp, /Claude: claude-fable, claude-sonnet, claude-opus/);
  assert.match(tierHelp, /not a permission level/);
  assert.match(tierHelp, /Availability is checked at launch/);
  const restartHelp = getTool('agent.restart').description;
  assert.match(restartHelp, /saved brief is submitted as the first turn/);
  assert.match(restartHelp, /not task completion/);
  assert.match(restartHelp, /agent.resume/);
  const policyAction = p13PolicyActionCatalog().find(action => action.name === 'agent.spawn');
  assert.equal(policyAction.policyKind, 'recursive-delegation');
  assert.equal(policyAction.p13Enforced, true);

  const launches = [];
  const launch = async request => {
    launches.push(request);
    return { ok: true, receipt: { launchId: 'launch_fixture_contract_gate' } };
  };

  const malformed = VALID_CONTRACT.replace('done      a caller observes one launch receipt\n', '');
  await assert.rejects(
    spawnSubagent({ contract: malformed, tier: 'luna' }, {}, { launch, apiSheet: '' }),
    error => error && error.code === 'AGENT_CONTRACT_INVALID' && /missing required field: done/.test(error.message)
  );
  assert.equal(launches.length, 0, 'a malformed contract reaches no launcher');

  // Drive the production launch path (no injected launcher) through each of
  // its transport/workspace refusals.  mission-bridge/actions is deliberately
  // lazy-loaded only after these gates, so an unchanged require cache proves
  // that refusal did not even construct the spawning authority.
  const actionsPath = require.resolve('../src/lib/mission-bridge/actions');
  const actionsBefore = require.cache[actionsPath];
  const assertSpawnRefused = async (context, workspaceRoot, expectedCode) => {
    await assert.rejects(
      spawnSubagent({
        contract: VALID_CONTRACT,
        tier: 'luna',
        ...(workspaceRoot === undefined ? {} : { workspaceRoot })
      }, context, { apiSheet: '' }),
      error => error && error.code === expectedCode
    );
    assert.strictEqual(require.cache[actionsPath], actionsBefore,
      `${expectedCode} must refuse before loading or spawning through mission actions`);
  };

  await assertSpawnRefused({ workspaceRoots: ['/verified/workspace'] }, undefined,
    'AGENT_SPAWN_IDENTITY_REQUIRED');
  await assertSpawnRefused({ agentActor: 'codex', agentId: 'root-alpha', workspaceRoots: [] }, undefined,
    'AGENT_SPAWN_WORKSPACE_UNAVAILABLE');
  await assertSpawnRefused({ agentActor: 'codex', agentId: 'root-alpha', workspaceRoots: ['/verified/workspace'] }, '/other/workspace',
    'AGENT_SPAWN_WORKSPACE_REFUSED');

  // Provider and declared organisation identity are separate facts. Keep four
  // dispatches simultaneously in flight and prove the factory receives the
  // exact declared id, with no rewritten organisation projection.
  const actorDispatches = [];
  let releaseDispatches;
  const dispatchHold = new Promise(resolve => { releaseDispatches = resolve; });
  const actorPromises = IDENTITIES.map(identity => {
    let factoryCalls = 0;
    return spawnSubagent({
      contract: VALID_CONTRACT,
      tier: 'local',
      turns: 1,
      timeoutSeconds: 60
    }, {
      agentActor: identity.agentActor,
      agentId: identity.agentId,
      workspaceRoots: ['/verified/workspace'],
      permissionSession: { origin: 'local', tier: 'full' }
    }, {
      apiSheet: '',
      createMissionActions(options) {
        factoryCalls += 1;
        assert.equal(factoryCalls, 1, `${identity.agentId} did not receive one fresh actions object`);
        assert.equal(Object.hasOwn(options, 'agentOrg'), false,
          `${identity.agentId} received a rewritten organisation projection`);
        assert.equal(options.actor, identity.agentId,
          `${identity.agentId} attribution was replaced by its provider label`);
        return new Proxy({
          async dispatch(request) {
            actorDispatches.push({ ...identity, request, options });
            await dispatchHold;
            assert.equal(options.actor, identity.agentId);
            return { ok: true, agentId: identity.agentId };
          }
        }, {
          get(target, property, receiver) {
            assert.equal(property, 'dispatch', `agent.spawn reached the broader mission action ${String(property)}`);
            return Reflect.get(target, property, receiver);
          }
        });
      }
    });
  });
  try {
    assert.equal(actorDispatches.length, IDENTITIES.length, 'not every identity reached one in-flight dispatch');
  } finally {
    releaseDispatches();
  }
  const actorAnswers = await Promise.all(actorPromises);
  assert.deepEqual(actorAnswers, IDENTITIES.map(identity => ({ ok: true, agentId: identity.agentId })));
  assert.deepEqual(actorDispatches.map(entry => entry.agentId), IDENTITIES.map(identity => identity.agentId));
  assert.ok(actorDispatches.every(entry => Object.isFrozen(entry.request)), 'a bounded dispatch request was mutable');

  let constructedForUnboundActor = false;
  await assert.rejects(
    spawnSubagent({ contract: VALID_CONTRACT, tier: 'local' }, {
      agentActor: 'codex',
      workspaceRoots: ['/verified/workspace'],
      permissionSession: { origin: 'local', tier: 'full' }
    }, {
      apiSheet: '',
      createMissionActions() {
        constructedForUnboundActor = true;
        return { dispatch() { throw new Error('must not dispatch'); } };
      }
    }),
    error => error?.code === 'AGENT_SPAWN_IDENTITY_REQUIRED'
  );
  assert.equal(constructedForUnboundActor, false,
    'a provider-only transport reached mission-action construction without a declared identity');

  await assert.rejects(
    executeTool('agent.spawn', { contract: malformed, tier: 'luna' }, {
      permissionSession: { origin: 'local', tier: 'full' }
    }),
    error => error && error.code === 'AGENT_CONTRACT_INVALID'
  );

  const result = await spawnSubagent({
    contract: VALID_CONTRACT,
    tier: 'luna',
    turns: 2,
    timeoutSeconds: 60
  }, {}, { launch, apiSheet: '' });
  assert.equal(result.ok, true);
  assert.equal(launches.length, 1, 'a valid contract reaches the launcher exactly once');
  assert.match(launches[0].brief, /ROLE: IMPLEMENTER/);
  assert.equal(launches[0].cap.value, 2);
  assert.equal(launches[0].cap.capMs, 60_000);

  process.stdout.write('agent.spawn contract gate: malformed paths refused; 4 exact identity dispatches isolated without org projection; valid injected path launched once\n');
}

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
