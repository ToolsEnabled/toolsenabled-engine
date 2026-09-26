#!/usr/bin/env node
'use strict';

// ADAPTER, NOT A CHECKER. All boundary logic lives in tools/lane-territory-check.js
// (merge-base diff, glob/prefix admission, the docs/coordinator carve-out). This
// file exists for one reason: that checker requires --worktree, --territory and
// --base, and nothing on this machine ever supplied them.
//
// WHY THAT MATTERED. lane-territory-check.js exits 1 correctly on an
// out-of-territory change. Measured 2026-08-09: ZERO automated invokers. Its
// only reference outside its own source was tests/lane-territory-check.test.js,
// reached through tests/surface.registry/run.js -- i.e. `npm run
// test:surface.registry`, which is itself in package.json and called by nothing.
// A correct merge gate that no merge runs is a comment.
//
// The declared territory was never missing -- it was already on disk, in
// state/agent-launch/<agentId>.json, which src/lib/agent-lane.js writes at lane
// launch with both `territory` and `worktree` fields. Measured: 62 of 65 records
// carry a territory, across 47 distinct worktrees. So this adapter reads what is
// already recorded rather than asking anyone to retype it -- the point being
// that a gate you must hand-feed arguments to is a gate that does not run.
//
// EXIT CODES mirror tools/check-single-copy-work.js on purpose, so callers do
// not have to learn a second vocabulary for the same three ideas:
//   0 CLEAN or NOT_APPLICABLE -- checked, or there is provably nothing to check
//   1 VIOLATION              -- checked, and the lane changed files it does not own
//   2 INDETERMINATE          -- could not form a trustworthy opinion
// Deciding what BLOCKS is the caller's job, not this file's. .githooks/pre-push
// blocks on 1 only; see the reasoning there.
//
// ATTRIBUTION. A worktree PATH is not a lane identity. A directory gets reused
// across separate lane launches over the life of a session -- measured: 65
// launch records across only 47 distinct worktrees, so at least 18 worktrees
// already carry more than one record. Every record whose `worktree` field
// names this directory is proof someone was launched there at some point;
// none of them alone is proof of who is pushing right now. This adapter used
// to break that tie by picking whichever record file had the newest mtime,
// which is a filesystem artifact, not a fact about the push -- a heartbeat
// touch, a restore, or an unrelated write can leave a long-finished lane's
// record looking newer than the one actually pushing. On a real push that
// picked state/agent-launch/r1180-fable5-planner.json for a session that was
// not that lane, and every path the ACTUAL pusher owned outside that record's
// (different, narrower) territory came back as a false violation.
//
// The fix is to prefer a live fact over a filesystem timestamp: the presence
// roster (src/lib/agent-presence.js) records which agentId is confirmed alive
// right now (recent heartbeat, live PID) rather than merely launched at some
// point. `resolvePusher` below trusts a launch record only when exactly one
// candidate for this worktree is confirmed live. When zero or more than one
// candidate is live, it refuses to select a historical launch record. Even a
// sole record proves only that an agent used this worktree in the past, not
// that the agent is the process pushing now. It reports INDETERMINATE with the
// candidates named: a confident wrong attribution is worse than an honest
// "cannot tell which lane this is".
//
// MEASURED 2026-08-10 ON THIS WORKTREE. The INDETERMINATE-on-every-push
// symptom is not a stopped writer and not an expiry gap. state/agent-launch/
// has exactly 7 records naming this worktree; every one of them has a
// presence entry, and every one of those is honestly TERMINAL (finished or
// failed, last activity 2026-08-06..08) -- the presence roster is doing its
// job correctly, it is just reporting that none of the actors it knows about
// are the one pushing right now. The real gap is upstream of presence: the
// only code path that ever writes a state/agent-launch/<agentId>.json file
// is src/lib/agent-lane.js's runLane(), used for coordinator-spawned
// codex/claude-CLI child lanes. A Claude Code session running directly in
// this worktree (owner-launched, or a Task-tool subagent of one -- the shape
// this exact session is) never goes through that path, so it never gets a
// launch record, no matter how long it runs or how narrow a territory it
// declares. That is the "declared state is not live presence" trap the
// project's own docs warn about, made concrete: declared state
// (state/agent-launch/*.json) and live presence (state/agent-presence.json)
// are two stores fed by two different writers, and nothing here ever asked
// presence for an answer when declared state had nothing live to offer.
//
// R1186 already built the missing writer for this exact case --
// tools/claude-session-register.js self-registers an owner-launched Claude
// session directly into presence (with its own `worktree` and `territory`)
// and detaches a heartbeat sidecar to keep it live -- but presence-only
// registration was never wired into THIS gate's attribution: resolvePusher
// only ever asked "is presence live for one of the launch-record
// candidates?", never "is there a live presence record naming this worktree
// on its own?". `resolvePusher` now also scans the presence roster directly
// for live records that name this worktree and carry a territory, whether or
// not a matching launch-record file exists. This closes the actual gap
// (self-registered sessions can now resolve CLEAN/VIOLATION like any other
// lane) without touching the launch-record side at all: nothing here reaps
// or trusts an unconfirmed record any more loosely than before, and a
// genuine collision (two live candidates, from either store, naming the same
// worktree) still refuses to guess.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const laneScope = require('../src/lib/lane-scope');
const presence = require('../src/lib/agent-presence');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

