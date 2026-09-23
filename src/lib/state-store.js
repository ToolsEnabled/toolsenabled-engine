'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, rootPath } = require('./runtime');
const { plaintextCredentialPattern } = require('./secret-patterns');
const { normalizeScheduledAction, SUPPORTED_SCHEDULED_ACTIONS } = require('./scheduled-actions');
const { SCHEDULER_RUN_RECOVERY_MS } = require('./scheduler-constants');
const { deriveAcceptedWorkflow } = require('./coordinator-workflow/broker-verification');
const capabilityManifests = require('./capability-manifests');
const provenanceEnvelopes = require('../../schemas/generated/platform.provenance');
const { validatePinnedFiles, assertProcessReceipt } = require('./research/provenance');
const { validateStudyProtocol, assertStudyProtocolDeclaration } = require('./research/study-protocol');
// Discord left the product on 2026-08-22 (owner ruling, O4) and
// src/lib/discord-owner-commands.js went with it. The V19 migration below
// still creates the three discord_* tables -- user_version numbering is
// load-bearing and a shipped migration is never edited -- so the one value
// its SQL interpolated is pinned here at the number V19 was written with.
// MIGRATION_V22 is what actually removes them: V19 creates, V22 drops, and a
// database that was ever at 19, 20 or 21 is still recognisable on the way past.
//
// NOT to be confused with agent comms. src/lib/agent-comms/* is the product's
// OWN inter-agent messaging: it is modelled on Discord's shape and was never
// Discord, never called it, and is not affected by any of this.
const DISCORD_COMMAND_MAX_CHARACTERS = 2000;

// Node 22 still labels only node:sqlite as experimental. Suppress that one
// exact load-time warning without muting unrelated process warnings.
function loadDatabaseSync() {
  const original = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...args) {
    const message = warning instanceof Error ? warning.message : String(warning);
    const type = warning instanceof Error ? warning.name : args[0];
    if (type === 'ExperimentalWarning' && message === 'SQLite is an experimental feature and might change at any time') return;
    return Reflect.apply(original, this, [warning, ...args]);
  };
  try {
    return require('node:sqlite').DatabaseSync;
  } finally {
    process.emitWarning = original;
  }
}

const DatabaseSync = loadDatabaseSync();
const SCHEMA_VERSION = 24;
const APPLICATION_ID = 0x54454e42; // "TENB" (ToolsEnabled broker)
const DEFAULT_STATE_PATH = rootPath('state', 'toolsenabled.sqlite3');
const sealedStores = new WeakSet();

function assertStateStoreActive(store) {
  if (sealedStores.has(store)) {
    throw stateError('STATE_STORE_CLOSED', 'The durable state store was closed for local-data removal. Restart before using it again.');
  }
}

// `DatabaseSync#isOpen` was added after the Node 22 experimental SQLite
// surface used by this host. StateStore owns the connection lifetime, clears
// `_db` after a successful close, and retains an unconfirmed close for cleanup.
// Treat an older connection object as open while it is retained. Keep the newer
// accessor when present, but do not let its absence recurse `_open()` through
// schema migration.
function databaseIsOpen(database) {
  if (!database) return false;
  try {
    if (typeof database.isOpen === 'boolean') return database.isOpen;
  } catch (error) {
    throw stateError('STATE_CONNECTION_STATUS_UNAVAILABLE', 'The durable state database connection status could not be read.', {}, error);
  }
  return true;
}

function databaseIsTransaction(database) {
  if (!database) return false;
  try {
    return typeof database.isTransaction === 'boolean' && database.isTransaction;
  } catch (error) {
    throw stateError('STATE_TRANSACTION_STATUS_UNAVAILABLE', 'The durable state database transaction status could not be read.', {}, error);
  }
}

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_TASK_PAYLOAD_BYTES = 64 * 1024;
const MAX_TASK_CHECKPOINT_BYTES = 256 * 1024;
const MAX_TASK_CHECKPOINTS = 1000;
const MAX_ACTIVE_TASKS_PER_QUEUE = 10000;
const DEFAULT_TASK_LEASE_MS = 5 * 60 * 1000;
const MAX_TELEGRAM_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_VALUE_BYTES = 32 * 1024;
const MAX_MEMORY_NOTE_CHARS = 8 * 1024;
const MAX_MEMORY_TAGS = 32;
const MAX_MEMORY_TAG_CHARS = 64;
const MAX_APPROVAL_TTL_MS = 15 * 60 * 1000;
const MAX_REMOTE_ASK_TTL_MS = 10 * 60 * 1000;
const REMOTE_ASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MEMORY_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MEMORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MEMORY_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Read only by the _validateSchema invariant for legacy databases at 19, 20 or 21;
// MIGRATION_V22 drops the table this describes.
const DISCORD_GATEWAY_STATES = new Set(['idle', 'connecting', 'ready', 'resuming', 'reconnecting', 'error']);
const MAX_LEGACY_BYTES = 10 * 1024 * 1024;
const OPERATION_STATES = new Set(['reserved', 'executing', 'succeeded', 'retryable_failed', 'uncertain']);
const TASK_STATES = new Set(['queued', 'leased', 'running', 'retry_wait', 'succeeded', 'failed', 'uncertain', 'cancelled']);
const SCHEDULER_OUTBOX_STATES = new Set(['pending', 'executing', 'succeeded', 'retryable_failed', 'error', 'uncertain', 'superseded']);
const STARTUP_WAIT = new Int32Array(new SharedArrayBuffer(4));
const REQUIRED_SCHEMA_V1 = Object.freeze({
  spend_entries: ['id', 'spend_date', 'timestamp_ms', 'amount_cents', 'purpose', 'provider', 'reference'],
  telegram_cursor: ['provider', 'next_update_id', 'updated_at_ms'],
  telegram_poll_lease: ['provider', 'owner_id', 'token', 'fence', 'expires_at_ms', 'updated_at_ms'],
  telegram_updates: ['update_id', 'received_at_ms', 'payload_json', 'payload_hash'],
  operations: ['id', 'operation_type', 'idempotency_key', 'input_hash', 'input_verified', 'status', 'fence', 'attempt', 'lease_owner', 'lease_token', 'lease_expires_at_ms', 'result_json', 'error_code', 'error_message', 'retry_at_ms', 'created_at_ms', 'updated_at_ms', 'completed_at_ms'],
  legacy_imports: ['source', 'source_path', 'digest', 'imported_at_ms', 'records', 'details_json']
});
const REQUIRED_SCHEMA_V2 = Object.freeze({
  ...REQUIRED_SCHEMA_V1,
  tasks: ['id', 'queue_name', 'task_type', 'idempotency_key', 'input_hash', 'body_json', 'status', 'priority', 'available_at_ms',
    'max_attempts', 'attempt', 'retry_backoff_ms', 'max_retry_backoff_ms', 'expiry_policy', 'fence', 'lease_worker_label',
    'lease_token_hash', 'lease_expires_at_ms', 'checkpoint_revision', 'checkpoint_key', 'checkpoint_json', 'checkpoint_hash',
    'result_json', 'result_hash', 'error_code', 'error_message', 'cancel_requested_at_ms', 'cancel_reason', 'created_at_ms',
    'updated_at_ms', 'completed_at_ms'],
  task_attempts: ['task_id', 'fence', 'execution_attempt', 'worker_label', 'token_hash', 'status', 'lease_expires_at_ms',
    'claimed_at_ms', 'started_at_ms', 'updated_at_ms', 'ended_at_ms', 'outcome_hash', 'error_code', 'error_message'],
  task_checkpoints: ['task_id', 'revision', 'fence', 'execution_attempt', 'checkpoint_key', 'previous_hash', 'checkpoint_json',
    'checkpoint_hash', 'created_at_ms']
});
const REQUIRED_SCHEMA_V3 = Object.freeze({
  ...REQUIRED_SCHEMA_V2,
  scheduler_installation: ['singleton', 'installation_id', 'created_at_ms', 'updated_at_ms'],
  scheduler_jobs: ['id', 'name', 'generation', 'schedule', 'interval_minutes', 'action', 'args_json', 'args_hash', 'spec_hash', 'desired_state', 'provider_state',
    'provider_error_code', 'provider_error_message', 'created_at_ms', 'updated_at_ms', 'removed_at_ms', 'last_run_at_ms',
    'last_result_json', 'last_result_hash'],
  scheduler_registrations: ['job_id', 'generation', 'task_name', 'ownership_marker', 'spec_json', 'spec_hash', 'desired_state',
    'observed_state', 'error_code', 'error_message', 'observed_at_ms', 'created_at_ms', 'updated_at_ms'],
  scheduler_outbox: ['id', 'job_id', 'generation', 'operation', 'status', 'attempt', 'fence', 'lease_owner', 'lease_token_hash',
    'lease_expires_at_ms', 'available_at_ms', 'error_code', 'error_message', 'created_at_ms', 'updated_at_ms', 'completed_at_ms'],
  scheduler_attempts: ['outbox_id', 'attempt', 'fence', 'owner_id', 'token_hash', 'operation', 'status', 'started_at_ms',
    'ended_at_ms', 'observation_json', 'observation_hash', 'error_code', 'error_message'],
  scheduler_legacy_import: ['source', 'source_path', 'digest', 'imported_at_ms', 'records', 'details_json'],
  scheduler_runs: ['id', 'job_id', 'generation', 'status', 'fence', 'started_at_ms', 'updated_at_ms', 'ended_at_ms',
    'result_json', 'result_hash', 'error_code', 'error_message']
});
const REQUIRED_SCHEMA_V4 = Object.freeze({
  ...REQUIRED_SCHEMA_V3,
  scheduler_jobs: [...REQUIRED_SCHEMA_V3.scheduler_jobs, 'active_generation']
});
const REQUIRED_SCHEMA_V5 = Object.freeze({
  ...REQUIRED_SCHEMA_V4,
  memory_entries: ['namespace', 'entry_key', 'value_json', 'value_hash', 'note', 'tags_json', 'revision', 'created_at_ms', 'updated_at_ms']
});
const REQUIRED_SCHEMA_V6 = Object.freeze({
  ...REQUIRED_SCHEMA_V5,
  approval_grants: ['id', 'token_hash', 'action', 'input_hash', 'status', 'created_at_ms', 'expires_at_ms', 'consumed_at_ms']
});
const REQUIRED_SCHEMA_V7 = Object.freeze({
  ...REQUIRED_SCHEMA_V6,
  remote_asks: ['id', 'yes_callback_hash', 'no_callback_hash', 'chat_id', 'message_id', 'status', 'created_at_ms', 'expires_at_ms', 'resolved_at_ms', 'resolution_update_id', 'disarmed_at_ms', 'error_code']
});
const REQUIRED_SCHEMA_V8 = Object.freeze({
  ...REQUIRED_SCHEMA_V7,
  model_usage_daily: ['usage_date', 'model', 'prompt_tokens', 'eval_tokens', 'calls', 'updated_at_ms']
});
const REQUIRED_SCHEMA_V9 = Object.freeze({
  ...REQUIRED_SCHEMA_V8,
  tavily_usage_monthly: ['year_month', 'routine_credits', 'research_credits', 'updated_at_ms']
});
const REQUIRED_SCHEMA_V10 = Object.freeze({
  ...REQUIRED_SCHEMA_V9,
  jarvis_missions: ['run_id', 'task_id', 'owner_revision', 'owner_json', 'owner_hash', 'created_at_ms', 'updated_at_ms'],
  jarvis_phase_states: ['run_id', 'actor', 'task_id', 'attempt', 'fence', 'phase', 'phase_status', 'shared_revision',
    'scratch_summary', 'resume_summary', 'cursor', 'retry_count', 'next_action', 'updated_at_ms']
});
const REQUIRED_SCHEMA_V11 = Object.freeze({
  ...REQUIRED_SCHEMA_V10,
  jarvis_workflow_missions: ['run_id', 'task_id', 'mission_id', 'mission_hash', 'contract_json', 'contract_hash', 'owner_revision', 'created_at_ms', 'updated_at_ms'],
  jarvis_broker_verifications: ['run_id', 'execution_role', 'execution_id', 'record_json', 'record_hash', 'owner_revision', 'created_at_ms'],
  jarvis_workflow_events: ['event_id', 'run_id', 'mission_id', 'event_hash', 'event_json', 'occurred_at_ms', 'created_at_ms'],
  jarvis_workflow_outbox: ['outbox_id', 'run_id', 'event_id', 'event_hash', 'event_json', 'status', 'fence', 'lease_worker_label', 'lease_token_hash', 'lease_expires_at_ms', 'created_at_ms', 'updated_at_ms', 'delivered_at_ms'],
  jarvis_workflow_acceptances: ['run_id', 'task_id', 'mission_id', 'mission_hash', 'owner_revision', 'acceptance_json', 'acceptance_hash', 'result_hash', 'event_id', 'accepted_at_ms']
});
const REQUIRED_SCHEMA_V12 = Object.freeze({
  ...REQUIRED_SCHEMA_V11,
  capability_profile_versions: ['profile_id', 'version', 'task_id', 'manifest_json', 'manifest_hash', 'parent_hash', 'expires_at_ms', 'created_at_ms'],
  capability_profile_bindings: ['task_id', 'binding_kind', 'binding_id', 'profile_id', 'profile_version', 'profile_hash', 'created_at_ms'],
  capability_profile_requests: ['request_id', 'task_id', 'request_kind', 'profile_id', 'profile_version', 'profile_hash', 'request_hash', 'request_json', 'status', 'created_at_ms'],
  capability_profile_revocations: ['profile_id', 'profile_version', 'profile_hash', 'reason_code', 'revoked_at_ms']
});
const REQUIRED_SCHEMA_V13 = Object.freeze({
  ...REQUIRED_SCHEMA_V12,
  policy_dispatch_authorizations: ['authorization_id', 'task_id', 'tool_name', 'args_hash', 'target_kind', 'target_hash', 'provenance_json', 'risk', 'delegation_depth', 'user_kind', 'profile_id', 'profile_version', 'profile_hash', 'request_hash', 'created_at_ms'],
  policy_dispatch_consumptions: ['authorization_id', 'args_hash', 'consumed_at_ms']
});
const REQUIRED_SCHEMA_V14 = Object.freeze({
  ...REQUIRED_SCHEMA_V13,
  policy_dispatch_consumptions: ['authorization_id', 'args_hash', 'consumed_at_ms', 'approval_id']
});
const REQUIRED_SCHEMA_V16 = Object.freeze({
  ...REQUIRED_SCHEMA_V14,
  scoped_approval_provenance: ['evidence_id', 'task_id', 'provenance_json', 'provenance_hash', 'created_at_ms'],
  scoped_approval_actions: ['approval_id', 'authorization_id', 'task_id', 'tool_name', 'args_hash', 'target_kind', 'target_hash',
    'parameters_json', 'parameters_hash', 'subject_json', 'subject_hash', 'provenance_evidence_id', 'provenance_hash', 'preview_hash',
    'expires_at_ms', 'created_at_ms'],
  scoped_approval_grants: ['approval_id', 'token_hash', 'approved_at_ms'],
  scoped_approval_events: ['sequence', 'approval_id', 'event_type', 'reason_code', 'event_hash', 'occurred_at_ms']
});
// V17 AND V18 STILL DECLARE THE CERBERUS CORRECTION TABLES. That is not an oversight and it
// is not a live feature: V20 below removes them. This ladder answers "what does a database
// AT version N look like", and _migrate() consults it for the version a database is already
// at before upgrading it. A real database at 17, 18 or 19 has these tables, so describing
// those versions without them makes every existing installation unrecognisable and therefore
// unopenable.
const REQUIRED_SCHEMA_V17 = Object.freeze({
  ...REQUIRED_SCHEMA_V16,
  cerberus_correction_closures: ['closure_family_id', 'source_run_id', 'source_task_id', 'mission_hash', 'owner_revision', 'closure_ref_hash', 'acceptance_ref_hash', 'issuer', 'purpose', 'acceptance_scope', 'catalog_digest', 'status'],
  cerberus_correction_evidence: ['evidence_id', 'closure_family_id', 'source_run_id', 'task_fence', 'owner_revision', 'catalog_digest', 'broker_epoch_digest', 'resolver_policy_digest', 'verifier_catalog_digest', 'verifier_entry_digest', 'taxonomy_catalog_digest', 'projection_policy_digest', 'source_clearance_digest', 'audit_head_sequence', 'audit_head_hash', 'arbiter_epoch', 'arbiter_epoch_digest', 'status'],
  cerberus_correction_handle_events: ['sequence', 'closure_family_id', 'evidence_id', 'event_type', 'reason_code'],
  cerberus_correction_episodes: ['evidence_id', 'episode_json', 'task_class', 'taxonomy', 'check_intent', 'current_verifier_required', 'training_state', 'authority_effect']
});
const REQUIRED_SCHEMA_V18 = Object.freeze({
  ...REQUIRED_SCHEMA_V17,
  cerberus_correction_acceptance_bindings: ['evidence_id', 'closure_family_id', 'source_run_id', 'source_task_id', 'acceptance_hash', 'event_id', 'event_hash', 'baseline_record_hash', 'candidate_record_hash', 'bound_at_ms']
});
const REQUIRED_SCHEMA_V19 = Object.freeze({
  ...REQUIRED_SCHEMA_V18,
  discord_gateway_state: ['provider', 'session_id', 'resume_gateway_url', 'sequence', 'status', 'last_error_code', 'last_event_at_ms', 'updated_at_ms'],
  discord_gateway_lease: ['provider', 'owner_id', 'token_hash', 'fence', 'expires_at_ms', 'updated_at_ms'],
  discord_command_events: ['event_id', 'gateway_sequence', 'channel_id', 'owner_user_id', 'content', 'event_hash', 'received_at_ms']
});
// V20 REMOVES THE CERBERUS CORRECTION STORAGE. It is the only step in this ladder that
// SUBTRACTS, so it is spelled as an explicit delete of five named keys rather than as a
// spread of some earlier version. Rebasing it on V16 would look equivalent and would not be:
// V16 also predates the three discord tables V19 added, so that shortcut would silently stop
// requiring them.
const REQUIRED_SCHEMA_V20 = Object.freeze(Object.fromEntries(
  Object.entries(REQUIRED_SCHEMA_V19).filter(([table]) => !table.startsWith('cerberus_correction_'))
));
// V21 adds the generalized research domain: projects -> experiments -> runs ->
// results (+ the findings register from docs/design/RESEARCH-SUITE.md section 2.1
// and the session-assignment table). Runs carry NO status column on purpose:
// every run is a durable task on the reserved 'research-runs' queue and status
// is read by joining tasks — one source of truth, zero drift (the durable
// mission/task split, same reasoning).
const REQUIRED_SCHEMA_V21 = Object.freeze({
  ...REQUIRED_SCHEMA_V20,
  research_projects: ['project_id', 'name', 'description', 'owner_scope', 'enabled', 'status', 'created_at_ms', 'updated_at_ms'],
  research_experiments: ['experiment_id', 'project_id', 'name', 'runner_kind', 'runner_config_json', 'config_hash',
    'result_schema_json', 'collector_json', 'max_parallel', 'mutex_key', 'timeout_ms', 'status', 'created_at_ms', 'updated_at_ms'],
  research_runs: ['run_id', 'experiment_id', 'task_id', 'params_json', 'params_hash', 'session_ref_kind', 'session_ref',
    'artifact_dir', 'created_at_ms'],
  research_results: ['result_id', 'run_id', 'record_kind', 'record_json', 'record_hash', 'artifact_path', 'created_at_ms'],
  research_findings: ['finding_id', 'project_id', 'claim', 'status', 'evidence_json', 'method', 'confidence', 'falsifier',
    'dissents_json', 'supersedes', 'created_at_ms', 'updated_at_ms'],
  research_project_sessions: ['assignment_id', 'project_id', 'session_ref_kind', 'session_ref', 'assigned_by', 'active',
    'assigned_at_ms', 'unassigned_at_ms']
});
// V22 REMOVES THE DISCORD CONNECTOR STORAGE. Like V20, this step SUBTRACTS, so it is
// spelled as an explicit delete of the three named keys rather than as a spread of some
// earlier version: rebasing on V18 would look equivalent and would silently stop requiring
// everything V19, V20 and V21 settled between them.
const REQUIRED_SCHEMA_V22 = Object.freeze(Object.fromEntries(
  Object.entries(REQUIRED_SCHEMA_V21).filter(([table]) => !table.startsWith('discord_'))
));
// V23 REMOVES THE TELEGRAM CONNECTOR STORAGE. Same shape as V20 and V22: this step
// SUBTRACTS, so it is spelled as an explicit filter over the version immediately below it
// rather than as a spread of some earlier version. Rebasing on anything older would look
// equivalent and would silently stop requiring everything V19 through V22 settled.
const REQUIRED_SCHEMA_V23 = Object.freeze(Object.fromEntries(
  Object.entries(REQUIRED_SCHEMA_V22).filter(([table]) => !table.startsWith('telegram_'))
));
// V24 RENAMES THE DURABLE-MISSION TABLES. The local worker integration that named them
// after itself left the product; the tables stay (the coordinator workflow acceptance
// records and their foreign keys still live here) under the coordinator's own name.
// V10 and V11 are NOT edited, for the reason every note above gives: a database written
// at any version from 10 to 23 has the old names, and _migrate() validates a database
// against the schema its recorded version PROMISED before upgrading it. The rename
// happens HERE, once, at the top, and the legacy prefix below is the single seam that
// still has to spell the old name so the ladder keeps describing real databases.
const REQUIRED_SCHEMA = Object.freeze(Object.fromEntries(
  Object.entries(REQUIRED_SCHEMA_V23).map(([table, columns]) => [
    table.startsWith('jarvis_') ? `coordinator_${table.slice('jarvis_'.length)}` : table,
    columns
  ])
));

class StateStoreError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = 'StateStoreError';
    this.code = code;
    this.details = details;
  }
}

function stateError(code, message, details, cause) {
  return new StateStoreError(code, message, details || {}, cause ? { cause } : {});
}

function translateError(error) {
  if (error instanceof StateStoreError) return error;
  if (error && error.code === 'ERR_SQLITE_ERROR') {
    const base = Number(error.errcode) & 0xff;
    if (base === 5 || base === 6) {
      return stateError('STATE_BUSY', 'The durable state database is busy.', { sqliteCode: error.errcode }, error);
    }
    if (base === 19) {
      return stateError('STATE_CONSTRAINT', 'A durable state constraint was violated.', { sqliteCode: error.errcode }, error);
    }
    return stateError('STATE_SQLITE_ERROR', 'The durable state database rejected an operation.', { sqliteCode: error.errcode }, error);
  }
  return error;
}

function isBusyError(error) {
  if (error instanceof StateStoreError) return error.code === 'STATE_BUSY';
  return Boolean(error && error.code === 'ERR_SQLITE_ERROR' && ([5, 6].includes(Number(error.errcode) & 0xff)));
}

function waitSynchronously(milliseconds) {
  if (milliseconds > 0) Atomics.wait(STARTUP_WAIT, 0, 0, milliseconds);
}

function hasTransactionControl(sql) {
  if (typeof sql !== 'string') return false;
  let visible = '';
  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      visible += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index = Math.min(sql.length, index + 2);
      visible += ' ';
      continue;
    }
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === closing) {
          if (closing !== ']' && sql[index + 1] === closing) { index += 2; continue; }
          index += 1;
          break;
        }
        index += 1;
      }
      visible += ' ';
      continue;
    }
    visible += char;
    index += 1;
  }
  // SQLite trigger bodies are syntactically delimited by BEGIN/END but cannot
  // contain transaction control.  Remove complete CREATE TRIGGER bodies before
  // enforcing the callback ban so schema migrations can still use immutable
  // append-only guards without granting callers COMMIT/ROLLBACK access.
  const withoutTriggers = visible.replace(/CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b[\s\S]*?\bBEGIN\b[\s\S]*?\bEND\s*;/gi, ' ');
  return /(?:^|;)\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(withoutTriggers);
}

  function transactionView(database, gate) {
  function assertOpen() {
    if (!gate.active) throw stateError('STATE_TRANSACTION_CLOSED', 'The transaction-scoped database handle is no longer active.');
  }
  function statementView(statement) {
    const view = {
      all(...args) { assertOpen(); return statement.all(...args); },
      columns() { assertOpen(); return statement.columns(); },
      get(...args) { assertOpen(); return statement.get(...args); },
      run(...args) { assertOpen(); return statement.run(...args); },
      setAllowBareNamedParameters(value) { assertOpen(); statement.setAllowBareNamedParameters(value); return view; },
      setAllowUnknownNamedParameters(value) { assertOpen(); statement.setAllowUnknownNamedParameters(value); return view; },
      setReadBigInts(value) { assertOpen(); statement.setReadBigInts(value); return view; },
      setReturnArrays(value) { assertOpen(); statement.setReturnArrays(value); return view; },
      iterate(...args) {
        assertOpen();
        const iterator = statement.iterate(...args);
        return {
          next() { assertOpen(); return iterator.next(); },
          return(value) { assertOpen(); return iterator.return ? iterator.return(value) : { done: true, value }; },
          [Symbol.iterator]() { return this; }
        };
      }
    };
    Object.defineProperties(view, {
      expandedSQL: { enumerable: true, get() { assertOpen(); return statement.expandedSQL; } },
      sourceSQL: { enumerable: true, get() { assertOpen(); return statement.sourceSQL; } }
    });
    return Object.freeze(view);
  }
  const view = {
    exec(sql) {
      assertOpen();
      if (hasTransactionControl(sql)) throw stateError('STATE_TRANSACTION_CONTROL', 'Transaction callbacks may not execute transaction-control SQL.');
      return database.exec(sql);
    },
    prepare(sql) {
      assertOpen();
      if (hasTransactionControl(sql)) throw stateError('STATE_TRANSACTION_CONTROL', 'Transaction callbacks may not prepare transaction-control SQL.');
      return statementView(database.prepare(sql));
    }
  };
  Object.defineProperties(view, {
    isOpen: { enumerable: true, get() { assertOpen(); return databaseIsOpen(database); } },
    isTransaction: { enumerable: true, get() { assertOpen(); return true; } }
  });
  return Object.freeze(view);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw stateError('STATE_INVALID_ARGUMENT', `${label} must be a plain object.`, { field: label });
  }
  return value;
}

function assertExactDataObject(value, keys, label) {
  let prototype;
  try { prototype = value && typeof value === 'object' && !Array.isArray(value) ? Object.getPrototypeOf(value) : null; }
  catch { prototype = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || prototype !== Object.prototype) {
    throw stateError('STATE_INVALID_ARGUMENT', `${label} must be a plain data object.`, { field: label });
  }
  let actual;
  try { actual = Reflect.ownKeys(value); } catch {
    throw stateError('STATE_INVALID_ARGUMENT', `${label} own fields are unavailable.`, { field: label });
  }
  if (actual.length !== keys.length
      || actual.some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw stateError('STATE_INVALID_ARGUMENT', `${label} has unsupported or missing fields.`, { field: label });
  }
  const snapshot = {};
  for (const key of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, key); } catch {
      throw stateError('STATE_INVALID_ARGUMENT', `${label} field descriptors are unavailable.`, { field: label });
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw stateError('STATE_INVALID_ARGUMENT', `${label} must not contain accessors.`, { field: label });
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function assertString(value, label, { min = 1, max = 500, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    throw stateError('STATE_INVALID_ARGUMENT', `${label} is invalid.`, { field: label });
  }
  return value;
}

function assertInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw stateError('STATE_INVALID_ARGUMENT', `${label} must be an integer from ${min} through ${max}.`, { field: label });
  }
  return value;
}

function assertMemoryTags(value, label = 'tags') {
  if (!Array.isArray(value) || value.length > MAX_MEMORY_TAGS) {
    throw stateError('MEMORY_TAGS_INVALID', `${label} must be an array of at most ${MAX_MEMORY_TAGS} tags.`, { field: label });
  }
  const tags = value.map((tag, index) => assertString(tag, `${label}[${index}]`, {
    max: MAX_MEMORY_TAG_CHARS, pattern: MEMORY_TAG_PATTERN
  }));
  if (new Set(tags).size !== tags.length) {
    throw stateError('MEMORY_TAGS_INVALID', `${label} must not contain duplicate tags.`, { field: label });
  }
  return tags;
}

function canonicalJson(value) {
  const seen = new Set();
  function encode(entry, inArray = false, depth = 0) {
    if (depth > 64) throw stateError('STATE_JSON_DEPTH', 'JSON nesting exceeds the durable-state depth limit.');
    if (entry === null) return 'null';
    if (entry === undefined) return inArray ? 'null' : undefined;
    if (typeof entry === 'string' || typeof entry === 'boolean') return JSON.stringify(entry);
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw stateError('STATE_JSON_INVALID', 'JSON values must contain only finite numbers.');
      return JSON.stringify(entry);
    }
    if (typeof entry !== 'object' || typeof entry.toJSON === 'function') {
      throw stateError('STATE_JSON_INVALID', 'Only JSON-compatible values may be persisted or hashed.');
    }
    if (seen.has(entry)) throw stateError('STATE_JSON_INVALID', 'Circular JSON values are not supported.');
    seen.add(entry);
    let output;
    if (Array.isArray(entry)) {
      output = `[${Array.from({ length: entry.length }, (_, index) => encode(entry[index], true, depth + 1)).join(',')}]`;
    } else {
      if (Object.getPrototypeOf(entry) !== Object.prototype) {
        seen.delete(entry);
        throw stateError('STATE_JSON_INVALID', 'Only plain JSON objects may be persisted or hashed.');
      }
      output = `{${Object.keys(entry).sort().flatMap(key => {
        const encoded = encode(entry[key], false, depth + 1);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      }).join(',')}}`;
    }
    seen.delete(entry);
    return output;
  }
  const result = encode(value, false, 0);
  if (result === undefined) throw stateError('STATE_JSON_INVALID', 'The root JSON value may not be undefined.');
  return result;
}

function boundedJson(value, label = 'value') {
  const json = canonicalJson(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_JSON_BYTES) {
    throw stateError('STATE_JSON_TOO_LARGE', `${label} exceeds the 1 MiB durable-state limit.`, { field: label });
  }
  return json;
}

function boundedTaskJson(value, label, maximumBytes, code) {
  const json = canonicalJson(value);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maximumBytes) {
    throw stateError(code, `${label} exceeds the durable task size limit.`, { field: label, maximumBytes });
  }
  return json;
}

function equalHash(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

const SENSITIVE_RESULT_KEY = /(?:^(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|authorization|password|cookie|cvc|cvv|security[_-]?code|securityCode|number|card[_-]?number|private[_-]?key|privateKey|credential|credentials|session|session[_-]?id|stripe_(?:secret|restricted)_key)$|(?:^|[_-])(?:token|secret|credential|session)(?:$|[_-])|(?:token|secret|credential|session|privateKey)$)/i;
function assertSafeOperationResult(value, depth = 0, seen = new Set()) {
  if (depth > 24) throw stateError('OPERATION_RESULT_INVALID', 'Operation result nesting exceeds the safe persistence limit.');
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeOperationResult(entry, depth + 1, seen);
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_RESULT_KEY.test(key)) {
        throw stateError('OPERATION_RESULT_SENSITIVE', 'Operation results may not persist sensitive credential or payment fields.', { field: key });
      }
      assertSafeOperationResult(entry, depth + 1, seen);
    }
  }
  seen.delete(value);
}

const PLAINTEXT_SECRET = plaintextCredentialPattern();
// Only a payload minted below from an existing research row and a computed
// parameter digest has this identity. JSON properties, clones and queue names
// cannot grant it. Nothing about the shared credential patterns is relaxed.
const RESEARCH_REFERENCE_PAYLOADS = new WeakSet();
// Only an immutable completion object minted inside completeResearchRun owns
// this exact computed digest. Caller fields, copies and other task results
// cannot turn digest-shaped text into an exemption from the secret scanner.
const RESEARCH_COMPLETION_DIGESTS = new WeakMap();
function researchReferencePayload(experimentRow, paramsHash) {
  const experimentId = experimentRow && experimentRow.experiment_id;
  if (typeof experimentId !== 'string' || !/^rx-[a-f0-9]{36}$/.test(experimentId)
      || typeof paramsHash !== 'string' || !/^[a-f0-9]{64}$/.test(paramsHash)) {
    throw stateError('RESEARCH_RUN_REFERENCE_INVALID', 'Research task references must bind a saved generated experiment ID and a computed parameter digest.');
  }
  // Preserve the original bytes: the task input hash and idempotent replay
  // already bind this exact title/objective representation in existing data.
  const payload = Object.freeze({
    title: `Research run ${paramsHash.slice(0, 12)}`,
    objective: JSON.stringify({ experimentId, paramsHash })
  });
  RESEARCH_REFERENCE_PAYLOADS.add(payload);
  return payload;
}

function assertNoPlaintextTaskSecrets(value, label = 'value', depth = 0, seen = new Set()) {
  if (depth > 32) throw stateError('STATE_JSON_DEPTH', `${label} nesting exceeds the safe persistence limit.`, { field: label });
  if (typeof value === 'string') {
    if (PLAINTEXT_SECRET.test(value)) throw stateError('TASK_SECRET_REJECTED', `${label} appears to contain a plaintext credential; store it in the vault and use a reference.`, { field: label });
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) value.forEach((entry, index) => assertNoPlaintextTaskSecrets(entry, `${label}[${index}]`, depth + 1, seen));
  else Object.entries(value).forEach(([key, entry]) => {
    if (SENSITIVE_RESULT_KEY.test(key)) throw stateError('TASK_SECRET_REJECTED', `${label} contains a sensitive field; store credentials in the vault and use a reference.`, { field: `${label}.${key}` });
    assertNoPlaintextTaskSecrets(entry, `${label}.${key}`, depth + 1, seen);
  });
  seen.delete(value);
}

function assertNoPlaintextMemorySecrets(value, label = 'memory value', depth = 0, seen = new Set()) {
  if (depth > 32) throw stateError('MEMORY_VALUE_INVALID', `${label} nesting exceeds the safe memory limit.`, { field: label });
  if (typeof value === 'string') {
    if (PLAINTEXT_SECRET.test(value)) {
      throw stateError('MEMORY_SECRET_REJECTED', `${label} appears to contain a plaintext credential; store credentials only in the vault.`, { field: label });
    }
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoPlaintextMemorySecrets(entry, `${label}[${index}]`, depth + 1, seen));
  } else {
    Object.entries(value).forEach(([key, entry]) => {
      if (SENSITIVE_RESULT_KEY.test(key)) {
        throw stateError('MEMORY_SECRET_REJECTED', `${label} contains a sensitive field; store credentials only in the vault.`, { field: `${label}.${key}` });
      }
      assertNoPlaintextMemorySecrets(entry, `${label}.${key}`, depth + 1, seen);
    });
  }
  seen.delete(value);
}

function assertNoPlaintextSchedulerSecrets(value, label = 'args') {
  try { assertNoPlaintextTaskSecrets(value, label); }
  catch (error) {
    if (error instanceof StateStoreError && error.code === 'TASK_SECRET_REJECTED') {
      throw stateError('SCHEDULER_SECRET_REJECTED', error.message, error.details, error);
    }
    throw error;
  }
}

function assertOnlyKeys(value, allowed, label, code = 'STATE_INVALID_ARGUMENT') {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw stateError(code, `${label} contains unsupported field '${key}'.`, { field: `${label}.${key}` });
  }
}

const LEGACY_SCHEDULER_ACTION_SCHEMAS = Object.freeze({
  'instagram.publish_image': { required: ['imageUrl'], strings: ['imageUrl', 'caption', 'idempotencyKey'] },
  'gmail.send': { required: ['to', 'subject'], strings: ['to', 'subject', 'text', 'cc', 'bcc'] },
  'calendar.create': { required: ['summary', 'start', 'end'], strings: ['calendarId', 'summary', 'description', 'start', 'end'], stringArrays: ['attendees'] },
  'launch.execute': {
    required: [], strings: ['cwd', 'projectId', 'provider', 'only'], booleans: ['deploy', 'skipTests'], objects: ['firebaseProvision', 'chromeWebStore']
  },
  'deployment.execute': { required: [], strings: ['cwd', 'provider', 'projectId', 'only'] }
});

function normalizeLegacySchedulerAction(value, label) {
  const action = assertString(value, label, { max: 100 });
  const normalized = normalizeScheduledAction(action);
  if (!SUPPORTED_SCHEDULED_ACTIONS.includes(normalized) || !LEGACY_SCHEDULER_ACTION_SCHEMAS[normalized]) {
    throw stateError('SCHEDULER_ACTION_UNSUPPORTED', `Scheduled action '${action}' is not supported.`, { action });
  }
  return normalized;
}

function validateLegacySchedulerArgs(action, value, label) {
  const args = assertPlainObject(value, label);
  assertNoPlaintextSchedulerSecrets(args, label);
  const schema = LEGACY_SCHEDULER_ACTION_SCHEMAS[action];
  const allowed = new Set([...(schema.strings || []), ...(schema.booleans || []), ...(schema.objects || []), ...(schema.stringArrays || []), ...Object.keys(schema.integers || {})]);
  assertOnlyKeys(args, allowed, label, 'SCHEDULER_LEGACY_INVALID');
  for (const key of schema.required || []) {
    if (args[key] === undefined) throw stateError('SCHEDULER_LEGACY_INVALID', `${label}.${key} is required.`, { field: `${label}.${key}` });
  }
  for (const key of schema.strings || []) {
    if (args[key] !== undefined) assertString(args[key], `${label}.${key}`, { min: schema.required.includes(key) ? 1 : 0, max: 10000 });
  }
  for (const key of schema.booleans || []) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') {
      throw stateError('SCHEDULER_LEGACY_INVALID', `${label}.${key} must be a boolean.`, { field: `${label}.${key}` });
    }
  }
  for (const [key, [min, max]] of Object.entries(schema.integers || {})) {
    if (args[key] !== undefined) assertInteger(args[key], `${label}.${key}`, { min, max });
  }
  for (const key of schema.objects || []) {
    if (args[key] !== undefined) assertPlainObject(args[key], `${label}.${key}`);
  }
  for (const key of schema.stringArrays || []) {
    if (args[key] !== undefined) {
      if (!Array.isArray(args[key]) || args[key].length > 100 || args[key].some(item => typeof item !== 'string' || item.length > 1000)) {
        throw stateError('SCHEDULER_LEGACY_INVALID', `${label}.${key} must be an array of at most 100 bounded strings.`, { field: `${label}.${key}` });
      }
    }
  }
  return args;
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashInput(value) {
  return hashText(canonicalJson(value));
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw stateError('STATE_CORRUPT_JSON', `Stored ${label} JSON is malformed.`, { field: label }, error);
  }
}

function isEmptyLegacySchedulerTombstone(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed).sort();
    return keys.length === 2 && keys[0] === 'jobs' && keys[1] === 'version'
      && parsed.version === 1 && Array.isArray(parsed.jobs) && parsed.jobs.length === 0;
  } catch {
    return false;
  }
}

function legacySchedulerCleanupCandidates(text) {
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) {
    throw stateError('SCHEDULER_LEGACY_ARCHIVE_INVALID', 'The imported scheduler archive is not valid JSON.', {}, error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.version !== 1 || !Array.isArray(parsed.jobs) || parsed.jobs.length > 10000) {
    throw stateError('SCHEDULER_LEGACY_ARCHIVE_INVALID', 'The imported scheduler archive has an invalid top-level shape.');
  }
  const keys = Object.keys(parsed);
  if (keys.some(key => !['version', 'jobs'].includes(key))) {
    throw stateError('SCHEDULER_LEGACY_ARCHIVE_INVALID', 'The imported scheduler archive has unsupported top-level fields.');
  }
  const names = new Set();
  return parsed.jobs.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw stateError('SCHEDULER_LEGACY_ARCHIVE_INVALID', `Archived jobs[${index}] is invalid.`);
    }
    const name = assertString(raw.name, `archived jobs[${index}].name`, { max: 80, pattern: /^[A-Za-z0-9_.-]{1,80}$/ });
    if (names.has(name)) throw stateError('SCHEDULER_LEGACY_ARCHIVE_INVALID', 'The imported scheduler archive has duplicate job names.', { name });
    names.add(name);
    if (!['daily', 'hourly'].includes(raw.schedule)) {
      throw stateError('SCHEDULER_LEGACY_ARCHIVE_INVALID', `Archived jobs[${index}].schedule is invalid.`, { name });
    }
    const createdAtMs = typeof raw.createdAt === 'string' && Number.isFinite(Date.parse(raw.createdAt))
      ? Date.parse(raw.createdAt) : null;
    return { name, schedule: raw.schedule, createdAtMs };
  });
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function centsToUsd(cents) {
  return cents / 100;
}

function legacyUsdToCents(value, label) {
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(cents) || Math.abs(amount * 100 - cents) > 1e-7) {
    throw stateError('LEGACY_IMPORT_INVALID', `${label} must be a non-negative USD value with at most two decimal places.`, { field: label });
  }
  return cents;
}

function validUtcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseLegacyTimestamp(value, label, fallbackMs) {
  if (value === undefined || value === null || value === '') return fallbackMs;
  if (typeof value !== 'string') {
    throw stateError('LEGACY_IMPORT_INVALID', `${label} must be an ISO timestamp string.`, { field: label });
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw stateError('LEGACY_IMPORT_INVALID', `${label} must be a valid timestamp.`, { field: label });
  }
  return parsed;
}

const SCHEMA_V1 = `
  CREATE TABLE spend_entries (
    id TEXT PRIMARY KEY,
    spend_date TEXT NOT NULL CHECK(length(spend_date) = 10),
    timestamp_ms INTEGER NOT NULL CHECK(timestamp_ms >= 0),
    amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
    purpose TEXT NOT NULL CHECK(length(purpose) <= 1000),
    provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 100),
    reference TEXT CHECK(reference IS NULL OR length(reference) BETWEEN 1 AND 500),
    UNIQUE(provider, reference)
  ) STRICT;
  CREATE INDEX spend_entries_date_idx ON spend_entries(spend_date, timestamp_ms);

  CREATE TABLE telegram_cursor (
    provider TEXT PRIMARY KEY CHECK(provider = 'telegram'),
    next_update_id INTEGER NOT NULL CHECK(next_update_id >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
  ) STRICT;
  INSERT INTO telegram_cursor(provider, next_update_id, updated_at_ms) VALUES('telegram', 0, 0);

  CREATE TABLE telegram_poll_lease (
    provider TEXT PRIMARY KEY CHECK(provider = 'telegram'),
    owner_id TEXT,
    token TEXT,
    fence INTEGER NOT NULL CHECK(fence >= 0),
    expires_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
    CHECK((owner_id IS NULL AND token IS NULL AND expires_at_ms IS NULL) OR
          (owner_id IS NOT NULL AND token IS NOT NULL AND expires_at_ms IS NOT NULL))
  ) STRICT;
  INSERT INTO telegram_poll_lease(provider, owner_id, token, fence, expires_at_ms, updated_at_ms)
    VALUES('telegram', NULL, NULL, 0, NULL, 0);

  CREATE TABLE telegram_updates (
    update_id INTEGER PRIMARY KEY CHECK(update_id >= 0),
    received_at_ms INTEGER NOT NULL CHECK(received_at_ms >= 0),
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64)
  ) STRICT;
  CREATE INDEX telegram_updates_received_idx ON telegram_updates(received_at_ms, update_id);

  CREATE TABLE operations (
    id TEXT PRIMARY KEY,
    operation_type TEXT NOT NULL CHECK(length(operation_type) BETWEEN 1 AND 200),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 500),
    input_hash TEXT NOT NULL CHECK(length(input_hash) = 64),
    input_verified INTEGER NOT NULL DEFAULT 1 CHECK(input_verified IN (0, 1)),
    status TEXT NOT NULL CHECK(status IN ('reserved','executing','succeeded','retryable_failed','uncertain')),
    fence INTEGER NOT NULL CHECK(fence >= 1),
    attempt INTEGER NOT NULL CHECK(attempt >= 1),
    lease_owner TEXT,
    lease_token TEXT,
    lease_expires_at_ms INTEGER,
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    retry_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
    completed_at_ms INTEGER,
    UNIQUE(operation_type, idempotency_key),
    CHECK((lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at_ms IS NULL) OR
          (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at_ms IS NOT NULL))
  ) STRICT;
  CREATE INDEX operations_status_idx ON operations(status, retry_at_ms, lease_expires_at_ms);

  CREATE TABLE legacy_imports (
    source TEXT PRIMARY KEY CHECK(source IN ('spend','telegram','instagram')),
    source_path TEXT NOT NULL,
    digest TEXT NOT NULL CHECK(length(digest) = 64),
    imported_at_ms INTEGER NOT NULL CHECK(imported_at_ms >= 0),
    records INTEGER NOT NULL CHECK(records >= 0),
    details_json TEXT NOT NULL
  ) STRICT;

  PRAGMA application_id = ${APPLICATION_ID};
  PRAGMA user_version = 1;
`;

const MIGRATION_V2 = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 500),
    queue_name TEXT NOT NULL CHECK(length(queue_name) BETWEEN 1 AND 64),
    task_type TEXT NOT NULL CHECK(length(task_type) BETWEEN 1 AND 64),
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 8 AND 200),
    input_hash TEXT NOT NULL CHECK(length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
    body_json TEXT NOT NULL CHECK(json_valid(body_json) AND length(CAST(body_json AS BLOB)) BETWEEN 1 AND ${MAX_TASK_PAYLOAD_BYTES}),
    status TEXT NOT NULL CHECK(status IN ('queued','leased','running','retry_wait','succeeded','failed','uncertain','cancelled')),
    priority INTEGER NOT NULL CHECK(priority BETWEEN -100 AND 100),
    available_at_ms INTEGER NOT NULL CHECK(available_at_ms >= 0),
    max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND max_attempts),
    retry_backoff_ms INTEGER NOT NULL CHECK(retry_backoff_ms BETWEEN 0 AND 86400000),
    max_retry_backoff_ms INTEGER NOT NULL CHECK(max_retry_backoff_ms BETWEEN 0 AND 604800000),
    expiry_policy TEXT NOT NULL CHECK(expiry_policy IN ('uncertain','retry')),
    fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
    lease_worker_label TEXT CHECK(lease_worker_label IS NULL OR length(lease_worker_label) BETWEEN 1 AND 100),
    lease_token_hash TEXT CHECK(lease_token_hash IS NULL OR (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
    lease_expires_at_ms INTEGER CHECK(lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
    checkpoint_revision INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_revision BETWEEN 0 AND ${MAX_TASK_CHECKPOINTS}),
    checkpoint_key TEXT CHECK(checkpoint_key IS NULL OR length(checkpoint_key) BETWEEN 8 AND 200),
    checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR (json_valid(checkpoint_json) AND length(CAST(checkpoint_json AS BLOB)) BETWEEN 1 AND ${MAX_TASK_CHECKPOINT_BYTES})),
    checkpoint_hash TEXT CHECK(checkpoint_hash IS NULL OR (length(checkpoint_hash) = 64 AND checkpoint_hash NOT GLOB '*[^0-9a-f]*')),
    result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB)) BETWEEN 1 AND ${MAX_JSON_BYTES})),
    result_hash TEXT CHECK(result_hash IS NULL OR (length(result_hash) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*')),
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 200),
    error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 1000),
    cancel_requested_at_ms INTEGER CHECK(cancel_requested_at_ms IS NULL OR cancel_requested_at_ms >= 0),
    cancel_reason TEXT CHECK(cancel_reason IS NULL OR length(cancel_reason) <= 1000),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    completed_at_ms INTEGER CHECK(completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
    UNIQUE(queue_name, idempotency_key),
    CHECK(retry_backoff_ms <= max_retry_backoff_ms),
    CHECK((status IN ('leased','running') AND lease_worker_label IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at_ms IS NOT NULL) OR
      (status NOT IN ('leased','running') AND lease_worker_label IS NULL AND lease_token_hash IS NULL AND lease_expires_at_ms IS NULL)),
    CHECK((checkpoint_revision = 0 AND checkpoint_key IS NULL AND checkpoint_json IS NULL AND checkpoint_hash IS NULL) OR
      (checkpoint_revision > 0 AND checkpoint_key IS NOT NULL AND checkpoint_json IS NOT NULL AND checkpoint_hash IS NOT NULL)),
    CHECK((result_json IS NULL AND result_hash IS NULL) OR (result_json IS NOT NULL AND result_hash IS NOT NULL)),
    CHECK(cancel_reason IS NULL OR cancel_requested_at_ms IS NOT NULL),
    CHECK((status IN ('succeeded','failed','uncertain','cancelled') AND completed_at_ms IS NOT NULL) OR
      (status NOT IN ('succeeded','failed','uncertain','cancelled') AND completed_at_ms IS NULL)),
    CHECK((status = 'succeeded' AND result_json IS NOT NULL) OR (status <> 'succeeded' AND result_json IS NULL)),
    CHECK((status IN ('retry_wait','failed','uncertain') AND error_code IS NOT NULL AND error_message IS NOT NULL) OR
      (status NOT IN ('retry_wait','failed','uncertain') AND error_code IS NULL AND error_message IS NULL))
  ) STRICT;
  CREATE INDEX tasks_claim_idx ON tasks(queue_name, status, available_at_ms, priority DESC, created_at_ms, id);
  CREATE INDEX tasks_expiry_idx ON tasks(status, lease_expires_at_ms);
  CREATE INDEX tasks_updated_idx ON tasks(updated_at_ms DESC, id DESC);

  CREATE TABLE task_attempts (
    task_id TEXT NOT NULL,
    fence INTEGER NOT NULL CHECK(fence >= 1),
    execution_attempt INTEGER NOT NULL CHECK(execution_attempt BETWEEN 1 AND 10),
    worker_label TEXT NOT NULL CHECK(length(worker_label) BETWEEN 1 AND 100),
    token_hash TEXT NOT NULL CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    status TEXT NOT NULL CHECK(status IN ('leased','running','succeeded','retryable_failed','failed','cancelled','lease_expired','uncertain')),
    lease_expires_at_ms INTEGER NOT NULL CHECK(lease_expires_at_ms >= 0),
    claimed_at_ms INTEGER NOT NULL CHECK(claimed_at_ms >= 0),
    started_at_ms INTEGER CHECK(started_at_ms IS NULL OR started_at_ms >= claimed_at_ms),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= claimed_at_ms),
    ended_at_ms INTEGER CHECK(ended_at_ms IS NULL OR ended_at_ms >= claimed_at_ms),
    outcome_hash TEXT CHECK(outcome_hash IS NULL OR (length(outcome_hash) = 64 AND outcome_hash NOT GLOB '*[^0-9a-f]*')),
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 200),
    error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 1000),
    PRIMARY KEY(task_id, fence),
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    CHECK((status IN ('leased','running') AND ended_at_ms IS NULL AND outcome_hash IS NULL) OR
      (status NOT IN ('leased','running') AND ended_at_ms IS NOT NULL AND outcome_hash IS NOT NULL)),
    CHECK(status NOT IN ('running','succeeded','uncertain') OR started_at_ms IS NOT NULL)
  ) STRICT;
  CREATE INDEX task_attempts_status_idx ON task_attempts(status, updated_at_ms);

  CREATE TABLE task_checkpoints (
    task_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND ${MAX_TASK_CHECKPOINTS}),
    fence INTEGER NOT NULL CHECK(fence >= 1),
    execution_attempt INTEGER NOT NULL CHECK(execution_attempt >= 1),
    checkpoint_key TEXT NOT NULL CHECK(length(checkpoint_key) BETWEEN 8 AND 200),
    previous_hash TEXT CHECK(previous_hash IS NULL OR (length(previous_hash) = 64 AND previous_hash NOT GLOB '*[^0-9a-f]*')),
    checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json) AND length(CAST(checkpoint_json AS BLOB)) BETWEEN 1 AND ${MAX_TASK_CHECKPOINT_BYTES}),
    checkpoint_hash TEXT NOT NULL CHECK(length(checkpoint_hash) = 64 AND checkpoint_hash NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    PRIMARY KEY(task_id, revision),
    UNIQUE(task_id, fence, checkpoint_key),
    FOREIGN KEY(task_id, fence) REFERENCES task_attempts(task_id, fence) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX task_checkpoints_attempt_idx ON task_checkpoints(task_id, execution_attempt, revision);

  PRAGMA user_version = 2;
`;

const MIGRATION_V3 = `
  CREATE TABLE scheduler_installation (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    installation_id TEXT NOT NULL UNIQUE CHECK(length(installation_id) = 32 AND installation_id NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
  ) STRICT;
  INSERT INTO scheduler_installation(singleton, installation_id, created_at_ms, updated_at_ms)
    VALUES(1, lower(hex(randomblob(16))), 0, 0);

  CREATE TABLE scheduler_jobs (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 200),
    name TEXT NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 80),
    generation INTEGER NOT NULL CHECK(generation >= 1),
    schedule TEXT NOT NULL CHECK(schedule IN ('daily','hourly','minutes')),
    interval_minutes INTEGER CHECK(interval_minutes IS NULL OR interval_minutes BETWEEN 1 AND 1440),
    action TEXT NOT NULL CHECK(length(action) BETWEEN 1 AND 100),
    args_json TEXT NOT NULL CHECK(json_valid(args_json) AND length(CAST(args_json AS BLOB)) BETWEEN 2 AND 262144),
    args_hash TEXT NOT NULL CHECK(length(args_hash) = 64 AND args_hash NOT GLOB '*[^0-9a-f]*'),
    spec_hash TEXT NOT NULL CHECK(length(spec_hash) = 64 AND spec_hash NOT GLOB '*[^0-9a-f]*'),
    desired_state TEXT NOT NULL CHECK(desired_state IN ('present','absent')),
    provider_state TEXT NOT NULL CHECK(provider_state IN ('pending','registered','removing','absent','error','uncertain')),
    provider_error_code TEXT CHECK(provider_error_code IS NULL OR length(provider_error_code) BETWEEN 1 AND 200),
    provider_error_message TEXT CHECK(provider_error_message IS NULL OR length(provider_error_message) <= 1000),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    removed_at_ms INTEGER CHECK(removed_at_ms IS NULL OR removed_at_ms >= created_at_ms),
    last_run_at_ms INTEGER CHECK(last_run_at_ms IS NULL OR last_run_at_ms >= created_at_ms),
    last_result_json TEXT CHECK(last_result_json IS NULL OR (json_valid(last_result_json) AND length(CAST(last_result_json AS BLOB)) BETWEEN 2 AND 262144)),
    last_result_hash TEXT CHECK(last_result_hash IS NULL OR (length(last_result_hash) = 64 AND last_result_hash NOT GLOB '*[^0-9a-f]*')),
    CHECK((desired_state = 'present' AND removed_at_ms IS NULL) OR (desired_state = 'absent' AND removed_at_ms IS NOT NULL)),
    CHECK((schedule = 'minutes' AND interval_minutes IS NOT NULL) OR (schedule <> 'minutes' AND interval_minutes IS NULL)),
    CHECK((last_result_json IS NULL AND last_result_hash IS NULL) OR (last_result_json IS NOT NULL AND last_result_hash IS NOT NULL)),
    CHECK((provider_state IN ('error','uncertain') AND provider_error_code IS NOT NULL AND provider_error_message IS NOT NULL) OR
      (provider_state NOT IN ('error','uncertain') AND provider_error_code IS NULL AND provider_error_message IS NULL))
  ) STRICT;
  CREATE INDEX scheduler_jobs_desired_idx ON scheduler_jobs(desired_state, provider_state, updated_at_ms, id);

  CREATE TABLE scheduler_registrations (
    job_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    task_name TEXT NOT NULL UNIQUE CHECK(length(task_name) BETWEEN 1 AND 238),
    ownership_marker TEXT NOT NULL UNIQUE CHECK(length(ownership_marker) = 64 AND ownership_marker NOT GLOB '*[^0-9a-f]*'),
    spec_json TEXT NOT NULL CHECK(json_valid(spec_json) AND length(CAST(spec_json AS BLOB)) BETWEEN 2 AND 262144),
    spec_hash TEXT NOT NULL CHECK(length(spec_hash) = 64 AND spec_hash NOT GLOB '*[^0-9a-f]*'),
    desired_state TEXT NOT NULL CHECK(desired_state IN ('present','absent')),
    observed_state TEXT NOT NULL CHECK(observed_state IN ('unknown','present','absent','conflict','error','uncertain')),
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 200),
    error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 1000),
    observed_at_ms INTEGER CHECK(observed_at_ms IS NULL OR observed_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    PRIMARY KEY(job_id, generation),
    FOREIGN KEY(job_id) REFERENCES scheduler_jobs(id) ON DELETE RESTRICT,
    CHECK((observed_state IN ('conflict','error','uncertain') AND error_code IS NOT NULL AND error_message IS NOT NULL) OR
      (observed_state NOT IN ('conflict','error','uncertain') AND error_code IS NULL AND error_message IS NULL))
  ) STRICT;
  CREATE INDEX scheduler_registrations_reconcile_idx ON scheduler_registrations(desired_state, observed_state, updated_at_ms, job_id, generation);

  CREATE TABLE scheduler_outbox (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 300),
    job_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    operation TEXT NOT NULL CHECK(operation IN ('ensure','delete')),
    status TEXT NOT NULL CHECK(status IN ('pending','executing','succeeded','retryable_failed','error','uncertain','superseded')),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
    lease_owner TEXT CHECK(lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 200),
    lease_token_hash TEXT CHECK(lease_token_hash IS NULL OR (length(lease_token_hash) = 64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
    lease_expires_at_ms INTEGER CHECK(lease_expires_at_ms IS NULL OR lease_expires_at_ms >= 0),
    available_at_ms INTEGER NOT NULL CHECK(available_at_ms >= 0),
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 200),
    error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 1000),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    completed_at_ms INTEGER CHECK(completed_at_ms IS NULL OR completed_at_ms >= created_at_ms),
    UNIQUE(job_id, generation, operation),
    FOREIGN KEY(job_id, generation) REFERENCES scheduler_registrations(job_id, generation) ON DELETE RESTRICT,
    CHECK((status = 'executing' AND lease_owner IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_expires_at_ms IS NOT NULL) OR
      (status <> 'executing' AND lease_owner IS NULL AND lease_token_hash IS NULL AND lease_expires_at_ms IS NULL)),
    CHECK((status IN ('succeeded','error','superseded') AND completed_at_ms IS NOT NULL) OR
      (status NOT IN ('succeeded','error','superseded') AND completed_at_ms IS NULL)),
    CHECK((status IN ('retryable_failed','error','uncertain') AND error_code IS NOT NULL AND error_message IS NOT NULL) OR
      (status NOT IN ('retryable_failed','error','uncertain') AND error_code IS NULL AND error_message IS NULL))
  ) STRICT;
  CREATE INDEX scheduler_outbox_claim_idx ON scheduler_outbox(status, available_at_ms, created_at_ms, id);
  CREATE INDEX scheduler_outbox_expiry_idx ON scheduler_outbox(status, lease_expires_at_ms);

  CREATE TABLE scheduler_attempts (
    outbox_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK(attempt >= 1),
    fence INTEGER NOT NULL CHECK(fence >= 1),
    owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 200),
    token_hash TEXT NOT NULL CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    operation TEXT NOT NULL CHECK(operation IN ('ensure','delete')),
    status TEXT NOT NULL CHECK(status IN ('executing','succeeded','retryable_failed','error','uncertain','superseded')),
    started_at_ms INTEGER NOT NULL CHECK(started_at_ms >= 0),
    ended_at_ms INTEGER CHECK(ended_at_ms IS NULL OR ended_at_ms >= started_at_ms),
    observation_json TEXT CHECK(observation_json IS NULL OR (json_valid(observation_json) AND length(CAST(observation_json AS BLOB)) BETWEEN 2 AND 262144)),
    observation_hash TEXT CHECK(observation_hash IS NULL OR (length(observation_hash) = 64 AND observation_hash NOT GLOB '*[^0-9a-f]*')),
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 200),
    error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 1000),
    PRIMARY KEY(outbox_id, attempt),
    FOREIGN KEY(outbox_id) REFERENCES scheduler_outbox(id) ON DELETE RESTRICT,
    CHECK((status = 'executing' AND ended_at_ms IS NULL) OR (status <> 'executing' AND ended_at_ms IS NOT NULL)),
    CHECK((observation_json IS NULL AND observation_hash IS NULL) OR (observation_json IS NOT NULL AND observation_hash IS NOT NULL)),
    CHECK((status IN ('retryable_failed','error','uncertain') AND error_code IS NOT NULL AND error_message IS NOT NULL) OR
      (status NOT IN ('retryable_failed','error','uncertain') AND error_code IS NULL AND error_message IS NULL))
  ) STRICT;
  CREATE INDEX scheduler_attempts_status_idx ON scheduler_attempts(status, started_at_ms, outbox_id);

  CREATE TABLE scheduler_legacy_import (
    source TEXT PRIMARY KEY CHECK(source = 'jobs'),
    source_path TEXT NOT NULL,
    digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    imported_at_ms INTEGER NOT NULL CHECK(imported_at_ms >= 0),
    records INTEGER NOT NULL CHECK(records >= 0),
    details_json TEXT NOT NULL CHECK(json_valid(details_json))
  ) STRICT;

  CREATE TABLE scheduler_runs (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 300),
    job_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 1),
    status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','uncertain','skipped')),
    fence INTEGER NOT NULL CHECK(fence >= 1),
    started_at_ms INTEGER NOT NULL CHECK(started_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= started_at_ms),
    ended_at_ms INTEGER CHECK(ended_at_ms IS NULL OR ended_at_ms >= started_at_ms),
    result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB)) BETWEEN 2 AND 262144)),
    result_hash TEXT CHECK(result_hash IS NULL OR (length(result_hash) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*')),
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 200),
    error_message TEXT CHECK(error_message IS NULL OR length(error_message) <= 1000),
    FOREIGN KEY(job_id, generation) REFERENCES scheduler_registrations(job_id, generation) ON DELETE RESTRICT,
    CHECK((status = 'running' AND ended_at_ms IS NULL) OR (status <> 'running' AND ended_at_ms IS NOT NULL)),
    CHECK((result_json IS NULL AND result_hash IS NULL) OR (result_json IS NOT NULL AND result_hash IS NOT NULL)),
    CHECK((status IN ('failed','uncertain','skipped') AND error_code IS NOT NULL AND error_message IS NOT NULL) OR
      (status IN ('running','succeeded') AND error_code IS NULL AND error_message IS NULL))
  ) STRICT;
  CREATE INDEX scheduler_runs_job_idx ON scheduler_runs(job_id, generation, started_at_ms DESC, id);

  PRAGMA user_version = 3;
`;

// Schema 3 was created by an earlier build before replacement continuity was
// modeled separately from desired generation. Keep its DDL byte-for-byte
// reproducible and add continuity as a real migration: production databases
// may already identify themselves as version 3.
const MIGRATION_V4 = `
  ALTER TABLE scheduler_jobs ADD COLUMN active_generation INTEGER
    CHECK(active_generation IS NULL OR (active_generation >= 1 AND active_generation <= generation AND desired_state = 'present'));
  UPDATE scheduler_jobs SET active_generation = generation
    WHERE desired_state = 'present'
      AND EXISTS(SELECT 1 FROM scheduler_registrations r
        WHERE r.job_id = scheduler_jobs.id AND r.generation = scheduler_jobs.generation
          AND r.desired_state = 'present' AND r.observed_state = 'present');
  UPDATE scheduler_runs SET status = 'uncertain', updated_at_ms = MAX(updated_at_ms, started_at_ms), ended_at_ms = MAX(updated_at_ms, started_at_ms),
    error_code = 'SCHEDULER_RUN_OVERLAP_MIGRATED', error_message = 'A duplicate active run was recovered during scheduler admission migration.'
    WHERE status = 'running' AND EXISTS(SELECT 1 FROM scheduler_runs newer
      WHERE newer.job_id = scheduler_runs.job_id AND newer.status = 'running'
        AND (newer.started_at_ms > scheduler_runs.started_at_ms OR
          (newer.started_at_ms = scheduler_runs.started_at_ms AND newer.id > scheduler_runs.id)));
  CREATE UNIQUE INDEX scheduler_runs_active_job_idx ON scheduler_runs(job_id) WHERE status = 'running';
  PRAGMA user_version = 4;
`;

const MIGRATION_V5 = `
  CREATE TABLE memory_entries (
    namespace TEXT NOT NULL CHECK(length(namespace) BETWEEN 1 AND 100),
    entry_key TEXT NOT NULL CHECK(length(entry_key) BETWEEN 1 AND 200),
    value_json TEXT NOT NULL CHECK(json_valid(value_json) AND length(CAST(value_json AS BLOB)) BETWEEN 1 AND ${MAX_MEMORY_VALUE_BYTES}),
    value_hash TEXT NOT NULL CHECK(length(value_hash) = 64 AND value_hash NOT GLOB '*[^0-9a-f]*'),
    note TEXT CHECK(note IS NULL OR length(note) <= ${MAX_MEMORY_NOTE_CHARS}),
    tags_json TEXT NOT NULL CHECK(json_valid(tags_json) AND length(CAST(tags_json AS BLOB)) BETWEEN 2 AND 4096),
    revision INTEGER NOT NULL CHECK(revision >= 1),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    PRIMARY KEY(namespace, entry_key)
  ) STRICT;
  CREATE INDEX memory_entries_search_idx ON memory_entries(namespace, updated_at_ms DESC, entry_key ASC);
  PRAGMA user_version = 5;
`;

const MIGRATION_V6 = `
  CREATE TABLE approval_grants (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 8 AND 200),
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    action TEXT NOT NULL CHECK(length(action) BETWEEN 3 AND 200),
    input_hash TEXT NOT NULL CHECK(length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
    status TEXT NOT NULL CHECK(status IN ('approved','consumed','expired')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
    consumed_at_ms INTEGER,
    CHECK((status = 'approved' AND consumed_at_ms IS NULL) OR
      (status = 'consumed' AND consumed_at_ms IS NOT NULL AND consumed_at_ms >= created_at_ms) OR
      (status = 'expired' AND consumed_at_ms IS NULL))
  ) STRICT;
  CREATE INDEX approval_grants_expiry_idx ON approval_grants(status, expires_at_ms);
  PRAGMA user_version = 6;
`;

const MIGRATION_V7 = `
  CREATE TABLE remote_asks (
    id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 16 AND 60 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
    yes_callback_hash TEXT NOT NULL UNIQUE CHECK(length(yes_callback_hash) = 64 AND yes_callback_hash NOT GLOB '*[^0-9a-f]*'),
    no_callback_hash TEXT NOT NULL UNIQUE CHECK(length(no_callback_hash) = 64 AND no_callback_hash NOT GLOB '*[^0-9a-f]*'),
    chat_id TEXT NOT NULL CHECK(length(chat_id) BETWEEN 1 AND 100),
    message_id INTEGER CHECK(message_id IS NULL OR message_id >= 0),
    status TEXT NOT NULL CHECK(status IN ('pending','yes','no','timeout','unavailable')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms > created_at_ms),
    resolved_at_ms INTEGER,
    resolution_update_id INTEGER CHECK(resolution_update_id IS NULL OR resolution_update_id >= 0),
    disarmed_at_ms INTEGER CHECK(disarmed_at_ms IS NULL OR disarmed_at_ms >= created_at_ms),
    error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 200),
    CHECK(yes_callback_hash <> no_callback_hash),
    CHECK(
      (status = 'pending' AND resolved_at_ms IS NULL AND resolution_update_id IS NULL AND error_code IS NULL)
      OR (status IN ('yes','no') AND resolved_at_ms IS NOT NULL AND resolution_update_id IS NOT NULL AND error_code IS NULL)
      OR (status = 'timeout' AND resolved_at_ms IS NOT NULL AND resolution_update_id IS NULL AND error_code IS NULL)
      OR (status = 'unavailable' AND resolved_at_ms IS NOT NULL AND resolution_update_id IS NULL AND error_code IS NOT NULL)
    )
  ) STRICT;
  CREATE INDEX remote_asks_status_expiry_idx ON remote_asks(status, expires_at_ms);
  PRAGMA user_version = 7;
`;

// Aggregate-only local-model accounting. Prompts and outputs never enter this
// table: it is solely a durable, per-day token ledger for model selection and
// operational inspection.
const MIGRATION_V8 = `
  CREATE TABLE model_usage_daily (
    usage_date TEXT NOT NULL CHECK(usage_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 200),
    prompt_tokens INTEGER NOT NULL CHECK(prompt_tokens >= 0),
    eval_tokens INTEGER NOT NULL CHECK(eval_tokens >= 0),
    calls INTEGER NOT NULL CHECK(calls >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
    PRIMARY KEY(usage_date, model)
  ) STRICT;
  CREATE INDEX model_usage_daily_model_date_idx ON model_usage_daily(model, usage_date DESC);
  PRAGMA user_version = 8;
`;

const MIGRATION_V9 = `
  CREATE TABLE tavily_usage_monthly (
    year_month TEXT PRIMARY KEY CHECK(year_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
    routine_credits INTEGER NOT NULL CHECK(routine_credits >= 0),
    research_credits INTEGER NOT NULL CHECK(research_credits >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
  ) STRICT;
  PRAGMA user_version = 9;
`;

const MIGRATION_V10 = `
  CREATE TABLE jarvis_missions (
    run_id TEXT PRIMARY KEY CHECK(length(run_id) = 36 AND run_id GLOB 'run-[0-9a-f]*'),
    task_id TEXT NOT NULL UNIQUE CHECK(length(task_id) BETWEEN 1 AND 500),
    owner_revision INTEGER NOT NULL CHECK(owner_revision >= 1),
    owner_json TEXT NOT NULL CHECK(json_valid(owner_json) AND length(CAST(owner_json AS BLOB)) BETWEEN 2 AND 65536),
    owner_hash TEXT NOT NULL CHECK(length(owner_hash) = 64 AND owner_hash NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX jarvis_missions_updated_idx ON jarvis_missions(updated_at_ms DESC, run_id);

  CREATE TABLE jarvis_phase_states (
    run_id TEXT NOT NULL CHECK(length(run_id) = 36 AND run_id GLOB 'run-[0-9a-f]*'),
    actor TEXT NOT NULL CHECK(actor IN ('human','codex','claude','gemini','jarvis')),
    task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 1 AND 500),
    attempt INTEGER NOT NULL CHECK(attempt >= 1),
    fence INTEGER NOT NULL CHECK(fence >= 1),
    phase INTEGER NOT NULL CHECK(phase BETWEEN 0 AND 24),
    phase_status TEXT NOT NULL CHECK(phase_status IN ('idle','running','continuation','blocked','completed','cancelled','uncertain')),
    shared_revision INTEGER NOT NULL CHECK(shared_revision >= 1),
    scratch_summary TEXT NOT NULL CHECK(length(scratch_summary) <= 2000),
    resume_summary TEXT NOT NULL CHECK(length(resume_summary) <= 2000),
    cursor TEXT NOT NULL CHECK(length(cursor) <= 500),
    retry_count INTEGER NOT NULL CHECK(retry_count BETWEEN 0 AND 5),
    next_action TEXT NOT NULL CHECK(length(next_action) <= 240),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
    PRIMARY KEY(run_id, actor),
    FOREIGN KEY(run_id) REFERENCES jarvis_missions(run_id) ON DELETE CASCADE,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX jarvis_phase_states_run_idx ON jarvis_phase_states(run_id, updated_at_ms DESC, actor);
  PRAGMA user_version = 10;
`;

// Q11 acceptance records are kept in the broker's durable state database, not
// in a worker-owned file.  The unique constraints make a restart replay safe
// while refusing the same identifier with different semantic content.
const MIGRATION_V11 = `
  CREATE TABLE jarvis_workflow_missions (
    run_id TEXT PRIMARY KEY CHECK(length(run_id) = 36 AND run_id GLOB 'run-[0-9a-f]*'),
    task_id TEXT NOT NULL UNIQUE CHECK(length(task_id) BETWEEN 1 AND 500),
    mission_id TEXT NOT NULL UNIQUE CHECK(length(mission_id) BETWEEN 3 AND 160 AND mission_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    mission_hash TEXT NOT NULL CHECK(length(mission_hash) = 64 AND mission_hash NOT GLOB '*[^0-9a-f]*'),
    contract_json TEXT NOT NULL CHECK(json_valid(contract_json) AND length(CAST(contract_json AS BLOB)) BETWEEN 2 AND 65536),
    contract_hash TEXT NOT NULL CHECK(length(contract_hash) = 64 AND contract_hash NOT GLOB '*[^0-9a-f]*'),
    owner_revision INTEGER NOT NULL CHECK(owner_revision >= 1),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    FOREIGN KEY(run_id) REFERENCES jarvis_missions(run_id) ON DELETE CASCADE,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX jarvis_workflow_missions_task_idx ON jarvis_workflow_missions(task_id, updated_at_ms DESC);

  CREATE TABLE jarvis_broker_verifications (
    run_id TEXT NOT NULL CHECK(length(run_id) = 36 AND run_id GLOB 'run-[0-9a-f]*'),
    execution_role TEXT NOT NULL CHECK(execution_role IN ('baseline','candidate')),
    execution_id TEXT NOT NULL CHECK(length(execution_id) BETWEEN 3 AND 160 AND execution_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    record_json TEXT NOT NULL CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 2 AND 262144),
    record_hash TEXT NOT NULL CHECK(length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
    owner_revision INTEGER NOT NULL CHECK(owner_revision >= 1),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    PRIMARY KEY(run_id, execution_role),
    UNIQUE(run_id, execution_id),
    FOREIGN KEY(run_id) REFERENCES jarvis_workflow_missions(run_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE jarvis_workflow_events (
    event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 3 AND 160 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    run_id TEXT NOT NULL CHECK(length(run_id) = 36 AND run_id GLOB 'run-[0-9a-f]*'),
    mission_id TEXT NOT NULL CHECK(length(mission_id) BETWEEN 3 AND 160 AND mission_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    event_hash TEXT NOT NULL CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
    event_json TEXT NOT NULL CHECK(json_valid(event_json) AND length(CAST(event_json AS BLOB)) BETWEEN 2 AND 262144),
    occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    UNIQUE(run_id, event_hash),
    FOREIGN KEY(run_id) REFERENCES jarvis_workflow_missions(run_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE jarvis_workflow_outbox (
    outbox_id TEXT PRIMARY KEY CHECK(length(outbox_id) BETWEEN 3 AND 160 AND outbox_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    run_id TEXT NOT NULL CHECK(length(run_id) = 36 AND run_id GLOB 'run-[0-9a-f]*'),
    event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 3 AND 160),
    event_hash TEXT NOT NULL CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
    event_json TEXT NOT NULL CHECK(json_valid(event_json) AND length(CAST(event_json AS BLOB)) BETWEEN 2 AND 262144),
    status TEXT NOT NULL CHECK(status IN ('pending','leased','delivered')),
    fence INTEGER NOT NULL CHECK(fence >= 0),
    lease_worker_label TEXT,
    lease_token_hash TEXT,
    lease_expires_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    delivered_at_ms INTEGER,
    CHECK(
      (status = 'pending' AND lease_worker_label IS NULL AND lease_token_hash IS NULL AND lease_expires_at_ms IS NULL AND delivered_at_ms IS NULL)
      OR (status = 'leased' AND lease_worker_label IS NOT NULL AND lease_token_hash IS NOT NULL AND length(lease_token_hash) = 64 AND lease_expires_at_ms IS NOT NULL AND delivered_at_ms IS NULL)
      OR (status = 'delivered' AND lease_worker_label IS NULL AND lease_token_hash IS NULL AND lease_expires_at_ms IS NULL AND delivered_at_ms IS NOT NULL)
    ),
    FOREIGN KEY(event_id) REFERENCES jarvis_workflow_events(event_id) ON DELETE CASCADE,
    FOREIGN KEY(run_id) REFERENCES jarvis_workflow_missions(run_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX jarvis_workflow_outbox_delivery_idx ON jarvis_workflow_outbox(run_id, status, created_at_ms, outbox_id);

  CREATE TABLE jarvis_workflow_acceptances (
    run_id TEXT PRIMARY KEY CHECK(length(run_id) = 36 AND run_id GLOB 'run-[0-9a-f]*'),
    task_id TEXT NOT NULL UNIQUE CHECK(length(task_id) BETWEEN 1 AND 500),
    mission_id TEXT NOT NULL CHECK(length(mission_id) BETWEEN 3 AND 160 AND mission_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    mission_hash TEXT NOT NULL CHECK(length(mission_hash) = 64 AND mission_hash NOT GLOB '*[^0-9a-f]*'),
    owner_revision INTEGER NOT NULL CHECK(owner_revision >= 1),
    acceptance_json TEXT NOT NULL CHECK(json_valid(acceptance_json) AND length(CAST(acceptance_json AS BLOB)) BETWEEN 2 AND 524288),
    acceptance_hash TEXT NOT NULL CHECK(length(acceptance_hash) = 64 AND acceptance_hash NOT GLOB '*[^0-9a-f]*'),
    result_hash TEXT NOT NULL CHECK(length(result_hash) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*'),
    event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 3 AND 160),
    accepted_at_ms INTEGER NOT NULL CHECK(accepted_at_ms >= 0),
    FOREIGN KEY(run_id) REFERENCES jarvis_workflow_missions(run_id) ON DELETE CASCADE,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY(event_id) REFERENCES jarvis_workflow_events(event_id) ON DELETE CASCADE
  ) STRICT;
  PRAGMA user_version = 11;
`;

// P12 keeps resolved capability profiles in the existing durable broker state.
// Profile bodies never update in place: new scope means a new version and
// revocation is an append-only separate fact.  SQLite triggers protect this
// property even if a future caller bypasses the Node adapter.
const MIGRATION_V12 = `
  CREATE TABLE capability_profile_versions (
    profile_id TEXT NOT NULL CHECK(length(profile_id) BETWEEN 3 AND 120 AND profile_id NOT GLOB '*[^a-z0-9._-]*'),
    version INTEGER NOT NULL CHECK(version >= 1),
    task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 8 AND 200),
    manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(CAST(manifest_json AS BLOB)) BETWEEN 2 AND 131072),
    manifest_hash TEXT NOT NULL UNIQUE CHECK(length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
    parent_hash TEXT CHECK(parent_hash IS NULL OR (length(parent_hash) = 64 AND parent_hash NOT GLOB '*[^0-9a-f]*')),
    expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 1),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    PRIMARY KEY(profile_id, version),
    UNIQUE(task_id, manifest_hash),
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    CHECK((version = 1 AND parent_hash IS NULL) OR (version > 1 AND parent_hash IS NOT NULL))
  ) STRICT;
  CREATE INDEX capability_profile_versions_task_idx ON capability_profile_versions(task_id, created_at_ms DESC, profile_id, version);

  CREATE TABLE capability_profile_bindings (
    task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 8 AND 200),
    binding_kind TEXT NOT NULL CHECK(binding_kind IN ('delegation','tool')),
    binding_id TEXT NOT NULL CHECK(length(binding_id) BETWEEN 3 AND 200 AND binding_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    profile_id TEXT NOT NULL CHECK(length(profile_id) BETWEEN 3 AND 120 AND profile_id NOT GLOB '*[^a-z0-9._-]*'),
    profile_version INTEGER NOT NULL CHECK(profile_version >= 1),
    profile_hash TEXT NOT NULL CHECK(length(profile_hash) = 64 AND profile_hash NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    PRIMARY KEY(task_id, binding_kind, binding_id),
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY(profile_id, profile_version) REFERENCES capability_profile_versions(profile_id, version) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX capability_profile_bindings_profile_idx ON capability_profile_bindings(profile_id, profile_version, task_id);

  CREATE TABLE capability_profile_requests (
    request_id TEXT PRIMARY KEY CHECK(length(request_id) BETWEEN 8 AND 200 AND request_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 8 AND 200),
    request_kind TEXT NOT NULL CHECK(request_kind IN ('tool','delegation','expansion')),
    profile_id TEXT NOT NULL CHECK(length(profile_id) BETWEEN 3 AND 120 AND profile_id NOT GLOB '*[^a-z0-9._-]*'),
    profile_version INTEGER NOT NULL CHECK(profile_version >= 1),
    profile_hash TEXT NOT NULL CHECK(length(profile_hash) = 64 AND profile_hash NOT GLOB '*[^0-9a-f]*'),
    request_hash TEXT NOT NULL UNIQUE CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB)) BETWEEN 2 AND 32768),
    status TEXT NOT NULL CHECK(status IN ('authorized','requested')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY(profile_id, profile_version) REFERENCES capability_profile_versions(profile_id, version) ON DELETE RESTRICT,
    CHECK((request_kind = 'expansion' AND status = 'requested') OR (request_kind IN ('tool','delegation') AND status = 'authorized'))
  ) STRICT;
  CREATE INDEX capability_profile_requests_task_idx ON capability_profile_requests(task_id, created_at_ms DESC, request_id);

  CREATE TABLE capability_profile_revocations (
    profile_id TEXT NOT NULL CHECK(length(profile_id) BETWEEN 3 AND 120 AND profile_id NOT GLOB '*[^a-z0-9._-]*'),
    profile_version INTEGER NOT NULL CHECK(profile_version >= 1),
    profile_hash TEXT NOT NULL CHECK(length(profile_hash) = 64 AND profile_hash NOT GLOB '*[^0-9a-f]*'),
    reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 3 AND 120 AND reason_code NOT GLOB '*[^a-z0-9._-]*'),
    revoked_at_ms INTEGER NOT NULL CHECK(revoked_at_ms >= 0),
    PRIMARY KEY(profile_id, profile_version),
    FOREIGN KEY(profile_id, profile_version) REFERENCES capability_profile_versions(profile_id, version) ON DELETE RESTRICT
  ) STRICT;

  CREATE TRIGGER capability_profile_versions_no_update BEFORE UPDATE ON capability_profile_versions
    BEGIN SELECT RAISE(ABORT, 'immutable capability profile version'); END;
  CREATE TRIGGER capability_profile_versions_no_delete BEFORE DELETE ON capability_profile_versions
    BEGIN SELECT RAISE(ABORT, 'immutable capability profile version'); END;
  CREATE TRIGGER capability_profile_bindings_no_update BEFORE UPDATE ON capability_profile_bindings
    BEGIN SELECT RAISE(ABORT, 'immutable capability profile binding'); END;
  CREATE TRIGGER capability_profile_bindings_no_delete BEFORE DELETE ON capability_profile_bindings
    BEGIN SELECT RAISE(ABORT, 'immutable capability profile binding'); END;
  CREATE TRIGGER capability_profile_requests_no_update BEFORE UPDATE ON capability_profile_requests
    BEGIN SELECT RAISE(ABORT, 'immutable capability profile request'); END;
  CREATE TRIGGER capability_profile_requests_no_delete BEFORE DELETE ON capability_profile_requests
    BEGIN SELECT RAISE(ABORT, 'immutable capability profile request'); END;
  CREATE TRIGGER capability_profile_revocations_no_update BEFORE UPDATE ON capability_profile_revocations
    BEGIN SELECT RAISE(ABORT, 'immutable capability profile revocation'); END;
  CREATE TRIGGER capability_profile_revocations_no_delete BEFORE DELETE ON capability_profile_revocations
    BEGIN SELECT RAISE(ABORT, 'immutable capability profile revocation'); END;

  PRAGMA user_version = 12;
`;

// P13 dispatch authorizations are intentionally separate from P12 profiles:
// P12 grants bounded capability; this append-only record binds one exact
// prepared invocation's P08 provenance, target, and canonical argument hash.
// Consumption is a separate immutable fact, so a stale worker cannot replay a
// once-authorized consequential request after a crash or handoff.
const MIGRATION_V13 = `
  CREATE TABLE policy_dispatch_authorizations (
    authorization_id TEXT PRIMARY KEY CHECK(length(authorization_id) BETWEEN 8 AND 200 AND authorization_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 8 AND 200),
    tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 3 AND 200 AND tool_name NOT GLOB '*[^a-z0-9._]*'),
    args_hash TEXT NOT NULL CHECK(length(args_hash) = 64 AND args_hash NOT GLOB '*[^0-9a-f]*'),
    target_kind TEXT NOT NULL CHECK(target_kind IN ('local','external','account','secret','browser-session','finance','agent')),
    target_hash TEXT NOT NULL CHECK(length(target_hash) = 64 AND target_hash NOT GLOB '*[^0-9a-f]*'),
    provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json) AND length(CAST(provenance_json AS BLOB)) BETWEEN 2 AND 65536),
    risk TEXT NOT NULL CHECK(risk IN ('low','medium','high','critical')),
    delegation_depth INTEGER NOT NULL CHECK(delegation_depth BETWEEN 0 AND 16),
    user_kind TEXT NOT NULL CHECK(user_kind IN ('owner-authenticated','agent','unknown')),
    profile_id TEXT NOT NULL CHECK(length(profile_id) BETWEEN 3 AND 120),
    profile_version INTEGER NOT NULL CHECK(profile_version >= 1),
    profile_hash TEXT NOT NULL CHECK(length(profile_hash) = 64 AND profile_hash NOT GLOB '*[^0-9a-f]*'),
    request_hash TEXT NOT NULL CHECK(length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    UNIQUE(task_id, args_hash),
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY(profile_id, profile_version) REFERENCES capability_profile_versions(profile_id, version) ON DELETE RESTRICT,
    FOREIGN KEY(request_hash) REFERENCES capability_profile_requests(request_hash) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX policy_dispatch_authorizations_task_idx ON policy_dispatch_authorizations(task_id, created_at_ms DESC, authorization_id);

  CREATE TABLE policy_dispatch_consumptions (
    authorization_id TEXT PRIMARY KEY,
    args_hash TEXT NOT NULL CHECK(length(args_hash) = 64 AND args_hash NOT GLOB '*[^0-9a-f]*'),
    consumed_at_ms INTEGER NOT NULL CHECK(consumed_at_ms >= 0),
    FOREIGN KEY(authorization_id) REFERENCES policy_dispatch_authorizations(authorization_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TRIGGER policy_dispatch_authorizations_no_update BEFORE UPDATE ON policy_dispatch_authorizations
    BEGIN SELECT RAISE(ABORT, 'immutable policy dispatch authorization'); END;
  CREATE TRIGGER policy_dispatch_authorizations_no_delete BEFORE DELETE ON policy_dispatch_authorizations
    BEGIN SELECT RAISE(ABORT, 'immutable policy dispatch authorization'); END;
  CREATE TRIGGER policy_dispatch_consumptions_no_update BEFORE UPDATE ON policy_dispatch_consumptions
    BEGIN SELECT RAISE(ABORT, 'immutable policy dispatch consumption'); END;
  CREATE TRIGGER policy_dispatch_consumptions_no_delete BEFORE DELETE ON policy_dispatch_consumptions
    BEGIN SELECT RAISE(ABORT, 'immutable policy dispatch consumption'); END;
  PRAGMA user_version = 13;
`;

// P13 confirmation evidence is append-only with the dispatch consumption. It
// references the existing canonical approval grant by opaque ID; the matching
// action/input hash and consumed status are checked transactionally at use.
const MIGRATION_V14 = `
  ALTER TABLE policy_dispatch_consumptions ADD COLUMN approval_id TEXT
    CHECK(approval_id IS NULL OR (length(approval_id) BETWEEN 8 AND 200));
  PRAGMA user_version = 14;
`;

// An approval is a single-use authorization fact.  P13 records the exact
// attachment as part of its immutable consumption, so the same consumed grant
// cannot authorize two independently prepared dispatches, even across tasks.
const MIGRATION_V15 = `
  CREATE UNIQUE INDEX policy_dispatch_consumptions_approval_once_idx
    ON policy_dispatch_consumptions(approval_id)
    WHERE approval_id IS NOT NULL;
  PRAGMA user_version = 15;
`;

// P14 keeps the controller-created action, its broker-owned P08 evidence
// reference, UI decision, and final P13 dispatch consumption in one durable
// authority.  The action is immutable; its append-only event stream carries
// every terminal outcome rather than rewriting a mutable approval status.
const MIGRATION_V16 = `
  CREATE TABLE scoped_approval_provenance (
    evidence_id TEXT PRIMARY KEY CHECK(length(evidence_id) BETWEEN 8 AND 200 AND evidence_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 8 AND 200),
    provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json) AND length(CAST(provenance_json AS BLOB)) BETWEEN 2 AND 65536),
    provenance_hash TEXT NOT NULL CHECK(length(provenance_hash) = 64 AND provenance_hash NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE scoped_approval_actions (
    approval_id TEXT PRIMARY KEY CHECK(length(approval_id) BETWEEN 8 AND 200 AND approval_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    authorization_id TEXT NOT NULL UNIQUE CHECK(length(authorization_id) BETWEEN 8 AND 200),
    task_id TEXT NOT NULL CHECK(length(task_id) BETWEEN 8 AND 200),
    tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 3 AND 200 AND tool_name NOT GLOB '*[^a-z0-9._]*'),
    args_hash TEXT NOT NULL CHECK(length(args_hash) = 64 AND args_hash NOT GLOB '*[^0-9a-f]*'),
    target_kind TEXT NOT NULL CHECK(target_kind IN ('local','external','account','secret','browser-session','finance','agent')),
    target_hash TEXT NOT NULL CHECK(length(target_hash) = 64 AND target_hash NOT GLOB '*[^0-9a-f]*'),
    parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json) AND length(CAST(parameters_json AS BLOB)) BETWEEN 2 AND 65536),
    parameters_hash TEXT NOT NULL CHECK(length(parameters_hash) = 64 AND parameters_hash NOT GLOB '*[^0-9a-f]*'),
    subject_json TEXT NOT NULL CHECK(json_valid(subject_json) AND length(CAST(subject_json AS BLOB)) BETWEEN 2 AND 512),
    subject_hash TEXT NOT NULL CHECK(length(subject_hash) = 64 AND subject_hash NOT GLOB '*[^0-9a-f]*'),
    provenance_evidence_id TEXT NOT NULL CHECK(length(provenance_evidence_id) BETWEEN 8 AND 200),
    provenance_hash TEXT NOT NULL CHECK(length(provenance_hash) = 64 AND provenance_hash NOT GLOB '*[^0-9a-f]*'),
    preview_hash TEXT NOT NULL CHECK(length(preview_hash) = 64 AND preview_hash NOT GLOB '*[^0-9a-f]*'),
    expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    FOREIGN KEY(authorization_id) REFERENCES policy_dispatch_authorizations(authorization_id) ON DELETE RESTRICT,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY(provenance_evidence_id) REFERENCES scoped_approval_provenance(evidence_id) ON DELETE RESTRICT,
    CHECK(expires_at_ms > created_at_ms)
  ) STRICT;
  CREATE INDEX scoped_approval_actions_expiry_idx ON scoped_approval_actions(expires_at_ms, approval_id);

  CREATE TABLE scoped_approval_grants (
    approval_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    approved_at_ms INTEGER NOT NULL CHECK(approved_at_ms >= 0),
    FOREIGN KEY(approval_id) REFERENCES scoped_approval_actions(approval_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE scoped_approval_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id TEXT NOT NULL CHECK(length(approval_id) BETWEEN 8 AND 200),
    event_type TEXT NOT NULL CHECK(event_type IN ('created','approved','declined','cancelled','revoked','expired','mismatch','consumed')),
    reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 3 AND 120 AND reason_code NOT GLOB '*[^A-Z0-9_]*'),
    event_hash TEXT NOT NULL UNIQUE CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
    occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
    FOREIGN KEY(approval_id) REFERENCES scoped_approval_actions(approval_id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX scoped_approval_events_current_idx ON scoped_approval_events(approval_id, sequence DESC);

  CREATE TRIGGER scoped_approval_provenance_no_update BEFORE UPDATE ON scoped_approval_provenance
    BEGIN SELECT RAISE(ABORT, 'immutable scoped approval provenance'); END;
  CREATE TRIGGER scoped_approval_provenance_no_delete BEFORE DELETE ON scoped_approval_provenance
    BEGIN SELECT RAISE(ABORT, 'immutable scoped approval provenance'); END;
  CREATE TRIGGER scoped_approval_actions_no_update BEFORE UPDATE ON scoped_approval_actions
    BEGIN SELECT RAISE(ABORT, 'immutable scoped approval action'); END;
  CREATE TRIGGER scoped_approval_actions_no_delete BEFORE DELETE ON scoped_approval_actions
    BEGIN SELECT RAISE(ABORT, 'immutable scoped approval action'); END;
  CREATE TRIGGER scoped_approval_grants_no_update BEFORE UPDATE ON scoped_approval_grants
    BEGIN SELECT RAISE(ABORT, 'immutable scoped approval grant'); END;
  CREATE TRIGGER scoped_approval_grants_no_delete BEFORE DELETE ON scoped_approval_grants
    BEGIN SELECT RAISE(ABORT, 'immutable scoped approval grant'); END;
  CREATE TRIGGER scoped_approval_events_no_update BEFORE UPDATE ON scoped_approval_events
    BEGIN SELECT RAISE(ABORT, 'immutable scoped approval event'); END;
  CREATE TRIGGER scoped_approval_events_no_delete BEFORE DELETE ON scoped_approval_events
    BEGIN SELECT RAISE(ABORT, 'immutable scoped approval event'); END;
  PRAGMA user_version = 16;
`;

// MIGRATION_V17 AND V18 STILL CREATE THE CERBERUS CORRECTION TABLES, AND THEY HAVE TO.
//
// The Cerberus system is not part of this product -- MIGRATION_V20 below drops these tables
// and every line of code that read or wrote them is gone. These two steps are kept intact
// anyway, and an earlier version of this change deleted their bodies, which would have
// BRICKED EVERY EXISTING INSTALLATION. _migrate() validates a database against the schema
// its recorded version PROMISED before it applies any upgrade ("never apply an upgrade over
// a database whose existing version does not exactly match"). A real database at 17, 18 or
// 19 has these tables. Emptying these constants makes expectedSchemaFingerprint(19) describe
// a database that never existed, so the pre-upgrade check fails, the upgrade never runs, and
// the store refuses to open at all. That failure was caught by the migration test below
// rather than by review, which is why that test seeds a genuine legacy database.
//
// So the DDL here is HISTORY, not a live feature: it records what these versions did, so
// that a database written by them can still be recognised and then upgraded past them.
const MIGRATION_V17 = `
  CREATE TABLE cerberus_correction_closures (
    closure_family_id TEXT PRIMARY KEY CHECK(length(closure_family_id) = 64 AND closure_family_id NOT GLOB '*[^0-9a-f]*'),
    source_run_id TEXT NOT NULL UNIQUE CHECK(length(source_run_id) = 36 AND source_run_id GLOB 'run-[0-9a-f]*'),
    source_task_id TEXT NOT NULL UNIQUE CHECK(length(source_task_id) BETWEEN 1 AND 500),
    mission_hash TEXT NOT NULL CHECK(length(mission_hash) = 64 AND mission_hash NOT GLOB '*[^0-9a-f]*'),
    owner_revision INTEGER NOT NULL CHECK(owner_revision >= 1),
    closure_ref_hash TEXT NOT NULL UNIQUE CHECK(length(closure_ref_hash) = 64 AND closure_ref_hash NOT GLOB '*[^0-9a-f]*'),
    acceptance_ref_hash TEXT NOT NULL UNIQUE CHECK(length(acceptance_ref_hash) = 64 AND acceptance_ref_hash NOT GLOB '*[^0-9a-f]*'),
    issuer TEXT NOT NULL CHECK(issuer = 'toolsenabled-broker-v1'),
    purpose TEXT NOT NULL CHECK(purpose = 'correction-closure-observation'),
    acceptance_scope TEXT NOT NULL CHECK(acceptance_scope = 'correction-closure-proof'),
    catalog_digest TEXT NOT NULL CHECK(length(catalog_digest) = 64 AND catalog_digest NOT GLOB '*[^0-9a-f]*'),
    status TEXT NOT NULL CHECK(status = 'resolved'),
    FOREIGN KEY(source_run_id) REFERENCES jarvis_workflow_missions(run_id) ON DELETE RESTRICT,
    FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE cerberus_correction_evidence (
    evidence_id TEXT PRIMARY KEY CHECK(length(evidence_id) = 64 AND evidence_id NOT GLOB '*[^0-9a-f]*'),
    closure_family_id TEXT NOT NULL CHECK(length(closure_family_id) = 64 AND closure_family_id NOT GLOB '*[^0-9a-f]*'),
    source_run_id TEXT NOT NULL CHECK(length(source_run_id) = 36 AND source_run_id GLOB 'run-[0-9a-f]*'),
    task_fence INTEGER NOT NULL CHECK(task_fence >= 1),
    owner_revision INTEGER NOT NULL CHECK(owner_revision >= 1),
    catalog_digest TEXT NOT NULL CHECK(length(catalog_digest) = 64 AND catalog_digest NOT GLOB '*[^0-9a-f]*'),
    broker_epoch_digest TEXT NOT NULL CHECK(length(broker_epoch_digest) = 64 AND broker_epoch_digest NOT GLOB '*[^0-9a-f]*'),
    resolver_policy_digest TEXT NOT NULL CHECK(length(resolver_policy_digest) = 64 AND resolver_policy_digest NOT GLOB '*[^0-9a-f]*'),
    verifier_catalog_digest TEXT NOT NULL CHECK(length(verifier_catalog_digest) = 64 AND verifier_catalog_digest NOT GLOB '*[^0-9a-f]*'),
    verifier_entry_digest TEXT NOT NULL CHECK(length(verifier_entry_digest) = 64 AND verifier_entry_digest NOT GLOB '*[^0-9a-f]*'),
    taxonomy_catalog_digest TEXT NOT NULL CHECK(length(taxonomy_catalog_digest) = 64 AND taxonomy_catalog_digest NOT GLOB '*[^0-9a-f]*'),
    projection_policy_digest TEXT NOT NULL CHECK(length(projection_policy_digest) = 64 AND projection_policy_digest NOT GLOB '*[^0-9a-f]*'),
    source_clearance_digest TEXT NOT NULL CHECK(length(source_clearance_digest) = 64 AND source_clearance_digest NOT GLOB '*[^0-9a-f]*'),
    audit_head_sequence INTEGER NOT NULL CHECK(audit_head_sequence >= 0),
    audit_head_hash TEXT NOT NULL CHECK(length(audit_head_hash) = 64 AND audit_head_hash NOT GLOB '*[^0-9a-f]*'),
    arbiter_epoch INTEGER NOT NULL CHECK(arbiter_epoch = 1),
    arbiter_epoch_digest TEXT NOT NULL CHECK(length(arbiter_epoch_digest) = 64 AND arbiter_epoch_digest NOT GLOB '*[^0-9a-f]*'),
    status TEXT NOT NULL CHECK(status = 'resolved'),
    UNIQUE(source_run_id, task_fence, catalog_digest),
    FOREIGN KEY(closure_family_id) REFERENCES cerberus_correction_closures(closure_family_id) ON DELETE RESTRICT,
    FOREIGN KEY(source_run_id) REFERENCES jarvis_workflow_missions(run_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE cerberus_correction_handle_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    closure_family_id TEXT NOT NULL CHECK(length(closure_family_id) = 64 AND closure_family_id NOT GLOB '*[^0-9a-f]*'),
    evidence_id TEXT NOT NULL CHECK(length(evidence_id) = 64 AND evidence_id NOT GLOB '*[^0-9a-f]*'),
    event_type TEXT NOT NULL CHECK(event_type IN ('issued', 'revoked', 'superseded')),
    reason_code TEXT CHECK(reason_code IS NULL OR (length(reason_code) BETWEEN 3 AND 80 AND reason_code NOT GLOB '*[^a-z0-9._-]*')),
    FOREIGN KEY(closure_family_id) REFERENCES cerberus_correction_closures(closure_family_id) ON DELETE RESTRICT,
    FOREIGN KEY(evidence_id) REFERENCES cerberus_correction_evidence(evidence_id) ON DELETE RESTRICT,
    CHECK((event_type = 'issued' AND reason_code IS NULL) OR (event_type IN ('revoked', 'superseded') AND reason_code IS NOT NULL))
  ) STRICT;

  CREATE TABLE cerberus_correction_episodes (
    evidence_id TEXT PRIMARY KEY CHECK(length(evidence_id) = 64 AND evidence_id NOT GLOB '*[^0-9a-f]*'),
    episode_json TEXT NOT NULL CHECK(json_valid(episode_json) AND length(CAST(episode_json AS BLOB)) BETWEEN 2 AND 2048),
    task_class TEXT NOT NULL CHECK(task_class = 'broker-authoritative-workflow'),
    taxonomy TEXT NOT NULL CHECK(taxonomy = 'broker-verified-fault-fix'),
    check_intent TEXT NOT NULL CHECK(check_intent = 'run-current-isolated-adversarial-verifier'),
    current_verifier_required INTEGER NOT NULL CHECK(current_verifier_required = 1),
    training_state TEXT NOT NULL CHECK(training_state = 'quarantined-not-admitted'),
    authority_effect TEXT NOT NULL CHECK(authority_effect = 'none'),
    FOREIGN KEY(evidence_id) REFERENCES cerberus_correction_evidence(evidence_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TRIGGER cerberus_correction_closures_no_update BEFORE UPDATE ON cerberus_correction_closures
    BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction closure'); END;
  CREATE TRIGGER cerberus_correction_closures_no_delete BEFORE DELETE ON cerberus_correction_closures
    BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction closure'); END;
  CREATE TRIGGER cerberus_correction_evidence_no_update BEFORE UPDATE ON cerberus_correction_evidence
    BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction evidence'); END;
  CREATE TRIGGER cerberus_correction_evidence_no_delete BEFORE DELETE ON cerberus_correction_evidence
    BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction evidence'); END;
  CREATE TRIGGER cerberus_correction_handle_events_no_update BEFORE UPDATE ON cerberus_correction_handle_events
    BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction handle event'); END;
  CREATE TRIGGER cerberus_correction_handle_events_no_delete BEFORE DELETE ON cerberus_correction_handle_events
    BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction handle event'); END;
  CREATE TRIGGER cerberus_correction_episodes_no_update BEFORE UPDATE ON cerberus_correction_episodes
    BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction episode'); END;
  CREATE TRIGGER cerberus_correction_episodes_no_delete BEFORE DELETE ON cerberus_correction_episodes
    BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction episode'); END;

  PRAGMA user_version = 17;
`;

const MIGRATION_V18 = `
  CREATE TABLE cerberus_correction_acceptance_bindings (
    evidence_id TEXT PRIMARY KEY CHECK(length(evidence_id) = 64 AND evidence_id NOT GLOB '*[^0-9a-f]*'),
    closure_family_id TEXT NOT NULL UNIQUE CHECK(length(closure_family_id) = 64 AND closure_family_id NOT GLOB '*[^0-9a-f]*'),
    source_run_id TEXT NOT NULL UNIQUE CHECK(length(source_run_id) = 36 AND source_run_id GLOB 'run-[0-9a-f]*'),
    source_task_id TEXT NOT NULL UNIQUE CHECK(length(source_task_id) BETWEEN 1 AND 500),
    acceptance_hash TEXT NOT NULL CHECK(length(acceptance_hash) = 64 AND acceptance_hash NOT GLOB '*[^0-9a-f]*'),
    event_id TEXT NOT NULL UNIQUE CHECK(length(event_id) BETWEEN 3 AND 160 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
    event_hash TEXT NOT NULL CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
    baseline_record_hash TEXT NOT NULL CHECK(length(baseline_record_hash) = 64 AND baseline_record_hash NOT GLOB '*[^0-9a-f]*'),
    candidate_record_hash TEXT NOT NULL CHECK(length(candidate_record_hash) = 64 AND candidate_record_hash NOT GLOB '*[^0-9a-f]*'),
    bound_at_ms INTEGER NOT NULL CHECK(bound_at_ms >= 0),
    FOREIGN KEY(evidence_id) REFERENCES cerberus_correction_evidence(evidence_id) ON DELETE RESTRICT,
    FOREIGN KEY(closure_family_id) REFERENCES cerberus_correction_closures(closure_family_id) ON DELETE RESTRICT,
    FOREIGN KEY(source_run_id) REFERENCES jarvis_workflow_acceptances(run_id) ON DELETE RESTRICT,
    FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY(event_id) REFERENCES jarvis_workflow_events(event_id) ON DELETE RESTRICT
  ) STRICT;
  CREATE TRIGGER cerberus_correction_acceptance_bindings_no_update BEFORE UPDATE ON cerberus_correction_acceptance_bindings
    BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction acceptance binding'); END;
  CREATE TRIGGER cerberus_correction_acceptance_bindings_no_delete BEFORE DELETE ON cerberus_correction_acceptance_bindings
    BEGIN SELECT RAISE(ABORT, 'immutable cerberus correction acceptance binding'); END;
  PRAGMA user_version = 18;
`;

// V19 adds a Discord-specific Gateway/session domain without changing the
// established Telegram polling tables or behavior. Only normalized,
// owner-filtered MESSAGE_CREATE fields are retained; the raw dispatch is not.
const MIGRATION_V19 = `
  CREATE TABLE discord_gateway_state (
    provider TEXT PRIMARY KEY CHECK(provider = 'discord'),
    session_id TEXT CHECK(session_id IS NULL OR length(session_id) BETWEEN 1 AND 256),
    resume_gateway_url TEXT CHECK(resume_gateway_url IS NULL OR length(resume_gateway_url) BETWEEN 6 AND 2048),
    sequence INTEGER CHECK(sequence IS NULL OR sequence >= 0),
    status TEXT NOT NULL CHECK(status IN ('idle','connecting','ready','resuming','reconnecting','error')),
    last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 100),
    last_event_at_ms INTEGER CHECK(last_event_at_ms IS NULL OR last_event_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
    CHECK((session_id IS NULL AND resume_gateway_url IS NULL AND sequence IS NULL) OR
          (session_id IS NOT NULL AND resume_gateway_url IS NOT NULL AND sequence IS NOT NULL))
  ) STRICT;
  INSERT INTO discord_gateway_state(provider, session_id, resume_gateway_url, sequence, status, last_error_code, last_event_at_ms, updated_at_ms)
    VALUES('discord', NULL, NULL, NULL, 'idle', NULL, NULL, 0);

  CREATE TABLE discord_gateway_lease (
    provider TEXT PRIMARY KEY CHECK(provider = 'discord'),
    owner_id TEXT CHECK(owner_id IS NULL OR length(owner_id) BETWEEN 1 AND 200),
    token_hash TEXT CHECK(token_hash IS NULL OR length(token_hash) = 64),
    fence INTEGER NOT NULL CHECK(fence >= 0),
    expires_at_ms INTEGER CHECK(expires_at_ms IS NULL OR expires_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
    CHECK((owner_id IS NULL AND token_hash IS NULL AND expires_at_ms IS NULL) OR
          (owner_id IS NOT NULL AND token_hash IS NOT NULL AND expires_at_ms IS NOT NULL))
  ) STRICT;
  INSERT INTO discord_gateway_lease(provider, owner_id, token_hash, fence, expires_at_ms, updated_at_ms)
    VALUES('discord', NULL, NULL, 0, NULL, 0);

  CREATE TABLE discord_command_events (
    event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 17 AND 20 AND event_id NOT GLOB '*[^0-9]*' AND substr(event_id, 1, 1) <> '0'),
    gateway_sequence INTEGER NOT NULL CHECK(gateway_sequence >= 0),
    channel_id TEXT NOT NULL CHECK(length(channel_id) BETWEEN 17 AND 20 AND channel_id NOT GLOB '*[^0-9]*' AND substr(channel_id, 1, 1) <> '0'),
    owner_user_id TEXT NOT NULL CHECK(length(owner_user_id) BETWEEN 17 AND 20 AND owner_user_id NOT GLOB '*[^0-9]*' AND substr(owner_user_id, 1, 1) <> '0'),
    content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND ${DISCORD_COMMAND_MAX_CHARACTERS}),
    event_hash TEXT NOT NULL CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
    received_at_ms INTEGER NOT NULL CHECK(received_at_ms >= 0)
  ) STRICT;
  CREATE INDEX discord_command_events_received_idx ON discord_command_events(received_at_ms, event_id);
  PRAGMA user_version = 19;
`;

// V20 REMOVES THE CERBERUS CORRECTION STORAGE FROM THIS PRODUCT.
//
// The owner stated that the Cerberus system is not part of ToolsEnabled and believed it
// had already been removed. It had not: this store carried its five tables, ten triggers
// and its whole projection path, and `src/lib/cerberus-correction-loop.js` shipped in the
// installer payload because THIS FILE named it in a require().
//
// THE TABLES NAMED BELOW ARE THE REMOVAL, NOT A REMNANT. A table cannot be dropped without
// being named, so these are the only occurrences of that name left here, and they exist to
// delete it. MIGRATION_V17 and MIGRATION_V18 above no longer create them.
//
// THIS DROP WAS PROVEN NON-DESTRUCTIVE BEFORE IT WAS WRITTEN, not assumed to be. All five
// tables held ZERO rows in the live database, and they could not have held any: the feature
// is gated on config/cerberus-correction-policy.json, which does not exist in either tree
// and has never been shipped, so classifyContract() could never return eligible.
//
// IF EXISTS is load-bearing rather than defensive noise. A database created fresh by this
// build never had these tables, one at 17/18/19 does, and both must arrive at the same DDL
// fingerprint -- which is exactly what _validateSchema compares.
//
// ORDER IS CHILD-FIRST ON PURPOSE. DROP TABLE performs an implicit row delete that still
// honours foreign keys, so dropping a parent ahead of its children would fail on any
// database that did hold rows. Triggers go first because they are what makes these tables
// immutable, and the whole point here is to remove the tables they protect.
const MIGRATION_V20 = `
  DROP TRIGGER IF EXISTS cerberus_correction_acceptance_bindings_no_update;
  DROP TRIGGER IF EXISTS cerberus_correction_acceptance_bindings_no_delete;
  DROP TRIGGER IF EXISTS cerberus_correction_episodes_no_update;
  DROP TRIGGER IF EXISTS cerberus_correction_episodes_no_delete;
  DROP TRIGGER IF EXISTS cerberus_correction_handle_events_no_update;
  DROP TRIGGER IF EXISTS cerberus_correction_handle_events_no_delete;
  DROP TRIGGER IF EXISTS cerberus_correction_evidence_no_update;
  DROP TRIGGER IF EXISTS cerberus_correction_evidence_no_delete;
  DROP TRIGGER IF EXISTS cerberus_correction_closures_no_update;
  DROP TRIGGER IF EXISTS cerberus_correction_closures_no_delete;
  DROP TABLE IF EXISTS cerberus_correction_acceptance_bindings;
  DROP TABLE IF EXISTS cerberus_correction_episodes;
  DROP TABLE IF EXISTS cerberus_correction_handle_events;
  DROP TABLE IF EXISTS cerberus_correction_evidence;
  DROP TABLE IF EXISTS cerberus_correction_closures;
  PRAGMA user_version = 20;
`;

// V21 — the generalized research domain. Pure CREATE statements (no data
// backfill: there is no legacy research data), so fresh and migrated databases
// arrive at the same DDL fingerprint by construction. Disciplines encoded as
// CHECKs rather than comments: a confirmed finding must carry evidence AND a
// falsifier (RESEARCH-SUITE.md section 2.1 verbatim); an 'all' session
// assignment is exactly the row kind='all', ref='*' (a live rule covering
// future sessions, not a materialized snapshot); unassignment deactivates with
// a timestamp instead of deleting, and the partial unique index is what allows
// re-assignment after an unassign.
const MIGRATION_V21 = `
  CREATE TABLE research_projects (
    project_id TEXT PRIMARY KEY CHECK(length(project_id) = 39 AND project_id GLOB 'rp-*' AND substr(project_id, 4) NOT GLOB '*[^0-9a-f]*'),
    name TEXT NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 120),
    description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 2000),
    owner_scope TEXT NOT NULL DEFAULT 'owner' CHECK(length(owner_scope) BETWEEN 1 AND 80),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
    status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms)
  ) STRICT;

  CREATE TABLE research_experiments (
    experiment_id TEXT PRIMARY KEY CHECK(length(experiment_id) = 39 AND experiment_id GLOB 'rx-*' AND substr(experiment_id, 4) NOT GLOB '*[^0-9a-f]*'),
    project_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
    runner_kind TEXT NOT NULL CHECK(runner_kind IN ('agent', 'process', 'http')),
    runner_config_json TEXT NOT NULL CHECK(json_valid(runner_config_json) AND length(CAST(runner_config_json AS BLOB)) BETWEEN 2 AND 65536),
    config_hash TEXT NOT NULL CHECK(length(config_hash) = 64 AND config_hash NOT GLOB '*[^0-9a-f]*'),
    result_schema_json TEXT NOT NULL CHECK(json_valid(result_schema_json) AND length(CAST(result_schema_json AS BLOB)) BETWEEN 2 AND 16384),
    collector_json TEXT NOT NULL CHECK(json_valid(collector_json) AND length(CAST(collector_json AS BLOB)) BETWEEN 2 AND 16384),
    max_parallel INTEGER NOT NULL DEFAULT 1 CHECK(max_parallel BETWEEN 1 AND 16),
    mutex_key TEXT CHECK(mutex_key IS NULL OR length(mutex_key) BETWEEN 1 AND 120),
    timeout_ms INTEGER NOT NULL CHECK(timeout_ms BETWEEN 1000 AND 3600000),
    status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    UNIQUE(project_id, name),
    FOREIGN KEY(project_id) REFERENCES research_projects(project_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX research_experiments_project_idx ON research_experiments(project_id, updated_at_ms DESC);

  CREATE TABLE research_runs (
    run_id TEXT PRIMARY KEY CHECK(length(run_id) = 39 AND run_id GLOB 'rr-*' AND substr(run_id, 4) NOT GLOB '*[^0-9a-f]*'),
    experiment_id TEXT NOT NULL,
    task_id TEXT NOT NULL UNIQUE CHECK(length(task_id) BETWEEN 1 AND 500),
    params_json TEXT NOT NULL CHECK(json_valid(params_json) AND length(CAST(params_json AS BLOB)) BETWEEN 2 AND 65536),
    params_hash TEXT NOT NULL CHECK(length(params_hash) = 64 AND params_hash NOT GLOB '*[^0-9a-f]*'),
    session_ref_kind TEXT CHECK(session_ref_kind IS NULL OR session_ref_kind IN ('launch', 'presence', 'observed')),
    session_ref TEXT CHECK(session_ref IS NULL OR length(session_ref) BETWEEN 1 AND 200),
    artifact_dir TEXT CHECK(artifact_dir IS NULL OR length(artifact_dir) <= 1024),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    CHECK((session_ref_kind IS NULL) = (session_ref IS NULL)),
    FOREIGN KEY(experiment_id) REFERENCES research_experiments(experiment_id) ON DELETE CASCADE,
    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX research_runs_experiment_idx ON research_runs(experiment_id, created_at_ms DESC);

  CREATE TABLE research_results (
    result_id TEXT PRIMARY KEY CHECK(length(result_id) = 41 AND result_id GLOB 'rres-*' AND substr(result_id, 6) NOT GLOB '*[^0-9a-f]*'),
    run_id TEXT NOT NULL,
    record_kind TEXT NOT NULL CHECK(length(record_kind) BETWEEN 1 AND 64),
    record_json TEXT NOT NULL CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB)) BETWEEN 2 AND 262144),
    record_hash TEXT NOT NULL CHECK(length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
    artifact_path TEXT CHECK(artifact_path IS NULL OR length(artifact_path) <= 1024),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    UNIQUE(run_id, record_hash),
    FOREIGN KEY(run_id) REFERENCES research_runs(run_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX research_results_run_idx ON research_results(run_id, created_at_ms);

  CREATE TABLE research_findings (
    finding_id TEXT PRIMARY KEY CHECK(finding_id GLOB 'F-[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]-[0-9][0-9][0-9]'),
    project_id TEXT NOT NULL,
    claim TEXT NOT NULL CHECK(length(claim) BETWEEN 1 AND 500),
    status TEXT NOT NULL CHECK(status IN ('open', 'confirmed', 'refuted', 'superseded')),
    evidence_json TEXT CHECK(evidence_json IS NULL OR (json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 65536)),
    method TEXT CHECK(method IS NULL OR length(method) <= 2000),
    confidence TEXT CHECK(confidence IS NULL OR length(confidence) <= 500),
    falsifier TEXT CHECK(falsifier IS NULL OR length(falsifier) <= 1000),
    dissents_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(dissents_json) AND length(CAST(dissents_json AS BLOB)) <= 65536),
    supersedes TEXT CHECK(supersedes IS NULL OR supersedes GLOB 'F-*'),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
    CHECK(status <> 'confirmed' OR (evidence_json IS NOT NULL AND falsifier IS NOT NULL)),
    FOREIGN KEY(project_id) REFERENCES research_projects(project_id) ON DELETE RESTRICT,
    FOREIGN KEY(supersedes) REFERENCES research_findings(finding_id) ON DELETE RESTRICT
  ) STRICT;
  CREATE INDEX research_findings_project_idx ON research_findings(project_id, updated_at_ms DESC);

  CREATE TABLE research_project_sessions (
    assignment_id TEXT PRIMARY KEY CHECK(length(assignment_id) = 39 AND assignment_id GLOB 'ra-*' AND substr(assignment_id, 4) NOT GLOB '*[^0-9a-f]*'),
    project_id TEXT NOT NULL,
    session_ref_kind TEXT NOT NULL CHECK(session_ref_kind IN ('launch', 'presence', 'observed', 'all')),
    session_ref TEXT NOT NULL CHECK(length(session_ref) BETWEEN 1 AND 200),
    assigned_by TEXT NOT NULL CHECK(length(assigned_by) BETWEEN 1 AND 100),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    assigned_at_ms INTEGER NOT NULL CHECK(assigned_at_ms >= 0),
    unassigned_at_ms INTEGER CHECK(unassigned_at_ms IS NULL OR unassigned_at_ms >= assigned_at_ms),
    CHECK((session_ref_kind = 'all') = (session_ref = '*')),
    CHECK((active = 1 AND unassigned_at_ms IS NULL) OR (active = 0 AND unassigned_at_ms IS NOT NULL)),
    FOREIGN KEY(project_id) REFERENCES research_projects(project_id) ON DELETE CASCADE
  ) STRICT;
  CREATE UNIQUE INDEX research_project_sessions_active_idx
    ON research_project_sessions(project_id, session_ref_kind, session_ref) WHERE active = 1;
  CREATE INDEX research_project_sessions_ref_idx ON research_project_sessions(session_ref_kind, session_ref);
  PRAGMA user_version = 21;
`;

// V22 REMOVES THE DISCORD CONNECTOR STORAGE FROM THIS PRODUCT.
//
// The owner ruled that Discord is not part of ToolsEnabled and is not to be mentioned at
// all. Its agent tools, its provider module, its UI row and its readiness surface were
// removed on 2026-08-22; what survived was this schema, so a shipped installer went on
// creating three tables named after a connector the product does not have, on every
// machine it ran on. That is what this step ends.
//
// THIS IS THE DISCORD CONNECTOR, NOT AGENT COMMS. src/lib/agent-comms/* is the product's
// own inter-agent messaging system. It borrowed Discord's SHAPE -- channels, a board, a
// roster -- and nothing else: it never contained, called or depended on Discord, it has
// no table here, and nothing below touches it.
//
// THE TABLES NAMED BELOW ARE THE REMOVAL, NOT A REMNANT. A table cannot be dropped without
// being named. MIGRATION_V19 above still creates them and is not edited: a database
// written at 19, 20 or 21 has them, and _migrate() validates a database against the schema
// its recorded version PROMISED before upgrading it. Emptying V19 would make
// expectedSchemaFingerprint(19) describe a database that never existed and every such
// installation would refuse to open. See the V17/V18 note above -- the same mistake, caught
// once already.
//
// WHAT THIS DROP DESTROYS, MEASURED RATHER THAN ASSUMED. Two of the three tables cannot
// hold owner content by construction: discord_gateway_state and discord_gateway_lease are
// singletons whose CHECK constraints admit only connection bookkeeping -- a session id, a
// resume URL, a sequence number, a token HASH and a fence -- and V19 inserts both rows
// itself. On the owner's live database both still hold exactly the row V19 inserted
// (status 'idle', every nullable column NULL, fence 0, updated_at_ms 0): the Gateway never
// connected. The third, discord_command_events, could hold relayed message text; it holds
// zero rows there, and no code in this engine can add one -- the whole write path went
// with the connector.
//
// THE HONEST RESIDUAL RISK, stated rather than buried: a database somewhere that DID run
// the bridge before 2026-08-22 loses whatever discord_command_events held. Keeping the
// tables does not preserve that content in any usable sense -- there is no reader, no
// export and no prune left, so the rows would sit unreachable and unbounded forever, which
// is retention without control rather than custody. That is the opposite of the vault
// decision on the two Discord credential keys, which are KEPT precisely because the vault's
// remove path still lets an owner see and delete them.
//
// IF EXISTS is load-bearing rather than defensive noise. A database created fresh by this
// build never had these tables, one at 19/20/21 does, and both must arrive at the same DDL
// fingerprint -- which is exactly what _validateSchema compares.
//
// The index goes with its table; SQLite drops it automatically, and naming it separately
// would fail on a fresh database where neither exists.
const MIGRATION_V22 = `
  DROP TABLE IF EXISTS discord_command_events;
  DROP TABLE IF EXISTS discord_gateway_lease;
  DROP TABLE IF EXISTS discord_gateway_state;
  PRAGMA user_version = 22;
`;

// V23 REMOVES THE TELEGRAM CONNECTOR STORAGE FROM THIS PRODUCT.
//
// The owner ruled that Telegram is no longer integrated ("you can rip out telegram"), because
// the product now ships its own mobile app. The bridge, the pulse, the command dispatcher,
// the five telegram.* MCP tools, system.ask_remote and the Telegram-only provider module were
// removed on 2026-08-23; what would otherwise survive is this schema, so a shipped installer
// would go on creating three tables named after a connector the product does not have, on
// every machine it ran on. That is what this step ends. It is the same move V22 made for
// Discord, one migration later, and for the same reason.
//
// THESE TABLES ARE OLDER THAN THE DISCORD ONES, AND THAT CHANGES ONE THING. MIGRATION_V1
// creates them -- not V19 -- so they are in REQUIRED_SCHEMA_V1 and in every REQUIRED_SCHEMA
// that spreads it. V1 is NOT edited, for exactly the reason the V22 note gives: a database
// written at ANY version from 1 to 22 has these tables, and _migrate() validates a database
// against the schema its recorded version PROMISED before upgrading it. Emptying V1 would
// make expectedSchemaFingerprint(1..22) describe a database that never existed, and every
// installation in the world would refuse to open. The subtraction happens HERE, at the top,
// once.
//
// WHAT THIS DROP DESTROYS, MEASURED RATHER THAN ASSUMED. Two of the three cannot hold owner
// content by construction: telegram_cursor and telegram_poll_lease are singletons whose CHECK
// constraints admit only polling bookkeeping -- a provider name pinned to 'telegram', an
// update-id watermark, a lease owner, an opaque lease token, a fence and two timestamps --
// and MIGRATION_V1 inserts both rows itself. On the owner's live database both still hold
// exactly the row V1 inserted (cursor next_update_id 0 and updated_at_ms 0; lease owner_id
// NULL, token NULL, fence 0, expires_at_ms NULL): the bridge never advanced the cursor and
// never took the lease. The third, telegram_updates, is the one that COULD hold relayed
// message text -- it stores whole getUpdates payloads as JSON -- and it holds ZERO rows there.
// The durable queue that carried telegram.command tasks is likewise empty (tasks: 0 rows,
// operations: 0 rows), so nothing references an update either.
//
// THE HONEST RESIDUAL RISK, stated rather than buried: a database somewhere that DID run the
// bridge before 2026-08-23 loses whatever telegram_updates held -- which is real owner message
// CONTENT, not just bookkeeping, and is a strictly bigger loss than V22's was. Keeping the
// table does not preserve that content in any usable sense: the reader (readTelegramUpdates),
// the prune and the whole write path went with the connector, so the rows would sit
// unreachable and unbounded forever. That is retention without control rather than custody,
// and it is the opposite of the vault decision on the two Telegram credential keys, which are
// KEPT and relabelled because an owner can still see them and delete them by hand.
//
// IF EXISTS is load-bearing rather than defensive noise -- and here it is doing MORE work than
// it did in V22. A database created fresh by this build still runs MIGRATION_V1, so it DOES
// have these tables a moment before this statement runs; a database at any version 1-22 has
// them too. Both must arrive at the same DDL fingerprint, which is exactly what
// _validateSchema compares.
//
// The index goes with its table; SQLite drops telegram_updates_received_idx automatically,
// and naming it separately would fail on a database where neither exists.
const MIGRATION_V23 = `
  DROP TABLE IF EXISTS telegram_updates;
  DROP TABLE IF EXISTS telegram_poll_lease;
  DROP TABLE IF EXISTS telegram_cursor;
  PRAGMA user_version = 23;
`;

// V24: rename the durable-mission tables (see the REQUIRED_SCHEMA note). ALTER TABLE
// RENAME rewrites every foreign-key reference and the stored CREATE TABLE text on a
// modern SQLite, so a database created fresh by this build (which still runs V10 and
// V11 and therefore creates the old names a moment earlier) and a database upgraded
// from 10..23 arrive at the identical DDL fingerprint. Indexes keep their own names
// through a table rename, so the four named after the old prefix are recreated.
const MIGRATION_V24 = `
  ALTER TABLE jarvis_missions RENAME TO coordinator_missions;
  ALTER TABLE jarvis_phase_states RENAME TO coordinator_phase_states;
  ALTER TABLE jarvis_workflow_missions RENAME TO coordinator_workflow_missions;
  ALTER TABLE jarvis_broker_verifications RENAME TO coordinator_broker_verifications;
  ALTER TABLE jarvis_workflow_events RENAME TO coordinator_workflow_events;
  ALTER TABLE jarvis_workflow_outbox RENAME TO coordinator_workflow_outbox;
  ALTER TABLE jarvis_workflow_acceptances RENAME TO coordinator_workflow_acceptances;
  DROP INDEX IF EXISTS jarvis_missions_updated_idx;
  CREATE INDEX coordinator_missions_updated_idx ON coordinator_missions(updated_at_ms DESC, run_id);
  DROP INDEX IF EXISTS jarvis_phase_states_run_idx;
  CREATE INDEX coordinator_phase_states_run_idx ON coordinator_phase_states(run_id, updated_at_ms DESC, actor);
  DROP INDEX IF EXISTS jarvis_workflow_missions_task_idx;
  CREATE INDEX coordinator_workflow_missions_task_idx ON coordinator_workflow_missions(task_id, updated_at_ms DESC);
  DROP INDEX IF EXISTS jarvis_workflow_outbox_delivery_idx;
  CREATE INDEX coordinator_workflow_outbox_delivery_idx ON coordinator_workflow_outbox(run_id, status, created_at_ms, outbox_id);
  PRAGMA user_version = 24;
`;

const expectedFingerprints = new Map();
function databaseSchemaFingerprint(db) {
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  // ALTER TABLE ... RENAME rewrites the stored DDL with the new name in double
  // quotes -- `CREATE TABLE "coordinator_missions"`, and every FOREIGN KEY
  // that referenced it likewise -- while DDL that was created under that name
  // carries no quotes. The two describe one schema, so quoting around a bare
  // identifier is not part of the fingerprint (MIGRATION_V24 renames seven
  // tables, and a downgrade fixture renaming them back would otherwise never
  // match the ladder's fingerprint for the version it stamps).
  const normalized = rows.map(row => [
    row.type,
    row.name,
    row.tbl_name,
    String(row.sql).replace(/"([A-Za-z_][A-Za-z0-9_]*)"/g, '$1').replace(/\s+/g, ' ').trim()
  ]);
  return hashText(JSON.stringify(normalized));
}

function expectedSchemaFingerprint(version = SCHEMA_VERSION) {
  if (![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24].includes(version)) throw stateError('STATE_SCHEMA_UNSUPPORTED', `State schema ${version} is not supported.`, { version, supported: SCHEMA_VERSION });
  if (expectedFingerprints.has(version)) return expectedFingerprints.get(version);
  const db = new DatabaseSync(':memory:', { allowExtension: false, enableForeignKeyConstraints: true });
  try {
    db.exec(SCHEMA_V1);
    if (version >= 2) db.exec(MIGRATION_V2);
    if (version >= 3) db.exec(MIGRATION_V3);
    if (version >= 4) db.exec(MIGRATION_V4);
    if (version >= 5) db.exec(MIGRATION_V5);
    if (version >= 6) db.exec(MIGRATION_V6);
    if (version >= 7) db.exec(MIGRATION_V7);
    if (version >= 8) db.exec(MIGRATION_V8);
    if (version >= 9) db.exec(MIGRATION_V9);
    if (version >= 10) db.exec(MIGRATION_V10);
    if (version >= 11) db.exec(MIGRATION_V11);
    if (version >= 12) db.exec(MIGRATION_V12);
    if (version >= 13) db.exec(MIGRATION_V13);
    if (version >= 14) db.exec(MIGRATION_V14);
    if (version >= 15) db.exec(MIGRATION_V15);
    if (version >= 16) db.exec(MIGRATION_V16);
    if (version >= 17) db.exec(MIGRATION_V17);
    if (version >= 18) db.exec(MIGRATION_V18);
    if (version >= 19) db.exec(MIGRATION_V19);
    if (version >= 20) db.exec(MIGRATION_V20);
    if (version >= 21) db.exec(MIGRATION_V21);
    if (version >= 22) db.exec(MIGRATION_V22);
    if (version >= 23) db.exec(MIGRATION_V23);
    if (version >= 24) db.exec(MIGRATION_V24);
    const fingerprint = databaseSchemaFingerprint(db);
    expectedFingerprints.set(version, fingerprint);
    return fingerprint;
  } finally {
    db.close();
  }
}

class StateStore {
  constructor(options = {}) {
    assertPlainObject(options, 'options');
    const environmentPath = typeof process.env.TOOLSENABLED_STATE_PATH === 'string' && process.env.TOOLSENABLED_STATE_PATH.trim()
      ? process.env.TOOLSENABLED_STATE_PATH.trim()
      : undefined;
    const selectedFile = options.file === undefined ? (environmentPath || DEFAULT_STATE_PATH) : options.file;
    this.file = assertString(selectedFile, 'file', { max: 4096 });
    this.file = this.file === ':memory:' ? this.file : path.resolve(this.file);
    this.clock = options.clock || (() => Date.now());
    if (typeof this.clock !== 'function') throw stateError('STATE_INVALID_ARGUMENT', 'clock must be a function.', { field: 'clock' });
    this.idFactory = options.idFactory || (prefix => `${prefix}-${crypto.randomUUID()}`);
    if (typeof this.idFactory !== 'function') throw stateError('STATE_INVALID_ARGUMENT', 'idFactory must be a function.', { field: 'idFactory' });
    this.busyTimeoutMs = assertInteger(options.busyTimeoutMs === undefined ? 5000 : options.busyTimeoutMs, 'busyTimeoutMs', { min: 1, max: 60000 });
    this.ownerId = options.ownerId === undefined ? this._newId('worker') : assertString(options.ownerId, 'ownerId', { max: 200 });
    this._db = null;
    this._transactionActive = false;
  }

  _newId(prefix) {
    const value = this.idFactory(prefix);
    return assertString(value, `${prefix} id`, { max: 500 });
  }

  _now() {
    const raw = this.clock();
    const value = raw instanceof Date ? raw.getTime() : Number(raw);
    return assertInteger(value, 'clock result', { min: 0 });
  }

  _open() {
    assertStateStoreActive(this);
    if (databaseIsOpen(this._db)) return this._db;
    if (this.file !== ':memory:') ensureDir(path.dirname(this.file));
    // A group of fresh broker processes can all race through journal-mode and
    // schema initialization before SQLite's connection busy handler is fully
    // applicable. Retry the complete open sequence with bounded jitter, always
    // closing a partial handle before starting over.
    const deadline = Date.now() + (this.busyTimeoutMs * 2);
    let attempt = 0;
    while (true) {
      let db;
      try {
        db = new DatabaseSync(this.file, {
          timeout: this.busyTimeoutMs,
          allowExtension: false,
          enableForeignKeyConstraints: true,
          enableDoubleQuotedStringLiterals: false,
          readBigInts: false,
          returnArrays: false,
          allowBareNamedParameters: true,
          allowUnknownNamedParameters: false
        });
        this._db = db;
        const mode = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
        if (this.file !== ':memory:' && mode !== 'wal') {
          throw stateError('STATE_WAL_UNAVAILABLE', 'The durable state database could not enable WAL mode.', { journalMode: mode });
        }
        db.exec(`PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${this.busyTimeoutMs};`);
        this._migrate();
        return db;
      } catch (error) {
        if (databaseIsOpen(db)) {
          try { db.close(); } catch { /* retain the original failure */ }
        }
        this._db = null;
        attempt += 1;
        const remaining = deadline - Date.now();
        if (isBusyError(error) && attempt < 10 && remaining > 0) {
          const backoff = Math.min(250, 10 * (2 ** Math.min(attempt - 1, 5))) + (process.pid % 17);
          waitSynchronously(Math.min(backoff, remaining));
          continue;
        }
        throw translateError(error);
      }
    }
  }

  _migrate() {
    this.transaction(db => {
      let version = db.prepare('PRAGMA user_version').get().user_version;
      let applicationId = db.prepare('PRAGMA application_id').get().application_id;
      if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
        throw stateError('STATE_DATABASE_IDENTITY', 'The configured state path belongs to a different SQLite application.', { applicationId, expected: APPLICATION_ID });
      }
      if (version > SCHEMA_VERSION) {
        throw stateError('STATE_SCHEMA_TOO_NEW', `State schema ${version} is newer than supported schema ${SCHEMA_VERSION}.`, { version, supported: SCHEMA_VERSION });
      }
      if (version === 0) {
        db.exec(SCHEMA_V1);
        version = 1;
        applicationId = APPLICATION_ID;
      } else {
        // Never apply an upgrade over a database whose existing version does
        // not exactly match the schema that version promised.
        this._validateSchema(db, version);
      }
      if (version === 1) {
        db.exec(MIGRATION_V2);
        version = 2;
      }
      if (version === 2) {
        db.exec(MIGRATION_V3);
        version = 3;
      }
      if (version === 3) {
        db.exec(MIGRATION_V4);
        // Only the current registration can have been runnable under schema 3.
        // Bind its immutable execution input now; retired generations remain
        // non-runnable because their historical action/args were not retained.
        const active = db.prepare(`SELECT j.id, j.active_generation, j.action, j.args_json, r.spec_json
          FROM scheduler_jobs j JOIN scheduler_registrations r
            ON r.job_id = j.id AND r.generation = j.active_generation
          WHERE j.active_generation IS NOT NULL`).all();
        const updateRegistration = db.prepare(`UPDATE scheduler_registrations SET spec_json = ?, spec_hash = ?, updated_at_ms = MAX(updated_at_ms, ?)
          WHERE job_id = ? AND generation = ?`);
        for (const row of active) {
          const spec = parseJson(row.spec_json, 'schema-3 scheduler registration spec');
          const normalizedAction = normalizeScheduledAction(row.action);
          db.prepare('UPDATE scheduler_jobs SET action = ? WHERE id = ?').run(normalizedAction, row.id);
          const principalMissing = typeof spec.principalId !== 'string' || !/^S-\d-(?:\d+-){1,14}\d+$/i.test(spec.principalId);
          const actionRefreshRequired = normalizedAction !== row.action
            || (spec.action !== undefined && spec.action !== normalizedAction);
          if (principalMissing || actionRefreshRequired) {
            // Do not rewrite an immutable ownership marker to make a legacy
            // task look current. Remove its executable fields, retire it, and
            // let the provider create a fresh principal/action-bound generation.
            const deletionSpec = { ...spec };
            if (principalMissing) delete deletionSpec.principalId;
            delete deletionSpec.action;
            delete deletionSpec.args;
            delete deletionSpec.desiredSpecHash;
            deletionSpec.migrationDeletionOnly = principalMissing ? 'principal-refresh' : 'action-refresh';
            const deletionSpecJson = canonicalJson(deletionSpec);
            updateRegistration.run(deletionSpecJson, hashText(deletionSpecJson), this._now(), row.id, row.active_generation);
            const code = principalMissing ? 'SCHEDULER_PRINCIPAL_REFRESH_REQUIRED' : 'SCHEDULER_ACTION_REFRESH_REQUIRED';
            const message = principalMissing
              ? 'This migrated registration predates exact Windows principal binding and must be replaced before execution.'
              : 'This migrated registration uses a legacy action identity and must be replaced before execution.';
            db.prepare(`UPDATE scheduler_jobs SET active_generation = NULL, provider_state = 'error',
              provider_error_code = ?, provider_error_message = ?, action = ? WHERE id = ?`).run(code, message, normalizedAction, row.id);
            db.prepare(`UPDATE scheduler_registrations SET desired_state = 'absent', updated_at_ms = MAX(updated_at_ms, ?)
              WHERE job_id = ? AND generation = ?`).run(this._now(), row.id, row.active_generation);
            this._wakeSchedulerOutbox(db, row.id, row.active_generation, 'delete', this._now(), this._now());
          } else if (spec.action === undefined || spec.args === undefined || spec.desiredSpecHash === undefined) {
            const upgraded = {
              ...spec, action: normalizedAction, args: parseJson(row.args_json, 'schema-3 scheduler args'),
              desiredSpecHash: db.prepare('SELECT spec_hash FROM scheduler_jobs WHERE id = ?').get(row.id).spec_hash
            };
            const specJson = canonicalJson(upgraded);
            updateRegistration.run(specJson, hashText(specJson), this._now(), row.id, row.active_generation);
          }
        }
        version = 4;
      }
      if (version === 4) {
        db.exec(MIGRATION_V5);
        version = 5;
      }
      if (version === 5) {
        db.exec(MIGRATION_V6);
        version = 6;
      }
      if (version === 6) {
        db.exec(MIGRATION_V7);
        version = 7;
      }
      if (version === 7) {
        db.exec(MIGRATION_V8);
        version = 8;
      }
      if (version === 8) {
        db.exec(MIGRATION_V9);
        version = 9;
      }
      if (version === 9) {
        db.exec(MIGRATION_V10);
        version = 10;
      }
      if (version === 10) {
        db.exec(MIGRATION_V11);
        version = 11;
      }
      if (version === 11) {
        db.exec(MIGRATION_V12);
        version = 12;
      }
      if (version === 12) {
        db.exec(MIGRATION_V13);
        version = 13;
      }
      if (version === 13) {
        db.exec(MIGRATION_V14);
        version = 14;
      }
      if (version === 14) {
        const duplicateApproval = db.prepare(`SELECT approval_id, COUNT(*) AS count
          FROM policy_dispatch_consumptions WHERE approval_id IS NOT NULL
          GROUP BY approval_id HAVING COUNT(*) > 1 LIMIT 1`).get();
        if (duplicateApproval) {
          throw stateError('POLICY_APPROVAL_EVIDENCE_REPLAYED', 'State migration found an approval grant attached to multiple P13 dispatches.', {
            approvalId: duplicateApproval.approval_id,
            attachments: duplicateApproval.count
          });
        }
        db.exec(MIGRATION_V15);
        version = 15;
      }
      if (version === 15) {
        db.exec(MIGRATION_V16);
        version = 16;
      }
      if (version === 16) {
        db.exec(MIGRATION_V17);
        version = 17;
      }
      if (version === 17) {
        db.exec(MIGRATION_V18);
        version = 18;
      }
      if (version === 18) {
        db.exec(MIGRATION_V19);
        version = 19;
      }
      if (version === 19) {
        db.exec(MIGRATION_V20);
        version = 20;
      }
      if (version === 20) {
        db.exec(MIGRATION_V21);
        version = 21;
      }
      if (version === 21) {
        db.exec(MIGRATION_V22);
        version = 22;
      }
      if (version === 22) {
        db.exec(MIGRATION_V23);
        version = 23;
      }
      if (version === 23) {
        db.exec(MIGRATION_V24);
        version = 24;
      }
      const migrated = db.prepare('PRAGMA user_version').get().user_version;
      if (migrated !== SCHEMA_VERSION) {
        throw stateError('STATE_SCHEMA_UNSUPPORTED', `State schema ${migrated} cannot be upgraded by this build.`, { version: migrated, supported: SCHEMA_VERSION });
      }
      this._validateSchema(db, migrated);
      const foreignKeyFailures = db.prepare('PRAGMA foreign_key_check').all();
      if (foreignKeyFailures.length) {
        throw stateError('STATE_SCHEMA_INVALID', 'The durable state database contains invalid foreign-key references.', { violations: foreignKeyFailures.length });
      }
      if (applicationId === 0) db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
      const migratedApplicationId = db.prepare('PRAGMA application_id').get().application_id;
      if (migratedApplicationId !== APPLICATION_ID) {
        throw stateError('STATE_DATABASE_IDENTITY', 'The state database application identity could not be established.', { applicationId: migratedApplicationId, expected: APPLICATION_ID });
      }
    });
  }

  _validateSchema(db, version = SCHEMA_VERSION) {
    const requiredSchema = version === 1 ? REQUIRED_SCHEMA_V1 : version === 2 ? REQUIRED_SCHEMA_V2
      : version === 3 ? REQUIRED_SCHEMA_V3 : version === 4 ? REQUIRED_SCHEMA_V4 : version === 5 ? REQUIRED_SCHEMA_V5
        : version === 6 ? REQUIRED_SCHEMA_V6 : version === 7 ? REQUIRED_SCHEMA_V7 : version === 8 ? REQUIRED_SCHEMA_V8 : version === 9 ? REQUIRED_SCHEMA_V9 : version === 10 ? REQUIRED_SCHEMA_V10 : version === 11 ? REQUIRED_SCHEMA_V11 : version === 12 ? REQUIRED_SCHEMA_V12 : version === 13 ? REQUIRED_SCHEMA_V13 : version === 14 ? REQUIRED_SCHEMA_V14 : version === 15 ? REQUIRED_SCHEMA_V14 : version === 16 ? REQUIRED_SCHEMA_V16 : version === 17 ? REQUIRED_SCHEMA_V17 : version === 18 ? REQUIRED_SCHEMA_V18 : version === 19 ? REQUIRED_SCHEMA_V19 : version === 20 ? REQUIRED_SCHEMA_V20 : version === 21 ? REQUIRED_SCHEMA_V21 : version === 22 ? REQUIRED_SCHEMA_V22 : version === 23 ? REQUIRED_SCHEMA_V23 : version === 24 ? REQUIRED_SCHEMA : null;
    if (!requiredSchema) throw stateError('STATE_SCHEMA_UNSUPPORTED', `State schema ${version} is not supported.`, { version, supported: SCHEMA_VERSION });
    const tables = new Map(db.prepare('PRAGMA table_list').all().map(row => [row.name, row]));
    for (const [name, expectedColumns] of Object.entries(requiredSchema)) {
      const table = tables.get(name);
      if (!table || table.type !== 'table' || table.strict !== 1) {
        throw stateError('STATE_SCHEMA_INVALID', `Required STRICT state table '${name}' is missing or invalid.`, { table: name });
      }
      const actualColumns = db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name);
      if (actualColumns.length !== expectedColumns.length || actualColumns.some((column, index) => column !== expectedColumns[index])) {
        throw stateError('STATE_SCHEMA_INVALID', `State table '${name}' has an unexpected column layout.`, { table: name, expectedColumns, actualColumns });
      }
    }
    const expected = expectedSchemaFingerprint(version);
    const actual = databaseSchemaFingerprint(db);
    if (actual !== expected) {
      throw stateError('STATE_SCHEMA_INVALID', 'The durable state DDL fingerprint does not match this schema version.', { expectedFingerprint: expected, actualFingerprint: actual });
    }
    // Bounded ABOVE, exactly as the Discord invariant below is. MIGRATION_V1 created these
    // two singletons and MIGRATION_V23 dropped them, so this describes precisely the versions
    // that have them: a legacy database on its way up from anywhere in 1..22 is still fully
    // checked, and a database at 23 or later is not asked about tables that no longer exist.
    // There is no lower bound because there is no version below 1.
    if (version <= 22) {
      const cursors = db.prepare("SELECT provider, next_update_id, updated_at_ms FROM telegram_cursor").all();
      if (cursors.length !== 1 || cursors[0].provider !== 'telegram' || !Number.isSafeInteger(cursors[0].next_update_id)
        || cursors[0].next_update_id < 0 || !Number.isSafeInteger(cursors[0].updated_at_ms) || cursors[0].updated_at_ms < 0) {
        throw stateError('STATE_SCHEMA_INVALID', 'The Telegram cursor singleton invariant is invalid.', { table: 'telegram_cursor' });
      }
      const leases = db.prepare("SELECT provider, owner_id, token, fence, expires_at_ms, updated_at_ms FROM telegram_poll_lease").all();
      const lease = leases[0];
      const emptyLease = lease && lease.owner_id === null && lease.token === null && lease.expires_at_ms === null;
      const heldLease = lease && typeof lease.owner_id === 'string' && typeof lease.token === 'string' && Number.isSafeInteger(lease.expires_at_ms);
      if (leases.length !== 1 || !lease || lease.provider !== 'telegram' || !Number.isSafeInteger(lease.fence) || lease.fence < 0
        || !Number.isSafeInteger(lease.updated_at_ms) || lease.updated_at_ms < 0 || (!emptyLease && !heldLease)) {
        throw stateError('STATE_SCHEMA_INVALID', 'The Telegram poll-lease singleton invariant is invalid.', { table: 'telegram_poll_lease' });
      }
    }
    // Bounded ABOVE as well as below, on purpose. V19 created the two Discord singletons
    // and V22 dropped them, so this invariant describes exactly the versions that have
    // them: a legacy database on its way past 19/20/21 is still checked, and a database at
    // 22 or later is not asked about tables that no longer exist.
    if (version >= 19 && version <= 21) {
      const gatewayRows = db.prepare('SELECT * FROM discord_gateway_state').all();
      const gateway = gatewayRows[0];
      const emptySession = gateway && gateway.session_id === null && gateway.resume_gateway_url === null && gateway.sequence === null;
      const resumableSession = gateway && typeof gateway.session_id === 'string' && typeof gateway.resume_gateway_url === 'string'
        && Number.isSafeInteger(gateway.sequence) && gateway.sequence >= 0;
      if (gatewayRows.length !== 1 || !gateway || gateway.provider !== 'discord'
        || !DISCORD_GATEWAY_STATES.has(gateway.status) || (!emptySession && !resumableSession)
        || !Number.isSafeInteger(gateway.updated_at_ms) || gateway.updated_at_ms < 0) {
        throw stateError('STATE_SCHEMA_INVALID', 'The Discord Gateway state singleton invariant is invalid.', { table: 'discord_gateway_state' });
      }
      const discordLeaseRows = db.prepare('SELECT * FROM discord_gateway_lease').all();
      const discordLease = discordLeaseRows[0];
      const emptyDiscordLease = discordLease && discordLease.owner_id === null && discordLease.token_hash === null && discordLease.expires_at_ms === null;
      const heldDiscordLease = discordLease && typeof discordLease.owner_id === 'string'
        && typeof discordLease.token_hash === 'string' && /^[a-f0-9]{64}$/.test(discordLease.token_hash)
        && Number.isSafeInteger(discordLease.expires_at_ms);
      if (discordLeaseRows.length !== 1 || !discordLease || discordLease.provider !== 'discord'
        || !Number.isSafeInteger(discordLease.fence) || discordLease.fence < 0
        || !Number.isSafeInteger(discordLease.updated_at_ms) || discordLease.updated_at_ms < 0
        || (!emptyDiscordLease && !heldDiscordLease)) {
        throw stateError('STATE_SCHEMA_INVALID', 'The Discord Gateway lease singleton invariant is invalid.', { table: 'discord_gateway_lease' });
      }
    }
    if (version >= 3) {
      const installations = db.prepare('SELECT singleton, installation_id, created_at_ms, updated_at_ms FROM scheduler_installation').all();
      const installation = installations[0];
      if (installations.length !== 1 || !installation || installation.singleton !== 1
        || typeof installation.installation_id !== 'string' || !/^[a-f0-9]{32}$/.test(installation.installation_id)
        || !Number.isSafeInteger(installation.created_at_ms) || installation.created_at_ms < 0
        || !Number.isSafeInteger(installation.updated_at_ms) || installation.updated_at_ms < installation.created_at_ms) {
        throw stateError('STATE_SCHEMA_INVALID', 'The scheduler installation singleton invariant is invalid.', { table: 'scheduler_installation' });
      }
    }
    if (version >= 4) {
      const invalidActive = db.prepare(`SELECT j.id FROM scheduler_jobs j
        LEFT JOIN scheduler_registrations r ON r.job_id = j.id AND r.generation = j.active_generation
        WHERE j.active_generation IS NOT NULL AND (r.job_id IS NULL OR r.desired_state <> 'present' OR r.observed_state <> 'present')
        LIMIT 1`).get();
      if (invalidActive) {
        throw stateError('STATE_SCHEMA_INVALID', 'A scheduler active generation is missing its exact present registration.', {
          table: 'scheduler_jobs', jobId: invalidActive.id
        });
      }
      // SQLite's structural checks cannot prove that canonical payloads and
      // their application-level identity bindings still agree. Scan every v4
      // scheduler row during health/open validation so corruption is surfaced
      // even before a particular job is selected for reconciliation or run.
      const installationId = db.prepare('SELECT installation_id FROM scheduler_installation WHERE singleton = 1').get().installation_id;
      const mappedJobs = new Map();
      for (const row of db.prepare('SELECT * FROM scheduler_jobs ORDER BY id').all()) {
        mappedJobs.set(row.id, this._schedulerJobRow(row));
      }
      for (const row of db.prepare('SELECT * FROM scheduler_registrations ORDER BY job_id, generation').all()) {
        const mappedJob = mappedJobs.get(row.job_id);
        if (!mappedJob) {
          throw stateError('STATE_SCHEMA_INVALID', 'A scheduler registration has no owning job.', {
            table: 'scheduler_registrations', jobId: row.job_id, generation: row.generation
          });
        }
        this._schedulerRegistrationRow(row, installationId, mappedJob);
      }
      this._validateSchedulerOutboxIntegrity(db);
    }
  }

  close() {
    if (!databaseIsOpen(this._db)) {
      this._db = null;
      return false;
    }
    const db = this._db;
    let failure;
    try {
      if (this._transactionActive || databaseIsTransaction(db)) db.exec('ROLLBACK');
    } catch (error) {
      failure = error;
    }
    try {
      db.close();
      this._db = null;
    } catch (error) {
      if (!failure) failure = error;
      // A failed native close can leave the file locked on Windows. Retain the
      // actual connection so a later cleanup can still release it.
    }
    if (failure) throw translateError(failure);
    return true;
  }

  transaction(callback) {
    assertStateStoreActive(this);
    if (typeof callback !== 'function') throw stateError('STATE_INVALID_ARGUMENT', 'transaction callback must be a function.', { field: 'callback' });
    if (callback.constructor && callback.constructor.name === 'AsyncFunction') {
      throw stateError('STATE_TRANSACTION_ASYNC', 'Durable-state transactions must be synchronous and may not use an async callback.');
    }
    const db = databaseIsOpen(this._db) ? this._db : this._open();
    if (this._transactionActive || databaseIsTransaction(db)) {
      throw stateError('STATE_TRANSACTION_NESTED', 'Nested durable-state transactions are not supported.');
    }
    const gate = { active: true };
    let transactionStarted = false;
    this._transactionActive = true;
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      const result = callback(transactionView(db, gate));
      if (result && typeof result.then === 'function') {
        if (typeof result.catch === 'function') result.catch(() => {});
        throw stateError('STATE_TRANSACTION_ASYNC', 'Durable-state transactions must be synchronous and may not return a Promise.');
      }
      gate.active = false;
      db.exec('COMMIT');
      return result;
    } catch (error) {
      gate.active = false;
      if (transactionStarted || databaseIsTransaction(db)) {
        try { db.exec('ROLLBACK'); } catch { /* preserve the initiating error */ }
      }
      throw translateError(error);
    } finally {
      this._transactionActive = false;
    }
  }

  _read(callback) {
    try {
      return callback(this._open());
    } catch (error) {
      throw translateError(error);
    }
  }

  _spendVerdict(db, { amountCents, dailyLimitCents, purpose }, now) {
    const date = iso(now).slice(0, 10);
    const currentSpendCents = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM spend_entries WHERE spend_date = ?').get(date).total;
    return {
      date,
      currentSpendCents,
      currentSpendUsd: centsToUsd(currentSpendCents),
      requestedCents: amountCents,
      requestedUsd: centsToUsd(amountCents),
      limitCents: dailyLimitCents,
      limitUsd: centsToUsd(dailyLimitCents),
      allowed: dailyLimitCents <= 0 || currentSpendCents + amountCents <= dailyLimitCents,
      purpose
    };
  }

  _validateSpend({ amountCents, dailyLimitCents, purpose = '' }) {
    assertInteger(amountCents, 'amountCents');
    assertInteger(dailyLimitCents, 'dailyLimitCents');
    assertString(purpose, 'purpose', { min: 0, max: 1000 });
    return { amountCents, dailyLimitCents, purpose };
  }

  checkSpend(input) {
    const values = this._validateSpend(assertPlainObject(input, 'spend'));
    return this._read(db => this._spendVerdict(db, values, this._now()));
  }

  _spendRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      date: row.spend_date,
      timestamp: iso(row.timestamp_ms),
      timestampMs: row.timestamp_ms,
      amountCents: row.amount_cents,
      amountUsd: centsToUsd(row.amount_cents),
      purpose: row.purpose,
      provider: row.provider,
      reference: row.reference || ''
    };
  }

  recordSpend(input) {
    const source = assertPlainObject(input, 'spend');
    const values = this._validateSpend(source);
    const provider = source.provider === undefined ? 'manual' : assertString(source.provider, 'provider', { max: 100 });
    const reference = source.reference === undefined || source.reference === '' ? null : assertString(source.reference, 'reference', { max: 500 });
    return this.transaction(db => {
      const now = this._now();
      if (reference) {
        const prior = db.prepare('SELECT * FROM spend_entries WHERE provider = ? AND reference = ?').get(provider, reference);
        if (prior) {
          if (prior.amount_cents !== values.amountCents || prior.purpose !== values.purpose) {
            throw stateError('SPEND_REFERENCE_CONFLICT', 'The spend reference was already used with different details.', { provider, reference });
          }
          return { ...this._spendVerdict(db, values, now), allowed: true, replayed: true, entry: this._spendRow(prior) };
        }
      }
      const verdict = this._spendVerdict(db, values, now);
      if (!verdict.allowed) {
        throw stateError('SPEND_LIMIT_EXCEEDED', 'The atomic daily spend limit would be exceeded.', {
          date: verdict.date,
          currentSpendCents: verdict.currentSpendCents,
          requestedCents: values.amountCents,
          limitCents: values.dailyLimitCents
        });
      }
      const id = this._newId('spend');
      db.prepare(`INSERT INTO spend_entries(id, spend_date, timestamp_ms, amount_cents, purpose, provider, reference)
        VALUES(?, ?, ?, ?, ?, ?, ?)`).run(id, verdict.date, now, values.amountCents, values.purpose, provider, reference);
      const entry = db.prepare('SELECT * FROM spend_entries WHERE id = ?').get(id);
      return { ...verdict, replayed: false, entry: this._spendRow(entry) };
    });
  }

  listSpend(options = {}) {
    assertPlainObject(options, 'options');
    const limit = assertInteger(options.limit === undefined ? 100 : options.limit, 'limit', { min: 1, max: 1000 });
    if (options.date !== undefined && !validUtcDate(options.date)) {
      throw stateError('STATE_INVALID_ARGUMENT', 'date must use YYYY-MM-DD UTC format.', { field: 'date' });
    }
    return this._read(db => {
      const rows = options.date === undefined
        ? db.prepare('SELECT * FROM spend_entries ORDER BY timestamp_ms DESC, id DESC LIMIT ?').all(limit)
        : db.prepare('SELECT * FROM spend_entries WHERE spend_date = ? ORDER BY timestamp_ms DESC, id DESC LIMIT ?').all(options.date, limit);
      return rows.map(row => this._spendRow(row));
    });
  }

  _modelUsageInput(input) {
    const source = assertPlainObject(input, 'model usage');
    const model = assertString(source.model, 'model', {
      max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
    });
    const promptTokens = assertInteger(source.promptTokens, 'promptTokens', { min: 0, max: 1_000_000_000 });
    const evalTokens = assertInteger(source.evalTokens, 'evalTokens', { min: 0, max: 1_000_000_000 });
    const date = source.date === undefined ? iso(this._now()).slice(0, 10) : source.date;
    if (!validUtcDate(date)) {
      throw stateError('STATE_INVALID_ARGUMENT', 'date must use YYYY-MM-DD UTC format.', { field: 'date' });
    }
    return { date, model, promptTokens, evalTokens };
  }

  _modelUsageRow(row) {
    if (!row) return null;
    const date = String(row.usage_date);
    if (!validUtcDate(date)) throw stateError('MODEL_USAGE_INVALID', 'A model usage row has an invalid UTC date.', { date });
    const model = assertString(row.model, 'stored model', { max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/ });
    const promptTokens = assertInteger(row.prompt_tokens, 'stored promptTokens', { min: 0 });
    const evalTokens = assertInteger(row.eval_tokens, 'stored evalTokens', { min: 0 });
    const calls = assertInteger(row.calls, 'stored calls', { min: 0 });
    const updatedAtMs = assertInteger(row.updated_at_ms, 'stored updatedAtMs', { min: 0 });
    return { date, model, promptTokens, evalTokens, calls, updatedAtMs, updatedAt: iso(updatedAtMs) };
  }

  // Record only provider-reported aggregate counts. This deliberately accepts no
  // prompt or output field so the transactional state database cannot become a
  // second content store for local-model interactions.
  recordModelUsage(input) {
    const values = this._modelUsageInput(input);
    return this.transaction(db => {
      const now = this._now();
      db.prepare(`INSERT INTO model_usage_daily(usage_date, model, prompt_tokens, eval_tokens, calls, updated_at_ms)
        VALUES(?, ?, ?, ?, 1, ?)
        ON CONFLICT(usage_date, model) DO UPDATE SET
          prompt_tokens = prompt_tokens + excluded.prompt_tokens,
          eval_tokens = eval_tokens + excluded.eval_tokens,
          calls = calls + 1,
          updated_at_ms = MAX(model_usage_daily.updated_at_ms, excluded.updated_at_ms)`).run(
        values.date, values.model, values.promptTokens, values.evalTokens, now
      );
      return this._modelUsageRow(db.prepare(`SELECT * FROM model_usage_daily
        WHERE usage_date = ? AND model = ?`).get(values.date, values.model));
    });
  }

  listModelUsage(options = {}) {
    const source = assertPlainObject(options, 'model usage selector');
    const date = source.date === undefined ? undefined : source.date;
    if (date !== undefined && !validUtcDate(date)) {
      throw stateError('STATE_INVALID_ARGUMENT', 'date must use YYYY-MM-DD UTC format.', { field: 'date' });
    }
    const model = source.model === undefined ? undefined : assertString(source.model, 'model', {
      max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
    });
    const limit = assertInteger(source.limit === undefined ? 100 : source.limit, 'limit', { min: 1, max: 1000 });
    return this._read(db => {
      const rows = date !== undefined && model !== undefined
        ? db.prepare(`SELECT * FROM model_usage_daily WHERE usage_date = ? AND model = ?
          ORDER BY usage_date DESC, model ASC LIMIT ?`).all(date, model, limit)
        : date !== undefined
          ? db.prepare(`SELECT * FROM model_usage_daily WHERE usage_date = ?
            ORDER BY model ASC LIMIT ?`).all(date, limit)
          : model !== undefined
            ? db.prepare(`SELECT * FROM model_usage_daily WHERE model = ?
              ORDER BY usage_date DESC LIMIT ?`).all(model, limit)
            : db.prepare(`SELECT * FROM model_usage_daily
              ORDER BY usage_date DESC, model ASC LIMIT ?`).all(limit);
      return rows.map(row => this._modelUsageRow(row));
    });
  }

  _tavilyUsageRow(row) {
    if (!row) return null;
    return {
      yearMonth: row.year_month,
      routineCredits: row.routine_credits,
      researchCredits: row.research_credits,
      updatedAtMs: row.updated_at_ms
    };
  }

  getTavilyUsage(yearMonth) {
    if (typeof yearMonth !== 'string' || !/^\d{4}-\d{2}$/.test(yearMonth)) {
      throw stateError('STATE_INVALID_ARGUMENT', 'yearMonth must be in YYYY-MM format.', { field: 'yearMonth' });
    }
    return this._read(db => this._tavilyUsageRow(
      db.prepare('SELECT * FROM tavily_usage_monthly WHERE year_month = ?').get(yearMonth)
    ));
  }

  recordTavilyUsage({ yearMonth, routineCredits = 0, researchCredits = 0 }) {
    if (typeof yearMonth !== 'string' || !/^\d{4}-\d{2}$/.test(yearMonth)) {
      throw stateError('STATE_INVALID_ARGUMENT', 'yearMonth must be in YYYY-MM format.', { field: 'yearMonth' });
    }
    assertInteger(routineCredits, 'routineCredits', { min: 0 });
    assertInteger(researchCredits, 'researchCredits', { min: 0 });
    if (routineCredits === 0 && researchCredits === 0) {
      return this.getTavilyUsage(yearMonth) || { yearMonth, routineCredits: 0, researchCredits: 0, updatedAtMs: 0 };
    }
    return this.transaction(db => {
      const now = this._now();
      db.prepare('INSERT INTO tavily_usage_monthly(year_month, routine_credits, research_credits, updated_at_ms) VALUES(?, ?, ?, ?) ON CONFLICT(year_month) DO UPDATE SET routine_credits = routine_credits + excluded.routine_credits, research_credits = research_credits + excluded.research_credits, updated_at_ms = excluded.updated_at_ms').run(yearMonth, routineCredits, researchCredits, now);
      return this._tavilyUsageRow(db.prepare('SELECT * FROM tavily_usage_monthly WHERE year_month = ?').get(yearMonth));
    });
  }

  _prepareMemoryEntry(input) {
    const source = assertPlainObject(input, 'memory');
    const namespace = assertString(source.namespace, 'namespace', { max: 100, pattern: MEMORY_NAMESPACE_PATTERN });
    const key = assertString(source.key, 'key', { max: 200, pattern: MEMORY_KEY_PATTERN });
    if (!Object.prototype.hasOwnProperty.call(source, 'value')) {
      throw stateError('MEMORY_VALUE_REQUIRED', 'value is required for a memory entry.', { field: 'value' });
    }
    assertNoPlaintextMemorySecrets(source.value, 'value');
    const valueJson = canonicalJson(source.value);
    if (Buffer.byteLength(valueJson, 'utf8') > MAX_MEMORY_VALUE_BYTES) {
      throw stateError('MEMORY_VALUE_TOO_LARGE', `value exceeds the ${MAX_MEMORY_VALUE_BYTES}-byte memory limit.`, {
        field: 'value', maximumBytes: MAX_MEMORY_VALUE_BYTES
      });
    }
    const note = source.note === undefined ? null : assertString(source.note, 'note', { min: 0, max: MAX_MEMORY_NOTE_CHARS });
    if (note !== null) assertNoPlaintextMemorySecrets(note, 'note');
    const tags = assertMemoryTags(source.tags === undefined ? [] : source.tags);
    const tagsJson = canonicalJson(tags);
    const expectedRevision = source.expectedRevision === undefined
      ? undefined : assertInteger(source.expectedRevision, 'expectedRevision', { min: 0 });
    return {
      namespace, key, valueJson, valueHash: hashText(valueJson), note, tagsJson,
      expectedRevision
    };
  }

  _memoryRow(row) {
    if (!row) return null;
    const value = parseJson(row.value_json, 'memory value');
    const valueJson = canonicalJson(value);
    if (valueJson !== row.value_json || hashText(valueJson) !== row.value_hash) {
      throw stateError('MEMORY_ENTRY_INVALID', 'A stored memory value failed its canonical integrity check.', {
        namespace: row.namespace, key: row.entry_key
      });
    }
    assertNoPlaintextMemorySecrets(value, 'stored memory value');
    const tags = parseJson(row.tags_json, 'memory tags');
    const tagsJson = canonicalJson(assertMemoryTags(tags, 'stored memory tags'));
    if (tagsJson !== row.tags_json) {
      throw stateError('MEMORY_ENTRY_INVALID', 'A stored memory tag set is not canonical.', {
        namespace: row.namespace, key: row.entry_key
      });
    }
    if (row.note !== null) {
      assertString(row.note, 'stored memory note', { min: 0, max: MAX_MEMORY_NOTE_CHARS });
      assertNoPlaintextMemorySecrets(row.note, 'stored memory note');
    }
    return {
      namespace: row.namespace,
      key: row.entry_key,
      value,
      valueHash: row.value_hash,
      note: row.note,
      tags,
      revision: row.revision,
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms,
      updatedAt: iso(row.updated_at_ms),
      updatedAtMs: row.updated_at_ms
    };
  }

  setMemory(input) {
    const entry = this._prepareMemoryEntry(input);
    return this.transaction(db => {
      const now = this._now();
      const prior = db.prepare('SELECT * FROM memory_entries WHERE namespace = ? AND entry_key = ?').get(entry.namespace, entry.key);
      if (entry.expectedRevision !== undefined) {
        const actualRevision = prior ? prior.revision : 0;
        if (actualRevision !== entry.expectedRevision) {
          throw stateError('MEMORY_REVISION_CONFLICT', 'The memory entry changed before this write could be applied.', {
            namespace: entry.namespace, key: entry.key, expectedRevision: entry.expectedRevision, actualRevision
          });
        }
      }
      if (prior && prior.value_json === entry.valueJson && prior.note === entry.note && prior.tags_json === entry.tagsJson) {
        return { entry: this._memoryRow(prior), created: false, replayed: true };
      }
      if (prior) {
        db.prepare(`UPDATE memory_entries SET value_json = ?, value_hash = ?, note = ?, tags_json = ?, revision = revision + 1,
          updated_at_ms = ? WHERE namespace = ? AND entry_key = ?`).run(
          entry.valueJson, entry.valueHash, entry.note, entry.tagsJson, now, entry.namespace, entry.key
        );
      } else {
        db.prepare(`INSERT INTO memory_entries(namespace, entry_key, value_json, value_hash, note, tags_json, revision, created_at_ms, updated_at_ms)
          VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
          entry.namespace, entry.key, entry.valueJson, entry.valueHash, entry.note, entry.tagsJson, now, now
        );
      }
      const saved = db.prepare('SELECT * FROM memory_entries WHERE namespace = ? AND entry_key = ?').get(entry.namespace, entry.key);
      return { entry: this._memoryRow(saved), created: !prior, replayed: false };
    });
  }

  getMemory(input) {
    const source = assertPlainObject(input, 'memory selector');
    const namespace = assertString(source.namespace, 'namespace', { max: 100, pattern: MEMORY_NAMESPACE_PATTERN });
    const key = assertString(source.key, 'key', { max: 200, pattern: MEMORY_KEY_PATTERN });
    return this._read(db => this._memoryRow(db.prepare('SELECT * FROM memory_entries WHERE namespace = ? AND entry_key = ?').get(namespace, key)));
  }

  searchMemory(input = {}) {
    const source = assertPlainObject(input, 'memory search');
    const query = assertString(source.query, 'query', { max: 256 });
    if (!query.trim()) throw stateError('STATE_INVALID_ARGUMENT', 'query must contain at least one non-whitespace character.', { field: 'query' });
    const namespace = source.namespace === undefined
      ? undefined : assertString(source.namespace, 'namespace', { max: 100, pattern: MEMORY_NAMESPACE_PATTERN });
    const limit = assertInteger(source.limit === undefined ? 10 : source.limit, 'limit', { min: 1, max: 20 });
    const escaped = query.replace(/[\\%_]/g, character => `\\${character}`);
    const pattern = `%${escaped}%`;
    return this._read(db => {
      const where = `(namespace LIKE ? ESCAPE '\\' COLLATE NOCASE OR entry_key LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR note LIKE ? ESCAPE '\\' COLLATE NOCASE OR tags_json LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR value_json LIKE ? ESCAPE '\\' COLLATE NOCASE)`;
      const rows = namespace === undefined
        ? db.prepare(`SELECT * FROM memory_entries WHERE ${where}
          ORDER BY updated_at_ms DESC, namespace ASC, entry_key ASC LIMIT ?`).all(pattern, pattern, pattern, pattern, pattern, limit)
        : db.prepare(`SELECT * FROM memory_entries WHERE namespace = ? AND ${where}
          ORDER BY updated_at_ms DESC, entry_key ASC LIMIT ?`).all(namespace, pattern, pattern, pattern, pattern, pattern, limit);
      return rows.map(row => this._memoryRow(row));
    });
  }

  listReminderEntries(input = {}) {
    const source = assertPlainObject(input, 'reminder listing');
    const namespace = assertString(source.namespace, 'namespace', { max: 100, pattern: MEMORY_NAMESPACE_PATTERN });
    const limit = assertInteger(source.limit === undefined ? 20 : source.limit, 'limit', { min: 1, max: 20 });
    const before = source.dueBefore === undefined ? undefined : assertString(source.dueBefore, 'dueBefore', { max: 40 });
    if (before !== undefined && (!Number.isFinite(Date.parse(before)) || new Date(before).toISOString() !== before)) {
      throw stateError('STATE_INVALID_ARGUMENT', 'dueBefore must be a normalized UTC timestamp.', { field: 'dueBefore' });
    }
    return this._read(db => {
      const conditions = ['namespace = ?'];
      const parameters = [namespace];
      if (source.includeCompleted !== true) conditions.push("COALESCE(json_extract(value_json, '$.status'), '') != 'completed'");
      if (before !== undefined) {
        conditions.push("json_extract(value_json, '$.dueAt') <= ?");
        parameters.push(before);
      }
      // General memory search limits by recency. Reminder filters and deadline
      // order must happen before LIMIT or newer future/completed entries can
      // hide an older deadline. Selected rows retain all memory integrity checks.
      const rows = db.prepare(`SELECT * FROM memory_entries WHERE ${conditions.join(' AND ')}
        ORDER BY json_extract(value_json, '$.dueAt') IS NULL ASC,
          json_extract(value_json, '$.dueAt') ASC, entry_key ASC LIMIT ?`).all(...parameters, limit);
      return rows.map(row => this._memoryRow(row));
    });
  }

  _approvalGrantInput(input, { includeToken = true } = {}) {
    const source = assertPlainObject(input, 'approval grant');
    const action = assertString(source.action, 'action', { max: 200, pattern: /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/ });
    const inputHash = assertString(source.inputHash, 'inputHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const prepared = { action, inputHash };
    if (includeToken) {
      prepared.tokenHash = assertString(source.tokenHash, 'tokenHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
      prepared.expiresAtMs = assertInteger(source.expiresAtMs, 'expiresAtMs');
      prepared.id = source.id === undefined ? this._newId('approval')
        : assertString(source.id, 'id', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]+$/ });
    } else {
      prepared.tokenHash = assertString(source.tokenHash, 'tokenHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    }
    return prepared;
  }

  _approvalGrantRow(row) {
    if (!row) return null;
    return {
      approvalId: row.id,
      action: row.action,
      inputHash: row.input_hash,
      status: row.status,
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms,
      expiresAt: iso(row.expires_at_ms),
      expiresAtMs: row.expires_at_ms,
      consumedAt: row.consumed_at_ms === null ? null : iso(row.consumed_at_ms),
      consumedAtMs: row.consumed_at_ms
    };
  }

  createApprovalGrant(input) {
    const grant = this._approvalGrantInput(input);
    return this.transaction(db => {
      const now = this._now();
      if (grant.expiresAtMs <= now || grant.expiresAtMs > now + MAX_APPROVAL_TTL_MS) {
        throw stateError('APPROVAL_EXPIRY_INVALID', `Approval expiry must be after now and within ${MAX_APPROVAL_TTL_MS} ms.`, {
          expiresAtMs: grant.expiresAtMs, now
        });
      }
      db.prepare(`INSERT INTO approval_grants(id, token_hash, action, input_hash, status, created_at_ms, expires_at_ms, consumed_at_ms)
        VALUES(?, ?, ?, ?, 'approved', ?, ?, NULL)`).run(
        grant.id, grant.tokenHash, grant.action, grant.inputHash, now, grant.expiresAtMs
      );
      return this._approvalGrantRow(db.prepare('SELECT * FROM approval_grants WHERE id = ?').get(grant.id));
    });
  }

  consumeApprovalGrant(input) {
    const request = this._approvalGrantInput(input, { includeToken: false });
    const outcome = this.transaction(db => {
      const now = this._now();
      const row = db.prepare('SELECT * FROM approval_grants WHERE token_hash = ?').get(request.tokenHash);
      if (!row) return { error: stateError('APPROVAL_NOT_FOUND', 'The approval token is unknown.') };
      if (row.action !== request.action || row.input_hash !== request.inputHash) {
        return { error: stateError('APPROVAL_BINDING_MISMATCH', 'The approval token is not valid for this exact action and input.') };
      }
      if (row.status === 'consumed') return { error: stateError('APPROVAL_ALREADY_USED', 'The approval token was already consumed.') };
      if (row.status === 'expired' || row.expires_at_ms <= now) {
        if (row.status === 'approved') {
          db.prepare("UPDATE approval_grants SET status = 'expired' WHERE id = ? AND status = 'approved'").run(row.id);
        }
        return { error: stateError('APPROVAL_EXPIRED', 'The approval token expired before the action began.') };
      }
      const changed = db.prepare(`UPDATE approval_grants SET status = 'consumed', consumed_at_ms = ?
        WHERE id = ? AND status = 'approved' AND expires_at_ms > ?`).run(now, row.id, now);
      if (changed.changes !== 1) return { error: stateError('APPROVAL_ALREADY_USED', 'The approval token was consumed concurrently.') };
      return { grant: this._approvalGrantRow(db.prepare('SELECT * FROM approval_grants WHERE id = ?').get(row.id)) };
    });
    if (outcome.error) throw outcome.error;
    return outcome.grant;
  }

  _scopedApprovalEvent(db, approvalId, eventType, reasonCode, occurredAtMs) {
    const eventHash = hashInput({
      domain: 'coordinator.scoped-approval-event.v1', approvalId, eventType, reasonCode, occurredAtMs
    });
    db.prepare(`INSERT INTO scoped_approval_events(approval_id, event_type, reason_code, event_hash, occurred_at_ms)
      VALUES(?, ?, ?, ?, ?)`).run(approvalId, eventType, reasonCode, eventHash, occurredAtMs);
    return eventHash;
  }

  _scopedApprovalState(db, approvalId) {
    const row = db.prepare(`SELECT event_type, reason_code, occurred_at_ms FROM scoped_approval_events
      WHERE approval_id = ? ORDER BY sequence DESC LIMIT 1`).get(approvalId);
    return row ? Object.freeze({ state: row.event_type, reasonCode: row.reason_code, changedAtMs: row.occurred_at_ms }) : null;
  }

  _scopedApprovalPreview(row) {
    const parameters = parseJson(row.parameters_json, 'scoped approval parameters');
    const subject = parseJson(row.subject_json, 'scoped approval subject');
    return Object.freeze({
      schemaVersion: 1,
      action: row.tool_name,
      target: Object.freeze({ kind: row.target_kind, identifierHash: row.target_hash, pinned: true }),
      parameters,
      subject,
      provenanceEvidence: Object.freeze({ evidenceId: row.provenance_evidence_id, provenanceHash: row.provenance_hash }),
      expiresAtMs: row.expires_at_ms,
      singleUse: true
    });
  }

  _scopedApprovalRow(db, row) {
    if (!row) return null;
    const state = this._scopedApprovalState(db, row.approval_id);
    const preview = this._scopedApprovalPreview(row);
    return Object.freeze({
      approvalId: row.approval_id,
      authorizationId: row.authorization_id,
      taskId: row.task_id,
      action: row.tool_name,
      target: preview.target,
      parameters: preview.parameters,
      parametersHash: row.parameters_hash,
      subject: preview.subject,
      provenanceEvidence: preview.provenanceEvidence,
      previewHash: row.preview_hash,
      expiresAt: iso(row.expires_at_ms),
      expiresAtMs: row.expires_at_ms,
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms,
      state: state ? state.state : 'invalid',
      stateReasonCode: state ? state.reasonCode : 'STATE_MISSING',
      stateChangedAtMs: state ? state.changedAtMs : null,
      singleUse: true,
      preview
    });
  }

  _assertScopedSubject(value) {
    const subject = assertPlainObject(value, 'scoped approval subject');
    const keys = Object.keys(subject).sort();
    if (keys.length !== 2 || keys[0] !== 'idHash' || keys[1] !== 'kind'
      || subject.kind !== 'owner-authenticated'
      || typeof subject.idHash !== 'string' || !/^[a-f0-9]{64}$/.test(subject.idHash)) {
      throw stateError('SCOPED_APPROVAL_SUBJECT_INVALID', 'A scoped approval requires one exact owner-authenticated subject hash.', { field: 'subject' });
    }
    return Object.freeze({ kind: subject.kind, idHash: subject.idHash });
  }

  _assertScopedApprovalId(value) {
    return assertString(value, 'approvalId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
  }

  _assertP13DispatchBinding(db, authorizationId, toolName, argsHash, now) {
    const authorization = db.prepare(`SELECT * FROM policy_dispatch_authorizations WHERE authorization_id = ?`).get(authorizationId);
    if (!authorization) throw stateError('POLICY_AUTHORIZATION_MISSING', 'The P13 dispatch authorization was not found.', { authorizationId });
    if (authorization.tool_name !== toolName || !equalHash(authorization.args_hash, argsHash)) {
      throw stateError('POLICY_AUTHORIZATION_BINDING_MISMATCH', 'The P13 authorization is not bound to these exact tool arguments.', { authorizationId });
    }
    // A task-scoped grant cannot outlive its task or the person's Stop request.
    // Read this in the same transaction as dispatch consumption so cancellation
    // cannot commit between the task check and the authorization decision.
    const task = db.prepare('SELECT status, cancel_requested_at_ms FROM tasks WHERE id = ?').get(authorization.task_id);
    if (!task || !['queued', 'leased', 'running', 'retry_wait'].includes(task.status)
      || task.cancel_requested_at_ms !== null) {
      throw stateError('POLICY_TASK_INACTIVE', 'The task is no longer authorized to dispatch work.', {
        authorizationId, taskId: authorization.task_id, status: task ? task.status : 'missing'
      });
    }
    const profile = db.prepare(`SELECT * FROM capability_profile_versions WHERE profile_id = ? AND version = ?`).get(authorization.profile_id, authorization.profile_version);
    if (!profile || !equalHash(profile.manifest_hash, authorization.profile_hash) || profile.task_id !== authorization.task_id) {
      throw stateError('CAPABILITY_MANIFEST_BINDING_MISMATCH', 'The P12 profile no longer matches this P13 authorization.', { authorizationId });
    }
    if (now >= profile.expires_at_ms) throw stateError('CAPABILITY_MANIFEST_EXPIRED', 'The P12 profile expired before dispatch.', { authorizationId });
    if (db.prepare(`SELECT 1 FROM capability_profile_revocations WHERE profile_id = ? AND profile_version = ?`).get(authorization.profile_id, authorization.profile_version)) {
      throw stateError('CAPABILITY_MANIFEST_REVOKED', 'The P12 profile was revoked before dispatch.', { authorizationId });
    }
    const request = db.prepare(`SELECT * FROM capability_profile_requests WHERE request_hash = ?`).get(authorization.request_hash);
    const bound = request && parseJson(request.request_json, 'authorized capability request');
    if (!request || request.status !== 'authorized' || request.request_kind !== 'tool' || request.task_id !== authorization.task_id
      || request.profile_id !== authorization.profile_id || request.profile_version !== authorization.profile_version
      || !equalHash(request.profile_hash, authorization.profile_hash) || !bound || !bound.request
      || bound.request.tool !== authorization.tool_name || bound.request.taskId !== authorization.task_id) {
      throw stateError('POLICY_CAPABILITY_REQUEST_MISMATCH', 'The P12 request no longer binds this P13 authorization.', { authorizationId });
    }
    return authorization;
  }

  recordScopedApprovalProvenance(input) {
    const source = assertPlainObject(input, 'scoped approval provenance');
    if (Object.keys(source).some(key => !['evidenceId', 'taskId', 'provenance'].includes(key))) {
      throw stateError('STATE_INVALID_ARGUMENT', 'Scoped approval provenance contains unsupported fields.', { field: 'scoped approval provenance' });
    }
    const evidenceId = assertString(source.evidenceId, 'evidenceId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    const taskId = assertString(source.taskId, 'taskId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    let provenance;
    try { provenance = provenanceEnvelopes.validateEnvelope(source.provenance); }
    catch (error) { throw stateError('SCOPED_APPROVAL_PROVENANCE_INVALID', 'Scoped approval provenance must be a canonical P08 envelope.', { evidenceId }, error); }
    const provenanceJson = canonicalJson(provenance);
    const provenanceHash = hashInput({ domain: 'coordinator.scoped-approval-provenance.v1', evidenceId, taskId, provenance });
    return this.transaction(db => {
      if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) {
        throw stateError('SCOPED_APPROVAL_TASK_MISSING', 'Scoped approval provenance requires an existing task.', { taskId });
      }
      const existing = db.prepare('SELECT * FROM scoped_approval_provenance WHERE evidence_id = ?').get(evidenceId);
      if (existing) {
        if (existing.task_id === taskId && existing.provenance_json === provenanceJson && equalHash(existing.provenance_hash, provenanceHash)) {
          return Object.freeze({ evidenceId, taskId, provenanceHash, replayed: true });
        }
        throw stateError('SCOPED_APPROVAL_PROVENANCE_CONFLICT', 'A provenance evidence ID already has different immutable content.', { evidenceId });
      }
      const now = this._now();
      db.prepare(`INSERT INTO scoped_approval_provenance(evidence_id, task_id, provenance_json, provenance_hash, created_at_ms)
        VALUES(?, ?, ?, ?, ?)`).run(evidenceId, taskId, provenanceJson, provenanceHash, now);
      return Object.freeze({ evidenceId, taskId, provenanceHash, replayed: false });
    });
  }

  createScopedApprovalAction(input) {
    const source = assertPlainObject(input, 'scoped approval action');
    if (Object.keys(source).some(key => !['authorizationId', 'parameters', 'subject', 'provenanceEvidenceId', 'expiresAtMs'].includes(key))) {
      throw stateError('STATE_INVALID_ARGUMENT', 'Scoped approval actions are controller-created from closed fields only.', { field: 'scoped approval action' });
    }
    const authorizationId = assertString(source.authorizationId, 'authorizationId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    const parameters = assertPlainObject(source.parameters, 'scoped approval parameters');
    const parametersJson = boundedTaskJson(parameters, 'scoped approval parameters', 64 * 1024, 'SCOPED_APPROVAL_PARAMETERS_TOO_LARGE');
    const parametersHash = hashInput(parameters);
    const subject = this._assertScopedSubject(source.subject);
    const subjectJson = canonicalJson(subject);
    const subjectHash = hashInput({ domain: 'coordinator.scoped-approval-subject.v1', subject });
    const provenanceEvidenceId = assertString(source.provenanceEvidenceId, 'provenanceEvidenceId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    const expiresAtMs = assertInteger(source.expiresAtMs, 'expiresAtMs');
    return this.transaction(db => {
      const now = this._now();
      if (expiresAtMs <= now || expiresAtMs > now + MAX_APPROVAL_TTL_MS) {
        throw stateError('APPROVAL_EXPIRY_INVALID', `Scoped approval expiry must be after now and within ${MAX_APPROVAL_TTL_MS} ms.`, { expiresAtMs, now });
      }
      const existing = db.prepare('SELECT * FROM scoped_approval_actions WHERE authorization_id = ?').get(authorizationId);
      if (existing) {
        if (existing.parameters_json === parametersJson && existing.subject_json === subjectJson
          && existing.provenance_evidence_id === provenanceEvidenceId && existing.expires_at_ms === expiresAtMs) {
          return Object.freeze({ replayed: true, action: this._scopedApprovalRow(db, existing) });
        }
        throw stateError('SCOPED_APPROVAL_ACTION_CONFLICT', 'A P13 authorization already has a different immutable scoped approval action.', { authorizationId });
      }
      const authorization = this._assertP13DispatchBinding(db, authorizationId,
        db.prepare('SELECT tool_name FROM policy_dispatch_authorizations WHERE authorization_id = ?').get(authorizationId)?.tool_name || '', parametersHash, now);
      const provenanceRecord = db.prepare('SELECT * FROM scoped_approval_provenance WHERE evidence_id = ?').get(provenanceEvidenceId);
      if (!provenanceRecord || provenanceRecord.task_id !== authorization.task_id) {
        throw stateError('SCOPED_APPROVAL_PROVENANCE_MISMATCH', 'The broker-owned provenance evidence is not bound to this P13 task.', { authorizationId, provenanceEvidenceId });
      }
      let provenance;
      try { provenance = provenanceEnvelopes.validateEnvelope(parseJson(provenanceRecord.provenance_json, 'scoped approval provenance')); }
      catch (error) { throw stateError('SCOPED_APPROVAL_PROVENANCE_CORRUPT', 'Stored scoped approval provenance is invalid.', { authorizationId, provenanceEvidenceId }, error); }
      const approvalId = this._assertScopedApprovalId(this._newId('scoped-approval'));
      const preview = Object.freeze({
        schemaVersion: 1,
        action: authorization.tool_name,
        target: Object.freeze({ kind: authorization.target_kind, identifierHash: authorization.target_hash, pinned: true }),
        parameters: JSON.parse(parametersJson),
        subject,
        provenanceEvidence: Object.freeze({ evidenceId: provenanceEvidenceId, provenanceHash: provenanceRecord.provenance_hash }),
        expiresAtMs,
        singleUse: true
      });
      const previewHash = hashInput({ domain: 'coordinator.scoped-approval-preview.v1', preview });
      db.prepare(`INSERT INTO scoped_approval_actions(
        approval_id, authorization_id, task_id, tool_name, args_hash, target_kind, target_hash,
        parameters_json, parameters_hash, subject_json, subject_hash, provenance_evidence_id, provenance_hash, preview_hash,
        expires_at_ms, created_at_ms
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        approvalId, authorizationId, authorization.task_id, authorization.tool_name, parametersHash, authorization.target_kind, authorization.target_hash,
        parametersJson, parametersHash, subjectJson, subjectHash, provenanceEvidenceId, provenanceRecord.provenance_hash, previewHash,
        expiresAtMs, now
      );
      this._scopedApprovalEvent(db, approvalId, 'created', 'CREATED', now);
      return Object.freeze({ replayed: false, action: this._scopedApprovalRow(db, db.prepare('SELECT * FROM scoped_approval_actions WHERE approval_id = ?').get(approvalId)) });
    });
  }

  getScopedApprovalAction(input) {
    const source = assertExactDataObject(input, ['approvalId'], 'scoped approval selector');
    const approvalId = this._assertScopedApprovalId(source.approvalId);
    return this._read(db => this._scopedApprovalRow(db, db.prepare('SELECT * FROM scoped_approval_actions WHERE approval_id = ?').get(approvalId)));
  }

  _expireScopedApproval(db, action, now) {
    const current = this._scopedApprovalState(db, action.approval_id);
    if (current && ['created', 'approved'].includes(current.state)) this._scopedApprovalEvent(db, action.approval_id, 'expired', 'APPROVAL_EXPIRED', now);
  }

  expireScopedApproval(input) {
    const source = assertPlainObject(input, 'scoped approval expiry');
    if (Object.keys(source).length !== 1 || !Object.hasOwn(source, 'approvalId')) throw stateError('STATE_INVALID_ARGUMENT', 'Scoped approval expiry has unsupported fields.', { field: 'scoped approval expiry' });
    const approvalId = this._assertScopedApprovalId(source.approvalId);
    return this.transaction(db => {
      const action = db.prepare('SELECT * FROM scoped_approval_actions WHERE approval_id = ?').get(approvalId);
      if (!action) throw stateError('SCOPED_APPROVAL_NOT_FOUND', 'The scoped approval was not found.', { approvalId });
      const now = this._now();
      if (action.expires_at_ms > now) throw stateError('SCOPED_APPROVAL_NOT_EXPIRED', 'The scoped approval has not expired.', { approvalId });
      this._expireScopedApproval(db, action, now);
      return this._scopedApprovalRow(db, action);
    });
  }

  approveScopedApproval(input) {
    const source = assertPlainObject(input, 'scoped approval UI decision');
    if (Object.keys(source).some(key => !['approvalId', 'previewHash', 'tokenHash'].includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'Scoped approval UI decision has unsupported fields.', { field: 'scoped approval UI decision' });
    const approvalId = this._assertScopedApprovalId(source.approvalId);
    const previewHash = assertString(source.previewHash, 'previewHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const tokenHash = assertString(source.tokenHash, 'tokenHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const outcome = this.transaction(db => {
      const now = this._now();
      const action = db.prepare('SELECT * FROM scoped_approval_actions WHERE approval_id = ?').get(approvalId);
      if (!action) throw stateError('SCOPED_APPROVAL_NOT_FOUND', 'The scoped approval was not found.', { approvalId });
      const current = this._scopedApprovalState(db, approvalId);
      if (!equalHash(action.preview_hash, previewHash)) {
        if (current && ['created', 'approved'].includes(current.state)) this._scopedApprovalEvent(db, approvalId, 'mismatch', 'PREVIEW_HASH_MISMATCH', now);
        return { error: stateError('APPROVAL_STALE', 'The approval preview no longer matches the canonical action.', { approvalId }) };
      }
      if (action.expires_at_ms <= now) {
        this._expireScopedApproval(db, action, now);
        return { error: stateError('APPROVAL_EXPIRED', 'The scoped approval expired before it was confirmed.', { approvalId }) };
      }
      if (!current || current.state !== 'created') throw stateError('SCOPED_APPROVAL_STATE_INVALID', 'The scoped approval is no longer awaiting a decision.', { approvalId, state: current && current.state });
      db.prepare('INSERT INTO scoped_approval_grants(approval_id, token_hash, approved_at_ms) VALUES(?, ?, ?)').run(approvalId, tokenHash, now);
      this._scopedApprovalEvent(db, approvalId, 'approved', 'APPROVED', now);
      return { action: this._scopedApprovalRow(db, action) };
    });
    if (outcome.error) throw outcome.error;
    return outcome.action;
  }

  declineScopedApproval(input) {
    const source = assertPlainObject(input, 'scoped approval UI decline');
    if (Object.keys(source).some(key => !['approvalId', 'previewHash'].includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'Scoped approval UI decline has unsupported fields.', { field: 'scoped approval UI decline' });
    const approvalId = this._assertScopedApprovalId(source.approvalId);
    const previewHash = assertString(source.previewHash, 'previewHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const outcome = this.transaction(db => {
      const now = this._now();
      const action = db.prepare('SELECT * FROM scoped_approval_actions WHERE approval_id = ?').get(approvalId);
      if (!action) throw stateError('SCOPED_APPROVAL_NOT_FOUND', 'The scoped approval was not found.', { approvalId });
      const current = this._scopedApprovalState(db, approvalId);
      if (!equalHash(action.preview_hash, previewHash)) {
        if (current && ['created', 'approved'].includes(current.state)) this._scopedApprovalEvent(db, approvalId, 'mismatch', 'PREVIEW_HASH_MISMATCH', now);
        return { error: stateError('APPROVAL_STALE', 'The approval preview no longer matches the canonical action.', { approvalId }) };
      }
      if (action.expires_at_ms <= now) {
        this._expireScopedApproval(db, action, now);
        return { error: stateError('APPROVAL_EXPIRED', 'The scoped approval expired before it was declined.', { approvalId }) };
      }
      if (!current || current.state !== 'created') throw stateError('SCOPED_APPROVAL_STATE_INVALID', 'The scoped approval is no longer awaiting a decision.', { approvalId, state: current && current.state });
      this._scopedApprovalEvent(db, approvalId, 'declined', 'DECLINED', now);
      return { action: this._scopedApprovalRow(db, action) };
    });
    if (outcome.error) throw outcome.error;
    return outcome.action;
  }

  cancelScopedApproval(input) {
    const source = assertPlainObject(input, 'scoped approval cancellation');
    if (Object.keys(source).some(key => !['approvalId', 'reasonCode'].includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'Scoped approval cancellation has unsupported fields.', { field: 'scoped approval cancellation' });
    const approvalId = this._assertScopedApprovalId(source.approvalId);
    const reasonCode = assertString(source.reasonCode, 'reasonCode', { min: 3, max: 120, pattern: /^[A-Z][A-Z0-9_]{2,119}$/ });
    const outcome = this.transaction(db => {
      const action = db.prepare('SELECT * FROM scoped_approval_actions WHERE approval_id = ?').get(approvalId);
      if (!action) throw stateError('SCOPED_APPROVAL_NOT_FOUND', 'The scoped approval was not found.', { approvalId });
      const current = this._scopedApprovalState(db, approvalId);
      const now = this._now();
      // Expiry wins over a later cancellation.  Persist it before returning
      // the typed stale outcome so no post-deadline caller can replace the
      // canonical terminal state with cancelled.
      if (action.expires_at_ms <= now) {
        this._expireScopedApproval(db, action, now);
        return { error: stateError('APPROVAL_EXPIRED', 'The scoped approval expired before it could be cancelled.', { approvalId }) };
      }
      if (!current || !['created', 'approved'].includes(current.state)) throw stateError('SCOPED_APPROVAL_STATE_INVALID', 'The scoped approval is no longer cancellable.', { approvalId, state: current && current.state });
      this._scopedApprovalEvent(db, approvalId, 'cancelled', reasonCode, now);
      return { action: this._scopedApprovalRow(db, action) };
    });
    if (outcome.error) throw outcome.error;
    return outcome.action;
  }

  revokeScopedApproval(input) {
    const source = assertPlainObject(input, 'scoped approval revocation');
    if (Object.keys(source).some(key => !['approvalId', 'reasonCode'].includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'Scoped approval revocation has unsupported fields.', { field: 'scoped approval revocation' });
    const approvalId = this._assertScopedApprovalId(source.approvalId);
    const reasonCode = assertString(source.reasonCode, 'reasonCode', { min: 3, max: 120, pattern: /^[A-Z][A-Z0-9_]{2,119}$/ });
    const outcome = this.transaction(db => {
      const action = db.prepare('SELECT * FROM scoped_approval_actions WHERE approval_id = ?').get(approvalId);
      if (!action) throw stateError('SCOPED_APPROVAL_NOT_FOUND', 'The scoped approval was not found.', { approvalId });
      const current = this._scopedApprovalState(db, approvalId);
      const now = this._now();
      // A revocation request after expiry must not overwrite expiry.  The
      // append-only stream records expiry first and the error is raised only
      // after that transaction commits.
      if (action.expires_at_ms <= now) {
        this._expireScopedApproval(db, action, now);
        return { error: stateError('APPROVAL_EXPIRED', 'The scoped approval expired before it could be revoked.', { approvalId }) };
      }
      if (!current || !['created', 'approved'].includes(current.state)) throw stateError('SCOPED_APPROVAL_STATE_INVALID', 'The scoped approval is no longer revocable.', { approvalId, state: current && current.state });
      this._scopedApprovalEvent(db, approvalId, 'revoked', reasonCode, now);
      return { action: this._scopedApprovalRow(db, action) };
    });
    if (outcome.error) throw outcome.error;
    return outcome.action;
  }

  consumeScopedApprovalDispatch(input) {
    const source = assertPlainObject(input, 'scoped approval dispatch consumption');
    if (Object.keys(source).some(key => !['authorizationId', 'toolName', 'argsHash', 'tokenHash'].includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'Scoped approval dispatch consumption has unsupported fields.', { field: 'scoped approval dispatch consumption' });
    const authorizationId = assertString(source.authorizationId, 'authorizationId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    const toolName = assertString(source.toolName, 'toolName', { min: 3, max: 200, pattern: /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/ });
    const argsHash = assertString(source.argsHash, 'argsHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const tokenHash = assertString(source.tokenHash, 'tokenHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const outcome = this.transaction(db => {
      const now = this._now();
      const action = db.prepare('SELECT * FROM scoped_approval_actions WHERE authorization_id = ?').get(authorizationId);
      if (!action) throw stateError('APPROVAL_REQUIRED', 'The P13 action has no controller-created scoped approval.', { authorizationId });
      const current = this._scopedApprovalState(db, action.approval_id);
      if (action.tool_name !== toolName || !equalHash(action.args_hash, argsHash)) {
        if (current && ['created', 'approved'].includes(current.state)) this._scopedApprovalEvent(db, action.approval_id, 'mismatch', 'ACTION_BINDING_MISMATCH', now);
        return { error: stateError('APPROVAL_STALE', 'The execution no longer matches the approved canonical action.', { authorizationId, approvalId: action.approval_id }) };
      }
      if (action.expires_at_ms <= now) {
        this._expireScopedApproval(db, action, now);
        return { error: stateError('APPROVAL_EXPIRED', 'The scoped approval expired before dispatch.', { approvalId: action.approval_id }) };
      }
      if (!current || current.state !== 'approved') {
        const codes = { created: 'APPROVAL_REQUIRED', declined: 'APPROVAL_DECLINED', cancelled: 'APPROVAL_CANCELLED', revoked: 'APPROVAL_REVOKED', expired: 'APPROVAL_EXPIRED', mismatch: 'APPROVAL_STALE', consumed: 'APPROVAL_ALREADY_USED' };
        throw stateError(codes[current && current.state] || 'SCOPED_APPROVAL_STATE_INVALID', 'The scoped approval is not available for dispatch.', { approvalId: action.approval_id, state: current && current.state });
      }
      const grant = db.prepare('SELECT * FROM scoped_approval_grants WHERE approval_id = ?').get(action.approval_id);
      if (!grant || !equalHash(grant.token_hash, tokenHash)) throw stateError('APPROVAL_TOKEN_INVALID', 'The supplied approval token does not match this scoped action.', { approvalId: action.approval_id });
      let authorization;
      try { authorization = this._assertP13DispatchBinding(db, authorizationId, toolName, argsHash, now); }
      catch (error) {
        if (error && ['CAPABILITY_MANIFEST_EXPIRED', 'CAPABILITY_MANIFEST_REVOKED', 'CAPABILITY_MANIFEST_BINDING_MISMATCH', 'POLICY_CAPABILITY_REQUEST_MISMATCH', 'POLICY_TASK_INACTIVE'].includes(error.code)) {
          this._scopedApprovalEvent(db, action.approval_id, 'cancelled', error.code, now);
          return { error };
        }
        throw error;
      }
      if (db.prepare('SELECT 1 FROM policy_dispatch_consumptions WHERE authorization_id = ?').get(authorizationId)) {
        throw stateError('POLICY_AUTHORIZATION_REPLAYED', 'The P13 dispatch authorization was already consumed.', { authorizationId });
      }
      const provenanceRecord = db.prepare('SELECT * FROM scoped_approval_provenance WHERE evidence_id = ?').get(action.provenance_evidence_id);
      if (!provenanceRecord || provenanceRecord.task_id !== authorization.task_id || !equalHash(provenanceRecord.provenance_hash, action.provenance_hash)) {
        this._scopedApprovalEvent(db, action.approval_id, 'mismatch', 'PROVENANCE_EVIDENCE_MISMATCH', now);
        return { error: stateError('SCOPED_APPROVAL_PROVENANCE_MISMATCH', 'The broker-owned provenance evidence no longer matches the canonical action.', { approvalId: action.approval_id }) };
      }
      let provenance;
      try { provenance = provenanceEnvelopes.validateEnvelope(parseJson(provenanceRecord.provenance_json, 'scoped approval provenance')); }
      catch (error) { throw stateError('SCOPED_APPROVAL_PROVENANCE_CORRUPT', 'Stored scoped approval provenance is invalid.', { approvalId: action.approval_id }, error); }
      db.prepare(`INSERT INTO policy_dispatch_consumptions(authorization_id, args_hash, consumed_at_ms, approval_id)
        VALUES(?, ?, ?, ?)`).run(authorizationId, argsHash, now, action.approval_id);
      this._scopedApprovalEvent(db, action.approval_id, 'consumed', 'CONSUMED', now);
      return { result: Object.freeze({
        authorizationId,
        approvalId: action.approval_id,
        previewHash: action.preview_hash,
        taskId: authorization.task_id,
        toolName: authorization.tool_name,
        argsHash: authorization.args_hash,
        target: Object.freeze({ kind: authorization.target_kind, identifierHash: authorization.target_hash, pinned: true }),
        provenance,
        risk: authorization.risk,
        delegationDepth: authorization.delegation_depth,
        userKind: authorization.user_kind,
        capability: Object.freeze({ status: 'authorized', profileHash: authorization.profile_hash, requestHash: authorization.request_hash, taskId: authorization.task_id, tool: authorization.tool_name }),
        approval: Object.freeze({ status: 'consumed' })
      }) };
    });
    if (outcome.error) throw outcome.error;
    return outcome.result;
  }

  _remoteAskInput(input) {
    const source = assertPlainObject(input, 'remote ask');
    const id = assertString(source.id, 'id', { min: 16, max: 60, pattern: /^[A-Za-z0-9_-]+$/ });
    const yesCallbackHash = assertString(source.yesCallbackHash, 'yesCallbackHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const noCallbackHash = assertString(source.noCallbackHash, 'noCallbackHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    if (yesCallbackHash === noCallbackHash) throw stateError('REMOTE_ASK_INVALID', 'Remote ask callbacks must be distinct.', { field: 'callbackHash' });
    return {
      id,
      yesCallbackHash,
      noCallbackHash,
      chatId: assertString(source.chatId, 'chatId', { min: 1, max: 100 }),
      expiresAtMs: assertInteger(source.expiresAtMs, 'expiresAtMs')
    };
  }

  _remoteAskRow(row) {
    if (!row) return null;
    return {
      askId: row.id,
      chatId: row.chat_id,
      messageId: row.message_id,
      status: row.status,
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms,
      expiresAt: iso(row.expires_at_ms),
      expiresAtMs: row.expires_at_ms,
      resolvedAt: row.resolved_at_ms === null ? null : iso(row.resolved_at_ms),
      resolvedAtMs: row.resolved_at_ms,
      resolutionUpdateId: row.resolution_update_id,
      disarmedAt: row.disarmed_at_ms === null ? null : iso(row.disarmed_at_ms),
      disarmedAtMs: row.disarmed_at_ms,
      errorCode: row.error_code
    };
  }

  _pruneRemoteAsks(db, now) {
    db.prepare(`UPDATE remote_asks SET status = 'timeout', resolved_at_ms = ?, resolution_update_id = NULL, error_code = NULL
      WHERE status = 'pending' AND expires_at_ms <= ?`).run(now, now);
    return db.prepare(`DELETE FROM remote_asks WHERE status <> 'pending' AND resolved_at_ms <= ?`).run(
      Math.max(0, now - REMOTE_ASK_RETENTION_MS)
    ).changes;
  }

  createRemoteAsk(input) {
    const ask = this._remoteAskInput(input);
    return this.transaction(db => {
      const now = this._now();
      this._pruneRemoteAsks(db, now);
      if (ask.expiresAtMs <= now || ask.expiresAtMs > now + MAX_REMOTE_ASK_TTL_MS) {
        throw stateError('REMOTE_ASK_EXPIRY_INVALID', `Remote ask expiry must be after now and within ${MAX_REMOTE_ASK_TTL_MS} ms.`, {
          expiresAtMs: ask.expiresAtMs, now
        });
      }
      db.prepare(`INSERT INTO remote_asks(id, yes_callback_hash, no_callback_hash, chat_id, message_id, status,
        created_at_ms, expires_at_ms, resolved_at_ms, resolution_update_id, disarmed_at_ms, error_code)
        VALUES(?, ?, ?, ?, NULL, 'pending', ?, ?, NULL, NULL, NULL, NULL)`).run(
        ask.id, ask.yesCallbackHash, ask.noCallbackHash, ask.chatId, now, ask.expiresAtMs
      );
      return this._remoteAskRow(db.prepare('SELECT * FROM remote_asks WHERE id = ?').get(ask.id));
    });
  }

  attachRemoteAskMessage(input) {
    const source = assertPlainObject(input, 'remote ask message');
    const id = assertString(source.id, 'id', { min: 16, max: 60, pattern: /^[A-Za-z0-9_-]+$/ });
    const messageId = assertInteger(source.messageId, 'messageId', { min: 0 });
    return this.transaction(db => {
      const row = db.prepare('SELECT * FROM remote_asks WHERE id = ?').get(id);
      if (!row) throw stateError('REMOTE_ASK_NOT_FOUND', 'The remote ask was not found.', { askId: id });
      if (row.message_id !== null && row.message_id !== messageId) {
        throw stateError('REMOTE_ASK_MESSAGE_CONFLICT', 'The historical remote ask is already bound to a different message receipt.', { askId: id });
      }
      if (row.message_id === null) db.prepare('UPDATE remote_asks SET message_id = ? WHERE id = ?').run(messageId, id);
      return this._remoteAskRow(db.prepare('SELECT * FROM remote_asks WHERE id = ?').get(id));
    });
  }

  getRemoteAsk(input) {
    const source = assertPlainObject(input, 'remote ask selector');
    const id = assertString(source.id, 'id', { min: 16, max: 60, pattern: /^[A-Za-z0-9_-]+$/ });
    return this._read(db => this._remoteAskRow(db.prepare('SELECT * FROM remote_asks WHERE id = ?').get(id)));
  }

  _finishRemoteAsk(db, row, status, now, errorCode = null) {
    if (row.status !== 'pending') return this._remoteAskRow(row);
    const update = db.prepare(`UPDATE remote_asks SET status = ?, resolved_at_ms = ?, resolution_update_id = NULL, error_code = ?
      WHERE id = ? AND status = 'pending'`).run(status, now, errorCode, row.id);
    if (update.changes !== 1) return this._remoteAskRow(db.prepare('SELECT * FROM remote_asks WHERE id = ?').get(row.id));
    return this._remoteAskRow(db.prepare('SELECT * FROM remote_asks WHERE id = ?').get(row.id));
  }

  expireRemoteAsk(input) {
    const source = assertPlainObject(input, 'remote ask expiry');
    const id = assertString(source.id, 'id', { min: 16, max: 60, pattern: /^[A-Za-z0-9_-]+$/ });
    return this.transaction(db => {
      const now = this._now();
      const row = db.prepare('SELECT * FROM remote_asks WHERE id = ?').get(id);
      if (!row) throw stateError('REMOTE_ASK_NOT_FOUND', 'The remote ask was not found.', { askId: id });
      if (row.status === 'pending' && row.expires_at_ms > now) {
        throw stateError('REMOTE_ASK_NOT_EXPIRED', 'The remote ask has not expired.', { askId: id, expiresAtMs: row.expires_at_ms });
      }
      return this._finishRemoteAsk(db, row, 'timeout', now);
    });
  }

  markRemoteAskUnavailable(input) {
    const source = assertPlainObject(input, 'remote ask failure');
    const id = assertString(source.id, 'id', { min: 16, max: 60, pattern: /^[A-Za-z0-9_-]+$/ });
    const errorCode = assertString(source.errorCode, 'errorCode', { min: 1, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/ });
    return this.transaction(db => {
      const row = db.prepare('SELECT * FROM remote_asks WHERE id = ?').get(id);
      if (!row) throw stateError('REMOTE_ASK_NOT_FOUND', 'The remote ask was not found.', { askId: id });
      return this._finishRemoteAsk(db, row, 'unavailable', this._now(), errorCode);
    });
  }

  markRemoteAskDisarmed(input) {
    const source = assertPlainObject(input, 'remote ask disarm');
    const id = assertString(source.id, 'id', { min: 16, max: 60, pattern: /^[A-Za-z0-9_-]+$/ });
    return this.transaction(db => {
      const row = db.prepare('SELECT * FROM remote_asks WHERE id = ?').get(id);
      if (!row) throw stateError('REMOTE_ASK_NOT_FOUND', 'The remote ask was not found.', { askId: id });
      if (row.status === 'pending') throw stateError('REMOTE_ASK_PENDING', 'The remote ask cannot be disarmed before it is resolved.', { askId: id });
      if (row.disarmed_at_ms === null) db.prepare('UPDATE remote_asks SET disarmed_at_ms = ? WHERE id = ?').run(this._now(), id);
      return this._remoteAskRow(db.prepare('SELECT * FROM remote_asks WHERE id = ?').get(id));
    });
  }

  _remoteAskCallback(update) {
    const query = update && update.callback_query;
    const chat = query && query.message && query.message.chat;
    const rawChatId = chat && chat.id;
    const chatId = typeof rawChatId === 'number' && Number.isSafeInteger(rawChatId)
      ? String(rawChatId) : (typeof rawChatId === 'string' ? rawChatId : null);
    if (!query || typeof query !== 'object' || typeof query.data !== 'string' || query.data.length < 1 || query.data.length > 64
      || chatId === null || chatId.length < 1 || chatId.length > 100 || !Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      return null;
    }
    return { callbackHash: hashText(query.data), chatId, updateId: update.update_id };
  }

  _resolveRemoteAskCallback(db, update, now) {
    const callback = this._remoteAskCallback(update);
    if (!callback) return null;
    const row = db.prepare(`SELECT * FROM remote_asks
      WHERE yes_callback_hash = ? OR no_callback_hash = ?`).get(callback.callbackHash, callback.callbackHash);
    if (!row || row.chat_id !== callback.chatId) return null;
    if (row.status !== 'pending') return { matched: true, accepted: false, ask: this._remoteAskRow(row) };
    if (row.expires_at_ms <= now) {
      const ask = this._finishRemoteAsk(db, row, 'timeout', now);
      return { matched: true, accepted: false, ask };
    }
    const status = row.yes_callback_hash === callback.callbackHash ? 'yes' : 'no';
    const changed = db.prepare(`UPDATE remote_asks SET status = ?, resolved_at_ms = ?, resolution_update_id = ?, error_code = NULL
      WHERE id = ? AND status = 'pending' AND expires_at_ms > ?`).run(status, now, callback.updateId, row.id, now);
    const ask = this._remoteAskRow(db.prepare('SELECT * FROM remote_asks WHERE id = ?').get(row.id));
    return { matched: true, accepted: changed.changes === 1, ask };
  }

  // _leaseMs IS NOT A TELEGRAM METHOD. It sat between getTelegramCursor() and
  // acquireTelegramPollLease() purely by placement, and it is the shared lease
  // bound used by reserveOperation() and every task-lease path in this file. It
  // stays exactly where it was.
  _leaseMs(value, label = 'leaseMs') {
    return assertInteger(value, label, { min: 1000, max: 24 * 60 * 60 * 1000 });
  }

  // THE TELEGRAM STORE METHODS WERE REMOVED 2026-08-23, WITH THE TABLES THEY READ.
  //
  // Fifteen methods lived here: getTelegramCursor, acquireTelegramPollLease,
  // releaseTelegramPollLease, commitTelegramUpdates, listTelegramUpdates,
  // getTelegramCommand, pruneTelegramUpdates and their eight private helpers
  // (_validateTelegramHandle, _requireTelegramLease, _prepareTelegramUpdates,
  // _telegramCommandMetadata, _telegramCommandMessage, _prepareTelegramCommandTasks,
  // _pruneTelegram). Every one of them read or wrote telegram_cursor,
  // telegram_poll_lease or telegram_updates, which MIGRATION_V23 above drops.
  // Leaving them would leave methods that can only ever raise "no such table".
  //
  // Their only caller was src/lib/providers/messaging.js, which was Telegram-only
  // once Discord left and is deleted too. Telegram left the product on the owner's
  // ruling ("you can rip out telegram"); the product now ships its own mobile app.

  _validateOperationIdentity({ type, key, inputHash: digest }) {
    return {
      type: assertString(type, 'type', { max: 200 }),
      key: assertString(key, 'key', { max: 500 }),
      inputHash: assertString(digest, 'inputHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ })
    };
  }

  _operationRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      type: row.operation_type,
      key: row.idempotency_key,
      inputHash: row.input_hash,
      inputVerified: Boolean(row.input_verified),
      status: row.status,
      fence: row.fence,
      attempt: row.attempt,
      leaseOwner: row.lease_owner,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      result: row.result_json === null ? null : parseJson(row.result_json, 'operation result'),
      error: row.error_code === null ? null : { code: row.error_code, message: row.error_message || '' },
      retryAtMs: row.retry_at_ms,
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms,
      updatedAt: iso(row.updated_at_ms),
      updatedAtMs: row.updated_at_ms,
      completedAt: row.completed_at_ms === null ? null : iso(row.completed_at_ms),
      completedAtMs: row.completed_at_ms
    };
  }

  _operationHandle(row) {
    return { operationId: row.id, ownerId: row.lease_owner, token: row.lease_token, fence: row.fence, expiresAtMs: row.lease_expires_at_ms };
  }

  reserveOperation(input) {
    const source = assertPlainObject(input, 'operation');
    const identity = this._validateOperationIdentity(source);
    const ownerId = source.ownerId === undefined ? this.ownerId : assertString(source.ownerId, 'ownerId', { max: 200 });
    const leaseMs = this._leaseMs(source.leaseMs, 'leaseMs');
    const outcome = this.transaction(db => {
      const now = this._now();
      let row = db.prepare('SELECT * FROM operations WHERE operation_type = ? AND idempotency_key = ?').get(identity.type, identity.key);
      if (!row) {
        const id = this._newId('operation');
        const token = this._newId('operation-lease');
        db.prepare(`INSERT INTO operations(id, operation_type, idempotency_key, input_hash, input_verified, status, fence, attempt,
          lease_owner, lease_token, lease_expires_at_ms, created_at_ms, updated_at_ms)
          VALUES(?, ?, ?, ?, 1, 'reserved', 1, 1, ?, ?, ?, ?, ?)`).run(
          id, identity.type, identity.key, identity.inputHash, ownerId, token, now + leaseMs, now, now
        );
        row = db.prepare('SELECT * FROM operations WHERE id = ?').get(id);
        return { disposition: 'reserved', handle: this._operationHandle(row), operation: this._operationRow(row) };
      }

      if (!row.input_verified && row.status === 'succeeded') {
        db.prepare('UPDATE operations SET input_hash = ?, input_verified = 1, updated_at_ms = ? WHERE id = ?').run(identity.inputHash, now, row.id);
        row = db.prepare('SELECT * FROM operations WHERE id = ?').get(row.id);
      } else if (row.input_hash !== identity.inputHash) {
        throw stateError('OPERATION_INPUT_CONFLICT', 'The idempotency key was already used with a different input hash.', { type: identity.type, key: identity.key });
      }

      if (row.status === 'succeeded') {
        const operation = this._operationRow(row);
        return { disposition: 'replay', operation, result: operation.result };
      }
      if (row.status === 'uncertain') {
        throw stateError('OPERATION_UNCERTAIN', 'The prior external outcome is uncertain and must be reconciled before retry.', { operationId: row.id });
      }
      if (row.status === 'executing' && row.lease_expires_at_ms <= now) {
        // Keep the original capability token and fence. Nobody may retry an
        // uncertain operation, but the original worker may still report a
        // definitive late success from an already-issued provider request.
        db.prepare(`UPDATE operations SET status = 'uncertain',
          error_code = 'LEASE_EXPIRED_DURING_EXECUTION', error_message = 'Execution lease expired before a terminal outcome was recorded.',
          completed_at_ms = ?, updated_at_ms = ? WHERE id = ?`).run(now, now, row.id);
        return { error: stateError('OPERATION_UNCERTAIN', 'An executing lease expired; automatic replay is unsafe until reconciliation.', { operationId: row.id }) };
      }
      if ((row.status === 'reserved' || row.status === 'executing') && row.lease_expires_at_ms > now) {
        throw stateError('OPERATION_LEASE_HELD', 'The operation already has an active lease.', { operationId: row.id, status: row.status, expiresAtMs: row.lease_expires_at_ms });
      }
      if (row.status === 'retryable_failed' && row.retry_at_ms !== null && row.retry_at_ms > now) {
        throw stateError('OPERATION_RETRY_NOT_READY', 'The operation is not eligible for retry yet.', { operationId: row.id, retryAtMs: row.retry_at_ms });
      }
      if (row.status !== 'reserved' && row.status !== 'retryable_failed') {
        throw stateError('OPERATION_INVALID_TRANSITION', `Operation state '${row.status}' cannot be reserved.`, { operationId: row.id, status: row.status });
      }
      const token = this._newId('operation-lease');
      db.prepare(`UPDATE operations SET status = 'reserved', fence = fence + 1, attempt = attempt + 1, lease_owner = ?, lease_token = ?,
        lease_expires_at_ms = ?, error_code = NULL, error_message = NULL, retry_at_ms = NULL, completed_at_ms = NULL, updated_at_ms = ? WHERE id = ?`).run(
        ownerId, token, now + leaseMs, now, row.id
      );
      row = db.prepare('SELECT * FROM operations WHERE id = ?').get(row.id);
      return { disposition: 'reserved', handle: this._operationHandle(row), operation: this._operationRow(row) };
    });
    if (outcome.error) throw outcome.error;
    return outcome;
  }

  _validateOperationHandle(handle) {
    assertPlainObject(handle, 'handle');
    return {
      operationId: assertString(handle.operationId, 'handle.operationId', { max: 500 }),
      ownerId: assertString(handle.ownerId, 'handle.ownerId', { max: 200 }),
      token: assertString(handle.token, 'handle.token', { max: 500 }),
      fence: assertInteger(handle.fence, 'handle.fence', { min: 1 })
    };
  }

  _requireOperationLease(db, handle, now, allowedStates) {
    const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(handle.operationId);
    if (!row || row.fence !== handle.fence || row.lease_owner !== handle.ownerId || row.lease_token !== handle.token) {
      throw stateError('OPERATION_FENCE_LOST', 'The operation handle is stale or no longer owns the lease fence.', { operationId: handle.operationId, fence: handle.fence });
    }
    if (!allowedStates.includes(row.status)) {
      throw stateError('OPERATION_INVALID_TRANSITION', `Operation state '${row.status}' does not allow this transition.`, { operationId: row.id, status: row.status, allowedStates });
    }
    if (row.lease_expires_at_ms <= now) {
      throw stateError('OPERATION_LEASE_EXPIRED', 'The operation lease expired before the transition.', { operationId: row.id, expiresAtMs: row.lease_expires_at_ms });
    }
    return row;
  }

  _leasedOperationResult(db, operationId) {
    const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId);
    return { handle: this._operationHandle(row), operation: this._operationRow(row) };
  }

  markOperationExecuting(handle, { leaseMs } = {}) {
    const lease = this._validateOperationHandle(handle);
    this._leaseMs(leaseMs);
    return this.transaction(db => {
      const now = this._now();
      this._requireOperationLease(db, lease, now, ['reserved']);
      const result = db.prepare(`UPDATE operations SET status = 'executing', lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND lease_owner = ? AND lease_token = ? AND status = 'reserved' AND lease_expires_at_ms > ?`).run(
        now + leaseMs, now, lease.operationId, lease.fence, lease.ownerId, lease.token, now
      );
      if (result.changes !== 1) throw stateError('OPERATION_FENCE_LOST', 'The operation lease changed before execution began.', { operationId: lease.operationId });
      return this._leasedOperationResult(db, lease.operationId);
    });
  }

  heartbeatOperation(handle, { leaseMs } = {}) {
    const lease = this._validateOperationHandle(handle);
    this._leaseMs(leaseMs);
    return this.transaction(db => {
      const now = this._now();
      this._requireOperationLease(db, lease, now, ['executing']);
      const result = db.prepare(`UPDATE operations SET lease_expires_at_ms = MAX(lease_expires_at_ms, ?), updated_at_ms = ?
        WHERE id = ? AND fence = ? AND lease_owner = ? AND lease_token = ? AND status = 'executing' AND lease_expires_at_ms > ?`).run(
        now + leaseMs, now, lease.operationId, lease.fence, lease.ownerId, lease.token, now
      );
      if (result.changes !== 1) throw stateError('OPERATION_FENCE_LOST', 'The operation lease changed before its heartbeat.', { operationId: lease.operationId });
      return this._leasedOperationResult(db, lease.operationId);
    });
  }

  succeedOperation(handle, { result } = {}) {
    const lease = this._validateOperationHandle(handle);
    assertSafeOperationResult(result);
    const resultJson = boundedJson(result, 'result');
    return this.transaction(db => {
      const now = this._now();
      const prior = db.prepare('SELECT * FROM operations WHERE id = ?').get(lease.operationId);
      if (!prior || prior.fence !== lease.fence || prior.lease_owner !== lease.ownerId || prior.lease_token !== lease.token) {
        throw stateError('OPERATION_FENCE_LOST', 'The operation handle is stale or no longer owns the success fence.', { operationId: lease.operationId, fence: lease.fence });
      }
      if (prior.status !== 'executing' && prior.status !== 'uncertain') {
        throw stateError('OPERATION_INVALID_TRANSITION', `Operation state '${prior.status}' cannot record provider success.`, { operationId: prior.id, status: prior.status });
      }
      const changed = db.prepare(`UPDATE operations SET status = 'succeeded', result_json = ?, error_code = NULL, error_message = NULL,
        retry_at_ms = NULL, lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL, completed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND lease_owner = ? AND lease_token = ? AND status IN ('executing','uncertain')`).run(
        resultJson, now, now, lease.operationId, lease.fence, lease.ownerId, lease.token
      );
      if (changed.changes !== 1) throw stateError('OPERATION_FENCE_LOST', 'The operation lease changed before success could be recorded.', { operationId: lease.operationId });
      const operation = this._operationRow(db.prepare('SELECT * FROM operations WHERE id = ?').get(lease.operationId));
      return { operation, result: operation.result };
    });
  }

  // Resolve an uncertain operation only when a separate, durable observation
  // has proved success after the original lease handle was lost. Callers must
  // bind the exact original identity and provide a non-sensitive result; this
  // method deliberately has no retry or provider-side behavior of its own.
  reconcileOperationSuccess(input) {
    const source = assertPlainObject(input, 'operation reconciliation');
    const identity = this._validateOperationIdentity(source);
    assertSafeOperationResult(source.result);
    const resultJson = boundedJson(source.result, 'result');
    return this.transaction(db => {
      const now = this._now();
      let row = db.prepare('SELECT * FROM operations WHERE operation_type = ? AND idempotency_key = ?').get(identity.type, identity.key);
      if (!row) throw stateError('OPERATION_NOT_FOUND', 'The operation to reconcile was not found.', { type: identity.type, key: identity.key });
      if (!row.input_verified && row.status === 'succeeded') {
        db.prepare('UPDATE operations SET input_hash = ?, input_verified = 1, updated_at_ms = ? WHERE id = ?').run(identity.inputHash, now, row.id);
        row = db.prepare('SELECT * FROM operations WHERE id = ?').get(row.id);
      } else if (row.input_hash !== identity.inputHash) {
        throw stateError('OPERATION_INPUT_CONFLICT', 'The idempotency key was already used with a different input hash.', { type: identity.type, key: identity.key });
      }
      if (row.status === 'succeeded') {
        const operation = this._operationRow(row);
        return { disposition: 'replay', operation, result: operation.result };
      }
      if (row.status !== 'uncertain') {
        throw stateError('OPERATION_INVALID_TRANSITION', `Operation state '${row.status}' cannot be reconciled as success.`, { operationId: row.id, status: row.status });
      }
      const changed = db.prepare(`UPDATE operations SET status = 'succeeded', result_json = ?, error_code = NULL, error_message = NULL,
        retry_at_ms = NULL, lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL, completed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'uncertain'`).run(resultJson, now, now, row.id);
      if (changed.changes !== 1) throw stateError('OPERATION_FENCE_LOST', 'The operation changed before reconciliation could record success.', { operationId: row.id });
      const operation = this._operationRow(db.prepare('SELECT * FROM operations WHERE id = ?').get(row.id));
      return { disposition: 'reconciled', operation, result: operation.result };
    });
  }

  // Resolve an uncertain operation as no-effect only when a separate, durable
  // observation proves the expected provider resource is absent. This method
  // performs no retry itself and cannot alter a succeeded operation.
  reconcileOperationFailure(input) {
    const source = assertPlainObject(input, 'operation reconciliation');
    const identity = this._validateOperationIdentity(source);
    const errorCode = assertString(source.errorCode, 'errorCode', { max: 200, pattern: /^[A-Za-z0-9_.:-]+$/ });
    const errorMessage = assertString(source.errorMessage === undefined ? '' : source.errorMessage, 'errorMessage', { min: 0, max: 1000 });
    const retryAtMs = source.retryAtMs === undefined ? this._now() : assertInteger(source.retryAtMs, 'retryAtMs');
    return this.transaction(db => {
      const now = this._now();
      let row = db.prepare('SELECT * FROM operations WHERE operation_type = ? AND idempotency_key = ?').get(identity.type, identity.key);
      if (!row) throw stateError('OPERATION_NOT_FOUND', 'The operation to reconcile was not found.', { type: identity.type, key: identity.key });
      if (!row.input_verified && row.status === 'succeeded') {
        db.prepare('UPDATE operations SET input_hash = ?, input_verified = 1, updated_at_ms = ? WHERE id = ?').run(identity.inputHash, now, row.id);
        row = db.prepare('SELECT * FROM operations WHERE id = ?').get(row.id);
      } else if (row.input_hash !== identity.inputHash) {
        throw stateError('OPERATION_INPUT_CONFLICT', 'The idempotency key was already used with a different input hash.', { type: identity.type, key: identity.key });
      }
      if (row.status === 'retryable_failed') return { disposition: 'replay', operation: this._operationRow(row) };
      if (row.status !== 'uncertain') {
        throw stateError('OPERATION_INVALID_TRANSITION', `Operation state '${row.status}' cannot be reconciled as no-effect.`, { operationId: row.id, status: row.status });
      }
      const changed = db.prepare(`UPDATE operations SET status = 'retryable_failed', result_json = NULL, error_code = ?, error_message = ?,
        retry_at_ms = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL, completed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'uncertain'`).run(errorCode, errorMessage, retryAtMs, now, now, row.id);
      if (changed.changes !== 1) throw stateError('OPERATION_FENCE_LOST', 'The operation changed before reconciliation could record no-effect.', { operationId: row.id });
      return { disposition: 'reconciled', operation: this._operationRow(db.prepare('SELECT * FROM operations WHERE id = ?').get(row.id)) };
    });
  }

  _operationFailure(handle, { errorCode, errorMessage = '', retryAtMs = null }, uncertain) {
    const lease = this._validateOperationHandle(handle);
    assertString(errorCode, 'errorCode', { max: 200, pattern: /^[A-Za-z0-9_.:-]+$/ });
    assertString(errorMessage, 'errorMessage', { min: 0, max: 1000 });
    if (retryAtMs !== null) assertInteger(retryAtMs, 'retryAtMs');
    return this.transaction(db => {
      const now = this._now();
      if (uncertain) {
        const prior = db.prepare('SELECT * FROM operations WHERE id = ?').get(lease.operationId);
        if (!prior || prior.fence !== lease.fence || prior.lease_owner !== lease.ownerId || prior.lease_token !== lease.token) {
          throw stateError('OPERATION_FENCE_LOST', 'The operation handle is stale or no longer owns the uncertainty fence.', { operationId: lease.operationId, fence: lease.fence });
        }
        if (prior.status !== 'executing' && prior.status !== 'uncertain') {
          throw stateError('OPERATION_INVALID_TRANSITION', `Operation state '${prior.status}' cannot be marked uncertain.`, { operationId: prior.id, status: prior.status });
        }
        const changed = db.prepare(`UPDATE operations SET status = 'uncertain', error_code = ?, error_message = ?, retry_at_ms = NULL,
          result_json = NULL, completed_at_ms = COALESCE(completed_at_ms, ?), updated_at_ms = ?
          WHERE id = ? AND fence = ? AND lease_owner = ? AND lease_token = ? AND status IN ('executing','uncertain')`).run(
          errorCode, errorMessage, now, now, lease.operationId, lease.fence, lease.ownerId, lease.token
        );
        if (changed.changes !== 1) throw stateError('OPERATION_FENCE_LOST', 'The operation lease changed before uncertainty could be recorded.', { operationId: lease.operationId });
        return { operation: this._operationRow(db.prepare('SELECT * FROM operations WHERE id = ?').get(lease.operationId)) };
      }
      this._requireOperationLease(db, lease, now, ['reserved', 'executing']);
      const changed = db.prepare(`UPDATE operations SET status = 'retryable_failed', error_code = ?, error_message = ?, retry_at_ms = ?, result_json = NULL,
        lease_owner = NULL, lease_token = NULL, lease_expires_at_ms = NULL, completed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND lease_owner = ? AND lease_token = ? AND status IN ('reserved','executing') AND lease_expires_at_ms > ?`).run(
        errorCode, errorMessage, retryAtMs, now, now,
        lease.operationId, lease.fence, lease.ownerId, lease.token, now
      );
      if (changed.changes !== 1) throw stateError('OPERATION_FENCE_LOST', 'The operation lease changed before failure could be recorded.', { operationId: lease.operationId });
      return { operation: this._operationRow(db.prepare('SELECT * FROM operations WHERE id = ?').get(lease.operationId)) };
    });
  }

  failOperation(handle, options = {}) {
    return this._operationFailure(handle, assertPlainObject(options, 'failure'), false);
  }

  markOperationUncertain(handle, options = {}) {
    return this._operationFailure(handle, assertPlainObject(options, 'failure'), true);
  }

  getOperation(selector) {
    const value = assertPlainObject(selector, 'selector');
    let row;
    if (value.id !== undefined) {
      if (value.type !== undefined || value.key !== undefined) throw stateError('STATE_INVALID_ARGUMENT', 'Select an operation by id or by type and key, not both.', { field: 'selector' });
      const id = assertString(value.id, 'id', { max: 500 });
      row = this._read(db => db.prepare('SELECT * FROM operations WHERE id = ?').get(id));
    } else {
      const type = assertString(value.type, 'type', { max: 200 });
      const key = assertString(value.key, 'key', { max: 500 });
      row = this._read(db => db.prepare('SELECT * FROM operations WHERE operation_type = ? AND idempotency_key = ?').get(type, key));
    }
    return this._operationRow(row);
  }

  listOperations(options = {}) {
    assertPlainObject(options, 'options');
    const limit = assertInteger(options.limit === undefined ? 100 : options.limit, 'limit', { min: 1, max: 1000 });
    if (options.status !== undefined && !OPERATION_STATES.has(options.status)) throw stateError('STATE_INVALID_ARGUMENT', 'status is invalid.', { field: 'status' });
    if (options.type !== undefined) assertString(options.type, 'type', { max: 200 });
    const clauses = [];
    const values = [];
    if (options.status !== undefined) { clauses.push('status = ?'); values.push(options.status); }
    if (options.type !== undefined) { clauses.push('operation_type = ?'); values.push(options.type); }
    values.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this._read(db => db.prepare(`SELECT * FROM operations ${where} ORDER BY updated_at_ms DESC, id DESC LIMIT ?`).all(...values).map(row => this._operationRow(row)));
  }

  _capabilityManifest(value) {
    try { return capabilityManifests.validateManifest(value); }
    catch (error) {
      if (error instanceof capabilityManifests.CapabilityManifestError) {
        throw stateError(error.code, error.message, error.details);
      }
      throw error;
    }
  }

  _capabilityProfileRow(db, row) {
    if (!row) return null;
    const manifest = this._capabilityManifest(parseJson(row.manifest_json, 'capability manifest'));
    const manifestHash = capabilityManifests.manifestHash(manifest);
    if (!equalHash(manifestHash, row.manifest_hash)) {
      throw stateError('CAPABILITY_MANIFEST_CORRUPT', 'The stored capability manifest hash does not match its immutable body.', { profileId: row.profile_id, version: row.version });
    }
    const revocation = db.prepare(`SELECT profile_hash, reason_code, revoked_at_ms FROM capability_profile_revocations
      WHERE profile_id = ? AND profile_version = ?`).get(row.profile_id, row.version);
    if (revocation && !equalHash(revocation.profile_hash, row.manifest_hash)) {
      throw stateError('CAPABILITY_MANIFEST_CORRUPT', 'The capability manifest revocation hash does not match its profile version.', { profileId: row.profile_id, version: row.version });
    }
    return {
      manifest,
      manifestHash: row.manifest_hash,
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
      status: revocation ? {
        revoked: true,
        reasonCode: revocation.reason_code,
        revokedAtMs: revocation.revoked_at_ms
      } : { revoked: false }
    };
  }

  createCapabilityProfile(input) {
    const source = assertPlainObject(input, 'capability profile');
    if (Object.keys(source).some(key => key !== 'manifest')) throw stateError('STATE_INVALID_ARGUMENT', 'capability profile contains unsupported fields.', { field: 'capability profile' });
    const manifest = this._capabilityManifest(source.manifest);
    const manifestHash = capabilityManifests.manifestHash(manifest);
    const manifestJson = canonicalJson(manifest);
    const now = this._now();
    return this.transaction(db => {
      const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(manifest.taskId);
      if (!task) throw stateError('CAPABILITY_MANIFEST_TASK_MISSING', 'A capability profile must bind to an existing durable task.', { taskId: manifest.taskId });
      const existing = db.prepare(`SELECT * FROM capability_profile_versions WHERE profile_id = ? AND version = ?`).get(manifest.profileId, manifest.version);
      if (existing) {
        if (equalHash(existing.manifest_hash, manifestHash) && existing.manifest_json === manifestJson) {
          return { replayed: true, profile: this._capabilityProfileRow(db, existing) };
        }
        throw stateError('CAPABILITY_MANIFEST_VERSION_CONFLICT', 'A capability profile version already exists with different immutable content.', { profileId: manifest.profileId, version: manifest.version });
      }
      if (manifest.version > 1) {
        const parent = db.prepare(`SELECT manifest_hash, task_id FROM capability_profile_versions WHERE profile_id = ? AND version = ?`).get(manifest.profileId, manifest.version - 1);
        if (!parent || parent.task_id !== manifest.taskId || !equalHash(parent.manifest_hash, manifest.parentHash)) {
          throw stateError('CAPABILITY_MANIFEST_PARENT_MISMATCH', 'A new capability profile version must name its exact prior immutable version.', { profileId: manifest.profileId, version: manifest.version });
        }
      }
      db.prepare(`INSERT INTO capability_profile_versions(profile_id, version, task_id, manifest_json, manifest_hash, parent_hash, expires_at_ms, created_at_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
        manifest.profileId, manifest.version, manifest.taskId, manifestJson, manifestHash, manifest.parentHash,
        manifest.expiresAtMs, now
      );
      const stored = db.prepare(`SELECT * FROM capability_profile_versions WHERE profile_id = ? AND version = ?`).get(manifest.profileId, manifest.version);
      return { replayed: false, profile: this._capabilityProfileRow(db, stored) };
    });
  }

  getCapabilityProfile(input) {
    const source = assertPlainObject(input, 'capability profile selector');
    if (Object.keys(source).some(key => !['profileId', 'version'].includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'capability profile selector contains unsupported fields.', { field: 'capability profile selector' });
    const profileId = assertString(source.profileId, 'profileId', { min: 3, max: 120, pattern: /^[a-z][a-z0-9._-]{2,119}$/ });
    const version = assertInteger(source.version, 'version', { min: 1 });
    return this._read(db => this._capabilityProfileRow(db, db.prepare(`SELECT * FROM capability_profile_versions WHERE profile_id = ? AND version = ?`).get(profileId, version)));
  }

  listCapabilityProfiles(input) {
    const source = assertPlainObject(input, 'capability profile list selector');
    if (Object.keys(source).some(key => !['taskId', 'limit'].includes(key))) {
      throw stateError('STATE_INVALID_ARGUMENT', 'capability profile list selector contains unsupported fields.', { field: 'capability profile list selector' });
    }
    const taskId = assertString(source.taskId, 'taskId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    const limit = assertInteger(source.limit === undefined ? 100 : source.limit, 'limit', { min: 1, max: 500 });
    return this._read(db => db.prepare(`SELECT * FROM capability_profile_versions WHERE task_id = ? ORDER BY profile_id ASC, version ASC LIMIT ?`)
      .all(taskId, limit).map(row => this._capabilityProfileRow(db, row)));
  }

  bindCapabilityProfile(input) {
    const source = assertPlainObject(input, 'capability profile binding');
    if (Object.keys(source).some(key => !['taskId', 'bindingKind', 'bindingId', 'profileId', 'profileVersion', 'profileHash'].includes(key))) {
      throw stateError('STATE_INVALID_ARGUMENT', 'capability profile binding contains unsupported fields.', { field: 'capability profile binding' });
    }
    const taskId = assertString(source.taskId, 'taskId', { min: 8, max: 200 });
    const bindingKind = assertString(source.bindingKind, 'bindingKind', { min: 4, max: 10, pattern: /^(delegation|tool)$/ });
    const bindingId = assertString(source.bindingId, 'bindingId', { min: 3, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/ });
    const profileId = assertString(source.profileId, 'profileId', { min: 3, max: 120, pattern: /^[a-z][a-z0-9._-]{2,119}$/ });
    const profileVersion = assertInteger(source.profileVersion, 'profileVersion', { min: 1 });
    const profileHash = assertString(source.profileHash, 'profileHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    return this.transaction(db => {
      const now = this._now();
      const profile = db.prepare(`SELECT * FROM capability_profile_versions WHERE profile_id = ? AND version = ?`).get(profileId, profileVersion);
      if (!profile || profile.task_id !== taskId || !equalHash(profile.manifest_hash, profileHash)) {
        throw stateError('CAPABILITY_MANIFEST_BINDING_MISMATCH', 'The capability profile binding does not match an immutable task profile.', { taskId, profileId, profileVersion });
      }
      if (now >= profile.expires_at_ms) {
        throw stateError('CAPABILITY_MANIFEST_EXPIRED', 'The capability profile has expired.', { profileId, profileVersion });
      }
      const revocation = db.prepare(`SELECT profile_hash FROM capability_profile_revocations WHERE profile_id = ? AND profile_version = ?`).get(profileId, profileVersion);
      if (revocation) {
        if (!equalHash(revocation.profile_hash, profileHash)) throw stateError('CAPABILITY_MANIFEST_CORRUPT', 'The capability profile revocation does not match its profile hash.', { profileId, profileVersion });
        throw stateError('CAPABILITY_MANIFEST_REVOKED', 'The capability profile has been revoked.', { profileId, profileVersion });
      }
      const existing = db.prepare(`SELECT * FROM capability_profile_bindings WHERE task_id = ? AND binding_kind = ? AND binding_id = ?`).get(taskId, bindingKind, bindingId);
      if (existing) {
        if (existing.profile_id === profileId && existing.profile_version === profileVersion && equalHash(existing.profile_hash, profileHash)) return { replayed: true };
        throw stateError('CAPABILITY_MANIFEST_BINDING_CONFLICT', 'A task binding already names a different immutable capability profile.', { taskId, bindingKind, bindingId });
      }
      db.prepare(`INSERT INTO capability_profile_bindings(task_id, binding_kind, binding_id, profile_id, profile_version, profile_hash, created_at_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?)`).run(taskId, bindingKind, bindingId, profileId, profileVersion, profileHash, now);
      return { replayed: false };
    });
  }

  authorizeCapabilityProfileRequest(input) {
    const source = assertPlainObject(input, 'authorized capability profile request');
    if (Object.keys(source).some(key => !['requestId', 'taskId', 'bindingKind', 'profileId', 'profileVersion', 'profileHash', 'requestHash', 'request'].includes(key))) {
      throw stateError('STATE_INVALID_ARGUMENT', 'authorized capability profile request contains unsupported fields.', { field: 'authorized capability profile request' });
    }
    const requestId = assertString(source.requestId, 'requestId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    const taskId = assertString(source.taskId, 'taskId', { min: 8, max: 200 });
    const bindingKind = assertString(source.bindingKind, 'bindingKind', { min: 4, max: 10, pattern: /^(delegation|tool)$/ });
    const profileId = assertString(source.profileId, 'profileId', { min: 3, max: 120, pattern: /^[a-z][a-z0-9._-]{2,119}$/ });
    const profileVersion = assertInteger(source.profileVersion, 'profileVersion', { min: 1 });
    const profileHash = assertString(source.profileHash, 'profileHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const requestHash = assertString(source.requestHash, 'requestHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const requestJson = boundedTaskJson(source.request, 'authorized capability profile request', 32 * 1024, 'CAPABILITY_MANIFEST_REQUEST_TOO_LARGE');
    return this.transaction(db => {
      const now = this._now();
      const profile = db.prepare(`SELECT * FROM capability_profile_versions WHERE profile_id = ? AND version = ?`).get(profileId, profileVersion);
      if (!profile || profile.task_id !== taskId || !equalHash(profile.manifest_hash, profileHash)) {
        throw stateError('CAPABILITY_MANIFEST_BINDING_MISMATCH', 'The capability request does not match an immutable task profile.', { taskId, profileId, profileVersion });
      }
      if (now >= profile.expires_at_ms) {
        throw stateError('CAPABILITY_MANIFEST_EXPIRED', 'The capability profile has expired.', { profileId, profileVersion });
      }
      const revocation = db.prepare(`SELECT profile_hash FROM capability_profile_revocations WHERE profile_id = ? AND profile_version = ?`).get(profileId, profileVersion);
      if (revocation) {
        if (!equalHash(revocation.profile_hash, profileHash)) throw stateError('CAPABILITY_MANIFEST_CORRUPT', 'The capability profile revocation does not match its profile hash.', { profileId, profileVersion });
        throw stateError('CAPABILITY_MANIFEST_REVOKED', 'The capability profile has been revoked.', { profileId, profileVersion });
      }
      const binding = db.prepare(`SELECT * FROM capability_profile_bindings WHERE task_id = ? AND binding_kind = ? AND binding_id = ?`).get(taskId, bindingKind, requestId);
      if (binding) {
        if (!(binding.profile_id === profileId && binding.profile_version === profileVersion && equalHash(binding.profile_hash, profileHash))) {
          throw stateError('CAPABILITY_MANIFEST_BINDING_CONFLICT', 'A task binding already names a different immutable capability profile.', { taskId, bindingKind, bindingId: requestId });
        }
      } else {
        db.prepare(`INSERT INTO capability_profile_bindings(task_id, binding_kind, binding_id, profile_id, profile_version, profile_hash, created_at_ms)
          VALUES(?, ?, ?, ?, ?, ?, ?)`).run(taskId, bindingKind, requestId, profileId, profileVersion, profileHash, now);
      }
      const existing = db.prepare(`SELECT * FROM capability_profile_requests WHERE request_id = ?`).get(requestId);
      if (existing) {
        if (existing.request_kind === bindingKind && existing.profile_id === profileId && existing.profile_version === profileVersion
          && equalHash(existing.profile_hash, profileHash) && equalHash(existing.request_hash, requestHash) && existing.request_json === requestJson && existing.status === 'authorized') {
          return { replayed: true };
        }
        throw stateError('CAPABILITY_MANIFEST_REQUEST_CONFLICT', 'A capability request ID already has different immutable content.', { requestId });
      }
      const existingHash = db.prepare(`SELECT request_id FROM capability_profile_requests WHERE request_hash = ?`).get(requestHash);
      if (existingHash) {
        throw stateError('CAPABILITY_MANIFEST_REQUEST_HASH_CONFLICT', 'This exact immutable capability request is already bound to another request ID.', {
          requestId, existingRequestId: existingHash.request_id
        });
      }
      db.prepare(`INSERT INTO capability_profile_requests(request_id, task_id, request_kind, profile_id, profile_version, profile_hash, request_hash, request_json, status, created_at_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?)`).run(requestId, taskId, bindingKind, profileId, profileVersion, profileHash, requestHash, requestJson, now);
      return { replayed: false };
    });
  }

  recordCapabilityProfileRequest(input) {
    const source = assertPlainObject(input, 'capability profile request');
    if (Object.keys(source).some(key => !['requestId', 'taskId', 'requestKind', 'profileId', 'profileVersion', 'profileHash', 'requestHash', 'request', 'status'].includes(key))) {
      throw stateError('STATE_INVALID_ARGUMENT', 'capability profile request contains unsupported fields.', { field: 'capability profile request' });
    }
    const requestId = assertString(source.requestId, 'requestId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    const taskId = assertString(source.taskId, 'taskId', { min: 8, max: 200 });
    const requestKind = assertString(source.requestKind, 'requestKind', { min: 4, max: 10, pattern: /^(tool|delegation|expansion)$/ });
    const profileId = assertString(source.profileId, 'profileId', { min: 3, max: 120, pattern: /^[a-z][a-z0-9._-]{2,119}$/ });
    const profileVersion = assertInteger(source.profileVersion, 'profileVersion', { min: 1 });
    const profileHash = assertString(source.profileHash, 'profileHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const requestHash = assertString(source.requestHash, 'requestHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const status = assertString(source.status, 'status', { min: 9, max: 10, pattern: /^(authorized|requested)$/ });
    if ((requestKind === 'expansion') !== (status === 'requested')) throw stateError('CAPABILITY_MANIFEST_REQUEST_INVALID', 'Capability expansion requests are non-granting and remain requested.', { requestKind, status });
    const requestJson = boundedTaskJson(source.request, 'capability profile request', 32 * 1024, 'CAPABILITY_MANIFEST_REQUEST_TOO_LARGE');
    return this.transaction(db => {
      const now = this._now();
      const profile = db.prepare(`SELECT * FROM capability_profile_versions WHERE profile_id = ? AND version = ?`).get(profileId, profileVersion);
      if (!profile || profile.task_id !== taskId || !equalHash(profile.manifest_hash, profileHash)) {
        throw stateError('CAPABILITY_MANIFEST_BINDING_MISMATCH', 'The capability request does not match an immutable task profile.', { taskId, profileId, profileVersion });
      }
      if (now >= profile.expires_at_ms) {
        throw stateError('CAPABILITY_MANIFEST_EXPIRED', 'The capability profile has expired.', { profileId, profileVersion });
      }
      const revocation = db.prepare(`SELECT profile_hash FROM capability_profile_revocations WHERE profile_id = ? AND profile_version = ?`).get(profileId, profileVersion);
      if (revocation) {
        if (!equalHash(revocation.profile_hash, profileHash)) throw stateError('CAPABILITY_MANIFEST_CORRUPT', 'The capability profile revocation does not match its profile hash.', { profileId, profileVersion });
        throw stateError('CAPABILITY_MANIFEST_REVOKED', 'The capability profile has been revoked.', { profileId, profileVersion });
      }
      const existing = db.prepare(`SELECT * FROM capability_profile_requests WHERE request_id = ?`).get(requestId);
      if (existing) {
        if (existing.request_kind === requestKind && existing.profile_id === profileId && existing.profile_version === profileVersion
          && equalHash(existing.profile_hash, profileHash) && equalHash(existing.request_hash, requestHash) && existing.request_json === requestJson && existing.status === status) return { replayed: true };
        throw stateError('CAPABILITY_MANIFEST_REQUEST_CONFLICT', 'A capability request ID already has different immutable content.', { requestId });
      }
      db.prepare(`INSERT INTO capability_profile_requests(request_id, task_id, request_kind, profile_id, profile_version, profile_hash, request_hash, request_json, status, created_at_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(requestId, taskId, requestKind, profileId, profileVersion, profileHash, requestHash, requestJson, status, now);
      return { replayed: false };
    });
  }

  createPolicyDispatchAuthorization(input) {
    const source = assertPlainObject(input, 'policy dispatch authorization');
    const allowed = ['authorizationId', 'taskId', 'toolName', 'argsHash', 'targetKind', 'targetHash', 'provenance', 'risk', 'delegationDepth', 'userKind', 'requestHash'];
    if (Object.keys(source).some(key => !allowed.includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'policy dispatch authorization contains unsupported fields.', { field: 'policy dispatch authorization' });
    const authorizationId = assertString(source.authorizationId, 'authorizationId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    const taskId = assertString(source.taskId, 'taskId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    const toolName = assertString(source.toolName, 'toolName', { min: 3, max: 200, pattern: /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/ });
    const argsHash = assertString(source.argsHash, 'argsHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const targetKind = assertString(source.targetKind, 'targetKind', { min: 3, max: 64, pattern: /^(local|external|account|secret|browser-session|finance|agent)$/ });
    const targetHash = assertString(source.targetHash, 'targetHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const risk = assertString(source.risk, 'risk', { min: 3, max: 16, pattern: /^(low|medium|high|critical)$/ });
    const delegationDepth = assertInteger(source.delegationDepth, 'delegationDepth', { min: 0, max: 16 });
    const userKind = assertString(source.userKind, 'userKind', { min: 5, max: 64, pattern: /^(owner-authenticated|agent|unknown)$/ });
    const requestHash = assertString(source.requestHash, 'requestHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    if (source.provenance !== null) {
      throw stateError('POLICY_PROVENANCE_AUTHORITY_UNAVAILABLE', 'Raw P08 provenance cannot grant P13 dispatch authority; a future broker-owned reference is required.', {});
    }
    const provenanceJson = 'null';
    return this.transaction(db => {
      const now = this._now();
      const request = db.prepare(`SELECT * FROM capability_profile_requests WHERE request_hash = ?`).get(requestHash);
      if (!request || request.status !== 'authorized' || request.request_kind !== 'tool' || request.task_id !== taskId) {
        throw stateError('POLICY_CAPABILITY_REQUEST_MISSING', 'Policy dispatch authorization requires an existing authorized P12 tool request.', { taskId });
      }
      const bound = parseJson(request.request_json, 'authorized capability request');
      if (!bound || !bound.request || bound.request.taskId !== taskId || bound.request.tool !== toolName
        || bound.profileHash !== request.profile_hash || bound.requestHash !== request.request_hash) {
        throw stateError('POLICY_CAPABILITY_REQUEST_MISMATCH', 'The P12 request does not bind this exact policy tool action.', { toolName });
      }
      const profile = db.prepare(`SELECT * FROM capability_profile_versions WHERE profile_id = ? AND version = ?`).get(request.profile_id, request.profile_version);
      if (!profile || !equalHash(profile.manifest_hash, request.profile_hash) || profile.task_id !== taskId) {
        throw stateError('CAPABILITY_MANIFEST_BINDING_MISMATCH', 'The P12 profile no longer matches this policy authorization.', { taskId });
      }
      if (now >= profile.expires_at_ms) throw stateError('CAPABILITY_MANIFEST_EXPIRED', 'The P12 profile expired before policy authorization.', { taskId });
      if (db.prepare(`SELECT 1 FROM capability_profile_revocations WHERE profile_id = ? AND profile_version = ?`).get(request.profile_id, request.profile_version)) {
        throw stateError('CAPABILITY_MANIFEST_REVOKED', 'The P12 profile was revoked before policy authorization.', { taskId });
      }
      const existing = db.prepare(`SELECT * FROM policy_dispatch_authorizations WHERE authorization_id = ?`).get(authorizationId);
      if (existing) {
        if (existing.task_id === taskId && existing.tool_name === toolName && equalHash(existing.args_hash, argsHash)
          && existing.target_kind === targetKind && equalHash(existing.target_hash, targetHash) && existing.provenance_json === provenanceJson
          && existing.risk === risk && existing.delegation_depth === delegationDepth && existing.user_kind === userKind
          && equalHash(existing.request_hash, requestHash)) return { replayed: true };
        throw stateError('POLICY_AUTHORIZATION_CONFLICT', 'A policy authorization ID already has different immutable content.', { authorizationId });
      }
      db.prepare(`INSERT INTO policy_dispatch_authorizations(authorization_id, task_id, tool_name, args_hash, target_kind, target_hash, provenance_json, risk, delegation_depth, user_kind, profile_id, profile_version, profile_hash, request_hash, created_at_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        authorizationId, taskId, toolName, argsHash, targetKind, targetHash, provenanceJson, risk, delegationDepth, userKind,
        request.profile_id, request.profile_version, request.profile_hash, requestHash, now
      );
      return { replayed: false };
    });
  }

  consumePolicyDispatchAuthorization(input) {
    const source = assertPlainObject(input, 'policy dispatch consumption');
    if (Object.keys(source).some(key => !['authorizationId', 'toolName', 'argsHash', 'approvalId', 'approvalInputHash'].includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'policy dispatch consumption contains unsupported fields.', { field: 'policy dispatch consumption' });
    const authorizationId = assertString(source.authorizationId, 'authorizationId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    const toolName = assertString(source.toolName, 'toolName', { min: 3, max: 200, pattern: /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/ });
    const argsHash = assertString(source.argsHash, 'argsHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const approvalId = source.approvalId === undefined || source.approvalId === null ? null : assertString(source.approvalId, 'approvalId', { min: 8, max: 200 });
    const approvalInputHash = source.approvalInputHash === undefined || source.approvalInputHash === null ? null : assertString(source.approvalInputHash, 'approvalInputHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    if ((approvalId === null) !== (approvalInputHash === null)) throw stateError('STATE_INVALID_ARGUMENT', 'P13 approval evidence must include both ID and input hash.', { field: 'approval evidence' });
    return this.transaction(db => {
      const now = this._now();
      const authorization = this._assertP13DispatchBinding(db, authorizationId, toolName, argsHash, now);
      if (db.prepare(`SELECT 1 FROM policy_dispatch_consumptions WHERE authorization_id = ?`).get(authorizationId)) {
        throw stateError('POLICY_AUTHORIZATION_REPLAYED', 'The P13 dispatch authorization was already consumed.', { authorizationId });
      }
      if (approvalId !== null) {
        const approval = db.prepare(`SELECT * FROM approval_grants WHERE id = ?`).get(approvalId);
        if (!approval || approval.status !== 'consumed' || approval.action !== authorization.tool_name || !equalHash(approval.input_hash, approvalInputHash)) {
          throw stateError('POLICY_APPROVAL_EVIDENCE_INVALID', 'The P13 approval evidence is not a consumed grant for these exact tool arguments.', { authorizationId, approvalId });
        }
        const attachment = db.prepare(`SELECT authorization_id FROM policy_dispatch_consumptions WHERE approval_id = ?`).get(approvalId);
        if (attachment) {
          throw stateError('POLICY_APPROVAL_EVIDENCE_REPLAYED', 'The P13 approval evidence is already attached to another dispatch authorization.', {
            authorizationId,
            approvalId,
            attachedAuthorizationId: attachment.authorization_id
          });
        }
      }
      db.prepare(`INSERT INTO policy_dispatch_consumptions(authorization_id, args_hash, consumed_at_ms, approval_id) VALUES(?, ?, ?, ?)`).run(authorizationId, argsHash, now, approvalId);
      let provenance;
      try {
        const storedProvenance = parseJson(authorization.provenance_json, 'policy provenance');
        provenance = storedProvenance === null ? null : provenanceEnvelopes.validateEnvelope(storedProvenance);
      } catch (error) { throw stateError('POLICY_PROVENANCE_CORRUPT', 'Stored P13 provenance is invalid.', { authorizationId }, error); }
      return Object.freeze({
        authorizationId, taskId: authorization.task_id, toolName: authorization.tool_name, argsHash: authorization.args_hash,
        target: Object.freeze({ kind: authorization.target_kind, identifierHash: authorization.target_hash, pinned: true }),
        provenance, risk: authorization.risk, delegationDepth: authorization.delegation_depth, userKind: authorization.user_kind,
        capability: Object.freeze({ status: 'authorized', profileHash: authorization.profile_hash, requestHash: authorization.request_hash, taskId: authorization.task_id, tool: authorization.tool_name }),
        approval: Object.freeze({ status: approvalId === null ? 'not-required' : 'consumed' })
      });
    });
  }

  revokeCapabilityProfile(input) {
    const source = assertPlainObject(input, 'capability profile revocation');
    if (Object.keys(source).some(key => !['profileId', 'version', 'profileHash', 'reasonCode'].includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'capability profile revocation contains unsupported fields.', { field: 'capability profile revocation' });
    const profileId = assertString(source.profileId, 'profileId', { min: 3, max: 120, pattern: /^[a-z][a-z0-9._-]{2,119}$/ });
    const version = assertInteger(source.version, 'version', { min: 1 });
    const profileHash = assertString(source.profileHash, 'profileHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const reasonCode = assertString(source.reasonCode, 'reasonCode', { min: 3, max: 120, pattern: /^[a-z][a-z0-9._-]{2,119}$/ });
    const now = this._now();
    return this.transaction(db => {
      const profile = db.prepare(`SELECT * FROM capability_profile_versions WHERE profile_id = ? AND version = ?`).get(profileId, version);
      if (!profile || !equalHash(profile.manifest_hash, profileHash)) throw stateError('CAPABILITY_MANIFEST_BINDING_MISMATCH', 'The capability profile revocation does not match an immutable profile.', { profileId, version });
      const existing = db.prepare(`SELECT * FROM capability_profile_revocations WHERE profile_id = ? AND profile_version = ?`).get(profileId, version);
      if (existing) {
        if (equalHash(existing.profile_hash, profileHash) && existing.reason_code === reasonCode) return { replayed: true, revokedAtMs: existing.revoked_at_ms };
        throw stateError('CAPABILITY_MANIFEST_REVOCATION_CONFLICT', 'The capability profile was already revoked with different immutable details.', { profileId, version });
      }
      db.prepare(`INSERT INTO capability_profile_revocations(profile_id, profile_version, profile_hash, reason_code, revoked_at_ms)
        VALUES(?, ?, ?, ?, ?)`).run(profileId, version, profileHash, reasonCode, now);
      return { replayed: false, revokedAtMs: now };
    });
  }

  revokeActiveCapabilityProfiles(input) {
    const source = assertPlainObject(input, 'active capability profile revocation');
    if (Object.keys(source).some(key => key !== 'reasonCode')) {
      throw stateError('STATE_INVALID_ARGUMENT', 'Active capability profile revocation contains unsupported fields.', { field: 'active capability profile revocation' });
    }
    const reasonCode = assertString(source.reasonCode, 'reasonCode', { min: 3, max: 120, pattern: /^[a-z][a-z0-9._-]{2,119}$/ });
    return this.transaction(db => {
      const now = this._now();
      const changed = db.prepare(`INSERT INTO capability_profile_revocations(profile_id, profile_version, profile_hash, reason_code, revoked_at_ms)
        SELECT profile_id, version, manifest_hash, ?, ?
        FROM capability_profile_versions AS profile
        WHERE profile.expires_at_ms > ?
          AND NOT EXISTS (
            SELECT 1 FROM capability_profile_revocations AS revocation
            WHERE revocation.profile_id = profile.profile_id AND revocation.profile_version = profile.version
          )`).run(reasonCode, now, now);
      return { revoked: changed.changes, revokedAtMs: now, reasonCode };
    });
  }

  _taskIdentifier(value, label) {
    return assertString(value, label, { max: 64, pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/ });
  }

  _taskKey(value, label) {
    return assertString(value, label, { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
  }

  _taskPayload(value, scope = {}) {
    const body = assertPlainObject(value, 'payload');
    const unknown = Object.keys(body).filter(key => !['title', 'objective', 'context'].includes(key));
    if (unknown.length) throw stateError('STATE_INVALID_ARGUMENT', 'payload contains unsupported fields.', { field: 'payload', fields: unknown });
    const normalized = {
      title: assertString(body.title, 'payload.title', { max: 200 }),
      objective: assertString(body.objective, 'payload.objective', { max: 16000 })
    };
    if (body.context !== undefined) normalized.context = assertString(body.context, 'payload.context', { min: 0, max: 32000 });
    const typedReferences = scope.queue === 'research-runs' && scope.type === 'research-run'
      && RESEARCH_REFERENCE_PAYLOADS.has(body);
    // This immutable objective was constructed from two typed local values,
    // not supplied as free text. A random hex ID/hash can otherwise match EAA
    // credential syntax. All other fields and every unbranded payload retain
    // the ordinary secret check, even on the reserved research queue.
    assertNoPlaintextTaskSecrets(typedReferences ? { ...normalized, objective: '' } : normalized, 'payload');
    if (typedReferences) RESEARCH_REFERENCE_PAYLOADS.delete(body);
    return normalized;
  }

  // `now` is only supplied by read-only entry points (getTask/listTasks). When
  // present, a 'leased'/'running' row whose lease already expired is reported
  // as 'expired'/'uncertain' instead of echoing the stale stored status --
  // reaping is otherwise lazy (only runs opportunistically inside claimTask),
  // so an unclaimed queue can leave a task reported "running" long after its
  // lease lapsed. This is read-time derivation only: it never mutates the row,
  // and internal transition code always reads the raw column directly, so it
  // cannot affect claim/start/heartbeat/checkpoint fencing.
  _taskRow(row, { includePayload = true, includeCheckpoint = true, includeResult = true, includeError = true, now = null } = {}) {
    if (!row) return null;
    const leaseExpired = now !== null && (row.status === 'leased' || row.status === 'running')
      && row.lease_expires_at_ms !== null && row.lease_expires_at_ms <= now;
    const reportedStatus = leaseExpired ? (row.status === 'leased' ? 'expired' : 'uncertain') : row.status;
    const task = {
      id: row.id,
      queue: row.queue_name,
      type: row.task_type,
      status: reportedStatus,
      storedStatus: row.status,
      leaseExpired,
      priority: row.priority,
      availableAt: iso(row.available_at_ms),
      availableAtMs: row.available_at_ms,
      maxAttempts: row.max_attempts,
      attempt: row.attempt,
      retryBackoffMs: row.retry_backoff_ms,
      maxRetryBackoffMs: row.max_retry_backoff_ms,
      expiryPolicy: row.expiry_policy,
      fence: row.fence,
      workerLabel: row.lease_worker_label,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      checkpointRevision: row.checkpoint_revision,
      latestCheckpoint: row.checkpoint_revision === 0 ? null : {
        revision: row.checkpoint_revision,
        checkpointKey: row.checkpoint_key,
        hash: row.checkpoint_hash
      },
      cancellation: row.cancel_requested_at_ms === null ? null : {
        requestedAt: iso(row.cancel_requested_at_ms),
        requestedAtMs: row.cancel_requested_at_ms,
        reason: row.cancel_reason || ''
      },
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms,
      updatedAt: iso(row.updated_at_ms),
      updatedAtMs: row.updated_at_ms,
      completedAt: row.completed_at_ms === null ? null : iso(row.completed_at_ms),
      completedAtMs: row.completed_at_ms
    };
    task.cancelRequested = row.cancel_requested_at_ms !== null;
    task.cancellationRequested = task.cancelRequested;
    if (row.status === 'retry_wait') {
      task.retryAt = iso(row.available_at_ms);
      task.retryAtMs = row.available_at_ms;
    }
    if (includePayload) {
      task.payload = parseJson(row.body_json, 'task payload');
    }
    if (includeCheckpoint && task.latestCheckpoint) task.latestCheckpoint.checkpoint = parseJson(row.checkpoint_json, 'task checkpoint');
    if (includeResult) task.result = row.result_json === null ? null : parseJson(row.result_json, 'task result');
    if (includeError) {
      task.error = row.error_code === null ? null : { code: row.error_code, message: row.error_message || '' };
      task.errorCode = row.error_code;
      task.errorMessage = row.error_message;
    }
    return task;
  }

  _validateTaskHandle(handle) {
    const value = assertPlainObject(handle, 'handle');
    return {
      taskId: assertString(value.taskId, 'handle.taskId', { max: 500 }),
      attempt: assertInteger(value.attempt, 'handle.attempt', { min: 1, max: 10 }),
      workerLabel: assertString(value.workerLabel, 'handle.workerLabel', { max: 100, pattern: /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/ }),
      claimToken: assertString(value.claimToken, 'handle.claimToken', { min: 43, max: 43, pattern: /^[A-Za-z0-9_-]{43}$/ }),
      fence: assertInteger(value.fence, 'handle.fence', { min: 1 })
    };
  }

  _taskAttempt(db, handle) {
    const row = db.prepare('SELECT * FROM task_attempts WHERE task_id = ? AND fence = ?').get(handle.taskId, handle.fence);
    const tokenHash = hashText(handle.claimToken);
    if (!row || row.execution_attempt !== handle.attempt || row.worker_label !== handle.workerLabel || !equalHash(row.token_hash, tokenHash)) {
      throw stateError('TASK_FENCE_LOST', 'The task claim handle is stale or invalid.', { taskId: handle.taskId, fence: handle.fence });
    }
    return row;
  }

  _currentTaskClaim(db, handle, now, allowedStates, { allowExpired = false } = {}) {
    const attempt = this._taskAttempt(db, handle);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(handle.taskId);
    const tokenHash = hashText(handle.claimToken);
    if (!task || task.fence !== handle.fence || task.lease_worker_label !== handle.workerLabel || !equalHash(task.lease_token_hash, tokenHash)) {
      throw stateError('TASK_FENCE_LOST', 'The task claim no longer owns the current fence.', { taskId: handle.taskId, fence: handle.fence });
    }
    if (!allowedStates.includes(task.status) || !allowedStates.includes(attempt.status)) {
      throw stateError('TASK_INVALID_TRANSITION', `Task state '${task.status}' does not allow this transition.`, { taskId: task.id, status: task.status, allowedStates });
    }
    if (!allowExpired && task.lease_expires_at_ms <= now) {
      throw stateError('TASK_LEASE_EXPIRED', 'The task claim lease expired before the transition.', { taskId: task.id, fence: task.fence, expiresAtMs: task.lease_expires_at_ms });
    }
    return { task, attempt };
  }

  _taskBackoff(row, now) {
    const exponent = Math.max(0, Math.min(30, row.attempt - 1));
    const delay = Math.min(row.max_retry_backoff_ms, row.retry_backoff_ms * (2 ** exponent));
    return now + Math.trunc(delay);
  }

  _reapExpiredTasks(db, now, { queue, limit = 1000 } = {}) {
    const rows = queue === undefined
      ? db.prepare("SELECT * FROM tasks WHERE status IN ('leased','running') AND lease_expires_at_ms <= ? ORDER BY lease_expires_at_ms, id LIMIT ?").all(now, limit)
      : db.prepare("SELECT * FROM tasks WHERE queue_name = ? AND status IN ('leased','running') AND lease_expires_at_ms <= ? ORDER BY lease_expires_at_ms, id LIMIT ?").all(queue, now, limit);
    let reclaimed = 0;
    let uncertain = 0;
    let cancelled = 0;
    for (const row of rows) {
      const wasLeased = row.status === 'leased';
      const cancellationRequested = row.cancel_requested_at_ms !== null;
      let status;
      let attemptStatus;
      let errorCode;
      let errorMessage;
      let availableAtMs = row.available_at_ms;
      let completedAtMs = null;
      if (wasLeased && cancellationRequested) {
        status = 'cancelled'; attemptStatus = 'cancelled'; cancelled += 1; completedAtMs = now;
      } else if (wasLeased) {
        status = 'retry_wait'; attemptStatus = 'lease_expired'; reclaimed += 1;
        errorCode = 'TASK_LEASE_EXPIRED'; errorMessage = 'The claim expired before execution started.'; availableAtMs = now;
      } else if (!cancellationRequested && row.expiry_policy === 'retry' && row.attempt < row.max_attempts) {
        status = 'retry_wait'; attemptStatus = 'retryable_failed'; reclaimed += 1;
        errorCode = 'TASK_LEASE_EXPIRED'; errorMessage = 'The running task lease expired and is eligible for safe retry.';
        availableAtMs = this._taskBackoff(row, now);
      } else {
        status = 'uncertain'; attemptStatus = 'uncertain'; uncertain += 1; completedAtMs = now;
        errorCode = 'TASK_LEASE_EXPIRED'; errorMessage = 'The running task outcome is uncertain after its lease expired.';
      }
      const outcomeHash = hashInput({ status: attemptStatus, errorCode: errorCode || null, atMs: now });
      db.prepare(`UPDATE task_attempts SET status = ?, updated_at_ms = ?, ended_at_ms = ?, outcome_hash = ?, error_code = ?, error_message = ?
        WHERE task_id = ? AND fence = ? AND status = ?`).run(
        attemptStatus, now, now, outcomeHash, errorCode || null, errorMessage || null, row.id, row.fence, row.status
      );
      db.prepare(`UPDATE tasks SET status = ?, available_at_ms = ?, lease_worker_label = NULL, lease_token_hash = NULL,
        lease_expires_at_ms = NULL, error_code = ?, error_message = ?, completed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND status = ?`).run(
        status, availableAtMs, errorCode || null, errorMessage || null, completedAtMs, now, row.id, row.fence, row.status
      );
    }
    return { examined: rows.length, reclaimed, uncertain, cancelled };
  }

  _prepareTaskSubmission(input) {
    const source = assertPlainObject(input, 'task');
    const queue = this._taskIdentifier(source.queue, 'queue');
    const type = this._taskIdentifier(source.type, 'type');
    const idempotencyKey = this._taskKey(source.idempotencyKey, 'idempotencyKey');
    const payload = this._taskPayload(source.payload, { queue, type });
    const bodyJson = boundedTaskJson(payload, 'payload', MAX_TASK_PAYLOAD_BYTES, 'TASK_PAYLOAD_TOO_LARGE');
    const priority = assertInteger(source.priority === undefined ? 0 : source.priority, 'priority', { min: -100, max: 100 });
    const maxAttempts = assertInteger(source.maxAttempts === undefined ? 3 : source.maxAttempts, 'maxAttempts', { min: 1, max: 10 });
    const retryBackoffMs = assertInteger(source.retryBackoffMs === undefined ? 1000 : source.retryBackoffMs, 'retryBackoffMs', { min: 0, max: 86400000 });
    const maxRetryBackoffMs = assertInteger(source.maxRetryBackoffMs === undefined ? 3600000 : source.maxRetryBackoffMs, 'maxRetryBackoffMs', { min: 0, max: 604800000 });
    if (retryBackoffMs > maxRetryBackoffMs) throw stateError('STATE_INVALID_ARGUMENT', 'retryBackoffMs may not exceed maxRetryBackoffMs.', { field: 'retryBackoffMs' });
    const expiryPolicy = source.expiryPolicy === undefined ? 'uncertain' : source.expiryPolicy;
    if (!['uncertain', 'retry'].includes(expiryPolicy)) throw stateError('STATE_INVALID_ARGUMENT', "expiryPolicy must be 'uncertain' or 'retry'.", { field: 'expiryPolicy' });
    const requestedAvailableAtMs = source.availableAtMs === undefined ? null : assertInteger(source.availableAtMs, 'availableAtMs');
    const inputHash = hashInput({ queue, type, payload, priority, availableAtMs: requestedAvailableAtMs, maxAttempts, retryBackoffMs, maxRetryBackoffMs, expiryPolicy });
    return { queue, type, idempotencyKey, payload, bodyJson, priority, maxAttempts, retryBackoffMs, maxRetryBackoffMs, expiryPolicy, requestedAvailableAtMs, inputHash };
  }

  _submitPreparedTask(db, definition, now, { maxActiveTasks = MAX_ACTIVE_TASKS_PER_QUEUE } = {}) {
    const existing = db.prepare('SELECT * FROM tasks WHERE queue_name = ? AND idempotency_key = ?').get(definition.queue, definition.idempotencyKey);
    if (existing) {
      if (existing.input_hash !== definition.inputHash) {
        throw stateError('TASK_IDEMPOTENCY_CONFLICT', 'The task idempotency key was already used with a different definition.', {
          queue: definition.queue, idempotencyKey: definition.idempotencyKey
        });
      }
      return { disposition: 'replay', task: this._taskRow(existing) };
    }
    const active = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE queue_name = ? AND status IN ('queued','leased','running','retry_wait','uncertain')").get(definition.queue).count;
    if (active >= maxActiveTasks) throw stateError('TASK_QUEUE_FULL', 'The task queue reached its active-task limit.', { queue: definition.queue, maximum: maxActiveTasks });
    const id = this._newId('task');
    const availableAtMs = definition.requestedAvailableAtMs === null ? now : definition.requestedAvailableAtMs;
    db.prepare(`INSERT INTO tasks(id, queue_name, task_type, idempotency_key, input_hash, body_json, status, priority, available_at_ms,
      max_attempts, attempt, retry_backoff_ms, max_retry_backoff_ms, expiry_policy, fence, created_at_ms, updated_at_ms)
      VALUES(?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, 0, ?, ?, ?, 0, ?, ?)`).run(
      id, definition.queue, definition.type, definition.idempotencyKey, definition.inputHash, definition.bodyJson,
      definition.priority, availableAtMs, definition.maxAttempts, definition.retryBackoffMs,
      definition.maxRetryBackoffMs, definition.expiryPolicy, now, now
    );
    return { disposition: 'submitted', task: this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)) };
  }

  submitTask(input) {
    const definition = this._prepareTaskSubmission(input);
    return this.transaction(db => this._submitPreparedTask(db, definition, this._now()));
  }

  // A small named queue may need a stricter cap than the shared handoff
  // default.  Keep the idempotency replay lookup and capacity check in the
  // same SQLite transaction so simultaneous submitters cannot overfill it.
  submitBoundedTask(input, maxActiveTasks) {
    const definition = this._prepareTaskSubmission(input);
    const maximum = assertInteger(maxActiveTasks, 'maxActiveTasks', { min: 1, max: MAX_ACTIVE_TASKS_PER_QUEUE });
    return this.transaction(db => this._submitPreparedTask(db, definition, this._now(), { maxActiveTasks: maximum }));
  }

  submitTasks(inputs) {
    if (!Array.isArray(inputs) || inputs.length > 1000) {
      throw stateError('STATE_INVALID_ARGUMENT', 'tasks must be an array of at most 1000 task definitions.', { field: 'tasks' });
    }
    const definitions = inputs.map((input, index) => {
      try { return this._prepareTaskSubmission(input); }
      catch (error) {
        if (error instanceof StateStoreError) error.details = { ...error.details, index };
        throw error;
      }
    });
    return this.transaction(db => {
      const now = this._now();
      return definitions.map(definition => this._submitPreparedTask(db, definition, now));
    });
  }

  claimTask(input) {
    const source = assertPlainObject(input, 'claim');
    const queue = this._taskIdentifier(source.queue, 'queue');
    const workerLabel = assertString(source.workerLabel === undefined ? this.ownerId : source.workerLabel,
      'workerLabel', { max: 100, pattern: /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,99}$/ });
    const leaseMs = this._leaseMs(source.leaseMs === undefined ? DEFAULT_TASK_LEASE_MS : source.leaseMs, 'leaseMs');
    let types;
    if (source.types !== undefined) {
      if (!Array.isArray(source.types) || source.types.length < 1 || source.types.length > 100) {
        throw stateError('STATE_INVALID_ARGUMENT', 'types must contain from 1 through 100 task type identifiers.', { field: 'types' });
      }
      types = [...new Set(source.types.map((type, index) => this._taskIdentifier(type, `types[${index}]`)))];
    }
    return this.transaction(db => {
      const now = this._now();
      this._reapExpiredTasks(db, now, { queue });
      const typeClause = types ? ` AND task_type IN (${types.map(() => '?').join(',')})` : '';
      const values = [queue, now, ...(types || [])];
      const row = db.prepare(`SELECT * FROM tasks WHERE queue_name = ? AND status IN ('queued','retry_wait')
        AND available_at_ms <= ? AND cancel_requested_at_ms IS NULL AND attempt < max_attempts${typeClause}
        ORDER BY priority DESC, available_at_ms, created_at_ms, id LIMIT 1`).get(...values);
      if (!row) return null;
      const fence = row.fence + 1;
      const attempt = row.attempt + 1;
      const claimToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = hashText(claimToken);
      const leaseExpiresAtMs = now + leaseMs;
      const changed = db.prepare(`UPDATE tasks SET status = 'leased', fence = ?, lease_worker_label = ?, lease_token_hash = ?,
        lease_expires_at_ms = ?, error_code = NULL, error_message = NULL, completed_at_ms = NULL, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND status IN ('queued','retry_wait')`).run(
        fence, workerLabel, tokenHash, leaseExpiresAtMs, now, row.id, row.fence
      );
      if (changed.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task changed before its claim could be recorded.', { taskId: row.id, fence });
      db.prepare(`INSERT INTO task_attempts(task_id, fence, execution_attempt, worker_label, token_hash, status,
        lease_expires_at_ms, claimed_at_ms, updated_at_ms) VALUES(?, ?, ?, ?, ?, 'leased', ?, ?, ?)`).run(
        row.id, fence, attempt, workerLabel, tokenHash, leaseExpiresAtMs, now, now
      );
      const handle = { taskId: row.id, attempt, workerLabel, claimToken, fence };
      return {
        task: this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id)),
        handle,
        leaseExpiresAtMs
      };
    });
  }

  startTask(handle, options = {}) {
    const claim = this._validateTaskHandle(handle);
    const source = assertPlainObject(options, 'options');
    const leaseMs = this._leaseMs(source.leaseMs === undefined ? DEFAULT_TASK_LEASE_MS : source.leaseMs, 'leaseMs');
    return this.transaction(db => {
      const now = this._now();
      const attempt = this._taskAttempt(db, claim);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
      if (attempt.status === 'running' && task && task.status === 'running' && task.fence === claim.fence) {
        const current = this._currentTaskClaim(db, claim, now, ['running']);
        const leaseExpiresAtMs = Math.max(current.task.lease_expires_at_ms, now + leaseMs);
        db.prepare('UPDATE tasks SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND fence = ?').run(leaseExpiresAtMs, now, task.id, claim.fence);
        db.prepare('UPDATE task_attempts SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE task_id = ? AND fence = ?').run(leaseExpiresAtMs, now, task.id, claim.fence);
        return { replayed: true, task: this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)), handle: claim, leaseExpiresAtMs };
      }
      const current = this._currentTaskClaim(db, claim, now, ['leased']);
      if (current.task.cancel_requested_at_ms !== null) {
        throw stateError('TASK_CANCEL_REQUESTED', 'Cancellation was requested before task execution started.', { taskId: current.task.id });
      }
      if (current.task.attempt + 1 !== claim.attempt || claim.attempt > current.task.max_attempts) {
        throw stateError('TASK_INVALID_TRANSITION', 'The claimed execution attempt is no longer eligible to start.', { taskId: current.task.id, attempt: claim.attempt });
      }
      const leaseExpiresAtMs = Math.max(current.task.lease_expires_at_ms, now + leaseMs);
      const changed = db.prepare(`UPDATE tasks SET status = 'running', attempt = ?, lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND status = 'leased' AND lease_expires_at_ms > ?`).run(
        claim.attempt, leaseExpiresAtMs, now, claim.taskId, claim.fence, now
      );
      if (changed.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task claim changed before execution could start.', { taskId: claim.taskId, fence: claim.fence });
      db.prepare(`UPDATE task_attempts SET status = 'running', lease_expires_at_ms = ?, started_at_ms = ?, updated_at_ms = ?
        WHERE task_id = ? AND fence = ? AND status = 'leased'`).run(leaseExpiresAtMs, now, now, claim.taskId, claim.fence);
      return {
        replayed: false,
        task: this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId)),
        handle: claim,
        leaseExpiresAtMs
      };
    });
  }

  heartbeatTask(handle, options = {}) {
    const claim = this._validateTaskHandle(handle);
    const source = assertPlainObject(options, 'options');
    const leaseMs = this._leaseMs(source.leaseMs === undefined ? DEFAULT_TASK_LEASE_MS : source.leaseMs, 'leaseMs');
    return this.transaction(db => {
      const now = this._now();
      const current = this._currentTaskClaim(db, claim, now, ['running']);
      const leaseExpiresAtMs = Math.max(current.task.lease_expires_at_ms, now + leaseMs);
      const changed = db.prepare(`UPDATE tasks SET lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND status = 'running' AND lease_expires_at_ms > ?`).run(
        leaseExpiresAtMs, now, claim.taskId, claim.fence, now
      );
      if (changed.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task claim changed before its heartbeat.', { taskId: claim.taskId, fence: claim.fence });
      db.prepare(`UPDATE task_attempts SET lease_expires_at_ms = ?, updated_at_ms = ?
        WHERE task_id = ? AND fence = ? AND status = 'running'`).run(leaseExpiresAtMs, now, claim.taskId, claim.fence);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
      return { task: this._taskRow(task), handle: claim, leaseExpiresAtMs, cancelRequested: task.cancel_requested_at_ms !== null };
    });
  }

  inspectTaskClaim(handle) {
    const claim = this._validateTaskHandle(handle);
    return this.transaction(db => {
      const now = this._now();
      const current = this._currentTaskClaim(db, claim, now, ['running']);
      return {
        task: this._taskRow(current.task),
        handle: claim,
        leaseExpiresAtMs: current.task.lease_expires_at_ms,
        cancelRequested: current.task.cancel_requested_at_ms !== null
      };
    });
  }

  _taskCheckpoint(value) {
    const checkpoint = assertPlainObject(value, 'checkpoint');
    assertNoPlaintextTaskSecrets(checkpoint, 'checkpoint');
    return checkpoint;
  }

  _checkpointRow(row) {
    if (!row) return null;
    return {
      revision: row.revision,
      checkpointKey: row.checkpoint_key,
      checkpoint: parseJson(row.checkpoint_json, 'task checkpoint'),
      hash: row.checkpoint_hash,
      previousHash: row.previous_hash,
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms
    };
  }

  checkpointTask(handle, options = {}) {
    const claim = this._validateTaskHandle(handle);
    const source = assertPlainObject(options, 'options');
    const checkpointKey = this._taskKey(source.checkpointKey, 'checkpointKey');
    const expectedRevision = assertInteger(source.expectedRevision, 'expectedRevision', { min: 0, max: MAX_TASK_CHECKPOINTS });
    const checkpoint = this._taskCheckpoint(source.checkpoint);
    const checkpointJson = boundedTaskJson(checkpoint, 'checkpoint', MAX_TASK_CHECKPOINT_BYTES, 'TASK_CHECKPOINT_TOO_LARGE');
    const leaseMs = source.leaseMs === undefined ? null : this._leaseMs(source.leaseMs, 'leaseMs');
    return this.transaction(db => {
      const now = this._now();
      const attempt = this._taskAttempt(db, claim);
      const prior = db.prepare('SELECT * FROM task_checkpoints WHERE task_id = ? AND fence = ? AND checkpoint_key = ?').get(
        claim.taskId, claim.fence, checkpointKey
      );
      if (prior) {
        if (prior.checkpoint_json !== checkpointJson) {
          throw stateError('TASK_CHECKPOINT_CONFLICT', 'The checkpoint key was already used with different content.', { taskId: claim.taskId, checkpointKey });
        }
        return {
          replayed: true,
          task: this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId)),
          handle: claim,
          savedCheckpoint: this._checkpointRow(prior),
          leaseExpiresAtMs: attempt.lease_expires_at_ms
        };
      }
      const current = this._currentTaskClaim(db, claim, now, ['running']);
      if (current.task.cancel_requested_at_ms !== null) {
        throw stateError('TASK_CANCEL_REQUESTED', 'Cancellation was requested before this checkpoint could be saved.', { taskId: claim.taskId });
      }
      if (current.task.checkpoint_revision !== expectedRevision) {
        throw stateError('TASK_CHECKPOINT_REVISION_CONFLICT', 'The checkpoint revision changed before this update.', {
          taskId: claim.taskId, expectedRevision, actualRevision: current.task.checkpoint_revision
        });
      }
      if (current.task.checkpoint_revision >= MAX_TASK_CHECKPOINTS) {
        throw stateError('TASK_CHECKPOINT_LIMIT', 'The task reached its checkpoint limit.', { taskId: claim.taskId, maximum: MAX_TASK_CHECKPOINTS });
      }
      const revision = current.task.checkpoint_revision + 1;
      const previousHash = current.task.checkpoint_hash;
      const checkpointHash = hashInput({ taskId: claim.taskId, revision, fence: claim.fence, attempt: claim.attempt, checkpointKey, previousHash, checkpoint });
      db.prepare(`INSERT INTO task_checkpoints(task_id, revision, fence, execution_attempt, checkpoint_key, previous_hash,
        checkpoint_json, checkpoint_hash, created_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        claim.taskId, revision, claim.fence, claim.attempt, checkpointKey, previousHash, checkpointJson, checkpointHash, now
      );
      const leaseExpiresAtMs = leaseMs === null ? current.task.lease_expires_at_ms : Math.max(current.task.lease_expires_at_ms, now + leaseMs);
      const changed = db.prepare(`UPDATE tasks SET checkpoint_revision = ?, checkpoint_key = ?, checkpoint_json = ?, checkpoint_hash = ?,
        lease_expires_at_ms = ?, updated_at_ms = ? WHERE id = ? AND fence = ? AND status = 'running'
        AND checkpoint_revision = ? AND lease_expires_at_ms > ?`).run(
        revision, checkpointKey, checkpointJson, checkpointHash, leaseExpiresAtMs, now,
        claim.taskId, claim.fence, expectedRevision, now
      );
      if (changed.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task claim changed before its checkpoint could commit.', { taskId: claim.taskId, fence: claim.fence });
      if (leaseMs !== null) db.prepare('UPDATE task_attempts SET lease_expires_at_ms = ?, updated_at_ms = ? WHERE task_id = ? AND fence = ? AND status = \'running\'').run(
        leaseExpiresAtMs, now, claim.taskId, claim.fence
      );
      const saved = db.prepare('SELECT * FROM task_checkpoints WHERE task_id = ? AND revision = ?').get(claim.taskId, revision);
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
      return {
        replayed: false,
        task: this._taskRow(task),
        handle: claim,
        savedCheckpoint: this._checkpointRow(saved),
        leaseExpiresAtMs,
        cancelRequested: task.cancel_requested_at_ms !== null
      };
    });
  }

  _taskResult(value) {
    const result = assertPlainObject(value, 'result');
    const computed = RESEARCH_COMPLETION_DIGESTS.get(result);
    RESEARCH_COMPLETION_DIGESTS.delete(result);
    if (computed !== undefined && Object.isFrozen(result) && result.collectionHash === computed.digest
        && JSON.stringify(result) === computed.json) {
      const { collectionHash, ...callerFields } = result;
      assertNoPlaintextTaskSecrets(callerFields, 'result');
    } else assertNoPlaintextTaskSecrets(result, 'result');
    return result;
  }

  completeTask(handle, options = {}) {
    const claim = this._validateTaskHandle(handle);
    const source = assertPlainObject(options, 'options');
    return this.transaction(db => this._completeTask(db, claim, source.result));
  }

  // Kept inside the caller's transaction so research evidence and its fenced
  // terminal outcome can commit together. No nested transaction is permitted.
  _completeTask(db, claim, value) {
    const result = this._taskResult(value);
    const resultJson = boundedTaskJson(result, 'result', MAX_JSON_BYTES, 'TASK_RESULT_TOO_LARGE');
    const resultHash = hashText(resultJson);
    const outcomeHash = hashInput({ disposition: 'succeeded', result });
    const now = this._now();
    const attempt = this._taskAttempt(db, claim);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
    if (attempt.status === 'succeeded') {
      if (!equalHash(attempt.outcome_hash, outcomeHash) || !task || task.status !== 'succeeded'
          || task.result_hash !== resultHash || task.result_json !== resultJson) {
        throw stateError('TASK_OUTCOME_CONFLICT', 'The task attempt already recorded a different terminal outcome.', { taskId: claim.taskId, fence: claim.fence });
      }
      return { replayed: true, task: this._taskRow(task), result };
    }
    if (task && task.cancel_requested_at_ms !== null) {
      throw stateError('TASK_CANCEL_REQUESTED', 'Cancellation was requested before task completion could be recorded.', { taskId: claim.taskId });
    }
    if (!task || task.fence !== claim.fence || task.attempt !== claim.attempt || !['running', 'uncertain'].includes(task.status)
      || !['running', 'uncertain'].includes(attempt.status)) {
      throw stateError('TASK_FENCE_LOST', 'The task attempt no longer owns the completion fence.', { taskId: claim.taskId, fence: claim.fence });
    }
    const attemptChanged = db.prepare(`UPDATE task_attempts SET status = 'succeeded', updated_at_ms = ?, ended_at_ms = ?, outcome_hash = ?,
      error_code = NULL, error_message = NULL WHERE task_id = ? AND fence = ? AND status IN ('running','uncertain')`).run(
      now, now, outcomeHash, claim.taskId, claim.fence
    );
    if (attemptChanged.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task attempt changed before completion could commit.', { taskId: claim.taskId, fence: claim.fence });
    const changed = db.prepare(`UPDATE tasks SET status = 'succeeded', result_json = ?, result_hash = ?, error_code = NULL,
      error_message = NULL, lease_worker_label = NULL, lease_token_hash = NULL, lease_expires_at_ms = NULL,
      completed_at_ms = ?, updated_at_ms = ? WHERE id = ? AND fence = ? AND status IN ('running','uncertain')`).run(
      resultJson, resultHash, now, now, claim.taskId, claim.fence
    );
    if (changed.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task changed before completion could commit.', { taskId: claim.taskId, fence: claim.fence });
    return { replayed: false, task: this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId)), result };
  }

  failTask(handle, options = {}) {
    const claim = this._validateTaskHandle(handle);
    const source = assertPlainObject(options, 'options');
    const disposition = source.disposition;
    if (!['retry', 'failed', 'uncertain', 'cancelled'].includes(disposition)) {
      throw stateError('STATE_INVALID_ARGUMENT', 'disposition must be retry, failed, uncertain, or cancelled.', { field: 'disposition' });
    }
    const code = assertString(source.code, 'code', { max: 100, pattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/ });
    const message = assertString(source.message === undefined ? '' : source.message, 'message', { min: 0, max: 1000 });
    const retryDelayMs = source.retryDelayMs === undefined ? null : assertInteger(source.retryDelayMs, 'retryDelayMs', { min: 0, max: 3600000 });
    if (retryDelayMs !== null && disposition !== 'retry') throw stateError('STATE_INVALID_ARGUMENT', 'retryDelayMs is valid only for retry disposition.', { field: 'retryDelayMs' });
    assertNoPlaintextTaskSecrets({ code, message }, 'failure');
    const outcomeHash = hashInput({ disposition, code, message, retryDelayMs });
    return this.transaction(db => {
      const now = this._now();
      const attempt = this._taskAttempt(db, claim);
      let task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
      if (disposition === 'retry' && task && task.expiry_policy !== 'retry') {
        throw stateError('TASK_RETRY_FORBIDDEN', 'This task was not submitted with a retry-safe expiry policy.', { taskId: claim.taskId });
      }
      const terminalAttemptStates = new Set(['retryable_failed', 'failed', 'cancelled']);
      if (terminalAttemptStates.has(attempt.status)) {
        if (!equalHash(attempt.outcome_hash, outcomeHash)) {
          throw stateError('TASK_OUTCOME_CONFLICT', 'The task attempt already recorded a different terminal outcome.', { taskId: claim.taskId, fence: claim.fence });
        }
        return { replayed: true, task: this._taskRow(task) };
      }
      if (attempt.status === 'uncertain') {
        if (disposition === 'uncertain') {
          if (!equalHash(attempt.outcome_hash, outcomeHash)) throw stateError('TASK_OUTCOME_CONFLICT', 'The task attempt already recorded different uncertainty details.', { taskId: claim.taskId, fence: claim.fence });
          return { replayed: true, task: this._taskRow(task) };
        }
        if (disposition !== 'failed') {
          throw stateError('TASK_UNCERTAIN', 'An uncertain task may only accept a definitive late success or failure from its original claim.', { taskId: claim.taskId, fence: claim.fence });
        }
      }
      if (!task || task.fence !== claim.fence || attempt.execution_attempt !== claim.attempt
        || !['leased', 'running', 'uncertain'].includes(task.status) || !['leased', 'running', 'uncertain'].includes(attempt.status)) {
        throw stateError('TASK_FENCE_LOST', 'The task attempt no longer owns the failure fence.', { taskId: claim.taskId, fence: claim.fence });
      }
      if (['leased', 'running'].includes(task.status)
        && (task.lease_worker_label !== claim.workerLabel || !equalHash(task.lease_token_hash, hashText(claim.claimToken)))) {
        throw stateError('TASK_FENCE_LOST', 'The task claim no longer owns the active failure fence.', { taskId: claim.taskId, fence: claim.fence });
      }
      if (disposition === 'uncertain' && task.status === 'leased') {
        throw stateError('TASK_INVALID_TRANSITION', 'A task that never started cannot have an uncertain execution outcome.', { taskId: task.id, status: task.status });
      }
      if (disposition === 'cancelled' && task.cancel_requested_at_ms === null) {
        throw stateError('TASK_CANCEL_NOT_REQUESTED', 'The worker may acknowledge cancellation only after it was requested.', { taskId: task.id });
      }

      let taskStatus;
      let attemptStatus;
      let errorCode = code;
      let errorMessage = message;
      let availableAtMs = task.available_at_ms;
      let completedAtMs = now;
      // A retry acknowledgement ends this attempt. If cancellation already
      // won, there must be no queued successor: retry_wait with a cancellation
      // flag has neither an eligible claimant nor a lease for the reaper.
      if (disposition === 'cancelled' || (disposition === 'retry' && task.cancel_requested_at_ms !== null)) {
        taskStatus = 'cancelled'; attemptStatus = 'cancelled'; errorCode = null; errorMessage = null;
      } else if (disposition === 'uncertain') {
        taskStatus = 'uncertain'; attemptStatus = 'uncertain';
      } else if (disposition === 'retry' && task.attempt < task.max_attempts) {
        taskStatus = 'retry_wait'; attemptStatus = 'retryable_failed'; completedAtMs = null;
        availableAtMs = retryDelayMs === null ? this._taskBackoff(task, now) : now + retryDelayMs;
      } else {
        taskStatus = 'failed'; attemptStatus = 'failed';
      }
      const attemptChanged = db.prepare(`UPDATE task_attempts SET status = ?, updated_at_ms = ?, ended_at_ms = ?, outcome_hash = ?,
        error_code = ?, error_message = ? WHERE task_id = ? AND fence = ? AND status IN ('leased','running','uncertain')`).run(
        attemptStatus, now, now, outcomeHash, attemptStatus === 'cancelled' ? null : code, attemptStatus === 'cancelled' ? null : message,
        claim.taskId, claim.fence
      );
      if (attemptChanged.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task attempt changed before its failure outcome could commit.', { taskId: claim.taskId, fence: claim.fence });
      const changed = db.prepare(`UPDATE tasks SET status = ?, available_at_ms = ?, lease_worker_label = NULL, lease_token_hash = NULL,
        lease_expires_at_ms = NULL, error_code = ?, error_message = ?, completed_at_ms = ?, updated_at_ms = ?
        WHERE id = ? AND fence = ? AND status IN ('leased','running','uncertain')`).run(
        taskStatus, availableAtMs, errorCode, errorMessage, completedAtMs, now, claim.taskId, claim.fence
      );
      if (changed.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task changed before its failure outcome could commit.', { taskId: claim.taskId, fence: claim.fence });
      task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
      return { replayed: false, task: this._taskRow(task) };
    });
  }

  cancelTask(input) {
    const source = assertPlainObject(input, 'cancellation');
    const taskId = assertString(source.taskId, 'taskId', { max: 500 });
    const reason = assertString(source.reason === undefined ? '' : source.reason, 'reason', { min: 0, max: 1000 });
    assertNoPlaintextTaskSecrets(reason, 'reason');
    return this.transaction(db => {
      const now = this._now();
      let row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      if (!row) throw stateError('TASK_NOT_FOUND', 'The durable task was not found.', { taskId });
      if (['succeeded', 'failed', 'cancelled'].includes(row.status)) {
        return { disposition: 'terminal', task: this._taskRow(row) };
      }
      if (row.status === 'uncertain') return { disposition: 'uncertain', task: this._taskRow(row) };
      if (['queued', 'retry_wait'].includes(row.status)) {
        db.prepare(`UPDATE tasks SET status = 'cancelled', cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?), cancel_reason = ?,
          error_code = NULL, error_message = NULL, completed_at_ms = ?, updated_at_ms = ? WHERE id = ? AND status IN ('queued','retry_wait')`).run(
          now, reason, now, now, taskId
        );
        row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
        return { disposition: 'cancelled', task: this._taskRow(row) };
      }
      db.prepare(`UPDATE tasks SET cancel_requested_at_ms = COALESCE(cancel_requested_at_ms, ?), cancel_reason = COALESCE(cancel_reason, ?), updated_at_ms = ?
        WHERE id = ? AND status IN ('leased','running')`).run(now, reason, now, taskId);
      row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
      return { disposition: 'requested', task: this._taskRow(row), cancelRequested: true };
    });
  }

  reapExpiredTasks(options = {}) {
    const source = assertPlainObject(options, 'options');
    const queue = source.queue === undefined ? undefined : this._taskIdentifier(source.queue, 'queue');
    const limit = assertInteger(source.limit === undefined ? 1000 : source.limit, 'limit', { min: 1, max: 1000 });
    return this.transaction(db => this._reapExpiredTasks(db, this._now(), { queue, limit }));
  }

  getTask(input) {
    const source = assertPlainObject(input, 'selector');
    const taskId = assertString(source.taskId, 'taskId', { max: 500 });
    const includePayload = source.includePayload === true;
    const includeCheckpoint = source.includeCheckpoint === true;
    const now = this._now();
    return this._read(db => this._taskRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId), { includePayload, includeCheckpoint, now }));
  }

  // Owner-facing, deliberately redacted attempt reader. The delegation layer
  // needs the canonical fence/execution-attempt relation but never receives a
  // worker identity, credential digest, outcome hash, error, payload, or row.
  getTaskAttemptMetadata(input) {
    const source = assertPlainObject(input, 'selector');
    const taskId = assertString(source.taskId, 'taskId', { max: 500 });
    const fence = assertInteger(source.fence, 'fence', { min: 1 });
    return this._read(db => {
      const row = db.prepare(`SELECT task_id, fence, execution_attempt, status, lease_expires_at_ms,
        claimed_at_ms, started_at_ms, updated_at_ms, ended_at_ms
        FROM task_attempts WHERE task_id = ? AND fence = ?`).get(taskId, fence);
      if (!row) return null;
      return Object.freeze({
        taskId: row.task_id,
        fence: row.fence,
        executionAttempt: row.execution_attempt,
        status: row.status,
        leaseExpiresAtMs: row.lease_expires_at_ms,
        claimedAtMs: row.claimed_at_ms,
        startedAtMs: row.started_at_ms,
        updatedAtMs: row.updated_at_ms,
        endedAtMs: row.ended_at_ms
      });
    });
  }

  // Checkpoints are append-only, hash-linked durable progress records.  This
  // bounded reader is intentionally separate from getTask's latest-checkpoint
  // snapshot so a client can consume progress with a cursor without scanning
  // raw SQLite tables or retaining task payloads/results.
  listTaskCheckpoints(options = {}) {
    const source = assertPlainObject(options, 'options');
    const taskId = assertString(source.taskId, 'taskId', { max: 500 });
    const afterRevision = assertInteger(source.afterRevision === undefined ? 0 : source.afterRevision, 'afterRevision', {
      min: 0, max: MAX_TASK_CHECKPOINTS
    });
    const limit = assertInteger(source.limit === undefined ? 100 : source.limit, 'limit', { min: 1, max: 200 });
    return this._read(db => db.prepare(`SELECT * FROM task_checkpoints
      WHERE task_id = ? AND revision > ? ORDER BY revision LIMIT ?`).all(taskId, afterRevision, limit)
      .map(row => this._checkpointRow(row)));
  }

  _coordinatorText(value, label, maximum) {
    const text = assertString(value, label, { min: 0, max: maximum });
    assertNoPlaintextTaskSecrets(text, label);
    return text;
  }

  _coordinatorTextList(value, label, maximumItems, maximumItemLength) {
    if (!Array.isArray(value) || value.length > maximumItems) {
      throw stateError('COORDINATOR_MISSION_INVALID', `${label} must be an array of at most ${maximumItems} safe strings.`, { field: label });
    }
    return value.map((item, index) => this._coordinatorText(item, `${label}[${index}]`, maximumItemLength));
  }

  _coordinatorMission(value) {
    const source = assertPlainObject(value, 'coordinator mission');
    assertOnlyKeys(source, new Set(['version', 'ownerRequest', 'constraints', 'decisions', 'acceptanceGates', 'reportPointer']), 'coordinator mission', 'COORDINATOR_MISSION_INVALID');
    if (source.version !== 1) throw stateError('COORDINATOR_MISSION_INVALID', 'coordinator mission version must be 1.', { field: 'mission.version' });
    const mission = {
      version: 1,
      ownerRequest: this._coordinatorText(source.ownerRequest, 'mission.ownerRequest', 12000),
      constraints: this._coordinatorTextList(source.constraints, 'mission.constraints', 32, 1000),
      decisions: this._coordinatorTextList(source.decisions, 'mission.decisions', 64, 1000),
      acceptanceGates: this._coordinatorTextList(source.acceptanceGates, 'mission.acceptanceGates', 32, 1000),
      reportPointer: assertString(source.reportPointer, 'mission.reportPointer', {
        min: 1, max: 400, pattern: /^reports\/[A-Za-z0-9._-]+\.(?:json|pdf)$/
      })
    };
    assertNoPlaintextTaskSecrets(mission, 'coordinator mission');
    const json = boundedTaskJson(mission, 'coordinator mission', 64 * 1024, 'COORDINATOR_MISSION_TOO_LARGE');
    return { mission, json, hash: hashText(json) };
  }

  _coordinatorMissionRow(row) {
    if (!row) return null;
    return {
      runId: row.run_id,
      taskId: row.task_id,
      revision: row.owner_revision,
      mission: parseJson(row.owner_json, 'coordinator mission'),
      hash: row.owner_hash,
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms,
      updatedAt: iso(row.updated_at_ms),
      updatedAtMs: row.updated_at_ms
    };
  }

  submitCoordinatorMission(input) {
    const source = assertPlainObject(input, 'coordinator mission submission');
    assertOnlyKeys(source, new Set(['runId', 'task', 'mission']), 'coordinator mission submission', 'COORDINATOR_MISSION_INVALID');
    const runId = assertString(source.runId, 'runId', { min: 36, max: 36, pattern: /^run-[a-f0-9]{32}$/ });
    const task = this._prepareTaskSubmission(source.task);
    const preparedMission = this._coordinatorMission(source.mission);
    return this.transaction(db => {
      const now = this._now();
      const submitted = this._submitPreparedTask(db, task, now);
      const existing = db.prepare('SELECT * FROM coordinator_missions WHERE run_id = ?').get(runId);
      if (existing) {
        if (existing.task_id !== submitted.task.id || existing.owner_hash !== preparedMission.hash) {
          throw stateError('COORDINATOR_MISSION_IDEMPOTENCY_CONFLICT', 'The durable run id already has different mission context.', { runId });
        }
        return { ...submitted, mission: this._coordinatorMissionRow(existing) };
      }
      // v10 adds mission state to pre-existing v9 coordinator tasks.  A replay can
      // safely backfill it only after _submitPreparedTask has verified that
      // the replayed task has the exact same idempotent input hash.  We never
      // infer a mission from arbitrary legacy task text.
      db.prepare(`INSERT INTO coordinator_missions(run_id, task_id, owner_revision, owner_json, owner_hash, created_at_ms, updated_at_ms)
        VALUES(?, ?, 1, ?, ?, ?, ?)`).run(runId, submitted.task.id, preparedMission.json, preparedMission.hash, now, now);
      return { ...submitted, mission: this._coordinatorMissionRow(db.prepare('SELECT * FROM coordinator_missions WHERE run_id = ?').get(runId)) };
    });
  }

  getCoordinatorMission(input) {
    const source = assertPlainObject(input, 'coordinator mission selector');
    const runId = assertString(source.runId, 'runId', { min: 36, max: 36, pattern: /^run-[a-f0-9]{32}$/ });
    return this._read(db => this._coordinatorMissionRow(db.prepare('SELECT * FROM coordinator_missions WHERE run_id = ?').get(runId)));
  }

  updateCoordinatorMission(input) {
    const source = assertPlainObject(input, 'coordinator mission update');
    assertOnlyKeys(source, new Set(['runId', 'expectedRevision', 'mission']), 'coordinator mission update', 'COORDINATOR_MISSION_INVALID');
    const runId = assertString(source.runId, 'runId', { min: 36, max: 36, pattern: /^run-[a-f0-9]{32}$/ });
    const expectedRevision = assertInteger(source.expectedRevision, 'expectedRevision', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const prepared = this._coordinatorMission(source.mission);
    return this.transaction(db => {
      const now = this._now();
      const changed = db.prepare(`UPDATE coordinator_missions SET owner_revision = owner_revision + 1, owner_json = ?, owner_hash = ?, updated_at_ms = ?
        WHERE run_id = ? AND owner_revision = ?`).run(prepared.json, prepared.hash, now, runId, expectedRevision);
      if (changed.changes !== 1) {
        const current = db.prepare('SELECT owner_revision FROM coordinator_missions WHERE run_id = ?').get(runId);
        if (!current) throw stateError('COORDINATOR_MISSION_NOT_FOUND', 'The coordinator mission was not found.', { runId });
        throw stateError('COORDINATOR_MISSION_REVISION_CONFLICT', 'The owner mission changed before this update.', { runId, expectedRevision, actualRevision: current.owner_revision });
      }
      return this._coordinatorMissionRow(db.prepare('SELECT * FROM coordinator_missions WHERE run_id = ?').get(runId));
    });
  }

  _coordinatorPhaseState(value) {
    const source = assertPlainObject(value, 'coordinator phase state');
    assertOnlyKeys(source, new Set(['runId', 'actor', 'taskId', 'attempt', 'fence', 'phase', 'phaseStatus', 'expectedSharedRevision', 'scratchSummary', 'resumeSummary', 'cursor', 'retryCount', 'nextAction']), 'coordinator phase state', 'COORDINATOR_PHASE_INVALID');
    const phaseStatus = assertString(source.phaseStatus, 'phaseStatus', { min: 1, max: 20 });
    if (!['idle', 'running', 'continuation', 'blocked', 'completed', 'cancelled', 'uncertain'].includes(phaseStatus)) {
      throw stateError('COORDINATOR_PHASE_INVALID', 'phaseStatus is invalid.', { field: 'phaseStatus' });
    }
    return {
      runId: assertString(source.runId, 'runId', { min: 36, max: 36, pattern: /^run-[a-f0-9]{32}$/ }),
      actor: assertString(source.actor, 'actor', { min: 3, max: 16, pattern: /^(?:human|codex|claude|gemini|grok|coordinator)$/ }),
      taskId: assertString(source.taskId, 'taskId', { min: 1, max: 500 }),
      attempt: assertInteger(source.attempt, 'attempt', { min: 1, max: 10 }),
      fence: assertInteger(source.fence, 'fence', { min: 1 }),
      phase: assertInteger(source.phase, 'phase', { min: 0, max: 24 }),
      phaseStatus,
      expectedSharedRevision: assertInteger(source.expectedSharedRevision, 'expectedSharedRevision', { min: 1 }),
      scratchSummary: this._coordinatorText(source.scratchSummary || '', 'scratchSummary', 2000),
      resumeSummary: this._coordinatorText(source.resumeSummary || '', 'resumeSummary', 2000),
      cursor: this._coordinatorText(source.cursor || '', 'cursor', 500),
      retryCount: assertInteger(source.retryCount === undefined ? 0 : source.retryCount, 'retryCount', { min: 0, max: 5 }),
      nextAction: this._coordinatorText(source.nextAction || '', 'nextAction', 240)
    };
  }

  _coordinatorPhaseRow(row) {
    if (!row) return null;
    return {
      runId: row.run_id, actor: row.actor, taskId: row.task_id, attempt: row.attempt, fence: row.fence,
      phase: row.phase, phaseStatus: row.phase_status, sharedRevision: row.shared_revision,
      scratchSummary: row.scratch_summary, resumeSummary: row.resume_summary, cursor: row.cursor,
      retryCount: row.retry_count, nextAction: row.next_action, updatedAt: iso(row.updated_at_ms), updatedAtMs: row.updated_at_ms
    };
  }

  saveCoordinatorPhaseState(input) {
    const phase = this._coordinatorPhaseState(input);
    return this.transaction(db => {
      const now = this._now();
      const mission = db.prepare('SELECT * FROM coordinator_missions WHERE run_id = ?').get(phase.runId);
      if (!mission || mission.task_id !== phase.taskId) throw stateError('COORDINATOR_MISSION_NOT_FOUND', 'The coordinator mission does not match this task.', { runId: phase.runId });
      if (mission.owner_revision !== phase.expectedSharedRevision) {
        throw stateError('COORDINATOR_MISSION_REVISION_CONFLICT', 'The owner mission changed; re-read it before continuing this phase.', { runId: phase.runId, expectedRevision: phase.expectedSharedRevision, actualRevision: mission.owner_revision });
      }
      const task = db.prepare('SELECT id, status, attempt, fence, lease_expires_at_ms FROM tasks WHERE id = ?').get(phase.taskId);
      if (!task || task.status !== 'running' || task.attempt !== phase.attempt || task.fence !== phase.fence || task.lease_expires_at_ms <= now) {
        throw stateError('COORDINATOR_PHASE_FENCE_LOST', 'The task fence is no longer active for this phase state.', { taskId: phase.taskId, fence: phase.fence });
      }
      const prior = db.prepare('SELECT * FROM coordinator_phase_states WHERE run_id = ? AND actor = ?').get(phase.runId, phase.actor);
      if (prior && (prior.fence > phase.fence || (prior.fence === phase.fence && prior.phase > phase.phase))) {
        throw stateError('COORDINATOR_PHASE_FENCE_LOST', 'A newer coordinator phase state already owns this actor/run.', { runId: phase.runId, actor: phase.actor, fence: phase.fence });
      }
      db.prepare(`INSERT INTO coordinator_phase_states(run_id, actor, task_id, attempt, fence, phase, phase_status, shared_revision,
        scratch_summary, resume_summary, cursor, retry_count, next_action, updated_at_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, actor) DO UPDATE SET task_id = excluded.task_id, attempt = excluded.attempt, fence = excluded.fence,
          phase = excluded.phase, phase_status = excluded.phase_status, shared_revision = excluded.shared_revision,
          scratch_summary = excluded.scratch_summary, resume_summary = excluded.resume_summary, cursor = excluded.cursor,
          retry_count = excluded.retry_count, next_action = excluded.next_action, updated_at_ms = excluded.updated_at_ms`).run(
        phase.runId, phase.actor, phase.taskId, phase.attempt, phase.fence, phase.phase, phase.phaseStatus,
        phase.expectedSharedRevision, phase.scratchSummary, phase.resumeSummary, phase.cursor, phase.retryCount, phase.nextAction, now
      );
      return this._coordinatorPhaseRow(db.prepare('SELECT * FROM coordinator_phase_states WHERE run_id = ? AND actor = ?').get(phase.runId, phase.actor));
    });
  }

  getCoordinatorPhaseStates(input) {
    const source = assertPlainObject(input, 'coordinator phase selector');
    const runId = assertString(source.runId, 'runId', { min: 36, max: 36, pattern: /^run-[a-f0-9]{32}$/ });
    return this._read(db => db.prepare('SELECT * FROM coordinator_phase_states WHERE run_id = ? ORDER BY updated_at_ms DESC, actor').all(runId).map(row => this._coordinatorPhaseRow(row)));
  }

  // The methods below are deliberately broker-internal.  They are not generic
  // task metadata: their uniqueness and transaction boundaries are what keep a
  // worker's prose-level `succeeded` result distinct from workflow ACCEPTED.
  _workflowRunId(value, label = 'runId') {
    return assertString(value, label, { min: 36, max: 36, pattern: /^run-[a-f0-9]{32}$/ });
  }

  _workflowIdentifier(value, label) {
    return assertString(value, label, { min: 3, max: 160, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/ });
  }

  _workflowHash(value, label) {
    return assertString(value, label, { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
  }

  _workflowJson(value, label, maximumBytes) {
    assertNoPlaintextTaskSecrets(value, label);
    return boundedTaskJson(value, label, maximumBytes, 'COORDINATOR_WORKFLOW_RECORD_TOO_LARGE');
  }

  _workflowMissionRow(row) {
    if (!row) return null;
    return {
      runId: row.run_id,
      taskId: row.task_id,
      missionId: row.mission_id,
      missionHash: row.mission_hash,
      contract: parseJson(row.contract_json, 'coordinator workflow mission contract'),
      contractHash: row.contract_hash,
      ownerRevision: row.owner_revision,
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms,
      updatedAt: iso(row.updated_at_ms),
      updatedAtMs: row.updated_at_ms
    };
  }

  _workflowVerificationRow(row) {
    if (!row) return null;
    return {
      runId: row.run_id,
      executionRole: row.execution_role,
      executionId: row.execution_id,
      record: parseJson(row.record_json, 'coordinator broker verification'),
      hash: row.record_hash,
      ownerRevision: row.owner_revision,
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms
    };
  }

  _workflowOutboxRow(row) {
    if (!row) return null;
    return {
      outboxId: row.outbox_id,
      runId: row.run_id,
      eventId: row.event_id,
      eventHash: row.event_hash,
      event: parseJson(row.event_json, 'coordinator workflow event'),
      deliveryState: row.status,
      fence: row.fence,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      createdAt: iso(row.created_at_ms),
      createdAtMs: row.created_at_ms,
      updatedAt: iso(row.updated_at_ms),
      updatedAtMs: row.updated_at_ms,
      deliveredAt: row.delivered_at_ms === null ? null : iso(row.delivered_at_ms),
      deliveredAtMs: row.delivered_at_ms
    };
  }

  _workflowAcceptanceRow(row) {
    if (!row) return null;
    return {
      runId: row.run_id,
      taskId: row.task_id,
      missionId: row.mission_id,
      missionHash: row.mission_hash,
      ownerRevision: row.owner_revision,
      acceptance: parseJson(row.acceptance_json, 'coordinator workflow acceptance'),
      acceptanceHash: row.acceptance_hash,
      resultHash: row.result_hash,
      eventId: row.event_id,
      status: 'ACCEPTED',
      acceptedAt: iso(row.accepted_at_ms),
      acceptedAtMs: row.accepted_at_ms
    };
  }

  // This is the one read-only source of truth for both authoritative replay
  // and P04 historical-advisory eligibility. P04 may never trust a cached
  // hash column or a partial duplicate of the Q11 terminal graph.
  _validatedCommittedCoordinatorWorkflowAcceptance(db, { runId, claim = null, expected = null }) {
    const prior = db.prepare('SELECT * FROM coordinator_workflow_acceptances WHERE run_id = ?').get(runId);
    if (!prior) return null;
    const workflow = db.prepare('SELECT * FROM coordinator_workflow_missions WHERE run_id = ?').get(runId);
    const ownerMission = db.prepare('SELECT * FROM coordinator_missions WHERE run_id = ?').get(runId);
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(prior.task_id);
    const attempt = claim
      ? this._taskAttempt(db, claim)
      : task && db.prepare('SELECT * FROM task_attempts WHERE task_id = ? AND fence = ?').get(task.id, task.fence);
    if (!workflow || !ownerMission || !task || !attempt || (claim && claim.taskId !== prior.task_id)
        || workflow.task_id !== prior.task_id || ownerMission.task_id !== prior.task_id
        || workflow.mission_id !== prior.mission_id || !equalHash(workflow.mission_hash, prior.mission_hash)) {
      throw stateError('COORDINATOR_WORKFLOW_STATE_CORRUPT', 'The committed workflow acceptance has a missing or mismatched mission/task edge.', { runId });
    }
    if (workflow.owner_revision !== prior.owner_revision || ownerMission.owner_revision !== prior.owner_revision) {
      throw stateError('COORDINATOR_WORKFLOW_ACCEPTANCE_STALE', 'The owner mission changed after this workflow acceptance was recorded.', { runId });
    }
    if ((claim && (task.fence !== claim.fence || task.attempt !== claim.attempt)) || task.status !== 'succeeded'
        || task.cancel_requested_at_ms !== null || !equalHash(task.result_hash, prior.result_hash)
        || attempt.status !== 'succeeded' || attempt.execution_attempt !== task.attempt) {
      throw stateError('COORDINATOR_WORKFLOW_STATE_CORRUPT', 'The committed workflow acceptance no longer matches its terminal fenced task attempt.', { runId });
    }
    if (task.result_json === null || !equalHash(hashText(task.result_json), task.result_hash)) {
      throw stateError('COORDINATOR_WORKFLOW_STATE_CORRUPT', 'The terminal workflow task result is missing or has an invalid durable hash.', { runId });
    }
    const taskResult = parseJson(task.result_json, 'coordinator workflow task result');
    if (!equalHash(attempt.outcome_hash, hashInput({ disposition: 'succeeded', result: taskResult }))) {
      throw stateError('COORDINATOR_WORKFLOW_STATE_CORRUPT', 'The terminal workflow task attempt outcome does not match its durable result.', { runId });
    }
    const baseline = db.prepare("SELECT * FROM coordinator_broker_verifications WHERE run_id = ? AND execution_role = 'baseline'").get(runId);
    const candidate = db.prepare("SELECT * FROM coordinator_broker_verifications WHERE run_id = ? AND execution_role = 'candidate'").get(runId);
    const event = db.prepare('SELECT * FROM coordinator_workflow_events WHERE event_id = ?').get(prior.event_id);
    const outbox = event && db.prepare('SELECT * FROM coordinator_workflow_outbox WHERE event_id = ?').get(event.event_id);
    if (!baseline || !candidate || !event || !outbox || baseline.owner_revision !== prior.owner_revision
        || candidate.owner_revision !== prior.owner_revision || event.run_id !== runId || event.mission_id !== prior.mission_id
        || outbox.run_id !== runId || outbox.event_id !== event.event_id
        || !equalHash(outbox.event_hash, event.event_hash) || outbox.event_json !== event.event_json) {
      throw stateError('COORDINATOR_WORKFLOW_STATE_CORRUPT', 'The committed workflow acceptance has a missing or mismatched verification/event/outbox edge.', { runId });
    }
    if (!equalHash(hashText(baseline.record_json), baseline.record_hash) || !equalHash(hashText(candidate.record_json), candidate.record_hash)
        || !equalHash(hashText(event.event_json), event.event_hash) || !equalHash(hashText(prior.acceptance_json), prior.acceptance_hash)) {
      throw stateError('COORDINATOR_WORKFLOW_STATE_CORRUPT', 'A committed workflow record no longer matches its durable canonical hash.', { runId });
    }
    const contract = parseJson(workflow.contract_json, 'coordinator workflow mission contract');
    if (!equalHash(hashText(canonicalJson(contract)), workflow.contract_hash) || !equalHash(workflow.contract_hash, workflow.mission_hash)) {
      throw stateError('COORDINATOR_WORKFLOW_STATE_CORRUPT', 'The persisted workflow contract no longer matches its mission hash.', { runId });
    }
    const storedAcceptance = parseJson(prior.acceptance_json, 'coordinator workflow acceptance');
    const storedEvent = parseJson(event.event_json, 'coordinator workflow event');
    let derived;
    try {
      derived = deriveAcceptedWorkflow({
        mission: contract,
        baseline: parseJson(baseline.record_json, 'coordinator baseline broker verification'),
        candidate: parseJson(candidate.record_json, 'coordinator candidate broker verification'),
        acceptedAt: storedEvent.occurredAt
      });
    } catch (error) {
      throw stateError('COORDINATOR_WORKFLOW_STATE_CORRUPT', 'The persisted workflow evidence can no longer reconstruct its accepted terminal fact.', { runId, cause: error && error.code }, error);
    }
    const reconstructed = { ...derived, baselineRecordHash: baseline.record_hash, candidateRecordHash: candidate.record_hash };
    if (canonicalJson(reconstructed) !== prior.acceptance_json || canonicalJson(derived.event) !== event.event_json
        || derived.event.eventId !== prior.event_id || derived.outbox.outboxId !== outbox.outbox_id
        || !equalHash(derived.outbox.eventHash, event.event_hash) || storedAcceptance.status !== 'ACCEPTED'
        || storedEvent.eventId !== prior.event_id) {
      throw stateError('COORDINATOR_WORKFLOW_STATE_CORRUPT', 'The committed workflow acceptance is not semantically bound to its reconstructed terminal event.', { runId });
    }
    if (expected && (expected.missionId !== prior.mission_id || !equalHash(expected.missionHash, prior.mission_hash)
        || expected.ownerRevision !== prior.owner_revision || !equalHash(expected.baselineRecordHash, baseline.record_hash)
        || !equalHash(expected.candidateRecordHash, candidate.record_hash) || !equalHash(expected.acceptanceHash, prior.acceptance_hash)
        || !equalHash(expected.resultHash, prior.result_hash) || expected.eventId !== prior.event_id
        || !equalHash(expected.eventHash, event.event_hash) || expected.outboxId !== outbox.outbox_id)) {
      throw stateError('COORDINATOR_WORKFLOW_ACCEPTANCE_CONFLICT', 'The durable run already has a different terminal acceptance record.', { runId });
    }
    return { prior, task, attempt, workflow, ownerMission, baseline, candidate, event, outbox };
  }

  // A committed ACCEPTED terminal fact is replayed from the durable graph, not
  // from its historical artifact workspace. This keeps a crash/retry safe
  // after normal artifact retention/cleanup, while the pre-commit path still
  // re-resolves every snapshot immediately before its transaction.
  _replayCoordinatorWorkflowAcceptance(db, { runId, claim, expected = null }) {
    const graph = this._validatedCommittedCoordinatorWorkflowAcceptance(db, { runId, claim, expected });
    if (!graph) return null;
    return {
      replayed: true,
      task: this._taskRow(graph.task),
      acceptance: this._workflowAcceptanceRow(graph.prior),
      outbox: this._workflowOutboxRow(graph.outbox)
    };
  }

  recordCoordinatorWorkflowMission(input) {
    const source = assertPlainObject(input, 'coordinator workflow mission');
    assertOnlyKeys(source, new Set(['runId', 'missionId', 'missionHash', 'contract', 'ownerRevision']), 'coordinator workflow mission', 'COORDINATOR_WORKFLOW_INVALID');
    const runId = this._workflowRunId(source.runId);
    const missionId = this._workflowIdentifier(source.missionId, 'missionId');
    const missionHash = this._workflowHash(source.missionHash, 'missionHash');
    const ownerRevision = assertInteger(source.ownerRevision, 'ownerRevision', { min: 1 });
    const contractJson = this._workflowJson(assertPlainObject(source.contract, 'contract'), 'contract', 64 * 1024);
    const contractHash = hashText(contractJson);
    if (!equalHash(missionHash, contractHash)) {
      throw stateError('COORDINATOR_WORKFLOW_MISSION_HASH_MISMATCH', 'The workflow mission hash does not match its canonical contract.', { runId, missionId });
    }
    return this.transaction(db => {
      const now = this._now();
      const ownerMission = db.prepare('SELECT * FROM coordinator_missions WHERE run_id = ?').get(runId);
      if (!ownerMission) throw stateError('COORDINATOR_WORKFLOW_RUN_NOT_FOUND', 'The durable run has no durable owner mission.', { runId });
      if (ownerMission.owner_revision !== ownerRevision) {
        throw stateError('COORDINATOR_WORKFLOW_OWNER_REVISION_CONFLICT', 'The owner mission revision changed before the workflow contract was recorded.', { runId, expectedOwnerRevision: ownerRevision, actualOwnerRevision: ownerMission.owner_revision });
      }
      const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(ownerMission.task_id);
      if (!task || ['succeeded', 'failed', 'uncertain', 'cancelled'].includes(task.status)) {
        throw stateError('COORDINATOR_WORKFLOW_TASK_NOT_ACTIVE', 'An authoritative workflow contract cannot be attached to a terminal coordinator task.', { runId, status: task && task.status });
      }
      const existing = db.prepare('SELECT * FROM coordinator_workflow_missions WHERE run_id = ?').get(runId);
      if (existing) {
        if (existing.task_id !== ownerMission.task_id || existing.mission_id !== missionId || !equalHash(existing.mission_hash, missionHash) ||
            !equalHash(existing.contract_hash, contractHash) || existing.owner_revision !== ownerRevision) {
          throw stateError('COORDINATOR_WORKFLOW_MISSION_CONFLICT', 'The workflow mission identifier was already recorded with different canonical content.', { runId, missionId });
        }
        return { replayed: true, mission: this._workflowMissionRow(existing) };
      }
      db.prepare(`INSERT INTO coordinator_workflow_missions(run_id, task_id, mission_id, mission_hash, contract_json, contract_hash, owner_revision, created_at_ms, updated_at_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(runId, ownerMission.task_id, missionId, missionHash, contractJson, contractHash, ownerRevision, now, now);
      return { replayed: false, mission: this._workflowMissionRow(db.prepare('SELECT * FROM coordinator_workflow_missions WHERE run_id = ?').get(runId)) };
    });
  }

  getCoordinatorWorkflowMission(input) {
    const source = assertPlainObject(input, 'coordinator workflow mission selector');
    const runId = this._workflowRunId(source.runId);
    return this._read(db => this._workflowMissionRow(db.prepare('SELECT * FROM coordinator_workflow_missions WHERE run_id = ?').get(runId)));
  }

  recordCoordinatorBrokerVerification(input) {
    const source = assertPlainObject(input, 'coordinator broker verification');
    assertOnlyKeys(source, new Set(['runId', 'executionRole', 'executionId', 'record', 'ownerRevision']), 'coordinator broker verification', 'COORDINATOR_WORKFLOW_INVALID');
    const runId = this._workflowRunId(source.runId);
    const executionRole = assertString(source.executionRole, 'executionRole', { min: 8, max: 9, pattern: /^(?:baseline|candidate)$/ });
    const executionId = this._workflowIdentifier(source.executionId, 'executionId');
    const ownerRevision = assertInteger(source.ownerRevision, 'ownerRevision', { min: 1 });
    const record = assertPlainObject(source.record, 'record');
    if (record.runId !== runId || record.executionRole !== executionRole || record.executionId !== executionId) {
      throw stateError('COORDINATOR_BROKER_VERIFICATION_MISMATCH', 'The broker verification body does not match its durable run, role, and execution identifier.', { runId, executionRole, executionId });
    }
    const recordJson = this._workflowJson(record, 'record', 256 * 1024);
    const recordHash = hashText(recordJson);
    return this.transaction(db => {
      const workflow = db.prepare('SELECT * FROM coordinator_workflow_missions WHERE run_id = ?').get(runId);
      const ownerMission = db.prepare('SELECT * FROM coordinator_missions WHERE run_id = ?').get(runId);
      const task = workflow && db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(workflow.task_id);
      if (!workflow || !ownerMission || !task) throw stateError('COORDINATOR_WORKFLOW_MISSION_NOT_FOUND', 'The workflow mission was not found.', { runId });
      if (record.missionId !== workflow.mission_id || !equalHash(record.missionHash, workflow.mission_hash)) {
        throw stateError('COORDINATOR_BROKER_VERIFICATION_MISMATCH', 'The broker verification body is not bound to the persisted workflow mission.', { runId });
      }
      if (workflow.owner_revision !== ownerRevision || ownerMission.owner_revision !== ownerRevision) {
        throw stateError('COORDINATOR_WORKFLOW_OWNER_REVISION_CONFLICT', 'The owner mission changed before broker verification could be recorded.', { runId, expectedOwnerRevision: ownerRevision, actualOwnerRevision: ownerMission.owner_revision });
      }
      const existing = db.prepare('SELECT * FROM coordinator_broker_verifications WHERE run_id = ? AND execution_role = ?').get(runId, executionRole);
      if (existing) {
        if (existing.execution_id !== executionId || !equalHash(existing.record_hash, recordHash) || existing.owner_revision !== ownerRevision) {
          throw stateError('COORDINATOR_BROKER_VERIFICATION_CONFLICT', 'The broker verification role was already recorded with different canonical content.', { runId, executionRole, executionId });
        }
        return { replayed: true, verification: this._workflowVerificationRow(existing) };
      }
      if (task.status !== 'running') throw stateError('COORDINATOR_WORKFLOW_TASK_NOT_RUNNING', 'Broker verification requires the current coordinator task to be running.', { runId, status: task.status });
      const duplicateExecution = db.prepare('SELECT execution_role FROM coordinator_broker_verifications WHERE run_id = ? AND execution_id = ?').get(runId, executionId);
      if (duplicateExecution) throw stateError('COORDINATOR_BROKER_EXECUTION_CONFLICT', 'A broker execution id may not serve more than one baseline/candidate role.', { runId, executionId });
      const now = this._now();
      db.prepare(`INSERT INTO coordinator_broker_verifications(run_id, execution_role, execution_id, record_json, record_hash, owner_revision, created_at_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?)`).run(runId, executionRole, executionId, recordJson, recordHash, ownerRevision, now);
      return { replayed: false, verification: this._workflowVerificationRow(db.prepare('SELECT * FROM coordinator_broker_verifications WHERE run_id = ? AND execution_role = ?').get(runId, executionRole)) };
    });
  }

  getCoordinatorBrokerVerifications(input) {
    const source = assertPlainObject(input, 'coordinator broker verification selector');
    const runId = this._workflowRunId(source.runId);
    return this._read(db => db.prepare(`SELECT * FROM coordinator_broker_verifications
      WHERE run_id = ? ORDER BY CASE execution_role WHEN 'baseline' THEN 0 ELSE 1 END`).all(runId).map(row => this._workflowVerificationRow(row)));
  }

  completeCoordinatorWorkflowAcceptance(input) {
    const source = assertPlainObject(input, 'coordinator workflow acceptance');
    assertOnlyKeys(source, new Set(['runId', 'handle', 'missionId', 'missionHash', 'ownerRevision', 'acceptance', 'event', 'outbox', 'result']), 'coordinator workflow acceptance', 'COORDINATOR_WORKFLOW_INVALID');
    const runId = this._workflowRunId(source.runId);
    const claim = this._validateTaskHandle(source.handle);
    const missionId = this._workflowIdentifier(source.missionId, 'missionId');
    const missionHash = this._workflowHash(source.missionHash, 'missionHash');
    const ownerRevision = assertInteger(source.ownerRevision, 'ownerRevision', { min: 1 });
    const acceptance = assertPlainObject(source.acceptance, 'acceptance');
    const baselineRecordHash = this._workflowHash(acceptance.baselineRecordHash, 'acceptance.baselineRecordHash');
    const candidateRecordHash = this._workflowHash(acceptance.candidateRecordHash, 'acceptance.candidateRecordHash');
    const acceptanceJson = this._workflowJson(acceptance, 'acceptance', 512 * 1024);
    const acceptanceHash = hashText(acceptanceJson);
    const event = assertPlainObject(source.event, 'event');
    const eventId = this._workflowIdentifier(event.eventId, 'event.eventId');
    const eventJson = this._workflowJson(event, 'event', 256 * 1024);
    const eventHash = hashText(eventJson);
    const outbox = assertPlainObject(source.outbox, 'outbox');
    const outboxId = this._workflowIdentifier(outbox.outboxId, 'outbox.outboxId');
    if (!outbox.event || outbox.event.eventId !== eventId || outbox.eventHash !== eventHash) {
      throw stateError('COORDINATOR_WORKFLOW_OUTBOX_MISMATCH', 'The terminal outbox must bind exactly the terminal event identifier and hash.', { runId });
    }
    if (acceptance.status !== 'ACCEPTED' || acceptance.missionId !== missionId || !equalHash(acceptance.missionHash, missionHash) ||
        !acceptance.event || acceptance.event.eventId !== eventId || !acceptance.manifest || !Array.isArray(acceptance.manifest.checks)) {
      throw stateError('COORDINATOR_WORKFLOW_ACCEPTANCE_MISMATCH', 'The terminal acceptance body is not semantically bound to its mission, manifest, and terminal event.', { runId });
    }
    const result = this._taskResult(assertPlainObject(source.result, 'result'));
    const resultJson = boundedTaskJson(result, 'result', MAX_JSON_BYTES, 'TASK_RESULT_TOO_LARGE');
    const resultHash = hashText(resultJson);
    const outcomeHash = hashInput({ disposition: 'succeeded', result });
    return this.transaction(db => {
      const now = this._now();
      const workflow = db.prepare('SELECT * FROM coordinator_workflow_missions WHERE run_id = ?').get(runId);
      const ownerMission = db.prepare('SELECT * FROM coordinator_missions WHERE run_id = ?').get(runId);
      if (!workflow || !ownerMission || workflow.task_id !== claim.taskId || workflow.mission_id !== missionId ||
          !equalHash(workflow.mission_hash, missionHash) || workflow.owner_revision !== ownerRevision || ownerMission.owner_revision !== ownerRevision) {
        throw stateError('COORDINATOR_WORKFLOW_ACCEPTANCE_STALE', 'The workflow mission or owner revision changed before acceptance could commit.', { runId });
      }
      const baseline = db.prepare("SELECT * FROM coordinator_broker_verifications WHERE run_id = ? AND execution_role = 'baseline'").get(runId);
      const candidate = db.prepare("SELECT * FROM coordinator_broker_verifications WHERE run_id = ? AND execution_role = 'candidate'").get(runId);
      if (!baseline || !candidate || !equalHash(baseline.record_hash, baselineRecordHash) || !equalHash(candidate.record_hash, candidateRecordHash) ||
          baseline.owner_revision !== ownerRevision || candidate.owner_revision !== ownerRevision) {
        throw stateError('COORDINATOR_WORKFLOW_VERIFICATION_STALE', 'Acceptance requires the exact persisted baseline and candidate broker records.', { runId });
      }
      const prior = db.prepare('SELECT * FROM coordinator_workflow_acceptances WHERE run_id = ?').get(runId);
      if (prior) {
        return this._replayCoordinatorWorkflowAcceptance(db, {
          runId,
          claim,
          expected: {
            missionId,
            missionHash,
            ownerRevision,
            baselineRecordHash,
            candidateRecordHash,
            acceptanceHash,
            resultHash,
            eventId,
            eventHash,
            outboxId
          }
        });
      }
      const current = this._currentTaskClaim(db, claim, now, ['running']);
      if (current.task.cancel_requested_at_ms !== null) {
        throw stateError('TASK_CANCEL_REQUESTED', 'Cancellation was requested before workflow acceptance could be recorded.', { taskId: claim.taskId });
      }
      const eventCollision = db.prepare('SELECT * FROM coordinator_workflow_events WHERE event_id = ?').get(eventId);
      if (eventCollision) throw stateError('COORDINATOR_WORKFLOW_EVENT_CONFLICT', 'The terminal event id is already bound to another event.', { eventId });
      const outboxCollision = db.prepare('SELECT * FROM coordinator_workflow_outbox WHERE outbox_id = ?').get(outboxId);
      if (outboxCollision) throw stateError('COORDINATOR_WORKFLOW_OUTBOX_CONFLICT', 'The terminal outbox id is already bound to another event.', { outboxId });
      const attemptChanged = db.prepare(`UPDATE task_attempts SET status = 'succeeded', updated_at_ms = ?, ended_at_ms = ?, outcome_hash = ?,
        error_code = NULL, error_message = NULL WHERE task_id = ? AND fence = ? AND status = 'running'`).run(
        now, now, outcomeHash, claim.taskId, claim.fence
      );
      if (attemptChanged.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task attempt changed before workflow acceptance could commit.', { taskId: claim.taskId, fence: claim.fence });
      const taskChanged = db.prepare(`UPDATE tasks SET status = 'succeeded', result_json = ?, result_hash = ?, error_code = NULL,
        error_message = NULL, lease_worker_label = NULL, lease_token_hash = NULL, lease_expires_at_ms = NULL,
        completed_at_ms = ?, updated_at_ms = ? WHERE id = ? AND fence = ? AND status = 'running'`).run(
        resultJson, resultHash, now, now, claim.taskId, claim.fence
      );
      if (taskChanged.changes !== 1) throw stateError('TASK_FENCE_LOST', 'The task changed before workflow acceptance could commit.', { taskId: claim.taskId, fence: claim.fence });
      db.prepare(`INSERT INTO coordinator_workflow_events(event_id, run_id, mission_id, event_hash, event_json, occurred_at_ms, created_at_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?)`).run(eventId, runId, missionId, eventHash, eventJson, now, now);
      db.prepare(`INSERT INTO coordinator_workflow_outbox(outbox_id, run_id, event_id, event_hash, event_json, status, fence,
        lease_worker_label, lease_token_hash, lease_expires_at_ms, created_at_ms, updated_at_ms, delivered_at_ms)
        VALUES(?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?, ?, NULL)`).run(outboxId, runId, eventId, eventHash, eventJson, now, now);
      db.prepare(`INSERT INTO coordinator_workflow_acceptances(run_id, task_id, mission_id, mission_hash, owner_revision,
        acceptance_json, acceptance_hash, result_hash, event_id, accepted_at_ms) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        runId, claim.taskId, missionId, missionHash, ownerRevision, acceptanceJson, acceptanceHash, resultHash, eventId, now
      );
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(claim.taskId);
      const acceptanceRow = db.prepare('SELECT * FROM coordinator_workflow_acceptances WHERE run_id = ?').get(runId);
      const eventRow = db.prepare('SELECT * FROM coordinator_workflow_events WHERE event_id = ?').get(eventId);
      const outboxRow = db.prepare('SELECT * FROM coordinator_workflow_outbox WHERE outbox_id = ?').get(outboxId);
      return {
        replayed: false,
        task: this._taskRow(task),
        acceptance: this._workflowAcceptanceRow(acceptanceRow),
        outbox: this._workflowOutboxRow(outboxRow)
      };
    });
  }

  getCoordinatorWorkflowAcceptance(input) {
    const source = assertPlainObject(input, 'coordinator workflow acceptance selector');
    const runId = this._workflowRunId(source.runId);
    return this._read(db => this._workflowAcceptanceRow(db.prepare('SELECT * FROM coordinator_workflow_acceptances WHERE run_id = ?').get(runId)));
  }

  replayCoordinatorWorkflowAcceptance(input) {
    const source = assertPlainObject(input, 'coordinator workflow acceptance replay');
    assertOnlyKeys(source, new Set(['runId', 'handle']), 'coordinator workflow acceptance replay', 'COORDINATOR_WORKFLOW_INVALID');
    const runId = this._workflowRunId(source.runId);
    const claim = this._validateTaskHandle(source.handle);
    return this.transaction(db => this._replayCoordinatorWorkflowAcceptance(db, { runId, claim }));
  }

  leaseCoordinatorWorkflowOutbox(input) {
    const source = assertPlainObject(input, 'coordinator workflow outbox lease');
    assertOnlyKeys(source, new Set(['runId', 'workerLabel', 'leaseMs']), 'coordinator workflow outbox lease', 'COORDINATOR_WORKFLOW_INVALID');
    const runId = this._workflowRunId(source.runId);
    const workerLabel = assertString(source.workerLabel, 'workerLabel', { min: 3, max: 100, pattern: /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,99}$/ });
    const leaseMs = this._leaseMs(source.leaseMs === undefined ? DEFAULT_TASK_LEASE_MS : source.leaseMs, 'leaseMs');
    return this.transaction(db => {
      const now = this._now();
      const row = db.prepare(`SELECT * FROM coordinator_workflow_outbox WHERE run_id = ?
        AND (status = 'pending' OR (status = 'leased' AND lease_expires_at_ms <= ?))
        ORDER BY created_at_ms, outbox_id LIMIT 1`).get(runId, now);
      if (!row) return null;
      const token = this._newId('workflow-outbox');
      const fence = row.fence + 1;
      const expiresAtMs = now + leaseMs;
      const changed = db.prepare(`UPDATE coordinator_workflow_outbox SET status = 'leased', fence = ?, lease_worker_label = ?, lease_token_hash = ?,
        lease_expires_at_ms = ?, updated_at_ms = ? WHERE outbox_id = ? AND fence = ?
        AND (status = 'pending' OR (status = 'leased' AND lease_expires_at_ms <= ?))`).run(
        fence, workerLabel, hashText(token), expiresAtMs, now, row.outbox_id, row.fence, now
      );
      if (changed.changes !== 1) throw stateError('COORDINATOR_OUTBOX_FENCE_LOST', 'The workflow outbox changed before it could be leased.', { outboxId: row.outbox_id });
      const leased = db.prepare('SELECT * FROM coordinator_workflow_outbox WHERE outbox_id = ?').get(row.outbox_id);
      return { outbox: this._workflowOutboxRow(leased), handle: { outboxId: row.outbox_id, workerLabel, token, fence, expiresAtMs } };
    });
  }

  deliverCoordinatorWorkflowOutbox(input) {
    const source = assertPlainObject(input, 'coordinator workflow outbox delivery');
    assertOnlyKeys(source, new Set(['handle']), 'coordinator workflow outbox delivery', 'COORDINATOR_WORKFLOW_INVALID');
    const handle = assertPlainObject(source.handle, 'handle');
    const outboxId = this._workflowIdentifier(handle.outboxId, 'handle.outboxId');
    const workerLabel = assertString(handle.workerLabel, 'handle.workerLabel', { min: 3, max: 100, pattern: /^[A-Za-z0-9][A-Za-z0-9._:@-]{2,99}$/ });
    const token = assertString(handle.token, 'handle.token', { min: 1, max: 500 });
    const fence = assertInteger(handle.fence, 'handle.fence', { min: 1 });
    return this.transaction(db => {
      const now = this._now();
      const row = db.prepare('SELECT * FROM coordinator_workflow_outbox WHERE outbox_id = ?').get(outboxId);
      if (!row) throw stateError('COORDINATOR_OUTBOX_NOT_FOUND', 'The workflow outbox item was not found.', { outboxId });
      if (row.status === 'delivered' && row.fence === fence) return { replayed: true, outbox: this._workflowOutboxRow(row) };
      if (row.status !== 'leased' || row.fence !== fence || row.lease_worker_label !== workerLabel ||
          !equalHash(row.lease_token_hash, hashText(token)) || row.lease_expires_at_ms <= now) {
        throw stateError('COORDINATOR_OUTBOX_FENCE_LOST', 'The workflow outbox lease is stale, expired, or does not own delivery.', { outboxId, fence });
      }
      const changed = db.prepare(`UPDATE coordinator_workflow_outbox SET status = 'delivered', lease_worker_label = NULL, lease_token_hash = NULL,
        lease_expires_at_ms = NULL, delivered_at_ms = ?, updated_at_ms = ? WHERE outbox_id = ? AND status = 'leased'
        AND fence = ? AND lease_worker_label = ? AND lease_token_hash = ? AND lease_expires_at_ms > ?`).run(
        now, now, outboxId, fence, workerLabel, hashText(token), now
      );
      if (changed.changes !== 1) throw stateError('COORDINATOR_OUTBOX_FENCE_LOST', 'The workflow outbox changed before delivery could commit.', { outboxId, fence });
      return { replayed: false, outbox: this._workflowOutboxRow(db.prepare('SELECT * FROM coordinator_workflow_outbox WHERE outbox_id = ?').get(outboxId)) };
    });
  }

  listTasks(options = {}) {
    const source = assertPlainObject(options, 'options');
    if (source.status !== undefined && source.statuses !== undefined) {
      throw stateError('STATE_INVALID_ARGUMENT', 'Use status or statuses, not both.', { field: 'statuses' });
    }
    const limit = assertInteger(source.limit === undefined ? 100 : source.limit, 'limit', { min: 1, max: 200 });
    const clauses = [];
    const values = [];
    if (source.queue !== undefined) { clauses.push('queue_name = ?'); values.push(this._taskIdentifier(source.queue, 'queue')); }
    if (source.type !== undefined) { clauses.push('task_type = ?'); values.push(this._taskIdentifier(source.type, 'type')); }
    if (source.status !== undefined) {
      if (!TASK_STATES.has(source.status)) throw stateError('STATE_INVALID_ARGUMENT', 'status is invalid.', { field: 'status' });
      clauses.push('status = ?'); values.push(source.status);
    }
    if (source.statuses !== undefined) {
      const statuses = source.statuses;
      if (!Array.isArray(statuses) || statuses.length < 1 || statuses.length > TASK_STATES.size
          || Array.from(statuses).some(status => !TASK_STATES.has(status))
          || new Set(statuses).size !== statuses.length) {
        throw stateError('STATE_INVALID_ARGUMENT', 'statuses must contain unique valid task states.', { field: 'statuses' });
      }
      clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
      values.push(...statuses);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    values.push(limit);
    const now = this._now();
    return this._read(db => db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at_ms DESC, id DESC LIMIT ?`).all(...values)
      .map(row => this._taskRow(row, { includePayload: false, includeCheckpoint: false, includeResult: false, includeError: false, now })));
  }

  _schedulerInput(input) {
    const source = assertPlainObject(input, 'scheduler job');
    const name = assertString(source.name, 'name', { max: 80, pattern: /^[A-Za-z0-9_.-]{1,80}$/ });
    const schedule = source.schedule;
    if (!['daily', 'hourly', 'minutes'].includes(schedule)) {
      throw stateError('STATE_INVALID_ARGUMENT', 'schedule must be daily, hourly, or minutes.', { field: 'schedule' });
    }
    const intervalMinutes = schedule === 'minutes'
      ? assertInteger(source.intervalMinutes, 'intervalMinutes', { min: 1, max: 1439 }) : null;
    if (schedule !== 'minutes' && source.intervalMinutes !== undefined && source.intervalMinutes !== null) {
      throw stateError('STATE_INVALID_ARGUMENT', 'intervalMinutes is valid only for a minutes schedule.', { field: 'intervalMinutes' });
    }
    const action = assertString(source.action, 'action', { max: 100 });
    if (!SUPPORTED_SCHEDULED_ACTIONS.includes(action)) {
      throw stateError('SCHEDULER_ACTION_UNSUPPORTED', `Scheduled action '${action}' is not supported.`, { action });
    }
    const args = source.args === undefined ? {} : assertPlainObject(source.args, 'args');
    assertNoPlaintextSchedulerSecrets(args, 'args');
    const argsJson = boundedTaskJson(args, 'scheduler args', 256 * 1024, 'SCHEDULER_ARGS_TOO_LARGE');
    const runtime = assertPlainObject(source.runtime, 'runtime');
    const nodePath = assertString(runtime.nodePath, 'runtime.nodePath', { max: 4096 });
    const runnerPath = assertString(runtime.runnerPath, 'runtime.runnerPath', { max: 4096 });
    const principalId = assertString(runtime.principalId, 'runtime.principalId', {
      max: 256, pattern: /^S-\d-(?:\d+-){1,14}\d+$/i
    });
    if (!path.isAbsolute(nodePath) || !path.isAbsolute(runnerPath)) {
      throw stateError('STATE_INVALID_ARGUMENT', 'Scheduler runtime paths must be absolute.', { field: 'runtime' });
    }
    const normalizedNodePath = path.resolve(nodePath);
    const normalizedRunnerPath = path.resolve(runnerPath);
    const maxScheduledJobs = assertInteger(source.maxScheduledJobs === undefined ? 50 : source.maxScheduledJobs,
      'maxScheduledJobs', { min: 1, max: 10000 });
    const spec = { schedule, intervalMinutes, action, args, nodePath: normalizedNodePath, runnerPath: normalizedRunnerPath, principalId };
    return {
      name, schedule, intervalMinutes, action, args, argsJson,
      argsHash: hashText(argsJson), specHash: hashInput(spec), nodePath: normalizedNodePath, runnerPath: normalizedRunnerPath,
      maxScheduledJobs, principalId
    };
  }

  _schedulerOutboxId(jobId, generation, operation) {
    return `scheduler-${operation}-${hashText(`${jobId}:${generation}`).slice(0, 48)}`;
  }

  _schedulerTaskSpec(installationId, jobId, generation, values) {
    const taskName = `\\ToolsEnabled-v2-${installationId.slice(0, 12)}-${hashText(jobId).slice(0, 16)}-g${generation}`;
    const ownershipMarker = hashInput({
      domain: 'toolsenabled.scheduler.registration.v1', installationId, jobId, generation,
      taskName, specHash: values.specHash, nodePath: values.nodePath, runnerPath: values.runnerPath, principalId: values.principalId
    });
    const spec = {
      version: 1, installationId, jobId, generation, taskName, ownershipMarker,
      nodePath: values.nodePath, runnerPath: values.runnerPath, principalId: values.principalId,
      schedule: values.schedule, intervalMinutes: values.intervalMinutes,
      action: values.action, args: values.args, desiredSpecHash: values.specHash
    };
    return { taskName, ownershipMarker, spec, specJson: canonicalJson(spec), specHash: hashInput(spec) };
  }

  _schedulerJobRow(row) {
    if (!row) return null;
    let args;
    try {
      args = parseJson(row.args_json, 'scheduler args');
      assertPlainObject(args, 'scheduler args');
      if (canonicalJson(args) !== row.args_json || !equalHash(hashText(row.args_json), row.args_hash)
        || !SUPPORTED_SCHEDULED_ACTIONS.includes(row.action)) throw new Error('job definition mismatch');
      assertNoPlaintextSchedulerSecrets(args, 'scheduler args');
    } catch (error) {
      throw stateError('SCHEDULER_JOB_CORRUPT', 'A scheduler job failed canonical integrity validation.', { jobId: row.id }, error);
    }
    return {
      jobId: row.id, name: row.name, generation: row.generation, activeGeneration: row.active_generation,
      schedule: row.schedule, intervalMinutes: row.interval_minutes,
      action: row.action, args, specHash: row.spec_hash,
      desiredState: row.desired_state, providerState: row.provider_state,
      providerError: row.provider_error_code ? { code: row.provider_error_code, message: row.provider_error_message } : null,
      createdAtMs: row.created_at_ms, createdAt: iso(row.created_at_ms),
      updatedAtMs: row.updated_at_ms, updatedAt: iso(row.updated_at_ms),
      removedAtMs: row.removed_at_ms, removedAt: row.removed_at_ms === null ? null : iso(row.removed_at_ms),
      lastRunAtMs: row.last_run_at_ms, lastRunAt: row.last_run_at_ms === null ? null : iso(row.last_run_at_ms),
      lastResult: row.last_result_json === null ? null : parseJson(row.last_result_json, 'scheduler last result')
    };
  }

  _schedulerRegistrationRow(row, expectedInstallationId = null, expectedJob = null) {
    if (!row) return null;
    let spec;
    try {
      spec = parseJson(row.spec_json, 'scheduler registration spec');
      assertPlainObject(spec, 'scheduler registration spec');
      const canonical = canonicalJson(spec);
      if (canonical !== row.spec_json || !equalHash(hashText(row.spec_json), row.spec_hash)) throw new Error('canonical hash mismatch');
      if (spec.version !== 1 || (expectedInstallationId !== null && spec.installationId !== expectedInstallationId)
        || spec.jobId !== row.job_id || spec.generation !== row.generation
        || spec.taskName !== row.task_name || spec.ownershipMarker !== row.ownership_marker
        || !/^[a-f0-9]{32}$/.test(spec.installationId || '') || !/^scheduler-job-[A-Za-z0-9-]{1,180}$/.test(spec.jobId || '')
        || !/^[a-f0-9]{64}$/.test(spec.ownershipMarker || '')) {
        throw new Error('row binding mismatch');
      }
      const expectedTaskName = `\\ToolsEnabled-v2-${spec.installationId.slice(0, 12)}-${hashText(row.job_id).slice(0, 16)}-g${row.generation}`;
      if (row.task_name !== expectedTaskName || !path.isAbsolute(spec.nodePath || '') || !path.isAbsolute(spec.runnerPath || '')
        || /["\0\r\n]/.test(spec.nodePath) || /["\0\r\n]/.test(spec.runnerPath)
        || !['daily', 'hourly', 'minutes'].includes(spec.schedule)
        || (spec.schedule === 'minutes' && (!Number.isSafeInteger(spec.intervalMinutes) || spec.intervalMinutes < 1 || spec.intervalMinutes > 1439))
        || (spec.schedule !== 'minutes' && spec.intervalMinutes !== null && spec.intervalMinutes !== undefined)) {
        throw new Error('runtime or schedule mismatch');
      }
      const principalBound = typeof spec.principalId === 'string' && /^S-\d-(?:\d+-){1,14}\d+$/i.test(spec.principalId);
      const executable = spec.action !== undefined || spec.args !== undefined || spec.desiredSpecHash !== undefined;
      const migrationDeletionOnly = ['principal-refresh', 'action-refresh'].includes(spec.migrationDeletionOnly);
      if (spec.migrationDeletionOnly !== undefined && !migrationDeletionOnly) throw new Error('invalid migration deletion marker');
      if (row.desired_state === 'present' && migrationDeletionOnly) throw new Error('executable registration has a deletion-only migration marker');
      if (row.desired_state === 'present' || executable) {
        if (!principalBound || !SUPPORTED_SCHEDULED_ACTIONS.includes(spec.action) || !spec.args
          || typeof spec.args !== 'object' || Array.isArray(spec.args) || !/^[a-f0-9]{64}$/.test(spec.desiredSpecHash || '')) {
          throw new Error('executable definition mismatch');
        }
        assertNoPlaintextSchedulerSecrets(spec.args, 'scheduler registration args');
        const desiredHash = hashInput({
          schedule: spec.schedule, intervalMinutes: spec.intervalMinutes, action: spec.action, args: spec.args,
          nodePath: path.resolve(spec.nodePath), runnerPath: path.resolve(spec.runnerPath), principalId: spec.principalId
        });
        if (!equalHash(desiredHash, spec.desiredSpecHash)) throw new Error('desired definition hash mismatch');
        const marker = hashInput({
          domain: 'toolsenabled.scheduler.registration.v1', installationId: spec.installationId,
          jobId: spec.jobId, generation: spec.generation, taskName: spec.taskName,
          specHash: spec.desiredSpecHash, nodePath: path.resolve(spec.nodePath), runnerPath: path.resolve(spec.runnerPath),
          principalId: spec.principalId
        });
        if (!equalHash(marker, spec.ownershipMarker)) throw new Error('ownership marker mismatch');
      }
      // The immutable registration is self-authenticating, but the current
      // desired generation must also be bound to the mutable job pointer. A
      // corrupt registration must not be able to select a different supported
      // action merely by recomputing all of its own hashes. Historical
      // generations intentionally remain self-contained because the job row
      // advances before an older active generation is retired.
      if (expectedJob !== null) {
        if (expectedJob.jobId !== row.job_id) throw new Error('job identity mismatch');
        const migrationRefreshRequired = row.generation === expectedJob.generation
          && expectedJob.desiredState === 'present' && row.desired_state === 'absent'
          && expectedJob.activeGeneration === null && migrationDeletionOnly && !executable;
        if (row.generation === expectedJob.generation && row.desired_state !== expectedJob.desiredState && !migrationRefreshRequired) {
          throw new Error('current registration desired state does not match job desired state');
        }
        if (row.generation !== expectedJob.generation && row.desired_state === 'present'
          && row.generation !== expectedJob.activeGeneration) {
          throw new Error('non-current registration is unexpectedly desired');
        }
        if (row.generation === expectedJob.generation && row.desired_state === 'present') {
          if (!equalHash(spec.desiredSpecHash, expectedJob.specHash)
            || spec.schedule !== expectedJob.schedule
            || (spec.intervalMinutes ?? null) !== (expectedJob.intervalMinutes ?? null)
            || spec.action !== expectedJob.action
            || canonicalJson(spec.args) !== canonicalJson(expectedJob.args)) {
            throw new Error('current desired registration does not match job definition');
          }
        }
      }
    } catch (error) {
      throw stateError('SCHEDULER_REGISTRATION_CORRUPT', 'A scheduler registration failed canonical integrity or identity validation.', {
        jobId: row.job_id, generation: row.generation
      }, error);
    }
    return {
      jobId: row.job_id, generation: row.generation, taskName: row.task_name,
      ownershipMarker: row.ownership_marker, spec, specHash: row.spec_hash,
      action: spec.action, args: spec.args,
      desiredState: row.desired_state, observedState: row.observed_state,
      error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
      observedAtMs: row.observed_at_ms, createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms
    };
  }

  _schedulerOutboxRow(row) {
    if (!row) return null;
    const expectedId = this._schedulerOutboxId(row.job_id, row.generation, row.operation);
    if (row.id !== expectedId) {
      throw stateError('SCHEDULER_OUTBOX_CORRUPT', 'A scheduler outbox row failed deterministic identity validation.', {
        outboxId: row.id, jobId: row.job_id, generation: row.generation
      });
    }
    return {
      outboxId: row.id, jobId: row.job_id, generation: row.generation, operation: row.operation,
      status: row.status, attempt: row.attempt, fence: row.fence,
      availableAtMs: row.available_at_ms, leaseExpiresAtMs: row.lease_expires_at_ms,
      error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
      createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms, completedAtMs: row.completed_at_ms
    };
  }

  _validateSchedulerOutboxIntegrity(db, jobId = null) {
    const missingCurrent = jobId === null
      ? db.prepare(`SELECT j.id, j.generation FROM scheduler_jobs j
          LEFT JOIN scheduler_registrations r ON r.job_id = j.id AND r.generation = j.generation
          WHERE r.job_id IS NULL ORDER BY j.id LIMIT 1`).get()
      : db.prepare(`SELECT j.id, j.generation FROM scheduler_jobs j
          LEFT JOIN scheduler_registrations r ON r.job_id = j.id AND r.generation = j.generation
          WHERE j.id = ? AND r.job_id IS NULL LIMIT 1`).get(jobId);
    if (missingCurrent) {
      throw stateError('SCHEDULER_REGISTRATION_CORRUPT', 'A scheduler job is missing its current desired registration.', {
        jobId: missingCurrent.id, generation: missingCurrent.generation
      });
    }
    const outboxRows = jobId === null
      ? db.prepare(`SELECT o.*, r.desired_state AS registration_desired_state
          FROM scheduler_outbox o JOIN scheduler_registrations r
            ON r.job_id = o.job_id AND r.generation = o.generation
          ORDER BY o.job_id, o.generation, o.operation`).all()
      : db.prepare(`SELECT o.*, r.desired_state AS registration_desired_state
          FROM scheduler_outbox o JOIN scheduler_registrations r
            ON r.job_id = o.job_id AND r.generation = o.generation
          WHERE o.job_id = ? ORDER BY o.generation, o.operation`).all(jobId);
    for (const row of outboxRows) {
      this._schedulerOutboxRow(row);
      const desiredOperation = row.registration_desired_state === 'present' ? 'ensure' : 'delete';
      if (['pending', 'retryable_failed', 'uncertain'].includes(row.status) && row.operation !== desiredOperation) {
        throw stateError('SCHEDULER_OUTBOX_CORRUPT', 'An actionable scheduler outbox operation contradicts registration desired state.', {
          outboxId: row.id, jobId: row.job_id, generation: row.generation
        });
      }
    }
    const missingDesired = jobId === null
      ? db.prepare(`SELECT r.job_id, r.generation, r.desired_state FROM scheduler_registrations r
          LEFT JOIN scheduler_outbox o ON o.job_id = r.job_id AND o.generation = r.generation
            AND o.operation = CASE r.desired_state WHEN 'present' THEN 'ensure' ELSE 'delete' END
          WHERE o.id IS NULL ORDER BY r.job_id, r.generation LIMIT 1`).get()
      : db.prepare(`SELECT r.job_id, r.generation, r.desired_state FROM scheduler_registrations r
          LEFT JOIN scheduler_outbox o ON o.job_id = r.job_id AND o.generation = r.generation
            AND o.operation = CASE r.desired_state WHEN 'present' THEN 'ensure' ELSE 'delete' END
          WHERE r.job_id = ? AND o.id IS NULL ORDER BY r.generation LIMIT 1`).get(jobId);
    if (missingDesired) {
      throw stateError('SCHEDULER_OUTBOX_CORRUPT', 'A scheduler registration is missing its desired operation outbox row.', {
        jobId: missingDesired.job_id, generation: missingDesired.generation, desiredState: missingDesired.desired_state
      });
    }
    return true;
  }

  _refreshSchedulerProviderState(db, jobId, now) {
    const job = db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(jobId);
    if (!job) return null;
    const terminal = db.prepare(`SELECT o.error_code, o.error_message FROM scheduler_outbox o
      JOIN scheduler_registrations r ON r.job_id = o.job_id AND r.generation = o.generation
      WHERE o.job_id = ? AND o.status = 'error'
        AND ((r.desired_state = 'present' AND o.operation = 'ensure')
          OR (r.desired_state = 'absent' AND o.operation = 'delete'))
      ORDER BY o.updated_at_ms DESC, o.id DESC LIMIT 1`).get(jobId);
    if (terminal) {
      db.prepare(`UPDATE scheduler_jobs SET provider_state = 'error', provider_error_code = ?, provider_error_message = ?,
        updated_at_ms = ? WHERE id = ?`).run(terminal.error_code, terminal.error_message, now, jobId);
      return 'error';
    }
    const migrationRefresh = job.desired_state === 'present' && job.active_generation === null
      ? db.prepare(`SELECT json_extract(spec_json, '$.migrationDeletionOnly') AS reason
          FROM scheduler_registrations WHERE job_id = ? AND generation = ? AND desired_state = 'absent'`).get(jobId, job.generation)
      : null;
    if (migrationRefresh && ['principal-refresh', 'action-refresh'].includes(migrationRefresh.reason)) {
      const principal = migrationRefresh.reason === 'principal-refresh';
      db.prepare(`UPDATE scheduler_jobs SET provider_state = 'error', provider_error_code = ?, provider_error_message = ?,
        updated_at_ms = ? WHERE id = ?`).run(
        principal ? 'SCHEDULER_PRINCIPAL_REFRESH_REQUIRED' : 'SCHEDULER_ACTION_REFRESH_REQUIRED',
        principal
          ? 'This migrated registration must be recreated with an exact Windows principal SID before execution.'
          : 'This migrated registration must be recreated with its canonical scheduled action before execution.',
        now, jobId
      );
      return 'error';
    }
    const uncertain = db.prepare("SELECT 1 AS found FROM scheduler_outbox WHERE job_id = ? AND status = 'uncertain' LIMIT 1").get(jobId);
    if (uncertain) {
      db.prepare(`UPDATE scheduler_jobs SET provider_state = 'uncertain', provider_error_code = 'SCHEDULER_OUTCOME_UNCERTAIN',
        provider_error_message = 'At least one scheduler registration has an unresolved provider outcome.', updated_at_ms = ? WHERE id = ?`).run(now, jobId);
      return 'uncertain';
    }
    if (job.desired_state === 'absent') {
      const remaining = db.prepare("SELECT 1 AS found FROM scheduler_registrations WHERE job_id = ? AND observed_state <> 'absent' LIMIT 1").get(jobId);
      const state = remaining ? 'removing' : 'absent';
      db.prepare(`UPDATE scheduler_jobs SET provider_state = ?, provider_error_code = NULL, provider_error_message = NULL,
        updated_at_ms = ? WHERE id = ?`).run(state, now, jobId);
      return state;
    }
    const desired = db.prepare('SELECT observed_state FROM scheduler_registrations WHERE job_id = ? AND generation = ?').get(jobId, job.generation);
    const state = job.active_generation === job.generation && desired && desired.observed_state === 'present' ? 'registered' : 'pending';
    db.prepare(`UPDATE scheduler_jobs SET provider_state = ?, provider_error_code = NULL, provider_error_message = NULL,
      updated_at_ms = ? WHERE id = ?`).run(state, now, jobId);
    return state;
  }

  schedulerInstallation() {
    return this._read(db => {
      const row = db.prepare('SELECT * FROM scheduler_installation WHERE singleton = 1').get();
      if (!row) throw stateError('STATE_SCHEMA_INVALID', 'Scheduler installation identity is missing.');
      return { installationId: row.installation_id, createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms };
    });
  }

  _insertSchedulerOutbox(db, jobId, generation, operation, availableAtMs, now) {
    const id = this._schedulerOutboxId(jobId, generation, operation);
    db.prepare(`INSERT INTO scheduler_outbox(id, job_id, generation, operation, status, available_at_ms, created_at_ms, updated_at_ms)
      VALUES(?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(job_id, generation, operation) DO NOTHING`).run(id, jobId, generation, operation, availableAtMs, now, now);
    return id;
  }

  _wakeSchedulerOutbox(db, jobId, generation, operation, availableAtMs, now, { force = false } = {}) {
    const id = this._insertSchedulerOutbox(db, jobId, generation, operation, availableAtMs, now);
    const row = db.prepare('SELECT * FROM scheduler_outbox WHERE id = ?').get(id);
    if (row.status === 'executing') return id;
    if (!force && row.status === 'succeeded') {
      const registration = db.prepare('SELECT observed_state FROM scheduler_registrations WHERE job_id = ? AND generation = ?').get(jobId, generation);
      if ((operation === 'delete' && registration && registration.observed_state === 'absent')
        || (operation === 'ensure' && registration && registration.observed_state === 'present')) return id;
    }
    db.prepare(`UPDATE scheduler_outbox SET status = 'pending', available_at_ms = ?, error_code = NULL, error_message = NULL,
      updated_at_ms = ?, completed_at_ms = NULL WHERE id = ? AND status <> 'executing'`).run(availableAtMs, now, id);
    return id;
  }

  _putSchedulerJob(db, values, now) {
    const installation = db.prepare('SELECT installation_id FROM scheduler_installation WHERE singleton = 1').get();
    if (!installation) throw stateError('STATE_SCHEMA_INVALID', 'Scheduler installation identity is missing.');
    const prior = db.prepare('SELECT * FROM scheduler_jobs WHERE name = ?').get(values.name);
    if (prior && prior.desired_state === 'present' && prior.spec_hash === values.specHash) {
      const registration = db.prepare('SELECT * FROM scheduler_registrations WHERE job_id = ? AND generation = ?').get(prior.id, prior.generation);
      const mappedPrior = this._schedulerJobRow(prior);
      // Validate the current registration before changing any retry state.
      if (!registration) {
        throw stateError('SCHEDULER_REGISTRATION_CORRUPT', 'A scheduler job is missing its current desired registration.', {
          jobId: prior.id, generation: prior.generation
        });
      }
      const mappedRegistration = this._schedulerRegistrationRow(registration, installation.installation_id, mappedPrior);
      let outbox = db.prepare("SELECT * FROM scheduler_outbox WHERE job_id = ? AND generation = ? AND operation = 'ensure'").get(prior.id, prior.generation);
      let requeued = false;
      if (!outbox) {
        const other = db.prepare('SELECT id FROM scheduler_outbox WHERE job_id = ? AND generation = ? LIMIT 1').get(prior.id, prior.generation);
        if (other) {
          throw stateError('SCHEDULER_OUTBOX_CORRUPT', 'The desired scheduler outbox row is missing while contradictory history remains.', {
            jobId: prior.id, generation: prior.generation
          });
        }
        const outboxId = this._wakeSchedulerOutbox(db, prior.id, prior.generation, 'ensure', now, now);
        outbox = db.prepare('SELECT * FROM scheduler_outbox WHERE id = ?').get(outboxId);
        db.prepare(`UPDATE scheduler_jobs SET provider_state = 'pending', provider_error_code = NULL,
          provider_error_message = NULL, updated_at_ms = ? WHERE id = ?`).run(now, prior.id);
        requeued = true;
      } else if (outbox.status === 'error') {
        db.prepare(`UPDATE scheduler_outbox SET status = 'pending', available_at_ms = ?, error_code = NULL, error_message = NULL,
          updated_at_ms = ?, completed_at_ms = NULL WHERE id = ? AND status = 'error'`).run(now, now, outbox.id);
        db.prepare(`UPDATE scheduler_jobs SET provider_state = 'pending', provider_error_code = NULL, provider_error_message = NULL,
          updated_at_ms = ? WHERE id = ?`).run(now, prior.id);
        outbox = db.prepare('SELECT * FROM scheduler_outbox WHERE id = ?').get(outbox.id);
        requeued = true;
      }
      return {
        replayed: true, requeued,
        job: this._schedulerJobRow(db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(prior.id)),
        registration: mappedRegistration, outbox: this._schedulerOutboxRow(outbox)
      };
    }
    if (!prior || prior.desired_state !== 'present') {
      const active = db.prepare("SELECT COUNT(*) AS count FROM scheduler_jobs WHERE desired_state = 'present'").get().count;
      if (active >= values.maxScheduledJobs) {
        throw stateError('SCHEDULER_JOB_LIMIT_REACHED', 'The transactional scheduled-job limit has been reached.', {
          activeJobs: active, maxScheduledJobs: values.maxScheduledJobs
        });
      }
    }
    const jobId = prior ? prior.id : this._newId('scheduler-job');
    const generation = prior ? prior.generation + 1 : 1;
    const registration = this._schedulerTaskSpec(installation.installation_id, jobId, generation, values);
    if (prior) {
      if (prior.active_generation === null) {
        db.prepare(`UPDATE scheduler_registrations SET desired_state = 'absent', updated_at_ms = ?
          WHERE job_id = ?`).run(now, jobId);
      } else {
        db.prepare(`UPDATE scheduler_registrations SET desired_state = CASE WHEN generation = ? THEN 'present' ELSE 'absent' END,
          updated_at_ms = ? WHERE job_id = ?`).run(prior.active_generation, now, jobId);
      }
      db.prepare(`UPDATE scheduler_outbox SET status = 'superseded', completed_at_ms = ?, updated_at_ms = ?,
        error_code = NULL, error_message = NULL WHERE job_id = ? AND generation <> COALESCE(?, -1) AND operation = 'ensure'
        AND status IN ('pending','retryable_failed','uncertain','error')`).run(now, now, jobId, prior.active_generation);
      const obsolete = db.prepare('SELECT generation FROM scheduler_registrations WHERE job_id = ? AND generation <> COALESCE(?, -1)').all(jobId, prior.active_generation);
      for (const item of obsolete) this._wakeSchedulerOutbox(db, jobId, item.generation, 'delete', now, now);
      db.prepare(`UPDATE scheduler_jobs SET generation = ?, schedule = ?, interval_minutes = ?, action = ?, args_json = ?,
        args_hash = ?, spec_hash = ?, desired_state = 'present', provider_state = 'pending', provider_error_code = NULL,
        provider_error_message = NULL, updated_at_ms = ?, removed_at_ms = NULL WHERE id = ?`).run(
        generation, values.schedule, values.intervalMinutes, values.action, values.argsJson,
        values.argsHash, values.specHash, now, jobId
      );
    } else {
      db.prepare(`INSERT INTO scheduler_jobs(id, name, generation, active_generation, schedule, interval_minutes, action, args_json, args_hash,
        spec_hash, desired_state, provider_state, created_at_ms, updated_at_ms)
        VALUES(?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'present', 'pending', ?, ?)`).run(
        jobId, values.name, generation, values.schedule, values.intervalMinutes, values.action,
        values.argsJson, values.argsHash, values.specHash, now, now
      );
    }
    db.prepare(`INSERT INTO scheduler_registrations(job_id, generation, task_name, ownership_marker, spec_json, spec_hash,
      desired_state, observed_state, created_at_ms, updated_at_ms)
      VALUES(?, ?, ?, ?, ?, ?, 'present', 'unknown', ?, ?)`).run(
      jobId, generation, registration.taskName, registration.ownershipMarker, registration.specJson, registration.specHash, now, now
    );
    const outboxId = this._insertSchedulerOutbox(db, jobId, generation, 'ensure', now, now);
    const mappedJob = this._schedulerJobRow(db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(jobId));
    return {
      replayed: false,
      job: mappedJob,
      registration: this._schedulerRegistrationRow(db.prepare('SELECT * FROM scheduler_registrations WHERE job_id = ? AND generation = ?').get(jobId, generation), installation.installation_id, mappedJob),
      outbox: this._schedulerOutboxRow(db.prepare('SELECT * FROM scheduler_outbox WHERE id = ?').get(outboxId))
    };
  }

  putSchedulerJob(input) {
    const values = this._schedulerInput(input);
    return this.transaction(db => this._putSchedulerJob(db, values, this._now()));
  }

  removeSchedulerJob(input) {
    const source = assertPlainObject(input, 'scheduler removal');
    const name = assertString(source.name, 'name', { max: 80, pattern: /^[A-Za-z0-9_.-]{1,80}$/ });
    return this.transaction(db => {
      const now = this._now();
      let job = db.prepare('SELECT * FROM scheduler_jobs WHERE name = ?').get(name);
      if (!job) return { removed: false, replayed: true, job: null, registration: null, outbox: null };
      const installationId = db.prepare('SELECT installation_id FROM scheduler_installation WHERE singleton = 1').get().installation_id;
      const mappedJobBeforeRemoval = this._schedulerJobRow(job);
      const registrationsBeforeRemoval = db.prepare('SELECT * FROM scheduler_registrations WHERE job_id = ? ORDER BY generation').all(job.id);
      for (const item of registrationsBeforeRemoval) {
        this._schedulerRegistrationRow(item, installationId, mappedJobBeforeRemoval);
      }
      const replayed = job.desired_state === 'absent';
      db.prepare(`UPDATE scheduler_jobs SET desired_state = 'absent', active_generation = NULL, provider_state = CASE
          WHEN NOT EXISTS(SELECT 1 FROM scheduler_registrations WHERE job_id = ? AND observed_state <> 'absent') THEN 'absent'
          ELSE 'removing' END,
        provider_error_code = NULL, provider_error_message = NULL, removed_at_ms = COALESCE(removed_at_ms, ?), updated_at_ms = ? WHERE id = ?`).run(job.id, now, now, job.id);
      db.prepare(`UPDATE scheduler_registrations SET desired_state = 'absent', updated_at_ms = ? WHERE job_id = ?`).run(now, job.id);
      db.prepare(`UPDATE scheduler_outbox SET status = 'superseded', completed_at_ms = ?, updated_at_ms = ?, error_code = NULL,
        error_message = NULL WHERE job_id = ? AND operation = 'ensure'
        AND status IN ('pending','retryable_failed','uncertain','error')`).run(now, now, job.id);
      const registrations = db.prepare('SELECT * FROM scheduler_registrations WHERE job_id = ? ORDER BY generation').all(job.id);
      let currentOutboxId = null;
      for (const item of registrations) {
        const outboxId = this._insertSchedulerOutbox(db, job.id, item.generation, 'delete', now, now);
        const outbox = db.prepare('SELECT * FROM scheduler_outbox WHERE id = ?').get(outboxId);
        if (outbox.status !== 'executing' && !(outbox.status === 'succeeded' && item.observed_state === 'absent')) {
          db.prepare(`UPDATE scheduler_outbox SET status = 'pending', available_at_ms = ?, error_code = NULL, error_message = NULL,
            updated_at_ms = ?, completed_at_ms = NULL WHERE id = ?`).run(now, now, outboxId);
        }
        if (item.generation === job.generation) currentOutboxId = outboxId;
      }
      job = db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(job.id);
      const mappedJob = this._schedulerJobRow(job);
      return {
        removed: true, replayed, job: mappedJob,
        registration: this._schedulerRegistrationRow(db.prepare('SELECT * FROM scheduler_registrations WHERE job_id = ? AND generation = ?').get(job.id, job.generation), installationId, mappedJob),
        outbox: this._schedulerOutboxRow(db.prepare('SELECT * FROM scheduler_outbox WHERE id = ?').get(currentOutboxId))
      };
    });
  }

  requeueSchedulerOutbox(input) {
    const source = assertPlainObject(input, 'scheduler requeue');
    const outboxId = assertString(source.outboxId, 'outboxId', { max: 300 });
    const delayMs = assertInteger(source.delayMs === undefined ? 0 : source.delayMs, 'delayMs', { min: 0, max: 60 * 60 * 1000 });
    return this.transaction(db => {
      const now = this._now();
      const row = db.prepare('SELECT * FROM scheduler_outbox WHERE id = ?').get(outboxId);
      if (!row) throw stateError('SCHEDULER_OUTBOX_NOT_FOUND', 'The scheduler outbox item was not found.', { outboxId });
      if (row.status !== 'error') {
        return { replayed: true, outbox: this._schedulerOutboxRow(row) };
      }
      const registration = db.prepare('SELECT desired_state FROM scheduler_registrations WHERE job_id = ? AND generation = ?').get(row.job_id, row.generation);
      const desiredOperation = registration && registration.desired_state === 'present' ? 'ensure' : 'delete';
      if (!registration || row.operation !== desiredOperation) {
        db.prepare(`UPDATE scheduler_outbox SET status = 'superseded', completed_at_ms = ?, updated_at_ms = ?,
          error_code = NULL, error_message = NULL WHERE id = ? AND status = 'error'`).run(now, now, outboxId);
        this._refreshSchedulerProviderState(db, row.job_id, now);
        return {
          replayed: false, superseded: true,
          outbox: this._schedulerOutboxRow(db.prepare('SELECT * FROM scheduler_outbox WHERE id = ?').get(outboxId))
        };
      }
      db.prepare(`UPDATE scheduler_outbox SET status = 'pending', available_at_ms = ?, error_code = NULL, error_message = NULL,
        updated_at_ms = ?, completed_at_ms = NULL WHERE id = ? AND status = 'error'`).run(now + delayMs, now, outboxId);
      const job = db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(row.job_id);
      if (job && job.generation === row.generation) {
        db.prepare(`UPDATE scheduler_jobs SET provider_state = ?, provider_error_code = NULL, provider_error_message = NULL,
          updated_at_ms = ? WHERE id = ?`).run(row.operation === 'ensure' ? 'pending' : 'removing', now, row.job_id);
      }
      this._refreshSchedulerProviderState(db, row.job_id, now);
      return { replayed: false, outbox: this._schedulerOutboxRow(db.prepare('SELECT * FROM scheduler_outbox WHERE id = ?').get(outboxId)) };
    });
  }

  getSchedulerJob(input) {
    const source = assertPlainObject(input, 'scheduler selector');
    if (source.name === undefined && source.jobId === undefined) throw stateError('STATE_INVALID_ARGUMENT', 'Select a scheduler job by name or jobId.');
    return this._read(db => {
      const installationId = db.prepare('SELECT installation_id FROM scheduler_installation WHERE singleton = 1').get().installation_id;
      const row = source.jobId !== undefined
        ? db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(assertString(source.jobId, 'jobId', { max: 200 }))
        : db.prepare('SELECT * FROM scheduler_jobs WHERE name = ?').get(assertString(source.name, 'name', { max: 80 }));
      if (!row) return null;
      const registration = db.prepare('SELECT * FROM scheduler_registrations WHERE job_id = ? AND generation = ?').get(row.id, row.generation);
      const registrations = db.prepare('SELECT * FROM scheduler_registrations WHERE job_id = ? ORDER BY generation').all(row.id);
      const outbox = db.prepare('SELECT * FROM scheduler_outbox WHERE job_id = ? ORDER BY generation, created_at_ms, id').all(row.id);
      const mappedJob = this._schedulerJobRow(row);
      return {
        ...mappedJob, registration: this._schedulerRegistrationRow(registration, installationId, mappedJob),
        registrations: registrations.map(item => this._schedulerRegistrationRow(item, installationId, mappedJob)),
        outbox: outbox.map(item => this._schedulerOutboxRow(item))
      };
    });
  }

  listSchedulerJobs(options = {}) {
    const source = assertPlainObject(options, 'scheduler list options');
    const includeRemoved = source.includeRemoved === true;
    const limit = assertInteger(source.limit === undefined ? 100 : source.limit, 'limit', { min: 1, max: 500 });
    return this._read(db => {
      const installationId = db.prepare('SELECT installation_id FROM scheduler_installation WHERE singleton = 1').get().installation_id;
      return db.prepare(`SELECT * FROM scheduler_jobs ${includeRemoved ? '' : "WHERE desired_state = 'present'"}
      ORDER BY name LIMIT ?`).all(limit).map(row => {
      const registration = db.prepare('SELECT * FROM scheduler_registrations WHERE job_id = ? AND generation = ?').get(row.id, row.generation);
      const mappedJob = this._schedulerJobRow(row);
      return { ...mappedJob, registration: this._schedulerRegistrationRow(registration, installationId, mappedJob) };
    });
    });
  }

  listSchedulerOutbox(options = {}) {
    const source = assertPlainObject(options, 'scheduler outbox list options');
    const jobId = source.jobId === undefined ? null : assertString(source.jobId, 'jobId', { max: 200 });
    const limit = assertInteger(source.limit === undefined ? 100 : source.limit, 'limit', { min: 1, max: 500 });
    let statuses = null;
    if (source.statuses !== undefined) {
      if (!Array.isArray(source.statuses) || source.statuses.length < 1 || source.statuses.length > SCHEDULER_OUTBOX_STATES.size) {
        throw stateError('STATE_INVALID_ARGUMENT', 'statuses must be a non-empty bounded array.', { field: 'statuses' });
      }
      statuses = Array.from(new Set(source.statuses.map((status, index) => {
        if (typeof status !== 'string' || !SCHEDULER_OUTBOX_STATES.has(status)) {
          throw stateError('STATE_INVALID_ARGUMENT', `statuses[${index}] is invalid.`, { field: `statuses[${index}]` });
        }
        return status;
      })));
    }
    return this._read(db => {
      const clauses = [];
      const parameters = [];
      if (jobId !== null) { clauses.push('o.job_id = ?'); parameters.push(jobId); }
      if (statuses) {
        clauses.push(`o.status IN (${statuses.map(() => '?').join(',')})`);
        parameters.push(...statuses);
      }
      parameters.push(limit);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return db.prepare(`SELECT o.*, r.task_name, r.ownership_marker, r.desired_state AS registration_desired_state,
        r.observed_state, j.name AS job_name, j.desired_state AS job_desired_state, j.active_generation
        FROM scheduler_outbox o
        JOIN scheduler_registrations r ON r.job_id = o.job_id AND r.generation = o.generation
        JOIN scheduler_jobs j ON j.id = o.job_id
        ${where} ORDER BY o.updated_at_ms, o.id LIMIT ?`).all(...parameters).map(row => ({
          ...this._schedulerOutboxRow(row), taskName: row.task_name, ownershipMarker: row.ownership_marker,
          registrationDesiredState: row.registration_desired_state, observedState: row.observed_state,
          jobName: row.job_name, jobDesiredState: row.job_desired_state, activeGeneration: row.active_generation
        }));
    });
  }

  _validateSchedulerHandle(handle) {
    const source = assertPlainObject(handle, 'scheduler handle');
    return {
      outboxId: assertString(source.outboxId, 'outboxId', { max: 300 }),
      fence: assertInteger(source.fence, 'fence', { min: 1 }),
      attempt: assertInteger(source.attempt, 'attempt', { min: 1 }),
      ownerId: assertString(source.ownerId, 'ownerId', { max: 200 }),
      claimToken: assertString(source.claimToken, 'claimToken', { max: 500 })
    };
  }

  claimSchedulerOutbox(options = {}) {
    const source = assertPlainObject(options, 'scheduler claim options');
    const ownerId = source.ownerId === undefined ? this.ownerId : assertString(source.ownerId, 'ownerId', { max: 200 });
    const leaseMs = assertInteger(source.leaseMs === undefined ? 60_000 : source.leaseMs, 'leaseMs', { min: 1000, max: 15 * 60 * 1000 });
    const jobId = source.jobId === undefined ? null : assertString(source.jobId, 'jobId', { max: 200 });
    return this.transaction(db => {
      const now = this._now();
      this._validateSchedulerOutboxIntegrity(db, jobId);
      const expired = db.prepare("SELECT * FROM scheduler_outbox WHERE status = 'executing' AND lease_expires_at_ms <= ? ORDER BY id").all(now);
      for (const row of expired) {
        this._schedulerOutboxRow(row);
        const registration = db.prepare('SELECT desired_state FROM scheduler_registrations WHERE job_id = ? AND generation = ?')
          .get(row.job_id, row.generation);
        const desiredOperation = registration && registration.desired_state === 'present' ? 'ensure' : 'delete';
        if (!registration || row.operation !== desiredOperation) {
          db.prepare(`UPDATE scheduler_attempts SET status = 'superseded', ended_at_ms = ?, error_code = NULL, error_message = NULL
            WHERE outbox_id = ? AND attempt = ? AND status = 'executing'`).run(now, row.id, row.attempt);
          db.prepare(`UPDATE scheduler_outbox SET status = 'superseded', lease_owner = NULL, lease_token_hash = NULL,
            lease_expires_at_ms = NULL, completed_at_ms = ?, error_code = NULL, error_message = NULL, updated_at_ms = ?
            WHERE id = ? AND status = 'executing'`).run(now, now, row.id);
          continue;
        }
        const code = 'SCHEDULER_ATTEMPT_EXPIRED';
        const message = 'The scheduler adapter attempt expired with an unknown provider outcome.';
        db.prepare(`UPDATE scheduler_attempts SET status = 'uncertain', ended_at_ms = ?, error_code = ?, error_message = ?
          WHERE outbox_id = ? AND attempt = ? AND status = 'executing'`).run(now, code, message, row.id, row.attempt);
        db.prepare(`UPDATE scheduler_outbox SET status = 'uncertain', lease_owner = NULL, lease_token_hash = NULL,
          lease_expires_at_ms = NULL, available_at_ms = ?, error_code = ?, error_message = ?, updated_at_ms = ? WHERE id = ? AND status = 'executing'`).run(
          now, code, message, now, row.id
        );
      }
      // Provider operations for different jobs may proceed concurrently, but
      // every generation and operation for one logical job is serialized. This
      // prevents an old delete from racing a newer ensure at the OS boundary.
      const row = jobId === null
        ? db.prepare(`SELECT candidate.* FROM scheduler_outbox candidate
          WHERE candidate.status IN ('pending','retryable_failed','uncertain') AND candidate.available_at_ms <= ?
            AND NOT EXISTS(SELECT 1 FROM scheduler_outbox active
              WHERE active.job_id = candidate.job_id AND active.status = 'executing')
          ORDER BY CASE candidate.operation WHEN 'ensure' THEN 0 ELSE 1 END,
            candidate.available_at_ms, candidate.created_at_ms, candidate.id LIMIT 1`).get(now)
        : db.prepare(`SELECT candidate.* FROM scheduler_outbox candidate
          WHERE candidate.job_id = ? AND candidate.status IN ('pending','retryable_failed','uncertain')
            AND candidate.available_at_ms <= ?
            AND NOT EXISTS(SELECT 1 FROM scheduler_outbox active
              WHERE active.job_id = candidate.job_id AND active.status = 'executing')
          ORDER BY CASE candidate.operation WHEN 'ensure' THEN 0 ELSE 1 END,
            candidate.available_at_ms, candidate.created_at_ms, candidate.id LIMIT 1`).get(jobId, now);
      if (!row) return { claimed: false };
      const claimToken = crypto.randomBytes(32).toString('base64url');
      const tokenHash = hashText(claimToken);
      const fence = row.fence + 1;
      const attempt = row.attempt + 1;
      const leaseExpiresAtMs = now + leaseMs;
      const changed = db.prepare(`UPDATE scheduler_outbox SET status = 'executing', attempt = ?, fence = ?, lease_owner = ?,
        lease_token_hash = ?, lease_expires_at_ms = ?, error_code = NULL, error_message = NULL, updated_at_ms = ?
        WHERE id = ? AND status IN ('pending','retryable_failed','uncertain')`).run(
        attempt, fence, ownerId, tokenHash, leaseExpiresAtMs, now, row.id
      );
      if (changed.changes !== 1) throw stateError('SCHEDULER_OUTBOX_RACE', 'The scheduler outbox item changed before it could be claimed.', { outboxId: row.id });
      db.prepare(`INSERT INTO scheduler_attempts(outbox_id, attempt, fence, owner_id, token_hash, operation, status, started_at_ms)
        VALUES(?, ?, ?, ?, ?, ?, 'executing', ?)`).run(row.id, attempt, fence, ownerId, tokenHash, row.operation, now);
      const registration = db.prepare('SELECT * FROM scheduler_registrations WHERE job_id = ? AND generation = ?').get(row.job_id, row.generation);
      const job = db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(row.job_id);
      const installationId = db.prepare('SELECT installation_id FROM scheduler_installation WHERE singleton = 1').get().installation_id;
      const mappedJob = this._schedulerJobRow(job);
      const mappedRegistration = this._schedulerRegistrationRow(registration, installationId, mappedJob);
      return {
        claimed: true,
        handle: { outboxId: row.id, fence, attempt, ownerId, claimToken },
        leaseExpiresAtMs,
        work: {
          outbox: this._schedulerOutboxRow(db.prepare('SELECT * FROM scheduler_outbox WHERE id = ?').get(row.id)),
          job: mappedJob, registration: mappedRegistration
        }
      };
    });
  }

  completeSchedulerOutbox(handle, options = {}) {
    const claim = this._validateSchedulerHandle(handle);
    const source = assertPlainObject(options, 'scheduler outcome');
    const disposition = source.disposition;
    if (!['succeeded', 'retry', 'uncertain', 'error', 'superseded'].includes(disposition)) {
      throw stateError('STATE_INVALID_ARGUMENT', 'Scheduler disposition is invalid.', { field: 'disposition' });
    }
    const observation = source.observation === undefined ? {} : assertPlainObject(source.observation, 'observation');
    assertNoPlaintextSchedulerSecrets(observation, 'observation');
    const observationJson = boundedTaskJson(observation, 'scheduler observation', 256 * 1024, 'SCHEDULER_OBSERVATION_TOO_LARGE');
    const errorCode = disposition === 'succeeded' || disposition === 'superseded' ? null
      : assertString(source.code, 'code', { max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/ });
    const errorMessage = disposition === 'succeeded' || disposition === 'superseded' ? null
      : assertString(source.message === undefined ? '' : source.message, 'message', { min: 1, max: 1000 });
    const retryDelayMs = source.retryDelayMs === undefined ? 1000 : assertInteger(source.retryDelayMs, 'retryDelayMs', { min: 0, max: 60 * 60 * 1000 });
    return this.transaction(db => {
      const now = this._now();
      const row = db.prepare('SELECT * FROM scheduler_outbox WHERE id = ?').get(claim.outboxId);
      if (!row || row.status !== 'executing' || row.fence !== claim.fence || row.attempt !== claim.attempt
        || row.lease_owner !== claim.ownerId || !equalHash(row.lease_token_hash, hashText(claim.claimToken))) {
        throw stateError('SCHEDULER_OUTBOX_FENCE_LOST', 'The scheduler outbox claim is no longer current.', { outboxId: claim.outboxId, fence: claim.fence });
      }
      const registration = db.prepare('SELECT * FROM scheduler_registrations WHERE job_id = ? AND generation = ?').get(row.job_id, row.generation);
      const desiredOperation = registration && registration.desired_state === 'present' ? 'ensure' : 'delete';
      const staleOperation = !registration || row.operation !== desiredOperation;
      const finalStatus = staleOperation ? 'superseded' : (disposition === 'retry' ? 'retryable_failed' : disposition);
      const completedAtMs = ['succeeded', 'error', 'superseded'].includes(finalStatus) ? now : null;
      const finalErrorCode = staleOperation ? null : errorCode;
      const finalErrorMessage = staleOperation ? null : errorMessage;
      db.prepare(`UPDATE scheduler_attempts SET status = ?, ended_at_ms = ?, observation_json = ?, observation_hash = ?,
        error_code = ?, error_message = ? WHERE outbox_id = ? AND attempt = ? AND status = 'executing'`).run(
        finalStatus, now, observationJson, hashText(observationJson), finalErrorCode, finalErrorMessage, row.id, row.attempt
      );
      db.prepare(`UPDATE scheduler_outbox SET status = ?, lease_owner = NULL, lease_token_hash = NULL, lease_expires_at_ms = NULL,
        available_at_ms = ?, error_code = ?, error_message = ?, updated_at_ms = ?, completed_at_ms = ? WHERE id = ? AND fence = ?`).run(
        finalStatus, now + retryDelayMs, finalErrorCode, finalErrorMessage, now, completedAtMs, row.id, row.fence
      );
      const job = db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(row.job_id);
      const current = job && job.generation === row.generation;
      if (!staleOperation && disposition === 'succeeded') {
        if (row.operation === 'ensure') {
          db.prepare(`UPDATE scheduler_registrations SET observed_state = 'present', error_code = NULL, error_message = NULL,
            observed_at_ms = ?, updated_at_ms = ? WHERE job_id = ? AND generation = ?`).run(now, now, row.job_id, row.generation);
          if (current && job.desired_state === 'present') {
            db.prepare(`UPDATE scheduler_jobs SET active_generation = ?, provider_state = 'registered', provider_error_code = NULL,
              provider_error_message = NULL, updated_at_ms = ? WHERE id = ?`).run(row.generation, now, row.job_id);
            db.prepare(`UPDATE scheduler_registrations SET desired_state = CASE WHEN generation = ? THEN 'present' ELSE 'absent' END,
              updated_at_ms = ? WHERE job_id = ?`).run(row.generation, now, row.job_id);
            db.prepare(`UPDATE scheduler_outbox SET status = 'superseded', completed_at_ms = ?, updated_at_ms = ?,
              error_code = NULL, error_message = NULL WHERE job_id = ? AND generation <> ? AND operation = 'ensure'
              AND status IN ('pending','retryable_failed','uncertain','error')`).run(now, now, row.job_id, row.generation);
            const retired = db.prepare('SELECT generation FROM scheduler_registrations WHERE job_id = ? AND generation <> ?').all(row.job_id, row.generation);
            for (const item of retired) this._wakeSchedulerOutbox(db, row.job_id, item.generation, 'delete', now, now);
          } else {
            db.prepare(`UPDATE scheduler_registrations SET desired_state = 'absent', updated_at_ms = ? WHERE job_id = ? AND generation = ?`).run(now, row.job_id, row.generation);
            this._wakeSchedulerOutbox(db, row.job_id, row.generation, 'delete', now, now, { force: true });
          }
        } else {
          db.prepare(`UPDATE scheduler_registrations SET observed_state = 'absent', error_code = NULL, error_message = NULL,
            observed_at_ms = ?, updated_at_ms = ? WHERE job_id = ? AND generation = ?`).run(now, now, row.job_id, row.generation);
          if (job && job.desired_state === 'absent') {
            const remaining = db.prepare(`SELECT COUNT(*) AS count FROM scheduler_registrations
              WHERE job_id = ? AND observed_state <> 'absent'`).get(row.job_id).count;
            db.prepare(`UPDATE scheduler_jobs SET provider_state = ?, provider_error_code = NULL,
              provider_error_message = NULL, updated_at_ms = ? WHERE id = ?`).run(remaining === 0 ? 'absent' : 'removing', now, row.job_id);
          }
        }
      } else if (!staleOperation && (disposition === 'retry' || disposition === 'uncertain' || disposition === 'error')) {
        const observedState = disposition === 'uncertain' ? 'uncertain' : 'error';
        db.prepare(`UPDATE scheduler_registrations SET observed_state = ?, error_code = ?, error_message = ?, observed_at_ms = ?,
          updated_at_ms = ? WHERE job_id = ? AND generation = ?`).run(observedState, errorCode, errorMessage, now, now, row.job_id, row.generation);
        if (current) db.prepare(`UPDATE scheduler_jobs SET provider_state = ?, provider_error_code = ?, provider_error_message = ?,
          updated_at_ms = ? WHERE id = ?`).run(disposition === 'uncertain' ? 'uncertain' : 'error', errorCode, errorMessage, now, row.job_id);
      }
      this._refreshSchedulerProviderState(db, row.job_id, now);
      const installationId = db.prepare('SELECT installation_id FROM scheduler_installation WHERE singleton = 1').get().installation_id;
      const mappedJob = this._schedulerJobRow(db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(row.job_id));
      return {
        replayed: false,
        outbox: this._schedulerOutboxRow(db.prepare('SELECT * FROM scheduler_outbox WHERE id = ?').get(row.id)),
        job: mappedJob,
        registration: this._schedulerRegistrationRow(
          db.prepare('SELECT * FROM scheduler_registrations WHERE job_id = ? AND generation = ?').get(row.job_id, row.generation),
          installationId, mappedJob
        )
      };
    });
  }

  _schedulerExecutionSelector(input) {
    const source = assertPlainObject(input, 'scheduler execution selector');
    return {
      installationId: assertString(source.installationId, 'installationId', { max: 64, pattern: /^[a-f0-9]{32}$/ }),
      jobId: assertString(source.jobId, 'jobId', { max: 200 }),
      generation: assertInteger(source.generation, 'generation', { min: 1 }),
      ownershipMarker: assertString(source.ownershipMarker, 'ownershipMarker', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ })
    };
  }

  _schedulerExecutionFromDb(db, selector) {
    const installation = db.prepare('SELECT installation_id FROM scheduler_installation WHERE singleton = 1').get();
    if (!installation || installation.installation_id !== selector.installationId) {
      throw stateError('SCHEDULER_INSTALLATION_MISMATCH', 'The scheduled invocation belongs to another installation.');
    }
    const job = db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(selector.jobId);
    const registration = db.prepare('SELECT * FROM scheduler_registrations WHERE job_id = ? AND generation = ?').get(selector.jobId, selector.generation);
    if (!job || job.active_generation !== selector.generation || job.desired_state !== 'present'
      || !registration || registration.ownership_marker !== selector.ownershipMarker
      || registration.desired_state !== 'present' || registration.observed_state !== 'present') {
      throw stateError('SCHEDULER_STALE_INVOCATION', 'The scheduled invocation is stale or inactive.', {
        jobId: selector.jobId, generation: selector.generation
      });
    }
    const mappedJob = this._schedulerJobRow(job);
    const mappedRegistration = this._schedulerRegistrationRow(registration, selector.installationId, mappedJob);
    return {
      job: mappedJob, registration: mappedRegistration,
      action: mappedRegistration.action, args: mappedRegistration.args
    };
  }

  getSchedulerExecution(input) {
    const selector = this._schedulerExecutionSelector(input);
    return this._read(db => this._schedulerExecutionFromDb(db, selector));
  }

  startSchedulerRun(input) {
    const selector = this._schedulerExecutionSelector(input);
    return this.transaction(db => {
      // Validate the exact active generation while holding the same IMMEDIATE
      // transaction that creates the run, so remove/update cannot interleave.
      const execution = this._schedulerExecutionFromDb(db, selector);
      const now = this._now();
      const activeRun = db.prepare("SELECT id, generation, started_at_ms FROM scheduler_runs WHERE job_id = ? AND status = 'running' LIMIT 1").get(selector.jobId);
      if (activeRun) {
        throw stateError('SCHEDULER_RUN_OVERLAP', 'Another generation of this scheduler job is already running.', {
          jobId: selector.jobId, activeRunId: activeRun.id, activeGeneration: activeRun.generation, startedAtMs: activeRun.started_at_ms
        });
      }
      const id = this._newId('scheduler-run');
      db.prepare(`INSERT INTO scheduler_runs(id, job_id, generation, status, fence, started_at_ms, updated_at_ms)
        VALUES(?, ?, ?, 'running', 1, ?, ?)`).run(id, execution.job.jobId, execution.registration.generation, now, now);
      return {
        runId: id, fence: 1, job: execution.job, registration: execution.registration,
        action: execution.action, args: execution.args, startedAtMs: now
      };
    });
  }

  completeSchedulerRun(handle, options = {}) {
    const sourceHandle = assertPlainObject(handle, 'scheduler run handle');
    const runId = assertString(sourceHandle.runId, 'runId', { max: 300 });
    const fence = assertInteger(sourceHandle.fence, 'fence', { min: 1 });
    const source = assertPlainObject(options, 'scheduler run outcome');
    const status = source.status;
    if (!['succeeded', 'failed', 'uncertain', 'skipped'].includes(status)) throw stateError('STATE_INVALID_ARGUMENT', 'Scheduler run status is invalid.', { field: 'status' });
    const result = source.result === undefined ? {} : assertPlainObject(source.result, 'result');
    assertNoPlaintextSchedulerSecrets(result, 'result');
    const resultJson = status === 'succeeded' ? boundedTaskJson(result, 'scheduler result', 256 * 1024, 'SCHEDULER_RESULT_TOO_LARGE') : null;
    const code = status === 'succeeded' ? null : assertString(source.code, 'code', { max: 200 });
    const message = status === 'succeeded' ? null : assertString(source.message === undefined ? '' : source.message, 'message', { min: 1, max: 1000 });
    return this.transaction(db => {
      const now = this._now();
      const changed = db.prepare(`UPDATE scheduler_runs SET status = ?, updated_at_ms = ?, ended_at_ms = ?, result_json = ?,
        result_hash = ?, error_code = ?, error_message = ? WHERE id = ? AND fence = ? AND status = 'running'`).run(
        status, now, now, resultJson, resultJson === null ? null : hashText(resultJson), code, message, runId, fence
      );
      if (changed.changes !== 1) throw stateError('SCHEDULER_RUN_FENCE_LOST', 'The scheduler run is no longer active.', { runId, fence });
      const run = db.prepare('SELECT * FROM scheduler_runs WHERE id = ?').get(runId);
      const summary = status === 'succeeded' ? { success: true, completedAt: iso(now) } : { success: false, status, code, message, completedAt: iso(now) };
      const summaryJson = boundedTaskJson(summary, 'scheduler run summary', 256 * 1024, 'SCHEDULER_RESULT_TOO_LARGE');
      db.prepare(`UPDATE scheduler_jobs SET last_run_at_ms = ?, last_result_json = ?, last_result_hash = ?, updated_at_ms = ?
        WHERE id = ? AND active_generation = ?`).run(now, summaryJson, hashText(summaryJson), now, run.job_id, run.generation);
      return { runId, fence, status, endedAtMs: now };
    });
  }

  reapExpiredSchedulerRuns(options = {}) {
    const source = assertPlainObject(options, 'scheduler run recovery options');
    const olderThanMs = assertInteger(source.olderThanMs === undefined ? SCHEDULER_RUN_RECOVERY_MS : source.olderThanMs,
      'olderThanMs', { min: 60_000, max: 30 * 24 * 60 * 60 * 1000 });
    const limit = assertInteger(source.limit === undefined ? 100 : source.limit, 'limit', { min: 1, max: 500 });
    return this.transaction(db => {
      const now = this._now();
      const rows = db.prepare(`SELECT id, job_id, generation, fence, started_at_ms FROM scheduler_runs
        WHERE status = 'running' AND started_at_ms <= ? ORDER BY started_at_ms, id LIMIT ?`).all(Math.max(0, now - olderThanMs), limit);
      const code = 'SCHEDULER_RUN_EXPIRED';
      const message = 'The scheduler run did not record a terminal outcome before its recovery deadline; provider outcome is unknown.';
      const update = db.prepare(`UPDATE scheduler_runs SET status = 'uncertain', updated_at_ms = ?, ended_at_ms = ?,
        error_code = ?, error_message = ? WHERE id = ? AND fence = ? AND status = 'running'`);
      const reaped = [];
      for (const row of rows) {
        if (update.run(now, now, code, message, row.id, row.fence).changes === 1) {
          reaped.push({ runId: row.id, jobId: row.job_id, generation: row.generation, startedAtMs: row.started_at_ms });
        }
      }
      return { reaped: reaped.length, runs: reaped, code };
    });
  }

  _schedulerLegacyArchivePath(sourcePath, digest) {
    return `${sourcePath}.legacy-${digest.slice(0, 16)}`;
  }

  _schedulerLegacyDigest(file, { missing = false } = {}) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        if (missing) return null;
        throw stateError('SCHEDULER_LEGACY_ARCHIVE_MISSING', 'The imported scheduler source and its archive are both missing.', { path: file }, error);
      }
      throw stateError('SCHEDULER_LEGACY_UNAVAILABLE', 'The legacy scheduler state could not be inspected.', { path: file }, error);
    }
    if (!stat.isFile() || stat.size > MAX_LEGACY_BYTES) {
      throw stateError('SCHEDULER_LEGACY_INVALID', 'Legacy scheduler state must be a regular file no larger than 10 MiB.', { path: file });
    }
    const bytes = fs.readFileSync(file);
    return { bytes, text: bytes.toString('utf8'), digest: hashText(bytes) };
  }

  _archiveLegacyScheduler(sourcePath, digest) {
    const archivePath = this._schedulerLegacyArchivePath(sourcePath, digest);
    const source = this._schedulerLegacyDigest(sourcePath, { missing: true });
    const archive = this._schedulerLegacyDigest(archivePath, { missing: true });
    if (source && source.digest !== digest) {
      throw stateError('SCHEDULER_LEGACY_CHANGED', 'Legacy scheduler state changed after its durable import.', {
        path: sourcePath, importedDigest: digest, currentDigest: source.digest
      });
    }
    if (archive && archive.digest !== digest) {
      throw stateError('SCHEDULER_LEGACY_ARCHIVE_CONFLICT', 'The digest-named scheduler archive has unexpected content.', {
        archivePath, expectedDigest: digest, currentDigest: archive.digest
      });
    }
    try {
      if (!archive && source) fs.renameSync(sourcePath, archivePath);
      else if (archive && source) fs.unlinkSync(sourcePath);
      else if (!archive) {
        throw stateError('SCHEDULER_LEGACY_ARCHIVE_MISSING', 'The imported scheduler source and its archive are both missing.', {
          path: sourcePath, archivePath
        });
      }
    } catch (error) {
      if (error instanceof StateStoreError) throw error;
      throw stateError('SCHEDULER_LEGACY_ARCHIVE_PENDING', 'Scheduler state was imported, but its exact legacy archive is still pending.', {
        path: sourcePath, archivePath, digest
      }, error);
    }
    return { archivePath, digest, archived: true };
  }

  importLegacyScheduler(options = {}) {
    const source = assertPlainObject(options, 'scheduler legacy import options');
    assertOnlyKeys(source, new Set(['path', 'runtime', 'maxScheduledJobs', 'validateAction']), 'scheduler legacy import options');
    const environmentPath = typeof process.env.TOOLSENABLED_SCHEDULER_LEGACY_PATH === 'string'
      && process.env.TOOLSENABLED_SCHEDULER_LEGACY_PATH.trim()
      ? process.env.TOOLSENABLED_SCHEDULER_LEGACY_PATH.trim() : null;
    const selectedPath = source.path === undefined ? (environmentPath || rootPath('config', 'jobs.json')) : source.path;
    const resolved = path.resolve(assertString(selectedPath, 'path', { max: 4096 }));
    if (source.runtime === undefined) {
      throw stateError('SCHEDULER_RUNTIME_REQUIRED', 'Legacy scheduler import requires an explicit runtime with a canonical Windows principal SID.', { field: 'runtime' });
    }
    const runtime = assertPlainObject(source.runtime, 'runtime');
    const validateAction = source.validateAction;
    if (validateAction !== undefined && typeof validateAction !== 'function') {
      throw stateError('STATE_INVALID_ARGUMENT', 'validateAction must be a function.', { field: 'validateAction' });
    }
    const maxScheduledJobs = assertInteger(source.maxScheduledJobs === undefined ? 50 : source.maxScheduledJobs,
      'maxScheduledJobs', { min: 1, max: 10000 });
    const prior = this._read(db => db.prepare("SELECT * FROM scheduler_legacy_import WHERE source = 'jobs'").get());
    if (prior && path.resolve(prior.source_path) !== resolved) {
      throw stateError('SCHEDULER_LEGACY_SOURCE_CONFLICT', 'A different legacy scheduler source was already imported.', {
        importedPath: prior.source_path, requestedPath: resolved
      });
    }
    const file = this._schedulerLegacyDigest(resolved, { missing: true });
    if (prior) {
      if (file && file.digest !== prior.digest) {
        // Older releases tracked an empty jobs.json. A checkout can restore
        // that inert file after the real source was archived. It is not new
        // authority and must not wedge scheduler startup, but any nonempty or
        // otherwise changed source still fails closed.
        if (isEmptyLegacySchedulerTombstone(file.text)) {
          const archivePath = this._schedulerLegacyArchivePath(resolved, prior.digest);
          const archive = this._schedulerLegacyDigest(archivePath, { missing: true });
          if (!archive || archive.digest !== prior.digest) {
            throw stateError('SCHEDULER_LEGACY_ARCHIVE_MISSING', 'The imported scheduler archive is missing or invalid.', {
              path: resolved, archivePath, digest: prior.digest
            });
          }
          return {
            source: 'jobs', path: resolved, digest: prior.digest, status: 'already_imported', records: prior.records,
            details: parseJson(prior.details_json, 'scheduler legacy import details'), archivePath,
            restoredTombstoneIgnored: true,
            legacyTasks: legacySchedulerCleanupCandidates(archive.text)
          };
        }
        throw stateError('SCHEDULER_LEGACY_CHANGED', 'Legacy scheduler state changed after its durable import.', {
          path: resolved, importedDigest: prior.digest, currentDigest: file.digest
        });
      }
      const archived = this._archiveLegacyScheduler(resolved, prior.digest);
      const archivedFile = this._schedulerLegacyDigest(archived.archivePath);
      return {
        source: 'jobs', path: resolved, digest: prior.digest, status: 'already_imported', records: prior.records,
        details: parseJson(prior.details_json, 'scheduler legacy import details'), archivePath: archived.archivePath,
        legacyTasks: legacySchedulerCleanupCandidates(archivedFile.text)
      };
    }
    if (!file) return { source: 'jobs', path: resolved, status: 'missing', records: 0, legacyTasks: [] };

    let parsed;
    try { parsed = JSON.parse(file.text); }
    catch (error) {
      throw stateError('SCHEDULER_LEGACY_INVALID', 'Legacy scheduler state is not valid JSON.', { path: resolved }, error);
    }
    assertPlainObject(parsed, 'legacy scheduler state');
    assertOnlyKeys(parsed, new Set(['version', 'jobs']), 'legacy scheduler state', 'SCHEDULER_LEGACY_INVALID');
    if (parsed.version !== 1 || !Array.isArray(parsed.jobs) || parsed.jobs.length > 10000) {
      throw stateError('SCHEDULER_LEGACY_INVALID', 'Legacy scheduler state must have version 1 and at most 10,000 jobs.', { path: resolved });
    }
    const names = new Set();
    const validationNow = this._now();
    const prepared = parsed.jobs.map((raw, index) => {
      assertPlainObject(raw, `jobs[${index}]`);
      assertOnlyKeys(raw, new Set(['name', 'schedule', 'action', 'args', 'enabled', 'createdAt', 'lastRunAt', 'lastResult']),
        `jobs[${index}]`, 'SCHEDULER_LEGACY_INVALID');
      const name = assertString(raw.name, `jobs[${index}].name`, { max: 80, pattern: /^[A-Za-z0-9_.-]{1,80}$/ });
      if (names.has(name)) throw stateError('SCHEDULER_LEGACY_INVALID', 'Legacy scheduler jobs contain duplicate names.', { name });
      names.add(name);
      if (!['daily', 'hourly'].includes(raw.schedule)) {
        throw stateError('SCHEDULER_LEGACY_INVALID', `jobs[${index}].schedule must be daily or hourly.`, { index });
      }
      if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
        throw stateError('SCHEDULER_LEGACY_INVALID', `jobs[${index}].enabled must be a boolean.`, { index });
      }
      const timestamps = {};
      for (const key of ['createdAt', 'lastRunAt']) {
        if (raw[key] !== undefined && raw[key] !== null && (typeof raw[key] !== 'string' || !Number.isFinite(Date.parse(raw[key])))) {
          throw stateError('SCHEDULER_LEGACY_INVALID', `jobs[${index}].${key} must be a valid timestamp or null.`, { index, field: key });
        }
        timestamps[key] = raw[key] === undefined || raw[key] === null ? null : Date.parse(raw[key]);
      }
      const createdAtMs = timestamps.createdAt === null ? validationNow : timestamps.createdAt;
      if (createdAtMs > validationNow || (timestamps.lastRunAt !== null && (timestamps.lastRunAt < createdAtMs || timestamps.lastRunAt > validationNow))) {
        throw stateError('SCHEDULER_LEGACY_INVALID', `jobs[${index}] has inconsistent or future timestamps.`, { index });
      }
      let lastResultJson = null;
      if (raw.lastResult !== undefined && raw.lastResult !== null) {
        assertPlainObject(raw.lastResult, `jobs[${index}].lastResult`);
        assertNoPlaintextSchedulerSecrets(raw.lastResult, `jobs[${index}].lastResult`);
        lastResultJson = boundedTaskJson(raw.lastResult, `jobs[${index}].lastResult`, 256 * 1024, 'SCHEDULER_LEGACY_INVALID');
      }
      const action = normalizeLegacySchedulerAction(raw.action, `jobs[${index}].action`);
      const args = validateLegacySchedulerArgs(action, raw.args === undefined ? {} : raw.args, `jobs[${index}].args`);
      if (validateAction) validateAction(action, args);
      return {
        enabled: raw.enabled !== false,
        values: this._schedulerInput({ name, schedule: raw.schedule, action, args, runtime, maxScheduledJobs }),
        history: { createdAtMs, lastRunAtMs: timestamps.lastRunAt, lastResultJson }
      };
    });

    const imported = this.transaction(db => {
      const now = this._now();
      const raced = db.prepare("SELECT * FROM scheduler_legacy_import WHERE source = 'jobs'").get();
      if (raced) {
        if (raced.digest !== file.digest || path.resolve(raced.source_path) !== resolved) {
          throw stateError('SCHEDULER_LEGACY_CHANGED', 'Legacy scheduler import raced with different source content.', { path: resolved });
        }
        return { status: 'already_imported', records: raced.records, details: parseJson(raced.details_json, 'scheduler legacy import details') };
      }
      const current = this._schedulerLegacyDigest(resolved);
      if (current.digest !== file.digest) {
        throw stateError('SCHEDULER_LEGACY_CHANGED', 'Legacy scheduler state changed during import.', {
          path: resolved, expectedDigest: file.digest, currentDigest: current.digest
        });
      }
      let created = 0; let replayed = 0; let disabled = 0;
      for (const item of prepared) {
        if (!item.enabled) { disabled += 1; continue; }
        const existing = db.prepare('SELECT id, desired_state, spec_hash FROM scheduler_jobs WHERE name = ?').get(item.values.name);
        if (existing && (existing.desired_state !== 'present' || existing.spec_hash !== item.values.specHash)) {
          throw stateError('SCHEDULER_LEGACY_CONFLICT', 'A durable scheduler job conflicts with the legacy definition.', {
            name: item.values.name, jobId: existing.id
          });
        }
        const result = this._putSchedulerJob(db, item.values, now);
        if (result.replayed) replayed += 1;
        else {
          created += 1;
          db.prepare(`UPDATE scheduler_jobs SET created_at_ms = ?, last_run_at_ms = ?, last_result_json = ?, last_result_hash = ?
            WHERE id = ?`).run(item.history.createdAtMs, item.history.lastRunAtMs, item.history.lastResultJson,
            item.history.lastResultJson === null ? null : hashText(item.history.lastResultJson), result.job.jobId);
        }
      }
      const details = { validated: prepared.length, created, replayed, disabled };
      const detailsJson = canonicalJson(details);
      db.prepare(`INSERT INTO scheduler_legacy_import(source, source_path, digest, imported_at_ms, records, details_json)
        VALUES('jobs', ?, ?, ?, ?, ?)`).run(resolved, file.digest, now, prepared.length, detailsJson);
      return { status: 'imported', records: prepared.length, details };
    });
    const archived = this._archiveLegacyScheduler(resolved, file.digest);
    return {
      source: 'jobs', path: resolved, digest: file.digest, status: imported.status, records: imported.records,
      details: imported.details, archivePath: archived.archivePath,
      legacyTasks: legacySchedulerCleanupCandidates(file.text)
    };
  }

  checkIntegrity({ full = false } = {}) {
    if (typeof full !== 'boolean') throw stateError('STATE_INVALID_ARGUMENT', 'full must be a boolean.', { field: 'full' });
    const mode = full ? 'full' : 'quick';
    const pragma = full ? 'PRAGMA integrity_check' : 'PRAGMA quick_check';
    return this._read(db => {
      const rows = db.prepare(pragma).all();
      const result = rows.map(row => Object.values(row)[0]);
      return { ok: result.length === 1 && result[0] === 'ok', mode, result };
    });
  }

  // OPEN AND VALIDATE NOW, RATHER THAN WHENEVER SOMETHING HAPPENS TO ASK.
  //
  // The constructor is deliberately lazy -- it resolves a path and returns --
  // so _open(), and with it _migrate() and the _validateSchema() call that
  // NAMES a missing or altered STRICT table, does not run until some operation
  // needs the database. That laziness is what let the Cerberus removal take
  // this store down quietly on 2026-08-10: the product started clean, then
  // every state-backed tool failed separately with its own error, and the only
  // place that said `cerberus_correction_closures` was a nested field inside
  // system.status. Measured 2026-08-11 on a probe database with a required
  // table dropped: getStateStore() returned a usable handle in 1 ms and threw
  // nothing.
  //
  // This method exists so a startup path can pay that cost on purpose. It is
  // ~29 ms on the real 41-table database (measured, warm cache 10 ms), and it
  // throws exactly the STATE_SCHEMA_INVALID that names the offending table.
  // It returns nothing: the database handle stays private.
  ensureOpen() {
    this._open();
    return true;
  }

  health() {
    return this._read(db => {
      this._validateSchema(db);
      const rows = db.prepare('PRAGMA quick_check').all();
      const result = rows.map(row => Object.values(row)[0]);
      const integrity = { ok: result.length === 1 && result[0] === 'ok', mode: 'quick', result };
      const health = {
        ok: integrity.ok,
        path: this.file,
        schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
        applicationId: db.prepare('PRAGMA application_id').get().application_id,
        journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
        synchronous: db.prepare('PRAGMA synchronous').get().synchronous,
        foreignKeys: Boolean(db.prepare('PRAGMA foreign_keys').get().foreign_keys),
        busyTimeoutMs: db.prepare('PRAGMA busy_timeout').get().timeout,
        integrity
      };
      if (!health.ok) throw stateError('STATE_INTEGRITY_FAILED', 'The durable state database failed its integrity check.', { result: integrity.result });
      return health;
    });
  }

  _readLegacy(source, file) {
    assertString(file, `${source}Path`, { max: 4096 });
    const resolved = path.resolve(file);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch (error) {
      if (error && error.code === 'ENOENT') return { source, path: resolved, status: 'missing' };
      throw stateError('LEGACY_IMPORT_UNAVAILABLE', `Legacy ${source} state could not be inspected.`, { source, path: resolved }, error);
    }
    if (!stat.isFile() || stat.size > MAX_LEGACY_BYTES) {
      throw stateError('LEGACY_IMPORT_INVALID', `Legacy ${source} state must be a regular file no larger than 10 MiB.`, { source, path: resolved });
    }
    const raw = fs.readFileSync(resolved, 'utf8');
    const digest = hashText(raw);
    const prior = this._read(db => db.prepare('SELECT * FROM legacy_imports WHERE source = ?').get(source));
    if (prior) {
      if (prior.digest !== digest) throw stateError('LEGACY_IMPORT_CHANGED', `Legacy ${source} state changed after its one-time import.`, { source, path: resolved, importedDigest: prior.digest, currentDigest: digest });
      return { source, path: resolved, digest, status: 'already_imported', records: prior.records, details: parseJson(prior.details_json, 'legacy import details') };
    }
    let value;
    try { value = JSON.parse(raw); }
    catch (error) { throw stateError('LEGACY_IMPORT_INVALID', `Legacy ${source} state is not valid JSON.`, { source, path: resolved }, error); }
    return { source, path: resolved, digest, status: 'ready', value };
  }

  _recordLegacyImport(db, source, file, digest, records, details, now) {
    db.prepare(`INSERT INTO legacy_imports(source, source_path, digest, imported_at_ms, records, details_json)
      VALUES(?, ?, ?, ?, ?, ?)`).run(source, file, digest, now, records, boundedJson(details, 'legacy import details'));
  }

  _legacyRace(db, item) {
    const prior = db.prepare('SELECT * FROM legacy_imports WHERE source = ?').get(item.source);
    if (!prior) return null;
    if (prior.digest !== item.digest) throw stateError('LEGACY_IMPORT_CHANGED', `Legacy ${item.source} state changed during import.`, { source: item.source });
    return { source: item.source, path: item.path, digest: item.digest, status: 'already_imported', records: prior.records, details: parseJson(prior.details_json, 'legacy import details') };
  }

  _assertLegacySourceUnchanged(item) {
    let stat;
    try {
      stat = fs.statSync(item.path);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw stateError('LEGACY_IMPORT_CHANGED', `Legacy ${item.source} state disappeared during import.`, { source: item.source, path: item.path }, error);
      }
      throw stateError('LEGACY_IMPORT_UNAVAILABLE', `Legacy ${item.source} state could not be inspected during import.`, {
        source: item.source, path: item.path
      }, error);
    }
    if (!stat.isFile() || stat.size > MAX_LEGACY_BYTES) {
      throw stateError('LEGACY_IMPORT_CHANGED', `Legacy ${item.source} state changed type or size during import.`, { source: item.source, path: item.path });
    }
    const digest = hashText(fs.readFileSync(item.path, 'utf8'));
    if (digest !== item.digest) {
      throw stateError('LEGACY_IMPORT_CHANGED', `Legacy ${item.source} state changed during import.`, { source: item.source, path: item.path, expectedDigest: item.digest, currentDigest: digest });
    }
  }

  importLegacySpend(file) {
    const item = this._readLegacy('spend', file);
    if (item.status !== 'ready') return item;
    const value = assertPlainObject(item.value, 'legacy spend');
    if (value.version !== 1 || !Array.isArray(value.entries)) throw stateError('LEGACY_IMPORT_INVALID', 'Legacy spend state must have version 1 and an entries array.', { source: 'spend' });
    const seenIds = new Set();
    const seenReferences = new Set();
    const validationNow = this._now();
    const entries = value.entries.map((raw, index) => {
      assertPlainObject(raw, `entries[${index}]`);
      const hasTimestamp = raw.timestamp !== undefined && raw.timestamp !== null && raw.timestamp !== '';
      let timestampMs;
      let date;
      if (hasTimestamp) {
        timestampMs = parseLegacyTimestamp(raw.timestamp, `entries[${index}].timestamp`, validationNow);
        date = raw.date === undefined ? iso(timestampMs).slice(0, 10) : raw.date;
      } else if (raw.date !== undefined) {
        date = raw.date;
        timestampMs = Date.parse(`${date}T00:00:00.000Z`);
      } else {
        timestampMs = validationNow;
        date = iso(timestampMs).slice(0, 10);
      }
      if (!validUtcDate(date)) throw stateError('LEGACY_IMPORT_INVALID', `entries[${index}].date is invalid.`, { source: 'spend', index });
      if (hasTimestamp && date !== iso(timestampMs).slice(0, 10)) {
        throw stateError('LEGACY_IMPORT_INVALID', `entries[${index}].date does not match its UTC timestamp day.`, { source: 'spend', index });
      }
      const id = raw.id === undefined ? `legacy-spend-${item.digest.slice(0, 16)}-${index}` : assertString(raw.id, `entries[${index}].id`, { max: 500 });
      if (seenIds.has(id)) throw stateError('LEGACY_IMPORT_INVALID', 'Legacy spend entries contain duplicate ids.', { source: 'spend', id });
      seenIds.add(id);
      const amountCents = legacyUsdToCents(raw.amountUsd, `entries[${index}].amountUsd`);
      const purpose = raw.purpose === undefined ? '' : assertString(raw.purpose, `entries[${index}].purpose`, { min: 0, max: 1000 });
      const provider = raw.provider === undefined ? 'manual' : assertString(raw.provider, `entries[${index}].provider`, { max: 100 });
      const reference = raw.reference === undefined || raw.reference === '' ? null : assertString(raw.reference, `entries[${index}].reference`, { max: 500 });
      if (reference) {
        const key = `${provider}\0${reference}`;
        if (seenReferences.has(key)) throw stateError('LEGACY_IMPORT_INVALID', 'Legacy spend entries reuse a provider reference.', { source: 'spend', provider, reference });
        seenReferences.add(key);
      }
      return { id, date, timestampMs, amountCents, purpose, provider, reference };
    });
    return this.transaction(db => {
      this._assertLegacySourceUnchanged(item);
      const raced = this._legacyRace(db, item);
      if (raced) return raced;
      const importedAt = this._now();
      const insert = db.prepare(`INSERT OR IGNORE INTO spend_entries(id, spend_date, timestamp_ms, amount_cents, purpose, provider, reference)
        VALUES(?, ?, ?, ?, ?, ?, ?)`);
      const byId = db.prepare('SELECT * FROM spend_entries WHERE id = ?');
      const byReference = db.prepare('SELECT * FROM spend_entries WHERE provider = ? AND reference = ?');
      let imported = 0;
      for (const entry of entries) {
        const changed = insert.run(entry.id, entry.date, entry.timestampMs, entry.amountCents, entry.purpose, entry.provider, entry.reference).changes;
        if (changed) {
          imported += 1;
          continue;
        }
        const priorById = byId.get(entry.id);
        const priorByReference = entry.reference ? byReference.get(entry.provider, entry.reference) : null;
        const exact = priorById && priorById.id === entry.id && priorById.spend_date === entry.date
          && priorById.timestamp_ms === entry.timestampMs && priorById.amount_cents === entry.amountCents
          && priorById.purpose === entry.purpose && priorById.provider === entry.provider
          && priorById.reference === entry.reference
          && (!priorByReference || priorByReference.id === entry.id);
        if (!exact) {
          throw stateError('LEGACY_IMPORT_CONFLICT', 'A durable spend entry conflicts with the legacy record.', {
            source: 'spend', id: entry.id, provider: entry.provider, reference: entry.reference
          });
        }
      }
      const details = { validated: entries.length, imported, skipped: entries.length - imported };
      this._recordLegacyImport(db, 'spend', item.path, item.digest, entries.length, details, importedAt);
      return { source: 'spend', path: item.path, digest: item.digest, status: 'imported', records: entries.length, details };
    });
  }

  // importLegacyTelegram() WAS REMOVED 2026-08-23, WITH MIGRATION_V23.
  //
  // It imported a pre-SQLite logs/message-queue.json into telegram_updates and
  // telegram_cursor. Both tables are dropped, so the method could only ever have
  // raised "no such table" -- and there is nothing left in the product that could
  // consume an imported Telegram update even if the import succeeded. The other
  // two legacy importers (spend, instagram) are untouched; only this one had its
  // destination removed. importLegacyState() below no longer offers a `telegram`
  // key for the same reason.

  importLegacyInstagram(file) {
    const item = this._readLegacy('instagram', file);
    if (item.status !== 'ready') return item;
    const value = assertPlainObject(item.value, 'legacy Instagram');
    if (value.version !== 1 || !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
      throw stateError('LEGACY_IMPORT_INVALID', 'Legacy Instagram state must have version 1 and an entries object.', { source: 'instagram' });
    }
    const validationNow = this._now();
    const entries = Object.entries(value.entries).map(([key, raw], index) => {
      assertString(key, `entries key ${index}`, { max: 200, pattern: /^[A-Za-z0-9_.:-]+$/ });
      assertPlainObject(raw, `entries.${key}`);
      const allowed = new Set(['containerId', 'mediaId', 'status', 'completedAt']);
      const unknown = Object.keys(raw).filter(field => !allowed.has(field));
      if (unknown.length) throw stateError('LEGACY_IMPORT_INVALID', `entries.${key} contains unsupported fields.`, { source: 'instagram', key, fields: unknown });
      const containerId = assertString(raw.containerId, `entries.${key}.containerId`, { max: 500 });
      const mediaId = assertString(raw.mediaId, `entries.${key}.mediaId`, { max: 500 });
      if (raw.status !== 'published') throw stateError('LEGACY_IMPORT_INVALID', `entries.${key}.status must be published.`, { source: 'instagram', key });
      assertString(raw.completedAt, `entries.${key}.completedAt`, { max: 100 });
      const completedAtMs = parseLegacyTimestamp(raw.completedAt, `entries.${key}.completedAt`, validationNow);
      const normalized = { containerId, mediaId, status: 'published', completedAt: iso(completedAtMs) };
      const resultJson = boundedJson(normalized, `entries.${key}`);
      return { key, resultJson, completedAtMs, inputHash: hashInput({ legacyInstagramIdempotencyKey: key }), id: `legacy-instagram-${hashText(key).slice(0, 32)}` };
    });
    return this.transaction(db => {
      this._assertLegacySourceUnchanged(item);
      const raced = this._legacyRace(db, item);
      if (raced) return raced;
      const importedAt = this._now();
      const existing = db.prepare("SELECT * FROM operations WHERE operation_type = 'instagram.publish_image' AND idempotency_key = ?");
      const insert = db.prepare(`INSERT INTO operations(id, operation_type, idempotency_key, input_hash, input_verified, status, fence, attempt,
        result_json, created_at_ms, updated_at_ms, completed_at_ms) VALUES(?, 'instagram.publish_image', ?, ?, 0, 'succeeded', 1, 1, ?, ?, ?, ?)`);
      let imported = 0;
      for (const entry of entries) {
        const prior = existing.get(entry.key);
        if (prior) {
          if (prior.status !== 'succeeded' || prior.result_json !== entry.resultJson) {
            throw stateError('LEGACY_IMPORT_CONFLICT', 'A durable Instagram operation conflicts with the legacy result.', { source: 'instagram', key: entry.key });
          }
          continue;
        }
        insert.run(entry.id, entry.key, entry.inputHash, entry.resultJson, entry.completedAtMs, entry.completedAtMs, entry.completedAtMs);
        imported += 1;
      }
      const details = { validated: entries.length, imported, skipped: entries.length - imported };
      this._recordLegacyImport(db, 'instagram', item.path, item.digest, entries.length, details, importedAt);
      return { source: 'instagram', path: item.path, digest: item.digest, status: 'imported', records: entries.length, details };
    });
  }

  importLegacyState(options = {}) {
    assertPlainObject(options, 'options');
    return {
      spend: this.importLegacySpend(options.spendPath || rootPath('logs', 'spend-ledger.json')),
      instagram: this.importLegacyInstagram(options.instagramPath || rootPath('logs', 'instagram-idempotency.json'))
    };
  }

  // ---------------------------------------------------------------------
  // Research domain (MIGRATION_V21). Mechanism only: enablement policy
  // (settings gate, per-project enabled) is enforced by the provider and the
  // worker, never here. Every run is a task on the reserved 'research-runs'
  // queue; the run row is the domain projection and status is always read
  // from the joined task (the coordinator mission/task split).
  // ---------------------------------------------------------------------

  _researchId(prefix) {
    return `${prefix}-${crypto.randomBytes(18).toString('hex')}`;
  }

  _researchJson(value, field, maxBytes) {
    const json = JSON.stringify(value === undefined ? null : value, (_key, item) => {
      if (typeof item === 'number' && !Number.isFinite(item)) {
        throw stateError('STATE_INVALID_ARGUMENT', `${field} contains a non-finite number.`, { field });
      }
      return item;
    });
    if (typeof json !== 'string' || json === 'null' && value !== null) {
      throw stateError('STATE_INVALID_ARGUMENT', `${field} must be JSON-serializable.`, { field });
    }
    if (Buffer.byteLength(json, 'utf8') > maxBytes) {
      throw stateError('STATE_INVALID_ARGUMENT', `${field} exceeds ${maxBytes} serialized bytes.`, { field, maxBytes });
    }
    return json;
  }

  _researchProjectRow(row) {
    return {
      projectId: row.project_id, name: row.name, description: row.description,
      ownerScope: row.owner_scope, enabled: row.enabled === 1, status: row.status,
      createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms
    };
  }

  _researchExperimentRow(row) {
    return {
      experimentId: row.experiment_id, projectId: row.project_id, name: row.name,
      runnerKind: row.runner_kind, runnerConfig: JSON.parse(row.runner_config_json),
      configHash: row.config_hash, resultSchema: JSON.parse(row.result_schema_json),
      collector: JSON.parse(row.collector_json), maxParallel: row.max_parallel,
      mutexKey: row.mutex_key, timeoutMs: row.timeout_ms, status: row.status,
      createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms
    };
  }

  _researchRunRow(row, taskRow) {
    // The clock must be passed or _taskRow cannot decide leaseExpired, and a
    // run whose worker died stays 'running' for ever with leaseExpired:false.
    // A board showed exactly that for two and a half hours beside a stopped
    // worker (installed build, 2026-08-15) — the reclaim was working, only the
    // report was wrong. Every other reader of a task row already passes now.
    return {
      runId: row.run_id, experimentId: row.experiment_id, taskId: row.task_id,
      params: JSON.parse(row.params_json), paramsHash: row.params_hash,
      sessionRefKind: row.session_ref_kind, sessionRef: row.session_ref,
      artifactDir: row.artifact_dir, createdAtMs: row.created_at_ms,
      task: taskRow ? this._taskRow(taskRow, { now: this._now() }) : null
    };
  }

  createResearchProject(input) {
    const source = assertPlainObject(input, 'project');
    const name = assertString(source.name, 'name', { max: 120 });
    const description = source.description === undefined ? '' : assertString(source.description, 'description', { max: 2000, allowEmpty: true });
    const ownerScope = source.ownerScope === undefined ? 'owner' : assertString(source.ownerScope, 'ownerScope', { max: 80 });
    const enabled = source.enabled === true ? 1 : 0;
    return this.transaction(db => {
      const now = this._now();
      const projectId = this._researchId('rp');
      try {
        db.prepare(`INSERT INTO research_projects(project_id, name, description, owner_scope, enabled, status, created_at_ms, updated_at_ms)
          VALUES(?, ?, ?, ?, ?, 'active', ?, ?)`).run(projectId, name, description, ownerScope, enabled, now, now);
      } catch (error) {
        if (String(error && error.message).includes('UNIQUE')) {
          throw stateError('RESEARCH_PROJECT_NAME_TAKEN', 'A research project with that name already exists.', { name });
        }
        throw error;
      }
      return this._researchProjectRow(db.prepare('SELECT * FROM research_projects WHERE project_id = ?').get(projectId));
    });
  }

  updateResearchProject(input) {
    const source = assertPlainObject(input, 'project');
    const projectId = assertString(source.projectId, 'projectId', { max: 39 });
    return this.transaction(db => {
      const row = db.prepare('SELECT * FROM research_projects WHERE project_id = ?').get(projectId);
      if (!row) throw stateError('RESEARCH_PROJECT_NOT_FOUND', 'No research project has that id.', { projectId });
      const name = source.name === undefined ? row.name : assertString(source.name, 'name', { max: 120 });
      const description = source.description === undefined ? row.description : assertString(source.description, 'description', { max: 2000, allowEmpty: true });
      const enabled = source.enabled === undefined ? row.enabled : (source.enabled === true ? 1 : 0);
      const status = source.status === undefined ? row.status : source.status;
      if (!['active', 'archived'].includes(status)) {
        throw stateError('STATE_INVALID_ARGUMENT', "status must be 'active' or 'archived'.", { field: 'status' });
      }
      db.prepare('UPDATE research_projects SET name = ?, description = ?, enabled = ?, status = ?, updated_at_ms = ? WHERE project_id = ?')
        .run(name, description, enabled, status, this._now(), projectId);
      return this._researchProjectRow(db.prepare('SELECT * FROM research_projects WHERE project_id = ?').get(projectId));
    });
  }

  getResearchProject(input) {
    const source = assertPlainObject(input, 'query');
    const projectId = assertString(source.projectId, 'projectId', { max: 39 });
    return this.transaction(db => {
      const row = db.prepare('SELECT * FROM research_projects WHERE project_id = ?').get(projectId);
      return row ? this._researchProjectRow(row) : null;
    });
  }

  listResearchProjects(options = {}) {
    const source = assertPlainObject(options, 'options');
    const status = source.status === undefined ? null : source.status;
    if (status !== null && !['active', 'archived'].includes(status)) {
      throw stateError('STATE_INVALID_ARGUMENT', "status must be 'active' or 'archived'.", { field: 'status' });
    }
    return this.transaction(db => {
      const rows = status
        ? db.prepare('SELECT * FROM research_projects WHERE status = ? ORDER BY updated_at_ms DESC').all(status)
        : db.prepare('SELECT * FROM research_projects ORDER BY updated_at_ms DESC').all();
      return rows.map(row => this._researchProjectRow(row));
    });
  }

  // Runner/collector/schema configs are IMMUTABLE after create: a config
  // change is a new experiment (reproducibility discipline). config_hash
  // covers everything reproducibility depends on, so create-or-match by hash
  // is safe for the app's register-on-first-submit flow.
  createResearchExperiment(input) {
    const prepared = this._prepareResearchExperiment(input);
    return this.transaction(db => this._createPreparedResearchExperiment(db, prepared));
  }

  _prepareResearchExperiment(input) {
    const source = assertPlainObject(input, 'experiment');
    const projectId = assertString(source.projectId, 'projectId', { max: 39 });
    const name = assertString(source.name, 'name', { max: 120 });
    const runnerKind = source.runnerKind;
    if (!['agent', 'process', 'http'].includes(runnerKind)) {
      throw stateError('STATE_INVALID_ARGUMENT', "runnerKind must be 'agent', 'process' or 'http'.", { field: 'runnerKind' });
    }
    const runnerConfigJson = this._researchJson(assertPlainObject(source.runnerConfig, 'runnerConfig'), 'runnerConfig', 65536);
    validatePinnedFiles(runnerKind, source.runnerConfig);
    validateStudyProtocol(runnerKind, source.runnerConfig);
    const resultSchemaJson = this._researchJson(assertPlainObject(source.resultSchema, 'resultSchema'), 'resultSchema', 16384);
    const collectorJson = this._researchJson(assertPlainObject(source.collector, 'collector'), 'collector', 16384);
    const maxParallel = assertInteger(source.maxParallel === undefined ? 1 : source.maxParallel, 'maxParallel', { min: 1, max: 16 });
    const mutexKey = source.mutexKey === undefined || source.mutexKey === null ? null : assertString(source.mutexKey, 'mutexKey', { max: 120 });
    const timeoutMs = assertInteger(source.timeoutMs === undefined ? 600000 : source.timeoutMs, 'timeoutMs', { min: 1000, max: 3600000 });
    const configHash = hashInput({ runnerKind, runnerConfigJson, resultSchemaJson, collectorJson, maxParallel, mutexKey, timeoutMs });
    return { projectId, name, runnerKind, runnerConfigJson, resultSchemaJson, collectorJson, maxParallel, mutexKey, timeoutMs, configHash };
  }

  _createPreparedResearchExperiment(db, prepared, beforeCreate) {
    const { projectId, name, runnerKind, runnerConfigJson, resultSchemaJson, collectorJson, maxParallel, mutexKey, timeoutMs, configHash } = prepared;
    const project = db.prepare('SELECT * FROM research_projects WHERE project_id = ?').get(projectId);
    if (!project) throw stateError('RESEARCH_PROJECT_NOT_FOUND', 'No research project has that id.', { projectId });
    const existing = db.prepare('SELECT * FROM research_experiments WHERE project_id = ? AND config_hash = ?').get(projectId, configHash);
    const experimentId = existing ? existing.experiment_id : this._researchId('rx');
    // Inline submission must obtain its provider admission and durable audit
    // before the first insert, while the project/config identity is locked.
    if (beforeCreate) beforeCreate(Object.freeze({ experimentId, projectId, runnerKind }), this._researchProjectRow(project));
    if (existing) return { disposition: 'replay', experiment: this._researchExperimentRow(existing) };
    const now = this._now();
    try {
      db.prepare(`INSERT INTO research_experiments(experiment_id, project_id, name, runner_kind, runner_config_json, config_hash,
        result_schema_json, collector_json, max_parallel, mutex_key, timeout_ms, status, created_at_ms, updated_at_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(
        experimentId, projectId, name, runnerKind, runnerConfigJson, configHash,
        resultSchemaJson, collectorJson, maxParallel, mutexKey, timeoutMs, now, now);
    } catch (error) {
      if (String(error && error.message).includes('UNIQUE')) {
        throw stateError('RESEARCH_EXPERIMENT_NAME_TAKEN', 'An experiment with that name already exists in the project (its configuration differs — rename or archive it first).', { projectId, name });
      }
      throw error;
    }
    return { disposition: 'created', experiment: this._researchExperimentRow(db.prepare('SELECT * FROM research_experiments WHERE experiment_id = ?').get(experimentId)) };
  }

  updateResearchExperiment(input) {
    const source = assertPlainObject(input, 'experiment');
    const experimentId = assertString(source.experimentId, 'experimentId', { max: 39 });
    const forbidden = ['runnerKind', 'runnerConfig', 'resultSchema', 'collector', 'mutexKey', 'timeoutMs'].filter(field => source[field] !== undefined);
    if (forbidden.length) {
      throw stateError('RESEARCH_EXPERIMENT_IMMUTABLE', 'An experiment configuration cannot be changed after creation — create a new experiment instead.', { fields: forbidden });
    }
    return this.transaction(db => {
      const row = db.prepare('SELECT * FROM research_experiments WHERE experiment_id = ?').get(experimentId);
      if (!row) throw stateError('RESEARCH_EXPERIMENT_NOT_FOUND', 'No research experiment has that id.', { experimentId });
      const name = source.name === undefined ? row.name : assertString(source.name, 'name', { max: 120 });
      const status = source.status === undefined ? row.status : source.status;
      if (!['active', 'archived'].includes(status)) {
        throw stateError('STATE_INVALID_ARGUMENT', "status must be 'active' or 'archived'.", { field: 'status' });
      }
      const maxParallel = source.maxParallel === undefined ? row.max_parallel : assertInteger(source.maxParallel, 'maxParallel', { min: 1, max: 16 });
      db.prepare('UPDATE research_experiments SET name = ?, status = ?, max_parallel = ?, updated_at_ms = ? WHERE experiment_id = ?')
        .run(name, status, maxParallel, this._now(), experimentId);
      return this._researchExperimentRow(db.prepare('SELECT * FROM research_experiments WHERE experiment_id = ?').get(experimentId));
    });
  }

  getResearchExperiment(input) {
    const source = assertPlainObject(input, 'query');
    const experimentId = assertString(source.experimentId, 'experimentId', { max: 39 });
    return this.transaction(db => {
      const row = db.prepare('SELECT * FROM research_experiments WHERE experiment_id = ?').get(experimentId);
      return row ? this._researchExperimentRow(row) : null;
    });
  }

  listResearchExperiments(options = {}) {
    const source = assertPlainObject(options, 'options');
    const projectId = assertString(source.projectId, 'projectId', { max: 39 });
    return this.transaction(db => db
      .prepare('SELECT * FROM research_experiments WHERE project_id = ? ORDER BY updated_at_ms DESC').all(projectId)
      .map(row => this._researchExperimentRow(row)));
  }

  // One transaction: task insert on the reserved queue + run projection (+
  // optional submitting-session attribution). Idempotency key derives from
  // (experimentId, paramsHash), so replicate runs must carry a distinguishing
  // field (e.g. a replicate index) inside params — a deliberate contract, not
  // an accident. Replay returns the existing run.
  submitResearchRun(input) {
    const source = assertPlainObject(input, 'run');
    const experimentId = assertString(source.experimentId, 'experimentId', { max: 39 });
    const prepared = this._prepareResearchRun(source);
    return this.transaction(db => this._submitPreparedResearchRun(db, experimentId, prepared));
  }

  // Register-on-first-submit is one operation: a refusal cannot leave an
  // unaudited experiment or a partial task/run behind. The callback is a
  // synchronous provider admission hook, not an asynchronous transaction.
  registerAndSubmitResearchRun(input, beforeSubmit) {
    const source = assertPlainObject(input, 'inline run');
    if (typeof beforeSubmit !== 'function' || beforeSubmit.constructor?.name === 'AsyncFunction') {
      throw stateError('STATE_INVALID_ARGUMENT', 'Inline run admission must be a synchronous function.');
    }
    const experiment = this._prepareResearchExperiment(source.experiment);
    const run = this._prepareResearchRun(source);
    return this.transaction(db => {
      const registered = this._createPreparedResearchExperiment(db, experiment, (identity, project) => {
        const admitted = beforeSubmit(identity, project);
        if (admitted && typeof admitted.then === 'function') {
          if (typeof admitted.catch === 'function') admitted.catch(() => {});
          throw stateError('STATE_TRANSACTION_ASYNC', 'Inline run admission may not return a Promise.');
        }
      });
      const submitted = this._submitPreparedResearchRun(db, registered.experiment.experimentId, run);
      return { ...submitted, experiment: registered.experiment };
    });
  }

  _prepareResearchRun(source) {
    const params = assertPlainObject(source.params, 'params');
    const paramsJson = this._researchJson(params, 'params', 65536);
    const paramsHash = hashText(paramsJson);
    const priority = source.priority === undefined ? 0 : assertInteger(source.priority, 'priority', { min: -100, max: 100 });
    const availableAtMs = source.availableAtMs === undefined ? undefined : assertInteger(source.availableAtMs, 'availableAtMs');
    let sessionRefKind = null;
    let sessionRef = null;
    if (source.sessionRefKind !== undefined || source.sessionRef !== undefined) {
      if (!['launch', 'presence', 'observed'].includes(source.sessionRefKind)) {
        throw stateError('STATE_INVALID_ARGUMENT', "sessionRefKind must be 'launch', 'presence' or 'observed'.", { field: 'sessionRefKind' });
      }
      sessionRefKind = source.sessionRefKind;
      sessionRef = assertString(source.sessionRef, 'sessionRef', { max: 200 });
    }
    const runId = this._researchId('rr');
    return { paramsJson, paramsHash, priority, availableAtMs, sessionRefKind, sessionRef, runId, maxAttempts: source.maxAttempts };
  }

  _submitPreparedResearchRun(db, experimentId, prepared) {
    const { paramsJson, paramsHash, priority, availableAtMs, sessionRefKind, sessionRef, runId, maxAttempts } = prepared;
    // The task payload contract is a closed {title, objective, context?} string
    // shape (_taskPayload), and it must be DETERMINISTIC for identical
    // submissions or the idempotency input-hash can never replay — so the
    // payload carries only (experimentId, paramsHash). The worker resolves the
    // run row through research_runs.task_id (UNIQUE) after claiming.
    const experiment = db.prepare('SELECT * FROM research_experiments WHERE experiment_id = ?').get(experimentId);
    if (!experiment) throw stateError('RESEARCH_EXPERIMENT_NOT_FOUND', 'No research experiment has that id.', { experimentId });
    if (experiment.status !== 'active') throw stateError('RESEARCH_EXPERIMENT_ARCHIVED', 'The experiment is archived; runs cannot be submitted to it.', { experimentId });
    const definition = this._prepareTaskSubmission({
      queue: 'research-runs', type: 'research-run',
      idempotencyKey: `run:${experimentId}:${paramsHash.slice(0, 32)}`,
      // Mint only after the row lookup, inside the transaction that binds
      // the task to its run. paramsHash was computed from paramsJson above;
      // no caller-provided hash or objective reaches this constructor.
      payload: researchReferencePayload(experiment, paramsHash),
      // 6, not 3: a pause consumes a claim, and the overnight queue already
      // learned that bounded pauses need headroom (its MAX_ATTEMPTS is 6).
      priority, maxAttempts: maxAttempts === undefined ? 6 : maxAttempts,
      expiryPolicy: 'retry', availableAtMs
    });
    const now = this._now();
    const submission = this._submitPreparedTask(db, definition, now, { maxActiveTasks: 128 });
    if (submission.disposition === 'replay') {
      const existing = db.prepare('SELECT * FROM research_runs WHERE task_id = ?').get(submission.task.id);
      if (!existing) throw stateError('RESEARCH_RUN_ORPHAN_TASK', 'A task exists for this submission but its run row is missing.', { taskId: submission.task.id });
      return { disposition: 'replay', run: this._researchRunRow(existing, null) };
    }
    db.prepare(`INSERT INTO research_runs(run_id, experiment_id, task_id, params_json, params_hash, session_ref_kind, session_ref, artifact_dir, created_at_ms)
      VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?)`).run(runId, experimentId, submission.task.id, paramsJson, paramsHash, sessionRefKind, sessionRef, now);
    const row = db.prepare('SELECT * FROM research_runs WHERE run_id = ?').get(runId);
    return { disposition: 'submitted', run: this._researchRunRow(row, null) };
  }

  // Attempt-neutral pause: push the availability of queued research-run tasks
  // whose project is disabled/archived, whose experiment is archived, or whose
  // runner kind is currently withheld, so the worker never claims them. A
  // pause that works by claim-then-retry burns a task attempt per cycle and
  // the closed retry taxonomy caps local-write retries at two, which would
  // make "jobs already waiting stay waiting instead of failing" (the settings
  // row's own sentence) false on the second cycle. Deferring availability
  // consumes nothing and reverses the moment the flag comes back.
  deferResearchRuns(input) {
    const source = assertPlainObject(input, 'options');
    const delayMs = assertInteger(source.delayMs, 'delayMs', { min: 1000, max: 3600000 });
    const withheldKinds = source.withheldKinds === undefined ? [] : source.withheldKinds;
    if (!Array.isArray(withheldKinds) || withheldKinds.some(kind => !['agent', 'process', 'http'].includes(kind))) {
      throw stateError('STATE_INVALID_ARGUMENT', "withheldKinds may contain only 'agent', 'process' or 'http'.", { field: 'withheldKinds' });
    }
    return this.transaction(db => {
      const now = this._now();
      const notBefore = now + delayMs;
      const kindClause = withheldKinds.length ? ` OR e.runner_kind IN (${withheldKinds.map(() => '?').join(',')})` : '';
      const result = db.prepare(`UPDATE tasks SET available_at_ms = ?, updated_at_ms = ?
        WHERE status IN ('queued', 'retry_wait') AND available_at_ms < ? AND id IN (
          SELECT r.task_id FROM research_runs r
          JOIN research_experiments e ON e.experiment_id = r.experiment_id
          JOIN research_projects p ON p.project_id = e.project_id
          WHERE p.enabled = 0 OR p.status <> 'active' OR e.status <> 'active'${kindClause}
        )`).run(notBefore, now, notBefore, ...withheldKinds);
      // Capacity is the same attempt math with a shorter horizon: a run
      // claimed beyond max_parallel or into a held mutex could only be
      // retry-failed, and a burst larger than the ceiling would die on it.
      // Defer over-capacity runs briefly instead; capacity clears fast.
      const capacityDelayMs = source.capacityDelayMs === undefined ? Math.min(delayMs, 15000)
        : assertInteger(source.capacityDelayMs, 'capacityDelayMs', { min: 1000, max: 3600000 });
      const capacityNotBefore = now + capacityDelayMs;
      const capacity = db.prepare(`UPDATE tasks SET available_at_ms = ?, updated_at_ms = ?
        WHERE status IN ('queued', 'retry_wait') AND available_at_ms < ? AND id IN (
          SELECT r.task_id FROM research_runs r
          JOIN research_experiments e ON e.experiment_id = r.experiment_id
          WHERE (SELECT COUNT(*) FROM research_runs r2 JOIN tasks t2 ON t2.id = r2.task_id
                 WHERE r2.experiment_id = e.experiment_id AND t2.status IN ('leased', 'running')) >= e.max_parallel
             OR (e.mutex_key IS NOT NULL AND EXISTS(
                 SELECT 1 FROM research_runs r3
                 JOIN research_experiments e3 ON e3.experiment_id = r3.experiment_id
                 JOIN tasks t3 ON t3.id = r3.task_id
                 WHERE e3.mutex_key = e.mutex_key AND t3.status IN ('leased', 'running')))
        )`).run(capacityNotBefore, now, capacityNotBefore);
      return { deferred: result.changes, deferredForCapacity: capacity.changes };
    });
  }

  getResearchRunByTask(input) {
    const source = assertPlainObject(input, 'query');
    const taskId = assertString(source.taskId, 'taskId', { max: 500 });
    return this.transaction(db => {
      const row = db.prepare('SELECT * FROM research_runs WHERE task_id = ?').get(taskId);
      if (!row) return null;
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.task_id);
      return this._researchRunRow(row, task || null);
    });
  }

  listResearchRuns(options = {}) {
    const source = assertPlainObject(options, 'options');
    const experimentId = source.experimentId === undefined ? null : assertString(source.experimentId, 'experimentId', { max: 39 });
    const runId = source.runId === undefined ? null : assertString(source.runId, 'runId', { max: 39 });
    if (!experimentId && !runId) {
      throw stateError('STATE_INVALID_ARGUMENT', 'listResearchRuns needs an experimentId or a runId.', { field: 'experimentId' });
    }
    const limit = assertInteger(source.limit === undefined ? 200 : source.limit, 'limit', { min: 1, max: 1000 });
    return this.transaction(db => {
      const rows = runId
        ? db.prepare('SELECT * FROM research_runs WHERE run_id = ?').all(runId)
        : db.prepare('SELECT * FROM research_runs WHERE experiment_id = ? ORDER BY created_at_ms DESC LIMIT ?').all(experimentId, limit);
      return rows.map(row => {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.task_id);
        return this._researchRunRow(row, task || null);
      });
    });
  }

  // A research history page freezes membership at an insertion ceiling. A
  // later append waits for the next traversal; deletion/replacement refuses
  // this traversal instead of passing an incomplete history to an export.
  listResearchRunsPage(options = {}) {
    const source = assertPlainObject(options, 'options');
    const experimentId = assertString(source.experimentId, 'experimentId', { max: 39 });
    const limit = assertInteger(source.limit === undefined ? 200 : source.limit, 'limit', { min: 1, max: 1000 });
    let cursor = null;
    if (source.cursor !== undefined) {
      try {
        const token = source.cursor;
        if (typeof token !== 'string' || !token || token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) throw Error();
        cursor = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
        if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)
            || Object.keys(cursor).sort().join(',') !== 'before,beforeRunId,ceiling,ceilingRunId,experimentId,offset,total,version'
            || cursor.version !== 1 || cursor.experimentId !== experimentId
            || ![cursor.ceiling, cursor.before, cursor.total, cursor.offset].every(value => Number.isSafeInteger(value) && value > 0)
            || cursor.before > cursor.ceiling || cursor.offset >= cursor.total
            || ![cursor.ceilingRunId, cursor.beforeRunId].every(value => typeof value === 'string' && /^rr-[0-9a-f]{36}$/.test(value))) throw Error();
      } catch { throw stateError('STATE_INVALID_ARGUMENT', 'The research run cursor is invalid or belongs to another experiment.'); }
    }
    return this.transaction(db => {
      const latest = db.prepare('SELECT rowid AS sequence, run_id FROM research_runs WHERE experiment_id = ? ORDER BY rowid DESC LIMIT 1').get(experimentId);
      const ceiling = cursor?.ceiling ?? latest?.sequence ?? 0;
      const total = db.prepare('SELECT COUNT(*) AS total FROM research_runs WHERE experiment_id = ? AND rowid <= ?').get(experimentId, ceiling).total;
      const snapshot = cursor?.ceilingRunId ?? latest?.run_id ?? null;
      if (cursor) {
        const ceilingRow = db.prepare('SELECT run_id FROM research_runs WHERE experiment_id = ? AND rowid = ?').get(experimentId, ceiling);
        const beforeRow = db.prepare('SELECT run_id FROM research_runs WHERE experiment_id = ? AND rowid = ?').get(experimentId, cursor.before);
        const offset = db.prepare('SELECT COUNT(*) AS total FROM research_runs WHERE experiment_id = ? AND rowid <= ? AND rowid >= ?').get(experimentId, ceiling, cursor.before).total;
        if (total !== cursor.total || ceilingRow?.run_id !== snapshot || beforeRow?.run_id !== cursor.beforeRunId || offset !== cursor.offset) {
          throw stateError('RESEARCH_RUNS_CHANGED', 'The research history changed while it was being read. Refresh it before using or exporting the run list.');
        }
      }
      const rows = db.prepare(`SELECT rowid AS sequence, * FROM research_runs
        WHERE experiment_id = ? AND rowid <= ? AND (? IS NULL OR rowid < ?) ORDER BY rowid DESC LIMIT ?`)
        .all(experimentId, ceiling, cursor?.before ?? null, cursor?.before ?? null, limit);
      const offset = cursor?.offset ?? 0;
      const nextOffset = offset + rows.length;
      if (rows.length !== Math.min(limit, total - offset)) throw stateError('RESEARCH_RUNS_CHANGED', 'The complete research history page could not be read. Refresh it before exporting.');
      const last = rows.at(-1);
      const nextCursor = nextOffset < total ? Buffer.from(JSON.stringify({ version: 1, experimentId,
        ceiling, ceilingRunId: snapshot, before: last.sequence, beforeRunId: last.run_id, total, offset: nextOffset })).toString('base64url') : null;
      return {
        runs: rows.map(row => this._researchRunRow(row, db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.task_id) || null)),
        pagination: { version: 1, experimentId, snapshot, total, offset, nextCursor }
      };
    });
  }

  setResearchRunArtifactDir(input) {
    const source = assertPlainObject(input, 'run');
    const runId = assertString(source.runId, 'runId', { max: 39 });
    const artifactDir = assertString(source.artifactDir, 'artifactDir', { max: 1024 });
    return this.transaction(db => {
      if (source.handle !== undefined) this._assertResearchRunClaim(db, runId, source.handle);
      const changed = db.prepare('UPDATE research_runs SET artifact_dir = ? WHERE run_id = ?').run(artifactDir, runId);
      if (changed.changes !== 1) throw stateError('RESEARCH_RUN_NOT_FOUND', 'No research run has that id.', { runId });
      return true;
    });
  }

  setResearchRunSession(input) {
    const source = assertPlainObject(input, 'run');
    const runId = assertString(source.runId, 'runId', { max: 39 });
    if (!['launch', 'presence', 'observed'].includes(source.sessionRefKind)) {
      throw stateError('STATE_INVALID_ARGUMENT', "sessionRefKind must be 'launch', 'presence' or 'observed'.", { field: 'sessionRefKind' });
    }
    const sessionRef = assertString(source.sessionRef, 'sessionRef', { max: 200 });
    return this.transaction(db => {
      if (source.handle !== undefined) this._assertResearchRunClaim(db, runId, source.handle);
      const changed = db.prepare('UPDATE research_runs SET session_ref_kind = ?, session_ref = ? WHERE run_id = ?')
        .run(source.sessionRefKind, sessionRef, runId);
      if (changed.changes !== 1) throw stateError('RESEARCH_RUN_NOT_FOUND', 'No research run has that id.', { runId });
      return true;
    });
  }

  _assertResearchRunClaim(db, runId, handle) {
    const claim = this._validateTaskHandle(handle);
    const run = db.prepare('SELECT task_id FROM research_runs WHERE run_id = ?').get(runId);
    if (!run) throw stateError('RESEARCH_RUN_NOT_FOUND', 'No research run has that id.', { runId });
    if (run.task_id !== claim.taskId) throw stateError('TASK_FENCE_LOST', 'The claim does not own this research run.', { runId });
    this._currentTaskClaim(db, claim, this._now(), ['running']);
  }

  _prepareResearchResults(records, { allowEmpty = false } = {}) {
    if (!Array.isArray(records) || records.length < (allowEmpty ? 0 : 1) || records.length > 500) {
      throw stateError('STATE_INVALID_ARGUMENT', `records must contain from ${allowEmpty ? 0 : 1} through 500 entries.`, { field: 'records' });
    }
    return records.map((entry, index) => {
      const record = assertPlainObject(entry, `records[${index}]`);
      const recordKind = assertString(record.recordKind, `records[${index}].recordKind`, { max: 64 });
      const recordJson = this._researchJson(record.record, `records[${index}].record`, 262144);
      const artifactPath = record.artifactPath === undefined || record.artifactPath === null
        ? null : assertString(record.artifactPath, `records[${index}].artifactPath`, { max: 1024 });
      return { recordKind, recordJson, recordHash: hashText(recordJson), artifactPath };
    });
  }

  _recordResearchResults(db, runId, prepared) {
    const run = db.prepare('SELECT run_id FROM research_runs WHERE run_id = ?').get(runId);
    if (!run) throw stateError('RESEARCH_RUN_NOT_FOUND', 'No research run has that id.', { runId });
    const now = this._now();
    const insert = db.prepare(`INSERT OR IGNORE INTO research_results(result_id, run_id, record_kind, record_json, record_hash, artifact_path, created_at_ms)
      VALUES(?, ?, ?, ?, ?, ?, ?)`);
    let recorded = 0;
    for (const entry of prepared) {
      const changes = insert.run(this._researchId('rres'), runId, entry.recordKind, entry.recordJson, entry.recordHash, entry.artifactPath, now).changes;
      if (changes) recorded += 1;
    }
    return { recorded, deduplicated: prepared.length - recorded };
  }

  recordResearchResults(input) {
    const source = assertPlainObject(input, 'results');
    const runId = assertString(source.runId, 'runId', { max: 39 });
    const prepared = this._prepareResearchResults(source.records);
    return this.transaction(db => this._recordResearchResults(db, runId, prepared));
  }

  completeResearchRun(handle, options = {}) {
    const claim = this._validateTaskHandle(handle);
    const source = assertPlainObject(options, 'options');
    const runId = assertString(source.runId, 'runId', { max: 39 });
    const prepared = this._prepareResearchResults(source.records, { allowEmpty: true });
    const completion = assertPlainObject(source.result, 'result');
    const expectedEvidence = prepared.length ? 'collected' : 'execution-only';
    if (completion.evidenceStatus !== expectedEvidence) {
      throw stateError('RESEARCH_RESULTS_EVIDENCE_MISMATCH', 'Collected evidence requires nonempty results; execution-only completion requires no results.', { runId });
    }
    // Keep the legacy writer compatible, but the fenced collector boundary
    // accepts only object records and never converts non-finite metadata to null.
    source.records.forEach((entry, index) => assertPlainObject(entry.record, `records[${index}].record`));
    this._researchJson(completion, 'result', MAX_JSON_BYTES);
    // The legacy result table deduplicates equal payloads. Treat an ambiguous
    // repeated observation as a refusal, never silently reduce the sample size.
    if (new Set(prepared.map(entry => entry.recordHash)).size !== prepared.length) {
      throw stateError('RESEARCH_RESULTS_DUPLICATE_IDENTITY', 'Repeated result payloads need distinct observation IDs; no observations were discarded or accepted.', { runId });
    }
    const result = Object.freeze({
      ...completion,
      recorded: prepared.length, deduplicated: 0,
      collectionHash: hashInput({ runId, records: prepared }),
      attempt: claim.attempt, fence: claim.fence
    });
    RESEARCH_COMPLETION_DIGESTS.set(result, Object.freeze({ digest: result.collectionHash, json: JSON.stringify(result) }));
    return this.transaction(db => {
      const run = db.prepare(`SELECT r.task_id, r.artifact_dir, r.experiment_id, r.params_hash, e.config_hash, e.runner_kind, e.runner_config_json, e.collector_json FROM research_runs r
        JOIN research_experiments e ON e.experiment_id = r.experiment_id WHERE r.run_id = ?`).get(runId);
      if (!run) throw stateError('RESEARCH_RUN_NOT_FOUND', 'No research run has that id.', { runId });
      if (run.task_id !== claim.taskId) throw stateError('TASK_FENCE_LOST', 'The claim does not own this research run.', { runId });
      const runnerConfig = JSON.parse(run.runner_config_json);
      const pins = validatePinnedFiles(run.runner_kind, runnerConfig);
      if (pins) assertProcessReceipt(completion.provenance, { pins, runId, artifactDir: run.artifact_dir });
      const manifest = validateStudyProtocol(run.runner_kind, runnerConfig);
      assertStudyProtocolDeclaration(completion.studyProtocol, { manifest, binding: {
        runId, experimentId: run.experiment_id, experimentConfigHash: run.config_hash,
        paramsHash: run.params_hash, attempt: claim.attempt, fence: claim.fence
      } });
      const collector = JSON.parse(run.collector_json);
      if (!['process', 'http'].includes(run.runner_kind) || completion.runnerKind !== run.runner_kind
          || !['none', 'stdout-json', 'artifact-glob'].includes(collector.kind)
          || (collector.kind === 'none' ? 'execution-only' : 'collected') !== completion.evidenceStatus) {
        throw stateError('RESEARCH_RESULTS_EVIDENCE_MISMATCH', 'The evidence status and runner must match this run\'s declared collector and execution kind.', { runId });
      }
      const completed = this._completeTask(db, claim, result);
      if (!completed.replayed) {
        if (db.prepare('SELECT 1 FROM research_results WHERE run_id = ? LIMIT 1').get(runId)) {
          throw stateError('RESEARCH_RESULTS_PRIOR_UNVERIFIED', 'This run has prior results without this atomic completion. They were preserved; submit a new run to avoid mixing attempts.', { runId });
        }
        const saved = this._recordResearchResults(db, runId, prepared);
        if (saved.recorded !== prepared.length || saved.deduplicated !== 0) {
          throw stateError('RESEARCH_RUN_RESULTS_INCOMPLETE', 'The complete result set could not be saved. Completion and all new records were rolled back.', { runId });
        }
      }
      // A terminal task hash alone does not establish that its current records
      // still match. Also check replays, including later legacy appends, deleted
      // rows, or a stored payload changed without updating its record hash.
      const rows = db.prepare(`SELECT record_kind, record_json, record_hash, artifact_path
        FROM research_results WHERE run_id = ? LIMIT 501`).all(runId);
      const expected = new Map(prepared.map(entry => [entry.recordHash, entry]));
      if (rows.length !== prepared.length || rows.some(row => {
        const entry = expected.get(row.record_hash);
        return !entry || row.record_kind !== entry.recordKind || row.record_json !== entry.recordJson
          || row.artifact_path !== entry.artifactPath;
      })) {
        throw stateError('RESEARCH_RESULTS_INTEGRITY_CONFLICT', 'The saved result set does not match this fenced completion. No records were repaired or accepted.', { runId });
      }
      return completed;
    });
  }

  listResearchResults(options = {}) {
    const source = assertPlainObject(options, 'options');
    const runId = source.runId === undefined ? null : assertString(source.runId, 'runId', { max: 39 });
    const experimentId = source.experimentId === undefined ? null : assertString(source.experimentId, 'experimentId', { max: 39 });
    if (!runId && !experimentId) {
      throw stateError('STATE_INVALID_ARGUMENT', 'listResearchResults needs a runId or an experimentId.', { field: 'runId' });
    }
    const limit = assertInteger(source.limit === undefined ? 500 : source.limit, 'limit', { min: 1, max: 2000 });
    return this.transaction(db => {
      const rows = runId
        ? db.prepare('SELECT * FROM research_results WHERE run_id = ? ORDER BY created_at_ms LIMIT ?').all(runId, limit)
        : db.prepare(`SELECT rr.* FROM research_results rr JOIN research_runs r ON r.run_id = rr.run_id
            WHERE r.experiment_id = ? ORDER BY rr.created_at_ms LIMIT ?`).all(experimentId, limit);
      return rows.map(row => ({
        resultId: row.result_id, runId: row.run_id, recordKind: row.record_kind,
        record: JSON.parse(row.record_json), recordHash: row.record_hash,
        artifactPath: row.artifact_path, createdAtMs: row.created_at_ms
      }));
    });
  }

  countActiveResearchRuns(options = {}) {
    const source = assertPlainObject(options, 'options');
    const experimentId = source.experimentId === undefined ? null : assertString(source.experimentId, 'experimentId', { max: 39 });
    const mutexKey = source.mutexKey === undefined ? null : assertString(source.mutexKey, 'mutexKey', { max: 120 });
    const excludeTaskId = source.excludeTaskId === undefined ? null : assertString(source.excludeTaskId, 'excludeTaskId', { max: 500 });
    if (!experimentId && !mutexKey) {
      throw stateError('STATE_INVALID_ARGUMENT', 'countActiveResearchRuns needs an experimentId or a mutexKey.', { field: 'experimentId' });
    }
    return this.transaction(db => {
      const clauses = ["t.status IN ('leased','running')"];
      const values = [];
      if (experimentId) { clauses.push('r.experiment_id = ?'); values.push(experimentId); }
      if (mutexKey) { clauses.push('e.mutex_key = ?'); values.push(mutexKey); }
      if (excludeTaskId) { clauses.push('r.task_id <> ?'); values.push(excludeTaskId); }
      return db.prepare(`SELECT COUNT(*) AS count FROM research_runs r
        JOIN tasks t ON t.id = r.task_id
        JOIN research_experiments e ON e.experiment_id = r.experiment_id
        WHERE ${clauses.join(' AND ')}`).get(...values).count;
    });
  }

  assignResearchSessions(input) {
    const source = assertPlainObject(input, 'assignment');
    const projectId = assertString(source.projectId, 'projectId', { max: 39 });
    const assignedBy = assertString(source.assignedBy, 'assignedBy', { max: 100 });
    if (!Array.isArray(source.sessions) || source.sessions.length < 1 || source.sessions.length > 100) {
      throw stateError('STATE_INVALID_ARGUMENT', 'sessions must contain from 1 through 100 entries.', { field: 'sessions' });
    }
    const sessions = source.sessions.map((entry, index) => {
      const record = assertPlainObject(entry, `sessions[${index}]`);
      if (!['launch', 'presence', 'observed', 'all'].includes(record.kind)) {
        throw stateError('STATE_INVALID_ARGUMENT', `sessions[${index}].kind must be 'launch', 'presence', 'observed' or 'all'.`, { field: 'sessions' });
      }
      const ref = record.kind === 'all' ? '*' : assertString(record.ref, `sessions[${index}].ref`, { max: 200 });
      return { kind: record.kind, ref };
    });
    return this.transaction(db => {
      const project = db.prepare('SELECT project_id FROM research_projects WHERE project_id = ?').get(projectId);
      if (!project) throw stateError('RESEARCH_PROJECT_NOT_FOUND', 'No research project has that id.', { projectId });
      const now = this._now();
      const results = sessions.map(session => {
        const existing = db.prepare(`SELECT * FROM research_project_sessions
          WHERE project_id = ? AND session_ref_kind = ? AND session_ref = ? AND active = 1`).get(projectId, session.kind, session.ref);
        if (existing) return { disposition: 'replay', assignmentId: existing.assignment_id, kind: session.kind, ref: session.ref };
        const assignmentId = this._researchId('ra');
        db.prepare(`INSERT INTO research_project_sessions(assignment_id, project_id, session_ref_kind, session_ref, assigned_by, active, assigned_at_ms, unassigned_at_ms)
          VALUES(?, ?, ?, ?, ?, 1, ?, NULL)`).run(assignmentId, projectId, session.kind, session.ref, assignedBy, now);
        return { disposition: 'assigned', assignmentId, kind: session.kind, ref: session.ref };
      });
      return { projectId, assignments: results };
    });
  }

  unassignResearchSession(input) {
    const source = assertPlainObject(input, 'assignment');
    const assignmentId = source.assignmentId === undefined ? null : assertString(source.assignmentId, 'assignmentId', { max: 39 });
    // Keep ID-only callers valid; a supplied project scopes either selector.
    const projectId = assignmentId && source.projectId === undefined
      ? null : assertString(source.projectId, 'projectId', { max: 39 });
    return this.transaction(db => {
      let row;
      if (assignmentId) {
        row = db.prepare('SELECT * FROM research_project_sessions WHERE assignment_id = ? AND active = 1').get(assignmentId);
      } else {
        if (!['launch', 'presence', 'observed', 'all'].includes(source.kind)) {
          throw stateError('STATE_INVALID_ARGUMENT', "kind must be 'launch', 'presence', 'observed' or 'all'.", { field: 'kind' });
        }
        const ref = source.kind === 'all' ? '*' : assertString(source.ref, 'ref', { max: 200 });
        row = db.prepare(`SELECT * FROM research_project_sessions
          WHERE project_id = ? AND session_ref_kind = ? AND session_ref = ? AND active = 1`).get(projectId, source.kind, ref);
      }
      if (!row || (projectId !== null && row.project_id !== projectId)) {
        throw stateError('RESEARCH_ASSIGNMENT_NOT_FOUND', 'No active assignment matches.', {});
      }
      db.prepare('UPDATE research_project_sessions SET active = 0, unassigned_at_ms = ? WHERE assignment_id = ?').run(this._now(), row.assignment_id);
      return { assignmentId: row.assignment_id, projectId: row.project_id, kind: row.session_ref_kind, ref: row.session_ref };
    });
  }

  listResearchSessionAssignments(options = {}) {
    const source = assertPlainObject(options, 'options');
    const projectId = source.projectId === undefined ? null : assertString(source.projectId, 'projectId', { max: 39 });
    const activeOnly = source.activeOnly !== false;
    return this.transaction(db => {
      const clauses = [];
      const values = [];
      if (projectId) { clauses.push('project_id = ?'); values.push(projectId); }
      if (activeOnly) clauses.push('active = 1');
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      return db.prepare(`SELECT * FROM research_project_sessions${where} ORDER BY assigned_at_ms DESC`).all(...values).map(row => ({
        assignmentId: row.assignment_id, projectId: row.project_id, kind: row.session_ref_kind,
        ref: row.session_ref, assignedBy: row.assigned_by, active: row.active === 1,
        assignedAtMs: row.assigned_at_ms, unassignedAtMs: row.unassigned_at_ms
      }));
    });
  }

  resolveSessionResearchProjects(input) {
    const source = assertPlainObject(input, 'query');
    if (!Array.isArray(source.refs) || source.refs.length < 1 || source.refs.length > 10) {
      throw stateError('STATE_INVALID_ARGUMENT', 'refs must contain from 1 through 10 entries.', { field: 'refs' });
    }
    const refs = source.refs.map((entry, index) => {
      const record = assertPlainObject(entry, `refs[${index}]`);
      if (!['launch', 'presence', 'observed'].includes(record.kind)) {
        throw stateError('STATE_INVALID_ARGUMENT', `refs[${index}].kind must be 'launch', 'presence' or 'observed'.`, { field: 'refs' });
      }
      return { kind: record.kind, ref: assertString(record.ref, `refs[${index}].ref`, { max: 200 }) };
    });
    return this.transaction(db => {
      const matches = new Map();
      const record = row => {
        if (!matches.has(row.project_id)) {
          matches.set(row.project_id, {
            projectId: row.project_id, name: row.name, enabled: row.enabled === 1,
            status: row.status, via: []
          });
        }
        matches.get(row.project_id).via.push({ kind: row.session_ref_kind, ref: row.session_ref });
      };
      for (const ref of refs) {
        db.prepare(`SELECT p.project_id, p.name, p.enabled, p.status, s.session_ref_kind, s.session_ref
          FROM research_project_sessions s JOIN research_projects p ON p.project_id = s.project_id
          WHERE s.active = 1 AND s.session_ref_kind = ? AND s.session_ref = ?`).all(ref.kind, ref.ref).forEach(record);
      }
      db.prepare(`SELECT p.project_id, p.name, p.enabled, p.status, s.session_ref_kind, s.session_ref
        FROM research_project_sessions s JOIN research_projects p ON p.project_id = s.project_id
        WHERE s.active = 1 AND s.session_ref_kind = 'all'`).all().forEach(record);
      return [...matches.values()];
    });
  }

  saveResearchFinding(input) {
    const source = assertPlainObject(input, 'finding');
    const projectId = assertString(source.projectId, 'projectId', { max: 39 });
    const claim = assertString(source.claim, 'claim', { max: 500 });
    const status = source.status === undefined ? 'open' : source.status;
    if (!['open', 'confirmed', 'refuted', 'superseded'].includes(status)) {
      throw stateError('STATE_INVALID_ARGUMENT', "status must be 'open', 'confirmed', 'refuted' or 'superseded'.", { field: 'status' });
    }
    const evidenceJson = source.evidence === undefined || source.evidence === null ? null : this._researchJson(source.evidence, 'evidence', 65536);
    const method = source.method === undefined || source.method === null ? null : assertString(source.method, 'method', { max: 2000 });
    const confidence = source.confidence === undefined || source.confidence === null ? null : assertString(source.confidence, 'confidence', { max: 500 });
    const falsifier = source.falsifier === undefined || source.falsifier === null ? null : assertString(source.falsifier, 'falsifier', { max: 1000 });
    const dissentsJson = source.dissents === undefined ? '[]' : this._researchJson(source.dissents, 'dissents', 65536);
    const supersedes = source.supersedes === undefined || source.supersedes === null ? null : assertString(source.supersedes, 'supersedes', { max: 20 });
    const findingId = source.findingId === undefined ? null : assertString(source.findingId, 'findingId', { max: 20 });
    if (status === 'confirmed' && (evidenceJson === null || falsifier === null)) {
      throw stateError('RESEARCH_FINDING_UNDISCIPLINED', 'A confirmed finding must carry evidence and a falsifier.', { status });
    }
    return this.transaction(db => {
      const project = db.prepare('SELECT project_id FROM research_projects WHERE project_id = ?').get(projectId);
      if (!project) throw stateError('RESEARCH_PROJECT_NOT_FOUND', 'No research project has that id.', { projectId });
      const now = this._now();
      if (findingId) {
        const row = db.prepare('SELECT * FROM research_findings WHERE finding_id = ?').get(findingId);
        if (!row) throw stateError('RESEARCH_FINDING_NOT_FOUND', 'No finding has that id.', { findingId });
        db.prepare(`UPDATE research_findings SET claim = ?, status = ?, evidence_json = ?, method = ?, confidence = ?,
          falsifier = ?, dissents_json = ?, supersedes = ?, updated_at_ms = ? WHERE finding_id = ?`).run(
          claim, status, evidenceJson, method, confidence, falsifier, dissentsJson, supersedes, now, findingId);
        return db.prepare('SELECT finding_id FROM research_findings WHERE finding_id = ?').get(findingId).finding_id;
      }
      const stamp = new Date(now);
      const datePart = `${stamp.getUTCFullYear()}-${String(stamp.getUTCMonth() + 1).padStart(2, '0')}${String(stamp.getUTCDate()).padStart(2, '0')}`;
      const prefix = `F-${datePart}-`;
      const last = db.prepare("SELECT finding_id FROM research_findings WHERE finding_id GLOB ? ORDER BY finding_id DESC LIMIT 1").get(`${prefix}[0-9][0-9][0-9]`);
      const next = last ? Number(last.finding_id.slice(-3)) + 1 : 1;
      if (next > 999) throw stateError('RESEARCH_FINDING_SEQUENCE_EXHAUSTED', 'The daily finding sequence is exhausted.', { prefix });
      const newId = `${prefix}${String(next).padStart(3, '0')}`;
      db.prepare(`INSERT INTO research_findings(finding_id, project_id, claim, status, evidence_json, method, confidence,
        falsifier, dissents_json, supersedes, created_at_ms, updated_at_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId, projectId, claim, status, evidenceJson, method, confidence, falsifier, dissentsJson, supersedes, now, now);
      return newId;
    });
  }

  listResearchFindings(options = {}) {
    const source = assertPlainObject(options, 'options');
    const projectId = assertString(source.projectId, 'projectId', { max: 39 });
    const status = source.status === undefined ? null : source.status;
    if (status !== null && !['open', 'confirmed', 'refuted', 'superseded'].includes(status)) {
      throw stateError('STATE_INVALID_ARGUMENT', "status must be 'open', 'confirmed', 'refuted' or 'superseded'.", { field: 'status' });
    }
    return this.transaction(db => {
      const rows = status
        ? db.prepare('SELECT * FROM research_findings WHERE project_id = ? AND status = ? ORDER BY finding_id DESC').all(projectId, status)
        : db.prepare('SELECT * FROM research_findings WHERE project_id = ? ORDER BY finding_id DESC').all(projectId);
      return rows.map(row => ({
        findingId: row.finding_id, projectId: row.project_id, claim: row.claim, status: row.status,
        evidence: row.evidence_json === null ? null : JSON.parse(row.evidence_json),
        method: row.method, confidence: row.confidence, falsifier: row.falsifier,
        dissents: JSON.parse(row.dissents_json), supersedes: row.supersedes,
        createdAtMs: row.created_at_ms, updatedAtMs: row.updated_at_ms
      }));
    });
  }
}

function createStateStore(options = {}) {
  return new StateStore(options);
}

let singleton;
let singletonSealed = false;
// THE PROCESS-WIDE DOOR, AND THEREFORE THE PLACE A BROKEN SCHEMA MUST STOP.
//
// Every process that wants durable state comes through here once. Before
// 2026-08-11 this returned a handle without touching the database at all --
// importLegacyState() short-circuits when no legacy file is present, so on a
// normal install nothing here opened anything. A database missing a required
// STRICT table therefore produced a clean start followed by a scattering of
// unrelated-looking failures at whichever tool reached the database first.
//
// ensureOpen() moves that to the first line of the first process that wants
// durable state, as one STATE_SCHEMA_INVALID that names the table. It runs
// BEFORE importLegacyState() on purpose: a legacy import writes, and writing
// into a database whose shape has not been checked is how a partial schema
// becomes a corrupt one.
function getStateStore() {
  if (singletonSealed) {
    throw stateError('STATE_STORE_CLOSED', 'The durable state store was closed for local-data removal. Restart before using it again.');
  }
  if (!singleton) {
    const candidate = createStateStore();
    try {
      candidate.ensureOpen();
      candidate.importLegacyState();
      singleton = candidate;
    } catch (error) {
      candidate.close();
      throw error;
    }
  }
  return singleton;
}

function closeStateStore() {
  if (!singleton) return false;
  const closed = singleton.close();
  singleton = undefined;
  return closed;
}

// Reset has already drained its runtime writers when it reaches this seam.
// Seal before closing so both cached store references and later singleton
// lookups refuse to recreate state while the result screen remains open.
// Unlike getStateStore(), this never opens a database merely to close it.
function sealAndCloseStateStore() {
  singletonSealed = true;
  if (singleton) sealedStores.add(singleton);
  return Object.freeze({ ok: true, closed: closeStateStore() });
}

module.exports = {
  APPLICATION_ID,
  DEFAULT_STATE_PATH,
  // The table -> columns map this build actually requires. Exported so a suite
  // can assert the storage it depends on is still present in the CURRENT
  // schema instead of pinning a schema NUMBER, which every additive bump
  // falsifies without breaking anything. Frozen, so a reader cannot mutate it.
  REQUIRED_SCHEMA,
  SCHEMA_VERSION,
  StateStore,
  StateStoreError,
  closeStateStore,
  createStateStore,
  getStateStore,
  sealAndCloseStateStore,
  hashInput
};
