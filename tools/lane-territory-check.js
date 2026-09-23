#!/usr/bin/env node
'use strict';

// Merge gate: verify a lane's worktree changed only files inside its declared
// territory (owner R1162 — out-of-directive work is a violation, not
// initiative). Diff base is ALWAYS the merge-base fork point, never a branch
// name taken on faith: in this repo `main` can sit behind the fork point, and
// diffing against it once produced a false scope-violation report.

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const laneScope = require('../src/lib/lane-scope');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env.js');

function fail(code, message) {
  process.stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`);
  process.exit(1);
}

function parseArgs(argv, env = process.env) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !flag.startsWith('--') || value === undefined) {
      fail('LANE_TERRITORY_ARGS', `Expected --name value pairs; problem at ${flag || '<end>'}.`);
    }
    values[flag.slice(2)] = value;
  }
  // A lane already publishes its own declared scope in TOOLSENABLED_LANE_SCOPE
  // (src/lib/lane-scope.js, exported to every lane process by
  // src/lib/agent-lane.js). Before this fallback existed, an automated caller
  // had to re-derive the territory string itself, so the merge gate was
  // reachable only by a human who happened to type the territory by hand --
  // which is why it had zero invokers despite exiting 1 correctly. Explicit
  // --territory still wins; this only fills the gap.
  if (!values.territory && env[laneScope.ENV_VAR]) {
    try {
      values.territory = laneScope.parse(env[laneScope.ENV_VAR]).territory.join(';');
      values.territorySource = laneScope.ENV_VAR;
    } catch (error) {
      fail('LANE_TERRITORY_ARGS', `${laneScope.ENV_VAR} was set but did not parse: ${error.message}`);
    }
  }
  for (const required of ['worktree', 'territory', 'base']) {
    if (!values[required]) fail('LANE_TERRITORY_ARGS', `Missing --${required}. Usage: --worktree <dir> --territory "<a;b;c>" --base <ref> (territory may instead come from ${laneScope.ENV_VAR})`);
  }
  return values;
}

function git(worktree, args) {
  return execFileSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: safeLaunchEnvironment(process.env, { context: 'lane territory git' })
  }).trim();
}

function normalize(relativePath) {
  return relativePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

// A territory entry admits a changed path when the path equals the entry, sits
// under it as a directory prefix, or matches the literal prefix before the
// entry's first glob character. NEWLY ADDED files under docs/coordinator (a
// lane's own report) and the runtime lane-question file are admitted; a
// MODIFICATION to an existing docs/coordinator file (program doctrine) still
// requires declared territory — council finding: a blanket carve-out would
// let a lane rewrite doctrine undetected.
const ADDED_ONLY_ALLOWED_PREFIXES = ['docs/coordinator/'];
const ALWAYS_ALLOWED_PATHS = ['lane-questions.md'];

function admits(entry, changedPath) {
  const globIndex = entry.search(/[*?]/);
  const literal = normalize(globIndex === -1 ? entry : entry.slice(0, globIndex));
  const candidate = normalize(changedPath);
  if (!literal) return false;
  const prefix = literal.endsWith('/') ? literal : `${literal}/`;
  return candidate === literal || candidate.startsWith(prefix)
    || (globIndex !== -1 && candidate.startsWith(literal));
}

function main() {
  const values = parseArgs(process.argv.slice(2));
  const worktree = path.resolve(values.worktree);
  let territory;
  try {
    territory = laneScope.parseTerritory(values.territory);
  } catch (error) {
    fail('LANE_TERRITORY_ARGS', `territory did not parse: ${error.message}`);
  }
  let mergeBase;
  try {
    mergeBase = git(worktree, ['merge-base', values.base, 'HEAD']);
  } catch (error) {
    fail('LANE_TERRITORY_GIT', `merge-base ${values.base}..HEAD failed: ${String(error.message).slice(0, 200)}`);
  }
  let changed;
  try {
    changed = git(worktree, ['diff', '--name-status', `${mergeBase}..HEAD`])
      .split('\n').map(line => line.trim()).filter(Boolean)
      .map(line => {
        const parts = line.split('\t');
        // Renames/copies carry two paths; the destination is what lands.
        return { status: parts[0][0], path: parts[parts.length - 1] };
      });
  } catch (error) {
    fail('LANE_TERRITORY_GIT', `diff failed: ${String(error.message).slice(0, 200)}`);
  }
  // ABSENCE IS DATA: a lane whose fork-point diff names zero changed files has
  // supplied no paths for this gate to measure. `violations.length === 0` is
  // true both when every measured path sat inside the territory AND when
  // nothing was measured at all, so without this branch the CLEAN verdict and
  // exit 0 below cannot tell a checked lane from an unchecked one -- a merge
  // gate reporting an unmeasured lane as confidently clean. Refuse instead, on
  // the same single-JSON-line stdout contract every other refusal here uses.
  // This is deliberately NOT a silent exit 0 skip: an empty input is a named,
  // non-zero outcome that says the lane was not counted as a pass.
  if (changed.length === 0) {
    fail('LANE_TERRITORY_EMPTY', `No files changed between merge-base ${mergeBase} (fork point with ${values.base}) and HEAD, so zero paths were measured against the declared territory. NOT counted as a pass -- an unmeasured lane is not a clean lane. Check that --base names the ref this lane actually forked from, and re-run once the lane has committed work.`);
  }
  const violations = changed.filter(({ status, path: changedPath }) => {
    const candidate = normalize(changedPath);
    if (ALWAYS_ALLOWED_PATHS.includes(candidate)) return false;
    if (status === 'A' && ADDED_ONLY_ALLOWED_PREFIXES.some(prefix => candidate.startsWith(prefix))) return false;
    return !territory.some(entry => admits(entry, changedPath));
  }).map(({ status, path: changedPath }) => `${status} ${changedPath}`);
  const result = {
    ok: violations.length === 0,
    code: violations.length === 0 ? 'LANE_TERRITORY_CLEAN' : 'LANE_TERRITORY_VIOLATION',
    // Name where the territory came from: a gate that read its own boundary
    // from an env var must not look identical to one a human vouched for.
    territorySource: values.territorySource || '--territory',
    base: values.base,
    mergeBase,
    changedCount: changed.length,
    violations
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(violations.length === 0 ? 0 : 1);
}

// GUARDED so the boundary logic can be REUSED rather than reimplemented.
// Before this guard, `require`-ing this file ran main(), which parses argv and
// calls process.exit -- so any other tool that wanted to ask "does this
// territory admit this path?" had no way to ask, and the only remaining option
// was to write a second admission rule somewhere else. Two subtly different
// definitions of the same boundary is worse than one imperfect definition:
// they disagree at exactly the edge cases the boundary exists to police.
// tools/agent-territory-claim.js imports `admits` and `normalize` from here.
if (require.main === module) main();

module.exports = Object.freeze({ admits, normalize, ADDED_ONLY_ALLOWED_PREFIXES, ALWAYS_ALLOWED_PATHS });
