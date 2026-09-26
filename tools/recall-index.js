#!/usr/bin/env node
'use strict';

// THE INDEXING PIPELINE, AS A COMMAND YOU MAY RUN AND NEVER HAVE TO.
//
//   node tools/recall-index.js            # bring stale sources up to date
//   node tools/recall-index.js --rebuild  # discard and rebuild every source
//   node tools/recall-index.js --json
//
// WHY IT IS OPTIONAL BY DESIGN. tools/prior-work-index.js states the rule and
// the two failures behind it: "context/systems.json is a generated file that is
// committed and then silently believed forever; it reported ONE system while
// seven cards existed on disk. The search index was last really rebuilt on
// 2026-08-08 and sat at 68% coverage because a rebuild is a manual call." An
// index that is only correct after somebody remembers a command is an index
// that is usually wrong. So `recall` re-fingerprints and self-heals on every
// query, and this command exists to do that work ahead of time (at install, in
// a scheduled sweep, after a big ledger import) and to REPORT on it.
//
// IT REFUSES TO INDEX WHAT THE USER SWITCHED OFF. Building the index for a
// withheld source would copy the owner's verbatims, or the agents' notes, into
// a second store that the user's settings say must not be searched -- the
// system half-running while claiming to be off. So a withheld source is skipped
// and named, and a fully withheld surface exits 5 having touched nothing.
//
// EXIT CODES
//   0  every enabled source is indexed and current
//   2  usage
//   4  at least one enabled source could NOT be indexed (unknown, not empty)
//   5  the surface, or every source, is withheld by settings

const { SOURCES } = require('./retrieval/sources');
const { GATE_STATE, gate } = require('./retrieval/settings-gate');
const fts = require('./retrieval/fts-index');
const { loadSettings } = require('../src/lib/settings');

const INDEX_EXIT = Object.freeze({ OK: 0, USAGE: 2, UNKNOWN: 4, WITHHELD: 5 });

function parseArgv(argv) {
  const args = argv.slice(2);
  const parsed = { asJson: false, forceRebuild: false, help: false, unknown: [] };
  for (const arg of args) {
    if (arg === '--json') parsed.asJson = true;
    else if (arg === '--rebuild') parsed.forceRebuild = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else parsed.unknown.push(arg);
  }
  return parsed;
}

