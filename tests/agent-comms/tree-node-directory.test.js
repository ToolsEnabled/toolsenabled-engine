'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  MAX_NODES,
  agentIdForSession,
  createTreeNodeDirectory,
  directoryFile,
  nameKey
} = require('../../src/lib/agent-comms/tree-node-directory');

function workspaceFor(t, label) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

function rejectsCode(action, code) {
  assert.throws(action, error => {
    assert.equal(error.code, code);
    return true;
  });
}

function waitUntil(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        if (predicate()) { resolve(); return; }
      } catch (error) { reject(error); return; }
      if (Date.now() >= deadline) { reject(new Error('timed out waiting for concurrent tree writers')); return; }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function childCompletion(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('one heartbeat batch updates only its sessions in one durable write and reports lost or stopped rows', t => {
  const workspace = workspaceFor(t, 'tree-heartbeat-batch');
  let now = 1000;
  let writes = 0;
  const fsImpl = Object.assign(Object.create(fs), {
    writeFileSync(...args) { writes += 1; return fs.writeFileSync(...args); }
  });
  const directory = createTreeNodeDirectory({
    file: path.join(workspace, 'tree-nodes.json'), now: () => now, fsImpl
  });
  for (const sessionId of ['manager', 'worker', 'stopped', 'untouched']) {
    directory.registerNode({ sessionId, nodeName: sessionId });
  }
  directory.unregisterNode({ sessionId: 'stopped' });
  now += 30_000;
  writes = 0;
  const result = directory.heartbeatNodes(['manager', 'worker', 'stopped', 'missing'].map(sessionId => ({ sessionId })));
  assert.equal(writes, 1, 'a whole host round must rewrite the directory only once');
  assert.deepEqual(result.map(({ found, live }) => ({ found, live })), [
    { found: true, live: true }, { found: true, live: true },
    { found: true, live: false }, { found: false, live: false }
  ]);
  const nodes = directory.listNodes();
  assert.equal(nodes.find(node => node.sessionId === 'manager').heartbeatAt, now);
  assert.equal(nodes.find(node => node.sessionId === 'worker').heartbeatAt, now);
  assert.equal(nodes.find(node => node.sessionId === 'untouched').heartbeatAt, 1000);
  assert.notEqual(nodes.find(node => node.sessionId === 'stopped').stoppedAt, null);
  assert.equal(directory.heartbeatNode({ sessionId: 'stopped' }).live, false,
    'a retained stopped row must not look like a reachable session to the host');
});

test('heartbeat validation is atomic and an absent directory reports lost rows', t => {
  const workspace = workspaceFor(t, 'tree-heartbeat-validation');
  const file = path.join(workspace, 'tree-nodes.json');
  const directory = createTreeNodeDirectory({ file });
  assert.deepEqual(directory.heartbeatNodes([]), []);
  assert.equal(fs.existsSync(file), false, 'an empty host round must do no disk work');
  rejectsCode(() => directory.heartbeatNodes([{ sessionId: 'valid' }, { sessionId: '' }]), 'TREE_SESSION_ID_INVALID');
  assert.equal(fs.existsSync(file), false, 'validate the whole batch before taking the write lock');
  assert.deepEqual(directory.heartbeatNode({ sessionId: 'missing' }), {
    agentId: agentIdForSession('missing'), found: false, live: false
  });
  assert.deepEqual(directory.listNodes(), []);
  directory.registerNode({ sessionId: 'valid', nodeName: 'Valid' });
  const many = directory.heartbeatNodes([
    { sessionId: 'valid' }, ...Array.from({ length: MAX_NODES }, (_, i) => ({ sessionId: `missing-${i}` }))
  ]);
  assert.equal(many.length, MAX_NODES + 1, 'cached host addresses can outnumber retained directory rows');
  assert.equal(many.filter(beat => beat.live).length, 1);
  assert.equal(directory.listNodes().length, 1, 'a large heartbeat batch must not bypass registration capacity');
  const before = fs.readFileSync(file, 'utf8');
  rejectsCode(() => directory.heartbeatNodes([{ sessionId: 'valid' }, { sessionId: '\n' }]), 'TREE_SESSION_ID_INVALID');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.writeFileSync(file, '{damaged');
  assert.throws(() => directory.heartbeatNodes([{ sessionId: 'valid' }]));
  assert.equal(fs.readFileSync(file, 'utf8'), '{damaged', 'an unreadable directory must not be replaced with an empty one');
});

test('a tree directory maps live, connected node names to stable session identities', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-node-directory-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));

  let now = 1_900_000_000_000;
  const directory = createTreeNodeDirectory({
    file: path.join(workspace, 'tree-nodes.json'),
    now: () => now,
    liveWindowMs: 100
  });

  assert.deepEqual(directory.listNodes(), [], 'an unwritten directory describes an empty tree');
  /* THE SAME UNWRITTEN DIRECTORY, THROUGH THE OTHER TWO READERS.
   *
   * listNodes() answers an unwritten directory with `[]` (asserted above) --
   * its own doc comment states the reason at length: "A DIRECTORY NOBODY HAS
   * WRITTEN YET HOLDS NOTHING, AND THAT IS AN ANSWER... Refusing here made a
   * pure reader depend on a write having happened first, and the owner
   * journal (the only production caller) crashed on a fresh machine." Both
   * listNodes() and findByThreadId() take that seriously: both call
   * read({ allowMissing: true }). resolveDelivery() and reachabilityFrom()
   * do not -- both call the bare read(), whose default is
   * `allowMissing = false` -- so the exact machine state this file's own
   * comment was written to fix (nobody has ever registered a tree node here)
   * makes THESE two readers throw TREE_DIRECTORY_UNREADABLE instead of
   * answering TREE_SENDER_UNKNOWN.
   *
   * THIS IS NOT A THEORETICAL DOOR. src/lib/providers/agent-comms-local.js's
   * send() calls tree.resolveDelivery(...) with no try/catch around it, right
   * beneath its own header comment: "A REFUSAL IS AN ANSWER, NOT AN
   * EXCEPTION... So the refusals come back as a value the model can read
   * aloud, carrying the names it can actually reach, and only a genuinely
   * malformed call throws." A brand-new machine on which no tree agent has
   * ever registered -- or any machine reached by a non-tree caller of
   * agent_comms.send_local/local_roster before the first tree registration --
   * is not a malformed call; it is the ordinary "no such agent" case this
   * refusal-not-exception contract exists for, and it reached the model as an
   * uncaught internal error instead. */
  assert.deepEqual(
    directory.resolveDelivery({ from: 'Worker', to: 'Manager' }),
    { ok: false, code: 'TREE_SENDER_UNKNOWN', message: 'No agent called "Worker" is registered on this computer\'s tree.' },
    'resolveDelivery on an unwritten directory must answer TREE_SENDER_UNKNOWN, exactly as it does once the file exists and is merely empty of matching rows -- never throw'
  );
  assert.deepEqual(
    directory.reachabilityFrom({ from: 'Worker' }),
    {
      ok: false,
      code: 'TREE_SENDER_UNKNOWN',
      message: 'No agent called "Worker" is registered on this computer\'s tree.',
      reachable: [],
      unavailable: []
    },
    'reachabilityFrom on an unwritten directory must answer TREE_SENDER_UNKNOWN -- never throw'
  );
  assert.deepEqual(directory.reachableFrom({ from: 'Worker' }), [], 'the backwards-compatible array projection must also answer empty, never throw');
  assert.equal(nameKey('  MANAGER  '), 'manager');
  assert.equal(agentIdForSession(' manager-session '), agentIdForSession('manager-session'));

  const manager = directory.registerNode({ sessionId: 'manager-session', nodeName: 'Manager' });
  const child = directory.registerNode({
    sessionId: 'child-session',
    nodeName: 'Child',
    managerName: ' manager '
  });

  /* agentId is on every row, not only on a user-linked peer (T138): it is the
     handle a caller falls back to when two circles answer to one name. */
  assert.deepEqual(directory.reachableFrom({ from: ' CHILD ' }), [
    { nodeName: 'Manager', agentId: manager.agentId, relation: 'manager', treeKey: null, lastSeenAt: 1_900_000_000_000, transient: false }
  ]);
  assert.deepEqual(directory.resolveDelivery({ from: 'child', to: 'MANAGER' }), {
    ok: true,
    sender: { agentId: child.agentId, nodeName: 'Child', sessionId: 'child-session' },
    recipient: { agentId: manager.agentId, nodeName: 'Manager', sessionId: 'manager-session' },
    relation: 'manager'
  });

  directory.registerNode({ sessionId: 'peer-session', nodeName: 'Peer' });
  assert.equal(
    directory.resolveDelivery({ from: 'Child', to: 'Peer' }).code,
    'TREE_RECIPIENT_NOT_CONNECTED',
    'registered nodes without a tree edge cannot be addressed'
  );

  now += 101;
  assert.equal(directory.resolveDelivery({ from: 'Child', to: 'Manager' }).code, 'TREE_SENDER_NOT_RUNNING');
  assert.equal(directory.heartbeatNode({ sessionId: 'child-session' }).found, true);
  /* T255. A LAPSED RECIPIENT IS NOW HELD FOR A WAKE, and the distinction this
     line exists to draw is preserved: the SENDER lapsing is still a refusal
     (asserted above), while the RECIPIENT lapsing resolves with
     recipientStopped. Those are different answers about different ends, which is
     the whole point of the sequence, and recipientStopped is what keeps them
     from collapsing into one another. */
  const lapsedRecipient = directory.resolveDelivery({ from: 'Child', to: 'Manager' });
  assert.equal(lapsedRecipient.ok, true);
  assert.equal(lapsedRecipient.recipientStopped, true, 'a lapsed recipient is held, not refused');
  assert.equal(directory.heartbeatNode({ sessionId: 'manager-session' }).found, true);
  const running = directory.resolveDelivery({ from: 'Child', to: 'Manager' });
  assert.equal(running.ok, true);
  assert.notEqual(running.recipientStopped, true,
    'a running recipient must NOT be marked stopped, or every send would claim it needs a wake');

  assert.equal(directory.unregisterNode({ sessionId: 'manager-session' }).removed, true);
  const unregistered = directory.resolveDelivery({ from: 'Child', to: 'Manager' });
  assert.equal(unregistered.ok, true);
  assert.equal(unregistered.recipientStopped, true, 'a cleanly stopped recipient is held too');
  assert.equal(directory.listNodes().find(node => node.nodeName === 'Manager').live, false);
});

