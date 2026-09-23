'use strict';

const assert = require('node:assert/strict');
const { DEFAULT_LIVE_WINDOW_MS } = require('../../src/lib/agent-comms/tree-node-directory');
const {
  LocalAgentMessageError,
  MAX_BODY_LENGTH,
  createLocalAgentMessageProvider
} = require('../../src/lib/providers/agent-comms-local');

/* THE RUNTIME MEMO: WHAT MUST REBUILD IT, AND WHAT MUST NOT.
 *
 * The application's tree poll calls inbox() for every running session on
 * TREE_POLL_MS = 1200 (shell/agent-host.cjs, app repo), so the memo's job is to
 * carry a runtime across a tick when nothing about the tree changed. This
 * harness asserts that in the caller's own units rather than in the provider's
 * constant, and asserts the other half too: a circle that registered a moment
 * ago must be in the very next runtime even though no time has passed at all.
 *
 * Every collaborator is injected and in memory. Nothing here opens the broker
 * file, the state store or the tree directory: what is under test is which
 * calls reach the factory, not what the factory then does. */
const APPLICATION_TREE_POLL_MS = 1200;
const CIRCLE_A = 'tree-aaaaaaaaaaaaaaaaaaaaaaaa';
const CIRCLE_B = 'tree-bbbbbbbbbbbbbbbbbbbbbbbb';

function memoHarness() {
  const builds = [];
  let clock = 1_000_000;
  let nodes = [CIRCLE_A];
  const provider = createLocalAgentMessageProvider({
    directory: {
      listNodes() { return nodes.map(agentId => ({ agentId })); },
      resolveDelivery() { throw new Error('the memo assertions never send'); },
      reachableFrom() { return []; }
    },
    brokerFile: 'memo-harness-local-broker.json',
    now: () => clock,
    runtimeFactory(options) {
      builds.push([...options.extraAgentIds].sort());
      return {
        identity(agentId) { return { agentId }; },
        fabric: { async read() { return { records: [] }; } }
      };
    }
  });
  return {
    builds,
    advance(milliseconds) { clock += milliseconds; },
    poll(agentId) { return provider.inbox({ agentId }); },
    register(agentId) { nodes = [...nodes, agentId]; }
  };
}

/* T201: THE ACKNOWLEDGE DOOR, WHICH IS WHAT LETS A READER BE DECLARED AT ALL.
 *
 * history.js refuses to evict a record a declared reader has not acknowledged
 * (HISTORY_CHANNEL_UNREAD_FULL). That protection is unreachable from the tree
 * path while nothing can advance a durable cursor: inbox() reads and nothing
 * more, so the application kept its own in-memory treeCursor and the durable
 * cursor stayed at zero forever. Declaring a reader BEFORE this door existed
 * would have wedged the channel closed -- append refusing on behalf of a reader
 * that can never acknowledge -- so the door comes first and is proved here.
 *
 * Driven by VALUES through an injected fabric: what is asserted is that the
 * door refuses each malformed call by its own name, addresses the fabric the
 * way inbox() addresses it, and hands the fabric's in-order refusal BACK
 * instead of throwing. */
async function acknowledgeDoorTests() {
  const calls = [];
  const provider = createLocalAgentMessageProvider({
    directory: {
      listNodes() { return [{ agentId: CIRCLE_A }]; },
      resolveDelivery() { throw new Error('the acknowledge door never sends'); },
      reachableFrom() { return []; }
    },
    brokerFile: 'acknowledge-door-local-broker.json',
    now: () => 1_000_000,
    runtimeFactory() {
      return {
        identity(agentId) { return { agentId }; },
        fabric: {
          async read() { return { records: [] }; },
          async markRead(input) {
            calls.push(input);
            return Object.freeze({ accepted: false, code: 'FABRIC_READ_OUT_OF_ORDER', cursor: 0 });
          }
        }
      };
    }
  });

  for (const [input, code] of [
    [{ messageId: 'msg-1', sequence: 1 }, 'AGENT_ACK_AGENT_INVALID'],
    [{ agentId: CIRCLE_A, sequence: 1 }, 'AGENT_ACK_MESSAGE_INVALID'],
    [{ agentId: CIRCLE_A, messageId: 'msg-1' }, 'AGENT_ACK_SEQUENCE_INVALID'],
    [{ agentId: CIRCLE_A, messageId: 'msg-1', sequence: 0 }, 'AGENT_ACK_SEQUENCE_INVALID'],
    [{ agentId: CIRCLE_A, messageId: 'msg-1', sequence: 1.5 }, 'AGENT_ACK_SEQUENCE_INVALID']
  ]) {
    await assert.rejects(
      () => provider.acknowledge(input),
      error => error instanceof LocalAgentMessageError && error.code === code,
      `acknowledge(${JSON.stringify(input)}) must refuse with ${code}`
    );
  }
  assert.equal(calls.length, 0, 'an argument the door refused must never reach the fabric');

  const answer = await provider.acknowledge({ agentId: CIRCLE_A, messageId: 'msg-1', sequence: 4 });
  assert.equal(calls.length, 1, 'a well-formed acknowledgement must reach the fabric exactly once');
  const [sent] = calls;
  assert.deepEqual(sent.agent, { agentId: CIRCLE_A }, 'the door must resolve the identity inbox() resolves');
  assert.deepEqual(sent.audience, { type: 'direct', agent: { agentId: CIRCLE_A } },
    'the door must address the same durable channel inbox() reads');
  assert.equal(sent.messageId, 'msg-1');
  assert.equal(sent.sequence, 4);
  /* The fabric refuses empty read evidence (FABRIC_READ_EVIDENCE_REQUIRED), so
     a door that sent none would refuse every acknowledgement in production
     while every injected test passed. */
  assert.ok(sent.evidence && Object.keys(sent.evidence).length >= 1,
    'the fabric refuses empty read evidence, so the door must always send some');

  /* markRead is strictly in order and says so by ANSWERING. A door that threw
     here would cost a batching caller its place in the queue. */
  assert.deepEqual(answer, { accepted: false, code: 'FABRIC_READ_OUT_OF_ORDER', cursor: 0 },
    'the fabric in-order refusal must be returned to the caller, not thrown');
}

