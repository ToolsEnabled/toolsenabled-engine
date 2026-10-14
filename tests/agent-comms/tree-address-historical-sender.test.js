'use strict';

// THE NAME AN AGENT WAS GIVEN STOPS BEING THE NAME IT IS REGISTERED UNDER.
//
// MEASURED 2026-09-12, by a manager on this computer that could not message
// anyone. Its brief said, verbatim, that it was "Manager". Both
// agent_comms.local_roster({ from: 'Manager' }) and a send under that name
// answered TREE_SENDER_UNKNOWN, "No agent called "Manager" is registered on
// this computer's tree." It got through only by reading the directory file and
// finding its row under "Manager (51094ae6)".
//
// WHY THE TWO DIVERGE, measured in the app worktree: the tree brief is written
// ONCE, from a name computed against the peers that existed at that moment, and
// is then a historical document replayed in the transcript. The directory row
// is written from a name recomputed at every registration, including every
// resume. A circle created while it was the only Manager is briefed "Manager";
// once a second Manager exists the namer qualifies it, and the next
// registration stores the qualified name. Nothing updates the brief, and the
// agent is instructed to send the name its brief gave it.
//
// WHAT THIS FIXES, AND WHAT IT MUST NOT. The caller's session is already
// vouched for by the owner host -- src/owner-host.js builds agentPrincipal and
// agentSessionId from the authenticated binding, never from the caller's words,
// and src/lib/providers/agent-comms-local.js passes exactly that through. So a
// caller naming itself by a name no row carries can be resolved to its OWN live
// row without guessing. It must never:
//   - resolve to any session but the caller's own;
//   - alias a name across trees, or map one circle's name to another's row;
//   - override a supplied name that currently identifies someone else;
//   - help a caller nobody vouched for.
// The fallback is therefore reached only when NO row carries the supplied name,
// and it resolves only the caller's own unique live row.
//
// EVERY CASE HERE RUNS THE REAL DIRECTORY, and the send cases run it through the
// real provider, so the message that comes out is the one the fabric would
// carry. That matters for the last requirement: the emitted message must name
// the sender's CURRENT identity, not the historical name it was addressed with.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');
const { createLocalAgentMessageProvider } = require('../../src/lib/providers/agent-comms-local');

function directoryFor(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-address-historical-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return createTreeNodeDirectory({ file: path.join(workspace, 'tree-nodes.json'), pidIsAlive: () => true });
}

/* The real provider over the real directory. The fabric is the one seam a test
   may hold, because a durable message bus is not what is under test; every
   name in the captured packet comes from the directory. */
function providerOver(directory) {
  const sent = [];
  const provider = createLocalAgentMessageProvider({
    directory,
    runtimeFactory: () => ({
      identity: agentId => ({ agentId }),
      fabric: {
        send(packet) {
          sent.push(packet);
          return { accepted: true, code: 'ACCEPTED', message: { id: 'm-1' }, stream: { sequence: 1 }, broker: { delivered: true } };
        }
      }
    })
  });
  return { provider, sent };
}

/* A manager and one worker under it, the smallest tree that has an edge. */
function treeWith(directory, { managerName }) {
  directory.registerNode({ sessionId: 'session-manager', nodeName: managerName, pid: process.pid, treeKey: 'tree-1', nodeKey: 'node-manager' });
  directory.registerNode({
    sessionId: 'session-worker', nodeName: 'Worker 1', managerSessionId: 'session-manager',
    managerName, pid: process.pid, treeKey: 'tree-1', nodeKey: 'node-worker'
  });
}

const bound = sessionId => ({ agentPrincipal: { kind: 'agent-session', sessionId, agentId: 'node-x' } });

test('a new session sends under the name it was registered with, unchanged', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  const { provider, sent } = providerOver(directory);

  const answer = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'hello' }, bound('session-manager'));
  assert.equal(answer.accepted, true);
  assert.equal(answer.from, 'Manager');
  assert.equal(sent[0].body, 'Manager: hello');
});

