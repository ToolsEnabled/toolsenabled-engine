'use strict';

// R1177 S1: focused tests for src/lib/providers/codex-cloud.js. Plain
// `node tests/codex-cloud-provider.test.js`. The local `codex --version`
// probe is always exercised through an injected fake `procRun`; this suite
// never spawns a real process and never needs the codex CLI installed.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createCodexCloudAdapter, mapStatus, PROVIDER_ID } = require('../src/lib/providers/codex-cloud');
const { CloudAgentSession } = require('../src/lib/cloud-agent/session');
const { CloudAgentError } = require('../src/lib/cloud-agent/errors');
const contract = require('../src/lib/cloud-agent/contract');
const realProcRun = require('../src/lib/proc/run');

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };
const asyncCheck = async (label, fn) => { await fn(); checks += 1; void label; };

async function rejectsWithCode(promise, expectedCode) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof CloudAgentError, `expected a CloudAgentError, got ${error && error.constructor && error.constructor.name}`);
    assert.equal(error.code, expectedCode, `expected code ${expectedCode}, got ${error.code}: ${error.message}`);
    return true;
  });
}

const hex = (char, length = 64) => char.repeat(length);
const opaque = (prefix, char = 'a') => `${prefix}${char.repeat(20)}`;

// Raw, unvalidated shape -- for CloudAgentSession.bindEnvironment(), which
// validates its own input (and would reject an already-validated object's
// extra requestHash field as an unlisted property).
function rawRequestInput(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'codex-cloud',
    environment: 'env-main',
    repository: { rootId: 'toolsenabled' },
    sourceRevision: hex('a', 40),
    fileKeeperProof: { proofId: opaque('fkp-', 'b'), treeSha256: hex('c') },
    idempotencyKey: opaque('idem-', 'd'),
    requiredModel: 'gpt-test-model',
    taskHash: hex('e'),
    pathAllowlist: ['src/**'],
    byteBudget: 4096,
    timeBudgetMs: 5000,
    ...overrides
  };
}

// Validated, frozen shape -- for calling an adapter operation directly, the
// same way CloudAgentSession calls it internally with its own bound request.
function baseRequestInput(overrides = {}) {
  return contract.validateRequest(rawRequestInput(overrides));
}

function neverCalled(name) {
  return async (...args) => { throw new Error(`${name} must not be called: ${JSON.stringify(args)}`); };
}

