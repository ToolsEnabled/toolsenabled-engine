#!/usr/bin/env node
'use strict';

// Execute the package's real pretest -> test -> posttest lifecycle, not a
// second hand-maintained test selection and not the broader census --all.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { configure, isolatedTemporaryRoot } = require('../tests/lib/isolated-environment');
const { safeLaunchEnvironment } = require('../src/lib/supervision/launch-environment');
const { deleteEnvNames } = require('../src/lib/env-scrub');
const { resolveCommand } = require('./check-chain-runner');
const { STRICT_ENV, OPT_IN_TESTS } = require('./lib/test-completion');
const lifecycleRecords = require('./lib/strict-lifecycle-record');

const ROOT = path.resolve(__dirname, '..');

function strictEnvironment(scratch, baseEnvironment = process.env, root = ROOT) {
  const environment = lifecycleRecords.clearAuthority(safeLaunchEnvironment(baseEnvironment));
  // Nested npm must not omit lifecycle hooks because of ambient npm config.
  // NODE_TEST_CONTEXT belongs to the invoking self-test, not these children.
  deleteEnvNames(environment, ['NODE_TEST_CONTEXT', 'npm_config_ignore_scripts', 'NODE_OPTIONS', STRICT_ENV,
    'npm_config_cache', 'npm_config_userconfig', 'npm_config_update_notifier', 'npm_config_offline']);
  configure(scratch, environment);
  environment[STRICT_ENV] = '1';
  environment.npm_config_ignore_scripts = 'false';
  environment.npm_config_update_notifier = 'false';
  environment.npm_config_offline = 'true';
  environment.npm_config_cache = path.join(scratch, 'npm-cache');
  environment.npm_config_userconfig = path.join(scratch, 'unused-user.npmrc');
  environment.MC_CANONICAL_ROOT = root;
  environment.TOOLSENABLED_TEST_RUN_OUTPUT_DIR = path.join(scratch, 'measurements');
  environment.APPDATA = path.join(scratch, 'roaming');
  environment.TEMP = environment.TMP = path.join(scratch, 'temp');
  fs.mkdirSync(environment.APPDATA, { recursive: true });
  fs.mkdirSync(environment.TEMP, { recursive: true });
  return environment;
}

function runStrict({ root = ROOT, spawn = spawnSync, temporaryRoot = isolatedTemporaryRoot(), environment = process.env } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (typeof pkg.scripts?.test !== 'string' || !pkg.scripts.test.trim()) throw new Error('package.json declares no test lifecycle');
  const declaredLifecycle = ['pretest', 'test', 'posttest'].filter(name => typeof pkg.scripts[name] === 'string')
    .map(name => ({ name, command: pkg.scripts[name] }));
  const scratch = fs.mkdtempSync(path.join(temporaryRoot, 'te-strict-'));
  const reportPath = path.join(scratch, 'strict-lifecycle.json');
  const report = {
    schemaVersion: 2, startedAt: new Date().toISOString(), completed: false,
    command: 'npm run test', root, declaredLifecycle,
    outsideProof: OPT_IN_TESTS.map(entry => ({ ...entry, status: 'UNEXECUTED' })),
    limits: ['Standalone assertion programs report process exit, not assertion counts.',
      'Within-suite reconciled skips are UNEXECUTED, not passes.',
      'Clean Git HEAD/tree and selected recipe/test hashes are checked before/after; ignored runtime files, dependency closure, and transient in-run changes are not attested.',
      'This is test-state isolation, not an OS/network sandbox or proof that arbitrary test code cannot access owner state.']
  };
  const save = () => fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  save();
  process.stdout.write(`Strict product lifecycle: npm run test (declared pre/test/post hooks)\nReport: ${reportPath}\n`);
  const command = resolveCommand({ npm: 'test' });
  try {
    const context = lifecycleRecords.createContract(root, path.join(scratch, 'proof'));
    report.contract = { path: path.join(context.directory, 'contract.json'), digest: context.contractDigest,
      runId: context.contract.runId, source: context.contract.source, recipeDigest: context.contract.recipeDigest };
    report.outsideProof.push(...context.contract.recipe.retired);
    for (const entry of report.outsideProof) process.stdout.write(`${entry.status} outside proof: ${entry.file || entry.script}; ${entry.reason || entry.coverage}\n`);
    save();
    const rootNode = context.contract.recipe.nodes.find(node => node.id === 'npm:test');
    lifecycleRecords.record(context, rootNode, 'start');
    const result = spawn(command.file, command.args, {
      cwd: root, shell: command.shell, windowsHide: true, stdio: 'inherit',
      env: lifecycleRecords.proofEnvironment(context, rootNode.id, strictEnvironment(scratch, environment, root))
    });
    const code = result.error || result.signal || !Number.isInteger(result.status) ? 1 : result.status;
    report.npm = { exitCode: result.status, signal: result.signal || null, error: result.error?.code || null };
    lifecycleRecords.record(context, rootNode, 'end', { status: code === 0 ? 'pass' : 'fail', ...report.npm });
    if (code !== 0) {
      report.exitCode = code;
      process.stdout.write('Strict lifecycle NONPASS: actual npm did not complete successfully.\n');
      return code;
    }
    report.evidence = lifecycleRecords.verify(context, { terminal: true });
    report.completed = true;
    report.exitCode = 0;
    process.stdout.write('Strict lifecycle PASS: declared receipts and actual npm terminal success reconcile; outside-proof coverage remains unexecuted/unimplemented.\n');
    return 0;
  } catch (error) {
    report.exitCode = 2;
    report.error = error.message;
    process.stderr.write(`Strict lifecycle could not complete: ${error.message}\n`);
    return 2;
  } finally {
    report.finishedAt = new Date().toISOString();
    save();
  }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw new Error('test:strict accepts no alternate selection, quick mode, or waiver flags');
    process.exitCode = runStrict();
  } catch (error) {
    process.stderr.write(`Strict lifecycle could not complete: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { runStrict, strictEnvironment };
