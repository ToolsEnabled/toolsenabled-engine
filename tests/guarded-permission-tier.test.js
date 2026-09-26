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

  /* THE SURFACE IS THE EFFECT FILTER MINUS WHAT CANNOT BE CONFINED.
   *
   * This asserted membership was EXACTLY the effect filter, which was true and
   * was the defect: the Guarded branch of assertToolAllowed consulted no
   * confinement table, so eight tools classified 'unconfinable' -- every one of
   * which the confined tiers refuse -- were carried on the remote (FRA) surface.
   * The predicate is widened here rather than deleted, so it still pins that
   * effect governs membership, and the case below pins that the table does too. */
  check('Guarded derives its surface from every registry effect, less the unconfinable', () => {
    const surface = require('../src/lib/confined-tool-surface');
    const names = new Set(policy.guardedToolNames(TOOL_REGISTRY));
    assert.ok(names.size > 0);
    let excludedByClass = 0;
    for (const entry of TOOL_REGISTRY) {
      const allowedByEffect = policy.GUARDED_EFFECTS.includes(entry.effect);
      const confinable = surface.classify(entry.name) !== 'unconfinable';
      if (allowedByEffect && !confinable) excludedByClass += 1;
      assert.equal(names.has(entry.name), allowedByEffect && confinable, `${entry.name}: ${entry.effect}`);
    }
    // Without this the widened predicate would also pass if the table stopped
    // excluding anything at all.
    assert.ok(excludedByClass > 0,
      'no tool was excluded by confinement class, so this case no longer proves the table is consulted');
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

  /* THE GUARDED TIER MUST NOT CARRY A TOOL NO CONFINED TIER WILL TOUCH.
   *
   * assertToolAllowed routes 'manifest', 'confined' and 'full' to their own
   * checkers, and the confined one consults the confinement table. Guarded fell
   * through to a bare GUARDED_EFFECTS.includes(entry.effect) and returned, so
   * the table was never consulted for it -- and guardedToolNames() resolves
   * { origin: 'remote', tier: 'guarded' }, which is the Full Remote Access
   * surface. MEASURED on this build before the fix: of 115 tools admitted there,
   * EIGHT are classified 'unconfinable', and the confined tier refuses all eight.
   * Seven execute a language-server binary resolved from the CALLER-supplied
   * root; the eighth reaches other applications outside a granted workspace.
   *
   * tests/remote-surface-tier-parity.test.js cannot see this: it checks the
   * advertised surface against guardedToolNames(), so when the policy itself is
   * too permissive both sides agree and it stays green. This asserts the policy
   * against the confinement contract instead. */
  {
    const surface = require('../src/lib/confined-tool-surface');
    const entries = require('../src/lib/tool-registry').registeredTools();
    const admitted = policy.guardedToolNames(entries);
    assert.ok(admitted.length > 0, 'the guarded surface must not be empty, or the check below proves nothing');

    const unconfinable = admitted.filter(name => surface.classify(name) === 'unconfinable');
    assert.deepEqual(unconfinable, [],
      `the guarded remote tier admits tools that cannot be confined: ${unconfinable.join(', ')}`);
    checks += 2;

    /* THE CONTROL. A guarded tier that refused everything would satisfy the line
       above while deleting the remote surface, so pin that its ordinary
       read-only content is still carried. These five are named in the
       GUARDED_EFFECTS comment as the tier's deliberate content. */
    for (const name of ['host.read_file', 'repo.read_file', 'host.list_dir', 'repo.list_dir', 'clipboard.read']) {
      assert.ok(admitted.includes(name), `the guarded tier must still carry ${name}`);
      checks += 1;
    }
  }

  /* A CLASSIFICATION THAT COULD NOT BE MADE MUST REFUSE, NOT ADMIT.
   *
   * The first version of the guarded confinement check caught a classify()
   * failure and left the class null, which fell through to the effect filter and
   * admitted the tool -- the same fail-open the check exists to close,
   * reintroduced by its own error handling. Driven here by making the module's
   * classify throw, because no ordinary input can: it is a table lookup that
   * returns null for a non-string. The realistic cause is the confinement module
   * failing to load, which is exactly when nothing has been checked. */
  check('Guarded refuses a tool whose confinement class cannot be read', () => {
    const surfacePath = require.resolve('../src/lib/confined-tool-surface');
    const surface = require('../src/lib/confined-tool-surface');
    const realClassify = surface.classify;
    const cached = require.cache[surfacePath];
    // classify is exported on a frozen object, so swap the module's cached
    // exports for one whose classify throws, then restore it.
    require.cache[surfacePath] = { ...cached, exports: { ...surface, classify() { throw new Error('table unavailable'); } } };
    try {
      const readOnly = TOOL_REGISTRY.find(entry => policy.GUARDED_EFFECTS.includes(entry.effect));
      assert.ok(readOnly, 'the registry must carry a read-only tool for this case to mean anything');
      assert.throws(() => policy.assertToolAllowed(readOnly, { origin: 'remote', tier: 'guarded' }),
        error => error?.code === 'PERMISSION_GUARDED_UNCONFINABLE_REFUSED',
        'an unreadable confinement class must refuse the tool, never admit it by effect');
      checks += 2;
    } finally {
      require.cache[surfacePath] = cached;
      assert.equal(require('../src/lib/confined-tool-surface').classify, realClassify,
        'the real classify must be restored, or every later case is measuring a stub');
    }
  });

  console.log(`Guarded permission tier escape tests passed (${checks} checks).`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
