'use strict';

/* A THROWAWAY PRODUCT IDENTITY, FOR TESTS THAT REACH THE SESSION SPOOL.
 *
 * Requiring this module gives the current process its own TOOLSENABLED_STATE_ROOT
 * under the system temp directory, and removes it again at exit.
 *
 * WHY IT IS NEEDED. `resolveServicesRoot()` derives the services root from
 * TOOLSENABLED_STATE_ROOT, which the shell publishes from Electron's own
 * `app.getPath('userData')`. Nothing publishes it for a bare `node` run, so the
 * resolver refuses with SERVICE_PRODUCT_IDENTITY_UNAVAILABLE. That refusal is a
 * fix working, not a gap: the resolver used to fall back to a literal directory
 * name, which meant a renamed or test build read and wrote the REAL product's
 * machine record, key and settings.
 *
 * WHY IT MUST BE A SCRATCH DIRECTORY AND NEVER THE MACHINE'S. Tests that reach
 * the spool WRITE. Pointing them at the installed product's state root would put
 * test bytes in the owner's own machine directory -- precisely the accident the
 * resolver now prevents. A fresh mkdtemp per process also stops two concurrent
 * runs sharing one spool, which on this repository's shared box is the normal
 * case rather than the exception.
 *
 * WHY IT LIVES HERE RATHER THAN IN EACH TEST. Two suites need it today
 * (agent-engine/claude-cli-process and agent-engine/claude-mcp-args) and a
 * copied setup block is a rule that drifts -- one file would gain a cleanup or a
 * guard the other did not. One module, one behaviour.
 *
 * IT DOES NOT OVERRIDE AN EXPLICIT ROOT. If a caller has already exported
 * TOOLSENABLED_STATE_ROOT -- a lane running against a prepared fixture, or a
 * deliberate integration run -- that value stands and nothing is created or
 * removed. Silently replacing a caller's stated root would make this helper the
 * kind of invisible second path the repository refuses elsewhere.
 *
 * MEASURED 2026-08-26: without this, `npm run test:agent-engine:process` fails
 * seven checks across the two suites with DurableMemoryFileError in any
 * environment that does not happen to export the variable -- every clean
 * checkout, every worktree, every CI runner. The chain baseline that tolerated
 * the step evidently had it exported, so the step's verdict depended on the
 * shell it was launched from rather than on the code under test.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let created = null;

if (!process.env.TOOLSENABLED_STATE_ROOT) {
  created = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-scratch-state-'));
  process.env.TOOLSENABLED_STATE_ROOT = created;
  process.on('exit', () => {
    // Best effort: a leaked scratch directory is litter, while throwing here
    // would turn a passing suite red on cleanup and hide its real result.
    try { fs.rmSync(created, { recursive: true, force: true }); } catch { /* ignore */ }
  });
}

module.exports = {
  /** The scratch root this helper created, or null when a caller supplied one. */
  scratchStateRoot: created,
  /** The root in force for this process, whoever set it. */
  stateRoot: process.env.TOOLSENABLED_STATE_ROOT,
};
