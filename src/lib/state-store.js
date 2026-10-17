'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ensureDir, rootPath } = require('./runtime');
const { plaintextCredentialOutsideGeneratedIds, plaintextCredentialPattern } = require('./secret-patterns');
const capabilityManifests = require('./capability-manifests');
const provenanceEnvelopes = require('../../schemas/generated/platform.provenance');
// Discord left the product on 2026-08-22 (product decision) and
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

/* Case-insensitive search text for any script: compatibility forms unified
   (NFKC), then upper- and lower-cased so that forms like "ß"/"SS" and final
   sigma meet. Used on both sides of memory search. */
function foldSearchText(text) {
  return String(text).normalize('NFKC').toUpperCase().toLowerCase();
}
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
// What a worker does when a task it holds was cancelled (task.cancel): the
// sentence ends every TASK_CANCEL_REQUESTED refusal an agent reads.
const TASK_CANCEL_ACKNOWLEDGE = 'Stop the work and acknowledge it with task.fail with disposition cancelled.';
const MAX_ACTIVE_TASKS_PER_QUEUE = 10000;
const DEFAULT_TASK_LEASE_MS = 5 * 60 * 1000;
const MAX_TELEGRAM_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_VALUE_BYTES = 32 * 1024;
const MAX_MEMORY_NOTE_CHARS = 8 * 1024;
/* A STORED MEMORY ROW IS VERIFIED ONCE PER STORED VALUE, NOT ONCE PER READ.
 *
 * _memoryRow re-serializes the value canonically, re-hashes it and scans it for
 * plaintext credentials. Every one of those checks is a pure function of four
 * stored strings: value_json, value_hash, tags_json and note. The agent courier
 * reads every circle's whole 32 KiB inbox stream through this path every 1.2 s,
 * so with 45 circles the same unchanged bytes were verified about 37 times a
 * minute each, on the application's main thread: measured offline at LIVE
 * fill, 40 of the 45 ms a round spent in getMemory was this re-verification.
 *
 * So a row whose four strings are exactly the ones already verified on this
 * store is not verified again. The comparison is exact string equality, so any
 * change to any of them -- a new write, a tampered value, a hash edited to
 * match, a secret smuggled in with a recomputed hash -- misses and is verified
 * in full, and a failure still throws. Only successes are remembered.
 *
 * BOUNDED: the oldest remembered rows are forgotten first, by count and by
 * stored characters, so the memo cannot grow with the memory table. */
