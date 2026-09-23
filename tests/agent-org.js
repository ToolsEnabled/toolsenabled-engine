// EXECUTABLE CHANGE
// Test-can-fail audit (testcanfail-tests-agent-org-js):
// - VACUOUS COLLECTIONS strengthened below: enabled implementation workers,
//   Gemini allowed models, and the exported default-role vocabulary now have
//   explicit non-empty witnesses before their per-entry assertions.
// - Mutation: exported ROLES as an empty array. RED:
//     AssertionError [ERR_ASSERTION]: the default-role posture invariant must exercise at least one shipped role
// - Mutation: made modelFloor.allowedUnion() return an empty array (with an
//   empty providerPolicy mirror in the scratch fixture). RED:
//     AssertionError [ERR_ASSERTION]: the flash-tier invariant must exercise at least one allowed Gemini model
// - Mutation: removed every enabled implementation seat from the normalized
//   scratch org. RED:
//     AssertionError [ERR_ASSERTION]: the provider invariant must exercise at least one enabled implementation seat
// - NOT-FOUND: exit-status/truthy process evidence; swallowed try/catch or
//   optional-chain failures; mocks of the subject; file-wide skips or silent
//   platform guards; expected values computed by the same implementation.
// - PRECONDITION-NOT-MET: this checkout has no excluded
//   config/agent-org.json, so the complete file stops at ENOENT before the
//   audited late assertions. The source mutations were restored byte-for-byte;
//   the unmutated command's exact terminal result is recorded in the final
//   report rather than misrepresented here as a green run.
// Declared agent-organisation model tests.
// Deterministic and offline: no state store, no MCP server, no provider.

'use strict';

const assert = require('node:assert');
const org = require('../src/lib/agent-org');

let checks = 0;
// A failing check must NAME ITSELF. This helper used to discard its label
// (`void label`), so a red run printed only "Expected values to be strictly
// equal" and a stack -- true, and useless for working out which invariant
// broke. Mutation testing made the cost concrete: several planted defects were
// caught but could not be attributed to the check that caught them.
const check = (label, fn) => {
  try {
    fn();
  } catch (error) {
    error.message = `[${label}] ${error.message}`;
    // The stack, not the message, is what a failed run PRINTS, and for a
    // generated assertion message node has already composed it. Naming only
    // the message leaves the printed failure anonymous.
    if (typeof error.stack === `string`) error.stack = `[${label}] ${error.stack}`;
    throw error;
  }
  checks += 1;
};
const throwsCode = (fn, code, label) => {
  assert.throws(fn, error => error.code === code, `${label}: expected ${code}`);
};

const CLAUDE = { id: 'claude', displayName: 'Claude', role: 'controller', provider: 'claude', enabled: true };
const LUNA = { id: 'luna', displayName: 'Luna', role: 'builder', provider: 'codex', enabled: true };
const TERRA = { id: 'terra', displayName: 'Terra', role: 'reviewer', provider: 'gemini', enabled: true };
const ASSISTANT = {
  id: 'codex-assistant', displayName: 'Codex assistant',
  role: 'coordinator-assistant', provider: 'codex', enabled: true
};

const baseOrg = () => ({
  revision: 1,
  agents: [{ ...CLAUDE }, { ...LUNA }, { ...TERRA }],
  relationships: [
    { from: 'claude', to: 'luna', type: 'manages' },
    { from: 'claude', to: 'terra', type: 'manages' },
    { from: 'terra', to: 'luna', type: 'reviews' }
  ]
});

// A controller plus (count - 1) workers, each managed by it. Used to press on
// the declared-org SIZE bound, which is a document guard and not an account or
// concurrency limit -- see the note above resolveMaxAgents in the subject.
const bigOrg = count => {
  const agents = [{ ...CLAUDE }];
  const relationships = [];
  for (let i = 1; i < count; i += 1) {
    const id = `w-${i}`;
    agents.push({ id, displayName: `Worker ${i}`, role: 'worker', provider: 'claude', enabled: true });
    relationships.push({ from: 'claude', to: id, type: 'manages' });
  }
  return { revision: 1, agents, relationships };
};

