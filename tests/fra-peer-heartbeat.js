'use strict';

// Behavioural coverage for tools/fra-peer-heartbeat.js: the always-on FRA
// outbound liveness heartbeat CLI. Everything here injects createProxy /
// loadProfile / loadToken (the same dependency-injection pattern
// tests/fra-token-enrollment-lifecycle.js uses for probePeer) rather than
// opening a real socket -- the real secure-session/transport-binding
// machinery already has its own coverage in tests/full-remote-access-mcp-proxy.js
// and tests/fra-secure-session.js.
//
// RELIABILITY LAYER (2026-08-04): every stub proxy below now also carries an
// `ensureConnected` method (the real RemoteAgentMcpProxy's own public method,
// which heartbeat() now calls explicitly as its 'connect' stage before the
// first request()) in addition to request/confirmFraPeerLiveness/_dropSocket.
// The retry-specific tests further down use a call-counting createProxy so
// "genuinely fresh proxy" and "exactly once" can be asserted directly rather
// than assumed.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const {
  loadWithPairedServiceRegistry,
  registry: pairedRegistry
} = require('./helpers/paired-service-registry');
const heartbeatModule = loadWithPairedServiceRegistry(
  () => require('../tools/fra-peer-heartbeat'));
const { FRA_HANDSHAKE_DEADLINE_MS } = require('../src/full-remote-access-bridge');

const SOURCE_PATH = path.join(__dirname, '..', 'tools', 'fra-peer-heartbeat.js');

function expectCode(fn, code) {
  assert.throws(fn, error => error?.code === code);
}

// A stub whose confirmFraPeerLiveness() must never be reached: every path
// that fails at or before the read-only tools/call must not advance
// liveness. Throwing (rather than silently recording a flag) turns "called
// when it shouldn't have been" into an immediate, loud test failure instead
// of a result the assertions below might not otherwise catch.
function mustNotConfirmLiveness() {
  throw new Error('confirmFraPeerLiveness must not be called on this path');
}

function assertElapsedMs(value) {
  assert.equal(Number.isInteger(value), true, 'elapsedMs must be a plain integer');
  assert.ok(value >= 0, 'elapsedMs must be non-negative');
}