test('invalid paths, session ids, and names refuse before any directory write', () => {
  const writes = { mkdir: 0, write: 0, rename: 0 };
  const fsImpl = {
    readFileSync() { const error = new Error('missing'); error.code = 'ENOENT'; throw error; },
    mkdirSync() { writes.mkdir += 1; },
    writeFileSync() { writes.write += 1; },
    renameSync() { writes.rename += 1; }
  };

  rejectsCode(() => createTreeNodeDirectory({
    env: { TOOLSENABLED_TREE_DIRECTORY_FILE: 'relative/tree.json' },
    fsImpl
  }), 'TREE_DIRECTORY_PATH_INVALID');
  rejectsCode(() => directoryFile({
    env: { TOOLSENABLED_TREE_DIRECTORY_FILE: path.join(os.tmpdir(), 'redirected-tree.json') }
  }), 'TREE_DIRECTORY_PATH_INVALID');

  const directory = createTreeNodeDirectory({ file: '/unused/tree.json', fsImpl });
  rejectsCode(() => directory.registerNode({ nodeName: 'Node' }), 'TREE_SESSION_ID_INVALID');
  rejectsCode(() => directory.registerNode({ sessionId: 'session', nodeName: ' \t ' }), 'TREE_NAME_INVALID');
  assert.deepEqual(writes, { mkdir: 0, write: 0, rename: 0 }, 'validation refusals have no durable side effect');
});