async function runtimeMemoTests() {
  const memo = memoHarness();

  await memo.poll(CIRCLE_A);
  await memo.poll(CIRCLE_A);
  assert.equal(memo.builds.length, 1, 'two inbox reads in one poll tick must share one runtime');

  /* THE ASSERTION THE ONE-SECOND LIFETIME FAILED. A memo that expires before
   * the next tick pays a full rebuild every tick for as long as the product
   * runs, which is the entire cost it was added to avoid. */
  memo.advance(APPLICATION_TREE_POLL_MS);
  await memo.poll(CIRCLE_A);
  assert.equal(memo.builds.length, 1, 'the memo must survive one application tree poll period');

  /* THE WRITE THAT CHANGES AGENT DISCOVERY INVALIDATES IT, WITH THE CLOCK
   * STANDING STILL. This is why the lifetime may be long: it is not what
   * answers "has the tree changed". */
  memo.register(CIRCLE_B);
  await memo.poll(CIRCLE_A);
  assert.equal(memo.builds.length, 2, 'a circle that just registered must rebuild the runtime with no delay');
  assert.deepEqual(memo.builds[1], [CIRCLE_A, CIRCLE_B],
    'the rebuilt runtime must be able to address the circle that just registered');

  // An agent this runtime was not built with is never answered out of it.
  await memo.poll('owner');
  assert.equal(memo.builds.length, 3, 'an agent absent from the memoized runtime must force a rebuild');
  assert.deepEqual(memo.builds[2], ['owner', CIRCLE_A, CIRCLE_B].sort(),
    'the rebuilt runtime must carry every registered circle as well as the named agent');

  await memo.poll('owner');
  assert.equal(memo.builds.length, 3, 'unchanged inputs inside the lifetime must not rebuild');

  /* AND THE LIFETIME IS BOUNDED. The tree directory's own live window is what
   * this product already tells a person about how current a fact about another
   * circle is; a runtime object may not outlive that. */
  memo.advance(DEFAULT_LIVE_WINDOW_MS);
  await memo.poll('owner');
  assert.equal(memo.builds.length, 4,
    'a runtime must not be held for as long as the tree directory live window');
}

function resolvedDirectory() {
  return {
    resolveDelivery() {
      return {
        ok: true,
        relation: 'child',
        sender: { agentId: 'sender-id', nodeName: 'sender' },
        recipient: { agentId: 'recipient-id', nodeName: 'recipient' }
      };
    },
    reachableFrom() {
      return ['recipient'];
    },
    listNodes() {
      return [];
    }
  };
}

async function throwingRefusal(code, body) {
  let runtimeConstructions = 0;
  const provider = createLocalAgentMessageProvider({
    directory: resolvedDirectory(),
    runtimeFactory() {
      runtimeConstructions += 1;
      throw new Error('a malformed message must be rejected before a runtime can write or spawn');
    }
  });

  await assert.rejects(
    provider.send({ from: 'sender', to: 'recipient', body }),
    error => {
      assert.ok(error instanceof LocalAgentMessageError);
      assert.equal(error.code, code);
      return true;
    }
  );
  assert.equal(runtimeConstructions, 0, `${code} constructed a runtime before refusing`);
}

(async () => {
  await throwingRefusal('AGENT_MESSAGE_BODY_REQUIRED', ' \n\t ');
  await throwingRefusal('AGENT_MESSAGE_BODY_TOO_LONG', 'x'.repeat(MAX_BODY_LENGTH + 1));

  let runtimeConstructions = 0;
  let sendAttempts = 0;
  let identityCalls = 0;
  const provider = createLocalAgentMessageProvider({
    directory: resolvedDirectory(),
    runtimeFactory() {
      runtimeConstructions += 1;
      return {
        identity(agentId) {
          identityCalls += 1;
          return { agentId };
        },
        fabric: {
          async send() {
            sendAttempts += 1;
            // This injected dependency refuses before doing any real broker I/O.
            return { accepted: false };
          }
        }
      };
    }
  });

  const result = await provider.send({ from: 'sender', to: 'recipient', body: 'hello' });
  assert.deepEqual(result, {
    accepted: false,
    code: 'AGENT_MESSAGE_REFUSED',
    reason: 'The local message fabric refused this message.'
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(runtimeConstructions, 1, 'delivery should use only the injected in-memory runtime');
  assert.equal(identityCalls, 2, 'delivery should resolve only the sender and recipient identities');
  assert.equal(sendAttempts, 1, 'the injected fabric should receive exactly one refused attempt');

  await runtimeMemoTests();
  await acknowledgeDoorTests();

  console.log('agent-comms-local refusal and runtime-memo tests passed');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