check('the declared-org size bound still defaults to 64, so no install changes silently', () => {
  assert.strictEqual(org.DEFAULT_MAX_AGENTS, 64);
  assert.strictEqual(org.normalizeOrg(bigOrg(64)).agents.length, 64, 'exactly the default is accepted');
  throwsCode(() => org.normalizeOrg(bigOrg(65)), 'AGENT_ORG_INVALID', 'one past the default');
});

check('64 is no longer a hard ceiling: the bound is raisable and removable per call', () => {
  assert.strictEqual(org.normalizeOrg(bigOrg(65), { maxAgents: 100 }).agents.length, 65);
  assert.strictEqual(org.normalizeOrg(bigOrg(200), { maxAgents: 0 }).agents.length, 200, '0 removes the bound');
  assert.strictEqual(org.normalizeOrg(bigOrg(65), { maxAgents: 'unlimited' }).agents.length, 65);
  throwsCode(() => org.normalizeOrg(bigOrg(65), { maxAgents: 64 }), 'AGENT_ORG_INVALID',
    'an explicitly lower bound is still enforced');
});

check('MC_MAX_AGENTS configures the bound for the call sites that pass no options', () => {
  const previous = process.env.MC_MAX_AGENTS;
  try {
    process.env.MC_MAX_AGENTS = '128';
    assert.strictEqual(org.resolveMaxAgents(), 128);
    assert.strictEqual(org.normalizeOrg(bigOrg(65)).agents.length, 65, 'the environment lifts the default');
    process.env.MC_MAX_AGENTS = 'unlimited';
    assert.strictEqual(org.resolveMaxAgents(), null, 'unlimited removes the bound entirely');
    assert.strictEqual(org.resolveMaxAgents({ maxAgents: 10 }), 10, 'an explicit option outranks the environment');
    process.env.MC_MAX_AGENTS = 'seventy';
    throwsCode(() => org.normalizeOrg(bigOrg(3)), 'AGENT_ORG_INVALID',
      'an unparseable bound is refused loudly, never ignored back to the default');
  } finally {
    if (previous === undefined) delete process.env.MC_MAX_AGENTS;
    else process.env.MC_MAX_AGENTS = previous;
  }
  if (previous === undefined) {
    assert.strictEqual(org.resolveMaxAgents(), org.DEFAULT_MAX_AGENTS, 'the default is restored after the probe');
  }
});

// --- a minimal declared arrangement -----------------------------------------

check('the declared arrangement normalises: one controller directs the builders', () => {
  const model = org.normalizeOrg(baseOrg());
  assert.strictEqual(model.agents.length, 3);
  assert.strictEqual(org.managerOf(model, 'luna'), 'claude');
  assert.deepStrictEqual(org.reportsOf(model, 'claude').sort(), ['luna', 'terra']);
  assert.strictEqual(org.managerOf(model, 'claude'), null, 'the controller has no manager');
});

check('supervisor is an orthogonal classifier derived from management edges', () => {
  const model = org.normalizeOrg(baseOrg());
  assert.deepStrictEqual([...org.CLASSIFIERS], ['supervisor']);
  assert.strictEqual(org.isSupervisor(model, 'claude'), true);
  assert.deepStrictEqual([...org.classifiersOf(model, 'claude')], ['supervisor']);
  assert.deepStrictEqual(org.classifyAgent(model, 'claude'), {
    agentId: 'claude', role: 'controller', classifiers: ['supervisor']
  });
  assert.strictEqual(org.isSupervisor(model, 'luna'), false);
  throwsCode(() => org.managerOf(model, 'nobody'), 'AGENT_ORG_UNKNOWN_AGENT', 'unknown agent manager');
  throwsCode(() => org.reportsOf(model, 'nobody'), 'AGENT_ORG_UNKNOWN_AGENT', 'unknown agent reports');
  throwsCode(() => org.classifiersOf(model, 'nobody'), 'AGENT_ORG_UNKNOWN_AGENT', 'unknown agent classifiers');
  throwsCode(() => org.isSupervisor(model, 'nobody'), 'AGENT_ORG_UNKNOWN_AGENT', 'unknown agent supervisor status');
  throwsCode(() => org.classifyAgent(model, 'nobody'), 'AGENT_ORG_UNKNOWN_AGENT', 'unknown agent classification');
});

