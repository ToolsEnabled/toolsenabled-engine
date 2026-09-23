// EXECUTABLE CHANGE
// Assertion-discrimination audit (2026-08-26).
//
// Strengthened: the FAILOVER_STATES agreement table now carries independent,
// literal expectations instead of relying only on an expectation computed by
// FAILOVER_STATES, which is exported by the subject under test.
// Mutation: changed the RATE_LIMITED result's `canFailover` from true to false
// only for the independently tabled `quota exceeded` provider response.
// RED: `AssertionError [ERR_ASSERTION]: rate_limited must report the independently expected canFailover value` followed by `false !== true`.
// Restored source byte-for-byte; GREEN: `Claude auth probe tests passed.`
//
// Checked assertion shapes: empty loops/forEach NOT-FOUND (all three loops are
// guarded by exact cardinality/shape assertions or iterate a non-empty literal);
// exit-status/truthy-only evidence NOT-FOUND; swallowed failures via try/catch
// or optional chaining NOT-FOUND; mock-of-subject assertions NOT-FOUND (the
// spawn fake is an injected boundary, while probeClaudeAuth remains real);
// skip/platform no-op guards NOT-FOUND; same-code expected values FIXED below.
// Preconditions not met: none.
'use strict';
// Claude auth state must be measured, not read off a file, and it must fail
// closed.
//
// The fixtures below are transcripts of the installed Claude Code CLI on this
// machine, captured 2026-08-10, with one exception that is labelled where it
// appears. Using real captures matters: the signed-out `--print` envelope
// carries `"subtype":"success"` next to `"is_error":true`, and no invented
// fixture would have contained that trap.
//
// No assertion here compares a secret's value. The one place a credential is
// involved -- `apiKeySource` -- names a VARIABLE, and the tests assert on that
// name and on the derived billing route, never on a key.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  FAILOVER_STATES,
  STATE,
  classifyClaudeAuth,
  probeClaudeAuth
} = require('../src/lib/providers/claude-auth-probe.js');

// -- real captures ----------------------------------------------------------

// `claude auth status --json`, signed in, environment scrubbed. exit 0.
const STATUS_SIGNED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'acctc@ucr.edu',
  orgName: "acctc@ucr.edu's Organization",
  subscriptionType: 'max'
});

// The same command with the machine-wide ANTHROPIC_API_KEY present. Every
// field a naive health check reads is green; only apiKeySource reveals that
// the session is billing per token instead of using the Max subscription.
const STATUS_SIGNED_IN_API_KEY = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  apiKeySource: 'ANTHROPIC_API_KEY',
  email: 'acctc@ucr.edu',
  subscriptionType: 'max'
});

// Signed out, measured against an isolated empty CLAUDE_CONFIG_DIR. exit 1.
const STATUS_SIGNED_OUT = JSON.stringify({
  loggedIn: false,
  authMethod: 'none',
  apiProvider: 'firstParty'
});

// A served `--print` request. exit 0.
const CAPABILITY_OK = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, api_error_status: null,
  result: 'ok', stop_reason: 'end_turn'
});

// A refused `--print` request from a signed-out home. exit 1. Note subtype.
const CAPABILITY_SIGNED_OUT = JSON.stringify({
  type: 'result', subtype: 'success', is_error: true, api_error_status: null,
  result: 'Not logged in · Please run /login', stop_reason: 'stop_sequence'
});

// NOT A LIVE CAPTURE. A real 429 cannot be produced on demand without
// deliberately exhausting the owner's allowance, which would be an absurd
// thing to do to prove a test. This is built from the documented API error
// surface, and it is labelled rather than passed off as measured.
const CAPABILITY_RATE_LIMITED = JSON.stringify({
  type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
  result: 'Claude AI usage limit reached. Your limit will reset at 3pm.'
});