const EXIT_CODES = Object.freeze({ CLEAN: 0, VIOLATION: 1, INDETERMINATE: 2 });
const CHECKER = path.join(__dirname, 'lane-territory-check.js');
const GIT_TIMEOUT_MS = 20_000;
const CHECK_TIMEOUT_MS = 60_000;
const MAX_RECORD_BYTES = 64 * 1024;
// A launch record is trusted as "the pusher" only when the live presence
// roster confirms an agent with this status is actually running right now.
// 'stale', 'process-gone', 'heartbeat-fault', 'finished' and 'failed' are all
// deliberately excluded -- a lane that is not provably alive is not provably
// the one pushing.
const LIVE_PRESENCE_STATUSES = new Set(['starting', 'running']);

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: safeLaunchEnvironment(process.env, { context: 'lane-territory-gate git' })
  }).trim();
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = value => {
    const resolved = path.resolve(String(value)).replace(/\\/g, '/');
    // Windows path lookup is normally case-insensitive; POSIX path lookup is
    // case-sensitive. Applying the Windows comparison everywhere can assign a
    // lane to a distinct sibling worktree whose name differs only by case.
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

// A territory entry is enforceable only if it actually denotes a path. Several
// live records declare a prose label instead -- "canonical:gate-claude-tier",
// "ui-verification-and-isolated-evidence-only", "retired-tree-telegram". Those
// parse fine as strings but admit() would match nothing, so EVERY changed file
// would read as a violation.
//
// That false-positive flood is the specific way this gate would die: a check
// that screams on correct work gets switched off within a day, and then the real
// violations it would have caught go unseen too. So a label is reported as
// INDETERMINATE -- an honest "not enforceable", never a fabricated violation.
function looksLikePath(entry) {
  return entry.includes('/') || /\.[A-Za-z0-9]+$/.test(entry);
}

function resolveBase(worktree, requested) {
  if (requested) return requested;
  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      git(worktree, ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      return candidate;
    } catch { /* try the next candidate */ }
  }
  return null;
}

function readLaunchRecords(launchDir) {
  let entries;
  try {
    entries = fs.readdirSync(launchDir).filter(name => name.endsWith('.json'));
  } catch (error) {
    return { error: `launch directory unreadable (${launchDir}): ${error.code || error.message}`, records: [] };
  }
  const records = [];
  for (const name of entries) {
    const file = path.join(launchDir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        records.push({ file, mtimeMs: stat.mtimeMs, record: parsed });
      }
    } catch { /* a single malformed record must not blind the gate to the rest */ }
  }
  return { error: null, records };
}

function describeCandidate({ file, record, presenceStatus }) {
  const described = {
    file: path.basename(file),
    agentId: (record && typeof record.agentId === 'string' && record.agentId) || null,
    lane: (record && typeof record.lane === 'string' && record.lane) || null
  };
  if (presenceStatus !== undefined) described.presenceStatus = presenceStatus;
  return described;
}

