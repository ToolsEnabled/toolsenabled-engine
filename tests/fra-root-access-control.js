'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceControl = path.join(root, 'tools', 'fra-root-access-control.ps1');
const sourceProbe = path.join(root, 'tools', 'fra-root-access-probe.ps1');

function invoke(script, action) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Action', action
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    env: { ...process.env }
  });
  return {
    ...result,
    output: JSON.parse(String(result.stdout).trim())
  };
}

function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fra-root-access-control-'));
  const tools = path.join(fixture, 'tools');
  fs.mkdirSync(tools);
  const control = path.join(tools, 'fra-root-access-control.ps1');
  fs.copyFileSync(sourceControl, control);
  fs.copyFileSync(sourceProbe, path.join(tools, 'fra-root-access-probe.ps1'));
  try {
    const before = invoke(control, 'Status');
    assert.equal(before.status, 1);
    assert.equal(before.output.ok, false);
    assert.equal(before.output.outcome, 'not_hardened');
    assert.equal(before.output.secretValuesEmitted, false);
    assert.equal(fs.existsSync(path.join(fixture, 'state')), false);

    const hardened = invoke(control, 'Harden');
    assert.equal(hardened.status, 0, hardened.stderr || hardened.stdout);
    assert.equal(hardened.output.ok, true);
    assert.equal(hardened.output.outcome, 'hardened');
    assert.match(hardened.output.policyDigest, /^[a-f0-9]{64}$/);
    assert.match(hardened.output.descriptorDigest, /^[a-f0-9]{64}$/);
    const preimage = JSON.parse(fs.readFileSync(
      path.join(fixture, 'state', 'fra-root-access-preimage.json'),
      'utf8'
    ).replace(/^\uFEFF/, ''));
    assert.equal(preimage.schemaVersion, 'fra-root-access-preimage.v1');
    assert.match(preimage.descriptorDigest, /^[a-f0-9]{64}$/);
    assert.equal(preimage.secretValuesEmitted, false);

    const second = invoke(control, 'Harden');
    assert.equal(second.status, 0);
    assert.equal(second.output.outcome, 'already_hardened');
    assert.equal(second.output.descriptorDigest, hardened.output.descriptorDigest);
    process.stdout.write('fra root access control tests passed\n');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

main();
