#!/usr/bin/env node
'use strict';

// R1190: review depth is set by measured lane quality, not by impression.
//
// The drift this exists to stop runs in both directions. Reviewing every diff
// forever is waste once a lane is reliably good; relaxing because reviewing is
// tedious is how an unreviewed regression lands. So the rate is recorded per
// outcome and the depth is derived from it -- a coordinator can read the
// recommendation but cannot quietly grant itself a lighter one.
//
//   node tools/lane-quality.js record --lane <name> --tier <tier> --verdict accept|accept-partial|reject --note "..."
//   node tools/lane-quality.js status [--tier <tier>]
//
// Outcomes live in reports/lane-quality.json (tracked, not state/, because an
// ignored file is evidence that disappears).

const fs = require('node:fs');
const path = require('node:path');

const LEDGER = path.resolve(__dirname, '..', 'reports', 'lane-quality.json');
const VERDICTS = Object.freeze(['accept', 'accept-partial', 'reject']);
// A rolling window, because "consistently good" is a claim about recent work.
// A lane that was excellent last week and broke twice today is not good now.
const WINDOW = 12;
const MIN_SAMPLE = 6;

// Depth tiers, weakest evidence to strongest. Below MIN_SAMPLE there is no
// evidence at all, so the answer is FULL -- an unmeasured lane is not a good
// lane, it is an unknown one.
const DEPTH = Object.freeze({
  FULL: 'full-adversarial: independent reviewer reads every hunk against the live source, defaults to reject',
  TARGETED: 'targeted: independent review of security-, auth-, audit-, or spawn-touching diffs; spot-check one in three of the rest',
  SPOT: 'spot-check: accept on a passing acceptance test plus a scan of the diff stat; escalate anything touching a safety surface'
});

function fail(message) { process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n'); process.exit(1); }

function load() {
  let contents;
  try { contents = fs.readFileSync(LEDGER, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, outcomes: [] };
    fail(`lane-quality ledger is unreadable: ${error.message}`);
  }

  let ledger;
  try { ledger = JSON.parse(contents); }
  catch (error) { fail(`lane-quality ledger is unreadable: ${error.message}`); }

  if (!ledger || ledger.schemaVersion !== 1 || !Array.isArray(ledger.outcomes)) {
    fail('lane-quality ledger must have schemaVersion 1 and an outcomes array');
  }
  for (const [index, entry] of ledger.outcomes.entries()) {
    if (!entry || typeof entry.lane !== 'string' || typeof entry.tier !== 'string' || !VERDICTS.includes(entry.verdict)) {
      fail(`lane-quality ledger outcome ${index} has an invalid lane, tier, or verdict`);
    }
  }
  return ledger;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (typeof rest[i] !== 'string' || !rest[i].startsWith('--')) fail(`expected a --flag, got '${rest[i]}'`);
    if (rest[i + 1] === undefined) fail(`flag ${rest[i]} requires a value`);
    options[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, options };
}

// Weighted: a partial accept is real work that still cost a reviewer a
// correction, so it counts as half. Counting it as a pass would let a lane that
// always needs fixing read as "consistently good".
function score(outcomes) {
  const weight = { accept: 1, 'accept-partial': 0.5, reject: 0 };
  const total = outcomes.reduce((sum, entry) => sum + weight[entry.verdict], 0);
  return outcomes.length === 0 ? null : total / outcomes.length;
}

function recommend(rate, sample) {
  if (sample < MIN_SAMPLE) return { depth: 'FULL', why: `only ${sample} of ${MIN_SAMPLE} sampled outcomes -- unmeasured is not the same as good` };
  if (rate >= 0.9) return { depth: 'SPOT', why: `${(rate * 100).toFixed(0)}% weighted acceptance over the last ${sample}` };
  if (rate >= 0.7) return { depth: 'TARGETED', why: `${(rate * 100).toFixed(0)}% weighted acceptance over the last ${sample}` };
  return { depth: 'FULL', why: `${(rate * 100).toFixed(0)}% weighted acceptance over the last ${sample} -- below the relax threshold` };
}

function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  const ledger = load();

  if (command === 'record') {
    for (const required of ['lane', 'tier', 'verdict']) {
      if (!options[required]) fail(`record requires --${required}`);
    }
    if (!VERDICTS.includes(options.verdict)) fail(`--verdict must be one of: ${VERDICTS.join(', ')}`);
    const entry = {
      lane: options.lane,
      tier: options.tier,
      verdict: options.verdict,
      note: options.note || '',
      reviewedBy: options['reviewed-by'] || 'unrecorded',
      at: new Date().toISOString()
    };
    ledger.outcomes.push(entry);
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ ok: true, recorded: entry, total: ledger.outcomes.length }) + '\n');
    return;
  }

  if (command === 'status') {
    const scoped = options.tier ? ledger.outcomes.filter(entry => entry.tier === options.tier) : ledger.outcomes;
    const recent = scoped.slice(-WINDOW);
    const rate = score(recent);
    const advice = recommend(rate === null ? 0 : rate, recent.length);
    const counts = VERDICTS.reduce((acc, verdict) => {
      acc[verdict] = recent.filter(entry => entry.verdict === verdict).length;
      return acc;
    }, {});
    process.stdout.write(JSON.stringify({
      ok: true,
      tier: options.tier || 'all',
      sampled: recent.length,
      windowSize: WINDOW,
      weightedAcceptance: rate === null ? null : Number(rate.toFixed(3)),
      counts,
      reviewDepth: advice.depth,
      reviewMeaning: DEPTH[advice.depth],
      why: advice.why
    }) + '\n');
    return;
  }

  fail(`unknown command '${command || ''}'. Use: record, status.`);
}

main();
