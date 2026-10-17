#!/usr/bin/env node
'use strict';

// Only the generated generic-worker entry starts this fixed host MCP server.
function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== '--state-root'
    || typeof argv[1] !== 'string' || !require('node:path').isAbsolute(argv[1])) {
    throw Object.assign(new Error('Usage: toolsenabled-generic-host --state-root ABSOLUTE_HOST_CONTAINER'), { code: 'OPENSHELL_WORKER_HOST_USAGE' });
  }
  return { stateRoot: argv[1] };
}
async function main(argv) {
  process.umask(0o077);
  return require('../src/lib/host-generic-entry').serveGenericHost(parseArgs(argv));
}
module.exports = Object.freeze({ parseArgs, main });
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error.code || 'OPENSHELL_WORKER_HOST_FAILED'}: ${error.message}\n`);
  process.exitCode = 1;
});
