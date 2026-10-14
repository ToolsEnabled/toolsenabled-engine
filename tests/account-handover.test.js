'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handoverReport } = require('../src/lib/multi-account/handover');
const sessions = [{ sessionId: 'saved-session', agentId: 'worker', provider: 'claude', account: 'chosen' }];

test('a usage limit describes only the current account even when another account is healthy', () => {
  const report = handoverReport({ sessions, usage: { ok: true, readAt: '2026-10-09T16:00:00Z',
    orders: [{ provider: 'claude', names: ['other', 'chosen'] }], accounts: [
      { name: 'other', provider: 'claude', canServe: true, status: 'HEALTHY' },
      { name: 'chosen', provider: 'claude', canServe: false, status: 'EXHAUSTED' } ] } });
  assert.equal(report.ok, true);
  assert.equal(report.held.length, 1);
  assert.deepEqual([report.held[0].sessionId, report.held[0].agentId, report.held[0].from], ['saved-session', 'worker', 'chosen']);
  assert.equal(report.unknown.length, 0);
  assert.equal(JSON.stringify(report).includes('other'), false);
  assert.ok(Object.isFrozen(report.held[0]));
});

test('an old policy cutoff cannot classify an available chosen account as exhausted', () => {
  const report = handoverReport({ sessions, usage: { ok: true, policy: { exhaustedAtPercent: 50, selectionMode: 'rotate' },
    accounts: [{ name: 'chosen', provider: 'claude', canServe: true, status: 'HEALTHY', windows: { hourly: { usedPercent: 99 } } }] } });
  assert.deepEqual(report.held, []);
  assert.deepEqual(report.unknown, []);
});

test('unread usage and a missing reading name their distinct reasons', () => {
  const unread = handoverReport({ sessions });
  const partial = handoverReport({ sessions, usage: { ok: true, accounts: [{ name: 'chosen', provider: 'codex', canServe: true }] } });
  assert.equal(unread.ok, false);
  assert.equal(unread.unknown[0].why, 'HANDOVER_UNKNOWN_NOTHING_READ');
  assert.equal(partial.ok, true);
  assert.equal(partial.unknown[0].why, 'HANDOVER_UNKNOWN_ACCOUNT_NOT_READ');
  assert.deepEqual(unread.held, []);
});

test('invalid session rows do not change valid session limit facts', () => {
  const report = handoverReport({ sessions: [null, 'bad', {}, ...sessions], usage: { ok: true, accounts: [null,
    { name: 'chosen', provider: 'claude', canServe: true, windows: { weekly: { usedPercent: 100 } } }] } });
  assert.equal(report.held.length, 1);
  assert.equal(report.held[0].sessionId, 'saved-session');
  assert.deepEqual(handoverReport().unknown, []);
});
