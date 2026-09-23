#!/usr/bin/env node
'use strict';

// THE MISSING HALF OF COLLISION PREVENTION: a territory claim a HARNESS agent
// can make.
//
// WHAT WAS ALREADY BUILT. tools/lane-territory-check.js decides whether a set
// of changed paths falls inside a declared territory, and
// tools/lane-territory-gate.js feeds it the territory recorded at lane launch,
// from .githooks/pre-push. That machinery is correct and installed.
//
// WHAT IT COULD NOT SEE. The gate identifies a lane by reading
// state/agent-launch/<agentId>.json, which src/lib/agent-lane.js writes when
// THE PRODUCT launches a lane. An agent launched by a harness instead -- Claude
// Code, Codex, a subagent of either -- never passes through agent-lane.js, so
// it has no launch record, so it has no declared territory. The gate's
// attribution then finds zero matching records and returns NOT_APPLICABLE,
// which exits 0. Measured at tools/lane-territory-gate.js: the `matches.length
// === 0` branch.
//
// That branch was RIGHT when the only agents were product-launched lanes: not
// every worktree is a scoped lane, and inventing a territory for a human's
// ordinary push would be a guess. It became absence-as-consent the moment most
// of the work started arriving from harness agents that cannot register. This
// repository's own history is the argument: eight incidents of one lane's
// uncommitted work being committed by another, and "six of tonight's seven
// ratchet regressions" from exactly that.
//
// WHAT THIS FILE ADDS, AND WHAT IT DELIBERATELY DOES NOT.
//
// It adds the registration a harness agent can perform for itself, in the
// record format the existing gate already reads -- so nothing downstream had to
// change to start covering harness agents. And it adds the check that actually
// prevents a collision BEFORE it happens: a claim that OVERLAPS a live claim
// held by a different agent is REFUSED, naming the holder. That is the part no
// push-time gate can do, because by the time a push happens both agents have
// already written the same file.
//
// It does NOT lock the filesystem. Two processes can still write the same byte;
// nothing here can stop that. What it stops is the far more common failure --
// two agents being GIVEN overlapping work in the first place -- and it makes
// the overlap visible at claim time instead of at merge time.
//
// FAIL CLOSED ON AMBIGUITY. An unreadable claim directory, a malformed record,
// or a territory that cannot be parsed all REFUSE the claim. A collision-
// prevention tool that fails open is decoration.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { admits, normalize } = require('./lane-territory-check.js');

const ROOT = path.resolve(__dirname, '..');
const CLAIM_DIR = path.join(ROOT, 'state', 'agent-launch');
const SCHEMA_VERSION = 1;

// A claim older than this is not treated as live. A harness agent that dies
// without releasing must not fence the file forever -- an expired fence is
// indistinguishable from a permanent one to whoever hits it next.
const DEFAULT_STALE_MS = 4 * 60 * 60 * 1000;

const EXIT = Object.freeze({ OK: 0, REFUSED: 1, INDETERMINATE: 2 });

class TerritoryClaimError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) { throw new TerritoryClaimError(code, message, details); }

function repoRoot(cwd = process.cwd()) {
  try {
    // git runs hooks, core.hooksPath is set in this repo, and a hook sees
    // whatever env the git child was given. Fixed argv does not make an
    // inherited credential safe.
    const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', windowsHide: true,
      env: safeLaunchEnvironment(process.env, { context: 'agent territory claim repo root' })
    }).trim();
  } catch {
    // Not a git worktree, or git is unavailable. Either way we cannot say which
    // tree a claim belongs to, and a claim without a tree fences nothing.
    return null;
  }
}

/** Territory is a `;`-separated list of paths/prefixes/globs, matching the gate's own vocabulary. */
function parseTerritory(text) {
  if (typeof text !== 'string' || !text.trim()) {
    fail('TERRITORY_CLAIM_EMPTY', 'A claim needs a territory: a ;-separated list of paths, directory prefixes or globs.');
  }
  const entries = text.split(';').map(part => part.trim()).filter(Boolean);
  if (entries.length === 0) fail('TERRITORY_CLAIM_EMPTY', 'The territory parsed to zero entries.');
  for (const entry of entries) {
    if (path.isAbsolute(entry) || entry.includes('..')) {
      fail('TERRITORY_CLAIM_PATH_INVALID',
        `Territory entries must be repo-relative and must not escape the tree: "${entry}"`);
    }
  }
  return entries;
}

