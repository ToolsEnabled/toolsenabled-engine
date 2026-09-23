'use strict';

/* THREE GRADES STOP A WAVE THAT FAILED FROM READING AS A WAVE THAT FOUND NOTHING,
 * AND NOTHING ASSERTED ANY OF THEM.
 *
 * batch-harvest.js separates an answer about the CODE from an answer about the
 * RUN. NO_DIFF means the agent looked and there was nothing to change. PENDING,
 * ERRORED and THROTTLED all mean something else entirely, and the module's own
 * header records what it cost to learn that: graded as NO_DIFF, "two waves errored
 * 66/66 and 8/8 and harvested as a clean manifest".
 *
 * Measured 2026-08-27: NO_DIFF is asserted by two test files. PENDING, ERRORED and
 * THROTTLED are asserted by ZERO. So the three grades whose entire purpose is
 * preventing a false-clean harvest were themselves unguarded -- the shape this
 * repository keeps finding, arriving in the instrument rather than the product.
 *
 * THE TERMINAL THROTTLE WAS UNREACHABLE, WHICH IS WHY IT WAS UNPINNED. The real
 * backoff ladder totals 63 seconds and nobody keeps a 63-second test. The ladder
 * now joins fetchTask, fsImpl and concurrency in the module's injected set, so it
 * can be driven in milliseconds. Default unchanged; a real harvest is unaffected.
 *
 * EVERY CASE HERE ASSERTS THE TALLY, not only the verdict, because the tally is
 * what a person reads and the false-clean failure was a tally that said the wave
 * was fine.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const batchHarvest = require('../src/lib/cloud-agent/batch-harvest');

const NO_DELAYS = Object.freeze([0, 0]);
let checks = 0;

function diffFor(file) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    '-before',
    '+after',
  ].join('\n');
}

function journalOf(temp, targets) {
  const file = path.join(temp, `journal-${targets.length}-${targets[0].replace(/\W/g, '')}.jsonl`);
  const lines = [];
  targets.forEach((target, i) => {
    lines.push(JSON.stringify({ kind: 'intent', index: i + 1, target }));
    lines.push(JSON.stringify({ kind: 'launched', index: i + 1, taskId: `task-${i + 1}`, account: 'acct-a' }));
  });
  fs.writeFileSync(file, lines.join('\n'));
  return file;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-run-vs-code-'));

async function harvest(targets, fetchTask, label) {
  return batchHarvest.harvestBatch({
    journalFile: journalOf(temp, targets),
    outDir: path.join(temp, `out-${label}`),
    concurrency: 1,
    retryDelaysMs: NO_DELAYS,
    fetchTask,
  });
}

(async () => {
  const target = 'src/lib/cloud-agent/widget.js';

  /* ---- 1. A WAVE STILL RUNNING IS NOT A WAVE THAT FOUND NOTHING ---------- */
  const pending = await harvest([target], async () => ({ state: 'pending' }), 'pending');
  assert.equal(pending.tally.NO_DIFF, undefined,
    'a task the provider still calls unfinished was tallied as NO_DIFF, so harvesting a wave mid-flight '
    + 'reports it as having found nothing to fix');
  assert.deepEqual(pending.tally, { PENDING: 1 });
  checks += 2;

  /* ---- 2. A LANE THAT FAILED IS NOT A LANE THAT FOUND NOTHING ------------ */
  /* The measured case in this module's own header: two waves errored 66/66 and
     8/8 and harvested as a clean manifest. */
  const errored = await harvest([target],
    async () => ({ state: 'errored', detail: 'the sandbox died before the run started' }), 'errored');
  assert.equal(errored.tally.NO_DIFF, undefined,
    'a task the provider reports as FAILED was tallied as NO_DIFF -- a wave that failed entirely is then '
    + 'indistinguishable from one that found nothing to fix');
  assert.deepEqual(errored.tally, { ERRORED: 1 });
  const manifest = JSON.parse(fs.readFileSync(errored.manifestFile, 'utf8'));
  assert.match(manifest.tasks[0].note, /sandbox died/,
    'the provider said WHY the lane failed and the manifest dropped it, leaving a reviewer nothing to act on');
  checks += 3;

  /* ---- 3. A THROTTLE THAT NEVER LIFTS IS NOT AN UNREADABLE TASK ---------- */
  /* Its diff probably EXISTS; the provider would not hand it over. Recording it
     as FETCH_ERROR or NO_DIFF loses work that is sitting there. */
  const throttled = await harvest([target], async () => {
    const error = new Error('request failed: 429 Too Many Requests');
    throw error;
  }, 'throttled');
  assert.deepEqual(throttled.tally, { THROTTLED: 1 },
    'a task throttled through every retry was not reported as still-throttled, so a re-run cannot pick it up');
  checks += 1;

  /* ---- 4. A THROTTLE THAT LIFTS IS GRADED ON ITS DIFF -------------------- */
  /* THE CONTROL for case 3. Without it, reporting THROTTLED on the FIRST 429
     would satisfy the assertion above while throwing away every diff behind one
     transient refusal -- the same could-not-look-is-not-an-answer mistake, made
     by the harvester instead of the product. */
  let refusals = 1;
  const recovered = await harvest([target], async () => {
    if (refusals > 0) { refusals -= 1; throw new Error('request failed: 429 Too Many Requests'); }
    return { state: 'ready', diff: diffFor(target) };
  }, 'recovered');
  assert.deepEqual(recovered.tally, { IN_FENCE: 1 },
    'one 429 that then lifted was recorded as throttled, so the retry ladder is not retrying');
  checks += 1;

  /* ---- 5. UNREADABLE IS NOT THROTTLED ----------------------------------- */
  const broken = await harvest([target],
    async () => { throw new Error('ENOENT: the codex binary is not on this machine'); }, 'broken');
  assert.deepEqual(broken.tally, { FETCH_ERROR: 1 },
    'a failure that is not a throttle was filed as one, so a re-run would wait for a rate limit that was '
    + 'never the problem');
  checks += 1;

  /* ---- 6. NO_DIFF STILL MEANS WHAT IT MEANS ----------------------------- */
  /* THE SECOND CONTROL, and the one that stops this file being satisfiable by
     never answering NO_DIFF at all: a task the provider calls READY with an empty
     diff is the honest nothing-to-fix answer and must keep saying so. */
  const clean = await harvest([target], async () => ({ state: 'ready', diff: '' }), 'clean');
  assert.deepEqual(clean.tally, { NO_DIFF: 1 },
    'a finished task with no diff no longer reports the honest nothing-to-fix answer');
  checks += 1;

  /* ---- 7. THE GRADES DO NOT BLEED ACROSS TASKS IN ONE WAVE -------------- */
  const mixed = await harvest([target, 'src/lib/cloud-agent/other.js'], async ({ taskId }) => (
    taskId === 'task-1' ? { state: 'pending' } : { state: 'ready', diff: '' }
  ), 'mixed');
  assert.deepEqual(mixed.tally, { PENDING: 1, NO_DIFF: 1 },
    'a wave holding one unfinished task and one honest no-change answer did not report both, so a partial '
    + 'harvest cannot be told from a complete one');
  checks += 1;

  console.log(`cloud-batch-harvest run-vs-code: ${checks} checks passed`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
