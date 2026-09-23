'use strict';

// Static require-graph resolver (R93 Phase 2, incident #3).
//
// What happened: an agent working on the Telegram pulse was cut off mid-edit by
// a connection drop, leaving a require() in src/lib/telegram-pulse.js pointing
// at a file it had not created yet.
// Because
//     tools/fleet-supervisor.js
//       -> owner-chat.js -> telegram-bridge.js
//       -> telegram-bridge-commands.js -> telegram-pulse.js
// that one dangling require FATALLY CRASHED THE GEMINI FLEET SUPERVISOR -- a
// subsystem the agent had no involvement with and was explicitly boundaried
// away from. Nobody noticed for 45 minutes.
//
// Two capabilities follow from resolving the graph statically:
//   1. an unresolved local require is caught before it takes a subsystem down;
//   2. BLAST RADIUS -- for any shared file, which subsystems does editing it
//      endanger? An agent told "you only own telegram-pulse.js" could not have
//      known it was holding the fleet supervisor's boot path in its hands.
//
// Dependency-free on purpose: this is part of the control plane, and the whole
// point is that it cannot be taken down by the thing it is watching.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

// Matches require('...') / require("...") with a STATIC string literal only.
// Dynamic requires are unresolvable by definition and are reported separately
// rather than silently ignored -- an honest unknown, not a pass.
const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const DYNAMIC_REQUIRE_RE = /\brequire\s*\(\s*(?!['"])/g;

function isLocalSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../') || path.isAbsolute(specifier);
}

function statIfPresent(file) {
  try {
    return fs.statSync(file);
  } catch (error) {
    // Absence is a measured result. Permission errors and other I/O failures
    // are not: propagating them prevents an unmeasured path from being
    // reported as a missing module or an absent subsystem.
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

// Node's resolution order for a file path, restricted to what this repo uses.
function resolveLocal(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.json`,
    `${base}.node`,
    path.join(base, 'index.js'),
    path.join(base, 'index.json')
  ];
  for (const candidate of candidates) {
    const stat = statIfPresent(candidate);
    if (stat && stat.isFile()) return candidate;
  }
  return null;
}

// Remove comments while respecting string, template and regex literals.
//
// This is a real tokenizer rather than a pair of regexes, because the naive
// version is not merely imprecise -- it is DANGEROUS here. A line comment in
// tools/fleet-supervisor.js reads:
//
//     // src/lib/fleet-supervisor/** so the supervisor's own state shape is
//
// The "/**" inside that line comment looks like a block-comment opener to a
// regex-based stripper, which then swallows everything up to the next "*/" --
// including the real require('../src/lib/owner-chat.js') twenty lines later.
// The scanner would then report a SMALLER graph and cheerfully pass. A tool
// whose job is to catch missing edges must never silently drop edges, so the
// failure mode has to be precision, not optimism.
function stripCommentsPreservingLiterals(text) {
  const out = [];
  let state = 'code';
  let index = 0;
  // Tracks the last significant code character, to tell a regex literal from a
  // division operator.
  let lastSignificant = '';

  const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n', '']);

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    if (state === 'code') {
      if (char === '/' && next === '/') { state = 'line'; index += 2; continue; }
      if (char === '/' && next === '*') { state = 'block'; index += 2; continue; }
      if (char === '\'') { state = 'single'; out.push(char); index += 1; lastSignificant = char; continue; }
      if (char === '"') { state = 'double'; out.push(char); index += 1; lastSignificant = char; continue; }
      if (char === '`') { state = 'template'; out.push(char); index += 1; lastSignificant = char; continue; }
      if (char === '/' && REGEX_PRECEDERS.has(lastSignificant)) { state = 'regex'; out.push(char); index += 1; continue; }
      out.push(char);
      if (!/\s/.test(char)) lastSignificant = char;
      else if (char === '\n') lastSignificant = '\n';
      index += 1;
      continue;
    }

    if (state === 'line') {
      if (char === '\n') { state = 'code'; out.push(char); lastSignificant = '\n'; }
      index += 1;
      continue;
    }

    if (state === 'block') {
      if (char === '*' && next === '/') { state = 'code'; index += 2; continue; }
      if (char === '\n') out.push('\n');
      index += 1;
      continue;
    }

    // Literal states: copy verbatim, honour backslash escapes.
    out.push(char);
    if (char === '\\') {
      if (index + 1 < text.length) out.push(text[index + 1]);
      index += 2;
      continue;
    }
    if (state === 'single' && char === '\'') state = 'code';
    else if (state === 'double' && char === '"') state = 'code';
    else if (state === 'template' && char === '`') state = 'code';
    else if (state === 'regex' && char === '/') state = 'code';
    else if (state === 'regex' && char === '\n') state = 'code';   // unterminated: bail out safely
    index += 1;
  }

  return out.join('');
}

// EAGER vs LAZY matters, and it is not a stylistic distinction.
//
// A top-level require runs at module load, so a broken one PREVENTS THE
// PROCESS FROM BOOTING -- that is precisely how a dangling require in
// telegram-pulse.js killed the fleet supervisor. A require nested inside a
// function only breaks if that branch is taken. Both are real, but only the
// eager graph determines whether a process can start, so the boot-safety cap
// must be stated over the eager graph specifically. Collapsing the two would
// force either a false alarm or a grandfathered exception, and grandfathered
// exceptions are how invariants die.
//
// Depth is measured in braces; a require at depth 0 is eager. Module-wrapping
// IIFEs would be misread as lazy, but this repo does not use them.
function classifyRequires(stripped) {
  const eager = [];
  const lazy = [];
  let depth = 0;
  let cursor = 0;
  REQUIRE_RE.lastIndex = 0;
  let match;
  while ((match = REQUIRE_RE.exec(stripped))) {
    for (let i = cursor; i < match.index; i += 1) {
      const char = stripped[i];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
    }
    cursor = match.index;
    (depth === 0 ? eager : lazy).push(match[2]);
  }
  return { eager, lazy };
}

function readRequires(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { specifiers: [], eager: [], lazy: [], dynamicCount: 0, unreadable: true };
  }
  const stripped = stripCommentsPreservingLiterals(text);
  const specifiers = [...stripped.matchAll(REQUIRE_RE)].map(match => match[2]);
  const { eager, lazy } = classifyRequires(stripped);
  const dynamicCount = [...stripped.matchAll(DYNAMIC_REQUIRE_RE)].length;
  return { specifiers, eager, lazy, dynamicCount, unreadable: false };
}

// Walk the static require graph from one entry point.
function walk(entryFile, { maxFiles = 5000, eagerOnly = false } = {}) {
  const visited = new Set();
  const unresolved = [];
  const dynamic = [];
  const queue = [entryFile];

  if (!statIfPresent(entryFile)) {
    unresolved.push({ from: null, specifier: entryFile, reason: 'entry point does not exist' });
    return { visited, unresolved, dynamic };
  }

  while (queue.length > 0 && visited.size < maxFiles) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);

    if (!current.endsWith('.js')) continue;   // JSON/node leaves have no edges

    const { specifiers, eager, dynamicCount, unreadable } = readRequires(current);
    if (unreadable) {
      unresolved.push({ from: current, specifier: null, reason: 'file could not be read' });
      continue;
    }
    if (dynamicCount > 0) {
      dynamic.push({ file: current, count: dynamicCount });
    }

    for (const specifier of (eagerOnly ? eager : specifiers)) {
      // Builtins and node_modules are out of scope: a missing package is an
      // install problem, not a mid-edit dangling reference.
      if (!isLocalSpecifier(specifier)) continue;
      const resolved = resolveLocal(current, specifier);
      if (!resolved) {
        unresolved.push({ from: current, specifier, reason: 'local module does not resolve' });
        continue;
      }
      if (resolved.includes(`${path.sep}node_modules${path.sep}`)) continue;
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }

  if (queue.length > 0) {
    unresolved.push({
      from: null,
      specifier: entryFile,
      reason: `graph traversal stopped at maxFiles (${maxFiles}) with ${queue.length} file(s) unscanned`
    });
  }

  return { visited, unresolved, dynamic };
}

