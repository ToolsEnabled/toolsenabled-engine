'use strict';

// Terminate a timed-out lane/reviewer child AND its descendants.
//
// WHY THIS EXISTS. Three timeout sites (lane-runner, review, evidence) used a
// bare `child.kill('SIGTERM')` and resolved immediately. On Windows that
// hard-terminates only the IMMEDIATE child: the provider CLI it spawned keeps
// its own subprocess tree alive, consuming CPU for however long it pleases on
// a machine the owner already reports as strained — a lane budget is 20
// minutes, so a leaked tree is long-lived. On POSIX a child that ignores
// SIGTERM was likewise never escalated. luna-executor.js already solved this
// for its own children; this module is the shared version so the three
// remaining sites cannot drift apart again.
//
// Best effort by design: the caller has already decided the work is dead and
// must not block its own timeout path on the kill's outcome. Every failure
// path here is swallowed on purpose — there is nothing useful a timed-out
// lane can do about "the kill failed", and the alternative (throwing out of a
// setTimeout callback) would crash the supervisor.
//
// MEASURED 2026-09-03: the Windows branch used to call child.kill() BEFORE
// taskkill, on the reasoning that the direct child needed to die first so a
// polite tree signal would have nobody left to relay it to. That reasoning
// assumed taskkill could still resolve an already-dead pid to walk its
// former tree. It cannot: `taskkill /PID <pid> /T /F` against a pid that no
// longer exists answers "ERROR: The process ... not found" and performs NO
// tree walk at all -- not even for descendants still very much alive. Every
// grandchild the OS does not already clean up on its own (this product's own
// spawns are, but a provider CLI's own child is not always -- see
// codex-process.js and claude-cli-process.js, which reuse this function for
// exactly that grandchild) was therefore never reached, silently: the
// preceding child.kill() "succeeded", taskkill's failure went to
// stdio:'ignore' with no exit handler reading it, and the caller had no way
// to learn its tree kill was a no-op. Reproduced directly: a child spawned
// detached (so it does not share its spawner's own process-tracking job, the
// same shape a provider CLI's long-lived helper has in production) survived
// child.kill()-then-taskkill every time, and survived zero times once
// taskkill ran first. So taskkill runs FIRST here, while the pid can still
// be resolved -- it kills the named process AND its tree in one call, which
// is why the child.kill() fallback below only fires if taskkill itself could
// not be started at all.
const { spawn } = require('node:child_process');

const POSIX_ESCALATION_GRACE_MS = 5_000;

function killProcessTree(child) {
  if (!child || typeof child.kill !== 'function') return;
  if (!Number.isSafeInteger(child.pid)) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    return;
  }

  if (process.platform === 'win32') {
    // taskkill /T walks the descendant tree and kills the named pid itself
    // in the same call, so no separate child.kill() runs ahead of it on the
    // success path -- see the module header for why running one first
    // silently defeated the tree walk.
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
        shell: false
      });
      killer.on('error', () => {
        // taskkill missing or refused to even start: fall back to the direct
        // kill so the immediate child is still addressed, best effort, even
        // though its own tree could not be reached this way.
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      });
      if (typeof killer.unref === 'function') killer.unref();
    } catch {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    return;
  }

  try { child.kill('SIGTERM'); } catch { /* already gone */ }

  // POSIX: give SIGTERM a bounded grace, then hard-kill if the child ignored
  // it. unref'd so a successful earlier exit never holds the event loop.
  const escalate = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* exited during the grace */ }
  }, POSIX_ESCALATION_GRACE_MS);
  if (typeof escalate.unref === 'function') escalate.unref();
  child.once('close', () => clearTimeout(escalate));
}

module.exports = { killProcessTree, POSIX_ESCALATION_GRACE_MS };
