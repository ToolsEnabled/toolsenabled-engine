'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AUTH_PURPOSE,
  createWakeRequestHandler
} = require('../../src/lib/agent-wake/wake-request');

const TRUSTED_TRANSPORT = Object.freeze({ trustedTransport: true });

function authenticator() {
  return Object.freeze({
    verify({ purpose, canonicalMessage, authentication }) {
      assert.equal(purpose, AUTH_PURPOSE);
      assert.equal(typeof canonicalMessage, 'string');
      if (!authentication || authentication.trustedTransport !== true) {
        return Object.freeze({ authenticated: false, integrityChecked: false, principal: '' });
      }
      return Object.freeze({
        authenticated: true,
        integrityChecked: true,
        principal: 'machine-a-tunnel-peer'
      });
    }
  });
}

function wake(requestId, action = 'resume', overrides = {}) {
  const value = {
    requestId,
    agentId: 'manager-b',
    sessionId: 'session-b-1',
    action,
    issuedAtMs: 10_000,
    ...overrides
  };
  if (action === 'prompt' && value.prompt === undefined) value.prompt = 'Continue the bounded assigned phase.';
  return value;
}

function fixture(t, options = {}) {
  const directory = options.directory || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-request-'));
  if (!options.directory) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = options.now ?? 10_000;
  const calls = [];
  const executor = options.executor || (async instruction => { calls.push(instruction); });
  const handler = createWakeRequestHandler({
    stateFile: path.join(directory, 'wake.json'),
    authenticator: options.authenticator === undefined ? authenticator() : options.authenticator,
    isKnownAgent: options.isKnownAgent || ((agentId, sessionId) => agentId === 'manager-b' && sessionId === 'session-b-1'),
    executor,
    ttlMs: options.ttlMs ?? 1_000,
    maxClockSkewMs: options.maxClockSkewMs ?? 100,
    rateLimit: options.rateLimit || { maxRequests: 3, windowMs: 60_000 },
    maxInFlight: options.maxInFlight ?? 2,
    ...(options.inFlightTtlMs === undefined ? {} : { inFlightTtlMs: options.inFlightTtlMs }),
    now: () => clock
  });
  return {
    calls,
    directory,
    handler,
    setNow(value) { clock = value; }
  };
}

test('only the closed resume, respawn, and prompt actions reach the injected executor', async t => {
  const { handler, calls } = fixture(t);
  assert.equal((await handler.handle(wake('request-0001', 'resume'), TRUSTED_TRANSPORT)).executed, true);
  assert.equal((await handler.handle(wake('request-0002', 'respawn'), TRUSTED_TRANSPORT)).executed, true);
  assert.equal((await handler.handle(wake('request-0003', 'prompt'), TRUSTED_TRANSPORT)).executed, true);

  assert.deepEqual(calls.map(call => call.action), ['resume', 'respawn', 'prompt']);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['action', 'agentId', 'requestId', 'sessionId']);
  assert.deepEqual(Object.keys(calls[2]).sort(), ['action', 'agentId', 'prompt', 'requestId', 'sessionId']);
  assert.equal(Object.isFrozen(calls[0]), true);
  assert.equal(Object.isFrozen(calls[2]), true);

  const refused = await handler.handle(wake('request-0004', 'execute'), TRUSTED_TRANSPORT);
  assert.equal(refused.accepted, false);
  assert.equal(refused.code, 'WAKE_ACTION_REFUSED');
  assert.equal(calls.length, 3);
});

test('command, argv, path, and script fields are all refused', async t => {
  const { handler, calls } = fixture(t);
  const forbidden = [
    ['command', 'ignored'],
    ['argv', ['ignored']],
    ['path', 'ignored'],
    ['script', 'ignored']
  ];
  for (let index = 0; index < forbidden.length; index += 1) {
    const [field, value] = forbidden[index];
    const result = await handler.handle({
      ...wake(`forbid-000${index}`),
      [field]: value
    }, TRUSTED_TRANSPORT);
    assert.equal(result.accepted, false, field);
    assert.equal(result.executed, false, field);
    assert.equal(result.code, 'WAKE_FORBIDDEN_FIELD', field);
  }
  assert.equal(calls.length, 0);
});

