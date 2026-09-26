'use strict';

require('../lib/isolated-environment').activate('scheduler-provider');

// This legacy suite exercises required audit intent and refusal contracts.
const operationAudit = require('../../src/lib/operation-audit');
const requiredAuditPolicy = operationAudit.capturePolicy({ loadSettings: () => ({
  values: { 'audit.enabled': true }, provenance: { 'audit.enabled': { source: 'user' } }, rejected: []
}) });
operationAudit.withPolicy(requiredAuditPolicy, () => {
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStateStore } = require('../../src/lib/state-store');
const { SchedulerAdapterError } = require('../../src/lib/scheduler-adapter');
const { createSchedulerProvider } = require('../../src/lib/providers/scheduler');

function runtimePrincipal() { return 'S-1-5-21-111111111-222222222-333333333-1001'; }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-scheduler-provider-'));
let now = Date.UTC(2026, 6, 22, 12, 0, 0);
const store = createStateStore({
  file: path.join(root, 'state.sqlite3'),
  clock: () => now,
  ownerId: 'provider-test'
});
const tasks = new Map();
const mutations = [];
const auditEvents = [];
const failures = new Map();
const adapter = {
  ensure(spec, options = {}) {
    const failure = failures.get(`ensure:${spec.generation}`);
    if (failure) throw failure;
    const existing = tasks.get(spec.taskName);
    if (existing && existing.ownershipMarker !== spec.ownershipMarker) {
      throw new SchedulerAdapterError('SCHEDULER_FOREIGN_TASK', 'foreign collision', { retryable: false, observation: { state: 'foreign' } });
    }
    if (!existing) {
      options.beforeMutation({ operation: 'create', spec });
      mutations.push({ operation: 'create', generation: spec.generation });
      tasks.set(spec.taskName, spec);
      return { changed: true, observation: { state: 'present', exact: true } };
    }
    return { changed: false, observation: { state: 'present', exact: true } };
  },
  remove(spec, options = {}) {
    const failure = failures.get(`delete:${spec.generation}`);
    if (failure) throw failure;
    const existing = tasks.get(spec.taskName);
    if (!existing) return { changed: false, observation: { state: 'absent', exact: true } };
    if (existing.ownershipMarker !== spec.ownershipMarker) {
      throw new SchedulerAdapterError('SCHEDULER_FOREIGN_TASK', 'foreign collision', { retryable: false, observation: { state: 'foreign' } });
    }
    options.beforeMutation({ operation: 'delete', spec });
    mutations.push({ operation: 'delete', generation: spec.generation });
    tasks.delete(spec.taskName);
    return { changed: true, observation: { state: 'absent', exact: true } };
  }
};
const fakeAudit = {
  redact: value => String(value).replace(/secret/gi, 'REDACTED'),
  requireRecord(event, target, details) {
    auditEvents.push({ type: 'intent', event, target, details });
    return { durable: true };
  },
  record(event, target, details) { auditEvents.push({ type: 'record', event, target, details }); }
};
const provider = createSchedulerProvider({
  state: store,
  adapter,
  audit: fakeAudit,
  policy: { assertActive() {}, load: () => ({ limits: { maxScheduledJobs: 2 } }) },
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  runnerPath: path.join(root, 'job-runner.js'),
  principalId: 'S-1-5-21-111111111-222222222-333333333-1001',
  validateAction(action, args) {
    // FIXTURE ACTION CHANGED 2026-08-23: 'telegram.send' left
    // SUPPORTED_SCHEDULED_ACTIONS with the Telegram connector. 'gmail.send' is a
    // surviving external-write action with the same shape of use, so the scheduler
    // machinery under test is exercised exactly as before against an action the
    // allowlist actually contains.
    assert.equal(action, 'gmail.send');
    if (!args || typeof args.to !== 'string' || typeof args.subject !== 'string') throw new Error('invalid scheduled action args');
  }
});

function reconciliationFixture({ operation, spec, adapter: claimAdapter, completionError = null }) {
  const stats = { claimed: false, completeCalls: 0, completions: [], importOptions: null };
  const fakeStore = {
    importLegacyScheduler(options) { stats.importOptions = options; return { status: 'missing', records: 0 }; },
    claimSchedulerOutbox() {
      if (stats.claimed) return { claimed: false };
      stats.claimed = true;
      return {
        claimed: true,
        handle: { outboxId: 'scheduler-test-outbox', fence: 1, attempt: 1, ownerId: 'test', claimToken: 'test-token' },
        work: {
          outbox: { outboxId: 'scheduler-test-outbox', operation, attempt: 0 },
          registration: { jobId: spec.jobId, generation: spec.generation, spec }
        }
      };
    },
    completeSchedulerOutbox(_handle, outcome) {
      stats.completeCalls += 1;
      stats.completions.push(outcome);
      if (completionError) throw completionError;
      return { job: null };
    }
  };
  const fakeProvider = createSchedulerProvider({
    state: fakeStore,
    adapter: claimAdapter,
    audit: { redact: value => String(value), requireRecord: () => ({ durable: true }), record() {} },
    policy: { assertActive() {}, load: () => ({ limits: { maxScheduledJobs: 10 } }) },
    nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: path.join(root, 'mock-runner.js'),
    resolveCurrentPrincipalId: () => 'S-1-5-21-111111111-222222222-333333333-1001'
  });
  return { provider: fakeProvider, stats };
}

try {
  // Unsupported hosts must refuse before touching durable jobs or attempting
  // to discover a Windows identity. Injected adapters above remain portable.
  const unsupported = createSchedulerProvider({
    platform: 'linux',
    state: new Proxy({}, { get() { throw new Error('unsupported scheduler touched durable state'); } }),
    policy: { assertActive() {}, load: () => ({}) },
    validateAction() {},
    resolveCurrentPrincipalId() { throw new Error('unsupported scheduler queried Windows identity'); }
  });
  for (const [method, input] of [
    ['list', {}], ['reconcile', {}], ['remove', { name: 'unsupported' }],
    ['create', { name: 'unsupported', schedule: 'daily', action: 'gmail.send', args: {} }]
  ]) {
    assert.throws(() => unsupported[method](input), error =>
      error instanceof SchedulerAdapterError && error.code === 'SCHEDULER_PLATFORM_UNSUPPORTED'
      && error.retryable === false && /Windows Task Scheduler/.test(error.message));
  }

  let invalidActionTouchedHost = false;
  const validationFirstProvider = createSchedulerProvider({
    state: { importLegacyScheduler() { throw new Error('invalid input must not initialize scheduler state'); } },
    adapter: {},
    audit: fakeAudit,
    policy: { assertActive() {}, load: () => ({ limits: { maxScheduledJobs: 2 } }) },
    resolveCurrentPrincipalId() {
      invalidActionTouchedHost = true;
      throw new Error('invalid input must not resolve the Windows principal');
    }
  });
  assert.throws(
    () => validationFirstProvider.create({ name: 'invalid-action', schedule: 'daily', action: 'not.real' }),
    /not supported/
  );
  assert.equal(invalidActionTouchedHost, false, 'invalid actions are rejected before host-specific initialization');

  /* A SCHEDULED JOB'S args ARE THE TARGET TOOL'S OWN FLAT ARGUMENTS, so a
   * validation refusal must name one of ITS fields, not an envelope this
   * caller never wrote. providers/scheduler.js#validateAction shares the
   * exact bug and the exact fix as tool-registry.js#executeTool (see
   * schema-validator.js#propertyPath and tests/purchase-request-tool.test.js):
   * both validated a flat arguments object with root path '$.arguments',
   * naming a field ("$.arguments.subject") that gmail.send has no such name
   * for -- its own schema calls it `subject`, at the top level. This is real
   * scheduler.create input, not a stub: validationFirstProvider above passes
   * no validateAction override, so this exercises the actual production
   * function. gmail.send is one of SUPPORTED_SCHEDULED_ACTIONS, is
   * 'external-write' (required by validateAction), and requires `to` AND
   * `subject` -- only `subject` is omitted here on purpose. */
  assert.throws(
    () => validationFirstProvider.create({
      name: 'scheduled-send', schedule: 'daily', action: 'gmail.send', args: { to: 'owner@example.invalid' }
    }),
    error => error && error.name === 'SchemaValidationError' && error.code === 'INVALID_PARAMS'
      && error.message === 'Invalid input: subject: is required'
  );

  const created = provider.create({
    name: 'owner-digest', schedule: 'minutes', intervalMinutes: 5,
    action: 'gmail.send', args: { to: 'owner@example.invalid', subject: 'digest' }
  });
  assert.equal(created.job.providerState, 'registered');
  assert.equal(created.job.activeGeneration, 1);
  assert.equal(created.reconciliation.succeeded, 1);
  assert.equal(tasks.size, 1);
  assert.deepEqual(mutations, [{ operation: 'create', generation: 1 }]);
  assert.equal(auditEvents.filter(item => item.type === 'intent').length, 1, 'Every OS mutation has one durable pre-effect intent.');
  assert.doesNotMatch(JSON.stringify(created), /ownershipMarker|claimToken|nodePath|runnerPath/);

  const replay = provider.create({
    name: 'owner-digest', schedule: 'minutes', intervalMinutes: 5,
    action: 'gmail.send', args: { subject: 'digest', to: 'owner@example.invalid' }
  });
  assert.equal(replay.replayed, true, 'Canonical args key order replays the same desired job.');
  assert.equal(replay.reconciliation.processed, 0);
  assert.equal(mutations.length, 1);

  failures.set('ensure:2', new SchedulerAdapterError('SCHEDULER_FOREIGN_TASK', 'foreign collision', {
    retryable: false, observation: { state: 'foreign', exact: false }
  }));
  const failedUpdate = provider.create({
    name: 'owner-digest', schedule: 'hourly',
    action: 'gmail.send', args: { to: 'owner@example.invalid', subject: 'new digest' }
  });
  assert.equal(failedUpdate.job.generation, 2);
  assert.equal(failedUpdate.job.activeGeneration, 1, 'A failed replacement leaves the previous immutable generation active.');
  assert.equal(failedUpdate.job.providerState, 'error');
  assert.equal(tasks.size, 1);
  const gen1 = store.getSchedulerJob({ name: 'owner-digest' }).registrations.find(item => item.generation === 1);
  assert.equal(store.getSchedulerExecution({
    installationId: gen1.spec.installationId, jobId: gen1.jobId, generation: 1, ownershipMarker: gen1.ownershipMarker
  }).action, 'gmail.send');

  failures.delete('ensure:2');
  const recovered = provider.reconcile({ name: 'owner-digest', requeueErrors: true, limit: 8 });
  assert.equal(recovered.errors, 0);
  assert.equal(recovered.succeeded, 2, 'Recovery ensures gen2 and then removes retired gen1.');
  assert.equal(recovered.job.activeGeneration, 2);
  assert.equal(tasks.size, 1);
  assert.deepEqual(mutations.map(item => `${item.operation}:${item.generation}`), ['create:1', 'create:2', 'delete:1']);

  const beforeRemoveIntents = auditEvents.filter(item => item.type === 'intent').length;
  const removed = provider.remove({ name: 'owner-digest' });
  assert.equal(removed.removed, true);
  assert.equal(removed.job.activeGeneration, null);
  assert.equal(removed.job.providerState, 'absent');
  assert.equal(tasks.size, 0);
  assert.equal(auditEvents.filter(item => item.type === 'intent').length, beforeRemoveIntents + 1);
  assert.equal(provider.remove({ name: 'missing' }).removed, false);

  const uncertain = new SchedulerAdapterError('SCHEDULER_CREATE_UNCERTAIN', 'provider outcome unknown', {
    retryable: true, uncertain: true, observation: { state: 'unknown' }
  });
  failures.set('ensure:1', uncertain);
  const pending = provider.create({
    name: 'uncertain-job', schedule: 'daily', action: 'gmail.send', args: { to: 'owner@example.invalid', subject: 'x' }
  });
  assert.equal(pending.job.providerState, 'uncertain');
  assert.equal(pending.reconciliation.retrying, 1);
  failures.delete('ensure:1');
  assert.equal(provider.reconcile({ name: 'uncertain-job', limit: 2 }).processed, 0, 'Retry delay prevents a tight retry loop.');
  now += 3000;
  const retry = provider.reconcile({ name: 'uncertain-job', limit: 2 });
  assert.equal(retry.succeeded, 1);
  assert.equal(retry.job.providerState, 'registered');

  assert.throws(() => provider.create({
    name: 'bad-secret', schedule: 'daily', action: 'gmail.send',
    args: { to: 'owner@example.invalid', subject: 'safe', access_token: 'not-allowed' }
  }), error => error.code === 'SCHEDULER_SECRET_REJECTED');
  assert.equal(provider.list({ includeRemoved: true }).length, 2);

  // Schema-3 account names (and missing principals) are enriched only for a
  // deletion adapter call. The durable object stays non-executable, and an
  // ensure claim receives no such enrichment.
  const legacyDeletionSpec = {
    version: 1, installationId: 'a'.repeat(32), jobId: 'scheduler-job-legacy-delete', generation: 1,
    taskName: '\\ToolsEnabled-v2-aaaaaaaaaaaa-bbbbbbbbbbbbbbbb-g1', ownershipMarker: 'c'.repeat(64),
    nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: path.join(root, 'mock-runner.js'),
    principalId: 'DESKTOP\\legacy-user', schedule: 'hourly', intervalMinutes: null
  };
  let deletionAdapterSpec;
  const deletion = reconciliationFixture({
    operation: 'delete', spec: legacyDeletionSpec,
    adapter: {
      ensure() { throw new Error('ensure must not run'); },
      remove(spec) { deletionAdapterSpec = spec; return { changed: false, observation: { state: 'absent', exact: true } }; }
    }
  });
  assert.equal(deletion.provider.reconcile({ limit: 1 }).succeeded, 1);
  assert.equal(deletionAdapterSpec.principalId, 'S-1-5-21-111111111-222222222-333333333-1001');
  assert.equal(legacyDeletionSpec.principalId, 'DESKTOP\\legacy-user');
  assert.equal(legacyDeletionSpec.action, undefined);

  let ensureAdapterSpec;
  const malformedCode = new TypeError('strict adapter rejected an unbound ensure');
  malformedCode.code = 'invalid code with spaces';
  const unboundEnsure = reconciliationFixture({
    operation: 'ensure', spec: legacyDeletionSpec,
    adapter: {
      ensure(spec) { ensureAdapterSpec = spec; throw malformedCode; },
      remove() { throw new Error('remove must not run'); }
    }
  });
  const rejectedEnsure = unboundEnsure.provider.reconcile({ limit: 1 });
  assert.equal(ensureAdapterSpec.principalId, 'DESKTOP\\legacy-user', 'Ensure never receives principal enrichment.');
  assert.equal(rejectedEnsure.outcomes[0].code, 'SCHEDULER_ADAPTER_FAILED');
  assert.equal(unboundEnsure.stats.completions[0].code, 'SCHEDULER_ADAPTER_FAILED');

  // Digest/archive-bound pre-saga cleanup is visible, name-scoped, and records
  // a durable evidence-bound intent before an exact legacy deletion.
  {
    const legacyAudit = [];
    const legacyCalls = [];
    const digest = 'd'.repeat(64);
    const createdAtMs = Date.parse('2026-07-22T20:16:30');
    const legacyStore = {
      importLegacyScheduler() {
        return {
          status: 'already_imported', path: path.join(root, 'jobs.json'), digest,
          legacyTasks: [
            { name: 'legacy-exact', schedule: 'hourly', createdAtMs },
            { name: 'legacy-absent', schedule: 'daily', createdAtMs }
          ]
        };
      },
      getSchedulerJob() { return null; },
      claimSchedulerOutbox() { return { claimed: false }; }
    };
    const legacyProvider = createSchedulerProvider({
      state: legacyStore,
      adapter: {
        removeLegacy(spec, options) {
          legacyCalls.push(spec.name);
          if (spec.name === 'legacy-exact') {
            options.beforeMutation({ operation: 'delete', spec, observation: { evidenceHash: 'e'.repeat(64) } });
            return { changed: true, observation: { state: 'absent', exact: true } };
          }
          return { changed: false, observation: { state: 'absent', exact: true } };
        }
      },
      audit: {
        redact: value => String(value),
        requireRecord(event, target, details) { legacyAudit.push({ type: 'intent', event, target, details }); return { durable: true }; },
        record(event, target, details) { legacyAudit.push({ type: 'record', event, target, details }); }
      },
      policy: { assertActive() {}, load: () => ({ limits: { maxScheduledJobs: 10 } }) },
      nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: path.join(root, 'mock-runner.js'),
      principalId: runtimePrincipal(), principalName: 'DESKTOP\\owner', validateAction() {}
    });
    const globalCleanup = legacyProvider.reconcile({ limit: 1 });
    assert.deepEqual(legacyCalls, ['legacy-exact', 'legacy-absent']);
    assert.deepEqual({
      status: globalCleanup.legacyCleanup.status, total: globalCleanup.legacyCleanup.total,
      removed: globalCleanup.legacyCleanup.removed, absent: globalCleanup.legacyCleanup.absent
    }, { status: 'complete', total: 2, removed: 1, absent: 1 });
    const intent = legacyAudit.find(item => item.type === 'intent');
    assert.equal(intent.event, 'scheduler.legacy.adapter.intent');
    assert.equal(intent.details.sourceDigest, digest);
    assert.equal(intent.details.matcherVersion, 1);
    assert.match(intent.details.evidenceHash, /^[a-f0-9]{64}$/);

    legacyCalls.length = 0;
    const missing = legacyProvider.reconcile({ name: 'legacy-exact', limit: 1 });
    assert.equal(missing.found, false);
    assert.deepEqual(legacyCalls, ['legacy-exact'], 'A named reconcile never broadens cleanup to other archived names.');
    assert.equal(missing.legacyCleanup.total, 1);
    assert.equal(missing.legacyCleanup.removed, 1);
  }

  // Missing archive timestamps and foreign legacy definitions remain visible
  // conflicts and never reach a mutation callback.
  {
    let adapterCalls = 0;
    const conflictProvider = createSchedulerProvider({
      state: {
        importLegacyScheduler() {
          return { status: 'already_imported', path: 'jobs.json', digest: 'f'.repeat(64), legacyTasks: [
            { name: 'missing-evidence', schedule: 'daily', createdAtMs: null },
            { name: 'foreign-definition', schedule: 'hourly', createdAtMs: Date.now() }
          ] };
        },
        claimSchedulerOutbox() { return { claimed: false }; }
      },
      adapter: {
        removeLegacy() {
          adapterCalls += 1;
          throw new SchedulerAdapterError('SCHEDULER_LEGACY_TASK_CONFLICT', 'foreign', {
            retryable: false, observation: { state: 'foreign', reason: 'legacy-identity-mismatch' }
          });
        }
      },
      audit: { redact: value => String(value), requireRecord() { throw new Error('must not mutate'); }, record() {} },
      policy: { assertActive() {}, load: () => ({ limits: { maxScheduledJobs: 10 } }) },
      nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: path.join(root, 'mock-runner.js'),
      principalId: runtimePrincipal(), principalName: 'DESKTOP\\owner', validateAction() {}
    });
    const result = conflictProvider.reconcile({ limit: 1 });
    assert.equal(adapterCalls, 1, 'Missing createdAt evidence is rejected before adapter inspection.');
    assert.equal(result.legacyCleanup.status, 'attention_required');
    assert.equal(result.legacyCleanup.conflicts, 2);
    assert.deepEqual(result.legacyCleanup.tasks.map(item => item.state), ['conflict', 'conflict']);
  }

  // A lost success fence is an idempotent supersession. Other durable
  // completion failures propagate and are never mistaken for adapter errors or
  // completed a second time.
  const successfulAdapter = { ensure: () => ({ changed: true, observation: { state: 'present', exact: true } }), remove() {} };
  const fenceError = Object.assign(new Error('lost fence'), { code: 'SCHEDULER_OUTBOX_FENCE_LOST' });
  const fenced = reconciliationFixture({ operation: 'ensure', spec: { ...legacyDeletionSpec, principalId: runtimePrincipal() }, adapter: successfulAdapter, completionError: fenceError });
  assert.equal(fenced.provider.reconcile({ limit: 1 }).outcomes[0].outcome, 'superseded');
  assert.equal(fenced.stats.completeCalls, 1);
  const persistenceError = Object.assign(new Error('database I/O failed'), { code: 'SQLITE_IOERR' });
  const persistence = reconciliationFixture({ operation: 'ensure', spec: { ...legacyDeletionSpec, principalId: runtimePrincipal() }, adapter: successfulAdapter, completionError: persistenceError });
  assert.throws(() => persistence.provider.reconcile({ limit: 1 }), error => error === persistenceError);
  assert.equal(persistence.stats.completeCalls, 1);

  // Provider initialization is the production legacy-import entry point: it
  // resolves the canonical SID, validates the action through the current tool
  // schema, commits the job, and archives the exact legacy bytes.
  {
    const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsenabled-scheduler-provider-import-'));
    const importPath = path.join(importRoot, 'jobs.json');
    const importStore = createStateStore({ file: path.join(importRoot, 'state.sqlite3'), clock: () => now });
    const original = `${JSON.stringify({ version: 1, jobs: [{
      name: 'imported-owner', schedule: 'hourly', action: 'gmail.send',
      args: { to: 'owner@example.invalid', subject: 'from legacy startup' }, enabled: true,
      createdAt: '2026-07-01T00:00:00.000Z'
    }] }, null, 2)}\n`;
    fs.writeFileSync(importPath, original, 'utf8');
    const priorLegacyPath = process.env.TOOLSENABLED_SCHEDULER_LEGACY_PATH;
    process.env.TOOLSENABLED_SCHEDULER_LEGACY_PATH = importPath;
    let resolvedSid = 0; let validated = 0;
    try {
      const importingProvider = createSchedulerProvider({
        state: importStore,
        adapter: { ensure() { throw new Error('list must not reconcile'); }, remove() {} },
        audit: fakeAudit,
        policy: { assertActive() {}, load: () => ({ limits: { maxScheduledJobs: 10 } }) },
        nodePath: 'C:\\Program Files\\nodejs\\node.exe', runnerPath: path.join(importRoot, 'runner.js'),
        resolveCurrentPrincipalId() { resolvedSid += 1; return runtimePrincipal(); },
        validateAction(action, args) {
          validated += 1;
          assert.equal(action, 'gmail.send');
          assert.deepEqual(args, { to: 'owner@example.invalid', subject: 'from legacy startup' });
        }
      });
      assert.deepEqual(importingProvider.list().map(item => item.name), ['imported-owner']);
      assert.equal(resolvedSid, 1);
      assert.equal(validated, 1);
      const imported = importStore.getSchedulerJob({ name: 'imported-owner' });
      assert.equal(imported.registration.spec.principalId, runtimePrincipal());
      assert.equal(fs.existsSync(importPath), false);
      const archives = fs.readdirSync(importRoot).filter(name => /^jobs\.json\.legacy-[a-f0-9]{16}$/.test(name));
      assert.equal(archives.length, 1);
      assert.equal(fs.readFileSync(path.join(importRoot, archives[0]), 'utf8'), original);
    } finally {
      if (priorLegacyPath === undefined) delete process.env.TOOLSENABLED_SCHEDULER_LEGACY_PATH;
      else process.env.TOOLSENABLED_SCHEDULER_LEGACY_PATH = priorLegacyPath;
      importStore.close();
      fs.rmSync(importRoot, { recursive: true, force: true });
    }
  }

  process.stdout.write('scheduler provider tests passed\n');
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}

});
