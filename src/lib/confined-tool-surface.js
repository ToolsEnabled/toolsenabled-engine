'use strict';

// A confined permission level admits only registered Fleet tools that this
// table classifies. The class records what the tool can reach locally, while
// its effect separately determines whether Guided may use it.
const workspaceBoundary = require('./workspace-boundary');

class ConfinedSurfaceRefusal extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConfinedSurfaceRefusal';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

// Installation-owned state and endpoints; no caller-supplied local path.
const CONTAINED = Object.freeze(new Set([
  'a_ledger.file', 'agent.remove', 'agent.stop', 'agent.wait',
  'agent_comms.local_roster', 'agent_comms.send_local',
  'audit.status', 'audit.tail', 'audit.verify',
  'capability.find', 'ledger.read',
  'memory.get', 'memory.search', 'memory.set',
  'openshell.denials', 'openshell.propose', 'openshell.status',
  'r_ledger.file', 'search.status', 'settings.read',
  'system.ask', 'system.notify', 'system.doctor', 'system.status',
  't_ledger.complete', 't_ledger.file', 't_ledger.progress',
  'task.cancel', 'task.checkpoint', 'task.claim', 'task.complete',
  'task.fail', 'task.get', 'task.heartbeat', 'task.list',
  'task.start', 'task.submit'
]));

// These paths are checked against the recorded workspace roots at dispatch.
// The host file tools are admitted only in host mode (fleet-confined-policy.js),
// where host-control.js also bounds them by the sealed workspace record.
const WORKSPACE_FENCED = Object.freeze(new Map([
  ['search.index', Object.freeze(['root'])],
  ['search.query', Object.freeze(['root'])],
  ['host.list_dir', Object.freeze(['path'])],
  ['host.read_file', Object.freeze(['path'])],
  ['host.write_file', Object.freeze(['path'])],
  ['host.patch_file', Object.freeze(['path'])]
]));

// Replacing a managed agent's execution configuration has no confined
// adapter. The registry and role policy still decide whether Full may act.
const UNCONFINABLE = Object.freeze(new Map([
  ['agent.set_model', 'changes a managed agent model without a confined model-change adapter'],
  ['agent.set_effort', 'changes a managed agent execution choice without a confined effort-change adapter'],
  ['agent.set_provider', 'selects another provider execution environment without a confined provider-change adapter'],
  ['agent.set_role', 'changes a managed agent role and function surface without a confined role-change adapter']
]));

const CONFIGURATION_CONTROL = new Set(['agent.set_model', 'agent.set_effort', 'agent.set_role']);
const CLASSES = Object.freeze(['contained', 'workspace', 'unconfinable', 'tree-confined', 'tree-lifecycle-confined', 'tree-speed-confined', 'tree-configuration-confined', 'tree-continuation-confined']);

function classify(name) {
  if (typeof name !== 'string' || !name) return null;
  if (name === 'agent.continue') return 'tree-continuation-confined';
  if (CONFIGURATION_CONTROL.has(name)) return 'tree-configuration-confined';
  if (name === 'agent.set_speed') return 'tree-speed-confined';
  if (name === 'agent.spawn') return 'tree-confined';
  if (name === 'agent.resume' || name === 'agent.restart') return 'tree-lifecycle-confined';
  if (CONTAINED.has(name)) return 'contained';
  if (WORKSPACE_FENCED.has(name)) return 'workspace';
  if (UNCONFINABLE.has(name)) return 'unconfinable';
  return null;
}

function classifiedToolNames() {
  return Object.freeze([...CONTAINED, ...WORKSPACE_FENCED.keys(), ...UNCONFINABLE.keys(),
    'agent.spawn', 'agent.resume', 'agent.restart', 'agent.set_speed', 'agent.continue'].sort());
}

function fencedArgumentNames(name) {
  const declared = WORKSPACE_FENCED.get(name);
  return declared ? Object.freeze([...declared]) : null;
}

function unconfinableReason(name) {
  return UNCONFINABLE.get(name) || null;
}

