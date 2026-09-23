#!/usr/bin/env node
'use strict';

// Fixed no-argument CLI for the Q39 refresh adapter.  It never accepts a
// command, operation id, argv, path, PID, or state-file selector.

const refresh = require('../src/lib/supervision/process-visibility-refresh.js');

async function main(argv, { refreshProcessVisibility = refresh.refreshProcessVisibility, write = process.stdout.write.bind(process.stdout) } = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    write(`${JSON.stringify(Object.freeze({
      status: 'refused',
      code: 'PROCESS_VISIBILITY_REFRESH_ARGS_REFUSED',
      operationId: refresh.OPERATION_ID
    }))}\n`);
    return 1;
  }
  const receipt = await refreshProcessVisibility();
  write(`${JSON.stringify(receipt)}\n`);
  return receipt.status === 'refreshed' ? 0 : (receipt.status === 'unknown' ? 2 : 1);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; })
    .catch(() => { process.stdout.write('{"status":"failed","code":"PROCESS_VISIBILITY_REFRESH_FAILED","operationId":"collect-process-visibility"}\n'); process.exitCode = 1; });
}

module.exports = Object.freeze({ main });
