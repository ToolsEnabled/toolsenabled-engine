/* Mutation check (2026-08-27):
 * In heartbeat.js, changed `if (!OUTCOME_VALUES.includes(duty.outcome))` to
 * `if (false && !OUTCOME_VALUES.includes(duty.outcome))`.
 * The edit landed (confirmed by an exact source search), and this file went red.
 */

'use strict';

// Behavioural contract for src/lib/coordinator/heartbeat.js. This file is
// intentionally runnable by itself: `node tests/firsttest2-coordinator-heartbeat.test.js`.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const heartbeat = require('../src/lib/coordinator/heartbeat.js');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-behaviour-'));
const file = path.join(directory, 'heartbeat.json');

try {
  const record = heartbeat.emptyHeartbeat({
    pid: 8123,
    bootId: 'behaviour-test-boot',
    startedAtMs: 10_000,
    observedAtMs: 10_250,
    cycleIntervalMs: 2_000
  });

  assert.deepEqual(
    {
      valid: heartbeat.validateHeartbeat(record).valid,
      cycleSeq: record.cycleSeq,
      hostState: record.hostState,
      escalationsSuppressed: record.escalationsSuppressed
    },
    { valid: true, cycleSeq: 0, hostState: 'UNKNOWN', escalationsSuppressed: null },
    'a newly booted host must report an honest, valid, not-yet-measured heartbeat'
  );

  record.cycleSeq = 4;
  record.hostState = heartbeat.HOST_STATE.DEGRADED;
  record.duties.poll = {
    lastRunAtMs: 10_250,
    outcome: heartbeat.DUTY_OUTCOME.TIMEOUT,
    consecutiveFailures: 2
  };

  assert.equal(heartbeat.writeHeartbeat(record, { file }), file);
  assert.deepEqual(heartbeat.readHeartbeatRaw({ file }), {
    ok: true,
    record,
    errorCode: null,
    reason: 'heartbeat read',
    file
  }, 'writeHeartbeat and readHeartbeatRaw must preserve the exported contract values');

  fs.writeFileSync(file, '{broken json', 'utf8');
  const corrupt = heartbeat.readHeartbeatRaw({ file });
  assert.equal(corrupt.ok, false);
  assert.equal(corrupt.record, null);
  assert.equal(corrupt.errorCode, 'HEARTBEAT_CORRUPT',
    'malformed JSON must be distinguished from a structurally invalid heartbeat');
  assert.match(corrupt.reason, /not valid JSON/);

  const invalid = heartbeat.emptyHeartbeat({ pid: 8123, bootId: 'invalid-record' });
  invalid.duties.poll = { lastRunAtMs: null, outcome: 'ASSUMED_OK', consecutiveFailures: 0 };
  const verdict = heartbeat.validateHeartbeat(invalid);
  assert.equal(verdict.valid, false);
  assert.match(verdict.errors.join('\n'), /unknown outcome "ASSUMED_OK"/);
  assert.throws(
    () => heartbeat.writeHeartbeat(invalid, { file }),
    error => error.code === 'HEARTBEAT_INVALID' && error.errors.some(message => /ASSUMED_OK/.test(message)),
    'the writer must refuse the same invalid values that validation identifies'
  );

  process.stdout.write('firsttest2 coordinator heartbeat behaviour: PASS\n');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
