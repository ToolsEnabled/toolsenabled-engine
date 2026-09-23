#!/usr/bin/env node
'use strict';

// Dispatcher-facing R1232 entry point.  Default output is either the complete
// prompt block or zero bytes when the owner has not opted in, so a dispatcher
// may safely prepend stdout without adding its own consent logic.

const statusInjection = require('../src/lib/status-injection');

function usage(message) {
  const error = new Error(message || 'Invalid status-snapshot arguments.');
  error.code = 'STATUS_SNAPSHOT_USAGE';
  throw error;
}

function parseArgs(argv) {
  const result = { json: false, input: {} };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      if (result.json) usage('Duplicate --json.');
      result.json = true;
      continue;
    }
    const kind = ({ '--agent': 'agentId', '--lane': 'laneId', '--host': 'hostId' })[argument];
    if (!kind || index + 1 >= argv.length || Object.hasOwn(result.input, kind)) {
      usage(`Unknown, duplicate, or incomplete option ${argument}.`);
    }
    result.input[kind] = argv[++index];
  }
  return Object.freeze({ json: result.json, input: Object.freeze(result.input) });
}

async function run(argv = process.argv, dependencies = {}) {
  const options = parseArgs(argv);
  const snapshot = await statusInjection.collectStatusSnapshot({ input: options.input }, dependencies);
  if (options.json) return `${JSON.stringify(snapshot, null, 2)}\n`;
  const block = statusInjection.renderStatusBlock(snapshot);
  return block ? `${block}\n` : '';
}

async function main() {
  try {
    process.stdout.write(await run());
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'STATUS_SNAPSHOT_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = Object.freeze({ parseArgs, run });
