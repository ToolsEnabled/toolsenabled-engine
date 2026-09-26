'use strict';

/* The harvester the journal was always written for.
 *
 * batch-target.js's harvest spec says it plainly: "the harvester enumerates a
 * wave from the batch JOURNAL (the provider's own list caps at 20 rows and
 * shows one account, so the journal is the only complete record)". Until now
 * that harvester existed only as a per-wave script composed outside the repo
 * -- the first real 150-task wave (2026-08-24) was harvested by one, and its
 * grading rules were bought with that wave's ten rejections. This module is
 * those rules, kept.
 *
 * WHAT A GRADE MEANS. A grade is a HARVEST verdict, not a merge decision:
 * nothing here applies a diff, and a kept grade promises only that the diff
 * stayed inside the fence its brief declared. The gate that decides landing is
 * the full suite over an applied stack, run by whoever lands it.
 *
 *   IN_FENCE     every touched file is the task's own target, its REPORT file,
 *                or at most ONE test that names the target (in its filename or
 *                in the diff's own text for that file).
 *   NEAR_FENCE   shaped like IN_FENCE -- target plus at most one test plus the
 *                report -- but the test names the target nowhere. The first
 *                wave's near-fence diffs were all legitimate; they are kept
 *                separately because a reviewer should look before stacking.
 *   OUT_OF_FENCE anything that touched a file the fence does not cover.
 *   NO_DIFF      the provider reports the task terminal with no diff -- for a
 *                sweep, the honest nothing-to-fix answer.
 *   PENDING      the provider still calls the task unfinished.
 *   ERRORED      the provider reports the task as failed. It has no diff for
 *                the same reason NO_DIFF has none, and the difference is the
 *                whole point: NO_DIFF is an answer about the CODE, ERRORED is
 *                an answer about the RUN. Graded as NO_DIFF -- which it was
 *                until two waves errored 66/66 and 8/8 and harvested as a
 *                clean manifest -- a wave that failed entirely is
 *                indistinguishable from one that found nothing to fix.
 *   THROTTLED    the provider answered 429 through every backoff. The task's
 *                diff probably EXISTS -- this says only that the provider
 *                would not hand it over yet, so a re-run collects these.
 *   FETCH_ERROR  the provider could not be asked (after retries); the note
 *                carries the refusal so a re-run can pick these up alone.
 *
 * FETCH IS INJECTED, like the runner's dispatch: this module owns enumeration
 * and grading, never provider transport. The CLI supplies a fetch built on the
 * codex CLI under each account's own CODEX_HOME; tests supply a fake. */

const fs = require('node:fs');
const path = require('node:path');
const { CloudAgentError } = require('./errors');

function fail(code, message, details) {
  throw new CloudAgentError(code, message, details);
}

/* Growing waits, measured against the provider's own throttle: two calls per
 * task at four workers hit 429 immediately, and the throttle clears in tens of
 * seconds rather than milliseconds. A THROTTLED verdict after all of these is
 * a fact about the provider's patience, not about the task. */
