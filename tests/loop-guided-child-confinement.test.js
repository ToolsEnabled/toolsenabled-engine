// REFUSED-CONTROL
/* testcanfail-tests-loop-guided-child-confinement-test-js
 *
 * PRECONDITION-NOT-MET: this repository requires Node >=22.19.0, but the
 * execution environment supplies Node v20.20.2. Loading this test stops in
 * state-store.js before any assertion runs:
 *
 *   Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite
 *
 * `nvm install 22` could not repair the precondition (`Version '22' not
 * found`), and `nvm ls-remote --lts` returned `N/A`. Consequently no honest
 * GREEN -> mutation RED -> restored GREEN control could be performed, and no
 * assertion was changed without that required evidence.
 *
 * NOT-FOUND (static inspection): an assertion inside a possibly-empty loop or
 * forEach; an exit-status/truthy-return assertion used in place of child-owned
 * output; a catch or optional chain swallowing the behavior under assertion;
 * an assertion against a mock of confinement/argv generation; a platform skip
 * or precondition guard; an expected value computed by the same confinement
 * builder it checks. The anchor/nested argv equality is backed independently
 * by literal guided and unrestricted argv assertions, so it is not such an
 * oracle.
 */

'use strict';

require('./lib/agent-api-mode-fixture').selectAgentApiMode('Enabled');

/* A LOOP MAY NOT WIDEN WHAT ITS CHILDREN MAY DO.
 *
 * This is the security-relevant half of the loop feature, and the half that
 * would be easiest to get wrong invisibly. A loop is N dispatches; nesting run
 * N under run 1 is the ONLY thing that distinguishes a loop run from the single
 * dispatch page 2 has always offered. If nesting could change the confinement
 * the child is spawned under, then "start a loop" would be a route to capability
 * the installed permission tier denies -- and nothing on screen would say so.
 *
 * WHAT IS ASSERTED, AND WHY IT IS ASSERTED THIS WAY.
 *
 * The tier of the SCHEDULING CALL proves nothing: the caller can ask for
 * anything. What matters is what the spawned child was actually given. So this
 * suite lets a real lane spawn a real child process and asserts THE ARGV THE
 * CHILD ITSELF RECORDED -- read back out of a file the child wrote -- rather
 * than the argv the parent believes it passed, or a return value, or a mock.
 *
 * The fixture rides in `prefixArgs`, which the dispatch path composes ahead of
 * the generated arguments (src/lib/mission-bridge/actions.js:628), so the
 * confinement flags under test are the ones the product's own argv builder
 * produced. Nothing about the argv is injected by this test.
 *
 * THE CONTROL THAT MAKES THE ASSERTION LOAD-BEARING. Asserting that a guided
 * child carries `--sandbox read-only` is worth nothing unless a DIFFERENT tier
 * would have produced something else. So the unrestricted argv is built too and
 * asserted to differ in exactly that place. Without that control this suite
 * would pass against a builder that emitted `--sandbox read-only`
 * unconditionally, which is precisely the bug it exists to catch.
 */

const isolated = require('./lib/isolated-environment').activate('loop-guided-child-confinement');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const presence = require('../src/lib/agent-presence');
const permissionTierPolicy = require('../src/lib/permission-tier-policy');
const { codexArgs, claudeArgs, createMissionActions } = require('../src/lib/mission-bridge/actions');
const { createStateStore } = require('../src/lib/state-store');
const { declaredOrg, enabledControllerId } = require('./helpers/declared-org');

void isolated;

const ROOT = path.resolve(__dirname, '..');
const LANE_FIXTURE = path.join(__dirname, 'fixtures', 'loop-confinement-lane.js');

const GUIDED = permissionTierPolicy.installTierSession('guided');
const UNRESTRICTED = permissionTierPolicy.installTierSession('unrestricted');

let assertions = 0;
const equal = (actual, expected, message) => { assertions += 1; assert.equal(actual, expected, message); };
const check = (value, message) => { assertions += 1; assert.ok(value, message); };
const deep = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };

