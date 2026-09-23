// EXECUTABLE CHANGE -- testcanfail-tests-fleet-supervisor-review-js
// Vacuity audit: `report.review.stalled.every(...)` stayed green after mutating
// status() to return `[]` for the eight-stalled-lane fixture.  The cardinality
// assertion below makes that mutation fail before validating every row's shape.
// RED: "AssertionError ... 0 !== 8" at testWedgedReviewTierIsLoudAndDistinct.
// RESTORED GREEN: "fleet-supervisor review tests passed (261 checks)."
// NOT-FOUND: exit-status/truthy-only evidence; swallowed failure; subject mock;
// platform skip/no-op guard; expected value computed by the production code.
// Preconditions met: Node.js and git were available.  The temporary production
// mutation was restored byte-for-byte before the final green run.

'use strict';

// Tests for the fleet REVIEW stage (src/lib/fleet-supervisor/review.js).
//
// The doctrine (docs/GEMINI-LANE-DOCTRINE.md) says a lane's own test result is
// worthless, so a test suite for the reviewer that only checks bookkeeping
// would be committing the same sin one level up. The centre of this file is
// therefore testFabricatedPassingLaneIsRejected(): a real fixture modeled on
// the s03/s09 escapes -- a module whose OWN test passes while its real-data
// behaviour is wrong -- driven through the real review pipeline by a reviewer
// that actually executes the artifact against the real producer's output.
//
//   node tests/fleet-supervisor-review.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const review = require('../src/lib/fleet-supervisor/review.js');
const directVertex = require('../src/lib/fleet-supervisor/direct-vertex-receipt.js');
const stateStore = require('../src/lib/fleet-supervisor/state.js');
const worktrees = require('../src/lib/fleet-supervisor/worktree.js');
const {
  FleetSupervisor, claimNext, markVerified, recordLaneOutcome, recordLaneStarted, status, verdictsByModel
} = require('../src/lib/fleet-supervisor/supervisor.js');

let checks = 0;
const tempDirs = [];

