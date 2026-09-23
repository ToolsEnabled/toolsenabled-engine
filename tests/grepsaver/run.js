#!/usr/bin/env node
'use strict';

// One bounded, isolated command for the complete GrepSaver layer.

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const runner = path.join(ROOT, 'tests', 'run-isolated.js');
const suites = [
  'tests/grepsaver/grepsaver.js',
  'tests/grepsaver/reindex.js',
  'tests/capability-recall/allowlist.test.js',
  'tests/grepsaver/orient.js',
  'tests/grepsaver/tooldigest.js',
  'tests/agent-preflight.js',
];
const started = Date.now();
const result = spawnSync(process.execPath, [runner, ...suites], {
  cwd: ROOT,
  stdio: 'inherit',
  windowsHide: true,
  timeout: 120_000,
});

if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = Number.isInteger(result.status) ? result.status : 1;
else process.stdout.write(`grepsaver aggregate passed (${suites.length} suites, ${Date.now() - started} ms).\n`);