(async () => {
  // --- provider status mapping ------------------------------------------------

  check('mapStatus maps every declared Codex Cloud status to a provider-neutral state', () => {
    assert.equal(mapStatus('queued'), 'SUBMITTED');
    assert.equal(mapStatus('in_progress'), 'RUNNING');
    assert.equal(mapStatus('completed'), 'SUCCEEDED');
    assert.equal(mapStatus('failed'), 'FAILED');
    assert.equal(mapStatus('error'), 'FAILED');
    assert.equal(mapStatus('cancelled'), 'CANCELLED');
    assert.equal(mapStatus('canceled'), 'CANCELLED');
  });

  check('mapStatus never guesses: an unrecognized or missing status maps to UNKNOWN', () => {
    assert.equal(mapStatus('some_future_status'), 'UNKNOWN');
    assert.equal(mapStatus(undefined), 'UNKNOWN');
    assert.equal(mapStatus(null), 'UNKNOWN');
    assert.equal(mapStatus(42), 'UNKNOWN');
  });

  // --- fail-closed by default: no injected transport, no live call -----------

  await asyncCheck('every transport-backed operation fails closed without an injected transport', async () => {
    const adapter = createCodexCloudAdapter({ procRun: () => ({ status: 'failure' }) });
    const request = baseRequestInput();
    await rejectsWithCode(adapter.bindEnvironment(request), 'CODEX_CLOUD_TRANSPORT_NOT_CONFIGURED');
    await rejectsWithCode(adapter.submit(request), 'CODEX_CLOUD_TRANSPORT_NOT_CONFIGURED');
    await rejectsWithCode(adapter.inspect(opaque('task-'), request), 'CODEX_CLOUD_TRANSPORT_NOT_CONFIGURED');
    await rejectsWithCode(adapter.fetchChangeManifest(opaque('task-'), request), 'CODEX_CLOUD_TRANSPORT_NOT_CONFIGURED');
    await rejectsWithCode(adapter.cancel(opaque('task-'), request), 'CODEX_CLOUD_TRANSPORT_NOT_CONFIGURED');
    await rejectsWithCode(adapter.reconcile(opaque('task-'), request), 'CODEX_CLOUD_TRANSPORT_NOT_CONFIGURED');
  });

  await asyncCheck('capabilities() never requires a transport and never performs a network call', async () => {
    const adapter = createCodexCloudAdapter({ procRun: () => ({ status: 'failure' }) });
    const caps = await adapter.capabilities();
    assert.equal(caps.providerId, PROVIDER_ID);
  });

  // --- capabilities(): declared models + bounded local CLI probe --------------

  await asyncCheck('capabilities() reports declared models and a detected local CLI version', async () => {
    let probeArgs = null;
    const fakeProcRun = (command, args, opts) => {
      probeArgs = { command, args, opts };
      return { status: realProcRun.RUN_STATUS.SUCCESS, exitCode: 0, stdout: 'codex-cli 1.4.0\n', stderr: '', durationMs: 5 };
    };
    const adapter = createCodexCloudAdapter({ procRun: fakeProcRun, declaredModels: ['gpt-test-model', 'gpt-test-model-mini'] });
    const caps = await adapter.capabilities();
    assert.deepEqual([...caps.models].sort(), ['gpt-test-model', 'gpt-test-model-mini']);
    assert.deepEqual(caps.localCli, { detected: true, version: '1.4.0' });

    // No shell, explicit argv only, bounded time and output -- the exact
    // safety rules the owning contract requires of any local child process.
    assert.equal(probeArgs.command, 'codex');
    assert.deepEqual(probeArgs.args, ['--version']);
    assert.equal(typeof probeArgs.opts.timeoutMs, 'number');
    assert.ok(probeArgs.opts.timeoutMs > 0 && probeArgs.opts.timeoutMs <= 30_000);
    assert.equal(typeof probeArgs.opts.maxBufferBytes, 'number');
    assert.ok(probeArgs.opts.maxBufferBytes > 0 && probeArgs.opts.maxBufferBytes <= 1024 * 1024);
    assert.equal('shell' in probeArgs.opts, false, 'the adapter must not itself select a shell mode; proc/run.js always forces shell:false');
  });

  await asyncCheck('capabilities() reports a detected local CLI with unknown version after a definite nonzero exit', async () => {
    const adapter = createCodexCloudAdapter({ procRun: () => ({ status: realProcRun.RUN_STATUS.FAILURE, exitCode: 1, stdout: '', stderr: 'not found' }) });
    const caps = await adapter.capabilities();
    // RUN_STATUS.FAILURE is emitted only after the executable actually starts
    // and exits nonzero. Spawn failures and unreadable outcomes are
    // INDETERMINATE, exercised immediately below. Do not collapse these two
    // states into the false claim that no local CLI was detected.
    assert.deepEqual(caps.localCli, { detected: true, version: null });
  });

  await asyncCheck('capabilities() omits the local CLI hint when the probe is INDETERMINATE', async () => {
    // Exercises the real proc/run.js three-valued result shape directly: a
    // timeout or an output-limit kill is RUN_STATUS.INDETERMINATE, distinct
    // from both SUCCESS and FAILURE, and this adapter must not treat it as a
    // detected CLI.
    const timedOut = () => realProcRun.runChecked('__nonexistent-codex-cloud-test-binary__', ['--version'], { timeoutMs: 50 });
    const outcome = timedOut();
    assert.equal(outcome.status, realProcRun.RUN_STATUS.INDETERMINATE, 'sanity check on the shared runner this adapter reuses');

    const adapter = createCodexCloudAdapter({ procRun: () => outcome });
    const caps = await adapter.capabilities();
    assert.equal(Object.hasOwn(caps, 'localCli'), false,
      'an unreadable probe must remain distinct from a definite not-detected answer');
  });

  await asyncCheck('capabilities() omits the local CLI hint when procRun throws', async () => {
    const adapter = createCodexCloudAdapter({ procRun: () => { throw new Error('boom'); } });
    const caps = await adapter.capabilities();
    assert.equal(Object.hasOwn(caps, 'localCli'), false);
  });

  // --- field translation into the injected transport ---------------------------

  await asyncCheck('bindEnvironment() forwards exactly the binding fields FileKeeper/the request contract require', async () => {
    let received = null;
    const transport = {
      async bindEnvironment(payload) { received = payload; return { environmentRef: opaque('envref-') }; }
    };
    const adapter = createCodexCloudAdapter({ transport });
    const request = baseRequestInput();
    const ack = await adapter.bindEnvironment(request);
    assert.deepEqual(received, {
      environment: request.environment,
      repository: request.repository,
      sourceRevision: request.sourceRevision,
      fileKeeperProof: request.fileKeeperProof
    });
    assert.match(ack.environmentRef, /^envref-/);
  });

  await asyncCheck('submit() forwards the idempotency key, exact required model, taskHash, and pathAllowlist', async () => {
    let received = null;
    const transport = {
      async createTask(payload) { received = payload; return { id: opaque('task-'), status: 'queued' }; }
    };
    const adapter = createCodexCloudAdapter({ transport });
    const request = baseRequestInput();
    const result = await adapter.submit(request);
    assert.equal(received.idempotencyKey, request.idempotencyKey);
    assert.equal(received.model, request.requiredModel);
    assert.equal(received.taskHash, request.taskHash);
    assert.deepEqual(received.pathAllowlist, request.pathAllowlist);
    assert.equal(result.schemaVersion, contract.SCHEMA_VERSION);
    assert.equal(result.requestHash, request.requestHash);
    assert.equal(result.state, 'SUBMITTED');
  });

  await asyncCheck('a submit() result validates against the provider-neutral CloudAgentResult contract', async () => {
    const transport = { async createTask() { return { id: opaque('task-'), status: 'queued' }; } };
    const adapter = createCodexCloudAdapter({ transport });
    const request = baseRequestInput();
    const raw = await adapter.submit(request);
    const validated = contract.validateResult(raw);
    contract.assertResultMatchesRequest(request, validated);
  });

  await asyncCheck('inspect() and cancel() report the transport-provided model and mapped status', async () => {
    const transport = {
      async getTask(id) { return { id, status: 'completed', model: 'gpt-test-model', evidenceHashes: [hex('7')] }; },
      async cancelTask(id) { return { id, status: 'cancelled' }; }
    };
    const adapter = createCodexCloudAdapter({ transport });
    const request = baseRequestInput();
    const inspected = await adapter.inspect(opaque('task-'), request);
    assert.equal(inspected.state, 'SUCCEEDED');
    assert.equal(inspected.servedModel, 'gpt-test-model');
    assert.deepEqual(inspected.evidenceHashes, [hex('7')]);

    const cancelled = await adapter.cancel(opaque('task-'), request);
    assert.equal(cancelled.state, 'CANCELLED');
  });

  await asyncCheck('fetchChangeManifest() accepts both a bare array and a {files: [...]} envelope', async () => {
    const entry = { path: 'src/foo.js', sha256: hex('9'), sizeBytes: 3 };
    const arrayTransport = { async getTaskChanges() { return [entry]; } };
    const wrappedTransport = { async getTaskChanges() { return { files: [entry] }; } };
    const request = baseRequestInput();

    const fromArray = await createCodexCloudAdapter({ transport: arrayTransport }).fetchChangeManifest(opaque('task-'), request);
    const fromWrapped = await createCodexCloudAdapter({ transport: wrappedTransport }).fetchChangeManifest(opaque('task-'), request);
    assert.deepEqual(contract.validateManifest(fromArray), contract.validateManifest(fromWrapped));
  });

  await asyncCheck('fetchChangeManifest() refuses a missing files array instead of inferring an empty manifest', async () => {
    const transport = { async getTaskChanges() { return {}; } };
    const adapter = createCodexCloudAdapter({ transport });
    await rejectsWithCode(adapter.fetchChangeManifest(opaque('task-')), 'CODEX_CLOUD_CHANGE_MANIFEST_INDETERMINATE');
  });

  // --- reconcile() with an ambiguous (null) providerTaskId ----------------------

  await asyncCheck('reconcile() with a known providerTaskId re-inspects the task and never touches createTask', async () => {
    const transport = {
      createTask: neverCalled('createTask'),
      async getTask(id) { return { id, status: 'completed', model: 'gpt-test-model', evidenceHashes: [hex('a')] }; }
    };
    const adapter = createCodexCloudAdapter({ transport });
    const request = baseRequestInput();
    const result = await adapter.reconcile(opaque('task-'), request);
    assert.equal(result.state, 'SUCCEEDED');
  });

  await asyncCheck('reconcile() with a null providerTaskId uses idempotency-key lookup when the transport supports it', async () => {
    let lookedUpKey = null;
    const transport = {
      createTask: neverCalled('createTask'),
      async findTaskByIdempotencyKey(key) { lookedUpKey = key; return { id: opaque('task-'), status: 'in_progress' }; }
    };
    const adapter = createCodexCloudAdapter({ transport });
    const request = baseRequestInput();
    const result = await adapter.reconcile(null, request);
    assert.equal(lookedUpKey, request.idempotencyKey);
    assert.equal(result.state, 'RUNNING');
  });

  await asyncCheck('reconcile() with a null providerTaskId and no lookup capability stays UNKNOWN, never re-submits', async () => {
    const transport = { createTask: neverCalled('createTask') };
    const adapter = createCodexCloudAdapter({ transport });
    const request = baseRequestInput();
    const raw = await adapter.reconcile(null, request);
    const validated = contract.validateResult(raw);
    assert.equal(validated.state, 'UNKNOWN');
    assert.equal(validated.providerTaskId, null);
  });

  // --- end-to-end wiring through CloudAgentSession ------------------------------

  await asyncCheck('the adapter wires into CloudAgentSession for a full bind -> submit -> inspect -> reconcile run', async () => {
    const tasks = new Map();
    const transport = {
      async bindEnvironment() { return { environmentRef: opaque('envref-') }; },
      async createTask(payload) {
        const id = opaque('task-', 'e');
        tasks.set(id, { id, status: 'queued', model: null });
        return tasks.get(id);
      },
      async getTask(id) { return tasks.get(id); },
      async getTaskChanges() { return [{ path: 'src/changed.js', sha256: hex('3'), sizeBytes: 9 }]; }
    };
    const adapter = createCodexCloudAdapter({ transport });
    const session = new CloudAgentSession({ adapter });

    await session.bindEnvironment(rawRequestInput());
    const submitted = await session.submit();
    const taskId = submitted.result.providerTaskId;
    Object.assign(tasks.get(taskId), { status: 'completed', model: 'gpt-test-model', evidenceHashes: [hex('4')] });

    const inspected = await session.inspect();
    assert.equal(inspected.state, 'SUCCEEDED');
    const manifest = await session.fetchChangeManifest();
    assert.deepEqual(manifest.map(entry => entry.path), ['src/changed.js']);

    const reconciled = await session.reconcile();
    assert.equal(reconciled.reconciled, true);
    assert.equal(reconciled.canAdvance, true);
  });

  await asyncCheck('a served model different from the request is surfaced as a blocked (non-advanceable) reconciliation, end to end', async () => {
    const tasks = new Map();
    const transport = {
      async bindEnvironment() { return { environmentRef: opaque('envref-') }; },
      async createTask() {
        const id = opaque('task-', 'f');
        tasks.set(id, { id, status: 'queued', model: null });
        return tasks.get(id);
      },
      async getTask(id) {
        Object.assign(tasks.get(id), { status: 'completed', model: 'an-unrequested-model', evidenceHashes: [hex('5')] });
        return tasks.get(id);
      },
      async getTaskChanges() { return []; }
    };
    const adapter = createCodexCloudAdapter({ transport });
    const session = new CloudAgentSession({ adapter });
    await session.bindEnvironment(rawRequestInput());
    await session.submit();
    const reconciled = await session.reconcile();
    assert.equal(reconciled.blockedReason, 'MODEL_MISMATCH');
    assert.equal(reconciled.canAdvance, false);
  });

  // --- zero checkout-write/apply capability + child-process safety -------------

  check('codex-cloud.js never references a filesystem write, git apply, shell mode, or ad-hoc child process spawn', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'providers', 'codex-cloud.js'), 'utf8');
    const forbidden = [/\bfs\.(?:write|append|rm|unlink|copy)/i, /\bgit\s+apply\b/i, /child_process/, /\bexecSync\b/, /\bspawn\(/, /shell:\s*true/];
    for (const pattern of forbidden) {
      assert.equal(pattern.test(source), false, `codex-cloud.js must not match ${pattern}`);
    }
    // The only local command this file may name, and only with a fixed,
    // literal argv array -- never a template literal or string concatenation
    // that could smuggle interpolation into an executable name or flag.
    assert.match(source, /LOCAL_COMMAND = 'codex'/);
    assert.match(source, /VERSION_PROBE_ARGS = Object\.freeze\(\['--version'\]\)/);
  });

  check('the default local probe is the shared, already-hardened proc/run.js#runChecked, not a bespoke spawn', () => {
    const adapter = createCodexCloudAdapter({ transport: {} });
    void adapter;
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'providers', 'codex-cloud.js'), 'utf8');
    assert.match(source, /require\(['"]\.\.\/proc\/run['"]\)/);
    assert.match(source, /procRun\.runChecked/);
  });

  console.log(`codex-cloud provider tests passed (${checks} checks: status mapping, fail-closed transport, bounded local CLI probe with timeout/truncation absorption, request field translation, ambiguous-reconcile idempotency-key lookup, end-to-end CloudAgentSession wiring, and zero checkout-write/apply capability).`);
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
