'use strict';

// The elevated Q39 collector is allowed to inspect only these fixed
// ToolsEnabled scheduler records. Which processes belong here is decided by
// tests/process-visibility-writer.test.js's own rule, verbatim: "every other
// declared scheduled process is a fixed collector target" -- i.e. everything
// in config/managed-processes.json with a taskName. Legacy scheduled
// owner-host records are retired by managed-processes before this projection;
// the installed app owns that same-principal host directly.
//
// This was a hand-maintained literal until 2026-08-09, and it had drifted:
// Processes added to config/managed-processes.json after this list was last
// touched were never added here, so Q39's elevated collector was not observing
// them.
// tests/process-visibility-writer.test.js was already asserting the correct,
// complete set; nothing was reading its failure because `npm test` aborted
// at `pretest` before reaching it (see the invocation-guard/pretest work
// earlier this session). Derived now instead of hand-copied, so the two
// cannot diverge again the same way.
//
// Until 2026-08-22 this module also carried a CONDITIONAL entry for the
// Discord bridge task, admitted only on an exact managed-process declaration
// match. Discord was removed from the product entirely (owner ruling, O4), so
// the conditional path, its declaration constant and the .ps1's matching
// gate are gone; the list is once again exactly the derived set below.
const managedProcesses = require('../managed-processes');

const baseTaskNames = managedProcesses.listProcesses()
  .filter(item => item.taskName && item.id !== 'owner-host')
  .map(item => item.taskName);

// An empty derived set is not evidence that there are no processes to
// inspect. It means the collector target contract could not be established,
// and allowing it through would make every downstream completeness check
// succeed vacuously.
if (baseTaskNames.length === 0) {
  throw new Error('process-visibility-targets: managed-process registry declares zero collector targets');
}

const BASE_TASK_NAMES = Object.freeze(baseTaskNames);

// Kept as a distinct export: tools/generate-mirrors.js reads BASE_TASK_NAMES
// for the .ps1 block and the writer reads TASK_NAMES; they are the same list
// now that nothing is appended conditionally.
const TASK_NAMES = BASE_TASK_NAMES;

module.exports = Object.freeze({
  BASE_TASK_NAMES,
  TASK_NAMES
});