check('an agent keeps its role while also becoming a supervisor', () => {
  const declared = baseOrg();
  declared.agents.push({ id: 'review-two', displayName: 'Review two', role: 'reviewer', provider: 'codex', enabled: true });
  declared.relationships.push({ from: 'terra', to: 'review-two', type: 'manages' });
  const model = org.normalizeOrg(declared);
  assert.strictEqual(model.agents.find(agent => agent.id === 'terra').role, 'reviewer');
  assert.strictEqual(org.isSupervisor(model, 'terra'), true);
  assert.deepStrictEqual(org.classifyAgent(model, 'terra'), {
    agentId: 'terra', role: 'reviewer', classifiers: ['supervisor']
  });
});

check('the model states it is declared and grants no authority', () => {
  const model = org.normalizeOrg(baseOrg());
  assert.strictEqual(model.stateKind, 'declared');
  assert.strictEqual(model.grantsAuthority, false);
});

check('content hash is stable across equal models and changes on edit', () => {
  const a = org.normalizeOrg(baseOrg());
  const b = org.normalizeOrg(baseOrg());
  assert.strictEqual(a.contentHash, b.contentHash);
  const edited = baseOrg();
  edited.agents[1].enabled = false;
  assert.notStrictEqual(org.normalizeOrg(edited).contentHash, a.contentHash);
});

check('revision is independent of content hash', () => {
  const a = org.normalizeOrg(baseOrg());
  const bumped = { ...baseOrg(), revision: 9 };
  const b = org.normalizeOrg(bumped);
  assert.strictEqual(a.contentHash, b.contentHash, 'same content, same hash');
  assert.strictEqual(b.revision, 9);
});

// --- structural invariants ---------------------------------------------------

check('a management cycle is rejected', () => {
  const cyclic = baseOrg();
  cyclic.relationships.push({ from: 'luna', to: 'claude', type: 'manages' });
  throwsCode(() => org.normalizeOrg(cyclic), 'AGENT_ORG_CYCLE', 'cycle');
});

check('a longer management cycle is rejected', () => {
  const cyclic = {
    revision: 1,
    agents: [{ ...CLAUDE }, { ...LUNA }, { ...TERRA }],
    relationships: [
      { from: 'claude', to: 'luna', type: 'manages' },
      { from: 'luna', to: 'terra', type: 'manages' },
      { from: 'terra', to: 'claude', type: 'manages' }
    ]
  };
  throwsCode(() => org.normalizeOrg(cyclic), 'AGENT_ORG_CYCLE', 'three-node cycle');
});

check('self-management is rejected', () => {
  const selfish = baseOrg();
  selfish.relationships.push({ from: 'luna', to: 'luna', type: 'manages' });
  throwsCode(() => org.normalizeOrg(selfish), 'AGENT_ORG_SELF_RELATION', 'self relation');
});

check('two managers for one agent is rejected', () => {
  const ambiguous = baseOrg();
  ambiguous.relationships.push({ from: 'terra', to: 'luna', type: 'manages' });
  throwsCode(() => org.normalizeOrg(ambiguous), 'AGENT_ORG_MULTIPLE_MANAGERS', 'two managers');
});

check('zero controllers is rejected', () => {
  const headless = baseOrg();
  headless.agents[0].role = 'builder';
  throwsCode(() => org.normalizeOrg(headless), 'AGENT_ORG_NO_CONTROLLER', 'no controller');
});

