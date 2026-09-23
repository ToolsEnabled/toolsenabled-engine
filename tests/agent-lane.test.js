// EXECUTABLE CHANGE
'use strict';

/* TEST-CAN-FAIL AUDIT (testcanfail-tests-agent-lane-test-js)
 *
 * SAME-CODE EXPECTATION — FOUND AND FIXED. Three assertions derived the public
 * environment name from laneScope.ENV_VAR, the same product constant whose
 * spelling they purported to check. Mutation: in a scratch edit, changed that
 * constant from TOOLSENABLED_LANE_SCOPE to TOOLSENABLED_WRONG_SCOPE. Before
 * this fix the collision test stayed green. With literal contract expectations,
 * the strengthened assertions went RED:
 *
 *   "the lane scope fence reached the child
 *    + undefined
 *    - 'lane-scope-document'"
 *
 *   "exactly one lane-scope spelling reaches the child ...
 *    + 'TOOLSENABLED_WRONG_SCOPE'
 *    - 'TOOLSENABLED_LANE_SCOPE'"
 *
 *   "agent-lane.js sets a lane-local variable ...
 *    + [ 'TOOLSENABLED_LANE_SCOPE' ]
 *    - []"
 *
 * RESTORATION — the mutated src/lib/lane-scope.js was restored byte-for-byte;
 * its before/after SHA-256 was
 * 194e6598f7dacad7fa8915d400a5bfcf454386787dfde3699316f2ccbd66aa1f.
 * The restored full-file run was GREEN: "# pass 8" and "# fail 0".
 *
 * EMPTY ITERATION — NOT-FOUND. The credential loop consumes a non-empty array
 * literal; the scope-enumeration loop is followed by a deep equality that fails
 * on an empty result; and the source-match loop has a minimum-size assertion.
 * EXIT-STATUS/TRUTHY-SUBJECT-OUTPUT — NOT-FOUND. No child process is used as
 * test evidence, and truthy checks validate locally inspected source positions.
 * SWALLOWED FAILURE — NOT-FOUND. There is no try/catch or optional chaining.
 * SELF-MOCK — NOT-FOUND. Injected spawn plumbing captures adapter output; it
 * does not mock laneChildEnvironment, the behavior under test.
 * SKIP/PRECONDITION NO-OP — NOT-FOUND. There are no skips or platform guards.
 * The repository's default Node 20 cannot load node:sqlite; the declared Node
 * >=22 precondition was met with /root/.nvm/versions/node/v22.22.2/bin/node.
 */

