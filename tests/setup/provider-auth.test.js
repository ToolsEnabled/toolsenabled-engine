#!/usr/bin/env node
/* Mutation check:
 * Changed guided: Object.freeze(['codex']) to Object.freeze(['claude']) in provider-auth.js.
 * The edit landed: yes (the mutated source contained claude and no longer contained codex there).
 * This test went red: yes, exiting 1 when the guided-tier assertion received ['claude'].
 */
'use strict';

const assert = require('node:assert/strict');

const providerAuth = require('../../src/lib/setup/provider-auth');

function result(status = 0, stdout = '', stderr = '') {
  return { status, stdout, stderr };
}

function scriptedRunner(steps) {
  let index = 0;
  const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    assert.ok(index < steps.length, `unexpected command: ${command} ${args.join(' ')}`);
    const step = steps[index++];
    assert.deepEqual([command, ...args], step.command);
    return step.result;
  };
  runner.calls = calls;
  runner.assertFinished = () => assert.equal(index, steps.length, 'all expected commands were called');
  return runner;
}

function assertRefusal(fn, code) {
  assert.throws(fn, error => error && error.code === code);
}

function main() {
  assert.deepEqual(providerAuth.PROVIDERS, ['codex', 'claude']);
  assert.deepEqual(providerAuth.providersForTier('guided'), ['codex']);
  assert.deepEqual(providerAuth.providersForTier('standard'), ['codex', 'claude']);
  assertRefusal(() => providerAuth.providersForTier('expert'), 'SETUP_TIER_UNKNOWN');
  assertRefusal(() => providerAuth.probeProvider('gemini'), 'SETUP_PROVIDER_UNKNOWN');

  const missingCodex = providerAuth.probeProvider('codex', {
    runner: () => ({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }),
    env: {}
  });
  assert.deepEqual(missingCodex, {
    provider: 'codex', installed: false, signedIn: false,
    detail: 'the assistant program is not on this computer yet'
  });

  const signedInCodexRunner = scriptedRunner([
    { command: ['codex', '--version'], result: result(0, 'codex 1.0') },
    { command: ['codex', 'login', 'status'], result: result(0, 'Logged in') }
  ]);
  assert.deepEqual(providerAuth.probeProvider('codex', { runner: signedInCodexRunner, env: {} }), {
    provider: 'codex', installed: true, signedIn: true,
    detail: 'already signed in on this computer'
  });
  signedInCodexRunner.assertFinished();

  assert.deepEqual(providerAuth.probeProvider('claude', {
    runner: () => result(0, '2.0'), env: { ANTHROPIC_API_KEY: ' configured ' }
  }), {
    provider: 'claude', installed: true, signedIn: true,
    detail: 'a key is configured for this computer'
  });

  const loginRunner = scriptedRunner([
    { command: ['codex', '--version'], result: result(0) },
    {
      command: ['codex', 'login', '--device-auth'],
      result: result(1, '', 'Visit https://auth.example/device and enter ABCD-2345')
    }
  ]);
  assert.deepEqual(providerAuth.startCodexDeviceLogin({ runner: loginRunner, env: {}, timeoutMs: 321 }), {
    started: true,
    userCode: 'ABCD-2345',
    verificationUrl: 'https://auth.example/device',
    message: 'Open the page shown and enter this code. Come back here when the page says you are signed in.'
  });
  assert.equal(loginRunner.calls[1].options.timeout, 321);

  const missingLoginRunner = scriptedRunner([
    {
      command: ['codex', '--version'],
      result: { error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) }
    }
  ]);
  const outputWrites = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = chunk => { outputWrites.push(['stdout', chunk]); return true; };
  process.stderr.write = chunk => { outputWrites.push(['stderr', chunk]); return true; };
  const missingLogin = providerAuth.startCodexDeviceLogin({ runner: missingLoginRunner, env: {} });
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  assert.deepEqual(missingLogin, {
    started: false,
    code: 'SETUP_PROVIDER_CLI_MISSING',
    message: 'The assistant program is not on this computer yet. Setup will get it before you sign in.',
    signupUrl: 'https://chatgpt.com/'
  });
  assert.equal(Object.isFrozen(missingLogin), true);
  assert.deepEqual(outputWrites, [], 'a missing CLI refusal must not write output');
  missingLoginRunner.assertFinished();
  assert.equal(missingLoginRunner.calls.length, 1, 'a missing CLI must not start the device-login command');

  const noCodeRunner = scriptedRunner([
    { command: ['codex', '--version'], result: result(0) },
    { command: ['codex', 'login', '--device-auth'], result: result(1, '', 'authorization failed') }
  ]);
  assert.equal(providerAuth.startCodexDeviceLogin({ runner: noCodeRunner }).code, 'SETUP_PROVIDER_CODE_NOT_SHOWN');

  assert.deepEqual(providerAuth.verifyCodexSignIn({ runner: () => result(0), env: {} }), { signedIn: true });
  assert.deepEqual(providerAuth.verifyCodexSignIn({ runner: () => result(1), env: {} }), {
    signedIn: false, reason: 'not signed in yet'
  });

  assert.equal(providerAuth.checkClaudeApiKeyShape('  sk-ant-12345678901234567890  ').ok, true);
  assert.equal(providerAuth.checkClaudeApiKeyShape('').code, 'SETUP_CLAUDE_KEY_MISSING');
  assert.equal(providerAuth.checkClaudeApiKeyShape('sk-ant-has spaces in it').code, 'SETUP_CLAUDE_KEY_MALFORMED');
  assert.equal(providerAuth.checkClaudeApiKeyShape('other-12345678901234567890').code, 'SETUP_CLAUDE_KEY_MALFORMED');

  const writes = [];
  const stored = providerAuth.storeClaudeApiKey('  sk-ant-12345678901234567890  ', {
    setSecret: (key, value) => writes.push([key, value])
  });
  assert.deepEqual(writes, [['anthropic_api_key', 'sk-ant-12345678901234567890']]);
  assert.deepEqual(stored, { stored: true, vaultKey: 'anthropic_api_key' });
  assert.equal(JSON.stringify(stored).includes('1234567890'), false, 'the result must not expose the secret');
  assertRefusal(() => providerAuth.storeClaudeApiKey('bad', { setSecret: assert.fail }), 'SETUP_CLAUDE_KEY_MALFORMED');

  assert.deepEqual(providerAuth.claudeHandoff(), {
    route: 'deep-link',
    url: 'https://claude.ai/download',
    message: 'Sign in inside the Claude CLI itself, then come back here. This program never asks for that password.'
  });
  assert.deepEqual(providerAuth.helperHandoffCode({
    tier: 'standard', workspace: '/work/Customer Site', random: Buffer.from([0, 1, 2, 3, 4])
  }), {
    code: 'TE-ABCDE',
    resumes: { tier: 'standard', workspaceLeaf: 'Customer Site' },
    carriesCredential: false
  });

  const optionsRunner = scriptedRunner([
    { command: ['codex', '--version'], result: result(0) },
    { command: ['codex', 'login', 'status'], result: result(1) },
    { command: ['claude', '--version'], result: result(0) }
  ]);
  const options = providerAuth.providerOptionsForTier('standard', { runner: optionsRunner, env: {} });
  assert.deepEqual(options.routes, [
    { provider: 'codex', route: 'device-code', signedIn: false },
    { provider: 'claude', route: 'paste-key', signedIn: false },
    { provider: 'claude', route: 'deep-link', signedIn: false }
  ]);
  assert.equal(options.anySignedIn, false);
  assert.equal(Object.isFrozen(options), true);
  assert.equal(Object.isFrozen(options.providers), true);
  assert.equal(Object.isFrozen(options.routes), true);

  assertRefusal(
    () => providerAuth.verifyCodexSignIn({ runner: () => ({ status: null, stdout: '', stderr: '' }) }),
    'SETUP_PROVIDER_PROBE_FAILED'
  );

  console.log('provider-auth behavior: PASS');
}

main();
