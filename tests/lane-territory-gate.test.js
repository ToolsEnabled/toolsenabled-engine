'use strict';

// R1162 territory gate ATTRIBUTION. tools/lane-territory-gate.js resolves a
// worktree PATH to a launch record's declared territory -- but a directory
// gets reused across separate lane launches over a session, so more than one
// launch record can legitimately name the same worktree. On a real push the
// gate picked whichever record file had the newest mtime and attributed a
// different lane's (narrower) territory to the actual pusher, producing false
// violations out of that other lane's in-flight files. This suite proves the
// fix: liveness from the presence roster (src/lib/agent-presence.js) breaks
// the tie when it can, and the gate reports INDETERMINATE -- never a guess --
// when it cannot.

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GATE = path.join(__dirname, '..', 'tools', 'lane-territory-gate.js');
const { checkerContractError } = require(GATE);

function git(cwd, args) {
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
}

function write(root, relative, content) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function runGate(worktree, launchDir, presenceFile) {
  const result = spawnSync(process.execPath, [GATE, '--worktree', worktree, '--base', 'trunk', '--json'], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      TOOLSENABLED_AGENT_LAUNCH_DIR: launchDir,
      TOOLSENABLED_AGENT_PRESENCE_FILE: presenceFile
    }
  });
  return { status: result.status, output: JSON.parse(result.stdout) };
}

// Only the fields lane-territory-gate.js actually reads matter for the
// launch-record fixtures: worktree, territory, agentId, lane.
function launchRecord(overrides = {}) {
  return {
    schemaVersion: 1,
    agentId: 'lane-a',
    lane: 'lane-a',
    territory: 'src/lib',
    worktree: '',
    ...overrides
  };
}

// A full presence record must satisfy src/lib/agent-presence.js's
// normalizeRecord -- reused here, not reinvented, so this fixture breaks the
// same way production data would if the schema ever changes underneath it.
function presenceRecord(overrides = {}) {
  return {
    agentId: 'lane-a',
    runId: '0123456789abcdef0123456789abcdef',
    recordRevision: 1,
    kind: 'claude',
    role: 'builder',
    tier: 'claude/sonnet',
    reportsTo: null,
    dispatcher: 'owner',
    lane: 'lane-a',
    territory: 'src/lib',
    currentTask: null,
    brief: 'brief',
    consoleLog: 'logs/lane-consoles/lane-a.log',
    worktree: '',
    launchSpec: 'state/agent-launch/lane-a.json',
    pid: null,
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
    status: 'running',
    exitCode: null,
    lastVerdict: null,
    terminalAt: null,
    staleReason: null,
    usefulProgressSeq: 0,
    lastUsefulProgressAt: null,
    lastUsefulProgressKind: null,
    mailboxOffset: 0,
    respawnCount: 0,
    verdictConsumedAt: null,
    ...overrides
  };
}

function writePresenceFile(file, records) {
  const agents = {};
  for (const record of records) agents[record.agentId] = record;
  writeJson(file, { schemaVersion: 1, revision: 1, updatedAt: Date.now(), agents });
}

let assertions = 0;
function check(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
}

