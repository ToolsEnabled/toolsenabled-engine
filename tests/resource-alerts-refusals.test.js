'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const alerts = require('../src/lib/resource-alerts');

let passed = 0;

function test(name, body) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-alert-refusal-'));
  try {
    body(stateDir);
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

async function testAsync(name, body) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-alert-refusal-'));
  try {
    await body(stateDir);
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function expectCode(code, body) {
  assert.throws(body, error => error instanceof alerts.ResourceAlertsError && error.code === code);
}

function files(stateDir) {
  return fs.readdirSync(stateDir).sort();
}

function rule(overrides = {}) {
  return {
    id: 'cpu-high', metric: 'cpu', op: '>', threshold: 90, forMinutes: 10,
    setBy: 'refusal-test', setAt: '2026-08-27T12:00:00.000Z', enabled: true,
    lastFiredAt: null, cooldown: false, cooldownClearedAt: null, ...overrides
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function addWindow(stateDir, now, cpu) {
  for (const offset of [10, 5, 0]) {
    alerts.appendSample({ at: now - offset * 60_000, cpu, freeRamMB: 4096 }, { stateDir });
  }
}

async function main() {
  process.stdout.write('resource-alerts driven refusals\n');

  test('RESOURCE_ALERTS_INVALID rejects a non-string expression without writing state', stateDir => {
    expectCode('RESOURCE_ALERTS_INVALID', () => alerts.parseRuleExpression(42));
    assert.deepEqual(files(stateDir), []);
  });

  test('RESOURCE_ALERTS_RULE_EXPRESSION_INVALID rejects malformed grammar without writing state', stateDir => {
    expectCode('RESOURCE_ALERTS_RULE_EXPRESSION_INVALID', () => alerts.parseRuleExpression('cpu maybe 90'));
    assert.deepEqual(files(stateDir), []);
  });

  test('RESOURCE_ALERTS_RULE_INVALID rejects a non-object rule before writing', stateDir => {
    expectCode('RESOURCE_ALERTS_RULE_INVALID', () => alerts.writeRules([null], { stateDir }));
    assert.deepEqual(files(stateDir), []);
  });

  test('RESOURCE_ALERTS_RULE_EXISTS preserves the original rule and does not create another', stateDir => {
    alerts.setRule(rule(), { stateDir });
    const before = fs.readFileSync(path.join(stateDir, 'rules.json'), 'utf8');
    expectCode('RESOURCE_ALERTS_RULE_EXISTS', () => alerts.setRule(rule(), { stateDir }));
    assert.equal(fs.readFileSync(path.join(stateDir, 'rules.json'), 'utf8'), before);
    assert.equal(alerts.readRules({ stateDir }).length, 1);
  });

  test('RESOURCE_ALERTS_RULE_NOT_FOUND leaves rule state byte-for-byte unchanged', stateDir => {
    alerts.setRule(rule(), { stateDir });
    const target = path.join(stateDir, 'rules.json');
    const before = fs.readFileSync(target, 'utf8');
    expectCode('RESOURCE_ALERTS_RULE_NOT_FOUND', () => alerts.clearRule('absent', { stateDir }));
    assert.equal(fs.readFileSync(target, 'utf8'), before);
  });

  test('RESOURCE_ALERTS_RULE_STATE_INVALID refuses corrupt JSON without rewriting it', stateDir => {
    const target = path.join(stateDir, 'rules.json');
    writeJson(target, '{broken');
    expectCode('RESOURCE_ALERTS_RULE_STATE_INVALID', () => alerts.readRules({ stateDir }));
    assert.equal(fs.readFileSync(target, 'utf8'), '{broken');
  });

  test('RESOURCE_ALERTS_SAMPLE_INVALID rejects a malformed sample before creating its journal', stateDir => {
    expectCode('RESOURCE_ALERTS_SAMPLE_INVALID', () => alerts.appendSample(null, { stateDir }));
    assert.deepEqual(files(stateDir), []);
  });

  test('RESOURCE_ALERTS_SAMPLE_STATE_INVALID refuses corrupt JSONL without rewriting it', stateDir => {
    const target = path.join(stateDir, 'samples.jsonl');
    writeJson(target, 'not-json\n');
    expectCode('RESOURCE_ALERTS_SAMPLE_STATE_INVALID', () => alerts.readSamples({ stateDir }));
    assert.equal(fs.readFileSync(target, 'utf8'), 'not-json\n');
  });

  test('RESOURCE_ALERTS_ESCALATION_INVALID rejects a malformed escalation before creating its journal', stateDir => {
    expectCode('RESOURCE_ALERTS_ESCALATION_INVALID', () => alerts.appendEscalations([{}], { stateDir }));
    assert.deepEqual(files(stateDir), []);
  });

  test('RESOURCE_ALERTS_ESCALATION_STATE_INVALID refuses corrupt JSONL without rewriting it', stateDir => {
    const target = path.join(stateDir, 'escalations.jsonl');
    writeJson(target, 'not-json\n');
    expectCode('RESOURCE_ALERTS_ESCALATION_STATE_INVALID', () => alerts.readEscalations({ stateDir }));
    assert.equal(fs.readFileSync(target, 'utf8'), 'not-json\n');
  });

  await testAsync('RESOURCE_ALERTS_COUNTER_READ_FAILED rejects a failed injected process and writes nothing', async stateDir => {
    let spawns = 0;
    await assert.rejects(alerts.powerShellCounters({
      execFileImpl: (_file, _args, _options, callback) => {
        spawns += 1;
        callback(Object.assign(new Error('missing counter'), { code: 'ENOENT' }), '', '');
      }
    }), error => error instanceof alerts.ResourceAlertsError
      && error.code === 'RESOURCE_ALERTS_COUNTER_READ_FAILED'
      && error.causeCode === 'ENOENT');
    assert.equal(spawns, 1);
    assert.deepEqual(files(stateDir), []);
  });

  test('BREACH drives one escalation and persists cooldown rather than returning healthy', stateDir => {
    const now = Date.UTC(2026, 7, 27, 12);
    alerts.setRule(rule(), { stateDir });
    addWindow(stateDir, now, 95);
    const result = alerts.evaluateRules({ stateDir, now });
    assert.equal(result.results[0].state, 'FIRED');
    assert.equal(result.escalations.length, 1);
    assert.equal(alerts.readEscalations({ stateDir }).length, 1);
    assert.equal(alerts.readRules({ stateDir })[0].cooldown, true);
  });

  test('ALREADY_FIRED_UNTIL_CLEAR returns cooldown and performs no second write or escalation', stateDir => {
    const now = Date.UTC(2026, 7, 27, 12);
    alerts.setRule(rule(), { stateDir });
    addWindow(stateDir, now, 95);
    alerts.evaluateRules({ stateDir, now });
    const rulesFile = path.join(stateDir, 'rules.json');
    const escalationsFile = path.join(stateDir, 'escalations.jsonl');
    const rulesBefore = fs.readFileSync(rulesFile, 'utf8');
    const escalationsBefore = fs.readFileSync(escalationsFile, 'utf8');
    const result = alerts.evaluateRules({ stateDir, now });
    assert.equal(result.results[0].state, 'COOLDOWN');
    assert.equal(result.results[0].reason, 'ALREADY_FIRED_UNTIL_CLEAR');
    assert.deepEqual(result.escalations, []);
    assert.equal(fs.readFileSync(rulesFile, 'utf8'), rulesBefore);
    assert.equal(fs.readFileSync(escalationsFile, 'utf8'), escalationsBefore);
  });

  test('CONDITION_CLEARED returns cleared, resets cooldown, and spawns no escalation', stateDir => {
    const now = Date.UTC(2026, 7, 27, 12);
    alerts.writeRules([rule({ cooldown: true, lastFiredAt: now - 60_000 })], { stateDir });
    addWindow(stateDir, now, 20);
    const result = alerts.evaluateRules({ stateDir, now });
    assert.equal(result.results[0].state, 'CLEARED');
    assert.equal(result.results[0].reason, 'CONDITION_CLEARED');
    assert.deepEqual(result.escalations, []);
    assert.equal(fs.existsSync(path.join(stateDir, 'escalations.jsonl')), false);
    assert.equal(alerts.readRules({ stateDir })[0].cooldown, false);
  });

  process.stdout.write(`\nresource-alerts driven refusals: ${passed} checks passed\n`);
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
