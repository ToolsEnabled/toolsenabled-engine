// EXECUTABLE CHANGE
// testcanfail-tests-fleet-supervisor-js
//
// Strengthened assertions and mutation evidence:
// - CLI plan exclusion census: mutated tools/fleet-supervisor.js so `notOpen`
//   was always `[]`. RED: "AssertionError [ERR_ASSERTION]: --plan reports at
//   least one excluded phase, so the exclusion-status assertion executes".
// - Worktree retention second pass: mutated worktree.js so an empty active-lane
//   list retained every candidate. RED: "AssertionError [ERR_ASSERTION]: the
//   second prune removes at least one superseded fleet worktree, so the
//   namespace assertion executes".
// - Restored both mutated product files byte-for-byte before the final run.
//   GREEN: "fleet-supervisor tests passed (462 checks)."
//
// Census: NOT-FOUND (2) exit-status/truthy-only evidence; NOT-FOUND (3)
// swallowed target failure; NOT-FOUND (4) assertion against a mock of its own
// subject; NOT-FOUND (5) whole-file skip/platform guard; NOT-FOUND (6) expected
// value computed by the same subject code. Shape (1) had the two cases above;
// all other assertion loops either use fixed non-empty inputs or have an
// independent cardinality assertion.
// Portability: queue and Vertex-account inputs are owned fixtures. No live
// BUILD-QUEUE, global Gemini settings, or installation credential metadata is
// read by this suite.

'use strict';

// Tests for the persistent Gemini fleet supervisor.
//
// Covers the six behaviours the supervisor exists to guarantee:
//   1. concurrency limiting            (N lanes filled, never N+1)
//   2. atomic claiming                 (no double-claim, in-process and cross-process)
//   3. crash/restart resume            (no duplicate dispatch, no lost in-flight lane)
//   4. retry capping                   (a permanently failing item parks with a reason)
//   5. the worktree-reaping guard      (the four protected worktrees are unreachable)
//   6. honest `unknown` state          (an unobservable lane is never counted running)
// plus BUILD-QUEUE parsing and the KILLSWITCH gate.
//
// Everything runs against a temp directory with injected clocks, injected
// liveness probes and an injected lane runner. Nothing here spawns Gemini,
// touches the real state file, or creates a git worktree.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const previousVertexAccount = process.env.TOOLSENABLED_VERTEX_ACCOUNT;
if (!previousVertexAccount) process.env.TOOLSENABLED_VERTEX_ACCOUNT = 'fleet-fixture@example.invalid';

const queueReader = require('../src/lib/fleet-supervisor/queue.js');
const stateStore = require('../src/lib/fleet-supervisor/state.js');
const worktrees = require('../src/lib/fleet-supervisor/worktree.js');
const {
  FleetSupervisor, claimNext, isTransientFailureDetail, occupiedSlots, quotaResetDelayMs,
  reconcile, recordLaneOutcome, recordLaneStarted, status, QUOTA_RESET_MAX_MS, TRANSIENT_REFUND_CAP
} = require('../src/lib/fleet-supervisor/supervisor.js');
const laneModels = require('../src/lib/fleet-supervisor/lane-models.js');
const directVertex = require('../src/lib/fleet-supervisor/direct-vertex-receipt.js');
const { changedFileCount, parseReportedFiles } = require('../src/lib/fleet-supervisor/lane-runner.js');
const { VERSION: GEMINI_REPORT_CONTRACT_VERSION } = require('../src/lib/fleet-supervisor/gemini-report-contract.js');

let checks = 0;
const tempDirs = [];

function ok(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}
function equal(actual, expected, message) {
  assert.strictEqual(actual, expected, message);
  checks += 1;
}
function notEqual(actual, expected, message) {
  assert.notStrictEqual(actual, expected, message);
  checks += 1;
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-sup-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (previousVertexAccount === undefined) delete process.env.TOOLSENABLED_VERTEX_ACCOUNT;
  else process.env.TOOLSENABLED_VERTEX_ACCOUNT = previousVertexAccount;
}

const SAMPLE_QUEUE = [
  '# BUILD-QUEUE',
  '',
  '## Builder protocol (read once per loop)',
  '',
  '**Pick rule:** work the lowest-numbered phase whose Status line does not start with DONE or BLOCKED.',
  '',
  '---',
  '',
  '## Q7 - Freshness automation',
  '',
  '**Status:** BLOCKED (waiting on a go-gate)',
  'Body of seven.',
  '',
  '---',
  '',
  '## Q9 - Measure the savings',
  '',
  '**Status:** DONE 2026-07-28 (measured)',
  '',
  '---',
  '',
  '## Q17 - Controller metering',
  '',
  '**Status:** IN-PROGRESS 2026-07-28 (partly done)',
  'Body of seventeen.',
  '',
  '---',
  '',
  '## Q27 - Dashboard spawn authority',
  '',
  '**Status:** PARTIAL 2026-07-28 (steps 1-2 done)',
  'Body of twenty-seven.',
  '',
  '---',
  '',
  '## Q11 - Something open',
  '',
  '**Status:** OPEN',
  'Body of eleven.',
  '',
  '---',
  '',
  '## Q40 - Status shape nobody documented',
  '',
  '**Status:** SOMETHING-ELSE 2026-07-28',
  'Body of forty.',
  '',
  '---',
  '',
  '## Completed - do not rebuild',
  '',
  '- Q1 done.',
  ''
].join('\n');

// ---------------------------------------------------------------------------
// 0. BUILD-QUEUE parsing and the pick rule
// ---------------------------------------------------------------------------
function testQueueParsing() {
  const phases = queueReader.parseBuildQueue(SAMPLE_QUEUE);
  equal(phases.length, 6, 'six Q phases parsed (protocol and Completed sections excluded)');
  const byId = new Map(phases.map(p => [p.id, p]));
  equal(byId.get('Q7').status, 'BLOCKED', 'Q7 classified BLOCKED');
  equal(byId.get('Q9').status, 'DONE', 'Q9 classified DONE');
  equal(byId.get('Q17').status, 'IN-PROGRESS', 'IN-PROGRESS is not shadowed by a shorter status token');
  equal(byId.get('Q27').status, 'PARTIAL', 'Q27 classified PARTIAL');
  equal(byId.get('Q11').status, 'OPEN', 'Q11 classified OPEN');
  equal(byId.get('Q40').status, 'UNKNOWN', 'an undocumented status shape is UNKNOWN, not guessed');

  const open = queueReader.openPhases(phases);
  assert.deepStrictEqual(open.map(p => p.id), ['Q11', 'Q17', 'Q27', 'Q40'],
    'open phases are lowest-number-first and exclude DONE/BLOCKED');
  checks += 1;

  ok(byId.get('Q17').body.includes('Body of seventeen.'), 'phase body captured');
  ok(queueReader.builderProtocol(SAMPLE_QUEUE).includes('Pick rule'), 'builder protocol section extracted');

  const brief = queueReader.buildLaneBrief(byId.get('Q11'), queueReader.builderProtocol(SAMPLE_QUEUE),
    { laneId: 'q11-abc', worktree: 'C:\\x' });
  ok(brief.includes('Body of eleven.'), 'brief carries the phase body verbatim');
  ok(brief.includes('Pick rule'), 'brief carries the builder protocol verbatim');
  ok(!brief.includes('Body of seventeen.'), 'brief carries only its own phase');

  // Exercise the filesystem corpus reader against an owned, installation-
  // shaped queue with enough phases to catch ordering/census regressions.
  const queueRoot = tempDir('queue-read');
  const queueFile = path.join(queueRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, `${buildQueueWithPhases(12)}\n---\n\n## Q13 - Closed\n\n**Status:** DONE\n\n---\n\n## Q14 - Parked\n\n**Status:** BLOCKED\n`, 'utf8');
  const fromFile = queueReader.readBuildQueue(queueFile);
  equal(fromFile.phases.length, 14, 'the owned BUILD-QUEUE fixture parses every phase');
  const fileOpen = queueReader.openPhases(fromFile.phases);
  equal(fileOpen.length, 12, 'DONE and BLOCKED fixture phases are excluded');
  ok(fileOpen.every(p => p.status !== 'DONE' && p.status !== 'BLOCKED'), 'no DONE/BLOCKED phase is ever open');
  for (let i = 1; i < fileOpen.length; i += 1) {
    ok(fileOpen[i - 1].number <= fileOpen[i].number, 'fixture open phases are in ascending number order');
  }
}

// ---------------------------------------------------------------------------
// 5. Worktree reaping guard -- run early, because it is the destructive one
// ---------------------------------------------------------------------------
function testWorktreeGuard() {
  const base = tempDir('wt');
  const repoRoot = path.join(base, 'ToolsEnabled');
  fs.mkdirSync(repoRoot, { recursive: true });

  // The four worktrees another agent is reviewing right now, reproduced by
  // exact name next to a repo root. None of them may be reapable.
  const protectedNames = [
    'ToolsEnabled-lane-s03-pdfinfo',
    'ToolsEnabled-lane-s05-fleet',
    'ToolsEnabled-lane-s09-gmail',
    'ToolsEnabled-lane-s10-ledger',
    'ToolsEnabled-lane-s10-ledger-readonly'
  ];
  for (const name of protectedNames) {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'real-unmerged-work.txt'), 'do not delete me', 'utf8');
    const verdict = worktrees.reapable(dir, { repoRoot });
    equal(verdict.ok, false, `${name} is not reapable`);
    ok(/basename is not a fleet lane directory/.test(verdict.reason), `${name} refused on the namespace check`);
    assert.throws(() => worktrees.removeLaneWorktree(dir, { repoRoot }), /FLEET_WORKTREE_REFUSED|Refusing to touch/);
    checks += 1;
    ok(fs.existsSync(path.join(dir, 'real-unmerged-work.txt')), `${name} content survived the refusal`);
  }

  // Even if an attacker plants a valid-looking marker in a protected worktree,
  // the namespace check still refuses: all four checks must pass, not any one.
  const planted = path.join(base, protectedNames[0]);
  fs.writeFileSync(path.join(planted, worktrees.MARKER_FILE), JSON.stringify({
    kind: 'toolsenabled-fleet-lane', ownerToken: worktrees.OWNER_TOKEN, repoRoot, laneId: 'x'
  }), 'utf8');
  equal(worktrees.reapable(planted, { repoRoot }).ok, false, 'a planted marker cannot make a protected worktree reapable');

  // The repo root itself is never reapable.
  equal(worktrees.reapable(repoRoot, { repoRoot }).ok, false, 'the repo root is not reapable');
  // Nor is a path outside the parent directory.
  equal(worktrees.reapable(path.join(base, 'nested', 'ToolsEnabled-fleet-lane-q1'), { repoRoot }).ok, false,
    'a non-sibling path is not reapable');
  // Nor a correctly-named directory with no marker at all.
  const unmarked = path.join(base, 'ToolsEnabled-fleet-lane-unmarked');
  fs.mkdirSync(unmarked, { recursive: true });
  const unmarkedVerdict = worktrees.reapable(unmarked, { repoRoot });
  equal(unmarkedVerdict.ok, false, 'a correctly-named directory without a marker is not reapable');
  ok(/no fleet lane ownership marker/.test(unmarkedVerdict.reason), 'refusal names the missing marker');
  // Nor one whose marker points at a different repository.
  const foreign = path.join(base, 'ToolsEnabled-fleet-lane-foreign');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, worktrees.MARKER_FILE), JSON.stringify({
    kind: 'toolsenabled-fleet-lane', ownerToken: worktrees.OWNER_TOKEN, repoRoot: path.join(base, 'OtherRepo')
  }), 'utf8');
  equal(worktrees.reapable(foreign, { repoRoot }).ok, false, 'a marker for another repo root is not reapable');

  // A properly created-and-marked lane worktree IS reapable.
  const mine = path.join(base, 'ToolsEnabled-fleet-lane-q11-abc');
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, worktrees.MARKER_FILE), JSON.stringify({
    kind: 'toolsenabled-fleet-lane', ownerToken: worktrees.OWNER_TOKEN, repoRoot, laneId: 'q11-abc'
  }), 'utf8');
  equal(worktrees.reapable(mine, { repoRoot }).ok, true, 'a marked fleet lane worktree is reapable');

  // Lane ids cannot escape the namespace with a traversal.
  assert.throws(() => worktrees.worktreePathFor('../../Windows', repoRoot), /not a safe single path segment/);
  checks += 1;
  assert.throws(() => worktrees.worktreePathFor('a/b', repoRoot), /not a safe single path segment/);
  checks += 1;

  // createLaneWorktree never clears an occupied path.
  const occupied = worktrees.worktreePathFor('occupied', repoRoot);
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, 'someone-elses.txt'), 'x', 'utf8');
  assert.throws(
    () => worktrees.createLaneWorktree('occupied', { repoRoot, exec: () => { throw new Error('git must not run'); } }),
    /refusing to clear it/
  );
  checks += 1;
  ok(fs.existsSync(path.join(occupied, 'someone-elses.txt')), 'the occupied path was not cleared');

  // And it writes the marker that later makes removal legal.
  let gitArgs = null;
  const created = worktrees.createLaneWorktree('fresh', {
    repoRoot,
    supervisorId: 'sup-test',
    itemId: 'Q11',
    exec: (cmd, args) => { gitArgs = args; fs.mkdirSync(args[3], { recursive: true }); return ''; }
  });
  assert.deepStrictEqual(gitArgs.slice(0, 3), ['worktree', 'add', '--detach']);
  checks += 1;
  equal(worktrees.reapable(created.path, { repoRoot }).ok, true, 'a freshly created lane worktree is reapable');
  equal(worktrees.readMarker(created.path).itemId, 'Q11', 'marker records the queue item');
}

// ---------------------------------------------------------------------------
// Helpers for the state-machine tests
// ---------------------------------------------------------------------------
function newStateFile(prefix) {
  return path.join(tempDir(prefix), 'state', 'fleet-supervisor.json');
}

const OPEN_IDS = ['Q11', 'Q17', 'Q27'];

function claim(stateFile, laneId, extra = {}) {
  return claimNext(stateFile, {
    openItemIds: OPEN_IDS, laneId, supervisorId: 'sup-a', concurrency: 4,
    maxAttempts: 3, maxNoProgressAttempts: 2, ...extra
  });
}

