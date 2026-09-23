// prior-work — "has this already been done?" with an exit code that means it.
//
// THE EXIT-CODE CONTRACT IS THE POINT OF THIS FILE
// ------------------------------------------------
//   0  HIT      prior work exists; the files are listed. READ THEM FIRST.
//   3  MISS     the corpus was read end to end and genuinely contains nothing.
//   4  UNKNOWN  the corpus could not be read, so this tool DOES NOT KNOW.
//   2  usage    no topic given.
//
// Why three codes and not two: `grepsaver-orient.js "trademark"` printed
// "No carded system matched" and exited **0**. Six documents of trademark
// research were on disk. Exit 0 is what a caller — a shell script, a hook, a
// CI gate, an agent skimming output — reads as "fine, carry on", so the fleet
// carried on and re-derived four nights of launch research it already owned.
//
// A tool that cannot distinguish "nothing exists" from "I could not look"
// forces every caller to guess, and the cheap guess is always "nothing exists".
// That is the absence-read-as-consent failure class this codebase has now hit
// nine times, and it is why MISS and UNKNOWN are different numbers here.
//
// Usage:
//   node tools/prior-work.js "trademark"
//   node tools/prior-work.js --json "delaware incorporation"
//   node tools/prior-work.js --limit 15 "domain names"
//   node tools/prior-work.js --rebuild "spend cap"     (force a fresh index)

'use strict';

const fs = require('fs');
const path = require('path');
const { query, ROOT, SCOPES } = require('./prior-work-index');

const INDEXABLE = /\.(?:md|mdx|txt|json)$/i;
const MAX_INDEX_DEPTH = 12;
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.shots', 'coverage', 'dist', 'build',
  'tmp', 'temp', '.cache', 'fixtures', '__pycache__', '.venv'
]);

// The index currently bounds its recursive walk.  A file below that boundary
// is not evidence of a MISS: it was never examined.  Keep this guard in the
// exit-code-owning command so that even an old or cached index cannot turn an
// incomplete traversal into permission to duplicate prior work.
function findUnenumeratedCorpusPath(rootDir = ROOT) {
  const pending = SCOPES.map(scope => ({ dir: path.join(rootDir, scope), depth: 0 }));

  while (pending.length) {
    const { dir, depth } = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      // The index reports readable-scope failures itself.  At a depth it does
      // not visit, however, the failed directory is itself omitted evidence.
      if (depth > MAX_INDEX_DEPTH) return path.relative(rootDir, dir) || '.';
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        pending.push({ dir: full, depth: depth + 1 });
      } else if (depth > MAX_INDEX_DEPTH && entry.isFile() && INDEXABLE.test(entry.name)) {
        return path.relative(rootDir, full).split(path.sep).join('/');
      }
    }
  }
  return null;
}

const EXIT = Object.freeze({
  HIT: 0,
  USAGE: 2,
  MISS: 3,
  UNKNOWN: 4
});

function exitCodeFor(outcome) {
  if (outcome === 'hit') return EXIT.HIT;
  if (outcome === 'miss') return EXIT.MISS;
  return EXIT.UNKNOWN;
}

function renderMarkdown(result) {
  const out = [];

  if (result.outcome === 'hit') {
    const count = result.totalCandidates;
    out.push(`# PRIOR WORK EXISTS: "${result.topic}"`);
    out.push('');
    out.push(`**${count} document${count === 1 ? '' : 's'} already address this topic.** `
      + `Read these before starting. If you are about to research this, it has been researched.`);
    out.push('');
    for (const hit of result.results) {
      out.push(`### ${hit.path}`);
      out.push(`${hit.title}  ·  ${hit.modified}  ·  ${hit.sizeBytes} bytes  ·  score ${hit.score}`);
      if (hit.headings.length) out.push(`  ${hit.headings.map(h => `_${h}_`).join(' · ')}`);
      out.push('');
    }
    if (count > result.results.length) {
      out.push(`_${count - result.results.length} further document(s) matched below the display limit; use --limit to see more._`);
      out.push('');
    }
  } else if (result.outcome === 'miss') {
    out.push(`# NO PRIOR WORK: "${result.topic}"`);
    out.push('');
    out.push(`**This is a genuine gap, not a failed lookup.** ${result.why}`);
    out.push('');
    out.push(`Corpus read: ${result.indexedFileCount} files across ${result.scopes.join(', ')} `
      + `(index ${result.rebuilt ? 'rebuilt just now from disk' : 'verified current against disk'}).`);
    out.push('');
    out.push('You are clear to do this work. When you do, write it into `docs/` or `reports/` '
      + 'and it becomes findable here automatically — there is nothing to register.');
    out.push('');
  } else {
    out.push(`# UNKNOWN — cannot answer for "${result.topic}"`);
    out.push('');
    out.push(`**This is NOT a statement that the topic is unexplored.** ${result.why}`);
    out.push('');
    out.push('Do not treat this as permission to redo the work. Resolve the problem above, '
      + 'or search by hand, before assuming nothing exists.');
    out.push('');
  }

  // Freshness is a fact about this answer, so it travels with the answer rather
  // than living in a log nobody reads.
  const parts = [
    `outcome=${result.outcome}`,
    `reason=${result.reason}`,
    `indexed=${result.indexedFileCount ?? 0} files`,
    `index=${result.rebuilt ? 'rebuilt-from-disk' : 'current'}`
  ];
  if (result.degradedCount) parts.push(`unreadable=${result.degradedCount}`);
  if (result.missingScopes && result.missingScopes.length) parts.push(`missing-scopes=${result.missingScopes.join(',')}`);
  out.push(`_${parts.join(' · ')}_`);

  return out.join('\n');
}

function main(argv) {
  const args = argv.slice(2);
  let asJson = false;
  let limit = 8;
  let forceRebuild = false;
  const words = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json') asJson = true;
    else if (arg === '--rebuild') forceRebuild = true;
    else if (arg === '--limit') { limit = Number(args[i + 1]); i += 1; }
    else words.push(arg);
  }

  const topic = words.join(' ').trim();
  if (!topic) {
    process.stderr.write('usage: node tools/prior-work.js [--json] [--limit N] [--rebuild] "<topic>"\n');
    process.exitCode = EXIT.USAGE;
    return;
  }

  let result;
  try {
    result = query(topic, { limit, forceRebuild });
    if (result.outcome === 'miss') {
      const omittedPath = findUnenumeratedCorpusPath();
      if (omittedPath) {
        result = {
          ...result,
          outcome: 'unknown',
          reason: 'CORPUS_ENUMERATION_INCOMPLETE',
          why: `the prior-work index did not enumerate deep corpus path ${omittedPath}`,
          results: []
        };
      }
    }
  } catch (error) {
    // Even a crash must not read as "nothing exists".
    const payload = {
      outcome: 'unknown',
      reason: 'QUERY_FAILED',
      topic,
      why: `the prior-work query threw: ${error.message}`,
      results: []
    };
    process.stdout.write(asJson ? `${JSON.stringify(payload, null, 2)}\n` : `${renderMarkdown(payload)}\n`);
    process.exitCode = EXIT.UNKNOWN;
    return;
  }

  const body = asJson
    ? JSON.stringify({ ...result, exitCode: exitCodeFor(result.outcome) }, null, 2)
    : renderMarkdown(result);
  process.stdout.write(`${body}\n`);
  process.exitCode = exitCodeFor(result.outcome);
}

if (require.main === module) main(process.argv);

module.exports = { renderMarkdown, exitCodeFor, findUnenumeratedCorpusPath, EXIT };