// -- the four states --------------------------------------------------------
{
  const authenticated = classifyClaudeAuth({
    statusExit: 0, statusStdout: STATUS_SIGNED_IN,
    capabilityRan: true, capabilityExit: 0, capabilityStdout: CAPABILITY_OK
  });
  assert.equal(authenticated.state, STATE.AUTHENTICATED, 'a served request on a signed-in account is authenticated');
  assert.equal(authenticated.usable, true);
  assert.equal(authenticated.canFailover, false, 'a working account must never be failed away from');
  assert.equal(authenticated.billingSource, 'subscription');
  assert.equal(authenticated.account, 'acctc@ucr.edu');
  assert.equal(authenticated.plan, 'max');

  const signedOut = classifyClaudeAuth({ statusExit: 1, statusStdout: STATUS_SIGNED_OUT });
  assert.equal(signedOut.state, STATE.SIGNED_OUT);
  assert.equal(signedOut.usable, false);
  assert.equal(signedOut.canFailover, true, 'a signed-out account is an account-level fault and may be failed over');

  const expired = classifyClaudeAuth({
    statusExit: 0, statusStdout: STATUS_SIGNED_IN,
    capabilityRan: true, capabilityExit: 1, capabilityStdout: CAPABILITY_SIGNED_OUT
  });
  assert.equal(expired.state, STATE.EXPIRED,
    'a stored session that the provider rejects on a live request is expired -- and this is the ONLY way expired may be reached, never by reading a token file');
  assert.equal(expired.usable, false);
  assert.equal(expired.canFailover, true);

  const rateLimited = classifyClaudeAuth({
    statusExit: 0, statusStdout: STATUS_SIGNED_IN,
    capabilityRan: true, capabilityExit: 1, capabilityStdout: CAPABILITY_RATE_LIMITED
  });
  assert.equal(rateLimited.state, STATE.RATE_LIMITED);
  assert.equal(rateLimited.usable, false);
  assert.equal(rateLimited.canFailover, true, 'rate limiting is account-level and time-bounded, so rotating is reasonable');
}

// -- the trap: subtype says success on a hard failure -----------------------
{
  const result = classifyClaudeAuth({
    statusExit: 0, statusStdout: STATUS_SIGNED_IN,
    capabilityRan: true, capabilityExit: 1, capabilityStdout: CAPABILITY_SIGNED_OUT
  });
  assert.notEqual(result.state, STATE.AUTHENTICATED,
    'the measured signed-out envelope carries "subtype":"success"; classifying on subtype instead of is_error would turn a hard auth failure into a green');
  assert.equal(result.usable, false);
}

// -- fail closed ------------------------------------------------------------
{
  // The account surface itself is unreachable. This says nothing about the
  // account, so it must be unusable AND must not trigger a failover.
  const transport = classifyClaudeAuth({ statusTransportError: 'timed out after 30000ms' });
  assert.equal(transport.state, STATE.INDETERMINATE);
  assert.equal(transport.usable, false, 'unknown auth state must be treated as not usable');
  assert.equal(transport.canFailover, false,
    'a transport fault must never rotate accounts: that abandons a healthy account and spends a second one for nothing');

  const garbage = classifyClaudeAuth({ statusExit: 0, statusStdout: 'not json at all' });
  assert.equal(garbage.state, STATE.INDETERMINATE);
  assert.equal(garbage.usable, false);

  // Synthetic malformed responses: a readable JSON object does not establish
  // that a linked account signed out. Unknown status must not rotate it away.
  const unconfirmed = [{}, { error: 'temporarily unavailable' }, { loggedIn: null },
    { loggedIn: 'false' }, { loggedIn: 0 }, { loggedIn: [] }];
  assert.equal(unconfirmed.length, 6);
  for (const envelope of unconfirmed) {
    const result = classifyClaudeAuth({ statusExit: 1, statusStdout: JSON.stringify(envelope) });
    assert.equal(result.state, STATE.INDETERMINATE, 'an unconfirmed sign-in status is not a sign-out');
    assert.equal(result.usable, false, 'an unknown account must not gain access');
    assert.equal(result.canFailover, false, 'unknown status must not move work to a different account');
  }

  // Signed in per the free surface, but nothing proved it can serve a
  // request. This is the exact false green the old exit-0 check produced.
  const unproven = classifyClaudeAuth({ statusExit: 0, statusStdout: STATUS_SIGNED_IN, capabilityRan: false });
  assert.strictEqual(unproven.capabilityRan, false, 'the no-request path must say no live request was made');
  assert.equal(unproven.state, STATE.INDETERMINATE,
    'a signed-in file/status reading alone must NOT be reported as authenticated -- that is the defect this module replaces');
  assert.equal(unproven.usable, false);
  assert.equal(unproven.canFailover, false);

  // A live request that failed for an unattributable reason.
  const unattributed = classifyClaudeAuth({
    statusExit: 0, statusStdout: STATUS_SIGNED_IN,
    capabilityRan: true, capabilityExit: 1,
    capabilityStdout: JSON.stringify({ type: 'result', is_error: true, result: 'something else went wrong' })
  });
  assert.equal(unattributed.state, STATE.INDETERMINATE);
  assert.equal(unattributed.canFailover, false, 'an unexplained failure is not grounds to switch accounts');

  const capabilityTransport = classifyClaudeAuth({
    statusExit: 0, statusStdout: STATUS_SIGNED_IN,
    capabilityRan: true, capabilityTransportError: 'ENOENT'
  });
  assert.equal(capabilityTransport.state, STATE.INDETERMINATE);
  assert.equal(capabilityTransport.canFailover, false);
}