/* THE LANE CHILD'S ENVIRONMENT: PROVENANCE IN, CREDENTIALS OUT.
 *
 * src/lib/mission-bridge/agent-lane-dispatch.js sits between the lane runtime
 * (src/lib/agent-lane.js, which builds the child env) and the OS. It used to
 * spread `...options` and then OVERWRITE env with
 * `{ ...cleanEnvironment, TOOLSENABLED_AGENT_ID }`, so everything else the lane
 * had just computed -- role, tier, project root, onboarding packet version and
 * hash, the launcher-provenance marker and the lane scope fence -- was silently
 * dropped on the floor for every app-dispatched child.
 *
 * These cases pin BOTH halves of the fix, because either one alone is a defect:
 * the provenance block has to survive the merge, and the merge must not become
 * a side door that walks the app's credential scrub backwards. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const laneDispatch = require('../src/lib/mission-bridge/agent-lane-dispatch.js');
const agentLane = require('../src/lib/agent-lane.js');
const laneScope = require('../src/lib/lane-scope.js');
const { presentEnvNames } = require('../src/lib/env-scrub.js');

const REPO_ROOT = path.resolve(__dirname, '..');

test('console tail distinguishes "no verdict happened" from "the read could not be established"', () => {
  const readable = {
    statSync: () => ({ size: 18 }),
    openSync: () => 7,
    readSync(handle, buffer) {
      assert.equal(handle, 7);
      buffer.write('ordinary log line\n');
      return 18;
    },
    closeSync: () => {}
  };
  assert.equal(agentLane.extractVerdict(agentLane.readTail('lane.log', 64, readable)), null,
    'a completely read console can establish that no verdict happened');

  const unclosable = {
    ...readable,
    closeSync() {
      const error = new Error('the descriptor close could not be established');
      error.code = 'EIO';
      throw error;
    }
  };
  assert.throws(() => agentLane.readTail('lane.log', 64, unclosable),
    error => error.code === 'EIO',
    'a failed console operation must not render as the same definite negative');
});

// What agent-lane.js:spawnChild hands the adapter: a scrubbed ambient base plus
// the lane-local block, in that order. Only the shape matters here.
function laneBuiltEnvironment(extra = {}) {
  return {
    PATH: 'C:\\ambient\\path',
    TOOLSENABLED_AGENT_ID: 'luna',
    TOOLSENABLED_AGENT_ROLE: 'builder',
    TOOLSENABLED_AGENT_TIER: 'opus',
    TOOLSENABLED_PROJECT_ROOT: 'C:\\worktrees\\lane',
    TOOLSENABLED_ONBOARDING_PACKET_VERSION: 'v1',
    TOOLSENABLED_ONBOARDING_PACKET_HASH: 'a'.repeat(64),
    TOOLSENABLED_ONBOARDING_LAUNCHER_PROVENANCE: 'launcher-bound',
    [laneScope.ENV_VAR]: 'lane-scope-document',
    ...extra
  };
}

function fakeChild() {
  return {
    pid: 4242,
    once() { return this; },
    kill() {}
  };
}

/* Drives the REAL boundedSpawn closure the adapter installs, through the real
 * startAgentLane wiring, rather than reaching into a private function: the
 * defect lived in the closure, so the closure is what has to be exercised. */
function dispatchAndCaptureChildEnvironment(cleanEnvironment, callerEnvironment, platform = 'win32') {
  let captured = null;
  const runLane = (laneOptions, laneDependencies) => {
    laneDependencies.spawnImpl('claude.exe', ['-p'], {
      cwd: 'C:\\worktrees\\lane',
      env: callerEnvironment,
      stdio: ['pipe', 1, 2]
    });
    return Promise.resolve({ terminal: { status: 'finished', exitCode: 0 } });
  };
  const execution = laneDispatch.startAgentLane({ agentId: 'luna' }, {
    runLane,
    presence: { heartbeat: () => ({ status: 'running' }) },
    platform,
    spawnImpl: (command, args, options) => {
      if (platform === 'win32') throw new Error('raw Windows spawn bypassed the Job Object seam');
      captured = options;
      return fakeChild();
    },
    spawnInJobImpl: (command, args, options) => { captured = options; return fakeChild(); },
    env: cleanEnvironment,
    capMs: 60_000,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {}
  });
  return { captured: () => captured, completion: execution.completion };
}

test('every launcher-built provenance variable survives app dispatch', async () => {
  const run = dispatchAndCaptureChildEnvironment({ PATH: 'C:\\app\\path' }, laneBuiltEnvironment());
  await run.completion;
  const childEnv = run.captured().env;

  assert.equal(childEnv.TOOLSENABLED_AGENT_ID, 'luna');
  assert.equal(childEnv.TOOLSENABLED_AGENT_ROLE, 'builder', 'role reached the child');
  assert.equal(childEnv.TOOLSENABLED_AGENT_TIER, 'opus', 'tier reached the child');
  assert.equal(childEnv.TOOLSENABLED_PROJECT_ROOT, 'C:\\worktrees\\lane', 'project root reached the child');
  assert.equal(childEnv.TOOLSENABLED_ONBOARDING_PACKET_VERSION, 'v1', 'packet version reached the child');
  assert.equal(childEnv.TOOLSENABLED_ONBOARDING_PACKET_HASH, 'a'.repeat(64), 'packet hash reached the child');
  assert.equal(childEnv.TOOLSENABLED_ONBOARDING_LAUNCHER_PROVENANCE, 'launcher-bound', 'launcher provenance reached the child');
  assert.equal(childEnv.TOOLSENABLED_LANE_SCOPE, 'lane-scope-document', 'the lane scope fence reached the child');

  // The app's own scrubbed base is still the base for everything else.
  assert.equal(childEnv.PATH, 'C:\\app\\path', 'the app-scrubbed environment remains the base');
  assert.equal(run.captured().cwd, 'C:\\worktrees\\lane', 'the caller spawn options are still spread');
  assert.equal(run.captured().windowsHide, true);
  assert.equal(run.captured().shell, false);
});

