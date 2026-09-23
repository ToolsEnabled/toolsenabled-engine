#!/usr/bin/env node
'use strict';

// CLI for the UAC delegation client (src/lib/uac-delegation-client.js).
//
//   node tools/uac-run.js --list
//   node tools/uac-run.js --status
//   node tools/uac-run.js <operation-id>
//
// <operation-id> must be one of the ids in config/uac-delegation-allowlist.json.
// There is deliberately NO way to pass an executable, arguments, a path, or a
// pid: the id is the entire caller input, and it is validated locally and again
// by the elevated helper. Output is JSON on stdout; the per-boot token never
// appears in it.
//
// Exit codes: 0 accepted and every step succeeded; 1 refused, or a step failed,
// or a precondition failed; 2 the outcome is UNKNOWN (response timeout after the
// request was sent -- the operation may have executed).

const client = require('../src/lib/uac-delegation-client');

function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function main(argv) {
  const args = argv.filter(arg => arg !== '');
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    print({
      usage: 'node tools/uac-run.js <operation-id> | --list | --status',
      operations: client.allowedOperations(),
      note: 'Only an allowlisted operation id is accepted. No command, argument, path, or pid can be passed.'
    });
    return 0;
  }
  if (args[0] === '--list') { print({ operations: client.allowedOperations() }); return 0; }
  if (args[0] === '--status') {
    print({ task: client.HELPER_TASK_NAME, registered: client.helperTaskRegistered(), operations: client.allowedOperations() });
    return 0;
  }
  if (args.length !== 1 || args[0].startsWith('-')) {
    print({ ok: false, error: 'exactly one allowlisted operation id is required.', operations: client.allowedOperations() });
    return 1;
  }

  try {
    const result = await client.runOperation(args[0]);
    print(result);
    return result.ok ? 0 : 1;
  } catch (error) {
    const unknown = Boolean(error && error.outcomeUnknown);
    print({
      ok: false,
      outcomeUnknown: unknown,
      code: (error && error.code) || 'UAC_CLIENT_ERROR',
      error: client.scrub(error && error.message)
    });
    return unknown ? 2 : 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(error => { print({ ok: false, error: client.scrub(error && error.message) }); process.exitCode = 1; });
}

module.exports = Object.freeze({ main });
