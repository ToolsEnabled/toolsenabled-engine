'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const access = require('../src/lib/fra-root-access');

function code(fn, expected) {
  assert.throws(fn, error => error && error.code === expected);
}

function main() {
  const descriptorDigest = 'a'.repeat(64);
  let captured = null;
  const report = access.verifyFraRootAccess({
    root: 'C:\\fixed\\ToolsEnabled',
    platform: 'win32',
    environment: {
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      COMPUTERNAME: 'FIXTURE'
    },
    scriptPath: 'C:\\fixed\\tools\\fra-root-access-probe.ps1',
    spawnSyncApi: (executable, args, options) => {
      captured = { executable, args, options };
      return {
        status: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          valid: true,
          policyDigest: access.ROOT_ACCESS_POLICY_DIGEST,
          descriptorDigest,
          secretValuesEmitted: false
        })
      };
    }
  });
  assert.equal(report.descriptorDigest, descriptorDigest);
  assert.equal(captured.executable, path.win32.join(
    'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  ));
  assert.equal(captured.options.env.TOOLSENABLED_FRA_ROOT_ACCESS_TARGET,
    'C:\\fixed\\ToolsEnabled');
  assert.equal(Object.prototype.hasOwnProperty.call(captured.options.env, 'PATH'), false);
  assert.equal(JSON.stringify(captured).includes('TOKEN'), false);

  code(() => access.normalizeReport({
    schemaVersion: 1,
    valid: true,
    policyDigest: 'b'.repeat(64),
    descriptorDigest,
    secretValuesEmitted: false
  }), 'FRA_ROOT_ACCESS_INVALID');
  code(() => access.verifyFraRootAccess({
    root: 'C:\\fixed\\ToolsEnabled',
    platform: 'linux',
    scriptPath: 'C:\\fixed\\tools\\fra-root-access-probe.ps1'
  }), 'FRA_ROOT_ACCESS_UNSUPPORTED');
  code(() => access.verifyFraRootAccess({
    root: 'C:\\fixed\\ToolsEnabled',
    platform: 'win32',
    scriptPath: 'C:\\fixed\\tools\\fra-root-access-probe.ps1',
    spawnSyncApi: () => ({ status: 1, stdout: '{"valid":false}' })
  }), 'FRA_ROOT_ACCESS_INVALID');
  process.stdout.write('fra root access tests passed\n');
}

main();
