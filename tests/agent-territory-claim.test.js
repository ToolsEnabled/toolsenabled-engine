// EXECUTABLE CHANGE
// Assertion strengthened: stale-claim expiry now uses the independently stated
// four-hour contract instead of computing its stimulus with DEFAULT_STALE_MS.
// Mutation: DEFAULT_STALE_MS changed from 4 hours to 400 hours. Before this fix
// the suite stayed green: "agent territory claim tests passed (18 checks: ...)."
// With this fix the mutation is RED: "TerritoryClaimError: \"lane-a\" already
// holds an overlapping territory in this worktree" and exits with status 1.
// Restored source: tools/agent-territory-claim.js was restored byte-for-byte
// (SHA-256 3d843fee856e74419d55a4720112147a3c84a982868b78585da37cab81c2f686),
// then this file was green: "agent territory claim tests passed (18 checks: ...)."
// NOT-FOUND: empty loop/forEach assertions; exit-status/truthy-return-only
// assertions; swallowed failures; mocks of the subject; skips/platform guards.
// The same-code expected-value shape was found only in the stale-window case.
// Preconditions not met: none.
'use strict';

// COLLISION PREVENTION FOR AGENTS THE PUSH GATE CANNOT SEE.
//
// tools/lane-territory-gate.js resolves who is pushing by reading
// state/agent-launch/<agentId>.json, which src/lib/agent-lane.js writes when
// THE PRODUCT launches a lane. An agent launched by a harness instead -- Claude
// Code, Codex, or a subagent of either -- never passes through agent-lane.js,
// so it has no record, so the gate's attribution finds zero matches and returns
// NOT_APPLICABLE, which exits 0. Every harness agent therefore pushed with no
// territory check at all.
//
// These cases pin the behaviour that closes it. The one that matters most is
// OVERLAP REFUSAL: a push-time gate structurally cannot prevent a collision,
// because by the time two agents push, both have already written the same file.
// The only place to catch it is when the second agent asks for the work.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claimTool = require('../tools/agent-territory-claim.js');

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

function refusalCode(run) {
  try { run(); } catch (error) { return error && error.code; }
  return null;
}

function freshStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'territory-claim-'));
}

const TREE = path.join(os.tmpdir(), 'territory-example', 'checkout');
const OTHER_TREE = path.join(os.tmpdir(), 'territory-example', 'other-checkout');

// 1. A claim is granted and is readable back as live.
{
  const claimDir = freshStore();
  claimTool.claim({ agentId: 'lane-a', territory: 'src/lib/audit.js', worktree: TREE, claimDir });
  const live = claimTool.readClaims({ claimDir }).filter(entry => entry.live);
  check(live.length === 1, 'a granted claim must be readable back as live');
  check(live[0].record.territoryEntries[0] === 'src/lib/audit.js', 'the claim must record the territory it was granted');
}

// 2. THE POINT: an overlapping claim is REFUSED, in both directions.
//    A broad claim must not swallow a narrow one already held, and a narrow
//    claim must not slip inside a broad one already held.
{
  const claimDir = freshStore();
  claimTool.claim({ agentId: 'lane-a', territory: 'src/lib/audit.js', worktree: TREE, claimDir });
  check(
    refusalCode(() => claimTool.claim({ agentId: 'lane-b', territory: 'src/lib', worktree: TREE, claimDir })) === 'TERRITORY_CLAIM_CONFLICT',
    'a BROADER claim overlapping a held narrow one must be refused'
  );

  const reverse = freshStore();
  claimTool.claim({ agentId: 'lane-a', territory: 'src/lib', worktree: TREE, claimDir: reverse });
  check(
    refusalCode(() => claimTool.claim({ agentId: 'lane-b', territory: 'src/lib/audit.js', worktree: TREE, claimDir: reverse })) === 'TERRITORY_CLAIM_CONFLICT',
    'a NARROWER claim inside a held broad one must be refused'
  );
}

// 3. Disjoint work proceeds. A fence that blocks everything gets switched off,
//    so the common case must stay frictionless.
{
  const claimDir = freshStore();
  claimTool.claim({ agentId: 'lane-a', territory: 'src/lib/audit.js', worktree: TREE, claimDir });
  const granted = claimTool.claim({ agentId: 'lane-b', territory: 'tools/bridge-status.js', worktree: TREE, claimDir });
  check(granted.record.agentId === 'lane-b', 'a disjoint territory in the same tree must be granted');
}

// 4. A DIFFERENT worktree cannot collide, however similar the paths. Worktree
//    isolation is the other legitimate way to parallelise, and this fence must
//    not punish it.
{
  const claimDir = freshStore();
  claimTool.claim({ agentId: 'lane-a', territory: 'src/lib', worktree: TREE, claimDir });
  const granted = claimTool.claim({ agentId: 'lane-b', territory: 'src/lib', worktree: OTHER_TREE, claimDir });
  check(granted.record.worktree === OTHER_TREE, 'the same territory in a different worktree must be granted');
}