function ok(condition, message) { assert.ok(condition, message); checks += 1; }
function equal(actual, expected, message) { assert.strictEqual(actual, expected, message); checks += 1; }

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-review-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function cleanup() {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function newRepoRoot(prefix) {
  const root = tempDir(prefix);
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  return root;
}

function stateFileIn(root) {
  return path.join(root, 'state', 'fleet-supervisor.json');
}

const OPEN_IDS = ['Q11', 'Q17', 'Q27', 'Q28', 'Q29', 'Q30', 'Q31', 'Q32'];

function directVertexEvidenceFor(laneId, {
  attemptNumber = 1,
  artifactProduced = true,
  modelVersion = 'gemini-2.5-pro',
  responseId = `vertex-${laneId}-response`
} = {}) {
  const binding = { callId: `lane:${laneId}:attempt:${attemptNumber}`, attemptNumber, artifactProduced };
  const rawResponse = { modelVersion, responseId };
  return { rawResponse, providerCallEvent: directVertex.providerCallEvent({ binding, rawResponse }) };
}

// A lane that exited zero and changed files -- i.e. one that lands in
// `lanesAwaitingReview`. Nothing here says the work is good; that is the point.
function seedFinishedLane(stateFile, laneId, {
  itemId = 'Q11', changedFileCount = 2, worktree = null, reportedModels = ['gemini-2.5-pro'],
  // Default evidence follows the production direct-Vertex binding contract.
  // Pass null to exercise unknown/aggregate-only receipt paths.
  directVertexEvidence = undefined,
  perCallModelEvidence = null
} = {}) {
  claimNext(stateFile, {
    openItemIds: [itemId], laneIdFor: () => laneId, supervisorId: 'sup-test',
    concurrency: 32, maxAttempts: 99, maxNoProgressAttempts: 99
  });
  recordLaneStarted(stateFile, laneId, {
    pid: process.pid, worktree, model: 'gemini-2.5-pro', backend: 'vertex'
  });
  const attemptNumber = stateStore.readState(stateFile).lanes[laneId].attempt;
  const evidence = directVertexEvidence === undefined
    ? directVertexEvidenceFor(laneId, { attemptNumber, artifactProduced: changedFileCount > 0 })
    : directVertexEvidence;
  recordLaneOutcome(stateFile, laneId, {
    ok: true, changedFileCount, backend: 'vertex', reportedModels,
    directVertexEvidence: evidence,
    perCallModelEvidence,
    maxAttempts: 99, maxNoProgressAttempts: 99
  });
}

// ---------------------------------------------------------------------------
// 1. A lane can never be reviewed by itself, or by its own provider
// ---------------------------------------------------------------------------
function testReviewerCannotBeTheLane() {
  const repoRoot = newRepoRoot('reviewer-identity');

  // Availability is injected so this test never touches the real CLIs.
  const availableEverywhere = providerId => ({ providerId, command: `<${providerId}>`, resolved: true, enabled: true, available: true });

  const geminiLane = review.chooseReviewer({
    laneProvider: 'gemini', preference: ['gemini', 'codex'], repoRoot, availabilityImpl: availableEverywhere
  });
  equal(geminiLane.providerId, 'codex',
    'a gemini lane is reviewed by codex even when gemini is listed first and is available');
  const skipped = geminiLane.checked.find(entry => entry.providerId === 'gemini');
  equal(skipped.reason, 'same-provider-as-the-lane-cannot-review-it',
    'and gemini is skipped with the reason spelled out, not silently reordered');

  const onlySelf = review.chooseReviewer({
    laneProvider: 'gemini',
    preference: ['gemini'],
    repoRoot,
    availabilityImpl: availableEverywhere
  });
  equal(onlySelf.providerId, null, 'when the only available provider is the lane\'s own, there is NO reviewer');
  equal(onlySelf.reason, 'no-reviewer-available-that-is-a-different-provider-than-the-lane',
    'and the refusal names why rather than falling back to self-review');

  // Codex preferred, gemini only as fallback for a non-gemini lane.
  const codexDown = review.chooseReviewer({
    laneProvider: 'claude',
    preference: ['codex', 'gemini'],
    repoRoot,
    availabilityImpl: providerId => providerId === 'codex'
      ? { providerId, resolved: false, enabled: null, available: false, reason: 'executable-not-found' }
      : availableEverywhere(providerId)
  });
  equal(codexDown.providerId, 'gemini', 'gemini is the fallback reviewer when codex is unavailable');

  const unreadableState = review.providerAvailability('codex', {
    repoRoot,
    resolveExecutable: () => ({ command: 'codex' }),
    fsImpl: {
      existsSync: fs.existsSync,
      readFileSync: () => { const error = new Error('refused'); error.code = 'EACCES'; throw error; }
    }
  });
  equal(unreadableState.available, false,
    'a provider-state read failure stays unknown and cannot become an affirmative availability answer');
  equal(unreadableState.reason, 'provider-state-unavailable: EACCES',
    'the reviewer refusal preserves the configuration-read failure');

  // The naming guard, and the state-level guard underneath it.
  assert.throws(() => review.assertReviewerIsNotTheLane('lane-a', { laneId: 'lane-a', provider: 'gemini' }),
    /cannot verify itself/);
  checks += 1;
  assert.throws(() => review.assertReviewerIsNotTheLane('review:gemini', { laneId: 'lane-a', provider: 'gemini' }),
    /cannot be reviewed by gemini/);
  checks += 1;
  ok(review.assertReviewerIsNotTheLane('review:codex', { laneId: 'lane-a', provider: 'gemini' }),
    'a different provider is accepted as the reviewer');

  const stateFile = stateFileIn(repoRoot);
  seedFinishedLane(stateFile, 'lane-a');
  assert.throws(() => markVerified(stateFile, 'lane-a', { reviewer: 'lane-a', verdict: 'accepted' }),
    /A lane cannot verify itself/);
  checks += 1;

  // And the whole pipeline refuses when no different provider exists.
  return (async () => {
    const claim = review.claimLaneForReview(stateFile, { supervisorId: 'sup-test' });
    ok(claim.claimed && claim.claimed.laneId === 'lane-a', 'the finished lane is claimable for review');
    const outcome = await review.reviewOneLane(stateFile, claim.claimed, {
      repoRoot,
      chooseReviewerImpl: () => ({ providerId: null, checked: [], reason: 'no-reviewer-available-that-is-a-different-provider-than-the-lane' }),
      runReviewerImpl: () => { throw new Error('no reviewer must ever be spawned when none is eligible'); }
    });
    equal(outcome.verdict, null, 'with no eligible reviewer, no verdict is invented');
    const lane = stateStore.readState(stateFile).lanes['lane-a'];
    equal(lane.verification.state, 'unverified', 'and the lane stays unverified rather than being waved through');
    ok(review.awaitsReview(lane), 'so it remains in the backlog, which keeps the fleet from building more of it');
  })();
}

// ---------------------------------------------------------------------------
// 2. Rejected work is preserved, never deleted
// ---------------------------------------------------------------------------
function testRejectedWorkIsPreserved() {
  const repoRoot = newRepoRoot('preserve');
  const stateFile = stateFileIn(repoRoot);
  seedFinishedLane(stateFile, 'lane-r');

  // Stand in for a captured packet.
  const pending = review.packetDir(repoRoot, 'lane-r', 'pending');
  fs.mkdirSync(path.join(pending, 'files', 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pending, 'files', 'src', 'lib', 'thing.js'), 'module.exports = 1;\n', 'utf8');
  fs.writeFileSync(path.join(pending, 'lane.diff'), 'diff --git a/x b/x\n', 'utf8');
  fs.writeFileSync(path.join(pending, 'manifest.json'), JSON.stringify({ laneId: 'lane-r', changedPaths: ['src/lib/thing.js'] }), 'utf8');

  review.recordVerdict(stateFile, 'lane-r', {
    reviewer: 'review:codex', verdict: 'rejected',
    reason: 'consumes details.messageId, which the producer never writes',
    repoRoot
  });

  const quarantine = review.packetDir(repoRoot, 'lane-r', 'quarantine');
  ok(fs.existsSync(quarantine), 'rejected work is moved into the quarantine bucket');
  equal(fs.readFileSync(path.join(quarantine, 'files', 'src', 'lib', 'thing.js'), 'utf8'), 'module.exports = 1;\n',
    'the rejected file survives byte-for-byte');
  ok(fs.existsSync(path.join(quarantine, 'lane.diff')), 'so does the diff');
  ok(fs.existsSync(path.join(quarantine, 'manifest.json')), 'so does the manifest');

  const lane = stateStore.readState(stateFile).lanes['lane-r'];
  equal(lane.verification.state, 'rejected', 'the verdict is recorded as a rejection');
  equal(lane.review.packetBucket, 'quarantine', 'and state points at where the work was preserved');
  equal(lane.mergeEligible, false, 'a rejected lane is never merge-eligible');

  // An accepted lane's packet is preserved too, in its own bucket.
  seedFinishedLane(stateFile, 'lane-a2');
  const pendingA = review.packetDir(repoRoot, 'lane-a2', 'pending');
  fs.mkdirSync(pendingA, { recursive: true });
  fs.writeFileSync(path.join(pendingA, 'manifest.json'), '{"laneId":"lane-a2"}', 'utf8');
  review.recordVerdict(stateFile, 'lane-a2', {
    reviewer: 'review:codex', verdict: 'accepted',
    reason: 'ran node harness against 52 real files; counts matched pdfinfo',
    repoRoot
  });
  ok(fs.existsSync(review.packetDir(repoRoot, 'lane-a2', 'accepted')), 'accepted work is preserved as well');
  equal(stateStore.readState(stateFile).lanes['lane-a2'].mergeEligible, true,
    'an accepted lane becomes ELIGIBLE for the controller to merge');

  // Nothing in the review stage may delete lane work.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'fleet-supervisor', 'review.js'), 'utf8');
  ok(!/\brmSync\s*\(|\bunlinkSync\s*\(|\brmdirSync\s*\(/.test(source),
    'review.js contains no filesystem removal call at all');
  ok(!/git\s*\(\s*\[\s*['"](?:merge|push|checkout)['"]/.test(source) && !/'--force'/.test(source),
    'and no merge/push/force path: merging stays a controller decision');
}

// ---------------------------------------------------------------------------
// 3. A verdict requires a named reviewer AND a reason AND execution evidence
// ---------------------------------------------------------------------------
function testVerdictRequiresReviewerAndReason() {
  const repoRoot = newRepoRoot('verdict');
  const stateFile = stateFileIn(repoRoot);
  seedFinishedLane(stateFile, 'lane-v');

  assert.throws(() => review.recordVerdict(stateFile, 'lane-v', { reviewer: '', verdict: 'accepted', reason: 'fine' }),
    /named reviewer/);
  checks += 1;
  assert.throws(() => review.recordVerdict(stateFile, 'lane-v', { reviewer: 'review:codex', verdict: 'accepted', reason: '   ' }),
    /requires a reason/);
  checks += 1;
  assert.throws(() => review.recordVerdict(stateFile, 'lane-v', { reviewer: 'review:codex', verdict: 'looks-good', reason: 'x' }),
    /must be 'accepted' or 'rejected'/);
  checks += 1;
  equal(stateStore.readState(stateFile).lanes['lane-v'].verification.state, 'unverified',
    'none of those malformed verdicts moved the lane');

  // Parsing: the acceptance path is only reachable with real execution evidence.
  const noVerdict = review.parseVerdict('I read the code and it looks correct to me.');
  equal(noVerdict.verdict, null, 'prose with no VERDICT line is not a verdict');
  ok(noVerdict.inconclusive, 'and it is reported as inconclusive, not as a pass');

  const noReason = review.parseVerdict('VERDICT: ACCEPTED\nRAN-COMMAND: node x.js\nRAN-OUTPUT: 5\n');
  equal(noReason.verdict, null, 'a verdict with no REASON is not accepted');

  const noEvidence = review.parseVerdict('VERDICT: ACCEPTED\nREASON: the tests pass\n');
  equal(noEvidence.verdict, null,
    'ACCEPTED with no RAN-COMMAND is discarded -- exactly the "the tests passed" claim that failed in batch 1');
  ok(/without-execution-evidence/.test(noEvidence.reason), 'and the discard says why');

  const rejectedNoRun = review.parseVerdict('VERDICT: REJECTED\nREASON: unverifiable: could not execute\n');
  equal(rejectedNoRun.verdict, 'rejected', 'a REJECTION does not require execution evidence to stand');

  const good = review.parseVerdict([
    'VERDICT: ACCEPTED',
    'SCORE: 0.9',
    'REASON: matched pdfinfo on all 52 real PDFs',
    'RAN-COMMAND: node harness.js ../real-pdfs',
    'RAN-OUTPUT: 52/52 page counts matched',
    'EFFECT: wrote 52 rows to state/pdf-pages.jsonl and returned pages=311 for the largest file',
    'SHAPE-CHECKED: src/lib/providers/google.js:168',
    'FAILURE-MODES: imagined-schema=pass, unreachable-code=pass, authority-inversion=pass, fabricated-numbers=pass, scope=pass'
  ].join('\n'));
  equal(good.verdict, 'accepted', 'a well-evidenced acceptance parses');
  equal(good.score, 0.9, 'and carries its graded score, not just a bit');
  equal(good.evidence.command, 'node harness.js ../real-pdfs', 'the command is captured as evidence');
  equal(good.evidence.shapeChecked, 'src/lib/providers/google.js:168', 'so is the producer file the shapes were checked against');

  review.recordVerdict(stateFile, 'lane-v', {
    reviewer: 'review:codex', verdict: 'accepted', reason: good.reason, evidence: good.evidence, repoRoot
  });
  const lane = stateStore.readState(stateFile).lanes['lane-v'];
  equal(lane.verification.reviewer, 'review:codex', 'the verdict names the reviewer that actually ran');
  ok(lane.verification.reason && lane.verification.reason.length > 0, 'and carries a reason');
  equal(lane.review.evidence.command, 'node harness.js ../real-pdfs', 'the execution evidence is durable');
}

// ---------------------------------------------------------------------------
// 4. The backlog threshold really blocks new launches
// ---------------------------------------------------------------------------
async function testBacklogThresholdBlocksLaunches() {
  const repoRoot = newRepoRoot('backlog');
  const stateFile = stateFileIn(repoRoot);

  for (let i = 0; i < 3; i += 1) seedFinishedLane(stateFile, `done-${i}`, { itemId: OPEN_IDS[i] });
  equal(review.reviewBacklog(stateStore.readState(stateFile)), 3, 'three lanes are awaiting review');

  const allowed = claimNext(stateFile, {
    openItemIds: OPEN_IDS, laneIdFor: () => 'next-1', supervisorId: 'sup-test',
    concurrency: 15, maxAttempts: 99, maxNoProgressAttempts: 99, reviewBacklogThreshold: 6
  });
  ok(allowed.claimed, 'under the threshold the fleet still claims work');

  for (let i = 3; i < 6; i += 1) seedFinishedLane(stateFile, `done-${i}`, { itemId: OPEN_IDS[i] });
  const blocked = claimNext(stateFile, {
    openItemIds: OPEN_IDS, laneIdFor: () => 'next-2', supervisorId: 'sup-test',
    concurrency: 15, maxAttempts: 99, maxNoProgressAttempts: 99, reviewBacklogThreshold: 6
  });
  equal(blocked.claimed, null, 'at the threshold no new lane is claimed');
  equal(blocked.reason, 'review-backlog-full', 'and the refusal names the review backlog, not concurrency');
  equal(blocked.backlog, 6, 'reporting the real backlog it measured');

  // The cap is a FUNCTION of review throughput: one verdict frees one slot.
  review.recordVerdict(stateFile, 'done-0', {
    reviewer: 'review:codex', verdict: 'rejected', reason: 'imagined schema', repoRoot
  });
  const afterVerdict = claimNext(stateFile, {
    openItemIds: OPEN_IDS, laneIdFor: () => 'next-3', supervisorId: 'sup-test',
    concurrency: 15, maxAttempts: 99, maxNoProgressAttempts: 99, reviewBacklogThreshold: 6
  });
  ok(afterVerdict.claimed, 'draining one review immediately makes room for one more lane');

  // Same rule through the supervisor's own tick().
  const queueFile = path.join(repoRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, buildQueue(20), 'utf8');
  const blockedRoot = newRepoRoot('backlog-tick');
  const blockedState = stateFileIn(blockedRoot);
  // Real workspaces, so the lanes are genuinely reviewABLE and stay in the
  // backlog while the reviewer is failing rather than being cleared out.
  for (let i = 0; i < 6; i += 1) {
    seedFinishedLane(blockedState, `held-${i}`, { itemId: `Q${i + 1}`, worktree: blockedRoot });
  }
  let launches = 0;
  const supervisor = new FleetSupervisor({
    repoRoot, stateFile: blockedState, queueFile, concurrency: 15,
    killSwitch: { status: () => ({ active: false, path: 'none' }) },
    review: {
      enabled: true, backlogThreshold: 6,
      chooseReviewer: () => ({ providerId: 'codex', checked: [], reason: null }),
      runReviewer: async () => ({ ok: false, code: 'TEST_NO_REVIEWER', text: '' })
    },
    runLane: async () => { launches += 1; return { ok: true, changedFileCount: 1 }; }
  });
  const tick = await supervisor.tick();
  equal(tick.launched.length, 0, 'the supervisor launches nothing while the backlog is at the threshold');
  equal(launches, 0, 'no lane runner was invoked at all');
  await supervisor.drain();
  const report = supervisor.status();
  equal(report.review.launchGate.blocked, true, 'and --status reports the launch gate as blocked');
  equal(report.review.launchGate.reason, 'review-backlog-full', 'with the honest reason');
}

function buildQueue(count) {
  const lines = ['# BUILD-QUEUE', '', '## Builder protocol (read once per loop)', '', '**Pick rule:** lowest open.', ''];
  for (let i = 1; i <= count; i += 1) lines.push('---', '', `## Q${i} - Phase ${i}`, '', '**Status:** OPEN', `Body ${i}.`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 5. KILLSWITCH stops reviews, not just lanes
// ---------------------------------------------------------------------------
async function testKillSwitchStopsReviews() {
  const repoRoot = newRepoRoot('kill');
  const stateFile = stateFileIn(repoRoot);
  const queueFile = path.join(repoRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, buildQueue(5), 'utf8');
  seedFinishedLane(stateFile, 'lane-k', { worktree: repoRoot });

  let reviewerRuns = 0;
  let active = true;
  const supervisor = new FleetSupervisor({
    repoRoot, stateFile, queueFile, concurrency: 4,
    killSwitch: { status: () => ({ active, path: path.join(repoRoot, 'KILLSWITCH') }) },
    review: {
      enabled: true,
      runReviewer: async () => {
        reviewerRuns += 1;
        return { ok: true, text: 'VERDICT: REJECTED\nREASON: fixture rejection\n' };
      },
      chooseReviewer: () => ({ providerId: 'codex', checked: [], reason: null })
    },
    runLane: async () => ({ ok: true, changedFileCount: 1 })
  });

  const blocked = await supervisor.tick();
  equal(blocked.blocked, 'killswitch', 'the tick reports the kill switch');
  equal(reviewerRuns, 0, 'NO reviewer process was started while KILLSWITCH was set');
  equal(supervisor.reviewTick().length, 0, 'a direct reviewTick() is refused too, not only the tick() path');
  const held = stateStore.readState(stateFile).lanes['lane-k'];
  ok(!held.review || held.review.state !== 'in-review', 'and no lane was even claimed for review');

  active = false;
  supervisor.reviewTick();
  await supervisor.drain();
  equal(reviewerRuns, 1, 'clearing the kill switch lets review run again');
  equal(stateStore.readState(stateFile).lanes['lane-k'].verification.state, 'rejected',
    'and the verdict is recorded');
}

// ---------------------------------------------------------------------------
// 6. Packet capture: the work is preserved BEFORE the worktree can vanish
// ---------------------------------------------------------------------------
function testPacketCaptureFromRealWorktree() {
  const root = tempDir('capture-repo');
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, shell: false });
  git(['init', '--quiet']);
  git(['config', 'user.email', 'fleet@test.local']);
  git(['config', 'user.name', 'fleet test']);
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '--quiet', '-m', 'seed']);

  const baseline = worktrees.captureBaselineTree(root);
  fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'lib', 'new-thing.js'), 'module.exports = { real: true };\n', 'utf8');

  const repoRoot = newRepoRoot('capture-state');
  const packet = review.capturePacket({
    laneId: 'cap-lane', itemId: 'Q11', repoRoot, worktree: root, baselineTree: baseline,
    brief: 'Create EXACTLY ONE NEW FILE: src/lib/new-thing.js',
    briefedInputs: ['src/lib/producer.js'],
    laneClaims: { filesRead: ['src/lib/producer.js'], filesChanged: ['src/lib/new-thing.js'] },
    laneOutcome: { processExitOk: true }
  });

  ok(packet.ok, 'the packet captured');
  assert.deepStrictEqual(packet.changedPaths, ['src/lib/new-thing.js'], 'exactly what the lane changed, not the whole tree');
  checks += 1;
  equal(packet.filesCopied, 1, 'the changed file was copied out');
  equal(fs.readFileSync(path.join(packet.dir, 'files', 'src', 'lib', 'new-thing.js'), 'utf8'),
    'module.exports = { real: true };\n', 'byte-for-byte');
  ok(fs.readFileSync(path.join(packet.dir, 'lane.diff'), 'utf8').includes('new-thing.js'), 'the diff was preserved');
  const manifest = review.readManifest(packet.dir);
  assert.deepStrictEqual(manifest.expectFiles, ['src/lib/producer.js'], 'the briefed expectFiles ride along');
  checks += 1;
  ok(manifest.laneClaims && manifest.laneClaims.filesChanged, 'so do the lane\'s own claims, labeled as claims');
  ok(manifest.brief.includes('EXACTLY ONE NEW FILE'), 'and the brief the lane was given');

  // Now delete the "worktree": the evidence must still exist.
  fs.rmSync(path.join(root, 'src'), { recursive: true, force: true });
  equal(fs.readFileSync(path.join(packet.dir, 'files', 'src', 'lib', 'new-thing.js'), 'utf8'),
    'module.exports = { real: true };\n', 'the preserved copy outlives the worktree');

  // A worktree that is already gone yields an honest failure, never a fake packet.
  const gone = review.capturePacket({
    laneId: 'gone-lane', itemId: 'Q11', repoRoot, worktree: path.join(root, 'does-not-exist'), baselineTree: baseline
  });
  equal(gone.ok, false, 'capturing from a missing worktree fails');
  equal(gone.reason, 'lane-worktree-missing-at-capture-time', 'with a reason, not a silent empty packet');
}

// ---------------------------------------------------------------------------
// 7. THE POINT: a lane whose OWN test passes but whose real-data behaviour is
//    wrong must be REJECTED.
//
// Modeled on the two batch-1 escapes described in the doctrine:
//   * s09-gmail: consumed `details.messageId` / `details.errorCode`; the real
//     producer writes neither, so the field is permanently null in production.
//   * s03-pdfinfo: reported a count with ok:true that did not match reality.
// The fixture reproduces the mechanism exactly: the artifact codes against an
// imagined schema, and the lane's own test fabricates that same schema so it
// passes. Reading the code does not catch it. Running the lane's test does not
// catch it. Executing it against the REAL producer's output does.
// ---------------------------------------------------------------------------
function writeFabricatedLaneFixture(worktree) {
  fs.mkdirSync(path.join(worktree, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(worktree, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(worktree, 'logs'), { recursive: true });

  // THE REAL PRODUCER (pre-existing repo file the lane was told to read).
  // It writes `result.id` and `result.error.code`. There is no `details` key.
  fs.writeFileSync(path.join(worktree, 'src', 'lib', 'send-producer.js'), [
    "'use strict';",
    '// Writes one JSON line per send attempt. THIS is the real emitted shape.',
    'const fs = require("node:fs");',
    'function recordSend(file, { ok, provider, id = null, errorCode = null }) {',
    '  const entry = { at: new Date().toISOString(), ok, provider, result: { id, error: errorCode ? { code: errorCode } : null } };',
    '  fs.appendFileSync(file, JSON.stringify(entry) + "\\n", "utf8");',
    '  return entry;',
    '}',
    'module.exports = { recordSend };',
    ''
  ].join('\n'), 'utf8');

  // THE LANE'S ARTIFACT: reads `entry.details.messageId` / `entry.details.errorCode`.
  // Those keys do not exist in anything send-producer.js writes.
  fs.writeFileSync(path.join(worktree, 'src', 'lib', 'send-history.js'), [
    "'use strict';",
    'const fs = require("node:fs");',
    'function summarize(file) {',
    '  const lines = fs.readFileSync(file, "utf8").split("\\n").filter(Boolean);',
    '  let withMessageId = 0;',
    '  let failures = 0;',
    '  for (const line of lines) {',
    '    const entry = JSON.parse(line);',
    '    if (entry.details && entry.details.messageId) withMessageId += 1;',
    '    if (entry.details && entry.details.errorCode) failures += 1;',
    '  }',
    '  return { ok: true, total: lines.length, withMessageId, failures };',
    '}',
    'module.exports = { summarize };',
    ''
  ].join('\n'), 'utf8');

  // THE LANE'S OWN TEST: fabricates the imagined schema, so it passes.
  fs.writeFileSync(path.join(worktree, 'tests', 'send-history.js'), [
    "'use strict';",
    'const assert = require("node:assert/strict");',
    'const fs = require("node:fs");',
    'const os = require("node:os");',
    'const path = require("node:path");',
    'const { summarize } = require("../src/lib/send-history.js");',
    'const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lane-own-test-")), "log.jsonl");',
    'fs.writeFileSync(file, [',
    '  JSON.stringify({ ok: true, details: { messageId: "abc" } }),',
    '  JSON.stringify({ ok: false, details: { errorCode: "RATE" } })',
    '].join("\\n") + "\\n", "utf8");',
    'const out = summarize(file);',
    'assert.strictEqual(out.total, 2);',
    'assert.strictEqual(out.withMessageId, 1);',
    'assert.strictEqual(out.failures, 1);',
    'console.log("send-history tests passed (3 checks).");',
    ''
  ].join('\n'), 'utf8');

  // REAL DATA on disk, written by the REAL producer.
  const { recordSend } = require(path.join(worktree, 'src', 'lib', 'send-producer.js'));
  const realLog = path.join(worktree, 'logs', 'sends.jsonl');
  recordSend(realLog, { ok: true, provider: 'gmail', id: 'm-1' });
  recordSend(realLog, { ok: true, provider: 'gmail', id: 'm-2' });
  recordSend(realLog, { ok: false, provider: 'gmail', errorCode: 'RATE_LIMIT' });
  return realLog;
}

// A reviewer that behaves the way the prompt demands: it EXECUTES the artifact
// against the real producer output and compares the result to ground truth
// obtained independently, then answers in the required format. Deterministic,
// offline, and -- crucially -- it derives its verdict from a real child-process
// run, not from a hardcoded answer.
function executingReviewer({ workspaceArtifact = 'src/lib/send-history.js', dataFile = 'logs/sends.jsonl' } = {}) {
  return async ({ cwd }) => {
    const harness = path.join(cwd, '.review-harness.js');
    fs.writeFileSync(harness, [
      'const { summarize } = require("./' + workspaceArtifact.replace(/\\/g, '/') + '");',
      'const fs = require("node:fs");',
      'const out = summarize("' + dataFile + '");',
      '// Ground truth read straight off the real producer output.',
      'const lines = fs.readFileSync("' + dataFile + '", "utf8").split("\\n").filter(Boolean).map(JSON.parse);',
      'const truthIds = lines.filter(e => e.result && e.result.id).length;',
      'const truthErrors = lines.filter(e => e.result && e.result.error).length;',
      'console.log(JSON.stringify({ artifact: out, truthIds, truthErrors }));',
      ''
    ].join('\n'), 'utf8');
    let raw;
    try {
      raw = execFileSync(process.execPath, [harness], { cwd, encoding: 'utf8', windowsHide: true, shell: false });
    } catch (error) {
      return { ok: true, text: `VERDICT: REJECTED\nREASON: unverifiable: harness threw ${String(error && error.message).slice(0, 80)}\n` };
    }
    const observed = JSON.parse(raw.trim().split('\n').pop());
    const mismatch = observed.artifact.withMessageId !== observed.truthIds
      || observed.artifact.failures !== observed.truthErrors;
    return {
      ok: true,
      text: [
        `VERDICT: ${mismatch ? 'REJECTED' : 'ACCEPTED'}`,
        `SCORE: ${mismatch ? '0.0' : '1.0'}`,
        `REASON: ${mismatch
          ? `real run reported withMessageId=${observed.artifact.withMessageId}/failures=${observed.artifact.failures} but the real producer wrote ${observed.truthIds} ids and ${observed.truthErrors} errors`
          : 'real run matched the producer output exactly'}`,
        `RAN-COMMAND: node .review-harness.js`,
        `RAN-OUTPUT: ${raw.trim().slice(0, 200)}`,
        `EFFECT: summarize() returned total=${observed.artifact.total} withMessageId=${observed.artifact.withMessageId} over the real producer log`,
        'SHAPE-CHECKED: src/lib/send-producer.js (writes result.id / result.error.code; no details key exists)',
        `FAILURE-MODES: imagined-schema=${mismatch ? 'fail' : 'pass'}, unreachable-code=pass, authority-inversion=pass, fabricated-numbers=pass, scope=pass`
      ].join('\n')
    };
  };
}

async function testFabricatedPassingLaneIsRejected() {
  const repoRoot = newRepoRoot('fabricated');
  const stateFile = stateFileIn(repoRoot);
  const worktree = tempDir('fabricated-worktree');
  const realLog = writeFabricatedLaneFixture(worktree);

  // Precondition: the LANE'S OWN TEST PASSES. If this ever stops being true the
  // fixture has stopped modeling the failure it exists to model.
  const ownTest = execFileSync(process.execPath, [path.join(worktree, 'tests', 'send-history.js')], {
    encoding: 'utf8', windowsHide: true, shell: false, cwd: worktree
  });
  ok(/tests passed \(3 checks\)/.test(ownTest),
    'FIXTURE PRECONDITION: the lane\'s own test passes, exactly like the batch-1 lanes that were wrong');

  // Precondition: against REAL data the artifact is wrong.
  const { summarize } = require(path.join(worktree, 'src', 'lib', 'send-history.js'));
  const realResult = summarize(realLog);
  equal(realResult.ok, true, 'and against real data it still reports ok:true (the s03 shape)');
  equal(realResult.withMessageId, 0, 'while actually finding 0 message ids in 3 real sends (the s09 shape)');

  seedFinishedLane(stateFile, 'fab-lane', { itemId: 'Q11', changedFileCount: 2, worktree });

  const claim = review.claimLaneForReview(stateFile, { supervisorId: 'sup-test' });
  ok(claim.claimed && claim.claimed.worktree === worktree, 'the lane is claimed for review with its workspace');

  const outcome = await review.reviewOneLane(stateFile, claim.claimed, {
    repoRoot,
    chooseReviewerImpl: () => ({ providerId: 'codex', checked: [], reason: null }),
    runReviewerImpl: executingReviewer()
  });

  equal(outcome.verdict, 'rejected',
    'THE POINT: a lane whose own test passes but whose real-data behaviour is wrong is REJECTED');
  ok(/withMessageId=0/.test(outcome.reason), 'and the rejection quotes the real observed output, not an opinion');
  equal(outcome.reviewer, 'review:codex', 'by a named reviewer that is not the lane and not its provider');

  const lane = stateStore.readState(stateFile).lanes['fab-lane'];
  equal(lane.verification.state, 'rejected', 'the durable state records the rejection');
  equal(lane.verification.verdict, 'rejected', 'with an explicit verdict');
  ok(lane.review.evidence.command.includes('node'), 'and the command the reviewer actually ran');
  ok(!review.awaitsReview(lane), 'the lane leaves the backlog, so the fleet may launch again');

  // Control: a CORRECT artifact against the same real data is accepted.
  const goodWorktree = tempDir('correct-worktree');
  writeFabricatedLaneFixture(goodWorktree);
  fs.writeFileSync(path.join(goodWorktree, 'src', 'lib', 'send-history.js'), [
    "'use strict';",
    'const fs = require("node:fs");',
    'function summarize(file) {',
    '  const lines = fs.readFileSync(file, "utf8").split("\\n").filter(Boolean);',
    '  let withMessageId = 0;',
    '  let failures = 0;',
    '  for (const line of lines) {',
    '    const entry = JSON.parse(line);',
    '    if (entry.result && entry.result.id) withMessageId += 1;',
    '    if (entry.result && entry.result.error) failures += 1;',
    '  }',
    '  return { ok: true, total: lines.length, withMessageId, failures };',
    '}',
    'module.exports = { summarize };',
    ''
  ].join('\n'), 'utf8');

  seedFinishedLane(stateFile, 'good-lane', { itemId: 'Q17', changedFileCount: 2, worktree: goodWorktree });
  const goodClaim = review.claimLaneForReview(stateFile, { supervisorId: 'sup-test' });
  const goodOutcome = await review.reviewOneLane(stateFile, goodClaim.claimed, {
    repoRoot,
    chooseReviewerImpl: () => ({ providerId: 'codex', checked: [], reason: null }),
    runReviewerImpl: executingReviewer()
  });
  equal(goodOutcome.verdict, 'accepted', 'the same reviewer accepts an artifact that matches the real producer');
  equal(stateStore.readState(stateFile).lanes['good-lane'].mergeEligible, true,
    'and only then does the work become eligible for the controller to merge');
}

// ---------------------------------------------------------------------------
// 7b. A lane whose work no longer exists is retried, then recorded as
//     UNREVIEWABLE -- never silently dropped, and never confused with a
//     reviewer judging the work bad. (Observed live 2026-07-28: five backlog
//     lanes predating packet capture, four with reaped worktrees.)
// ---------------------------------------------------------------------------
async function testMissingArtifactIsUnreviewableNotJudged() {
  const repoRoot = newRepoRoot('no-artifact');
  const stateFile = stateFileIn(repoRoot);
  seedFinishedLane(stateFile, 'ghost-lane', { worktree: path.join(repoRoot, 'worktree-that-was-reaped') });

  const options = {
    repoRoot,
    maxAttempts: 2,
    chooseReviewerImpl: () => ({ providerId: 'codex', checked: [], reason: null }),
    runReviewerImpl: () => { throw new Error('a reviewer must not be spawned when there is nothing to review'); }
  };

  const first = await review.reviewOneLane(stateFile,
    review.claimLaneForReview(stateFile, { supervisorId: 'sup-test', maxAttempts: 2 }).claimed, options);
  equal(first.verdict, null, 'the first missing-artifact attempt does NOT reach a verdict');
  ok(/no-artifact-to-review/.test(first.reason), 'it is deferred with an explicit reason (a prune race deserves a retry)');
  equal(stateStore.readState(stateFile).lanes['ghost-lane'].verification.state, 'unverified',
    'and the lane is still unverified');

  const second = await review.reviewOneLane(stateFile,
    review.claimLaneForReview(stateFile, { supervisorId: 'sup-test', maxAttempts: 2 }).claimed, options);
  equal(second.verdict, 'rejected', 'once the attempt budget is spent it becomes terminal');
  equal(second.unreviewable, true, 'flagged as unreviewable, not as a judgement of the work');
  ok(/NOT a judgement of the work/.test(second.reason), 'and the reason says so in words');

  const report = status(stateFile, { reviewBacklogThreshold: 6 });
  const entry = report.lanesRejected.find(row => row.laneId === 'ghost-lane');
  equal(entry.unreviewable, true, '--status distinguishes it from a real rejection');
  equal(report.review.backlog, 0, 'and it no longer wedges the launch gate, because no future review could ever see it');
}

// ---------------------------------------------------------------------------
// 8. The review prompt itself must demand execution
// ---------------------------------------------------------------------------
function testPromptForcesExecution() {
  const prompt = review.buildReviewPrompt({
    lane: { laneId: 'lane-p', itemId: 'Q11', provider: 'gemini' },
    manifest: { changedPaths: ['src/lib/x.js'], expectFiles: ['src/lib/producer.js'], brief: 'do the thing', laneClaims: { filesChanged: ['src/lib/x.js'] } },
    workspace: 'C:/tmp/ws',
    repoRoot: 'C:/repo'
  });
  for (const demand of [
    'EXECUTE', 'RAN-COMMAND', 'RAN-OUTPUT', 'IMAGINED SCHEMA', 'UNREACHABLE CODE',
    'AUTHORITY INVERSION', 'FABRICATED NUMBERS', 'VERIFY EVERY DATA SHAPE'
  ]) {
    ok(prompt.includes(demand), `the prompt demands: ${demand}`);
  }
  ok(/own test results are NOT evidence/i.test(prompt), 'and tells the reviewer the lane\'s tests are not evidence');
  ok(prompt.includes('untrusted'), 'and marks the brief/files as untrusted data');
  ok(prompt.includes('C:/tmp/ws') && prompt.includes('C:/repo'),
    'and names the workspace AND the live repo so real data is reachable');

  // Reviewer invocation must let the reviewer actually run things.
  const codexArgs = review.reviewerArgs('codex', { prompt: 'p', cwd: 'C:/tmp/ws' });
  ok(codexArgs.includes('--sandbox') && codexArgs[codexArgs.indexOf('--sandbox') + 1] === 'workspace-write',
    'codex reviews run in a sandbox that permits executing a harness');
  equal(codexArgs[codexArgs.indexOf('--cd') + 1], 'C:/tmp/ws', 'and are pinned to the review workspace');
  ok(!codexArgs.includes('--ignore-user-config'),
    'the machine codex config is honored: measured 2026-07-28, --ignore-user-config leaves codex unable to run ANY command on Windows ("rejected: blocked by policy"), which would make every review unverifiable');
  assert.throws(() => review.reviewerArgs('claude', { prompt: 'p', cwd: 'x' }), /No reviewer invocation/);
  checks += 1;
}

// ---------------------------------------------------------------------------
// 9. Review claiming is durable and single-holder
// ---------------------------------------------------------------------------
function testReviewClaimingIsSingleHolder() {
  const repoRoot = newRepoRoot('claiming');
  const stateFile = stateFileIn(repoRoot);
  seedFinishedLane(stateFile, 'c-1', { itemId: 'Q11' });
  seedFinishedLane(stateFile, 'c-2', { itemId: 'Q17' });

  const first = review.claimLaneForReview(stateFile, { supervisorId: 'sup-a' });
  const second = review.claimLaneForReview(stateFile, {
    supervisorId: 'sup-b', inFlightLaneIds: new Set([first.claimed.laneId])
  });
  ok(first.claimed && second.claimed, 'two reviewers can work two different lanes');
  ok(first.claimed.laneId !== second.claimed.laneId, 'never the same lane twice');

  const third = review.claimLaneForReview(stateFile, { supervisorId: 'sup-c' });
  equal(third.claimed, null, 'a lane already held by a live reviewer is not re-claimed');
  equal(third.reason, 'all-candidates-held-or-stalled', 'and the refusal is explicit');

  // A dead holder is reclaimed rather than deadlocking the backlog forever.
  stateStore.withState(stateFile, state => {
    state.lanes['c-1'].review.claimedPid = 999_999;
    return { state };
  });
  const reclaimed = review.claimLaneForReview(stateFile, { supervisorId: 'sup-d', isAlive: () => false });
  ok(reclaimed.claimed, 'a claim held by a dead process is reclaimed');

  // Attempts are capped; a lane nothing can review becomes `stalled` but stays
  // in the backlog, so the fleet stops rather than quietly building more.
  for (let i = 0; i < 5; i += 1) {
    const claim = review.claimLaneForReview(stateFile, { supervisorId: 'sup-e', isAlive: () => false, maxAttempts: 3 });
    if (!claim.claimed) break;
    review.releaseReviewClaim(stateFile, claim.claimed.laneId, { error: 'reviewer exploded', maxAttempts: 3 });
  }
  const lanes = stateStore.readState(stateFile).lanes;
  const stalled = Object.values(lanes).filter(lane => lane.review && lane.review.state === 'stalled');
  ok(stalled.length > 0, 'a lane that repeatedly cannot be reviewed is marked stalled');
  ok(stalled.every(lane => review.awaitsReview(lane)),
    'and it STAYS in the backlog: unreviewable output must keep blocking new launches');
  const report = status(stateFile, { reviewBacklogThreshold: 6 });
  ok(report.review.stalled.length > 0, 'and --status surfaces it for a human');
}

// ---------------------------------------------------------------------------
// 10. End to end through the supervisor: review runs alongside lanes
// ---------------------------------------------------------------------------
async function testSupervisorRunsReviewAlongsideLanes() {
  const repoRoot = newRepoRoot('e2e');
  const stateFile = stateFileIn(repoRoot);
  const queueFile = path.join(repoRoot, 'BUILD-QUEUE.md');
  fs.writeFileSync(queueFile, buildQueue(10), 'utf8');

  const laneWorkspaces = [];
  const realWorktrees = require('../src/lib/fleet-supervisor/worktree.js');
  const saved = {
    createLaneWorktree: realWorktrees.createLaneWorktree,
    removeLaneWorktree: realWorktrees.removeLaneWorktree,
    materializeWorkingTree: realWorktrees.materializeWorkingTree,
    captureBaselineTree: realWorktrees.captureBaselineTree,
    changedSinceBaseline: realWorktrees.changedSinceBaseline,
    capturePacket: review.capturePacket
  };
  let removals = 0;
  realWorktrees.createLaneWorktree = laneId => {
    const dir = tempDir(`e2e-lane-${laneId.slice(0, 6)}`);
    laneWorkspaces.push(dir);
    return { path: dir, marker: {} };
  };
  realWorktrees.removeLaneWorktree = () => { removals += 1; return { removed: true }; };
  realWorktrees.materializeWorkingTree = () => ({
    complete: true, reason: null, trackedExpected: [], trackedMissing: [],
    untrackedExpected: 0, untrackedCopied: 0, untrackedSkipped: [], patchBytes: 0
  });
  // This test exercises continuous scheduling/review, not Git plumbing. Give
  // each disposable lane an owned baseline and measured change so it never
  // searches above the temp directory for an unrelated repository.
  realWorktrees.captureBaselineTree = () => 'fixture-baseline-tree';
  realWorktrees.changedSinceBaseline = () => 1;
  review.capturePacket = ({ laneId, repoRoot: packetRoot }) => ({
    ok: true,
    reason: null,
    dir: path.join(packetRoot, 'state', 'fleet-review', 'pending', laneId),
    filesCopied: 1,
    diffBytes: 0
  });

  try {
    let reviewsRun = 0;
    let gateBlocked = 0;
    const supervisor = new FleetSupervisor({
      repoRoot, stateFile, queueFile, concurrency: 15, maxAttempts: 1, maxNoProgressAttempts: 99, pollMs: 0,
      killSwitch: { status: () => ({ active: false, path: 'none' }) },
      logger: entry => { if (entry.event === 'launch-blocked-by-review-backlog') gateBlocked += 1; },
      review: {
        enabled: true,
        backlogThreshold: 4,
        concurrency: 2,
        chooseReviewer: () => ({ providerId: 'codex', checked: [], reason: null }),
        // A reviewer that really executes something in the review workspace and
        // quotes the REAL output back -- because the harness now re-runs that
        // command itself and compares. A canned string would (correctly) be
        // discarded as unverifiable.
        runReviewer: async ({ cwd }) => {
          reviewsRun += 1;
          fs.writeFileSync(path.join(cwd, 'probe.js'),
            'console.log("3/3 matched against the real state file");\n', 'utf8');
          const real = execFileSync(process.execPath, ['probe.js'], {
            cwd, encoding: 'utf8', windowsHide: true, shell: false
          }).trim();
          return {
            ok: true,
            text: [
              'VERDICT: ACCEPTED',
              'SCORE: 1.0',
              'REASON: executed the module against the real state file and the counts matched',
              'RAN-COMMAND: node probe.js',
              `RAN-OUTPUT: ${real}`,
              'EFFECT: the probe returned a non-empty 3/3 comparison against the real state file',
              'FAILURE-MODES: imagined-schema=pass, unreachable-code=pass, authority-inversion=pass, fabricated-numbers=pass, scope=pass'
            ].join('\n')
          };
        }
      },
      // Like the real lane runner, report the pid so the lane's worktree is
      // recorded -- that worktree is the review workspace.
      runLane: async ({ onStart, laneId }) => {
        onStart(process.pid);
        return {
          ok: true, changedFileCount: 1, reportedModels: ['gemini-2.5-pro'],
          directVertexEvidence: directVertexEvidenceFor(laneId, {
            responseId: 'vertex-continuous-review-producer'
          })
        };
      }
    });

    await supervisor.run({ maxCycles: 8, sleep: () => new Promise(resolve => setImmediate(resolve)) });
    const report = supervisor.status();

    ok(reviewsRun > 0, 'reviews ran continuously alongside lane execution, without a separate command');
    ok(report.lanesEligibleForMerge.length > 0, 'accepted lanes are reported as eligible for the controller to merge');
    ok(report.lanesEligibleForMerge.every(entry => entry.reviewer === 'review:codex'),
      'each carries the reviewer that actually ran');
    // THE HONEST BOUND. The launch gate stops CLAIMING at the threshold, but
    // lanes already in flight when it trips still land afterwards, so the real
    // bound is threshold + lane concurrency. The previous assertion here used
    // `threshold + reviewConcurrency`, which only ever held because a stubbed
    // reviewer returned instantly; it was measuring reviewer speed, not the
    // gate. Now that an accept costs a real harness re-execution, that
    // coincidence is gone -- so this asserts the structural invariant and the
    // gate firing, which is what the doctrine actually claims.
    ok(report.review.backlog <= 4 + supervisor.concurrency,
      'the backlog stays inside threshold + lane concurrency: nothing is claimed past the gate');
    ok(gateBlocked > 0, 'and the launch gate really fired rather than never being reached');
    equal(removals, 0,
      'no worktree awaiting or holding reviewed work was removed by the supervisor');

    // The supervisor must never merge. Assert on the source, like the
    // worktree-guard test does, not just on behaviour.
    const supervisorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'fleet-supervisor', 'supervisor.js'), 'utf8');
    ok(!/['"]merge['"]|['"]push['"]|['"]cherry-pick['"]/.test(supervisorSource),
      'supervisor.js contains no git merge/push/cherry-pick: merging stays a controller decision');
  } finally {
    Object.assign(realWorktrees, {
      createLaneWorktree: saved.createLaneWorktree,
      removeLaneWorktree: saved.removeLaneWorktree,
      materializeWorkingTree: saved.materializeWorkingTree,
      captureBaselineTree: saved.captureBaselineTree,
      changedSinceBaseline: saved.changedSinceBaseline
    });
    review.capturePacket = saved.capturePacket;
  }
}

// ---------------------------------------------------------------------------
// 11. THE NEW POINT: the HARNESS is the executor of record.
//
// Until this landed, review.js gated an ACCEPTED verdict on the SYNTACTIC
// PRESENCE of RAN-COMMAND/RAN-OUTPUT. Nothing re-ran the command; nothing
// compared the output to anything. That is the doctrine's own rejected move --
// "a lane's self-reported test result is worthless" -- displaced one level up
// onto the reviewer. This test drives a reviewer that runs a REAL command and
// then quotes output the command never produced.
// ---------------------------------------------------------------------------
function writeHonestArtifact(worktree) {
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'counter.js'),
    'module.exports = { count: () => 3 };\n', 'utf8');
  fs.writeFileSync(path.join(worktree, 'probe.js'),
    'console.log("counted " + require("./src/counter.js").count() + " real records");\n', 'utf8');
}

function reviewerSaying(lines) {
  return async () => ({ ok: true, text: lines.join('\n') });
}

const ACCEPT_TEMPLATE = ({ command, output, score = '1.0', effect = 'wrote 3 rows into state/counter.jsonl and returned count=3', modes = 'imagined-schema=pass, unreachable-code=pass, authority-inversion=pass, fabricated-numbers=pass, scope=pass' }) => ([
  'VERDICT: ACCEPTED',
  `SCORE: ${score}`,
  'REASON: executed the artifact against the real on-disk records',
  `RAN-COMMAND: ${command}`,
  `RAN-OUTPUT: ${output}`,
  `EFFECT: ${effect}`,
  'SHAPE-CHECKED: src/counter.js:1',
  `FAILURE-MODES: ${modes}`
]);

async function testFabricatingReviewerIsCaught() {
  const repoRoot = newRepoRoot('fabricating-reviewer');
  const stateFile = stateFileIn(repoRoot);

  const drive = async (laneId, itemId, reviewerText) => {
    const worktree = tempDir(`fabricating-${laneId}`);
    writeHonestArtifact(worktree);
    seedFinishedLane(stateFile, laneId, { itemId, worktree });
    const claim = review.claimLaneForReview(stateFile, { supervisorId: 'sup-test' });
    const outcome = await review.reviewOneLane(stateFile, claim.claimed, {
      repoRoot,
      chooseReviewerImpl: () => ({ providerId: 'codex', checked: [], reason: null }),
      runReviewerImpl: reviewerSaying(reviewerText),
      secondOpinionEnabled: false
    });
    return { outcome, lane: stateStore.readState(stateFile).lanes[laneId] };
  };

  // CONTROL: the reviewer quotes what the command really prints.
  const honest = await drive('honest-lane', 'Q11', ACCEPT_TEMPLATE({
    command: 'node probe.js', output: 'counted 3 real records'
  }));
  equal(honest.outcome.verdict, 'accepted', 'CONTROL: an honestly-quoted acceptance still passes');
  equal(honest.outcome.harness.verified, true, 'and the harness confirms it re-ran the command itself');
  ok(['exact-normalized', 'substring', 'token-overlap'].includes(honest.outcome.harness.match.mode),
    `matched by ${honest.outcome.harness.match.mode}`);
  equal(honest.lane.review.evidence.harness.classification, 'match',
    'the harness record is durable, alongside the reviewer\'s own claim');

  // THE FABRICATION: a real, runnable command -- and a quoted output the
  // command has never produced. Under the old gate this ACCEPTED, because both
  // fields were non-empty strings.
  const fabricated = await drive('fabricating-lane', 'Q17', ACCEPT_TEMPLATE({
    command: 'node probe.js', output: 'counted 52 real records, 52/52 verified against ground truth'
  }));
  equal(fabricated.outcome.verdict, null,
    'THE POINT: a reviewer that fabricates RAN-OUTPUT does NOT produce a verdict');
  equal(fabricated.outcome.harness.classification, 'fabricated',
    'and the harness names it fabrication, having proved the command is deterministic');
  ok(fabricated.outcome.harness.match.missingNumbers.includes('52'),
    'naming the number the command never printed');
  equal(fabricated.lane.verification.state, 'unverified',
    'DISCARDED, NOT REJECTED: a lying reviewer is not evidence the LANE is bad');
  ok(review.awaitsReview(fabricated.lane),
    'so the lane stays in the backlog for a fresh review, and keeps the launch gate honest');
  ok(!fabricated.lane.mergeEligible, 'and it is certainly not merge-eligible');

  // A command that does not exist at all: the reviewer invented the whole run.
  const invented = await drive('invented-lane', 'Q27', ACCEPT_TEMPLATE({
    command: 'node never-written.js', output: 'all checks passed'
  }));
  equal(invented.outcome.verdict, null, 'a command that cannot even run yields no verdict');
  ok(['fabricated', 'unstable', 'not-executable'].includes(invented.outcome.harness.classification),
    `classified honestly as ${invented.outcome.harness.classification}, not accepted`);

  // A command the harness refuses to run is ALSO not an acceptance -- and is
  // labelled as a refusal rather than as a lie.
  const refused = await drive('refused-lane', 'Q28', ACCEPT_TEMPLATE({
    command: 'node probe.js && rm -rf state', output: 'counted 3 real records'
  }));
  equal(refused.outcome.verdict, null, 'a chained/shell-shaped command yields no verdict');
  equal(refused.outcome.harness.classification, 'refused', 'and is recorded as a REFUSAL, not as fabrication');
  ok(/shell-metacharacters/.test(refused.outcome.harness.reason), 'naming why it was refused');
}

// ---------------------------------------------------------------------------
// 12. Command safety: the reviewer supplies this string, so it is a parser
//     problem, not a trust problem.
// ---------------------------------------------------------------------------
function testHarnessCommandSafety() {
  const workspace = tempDir('cmd-safety');
  const plan = command => review.planHarnessCommand(command, { workspace, repoRoot: workspace });

  ok(plan('node harness.js').ok, 'node <script> inside the workspace is allowed');
  ok(plan('npm test').ok, 'npm test is allowed');
  ok(plan('git diff --stat').ok, 'read-only git is allowed');
  ok(plan('node -e "console.log(1)"').ok, 'inline node eval is allowed -- it is the shape the prompt suggests');

  for (const [command, why] of [
    ['node a.js && curl http://x', 'chaining'],
    ['node a.js | tee out.txt', 'piping'],
    ['node a.js > out.txt', 'redirection'],
    ['node a.js; rm -rf /', 'sequencing'],
    ['echo $(whoami)', 'command substitution'],
    ['powershell -c "Get-Content x"', 'a shell'],
    ['cmd /c dir', 'a shell'],
    ['sudo node a.js', 'elevation'],
    ['npm install left-pad', 'an installing npm subcommand'],
    ['git push origin main', 'a writing git subcommand'],
    ['python evil.py', 'an off-allowlist binary'],
    ['node ../../../../etc/passwd.js', 'a script outside the workspace and repo']
  ]) {
    const result = plan(command);
    equal(result.ok, false, `refused (${why}): ${command}`);
  }

  // `node` resolves to THIS process's executable, never to whatever a
  // model-supplied string finds on PATH.
  equal(plan('node harness.js').executable, process.execPath,
    'node is spawned as the running interpreter, not resolved from PATH');
  // And nothing credential-shaped is inherited by a command a model chose.
  const env = review.verifyEvidence === undefined ? null : require('../src/lib/fleet-supervisor/evidence.js')
    .harnessEnvironment({ GEMINI_API_KEY: 'secret', GOOGLE_APPLICATION_CREDENTIALS: 'c:/adc.json', PATH: 'x' });
  equal(env.GEMINI_API_KEY, undefined, 'the harness strips credential env vars before running a model-chosen command');
  equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined, 'including the ADC path');
  equal(env.PATH, 'x', 'while leaving the ordinary environment intact');
}

