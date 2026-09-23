// EXECUTABLE CHANGE
//
// Discrimination report (testcanfail-tests-desktop-window-close-guard-js):
// - The identity-mismatch loop could pass vacuously. Mutation: the mismatch-case
//   table was emptied in a scratch copy. RED: "AssertionError [ERR_ASSERTION]:
//   identity mismatch coverage must include every guarded identity field".
// - postMessageCalls is emitted by the test seam itself, so it cannot prove that
//   the production script lacks a native close call. Mutation: a PostMessage(...)
//   call was inserted into a scratch copy of desktop.ps1. RED: "AssertionError
//   [ERR_ASSERTION]: the desktop helper must not invoke a native window-close API".
// - NOT-FOUND (2): no assertion treats non-zero exit/truthiness as subject evidence;
//   status === 0 is only a load gate and exact parsed output supplies the evidence.
// - NOT-FOUND (3): the only catch is best-effort temporary-file cleanup.
// - NOT-FOUND (5): there is no skip or platform precondition guard.
// - NOT-FOUND (6): expected results are literal values, not product-computed values.
// - PRECONDITION-NOT-MET: powershell.exe is unavailable in this Linux container,
//   so the restored test cannot execute here; `node --check` is green.

'use strict';

// Deterministic seam coverage for the cooperative unowned-window close observer.
// Production contains no WM_CLOSE/PostMessage call. No real HWND is opened or
// closed; every identity outcome must leave postMessageCalls at zero.

require('./lib/isolated-environment').activate('desktop-window-close-guard');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', 'tools', 'desktop.ps1');
const desktopSource = fs.readFileSync(script, 'utf8');
assert.doesNotMatch(
  desktopSource,
  /\b(?:PostMessage|SendMessage)\s*\(/,
  'the desktop helper must not invoke a native window-close API'
);
const expected = {
  windowId: '12345', expectedProcessId: 23456, expectedProcessStartKey: '133700000000000000',
  expectedProcessName: 'chrome', expectedTitle: 'Sample Calendar - Firebase console'
};
const snapshot = {
  windowId: expected.windowId, processId: expected.expectedProcessId,
  processStartKey: expected.expectedProcessStartKey, processName: expected.expectedProcessName,
  title: expected.expectedTitle
};
const mismatchCases = [
  ['pid mismatch', { processId: 23457 }],
  ['start-key mismatch', { processStartKey: '133700000000000001' }],
  ['recycled handle identity', { windowId: '67890', processId: 23457, processStartKey: '133700000000000001' }],
  ['process-name mismatch', { processName: 'msedge' }],
  ['title mismatch', { title: 'Different Firebase window' }]
];

assert.equal(
  mismatchCases.length,
  5,
  'identity mismatch coverage must include every guarded identity field'
);

function run(payload) {
  const file = path.join(os.tmpdir(), `toolsenabled-window-close-guard-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' });
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, 'window-close-test', file], {
      cwd: process.cwd(), encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  } finally { try { fs.unlinkSync(file); } catch { /* test cleanup */ } }
}

assert.deepEqual(run({ ...expected, snapshot, afterSnapshot: snapshot }), {
  matched: true, status: 'manual_timeout', postMessageCalls: 0
});
assert.deepEqual(run({ ...expected, snapshot, afterSnapshot: null }), {
  matched: true, status: 'closed', postMessageCalls: 0
});
for (const [label, replacement] of mismatchCases) {
  const result = run({ ...expected, snapshot: { ...snapshot, ...replacement }, afterSnapshot: snapshot });
  assert.deepEqual(result, {
    matched: false, status: 'target_changed', postMessageCalls: 0
  }, `${label} must never send WM_CLOSE`);
}

assert.deepEqual(run({
  ...expected, snapshot, afterSnapshot: { ...snapshot, title: 'Recycled title' }
}), {
  matched: true, status: 'target_changed', postMessageCalls: 0
}, 'a last-boundary target change must never send WM_CLOSE');

console.log('Desktop window-close native guard tests passed.');
