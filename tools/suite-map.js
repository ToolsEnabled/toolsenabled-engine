#!/usr/bin/env node
'use strict';

// SUITE MAP -- "I changed this file. Which suites actually cover it, and how?"
//
// WHY THIS EXISTS
// ---------------
// A lane once changed a process launcher, ran a keeper suite that never loaded
// that launcher, got a green exit, and nearly shipped it. The lane did not run
// a weak test. It ran an UNRELATED one, and the green was real -- it just meant
// nothing about the changed file.
//
// Nothing in the repository could have told that lane otherwise, because the
// relationship "suite S covers file F" existed only in the head of whoever wrote
// S. This file makes that relationship computable.
//
// COVERAGE IS NOT A BOOLEAN -- THAT IS THE WHOLE POINT
// ----------------------------------------------------
// The named failure mode in this codebase is SOURCE-TEXT ASSERTIONS STANDING IN
// FOR BEHAVIOUR: dead code greps identically to live code, so a test that reads
// a file and matches a regex against it cannot see reachability. Two deliberate
// plants left the suite fully GREEN. A map that reported "yes, 3 suites cover
// this" without saying HOW would launder exactly that defect into a reassurance.
//
// So every edge carries its kind, strongest first:
//
//   require  the suite loads the module and calls into it.  BEHAVIOURAL.
//   exec     the suite spawns the file as a process.        BEHAVIOURAL.
//   read     the suite reads the file as TEXT and asserts on the text.
//            WEAK: identical for live and dead code. Cannot see reachability.
//   sweep    the suite walks a directory tree this file sits in and applies a
//            policy to everything it finds. WEAK for the same reason, but it is
//            the only kind that covers a file NOBODY NAMED -- a new file added
//            to tools/ is swept on day one. Do not dismiss it.
//   mention  the path appears in the suite but in none of the above positions.
//            NOT COVERAGE. Reported so it can be told apart from silence.
//
// RECALL OVER PRECISION, DELIBERATELY -- THE OPPOSITE OF invocation-graph.js
// -------------------------------------------------------------------------
// tools/invocation-graph.js answers "does A really RUN B", where a false yes
// certifies a lie, so it counts a path string only inside a spawn span or a
// resolved require. Correct there. WRONG HERE. The overwhelmingly common shape
// in this repository's tests is `assert.match(read('tools/x.ps1'), /.../)`,
// which is neither. Under the guard's rules the suite-map would report common
// PowerShell launchers as covered by NOTHING -- rediscovering the original
// defect in the tool built to prevent it.
//
// The costs are asymmetric. A false edge costs an agent a few wasted seconds
// running one extra suite. A missing edge is the defect this file exists for.
// So the extractor is broad, and honesty is preserved by LABELLING each edge's
// strength rather than by refusing to draw it.
//
// EXIT CODES SAY WHICH OF THREE DIFFERENT THINGS HAPPENED
// -------------------------------------------------------
// "I found nothing" must never be spelled the same way as "I checked and it is
// fine" -- that is the absence-read-as-consent defect, found nine times in this
// codebase, and tools/grepsaver-orient.js still exits 0 on a miss today.
//
//   0  every input file has at least one BEHAVIOURAL covering suite
//   3  some input file is covered ONLY by source-text assertions or sweeps
//   4  some input file has NO covering suite at all
//   2  could not determine (bad usage, unreadable tree, git unavailable)
//
// 3 and 4 are findings, not crashes. A caller that wants "did this blow up"
// should test for 2. A caller that wants "is this change covered" should
// require 0. They are different questions and they get different answers.
//
// USAGE
//   node tools/suite-map.js <path>...     which suites cover these files
//   node tools/suite-map.js --changed     use the working tree's changed files
//   node tools/suite-map.js --json        machine-readable, with edge kinds
//   node tools/suite-map.js --audit       whole-tree report: what is uncovered,
//                                         and what is covered ONLY weakly

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { stripJavaScriptComments } = require('./invocation-graph');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env.js');

const ROOT = path.resolve(__dirname, '..');
const TESTS_ROOT = path.join(ROOT, 'tests');