// ---------------------------------------------------------------------------
// 2. Atomic claiming -- no double-claim
// ---------------------------------------------------------------------------
function testAtomicClaiming() {
  const stateFile = newStateFile('claim');

  const first = claim(stateFile, 'lane-1');
  equal(first.claimed.itemId, 'Q11', 'the lowest-numbered open item is claimed first');
  const second = claim(stateFile, 'lane-2');
  equal(second.claimed.itemId, 'Q17', 'the second lane cannot take the already-claimed Q11');
  const third = claim(stateFile, 'lane-3');
  equal(third.claimed.itemId, 'Q27', 'the third lane takes the next open item');
  const fourth = claim(stateFile, 'lane-4');
  equal(fourth.claimed, null, 'a fourth lane finds nothing eligible');
  equal(fourth.reason, 'no-eligible-item', 'and says so honestly');

  const state = stateStore.readState(stateFile);
  const claimedItems = Object.values(state.items).filter(item => item.condition === 'claimed');
  equal(claimedItems.length, 3, 'exactly three items are claimed');
  const claimants = claimedItems.map(item => item.claimedByLaneId).sort();
  assert.deepStrictEqual(claimants, ['lane-1', 'lane-2', 'lane-3'], 'each item has exactly one claimant');
  checks += 1;
  const itemsPerLane = new Map();
  for (const lane of Object.values(state.lanes)) {
    ok(!itemsPerLane.has(lane.itemId), `item ${lane.itemId} is held by exactly one lane`);
    itemsPerLane.set(lane.itemId, lane.laneId);
  }

  // A reused lane id is refused rather than silently overwriting a live lane.
  equal(claim(stateFile, 'lane-1').reason, 'lane-id-already-used', 'a duplicate lane id is refused');
}

// Cross-process: N child processes race for the same items through the on-disk
// lock, launched CONCURRENTLY so the lock is actually contended. Every item
// must end up claimed by exactly one lane.
async function testCrossProcessClaiming() {
  const stateFile = newStateFile('race');
  const script = path.join(path.dirname(path.dirname(stateFile)), 'racer.js');
  const supervisorModule = path.resolve(__dirname, '..', 'src', 'lib', 'fleet-supervisor', 'supervisor.js').replace(/\\/g, '\\\\');
  fs.writeFileSync(script, [
    "'use strict';",
    `const { claimNext } = require('${supervisorModule}');`,
    'const stateFile = process.argv[2];',
    'const laneId = process.argv[3];',
    "const ids = ['Q11','Q17','Q27','Q28','Q29','Q30','Q31','Q32'];",
    'const result = claimNext(stateFile, { openItemIds: ids, laneId, supervisorId: laneId, concurrency: 8, maxAttempts: 3, maxNoProgressAttempts: 2 });',
    'process.stdout.write(JSON.stringify(result));'
  ].join('\n'), 'utf8');

  const { spawn } = require('node:child_process');
  const racers = 8;
  const runs = [];
  for (let i = 0; i < racers; i += 1) {
    runs.push(new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, stateFile, `race-${i}`], {
        windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      let err = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.stderr.on('data', chunk => { err += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, out, err }));
    }));
  }
  const results = await Promise.all(runs);

  const claimedIds = [];
  for (const result of results) {
    equal(result.code, 0, `racer exited cleanly (stderr: ${result.err.slice(0, 200)})`);
    const parsed = JSON.parse(result.out);
    if (parsed.claimed) claimedIds.push(parsed.claimed.itemId);
  }
  equal(claimedIds.length, racers, 'all eight concurrent processes claimed something');
  equal(new Set(claimedIds).size, racers, 'no two processes claimed the same queue item');

  const state = stateStore.readState(stateFile);
  equal(Object.keys(state.lanes).length, racers, 'every racer left exactly one durable lane record');
  for (const item of Object.values(state.items)) {
    if (item.condition !== 'claimed') continue;
    equal(item.attempts, 1, `${item.itemId} was attempted exactly once, not twice`);
  }
}

// ---------------------------------------------------------------------------
// 1. Concurrency limiting
// ---------------------------------------------------------------------------
async function testConcurrencyLimiting() {
  for (const concurrency of [1, 4, 15]) {
    const stateFile = newStateFile(`conc${concurrency}`);
    const ids = Array.from({ length: 40 }, (_, i) => `Q${i + 1}`);

    // Claim-level: the lock refuses to hand out more than `concurrency` slots.
    let handed = 0;
    for (let i = 0; i < 40; i += 1) {
      const result = claimNext(stateFile, {
        openItemIds: ids, laneId: `lane-${i}`, supervisorId: 'sup-a', concurrency,
        maxAttempts: 3, maxNoProgressAttempts: 2
      });
      if (result.claimed) handed += 1;
      else { equal(result.reason, 'concurrency-full', `slot ${i} refused because the fleet is full`); break; }
    }
    equal(handed, concurrency, `exactly ${concurrency} lanes were handed a slot`);
    equal(occupiedSlots(stateStore.readState(stateFile)), concurrency, `occupiedSlots agrees at ${concurrency}`);
  }

  // Supervisor-level: a real tick with a slow lane runner never exceeds the cap.
  const stateFile = newStateFile('conc-tick');
  const queueFile = path.join(path.dirname(path.dirname(stateFile)), 'BUILD-QUEUE.md');
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });
  fs.writeFileSync(queueFile, buildQueueWithPhases(30), 'utf8');

  let concurrent = 0;
  let peak = 0;
  const release = [];
  const supervisor = new FleetSupervisor({
    repoRoot: path.dirname(queueFile),
    stateFile,
    queueFile,
    concurrency: 15,
    dryRun: false,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    runLane: () => new Promise(resolve => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      release.push(() => { concurrent -= 1; resolve({ ok: true, changedFileCount: 2 }); });
    })
  });
  // Skip real worktree creation for this test.
  stubWorktrees();

  await supervisor.tick();
  equal(supervisor.inFlight.size, 15, 'the supervisor filled exactly 15 lanes');
  equal(peak, 15, 'never more than 15 lanes ran at once');
  await supervisor.tick();
  equal(supervisor.inFlight.size, 15, 'a second tick with all lanes busy launches nothing more');
  for (const fn of release.splice(0)) fn();
  await supervisor.drain();
  equal(supervisor.inFlight.size, 0, 'lanes drained');
  const after = supervisor.status();
  equal(after.laneCounts.running, 0, 'no lane is reported running after draining');
  equal(after.laneCounts.succeeded, 15, 'all fifteen lanes recorded a terminal success');
}

function buildQueueWithPhases(count) {
  const lines = ['# BUILD-QUEUE', '', '## Builder protocol (read once per loop)', '', '**Pick rule:** lowest open.', ''];
  for (let i = 1; i <= count; i += 1) {
    lines.push('---', '', `## Q${i} - Phase ${i}`, '', '**Status:** OPEN', `Body ${i}.`, '');
  }
  return lines.join('\n');
}

// Replaces worktree creation/materialization with stubs so the concurrency,
// kill-switch and refill tests never invoke git. The guard and the
// materialization are each tested for real, separately.
const worktreeModule = require('../src/lib/fleet-supervisor/worktree.js');
const TRUE_WORKTREE_FNS = {
  createLaneWorktree: worktreeModule.createLaneWorktree,
  removeLaneWorktree: worktreeModule.removeLaneWorktree,
  materializeWorkingTree: worktreeModule.materializeWorkingTree,
  captureBaselineTree: worktreeModule.captureBaselineTree,
  changedSinceBaseline: worktreeModule.changedSinceBaseline
};

function stubWorktrees() {
  worktreeModule.createLaneWorktree = laneId => ({ path: `<stub>/${laneId}`, marker: {} });
  worktreeModule.removeLaneWorktree = () => ({ removed: false, viaGit: false, detail: 'stubbed' });
  worktreeModule.materializeWorkingTree = () => ({
    complete: true, reason: null, trackedExpected: [], trackedMissing: [],
    untrackedExpected: 0, untrackedCopied: 0, untrackedSkipped: [], patchBytes: 0
  });
  worktreeModule.captureBaselineTree = () => 'fixture-baseline-tree';
  worktreeModule.changedSinceBaseline = () => 1;
}

function restoreWorktrees() {
  Object.assign(worktreeModule, TRUE_WORKTREE_FNS);
}

// ---------------------------------------------------------------------------
// 3. Crash / restart resume
// ---------------------------------------------------------------------------
function testRestartResume() {
  const stateFile = newStateFile('resume');

  // Supervisor A claims two items and records live pids, then "crashes".
  claimNext(stateFile, { openItemIds: OPEN_IDS, laneId: 'a1', supervisorId: 'sup-a', concurrency: 4, maxAttempts: 3, maxNoProgressAttempts: 2 });
  claimNext(stateFile, { openItemIds: OPEN_IDS, laneId: 'a2', supervisorId: 'sup-a', concurrency: 4, maxAttempts: 3, maxNoProgressAttempts: 2 });
  recordLaneStarted(stateFile, 'a1', { pid: 4242, pidKind: 'process', worktree: 'wt-a1' });
  equal(stateStore.readState(stateFile).lanes.a1.pidKind, 'process', 'the legacy retry control explicitly records a process PID');
  recordLaneStarted(stateFile, 'a2', { pid: 4243, worktree: 'wt-a2' });

  // Supervisor B starts. a1's process is gone; a2's is somehow still alive.
  const isAlive = pid => pid === 4243;
  const transitions = reconcile(stateFile, { supervisorId: 'sup-b', inFlightLaneIds: new Set(), isAlive });
  equal(transitions.length, 2, 'both orphaned lanes were reconciled');

  const state = stateStore.readState(stateFile);
  equal(state.lanes.a1.status, 'unknown', 'a lane whose process is gone is unknown, not failed and not running');
  equal(state.lanes.a1.unknownReason, 'supervisor-exited-before-outcome-was-observed', 'reason recorded');
  equal(state.lanes.a2.status, 'unknown', 'a live orphan is ALSO unknown: we cannot observe its outcome');
  equal(state.lanes.a2.orphanWatch, true, 'the live orphan is watched');

  // a1's item is released for retry; a2's stays claimed so work is not duplicated.
  equal(state.items.Q11.condition, 'idle', "the dead lane's item is released for retry");
  equal(state.items.Q11.attempts, 1, 'the crashed attempt still counted against the retry cap');
  equal(state.items.Q17.condition, 'orphaned', "the live orphan's item stays held, so no duplicate lane starts");

  // Supervisor B resumes: it may retry Q11, must not retry Q17.
  const resumed = claimNext(stateFile, { openItemIds: OPEN_IDS, laneId: 'b1', supervisorId: 'sup-b', concurrency: 4, maxAttempts: 3, maxNoProgressAttempts: 2 });
  equal(resumed.claimed.itemId, 'Q11', 'the released item is re-dispatched');
  equal(resumed.claimed.attempt, 2, 'as attempt 2, not attempt 1');
  const next = claimNext(stateFile, { openItemIds: OPEN_IDS, laneId: 'b2', supervisorId: 'sup-b', concurrency: 4, maxAttempts: 3, maxNoProgressAttempts: 2 });
  equal(next.claimed.itemId, 'Q27', 'the orphan-held Q17 is skipped, not duplicated');

  // When the orphan finally exits, its item is released with the attempt counted.
  reconcile(stateFile, { supervisorId: 'sup-b', inFlightLaneIds: new Set(['b1', 'b2']), isAlive: () => false });
  const later = stateStore.readState(stateFile);
  equal(later.items.Q17.condition, 'idle', 'the exited orphan releases its item');
  equal(later.lanes.a2.unknownReason, 'orphan-process-exited-outcome-never-observed', 'and stays honestly unknown');
  equal(later.items.Q17.attempts, 1, 'the orphan attempt is not double-counted');

  // A restart must not lose the durable record.
  ok(fs.existsSync(stateFile), 'state survives on disk across all of this');
  const reread = stateStore.readState(stateFile);
  equal(Object.keys(reread.lanes).length, 4, 'every lane record survived the restart');
}

function testCorruptStateRefusesToStartEmpty() {
  const stateFile = newStateFile('corrupt');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, '{ this is not json', 'utf8');
  assert.throws(() => stateStore.readState(stateFile), error => error.code === 'FLEET_STATE_CORRUPT');
  checks += 1;

  const wrongSchema = newStateFile('schema');
  fs.mkdirSync(path.dirname(wrongSchema), { recursive: true });
  fs.writeFileSync(wrongSchema, JSON.stringify({ schemaVersion: 99 }), 'utf8');
  assert.throws(() => stateStore.readState(wrongSchema), error => error.code === 'FLEET_STATE_SCHEMA');
  checks += 1;

  // A missing file is fine -- that is a first run, not corruption.
  equal(stateStore.readState(path.join(tempDir('fresh'), 'nope.json')).schemaVersion, stateStore.SCHEMA_VERSION,
    'a missing state file starts empty');
}