function assertToolConfinable(name, { tier = 'confined', profile = null } = {}) {
  const decided = classify(name);
  if (decided === 'tree-continuation-confined' && (profile !== 'workspace'
      || !require('./tree-host-registry').supportsConfinedContinuationControl())) {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
      'Assigned-task continuation requires a compatible retained-tree host; workspace, role and task ownership stay enforced.', { tool: name, tier, profile });
  }
  if (decided === 'tree-configuration-confined' && (profile !== 'workspace'
      || !require('./tree-host-registry').supportsConfinedConfigurationControl())) {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
      'Model, effort and role selection require a compatible host that retains workspace, provider and role authority.', { tool: name, tier, profile });
  }
  if (decided === 'tree-speed-confined' && (profile !== 'workspace'
      || !require('./tree-host-registry').supportsConfinedSpeedControl())) {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
      'Speed selection requires a compatible host that preserves the existing workspace and execution policy.', { tool: name, tier, profile });
  }
  if (decided === 'tree-lifecycle-confined' && (profile !== 'workspace'
      || !require('./tree-host-registry').supportsConfinedTreeLifecycle())) {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
      'Resuming or restarting a Standard circle requires a compatible application with retained tree authority.',
      { tool: name, tier, profile });
  }
  if (decided === 'tree-confined' && (profile !== 'workspace'
      || !require('./tree-host-registry').supportsConfinedTreeSpawn())) {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
      'Agent delegation requires a Standard tree session in a compatible application.',
      { tool: name, tier, profile });
  }
  if (decided === null) {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_UNCLASSIFIED_REFUSED',
      `Tool '${name}' has no recorded confinement class, so a confined permission level refuses it.`,
      { tool: name, tier, profile });
  }
  if (decided === 'unconfinable') {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
      `Tool '${name}' cannot be confined to a workspace (${unconfinableReason(name)}), so it is available only at the Unrestricted level.`,
      { tool: name, tier, profile, reason: unconfinableReason(name) });
  }
  return decided;
}

function assertPathValueInsideRoots(name, label, value, workspaceRoots, { tier, profile }) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_PATH_UNREADABLE',
      `Tool '${name}' was given a '${label}' this permission level cannot check.`,
      { tool: name, argument: label, tier, profile });
  }
  try {
    workspaceBoundary.assertInsideRoots(value, workspaceRoots, { label, tool: name });
  } catch (error) {
    const boundaryCode = error && error.code;
    const refused = boundaryCode === 'WORKSPACE_BOUNDARY_REFUSED'
      || boundaryCode === 'WORKSPACE_PATH_REFUSED'
      || boundaryCode === 'WORKSPACE_ROOTS_ABSENT'
      || boundaryCode === 'WORKSPACE_ROOTS_UNREADABLE';
    throw new ConfinedSurfaceRefusal(
      refused ? 'PERMISSION_CONFINED_WORKSPACE_REFUSED' : 'PERMISSION_CONFINED_PATH_UNREADABLE',
      error.message,
      { tool: name, argument: label, tier, profile, boundaryCode: boundaryCode || null });
  }
}

function assertArgumentsConfined(name, argumentsValue, workspaceRoots, { tier = 'confined', profile = null } = {}) {
  const declared = WORKSPACE_FENCED.get(name);
  if (!declared) return true;
  if (!argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) {
    throw new ConfinedSurfaceRefusal('PERMISSION_CONFINED_PATH_UNREADABLE',
      `Tool '${name}' was given arguments this permission level cannot check.`,
      { tool: name, tier, profile });
  }
  for (const argument of declared) {
    assertPathValueInsideRoots(name, argument, argumentsValue[argument], workspaceRoots, { tier, profile });
  }
  return true;
}

module.exports = Object.freeze({
  CLASSES, CONTAINED, WORKSPACE_FENCED, UNCONFINABLE,
  ConfinedSurfaceRefusal, classify, classifiedToolNames,
  fencedArgumentNames, unconfinableReason,
  assertToolConfinable, assertArgumentsConfined
});