test('unreadable and malformed records throw their precise refusal without rewriting the record', t => {
  const workspace = workspaceFor(t, 'tree-directory-corrupt');
  const file = path.join(workspace, 'tree.json');
  fs.writeFileSync(file, '{not json', 'utf8');
  const before = fs.readFileSync(file, 'utf8');
  rejectsCode(() => createTreeNodeDirectory({ file }).listNodes(), 'TREE_DIRECTORY_MALFORMED');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'malformed input is preserved rather than replaced');

  let writes = 0;
  const denied = new Error('denied');
  denied.code = 'EACCES';
  const fsImpl = {
    readFileSync() { throw denied; },
    mkdirSync() { writes += 1; },
    writeFileSync() { writes += 1; },
    renameSync() { writes += 1; }
  };
  rejectsCode(
    () => createTreeNodeDirectory({ file: path.join(workspace, 'denied.json'), fsImpl }).listNodes(),
    'TREE_DIRECTORY_UNREADABLE'
  );
  assert.equal(writes, 0, 'an unreadable directory is never initialized or rewritten');
});

test('every durable tree row is rebound to the exact writer invariants before it is trusted', t => {
  const workspace = workspaceFor(t, 'tree-directory-row-validation');
  const file = path.join(workspace, 'tree.json');
  const sessionId = 'valid-session';
  const valid = {
    agentId: agentIdForSession(sessionId),
    nodeName: 'Valid node',
    sessionId,
    managerAgentId: null,
    managerName: null,
    managerUnresolved: null,
    registeredAt: 1234,
    heartbeatAt: 1234,
    stoppedAt: null,
    pid: 4321
  };
  const corruptions = [
    ['truncated agent identity', entry => { entry.agentId = 'tree-'; }],
    ['agent identity does not bind its session', entry => { entry.agentId = agentIdForSession('different-session'); }],
    ['control character in node name', entry => { entry.nodeName = '\n'; }],
    ['control character in session id', entry => { entry.sessionId = '\u0001'; }],
    ['arbitrary manager identity', entry => { entry.managerAgentId = 'not-a-tree-agent-id'; }],
    ['oversized manager name', entry => { entry.managerName = 'x'.repeat(121); }],
    ['unresolved manager that is not a name a person could have typed', entry => { entry.managerUnresolved = ' Other '; }],
    ['fractional timestamp', entry => { entry.heartbeatAt = 1234.5; }],
    ['invalid process identity', entry => { entry.pid = -1; }],
    ['unknown durable field', entry => { entry.unreviewed = true; }]
  ];

  for (const [label, corrupt] of corruptions) {
    const entry = JSON.parse(JSON.stringify(valid));
    corrupt(entry);
    fs.writeFileSync(file, JSON.stringify({ version: 1, nodes: [entry] }), 'utf8');
    rejectsCode(
      () => createTreeNodeDirectory({ file, now: () => 1234 }).listNodes(),
      'TREE_DIRECTORY_MALFORMED'
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).nodes[0], entry,
      `${label} was rewritten instead of being preserved for diagnosis`);
  }
});

