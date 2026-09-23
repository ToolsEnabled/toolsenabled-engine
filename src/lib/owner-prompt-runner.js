'use strict';

// One owner-controlled queue policy; native adapters own only launch and UI.
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const queue = require('./providers/owner-prompt-queue');
const native = require('./owner-prompt-platform');
const { acquireLock } = require('./process-claim-lock');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function queueTransaction(work) {
  const deadline = performance.now() + 60_000;
  for (;;) {
    try { return work(); }
    catch (error) {
      if (error.code !== 'OWNER_PROMPT_QUEUE_BUSY' || performance.now() >= deadline) throw error;
      await sleep(50);
    }
  }
}

async function drain({ queueFile = queue.QUEUE_FILE, ui = native.createUI(), graceMs = 20_000 } = {}) {
  const options = { queueFile };
  const pending = () => queue.readQueue(queueFile).items.filter(item => item.status === 'queued' && ui.supportedKinds.includes(item.kind));
  const first = pending();
  if (!first.length) return 'empty';
  if (await ui.begin(first.length, first[0]) !== true) return 'paused';
  let deadline = performance.now() + graceMs;
  for (;;) {
    const next = pending()[0];
    if (!next) {
      if (performance.now() >= deadline) return 'drained';
      await sleep(Math.min(500, Math.max(1, deadline - performance.now()))); continue;
    }
    const item = await queueTransaction(() => queue.runnerClaim(next.requestId, options));
    if (!item) continue; // Owner cancelled while the Start dialog was open.
    let outcome;
    try { outcome = await ui.capture(item); } catch { outcome = 'failed'; }
    if (!['completed', 'cancelled', 'timeout', 'deferred'].includes(outcome)) outcome = 'failed';
    // A concurrent enqueue may briefly hold the queue lock after Save. Retry
    // that metadata transaction only; never reopen the form or repeat Save.
    await queueTransaction(() => queue.runnerSettle(item.requestId, outcome, options));
    if (outcome !== 'completed') return 'paused';
    deadline = performance.now() + graceMs;
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== '--queue' || path.resolve(args[1]) !== path.resolve(queue.QUEUE_FILE)) throw new Error('OWNER_PROMPT_QUEUE_OUTSIDE_STATE_ROOT');
  const queueFile = path.resolve(args[1]);
  native.assertAvailable();
  if (native.legacyRunnerIsAlive(queueFile)) return;
  let lock;
  try { lock = acquireLock(native.runnerLock(queueFile), { publishGraceMs: 60_000, polls: 1200 }); }
  catch (error) { if (error.code === 'AGENT_DIGEST_ALREADY_RUNNING') return; throw error; }
  try {
    // Only the exclusive runner may recover an interrupted presentation.
    await queueTransaction(() => queue.runnerPrepare({ queueFile }));
    await drain({ queueFile });
  } finally { lock.release(); }
}

if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = Object.freeze({ drain, main });
