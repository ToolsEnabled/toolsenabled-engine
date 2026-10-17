'use strict';
/* An agent CLI the person runs gets the person's environment, sign-in
 * variables included (src/lib/proc/hidden-spawn.js, agentCliEnvironment).
 * Fleet's own helper children keep the credential scrub. Anthropic's terms for
 * running Claude Code in a product forbid removing, disabling or restricting any
 * of its authentication methods, so a worker must see the same API-key, cloud
 * and gateway variables the person's own session has. */
require('./lib/isolated-environment').activate('agent-cli-environment-passthrough');

const test = require('node:test');
const assert = require('node:assert/strict');

const { spawnHidden } = require('../src/lib/proc/hidden-spawn');
const claudeCli = require('../src/lib/agent-engine/claude-cli-process');

const SIGN_IN = Object.freeze({
  ANTHROPIC_API_KEY: 'test-anthropic-value',
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_BEARER_TOKEN_BEDROCK: 'test-bedrock-value',
  OPENAI_API_KEY: 'test-openai-value',
  GEMINI_API_KEY: 'test-gemini-value'
});
const BASE = Object.freeze({ PATH: process.env.PATH || '/usr/bin:/bin', ...SIGN_IN });
const PRINT_ENV = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(SIGN_IN))}.map(n => [n, process.env[n] ?? null]))))`;

function childEnvironment(options) {
  return new Promise((resolve, reject) => {
    const child = spawnHidden(process.execPath, ['-e', PRINT_ENV], { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`child exited ${code}`))));
  });
}

test('an agent CLI child receives every sign-in variable the caller supplied', async () => {
  assert.deepEqual(await childEnvironment({ env: BASE, agentCli: true, containProcessTree: false }), { ...SIGN_IN });
});

test('an agent CLI child leading its own process group receives them too', { skip: process.platform !== 'linux' }, async () => {
  assert.deepEqual(await childEnvironment({ env: BASE, agentCli: true, containProcessTree: false, processGroup: true }), { ...SIGN_IN });
});

test('a contained agent CLI child receives them too', { skip: process.platform !== 'linux' }, async () => {
  assert.deepEqual(await childEnvironment({ env: BASE, agentCli: true, containProcessTree: true }), { ...SIGN_IN });
});

test('a helper child that is not an agent CLI still has them scrubbed', async () => {
  const seen = await childEnvironment({ env: BASE, containProcessTree: false });
  for (const name of Object.keys(SIGN_IN)) assert.equal(seen[name], null, `${name} is scrubbed from a helper child`);
});

test('agentCli must be a boolean', () => {
  assert.throws(() => spawnHidden(process.execPath, ['-e', ''], { env: BASE, agentCli: 'yes' }),
    error => error.code === 'HIDDEN_SPAWN_AGENT_CLI_INVALID');
});

test('the Claude launcher no longer deletes sign-in variables, and still redacts their values', () => {
  const env = claudeCli.launchEnvironment({ ...BASE });
  for (const [name, value] of Object.entries(SIGN_IN)) assert.equal(env[name], value);
  assert.ok(claudeCli.CREDENTIAL_ENV_NAMES.includes('ANTHROPIC_API_KEY'), 'the redaction list still names the key');
});

test("a worker gets none of the lead session's own variables, and keeps the person's OAuth scopes", () => {
  const { HOST_SESSION_ENV } = require('../src/lib/host-worker-session');
  for (const name of ['CLAUDE_EFFORT', 'CLAUDE_PID', 'CLAUDE_JOB_DIR', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID']) {
    assert.ok(HOST_SESSION_ENV.has(name), name);
  }
  // A sign-in variable of the person's own token, which Fleet never removes.
  assert.equal(HOST_SESSION_ENV.has('CLAUDE_CODE_OAUTH_SCOPES'), false);
});
