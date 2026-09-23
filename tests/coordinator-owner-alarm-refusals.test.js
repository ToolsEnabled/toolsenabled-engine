'use strict';

const assert = require('node:assert/strict');
const {
  OwnerAlarmChannelError,
  sendToOwner
} = require('../src/lib/coordinator/owner-alarm-channel.js');

const ALARM = Object.freeze({ text: 'COORDINATOR ESCALATION: the supervisor is DOWN.' });

function controlledRuntime({ sendResult, projection } = {}) {
  const calls = [];
  const factory = () => {
    calls.push('runtime');
    return {
      identity(agentId) {
        calls.push(`identity:${agentId}`);
        return { agentId };
      },
      ownerActor: { actorId: 'owner', actorKind: 'owner' },
      fabric: {
        async send() {
          calls.push('send');
          return sendResult;
        },
        async ownerProjection() {
          calls.push('projection');
          return projection;
        }
      }
    };
  };
  return { calls, factory };
}

async function refused(run, code) {
  await assert.rejects(run, error => {
    assert.ok(error instanceof OwnerAlarmChannelError);
    assert.equal(error.code, code);
    return true;
  });
}

(async () => {
  {
    let spawned = 0;
    const runtimeFactory = () => {
      spawned += 1;
      throw new Error('invalid input must not construct a runtime');
    };
    await refused(
      () => sendToOwner(['not', 'an', 'object'], { runtimeFactory }),
      'OWNER_ALARM_INVALID'
    );
    assert.equal(spawned, 0, 'invalid input must refuse before any runtime, send, or write can occur');
  }

  {
    const runtime = controlledRuntime({ sendResult: { accepted: false, code: 'not a valid code!' } });
    await refused(
      () => sendToOwner(ALARM, { runtimeFactory: runtime.factory }),
      'OWNER_ALARM_REFUSED'
    );
    assert.deepEqual(runtime.calls, [
      'runtime',
      'identity:coordinator',
      'identity:owner',
      'send'
    ], 'a fabric refusal must not spawn a verifier or attempt a journal read');
  }

  {
    const runtime = controlledRuntime({
      sendResult: { accepted: true, message: {}, journal: { sequence: 4 } }
    });
    await refused(
      () => sendToOwner(ALARM, { runtimeFactory: runtime.factory }),
      'OWNER_ALARM_RECEIPT_UNREADABLE'
    );
    assert.deepEqual(runtime.calls, [
      'runtime',
      'identity:coordinator',
      'identity:owner',
      'send'
    ], 'an unverifiable receipt must not spawn a verifier or perform a journal read');
  }

  {
    const runtime = controlledRuntime({
      sendResult: {
        accepted: true,
        message: { id: 'message-accepted-but-retention-moved' },
        journal: { sequence: 9 }
      },
      projection: { journal: { status: 'TRUNCATED', records: [] } }
    });
    await refused(
      () => sendToOwner(ALARM, { runtimeFactory: runtime.factory }),
      'OWNER_ALARM_JOURNAL_TRUNCATED'
    );
    assert.deepEqual(runtime.calls, [
      'runtime',
      'identity:coordinator',
      'identity:owner',
      'send',
      'runtime',
      'projection'
    ], 'a truncated read-back must stop without reporting a successful receipt');
  }

  process.stdout.write('coordinator owner alarm refusals: 4 driven refusals passed\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
