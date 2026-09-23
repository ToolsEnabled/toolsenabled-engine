'use strict';

// T839: A MESSAGE TO A CIRCLE THAT AN ACCOUNT RECOVERY REPLACED.
//
// Measured on the shipping directory with no app in the loop: a manager writing
// to a circle across a recovery (its old session a6 replaced by b6) was told
// TREE_RECIPIENT_NOT_RUNNING or TREE_RECIPIENT_AMBIGUOUS -- while the successor
// ran -- depending only on the successor's state, and a circle that merely
// stopped, with no predecessor, was held for a wake. Nothing here starts a
// session: a held message is only recorded, and no application code consumes
// the wake it asks for, so a person's Stop is never undone by writing to it.
//
// This file runs the SHIPPING module against a filesystem held in a Map and a
// stubbed cross-process lock, so it creates, locks and removes nothing on disk.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const sourceFile = path.join(__dirname, '../../src/lib/agent-comms/tree-node-directory.js');

function memoryFs() {
  const files = new Map(), handles = new Map();
  let next = 100;
  const code = name => Object.assign(new Error(name), { code: name });
  return {
    files,
    statSync(file) { if (!files.has(file)) throw code('ENOENT'); return { size: Buffer.byteLength(files.get(file), 'utf8') }; },
    readFileSync(file) { if (!files.has(file)) throw code('ENOENT'); return files.get(file); },
    mkdirSync() {},
    openSync(file, flag) { if (flag === 'wx' && files.has(file)) throw code('EEXIST'); files.set(file, ''); next += 1; handles.set(next, file); return next; },
    writeFileSync(target, text) { files.set(typeof target === 'number' ? handles.get(target) : target, text); },
    fsyncSync() {},
    closeSync(handle) { handles.delete(handle); },
    renameSync(from, to) { if (!files.has(from)) throw code('ENOENT'); files.set(to, files.get(from)); files.delete(from); },
    rmSync(file) { files.delete(file); } // an entry of this Map only
  };
}

function loadDirectory(memory) {
  const resolver = createRequire(sourceFile);
  const local = id => id === 'node:fs' ? memory
    : id === '../process-claim-lock' ? { acquireLock: () => ({ release() {} }), pidAlive: () => true }
    : id === '../runtime-state-root' ? { statePath: (...parts) => path.join('/memory-only', ...parts) }
    : resolver(id);
  const module = { exports: {} };
  const wrapper = vm.runInThisContext('(function(require,module,exports,__filename,__dirname){\n' + fs.readFileSync(sourceFile, 'utf8') + '\n})', { filename: sourceFile });
  wrapper(local, module, module.exports, sourceFile, path.dirname(sourceFile));
  return module.exports;
}

const TREE = 'tree-top-circle';
const MANAGER = 'Builder 2 (964cd27e)';
const CHILD = 'Builder 6 (7a80e60d)';

/** One isolated world: the shipping directory, a clock, and the exact argument shape the
 *  application host uses to register a session (shell/agent-host.cjs attemptTreeRegistration). */
function world({ managerLabel = MANAGER } = {}) {
  const memory = memoryFs();
  const api = loadDirectory(memory);
  let clock = 1_800_000_000_000;
  const directory = api.createTreeNodeDirectory({
    file: '/memory-only/tree-nodes.json', fsImpl: memory, now: () => clock, pidIsAlive: () => true, lockIsAlive: () => true
  });
  const register = ({ session, name, manager = null, node, thread = null, replaces = null, treeKey = TREE }) => directory.registerNode({
    sessionId: session, nodeName: name, managerName: manager, pid: 4242, threadId: thread, treeKey, nodeKey: node, replacesSessionId: replaces
  });
  const w = { api, directory, memory, register,
    advance(ms) { clock += ms; },
    beat(...sessions) { directory.heartbeatNodes(sessions.map(sessionId => ({ sessionId }))); },
    stop(session) { directory.unregisterNode({ sessionId: session }); },
    send(from, fromSession, to) { return directory.resolveDelivery({ from, to, senderSessionId: fromSession }); },
    toManager(to = CHILD) { return w.send(managerLabel, 'p1', to); },
    child(session, extra = {}) {
      return register({ session, name: CHILD, manager: managerLabel, node: 'node-K6', thread: `thread-${session}`, ...extra });
    },
    id(session) { return api.agentIdForSession(session); }
  };
  register({ session: 'p1', name: managerLabel, manager: 'Controller (5a702567)', node: 'node-P' });
  w.child('a6');
  w.beat('p1', 'a6');
  return w;
}

