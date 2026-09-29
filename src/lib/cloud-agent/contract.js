'use strict';

// R1177 S1: provider-neutral cloud-agent contract. Pure data validation --
// no fs, no network, no child process, no provider knowledge. Every exported
// validator returns a frozen, closed-object snapshot (unknown or
// non-enumerable/getter fields are rejected, not silently dropped), so a
// value that survives validation is safe to treat as immutable evidence.
//
// FileKeeper custody proofs are consumed here only as an opaque, bounded
// reference (proofId + treeSha256). This module never calls into
// @toolsenabled/internal-vcs; verifying a proof's authenticity is the
// custody gateway's job (S2's lane), not this provider-neutral contract's.

const crypto = require('node:crypto');
const { CloudAgentError } = require('./errors');

const SCHEMA_VERSION = 1;
const HASH_DOMAIN = 'toolsenabled.cloud-agent-contract.v1';

const STATES = Object.freeze(['UNBOUND', 'READY', 'SUBMITTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']);
const STATE_SET = new Set(STATES);
const TERMINAL_STATES = Object.freeze(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const TERMINAL_SET = new Set(TERMINAL_STATES);

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_SHA1 = /^[a-f0-9]{40}$/;
const ID = /^[a-z][a-z0-9._-]{1,63}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/;
const ARTIFACT_PATH = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,198}[A-Za-z0-9_-])?$/;
const ALLOWLIST_ENTRY = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,196}[A-Za-z0-9_-])?(?:\/\*\*)?$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CLI_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;

const MAX_ALLOWLIST_ENTRIES = 256;
const MAX_MANIFEST_ENTRIES = 4096;
const MAX_EVIDENCE_HASHES = 64;
const MAX_BYTE_BUDGET = 512 * 1024 * 1024;
const MAX_TIME_BUDGET_MS = 24 * 60 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_MODELS_DECLARED = 128;