test('an unknown agent and session are refused', async t => {
  const { handler, calls } = fixture(t);
  const result = await handler.handle(wake('request-unknown', 'resume', {
    agentId: 'unknown-agent',
    sessionId: 'unknown-session'
  }), TRUSTED_TRANSPORT);
  assert.equal(result.code, 'WAKE_AGENT_UNKNOWN');
  assert.equal(result.executed, false);
  assert.equal(calls.length, 0);
});

test('an agent lookup failure is not reported as a definite unknown-agent answer', async t => {
  for (const [requestId, isKnownAgent] of [
    ['lookup-threw', () => { throw new Error('roster unavailable'); }],
    ['lookup-async', async () => true]
  ]) {
    const { handler, calls } = fixture(t, { isKnownAgent });
    const result = await handler.handle(wake(requestId), TRUSTED_TRANSPORT);
    assert.equal(result.code, 'WAKE_AGENT_LOOKUP_FAILED');
    assert.equal(result.accepted, false);
    assert.equal(result.executed, false);
    assert.equal(calls.length, 0);
  }
});

test('expired requests are refused, while the exact TTL boundary is accepted', async t => {
  const { handler, calls } = fixture(t, { ttlMs: 500 });
  const expired = await handler.handle(wake('request-expired', 'resume', { issuedAtMs: 9_499 }), TRUSTED_TRANSPORT);
  const boundary = await handler.handle(wake('request-boundary', 'resume', { issuedAtMs: 9_500 }), TRUSTED_TRANSPORT);
  assert.equal(expired.code, 'WAKE_REQUEST_EXPIRED');
  assert.equal(expired.executed, false);
  assert.equal(boundary.code, 'WAKE_EXECUTED');
  assert.equal(calls.length, 1);
});

test('the durable seen-set makes replay a no-op across handler restart', async t => {
  const first = fixture(t);
  const message = wake('request-replay');
  assert.equal((await first.handler.handle(message, TRUSTED_TRANSPORT)).executed, true);
  assert.equal(first.calls.length, 1);

  const secondCalls = [];
  const reloaded = createWakeRequestHandler({
    stateFile: path.join(first.directory, 'wake.json'),
    authenticator: authenticator(),
    isKnownAgent: (agentId, sessionId) => agentId === 'manager-b' && sessionId === 'session-b-1',
    executor: async instruction => { secondCalls.push(instruction); },
    ttlMs: 1_000,
    maxClockSkewMs: 100,
    rateLimit: { maxRequests: 3, windowMs: 60_000 },
    maxInFlight: 2,
    now: () => 10_100
  });
  const replay = await reloaded.handle(message, TRUSTED_TRANSPORT);
  assert.equal(replay.replayed, true);
  assert.equal(replay.executed, false);
  assert.equal(replay.code, 'WAKE_REPLAY_NOOP');
  assert.equal(secondCalls.length, 0);
});

test('concurrent handlers sharing a state file cannot reserve the same request twice', async t => {
  let release;
  const blocker = new Promise(resolve => { release = resolve; });
  const firstCalls = [];
  const first = fixture(t, {
    executor: async instruction => {
      firstCalls.push(instruction.requestId);
      await blocker;
    }
  });
  const secondCalls = [];
  const second = createWakeRequestHandler({
    stateFile: path.join(first.directory, 'wake.json'),
    authenticator: authenticator(),
    isKnownAgent: (agentId, sessionId) => agentId === 'manager-b' && sessionId === 'session-b-1',
    executor: async instruction => { secondCalls.push(instruction.requestId); },
    ttlMs: 1_000,
    maxClockSkewMs: 100,
    rateLimit: { maxRequests: 3, windowMs: 60_000 },
    maxInFlight: 2,
    now: () => 10_000
  });

  const message = wake('request-cross-handler');
  const pending = first.handler.handle(message, TRUSTED_TRANSPORT);
  await Promise.resolve();
  const replay = await second.handle(message, TRUSTED_TRANSPORT);
  assert.equal(replay.code, 'WAKE_REPLAY_NOOP');
  assert.equal(replay.executed, false);
  assert.deepEqual(firstCalls, ['request-cross-handler']);
  assert.deepEqual(secondCalls, []);
  release();
  assert.equal((await pending).executed, true);
});