const RETRY_DELAYS_MS = Object.freeze([2_000, 6_000, 15_000, 40_000]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* The journal is the wave's one complete record, so refusing to read it is
 * refusing to harvest -- there is no second source to fall back to. */
function readWave(journalFile, fsImpl) {
  let raw;
  try {
    raw = fsImpl.readFileSync(journalFile, 'utf8');
  } catch (error) {
    fail('CLOUD_HARVEST_NO_JOURNAL',
      `the batch journal at ${journalFile} could not be read (${error && error.code}): ${error && error.message}. `
      + 'The journal is the only complete record of a wave -- the provider list caps at 20 rows -- so nothing can be harvested without it.');
  }
  let declared = null;
  const launched = new Map();
  const targets = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; /* a torn final line is the journal contract */ }
    /* THE ADMITTED HEADER, which nothing here used to read. batch-target.js
       seals { branch, mutationSample } and openBatch writes them here, so the
       verification bar a wave was admitted under travels WITH the wave. Not
       reading it is how a sealed promise became evidence for a check that
       never ran. */
    if (entry.kind === 'admitted' && entry.harvest && typeof entry.harvest === 'object') {
      declared = entry.harvest;
    }
    if (entry.kind === 'intent' && Number.isInteger(entry.index)) targets.set(entry.index, entry.target);
    if (entry.kind === 'launched' && Number.isInteger(entry.index)) launched.set(entry.index, entry);
  }
  if (launched.size === 0) {
    fail('CLOUD_HARVEST_NOTHING_LAUNCHED',
      `${journalFile} records no launched task, so there is nothing to harvest. A journal with intents and no launches is a wave that never went out.`);
  }
  const tasks = [...launched.values()]
    .sort((a, b) => a.index - b.index)
    .map((entry) => ({ index: entry.index, taskId: entry.taskId, account: entry.account, target: targets.get(entry.index) || null }));
  /* An ARRAY WITH A PROPERTY rather than a new shape, so every existing caller
     and test that treats the result as a list keeps working unchanged. The
     sealed spec rides along for the one caller that needs it. */
  tasks.declared = declared;
  return tasks;
}

function filesOf(diffText) {
  const files = new Set();
  for (const match of String(diffText).matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) {
    files.add(match[1]);
    files.add(match[2]);
  }
  return [...files];
}

/* One file's own segment of a unified diff, so "the test names the target" is
 * asked of the test's changes and not of the whole wave's text. */
