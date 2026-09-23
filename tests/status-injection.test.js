// REFUSED-CONTROL
// testcanfail-tests-status-injection-test-js
//
// PRECONDITION-NOT-MET: the mutation protocol requires this file to run, but
// the available Node.js v20.20.2 runtime does not provide `node:sqlite`.
// Baseline command: `node tests/status-injection.test.js`
// Baseline output: "AuditStoreError: global opt-in collects the compact source
// set: The audit ledger could not be opened."
// Attempted runtime remedy: `npx -y node@22 tests/status-injection.test.js`
// Remedy output: "npm error 403 403 Forbidden - GET
// https://registry.npmjs.org/node".
// Because a green baseline was impossible, no product mutation was made and
// no assertion was changed without the required green/red/green evidence.
//
// Static census (not a substitute for mutation evidence):
// 1 EMPTY-ITERATION: NOT-FOUND. Both assertion loops iterate non-empty array
//   literals; neither collection can be empty at runtime.
// 2 EXIT-STATUS/TRUTHY-PROXY: NOT-FOUND. This file does not spawn a process or
//   assert an exit status; return-value assertions inspect subject output.
// 3 SWALLOWED-FAILURE: NOT-FOUND. try/finally blocks only clean resources, the
//   top-level catch reports and marks failure, and there is no optional chain.
// 4 SUBJECT-MOCK: NOT-FOUND. Injected readers are collaborators/fixtures; the
//   status-injection subject itself is imported from production.
// 5 SKIP/PRECONDITION-GUARD: NOT-FOUND. Every registered case is awaited and
//   there are no skips or platform guards.
// 6 SELF-COMPUTED-EXPECTED: NOT-FOUND. Expected values are fixed literals or
//   regexes, not values produced by the implementation under test.

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAuditStore } = require('../src/lib/audit-store');
const statusInjection = require('../src/lib/status-injection');
const statusSnapshotTool = require('../tools/status-snapshot');

const ROOT = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-08-11T17:30:00.000Z');

function settings(global, overrides = []) {
  return {
    values: {
      [statusInjection.GLOBAL_SETTING_ID]: global,
      [statusInjection.NODE_OVERRIDES_SETTING_ID]: overrides
    },
    revision: 1,
    rejected: []
  };
}

function measuredDependencies(extra = {}) {
  // Project rule: an audit-touching test owns an in-memory store.  The
  // durability source below reads its status and never reaches the production
  // audit singleton or sidecar.
  const auditStore = createAuditStore({ file: ':memory:' });
  const dependencies = {
    settings: settings(true),
    clock: () => NOW,
    readMachineLoad: async () => ({
      status: 'MEASURED', utilizationPercent: 37, coreCount: 16,
      sampleIntervalMs: 200, detail: 'sk_live_must_not_render'
    }),
    readMemory: () => ({
      status: 'MEASURED', freeBytes: 8 * 1024 ** 3,
      totalBytes: 32 * 1024 ** 3, freePercent: 25
    }),
    readStateHealth: () => ({
      ok: true, schemaVersion: 20, expectedSchemaVersion: 20,
      integrity: { ok: true }, path: 'C:/private/state.sqlite3'
    }),
    readAuditDurability: () => {
      auditStore.status();
      return {
        state: 'warn', pendingEmergency: 0,
        current: { failing: false, breachCount: 0 },
        historical: { breachCount: 9 },
        reasons: ['Bearer must-not-render']
      };
    },
    readOwnerCapture: () => [
      { text: 'owner private words must not render' },
      { text: 'another private record must not render' }
    ],
    readUsage: () => ({
      coverage: { state: 'complete', complete: true, scannedEvents: 200 },
      totals: { calls: 4, tokens: 1234, measuredLowerBoundTokens: 1234 },
      window: { latestTimestamp: '2026-08-11T17:29:00.000Z' },
      rows: [{ pool: 'private-account-name', provider: 'gemini', tokens: 1234 }]
    }),
    readQuota: async () => ({
      codex: {
        status: 'PARTIAL', accountCount: 2, usableAccounts: 1,
        exhaustedAccounts: 1, unknownAccounts: 0, maxUsedPercent: 100,
        minRemainingPercent: 0, nearestReset: '2026-08-12T00:00:00.000Z',
        email: 'private@example.com', token: 'sk_live_must_not_render'
      },
      claude: {
        status: 'MEASURED', usedPercent: 42, limitKind: 'weekly',
        resetsAt: '2026-08-13T00:00:00.000Z', ageMs: 1000,
        accountUuid: 'private-account-uuid'
      }
    }),
    ...extra
  };
  return { auditStore, dependencies };
}