// ---------------------------------------------------------------------------
// 4. Retry capping and parking
// ---------------------------------------------------------------------------
function testRetryCapping() {
  const stateFile = newStateFile('retry');
  const ids = ['Q11'];
  const opts = { openItemIds: ids, supervisorId: 'sup-a', concurrency: 4, maxAttempts: 3, maxNoProgressAttempts: 99 };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = claimNext(stateFile, { ...opts, laneId: `lane-${attempt}` });
    equal(result.claimed.attempt, attempt, `attempt ${attempt} handed out`);
    recordLaneOutcome(stateFile, `lane-${attempt}`, {
      ok: false, code: 'EXIT_NONZERO', changedFileCount: 3, maxAttempts: 3, maxNoProgressAttempts: 99
    });
  }
  const capped = claimNext(stateFile, { ...opts, laneId: 'lane-4' });
  equal(capped.claimed, null, 'a fourth attempt is refused');
  const state = stateStore.readState(stateFile);
  equal(state.items.Q11.condition, 'parked', 'the permanently failing item is parked');
  ok(/attempt-cap-reached: 3 of 3/.test(state.items.Q11.parkedReason), 'parked with a reason, not silently dropped');
  ok(state.items.Q11.parkedAt, 'park time recorded');

  // A parked item is never re-dispatched, even after more cycles.
  for (let i = 0; i < 5; i += 1) {
    equal(claimNext(stateFile, { ...opts, laneId: `spin-${i}` }).claimed, null, 'a parked item is never spun on');
  }

  // No-progress parking is separate and fires earlier.
  const noProgressFile = newStateFile('noprogress');
  const npOpts = { openItemIds: ['Q11'], supervisorId: 'sup-a', concurrency: 4, maxAttempts: 99, maxNoProgressAttempts: 2 };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    claimNext(noProgressFile, { ...npOpts, laneId: `np-${attempt}` });
    recordLaneOutcome(noProgressFile, `np-${attempt}`, {
      ok: true, changedFileCount: 0, maxAttempts: 99, maxNoProgressAttempts: 2
    });
  }
  const npState = stateStore.readState(noProgressFile);
  equal(npState.items.Q11.condition, 'parked', 'two zero-diff attempts park the item');
  ok(/no-progress: 2 consecutive/.test(npState.items.Q11.parkedReason), 'the no-progress reason is explicit');
  equal(claimNext(noProgressFile, { ...npOpts, laneId: 'np-3' }).claimed, null, 'and it is not retried forever');

  // An UNMEASURABLE diff must not be counted as "no progress" -- a failed git
  // call is not evidence the lane did nothing, and treating it as zero would
  // park a productive item.
  const unmeasuredFile = newStateFile('unmeasured');
  const uOpts = { openItemIds: ['Q11'], supervisorId: 'sup-a', concurrency: 4, maxAttempts: 99, maxNoProgressAttempts: 2 };
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    claimNext(unmeasuredFile, { ...uOpts, laneId: `u-${attempt}` });
    recordLaneOutcome(unmeasuredFile, `u-${attempt}`, {
      ok: true, changedFileCount: null, maxAttempts: 99, maxNoProgressAttempts: 2
    });
  }
  const uState = stateStore.readState(unmeasuredFile).items.Q11;
  equal(uState.noProgressAttempts, 0, 'an unmeasurable diff does not increment the no-progress streak');
  equal(uState.unmeasuredAttempts, 4, 'but it is counted and visible');
  equal(uState.condition, 'idle', 'and the item is not parked for something we never measured');

  // A lane that NEVER LAUNCHED reports a truthful changedFileCount of 0 -- it
  // changed nothing because it never ran. Counting that as "the phase made no
  // progress" is the bug that parked 78 of 99 real queue items on 2026-07-29
  // while both underlying faults (an accidental gitlink blocking materialization,
  // and a `git worktree add` path-length failure) were pure harness bugs.
  const harnessFile = newStateFile('harness-fault');
  const hOpts = { openItemIds: ['Q11'], supervisorId: 'sup-a', concurrency: 4, maxAttempts: 3, maxNoProgressAttempts: 2 };
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    claimNext(harnessFile, { ...hOpts, laneId: `h-${attempt}` });
    recordLaneOutcome(harnessFile, `h-${attempt}`, {
      ok: false,
      code: 'DISPATCH_BLOCKED_STALE_SNAPSHOT',
      detail: 'tracked-paths-not-materialized: reports/desktop-archive/AI_Session_Logs',
      changedFileCount: 0,
      maxAttempts: 3,
      maxNoProgressAttempts: 2
    });
  }
  const hState = stateStore.readState(harnessFile);
  const hItem = hState.items.Q11;
  equal(hItem.noProgressAttempts, 0,
    'a lane that never launched does not move the no-progress streak');
  equal(hItem.condition, 'idle',
    'so four blocked dispatches do NOT park a phase that was never actually tried');
  equal(hItem.harnessFaults, 4, 'the harness faults are counted and visible');
  equal(hState.lanes['h-1'].outcome.neverLaunched, true,
    'and the lane records that no agent acted');
  ok(claimNext(harnessFile, { ...hOpts, laneId: 'h-5' }).claimed,
    'the item is still claimable once the harness is repaired');

  // The refund is capped, so a PERMANENTLY broken harness still converges to
  // parked rather than retrying forever.
  const forever = newStateFile('harness-forever');
  let parkedAt = null;
  for (let attempt = 1; attempt <= 40 && !parkedAt; attempt += 1) {
    const claim = claimNext(forever, { ...hOpts, laneId: `f-${attempt}` });
    if (!claim.claimed) { parkedAt = attempt; break; }
    recordLaneOutcome(forever, `f-${attempt}`, {
      ok: false, code: 'LANE_THREW', detail: 'Command failed: git worktree add',
      changedFileCount: 0, maxAttempts: 3, maxNoProgressAttempts: 2
    });
  }
  ok(parkedAt !== null, 'a permanently broken harness eventually stops being retried');
  ok(parkedAt > 3, `and it is given more than the raw attempt cap first (stopped at ${parkedAt})`);
  ok(/attempt-cap-reached/.test(stateStore.readState(forever).items.Q11.parkedReason || ''),
    'parking for a broken harness names the attempt cap, never "no progress"');

  // An agent that DID run and failed is still the phase's evidence: EXIT_NONZERO
  // and TIMEOUT must keep counting, or the no-progress rule stops working.
  const ranFile = newStateFile('agent-ran');
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    claimNext(ranFile, { ...hOpts, laneId: `ran-${attempt}` });
    recordLaneOutcome(ranFile, `ran-${attempt}`, {
      ok: false, code: 'EXIT_NONZERO', detail: 'model produced no edits',
      changedFileCount: 0, maxAttempts: 3, maxNoProgressAttempts: 2
    });
  }
  const ranItem = stateStore.readState(ranFile).items.Q11;
  equal(ranItem.condition, 'parked', 'a lane that ran and changed nothing still parks the item');
  ok(/no-progress: 2 consecutive/.test(ranItem.parkedReason),
    'and it parks for no-progress, because that failure IS evidence about the phase');

  // Real progress resets the no-progress streak.
  const resetFile = newStateFile('reset');
  claimNext(resetFile, { ...npOpts, laneId: 'r1' });
  recordLaneOutcome(resetFile, 'r1', { ok: true, changedFileCount: 0, maxAttempts: 99, maxNoProgressAttempts: 2 });
  claimNext(resetFile, { ...npOpts, laneId: 'r2' });
  recordLaneOutcome(resetFile, 'r2', { ok: true, changedFileCount: 7, maxAttempts: 99, maxNoProgressAttempts: 2 });
  equal(stateStore.readState(resetFile).items.Q11.noProgressAttempts, 0, 'a productive attempt resets the streak');
  equal(stateStore.readState(resetFile).items.Q11.condition, 'idle', 'and the item stays workable');
}

// ---------------------------------------------------------------------------
// 6. Honest `unknown` state -- the specific bug the owner complained about
// ---------------------------------------------------------------------------
function testHonestUnknownState() {
  const stateFile = newStateFile('honest');
  const common = { openItemIds: ['Q11', 'Q17', 'Q27', 'Q28'], supervisorId: 'sup-a', concurrency: 8, maxAttempts: 3, maxNoProgressAttempts: 2 };

  claimNext(stateFile, { ...common, laneId: 'live' });
  claimNext(stateFile, { ...common, laneId: 'ghost' });
  claimNext(stateFile, { ...common, laneId: 'pending' });
  claimNext(stateFile, { ...common, laneId: 'done' });
  recordLaneStarted(stateFile, 'live', { pid: 1001, worktree: 'wt-live' });
  recordLaneStarted(stateFile, 'ghost', { pid: 1002, worktree: 'wt-ghost' });
  recordLaneStarted(stateFile, 'done', { pid: 1003, worktree: 'wt-done' });
  recordLaneOutcome(stateFile, 'done', { ok: true, changedFileCount: 4, maxAttempts: 3, maxNoProgressAttempts: 2 });
  // 'pending' stays in `starting`: claimed, but no pid was ever observed.

  stateStore.withState(stateFile, state => {
    state.supervisor = { supervisorId: 'sup-a', pid: 9999, startedAt: 'x', heartbeatAt: 'x' };
    for (const lane of Object.values(state.lanes)) lane.supervisorPid = 9999;
    return { state };
  });

  // Only pid 1001 and the supervisor itself are alive.
  const isAlive = pid => pid === 1001 || pid === 9999;
  const report = status(stateFile, { supervisorId: 'sup-a', isAlive, openItemIds: ['Q11', 'Q17', 'Q27', 'Q28'] });

  equal(report.laneCounts.running, 1, 'exactly one lane has a verified live process');
  equal(report.observedRunningLanes[0].laneId, 'live', 'and it is the one that really is running');
  equal(report.laneCounts.unknown, 1, "the lane whose process vanished is unknown, not running");
  equal(report.unknownLanes[0].laneId, 'ghost', 'the vanished lane is named');
  ok(/no-live-process-found/.test(report.unknownLanes[0].unknownReason), 'with an honest reason');
  equal(report.laneCounts.starting, 1, 'a claimed-but-unverified lane is `starting`, counted separately');
  equal(report.startingLanes[0].laneId, 'pending', 'and it is the unverified one');
  equal(report.laneCounts.succeeded, 1, 'the finished lane is terminal');
  ok(report.laneCounts.running < 4, 'the running count NEVER equals the number of lanes ever launched');
  equal(report.openItemCount, 4, 'open item count is reported from the queue, not guessed');
  equal(report.supervisorProcessAlive, true, 'supervisor liveness is probed, not assumed');

  // With the supervisor itself dead, nothing may be reported as running or starting.
  const dead = status(stateFile, { supervisorId: 'sup-a', isAlive: () => false });
  equal(dead.laneCounts.running, 0, 'a dead supervisor reports zero running lanes');
  equal(dead.laneCounts.starting, 0, 'and zero starting lanes');
  equal(dead.laneCounts.unknown, 3, 'every non-terminal lane becomes unknown');
  equal(dead.supervisorProcessAlive, false, 'and the supervisor is honestly reported dead');

  // THE ORPHAN CASE, the one a bare --status is most likely to get wrong: the
  // lane's OWN process is still alive, but the supervisor that was watching it
  // is gone. Nobody holds its exit code, so its outcome is unobservable. It
  // must not be counted as running -- an alive process is not an observed lane.
  const orphaned = status(stateFile, { supervisorId: 'sup-a', isAlive: pid => pid === 1001 });
  equal(orphaned.laneCounts.running, 0,
    'a live lane process whose supervisor died is NOT counted as running');
  equal(orphaned.supervisorProcessAlive, false, 'because the supervisor is gone');
  const orphanEntry = orphaned.unknownLanes.find(lane => lane.laneId === 'live');
  ok(orphanEntry, 'the orphan appears in the unknown list');
  equal(orphanEntry.unknownReason, 'orphan-process-alive-but-supervisor-gone-outcome-unobservable',
    'with a reason that says exactly why it is unknown rather than running');
  equal(orphanEntry.pid, 1001, 'and it still reports the live pid, so an operator can go look');
}

// ---------------------------------------------------------------------------
// KILLSWITCH gate
// ---------------------------------------------------------------------------
async function testKillSwitchGate() {
  const stateFile = newStateFile('kill');
  const repoRoot = path.dirname(path.dirname(stateFile));
  const queueFile = path.join(repoRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, buildQueueWithPhases(5), 'utf8');

  let launches = 0;
  let active = true;
  const supervisor = new FleetSupervisor({
    repoRoot, stateFile, queueFile, concurrency: 4,
    killSwitch: { status: () => ({ active, path: path.join(repoRoot, 'KILLSWITCH') }) },
    runLane: async () => { launches += 1; return { ok: true, changedFileCount: 1 }; }
  });
  stubWorktrees();

  const blocked = await supervisor.tick();
  equal(blocked.blocked, 'killswitch', 'the tick reports it was blocked by the kill switch');
  equal(launches, 0, 'no outward lane was launched while KILLSWITCH was set');
  equal(Object.keys(stateStore.readState(stateFile).lanes).length, 0, 'and nothing was even claimed');

  active = false;
  await supervisor.tick();
  await supervisor.drain();
  equal(launches, 4, 'clearing the kill switch lets the fleet fill again');

  // The real kill-switch module is what the CLI consults.
  const realKillSwitch = require('../src/lib/kill-switch.js');
  ok(typeof realKillSwitch.status().active === 'boolean', 'the real kill switch exposes a boolean active flag');
}

// ---------------------------------------------------------------------------
// End-to-end: the supervisor keeps lanes filled as they finish
// ---------------------------------------------------------------------------
async function testKeepsLanesFilled() {
  const stateFile = newStateFile('filled');
  const repoRoot = path.dirname(path.dirname(stateFile));
  const queueFile = path.join(repoRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, buildQueueWithPhases(12), 'utf8');

  const started = [];
  const supervisor = new FleetSupervisor({
    repoRoot, stateFile, queueFile, concurrency: 3, maxAttempts: 1, maxNoProgressAttempts: 99, pollMs: 0,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    runLane: async ({ itemId, onStart }) => {
      started.push(itemId);
      onStart(process.pid);
      return { ok: true, changedFileCount: 1 };
    }
  });
  stubWorktrees();

  await supervisor.run({ maxCycles: 6, sleep: () => new Promise(resolve => setImmediate(resolve)) });
  equal(new Set(started).size, started.length, 'no queue item was worked twice');
  equal(started.length, 12, 'all twelve items were worked as lanes freed up');
  assert.deepStrictEqual(started.slice(0, 3).sort(), ['Q1', 'Q2', 'Q3'],
    'the first three lanes took the three lowest-numbered items');
  checks += 1;
  const final = supervisor.status();
  equal(final.laneCounts.succeeded, 12, 'twelve terminal successes recorded durably');
  equal(final.laneCounts.running, 0, 'nothing is claimed to be running at the end');
  equal(final.laneCounts.unknown, 0, 'and nothing is left unknown after a clean drain');
  restoreWorktrees();
}

// A dry run must claim, park and report without launching anything.
async function testDryRun() {
  const stateFile = newStateFile('dry');
  const repoRoot = path.dirname(path.dirname(stateFile));
  const queueFile = path.join(repoRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, buildQueueWithPhases(6), 'utf8');

  let launched = 0;
  const supervisor = new FleetSupervisor({
    repoRoot, stateFile, queueFile, concurrency: 2, dryRun: true,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    runLane: async () => { launched += 1; return { ok: true, changedFileCount: 1 }; }
  });
  await supervisor.tick();
  await supervisor.drain();
  equal(launched, 0, 'a dry run never invokes the lane runner');
  const state = stateStore.readState(stateFile);
  ok(Object.keys(state.lanes).length >= 2, 'but it does exercise the claim path');
  for (const lane of Object.values(state.lanes)) {
    equal(lane.outcome.code, 'DRY_RUN', 'each dry-run lane is labelled as such');
    equal(lane.worktree, '(dry-run: no worktree created)', 'and no worktree was created');
  }
}

// ---------------------------------------------------------------------------
// 7. Uncommitted working state must reach the lane worktree
//
// The batch-2 failure: `git worktree add --detach <dir> HEAD` gives the lane
// the last COMMIT, but this repo carries ~70 modified tracked files plus source
// files that exist ONLY as uncommitted state. A lane launched into that reads a
// repo that does not exist. This test builds a real git repo with exactly that
// shape and proves the lane worktree ends up matching the working tree.
// ---------------------------------------------------------------------------
function initRealRepo(name) {
  const base = tempDir(name);
  const repoRoot = path.join(base, 'ToolsEnabled');
  fs.mkdirSync(repoRoot, { recursive: true });
  const run = (args, cwd = repoRoot) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, shell: false });

  run(['init', '-q']);
  run(['config', 'user.email', 'fleet-test@example.invalid']);
  run(['config', 'user.name', 'Fleet Test']);
  run(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repoRoot, 'committed.js'), 'module.exports = { version: 1 };\n', 'utf8');
  fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'state/\nlogs/\nsecret.env\n', 'utf8');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'baseline']);
  return { base, repoRoot, run };
}

