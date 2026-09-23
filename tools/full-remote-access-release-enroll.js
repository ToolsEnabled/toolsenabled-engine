#!/usr/bin/env node
'use strict';

// Fixed local enrollment entry point for the registry-derived coordinator. FRA control-plane staging
// is a separate reviewed operation; reconnect must never expand into an
// implicit whole-ToolsEnabled promotion. The enrollment implementation itself
// verifies the local FRA-only runtime anchor before binding 8793.

const { main: runCredentialEnrollment } = require('./full-remote-access-enroll-token');

async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    throw Object.assign(new Error('FRA_RELEASE_ENROLL_ARGUMENTS_REFUSED'), {
      code: 'FRA_RELEASE_ENROLL_ARGUMENTS_REFUSED'
    });
  }
  const enroll = dependencies.runCredentialEnrollment || runCredentialEnrollment;
  const writeOutput = dependencies.writeOutput || (text => process.stdout.write(text));
  writeOutput(JSON.stringify({
    ok: true,
    code: 'FRA_CONTROL_PLANE_ENROLLMENT_STARTING',
    secretValuesEmitted: false
  }) + '\n');
  await enroll();
}

if (require.main === module) {
  main().catch(error => {
    const code = error && /^[A-Z0-9_]{1,80}$/.test(error.code || error.message)
      ? (error.code || error.message) : 'FRA_RELEASE_ENROLL_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({ main });
