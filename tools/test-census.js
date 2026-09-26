#!/usr/bin/env node
'use strict';

// The census is deliberately static: test runner files are source code, and
// executing them to discover their suite would run tests against production
// state.  We extract only literal test paths and the two path.join patterns
// used by the package runners.

const fs = require('node:fs');
const path = require('node:path');
const { javaScriptReferences } = require('./invocation-graph');
const { suiteListReferences } = require('../tests/lib/suite-list');

const ROOT = path.resolve(__dirname, '..');
const TESTS_ROOT = path.join(ROOT, 'tests');

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function normalizeTestPath(value, sourceDirectory = ROOT) {
  if (typeof value !== 'string' || !value) return null;
  const isRepositoryRelative = /^tests[\\/]/i.test(value);
  const absolute = path.resolve(isRepositoryRelative ? ROOT : sourceDirectory, value);
  const relative = path.relative(ROOT, absolute);
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..') return null;
  if (!relative.toLowerCase().startsWith(`tests${path.sep}`) || path.extname(relative).toLowerCase() !== '.js') return null;
  return toPosix(relative);
}

// Every extension this walk will even LOOK at. `.mjs` and `.cjs` are here so a
// test written in either lands in the census as an EXCLUDED file with the
// reason `unsupported-extension`, rather than not being discovered at all --
// see the exclusion doctrine below. Measured 2026-08-25: `git ls-files tests`
// matches no .mjs and no .cjs path, so this changes no count today; it exists
// so the first one that appears is named instead of silently absent.
const WALKED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function walkJavaScript(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJavaScript(candidate));
    else if (entry.isFile() && WALKED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(candidate);
  }
  return files;
}

/* EXCLUSION IS A CLASSIFICATION, NOT A DISAPPEARANCE.
 *
 * A file under tests/ that is not a candidate is one of three things: a package
 * RUNNER (it spawns suites, so running it as a suite would run its whole package
 * twice), a HELPER/WORKER/FIXTURE (it is imported or spawned by a suite and
 * asserts nothing on its own), or a file this census cannot read as a suite at
 * all. All three are correct to keep out of `reachable`/`orphaned`.
 *
 * What was NOT correct was keeping them out of the REPORT. Measured 2026-08-25
 * on this tree: 856 JavaScript files under tests/, 785 candidates, 71 excluded.
 * Those 71 appeared in NEITHER `reachable` NOR `orphaned`, and
 * `tools/test-run.js --all` runs exactly `[...reachable, ...orphaned]` -- the
 * set tools/test-ratchet.mjs's header calls "the ENTIRE tree". So 71 files were
 * invisible to the runner AND to the orphan count that exists to catch exactly
 * this, and the only trace was a bare integer (`counts.excluded`) with no names
 * behind it. A number nobody can expand is not a report: "we ran less than the
 * whole tree" read as "the whole tree passed".
 *
 * Three of the 71 were real assertion suites, not runners, caught by the
 * `run-` PREFIX rule rather than by any of the three exact runner names:
 *   tests/run-isolated-config-integrity.js       -- measured green, now wired
 *   tests/tools.misc/run-vertex-report-wave.js   -- measured RED (see below)
 *   tests/run-vertex-report-wave.js              -- 5-line shim for the above
 *
 * The remedy is NOT to drop the prefix rule -- a real runner run as a suite is
 * a genuine defect, and `run-isolated.js` is reached by the prefix as well as
 * by name. The remedy is that every exclusion now carries a REASON and is
 * listed by name, so the next reader can audit the 71 instead of trusting them.
 */
function exclusionReason(relativePath) {
  const parts = relativePath.split('/');
  const basename = parts.at(-1).toLowerCase();
  if (path.extname(basename) !== '.js') return 'unsupported-extension';
  // A `.test.js` suffix is this repository's OWN strong, deliberate signal for
  // "this is a real assertion suite, not a helper" -- already trusted by the
  // `worker` basename rule below (`!basename.endsWith('.test.js')`). The five
  // directory-name heuristics just above it were not extending that same
  // trust, so a real suite sitting in a directory named after what it tests
  // was indistinguishable from an actual helper.
  //
  // MEASURED 2026-09-03: tests/lib/multi-account/registry-write.test.js,
  // tests/lib/multi-account/registry-write-refusals.test.js,
  // tests/lib/cloud-agent/batch-runner.test.js and
  // tests/fixtures/fake-provider.test.js were all classified `lib-directory` /
  // `fixtures-directory` purely because of their directory, and were therefore
  // EXCLUDED -- not `orphaned` (which `tools/test-run.js --all` still runs),
  // genuinely unreachable by anything. Two of the four threw or asserted wrong
  // (AGENT_DIGEST_PROCESS_IDENTITY_UNVERIFIED / a stale return-shape
  // expectation) against the CURRENT src/lib/multi-account/registry-write.js,
  // because nothing had run them since that module grew exact lock-identity
  // checking; the other two already passed. All four are fixed/confirmed and
  // wired via tests/suites/orphans-wired-0903.txt.
  const isDeclaredTest = basename.endsWith('.test.js');
  if (!isDeclaredTest) {
    if (parts.includes('lib')) return 'lib-directory';
    if (parts.includes('fixtures')) return 'fixtures-directory';
    if (parts.includes('helpers')) return 'helpers-directory';
    if (parts.includes('workers')) return 'workers-directory';
    if (parts.includes('runner')) return 'runner-directory';
  }
  if (basename === 'run.js' || basename === 'run-isolated.js' || basename === 'legacy-run.js') return 'package-runner';
  if (basename.startsWith('run-')) return 'run-prefixed-name';
  if (/(?:^|[-.])worker(?:[-.]|$)/.test(basename) && !isDeclaredTest) return 'worker-helper';
  return null;
}

