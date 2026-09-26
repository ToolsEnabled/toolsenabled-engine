#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classifyRun, classifyToolchainResolution, reducedPath, resolveToolchain, runTracked } from './clean-env-launch.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'clean-env-launch-selftest-'));
try {
  const fixtures = {
    zero: 'process.exit(0);',
    three: 'process.exit(3);',
    hangs: 'setInterval(() => {}, 1000);',
  };
  for (const [name, source] of Object.entries(fixtures)) await writeFile(path.join(root, `${name}.mjs`), source, 'utf8');

  const zero = await runTracked(process.execPath, [path.join(root, 'zero.mjs')], { env: process.env, timeout: 2_000 });
  const zeroClass = classifyRun(zero);
  assert.equal(zero.exitCode, 0);
  assert.equal(zeroClass.failed, true, 'an immediate clean exit without a window must be red');

  const three = await runTracked(process.execPath, [path.join(root, 'three.mjs')], { env: process.env, timeout: 2_000 });
  assert.equal(three.exitCode, 3);
  assert.equal(classifyRun(three).failed, true, 'exit 3 must be red');

  const hangs = await runTracked(process.execPath, [path.join(root, 'hangs.mjs')], { env: process.env, timeout: 150 });
  const hangsClass = classifyRun(hangs);
  assert.equal(hangs.timedOut, true);
  assert.equal(hangs.exitCode, null);
  assert.equal(hangsClass.failed, false, 'still running at timeout must not be a failure');

  const resolution = await resolveToolchain(reducedPath('C:\\Windows'));
  assert.deepEqual(resolution, { node: [], npm: [], git: [] }, 'reduced PATH must not resolve developer tools');
  assert.equal(classifyToolchainResolution(resolution).failed, false, 'complete empty results prove the named tools unreachable');
  assert.equal(classifyToolchainResolution({}).failed, true, 'an empty enumeration must be unmeasurable, not green');
  assert.equal(classifyToolchainResolution({ node: [], npm: [], git: undefined }).failed, true, 'a missing result must be unmeasurable');
  assert.equal(classifyToolchainResolution({ node: [], npm: [], git: [], python: [] }).failed, true, 'undeclared results must not pass unnamed');
  assert.equal(classifyToolchainResolution({ node: [{ path: 'C:\\locked\\node.exe', skipped: true, error: 'EACCES' }], npm: [], git: [] }).failed, true, 'could-not-read results must be indeterminate failures');
  assert.equal(classifyToolchainResolution({ node: ['C:\\node.exe'], npm: [], git: [] }).failed, true, 'a reachable toolchain must fail the gate, not merely warn');
  console.log(JSON.stringify({ passed: 10, fixtures: ['exit-0-red', 'exit-3-red', 'timeout-green', 'path-clean', 'empty-enumeration-red', 'missing-result-red', 'undeclared-result-red', 'unreadable-red', 'reachable-red'] }));
  console.log('SELFTEST PASS: failing fixtures were red first; timeout fixture and reduced PATH were green.');
} finally {
  await rm(root, { recursive: true, force: true });
}
