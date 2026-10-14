// EXECUTABLE CHANGE
'use strict';

// Test-can-fail report (testcanfail-tests-coordinator-owner-alarm-channel-test-js)
//
// STRENGTHENED: the over-long-alarm check formerly compared the emitted body
// length with channel.MAX_BODY_LENGTH. Mutating the product limit from 4000 to
// 4001 left all eight checks green because both actual and expected values came
// from the same code. The assertion now pins the public 4000-character
// contract. Under that same mutation it went RED with:
//
//   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
//   4001 !== 4000
//
// RESTORATION: src/lib/coordinator/owner-alarm-channel.js was restored exactly;
// its SHA-256 before and after mutation was
// 8816ce644d4d0983c22a5004011c272505c0320825aa8e6b5dfe4e61ad9b9617.
// The restored test run ended GREEN with:
//
//   coordinator-owner-alarm-channel: 8 checks passed
//
// NOT-FOUND (1): no assertion is inside a loop/forEach over a possibly empty
// collection. NOT-FOUND (2): no exit-status or generic truthy-return assertion
// is used as evidence. NOT-FOUND (3): no try/catch or optional chain swallows a
// subject failure; the terminal catch makes the process fail. NOT-FOUND (4):
// injected runtimes separate send receipts from journal evidence rather than
// asserting that the mocked send itself is correct. NOT-FOUND (5): there is no
// skip or platform precondition guard. NOT-FOUND (6), beyond the fixed body
// length assertion: expected decisions, error codes, identities, message
// fields, and prohibited source shapes are independently specified literals.
// PRECONDITIONS: the default Node v20.20.2 lacks node:sqlite, so measurements
// used installed Node v24.15.0. This checkout also lacks config/agent-org.json;
// each full run temporarily copied config/agent-org.example.json to that path
// and removed it afterward. Neither precondition changed a product check.

// THE COORDINATOR'S ALARM, END TO END, THROUGH THIS PRODUCT.
// Plain `node tests/coordinator-owner-alarm-channel.test.js`.
//
// NOTHING HERE REACHES ANYTHING EXTERNAL. The message fabric is local and
// opens no socket (src/lib/agent-comms/local-runtime.js injects an in-process
// transport). Every durable path this test touches -- the state store, the
// broker spool, the presence registry and mailbox, the vault, the audit ledger
// and the KILLSWITCH -- is redirected under a scratch root BEFORE the modules
// that resolve those paths at load time are required. That ordering is
// load-bearing: src/lib/agent-presence.js resolves its three coordinated files
// in module-level consts, so an override set after the require would be
// ignored and this test would write into the real state directory.
//
// The claims under test:
//   1. an escalation sent with NO injected sender reaches the owner journal,
//      and reads back through the same call the app's Comms page makes
//   2. `delivered` means IN THE JOURNAL, not "the send function returned"
//   3. a fabric refusal VALUE becomes a throw carrying its own code, so it can
//      never be mistaken for a delivery
//   4. the channel cannot be pointed at anyone but the owner, and has no reply

const { activate } = require('./lib/isolated-environment');
const scratch = activate('coordinator-owner-alarm-channel');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Redirect everything the local message fabric writes, before it is required.
process.env.TOOLSENABLED_STATE_ROOT = scratch.root;
process.env.TOOLSENABLED_AGENT_PRESENCE_FILE = path.join(scratch.root, 'agent-presence.json');
process.env.TOOLSENABLED_AGENT_MAILBOX_DIR = path.join(scratch.root, 'agent-mailbox');
process.env.TOOLSENABLED_AGENT_LAUNCH_DIR = path.join(scratch.root, 'agent-launch');
process.env.TOOLSENABLED_AGENT_COMMS_BROKER_FILE = path.join(scratch.root, 'local-broker.json');

const channel = require('../src/lib/coordinator/owner-alarm-channel.js');
const sink = require('../src/lib/coordinator/escalation-sink.js');
const policy = require('../src/lib/coordinator/escalation-policy.js');
const localMessages = require('../src/lib/providers/agent-comms-local.js');

const T0 = 1_800_000_000_000;
const DOWN = {
  subsystemId: 'fleet-supervisor',
  state: 'DOWN',
  reason: 'the pid lock holder is gone and the scheduled task is not registered',
  detectedBy: 'coordinator-duty-host'
};

