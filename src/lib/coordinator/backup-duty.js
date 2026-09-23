'use strict';

// Q37 foundation: a declaration the existing coordinator duty host can report
// on.  This module deliberately has no backup implementation.  It reads only
// its small, non-secret config file; it never inspects a backup destination,
// state, or vault, and it never starts a process or writes a file.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
// The tracked file is a shipped, address-free template: its destination path
// is a placeholder, not a real directory, so the product never ships one
// person's filesystem layout as a default. `coordinator-backup-duty.local.json`
// is the per-installation override -- already covered by the repo's blanket
// `*.local.json` gitignore rule, same convention as `config/machines.profile.json`
// for machine topology -- and is preferred when present. Its absence is the
// normal, fully-working state: this duty stays report-only either way.
const TRACKED_DEFINITION_FILE = path.join(ROOT, 'config', 'coordinator-backup-duty.json');
const LOCAL_DEFINITION_FILE = path.join(ROOT, 'config', 'coordinator-backup-duty.local.json');
const DEFINITION_FILE = TRACKED_DEFINITION_FILE;
const SCHEMA_VERSION = 1;
const MODE = 'report-only';
const HOST = 'coordinator-duty-host';
const REQUIRED_ARTIFACTS = Object.freeze([
  'git-bundle', 'vault-state-copy', 'manifest-sha256', 'retention-prune'
]);
const TOP_LEVEL_KEYS = Object.freeze([
  'schemaVersion', 'id', 'host', 'mode', 'intervalMs', 'destination', 'retention', 'plannedArtifacts', 'safety'
]);
const SAFETY_KEYS = Object.freeze([
  'registerScheduledTask', 'createArtifacts', 'deleteArtifacts', 'readVaultContents', 'readDestinationMetadata'
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateDefinition(definition) {
  const errors = [];
  if (!isPlainObject(definition)) return { valid: false, errors: ['backup duty definition must be an object'] };

  const extras = Object.keys(definition).filter(key => !TOP_LEVEL_KEYS.includes(key));
  if (extras.length > 0) errors.push(`backup duty definition contains unsupported keys: ${extras.join(', ')}`);

  if (definition.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (definition.id !== 'recurring-backup-definition') errors.push('id must be recurring-backup-definition');
  if (definition.host !== HOST) errors.push(`host must be ${HOST}`);
  if (definition.mode !== MODE) errors.push(`mode must be ${MODE}`);
  if (!Number.isSafeInteger(definition.intervalMs) || definition.intervalMs < 60_000) {
    errors.push('intervalMs must be a safe integer of at least 60000');
  }

  if (!isPlainObject(definition.destination)
    || definition.destination.kind !== 'local-directory'
    || typeof definition.destination.path !== 'string'
    || definition.destination.path.trim().length === 0) {
    errors.push('destination must name a non-empty local-directory path');
  }
  if (!isPlainObject(definition.retention)
    || !Number.isSafeInteger(definition.retention.maxSnapshots)
    || definition.retention.maxSnapshots < 1
    || definition.retention.maxSnapshots > 90) {
    errors.push('retention.maxSnapshots must be a safe integer from 1 through 90');
  }
  if (!Array.isArray(definition.plannedArtifacts)
    || definition.plannedArtifacts.length !== REQUIRED_ARTIFACTS.length
    || new Set(definition.plannedArtifacts).size !== REQUIRED_ARTIFACTS.length
    || !REQUIRED_ARTIFACTS.every(value => definition.plannedArtifacts.includes(value))) {
    errors.push(`plannedArtifacts must contain exactly: ${REQUIRED_ARTIFACTS.join(', ')}`);
  }
  const safety = definition.safety;
  const safetyKeys = isPlainObject(safety) ? Object.keys(safety) : [];
  if (!isPlainObject(safety)
    || safetyKeys.length !== SAFETY_KEYS.length
    || safetyKeys.some(key => !SAFETY_KEYS.includes(key))
    || safety.registerScheduledTask !== false
    || safety.createArtifacts !== false
    || safety.deleteArtifacts !== false
    || safety.readVaultContents !== false
    || safety.readDestinationMetadata !== true) {
    errors.push('safety must explicitly disable scheduling, artifact creation/deletion, and vault-content reads while allowing destination metadata only');
  }
  return { valid: errors.length === 0, errors };
}

function definitionSummary(definition) {
  return Object.freeze({
    id: definition.id,
    host: definition.host,
    mode: definition.mode,
    intervalMs: definition.intervalMs,
    destinationKind: definition.destination.kind,
    retentionMaxSnapshots: definition.retention.maxSnapshots,
    plannedArtifacts: Object.freeze([...definition.plannedArtifacts]),
    safety: Object.freeze({ ...definition.safety })
  });
}

function resolveDefinitionFile(fsImpl) {
  if (fsImpl.existsSync ? fsImpl.existsSync(LOCAL_DEFINITION_FILE) : fs.existsSync(LOCAL_DEFINITION_FILE)) {
    return LOCAL_DEFINITION_FILE;
  }
  return TRACKED_DEFINITION_FILE;
}

function readDefinition({ file, fsImpl = fs } = {}) {
  let parsed;
  try {
    const resolvedFile = file === undefined ? resolveDefinitionFile(fsImpl) : file;
    parsed = JSON.parse(fsImpl.readFileSync(resolvedFile, 'utf8'));
  } catch {
    return {
      valid: false,
      errors: ['backup duty definition is unavailable'],
      definition: null
    };
  }
  const verdict = validateDefinition(parsed);
  return {
    valid: verdict.valid,
    errors: verdict.errors,
    definition: verdict.valid ? parsed : null
  };
}

function loadDefinition(options = {}) {
  const loaded = readDefinition(options);
  return {
    valid: loaded.valid,
    errors: loaded.errors,
    definition: loaded.valid ? definitionSummary(loaded.definition) : null
  };
}

// This is intentionally a narrow private-to-the-duty seam: the destination
// path is needed to enumerate snapshot *metadata*, but must never travel in a
// heartbeat or dashboard projection. It grants neither content reads nor any
// write/scheduling capability.
function loadObservationTarget(options = {}) {
  const loaded = readDefinition(options);
  if (!loaded.valid || !loaded.definition) {
    return { valid: false, errors: ['backup observation target is unavailable'], target: null };
  }
  return {
    valid: true,
    errors: [],
    target: Object.freeze({
      destinationPath: loaded.definition.destination.path,
      intervalMs: loaded.definition.intervalMs
    })
  };
}

module.exports = Object.freeze({
  ROOT,
  DEFINITION_FILE,
  TRACKED_DEFINITION_FILE,
  LOCAL_DEFINITION_FILE,
  SCHEMA_VERSION,
  MODE,
  HOST,
  REQUIRED_ARTIFACTS,
  TOP_LEVEL_KEYS,
  SAFETY_KEYS,
  validateDefinition,
  loadDefinition,
  loadObservationTarget
});