function isCandidate(relativePath) {
  return exclusionReason(relativePath) === null;
}

function literalTests(source, sourceDirectory) {
  const paths = new Set();
  const add = (candidate, directory = sourceDirectory) => {
    const normalized = normalizeTestPath(candidate, directory);
    if (normalized) paths.add(normalized);
  };

  for (const match of source.matchAll(/(['"])(tests[\\/][^'"`\r\n]+?\.js)\1/g)) add(match[2]);
  // ANY number of string segments after __dirname, not exactly one.
  //
  // The single-segment form missed `path.join(__dirname, '..', 'x.js')`, which
  // is how a package runner reaches a sibling suite at the flat tests/ path.
  // Measured 2026-08-12: tests/surface.registry/run.js has named
  // tests/lane-scope.test.js and tests/lane-territory-check.test.js that way for
  // some time, and this census reported both as ORPHANED -- a census that calls
  // a running test unrun is worse than one that misses a test, because the
  // remedy it invites is to wire the file a second time.
  for (const match of source.matchAll(/path\.join\(\s*__dirname\s*((?:,\s*(?:'[^'\r\n]*'|"[^"\r\n]*")\s*)+)\)/g)) {
    const segments = [...match[1].matchAll(/'([^'\r\n]*)'|"([^"\r\n]*)"/g)].map(part => part[1] ?? part[2]);
    if (!segments.length || !segments.at(-1).toLowerCase().endsWith('.js')) continue;
    add(path.join(...segments), sourceDirectory);
  }
  for (const match of source.matchAll(/path\.join\(\s*(?:root|ROOT)\s*,\s*(['"])tests\1\s*,\s*(['"])([^'"]+?\.js)\2\s*\)/g)) add(path.join('tests', match[3]));
  return [...paths];
}

function suiteArrayTests(source, sourceDirectory) {
  const paths = new Set();
  const pattern = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:Object\.freeze\(\s*)?\[([\s\S]*?)\](?:\s*\))?\s*;/g;
  for (const match of source.matchAll(pattern)) {
    if (!/(?:suite|tests?)/i.test(match[1])) continue;
    for (const testPath of literalTests(match[2], sourceDirectory)) paths.add(testPath);
  }
  return [...paths];
}

function packageScriptTests(scripts) {
  const found = new Set();
  for (const [name, command] of Object.entries(scripts || {})) {
    if (typeof command !== 'string') continue;
    for (const testPath of literalTests(command, ROOT)) found.add(testPath);
    for (const match of command.matchAll(/(?:^|\s)(tests[\\/][^\s;&|]+?\.js)(?=$|\s|[;&|])/g)) {
      const testPath = normalizeTestPath(match[1]);
      if (testPath) found.add(testPath);
    }
    // A file list handed to `tests/run-isolated.js --from` names test files
    // exactly as argv did, and the runner spawns each of them. Without this the
    // census would report every member of such a list as ORPHANED the moment a
    // list moved out of argv -- and it had to move, because 305 inline paths
    // put package.json's `test` script past Windows' 8191-character command
    // line and stopped `npm test` from starting at all. A census that calls a
    // running test unrun is worse than one that misses a test: the remedy it
    // invites is to wire the file a second time. See tests/lib/suite-list.js.
    for (const listed of suiteListReferences(command)) {
      const testPath = normalizeTestPath(listed);
      if (testPath) found.add(testPath);
    }
  }
  return [...found];
}

function findPackageRunners() {
  return fs.readdirSync(TESTS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(TESTS_ROOT, entry.name, 'run.js'))
    .filter((runner) => fs.existsSync(runner));
}

function expandTestReferences(seedPaths, allJavaScript) {
  const testFiles = new Set(allJavaScript);
  const referenced = new Set(seedPaths);
  const pending = [...seedPaths].filter(testPath => testFiles.has(testPath));
  const scanned = new Set();

  while (pending.length > 0) {
    const testPath = pending.shift();
    if (scanned.has(testPath)) continue;
    scanned.add(testPath);
    const absolutePath = path.join(ROOT, ...testPath.split('/'));
    const source = fs.readFileSync(absolutePath, 'utf8');
    const references = javaScriptReferences(absolutePath, source).files;
    for (const reference of references) {
      if (!testFiles.has(reference)) continue;
      referenced.add(reference);
      if (!scanned.has(reference)) pending.push(reference);
    }
  }

  return referenced;
}

function buildCensus() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // Discovery is repository-relative and extension-agnostic, so a file this
  // census cannot treat as a suite still gets DISCOVERED and named. The old
  // shape mapped through normalizeTestPath and dropped every null on the floor,
  // which is how a `.mjs` test would have been absent from all four lists.
  const discovered = walkJavaScript(TESTS_ROOT)
    .map((file) => toPosix(path.relative(ROOT, file)))
    .sort();
  const allJavaScript = [];
  const excluded = [];
  for (const file of discovered) {
    const reason = exclusionReason(file);
    if (reason) excluded.push({ file, reason });
    if (reason !== 'unsupported-extension') allJavaScript.push(file);
  }
  const candidates = allJavaScript.filter(isCandidate);
  if (candidates.length === 0) {
    throw new Error('Test census refused: scanned zero candidate test files');
  }
  const candidateSet = new Set(candidates);
  const packageScripts = packageScriptTests(packageJson.scripts);
  const runnerSuites = {};
  const referenced = new Set(packageScripts);
  const runnerPaths = findPackageRunners()
    .map((runner) => normalizeTestPath(runner))
    .filter(Boolean);
  const processedRunners = new Set();
  let changed = true;

  while (changed) {
    changed = false;
    const transitivelyReferenced = expandTestReferences(referenced, allJavaScript);
    for (const testPath of transitivelyReferenced) {
      if (referenced.has(testPath)) continue;
      referenced.add(testPath);
      changed = true;
    }

    for (const relativeRunner of runnerPaths) {
      if (!referenced.has(relativeRunner) || processedRunners.has(relativeRunner)) continue;
      processedRunners.add(relativeRunner);
      const runner = path.join(ROOT, ...relativeRunner.split('/'));
      const source = fs.readFileSync(runner, 'utf8');
      const tests = [...new Set([
        ...suiteArrayTests(source, path.dirname(runner)),
        ...literalTests(source, path.dirname(runner))
      ])].sort();
      runnerSuites[relativeRunner] = tests;
      for (const testPath of tests) {
        if (referenced.has(testPath)) continue;
        referenced.add(testPath);
        changed = true;
      }
    }
  }

  const transitivelyReferenced = expandTestReferences(referenced, allJavaScript);
  const reachable = [...candidateSet].filter((testPath) => transitivelyReferenced.has(testPath)).sort();
  const orphaned = [...candidateSet].filter((testPath) => !transitivelyReferenced.has(testPath)).sort();
  return {
    generatedAt: new Date().toISOString(),
    counts: {
      // Every discovered file, whatever its extension, so the three counts
      // below genuinely partition the tree: discovered === candidates +
      // excluded, and candidates === reachable + orphaned.
      javascriptFiles: discovered.length,
      candidates: candidates.length,
      reachable: reachable.length,
      orphaned: orphaned.length,
      // Derived from the NAMED list, never recomputed by subtraction. A count
      // that is a subtraction cannot be audited: it is right by construction
      // even when the thing it counts is wrong.
      excluded: excluded.length
    },
    candidates,
    reachable,
    orphaned,
    excluded,
    packageScripts: packageScripts.sort(),
    runnerSuites
  };
}

function printHuman(census) {
  process.stdout.write(`Test census: ${census.counts.candidates} candidate test files of ${census.counts.javascriptFiles} discovered under tests/\n`);
  process.stdout.write(`Reachable: ${census.counts.reachable}\n`);
  for (const testPath of census.reachable) process.stdout.write(`  ${testPath}\n`);
  process.stdout.write(`Orphaned: ${census.counts.orphaned}\n`);
  for (const testPath of census.orphaned) process.stdout.write(`  ${testPath}\n`);
  // Printed with the same weight as the other two, and each line carries the
  // reason it is here. `tools/test-run.js --all` runs reachable + orphaned and
  // NOTHING from this list, so this is the exact measure of how far short of
  // "the whole tree" a full run falls.
  process.stdout.write(`Excluded (not run by tools/test-run.js --all): ${census.counts.excluded}\n`);
  for (const entry of census.excluded) process.stdout.write(`  ${entry.file}  [${entry.reason}]\n`);
}

if (require.main === module) {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.length > 1 || (argumentsList.length === 1 && argumentsList[0] !== '--json')) {
    process.stderr.write('Usage: node tools/test-census.js [--json]\n');
    process.exitCode = 2;
  } else {
    const census = buildCensus();
    if (argumentsList[0] === '--json') process.stdout.write(`${JSON.stringify(census, null, 2)}\n`);
    else printHuman(census);
  }
}

module.exports = { buildCensus, exclusionReason, expandTestReferences, isCandidate, normalizeTestPath, suiteArrayTests };