/**
 * Do two territories overlap?
 *
 * Asymmetric by nature: "src/lib" admits "src/lib/audit.js" but not the other
 * way round, so BOTH directions are tested. Using the gate's own `admits`
 * rather than a string compare means a glob claim and a prefix claim are
 * compared the same way the push gate will eventually compare them -- one
 * definition of the boundary, not two.
 */
function territoriesOverlap(a, b) {
  for (const left of a) {
    for (const right of b) {
      if (normalize(left) === normalize(right)) return { left, right };
      if (admits(left, right) || admits(right, left)) return { left, right };
    }
  }
  return null;
}

function readClaims({ claimDir = CLAIM_DIR, now = Date.now(), staleMs = DEFAULT_STALE_MS } = {}) {
  let names;
  try {
    names = fs.readdirSync(claimDir).filter(name => name.endsWith('.json'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    // Unreadable claim store: we cannot prove the file is free, so callers must
    // refuse rather than assume it is.
    fail('TERRITORY_CLAIM_STORE_UNREADABLE', `The claim store could not be read: ${error.message}`);
  }
  const claims = [];
  for (const name of names) {
    const file = path.join(claimDir, name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      // A directory entry proves that a claim record exists. If it cannot be
      // read or parsed, treating it as absent would turn "not measured" into
      // "no collision".
      fail('TERRITORY_CLAIM_STORE_UNREADABLE',
        `Claim record ${file} could not be read and validated: ${error.message}`);
    }
    if (!record || typeof record !== 'object') {
      fail('TERRITORY_CLAIM_STORE_UNREADABLE', `Claim record ${file} is not a JSON object.`);
    }
    if (!Array.isArray(record.territoryEntries)) continue;   // not a claim this tool wrote
    if (record.territoryEntries.length === 0
        || record.territoryEntries.some(entry => typeof entry !== 'string' || !entry.trim())
        || record.territoryEntries.some(entry => path.isAbsolute(entry) || entry.includes('..'))
        || typeof record.agentId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(record.agentId)
        || typeof record.worktree !== 'string' || !record.worktree
        || !Number.isFinite(record.claimedAtMs)) {
      fail('TERRITORY_CLAIM_STORE_UNREADABLE', `Claim record ${file} is missing required claim fields.`);
    }
    const claimedAtMs = record.claimedAtMs;
    claims.push({ file, record, live: (now - claimedAtMs) < staleMs && record.released !== true });
  }
  return claims;
}

function claim({ agentId, territory, worktree, lane = null, note = null, claimDir = CLAIM_DIR, now = Date.now(), staleMs = DEFAULT_STALE_MS }) {
  if (typeof agentId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId)) {
    fail('TERRITORY_CLAIM_AGENT_INVALID', 'agentId must be 1-64 chars of [A-Za-z0-9_-] and start alphanumeric.');
  }
  const entries = parseTerritory(territory);
  if (!worktree) {
    fail('TERRITORY_CLAIM_NO_WORKTREE', 'Could not resolve a git worktree for this claim; a claim without a tree fences nothing.');
  }

  const existing = readClaims({ claimDir, now, staleMs });
  for (const { record, live } of existing) {
    if (!live) continue;
    if (record.agentId === agentId) continue;              // re-claiming your own is a refresh, handled below
    if (normalize(record.worktree || '') !== normalize(worktree)) continue;  // a different tree cannot collide
    const clash = territoriesOverlap(entries, record.territoryEntries);
    if (clash) {
      fail('TERRITORY_CLAIM_CONFLICT',
        `"${record.agentId}" already holds an overlapping territory in this worktree `
        + `("${clash.right}" overlaps your "${clash.left}"). Narrow your territory, or wait for it to finish and release. `
        + `This is the collision the push gate cannot catch: by the time both of you push, both files are already written.`,
        { holder: record.agentId, holderEntry: clash.right, requestedEntry: clash.left, holderLane: record.lane || null });
    }
  }

  const record = {
    schemaVersion: SCHEMA_VERSION,
    agentId,
    kind: 'harness',
    lane,
    // `territory` is the string the existing gate reads; territoryEntries is the
    // parsed form this tool compares. Both are written so neither reader has to
    // know about the other.
    territory: entries.join(';'),
    territoryEntries: entries,
    worktree,
    note,
    claimedAtMs: now,
    claimedAt: new Date(now).toISOString(),
    released: false
  };
  fs.mkdirSync(claimDir, { recursive: true });
  const file = path.join(claimDir, `${agentId}.json`);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
  return { file, record };
}

function release({ agentId, claimDir = CLAIM_DIR, now = Date.now() }) {
  const file = path.join(claimDir, `${agentId}.json`);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { released: false, reason: 'no claim on file' };
    fail('TERRITORY_CLAIM_STORE_UNREADABLE',
      `Claim record ${file} could not be read and validated: ${error.message}`);
  }
  if (!Array.isArray(record.territoryEntries)) {
    // Not ours: a product-launched lane record. Refuse rather than clobber the
    // record the push gate depends on.
    fail('TERRITORY_CLAIM_NOT_OURS', `state/agent-launch/${agentId}.json was not written by this tool; refusing to modify it.`);
  }
  record.released = true;
  record.releasedAtMs = now;
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { released: true, file };
}

