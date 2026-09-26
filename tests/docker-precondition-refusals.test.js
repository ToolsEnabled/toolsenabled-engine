#!/usr/bin/env node
'use strict';

// Docker's absence signals belong in the runner summary, not in a raw ENOENT,
// an account-specific assertion, or a child program that prints SKIP and exits
// zero. Exercise the public runner with real absent values; none of these
// assertions reads its registries or pins how the checks are represented.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { strictRequested } = require('../tools/lib/test-completion');
const { deleteEnvNames } = require('../src/lib/env-scrub');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(__dirname, 'run-isolated.js');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-precondition-refusals-'));
let checks = 0;
const failures = [];

function run(suite, env = process.env) {
  const summaryPath = path.join(scratch, `summary-${checks}-${Math.random().toString(36).slice(2)}.json`);
  const child = spawnSync(process.execPath, [RUNNER, '--summary', summaryPath, suite], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000
  });
  assert.equal(child.error, undefined, `${suite}: runner could not start: ${child.error && child.error.message}`);
  assert.equal(fs.existsSync(summaryPath), true, `${suite}: runner wrote no summary`);
  return { child, summary: JSON.parse(fs.readFileSync(summaryPath, 'utf8')) };
}

function expectRefusal(suite, expectedNames, env = process.env) {
  try {
    const observed = run(suite, env);
    assert.notEqual(observed.child.status, 0, `${suite}: absent coverage was reported as a passing run`);
    assert.equal(observed.summary.files.length, 1, `${suite}: expected one summary record`);
    const record = observed.summary.files[0];
    assert.equal(record.status, 'skip', `${suite}: missing precondition was reported as ${record.status}`);
    assert.equal(record.exitCode, null, `${suite}: a refusal must not carry a child success/failure code`);
    for (const expected of expectedNames) {
      assert.match(record.reason, expected, `${suite}: refusal did not name ${expected}`);
    }
    checks += 1;
    process.stdout.write(`  ok  ${suite} refuses and names its missing precondition\n`);
  } catch (error) {
    failures.push({ suite, error });
    process.stderr.write(`  NOT OK  ${suite}: ${error.message}\n`);
  }
}

function withoutCommands() {
  const emptyPath = path.join(scratch, 'empty-command-path');
  fs.mkdirSync(emptyPath, { recursive: true });
  const env = { ...process.env };
  deleteEnvNames(env, ['PATH', 'APPDATA', 'npm_config_prefix']);
  env.PATH = emptyPath;
  env.APPDATA = emptyPath;
  env.npm_config_prefix = emptyPath;
  return env;
}

function expectMissingCodexCli(env) {
  // Strict scope refuses the live provider suite before probing installation
  // prerequisites. Keep that refusal intact AND independently exercise the
  // production resolver with an empty PATH/npm root. This never runs a turn
  // or turns off the inherited strict requirement.
  const modulePath = path.join(ROOT, 'src', 'lib', 'agent-engine', 'codex-process.js');
  const child = spawnSync(process.execPath, ['-e', [
    `const { detectCodexVersion } = require(${JSON.stringify(modulePath)});`,
    'detectCodexVersion({ env: process.env }).then(() => process.exit(0)).catch(error => {',
    '  process.stderr.write(String(error.code));',
    "  process.exit(error.code === 'CODEX_CLI_NOT_FOUND' ? 3 : 4);",
    '});'
  ].join('\n')], {
    cwd: env.PATH, env, encoding: 'utf8', windowsHide: true, timeout: 15_000
  });
  assert.equal(child.error, undefined, 'the production missing-CLI probe must finish');
  assert.equal(child.status, 3, child.stderr || child.stdout);
  assert.match(child.stderr, /CODEX_CLI_NOT_FOUND/);
  checks += 1;
  process.stdout.write('  ok  production Codex resolver reports CODEX_CLI_NOT_FOUND with no commands available\n');
}

try {
  expectRefusal(
    'tests/surface.policy/owner-authorization-surfaces.test.js',
    [/config\/owner-authorization\.json/]
  );
  const commandless = withoutCommands();
  expectRefusal('tests/agent-engine/codex-live-turn.js', strictRequested(commandless)
    ? [/explicit opt-in test/, /outside the unattended strict lifecycle/]
    : [/Codex CLI/, /CODEX_CLI_NOT_FOUND/], commandless);
  expectMissingCodexCli(commandless);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write(`docker precondition refusals: ${checks} checks passed\n`);
if (failures.length) {
  throw new Error(`docker precondition refusals: ${failures.length} check(s) failed`);
}
