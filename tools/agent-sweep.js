#!/usr/bin/env node
'use strict';

const wake = require('../src/lib/agent-wake');

async function main() {
  const parsed = wake.parseSweepArgs(process.argv.slice(2));
  const result = await wake.sweepAgents(parsed.input, parsed.options);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    at: result.at,
    policy: result.policy,
    usefulProgressStaleMs: result.usefulProgressStaleMs,
    counts: result.counts,
    terminalVerdicts: result.terminalVerdicts,
    failures: result.failures,
    deadStale: result.deadStale,
    heartbeatFaults: result.heartbeatFaults,
    aliveNoUsefulProgress: result.aliveNoUsefulProgress,
    unknownLiveness: result.unknownLiveness,
    respawns: result.respawns,
    escalations: result.escalations,
    consumptionRaces: result.consumptionRaces
  })}\n`);
}

main().catch(error => {
  const safe = wake.safeError(error);
  process.stderr.write(`${JSON.stringify({ ok: false, code: safe.code, message: safe.message })}\n`);
  process.exitCode = 1;
});