check('two controllers is rejected', () => {
  const twoHeads = baseOrg();
  twoHeads.agents[1].role = 'controller';
  throwsCode(() => org.normalizeOrg(twoHeads), 'AGENT_ORG_MULTIPLE_CONTROLLERS', 'two controllers');
});

check('a relationship naming an unknown agent is rejected', () => {
  const dangling = baseOrg();
  dangling.relationships.push({ from: 'claude', to: 'ghost', type: 'manages' });
  throwsCode(() => org.normalizeOrg(dangling), 'AGENT_ORG_UNKNOWN_AGENT', 'dangling');
});

check('duplicate agent ids are rejected', () => {
  const dupe = baseOrg();
  dupe.agents.push({ ...LUNA });
  throwsCode(() => org.normalizeOrg(dupe), 'AGENT_ORG_DUPLICATE_AGENT', 'duplicate agent');
});

check('duplicate relationships are rejected', () => {
  const dupe = baseOrg();
  dupe.relationships.push({ from: 'claude', to: 'luna', type: 'manages' });
  throwsCode(() => org.normalizeOrg(dupe), 'AGENT_ORG_DUPLICATE_RELATION', 'duplicate relation');
});

check('a non-manages cycle is allowed — reviews may be mutual', () => {
  const mutual = baseOrg();
  mutual.relationships.push({ from: 'luna', to: 'terra', type: 'reviews' });
  const model = org.normalizeOrg(mutual);
  assert.strictEqual(model.relationships.length, 4);
});

// --- field validation --------------------------------------------------------

check('an unknown role is rejected', () => {
  const bad = baseOrg();
  bad.agents[1].role = 'overlord';
  throwsCode(() => org.normalizeOrg(bad), 'AGENT_ORG_INVALID', 'role');
});

check('runtime registries cannot extend the fixed functional role vocabulary', () => {
  const declared = baseOrg();
  declared.agents[1].role = 'release-captain';
  const registry = { hasRole: role => role === 'release-captain' };
  throwsCode(() => org.normalizeOrg(declared), 'AGENT_ORG_INVALID', 'unregistered role');
  throwsCode(() => org.normalizeOrg(declared, { customRoleRegistry: registry }), 'AGENT_ORG_INVALID', 'registry cannot add a role');
});

check('the coordinator assistant role is valid but cannot claim implementation phases', () => {
  const declared = baseOrg();
  declared.agents.push({ ...ASSISTANT });
  declared.relationships.push({ from: 'claude', to: 'codex-assistant', type: 'manages' });
  const model = org.normalizeOrg(declared);
  assert.strictEqual(org.managerOf(model, 'codex-assistant'), 'claude');
  assert.strictEqual(org.mayClaim(model, 'codex-assistant', 'Q21'), false);
});

check('an unknown provider is rejected', () => {
  const bad = baseOrg();
  bad.agents[1].provider = 'somethingelse';
  throwsCode(() => org.normalizeOrg(bad), 'AGENT_ORG_INVALID', 'provider');
});

check('enabled must be explicit — an unknown state is not a default', () => {
  const bad = baseOrg();
  delete bad.agents[1].enabled;
  throwsCode(() => org.normalizeOrg(bad), 'AGENT_ORG_INVALID', 'enabled');
});

check('a malformed phase id is rejected', () => {
  const bad = baseOrg();
  bad.agents[1].assignedPhase = 'not-a-phase';
  throwsCode(() => org.normalizeOrg(bad), 'AGENT_ORG_INVALID', 'assignedPhase');
});

check('an unknown phase is rejected when the queue phase list is supplied', () => {
  const model = baseOrg();
  model.agents[1].assignedPhase = 'Q99';
  throwsCode(() => org.normalizeOrg(model, { knownPhases: ['Q21', 'Q23'] }), 'AGENT_ORG_UNKNOWN_PHASE', 'unknown phase');
  model.agents[1].assignedPhase = 'Q23';
  assert.ok(org.normalizeOrg(model, { knownPhases: ['Q21', 'Q23'] }));
});