function buildIndex(options = {}) {
  const started = Date.now();
  const settings = options.settings || loadSettings(options.settingsOptions || {});
  const sources = options.sources || SOURCES;
  const decisions = gate({ settings, sources });

  const skipped = decisions.sources
    .filter(entry => entry.state !== GATE_STATE.ENABLED)
    .map(entry => ({ id: entry.id, state: entry.state === GATE_STATE.UNCLASSIFIED ? 'unclassified' : 'withheld', why: entry.why }));

  const enabledIndexed = decisions.sources
    .filter(entry => entry.state === GATE_STATE.ENABLED)
    .map(entry => sources.find(source => source.id === entry.id))
    .filter(source => source && source.kind === 'indexed');

  // Sources that are enabled but not stored here (docs delegates to
  // prior-work-index, which maintains itself). Named so the report cannot be
  // read as "docs was skipped".
  const delegated = decisions.sources
    .filter(entry => entry.state === GATE_STATE.ENABLED)
    .map(entry => sources.find(source => source.id === entry.id))
    .filter(source => source && source.kind !== 'indexed')
    .map(source => ({ id: source.id, delegatedTo: 'tools/prior-work-index.js (self-maintaining; nothing to build here)' }));

  if (decisions.surfaceWithheld || (!enabledIndexed.length && !delegated.length)) {
    return {
      state: 'withheld',
      why: decisions.surfaceWithheld
        ? `Unified retrieval is off (${decisions.surface.why}); no index was built and nothing was read.`
        : 'Every knowledge source is switched off; no index was built and nothing was read.',
      surface: decisions.surface,
      skipped,
      delegated,
      sources: [],
      exitCode: INDEX_EXIT.WITHHELD,
      durationMs: Date.now() - started,
    };
  }

  const store = fts.openStore(options);
  /* INJECTED, like every other collaborator in this tree, because the test that
   * pins the reconciliation below CANNOT reach it otherwise: fts-index.js
   * exports Object.freeze({...}), so assigning fts.ensureFresh from a test is
   * silently refused in non-strict mode -- the patch appears to take, the real
   * function runs, and the assertion can never hold. That is how this gate's own
   * regression test shipped permanently red. A seam makes the injection real. */
  const ensureFresh = typeof options.ensureFresh === 'function' ? options.ensureFresh : fts.ensureFresh;
  try {
    const report = enabledIndexed.length ? ensureFresh(store.db, enabledIndexed, options) : [];
    // `ensureFresh` is the accounting boundary for this gate: if it fails to
    // return a row for an enabled source, absence of that row is not evidence
    // that the source is current. Reconcile by id so a partial/empty report
    // cannot make the command exit 0 after measuring fewer sources than it was
    // asked to index.
    const reportedIds = new Set(report.map(entry => entry.id));
    for (const source of enabledIndexed) {
      if (!reportedIds.has(source.id)) {
        report.push({
          id: source.id,
          state: 'unavailable',
          code: 'SOURCE_INDEX_STATUS_MISSING',
          why: 'The index refresh returned no status for this enabled source, so its freshness was not established.',
          documentCount: 0,
          durationMs: 0,
        });
      }
    }
    const unavailable = report.filter(entry => entry.state === 'unavailable');

    return {
      state: unavailable.length ? 'incomplete' : 'current',
      why: unavailable.length
        ? `${unavailable.length} enabled source(s) could not be indexed, so a later query over them will answer UNKNOWN rather than MISS.`
        : `${report.length} indexed source(s) are current.`,
      surface: decisions.surface,
      index: { storage: store.storage, dbPath: store.dbPath, why: store.why },
      skipped,
      delegated,
      sources: report,
      exitCode: unavailable.length ? INDEX_EXIT.UNKNOWN : INDEX_EXIT.OK,
      durationMs: Date.now() - started,
    };
  } finally {
    store.db.close();
  }
}

function render(result) {
  const out = [];
  out.push('# Recall index');
  out.push('');
  out.push(`**${result.state.toUpperCase()}.** ${result.why}`);
  out.push('');
  if (result.index) {
    out.push(`Store: \`${result.index.dbPath}\` (${result.index.storage})`);
    if (result.index.why) out.push(`  ${result.index.why}`);
    out.push('');
  }
  for (const source of result.sources) {
    if (source.state === 'unavailable') {
      out.push(`- \`${source.id}\` **UNAVAILABLE** (${source.code}) -- ${source.why}`);
    } else {
      out.push(`- \`${source.id}\` ${source.state} -- ${source.documentCount} record(s) in ${source.durationMs}ms`);
    }
  }
  for (const source of result.delegated) out.push(`- \`${source.id}\` delegated -- ${source.delegatedTo}`);
  for (const source of result.skipped) out.push(`- \`${source.id}\` **${source.state.toUpperCase()}** -- ${source.why}`);
  out.push('');
  return out.join('\n');
}

function main(argv) {
  const parsed = parseArgv(argv);
  if (parsed.help || parsed.unknown.length) {
    process.stderr.write('usage: node tools/recall-index.js [--rebuild] [--json]\n');
    process.exitCode = INDEX_EXIT.USAGE;
    return;
  }
  const result = buildIndex({ forceRebuild: parsed.forceRebuild });
  if (parsed.asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${render(result)}\n`);
  process.exitCode = result.exitCode;
}

if (require.main === module) main(process.argv);

module.exports = { INDEX_EXIT, buildIndex, main, parseArgv, render };