// -- the failover contract the multi-account lane depends on ----------------
{
  assert.ok(!FAILOVER_STATES.has(STATE.INDETERMINATE),
    'indeterminate must never be in the failover set');
  assert.ok(!FAILOVER_STATES.has(STATE.AUTHENTICATED),
    'a working account must never be in the failover set');
  for (const state of [STATE.EXPIRED, STATE.SIGNED_OUT, STATE.RATE_LIMITED]) {
    assert.ok(FAILOVER_STATES.has(state), `${state} is an account-level fault and must be failover-eligible`);
  }
  // canFailover and FAILOVER_STATES must not disagree; a caller may use either.
  const cases = [
    { expectedCanFailover: true, in: { statusExit: 1, statusStdout: STATUS_SIGNED_OUT } },
    { expectedCanFailover: false, in: { statusExit: 0, statusStdout: STATUS_SIGNED_IN, capabilityRan: true, capabilityExit: 0, capabilityStdout: CAPABILITY_OK } },
    { expectedCanFailover: false, in: { statusTransportError: 'boom' } },
    { expectedCanFailover: true, in: { statusExit: 0, statusStdout: STATUS_SIGNED_IN, capabilityRan: true, capabilityExit: 1, capabilityStdout: CAPABILITY_RATE_LIMITED } },
    {
      expectedCanFailover: true,
      in: {
        statusExit: 0, statusStdout: STATUS_SIGNED_IN,
        capabilityRan: true, capabilityExit: 1,
        capabilityStdout: JSON.stringify({ type: 'result', is_error: true, result: 'quota exceeded' })
      }
    }
  ];
  for (const item of cases) {
    const result = classifyClaudeAuth(item.in);
    assert.equal(result.canFailover, item.expectedCanFailover,
      `${result.state} must report the independently expected canFailover value`);
    assert.equal(result.canFailover, FAILOVER_STATES.has(result.state),
      `canFailover must agree with FAILOVER_STATES for state ${result.state}`);
  }
}

// -- the billing tell -------------------------------------------------------
{
  const onApiKey = classifyClaudeAuth({
    statusExit: 0, statusStdout: STATUS_SIGNED_IN_API_KEY,
    capabilityRan: true, capabilityExit: 0, capabilityStdout: CAPABILITY_OK
  });
  assert.equal(onApiKey.state, STATE.AUTHENTICATED, 'it does work -- that is what makes it dangerous');
  assert.equal(onApiKey.billingSource, 'api_key',
    'apiKeySource in the status envelope means the CLI authenticated from an API key variable and is billing per token, even though loggedIn/authMethod/subscriptionType all read green');
  assert.match(onApiKey.reason, /bills per token/i, 'the reason must say plainly that this costs money');

  const onSubscription = classifyClaudeAuth({
    statusExit: 0, statusStdout: STATUS_SIGNED_IN,
    capabilityRan: true, capabilityExit: 0, capabilityStdout: CAPABILITY_OK
  });
  assert.equal(onSubscription.billingSource, 'subscription');
}

