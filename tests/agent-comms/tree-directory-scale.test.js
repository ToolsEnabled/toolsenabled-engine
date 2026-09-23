'use strict';

// Synthetic directory records only. This test starts no provider or agent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createTreeNodeDirectory, MAX_NODES, MAX_DOCUMENT_BYTES,
  MAX_NAME_LENGTH, MAX_SESSION_ID_LENGTH, MAX_TREE_KEY_LENGTH,
} = require('../../src/lib/agent-comms/tree-node-directory');

function memoryFiles() {
  const files = new Map();
  const handles = new Map();
  let nextHandle = 100;
  const missing = () => Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
  return {
    files,
    fsImpl: {
      mkdirSync() {},
      statSync(file) { if (!files.has(file)) throw missing(); return { size: Buffer.byteLength(files.get(file)) }; },
      readFileSync(file) { if (!files.has(file)) throw missing(); return files.get(file); },
      openSync(file) { const handle = nextHandle++; handles.set(handle, file); return handle; },
      writeFileSync(handle, text) { files.set(handles.get(handle), text); },
      fsyncSync() {},
      closeSync(handle) { handles.delete(handle); },
      renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); },
      rmSync(file) { files.delete(file); },
    },
  };
}

test('1,000 named registrations survive a durable round-trip, batched heartbeat, and routing', t => {
  assert.ok(MAX_NODES >= 1000, 'the directory envelope must hold the supported saved tree');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-directory-scale-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const file = path.join(scratch, 'directory.json');
  const memory = memoryFiles();
  let at = 1_900_000_000_000;
  const directory = createTreeNodeDirectory({ file, fsImpl: memory.fsImpl, now: () => at });
  for (let index = 0; index < 1000; index += 1) {
    directory.registerNode({
      sessionId: `session-${index}`, nodeName: index === 0 ? 'Controller' : `Worker ${index}`,
      managerName: index === 0 ? null : 'Controller', nodeKey: `circle-${index}`, treeKey: 'root',
    });
  }
  const text = memory.files.get(file);
  assert.ok(Buffer.byteLength(text) < MAX_DOCUMENT_BYTES);
  fs.writeFileSync(file, text);
  const restarted = createTreeNodeDirectory({ file, now: () => at });
  assert.equal(restarted.listNodes().length, 1000);
  at += 100_000;
  assert.equal(restarted.listNodes().filter(node => node.live).length, 0);
  const beats = restarted.heartbeatNodes(Array.from({ length: 1000 }, (_, index) => ({ sessionId: `session-${index}` })));
  assert.equal(beats.filter(beat => beat.found && beat.live).length, 1000);
  const roster = restarted.reachabilityFrom({ from: 'Controller', senderSessionId: 'session-0' });
  assert.equal(roster.reachable.length, 999);
  assert.deepEqual(roster.unavailable, []);
  assert.equal(restarted.resolveDelivery({ from: 'Worker 999', to: 'Controller' }).recipient.sessionId, 'session-0');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).nodes.length, 1000);
});

test('an oversized document is refused before reading or parsing its contents', t => {
  assert.ok(Number.isSafeInteger(MAX_DOCUMENT_BYTES) && MAX_DOCUMENT_BYTES > 0);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-directory-size-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  let reads = 0;
  const directory = createTreeNodeDirectory({
    file: path.join(scratch, 'too-large.json'),
    fsImpl: {
      statSync: () => ({ size: MAX_DOCUMENT_BYTES + 1 }),
      readFileSync: () => { reads += 1; return '{}'; },
    },
  });
  assert.throws(() => directory.listNodes(), error => error.code === 'TREE_DIRECTORY_MALFORMED');
  assert.equal(reads, 0);
});

test('the document byte envelope holds every row at maximum JSON-escaped field lengths', t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-directory-byte-envelope-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const file = path.join(scratch, 'directory.json');
  const memory = memoryFiles();
  // An unpaired surrogate occupies six JSON bytes per code unit. This is a
  // conservative envelope, not the ASCII-only average size of today's IDs.
  const escaped = length => '\ud800'.repeat(length);
  const directory = createTreeNodeDirectory({ file, fsImpl: memory.fsImpl, now: () => Number.MAX_SAFE_INTEGER });
  directory.registerNode({
    sessionId: escaped(MAX_SESSION_ID_LENGTH), nodeName: escaped(MAX_NAME_LENGTH),
    managerName: '\ud801'.repeat(MAX_NAME_LENGTH), managerSessionId: 'missing-manager',
    threadId: escaped(512), treeKey: escaped(MAX_TREE_KEY_LENGTH), nodeKey: escaped(MAX_TREE_KEY_LENGTH),
    pid: Number.MAX_SAFE_INTEGER,
  });
  directory.unregisterNode({ sessionId: escaped(MAX_SESSION_ID_LENGTH) });
  const row = JSON.parse(memory.files.get(file)).nodes[0];
  assert.equal(row.managerUnresolved.length, MAX_NAME_LENGTH);
  assert.equal(row.stoppedAt, Number.MAX_SAFE_INTEGER);
  // Subtract the common document wrapper from a one-row serialization and
  // allow a comma/newline per row. No giant test file or agent is needed.
  const wrapperBytes = Buffer.byteLength(JSON.stringify({ version: 1, nodes: [] }, null, 2) + '\n');
  const singleBytes = Buffer.byteLength(JSON.stringify({ version: 1, nodes: [row] }, null, 2) + '\n');
  const fullEnvelope = wrapperBytes + MAX_NODES * (singleBytes - wrapperBytes + 2);
  t.diagnostic(`${MAX_NODES} maximum-escaped rows fit in ${fullEnvelope} bytes; document limit ${MAX_DOCUMENT_BYTES}`);
  assert.ok(fullEnvelope < MAX_DOCUMENT_BYTES,
    `${MAX_NODES} fully escaped rows need ${fullEnvelope} bytes, exceeding ${MAX_DOCUMENT_BYTES}`);
  assert.equal(directory.listNodes().length, 1, 'the extreme row remains readable');
});
