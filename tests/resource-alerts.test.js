'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const alerts = require('../src/lib/resource-alerts');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

async function checkAsync(name, fn) {
  await fn();
  passed += 1;
  process.stdout.write(`  ok  ${name}\n`);
}

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-alerts-'));
  const now = Date.UTC(2026, 7, 7, 12, 0, 0);
  return { stateDir, now };
}

function sample(stateDir, at, cpu) {
  alerts.appendSample({ at: new Date(at).toISOString(), cpu, freeRamMB: 4096 }, { stateDir });
}

function highCpuRule(stateDir, now) {
  return alerts.setRule({
    id: 'cpu-high',
    metric: 'cpu',
    op: '>',
    threshold: 90,
    forMinutes: 10,
    setBy: 'test-coordinator'
  }, { stateDir, now });
}

function cleanup(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

async function main() {
  process.stdout.write('resource-alerts\n');

  await checkAsync('injects a fake sampler and appends a normalized bounded sample', async () => {
    const { stateDir, now } = fixture();
    try {
      const result = await alerts.recordSample({
        stateDir,
        now,
        sampler: async () => ({ cpu: 41.25, freeRamMB: 3072.5 })
      });
      assert.equal(result.state, 'RECORDED');
      assert.deepEqual(alerts.readSamples({ stateDir }), [{
        at: new Date(now).toISOString(), cpu: 41.25, freeRamMB: 3072.5
      }]);
    } finally {
      cleanup(stateDir);
    }
  });

  await checkAsync('refuses to report a sample as recorded when retention cannot hold it', async () => {
    const { stateDir, now } = fixture();
    try {
      await assert.rejects(alerts.recordSample({
        stateDir,
        now,
        maxSampleBytes: 1,
        sampler: async () => ({ cpu: 41.25, freeRamMB: 3072.5 })
      }), error => error && error.code === 'RESOURCE_ALERTS_RETENTION_TOO_SMALL');
      assert.equal(fs.existsSync(path.join(stateDir, 'samples.jsonl')), false);
    } finally {
      cleanup(stateDir);
    }
  });

  check('fires one full-window breach exactly once and writes the sweep escalation shape', () => {
    const { stateDir, now } = fixture();
    try {
      highCpuRule(stateDir, now);
      sample(stateDir, now - 10 * 60 * 1000, 91);
      sample(stateDir, now - 5 * 60 * 1000, 95);
      sample(stateDir, now, 93);
      const first = alerts.evaluateRules({ stateDir, now });
      assert.equal(first.results[0].state, 'FIRED');
      assert.equal(first.escalations.length, 1);
      assert.deepEqual(Object.keys(first.escalations[0]).sort(), ['agentId', 'code', 'message', 'runId', 'status']);
      const again = alerts.evaluateRules({ stateDir, now });
      assert.equal(again.results[0].state, 'COOLDOWN');
      assert.equal(again.escalations.length, 0);
      assert.equal(alerts.readEscalations({ stateDir }).length, 1);
      const [rule] = alerts.readRules({ stateDir });
      assert.equal(rule.cooldown, true);
      assert.ok(rule.lastFiredAt);
    } finally {
      cleanup(stateDir);
    }
  });

  check('treats a partial window as UNKNOWN instead of healthy or fired', () => {
    const { stateDir, now } = fixture();
    try {
      highCpuRule(stateDir, now);
      sample(stateDir, now, 99);
      const result = alerts.evaluateRules({ stateDir, now });
      assert.equal(result.results[0].state, 'UNKNOWN');
      assert.equal(result.results[0].reason, 'INSUFFICIENT_SAMPLES');
      assert.equal(result.escalations.length, 0);
    } finally {
      cleanup(stateDir);
    }
  });

  check('a recovery clears cooldown and a later full recurrence may fire once', () => {
    const { stateDir, now } = fixture();
    try {
      highCpuRule(stateDir, now);
      sample(stateDir, now - 10 * 60 * 1000, 91);
      sample(stateDir, now - 5 * 60 * 1000, 95);
      sample(stateDir, now, 93);
      assert.equal(alerts.evaluateRules({ stateDir, now }).results[0].state, 'FIRED');
      assert.equal(alerts.evaluateRules({ stateDir, now }).results[0].state, 'COOLDOWN');

      sample(stateDir, now + 5 * 60 * 1000, 20);
      sample(stateDir, now + 10 * 60 * 1000, 20);
      const recovery = alerts.evaluateRules({ stateDir, now: now + 10 * 60 * 1000 });
      assert.equal(recovery.results[0].state, 'CLEARED');
      assert.equal(alerts.readRules({ stateDir })[0].cooldown, false);

      sample(stateDir, now + 15 * 60 * 1000, 96);
      sample(stateDir, now + 20 * 60 * 1000, 94);
      sample(stateDir, now + 25 * 60 * 1000, 97);
      const recurrence = alerts.evaluateRules({ stateDir, now: now + 25 * 60 * 1000 });
      assert.equal(recurrence.results[0].state, 'FIRED');
      assert.equal(alerts.readEscalations({ stateDir }).length, 2);
    } finally {
      cleanup(stateDir);
    }
  });

  check('rule create, list, and clear persist atomically without temporary residue', () => {
    const { stateDir, now } = fixture();
    try {
      const created = highCpuRule(stateDir, now);
      assert.equal(alerts.readRules({ stateDir })[0].id, created.id);
      const rulesFile = path.join(stateDir, 'rules.json');
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(rulesFile, 'utf8')));
      assert.equal(fs.readdirSync(stateDir).filter(name => name.includes('.tmp')).length, 0);
      const cleared = alerts.clearRule(created.id, { stateDir });
      assert.equal(cleared.id, created.id);
      assert.deepEqual(alerts.readRules({ stateDir }), []);
      assert.equal(fs.readdirSync(stateDir).filter(name => name.includes('.tmp')).length, 0);
    } finally {
      cleanup(stateDir);
    }
  });

  await checkAsync('counter failure remains UNKNOWN and the scheduled-task dry run succeeds', async () => {
    const { stateDir, now } = fixture();
    try {
      highCpuRule(stateDir, now);
      sample(stateDir, now - 10 * 60 * 1000, 99);
      sample(stateDir, now, 99);
      const sampled = await alerts.recordSample({
        stateDir,
        now,
        sampler: async () => { throw new alerts.ResourceAlertsError('TEST_COUNTER_FAILURE', 'counter unavailable'); }
      });
      assert.equal(sampled.state, 'UNKNOWN');
      const evaluation = alerts.evaluateRules({ stateDir, now, samplerFailure: true });
      assert.equal(evaluation.results[0].state, 'UNKNOWN');
      assert.equal(evaluation.results[0].reason, 'COUNTER_READ_FAILED');
      assert.equal(evaluation.escalations.length, 0);
    } finally {
      cleanup(stateDir);
    }

    const task = path.join(__dirname, '..', 'tools', 'resource-alerts-task.ps1');
    const run = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', task, '-DryRun'
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /DRY RUN - no scheduled task was created/i);
    assert.match(run.stdout, /RepetitionInterval=PT5M|PT5M/i);
  });

  process.stdout.write(`\nresource-alerts: ${passed} checks passed\n`);
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
