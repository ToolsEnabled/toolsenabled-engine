'EXECUTABLE CHANGE — testcanfail-tests-repo-sync-test-js';
//
// Strengthened assertions and mutation evidence:
// - `assertOnlyFilekeeperReceiverOperations`: `Array#every` accepted an empty
//   call trace. It now requires at least one receiver operation. There is no
//   product-only mutation that can preserve the asserted action while erasing
//   the fixture-private trace, so that mutation precondition could not be met;
//   the regression check below directly quotes the formerly accepted input.
// - State schema version: mutated tools/repo-sync.js's STATE_SCHEMA_VERSION from
//   1 to 2. The old self-derived expectation stayed green with
//   `Repo-sync reconciler tests passed (19 checks).` With the literal
//   contract below it went red with:
//     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
//     2 !== 1
//   tools/repo-sync.js was then restored byte-for-byte.
// - Restored-source green confirmation:
//     Repo-sync reconciler tests passed (19 checks).
// - NOT-FOUND: exit-status/truthy-return-only evidence; swallowed failures via
//   try/catch or optional chaining; assertions against a mock of repo-sync;
//   skips or platform precondition guards. The two fixed, literal scenario
//   loops cannot become empty through a product mutation. No other expected
//   value is computed by the same product code it checks.

'use strict';

// All Git operations and the all-ref single-copy detector are faked here.
// This suite must never contact a real remote or mutate a real checkout.

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const sync = require('../tools/repo-sync.js');

const FIXTURE_ROOT = path.join(os.tmpdir(), 'fixture-dedicated-sync-checkout');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
}

function cleanContainment(overrides = {}) {
  return {
    status: 'clean',
    code: null,
    summary: 'nothing stranded across advertised refs',
    scope: { network: true, remotesFetched: ['origin'] },
    ...overrides
  };
}

function makeDeps(overrides = {}) {
  const calls = [];
  const detectorCalls = [];
  const stateWrites = [];
  const scenario = {
    branch: 'main',
    ahead: 0,
    behind: 0,
    postAhead: 0,
    postBehind: 0,
    dirty: [],
    failFetch: false,
    failFastForward: false,
    stopFile: false,
    containment: cleanContainment(),
    containmentError: null,
    initialObservation: null,
    postObservation: null,
    ...overrides
  };
  let fastForwarded = false;

  const transport = {
    observeBranch() {
      calls.push('observeBranch');
      return { state: 'SAFE', branch: scenario.branch };
    },
    fetchPrune() {
      calls.push('fetchPrune');
      if (scenario.failFetch) {
        return { state: 'UNSAFE', exitCode: 1, detail: 'remote unavailable' };
      }
      return { state: 'SAFE' };
    },
    observeReceiver() {
      calls.push('observeReceiver');
      const injected = fastForwarded ? scenario.postObservation : scenario.initialObservation;
      if (injected !== null) return injected;
      return {
        state: 'SAFE',
        dirtyPaths: scenario.dirty.map(line => line.length > 3 ? line.slice(3) : line),
        ahead: fastForwarded ? scenario.postAhead : scenario.ahead,
        behind: fastForwarded ? scenario.postBehind : scenario.behind,
      };
    },
    fastForward() {
      calls.push('fastForward');
      if (scenario.failFastForward) return { state: 'UNSAFE', exitCode: 1, detail: 'fast-forward failed' };
      fastForwarded = true;
      return { state: 'SAFE' };
    },
  };

  const singleCopyCheck = options => {
    detectorCalls.push(options);
    if (scenario.containmentError) throw scenario.containmentError;
    return scenario.containment;
  };
  const fsImpl = {
    existsSync: file => (file === sync.STOP_FILE ? scenario.stopFile : false),
    mkdirSync: () => {},
    writeFileSync: (file, body) => stateWrites.push({ file, body: JSON.parse(body) })
  };

  return {
    deps: {
      transport,
      singleCopyCheck,
      fsImpl,
      root: FIXTURE_ROOT,
      now: () => '2026-08-07T00:00:00.000Z'
    },
    calls,
    detectorCalls,
    stateWrites
  };
}

function assertOnlyFilekeeperReceiverOperations(calls) {
  assert.ok(calls.length > 0, 'expected at least one Filekeeper receiver operation');
  assert.ok(calls.every(call => ['observeBranch', 'fetchPrune', 'observeReceiver', 'fastForward'].includes(call)));
  assert.ok(!calls.includes('push'));
}

check('the receiver-operation assertion rejects an empty trace', () => {
  assert.throws(
    () => assertOnlyFilekeeperReceiverOperations([]),
    /expected at least one Filekeeper receiver operation/
  );
});

