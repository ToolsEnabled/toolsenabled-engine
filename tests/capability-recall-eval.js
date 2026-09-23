/* EXECUTABLE CHANGE — testcanfail-tests-capability-recall-eval-js
 *
 * Mutation evidence:
 * - Replaced capability-recall-fresh.jsonl with a metadata-only file. Before
 *   this change the ratchet stayed green: "RATCHET ok — no headline metric
 *   regressed beyond tolerance." After this change it is rejected with:
 *   "EVALUATION REFUSED — fresh set has no positive cases"
 * - Replaced capability-recall-ratchet.json with `{}`. Before this change the
 *   ratchet stayed green with the same "RATCHET ok" output. After this change
 *   it is rejected with: "RATCHET REFUSED — ... must contain a finite numeric
 *   recall3"
 * - Restored both mutated fixtures byte-for-byte (SHA-256 respectively
 *   028345480b18ed8a6ab35db1695f3ea4b38daa9a19a2af1623a1c5172d3afbed and
 *   90dadf901fa03807349ca846994dedcee62a192956c0aa6f7c6bc5e55b4ea9e5).
 *
 * Shape census: (1) FIXED empty positive/negative evaluation collections;
 * (2) NOT-FOUND exit-status/truthy-return assertions; (3) NOT-FOUND swallowed
 * failures (the ratchet JSON catch is an explicit refusal); (4) NOT-FOUND
 * mocks; (5) NOT-FOUND skips/platform guards; (6) NOT-FOUND expectations
 * computed by the implementation under evaluation. Preconditions met: Node,
 * artifact, gold/fresh fixtures, and tracked ratchet fixture were available.
 */
'use strict';

// MEASURE THE RECOMMENDER, THEN TUNE IT, AND NEVER ON THE SAME CASES.
//
//   node tests/capability-recall-eval.js            report on the shipped constants
//   node tests/capability-recall-eval.js --tune     search, report, write tuned constants
//   node tests/capability-recall-eval.js --ratchet  fail if any headline metric regressed
//
// THE RESEARCH RAG THIS DESIGN LEARNED FROM REFUSED THIS STEP ON PURPOSE:
// lean_rag/ROSLYN_DATASTORE_SPEC.md says "Do NOT optimize retrieval... Build it,
// freeze it, sanity-check it, never touch it again", because there it is a
// controlled instrument and tuning it would be a confound. Here it is a
// product feature and NOT tuning it is the defect.
//
// FOUR NUMBERS, AND THE FOURTH IS THE ONE NOBODY MEASURES.
//
//   recall@3    did the right tool make the three-slot auto block?
//   recall@10   did it make the ten-slot answer to an explicit query?
//   mrr         how far down was it?
//   falsePositive  ON PROMPTS THAT DESERVE SILENCE, how often did we speak?
//
// tools/grepsaver-orient.js had the first three in spirit and not the fourth,
// and its own comments record the result: "'gmail thread read' returned
// openclaw-gateway + portfolio-dashboard + servercontrol". A recommender is
// judged on what it says when it has nothing to say.
//
// HELD-OUT SPLIT, BECAUSE 85 POSITIVES AND 12 KNOBS IS AN OVERFITTING MACHINE.
// Every third case is withheld from tuning and reported separately. If TRAIN
// and HELD-OUT diverge, the tuner has memorised the gold set and the numbers
// are worth nothing -- so both are always printed, side by side, whether they
// agree or not.

const fs = require('node:fs');
const path = require('node:path');

const { loadFrom } = require('../src/lib/capability-recall/artifact');
const { rank } = require('../src/lib/capability-recall/score');

const ROOT = path.resolve(__dirname, '..');
const GOLD = path.join(ROOT, 'tests', 'fixtures', 'capability-recall-gold.jsonl');
const FRESH = path.join(ROOT, 'tests', 'fixtures', 'capability-recall-fresh.jsonl');
const ARTIFACT = path.join(ROOT, 'config', 'capability-index.json');
const TUNED_OUT = path.join(ROOT, 'scratch', 'capability-recall-tuned-constants.json');
const RATCHET = path.join(ROOT, 'tests', 'fixtures', 'capability-recall-ratchet.json');

const AUTO_K = 3;
const QUERY_K = 10;