function fail(code, message) { throw new CloudAgentError(code, message); }

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// Closed-object validation: only own, enumerable, plain data properties are
// accepted. A getter, a prototype trick, or an unlisted extra field fails
// validation instead of being silently ignored or evaluated for a side
// effect.
function closedObject(value, keys, required, label) {
  if (!isPlainObject(value)) fail('CLOUD_AGENT_CONTRACT_INVALID', `${label} must be a plain object.`);
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    fail('CLOUD_AGENT_CONTRACT_INVALID', `${label} must be a plain object.`);
  }
  if (ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))
      || required.some(key => !ownKeys.includes(key))) {
    fail('CLOUD_AGENT_CONTRACT_INVALID', `${label} has unsupported or missing fields.`);
  }
  const snapshot = {};
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('CLOUD_AGENT_CONTRACT_INVALID', `${label} must contain only enumerable data fields.`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function arrayOf(value, label, { min = 0, max = 1024 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail('CLOUD_AGENT_CONTRACT_INVALID', `${label} is invalid.`);
  }
  return [...value];
}

function boundedString(value, pattern, label, maxLength = 200) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || !pattern.test(value)) {
    fail('CLOUD_AGENT_CONTRACT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function boundedInteger(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('CLOUD_AGENT_CONTRACT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function boundedBoolean(value, label) {
  if (typeof value !== 'boolean') fail('CLOUD_AGENT_CONTRACT_INVALID', `${label} must be a boolean.`);
  return value;
}

function oneOf(value, values, label) {
  if (!values.includes(value)) fail('CLOUD_AGENT_CONTRACT_INVALID', `${label} is invalid.`);
  return value;
}

function sortedUniqueStrings(value, pattern, label, { min = 0, max = 256, maxLength = 240 } = {}) {
  const items = arrayOf(value, label, { min, max }).map((item, index) => boundedString(item, pattern, `${label}[${index}]`, maxLength));
  if (new Set(items).size !== items.length) fail('CLOUD_AGENT_CONTRACT_INVALID', `${label} contains duplicates.`);
  return Object.freeze([...items].sort());
}

function rejectParentSegments(paths, label) {
  for (const candidate of paths) {
    const withoutWildcard = candidate.endsWith('/**') ? candidate.slice(0, -3) : candidate;
    if (withoutWildcard.split('/').includes('..')) {
      fail('CLOUD_AGENT_CONTRACT_INVALID', `${label} may not contain a ".." path segment.`);
    }
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(kind, value) {
  return crypto.createHash('sha256').update(`${HASH_DOMAIN}\0${kind}\0${stableStringify(value)}`).digest('hex');
}

function isKnownState(value) { return typeof value === 'string' && STATE_SET.has(value); }
function isTerminalState(value) { return TERMINAL_SET.has(value); }

// --- CloudAgentRequest -----------------------------------------------------

function repository(value) {
  const snapshot = closedObject(value, ['rootId'], ['rootId'], 'repository');
  return Object.freeze({ rootId: boundedString(snapshot.rootId, ID, 'repository.rootId', 64) });
}

function fileKeeperProof(value) {
  const snapshot = closedObject(value, ['proofId', 'treeSha256'], ['proofId', 'treeSha256'], 'fileKeeperProof');
  return Object.freeze({
    proofId: boundedString(snapshot.proofId, OPAQUE, 'fileKeeperProof.proofId', 128),
    treeSha256: boundedString(snapshot.treeSha256, SHA256, 'fileKeeperProof.treeSha256', 64)
  });
}

const REQUEST_FIELDS = Object.freeze([
  'schemaVersion', 'provider', 'environment', 'repository', 'sourceRevision', 'fileKeeperProof',
  'idempotencyKey', 'requiredModel', 'taskHash', 'pathAllowlist', 'byteBudget', 'timeBudgetMs'
]);

function validateRequest(value) {
  const snapshot = closedObject(value, REQUEST_FIELDS, REQUEST_FIELDS, 'CloudAgentRequest');
  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    fail('CLOUD_AGENT_CONTRACT_VERSION_UNSUPPORTED', 'CloudAgentRequest schema version is unsupported.');
  }
  const output = {
    schemaVersion: SCHEMA_VERSION,
    provider: boundedString(snapshot.provider, ID, 'provider', 64),
    environment: boundedString(snapshot.environment, ID, 'environment', 64),
    repository: repository(snapshot.repository),
    sourceRevision: boundedString(snapshot.sourceRevision, GIT_SHA1, 'sourceRevision', 40),
    fileKeeperProof: fileKeeperProof(snapshot.fileKeeperProof),
    idempotencyKey: boundedString(snapshot.idempotencyKey, OPAQUE, 'idempotencyKey', 128),
    requiredModel: boundedString(snapshot.requiredModel, MODEL_ID, 'requiredModel', 80),
    taskHash: boundedString(snapshot.taskHash, SHA256, 'taskHash', 64),
    pathAllowlist: sortedUniqueStrings(snapshot.pathAllowlist, ALLOWLIST_ENTRY, 'pathAllowlist', { min: 1, max: MAX_ALLOWLIST_ENTRIES }),
    byteBudget: boundedInteger(snapshot.byteBudget, 1, MAX_BYTE_BUDGET, 'byteBudget'),
    timeBudgetMs: boundedInteger(snapshot.timeBudgetMs, 1000, MAX_TIME_BUDGET_MS, 'timeBudgetMs')
  };
  rejectParentSegments(output.pathAllowlist, 'pathAllowlist');
  return Object.freeze({ ...output, requestHash: digest('CloudAgentRequest', output) });
}

// --- CloudAgentResult --------------------------------------------------------

function artifactEntry(value, index) {
  const snapshot = closedObject(value, ['path', 'sha256', 'sizeBytes'], ['path', 'sha256', 'sizeBytes'], `artifactManifest[${index}]`);
  const entryPath = boundedString(snapshot.path, ARTIFACT_PATH, `artifactManifest[${index}].path`, 200);
  if (entryPath.split('/').includes('..')) fail('CLOUD_AGENT_CONTRACT_INVALID', `artifactManifest[${index}].path may not contain a ".." segment.`);
  return Object.freeze({
    path: entryPath,
    sha256: boundedString(snapshot.sha256, SHA256, `artifactManifest[${index}].sha256`, 64),
    sizeBytes: boundedInteger(snapshot.sizeBytes, 0, MAX_ARTIFACT_BYTES, `artifactManifest[${index}].sizeBytes`)
  });
}

function validateManifest(value) {
  const entries = arrayOf(value, 'ChangeManifest', { min: 0, max: MAX_MANIFEST_ENTRIES }).map(artifactEntry);
  const paths = entries.map(entry => entry.path);
  if (new Set(paths).size !== paths.length) fail('CLOUD_AGENT_CONTRACT_INVALID', 'ChangeManifest paths must be unique.');
  return Object.freeze([...entries].sort((a, b) => a.path.localeCompare(b.path)));
}

function matchesAllowlist(candidatePath, allowlist) {
  return allowlist.some(pattern => {
    if (pattern.endsWith('/**')) {
      const prefix = pattern.slice(0, -3);
      return candidatePath === prefix || candidatePath.startsWith(`${prefix}/`);
    }
    return candidatePath === pattern;
  });
}

function assertManifestWithinBudget(request, manifest) {
  let totalBytes = 0;
  for (const entry of manifest) {
    if (!matchesAllowlist(entry.path, request.pathAllowlist)) {
      fail('CLOUD_AGENT_MANIFEST_PATH_DENIED', `ChangeManifest path "${entry.path}" is outside the request's path allowlist.`);
    }
    totalBytes += entry.sizeBytes;
  }
  if (totalBytes > request.byteBudget) {
    fail('CLOUD_AGENT_MANIFEST_BUDGET_EXCEEDED', `ChangeManifest totals ${totalBytes} bytes, exceeding the request byteBudget of ${request.byteBudget}.`);
  }
  return true;
}

const RESULT_FIELDS = Object.freeze([
  'schemaVersion', 'requestHash', 'providerTaskId', 'requestedModel', 'servedModel', 'state',
  'createdAt', 'updatedAt', 'evidenceHashes', 'artifactManifest'
]);

function validateResult(value) {
  const snapshot = closedObject(value, RESULT_FIELDS, RESULT_FIELDS, 'CloudAgentResult');
  if (snapshot.schemaVersion !== SCHEMA_VERSION) {
    fail('CLOUD_AGENT_CONTRACT_VERSION_UNSUPPORTED', 'CloudAgentResult schema version is unsupported.');
  }
  const state = oneOf(snapshot.state, STATES, 'state');

  let providerTaskId;
  if (snapshot.providerTaskId === null) {
    if (state !== 'UNKNOWN') fail('CLOUD_AGENT_CONTRACT_INVALID', 'providerTaskId may only be null while state is UNKNOWN.');
    providerTaskId = null;
  } else {
    providerTaskId = boundedString(snapshot.providerTaskId, OPAQUE, 'providerTaskId', 128);
  }

  const output = {
    schemaVersion: SCHEMA_VERSION,
    requestHash: boundedString(snapshot.requestHash, SHA256, 'requestHash', 64),
    providerTaskId,
    requestedModel: boundedString(snapshot.requestedModel, MODEL_ID, 'requestedModel', 80),
    servedModel: snapshot.servedModel === null ? null : boundedString(snapshot.servedModel, MODEL_ID, 'servedModel', 80),
    state,
    createdAt: boundedString(snapshot.createdAt, ISO_TIMESTAMP, 'createdAt', 32),
    updatedAt: boundedString(snapshot.updatedAt, ISO_TIMESTAMP, 'updatedAt', 32),
    evidenceHashes: sortedUniqueStrings(snapshot.evidenceHashes, SHA256, 'evidenceHashes', { min: 0, max: MAX_EVIDENCE_HASHES, maxLength: 64 }),
    artifactManifest: validateManifest(snapshot.artifactManifest)
  };
  return Object.freeze({ ...output, resultHash: digest('CloudAgentResult', output) });
}

function assertResultMatchesRequest(request, result) {
  // This assertion is also exported as a standalone gate. Refuse malformed
  // bindings before comparing them: otherwise two absent fields compare equal
  // and an unvalidated `{}` request/result pair is reported as a match.
  boundedString(request && request.requestHash, SHA256, 'request.requestHash', 64);
  boundedString(result && result.requestHash, SHA256, 'result.requestHash', 64);
  boundedString(request && request.requiredModel, MODEL_ID, 'request.requiredModel', 80);
  boundedString(result && result.requestedModel, MODEL_ID, 'result.requestedModel', 80);
  if (result.requestHash !== request.requestHash) {
    fail('CLOUD_AGENT_REQUEST_MISMATCH', 'Result does not bind the exact originating request.');
  }
  if (result.requestedModel !== request.requiredModel) {
    fail('CLOUD_AGENT_REQUEST_MISMATCH', 'Result requestedModel does not match the bound request required model.');
  }
  return true;
}

// A session-synthesized placeholder for "the adapter did not answer inside
// the request's time budget". Routed through validateResult so a
// locally-built UNKNOWN result and an adapter-reported one are exactly the
// same shape -- one normalization path, not two.
function buildUnknownResult({ request, previous, now }) {
  const stamp = now();
  return validateResult({
    schemaVersion: SCHEMA_VERSION,
    requestHash: request.requestHash,
    providerTaskId: previous ? previous.providerTaskId : null,
    requestedModel: request.requiredModel,
    servedModel: previous ? previous.servedModel : null,
    state: 'UNKNOWN',
    createdAt: previous ? previous.createdAt : stamp,
    updatedAt: stamp,
    evidenceHashes: previous ? previous.evidenceHashes : [],
    artifactManifest: previous ? previous.artifactManifest : []
  });
}

// --- CloudAgentCapabilities / EnvironmentAck --------------------------------

function localCliHint(value) {
  const snapshot = closedObject(value, ['detected', 'version'], ['detected', 'version'], 'capabilities.localCli');
  return Object.freeze({
    detected: boundedBoolean(snapshot.detected, 'capabilities.localCli.detected'),
    version: snapshot.version === null ? null : boundedString(snapshot.version, CLI_VERSION, 'capabilities.localCli.version', 64)
  });
}

const CAPABILITIES_REQUIRED = Object.freeze(['providerId', 'models', 'supportsCancel', 'maxByteBudget', 'maxTimeBudgetMs']);
const CAPABILITIES_FIELDS = Object.freeze([...CAPABILITIES_REQUIRED, 'localCli']);

function validateCapabilities(value) {
  const snapshot = closedObject(value, CAPABILITIES_FIELDS, CAPABILITIES_REQUIRED, 'CloudAgentCapabilities');
  const output = {
    providerId: boundedString(snapshot.providerId, ID, 'providerId', 64),
    models: sortedUniqueStrings(snapshot.models, MODEL_ID, 'models', { min: 0, max: MAX_MODELS_DECLARED, maxLength: 80 }),
    supportsCancel: boundedBoolean(snapshot.supportsCancel, 'supportsCancel'),
    maxByteBudget: boundedInteger(snapshot.maxByteBudget, 1, MAX_BYTE_BUDGET, 'maxByteBudget'),
    maxTimeBudgetMs: boundedInteger(snapshot.maxTimeBudgetMs, 1000, MAX_TIME_BUDGET_MS, 'maxTimeBudgetMs')
  };
  if (Object.prototype.hasOwnProperty.call(snapshot, 'localCli')) output.localCli = localCliHint(snapshot.localCli);
  return Object.freeze(output);
}

function validateEnvironmentAck(value) {
  const snapshot = closedObject(value, ['environmentRef'], ['environmentRef'], 'EnvironmentAck');
  return Object.freeze({ environmentRef: boundedString(snapshot.environmentRef, OPAQUE, 'environmentRef', 128) });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  STATES,
  TERMINAL_STATES,
  isKnownState,
  isTerminalState,
  matchesAllowlist,
  digest,
  validateRequest,
  validateResult,
  validateManifest,
  validateCapabilities,
  validateEnvironmentAck,
  assertResultMatchesRequest,
  assertManifestWithinBudget,
  buildUnknownResult
});