// Build the full graph across every managed subsystem that has a real entry
// point in this repo. Returns per-subsystem reachability plus the inverted
// blast-radius map.
function buildGraph(processes, { root = ROOT, eagerOnly = false } = {}) {
  const subsystems = {};
  const blastRadius = new Map();
  const problems = [];

  for (const entry of processes) {
    const entryFile = path.resolve(root, entry.entryPoint);
    // A sibling-repo entry point that is not checked out here is not a defect.
    if (!statIfPresent(entryFile)) {
      const missing = { from: null, specifier: entry.entryPoint, reason: 'entry point does not exist' };
      const relative = path.relative(root, entryFile);
      const outsideRoot = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
      subsystems[entry.id] = {
        entryPoint: entry.entryPoint,
        present: false,
        files: [],
        unresolved: outsideRoot ? [] : [missing]
      };
      // Sibling repositories remain optional, but a missing entry point in
      // this repository must not turn a zero-file scan into a passing graph.
      if (!outsideRoot) problems.push({ subsystem: entry.id, ...missing });
      continue;
    }

    const { visited, unresolved, dynamic } = walk(entryFile, { eagerOnly });
    const files = [...visited].map(file => path.relative(root, file).replace(/\\/g, '/'));
    subsystems[entry.id] = {
      entryPoint: entry.entryPoint,
      present: true,
      files,
      fileCount: files.length,
      unresolved,
      dynamic
    };

    for (const file of files) {
      if (!blastRadius.has(file)) blastRadius.set(file, new Set());
      blastRadius.get(file).add(entry.id);
    }
    for (const item of unresolved) {
      problems.push({
        subsystem: entry.id,
        from: item.from ? path.relative(root, item.from).replace(/\\/g, '/') : null,
        specifier: item.specifier,
        reason: item.reason
      });
    }
  }

  return { subsystems, blastRadius, problems };
}

// Which subsystems does editing this file endanger?
function subsystemsAffectedBy(relativeFile, graph) {
  const key = relativeFile.replace(/\\/g, '/');
  const set = graph.blastRadius.get(key);
  return set ? [...set].sort() : [];
}

function blastRadiusObject(graph) {
  const out = {};
  for (const [file, set] of graph.blastRadius.entries()) {
    const ids = [...set].sort();
    // Files reachable from only one subsystem are not interesting; the danger
    // is in the shared ones.
    if (ids.length > 1) out[file] = ids;
  }
  return out;
}

module.exports = Object.freeze({
  ROOT,
  blastRadiusObject,
  buildGraph,
  isLocalSpecifier,
  readRequires,
  resolveLocal,
  stripCommentsPreservingLiterals,
  subsystemsAffectedBy,
  walk
});
