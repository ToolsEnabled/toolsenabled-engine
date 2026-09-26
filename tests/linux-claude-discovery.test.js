'use strict';
require('./lib/isolated-environment').activate('linux-claude-discovery');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { executableFor } = require('../src/lib/providers/cli-provider-gateway');
const { probeClaudeAuth } = require('../src/lib/providers/claude-auth-probe');

test('Linux discovery uses absolute POSIX locations and executable access on every host', () => {
  const executable = new Map([['/fixture/login/.local/bin/claude', true]]);
  const inspected = [];
  const options = { platform: 'linux', loginHome: '/fixture/login',
    environment: { PATH: '.:relative', HOME: '/wrong/profile' },
    fsImpl: {
      statSync(file) {
        inspected.push(file);
        if (!executable.has(file)) throw Object.assign(new Error('Fixture absent'), { code: 'ENOENT' });
        return { isFile: () => true };
      },
      accessSync(file, mode) {
        assert.equal(mode, fs.constants.X_OK);
        if (!executable.get(file)) throw Object.assign(new Error('Fixture non-executable'), { code: 'EACCES' });
      }
    }
  };
  assert.deepEqual(executableFor('claude', options), { command: '/fixture/login/.local/bin/claude', prefixArgs: [] });
  assert.ok(inspected.every(file => file.startsWith('/fixture/login/')));
  executable.set('/fixture/login/.local/bin/claude', false);
  assert.equal(executableFor('claude', options).command, 'claude');
  executable.set('/fixture/explicit/claude', true);
  assert.equal(executableFor('claude', { ...options, environment: { PATH: '/fixture/explicit' } }).command, '/fixture/explicit/claude');
  inspected.length = 0;
  assert.equal(executableFor('claude', { ...options, loginHome: 'C:\\fixture\\login' }).command, 'claude');
  assert.deepEqual(inspected, [], 'A foreign-platform path is never inspected as a Linux home');
});

test('native Linux discovery honors login-user executable permissions', { skip: process.platform !== 'linux' && 'Requires a native POSIX filesystem and executable permissions' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-cli-discovery-'));
  const bin = path.join(root, '.local/bin');
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, 'claude');
  fs.writeFileSync(file, 'fixture executable', { mode: 0o700 });
  try {
    const options = { platform: 'linux', loginHome: root, environment: { PATH: '.:relative', HOME: '/wrong/profile' } };
    assert.deepEqual(executableFor('claude', options), { command: file, prefixArgs: [] });
    fs.chmodSync(file, 0o600);
    assert.equal(executableFor('claude', options).command, 'claude');
    fs.chmodSync(file, 0o700);
    const override = path.join(root, 'explicit'); fs.mkdirSync(override);
    const explicit = path.join(override, 'claude'); fs.writeFileSync(explicit, 'fixture', { mode: 0o700 });
    assert.equal(executableFor('claude', { ...options, environment: { PATH: override } }).command, explicit);
    fs.unlinkSync(explicit); fs.rmdirSync(override);
  } finally { fs.unlinkSync(file); fs.rmdirSync(bin); fs.rmdirSync(path.dirname(bin)); fs.rmdirSync(root); }
});

test('actual status child uses the supplied executable and selected home without inherited nesting marker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-auth-status-child-'));
  const script = path.join(root, 'status.js');
  fs.writeFileSync(script, `const assert=require('node:assert/strict');
assert.deepEqual(process.argv.slice(2), ['auth','status','--json']);
assert.equal(process.env.CLAUDECODE, undefined);
assert.equal(process.env.CLAUDE_CONFIG_DIR, ${JSON.stringify(root)});
console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'fixture'}));`);
  try {
    const result = await probeClaudeAuth({ capability: false, configDir: root, cwd: root,
      executable: { command: process.execPath, prefixArgs: [script] },
      baseEnvironment: { PATH: '/usr/bin:/bin', CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1' } });
    assert.equal(result.billingSource, 'subscription');
    assert.equal(result.capabilityRan, false);
    assert.equal(result.state, 'indeterminate', 'status alone is not an authenticated model turn');
  } finally { fs.unlinkSync(script); fs.rmdirSync(root); }
});
