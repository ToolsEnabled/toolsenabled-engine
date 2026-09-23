'use strict';

// Coordinator duty registry (owner request R100).
//
// THE PROBLEM THIS FILE IS PART OF
//
// The coordinator role runs on two substrates. Durable scheduled processes
// such as the fleet supervisor and agent digest survive an agent handoff.
// Session-only inbox and health judgement lives inside whichever agent session
// holds the role and otherwise dies silently when the role moves.
//
// This registry declares the MECHANICAL half of that session state as DATA, so
// a durable process can run it.
//
// WHY JUDGEMENT DUTIES ARE DECLARED WITHOUT run()
//
// The dangerous failure mode of "port the coordinator to a daemon" is a daemon
// that starts answering the owner. So judgement duties are declared here with
// NO run() function at all, and validateRegistry() REFUSES any judgement entry
// that carries one. There is no code path by which the host can execute a
// judgement duty, because there is no code attached to execute. A judgement
// duty evaluates to a WAITING record naming what a human must decide.
//
// In particular: composing the reply text to an owner message is judgement.
// This file never imports ownerChat.reply. The host detects
// OWNER_WAITING_FOR_REPLY and escalates a NOTICE ABOUT the condition; it never
// sends him an answer.

const fs = require('node:fs');
const path = require('node:path');

const ownerChat = require('../owner-chat.js');
const managedProcesses = require('../managed-processes.js');
const health = require('../health-invariants.js');
const observer = require('../supervision/observer.js');
const policy = require('../supervision/policy.js');
const backupDuty = require('./backup-duty.js');
const backupObserver = require('./backup-observer.js');
const backupAgeStatus = require('./backup-age-status.js');
const backupExecutionGate = require('./backup-execution-gate.js');
const backupActivationRequest = require('./backup-activation-request.js');
const { DUTY_OUTCOME } = require('./heartbeat.js');
const { resolveServiceOrThrow } = require('../service-registry.js');

const ROOT = managedProcesses.ROOT;

const DUTY_KIND = Object.freeze({
  MECHANICAL: 'mechanical',
  JUDGEMENT: 'judgement'
});

// The dashboard listener the duty host probes. The regress terminates here:
// the duty host watches the dashboard, the dashboard watches the duty host,
// neither watches itself, and both are meant to hold registered scheduled
// tasks so the Windows scheduler is the actual bottom turtle.
/* RESOLVED WHEN IT IS NEEDED, NOT WHEN THIS FILE IS LOADED.
 *
 * This used to be a module-level const. On a CUSTOMER MACHINE that meant this
 * module could not be required at all: the shipped default service registry
 * (capability-defaults/config/service-registry.json) declares NO services --
 * deliberately, because the builder's own registry describes the builder's own
 * machines and none of that is any business of a customer -- so reading
 * `.dashboard.port` off it threw `TypeError: Cannot read properties of
 * undefined` before a single line of this module ran. Verified against the
 * registry actually installed on this machine.
 *
 * A module-scope throw is the worst shape available: it takes down every
 * importer, whether or not they were going to use the value, and it does it
 * with a raw TypeError rather than one of this product's named refusals. That
 * is how an unrelated module's identical line once made the coordinator's
 * whole escalation path unloadable.
 *
 * So it is a function, and a caller that genuinely needs the port gets a NAMED
 * refusal naming the thing that is missing. A caller that does not need it is
 * not punished for importing the file. */
let dashboardPortCache = null;
function dashboardPort() {
  if (dashboardPortCache === null) dashboardPortCache = resolveServiceOrThrow('dashboard').port;
  return dashboardPortCache;
}

// The action strings src/lib/supervision/policy.js#decide actually emits for
// "go fix this" -- read from that file, not assumed. 'restart' is listed only
// so a future rename of the vocabulary does not silently disable corrections.
const RESTART_ACTIONS = new Set(['correct', 'restart']);

// Sink error codes that mean "try again shortly", as opposed to "a human must
// look at this". Deliberately NARROW: of the five codes escalation-sink.js can
// throw (ESCALATION_INVALID, ESCALATION_LOOKS_SENSITIVE, ESCALATION_STATE_BUSY,
// ESCALATION_STATE_CORRUPT, ESCALATION_STATE_UNAVAILABLE) only the lock-contention
// one resolves itself. A corrupt state file, a malformed candidate or a refused
// payload all stay BROKEN, because each needs a person and none gets quieter by
// waiting. Erring toward BROKEN is the safe direction; the bug being fixed here
// was the reverse, treating a 25ms lock retry as a dead owner channel.
const TRANSIENT_SINK_CODES = new Set(['ESCALATION_STATE_BUSY']);

// ---------------------------------------------------------------- helpers

function dep(ctx, name, fallback) {
  const provided = ctx && ctx.deps ? ctx.deps[name] : undefined;
  return provided === undefined ? fallback : provided;
}

/**
 * Lazy-require a module owned by ANOTHER builder in this port. If it is not
 * on disk yet, the duty reports UNAVAILABLE naming the missing path -- it does
 * NOT stub, fake, or invent the module. A duty that cannot run must say so;
 * silent success on a duty that did not run is the exact failure mode this
 * whole port exists to eliminate.
 */
function optionalModule(ctx, name, relativePath) {
  const injected = ctx && ctx.deps ? ctx.deps[name] : undefined;
  if (injected !== undefined) return { ok: true, module: injected, reason: 'injected' };
  const absolute = path.resolve(__dirname, relativePath);
  try {
    fs.statSync(absolute);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        ok: false,
        code: 'COORDINATOR_OPTIONAL_MODULE_ABSENT',
        module: null,
        reason: `${relativePath} is not present on disk (owned by another builder in this port)`
      };
    }
    const cause = (error && error.code) || 'UNKNOWN';
    return {
      ok: false,
      code: 'COORDINATOR_OPTIONAL_MODULE_LOOKUP_UNAVAILABLE',
      module: null,
      reason: `${relativePath} could not be checked (${cause}); this does NOT claim the module is absent`
    };
  }
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return { ok: true, module: require(absolute), reason: 'required' };
  } catch (error) {
    return {
      ok: false,
      code: 'COORDINATOR_OPTIONAL_MODULE_LOAD_UNAVAILABLE',
      module: null,
      reason: `${relativePath} could not be loaded; this does NOT claim the module is absent: ${error && error.message}`
    };
  }
}

