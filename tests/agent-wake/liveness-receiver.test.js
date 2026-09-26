'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AUTH_PURPOSE,
  STATES,
  createLivenessReceiver
} = require('../../src/lib/agent-wake/liveness-receiver');

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
        principal: 'machine-b-tunnel-peer'
      });
    }
  });
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-liveness-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = options.now ?? 10_000;
  const receiver = createLivenessReceiver({
    stateFile: path.join(directory, 'liveness.json'),
    knownAgents: options.knownAgents || [{ agentId: 'manager-b', sessionId: 'session-b-1' }],
    authenticator: options.authenticator === undefined ? authenticator() : options.authenticator,
    freshnessBudgetMs: options.freshnessBudgetMs ?? 1_000,
    now: () => clock
  });
  return {
    directory,
    receiver,
    setNow(value) { clock = value; }
  };
}

function validReport(overrides = {}) {
  return {
    agentId: 'manager-b',
    sessionId: 'session-b-1',
    event: 'Heartbeat',
    reportedAtMs: 9_900,
    ...overrides
  };
}

test('configuration refusals throw before creating state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-liveness-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'must-not-exist.json');

  assert.throws(() => createLivenessReceiver({ stateFile, freshnessBudgetMs: 0 }), error => {
    assert.equal(error.code, 'LIVENESS_CONFIGURATION_INVALID');
    return true;
  });
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(fs.existsSync(`${stateFile}.lock`), false);
});

test('corrupt persisted state is refused without replacing or locking it', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-liveness-corrupt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'liveness.json');
  const corrupt = '{ definitely not json }\n';
  fs.writeFileSync(stateFile, corrupt);

  assert.throws(() => createLivenessReceiver({ stateFile }), error => {
    assert.equal(error.code, 'LIVENESS_STATE_CORRUPT');
    return true;
  });
  assert.equal(fs.readFileSync(stateFile, 'utf8'), corrupt);
  assert.equal(fs.existsSync(`${stateFile}.lock`), false);
});

test('an existing state lock refuses initialization without changing state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-liveness-locked-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const stateFile = path.join(directory, 'liveness.json');
  const lockFile = `${stateFile}.lock`;
  fs.writeFileSync(lockFile, 'held elsewhere');

  assert.throws(() => createLivenessReceiver({ stateFile }), error => {
    assert.equal(error.code, 'LIVENESS_STATE_LOCKED');
    return true;
  });
  assert.equal(fs.existsSync(stateFile), false);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), 'held elsewhere');
});

test('an invalid injected clock refuses a report without mutating persisted state', t => {
  const setup = fixture(t);
  const before = fs.readFileSync(path.join(setup.directory, 'liveness.json'), 'utf8');
  setup.setNow(-1);

  assert.throws(() => setup.receiver.receive(validReport(), TRUSTED_TRANSPORT), error => {
    assert.equal(error.code, 'LIVENESS_CLOCK_INVALID');
    return true;
  });
  assert.equal(fs.readFileSync(path.join(setup.directory, 'liveness.json'), 'utf8'), before);
});

test('a promise-returning authenticator is refused and only the rejection ledger changes', t => {
  const { receiver } = fixture(t, { authenticator: { verify: () => Promise.resolve(true) } });
  const beforeAgent = receiver.getAgent('manager-b', 'session-b-1', 10_000);

  const result = receiver.receive(validReport(), TRUSTED_TRANSPORT);
  assert.deepEqual(result, { accepted: false, applied: false, code: 'LIVENESS_AUTHENTICATOR_INVALID' });
  assert.deepEqual(receiver.getAgent('manager-b', 'session-b-1', 10_000), beforeAgent);
  assert.deepEqual(receiver.getRejections(), [{ receivedAtMs: 10_000, code: 'LIVENESS_AUTHENTICATOR_INVALID' }]);
});

test('a future report is refused and cannot update the known agent', t => {
  const { receiver } = fixture(t);
  const beforeAgent = receiver.getAgent('manager-b', 'session-b-1', 10_000);

  const result = receiver.receive(validReport({ reportedAtMs: 10_001 }), TRUSTED_TRANSPORT);
  assert.deepEqual(result, { accepted: false, applied: false, code: 'LIVENESS_REPORT_IN_FUTURE' });
  assert.deepEqual(receiver.getAgent('manager-b', 'session-b-1', 10_000), beforeAgent);
  assert.deepEqual(receiver.getRejections(), [{ receivedAtMs: 10_000, code: 'LIVENESS_REPORT_IN_FUTURE' }]);
});