const cases = [];
function test(name, run) { cases.push([name, run]); }

test('missing global setting is OFF', () => {
  const decision = statusInjection.resolveInjectionSetting({ values: {} }, { host: 'machine-a' });
  assert.deepEqual(decision, { enabled: false, source: 'default', reason: 'SETTING_ABSENT' });
  const overrideWithoutGlobal = statusInjection.resolveInjectionSetting({
    values: {
      [statusInjection.NODE_OVERRIDES_SETTING_ID]: [
        { kind: 'host', id: 'machine-a', enabled: true }
      ]
    }
  }, { host: 'machine-a' });
  assert.deepEqual(overrideWithoutGlobal, {
    enabled: false, source: 'default', reason: 'SETTING_ABSENT'
  });
});

test('settings read failure is refused without reporting the key absent', async () => {
  const snapshot = await statusInjection.collectStatusSnapshot({}, {
    clock: () => NOW,
    loadSettings: () => { throw new Error('settings store unreachable'); }
  });
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.observations, null);
  assert.deepEqual(snapshot.setting, {
    enabled: false, source: 'default', reason: 'SETTINGS_UNAVAILABLE'
  });
});

test('OFF collection invokes no status source', async () => {
  let calls = 0;
  const snapshot = await statusInjection.collectStatusSnapshot({ settings: { values: {} } }, {
    clock: () => NOW,
    readMachineLoad: () => { calls += 1; throw new Error('must not run'); },
    readQuota: () => { calls += 1; throw new Error('must not run'); }
  });
  assert.equal(snapshot.enabled, false);
  assert.equal(snapshot.observations, null);
  assert.equal(calls, 0);
  assert.equal(statusInjection.renderStatusBlock(snapshot), '');
});

test('global opt-in collects the compact source set', async () => {
  const { auditStore, dependencies } = measuredDependencies();
  try {
    const snapshot = await statusInjection.collectStatusSnapshot({}, dependencies);
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.setting.source, 'global');
    assert.equal(snapshot.observations.cpu.utilizationPercent, 37);
    assert.equal(snapshot.observations.memory.freePercent, 25);
    assert.equal(snapshot.observations.stateStore.schemaVersion, 20);
    assert.equal(snapshot.observations.auditDurability.state, 'warn');
    assert.equal(snapshot.observations.ownerCapture.pendingCount, 2);
    assert.equal(snapshot.observations.usage.tokens, 1234);
    assert.equal(snapshot.observations.quota.codex.minRemainingPercent, 0);
    assert.equal(snapshot.observations.quota.claude.remainingPercent, 58);
  } finally {
    auditStore.close();
  }
});

test('per-host override can opt in while global is off', () => {
  const decision = statusInjection.resolveInjectionSetting(settings(false, [
    { kind: 'host', id: 'machine-a', enabled: true }
  ]), { host: 'machine-a' });
  assert.deepEqual(decision, { enabled: true, source: 'host', reason: 'NODE_OVERRIDE' });
});

test('agent override wins over lane and host overrides', () => {
  const decision = statusInjection.resolveInjectionSetting(settings(true, [
    { kind: 'host', id: 'machine-a', enabled: true },
    { kind: 'lane', id: 'status-push', enabled: true },
    { kind: 'agent', id: 'codex', enabled: false }
  ]), { agent: 'codex', lane: 'status-push', host: 'machine-a' });
  assert.deepEqual(decision, { enabled: false, source: 'agent', reason: 'NODE_OVERRIDE' });
});

