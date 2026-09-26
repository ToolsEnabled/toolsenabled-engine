'use strict';
/* EIGHT SESSIONS REGISTERING AT ONCE MUST NOT STARVE EACH OTHER.
 *
 * MAX_AGENT_SESSIONS in shell/main.cjs caps this product at eight LIVE
 * sessions, and every one of them calls registerNode()/heartbeatNode() on
 * this same shared file -- from separate OS processes when more than one
 * ToolsEnabled-owned process touches the state root at once (an external
 * tool, a repair script, a second launch), which this repository's own
 * history already shows happens (tools/agent-to-agent-mcp-proof.mjs,
 * tools/agent-tool-sweep-qa.mjs, repair-tree-directory-manager.mjs all call
 * registerNode() directly, outside the app).
 *
 * MEASURED 2026-09-03, against this file's own mutate() before the fix below:
 * eight real node processes, each calling registerNode() in a loop for a few
 * seconds, default settings throughout (DEFAULT_LOCK_TIMEOUT_MS = 10_000).
 * Across several runs at this shape, between 30% and 67% of calls failed
 * TREE_DIRECTORY_BUSY -- each one only after burning its FULL ~10s wait doing
 * nothing. Raising that budget to 60s did not fix it: calls kept failing at
 * the full 60s, so this was not "too impatient", it was a herd that never
 * converges. One run: 64 calls, 45 failed, 82.8s wall time. The identical
 * scenario against the fix: 64/64 succeeded, 0 failures, 39.2s -- faster AND
 * correct, because nothing was burning its whole budget on a doomed attempt.
 *
 * THE CAUSE (see acquireMutationLock's own comment in
 * src/lib/agent-comms/tree-node-directory.js for the full account): the retry
 * loop around lock.js's acquireLock() called it again from scratch on every
 * TREE_DIRECTORY_BUSY, and acquireLock() mints a fresh random ticket every
 * call -- so the retry was not waiting in line, it was drawing a new number
 * and walking to the back, and eight processes doing that together never let
 * the queue stand still long enough for anyone to reach the front.
 *
 * WHY THIS TEST SPAWNS REAL PROCESSES rather than mocking the lock: the bug
 * is specifically about SEPARATE OS processes racing a real lock FILE: it
 * does not reproduce from async interleaving inside one process, because
 * nothing in this module ever holds the lock across an await -- mutate() is
 * fully synchronous. A fake timer proves nothing about a real herd.
 *
 *   node --test tests/tree-directory-lock-contention.test.js
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const MODULE_PATH = require.resolve('../src/lib/agent-comms/tree-node-directory.js');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tree-lock-contention-'));
}

/* One contender's body, run in a genuinely separate `node -e` process (see
 * the file header for why this cannot be an in-process fake). Deliberately
 * not a fixture file: no new non-test file, per this lane's own rule, and the
 * body is short enough that inlining it is the honest choice anyway.
 *
 * `node -e "<src>" -- a b c` hands the script `process.argv` = [execPath, a,
 * b, c] -- there is no eval placeholder in argv the way there is a script
 * path when running a real .js file, so the real arguments start at argv[1].
 *
 * EVERY WORKER WAITS UNTIL THE SAME WALL-CLOCK INSTANT before its first
 * attempt. Relying on process-launch jitter to spread out eight arrivals is
 * not this bug: staggered arrivals mostly queue up cleanly one at a time, and
 * whether the herd forms at all became a coin flip across otherwise-identical
 * runs (measured: one run passed at 100% against the UNFIXED code, the very
 * defect this test exists to catch). A shared start instant makes all eight
 * processes present their first ticket at once on every run, which is the
 * scenario the fix's own MEASURED comment is about and the one real launches
 * approximate whenever more than one session starts together. */