function loadCases(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim());
  const cases = [];
  for (const line of lines) {
    const parsed = JSON.parse(line);
    if (parsed.$schema || parsed.$note) continue;
    cases.push(parsed);
  }
  return cases;
}

function loadGold() { return loadCases(GOLD); }
function loadFresh() { return loadCases(FRESH); }

function requireEvaluationCoverage(label, cases) {
  if (!cases.some(entry => entry.kind !== 'negative')) {
    throw new Error(`EVALUATION REFUSED — ${label} has no positive cases`);
  }
  if (!cases.some(entry => entry.kind === 'negative')) {
    throw new Error(`EVALUATION REFUSED — ${label} has no negative cases`);
  }
}

/* Deterministic split. Every third case is held out -- no shuffle, no seed, no
 * clock, so two runs on the same file always split the same way and a metric
 * can be compared across runs. */
function split(cases) {
  const train = [];
  const held = [];
  cases.forEach((entry, index) => { (index % 3 === 2 ? held : train).push(entry); });
  return { train, held };
}

function dcg(gains) {
  return gains.reduce((total, gain, position) => total + gain / Math.log2(position + 2), 0);
}

/**
 * Score one set of cases with one set of constants.
 *
 * Positives and negatives are measured by different questions, so they are
 * kept apart all the way through rather than averaged into one number that
 * hides which half is failing.
 */
function evaluate(artifact, constants, cases) {
  const positives = cases.filter(entry => entry.kind !== 'negative');
  const negatives = cases.filter(entry => entry.kind === 'negative');

  let hit3 = 0;
  let hit10 = 0;
  let reciprocal = 0;
  let ndcgTotal = 0;
  let noiseSlots = 0;
  let filledSlots = 0;
  const misses = [];

  for (const entry of positives) {
    const want = new Set(entry.want || []);
    const okay = new Set(entry.ok || []);
    const auto = rank(artifact, entry.q, { floor: constants.floorAuto, limit: AUTO_K, constants });
    const query = rank(artifact, entry.q, { floor: constants.floorQuery, limit: QUERY_K, constants });

    const autoIds = auto.results.map(result => result.id);
    const queryIds = query.results.map(result => result.id);

    const in3 = autoIds.some(id => want.has(id));
    const in10 = queryIds.some(id => want.has(id));
    if (in3) hit3 += 1;
    if (in10) hit10 += 1;

    const first = queryIds.findIndex(id => want.has(id));
    if (first >= 0) reciprocal += 1 / (first + 1);

    const gains = queryIds.map(id => (want.has(id) ? 1 : okay.has(id) ? 0.4 : 0));
    const ideal = [...want].map(() => 1).concat([...okay].map(() => 0.4)).slice(0, QUERY_K);
    const idealDcg = dcg(ideal);
    if (idealDcg > 0) ndcgTotal += dcg(gains) / idealDcg;

    for (const id of autoIds) {
      filledSlots += 1;
      if (!want.has(id) && !okay.has(id)) noiseSlots += 1;
    }
    if (!in3) {
      misses.push({
        q: entry.q,
        want: [...want],
        lex: entry.lex !== false,
        got: autoIds,
        best: auto.bestRejected ? `${auto.bestRejected.id}@${auto.bestRejected.score.toFixed(3)}` : null,
        reason: auto.reason,
      });
    }
  }

  let spoke = 0;
  const falsePositives = [];
  /* MARGIN, NOT JUST THE COUNT.
   *
   * Counting false positives tells the tuner nothing about HOW CLOSE the
   * silent ones came. Measured: a configuration with zero false positives on
   * the tuning negatives produced 14% on the held-out ones, because the floor
   * had been tuned down until every training negative sat a thousandth below
   * it. Margin -- how far the best negative fell short of the floor, averaged
   * -- is the quantity that actually generalises, so the objective climbs that
   * instead. */
  let marginTotal = 0;
  for (const entry of negatives) {
    const auto = rank(artifact, entry.q, { floor: constants.floorAuto, limit: AUTO_K, constants });
    if (auto.results.length > 0) {
      spoke += 1;
      falsePositives.push({ q: entry.q, got: auto.results.map(result => `${result.id}@${result.score.toFixed(3)}`) });
      marginTotal += Math.max(-0.3, constants.floorAuto - auto.results[0].score);
    } else {
      const best = auto.bestRejected ? auto.bestRejected.score : 0;
      marginTotal += Math.min(0.3, constants.floorAuto - best);
    }
  }

  const positiveCount = positives.length || 1;
  return {
    positives: positives.length,
    negatives: negatives.length,
    recall3: hit3 / positiveCount,
    recall10: hit10 / positiveCount,
    mrr: reciprocal / positiveCount,
    ndcg10: ndcgTotal / positiveCount,
    falsePositive: negatives.length ? spoke / negatives.length : 0,
    silenceMargin: negatives.length ? marginTotal / negatives.length : 0,
    noiseRate: filledSlots ? noiseSlots / filledSlots : 0,
    misses,
    falsePositives,
  };
}