// ---------------------------------------------------------------------------
// 13. The matcher: tolerant of real-world noise, intolerant of invention.
// ---------------------------------------------------------------------------
function testMatcherToleratesNoiseButCatchesInvention() {
  const compare = review.compareOutputs;

  ok(compare('52/52 page counts matched', '52/52 page counts matched').match, 'identical output matches');
  ok(compare('2026-07-29T04:11:02.881Z  52/52 matched in 1841ms', '2026-07-29T05:00:00.000Z  52/52 matched in 12ms').match,
    'timestamps and durations are normalized away -- exact matching here would fail every honest review');
  ok(compare('read C:\\Users\\owner\\Desktop\\ToolsEnabled\\logs\\x.jsonl: 3 rows', 'read C:\\other\\path\\x.jsonl: 3 rows').match,
    'absolute paths are normalized away too');
  ok(compare('checking...\n52/52 page counts matched\ndone.', '52/52 page counts matched').match,
    'a partial quote of real output matches (the prompt asks for <=300 chars)');

  const invented = compare('counted 3 real records', 'counted 52 real records');
  equal(invented.match, false, 'a fabricated COUNT does not match');
  equal(invented.mode, 'number-not-in-real-output',
    'and it is caught by the numeric rule specifically, not by prose drift');
  assert.deepStrictEqual(invented.missingNumbers, ['52'], 'naming the invented number');
  checks += 1;

  equal(compare('ok', 'the module returned 52 rows and 12 errors and everything passed').match, false,
    'a tiny real output cannot be stretched to cover a long invented claim');
  equal(compare('anything at all', '').match, false, 'an empty claim is an absence of evidence, not a match');
}