function unavailable(reason, detail = {}) {
  return { outcome: DUTY_OUTCOME.UNAVAILABLE, reason, detail };
}

function ok(detail = {}, reason = null) {
  return { outcome: DUTY_OUTCOME.OK, reason, detail };
}

function skipped(reason, detail = {}) {
  return { outcome: DUTY_OUTCOME.SKIPPED, reason, detail };
}

/**
 * Route an escalation through the sink another builder owns. Never throws:
 * a broken escalation channel is recorded as a FACT on the cycle so the
 * heartbeat can surface "escalation channel BROKEN". A sink that cannot
 * deliver must not look quiet.
 */
async function escalateVia(ctx, candidate) {
  const sinkModule = optionalModule(ctx, 'escalationSink', './escalation-sink.js');
  if (!sinkModule.ok) {
    ctx.cycle.escalationChannel = {
      state: 'UNKNOWN',
      reason: `escalation sink unavailable: ${sinkModule.reason}`,
      lastErrorAtMs: ctx.now(),
      lastSendAtMs: ctx.cycle.escalationChannel ? ctx.cycle.escalationChannel.lastSendAtMs : null
    };
    return { sent: false, available: false, reason: sinkModule.reason };
  }
  const sink = sinkModule.module;
  if (typeof sink.escalate !== 'function') {
    ctx.cycle.escalationChannel = {
      state: 'BROKEN',
      reason: 'escalation sink module exports no escalate() function',
      lastErrorAtMs: ctx.now(),
      lastSendAtMs: null
    };
    return { sent: false, available: false, reason: 'sink exports no escalate()' };
  }
  try {
    const result = await sink.escalate(candidate);

    // A RESOLVED CALL IS NOT A DELIVERED NOTICE.
    //
    // escalate() resolves normally for SUPPRESS_DUPLICATE / SUPPRESS_RATE_LIMIT /
    // SUPPRESS_QUIET_HOURS as well as SEND. Treating "the sink did not throw" as
    // "the owner was told" is the false-OK-from-a-suppressed-escalation failure
    // this port was written against, and it bites hardest on the one condition
    // R100 is about: the owner is left waiting, an unrelated subsystem alarm
    // trips the global 60s send floor, his notice is suppressed, and the duty
    // still reports escalated:true. So `delivered` is taken from the sink's own
    // decision, never inferred from the absence of an exception.
    const delivered = result && result.delivered === true;
    const decision = (result && result.decision) || 'UNKNOWN';

    if (delivered) {
      ctx.cycle.escalationChannel = {
        state: 'OK',
        reason: 'escalation sink delivered the notice',
        lastErrorAtMs: null,
        lastSendAtMs: ctx.now()
      };
    } else {
      // The wire was never exercised, so this cycle learned nothing about
      // whether the owner channel works. Do not claim OK and do not claim BROKEN;
      // preserve whatever the channel last genuinely showed.
      const previous = ctx.cycle.escalationChannel || {};
      ctx.cycle.escalationChannel = {
        state: previous.state || 'UNKNOWN',
        reason: `escalation suppressed by policy (${decision}); the wire was not exercised this cycle`,
        lastErrorAtMs: previous.lastErrorAtMs === undefined ? null : previous.lastErrorAtMs,
        lastSendAtMs: previous.lastSendAtMs === undefined ? null : previous.lastSendAtMs
      };
    }
    return { sent: true, available: true, delivered, decision, result };
  } catch (error) {
    const code = (error && error.code) || 'UNKNOWN';

    // TRANSIENT CONTENTION IS NOT A BROKEN CHANNEL.
    //
    // escalation-sink.js#withLock throws ESCALATION_STATE_BUSY after 5 retries
    // when another writer (the duty host's own cycle, or tools/coordinator-escalate.js
    // run by hand) holds the advisory lock on state/coordinator-escalation.json.
    // That means "I could not take the lock in this instant", NOT "the wire to
    // the owner is dead" -- the escalation is still owed and the next cycle
    // retries it 30s later.
    //
    // Rendering it as BROKEN produced the loudest possible false alarm on the
    // single channel that carries every other alarm, which is precisely how a
    // reader gets trained to ignore it. The two conditions also demand opposite
    // responses: contention resolves itself, a broken channel needs a human.
    // So they must not share a word. UNKNOWN is the honest band -- we did not
    // reach the wire, so we learned nothing about whether it works.
    if (TRANSIENT_SINK_CODES.has(code)) {
      const previous = ctx.cycle.escalationChannel || {};
      ctx.cycle.escalationChannel = {
        state: 'UNKNOWN',
        reason: `escalation deferred: the sink state file was busy (${code}). `
          + 'This says nothing about whether the owner journal works; the escalation is still owed '
          + 'and the next cycle retries it.',
        lastErrorAtMs: ctx.now(),
        lastSendAtMs: previous.lastSendAtMs === undefined ? null : previous.lastSendAtMs
      };
      return { sent: false, available: true, deferred: true, reason: code };
    }

    ctx.cycle.escalationChannel = {
      state: 'BROKEN',
      reason: `escalation sink threw ${code}: ${String(error && error.message).slice(0, 300)}`,
      lastErrorAtMs: ctx.now(),
      lastSendAtMs: null
    };
    return { sent: false, available: true, reason: code };
  }
}

// ---------------------------------------------------------------- duties

// 1. DRAIN-DETECT THE OWNER INBOX. Detection only. summarize() is documented
//    as never throwing: a reader that cannot look reports UNAVAILABLE loudly
//    rather than taking down its host.
async function runOwnerInboxDetect(ctx) {
  const chat = dep(ctx, 'ownerChat', ownerChat);
  const summary = chat.summarize({ now: ctx.now });
  ctx.cycle.ownerInbox = summary;

  const detail = {
    condition: summary.condition,
    ownerWaiting: Boolean(summary.ownerWaiting),
    unread: summary.unread,
    ownerUnread: summary.ownerUnread,
    waitingMs: summary.waitingMs,
    staleThresholdMs: summary.staleThresholdMs,
    lastDrainedAtMs: summary.lastDrainedAtMs,
    drainCommand: summary.drainCommand
  };

  if (summary.condition === chat.CONDITIONS.UNAVAILABLE) {
    return unavailable('the owner inbox could not be read; whether he is waiting is UNKNOWN', detail);
  }
  return ok(detail, `owner inbox condition ${summary.condition}`);
}

