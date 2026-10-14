'use strict';

// THE OWNER JOURNAL NAMES EVERY SIDE BY ITS CIRCLE, INCLUDING A REPLACED ONE,
// AND NAMES WHICH SAVED CIRCLE IT IS.
//
// Two defects on the Messages page, both measured on 419fcca:
//
// 1. A session that continued in a successor (registerNode with
//    replacesSessionId) keeps its row, marked supersededBy, and listNodes()
//    hides such rows unless asked. ownerJournal() built its name table from the
//    default listNodes(), so every message to or from a replaced session showed
//    its durable id -- "tree-62d17d01b14ada3283ac011a" -- where the circle name
//    belonged. The routing path (runtimeFor) already asks with
//    includeSuperseded: true.
//
// 2. The app paired with this engine (2eaaf7b, src/comms-feed.js, T1513) tells
//    two same-named circles in different trees apart by the saved circle each
//    side belongs to -- `senderNodeKey` / `recipientNodeKey` on every journal
//    row -- and its comment says the owner journal names them. It did not, so
//    the page could only ever number same-named agents ("Manager · 1") instead
//    of naming their trees.

const isolation = require('../lib/isolated-environment').activate('owner-journal-circle-identity');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');
const { createLocalAgentMessageProvider } = require('../../src/lib/providers/agent-comms-local');

let prefixes = 0;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(isolation.root, 'journal-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = `journal-${++prefixes}`;
  const directory = createTreeNodeDirectory({ file: path.join(root, 'tree.json') });
  const register = (name, managerName = null, extra = {}) => directory.registerNode({
    sessionId: `${prefix}-${name}${extra.suffix || ''}`, nodeName: name, managerName,
    nodeKey: `${prefix}-${name}-node`, treeKey: prefix, pid: process.pid,
    ...(extra.replacesSessionId ? { replacesSessionId: extra.replacesSessionId } : {}),
  });
  const provider = createLocalAgentMessageProvider({ directory, brokerFile: path.join(root, 'broker.json') });
  const send = (from, to, body, session) => provider.send({ from, to, body: `${prefix}: ${body}` },
    { agentSessionId: session.sessionId, agentPrincipal: { sessionId: session.sessionId } });
  /* The owner journal is machine-wide (it lives in the isolated state root, not
     in this fixture's broker file), so each test reads only its own rows. */
  const rows = async () => {
    const journal = await provider.ownerJournal({});
    assert.equal(journal.ok, true, journal.reason);
    return journal.messages.filter(message => message.text.includes(`${prefix}: `));
  };
  return { prefix, register, provider, send, rows };
}

test('a message to or from a session that has since been replaced still shows its circle name', async t => {
  const f = fixture(t);
  const manager = f.register('Manager');
  const builder = f.register('Builder', 'Manager');
  assert.equal((await f.send('Manager', 'Builder', 'Before the restart.', manager)).accepted, true);
  assert.equal((await f.send('Builder', 'Manager', 'Acknowledged.', builder)).accepted, true);
  f.register('Builder', 'Manager', { suffix: '-next', replacesSessionId: builder.sessionId });
  const messages = await f.rows();
  assert.deepEqual(messages.map(message => [message.sender, message.recipient]),
    [['Manager', 'Builder'], ['Builder', 'Manager']],
    'a replaced session was shown by its durable id instead of its circle name');
  for (const message of messages) {
    assert.doesNotMatch(`${message.sender} ${message.recipient}`, /tree-[0-9a-f]{8,}/);
  }
});

test('every journal row names the saved circle on each side, as the paired app reads it', async t => {
  const f = fixture(t);
  const manager = f.register('Manager');
  const builder = f.register('Builder', 'Manager');
  await f.send('Manager', 'Builder', 'Build it.', manager);
  f.register('Builder', 'Manager', { suffix: '-next', replacesSessionId: builder.sessionId });
  const [row, ...others] = await f.rows();
  assert.equal(others.length, 0);
  assert.equal(row.senderNodeKey, `${f.prefix}-Manager-node`);
  assert.equal(row.recipientNodeKey, `${f.prefix}-Builder-node`, 'a replaced recipient lost its saved circle');
  assert.equal(row.senderId, manager.agentId, 'the durable identities are unchanged');
  assert.equal(row.recipientId, builder.agentId);
});
