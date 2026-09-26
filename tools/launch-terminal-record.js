#!/usr/bin/env node
'use strict';

// Safe completion companion to tools/spawn-record.js.  The CLI has no free
// text/evidence flag: terminal events carry only a launch binding, one closed
// state, and a writer-generated timestamp.

const outcome = require('../src/lib/launch-outcome');

const USAGE = `Record one terminal state for a tracked launch (Q27).

  node tools/launch-terminal-record.js --launch <launchId> --state <state> [--json]

Required
  --launch <id>       launch id emitted by tools/spawn-record.js
  --state <state>     completed | failed | cancelled

The launch record is never rewritten. This writes exactly one signed terminal
receipt bound to its audited record hash. There is no free-text evidence,
prompt, path, token, or message field.

Exit codes: 0 recorded, 2 bad usage, 3 refused by the lifecycle contract.
`;

function parseArgs(argv) {
  const flags = new Map();
  const allowed = new Set(['launch', 'state', 'json', 'help']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unexpected argument "${token}"`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`unknown option "--${key}"`);
    if (key === 'json' || key === 'help') { flags.set(key, true); continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    flags.set(key, value);
    index += 1;
  }
  return flags;
}

function recordTerminal(options = {}, dependencies = {}) {
  return outcome.recordTerminal({ launchId: options.launchId, terminalState: options.terminalState }, dependencies);
}

function assertRecordedResult(result, launchId, terminalState) {
  const hashPattern = /^[a-f0-9]{64}$/;
  if (!result || result.launchId !== launchId || result.terminalState !== terminalState ||
      !hashPattern.test(result.receiptHash) || !Number.isSafeInteger(result.auditSequence) || result.auditSequence < 1 ||
      !hashPattern.test(result.auditEventHash)) {
    const error = new Error('The terminal receipt result was incomplete or did not match the request.');
    error.code = 'LAUNCH_TERMINAL_FAILED';
    throw error;
  }
}

function main(argv) {
  let flags;
  try { flags = parseArgs(argv); }
  catch (error) { process.stderr.write(`${error.message}\n\n${USAGE}`); return 2; }
  if (flags.get('help') || argv.length === 0) { process.stdout.write(USAGE); return flags.get('help') ? 0 : 2; }
  const launchId = flags.get('launch');
  const terminalState = flags.get('state');
  if (!launchId || !terminalState) { process.stderr.write(`--launch and --state are required\n\n${USAGE}`); return 2; }
  let result;
  try {
    result = recordTerminal({ launchId, terminalState });
    assertRecordedResult(result, launchId, terminalState);
  }
  catch (error) {
    const code = error && error.code ? error.code : 'LAUNCH_TERMINAL_FAILED';
    process.stderr.write(`${code}: ${error && error.message ? error.message : String(error)}\n`);
    return 3;
  }
  if (flags.get('json')) {
    process.stdout.write(`${JSON.stringify({
      launchId: result.launchId, terminalState: result.terminalState,
      receiptHash: result.receiptHash, auditSequence: result.auditSequence, auditEventHash: result.auditEventHash
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.launchId} ${result.terminalState}\n`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { USAGE, parseArgs, recordTerminal, main };