/* One number for the search to climb.
 *
 * recall@3 dominates because the three-slot auto block is the feature; silence
 * on the negatives is weighted almost as heavily because speaking wrongly is
 * the failure that makes people stop reading the block at all. A configuration
 * that talks over more than one negative in twenty is rejected outright rather
 * than traded against recall -- some things are not currency. */
const MAX_ACCEPTABLE_FALSE_POSITIVE = 0.05;

function objective(metrics) {
  if (metrics.falsePositive > MAX_ACCEPTABLE_FALSE_POSITIVE) return -1;
  return (
    0.40 * metrics.recall3
    + 0.18 * metrics.mrr
    + 0.12 * metrics.ndcg10
    + 0.08 * metrics.recall10
    + 0.07 * (1 - metrics.noiseRate)
    /* Scaled so a full 0.3 margin is worth 0.15 -- more than a third of what
     * recall@3 can pay. Silence has to be able to outbid recall, or the search
     * will always sell it. */
    + 0.50 * Math.max(0, metrics.silenceMargin)
  );
}

/* The search space. Coarse on purpose, and deliberately SMALL.
 *
 * It began with twelve knobs including the four bm25 length-normalisation
 * terms (b.identity, b.title, b.body, b.alias). Measured: the tuner gained 16
 * points of recall@3 on the tuning set and 7 on the held-out set, a gap of
 * 18.4 points, and pushed held-out false positives from 0% to 14%. That is the
 * definition of memorising 70 examples. The four b terms moved least and cost
 * four dimensions, so they are fixed at their defaults and the search is left
 * with the eight knobs that carry real behaviour. */
const GRID = Object.freeze({
  'weights.identity': [4, 6, 8, 10, 12],
  'weights.title': [1, 2, 3, 4, 6],
  'weights.body': [0.3, 0.5, 1, 1.5],
  'weights.alias': [2, 4, 6, 8, 10],
  stemDiscount: [0.3, 0.45, 0.55, 0.7, 0.85],
  commonFraction: [0.1, 0.2, 0.3, 0.4],
  strongTermFraction: [0.008, 0.015, 0.025, 0.04, 0.06],
  priorMass: [0, 3, 6, 9, 12, 16],
  absentWeight: [0.15, 0.25, 0.35, 0.45, 0.6, 0.8, 1],
  focusTerms: [4, 6, 8, 10, 14, 99],
  maxAbsentMass: [2, 4, 6, 8, 12, 99],
  phraseBoost: [0.1, 0.2, 0.3, 0.4, 0.5],
  floorAuto: [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6],
  floorQuery: [0.12, 0.18, 0.24, 0.3, 0.36],
});

function getAt(constants, key) {
  const [head, tail] = key.split('.');
  return tail === undefined ? constants[head] : constants[head][tail];
}

function setAt(constants, key, value) {
  const [head, tail] = key.split('.');
  const next = { ...constants, weights: { ...constants.weights }, b: { ...constants.b } };
  if (tail === undefined) next[head] = value;
  else next[head][tail] = value;
  return next;
}

/**
 * Coordinate descent with repeated sweeps.
 *
 * Not a global optimiser and not pretending to be. It is the right shape for a
 * space this small with an objective this cheap, it is deterministic, and it
 * stops when a whole sweep changes nothing -- so the result is reproducible
 * from the gold file alone.
 */