test('the per-agent rate limit is durable and enforced', async t => {
  const { handler, calls } = fixture(t, { rateLimit: { maxRequests: 2, windowMs: 60_000 } });
  assert.equal((await handler.handle(wake('request-rate-1'), TRUSTED_TRANSPORT)).executed, true);
  assert.equal((await handler.handle(wake('request-rate-2'), TRUSTED_TRANSPORT)).executed, true);
  const limited = await handler.handle(wake('request-rate-3'), TRUSTED_TRANSPORT);
  assert.equal(limited.code, 'WAKE_RATE_LIMITED');
  assert.equal(limited.executed, false);
  assert.equal(calls.length, 2);
});

test('the rate limit is per agent across that agent\'s known sessions', async t => {
  const { handler, calls } = fixture(t, {
    rateLimit: { maxRequests: 1, windowMs: 60_000 },
    isKnownAgent: (agentId, sessionId) => agentId === 'manager-b' && ['session-b-1', 'session-b-2'].includes(sessionId)
  });
  assert.equal((await handler.handle(wake('request-agent-rate-1'), TRUSTED_TRANSPORT)).executed, true);
  const secondSession = await handler.handle(wake('request-agent-rate-2', 'resume', {
    sessionId: 'session-b-2'
  }), TRUSTED_TRANSPORT);
  assert.equal(secondSession.code, 'WAKE_RATE_LIMITED');
  assert.equal(calls.length, 1);
});

test('the global maximum in-flight count prevents an unbounded executor flood', async t => {
  let release;
  const started = [];
  const blocker = new Promise(resolve => { release = resolve; });
  const { handler } = fixture(t, {
    maxInFlight: 1,
    executor: async instruction => {
      started.push(instruction.requestId);
      await blocker;
    }
  });

  const first = handler.handle(wake('request-flight-1'), TRUSTED_TRANSPORT);
  await Promise.resolve();
  const second = await handler.handle(wake('request-flight-2'), TRUSTED_TRANSPORT);
  assert.equal(second.code, 'WAKE_MAX_IN_FLIGHT');
  assert.deepEqual(started, ['request-flight-1']);
  release();
  assert.equal((await first).executed, true);
});

test('unauthenticated wake requests are refused and durably recorded', async t => {
  const { handler, calls, directory } = fixture(t);
  const result = await handler.handle(wake('request-no-auth'), Object.freeze({ trustedTransport: false }));
  assert.equal(result.code, 'WAKE_AUTHENTICATION_FAILED');
  assert.equal(result.executed, false);
  assert.equal(calls.length, 0);
  assert.equal(handler.getRejections().at(-1).code, 'WAKE_AUTHENTICATION_FAILED');

  const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'wake.json'), 'utf8'));
  assert.equal(persisted.rejectionCount, 1);
  assert.equal(JSON.stringify(persisted).includes('trustedTransport'), false);
});

test('missing authentication integration fails closed and is recorded', async t => {
  const { handler, calls } = fixture(t, { authenticator: null });
  const result = await handler.handle(wake('request-no-verifier'));
  assert.equal(result.code, 'WAKE_AUTHENTICATOR_UNAVAILABLE');
  assert.equal(calls.length, 0);
  assert.equal(handler.getRejections().at(-1).code, 'WAKE_AUTHENTICATOR_UNAVAILABLE');
});

test('authentication without an integrity attestation is refused and recorded', async t => {
  const integrityBlind = Object.freeze({
    verify() {
      return Object.freeze({ authenticated: true, integrityChecked: false, principal: 'machine-a-tunnel-peer' });
    }
  });
  const { handler, calls } = fixture(t, { authenticator: integrityBlind });
  const result = await handler.handle(wake('request-no-integrity'), TRUSTED_TRANSPORT);
  assert.equal(result.code, 'WAKE_AUTHENTICATION_FAILED');
  assert.equal(calls.length, 0);
  assert.equal(handler.getRejections().at(-1).code, 'WAKE_AUTHENTICATION_FAILED');
});