test('a stale unresolved-manager diagnosis heals on read instead of condemning the directory', t => {
  const workspace = workspaceFor(t, 'tree-directory-stale-diagnosis');
  const file = path.join(workspace, 'tree.json');
  let now = 1_900_000_000_000;
  const directory = createTreeNodeDirectory({ file, now: () => now, liveWindowMs: 90_000 });

  directory.registerNode({ sessionId: 'controller-session', nodeName: 'Controller' });
  const controller3 = directory.registerNode({ sessionId: 'controller-3-session', nodeName: 'Controller 3', managerName: 'Controller' });

  /* THE SHAPE MEASURED ON AN INSTALLED COPY, 2026-09-02: a manager edge that
   * resolves, beside a diagnosis an earlier writer left naming a circle nobody
   * started. It condemned the whole file, and every agent message on that
   * machine answered with an internal error until the file was moved aside. */
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.nodes.find(node => node.nodeName === 'Controller 3').managerUnresolved = 'Controller 2';
  fs.writeFileSync(file, JSON.stringify(record), 'utf8');
  const onDisk = fs.readFileSync(file, 'utf8');

  const nodes = directory.listNodes();
  assert.equal(nodes.length, 2, 'one stale row does not condemn the rows beside it');
  assert.equal(nodes.find(node => node.nodeName === 'Controller 3').managerUnresolved, null,
    'the diagnosis is restated from the node set this process can see');
  assert.deepEqual(directory.reachabilityFrom({ from: 'Controller' }), {
    ok: true,
    reachable: [{ nodeName: 'Controller 3', agentId: controller3.agentId, relation: 'reports-to-sender', treeKey: null,
      lastSeenAt: 1_900_000_000_000, transient: false }],
    unavailable: []
  });
  assert.equal(fs.readFileSync(file, 'utf8'), onDisk, 'the read heals in memory and writes nothing');

  now += 1;
  directory.heartbeatNode({ sessionId: 'controller-3-session' });
  assert.equal(
    JSON.parse(fs.readFileSync(file, 'utf8')).nodes.find(node => node.nodeName === 'Controller 3').managerUnresolved,
    null,
    'the next mutation persists what the read established'
  );
});