check('phase validation is skipped when the caller cannot supply the phase list', () => {
  const model = baseOrg();
  model.agents[1].assignedPhase = 'Q99';
  assert.ok(org.normalizeOrg(model), 'unchecked beats wrongly rejected');
});

check('a repeated phase in a priority list is rejected', () => {
  const bad = baseOrg();
  bad.agents[1].phasePriority = ['Q21', 'Q21'];
  throwsCode(() => org.normalizeOrg(bad), 'AGENT_ORG_INVALID', 'repeat priority');
});

check('secret-shaped display names are rejected with a distinct code', () => {
  const leak = baseOrg();
  // Passes the display-name character rule, so only the secret check catches it.
  leak.agents[1].displayName = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  throwsCode(() => org.normalizeOrg(leak), 'AGENT_ORG_SECRET_REJECTED', 'secret display name');
});

check('a display name with illegal characters is rejected separately', () => {
  const bad = baseOrg();
  bad.agents[1].displayName = 'Luna\n<script>';
  throwsCode(() => org.normalizeOrg(bad), 'AGENT_ORG_INVALID', 'display name shape');
});

check('the model is bounded', () => {
  const many = { revision: 1, agents: [{ ...CLAUDE }], relationships: [] };
  for (let index = 0; index < 64; index += 1) {
    many.agents.push({ id: `w${index}`, displayName: `W${index}`, role: 'worker', provider: 'none', enabled: true });
  }
  throwsCode(() => org.normalizeOrg(many), 'AGENT_ORG_INVALID', 'agent cap');
});

// --- claim eligibility -------------------------------------------------------

check('a disabled agent may claim nothing', () => {
  const model = baseOrg();
  model.agents[1].enabled = false;
  const normalized = org.normalizeOrg(model);
  assert.strictEqual(org.mayClaim(normalized, 'luna', 'Q21'), false);
});

check('an agent with no priority list is unrestricted', () => {
  const normalized = org.normalizeOrg(baseOrg());
  assert.strictEqual(org.mayClaim(normalized, 'luna', 'Q21'), true);
  assert.strictEqual(org.mayClaim(normalized, 'luna', 'Q23'), true);
});

check('an agent with a priority list is limited to it', () => {
  const model = baseOrg();
  model.agents[1].phasePriority = ['Q23', 'Q21'];
  const normalized = org.normalizeOrg(model);
  assert.strictEqual(org.mayClaim(normalized, 'luna', 'Q23'), true);
  assert.strictEqual(org.mayClaim(normalized, 'luna', 'Q18'), false);
});

check('an unknown agent may claim nothing', () => {
  const normalized = org.normalizeOrg(baseOrg());
  assert.strictEqual(org.mayClaim(normalized, 'nobody', 'Q21'), false);
});

// --- R95: this file's providerPolicy is a MIRROR, not an authority ----------
//
// config/agent-org.json used to declare its own Gemini allowedModels list and
// its own note admitted "this policy is still read by no code path" -- a floor
// nothing reads is not a floor, and it drifted into contradicting both
// STANDING-ORDERS.md and the live fleet. These checks live in this already-
// registered suite on purpose: a check that only runs when someone remembers
// to run it is the same failure it exists to catch.

const fs = require('node:fs');
const path = require('node:path');

