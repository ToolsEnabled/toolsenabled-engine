#!/usr/bin/env node
// finished-queue — the FINISHED build queue, per project, and the gate that
// reads it before a lane is dispatched.
//
// THE EXIT-CODE CONTRACT IS THE POINT OF THIS FILE
// ------------------------------------------------
//   0  CLEAR      the roster was read in full and holds no matching finished
//                 work. Dispatch it.
//   3  DUPLICATE  finished work already covers this. REFUSE the dispatch; the
//                 commit and the test that proves it are printed.
//   4  FLAG       overlapping finished work exists. A human decides.
//   5  UNKNOWN    the roster could not be read / is empty / the assignment was
//                 empty. NOT "clear". Do not dispatch on this.
//   2  usage
//
// Note the polarity, and note that it is deliberately the OPPOSITE of
// tools/prior-work.js. prior-work is a DISCOVERY tool, so 0 means "found
// something, go read it". This is a GATE, so 0 means "proceed". Any caller that
// only checks `exit === 0` therefore fails CLOSED here: a broken index, a
// missing tree, an empty corpus and a real duplicate all block. That is the
// only safe direction for a gate, because the cheap misreading of a non-zero is
// "stop and look", while the cheap misreading of a zero is "carry on".
//
// Usage:
//   node tools/finished-queue.js check "make Pause/Respawn/Terminate steer a real agent session"
//   node tools/finished-queue.js check "<assignment>" --files src/views/setup.js,src/setup-profile.js
//   node tools/finished-queue.js check "<assignment>" --json
//   node tools/finished-queue.js render                 # write reports/FINISHED-QUEUE.md
//   node tools/finished-queue.js projects [--since 30]  # per-project finished work
//   node tools/finished-queue.js trees                  # what the roster read, and what it did not
//
// Flags: --since <days>  --limit <n>  --rebuild  --include-retired  --root <dir>
//        --tree <dir> (repeatable)  --active-days <n>  --json

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const idx = require('./finished-queue-index');

const EXIT = Object.freeze({ CLEAR: 0, USAGE: 2, DUPLICATE: 3, FLAG: 4, UNKNOWN: 5 });

function exitCodeFor(verdict) {
  if (verdict === idx.VERDICT.CLEAR) return EXIT.CLEAR;
  if (verdict === idx.VERDICT.DUPLICATE) return EXIT.DUPLICATE;
  if (verdict === idx.VERDICT.FLAG) return EXIT.FLAG;
  return EXIT.UNKNOWN;
}

function parseArgs(argv) {
  const opts = { extraTrees: [], _: [], argErrors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = (flag) => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        opts.argErrors.push(`${flag} requires a value`);
        return undefined;
      }
      i += 1;
      return value;
    };
    const takeNum = (key, flag) => {
      const value = takeValue(flag);
      if (value === undefined) return;
      const number = Number(value);
      if (!Number.isFinite(number)) opts.argErrors.push(`${flag} requires a finite number`);
      else opts[key] = number;
    };
    if (a === '--help') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--rebuild') opts.rebuild = true;
    else if (a === '--include-retired') opts.includeRetired = true;
    else if (a === '--since') takeNum('sinceDays', a);
    else if (a === '--limit') takeNum('limit', a);
    else if (a === '--active-days') takeNum('activeDays', a);
    else if (a === '--root') opts.root = takeValue(a);
    else if (a === '--tree') {
      const tree = takeValue(a);
      if (tree !== undefined) opts.extraTrees.push(tree);
    } else if (a === '--files') {
      const files = takeValue(a);
      if (files !== undefined) opts.files = files.split(',').map(s => s.trim()).filter(Boolean);
    } else if (a.startsWith('--')) opts.argErrors.push(`unknown option ${a}`);
    else opts._.push(a);
  }
  return opts;
}

