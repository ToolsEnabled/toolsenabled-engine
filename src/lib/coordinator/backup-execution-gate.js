'use strict';

// Q37 execution gate.  This is deliberately *not* an activation mechanism:
// production backup execution has no code path in this module.  It converts
// the already-redacted report-only definition summary into a truthful,
// dashboard-safe statement that execution remains blocked.  Keeping this
// contract pure lets a later owner-approved activation phase add a separate
// authority check without changing what the current duty host reports.

const activationRequest = require('./backup-activation-request.js');

const SCHEMA_VERSION = 1;
const DEFINITION_KEYS = Object.freeze([
  'id', 'host', 'mode', 'intervalMs', 'destinationKind', 'retentionMaxSnapshots',
  'plannedArtifacts', 'safety'
]);
const OUTPUT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'status', 'executionAuthorized', 'activationRequired',
  'mode', 'intervalMs', 'retentionMaxSnapshots', 'plannedArtifacts',
  'artifactsCreated', 'artifactsDeleted', 'scheduledTaskRegistered',
  'vaultContentsRead', 'backupExistence', 'contentTrust', 'activationContract'
]);
const REQUIRED_ARTIFACTS = Object.freeze([
  'git-bundle', 'vault-state-copy', 'manifest-sha256', 'retention-prune'
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function isExactDataObject(value, keys) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { exact: false };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { exact: false };
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return { exact: false };
    return { exact: ownKeys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable === true;
    }) };
  } catch (error) {
    return { exact: false, inspectionError: error };
  }
}

function couldNotInspectDefinition(error) {
  const errorCode = error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN_INSPECTION_FAILURE';
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    kind: 'backup-execution-gate',
    status: 'could-not-tell',
    code: 'BACKUP_GATE_DEFINITION_INSPECTION_FAILED',
    causeCode: errorCode,
    message: 'The backup definition could not be inspected; this is NOT claiming that it is absent.'
  });
}

function unavailable() {
  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    kind: 'backup-execution-gate',
    status: 'unavailable',
    executionAuthorized: false,
    activationRequired: true,
    mode: null,
    intervalMs: null,
    retentionMaxSnapshots: null,
    plannedArtifacts: Object.freeze([]),
    artifactsCreated: 0,
    artifactsDeleted: 0,
    scheduledTaskRegistered: false,
    vaultContentsRead: false,
    backupExistence: 'not-asserted',
    contentTrust: 'untrusted',
    activationContract: activationRequest.activationContractSummary()
  });
}

function evaluateBackupExecutionGate(definition) {
  const definitionShape = isExactDataObject(definition, DEFINITION_KEYS);
  if (definitionShape.inspectionError !== undefined) {
    return couldNotInspectDefinition(definitionShape.inspectionError);
  }
  if (!definitionShape.exact) return unavailable();
  const safetyShape = isExactDataObject(definition.safety, [
    'registerScheduledTask', 'createArtifacts', 'deleteArtifacts', 'readVaultContents', 'readDestinationMetadata'
  ]);
  if (safetyShape.inspectionError !== undefined) {
    return couldNotInspectDefinition(safetyShape.inspectionError);
  }
  if (definition.id !== 'recurring-backup-definition'
    || definition.host !== 'coordinator-duty-host'
    || definition.mode !== 'report-only'
    || definition.destinationKind !== 'local-directory'
    || !Number.isSafeInteger(definition.intervalMs) || definition.intervalMs < 60_000
    || !Number.isSafeInteger(definition.retentionMaxSnapshots)
    || definition.retentionMaxSnapshots < 1 || definition.retentionMaxSnapshots > 365
    || !Array.isArray(definition.plannedArtifacts)
    || definition.plannedArtifacts.length !== REQUIRED_ARTIFACTS.length
    || new Set(definition.plannedArtifacts).size !== REQUIRED_ARTIFACTS.length
    || !REQUIRED_ARTIFACTS.every(item => definition.plannedArtifacts.includes(item))
    || !safetyShape.exact
    || definition.safety.registerScheduledTask !== false
    || definition.safety.createArtifacts !== false
    || definition.safety.deleteArtifacts !== false
    || definition.safety.readVaultContents !== false
    || definition.safety.readDestinationMetadata !== true) {
    return unavailable();
  }

  return deepFreeze({
    schemaVersion: SCHEMA_VERSION,
    kind: 'backup-execution-gate',
    status: 'blocked',
    executionAuthorized: false,
    activationRequired: true,
    mode: 'report-only',
    intervalMs: definition.intervalMs,
    retentionMaxSnapshots: definition.retentionMaxSnapshots,
    plannedArtifacts: [...definition.plannedArtifacts],
    artifactsCreated: 0,
    artifactsDeleted: 0,
    scheduledTaskRegistered: false,
    vaultContentsRead: false,
    backupExistence: 'not-asserted',
    contentTrust: 'untrusted',
    activationContract: activationRequest.activationContractSummary()
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  DEFINITION_KEYS,
  OUTPUT_KEYS,
  REQUIRED_ARTIFACTS,
  evaluateBackupExecutionGate,
  unavailable
});