function testMaterializesUncommittedWorkingState() {
  const { base, repoRoot, run } = initRealRepo('materialize');

  // The three shapes that broke batch 2, all uncommitted:
  //   a modified tracked file, an untracked-only source file, an ignored secret.
  fs.writeFileSync(path.join(repoRoot, 'committed.js'), 'module.exports = { version: 2, added: true };\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'lib', 'owner-directive-inbox.js'),
    '// exists only as uncommitted state\nmodule.exports = {};\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'state'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'state', 'audit.sqlite3'), 'PRIVATE', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'secret.env'), 'TOKEN=must-never-travel', 'utf8');

  const created = worktrees.createLaneWorktree('mat1', { repoRoot, supervisorId: 'sup-t', itemId: 'Q1' });
  // Before materialization the lane sees the stale commit -- this is the bug.
  equal(fs.readFileSync(path.join(created.path, 'committed.js'), 'utf8').includes('version: 1'), true,
    'a fresh worktree really does start at the stale HEAD commit');
  equal(fs.existsSync(path.join(created.path, 'src', 'lib', 'owner-directive-inbox.js')), false,
    'and an uncommitted-only file really is absent from it');

  const report = worktrees.materializeWorkingTree(created.path, { repoRoot });
  equal(report.complete, true, `materialization completed (reason: ${report.reason})`);

  // THE CORE ASSERTION: the worktree now contains the uncommitted-only file.
  ok(fs.existsSync(path.join(created.path, 'src', 'lib', 'owner-directive-inbox.js')),
    'the lane worktree contains a file that exists ONLY as uncommitted state');
  equal(fs.readFileSync(path.join(created.path, 'src', 'lib', 'owner-directive-inbox.js'), 'utf8'),
    '// exists only as uncommitted state\nmodule.exports = {};\n', 'with its exact bytes');
  ok(fs.readFileSync(path.join(created.path, 'committed.js'), 'utf8').includes('version: 2'),
    'and the uncommitted modification to a tracked file');
  equal(report.trackedMissing.length, 0, 'no tracked change was left behind');
  equal(report.untrackedCopied, 1, 'exactly the one untracked source file was copied');

  // Ignored paths must NOT travel into a lane.
  equal(fs.existsSync(path.join(created.path, 'secret.env')), false,
    'a .gitignore-d secret file never travels into a lane worktree');
  equal(fs.existsSync(path.join(created.path, 'state', 'audit.sqlite3')), false,
    'and neither does the ignored state directory');

  // Policy skip list: transient working residue is NOT copied into a lane, and
  // that is recorded rather than being allowed to look like a materialization
  // failure. (Measured on the real repo: scratch/ alone is 2184 files/109.8 MB.)
  fs.mkdirSync(path.join(repoRoot, 'scratch', 'q23-pre-migration'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'scratch', 'q23-pre-migration', 'junk.md'), 'transient', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'tmp', 'junk.txt'), 'transient', 'utf8');
  const skipping = worktrees.createLaneWorktree('skip1', { repoRoot, supervisorId: 'sup-t', itemId: 'Q1' });
  const skipReport = worktrees.materializeWorkingTree(skipping.path, { repoRoot });
  equal(skipReport.complete, true, 'a policy skip does NOT make the snapshot incomplete');
  equal(skipReport.untrackedSkippedByPolicy, 2, 'both transient files were skipped by policy');
  equal(fs.existsSync(path.join(skipping.path, 'scratch', 'q23-pre-migration', 'junk.md')), false,
    'scratch/ does not travel into a lane');
  equal(fs.existsSync(path.join(skipping.path, 'tmp', 'junk.txt')), false, 'tmp/ does not travel into a lane');
  ok(skipReport.skipPrefixes.includes('scratch/'), 'the skip list is recorded in the lane snapshot record');
  ok(fs.existsSync(path.join(skipping.path, 'src', 'lib', 'owner-directive-inbox.js')),
    'while real uncommitted source still arrives');
  // The skip set can be narrowed explicitly, never silently.
  const wide = worktrees.createLaneWorktree('skip2', { repoRoot, supervisorId: 'sup-t', itemId: 'Q1' });
  const wideReport = worktrees.materializeWorkingTree(wide.path, { repoRoot, skipUntrackedPrefixes: [] });
  equal(wideReport.untrackedSkippedByPolicy, 0, 'an empty skip list copies everything');
  ok(fs.existsSync(path.join(wide.path, 'scratch', 'q23-pre-migration', 'junk.md')), 'including scratch/');

  // Targeted rescue: a specific named file under a skipped prefix can still be
  // brought in on demand without widening the skip set.
  const rescue = worktrees.copyRepoFileIntoWorktree('scratch/q23-pre-migration/junk.md',
    { repoRoot, worktree: skipping.path });
  equal(rescue.copied, true, 'a briefed file under a skipped prefix can be rescued individually');
  ok(fs.existsSync(path.join(skipping.path, 'scratch', 'q23-pre-migration', 'junk.md')), 'and it arrives');
  equal(worktrees.copyRepoFileIntoWorktree('../../escape.txt', { repoRoot, worktree: skipping.path }).copied,
    false, 'but a traversal cannot escape the worktree');
  for (const dir of [skipping.path, wide.path]) worktrees.removeLaneWorktree(dir, { repoRoot });

  // NESTED GIT REPOSITORY. A nested site with its own .git plus ignored build
  // dependencies can appear as ONE directory entry from `git ls-files --others`.
  // Walking it by hand can blow the file cap and block every lane. It must be
  // skipped and reported, not descended into and not treated as a failure.
  fs.mkdirSync(path.join(repoRoot, 'sites', 'nested-site', 'node_modules', 'dep'), { recursive: true });
  execFileSync('git', ['init', '-q'], {
    cwd: path.join(repoRoot, 'sites', 'nested-site'), encoding: 'utf8', windowsHide: true, shell: false
  });
  fs.writeFileSync(path.join(repoRoot, 'sites', 'nested-site', 'index.js'), 'nested', 'utf8');
  fs.writeFileSync(path.join(repoRoot, 'sites', 'nested-site', 'node_modules', 'dep', 'big.js'), 'x'.repeat(1000), 'utf8');
  const listed = worktrees.untrackedPaths(repoRoot);
  assert.deepStrictEqual(listed.nestedRepositories, ['sites/nested-site'],
    'a nested git repository is reported, not descended into');
  checks += 1;
  ok(!listed.files.some(file => file.startsWith('sites/nested-site/')),
    'not one file from inside the nested repository is listed');

  const nestedLane = worktrees.createLaneWorktree('nested1', { repoRoot, supervisorId: 'sup-t', itemId: 'Q1' });
  const nestedReport = worktrees.materializeWorkingTree(nestedLane.path, { repoRoot });
  equal(nestedReport.complete, true, 'a nested repository does not make the snapshot incomplete');
  assert.deepStrictEqual(nestedReport.nestedRepositoriesSkipped, ['sites/nested-site'],
    'and the skip is recorded in the lane snapshot record');
  checks += 1;
  equal(fs.existsSync(path.join(nestedLane.path, 'sites', 'nested-site')), false,
    'the nested repository never travels into a lane');
  ok(fs.existsSync(path.join(nestedLane.path, 'src', 'lib', 'owner-directive-inbox.js')),
    'while the rest of the working state still arrives');
  worktrees.removeLaneWorktree(nestedLane.path, { repoRoot });
  fs.rmSync(path.join(repoRoot, 'sites'), { recursive: true, force: true });

  // TRACKED nested repository (a GITLINK, index mode 160000). The case above is
  // the UNTRACKED one; this is the same situation reached through the index, and
  // it was the more damaging of the two. Measured on the real repo 2026-07-29:
  // `reports/desktop-archive-2026-07-29/AI_Session_Logs` was committed as a
  // gitlink with no .gitmodules entry, so `git diff HEAD --name-only` listed it
  // as a changed tracked path, the byte-copy could not copy a directory, and it
  // landed in trackedMissing -- blocking 75 consecutive lanes with
  // DISPATCH_BLOCKED_STALE_SNAPSHOT, each dead in ~2s before any agent launched.
  const gitlinkRel = 'reports/archive-logs';
  const gitlinkDir = path.join(repoRoot, ...gitlinkRel.split('/'));
  const inNested = args => execFileSync('git', args, {
    cwd: gitlinkDir, encoding: 'utf8', windowsHide: true, shell: false
  });
  fs.mkdirSync(gitlinkDir, { recursive: true });
  inNested(['init', '-q']);
  inNested(['config', 'user.email', 'fleet-test@example.invalid']);
  inNested(['config', 'user.name', 'Fleet Test']);
  inNested(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(gitlinkDir, 'session.log'), 'first\n', 'utf8');
  inNested(['add', '-A']);
  inNested(['commit', '-q', '-m', 'nested baseline']);
  // Record the gitlink in the PARENT index, then move the nested HEAD so the
  // parent reports the gitlink as a changed tracked path.
  run(['add', gitlinkRel]);
  run(['commit', '-q', '-m', 'record gitlink']);
  fs.writeFileSync(path.join(gitlinkDir, 'session.log'), 'first\nsecond\n', 'utf8');
  inNested(['add', '-A']);
  inNested(['commit', '-q', '-m', 'nested moves on']);

  equal(worktrees.changedTrackedPaths(repoRoot).includes(gitlinkRel), true,
    'a moved gitlink really is reported by git as a changed TRACKED path');
  const gitlinkLane = worktrees.createLaneWorktree('gitlink1', { repoRoot, supervisorId: 'sup-t', itemId: 'Q1' });
  const gitlinkReport = worktrees.materializeWorkingTree(gitlinkLane.path, { repoRoot });
  equal(gitlinkReport.complete, true,
    `a tracked gitlink does NOT block dispatch (reason: ${gitlinkReport.reason})`);
  equal(gitlinkReport.trackedMissing.length, 0,
    'and it is not counted as a tracked path we failed to materialize');
  ok(gitlinkReport.nestedRepositoriesSkipped.includes(gitlinkRel),
    'the tracked gitlink is recorded as a skipped nested repository, same as the untracked case');
  ok(fs.existsSync(path.join(gitlinkLane.path, 'src', 'lib', 'owner-directive-inbox.js')),
    'while the rest of the working state still arrives');
  worktrees.removeLaneWorktree(gitlinkLane.path, { repoRoot });

  // The skip is scoped to GITLINKS, not to directories in general: a tracked
  // path that is a directory but carries no .git is still unexplained and must
  // still refuse the lane. Only the `.git` probe is stubbed out here -- git and
  // the rest of the filesystem stay real -- so this pins the branch condition
  // itself rather than a mock of the whole function.
  const nestedGitProbe = path.resolve(gitlinkDir, '.git');
  const fsWithoutNestedGit = Object.create(fs);
  fsWithoutNestedGit.existsSync = target =>
    (path.resolve(String(target)) === nestedGitProbe ? false : fs.existsSync(target));
  const plainDirLane = worktrees.createLaneWorktree('gitlink2', { repoRoot, supervisorId: 'sup-t', itemId: 'Q1' });
  const plainDirReport = worktrees.materializeWorkingTree(plainDirLane.path,
    { repoRoot, fsImpl: fsWithoutNestedGit });
  equal(plainDirReport.complete, false,
    'a tracked directory with no .git still refuses the lane rather than being skipped');
  ok(plainDirReport.trackedMissing.includes(gitlinkRel), 'and it is reported as tracked-missing');
  worktrees.removeLaneWorktree(plainDirLane.path, { repoRoot });
  fs.rmSync(path.join(repoRoot, 'reports'), { recursive: true, force: true });
  run(['rm', '-q', '--cached', gitlinkRel]);
  run(['commit', '-q', '-m', 'drop gitlink']);

  // A deleted-but-uncommitted tracked file is reproduced as deleted.
  fs.rmSync(path.join(repoRoot, 'committed.js'));
  const second = worktrees.createLaneWorktree('mat2', { repoRoot, supervisorId: 'sup-t', itemId: 'Q1' });
  const secondReport = worktrees.materializeWorkingTree(second.path, { repoRoot });
  equal(secondReport.complete, true, 'a working tree with a deletion still materializes');
  equal(fs.existsSync(path.join(second.path, 'committed.js')), false,
    'an uncommitted deletion is reproduced in the lane');

  // PROGRESS MEASUREMENT. After materialization the worktree differs from HEAD
  // by every materialized file, so measuring against HEAD would report a large
  // change count before the lane has done anything -- which would make every
  // lane look productive and silently disable the no-progress park rule.
  // Progress is therefore measured against a baseline tree captured right after
  // materialization.
  const progressLane = worktrees.createLaneWorktree('progress1', { repoRoot, supervisorId: 'sup-t', itemId: 'Q1' });
  worktrees.materializeWorkingTree(progressLane.path, { repoRoot });
  const naive = execFileSync('git', ['status', '--porcelain'], {
    cwd: progressLane.path, encoding: 'utf8', windowsHide: true, shell: false
  }).split('\n').filter(Boolean).length;
  ok(naive > 0, `measuring against HEAD would wrongly report ${naive} changes before the lane runs`);

  const baseline = worktrees.captureBaselineTree(progressLane.path);
  ok(/^[0-9a-f]{40}$/.test(baseline), 'a baseline tree object is captured');
  equal(worktrees.changedSinceBaseline(progressLane.path, baseline), 0,
    'a lane that did nothing measures ZERO changes, despite the materialized diff');

  // A lane creating a new file counts as one change.
  fs.writeFileSync(path.join(progressLane.path, 'lane-output.js'), 'module.exports = 1;\n', 'utf8');
  equal(worktrees.changedSinceBaseline(progressLane.path, baseline), 1, 'a new file is one change');

  // Editing a file that was ALREADY modified by materialization still counts --
  // a porcelain line-diff would have missed this one.
  fs.writeFileSync(path.join(progressLane.path, 'src', 'lib', 'owner-directive-inbox.js'),
    '// edited by the lane\nmodule.exports = { extended: true };\n', 'utf8');
  equal(worktrees.changedSinceBaseline(progressLane.path, baseline), 2,
    'editing an already-materialized file is detected too');

  equal(worktrees.changedSinceBaseline(progressLane.path, null), null,
    'with no baseline the measurement is null (unknown), not a fabricated zero');
  worktrees.removeLaneWorktree(progressLane.path, { repoRoot });

  // Cleanup through the guarded remover only.
  for (const dir of [created.path, second.path]) {
    equal(worktrees.reapable(dir, { repoRoot }).ok, true, 'the lane worktree it made is reapable');
    worktrees.removeLaneWorktree(dir, { repoRoot });
  }
  run(['worktree', 'prune']);
  ok(base, 'real-repo materialization scenario completed');
}

