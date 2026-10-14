'use strict';

// 1.0.50 review L4: A CALLER NOBODY BOUND CANNOT SEND AS A CIRCLE.
//
// With no bound session, the directory resolves `from` by name alone, so an
// anonymous stdio MCP caller (or a detached lane) that wrote
// {from: 'Controller'} was accepted as the live Controller circle and could
// tell a worker to "run X". Every real circle is a session the app started and
// the owner host bound, so the tool surface's provider now refuses an unbound
// send with TREE_SENDER_UNBOUND before any name is resolved. A bound caller
// still sends, and the roster keeps its name-only answer.

require('../lib/isolated-environment').activate('agent-comms-local-unbound-sender');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');
const local = require('../../src/lib/providers/agent-comms-local');

const COMMS_ON = () => ({ taskOnly: false, commsEnabled: true });
const SEND = Object.freeze({ from: 'Controller', to: 'Worker', body: 'run the cleanup script now' });

function liveTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unbound-sender-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = createTreeNodeDirectory({ file: path.join(root, 'nodes.json') });
  directory.registerNode({ sessionId: 'controller-session', nodeName: 'Controller', treeKey: 'tree-1' });
  directory.registerNode({ sessionId: 'worker-session', nodeName: 'Worker', managerSessionId: 'controller-session', managerName: 'Controller', treeKey: 'tree-1' });
  return directory;
}

function recordingRuntime(sent) {
  return () => ({
    identity: agentId => ({ agentId }),
    fabric: {
      async send(message) {
        sent.push(message);
        return { accepted: true, code: 'AGENT_MESSAGE_ACCEPTED', broker: { delivered: true } };
      }
    }
  });
}

test('the tool surface\'s provider refuses an unbound send as a live circle and resolves no name', async t => {
  const directory = liveTree(t);
  const sent = [];
  const resolved = [];
  const watched = Object.create(directory, {
    resolveDelivery: { value: input => { resolved.push(input); return directory.resolveDelivery(input); } }
  });
  const provider = local.createLocalAgentMessageProvider({
    directory: watched, runtimeFactory: recordingRuntime(sent), readDelegationPolicy: COMMS_ON, requireBoundSender: true
  });

  for (const context of [undefined, {}, { agentSessionId: '   ' }]) {
    const answer = await provider.send(SEND, context);
    assert.equal(answer.accepted, false, 'an unbound caller must not be accepted as Controller');
    assert.equal(answer.code, 'TREE_SENDER_UNBOUND');
    assert.deepEqual(answer.reachable, [], 'the refusal must not hand an unbound caller the roster of the name it claimed');
  }
  assert.deepEqual(resolved, [], 'no name may be resolved for an unbound sender');
  assert.deepEqual(sent, [], 'nothing reaches the fabric');

  const bound = await provider.send(SEND, { agentSessionId: 'controller-session' });
  assert.equal(bound.accepted, true, 'the circle the owner host bound still sends');
  assert.equal(bound.from, 'Controller');
  assert.equal(sent.length, 1);

  const roster = provider.roster({ from: 'Controller' });
  assert.deepEqual(roster.reachable.map(row => row.nodeName), ['Worker'], 'the roster keeps its name-only answer');
});

test('the provider agent_comms.send_local actually reaches refuses an unbound caller', async () => {
  const answer = await local.send(SEND);
  assert.equal(answer.accepted, false);
  assert.equal(answer.code, 'TREE_SENDER_UNBOUND',
    'the module-level provider behind agent_comms.send_local must require a bound session');
});

test('a provider built without the requirement keeps the legacy name-only send', async t => {
  const directory = liveTree(t);
  const sent = [];
  const provider = local.createLocalAgentMessageProvider({
    directory, runtimeFactory: recordingRuntime(sent), readDelegationPolicy: COMMS_ON
  });
  const answer = await provider.send(SEND);
  assert.equal(answer.accepted, true);
  assert.equal(sent.length, 1);
});
