// EXECUTABLE CHANGE
// testcanfail-tests-agent-org-store-test-js
//
// Mutation report: setting agent-org.js RESERVED_ROLE_IDS to Object.freeze([])
// left the original loop green, proving that an empty collection skipped every
// refusal assertion.  The explicit inventory assertion below made that mutation
// red with:
//   [a reserved identifier cannot be minted as a custom role] AssertionError
//   [ERR_ASSERTION]: the reserved-role refusal cases must not disappear
//   + actual - expected
//   + []
//   - [ 'act', 'me', 'owner' ]
// After restoring agent-org.js byte-for-byte, the strengthened file was green:
//   Agent org store tests passed (28 assertions; every persistence case reopens
//   the files rather than trusting an in-memory cache).
// Census: empty loop/forEach FOUND and fixed; exit-status/truthy-own-output
// NOT-FOUND; swallowed failure via try/catch or optional-chain NOT-FOUND; mock of
// subject NOT-FOUND; skip/platform precondition guard NOT-FOUND; expected value
// computed by the same code NOT-FOUND.  Named precondition: the installed Node
// 20 lacks node:sqlite, so runs used a load-only node:sqlite shim; the suite does
// not instantiate SQLite because these tests inject their file-backed stores.

'use strict';

// Declared-org WRITER tests.
//
// The property under test throughout is durability across a fresh reader. Every
// persistence case builds a brand-new store over the same files rather than
// asking the store that just wrote whether it remembers writing -- an in-memory
// cache passes that weaker question, and the defect this module exists to fix
// was exactly an edit that lived only in memory.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const agentOrg = require('../src/lib/agent-org');
const { createAgentOrgStore, createInstalledAgentOrgStores } = require('../src/lib/agent-org-store');
const { createDurableMemoryFile, resolveServicesRoot } = require('../src/lib/durable-memory-file');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');
const { createCustomRoleStore } = require('../src/lib/custom-role-store');
const machineRecord = require('../src/lib/setup/machine-record');

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
  assert.throws(fn, error => error.code === code,
    `${label}: expected ${code}, got a different failure`);
};

const BASELINE = {
  schemaVersion: 1,
  revision: 1,
  agents: [
    { id: 'controller', displayName: 'Controller', role: 'controller', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [] },
    { id: 'alpha', displayName: 'Alpha', role: 'builder', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [] },
    { id: 'beta', displayName: 'Beta', role: 'worker', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [] },
    { id: 'gamma', displayName: 'Gamma', role: 'worker', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [] }
  ],
  relationships: [
    { from: 'controller', to: 'alpha', type: 'manages' },
    { from: 'alpha', to: 'beta', type: 'manages' },
    { from: 'beta', to: 'gamma', type: 'manages' }
  ]
};

function workspace() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-org-store-'));
  const baselineFile = path.join(directory, 'baseline-agent-org.json');
  const overlayFile = path.join(directory, 'overlay-agent-org.json');
  const rolesFile = path.join(directory, 'custom-roles.json');
  fs.writeFileSync(baselineFile, JSON.stringify(BASELINE, null, 2));
  return { directory, baselineFile, overlayFile, rolesFile };
}

// A brand-new store over the same files. This is what "persisted" has to mean.
function reopen(paths, { withRoles = false } = {}) {
  const customRoles = withRoles
    ? createCustomRoleStore({ stateStore: createDurableMemoryFile({ file: paths.rolesFile }) })
    : null;
  return createAgentOrgStore({ baselineFile: paths.baselineFile, overlayFile: paths.overlayFile, customRoles });
}

function managerOf(org, agentId) {
  return agentOrg.managerOf(org, agentId);
}

// --- 1. reading before anything has been written -----------------------------

check('an unedited installation reads the shipped baseline', () => {
  const paths = workspace();
  const read = reopen(paths).read();
  assert.strictEqual(read.source, 'baseline');
  assert.strictEqual(read.damaged, null);
  assert.strictEqual(read.org.agents.length, 4);
  assert.strictEqual(managerOf(read.org, 'gamma'), 'beta');
  assert.ok(!fs.existsSync(paths.overlayFile), 'reading must not create an overlay');
});

// --- 2. a reparent survives a relaunch ---------------------------------------

check('a reparent is durable across a fresh store over the same files', () => {
  const paths = workspace();
  reopen(paths).reparent({ agentId: 'gamma', parentId: 'controller' });

  const reopened = reopen(paths).read();
  assert.strictEqual(reopened.source, 'overlay');
  assert.strictEqual(managerOf(reopened.org, 'gamma'), 'controller',
    'the reparent did not survive being read back by a new store');
  assert.strictEqual(reopened.org.revision, 2, 'a write must bump the revision');
});

