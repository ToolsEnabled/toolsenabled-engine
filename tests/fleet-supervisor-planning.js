'EXECUTABLE CHANGE';
'use strict';

// Assertion audit (testcanfail-tests-fleet-supervisor-planning-js):
// - SAME-CODE-EXPECTED: MAX_SUBTASKS constructed its own boundary case, and
//   exported failure/wiring constants supplied their own expected values.
// - ALWAYS-TRUE: the fallback-path test ended with ok(true).
// - NOT-FOUND: vacuous assertion loops (the receivedBriefs loop has an exact
//   length precondition); exit-status-only evidence; swallowed subject
//   failures; mocks of planning validation/status behavior; platform skips or
//   silent precondition guards.
// Mutation: changing planning.js MAX_SUBTASKS from 8 to 9 left the original
// suite GREEN: "fleet-supervisor planning tests passed (149 checks)." With the
// independent expectation below it is RED:
// "[validateSubtasks] the decomposition doctrine permits at most eight sub-tasks"
// "9 !== 8"
// Source restoration was byte-for-byte (SHA-256 de46d8a876c62e36876d29632a86ea40031584ad1e90f2438ee7e42197f5304a).

// Tests for the fleet supervisor's planning pass (owner ledger R91):
//
//   "the manager is not just reviewing work they dispatch work effectively...
//    more pre planning to help the gemini models might help too."
//
// Covers what src/lib/fleet-supervisor/planning.js and its wiring into
// supervisor.js exist to guarantee:
//   1. the planner extracts and validates a bounded, grounded sub-task list
//      from a model reply (JSON extraction, coherence checks, fabricated
//      ground-truth citations discarded rather than trusted)
//   2. a planning call NEVER throws and NEVER spends a phase's/sub-task's
//      attempt budget -- planPhase()/ensurePlans() always resolve, and
//      state.items is untouched by planning itself
//   3. a `ready` plan makes sub-task ids (not the phase id) the claimable
//      unit, each dispatched with its OWN bounded brief
//   4. a sub-task that fails repeatedly parks at the SUB-TASK level without
//      blowing its sibling sub-tasks' or the phase's own budget
//   5. an incoherent or failed plan falls back to the OLD whole-phase
//      dispatch rather than blocking the phase
//   6. phase-level status aggregates sub-task verdicts ("Qn: x/y verified")
//
// Nothing here spawns a real gemini/codex process or creates a real git
// worktree except where the existing suite's own real-repo pattern is reused.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const queueReader = require('../src/lib/fleet-supervisor/queue.js');
const stateStore = require('../src/lib/fleet-supervisor/state.js');
const worktreeModule = require('../src/lib/fleet-supervisor/worktree.js');
const planningStage = require('../src/lib/fleet-supervisor/planning.js');
const { providerCallEvent } = require('../src/lib/fleet-supervisor/direct-vertex-receipt.js');
const {
  FleetSupervisor, expandClaimableItems, isSubtaskSettled, phaseDecompositionSummary, subtaskItemId,
  status, markVerified
} = require('../src/lib/fleet-supervisor/supervisor.js');

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

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-plan-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Same stub used by tests/fleet-supervisor.js: replace worktree creation with
// an in-memory stand-in so supervisor-level dispatch tests never invoke git.
// The real worktree mechanics are covered by that suite, not this one.
const TRUE_WORKTREE_FNS = {
  createLaneWorktree: worktreeModule.createLaneWorktree,
  removeLaneWorktree: worktreeModule.removeLaneWorktree,
  materializeWorkingTree: worktreeModule.materializeWorkingTree,
  captureBaselineTree: worktreeModule.captureBaselineTree,
  changedSinceBaseline: worktreeModule.changedSinceBaseline
};
/* `changed` lets a scenario state what the SUPERVISOR would measure. It matters
   because supervisor.js deliberately does not fall back to the runner's own
   changedFileCount -- "the runner's differently based count must not turn a
   failed supervisor measurement into a definite answer" -- so a lane returning
   changedFileCount: 0 no longer reaches the no-progress rule at all. The lane id
   is slugged from the item id (Q5::bad -> q5bad-...), so the worktree path names
   which item is running. */
function stubWorktrees({ changed = null } = {}) {
  worktreeModule.createLaneWorktree = laneId => ({ path: path.join(os.tmpdir(), `stub-${laneId}`), marker: {} });
  worktreeModule.removeLaneWorktree = () => ({ removed: false, viaGit: false, detail: 'stubbed' });
  /* THE SEAM GREW AND THIS DOUBLE DID NOT. supervisor.js now captures a baseline
     tree right after materialization -- `git add -A` plus `git write-tree` in the
     lane worktree -- so that progress is measured against the materialized state
     rather than against HEAD, where ~700 materialized files would make every lane
     look productive and silently disable the no-progress park rule.
     This stub creates a PATH under the temp directory, not a git worktree, so the
     real captureBaselineTree threw, the supervisor refused the lane by design with
     BASELINE_CAPTURE_FAILED, and no lane ever ran. The suite failed at its sixth
     test of fifteen and runAll rethrows, so tests 7-15 never executed at all.
     changedSinceBaseline needs no double: it already answers null -- unknown --
     rather than pretending, which is the behaviour a stubbed lane should see. */
  worktreeModule.captureBaselineTree = () => 'stubbaselinetree0000000000000000000000000';
  if (changed) worktreeModule.changedSinceBaseline = worktree => changed(String(worktree));
  worktreeModule.materializeWorkingTree = () => ({
    complete: true, reason: null, trackedExpected: [], trackedMissing: [],
    untrackedExpected: 0, untrackedCopied: 0, untrackedSkipped: [], patchBytes: 0
  });
}
function restoreWorktrees() {
  Object.assign(worktreeModule, TRUE_WORKTREE_FNS);
}

function samplePhase(id = 'Q1', body = 'Build a thing.') {
  const text = [
    '# BUILD-QUEUE', '', '## Builder protocol (read once per loop)', '', '**Pick rule:** lowest open.', '',
    '---', '', `## ${id} - Sample phase`, '', '**Status:** OPEN', body, ''
  ].join('\n');
  const parsed = queueReader.parseBuildQueue(text);
  return { phase: parsed[0], protocol: queueReader.builderProtocol(text), text };
}

function validPlannerResponse(subtasks) {
  return `Some reasoning here.\n${planningStage.SUBTASKS_LABEL} ${JSON.stringify(subtasks)}\n`;
}

function acceptedDirectVertexEvidence(laneId) {
  const binding = { callId: `lane:${laneId}:attempt:1`, attemptNumber: 1, artifactProduced: true };
  const rawResponse = { modelVersion: 'gemini-2.5-pro', responseId: `planning-${laneId}-response` };
  return { providerCallEvent: providerCallEvent({ binding, rawResponse }), rawResponse };
}