test('malformed or duplicate overrides fail closed', () => {
  assert.equal(statusInjection.resolveInjectionSetting(settings(true, [
    { kind: 'host', id: 'machine-a', enabled: true },
    { kind: 'host', id: 'machine-a', enabled: false }
  ]), { host: 'machine-a' }).enabled, false);
  assert.equal(statusInjection.resolveInjectionSetting(settings(true, [
    { kind: 'host', id: 'machine-a', enabled: 'yes' }
  ]), { host: 'machine-a' }).enabled, false);
});

test('rendered block is bounded to safe aggregate fields', async () => {
  const { auditStore, dependencies } = measuredDependencies();
  try {
    const block = statusInjection.renderStatusBlock(await statusInjection.collectStatusSnapshot({}, dependencies));
    assert.match(block, /^\[TOOLSENABLED STATUS v1\]/);
    assert.match(block, /cpu=37%\/16c\/200ms/);
    assert.match(block, /ownerIngress=2 owner turns spooled and unclassified, oldest unknown/);
    assert.match(block, /codex=PARTIAL 1\/2 usable, 0% measured-min remaining/);
    assert.match(block, /usage=complete tokens=1234 calls=4 tail=200/);
    for (const forbidden of [
      'sk_live_must_not_render', 'private@example.com', 'private-account-name',
      'private-account-uuid', 'owner private words', 'Bearer must-not-render',
      'C:/private/state.sqlite3'
    ]) assert.equal(block.includes(forbidden), false, `render leaked ${forbidden}`);
    assert.ok(Buffer.byteLength(block, 'utf8') < 2048);
  } finally {
    auditStore.close();
  }
});