// 2. ESCALATE OWNER_WAITING_FOR_REPLY -- the highest-priority state in this
//    system. The notice is ABOUT the condition. It is NEVER a reply to him:
//    this function does not have access to ownerChat.reply and must not gain
//    it.
async function runOwnerWaitingEscalate(ctx) {
  const chat = dep(ctx, 'ownerChat', ownerChat);
  const summary = ctx.cycle.ownerInbox || chat.summarize({ now: ctx.now });

  if (summary.condition !== chat.CONDITIONS.OWNER_WAITING_FOR_REPLY) {
    return ok({ condition: summary.condition, escalated: false },
      `no escalation: condition is ${summary.condition}`);
  }
  if (ctx.killSwitchActive) {
    return skipped('kill switch is active; outward escalation suppressed', { condition: summary.condition });
  }

  const waitingMinutes = Math.round((summary.waitingMs || 0) / 60000);
  const outcome = await escalateVia(ctx, {
    subsystemId: 'owner-inbox',
    state: 'OWNER_WAITING_FOR_REPLY',
    // Deliberately describes the CONDITION and names the human action. It
    // carries no owner message text: the heartbeat and the escalation are
    // both machine surfaces and his words belong in the inbox, not here.
    reason: `The owner has an unread message waiting ${waitingMinutes} minute(s) with no agent reply. `
      + `No agent currently holds the coordinator role's reply duty. Run ${summary.drainCommand} and answer him.`
  });

  if (!outcome.available) {
    return unavailable(`owner is waiting but the escalation sink is unavailable: ${outcome.reason}`,
      { condition: summary.condition, waitingMs: summary.waitingMs, escalated: false });
  }
  if (!outcome.sent) {
    return { outcome: DUTY_OUTCOME.FAILED, reason: `escalation sink refused or failed: ${outcome.reason}`, detail: { condition: summary.condition, escalated: false } };
  }
  if (!outcome.delivered) {
    // The condition still holds and the owner still has not been told. This is
    // not a duty FAILURE -- the rate limiter is working as declared -- but it
    // must never read as "escalated". The condition persists, so the next cycle
    // re-evaluates and sends once the floor clears.
    return ok({
      condition: summary.condition,
      waitingMs: summary.waitingMs,
      escalated: false,
      suppressedDecision: outcome.decision
    }, `OWNER IS STILL WAITING AND HAS NOT BEEN NOTIFIED: the notice was suppressed by policy (${outcome.decision}). Retrying next cycle.`);
  }
  return ok({ condition: summary.condition, waitingMs: summary.waitingMs, escalated: true },
    'escalated OWNER_WAITING_FOR_REPLY as a notice about the condition');
}

// 3. ACKNOWLEDGE MACHINE-SOURCED DIRECTIVES.
//
//    Narrow on purpose. The host acknowledges ONLY directives it recorded as
//    actioned itself this cycle (ctx.cycle.actionedDirectiveIds). It never
//    walks the inbox filing away things it did not handle -- that would be
//    "make the loud condition go away", which is how the inbox went
//    write-only in the first place.
//
//    Structural backstop: ownerChat.acknowledgeWithoutReply throws
//    OWNER_CHAT_NEEDS_A_REPLY on any owner-sourced item, so even a bug here
//    cannot file one of his messages.
async function runMachineDirectiveAck(ctx) {
  const chat = dep(ctx, 'ownerChat', ownerChat);
  const ids = Array.isArray(ctx.cycle.actionedDirectiveIds) ? ctx.cycle.actionedDirectiveIds : [];
  if (ids.length === 0) {
    return ok({ acknowledged: 0, refused: 0 }, 'no machine-sourced directive was actioned by the host this cycle');
  }

  const acknowledged = [];
  const refused = [];
  for (const id of ids) {
    try {
      chat.acknowledgeWithoutReply({
        id,
        actor: 'coordinator-duty-host',
        note: 'Actioned mechanically by the coordinator duty host; no human reply was required.'
      });
      acknowledged.push(id);
    } catch (error) {
      // OWNER_CHAT_NEEDS_A_REPLY lands here. That is the guard working, and it
      // is REPORTED, not swallowed.
      refused.push({ id, code: (error && error.code) || 'UNKNOWN' });
    }
  }
  return ok({ acknowledged: acknowledged.length, refused },
    `acknowledged ${acknowledged.length} machine-sourced directive(s); ${refused.length} refused`);
}

// 5. ARGV DRIFT DETECTION. src/lib/argv-drift.js is owned by the
//    argv-authority builder. If it is not on disk this duty reports
//    UNAVAILABLE naming the file; it does not reimplement it.
async function runArgvDriftDetect(ctx) {
  const driftModule = optionalModule(ctx, 'argvDrift', '../argv-drift.js');
  if (!driftModule.ok) {
    return unavailable(`argv drift cannot be evaluated: ${driftModule.reason}`, { module: 'src/lib/argv-drift.js' });
  }
  const argvDrift = driftModule.module;
  if (typeof argvDrift.detectAllDrift !== 'function') {
    return unavailable('src/lib/argv-drift.js exports no detectAllDrift() function', { module: 'src/lib/argv-drift.js' });
  }

  // Real signature (read from the module, not assumed):
  //   detectAllDrift({ processes, registryFile, root, collect }) ->
  //     { observedAtMs, processTableReadable, drifted: [id], unknown: [id], records }
  const result = await argvDrift.detectAllDrift({});
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.processTableReadable !== 'boolean'
    || !result.records || typeof result.records !== 'object' || Array.isArray(result.records)
    || !Array.isArray(result.drifted) || !Array.isArray(result.unknown)) {
    return unavailable('argv drift detector returned an incomplete result; drift is UNKNOWN', { checked: 0 });
  }
  const records = result.records;
  const drifted = result.drifted;
  const unknownIds = result.unknown;

  // UNKNOWN is reported as its own bucket, never folded into "no drift". An
  // unreadable command line is not a clean bill of health -- and it is not a
  // liveness verdict either. Whether a real drift is an intended override or a
  // defect is a JUDGEMENT duty (adjudicate-argv-drift).
  const detail = {
    checked: Object.keys(records).length,
    processTableReadable: Boolean(result && result.processTableReadable),
    drifted: drifted.length,
    unknown: unknownIds.length,
    driftedIds: drifted,
    unknownIds,
    records: drifted.map(id => {
      const record = records[id] || {};
      return {
        id,
        state: record.state,
        declaredArgv: record.declaredArgv,
        liveArgv: record.liveArgv || (record.candidates && record.candidates[0] ? record.candidates[0].argv : null),
        missing: record.missing || null,
        extra: record.extra || null,
        reason: record.reason || null
      };
    })
  };

  if (!detail.processTableReadable) {
    return unavailable('the live process table could not be read, so argv drift is UNKNOWN (this is not a liveness claim)', detail);
  }
  if (detail.checked === 0) {
    return unavailable('argv drift detector scanned zero declared processes; no-drift cannot be established', detail);
  }
  return ok(detail,
    `${drifted.length} declared process(es) differ from their declared argv; ${unknownIds.length} not comparable`);
}