// 5. Re-claiming your own territory is a refresh, not a self-collision.
{
  const claimDir = freshStore();
  claimTool.claim({ agentId: 'lane-a', territory: 'src/lib', worktree: TREE, claimDir });
  const again = claimTool.claim({ agentId: 'lane-a', territory: 'src/lib;tests/audit-store.js', worktree: TREE, claimDir });
  check(again.record.territoryEntries.length === 2, 'an agent must be able to widen its own claim without colliding with itself');
}

// 6. A RELEASED claim frees the ground. Without this the first agent to touch a
//    file would fence it for the life of the store.
{
  const claimDir = freshStore();
  claimTool.claim({ agentId: 'lane-a', territory: 'src/lib', worktree: TREE, claimDir });
  claimTool.release({ agentId: 'lane-a', claimDir });
  const granted = claimTool.claim({ agentId: 'lane-b', territory: 'src/lib', worktree: TREE, claimDir });
  check(granted.record.agentId === 'lane-b', 'a released territory must become claimable');
}

// 7. A STALE claim frees the ground too. A harness agent that dies without
//    releasing must not fence a file forever -- to whoever hits it next, a
//    permanent fence and an abandoned one are indistinguishable.
{
  const claimDir = freshStore();
  const now = 1_000_000_000_000;
  claimTool.claim({ agentId: 'lane-a', territory: 'src/lib', worktree: TREE, claimDir, now });
  const later = now + (4 * 60 * 60 * 1000) + 1;
  const granted = claimTool.claim({ agentId: 'lane-b', territory: 'src/lib', worktree: TREE, claimDir, now: later });
  check(granted.record.agentId === 'lane-b', 'a claim past the stale window must not fence the tree forever');
}

// 8. FAIL CLOSED ON A BAD REQUEST. A territory that escapes the tree, or an
//    unusable agent id, must refuse rather than be normalised into something
//    that fences the wrong thing.
{
  const claimDir = freshStore();
  check(refusalCode(() => claimTool.claim({ agentId: 'lane-a', territory: '', worktree: TREE, claimDir })) === 'TERRITORY_CLAIM_EMPTY',
    'an empty territory must refuse');
  check(refusalCode(() => claimTool.claim({ agentId: 'lane-a', territory: '../outside', worktree: TREE, claimDir })) === 'TERRITORY_CLAIM_PATH_INVALID',
    'a territory escaping the tree must refuse');
  const absoluteTerritory = path.join(path.parse(TREE).root, 'absolute');
  check(refusalCode(() => claimTool.claim({ agentId: 'lane-a', territory: absoluteTerritory, worktree: TREE, claimDir })) === 'TERRITORY_CLAIM_PATH_INVALID',
    'an absolute territory must refuse');
  check(refusalCode(() => claimTool.claim({ agentId: 'bad id!', territory: 'src', worktree: TREE, claimDir })) === 'TERRITORY_CLAIM_AGENT_INVALID',
    'an unusable agent id must refuse');
  check(refusalCode(() => claimTool.claim({ agentId: 'lane-a', territory: 'src', worktree: null, claimDir })) === 'TERRITORY_CLAIM_NO_WORKTREE',
    'a claim with no resolvable worktree must refuse -- it would fence nothing');
}

// 9. A PRODUCT-LAUNCHED lane record must not be clobbered. Those records are
//    what the push gate reads; releasing one as if it were ours would quietly
//    disarm the gate for that lane.
{
  const claimDir = freshStore();
  fs.writeFileSync(path.join(claimDir, 'product-lane.json'),
    JSON.stringify({ schemaVersion: 1, agentId: 'product-lane', territory: 'src/lib', worktree: TREE }), 'utf8');
  check(refusalCode(() => claimTool.release({ agentId: 'product-lane', claimDir })) === 'TERRITORY_CLAIM_NOT_OURS',
    'releasing a record this tool did not write must refuse, not disarm the push gate');
}

// 10. The overlap rule is the push gate's own rule, not a second one. Proving
//     it here means the two cannot drift apart at the edges.
{
  check(claimTool.territoriesOverlap(['src/lib/'], ['src/lib/audit.js']) !== null,
    'a trailing-slash prefix must overlap a file beneath it');
  check(claimTool.territoriesOverlap(['tests/audit-*'], ['tests/audit-store.js']) !== null,
    'a glob claim must overlap a file it admits');
  check(claimTool.territoriesOverlap(['src/lib'], ['src/libexec/x.js']) === null,
    'a shared name PREFIX is not containment -- src/lib must not fence src/libexec');
}

console.log(`agent territory claim tests passed (${checks} checks: grant and read-back, overlap refused in both directions, disjoint granted, other worktree granted, self-refresh, release frees, stale frees, fail-closed on bad territory/agent/worktree, product lane records protected, and prefix-vs-containment).`);