// ---------------------------------------------------------------------------
// 14. Non-determinism is DETECTED AND REPORTED, never punished as a lie.
// ---------------------------------------------------------------------------
async function testNonDeterministicCommandIsNotPunished() {
  const workspace = tempDir('nondet');
  // Each run prints a different counter value: legitimately non-deterministic.
  fs.writeFileSync(path.join(workspace, 'counter.js'), [
    'const fs = require("node:fs");',
    'let n = 0;',
    'try { n = Number(fs.readFileSync("n.txt", "utf8")) || 0; } catch {}',
    'n += 1;',
    'fs.writeFileSync("n.txt", String(n), "utf8");',
    'console.log("processed " + n + " batches of records");',
    ''
  ].join('\n'), 'utf8');

  // The harness runs it twice: run 1 prints 1, run 2 prints 2. The reviewer
  // quoted "2", which IS a real run -- just not the first one we made.
  const quotedReal = await review.verifyEvidence({
    command: 'node counter.js', claimedOutput: 'processed 2 batches of records', workspace
  });
  equal(quotedReal.verified, true, 'a quote matching one real run is VERIFIED even though the runs differ');
  equal(quotedReal.classification, 'nondeterministic', 'and is labelled non-deterministic, not "match"');
  ok(quotedReal.warnings.includes('command-output-varies-between-runs'), 'with the variance surfaced as a warning');

  const quotedNothing = await review.verifyEvidence({
    command: 'node counter.js', claimedOutput: 'processed 900 batches of records', workspace
  });
  equal(quotedNothing.verified, false, 'a quote matching NEITHER run is not verified');
  equal(quotedNothing.classification, 'nondeterministic',
    'but it is still classified non-deterministic -- crucially NOT "fabricated", because we cannot prove a lie');
  ok(/NOT recorded as a false claim/.test(quotedNothing.reason), 'and the reason says so in words');
  equal(quotedNothing.reruns, 2, 'the second run only happens on a mismatch, so the common path costs one execution');
}