// Backstop (b): if the worktree does not contain a briefed input that exists in
// the live repo, the lane must be refused, not launched into a stale snapshot.
async function testStaleSnapshotBackstop() {
  const { repoRoot } = initRealRepo('stale');
  fs.mkdirSync(path.join(repoRoot, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'lib', 'owner-directive-inbox.js'), 'module.exports = {};\n', 'utf8');

  const stateFile = path.join(repoRoot, 'state', 'fleet-supervisor.json');
  const queueFile = path.join(repoRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, [
    '# BUILD-QUEUE', '', '## Builder protocol (read once per loop)', '', 'Pick the lowest open.', '',
    '---', '', '## Q1 - Extend the inbox', '', '**Status:** OPEN',
    'Extend `src/lib/owner-directive-inbox.js` and add `tests/owner-directive-inbox.js`.', ''
  ].join('\n'), 'utf8');

  // The brief names two paths. Only one exists in the live repo; the other is
  // an OUTPUT the phase is meant to create and must not block dispatch.
  const referenced = queueReader.referencedPaths(
    'Extend `src/lib/owner-directive-inbox.js` and add `tests/owner-directive-inbox.js`.');
  assert.deepStrictEqual(referenced.sort(),
    ['src/lib/owner-directive-inbox.js', 'tests/owner-directive-inbox.js'],
    'both backticked repo paths are extracted');
  checks += 1;

  let launched = 0;
  const broken = new FleetSupervisor({
    repoRoot, stateFile, queueFile, concurrency: 1,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    runLane: async () => { launched += 1; return { ok: true, changedFileCount: 1 }; }
  });
  // Simulate materialization silently failing: the worktree stays at HEAD.
  broken.materialize = () => ({
    complete: false, reason: 'tracked-diff-apply-failed: simulated', trackedExpected: ['x'],
    trackedMissing: ['x'], untrackedExpected: 1, untrackedCopied: 0, untrackedSkipped: [], patchBytes: 10
  });
  await broken.tick();
  await broken.drain();

  equal(launched, 0, 'no Gemini lane was launched into a snapshot known to be stale');
  const lanes = Object.values(stateStore.readState(stateFile).lanes);
  equal(lanes.length, 1, 'the blocked attempt is still recorded, not swallowed');
  equal(lanes[0].outcome.code, 'DISPATCH_BLOCKED_STALE_SNAPSHOT', 'with the honest DISPATCH_BLOCKED_STALE_SNAPSHOT code');
  equal(lanes[0].status, 'failed', 'and it is a failure, not a success');
  const report = broken.status();
  equal(report.lanesBlockedByStaleSnapshot.length, 1, 'the status surfaces stale-snapshot blocks');

  // With materialization working, the same phase dispatches normally.
  const stateFile2 = path.join(repoRoot, 'state', 'fleet-supervisor-2.json');
  const healthy = new FleetSupervisor({
    repoRoot, stateFile: stateFile2, queueFile, concurrency: 1,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    runLane: async ({ cwd, territory }) => {
      launched += 1;
      ok(fs.existsSync(path.join(cwd, 'src', 'lib', 'owner-directive-inbox.js')),
        'the launched lane really can see the uncommitted-only briefed input');
      assert.deepStrictEqual(territory.sort(), referenced,
        'the onboarding packet receives the phase file territory for collision analysis');
      checks += 1;
      return { ok: true, changedFileCount: 1 };
    }
  });
  await healthy.tick();
  await healthy.drain();
  equal(launched, 1, 'a correctly materialized lane does launch');
  execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true, shell: false });
}

// ---------------------------------------------------------------------------
// 8. A lane can never verify its own work
//
// Fleet review 2026-07-28: Gemini lanes write code against imagined schemas and
// then write tests that fabricate those same schemas, so "40 checks passed"
// from a lane is worth nothing. Exit code zero must never become "verified".
// ---------------------------------------------------------------------------
function testLaneCannotVerifyItself() {
  const { markVerified } = require('../src/lib/fleet-supervisor/supervisor.js');
  const stateFile = newStateFile('verify');
  const opts = { openItemIds: ['Q11'], supervisorId: 'sup-a', concurrency: 4, maxAttempts: 9, maxNoProgressAttempts: 9 };

  claimNext(stateFile, { ...opts, laneId: 'confident' });
  recordLaneStarted(stateFile, 'confident', {
    pid: process.pid, worktree: 'wt', model: 'gemini-2.5-pro', backend: 'vertex'
  });
  // The lane exits zero, changed 12 files, and its stdout claimed 40 passing checks.
  recordLaneOutcome(stateFile, 'confident', {
    ok: true, code: null, detail: 'All 40 checks passed!', changedFileCount: 12,
    backend: 'vertex', reportedModels: ['gemini-2.5-pro'],
    // The outcome writer only accepts a direct-Vertex receipt after binding
    // it to this exact lane/attempt/artifact and raw response.
    directVertexEvidence: (() => {
      const binding = { callId: 'lane:confident:attempt:1', attemptNumber: 1, artifactProduced: true };
      const rawResponse = { modelVersion: 'gemini-2.5-pro', responseId: 'vertex-confident-call-1' };
      return { rawResponse, providerCallEvent: directVertex.providerCallEvent({ binding, rawResponse }) };
    })(),
    maxAttempts: 9, maxNoProgressAttempts: 9
  });

  const lane = stateStore.readState(stateFile).lanes.confident;
  equal(lane.status, 'succeeded', 'the PROCESS is recorded as having exited zero');
  equal(lane.outcome.processExitOk, true, 'and that is named processExitOk, not "passed"');
  equal(lane.verification.state, 'unverified', 'but the work is UNVERIFIED regardless of what the lane claimed');
  ok(/not evidence/.test(lane.verification.reason), 'with the reason spelled out');
  equal(lane.verification.reviewer, null, 'and no reviewer attributed');

  const item = stateStore.readState(stateFile).items.Q11;
  equal(item.unreviewedOutputs, 1, 'the item carries an unreviewed output');
  equal(item.lastOutcome.verification, 'unverified', 'the item outcome is labelled unverified too');
  assert.notStrictEqual(item.condition, 'done');
  checks += 1;

  const report = status(stateFile, { isAlive: () => false });
  equal(report.lanesAwaitingReview.length, 1, 'the status reports it as awaiting review');
  equal(report.verifiedLaneCount, 0, 'and zero lanes verified');

  // Only a separate, named reviewer can move it -- and never the lane itself.
  assert.throws(() => markVerified(stateFile, 'confident', { reviewer: 'confident', verdict: 'accepted' }),
    /cannot verify itself/);
  checks += 1;
  assert.throws(() => markVerified(stateFile, 'confident', { reviewer: '', verdict: 'accepted' }),
    /named reviewer/);
  checks += 1;
  assert.throws(() => markVerified(stateFile, 'confident', { reviewer: 'terra', verdict: 'looks-fine' }),
    /accepted.*rejected/);
  checks += 1;

  markVerified(stateFile, 'confident', { reviewer: 'terra', verdict: 'rejected', note: 'schema was imagined' });
  const rejected = stateStore.readState(stateFile).lanes.confident;
  equal(rejected.verification.state, 'rejected', 'a reviewer can reject it');
  equal(rejected.verification.reviewer, 'terra', 'with attribution');
  equal(status(stateFile, { isAlive: () => false }).verifiedLaneCount, 0, 'a rejection is not a verification');

  markVerified(stateFile, 'confident', { reviewer: 'terra', verdict: 'accepted', note: 're-checked against live code' });
  equal(status(stateFile, { isAlive: () => false }).verifiedLaneCount, 1, 'and only then does it count as verified');

  // A REVIEW THAT COULD NOT RUN IS NOT A REJECTION. Measured 2026-07-29: 42 of
  // 42 verdicts came back "unverifiable: <runner> timed out before any command
  // executed" while the box was saturated. Charged as ordinary rejections they
  // parked 13 items at attempt-cap and drove verdictsByModel() to "0 accepted,
  // 42 rejected, mean score 0" for work no reviewer ever looked at.
  const unrevFile = newStateFile('unreviewable-refund');
  const urOpts = { openItemIds: ['Q40'], supervisorId: 'sup-a', concurrency: 4, maxAttempts: 3, maxNoProgressAttempts: 2 };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const claim = claimNext(unrevFile, { ...urOpts, laneId: `ur-${attempt}` });
    ok(claim.claimed, `attempt ${attempt} is claimable`);
    recordLaneOutcome(unrevFile, `ur-${attempt}`, {
      ok: true, changedFileCount: 4, maxAttempts: 3, maxNoProgressAttempts: 2
    });
    markVerified(unrevFile, `ur-${attempt}`, {
      reviewer: 'review:codex', verdict: 'rejected', unreviewable: true,
      note: 'unverifiable: local command runner timed out before any command executed'
    });
  }
  const urItem = stateStore.readState(unrevFile).items.Q40;
  equal(urItem.unreviewableVerdicts, 3, 'unreviewable verdicts are counted and visible');
  equal(urItem.attempts, 0, 'and each one refunds the attempt it was charged to');
  equal(urItem.condition, 'idle', 'so three unexecutable reviews do NOT park the phase');
  ok(claimNext(unrevFile, { ...urOpts, laneId: 'ur-4' }).claimed,
    'the phase is still claimable once the review tier can execute again');

  // An already-recorded attempt-cap park is RELEASED when the evidence behind it
  // is withdrawn -- claimNext re-runs parkDecision, so this cannot leak an item
  // whose budget is genuinely spent.
  const releaseFile = newStateFile('unreviewable-release');
  const rOpts = { openItemIds: ['Q41'], supervisorId: 'sup-a', concurrency: 4, maxAttempts: 1, maxNoProgressAttempts: 9 };
  claimNext(releaseFile, { ...rOpts, laneId: 'rel-1' });
  recordLaneOutcome(releaseFile, 'rel-1', { ok: true, changedFileCount: 2, maxAttempts: 1, maxNoProgressAttempts: 9 });
  equal(claimNext(releaseFile, { ...rOpts, laneId: 'rel-2' }).claimed, null, 'the item parks at its attempt cap');
  equal(stateStore.readState(releaseFile).items.Q41.condition, 'parked', 'and is recorded parked');
  markVerified(releaseFile, 'rel-1', {
    reviewer: 'review:codex', verdict: 'rejected', unreviewable: true,
    note: 'unverifiable: shell runner failed before artifact execution'
  });
  const released = stateStore.readState(releaseFile).items.Q41;
  equal(released.condition, 'idle', 'withdrawing the evidence releases the attempt-cap park');
  ok(/never executed/.test(released.unparkedNote || ''), 'and says why in the record');

  // A no-progress park rests on lanes that DID run, so it is NOT released.
  const keepFile = newStateFile('unreviewable-keeps-noprogress');
  const kOpts = { openItemIds: ['Q42'], supervisorId: 'sup-a', concurrency: 4, maxAttempts: 99, maxNoProgressAttempts: 1 };
  claimNext(keepFile, { ...kOpts, laneId: 'keep-1' });
  recordLaneOutcome(keepFile, 'keep-1', { ok: true, changedFileCount: 0, maxAttempts: 99, maxNoProgressAttempts: 1 });
  equal(stateStore.readState(keepFile).items.Q42.condition, 'parked', 'a zero-diff lane that ran parks the item');
  markVerified(keepFile, 'keep-1', {
    reviewer: 'review:codex', verdict: 'rejected', unreviewable: true, note: 'unverifiable: runner timed out'
  });
  equal(stateStore.readState(keepFile).items.Q42.condition, 'parked',
    'a no-progress park is left alone -- that evidence was not withdrawn');

  // An ORDINARY rejection still costs the attempt: the reviewer really judged it.
  const realFile = newStateFile('real-rejection');
  claimNext(realFile, { ...urOpts, openItemIds: ['Q43'], laneId: 'real-1' });
  recordLaneOutcome(realFile, 'real-1', { ok: true, changedFileCount: 4, maxAttempts: 3, maxNoProgressAttempts: 2 });
  markVerified(realFile, 'real-1', {
    reviewer: 'review:codex', verdict: 'rejected', note: 'Imagined schema: reads configuredAccountAlias, producer emits configuredAccount'
  });
  const realItem = stateStore.readState(realFile).items.Q43;
  equal(realItem.attempts, 1, 'a substantive rejection is not refunded');
  equal(realItem.unreviewableVerdicts, undefined, 'and is not counted as unreviewable');
}