test('the non-Windows fallback keeps terminal suppression explicit at the spawn boundary', async () => {
  const run = dispatchAndCaptureChildEnvironment(
    { PATH: '/opt/toolsenabled/bin' },
    laneBuiltEnvironment({ PATH: '/usr/bin' }),
    'linux'
  );
  await run.completion;
  assert.equal(run.captured().windowsHide, true,
    'portable fallback launches remain hidden when this path is statically audited for Windows packaging');
  assert.equal(run.captured().shell, false, 'the portable fallback never widens into a shell launch');
});

test('a credential-shaped variable supplied through options.env never reaches the child', async () => {
  const callerEnvironment = laneBuiltEnvironment({
    GITHUB_TOKEN: 'must-not-reach-child',
    HELPDESK_PASSWORD: 'must-not-reach-child',
    SESSION_COOKIE: 'must-not-reach-child',
    TOOLSENABLED_SUPPORT_API_KEY: 'must-not-reach-child',
    TOOLSENABLED_ONBOARDING_PACKET_HASH: 'b'.repeat(64)
  });
  // The app deliberately removed these names before dispatch; the merge must
  // not put them back through the caller side.
  const run = dispatchAndCaptureChildEnvironment({ PATH: 'C:\\app\\path' }, callerEnvironment);
  await run.completion;
  const childEnv = run.captured().env;

  for (const name of ['GITHUB_TOKEN', 'HELPDESK_PASSWORD', 'SESSION_COOKIE', 'TOOLSENABLED_SUPPORT_API_KEY']) {
    assert.deepEqual(presentEnvNames(childEnv, [name]), [], `${name} was re-admitted through options.env`);
  }
  assert.equal(
    JSON.stringify(childEnv).includes('must-not-reach-child'), false,
    'no credential-shaped value survived in any spelling'
  );
  assert.equal(childEnv.TOOLSENABLED_ONBOARDING_PACKET_HASH, 'b'.repeat(64), 'the contract still forwards');
});

test('a Codex identity pin in the app environment outranks the ambient one the lane carried', () => {
  const childEnv = laneDispatch.laneChildEnvironment(
    { PATH: 'C:\\app\\path', CODEX_HOME: 'C:\\owner\\designated-codex' },
    laneBuiltEnvironment({ CODEX_HOME: 'C:\\whatever\\ambient-codex' })
  );
  assert.equal(childEnv.CODEX_HOME, 'C:\\owner\\designated-codex', 'the owner pin must win over the ambient value');
});

test('the launcher wins on a provenance collision, in every casing', () => {
  const childEnv = laneDispatch.laneChildEnvironment(
    {
      PATH: 'C:\\app\\path',
      TOOLSENABLED_PROJECT_ROOT: 'C:\\dispatcher\\root',
      toolsenabled_lane_scope: 'dispatcher-scope'
    },
    laneBuiltEnvironment()
  );
  assert.equal(childEnv.TOOLSENABLED_PROJECT_ROOT, 'C:\\worktrees\\lane', "the child's own root, not the dispatcher's");
  const scopeSpellings = [];
  for (const key in childEnv) {
    if (key.toLowerCase() === laneScope.ENV_VAR.toLowerCase()) scopeSpellings.push([key, childEnv[key]]);
  }
  assert.deepEqual(scopeSpellings, [['TOOLSENABLED_LANE_SCOPE', 'lane-scope-document']],
    'exactly one lane-scope spelling reaches the child, and it is the launcher-built one');
});

