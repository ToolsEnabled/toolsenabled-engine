'use strict';

// THE RE-SEND: A MESSAGE THE OWNER HAD ALREADY RECEIVED, SENT AGAIN.
// Plain `node tests/coordinator-escalation-resend.test.js`.
//
// THE DEFECT, traced rather than assumed. escalation-sink.js#escalate takes the
// state lock TWICE around one irreversible send: once to reserve the attempt
// before the wire, once to record the outcome after it. The second one ran with
// no try/catch, unlike the send above it and the inbox write below it. So when
// it threw ESCALATION_STATE_BUSY -- which is what withLock throws when another
// writer holds state/coordinator-escalation.json.lock -- escalate() threw,
// AFTER the owner already had the message.
//
// Two things then compound:
//   1. `delivered: true` is the ONLY thing that writes the dedupe stamp
//      (escalation-policy.js#applyDecision), and the resolve phase is where
//      that happens. It never ran, so the stamp was never written.
//   2. duty-registry.js:201-211 classifies ESCALATION_STATE_BUSY as TRANSIENT
//      and reports "the escalation is still owed; the next cycle retries it".
//      That classification is CORRECT for the pre-send lock, where nothing has
//      been sent. It is wrong here, and nothing in the code distinguished them.
//
// So the next cycle re-sent it, on the one channel that carries every other
// alarm -- which is how a reader is trained to ignore it.
//
// The claims under test:
//   1. a post-send lock failure does not throw, and says the outcome is not
//      recorded rather than pretending it is
//   2. the owed outcome is folded into the very next acquisition, so the next
//      escalation is SUPPRESSED as a duplicate and the wire is used ONCE
//   3. a PRE-send lock failure still throws ESCALATION_STATE_BUSY, because
//      there the escalation genuinely is still owed

const { activate } = require('./lib/isolated-environment');
activate('coordinator-escalation-resend');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sink = require('../src/lib/coordinator/escalation-sink.js');
const policy = require('../src/lib/coordinator/escalation-policy.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coordinator-escalation-resend-'));
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

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

/**
 * A sender that ALSO takes the state lock and keeps it.
 *
 * This is the only honest way to reproduce the bug: the lock has to be held at
 * the moment BETWEEN the wire and the resolve, which is precisely the window
 * the sender runs in. A freshly created lock file is not stale, so withLock
 * cannot reclaim it and must exhaust its retries -- exactly what a live
 * competing writer (this host's own cycle, or a person running
 * tools/coordinator-escalate.js) looks like from in here.
 */
function senderThatSeizesTheLock(stateFile) {
  const calls = [];
  const lock = `${stateFile}.lock`;
  return {
    calls,
    lock,
    send: async ({ text }) => {
      calls.push(text);
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, 'held by the test\n', { encoding: 'utf8', mode: 0o600 });
      return { channel: 'agent-comms', messageId: 'message-held-by-the-test' };
    }
  };
}

(async () => {
  // --- 1 & 2. The post-send lock failure, and the re-send it used to cause --
  await check('a post-send lock failure is reported, not thrown, and never re-sends', async () => {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const sender = senderThatSeizesTheLock(stateFile);
    const deps = {
      stateFile,
      inboxOverrides: { inboxFile },
      sendToOwner: sender.send,
      acknowledgeWithoutReply: () => { throw new Error('a test forgot to inject acknowledgeWithoutReply'); },
      killSwitch: () => ({ active: false })
    };

    // BEFORE THE FIX this call threw ESCALATION_STATE_BUSY out of escalate().
    const first = await sink.escalate(DOWN, { ...deps, now: () => T0 });
    assert.equal(first.decision, policy.DECISION.SEND);
    assert.equal(first.delivered, true, 'the owner has the message; that fact may not be lost');
    assert.equal(first.recorded, false, 'and the sink must SAY the outcome did not reach the state file');
    assert.equal(first.error, 'STATE_ESCALATION_STATE_BUSY');
    assert.equal(sender.calls.length, 1);

    // The attempt is visibly unresolved on disk. "We sent something and did not
    // learn what happened to it" is a real state and it must be readable.
    const stranded = sink.sinkStatus({ stateFile, now: () => T0 + 1_000, killSwitch: () => ({ active: false }) });
    assert.equal(stranded.pendingAttempts.length, 1);
    assert.equal(stranded.channel.lastSentAtMs, null);

    // The competing writer finishes and releases.
    fs.unlinkSync(sender.lock);

    // THE CYCLE THAT USED TO RE-SEND. Past the 60s floor, so the rate limit is
    // not what saves it; the only thing that can suppress this is the dedupe
    // stamp for a delivery that had not been written when the decision was
    // last taken.
    const second = await sink.escalate(DOWN, {
      ...deps,
      sendToOwner: async ({ text }) => { sender.calls.push(text); return { messageId: 1 }; },
      now: () => T0 + policy.MIN_SEND_GAP_MS + 1_000
    });
    assert.equal(second.decision, policy.DECISION.SUPPRESS_DUPLICATE,
      'the owner already has this message; sending it again is the defect');
    assert.equal(second.delivered, false);
    assert.equal(sender.calls.length, 1, 'the wire was used exactly once for one condition');

    // And the folded outcome is now genuinely on disk, not just in memory.
    const settled = sink.sinkStatus({
      stateFile, now: () => T0 + policy.MIN_SEND_GAP_MS + 2_000, killSwitch: () => ({ active: false })
    });
    assert.equal(settled.pendingAttempts.length, 0, 'the stranded attempt was resolved, not abandoned');
    assert.equal(settled.channel.lastSentAtMs, T0);
    assert.equal(settled.channel.broken, false);
    assert.equal(settled.totals.sent, 1);
  });

  // --- 3. The pre-send case is genuinely different and must stay so --------
  await check('a PRE-send lock failure still throws: nothing was sent and it is still owed', async () => {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const calls = [];

    // Held before escalate() is called at all, so the FIRST acquisition fails.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${stateFile}.lock`, 'held by the test\n', { encoding: 'utf8', mode: 0o600 });

    await assert.rejects(() => sink.escalate(DOWN, {
      stateFile,
      inboxOverrides: { inboxFile },
      sendToOwner: async ({ text }) => { calls.push(text); return { messageId: 1 }; },
      killSwitch: () => ({ active: false }),
      now: () => T0
    }), error => error.code === 'ESCALATION_STATE_BUSY');
    assert.equal(calls.length, 0,
      'nothing reached the wire, so duty-registry.js is right to call this transient and retry');
    fs.unlinkSync(`${stateFile}.lock`);
  });

  // --- The ordinary path is unchanged --------------------------------------
  await check('with no contention the outcome is recorded inline, as before', async () => {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const calls = [];
    const result = await sink.escalate(DOWN, {
      stateFile,
      inboxOverrides: { inboxFile },
      sendToOwner: async ({ text }) => { calls.push(text); return { channel: 'agent-comms', messageId: 'message-x' }; },
      killSwitch: () => ({ active: false }),
      now: () => T0
    });
    assert.equal(result.delivered, true);
    assert.equal(result.recorded, true);
    assert.equal(result.error, null);
    const status = sink.sinkStatus({ stateFile, now: () => T0 + 1_000, killSwitch: () => ({ active: false }) });
    assert.equal(status.pendingAttempts.length, 0);
    assert.equal(status.channel.lastSentAtMs, T0);
    assert.equal(calls.length, 1);
  });

  console.log(`coordinator-escalation-resend: ${passed} checks passed`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
