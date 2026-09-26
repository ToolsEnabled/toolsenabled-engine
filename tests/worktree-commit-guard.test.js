'use strict';
/* ONE WORKTREE PER AGENT, AT THE COMMIT.
 *
 * Two failures on 2026-09-15 came from agents sharing a working tree: the
 * shared dependency store lost 76 top-level packages to a recursive delete that
 * followed one worktree's node_modules reparse point, and a builder was asked
 * to prove a suite it had never run because another agent's staged paths were
 * in the same index. A commit is where that stops being a nuisance: whoever
 * commits signs for everything staged, including work they have not read.
 *
 * WHAT THESE TESTS FIX IN PLACE, and the second is as important as the first:
 *   - a tree that says it belongs to someone else refuses the commit, by name,
 *     and says what is staged;
 *   - an UNMARKED tree is allowed. Every worktree in use today carries no
 *     marker, so a guard that refused them would refuse every commit on this
 *     machine the moment it landed. A repair that makes the guard stricter by
 *     refusing silence fails here instead of passing.
 *
 *   node --test tests/worktree-commit-guard.test.js
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MARKER_FILENAME, WorktreeCommitRefused, commitAllowed, readWorktreeOwner, sameAgent
} = require('../src/lib/fleet-supervisor/worktree-commit-guard.js');

function tree(t, marker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (marker !== undefined) fs.writeFileSync(path.join(dir, MARKER_FILENAME), marker);
  return dir;
}

test('a tree that belongs to another agent refuses the commit, and says who and what', (t) => {
  const dir = tree(t, JSON.stringify({ agent: 'Builder 6' }));
  const answer = commitAllowed({ worktreePath: dir, agent: 'Builder 4', stagedPaths: ['src/a.js', 'src/b.js'] });

  assert.equal(answer.ok, false, 'committing into another agent\'s tree is the thing being prevented');
  assert.equal(answer.code, 'WORKTREE_COMMIT_NOT_YOURS');
  assert.match(answer.message, /Builder 6/, `the refusal must name the owner: ${answer.message}`);
  assert.match(answer.message, /Builder 4/, 'and who was refused');
  assert.match(answer.message, /2 path\(s\) are staged/, `and what would have been signed for: ${answer.message}`);
  assert.deepEqual(answer.stagedPaths, ['src/a.js', 'src/b.js']);
});

test('AN UNMARKED TREE IS ALLOWED, because every worktree in use today is unmarked', (t) => {
  const dir = tree(t);
  const answer = commitAllowed({ worktreePath: dir, agent: 'Builder 4' });
  assert.equal(answer.ok, true,
    'refusing silence would refuse every commit on this machine the moment this landed, which is worse than the defect it prevents');
  assert.equal(answer.owner, null);
  assert.equal(answer.claimed, false, 'and it must say the tree is unclaimed, so a caller can choose to claim it');
});

test('the agent that owns the tree may commit in it', (t) => {
  const dir = tree(t, JSON.stringify({ agent: 'Builder 4' }));
  const answer = commitAllowed({ worktreePath: dir, agent: 'Builder 4' });
  assert.equal(answer.ok, true);
  assert.equal(answer.claimed, true);
});

test('the owner is matched the way a person would read it, not byte for byte', (t) => {
  const dir = tree(t, JSON.stringify({ agent: '  builder 4 ' }));
  assert.equal(commitAllowed({ worktreePath: dir, agent: 'Builder 4' }).ok, true,
    'spacing and case are not a different circle');
  assert.equal(commitAllowed({ worktreePath: dir, agent: 'Builder 5' }).ok, false,
    'but a different number is a different circle');
  assert.equal(sameAgent('Builder 4', 'Builder 40'), false, 'and a prefix is not the same agent');
});

test('a marker a person wrote by hand is read, not rejected', (t) => {
  const dir = tree(t, 'Builder 6\n');
  assert.equal(readWorktreeOwner(dir), 'Builder 6',
    'a bare name on one line is what someone would plausibly leave, and refusing to read it would make the guard useless in exactly the case it is needed');
  assert.equal(commitAllowed({ worktreePath: dir, agent: 'Builder 4' }).ok, false);
});

test('an unreadable or corrupt marker reads as ABSENT, never as a refusal', (t) => {
  /* THE NUL BYTES ARE BUILT HERE, NOT EMBEDDED IN THIS FILE.
     Written literally, three raw NUL bytes make this source BINARY to git
     (`Bin 0 -> 6035 bytes` in a diffstat), so the test that guards against
     corruption could not itself be diffed or reviewed, and would trip any
     text-only gate. The bytes reaching the fixture are identical. */
  const dir = tree(t, String.fromCharCode(0).repeat(3));
  assert.equal(readWorktreeOwner(dir), null,
    'one corrupt byte must not become "nobody may commit here" -- that is the failure mode this guard exists to avoid');
  assert.equal(commitAllowed({ worktreePath: dir, agent: 'Builder 4' }).ok, true);

  // The same must hold for a marker that is merely blank rather than corrupt.
  const blank = tree(t, '   \n');
  assert.equal(readWorktreeOwner(blank), null, 'whitespace names nobody either');
  assert.equal(commitAllowed({ worktreePath: blank, agent: 'Builder 4' }).ok, true);
});

test('a missing worktree is not an owner, and does not throw', () => {
  assert.equal(readWorktreeOwner(path.join(os.tmpdir(), 'no-such-worktree-' + Date.now())), null);
  assert.equal(readWorktreeOwner(null), null);
  assert.equal(readWorktreeOwner(''), null);
});

test('a guard that cannot tell who is asking refuses to answer at all', (t) => {
  const dir = tree(t, JSON.stringify({ agent: 'Builder 6' }));
  assert.throws(() => commitAllowed({ worktreePath: dir, agent: '' }), WorktreeCommitRefused,
    'answering "yes" to an unnamed caller would let the guard be bypassed by omitting a field');
  assert.throws(() => commitAllowed({ worktreePath: dir }), /WORKTREE_COMMIT_AGENT_REQUIRED/);
});

test('an explicit owner overrides the file, so a caller that already knows need not re-read it', (t) => {
  const dir = tree(t, JSON.stringify({ agent: 'Builder 4' }));
  assert.equal(commitAllowed({ worktreePath: dir, agent: 'Builder 4', owner: 'Builder 6' }).ok, false,
    'the supplied owner is the one that counts when it is supplied');
  assert.equal(commitAllowed({ worktreePath: dir, agent: 'Builder 6', owner: null }).ok, true,
    'and an explicit null means unmarked');
});

test('control characters cannot hide after a valid first line or in trimmed owner text', t => {
  for (const marker of ['Builder 6\n' + String.fromCharCode(0),
    JSON.stringify({ agent: 'Builder 6' + String.fromCharCode(9) })]) {
    const dir = tree(t, marker);
    assert.equal(readWorktreeOwner(dir), null, 'a corrupt marker must not invent an owner');
    assert.equal(commitAllowed({ worktreePath: dir, agent: 'Builder 4' }).ok, true);
  }
});
