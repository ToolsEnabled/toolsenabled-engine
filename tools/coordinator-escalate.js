#!/usr/bin/env node
'use strict';

// CLI for the coordinator escalation sink (R100).
//
//   node tools/coordinator-escalate.js --send --id <subsystem> --state <STATE> --reason "<text>" [--detail "<text>"]
//   node tools/coordinator-escalate.js --send ... --dry-run     decide only, send NOTHING
//   node tools/coordinator-escalate.js --status [--json]
//
// WHY THIS EXISTS SEPARATELY FROM THE DUTY HOST. The whole path -- decide,
// rate limit, send, record, degrade honestly -- has to be exercisable by a
// human and by a test without starting a long-lived process. `escalated:[]` in
// logs/health-observer.log went unnoticed for a day partly because there was no
// one command that would have shown it.
//
// --dry-run is the safe rehearsal: it runs the REAL decision function against
// the REAL durable state and prints what would happen, and it does not go
// through escalate() at all. That is deliberate. An earlier shape of this flag
// injected a sendToOwner that threw -- which would have recorded a FAILED
// attempt and made sinkStatus().channel.broken true, i.e. a rehearsal would
// have manufactured the exact "the alert channel is dead" signal it was meant
// to test for. A dry run reads state and writes none.
//
// EXIT CODES are meaningful because a scheduled task reads them:
//   0  the escalation was delivered, or was correctly suppressed/refused
//   1  invalid usage or a corrupt state file
//   2  a SEND decision that did NOT reach the owner channel -- the loud case

const sink = require('../src/lib/coordinator/escalation-sink.js');
const killSwitch = require('../src/lib/kill-switch.js');
const policy = require('../src/lib/coordinator/escalation-policy.js');

const USAGE = [
  'ToolsEnabled coordinator escalation sink',
  '',
  '  --send --id <subsystem> --state <STATE> --reason "<text>" [--detail "<text>"]',
  '                        decide, then send to the owner over the configured channel',
  '  --dry-run             with --send: run the real decision, send NOTHING',
  '  --status [--json]     rate-limit budget, suppression counts, channel health',
  '  --json                machine-readable output',
  '',
  'The kill switch refuses every outward send. A failed send is recorded as',
  'FAILED and is never reported as delivered.',
  ''
].join('\n');

function parse(argv) {
  const flag = name => argv.includes(`--${name}`);
  const option = (name, fallback = null) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 || index === argv.length - 1 ? fallback : argv[index + 1];
  };
  return { flag, option };
}

function humanDecision(result) {
  const lines = [];
  if (result.decision === policy.DECISION.SEND) {
    const receipt = result.messageId === null ? 'id unknown' : JSON.stringify(result.messageId);
    lines.push(result.delivered
      ? `DELIVERED  ${result.identity}  (message ${receipt})`
      : `NOT DELIVERED  ${result.identity}  (${result.error})`);
  } else {
    lines.push(`${result.decision}  ${result.identity}`);
  }
  lines.push(`  ${result.reason}`);
  if (result.inboxItemId) lines.push(`  durable trail: ${result.inboxItemId}`);
  if (result.ackRefusals && result.ackRefusals.length) {
    for (const refusal of result.ackRefusals) lines.push(`  ack refused: ${refusal.id} (${refusal.code})`);
  }
  return `${lines.join('\n')}\n`;
}