function parseArgs(argv) {
  const out = { command: argv[0] || 'status' };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail('TERRITORY_CLAIM_ARGS', `Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail('TERRITORY_CLAIM_ARGS', `${token} requires a value`);
    out[key] = value;
    index += 1;
  }
  return out;
}

function usage() {
  return [
    'Claim a file territory for a harness-launched agent, so two agents are not given overlapping work.',
    '',
    '  node tools/agent-territory-claim.js claim --agent <id> --territory "src/lib/audit.js;tests/audit-*" [--lane <name>] [--note <text>]',
    '  node tools/agent-territory-claim.js status',
    '  node tools/agent-territory-claim.js release --agent <id>',
    '',
    'Exit codes: 0 granted/clean, 1 refused (overlap or invalid), 2 indeterminate (cannot prove it is free).',
    ''
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage()); return EXIT.OK; }
  const args = parseArgs(argv);
  const worktree = repoRoot();

  if (args.command === 'status') {
    if (!worktree) {
      fail('TERRITORY_CLAIM_STORE_UNREADABLE',
        'Could not resolve a git worktree; status cannot determine which claims belong to this tree.');
    }
    const claims = readClaims().filter(c => normalize(c.record.worktree) === normalize(worktree));
    const live = claims.filter(c => c.live);
    process.stdout.write(`${JSON.stringify({
      ok: true, worktree, liveClaims: live.length,
      claims: live.map(c => ({ agentId: c.record.agentId, lane: c.record.lane, territory: c.record.territory, claimedAt: c.record.claimedAt }))
    }, null, 1)}\n`);
    return EXIT.OK;
  }

  if (args.command === 'claim') {
    const { file, record } = claim({
      agentId: args.agent, territory: args.territory, worktree,
      lane: args.lane || null, note: args.note || null
    });
    process.stdout.write(`${JSON.stringify({ ok: true, code: 'TERRITORY_CLAIM_GRANTED', file, agentId: record.agentId, territory: record.territory }, null, 1)}\n`);
    return EXIT.OK;
  }

  if (args.command === 'release') {
    const result = release({ agentId: args.agent });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 1)}\n`);
    return EXIT.OK;
  }

  fail('TERRITORY_CLAIM_ARGS', `Unknown command "${args.command}".\n${usage()}`);
  return EXIT.INDETERMINATE;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    const code = error instanceof TerritoryClaimError ? error.code : 'TERRITORY_CLAIM_FAILED';
    const details = error instanceof TerritoryClaimError ? error.details : {};
    process.stderr.write(`${JSON.stringify({ ok: false, code, message: error.message, ...details }, null, 1)}\n`);
    process.exitCode = code === 'TERRITORY_CLAIM_STORE_UNREADABLE' ? EXIT.INDETERMINATE : EXIT.REFUSED;
  }
}

module.exports = Object.freeze({
  TerritoryClaimError, DEFAULT_STALE_MS, EXIT,
  parseTerritory, territoriesOverlap, readClaims, claim, release, main
});
