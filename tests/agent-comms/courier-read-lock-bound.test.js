'use strict';

// THE COURIER'S ROUND, AND THE MACHINE-WIDE LOCK IT WAITED FOR ON THE MAIN THREAD.
//
// MEASURED at 80f08ecb before this change (builds\w14-measure-inbox-sync.cjs and
// builds\w14-measure-contention.cjs, both naming their build):
//
//   inboxes() SYNCHRONOUS prefix -- the work before its first await, which the
//   event loop cannot interrupt -- seeded from the real 2.6 MB live spool:
//     memo HIT           1.33 / 1.49 / 1.77 ms
//     memo MISS        160.68 / 162.71 / 204.57 ms      (3 circles)
//     memo MISS        151.30 / 175.53 / 192.58 ms      (21 circles)
//   and essentially all of the miss is createLocalAgentCommsRuntime().
//
// TWO THINGS THAT FOLLOW, AND THEY REDIRECT THIS FIX:
//
// 1. CIRCLE COUNT IS NOT THE COST. 3 circles and 21 circles cost the same. The
//    per-request scan in inboxes() is O(requests) over a handful of small
//    objects; indexing or capping it cannot help, because it is not where the
//    time goes.
// 2. THE COST IS THE RUNTIME BUILD, AND ITS WORST CASE IS A LOCK WAIT. Building
//    a runtime constructs a broker, which calls withStateLock() on the
//    machine-wide spool file and waits with Atomics.wait -- a real thread block
//    -- polling until DEFAULT_LOCK_TIMEOUT_MS (10_000). So the ceiling on this
//    synchronous prefix is ten seconds of blocked main thread, and live's worst
//    observed tree-courier:read-dispatch span is 3,257 ms.
//
// AND THE FAILURE IS WORSE THAN SLOW. Reproduced with real contending
// processes: when the wait runs out, withStateLock throws BROKER_STATE_LOCKED
// out of runtimeFor(), which sits OUTSIDE the per-request try/catch in
// inboxes() -- so the whole round throws and EVERY circle goes unread. That is
// the exact shape this module's own comment says it refuses to have:
// "one bad row refusing every reader".
//
// WHAT THIS PINS, BY BEHAVIOUR:
//   - a contended lock omits the round (retried next tick) instead of throwing it
//   - reads do not wait the full patient timeout; writes still do
//   - nothing is lost: the next uncontended round still delivers every message
//
// NO NEW TIMER. The retry is the courier's existing tick.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fork } = require('node:child_process');

const TEMP_ROOT = fs.realpathSync.native ? fs.realpathSync.native(os.tmpdir()) : fs.realpathSync(os.tmpdir());
const STATE_ROOT = fs.mkdtempSync(path.join(TEMP_ROOT, 'courier-read-lock-'));
process.env.TOOLSENABLED_STATE_ROOT = STATE_ROOT;
process.on('exit', () => { try { fs.rmSync(STATE_ROOT, { recursive: true, force: true }); } catch { /* OS sweeps temp */ } });

const { createTreeNodeDirectory } = require('../../src/lib/agent-comms/tree-node-directory');
const local = require('../../src/lib/providers/agent-comms-local');

const START_MS = 1_900_000_000_000;
const PAST_THE_CEILING_MS = 60_000;

// The default patient wait. A read that is bounded must come back FAR inside
// this; the margin is wide on purpose so a loaded machine cannot make this
// test lie in either direction.
const DEFAULT_PATIENT_WAIT_MS = 10_000;
const BOUNDED_READ_MUST_BEAT_MS = 5_000;

let standing = 0;

/* A REAL HOLDER OF THE REAL LOCK, in another process. The broker derives its
   lock as `${spoolFile}.lock` (src/lib/agent-comms/broker.js, withStateLock),
   so holding that exact file is holding the broker's lock -- no stubbing, and
   the product's own contention path is what runs. */
