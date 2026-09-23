'use strict';
/* THE PATH THE OTHER TESTS DID NOT TAKE.
 *
 * claude-process.js removed every casing of ANTHROPIC_API_KEY from a session's
 * environment and then re-set it from `process.env.ANTHROPIC_API_KEY`, because
 * that was the DEFAULT VALUE of startClaudeSession()'s own `apiKey` parameter.
 * The scrub removed the key and the caller put it back.
 *
 * Twenty-nine tests were green over that. Both of the ones that cover this
 * function pass the key EXPLICITLY -- `undefined` at
 * claude-session-environment.test.js:98, `null` at
 * claude-subscription-credential-fence.test.js:224 -- so between them they
 * exercised only the branch no production caller takes. A default parameter is
 * invisible to a test that always supplies the argument.
 *
 * So this file tests the DEFAULT ITSELF, by calling the exported
 * defaultApiKey() rather than re-typing `undefined` and hoping it is the same
 * thing, and it proves the result against a real spawned child.
 *
 * It also covers the same bug on the OUTPUT path: stderr redaction looked up
 * `env.ANTHROPIC_API_KEY` exactly, so a child holding a lowercase spelling
 * printed the raw secret to an observer with no redaction at all.
 */

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');

const claudeProcess = require('../../src/lib/agent-engine/claude-process.js');

const MARKER = 'SYNTHETIC-CLAUDE-DEFAULT-MARKER-NOT-A-CREDENTIAL';

let spawns = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function childResolves(env, name) {
  spawns += 1;
  const script = `const v=process.env[${JSON.stringify(name)}];process.stdout.write(v===undefined?'ABSENT':'PRESENT');`;
  const result = spawnSync(process.execPath, ['-e', script], {
    env, encoding: 'utf8', windowsHide: true, timeout: 30_000
  });
  assert.ok(!result.error, `child failed to spawn: ${result.error && result.error.message}`);
  return String(result.stdout).trim();
}

function withAmbient(planted, run) {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of Object.entries(planted)) process.env[key] = value;
    return run();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) process.env[key] = value;
  }
}

function cleanParent() {
  const base = {};
  for (const key of Object.keys(process.env)) {
    if (/^(anthropic|claude_code|aws_)/i.test(key)) continue;
    base[key] = process.env[key];
  }
  return base;
}

/* ------------------------------------------------------------------ */
test('CONTROL: the ambient key really does reach an unscrubbed child', () => {
  const parent = { ...cleanParent(), anthropic_api_key: MARKER };
  assert.equal(childResolves(parent, 'anthropic_api_key'), 'PRESENT',
    'if this is ABSENT the rest of this file proves nothing');
});

test('the DEFAULT apiKey does not carry the ambient key into a real child', () => {
  withAmbient({ ...cleanParent(), anthropic_api_key: MARKER }, () => {
    // The value startClaudeSession() actually runs with -- not a re-typed guess.
    const env = claudeProcess.createSessionEnvironment(claudeProcess.defaultApiKey(), 'C:\\round2-nonexistent');
    assert.equal(childResolves(env, 'anthropic_api_key'), 'ABSENT',
      'the default path put the ambient key back after the scrub removed it');
  });
});

test('defaultApiKey() is not derived from ambient state at all', () => {
  for (const spelling of ['ANTHROPIC_API_KEY', 'anthropic_api_key', 'Anthropic_Api_Key']) {
    withAmbient({ ...cleanParent(), [spelling]: MARKER }, () => {
      assert.ok(!claudeProcess.defaultApiKey(),
        `defaultApiKey() returned a value while ${spelling} was set; it must never read the environment`);
    });
  }
});

test('createSessionEnvironment honours a STATED key before the transport boundary', () => {
  withAmbient(cleanParent(), () => {
    const env = claudeProcess.createSessionEnvironment('stated-key-value', 'C:\\round2-nonexistent');
    assert.equal(env.ANTHROPIC_API_KEY, 'stated-key-value');
    assert.equal(childResolves(env, 'ANTHROPIC_API_KEY'), 'PRESENT');
  });
});