check('a reparent moves only the manages edge it was asked to move', () => {
  const paths = workspace();
  const store = reopen(paths);
  const before = store.read().org;
  store.reparent({ agentId: 'gamma', parentId: 'controller' });
  const after = reopen(paths).read().org;

  assert.strictEqual(managerOf(after, 'beta'), 'alpha', 'an unrelated manages edge was disturbed');
  assert.strictEqual(managerOf(after, 'alpha'), 'controller', 'an unrelated manages edge was disturbed');
  assert.strictEqual(
    after.relationships.filter(entry => entry.type === 'manages' && entry.to === 'gamma').length, 1,
    'an agent must end up with exactly one manager, never two edges'
  );
  assert.strictEqual(before.relationships.length, after.relationships.length,
    'a reparent replaces one edge; it must not add or drop any');
});

check('a reparent to a null parent makes an agent a root', () => {
  const paths = workspace();
  reopen(paths).reparent({ agentId: 'gamma', parentId: null });
  const after = reopen(paths).read().org;
  assert.strictEqual(managerOf(after, 'gamma'), null);
});

// --- 3. the guards are the normalizer's, and they still fire ------------------

check('a reparent that would form a management cycle is refused', () => {
  const paths = workspace();
  const store = reopen(paths);
  // alpha manages beta manages gamma. Putting alpha under gamma closes the loop.
  throwsCode(() => store.reparent({ agentId: 'alpha', parentId: 'gamma' }),
    'AGENT_ORG_CYCLE', 'a cycle through the existing chain');
  assert.ok(!fs.existsSync(paths.overlayFile), 'a refused edit must not leave a file behind');
});

check('the controller cannot be given a manager', () => {
  const paths = workspace();
  throwsCode(() => reopen(paths).reparent({ agentId: 'controller', parentId: 'alpha' }),
    'AGENT_ORG_STORE_CONTROLLER_ROOTED', 'rooting the controller under a report');
});

check('an unknown agent, and an agent parented to itself, are refused by name', () => {
  const paths = workspace();
  const store = reopen(paths);
  throwsCode(() => store.reparent({ agentId: 'ghost', parentId: 'alpha' }), 'AGENT_ORG_STORE_UNKNOWN_AGENT', 'unknown child');
  throwsCode(() => store.reparent({ agentId: 'gamma', parentId: 'ghost' }), 'AGENT_ORG_STORE_UNKNOWN_AGENT', 'unknown parent');
  throwsCode(() => store.reparent({ agentId: 'gamma', parentId: 'gamma' }), 'AGENT_ORG_STORE_SELF_PARENT', 'self as parent');
});

// --- 4. role assignment ------------------------------------------------------

check('a role assignment is durable across a fresh store', () => {
  const paths = workspace();
  reopen(paths).assignRole({ agentId: 'beta', role: 'reviewer' });
  const after = reopen(paths).read().org;
  assert.strictEqual(after.agents.find(entry => entry.id === 'beta').role, 'reviewer');
});

check('assigning a read-only role actually removes the ability to claim work', () => {
  // The point of enforcing NON_CLAIMING_ROLES: assignment has to change what
  // the agent may do, not just what its badge says.
  const paths = workspace();
  const store = reopen(paths);
  assert.strictEqual(agentOrg.mayClaim(store.read().org, 'beta', 'Q1'), true);
  store.assignRole({ agentId: 'beta', role: 'observer' });
  assert.strictEqual(agentOrg.mayClaim(reopen(paths).read().org, 'beta', 'Q1'), false,
    'an agent assigned a read-only role could still claim work');
});

check('a second controller is refused, and the only controller cannot step down', () => {
  const paths = workspace();
  const store = reopen(paths);
  throwsCode(() => store.assignRole({ agentId: 'beta', role: 'controller' }),
    'AGENT_ORG_STORE_CONTROLLER_EXISTS', 'appointing a second controller');
  throwsCode(() => store.assignRole({ agentId: 'controller', role: 'worker' }),
    'AGENT_ORG_STORE_CONTROLLER_VACANT', 'leaving the org with no controller');
});

check('an undeclared role cannot be assigned', () => {
  const paths = workspace();
  throwsCode(() => reopen(paths).assignRole({ agentId: 'beta', role: 'night-shift' }),
    'AGENT_ORG_INVALID', 'a role that does not exist');
});

// --- 5. custom roles reach the org ------------------------------------------