/** A circle a recovery replaced: a6 closed, b6 registered as its exact replacement. */
function replaced(w, extra = {}) {
  w.stop('a6');
  w.child('b6', { replaces: 'a6', ...extra });
  return w;
}

function held(answer, session) {
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.equal(answer.recipientStopped, true, 'recorded for the circle, not reported as delivered');
  assert.equal(answer.recipient.sessionId, session);
}

test('T839 a message to a circle whose successor is still starting is held for that circle, by name and by its old address, and delivered once the successor heartbeats', () => {
  const w = replaced(world());
  w.advance(100_000); w.beat('p1'); // the successor is registered but has not renewed its heartbeat
  held(w.toManager(), 'b6');
  held(w.toManager(w.id('a6')), 'b6');
  w.beat('p1', 'b6');
  for (const to of [CHILD, w.id('a6'), w.id('b6')]) {
    const answer = w.toManager(to);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.recipient.sessionId, 'b6');
    assert.equal(answer.recipientStopped, undefined, 'a running circle is not reported as stopped');
  }
});

test('T839 a successor the person stopped is held exactly like a person-stopped circle that never had a successor', () => {
  const recovered = replaced(world());
  recovered.beat('p1', 'b6'); recovered.stop('b6');
  const plain = world();
  plain.stop('a6');
  const shape = answer => ({ ok: answer.ok, stopped: answer.recipientStopped === true, relation: answer.relation });
  held(recovered.toManager(), 'b6');
  held(plain.toManager(), 'a6');
  assert.deepEqual(shape(recovered.toManager()), shape(plain.toManager()));
  held(recovered.toManager(recovered.id('a6')), 'b6');
});

test('T839 a live successor whose manager label drifted from its manager\'s registered name keeps its manager\'s line, across generations', () => {
  const w = replaced(world(), { manager: 'Builder 2' }); // the canvas re-sent the label without its suffix
  w.beat('p1', 'b6');
  for (const to of [CHILD, w.id('a6')]) {
    const answer = w.toManager(to);
    assert.equal(answer.ok, true, `${to}: ${JSON.stringify(answer)}`);
    assert.equal(answer.recipient.sessionId, 'b6');
  }
  assert.equal(w.directory.reachabilityFrom({ from: MANAGER, senderSessionId: 'p1' }).reachable.some(row => row.agentId === w.id('b6')), true, 'the roster offers what the send accepts');
  w.stop('b6'); w.child('c6', { replaces: 'b6', manager: 'Builder 2' }); w.beat('p1', 'c6');
  assert.equal(w.toManager().recipient.sessionId, 'c6');
});

test('T839 a drifted label is the same manager only when it names one circle here, and never crosses to another manager with the same base name', () => {
  const w = world();
  w.register({ session: 'p2', name: 'Builder 2 (bbbbbbbb)', manager: 'Controller (5a702567)', node: 'node-P2' });
  w.beat('p1', 'p2', 'a6');
  replaced(w, { manager: 'Builder 2' }); // "Builder 2" could now name either manager: nothing may be inherited
  w.beat('p1', 'p2', 'b6');
  for (const [name, session] of [[MANAGER, 'p1'], ['Builder 2 (bbbbbbbb)', 'p2']]) {
    const answer = w.send(name, session, CHILD);
    assert.equal(answer.ok, false, `${name} must not gain a line by an ambiguous label: ${JSON.stringify(answer)}`);
  }
  const label = w.api.nameKey;
  assert.equal(label('Builder 2'), 'builder 2');
});

