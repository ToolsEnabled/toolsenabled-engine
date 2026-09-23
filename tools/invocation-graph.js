#!/usr/bin/env node
'use strict';

// THE INVOCATION GRAPH -- reference extraction for tools/invocation-guard.js.
//
// The guard decides policy. This file decides one narrower and much harder
// question: does file A actually RUN file B, or does it merely MENTION it?
//
// WHY THAT DISTINCTION IS THE WHOLE JOB. Every mechanism in this repository's
// unrun-mechanism family was heavily referenced. tools/check-single-copy-work.js
// is cited in CLAUDE.md, AGENTS.md, config/standing-orders.json and seven other
// documents, and was invoked by nothing. Being written about is not being run.
//
// A guard that cannot tell a call from a comment does not merely miss things --
// it certifies the lie and stops anyone looking. That already happened here:
// hasProductionReference() at src/lib/standing-orders.js:366 is a substring
// scan, so checkWiredDrift() at :387 RUNS, PASSES, and reports mayClaim() as
// wired because the name appears in two comments. mayClaim() has no production
// caller. A false green is worse than no check.
//
// THREE FALSE GREENS WERE MEASURED IN THIS GUARD'S OWN FIRST DRAFT, which is
// why the extraction below is shaped the way it is:
//
//  1. package.json was read as a TEXT source. Any path named in ANY npm script
//     therefore became "reachable" -- including scripts nothing invokes. That
//     defeated the guard's own central rule ("an npm script nothing invokes is
//     not wiring") inside the guard built to enforce it. tools/package-check.js
//     scored REACHABLE through test:pkg.tree, a script no target calls.
//     FIX: package.json is never scanned as text. Only scripts reached by name
//     from a declared root contribute, and their command lines are parsed as
//     command lines.
//
//  2. Prose inside a STRING LITERAL counted. src/lib/coordinator/duty-registry.js:712
//     contains the sentence "Fix with an elevated run of the registrar (node
//     tools/register-managed-tasks.js prints it)" as a human-readable
//     decisionReason. That is advice to a person, not a call, and it made an
//     unwired registrar look wired.
//     FIX: in JavaScript a path string counts only inside an EXECUTION CONTEXT
//     -- the argument span of spawn/exec/execFile/fork -- or as a resolved
//     require()/import. Comments are stripped first.
//
//  3. $comment prose in JSON counted. config/managed-processes.json documents
//     its own design in $comment arrays that name tools.
//     FIX: JSON is parsed structurally, $comment keys are skipped, and only
//     fields that actually denote something to execute are read.
//
// PRECISION OVER RECALL, DELIBERATELY. Where this engine cannot prove an edge
// it reports none, which shows up as RED and gets triaged in the registry with
// a written reason. The opposite error -- a green that nobody re-examines --
// is the one that cost this project nine near-losses.

const fs = require('node:fs');
const path = require('node:path');
const { suiteListReferences } = require('../tests/lib/suite-list');

const ROOT = path.resolve(__dirname, '..');

const EXECUTABLE_PATTERN = '(?:tools|tests|src|bin|scripts|sidecars|adapters)[\\\\/][\\w./\\\\-]+?\\.(?:js|cjs|mjs|ps1|sh)';

// Functions that actually start a process. A path string sitting inside one of
// these calls is being executed; a path string anywhere else in JavaScript is
// data or prose until proven otherwise.
const EXECUTION_CALLS = [
  'spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec', 'fork'
];

