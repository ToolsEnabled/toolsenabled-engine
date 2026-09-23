'use strict';

// THE CALLER'S OWN SESSION REACHES THE DIRECTORY, AND ONLY FROM THE SURFACE
// THAT VOUCHED FOR IT. See src/lib/agent-comms/tree-node-directory.js ("TWO
// TREES ON ONE COMPUTER"): when several live circles share the caller's name,
// the directory tells them apart by the session the owner host bound, which
// the MCP surface hands every tool as `agentSessionId` and, for a declared
// identity, inside `agentPrincipal`. The provider's whole job here is to pass
// exactly that through, and to pass nothing when there is nothing.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLocalAgentMessageProvider } = require('../../src/lib/providers/agent-comms-local');

function recordingDirectory() {
  const calls = [];
  return {
    calls,
    listNodes() { return []; },
    resolveDelivery(input) {
      calls.push(['resolveDelivery', input]);
      return { ok: false, code: 'TREE_SENDER_AMBIGUOUS', message: 'refused for the test' };
    },
    reachableFrom(input) { calls.push(['reachableFrom', input]); return []; },
    reachabilityFrom(input) { calls.push(['reachabilityFrom', input]); return { ok: true, reachable: [], unavailable: [] }; }
  };
}

function providerOver(directory) {
  return createLocalAgentMessageProvider({
    directory,
    runtimeFactory() { throw new Error('never built: every call in this suite is refused or a read'); }
  });
}

test('send and roster hand the vouched-for session to the directory, the declared principal first', async () => {
  const directory = recordingDirectory();
  const provider = providerOver(directory);

  await provider.send({ from: 'Worker', to: 'Manager', body: 'hello' }, {
    agentSessionId: 'chat-bound',
    agentPrincipal: { kind: 'agent-session', sessionId: 'chat-principal', agentId: 'node-1' }
  });
  assert.deepEqual(directory.calls.map(([name, input]) => [name, input.senderSessionId]), [
    ['resolveDelivery', 'chat-principal'],
    ['reachableFrom', 'chat-principal']
  ], 'the resolution and the refusal\'s "what it could have said" list must name the same caller');

  directory.calls.length = 0;
  provider.roster({ from: 'Worker' }, { agentSessionId: 'chat-bound' });
  assert.deepEqual(directory.calls, [['reachabilityFrom', { from: 'Worker', senderSessionId: 'chat-bound' }]],
    'a bound session without a declared identity is still vouched for by the owner host');
});

test('a caller the surface could not vouch for reaches the directory with no session at all', async () => {
  const directory = recordingDirectory();
  const provider = providerOver(directory);

  await provider.send({ from: 'Worker', to: 'Manager', body: 'hello' });
  provider.roster({ from: 'Worker' });
  assert.equal(directory.calls.length, 3, 'the resolution, its refusal list and the roster were all asked');
  for (const [, input] of directory.calls) {
    assert.equal(input.senderSessionId, null, 'nothing is invented for a caller nobody bound');
  }

  /* The words the caller wrote are never a session, and neither is an empty
     or blank binding. */
  directory.calls.length = 0;
  provider.roster({ from: 'Worker', senderSessionId: 'chat-forged' }, { agentSessionId: '   ' });
  assert.equal(directory.calls[0][1].senderSessionId, null,
    'a session id written into the arguments, or a blank binding, is not the caller\'s session');
});
