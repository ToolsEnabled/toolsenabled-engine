'use strict';

// THE PLAN -- task T7 of docs/design/INSTALLER-EXPERIENCE.md section 7.
//
// "A typed array of steps, each carrying an identifier, phase, human name, the
// declared writes, the network hosts contacted, the byte count, whether elevation
// is required, the resolved value, and the provenance of that value."
//
// WHY A PLAN AT ALL, when setup could simply do the work. Three reasons, and the
// third is the one that made it worth building.
//
// One: it makes `dry-run` real. A dry run that re-derives what it would have done
// is a second implementation that can disagree with the first; a dry run that
// prints the same plan the apply consumes cannot.
//
// Two: it makes the zero-elevation promise checkable instead of asserted. Section
// 8.2 requires zero UAC prompts across five installs. A plan whose every step
// declares `elevation: false` can be checked by a test in milliseconds, and any
// future step that needs elevation has to say so in the one place a test is
// looking.
//
// Three, and this is the reason: it makes the writes ENUMERABLE BEFORE THEY
// HAPPEN. The owner's standing question about anything that touches his machine
// is what it will actually do. `mcsetup plan --json` answers that in full, in
// advance, in paths -- and `assertWritesContained()` turns the answer into a
// refusal rather than a document nobody reads.
//
// A DEVIATION FROM THE DESIGN, STATED PLAINLY. The design's containment property
// is "no path outside the services root, the workspace, and %APPDATA%". Signing
// in cannot satisfy that: the agent command line writes its own credentials to
// `%USERPROFILE%\.codex`, which is none of those three. Rather than hide that
// write or pretend the property holds, the containment rule implemented here is
// the one the design was reaching for -- every write lands inside the user's own
// profile or this installation's own services root, and no step requires
// elevation -- and the `.codex` root is declared explicitly so a reader sees it.

const os = require('node:os');
const path = require('node:path');

const { SetupRefusal, TIERS } = require('./machine-record');

const SCHEMA_VERSION = 1;

// Phases exist so a screen can group steps without parsing their names.
const PHASES = Object.freeze(['decide', 'resolve', 'provision', 'configure', 'verify']);

function step(input) {
  const {
    id,
    phase,
    name,
    value,
    provenance,
    writes = [],
    hosts = [],
    bytes = 0,
    elevation = false,
    optional = false
  } = input;
  if (!PHASES.includes(phase)) {
    throw new SetupRefusal('SETUP_PLAN_PHASE_UNKNOWN', `${phase} is not a setup phase.`, { id, phase });
  }
  if (typeof id !== 'string' || id.trim() === '') {
    throw new SetupRefusal('SETUP_PLAN_STEP_INVALID', 'Every step needs an identifier.', { step: input });
  }
  if (typeof provenance !== 'string' || provenance.trim() === '') {
    // A value with no stated origin is a guess, and `mcsetup explain` exists
    // precisely so that no value in this product is a guess.
    throw new SetupRefusal('SETUP_PLAN_PROVENANCE_MISSING', `Step ${id} does not say where its value came from.`, { id });
  }
  return Object.freeze({
    id,
    phase,
    name,
    value: value === undefined ? null : value,
    provenance,
    writes: Object.freeze(writes.map(entry => path.resolve(entry))),
    hosts: Object.freeze(hosts.slice()),
    bytes,
    elevation,
    optional
  });
}

/**
 * The roots every write in a plan must land inside. Declared as data so a test
 * can assert against the same list the plan is built from, rather than a second
 * copy of the rule that can drift from it.
 */
function declaredWriteRoots({ servicesRoot, workspaceRoots, env = process.env, homedir = os.homedir }) {
  const home = typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '' ? env.USERPROFILE : homedir();
  const roots = [servicesRoot, ...workspaceRoots];
  if (typeof env.APPDATA === 'string' && env.APPDATA !== '') roots.push(env.APPDATA);
  if (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA !== '') roots.push(env.LOCALAPPDATA);
  // The agent command line's own credential directory. Named, not hidden -- see
  // the deviation note at the top of this file.
  roots.push(path.join(home, '.codex'));
  return Object.freeze(roots.filter(Boolean).map(entry => path.resolve(entry)));
}

