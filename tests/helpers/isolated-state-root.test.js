'use strict';

// FINDING 1 (REPORT-ledger-kinds-tools-20260907.md): a test that resolves
// owner-request-store.js's state root must never resolve it to the LIVE
// capability root. What must hold: requiring the helper always redirects
// TOOLSENABLED_STATE_ROOT to a fresh, non-live scratch directory, and its
// own defensive check (assertNotLive, exercised directly here, no
// require-cache tricks needed) throws -- naming the path -- for the live
// root and only the live root.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const isolated = require('./isolated-state-root');

test('requiring the helper points TOOLSENABLED_STATE_ROOT at a fresh scratch directory that exists and is not the live root', () => {
  assert.equal(process.env.TOOLSENABLED_STATE_ROOT, isolated.scratchRoot);
  assert.equal(fs.existsSync(isolated.scratchRoot), true);
  assert.equal(isolated.isLiveRoot(isolated.scratchRoot), false);
});

test('assertNotLive throws, naming the exact path, for the live capability root and nothing else', () => {
  const live = isolated.liveCapabilityRoot();
  assert.throws(
    () => isolated.assertNotLive(live),
    error => error.message.includes(live) && /LIVE owner-request ledger/.test(error.message)
  );
  assert.doesNotThrow(() => isolated.assertNotLive(isolated.scratchRoot));
  assert.doesNotThrow(() => isolated.assertNotLive(path.join(os.tmpdir(), 'unrelated-dir')));
  assert.doesNotThrow(() => isolated.assertNotLive(null));
  assert.doesNotThrow(() => isolated.assertNotLive(undefined));
});

test('isLiveRoot is case- and trailing-slash insensitive, so a differently-spelled live path is still caught', () => {
  const live = isolated.liveCapabilityRoot();
  assert.equal(isolated.isLiveRoot(live.toUpperCase()), true);
  assert.equal(isolated.isLiveRoot(`${live}\\`), true);
});

test('liveCapabilityRoot is derived from APPDATA, never a hardcoded account path -- a different APPDATA yields a different live root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-appdata-'));
  const derived = isolated.liveCapabilityRoot({ environment: { APPDATA: dir } });
  assert.equal(derived, path.join(dir, 'ToolsEnabled-Live', 'capability'));
  assert.notEqual(derived, isolated.liveCapabilityRoot());
});

test('runtime-state-root.js itself now resolves this process to the scratch root, not the live one -- the actual production resolution path is redirected, not just the raw env var', () => {
  const runtimeStateRoot = require('../../src/lib/runtime-state-root');
  const resolved = runtimeStateRoot.resolveStateRoot();
  assert.equal(resolved.root, isolated.scratchRoot);
  assert.equal(isolated.isLiveRoot(resolved.root), false);
});
