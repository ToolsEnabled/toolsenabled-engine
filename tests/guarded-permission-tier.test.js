// EXECUTABLE CHANGE — testcanfail-tests-guarded-permission-tier-test-js
//
// Assertion strengthened:
// - The guarded executeTool rejection used TOOL_REGISTRY.find(...).name without
//   first proving that the registry actually supplied the local-write subject.
//   Mutation: temporarily changed every `effect: 'local-write'` classification
//   in src/lib/tool-registry.js to `effect: 'local-read'` (then restored the
//   file byte-for-byte; SHA-256 before/after was
//   29f8cb60e8bf36f3247a0e19599e4b9ab13f142916b644f0eb4a9221f611d86f).
//   RED: "AssertionError [ERR_ASSERTION]: registry fixture must contain a
//   local-write tool to exercise guarded refusal" (exit 1).
//
// Census:
// - EMPTY LOOP — NOT-FOUND. The fixed malformed-session candidates are
//   non-empty, and the registry parity loop is preceded by names.size > 0.
// - EXIT STATUS / TRUTHY RETURN — NOT-FOUND. This file invokes APIs directly
//   and checks specific refusal codes and details rather than child status.
// - SWALLOWED FAILURE — NOT-FOUND. There is no optional chaining that invokes
//   the subject and no try/catch; optional chaining occurs only in strict error
//   predicates.
// - MOCK OF SUBJECT — NOT-FOUND. The injected argv builders are tripwires; the
//   real permission policy and dispatch admission are the subjects, and the
//   test proves the tripwires were not reached.
// - SKIP / PLATFORM GUARD — NOT-FOUND. This file has neither.
// - SAME-CODE EXPECTATION — NOT-FOUND. Registry entries are compared with the
//   policy's declared effect vocabulary, while independent refusal assertions
//   cover guarded execution and provider dispatch.
//
// Precondition met: this checkout has no config/agent-org.json, so the original
// run stopped at BRIDGE_ACTOR_AUTHORITY_UNAVAILABLE before the dispatch
// assertion. The test now supplies the repository's declared-org fixture and
// its enabled controller. Restored-source GREEN: "Guarded permission tier
// escape tests passed (8 checks)." (exit 0), run with Node 22.22.2.
'use strict';

const isolated = require('./lib/isolated-environment').activate('guarded-permission-tier');
const assert = require('node:assert/strict');
const policy = require('../src/lib/permission-tier-policy');
const { TOOL_REGISTRY, executeTool } = require('../src/lib/tool-registry');
const { claudeArgs, codexArgs, createMissionActions } = require('../src/lib/mission-bridge/actions');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

void isolated;

const GUARDED = Object.freeze({ origin: 'remote', tier: 'guarded' });
let checks = 0;
const check = (description, fn) => { fn(); checks += 1; void description; };

async function main() {
  check('unknown and malformed sessions fail closed', () => {
    for (const candidate of [null, {}, { origin: 'remote', tier: 'mystery' }, { origin: 'mystery', tier: 'guarded' }, { origin: 'remote', tier: 'full' }]) {
      assert.throws(() => policy.session(candidate), error => /^PERMISSION_/.test(error?.code));
    }
  });

  check('unreadable policy metadata fails closed', () => {
    assert.throws(() => policy.guardedToolNames(null), error => error?.code === 'PERMISSION_POLICY_UNREADABLE');
    assert.throws(() => policy.guardedToolNames([{ name: 'missing.effect' }]), error => error?.code === 'PERMISSION_POLICY_UNREADABLE');
  });

  check('Guarded derives its surface from every registry effect', () => {
    const names = new Set(policy.guardedToolNames(TOOL_REGISTRY));
    assert.ok(names.size > 0);
    for (const entry of TOOL_REGISTRY) {
      assert.equal(names.has(entry.name), policy.GUARDED_EFFECTS.includes(entry.effect), `${entry.name}: ${entry.effect}`);
    }
  });

  check('Guarded cannot construct either provider bypass argv', () => {
    assert.throws(() => codexArgs({ root: process.cwd(), tier: { model: 'test', effort: 'medium' }, permissionSession: GUARDED }),
      error => error?.code === 'PERMISSION_UNRESTRICTED_SPAWN_REFUSED');
    assert.throws(() => claudeArgs({ root: process.cwd(), tier: { cliModel: 'test' }, permissionSession: GUARDED }),
      error => error?.code === 'PERMISSION_UNRESTRICTED_SPAWN_REFUSED');
  });

  const localWrite = TOOL_REGISTRY.find(entry => entry.effect === 'local-write');
  assert.ok(localWrite, 'registry fixture must contain a local-write tool to exercise guarded refusal');
  await assert.rejects(
    () => executeTool(localWrite.name, {}, { permissionSession: GUARDED }),
    error => error?.code === 'PERMISSION_EFFECT_REFUSED' && error.details?.effect === 'local-write'
  );
  checks += 1;

  await assert.rejects(
    () => executeTool('not.registered.escape', {}, { permissionSession: GUARDED }),
    error => error?.code === 'UNKNOWN_TOOL'
  );
  checks += 1;

  let argvBuilderReached = 0;
  const actions = createMissionActions({
    roots: { isolated: process.cwd() },
    agentOrg: declaredOrg(),
    actor: enabledControllerId(declaredOrg()),
    permissionSession: GUARDED,
    policy: { assertActive() {} },
    codexArgs() { argvBuilderReached += 1; return ['--dangerously-bypass-approvals-and-sandbox']; },
    claudeArgs() { argvBuilderReached += 1; return ['--dangerously-skip-permissions']; }
  });
  await assert.rejects(() => actions.dispatch({
    rootId: 'isolated', tier: 'luna', objectiveRef: 'nested-escape', brief: 'attempt nested dispatch',
    cap: { kind: 'turns', value: 1, capMs: 60_000 }
  }), error => error?.code === 'PERMISSION_UNRESTRICTED_SPAWN_REFUSED');
  assert.equal(argvBuilderReached, 0, 'Guarded refusal must occur before either dangerous argv builder');
  checks += 2;

  console.log(`Guarded permission tier escape tests passed (${checks} checks).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