function tune(artifact, trainCases, startConstants, { sweeps = 5, onProgress } = {}) {
  let best = { ...startConstants, weights: { ...startConstants.weights }, b: { ...startConstants.b } };
  let bestScore = objective(evaluate(artifact, best, trainCases));
  let evaluations = 1;

  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    let improved = false;
    for (const key of Object.keys(GRID)) {
      const current = getAt(best, key);
      for (const value of GRID[key]) {
        if (value === current) continue;
        const candidate = setAt(best, key, value);
        const candidateScore = objective(evaluate(artifact, candidate, trainCases));
        evaluations += 1;
        if (candidateScore > bestScore + 1e-9) {
          best = candidate;
          bestScore = candidateScore;
          improved = true;
        }
      }
    }
    if (onProgress) onProgress({ sweep: sweep + 1, bestScore, evaluations });
    if (!improved) break;
  }
  return { constants: best, score: bestScore, evaluations };
}

/* ------------------------------------------------------------------ report */

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function metricLine(label, metrics) {
  return `${label.padEnd(14)} recall@3 ${percent(metrics.recall3).padStart(6)}   `
    + `recall@10 ${percent(metrics.recall10).padStart(6)}   `
    + `MRR ${metrics.mrr.toFixed(3)}   `
    + `nDCG@10 ${metrics.ndcg10.toFixed(3)}   `
    + `noise@3 ${percent(metrics.noiseRate).padStart(6)}   `
    + `false-positive ${percent(metrics.falsePositive).padStart(6)}   `
    + `silence-margin ${metrics.silenceMargin >= 0 ? '+' : ''}${metrics.silenceMargin.toFixed(3)}`;
}