check('a custom role can be created and then assigned, and both survive a relaunch', () => {
  const paths = workspace();
  const roles = createCustomRoleStore({ stateStore: createDurableMemoryFile({ file: paths.rolesFile }) });
  roles.createCustomRole({
    id: 'night-shift',
    baseDefaultRole: 'builder',
    rules: {
      owns: 'Work that runs while nobody is watching.',
      mustNot: 'Start anything it cannot finish before the window closes.',
      handoff: 'Receives a bounded overnight task; returns evidence in the morning.'
    }
  });
  reopen(paths, { withRoles: true }).assignRole({ agentId: 'beta', role: 'night-shift' });

  const after = reopen(paths, { withRoles: true }).read();
  assert.strictEqual(after.source, 'overlay');
  assert.strictEqual(after.org.agents.find(entry => entry.id === 'beta').role, 'night-shift');
  assert.strictEqual(agentOrg.mayClaim(after.org, 'beta', 'Q1'), true,
    'a custom role based on builder should be able to claim work');
});

check('a custom role based on a read-only role cannot claim, even once assigned', () => {
  const paths = workspace();
  const roles = createCustomRoleStore({ stateStore: createDurableMemoryFile({ file: paths.rolesFile }) });
  roles.createCustomRole({
    id: 'watcher',
    baseDefaultRole: 'observer',
    rules: {
      owns: 'Watching one named surface and reporting what it shows.',
      mustNot: 'Change the thing it is watching.',
      handoff: 'Receives access only; publishes what it measured.'
    }
  });
  reopen(paths, { withRoles: true }).assignRole({ agentId: 'beta', role: 'watcher' });
  const after = reopen(paths, { withRoles: true }).read();
  assert.strictEqual(agentOrg.mayClaim(after.org, 'beta', 'Q1'), false,
    'a custom role copied from observer became a way to claim work');
});

check('a reserved identifier cannot be minted as a custom role', () => {
  const paths = workspace();
  const roles = createCustomRoleStore({ stateStore: createDurableMemoryFile({ file: paths.rolesFile }) });
  assert.deepStrictEqual([...agentOrg.RESERVED_ROLE_IDS].sort(), ['act', 'me', 'owner'],
    'the reserved-role refusal cases must not disappear');
  for (const reserved of agentOrg.RESERVED_ROLE_IDS) {
    throwsCode(() => roles.createCustomRole({
      id: reserved,
      baseDefaultRole: 'builder',
      rules: { owns: 'x', mustNot: 'y', handoff: 'z' }
    }), 'CUSTOM_ROLE_RESERVED_ID', `reserved id "${reserved}"`);
  }
});

check('an org holding a custom role that was deleted reports damage, not a silent reset', () => {
  const paths = workspace();
  const roles = createCustomRoleStore({ stateStore: createDurableMemoryFile({ file: paths.rolesFile }) });
  roles.createCustomRole({
    id: 'night-shift',
    baseDefaultRole: 'builder',
    rules: { owns: 'Overnight work.', mustNot: 'Overrun the window.', handoff: 'Returns evidence.' }
  });
  reopen(paths, { withRoles: true }).assignRole({ agentId: 'beta', role: 'night-shift' });

  // Reopen WITHOUT the custom role vocabulary: the stored org now names a role
  // that no longer exists. The operator must be told, not quietly shown the
  // shipped default as though it were their org.
  const orphaned = reopen(paths).read();
  assert.strictEqual(orphaned.source, 'baseline');
  assert.match(String(orphaned.damaged), /no longer valid/);
});

// --- 6. durability and concurrency ------------------------------------------

check('two sequential edits both survive, and the revision advances once each', () => {
  const paths = workspace();
  reopen(paths).reparent({ agentId: 'gamma', parentId: 'controller' });
  reopen(paths).assignRole({ agentId: 'beta', role: 'reviewer' });
  const after = reopen(paths).read();
  assert.strictEqual(managerOf(after.org, 'gamma'), 'controller');
  assert.strictEqual(after.org.agents.find(entry => entry.id === 'beta').role, 'reviewer');
  assert.strictEqual(after.org.revision, 3);
});

check('a stale expectedRevision is refused rather than silently overwriting', () => {
  const paths = workspace();
  const store = reopen(paths);
  const stale = store.read().org.revision;
  reopen(paths).reparent({ agentId: 'gamma', parentId: 'controller' });
  throwsCode(() => store.reparent({ agentId: 'beta', parentId: 'controller' }, { expectedRevision: stale }),
    'AGENT_ORG_STORE_REVISION_CONFLICT', 'a second window editing a stale read');
});

check('a damaged overlay is reported and never written over', () => {
  const paths = workspace();
  reopen(paths).reparent({ agentId: 'gamma', parentId: 'controller' });
  fs.writeFileSync(paths.overlayFile, '{ this is not json');
  const store = reopen(paths);
  const read = store.read();
  assert.strictEqual(read.source, 'baseline');
  assert.match(String(read.damaged), /malformed JSON/);
  throwsCode(() => store.reparent({ agentId: 'beta', parentId: 'controller' }),
    'AGENT_ORG_STORE_DAMAGED', 'writing over an unreadable overlay');
});