// ---------------------------------------------------------------------------
// 15. FAILURE-MODES are typed flags now, not an opaque string.
// ---------------------------------------------------------------------------
function testFailureModesAreTyped() {
  const parsed = review.parseFailureModes(
    'imagined-schema=fail, unreachable-code=pass, authority-inversion=pass, fabricated-numbers=pass, scope=pass');
  equal(parsed.modes['imagined-schema'], 'fail', 'each flag is parsed into a typed value');
  assert.deepStrictEqual(parsed.failing, ['imagined-schema'], 'and failing modes are enumerated');
  checks += 1;
  assert.deepStrictEqual(review.parseFailureModes('').missingModes.length, 5, 'an absent line reports all five modes missing');
  checks += 1;

  // THE DEFECT: a reviewer could answer imagined-schema=fail AND accept.
  const contradictory = review.parseVerdict(ACCEPT_TEMPLATE({
    command: 'node probe.js', output: 'counted 3 real records',
    modes: 'imagined-schema=fail, unreachable-code=pass, authority-inversion=pass, fabricated-numbers=pass, scope=pass'
  }).join('\n'));
  equal(contradictory.verdict, null, 'an ACCEPTED verdict reporting a failing mode is no longer honored');
  ok(/failing-modes: imagined-schema/.test(contradictory.reason), 'and the discard names the mode');
  ok(contradictory.inconclusive,
    'it is retryable, not converted into a rejection: a self-contradicting reviewer is most likely a formatting error');

  const noModes = review.parseVerdict([
    'VERDICT: ACCEPTED', 'REASON: looks right', 'RAN-COMMAND: node probe.js',
    'RAN-OUTPUT: counted 3 real records', 'EFFECT: wrote 3 rows to state/counter.jsonl'
  ].join('\n'));
  equal(noModes.verdict, null, 'an acceptance that never answered the doctrine checklist at all is discarded');

  // A REJECTION reporting a failing mode is perfectly coherent and stands.
  const rejects = review.parseVerdict([
    'VERDICT: REJECTED', 'SCORE: 0.0', 'REASON: consumes details.messageId, which no producer writes',
    'FAILURE-MODES: imagined-schema=fail, unreachable-code=pass, authority-inversion=pass, fabricated-numbers=pass, scope=pass'
  ].join('\n'));
  equal(rejects.verdict, 'rejected', 'a rejection that reports a failing mode is coherent and stands');
  assert.deepStrictEqual(rejects.failureModes.failing, ['imagined-schema'], 'with the mode recorded as structured data');
  checks += 1;
}