// The lane map is bounded, but bounding must never discard a lane that still
// means something.
function testLaneRecordPruning() {
  const state = stateStore.emptyState(new Date());
  const add = (laneId, overrides) => {
    state.lanes[laneId] = {
      laneId, itemId: 'Q1', status: 'succeeded', pid: null, orphanWatch: false,
      changedFileCount: 0, startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:00.000Z',
      verification: { state: 'verified' }, ...overrides
    };
  };
  for (let i = 0; i < 500; i += 1) {
    add(`settled-${String(i).padStart(3, '0')}`, { endedAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z` });
  }
  add('still-running', { status: 'running', pid: 1, endedAt: null });
  add('watched-orphan', { status: 'unknown', orphanWatch: true, pid: 2 });
  add('awaiting-review', { changedFileCount: 9, verification: { state: 'unverified' } });

  const removed = stateStore.pruneLanes(state, 300);
  ok(removed > 0, `pruning removed ${removed} settled lane records`);
  equal(Object.keys(state.lanes).length, 300, 'the lane map is bounded at the limit');
  ok(state.lanes['still-running'], 'a running lane is never pruned');
  ok(state.lanes['watched-orphan'], 'an orphan still being watched is never pruned');
  ok(state.lanes['awaiting-review'], 'a completed lane nobody has reviewed is never pruned');
  equal(stateStore.pruneLanes({ lanes: { a: { status: 'succeeded' } } }, 300), 0,
    'pruning under the limit is a no-op');
}

// Concurrency is validated, so a typo cannot silently create a 1500-lane fleet.
function testConcurrencyValidation() {
  const repoRoot = tempDir('validate');
  for (const bad of [0, -1, 1.5, 'four', 65, NaN]) {
    assert.throws(() => new FleetSupervisor({ repoRoot, concurrency: bad }), /concurrency must be an integer/);
    checks += 1;
  }
  const supervisor = new FleetSupervisor({ repoRoot, concurrency: 15 });
  equal(supervisor.concurrency, 15, '15 lanes is accepted (the owner-authorised ceiling)');
  const defaulted = new FleetSupervisor({ repoRoot });
  equal(defaulted.concurrency, 4, 'the default is 4, and 15 is not hardcoded anywhere');
}

// The supervisor must not be able to reach gemini-fleet.js's unguarded remover.
function testNoUnguardedRemovalPath() {
  const root = path.resolve(__dirname, '..');
  const files = [
    'src/lib/fleet-supervisor/supervisor.js',
    'src/lib/fleet-supervisor/lane-runner.js',
    'src/lib/fleet-supervisor/state.js',
    'src/lib/fleet-supervisor/queue.js',
    'tools/fleet-supervisor.js'
  ];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    // Only an actual import matters; the modules name gemini-fleet.js in
    // comments on purpose, to record what they deliberately do NOT reuse.
    ok(!/require\([^)]*gemini-fleet/.test(source), `${relative} does not import tools/gemini-fleet.js`);
    ok(!/'worktree'\s*,\s*'remove'/.test(source), `${relative} contains no direct 'git worktree remove' call`);
    ok(!/rmSync\([^)]*worktree/i.test(source), `${relative} contains no ad hoc worktree deletion`);
  }
  // The one module allowed to delete gates every path through assertReapable.
  const guard = fs.readFileSync(path.join(root, 'src/lib/fleet-supervisor/worktree.js'), 'utf8');
  const removeBody = guard.slice(guard.indexOf('function removeLaneWorktree'));
  ok(/assertReapable\(/.test(removeBody.slice(0, 400)), 'removeLaneWorktree calls assertReapable before anything else');

  // And the live protected worktrees on this machine are refused by name.
  const live = [
    'ToolsEnabled-lane-s03-pdfinfo', 'ToolsEnabled-lane-s05-fleet',
    'ToolsEnabled-lane-s09-gmail', 'ToolsEnabled-lane-s10-ledger'
  ];
  for (const name of live) {
    const target = path.join(path.dirname(root), name);
    const verdict = worktrees.reapable(target, { repoRoot: root });
    equal(verdict.ok, false, `the live worktree ${name} is refused by the guard`);
  }
}

// The scheduled task must be registered non-interactively with no console.
function testScheduledTaskIsWindowless() {
  const script = fs.readFileSync(path.resolve(__dirname, '..', 'tools', 'fleet-supervisor-task.ps1'), 'utf8');
  ok(/-LogonType S4U/.test(script), 'the task principal is S4U (non-interactive session, no desktop, no console)');
  ok(/-Hidden/.test(script), 'the task settings include -Hidden');
  ok(!/-WindowStyle/.test(script), 'it does not rely on -WindowStyle, which does not stop the flash');
  ok(/MultipleInstances IgnoreNew/.test(script), 'a duplicate trigger is a no-op, not a second supervisor');
  // eslint-disable-next-line no-control-regex
  ok(!/[^\x00-\x7F]/.test(script), 'the .ps1 is pure ASCII (PowerShell 5.1 on this machine mis-parses non-ASCII)');

  const guard = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'lib', 'fleet-supervisor', 'worktree.js'), 'utf8');
  ok(/windowsHide: true/.test(guard), 'git invocations pass windowsHide:true');
}

// Functional (not regex) proof of the lane spawn contract: no console window,
// no shell, correct cwd, the reviewed Gemini argument set -- and, since the
// live 2026-07-29 `spawn ENAMETOOLONG` on Q18's oversized brief, that the
// brief travels through a scratch FILE on stdin, never on argv (Windows caps
// the assembled command line at ~32K chars).
async function testLaneSpawnContract() {
  const { runLane, MODEL, LANE_BRIEF_PREFIX, MAX_COMMAND_LINE_CHARS } =
    require('../src/lib/fleet-supervisor/lane-runner.js');
  const dir = tempDir('spawn');
  const EventEmitter = require('node:events');

  let captured = null;
  let briefViaStdin = null;
  let onboardingInput = null;
  const onboardingPacket = 'TEST SUPERVISOR ONBOARDING PACKET';
  const fakeSpawn = (command, args, options) => {
    captured = { command, args, options };
    // stdio[0] is an open read fd on the brief file; read it the way the
    // child would, synchronously inside the spawn call (runLane closes its
    // parent copy right after spawn returns).
    briefViaStdin = fs.readFileSync(options.stdio[0], 'utf8');
    const child = new EventEmitter();
    child.pid = 4321;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit('data', JSON.stringify({ response: 'done', stats: { models: { g: { tokens: { total: 7 } } } } }));
      child.emit('close', 0);
    });
    return child;
  };

  let startedPid = null;
  const result = await runLane({
    laneId: 'lane-x', itemId: 'Q1', brief: 'THE BRIEF', cwd: dir, timeoutMs: 5000,
    project: 'proj-x',
    onStart: pid => { startedPid = pid; },
    spawnImpl: fakeSpawn,
    execImpl: () => '',
    buildOnboardingPacket: input => { onboardingInput = input; return onboardingPacket; },
    resolveExecutable: () => ({ command: 'node', prefixArgs: ['/fake/gemini.js'] })
  });

  equal(captured.options.windowsHide, true, 'the lane spawn sets windowsHide:true (no console window)');
  equal(captured.options.shell, false, 'and shell:false, so no cmd.exe shim console is created');
  equal(captured.options.cwd, dir, 'and runs inside the lane worktree, never the main repo');
  equal(typeof captured.options.stdio[0], 'number',
    'stdin is redirected from the brief FILE (an fd, not a pipe -- nothing to leave undrained)');
  assert.deepStrictEqual(captured.options.stdio.slice(1), ['pipe', 'pipe'], 'output is captured');
  checks += 1;
  equal(briefViaStdin, `${onboardingPacket}\n\nTHE BRIEF`,
    'the dynamic onboarding packet and exact brief reach the child through that file in order');
  equal(onboardingInput.projectRoot, dir, 'the packet receives the lane project root');
  equal(onboardingInput.profile, 'builder', 'the standard supervisor lane receives the builder profile');
  equal(onboardingInput.directiveId, 'Q1', 'the packet receives the queue directive');
  assert.deepStrictEqual(captured.args, [
    '/fake/gemini.js', '--model', MODEL,
    '--approval-mode', 'auto_edit', '--output-format', 'json'
  ], 'argv carries only flags -- the brief (and --prompt) is deliberately absent');
  checks += 1;
  equal(startedPid, 4321, 'the child pid is reported so durable state can record real liveness');
  equal(result.ok, true, 'exit zero is reported as a zero exit');
  equal(result.reportedTokens, 7, 'and usage is parsed from the JSON output');
  assert.deepStrictEqual(result.reportedModels, ['g'], 'the serving model names are surfaced from the CLI stats');
  checks += 1;
  equal(captured.options.env.GOOGLE_CLOUD_PROJECT, 'proj-x',
    'a configured quota project reaches the lane as GOOGLE_CLOUD_PROJECT');
  equal(captured.options.env.TOOLSENABLED_ONBOARDING_ALREADY_INJECTED, undefined,
    'an unverified supervisor launcher cannot request native-hook suppression');
  equal(captured.options.env.TOOLSENABLED_PROJECT_ROOT, dir,
    'the child environment carries the actual project root');
  equal(captured.options.env.TOOLSENABLED_ONBOARDING_PACKET_VERSION, 'toolsenabled.agent-onboarding.v1');
  ok(/^[a-f0-9]{64}$/.test(captured.options.env.TOOLSENABLED_ONBOARDING_PACKET_HASH),
    'the supervisor child receives the injected prompt hash');
  equal(fs.existsSync(path.join(os.tmpdir(), `${LANE_BRIEF_PREFIX}lane-x.txt`)), false,
    'the scratch brief file is removed once the lane settles');

  const invalidJsonSpawn = () => {
    const child = new EventEmitter();
    child.pid = 4322;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.kill = () => {};
    process.nextTick(() => {
      child.stdout.emit('data', 'not a JSON result');
      child.emit('close', 0);
    });
    return child;
  };
  const unestablished = await runLane({
    laneId: 'lane-invalid-json', itemId: 'Q1', brief: 'THE BRIEF', cwd: dir, timeoutMs: 5000,
    spawnImpl: invalidJsonSpawn,
    execImpl: () => '',
    buildOnboardingPacket: () => onboardingPacket,
    resolveExecutable: () => ({ command: 'node', prefixArgs: ['/fake/gemini.js'] })
  });
  equal(unestablished.ok, false,
    'invalid JSON means success could not be established, not that a response definitely did not happen');
  equal(unestablished.code, 'OUTPUT_INVALID_JSON',
    'the caller can distinguish could-not-establish from a valid JSON result with no response');

  // The preflight guard: with the brief off argv the cap is unreachable by
  // construction, and this pins that argv can never quietly grow back toward
  // the Windows limit -- an oversized command line is refused BEFORE spawn.
  let spawnAttempted = false;
  const refused = await runLane({
    laneId: 'lane-argv-cap', itemId: 'Q1', brief: 'small brief', cwd: dir, timeoutMs: 5000,
    spawnImpl: () => { spawnAttempted = true; throw new Error('must never be reached'); },
    execImpl: () => '',
    buildOnboardingPacket: () => onboardingPacket,
    resolveExecutable: () => ({ command: 'node', prefixArgs: ['x'.repeat(MAX_COMMAND_LINE_CHARS + 1)] })
  });
  equal(refused.code, 'COMMAND_LINE_TOO_LONG', 'an oversized assembled command line is refused, loudly');
  equal(spawnAttempted, false, 'and the spawn is never attempted, so ENAMETOOLONG cannot recur');
  equal(fs.existsSync(path.join(os.tmpdir(), `${LANE_BRIEF_PREFIX}lane-argv-cap.txt`)), false,
    'the refusal also cleans up its scratch brief file');

  const noPacket = await runLane({
    laneId: 'lane-no-packet', itemId: 'Q1', brief: 'small brief', cwd: dir, timeoutMs: 5000,
    spawnImpl: () => { throw new Error('must never spawn without onboarding'); },
    buildOnboardingPacket: () => '',
    buildEnvironment: () => ({ env: {}, home: null, billing: { backend: 'subscription', account: 'test', project: null } }),
    resolveExecutable: () => ({ command: 'node', prefixArgs: ['/fake/gemini.js'] })
  });
  equal(noPacket.code, 'ONBOARDING_FAILED', 'the supervisor lane fails closed when packet construction returns empty context');

  // A missing worktree must fail closed rather than run in some other directory.
  const missing = await runLane({ laneId: 'l', itemId: 'Q1', brief: 'b', cwd: path.join(dir, 'nope') });
  equal(missing.code, 'WORKTREE_MISSING', 'a missing worktree fails closed');
}

// The CLI surface itself must work without launching anything.
function testCliPlanAndStatus() {
  const root = path.resolve(__dirname, '..');
  const cli = path.join(root, 'tools', 'fleet-supervisor.js');
  const queueRoot = tempDir('cli-queue');
  const queueFile = path.join(queueRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, `${buildQueueWithPhases(12)}\n---\n\n## Q13 - Closed\n\n**Status:** DONE\n\n---\n\n## Q14 - Parked\n\n**Status:** BLOCKED\n`, 'utf8');
  const plan = JSON.parse(execFileSync(process.execPath, [cli, '--plan', '--queue-file', queueFile], {
    encoding: 'utf8', windowsHide: true, shell: false, cwd: root, timeout: 60_000
  }));
  equal(plan.openCount, 12, '--plan reports the fixture open item count');
  equal(plan.firstPick, 'Q1', '--plan names the deterministic first fixture pick');
  ok(plan.pickOrder[0].id === plan.firstPick, 'the first pick is the head of the pick order');
  ok(plan.notOpen.length > 0,
    '--plan reports at least one excluded phase, so the exclusion-status assertion executes');
  ok(plan.notOpen.every(entry => entry.status === 'DONE' || entry.status === 'BLOCKED'),
    'only DONE/BLOCKED phases are excluded');

  // --status against an ISOLATED state file: this test must stay green whether
  // or not a live fleet is running on the machine (before this, it read the
  // real state file and failed the moment real lanes were up).
  const isolated = newStateFile('cli-status');
  const report = JSON.parse(execFileSync(process.execPath, [cli, '--status', '--state-file', isolated, '--queue-file', queueFile], {
    encoding: 'utf8', windowsHide: true, shell: false, cwd: root, timeout: 60_000
  }).split('\n(no durable state yet')[0]);
  equal(report.laneCounts.running, 0, '--status on a never-run fleet reports zero running, not a guess');
  ok(report.killSwitch && typeof report.killSwitch.active === 'boolean', '--status surfaces the kill switch');
}

// ---------------------------------------------------------------------------
// Lane model floor: strongest verified model by default, refusal not fallback
// ---------------------------------------------------------------------------
async function testModelFloor() {
  equal(laneModels.DEFAULT_LANE_MODEL, 'gemini-3.1-pro-preview',
    'the default lane model is the verified strongest CLI model (3.1-pro, HIGH thinking via chat-base-3)');
  equal(laneModels.assertLaneModel(undefined), 'gemini-3.1-pro-preview', 'no explicit model means the default, never less');
  assert.throws(() => laneModels.assertLaneModel('gemini-2.5-flash'), /FLEET_MODEL_REFUSED|refusal/i);
  checks += 1;
  // Verified 2026-07-29: this id appears nowhere in the installed gemini-cli
  // 0.52.0 bundle, so a lane can never actually get it.
  assert.throws(() => laneModels.assertLaneModel('gemini-3.6-flash'), /FLEET_MODEL_REFUSED|refusal/i);
  checks += 1;
  assert.throws(() => new FleetSupervisor({ repoRoot: tempDir('model'), laneModel: 'gemini-1.5-pro' }),
    /refusal|model floor/i);
  checks += 1;

  // gemini-2.5-flash was listed as the Vertex light-work tier on the strength
  // of it appearing in the CLI's advertised model list. PROBED LIVE
  // 2026-07-29 through the real lane spawn path: it exits 1, and the provider
  // error names gemini-3.5-flash -- an id nobody requested, which the CLI
  // substitutes and which 404s on Vertex. It is off the floor now, and asking
  // for it explicitly must fail with the REAL cause rather than the confusing
  // raw CLI error or a generic "downgrade" message.
  equal(laneModels.ALLOWED_VERTEX_LANE_MODELS.includes('gemini-2.5-flash'), false,
    'gemini-2.5-flash is NOT on the vertex floor: it is not servable there');
  equal(laneModels.ALLOWED_VERTEX_LANE_MODELS.includes('gemini-2.5-pro'), true,
    'gemini-2.5-pro remains the vertex floor: it is the one id verified to serve');
  assert.throws(
    () => laneModels.assertLaneModelFor('vertex', 'gemini-2.5-flash'),
    error => error && error.code === 'FLEET_MODEL_NOT_SERVABLE'
      && /configured Vertex route/i.test(error.message)
      && /substitution.*refused/i.test(error.message)
  );
  checks += 1;
  try {
    laneModels.assertLaneModelFor('vertex', 'gemini-2.5-flash');
  } catch (error) {
    equal(error.code, 'FLEET_MODEL_NOT_SERVABLE',
      'a dead model gets its own code, distinct from an ordinary floor refusal');
    ok(/configured Vertex route/i.test(error.message) && /substitution.*refused/i.test(error.message),
      'and the configured authority explains that route substitution is refused');
  }
  // A build lane constructed with it is refused at construction, not at spawn.
  assert.throws(
    () => new FleetSupervisor({
      repoRoot: tempDir('deadmodel'), laneBackend: 'vertex', laneModel: 'gemini-2.5-flash'
    }),
    error => error && error.code === 'FLEET_MODEL_NOT_SERVABLE'
  );
  checks += 1;
  // The subscription flash tier is a different product and is untouched.
  equal(laneModels.notServableReason('subscription', 'gemini-3.5-flash'), null,
    'the subscription flash tier is not affected by the vertex finding');

  // The configured model reaches the lane runner and the durable lane record.
  const stateFile = newStateFile('modelwire');
  const repoRoot = path.dirname(path.dirname(stateFile));
  fs.writeFileSync(path.join(repoRoot, 'BUILD-QUEUE.md'), buildQueueWithPhases(1), 'utf8');
  const seenModels = [];
  const seenProjects = [];
  const supervisor = new FleetSupervisor({
    repoRoot, stateFile, queueFile: path.join(repoRoot, 'BUILD-QUEUE.md'), concurrency: 1,
    laneProject: 'example-dedicated-project',
    // Pinned to the subscription backend: this test is about the SUBSCRIPTION
    // floor specifically. The vertex floor is covered separately.
    laneBackend: 'subscription',
    planning: { enabled: false },
    review: { enabled: false },
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    runLane: async ({ model, project, onStart }) => {
      seenModels.push(model);
      seenProjects.push(project);
      onStart(process.pid);
      return { ok: true, changedFileCount: 1, reportedModels: ['gemini-2.5-pro'], reportedTokens: 12345 };
    }
  });
  stubWorktrees();
  const modelTick = await supervisor.tick();
  assert.equal(
    modelTick.launched.length,
    1,
    `the model wiring fixture launches exactly one lane: ${JSON.stringify({ tick: modelTick, state: stateStore.readState(stateFile) })}`
  );
  checks += 1;
  await supervisor.drain();
  restoreWorktrees();
  assert.deepStrictEqual(seenModels, ['gemini-3.1-pro-preview'], 'the lane runner receives the configured model');
  checks += 1;
  assert.deepStrictEqual(seenProjects, ['example-dedicated-project'], 'and the configured quota project');
  checks += 1;
  const state = stateStore.readState(stateFile);
  const lane = Object.values(state.lanes)[0];
  equal(lane.model, 'gemini-3.1-pro-preview', 'the durable lane record names the model that actually ran');
  equal(lane.project, 'example-dedicated-project', 'and the project the lane billed against');
  assert.deepStrictEqual(lane.outcome.reportedModels, ['gemini-2.5-pro'],
    'the models the CLI says actually SERVED are recorded, so a silent provider downgrade is visible evidence');
  checks += 1;
  supervisor.registerSelf();
  const after = stateStore.readState(stateFile);
  equal(after.supervisor.laneModel, 'gemini-3.1-pro-preview', 'the supervisor registration records the fleet model');
  equal(
    after.supervisor.laneThinking,
    laneModels.LANE_MODEL_THINKING['gemini-3.1-pro-preview'],
    'and the reasoning description comes from the configured model-floor authority'
  );
  equal(after.supervisor.laneProject, 'example-dedicated-project', 'and the quota project');
  equal(after.supervisor.geminiReportContract.version, GEMINI_REPORT_CONTRACT_VERSION,
    'the supervisor consults and records the durable report contract by default');
  ok(/^[a-f0-9]{64}$/.test(after.supervisor.geminiReportContract.sha256),
    'the durable state fingerprints the exact consulted contract document');

  // Credit burn is summed from PROVIDER-reported tokens, never estimated.
  equal(lane.outcome.reportedTokens, 12345, 'the provider-reported token total is persisted per lane');
  const burn = supervisor.status().creditBurn;
  equal(burn.subscriptionTokens, 12345, 'and rolls up per billing path so spend is measurable');
  equal(burn.vertexTokens, 0, 'with the credit path counted separately from the subscription');
}

// ---------------------------------------------------------------------------
// Vertex lane mode: billed credit path, isolated auth, no global mutation
// ---------------------------------------------------------------------------
function testVertexLaneMode() {
  const laneRunner = require('../src/lib/fleet-supervisor/lane-runner.js');
  const home = tempDir('vxhome');
  const fakeAppData = tempDir('appdata');
  const adcDir = path.join(fakeAppData, 'gcloud', 'legacy_credentials', laneRunner.VERTEX_ACCOUNT);
  fs.mkdirSync(adcDir, { recursive: true });
  fs.writeFileSync(path.join(adcDir, 'adc.json'), JSON.stringify({ type: 'authorized_user' }), 'utf8');
  const baseEnv = {
    APPDATA: fakeAppData,
    // Stale variables that MUST be stripped so a lane cannot inherit the
    // wrong billing target from whatever shell launched the supervisor.
    GOOGLE_API_KEY: 'stale', GEMINI_API_KEY: 'stale', GOOGLE_CLOUD_PROJECT: 'wrong-project',
    GEMINI_CLI_HOME: '/somewhere/else'
  };

  const vertex = laneRunner.laneEnvironment({
    backend: 'vertex', laneId: 'q9-abc', project: 'example-vertex-project',
    baseEnv, tmpdir: () => home
  });
  equal(vertex.env.GOOGLE_GENAI_USE_VERTEXAI, 'true', 'a vertex lane routes to Vertex');
  equal(vertex.env.GOOGLE_CLOUD_PROJECT, 'example-vertex-project', 'against the credit project');
  equal(vertex.env.GOOGLE_CLOUD_LOCATION, 'us-central1', 'in the verified region');
  equal(vertex.env.GEMINI_CLI_TRUST_WORKSPACE, 'true',
    'with trust-workspace set, which is what makes a headless lane fail fast instead of hanging');
  equal(vertex.env.GOOGLE_API_KEY, undefined, 'a stale API key cannot survive into a lane');
  equal(vertex.env.GEMINI_API_KEY, undefined, 'nor a stale Gemini key');
  assert.deepStrictEqual(vertex.billing,
    { backend: 'vertex', account: laneRunner.VERTEX_ACCOUNT, project: 'example-vertex-project' },
    'the lane records which account and project actually paid for it');
  checks += 1;

  // THE LOAD-BEARING ONE: auth is switched per-lane, never globally.
  ok(vertex.env.GEMINI_CLI_HOME && vertex.env.GEMINI_CLI_HOME.startsWith(home),
    'the vertex auth type lives in a per-lane settings home');
  notEqual(vertex.env.GEMINI_CLI_HOME, '/somewhere/else', 'and never inherits an outside GEMINI_CLI_HOME');
  const written = JSON.parse(fs.readFileSync(path.join(vertex.env.GEMINI_CLI_HOME, 'settings.json'), 'utf8'));
  equal(written.security.auth.selectedType, 'vertex-ai', 'that per-lane home selects vertex-ai');
  const globalSettings = path.join(os.homedir(), '.gemini', 'settings.json');
  notEqual(path.resolve(path.join(vertex.env.GEMINI_CLI_HOME, 'settings.json')), path.resolve(globalSettings),
    'the lane settings target is never the user-global Gemini settings path');
  notEqual(path.resolve(vertex.env.GEMINI_CLI_HOME), path.resolve(path.dirname(globalSettings)),
    'the isolated lane home is distinct from the user-global Gemini home');

  // Missing credit credentials must REFUSE, never silently bill the owner.
  const noCreds = { APPDATA: tempDir('empty-appdata') };
  assert.throws(
    () => laneRunner.laneEnvironment({ backend: 'vertex', laneId: 'q9-x', project: 'p', baseEnv: noCreds, tmpdir: () => home }),
    error => error.code === 'FLEET_VERTEX_CREDENTIALS_MISSING',
    'a vertex lane without the credit account refuses rather than falling back to the subscription'
  );
  checks += 1;
  assert.throws(
    () => laneRunner.laneEnvironment({ backend: 'vertex', laneId: 'q9-y', project: null, baseEnv, tmpdir: () => home }),
    error => error.code === 'FLEET_VERTEX_PROJECT_MISSING',
    'and a vertex lane without an explicit project refuses'
  );
  checks += 1;

  // A subscription lane must NOT get vertex routing.
  const sub = laneRunner.laneEnvironment({ backend: 'subscription', laneId: 'q9-s', baseEnv, tmpdir: () => home });
  equal(sub.env.GOOGLE_GENAI_USE_VERTEXAI, undefined, 'a subscription lane is never routed to Vertex');
  equal(sub.env.GEMINI_CLI_HOME, undefined, "and uses the owner's own persisted login");
  equal(sub.billing.backend, 'subscription', 'and records that it billed the subscription');
}

// ---------------------------------------------------------------------------
// Backend-aware model floors, and catching a SILENT below-floor serve
// ---------------------------------------------------------------------------
function testBackendFloorsAndSilentDowngrade() {
  equal(laneModels.DEFAULT_BACKEND, 'vertex', 'the fleet defaults to the billed credit path (owner order R58)');
  equal(laneModels.assertLaneModelFor('vertex', undefined), 'gemini-2.5-pro',
    'the vertex floor is the best model that project actually serves');
  equal(laneModels.assertLaneModelFor('subscription', undefined), 'gemini-3.1-pro-preview',
    'the subscription floor is unchanged and separate');
  // The 3.x ids 404 on that Vertex project, so accepting one would guarantee a failed lane.
  assert.throws(() => laneModels.assertLaneModelFor('vertex', 'gemini-3.1-pro-preview'),
    error => error.code === 'FLEET_MODEL_REFUSED');
  checks += 1;
  assert.throws(() => laneModels.assertBackend('bargain-bin'),
    error => error.code === 'FLEET_BACKEND_INVALID');
  checks += 1;

  // The measured live failure: a pro request answered with flash tiers.
  // Under owner request R95 the light-work carve-out is closed, so BOTH of
  // these are below floor now -- gemini-3.5-flash used to be tolerated here
  // and is not any more. The floor comes from config/model-floor.json, so
  // this expectation moves with the authority rather than restating it.
  assert.deepStrictEqual(
    laneModels.servedBelowFloor('subscription', ['gemini-3.1-flash-lite', 'gemini-3.5-flash']),
    ['gemini-3.1-flash-lite', 'gemini-3.5-flash'],
    'after R95 every silent flash serve against a pro request is below-floor, not just flash-lite'
  );
  checks += 1;
  assert.deepStrictEqual(laneModels.servedBelowFloor('vertex', ['gemini-2.5-pro']), [],
    'the verified vertex serve is on-floor');
  checks += 1;
  equal(laneModels.servedBelowFloor('vertex', null), null,
    'a silent CLI is UNKNOWN, never silently treated as compliant');
}

// ---------------------------------------------------------------------------
// The review tier runs on Codex -- never Claude, never Sol (owner order R77)
// ---------------------------------------------------------------------------
// Owner's words: "dont use any claude or sol use terrra or luna or such".
// Terra/Luna are Codex tiers. A silent fallback onto an expensive tier would
// be both a budget leak and a directive violation, so this pins that the
// reviewer can ONLY ever be a codex/gemini provider and that exhausting the
// preference is an explicit REFUSAL rather than a substitution.
function testReviewerIsCodexTierNeverClaudeOrSol() {
  const reviewStage = require('../src/lib/fleet-supervisor/review.js');
  const preference = reviewStage.DEFAULT_REVIEWER_PREFERENCE;
  ok(Array.isArray(preference) && preference.length > 0, 'the reviewer preference is a real list');
  equal(preference[0], 'codex', 'codex (Terra/Luna) is the FIRST choice reviewer');
  for (const banned of ['claude', 'sol', 'opus', 'fable', 'sonnet']) {
    ok(!preference.includes(banned), `${banned} is not a reachable reviewer provider`);
  }

  // Nothing available => refusal with a recorded reason, never a substitution.
  const exhausted = reviewStage.chooseReviewer({
    laneProvider: 'gemini',
    repoRoot: tempDir('rev'),
    availabilityImpl: providerId => ({ providerId, available: false, reason: 'stubbed-unavailable' })
  });
  equal(exhausted.providerId, null, 'with no codex available the reviewer choice REFUSES');
  ok(/no-reviewer-available/.test(exhausted.reason), 'and records why, instead of silently picking something pricier');
  ok(exhausted.checked.some(entry => entry.providerId === 'codex'),
    'and the refusal shows codex was actually attempted');

  // A gemini lane can never review itself, even if listed first.
  const selfReview = reviewStage.chooseReviewer({
    laneProvider: 'gemini',
    preference: ['gemini', 'codex'],
    repoRoot: tempDir('rev2'),
    availabilityImpl: providerId => ({ providerId, available: true, reason: null })
  });
  equal(selfReview.providerId, 'codex', 'reordering the preference cannot make a lane its own reviewer');
}

// ---------------------------------------------------------------------------
// Lane ids carry the CLAIMED item, not openItemIds[0]
// ---------------------------------------------------------------------------
function testLaneIdCarriesClaimedItem() {
  const stateFile = newStateFile('laneid');
  const opts = { openItemIds: ['Q17', 'Q18', 'Q20'], supervisorId: 'sup', concurrency: 8, maxAttempts: 3, maxNoProgressAttempts: 2 };
  const first = claimNext(stateFile, { ...opts, laneIdFor: itemId => `${itemId.toLowerCase()}-aaaa` });
  equal(first.claimed.itemId, 'Q17', 'the lowest open item is claimed first');
  equal(first.claimed.laneId, 'q17-aaaa', 'and its lane id is slugged from THAT item');
  const second = claimNext(stateFile, { ...opts, laneIdFor: itemId => `${itemId.toLowerCase()}-bbbb` });
  equal(second.claimed.itemId, 'Q18', 'the next claim takes the next item');
  equal(second.claimed.laneId, 'q18-bbbb',
    'whose lane id carries q18-, not q17- (the old bug named EVERY lane after the lowest open item)');
  const collision = claimNext(stateFile, { ...opts, laneIdFor: () => 'q17-aaaa' });
  equal(collision.claimed, null, 'a colliding generated lane id is refused, not overwritten');
}

// ---------------------------------------------------------------------------
// Transient provider failures: refund + cooldown, never a parked item
// ---------------------------------------------------------------------------
function testTransientFailureRefundAndCooldown() {
  ok(isTransientFailureDetail('...project is experiencing high traffic and has hit its quota limits...'),
    'the live 2026-07-28 Gemini quota error is classified transient');
  ok(!isTransientFailureDetail('SyntaxError: unexpected token'), 'a real code failure is NOT transient');

  const stateFile = newStateFile('transient');
  const opts = { openItemIds: ['Q1'], supervisorId: 'sup', concurrency: 4, maxAttempts: 3, maxNoProgressAttempts: 2 };
  let clock = Date.parse('2026-07-28T23:00:00.000Z');
  const now = () => new Date(clock);

  const claim = claimNext(stateFile, { ...opts, laneId: 'lane-t1', now });
  equal(claim.claimed.itemId, 'Q1', 'claimed');
  recordLaneOutcome(stateFile, 'lane-t1', {
    ok: false, code: 'EXIT_NONZERO',
    detail: 'Google Cloud project is experiencing high traffic and has hit its quota limits.',
    changedFileCount: 0, maxAttempts: 3, maxNoProgressAttempts: 2, now
  });
  let state = stateStore.readState(stateFile);
  equal(state.items.Q1.attempts, 0, 'a quota failure REFUNDS the attempt instead of burning the budget');
  equal(state.items.Q1.transientFailures, 1, 'and is counted as a transient failure');
  equal(state.items.Q1.noProgressAttempts, 0, 'a zero-diff quota kill does not move the no-progress streak');
  ok(state.items.Q1.cooldownUntil > now().toISOString(), 'the item is on cooldown');
  ok(state.lanes['lane-t1'].outcome.transient === true, 'the lane outcome is marked transient');

  equal(state.items.Q1.cooldownSource, 'supervisor-backoff',
    'with no stated reset window the supervisor uses its own bounded backoff');

  const during = claimNext(stateFile, { ...opts, laneId: 'lane-t2', now });
  equal(during.claimed, null, 'a cooling item is not re-claimed into the same congestion');
  clock += 6 * 60_000;
  const after = claimNext(stateFile, { ...opts, laneId: 'lane-t3', now });
  equal(after.claimed && after.claimed.itemId, 'Q1', 'after the cooldown it is claimable again');

  // A NON-transient failure still burns the budget as before.
  recordLaneOutcome(stateFile, 'lane-t3', {
    ok: false, code: 'EXIT_NONZERO', detail: 'tests failed: 3 assertions',
    changedFileCount: 1, maxAttempts: 3, maxNoProgressAttempts: 2, now
  });
  state = stateStore.readState(stateFile);
  equal(state.items.Q1.attempts, 1, 'a genuine failure keeps its attempt spent');

  // The refund is capped so permanent throttling still converges to parked.
  clock += 60 * 60_000;
  for (let guard = 0; guard < 4 * (TRANSIENT_REFUND_CAP + 4); guard += 1) {
    const next = claimNext(stateFile, { ...opts, laneId: `lane-cap-${guard}`, now });
    if (!next.claimed) {
      if (stateStore.readState(stateFile).items.Q1.condition === 'parked') break;
      clock += 31 * 60_000; // wait out the cooldown, bounded by the guard
      continue;
    }
    recordLaneOutcome(stateFile, next.claimed.laneId, {
      ok: false, code: 'EXIT_NONZERO', detail: 'quota limits again', changedFileCount: 0,
      maxAttempts: 3, maxNoProgressAttempts: 2, now
    });
    clock += 31 * 60_000;
  }
  state = stateStore.readState(stateFile);
  ok(state.items.Q1.attempts > 1, 'past the refund cap, transient failures start spending attempts again');
  equal(state.items.Q1.condition, 'parked', 'so a permanently throttled item still converges to parked, not an infinite spin');
}

// ---------------------------------------------------------------------------
// A provider that states WHEN capacity returns is honored over our backoff
// ---------------------------------------------------------------------------
function testProviderStatedQuotaReset() {
  // The exact live string from the subscription CLI, 2026-07-29T00:05Z.
  const live = 'You have exhausted your capacity on this model. Your quota will reset after 11h43m52s.';
  equal(quotaResetDelayMs(live), ((11 * 3600) + (43 * 60) + 52) * 1000,
    "the provider's own stated reset window is parsed exactly");
  equal(quotaResetDelayMs('quota will reset after 45m'), 45 * 60_000, 'a minutes-only window parses');
  equal(quotaResetDelayMs('no window stated here'), null, 'a silent provider yields null, never a guess');
  // A hostile/absurd window must not be able to park the fleet for a year.
  equal(quotaResetDelayMs('quota will reset after 9999h'), QUOTA_RESET_MAX_MS,
    'an absurd stated window is capped, because provider text is untrusted input');

  const stateFile = newStateFile('quotareset');
  const opts = { openItemIds: ['Q1'], supervisorId: 'sup', concurrency: 4, maxAttempts: 3, maxNoProgressAttempts: 2 };
  const clock = Date.parse('2026-07-29T00:05:00.000Z');
  const now = () => new Date(clock);
  claimNext(stateFile, { ...opts, laneId: 'lane-q', now });
  recordLaneOutcome(stateFile, 'lane-q', {
    ok: false, code: 'EXIT_NONZERO', detail: live, changedFileCount: 0,
    maxAttempts: 3, maxNoProgressAttempts: 2, now
  });
  const item = stateStore.readState(stateFile).items.Q1;
  equal(item.cooldownSource, 'provider-stated-reset', 'the cooldown records that the provider set it');
  equal(item.cooldownUntil, new Date(clock + (((11 * 3600) + (43 * 60) + 52) * 1000)).toISOString(),
    'and the item sleeps until capacity actually returns instead of relaunching ~90 doomed lanes');
}

// ---------------------------------------------------------------------------
// Result contract: FILES-READ/FILES-CHANGED parsed and checked against disk
// ---------------------------------------------------------------------------
async function testResultContract() {
  const parsed = parseReportedFiles('Did the work.\nFILES-READ: src/a.js, `docs/b.md`\nFILES-CHANGED: src/a.js');
  assert.deepStrictEqual(parsed, { filesRead: ['src/a.js', 'docs/b.md'], filesChanged: ['src/a.js'] },
    'the contract lines parse into bounded path lists');
  checks += 1;
  assert.deepStrictEqual(parseReportedFiles('FILES-READ: (none)\nFILES-CHANGED: (none)'),
    { filesRead: [], filesChanged: [] }, '(none) is an explicit empty list');
  checks += 1;
  equal(parseReportedFiles('no contract lines at all'), null, 'absence is null, never invented');

  // The brief itself carries the contract instruction.
  const phases = queueReader.parseBuildQueue(SAMPLE_QUEUE);
  const brief = queueReader.buildLaneBrief(phases.find(p => p.id === 'Q11'), 'proto', { laneId: 'x', worktree: 'y' });
  ok(brief.includes('FILES-READ:'), 'every lane brief demands the FILES-READ contract line');
  ok(brief.includes('FILES-CHANGED:'), 'and the FILES-CHANGED contract line');

  // End-to-end: a lane naming a file that does not exist in its worktree is
  // recorded as contract-broken -- the imagined-schema tripwire.
  const stateFile = newStateFile('contract');
  const repoRoot = path.dirname(path.dirname(stateFile));
  fs.writeFileSync(path.join(repoRoot, 'BUILD-QUEUE.md'), buildQueueWithPhases(1), 'utf8');
  const supervisor = new FleetSupervisor({
    repoRoot, stateFile, queueFile: path.join(repoRoot, 'BUILD-QUEUE.md'), concurrency: 1,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    runLane: async ({ onStart }) => {
      onStart(process.pid);
      return {
        ok: true, changedFileCount: 1,
        reportedFiles: { filesRead: ['src/imagined-schema.js'], filesChanged: [] }
      };
    }
  });
  stubWorktrees();
  await supervisor.tick();
  await supervisor.drain();
  restoreWorktrees();
  const lane = Object.values(stateStore.readState(stateFile).lanes)[0];
  ok(lane.contract && lane.contract.reported === true, 'the lane contract is recorded');
  assert.deepStrictEqual(lane.contract.missing, ['src/imagined-schema.js'],
    'a reported file absent from the worktree is flagged for the review stage');
  checks += 1;
}

// ---------------------------------------------------------------------------
// Graceful stop sentinel
// ---------------------------------------------------------------------------
async function testStopFile() {
  const stateFile = newStateFile('stop');
  const repoRoot = path.dirname(path.dirname(stateFile));
  fs.writeFileSync(path.join(repoRoot, 'BUILD-QUEUE.md'), buildQueueWithPhases(3), 'utf8');
  const stopFile = path.join(repoRoot, 'state', 'fleet-supervisor.stop');
  fs.mkdirSync(path.dirname(stopFile), { recursive: true });
  fs.writeFileSync(stopFile, '{}', 'utf8');

  let launches = 0;
  const supervisor = new FleetSupervisor({
    repoRoot, stateFile, queueFile: path.join(repoRoot, 'BUILD-QUEUE.md'), concurrency: 2, pollMs: 0, stopFile,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    runLane: async () => { launches += 1; return { ok: true, changedFileCount: 1 }; }
  });
  stubWorktrees();
  await supervisor.run({ maxCycles: 5, sleep: () => new Promise(resolve => setImmediate(resolve)) });
  restoreWorktrees();
  equal(launches, 0, 'a supervisor that sees the stop sentinel claims nothing and exits');
  equal(supervisor.stopping, true, 'and records that it is stopping');
}

// ---------------------------------------------------------------------------
// Worktree retention: keep newest per item (+active), remove older, real git
// ---------------------------------------------------------------------------
function testWorktreeRetention() {
  const base = tempDir('retention');
  const repoRoot = path.join(base, 'ToolsEnabled');
  fs.mkdirSync(repoRoot, { recursive: true });
  const git = args => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true, shell: false });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'a\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);

  const mk = (laneId, itemId, createdAt) => worktrees.createLaneWorktree(laneId, {
    repoRoot, supervisorId: 'sup', itemId, now: () => new Date(createdAt)
  });
  mk('q9-old', 'Q9', '2026-07-28T01:00:00.000Z');
  mk('q9-new', 'Q9', '2026-07-28T02:00:00.000Z');
  mk('q8-active-old', 'Q8', '2026-07-28T01:00:00.000Z');
  mk('q8-live', 'Q8', '2026-07-28T02:00:00.000Z');
  // A directory in the namespace with NO marker must be refused, not deleted.
  const unmarked = path.join(base, 'ToolsEnabled-fleet-lane-mystery');
  fs.mkdirSync(unmarked, { recursive: true });

  const report = worktrees.pruneLaneWorktrees({ repoRoot, activeLaneIds: ['q8-active-old'] });
  const keptIds = report.kept.map(entry => entry.laneId).sort();
  assert.deepStrictEqual(keptIds, ['q8-active-old', 'q8-live', 'q9-new'],
    'newest per item is kept, and an ACTIVE older lane is never removed');
  checks += 1;
  assert.deepStrictEqual(report.removed.map(entry => entry.laneId), ['q9-old'],
    'only the superseded inactive worktree is removed');
  checks += 1;
  ok(!fs.existsSync(path.join(base, 'ToolsEnabled-fleet-lane-q9-old')), 'and it is really gone from disk');
  ok(fs.existsSync(path.join(base, 'ToolsEnabled-fleet-lane-q9-new')), 'while the newest survives');
  ok(report.refused.some(entry => entry.path.endsWith('ToolsEnabled-fleet-lane-mystery')),
    'an unmarked directory in the namespace is refused, never deleted');
  ok(fs.existsSync(unmarked), 'and still exists');

  // The protected non-fleet namespace is invisible to the prune entirely.
  const protectedDir = path.join(base, 'ToolsEnabled-lane-s11-board');
  fs.mkdirSync(protectedDir, { recursive: true });
  const second = worktrees.pruneLaneWorktrees({ repoRoot, activeLaneIds: [] });
  ok(second.removed.length > 0,
    'the second prune removes at least one superseded fleet worktree, so the namespace assertion executes');
  ok(second.removed.every(entry => !entry.path.includes('ToolsEnabled-lane-s11')),
    'ToolsEnabled-lane-* (no fleet-) is never even considered');
  ok(fs.existsSync(protectedDir), 'and is untouched');
}

// ---------------------------------------------------------------------------
// Doctrine countermeasure #1, enforced in code: the brief injects the REAL
// shape of every producer file the phase names.
//
// The countermeasure ("a brief must name the exact producer file that writes
// any data the lane consumes") was documented and unenforced -- buildLaneBrief
// supplied generic prohibitions and left producer files and expected shapes to
// whatever prose a human typed. Imagined schemas are the highest-frequency,
// highest-damage failure mode we have measured, so the shape now comes from the
// file that DEFINES it, extracted mechanically.
// ---------------------------------------------------------------------------
function testBriefInjectsProducerGroundTruth() {
  const repoRoot = tempDir('ground-truth');
  fs.mkdirSync(path.join(repoRoot, 'src', 'lib'), { recursive: true });
  // The exact shape of the s09 escape: a producer writing result.id /
  // result.error.code, and nothing called `details`.
  fs.writeFileSync(path.join(repoRoot, 'src', 'lib', 'send-producer.js'), [
    "'use strict';",
    'function recordSend(file, { ok, provider, id = null, errorCode = null }) {',
    '  const entry = { at: new Date().toISOString(), ok, provider, result: { id, error: errorCode ? { code: errorCode } : null } };',
    '  return entry;',
    '}',
    'module.exports = { recordSend };',
    ''
  ].join('\n'), 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'config'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'config', 'shape.json'), '{"alpha":1,"beta":2}\n', 'utf8');

  const phase = {
    id: 'Q99',
    body: 'Consume the send log written by `src/lib/send-producer.js` and mirror `config/shape.json`. '
      + 'Emit `src/lib/send-history.js`, which does not exist yet.'
  };
  const brief = queueReader.buildLaneBrief(phase, 'proto', { laneId: 'q99-a', worktree: 'C:/wt', repoRoot });

  ok(brief.includes('GROUND TRUTH'), 'the brief carries a generated ground-truth block');
  ok(brief.includes('src/lib/send-producer.js'), 'naming the exact producer file the phase referenced');
  ok(/exports:.*recordSend/.test(brief), 'with the real exported symbol extracted from the file');
  ok(/keys this file writes:.*result/.test(brief), 'and the real keys the producer emits');
  ok(brief.includes('config/shape.json') && /alpha/.test(brief), 'JSON producers contribute their real top-level keys');
  // The block itself, not the verbatim phase body that follows it.
  const block = brief.slice(brief.indexOf('GROUND TRUTH'), brief.indexOf('BUILDER PROTOCOL'));
  ok(!block.includes('src/lib/send-history.js'),
    'a path the phase must CREATE is not presented as ground truth -- it has no shape yet');
  ok(/QUOTE the real emitted\s+shape back/.test(brief),
    'and the lane is told to quote the real shape before consuming it, as the doctrine demands');

  // Extraction is mechanical and reports what it cannot do rather than inventing.
  const rows = queueReader.producerGroundTruth(['src/lib/send-producer.js', 'nope.js'], { repoRoot });
  equal(rows.length, 1, 'a referenced path that does not exist yields no row at all, never a guessed one');
  ok(rows[0].emittedKeys.includes('result'), 'the emitted-key extraction is real');
  ok(!rows[0].emittedKeys.includes('details'), 'and it cannot report a key the producer does not write');

  // A path escaping the repo is never read on the strength of a queue string.
  equal(queueReader.producerGroundTruth(['../../../../etc/passwd'], { repoRoot }).length, 0,
    'a referenced path escaping the repo root is refused');

  // Backwards compatible: without a repoRoot there is no invented block.
  const bare = queueReader.buildLaneBrief(phase, 'proto', { laneId: 'q99-b', worktree: 'C:/wt' });
  ok(!bare.includes('GROUND TRUTH'), 'with no repoRoot, no ground-truth block is fabricated');
}

