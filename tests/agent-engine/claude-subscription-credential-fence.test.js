// EXECUTABLE CHANGE
'use strict';

/*
 * This suite exists because claude-agent-acp authenticates from the user's Claude Code
 * subscription session. The isolated CLAUDE_CONFIG_DIR is what prevents this product from
 * routing those subscription credentials. A -32000 "Authentication required" response from
 * the live agent means the fence is working, NOT that the isolation is a bug. Deleting the
 * isolation to make that error disappear would route subscription credentials and violate
 * the licence.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { startClaudeSession } = require('../../src/lib/agent-engine/claude-process');

const FAKE_AGENT_ARG = '--claude-subscription-credential-fence-fake-agent';
const TEMP_CONFIG_PREFIX = 'toolsenabled-claude-acp-';
const FENCE_FAILURE =
  'The isolated CLAUDE_CONFIG_DIR is the licence fence: claude-agent-acp otherwise reads the ' +
  "user's Claude Code subscription credentials, and -32000 Authentication required means the " +
  'fence is working, not a bug. Deleting the isolation to remove that error would route ' +
  'subscription credentials and violate the licence.';

const unsafeSubscriptionAuthMethods = [
  { id: 'oauth-route', name: 'OAuth API key', description: 'Authenticate an API key through OAuth' },
  { id: 'device-route', name: 'Device API key', description: 'Authenticate an API key with a device flow' },
  { id: 'subscription-route', name: 'Subscription API key', description: 'Use a subscription API key' },
  {
    id: 'looks-harmless',
    name: 'API key',
    description: 'Sign in with your Claude.ai subscription'
  }
];
const safeApiKeyAuthMethod = {
  id: 'api-key-safe',
  name: 'Anthropic API key',
  description: 'Use a separately supplied API key'
};

/* THE AMBIENT KEY MUST BE PRESENT FOR THIS SUITE TO PROVE ANYTHING.
 *
 * Until 2026-08-11 this suite ran `delete process.env.ANTHROPIC_API_KEY` and then
 * asserted the child had not received it. That assertion could not fail: the child
 * could not see a variable the parent did not have, whether or not the scrub worked.
 * MEASURED -- removing 'ANTHROPIC_API_KEY' from CLAUDE_SESSION_SCRUB_NAMES left this
 * suite green and still printing "auth tokens stripped", on a machine where the real
 * ANTHROPIC_API_KEY *is* persisted in the owner's environment. The scrub this file
 * exists to guard was the one credential it never tested.
 *
 * The two sibling assertions had it right all along: they plant a decoy VALUE and
 * check it did not survive. This one now does the same. A negative assertion only
 * carries weight when the thing it forbids was actually there to be found. */
const AMBIENT_API_KEY_DECOY = 'ambient-anthropic-api-key-DO-NOT-USE';
/* What a CALLER states, as distinct from what is lying around in the environment.
 * createSessionEnvironment() must re-set the key only from this, never from ambient
 * state -- so the two values must be different or the test cannot tell them apart. */
const CALLER_API_KEY_DECOY = 'decoy-api-key-DO-NOT-USE';

/* DISCRIMINATION REPORT (testcanfail-tests-agent-engine-claude-subscription-credential-fence-test-js)
 *
 * The runtime credential assertions used to stay green when either
 * CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY was deleted from
 * CLAUDE_SESSION_SCRUB_NAMES: hidden-spawn's independent launch scrub masked
 * both mutations. Those mutations printed the suite's normal PASS line and
 * exited 0. The declaration control below closes that blind spot without
 * changing the spawned command, resolution, or any product allowance.
 *
 * RED after deleting CLAUDE_CODE_OAUTH_TOKEN from CLAUDE_SESSION_SCRUB_NAMES:
 * "AssertionError [ERR_ASSERTION]: CLAUDE_SESSION_SCRUB_NAMES must explicitly
 * remove CLAUDE_CODE_OAUTH_TOKEN; a downstream scrub must not mask drift in
 * this Claude-session fence."
 * RED after deleting ANTHROPIC_API_KEY from CLAUDE_SESSION_SCRUB_NAMES:
 * "AssertionError [ERR_ASSERTION]: CLAUDE_SESSION_SCRUB_NAMES must explicitly
 * remove ANTHROPIC_API_KEY; a downstream scrub must not mask drift in this
 * Claude-session fence."
 *
 * Restored source SHA-256 matched the pre-mutation copy byte-for-byte:
 * 9bba165567062e6d997c9396f485806e0be310eb5ccbba88b38ab27f20a34b8c.
 * Restored GREEN: "Claude subscription credential fence tests passed (fresh
 * isolated CLAUDE_CONFIG_DIR, auth tokens stripped, subscription auth refused,
 * temp cleanup verified)."
 *
 * NOT-FOUND (1): other loops are fed by populated literals or by sessions that
 * must already have opened successfully; mutations of unsafe auth selection
 * and cleanup produced the loop assertions' RED messages.
 * NOT-FOUND (2): no exit-status or truthy-return-only assertion.
 * NOT-FOUND (3): catches occur only in teardown or product-independent fake
 * observer behavior; none swallows an assertion under test.
 * NOT-FOUND (4): the fake agent captures child inputs and supplies protocol
 * responses, but no assertion compares product behavior with mocked product
 * behavior.
 * NOT-FOUND (5): no skip or platform-wide precondition guard.
 * NOT-FOUND (6): expected values are fixed policy literals or independently
 * observed filesystem/environment facts, not computed by product code.
 * Preconditions met: Node, child-process spawning, and temporary-directory
 * creation were available. No unmet precondition.
 */

