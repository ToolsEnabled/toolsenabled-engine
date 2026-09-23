'use strict';

// Thin, dependency-injected Codex Cloud adapter for
// src/lib/cloud-agent/session.js. Every provider effect this file can reach
// is injected: there is no default network transport, so constructing or
// calling this adapter can never perform a live Codex Cloud call, sign in,
// push, create an environment, or apply a patch to a shared checkout on its
// own. A caller that wants real behaviour must supply `options.transport`;
// omitting it fails closed with CODEX_CLOUD_TRANSPORT_NOT_CONFIGURED.
//
// The one local process this file knows how to run is a bounded, read-only
// `codex --version` probe, reused from src/lib/proc/run.js (no shell, no
// argv interpolation, bounded output/time) purely as an optional
// capabilities hint. It is never on the path of submit/inspect/cancel/
// reconcile/fetchChangeManifest.

const procRun = require('../proc/run');
const { CloudAgentError } = require('../cloud-agent/errors');
const { SCHEMA_VERSION } = require('../cloud-agent/contract');

const PROVIDER_ID = 'codex-cloud';
const LOCAL_COMMAND = 'codex';
const VERSION_PROBE_ARGS = Object.freeze(['--version']);
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_MAX_BUFFER_BYTES = 8 * 1024;
const VERSION_PATTERN = /(\d+\.\d+\.\d+[A-Za-z0-9.-]*)/;
const DEFAULT_MAX_BYTE_BUDGET = 64 * 1024 * 1024;
const DEFAULT_MAX_TIME_BUDGET_MS = 6 * 60 * 60 * 1000;

// Codex Cloud's own task-status vocabulary is provider detail. This table is
// the only place that vocabulary is allowed to leak into the provider-neutral
// STATES enum; any status this adapter does not recognize maps to UNKNOWN --
// never guessed toward SUCCEEDED or FAILED.
const STATUS_MAP = Object.freeze({
  queued: 'SUBMITTED',
  // Observed live 2026-08-11 from `cloud list --json`, seconds after a real
  // `cloud exec` submission: a task the provider has accepted but not yet
  // started reports "pending". It was absent from this table, so every
  // freshly launched task read back as UNKNOWN -- the one state a caller
  // must not see for a submission that demonstrably succeeded.
  pending: 'SUBMITTED',
  in_progress: 'RUNNING',
  completed: 'SUCCEEDED',
  // Observed live from codex-cli 0.146.0 `cloud list --json`: a finished task
  // whose diff is ready for review reports "ready".
  ready: 'SUCCEEDED',
  failed: 'FAILED',
  error: 'FAILED',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED'
});

function mapStatus(rawStatus) {
  if (typeof rawStatus !== 'string') return 'UNKNOWN';
  return STATUS_MAP[rawStatus] || 'UNKNOWN';
}

function requireTransport(transport) {
  if (!transport || typeof transport !== 'object') {
    throw new CloudAgentError(
      'CODEX_CLOUD_TRANSPORT_NOT_CONFIGURED',
      'The codex-cloud adapter requires an injected transport; it never performs a live call by default.'
    );
  }
  return transport;
}

// Never throws. An unreadable probe has no localCli hint because the
// capabilities contract intentionally makes that hint optional.
function probeLocalCli(run) {
  let outcome;
  try {
    outcome = run(LOCAL_COMMAND, VERSION_PROBE_ARGS, {
      timeoutMs: VERSION_PROBE_TIMEOUT_MS,
      maxBufferBytes: VERSION_PROBE_MAX_BUFFER_BYTES
    });
  } catch {
    return undefined;
  }
  if (!outcome || outcome.status === procRun.RUN_STATUS.INDETERMINATE) {
    return undefined;
  }
  // A definite nonzero exit still proves that the executable was started;
  // it does not prove that the CLI is absent. Version output may be on either
  // stream, including for a CLI that rejects this version flag.
  const match = VERSION_PATTERN.exec(`${outcome.stdout || ''}\n${outcome.stderr || ''}`);
  return Object.freeze({ detected: true, version: match ? match[1] : null });
}