test('healing restates an unreachable manager rather than forgiving it', t => {
  const workspace = workspaceFor(t, 'tree-directory-heal-restates');
  const file = path.join(workspace, 'tree.json');
  const directory = createTreeNodeDirectory({ file, now: () => 1_900_000_000_000, liveWindowMs: 90_000 });

  directory.registerNode({ sessionId: 'worker-session', nodeName: 'Worker', managerName: 'Manager 4' });
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.nodes[0].managerUnresolved, 'Manager 4');
  // Stale in the other direction: a row that claims the edge resolves when no
  // such circle is on this tree. Healing must not turn that into silence.
  record.nodes[0].managerUnresolved = null;
  fs.writeFileSync(file, JSON.stringify(record), 'utf8');

  assert.equal(directory.listNodes()[0].managerUnresolved, 'Manager 4');
  const answer = directory.reachabilityFrom({ from: 'Worker' });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'TREE_MANAGER_UNREGISTERED');
  assert.equal(answer.managerName, 'Manager 4');
});

test('two live circles sharing a name answer the roster instead of throwing', t => {
  const workspace = workspaceFor(t, 'tree-directory-ambiguous-roster');
  const file = path.join(workspace, 'tree.json');
  const directory = createTreeNodeDirectory({ file, now: () => 1_900_000_000_000, liveWindowMs: 90_000 });

  directory.registerNode({ sessionId: 'manager-a', nodeName: 'Manager' });
  directory.registerNode({ sessionId: 'manager-b', nodeName: 'manager' });
  directory.registerNode({ sessionId: 'worker', nodeName: 'Worker', managerName: 'Manager' });

  const answer = directory.reachabilityFrom({ from: 'Manager' });
  assert.equal(answer.ok, false);
  assert.equal(answer.code, 'TREE_SENDER_AMBIGUOUS');
  assert.equal(answer.candidates, 2);
  assert.deepEqual(answer.reachable, []);
  assert.deepEqual(answer.unavailable, []);
  assert.deepEqual(directory.reachableFrom({ from: 'Manager' }), [],
    'the list a refusal offers instead is empty, not a thrown tool failure');
});

test('writer-impossible duplicate durable session rows are refused', t => {
  const workspace = workspaceFor(t, 'tree-directory-duplicate-session');
  const file = path.join(workspace, 'tree.json');
  const directory = createTreeNodeDirectory({ file, now: () => 1234 });
  directory.registerNode({ sessionId: 'one-session', nodeName: 'One node' });
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.nodes.push({ ...record.nodes[0] });
  fs.writeFileSync(file, JSON.stringify(record), 'utf8');
  rejectsCode(() => directory.listNodes(), 'TREE_DIRECTORY_MALFORMED');
});

test('a full saved-directory envelope refuses one extra row and preserves every existing node', t => {
  const workspace = workspaceFor(t, 'tree-directory-full');
  const file = path.join(workspace, 'tree.json');
  const directory = createTreeNodeDirectory({ file, now: () => 1_900_000_000_000 });
  // Seed the boundary from a real registration shape. Rewriting a growing
  // 4,096-row file thousands of times tests disk throughput, not the refusal.
  const template = directory.registerNode({ sessionId: 'template', nodeName: 'Template' });
  const nodes = Array.from({ length: MAX_NODES }, (_, index) => ({
    ...template, sessionId: `session-${index}`, agentId: agentIdForSession(`session-${index}`), nodeName: `Node ${index}`,
  }));
  fs.writeFileSync(file, JSON.stringify({ version: 1, nodes }), 'utf8');
  const before = fs.readFileSync(file, 'utf8');
  rejectsCode(
    () => directory.registerNode({ sessionId: 'one-too-many', nodeName: 'Overflow' }),
    'TREE_DIRECTORY_FULL'
  );
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the rejected node is not written');
  assert.equal(directory.listNodes().length, MAX_NODES);
});