function isInside(candidate, container) {
  const relative = path.relative(path.resolve(container), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Every write in the plan lands inside a declared root, and nothing asks for
 * administrator rights. Returns the offending steps rather than a boolean so a
 * failure names what to fix.
 */
function checkPlanContainment(plan) {
  const escaping = [];
  const elevating = [];
  for (const entry of plan.steps) {
    if (entry.elevation === true) elevating.push(entry.id);
    for (const target of entry.writes) {
      if (!plan.writeRoots.some(root => isInside(target, root))) escaping.push({ id: entry.id, path: target });
    }
  }
  return { ok: escaping.length === 0 && elevating.length === 0, escaping, elevating };
}

function assertWritesContained(plan) {
  const verdict = checkPlanContainment(plan);
  if (!verdict.ok) {
    throw new SetupRefusal(
      'SETUP_PLAN_UNCONTAINED',
      'This plan would write outside the folders it declared, or ask for administrator rights. Setup will not run it.',
      verdict
    );
  }
  return plan;
}

/**
 * Build the plan for one installation from the tier, the probe facts, and the
 * choices the person made.
 */
function plan(input = {}) {
  const {
    tier,
    facts,
    installRoot,
    servicesRoot,
    nodePath,
    workspaceRoots,
    tierSource = 'you chose it when setup asked',
    pairComputer = false,
    env = process.env,
    homedir = os.homedir
  } = input;

  if (!TIERS.includes(tier)) {
    throw new SetupRefusal('SETUP_TIER_UNKNOWN', `${tier} is not a tier this setup knows about.`, { tier });
  }
  if (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0) {
    throw new SetupRefusal('SETUP_WORKSPACE_MISSING', 'Choose a folder for your assistant to work in.', {});
  }

  const resolvedWorkspaces = workspaceRoots.map(entry => path.resolve(entry));
  const primaryWorkspace = resolvedWorkspaces[0];
  const writeRoots = declaredWriteRoots({ servicesRoot, workspaceRoots: resolvedWorkspaces, env, homedir });

  const steps = [
    step({
      id: 'tier',
      phase: 'decide',
      name: 'How much the assistant is allowed to do',
      value: tier,
      provenance: tierSource
    }),
    step({
      id: 'services-root',
      phase: 'resolve',
      name: 'Where this program keeps its own files',
      value: servicesRoot,
      provenance: typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA !== ''
        ? 'the standard per-user application folder on this computer'
        : 'a folder inside your home directory, because this computer does not use the standard one'
    }),
    step({
      id: 'runtime',
      phase: 'resolve',
      name: 'The program that runs the background services',
      value: nodePath,
      provenance: 'the same runtime that is executing setup right now, so it is known to exist on this computer'
    }),
    step({
      id: 'shell-port',
      phase: 'resolve',
      name: 'The port the window uses',
      value: facts && facts.shellPort ? facts.shellPort.chosen : null,
      provenance: facts && facts.shellPort
        ? `the first free port between ${facts.shellPort.range.first} and ${facts.shellPort.range.last}, found by opening it`
        : 'not measured'
    }),
    step({
      id: 'bridge-port',
      phase: 'resolve',
      name: 'The port the background service uses',
      value: facts && facts.bridgePort ? facts.bridgePort.chosen : null,
      provenance: facts && facts.bridgePort
        ? `the first free port between ${facts.bridgePort.range.first} and ${facts.bridgePort.range.last}, found by opening it`
        : 'not measured'
    }),
    step({
      id: 'workspace',
      phase: 'provision',
      name: 'The folder your assistant works in',
      value: resolvedWorkspaces,
      provenance: tier === 'guided'
        ? 'the folder setup offered you, in your Documents'
        : 'the folder or folders you chose',
      writes: resolvedWorkspaces,
      bytes: 0
    }),
    step({
      id: 'workspace-history',
      phase: 'provision',
      name: 'A record of changes, so anything can be undone',
      value: facts && facts.git
        ? (facts.git.present ? 'available' : 'not available on this computer')
        : null,
      provenance: facts && facts.git
        ? 'whether a version-history tool was found during the check'
        : 'not measured',
      writes: resolvedWorkspaces.map(root => path.join(root, '.git')),
      bytes: 64 * 1024
    }),
    step({
      id: 'provider-sign-in',
      phase: 'configure',
      name: 'Signing in to the account that does the thinking',
      value: tier === 'guided' ? 'codex' : 'codex or claude',
      provenance: tier === 'guided'
        ? 'setup chooses this for you at this level, because it is the only sign-in this program is permitted to show you directly'
        : 'you choose, and both routes are offered',
      // The device-authorization page and the account it belongs to. Named so
      // that "what does setup contact" has an answer before it contacts it.
      hosts: ['auth.openai.com', 'chatgpt.com'],
      writes: [path.join(
        typeof env.USERPROFILE === 'string' && env.USERPROFILE !== '' ? env.USERPROFILE : homedir(),
        '.codex'
      )],
      bytes: 4 * 1024
    }),
    step({
      id: 'machine-record',
      phase: 'configure',
      name: 'Writing down what was decided',
      value: path.join(servicesRoot, 'machine.json'),
      provenance: 'the choices and resolved values above, so nothing has to be asked again',
      writes: [path.join(servicesRoot, 'machine.json')],
      bytes: 2 * 1024
    }),
    step({
      id: 'mcp-config',
      phase: 'configure',
      name: 'Telling the assistant what it may use',
      value: path.join(primaryWorkspace, '.mcp.json'),
      provenance: 'generated from the record above, so every path in it exists on this computer',
      writes: [path.join(primaryWorkspace, '.mcp.json')],
      bytes: 4 * 1024
    })
  ];

  if (pairComputer === true) {
    steps.push(step({
      id: 'pair-computer',
      phase: 'configure',
      name: 'Adding a second computer',
      value: 'a code shown on this screen and typed on the other computer',
      provenance: 'you asked to add another computer',
      // Loopback only until the other computer connects; the code never leaves
      // the screen it is displayed on.
      hosts: [],
      writes: [path.join(installRoot || servicesRoot, 'config', 'peers.profile.json')],
      bytes: 2 * 1024,
      optional: true
    }));
  }

  steps.push(step({
    id: 'verify',
    phase: 'verify',
    name: 'Checking it actually works',
    value: 'the recorded configuration is read back and every path in it is confirmed to exist',
    provenance: 'setup verifies rather than assumes -- a configuration that was written is not the same as one that works'
  }));

  const built = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    tier,
    installRoot: installRoot ? path.resolve(installRoot) : null,
    servicesRoot: path.resolve(servicesRoot),
    workspaceRoots: Object.freeze(resolvedWorkspaces),
    writeRoots,
    steps: Object.freeze(steps),
    totalBytes: steps.reduce((sum, entry) => sum + entry.bytes, 0),
    requiresElevation: steps.some(entry => entry.elevation === true),
    hosts: Object.freeze([...new Set(steps.flatMap(entry => entry.hosts))])
  });

  return assertWritesContained(built);
}

function explainStep(builtPlan, id) {
  const found = builtPlan.steps.find(entry => entry.id === id);
  if (!found) {
    throw new SetupRefusal('SETUP_PLAN_STEP_UNKNOWN', `There is no step called ${id} in this plan.`, { id });
  }
  return found;
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  PHASES,
  plan,
  step,
  explainStep,
  declaredWriteRoots,
  checkPlanContainment,
  assertWritesContained,
  isInside
});
