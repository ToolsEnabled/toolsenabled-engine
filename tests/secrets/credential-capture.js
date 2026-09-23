// EXECUTABLE CHANGE
// Report: testcanfail-tests-secrets-credential-capture-js
//
// Strengthened assertion: each credential-capture request must launch exactly
// one prompt-set action. Mutation: runtime.captureCredential was temporarily
// changed to invoke execFileSync a second time after the real invocation. Before
// this assertion the mutant stayed green: "Credential capture tests passed."
// With this assertion it went red:
// "AssertionError [ERR_ASSERTION]: one credential capture must launch exactly one prompt-set action"
// "2 !== 1"
// The mutation was restored byte-for-byte (matching SHA-256
// 3cc8084a1c19e85fccb39ca969168b41f263d9132b9b2f2827328aa8ab99a0c1),
// and the restored test was green: "Credential capture tests passed."
//
// NOT-FOUND (1): loops over possibly empty collections. Both loops enumerate
// non-empty literals; no product-derived collection controls assertion entry.
// NOT-FOUND (2): exit-status or truthy-return assertions used in place of the
// subject's own output. This in-process harness asserts typed results/errors.
// NOT-FOUND (3): try/catch or optional chaining that swallows the target failure.
// NOT-FOUND (4): assertions against a mock of the subject itself. The recorder
// replaces the process boundary, not runtime.captureCredential, and its exact
// invocation count is now independently pinned.
// NOT-FOUND (5): skip/precondition guard that makes the file a no-op. The
// platform branch models the supported platform and all assertions still run.
// NOT-FOUND (6): expected values computed by the same code being checked.
// Preconditions not met: none.
'use strict';

require('../lib/isolated-environment').activate('credential-capture');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const {
  DIAGNOSTIC_CREDENTIAL_KEYS, credentialDefinitionForKey, resolveCredentialRequest
} = require('../../src/lib/credential-metadata');

const runtimePath = require.resolve('../../src/lib/runtime');
const queuePath = require.resolve('../../src/lib/providers/owner-prompt-queue');
const vaultPlatformPath = require.resolve('../../src/lib/vault-platform');
const originalExecFileSync = childProcess.execFileSync;
const originalQueueModule = require.cache[queuePath];
const originalVaultPlatform = require(vaultPlatformPath);

// This unit harness replaces the PowerShell process with a recorder, so on a
// non-Windows census it must also model the supported platform whose dialog
// path it is testing. The real non-Windows refusal remains live and separately
// pinned by tests/vault-platform-unsupported.test.js.
if (process.platform !== originalVaultPlatform.SUPPORTED_VAULT_PLATFORM) {
  require.cache[vaultPlatformPath].exports = Object.freeze({
    ...originalVaultPlatform,
    assertVaultPlatform() {}
  });
}

function missingKey(key) {
  const error = new Error('missing key');
  error.stderr = Buffer.from(`key not found: ${key}`, 'utf8');
  return error;
}

function loadRuntime(fake, queueImpl) {
  childProcess.execFileSync = fake;
  require.cache[queuePath] = {
    id: queuePath, filename: queuePath, loaded: true, exports: queueImpl
  };
  delete require.cache[runtimePath];
  return require('../../src/lib/runtime');
}