test('a peer-set rename leaves the historical name working, and the message carries the current one', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  /* The second Manager arrives, the app's namer qualifies the first, and its
     next registration stores the qualified name. This is the whole defect. */
  directory.registerNode({
    sessionId: 'session-manager', nodeName: 'Manager (51094ae6)', pid: process.pid,
    treeKey: 'tree-1', nodeKey: 'node-manager'
  });
  const { provider, sent } = providerOver(directory);

  const answer = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'hello' }, bound('session-manager'));
  assert.equal(answer.accepted, true, `the historical name refused: ${answer.code} ${answer.reason || ''}`);
  /* THE RECEIPT AND THE MESSAGE BOTH NAME THE CURRENT IDENTITY. A reply
     addressed to the historical name would refuse in turn, so echoing it back
     would hand the reader an address that does not work. */
  assert.equal(answer.from, 'Manager (51094ae6)');
  assert.equal(sent[0].body, 'Manager (51094ae6): hello', 'the courier framing must carry the current sender name');
});

test('the roster answers a circle that asks under the name its brief gave it', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  directory.registerNode({
    sessionId: 'session-manager', nodeName: 'Manager (51094ae6)', pid: process.pid,
    treeKey: 'tree-1', nodeKey: 'node-manager'
  });
  const { provider } = providerOver(directory);

  /* The exact call that failed on this computer. */
  const answer = provider.roster({ from: 'Manager' }, bound('session-manager'));
  assert.notEqual(answer.code, 'TREE_SENDER_UNKNOWN', 'the manager could not list anyone using its own name');
  assert.deepEqual(answer.reachable.map(row => row.nodeName), ['Worker 1']);
});

test('a resumed session that re-registers under a new name keeps answering to the old one', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  /* A resume is a NEW sessionId replacing the old row, which is how the app
     registers one (replacesSessionId). The brief it replays is the original. */
  directory.registerNode({
    sessionId: 'session-manager-2', nodeName: 'Manager (7f0c2a11)', pid: process.pid,
    treeKey: 'tree-1', nodeKey: 'node-manager', replacesSessionId: 'session-manager'
  });
  /* The worker's own next registration re-points it at the resumed session,
     which is what the app does on its courier round. */
  directory.registerNode({
    sessionId: 'session-worker', nodeName: 'Worker 1', managerSessionId: 'session-manager-2',
    managerName: 'Manager (7f0c2a11)', pid: process.pid, treeKey: 'tree-1', nodeKey: 'node-worker'
  });
  const { provider, sent } = providerOver(directory);

  const answer = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'after resume' }, bound('session-manager-2'));
  assert.equal(answer.accepted, true, `${answer.code} ${answer.reason || ''}`);
  assert.equal(sent[0].body, 'Manager (7f0c2a11): after resume');
});

/* A RESUME MUST NOT COST A PARENT ITS CHILDREN.
 *
 * A resumed session has a new sessionId and therefore a new agentId, and the
 * children's rows still name the predecessor. When the resume also renames the
 * parent their recorded managerName stops matching too, and edge() tests
 * exactly those two. Before the carry-over the parent had no line to its own
 * children at all until each of them happened to register again, which nothing
 * makes them do promptly.
 *
 * NO CHILD RE-REGISTERS IN ANY CASE BELOW. That is the whole point: the earlier
 * resume case re-registers the worker the way a courier round eventually would,
 * and would pass with or without the fix. */
test('a resumed parent still reaches children that never re-register', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  directory.registerNode({
    sessionId: 'session-manager-2', nodeName: 'Manager (renamed)', pid: process.pid,
    treeKey: 'tree-1', nodeKey: 'node-manager', replacesSessionId: 'session-manager'
  });
  const { provider, sent } = providerOver(directory);

  const answer = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'after resume' }, bound('session-manager-2'));
  assert.equal(answer.accepted, true, `${answer.code} ${answer.reason || ''}`);
  assert.equal(answer.from, 'Manager (renamed)');
  assert.equal(sent[0].body, 'Manager (renamed): after resume');
});

