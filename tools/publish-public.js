#!/usr/bin/env node
'use strict';

// RETIRED PRIVATE-SOURCE TOMBSTONE.
//
// ToolsEnabled/engine and ToolsEnabled/app remain private.  This filename is
// retained only so an old operator command, automation fragment, or agent
// memory fails with one explicit policy result instead of MODULE_NOT_FOUND.
// There is deliberately no argument parser, owner-token compatibility path,
// filesystem import, git subprocess, remote operation, or target preparation
// code in this module.  A role direction is prose, and the former token was
// prose too; neither can authorize source publication.

const RETIREMENT_CODE = 'PUBLISH_PUBLIC_RETIRED';
const RETIREMENT_MESSAGE =
  'Source publication is retired. ToolsEnabled/engine and ToolsEnabled/app remain private; ' +
  'no flag, token, target, role, or agent instruction authorizes generating a public-source tree.';

class PublishRefusal extends Error {
  constructor() {
    super(RETIREMENT_MESSAGE);
    this.name = 'PublishRefusal';
    this.code = RETIREMENT_CODE;
  }
}

function refusePublication() {
  throw new PublishRefusal();
}

function main(_argv = process.argv.slice(2)) {
  // Every spelling, including --help, --check and the former fully-authorized
  // --publish form, converges on the same permanent refusal before any input is
  // inspected or any external capability is loaded.
  refusePublication();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    if (error instanceof PublishRefusal) {
      process.stderr.write(`REFUSED (${error.code}): ${error.message}\n`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}

module.exports = Object.freeze({
  RETIREMENT_CODE,
  RETIREMENT_MESSAGE,
  PublishRefusal,
  refusePublication,
  main
});