check('the overlay is written whole, never left half-written under a reader', () => {
  // The write must land by rename, so a reader either sees the old document or
  // the new one. Asserting the temporary is gone is how the rename is observed
  // without racing it.
  const paths = workspace();
  reopen(paths).reparent({ agentId: 'gamma', parentId: 'controller' });
  const leftovers = fs.readdirSync(paths.directory).filter(entry => entry.includes('.tmp'));
  assert.deepStrictEqual(leftovers, [], `a temporary file survived the write: ${leftovers.join(', ')}`);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(paths.overlayFile, 'utf8')));
});

// --- 7. baseline relationship ------------------------------------------------

check('a reset returns the installation to the shipped default', () => {
  const paths = workspace();
  reopen(paths).reparent({ agentId: 'gamma', parentId: 'controller' });
  reopen(paths).resetToBaseline();
  const after = reopen(paths).read();
  assert.strictEqual(after.source, 'baseline');
  assert.strictEqual(managerOf(after.org, 'gamma'), 'beta');
});

check('a shipped default that moved under an operator edit is reported, not applied', () => {
  const paths = workspace();
  reopen(paths).reparent({ agentId: 'gamma', parentId: 'controller' });

  // The product ships a new default with an extra seat.
  const moved = JSON.parse(JSON.stringify(BASELINE));
  moved.agents.push({ id: 'delta', displayName: 'Delta', role: 'worker', provider: 'none', enabled: true, assignedPhase: null, phasePriority: [] });
  fs.writeFileSync(paths.baselineFile, JSON.stringify(moved, null, 2));

  const after = reopen(paths).read();
  assert.strictEqual(after.source, 'overlay');
  assert.ok(after.baselineDrift, 'drift against the shipped default was not reported');
  assert.notStrictEqual(after.baselineDrift.seededFrom, after.baselineDrift.shippedNow);
  assert.strictEqual(managerOf(after.org, 'gamma'), 'controller', 'the operator edit must survive');
  assert.ok(!after.org.agents.some(entry => entry.id === 'delta'),
    'a moved baseline must not be silently merged into the operator org');
});

check('an export is the org and nothing else', () => {
  const paths = workspace();
  reopen(paths).reparent({ agentId: 'gamma', parentId: 'controller' });
  const exported = reopen(paths).exportOrg();
  assert.deepStrictEqual(Object.keys(exported).sort(), ['agents', 'relationships', 'revision', 'schemaVersion']);
  // It must be round-trippable: an export that cannot be read back as an org is
  // not a document anyone can keep.
  assert.doesNotThrow(() => agentOrg.normalizeOrg(exported));
});

// --- 8. where the data lives -------------------------------------------------

check('the store writes where the installation already keeps its own data', () => {
  // The shipping spelling is a compatibility promise: changing it would move
  // every existing customer's machine record, settings and agent home.
  const localAppData = path.join(isolatedTemporaryRoot(), 'localappdata-probe');
  const selectedUserData = path.join(isolatedTemporaryRoot(), 'roaming-probe', 'ToolsEnabled');
  const expectedServicesRoot = path.join(localAppData, 'ToolsEnabled');
  const env = {
    LOCALAPPDATA: localAppData,
    TOOLSENABLED_STATE_ROOT: path.join(selectedUserData, 'capability')
  };
  assert.strictEqual(
    resolveServicesRoot({ env }),
    expectedServicesRoot,
    'the customer service root must combine owner-fenced LOCALAPPDATA with the selected product identity'
  );
  assert.strictEqual(machineRecord.resolveServicesRoot({ env }), resolveServicesRoot({ env }),
    'durable-memory-file and machine-record disagree about the installation directory');
  const store = createAgentOrgStore({ baselineFile: workspace().baselineFile, env });
  assert.strictEqual(store.overlayFile, path.join(expectedServicesRoot, 'agent-org.json'));
  const installed = createInstalledAgentOrgStores({ baselineFile: workspace().baselineFile, env });
  assert.strictEqual(installed.orgStore.overlayFile, path.join(expectedServicesRoot, 'agent-org.json'));
  assert.strictEqual(installed.roleStore.stateStore.file, path.join(expectedServicesRoot, 'custom-roles.json'),
    'the installed role/org composition must stay inside the owner-fenced customer service root');
});

check('a renamed build resolves a different service root', () => {
  const localAppData = path.join(isolatedTemporaryRoot(), 'renamed-localappdata-probe');
  const identityBase = path.join(isolatedTemporaryRoot(), 'roaming-probe');
  const shipping = resolveServicesRoot({ env: {
    LOCALAPPDATA: localAppData,
    TOOLSENABLED_STATE_ROOT: path.join(identityBase, 'ToolsEnabled', 'capability')
  } });
  const renamed = resolveServicesRoot({ env: {
    LOCALAPPDATA: localAppData,
    TOOLSENABLED_STATE_ROOT: path.join(identityBase, 'ToolsEnabled Test', 'capability')
  } });
  assert.strictEqual(renamed, path.join(localAppData, 'ToolsEnabled Test'),
    'the renamed identity did not carry through to the service root');
  assert.notStrictEqual(renamed, shipping,
    'a renamed lifecycle build still addresses the shipping product service root');
});