test('delivery requires both names and refuses ambiguous live endpoints without writing', t => {
  const workspace = workspaceFor(t, 'tree-directory-resolution');
  const file = path.join(workspace, 'tree.json');
  const directory = createTreeNodeDirectory({ file, now: () => 1_900_000_000_000 });

  directory.registerNode({ sessionId: 'manager', nodeName: 'Manager' });
  directory.registerNode({ sessionId: 'sender-a', nodeName: 'Sender', managerName: 'Manager' });
  directory.registerNode({ sessionId: 'sender-b', nodeName: 'sender', managerName: 'Manager' });
  const workerA = directory.registerNode({ sessionId: 'worker-a', nodeName: 'Worker', managerName: 'Manager' });
  const workerB = directory.registerNode({ sessionId: 'worker-b', nodeName: 'worker', managerName: 'Manager' });
  const before = fs.readFileSync(file, 'utf8');

  assert.deepEqual(directory.resolveDelivery({ to: 'Manager' }), {
    ok: false,
    code: 'TREE_SENDER_REQUIRED',
    message: 'Say which circle on the tree you are, using the name you were given.'
  });
  assert.deepEqual(directory.resolveDelivery({ from: 'Manager' }), {
    ok: false,
    code: 'TREE_RECIPIENT_REQUIRED',
    message: 'Say which circle on the tree you are writing to, using the name you were given.'
  });
  assert.equal(directory.resolveDelivery({ from: 'Sender', to: 'Manager' }).code, 'TREE_SENDER_AMBIGUOUS');
  /* THE REFUSAL NAMES AN ADDRESS PER CANDIDATE (T138). The old sentence ended
     "use the full name", which is no instruction at all when the full names are
     what collided -- measured on four circles all called "Manager". The
     addresses are built from the registrations rather than copied in, so this
     stays an exact pin without carrying a hash a reader cannot check. */
  assert.deepEqual(directory.resolveDelivery({ from: 'Manager', to: 'Worker' }), {
    ok: false,
    code: 'TREE_RECIPIENT_AMBIGUOUS',
    message: `More than one running agent connected to you is called "Worker": Worker (${workerA.agentId}), worker (${workerB.agentId}). `
      + 'No message was sent because the recipient is ambiguous; send again to one of those agentIds.',
    candidates: 2,
    candidateAgents: [
      { nodeName: 'Worker', agentId: workerA.agentId },
      { nodeName: 'worker', agentId: workerB.agentId }
    ]
  });
  /* And the instruction it gives must be one that works. */
  for (const candidate of [workerA, workerB]) {
    assert.equal(directory.resolveDelivery({ from: 'Manager', to: candidate.agentId }).recipient.agentId, candidate.agentId);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'resolution refusals do not mutate the directory');
});

