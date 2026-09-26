#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const acceptance = require('../src/lib/dependency-acceptance');
const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');

function parseArgs(argv) {
  const command = argv[0];
  const values = {};
  const flags = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === 'save-dev') { flags.add(key); continue; }
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`missing value for --${key}`);
    values[key] = argv[index + 1];
    index += 1;
  }
  return { command, values, flags };
}

function recordInput(values) {
  return {
    name: values.name,
    kind: values.kind,
    license: values.license,
    reuseType: values['reuse-type']
  };
}

function installDependency(input, options = {}) {
  const normalized = acceptance.normalizeRecord(input);
  const packageSpec = options.packageSpec || normalized.name;
  const args = ['install', packageSpec];
  if (options.saveDev) args.push('--save-dev');
  const run = options.run || ((command, commandArgs) => spawnSync(command, commandArgs, {
    cwd: acceptance.ROOT,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    stdio: 'inherit',
    env: safeLaunchEnvironment(process.env, { context: 'dependency acceptance install' })
  }));
  const result = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`npm install failed with exit ${result.status}`);
    error.code = 'DEPENDENCY_INSTALL_FAILED';
    error.status = result.status;
    throw error;
  }
  return acceptance.captureDependency(normalized, options);
}

function usage() {
  return [
    'Usage:',
    '  node tools/dependency-acceptance.js capture --name <pkg> --kind <crypto|protocol|other> [--license <SPDX>] [--reuse-type <type>]',
    '  node tools/dependency-acceptance.js install --name <pkg> --kind <crypto|protocol|other> [--license <SPDX>] [--reuse-type <type>] [--spec <pkg@version>] [--save-dev]',
    '  node tools/dependency-acceptance.js check --event <distribution|shipping|third-party-interaction>',
    `Reuse types: ${acceptance.REUSE_TYPES.join(', ')}`
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  let result;
  if (parsed.command === 'capture') {
    result = acceptance.captureDependency(recordInput(parsed.values));
  } else if (parsed.command === 'install') {
    result = installDependency(recordInput(parsed.values), {
      packageSpec: parsed.values.spec,
      saveDev: parsed.flags.has('save-dev')
    });
  } else if (parsed.command === 'check') {
    result = acceptance.assertEventAllowed({ event: parsed.values.event });
  } else {
    throw new Error(usage());
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${String(error && error.message || error)}\n${usage()}\n`);
    process.exitCode = 2;
  }
}

module.exports = Object.freeze({ parseArgs, recordInput, installDependency, main, usage });