check('an unavailable product identity is a named refusal', () => {
  throwsCode(() => resolveServicesRoot({ env: { LOCALAPPDATA: os.tmpdir() } }),
    'SERVICE_PRODUCT_IDENTITY_UNAVAILABLE', 'a missing running-product identity');
});

check('a missing baseline is a named failure, not an empty organisation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-agent-org-store-'));
  throwsCode(() => createAgentOrgStore({
    baselineFile: path.join(directory, 'no-such-org.json'),
    overlayFile: path.join(directory, 'overlay-agent-org.json')
  }).read(),
    'AGENT_ORG_STORE_NO_BASELINE', 'a baseline that is not there');
});

check('a missing baseline cannot be reported as no drift for a saved organisation', () => {
  const paths = workspace();
  reopen(paths).reparent({ agentId: 'gamma', parentId: 'controller' });
  fs.unlinkSync(paths.baselineFile);

  throwsCode(() => reopen(paths).read(),
    'AGENT_ORG_STORE_NO_BASELINE', 'drift when the baseline cannot be measured');
});

check('the installed view composes the customer role file with the customer org overlay', () => {
  const paths = workspace();
  const roles = createCustomRoleStore({ stateStore: createDurableMemoryFile({ file: paths.rolesFile }) });
  roles.createCustomRole({
    id: 'release-captain',
    baseDefaultRole: 'manager',
    rules: {
      owns: 'Own the bounded release train.',
      mustNot: 'Change work outside the declared release.',
      handoff: 'Return reviewed release evidence to the controller.'
    }
  });
  createAgentOrgStore({
    baselineFile: paths.baselineFile,
    overlayFile: paths.overlayFile,
    customRoles: roles
  }).assignRole({ agentId: 'alpha', role: 'release-captain' });

  const active = createInstalledAgentOrgStores({
    baselineFile: paths.baselineFile,
    overlayFile: paths.overlayFile,
    roleMemoryFile: paths.rolesFile
  }).read();
  assert.strictEqual(active.source, 'overlay');
  assert.strictEqual(active.org.agents.find(agent => agent.id === 'alpha').role, 'release-captain');
  assert.deepStrictEqual(active.knownRoles.map(role => role.id), [...agentOrg.ROLES, 'release-captain']);
  assert.deepStrictEqual(
    active.knownRoles.find(role => role.id === 'release-captain').capabilities,
    agentOrg.DEFAULT_ROLE_CAPABILITIES.manager,
    'the installed view carries the role-defined workflow posture used by normalizeOrg'
  );
  assert.strictEqual(active.roles.find(role => role.id === 'release-captain').rules.owns,
    'Own the bounded release train.');
});

check('one org read uses one authoritative role-definition snapshot', () => {
  const paths = workspace();
  let roleReads = 0;
  const roleDefinition = {
    id: 'release-captain',
    baseDefaultRole: 'manager',
    capabilities: agentOrg.DEFAULT_ROLE_CAPABILITIES.manager
  };
  const store = createAgentOrgStore({
    baselineFile: paths.baselineFile,
    overlayFile: paths.overlayFile,
    customRoles: {
      listRoles() {
        roleReads += 1;
        return [roleDefinition];
      }
    }
  });
  store.assignRole({ agentId: 'alpha', role: 'release-captain' });
  roleReads = 0;
  const active = store.read();
  assert.strictEqual(active.org.agents.find(agent => agent.id === 'alpha').role, 'release-captain');
  assert.strictEqual(roleReads, 1,
    'overlay normalization and baseline drift must not observe different role-store instants');
});

check('the existing root holder can move atomically to a custom root-capable role', () => {
  const paths = workspace();
  const rootCapabilities = {
    ...agentOrg.DEFAULT_ROLE_CAPABILITIES.manager,
    orgRoot: true,
    singleSeat: true
  };
  const store = createAgentOrgStore({
    baselineFile: paths.baselineFile,
    overlayFile: paths.overlayFile,
    customRoles: {
      listRoles: () => [{ id: 'program-lead', baseDefaultRole: 'manager', capabilities: rootCapabilities }]
    }
  });
  const changed = store.assignRole({ agentId: 'controller', role: 'program-lead' });
  assert.strictEqual(agentOrg.rootAgentOf(changed.org).id, 'controller');
  assert.strictEqual(changed.org.agents.find(agent => agent.id === 'controller').role, 'program-lead');
});

// --- 9. store-owned refusal boundaries --------------------------------------