// 6. SCHEDULED-TASK REGISTRATION CHECK. A DURABILITY fact, reported
//    INDEPENDENTLY of liveness. Collapsing "cannot self-restart" into the same
//    word as "is not running" is exactly what made the health observer emit
//    FALSE DOWN for two demonstrably alive processes.
async function runTaskRegistrationCheck(ctx) {
  const registry = dep(ctx, 'managedProcesses', managedProcesses);
  const obs = dep(ctx, 'observer', observer);

  const entries = registry.listProcesses();
  if (!Array.isArray(entries)) {
    return unavailable('managed process registry could not provide a process list; registration is UNKNOWN',
      { declaredTasks: null });
  }
  const taskNames = entries.map(entry => entry.taskName).filter(Boolean);
  if (taskNames.length === 0) {
    return unavailable('managed process registry declared zero scheduled tasks; ALL_REGISTERED cannot be established',
      { declaredTasks: 0 });
  }
  const tasks = obs.collectScheduledTasks(taskNames);

  if (tasks === undefined) {
    // Could not look. UNKNOWN, never NOT_REGISTERED.
    return unavailable('Task Scheduler could not be queried; registration is UNKNOWN, not absent',
      { declaredTasks: taskNames.length });
  }

  const registered = [];
  const notRegistered = [];
  for (const entry of entries) {
    if (!entry.taskName) continue;
    const found = tasks.get(entry.taskName);
    if (found) registered.push({ id: entry.id, taskName: entry.taskName, state: found.state });
    else notRegistered.push({ id: entry.id, taskName: entry.taskName });
  }

  return ok({
    durability: notRegistered.length === 0 ? 'ALL_REGISTERED' : 'SOME_NOT_REGISTERED',
    registered,
    notRegistered,
    note: 'DURABILITY only. A NOT_REGISTERED subsystem may still be alive and working; it simply cannot self-restart.'
  }, `${registered.length} declared task(s) registered, ${notRegistered.length} not registered`);
}

// 9. DASHBOARD LISTENER PROBE. Terminates the watcher regress: the dashboard
//    reads the duty host's heartbeat, so the duty host checks that the
//    dashboard is still listening.
//
//    The probe can confirm that SOMETHING holds the port but not that it is
//    the declared server -- the listener's command line is unreadable from an
//    unelevated session. Reporting UNKNOWN there is correct and must never be
//    "fixed" into OK.
async function runDashboardListenerProbe(ctx) {
  const probe = ctx.probeListener;
  if (typeof probe !== 'function') {
    return unavailable('no listener probe is available in this context', { port: dashboardPort() });
  }

  let snapshot;
  try {
    snapshot = await probe(dashboardPort());
  } catch (error) {
    return unavailable(`the listener probe for port ${dashboardPort()} failed: ${(error && error.code) || error}`,
      { port: dashboardPort(), listening: 'UNKNOWN' });
  }

  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.listeners)) {
    return unavailable(`the listener probe for port ${dashboardPort()} returned an incomplete result; listening is UNKNOWN`,
      { port: dashboardPort(), listening: 'UNKNOWN' });
  }
  const listeners = snapshot.listeners;
  const listener = listeners.find(item => item && item.pid) || null;

  if (listener) {
    return ok({
      port: dashboardPort(),
      listening: true,
      pid: listener.pid,
      identity: 'UNKNOWN',
      note: 'something holds the port; whether it is the declared dashboard server is UNKNOWN from an unelevated session'
    }, `port ${dashboardPort()} has a listener (pid ${listener.pid})`);
  }

  if (ctx.killSwitchActive) {
    return skipped('kill switch is active; outward escalation suppressed', { port: dashboardPort(), listening: false });
  }
  const outcome = await escalateVia(ctx, {
    subsystemId: 'dashboard',
    state: 'DOWN',
    reason: `Nothing is listening on 127.0.0.1:${dashboardPort()}. The dashboard is the surface that reports whether the `
      + 'coordinator duty host is alive, so while it is down nobody is watching the watcher.'
  });
  return ok({ port: dashboardPort(), listening: false, escalated: outcome.delivered === true },
    `nothing is listening on port ${dashboardPort()}`);
}

