#!/usr/bin/env node
'use strict';

const { doctor } = require('./lib/system-status');

const checks = doctor();
process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
if (!checks.policy || !checks.mcpServer || !checks.browser || !checks.state || checks.state.ok !== true ||
    !checks.audit || checks.audit.ok !== true || !checks.audit.verification || checks.audit.verification.valid !== true) {
  process.exitCode = 1;
}
