/* Mutation check:
 * Replaced `input: hasSecretInput ? options.value : undefined` in the module
 * with `input: undefined` to drop the secret supplied on stdin.
 * The edit landed: yes. This isolated test went red: yes (exit code 1).
 */
'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const subjectPath = require.resolve('../../src/lib/secret-store/powershell');
const calls = [];
const originalLoad = Module._load;

// Exercise the exported JavaScript boundary without requiring Windows or
// launching PowerShell. Only the operating-system seams are replaced; the
// subject still builds the complete process request itself.
Module._load = function loadWithPowerShellSeams(request, parent, isMain) {
  if (parent && parent.filename === subjectPath) {
    if (request === 'node:fs') {
      return { constants: { F_OK: 0 }, accessSync() {} };
    }
    if (request === 'node:child_process') {
      return {
        spawnSync(command, args, options) {
          calls.push({ command, args, options });
          return { status: 0, stdout: '{"stored":true}', stderr: '' };
        }
      };
    }
    if (request === '../vault-platform') return { assertWindowsVaultPlatform() {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

let powershell;
try {
  powershell = require(subjectPath);
} finally {
  Module._load = originalLoad;
}

const vaultPath = path.join('relative-fixtures', 'test-vault.json');
const result = powershell.mutate('rotate', 'github_token', 'canary-secret', {
  reason: 'scheduled renewal',
  expiresAt: '2030-01-02T03:04:05Z',
  staleAfterDays: 30,
  vaultPath,
  lockTimeoutMs: 750
});

assert.deepEqual(result, { stored: true }, 'mutate returns the manager JSON response');
assert.equal(calls.length, 1, 'mutate starts exactly one manager process');

const call = calls[0];
assert.equal(call.command, 'powershell.exe');
assert.deepEqual(call.args.slice(-10), [
  powershell.MANAGER,
  'rotate',
  '-Name', 'github_token',
  '-Reason', 'scheduled renewal',
  '-ExpiresAt', '2030-01-02T03:04:05Z',
  '-StaleAfterDays', '30'
]);
assert.equal(call.options.input, 'canary-secret',
  'rotate sends the supplied secret through stdin rather than an argument');
assert.equal(call.options.env.TOOLSENABLED_VAULT_PATH, path.resolve(vaultPath));
assert.equal(call.options.env.TOOLSENABLED_VAULT_LOCK_TIMEOUT_MS, '750');
assert.equal(call.options.shell, false);
assert.equal(call.options.stdio[0], 'pipe');

console.log('PASS powershell mutate builds a safe rotate manager request and returns its response');