test('owner ingress line folds in fallback records and reports the oldest age', async () => {
  // The real owner-ingress reader against a real spool + fallback journal, so
  // the enrichment is exercised end to end: a fallback-file turn (one captured
  // when the primary spool write failed) must be COUNTED, and the oldest age
  // across both stores must appear -- neither of which a bare owner-capture
  // pending count could show. Owner text must never reach the rendered block.
  const ingress = require('../tools/owner-ingress-spool');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-ingress-'));
  const ledgerFile = path.join(dir, 'OWNER-REQUEST-LEDGER.json');
  const fallbackFile = ingress.fallbackFileForLedger(ledgerFile);
  try {
    // One spooled ingress turn, 3h old.
    const spooled = ingress.captureHookEvent(
      { hook_event_name: 'UserPromptSubmit', prompt: 'owner private words must not render', session_id: 's1' },
      { ledgerFile, fallbackFile, now: new Date(NOW - 3 * 3600_000) });
    assert.equal(spooled.action, 'spooled', 'the primary spool write must succeed for this fixture');
    // One fallback-file turn, 5h old -- the oldest, and invisible to the old count.
    ingress.appendFallback(fallbackFile, {
      text: 'another private fallback turn must not render',
      reason: 'spool-module-failure', now: new Date(NOW - 5 * 3600_000)
    });

    const { auditStore, dependencies } = measuredDependencies({
      readOwnerCapture: () => ingress.getIngressStatus({ ledgerFile, fallbackFile, now: new Date(NOW) })
    });
    try {
      const snapshot = await statusInjection.collectStatusSnapshot({}, dependencies);
      assert.equal(snapshot.observations.ownerCapture.pendingCount, 2,
        'both the spooled turn and the fallback-file turn are counted');
      const block = statusInjection.renderStatusBlock(snapshot);
      assert.match(block, /ownerIngress=2 owner turns spooled and unclassified, oldest 5\.0h/);
      assert.equal(block.includes('owner private words'), false, 'the spooled owner text must not leak');
      assert.equal(block.includes('another private fallback'), false, 'the fallback owner text must not leak');
    } finally {
      auditStore.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('source failures stay UNKNOWN without dropping the block', async () => {
  const { auditStore, dependencies } = measuredDependencies({
    readMachineLoad: () => { throw new Error('secret cpu failure'); },
    readStateHealth: () => { throw new Error('secret state failure'); },
    readAuditDurability: () => { throw new Error('secret audit failure'); },
    readOwnerCapture: () => { throw new Error('secret owner words'); },
    readUsage: () => { throw new Error('secret usage failure'); },
    readQuota: () => { throw new Error('secret quota failure'); }
  });
  try {
    const block = statusInjection.renderStatusBlock(await statusInjection.collectStatusSnapshot({}, dependencies));
    for (const reason of [
      'CPU_UNAVAILABLE', 'STATE_STORE_UNAVAILABLE', 'AUDIT_DURABILITY_UNAVAILABLE',
      'OWNER_CAPTURE_BACKLOG_UNAVAILABLE', 'USAGE_SOURCE_UNAVAILABLE', 'QUOTA_SOURCE_UNAVAILABLE'
    ]) assert.match(block, new RegExp(reason));
    assert.equal(block.includes('secret'), false);
  } finally {
    auditStore.close();
  }
});

test('partial usage reports a measured lower bound, never a fabricated total', async () => {
  const { auditStore, dependencies } = measuredDependencies({
    readUsage: () => ({
      coverage: { state: 'partial', complete: false, scannedEvents: 200 },
      totals: { calls: 3, tokens: null, measuredLowerBoundTokens: 777 },
      window: { latestTimestamp: null }
    })
  });
  try {
    const block = statusInjection.renderStatusBlock(await statusInjection.collectStatusSnapshot({}, dependencies));
    assert.match(block, /usage=partial tokens>=777 calls=3 tail=200/);
  } finally {
    auditStore.close();
  }
});

// The former observation file has no authenticated generation binding. Age,
// even zero, cannot authorize quota reuse after another login replaces it.
for (const [label, observedAtMs, corrupt] of [
  ['fresh', NOW, false], ['inside the old interval', NOW - 30_000, false],
  ['past the old interval', NOW - 300_000, false],
  ['past the old maximum age', NOW - 900_001, false],
  ['future stamped', NOW + 30_000, false], ['corrupt', NOW, true]
]) {
  test(`an unbound ${label} quota record is not replayed, probed or modified`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-quota-refusal-'));
    const file = path.join(dir, 'observation.json');
    const bytes = corrupt ? '{ not json' : JSON.stringify({ schemaVersion: 1, observedAtMs,
      quota: { codex: { status: 'MEASURED', accountCount: 1, usableAccounts: 1,
        maxUsedPercent: 52, minRemainingPercent: 48 },
        claude: { status: 'MEASURED', usedPercent: 42, ageMs: 0 } } });
    fs.writeFileSync(file, bytes);
    let probes = 0, reads = 0;
    try {
      const answer = await statusInjection.readQuotaObservation({}, {
        clock: () => NOW, quotaObservationFile: file,
        fsImpl: { readFileSync() { reads += 1; return bytes; } },
        probeQuota: async () => { probes += 1; return { status: 'UNKNOWN' }; }
      });
      assert.deepEqual(answer, { status: 'UNKNOWN', reason: 'QUOTA_BOUND_SNAPSHOT_UNAVAILABLE' });
      assert.equal(reads, 0);
      assert.equal(probes, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('an explicitly supplied current quota reading remains dated and is not persisted', async () => {
  const { auditStore, dependencies } = measuredDependencies();
  const readQuota = dependencies.readQuota;
  dependencies.readQuota = async () => ({ ...await readQuota(), observedAgeMs: 45000 });
  dependencies.fsImpl = { readFileSync() { throw new Error('no implicit quota read'); },
    writeFileSync() { throw new Error('no quota persistence'); } };
  try {
    const snapshot = await statusInjection.collectStatusSnapshot({}, dependencies);
    const block = statusInjection.renderStatusBlock(snapshot);
    assert.match(block, /quota=observedAgeMs=45000; codex=PARTIAL/);
    for (const secret of ['private@example.com', 'sk_live_must_not_render', 'private-account-uuid']) {
      assert.equal(JSON.stringify(snapshot).includes(secret), false);
      assert.equal(block.includes(secret), false);
    }
  } finally { auditStore.close(); }
});

test('canonical partial Claude coverage is rendered as a measured minimum across listed accounts', async () => {
  const { auditStore, dependencies } = measuredDependencies({
    readQuota: async () => ({ codex: { status: 'UNKNOWN' }, claude: {
      status: 'PARTIAL', accountCount: 3, usableAccounts: 2, exhaustedAccounts: 0,
      unknownAccounts: 1, maxUsedPercent: 42, minRemainingPercent: 58, nearestReset: null
    } })
  });
  try {
    const snapshot = await statusInjection.collectStatusSnapshot({}, dependencies);
    assert.equal(snapshot.observations.quota.claude.unknownAccounts, 1);
    assert.match(statusInjection.renderStatusBlock(snapshot), /claude=PARTIAL 2\/3 usable, 58% measured-min remaining/);
  } finally { auditStore.close(); }
});

test('prepend is a no-op while off and adds one block while on', async () => {
  const text = 'BEGIN ORIGINAL PACKET\n';
  assert.equal(await statusInjection.prependStatusInjection(text, { settings: { values: {} } }, { clock: () => NOW }), text);
  const { auditStore, dependencies } = measuredDependencies();
  try {
    const combined = await statusInjection.prependStatusInjection(text, {}, dependencies);
    assert.equal(combined.match(/\[TOOLSENABLED STATUS v1\]/g).length, 1);
    assert.match(combined, /\n\nBEGIN ORIGINAL PACKET/);
  } finally {
    auditStore.close();
  }
});

test('snapshot CLI defaults to zero bytes while setting is absent', async () => {
  const dependencies = {
    settings: { values: {} },
    clock: () => NOW,
    readMachineLoad: () => { throw new Error('must not run'); }
  };
  assert.equal(await statusSnapshotTool.run(['node', 'status-snapshot'], dependencies), '');
  const json = JSON.parse(await statusSnapshotTool.run(['node', 'status-snapshot', '--json'], dependencies));
  assert.equal(json.enabled, false);
  assert.equal(json.setting.reason, 'SETTING_ABSENT');
});

test('automatic hook wrapper awaits status prepend for text and hook output', () => {
  const source = fs.readFileSync(path.join(ROOT, 'tools', 'agent-onboarding.js'), 'utf8');
  assert.match(source, /await prependStatus\(onboarding\.renderPacket\(packet\)/);
  /* WHAT THIS PINS IS THAT `rendered` REACHES THE ENVELOPE, not how it is
     punctuated on the way. The older spelling matched the exact argument
     `hookEnvelope(event.hook_event_name, rendered)`, so when f8f58c1 began
     prefixing a launch note -- a deliberate, correct change -- this test went
     red over formatting while the behaviour it exists to protect was intact.
     A source-grep test earns its keep only when it greps for the thing that
     would actually be a defect if it vanished. */
  assert.match(source, /hookEnvelope\(event\.hook_event_name,[^)]*rendered/);
  assert.match(source, /return rendered;/);
});

test('CLI node selector parsing is closed and deterministic', () => {
  assert.deepEqual(statusSnapshotTool.parseArgs([
    'node', 'status-snapshot', '--json', '--agent', 'codex', '--lane', 'r1232', '--host', 'machine-a'
  ]), {
    json: true,
    input: { agentId: 'codex', laneId: 'r1232', hostId: 'machine-a' }
  });
  assert.throws(() => statusSnapshotTool.parseArgs(['node', 'status-snapshot', '--force']), /Unknown/);
});

async function main() {
  let passed = 0;
  for (const [name, run] of cases) {
    try {
      await run();
      passed += 1;
    } catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    }
  }
  process.stdout.write(`status-injection tests passed: ${passed}/${cases.length}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