// 10. BOUNDED RESTART OF A DECLARED PROCESS.
//
//     REPORT-ONLY BY DEFAULT (ctx.allowRestart === false). Restarting a
//     subsystem is the single most destructive thing this host can do, and
//     restarting the fleet supervisor without --project is a verified past
//     incident. The decision is computed and reported every cycle so the gap
//     is visible; actually spawning requires an explicit opt-in.
//
//     Even when enabled, a restart requires ALL of: liveness genuinely DOWN,
//     checkArgvPreconditions passing, kill switch inactive, and
//     supervision/policy.js#decide permitting it. A restart whose
//     preconditions fail is REPORTED, never attempted.
async function runBoundedRestart(ctx) {
  const registry = dep(ctx, 'managedProcesses', managedProcesses);
  const obs = dep(ctx, 'observer', observer);
  const pol = dep(ctx, 'policy', policy);
  const invariants = dep(ctx, 'health', health);

  let snapshot;
  try {
    snapshot = obs.sweep({ now: ctx.now });
  } catch (error) {
    return unavailable(`health sweep failed: ${error && error.message}`, {});
  }

  const subsystems = (snapshot && snapshot.subsystems) || {};
  const considered = [];

  for (const [id, verdict] of Object.entries(subsystems)) {
    if (!verdict || verdict.state !== invariants.STATE.DOWN) continue;

    const record = { id, state: verdict.state, reason: verdict.reason, action: 'none', outcome: null, attempted: false };

    // A DOWN THAT MEANS "NOT REGISTERED" IS NOT A DOWN THAT A RESTART FIXES.
    //
    // health-invariants.js#evaluateSubsystem returns at the FIRST failing rung
    // and maps RUNG_FAILURE_STATE.registered to STATE.DOWN, so a subsystem whose
    // scheduled task is merely absent reports DOWN with `registered` as the only
    // rung ever evaluated -- the `alive` rung is not reached. That is a
    // DURABILITY fact ("the OS cannot restart it") collapsed into the same word
    // as a LIVENESS fact ("it is not running"), which is breakage 3 of this port.
    //
    // Measured, not inferred: with the duty host running healthily as pid 34848
    // and its heartbeat 5s old, the sweep reported coordinator-duty-host DOWN /
    // failedRung=registered, policy said action=correct, and preconditions
    // passed. Under --allow-restart this duty would have spawned a SECOND duty
    // host against a perfectly healthy one, every cycle. Spawning a process
    // cannot register a scheduled task, so the "correction" could never even
    // clear the condition it was reacting to.
    //
    // The registration gap is real and still needs fixing -- by an elevated
    // registrar run, which this duty reports rather than attempts.
    if (verdict.failedRung === 'registered') {
      record.action = 'none';
      record.outcome = 'RESTART_INAPPLICABLE_NOT_REGISTERED';
      record.decisionReason = 'DOWN here is a DURABILITY fact (no scheduled task), not a liveness '
        + 'fact; the alive rung was never evaluated. A restart cannot register a task. '
        + 'Fix with an elevated run of the registrar (node tools/register-managed-tasks.js prints it).';
      considered.push(record);
      continue;
    }

    let decision;
    try {
      decision = pol.decide(verdict, { nowMs: ctx.now(), killSwitchActive: ctx.killSwitchActive });
    } catch (error) {
      record.outcome = 'POLICY_ERROR';
      record.reason = `policy.decide threw: ${error && error.message}`;
      considered.push(record);
      continue;
    }
    record.action = decision.action;
    record.outcome = decision.outcome;
    record.decisionReason = decision.reason;

    // The action vocabulary is policy.js's, verified by reading it: it emits
    // 'none' | 'quarantine' | 'correct'. It NEVER emits 'restart'. Matching on
    // 'restart' (the obvious guess) would have made --allow-restart a silent
    // no-op forever -- a duty reporting success while doing nothing, which is
    // the failure mode this port exists to eliminate.
    if (!RESTART_ACTIONS.has(decision.action)) { considered.push(record); continue; }

    // A registry entry can describe a Task Scheduler wrapper whose real launch
    // contract is not `node <resolved argv>`.  Reporting that fact is safer
    // than feeding a PowerShell program to node.exe and claiming a restart was
    // attempted.  The scheduler remains the sole authority for those entries.
    try {
      if (typeof registry.correctionMode === 'function'
          && registry.correctionMode(id) === 'report-only') {
        record.outcome = 'RESTART_INAPPLICABLE_LAUNCH_CONTRACT';
        record.decisionReason = 'the managed-process declaration is report-only because its Task Scheduler launch contract cannot be reproduced by the direct Node spawner';
        considered.push(record);
        continue;
      }
    } catch (error) {
      record.outcome = 'CORRECTION_MODE_UNRESOLVABLE';
      record.decisionReason = `correctionMode(${id}) threw: ${error && error.message}`;
      considered.push(record);
      continue;
    }

    let argv;
    try {
      argv = registry.resolveArgv(id);
    } catch (error) {
      record.outcome = 'ARGV_UNRESOLVABLE';
      record.decisionReason = `resolveArgv(${id}) threw: ${error && error.message}`;
      considered.push(record);
      continue;
    }

    const preconditions = registry.checkArgvPreconditions(id, argv);
    record.preconditions = preconditions;
    if (!preconditions.ok) {
      record.outcome = preconditions.code;
      record.decisionReason = preconditions.reason;
      considered.push(record);
      continue;
    }

    if (!ctx.allowRestart) {
      record.outcome = 'RESTART_WITHHELD_REPORT_ONLY';
      record.decisionReason = 'the duty host is running report-only; pass --allow-restart to permit bounded restarts';
      considered.push(record);
      continue;
    }
    if (typeof ctx.spawnManaged !== 'function') {
      record.outcome = 'NO_SPAWNER';
      record.decisionReason = 'no spawnManaged function is available in this context';
      considered.push(record);
      continue;
    }

    try {
      const spawned = await ctx.spawnManaged(id, argv);
      record.attempted = true;
      record.outcome = 'RESTART_ATTEMPTED';
      record.spawnedPid = spawned && spawned.pid ? spawned.pid : null;
      if (typeof pol.recordAttempt === 'function') {
        try { pol.recordAttempt(id, { nowMs: ctx.now() }); } catch { /* accounting failure must not hide the attempt */ }
      }
    } catch (error) {
      record.outcome = 'RESTART_SPAWN_FAILED';
      record.decisionReason = String(error && error.message).slice(0, 300);
    }
    considered.push(record);
  }

  return ok({
    allowRestart: Boolean(ctx.allowRestart),
    downSubsystems: considered.length,
    attempted: considered.filter(record => record.attempted).length,
    decisions: considered
  }, considered.length === 0
    ? 'no declared subsystem is DOWN'
    : `${considered.length} DOWN subsystem(s) evaluated, ${considered.filter(r => r.attempted).length} restart(s) attempted`);
}

// 11. ESCALATION BUDGET REPORT. Reads the sink's own suppression accounting so
//     the heartbeat can carry escalationsSuppressed. A suppressed escalation
//     is indistinguishable from no escalation unless it is counted.
async function runEscalationBudgetReport(ctx) {
  const sinkModule = optionalModule(ctx, 'escalationSink', './escalation-sink.js');
  if (!sinkModule.ok) {
    ctx.cycle.escalationsSuppressed = null;
    return unavailable(`escalation budget unknown: ${sinkModule.reason}`, { module: 'src/lib/coordinator/escalation-sink.js' });
  }
  const sink = sinkModule.module;
  if (typeof sink.sinkStatus !== 'function') {
    ctx.cycle.escalationsSuppressed = null;
    return unavailable('escalation sink exports no sinkStatus() function', {});
  }

  const status = await sink.sinkStatus();
  const suppressed = status && typeof status.suppressed === 'number'
    ? status.suppressed
    : (status && typeof status.escalationsSuppressed === 'number' ? status.escalationsSuppressed : null);
  ctx.cycle.escalationsSuppressed = suppressed;
  return ok({ suppressed, status }, suppressed === null
    ? 'escalation sink reported no suppression count'
    : `${suppressed} escalation(s) suppressed by policy`);
}