test('the child of a resumed parent can still reach its parent, by the parent\'s new name', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  directory.registerNode({
    sessionId: 'session-manager-2', nodeName: 'Manager (renamed)', pid: process.pid,
    treeKey: 'tree-1', nodeKey: 'node-manager', replacesSessionId: 'session-manager'
  });
  const { provider } = providerOver(directory);

  /* The worker never re-registered, so this is the carried edge answering. */
  const roster = provider.roster({ from: 'Worker 1' }, bound('session-worker'));
  assert.deepEqual(roster.reachable.map(row => [row.nodeName, row.relation]), [['Manager (renamed)', 'manager']]);
});

test('a child reparented before the resume is left where the person put it', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  directory.registerNode({ sessionId: 'session-lead', nodeName: 'Lead', pid: process.pid, treeKey: 'tree-1', nodeKey: 'node-lead' });
  /* The person moves the worker under Lead. Its managerAgentId is rewritten,
     which is what makes it no longer the resumed parent's child. */
  directory.registerNode({
    sessionId: 'session-worker', nodeName: 'Worker 1', managerSessionId: 'session-lead', managerName: 'Lead',
    pid: process.pid, treeKey: 'tree-1', nodeKey: 'node-worker'
  });
  directory.registerNode({
    sessionId: 'session-manager-2', nodeName: 'Manager (renamed)', pid: process.pid,
    treeKey: 'tree-1', nodeKey: 'node-manager', replacesSessionId: 'session-manager'
  });
  const { provider, sent } = providerOver(directory);

  const roster = provider.roster({ from: 'Worker 1' }, bound('session-worker'));
  assert.deepEqual(roster.reachable.map(row => row.nodeName), ['Lead'],
    'the resume must not drag back a child that was reparented away');

  const answer = await provider.send({ from: 'Manager (renamed)', to: 'Worker 1', body: 'mine again' }, bound('session-manager-2'));
  assert.equal(answer.accepted, false, 'the resumed parent has no line to a child it no longer has');
  assert.equal(answer.code, 'TREE_RECIPIENT_NOT_CONNECTED');
  assert.equal(sent.length, 0);
});

test('the carry-over never adopts a same-named circle on another tree', async t => {
  const directory = directoryFor(t);
  directory.registerNode({ sessionId: 'session-a', nodeName: 'Manager', pid: process.pid, treeKey: 'tree-a', nodeKey: 'node-a' });
  /* A worker on ANOTHER tree, whose own parent happens to share the name. It is
     not this predecessor's child, and a resume on tree-a must not take it. */
  directory.registerNode({
    sessionId: 'session-far', nodeName: 'Worker 1', managerSessionId: 'session-far-parent', managerName: 'Manager',
    pid: process.pid, treeKey: 'tree-b', nodeKey: 'node-far'
  });
  directory.registerNode({
    sessionId: 'session-a-2', nodeName: 'Manager (renamed)', pid: process.pid,
    treeKey: 'tree-a', nodeKey: 'node-a', replacesSessionId: 'session-a'
  });
  const { provider, sent } = providerOver(directory);

  const answer = await provider.send({ from: 'Manager (renamed)', to: 'Worker 1', body: 'across' }, bound('session-a-2'));
  assert.equal(answer.accepted, false, 'a resume on one tree must not adopt another tree\'s circle');
  assert.equal(sent.length, 0);
});

test('an explicit rename and reparent are answered by the caller\'s own current row', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  directory.registerNode({ sessionId: 'session-lead', nodeName: 'Lead', pid: process.pid, treeKey: 'tree-1', nodeKey: 'node-lead' });
  /* The person renames the worker and re-points it at the new parent. */
  directory.registerNode({
    sessionId: 'session-worker', nodeName: 'Builder', managerSessionId: 'session-lead', managerName: 'Lead',
    pid: process.pid, treeKey: 'tree-1', nodeKey: 'node-worker'
  });
  const { provider, sent } = providerOver(directory);

  const answer = await provider.send({ from: 'Worker 1', to: 'Lead', body: 'moved' }, bound('session-worker'));
  assert.equal(answer.accepted, true, `${answer.code} ${answer.reason || ''}`);
  assert.equal(answer.from, 'Builder');
  assert.equal(answer.to, 'Lead', 'the new parent is the reachable one');
  assert.equal(sent[0].body, 'Builder: moved');
});