// ---------------------------------------------------------------------------
// 1. JSON extraction
// ---------------------------------------------------------------------------
function testExtractSubtasksJson() {
  const good = planningStage.extractSubtasksJson(
    `I will split this up.\n${planningStage.SUBTASKS_LABEL} [{"id":"s1","title":"t"}]\ntrailing text ignored`
  );
  ok(good.ok, 'a well-formed array after the label extracts cleanly');
  equal(good.value.length, 1, 'one element parsed');

  // A literal "]" inside a quoted scope string must not truncate the array.
  const tricky = planningStage.extractSubtasksJson(
    `${planningStage.SUBTASKS_LABEL} [{"id":"s1","scope":"handles [brackets] fine"},{"id":"s2"}]`
  );
  ok(tricky.ok, 'bracket-matching is string-aware');
  equal(tricky.value.length, 2, 'both elements survive a bracket inside a string');

  const noLabel = planningStage.extractSubtasksJson('just prose, no label at all');
  equal(noLabel.ok, false, 'missing label is reported, not guessed');
  equal(noLabel.reason, 'no-SUBTASKS-JSON-label-in-planner-output');

  const noArray = planningStage.extractSubtasksJson(`${planningStage.SUBTASKS_LABEL} not an array`);
  equal(noArray.ok, false, 'a label with no following array is reported');

  const unbalanced = planningStage.extractSubtasksJson(`${planningStage.SUBTASKS_LABEL} [{"id":"s1"}`);
  equal(unbalanced.ok, false, 'an unterminated array is reported, not silently truncated');

  const badJson = planningStage.extractSubtasksJson(`${planningStage.SUBTASKS_LABEL} [{"id":}]`);
  equal(badJson.ok, false, 'invalid JSON inside a balanced array is reported');
}

// ---------------------------------------------------------------------------
// 2. Sub-task validation: bounded, grounded, coherent
// ---------------------------------------------------------------------------
function testValidateSubtasks() {
  const repoRoot = tempDir('validate-repo');
  fs.mkdirSync(path.join(repoRoot, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'lib', 'real-producer.js'), 'module.exports = {};\n', 'utf8');

  // A coherent, bounded plan citing one real file and one fabricated one.
  const result = planningStage.validateSubtasks([
    {
      id: 's1', title: 'Add the thing', scope: 'Implements the thing described in the phase body.',
      newFiles: ['src/lib/new-thing.js', 'tests/new-thing.js'],
      groundTruthFiles: ['src/lib/real-producer.js', 'src/lib/does-not-exist.js']
    }
  ], { repoRoot });
  ok(result.ok, 'a single well-formed, grounded subtask validates');
  equal(result.subtasks.length, 1, 'one subtask survives');
  assert.deepStrictEqual(result.subtasks[0].groundTruthFiles, ['src/lib/real-producer.js'],
    'a fabricated ground-truth citation is dropped; a real one is kept');
  checks += 1;

  // Zero subtasks is incoherent.
  equal(planningStage.validateSubtasks([], { repoRoot }).ok, false, 'zero subtasks is incoherent');

  // Not an array at all.
  equal(planningStage.validateSubtasks({ not: 'an array' }, { repoRoot }).ok, false,
    'a non-array planner reply is incoherent');

  // Too many subtasks.
  equal(planningStage.MAX_SUBTASKS, 8, 'the decomposition doctrine permits at most eight sub-tasks');
  const tooMany = Array.from({ length: 9 }, (_, i) => ({
    id: `s${i}`, title: 't', scope: 'a scope long enough to pass the minimum length check',
    newFiles: ['src/lib/a.js', 'src/lib/b.js'], groundTruthFiles: []
  }));
  equal(planningStage.validateSubtasks(tooMany, { repoRoot }).ok, false,
    'more than eight subtasks is rejected as unbounded');

  // Partial coherence: one good subtask survives even though a sibling is malformed.
  const mixed = planningStage.validateSubtasks([
    { id: 's1', title: 'Good one', scope: 'a scope long enough to pass the minimum length check', newFiles: ['src/lib/a.js', 'tests/a.js'], groundTruthFiles: [] },
    { id: 's2', title: '', scope: 'missing title should drop this one', newFiles: ['src/lib/b.js'], groundTruthFiles: [] },
    { id: 's1', title: 'Duplicate id', scope: 'a scope long enough to pass the minimum length check', newFiles: ['src/lib/c.js'], groundTruthFiles: [] }
  ], { repoRoot });
  ok(mixed.ok, 'one valid subtask is enough to keep the plan usable');
  equal(mixed.subtasks.length, 1, 'the malformed and duplicate-id entries are dropped, not kept');
  equal(mixed.dropped.length, 2, 'both drops are recorded for the reason field');

  // A subtask with too many/too few newFiles is dropped (doctrine bound).
  const boundsCheck = planningStage.validateSubtasks([
    { id: 's1', title: 't', scope: 'a scope long enough to pass the minimum length check', newFiles: [], groundTruthFiles: [] }
  ], { repoRoot });
  equal(boundsCheck.ok, false, 'a subtask naming zero new files has no bounded unit and is incoherent alone');

  const unreadableFs = Object.create(fs);
  unreadableFs.statSync = () => { const error = new Error('repository read failed'); error.code = 'EIO'; throw error; };
  assert.throws(() => planningStage.validateSubtasks([
    {
      id: 's1', title: 'Unreadable citation', scope: 'a scope long enough to pass the minimum length check',
      newFiles: ['src/lib/a.js'], groundTruthFiles: ['src/lib/real-producer.js']
    }
  ], { repoRoot, fsImpl: unreadableFs }), /repository read failed/,
  'an unmeasurable citation is not collapsed into a fabricated-file negative');
  checks += 1;
}

// ---------------------------------------------------------------------------
// 3. planPhase end-to-end: ready plan, and every documented fallback path
// ---------------------------------------------------------------------------
async function testPlanPhaseReady() {
  const repoRoot = tempDir('plan-ready-repo');
  fs.mkdirSync(path.join(repoRoot, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'lib', 'existing.js'), 'module.exports = { thing: 1 };\n', 'utf8');
  const { phase, protocol } = samplePhase('Q1', 'Extend `src/lib/existing.js` with a new capability.');

  const subtasks = [
    { id: 's1', title: 'Implement', scope: 'Implements the new capability in existing.js.', newFiles: ['src/lib/existing.js', 'tests/existing.js'], groundTruthFiles: ['src/lib/existing.js'] },
    { id: 's2', title: 'Register', scope: 'Registers the new capability with the registry.', newFiles: ['src/lib/registry-entry.js'], groundTruthFiles: [] }
  ];

  let seenBrief = null;
  let seenModel = null;
  const plan = await planningStage.planPhase(phase, protocol, {
    repoRoot,
    backend: 'vertex',
    runPlanningLane: async args => {
      seenBrief = args.brief;
      seenModel = args.model;
      ok(fs.existsSync(args.cwd), 'the planning call runs in a real (scratch) cwd');
      ok(!path.resolve(args.cwd).startsWith(path.resolve(repoRoot)), 'the scratch cwd is never inside the live repo');
      return { ok: true, response: validPlannerResponse(subtasks), reportedTokens: 123 };
    }
  });

  equal(plan.ok, true, 'a well-formed planner reply produces a ready plan');
  equal(plan.status, 'ready');
  equal(plan.subtasks.length, 2, 'both subtasks survive');
  equal(plan.reportedTokens, 123, 'the planner\'s own reported token count is carried through');
  // PROBED LIVE 2026-07-29 against example-vertex-project: asking the
  // Vertex path for gemini-2.5-flash exits 1, and the provider error names a
  // model nobody requested ("...-3.5-flash was not found") because the CLI
  // substitutes its own built-in default flash id, which 404s there.
  // gemini-2.5-pro is the only id verified to serve (exit 0, stats.models ==
  // ["gemini-2.5-pro"]). This assertion pins the MEASURED value so a
  // plausible-looking-but-phantom flash id cannot be reintroduced here.
  equal(seenModel, 'gemini-2.5-pro', 'the vertex backend plans on the only model it is verified to actually serve');
  ok(seenBrief.includes('src/lib/existing.js'), 'the brief carries the mechanically-extracted ground truth');
  ok(seenBrief.includes('one file of implementation plus one test file'), 'the brief cites the doctrine unit');
}