// ---------------------------------------------------------------------------
// 16. EFFECT: did the artifact actually DO anything.
// ---------------------------------------------------------------------------
function testEffectMustBeRealAndNonTrivial() {
  equal(review.checkEffect('undefined').trivial, true, '"undefined" is not an effect');
  equal(review.checkEffect('(none)').trivial, true, '"(none)" is not an effect');
  equal(review.checkEffect('0').trivial, true, '"0" is not an effect');
  equal(review.checkEffect('no output').trivial, true, '"no output" is not an effect');
  equal(review.checkEffect('appended 3 rows to logs/sends.jsonl').trivial, false,
    'a named, observable state change is an effect');

  // The exact escape the audit described: a module that imports cleanly and
  // does nothing, dressed up as a passing review.
  const hollow = review.parseVerdict([
    'VERDICT: ACCEPTED', 'REASON: the module loads', 'RAN-COMMAND: node -e "require(\'./src/lib/thing.js\')"',
    'RAN-OUTPUT: undefined', 'EFFECT: undefined',
    'FAILURE-MODES: imagined-schema=pass, unreachable-code=pass, authority-inversion=pass, fabricated-numbers=pass, scope=pass'
  ].join('\n'));
  equal(hollow.verdict, null, 'an acceptance whose EFFECT is "undefined" is discarded');
  ok(/EFFECT/.test(hollow.reason), 'and the discard names the missing effect');
}

// ---------------------------------------------------------------------------
// 17. servedBelowFloor is READ now (owner order R58).
// ---------------------------------------------------------------------------
async function testBelowFloorLaneIsRefused() {
  const repoRoot = newRepoRoot('below-floor');
  const stateFile = stateFileIn(repoRoot);
  const worktree = tempDir('below-floor-worktree');
  writeHonestArtifact(worktree);

  claimNext(stateFile, {
    openItemIds: ['Q11'], laneIdFor: () => 'floor-lane', supervisorId: 'sup-test',
    concurrency: 32, maxAttempts: 99, maxNoProgressAttempts: 99
  });
  recordLaneStarted(stateFile, 'floor-lane', { pid: process.pid, worktree, model: 'gemini-2.5-pro', backend: 'vertex' });
  recordLaneOutcome(stateFile, 'floor-lane', {
    ok: true, changedFileCount: 2, backend: 'vertex',
    // What the direct-Vertex response actually served: a cheap tier.
    reportedModels: ['gemini-3.1-flash-lite'],
    directVertexEvidence: directVertexEvidenceFor('floor-lane', {
      modelVersion: 'gemini-3.1-flash-lite', responseId: 'vertex-floor-lane-producer'
    }),
    maxAttempts: 99, maxNoProgressAttempts: 99
  });

  const lane = stateStore.readState(stateFile).lanes['floor-lane'];
  assert.deepStrictEqual(lane.outcome.servedBelowFloor, ['gemini-3.1-flash-lite'],
    'the R58 instrumentation records the off-floor serve, as it always did');
  checks += 1;

  const claim = review.claimLaneForReview(stateFile, { supervisorId: 'sup-test' });
  assert.deepStrictEqual(claim.claimed.servedBelowFloor, ['gemini-3.1-flash-lite'],
    'and the claim now carries it to the stage that can act on it');
  checks += 1;

  const outcome = await review.reviewOneLane(stateFile, claim.claimed, {
    repoRoot,
    chooseReviewerImpl: () => ({ providerId: 'codex', checked: [], reason: null }),
    runReviewerImpl: () => { throw new Error('no reviewer may be spent on a lane served below the model floor'); }
  });
  equal(outcome.verdict, 'rejected', 'a below-floor lane is refused rather than accepted');
  ok(/below-floor|model evidence|receipt/i.test(outcome.reason),
    'with a conservative reason naming either the observed floor violation or the now-stricter missing producing-call receipt');
  ok(/NOT a judgement of the work|receipt|model evidence/i.test(outcome.reason),
    'and records this as a policy/provenance refusal before any quality judgement');
  assert.deepStrictEqual(outcome.belowFloor.servedBelowFloor, ['gemini-3.1-flash-lite'],
    'naming what was actually served');
  checks += 1;

  const after = stateStore.readState(stateFile).lanes['floor-lane'];
  equal(after.mergeEligible, false, 'a below-floor lane never becomes merge-eligible');
  equal(after.review.state, 'below-floor', 'and the review record is labelled distinctly');

  const report = status(stateFile, { reviewBacklogThreshold: 6 });
  equal(report.lanesServedBelowFloor.length, 1, '--status surfaces the below-floor lane');
  equal(report.lanesServedBelowFloor[0].servedModels[0], 'gemini-3.1-flash-lite', 'naming the served model');
  equal(report.lanesServedBelowFloor[0].enforced, true, 'and reports that the review stage enforced it');
  const rejectedRow = report.lanesRejected.find(row => row.laneId === 'floor-lane');
  assert.deepStrictEqual(rejectedRow.belowFloor, ['gemini-3.1-flash-lite'],
    'the rejection is distinguishable from a quality rejection and from an unreviewable one');
  checks += 1;

  // A COMPLIANT lane is untouched, and an UNKNOWN serve is not read as a pass.
  const compliantRoot = newRepoRoot('below-floor-ok');
  const compliantState = stateFileIn(compliantRoot);
  seedFinishedLane(compliantState, 'ok-lane', {
    itemId: 'Q11', worktree, reportedModels: null, directVertexEvidence: null
  });
  const okReport = status(compliantState, { reviewBacklogThreshold: 6 });
  equal(okReport.lanesServedBelowFloor.length, 0, 'a lane with no off-floor serve is not flagged');
  equal(okReport.lanesWithUnknownServedModel.length, 1,
    'but a lane whose CLI reported NO model is listed as UNKNOWN -- absence of a flag is not proof the floor held');
}