test('concurrent process registrations preserve every node instead of losing a read-modify-write', async t => {
  const workspace = workspaceFor(t, 'tree-directory-concurrent');
  const file = path.join(workspace, 'tree.json');
  const readyFile = path.join(workspace, 'ready.txt');
  const goFile = path.join(workspace, 'go');
  const helper = path.join(workspace, 'register-child.cjs');
  const modulePath = require.resolve('../../src/lib/agent-comms/tree-node-directory');
  fs.writeFileSync(helper, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const [modulePath, file, readyFile, goFile, index] = process.argv.slice(2);",
    "const { createTreeNodeDirectory } = require(modulePath);",
    "fs.appendFileSync(readyFile, index + '\\n');",
    "(async () => {",
    "  while (!fs.existsSync(goFile)) await new Promise(resolve => setTimeout(resolve, 5));",
    "  createTreeNodeDirectory({ file }).registerNode({ sessionId: 'session-' + index, nodeName: 'Node ' + index });",
    "  process.stdout.write(index);",
    "})().catch(error => { console.error(error && error.stack || error); process.exit(1); });",
    ''
  ].join('\n'), 'utf8');

  const count = 12;
  const children = [];
  const completions = [];
  for (let index = 0; index < count; index += 1) {
    const child = spawn(process.execPath, [helper, modulePath, file, readyFile, goFile, String(index)], {
      cwd: workspace,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(child);
    completions.push(childCompletion(child));
  }
  t.after(() => { for (const child of children) { try { child.kill(); } catch { /* already exited */ } } });
  await waitUntil(() => fs.existsSync(readyFile)
    && fs.readFileSync(readyFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length === count);
  fs.writeFileSync(goFile, 'go', 'utf8');
  const results = await Promise.all(completions);
  for (const result of results) {
    assert.equal(result.code, 0, `a concurrent registration failed: ${result.stderr}`);
  }
  const nodes = createTreeNodeDirectory({ file }).listNodes();
  assert.equal(nodes.length, count);
  assert.deepEqual(nodes.map(node => node.nodeName).sort(),
    Array.from({ length: count }, (_, index) => `Node ${index}`).sort());
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the successful writers left the mutation lock behind');
});

test('a registration keeps its engine thread, and a resumed session finds its circle by it', (t) => {
  const file = path.join(workspaceFor(t, 'tree-thread'), 'tree-nodes.json');
  const directory = createTreeNodeDirectory({ file });
  const first = directory.registerNode({ sessionId: 'chat-first', nodeName: 'Manager', managerName: 'Controller', threadId: 'thread-42' });
  assert.equal(first.threadId, 'thread-42');
  assert.equal(directory.findByThreadId('thread-42').sessionId, 'chat-first');
  assert.equal(directory.findByThreadId('thread-unknown'), null);
  assert.equal(directory.findByThreadId(''), null);

  // Bound later, for a session that registered before its engine thread existed.
  directory.registerNode({ sessionId: 'chat-late', nodeName: 'Worker' });
  assert.equal(directory.findByThreadId('thread-7'), null);
  assert.deepEqual(directory.bindThread({ sessionId: 'chat-late', threadId: 'thread-7' }).found, true);
  assert.equal(directory.findByThreadId('thread-7').nodeName, 'Worker');
  rejectsCode(() => directory.bindThread({ sessionId: 'chat-late', threadId: '' }), 'TREE_THREAD_INVALID');

  // The old session stops; the resumed one registers under the same thread and wins the lookup.
  directory.unregisterNode({ sessionId: 'chat-first' });
  const resumed = directory.registerNode({ sessionId: 'chat-resumed', nodeName: 'Manager', managerName: 'Controller', threadId: 'thread-42' });
  assert.equal(directory.findByThreadId('thread-42').sessionId, 'chat-resumed');
  assert.equal(directory.findByThreadId('thread-42').agentId, resumed.agentId);
  const reopened = createTreeNodeDirectory({ file }).listNodes();
  assert.equal(reopened.find(node => node.sessionId === 'chat-resumed').threadId, 'thread-42', 'the thread is durable, not in-memory');
});

test('a resumed circle takes its entry over, so one circle is never two agents', (t) => {
  const file = path.join(workspaceFor(t, 'tree-resume-takeover'), 'tree-nodes.json');
  const directory = createTreeNodeDirectory({ file });
  directory.registerNode({ sessionId: 'manager-before', nodeName: 'Manager', threadId: 'thread-manager' });
  directory.registerNode({ sessionId: 'worker', nodeName: 'Worker', managerName: 'Manager', threadId: 'thread-worker' });

  /* NOTHING UNREGISTERED THE FIRST SESSION. That is what a process which ended
     without closing its sessions leaves on disk, and the row stays inside the
     90s live window. The person reopens and resumes the same circle. */
  directory.registerNode({ sessionId: 'manager-after', nodeName: 'Manager', threadId: 'thread-manager' });

  const managers = directory.listNodes().filter(node => node.nodeName === 'Manager');
  assert.equal(managers.length, 1, 'the resume left a second Manager beside the circle it continues');
  assert.equal(managers[0].sessionId, 'manager-after');

  const delivery = directory.resolveDelivery({ from: 'Worker', to: 'Manager' });
  assert.equal(delivery.ok, true, `a message to the resumed circle was refused: ${delivery.code}`);
  assert.equal(delivery.recipient.sessionId, 'manager-after');

  const roster = directory.reachabilityFrom({ from: 'Worker' });
  assert.deepEqual(roster.reachable.map(entry => entry.nodeName), ['Manager']);
  assert.deepEqual(roster.unavailable, []);
});

test('a resumed circle that was stopped first leaves no stopped twin in the roster', (t) => {
  const file = path.join(workspaceFor(t, 'tree-resume-twin'), 'tree-nodes.json');
  const directory = createTreeNodeDirectory({ file });
  directory.registerNode({ sessionId: 'manager-before', nodeName: 'Manager', threadId: 'thread-manager' });
  directory.registerNode({ sessionId: 'worker', nodeName: 'Worker', managerName: 'Manager', threadId: 'thread-worker' });
  directory.unregisterNode({ sessionId: 'manager-before' });
  directory.registerNode({ sessionId: 'manager-after', nodeName: 'Manager', threadId: 'thread-manager' });

  const roster = directory.reachabilityFrom({ from: 'Worker' });
  assert.deepEqual(roster.reachable.map(entry => entry.nodeName), ['Manager']);
  assert.deepEqual(
    roster.unavailable,
    [],
    'the roster the model reads called one circle reachable and session-stopped at the same time',
  );
});

test('a circle that merely stopped keeps its row, and its own sentence', (t) => {
  const file = path.join(workspaceFor(t, 'tree-stopped-kept'), 'tree-nodes.json');
  const directory = createTreeNodeDirectory({ file });
  directory.registerNode({ sessionId: 'manager', nodeName: 'Manager', threadId: 'thread-manager' });
  directory.registerNode({ sessionId: 'worker', nodeName: 'Worker', managerName: 'Manager', threadId: 'thread-worker' });
  directory.unregisterNode({ sessionId: 'manager' });

  /* A DIFFERENT circle registering must not sweep the stopped one: only a
     registration on the SAME thread supersedes, and rows with no thread at all
     are never matched by it. */
  directory.registerNode({ sessionId: 'other', nodeName: 'Other', managerName: 'Manager', threadId: 'thread-other' });
  directory.registerNode({ sessionId: 'threadless', nodeName: 'Threadless', managerName: 'Manager' });

  /* T255. THE SUBJECT OF THIS TEST IS THE SURVIVING ROW, and it is asserted
     harder than before rather than softer. It used to prove the row survived by
     showing the delivery refused with "its session has stopped" -- a refusal can
     only name a circle it can still see. Now the row is not merely visible but
     ADDRESSABLE: the stopped circle resolves, by name, to its own agentId, which
     is a strictly stronger statement about the same row. The count assertion
     that was the real point is untouched. */
  const resolved = directory.resolveDelivery({ from: 'Worker', to: 'Manager' });
  assert.equal(resolved.ok, true, 'the stopped row is still addressable, which is what keeping it is for');
  assert.equal(resolved.recipientStopped, true, 'and the caller is told no session is reading yet');
  assert.equal(resolved.recipient.nodeName, 'Manager',
    'it resolved to the stopped Manager, not to one of the circles that registered afterwards');
  assert.equal(
    directory.listNodes().filter(node => node.nodeName === 'Manager').length,
    1,
    'the stopped circle lost the row that tells a person its session ended rather than its name being wrong',
  );
});

/* MEASURED 2026-09-03 against the live directory (11 rows): two rows, both
 * named "Controller", carried stoppedAt: null with heartbeatAt 4007s and
 * 2229s in the past -- 66 and 37 minutes past the 90-second live window --
 * because whatever ran their sessions never got to call unregisterNode. A row
 * only used to age out once stoppedAt was set, and nothing sets it for a
 * session that did not exit cleanly, so a crashed or killed process left a
 * row that would never leave the directory: one of MAX_NODES=64 slots spent
 * forever on a circle nobody can reach and this file could never retire. */
test('a heartbeat that goes silent without an explicit stop is reclaimed like a clean stop, not held forever', t => {
  const workspace = workspaceFor(t, 'tree-directory-silent-crash');
  const file = path.join(workspace, 'tree.json');
  let now = 1_900_000_000_000;
  const directory = createTreeNodeDirectory({ file, now: () => now, liveWindowMs: 90_000 });

  // A session that registers and then never calls heartbeatNode or
  // unregisterNode again -- a killed process, a crash, a power loss -- is the
  // exact shape measured live. stoppedAt stays null for the rest of its life.
  directory.registerNode({ sessionId: 'ghost-session', nodeName: 'Ghost' });

  // Long past the 90-second live window but short of the one-hour retention a
  // CLEAN stop earns: a row merely quiet for under an hour must not be swept
  // just because something else on the tree registers.
  now += 59 * 60 * 1000;
  directory.registerNode({ sessionId: 'nearby-session', nodeName: 'Nearby' });
  assert.deepEqual(
    directory.listNodes().map(node => node.nodeName).sort(),
    ['Ghost', 'Nearby'],
    'a silent row under the one-hour retention survives a sweep-triggering registration elsewhere'
  );

  // Now past the same one-hour retention a clean stop would have earned it.
  // Nobody ever called unregisterNode for "Ghost" -- its stoppedAt is still
  // null -- but an hour of silence is an hour of silence either way.
  now += 2 * 60 * 1000;
  directory.registerNode({ sessionId: 'later-session', nodeName: 'Later' });
  assert.deepEqual(
    directory.listNodes().map(node => node.nodeName).sort(),
    ['Later', 'Nearby'],
    'a row that never called unregisterNode is still reclaimed once its heartbeat is an hour stale'
  );
});