test('authentication rejection is distinguished from an authenticator that could not establish an answer', async t => {
  const rejected = fixture(t, {
    authenticator: Object.freeze({
      verify() {
        return Object.freeze({ authenticated: false, integrityChecked: true, principal: '' });
      }
    })
  });
  const unavailable = fixture(t, {
    authenticator: Object.freeze({
      verify() { throw new Error('identity provider read failed'); }
    })
  });

  const rejectedResult = await rejected.handler.handle(wake('auth-rejected'), TRUSTED_TRANSPORT);
  const unavailableResult = await unavailable.handler.handle(wake('auth-unavailable'), TRUSTED_TRANSPORT);

  assert.equal(rejectedResult.code, 'WAKE_AUTHENTICATION_FAILED');
  assert.equal(unavailableResult.code, 'WAKE_AUTHENTICATOR_FAILED');
  assert.notEqual(unavailableResult.code, rejectedResult.code);
  assert.equal(rejected.calls.length, 0);
  assert.equal(unavailable.calls.length, 0);
});

test('prompt accepts bounded text only and never supplies shell-shaped fields to the executor', async t => {
  const { handler, calls } = fixture(t);
  const result = await handler.handle(wake('request-prompt', 'prompt', {
    prompt: 'Resume the existing agent context and report status.'
  }), TRUSTED_TRANSPORT);
  assert.equal(result.executed, true);
  assert.equal(typeof calls[0].prompt, 'string');
  for (const field of ['command', 'argv', 'path', 'script', 'shell']) {
    assert.equal(Object.prototype.hasOwnProperty.call(calls[0], field), false);
  }

  const structured = await handler.handle(wake('request-prompt-bad', 'prompt', { prompt: { text: 'ignored' } }), TRUSTED_TRANSPORT);
  assert.equal(structured.accepted, false);
  assert.equal(calls.length, 1);
});

test('a dead reservation is reaped after inFlightTtlMs instead of wedging the wake path forever', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-reaper-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Handler A stands in for a process that crashed between reserve() and
  // finish(): its executor never settles, so its reservation is never drained.
  const hung = fixture(t, { directory, executor: () => new Promise(() => {}), maxInFlight: 1, ttlMs: 300_000, inFlightTtlMs: 60_000 });
  void hung.handler.handle(wake('request-hung-0001', 'resume', { issuedAtMs: 10_000 }), TRUSTED_TRANSPORT);
  await new Promise(resolve => setTimeout(resolve, 25));

  // Within the TTL the slot is honored: the durable state still counts it.
  const within = fixture(t, { directory, maxInFlight: 1, ttlMs: 300_000, inFlightTtlMs: 60_000 });
  const refused = await within.handler.handle(wake('request-after-0002', 'resume', { issuedAtMs: 10_000 }), TRUSTED_TRANSPORT);
  assert.equal(refused.code, 'WAKE_MAX_IN_FLIGHT');

  // Past the TTL the reaper frees the dead slot, records the honest verdict,
  // and the wake path works again. Replays of the reaped id stay noops.
  const later = fixture(t, { directory, maxInFlight: 1, ttlMs: 300_000, inFlightTtlMs: 60_000, now: 10_000 + 61_000 });
  const accepted = await later.handler.handle(wake('request-after-0003', 'resume', { issuedAtMs: 10_000 + 61_000 }), TRUSTED_TRANSPORT);
  assert.equal(accepted.executed, true);
  const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'wake.json'), 'utf8'));
  assert.equal(persisted.seenRequests.find(record => record.requestId === 'request-hung-0001').outcome, 'outcome_unknown');
  assert.equal(persisted.inFlight.includes('request-hung-0001'), false);
  const replay = await later.handler.handle(wake('request-hung-0001', 'resume', { issuedAtMs: 10_000 + 61_000 }), TRUSTED_TRANSPORT);
  assert.equal(replay.code, 'WAKE_REPLAY_NOOP');
});