const WORKER_SOURCE = `
'use strict';
const { createTreeNodeDirectory } = require(process.argv[1]);
const directory = createTreeNodeDirectory({ file: process.argv[2], lockTimeoutMs: Number(process.argv[5]) });
const workerId = process.argv[3];
const startAt = Number(process.argv[6]);
const barrier = new Int32Array(new SharedArrayBuffer(4));
while (Date.now() < startAt) Atomics.wait(barrier, 0, 0, startAt - Date.now());
const stopAt = Date.now() + Number(process.argv[4]);
let ok = 0, busy = 0, other = 0, attempted = 0;
while (Date.now() < stopAt) {
  const sessionId = 'contend-' + workerId + '-' + attempted;
  try {
    directory.registerNode({
      sessionId,
      nodeName: 'Node-' + workerId,
      pid: process.pid,
      threadId: 'thread-' + workerId + '-' + attempted,
    });
    ok += 1;
  } catch (error) {
    if (error && error.code === 'TREE_DIRECTORY_BUSY') busy += 1; else other += 1;
  }
  attempted += 1;
}
process.stdout.write(JSON.stringify({ ok, busy, other, attempted }));
`;

function runWorker(file, workerId, durationMs, lockTimeoutMs, startAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '-e', WORKER_SOURCE, '--',
      MODULE_PATH, file, String(workerId), String(durationMs), String(lockTimeoutMs), String(startAt),
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 80_000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`worker ${workerId} exited ${code}, stderr: ${stderr.slice(0, 2000)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`worker ${workerId} produced unparsable stdout ${JSON.stringify(stdout).slice(0, 500)}: ${error.message}`));
      }
    });
  });
}

test('eight processes registering concurrently mostly succeed instead of starving on TREE_DIRECTORY_BUSY', { timeout: 90_000 }, async (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'tree-nodes.json');

  // Mirrors MAX_AGENT_SESSIONS (shell/main.cjs) -- the real concurrency
  // ceiling this file's own callers live under -- and this module's own
  // DEFAULT_LOCK_TIMEOUT_MS, so the test measures the budget production code
  // actually gets, not a budget picked to make the assertion convenient.
  const WORKERS = 8;
  const DURATION_MS = 6000;
  const LOCK_TIMEOUT_MS = 10_000;
  // Generous lead time for eight `node -e` processes to spawn, load this
  // module and reach the barrier -- a slow spawn arriving AFTER startAt
  // would just fall straight through to its first attempt alone, which
  // undersells the herd rather than falsely inflating it.
  const startAt = Date.now() + 2000;

  const settled = await Promise.allSettled(
    Array.from({ length: WORKERS }, (_, workerId) => runWorker(file, workerId, DURATION_MS, LOCK_TIMEOUT_MS, startAt))
  );
  const results = settled.map((result) => {
    assert.equal(result.status, 'fulfilled', result.reason?.message);
    return result.value;
  });

  const totals = results.reduce((sum, r) => ({
    ok: sum.ok + r.ok,
    busy: sum.busy + r.busy,
    other: sum.other + r.other,
    attempted: sum.attempted + r.attempted,
  }), { ok: 0, busy: 0, other: 0, attempted: 0 });

  assert.equal(totals.other, 0,
    `no call should fail with anything but TREE_DIRECTORY_BUSY; saw ${JSON.stringify(totals)}`);
  assert.ok(totals.attempted >= WORKERS,
    `each of ${WORKERS} workers should get at least one attempt in; saw ${JSON.stringify(totals)}`);

  // The bug measured 30-67% success under this exact shape; the fix measured
  // 100% every time it was tried. 90% leaves real margin on a busy shared
  // machine without being anywhere near what the unfixed retry loop achieves.
  const successRate = totals.ok / totals.attempted;
  assert.ok(successRate >= 0.9,
    `expected at least 90% of concurrent registerNode() calls to succeed, got `
    + `${(successRate * 100).toFixed(1)}% (${JSON.stringify(totals)}); a retry that abandons its `
    + 'queue position on every TREE_DIRECTORY_BUSY reintroduces the eight-way starvation this guards against');

  // The lock protected more than throughput: the file the whole tree depends
  // on must still come out whole, with one row per session and no row lost or
  // doubled by an interrupted mutate().
  const { createTreeNodeDirectory } = require(MODULE_PATH);
  const directory = createTreeNodeDirectory({ file });
  const nodes = directory.listNodes();
  const seen = new Set();
  for (const node of nodes) {
    assert.ok(!seen.has(node.agentId), `duplicate agentId row survived concurrent writers: ${node.agentId}`);
    seen.add(node.agentId);
  }
  assert.equal(nodes.length, totals.ok,
    `every successful registerNode() should leave exactly one row; ${totals.ok} succeeded but `
    + `${nodes.length} rows are on file`);
});