check('in-sync fetches with prune, verifies all-ref containment, and never mutates', () => {
  const { deps, calls, detectorCalls, stateWrites } = makeDeps();
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'in-sync');
  assert.equal(result.ok, true);
  assert.ok(calls.includes('fetchPrune'));
  assert.ok(calls.includes('observeReceiver'));
  assert.deepEqual(detectorCalls, [{
    root: FIXTURE_ROOT, network: true, strictUncommitted: true
  }]);
  assert.equal(result.containment.status, 'verified');
  assert.equal(result.countsAreContainmentProof, false);
  assertOnlyFilekeeperReceiverOperations(calls);
  assert.equal(stateWrites.length, 1);
});

check('prune failure is typed and stops before containment or movement', () => {
  const { deps, calls, detectorCalls } = makeDeps({ failFetch: true });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'fetch-failed');
  assert.equal(result.ok, false);
  assert.equal(detectorCalls.length, 0);
  assert.match(result.detail, /remote unavailable/);
  assertOnlyFilekeeperReceiverOperations(calls);
});

check('non-main checkout is refused before fetch', () => {
  const { deps, calls } = makeDeps({ branch: 'feature/work' });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'wrong-branch');
  assert.equal(result.ok, false);
  assert.ok(!calls.includes('fetchPrune'));
  assertOnlyFilekeeperReceiverOperations(calls);
});

check('untracked work is dirty and blocks a behind-only fast-forward', () => {
  const { deps, calls } = makeDeps({ behind: 2, dirty: ['?? scratch/notes.txt'] });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'dirty-worktree');
  assert.equal(result.dirtyPathCount, 1);
  assert.deepEqual(result.dirtyPaths, ['scratch/notes.txt']);
  assert.ok(!calls.includes('fastForward'));
});

check('tracked work is dirty and is named in state', () => {
  const { deps } = makeDeps({ behind: 1, dirty: [' M src/lib/thing.js'] });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'dirty-worktree');
  assert.deepEqual(result.dirtyPaths, ['src/lib/thing.js']);
  assert.match(result.detail, /src\/lib\/thing\.js/);
});

check('clean behind-only main uses only --ff-only and verifies the result', () => {
  const { deps, calls } = makeDeps({ behind: 3 });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'fast-forward');
  assert.equal(result.ok, true);
  assert.equal(result.ahead, 0);
  assert.equal(result.behind, 0);
  assert.ok(calls.includes('fastForward'));
  assertOnlyFilekeeperReceiverOperations(calls);
});

check('ahead-only main stops with an actionable typed state and never pushes', () => {
  const { deps, calls } = makeDeps({ ahead: 2 });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'ahead-main');
  assert.equal(result.ok, false);
  assert.match(result.detail, /will not push/);
  assertOnlyFilekeeperReceiverOperations(calls);
});

check('diverged main stops without merge, rebase, reset, or push', () => {
  const { deps, calls } = makeDeps({ ahead: 2, behind: 3 });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'diverged-main');
  assert.equal(result.ok, false);
  assert.match(result.detail, /ahead 2, behind 3/);
  assert.ok(!calls.includes('fastForward'));
  assertOnlyFilekeeperReceiverOperations(calls);
});

check('unknown advertised-ref containment stops even when one-upstream counts are green', () => {
  const { deps, calls } = makeDeps({
    containment: {
      status: 'indeterminate',
      code: 'REF_FETCH_FAILED',
      reason: 'review ref could not be fetched',
      scope: { network: true, remotesFetched: ['origin'] }
    }
  });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'containment-unknown');
  assert.equal(result.ok, false);
  assert.equal(result.containment.code, 'REF_FETCH_FAILED');
  assert.equal(result.countsAreContainmentProof, false);
  assertOnlyFilekeeperReceiverOperations(calls);
});

check('offline clean detector result is not accepted as containment proof', () => {
  const { deps } = makeDeps({
    containment: cleanContainment({ scope: { network: false, remotesFetched: [] } })
  });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'containment-unknown');
  assert.equal(result.containment.code, 'CONTAINMENT_NOT_NETWORK_VERIFIED');
});

check('stranded work elsewhere blocks an otherwise safe fast-forward', () => {
  const { deps, calls } = makeDeps({
    behind: 1,
    containment: {
      status: 'stranded',
      code: null,
      summary: 'untracked file in another worktree',
      scope: { network: true, remotesFetched: ['origin'] }
    }
  });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'single-copy-stranded');
  assert.ok(!calls.includes('fastForward'));
});