check('an invalid store configuration refuses before touching the filesystem', () => {
  let fileSystemCalls = 0;
  const untouchedFileSystem = new Proxy({}, {
    get() {
      fileSystemCalls += 1;
      throw new Error('the filesystem must not be consulted');
    }
  });

  throwsCode(() => createAgentOrgStore({ baselineFile: '', fileSystem: untouchedFileSystem }),
    'AGENT_ORG_STORE_INVALID', 'an empty baseline path');
  assert.strictEqual(fileSystemCalls, 0, 'invalid construction performed filesystem work');
});

check('a malformed shipped baseline is refused without creating an overlay', () => {
  const paths = workspace();
  fs.writeFileSync(paths.baselineFile, '{ not valid JSON');

  throwsCode(() => reopen(paths).read(),
    'AGENT_ORG_STORE_BASELINE_DAMAGED', 'malformed shipped baseline');
  assert.ok(!fs.existsSync(paths.overlayFile), 'reading a damaged baseline wrote an overlay');
});

check('an atomic rename failure is reported and leaves neither overlay nor temporary file', () => {
  const paths = workspace();
  let renameAttempts = 0;
  const failingFileSystem = Object.create(fs);
  failingFileSystem.renameSync = () => {
    renameAttempts += 1;
    const error = new Error('injected rename failure');
    error.code = 'EIO';
    throw error;
  };
  const store = createAgentOrgStore({
    baselineFile: paths.baselineFile,
    overlayFile: paths.overlayFile,
    fileSystem: failingFileSystem
  });

  throwsCode(() => store.reparent({ agentId: 'gamma', parentId: 'controller' }),
    'AGENT_ORG_STORE_WRITE_FAILED', 'atomic rename failure');
  assert.strictEqual(renameAttempts, 1, 'the injected persistence failure was not reached');
  assert.ok(!fs.existsSync(paths.overlayFile), 'a failed atomic write created the target overlay');
  assert.deepStrictEqual(fs.readdirSync(paths.directory).filter(name => name.endsWith('.tmp')), [],
    'a failed atomic write left its temporary file behind');
});

// --- 10. the durable backend -------------------------------------------------

check('a stored entry is still findable by search after a reload', () => {
  // The regression this pins: note and tags were written to the file and then
  // dropped on reload. Nothing looked broken -- getMemory still returned the
  // value -- but searchMemory matches against note and tags, and
  // custom-role-store.js LISTS roles through searchMemory. So a custom role
  // defined in one session was persisted perfectly and invisible in the next.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-memory-'));
  const file = path.join(directory, 'entries.json');
  createDurableMemoryFile({ file }).setMemory({
    namespace: 'probe', key: 'alpha', value: { n: 1 },
    note: 'findable-by-this-word', tags: ['probe-tag']
  });

  const reloaded = createDurableMemoryFile({ file });
  assert.strictEqual(reloaded.searchMemory({ namespace: 'probe', query: 'findable-by-this-word' }).length, 1,
    'a note written to disk was not searchable after a reload');
  assert.strictEqual(reloaded.searchMemory({ namespace: 'probe', query: 'probe-tag' }).length, 1,
    'a tag written to disk was not searchable after a reload');
  assert.strictEqual(reloaded.searchMemory({ namespace: 'other', query: 'findable-by-this-word' }).length, 0,
    'a search must not cross namespaces');
});

check('expectedRevision 0 means the key must not exist yet', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-memory-'));
  const file = path.join(directory, 'entries.json');
  const store = createDurableMemoryFile({ file });
  store.setMemory({ namespace: 'probe', key: 'alpha', value: 1, expectedRevision: 0 });
  throwsCode(() => createDurableMemoryFile({ file }).setMemory({ namespace: 'probe', key: 'alpha', value: 2, expectedRevision: 0 }),
    'MEMORY_REVISION_CONFLICT', 'creating a key that already exists');
});

