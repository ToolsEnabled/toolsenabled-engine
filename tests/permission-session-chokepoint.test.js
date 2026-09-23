/* EXECUTABLE CHANGE
 *
 * CAN-FAIL REPORT (testcanfail-tests-permission-session-chokepoint-test-js)
 *
 * Strengthened assertions:
 * - Both policy-table loops used a bare catch to translate every exception into
 *   "refused". Mutation: permission-tier-policy assertToolAllowed threw
 *   `Error: MUTANT unrelated policy outage` for launch.execute. Before this
 *   change the entire file remained green: "permission-session chokepoint: 20
 *   checks passed, 0 failed." After this change the mutation is rejected with:
 *   "FAIL the unattended ceiling carries the confinable scheduled actions:
 *   launch.execute refusal must come from the confined tool policy"
 *   and "FAIL the unattended ceiling refuses every tool that runs
 *   caller-influenced code here: launch.execute refusal must come from the
 *   confined tool policy"; the run ends "18 checks passed, 2 failed."
 * - The product file was restored byte-for-byte after each mutation run
 *   (SHA-256 before/after:
 *   508bcff2e2152b28de000818b8b79523ec5fec223f91be8d0d38e0981a0cb81c).
 *   The restored run is green: "permission-session chokepoint: 20 checks
 *   passed, 0 failed."
 *
 * Shape census:
 * - EMPTY LOOP: NOT-FOUND. Both loops iterate populated literal expectation
 *   tables; the scheduled-actions loop also asserts exact key-set parity.
 * - EXIT STATUS / TRUTHY RETURN WITHOUT OWN OUTPUT: NOT-FOUND. This file makes
 *   in-process assertions and its final exit status only summarizes them.
 * - SWALLOWED FAILURE: FIXED in the two policy-table loops described above.
 *   The final async table was also passed to the synchronous `check` wrapper;
 *   it is now passed to `asyncCheck`, so its rejection is counted rather than
 *   detached. The getTool try/catch remains discriminating because its result
 *   is immediately required to be a registry entry.
 * - MOCK OF SUBJECT: NOT-FOUND. The runner test mocks dispatch as an observer,
 *   while its subject is the runner's permission-session wiring.
 * - SKIP / PLATFORM PRECONDITION: NOT-FOUND. No skip or platform guard exists.
 * - EXPECTED VALUE COMPUTED BY SUBJECT: NOT-FOUND. Expected tiers, profiles,
 *   actions, and refusal codes are independently stated literals.
 *
 * Named precondition: the default Node 20.20.2 lacks node:sqlite; mutation and
 * restored runs therefore used the installed Node 22.22.2 binary.
 */
'use strict';

// THE CHOKEPOINT: AN OMITTED PERMISSION SESSION MUST REFUSE, NOT DISPATCH.
//
// src/lib/tool-registry.js#executeTool() ran its tier check only
// `if (context.permissionSession !== undefined)`. A caller that omitted the
// session did not get a permissive tier -- it got NO TIER CHECK AT ALL, which
// is wider than the widest tier this program can name.
//
// Four lanes each found one instance of that shape in a single day and each
// fixed it at its own call site; the shape survived every time. This file pins
// the version that cannot be forgotten by the next caller: the refusal lives at
// the one function every dispatch passes through.
//
// It also pins the two things that make that refusal safe rather than merely
// strict -- that the unattended path gets a REAL ceiling rather than a hole,
// and that the ceiling is narrower than the interactive one.

const assert = require('node:assert/strict');

const registry = require('../src/lib/tool-registry');
const policy = require('../src/lib/permission-tier-policy');
const dispatchSession = require('../src/lib/dispatch-permission-session');
const jobRunner = require('../src/job-runner');

let checks = 0;
let failures = 0;

function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); checks += 1; }
  catch (error) { console.error(`  FAIL ${name}: ${error && error.message}`); failures += 1; }
}