// Directories whose contents are subject matter a suite can cover. `tests` is
// deliberately included: a change to a shared test helper is itself a change
// that other suites cover, and a lane editing tests/lib/x.js deserves the same
// answer as a lane editing src/lib/x.js.
const SUBJECT_ROOTS = ['src', 'tools', 'bin', 'scripts', 'sidecars', 'adapters', 'packages', 'config', 'tests', '.githooks'];
const SUBJECT_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ps1', '.psm1', '.json', '.sh']);

const EDGE_KINDS = ['require', 'exec', 'read', 'sweep', 'mention'];
const BEHAVIOURAL = new Set(['require', 'exec']);

const EXIT = {
  COVERED: 0,
  UNDETERMINED: 2,
  WEAK_ONLY: 3,
  UNCOVERED: 4
};

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function relativeToRoot(absolute) {
  const relative = path.relative(ROOT, absolute);
  if (!relative || relative.startsWith('..')) return null;
  return toPosix(relative);
}

function existsOrMissing(absolute) {
  try {
    fs.statSync(absolute);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function walk(directory, onFile) {
  const skip = new Set(['.git', 'node_modules', 'state', 'logs', 'profiles', 'release', '.worktrees', 'dist', '.shots']);
  // A failed listing is not an empty directory. Callers use the files found
  // here to make coverage claims, so let the failure reach main's
  // UNDETERMINED path rather than manufacturing an empty (and complete-looking)
  // census.
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) walk(full, onFile);
      continue;
    }
    if (entry.isFile()) onFile(full);
  }
}

// ---------------------------------------------------------------------------
// Which files are suites, and how do you run one
// ---------------------------------------------------------------------------

// A "suite" is something a person can be told to run. Shared helpers, fixtures
// and the runners themselves are not suites; naming one of those as the answer
// to "what should I run" would be advice that does not execute anything.
function isSuiteFile(relativePath) {
  if (!relativePath.startsWith('tests/')) return false;
  const parts = relativePath.split('/');
  const basename = parts.at(-1);
  if (!/\.(?:js|cjs|mjs)$/.test(basename)) return false;
  if (parts.includes('lib') || parts.includes('fixtures') || parts.includes('helpers') || parts.includes('workers')) return false;
  if (basename === 'run.js' || basename === 'run-isolated.js' || basename === 'legacy-run.js') return false;
  if (basename.startsWith('run-')) return false;
  return true;
}

function collectSuites() {
  const suites = [];
  walk(TESTS_ROOT, (absolute) => {
    const relative = relativeToRoot(absolute);
    if (relative && isSuiteFile(relative)) suites.push(relative);
  });
  // tools/launch-readiness/*.selftest.mjs are suites living outside tests/.
  walk(path.join(ROOT, 'tools', 'launch-readiness'), (absolute) => {
    const relative = relativeToRoot(absolute);
    if (relative && relative.endsWith('.selftest.mjs')) suites.push(relative);
  });
  return suites.sort();
}

// The command that actually runs a given suite. Derived from package.json so it
// cannot drift from the real chain: if a suite is listed in `test:foo`, the
// answer is `npm run test:foo`. A suite reachable only through the root chain
// gets the direct run-isolated invocation, which is what a lane wants anyway --
// it is far cheaper than the whole chain.
function buildRunCommands(scripts) {
  const bySuite = new Map();
  for (const [name, command] of Object.entries(scripts || {})) {
    if (typeof command !== 'string') continue;
    if (!/^(?:test|pretest|posttest)/.test(name)) continue;
    for (const match of command.matchAll(/(?:^|\s)((?:tests|tools)[\\/][\w./\\-]+?\.(?:js|cjs|mjs))(?=$|\s)/g)) {
      const suite = toPosix(match[1].replace(/\\/g, '/'));
      if (suite.endsWith('run-isolated.js')) continue;
      if (!bySuite.has(suite)) bySuite.set(suite, []);
      if (!bySuite.get(suite).includes(name)) bySuite.get(suite).push(name);
    }
  }
  return bySuite;
}

function runCommandFor(suite, scriptsBySuite) {
  const scripts = scriptsBySuite.get(suite);
  // The root chain is the whole battery; naming it as "how to run this one
  // suite" would be a 58-minute answer to a 4-second question.
  const specific = (scripts || []).filter((name) => name !== 'test' && name !== 'pretest');
  if (specific.length > 0) return `npm run ${specific[0]}`;
  if (suite.endsWith('.mjs')) return `node ${suite}`;
  return `node tests/run-isolated.js ${suite}`;
}