let caseIndex = 0;
function freshDir() {
  caseIndex += 1;
  const dir = path.join(scratch.root, `case-${caseIndex}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

/**
 * A stand-in runtime whose fabric accepts a send and reports a journal
 * sequence, but whose journal is whatever the caller says it is. This is how
 * "the send call returned" and "the message is where the owner can see it" are
 * pulled apart: no real fabric lets you have one without the other, which is
 * exactly why the difference cannot be observed without a fake.
 */
function fakeRuntime({
  accept = true,
  refusalCode = 'FABRIC_HOME_NODE_UNCONFIGURED',
  journalled = true,
  projectionOverride
} = {}) {
  const calls = [];
  const messageId = 'message-11111111-2222-3333-4444-555555555555';
  const factory = () => Object.freeze({
    identity: agentId => Object.freeze({ agentId, machineId: 'test-machine' }),
    ownerActor: Object.freeze({ actorId: 'owner', actorKind: 'owner' }),
    fabric: Object.freeze({
      async send(input, authentication) {
        calls.push({ input, authentication });
        if (!accept) return Object.freeze({ accepted: false, code: refusalCode });
        return Object.freeze({
          accepted: true,
          code: 'BROKER_DELIVERED',
          message: Object.freeze({ id: messageId, body: input.body }),
          stream: Object.freeze({ id: 'direct.abc', sequence: 1 }),
          journal: Object.freeze({ id: 'owner.journal', sequence: 7 })
        });
      },
      async ownerProjection() {
        if (projectionOverride !== undefined) return projectionOverride;
        return Object.freeze({
          journal: Object.freeze({
            status: 'BACKLOG',
            records: journalled
              ? [Object.freeze({ sequence: 7, message: { streamId: 'direct.abc', message: { id: messageId } } })]
              : []
          })
        });
      }
    })
  });
  return { calls, factory, messageId };
}

(async () => {
  // --- 1. The real thing, with nothing injected ----------------------------
  //
  // This is the claim the owner's sentence turns on: the coordinator points at
  // our own product. No sendToOwner is passed, so the sink uses its default,
  // and the message has to turn up in the journal the app reads.
  await check('an escalation with NO injected sender lands in the owner journal', async () => {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');

    const before = await localMessages.ownerJournal({ limit: 200 });
    assert.equal(before.ok, true, 'the owner journal must be readable to begin with');
    const beforeCount = before.messages.length;

    const result = await sink.escalate(DOWN, {
      stateFile,
      inboxOverrides: { inboxFile },
      killSwitch: () => ({ active: false }),
      now: () => T0
    });

    assert.equal(result.decision, policy.DECISION.SEND);
    assert.equal(result.delivered, true, `the alarm must be delivered (error: ${result.error})`);
    assert.equal(result.channel, 'agent-comms');
    assert.equal(result.recorded, true);
    assert.match(String(result.messageId), /^message-/, 'the receipt carries the fabric message id');

    // THE READ THE APP ACTUALLY MAKES. src/lib/providers/agent-comms-local.js
    // #ownerJournal is what shell/agent-command-surface.cjs calls for
    // 'agent:local-messages', which is both the Comms page (bridge.localMessages)
    // and the phone (GET /v1/agent/local-messages on the facade). If the alarm
    // is visible here it is visible on both.
    const after = await localMessages.ownerJournal({ limit: 200 });
    assert.equal(after.ok, true);
    assert.equal(after.messages.length, beforeCount + 1, 'exactly one new message');
    const shown = after.messages.at(-1);
    assert.match(shown.text, /COORDINATOR ESCALATION: fleet-supervisor is DOWN/);
    assert.match(shown.text, /pid lock holder is gone/);
    assert.match(shown.text, /not a reply to a message/,
      'the alarm must keep saying it is a notice, not an answer from him');
    assert.equal(shown.sender, 'coordinator');
    assert.equal(shown.contentTrust, 'untrusted');
    assert.equal(shown.grantsAuthority, false);
  });

  // --- 2. Delivered means IN THE JOURNAL -----------------------------------
  await check('a send the journal did not keep is NOT delivered', async () => {
    const runtime = fakeRuntime({ journalled: false });
    await assert.rejects(
      () => channel.sendToOwner({ text: 'COORDINATOR ESCALATION: x is DOWN.' }, { runtimeFactory: runtime.factory }),
      error => error.code === 'OWNER_ALARM_NOT_IN_JOURNAL');
    assert.equal(runtime.calls.length, 1, 'the send was made; only the confirmation failed');
  });

  await check('an unreadable journal projection is not reported as a definite missing message', async () => {
    for (const projectionOverride of [null, {}, { journal: {} }, { journal: { status: 'BACKLOG' } }]) {
      const runtime = fakeRuntime({ projectionOverride });
      await assert.rejects(
        () => channel.sendToOwner(
          { text: 'COORDINATOR ESCALATION: x is DOWN.' },
          { runtimeFactory: runtime.factory }
        ),
        error => error.code === 'OWNER_ALARM_JOURNAL_UNREADABLE');
    }
  });

  await check('the sink records that as a FAILED, undeduped, visibly broken channel', async () => {
    const dir = freshDir();
    const stateFile = path.join(dir, 'escalation.json');
    const inboxFile = path.join(dir, 'inbox.json');
    const runtime = fakeRuntime({ journalled: false });

    const result = await sink.escalate(DOWN, {
      stateFile,
      inboxOverrides: { inboxFile },
      sendToOwner: input => channel.sendToOwner(input, { runtimeFactory: runtime.factory }),
      killSwitch: () => ({ active: false }),
      now: () => T0
    });
    assert.equal(result.delivered, false);
    assert.equal(result.error, 'OWNER_ALARM_NOT_IN_JOURNAL');

    const status = sink.sinkStatus({ stateFile, now: () => T0 + 1_000, killSwitch: () => ({ active: false }) });
    assert.equal(status.channel.broken, true, 'a channel that cannot show him the message must not look quiet');
    assert.equal(status.channel.lastSentAtMs, null, 'nothing may be recorded as sent');

    // And the condition is still owed: the next attempt is not deduped away.
    const again = await sink.escalate(DOWN, {
      stateFile,
      inboxOverrides: { inboxFile },
      sendToOwner: input => channel.sendToOwner(input, { runtimeFactory: runtime.factory }),
      killSwitch: () => ({ active: false }),
      now: () => T0 + policy.MIN_SEND_GAP_MS + 1_000
    });
    assert.equal(again.decision, policy.DECISION.SEND,
      'a failed delivery must never dedupe the next one, or a dead channel silences the alarm forever');
  });

  // --- 3. A refusal VALUE is not a delivery --------------------------------
  await check('a fabric refusal becomes a throw carrying its own code', async () => {
    const runtime = fakeRuntime({ accept: false, refusalCode: 'FABRIC_HOME_NODE_UNCONFIGURED' });
    await assert.rejects(
      () => channel.sendToOwner({ text: 'COORDINATOR ESCALATION: x is DOWN.' }, { runtimeFactory: runtime.factory }),
      error => error.code === 'FABRIC_HOME_NODE_UNCONFIGURED');
  });

  await check('blank text is refused before anything is addressed', async () => {
    const runtime = fakeRuntime();
    await assert.rejects(
      () => channel.sendToOwner({ text: '   ' }, { runtimeFactory: runtime.factory }),
      error => error.code === 'OWNER_ALARM_TEXT_REQUIRED');
    assert.equal(runtime.calls.length, 0, 'nothing may reach the fabric');
  });

  await check('the sender is the coordinator and the recipient is the owner, both fixed', async () => {
    const runtime = fakeRuntime();
    await channel.sendToOwner({ text: 'COORDINATOR ESCALATION: x is DOWN.' }, { runtimeFactory: runtime.factory });
    const { input, authentication } = runtime.calls[0];
    assert.equal(input.sender.agentId, 'coordinator');
    assert.equal(input.recipient.agentId, 'owner');
    assert.equal(input.kind, 'notice');
    assert.equal(authentication.identity.agentId, 'coordinator',
      'it may only ever authenticate as itself');
  });

  // --- 4. It can raise an alarm and it can do nothing else -----------------
  //
  // A structural check, like the one tests/coordinator-escalation-sink.test.js
  // keeps on the sink: the property is an ABSENCE of code, and no behavioural
  // test can observe an absence.
  await check('the channel has no reply path and takes no recipient from a caller', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'src', 'lib', 'coordinator', 'owner-alarm-channel.js'), 'utf8');
    const code = source
      .split('\n')
      .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
      .join('\n');
    assert.equal(/\breply\s*\(/.test(code), false,
      'the alarm channel must never gain a way to answer him');
    assert.equal(/ownerChat/.test(code), false,
      'it must not reach the owner-chat surface at all');
    assert.equal(/input\.recipient|input\.to\b|dependencies\.recipient/.test(code), false,
      'the recipient is a constant in this file; a caller must not be able to redirect an alarm');
    // One recipient constant, one sender constant, and both are read from the
    // module rather than from the call.
    assert.equal(channel.OWNER_AGENT_ID, 'owner');
    assert.equal(channel.SENDER_AGENT_ID, 'coordinator');
  });

  await check('an over-long alarm is shortened, never dropped', async () => {
    const runtime = fakeRuntime();
    const long = `COORDINATOR ESCALATION: x is DOWN.\n${'y'.repeat(channel.MAX_BODY_LENGTH + 500)}`;
    const result = await channel.sendToOwner({ text: long }, { runtimeFactory: runtime.factory });
    assert.equal(result.truncated, true);
    assert.equal(runtime.calls[0].input.body.length, 4000,
      'the alarm channel contract caps bodies at 4000 characters');
    assert.match(runtime.calls[0].input.body, /^COORDINATOR ESCALATION: x is DOWN\./,
      'the line a person acts on has to survive the shortening');
  });

  console.log(`coordinator-owner-alarm-channel: ${passed} checks passed`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
