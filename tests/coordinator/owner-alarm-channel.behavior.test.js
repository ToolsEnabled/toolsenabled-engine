/*
 * Mutation check: changed `const verifier = runtimeFactory(options);` to
 * `const verifier = runtime;` in owner-alarm-channel.js.
 * The edit landed: yes.
 * This isolated test went red: yes (exit 1, expected two runtime calls but saw one).
 */

'use strict';

const assert = require('node:assert/strict');
const {
  MAX_BODY_LENGTH,
  OWNER_AGENT_ID,
  SENDER_AGENT_ID,
  sendToOwner
} = require('../../src/lib/coordinator/owner-alarm-channel.js');

const calls = [];
const messageId = 'message-owner-alarm-behaviour';

function runtimeFactory(options) {
  calls.push({ operation: 'runtime', options });
  return {
    identity(agentId) {
      return { agentId };
    },
    ownerActor: { actorId: OWNER_AGENT_ID, actorKind: 'owner' },
    fabric: {
      async send(message, authentication) {
        calls.push({ operation: 'send', message, authentication });
        return {
          accepted: true,
          message: { id: messageId },
          stream: { id: 'direct.coordinator-owner' },
          journal: { sequence: 12 }
        };
      },
      async ownerProjection(query) {
        calls.push({ operation: 'projection', query });
        return {
          journal: {
            status: 'BACKLOG',
            records: [{
              sequence: 12,
              message: {
                streamId: 'direct.coordinator-owner',
                message: { id: messageId }
              }
            }]
          }
        };
      }
    }
  };
}

(async () => {
  const text = 'A'.repeat(MAX_BODY_LENGTH + 20);
  const receipt = await sendToOwner(
    { text },
    { runtimeFactory, runtimeOptions: { extraAgentIds: ['observer', SENDER_AGENT_ID] } }
  );

  const runtimeCalls = calls.filter(call => call.operation === 'runtime');
  assert.equal(runtimeCalls.length, 2, 'delivery must be verified through a second runtime');
  assert.deepEqual(runtimeCalls[0].options.extraAgentIds, [SENDER_AGENT_ID, 'observer']);
  assert.deepEqual(runtimeCalls[1].options, runtimeCalls[0].options);

  const send = calls.find(call => call.operation === 'send');
  assert.equal(send.message.sender.agentId, SENDER_AGENT_ID);
  assert.equal(send.message.recipient.agentId, OWNER_AGENT_ID);
  assert.equal(send.message.kind, 'notice');
  assert.equal(send.message.body.length, 4000);
  assert.equal(send.message.body, `${'A'.repeat(3997)}...`);
  assert.deepEqual(send.authentication, { identity: { agentId: SENDER_AGENT_ID } });

  const projection = calls.find(call => call.operation === 'projection');
  assert.deepEqual(projection.query, {
    actor: { actorId: OWNER_AGENT_ID, actorKind: 'owner' },
    cursor: 11,
    limit: 1
  });

  assert.deepEqual(receipt, {
    channel: 'agent-comms',
    messageId,
    journalSequence: 12,
    streamId: 'direct.coordinator-owner',
    truncated: true
  });
  assert.equal(Object.isFrozen(receipt), true);

  process.stdout.write('owner-alarm-channel behaviour: PASS\n');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