test('T839 a drifted label matches only its own base name plus the canvas disambiguator, in either direction', () => {
  const cases = [
    // [how the manager is registered, the label its child's successor re-sends, does the successor keep its manager's line]
    [MANAGER, 'Builder 2', true], [MANAGER, 'builder 2  ', true], [MANAGER, 'Builder 20', false], [MANAGER, 'Builder 2 (zz)', false],
    [MANAGER, 'Builder', false], [MANAGER, 'Builder 2 (964cd27e) extra', false],
    ['Builder 2', 'Builder 2 (964cd27e)', true], ['Builder 2', 'Builder 2 (zz)', false], ['Builder 2', 'Builder 2 (12)', false],
    ['Builder 2', 'Builder 20 (964cd27e)', false], ['Builder 20 (964cd27e)', 'Builder 2', false]
  ];
  for (const [registered, label, inherits] of cases) {
    const w = replaced(world({ managerLabel: registered }), { manager: label });
    w.beat('p1', 'b6');
    const answer = w.toManager();
    assert.equal(answer.ok, inherits, `manager registered as ${JSON.stringify(registered)}, successor sends ${JSON.stringify(label)}: ${JSON.stringify(answer)}`);
  }
});

test('T839 a circle the person moved under another manager is reached by that manager, and its old manager gains nothing', () => {
  const w = world();
  w.register({ session: 'x1', name: 'Stranger (bbbbbbbb)', manager: null, node: 'node-X' });
  w.beat('p1', 'x1', 'a6');
  replaced(w, { manager: 'Stranger (bbbbbbbb)' });
  w.beat('p1', 'x1', 'b6');
  assert.equal(w.toManager().ok, false, 'the old manager keeps no line to a circle that moved');
  assert.equal(w.toManager(w.id('a6')).ok, false);
  assert.match(w.toManager().message, /no line between you/);
  assert.doesNotMatch(w.toManager().message, /session has stopped/, 'a running circle is not described as stopped');
  const moved = w.send('Stranger (bbbbbbbb)', 'x1', CHILD);
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.recipient.sessionId, 'b6');
});

test('T839 a drifted manager label never binds a circle on another tree', () => {
  const w = world();
  w.register({ session: 'o1', name: 'Sentinel (cccccccc)', manager: null, node: 'node-O', treeKey: 'tree-other' });
  w.register({ session: 'k9', name: 'Builder 9 (99999999)', manager: 'Sentinel', node: 'node-K9', thread: 'thread-k9' });
  w.beat('p1', 'o1', 'k9');
  const answer = w.send('Sentinel (cccccccc)', 'o1', 'Builder 9 (99999999)');
  assert.equal(answer.ok, false, `the circle on the other tree gains no line by a shared label: ${JSON.stringify(answer)}`);
  w.beat('p1', 'o1', 'k9'); // any ordinary write persists what a read repaired
  const stored = JSON.parse(w.memory.files.get('/memory-only/tree-nodes.json')).nodes.find(row => row.sessionId === 'k9');
  assert.equal(stored.managerAgentId, null, 'a label never saves a binding to a circle on another tree');
});