try {
  const calls = [];
  const queued = [];
  let queueFailure = null;
  let promptResult = { key: 'github_pat', status: 'created' };
  const runtime = loadRuntime((executable, args, options) => {
    calls.push({ executable, args, options });
    if (args.includes('get')) {
      const key = args.at(-1);
      throw missingKey(key);
    }
    if (args.includes('present')) {
      // secretExists() now answers through tools/secrets.ps1's `present` verb
      // (via src/lib/vault-presence.js), not `get`. The real verb signals ABSENT
      // by exiting 3, which execFileSync surfaces as a throw carrying that exit
      // status; simulate a missing record so a presence check answers a definite
      // false without reading a value, hitting the denylist, or opening a prompt.
      const key = args.at(-1);
      const error = new Error(`present: no record for ${key}`);
      error.status = 3;
      throw error;
    }
    if (args.includes('prompt-set') || args.includes('prompt-payment-card')) {
      assert.equal(executable, 'powershell.exe');
      assert.ok(args.includes('-STA'), 'credential capture must use an STA Windows Forms host');
      if (args.includes('prompt-set')) {
        assert.ok(args.includes('github_pat'));
        assert.ok(args.includes('GitHub personal access token'));
      } else {
        assert.ok(args.includes('payment_card_default'));
        assert.ok(args.includes('default payment card'));
      }
      assert.equal(options.input, undefined, 'the dialog value must not be supplied on stdin');
      assert.ok(!args.some(item => String(item).includes('stored-github-token')), 'credential values must not enter argv');
      return JSON.stringify(promptResult);
    }
    throw new Error(`Unexpected vault action: ${args.join(' ')}`);
  }, {
    enqueue(input) {
      if (queueFailure) throw queueFailure;
      queued.push(input);
      return { requestId: 'owner-prompt-00000000-0000-4000-8000-000000000001' };
    }
  });

  const requestMetadata = {
    requester: 'codex',
    requestContext: {
      purpose: 'Run github.repo_get',
      scope: 'github access for this operation only',
      lifetime: 'Until provider expiry, replacement, or revocation'
    }
  };
  assert.throws(
    () => runtime.withCredentialPrompt(() => runtime.getSecret('github_pat'), requestMetadata),
    error => error.code === 'OWNER_PROMPT_QUEUED' && error.requestId === 'owner-prompt-00000000-0000-4000-8000-000000000001'
  );
  assert.deepEqual(queued, [{
    kind: 'credential', vaultKey: 'github_pat', label: 'GitHub personal access token',
    requestContext: requestMetadata.requestContext, requester: 'codex'
  }]);
  assert.equal(calls.filter(call => call.args.includes('prompt-set')).length, 0, 'a worker must queue rather than launch a surprise desktop form');

  assert.throws(
    () => runtime.withCredentialPrompt(() => runtime.getSecret('vercel_token')),
    error => error.code === 'CREDENTIAL_PROMPT_CONTEXT_REQUIRED'
  );
  assert.equal(queued.length, 1, 'an unattributed runtime read must not create an owner prompt');

  // Unattended agent transports can explicitly defer owner-only credential
  // entry. The handler still executes, but no Windows prompt is launched.
  process.env.TOOLSENABLED_DEFER_CREDENTIAL_PROMPTS = '1';
  assert.throws(
    () => runtime.withCredentialPrompt(() => runtime.getSecret('vercel_token')),
    error => error.code === 'SECRET_NOT_CONFIGURED'
  );
  assert.equal(calls.filter(call => call.args.includes('prompt-set')).length, 0);
  assert.equal(queued.length, 1, 'deferred transports must not enqueue an owner form');
  delete process.env.TOOLSENABLED_DEFER_CREDENTIAL_PROMPTS;

  // Presence checks are used by doctor/account selection and must not make a
  // dialog appear even when a handler has credential prompting enabled.
  const promptsBeforePresenceCheck = calls.filter(call => call.args.includes('prompt-set')).length;
  assert.equal(runtime.withCredentialPrompt(() => runtime.secretExists('vercel_token')), false);
  assert.equal(calls.filter(call => call.args.includes('prompt-set')).length, promptsBeforePresenceCheck);

  // Outside a handler, a normal missing read retains the existing quiet error
  // rather than surprising a caller with a desktop prompt.
  assert.throws(
    () => runtime.getSecret('vercel_token'),
    error => error.code === 'SECRET_NOT_CONFIGURED' && error.message === "Secret 'vercel_token' is not configured."
  );
  assert.equal(calls.filter(call => call.args.includes('prompt-set')).length, promptsBeforePresenceCheck);

  // A queue refusal must reach the caller with its own reason. One unanswered
  // A TYPED QUEUE FAILURE MUST REACH THE CALLER WITH ITS REASON INTACT, because
  // src/mcp-server.js toolError() forwards only the code, the message and the
  // taxonomy -- everything carried as a field alone is dropped. If runtime.js
  // collapses one of these into a generic failure, the caller is told merely
  // "could not be queued" and cannot act.
  //
  // This used to pin OWNER_PROMPT_DIFFERENT_ACTIVE, the single-slot refusal that
  // was raised when a prompt for one key was already active. That rule is gone
  // (2026-08-21): a different key now simply queues alongside, because the slot
  // was what let ONE unanswered prompt disable every credential path on the
  // machine for ~17 hours. The property being pinned is unchanged; the code that
  // exercises it is now OWNER_PROMPT_QUEUE_FULL, which the capacity cap really
  // does raise -- and which, unlike the retired one, is reachable in production.
  const queueFullMessage = 'Too many owner prompts are already waiting.';
  const queueFull = new Error(queueFullMessage);
  queueFull.code = 'OWNER_PROMPT_QUEUE_FULL';
  queueFailure = queueFull;
  assert.throws(
    () => runtime.withCredentialPrompt(() => runtime.getSecret('ig_access_token'), requestMetadata),
    error => error.code === 'OWNER_PROMPT_QUEUE_FULL' && error.message === queueFullMessage,
    'a typed queue failure must reach the caller with its own reason, not a generic one'
  );
  const queueSource = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'src', 'lib', 'providers', 'owner-prompt-queue.js'), 'utf8');
  assert.ok(queueSource.includes(queueFullMessage),
    'the sentence pinned here must still be the one the queue actually builds');
  // The retired refusal must not quietly come back: its sentence is gone from
  // the source, and a test that still expected it would be pinning a rule the
  // product no longer has.
  assert.ok(!queueSource.includes('A different owner prompt is already queued or being presented'),
    'the single-slot refusal is retired and must not reappear');

  // An unexpected internal failure still must not leak its detail. Only the
  // queue's own typed vocabulary is re-surfaced; anything else stays generic.
  const internalFailure = new Error("Cannot find module 'C:\\Users\\example\\secret-path\\owner-prompt-queue'");
  internalFailure.code = 'MODULE_NOT_FOUND';
  queueFailure = internalFailure;
  assert.throws(
    () => runtime.withCredentialPrompt(() => runtime.getSecret('ig_access_token'), requestMetadata),
    error => error.code === 'OWNER_PROMPT_QUEUE_FAILED'
      && error.message === 'The owner credential request could not be queued.'
      && !/secret-path/.test(error.message),
    'an unrecognised queue failure must stay generic and must not carry internal detail'
  );

  // A queue error whose prose is not plain bounded text is not re-surfaced
  // either, even when its code is one the queue owns.
  const unsafeProse = new Error('Blocked by C:\\Users\\example\\Desktop\\state\\owner-prompt-queue.json');
  unsafeProse.code = 'OWNER_PROMPT_QUEUE_UNAVAILABLE';
  queueFailure = unsafeProse;
  assert.throws(
    () => runtime.withCredentialPrompt(() => runtime.getSecret('ig_access_token'), requestMetadata),
    error => error.code === 'OWNER_PROMPT_QUEUE_FAILED' && !/example/.test(error.message),
    'a queue message that is not plain bounded prose must not be surfaced to the caller'
  );
  queueFailure = null;

  const promptSetCallsBeforeCapture = calls.filter(call => call.args.includes('prompt-set')).length;
  promptResult = { key: 'github_pat', status: 'updated' };
  assert.deepEqual(runtime.captureCredential('github_pat'), { key: 'github_pat', status: 'updated' });
  assert.equal(
    calls.filter(call => call.args.includes('prompt-set')).length,
    promptSetCallsBeforeCapture + 1,
    'one credential capture must launch exactly one prompt-set action'
  );

  promptResult = { key: 'payment_card_default', status: 'created' };
  const paymentCapture = runtime.capturePaymentCard();
  assert.deepEqual(paymentCapture, { key: 'payment_card_default', status: 'created' });
  const paymentCall = calls.find(call => call.args.includes('prompt-payment-card'));
  assert.ok(paymentCall, 'payment-card capture must use the dedicated local prompt action');
  assert.ok(paymentCall.args.includes('-STA'), 'payment-card capture must use an STA Windows Forms host');
  assert.ok(paymentCall.args.includes('default payment card'));
  assert.equal(paymentCall.options.input, undefined, 'payment-card data must not be supplied on stdin');
  assert.ok(!paymentCall.args.some(item => /(?:4242|cvc|postal)/i.test(String(item))), 'payment-card details must not enter argv');
  assert.throws(
    () => runtime.capturePaymentCard('payment_card_other'),
    error => error.code === 'PAYMENT_METHOD_CAPTURE_UNSUPPORTED'
  );

  promptResult = { status: 'cancelled' };
  assert.throws(
    () => runtime.captureCredential('github_pat'),
    error => error.code === 'CREDENTIAL_CAPTURE_CANCELLED' && /vault was not changed/i.test(error.message)
  );
  promptResult = { key: 'github_pat', status: 'in_progress' };
  assert.throws(
    () => runtime.captureCredential('github_pat'),
    error => error.code === 'CREDENTIAL_CAPTURE_IN_PROGRESS' && /already open/i.test(error.message)
  );
  assert.throws(
    () => runtime.captureCredential('audit_head'),
    error => error.code === 'CREDENTIAL_CAPTURE_UNSUPPORTED'
  );

  assert.deepEqual(credentialDefinitionForKey('google_refresh_token__acct-primary'), {
    key: 'google_refresh_token__acct-primary', label: 'Google OAuth refresh token'
  });
  assert.deepEqual(resolveCredentialRequest({
    credential: 'google_refresh_token', account: 'acct-primary'
  }), {
    key: 'google_refresh_token__acct-primary', label: 'Google OAuth refresh token'
  });
  assert.deepEqual(resolveCredentialRequest({ credential: 'custom', customName: 'my_api_token' }), {
    key: 'custom.my_api_token', label: 'My API Token'
  });
  for (const credential of ['ig_access_token', 'ig_user_id']) {
    assert.throws(
      () => resolveCredentialRequest({ credential }),
      error => error.code === 'CREDENTIAL_PROVIDER_PROBE_REQUIRED'
        && /instagram\.verify missing-secret operation/i.test(error.message)
    );
  }
  assert.deepEqual(credentialDefinitionForKey('tavily_api_key'), {
    key: 'tavily_api_key', label: 'Tavily API key'
  });
  // Removed transports cannot be reconfigured through the live credential
  // prompt. Existing vault values remain owner-removable by exact key through
  // system.credential_remove, which does not depend on this capture catalogue.
  assert.equal(credentialDefinitionForKey('telegram_bot_token'), null);
  assert.equal(credentialDefinitionForKey('telegram_owner_chat_id'), null);
  // Discord left the product (2026-08-22). Its two vault keys stay catalogued
  // so a stored value is still listed and removable, but they are relabelled
  // to say so and no longer count as diagnostic inputs.
  assert.deepEqual(credentialDefinitionForKey('discord_owner_channel_id'), {
    key: 'discord_owner_channel_id', label: 'Discord owner channel ID — no longer used; remove it'
  });
  assert.deepEqual(credentialDefinitionForKey('discord_bot_token'), {
    key: 'discord_bot_token', label: 'Discord bot token — no longer used; remove it'
  });
  assert.equal(DIAGNOSTIC_CREDENTIAL_KEYS.includes('discord_bot_token'), false);
  assert.equal(DIAGNOSTIC_CREDENTIAL_KEYS.includes('discord_owner_channel_id'), false);
  assert.deepEqual(credentialDefinitionForKey('paddle_sandbox_webhook_secret'), {
    key: 'paddle_sandbox_webhook_secret', label: 'Paddle sandbox webhook signing secret'
  });
  assert.deepEqual(credentialDefinitionForKey('gcp_service_account_key'), {
    key: 'gcp_service_account_key', label: 'Google Cloud service-account JSON'
  });
  assert.throws(() => resolveCredentialRequest({ credential: 'github_pat', account: 'acct-primary' }), /Google OAuth/);

  console.log('Credential capture tests passed.');
} finally {
  childProcess.execFileSync = originalExecFileSync;
  require.cache[vaultPlatformPath].exports = originalVaultPlatform;
  delete require.cache[runtimePath];
  if (originalQueueModule) require.cache[queuePath] = originalQueueModule;
  else delete require.cache[queuePath];
}