function timing(artifact, constants, cases) {
  const samples = [];
  for (let round = 0; round < 5; round += 1) {
    for (const entry of cases) {
      const started = process.hrtime.bigint();
      rank(artifact, entry.q, { floor: constants.floorAuto, limit: AUTO_K, constants });
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
  }
  samples.sort((a, b) => a - b);
  return {
    calls: samples.length,
    p50: samples[Math.floor(samples.length * 0.5)],
    p99: samples[Math.floor(samples.length * 0.99)],
    max: samples[samples.length - 1],
  };
}

function main(argv) {
  const wantTune = argv.includes('--tune');
  const wantRatchet = argv.includes('--ratchet');
  const verbose = argv.includes('--verbose');

  /* TIME THE FIRST LOAD, WHICH IS THE ONE ANYBODY PAYS. This used to time a
   * SECOND loadFrom() call, back when loadFrom() re-read and re-parsed the whole
   * artifact every time and the two numbers were the same. loadFrom() is now
   * memoised on the artifact's content digest, so timing the second call would
   * report the memo hit -- about 0.05 ms -- under a line that says "artifact
   * load". A cost line that reports a cache hit as the cost is worse than no
   * cost line. */
  const loadStart = process.hrtime.bigint();
  const artifact = loadFrom(ARTIFACT);
  const loadMs = Number(process.hrtime.bigint() - loadStart) / 1e6;

  const cases = loadGold();
  requireEvaluationCoverage('gold set', cases);
  const { train, held } = split(cases);

  const shipped = artifact.constants;

  console.log('CAPABILITY RECALL — EVALUATION');
  console.log('='.repeat(112));
  console.log(`corpus        ${artifact.N} tools, ${Object.keys(artifact.df).length} terms, `
    + `${fs.statSync(ARTIFACT).size} bytes on disk`);
  console.log(`gold set      ${cases.length} cases: ${cases.filter(c => c.kind !== 'negative').length} positive, `
    + `${cases.filter(c => c.kind === 'negative').length} negative `
    + `(${cases.filter(c => c.lex === false).length} positives phrased outside the lexicon)`);
  console.log(`split         ${train.length} tuning / ${held.length} held out (every third case, deterministic)`);
  console.log('');

  const baseAll = evaluate(artifact, shipped, cases);
  const baseTrain = evaluate(artifact, shipped, train);
  const baseHeld = evaluate(artifact, shipped, held);
  console.log('SHIPPED CONSTANTS — gold set');
  console.log(metricLine('  all', baseAll));
  console.log(metricLine('  tuning set', baseTrain));
  console.log(metricLine('  held out', baseHeld));

  /* THE NUMBER THAT ACTUALLY MEANS SOMETHING.
   *
   * The gold set above drove the lexicon: every miss it reported became an
   * alias line, so its recall is partly a measure of that loop closing on
   * itself. It now reads 100%, which should be treated as a saturated
   * instrument rather than as a result. The fresh set was written after the
   * lexicon and the constants were finished, was never used to tune either,
   * and no alias may be added because of it. It is the only honest estimate of
   * what happens to wording nobody anticipated. */
  const fresh = loadFresh();
  requireEvaluationCoverage('fresh set', fresh);
  const freshMetrics = evaluate(artifact, shipped, fresh);
  console.log('');
  console.log(`FRESH SET — ${fresh.length} prompts written after tuning, never used to tune anything`);
  console.log(metricLine('  fresh', freshMetrics));

  let finalConstants = shipped;
  let finalAll = baseAll;

  if (wantTune) {
    console.log('');
    console.log('TUNING (coordinate descent on the tuning set only)');
    const result = tune(artifact, train, shipped, {
      onProgress: ({ sweep, bestScore, evaluations }) => {
        console.log(`  sweep ${sweep}: objective ${bestScore.toFixed(4)} after ${evaluations} evaluations`);
      },
    });
    const tunedAll = evaluate(artifact, result.constants, cases);
    const tunedTrain = evaluate(artifact, result.constants, train);
    const tunedHeld = evaluate(artifact, result.constants, held);
    console.log('');
    console.log('TUNED CONSTANTS');
    console.log(metricLine('  all', tunedAll));
    console.log(metricLine('  tuning set', tunedTrain));
    console.log(metricLine('  held out', tunedHeld));
    const gap = tunedTrain.recall3 - tunedHeld.recall3;
    console.log('');
    console.log(`  overfitting check: recall@3 tuning ${percent(tunedTrain.recall3)} vs held out `
      + `${percent(tunedHeld.recall3)} — gap ${(gap * 100).toFixed(1)} points`
      + `${Math.abs(gap) > 0.15 ? '  ** WIDE: treat the tuned numbers with suspicion **' : ''}`);
    fs.mkdirSync(path.dirname(TUNED_OUT), { recursive: true });
    fs.writeFileSync(TUNED_OUT, `${JSON.stringify(result.constants, null, 2)}\n`);
    console.log(`  wrote ${TUNED_OUT} — rebuild with --constants to adopt.`);
    finalConstants = result.constants;
    finalAll = tunedAll;
  }

  const speed = timing(artifact, finalConstants, cases);
  console.log('');
  console.log('COST');
  console.log(`  artifact load   ${loadMs.toFixed(1)} ms (once per process, then shared frozen)`);
  console.log(`  query p50       ${speed.p50.toFixed(3)} ms`);
  console.log(`  query p99       ${speed.p99.toFixed(3)} ms   (max ${speed.max.toFixed(3)} ms over ${speed.calls} calls)`);
  console.log(`  resident        ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB heap with the index loaded`);

  if (freshMetrics.falsePositives.length) {
    console.log('');
    console.log(`FRESH SET FALSE POSITIVES — spoke on ${freshMetrics.falsePositives.length} prompt(s) that deserved silence`);
    for (const item of freshMetrics.falsePositives) console.log(`  "${item.q}" -> ${item.got.join(', ')}`);
  }

  if (freshMetrics.misses.length) {
    console.log('');
    console.log(`FRESH SET MISSES — ${freshMetrics.misses.length} of ${freshMetrics.positives}. `
      + 'These are the designed failure mode: wording the lexicon does not cover. '
      + 'They are reported, not fixed -- an alias added because of this file would destroy its only purpose.');
    for (const miss of freshMetrics.misses) {
      console.log(`  "${miss.q}"`);
      console.log(`      wanted ${miss.want.join(' | ')}`);
      console.log(`      got    ${miss.got.length ? miss.got.join(', ') : `(nothing; best ${miss.best || 'none'})`}`);
    }
  }

  if (finalAll.falsePositives.length) {
    console.log('');
    console.log(`FALSE POSITIVES — spoke on ${finalAll.falsePositives.length} prompt(s) that deserved silence`);
    for (const item of finalAll.falsePositives) console.log(`  "${item.q}" -> ${item.got.join(', ')}`);
  }

  if (finalAll.misses.length) {
    console.log('');
    console.log(`MISSES — the right tool was not in the top ${AUTO_K} (${finalAll.misses.length} of ${finalAll.positives})`);
    for (const miss of finalAll.misses) {
      console.log(`  "${miss.q}"`);
      console.log(`      wanted ${miss.want.join(' | ')}${miss.lex ? '' : '   [phrased outside the lexicon]'}`);
      console.log(`      got    ${miss.got.length ? miss.got.join(', ') : `(nothing; best ${miss.best || 'none'}; ${miss.reason})`}`);
    }
  }

  if (verbose) {
    console.log('');
    console.log('CONSTANTS IN FORCE');
    console.log(JSON.stringify(finalConstants, null, 2));
  }

  if (wantRatchet) {
    /* THE FLOOR IS NEVER SEEDED FROM THE RUN BEING JUDGED.
     *
     * This used to collapse "no floor file" and "unreadable floor file" into
     * one branch that wrote the CURRENT run's metrics as the new floor and
     * exited 0 -- so deleting or corrupting the tracked ratchet file let a run
     * with any recall at all ratify itself as the standard. The file is
     * TRACKED, so on the wired path it always exists; the only ways to reach
     * that branch were the two that must refuse. check-naming.js refuses when
     * its tracked baseline is absent and check-chain-runner exits 2 on an
     * unreadable one, for the same reason: a gate that cannot read its own
     * record must not pass anything, and it especially must not write the
     * record it was about to be judged against. Re-seeding is now a separate,
     * deliberate act: --seed-floor, which still refuses to overwrite. */
    console.log('');
    if (!fs.existsSync(RATCHET)) {
      if (process.argv.includes('--seed-floor')) {
        fs.writeFileSync(RATCHET, `${JSON.stringify({
          recall3: Number(finalAll.recall3.toFixed(4)),
          recall10: Number(finalAll.recall10.toFixed(4)),
          mrr: Number(finalAll.mrr.toFixed(4)),
          falsePositive: Number(finalAll.falsePositive.toFixed(4)),
        }, null, 2)}\n`);
        console.log(`RATCHET floor seeded deliberately from this run -> ${RATCHET}`);
        return;
      }
      console.log(`RATCHET REFUSED — ${RATCHET} does not exist. That file is tracked, so its absence means it was `
        + 'deleted, not that this is a first run. Restore it from git, or pass --seed-floor to record THIS run as the '
        + 'floor deliberately. Refusing to let a run set the standard it is about to be judged against.');
      process.exitCode = 2;
      return;
    }
    let floorValues;
    try {
      floorValues = JSON.parse(fs.readFileSync(RATCHET, 'utf8'));
    } catch (error) {
      console.log(`RATCHET REFUSED — ${RATCHET} exists but cannot be read as JSON (${error.message}). `
        + 'An unreadable floor is not a missing floor: restore the file from git rather than re-seeding over it.');
      process.exitCode = 2;
      return;
    }
    for (const key of ['recall3', 'recall10', 'mrr', 'falsePositive']) {
      if (!Number.isFinite(floorValues[key])) {
        console.log(`RATCHET REFUSED — ${RATCHET} must contain a finite numeric ${key}. `
          + 'Restore the tracked floor rather than allowing an incomplete standard to pass by comparison with NaN.');
        process.exitCode = 2;
        return;
      }
    }
    const tolerance = 0.02;
    const failures = [];
    for (const key of ['recall3', 'recall10', 'mrr']) {
      if (finalAll[key] < floorValues[key] - tolerance) {
        failures.push(`${key} fell from ${floorValues[key].toFixed(3)} to ${finalAll[key].toFixed(3)}`);
      }
    }
    if (finalAll.falsePositive > floorValues.falsePositive + tolerance) {
      failures.push(`falsePositive rose from ${floorValues.falsePositive.toFixed(3)} to ${finalAll.falsePositive.toFixed(3)}`);
    }
    if (failures.length) {
      console.log(`RATCHET FAILED — ${failures.join('; ')}`);
      process.exitCode = 1;
      return;
    }
    console.log('RATCHET ok — no headline metric regressed beyond tolerance.');
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = Object.freeze({ evaluate, loadCases, loadFresh, loadGold, objective, split, tune });