// ---------------------------------------------------------------------------
// Edge extraction from one suite
// ---------------------------------------------------------------------------

const SUBJECT_PATTERN = new RegExp(
  `(?:${SUBJECT_ROOTS.map((r) => r.replace('.', '\\.')).join('|')})[\\\\/][\\w./\\\\-]+?\\.(?:js|cjs|mjs|ps1|psm1|json|sh)`,
  'g'
);

const EXEC_CALLS = ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec', 'fork'];
const READ_CALLS = ['readFileSync', 'readFile', 'createReadStream', 'statSync', 'existsSync', 'accessSync', 'openSync'];
const SWEEP_CALLS = ['readdirSync', 'readdir', 'opendirSync', 'globSync', 'glob'];

// Argument spans of a set of call names, by parenthesis balancing. A multi-line
// spawnSync argv array is fully covered; an unrelated string 300 characters
// later is not.
function callSpans(source, names) {
  const spans = [];
  const pattern = new RegExp(`\\b(?:${names.join('|')})\\s*\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    let depth = 0;
    let index = match.index + match[0].length - 1;
    const start = index + 1;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    spans.push([start, index]);
  }
  return spans;
}

function within(spans, offset) {
  return spans.some(([start, end]) => offset >= start && offset <= end);
}

function resolveRequire(specifier, fromDirectory) {
  const base = path.resolve(fromDirectory, specifier);
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      // A candidate that does not exist can legitimately be tried with the
      // next Node spelling. Any other stat failure means resolution was not
      // measured and must not be collapsed into "not required".
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  return null;
}

// A suite that walks directory trees applies its policy to every file under
// them, including files that do not exist yet. Detected as: the file performs a
// directory listing AND names repository roots as literals. Both halves are
// required -- a suite that merely mentions 'tools' in a message is not sweeping
// it, and a suite that lists one hard-coded directory of fixtures is not
// sweeping the source tree.
function sweepRoots(source) {
  if (!callSpans(source, SWEEP_CALLS).length) return [];
  const roots = new Set();
  for (const match of source.matchAll(/['"]([\w.-]+)['"]/g)) {
    const value = match[1];
    if (SUBJECT_ROOTS.includes(value)) roots.add(value);
  }
  // `path.join(root, 'src', 'lib')` style nested roots.
  for (const match of source.matchAll(/path\.(?:join|resolve)\(\s*(?:root|ROOT|repoRoot)\s*,\s*['"]([\w.-]+)['"]\s*(?:,\s*['"]([\w.-]+)['"]\s*)?\)/g)) {
    if (SUBJECT_ROOTS.includes(match[1])) roots.add(match[2] ? `${match[1]}/${match[2]}` : match[1]);
  }
  return [...roots];
}

// Returns Map<subjectPath, edgeKind> for one suite, plus its sweep roots.
function edgesFromSuite(suiteRelative) {
  const absolute = path.join(ROOT, suiteRelative);
  // An unreadable suite has unknown edges, not zero edges. Propagate the read
  // failure so the command refuses with UNDETERMINED.
  const raw = fs.readFileSync(absolute, 'utf8');
  const source = stripJavaScriptComments(raw);
  const directory = path.dirname(absolute);
  const edges = new Map();

  // Strongest wins: a file both required and read is required.
  const record = (subject, kind) => {
    const existing = edges.get(subject);
    if (existing && EDGE_KINDS.indexOf(existing) <= EDGE_KINDS.indexOf(kind)) return;
    edges.set(subject, kind);
  };

  for (const match of [
    ...source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g),
    ...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g),
    ...source.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)
  ]) {
    const resolved = resolveRequire(match[1], directory);
    const relative = resolved && relativeToRoot(resolved);
    if (relative) record(relative, 'require');
  }

  const execSpans = callSpans(source, EXEC_CALLS);
  const readSpans = callSpans(source, READ_CALLS);

  for (const match of source.matchAll(SUBJECT_PATTERN)) {
    const subject = toPosix(match[0].replace(/\\/g, '/'));
    if (!existsOrMissing(path.join(ROOT, subject))) continue;
    if (within(execSpans, match.index)) record(subject, 'exec');
    else if (within(readSpans, match.index)) record(subject, 'read');
    else record(subject, 'mention');
  }

  // `read('tools/x.ps1')` where read() is the suite's own one-line helper around
  // readFileSync. This shape is everywhere in this repository -- it is how
  // tests/terminal-suppression.test.js reaches many PowerShell launchers -- and
  // treating it as a bare mention would drop the single most common real edge.
  const helperNames = new Set();
  for (const match of source.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)\s*=?[^\n]*readFileSync/g)) {
    helperNames.add(match[1]);
  }
  if (helperNames.size) {
    const helperSpans = callSpans(source, [...helperNames]);
    for (const match of source.matchAll(SUBJECT_PATTERN)) {
      const subject = toPosix(match[0].replace(/\\/g, '/'));
      if (!existsOrMissing(path.join(ROOT, subject))) continue;
      if (within(helperSpans, match.index)) record(subject, 'read');
    }
  }

  return { edges, sweeps: sweepRoots(source) };
}

// ---------------------------------------------------------------------------
// Transitive reach through the production module graph
// ---------------------------------------------------------------------------
//
// A suite that requires src/lib/a.js, which requires src/lib/b.js, exercises
// b.js. Depth is recorded and reported: depth 1 is the suite's declared subject,
// depth 4 is something it happens to drag in. A lane should be told the
// difference rather than handed a flat list where they look equally relevant.

function productionRequires(relativePath) {
  if (!/\.(?:js|cjs|mjs)$/.test(relativePath)) return [];
  // A failed module read cannot establish that the module has no dependencies.
  const raw = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  const source = stripJavaScriptComments(raw);
  const directory = path.dirname(path.join(ROOT, relativePath));
  const out = [];
  for (const match of [
    ...source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g),
    ...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)
  ]) {
    const resolved = resolveRequire(match[1], directory);
    const relative = resolved && relativeToRoot(resolved);
    if (relative) out.push(relative);
  }
  return out;
}

const MAX_DEPTH = 4;

function buildMap() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const scriptsBySuite = buildRunCommands(packageJson.scripts);
  const suites = collectSuites();

  // subject -> Map<suite, {kind, depth}>
  const coverage = new Map();
  const sweepsBySuite = new Map();
  const requireCache = new Map();

  const requiresOf = (file) => {
    if (!requireCache.has(file)) requireCache.set(file, productionRequires(file));
    return requireCache.get(file);
  };

  const add = (subject, suite, kind, depth) => {
    if (!coverage.has(subject)) coverage.set(subject, new Map());
    const existing = coverage.get(subject).get(suite);
    if (existing && (EDGE_KINDS.indexOf(existing.kind) < EDGE_KINDS.indexOf(kind)
      || (existing.kind === kind && existing.depth <= depth))) return;
    coverage.get(subject).set(suite, { kind, depth });
  };

  for (const suite of suites) {
    const { edges, sweeps } = edgesFromSuite(suite);
    if (sweeps.length) sweepsBySuite.set(suite, sweeps);

    for (const [subject, kind] of edges) {
      add(subject, suite, kind, 1);
      if (!BEHAVIOURAL.has(kind)) continue;
      // Only a behavioural edge propagates. A suite that READS the text of
      // a.js has not exercised anything a.js requires, and saying otherwise
      // would manufacture depth-2 coverage out of a regex match.
      const seen = new Set([subject]);
      let frontier = [subject];
      for (let depth = 2; depth <= MAX_DEPTH && frontier.length; depth += 1) {
        const next = [];
        for (const file of frontier) {
          for (const child of requiresOf(file)) {
            if (seen.has(child)) continue;
            seen.add(child);
            add(child, suite, 'require', depth);
            next.push(child);
          }
        }
        frontier = next;
      }
    }
  }

  return { coverage, sweepsBySuite, scriptsBySuite, suites };
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

function normalizeInput(value) {
  const cleaned = value.replace(/^["']|["']$/g, '');
  const absolute = path.isAbsolute(cleaned) ? cleaned : path.resolve(process.cwd(), cleaned);
  const relative = relativeToRoot(absolute);
  if (relative) return relative;
  // Git returns repository-relative paths, including deleted paths. Resolve the
  // spelling lexically instead of requiring the file to exist: absence is part
  // of the measured changed set, not grounds for silently dropping that input.
  return relativeToRoot(path.resolve(ROOT, cleaned));
}

function coveringSuites(map, subject) {
  const direct = map.coverage.get(subject) || new Map();
  const results = [];
  for (const [suite, info] of direct) results.push({ suite, ...info });

  const parts = subject.split('/');
  for (const [suite, roots] of map.sweepsBySuite) {
    if (results.some((r) => r.suite === suite)) continue;
    const extension = path.extname(subject).toLowerCase();
    if (!SUBJECT_EXTENSIONS.has(extension)) continue;
    for (const root of roots) {
      const rootParts = root.split('/');
      if (rootParts.every((segment, index) => parts[index] === segment)) {
        results.push({ suite, kind: 'sweep', depth: 1, sweptRoot: root });
        break;
      }
    }
  }

  results.sort((a, b) => {
    const byKind = EDGE_KINDS.indexOf(a.kind) - EDGE_KINDS.indexOf(b.kind);
    if (byKind !== 0) return byKind;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.suite.localeCompare(b.suite);
  });
  return results;
}

function classify(results) {
  const real = results.filter((r) => r.kind !== 'mention');
  if (real.length === 0) return 'uncovered';
  if (real.some((r) => BEHAVIOURAL.has(r.kind))) return 'behavioural';
  return 'weak-only';
}

function changedFiles() {
  const args = ['diff', '--name-only', 'HEAD'];
  // git runs credential helpers and hooks -- caller-supplied code -- so the
  // env is scrubbed. Measured limit (canary-tested): ANTHROPIC_API_KEY is
  // removed, but GITHUB_TOKEN/GH_TOKEN survive the scrub and reach the child.
  const gitEnv = safeLaunchEnvironment(process.env, { context: 'suite-map changed-file scan' });
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: gitEnv });
  if (result.error || result.status !== 0) return null;
  const tracked = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true, env: gitEnv
  });
  if (untracked.error || untracked.status !== 0) return null;
  const extra = untracked.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return [...new Set([...tracked, ...extra])].filter((file) => SUBJECT_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

const KIND_NOTE = {
  require: 'loads the module — behavioural',
  exec: 'spawns the file — behavioural',
  read: 'reads the file as TEXT and asserts on it — CANNOT see reachability',
  sweep: 'policy sweep over a directory — CANNOT see reachability',
  mention: 'names the path but neither loads, runs nor reads it — NOT coverage'
};

function report(map, inputs, out) {
  let worst = EXIT.COVERED;
  const payload = [];

  for (const subject of inputs) {
    const results = coveringSuites(map, subject);
    const verdict = classify(results);
    payload.push({ file: subject, verdict, suites: results });

    out(`\n${subject}`);
    if (verdict === 'uncovered') {
      worst = EXIT.UNCOVERED;
      out('  NO SUITE COVERS THIS FILE.');
      out('  This is a finding, not a pass. Changing it cannot be validated by any');
      out('  existing test, so a green run says nothing about your change.');
      const mentions = results.filter((r) => r.kind === 'mention');
      if (mentions.length) {
        out(`  (${mentions.length} suite(s) mention the path without loading, running or reading it:`);
        for (const r of mentions.slice(0, 5)) out(`     ${r.suite}`);
        out('   a mention is not coverage.)');
      }
      continue;
    }

    if (verdict === 'weak-only') {
      if (worst !== EXIT.UNCOVERED) worst = EXIT.WEAK_ONLY;
      out('  COVERED ONLY BY SOURCE-TEXT ASSERTIONS. No suite loads or runs this file.');
      out('  Dead code greps identically to live code: these suites stay GREEN if your');
      out('  change is unreachable at runtime. Treat their pass as unproven.');
    }

    for (const r of results) {
      if (r.kind === 'mention') continue;
      const depth = r.depth > 1 ? `  (depth ${r.depth}, indirect)` : '';
      const swept = r.sweptRoot ? `  [sweeps ${r.sweptRoot}/]` : '';
      out(`  ${r.kind.padEnd(8)} ${r.suite}${depth}${swept}`);
      out(`           ${KIND_NOTE[r.kind]}`);
      out(`           run: ${runCommandFor(r.suite, map.scriptsBySuite)}`);
    }
  }
  return { worst, payload };
}

function audit(map, out) {
  const subjects = [];
  for (const root of SUBJECT_ROOTS) {
    if (root === 'tests') continue;
    walk(path.join(ROOT, root), (absolute) => {
      const relative = relativeToRoot(absolute);
      if (relative && SUBJECT_EXTENSIONS.has(path.extname(relative).toLowerCase())) subjects.push(relative);
    });
  }
  const buckets = { behavioural: [], 'weak-only': [], uncovered: [] };
  for (const subject of subjects.sort()) {
    buckets[classify(coveringSuites(map, subject))].push(subject);
  }
  const total = subjects.length;
  out('SUITE MAP AUDIT -- how the tree is covered, by KIND of coverage');
  out('='.repeat(72));
  out(`  ${String(buckets.behavioural.length).padStart(5)}  behavioural   a suite loads or runs it`);
  out(`  ${String(buckets['weak-only'].length).padStart(5)}  weak only     ONLY source-text assertions or policy sweeps`);
  out(`  ${String(buckets.uncovered.length).padStart(5)}  uncovered     no suite reaches it at all`);
  out(`  ${String(total).padStart(5)}  total subject files`);
  out('');
  out('"weak only" is the named failure mode: those files can be broken at runtime');
  out('while every suite naming them stays green.');
  return buckets;
}

function main(argv) {
  const args = argv.slice(2);
  const supportedOptions = new Set(['--json', '--audit', '--changed']);
  const unknownOption = args.find((arg) => arg.startsWith('--') && !supportedOptions.has(arg));
  if (unknownOption) {
    process.stderr.write(`suite-map: unknown option: ${unknownOption}\n`);
    return EXIT.UNDETERMINED;
  }
  const json = args.includes('--json');
  const wantAudit = args.includes('--audit');
  const wantChanged = args.includes('--changed');
  const positional = args.filter((a) => !a.startsWith('--'));
  const lines = [];
  const out = (line) => lines.push(line);

  if (!wantAudit && !wantChanged && positional.length === 0) {
    process.stderr.write(
      'usage: node tools/suite-map.js <path>...\n'
      + '       node tools/suite-map.js --changed    (files changed vs HEAD, plus untracked)\n'
      + '       node tools/suite-map.js --audit      (whole-tree coverage-kind report)\n'
      + '       add --json for machine-readable output\n'
    );
    return EXIT.UNDETERMINED;
  }

  let map;
  try {
    map = buildMap();
  } catch (error) {
    // An unreadable tree is UNDETERMINED, never "covered". Reporting 0 here
    // would be the exact absence-read-as-consent shape this tool exists to end.
    process.stderr.write(`suite-map: could not build the map: ${error.message}\n`);
    return EXIT.UNDETERMINED;
  }

  if (wantAudit) {
    let buckets;
    try {
      buckets = audit(map, out);
    } catch (error) {
      process.stderr.write(`suite-map: could not audit the subject tree: ${error.message}\n`);
      return EXIT.UNDETERMINED;
    }
    if (json) process.stdout.write(`${JSON.stringify(buckets, null, 2)}\n`);
    else process.stdout.write(`${lines.join('\n')}\n`);
    // The audit is a census, not a verdict on a change. It reports; the tiering
    // gate is what refuses.
    return EXIT.COVERED;
  }

  let inputs;
  if (wantChanged) {
    const changed = changedFiles();
    if (changed === null) {
      process.stderr.write('suite-map: git is unavailable, so the changed-file set is UNKNOWN.\n');
      return EXIT.UNDETERMINED;
    }
    inputs = changed.map(normalizeInput).filter(Boolean);
    if (inputs.length === 0) {
      process.stdout.write('suite-map: no changed subject files.\n');
      return EXIT.COVERED;
    }
  } else {
    inputs = [];
    for (const value of positional) {
      const normalized = normalizeInput(value);
      if (!normalized) {
        process.stderr.write(`suite-map: not a path inside this repository: ${value}\n`);
        return EXIT.UNDETERMINED;
      }
      inputs.push(normalized);
    }
  }

  const { worst, payload } = report(map, inputs, out);
  if (json) {
    process.stdout.write(`${JSON.stringify({ files: payload, exitCode: worst }, null, 2)}\n`);
  } else {
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return worst;
}

module.exports = {
  buildMap,
  coveringSuites,
  classify,
  edgesFromSuite,
  sweepRoots,
  isSuiteFile,
  runCommandFor,
  buildRunCommands,
  EXIT,
  EDGE_KINDS,
  BEHAVIOURAL
};

if (require.main === module) {
  process.exitCode = main(process.argv);
}