function fromRawTask(raw, request, fallbackTaskId) {
  const stamp = new Date().toISOString();
  if (!raw || typeof raw !== 'object') {
    return {
      schemaVersion: SCHEMA_VERSION,
      requestHash: request.requestHash,
      providerTaskId: fallbackTaskId || null,
      requestedModel: request.requiredModel,
      servedModel: null,
      state: 'UNKNOWN',
      createdAt: stamp,
      updatedAt: stamp,
      evidenceHashes: [],
      artifactManifest: []
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    requestHash: request.requestHash,
    providerTaskId: typeof raw.id === 'string' ? raw.id : (fallbackTaskId || null),
    requestedModel: request.requiredModel,
    servedModel: typeof raw.model === 'string' ? raw.model : null,
    state: mapStatus(raw.status),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : stamp,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : stamp,
    evidenceHashes: Array.isArray(raw.evidenceHashes) ? raw.evidenceHashes : [],
    // The inline manifest always starts empty here: the authoritative, budget
    // checked manifest comes only from fetchChangeManifest() below.
    artifactManifest: []
  };
}

function fromRawManifest(raw) {
  const entries = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.files) ? raw.files : null);
  if (!entries) {
    throw new CloudAgentError(
      'CODEX_CLOUD_CHANGE_MANIFEST_INDETERMINATE',
      'The Codex Cloud change-manifest response was missing its files array; no empty manifest was inferred.'
    );
  }
  return entries.map(entry => ({
    path: entry && entry.path,
    sha256: entry && entry.sha256,
    sizeBytes: entry && entry.sizeBytes
  }));
}

function createCodexCloudAdapter(options = {}) {
  const transport = options.transport || null;
  const run = typeof options.procRun === 'function' ? options.procRun : procRun.runChecked;
  const declaredModels = Array.isArray(options.declaredModels) ? Object.freeze([...options.declaredModels]) : Object.freeze([]);
  const maxByteBudget = Number.isSafeInteger(options.maxByteBudget) ? options.maxByteBudget : DEFAULT_MAX_BYTE_BUDGET;
  const maxTimeBudgetMs = Number.isSafeInteger(options.maxTimeBudgetMs) ? options.maxTimeBudgetMs : DEFAULT_MAX_TIME_BUDGET_MS;

  return Object.freeze({
    providerId: PROVIDER_ID,

    // No transport call: capabilities are either statically declared by the
    // caller or observed locally via the bounded version probe. Safe to call
    // before bindEnvironment and without cloud credentials.
    async capabilities() {
      const localCli = probeLocalCli(run);
      return {
        providerId: PROVIDER_ID,
        models: declaredModels,
        supportsCancel: true,
        maxByteBudget,
        maxTimeBudgetMs,
        ...(localCli === undefined ? {} : { localCli })
      };
    },

    async bindEnvironment(request) {
      const client = requireTransport(transport);
      const ack = await client.bindEnvironment({
        environment: request.environment,
        repository: request.repository,
        sourceRevision: request.sourceRevision,
        fileKeeperProof: request.fileKeeperProof
      });
      return { environmentRef: ack && ack.environmentRef };
    },

    async submit(request) {
      const client = requireTransport(transport);
      const raw = await client.createTask({
        environment: request.environment,
        sourceRevision: request.sourceRevision,
        fileKeeperProof: request.fileKeeperProof,
        idempotencyKey: request.idempotencyKey,
        model: request.requiredModel,
        taskHash: request.taskHash,
        pathAllowlist: request.pathAllowlist
      });
      return fromRawTask(raw, request);
    },

    async inspect(providerTaskId, request) {
      const client = requireTransport(transport);
      const raw = await client.getTask(providerTaskId);
      return fromRawTask(raw, request, providerTaskId);
    },

    async fetchChangeManifest(providerTaskId) {
      const client = requireTransport(transport);
      const raw = await client.getTaskChanges(providerTaskId);
      return fromRawManifest(raw);
    },

    async cancel(providerTaskId, request) {
      const client = requireTransport(transport);
      const raw = await client.cancelTask(providerTaskId);
      return fromRawTask(raw, request, providerTaskId);
    },

    // A null providerTaskId here means submit() itself was ambiguous (e.g. a
    // session-level timeout with no confirmed task id). A transport that can
    // look a task up by idempotencyKey gets a chance to resolve that; one
    // that cannot simply stays UNKNOWN, which fromRawTask(null, ...) already
    // reports honestly -- reconcile never guesses and never re-submits.
    async reconcile(providerTaskId, request) {
      const client = requireTransport(transport);
      if (providerTaskId) {
        return fromRawTask(await client.getTask(providerTaskId), request, providerTaskId);
      }
      if (typeof client.findTaskByIdempotencyKey === 'function') {
        const raw = await client.findTaskByIdempotencyKey(request.idempotencyKey);
        return fromRawTask(raw, request, null);
      }
      return fromRawTask(null, request, null);
    }
  });
}

module.exports = {
  PROVIDER_ID,
  createCodexCloudAdapter,
  mapStatus
};