function renderCheck(r) {
  const L = [];
  if (r.verdict === idx.VERDICT.DUPLICATE) {
    L.push(`# REFUSED — ALREADY BUILT: "${r.assignment}"`);
    L.push('');
    L.push('Finished work already covers this assignment. Do not dispatch it. If you believe');
    L.push('the work is genuinely incomplete, say what is missing THAT THE COMMIT BELOW DID NOT DO,');
    L.push('and dispatch that instead.');
  } else if (r.verdict === idx.VERDICT.FLAG) {
    L.push(`# FLAGGED — OVERLAPPING FINISHED WORK: "${r.assignment}"`);
    L.push('');
    L.push('This is not obviously a duplicate, but finished work touches the same ground.');
    L.push('Read these before dispatching, and narrow the brief to what is actually left.');
  } else if (r.verdict === idx.VERDICT.CLEAR) {
    L.push(`# CLEAR — no finished work matches: "${r.assignment}"`);
    L.push('');
    L.push(`${r.docCount} commits read end to end across ${r.treesRead.length} tree(s). `
      + 'This is a genuine gap, not a failed lookup.');
  } else {
    L.push(`# UNKNOWN — the finished queue could not answer: "${r.assignment || '(no assignment given)'}"`);
    L.push('');
    L.push(r.why || r.reason);
    L.push('');
    L.push('**This is not permission to dispatch.** Fix the lookup, then ask again.');
    if (r.failures?.length) for (const f of r.failures) L.push(`  unreadable: ${f.root} — ${f.error}`);
    return L.join('\n');
  }
  L.push('');

  for (const m of r.matches) {
    L.push(`### ${m.shortSha} — ${m.subject}`);
    L.push(`${m.date.slice(0, 10)}  ·  coverage ${(m.coverage * 100).toFixed(0)}%  ·  matched: ${m.matchedTerms.join(', ')}`);
    if (m.fileOverlap.length) L.push(`  **same files:** ${m.fileOverlap.join(', ')}`);
    if (m.provenBy.length) L.push(`  **proven by:** ${m.provenBy.join(', ')}`);
    else L.push('  **proven by:** (no test in this commit — the claim rests on the diff alone)');
    L.push(`  artifacts: ${m.artifacts.join(', ')}`);
    L.push(`  in tree(s): ${m.trees.join(', ')}`);
    L.push('');
  }

  if (r.totalCandidates > r.matches.length) {
    L.push(`(${r.totalCandidates - r.matches.length} further overlapping commit(s) not shown; --limit to widen.)`);
    L.push('');
  }
  L.push(`Roster: ${r.treesRead.join(', ')}`);
  if (r.treesUnreadable?.length) {
    L.push(`Unreadable candidates (not in scope, listed for honesty): ${r.treesUnreadable.length}`);
  }
  return L.join('\n');
}

function renderTrees(opts, roster = idx.buildRoster(opts)) {
  const L = ['# Finished-queue roster', ''];
  L.push(`Package name matched: \`${roster.selfName || '(none)'}\`   activity window: ${roster.activeDays} days`);
  L.push('');
  L.push(`## Read (${roster.included.length})`);
  for (const t of roster.included) {
    L.push(`- ${t.root}  —  ${t.commitCount} commits, HEAD ${t.head.slice(0, 7)}, last ${t.lastCommit.slice(0, 10)} (${t.why})`);
  }
  L.push('');
  L.push(`## Not read (${roster.skipped.length}) — named so no exclusion is silent`);
  for (const t of roster.skipped.slice(0, 200)) L.push(`- ${t.root}  —  ${t.reason}`);
  if (roster.unreadable.length) {
    L.push('');
    L.push(`## Candidates that could not be read (${roster.unreadable.length})`);
    for (const t of roster.unreadable.slice(0, 200)) L.push(`- ${t.root}  —  ${t.reason}`);
  }
  return L.join('\n');
}

