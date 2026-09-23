'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

// Instrument side effects before loading the subject. A refusal is only safe if
// checking it cannot itself write an artifact or launch outward work.
let writes = 0;
let spawns = 0;
for (const method of ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream']) {
  const original = fs[method];
  fs[method] = function countedWrite(...args) {
    writes += 1;
    return original.apply(this, args);
  };
}
for (const method of ['spawn', 'spawnSync', 'exec', 'execFile', 'fork']) {
  const original = childProcess[method];
  childProcess[method] = function countedSpawn(...args) {
    spawns += 1;
    return original.apply(this, args);
  };
}

const { preflight } = require('../src/lib/egress-preflight');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-preflight-refusals-'));

function assertNoEffects(beforeWrites, beforeSpawns) {
  assert.equal(writes, beforeWrites, 'refusal must not write');
  assert.equal(spawns, beforeSpawns, 'refusal must not spawn');
  assert.deepEqual(fs.readdirSync(scratch), [], 'refusal must leave scratch directory empty');
}

function driveFinding({ code, filePath, metadata, severity, allowed }) {
  const beforeWrites = writes;
  const beforeSpawns = spawns;
  const result = preflight({ filePath, metadata, destination: 'external recipient' });

  assert.equal(result.allowed, allowed, `${code} allowed state`);
  assert.equal(result.severity, severity, `${code} aggregate severity`);
  assert.ok(result.findings.some(finding => finding.code === code), `${code} finding must be produced`);
  assert.ok(result.suggestedName, `${code} must produce a safer suggested name`);
  assert.match(result.summary, new RegExp(code), `${code} must be reported in the summary`);
  assertNoEffects(beforeWrites, beforeSpawns);
}

driveFinding({ code: 'AI_PROVENANCE', filePath: 'quarterly-ai_generated-report.pdf', severity: 'block', allowed: false });
driveFinding({ code: 'AUTOGEN', filePath: 'quarterly-auto-generated-report.pdf', severity: 'block', allowed: false });
driveFinding({ code: 'MODEL_NAME', filePath: 'quarterly-report.pdf', metadata: { author: 'OpenAI' }, severity: 'block', allowed: false });
driveFinding({ code: 'PROCESS_STATE', filePath: 'quarterly-corrected-report.pdf', severity: 'warn', allowed: true });
driveFinding({ code: 'SLOPPY_NAME', filePath: 'quarterly-final-final.pdf', severity: 'warn', allowed: true });

{
  const beforeWrites = writes;
  const beforeSpawns = spawns;
  assert.throws(
    () => preflight({ filePath: '   ' }),
    error => error instanceof Error && error.message === 'EGRESS_PREFLIGHT_FILE_REQUIRED'
  );
  assertNoEffects(beforeWrites, beforeSpawns);
}

fs.rmSync(scratch, { recursive: true, force: true });
console.log('egress-preflight uncovered refusals: 6 driven refusals passed');
