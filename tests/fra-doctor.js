'use strict';

// fra-doctor must never be green about a lane that cannot start.
//
// WHY THIS TEST EXISTS. On 2026-08-10 this command printed "VERDICT: HEALTHY"
// and exited 0 while FRA was completely unable to start: the tree root's DACL
// had never been hardened, and both src/full-remote-access-bridge.js and
// tools/remote-agent-mcp-proxy.js refuse to run unless verifyFraRootAccess()
// passes. The doctor checked anchors, the policy digest, both capability
// manifests, and both credential slots -- every gate except the one that was
// actually failing, which it did not reference at all.
//
// A false green in a health check is worse than having no health check, because
// someone acts on it. The invariant pinned here is not "root access passes" --
// that is a property of the machine, and it will change the moment somebody
// runs the Harden action. The invariant is that THE DOCTOR'S VERDICT AGREES
// WITH THE GATE THE BRIDGE ACTUALLY ENFORCES, whichever way that gate answers.
// That statement stays true and stays meaningful on a hardened machine too.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DOCTOR = path.join(ROOT, 'tools', 'fra-doctor.js');
const { verifyFraRootAccess } = require('../src/lib/fra-root-access');

// The literal check whose ZERO result was the original bug: the doctor did not
// mention root access anywhere. Cheap, and it catches an outright deletion that
// the behavioural assertions below would only catch on a failing machine.
const source = fs.readFileSync(DOCTOR, 'utf8');
assert.ok(/verifyFraRootAccess/.test(source),
  'fra-doctor must call the same root-access gate the FRA bridge enforces');
assert.ok(/'root-access'/.test(source),
  'a root-access refusal must be reportable as its own finding area');

// Ground truth, taken from the gate itself rather than from the doctor.
let gatePasses;
let gateCode = null;
try {
  gatePasses = verifyFraRootAccess({ root: ROOT }).valid === true;
} catch (error) {
  gatePasses = false;
  gateCode = (error && error.code) || 'FRA_ROOT_ACCESS_INVALID';
}

const run = spawnSync(process.execPath, [DOCTOR, '--json', '--no-vault'],
  { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
const report = JSON.parse(run.stdout);

assert.ok(report.rootAccess, 'the doctor must report a root-access rung at all');
assert.equal(report.rootAccess.ok, gatePasses,
  'the doctor must agree with the gate the bridge enforces, not with a subset of the gates');

if (!gatePasses) {
  // The failing direction, which is the one that actually misled someone.
  assert.equal(report.ok, false, 'the verdict cannot be HEALTHY while FRA cannot start');
  assert.notEqual(run.status, 0, 'a doctor that cannot honestly say healthy must not exit 0');
  // Deliberately NOT "some finding has area root-access". The doctor raises a
  // second root-access finding when the tree has never been hardened, and an
  // earlier draft of this test accepted that one as proof -- so neutering the
  // primary refusal left the test green. That matters on a machine that WAS
  // hardened once and later drifted: the never-hardened finding would not fire,
  // and the false green would be back. The refusal itself must be reported, and
  // it is identified by carrying the specific code.
  const refusal = report.findings.filter(finding =>
    finding.area === 'root-access'
    && /^FRA_ROOT_ACCESS_[A-Z_]+/.test(String(finding.detail || '')));
  assert.equal(refusal.length >= 1, true,
    'the refusal itself must be a named problem carrying its code, independent of whether the tree was ever hardened');
  // This tool exists to print the address, not just sound the alarm: the gate
  // itself collapses every refusal to FRA_ROOT_ACCESS_INVALID, so the doctor
  // recovers the specific code from the read-only probe.
  assert.match(String(report.rootAccess.granularCode || report.rootAccess.code),
    /^FRA_ROOT_ACCESS_[A-Z_]+$/, 'the refusal must be named with a specific code');
  if (report.rootAccess.granularCode) {
    assert.notEqual(report.rootAccess.granularCode, 'FRA_ROOT_ACCESS_TARGET_INVALID',
      'the probe must be pointed at this tree; TARGET_INVALID means the doctor asked about nothing');
  }
} else {
  assert.ok(report.findings.every(finding => finding.area !== 'root-access'),
    'a passing gate must not be reported as a problem');
}

// No secret, path, SID or account name may reach this surface -- the reason the
// underlying probe emits codes only.
const serialized = JSON.stringify(report.rootAccess);
assert.equal(/S-1-5-|\\\\Users\\\\|password|token/i.test(serialized), false,
  'the root-access rung must carry codes and digests only');

console.log(JSON.stringify({
  ok: true,
  gatePasses,
  gateCode,
  doctorExit: run.status,
  doctorRootAccess: report.rootAccess,
  verdictAgreesWithGate: true
}));
