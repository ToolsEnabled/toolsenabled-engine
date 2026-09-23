// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-coordinator-escalation-sink-test-js):
// - STRENGTHENED: the owner-chat transport-dependency assertion below formerly
//   recognized only single-quoted require() calls. Mutation applied to the code
//   under test: `if (false) require("./telegram-bridge");`. Before this change
//   the test stayed green: "coordinator-escalation-sink tests passed." With the
//   strengthened assertion it went red:
//     "AssertionError [ERR_ASSERTION]: owner-chat must not require a transport
//      module at load; inject sendToOwner instead"
//     "+ ["
//     "+   'require(\"./telegram-bridge\")'"
//     "+ ]"
//     "- []"
// - NOT-FOUND (empty iteration): loops have fixed non-empty bounds/literals,
//   or their results have independent cardinality assertions.
// - NOT-FOUND (exit/truthy-only evidence): the CLI's non-zero result is paired
//   with its own NOT DELIVERED output and recorded broken-channel state.
// - NOT-FOUND (swallowed failure): try/finally only cleans the kill-switch file;
//   no catch or optional chain suppresses an assertion failure.
// - NOT-FOUND (mock of subject): recorders mock only injected channel I/O, not
//   the sink/policy/inbox/owner-chat behavior asserted by the test.
// - NOT-FOUND (skip/guard): the file has no skip or platform no-op guard; its
//   isolation precondition fails loudly.
// - NOT-FOUND (same-code expectation): expected decisions, counts, messages,
//   and state are specified independently rather than derived by the subject.
// - RESTORED: src/lib/owner-chat.js matched its pre-mutation SHA-256 byte for
//   byte (3d5c9079c9a1e549da1bc048a6a405b90e96fdeec008fc2a03413184b0632b48).
//   After restoration the run was green: "coordinator-escalation-sink tests
//   passed." No mutation precondition was unmet.

'use strict';

// Wired-path tests for src/lib/coordinator/escalation-sink.js.
// Plain `node tests/coordinator-escalation-sink.test.js`.
//
// NOTHING here touches a real owner channel, the real owner directive inbox,
// or the real state/ directory: sendToOwner is injected, every file path is a
// fresh temp dir, and ./lib/isolated-environment redirects the vault, audit
// ledger and KILLSWITCH path under a scratch root. The kill-switch case is
// exercised through the REAL src/lib/kill-switch.js against that redirected
// path rather than a stub, because "does this code check the kill switch the
// same way the rest of the repo does" is exactly the thing a stub would not
// answer.
//
// The claims under test, each one a way the previous escalation path failed:
//   1. a detected failure actually reaches a send call (breakage 2: escalated:[])
//   2. the second identical escalation is SUPPRESSED and does not send
//   3. the rate limit holds when many subsystems break at once
//   4. a send failure is recorded as FAILED, is never reported as delivered,
//      and makes the channel visibly BROKEN
//   5. the kill switch refuses the send outright
//   6. dedupe is DURABLE: a restarted host does not re-notify everything
//   7. the sink structurally cannot reply to the owner
//   8. acknowledging an owner-sourced directive is refused by construction