// ---------------------------------------------------------------------------
// 18. History can answer "which model produces work that passes review".
// ---------------------------------------------------------------------------
function testHistoryCarriesModelAndVerdict() {
  const repoRoot = newRepoRoot('history');
  const stateFile = stateFileIn(repoRoot);

  const seed = (laneId, itemId, model, backend) => {
    claimNext(stateFile, {
      openItemIds: [itemId], laneIdFor: () => laneId, supervisorId: 'sup-test',
      concurrency: 32, maxAttempts: 99, maxNoProgressAttempts: 99
    });
    recordLaneStarted(stateFile, laneId, { pid: process.pid, worktree: repoRoot, model, backend });
    const attemptNumber = stateStore.readState(stateFile).lanes[laneId].attempt;
    recordLaneOutcome(stateFile, laneId, {
      ok: true, changedFileCount: 2, backend, reportedModels: [model], reportedTokens: 1000,
      directVertexEvidence: backend === 'vertex'
        ? directVertexEvidenceFor(laneId, { attemptNumber, modelVersion: model })
        : null,
      maxAttempts: 99, maxNoProgressAttempts: 99
    });
  };
  seed('h-vertex-1', 'Q11', 'gemini-2.5-pro', 'vertex');
  seed('h-vertex-2', 'Q17', 'gemini-2.5-pro', 'vertex');
  seed('h-sub-1', 'Q27', 'gemini-3.1-pro-preview', 'subscription');

  const outcomeEvents = stateStore.readState(stateFile).history.filter(e => e.event === 'lane-outcome');
  equal(outcomeEvents.length, 3, 'every lane outcome lands in the append-only history');
  equal(outcomeEvents[0].model, 'gemini-2.5-pro', 'carrying the MODEL that produced the work (it carried none before)');
  equal(outcomeEvents[0].backend, 'vertex', 'and the backend that paid for it');

  review.recordVerdict(stateFile, 'h-vertex-1', {
    reviewer: 'review:codex', verdict: 'accepted', reason: 'ran it against real data; matched',
    evidence: { score: 0.9, rubricVersion: review.REVIEW_RUBRIC_VERSION, scoreThreshold: review.REVIEW_SCORE_THRESHOLD },
    repoRoot
  });
  review.recordVerdict(stateFile, 'h-vertex-2', {
    reviewer: 'review:codex', verdict: 'rejected', reason: 'imagined schema', repoRoot
  });
  review.recordVerdict(stateFile, 'h-sub-1', {
    reviewer: 'review:codex', verdict: 'rejected', reason: 'unreachable code', repoRoot
  });

  const state = stateStore.readState(stateFile);
  const verifications = state.history.filter(e => e.event === 'verification');
  equal(verifications.length, 3, 'each landed verdict emits its OWN history event');
  const accepted = verifications.find(e => e.laneId === 'h-vertex-1');
  equal(accepted.verification, 'verified', 'recording the REAL verification outcome, not a hardcoded "unverified"');
  equal(accepted.model, 'gemini-2.5-pro', 'attributed to the model that produced the work');
  equal(accepted.reviewer, 'review:codex', 'and the reviewer that reached the verdict');
  equal(accepted.rubricVersion, review.REVIEW_RUBRIC_VERSION,
    'stamped with the rubric version, so a later prompt edit cannot silently corrupt the series');
  equal(accepted.score, 0.9, 'and the graded score');

  // THE QUESTION THE OWNER NEEDS ANSWERED, now answerable from our own data.
  const rows = verdictsByModel(state);
  const vertex = rows.find(row => row.model === 'gemini-2.5-pro');
  const sub = rows.find(row => row.model === 'gemini-3.1-pro-preview');
  equal(vertex.accepted, 1, 'per-model accept counts are computable');
  equal(vertex.rejected, 1, 'as are per-model rejections');
  equal(sub.accepted, 0, 'and the subscription path is measured separately');
  equal(vertex.backend, 'vertex', 'split by backend, which is what decides where the credit goes');

  const item = stateStore.readState(stateFile).items.Q11;
  equal(item.lastOutcome.verification, 'verified',
    'and the item summary stops claiming "unverified" forever after a verdict lands');
}

// ---------------------------------------------------------------------------
// 19. Graded score, and a second vendor spent ONLY near the threshold.
// ---------------------------------------------------------------------------
async function testGradedScoreAndSecondOpinion() {
  ok(review.scoreIsBorderline(0.7), 'a score at the threshold is borderline');
  ok(review.scoreIsBorderline(0.6) && review.scoreIsBorderline(0.8),
    'so are the two rubric anchors that straddle it');
  ok(!review.scoreIsBorderline(1.0) && !review.scoreIsBorderline(0.0),
    'a clear accept or a clear reject is NOT borderline, so it costs one reviewer, not two');

  // Score and verdict must agree -- his cross-validation discipline.
  const contradictory = review.parseVerdict(ACCEPT_TEMPLATE({
    command: 'node probe.js', output: 'counted 3 real records', score: '0.3'
  }).join('\n'));
  equal(contradictory.verdict, null, 'ACCEPTED with a score below the threshold is discarded as self-contradictory');
  const rejectedHigh = review.parseVerdict('VERDICT: REJECTED\nSCORE: 0.95\nREASON: nope\n');
  equal(rejectedHigh.verdict, null, 'and so is REJECTED with a score above it');

  const repoRoot = newRepoRoot('second-opinion');
  const stateFile = stateFileIn(repoRoot);
  const worktree = tempDir('second-opinion-worktree');
  writeHonestArtifact(worktree);
  // A CLAUDE lane, so both codex and gemini remain eligible as reviewers and a
  // genuine cross-vendor second opinion is possible.
  seedFinishedLane(stateFile, 'borderline-lane', { itemId: 'Q11', worktree });
  stateStore.withState(stateFile, state => {
    state.lanes['borderline-lane'].provider = 'claude';
    return { state };
  });

  const seen = [];
  const claim = review.claimLaneForReview(stateFile, { supervisorId: 'sup-test' });
  const outcome = await review.reviewOneLane(stateFile, claim.claimed, {
    repoRoot,
    reviewerPreference: ['codex', 'gemini'],
    chooseReviewerImpl: ({ preference }) => ({ providerId: preference[0], checked: [], reason: null }),
    runReviewerImpl: async ({ providerId }) => {
      seen.push(providerId);
      // First vendor: a bare accept at the threshold. Second vendor: 0.4.
      // Mean 0.55 -> below the line -> the accept is OVERTURNED.
      return providerId === 'codex'
        ? { ok: true, text: ACCEPT_TEMPLATE({ command: 'node probe.js', output: 'counted 3 real records', score: '0.7' }).join('\n') }
        : { ok: true, text: 'VERDICT: REJECTED\nSCORE: 0.4\nREASON: the changed module is registered nowhere\n' };
    }
  });

  assert.deepStrictEqual(seen, ['codex', 'gemini'],
    'a borderline score buys a second reviewer, and it is a DIFFERENT vendor');
  checks += 1;
  equal(outcome.verdict, 'rejected', 'the averaged cross-vendor score overturns a borderline accept');
  equal(Number(outcome.score.toFixed(3)), 0.55, 'the verdict now carries a graded score, not one bit');
  equal(outcome.secondOpinion.straddledThreshold, true,
    'and records that the two vendors landed on OPPOSITE sides of the line -- the 31% case his data measured');

  // Our real pool is {codex, gemini}: for a GEMINI lane there is no third
  // vendor, and that must be reported honestly rather than faked by re-asking
  // the same provider. Reviewer independence is a safety property here.
  const geminiRoot = newRepoRoot('second-opinion-none');
  const geminiState = stateFileIn(geminiRoot);
  const geminiWorktree = tempDir('second-opinion-none-worktree');
  writeHonestArtifact(geminiWorktree);
  seedFinishedLane(geminiState, 'gemini-lane', { itemId: 'Q11', worktree: geminiWorktree });
  let runs = 0;
  const soloOutcome = await review.reviewOneLane(geminiState,
    review.claimLaneForReview(geminiState, { supervisorId: 'sup-test' }).claimed, {
      repoRoot: geminiRoot,
      reviewerPreference: ['codex', 'gemini'],
      chooseReviewerImpl: ({ preference }) => ({ providerId: preference[0], checked: [], reason: null }),
      runReviewerImpl: async () => {
        runs += 1;
        return { ok: true, text: ACCEPT_TEMPLATE({ command: 'node probe.js', output: 'counted 3 real records', score: '0.7' }).join('\n') };
      }
    });
  equal(runs, 1, 'with no third vendor available, no second reviewer is spawned');
  equal(soloOutcome.secondOpinion.available, false, 'and the absence is recorded honestly');
  equal(soloOutcome.verdict, 'accepted', 'the single verdict stands rather than being invented around');
}

// ---------------------------------------------------------------------------
// 21. Our own restarts must not spend a lane's review budget
// ---------------------------------------------------------------------------
// Live 2026-07-28: six supervisor restarts drove q21-ms5cd6w1z8wd to
// reviewAttempt 3 of 3 without a reviewer ever finishing. One more restart
// would have stalled a lane whose work nobody had judged. A takeover from a
// dead holder is a RECLAIM, counted and capped on its own budget.
function testRestartsDoNotBurnTheReviewBudget() {
  const repoRoot = newRepoRoot('reclaims');
  const stateFile = stateFileIn(repoRoot);
  seedFinishedLane(stateFile, 'r-1', { itemId: 'Q11' });

  for (let i = 0; i < 5; i += 1) {
    const claim = review.claimLaneForReview(stateFile, {
      supervisorId: `sup-${i}`, maxAttempts: 3, maxReclaims: 5, isAlive: () => false
    });
    ok(claim.claimed, `restart ${i} can still claim the lane for review`);
    equal(claim.claimed.reviewAttempt, 1, 'and it is still the SAME judgement attempt, not a new one');
  }
  const lane = stateStore.readState(stateFile).lanes['r-1'];
  equal(lane.review.attempts, 1, 'five supervisor restarts spend one attempt, not five');
  equal(lane.review.reclaims, 4, 'the restarts are counted as reclaims instead');
  ok(lane.review.state !== 'stalled', 'and the lane is still reviewable rather than stalled by our own crashes');

  // Bounded: a lane that keeps killing its reviewer still stops, and says so.
  const stallEvents = [];
  for (let i = 0; i < 4; i += 1) {
    review.claimLaneForReview(stateFile, {
      supervisorId: 'sup-x', maxAttempts: 3, maxReclaims: 5, isAlive: () => false,
      logger: (event, detail) => stallEvents.push({ event, detail })
    });
  }
  const stalledLane = stateStore.readState(stateFile).lanes['r-1'];
  equal(stalledLane.review.state, 'stalled', 'the reclaim budget is finite, so this cannot spin forever');
  const stall = stallEvents.find(entry => entry.event === 'review-stalled');
  ok(stall, 'and hitting the reclaim cap is ANNOUNCED, not silent');
  equal(stall.detail.reason, 'reclaim-cap', 'named as a reclaim cap, never as a judgement of the work');
}