test('a credential found only in transport env is scrubbed, not relabelled as STATED', () => {
  const env = { ...cleanParent(), ANTHROPIC_API_KEY: MARKER };
  const seen = [];
  const transport = claudeProcess.createClaudeAcpTransport({
    command: process.execPath,
    args: ['-e', "process.stderr.write('KEY='+(process.env.ANTHROPIC_API_KEY||'none'))"],
    env
  });
  spawns += 1;
  transport.onStderr(chunk => seen.push(String(chunk)));
  return new Promise(resolve => setTimeout(() => {
    const text = seen.join('');
    assert.ok(text.includes('KEY=none'),
      'a credential present only in transport env was treated as caller-stated');
    assert.ok(!text.includes(MARKER),
      'a credential present only in transport env reached the child');
    try { transport.close(); } catch { /* teardown */ }
    resolve();
  }, 2500));
});

test('an OMITTED transport env is scrubbed, not the full ambient environment', () => {
  /* `options.env === undefined ? process.env : options.env` handed an omitted
   * env straight to spawn() -- the INHERITS_AMBIENT shape, spelled as a default
   * parameter instead of an absent option, so the spawn-site gate could not see
   * it. */
  withAmbient({ ...cleanParent(), anthropic_api_key: MARKER }, () => {
    const seen = [];
    const transport = claudeProcess.createClaudeAcpTransport({
      command: process.execPath,
      args: ['-e', "process.stderr.write('KEY='+(process.env.ANTHROPIC_API_KEY||'none'))"]
    });
    spawns += 1;
    transport.onStderr(chunk => seen.push(String(chunk)));
    return new Promise(resolve => setTimeout(() => {
      const text = seen.join('');
      assert.ok(text.includes('KEY=none'),
        `a transport with no env option handed the child the ambient key (child said: ${text.replace(MARKER, '<MARKER>')})`);
      try { transport.close(); } catch { /* teardown */ }
      resolve();
    }, 2500));
  });
});

test('stderr redaction finds the key in ANY casing', () => {
  const checks = [];
  for (const spelling of ['ANTHROPIC_API_KEY', 'anthropic_api_key', 'Anthropic_Api_Key']) {
    const env = { ...cleanParent(), [spelling]: MARKER };
    const seen = [];
    const transport = claudeProcess.createClaudeAcpTransport({
      command: process.execPath,
      args: ['-e', `process.stderr.write('leaked='+(process.env[${JSON.stringify(spelling)}]||'none')+'\\n')`],
      env,
      credentialEnvironment: { [spelling]: MARKER }
    });
    spawns += 1;
    transport.onStderr(chunk => seen.push(String(chunk)));
    checks.push(new Promise(resolve => setTimeout(() => {
      const text = seen.join('');
      // Report booleans only. The marker is synthetic, but printing a value
      // found in an environment is the habit this whole class punishes.
      assert.ok(!text.includes(MARKER),
        `spelling ${spelling}: the raw value reached a stderr observer unredacted`);
      assert.ok(text.includes('[REDACTED]'),
        `spelling ${spelling}: no redaction marker, so nothing was redacted`);
      try { transport.close(); } catch { /* teardown */ }
      resolve();
    }, 2500)));
  }
  return Promise.all(checks);
});

test('CLAUDE_CODE_OAUTH_TOKEN is in the session scrub list', () => {
  assert.ok(claudeProcess.CLAUDE_SESSION_SCRUB_NAMES.includes('CLAUDE_CODE_OAUTH_TOKEN'));
  assert.ok(claudeProcess.CLAUDE_SESSION_SCRUB_NAMES.includes('ANTHROPIC_API_KEY'),
    'the API key belongs in the one list, not in a second delete after it');
});

/* ------------------------------------------------------------------ */
async function main() {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}\n    ${error && error.message}`);
    }
  }
  console.log(`# ${spawns} real child spawns`);
  if (failed > 0) {
    console.error(`\n${failed} failing`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nall ${tests.length} claude ambient-key-default checks passed`);
}

main();
