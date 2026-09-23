#!/usr/bin/env node
'use strict';

const wake = require('../src/lib/agent-wake');

async function main() {
  const parsed = wake.parseWakeArgs(process.argv.slice(2));
  const result = await wake.wakeAgent(parsed.input, parsed.options);
  process.stdout.write(`${result.message}\n`);
}

main().catch(error => {
  const safe = wake.safeError(error);
  process.stderr.write(`${JSON.stringify({ ok: false, code: safe.code, message: safe.message })}\n`);
  process.exitCode = 1;
});
