'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const agentOrg = require('../src/lib/agent-org');
const { createMissionActions } = require('../src/lib/mission-bridge/actions');
const { INSTALL_TIER_SESSIONS } = require('../src/lib/permission-tier-policy');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

const input = {
  rootId: 'repo', tier: 'luna', objectiveRef: 'Q1', brief: 'bounded',
  cap: { kind: 'turns', value: 1, capMs: 1000 }
};

function fixture() {
  const initial = declaredOrg();
  const actor = enabledControllerId(initial);
  let installed = initial;
  const reads = [];
  const launches = [];
  const forbiddenEffects = [];
  const forbid = name => () => { forbiddenEffects.push(name); throw new Error(`unexpected ${name}`); };
  const actions = createMissionActions({
    roots: { repo: path.resolve(__dirname, '..') },
    actor,
    permissionSession: INSTALL_TIER_SESSIONS.unrestricted,
    policy: { assertActive() {} }, env: { PATH: process.env.PATH },
    readDeclaredOrgContext() {
      reads.push(installed);
      return { org: installed, knownRoles: undefined };
    },
    createLaunch(request, dependencies) {
      launches.push({ request, org: dependencies.org });
      throw Object.assign(new Error('fixture stops before the durable launch'), { code: 'FIXTURE_LAUNCH_BOUNDARY' });
    },
    audit: { requireRecord: forbid('audit') },
    resolveCommand: forbid('provider discovery'), spawn: forbid('spawn'), runLane: forbid('lane')
  });
  return { initial, actor, actions, reads, launches, forbiddenEffects,
    install(next) { installed = next; } };
}

test('dispatch admits an unchanged actor and lane against the latest installed org', async () => {
  const f = fixture();
  const current = agentOrg.normalizeOrg({ ...f.initial, revision: f.initial.revision + 1 });
  f.install(current);
  await assert.rejects(() => f.actions.dispatch(input), error => error?.code === 'FIXTURE_LAUNCH_BOUNDARY');
  assert.equal(f.launches.length, 1, 'the admitted dispatch reaches the durable-launch boundary exactly once');
  assert.equal(f.launches[0].request.requestingActor, f.actor);
  assert.equal(f.launches[0].request.targetAgentId, 'luna');
  assert.equal(f.launches[0].org, current, 'the launch consumes fresh authority, not the construction snapshot');
  assert.equal(f.reads.at(-1), current);
  assert.deepEqual(f.forbiddenEffects, [], 'the fixture never contacts a provider or writes an audit record');
});

test('a lane removed after startup is refused before any launch side effect', async () => {
  const f = fixture();
  const current = agentOrg.normalizeOrg({
    ...f.initial, revision: f.initial.revision + 1,
    agents: f.initial.agents.filter(agent => agent.id !== 'luna'),
    relationships: f.initial.relationships.filter(relation => relation.from !== 'luna' && relation.to !== 'luna')
  });
  f.install(current);
  await assert.rejects(() => f.actions.dispatch(input), error => error?.code === 'BRIDGE_AGENT_DECLARATION_MISSING');
  assert.equal(f.reads.at(-1), current, 'dispatch re-reads installed authority without prescribing a guard count');
  assert.deepEqual(f.launches, []);
  assert.deepEqual(f.forbiddenEffects, []);
});

test('an actor disabled after startup cannot borrow the retained controller identity', async () => {
  const f = fixture();
  const current = agentOrg.normalizeOrg({
    ...f.initial, revision: f.initial.revision + 1,
    agents: f.initial.agents.map(agent => agent.id === f.actor ? { ...agent, enabled: false } : agent)
  });
  f.install(current);
  await assert.rejects(() => f.actions.dispatch(input), error => error?.code === 'BRIDGE_ACTOR_REFUSED');
  assert.equal(f.reads.at(-1), current);
  assert.deepEqual(f.launches, []);
  assert.deepEqual(f.forbiddenEffects, []);
});