/* ------------------------------------------------------------------
   WHAT THE FALLBACK MAY NEVER DO. Each of these passes today and must keep
   passing: a repair that opened any of them would be worse than the refusal it
   replaced, because a delivery under the wrong sender is indistinguishable
   from a correct one afterwards.
   ------------------------------------------------------------------ */

test('a name that currently identifies someone else is never overridden', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  const { provider, sent } = providerOver(directory);

  /* The worker names itself with the manager's live name. That name IS on a
     row, so the fallback must not be reached at all and this must refuse. */
  const answer = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'not mine' }, bound('session-worker'));
  assert.equal(answer.accepted, false);
  assert.equal(answer.code, 'TREE_SENDER_IDENTITY_MISMATCH');
  assert.equal(sent.length, 0, 'nothing may be emitted for an impersonated sender');
});

test('a caller nobody vouched for gets the same refusal it always got', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  directory.registerNode({
    sessionId: 'session-manager', nodeName: 'Manager (51094ae6)', pid: process.pid,
    treeKey: 'tree-1', nodeKey: 'node-manager'
  });
  const { provider, sent } = providerOver(directory);

  /* No principal and no bound session: the owner host vouched for nothing, so
     there is no own row to fall back to and the historical name stays unknown. */
  const answer = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'hello' }, {});
  assert.equal(answer.accepted, false);
  assert.equal(answer.code, 'TREE_SENDER_UNKNOWN');
  assert.equal(sent.length, 0);
});

test('a caller whose own row is not running cannot send under a historical name', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  directory.registerNode({
    sessionId: 'session-manager', nodeName: 'Manager (51094ae6)', pid: process.pid,
    treeKey: 'tree-1', nodeKey: 'node-manager'
  });
  directory.unregisterNode({ sessionId: 'session-manager' });
  const { provider, sent } = providerOver(directory);

  const answer = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'hello' }, bound('session-manager'));
  assert.equal(answer.accepted, false, 'a stopped circle must not send');
  assert.equal(sent.length, 0);
});

test('a caller bound to a session with no row at all is still unknown', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  const { provider, sent } = providerOver(directory);

  const answer = await provider.send({ from: 'Ghost', to: 'Worker 1', body: 'hello' }, bound('session-never-registered'));
  assert.equal(answer.accepted, false);
  assert.equal(answer.code, 'TREE_SENDER_UNKNOWN');
  assert.equal(sent.length, 0);
});

test('two live rows sharing the historical name refuse rather than pick one', async t => {
  const directory = directoryFor(t);
  /* Two trees, each with a circle called "Manager": the legitimate duplicate
     the person warned about. A caller whose own name is neither of them must
     not be resolved onto either. */
  directory.registerNode({ sessionId: 'session-a', nodeName: 'Manager', pid: process.pid, treeKey: 'tree-a', nodeKey: 'node-a' });
  directory.registerNode({ sessionId: 'session-b', nodeName: 'Manager', pid: process.pid, treeKey: 'tree-b', nodeKey: 'node-b' });
  directory.registerNode({
    sessionId: 'session-c', nodeName: 'Worker 1', managerSessionId: 'session-a', managerName: 'Manager',
    pid: process.pid, treeKey: 'tree-a', nodeKey: 'node-c'
  });
  const { provider, sent } = providerOver(directory);

  const answer = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'which one' }, bound('session-c'));
  assert.equal(answer.accepted, false, 'a name held by two live circles must not resolve to the caller');
  assert.equal(answer.code, 'TREE_SENDER_IDENTITY_MISMATCH');
  assert.equal(sent.length, 0);
});

