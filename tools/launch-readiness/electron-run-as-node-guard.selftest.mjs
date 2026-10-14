#!/usr/bin/env node

// ELECTRON_RUN_AS_NODE guard for the launch-readiness harnesses.
//
// Agent harnesses export ELECTRON_RUN_AS_NODE=1. That turns an Electron binary
// into plain Node: launched with no script it reads stdin, hits EOF, and exits
// 0 silently with no window. The signature is indistinguishable from a crash.
// It produced a confident and wrong "the product silently exits on launch"
// root cause, cost an afternoon, and is very likely the original Machine-B
// launch blocker behind days of work across two machines.
//
// The Electron app itself lives in the mission-control repo, and the guard for
// its harnesses lives there too (tools/test/electron-run-as-node-harness-guard
// .test.mjs). What lives HERE is tools/launch-readiness/clean-env-launch.mjs,
// which takes an operator-supplied --exe and launches it. That is precisely the
// exposed shape: a human or an agent invoking a packaged exe path directly.
//
// This file checks the rule twice, deliberately, because the two checks fail in
// different ways:
//
//   1. BEHAVIOURALLY. buildHostileEnvironment() is called and the resulting
//      object is inspected. This is the real question -- does the child
//      actually not receive the variable -- and no regex can answer it.
//   2. STRUCTURALLY. Every harness in this directory that spawns a process and
//      accepts an operator-supplied executable must show a scrub. Check 1
//      cannot see a harness added next week; this one can. That gap is the
//      whole reason this class recurred: the defence existed in code and
//      existed nowhere as a rule, so nothing carried it to the next file.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHostileEnvironment } from './clean-env-launch.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 1. Behavioural: the environment handed to a launched executable is clean.
// ---------------------------------------------------------------------------
const poisoned = {
  PATH: process.env.PATH ?? '',
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_NO_ATTACH_CONSOLE: '1',
  KEEP_ME: 'untouched',
};
const { env } = await buildHostileEnvironment(poisoned, path.join(DIRECTORY, 'nonexistent-profile-root'));

assert.equal(
  Object.hasOwn(env, 'ELECTRON_RUN_AS_NODE'),
  false,
  'buildHostileEnvironment must REMOVE ELECTRON_RUN_AS_NODE. With it set, a packaged Electron '
    + 'app starts as plain Node, reads stdin, hits EOF and exits 0 with no window -- which this '
    + "harness would then report as the product failing to launch.",
);
assert.equal(
  Object.hasOwn(env, 'ELECTRON_NO_ATTACH_CONSOLE'),
  false,
  'buildHostileEnvironment must also remove ELECTRON_NO_ATTACH_CONSOLE.',
);
assert.equal(env.KEEP_ME, 'untouched', 'the scrub must not empty the whole environment; that would prove nothing.');

// ---------------------------------------------------------------------------
// 2. Structural: no harness in this directory launches an exe without a scrub.
// ---------------------------------------------------------------------------
// "Spawns a FOREIGN process." The negative lookahead matters: a harness whose
// only spawn is `spawnSync(process.execPath, ...)` re-enters the very Node
// runtime already executing this guard. That is not an operator-supplied
// executable and cannot be an Electron binary mis-started as Node, so it is not
// in the risk class -- while a driver that merely PASSES `--exe` through to a
// child audit does match the old, argument-free pattern and would be reported
// as an offender that has nothing to scrub. Narrowed 2026-08-13 when
// run-launch-audits.mjs was added; the fail-closed anchor on
// clean-env-launch.mjs below is what keeps this from quietly matching nothing.
const SPAWNS_A_PROCESS = /(?:^|[^\w.])(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*(?!process\.execPath\b)/;
const TAKES_AN_OPERATOR_EXECUTABLE = /--exe\b/;
const SCRUBS_ELECTRON_VARIABLES = [
  /delete\s+[A-Za-z_$][\w$.]*\.ELECTRON_RUN_AS_NODE/, // named delete
  /(['"])ELECTRON_\1/,                                 // prefix scrub list
  /guiEnvironment\s*\(/,                               // the shared helper
];

const entries = await readdir(DIRECTORY, { withFileTypes: true });
const harnesses = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.selftest.mjs'))
  .map((entry) => entry.name)
  .sort();

assert.ok(harnesses.length > 0, `no harnesses found in ${DIRECTORY}; this check would pass while inspecting nothing`);

const launchers = [];
for (const name of harnesses) {
  const source = await readFile(path.join(DIRECTORY, name), 'utf8');
  if (!SPAWNS_A_PROCESS.test(source)) continue;
  if (!TAKES_AN_OPERATOR_EXECUTABLE.test(source)) continue;
  launchers.push({ name, scrubs: SCRUBS_ELECTRON_VARIABLES.some((pattern) => pattern.test(source)) });
}

// Fail closed. A scan that matches nothing must never read as a pass -- the
// same rule tools/package-check.js applies when it observes no repository
// files. clean-env-launch.mjs is the harness this directory exists for; if it
// stops matching, the detection drifted rather than the risk disappearing.
assert.ok(
  launchers.some((entry) => entry.name === 'clean-env-launch.mjs'),
  'clean-env-launch.mjs launches an operator-supplied executable but was not detected as one. '
    + 'The detection patterns have drifted and this guard is now inspecting nothing that matters.',
);

const offenders = launchers.filter((entry) => !entry.scrubs).map((entry) => entry.name);
assert.deepEqual(
  offenders,
  [],
  `these launch-readiness harnesses spawn an operator-supplied executable without scrubbing `
    + `ELECTRON_RUN_AS_NODE from the child environment: ${offenders.join(', ')}. `
    + 'Route the child environment through buildHostileEnvironment() in clean-env-launch.mjs '
    + 'rather than reimplementing the scrub.',
);

console.log(
  `electron-run-as-node-guard: OK (${harnesses.length} harness(es) inspected, `
    + `${launchers.length} launch an operator-supplied executable, all scrub ELECTRON_*)`,
);