// 12. BACKUP DEFINITION REPORT. This is intentionally the first Q37 slice:
// it validates the declared future backup contract from the existing duty
// host, but performs none of the future copy, bundle, manifest, retention, or
// task-registration operations. A missing/invalid declaration stays loud.
async function runBackupDefinitionReport(ctx) {
  const module = dep(ctx, 'backupDuty', backupDuty);
  if (!module || typeof module.loadDefinition !== 'function') {
    return unavailable('backup duty definition reader is unavailable', { module: 'src/lib/coordinator/backup-duty.js' });
  }
  const verdict = module.loadDefinition();
  if (!verdict || verdict.valid !== true || !verdict.definition) {
    return unavailable('backup duty definition is invalid or unavailable', {});
  }
  const definition = verdict.definition;
  const artifactPlanIsSafe = Array.isArray(definition.plannedArtifacts)
    && definition.plannedArtifacts.length === backupDuty.REQUIRED_ARTIFACTS.length
    && backupDuty.REQUIRED_ARTIFACTS.every(value => definition.plannedArtifacts.includes(value));
  const summaryIsSafe = definition.id === 'recurring-backup-definition'
    && definition.host === 'coordinator-duty-host'
    && definition.mode === 'report-only'
    && Number.isSafeInteger(definition.intervalMs)
    && definition.intervalMs >= 60_000
    && definition.destinationKind === 'local-directory'
    && Number.isSafeInteger(definition.retentionMaxSnapshots)
    && definition.retentionMaxSnapshots >= 1
    && definition.retentionMaxSnapshots <= 365
    && artifactPlanIsSafe
    && definition.safety && definition.safety.registerScheduledTask === false
    && definition.safety.createArtifacts === false
    && definition.safety.deleteArtifacts === false
    && definition.safety.readVaultContents === false
    && definition.safety.readDestinationMetadata === true;
  if (!summaryIsSafe) {
    return unavailable('backup duty definition reader returned an unsafe or incomplete report-only summary', {});
  }
  return ok({
    id: definition.id,
    host: definition.host,
    mode: definition.mode,
    intervalMs: definition.intervalMs,
    destinationKind: definition.destinationKind,
    retentionMaxSnapshots: definition.retentionMaxSnapshots,
    plannedArtifacts: [...definition.plannedArtifacts],
    safety: { ...definition.safety },
    execution: 'report-only',
    artifactsCreated: 0,
    artifactsDeleted: 0,
    scheduledTaskRegistered: false,
    vaultContentsRead: false
  }, 'backup duty definition is valid; report-only foundation made no backup changes');
}

// 13. BACKUP AGE OBSERVATION. This consumes only direct child-directory
// metadata through the Q37 observer. The configured path is deliberately not
// included in the duty detail: the heartbeat is a dashboard-facing surface.
// It still does not read backup/vault contents, create a manifest, or write.
async function runBackupObservationReport(ctx) {
  const definitionModule = dep(ctx, 'backupDuty', backupDuty);
  const observerModule = dep(ctx, 'backupObserver', backupObserver);
  const projectionModule = dep(ctx, 'backupAgeStatus', backupAgeStatus);
  const nowMs = typeof ctx.now === 'function' ? ctx.now() : Date.now();
  if (!definitionModule || typeof definitionModule.loadObservationTarget !== 'function'
    || !observerModule || typeof observerModule.observeBackupDestination !== 'function'
    || !projectionModule || typeof projectionModule.projectBackupAgeStatus !== 'function') {
    return unavailable('backup age observation dependencies are unavailable', {});
  }
  const target = definitionModule.loadObservationTarget();
  if (!target || target.valid !== true || !target.target
    || typeof target.target.destinationPath !== 'string') {
    return unavailable('backup age observation target is unavailable', {});
  }
  let observation;
  let projection;
  try {
    observation = observerModule.observeBackupDestination(target.target.destinationPath, { nowMs });
    projection = projectionModule.projectBackupAgeStatus(observation, { nowMs });
  } catch {
    return unavailable('backup age observation is unavailable', {});
  }
  if (!projection || projection.status === 'unavailable') {
    return unavailable('backup age is unavailable; no trusted snapshot metadata was observed', {
      status: 'unavailable',
      contentTrust: 'untrusted',
      grantsAuthority: false,
      backupExistence: 'not-asserted'
    });
  }
  return ok({ ...projection }, `backup age observation is ${projection.status}; metadata does not assert backup contents or existence`);
}

// 14. BACKUP EXECUTION GATE. This is a dashboard-truthfulness duty, not an
// executor. It has no destination path, artifact bytes, or activation token;
// the only successful state is explicitly BLOCKED by report-only policy.
const BACKUP_GATE_REPORT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'executionAuthorized', 'activationRequired',
  'mode', 'intervalMs', 'retentionMaxSnapshots', 'plannedArtifacts',
  'artifactsCreated', 'artifactsDeleted', 'scheduledTaskRegistered',
  'vaultContentsRead', 'backupExistence', 'contentTrust', 'activationContract'
]);
const BACKUP_GATE_ARTIFACTS = Object.freeze([
  'git-bundle', 'vault-state-copy', 'manifest-sha256', 'retention-prune'
]);

// This accepts only ordinary frozen data. In particular, do not read values
// from accessors or proxy-backed objects and then surface them to the dashboard:
// a dependency result is untrusted until it passes this boundary.
function isExactFrozenDataObject(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value)) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return false;
    return ownKeys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value')
        && descriptor.enumerable === true && descriptor.configurable === false && descriptor.writable === false;
    });
  } catch {
    return false;
  }
}

function isExactFrozenStringArray(value, expected) {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !Object.isFrozen(value)
      || value.length !== expected.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value !== expected[index]
        || descriptor.enumerable !== true || descriptor.configurable !== false || descriptor.writable !== false) return false;
    }
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    return length && length.value === expected.length && length.writable === false
      && length.enumerable === false && length.configurable === false
      && Reflect.ownKeys(value).length === expected.length + 1;
  } catch {
    return false;
  }
}

function isCanonicalNonAuthorizingActivationContract(value) {
  const canonical = backupActivationRequest.activationContractSummary();
  const keys = Object.keys(canonical);
  if (!isExactFrozenDataObject(value, keys)) return false;
  try {
    return keys.every(key => value[key] === canonical[key]);
  } catch {
    return false;
  }
}