const MEMORY_VERIFIED_MAX_ROWS = 1024;
const MEMORY_VERIFIED_MAX_CHARS = 8 * 1024 * 1024;
const MAX_MEMORY_TAGS = 32;
const MAX_MEMORY_TAG_CHARS = 64;
const MAX_APPROVAL_TTL_MS = 15 * 60 * 1000;
const MEMORY_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const MEMORY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MEMORY_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
// Read only by the _validateSchema invariant for legacy databases at 19, 20 or 21;
// MIGRATION_V22 drops the table this describes.
const DISCORD_GATEWAY_STATES = new Set(['idle', 'connecting', 'ready', 'resuming', 'reconnecting', 'error']);
const TASK_STATES = new Set(['queued', 'leased', 'running', 'retry_wait', 'succeeded', 'failed', 'uncertain', 'cancelled']);
// Expired is a read-time lease projection, never a persisted lifecycle state.
const TASK_READ_STATES = new Set([...TASK_STATES, 'expired']);
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
// V17 AND V18 STILL DECLARE THE RETIRED CORRECTION TABLES. That is not an oversight and it
// is not a live feature: V20 below removes them. This ladder answers "what does a database
// AT version N look like", and _migrate() consults it for the version a database is already
// at before upgrading it. A real database at 17, 18 or 19 has these tables, so describing
// those versions without them makes every existing installation unrecognisable and therefore
// unopenable.
const REQUIRED_SCHEMA_V17 = Object.freeze({
  ...REQUIRED_SCHEMA_V16,
  review_correction_closures: ['closure_family_id', 'source_run_id', 'source_task_id', 'mission_hash', 'owner_revision', 'closure_ref_hash', 'acceptance_ref_hash', 'issuer', 'purpose', 'acceptance_scope', 'catalog_digest', 'status'],
  review_correction_evidence: ['evidence_id', 'closure_family_id', 'source_run_id', 'task_fence', 'owner_revision', 'catalog_digest', 'broker_epoch_digest', 'resolver_policy_digest', 'verifier_catalog_digest', 'verifier_entry_digest', 'taxonomy_catalog_digest', 'projection_policy_digest', 'source_clearance_digest', 'audit_head_sequence', 'audit_head_hash', 'arbiter_epoch', 'arbiter_epoch_digest', 'status'],
  review_correction_handle_events: ['sequence', 'closure_family_id', 'evidence_id', 'event_type', 'reason_code'],
  review_correction_episodes: ['evidence_id', 'episode_json', 'task_class', 'taxonomy', 'check_intent', 'current_verifier_required', 'training_state', 'authority_effect']
});
const REQUIRED_SCHEMA_V18 = Object.freeze({
  ...REQUIRED_SCHEMA_V17,
  review_correction_acceptance_bindings: ['evidence_id', 'closure_family_id', 'source_run_id', 'source_task_id', 'acceptance_hash', 'event_id', 'event_hash', 'baseline_record_hash', 'candidate_record_hash', 'bound_at_ms']
});
const REQUIRED_SCHEMA_V19 = Object.freeze({
  ...REQUIRED_SCHEMA_V18,
  discord_gateway_state: ['provider', 'session_id', 'resume_gateway_url', 'sequence', 'status', 'last_error_code', 'last_event_at_ms', 'updated_at_ms'],
  discord_gateway_lease: ['provider', 'owner_id', 'token_hash', 'fence', 'expires_at_ms', 'updated_at_ms'],
  discord_command_events: ['event_id', 'gateway_sequence', 'channel_id', 'owner_user_id', 'content', 'event_hash', 'received_at_ms']
});
// V20 REMOVES THE RETIRED CORRECTION STORAGE. It is the only step in this ladder that
// SUBTRACTS, so it is spelled as an explicit delete of five named keys rather than as a
// spread of some earlier version. Rebasing it on V16 would look equivalent and would not be:
// V16 also predates the three discord tables V19 added, so that shortcut would silently stop
// requiring them.
const REQUIRED_SCHEMA_V20 = Object.freeze(Object.fromEntries(
  Object.entries(REQUIRED_SCHEMA_V19).filter(([table]) => !table.startsWith('review_correction_'))
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
const PLAINTEXT_SECRET = plaintextCredentialPattern();

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
    // A circle id or inbox id the product minted is not a credential, even when
    // its hex begins `eaa`; any other match in the same text still refuses.
    if (PLAINTEXT_SECRET.test(value) && plaintextCredentialOutsideGeneratedIds(value)) {
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

function assertOnlyKeys(value, allowed, label, code = 'STATE_INVALID_ARGUMENT') {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw stateError(code, `${label} contains unsupported field '${key}'.`, { field: `${label}.${key}` });
  }
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

function iso(ms) {
  return new Date(ms).toISOString();
}

function validUtcDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
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

// Historical acceptance records are kept in the broker's durable state database, not
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

// Capability keeps resolved capability profiles in the existing durable broker state.
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

// Policy dispatch authorizations are intentionally separate from capability profiles:
// Capability grants bounded capability; this append-only record binds one exact
// prepared invocation's broker provenance, target, and canonical argument hash.
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

// Policy confirmation evidence is append-only with the dispatch consumption. It
// references the existing canonical approval grant by opaque ID; the matching
// action/input hash and consumed status are checked transactionally at use.
const MIGRATION_V14 = `
  ALTER TABLE policy_dispatch_consumptions ADD COLUMN approval_id TEXT
    CHECK(approval_id IS NULL OR (length(approval_id) BETWEEN 8 AND 200));
  PRAGMA user_version = 14;
`;

// An approval is a single-use authorization fact.  policy records the exact
// attachment as part of its immutable consumption, so the same consumed grant
// cannot authorize two independently prepared dispatches, even across tasks.
const MIGRATION_V15 = `
  CREATE UNIQUE INDEX policy_dispatch_consumptions_approval_once_idx
    ON policy_dispatch_consumptions(approval_id)
    WHERE approval_id IS NOT NULL;
  PRAGMA user_version = 15;
`;

// Scoped approval keeps the controller-created action, its broker-owned provenance evidence
// reference, UI decision, and final policy dispatch consumption in one durable
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

// MIGRATION_V17 AND V18 STILL CREATE THE RETIRED CORRECTION TABLES, AND THEY HAVE TO.
//
// That correction subsystem is not part of this product -- MIGRATION_V20 below drops these tables
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
// For the same reason the table, trigger and message names inside it are frozen: the
// schema fingerprint covers every name and every trigger body, so renaming any of them
// would make a database written at 17, 18 or 19 unrecognisable.
const MIGRATION_V17 = `
  CREATE TABLE review_correction_closures (
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

  CREATE TABLE review_correction_evidence (
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
    FOREIGN KEY(closure_family_id) REFERENCES review_correction_closures(closure_family_id) ON DELETE RESTRICT,
    FOREIGN KEY(source_run_id) REFERENCES jarvis_workflow_missions(run_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE review_correction_handle_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    closure_family_id TEXT NOT NULL CHECK(length(closure_family_id) = 64 AND closure_family_id NOT GLOB '*[^0-9a-f]*'),
    evidence_id TEXT NOT NULL CHECK(length(evidence_id) = 64 AND evidence_id NOT GLOB '*[^0-9a-f]*'),
    event_type TEXT NOT NULL CHECK(event_type IN ('issued', 'revoked', 'superseded')),
    reason_code TEXT CHECK(reason_code IS NULL OR (length(reason_code) BETWEEN 3 AND 80 AND reason_code NOT GLOB '*[^a-z0-9._-]*')),
    FOREIGN KEY(closure_family_id) REFERENCES review_correction_closures(closure_family_id) ON DELETE RESTRICT,
    FOREIGN KEY(evidence_id) REFERENCES review_correction_evidence(evidence_id) ON DELETE RESTRICT,
    CHECK((event_type = 'issued' AND reason_code IS NULL) OR (event_type IN ('revoked', 'superseded') AND reason_code IS NOT NULL))
  ) STRICT;

  CREATE TABLE review_correction_episodes (
    evidence_id TEXT PRIMARY KEY CHECK(length(evidence_id) = 64 AND evidence_id NOT GLOB '*[^0-9a-f]*'),
    episode_json TEXT NOT NULL CHECK(json_valid(episode_json) AND length(CAST(episode_json AS BLOB)) BETWEEN 2 AND 2048),
    task_class TEXT NOT NULL CHECK(task_class = 'broker-authoritative-workflow'),
    taxonomy TEXT NOT NULL CHECK(taxonomy = 'broker-verified-fault-fix'),
    check_intent TEXT NOT NULL CHECK(check_intent = 'run-current-isolated-adversarial-verifier'),
    current_verifier_required INTEGER NOT NULL CHECK(current_verifier_required = 1),
    training_state TEXT NOT NULL CHECK(training_state = 'quarantined-not-admitted'),
    authority_effect TEXT NOT NULL CHECK(authority_effect = 'none'),
    FOREIGN KEY(evidence_id) REFERENCES review_correction_evidence(evidence_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TRIGGER review_correction_closures_no_update BEFORE UPDATE ON review_correction_closures
    BEGIN SELECT RAISE(ABORT, 'immutable review correction closure'); END;
  CREATE TRIGGER review_correction_closures_no_delete BEFORE DELETE ON review_correction_closures
    BEGIN SELECT RAISE(ABORT, 'immutable review correction closure'); END;
  CREATE TRIGGER review_correction_evidence_no_update BEFORE UPDATE ON review_correction_evidence
    BEGIN SELECT RAISE(ABORT, 'immutable review correction evidence'); END;
  CREATE TRIGGER review_correction_evidence_no_delete BEFORE DELETE ON review_correction_evidence
    BEGIN SELECT RAISE(ABORT, 'immutable review correction evidence'); END;
  CREATE TRIGGER review_correction_handle_events_no_update BEFORE UPDATE ON review_correction_handle_events
    BEGIN SELECT RAISE(ABORT, 'immutable review correction handle event'); END;
  CREATE TRIGGER review_correction_handle_events_no_delete BEFORE DELETE ON review_correction_handle_events
    BEGIN SELECT RAISE(ABORT, 'immutable review correction handle event'); END;
  CREATE TRIGGER review_correction_episodes_no_update BEFORE UPDATE ON review_correction_episodes
    BEGIN SELECT RAISE(ABORT, 'immutable review correction episode'); END;
  CREATE TRIGGER review_correction_episodes_no_delete BEFORE DELETE ON review_correction_episodes
    BEGIN SELECT RAISE(ABORT, 'immutable review correction episode'); END;

  PRAGMA user_version = 17;
`;

const MIGRATION_V18 = `
  CREATE TABLE review_correction_acceptance_bindings (
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
    FOREIGN KEY(evidence_id) REFERENCES review_correction_evidence(evidence_id) ON DELETE RESTRICT,
    FOREIGN KEY(closure_family_id) REFERENCES review_correction_closures(closure_family_id) ON DELETE RESTRICT,
    FOREIGN KEY(source_run_id) REFERENCES jarvis_workflow_acceptances(run_id) ON DELETE RESTRICT,
    FOREIGN KEY(source_task_id) REFERENCES tasks(id) ON DELETE RESTRICT,
    FOREIGN KEY(event_id) REFERENCES jarvis_workflow_events(event_id) ON DELETE RESTRICT
  ) STRICT;
  CREATE TRIGGER review_correction_acceptance_bindings_no_update BEFORE UPDATE ON review_correction_acceptance_bindings
    BEGIN SELECT RAISE(ABORT, 'immutable review correction acceptance binding'); END;
  CREATE TRIGGER review_correction_acceptance_bindings_no_delete BEFORE DELETE ON review_correction_acceptance_bindings
    BEGIN SELECT RAISE(ABORT, 'immutable review correction acceptance binding'); END;
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

// V20 REMOVES THE RETIRED CORRECTION STORAGE FROM THIS PRODUCT.
//
// A retired external correction subsystem is not part of ToolsEnabled and was believed to
// have been removed already. It had not: this store carried its five tables, ten triggers
// and its whole projection path, and that subsystem's loop module shipped in the
// installer payload because THIS FILE named it in a require().
//
// THE TABLES NAMED BELOW ARE THE REMOVAL, NOT A REMNANT. A table cannot be dropped without
// being named, so these names exist here to delete what MIGRATION_V17 and MIGRATION_V18
// above created on databases written at those versions.
//
// THIS DROP WAS PROVEN NON-DESTRUCTIVE BEFORE IT WAS WRITTEN, not assumed to be. All five
// tables held ZERO rows in the live database, and they could not have held any: the feature
// was gated on a policy file that does not exist in either tree and has never been
// shipped, so classifyContract() could never return eligible.
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
  DROP TRIGGER IF EXISTS review_correction_acceptance_bindings_no_update;
  DROP TRIGGER IF EXISTS review_correction_acceptance_bindings_no_delete;
  DROP TRIGGER IF EXISTS review_correction_episodes_no_update;
  DROP TRIGGER IF EXISTS review_correction_episodes_no_delete;
  DROP TRIGGER IF EXISTS review_correction_handle_events_no_update;
  DROP TRIGGER IF EXISTS review_correction_handle_events_no_delete;
  DROP TRIGGER IF EXISTS review_correction_evidence_no_update;
  DROP TRIGGER IF EXISTS review_correction_evidence_no_delete;
  DROP TRIGGER IF EXISTS review_correction_closures_no_update;
  DROP TRIGGER IF EXISTS review_correction_closures_no_delete;
  DROP TABLE IF EXISTS review_correction_acceptance_bindings;
  DROP TABLE IF EXISTS review_correction_episodes;
  DROP TABLE IF EXISTS review_correction_handle_events;
  DROP TABLE IF EXISTS review_correction_evidence;
  DROP TABLE IF EXISTS review_correction_closures;
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
// Discord is not part of ToolsEnabled (product rule). Its agent tools, its provider module, its UI row and its readiness surface were
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
// itself. On a live database both still hold exactly the row V19 inserted
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
// Telegram is no longer integrated (product rule), because the product now ships
// its own mobile app. The bridge, the pulse, the command dispatcher,
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
// and MIGRATION_V1 inserts both rows itself. On a live database both still hold
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
    this._verifiedMemoryRows = new Map();
    this._verifiedMemoryChars = 0;
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
        // SQLite's NOCASE folds ASCII only, so memory search found "café" but
        // not "CAFÉ". te_fold() folds any script the way foldSearchText does.
        this._unicodeFold = typeof db.function === 'function';
        if (this._unicodeFold) db.function('te_fold', { deterministic: true }, value => (value === null || value === undefined ? value : foldSearchText(String(value))));
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
          const normalizedAction = row.action === 'instagram.publishImage' ? 'instagram.publish_image' : row.action;
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
          throw stateError('POLICY_APPROVAL_EVIDENCE_REPLAYED', 'State migration found an approval grant attached to multiple policy dispatches.', {
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
    }
  }

  close() {
    this._verifiedMemoryRows?.clear();
    this._verifiedMemoryChars = 0;
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

  _memoryRowVerifiedBefore(row) {
    const known = this._verifiedMemoryRows?.get(`${row.namespace}\u0000${row.entry_key}`);
    return Boolean(known)
      && known.valueJson === row.value_json
      && known.valueHash === row.value_hash
      && known.tagsJson === row.tags_json
      && known.note === row.note;
  }

  _rememberVerifiedMemoryRow(row) {
    if (!this._verifiedMemoryRows) {
      this._verifiedMemoryRows = new Map();
      this._verifiedMemoryChars = 0;
    }
    const key = `${row.namespace}\u0000${row.entry_key}`;
    const prior = this._verifiedMemoryRows.get(key);
    if (prior) {
      this._verifiedMemoryRows.delete(key);
      this._verifiedMemoryChars -= prior.chars;
    }
    const chars = key.length + row.value_json.length + row.value_hash.length + row.tags_json.length
      + (row.note === null ? 0 : row.note.length);
    this._verifiedMemoryRows.set(key, {
      valueJson: row.value_json, valueHash: row.value_hash, tagsJson: row.tags_json, note: row.note, chars
    });
    this._verifiedMemoryChars += chars;
    while (this._verifiedMemoryRows.size > MEMORY_VERIFIED_MAX_ROWS || this._verifiedMemoryChars > MEMORY_VERIFIED_MAX_CHARS) {
      const [oldestKey, oldest] = this._verifiedMemoryRows.entries().next().value;
      this._verifiedMemoryRows.delete(oldestKey);
      this._verifiedMemoryChars -= oldest.chars;
    }
  }

  _memoryRow(row) {
    if (!row) return null;
    const value = parseJson(row.value_json, 'memory value');
    let tags;
    if (this._memoryRowVerifiedBefore(row)) {
      tags = parseJson(row.tags_json, 'memory tags');
    } else {
      const valueJson = canonicalJson(value);
      if (valueJson !== row.value_json || hashText(valueJson) !== row.value_hash) {
        throw stateError('MEMORY_ENTRY_INVALID', 'A stored memory value failed its canonical integrity check.', {
          namespace: row.namespace, key: row.entry_key
        });
      }
      assertNoPlaintextMemorySecrets(value, 'stored memory value');
      tags = parseJson(row.tags_json, 'memory tags');
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
      this._rememberVerifiedMemoryRow(row);
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

  /* EVERY ROW IN ONE NAMESPACE, REMOVED, AND THE COUNT RETURNED.
   *
   * Recovery only. An installation that ran a release where the public memory
   * tools could reach Fleet's reserved namespaces may hold a row an agent wrote,
   * and a forged row is indistinguishable from a legitimate one after the fact --
   * so the only honest repair is to reset the namespace, which is a decision for
   * the person, taken with Fleet stopped. recover-state.js is the only caller.
   *
   * This is NOT reachable from the memory tools: those expose get, set and search
   * and refuse these namespaces outright. Adding it here does not widen them. */
  clearMemoryNamespace({ namespace } = {}) {
    const checked = assertString(namespace, 'namespace', { max: 100, pattern: MEMORY_NAMESPACE_PATTERN });
    return this.transaction(db => db.prepare('DELETE FROM memory_entries WHERE namespace = ?').run(checked).changes);
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

  /* THE KEYS IN ONE NAMESPACE, AND NOTHING ELSE.
   *
   * system.doctor has to say whether Fleet's own reserved namespaces hold rows
   * and whether the modules that own them can still parse those rows. It must do
   * that without putting retained message bodies in front of anyone, so this
   * returns keys only and never a value. Read-only, and not reachable from the
   * public memory tools, which refuse these namespaces outright. */
  memoryKeys({ namespace } = {}) {
    const checked = assertString(namespace, 'namespace', { max: 100, pattern: MEMORY_NAMESPACE_PATTERN });
    return this._read(db => db.prepare('SELECT entry_key FROM memory_entries WHERE namespace = ? ORDER BY entry_key ASC')
      .all(checked).map(row => row.entry_key));
  }

  searchMemory(input = {}) {
    const source = assertPlainObject(input, 'memory search');
    const query = assertString(source.query, 'query', { max: 256 });
    if (!query.trim()) throw stateError('STATE_INVALID_ARGUMENT', 'query must contain at least one non-whitespace character.', { field: 'query' });
    const namespace = source.namespace === undefined
      ? undefined : assertString(source.namespace, 'namespace', { max: 100, pattern: MEMORY_NAMESPACE_PATTERN });
    const limit = assertInteger(source.limit === undefined ? 10 : source.limit, 'limit', { min: 1, max: 20 });
    /* Namespaces this caller may not see. providers/memory.js passes its own
     * internal set so the exclusion lands in SQL, BEFORE the row limit:
     * filtering the returned page instead would hand back a short or empty page
     * whenever excluded rows sorted first, which reads as "no matches". */
    const exclude = source.excludeNamespaces === undefined ? [] : (() => {
      if (!Array.isArray(source.excludeNamespaces)) {
        throw stateError('STATE_INVALID_ARGUMENT', 'excludeNamespaces must be an array of namespaces.', { field: 'excludeNamespaces' });
      }
      if (source.excludeNamespaces.length > 32) {
        throw stateError('STATE_INVALID_ARGUMENT', 'excludeNamespaces exceeds 32 entries.', { field: 'excludeNamespaces' });
      }
      return source.excludeNamespaces.map((value, index) =>
        assertString(value, `excludeNamespaces[${index}]`, { max: 100, pattern: MEMORY_NAMESPACE_PATTERN }));
    })();
    return this._read(db => {
      // Fold the query before escaping it: folding can turn a compatibility
      // character (a full-width percent sign, say) into a wildcard, and the
      // query stays a literal substring either way.
      const folded = this._unicodeFold ? foldSearchText(query) : query;
      const like = text => `%${text.replace(/[\\%_]/g, character => `\\${character}`)}%`;
      const pattern = like(folded);
      // Values are stored as JSON text, where a quote, a backslash, a tab or
      // a line break is written escaped: the query is matched there in the
      // same escaped form too, or a value such as 'He said "ship it"' was
      // not found by its own words.
      const valuePattern = like(JSON.stringify(folded).slice(1, -1));
      const column = name => (this._unicodeFold ? `te_fold(${name}) LIKE ? ESCAPE '\\'` : `${name} LIKE ? ESCAPE '\\' COLLATE NOCASE`);
      const where = `(${column('namespace')} OR ${column('entry_key')} OR ${column('note')} OR ${column('tags_json')} OR ${column('value_json')} OR ${column('value_json')})`;
      const skip = exclude.length ? ` AND namespace NOT IN (${exclude.map(() => '?').join(', ')})` : '';
      const rows = namespace === undefined
        ? db.prepare(`SELECT * FROM memory_entries WHERE ${where}${skip}
          ORDER BY updated_at_ms DESC, namespace ASC, entry_key ASC LIMIT ?`).all(pattern, pattern, pattern, pattern, pattern, valuePattern, ...exclude, limit)
        : db.prepare(`SELECT * FROM memory_entries WHERE namespace = ? AND ${where}${skip}
          ORDER BY updated_at_ms DESC, entry_key ASC LIMIT ?`).all(namespace, pattern, pattern, pattern, pattern, pattern, valuePattern, ...exclude, limit);
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
    if (!authorization) throw stateError('POLICY_AUTHORIZATION_MISSING', 'The policy dispatch authorization was not found.', { authorizationId });
    if (authorization.tool_name !== toolName || !equalHash(authorization.args_hash, argsHash)) {
      throw stateError('POLICY_AUTHORIZATION_BINDING_MISMATCH', 'The policy authorization is not bound to these exact tool arguments.', { authorizationId });
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
      throw stateError('CAPABILITY_MANIFEST_BINDING_MISMATCH', 'The capability profile no longer matches this policy authorization.', { authorizationId });
    }
    if (now >= profile.expires_at_ms) throw stateError('CAPABILITY_MANIFEST_EXPIRED', 'The capability profile expired before dispatch.', { authorizationId });
    if (db.prepare(`SELECT 1 FROM capability_profile_revocations WHERE profile_id = ? AND profile_version = ?`).get(authorization.profile_id, authorization.profile_version)) {
      throw stateError('CAPABILITY_MANIFEST_REVOKED', 'The capability profile was revoked before dispatch.', { authorizationId });
    }
    const request = db.prepare(`SELECT * FROM capability_profile_requests WHERE request_hash = ?`).get(authorization.request_hash);
    const bound = request && parseJson(request.request_json, 'authorized capability request');
    if (!request || request.status !== 'authorized' || request.request_kind !== 'tool' || request.task_id !== authorization.task_id
      || request.profile_id !== authorization.profile_id || request.profile_version !== authorization.profile_version
      || !equalHash(request.profile_hash, authorization.profile_hash) || !bound || !bound.request
      || bound.request.tool !== authorization.tool_name || bound.request.taskId !== authorization.task_id) {
      throw stateError('POLICY_CAPABILITY_REQUEST_MISMATCH', 'The capability request no longer binds this policy authorization.', { authorizationId });
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
    catch (error) { throw stateError('SCOPED_APPROVAL_PROVENANCE_INVALID', 'Scoped approval provenance must be a canonical broker provenance envelope.', { evidenceId }, error); }
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
        throw stateError('SCOPED_APPROVAL_ACTION_CONFLICT', 'A policy authorization already has a different immutable scoped approval action.', { authorizationId });
      }
      const authorization = this._assertP13DispatchBinding(db, authorizationId,
        db.prepare('SELECT tool_name FROM policy_dispatch_authorizations WHERE authorization_id = ?').get(authorizationId)?.tool_name || '', parametersHash, now);
      const provenanceRecord = db.prepare('SELECT * FROM scoped_approval_provenance WHERE evidence_id = ?').get(provenanceEvidenceId);
      if (!provenanceRecord || provenanceRecord.task_id !== authorization.task_id) {
        throw stateError('SCOPED_APPROVAL_PROVENANCE_MISMATCH', 'The broker-owned provenance evidence is not bound to this policy task.', { authorizationId, provenanceEvidenceId });
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
      if (!action) throw stateError('APPROVAL_REQUIRED', 'The policy action has no controller-created scoped approval.', { authorizationId });
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
        throw stateError('POLICY_AUTHORIZATION_REPLAYED', 'The policy dispatch authorization was already consumed.', { authorizationId });
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

  _leaseMs(value, label = 'leaseMs') {
    return assertInteger(value, label, { min: 1000, max: 24 * 60 * 60 * 1000 });
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
    const source = assertPlainObject(input, 'Policy dispatch authorization');
    const allowed = ['authorizationId', 'taskId', 'toolName', 'argsHash', 'targetKind', 'targetHash', 'provenance', 'risk', 'delegationDepth', 'userKind', 'requestHash'];
    if (Object.keys(source).some(key => !allowed.includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'Policy dispatch authorization contains unsupported fields.', { field: 'Policy dispatch authorization' });
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
      throw stateError('POLICY_PROVENANCE_AUTHORITY_UNAVAILABLE', 'Raw broker provenance cannot grant policy dispatch authority; a future broker-owned reference is required.', {});
    }
    const provenanceJson = 'null';
    return this.transaction(db => {
      const now = this._now();
      const request = db.prepare(`SELECT * FROM capability_profile_requests WHERE request_hash = ?`).get(requestHash);
      if (!request || request.status !== 'authorized' || request.request_kind !== 'tool' || request.task_id !== taskId) {
        throw stateError('POLICY_CAPABILITY_REQUEST_MISSING', 'Policy dispatch authorization requires an existing authorized capability tool request.', { taskId });
      }
      const bound = parseJson(request.request_json, 'authorized capability request');
      if (!bound || !bound.request || bound.request.taskId !== taskId || bound.request.tool !== toolName
        || bound.profileHash !== request.profile_hash || bound.requestHash !== request.request_hash) {
        throw stateError('POLICY_CAPABILITY_REQUEST_MISMATCH', 'The capability request does not bind this exact policy tool action.', { toolName });
      }
      const profile = db.prepare(`SELECT * FROM capability_profile_versions WHERE profile_id = ? AND version = ?`).get(request.profile_id, request.profile_version);
      if (!profile || !equalHash(profile.manifest_hash, request.profile_hash) || profile.task_id !== taskId) {
        throw stateError('CAPABILITY_MANIFEST_BINDING_MISMATCH', 'The capability profile no longer matches this policy authorization.', { taskId });
      }
      if (now >= profile.expires_at_ms) throw stateError('CAPABILITY_MANIFEST_EXPIRED', 'The capability profile expired before policy authorization.', { taskId });
      if (db.prepare(`SELECT 1 FROM capability_profile_revocations WHERE profile_id = ? AND profile_version = ?`).get(request.profile_id, request.profile_version)) {
        throw stateError('CAPABILITY_MANIFEST_REVOKED', 'The capability profile was revoked before policy authorization.', { taskId });
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
    const source = assertPlainObject(input, 'Policy dispatch consumption');
    if (Object.keys(source).some(key => !['authorizationId', 'toolName', 'argsHash', 'approvalId', 'approvalInputHash'].includes(key))) throw stateError('STATE_INVALID_ARGUMENT', 'Policy dispatch consumption contains unsupported fields.', { field: 'Policy dispatch consumption' });
    const authorizationId = assertString(source.authorizationId, 'authorizationId', { min: 8, max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/ });
    const toolName = assertString(source.toolName, 'toolName', { min: 3, max: 200, pattern: /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/ });
    const argsHash = assertString(source.argsHash, 'argsHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    const approvalId = source.approvalId === undefined || source.approvalId === null ? null : assertString(source.approvalId, 'approvalId', { min: 8, max: 200 });
    const approvalInputHash = source.approvalInputHash === undefined || source.approvalInputHash === null ? null : assertString(source.approvalInputHash, 'approvalInputHash', { min: 64, max: 64, pattern: /^[a-f0-9]{64}$/ });
    if ((approvalId === null) !== (approvalInputHash === null)) throw stateError('STATE_INVALID_ARGUMENT', 'Policy approval evidence must include both ID and input hash.', { field: 'approval evidence' });
    return this.transaction(db => {
      const now = this._now();
      const authorization = this._assertP13DispatchBinding(db, authorizationId, toolName, argsHash, now);
      if (db.prepare(`SELECT 1 FROM policy_dispatch_consumptions WHERE authorization_id = ?`).get(authorizationId)) {
        throw stateError('POLICY_AUTHORIZATION_REPLAYED', 'The policy dispatch authorization was already consumed.', { authorizationId });
      }
      if (approvalId !== null) {
        const approval = db.prepare(`SELECT * FROM approval_grants WHERE id = ?`).get(approvalId);
        if (!approval || approval.status !== 'consumed' || approval.action !== authorization.tool_name || !equalHash(approval.input_hash, approvalInputHash)) {
          throw stateError('POLICY_APPROVAL_EVIDENCE_INVALID', 'The policy approval evidence is not a consumed grant for these exact tool arguments.', { authorizationId, approvalId });
        }
        const attachment = db.prepare(`SELECT authorization_id FROM policy_dispatch_consumptions WHERE approval_id = ?`).get(approvalId);
        if (attachment) {
          throw stateError('POLICY_APPROVAL_EVIDENCE_REPLAYED', 'The policy approval evidence is already attached to another dispatch authorization.', {
            authorizationId,
            approvalId,
            attachedAuthorizationId: attachment.authorization_id
          });
        }
      }
      db.prepare(`INSERT INTO policy_dispatch_consumptions(authorization_id, args_hash, consumed_at_ms, approval_id) VALUES(?, ?, ?, ?)`).run(authorizationId, argsHash, now, approvalId);
      let provenance;
      try {
        const storedProvenance = parseJson(authorization.provenance_json, 'Policy provenance');
        provenance = storedProvenance === null ? null : provenanceEnvelopes.validateEnvelope(storedProvenance);
      } catch (error) { throw stateError('POLICY_PROVENANCE_CORRUPT', 'Stored policy provenance is invalid.', { authorizationId }, error); }
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

  _taskPayload(value) {
    const body = assertPlainObject(value, 'payload');
    const unknown = Object.keys(body).filter(key => !['title', 'objective', 'context'].includes(key));
    if (unknown.length) throw stateError('STATE_INVALID_ARGUMENT', 'payload contains unsupported fields.', { field: 'payload', fields: unknown });
    const normalized = {
      title: assertString(body.title, 'payload.title', { max: 200 }),
      objective: assertString(body.objective, 'payload.objective', { max: 16000 })
    };
    if (body.context !== undefined) normalized.context = assertString(body.context, 'payload.context', { min: 0, max: 32000 });
    assertNoPlaintextTaskSecrets(normalized, 'payload');
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
    const payload = this._taskPayload(source.payload);
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
        throw stateError('TASK_CANCEL_REQUESTED', `Cancellation was requested before task execution started. ${TASK_CANCEL_ACKNOWLEDGE}`, { taskId: current.task.id });
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
        throw stateError('TASK_CANCEL_REQUESTED', `Cancellation was requested before this checkpoint could be saved. ${TASK_CANCEL_ACKNOWLEDGE}`, { taskId: claim.taskId });
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
    assertNoPlaintextTaskSecrets(result, 'result');
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
      throw stateError('TASK_CANCEL_REQUESTED', `Cancellation was requested before task completion could be recorded. ${TASK_CANCEL_ACKNOWLEDGE}`, { taskId: claim.taskId });
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
    let statuses;
    if (source.status !== undefined) {
      if (!TASK_READ_STATES.has(source.status)) throw stateError('STATE_INVALID_ARGUMENT', 'status is invalid.', { field: 'status' });
      statuses = [source.status];
    }
    if (source.statuses !== undefined) {
      statuses = source.statuses;
      if (!Array.isArray(statuses) || statuses.length < 1 || statuses.length > TASK_READ_STATES.size
          || Array.from(statuses).some(status => !TASK_READ_STATES.has(status))
          || new Set(statuses).size !== statuses.length) {
        throw stateError('STATE_INVALID_ARGUMENT', 'statuses must contain unique valid task states.', { field: 'statuses' });
      }
    }
    const now = this._now();
    if (statuses) {
      // Match _taskRow's reported status before ordering/LIMIT. Filtering raw
      // status (or filtering the limited rows afterward) hides expired work.
      // The same captured clock drives this predicate and the returned rows;
      // no reaper or transition runs on this read path.
      clauses.push(`(CASE WHEN status IN ('leased','running') AND lease_expires_at_ms IS NOT NULL AND lease_expires_at_ms <= ?
        THEN CASE WHEN status = 'leased' THEN 'expired' ELSE 'uncertain' END
        ELSE status END) IN (${statuses.map(() => '?').join(',')})`);
      values.push(now, ...statuses);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    values.push(limit);
    return this._read(db => db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at_ms DESC, id DESC LIMIT ?`).all(...values)
      .map(row => this._taskRow(row, { includePayload: false, includeCheckpoint: false, includeResult: false, includeError: false, now })));
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
  // needs the database. That laziness is what let the correction-table removal
  // take this store down quietly on 2026-08-10: the product started clean, then
  // every state-backed tool failed separately with its own error, and the only
  // place that named the missing table was a nested field inside
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


}

function createStateStore(options = {}) {
  return new StateStore(options);
}

let singleton;
let singletonSealed = false;
// Open and validate the durable database before sharing its process-wide
// handle. A missing or altered required table fails at startup.
function getStateStore() {
  if (singletonSealed) {
    throw stateError('STATE_STORE_CLOSED', 'The durable state store was closed for local-data removal. Restart before using it again.');
  }
  if (!singleton) {
    const candidate = createStateStore();
    try {
      candidate.ensureOpen();
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