test('the fallback never reaches across trees to a same-named circle', async t => {
  const directory = directoryFor(t);
  directory.registerNode({ sessionId: 'session-a', nodeName: 'Manager', pid: process.pid, treeKey: 'tree-a', nodeKey: 'node-a' });
  directory.registerNode({
    sessionId: 'session-b', nodeName: 'Worker 1', managerSessionId: 'session-a', managerName: 'Manager',
    pid: process.pid, treeKey: 'tree-a', nodeKey: 'node-b'
  });
  /* This caller is alone on its own tree and holds a historical name. Its own
     row is what it must resolve to -- never the identically-briefed circle on
     the other tree. */
  directory.registerNode({ sessionId: 'session-c', nodeName: 'Manager (2)', pid: process.pid, treeKey: 'tree-b', nodeKey: 'node-c' });
  const { provider, sent } = providerOver(directory);

  /* The name is on NO row, so the fallback IS reached and resolves this caller
     to its own tree-b row. From there tree-a's worker is not connected, which
     is the proof that the fallback did not hop trees to the "Manager" row. */
  const answer = await provider.send({ from: 'Manager (old)', to: 'Worker 1', body: 'across' }, bound('session-c'));
  assert.equal(answer.accepted, false, 'tree-b has no line to tree-a; the fallback must not have crossed trees');
  assert.equal(answer.code, 'TREE_RECIPIENT_NOT_CONNECTED');
  assert.equal(sent.length, 0);
});

/* WHERE AUTHORITY COMES FROM, AND WHERE IT MAY NOT.
 *
 * The owner host builds the tool context from the binding it authenticated and
 * always sets agentSessionId from that principal; agentPrincipal is added only
 * when the session also carries a declared agent identity. Both are injected
 * context. The caller's own arguments are a separate parameter that the context
 * is never built from, so nothing a caller writes can name a session.
 *
 * Requiring a declared identity here would refuse a legitimate host-bound
 * session that simply has no declared agent id, which is a normal state, so the
 * fallback takes the host-bound session either way. */
test('a host-bound session with no declared identity is still the caller', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  directory.registerNode({
    sessionId: 'session-manager', nodeName: 'Manager (renamed)', pid: process.pid,
    treeKey: 'tree-1', nodeKey: 'node-manager'
  });
  const { provider, sent } = providerOver(directory);

  const answer = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'hello' },
    { agentSessionId: 'session-manager' });
  assert.equal(answer.accepted, true, `${answer.code} ${answer.reason || ''}`);
  assert.equal(answer.from, 'Manager (renamed)');
  assert.equal(sent[0].body, 'Manager (renamed): hello');

  const roster = provider.roster({ from: 'Manager' }, { agentSessionId: 'session-manager' });
  assert.deepEqual(roster.reachable.map(row => row.nodeName), ['Worker 1']);
});

test('nothing a caller writes in its own arguments can name a session', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  directory.registerNode({
    sessionId: 'session-manager', nodeName: 'Manager (renamed)', pid: process.pid,
    treeKey: 'tree-1', nodeKey: 'node-manager'
  });
  const { provider, sent } = providerOver(directory);

  /* Every shape a caller could try, all in the arguments, with no host context
     at all. The context is built from the owner host's options and never from
     these, so each must land exactly where an unvouched caller lands. */
  for (const forged of [
    { senderSessionId: 'session-manager' },
    { agentSessionId: 'session-manager' },
    { agentPrincipal: { kind: 'agent-session', sessionId: 'session-manager', agentId: 'node-x' } },
    { senderPrincipalSessionId: 'session-manager' }
  ]) {
    const answer = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'hello', ...forged }, {});
    assert.equal(answer.accepted, false, `${Object.keys(forged)[0]} in the arguments was honoured`);
    assert.equal(answer.code, 'TREE_SENDER_UNKNOWN');

    const roster = provider.roster({ from: 'Manager', ...forged }, {});
    assert.equal(roster.code, 'TREE_SENDER_UNKNOWN', `${Object.keys(forged)[0]} was honoured by the roster`);
  }
  assert.equal(sent.length, 0, 'no forged argument may put a message on the fabric');

  /* And the same words in the context the host really builds do work, so the
     refusals above are about where the value came from and not about its shape. */
  const real = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'hello' }, { agentSessionId: 'session-manager' });
  assert.equal(real.accepted, true, `${real.code} ${real.reason || ''}`);
});