// The checked-in org is a portable declaration, not a snapshot of one
// builder's controller or subscription state. Transport actors receive a
// dispatch-only projection at spawn time; the durable declaration stays
// neutral and exposes reusable provider seats underneath it.
check('the checked-in declared org keeps a neutral controller and the full shared worker pools', () => {
  const declared = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'agent-org.json'), 'utf8'));
  const model = org.normalizeOrg(declared);
  const controller = model.agents.filter(agent => agent.role === 'controller');
  assert.deepStrictEqual(controller.map(agent => agent.id), ['controller']);
  assert.strictEqual(controller[0].provider, 'none', 'the durable controller must not claim a client provider');
  assert.strictEqual(controller[0].enabled, true);
  assert.strictEqual(org.isSupervisor(model, 'controller'), true,
    'the neutral controller is a supervisor because it manages the declared seats');
  assert.deepStrictEqual(org.classifyAgent(model, 'controller'), {
    agentId: 'controller', role: 'controller', classifiers: ['supervisor']
  });
  assert.strictEqual(org.managerOf(model, 'controller'), null, 'the neutral controller is the declared root');

  const IMPLEMENTATION_PROVIDERS = [...new Set(
    Object.values(require('../src/lib/mission-bridge/actions').TIERS).map(tier => tier.provider)
  )];
  const implementationWorkers = model.agents.filter(agent => agent.id !== 'controller');
  assert.ok(implementationWorkers.length > 0, 'the neutral declaration must expose at least one worker seat');
  for (const worker of implementationWorkers) {
    assert.strictEqual(worker.enabled, true, `${worker.id} must be available for an authenticated spawn projection`);
    assert.strictEqual(worker.role, 'builder', `${worker.id} must remain a dispatchable builder seat`);
    assert.ok(IMPLEMENTATION_PROVIDERS.includes(worker.provider),
      `${worker.id} is an enabled implementation seat on provider "${worker.provider}"; implementation seats must be one the mission bridge can dispatch to (${IMPLEMENTATION_PROVIDERS.join(', ')})`);
    assert.strictEqual(org.managerOf(model, worker.id), 'controller', `${worker.id} must report to the neutral controller`);
  }

  const claudeSeats = implementationWorkers
    .filter(agent => agent.provider === 'claude')
    .map(agent => agent.id)
    .sort();
  assert.deepStrictEqual(claudeSeats, ['claude-1', 'claude-2', 'claude-3', 'claude-4']);
  assert.strictEqual(model.agents.some(agent => agent.id === 'claude'), false,
    'a provider principal name must not double as one pooled worker seat');
  assert.deepStrictEqual([...org.reportsOf(model, 'controller')].sort(),
    implementationWorkers.map(agent => agent.id).sort(),
    'every declared worker pool seat must be managed by the neutral controller');
  assert.strictEqual(model.stateKind, 'declared');
  assert.strictEqual(model.grantsAuthority, false);
});

check('the neutral checked-in declaration carries no persistent escalation authority', () => {
  const declared = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'agent-org.json'), 'utf8'));
  const model = org.normalizeOrg(declared);
  assert.deepStrictEqual(model.relationships.filter(edge => edge.type === 'escalates_to'), []);
});

check('the portable org does not duplicate provider policy', () => {
  const declared = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'agent-org.json'), 'utf8'));
  assert.strictEqual(Object.hasOwn(declared, 'providerPolicy'), false,
    'model policy belongs to config/model-floor.json, not the portable org declaration');
});

check('the neutral Sol seat is an ordinary enabled Codex builder', () => {
  const declared = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'agent-org.json'), 'utf8'));
  const sol = declared.agents.find(entry => entry.id === 'sol');
  assert.ok(sol, 'the shared Codex worker pool must retain the Sol seat');
  assert.strictEqual(sol.enabled, true);
  assert.strictEqual(sol.role, 'builder');
  assert.strictEqual(sol.provider, 'codex');
  assert.strictEqual(Object.hasOwn(sol, 'scopeActivation'), false);
});


// --- custom roles in the declared org ----------------------------------------
//
// A custom role is the operator's own vocabulary, so the questions worth pinning
// are not "does it round-trip" but "what may it be named" and "what may it do".

// Every org needs exactly one controller, so when the SUBJECT is the controller
// the root seat steps down to manager rather than the org carrying two.
function orgWithRole(role, knownRoles) {
  return org.normalizeOrg({
    revision: 1,
    agents: [
      { id: 'root', displayName: 'Root', role: role === 'controller' ? 'manager' : 'controller', provider: 'none', enabled: true },
      { id: 'subject', displayName: 'Subject', role, provider: 'none', enabled: true }
    ],
    relationships: [{ from: 'root', to: 'subject', type: 'manages' }]
  }, knownRoles === undefined ? {} : { knownRoles });
}