function testChangedFileCountPreservesProbeFailure() {
  equal(changedFileCount('/unavailable-worktree', () => { throw new Error('git status unavailable'); }), null,
    'an unavailable git status is unmeasured, never reported as a definite clean worktree');
}

async function runAll() {
  testQueueParsing();
  testChangedFileCountPreservesProbeFailure();
  testBriefInjectsProducerGroundTruth();
  testWorktreeGuard();
  // Real-git scenarios run before anything stubs the worktree module.
  testMaterializesUncommittedWorkingState();
  await testStaleSnapshotBackstop();
  testAtomicClaiming();
  await testCrossProcessClaiming();
  testRestartResume();
  testCorruptStateRefusesToStartEmpty();
  testRetryCapping();
  testHonestUnknownState();
  testLaneCannotVerifyItself();
  testLaneRecordPruning();
  testConcurrencyValidation();
  testNoUnguardedRemovalPath();
  testScheduledTaskIsWindowless();
  await testLaneSpawnContract();
  testCliPlanAndStatus();
  testLaneIdCarriesClaimedItem();
  testVertexLaneMode();
  testBackendFloorsAndSilentDowngrade();
  testReviewerIsCodexTierNeverClaudeOrSol();
  testTransientFailureRefundAndCooldown();
  testProviderStatedQuotaReset();
  testWorktreeRetention();
  await testDryRun();
  await testModelFloor();
  await testResultContract();
  await testStopFile();
  // Stubbed-worktree scenarios last; restoreWorktrees() puts the real module back.
  await testConcurrencyLimiting();
  await testKillSwitchGate();
  await testKeepsLanesFilled();
  restoreWorktrees();
}

runAll()
  .then(() => {
    cleanup();
    console.log(`fleet-supervisor tests passed (${checks} checks).`);
  })
  .catch(error => {
    cleanup();
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