const { activate, within } = require('./lib/isolated-environment');
activate('coordinator-escalation-sink');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sink = require('../src/lib/coordinator/escalation-sink.js');
const policy = require('../src/lib/coordinator/escalation-policy.js');
const directiveInbox = require('../src/lib/owner-directive-inbox.js');
const { killSwitchPath } = require('../src/lib/policy.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-escalation-sink-'));
let caseIndex = 0;
function freshDir() {
  caseIndex += 1;
  const dir = path.join(root, `case-${caseIndex}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const T0 = 1_800_000_000_000;
const DOWN = {
  subsystemId: 'fleet-supervisor',
  state: 'DOWN',
  reason: 'the pid lock holder is gone and the scheduled task is not registered',
  detectedBy: 'coordinator-duty-host'
};

// A recorder that stands in for the injected owner channel. Its signature is
// the real one -- ({ text }) -> a receipt, or a throw carrying .code --
// verified against src/lib/coordinator/owner-alarm-channel.js#sendToOwner.
// The receipt is a bounded opaque string, matching the product channel.
function recorder({ throws = null, messageId = 'owner-alarm-test-4242' } = {}) {
  const calls = [];
  const send = async ({ text }) => {
    calls.push(text);
    if (throws) {
      const error = new Error('fixture failure');
      error.code = throws;
      throw error;
    }
    return { messageId };
  };
  return { calls, send };
}

function neverAcknowledge() {
  throw new Error('a test forgot to inject acknowledgeWithoutReply');
}

(async () => {
  // --- 1. The wire actually gets used --------------------------------------
  {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const channel = recorder();

    const result = await sink.escalate(DOWN, {
      stateFile,
      sendToOwner: channel.send,
      inboxOverrides: { inboxFile },
      acknowledgeWithoutReply: neverAcknowledge,
      killSwitch: () => ({ active: false }),
      now: () => T0
    });

    assert.equal(result.decision, policy.DECISION.SEND);
    assert.equal(result.delivered, true);
    assert.equal(result.messageId, 'owner-alarm-test-4242');
    assert.equal(result.error, null);
    assert.equal(channel.calls.length, 1, 'exactly one message on the wire');
    assert.match(channel.calls[0], /COORDINATOR ESCALATION: fleet-supervisor is DOWN/);
    assert.match(channel.calls[0], /pid lock holder is gone/);
    assert.match(channel.calls[0], /not a reply to a message/,
      'the notice must say it is a notice, so it can never read as an answer to something he said');

    // The durable trail exists AND is secondary: it carries the delivery
    // outcome rather than being the delivery.
    assert.ok(result.inboxItemId, 'a durable trail item was written');
    const inbox = directiveInbox.list({ unreadOnly: true }, { inboxFile });
    assert.equal(inbox.items.length, 1);
    assert.equal(inbox.items[0].source, sink.DIRECTIVE_SOURCE);
    assert.match(inbox.items[0].text, /\[agent-comms: delivered \(message "owner-alarm-test-4242"\)\]/);
    assert.equal(result.channel, 'agent-comms',
      'the trail and the record must name the channel that actually carried it');
    assert.equal(result.recorded, true, 'the outcome reached the state file');

    const status = sink.sinkStatus({ stateFile, now: () => T0 + 1_000, killSwitch: () => ({ active: false }) });
    assert.equal(status.channel.broken, false);
    assert.equal(status.totals.sent, 1);
    assert.equal(status.budget.attemptsInLastHour, 1);
    assert.equal(status.budget.remainingThisHour, policy.MAX_SENDS_PER_HOUR - 1);
    assert.match(status.headline, /Escalation sink OK: 1 sent/);
  }

  // --- 1b. New delivery receipts are opaque strings, never numeric --------
  {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const result = await sink.escalate(DOWN, {
      stateFile,
      sendToOwner: recorder({ messageId: 4242 }).send,
      inboxOverrides: { inboxFile },
      acknowledgeWithoutReply: neverAcknowledge,
      killSwitch: () => ({ active: false }),
      now: () => T0
    });
    assert.equal(result.delivered, null,
      'a numeric current receipt cannot establish delivery');
    assert.equal(result.messageId, null);
    assert.equal(result.error, sink.ESCALATION_DELIVERY_UNKNOWN);
    assert.match(result.reason, /OWNER_CHANNEL_RECEIPT_INVALID/);
    assert.equal(sink.readPolicyState(stateFile).attempts[0].outcome, 'pending');
  }

  // --- 2. Dedupe: the second identical escalation does NOT send ------------
  {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const channel = recorder();
    const common = {
      stateFile,
      sendToOwner: channel.send,
      inboxOverrides: { inboxFile },
      acknowledgeWithoutReply: neverAcknowledge,
      killSwitch: () => ({ active: false })
    };

    await sink.escalate(DOWN, { ...common, now: () => T0 });
    assert.equal(channel.calls.length, 1);

    // 60 more sweeps over the next five minutes, exactly what a 5s health
    // observer would do while the subsystem stays down.
    const decisions = [];
    for (let i = 1; i <= 60; i += 1) {
      const outcome = await sink.escalate(DOWN, { ...common, now: () => T0 + i * 5_000 });
      decisions.push(outcome.decision);
      assert.equal(outcome.delivered, false);
    }
    assert.equal(channel.calls.length, 1,
      'one stuck subsystem must produce ONE notification, not 61');
    assert.ok(decisions.every(decision => decision === policy.DECISION.SUPPRESS_DUPLICATE),
      `every repeat must be SUPPRESS_DUPLICATE, saw ${[...new Set(decisions)].join(',')}`);

    // The inbox must not be buried either: same identity, same window, one item.
    const inbox = directiveInbox.list({ unreadOnly: true }, { inboxFile });
    assert.equal(inbox.items.length, 1, 'the durable trail is deduped on the same identity');

    // Counted, not dropped.
    const status = sink.sinkStatus({ stateFile, now: () => T0 + 400_000, killSwitch: () => ({ active: false }) });
    assert.equal(status.suppressed.duplicate, 60);
    assert.equal(status.suppressed.total, 60);
    const since = sink.suppressedSince(T0, { stateFile });
    assert.equal(since.duplicate, 60);
    assert.equal(since.total, 60);

    // Past the re-notify interval it speaks again -- silence forever would be
    // indistinguishable from a dead escalator.
    const later = await sink.escalate(DOWN, { ...common, now: () => T0 + policy.RE_NOTIFY_MS + 1 });
    assert.equal(later.decision, policy.DECISION.SEND);
    assert.equal(later.delivered, true);
    assert.equal(channel.calls.length, 2);
  }

  // --- 3. Rate limit holds when many subsystems break at once --------------
  {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const channel = recorder();

    let sent = 0;
    let rateLimited = 0;
    for (let i = 0; i < 20; i += 1) {
      const outcome = await sink.escalate({
        subsystemId: `subsystem-${i}`, state: 'DOWN', reason: 'simultaneous failure fixture'
      }, {
        stateFile,
        sendToOwner: channel.send,
        inboxOverrides: { inboxFile },
        acknowledgeWithoutReply: neverAcknowledge,
        killSwitch: () => ({ active: false }),
        now: () => T0 + i * 1_000   // twenty distinct failures inside 20 seconds
      });
      if (outcome.decision === policy.DECISION.SEND) sent += 1;
      if (outcome.decision === policy.DECISION.SUPPRESS_RATE_LIMIT) rateLimited += 1;
    }
    assert.equal(sent, 1, 'the one-per-minute floor must stop a burst dead after the first');
    assert.equal(rateLimited, 19);
    assert.equal(channel.calls.length, 1);

    // Spread over the hour, the ceiling is what binds.
    let spreadSent = 0;
    for (let i = 1; i <= 20; i += 1) {
      const outcome = await sink.escalate({
        subsystemId: `spread-${i}`, state: 'DOWN', reason: 'spread fixture'
      }, {
        stateFile,
        sendToOwner: channel.send,
        inboxOverrides: { inboxFile },
        acknowledgeWithoutReply: neverAcknowledge,
        killSwitch: () => ({ active: false }),
        now: () => T0 + i * policy.MIN_SEND_GAP_MS
      });
      if (outcome.decision === policy.DECISION.SEND) spreadSent += 1;
    }
    assert.equal(1 + spreadSent, policy.MAX_SENDS_PER_HOUR,
      `the hourly ceiling must bind at ${policy.MAX_SENDS_PER_HOUR} total attempts`);

    const status = sink.sinkStatus({
      stateFile, now: () => T0 + 21 * policy.MIN_SEND_GAP_MS, killSwitch: () => ({ active: false })
    });
    assert.equal(status.budget.remainingThisHour, 0);
    assert.ok(status.suppressed.rateLimit >= 19);
  }

  // --- 4. A failed send is FAILED, never delivered -------------------------
  {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const channel = recorder({ throws: 'OWNER_ALARM_UNAVAILABLE' });

    const result = await sink.escalate(DOWN, {
      stateFile,
      sendToOwner: channel.send,
      inboxOverrides: { inboxFile },
      acknowledgeWithoutReply: neverAcknowledge,
      killSwitch: () => ({ active: false }),
      now: () => T0
    });
    assert.equal(result.decision, policy.DECISION.SEND, 'the DECISION was to send');
    assert.equal(result.delivered, false, 'but delivery must never be claimed');
    assert.equal(result.error, 'OWNER_ALARM_UNAVAILABLE');
    assert.equal(result.messageId, null);
    assert.match(result.reason, /NOT delivered/);

    // The trail records the failure, so the fact survives the process.
    const inbox = directiveInbox.list({ unreadOnly: true }, { inboxFile });
    assert.equal(inbox.items.length, 1);
    assert.match(inbox.items[0].text, /NOT DELIVERED \(OWNER_ALARM_UNAVAILABLE\)/);

    // A sink that cannot deliver must NOT look quiet.
    const status = sink.sinkStatus({ stateFile, now: () => T0 + 1_000, killSwitch: () => ({ active: false }) });
    assert.equal(status.channel.broken, true);
    assert.equal(status.channel.consecutiveFailures, 1);
    assert.equal(status.channel.lastFailureCode, 'OWNER_ALARM_UNAVAILABLE');
    assert.equal(status.channel.lastSentAtMs, null);
    assert.equal(status.totals.sent, 0);
    assert.equal(status.totals.failed, 1);
    assert.match(status.headline, /ESCALATION CHANNEL BROKEN/);
    assert.match(status.headline, /NOT reaching the owner/);

    // And the failure must not have deduped the condition away.
    const retry = await sink.escalate(DOWN, {
      stateFile,
      sendToOwner: recorder().send,
      inboxOverrides: { inboxFile },
      acknowledgeWithoutReply: neverAcknowledge,
      killSwitch: () => ({ active: false }),
      now: () => T0 + policy.MIN_SEND_GAP_MS
    });
    assert.equal(retry.decision, policy.DECISION.SEND,
      'a previously FAILED escalation must remain eligible: a broken channel cannot be allowed to silence the condition it failed to report');
    assert.equal(retry.delivered, true);
    const recovered = sink.sinkStatus({
      stateFile, now: () => T0 + policy.MIN_SEND_GAP_MS + 1, killSwitch: () => ({ active: false })
    });
    assert.equal(recovered.channel.broken, false);
  }

  // --- 4b. COULD NOT LOOK is not cached as NOT DELIVERED ------------------
  {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const channel = recorder({ throws: 'EMFILE' });

    const result = await sink.escalate(DOWN, {
      stateFile,
      sendToOwner: channel.send,
      inboxOverrides: { inboxFile },
      acknowledgeWithoutReply: neverAcknowledge,
      killSwitch: () => ({ active: false }),
      now: () => T0
    });
    assert.equal(result.delivered, null,
      'EMFILE means the machine could not observe delivery, not that delivery was false');
    assert.equal(result.error, sink.ESCALATION_DELIVERY_UNKNOWN);
    assert.equal(result.recorded, false, 'an invented non-delivery must not be cached');
    assert.match(result.reason, /delivery is UNKNOWN/);
    assert.match(result.reason, /NOT claiming.*not delivered/);

    const durable = sink.readPolicyState(stateFile);
    assert.equal(durable.totals.failed, 0,
      'the durable failure total must not latch an ambiguous observation');
    assert.equal(durable.attempts[0].outcome, 'pending');
    const status = sink.sinkStatus({ stateFile, now: () => T0 + 1, killSwitch: () => ({ active: false }) });
    assert.equal(status.channel.broken, false);
    assert.equal(status.pendingAttempts.length, 1,
      'the truthful durable fact is that the reserved attempt remains unresolved');
    const inbox = directiveInbox.list({ unreadOnly: true }, { inboxFile });
    assert.match(inbox.items[0].text, /DELIVERY UNKNOWN \(EMFILE\)/);
    assert.match(inbox.items[0].text, /NOT claiming absence or non-delivery/);

    // CONTROL: the preceding OWNER_ALARM_UNAVAILABLE case proves a genuine
    // rejection is still durably cached as one failed attempt. This assertion
    // additionally pins the policy behavior directly, so deleting all failure
    // caching cannot make the ambiguity test pass by restoring its cost.
    const rejectedFile = path.join(dir, 'rejected.json');
    await sink.escalate(DOWN, {
      stateFile: rejectedFile,
      sendToOwner: recorder({ throws: 'OWNER_ALARM_UNAVAILABLE' }).send,
      inboxOverrides: { inboxFile: path.join(dir, 'rejected-inbox.json') },
      acknowledgeWithoutReply: neverAcknowledge,
      killSwitch: () => ({ active: false }),
      now: () => T0
    });
    assert.equal(sink.readPolicyState(rejectedFile).totals.failed, 1,
      'a definite channel rejection remains cached');
  }

  // --- 5. The kill switch refuses, through the REAL kill-switch module -----
  {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const channel = recorder();
    const killFile = killSwitchPath();
    // This interlock must actually inspect the resolved path. Its previous
    // shape (`path.includes('toolsenabled-test') || TOOLSENABLED_TEST_ISOLATED
    // === '1'`) was vacuous under every runner, because the isolation marker
    // is always '1' here — so if isolation ever stopped redirecting
    // TOOLSENABLED_KILLSWITCH_PATH, the test would have written a REAL
    // kill-switch file without noticing. Requiring the kill file to resolve
    // inside the declared isolated root closes that.
    assert.ok(process.env.TOOLSENABLED_TEST_ROOT && within(process.env.TOOLSENABLED_TEST_ROOT, killFile),
      'refusing to run: the kill switch path is not redirected under the isolated test root');

    fs.mkdirSync(path.dirname(killFile), { recursive: true });
    fs.writeFileSync(killFile, 'engaged by tests/coordinator-escalation-sink.test.js\n', 'utf8');
    try {
      // No killSwitch override here on purpose: this exercises the same
      // src/lib/kill-switch.js#status the rest of the repo uses.
      const result = await sink.escalate(DOWN, {
        stateFile,
        sendToOwner: channel.send,
        inboxOverrides: { inboxFile },
        acknowledgeWithoutReply: neverAcknowledge,
        now: () => T0
      });
      assert.equal(result.decision, sink.REFUSED_KILLSWITCH);
      assert.equal(result.delivered, false);
      assert.equal(channel.calls.length, 0, 'nothing may go on the wire while the kill switch is active');
      assert.match(result.reason, /KILLSWITCH is active/);

      // A refusal must not consume budget or set the dedupe stamp: the
      // escalation is still owed once the switch is cleared.
      assert.equal(fs.existsSync(stateFile), false,
        'a kill-switch refusal happens before any durable write, so it cannot charge a send that never happened');

      const status = sink.sinkStatus({ stateFile, now: () => T0 });
      assert.equal(status.killSwitchActive, true);
      assert.match(status.headline, /KILLSWITCH is active/);
      assert.match(status.headline, /NOT reaching the owner/);
    } finally {
      fs.unlinkSync(killFile);
    }

    // Cleared: the same escalation now goes out.
    const afterClear = await sink.escalate(DOWN, {
      stateFile,
      sendToOwner: channel.send,
      inboxOverrides: { inboxFile },
      acknowledgeWithoutReply: neverAcknowledge,
      now: () => T0 + 1_000
    });
    assert.equal(afterClear.decision, policy.DECISION.SEND);
    assert.equal(afterClear.delivered, true);
    assert.equal(channel.calls.length, 1);

    // A dependency that returns no definite switch state is not permission to
    // send. Only an explicit `active: false` establishes that the gate is open.
    const malformedChannel = recorder();
    const malformed = await sink.escalate(DOWN, {
      stateFile: path.join(dir, 'malformed-state.json'),
      sendToOwner: malformedChannel.send,
      inboxOverrides: { inboxFile },
      acknowledgeWithoutReply: neverAcknowledge,
      killSwitch: () => ({}),
      now: () => T0 + 2_000
    });
    assert.equal(malformed.decision, sink.REFUSED_KILLSWITCH);
    assert.equal(malformed.error, 'KILLSWITCH_STATUS_INVALID');
    assert.equal(malformed.delivered, false);
    assert.equal(malformedChannel.calls.length, 0,
      'an indeterminate kill-switch result must refuse rather than silently enable the wire');
  }

  // --- 6. Dedupe is DURABLE across a restart ------------------------------
  {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const first = recorder();
    const common = inboxOverrides => ({
      stateFile,
      inboxOverrides,
      acknowledgeWithoutReply: neverAcknowledge,
      killSwitch: () => ({ active: false })
    });

    await sink.escalate(DOWN, { ...common({ inboxFile }), sendToOwner: first.send, now: () => T0 });
    assert.equal(first.calls.length, 1);

    // Simulate a duty-host restart: nothing in memory survives, only the file.
    // readPolicyState is the reader a fresh process would use.
    const reloaded = sink.readPolicyState(stateFile);
    assert.equal(reloaded.totals.sent, 1);
    assert.equal(reloaded.entries['fleet-supervisor:DOWN'].lastSentAtMs, T0);

    const second = recorder();
    const afterRestart = await sink.escalate(DOWN, {
      ...common({ inboxFile }), sendToOwner: second.send, now: () => T0 + 120_000
    });
    assert.equal(afterRestart.decision, policy.DECISION.SUPPRESS_DUPLICATE,
      'restarting the duty host must NOT re-notify everything it already reported');
    assert.equal(second.calls.length, 0);
  }

  // --- 7. The sink structurally cannot reply to the owner -----------------
  {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'lib', 'coordinator', 'escalation-sink.js'), 'utf8');

    // Strip comments so the prose ABOUT reply() is not mistaken for a call to
    // it. (Naive stripper: adequate because this file contains no '//' or '/*'
    // inside a string literal -- asserted below so the check cannot silently
    // rot if one is added.)
    assert.equal(/'[^'\n]*\/\//.test(source), false,
      'the comment stripper below assumes no // inside a string literal in escalation-sink.js');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');

    assert.equal(/\breply\s*\(/.test(code), false,
      'escalation-sink.js must never call reply(): composing words back to the owner is a judgement duty');
    assert.equal(/ownerChat\s*\.\s*reply/.test(code), false);

    // The owner-chat require must be narrowed at the point of import, so the
    // whole module (and therefore reply) is never in scope here.
    const requires = [...code.matchAll(/require\(\s*['"]\.\.\/owner-chat['"]\s*\)([.\s\S]{0,32})/g)];
    assert.equal(requires.length, 1, 'exactly one owner-chat require is expected');
    assert.match(requires[0][1], /^\.acknowledgeWithoutReply/,
      "the owner-chat require must be immediately narrowed to .acknowledgeWithoutReply");
  }

  // --- 8. Acknowledging an OWNER-sourced directive is refused -------------
  {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const chatFile = path.join(dir, 'owner-chat.json');
    const channel = recorder();

    // One historical owner message (source 'telegram' is the immutable
    // provenance stamp used by the removed relay), and one machine
    // directive.
    const fromOwner = directiveInbox.append({
      text: 'is the fleet supervisor still running',
      source: 'telegram', submittedBy: 'owner-telegram'
    }, { inboxFile });
    const fromMachine = directiveInbox.append({
      text: 'HEALTH DOWN: fleet-supervisor moved OK -> DOWN.',
      source: 'health-observer', submittedBy: 'health-observer'
    }, { inboxFile });

    // The REAL owner-chat.acknowledgeWithoutReply, not a stub: the guard being
    // tested lives inside it (src/lib/owner-chat.js:750).
    const result = await sink.escalate({
      ...DOWN,
      acknowledgeDirectiveIds: [fromMachine.id, fromOwner.id]
    }, {
      stateFile,
      sendToOwner: channel.send,
      inboxOverrides: { inboxFile, chatFile },
      killSwitch: () => ({ active: false }),
      now: () => T0
    });

    assert.equal(result.delivered, true);
    assert.deepEqual([...result.acknowledged], [fromMachine.id],
      'only the machine-sourced directive may be filed');
    assert.equal(result.ackRefusals.length, 1);
    assert.equal(result.ackRefusals[0].id, fromOwner.id);
    assert.equal(result.ackRefusals[0].code, 'OWNER_CHAT_NEEDS_A_REPLY');

    // And his message is STILL unread: he is still visibly waiting.
    const unread = directiveInbox.list({ unreadOnly: true }, { inboxFile });
    const stillWaiting = unread.items.find(item => item.id === fromOwner.id);
    assert.ok(stillWaiting, 'the owner message must stay unread -- his messages get answered, not filed');
    assert.equal(stillWaiting.status, 'unread');
  }

  // --- 9. Bad input refuses loudly; a corrupt state file is a hard stop ----
  {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const channel = recorder();
    const deps = {
      stateFile, sendToOwner: channel.send, inboxOverrides: { inboxFile: path.join(dir, 'inbox.json') },
      acknowledgeWithoutReply: neverAcknowledge, killSwitch: () => ({ active: false }), now: () => T0
    };

    await assert.rejects(() => sink.escalate({ subsystemId: 'x', state: 'DOWN' }, deps),
      error => error.code === 'ESCALATION_INVALID');
    await assert.rejects(() => sink.escalate({ subsystemId: 'x', state: 'DOWN', reason: 'r', bogus: 1 }, deps),
      error => error.code === 'ESCALATION_INVALID');
    // A credential-shaped reason must never reach a chat history.
    await assert.rejects(() => sink.escalate({
      subsystemId: 'x', state: 'DOWN', reason: 'restart failed: api_key=AKIAABCDEFGHIJKLMNOP'
    }, deps), error => error.code === 'ESCALATION_LOOKS_SENSITIVE');
    assert.equal(channel.calls.length, 0, 'a refused candidate must never reach the wire');

    fs.writeFileSync(stateFile, '{ not json', 'utf8');
    assert.throws(() => sink.readPolicyState(stateFile), error => error.code === 'ESCALATION_STATE_CORRUPT');
    // sinkStatus must survive it and say so, rather than take down its host.
    const status = sink.sinkStatus({ stateFile, now: () => T0, killSwitch: () => ({ active: false }) });
    assert.equal(status.stateCorrupt, true);
    assert.equal(status.channel, null);
    assert.match(status.headline, /UNAVAILABLE/);
    assert.match(status.headline, /UNKNOWN/);
  }

  // --- Lock contention is different from lock state that is UNKNOWN -------
  {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const lockFile = `${stateFile}.lock`;
    const channel = recorder();
    fs.writeFileSync(lockFile, 'possible holder', 'utf8');

    const realStatSync = fs.statSync;
    fs.statSync = file => {
      if (path.resolve(file) === path.resolve(lockFile)) {
        const error = new Error('the lock metadata cannot be read');
        error.code = 'EACCES';
        throw error;
      }
      return realStatSync(file);
    };
    try {
      await assert.rejects(() => sink.escalate(DOWN, {
        stateFile,
        sendToOwner: channel.send,
        killSwitch: () => ({ active: false }),
        now: () => T0
      }), error => {
        assert.equal(error.code, 'ESCALATION_STATE_UNAVAILABLE',
          '"this lock is busy" must differ from "whether this lock is held could not be established"');
        assert.match(error.message, /whether it is held is unknown/i);
        return true;
      });
    } finally {
      fs.statSync = realStatSync;
    }
    assert.equal(channel.calls.length, 0, 'an unknown lock state must never reach the wire');
  }

  // --- 10. The CLI exercises the whole path without a process ------------
  {
    const cli = require('../tools/coordinator-escalate.js');
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const channel = recorder();
    const deps = {
      stateFile,
      inboxOverrides: { inboxFile },
      acknowledgeWithoutReply: neverAcknowledge,
      killSwitch: () => ({ active: false }),
      now: () => T0
    };

    const help = await cli.run([], deps);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /coordinator escalation sink/);

    const badUsage = await cli.run(['--send', '--id', 'x'], deps);
    assert.equal(badUsage.code, 1, 'incomplete --send must refuse, not guess');
    assert.match(badUsage.stderr, /needs --id, --state and --reason/);

    // --dry-run must be incapable of sending AND must not write state -- an
    // earlier shape injected a throwing sendToOwner, which would have recorded
    // a failed attempt and manufactured a false "channel BROKEN" signal.
    const dry = await cli.run(['--send', '--id', 'fleet-supervisor', '--state', 'DOWN',
      '--reason', 'rehearsal', '--dry-run', '--json'], { ...deps, sendToOwner: channel.send });
    assert.equal(dry.code, 0);
    const preview = JSON.parse(dry.stdout);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.wouldSend, true);
    assert.equal(channel.calls.length, 0, 'a rehearsal must never reach the wire');
    assert.equal(fs.existsSync(stateFile), false, 'a rehearsal must not write durable state');

    const unknownKillSwitch = await cli.run(['--send', '--id', 'fleet-supervisor', '--state', 'DOWN',
      '--reason', 'rehearsal', '--dry-run', '--json'], { ...deps, killSwitch: () => ({}) });
    assert.equal(unknownKillSwitch.code, 1, 'an unknown kill-switch observation must refuse');
    assert.match(unknownKillSwitch.stderr, /KILLSWITCH_STATUS_UNKNOWN/);

    const sent = await cli.run(['--send', '--id', 'fleet-supervisor', '--state', 'DOWN',
      '--reason', 'the live process is missing declared argv'], { ...deps, sendToOwner: channel.send });
    assert.equal(sent.code, 0);
    assert.equal(channel.calls.length, 1);
    assert.match(sent.stdout, /^DELIVERED {2}fleet-supervisor:DOWN/m);

    // Exit code 2 is the loud case: we decided to tell a human and could not.
    const failing = recorder({ throws: 'OWNER_ALARM_SEND_FAILED' });
    const broken = await cli.run(['--send', '--id', 'owner-channel', '--state', 'DOWN',
      '--reason', 'owner journal delivery failed'],
    { ...deps, sendToOwner: failing.send, now: () => T0 + policy.MIN_SEND_GAP_MS });
    assert.equal(broken.code, 2, 'an undelivered escalation must exit non-zero so a scheduled task notices');
    assert.match(broken.stdout, /NOT DELIVERED/);

    const status = await cli.run(['--status', '--json'],
      { ...deps, now: () => T0 + policy.MIN_SEND_GAP_MS + 1_000 });
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.totals.sent, 1);
    assert.equal(parsed.totals.failed, 1);

    fs.writeFileSync(stateFile, '{ not json', 'utf8');
    const unavailable = await cli.run(['--status', '--json'], deps);
    assert.equal(unavailable.code, 1, 'an unavailable status must not report successful exit');
    assert.equal(JSON.parse(unavailable.stdout).stateCorrupt, true);
    assert.equal(parsed.channel.broken, true);
    assert.match(parsed.headline, /ESCALATION CHANNEL BROKEN/);
  }

  // --- 11. The candidate shape the duty host actually sends ---------------
  //
  // src/lib/coordinator/duty-registry.js (another builder's file) calls
  // escalateVia(ctx, { id, state, reason }) -- `id`, not `subsystemId`. Before
  // this alias existed, every real escalation threw ESCALATION_INVALID, which
  // that caller's catch converts into "escalation channel BROKEN". The failure
  // would have looked like a dead owner channel. Pinned here so the two
  // spellings cannot silently diverge again.
  {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const channel = recorder();
    const deps = {
      stateFile,
      sendToOwner: channel.send,
      inboxOverrides: { inboxFile },
      acknowledgeWithoutReply: neverAcknowledge,
      killSwitch: () => ({ active: false }),
      now: () => T0
    };

    const result = await sink.escalate({
      id: 'owner-inbox',
      state: 'OWNER_WAITING_FOR_REPLY',
      reason: 'The owner has an unread message waiting 14 minute(s) with no agent reply.'
    }, deps);
    assert.equal(result.decision, policy.DECISION.SEND);
    assert.equal(result.delivered, true);
    assert.equal(result.identity, 'owner-inbox:OWNER_WAITING_FOR_REPLY');
    assert.equal(result.subsystemId, 'owner-inbox');
    assert.match(channel.calls[0], /COORDINATOR ESCALATION: owner-inbox is OWNER_WAITING_FOR_REPLY/);
    assert.match(channel.calls[0], /not a reply to a message/,
      'the owner-waiting notice must be unmistakably ABOUT the condition, never an answer to him');

    // Ambiguity is refused rather than resolved by guessing.
    await assert.rejects(() => sink.escalate({
      id: 'a', subsystemId: 'b', state: 'DOWN', reason: 'r'
    }, deps), error => error.code === 'ESCALATION_INVALID');

    // And the flat numeric mirror the heartbeat reads must exist and be a
    // number, not null -- null renders as "unknown", zero as "none suppressed".
    await sink.escalate({ id: 'owner-inbox', state: 'OWNER_WAITING_FOR_REPLY', reason: 'again' },
      { ...deps, now: () => T0 + 5_000 });
    const status = sink.sinkStatus({ stateFile, now: () => T0 + 6_000, killSwitch: () => ({ active: false }) });
    assert.equal(typeof status.escalationsSuppressed, 'number');
    assert.equal(status.escalationsSuppressed, status.suppressed.total);
    assert.equal(status.escalationsSuppressed, 1);
  }

  // 9. THE OWNER INBOX LOADS WITHOUT A TRANSPORT MODULE BEHIND IT.
  //
  // src/lib/owner-chat.js used to `require('./telegram-bridge')` at the TOP of
  // the file, and this sink calls owner-chat's acknowledgeWithoutReply(). Only
  // two of owner-chat's twenty exports ever touched a transport, so that single
  // load-time require put the whole owner directive inbox -- and therefore this
  // sink -- behind a connector module. When Telegram was removed on 2026-08-23
  // that module stopped existing and the require would have taken this file down
  // with it: MODULE_NOT_FOUND at load, before any test could report anything
  // useful. This is the same shape of defect as telegram-pulse.js's module-level
  // service lookup, which made the escalation path unloadable on any install
  // whose service registry declared no services.
  {
    const ownerChat = require('../src/lib/owner-chat');
    assert.equal(typeof ownerChat.acknowledgeWithoutReply, 'function',
      'the sink depends on this; if it is gone the sink is broken');
    for (const transportFree of ['readChatLog', 'summarize', 'pending', 'transcript', 'classify', 'headline']) {
      assert.equal(typeof ownerChat[transportFree], 'function', `${transportFree} must not need a transport to exist`);
    }
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'owner-chat.js'), 'utf8');
    const requires = source.match(/require\(\s*(['"])[^'"]+\1\s*\)/g) || [];
    assert.deepEqual(requires.filter(line => /telegram/i.test(line)), [],
      'owner-chat must not require a transport module at load; inject sendToOwner instead');
  }

  // 10. alert() AND reply() FAIL CLOSED WITH A NAMED REASON, RATHER THAN
  //     APPEARING TO SEND INTO NOTHING.
  //
  // Reply-capable owner delivery is deliberately injected: a caller that does
  // not select one gets a typed refusal. Operational alarms have a separate
  // product-native journal adapter; this generic conversation log does not
  // silently substitute it. The refusal must also come
  // BEFORE anything durable is written, or a half-sent entry is left behind in
  // state/owner-chat.json for a message that never went anywhere.
  {
    const ownerChat = require('../src/lib/owner-chat');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-chat-no-transport-'));
    const chatFile = path.join(dir, 'owner-chat.json');

    await assert.rejects(
      () => ownerChat.alert({ text: 'the machine needs you', actor: 'test' }, {}, { chatFile }),
      error => error && error.code === 'OWNER_CHAT_NO_TRANSPORT',
      'alert() must refuse with a named code, not send into a deleted module');

    // A WELL-FORMED id that does not exist. reply() validates the id SHAPE first
    // -- cheap checks before expensive ones -- so a malformed id would refuse with
    // OWNER_CHAT_INVALID and never reach the transport check this case is about.
    const wellFormedId = `owner-directive-${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`;
    await assert.rejects(
      () => ownerChat.reply({ id: wellFormedId, text: 'hello' }, {}, { chatFile }),
      error => error && error.code === 'OWNER_CHAT_NO_TRANSPORT',
      'reply() must refuse for the missing transport BEFORE it goes looking for the directive');

    assert.equal(fs.existsSync(chatFile), false,
      'a refused send must leave no durable trace: the transport is checked before the log is written');

    // The injected path still works, so this is a missing DEFAULT and not a
    // broken function. Whatever channel the owner picks plugs in here.
    const sent = [];
    const result = await ownerChat.alert(
      { text: 'delivered through an injected transport', actor: 'test' },
      { sendToOwner: async ({ text }) => { sent.push(text); return { messageId: 'message-test-injected' }; } },
      { chatFile });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /delivered through an injected transport/);
    assert.ok(result, 'an injected transport must produce a normal result');
  }

  console.log('coordinator-escalation-sink tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