check('default construction receives the Filekeeper transport factory result', () => {
  const calls = [];
  const transport = {
    observeBranch: () => ({ state: 'SAFE', branch: 'main' }),
    fetchPrune: () => ({ state: 'SAFE' }),
    observeReceiver: () => ({ state: 'SAFE', dirtyPaths: [], ahead: 0, behind: 0 }),
    fastForward: () => { calls.push('fastForward'); return { state: 'SAFE' }; },
  };
  const { deps } = makeDeps();
  delete deps.transport;
  deps.transportFactory = root => {
    calls.push(root);
    return transport;
  };
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'in-sync');
  assert.deepEqual(calls, [FIXTURE_ROOT]);
});

check('stop file disables synchronization and is not reported healthy', () => {
  const { deps, calls, stateWrites } = makeDeps({ stopFile: true });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'stopped');
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
  assert.equal(stateWrites.length, 1);
});

check('fast-forward failure is typed and never falls back to another merge', () => {
  const { deps, calls } = makeDeps({ behind: 2, failFastForward: true });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'fast-forward-failed');
  assert.equal(result.ok, false);
  assert.deepEqual(calls.filter(call => call === 'fastForward'), ['fastForward']);
  assertOnlyFilekeeperReceiverOperations(calls);
});

check('post-fast-forward disagreement refuses a success claim', () => {
  const { deps } = makeDeps({ behind: 2, postBehind: 1 });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'post-fast-forward-unknown');
  assert.equal(result.ok, false);
});

check('malformed SAFE receiver observations fail closed before containment or movement', () => {
  const malformedObservations = [
    { state: 'SAFE', ahead: 0, behind: 0 },
    { state: 'SAFE', dirtyPaths: [], behind: 0 },
    { state: 'SAFE', dirtyPaths: [], ahead: 0 },
    { state: 'SAFE', dirtyPaths: 'not-an-array', ahead: 0, behind: 0 },
    { state: 'SAFE', dirtyPaths: ['valid', 7], ahead: 0, behind: 0 },
    { state: 'SAFE', dirtyPaths: [], ahead: -1, behind: 0 },
    { state: 'SAFE', dirtyPaths: [], ahead: 0, behind: 1.5 },
  ];
  for (const initialObservation of malformedObservations) {
    const { deps, calls, detectorCalls } = makeDeps({ initialObservation });
    const result = sync.runOnce(deps);
    assert.equal(result.action, 'inspection-failed');
    assert.equal(result.ok, false);
    assert.match(result.detail, /invalid SAFE receiver observation/);
    assert.equal(detectorCalls.length, 0);
    assert.ok(!calls.includes('fastForward'));
  }
});

check('malformed post-fast-forward SAFE receiver observation refuses success', () => {
  const { deps } = makeDeps({
    behind: 1,
    postObservation: { state: 'SAFE', dirtyPaths: [], ahead: 0, behind: -1 },
  });
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'post-fast-forward-unknown');
  assert.equal(result.ok, false);
  assert.match(result.detail, /invalid SAFE receiver observation/);
});

check('every exit writes one bounded, versioned truth state', () => {
  const scenarios = [
    {},
    { failFetch: true },
    { branch: 'dev' },
    { dirty: Array.from({ length: 55 }, (_, index) => `?? scratch/${index}.txt`) },
    { ahead: 1 },
    { ahead: 1, behind: 1 },
    { behind: 2 },
    { stopFile: true }
  ];
  for (const scenario of scenarios) {
    const { deps, stateWrites } = makeDeps(scenario);
    sync.runOnce(deps);
    assert.equal(stateWrites.length, 1, `state not written for ${JSON.stringify(scenario)}`);
    const state = stateWrites[0].body;
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.generatedAt, '2026-08-07T00:00:00.000Z');
    assert.equal(typeof state.action, 'string');
    assert.equal(state.countsAreContainmentProof, false);
    assert.ok(state.dirtyPaths.length <= 50);
    assert.ok(JSON.stringify(state).length < 20_000);
  }
});

check('state persistence failure refuses an otherwise successful result', () => {
  const { deps } = makeDeps();
  deps.fsImpl.writeFileSync = () => {
    const error = new Error('state volume is read-only');
    error.code = 'EROFS';
    throw error;
  };
  const result = sync.runOnce(deps);
  assert.equal(result.action, 'state-write-failed');
  assert.equal(result.ok, false);
  assert.match(result.detail, /state volume is read-only/);
});

console.log(`Repo-sync reconciler tests passed (${passed} checks).`);
