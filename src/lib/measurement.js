'use strict';
// THREE-STATE MEASUREMENT. The single most expensive bug class in this project
// is a measurement that could not see something reporting that the thing is
// ABSENT.
//
// On 2026-08-03 that one mistake, wearing different clothes, produced: three
// racing durable workers (EPERM from process.kill read as "dead"), a Telegram
// dual-poller 409 that cost the owner's only inbound channel its diagnosis
// (empty CommandLine read as "no poller"), a listener reported unowned and
// unhealthy while serving traffic (task-owned process unreadable), and two
// separate agents each confidently telling the other a subsystem did not exist.
//
// The fix is not "be careful". It is to make the honest answer REPRESENTABLE and
// the dishonest one awkward. A boolean cannot express "I could not tell", so
// every caller that reduces observation to a boolean is one privilege boundary
// away from lying. This module returns three states and refuses to collapse
// them for you.
//
// THE RULE, and it is short enough to remember:
//   ALIVE        two agreeing positives, or one unambiguous one
//   ABSENT       two agreeing negatives
//   UNVERIFIABLE anything else -- INCLUDING every error you did not expect
//
// UNVERIFIABLE is not a failure of the measurement. It is the correct answer,
// and acting on it is the bug. Callers must branch on it explicitly; there is
// deliberately no truthiness shortcut.

const ALIVE = 'alive';
const ABSENT = 'absent';
const UNVERIFIABLE = 'unverifiable';

class Observation {
  constructor(state, via, detail) {
    this.state = state;
    this.via = via;
    this.detail = detail || null;
    Object.freeze(this);
  }

  // Deliberately NOT `isAlive()` returning a boolean. Naming it this way makes
  // the caller say which side of the uncertainty it is treating as acceptable,
  // instead of writing `if (probe())` and silently choosing "absent" for a
  // reading that never happened.
  get actionable() { return this.state === ALIVE || this.state === ABSENT; }

  toJSON() { return { state: this.state, via: this.via, detail: this.detail }; }
}

const alive = (via, detail) => new Observation(ALIVE, via, detail);
const absent = (via, detail) => new Observation(ABSENT, via, detail);
const unverifiable = (via, detail) => new Observation(UNVERIFIABLE, via, detail);

// --- process liveness --------------------------------------------------------
// process.kill(pid, 0) has THREE outcomes and code routinely writes two.
//   no throw -> the process exists and we may signal it
//   ESRCH    -> it genuinely does not exist
//   EPERM    -> IT EXISTS AND WE MAY NOT TOUCH IT. This is the one that gets
//               swallowed by `catch { return false }`, and it is exactly what a
//               scheduled task running S4U in another session looks like from an
//               ordinary session.
function observeProcess(pid, deps = {}) {
  const kill = deps.kill || process.kill.bind(process);
  let numeric;
  try {
    numeric = Number(pid);
  } catch (error) {
    return unverifiable('invalid-pid',
      `pid could not be converted to a number: ${String((error && error.message) || error).slice(0, 200)}`);
  }
  // Number() can round an unsafe integer to a different PID. Probing that
  // rounded process would turn "this PID cannot be represented exactly" into
  // a confident answer about another process.
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    return unverifiable('invalid-pid', `numeric pid ${numeric} is not a positive safe integer`);
  }
  try {
    kill(numeric, 0);
    return alive('signal-0-accepted');
  } catch (error) {
    const code = error && error.code;
    if (code === 'ESRCH') return absent('ESRCH');
    if (code === 'EPERM') {
      return unverifiable('EPERM',
        'the process exists but this privilege level may not signal it; treating it as dead is how duplicates get started');
    }
    return unverifiable(code || 'unknown-error', String((error && error.message) || error).slice(0, 200));
  }
}

// --- listener liveness: DELETED, not wired -----------------------------------
// This module used to export an observeListener(host, port) built the same
// way as observeProcess/observeCommandLine below (bind, then an independent
// connect, before reporting ABSENT) and documented as the preferred mechanism
// for listener liveness. It had zero callers anywhere in this repository --
// only its own definition and tests/measurement-honesty.js's Rule 6 mentioned
// it, and Rule 6 never actually exercised it (compare observeProcess and
// observeCommandLine, both directly asserted on there). A measurement
// function nobody calls proves nothing about what actually runs, and
// "preferred mechanism" documentation pointing at dead code actively
// misleads the next reader into assuming it is the supported path.
//
// It is not needed: listener liveness is measured a DIFFERENT way in every
// real caller, and that way is more thorough than a bind+connect from this
// process could ever be. src/lib/service-control.js's tcpPortHasListener()
// (cheap node:net connect, used only as a hint) falls through to
// defaultProbe() (tools/port-listener-probe.ps1: netstat cross-checked
// against Get-NetTCPConnection) whenever something answers, which is the
// SAME canonical probe tools/dashboard-task.ps1's Get-PortListeners uses and
// src/lib/supervision/observer.js's getListener()/listenerCache call through
// service-control.js's defaultProbe(). That probe can see a listener owned by
// a full-administrator token that this process cannot bind over or connect
// past -- exactly the EPERM-shaped blind spot this module's header warns
// about -- which a same-process bind/connect check structurally cannot. If a
// FUTURE caller needs listener liveness from inside this process rather than
// through service-control.js, prefer wiring it to that PowerShell probe route
// (or, if a pure node:net check is genuinely required, re-add a three-state
// version here and give it a real caller and a Rule in
// tests/measurement-honesty.js) rather than resurrecting this exact function
// dark.

// --- command-line identity ---------------------------------------------------
// An unelevated Win32_Process read returns an EMPTY CommandLine for a process
// owned by another session, notably any S4U scheduled task. Matching on that
// empty string yields "not our process", which is indistinguishable from "not
// running" and is how a healthy task-owned listener gets reported unowned.
//
// So emptiness is UNVERIFIABLE, never a mismatch. This is the single check that
// would have prevented three of tonight's seven incidents.
function observeCommandLine(commandLine, expectedSubstring) {
  if (commandLine === null || commandLine === undefined || String(commandLine).trim() === '') {
    return unverifiable('command-line-empty',
      'an empty command line means this privilege level cannot read the process, NOT that it is the wrong process');
  }
  const haystack = String(commandLine).toLowerCase();
  const needle = String(expectedSubstring || '').toLowerCase();
  if (!needle) return unverifiable('no-expected-substring');
  return haystack.includes(needle)
    ? alive('command-line-match')
    : absent('command-line-mismatch');
}

module.exports = Object.freeze({
  ALIVE, ABSENT, UNVERIFIABLE,
  Observation,
  alive, absent, unverifiable,
  observeProcess, observeCommandLine
});
