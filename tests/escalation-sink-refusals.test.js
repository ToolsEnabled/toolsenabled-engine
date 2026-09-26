'use strict';

const { activate } = require('./lib/isolated-environment');
activate('escalation-sink-refusals');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sink = require('../src/lib/coordinator/escalation-sink');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'escalation-sink-refusals-'));
let sequence = 0;
const candidate = {
  subsystemId: 'refusal-fixture',
  state: 'DOWN',
  reason: 'driven refusal fixture'
};

function files() {
  sequence += 1;
  const dir = path.join(root, String(sequence));
  fs.mkdirSync(dir, { recursive: true });
  return {
    stateFile: path.join(dir, 'state.json'),
    inboxFile: path.join(dir, 'inbox.json')
  };
}

function common(target, overrides = {}) {
  return {
    stateFile: target.stateFile,
    inboxOverrides: { inboxFile: target.inboxFile },
    killSwitch: () => ({ active: false }),
    now: () => 1_800_000_000_000,
    ...overrides
  };
}

(async () => {
  // A timeout after invoking the transport is ambiguous: the receiver may
  // already have accepted the message. The sink must retain a pending attempt,
  // return UNKNOWN (not false), and must not acknowledge anything as delivered.
  {
    const target = files();
    let sends = 0;
    let acknowledgements = 0;
    const result = await sink.escalate({
      ...candidate,
      acknowledgeDirectiveIds: ['owner-directive-00000000-0000-0000-0000-000000000001']
    }, common(target, {
      sendToOwner: async () => {
        sends += 1;
        const error = new Error('answer timed out');
        error.code = 'ETIMEDOUT';
        throw error;
      },
      acknowledgeWithoutReply: () => { acknowledgements += 1; }
    }));

    assert.equal(result.error, 'ESCALATION_DELIVERY_UNKNOWN');
    assert.equal(result.delivered, null);
    assert.equal(result.recorded, false);
    assert.match(result.reason, /delivery is UNKNOWN/);
    assert.equal(sends, 1, 'the ambiguity must be driven through the transport');
    assert.equal(acknowledgements, 0, 'unknown delivery must not spawn acknowledgements');
    const state = JSON.parse(fs.readFileSync(target.stateFile, 'utf8'));
    assert.equal(state.attempts.length, 1);
    assert.equal(state.attempts[0].outcome, 'pending', 'unknown must not be written as failed');
  }

  // Force the post-send state lock to fail. This leaves a real observed result
  // in the module's owed-resolution queue and drives both public readers'
  // ESCALATION_STATE_INCOMPLETE refusal without stubbing their internals.
  {
    const target = files();
    const lockFile = `${path.resolve(target.stateFile)}.lock`;
    let sends = 0;
    let appends = 0;
    const result = await sink.escalate(candidate, common(target, {
      sendToOwner: async () => {
        sends += 1;
        fs.writeFileSync(lockFile, 'held', { flag: 'wx' });
        return { messageId: 'message-refusal-fixture' };
      },
      appendDirective: () => { appends += 1; return { id: 'trail-item' }; }
    }));
    fs.unlinkSync(lockFile);

    assert.equal(result.delivered, true);
    assert.equal(result.recorded, false);
    assert.match(result.error, /^STATE_ESCALATION_STATE_BUSY$/);
    assert.equal(sends, 1);
    assert.equal(appends, 1);

    const before = fs.readFileSync(target.stateFile, 'utf8');
    const status = sink.sinkStatus(common(target));
    assert.equal(status.error, 'ESCALATION_STATE_INCOMPLETE');
    assert.equal(status.channel.broken, null);
    assert.equal(status.totals, null);
    assert.equal(status.entries, null);
    assert.equal(status.pendingAttempts.length, 1);
    assert.throws(
      () => sink.suppressedSince(0, { stateFile: target.stateFile }),
      error => error && error.code === 'ESCALATION_STATE_INCOMPLETE'
    );
    assert.equal(fs.readFileSync(target.stateFile, 'utf8'), before,
      'incomplete-state readers must not write guessed state');
    assert.equal(sends, 1, 'incomplete-state readers must not send or spawn work');
    assert.equal(appends, 1, 'incomplete-state readers must not append a trail');

    // Make the durable state valid but inconsistent with the owed resolution by
    // deleting its pending attempt. The next acquisition must refuse before its
    // decision, wire call, or trail append rather than silently dropping truth.
    const inconsistent = JSON.parse(before);
    inconsistent.attempts = [];
    fs.writeFileSync(target.stateFile, `${JSON.stringify(inconsistent, null, 2)}\n`);
    const afterFixtureWrite = fs.readFileSync(target.stateFile, 'utf8');

    await assert.rejects(
      sink.escalate({ ...candidate, subsystemId: 'second-fixture' }, common(target, {
        sendToOwner: async () => { sends += 1; return { messageId: 'should-not-send' }; },
        appendDirective: () => { appends += 1; return { id: 'should-not-append' }; }
      })),
      error => error && error.code === 'ESCALATION_STATE_INCONSISTENT'
    );
    assert.equal(sends, 1, 'inconsistent state must refuse before the wire');
    assert.equal(appends, 1, 'inconsistent state must refuse before trail writes');
    assert.equal(fs.readFileSync(target.stateFile, 'utf8'), afterFixtureWrite,
      'inconsistent-state refusal must not rewrite state');
    assert.equal(fs.existsSync(lockFile), false, 'the refusal must release its lock');
  }

  fs.rmSync(root, { recursive: true, force: true });
  process.stdout.write('escalation-sink refusal tests passed\n');
})().catch(error => {
  fs.rmSync(root, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