function isSafeBlockedBackupGateReport(result) {
  if (!isExactFrozenDataObject(result, BACKUP_GATE_REPORT_KEYS)) return false;
  try {
    return result.schemaVersion === 1
      && result.kind === 'backup-execution-gate'
      && result.status === 'blocked'
      && result.executionAuthorized === false
      && result.activationRequired === true
      && result.mode === 'report-only'
      && Number.isSafeInteger(result.intervalMs) && result.intervalMs >= 60_000
      && Number.isSafeInteger(result.retentionMaxSnapshots)
      && result.retentionMaxSnapshots >= 1 && result.retentionMaxSnapshots <= 365
      && isExactFrozenStringArray(result.plannedArtifacts, BACKUP_GATE_ARTIFACTS)
      && result.artifactsCreated === 0
      && result.artifactsDeleted === 0
      && result.scheduledTaskRegistered === false
      && result.vaultContentsRead === false
      && result.backupExistence === 'not-asserted'
      && result.contentTrust === 'untrusted'
      && isCanonicalNonAuthorizingActivationContract(result.activationContract);
  } catch {
    return false;
  }
}

async function runBackupExecutionGateReport(ctx) {
  const definitionModule = dep(ctx, 'backupDuty', backupDuty);
  const gateModule = dep(ctx, 'backupExecutionGate', backupExecutionGate);
  if (!definitionModule || typeof definitionModule.loadDefinition !== 'function'
    || !gateModule || typeof gateModule.evaluateBackupExecutionGate !== 'function') {
    return unavailable('backup execution gate dependencies are unavailable', {});
  }
  const loaded = definitionModule.loadDefinition();
  if (!loaded || loaded.valid !== true || !loaded.definition) {
    return unavailable('backup execution gate definition is invalid or unavailable', {});
  }
  let result;
  try {
    result = gateModule.evaluateBackupExecutionGate(loaded.definition);
  } catch {
    return unavailable('backup execution gate is unavailable', {});
  }
  if (!isSafeBlockedBackupGateReport(result)) {
    return unavailable('backup execution gate returned an unsafe or incomplete report', {});
  }
  return ok(result, 'backup execution is deliberately blocked by report-only policy; no backup artifact action was attempted');
}

// ------------------------------------------------------------ the registry

const DUTIES = Object.freeze([
  Object.freeze({
    id: 'owner-inbox-detect',
    kind: DUTY_KIND.MECHANICAL,
    intervalMs: 30_000,
    description: 'Read the owner inbox and classify OWNER_WAITING_FOR_REPLY / OWNER_MESSAGE_UNREAD / DIRECTIVES_UNREAD / CLEAR / UNAVAILABLE. Detection only.',
    run: runOwnerInboxDetect
  }),
  Object.freeze({
    id: 'owner-waiting-escalate',
    kind: DUTY_KIND.MECHANICAL,
    intervalMs: 60_000,
    outward: true,
    description: 'When an owner-sourced message has been unread past STALE_UNREAD_MS, send a notice ABOUT that condition. Never a reply to him.',
    run: runOwnerWaitingEscalate
  }),
  Object.freeze({
    id: 'machine-directive-ack',
    kind: DUTY_KIND.MECHANICAL,
    intervalMs: 60_000,
    description: 'Acknowledge (without replying) only the machine-sourced directives the host itself actioned this cycle.',
    run: runMachineDirectiveAck
  }),
  // A removed wake-signal monitor tailed a producer that no longer exists; it
  // would only report an empty file forever.
  Object.freeze({
    id: 'argv-drift-detect',
    kind: DUTY_KIND.MECHANICAL,
    intervalMs: 120_000,
    description: 'Compare every live declared process command line against managedProcesses.resolveArgv(id) and report drift as its own fact.',
    run: runArgvDriftDetect
  }),
  Object.freeze({
    id: 'task-registration-check',
    kind: DUTY_KIND.MECHANICAL,
    intervalMs: 300_000,
    description: 'Report per declared taskName whether the OS task exists. DURABILITY, reported independently of liveness.',
    run: runTaskRegistrationCheck
  }),
  // Removed provider-process probes no longer have a process to measure. Their
  // removal narrows what this host can escalate about; it does not widen the
  // escalation policy.
  Object.freeze({
    id: 'dashboard-listener-probe',
    kind: DUTY_KIND.MECHANICAL,
    intervalMs: 120_000,
    outward: true,
    /* THE PORT IS NOT INTERPOLATED HERE, and that is not cosmetic. DUTIES is
       frozen module-scope data, so a template literal in a description is
       evaluated while this file is LOADING -- and on a customer machine the
       shipped registry declares no dashboard, so resolving it threw and took
       the whole coordinator down at require time. The duty reports the real
       port in its RESULT, where a caller has actually asked for it. */
    description: 'Confirm something still listens on the registered loopback dashboard port. Terminates the watcher regress; identity stays UNKNOWN unelevated.',
    run: runDashboardListenerProbe
  }),
  Object.freeze({
    id: 'bounded-restart',
    kind: DUTY_KIND.MECHANICAL,
    intervalMs: 120_000,
    outward: true,
    description: 'Evaluate DOWN subsystems against supervision policy and argv preconditions. Report-only unless --allow-restart.',
    run: runBoundedRestart
  }),
  Object.freeze({
    id: 'escalation-budget-report',
    kind: DUTY_KIND.MECHANICAL,
    intervalMs: 60_000,
    description: 'Read the escalation sink suppression accounting so every suppressed escalation is counted and surfaced.',
    run: runEscalationBudgetReport
  }),
  Object.freeze({
    id: 'backup-definition-report',
    kind: DUTY_KIND.MECHANICAL,
    intervalMs: 300_000,
    description: 'Validate the report-only recurring-backup definition. It does not create, copy, prune, hash, schedule, or read vault contents.',
    run: runBackupDefinitionReport
  }),
  Object.freeze({
    id: 'backup-observation-report',
    kind: DUTY_KIND.MECHANICAL,
    intervalMs: 300_000,
    description: 'Read direct future snapshot-directory metadata only and project a redacted fresh/stale/unavailable backup age. It does not read content, create, copy, prune, hash, schedule, or read vault contents.',
    run: runBackupObservationReport
  }),
  Object.freeze({
    id: 'backup-execution-gate-report',
    kind: DUTY_KIND.MECHANICAL,
    intervalMs: 300_000,
    description: 'Surface that recurring backup execution is deliberately blocked by report-only policy. It does not create, copy, prune, hash, schedule, or read vault contents.',
    run: runBackupExecutionGateReport
  }),

  // ---- JUDGEMENT. No run(). validateRegistry() refuses one that has it. ----

  Object.freeze({
    id: 'compose-owner-reply',
    kind: DUTY_KIND.JUDGEMENT,
    description: 'Composing the reply text to an owner message. The host detects and escalates OWNER_WAITING_FOR_REPLY; a human writes the answer.',
    humanAction: 'node tools/owner-chat.js --pending, then --reply <id> --text "..."'
  }),
  Object.freeze({
    id: 'accept-or-reject-builder-result',
    kind: DUTY_KIND.JUDGEMENT,
    description: 'Deciding what merges: accepting or rejecting a builder result.',
    humanAction: 'review the diff and the builder evidence packet'
  }),
  Object.freeze({
    id: 'interpret-owner-request',
    kind: DUTY_KIND.JUDGEMENT,
    description: 'Interpreting a new owner request into STANDING-ORDERS.md entries and OWNER-REQUEST-LEDGER gates.',
    humanAction: 'node tools/owner-capture.js'
  }),
  Object.freeze({
    id: 'choose-fleet-strategy',
    kind: DUTY_KIND.JUDGEMENT,
    description: 'Choosing fleet strategy: decomposition vs whole-phase dispatch, concurrency, lane model, backend.',
    humanAction: 'decide, then update config/managed-processes.json declaredArgv'
  }),
  Object.freeze({
    id: 'adjudicate-argv-drift',
    kind: DUTY_KIND.JUDGEMENT,
    description: 'Deciding whether a detected argv drift is a deliberate temporary override or a defect. The host reports both argv strings; a human decides which is right.',
    humanAction: 'compare declaredArgv against the live command line and correct one of them'
  }),
  Object.freeze({
    id: 'quarantine-or-stop-subsystem',
    kind: DUTY_KIND.JUDGEMENT,
    description: 'Deciding to quarantine or permanently stop a subsystem, as opposed to the bounded automatic restart policy already allows.',
    humanAction: 'supervision policy quarantine, or place the declared stop sentinel'
  }),
  // A removed provider-pulse narrative duty has no live consumer.
  Object.freeze({
    id: 'answer-owner-prompt',
    kind: DUTY_KIND.JUDGEMENT,
    // The removed remote-owner ask did not outlive its provider. system.ask is
    // a local prompt and is untouched.
    description: 'Answering a system.ask prompt on the owner behalf.',
    humanAction: 'the owner answers the prompt himself'
  }),
  Object.freeze({
    id: 'weigh-escalation-urgency',
    kind: DUTY_KIND.JUDGEMENT,
    description: 'Judging whether an escalation is worth waking the owner for beyond the mechanical rate limit. The host applies declared policy; it does not re-weigh urgency.',
    humanAction: 'adjust the declared escalation policy deliberately'
  })
]);