async function asyncCheck(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`); checks += 1; }
  catch (error) { console.error(`  FAIL ${name}: ${error && error.message}`); failures += 1; }
}

// Two tools that differ ONLY in whether the unattended ceiling carries them, so
// a refusal below is attributable to the tier and not to anything else.
const PERMITTED_INTERACTIVELY = 'host.exec';
const PROBE_ARGUMENTS = Object.freeze({ command: '__chokepoint_probe__', args: [] });

async function main() {
  console.log('permission-session chokepoint');

  // --- 1. THE REFUSAL ITSELF -------------------------------------------------

  await asyncCheck('executeTool REFUSES a dispatch that states no permission session', async () => {
    await assert.rejects(
      () => registry.executeTool('system.status', {}),
      error => error?.code === 'PERMISSION_SESSION_REQUIRED',
      'an omitted session must refuse, not dispatch'
    );
  });

  await asyncCheck('the refusal names the tool, so an operator can see WHICH call was unbound', async () => {
    const error = await registry.executeTool('system.status', {}).then(() => null, e => e);
    assert.ok(error, 'the call must reject');
    assert.equal(error.details.tool, 'system.status');
    assert.match(error.message, /system\.status/);
  });

  // The refusal must land BEFORE the handler, not after it. A guard that runs
  // late still lets a local-read tool touch the machine first.
  await asyncCheck('the refusal precedes schema validation, so nothing runs on an unbound call', async () => {
    const error = await registry.executeTool('host.exec', { nonsense: true }).then(() => null, e => e);
    assert.equal(error?.code, 'PERMISSION_SESSION_REQUIRED',
      'a schema error here would mean the unbound call got past the ceiling first');
  });

  // An explicitly undefined session is the same absence as a missing key. This
  // is the shape a conditional spread produces (`...(x === undefined ? {} : ...)`)
  // and it must not read differently from omitting the property.
  await asyncCheck('an explicitly-undefined session refuses exactly like an absent one', async () => {
    await assert.rejects(
      () => registry.executeTool('system.status', {}, { permissionSession: undefined }),
      error => error?.code === 'PERMISSION_SESSION_REQUIRED'
    );
  });

  // A stated session still has to be a REAL one. `null`, `{}` and a made-up
  // tier must not satisfy the new requirement just by being present.
  for (const [label, value] of [
    ['null', null],
    ['an empty object', {}],
    ['an unknown tier', { origin: 'local', tier: 'superuser' }],
    ['a confined session with no profile', { origin: 'local', tier: 'confined' }]
  ]) {
    await asyncCheck(`stating ${label} does not satisfy the requirement`, async () => {
      await assert.rejects(
        () => registry.executeTool('system.status', {}, { permissionSession: value }),
        error => error?.name === 'PermissionTierRefusal' && error.code !== 'PERMISSION_SESSION_REQUIRED',
        'a malformed session must be refused by the policy, not accepted as "present"'
      );
    });
  }

  await asyncCheck('a stated, valid session still dispatches', async () => {
    const result = await registry.executeTool('system.status', {},
      { permissionSession: { origin: 'local', tier: 'full' } });
    assert.ok(result && typeof result === 'object', 'a bound owner call must still work');
  });

  // --- 2. THE AGENT EXECUTOR REFUSES AT CONSTRUCTION -------------------------

  check('createAgentToolExecutor refuses to be built without a ceiling', () => {
    assert.throws(() => registry.createAgentToolExecutor(),
      error => error?.code === 'PERMISSION_SESSION_REQUIRED');
    assert.throws(() => registry.createAgentToolExecutor({ agentActor: 'codex' }),
      error => error?.code === 'PERMISSION_SESSION_REQUIRED');
  });

  check('createAgentToolExecutor still builds a mediated executor when a ceiling is stated', () => {
    const executor = registry.createAgentToolExecutor({
      permissionSession: { origin: 'local', tier: 'full' }
    });
    assert.ok(registry.isMediatedAgentToolExecutor(executor),
      'the marker must survive, or AgentWorker will reject its own executor');
  });

  for (const cancellationOwner of ['operation', 'session']) {
    await asyncCheck(`agent executor observes ${cancellationOwner} cancellation after admission`, async () => {
      const operation = new AbortController();
      const session = new AbortController();
      let reachedHandlerBoundary = false;
      const executor = registry.createAgentToolExecutor({
        permissionSession: { origin: 'local', tier: 'full' },
        signal: session.signal,
        assertPermissionCurrent() {
          reachedHandlerBoundary = true;
          (cancellationOwner === 'operation' ? operation : session).abort();
        }
      });
      await assert.rejects(
        () => executor.execute('system.status', {}, { signal: operation.signal }),
        error => error?.name === 'AbortError' && error.code === 'ABORT_ERR',
        'cancellation after the first dispatch check must still prevent the handler'
      );
      assert.equal(reachedHandlerBoundary, true, 'exercise cancellation after admission, not before it');
    });
  }

  // --- 3. THE UNATTENDED CEILING IS REAL, AND NARROWER -----------------------

  check('the unattended ceiling is a stated tier, and it is not full', () => {
    const session = policy.session(dispatchSession.UNATTENDED_CEILING);
    assert.equal(session.tier, 'confined');
    assert.equal(session.profile, 'workspace');
    assert.notEqual(session.tier, 'full', 'an internal ceiling that means "everything" is not a ceiling');
  });

  check('a local FULL recorded level is clamped down for unattended work', () => {
    const session = dispatchSession.unattendedSession({
      machineRecord: {
        resolveServicesRoot: () => 'unused',
        readMachineRecord: () => ({ tier: 'unrestricted' })
      }
    });
    assert.equal(session.tier, 'confined');
    assert.equal(session.profile, 'workspace');
  });

  check('a recorded level that is ALREADY narrower is honoured, never widened', () => {
    const session = dispatchSession.unattendedSession({
      machineRecord: {
        resolveServicesRoot: () => 'unused',
        readMachineRecord: () => ({ tier: 'guided' })
      }
    });
    assert.equal(session.tier, 'confined');
    assert.equal(session.profile, 'read-only',
      'guided must stay read-only; clamping must not round a narrow level UP to workspace');
  });

  check('an unreadable machine record fails closed rather than open', () => {
    assert.throws(() => dispatchSession.unattendedSession({
      machineRecord: {
        resolveServicesRoot: () => 'unused',
        readMachineRecord: () => { throw new Error('record is corrupt'); }
      }
    }), /record is corrupt/, 'an unreadable record must refuse rather than manufacture a permission answer');
  });

  check('an absent machine record fails closed rather than open', () => {
    assert.throws(() => dispatchSession.unattendedSession({
      machineRecord: { resolveServicesRoot: () => 'unused', readMachineRecord: () => null }
    }), error => error?.code === 'PERMISSION_INSTALL_TIER_UNREADABLE');
  });

  // --- 4. THE DIFFERENTIAL THE WHOLE CHANGE IS FOR ---------------------------
  //
  // A tool PERMITTED interactively and REFUSED on the scheduled path. Without
  // this pair the clamp above could be any two words that happen to validate.

  check('host.exec is permitted interactively and refused on the unattended ceiling', () => {
    const entry = registry.getTool(PERMITTED_INTERACTIVELY);
    assert.ok(entry, 'the differential needs a real registry entry');

    // Interactive: a local owner session carries it.
    policy.assertToolAllowed(entry, { origin: 'local', tier: 'full' });

    // Scheduled: the same tool, the same registry, refused by the ceiling.
    assert.throws(() => policy.assertToolAllowed(entry, policy.session(dispatchSession.UNATTENDED_CEILING)),
      error => error?.code === 'PERMISSION_CONFINED_EXCLUSION_REFUSED');
  });

  // WHICH SCHEDULED ACTIONS THE CEILING STILL CARRIES, AND WHICH IT NO LONGER
  // DOES. This check used to assert that ALL eight supported scheduled actions
  // were admitted. Six still are. Two are not, and that is a deliberate,
  // owner-visible product decision rather than an accident, so it is pinned by
  // name here instead of being softened into a weaker assertion.
  //
  // `launch.execute` and `deployment.execute` are now UNCONFINABLE: they run a
  // project's own npm/yarn/pnpm lifecycle scripts and deploy hooks, which are
  // arbitrary code that no path fence bounds. dispatch-permission-session.js
  // had already recorded that a scheduled job with nobody watching could
  // "deploy infrastructure, apply a Terraform plan and execute a launch", and
  // recorded it as an open product decision. The confinement work answers it in
  // the safe direction: the one path with no human on it does not get to run
  // arbitrary project code.
  //
  // THIS IS A CAPABILITY CHANGE AND IT IS MEANT TO BE READ AS ONE. A scheduled
  // `launch.execute` job now refuses. If the owner wants it back, the honest
  // routes are to confine what those tools spawn, or to give the scheduler an
  // explicitly-approved per-job grant -- not to widen the ceiling back, which
  // would restore the escape for every scheduled job at once.
  // The title no longer counts the rows. It used to say "six", the table then
  // held seven, and the count is now five -- a number in the name rots on every
  // capability change while the deepEqual below is what actually holds the line.
  check('the unattended ceiling carries the confinable scheduled actions', () => {
    const { SUPPORTED_SCHEDULED_ACTIONS } = require('../src/lib/scheduled-actions');
    const session = policy.session(dispatchSession.UNATTENDED_CEILING);

    // telegram.send and telegram.worker_run were removed here because the
    // connector, its tools and its tables left the product in "Telegram is out"
    // (755dc91). They are not registered any more, so the rows asserted a
    // capability that cannot exist; keeping them made this table fail for a
    // reason that had nothing to do with the ceiling it guards.
    const expected = {
      'instagram.publish_image': 'admitted',
      'gmail.send': 'admitted',
      'calendar.create': 'admitted',
      'launch.execute': 'refused',
      'deployment.execute': 'refused'
    };
    // Replaces a `>= 7` floor that was really a guard against the action list
    // silently emptying. The deepEqual below already fails on an emptied list,
    // and unlike a magic number it also fails on a list that grew. This keeps
    // the loop from being vacuous without pinning a count.
    assert.ok(Object.keys(expected).length > 0,
      'the expected table is empty, so the loop below would assert nothing');
    assert.deepEqual(new Set(Object.keys(expected)), new Set(SUPPORTED_SCHEDULED_ACTIONS),
      'a scheduled action was added or removed without deciding whether the unattended ceiling carries it');

    for (const [action, want] of Object.entries(expected)) {
      const entry = registry.getTool(action);
      assert.ok(entry, `${action} must be registered`);
      let actual = 'admitted';
      let refusal = null;
      try { policy.assertToolAllowed(entry, session); }
      catch (error) { refusal = error; actual = 'refused'; }
      if (want === 'refused') {
        assert.equal(refusal?.code, 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED',
          `${action} refusal must come from the confined tool policy`);
      }
      assert.equal(actual, want,
        want === 'admitted'
          ? `${action} is now refused on the unattended path -- the scheduler just lost a capability`
          : `${action} is admitted on the unattended path again -- a scheduled job with no human present can run arbitrary project code`);
    }
  });

  // --- 5. THE SCHEDULED RUNNER ACTUALLY STATES IT ---------------------------
  //
  // Points 3 and 4 are about the ceiling. This is about whether job-runner.js
  // puts it on the call, which is the defect that was open.

  await asyncCheck('runScheduledInvocation states the unattended ceiling on its dispatch', async () => {
    const seen = [];
    const started = {
      // SUBJECT CHANGED: this drove telegram.send, which left the product with
      // the connector in 755dc91. gmail.send is a surviving SUPPORTED_SCHEDULED_
      // ACTION that the unattended ceiling admits, so the dispatch path is still
      // exercised against a real scheduled action rather than a removed one --
      // a stored action the runner no longer allowlists refuses before dispatch
      // and would prove nothing about the permission session on the call.
      runId: 'run-1', fence: 1, action: 'gmail.send', args: { to: 'someone@example.com', subject: 's', body: 'x' },
      job: { jobId: 'scheduler-job-a', name: 'a' }
    };
    await jobRunner.runScheduledInvocation({ jobId: 'scheduler-job-a', generation: 1 }, {
      state: {
        reapExpiredSchedulerRuns: () => {},
        startSchedulerRun: () => started,
        completeSchedulerRun: () => {}
      },
      assertActive: () => {},
      audit: { record: () => {}, redact: value => value },
      assertValid: () => {},
      getTool: () => ({ name: 'gmail.send', effect: 'external-write' }),
      machineRecord: {
        resolveServicesRoot: () => 'unused',
        readMachineRecord: () => ({ tier: 'unrestricted' })
      },
      executeTool: async (action, args, context) => { seen.push(context); return { ok: true }; }
    });
    assert.equal(seen.length, 1, 'the scheduled action must have dispatched exactly once');
    const session = seen[0].permissionSession;
    assert.ok(session, 'the scheduled dispatch must state a permission session');
    assert.equal(session.tier, 'confined');
    assert.equal(session.profile, 'workspace');
    assert.notEqual(session.tier, 'full',
      'an unrestricted machine must NOT hand its full ceiling to unattended work');
  });

  // WHAT THE UNATTENDED CEILING ACTUALLY REACHES, PINNED AS A TABLE.
  //
  // THE HISTORY MATTERS, because this table is the record of a defect being
  // closed. It was first written to pin a MEASURED embarrassment: the ceiling
  // claimed to remove "the entire permanent exclusion set from the one path
  // with no human on it", which reads as "unattended work cannot run a
  // program", and measured false -- `host.exec` was the only execution-shaped
  // tool the nine-name exclusion set named, and six other execution-capable
  // tools were admitted. The lane that measured it deliberately pinned the
  // wrong-looking truth rather than quietly narrowing the ceiling, and recorded
  // whether a scheduled job SHOULD be able to apply a Terraform plan as an open
  // product decision.
  //
  // The confinement work answers that question. The ceiling is confined tier,
  // and a confined tier now admits only tools with a recorded confinement class,
  // refusing the ones that execute caller-influenced code. Five of the six rows
  // that used to read `admitted` now read `refused`, each for a stated reason in
  // src/lib/confined-tool-surface.js.
  //
  // `sandbox.exec` stays admitted on purpose, and the contrast is the point of
  // keeping it in the table: it runs inside a leased container that IS the
  // confinement. "Execution-capable" was never the right axis -- reaching THIS
  // MACHINE outside the granted folder is.
  await asyncCheck('the unattended ceiling refuses every tool that runs caller-influenced code here', async () => {
    const ceiling = policy.session(dispatchSession.UNATTENDED_CEILING);
    const expected = {
      'host.exec': 'refused',              // permanent exclusion, unchanged
      'launch.execute': 'refused',         // runs the project's npm/yarn/pnpm lifecycle scripts
      'deployment.execute': 'refused',     // runs the project's deploy toolchain and hooks
      'terraform.apply': 'refused',        // executes provider plugins and local-exec provisioners
      'firebase.deploy': 'refused',        // runs firebase.json predeploy hooks
      'code.hover': 'refused',             // executes a language server from a caller-named root
      'sandbox.exec': 'admitted'           // the leased container IS the confinement
    };

    for (const [name, want] of Object.entries(expected)) {
      let entry;
      try { entry = registry.getTool(name); } catch { entry = null; }
      assert.ok(entry, `${name} is not registered; this table is stale and no longer measures anything`);

      let actual = 'admitted';
      let refusal = null;
      try { policy.assertToolAllowed(entry, ceiling); }
      catch (error) { refusal = error; actual = 'refused'; }

      if (want === 'refused') {
        const expectedCode = name === 'host.exec'
          ? 'PERMISSION_CONFINED_EXCLUSION_REFUSED'
          : 'PERMISSION_CONFINED_UNCONFINABLE_REFUSED';
        assert.equal(refusal?.code, expectedCode,
          `${name} refusal must come from the confined tool policy`);
      }

      assert.equal(actual, want,
        want === 'refused'
          ? `${name} is admitted on the unattended path again -- a scheduled job with nobody watching can run caller-influenced code outside the workspace`
          : `${name} is now refused on the unattended path -- if that was deliberate, the scheduler just lost a capability and dispatch-permission-session.js's table needs updating with it`);
    }
  });

  console.log(`\npermission-session chokepoint: ${checks} checks passed, ${failures} failed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
