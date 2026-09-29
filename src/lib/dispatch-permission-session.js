'use strict';

// THE CEILING A DISPATCH RUNS UNDER WHEN THE CALLER IS NOT A BOUND TRANSPORT.
//
// src/lib/tool-registry.js#executeTool() now REFUSES a call that states no
// permission session, because an omitted session used to mean the tier check
// never ran at all. That refusal is only half an answer: the callers that
// legitimately have no transport-bound session -- the scheduled-job runner, the
// mission bridge's own internal reads, the operator scripts under tools/ --
// still need a ceiling, and it must be a STATED one rather than a hole.
//
// This module is where that answer lives, ONCE. The same "read the recorded
// level, fail closed to the most restrictive one" rule had already been written
// twice by hand -- src/mcp-server.js#resolvePermissionSession() and
// src/lib/mission-bridge/actions.js#recordedPermissionSession() -- and a third
// hand-written copy in src/job-runner.js is exactly how a permission vocabulary
// starts disagreeing with itself. Both existing copies are left alone here on
// purpose: they belong to other lanes and they are correct. New unbound callers
// use this one.

const permissionTierPolicy = require('./permission-tier-policy');

// Required lazily for the same reason permission-tier-policy.js defers its own
// manifest require: this module is reached from the dispatch path, and the
// setup graph has nothing to do with most calls that get here.
function machineRecordModule() { return require('./setup/machine-record'); }

/**
 * The session the local installation's RECORDED permission level permits.
 *
 * This is the precedent src/mcp-server.js set for an unbound caller and it is
 * deliberately matched rather than re-decided: an installation that recorded
 * `guided` should not get a wider ceiling merely because the call arrived
 * through a different door.
 *
 * Unreadable, absent, and unrecognised records all refuse. The most restrictive
 * product tier still grants a read surface, so substituting it for a record we
 * could not establish would turn "not measured" into a definite permission
 * answer.
 */
function recordedInstallSession({
  machineRecord = machineRecordModule()
} = {}) {
  const record = machineRecord.readMachineRecord({ servicesRoot: machineRecord.resolveServicesRoot({}) });
  return permissionTierPolicy.installTierSessionFromRecord(record);
}

// The widest ceiling unattended work may ever reach.
//
// WHY CONFINED/WORKSPACE AND NOT FULL. Scheduled actions run while nobody is
// watching, so they must be MORE constrained than an interactive session, not
// less. Confined/workspace applies the permanently excluded tools -- host.exec,
// the clipboard, and the raw host/repo file surface -- while still permitting
// every effect class, which is what a scheduled job legitimately needs. The
// clamp therefore costs the scheduler nothing it is allowed to do.
//
// WHAT THIS CEILING REACHES, MEASURED RATHER THAN ASSUMED.
//
// This comment once ended "and removes the entire permanent exclusion set from
// the one path with no human on it", which reads as "unattended work cannot run
// a program". Measured, that was false in the direction that matters:
// `host.exec` was the only execution-shaped tool the nine-name exclusion set
// named, and six other execution-capable tools were admitted. The lane that
// found it pinned the true table and recorded the product question -- should a
// scheduled job with nobody watching be able to apply a Terraform plan? -- as
// open.
//
// IT IS NOW ANSWERED, in the safe direction. A confined tier admits only tools
// carrying a recorded confinement class in src/lib/confined-tool-surface.js, and
// refuses the ones that execute caller-influenced code on this machine.
// Measured against this exact ceiling:
//
//     host.exec                 REFUSED  (PERMISSION_CONFINED_EXCLUSION_REFUSED)
//     launch.execute            REFUSED  (PERMISSION_CONFINED_UNCONFINABLE_REFUSED)
//     deployment.execute        REFUSED  (PERMISSION_CONFINED_UNCONFINABLE_REFUSED)
//     terraform.apply           REFUSED  (PERMISSION_CONFINED_UNCONFINABLE_REFUSED)
//     firebase.deploy           REFUSED  (PERMISSION_CONFINED_UNCONFINABLE_REFUSED)
//     code.hover                REFUSED  (PERMISSION_CONFINED_UNCONFINABLE_REFUSED)
//     sandbox.exec              ADMITTED (the leased container is the confinement)
// THIS COST THE SCHEDULER TWO SUPPORTED ACTIONS, and that is stated plainly
// rather than left for someone to discover: `launch.execute` and
// `deployment.execute` are in SUPPORTED_SCHEDULED_ACTIONS and now refuse on this
// path. The alternative was to keep admitting tools whose whole behaviour is to
// run a project's own scripts, on the one path with no human present to see it.
//
// "Execution-capable" turned out to be the wrong axis, which is why the two
// admitted rows are kept in the table as the contrast: what matters is whether a
// tool reaches THIS MACHINE outside the folder the user granted.
//
// tests/permission-session-chokepoint.test.js pins the table above, so this
// paragraph cannot quietly drift back out of agreement with the behaviour.
//
// Guarded and confined/read-only were both rejected for the opposite reason:
// each permits only local-read/external-read, so either would refuse ALL eight
// scheduled actions and silently delete the scheduler rather than bound it.
const UNATTENDED_CEILING = Object.freeze({ origin: 'local', tier: 'confined', profile: 'workspace' });

/**
 * The ceiling for work that runs with no human present.
 *
 * The recorded level still applies and can only make this NARROWER: a `guided`
 * installation resolves to confined/read-only and its scheduled jobs refuse,
 * which is correct -- that installation cannot reach those tools interactively
 * either, so honouring the record is not a regression against it.
 *
 * There is deliberately no caller-supplied override. A ceiling the caller can
 * name is a ceiling the caller can raise, and the scheduler's own arguments are
 * durable state read back from a database. Tests bind the level by injecting
 * `machineRecord`, which is the same lever the recorded level itself uses.
 */
function unattendedSession(options = {}) {
  const recorded = recordedInstallSession(options);
  if (recorded.origin === 'local' && recorded.tier === 'full') {
    return permissionTierPolicy.session(UNATTENDED_CEILING);
  }
  return recorded;
}

module.exports = Object.freeze({
  UNATTENDED_CEILING,
  recordedInstallSession,
  unattendedSession
});
