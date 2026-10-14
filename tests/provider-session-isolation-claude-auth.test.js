'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const isolation = require('../src/lib/provider-session-isolation');

test('native Claude keeps configured auth methods within the private profile', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-claude-auth-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  const base = { TOOLSENABLED_PROVIDER_ISOLATION_ROOT:root,
    TOOLSENABLED_STATE_ROOT:path.join(root,'services','capability'), PATH:'fixture-path' };
  const context = isolation.isolationContext(base);
  const home = path.join(root,'claude-home');
  const settings = { ANTHROPIC_API_KEY:'fixture', CLAUDE_CODE_OAUTH_TOKEN:'fixture',
    CLAUDE_CODE_USE_VERTEX:'1', CLAUDE_CODE_USE_BEDROCK:'1', AWS_PROFILE:'fixture-profile',
    GOOGLE_APPLICATION_CREDENTIALS:path.join(root,'cloud-credential'),
    ANTHROPIC_IDENTITY_TOKEN_FILE:path.join(root,'identity-credential') };
  const output = isolation.providerSessionEnvironment({ ...base,...settings },
    { provider:'claude', home, requireHome:true });
  for (const [name,value] of Object.entries(settings)) assert.ok(output[name] === value, name);
  assert.equal(output.HOME,context.userProfile);
  assert.equal(output.CLAUDE_CONFIG_DIR,home);
  assert.equal(fs.existsSync(settings.GOOGLE_APPLICATION_CREDENTIALS),false,
    'the test does not need to create or read a credential');
  for (const name of ['GOOGLE_APPLICATION_CREDENTIALS','ANTHROPIC_IDENTITY_TOKEN_FILE']) {
    const foreign = path.join(path.dirname(root),'outside-auth');
    assert.throws(() => isolation.providerSessionEnvironment({ ...base,[name]:foreign },
      { provider:'claude', home, requireHome:true }), {code:'AGENT_PROVIDER_ISOLATION_PATH'},
      `native auth file setting ${name} crossed the private profile`);
  }
});