test('a caller may not send as another live circle whatever it writes', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  const { provider, sent } = providerOver(directory);

  /* The worker is a genuinely vouched-for caller; the name it writes is the
     manager's live one. Naming someone else is refused whoever is asking. */
  const answer = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'not mine' },
    { agentSessionId: 'session-worker' });
  assert.equal(answer.accepted, false);
  assert.equal(answer.code, 'TREE_SENDER_IDENTITY_MISMATCH');
  assert.equal(sent.length, 0);
});

test('a bare session still disambiguates among rows that already carry its name', async t => {
  const directory = directoryFor(t);
  /* Two live circles share a name across two trees, which is the case the
     session check already existed for. That behaviour is unchanged: it picks
     among rows that MATCH, and never invents one that does not. */
  directory.registerNode({ sessionId: 'session-a', nodeName: 'Manager', pid: process.pid, treeKey: 'tree-a', nodeKey: 'node-a' });
  directory.registerNode({ sessionId: 'session-b', nodeName: 'Manager', pid: process.pid, treeKey: 'tree-b', nodeKey: 'node-b' });
  directory.registerNode({
    sessionId: 'session-child', nodeName: 'Worker 1', managerSessionId: 'session-a', managerName: 'Manager',
    pid: process.pid, treeKey: 'tree-a', nodeKey: 'node-child'
  });
  const { provider, sent } = providerOver(directory);

  const answer = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'mine' }, { agentSessionId: 'session-a' });
  assert.equal(answer.accepted, true, `${answer.code} ${answer.reason || ''}`);
  assert.equal(sent[0].body, 'Manager: mine');
});

test('a replacement without a matching tree key cannot inherit children', async t => {
  for (const missing of ['treeKey']) {
    const directory = directoryFor(t);
    treeWith(directory, { managerName: 'Manager' });
    const replacement = { sessionId: 'replacement-session', nodeName: 'Renamed manager', pid: process.pid,
      treeKey: 'tree-1', nodeKey: 'node-manager', replacesSessionId: 'session-manager' };
    delete replacement[missing];
    directory.registerNode(replacement);
    const { provider, sent } = providerOver(directory);
    const result = await provider.send({ from: 'Renamed manager', to: 'Worker 1', body: 'unproven replacement' }, bound('replacement-session'));
    assert.equal(result.accepted, false, `missing ${missing} must not carry the old parent's children`);
    assert.equal(sent.length, 0);
  }
});

test('an exact replacement inherits an omitted saved circle key and keeps its own children', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  const replacement = directory.registerNode({ sessionId: 'replacement-session', nodeName: 'Renamed manager',
    pid: process.pid, treeKey: 'tree-1', replacesSessionId: 'session-manager' });
  assert.equal(replacement.nodeKey, 'node-manager');
  const { provider, sent } = providerOver(directory);
  const result = await provider.send({ from: 'Renamed manager', to: 'Worker 1', body: 'same circle' }, bound('replacement-session'));
  assert.equal(result.accepted, true);
  assert.equal(sent.length, 1);
  assert.equal(directory.listNodes().find(row => row.sessionId === 'session-worker').managerAgentId, replacement.agentId);
});

test('a retired name cannot be claimed by a different circle or by the retired session', async t => {
  const directory = directoryFor(t);
  treeWith(directory, { managerName: 'Manager' });
  directory.registerNode({ sessionId: 'replacement-session', nodeName: 'Renamed manager', pid: process.pid,
    treeKey: 'tree-1', nodeKey: 'node-manager', replacesSessionId: 'session-manager' });
  const { provider, sent } = providerOver(directory);
  for (const sessionId of ['session-worker', 'session-manager']) {
    const result = await provider.send({ from: 'Manager', to: 'Worker 1', body: 'not the successor' }, bound(sessionId));
    assert.equal(result.accepted, false);
  }
  assert.equal(sent.length, 0);
});