// -- nothing sensitive ever leaves ------------------------------------------
{
  const SENTINEL = 'sk-ant-TEST-SENTINEL-NOT-A-REAL-KEY';
  const noisy = classifyClaudeAuth({
    statusExit: 0,
    statusStdout: JSON.stringify({
      loggedIn: true, authMethod: 'claude.ai', apiKeySource: 'ANTHROPIC_API_KEY',
      email: 'acctc@ucr.edu', subscriptionType: 'max', accessToken: SENTINEL
    }),
    capabilityRan: true, capabilityExit: 1,
    capabilityStdout: JSON.stringify({ type: 'result', is_error: true, result: `Invalid API key ${SENTINEL}` }),
    capabilityStderr: SENTINEL
  });
  const serialized = JSON.stringify(noisy);
  assert.ok(!serialized.includes(SENTINEL),
    'the probe result must never carry a credential value, even when the provider echoes one back at it');
  // Assert on SHAPE, not on any value: no credential-ish field may exist.
  for (const key of Object.keys(noisy)) {
    assert.doesNotMatch(key, /token|secret|key$|password|cookie/i,
      `the probe result must not expose a field named ${key}`);
  }
  assert.deepEqual(Object.keys(noisy).sort(),
    ['account', 'authMethod', 'billingSource', 'canFailover', 'capabilityRan', 'plan', 'reason', 'state', 'usable'],
    'the probe result shape is a contract the multi-account lane consumes; changing it is a breaking change');
}

// -- the probe runner spends nothing when the account is already signed out --
(async () => {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push(args.join(' '));
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const receipt = { type: 'exit', activeProcesses: 0, exitCode: 1 };
    child.jobOutcome = Promise.resolve(receipt);
    child.terminateJob = async () => receipt;
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(STATUS_SIGNED_OUT));
      child.emit('close', 1, null);
    });
    return child;
  };
  const result = await probeClaudeAuth({
    capability: true,
    spawnImpl,
    executable: { command: 'claude', prefixArgs: [] },
    baseEnvironment: { PATH: 'p' },
    cwd: process.cwd()
  });
  assert.equal(result.state, STATE.SIGNED_OUT);
  assert.equal(calls.length, 1,
    'a signed-out account is already conclusive; the probe must not spend allowance on a request that cannot succeed');
  assert.match(calls[0], /auth status/, 'the free account surface must be tried first');

  // And it must never reach for --bare, whose own help says auth becomes
  // strictly ANTHROPIC_API_KEY -- probing that way would bill the API and
  // measure the wrong thing entirely.
  for (const call of calls) {
    assert.doesNotMatch(call, /--bare/, 'the probe must never use --bare: it forces API-key auth and would bill the owner');
  }

  // A failed scratch setup must not fall back to the caller's cwd and turn a
  // probe that was never isolated into a definite answer about the account.
  let spawnedAfterScratchFailure = false;
  const noScratch = await probeClaudeAuth({
    spawnImpl: () => { spawnedAfterScratchFailure = true; },
    executable: { command: 'claude', prefixArgs: [] },
    baseEnvironment: { PATH: 'p' },
    fsImpl: { mkdtempSync: () => { throw new Error('scratch unavailable'); } }
  });
  assert.equal(noScratch.state, STATE.INDETERMINATE,
    'a scratch creation failure is not a definite answer about the account');
  assert.equal(noScratch.usable, false);
  assert.equal(noScratch.canFailover, false);
  assert.equal(spawnedAfterScratchFailure, false,
    'the account probe must refuse to run when its isolation could not be established');

  console.log('Claude auth probe tests passed.');
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