test('T839 nobody but the circle\'s own manager gains a line by a recovery', () => {
  const w = world();
  w.register({ session: 's1', name: 'Builder 7 (aaaaaaaa)', manager: MANAGER, node: 'node-S' });
  w.register({ session: 'x1', name: 'Stranger (bbbbbbbb)', manager: null, node: 'node-X' });
  w.beat('p1', 's1', 'x1', 'a6');
  const before = [['Builder 7 (aaaaaaaa)', 's1'], ['Stranger (bbbbbbbb)', 'x1']].map(([name, session]) => w.send(name, session, CHILD));
  replaced(w); w.advance(100_000); w.beat('p1', 's1', 'x1');
  for (const [name, session] of [['Builder 7 (aaaaaaaa)', 's1'], ['Stranger (bbbbbbbb)', 'x1']]) {
    for (const to of [CHILD, w.id('a6'), w.id('b6')]) assert.equal(w.send(name, session, to).ok, false, `${name} -> ${to}`);
  }
  assert.deepEqual(before.map(answer => answer.ok), [false, false]);
});

test('T839 two circles that share a name and neither runs stay ambiguous, and the answer names both', () => {
  const w = world();
  w.register({ session: 'k2', name: CHILD, manager: MANAGER, node: 'node-K7', thread: 'thread-k2' });
  w.beat('p1'); w.stop('a6'); w.stop('k2');
  const answer = w.toManager();
  assert.equal(answer.code, 'TREE_RECIPIENT_AMBIGUOUS');
  assert.equal(answer.candidates, 2);
});

test('T839 a head past its retention window is refused, never held, and a circle\'s two expired rows are one circle', () => {
  const w = replaced(world());
  w.beat('p1', 'b6'); w.advance(61 * 60_000); w.beat('p1');
  for (const to of [CHILD, w.id('a6'), w.id('b6')]) assert.equal(w.toManager(to).code, 'TREE_RECIPIENT_NOT_RUNNING', to);
  assert.equal(w.directory.reachabilityFrom({ from: MANAGER, senderSessionId: 'p1' }).unavailable.some(row => row.wakeable === true), false);
});

test('T839 the roster and the send agree about a recovering circle', () => {
  const w = replaced(world());
  w.advance(100_000); w.beat('p1');
  const row = w.directory.reachabilityFrom({ from: MANAGER, senderSessionId: 'p1' }).unavailable.find(entry => entry.agentId === w.id('b6'));
  assert.equal(row.wakeable, true);
  held(w.toManager(), 'b6');
  assert.equal(w.directory.reachabilityFrom({ from: MANAGER, senderSessionId: 'p1' }).unavailable.some(entry => entry.agentId === w.id('a6')), false, 'a superseded row is not offered as a recipient');
});

test('T839 a row an earlier build saved unbound is healed on the first read, and persisted by the next write', () => {
  const w = replaced(world(), { manager: 'Builder 2' });
  w.beat('p1', 'b6');
  const file = '/memory-only/tree-nodes.json';
  const saved = JSON.parse(w.memory.files.get(file));
  for (const row of saved.nodes) if (row.sessionId === 'b6') row.managerAgentId = null; // as an earlier build left it
  w.memory.files.set(file, JSON.stringify(saved));
  const bytes = w.memory.files.get(file);
  assert.equal(w.toManager().ok, true, 'the circle is reachable on the first read after the fix, with no re-registration');
  assert.equal(w.memory.files.get(file), bytes, 'a read repairs in memory and writes nothing');
  w.beat('p1', 'b6');
  const persisted = JSON.parse(w.memory.files.get(file)).nodes.find(row => row.sessionId === 'b6');
  assert.equal(persisted.managerAgentId, w.id('p1'), 'the next ordinary write saves the repaired line');
});

test('T839 resolving a message starts nothing and changes nothing on disk', () => {
  const w = replaced(world());
  w.stop('b6');
  const bytes = new Map(w.memory.files);
  for (const to of [CHILD, w.id('a6'), w.id('b6')]) w.toManager(to);
  w.directory.reachabilityFrom({ from: MANAGER, senderSessionId: 'p1' });
  assert.deepEqual([...w.memory.files], [...bytes], 'resolving is a read: no row, heartbeat or registration changes');
  assert.equal(w.directory.listNodes().filter(row => row.live).map(row => row.sessionId).sort().join(), 'p1', 'the stopped circle is still stopped');
});
