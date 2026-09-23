#!/usr/bin/env node
'use strict';

// WHICH IDIOMS DOES THE FACTORISATION ACTUALLY FAIL TO REACH?
//
//   node tools/prune-phrases.js            report
//   node tools/prune-phrases.js --write    rewrite config/phrases.json
//
// It reads THIS checkout's registry unless --engine-root names another one.
//
// The residual phrase table is the one place hand-authored intent survives,
// and it is exactly the thing that rots. So it is not asserted, it is
// MEASURED: every candidate phrase is run against an index built WITHOUT the
// phrase table, and kept only if the factored vocabulary cannot already find
// its tools. Everything else is deleted.
//
// That makes the file self-limiting in the direction that matters. It can only
// grow by an idiom the structure demonstrably cannot express, and re-running
// this after any vocabulary change deletes whatever the new words made
// redundant. A phrase that survives is evidence about the factorisation's
// blind spots, not a maintenance burden someone took on.
//
// The candidate pool is config/capability-aliases.json -- the retired
// enumerated lexicon. Those 686 phrases were written against real prompts and
// are the best available source of "things people say"; this tool is how they
// are triaged into the few that are still load-bearing.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { build } = require('./build-capability-index');
const { rank } = require('../src/lib/capability-recall/score');
const { normalizePhrase } = require('../src/lib/capability-recall/text');

const KEEP_AT = 3;

function parseArguments(argv) {
  const args = argv.slice(2);
  const options = {
    engineRoot: process.env.TOOLSENABLED_ENGINE_ROOT || ROOT,
    write: args.includes('--write'),
    verbose: args.includes('--verbose'),
  };
  const at = args.indexOf('--engine-root');
  if (at >= 0) options.engineRoot = args[at + 1];
  return options;
}

/** Candidate idioms from the retired lexicon: multi-word only, deduplicated. */
function candidates(engineRoot = ROOT) {
  const retired = path.join(engineRoot, 'config', 'capability-aliases.json');
  const raw = JSON.parse(fs.readFileSync(retired, 'utf8'));
  const seen = new Map();
  for (const entry of raw.entries || []) {
    for (const said of [...(entry.words || []), ...(entry.phrases || [])]) {
      const normalised = normalizePhrase(said);
      if (!normalised || normalised.split(' ').length < 2) continue;
      if (!seen.has(normalised)) seen.set(normalised, new Set());
      for (const id of entry.tools || []) seen.get(normalised).add(id);
    }
  }
  return [...seen.entries()].map(([phrase, tools]) => ({ phrase, tools: [...tools] }));
}

function main(argv) {
  const options = parseArguments(argv);
  if (!options.engineRoot) {
    process.stderr.write('prune-phrases: --engine-root is required (or set TOOLSENABLED_ENGINE_ROOT).\n');
    process.exitCode = 2;
    return;
  }
  const engineRoot = path.resolve(options.engineRoot);
  const config = name => path.join(engineRoot, 'config', name);

  /* The index WITHOUT any residual, which is the thing being tested. */
  /* Rebuilt with an EMPTY residual regardless of what is on disk, so a second
   * run cannot judge the phrases against an index that already contains them. */
  const emptyResidual = path.join(engineRoot, 'scratch', '.phrases-empty.json');
  fs.mkdirSync(path.dirname(emptyResidual), { recursive: true });
  fs.writeFileSync(emptyResidual, JSON.stringify({ schemaVersion: 'capability-phrases-v1', entries: [] }));
  const bare = build({
    engineRoot,
    actions: config('actions.json'),
    objects: config('objects.json'),
    phrases: emptyResidual,
    withPacks: false,
    constants: null,
  }).artifact;
  fs.unlinkSync(emptyResidual);

  /* Keep every id in one namespace. Previously --engine-root loaded documents
   * from the named checkout but candidates and vocabularies from this checkout,
   * so version-skewed ids silently became the definite answer "stale". */
  const pool = candidates(engineRoot);
  const known = new Set(bare.docs.map(document => document.id));
  const keep = [];
  const drop = [];
  const stale = [];

  for (const candidate of pool) {
    const wanted = candidate.tools.filter(id => known.has(id));
    if (!wanted.length) { stale.push(candidate.phrase); continue; }
    /* AT THE REAL FLOOR, NOT AT ZERO.
     *
     * This tested with floor 0 and deleted 365 phrases as "already reachable".
     * They were reachable in the sense of appearing in a ranked list -- and
     * unreachable in the sense that matters, because at the floor the auto
     * block actually uses, those same tools were never returned. The test has
     * to be the question the product asks: would this phrase's tools be
     * RECOMMENDED without it? */
    const found = rank(bare, candidate.phrase, { floor: bare.constants.floorAuto, limit: KEEP_AT });
    const reached = found.results.some(result => wanted.includes(result.id));
    (reached ? drop : keep).push({ ...candidate, tools: wanted, got: found.results.map(r => r.id) });
  }

  if (drop.length + keep.length === 0) {
    throw new Error(
      `refusing to report or write a residual: none of ${pool.length} candidate idiom(s) named a tool in the measured registry`
    );
  }

  const absorbed = drop.length / (drop.length + keep.length || 1);
  process.stdout.write(
    `candidate idioms from the retired lexicon: ${pool.length}\n`
    + `  already reachable without them (deleted): ${drop.length}  (${(absorbed * 100).toFixed(1)}% absorbed by the factorisation)\n`
    + `  still needed (the real residual):         ${keep.length}\n`
    + `  naming tools that no longer exist:        ${stale.length}\n`
  );

  if (options.verbose) {
    process.stdout.write('\nSTILL NEEDED — what the action x object structure cannot reach:\n');
    for (const item of keep.slice(0, 40)) {
      process.stdout.write(`  "${item.phrase}" -> ${item.tools.join(', ')}   (got: ${item.got.join(', ') || 'nothing'})\n`);
    }
  }

  if (!options.write) {
    process.stdout.write('\n(--write to rewrite config/phrases.json with the survivors)\n');
    return;
  }

  const byTools = new Map();
  for (const item of keep) {
    const key = item.tools.slice().sort().join('|');
    if (!byTools.has(key)) byTools.set(key, { tools: item.tools.slice().sort(), says: [] });
    byTools.get(key).says.push(item.phrase);
  }
  const phrases = config('phrases.json');
  const existing = JSON.parse(fs.readFileSync(phrases, 'utf8'));
  existing.entries = [...byTools.values()].sort((a, b) => a.tools[0].localeCompare(b.tools[0]));
  existing.$measured = {
    candidates: pool.length,
    absorbedByFactorisation: drop.length,
    keptAsResidual: keep.length,
    testedAt: `top-${KEEP_AT} at the real auto floor, against an index rebuilt with an empty residual`,
  };
  fs.writeFileSync(phrases, `${JSON.stringify(existing, null, 2)}\n`);
  process.stdout.write(`\nwrote ${phrases} with ${existing.entries.length} entries / ${keep.length} phrases\n`);
}

if (require.main === module) main(process.argv);

module.exports = Object.freeze({ candidates });