async function main() {
  const freshInstallLoad = spawnSync(process.execPath, ['-e', "require('./tools/fra-peer-heartbeat.js'); process.stdout.write('loaded')"], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true
  });
  assert.equal(freshInstallLoad.status, 0,
    `the shipped one-machine pre-enrollment registry must not make module load fail: ${freshInstallLoad.stderr}`);
  assert.equal(freshInstallLoad.stdout, 'loaded');

  // HOST_A/HOST_B are the registry's machine-a/machine-b addresses, and this
  // pins the MAPPING rather than any particular pair of addresses: a swap, or a
  // module that resolved a third machine, still fails here, while an install
  // whose two machines sit on different addresses than another install's does
  // not. Pinning literals here would have pinned one deployment's LAN as the
  // only correct answer.
  const registeredMachines = pairedRegistry.machines;
  assert.equal(heartbeatModule.HOST_B, registeredMachines['machine-b'].address);
  assert.equal(heartbeatModule.HOST_A, registeredMachines['machine-a'].address);
  assert.notEqual(heartbeatModule.HOST_A, heartbeatModule.HOST_B);
  assert.equal(heartbeatModule.FRA_PORT, 8790);
  assert.equal(heartbeatModule.READ_ONLY_TOOL, 'system.kill_switch_status');
  assert.equal(heartbeatModule.peerForHost(heartbeatModule.HOST_B), heartbeatModule.HOST_A);
  assert.equal(heartbeatModule.peerForHost(heartbeatModule.HOST_A), heartbeatModule.HOST_B);
  expectCode(() => heartbeatModule.peerForHost('127.0.0.1'), 'FRA_HEARTBEAT_HOST_INVALID');
  // The expected checkout root was once a literal path, and it named a tree
  // that had already been retired. That pinned a stale value as correct and
  // would have masked the real bug -- the module hardcoded the same wrong path,
  // so both sides agreed and the test passed. Deriving the expectation from the
  // same authority the module now reads means this test can no longer agree
  // with a wrong answer just because both sides copied it.
  assert.equal(heartbeatModule.expectedRootForHost(heartbeatModule.HOST_B),
    registeredMachines['machine-b'].root);
  assert.equal(heartbeatModule.expectedRootForHost(heartbeatModule.HOST_A),
    registeredMachines['machine-a'].root);

  // --- parseCli -----------------------------------------------------------
  assert.deepEqual(heartbeatModule.parseCli(['--host', heartbeatModule.HOST_B]),
    { host: heartbeatModule.HOST_B, timeoutMs: heartbeatModule.DEFAULT_TIMEOUT_MS });
  assert.deepEqual(heartbeatModule.parseCli(['--host', heartbeatModule.HOST_A, '--timeout-ms', '5000']),
    { host: heartbeatModule.HOST_A, timeoutMs: 5000 });
  expectCode(() => heartbeatModule.parseCli([]), 'FRA_HEARTBEAT_ARGUMENT_INVALID');
  expectCode(() => heartbeatModule.parseCli(['--host', '127.0.0.1']), 'FRA_HEARTBEAT_ARGUMENT_INVALID');
  expectCode(() => heartbeatModule.parseCli(['--host', heartbeatModule.HOST_B, '--unknown']), 'FRA_HEARTBEAT_ARGUMENT_INVALID');
  expectCode(() => heartbeatModule.parseCli(['--host', heartbeatModule.HOST_B, '--timeout-ms', '0']), 'FRA_HEARTBEAT_ARGUMENT_INVALID');
  expectCode(() => heartbeatModule.parseCli(['--host', heartbeatModule.HOST_B, '--timeout-ms', '99999999']), 'FRA_HEARTBEAT_ARGUMENT_INVALID');

  // --- isCleanResponse(): the strict shared success check ------------------
  // Directly exercises every branch: no JSON-RPC error AND (no result, or a
  // result that is not isError:true) is the only shape that counts as clean.
  {
    const clean = heartbeatModule.isCleanResponse;
    assert.equal(clean(null), false);
    assert.equal(clean(undefined), false);
    assert.equal(clean('not-an-object'), false);
    assert.equal(clean([]), false);
    assert.equal(clean({ error: { code: -32000 } }), false, 'a JSON-RPC error must never read as clean');
    assert.equal(clean({ error: null }), false, 'an explicit error key, even null, must not read as clean');
    assert.equal(clean({ result: { isError: true } }), false, 'an MCP isError:true result must never read as clean');
    assert.equal(clean({ result: { isError: false } }), true);
    assert.equal(clean({ result: { content: [] } }), true, 'a result with no isError field at all is clean');
    assert.equal(clean({}), true, 'no result and no error is still structurally clean (callers check result shape separately)');
  }

  // --- the recalibrated timeout constants, and the four-layer ordering
  // (change 2) -- EXACT numbers, asserted as actual numeric relationships,
  // not just individually. FRA_HANDSHAKE_DEADLINE_MS (server) and
  // DEFAULT_TIMEOUT_MS/TOTAL_TIMEOUT_MS (client) are all covered here; the
  // fourth layer (the lifecycle PS wrapper's outer kill, 450000) is covered
  // in tests/fra-lifecycle-guards.js, which also asserts its relationship to
  // this file's own TOTAL_TIMEOUT_MS. ------------------------------------
  {
    assert.equal(FRA_HANDSHAKE_DEADLINE_MS, 120_000, 'server FRA_HANDSHAKE_DEADLINE_MS must stay unchanged at 120s');
    assert.equal(heartbeatModule.DEFAULT_TIMEOUT_MS, 135_000, 'client per-frame DEFAULT_TIMEOUT_MS must stay unchanged at 135s');
    assert.equal(heartbeatModule.TOTAL_TIMEOUT_MS, 420_000, 'client whole-probe TOTAL_TIMEOUT_MS must be raised to 420s');
    assert.ok(FRA_HANDSHAKE_DEADLINE_MS < heartbeatModule.DEFAULT_TIMEOUT_MS,
      'the server handshake deadline must fire before the client per-frame timeout');
    assert.ok(heartbeatModule.DEFAULT_TIMEOUT_MS < heartbeatModule.TOTAL_TIMEOUT_MS,
      'a single frame timeout must stay well inside the whole-probe budget');
    // 149.6s worst observed transient close + 211s worst observed successful
    // retry = 360.6s; 420s leaves ~59s of real margin over that.
    assert.ok(heartbeatModule.TOTAL_TIMEOUT_MS - 360_600 >= 55_000,
      'TOTAL_TIMEOUT_MS must retain real margin over the worst-case two-attempt sum observed in production');
  }

  // --- the retry allowlist (change 3): exactly the six verified transient
  // transport codes, no more, no fewer -- and confirmation that neither an
  // application-level heartbeat code nor the whole-probe timeout code is a
  // member. -----------------------------------------------------------------
  {
    const expectedRetryable = [
      'REMOTE_BRIDGE_CONNECTION_CLOSED',
      'REMOTE_BRIDGE_CONNECT_TIMEOUT',
      'REMOTE_BRIDGE_CONNECT_FAILED',
      'REMOTE_BRIDGE_REFUSED',
      'REMOTE_BRIDGE_RESET',
      'REMOTE_BRIDGE_SOCKET_ERROR'
    ];
    assert.deepEqual([...heartbeatModule.RETRYABLE_TRANSPORT_CODES].sort(), expectedRetryable.slice().sort());
    for (const nonRetryable of [
      'FRA_HEARTBEAT_TIMEOUT',
      'FRA_HEARTBEAT_INITIALIZE_FAILED',
      'FRA_HEARTBEAT_TOOLS_LIST_FAILED',
      'FRA_HEARTBEAT_READ_ONLY_CALL_FAILED',
      'REMOTE_BRIDGE_TOKEN_INVALID',
      'REMOTE_BRIDGE_PEER_MISMATCH',
      'REMOTE_BRIDGE_CAPABILITY_MISMATCH'
    ]) {
      assert.equal(heartbeatModule.RETRYABLE_TRANSPORT_CODES.has(nonRetryable), false,
        `${nonRetryable} must never be retry-eligible`);
    }
  }

  // --- STAGES: the fixed allowlist enum, in real step order -----------------
  assert.deepEqual(heartbeatModule.STAGES, ['connect', 'initialize', 'tools_list', 'read_only_call', 'liveness_write']);

  // --- Correction 6: the retry-rationale comment must no longer claim these
  // six codes are "never an authenticated-but-rejected session" -- this
  // file's own header comment proves REMOTE_BRIDGE_CONNECTION_CLOSED can
  // mask exactly that (the measured 149.6s AUDIT_UNAVAILABLE production
  // failure). Pinned here, source-text-level, so nobody can quietly put the
  // false claim back without deleting a test that says why. -----------------
  {
    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    // The false claim may still appear QUOTED, as historical context inside
    // the honest correction itself ("An earlier version of this comment
    // claimed X ... that claim was false") -- what must never reappear is
    // the claim asserted as fact, unqualified. Checking for the specific
    // "CORRECTED" marker and the "was false" acknowledgement right next to
    // the quoted claim distinguishes a citation from a live assertion.
    assert.match(source, /CORRECTED 2026-08-04/,
      'the retry-rationale comment must carry a visible correction marker, not a silent rewrite');
    assert.match(source, /That claim was false/,
      'the comment must explicitly say the old claim was false, not just quote it');
    assert.match(source, /FUNDAMENTALLY UNKNOWABLE to this client/,
      'the honest replacement -- the real cause of a generic transport close is unknowable to this client -- must be present');
    assert.match(source, /affirmatively identify as an explicit authenticated rejection/,
      'the honest replacement must explain what IS excluded and why');
  }

  // --- Correction 1: elapsedMs must be computed from a MONOTONIC clock
  // (performance.now()), never Date.now() -- a simulated backward wall-clock
  // jump between the start and end of a probe must not change the reported
  // elapsedMs at all. Both clocks are stubbed with a deterministic,
  // call-count-based sequence so the two runs are exactly comparable rather
  // than racing real wall-clock time. -----------------------------------
  {
    function makeCleanProxy() {
      return {
        closed: false,
        async ensureConnected() {},
        async request(message) {
          if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
          if (message.method === 'tools/list') return { result: { tools: [{ name: 'system.kill_switch_status' }] } };
          return { result: { content: [], isError: false } };
        },
        confirmFraPeerLiveness() { return true; },
        _dropSocket() {}
      };
    }
    // A deterministic monotonic stub: every call advances by a fixed step,
    // independent of real wall-clock time. Reset identically before each of
    // the two runs below so both exercise the EXACT same call-count-derived
    // sequence -- if elapsedMs depends only on performance.now(), the two
    // runs must produce an identical result no matter what Date.now() does.
    function makeMonotonicStub(startMs = 1_000_000, stepMs = 10) {
      let next = startMs;
      return () => { const value = next; next += stepMs; return value; };
    }
    const originalPerformanceNow = performance.now;
    const originalDateNow = Date.now;
    let cleanResult;
    let jumpedResult;
    try {
      performance.now = makeMonotonicStub();
      cleanResult = await heartbeatModule.heartbeat({
        host: heartbeatModule.HOST_B,
        loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
        loadToken: () => 'x',
        createProxy: makeCleanProxy
      });

      performance.now = makeMonotonicStub();
      let dateNowCalls = 0;
      Date.now = () => {
        dateNowCalls += 1;
        // Simulate a wall clock that jumps backward by an hour partway
        // through the probe -- exactly the kind of NTP correction or manual
        // clock change that must never be allowed to change elapsedMs. (Not
        // DST: a daylight-saving transition only changes how a timestamp is
        // FORMATTED in local time, never the underlying epoch milliseconds
        // Date.now() returns -- see the correction in tools/fra-peer-heartbeat.js.)
        return dateNowCalls <= 1 ? originalDateNow() : originalDateNow() - 3_600_000;
      };
      jumpedResult = await heartbeatModule.heartbeat({
        host: heartbeatModule.HOST_B,
        loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
        loadToken: () => 'x',
        createProxy: makeCleanProxy
      });
    } finally {
      performance.now = originalPerformanceNow;
      Date.now = originalDateNow;
    }
    assert.equal(cleanResult.ok, true);
    assert.equal(jumpedResult.ok, true);
    assertElapsedMs(cleanResult.elapsedMs);
    assert.equal(jumpedResult.elapsedMs, cleanResult.elapsedMs,
      'a simulated backward Date.now() jump between the start and end of the probe must not change the ' +
      'computed elapsedMs -- proves elapsedMs is derived only from performance.now(), never Date.now()');
  }

  // --- heartbeat(): the happy path proves the exact round trip the owner
  // asked for -- connect, then initialize, then tools/list, then one
  // tools/call against the read-only tool -- that it is wired through
  // createFullRemoteAccessProxy exactly like every other FRA client, that
  // liveness is confirmed exactly once, only after all three calls have
  // cleanly succeeded, and that the new stage/attempt/elapsedMs telemetry is
  // present and correctly valued on this success path. ---------------------
  {
    const calls = [];
    let proxyOptions = null;
    const secretToken = 'must-not-leak-into-any-result-0123456789';
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: peer => {
        assert.equal(peer, heartbeatModule.HOST_A);
        return { allowedTools: ['system.kill_switch_status', 'workspace.list'] };
      },
      loadToken: () => secretToken,
      createProxy(options) {
        proxyOptions = options;
        return {
          closed: false,
          async ensureConnected() { calls.push('ensureConnected'); },
          async request(message) {
            calls.push(message.method);
            if (message.method === 'initialize') {
              return { result: { serverInfo: { name: 'toolsenabled' } } };
            }
            if (message.method === 'tools/list') {
              return { result: { tools: [{ name: 'system.kill_switch_status' }, { name: 'workspace.list' }] } };
            }
            assert.equal(message.method, 'tools/call');
            assert.equal(message.params.name, 'system.kill_switch_status');
            assert.deepEqual(message.params.arguments, {});
            return { result: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false } };
          },
          confirmFraPeerLiveness() { calls.push('confirmFraPeerLiveness'); return true; },
          _dropSocket() {}
        };
      }
    });
    assert.deepEqual(calls, ['ensureConnected', 'initialize', 'tools/list', 'tools/call', 'confirmFraPeerLiveness']);
    assert.equal(result.ok, true);
    assert.equal(result.host, heartbeatModule.HOST_B);
    assert.equal(result.peer, heartbeatModule.HOST_A);
    assert.equal(result.toolCount, 2);
    assert.equal(result.readOnlyToolVerified, 'system.kill_switch_status');
    assert.equal(result.stage, 'liveness_write', 'a fully successful probe ends at the liveness_write stage');
    assert.equal(result.attempt, 1, 'a clean first attempt must report attempt:1');
    assertElapsedMs(result.elapsedMs);
    assert.equal(result.secretValuesEmitted, false);
    assert.equal(JSON.stringify(result).includes(secretToken), false);
    assert.equal(proxyOptions.secureProfile, true);
    assert.equal(proxyOptions.host, heartbeatModule.HOST_A);
    assert.equal(proxyOptions.port, heartbeatModule.FRA_PORT);
    assert.equal(proxyOptions.localHost, heartbeatModule.HOST_B);
    assert.equal(proxyOptions.expectedRoot, heartbeatModule.expectedRootForHost(heartbeatModule.HOST_A));
    assert.equal(proxyOptions.tokenLoader(), secretToken);
  }

  // --- host validation --------------------------------------------------
  // Matches probePeer's convention (tools/fra-token-enrollment-lifecycle.js):
  // host/profile/token resolution happens before the connection attempt and
  // throws directly rather than returning a structured ok:false -- only
  // failures from the connection onward are caught and projected. The CLI
  // entrypoint's own top-level .catch still turns this into valid JSON on
  // stdout with exit 1, so nothing reaches the caller unstructured.
  await assert.rejects(
    () => heartbeatModule.heartbeat({
      host: '127.0.0.1',
      loadProfile: () => ({ allowedTools: [] }),
      loadToken: () => 'x',
      createProxy: () => { throw new Error('must not connect for an invalid host'); }
    }),
    error => error?.code === 'FRA_HEARTBEAT_HOST_INVALID'
  );

  // --- an underlying CONNECT-stage transport failure surfaces its real
  // code, not a mask -- and is the "connect" stage coverage required by the
  // test plan. A non-retryable transport/identity code (REMOTE_BRIDGE_PEER_
  // MISMATCH -- a real security decision, deliberately excluded from
  // RETRYABLE_TRANSPORT_CODES) keeps this test's single-attempt intent
  // separate from the dedicated retry tests below. -----------------------
  {
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => ({
        closed: false,
        async ensureConnected() { throw Object.assign(new Error('mismatch'), { code: 'REMOTE_BRIDGE_PEER_MISMATCH' }); },
        async request() { throw new Error('request must not be reached if connect itself failed'); },
        confirmFraPeerLiveness: mustNotConfirmLiveness,
        _dropSocket() {}
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'REMOTE_BRIDGE_PEER_MISMATCH');
    assert.equal(result.stage, 'connect');
    assert.equal(result.attempt, 1);
    assertElapsedMs(result.elapsedMs);
  }

  // --- an initialize response carrying a JSON-RPC error must not read as
  // success, and must not advance liveness -----------------------------------
  {
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => ({
        closed: false,
        async ensureConnected() {},
        async request(message) {
          if (message.method === 'initialize') return { error: { code: -32000, message: 'boom' } };
          return { result: {} };
        },
        confirmFraPeerLiveness: mustNotConfirmLiveness,
        _dropSocket() {}
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_INITIALIZE_FAILED');
    assert.equal(result.stage, 'initialize');
    assert.equal(result.attempt, 1);
  }

  // --- an initialize response must name the real server -----------------------
  {
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => ({
        closed: false,
        async ensureConnected() {},
        async request(message) {
          if (message.method === 'initialize') return { result: { serverInfo: { name: 'someone-else' } } };
          return { result: {} };
        },
        confirmFraPeerLiveness: mustNotConfirmLiveness,
        _dropSocket() {}
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_INITIALIZE_INVALID');
  }

  // --- a tools/list response carrying a JSON-RPC error must not read as
  // success, and must not advance liveness -----------------------------------
  {
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => ({
        closed: false,
        async ensureConnected() {},
        async request(message) {
          if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
          if (message.method === 'tools/list') return { error: { code: -32000, message: 'boom' } };
          return { result: {} };
        },
        confirmFraPeerLiveness: mustNotConfirmLiveness,
        _dropSocket() {}
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_TOOLS_LIST_FAILED');
    assert.equal(result.stage, 'tools_list');
  }

  // --- the read-only tool must actually be present in this session's list --
  {
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['workspace.list'] }),
      loadToken: () => 'x',
      createProxy: () => ({
        closed: false,
        async ensureConnected() {},
        async request(message) {
          if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
          if (message.method === 'tools/list') return { result: { tools: [{ name: 'workspace.list' }] } };
          return { result: {} };
        },
        confirmFraPeerLiveness: mustNotConfirmLiveness,
        _dropSocket() {}
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_READ_ONLY_TOOL_UNAVAILABLE');
  }

  // --- a tools/call JSON-RPC error response must not read as success, and
  // must not advance liveness -- this is also the "read_only_call" stage
  // coverage required by the test plan. ---------------------------------------
  {
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => ({
        closed: false,
        async ensureConnected() {},
        async request(message) {
          if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
          if (message.method === 'tools/list') return { result: { tools: [{ name: 'system.kill_switch_status' }] } };
          return { error: { code: -32000, message: 'nope' } };
        },
        confirmFraPeerLiveness: mustNotConfirmLiveness,
        _dropSocket() {}
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_READ_ONLY_CALL_FAILED');
    assert.equal(result.stage, 'read_only_call');
    assert.equal(result.attempt, 1);
    assertElapsedMs(result.elapsedMs);
  }

  // --- a tools/call MCP isError:true result must not read as success either,
  // and must not advance liveness -- this is the exact shape a served-but-
  // application-level-failed call takes, distinct from a JSON-RPC error ------
  {
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => ({
        closed: false,
        async ensureConnected() {},
        async request(message) {
          if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
          if (message.method === 'tools/list') return { result: { tools: [{ name: 'system.kill_switch_status' }] } };
          return { result: { isError: true, content: [{ type: 'text', text: 'boom' }] } };
        },
        confirmFraPeerLiveness: mustNotConfirmLiveness,
        _dropSocket() {}
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_READ_ONLY_CALL_FAILED');
  }

  // --- an unsafe/unexpected error code is not echoed verbatim, and (being
  // outside the six-code allowlist) is never retried --------------------------
  {
    let createProxyCalls = 0;
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => {
        createProxyCalls += 1;
        return {
          closed: false,
          async ensureConnected() {},
          async request() { throw Object.assign(new Error('down'), { code: 'lowercase not safe' }); },
          confirmFraPeerLiveness: mustNotConfirmLiveness,
          _dropSocket() {}
        };
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_FAILED');
    assert.equal(createProxyCalls, 1, 'an unsafe/unrecognized code must not trigger a retry');
  }

  // --- the proxy is always torn down, success or failure ---------------------
  {
    let dropped = false;
    let livenessConfirmed = false;
    const proxyStub = {
      closed: false,
      async ensureConnected() {},
      async request(message) {
        if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
        if (message.method === 'tools/list') return { result: { tools: [{ name: 'system.kill_switch_status' }] } };
        return { result: { content: [], isError: false } };
      },
      confirmFraPeerLiveness() { livenessConfirmed = true; return true; },
      _dropSocket() { dropped = true; }
    };
    const teardownResult = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => proxyStub
    });
    assert.equal(teardownResult.ok, true);
    assert.equal(livenessConfirmed, true);
    assert.equal(dropped, true);
    assert.equal(proxyStub.closed, true);
  }

  // A teardown exception is uncertainty about whether the proxy was actually
  // closed, not evidence that cleanup succeeded. The heartbeat must refuse
  // rather than preserve the otherwise-successful round-trip answer. --------
  {
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => ({
        closed: false,
        async ensureConnected() {},
        async request(message) {
          if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
          if (message.method === 'tools/list') return { result: { tools: [{ name: 'system.kill_switch_status' }] } };
          return { result: { content: [], isError: false } };
        },
        confirmFraPeerLiveness() { return true; },
        _dropSocket() { throw new Error('cleanup unavailable'); }
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_TEARDOWN_FAILED');
    assert.equal(result.attempt, 1);
  }

  // --- a liveness write that did not durably commit must not read as a
  // successful heartbeat, even though every network call up to that point
  // was clean -- Task Scheduler must not stay green while the artifact it
  // exists to refresh never actually advances. This is also the
  // "liveness_write" stage coverage required by the test plan. ---------------
  {
    let dropped = false;
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => ({
        closed: false,
        async ensureConnected() {},
        async request(message) {
          if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
          if (message.method === 'tools/list') return { result: { tools: [{ name: 'system.kill_switch_status' }] } };
          return { result: { content: [], isError: false } };
        },
        confirmFraPeerLiveness() { return false; },
        _dropSocket() { dropped = true; }
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_LIVENESS_WRITE_FAILED');
    assert.equal(result.stage, 'liveness_write');
    assert.equal(result.attempt, 1);
    assertElapsedMs(result.elapsedMs);
    assert.equal(dropped, true, 'the proxy must still be torn down even when the liveness write fails');
  }

  // --- the entire probe is bounded by ONE total deadline, not just a
  // per-request timeout -- a proxy whose calls never resolve must still
  // cause heartbeat() to return ok:false with FRA_HEARTBEAT_TIMEOUT rather
  // than hang indefinitely. FRA_HEARTBEAT_TIMEOUT is also never retried, so
  // this stays a single attempt. -------------------------------------------------
  {
    let dropped = false;
    const start = Date.now();
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      timeoutMs: 1000,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      totalTimeoutMs: 200,
      createProxy: () => ({
        closed: false,
        async ensureConnected() {},
        request: () => new Promise(() => {}),
        confirmFraPeerLiveness: mustNotConfirmLiveness,
        _dropSocket() { dropped = true; }
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_TIMEOUT');
    assert.equal(dropped, true, 'the proxy must still be torn down when the total deadline fires');
    assert.ok(Date.now() - start < 5000, 'the total deadline must actually bound wall-clock time, not just be decorative');
    // Correction 2: the deadline-timeout path must no longer report null
    // telemetry -- the current-attempt tracker must show this fired while
    // attempt 1 was stuck at 'initialize' (ensureConnected already resolved,
    // the hung request() call is what the deadline actually caught).
    assert.equal(result.attempt, 1);
    assert.equal(result.stage, 'initialize');
    assertElapsedMs(result.elapsedMs);
  }

  // ========================================================================
  // Correction 2 (2026-08-04 review): the whole-probe DEADLINE-TIMEOUT path
  // previously reported stage/attempt/elapsedMs as null unconditionally --
  // exactly the full-budget-exhaustion failures this telemetry effort exists
  // to diagnose. A "current attempt tracker" living outside any individual
  // attempt's closure now lets the deadline race read the real in-flight
  // stage/attempt/elapsedMs. Two cases: the deadline firing during attempt 1,
  // and during the retry (attempt 2).
  // ========================================================================

  // --- case 2a: the deadline fires while attempt 1 is stuck at 'connect'
  // (ensureConnected itself never resolves) -- distinct stage coverage from
  // the generic deadline test above, which hangs one stage later. -----------
  {
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      totalTimeoutMs: 200,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => ({
        closed: false,
        ensureConnected: () => new Promise(() => {}),
        async request() { throw new Error('must not be reached -- connect never resolves'); },
        confirmFraPeerLiveness: mustNotConfirmLiveness,
        _dropSocket() {}
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_TIMEOUT');
    assert.equal(result.attempt, 1, 'the deadline fired while the FIRST attempt was still in flight');
    assert.equal(result.stage, 'connect',
      'the current-attempt tracker must reflect the real in-flight stage, not null, on a whole-probe timeout');
    assertElapsedMs(result.elapsedMs);
  }

  // --- case 2b: the deadline fires while the RETRY (attempt 2) is in flight
  // -- the tracker must have moved on to attempt 2 by the time the shared
  // deadline catches it. -----------------------------------------------------
  {
    let createProxyCalls = 0;
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      totalTimeoutMs: 300,
      minRetryRemainingMs: 0,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => {
        createProxyCalls += 1;
        if (createProxyCalls === 1) {
          return {
            closed: false,
            async ensureConnected() { throw Object.assign(new Error('closed'), { code: 'REMOTE_BRIDGE_CONNECTION_CLOSED' }); },
            async request() { throw new Error('must not be reached'); },
            confirmFraPeerLiveness: mustNotConfirmLiveness,
            _dropSocket() {}
          };
        }
        return {
          closed: false,
          ensureConnected: () => new Promise(() => {}),
          async request() { throw new Error('must not be reached -- second attempt never gets past connect'); },
          confirmFraPeerLiveness: mustNotConfirmLiveness,
          _dropSocket() {}
        };
      }
    });
    assert.equal(createProxyCalls, 2, 'the retry must still fire when real budget remains');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_TIMEOUT');
    assert.equal(result.attempt, 2, 'the deadline fired while the RETRY (attempt 2) was in flight');
    assert.equal(result.stage, 'connect');
    assertElapsedMs(result.elapsedMs);
  }

  // ========================================================================
  // RELIABILITY LAYER: retry mechanics (required change 3) and guaranteed
  // per-attempt teardown (required change 4).
  // ========================================================================

  // --- a retryable transport failure on the first attempt is retried
  // EXACTLY once, against a genuinely fresh proxy (distinct instances, and
  // distinct createProxy call args reflecting the same peer/host each time),
  // and the retry can recover the probe into a clean success. ----------------
  {
    const createdProxies = [];
    const createProxyCallArgs = [];
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy(options) {
        createProxyCallArgs.push(options);
        const attemptIndex = createdProxies.length;
        const proxy = {
          closed: false,
          dropped: false,
          async ensureConnected() {
            if (attemptIndex === 0) throw Object.assign(new Error('closed'), { code: 'REMOTE_BRIDGE_CONNECTION_CLOSED' });
          },
          async request(message) {
            if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
            if (message.method === 'tools/list') return { result: { tools: [{ name: 'system.kill_switch_status' }] } };
            return { result: { content: [], isError: false } };
          },
          confirmFraPeerLiveness() { return true; },
          _dropSocket() { proxy.dropped = true; }
        };
        createdProxies.push(proxy);
        return proxy;
      }
    });
    assert.equal(createdProxies.length, 2, 'exactly one retry must fire -- exactly two proxies total');
    assert.notEqual(createdProxies[0], createdProxies[1], 'the retry must use a genuinely fresh proxy instance, not the dead one');
    assert.equal(createProxyCallArgs.length, 2);
    assert.equal(createProxyCallArgs[0].host, createProxyCallArgs[1].host, 'both attempts must target the same peer');
    assert.equal(createProxyCallArgs[0].localHost, createProxyCallArgs[1].localHost);
    assert.equal(result.ok, true, 'the retry must be able to recover the probe');
    assert.equal(result.attempt, 2, 'a result recovered on the retry must report attempt:2');
    assert.equal(result.stage, 'liveness_write');
    assert.equal(createdProxies[0].dropped, true, 'the dead first-attempt proxy must still be torn down (change 4)');
    assert.equal(createdProxies[0].closed, true);
    assert.equal(createdProxies[1].dropped, true, 'the successful second-attempt proxy must also be torn down');
    assert.equal(createdProxies[1].closed, true);
  }

  // --- Correction 7: the FIRST attempt's proxy must be explicitly torn down
  // BEFORE the second attempt's fresh proxy is constructed -- not only in
  // the shared final cleanup, which remains as defense in depth. A shared
  // ordered log array records both events; the drop's index must precede
  // the create's index. --------------------------------------------------
  {
    const order = [];
    let createProxyCalls = 0;
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => {
        createProxyCalls += 1;
        const attemptIndex = createProxyCalls;
        order.push(`create-${attemptIndex}`);
        const proxy = {
          closed: false,
          async ensureConnected() {
            if (attemptIndex === 1) throw Object.assign(new Error('closed'), { code: 'REMOTE_BRIDGE_CONNECTION_CLOSED' });
          },
          async request(message) {
            if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
            if (message.method === 'tools/list') return { result: { tools: [{ name: 'system.kill_switch_status' }] } };
            return { result: { content: [], isError: false } };
          },
          confirmFraPeerLiveness() { return true; },
          _dropSocket() { order.push(`drop-${attemptIndex}`); }
        };
        return proxy;
      }
    });
    assert.equal(result.ok, true, 'the retry must still be able to recover the probe');
    assert.equal(createProxyCalls, 2);
    const dropFirstIndex = order.indexOf('drop-1');
    const createSecondIndex = order.indexOf('create-2');
    assert.ok(dropFirstIndex >= 0, `the first attempt's proxy must have been dropped -- observed order: ${order.join(',')}`);
    assert.ok(createSecondIndex >= 0, `the second attempt's proxy must have been created -- observed order: ${order.join(',')}`);
    assert.ok(dropFirstIndex < createSecondIndex,
      `the first proxy's drop (index ${dropFirstIndex}) must happen BEFORE the second proxy's construction ` +
      `(index ${createSecondIndex}) -- observed order: ${order.join(',')}`);
  }

  // --- a retryable transport failure that ALSO fails on the retry does not
  // attempt a third time -- the retry is AT MOST once, never more. -----------
  {
    let createProxyCalls = 0;
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => {
        createProxyCalls += 1;
        const code = createProxyCalls === 1 ? 'REMOTE_BRIDGE_CONNECT_TIMEOUT' : 'REMOTE_BRIDGE_RESET';
        return {
          closed: false,
          async ensureConnected() { throw Object.assign(new Error('down'), { code }); },
          async request() { throw new Error('request must not be reached'); },
          confirmFraPeerLiveness: mustNotConfirmLiveness,
          _dropSocket() {}
        };
      }
    });
    assert.equal(createProxyCalls, 2, 'exactly two attempts total -- the retry must not itself be retried');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'REMOTE_BRIDGE_RESET', 'the SECOND attempt\'s own failure code must be the one reported');
    assert.equal(result.attempt, 2);
    assert.equal(result.stage, 'connect');
  }

  // --- a non-retryable APPLICATION-LEVEL failure (the transport worked, the
  // server answered, the answer itself was bad) must never be retried,
  // confirming the six-code allowlist is exclusive, not just inclusive. ------
  {
    let createProxyCalls = 0;
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => {
        createProxyCalls += 1;
        return {
          closed: false,
          async ensureConnected() {},
          async request(message) {
            if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
            return { error: { code: -32000, message: 'application-level failure, transport is fine' } };
          },
          confirmFraPeerLiveness: mustNotConfirmLiveness,
          _dropSocket() {}
        };
      }
    });
    assert.equal(createProxyCalls, 1, 'an application-level MCP failure must never trigger a retry');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_TOOLS_LIST_FAILED');
    assert.equal(result.attempt, 1);
  }

  // --- the shared whole-probe deadline still bounds BOTH attempts combined:
  // a retryable first-attempt failure is followed by a second attempt that
  // hangs, and the total wall-clock time must stay close to the (scaled-down)
  // totalTimeoutMs, never anywhere near double it -- proving the retry does
  // NOT get its own fresh deadline. minRetryRemainingMs is scaled down too
  // (it defaults to a real 90s floor that a fast scaled-down test could never
  // clear otherwise). ---------------------------------------------------------
  {
    let createProxyCalls = 0;
    let secondProxyDropped = false;
    const start = Date.now();
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      totalTimeoutMs: 300,
      minRetryRemainingMs: 0,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => {
        createProxyCalls += 1;
        if (createProxyCalls === 1) {
          return {
            closed: false,
            async ensureConnected() { throw Object.assign(new Error('closed'), { code: 'REMOTE_BRIDGE_CONNECTION_CLOSED' }); },
            async request() { throw new Error('must not be reached'); },
            confirmFraPeerLiveness: mustNotConfirmLiveness,
            _dropSocket() {}
          };
        }
        return {
          closed: false,
          async ensureConnected() {},
          request: () => new Promise(() => {}),
          confirmFraPeerLiveness: mustNotConfirmLiveness,
          _dropSocket() { secondProxyDropped = true; }
        };
      }
    });
    const elapsed = Date.now() - start;
    assert.equal(createProxyCalls, 2, 'the retry must still fire when real budget remains');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'FRA_HEARTBEAT_TIMEOUT');
    assert.equal(secondProxyDropped, true, 'the hung retry proxy must still be torn down when the shared deadline fires');
    assert.ok(elapsed < 5000,
      `combined two-attempt wall-clock time (${elapsed}ms) must stay bounded by the single shared totalTimeoutMs, ` +
      'not reset to a fresh budget for the retry');
    // Correction 2: this is also a second, independent "deadline fires
    // during the retry" case (the first hangs at a different stage --
    // 'initialize', since its ensureConnected resolves -- than the dedicated
    // case 2b test above, which hangs at 'connect').
    assert.equal(result.attempt, 2, 'the deadline fired while the RETRY (attempt 2) was in flight');
    assert.equal(result.stage, 'initialize');
    assertElapsedMs(result.elapsedMs);
  }

  // ========================================================================
  // Correction B (2026-08-04 review, round 2): a SYNCHRONOUS throw from
  // createProxy() (not a rejected promise -- a real throw during
  // construction, e.g. an eager REMOTE_BRIDGE_CONNECT_FAILED) must still be
  // reported with a real attempt number, stage:'connect', and a real (small)
  // elapsedMs -- not attempt:null/stage:null/elapsedMs:null. Before the fix,
  // the tracker was only primed once runHeartbeatAttempt began, which is
  // AFTER freshProxy()'s createProxy() call -- a synchronous throw there
  // happened before any tracker/attempt bookkeeping existed at all.
  // ========================================================================
  {
    // A NON-retryable code here (deliberately excluded from
    // RETRYABLE_TRANSPORT_CODES, exactly like the existing 'connect' stage
    // coverage above) keeps this a single-attempt case, isolated from the
    // dedicated retry-scenario test below.
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => {
        throw Object.assign(new Error('eager auth failure'), { code: 'REMOTE_BRIDGE_TOKEN_INVALID' });
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'REMOTE_BRIDGE_TOKEN_INVALID');
    assert.equal(result.attempt, 1, 'a synchronous construction-time throw must still report the real attempt number');
    assert.equal(result.stage, 'connect', 'a synchronous construction-time throw must still report stage:\'connect\'');
    assertElapsedMs(result.elapsedMs);
    assert.ok(result.elapsedMs < 5000, 'a synchronous throw must produce a small, plausible elapsed time, not a placeholder');
    assert.equal(result.attemptsHistory.length, 1);
  }

  // --- the same synchronous-throw behaviour on the RETRY (attempt 2): a
  // retryable first attempt is followed by a second attempt whose
  // createProxy() itself throws synchronously -- attempt:2/stage:'connect'
  // must still be reported, not null. -----------------------------------
  {
    let createProxyCalls = 0;
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => {
        createProxyCalls += 1;
        if (createProxyCalls === 1) {
          return {
            closed: false,
            async ensureConnected() { throw Object.assign(new Error('closed'), { code: 'REMOTE_BRIDGE_CONNECTION_CLOSED' }); },
            async request() { throw new Error('must not be reached'); },
            confirmFraPeerLiveness: mustNotConfirmLiveness,
            _dropSocket() {}
          };
        }
        throw Object.assign(new Error('eager connect failure on retry'), { code: 'REMOTE_BRIDGE_CONNECT_FAILED' });
      }
    });
    assert.equal(createProxyCalls, 2);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'REMOTE_BRIDGE_CONNECT_FAILED');
    assert.equal(result.attempt, 2, 'a synchronous construction-time throw on the retry must report attempt:2');
    assert.equal(result.stage, 'connect');
    assertElapsedMs(result.elapsedMs);
  }

  // ========================================================================
  // Correction D (2026-08-04 review, round 2): masked-retry telemetry --
  // a recovered attempt-2 success must not erase attempt-1's own failure
  // code/stage/elapsedMs. The new `attemptsHistory` field (max 2 entries,
  // deep-frozen) must retain BOTH attempts' outcomes.
  // ========================================================================
  {
    const createdProxies = [];
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy(options) {
        const attemptIndex = createdProxies.length;
        const proxy = {
          closed: false,
          async ensureConnected() {
            if (attemptIndex === 0) throw Object.assign(new Error('closed'), { code: 'REMOTE_BRIDGE_CONNECTION_CLOSED' });
          },
          async request(message) {
            if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
            if (message.method === 'tools/list') return { result: { tools: [{ name: 'system.kill_switch_status' }] } };
            return { result: { content: [], isError: false } };
          },
          confirmFraPeerLiveness() { return true; },
          _dropSocket() {}
        };
        createdProxies.push(proxy);
        return proxy;
      }
    });
    assert.equal(result.ok, true, 'the retry must recover the probe');
    assert.equal(result.attempt, 2, 'the top-level result still reports the recovering attempt, unchanged by this correction');
    assert.ok(Array.isArray(result.attemptsHistory), 'attemptsHistory must be present on a recovered success');
    assert.equal(result.attemptsHistory.length, 2, 'both attempts must be retained, not just the successful one');
    assert.equal(Object.isFrozen(result.attemptsHistory), true, 'attemptsHistory must be deep-frozen');
    const [first, second] = result.attemptsHistory;
    assert.equal(Object.isFrozen(first), true, 'each attemptsHistory entry must be frozen');
    assert.equal(first.attempt, 1);
    assert.equal(first.ok, false, 'attempt 1\'s FAILURE must survive, not be erased by attempt 2\'s success');
    assert.equal(first.code, 'REMOTE_BRIDGE_CONNECTION_CLOSED');
    assert.equal(first.stage, 'connect');
    assertElapsedMs(first.elapsedMs);
    assert.equal(second.attempt, 2);
    assert.equal(second.ok, true, 'attempt 2\'s success must also be present');
    assert.equal(second.code, null, 'a successful attempt entry must carry a null code, never a placeholder string');
    assert.equal(second.stage, 'liveness_write');
    assertElapsedMs(second.elapsedMs);
    // Mutation must never be possible after construction.
    assert.throws(() => { result.attemptsHistory.push({}); });
    assert.throws(() => { first.ok = true; });
  }

  // --- a clean, non-retried success reports exactly ONE attemptsHistory
  // entry -- the array is not padded or backfilled. ------------------------
  {
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => ({
        closed: false,
        async ensureConnected() {},
        async request(message) {
          if (message.method === 'initialize') return { result: { serverInfo: { name: 'toolsenabled' } } };
          if (message.method === 'tools/list') return { result: { tools: [{ name: 'system.kill_switch_status' }] } };
          return { result: { content: [], isError: false } };
        },
        confirmFraPeerLiveness() { return true; },
        _dropSocket() {}
      })
    });
    assert.equal(result.ok, true);
    assert.equal(result.attemptsHistory.length, 1);
    assert.equal(result.attemptsHistory[0].attempt, 1);
    assert.equal(result.attemptsHistory[0].ok, true);
  }

  // --- a non-retried, non-retryable single failure also reports exactly
  // ONE attemptsHistory entry, and it is not duplicated by the outer catch
  // (a regression this correction's implementation could easily introduce:
  // recording the same firstError twice, once in the inner catch and again
  // in the outer one). -------------------------------------------------------
  {
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => ({
        closed: false,
        async ensureConnected() { throw Object.assign(new Error('mismatch'), { code: 'REMOTE_BRIDGE_PEER_MISMATCH' }); },
        async request() { throw new Error('must not be reached'); },
        confirmFraPeerLiveness: mustNotConfirmLiveness,
        _dropSocket() {}
      })
    });
    assert.equal(result.ok, false);
    assert.equal(result.attemptsHistory.length, 1, 'a non-retried failure must be recorded exactly once, not duplicated');
    assert.equal(result.attemptsHistory[0].ok, false);
    assert.equal(result.attemptsHistory[0].code, 'REMOTE_BRIDGE_PEER_MISMATCH');
  }

  // --- a retryable failure on BOTH attempts (no recovery) also retains
  // both attempts' summaries, not just the final (second) one. --------------
  {
    let createProxyCalls = 0;
    const result = await heartbeatModule.heartbeat({
      host: heartbeatModule.HOST_B,
      loadProfile: () => ({ allowedTools: ['system.kill_switch_status'] }),
      loadToken: () => 'x',
      createProxy: () => {
        createProxyCalls += 1;
        const code = createProxyCalls === 1 ? 'REMOTE_BRIDGE_CONNECT_TIMEOUT' : 'REMOTE_BRIDGE_RESET';
        return {
          closed: false,
          async ensureConnected() { throw Object.assign(new Error('down'), { code }); },
          async request() { throw new Error('must not be reached'); },
          confirmFraPeerLiveness: mustNotConfirmLiveness,
          _dropSocket() {}
        };
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.attemptsHistory.length, 2);
    assert.equal(result.attemptsHistory[0].code, 'REMOTE_BRIDGE_CONNECT_TIMEOUT');
    assert.equal(result.attemptsHistory[0].ok, false);
    assert.equal(result.attemptsHistory[1].code, 'REMOTE_BRIDGE_RESET');
    assert.equal(result.attemptsHistory[1].ok, false);
  }

  // --- sanitizeHeartbeatTelemetry() (the unattended-log projection) must
  // carry the bounded/sanitized attemptsHistory through too, and must never
  // let an unsafe/unexpected value on an individual entry escape the
  // allowlist -- the same discipline it already applies to code/stage/
  // attempt/elapsedMs. -------------------------------------------------------
  {
    const sanitized = heartbeatModule.sanitizeHeartbeatTelemetry({
      ok: true, stage: 'liveness_write', attempt: 2, elapsedMs: 500,
      attemptsHistory: [
        { attempt: 1, stage: 'connect', code: 'REMOTE_BRIDGE_RESET', elapsedMs: 120, ok: false },
        { attempt: 2, stage: 'liveness_write', code: null, elapsedMs: 500, ok: true }
      ]
    });
    assert.equal(sanitized.attemptsHistory.length, 2);
    assert.deepEqual(sanitized.attemptsHistory[0],
      { attempt: 1, stage: 'connect', code: 'REMOTE_BRIDGE_RESET', elapsedMs: 120, ok: false });
    assert.deepEqual(sanitized.attemptsHistory[1],
      { attempt: 2, stage: 'liveness_write', code: null, elapsedMs: 500, ok: true });

    // A malformed/hostile entry (bad stage, unsafe code, extra field, a
    // third entry beyond the max-2 bound) must never pass through
    // unsanitized.
    const hostile = heartbeatModule.sanitizeHeartbeatTelemetry({
      ok: false, attemptsHistory: [
        { attempt: 1, stage: 'connect', code: 'REMOTE_BRIDGE_RESET', elapsedMs: 10, ok: false },
        { attempt: 2, stage: 'not_a_real_stage', code: 'lowercase not safe', elapsedMs: -5, ok: false, secretPath: 'C:\\should\\never\\appear' },
        { attempt: 1, stage: 'connect', code: 'SHOULD_NOT_APPEAR', elapsedMs: 1, ok: false }
      ]
    });
    assert.equal(hostile.attemptsHistory.length, 2, 'no more than 2 entries may ever survive sanitization');
    assert.equal(hostile.attemptsHistory[1].stage, null, 'an unrecognized stage must collapse to null');
    assert.equal(hostile.attemptsHistory[1].code, 'FRA_HEARTBEAT_FAILED', 'an unsafe code must collapse to the fallback');
    assert.equal(hostile.attemptsHistory[1].elapsedMs, null, 'a negative elapsedMs must collapse to null');
    const serialized = JSON.stringify(hostile);
    assert.equal(serialized.includes('secretPath'), false);
    assert.equal(serialized.includes('SHOULD_NOT_APPEAR'), false);

    // A non-array attemptsHistory (missing entirely, or the wrong type) must
    // collapse to a safe empty frozen array, never throw and never echo the
    // malformed value through.
    const missing = heartbeatModule.sanitizeHeartbeatTelemetry({ ok: true, stage: 'liveness_write', attempt: 1, elapsedMs: 5 });
    assert.deepEqual(missing.attemptsHistory, []);
    assert.equal(Object.isFrozen(missing.attemptsHistory), true);
  }

  console.log('FRA peer heartbeat CLI contract passed.');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