function holdLock(lockFile, holdMs) {
  const child = fork(path.join(__dirname, 'helpers', 'hold-broker-lock.cjs'), [lockFile, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  return {
    child,
    held: new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the lock holder never reported that it held the lock')), 20_000);
      child.once('message', message => { clearTimeout(timer); resolve(message); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    }),
    release() { try { child.kill(); } catch { /* already gone */ } }
  };
}

async function standUp(circles = 3) {
  standing += 1;
  const suffix = `t${standing}`;
  const clock = { at: START_MS };
  const now = () => clock.at;
  const brokerFile = path.join(STATE_ROOT, `broker-${suffix}.json`);
  const tree = createTreeNodeDirectory({ file: path.join(STATE_ROOT, `tree-${suffix}.json`), now });
  const provider = local.createLocalAgentMessageProvider({ directory: tree, brokerFile, now });
  tree.registerNode({ sessionId: `session-controller-${suffix}`, nodeName: 'Controller' });
  const nodes = [];
  for (let i = 0; i < circles; i += 1) {
    nodes.push(tree.registerNode({
      sessionId: `session-circle-${i}-${suffix}`,
      nodeName: `Circle${i}`,
      managerSessionId: `session-controller-${suffix}`,
      managerName: 'Controller'
    }));
    // eslint-disable-next-line no-await-in-loop
    const sent = await provider.send({ from: 'Controller', to: `Circle${i}`, body: `work item ${i}` });
    assert.equal(sent.accepted, true, 'the fixture must actually put a message on the wire');
  }
  return {
    clock, provider, tree, nodes, brokerFile,
    lockFile: `${path.resolve(brokerFile)}.lock`,
    requests: nodes.map(node => ({ agentId: node.agentId, cursor: 0, limit: 10 }))
  };
}

// The synchronous prefix: an async function runs synchronously until its first
// await, so this is exactly the main-thread work the event loop cannot escape.
function syncPrefix(fn) {
  const t0 = process.hrtime.bigint();
  const promise = fn();
  const t1 = process.hrtime.bigint();
  return { elapsed: Number(t1 - t0) / 1e6, promise };
}

test('a contended spool lock omits the courier round instead of throwing it, and does not block on the patient wait', async () => {
  const rig = await standUp(3);
  await rig.provider.inboxes(rig.requests); // warm the memo

  const holder = holdLock(rig.lockFile, 8_000);
  await holder.held;
  try {
    // Past the memo ceiling, so this round MUST try to rebuild and MUST meet
    // the held lock. Without that the round would answer from the memo and
    // this test would pass without ever touching the contention path.
    rig.clock.at += PAST_THE_CEILING_MS;

    const { elapsed, promise } = syncPrefix(() => rig.provider.inboxes(rig.requests));
    const answer = await promise;

    // THE HEADLINE, ASSERTED FIRST because it is the job: bound the
    // synchronous work. Measured at 80f08ecb this blocks for ~9,072 ms.
    assert.ok(elapsed < BOUNDED_READ_MUST_BEAT_MS,
      `a read must not spend the patient ${DEFAULT_PATIENT_WAIT_MS} ms wait blocking the main thread; `
      + `this round blocked it for ${elapsed.toFixed(0)} ms`);
    assert.ok(Array.isArray(answer),
      'a round that met a held lock must still answer with a list, not throw the whole round away');
    assert.equal(answer.length, 0,
      'every circle must be OMITTED, never answered with an empty page -- an empty page reads as '
      + '"nothing arrived" and is how a message is lost once and never looked for again');
  } finally {
    holder.release();
  }
});

test('nothing is lost: once the lock is free the same round delivers every message', async () => {
  const rig = await standUp(3);
  await rig.provider.inboxes(rig.requests);

  const holder = holdLock(rig.lockFile, 4_000);
  await holder.held;
  rig.clock.at += PAST_THE_CEILING_MS;
  const skipped = await rig.provider.inboxes(rig.requests);
  assert.equal(skipped.length, 0, 'premise: the contended round must have been omitted');
  holder.release();

  // Give the holder's exit a moment to land, then read again.
  await new Promise(resolve => setTimeout(resolve, 500));
  rig.clock.at += PAST_THE_CEILING_MS;
  const answer = await rig.provider.inboxes(rig.requests);

  assert.equal(answer.length, rig.requests.length,
    'once the lock is free every circle must be answered again -- a skipped round is a retry, not a loss');
  for (const entry of answer) {
    assert.ok(entry.page.records.length > 0,
      `${entry.agentId} must still have the message that was waiting for it before the contended round`);
  }
});

test('an uncontended round is unchanged: every circle is answered with its own page', async () => {
  const rig = await standUp(3);
  rig.clock.at += PAST_THE_CEILING_MS;
  const answer = await rig.provider.inboxes(rig.requests);
  assert.equal(answer.length, rig.requests.length, 'with a free lock nothing about the round changes');
  assert.deepEqual(
    answer.map(entry => entry.page.records.map(record => record.message.body)),
    rig.nodes.map((node, index) => [`Controller: work item ${index}`]),
    'and each circle gets exactly the message it was sent'
  );
});

test('a SEND still waits patiently: only reads are bounded', async () => {
  // The asymmetry is the point. A read that is skipped is retried on the next
  // tick and costs nothing. A send that is refused is a message the person
  // asked to deliver and did not get, so it keeps the full patient wait.
  const rig = await standUp(1);
  const holder = holdLock(rig.lockFile, 1_200);
  await holder.held;
  rig.clock.at += PAST_THE_CEILING_MS;

  const sent = await rig.provider.send({ from: 'Controller', to: 'Circle0', body: 'this must not be dropped' });
  holder.release();

  assert.equal(sent.accepted, true,
    'a send that met a briefly-held lock must wait for it, not inherit the read path\'s bound');
});
