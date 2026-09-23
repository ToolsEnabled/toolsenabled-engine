'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { failoverChoice } = require(process.env.T1010_SOURCE || path.join(__dirname, '../src/lib/multi-account/failover-setting.js'));

// All values are inert. Injecting loadSettings avoids real settings, accounts,
// storage and native execution while calling the actual public entry point.
function unreadable(value) {
  let calls = 0;
  let result;
  assert.doesNotThrow(() => { result = failoverChoice({ loadSettings() { calls++; throw value; } }); });
  assert.equal(calls, 1);
  assert.equal(result.chosen, false);
  assert.equal(result.settingId, 'accounts.failover');
  assert.equal(result.value, null);
  assert.equal(result.reason, 'settings-unreadable');
  assert.equal(Object.isFrozen(result), true);
  assert.equal(typeof result.detail, 'string');
  assert.ok(result.detail.length > 0, 'unreadable settings retain a named reason');
  return result.detail;
}
for (const [name, value, marker] of [
  ['string', 'INERT_THROWN_MARKER', 'INERT_THROWN_MARKER'],
  ['number', 137, '137'],
  ['boolean', true, 'true'],
  ['bigint', 137n, '137'],
  ['symbol', Symbol('INERT_SYMBOL_MARKER'), 'INERT_SYMBOL_MARKER'],
  ['null', null, null],
  ['undefined', undefined, null]
]) {
  test('settings failure contains a thrown ' + name, () => {
    const detail = unreadable(value);
    if (marker) assert.equal(detail.includes(marker), false);
    else assert.notEqual(detail, String(value));
  });
}
test('raw Buffer bytes are not a diagnostic', () => {
  assert.equal(unreadable(Buffer.from('INERT_BUFFER_MARKER')).includes('INERT_BUFFER_MARKER'), false);
});
test('arbitrary thrown object conversion is never called', () => {
  let calls = 0;
  const error = { toString() { calls++; throw new Error('INERT_COERCION_MARKER'); } };
  unreadable(error);
  assert.equal(calls, 0);
});
test('throwing message getter is contained', () => {
  let reads = 0;
  const error = Object.defineProperty({}, 'message', { get() { reads++; throw new Error('INERT_GETTER_MARKER'); } });
  assert.equal(unreadable(error).includes('INERT_GETTER_MARKER'), false);
  assert.ok(reads <= 1);
});
test('changing message getter contributes its first value only', () => {
  let reads = 0;
  const error = Object.defineProperty({}, 'message', { get() { return ++reads === 1 ? 'Settings file is unreadable.' : 'INERT_SECOND_READ_MARKER'; } });
  const detail = unreadable(error);
  assert.equal(detail, 'Settings file is unreadable.');
  assert.equal(reads, 1);
});
test('object message is not converted into detail', () => {
  let calls = 0;
  const message = { toString() { calls++; return 'INERT_MESSAGE_MARKER'; } };
  assert.equal(unreadable({ message }).includes('INERT_MESSAGE_MARKER'), false);
  assert.equal(calls, 0);
});
test('empty message still yields a readable diagnostic', () => {
  unreadable({ message: '' });
});
test('safe Error message remains available', () => {
  assert.equal(unreadable(new Error('Settings file is unreadable.')), 'Settings file is unreadable.');
});
test('failure diagnostics do not inspect stdout or stderr', () => {
  let reads = 0;
  const error = new Error('Settings file is unreadable.');
  for (const key of ['stdout', 'stderr']) Object.defineProperty(error, key, { get() { reads++; throw new Error('INERT_STREAM_MARKER'); } });
  assert.equal(unreadable(error), 'Settings file is unreadable.');
  assert.equal(reads, 0);
});
for (const value of ['manual', 'auto']) {
  for (const source of ['user', 'installer', 'default']) {
    test(value + ' preserves ' + source + ' provenance', () => {
      const result = failoverChoice({ loadSettings: () => ({ values: { 'accounts.failover': value }, provenance: { 'accounts.failover': { source } } }) });
      assert.equal(result.chosen, source !== 'default');
      assert.equal(result.reason, source === 'default' ? 'not-chosen' : 'chosen');
      assert.equal(result.value, source === 'default' ? null : value);
      assert.equal(result.source, source);
      assert.equal(Object.isFrozen(result), true);
    });
  }
}
for (const [name, settings, reason] of [
  ['missing row', { values: {} }, 'not-declared'],
  ['invalid stored choice', { values: { 'accounts.failover': 'INERT_INVALID_CHOICE' } }, 'not-a-choice'],
  ['absent provenance', { values: { 'accounts.failover': 'manual' } }, 'not-chosen']
]) {
  test(name + ' does not become a chosen policy', () => {
    const result = failoverChoice({ loadSettings: () => settings });
    assert.equal(result.chosen, false);
    assert.equal(result.reason, reason);
    assert.equal(result.value, null);
  });
}