// --- ensureSeat: one seat per tree node, idempotently -------------------------
check('ensureSeat declares a manager seat under the root, durably, and repeats as unchanged', () => {
  const paths = workspace();
  const first = reopen(paths).ensureSeat({ id: 'node-1-abc', role: 'manager', provider: 'claude', displayName: 'Manager 1 (tree seat)' });
  assert.strictEqual(first.unchanged, false);
  assert.strictEqual(first.seat.role, 'manager');
  assert.strictEqual(first.seat.provider, 'claude');
  assert.strictEqual(first.seat.enabled, true);
  const reopened = reopen(paths).read();
  assert.strictEqual(reopened.source, 'overlay');
  assert.strictEqual(reopened.org.revision, 2, 'a write must bump the revision');
  assert.strictEqual(managerOf(reopened.org, 'node-1-abc'), 'controller', 'a new seat reports to the root by default');
  const again = reopen(paths).ensureSeat({ id: 'node-1-abc', role: 'manager', provider: 'claude' });
  assert.strictEqual(again.unchanged, true, 'the same seat again is a no-op');
  assert.strictEqual(reopen(paths).read().org.revision, 2, 'a no-op must not bump the revision');
});
check('ensureSeat can place a seat under a named manager', () => {
  const paths = workspace();
  reopen(paths).ensureSeat({ id: 'node-2-def', role: 'worker', managerId: 'alpha' });
  assert.strictEqual(managerOf(reopen(paths).read().org, 'node-2-def'), 'alpha');
});
check('ensureSeat never re-roles or re-enables a seat, and refuses a second root', () => {
  const paths = workspace();
  const store = reopen(paths);
  throwsCode(() => store.ensureSeat({ id: 'beta', role: 'manager' }), 'AGENT_ORG_STORE_SEAT_ROLE_DIFFERS', 'an existing seat with another role');
  throwsCode(() => store.ensureSeat({ id: 'node-3-ghi', role: 'controller' }), 'AGENT_ORG_STORE_CONTROLLER_EXISTS', 'a second organisation root');
  throwsCode(() => store.ensureSeat({ id: 'node-4-jkl', role: 'worker', managerId: 'nobody' }), 'AGENT_ORG_STORE_UNKNOWN_AGENT', 'an unknown manager');
  throwsCode(() => store.ensureSeat({ id: 'node-5-mno', role: 'worker', managerId: 'node-5-mno' }), 'AGENT_ORG_STORE_SELF_PARENT', 'a seat managing itself');
  throwsCode(() => store.ensureSeat({ id: 'node-6-pqr', role: 'no-such-role' }), 'AGENT_ORG_INVALID', 'a role the library does not define');
  assert.ok(!fs.existsSync(paths.overlayFile), 'every refusal above must leave no overlay behind');
});
check('ensureSeat records the tree node id in its own field, distinct from a stable seat id', () => {
  const paths = workspace();
  const store = reopen(paths);
  const created = store.ensureSeat({ id: 'seat-manager-1', role: 'manager', nodeId: 'node-1-abc' });
  assert.strictEqual(created.seat.id, 'seat-manager-1', 'the seat id must be the stable id the caller chose, not the node id');
  assert.strictEqual(created.seat.nodeId, 'node-1-abc', 'the seat must carry the tree node id in its own field');
  const reopened = reopen(paths).read().org.agents.find(entry => entry.id === 'seat-manager-1');
  assert.strictEqual(reopened.nodeId, 'node-1-abc', 'nodeId must survive a fresh reader, not just the in-memory result it was returned in');
});
check('a legacy seat with no nodeId, whose id is itself a node id, still reads and releases correctly', () => {
  const paths = workspace();
  const store = reopen(paths);
  store.ensureSeat({ id: 'node-9-legacy', role: 'worker' }); // no nodeId passed: the pre-existing convention
  const legacy = reopen(paths).read().org.agents.find(entry => entry.id === 'node-9-legacy');
  assert.strictEqual(legacy.nodeId, null, 'a legacy seat created without nodeId must read back as null, not throw or vanish');
  const released = reopen(paths).releaseSeat({ id: 'node-9-legacy' });
  assert.strictEqual(released.unchanged, false, 'a legacy seat must still be releasable by its own id');
});
check('ensureSeat honours the caller\'s expected revision', () => {
  const paths = workspace();
  const store = reopen(paths);
  const { org } = store.read();
  throwsCode(() => store.ensureSeat({ id: 'node-7-stu', role: 'worker' }, { expectedRevision: org.revision + 5 }), 'AGENT_ORG_STORE_REVISION_CONFLICT', 'a stale snapshot');
  const written = store.ensureSeat({ id: 'node-7-stu', role: 'worker' }, { expectedRevision: org.revision });
  assert.strictEqual(written.org.revision, org.revision + 1);
});

// --- releaseSeat: the counterpart of ensureSeat -------------------------------
check('releaseSeat removes an existing seat and every relationship naming it, durably', () => {
  const paths = workspace();
  reopen(paths).ensureSeat({ id: 'node-1-abc', role: 'worker', managerId: 'beta' });
  const before = reopen(paths).read().org;
  assert.strictEqual(managerOf(before, 'node-1-abc'), 'beta', 'setup: the probe seat must report to beta');
  assert.strictEqual(managerOf(before, 'gamma'), 'beta', 'setup: beta must still manage its original report too');

  const released = reopen(paths).releaseSeat({ id: 'beta' });
  assert.strictEqual(released.unchanged, false);
  assert.ok(!released.org.agents.some(entry => entry.id === 'beta'), 'the released seat is still present in the write result');

  const after = reopen(paths).read().org;
  assert.ok(!after.agents.some(entry => entry.id === 'beta'), 'the released seat did not survive being read back by a new store');
  assert.ok(!after.relationships.some(entry => entry.from === 'beta' || entry.to === 'beta'),
    'a relationship naming the released seat survived');
  assert.strictEqual(managerOf(after, 'gamma'), null, 'an edge FROM the released seat survived');
  assert.strictEqual(managerOf(after, 'node-1-abc'), null, 'an edge FROM the released seat survived');
  assert.strictEqual(managerOf(after, 'alpha'), 'controller', 'an unrelated manages edge was disturbed');
  assert.strictEqual(after.revision, 3, 'a write must bump the revision');
});