function segmentFor(diffText, file) {
  const text = String(diffText);
  const start = text.indexOf(`diff --git a/${file}`);
  if (start < 0) return '';
  const next = text.indexOf('diff --git a/', start + 1);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

/* THE ANSWER A WAVE WAS SENT TO GET, when the answer is not a code change.
 *
 * An INVESTIGATION brief -- run this red test and tell me whether the PRODUCT
 * is wrong or the ENVIRONMENT is -- is CORRECT to change nothing when the
 * answer is "the environment". It then grades NO_DIFF, and until now its
 * finding was unreachable from here: `cloud status` prints a bracket state and
 * the words "no diff", `cloud diff` has nothing, and the CLI has no command
 * that returns an agent message at all. Measured 2026-08-25, a 42-task
 * investigation wave came back 42/42 NO_DIFF with every answer stranded on a
 * task page, one click away and unreadable.
 *
 * The fence already TOLERATED a REPORT- file. It never read one. So the whole
 * mechanism for carrying an answer home existed except for the last step, and
 * briefs were being written to forbid the file rather than to use it.
 *
 * ONLY ADDED LINES ARE KEPT: a report is a file the task created, so the "+"
 * side is what it said. Capped, because a manifest is read by a person and one
 * runaway report should not bury forty concise ones -- and truncation is
 * STATED per finding rather than silent, so nobody reads a cut-off answer as a
 * complete one. */
const NEWLINE_RE = /\r?\n/;
const FINDING_CHARS_MAX = 4000;

function findingsIn(diffText, files) {
  const found = [];
  for (const file of files) {
    if (!/^REPORT-/i.test(path.basename(file))) continue;
    const added = segmentFor(diffText, file)
      .split(NEWLINE_RE)
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n')
      .trim();
    if (!added) continue;
    found.push({
      file,
      truncated: added.length > FINDING_CHARS_MAX,
      text: added.slice(0, FINDING_CHARS_MAX),
    });
  }
  return found;
}

function grade(diffText, target) {
  const files = filesOf(diffText);
  if (files.length === 0) return { verdict: 'NO_DIFF', files };
  const findings = findingsIn(diffText, files);
  if (!target) return { verdict: 'OUT_OF_FENCE', files, findings, note: 'the journal carries no intent target for this index, so no fence can vouch for it' };
  const stem = path.basename(target);
  const tests = [];
  for (const file of files) {
    if (file === target) continue;
    if (/^REPORT-/i.test(path.basename(file))) continue;
    /* THE FENCE'S INTENT IS "the target plus its own tests"; this regex is
       the implementation, and the two diverged: tools/launch-readiness/ names
       its tests <tool>.selftest.mjs beside the tool -- no tests/ directory,
       no .test. suffix -- so five wave-26 diffs touching exactly their target
       plus that target's OWN selftest graded OUT_OF_FENCE (2026-08-25).
       Agents obeyed the fence's meaning and were failed by its spelling. */
    const isTest = /(^|\/)tests?\//.test(file) || /\.(test|selftest)\.[a-z]+$/i.test(file);
    if (!isTest) return { verdict: 'OUT_OF_FENCE', files, findings, note: `${file} is neither the target, a report, nor a test` };
    tests.push(file);
  }
  if (tests.length > 1) return { verdict: 'OUT_OF_FENCE', files, findings, note: `${tests.length} test files touched; the fence allows one` };
  if (tests.length === 1) {
    const named = tests[0].includes(stem.replace(/\.[^.]+$/, '')) || segmentFor(diffText, tests[0]).includes(stem);
    if (!named) return { verdict: 'NEAR_FENCE', files, findings, note: `${tests[0]} names the target nowhere; review before stacking` };
  }
  return { verdict: 'IN_FENCE', files, findings };
}

/* fetchTask({ taskId, account }) -> { state: 'ready'|'pending', diff: string }
 * and throws for a provider it could not ask. Retries are the caller's
 * transport concern; one task's failure never costs the rest of the wave. */
/* retryDelaysMs joins fetchTask, fsImpl and concurrency in the injected set for
 * one reason: the real ladder totals 63 seconds, so the TERMINAL throttle
 * verdict could not be reached by any test anybody would keep. It stayed
 * unpinned because it was unreachable, not because it was unimportant -- and
 * THROTTLED, PENDING and ERRORED are the three grades that stop a wave which
 * failed or is still running from harvesting as a clean manifest. The default
 * is the real ladder; nothing about a real harvest changes. */
async function harvestBatch({ journalFile, outDir, fetchTask, fsImpl = fs, concurrency = 4,
  retryDelaysMs = RETRY_DELAYS_MS }) {
  if (typeof fetchTask !== 'function') {
    fail('CLOUD_HARVEST_MISCONFIGURED', 'harvestBatch needs fetchTask({ taskId, account }); enumeration without transport can name the wave but not collect it.');
  }
  const wave = readWave(journalFile, fsImpl);
  fsImpl.mkdirSync(outDir, { recursive: true });
  const manifest = [];
  const queue = [...wave];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 16)) }, async () => {
    for (;;) {
      const task = queue.shift();
      if (!task) return;
      const slug = `${String(task.index).padStart(3, '0')}-${path.basename(task.target || 'unknown').replace(/[^\w.-]/g, '_')}`;
      let record;
      /* THE PROVIDER THROTTLES A HARVEST HARDER THAN A LAUNCH. Measured on the
       * first real 144-task harvest: 92 of 144 came back 429 Too Many Requests,
       * evenly across both accounts, because every task costs two calls
       * (status, then diff) and nothing waited. A 429 is not an answer about
       * the task -- recording it as FETCH_ERROR loses a diff that exists. So
       * it is retried with growing backoff, and only a throttle that survives
       * every attempt is reported, by name, as still-throttled rather than as
       * an unreadable task. */
      for (let attempt = 0; attempt < retryDelaysMs.length + 1; attempt += 1) {
        try {
          const fetched = await fetchTask({ taskId: task.taskId, account: task.account });
          if (fetched && fetched.state === 'pending') {
            record = { verdict: 'PENDING', files: [] };
          } else if (fetched && fetched.state === 'errored') {
            /* The provider says this lane FAILED. It has no diff for the same
               reason a task that found nothing has no diff, and telling those
               two apart is the whole point: one is an answer about the code,
               the other is an answer about the run. */
            record = { verdict: 'ERRORED', files: [], note: String(fetched.detail || 'the provider reports this task as failed').slice(0, 200) };
          } else {
            const diffText = fetched && typeof fetched.diff === 'string' ? fetched.diff : '';
            if (diffText.trim()) fsImpl.writeFileSync(path.join(outDir, `${slug}.diff`), diffText);
            record = grade(diffText, task.target);
          }
          break;
        } catch (error) {
          const message = String((error && error.message) || error);
          const throttled = /\b429\b|Too Many Requests/i.test(message);
          if (throttled && attempt < retryDelaysMs.length) {
            await sleep(retryDelaysMs[attempt]);
            continue;
          }
          record = {
            verdict: throttled ? 'THROTTLED' : 'FETCH_ERROR',
            files: [],
            note: message.slice(0, 200)
          };
          break;
        }
      }
      /* THE TASK'S OWN PAGE, ON EVERY ROW, BECAUSE THE CLI CANNOT SAY WHY.
       *
       * When a task fails, `cloud status` gives a bracket state, `cloud diff`
       * gives "No diff available", and get_task_details 429s under harvest
       * load. The provider's actual error text is readable only on the task's
       * web page. Three waves failed 66/66, 8/8 and 73/73 and cost two
       * sessions a bisect to explain, with the reason sitting one click away
       * the whole time and neither of them holding the link.
       *
       * It rides on EVERY row rather than only the failures: a row whose
       * verdict is disputed later needs the same page, and a URL that is only
       * present when something went wrong is missing exactly when somebody
       * doubts a verdict that looks fine. */
      manifest.push({
        index: task.index,
        taskId: task.taskId,
        account: task.account,
        target: task.target,
        url: `https://chatgpt.com/codex/tasks/${task.taskId}`,
        ...record,
      });
    }
  });
  await Promise.all(workers);
  manifest.sort((a, b) => a.index - b.index);
  const tally = {};
  for (const row of manifest) tally[row.verdict] = (tally[row.verdict] || 0) + 1;
  const manifestFile = path.join(outDir, 'manifest.json');

  /* A SECOND HARVEST MUST NOT LOSE WHAT THE FIRST ESTABLISHED.
   *
   * Re-harvesting is the documented way to collect a THROTTLED task, and it
   * used to overwrite the manifest wholesale. Measured on wave 6: the first
   * pass collected 107 IN_FENCE with 14 throttled, and the re-run -- against a
   * busier provider -- wrote back 99 IN_FENCE and 22 throttled. The re-run
   * intended to ADD eight answers and instead subtracted eight, because a
   * throttle is not an answer about the task and was allowed to replace one.
   * The .diff files were still on disk the whole time; only the manifest, the
   * thing a stacker reads, had forgotten them.
   *
   * So a definite verdict is never replaced by a non-answer. This is the
   * could-not-read-collapsed-into-an-absent-answer defect that this codebase
   * names everywhere else, appearing in the harvester that grades it. */
  const SETTLED = new Set(['IN_FENCE', 'NEAR_FENCE', 'OUT_OF_FENCE', 'NO_DIFF']);
  let previous = [];
  try {
    previous = JSON.parse(fsImpl.readFileSync(manifestFile, 'utf8')).tasks || [];
  } catch { previous = []; /* no prior manifest, or an unreadable one: this pass is the whole truth */ }
  if (previous.length > 0) {
    const settledBefore = new Map(previous.filter((row) => SETTLED.has(row.verdict)).map((row) => [row.index, row]));
    for (let i = 0; i < manifest.length; i += 1) {
      const kept = settledBefore.get(manifest[i].index);
      /* The PREVIOUS verdict, but THIS row's url: a manifest written before
         the url existed would otherwise drop it every time an answer was
         restored, so the rows that most need a link to the task page -- the
         ones that have been through more than one pass -- would be the ones
         without it. */
      if (kept && !SETTLED.has(manifest[i].verdict)) manifest[i] = { ...kept, url: manifest[i].url };
    }
  }

  /* THE DIFF ON DISK OUTRANKS BOTH MANIFESTS.
   *
   * Merging manifest-to-manifest recovers an answer the PREVIOUS manifest
   * still held, and recovers nothing when both passes recorded a non-answer
   * while the .diff file sat on disk the whole time -- which is the state a
   * wave harvested before the merge fix is left in. Measured on wave 7: 139
   * diffs on disk against a manifest crediting 136.
   *
   * A manifest is a CLAIM; the diff is the ARTIFACT. So a row still carrying a
   * non-answer is checked against the artifact, and graded from it if it is
   * there. This cannot invent an answer: it only reads a file the harvester
   * itself wrote, through the same grade() every other verdict comes from. */
  for (let i = 0; i < manifest.length; i += 1) {
    if (SETTLED.has(manifest[i].verdict)) continue;
    const row = manifest[i];
    const slug = `${String(row.index).padStart(3, '0')}-${path.basename(row.target || 'unknown').replace(/[^\w.-]/g, '_')}`;
    const diffPath = path.join(outDir, `${slug}.diff`);
    let diffText = '';
    try { diffText = fsImpl.readFileSync(diffPath, 'utf8'); } catch { continue; /* no artifact: the non-answer stands */ }
    if (!diffText.trim()) continue;
    manifest[i] = { ...row, ...grade(diffText, row.target), note: `recovered from the diff on disk; the manifest had recorded ${row.verdict}` };
  }

  if (previous.length > 0 || manifest.some((row) => /recovered from the diff on disk/.test(row.note || ''))) {
    // The tally is recomputed from the merged rows; a stale tally beside merged
    // rows would be a third account of the same wave.
    for (const key of Object.keys(tally)) delete tally[key];
    for (const row of manifest) tally[row.verdict] = (tally[row.verdict] || 0) + 1;
  }

  /* WHAT THIS HARVEST DID NOT VERIFY, SAID OUT LOUD.
   *
   * batch-target.js seals { branch, mutationSample } and openBatch writes them
   * into the journal's admitted header, so every wave is admitted under a
   * stated verification bar. Nothing here performed it -- readWave did not even
   * parse that header until today -- and the seal is EVIDENCE-SHAPED: a reader
   * sees a declared sample and reasonably concludes one ran. Two lanes offered
   * branches tonight believing the pipeline carried that check.
   *
   * The sampler is not built yet. Until it is, the manifest STATES the gap
   * rather than leaving silence to be read as a pass -- the same principle the
   * mirror's visibility check was just fixed under: a check that names its own
   * blind spot is far harder to wave past than one that says nothing. */
  const declaredSpec = (wave && wave.declared) || null;
  const verification = {
    declaredBranch: declaredSpec && declaredSpec.branch ? declaredSpec.branch : null,
    declaredMutationSample: declaredSpec && Number.isInteger(declaredSpec.mutationSample)
      ? declaredSpec.mutationSample : null,
    mutationSamplePerformed: 0,
    mutationSampleReason: declaredSpec
      ? 'NOT PERFORMED. This wave was admitted under a mutation-sample bar that the harvester does not yet run. Treat these diffs as UNSAMPLED: nothing here has checked that a landed test fails when the behaviour it covers is broken.'
      : 'NOT DECLARED. This journal carries no admitted header with a harvest spec, so no sample was promised and none was run.'
  };

  fsImpl.writeFileSync(manifestFile, `${JSON.stringify({ journalFile, tally, verification, tasks: manifest }, null, 1)}\n`);

  return { manifestFile, tally, verification, taskCount: manifest.length };
}

module.exports = Object.freeze({ harvestBatch, grade, readWave, filesOf });
