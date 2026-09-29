#!/usr/bin/env node
'use strict';

// Closes ledger row R70: "no automated check that app\capability\** matches
// the engine source. generate-mirrors --check covers three onboarding files
// only." generate-mirrors.js --check is correct as far as it goes -- it
// verifies two onboarding templates and one .ps1 block, all three DERIVED
// FROM THIS REPO'S OWN SOURCE. It never looks at another checkout at all, so
// it cannot be the thing that verifies an app checkout's packed capability
// payload against this engine's source.
//
// That comparison already exists: the app repo carries
// tools/check-payload-current.mjs, which walks a staged capability/ directory
// and sha256-compares every file against its declared source (or, for
// deliberately neutralized files, against capability-defaults/), naming every
// stale or orphaned file and exiting non-zero on any drift. What it cannot do
// on its own is bind itself to THIS engine checkout without the caller
// hand-supplying an exact, clean Git commit through
// TOOLSENABLED_SOURCE/TOOLSENABLED_SOURCE_REF -- there was no engine-side
// tool that did that binding, so nothing in this repo's own tooling could ask
// "does that app checkout's mirror match ME" without manual setup.
//
// This script is that binding, run from the engine side: it resolves this
// engine checkout's own exact HEAD commit, refuses if the tree is not clean
// (an unclean source cannot be named by a single commit), and forwards to the
// app checkout's own checker with that binding supplied. It reuses the app's
// comparison logic rather than re-implementing sha256 walking a second time,
// because a second implementation is a second place for the two to drift from
// each other.
//
// USAGE: node tools/check-capability-mirror.js <path-to-app-checkout> [staged-directory]
//   staged-directory defaults to <app-checkout>/capability, the default
//   output of the app's `npm run pack:capability`. Requires that directory to
//   already be staged; this script does not stage it (staging can require
//   the app's owner-data guard to be configured, which is a privacy decision
//   for whoever runs the build, not something a mirror-drift check should do
//   on their behalf).
//
// EXIT CODES: 0 when every staged file matches this engine checkout (or the
// app's capability-defaults/ for files the manifest marks neutral); 1 when
// the app checkout, its checker, or the staged directory cannot be found, or
// this engine checkout is not clean, or the forwarded check itself reports
// drift.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

function resolveEngineRoot(explicit) {
  return path.resolve(explicit || path.join(__dirname, '..'));
}

function git(engineRoot, args) {
  const result = spawnSync('git', args, {
    cwd: engineRoot, encoding: 'utf8', windowsHide: true,
    env: safeLaunchEnvironment()
  });
  if (result.error) throw new Error(`git ${args.join(' ')} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim();
}

// Exported so tests can exercise the binding logic against a throwaway Git
// repository instead of mutating this real checkout to test the dirty path.
function resolveEngineBinding(engineRoot) {
  const status = git(engineRoot, ['status', '--porcelain']);
  if (status) {
    throw new Error(
      `${engineRoot} is not a clean checkout, so it cannot be named by one exact commit. `
      + 'Commit or discard the pending changes before checking the capability mirror against it.',
    );
  }
  const head = git(engineRoot, ['rev-parse', 'HEAD']);
  return { engineRoot, head };
}

function runCheck({ appRoot, stagedDirectory, engineRoot, spawn = spawnSync }) {
  const resolvedAppRoot = path.resolve(appRoot);
  const checkerFile = path.join(resolvedAppRoot, 'tools', 'check-payload-current.mjs');
  if (!fs.existsSync(checkerFile)) {
    return {
      ok: false,
      message: `${checkerFile} not found -- ${resolvedAppRoot} does not look like a toolsenabled app checkout`,
    };
  }

  const staged = path.resolve(stagedDirectory || path.join(resolvedAppRoot, 'capability'));

  let binding;
  try {
    binding = resolveEngineBinding(engineRoot);
  } catch (error) {
    return { ok: false, message: error.message };
  }

  const result = spawn(process.execPath, [checkerFile, staged], {
    cwd: resolvedAppRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: safeLaunchEnvironment({ ...process.env, TOOLSENABLED_SOURCE: binding.engineRoot, TOOLSENABLED_SOURCE_REF: binding.head }),
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    exitCode: result.status,
  };
}

function main() {
  const appRoot = process.argv[2];
  const stagedDirectory = process.argv[3];
  if (!appRoot) {
    console.error('usage: node tools/check-capability-mirror.js <path-to-app-checkout> [staged-directory]');
    process.exitCode = 1;
    return;
  }
  const engineRoot = resolveEngineRoot(process.env.CAPABILITY_MIRROR_ENGINE_ROOT);
  const result = runCheck({ appRoot, stagedDirectory, engineRoot });
  if (result.message) {
    console.error(`[check-capability-mirror] ${result.message}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode ?? 1;
}

if (require.main === module) main();

module.exports = { runCheck, resolveEngineBinding, resolveEngineRoot };