const capabilities = overrides => ({
  orgRoot: false,
  singleSeat: false,
  mayClaimWork: false,
  mayWakeReports: false,
  requiresMutationContext: false,
  ...overrides
});

check('an org refuses a custom role by default, and accepts it once declared', () => {
  throwsCode(() => orgWithRole('night-shift'), 'AGENT_ORG_INVALID', 'undeclared custom role');
  const built = orgWithRole('night-shift', [{ id: 'night-shift', baseDefaultRole: 'builder' }]);
  assert.strictEqual(built.agents.find(entry => entry.id === 'subject').role, 'night-shift');
});

check('a custom role based on a read-only role cannot claim work', () => {
  // The escalation this prevents: copy `observer`, give the copy a new name,
  // and the copy would otherwise carry observer's description with a builder's
  // power -- while being the role the operator actually assigned.
  const watcher = orgWithRole('watcher', [{ id: 'watcher', baseDefaultRole: 'observer' }]);
  assert.strictEqual(org.mayClaim(watcher, 'subject', 'Q1'), false);
  assert.strictEqual(org.roleMayAct(watcher, 'watcher'), false);
  const nightShift = orgWithRole('night-shift', [{ id: 'night-shift', baseDefaultRole: 'builder' }]);
  assert.strictEqual(org.mayClaim(nightShift, 'subject', 'Q1'), true);
  assert.strictEqual(org.roleMayAct(nightShift, 'night-shift'), true);
});

check('a custom role with no declared base cannot claim work (fail closed)', () => {
  const freeform = orgWithRole('freeform', [{ id: 'freeform', baseDefaultRole: null }]);
  assert.strictEqual(org.mayClaim(freeform, 'subject', 'Q1'), false);
  assert.strictEqual(org.roleMayAct(freeform, 'freeform'), false);
});

check('mayClaim fails closed on an org carrying no derived posture map', () => {
  // Anything not produced by normalizeOrg -- a hand-built object, a structure
  // revived from JSON -- must not become a way to claim under a custom role.
  const built = orgWithRole('night-shift', [{ id: 'night-shift', baseDefaultRole: 'builder' }]);
  assert.strictEqual(org.mayClaim({
    ...built,
    claimPostureByRole: undefined,
    roleCapabilitiesByRole: undefined
  }, 'subject', 'Q1'), false);
});

check('built-in role ids do not recover authority from a missing or malformed capability map', () => {
  const built = orgWithRole('builder');
  const missing = { ...built, roleCapabilitiesByRole: undefined };
  assert.strictEqual(org.roleHasCapability(missing, 'controller', 'orgRoot'), false,
    'the controller id is not a fallback proof of root authority');
  assert.strictEqual(org.mayClaim(missing, 'subject', 'Q1'), false,
    'the builder id is not a fallback proof of claim authority');

  const partial = {
    ...built,
    roleCapabilitiesByRole: {
      controller: { orgRoot: true },
      builder: { mayClaimWork: true }
    }
  };
  assert.strictEqual(org.roleHasCapability(partial, 'controller', 'orgRoot'), false,
    'a forged partial root record fails closed');
  assert.strictEqual(org.mayClaim(partial, 'subject', 'Q1'), false,
    'a forged partial claim record fails closed');
});

check('a custom role may not take a reserved not-an-agent identifier', () => {
  for (const reserved of org.RESERVED_ROLE_IDS) {
    throwsCode(() => orgWithRole(reserved, [{ id: reserved, baseDefaultRole: 'builder' }]),
      'AGENT_ORG_RESERVED_ROLE', `reserved role id "${reserved}"`);
  }
  assert.deepStrictEqual([...org.RESERVED_ROLE_IDS], ['owner', 'me', 'act']);
});