// JSON fields that denote something to run. Everything else in a config file --
// including every $comment -- is description.
const EXECUTABLE_JSON_KEYS = new Set([
  'command', 'args', 'argv', 'declaredArgv', 'entryPoint', 'entryPattern',
  'registrar', 'script', 'exec', 'run', 'entry', 'module', 'path', 'file'
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function relativeToRoot(absolute) {
  const relative = path.relative(ROOT, absolute);
  if (!relative || relative.startsWith('..')) return null;
  return toPosix(relative);
}

function isMissingPathError(error) {
  return error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

function fileExists(absolutePath) {
  try {
    return fs.statSync(absolutePath).isFile();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

function stripJavaScriptComments(source) {
  let out = '';
  let index = 0;
  let state = 'code';
  let quote = '';
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (character === '/' && next === '/') { state = 'line'; index += 2; continue; }
      if (character === '/' && next === '*') { state = 'block'; index += 2; continue; }
      if (character === '"' || character === "'" || character === '`') { state = 'string'; quote = character; }
      out += character;
      index += 1;
      continue;
    }
    if (state === 'string') {
      out += character;
      if (character === '\\') { out += next ?? ''; index += 2; continue; }
      if (character === quote) state = 'code';
      index += 1;
      continue;
    }
    if (state === 'line') {
      if (character === '\n') { out += character; state = 'code'; }
      index += 1;
      continue;
    }
    if (character === '*' && next === '/') { state = 'code'; index += 2; continue; }
    if (character === '\n') out += character;
    index += 1;
  }
  return out;
}

// Shell and PowerShell both end a line at `#`, but only outside quotes -- a `#`
// inside a printf argument does not start a comment. Length is preserved so
// that offsets stay valid for the command-position test.
function stripHashComments(source) {
  return source.split('\n').map((line) => {
    let quote = '';
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (quote) {
        if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === '#' && line.slice(index, index + 2) !== '#>') {
        return line.slice(0, index) + ' '.repeat(line.length - index);
      }
    }
    return line;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Execution contexts in JavaScript
// ---------------------------------------------------------------------------

// A CALLBACK BODY IS NOT AN ARGUMENT, and treating it as one produced the
// fourth measured false green in this engine.
//
// `execFile(a, b, opts, (error, stdout, stderr) => { ...200 lines... })` is one
// parenthesis-balanced call. The first version of executionSpans() returned the
// whole thing, so every path string anywhere in that callback -- including the
// error message a human reads when the call FAILS -- scored as "being executed".
//
// Measured 2026-08-11: src/lib/providers/web.js:973 is the ENOENT branch of the
// extractor callback and reads
//     + 'Run `pwsh tools/provision-research.ps1 -Python` to provision it. '
// -- advice printed to a person precisely because the tool has NOT been run. It
// sat 1096 characters inside a 2183-character execFile span, so the guard
// certified tools/provision-research.ps1 as reachable and then demanded its
// baseline registry entry be deleted as stale. Deleting it would have removed
// the only record that an unrun tool exists: the registry may only shrink, so a
// laundered entry never comes back.
//
// That is rule 2 of this file's own header ("prose inside a string literal
// counted") reappearing one level down, in the ONE syntactic position where the
// prose is guaranteed to be about a failure rather than about a call.
//
// So the span stops at a callback body and resumes after it. Real edges survive
// by construction: argv arrays and option objects sit BEFORE the callback, and
// a process-starting call nested inside a callback still matches the pattern on
// its own and contributes its own span. Only concise arrow bodies (`=> expr`,
// no braces) stay inside the span -- they cannot be bounded without a parser,
// and leaving them counted keeps this narrowing from silently dropping edges.
function skipBraceBlock(source, open) {
  let depth = 0;
  let quote = '';
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') { index += 1; continue; }
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'" || character === '`') { quote = character; continue; }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return source.length - 1;
}

// Index of the `{` that opens a callback body starting at `index`, or -1.
function callbackBodyOpensAt(source, index) {
  const openBraceAfter = (from) => {
    let cursor = from;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
    return source[cursor] === '{' ? cursor : -1;
  };
  if (source.startsWith('=>', index)) return openBraceAfter(index + 2);
  if (source.startsWith('function', index)) {
    const before = index === 0 ? '' : source[index - 1];
    if (/[\w$]/.test(before)) return -1;
    const paren = source.indexOf('(', index + 'function'.length);
    if (paren === -1) return -1;
    let depth = 0;
    for (let cursor = paren; cursor < source.length; cursor += 1) {
      if (source[cursor] === '(') depth += 1;
      else if (source[cursor] === ')') {
        depth -= 1;
        if (depth === 0) return openBraceAfter(cursor + 1);
      }
    }
  }
  return -1;
}

// Argument spans of every process-starting call in the source. Parenthesis
// balancing rather than a fixed lookahead window, so a multi-line spawnSync
// argv array is fully covered and an unrelated string 300 characters later is
// not. Returns one span per contiguous argument region, so a single call with a
// callback contributes the arguments before it and the arguments after it and
// nothing in between.
function executionSpans(source) {
  const spans = [];
  const pattern = new RegExp(`\\b(?:${EXECUTION_CALLS.join('|')})\\s*\\(`, 'g');
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let index = start;
    let segmentStart = start;
    let quote = '';
    while (index < source.length && depth > 0) {
      const character = source[index];
      if (quote) {
        if (character === '\\') { index += 2; continue; }
        if (character === quote) quote = '';
        index += 1;
        continue;
      }
      if (character === '"' || character === "'" || character === '`') { quote = character; index += 1; continue; }
      if (character === '(') { depth += 1; index += 1; continue; }
      if (character === ')') {
        depth -= 1;
        if (depth === 0) break;
        index += 1;
        continue;
      }
      const bodyOpen = callbackBodyOpensAt(source, index);
      if (bodyOpen !== -1) {
        if (bodyOpen > segmentStart) spans.push([segmentStart, bodyOpen - 1]);
        index = skipBraceBlock(source, bodyOpen) + 1;
        segmentStart = index;
        continue;
      }
      index += 1;
    }
    if (index > segmentStart) spans.push([segmentStart, index]);
  }
  return spans;
}

function withinSpans(spans, offset) {
  return spans.some(([start, end]) => offset >= start && offset <= end);
}

function resolveRelativeRequire(specifier, fromDirectory) {
  const base = path.resolve(fromDirectory, specifier);
  for (const candidate of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (error) {
      // A missing spelling is evidence that this candidate is absent. An I/O
      // or permission failure is not: refusing prevents an unreadable module
      // from being reported as though no invocation edge existed.
      if (!isMissingPathError(error)) throw error;
    }
  }
  return null;
}

function javaScriptReferences(absolutePath, rawSource) {
  const files = new Set();
  const npmScripts = new Set();
  const directory = path.dirname(absolutePath);
  const source = stripJavaScriptComments(rawSource);

  // (a) The real module graph. A tool required by a reachable library is
  //     genuinely reachable -- tools/repo-sync.js:14 requires
  //     check-single-copy-work, and that edge is a call, not a mention.
  const specifiers = [
    ...source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g),
    ...source.matchAll(/from\s+['"](\.[^'"]+)['"]/g),
    ...source.matchAll(/import\(\s*['"](\.[^'"]+)['"]\s*\)/g)
  ];
  for (const match of specifiers) {
    const resolved = resolveRelativeRequire(match[1], directory);
    const relative = resolved && relativeToRoot(resolved);
    if (relative) files.add(relative);
  }

  // (b) Path strings, but ONLY inside a process-starting call.
  const spans = executionSpans(source);
  if (spans.length) {
    for (const match of source.matchAll(new RegExp(EXECUTABLE_PATTERN, 'g'))) {
      if (withinSpans(spans, match.index)) files.add(toPosix(match[0].replace(/\\/g, '/')));
    }
    for (const match of source.matchAll(/__dirname\s*,\s*['"]([\w./-]+\.(?:js|cjs|mjs|ps1))['"]/g)) {
      if (!withinSpans(spans, match.index)) continue;
      const relative = relativeToRoot(path.resolve(directory, match[1]));
      if (relative) files.add(relative);
    }
    for (const match of source.matchAll(/npm\s+(?:run|run-script)\s+(?:--silent\s+|-s\s+)?([\w:.-]+)/g)) {
      if (withinSpans(spans, match.index)) npmScripts.add(match[1]);
    }
  }

  return { files: [...files], npmScripts: [...npmScripts] };
}

// ---------------------------------------------------------------------------
// Command lines: shell, PowerShell, git hooks, npm script bodies
// ---------------------------------------------------------------------------

// The token must sit at the start of a statement. This is what separates
// `node tools/x.js` from `printf '  node tools/x.js\n'`. .githooks/post-commit
// names tools/check-single-copy-work.js twice -- once in a comment and once in
// printf help text -- and runs it neither time.
const COMMAND_POSITION = '(?:^|[\\n;|&(]|&&|\\|\\||\\$\\(|`|\\bthen\\b|\\bdo\\b|\\belse\\b)\\s*';
const INTERPRETERS = 'node|npx|pwsh|powershell(?:\\.exe)?|sh|bash|python|py';

function commandLineReferences(absolutePath, rawSource) {
  const files = new Set();
  const npmScripts = new Set();
  const source = stripHashComments(rawSource);
  const directory = path.dirname(absolutePath);

  const add = (raw) => {
    const normalized = toPosix(raw.replace(/\\/g, '/')).replace(/^\.\//, '');
    if (/^(?:tools|tests|src|bin|scripts|sidecars|adapters)\//.test(normalized)) {
      files.add(normalized);
      return;
    }
    const relative = relativeToRoot(path.resolve(directory, normalized));
    if (relative) files.add(relative);
  };

  const invocation = new RegExp(
    `${COMMAND_POSITION}(?:${INTERPRETERS})\\b[^\\n;|&]*?(?:^|\\s)(?:-File\\s+|-f\\s+)?['"]?((?:\\.{1,2}[\\\\/])?${EXECUTABLE_PATTERN})`,
    'gm'
  );
  for (const match of source.matchAll(invocation)) add(match[1]);

  // `--from tests/suites/<id>.txt`: tests/run-isolated.js reads its file list
  // from a checked-in file when the list is too long for a Windows command
  // line, which is what package.json's `test` had to do at 305 files and 12,928
  // characters. Those files ARE executed -- one node process each -- so they
  // are an invocation path, and a reader that stopped at the runner would
  // report every one of them as reachable by nothing. Narrow on purpose: only
  // `tests/suites/*.txt` is followed, because `--from` means other things in
  // other command lines and crediting reachability on a guess is the failure
  // this whole graph exists to prevent. See tests/lib/suite-list.js.
  for (const listed of suiteListReferences(source)) add(listed);

  // PowerShell call operator / direct execution, command position only.
  const callOperator = new RegExp(`${COMMAND_POSITION}&\\s*['"]?((?:\\.{1,2}[\\\\/])?${EXECUTABLE_PATTERN})`, 'gm');
  for (const match of source.matchAll(callOperator)) add(match[1]);

  // PowerShell siblings: `& "$PSScriptRoot\foo.ps1"`, Join-Path $PSScriptRoot.
  for (const match of source.matchAll(/\$PSScriptRoot[\\/]+['"]?([\w.-]+\.ps1)/gi)) {
    const relative = relativeToRoot(path.resolve(directory, match[1]));
    if (relative) files.add(relative);
  }
  for (const match of source.matchAll(/Join-Path\s+[^\n]*?\$PSScriptRoot[^\n]*?['"]([\w.-]+\.ps1)['"]/gi)) {
    const relative = relativeToRoot(path.resolve(directory, match[1]));
    if (relative) files.add(relative);
  }

  for (const match of source.matchAll(new RegExp(`${COMMAND_POSITION}npm\\s+(?:run|run-script)\\s+(?:--silent\\s+|-s\\s+)?([\\w:.-]+)`, 'gm'))) {
    npmScripts.add(match[1]);
  }

  return { files: [...files], npmScripts: [...npmScripts] };
}

// ---------------------------------------------------------------------------
// JSON configuration
// ---------------------------------------------------------------------------

function jsonReferences(rawSource) {
  const files = new Set();
  const npmScripts = new Set();
  let parsed;
  try {
    parsed = JSON.parse(rawSource);
  } catch (error) {
    // Invalid JSON is not an empty configuration. Let the caller refuse the
    // scan instead of certifying that a source with unknown contents has no
    // invocation edges.
    throw new Error(`Cannot extract invocation references from invalid JSON: ${error.message}`, { cause: error });
  }

  const pattern = new RegExp(`^(?:\\.{1,2}[\\\\/])?(${EXECUTABLE_PATTERN})$`);
  const consider = (value) => {
    if (typeof value !== 'string') return;
    const normalized = toPosix(value.replace(/\\/g, '/')).replace(/^\.\//, '');
    const direct = normalized.match(pattern);
    if (direct) { files.add(direct[1]); return; }
    // A full command line stored in a single field.
    for (const match of normalized.matchAll(new RegExp(EXECUTABLE_PATTERN, 'g'))) {
      if (/\b(?:node|pwsh|powershell|sh|bash)\b/.test(normalized)) files.add(toPosix(match[0]));
    }
  };

  const walk = (node, key) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (key && EXECUTABLE_JSON_KEYS.has(key)) consider(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
      return;
    }
    if (typeof node !== 'object') return;
    for (const [childKey, value] of Object.entries(node)) {
      // $comment is prose. config/managed-processes.json documents its own
      // design there and names tools it does not run.
      if (childKey.startsWith('$comment')) continue;
      walk(value, childKey);
    }
  };

  walk(parsed, null);
  return { files: [...files], npmScripts: [...npmScripts] };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// Signature-compatible with the extractor it replaces, so the guard consumes it
// as a drop-in. `source` is passed in rather than read here so callers can hand
// over an npm command line with a synthetic path.
function extractReferences(absolutePath, source) {
  const extension = path.extname(absolutePath).toLowerCase();
  if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
    return javaScriptReferences(absolutePath, source);
  }
  if (extension === '.json') {
    return jsonReferences(source);
  }
  return commandLineReferences(absolutePath, source);
}

// npm script bodies are command lines, not files.
function extractFromCommandLine(command) {
  return commandLineReferences(path.join(ROOT, 'package.json'), `\n${command}`);
}

// ---------------------------------------------------------------------------
// FAIL-FAST SHADOWING -- statically wired, dynamically never reached.
// ---------------------------------------------------------------------------
//
// A test can be perfectly reachable on paper and never execute in practice.
// Measured case: tests/test-census.test.js is reachable as
//   npm:test -> pretest -> test:repo-protocol -> tests/repo-protocol/run.js
// at position 6 of 8. The runner STOPPED at the first failure, so position 3
// failing meant positions 4 through 8 had not run in any pretest invocation
// since that regression landed. A plain reachability walk follows the edge and
// reports all eight as wired.
//
// That is not a hypothetical. Adding --continue to that one runner unshadowed
// THREE failures nobody knew existed, including the orphan-test ratchet itself:
// the mechanism built to catch unreachable tests was, in practice, unreachable.
//
// SINCE 2026-08-10 the hazard is the exception rather than the norm:
// tests/run-isolated.js now runs every requested file by default and stops
// early only for an explicit `--fail-fast`. So this check keys off that flag.
// It is deliberately NOT dead code -- the moment a batch opts back into
// stopping early, every member after position 1 is conditional again and a
// recorded failure among them shadows the rest, exactly as before.
//
// So position in a fail-fast batch is part of whether something is wired.
// Proving WHICH members are actually shadowed needs the run data in
// state/test-runs/latest.json; without it this reports the honest weaker fact --
// "conditionally reachable, gated on every earlier sibling passing" -- rather
// than silently upgrading it to wired.
// `scriptsOnly` exists so this can be exercised on a synthetic batch without
// the repository's own 50 real batches bleeding into the result. Caught by the
// regression suite rather than by reasoning: the first version always scanned
// tests/*/run.js, so a test asserting "a --continue batch shadows nothing"
// failed against unrelated real batches.
function orderedBatches(scripts, options = {}) {
  const batches = [];
  const seen = new Set();

  const filesInOrder = (text) => {
    const found = [];
    for (const match of text.matchAll(/tests[\\/][\w./\\-]+?\.js/g)) {
      const normalized = toPosix(match[0].replace(/\\/g, '/'));
      if (!found.includes(normalized)) found.push(normalized);
    }
    return found;
  };

  for (const [name, command] of Object.entries(scripts || {})) {
    if (typeof command !== 'string' || !command.includes('run-isolated')) continue;
    for (const segment of command.split(/&&|;/)) {
      if (!segment.includes('run-isolated')) continue;
      const files = filesInOrder(segment).filter((file) => !file.endsWith('run-isolated.js'));
      if (files.length > 1) {
        batches.push({ source: `npm:${name}`, failFast: segment.includes('--fail-fast'), files });
      }
    }
  }

  if (options.scriptsOnly) return batches;

  const testsRoot = path.join(ROOT, 'tests');
  let directories;
  try {
    directories = fs.readdirSync(testsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch (error) {
    throw new Error(`Cannot enumerate test runners in ${testsRoot}: ${error.message}`, { cause: error });
  }
  for (const entry of directories) {
    const runner = path.join(testsRoot, entry.name, 'run.js');
    let source;
    try {
      source = fs.readFileSync(runner, 'utf8');
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      continue;
    }
    const stripped = stripJavaScriptComments(source);
    const files = filesInOrder(stripped)
      .map((file) => (file.startsWith('tests/') ? file : toPosix(path.join('tests', entry.name, file))))
      .filter((file) => !file.endsWith('run-isolated.js'));
    const resolved = [];
    for (const file of files) {
      const candidate = file.includes('/') && fileExists(path.join(ROOT, file))
        ? file
        : toPosix(path.join('tests', entry.name, path.basename(file)));
      if (fileExists(path.join(ROOT, candidate)) && !resolved.includes(candidate)) resolved.push(candidate);
    }
    if (resolved.length > 1) {
      const key = `tests/${entry.name}/run.js`;
      if (seen.has(key)) continue;
      seen.add(key);
      batches.push({ source: key, failFast: stripped.includes('--fail-fast'), files: resolved });
    }
  }

  return batches;
}

// `skip` is NOT a blocker, and saying it was cost 115 of the 139 names this
// guard printed on 2026-08-10. tests/run-isolated.js recognises an opt-in gated
// suite BEFORE spawning it and `continue`s -- explicitly, even under
// --fail-fast, because an absence of coverage is not a crash. Treating every
// non-pass status as "the runner stopped here" therefore accused
// tests/scheduler-windows-mutation.js of blocking 115 suites that it steps
// aside for by construction. A checker that reports unmeasured claims is the
// same defect it exists to catch, so the blocker set is restricted to statuses
// that actually end a batch: fail, timeout, config-mutation, not-run.
const BATCH_ENDING_STATUSES = new Set(['fail', 'timeout', 'config-mutation', 'not-run']);

// `recordPath` is a PATH seam, not a data seam: a caller may point this at a
// different run record, but it can never hand in a synthetic verdict. That is
// what lets the blocker-status rule above be tested without giving anything a
// way to fabricate evidence in production.
function readLatestRun(recordPath = path.join(ROOT, 'state', 'test-runs', 'latest.json')) {
  try {
    const parsed = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    const failing = new Set();
    for (const record of parsed.files || []) {
      if (record && BATCH_ENDING_STATUSES.has(record.status)) failing.add(toPosix(String(record.file)));
    }
    return { available: true, generatedAt: parsed.generatedAt || null, failing };
  } catch {
    return { available: false, generatedAt: null, failing: new Set() };
  }
}

function findShadowedTests(scripts, options = {}) {
  const batches = orderedBatches(scripts, options);
  const latest = readLatestRun(options.runRecordPath);
  const conditional = new Map();
  const shadowed = new Map();

  for (const batch of batches) {
    if (!batch.failFast) continue;
    let sawFailure = null;
    for (let index = 0; index < batch.files.length; index += 1) {
      const file = batch.files[index];
      if (index > 0 && !conditional.has(file)) {
        conditional.set(file, { batch: batch.source, position: index + 1, of: batch.files.length });
      }
      if (sawFailure && !shadowed.has(file)) {
        shadowed.set(file, { batch: batch.source, position: index + 1, blockedBy: sawFailure });
      }
      if (latest.failing.has(file) && !sawFailure) sawFailure = file;
    }
  }

  return {
    runEvidence: { available: latest.available, generatedAt: latest.generatedAt },
    batches: batches.map(({ source, failFast, files }) => ({ source, failFast, count: files.length })),
    conditional: Object.fromEntries([...conditional].sort(([a], [b]) => a.localeCompare(b))),
    shadowed: Object.fromEntries([...shadowed].sort(([a], [b]) => a.localeCompare(b)))
  };
}

module.exports = {
  ROOT,
  extractReferences,
  extractFromCommandLine,
  findShadowedTests,
  orderedBatches,
  javaScriptReferences,
  commandLineReferences,
  jsonReferences,
  stripJavaScriptComments,
  stripHashComments,
  executionSpans
};
