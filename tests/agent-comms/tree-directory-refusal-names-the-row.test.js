'use strict';

// "THE TREE DIRECTORY CONTAINS AN INVALID NODE LIST" NAMED NOTHING.
//
// Evidence, this installation, capability/logs/actions.jsonl: 25 refusals --
// 17 of agent_comms.local_roster and 8 of agent_comms.send_local -- whose
// whole caller-visible reason was
//
//   "The tree directory contains an invalid node list."
//
// Not the file. Not which of up to 64 rows. Not what was wrong with it. Not
// what to do. The 2026-09-02 outage recorded in tree-node-directory.js cost
// eighty minutes against exactly that sentence.
//
// Worse, one sentence covered three different causes -- a `nodes` field that
// was not a list, a directory with too many rows, and a single unreadable row
// -- so two of the three had their cause misstated.
//
// These checks assert the refusal a caller receives, by value:
//   - it names the file;
//   - a bad row is named by position AND by the field that made it bad;
//   - the field named is the field that was actually corrupted;
//   - the three causes that used to share a sentence no longer do;
//   - an unreadable file says "could not be read", with the filesystem's own
//     code, and does not read as "no agents are registered";
//   - none of this repairs, rewrites, or relaxes anything: every case still
//     throws its original code and leaves the file byte-for-byte.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_NODES,
  agentIdForSession,
  createTreeNodeDirectory
} = require('../../src/lib/agent-comms/tree-node-directory');

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-directory-refusal-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

const SESSION = 'valid-session';
function validRow() {
  return {
    agentId: agentIdForSession(SESSION),
    nodeName: 'Valid node',
    sessionId: SESSION,
    managerAgentId: null,
    managerName: null,
    managerUnresolved: null,
    registeredAt: 1234,
    heartbeatAt: 1234,
    stoppedAt: null,
    pid: 4321
  };
}

function refusal(file, contents) {
  fs.writeFileSync(file, contents, 'utf8');
  const before = fs.readFileSync(file, 'utf8');
  let thrown = null;
  try { createTreeNodeDirectory({ file, now: () => 1234 }).listNodes(); }
  catch (error) { thrown = error; }
  assert.ok(thrown, 'the read must refuse');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused read must leave the file untouched');
  return thrown;
}

test('the refusal names the file every agent_comms read is blocked on', t => {
  const file = path.join(workspace(t), 'tree.json');
  const thrown = refusal(file, '{not json');

  assert.equal(thrown.code, 'TREE_DIRECTORY_MALFORMED', 'the refusal code is the contract and must not change');
  assert.ok(thrown.message.includes(file), `the sentence must name the file; got: ${thrown.message}`);
  assert.match(thrown.message, /agent_comms/, 'the caller must be told the blast radius it is already seeing');
});

test('a bad row is named by position and by the field that made it bad', t => {
  const file = path.join(workspace(t), 'tree.json');
  const rows = [validRow(), validRow(), validRow()];
  rows[1].sessionId = 'a-different-session';
  rows[2].sessionId = 'yet-another-session';
  rows[1].agentId = agentIdForSession('a-different-session');
  rows[2].agentId = agentIdForSession('yet-another-session');
  rows[2].heartbeatAt = 1234.5;

  const thrown = refusal(file, JSON.stringify({ version: 1, nodes: rows }));
  assert.equal(thrown.code, 'TREE_DIRECTORY_MALFORMED');
  assert.match(thrown.message, /row 3 of 3/, `the sentence must name which row; got: ${thrown.message}`);
  assert.match(thrown.message, /heartbeatAt/, `the sentence must name the field; got: ${thrown.message}`);
  assert.equal(thrown.details.nodeIndex, 2, 'machine readers get the row index');
});

