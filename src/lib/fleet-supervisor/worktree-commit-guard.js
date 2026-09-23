'use strict';

/* ONE WORKTREE PER AGENT, ENFORCED WHERE IT ACTUALLY GOES WRONG: THE COMMIT.
 *
 * MEASURED 2026-09-15. Two failures on one day, both from agents sharing a
 * working tree:
 *   - the shared dependency store lost 76 top-level packages when a recursive
 *     delete followed one worktree's node_modules reparse point into it;
 *   - a builder was asked to prove a suite it had never run, because another
 *     agent's staged paths were sitting in the same index.
 * A commit is where a shared tree stops being a nuisance and starts being a
 * wrong record: whoever commits signs for everything staged, including work
 * they have not read.
 *
 * WHY ADVISORY, AND WHY IT FAILS OPEN. worktree-lease.js already holds the
 * allocation contract and says of itself that it "intentionally does NOT create
 * a worktree, write fleet state, or start a process". Nothing enforces it yet,
 * so every worktree in use today carries no marker at all. A guard that refused
 * an unmarked tree would refuse every commit on this machine the moment it
 * landed, during a launch, which is a worse failure than the one it prevents.
 * So: no marker means allowed, and the guard only ever refuses when a tree
 * SAYS it belongs to someone else. That is the smallest version that is honest
 * about what it knows.
 *
 * It answers a question and performs no effect: no file is written, no process
 * is signalled, no commit is run. The caller -- a pre-commit hook, or a builder
 * checking before it stages -- owns the consequence.
 */

const MARKER_FILENAME = '.agent-worktree-owner';
const MAX_AGENT_NAME = 120;

class WorktreeCommitRefused extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'WorktreeCommitRefused';
    this.code = code;
    this.detail = detail;
  }
}

function normalizeAgent(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AGENT_NAME) return null;
  /* A NUL-FILLED FILE IS CORRUPTION, NOT A NAME, and on this machine it is the
     corruption that actually happens: the live tree directory was once found as
     22,346 bytes of pure NUL and quarantined as tree-nodes.json.corrupt-…zeros
     after an unclean shutdown. String.trim() does not strip NUL, so without
     this a marker of three NUL bytes reads as a three-character agent name that
     matches nobody -- and every agent on the machine is refused its commits by
     a file none of them wrote. No agent name a person types contains a control
     character. */
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return trimmed;
}

/* Two names are the same agent when a person would say so. "Builder 4" and
   "builder 4" are one circle; "Builder 4" and "Builder 5" are not. */
function sameAgent(left, right) {
  return normalizeAgent(left) !== null
    && normalizeAgent(right) !== null
    && normalizeAgent(left).toLowerCase() === normalizeAgent(right).toLowerCase();
}

/** Who a worktree says it belongs to, or null when it says nothing.
 *  A marker that cannot be read or parsed is treated as ABSENT rather than as a
 *  refusal: an unreadable file is not evidence that the tree is someone else's,
 *  and turning one corrupt byte into "nobody may commit here" is the failure
 *  this guard exists to avoid. */
function readWorktreeOwner(worktreePath, { fsImpl, pathImpl } = {}) {
  const fs = fsImpl || require('node:fs');
  const path = pathImpl || require('node:path');
  if (typeof worktreePath !== 'string' || worktreePath.trim().length === 0) return null;
  let raw;
  try {
    raw = fs.readFileSync(path.join(worktreePath, MARKER_FILENAME), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    return normalizeAgent(parsed && parsed.agent);
  } catch {
    /* A bare name on one line is a marker a person can write by hand, and this
       guard should read what a person would plausibly leave. */
    return normalizeAgent(String(raw).replace(/\r?\n$/, ''));
  }
}

/**
 * May this agent commit in this worktree?
 *
 * Returns { ok: true } or { ok: false, code, message }. It never throws for an
 * ordinary refusal -- a refusal is an answer, not an exception -- and throws
 * only when the CALLER is malformed, because a guard that cannot tell who is
 * asking must not answer "yes".
 */
function commitAllowed({ worktreePath = null, agent = null, owner = undefined, stagedPaths = null } = {}) {
  const who = normalizeAgent(agent);
  if (who === null) {
    throw new WorktreeCommitRefused('WORKTREE_COMMIT_AGENT_REQUIRED',
      'Say which agent is committing; a guard that cannot tell who is asking must not answer yes.');
  }
  const holder = owner === undefined ? readWorktreeOwner(worktreePath) : normalizeAgent(owner);

  if (holder === null) {
    // Unmarked tree: allowed, and said plainly so a caller can choose to claim it.
    return Object.freeze({ ok: true, owner: null, claimed: false });
  }
  if (sameAgent(holder, who)) {
    return Object.freeze({ ok: true, owner: holder, claimed: true });
  }
  const staged = Array.isArray(stagedPaths) ? stagedPaths.filter(entry => typeof entry === 'string') : [];
  return Object.freeze({
    ok: false,
    code: 'WORKTREE_COMMIT_NOT_YOURS',
    owner: holder,
    agent: who,
    stagedPaths: Object.freeze(staged),
    message: `This working tree belongs to ${holder}, so ${who} must not commit in it: whoever commits signs for everything staged here, including work they have not read.`
      + (staged.length > 0 ? ` ${staged.length} path(s) are staged.` : '')
      + ` Use your own worktree, or clear the ${MARKER_FILENAME} marker if ${holder} has finished with this one.`
  });
}

module.exports = Object.freeze({
  MARKER_FILENAME,
  WorktreeCommitRefused,
  commitAllowed,
  readWorktreeOwner,
  sameAgent
});