function auditFixture() {
  const events = [];
  const append = (action, target, details, extra = {}) => {
    const sequence = events.length + 1;
    const event = { action, target, details, sequence, ...extra };
    event.eventHash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
    events.push(event);
    return event;
  };
  return {
    events,
    requireRecord(action, target, details) {
      const event = append(action, target, details);
      return { durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash };
    },
    findEvents({ action, target, limit = 100 } = {}) {
      return events.filter(event => (!action || event.action === action) && (!target || event.target === target)).slice(-limit);
    },
    tail(limit = 200) { return events.slice(-limit); },
    conditionalRecord({ action, target, eventId, decide }) {
      const outcome = decide({ findEvents: this.findEvents.bind(this), nowMs: Date.now() });
      if (outcome.kind === 'refused') return { recorded: false, refusal: outcome.refusal };
      const event = append(action, target, outcome.details, { eventId });
      return { recorded: true, durable: true, anchored: true, sequence: event.sequence, eventHash: event.eventHash, value: outcome.value };
    }
  };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(read, accept, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = read(); if (accept(last)) return last; }
    catch (error) { last = error; }
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}; last=${last?.message || JSON.stringify(last)}`);
}

/* The argv the CHILD recorded, with the fixture's own prefix removed, so what
   is compared is exactly the product-generated portion. */
function childGeneratedArgv(captureFile) {
  const raw = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  check(Array.isArray(raw.argv) && raw.argv.length > 1, 'the child recorded an argv with a generated portion');
  return raw.argv.slice(1);
}

async function main() {
  /* ---------------------------------------------------------------
     1 · the control: guided and unrestricted argv genuinely differ
     --------------------------------------------------------------- */

  const guidedCodex = codexArgs({ root: ROOT, tier: { model: 'm', effort: 'medium' }, permissionSession: GUIDED });
  const fullCodex = codexArgs({ root: ROOT, tier: { model: 'm', effort: 'medium' }, permissionSession: UNRESTRICTED });

  equal(guidedCodex.includes('--sandbox'), true, 'a guided codex lane must be sandboxed');
  equal(guidedCodex[guidedCodex.indexOf('--sandbox') + 1], 'read-only', 'a guided codex lane must be read-only');
  equal(guidedCodex.includes('--dangerously-bypass-approvals-and-sandbox'), false, 'a guided codex lane must not bypass the sandbox');
  /* The control. If this ever matches guided, every guided assertion here is
     vacuous and this suite must fail rather than reassure. */
  equal(fullCodex.includes('--dangerously-bypass-approvals-and-sandbox'), true, 'unrestricted must still be the bypassing argv, or the guided assertions above prove nothing');
  equal(fullCodex.includes('--sandbox'), false, 'unrestricted does not name a sandbox');

  const guidedClaude = claudeArgs({ root: ROOT, tier: { cliModel: 'c' }, permissionSession: GUIDED });
  const fullClaude = claudeArgs({ root: ROOT, tier: { cliModel: 'c' }, permissionSession: UNRESTRICTED });
  equal(guidedClaude[guidedClaude.indexOf('--permission-mode') + 1], 'plan', 'a guided claude lane runs in plan mode');
  equal(guidedClaude.includes('--dangerously-skip-permissions'), false, 'a guided claude lane must not skip permissions');
  equal(fullClaude.includes('--dangerously-skip-permissions'), true, 'unrestricted claude must still skip permissions, or the guided claude assertions prove nothing');

  /* The argv builders take no parent: nesting CANNOT reach confinement, which is
     a structural guarantee rather than an observed coincidence. */
  equal(/parentLaunchId/.test(String(codexArgs)), false, 'the codex argv builder must not read a parent launch');
  equal(/parentLaunchId/.test(String(claudeArgs)), false, 'the claude argv builder must not read a parent launch');

  /* ---------------------------------------------------------------
     2 · a real guided child, spawned twice: alone, then nested
     --------------------------------------------------------------- */

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-guided-confinement-'));
  const stateFile = path.join(root, 'isolated-state', 'agent-presence.json');
  const anchorCapture = path.join(root, 'anchor-argv.json');
  const nestedCapture = path.join(root, 'nested-argv.json');
  const taskState = createStateStore({ file: path.join(root, 'isolated-state', 'tasks.sqlite3'), ownerId: 'loop-guided-confinement' });
  const auditApi = auditFixture();
  const previousTestMode = process.env.TOOLSENABLED_LANE_RUN_TEST;
  process.env.TOOLSENABLED_LANE_RUN_TEST = '1';

  let capture = anchorCapture;
  const org = declaredOrg();
  const actions = createMissionActions({
    roots: { isolated: root },
    actor: enabledControllerId(org), agentOrg: org,
    audit: auditApi,
    policy: { assertActive() {} },
    permissionSession: GUIDED,
    env: { PATH: process.env.PATH },
    laneDependencies: {
      stateFile,
      mailboxDir: path.join(root, 'isolated-state', 'mailbox'),
      launchDir: path.join(root, 'isolated-state', 'launch'),
      taskDependencies: { state: taskState, auditRecord: () => {} }
    },
    /* The fixture is a PREFIX argument, so the generated confinement argv
       follows it untouched and reaches the real spawn. */
    resolveCommand: () => ({ command: process.execPath, prefixArgs: [LANE_FIXTURE, capture] }),
    spawn(command, args, options) { return spawn(command, args, options); }
  });

  try {
    const anchor = await actions.dispatch({
      rootId: 'isolated',
      tier: 'luna',
      objectiveRef: 'loop-anchor',
      brief: 'anchor run of a guided loop',
      cap: { kind: 'turns', value: 1, capMs: 60_000 }
    });
    equal(anchor.receipt.action, 'dispatch', 'the anchor run dispatched');
    await waitFor(() => fs.existsSync(anchorCapture), value => value === true, 'anchor child argv capture');
    await waitFor(() => presence.readRegistry(stateFile).agents.luna.status,
      status => status !== 'running', 'anchor lane to go terminal');

    capture = nestedCapture;
    const nested = await actions.dispatch({
      rootId: 'isolated',
      tier: 'luna',
      objectiveRef: 'loop-run-2',
      brief: 'anchor run of a guided loop',
      cap: { kind: 'turns', value: 1, capMs: 60_000 },
      parentLaunchId: anchor.receipt.launchId
    });
    equal(nested.receipt.action, 'dispatch', 'the nested run dispatched');
    await waitFor(() => fs.existsSync(nestedCapture), value => value === true, 'nested child argv capture');

    /* THE ASSERTION THIS FILE EXISTS FOR. Both children recorded their own argv;
       a loop run is confined exactly as a single dispatch is. */
    const anchorArgv = childGeneratedArgv(anchorCapture);
    const nestedArgv = childGeneratedArgv(nestedCapture);
    deep(nestedArgv, anchorArgv, 'a nested loop run must be spawned with exactly the argv a single dispatch is');
    equal(nestedArgv[nestedArgv.indexOf('--sandbox') + 1], 'read-only',
      'the CHILD of a guided loop run must be read-only sandboxed');
    equal(nestedArgv.includes('--dangerously-bypass-approvals-and-sandbox'), false,
      'a guided loop child must never carry the sandbox bypass');
    /* And the nesting really did happen -- otherwise the equality above would be
       comparing two identical unnested dispatches and proving nothing. Read from
       the durable launch record the engine itself wrote
       (controller-launch-record.js:34, details.record), not from the receipt. */
    const launchRecord = launchId => auditApi.events
      .filter(event => event.action === 'controller.agent.launch' && event.target === launchId)
      .map(event => event.details && event.details.record)
      .find(Boolean);

    const anchorRecord = launchRecord(anchor.receipt.launchId);
    const nestedRecord = launchRecord(nested.receipt.launchId);
    check(anchorRecord, 'the anchor run must have a durable launch record');
    check(nestedRecord, 'the nested run must have a durable launch record');
    /* Positive on the anchor first: it is depth 0 with no parent, so the nested
       assertions below are measuring a real difference rather than passing on a
       pair that were both nested or both not. */
    equal(anchorRecord.parentLaunchId, null, 'the anchor run is a root launch');
    equal(anchorRecord.depth, 0, 'the anchor run is at depth 0');
    equal(nestedRecord.parentLaunchId, anchor.receipt.launchId, 'the nested run names the anchor as its parent');
    equal(nestedRecord.depth, 1, 'the nested run is one level deep, which is what arms the fan-out cap');

    console.log(`Loop guided-child confinement tests passed (${assertions} assertions).`);
  } finally {
    if (previousTestMode === undefined) delete process.env.TOOLSENABLED_LANE_RUN_TEST;
    else process.env.TOOLSENABLED_LANE_RUN_TEST = previousTestMode;
    try { taskState.close?.(); } catch { /* cleanup must not decide the verdict */ }
    /* Cleanup must never fail the run: Windows holds handles briefly after a
       child exits, and a suite that exits 1 after every assertion passed is a
       suite nobody can read. */
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch { /* the temp directory is the OS's problem, not this verdict's */ }
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