// A synthetic "launch record" shape for a presence-only candidate, so every
// downstream reader (main(), describeCandidate) can keep treating every
// candidate as a uniform { file, record } pair regardless of which store
// supplied it. `record` here IS the live presence record: it already carries
// agentId/lane/territory/worktree with the exact same meaning a launch
// record's fields have (src/lib/agent-presence.js normalizeRecord requires
// all four), so no field mapping is needed.
function presenceCandidate(presenceRecord) {
  return { file: `presence:${presenceRecord.agentId}`, record: presenceRecord, presenceOnly: true };
}

// Which of the launch records naming this worktree, if any, is trustworthy as
// "the lane currently pushing"? See the ATTRIBUTION header comment for why a
// worktree-path match alone (the only thing a launch record ever proves) is
// not enough on its own, and for why presence is now also consulted directly
// instead of only as a corroboration source for a launch-record candidate.
function resolvePusher(matches, worktree, deps = {}) {
  const presenceApi = deps.presence || presence;
  let registry = null;
  let presenceError = null;
  try {
    registry = presenceApi.readRegistry(deps.presenceFile);
  } catch (error) {
    presenceError = String((error && error.message) || error).slice(0, 200);
  }

  const isLive = presenceRecord => {
    if (!presenceRecord || !samePath(presenceRecord.worktree, worktree)) return false;
    let liveness;
    try { liveness = presenceApi.deriveLiveness(presenceRecord, deps.livenessOptions); }
    catch { return false; }
    return LIVE_PRESENCE_STATUSES.has(liveness);
  };

  const liveFromMatches = registry
    ? matches.filter(({ record }) => {
      const agentId = record && record.agentId;
      if (typeof agentId !== 'string' || !agentId) return false;
      return isLive(registry.agents[agentId]);
    })
    : [];

  // A live presence record naming this worktree directly closes the
  // declared-state/live-presence gap for a session that was never given a
  // launch-record file at all (see the header comment). Agent ids already
  // represented in `matches` are excluded here regardless of their liveness:
  // if presence considers them live, isLive() already put them in
  // liveFromMatches above, and counting them twice would manufacture a false
  // "two lanes are live" collision out of one live agent.
  const matchedAgentIds = new Set(matches.map(({ record }) => record && record.agentId).filter(Boolean));
  const liveFromPresenceOnly = registry
    ? Object.values(registry.agents)
      .filter(presenceRecord => !matchedAgentIds.has(presenceRecord.agentId) && isLive(presenceRecord))
      .map(presenceCandidate)
    : [];

  const live = [...liveFromMatches, ...liveFromPresenceOnly];

  if (live.length === 1) {
    const method = live[0].presenceOnly ? 'live-presence-self-registered' : 'live-presence';
    return { status: 'RESOLVED', method, chosen: live[0] };
  }
  if (live.length > 1) {
    return {
      status: 'INDETERMINATE',
      candidates: live.map(describeCandidate),
      reason: `${live.length} lanes are simultaneously live in ${worktree} (a shared checkout); cannot tell which one is pushing`
    };
  }
  // No candidate is confirmed live. Launch records are historical: even a
  // sole match proves who was launched here, not who is pushing now. Refuse
  // to attribute the push to a departed or otherwise unconfirmed agent.
  if (matches.length === 0) {
    // Neither store has anything to say about this worktree: not every
    // worktree is a scoped lane, and inventing one here would be a guess.
    return { status: 'NOT_APPLICABLE' };
  }
  const describeMatch = ({ file, record }) => {
    const agentId = record && record.agentId;
    const presenceRecord = registry && typeof agentId === 'string' ? registry.agents[agentId] : null;
    return describeCandidate({
      file, record,
      presenceStatus: presenceRecord ? presenceRecord.status : (registry ? 'not-in-roster' : 'roster-unreadable')
    });
  };
  const rosterNote = presenceError
    ? `the live presence roster could not be read (${presenceError})`
    : `none of them is confirmed live in the presence roster (${matches.map(({ record }) => {
      const presenceRecord = registry && typeof record.agentId === 'string' ? registry.agents[record.agentId] : null;
      return `${record.agentId || '?'}: ${presenceRecord ? presenceRecord.status : 'not in roster'}`;
    }).join(', ')}), and no other live presence record names this worktree either`;
  return {
    status: 'INDETERMINATE',
    candidates: matches.map(describeMatch),
    presenceRosterUpdatedAt: registry ? registry.updatedAt : null,
    reason: `${matches.length} launch records name ${worktree} and ${rosterNote}; cannot determine which lane is pushing without guessing`
  };
}