// ---------------------------------------------------------------------------
// 22. Stalling is loud, and a wedged review tier is not disguised as congestion
// ---------------------------------------------------------------------------
// The launch gate blocks on unreviewable output BY DESIGN. The defect was that
// it reported `review-backlog-full` either way, so a permanent stop that no
// amount of reviewing could clear looked exactly like a busy minute -- and the
// transition into it was never logged at all.
function testWedgedReviewTierIsLoudAndDistinct() {
  const repoRoot = newRepoRoot('wedged');
  const stateFile = stateFileIn(repoRoot);
  for (let i = 0; i < 8; i += 1) seedFinishedLane(stateFile, `w-${i}`, { itemId: 'Q11' });

  // Congestion first: everything is drainable, so this is the patient case.
  const congested = claimNext(stateFile, {
    openItemIds: ['Q17'], laneIdFor: () => 'new-lane-a', supervisorId: 'sup-a',
    concurrency: 99, maxAttempts: 99, maxNoProgressAttempts: 99, reviewBacklogThreshold: 8
  });
  equal(congested.reason, 'review-backlog-full', 'a backlog of live lanes reads as congestion');
  equal(congested.drainable, 8, 'and every one of them is still claimable by a reviewer');

  // Now burn every lane's attempts on genuine review failures.
  const stallEvents = [];
  const logger = (event, detail) => stallEvents.push({ event, detail });
  for (let round = 0; round < 4; round += 1) {
    for (;;) {
      const claim = review.claimLaneForReview(stateFile, {
        supervisorId: 'sup-b', maxAttempts: 3, isAlive: () => true, logger
      });
      if (!claim.claimed) break;
      review.releaseReviewClaim(stateFile, claim.claimed.laneId, {
        error: 'reviewer exploded', maxAttempts: 3, logger
      });
    }
  }
  ok(stallEvents.filter(entry => entry.event === 'review-stalled').length >= 8,
    'every lane that stalls says so -- the transition is never silent');

  const state = stateStore.readState(stateFile);
  equal(review.stalledReviewLanes(state).length, 8, 'all eight lanes are stalled');
  equal(review.drainableReviewLanes(state).length, 0, 'and nothing is left for a reviewer to claim');
  equal(review.reviewBacklog(state), 8,
    'they still COUNT against the backlog: unreviewable output must keep blocking launches');

  const wedged = claimNext(stateFile, {
    openItemIds: ['Q17'], laneIdFor: () => 'new-lane-b', supervisorId: 'sup-c',
    concurrency: 99, maxAttempts: 99, maxNoProgressAttempts: 99, reviewBacklogThreshold: 8
  });
  equal(wedged.claimed, null, 'the fleet still refuses to build more unreviewed inventory');
  equal(wedged.reason, 'review-tier-wedged',
    'but the refusal now names a permanent stop instead of implying reviewers are merely busy');
  equal(wedged.drainable, 0, 'and reports that nothing can drain');

  const report = status(stateFile, { reviewBacklogThreshold: 8 });
  equal(report.review.launchGate.reason, 'review-tier-wedged', '--status tells an operator the same truth');
  equal(report.review.drainable, 0, 'and surfaces the drainable count');
  equal(report.review.stalled.length, 8,
    'and --status retains every stalled lane rather than satisfying the row-shape check vacuously');
  ok(report.review.stalled.every(entry => entry.itemId && Number.isInteger(entry.attempts)),
    'each stalled lane is reported with the item and attempt count needed to act on it');
}

// ---------------------------------------------------------------------------
// 23. Review throughput settings, and the reviewer tier that must not drift
// ---------------------------------------------------------------------------
function testReviewThroughputDefaults() {
  ok(review.DEFAULT_REVIEW_CONCURRENCY >= 6,
    'review concurrency is sized to the lane tier it has to keep up with (measured 350s/review)');
  ok(review.DEFAULT_REVIEW_BACKLOG_THRESHOLD > review.DEFAULT_REVIEW_CONCURRENCY,
    'the backlog threshold sits above the concurrency so a freed reviewer slot always has work');
  ok(review.DEFAULT_REVIEW_BACKLOG_THRESHOLD - review.DEFAULT_REVIEW_CONCURRENCY <= 4,
    'but not so far above that idle unreviewed inventory piles up');

  // Owner order R77. Claude and Sol are not reviewers, and there is no
  // fallback that could quietly make them one.
  const preference = review.DEFAULT_REVIEWER_PREFERENCE;
  ok(!preference.includes('claude') && !preference.includes('sol'),
    'the reviewer preference never reaches an expensive tier');
  const exhausted = review.chooseReviewer({
    laneProvider: 'gemini',
    preference: review.DEFAULT_REVIEWER_PREFERENCE,
    repoRoot: newRepoRoot('tier'),
    availabilityImpl: providerId => ({ providerId, available: false, reason: 'executable-not-found' })
  });
  equal(exhausted.providerId, null,
    'with the codex tier exhausted the answer is NO REVIEWER, never an escalation');
  ok(exhausted.checked.length > 0 && exhausted.reason,
    'and the refusal records what was tried and why');
}

async function runAll() {
  await testReviewerOwnsDescendants();
  await testReviewerWaitsForCleanup();
  await testReviewerCannotBeTheLane();
  testRejectedWorkIsPreserved();
  testVerdictRequiresReviewerAndReason();
  await testBacklogThresholdBlocksLaunches();
  await testKillSwitchStopsReviews();
  testPacketCaptureFromRealWorktree();
  await testFabricatedPassingLaneIsRejected();
  await testMissingArtifactIsUnreviewableNotJudged();
  testPromptForcesExecution();
  testReviewClaimingIsSingleHolder();
  await testSupervisorRunsReviewAlongsideLanes();
  await testFabricatingReviewerIsCaught();
  testHarnessCommandSafety();
  testMatcherToleratesNoiseButCatchesInvention();
  await testNonDeterministicCommandIsNotPunished();
  testFailureModesAreTyped();
  testEffectMustBeRealAndNonTrivial();
  await testBelowFloorLaneIsRefused();
  testHistoryCarriesModelAndVerdict();
  await testGradedScoreAndSecondOpinion();
  testRestartsDoNotBurnTheReviewBudget();
  testWedgedReviewTierIsLoudAndDistinct();
  testReviewThroughputDefaults();
}

async function testReviewerOwnsDescendants() {
  if (!['linux', 'win32'].includes(process.platform)) return;
  const { spawnHidden } = require('../src/lib/proc/hidden-spawn');
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const mode of ['success', 'timeout']) {
    const directory = tempDir(`native-lifetime-${mode}`);
    const marker = path.join(directory, 'effects.txt');
    const done = path.join(directory, 'leaf-done.txt');
    const leafFile = path.join(directory, 'leaf.cjs');
    const rootFile = path.join(directory, 'reviewer.cjs');
    // The deadline starts before native ownership, reviewer root, and detached-leaf cold start.
    // Match the proven Windows allowance so Linux observes real descendant lifetime behavior.
    const timeoutMs = 10000;
    const lifetimeMs = mode === 'timeout' ? timeoutMs + 1000 : 1000;
    fs.writeFileSync(leafFile, `const fs=require('node:fs'); const marker=${JSON.stringify(marker)};
      fs.writeFileSync(marker,'started\\n');const timer=setInterval(()=>fs.appendFileSync(marker,'effect\\n'),20);
      setTimeout(()=>{clearInterval(timer);fs.writeFileSync(${JSON.stringify(done)},'done');},${lifetimeMs});`);
    fs.writeFileSync(rootFile, `const fs=require('node:fs'); const {spawn}=require('node:child_process');
      const leaf=spawn(process.execPath,[${JSON.stringify(leafFile)}],{detached:true,stdio:'ignore',windowsHide:true});leaf.unref();
      const ready=setInterval(()=>{if(!fs.existsSync(${JSON.stringify(marker)}))return;clearInterval(ready);
        process.stdout.write('REVIEW-RESULT\\n');process.stderr.write('STDERR-MUST-STAY-SEPARATE\\n');
        ${mode === 'success' ? 'process.exit(0);' : ''}},5);
      setTimeout(()=>process.exit(0),${timeoutMs + 1500});`);
    let child, rootClosed, closed = false;
    try {
      const result = await review.runReviewer({ providerId: 'codex', prompt: 'Isolated native lifetime fixture.', cwd: directory,
        timeoutMs: mode === 'success' ? 20000 : timeoutMs,
        resolveExecutable: () => ({ command: process.execPath, prefixArgs: [rootFile] }),
        parseOutput: (_provider, stdout) => {
          assert.equal(stdout.includes('STDERR-MUST-STAY-SEPARATE'), false, 'stderr is not reviewer JSON');
          return { text: stdout };
        },
        spawnImpl(file, args, options) {
          assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe'], 'keep the reviewer stdin contract');
          child = spawnHidden(file, args, options);
          rootClosed = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
          child.on('error', () => {});
          return child;
        } });
      ok(fs.existsSync(marker), `${mode}: prove a real descendant was running`);
      const atReturn = fs.readFileSync(marker, 'utf8');
      await sleep(180);
      equal(fs.readFileSync(marker, 'utf8'), atReturn, `${mode}: no descendant effects after the reviewer result`);
      equal(result.cleanupConfirmed, true, `${mode}: result requires owned cleanup proof`);
      equal(result.ok, mode === 'success');
      equal(result.code, mode === 'success' ? null : 'TIMEOUT');
      if (mode === 'success') equal(result.text, 'REVIEW-RESULT\n');
      const outcome = await child.jobOutcome;
      equal(outcome.activeProcesses, 0);
      equal((await child.jobClosed).failure, null);
      if (process.platform === 'linux') {
        ok(outcome.observedChildren >= 2, 'observe the actual root and detached descendant');
        equal(outcome.reapedChildren, outcome.observedChildren);
      }
    } finally {
      if (child?.jobOutcome) {
        if (!closed) await child.terminateJob().catch(() => {});
        await child.jobClosed;
      } else if (child) {
        const deadline = Date.now() + timeoutMs + 2000;
        while (!fs.existsSync(done) && Date.now() < deadline) await sleep(20);
        assert.equal(fs.existsSync(done), true, 'baseline detached canary must self-terminate');
        await sleep(80);
        if (!closed) child.kill('SIGTERM');
      }
      if (rootClosed) await rootClosed;
    }
  }
}

async function testReviewerWaitsForCleanup() {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  for (const activeProcesses of [0, 1]) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.terminateJob = async () => child.jobOutcome;
    child.jobOutcome = Promise.resolve({ type: 'exit', exitCode: 7, activeProcesses });
    let closeWrapper;
    child.jobClosed = new Promise(resolve => { closeWrapper = resolve; });
    let parsed = 0, answered = false;
    const pending = review.runReviewer({ providerId: 'codex', prompt: 'Receipt fixture.', cwd: tempDir('reviewer-receipts'),
      resolveExecutable: () => ({ command: process.execPath, prefixArgs: [] }),
      parseOutput: (_provider, output) => { parsed += 1; return { text: output }; },
      spawnImpl: () => child
    }).then(result => { answered = true; return result; });
    child.stdout.write('ROOT-OUTPUT');
    child.emit('close', 0);
    await new Promise(resolve => setImmediate(resolve));
    equal(answered, false, 'root close and empty-scope receipt cannot bypass pending wrapper closure');
    equal(parsed, 0, 'a reviewer cannot publish a verdict before cleanup');
    closeWrapper({ failure: null });
    const result = await pending;
    equal(result.cleanupConfirmed, activeProcesses === 0);
    equal(result.ok, false);
    equal(result.code, activeProcesses === 0 ? 'EXIT_NONZERO' : 'CLEANUP_UNPROVEN');
    equal(parsed, activeProcesses === 0 ? 1 : 0, 'unproven cleanup cannot feed a verdict parser');
    if (activeProcesses === 0) equal(result.exitCode, 7, 'the root status is distinct from wrapper status');
  }
}

runAll()
  .then(() => {
    cleanup();
    console.log(`fleet-supervisor review tests passed (${checks} checks).`);
  })
  .catch(error => {
    cleanup();
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