async function testPlanPhaseFallbackPaths() {
  const repoRoot = tempDir('plan-fallback-repo');
  const { phase, protocol } = samplePhase('Q2', 'Do a thing.');

  const failedExit = await planningStage.planPhase(phase, protocol, {
    repoRoot, runPlanningLane: async () => ({ ok: false, code: 'EXIT_NONZERO', detail: 'boom' })
  });
  equal(failedExit.status, 'fallback', 'a non-zero planning-lane exit falls back');
  equal(failedExit.subtasks.length, 0);

  const threw = await planningStage.planPhase(phase, protocol, {
    repoRoot, runPlanningLane: async () => { throw new Error('spawn exploded'); }
  });
  equal(threw.status, 'fallback', 'a thrown planning-lane error falls back rather than propagating');
  ok(threw.reason.includes('planning-lane-threw'));

  const noLabel = await planningStage.planPhase(phase, protocol, {
    repoRoot, runPlanningLane: async () => ({ ok: true, response: 'I refuse to use the required format.' })
  });
  equal(noLabel.status, 'fallback', 'a reply with no SUBTASKS-JSON label falls back');

  const zeroSubtasks = await planningStage.planPhase(phase, protocol, {
    repoRoot, runPlanningLane: async () => ({ ok: true, response: validPlannerResponse([]) })
  });
  equal(zeroSubtasks.status, 'fallback', 'zero subtasks is incoherent and falls back');

  const tooManyFiles = await planningStage.planPhase(phase, protocol, {
    repoRoot, runPlanningLane: async () => ({
      ok: true,
      response: validPlannerResponse([{ id: 's1', title: 't', scope: 'a scope long enough to pass validation', newFiles: ['src/lib/a.js', 'src/lib/b.js', 'src/lib/c.js', 'src/lib/d.js'], groundTruthFiles: [] }])
    })
  });
  equal(tooManyFiles.status, 'fallback', 'a subtask exceeding the new-files bound is dropped, and with nothing left, falls back');

  const unreadableFs = Object.create(fs);
  unreadableFs.statSync = () => { const error = new Error('repository read failed'); error.code = 'EIO'; throw error; };
  const unreadableCitation = await planningStage.planPhase(phase, protocol, {
    repoRoot,
    fsImpl: unreadableFs,
    runPlanningLane: async () => ({
      ok: true,
      response: validPlannerResponse([{
        id: 's1', title: 'Cited task', scope: 'a scope long enough to pass validation',
        newFiles: ['src/lib/a.js'], groundTruthFiles: ['src/lib/existing.js']
      }])
    })
  });
  equal(unreadableCitation.status, 'fallback', 'a repository read failure refuses to mark a citation absent');
  equal(unreadableCitation.failureClass, planningStage.FAILURE_UNAVAILABLE,
    'repository uncertainty is recorded as planner unavailability, not an answer about the citation');
  ok(unreadableCitation.reason.includes('planning-repo-validation-failed'));

  // Every one of the above resolved (none threw out of planPhase itself),
  // which is the whole point: a broken planner must never block a phase.
  assert.deepStrictEqual(
    [failedExit, threw, noLabel, zeroSubtasks, tooManyFiles].map(result => result.status),
    ['fallback', 'fallback', 'fallback', 'fallback', 'fallback'],
    'planPhase resolved to fallback across every documented failure path'
  );
  checks += 1;
}

// ---------------------------------------------------------------------------
// 4. expandClaimableItems: ready -> subtasks, fallback -> phase, pending -> nothing
// ---------------------------------------------------------------------------
function testExpandClaimableItems() {
  const openPhases = [
    { id: 'Q1', number: 1 }, { id: 'Q2', number: 2 }, { id: 'Q3', number: 3 }
  ];
  const plans = {
    Q1: { status: 'ready', subtasks: [{ id: 's1' }, { id: 's2' }], laneId: 'plan-q1' },
    Q2: { status: 'fallback', reason: 'incoherent' }
    // Q3 has no plan record at all -- planning has not run for it yet.
  };
  const { ids, meta } = expandClaimableItems(openPhases, plans);
  assert.deepStrictEqual(ids, ['Q1::s1', 'Q1::s2', 'Q2'],
    'ready phases contribute sub-task ids, fallback phases contribute the phase id, pending phases contribute nothing');
  checks += 1;
  equal(meta.get('Q1::s1').kind, 'subtask');
  equal(meta.get('Q2').kind, 'phase');
  equal(meta.has('Q3'), false, 'a phase with no plan record yet is not claimable this tick');

  const disabled = expandClaimableItems(openPhases, plans, { planningEnabled: false });
  assert.deepStrictEqual(disabled.ids, ['Q1', 'Q2', 'Q3'],
    '--no-planning reproduces the exact pre-decomposition whole-phase behaviour');
  checks += 1;

  // A sub-task that already succeeded (and is awaiting review, or was
  // accepted) must not be re-claimed forever -- there is no BUILD-QUEUE.md
  // status line for a sub-task to flip DONE the way a whole phase has.
  equal(isSubtaskSettled(null), false, 'no item record yet is not settled');
  equal(isSubtaskSettled({ lastOutcome: { processExitOk: true, changedFileCount: 0, verification: 'unverified' } }), false,
    'a zero-diff success stays reclaimable (ordinary no-progress parking applies)');
  equal(isSubtaskSettled({ lastOutcome: { processExitOk: true, changedFileCount: 2, verification: 'unverified' } }), true,
    'a real change awaiting review is settled -- must not be redispatched underneath the reviewer');
  equal(isSubtaskSettled({ lastOutcome: { processExitOk: true, changedFileCount: 2, verification: 'verified' } }), true,
    'an accepted sub-task is settled');
  equal(isSubtaskSettled({ lastOutcome: { processExitOk: true, changedFileCount: 2, verification: 'rejected' } }), false,
    'a rejected sub-task is deliberately reclaimable -- rejection means try again');

  const withItems = expandClaimableItems(openPhases, plans, {
    items: { 'Q1::s1': { lastOutcome: { processExitOk: true, changedFileCount: 3, verification: 'unverified' } } }
  });
  assert.deepStrictEqual(withItems.ids, ['Q1::s2', 'Q2'],
    'a settled sub-task is excluded from the claimable set even though its plan is ready');
  checks += 1;
}