test('the field named is the field that was actually corrupted', t => {
  const dir = workspace(t);
  const cases = [
    ['agentId', row => { row.agentId = 'tree-'; }],
    ['nodeName', row => { row.nodeName = 'x'.repeat(121); }],
    ['managerAgentId', row => { row.managerAgentId = 'not-a-tree-agent-id'; }],
    ['managerName', row => { row.managerName = 'x'.repeat(121); }],
    ['managerUnresolved', row => { row.managerUnresolved = ' Other '; }],
    ['registeredAt', row => { row.registeredAt = -1; }],
    ['stoppedAt', row => { row.stoppedAt = 1234.5; }],
    ['pid', row => { row.pid = -1; }],
    ['threadId', row => { row.threadId = ''; }]
  ];

  for (const [field, corrupt] of cases) {
    const file = path.join(dir, `${field}.json`);
    const row = validRow();
    corrupt(row);
    const thrown = refusal(file, JSON.stringify({ version: 1, nodes: [row] }));
    assert.equal(thrown.code, 'TREE_DIRECTORY_MALFORMED', `${field} must still be refused`);
    assert.match(thrown.message, new RegExp(`"${field}"`),
      `a corrupted ${field} must be reported as ${field}; got: ${thrown.message}`);
  }
});

test('an unknown field is reported as an unknown field, by name', t => {
  const file = path.join(workspace(t), 'tree.json');
  const row = validRow();
  row.unreviewed = true;
  const thrown = refusal(file, JSON.stringify({ version: 1, nodes: [row] }));
  assert.match(thrown.message, /unreviewed/, `the unknown field must be named; got: ${thrown.message}`);
});

test('the three causes that used to share one sentence now differ', t => {
  const dir = workspace(t);
  const notAList = refusal(path.join(dir, 'a.json'), JSON.stringify({ version: 1, nodes: {} }));
  const tooMany = refusal(path.join(dir, 'b.json'), JSON.stringify({ version: 1, nodes: new Array(MAX_NODES + 1).fill(validRow()) }));
  const badRow = refusal(path.join(dir, 'c.json'), JSON.stringify({ version: 1, nodes: [{ ...validRow(), pid: -1 }] }));

  assert.notEqual(notAList.message, tooMany.message);
  assert.notEqual(tooMany.message, badRow.message);
  assert.notEqual(notAList.message, badRow.message);
  assert.match(notAList.message, /not a list/, `got: ${notAList.message}`);
  assert.match(tooMany.message, new RegExp(`${MAX_NODES + 1} rows and this build reads at most ${MAX_NODES}`), `got: ${tooMany.message}`);
  assert.equal(tooMany.details.nodeCount, MAX_NODES + 1);
  assert.equal(tooMany.details.limit, MAX_NODES);
});

test('a duplicated identity says which identity and what to do about it', t => {
  const file = path.join(workspace(t), 'tree.json');
  const thrown = refusal(file, JSON.stringify({ version: 1, nodes: [validRow(), validRow()] }));
  assert.equal(thrown.code, 'TREE_DIRECTORY_MALFORMED');
  assert.match(thrown.message, /twice/, `got: ${thrown.message}`);
  assert.match(thrown.message, /one row must be removed/, `got: ${thrown.message}`);
  assert.equal(thrown.details.agentId, agentIdForSession(SESSION));
});

test('a file that could not be read is not reported as an empty tree', () => {
  const denied = new Error('denied');
  denied.code = 'EACCES';
  let writes = 0;
  const fsImpl = {
    readFileSync() { throw denied; },
    mkdirSync() { writes += 1; },
    writeFileSync() { writes += 1; },
    renameSync() { writes += 1; }
  };
  const file = path.join(os.tmpdir(), 'tree-directory-refusal-denied.json');

  let thrown = null;
  try { createTreeNodeDirectory({ file, fsImpl }).listNodes(); }
  catch (error) { thrown = error; }

  assert.ok(thrown, 'an unreadable directory must refuse rather than answer');
  assert.equal(thrown.code, 'TREE_DIRECTORY_UNREADABLE');
  assert.match(thrown.message, /EACCES/, `the filesystem's own code must reach the caller; got: ${thrown.message}`);
  assert.ok(thrown.message.includes(file), 'the sentence must name the file');
  assert.match(thrown.message, /not a statement that no agents are registered/,
    'a failed look must not read as an answer about the world');
  assert.equal(writes, 0, 'an unreadable directory is never initialized or rewritten');
});

test('a valid directory still reads', t => {
  const file = path.join(workspace(t), 'tree.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, nodes: [validRow()] }), 'utf8');
  const nodes = createTreeNodeDirectory({ file, now: () => 1234 }).listNodes();
  assert.equal(nodes.length, 1, 'the refusal must not have become universal');
  assert.equal(nodes[0].nodeName, 'Valid node');
});