const MECHANICAL_DUTY_IDS = Object.freeze(
  DUTIES.filter(duty => duty.kind === DUTY_KIND.MECHANICAL).map(duty => duty.id));
const JUDGEMENT_DUTY_IDS = Object.freeze(
  DUTIES.filter(duty => duty.kind === DUTY_KIND.JUDGEMENT).map(duty => duty.id));

function getDuty(id, duties = DUTIES) {
  return duties.find(duty => duty.id === id) || null;
}

function listDuties({ kind = null, duties = DUTIES } = {}) {
  return kind === null ? [...duties] : duties.filter(duty => duty.kind === kind);
}

/**
 * Structural enforcement of the design constraint that the host cannot fake a
 * judgement duty. Returns { valid, errors }. Throws nothing.
 */
function validateRegistry(duties = DUTIES) {
  const errors = [];
  if (!Array.isArray(duties)) return { valid: false, errors: ['duty registry is not an array'] };

  const seen = new Set();
  for (const duty of duties) {
    if (!duty || typeof duty !== 'object') { errors.push('a duty entry is not an object'); continue; }
    const id = duty.id;
    if (typeof id !== 'string' || id.length === 0) { errors.push('a duty entry has no id'); continue; }
    if (seen.has(id)) errors.push(`duplicate duty id ${id}`);
    seen.add(id);

    if (duty.kind !== DUTY_KIND.MECHANICAL && duty.kind !== DUTY_KIND.JUDGEMENT) {
      errors.push(`duty ${id} has unknown kind ${JSON.stringify(duty.kind)}`);
      continue;
    }
    if (typeof duty.description !== 'string' || duty.description.trim().length === 0) {
      errors.push(`duty ${id} has no description; a duty that cannot say what it is for cannot be reviewed`);
    }

    if (duty.kind === DUTY_KIND.MECHANICAL) {
      if (typeof duty.run !== 'function') {
        errors.push(`mechanical duty ${id} has no run() function; it would report success without ever running`);
      }
      if (typeof duty.intervalMs !== 'number' || !Number.isFinite(duty.intervalMs) || duty.intervalMs <= 0) {
        errors.push(`mechanical duty ${id} needs a positive finite intervalMs`);
      }
    } else {
      // THE STRUCTURAL GUARD. A judgement duty with executable code attached
      // is a host that can act on a human's behalf.
      if (duty.run !== undefined) {
        errors.push(`judgement duty ${id} carries a run() function; judgement duties must have no code path to execute`);
      }
      if (typeof duty.humanAction !== 'string' || duty.humanAction.trim().length === 0) {
        errors.push(`judgement duty ${id} must name the human action it is waiting on`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = Object.freeze({
  DUTY_KIND,
  DUTIES,
  MECHANICAL_DUTY_IDS,
  JUDGEMENT_DUTY_IDS,
  dashboardPort,
  ROOT,
  getDuty,
  listDuties,
  validateRegistry,
  // Exported for focused unit tests; the host only ever goes through DUTIES.
  _internals: Object.freeze({
    escalateVia,
    optionalModule,
    runOwnerInboxDetect,
    runOwnerWaitingEscalate,
    runMachineDirectiveAck,
    runArgvDriftDetect,
    runTaskRegistrationCheck,
    runDashboardListenerProbe,
    runBoundedRestart,
    runEscalationBudgetReport,
    runBackupDefinitionReport,
    runBackupObservationReport,
    runBackupExecutionGateReport
  })
});
