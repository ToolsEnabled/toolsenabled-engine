'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { activityMode, shouldRecordToolActivity, SETTING_ID } = require('../src/lib/audit-activity');
const { resolveRuntimePolicy, runtimePolicy } = require('../src/lib/runtime-policy');
const operation = require('../src/lib/operation-audit');
function settings(values = {}, source = 'user') {
  return { values, provenance: Object.fromEntries(Object.keys(values).map(id => [id, { source }])), rejected: [] };
}
test('Basic and legacy Full stay unaudited until the separate master is explicitly enabled', () => {
  for (const value of [settings(), settings({ [SETTING_ID]: 'Full' }), settings({ 'audit.enabled': false, [SETTING_ID]: 'Full' })]) {
    const options = { loadSettings: () => value };
    assert.equal(activityMode(options), 'Off');
    for (const outcome of ['succeeded', 'failed', 'unknown']) assert.equal(shouldRecordToolActivity(outcome, options), false);
    assert.equal(resolveRuntimePolicy(value).continuationEnabled, true);
  }
  assert.equal(resolveRuntimePolicy(settings({ [SETTING_ID]: 'Full' })).retainedActivity, 'Full');
});
test('explicit audit and history are independent opt-ins; rejected or untrusted data grants neither', () => {
  for (const source of ['user', 'installer']) {
    const value = settings({ 'audit.enabled': true, 'ledger.verify_history': true, 'agent.persistent_continuation': false }, source);
    assert.deepEqual([resolveRuntimePolicy(value).auditEnabled, resolveRuntimePolicy(value).verifyHistory, resolveRuntimePolicy(value).continuationEnabled], [true, true, false]);
  }
  for (const source of ['default', 'agent', 'unknown']) assert.equal(resolveRuntimePolicy(settings({ 'audit.enabled': true }, source)).auditEnabled, false);
  const rejected = settings({ 'audit.enabled': true, 'ledger.verify_history': true });
  rejected.rejected = [{ id: 'audit.enabled' }];
  assert.equal(resolveRuntimePolicy(rejected).auditEnabled, false);
  assert.equal(resolveRuntimePolicy(rejected).verifyHistory, true);
  const unreadable = runtimePolicy({ loadSettings: () => { throw Error('unreadable'); } });
  assert.equal(unreadable.configurationAvailable, false);
  assert.equal(unreadable.continuationEnabled, false);
  assert.equal(unreadable.auditEnabled, false);
});
test('configured activity choices apply to one read per outcome and reconfigure on the next call', () => {
  let mode = 'Full', enabled = true, reads = 0;
  const options = { loadSettings: () => { reads++; return settings({ 'audit.enabled': enabled, [SETTING_ID]: mode }); } };
  for (const [choice, success, failed] of [['Full', true, true], ['Essential', false, true], ['Off', false, false]]) {
    mode = choice;
    for (const [outcome, expected] of [['succeeded', success], ['failed', failed]]) {
      const before = reads;
      assert.equal(shouldRecordToolActivity(outcome, options), expected);
      assert.equal(reads, before + 1);
    }
  }
  enabled = false;
  assert.equal(shouldRecordToolActivity('unknown', options), false);
});
test('ordinary audit captures an internal decision across toggles without fabricating evidence', async () => {
  let enabled = false, writes = 0;
  const options = { loadSettings: () => settings({ 'audit.enabled': enabled }), audit: { requireRecord(action, target) {
    writes++; return { durable: true, anchored: true, sequence: writes, eventHash: 'a'.repeat(64), action, target };
  } } };
  const off = operation.capturePolicy(options);
  enabled = true;
  const skipped = operation.requireRecord('intent', 'bound-1', {}, { ...options, auditPolicy: off });
  assert.deepEqual(skipped, { ok: true, disposition: 'not-required', required: false, recorded: false, durable: false, anchored: false, signed: false, sequence: null, eventId: null, eventHash: null, action: 'intent', target: 'bound-1' });
  assert.equal((await operation.requireRecordAsync('outcome', 'bound-1', {}, { ...options, auditPolicy: off })).disposition, 'not-required');
  assert.equal(writes, 0);
  const on = operation.capturePolicy(options);
  enabled = false;
  assert.equal(operation.requireRecord('intent', 'bound-2', {}, { ...options, auditPolicy: on }).sequence, 1);
  assert.equal(operation.requireRecord('outcome', 'bound-2', {}, { ...options, auditPolicy: on }).sequence, 2);
  assert.throws(() => operation.capturePolicy({ auditPolicy: { required: false } }), /trusted runtime/);
  assert.throws(() => operation.requireRecord('intent', 'bound-3', {}, { ...options, auditPolicy: on, audit: { requireRecord() { throw Error('anchor unavailable'); } } }), /anchor unavailable/);
});