function readClaudeSessionScrubNames() {
  const sourcePath = require.resolve('../../src/lib/agent-engine/claude-process');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const declaration = source.match(
    /const CLAUDE_SESSION_SCRUB_NAMES = Object\.freeze\(\[([\s\S]*?)\n\]\);/
  );
  assert.ok(
    declaration,
    fenceMessage('The test must locate CLAUDE_SESSION_SCRUB_NAMES in claude-process.js.')
  );
  return [...declaration[1].matchAll(/^\s*'([^']+)'\s*,?\s*$/gm)].map(match => match[1]);
}

function fenceMessage(detail) {
  return `${detail} ${FENCE_FAILURE}`;
}

function writeFakeCapture(capturePath, capture) {
  fs.writeFileSync(capturePath, JSON.stringify(capture), 'utf8');
}

function runFakeAgent() {
  const capturePath = process.env.CLAUDE_FENCE_CAPTURE_PATH;
  const requireAuth = process.env.CLAUDE_FENCE_REQUIRE_AUTH === '1';
  const capture = {
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || null,
    hasClaudeCodeOauthToken: Object.hasOwn(process.env, 'CLAUDE_CODE_OAUTH_TOKEN'),
    hasAnthropicAuthToken: Object.hasOwn(process.env, 'ANTHROPIC_AUTH_TOKEN'),
    hasAnthropicApiKey: Object.hasOwn(process.env, 'ANTHROPIC_API_KEY'),
    /* Presence alone cannot tell the two decoys apart, and the difference is the
     * whole fence: a stated key SHOULD reach the child, an ambient one must not.
     * Only ever one of this file's own DO-NOT-USE literals -- the parent overwrites
     * the real variable before any spawn, so a genuine credential cannot land here. */
    anthropicApiKeyValue: Object.hasOwn(process.env, 'ANTHROPIC_API_KEY')
      ? process.env.ANTHROPIC_API_KEY
      : null,
    authenticatedMethodIds: []
  };
  let authenticated = false;

  writeFakeCapture(capturePath, capture);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  function respond(request, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  }

  input.on('line', line => {
    if (!line.trim()) return;
    const request = JSON.parse(line);

    if (request.method === 'initialize') {
      respond(request, {
        protocolVersion: request.params.protocolVersion,
        agentCapabilities: {
          promptCapabilities: { image: false, audio: false, embeddedContext: false }
        },
        agentInfo: { name: 'claude-fence-fake-agent', version: 'test' },
        authMethods: requireAuth
          ? [...unsafeSubscriptionAuthMethods, safeApiKeyAuthMethod]
          : []
      });
      return;
    }

    if (request.method === 'authenticate') {
      capture.authenticatedMethodIds.push(request.params.methodId);
      authenticated = true;
      writeFakeCapture(capturePath, capture);
      respond(request, {});
      return;
    }

    if (request.method === 'session/new') {
      if (requireAuth && !authenticated) {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32000, message: 'Authentication required' }
        })}\n`);
        return;
      }
      respond(request, { sessionId: `fake-session-${process.pid}` });
      return;
    }

    process.stdout.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: 'Method not found' }
    })}\n`);
  });
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createFakeAgentCommand(testTempDir) {
  if (process.platform === 'win32') {
    const commandPath = path.join(testTempDir, 'fake-claude-agent.cmd');
    const nodePath = process.execPath.replace(/"/g, '""');
    const testPath = __filename.replace(/"/g, '""');
    fs.writeFileSync(commandPath, `@echo off\r\n"${nodePath}" "${testPath}" ${FAKE_AGENT_ARG}\r\n`, 'utf8');
    return commandPath;
  }

  const commandPath = path.join(testTempDir, 'fake-claude-agent');
  fs.writeFileSync(
    commandPath,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(__filename)} ${FAKE_AGENT_ARG}\n`,
    'utf8'
  );
  fs.chmodSync(commandPath, 0o700);
  return commandPath;
}

function snapshotEnvironment(names) {
  return names.map(name => ({
    name,
    present: Object.hasOwn(process.env, name),
    value: process.env[name]
  }));
}

function restoreEnvironment(snapshot) {
  for (const entry of snapshot) {
    if (entry.present) process.env[entry.name] = entry.value;
    else delete process.env[entry.name];
  }
}

function isSameOrDescendant(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertIsolatedConfigDir(capture, label) {
  assert.equal(
    typeof capture.claudeConfigDir,
    'string',
    fenceMessage(`${label} did not receive a CLAUDE_CONFIG_DIR.`)
  );
  const configDir = path.resolve(capture.claudeConfigDir);
  const tempRoot = path.resolve(os.tmpdir());
  const realClaudeConfigDir = path.resolve(os.homedir(), '.claude');

  assert.equal(
    path.dirname(configDir),
    tempRoot,
    fenceMessage(`${label} CLAUDE_CONFIG_DIR must be a direct child of os.tmpdir().`)
  );
  assert.equal(
    path.basename(configDir).startsWith(TEMP_CONFIG_PREFIX),
    true,
    fenceMessage(`${label} CLAUDE_CONFIG_DIR must use the ${TEMP_CONFIG_PREFIX} prefix.`)
  );
  assert.equal(
    isSameOrDescendant(configDir, realClaudeConfigDir),
    false,
    fenceMessage(`${label} must never see ~/.claude or anything beneath it.`)
  );
  assert.equal(
    fs.statSync(configDir).isDirectory(),
    true,
    fenceMessage(`${label} CLAUDE_CONFIG_DIR must be a freshly created directory.`)
  );

  return configDir;
}

function readCapture(capturePath) {
  return JSON.parse(fs.readFileSync(capturePath, 'utf8'));
}

async function runFenceTest() {
  const environmentNames = [
    'CLAUDE_ACP_COMMAND',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'CLAUDE_FENCE_CAPTURE_PATH',
    'CLAUDE_FENCE_REQUIRE_AUTH'
  ];
  const originalEnvironment = snapshotEnvironment(environmentNames);
  const testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-claude-fence-test-'));
  const sessions = [];
  const observedConfigDirs = new Set();
  let captureIndex = 0;

  async function openFakeSession({ requireAuth = false } = {}) {
    captureIndex += 1;
    const capturePath = path.join(testTempDir, `capture-${captureIndex}.json`);
    process.env.CLAUDE_FENCE_CAPTURE_PATH = capturePath;
    if (requireAuth) process.env.CLAUDE_FENCE_REQUIRE_AUTH = '1';
    else delete process.env.CLAUDE_FENCE_REQUIRE_AUTH;

    const session = await startClaudeSession({
      cwd: process.cwd(),
      apiKey: requireAuth ? CALLER_API_KEY_DECOY : null,
      startupTimeoutMs: 5_000
    });
    const entry = { session, capturePath, configDir: null };
    sessions.push(entry);
    return entry;
  }

  try {
    const declaredScrubNames = readClaudeSessionScrubNames();
    for (const credentialName of [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY'
    ]) {
      assert.equal(
        declaredScrubNames.includes(credentialName),
        true,
        fenceMessage(
          `CLAUDE_SESSION_SCRUB_NAMES must explicitly remove ${credentialName}; ` +
          'a downstream scrub must not mask drift in this Claude-session fence.'
        )
      );
    }

    process.env.CLAUDE_ACP_COMMAND = createFakeAgentCommand(testTempDir);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'decoy-oauth-token-DO-NOT-USE';
    process.env.ANTHROPIC_AUTH_TOKEN = 'decoy-anthropic-auth-token-DO-NOT-USE';
    process.env.ANTHROPIC_API_KEY = AMBIENT_API_KEY_DECOY;

    /* Self-check on the SUBJECT, before any assertion depends on it.
     *
     * Everything below asserts that a decoy did NOT reach the child. If the decoy
     * were not set in the first place, every one of those assertions would pass
     * against an environment that never held the credential -- which is exactly the
     * defect this self-check exists to prevent recurring. Assert the parent really
     * holds it, so "the child did not get it" is a measurement rather than a
     * tautology. Presence and identity, never the value. */
    assert.equal(
      Object.hasOwn(process.env, 'ANTHROPIC_API_KEY'),
      true,
      fenceMessage('The test must plant an ambient ANTHROPIC_API_KEY, or it proves nothing about the scrub.')
    );
    assert.equal(
      process.env.ANTHROPIC_API_KEY,
      AMBIENT_API_KEY_DECOY,
      fenceMessage('The ambient ANTHROPIC_API_KEY must be this suite\'s decoy before any session is opened.')
    );

    const first = await openFakeSession();
    const firstCapture = readCapture(first.capturePath);
    first.configDir = assertIsolatedConfigDir(firstCapture, 'First spawned Claude agent');
    observedConfigDirs.add(first.configDir);

    const second = await openFakeSession();
    const secondCapture = readCapture(second.capturePath);
    second.configDir = assertIsolatedConfigDir(secondCapture, 'Second spawned Claude agent');
    observedConfigDirs.add(second.configDir);

    assert.notEqual(
      second.configDir,
      first.configDir,
      fenceMessage('Successive Claude sessions must receive different freshly created config directories.')
    );

    for (const [label, capture] of [['First', firstCapture], ['Second', secondCapture]]) {
      assert.equal(
        capture.hasClaudeCodeOauthToken,
        false,
        fenceMessage(`${label} spawned Claude agent must not receive CLAUDE_CODE_OAUTH_TOKEN.`)
      );
      assert.equal(
        capture.hasAnthropicAuthToken,
        false,
        fenceMessage(`${label} spawned Claude agent must not receive ANTHROPIC_AUTH_TOKEN.`)
      );
      assert.equal(
        capture.hasAnthropicApiKey,
        false,
        fenceMessage(`${label} no-key session must not inherit the ambient ANTHROPIC_API_KEY.`)
      );
      assert.equal(
        capture.anthropicApiKeyValue,
        null,
        fenceMessage(`${label} no-key session must carry no ANTHROPIC_API_KEY value at all.`)
      );
    }

    const auth = await openFakeSession({ requireAuth: true });
    const authCapture = readCapture(auth.capturePath);
    auth.configDir = assertIsolatedConfigDir(authCapture, 'Auth-probing spawned Claude agent');
    observedConfigDirs.add(auth.configDir);

    /* POSITIVE CONTROL ON THE SAME FIELD THE NEGATIVES USE.
     *
     * `hasAnthropicApiKey === false` above is only evidence if that field is capable
     * of being true. A stated key is the one case where the child SHOULD receive
     * ANTHROPIC_API_KEY, so this asserts the same field, in the same capture shape,
     * reaching the opposite value -- which is what makes the three negatives
     * measurements instead of a field that is always false.
     *
     * It also pins the distinction createSessionEnvironment() exists to draw: the
     * child gets the key the CALLER stated and never the one lying in the ambient
     * environment. Both decoys are live in this process at this moment, so a
     * regression that re-set the key from ambient state lands on the wrong literal
     * and is named here rather than passing as "a key arrived". */
    assert.equal(
      authCapture.hasAnthropicApiKey,
      true,
      fenceMessage('A stated API key must reach the child, or the no-key assertions above are vacuous.')
    );
    assert.equal(
      authCapture.anthropicApiKeyValue,
      CALLER_API_KEY_DECOY,
      fenceMessage('The child must receive the API key the caller stated.')
    );
    assert.notEqual(
      authCapture.anthropicApiKeyValue,
      AMBIENT_API_KEY_DECOY,
      fenceMessage('The child received the AMBIENT ANTHROPIC_API_KEY rather than the stated one.')
    );

    for (const unsafeMethod of unsafeSubscriptionAuthMethods) {
      assert.equal(
        authCapture.authenticatedMethodIds.includes(unsafeMethod.id),
        false,
        fenceMessage(`Subscription-shaped auth method ${unsafeMethod.id} must be refused.`)
      );
    }
    assert.deepEqual(
      authCapture.authenticatedMethodIds,
      [safeApiKeyAuthMethod.id],
      fenceMessage('A separately supplied API-key-shaped method must be selected instead.')
    );

    for (const entry of sessions) entry.session.close();
    for (const entry of sessions) {
      assert.equal(
        fs.existsSync(entry.configDir),
        false,
        fenceMessage(`close() must remove temporary config directory ${path.basename(entry.configDir)}.`)
      );
    }

    console.log(
      'Claude subscription credential fence tests passed ' +
      '(fresh isolated CLAUDE_CONFIG_DIR, auth tokens stripped, subscription auth refused, temp cleanup verified).'
    );
  } finally {
    for (const entry of sessions) {
      try { entry.session.close(); } catch { /* Test teardown must continue. */ }
    }
    for (const configDir of observedConfigDirs) {
      try { fs.rmSync(configDir, { recursive: true, force: true }); } catch { /* Best-effort test cleanup. */ }
    }
    try { fs.rmSync(testTempDir, { recursive: true, force: true }); } catch { /* Best-effort test cleanup. */ }
    restoreEnvironment(originalEnvironment);
  }
}

if (process.argv.includes(FAKE_AGENT_ARG)) {
  runFakeAgent();
} else {
  runFenceTest().catch(error => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