test('the billing tripwire still refuses a launch environment that carries a credential', () => {
  assert.throws(
    () => laneDispatch.laneChildEnvironment({ ANTHROPIC_API_KEY: 'sk-should-refuse' }, laneBuiltEnvironment()),
    error => error.code === 'LAUNCH_BILLING_CREDENTIAL_PRESENT'
  );
});

test('an absent or non-object caller environment degrades to the scrubbed base', () => {
  assert.deepEqual(laneDispatch.laneChildEnvironment({ PATH: 'p' }, undefined), { PATH: 'p' });
  assert.deepEqual(laneDispatch.laneChildEnvironment({ PATH: 'p' }, 'not-an-object'), { PATH: 'p' });
  assert.deepEqual(laneDispatch.laneChildEnvironment({}, { TOOLSENABLED_AGENT_ID: 7 }), {},
    'a non-string value is not an environment value');
});

/* DRIFT GUARD. The forwarding contract is an allowlist, and an allowlist that
 * nobody updates is how the original defect looked from the inside: correct
 * where someone remembered. This reads the lane runtime's own spawn env block
 * and fails if it grows a lane-local variable the adapter would drop. */
test('the forwarding contract covers every lane-local variable agent-lane.js sets', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'lib', 'agent-lane.js'), 'utf8');
  const start = source.indexOf('function spawnChild');
  assert.ok(start !== -1, 'spawnChild is still the lane spawn site');
  const end = source.indexOf('\nfunction ', start + 1);
  const spawnChildSource = source.slice(start, end === -1 ? source.length : end);

  const declared = new Set();
  for (const match of spawnChildSource.matchAll(/^\s*(TOOLSENABLED_[A-Z0-9_]+)\s*:/gm)) declared.add(match[1]);
  assert.ok(declared.size >= 7, `expected the lane-local block, found ${declared.size} names`);
  if (/\[laneScope\.ENV_VAR\]\s*:/.test(spawnChildSource)) declared.add('TOOLSENABLED_LANE_SCOPE');

  const contract = new Set(laneDispatch.LANE_PROVENANCE_ENV_NAMES);
  const dropped = [...declared].filter(name => !contract.has(name));
  assert.deepEqual(dropped, [],
    'agent-lane.js sets a lane-local variable that agent-lane-dispatch.js would discard');
});

/* The owner's R-ledger lineage for a lane child (owner design 2026-08-15,
 * "tree is every agent connected below that agent period"): the child is its
 * own session and thread; its tree ancestors are the launcher's chain plus the
 * launcher, oldest first, and never a sibling or anything above the launcher.
 * The three TOOLSENABLED_{SESSION_ID,THREAD_ID,TREE_ANCESTORS} names must
 * ALSO ride the app-dispatch forwarding contract, or app-spawned children boot
 * without their ancestry -- the drift guard above catches that. */
test('a lane child inherits its ancestors\' tree ledgers plus the launcher, and is its own session and thread', () => {
  const lane = require('../src/lib/agent-lane.js');
  const lineage = lane.ledgerLineage({ agentId: 'worker-7' }, {
    TOOLSENABLED_AGENT_ID: 'manager-2',
    TOOLSENABLED_TREE_ANCESTORS: 'root-1'
  });
  assert.deepEqual(lineage, { sessionId: 'worker-7', threadId: 'worker-7', treeAnchors: ['root-1', 'manager-2'] });

  const atRoot = lane.ledgerLineage({ agentId: 'root-1' }, {});
  assert.deepEqual(atRoot.treeAnchors, [], 'a tree root has no ancestors');

  const hostile = lane.ledgerLineage({ agentId: 'worker-7' }, {
    TOOLSENABLED_AGENT_ID: '../etc',
    TOOLSENABLED_TREE_ANCESTORS: 'ok-1, bad path here ,ok-2'
  });
  assert.deepEqual(hostile.treeAnchors, ['ok-1', 'ok-2'], 'unsafe spellings never become ledger keys');
});