// Validate both halves of the checker contract together. execFileSync exposes
// the producer's exit status separately from stdout; accepting either one in
// isolation lets a failed checker masquerade as CLEAN with a parseable last
// line. Only the two documented result shapes are authoritative.
function checkerContractError(parsed, checkerExit) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'payload is not a JSON object';
  }
  if (!Array.isArray(parsed.violations)) {
    return 'payload has no violations array';
  }
  const isClean = checkerExit === 0
    && parsed.ok === true
    && parsed.code === 'LANE_TERRITORY_CLEAN'
    && parsed.violations.length === 0;
  const isViolation = checkerExit === 1
    && parsed.ok === false
    && parsed.code === 'LANE_TERRITORY_VIOLATION'
    && parsed.violations.length > 0;
  if (isClean || isViolation) return null;
  return `exit ${checkerExit}, ok ${JSON.stringify(parsed.ok)}, code ${JSON.stringify(parsed.code)}, violations ${parsed.violations.length}`;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const baseIndex = argv.indexOf('--base');
  const requestedBase = baseIndex >= 0 ? argv[baseIndex + 1] : null;
  const worktreeIndex = argv.indexOf('--worktree');

  const emit = result => {
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`lane-territory-gate: ${result.status} -- ${result.reason}\n`);
      for (const violation of result.violations || []) process.stdout.write(`  - ${violation}\n`);
    }
    process.exitCode = result.exitCode;
  };

  let worktree;
  try {
    worktree = worktreeIndex >= 0
      ? path.resolve(argv[worktreeIndex + 1])
      : git(process.cwd(), ['rev-parse', '--show-toplevel']);
  } catch (error) {
    return emit({
      status: 'INDETERMINATE', exitCode: EXIT_CODES.INDETERMINATE,
      reason: `not a git worktree: ${String(error.message).slice(0, 160)}`
    });
  }

  // Launch records are written into the MAIN worktree's state directory. A
  // linked worktree has its own checked-out copy of state/ which can be stale,
  // so resolve the main tree from --git-common-dir rather than trusting cwd.
  let launchDir = process.env.TOOLSENABLED_AGENT_LAUNCH_DIR;
  if (!launchDir) {
    try {
      const commonDir = path.resolve(worktree, git(worktree, ['rev-parse', '--git-common-dir']));
      launchDir = path.join(path.dirname(commonDir), 'state', 'agent-launch');
    } catch {
      launchDir = path.join(worktree, 'state', 'agent-launch');
    }
  }

  const { error: readError, records } = readLaunchRecords(launchDir);
  if (readError) {
    return emit({ status: 'INDETERMINATE', exitCode: EXIT_CODES.INDETERMINATE, reason: readError });
  }

  const matches = records.filter(entry => samePath(entry.record.worktree, worktree));

  // A worktree path names a DIRECTORY, not a lane. When more than one launch
  // record (or live presence record -- see resolvePusher) claims it, do not
  // guess which one is pushing. resolvePusher is always consulted, even with
  // zero launch-record matches, because a live presence-only registration
  // (tools/claude-session-register.js) can resolve a pusher on its own with
  // no launch-record file involved at all.
  const attribution = resolvePusher(matches, worktree);
  if (attribution.status === 'NOT_APPLICABLE') {
    // Not every worktree is a scoped lane. Say so plainly and pass: inventing a
    // territory for an unregistered worktree would block ordinary work.
    return emit({
      status: 'NOT_APPLICABLE', exitCode: EXIT_CODES.CLEAN, worktree,
      reason: `no launch record in ${launchDir} declares this worktree, and no live presence record does either, so no territory is being enforced`
    });
  }
  if (attribution.status === 'INDETERMINATE') {
    return emit({
      status: 'INDETERMINATE', exitCode: EXIT_CODES.INDETERMINATE, worktree,
      candidates: attribution.candidates,
      presenceRosterUpdatedAt: attribution.presenceRosterUpdatedAt,
      reason: attribution.reason
    });
  }

  const { file: recordFile, record } = attribution.chosen;
  const attributedBy = attribution.method;
  const rawTerritory = typeof record.territory === 'string' ? record.territory : '';
  if (!rawTerritory.trim()) {
    return emit({
      status: 'INDETERMINATE', exitCode: EXIT_CODES.INDETERMINATE, worktree, recordFile, attributedBy,
      reason: 'the launch record declares no territory'
    });
  }

  let territory;
  try {
    territory = laneScope.parseTerritory(rawTerritory);
  } catch (error) {
    return emit({
      status: 'INDETERMINATE', exitCode: EXIT_CODES.INDETERMINATE, worktree, recordFile, attributedBy,
      reason: `declared territory did not parse: ${String(error.message).slice(0, 200)}`
    });
  }

  const enforceable = territory.filter(looksLikePath);
  if (!enforceable.length) {
    return emit({
      status: 'INDETERMINATE', exitCode: EXIT_CODES.INDETERMINATE, worktree, recordFile, attributedBy,
      territory,
      reason: `declared territory is a label, not a path list (${JSON.stringify(territory).slice(0, 160)}); nothing to enforce without fabricating violations`
    });
  }

  const base = resolveBase(worktree, requestedBase);
  if (!base) {
    return emit({
      status: 'INDETERMINATE', exitCode: EXIT_CODES.INDETERMINATE, worktree, recordFile, attributedBy,
      reason: 'no usable diff base (tried origin/main, main, origin/master, master)'
    });
  }

  let raw;
  let checkerExit = 0;
  try {
    raw = execFileSync(process.execPath, [
      CHECKER, '--worktree', worktree, '--territory', enforceable.join(';'), '--base', base
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: CHECK_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: safeLaunchEnvironment(process.env, { context: 'lane-territory-gate checker' })
    });
  } catch (error) {
    // execFileSync throws on a non-zero exit; exit 1 IS the checker's violation
    // signal, so a throw is not automatically a failure to run.
    raw = String(error.stdout || '');
    checkerExit = Number.isInteger(error.status) ? error.status : 2;
    if (!raw) {
      return emit({
        status: 'INDETERMINATE', exitCode: EXIT_CODES.INDETERMINATE, worktree, recordFile, attributedBy, base,
        reason: `lane-territory-check produced no output (status ${checkerExit}): ${String(error.message).slice(0, 200)}`
      });
    }
  }

  let parsed;
  try {
    parsed = JSON.parse(raw.trim().split('\n').filter(Boolean).pop());
  } catch {
    return emit({
      status: 'INDETERMINATE', exitCode: EXIT_CODES.INDETERMINATE, worktree, recordFile, attributedBy, base,
      reason: `lane-territory-check did not return its JSON contract: ${raw.slice(0, 200)}`
    });
  }

  const contractError = checkerContractError(parsed, checkerExit);
  if (contractError) {
    return emit({
      status: 'INDETERMINATE', exitCode: EXIT_CODES.INDETERMINATE, worktree, recordFile, attributedBy, base,
      reason: `lane-territory-check returned an inconsistent contract (${contractError})${parsed.message ? `: ${parsed.message}` : ''}`
    });
  }

  if (parsed.violations && parsed.violations.length) {
    return emit({
      status: 'VIOLATION', exitCode: EXIT_CODES.VIOLATION, worktree, recordFile, attributedBy,
      base, mergeBase: parsed.mergeBase, agentId: record.agentId, lane: record.lane,
      territory: enforceable, violations: parsed.violations,
      reason: `${parsed.violations.length} changed path(s) outside the territory declared in ${path.basename(recordFile)} (attributed to this lane via ${attributedBy})`
    });
  }

  return emit({
    status: 'CLEAN', exitCode: EXIT_CODES.CLEAN, worktree, recordFile, attributedBy,
    base, mergeBase: parsed.mergeBase, agentId: record.agentId, lane: record.lane,
    territory: enforceable,
    reason: `all ${parsed.changedCount} changed path(s) fall inside the declared territory`
  });
}

module.exports = { EXIT_CODES, looksLikePath, samePath, resolvePusher, describeCandidate, checkerContractError, LIVE_PRESENCE_STATUSES };

if (require.main === module) main();