function renderProjects(res) {
  if (!res.ok) return `# UNKNOWN — ${res.reason}\n\nThe finished queue could not be built. This is not "nothing was finished".`;
  const L = ['# FINISHED build queue — by project', ''];
  L.push('**This file is written by a machine and is regenerated from git history.**');
  L.push('Do not hand-edit it: a hand-maintained done-list is the failure this exists to end.');
  L.push('Regenerate with `node tools/finished-queue.js render`.');
  L.push('');
  L.push(`Window: last ${res.sinceDays} days · ${res.docCount} commits indexed · `
    + `${res.roster.included.length} tree(s) read · generated ${new Date().toISOString()}`);
  L.push('');
  L.push('Trees read: ' + res.roster.included.map(t => t.root).join(', '));
  L.push('');
  L.push('Projects are the ids declared in `config/packages.json`, resolved by the files each');
  L.push('commit touched. A commit whose files no package claims lands in `(unclaimed files)` —');
  L.push('that bucket is a real signal about the manifest, not a rounding error.');
  L.push('');
  for (const p of res.projects) {
    L.push(`## ${p.id}  (${p.count})`);
    for (const e of p.entries.slice(0, 40)) {
      const proof = e.provenBy.length ? `  [proven by ${e.provenBy.join(', ')}]` : '  [no test in commit]';
      L.push(`- \`${e.sha}\` ${e.date} — ${e.subject}${proof}`);
    }
    if (p.entries.length > 40) L.push(`- …and ${p.entries.length - 40} more`);
    L.push('');
  }
  return L.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const cmd = opts._[0];

  if (opts.argErrors.length) {
    process.stderr.write(`invalid arguments: ${opts.argErrors.join('; ')}\n`);
    return EXIT.USAGE;
  }

  if (!cmd || opts.help || cmd === 'help') {
    process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n')
      .filter(l => l.startsWith('//')).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    return EXIT.USAGE;
  }

  if (cmd === 'trees') {
    const roster = idx.buildRoster(opts);
    const out = renderTrees(opts, roster);
    process.stdout.write((opts.json ? JSON.stringify(roster, null, 2) : out) + '\n');
    return roster.included.length ? EXIT.CLEAR : EXIT.UNKNOWN;
  }

  if (cmd === 'projects' || cmd === 'render') {
    const res = idx.byProject(opts);
    const text = renderProjects(res);
    if (cmd === 'render') {
      const root = path.resolve(opts.root || path.resolve(__dirname, '..'));
      const out = path.join(root, 'reports', 'FINISHED-QUEUE.md');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, text + '\n', 'utf8');
      process.stdout.write(`wrote ${out} (${res.ok ? res.projects.length : 0} projects)\n`);
      return res.ok ? EXIT.CLEAR : EXIT.UNKNOWN;
    }
    process.stdout.write((opts.json ? JSON.stringify(res, null, 2) : text) + '\n');
    return res.ok ? EXIT.CLEAR : EXIT.UNKNOWN;
  }

  if (cmd !== 'check') {
    process.stderr.write(`unknown command "${cmd}". Try: check | projects | render | trees\n`);
    return EXIT.USAGE;
  }

  const assignment = opts._.slice(1).join(' ');
  if (!assignment.trim() && !(opts.files || []).length) {
    process.stderr.write('usage: node tools/finished-queue.js check "<assignment>" [--files a,b]\n'
      + 'Refusing to answer with no assignment: silence here would be read as CLEAR.\n');
    return EXIT.USAGE;
  }

  const result = idx.check(assignment, opts);
  process.stdout.write((opts.json ? JSON.stringify(result, null, 2) : renderCheck(result)) + '\n');
  return exitCodeFor(result.verdict);
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    // A crash is UNKNOWN, never CLEAR.
    process.stderr.write(`finished-queue failed: ${error && error.stack ? error.stack : error}\n`);
    process.exitCode = EXIT.UNKNOWN;
  }
}

module.exports = { EXIT, exitCodeFor, renderCheck, renderProjects, renderTrees };