test('a timestamp conflict is refused without overwriting the applied event', t => {
  const { receiver } = fixture(t);
  const applied = receiver.receive(validReport(), TRUSTED_TRANSPORT);
  assert.deepEqual(applied, { accepted: true, applied: true, replayed: false, code: 'LIVENESS_APPLIED' });
  const beforeAgent = receiver.getAgent('manager-b', 'session-b-1', 10_000);

  const conflict = receiver.receive(validReport({ event: 'Stop' }), TRUSTED_TRANSPORT);
  assert.deepEqual(conflict, {
    accepted: false,
    applied: false,
    replayed: true,
    code: 'LIVENESS_TIMESTAMP_CONFLICT'
  });
  assert.deepEqual(receiver.getAgent('manager-b', 'session-b-1', 10_000), beforeAgent);
  assert.deepEqual(receiver.getRejections(), [{ receivedAtMs: 10_000, code: 'LIVENESS_TIMESTAMP_CONFLICT' }]);
});

test('a known agent never heard from is UNKNOWN, not implicitly healthy', t => {
  const { receiver } = fixture(t);
  assert.deepEqual(receiver.getAgent('manager-b', 'session-b-1'), {
    agentId: 'manager-b',
    sessionId: 'session-b-1',
    state: STATES.UNKNOWN,
    status: STATES.UNKNOWN,
    freshness: 'NEVER',
    ageMs: null,
    lastSeenAtMs: null,
    lastReceivedAtMs: null,
    lastEvent: null
  });
});