// ---------------------------------------------------------------------------
// 5. Supervisor integration: a ready plan dispatches sub-task briefs, and
//    planning cost never touches the phase's own item/attempt ledger.
// ---------------------------------------------------------------------------
async function testSupervisorDispatchesSubtasks() {
  const base = tempDir('sup-ready');
  const repoRoot = path.join(base, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const queueFile = path.join(repoRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, [
    '# BUILD-QUEUE', '', '## Builder protocol (read once per loop)', '', 'Pick the lowest open.', '',
    '---', '', '## Q1 - Decomposable phase', '', '**Status:** OPEN', 'A multi-file integration phase.', ''
  ].join('\n'), 'utf8');
  const stateFile = path.join(repoRoot, 'state', 'fleet-supervisor.json');

  const subtasks = [
    { id: 's1', title: 'Part one', scope: 'Implements part one of the phase.', newFiles: ['src/lib/a.js', 'tests/a.js'], groundTruthFiles: [] },
    { id: 's2', title: 'Part two', scope: 'Implements part two of the phase.', newFiles: ['src/lib/b.js', 'tests/b.js'], groundTruthFiles: [] }
  ];

  const receivedBriefs = [];
  const supervisor = new FleetSupervisor({
    repoRoot, stateFile, queueFile, concurrency: 4,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    planning: {
      enabled: true,
      runPlanningLane: async () => ({ ok: true, response: validPlannerResponse(subtasks), reportedTokens: 10 })
    },
    runLane: async ({ itemId, brief }) => {
      receivedBriefs.push({ itemId, brief });
      return { ok: true, changedFileCount: 1 };
    }
  });
  stubWorktrees();
  try {
    await supervisor.tick();
    await supervisor.drain();
  } finally {
    restoreWorktrees();
  }

  const state = stateStore.readState(stateFile);
  equal(Object.keys(state.items).sort().join(','), 'Q1::s1,Q1::s2',
    'the claimable items are the sub-tasks, not the phase itself');
  ok(!state.items.Q1, 'the phase id itself was never claimed/attempted once a plan was ready');
  equal(state.plans.Q1.status, 'ready');
  equal(state.plans.Q1.subtasks.length, 2);

  equal(receivedBriefs.length, 2, 'both sub-task lanes were dispatched');
  for (const { itemId, brief } of receivedBriefs) {
    ok(itemId === 'Q1::s1' || itemId === 'Q1::s2', 'each dispatched lane is keyed by the sub-task item id');
    ok(brief.includes('ONE BOUNDED SUB-TASK'), 'the sub-task brief marks itself as bounded, not the whole phase');
    ok(brief.includes('Sub-task s1') || brief.includes('Sub-task s2'), 'the brief names its own sub-task');
  }
}

// Planning cost must never count against the phase's lane attempt budget --
// checked directly against state.items immediately after ensurePlans(),
// before any claim has happened.
async function testPlanningNeverTouchesItemLedger() {
  const base = tempDir('sup-ledger');
  const repoRoot = path.join(base, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const queueFile = path.join(repoRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, [
    '# BUILD-QUEUE', '', '## Builder protocol (read once per loop)', '', 'Pick the lowest open.', '',
    '---', '', '## Q9 - Ready phase', '', '**Status:** OPEN', 'Body nine.', '',
    '---', '', '## Q10 - Fallback phase', '', '**Status:** OPEN', 'Body ten.', ''
  ].join('\n'), 'utf8');
  const stateFile = path.join(repoRoot, 'state', 'fleet-supervisor.json');

  const subtasks = [{ id: 's1', title: 'Only part', scope: 'Implements the only bounded part of this phase.', newFiles: ['src/lib/a.js', 'tests/a.js'], groundTruthFiles: [] }];
  const supervisor = new FleetSupervisor({
    repoRoot, stateFile, queueFile, concurrency: 4,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    planning: {
      enabled: true,
      maxPerTick: 5,
      runPlanningLane: async ({ itemId }) => {
        if (itemId === 'Q9') return { ok: true, response: validPlannerResponse(subtasks), reportedTokens: 7 };
        return { ok: false, code: 'EXIT_NONZERO', detail: 'planner failed for Q10' };
      }
    },
    runLane: async () => ({ ok: true, changedFileCount: 0 })
  });

  const queue = supervisor.readQueue();
  await supervisor.ensurePlans(queue.open, queue.protocol);

  const state = stateStore.readState(stateFile);
  equal(state.plans.Q9.status, 'ready', 'Q9 planned successfully');
  equal(state.plans.Q10.status, 'fallback', 'Q10 fell back');
  ok(!state.items.Q9, 'a readily-planned phase never becomes an item at all');
  ok(!state.items['Q9::s1'], 'planning records the plan but does not itself claim/attempt the sub-task');
  ok(!state.items.Q10, 'a fallback phase is not attempted by planning either -- only by the later claim loop');
}

// ---------------------------------------------------------------------------
// 6. A sub-task that fails repeatedly parks at the SUB-TASK level only
// ---------------------------------------------------------------------------
async function testSubtaskParkingIsolated() {
  const base = tempDir('sup-park');
  const repoRoot = path.join(base, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const queueFile = path.join(repoRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, [
    '# BUILD-QUEUE', '', '## Builder protocol (read once per loop)', '', 'Pick the lowest open.', '',
    '---', '', '## Q5 - Two-part phase', '', '**Status:** OPEN', 'Body five.', ''
  ].join('\n'), 'utf8');
  const stateFile = path.join(repoRoot, 'state', 'fleet-supervisor.json');

  const subtasks = [
    { id: 'bad', title: 'Always fails', scope: 'A sub-task that never makes progress, on purpose for this test.', newFiles: ['src/lib/bad.js', 'tests/bad.js'], groundTruthFiles: [] },
    { id: 'good', title: 'Succeeds', scope: 'A sub-task that succeeds on its first attempt, on purpose for this test.', newFiles: ['src/lib/good.js', 'tests/good.js'], groundTruthFiles: [] }
  ];

  const supervisor = new FleetSupervisor({
    repoRoot, stateFile, queueFile, concurrency: 2, maxAttempts: 3, maxNoProgressAttempts: 2,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    planning: {
      enabled: true,
      runPlanningLane: async () => ({ ok: true, response: validPlannerResponse(subtasks), reportedTokens: 1 })
    },
    runLane: async ({ itemId }) => (itemId === 'Q5::bad'
      ? { ok: true, changedFileCount: 0 } // exits fine but makes zero progress, every time
      : { ok: true, changedFileCount: 1 })
  });
  stubWorktrees({ changed: worktree => (/q5bad/.test(worktree) ? 0 : 1) });
  try {
    // Enough ticks for the bad sub-task to exhaust maxNoProgressAttempts (2).
    for (let i = 0; i < 4; i += 1) {
      await supervisor.tick();
      await supervisor.drain();
    }
  } finally {
    restoreWorktrees();
  }

  const state = stateStore.readState(stateFile);
  equal(state.items['Q5::bad'].condition, 'parked', 'the perpetually-unproductive sub-task parks');
  ok(/no-progress/.test(state.items['Q5::bad'].parkedReason), 'parked for the honest reason');
  equal(state.items['Q5::good'].condition, 'idle', 'the sibling sub-task is unaffected by its neighbour parking');
  equal(state.items['Q5::good'].attempts, 1, 'the sibling only needed one attempt and was never re-driven by the other\'s failures');
  ok(!state.items.Q5, 'the phase-level id was never touched -- the phase\'s own "budget" was never at stake, only the sub-task\'s');
}

// ---------------------------------------------------------------------------
// 7. A broken/incoherent plan falls back to whole-phase dispatch
// ---------------------------------------------------------------------------
async function testFallbackDispatchesWholePhase() {
  const base = tempDir('sup-fallback');
  const repoRoot = path.join(base, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const queueFile = path.join(repoRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, [
    '# BUILD-QUEUE', '', '## Builder protocol (read once per loop)', '', 'Pick the lowest open.', '',
    '---', '', '## Q6 - Whole phase after a broken plan', '', '**Status:** OPEN', 'Body six.', ''
  ].join('\n'), 'utf8');
  const stateFile = path.join(repoRoot, 'state', 'fleet-supervisor.json');

  let receivedBrief = null;
  const supervisor = new FleetSupervisor({
    repoRoot, stateFile, queueFile, concurrency: 1,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    planning: {
      enabled: true,
      // A response that never even attempts the required format -- incoherent.
      runPlanningLane: async () => ({ ok: true, response: 'I have thoughts but no JSON.' })
    },
    runLane: async ({ itemId, brief }) => { receivedBrief = { itemId, brief }; return { ok: true, changedFileCount: 1 }; }
  });
  stubWorktrees();
  try {
    await supervisor.tick();
    await supervisor.drain();
  } finally {
    restoreWorktrees();
  }

  const state = stateStore.readState(stateFile);
  equal(state.plans.Q6.status, 'fallback', 'the incoherent reply is recorded as a fallback, not silently ignored');
  ok(receivedBrief, 'a lane was still dispatched -- a broken planner never blocks the phase');
  equal(receivedBrief.itemId, 'Q6', 'dispatch fell back to the WHOLE phase id, not a sub-task id');
  ok(receivedBrief.brief.includes('Work exactly one BUILD-QUEUE phase'),
    'the fallback brief is the ordinary whole-phase buildLaneBrief, unchanged');
  ok(!receivedBrief.brief.includes('ONE BOUNDED SUB-TASK'), 'and is not mistaken for a sub-task brief');
}

// ---------------------------------------------------------------------------
// 8. Phase-level status aggregates sub-task verdicts correctly
// ---------------------------------------------------------------------------
function testPhaseStatusAggregation() {
  const stateFile = path.join(tempDir('sup-status'), 'state', 'fleet-supervisor.json');
  const base = { supervisorId: 'sup-a', concurrency: 4, maxAttempts: 5, maxNoProgressAttempts: 5 };
  const { claimNext, recordLaneOutcome, recordLaneStarted } = require('../src/lib/fleet-supervisor/supervisor.js');

  // Record the plan itself.
  stateStore.withState(stateFile, state => {
    state.plans.Q8 = {
      phaseId: 'Q8', status: 'ready', model: 'gemini-2.5-flash', laneId: 'plan-q8',
      reason: null, plannedAt: new Date().toISOString(), reportedTokens: 5,
      subtasks: [{ id: 's1', title: 'One' }, { id: 's2', title: 'Two' }, { id: 's3', title: 'Three' }]
    };
    return { state };
  });

  // Each claim below passes only the ONE sub-task item id it targets --
  // standing in for what expandClaimableItems()/isSubtaskSettled() would
  // already have filtered a real tick() down to (a settled sub-task, like s1
  // the instant it succeeds, drops out of the claimable set; see the
  // dedicated expandClaimableItems test for that mechanism itself).

  // s1: dispatched, succeeded, and ACCEPTED by a reviewer.
  claimNext(stateFile, { ...base, openItemIds: [subtaskItemId('Q8', 's1')], laneId: 'lane-s1' });
  recordLaneStarted(stateFile, 'lane-s1', { pid: process.pid, worktree: 'wt-s1', model: 'gemini-2.5-pro', backend: 'vertex' });
  recordLaneOutcome(stateFile, 'lane-s1', {
    ok: true, changedFileCount: 2, backend: 'vertex',
    directVertexEvidence: acceptedDirectVertexEvidence('lane-s1'),
    maxAttempts: 5, maxNoProgressAttempts: 5
  });
  markVerified(stateFile, 'lane-s1', { reviewer: 'review:codex', verdict: 'accepted', note: 'ran it, real effect' });

  // s2: dispatched, succeeded, but REJECTED by a reviewer.
  claimNext(stateFile, { ...base, openItemIds: [subtaskItemId('Q8', 's2')], laneId: 'lane-s2' });
  recordLaneStarted(stateFile, 'lane-s2', { pid: process.pid, worktree: 'wt-s2', model: 'gemini-2.5-pro', backend: 'vertex' });
  recordLaneOutcome(stateFile, 'lane-s2', { ok: true, changedFileCount: 2, backend: 'vertex', reportedModels: ['gemini-2.5-pro'], maxAttempts: 5, maxNoProgressAttempts: 5 });
  markVerified(stateFile, 'lane-s2', { reviewer: 'review:codex', verdict: 'rejected', note: 'imagined schema' });

  // s3: never claimed yet -- still pending.

  const report = status(stateFile, { isAlive: () => false });
  const q8 = report.decomposition.find(row => row.phaseId === 'Q8');
  ok(q8, 'Q8 appears in the decomposition rollup');
  equal(q8.subtaskCount, 3);
  equal(q8.verified, 1, 'one sub-task verified');
  equal(q8.rejected, 1, 'one sub-task rejected');
  equal(q8.pending, 1, 'one sub-task still pending');
  equal(q8.addressed, false, 'not every sub-task has left the open set (s3 is still pending)');
  ok(q8.summaryLine.startsWith('Q8: 1/3 sub-tasks verified'), `summary line reads the owner's requested shape: ${q8.summaryLine}`);

  // Also exercise phaseDecompositionSummary() directly against the same state.
  const state = stateStore.readState(stateFile);
  const direct = phaseDecompositionSummary(state).find(row => row.phaseId === 'Q8');
  equal(direct.verified, 1);
  equal(direct.rejected, 1);
}

// ---------------------------------------------------------------------------
// 9. A planner that cannot RUN is loud, retryable, and never silently
//    indistinguishable from a phase that had nothing to decompose.
//
// Regression test for a real live failure (2026-07-29): the planning pass
// dispatched a model id the Vertex backend does not serve, every planning call
// exited non-zero, every phase silently fell back to whole-phase dispatch, and
// nothing in the log or --status said decomposition had stopped happening.
// ---------------------------------------------------------------------------
async function testPlannerUnavailableIsLoudAndRetryable() {
  const repoRoot = tempDir('loud-repo');
  const { phase, protocol } = samplePhase('Q4', 'Do a thing.');

  // Failure CLASSES are distinguished at the source.
  const unavailable = await planningStage.planPhase(phase, protocol, {
    repoRoot,
    runPlanningLane: async () => ({ ok: false, code: 'EXIT_NONZERO', detail: 'model was not found or your project does not have access to it' })
  });
  equal(unavailable.failureClass, 'planner-unavailable',
    'a provider/CLI failure is classed planner-unavailable, not blamed on the phase');

  const incoherent = await planningStage.planPhase(phase, protocol, {
    repoRoot, runPlanningLane: async () => ({ ok: true, response: 'thoughts, but no JSON' })
  });
  equal(incoherent.failureClass, 'plan-incoherent',
    'a real answer that is unusable is classed plan-incoherent');

  // Supervisor level: retried while unavailable, and LOUD in the log.
  const base = tempDir('loud-sup');
  const repo2 = path.join(base, 'repo');
  fs.mkdirSync(repo2, { recursive: true });
  const queueFile = path.join(repo2, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, [
    '# BUILD-QUEUE', '', '## Builder protocol (read once per loop)', '', 'Pick the lowest open.', '',
    '---', '', '## Q4 - A phase', '', '**Status:** OPEN', 'Body four.', ''
  ].join('\n'), 'utf8');
  const stateFile = path.join(repo2, 'state', 'fleet-supervisor.json');

  const events = [];
  let planCalls = 0;
  const subtasks = [{ id: 's1', title: 'Only part', scope: 'Implements the only bounded part of this phase.', newFiles: ['src/lib/a.js', 'tests/a.js'], groundTruthFiles: [] }];
  const supervisor = new FleetSupervisor({
    repoRoot: repo2, stateFile, queueFile, concurrency: 1,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    logger: entry => events.push(entry),
    planning: {
      enabled: true,
      maxAttempts: 3,
      runPlanningLane: async () => {
        planCalls += 1;
        // Broken for the first two attempts, then the environment is fixed.
        if (planCalls <= 2) return { ok: false, code: 'EXIT_NONZERO', detail: 'model not found on this backend' };
        return { ok: true, response: validPlannerResponse(subtasks), reportedTokens: 9 };
      }
    },
    runLane: async () => ({ ok: true, changedFileCount: 1 })
  });

  const queue = supervisor.readQueue();
  await supervisor.ensurePlans(queue.open, queue.protocol);

  const loud = events.filter(entry => entry.event === 'phase-planning-UNAVAILABLE');
  equal(loud.length, 1, 'an unrunnable planner emits a distinctly-named LOUD event, not a generic fallback');
  ok(/decomposition is NOT running/i.test(loud[0].detail),
    'and the event says outright that decomposition is not happening for that phase');
  ok(!events.some(entry => entry.event === 'phase-planned'), 'nothing claimed success on a failed attempt');

  // Status must surface it at the top level, not only per-phase.
  let report = status(stateFile, { isAlive: () => false });
  equal(report.planning.healthy, false, 'planning health is FALSE while the planner cannot run');
  equal(report.planning.plannerUnavailable, 1, 'the unavailable count is reported');
  equal(report.planning.decomposed, 0, 'and no phase is claimed as decomposed');
  ok(/PLANNER UNAVAILABLE/.test(report.planning.headline), `the headline is unmissable: ${report.planning.headline}`);
  const row = report.decomposition.find(entry => entry.phaseId === 'Q4');
  equal(row.plannerUnavailable, true, 'the per-phase row distinguishes an unavailable planner');
  ok(/decomposition did NOT run/.test(row.summaryLine), 'and says so in its summary line');

  // Retried on the next tick rather than being poisoned forever...
  await supervisor.ensurePlans(supervisor.readQueue().open, queue.protocol);
  equal(planCalls, 2, 'a planner-unavailable phase is re-attempted, not cached as permanently undecomposable');

  // ...and once the environment is fixed, the phase really does decompose.
  await supervisor.ensurePlans(supervisor.readQueue().open, queue.protocol);
  equal(planCalls, 3, 'the third attempt runs');
  report = status(stateFile, { isAlive: () => false });
  equal(report.planning.healthy, true, 'planning reports healthy again once a plan lands');
  equal(report.planning.decomposed, 1, 'and the phase is now decomposed');
  equal(report.planning.subtasksPlanned, 1, 'with its sub-task counted');

  // A ready plan is final -- no further re-planning.
  await supervisor.ensurePlans(supervisor.readQueue().open, queue.protocol);
  equal(planCalls, 3, 'a ready plan is never re-planned');
}

// An INCOHERENT plan is a statement about the phase, so it is NOT retried --
// otherwise every undecomposable phase re-burns tokens every cycle forever.
async function testIncoherentPlanIsNotRetried() {
  const base = tempDir('incoherent-sup');
  const repoRoot = path.join(base, 'repo');
  fs.mkdirSync(repoRoot, { recursive: true });
  const queueFile = path.join(repoRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, [
    '# BUILD-QUEUE', '', '## Builder protocol (read once per loop)', '', 'Pick the lowest open.', '',
    '---', '', '## Q7 - A phase', '', '**Status:** OPEN', 'Body seven.', ''
  ].join('\n'), 'utf8');
  const stateFile = path.join(repoRoot, 'state', 'fleet-supervisor.json');

  let planCalls = 0;
  const supervisor = new FleetSupervisor({
    repoRoot, stateFile, queueFile, concurrency: 1,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    planning: {
      enabled: true,
      runPlanningLane: async () => { planCalls += 1; return { ok: true, response: 'no JSON here at all' }; }
    },
    runLane: async () => ({ ok: true, changedFileCount: 1 })
  });

  const queue = supervisor.readQueue();
  await supervisor.ensurePlans(queue.open, queue.protocol);
  await supervisor.ensurePlans(queue.open, queue.protocol);
  equal(planCalls, 1, 'an incoherent plan is final -- the phase is not re-planned every cycle');

  const report = status(stateFile, { isAlive: () => false });
  equal(report.planning.healthy, true, 'an incoherent plan does not mean the PLANNER is broken');
  equal(report.planning.planIncoherent, 1, 'but it is still counted and visible');
  equal(report.decomposition.find(entry => entry.phaseId === 'Q7').plannerUnavailable, false,
    'and is explicitly NOT reported as an unavailable planner');
}

// ---------------------------------------------------------------------------
// 10. The wiring obligation (doctrine failure mode #3)
//
// MEASURED 2026-07-29: across 12 sampled rejections of decomposed sub-tasks,
// the dominant verdict was "unwired" -- correct code, passing test, nothing in
// the repo able to call it. The decomposition size target was being met; the
// briefs were silent about reachability. These pin that they no longer are.
// ---------------------------------------------------------------------------
function testWiringObligation() {
  const repoRoot = tempDir('wiring-repo');
  fs.mkdirSync(path.join(repoRoot, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'lib', 'tool-registry.js'), 'module.exports = {};\n', 'utf8');

  // kind "wire" with a REAL target survives intact.
  const wired = planningStage.normalizeWiring({
    kind: 'wire', targetFile: 'src/lib/tool-registry.js',
    pattern: 'register it exactly as the sibling foo.* is registered', caller: 'src/mcp-server.js'
  }, { repoRoot });
  equal(wired.kind, 'wire', 'a real registration site is kept');
  equal(wired.targetFile, 'src/lib/tool-registry.js');
  equal(wired.note, null, 'and is not flagged');

  // An INVENTED registration site is demoted, never passed to a lane.
  const invented = planningStage.normalizeWiring({
    kind: 'wire', targetFile: 'src/lib/does-not-exist.js', pattern: 'register it there'
  }, { repoRoot });
  equal(invented.kind, 'unstated',
    'a wiring target that does not exist is demoted rather than sending a lane after an invented site');
  equal(invented.targetFile, null, 'and the phantom path is not propagated');
  ok(/does not exist/.test(invented.note), 'the demotion is recorded with its reason');

  // "wire" with no pattern to copy is not actionable.
  equal(planningStage.normalizeWiring({ kind: 'wire', targetFile: 'src/lib/tool-registry.js' }, { repoRoot }).kind,
    'unstated', 'a target with no pattern to copy is treated as unstated');

  // "deferred" requires a reason; a bare claim is not a licence.
  equal(planningStage.normalizeWiring({ kind: 'deferred' }, { repoRoot }).kind,
    'unstated', 'deferred with no reason is not accepted as deferred');
  const deferred = planningStage.normalizeWiring(
    { kind: 'deferred', reason: 'the controller wires registry entries serially' }, { repoRoot });
  equal(deferred.kind, 'deferred', 'deferred with a real reason is honored');

  // Missing entirely -> unstated, and CRUCIALLY the subtask still survives:
  // invalidating it would fall back to whole-phase dispatch, which is larger
  // AND less wired.
  equal(planningStage.normalizeWiring(undefined, { repoRoot }).kind, 'unstated');
  const validated = planningStage.validateSubtasks([{
    id: 's1', title: 'No wiring stated', scope: 'a scope long enough to pass the minimum length check',
    newFiles: ['src/lib/a.js', 'tests/a.js'], groundTruthFiles: []
  }], { repoRoot });
  ok(validated.ok, 'a subtask with no wiring field is NOT dropped (that would fall back to whole-phase)');
  equal(validated.subtasks[0].wiring.kind, 'unstated', 'it is recorded as unstated');

  // --- the briefs themselves --------------------------------------------
  const { phase, protocol } = samplePhase('Q1', 'Build a thing.');
  const briefFor = wiring => queueReader.buildSubtaskBrief(
    phase,
    { id: 's1', title: 'T', scope: 'S', newFiles: ['src/lib/a.js'], groundTruthFiles: [], wiring },
    protocol,
    { laneId: 'lane-1', worktree: 'wt', repoRoot }
  );

  const wireBrief = briefFor(wired);
  ok(/WIRING OBLIGATION: THIS SUB-TASK MUST MAKE ITS WORK REACHABLE/.test(wireBrief),
    'a wire brief states the obligation unmissably');
  ok(wireBrief.includes('src/lib/tool-registry.js'), 'names the exact registration file');
  ok(wireBrief.includes('register it exactly as the sibling foo.* is registered'), 'and the pattern to copy');
  ok(/never a scope violation/.test(wireBrief),
    'and tells the lane wiring is in scope, so it does not skip it to avoid a scope violation');

  const deferredBrief = briefFor(deferred);
  ok(/DEFERRED TO THE CONTROLLER/.test(deferredBrief), 'a deferred brief says so explicitly');
  ok(/STOP at the wiring boundary/.test(deferredBrief), 'and tells the lane not to wire it itself');

  const unstatedBrief = briefFor({ kind: planningStage.WIRING_UNSTATED });
  ok(/YOU MUST DETERMINE IT/.test(unstatedBrief),
    'an unstated brief makes the LANE resolve wiring rather than silently permitting dead code');
  ok(/reject it as "unwired"/.test(unstatedBrief), 'and warns it is the top rejection cause');
  // The review tier must never be told to relax for an unstated wiring.
  ok(!/do not reject/i.test(unstatedBrief), 'and never instructs anyone to accept unwired work');

  // The wiring target is injected as ground truth, like any other producer.
  ok(/GROUND TRUTH/.test(wireBrief) && wireBrief.indexOf('src/lib/tool-registry.js') > 0,
    'the registration site is carried into the ground-truth block so the lane reads it first');
}

// A sub-task that only becomes reachable once a sibling lands must not be
// dispatched beside it -- that is how two unwireable halves get produced.
function testDependsOnSequencing() {
  const openPhases = [{ id: 'Q1', number: 1 }];
  const plans = {
    Q1: {
      status: 'ready',
      subtasks: [
        { id: 's1', title: 'first' },
        { id: 's2', title: 'second', dependsOn: ['s1'] },
        { id: 's3', title: 'third', dependsOn: ['ghost'] }
      ]
    }
  };

  const fresh = expandClaimableItems(openPhases, plans, { items: {} });
  assert.deepStrictEqual(fresh.ids, ['Q1::s1', 'Q1::s3'],
    's2 waits on its unmet dependency; s3 is not wedged by a dependency id that does not exist');
  checks += 1;

  const afterS1 = expandClaimableItems(openPhases, plans, {
    items: { 'Q1::s1': { lastOutcome: { processExitOk: true, changedFileCount: 2, verification: 'unverified' } } }
  });
  ok(afterS1.ids.includes('Q1::s2'), 'once the dependency lands, the dependent becomes claimable');

  // A dependency that PARKED must not block its dependent forever -- waiting
  // on something that will never land silently removes real work.
  const depParked = expandClaimableItems(openPhases, plans, {
    items: { 'Q1::s1': { condition: 'parked', lastOutcome: null } }
  });
  ok(depParked.ids.includes('Q1::s2'), 'a parked dependency unblocks rather than wedging the dependent');
}

// ---------------------------------------------------------------------------
// 12. The largest phases must still plan: the brief never rides argv
//
// MEASURED live 2026-07-29 (logs/fleet-supervisor.log): planning Q18/a second project
// -- a phase body of >100 lines -- failed with
// `planning-lane-failed: SPAWN_THREW spawn ENAMETOOLONG`, because the whole
// brief travelled as one `--prompt` argument and the assembled command line
// crossed Windows' ~32K CreateProcess cap. Exactly the phases that need
// decomposition most silently fell back to whole-phase dispatch. This drives
// the REAL runLane (only the process spawn and environment faked) with a
// >40KB phase body and pins the fix: argv stays small, and the oversized
// brief round-trips intact through the scratch file on the child's stdin.
// ---------------------------------------------------------------------------
async function testLargePhaseBriefNeverRidesArgv() {
  const laneRunner = require('../src/lib/fleet-supervisor/lane-runner.js');
  const EventEmitter = require('node:events');

  const repoRoot = tempDir('plan-large-repo');
  fs.mkdirSync(path.join(repoRoot, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'lib', 'existing.js'), 'module.exports = {};\n', 'utf8');

  // A phase body comfortably past the Windows command-line cap.
  const stepLine = 'Deliver bounded verifier behavior for a second project correction loop, step ';
  let body = '';
  for (let i = 0; body.length < 41_000; i += 1) body += `${stepLine}${i}.\n`;
  ok(body.length > 40_000, `the synthetic phase body is oversized (${body.length} chars)`);
  const { phase, protocol } = samplePhase('Q18', body);
  ok(phase.body.length > 40_000, 'the parsed phase carries the oversized body');

  const subtasks = [{
    id: 's1', title: 'Implement', scope: 'Implements the bounded behavior the phase describes.',
    newFiles: ['src/lib/a.js', 'tests/a.js'], groundTruthFiles: ['src/lib/existing.js']
  }];

  let sentBrief = null;
  let capturedArgs = null;
  let commandLineChars = null;
  let briefViaStdin = null;
  let capturedEnvironment = null;
  let onboardingInput = null;
  const fakeSpawn = (command, args, options) => {
    capturedArgs = args;
    commandLineChars = [command, ...args].join(' ').length;
    // stdio[0] is runLane's open read fd on the scratch brief file -- read it
    // exactly as the child would.
    briefViaStdin = fs.readFileSync(options.stdio[0], 'utf8');
    capturedEnvironment = options.env;
    const child = new EventEmitter();
    child.pid = 777;
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.kill = () => {};
    // This fixture represents a completed owned scope. A bare child close
    // alone intentionally leaves planning custody unproven.
    child.jobReady = Promise.resolve();
    child.jobOutcome = Promise.resolve({ type: 'exit', exitCode: 0, activeProcesses: 0 });
    child.jobClosed = Promise.resolve({ failure: null });
    child.terminateJob = () => child.jobOutcome;
    process.nextTick(() => {
      child.stdout.emit('data', JSON.stringify({
        response: validPlannerResponse(subtasks),
        stats: { models: { 'gemini-2.5-pro': { tokens: { total: 5 } } } }
      }));
      child.emit('close', 0);
    });
    return child;
  };

  const plan = await planningStage.planPhase(phase, protocol, {
    repoRoot,
    backend: 'vertex',
    runPlanningLane: args => {
      sentBrief = args.brief;
      return laneRunner.runLane({
        ...args,
        spawnImpl: fakeSpawn,
        execImpl: () => '',
        resolveExecutable: () => ({ command: 'node', prefixArgs: ['/fake/gemini.js'] }),
        buildOnboardingPacket: input => {
          onboardingInput = input;
          return 'TEST PLANNER ONBOARDING PACKET';
        },
        buildEnvironment: () => ({ env: {}, home: null, billing: { backend: 'vertex', account: 'test', project: 'proj' } })
      });
    }
  });

  equal(plan.ok, true, 'a >40KB phase body still produces a ready plan instead of ENAMETOOLONG');
  equal(plan.status, 'ready');
  equal(plan.subtasks.length, 1, 'the decomposition happened');
  ok(sentBrief.length > 40_000, `the assembled brief really was oversized (${sentBrief.length} chars)`);
  ok(sentBrief.includes(phase.body), 'and embeds the phase body verbatim');
  equal(briefViaStdin, `TEST PLANNER ONBOARDING PACKET\n\n${sentBrief}`,
    'the packet and then the oversized brief round-trip through the stdin scratch file intact');
  equal(onboardingInput.projectRoot, repoRoot, 'the planner packet identifies the real project, not its isolated scratch cwd');
  equal(onboardingInput.profile, 'planner');
  equal(onboardingInput.role, 'planner');
  equal(onboardingInput.identityBinding, 'none');
  equal(onboardingInput.directiveId, 'Q18');
  equal(capturedEnvironment.TOOLSENABLED_AGENT_ROLE, 'planner');
  equal(capturedEnvironment.TOOLSENABLED_PROJECT_ROOT, repoRoot);
  equal(capturedEnvironment.TOOLSENABLED_ONBOARDING_ALREADY_INJECTED, undefined,
    'an unverified planner launcher cannot request native-hook suppression');
  equal(capturedEnvironment.TOOLSENABLED_ONBOARDING_PACKET_VERSION, 'toolsenabled.agent-onboarding.v1');
  ok(/^[a-f0-9]{64}$/.test(capturedEnvironment.TOOLSENABLED_ONBOARDING_PACKET_HASH));
  ok(commandLineChars < laneRunner.MAX_COMMAND_LINE_CHARS,
    `the assembled command line stays far under the Windows cap (${commandLineChars} < ${laneRunner.MAX_COMMAND_LINE_CHARS})`);
  ok(!capturedArgs.includes('--prompt'), 'no --prompt flag: the brief is not on argv at all');
  ok(!capturedArgs.some(arg => String(arg).includes(stepLine)), 'and no argv element carries any of the phase body');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
async function runAll() {
  const suite = [
    ['extractSubtasksJson', testExtractSubtasksJson],
    ['validateSubtasks', testValidateSubtasks],
    ['planPhase (ready)', testPlanPhaseReady],
    ['planPhase (fallback paths)', testPlanPhaseFallbackPaths],
    ['expandClaimableItems', testExpandClaimableItems],
    ['supervisor dispatches sub-tasks', testSupervisorDispatchesSubtasks],
    ['planning never touches the item ledger', testPlanningNeverTouchesItemLedger],
    ['sub-task parking is isolated', testSubtaskParkingIsolated],
    ['fallback dispatches the whole phase', testFallbackDispatchesWholePhase],
    ['phase status aggregation', testPhaseStatusAggregation],
    ['planner-unavailable is loud and retryable', testPlannerUnavailableIsLoudAndRetryable],
    ['incoherent plan is not retried', testIncoherentPlanIsNotRetried],
    ['wiring obligation', testWiringObligation],
    ['dependsOn sequencing', testDependsOnSequencing],
    ['large phase brief never rides argv', testLargePhaseBriefNeverRidesArgv]
  ];
  try {
    for (const [name, fn] of suite) {
      try {
        await fn();
      } catch (error) {
        error.message = `[${name}] ${error.message}`;
        throw error;
      }
    }
  } finally {
    cleanup();
  }
  console.log(`fleet-supervisor planning tests passed (${checks} checks).`);
}

runAll().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
