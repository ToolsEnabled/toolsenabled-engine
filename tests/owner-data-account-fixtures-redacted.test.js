#!/usr/bin/env node
'use strict';

// A REGRESSION PIN, NOT A RE-IMPLEMENTATION OF THE GUARD.
//
// MEASURED 2026-09-03: `node tools/check-no-owner-data.mjs` reported 31
// findings across 4 files. Two were the owner's real account alias and email
// address, hardcoded into explanatory comments (src/lib/multi-account/
// rotation.js and tests/multi-account-rotation.test.js) plus two more test
// files that repeated the alias (tests/account-handover.test.js,
// tests/window-thresholds.test.js). Two more were the owner's real Windows
// account name, hardcoded as a literal `C:\Users\...\AppData\Local\Temp`
// path used as a scratch-directory fence (tests/entry/
// mcp-owner-proxy-lifecycle.js, tests/generic-role-authority-hostile.test.js)
// -- portable machines break on it too, since it names one specific account.
// All six are fixed: the two aliases/emails are redacted from prose, and the
// two hardcoded temp roots are computed at runtime from this account's own
// os.tmpdir(), the same way src/lib/account-profile-boundary.js does.
//
// THE SECOND DEFECT THIS PINS: tests/account-handover.test.js and
// tests/window-thresholds.test.js were both added to this repository on
// 2026-09-03 and wired into the TEST battery that same day (see
// tests/suites/orphans-wired-0901.txt) -- but never added to
// config/payload-boundary.json's open.paths, the SEPARATE list the owner-data
// guard actually scans. "Wired to run" and "wired to be scanned for owner
// data" are two different lists that happened to move together for every
// older file and silently did not for these two: the guard never looked at
// either file, so it never had a chance to catch the alias it held. Fixed by
// adding both paths to open.paths. THE TEST BELOW ALSO PINS THAT: it asserts
// the guard's own account of its publishable set includes both paths by name,
// so a future rename or manifest rewrite that drops them again is caught here
// rather than by nobody, again.
//
// This file does not re-run the FULL guard (tests/durable-memory-file.test.js
// carries a separate, pre-existing, larger set of shape-rule findings against
// synthetic "Alice"/"Bob" fixtures that this fix does not touch -- see the
// round's own report). It scans exactly the six files this fix changed,
// through the real guard, against this machine's real identity profile, so a
// revert of any one of them is caught by name.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isolatedTemporaryRoot } = require('./lib/isolated-environment');

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'tools', 'check-no-owner-data.mjs');
const MANIFEST = path.join(ROOT, 'config', 'payload-boundary.json');

// The six files this fix touched. Every path here must already be a member
// of config/payload-boundary.json's open.paths -- checked below -- so this
// scratch manifest is exactly that subset, not a wider or narrower claim.
const FIXED_FILES = Object.freeze([
  'src/lib/multi-account/rotation.js',
  'tests/multi-account-rotation.test.js',
  'tests/account-handover.test.js',
  'tests/window-thresholds.test.js',
  'tests/entry/mcp-owner-proxy-lifecycle.js',
  'tests/generic-role-authority-hostile.test.js',
]);

const ownerProfile = process.env.TE_OWNER_DATA_PROFILE || (process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Local', 'ToolsEnabled', 'owner-data-profile.json')
  : path.join(os.userInfo().homedir, '.config', 'toolsenabled', 'owner-data-profile.json'));
let skipped = 0;
let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL ${name}: ${error && error.message}`);
  }
}

function checkWithOwnerProfile(name, fn) {
  if (!fs.existsSync(ownerProfile)) {
    skipped += 1;
    console.log(`SKIP ${name}: this account has no owner identity profile; supply TE_OWNER_DATA_PROFILE to measure it`);
    return;
  }
  check(name, fn);
}

check('every file this fix touched still exists and is tracked', () => {
  for (const relative of FIXED_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, relative)), `${relative} is missing`);
  }
});

check('config/payload-boundary.json lists every file this fix touched as open', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const openPaths = new Set(manifest.open.paths);
  for (const relative of FIXED_FILES) {
    assert.ok(openPaths.has(relative),
      `${relative} is not in config/payload-boundary.json open.paths -- the owner-data guard never scans it`);
  }
});

checkWithOwnerProfile('the real owner-data guard reports zero findings in the six files this fix touched', () => {
  const scratch = fs.mkdtempSync(path.join(isolatedTemporaryRoot(), 'owner-data-fixture-scan-'));
  try {
    const scratchManifest = path.join(scratch, 'payload-boundary.json');
    fs.writeFileSync(scratchManifest, JSON.stringify({ open: { paths: FIXED_FILES } }, null, 2));

    // The profile belongs to the actual account or an explicit caller binding;
    // per-test redirected HOME/LOCALAPPDATA must not select an empty fixture.
    const profile = ownerProfile;
    assert.ok(fs.existsSync(profile), 'the explicitly selected owner identity profile must remain available');

    const result = spawnSync(process.execPath, [
      GUARD, '--manifest', scratchManifest, '--profile', profile
    ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });

    assert.equal(result.status, 0,
      `the owner-data guard found something in the six files this fix touched (exit ${result.status}):\n`
      + `${String(result.stdout || '').trim()}\n${String(result.stderr || '').trim()}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

check('the two temp-root fences no longer hardcode a Windows account name', () => {
  // Positive check, not a search for the retired literal: the fix computes the
  // account's real temp root at runtime, so both files must call the same
  // realpath-of-os.tmpdir() idiom account-profile-boundary.js already uses,
  // and neither may spell out a literal C:\Users\<name>\... string anymore --
  // the owner-data guard check above already proves that; this proves WHY it
  // passes, so a future edit that reintroduces a literal a different way (one
  // the guard's shape rule does not happen to catch) still fails here.
  for (const relative of ['tests/entry/mcp-owner-proxy-lifecycle.js', 'tests/generic-role-authority-hostile.test.js']) {
    const text = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(text, /fs\.realpathSync\.native\(os\.tmpdir\(\)\)/,
      `${relative} must compute its temp-root fence from os.tmpdir(), not a hardcoded account path`);
    assert.doesNotMatch(text, /[A-Za-z]:\\\\Users\\\\/,
      `${relative} still spells out a literal drive-letter Users path`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed, ${skipped} missing-profile checks skipped`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  ${failure.name}: ${failure.error && failure.error.message}`);
  process.exit(1);
}
