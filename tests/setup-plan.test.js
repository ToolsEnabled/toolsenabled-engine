/* Mutation check:
 * In src/lib/setup/plan.js, changed the isInside return expression from
 * `relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))`
 * to `relative === '' || !path.isAbsolute(relative)`.
 * The edit landed, and this test file went red (exit 1).
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const {
  SCHEMA_VERSION,
  PHASES,
  plan,
  step,
  explainStep,
  declaredWriteRoots,
  checkPlanContainment,
  assertWritesContained,
  isInside
} = require('../src/lib/setup/plan');

const base = path.resolve('/tmp/setup-plan-behaviour');
const servicesRoot = path.join(base, 'services');
const workspace = path.join(base, 'workspace');
const home = path.join(base, 'home');

assert.equal(SCHEMA_VERSION, 1);
assert.deepEqual(PHASES, ['decide', 'resolve', 'provision', 'configure', 'verify']);
assert.equal(isInside(path.join(workspace, 'child'), workspace), true);
assert.equal(isInside(path.join(base, 'workspace-escape'), workspace), false);

const roots = declaredWriteRoots({
  servicesRoot,
  workspaceRoots: [workspace],
  env: { APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local') },
  homedir: () => home
});
assert.deepEqual(roots, [
  servicesRoot,
  workspace,
  path.join(home, 'roaming'),
  path.join(home, 'local'),
  path.join(home, '.codex')
].map(entry => path.resolve(entry)));

const normalized = step({
  id: 'write-config',
  phase: 'configure',
  name: 'Write configuration',
  provenance: 'test input',
  writes: [path.join(workspace, '..', 'workspace', 'config.json')],
  hosts: ['example.test']
});
assert.equal(normalized.value, null);
assert.deepEqual(normalized.writes, [path.join(workspace, 'config.json')]);
assert.equal(Object.isFrozen(normalized), true);
assert.equal(Object.isFrozen(normalized.writes), true);
assert.throws(() => step({ id: 'bad', phase: 'invented', provenance: 'test input' }), error => {
  assert.equal(error.code, 'SETUP_PLAN_PHASE_UNKNOWN');
  return true;
});

const built = plan({
  tier: 'guided',
  facts: {
    shellPort: { chosen: 4100, range: { first: 4100, last: 4110 } },
    bridgePort: { chosen: 4200, range: { first: 4200, last: 4210 } }
  },
  installRoot: servicesRoot,
  servicesRoot,
  nodePath: process.execPath,
  workspaceRoots: [workspace],
  pairComputer: true,
  env: {},
  homedir: () => home
});
assert.equal(built.schemaVersion, SCHEMA_VERSION);
assert.equal(built.requiresElevation, false);
assert.equal(checkPlanContainment(built).ok, true);
assert.equal(explainStep(built, 'shell-port').value, 4100);
assert.equal(explainStep(built, 'pair-computer').optional, true);
assert.deepEqual(built.hosts, ['auth.openai.com', 'chatgpt.com']);
assert.equal(built.totalBytes, built.steps.reduce((sum, entry) => sum + entry.bytes, 0));
assert.throws(() => explainStep(built, 'missing'), error => {
  assert.equal(error.code, 'SETUP_PLAN_STEP_UNKNOWN');
  return true;
});

const unsafe = {
  writeRoots: [workspace],
  steps: [
    { id: 'escape', elevation: false, writes: [path.join(base, 'outside.txt')] },
    { id: 'admin', elevation: true, writes: [path.join(workspace, 'inside.txt')] }
  ]
};
assert.deepEqual(checkPlanContainment(unsafe), {
  ok: false,
  escaping: [{ id: 'escape', path: path.join(base, 'outside.txt') }],
  elevating: ['admin']
});
assert.throws(() => assertWritesContained(unsafe), error => {
  assert.equal(error.code, 'SETUP_PLAN_UNCONTAINED');
  assert.deepEqual(error.details.elevating, ['admin']);
  return true;
});

console.log('setup plan behaviour: ok');
