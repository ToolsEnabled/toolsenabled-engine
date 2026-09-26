'use strict';

const isolated = require('./lib/isolated-environment').activate('isolation-contract');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const audit = require('../src/lib/audit');
const killSwitch = require('../src/lib/kill-switch');
const { assertActive } = require('../src/lib/policy');
const { closeStateStore, getStateStore } = require('../src/lib/state-store');

try {
  for (const name of [
    'TOOLSENABLED_AUDIT_DB', 'TOOLSENABLED_AUDIT_JSONL_PATH', 'TOOLSENABLED_AUDIT_TEXT_PATH',
    'TOOLSENABLED_AUDIT_EMERGENCY_PATH', 'TOOLSENABLED_VAULT_PATH', 'TOOLSENABLED_KILLSWITCH_PATH',
    'TOOLSENABLED_STATE_PATH', 'TOOLSENABLED_SCHEDULER_LEGACY_PATH',
    'TOOLSENABLED_BROWSER_PROFILE_PATH', 'TOOLSENABLED_PLAYWRIGHT_OUTPUT_PATH'
  ]) {
    assert.equal(path.dirname(process.env[name]), isolated.root, `${name} must point into the disposable test root`);
  }

  assert.equal(killSwitch.status().path, process.env.TOOLSENABLED_KILLSWITCH_PATH);
  assert.equal(killSwitch.status().active, false);
  execFileSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(__dirname, '..', 'tools', 'kill.ps1'), 'activate'
  ], { env: process.env, stdio: 'ignore' });
  assert.equal(killSwitch.status().active, true, 'PowerShell and Node must honor the same injected kill-switch path');
  assert.throws(() => assertActive('isolation.probe'), /KILLSWITCH is active/);
  killSwitch.deactivate();

  const auditStatus = audit.status();
  assert.equal(auditStatus.path, process.env.TOOLSENABLED_AUDIT_DB);
  assert.equal(audit.verify().valid, true);
  assert.equal(getStateStore().health().path, process.env.TOOLSENABLED_STATE_PATH);

  console.log('Mandatory test-isolation contract passed.');
} finally {
  closeStateStore();
  audit.resetForTests();
  killSwitch.deactivate();
}