check('default-role capability overrides are explicit data and do not drop the nine', () => {
  const readOnlyBuilder = orgWithRole('builder', [{
    id: 'builder',
    baseDefaultRole: null,
    capabilities: capabilities({ requiresMutationContext: true })
  }]);
  assert.strictEqual(org.mayClaim(readOnlyBuilder, 'subject', 'Q1'), false);
  const built = orgWithRole('builder', [{ id: 'night-shift', baseDefaultRole: 'builder' }]);
  assert.strictEqual(built.agents.find(entry => entry.id === 'subject').role, 'builder');
});

check('a role name has no privileged mechanics; its explicit capabilities and relationships decide', () => {
  const activeShadow = orgWithRole('shadow-manager', [{
    id: 'shadow-manager',
    baseDefaultRole: null,
    capabilities: capabilities({ mayClaimWork: true, mayWakeReports: true })
  }]);
  assert.strictEqual(org.mayClaim(activeShadow, 'subject', 'Q1'), true,
    'the shipped Shadow name is not mechanically forced read-only');

  const activeObserverCopy = orgWithRole('active-auditor', [{
    id: 'active-auditor',
    baseDefaultRole: 'observer',
    capabilities: capabilities({ mayClaimWork: true, mayWakeReports: true })
  }]);
  assert.strictEqual(org.mayClaim(activeObserverCopy, 'subject', 'Q1'), true,
    'an explicit custom-role capability overrides its descriptive base');
});

check('the accountable root is a role capability rather than the literal controller id', () => {
  const rooted = org.normalizeOrg({
    revision: 1,
    agents: [
      { id: 'lead', displayName: 'Lead', role: 'program-lead', provider: 'none', enabled: true },
      { id: 'worker', displayName: 'Worker', role: 'worker', provider: 'none', enabled: true }
    ],
    relationships: [{ from: 'lead', to: 'worker', type: 'manages' }]
  }, {
    knownRoles: [{
      id: 'program-lead',
      baseDefaultRole: 'manager',
      capabilities: capabilities({
        orgRoot: true,
        singleSeat: true,
        mayClaimWork: true,
        mayWakeReports: true
      })
    }]
  });
  assert.strictEqual(org.rootAgentOf(rooted).id, 'lead');
  assert.strictEqual(org.roleHasCapability(rooted, 'program-lead', 'orgRoot'), true);
});

check('an unknown baseDefaultRole is refused rather than treated as no base', () => {
  throwsCode(() => orgWithRole('night-shift', [{ id: 'night-shift', baseDefaultRole: 'wizard' }]),
    'AGENT_ORG_INVALID', 'unknown baseDefaultRole');
});

check('every default role keeps its claim posture when a custom role is declared', () => {
  // Custom roles are additive. This fails if declaring one ever changes what a
  // shipped role may do.
  assert.ok(org.ROLES.length > 0,
    'the default-role posture invariant must exercise at least one shipped role');
  for (const roleId of org.ROLES) {
    const bare = orgWithRole(roleId);
    const withCustom = orgWithRole(roleId, [{ id: 'night-shift', baseDefaultRole: 'builder' }]);
    assert.strictEqual(org.mayClaim(bare, 'subject', 'Q1'), org.mayClaim(withCustom, 'subject', 'Q1'),
      `declaring a custom role changed what "${roleId}" may claim`);
  }
});

check('declaring a custom role does not change the content hash of the same org', () => {
  // contentHash answers "did the declared agents and relationships change".
  // The role vocabulary is not part of that question, and folding it in would
  // make every custom-role definition look like an org edit.
  assert.strictEqual(
    orgWithRole('builder').contentHash,
    orgWithRole('builder', [{ id: 'night-shift', baseDefaultRole: 'builder' }]).contentHash
  );
});

console.log(`Agent org model tests passed (${checks} assertions; portable controller/worker pools and custom-role admission are pinned).`);