check('releaseSeat is idempotent when the seat is already absent', () => {
  const paths = workspace();
  const store = reopen(paths);
  const before = store.read().org;
  const result = store.releaseSeat({ id: 'no-such-agent' });
  assert.strictEqual(result.unchanged, true);
  const after = reopen(paths).read().org;
  assert.strictEqual(after.revision, before.revision, 'a no-op release must not bump the revision');
  assert.ok(!fs.existsSync(paths.overlayFile), 'releasing an absent seat must not create an overlay');
});

check('releaseSeat refuses the organisation root by name', () => {
  const paths = workspace();
  throwsCode(() => reopen(paths).releaseSeat({ id: 'controller' }),
    'AGENT_ORG_STORE_SEAT_IS_ROOT', 'releasing the organisation root');
  assert.ok(!fs.existsSync(paths.overlayFile), 'a refused release must not leave a file behind');
  assert.strictEqual(managerOf(reopen(paths).read().org, 'alpha'), 'controller',
    'a refused release must leave the org completely unchanged');
});

check('saved admission limit controls the next mutation and survives a fresh process without truncating existing seats', () => {
  const paths = workspace();
  const settingsPath = path.join(paths.directory, 'settings.json');
  const env = { ...process.env, TOOLSENABLED_SETTINGS_PATH: settingsPath };
  delete env.MC_MAX_AGENTS;
  const makeStore = () => createAgentOrgStore({ baselineFile: paths.baselineFile, overlayFile: paths.overlayFile, env });
  const large = JSON.parse(JSON.stringify(BASELINE));
  for (let index = large.agents.length; index < 65; index += 1) {
    const id = `extra-${index}`;
    large.agents.push({ id, displayName: id, role: 'worker', provider: 'none', enabled: true });
    large.relationships.push({ from: 'controller', to: id, type: 'manages' });
  }
  const store = makeStore();
  throwsCode(() => store.write(large), 'AGENT_ORG_INVALID', 'default admission refuses 65');
  assert.strictEqual(fs.existsSync(paths.overlayFile), false);
  const saveLimit = value => fs.writeFileSync(settingsPath, JSON.stringify({ revision: 1,
    values: { 'fleet.max_declared_agents': value },
    provenance: { 'fleet.max_declared_agents': { source: 'user', atMs: 1, directive: null } } }));
  saveLimit(65);
  assert.strictEqual(store.write(large).org.agents.length, 65, 'the already-open store must reread the saved limit');
  const { execFileSync } = require('node:child_process');
  const program = `const {createAgentOrgStore}=require(${JSON.stringify(require.resolve('../src/lib/agent-org-store'))});
    const store=createAgentOrgStore({baselineFile:${JSON.stringify(paths.baselineFile)},overlayFile:${JSON.stringify(paths.overlayFile)}});
    console.log(store.read().org.agents.length);`;
  assert.strictEqual(execFileSync(process.execPath, ['-e', program], { env, encoding: 'utf8' }).trim(), '65');
  saveLimit(64);
  assert.strictEqual(makeStore().read().org.agents.length, 65, 'lowering the limit cannot replace the saved org with its baseline');
  throwsCode(() => store.ensureSeat({ id: 'too-many', role: 'worker', provider: 'none' }), 'AGENT_ORG_INVALID', 'growth above lowered limit');
  assert.strictEqual(store.releaseSeat({ id: 'extra-64' }).org.agents.length, 64);
  assert.strictEqual(makeStore().read().org.agents.length, 64);
  saveLimit(0);
  assert.strictEqual(store.ensureSeat({ id: 'unbounded', role: 'worker', provider: 'none' }).org.agents.length, 65);
  for (const invalid of [-1, 1.5, '65', Number.MAX_SAFE_INTEGER + 1]) {
    saveLimit(invalid);
    throwsCode(() => store.ensureSeat({ id: 'invalid-cap', role: 'worker', provider: 'none' }), 'AGENT_ORG_LIMIT_INVALID', 'invalid saved limit');
    assert.strictEqual(makeStore().read().org.agents.length, 65);
  }
});

console.log(`Agent org store tests passed (${checks} assertions; every persistence case reopens the files rather than trusting an in-memory cache).`);