function humanStatus(status) {
  const lines = [status.headline, ''];
  if (status.stateCorrupt || status.error) {
    lines.push(`state file: ${status.stateFile}`);
    lines.push(`error: ${status.error}`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(`kill switch      ${status.killSwitchActive === null ? 'UNKNOWN' : (status.killSwitchActive ? 'ACTIVE (sends refused)' : 'inactive')}`);
  lines.push(`channel          ${status.channel.broken ? `BROKEN (${status.channel.consecutiveFailures} consecutive failures, last ${status.channel.lastFailureCode})` : 'ok'}`);
  lines.push(`last delivered   ${status.channel.lastSentAtMs === null ? 'never' : `${new Date(status.channel.lastSentAtMs).toISOString()} (${Math.round(status.channel.lastSentAgeMs / 1000)}s ago)`}`);
  lines.push(`budget           ${status.budget.attemptsInLastHour}/${status.budget.maxSendsPerHour} used this hour, ${status.budget.remainingThisHour} left; floor ${Math.round(status.budget.minSendGapMs / 1000)}s; re-notify ${Math.round(status.budget.reNotifyMs / 1000)}s`);
  lines.push(`totals           sent=${status.totals.sent} failed=${status.totals.failed}`);
  lines.push(`suppressed       duplicate=${status.suppressed.duplicate} rateLimit=${status.suppressed.rateLimit} quietHours=${status.suppressed.quietHours}`);
  if (status.pendingAttempts.length) {
    lines.push(`unresolved       ${status.pendingAttempts.length} attempt(s) reserved but never resolved`);
  }
  if (status.entries.length) {
    lines.push('', 'identity                                  sent  failed  suppressed  last delivered');
    for (const entry of status.entries) {
      const suppressed = entry.suppressed.duplicate + entry.suppressed.rateLimit + entry.suppressed.quietHours;
      lines.push(`${entry.identity.padEnd(40)}  ${String(entry.sendCount).padStart(4)}  ${String(entry.failureCount).padStart(6)}  ${String(suppressed).padStart(10)}  ${entry.lastSentAtMs === null ? 'never' : new Date(entry.lastSentAtMs).toISOString()}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The whole CLI as a function so a test can drive it without a subprocess.
 * Returns { code, stdout, stderr }; writes nothing itself.
 */
async function run(argv = [], dependencies = {}) {
  const { flag, option } = parse(argv);

  if (argv.length === 0 || flag('help')) return { code: 0, stdout: USAGE, stderr: '' };

  if (flag('status')) {
    const status = sink.sinkStatus(dependencies);
    return {
      // A status payload can describe an unavailable observation, but that is
      // not a successful status check.  In particular, do not let a corrupt or
      // unreadable state file become exit 0 merely because sinkStatus() carried
      // the error in-band.
      code: status.stateCorrupt || status.error ? 1 : 0,
      stdout: flag('json') ? `${JSON.stringify(status, null, 2)}\n` : humanStatus(status),
      stderr: ''
    };
  }

  if (!flag('send')) return { code: 1, stdout: '', stderr: `unknown invocation\n\n${USAGE}` };

  const subsystemId = option('id');
  const state = option('state');
  const reason = option('reason');
  const detail = option('detail');
  if (!subsystemId || !state || !reason) {
    return { code: 1, stdout: '', stderr: `--send needs --id, --state and --reason\n\n${USAGE}` };
  }

  const candidate = {
    subsystemId,
    state,
    reason,
    ...(detail ? { detail } : {}),
    detectedBy: option('by', 'coordinator-escalate-cli')
  };

  if (flag('dry-run')) {
    let preview;
    try {
      const nowMs = (dependencies.now || Date.now)();
      const killSwitchObservation = (dependencies.killSwitch || killSwitch.status)();
      if (!killSwitchObservation || typeof killSwitchObservation.active !== 'boolean') {
        const error = new Error('kill-switch status did not provide a definite active value');
        error.code = 'KILLSWITCH_STATUS_UNKNOWN';
        throw error;
      }
      const active = killSwitchObservation.active;
      const durable = sink.readPolicyState(dependencies.stateFile || sink.ESCALATION_STATE_FILE());
      const decision = policy.decide(candidate, durable, { ...(dependencies.policyOptions || {}), now: nowMs });
      preview = {
        dryRun: true,
        killSwitchActive: active,
        wouldSend: active === false && decision.decision === policy.DECISION.SEND,
        decision: active ? sink.REFUSED_KILLSWITCH : decision.decision,
        identity: decision.identity,
        reason: active ? 'KILLSWITCH is active: an outward send would be refused.' : decision.reason,
        observed: decision.observed,
        messageThatWouldBeSent: sink.composeMessage(candidate, nowMs)
      };
    } catch (error) {
      return { code: 1, stdout: '', stderr: `${error.code || 'ERROR'}: ${error.message}\n` };
    }
    const human = [
      `DRY RUN  ${preview.decision}  ${preview.identity}`,
      `  ${preview.reason}`,
      '  Nothing was sent and nothing was recorded: this decision was computed against',
      '  the current durable state and no attempt was reserved.',
      '',
      preview.messageThatWouldBeSent.split('\n').map(line => `  | ${line}`).join('\n'),
      ''
    ].join('\n');
    return { code: 0, stdout: flag('json') ? `${JSON.stringify(preview, null, 2)}\n` : human, stderr: '' };
  }

  let result;
  try {
    result = await sink.escalate(candidate, dependencies);
  } catch (error) {
    return { code: 1, stdout: '', stderr: `${error.code || 'ERROR'}: ${error.message}\n` };
  }

  const stdout = flag('json') ? `${JSON.stringify(result, null, 2)}\n` : humanDecision(result);
  // The loud case: we decided to tell a human and failed to.
  const code = result.decision === policy.DECISION.SEND && result.delivered !== true ? 2 : 0;
  return { code, stdout, stderr: '' };
}

async function main(argv = process.argv.slice(2)) {
  const result = await run(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
  return result;
}

module.exports = { main, run, USAGE };

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