test('a persisted mutation is not reported as successful when lock release could not be established', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-wake-liveness-unlock-'));
  const stateFile = path.join(directory, 'liveness.json');
  const originalUnlinkSync = fs.unlinkSync;
  const unlinkSync = t.mock.method(fs, 'unlinkSync', file => {
    if (file === `${stateFile}.lock`) {
      const error = new Error('simulated lock removal failure');
      error.code = 'EACCES';
      throw error;
    }
    return originalUnlinkSync(file);
  });

  assert.throws(() => createLivenessReceiver({
    stateFile,
    knownAgents: [{ agentId: 'manager-b', sessionId: 'session-b-1' }],
    authenticator: authenticator()
  }), error => {
    assert.equal(error.code, 'LIVENESS_STATE_UNAVAILABLE');
    assert.match(error.message, /could not be established/);
    assert.equal(error.cause.code, 'EACCES');
    return true;
  });

  // The state write happened, but the API refuses to claim complete success
  // because it cannot establish that the mutation lock was released.
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(persisted.agents.length, 1);
  assert.equal(fs.existsSync(`${stateFile}.lock`), true);

  unlinkSync.mock.restore();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('lifecycle events derive RUNNING, IDLE, and STOPPED states', t => {
  const { receiver, setNow } = fixture(t);
  const base = { agentId: 'manager-b', sessionId: 'session-b-1' };

  assert.equal(receiver.receive({ ...base, event: 'SessionStart', reportedAtMs: 9_000 }, TRUSTED_TRANSPORT).applied, true);
  assert.equal(receiver.getAgent(base.agentId, base.sessionId).state, STATES.RUNNING);

  setNow(10_100);
  receiver.receive({ ...base, event: 'TeamMateIdle', reportedAtMs: 10_100 }, TRUSTED_TRANSPORT);
  assert.equal(receiver.getAgent(base.agentId, base.sessionId).state, STATES.IDLE);

  setNow(10_200);
  receiver.receive({ ...base, event: 'SessionEnd', reportedAtMs: 10_200 }, TRUSTED_TRANSPORT);
  assert.equal(receiver.getAgent(base.agentId, base.sessionId).state, STATES.STOPPED);
});

test('stale reports expose STALE status and the exact age', t => {
  const { receiver } = fixture(t, { now: 5_000, freshnessBudgetMs: 500 });
  receiver.receive({
    agentId: 'manager-b',
    sessionId: 'session-b-1',
    event: 'Heartbeat',
    reportedAtMs: 4_000
  }, TRUSTED_TRANSPORT);

  const view = receiver.getAgent('manager-b', 'session-b-1', 5_250);
  assert.equal(view.state, STATES.RUNNING);
  assert.equal(view.status, 'STALE');
  assert.equal(view.freshness, 'STALE');
  assert.equal(view.ageMs, 1_250);
});

test('unauthenticated and unparseable reports are refused and durably recorded', t => {
  const { receiver, directory } = fixture(t);
  const report = {
    agentId: 'manager-b',
    sessionId: 'session-b-1',
    event: 'Heartbeat',
    reportedAtMs: 9_900
  };

  const unauthenticated = receiver.receive(report, Object.freeze({ trustedTransport: false }));
  const unparseable = receiver.receive({ ...report, event: 'not-a-lifecycle-event' }, TRUSTED_TRANSPORT);
  assert.equal(unauthenticated.accepted, false);
  assert.equal(unauthenticated.code, 'LIVENESS_AUTHENTICATION_FAILED');
  assert.equal(unparseable.accepted, false);
  assert.equal(unparseable.code, 'LIVENESS_REPORT_INVALID');
  assert.deepEqual(receiver.getRejections().map(item => item.code), [
    'LIVENESS_AUTHENTICATION_FAILED',
    'LIVENESS_REPORT_INVALID'
  ]);

  const persisted = JSON.parse(fs.readFileSync(path.join(directory, 'liveness.json'), 'utf8'));
  assert.equal(persisted.rejectionCount, 2);
  assert.equal(persisted.rejections.length, 2);
  assert.equal(JSON.stringify(persisted).includes('trustedTransport'), false);
});

test('missing authenticator fails closed and records the refusal', t => {
  const { receiver } = fixture(t, { authenticator: null });
  const result = receiver.receive({
    agentId: 'manager-b',
    sessionId: 'session-b-1',
    event: 'Heartbeat',
    reportedAtMs: 9_900
  });
  assert.equal(result.code, 'LIVENESS_AUTHENTICATOR_UNAVAILABLE');
  assert.equal(receiver.getRejections().at(-1).code, 'LIVENESS_AUTHENTICATOR_UNAVAILABLE');
});

test('authentication without an integrity attestation is refused and recorded', t => {
  const integrityBlind = Object.freeze({
    verify() {
      return Object.freeze({ authenticated: true, integrityChecked: false, principal: 'machine-b-tunnel-peer' });
    }
  });
  const { receiver } = fixture(t, { authenticator: integrityBlind });
  const result = receiver.receive({
    agentId: 'manager-b',
    sessionId: 'session-b-1',
    event: 'Heartbeat',
    reportedAtMs: 9_900
  }, TRUSTED_TRANSPORT);
  assert.equal(result.code, 'LIVENESS_AUTHENTICATION_FAILED');
  assert.equal(receiver.getRejections().at(-1).code, 'LIVENESS_AUTHENTICATION_FAILED');
});

test('an unknown agent report is refused even when authenticated', t => {
  const { receiver } = fixture(t);
  const result = receiver.receive({
    agentId: 'unknown-agent',
    sessionId: 'unknown-session',
    event: 'Heartbeat',
    reportedAtMs: 9_900
  }, TRUSTED_TRANSPORT);
  assert.equal(result.code, 'LIVENESS_AGENT_UNKNOWN');
  assert.equal(receiver.isKnownAgent('unknown-agent', 'unknown-session'), false);
});

test('replayed and out-of-order reports cannot move state backwards, including after reload', t => {
  const { receiver, directory } = fixture(t, { now: 20_000 });
  const identity = { agentId: 'manager-b', sessionId: 'session-b-1' };
  receiver.receive({ ...identity, event: 'TeamMateIdle', reportedAtMs: 19_000 }, TRUSTED_TRANSPORT);
  assert.equal(receiver.receive({ ...identity, event: 'TeamMateIdle', reportedAtMs: 19_000 }, TRUSTED_TRANSPORT).code, 'LIVENESS_REPLAY_NOOP');
  assert.equal(receiver.receive({ ...identity, event: 'Stop', reportedAtMs: 18_000 }, TRUSTED_TRANSPORT).code, 'LIVENESS_OUT_OF_ORDER_NOOP');
  assert.equal(receiver.getAgent(identity.agentId, identity.sessionId).state, STATES.IDLE);

  const reloaded = createLivenessReceiver({
    stateFile: path.join(directory, 'liveness.json'),
    knownAgents: [identity],
    authenticator: authenticator(),
    freshnessBudgetMs: 1_000,
    now: () => 20_100
  });
  assert.equal(reloaded.getAgent(identity.agentId, identity.sessionId).state, STATES.IDLE);
  assert.equal(reloaded.receive({ ...identity, event: 'Stop', reportedAtMs: 18_500 }, TRUSTED_TRANSPORT).applied, false);
  assert.equal(reloaded.getAgent(identity.agentId, identity.sessionId).state, STATES.IDLE);
});