// The git repo and the state directory are DELIBERATELY separate temp roots.
// Putting state/ inside the repo would let `git add .` sweep the launch and
// presence fixtures into the very commits the gate is diffing, which is a
// self-inflicted territory violation that has nothing to do with what this
// suite is testing.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-territory-gate-'));
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-territory-gate-state-'));
const launchDir = path.join(stateRoot, 'agent-launch');
const presenceFile = path.join(stateRoot, 'agent-presence.json');
try {
  git(root, ['init', '-q', '-b', 'trunk']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'territory-gate-test']);
  write(root, 'src/lib/inside.js', 'module.exports = 1;\n');
  write(root, 'src/other/outside.js', 'module.exports = 2;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'base']);
  git(root, ['checkout', '-q', '-b', 'lane']);

  // --- No launch record names this worktree: pass without inventing a scope. ---
  fs.mkdirSync(launchDir, { recursive: true });
  const notApplicable = runGate(root, launchDir, presenceFile);
  check(notApplicable.status === 0, 'no matching launch record exits 0');
  check(notApplicable.output.status === 'NOT_APPLICABLE', 'reports NOT_APPLICABLE with nothing to enforce');

  // --- Exactly one stale launch record names this worktree: historical state
  // is not proof that the departed lane is the process pushing now. ---
  writeJson(path.join(launchDir, 'lane-a.json'), launchRecord({ worktree: root, territory: 'src/lib' }));
  writePresenceFile(presenceFile, [
    presenceRecord({ worktree: root, status: 'finished', terminalAt: Date.now(), lastHeartbeat: Date.now() - 999_999 })
  ]);
  write(root, 'src/lib/inside.js', 'module.exports = 11;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'lane-a in-territory work']);

  const sole = runGate(root, launchDir, presenceFile);
  check(sole.status === 2, 'sole stale launch record exits 2 (INDETERMINATE)');
  check(sole.output.status === 'INDETERMINATE', 'sole stale launch record is not trusted as the current pusher');
  check(sole.output.candidates[0].presenceStatus === 'finished', 'the stale candidate reports its terminal presence status');

  // --- Two launch records now name this worktree (a reused/shared checkout) and
  // neither is confirmed live: refuse to guess rather than pick one. ---
  writeJson(path.join(launchDir, 'lane-b.json'), launchRecord({ agentId: 'lane-b', lane: 'lane-b', worktree: root, territory: 'src/other' }));
  const ambiguous = runGate(root, launchDir, presenceFile);
  check(ambiguous.status === 2, 'two unconfirmed candidates for the same worktree exits 2 (INDETERMINATE)');
  check(ambiguous.output.status === 'INDETERMINATE', 'reports INDETERMINATE rather than picking one');
  check(Array.isArray(ambiguous.output.candidates) && ambiguous.output.candidates.length === 2,
    'both candidates are named, not silently dropped');
  check(ambiguous.output.candidates.some(c => c.agentId === 'lane-a') && ambiguous.output.candidates.some(c => c.agentId === 'lane-b'),
    'both agent ids appear among the candidates');

  // --- REGRESSION: lane-b's launch record is now the one with the newer mtime
  // (rewritten most recently), which is exactly what made the old mtime-sort
  // pick the wrong lane on the real push this fixes. The live presence roster
  // says lane-a is the one actually running; lane-b already finished. The gate
  // must attribute to lane-a, not to whichever file was touched last. ---
  writeJson(path.join(launchDir, 'lane-b.json'), launchRecord({ agentId: 'lane-b', lane: 'lane-b', worktree: root, territory: 'src/other' }));
  writePresenceFile(presenceFile, [
    presenceRecord({ agentId: 'lane-a', lane: 'lane-a', territory: 'src/lib', worktree: root, status: 'running', lastHeartbeat: Date.now() }),
    presenceRecord({ agentId: 'lane-b', lane: 'lane-b', territory: 'src/other', worktree: root, status: 'finished', lastHeartbeat: Date.now() - 999_999 })
  ]);
  const disambiguated = runGate(root, launchDir, presenceFile);
  check(disambiguated.status === 0, 'live presence resolves the ambiguity in favor of the in-territory lane: exits 0');
  check(disambiguated.output.status === 'CLEAN', 'resolves CLEAN using the LIVE lane (lane-a), not the newer-mtime file (lane-b)');
  check(disambiguated.output.attributedBy === 'live-presence', 'attribution method is live-presence when the roster disambiguates');
  check(disambiguated.output.agentId === 'lane-a', 'the live agent (lane-a) is the one attributed, not lane-b');

  // --- A stale competing launch record (lane-b) must not resurface a false
  // violation once the live lane keeps working inside its OWN territory. ---
  write(root, 'src/lib/another.js', 'module.exports = 3;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'more in-territory work from the live lane']);
  const liveClean = runGate(root, launchDir, presenceFile);
  check(liveClean.status === 0, 'further in-territory work from the confirmed-live lane: exits 0');
  check(liveClean.output.status === 'CLEAN',
    'reports CLEAN for the live lane; the unconfirmed lane-b record never gets a chance to misattribute');

  // --- Both candidates confirmed live at once (a genuinely concurrent shared
  // checkout): still refuse to pick, because either pick could be wrong. ---
  writePresenceFile(presenceFile, [
    presenceRecord({ agentId: 'lane-a', lane: 'lane-a', territory: 'src/lib', worktree: root, status: 'running', lastHeartbeat: Date.now() }),
    presenceRecord({ agentId: 'lane-b', lane: 'lane-b', territory: 'src/other', worktree: root, status: 'running', lastHeartbeat: Date.now() })
  ]);
  const bothLive = runGate(root, launchDir, presenceFile);
  check(bothLive.status === 2, 'two simultaneously live lanes in the same worktree exits 2 (INDETERMINATE)');
  check(bothLive.output.status === 'INDETERMINATE', 'refuses to pick between two simultaneously live lanes');
  check(/simultaneously live/.test(bothLive.output.reason), 'reason names the shared-checkout ambiguity');

  // --- PRESENCE-ONLY RESOLUTION (2026-08-10 fix). Measured root cause of the
  // INDETERMINATE-on-every-push symptom: the only writer of
  // state/agent-launch/<agentId>.json is src/lib/agent-lane.js's runLane(),
  // used for coordinator-spawned codex/claude-CLI child lanes. An
  // owner-launched Claude session (or a Task-tool subagent of one) never goes
  // through that path, so it never gets a launch-record file no matter how
  // long it runs -- it can only ever appear in presence, via
  // tools/claude-session-register.js (R1186). Before this fix, resolvePusher
  // only ever asked presence to corroborate a launch-record candidate, so a
  // worktree with zero live launch records and one genuinely live
  // self-registered session still reported INDETERMINATE forever. This uses
  // its own fixture roots so it cannot be confused by lane-a/lane-b's launch
  // records above, which persist in `launchDir` for the rest of this file.
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-territory-gate-presence-'));
  const stateRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-territory-gate-presence-state-'));
  const launchDir2 = path.join(stateRoot2, 'agent-launch');
  const presenceFile2 = path.join(stateRoot2, 'agent-presence.json');
  try {
    git(root2, ['init', '-q', '-b', 'trunk']);
    git(root2, ['config', 'user.email', 'test@example.invalid']);
    git(root2, ['config', 'user.name', 'territory-gate-test']);
    write(root2, 'src/lib/inside.js', 'module.exports = 1;\n');
    write(root2, 'src/other/outside.js', 'module.exports = 2;\n');
    git(root2, ['add', '.']);
    git(root2, ['commit', '-q', '-m', 'base']);
    git(root2, ['checkout', '-q', '-b', 'lane']);
    fs.mkdirSync(launchDir2, { recursive: true });

    // Neither store declares this worktree at all: still NOT_APPLICABLE, not
    // a guess. Unchanged behavior -- proves the fix did not turn "nothing to
    // enforce" into a fabricated attribution.
    const nothingDeclared = runGate(root2, launchDir2, presenceFile2);
    check(nothingDeclared.status === 0, 'no launch record and no presence record: exits 0');
    check(nothingDeclared.output.status === 'NOT_APPLICABLE', 'reports NOT_APPLICABLE when neither store declares this worktree');

    // A single live presence record naming this worktree, with NO matching
    // launch-record file anywhere, resolves the pusher directly from
    // presence -- this is the actual fix.
    writePresenceFile(presenceFile2, [
      presenceRecord({ agentId: 'self-a', lane: 'self-a', territory: 'src/lib', worktree: root2, status: 'running', lastHeartbeat: Date.now() })
    ]);
    write(root2, 'src/lib/inside.js', 'module.exports = 11;\n');
    git(root2, ['add', '.']);
    git(root2, ['commit', '-q', '-m', 'self-a in-territory work']);
    const presenceOnly = runGate(root2, launchDir2, presenceFile2);
    check(presenceOnly.status === 0, 'sole live presence record, in-territory work: exits 0');
    check(presenceOnly.output.status === 'CLEAN', 'sole live presence record resolves CLEAN with no launch-record file at all');
    check(presenceOnly.output.attributedBy === 'live-presence-self-registered', 'attribution method names presence-only resolution');
    check(presenceOnly.output.agentId === 'self-a', 'the live presence agent is the one attributed');

    // PROOF THE GATE STILL REFUSES #1: the same presence-only lane straying
    // outside its declared territory is still a real VIOLATION, not a silent
    // pass -- the new resolution path does not weaken enforcement.
    write(root2, 'src/other/outside.js', 'module.exports = 22;\n');
    git(root2, ['add', '.']);
    git(root2, ['commit', '-q', '-m', 'self-a strays out of territory']);
    const presenceOnlyViolation = runGate(root2, launchDir2, presenceFile2);
    check(presenceOnlyViolation.status === 1, 'presence-only lane straying out of territory exits 1 (VIOLATION)');
    check(presenceOnlyViolation.output.status === 'VIOLATION', 'reports VIOLATION for the presence-only lane, not a silent pass');

    // PROOF THE GATE STILL REFUSES #2: two live presence-only records naming
    // the same worktree (no launch-record file for either) still collide.
    writePresenceFile(presenceFile2, [
      presenceRecord({ agentId: 'self-a', lane: 'self-a', territory: 'src/lib', worktree: root2, status: 'running', lastHeartbeat: Date.now() }),
      presenceRecord({ agentId: 'self-b', lane: 'self-b', territory: 'src/other', worktree: root2, status: 'running', lastHeartbeat: Date.now() })
    ]);
    const presenceOnlyCollision = runGate(root2, launchDir2, presenceFile2);
    check(presenceOnlyCollision.status === 2, 'two live presence-only lanes collide: exits 2 (INDETERMINATE)');
    check(presenceOnlyCollision.output.status === 'INDETERMINATE', 'refuses to pick between two presence-only lanes');
    check(/simultaneously live/.test(presenceOnlyCollision.output.reason), 'reason names the shared-checkout ambiguity for presence-only lanes too');

    // PROOF THE GATE STILL REFUSES #3: a live launch-record lane and a
    // separate live presence-only lane (different agents, same worktree)
    // collide too -- proves the union of the two sources is checked for
    // ambiguity, not just each source in isolation.
    writeJson(path.join(launchDir2, 'lane-x.json'), launchRecord({ agentId: 'lane-x', lane: 'lane-x', worktree: root2, territory: 'src/lib' }));
    writePresenceFile(presenceFile2, [
      presenceRecord({ agentId: 'lane-x', lane: 'lane-x', territory: 'src/lib', worktree: root2, status: 'running', lastHeartbeat: Date.now() }),
      presenceRecord({ agentId: 'self-c', lane: 'self-c', territory: 'src/other', worktree: root2, status: 'running', lastHeartbeat: Date.now() })
    ]);
    const mixedCollision = runGate(root2, launchDir2, presenceFile2);
    check(mixedCollision.status === 2, 'a live launch-record lane plus a live presence-only lane collide: exits 2 (INDETERMINATE)');
    check(mixedCollision.output.status === 'INDETERMINATE', 'refuses to pick between a launch-record lane and a presence-only lane');
    check(mixedCollision.output.candidates.some(c => c.agentId === 'lane-x') && mixedCollision.output.candidates.some(c => c.agentId === 'self-c'),
      'both the launch-record lane and the presence-only lane are named among the candidates');
  } finally {
    fs.rmSync(root2, { recursive: true, force: true, maxRetries: 8 });
    fs.rmSync(stateRoot2, { recursive: true, force: true, maxRetries: 8 });
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8 });
  fs.rmSync(stateRoot, { recursive: true, force: true, maxRetries: 8 });
}

// The checker exit status and JSON payload form one contract. A parseable last
// line must not erase a producer failure or an incomplete payload.
check(checkerContractError({ ok: true, code: 'LANE_TERRITORY_CLEAN', violations: [] }, 0) === null,
  'accepts a consistent CLEAN checker contract');
check(checkerContractError({ ok: false, code: 'LANE_TERRITORY_VIOLATION', violations: ['M outside.js'] }, 1) === null,
  'accepts a consistent VIOLATION checker contract');
check(/exit 1/.test(checkerContractError({ ok: true, code: 'LANE_TERRITORY_CLEAN', violations: [] }, 1)),
  'rejects CLEAN JSON emitted by a failed checker');
check(/ok undefined/.test(checkerContractError({ code: 'LANE_TERRITORY_CLEAN', violations: [] }, 0)),
  'rejects a checker payload that omits ok');
check(/no violations array/.test(checkerContractError({ ok: true, code: 'LANE_TERRITORY_CLEAN' }, 0)),
  'rejects a checker payload that omits violations');

console.log(`lane territory gate: ${assertions} assertions passed`);
