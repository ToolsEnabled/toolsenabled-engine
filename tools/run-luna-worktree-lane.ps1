[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepoPath,
  [Parameter(Mandatory = $true)][string]$WorktreePath,
  [Parameter(Mandatory = $true)][string]$ArtifactPath,
  [Parameter(Mandatory = $true)][string]$BaseCommit,
  [Parameter(Mandatory = $true)][string]$LaunchId,
  [Parameter(Mandatory = $true)][string]$LaneId,
  # A queue phase or captured owner-request identifier, never free-form work
  # text. It is independently bound into both the signed launch record and the
  # controller policy.
  [Parameter(Mandatory = $true)][string]$ObjectiveRef,
  # Legacy receipt/key parameters remain accepted for one-way compatibility
  # with old dispatchers, but are deliberately never read or trusted. The
  # canonical audit record below is the only launch authority.
  [Parameter(Mandatory = $false)][string]$LaunchEvidencePath,
  [Parameter(Mandatory = $false)][string]$LaunchPublicKeyPath,
  [Parameter(Mandatory = $true)][string[]]$AllowPath,
  [Parameter(Mandatory = $true)][string]$PromptFile,
  [Parameter(Mandatory = $true)][string]$VerificationProgram,
  [Parameter(Mandatory = $true)][string]$VerificationArgumentsJson,
  [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
  [Parameter(Mandatory = $false)][int]$OutputBudgetBytes = 8388608,
  [Parameter(Mandatory = $false)][string]$CodexExecutablePath,
  [Parameter(Mandatory = $false)][string]$NodeExecutablePath,
  [Parameter(Mandatory = $false)][switch]$AllowVerificationChangedPathArguments,
  # Prompt-complete lanes can be deprived of the shell entirely. The worker
  # then has only its bounded prompt plus apply_patch; deterministic inspection
  # and verification remain controller-owned. This also avoids depending on a
  # long-lived command-host process for source files that do not yet exist.
  [Parameter(Mandatory = $false)][switch]$ApplyPatchOnly,
  # Selects one closed launch/model tuple; callers cannot mix identities,
  # pricing tiers, models, or reasoning efforts.
  [Parameter(Mandatory = $false)][ValidateSet('luna', 'terra', 'sol')][string]$AgentProfile = 'luna',
  # A non-empty prefix is only for deterministic fake-executable tests. The
  # live invocation leaves it empty, so its argv is exactly the Codex command
  # recorded in the manifest. JSON is used so argv values beginning with '-'
  # cannot be mistaken for PowerShell parameters.
  [Parameter(Mandatory = $false)][string]$CodexPrefixArgumentsJson = '[]',
  # Opt in to Codex's named permission-profile path for the one public package
  # registry needed by deterministic JavaScript lanes. This never selects full
  # access: the profile inherits :workspace and allowlists registry.npmjs.org
  # plus exact 127.0.0.1 for lane-local preview/test servers.
  # Existing callers retain the legacy workspace-write sandbox byte-for-byte.
  [Parameter(Mandatory = $false)][switch]$AllowNpmRegistryNetwork,
  # Controller-only, read-only preparation. This emits the exact policy
  # details object to be signed later; it never creates a worktree/artifact,
  # starts Codex, or mutates the canonical ledger.
  [Parameter(Mandatory = $false)][switch]$PreparePolicy
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$script:AgentProfiles = @{
  luna = [ordered]@{ targetAgentId = 'luna'; tier = 'cheap'; tierProposed = $false; model = 'gpt-5.6-luna'; reasoningEffort = 'max' }
  terra = [ordered]@{ targetAgentId = 'terra'; tier = 'standard'; tierProposed = $true; model = 'gpt-5.6-terra'; reasoningEffort = 'xhigh' }
  sol = [ordered]@{ targetAgentId = 'sol'; tier = 'premium'; tierProposed = $true; model = 'gpt-5.6-sol'; reasoningEffort = 'ultra' }
}
$agentProfileValues = $script:AgentProfiles[$AgentProfile]

$script:ExitCode = 20
$script:MaxPromptBytes = 4 * 1024 * 1024
$script:MaxPathLength = 1024
$script:GitTimeoutSeconds = 60
$script:AllowedExitCodesForNoIndex = @(0, 1)
$script:CleanupTimeoutMilliseconds = 5000
$script:MaxInternalOutputBytes = 64 * 1024 * 1024
$script:MaxArtifactFileBytes = 64 * 1024 * 1024
$script:NpmRegistryPermissionProfileName = 'lane-npm-registry'
$script:ChildEnvironmentNames = @(
  'APPDATA', 'CI', 'CODEX_HOME', 'COMPUTERNAME', 'ComSpec', 'HOMEDRIVE',
  'HOMEPATH', 'HOME', 'LANG', 'LOCALAPPDATA', 'NO_COLOR',
  'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
  'ProgramData', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PUBLIC', 'SystemDrive',
  'SystemRoot', 'TEMP', 'TERM', 'TMP', 'USERDOMAIN',
  'USERDOMAIN_ROAMINGPROFILE', 'USERNAME', 'USERPROFILE', 'windir'
)

# This verifier is intentionally self-contained. It opens only the canonical
# control-root ledger in SQLite read-only mode; it does not require audit-store,
# controller-launch-record, runtime, or any module that could choose/open the
# default ledger. It independently checks the exact v3 schema fingerprint,
# signed hash chain, and narrowly scoped launch/policy pair. It emits only a
# bounded {ok,code} verdict; paths, policy values, signatures, and all other
# audit material stay out of its output.
$script:CanonicalAuditVerifier = @'
'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const APPLICATION_ID = 0x54454155;
const SCHEMA_VERSION = 3;
const SCHEMA_FINGERPRINT = 'a6ae700d55de5c3e1fcb1fb5ee42e723c658fc9b0bb66788475050bde3b5c54d';
const ZERO_HASH = '0'.repeat(64);
const MAX_EVENT_BYTES = 64 * 1024;
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const LAUNCH_ID_RE = /^launch_[A-Za-z0-9_-]{16,64}$/;

const mode = process.argv[1];
const dbPath = process.argv[2];
const launchId = process.argv[3];
const expectedPolicy = JSON.parse(process.argv[4]);

function emit(ok, code) {
  process.stdout.write(JSON.stringify({ ok, code }) + '\n');
  // A well-formed negative verdict is still a successful bounded helper
  // execution. The PowerShell boundary rejects on {ok:false,code}; using a
  // nonzero helper exit for that expected policy result would discard the
  // canonical rejection code as a generic runner failure.
  return 0;
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function agentProfile(model, reasoningEffort) {
  if (model === 'gpt-5.6-luna' && reasoningEffort === 'max') return { targetAgentId: 'luna', tier: 'cheap', tierProposed: false };
  if (model === 'gpt-5.6-terra' && reasoningEffort === 'xhigh') return { targetAgentId: 'terra', tier: 'standard', tierProposed: true };
  if (model === 'gpt-5.6-sol' && reasoningEffort === 'ultra') return { targetAgentId: 'sol', tier: 'premium', tierProposed: true };
  return null;
}

function assertScopePacket(value, expectedAgentId) {
  if (!exact(value, ['schemaVersion', 'agentId', 'threadId', 'generatedAt', 'appliedRuleIds', 'rules', 'conflicts', 'grantsAuthority']) ||
      value.schemaVersion !== 1 || value.agentId !== expectedAgentId || value.grantsAuthority !== false ||
      (value.threadId !== null && typeof value.threadId !== 'string') ||
      typeof value.generatedAt !== 'string' || !Number.isSafeInteger(Date.parse(value.generatedAt)) ||
      !Array.isArray(value.appliedRuleIds) || !Array.isArray(value.rules) || !Array.isArray(value.conflicts)) throw new Error('launch scope');
  const ids = [];
  for (const rule of value.rules) {
    if (!exact(rule, ['ruleId', 'ruleKey', 'scopeKind', 'threadId', 'sourceRequestId', 'issuedAt', 'expiresAt', 'decisionSummary', 'evidenceRefs', 'ownerVerbatim']) ||
        typeof rule.ruleId !== 'string' || typeof rule.ruleKey !== 'string' || typeof rule.sourceRequestId !== 'string' ||
        !['global', 'thread'].includes(rule.scopeKind) || !Array.isArray(rule.evidenceRefs) ||
        typeof rule.ownerVerbatim !== 'string' || typeof rule.decisionSummary !== 'string') throw new Error('launch scope rule');
    ids.push(rule.ruleId);
  }
  if (JSON.stringify(ids) !== JSON.stringify(value.appliedRuleIds)) throw new Error('launch scope ids');
  return value.rules;
}

function canonicalJson(value) {
  const seen = new Set();
  function encode(entry, inArray = false, depth = 0) {
    if (depth > 32) throw new Error('canonical depth');
    if (entry === null) return 'null';
    if (entry === undefined) return inArray ? 'null' : undefined;
    if (typeof entry === 'string' || typeof entry === 'boolean') return JSON.stringify(entry);
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new Error('canonical number');
      return JSON.stringify(entry);
    }
    if (typeof entry !== 'object' || typeof entry.toJSON === 'function') throw new Error('canonical type');
    if (seen.has(entry)) throw new Error('canonical circular');
    seen.add(entry);
    let output;
    if (Array.isArray(entry)) {
      output = `[${Array.from({ length: entry.length }, (_, index) => encode(entry[index], true, depth + 1)).join(',')}]`;
    } else {
      if (!plain(entry)) throw new Error('canonical object');
      output = `{${Object.keys(entry).sort().flatMap(key => {
        const encoded = encode(entry[key], false, depth + 1);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      }).join(',')}}`;
    }
    seen.delete(entry);
    return output;
  }
  const json = encode(value);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > MAX_EVENT_BYTES) throw new Error('canonical size');
  return json;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function eventHashInput(row) {
  return Buffer.from(canonicalJson({
    domain: 'toolsenabled.audit.event.v1', sequence: row.sequence,
    eventId: row.event_id, occurredAtMs: row.occurred_at_ms,
    event: JSON.parse(row.event_json), previousHash: row.previous_hash,
    keyId: row.key_id, createdAtMs: row.created_at_ms
  }), 'utf8');
}

function databaseFingerprint(db) {
  const rows = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
  return sha256(JSON.stringify(rows.map(row => [
    row.type, row.name, row.tbl_name, String(row.sql).replace(/\s+/g, ' ').trim()
  ])));
}

function validAgentSandbox(agent) {
  const legacy = agent.sandbox === 'workspace-write';
  const npmProfile = agent.sandbox === 'permission-profile:lane-npm-registry';
  if (!legacy && !npmProfile) return false;
  const args = agent.arguments;
  const sandboxIndex = args.indexOf('--sandbox');
  const ignoreConfigIndex = args.indexOf('--ignore-user-config');
  const hasLegacySandbox = sandboxIndex >= 0 && args[sandboxIndex + 1] === 'workspace-write';
  const requiredProfileArguments = [
    'default_permissions="lane-npm-registry"',
    'permissions.lane-npm-registry.extends=":workspace"',
    'permissions.lane-npm-registry.network.enabled=true',
    'permissions.lane-npm-registry.network.domains={ "registry.npmjs.org" = "allow", "127.0.0.1" = "allow" }',
  ];
  if (legacy) return hasLegacySandbox && !requiredProfileArguments.some(argument => args.includes(argument));
  return sandboxIndex === -1 && ignoreConfigIndex >= 0 &&
    requiredProfileArguments.every(argument => args.indexOf(argument) > ignoreConfigIndex);
}

function assertDraftPolicy(value) {
  if (!exact(value, ['schemaVersion', 'controllerActor', 'launchId', 'laneId', 'objectiveRef', 'baseCommit', 'allowlist', 'prompt', 'verification', 'timeoutSeconds', 'outputBudgetBytes', 'agent'])) {
    throw new Error('policy shape');
  }
  if (value.schemaVersion !== 1 || value.controllerActor !== 'codex' || value.launchId !== launchId ||
      typeof value.laneId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.laneId) ||
      typeof value.objectiveRef !== 'string' || !/^(?:Q(?:[1-9][0-9]{0,2})|R(?:[1-9][0-9]{0,3}))$/.test(value.objectiveRef) ||
      typeof value.baseCommit !== 'string' || !/^[a-f0-9]{40}$/.test(value.baseCommit) ||
      !Array.isArray(value.allowlist) || value.allowlist.length < 1 || value.allowlist.length > 128 ||
      !Number.isSafeInteger(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > 86400 ||
      !Number.isSafeInteger(value.outputBudgetBytes) || value.outputBudgetBytes < 65536 || value.outputBudgetBytes > 67108864) {
    throw new Error('policy values');
  }
  if (!exact(value.prompt, ['path', 'sha256']) || typeof value.prompt.path !== 'string' || !HASH_RE.test(value.prompt.sha256)) throw new Error('policy prompt');
  if (!exact(value.verification, ['program', 'sha256', 'arguments', 'allowChangedPathArguments']) ||
      typeof value.verification.program !== 'string' || !HASH_RE.test(value.verification.sha256) ||
      !Array.isArray(value.verification.arguments) || value.verification.arguments.some(argument => typeof argument !== 'string') ||
      typeof value.verification.allowChangedPathArguments !== 'boolean') throw new Error('policy verifier');
  if (!exact(value.agent, ['program', 'sha256', 'prefixArguments', 'arguments', 'model', 'reasoningEffort', 'sandbox', 'nodePath', 'nodeSha256']) ||
      typeof value.agent.program !== 'string' || !HASH_RE.test(value.agent.sha256) ||
      !Array.isArray(value.agent.prefixArguments) || value.agent.prefixArguments.some(argument => typeof argument !== 'string') ||
      !Array.isArray(value.agent.arguments) || value.agent.arguments.some(argument => typeof argument !== 'string') ||
      !agentProfile(value.agent.model, value.agent.reasoningEffort) || !validAgentSandbox(value.agent) ||
      typeof value.agent.nodePath !== 'string' || !HASH_RE.test(value.agent.nodeSha256) ||
      path.resolve(value.agent.nodePath).toLowerCase() !== path.resolve(process.execPath).toLowerCase()) throw new Error('policy agent');
}

function makeAuditAnchor(row, keyHash) {
  return {
    schemaVersion: 1,
    launchEventId: row.event_id,
    launchSequence: row.sequence,
    launchPreviousHash: row.previous_hash,
    launchEventHash: row.event_hash,
    launchKeyId: row.key_id,
    launchPublicKeyHash: keyHash,
  };
}

function withAuditAnchor(draft, row, keyHash) {
  return { ...draft, auditAnchor: makeAuditAnchor(row, keyHash) };
}

function assertExpectedPolicy(value) {
  if (!exact(value, ['schemaVersion', 'controllerActor', 'launchId', 'laneId', 'objectiveRef', 'baseCommit', 'allowlist', 'prompt', 'verification', 'timeoutSeconds', 'outputBudgetBytes', 'agent', 'auditAnchor'])) {
    throw new Error('policy shape');
  }
  const draft = { ...value };
  delete draft.auditAnchor;
  assertDraftPolicy(draft);
  if (!exact(value.auditAnchor, ['schemaVersion', 'launchEventId', 'launchSequence', 'launchPreviousHash', 'launchEventHash', 'launchKeyId', 'launchPublicKeyHash']) ||
      value.auditAnchor.schemaVersion !== 1 || typeof value.auditAnchor.launchEventId !== 'string' || !ID_RE.test(value.auditAnchor.launchEventId) ||
      !Number.isSafeInteger(value.auditAnchor.launchSequence) || value.auditAnchor.launchSequence < 1 ||
      !HASH_RE.test(value.auditAnchor.launchPreviousHash) || !HASH_RE.test(value.auditAnchor.launchEventHash) ||
      typeof value.auditAnchor.launchKeyId !== 'string' || !ID_RE.test(value.auditAnchor.launchKeyId) ||
      !HASH_RE.test(value.auditAnchor.launchPublicKeyHash)) throw new Error('policy anchor');
  canonicalJson(value);
}

function assertLaunchEvent(event) {
  if (!exact(event, ['timestamp', 'action', 'target', 'details']) || event.action !== 'controller.agent.launch' || event.target !== launchId ||
      typeof event.timestamp !== 'string' || !Number.isSafeInteger(Date.parse(event.timestamp)) ||
      !exact(event.details, ['schemaVersion', 'record']) || event.details.schemaVersion !== 1) throw new Error('launch event');
  const record = event.details.record;
  const profile = agentProfile(expectedPolicy.agent.model, expectedPolicy.agent.reasoningEffort);
  const recordKeys = ['schemaVersion', 'launchId', 'requestingActor', 'targetAgentId', 'tier', 'tierProposed', 'model', 'objectiveRef', 'cap', 'parentLaunchId', 'depth', 'launchedAt', 'terminalState'];
  if (Object.hasOwn(record, 'scopePacket')) recordKeys.push('scopePacket');
  if (!profile || !exact(record, recordKeys) ||
      record.schemaVersion !== 1 || record.launchId !== launchId || !LAUNCH_ID_RE.test(record.launchId) ||
      record.requestingActor !== expectedPolicy.controllerActor || record.targetAgentId !== profile.targetAgentId ||
      record.tier !== profile.tier || record.tierProposed !== profile.tierProposed || record.model !== expectedPolicy.agent.model ||
      record.objectiveRef !== expectedPolicy.objectiveRef || !/^(?:Q(?:[1-9][0-9]{0,2})|R(?:[1-9][0-9]{0,3}))$/.test(record.objectiveRef) ||
      record.parentLaunchId !== null || record.depth !== 0 || record.terminalState !== 'pending' ||
      typeof record.launchedAt !== 'string' || !Number.isSafeInteger(Date.parse(record.launchedAt)) ||
      !exact(record.cap, ['kind', 'value', 'capMs']) || !['turns', 'budget'].includes(record.cap.kind) ||
      !Number.isSafeInteger(record.cap.value) || record.cap.value < 1 || record.cap.value > 100000 ||
      !Number.isSafeInteger(record.cap.capMs) || record.cap.capMs < 60000 || record.cap.capMs > 86400000 ||
      record.cap.capMs < expectedPolicy.timeoutSeconds * 1000) throw new Error('launch record');
  const scopeRules = Object.hasOwn(record, 'scopePacket') ? assertScopePacket(record.scopePacket, profile.targetAgentId) : [];
  if (profile.targetAgentId === 'sol' && !scopeRules.some(rule => rule.ruleKey === 'game.agent.model')) {
    throw new Error('sol scope activation');
  }
  if (Date.now() - Date.parse(record.launchedAt) > record.cap.capMs) throw new Error('launch replay');
}

function assertPolicyEvent(event, policy) {
  if (!exact(event, ['timestamp', 'action', 'target', 'details']) || event.action !== 'controller.agent.launch.policy' ||
      event.target !== launchId || typeof event.timestamp !== 'string' || !Number.isSafeInteger(Date.parse(event.timestamp)) ||
      canonicalJson(event.details) !== canonicalJson(policy)) throw new Error('policy event');
}

function verifyDatabaseIdentity(db) {
  const app = db.prepare('PRAGMA application_id').get().application_id;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (app !== APPLICATION_ID || version !== SCHEMA_VERSION || databaseFingerprint(db) !== SCHEMA_FINGERPRINT) throw new Error('audit schema');
  const pageCount = db.prepare('PRAGMA page_count').get().page_count;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 262144) throw new Error('audit size');
  const sinks = db.prepare('SELECT sink FROM audit_sink_state ORDER BY sink').all().map(row => row.sink);
  if (JSON.stringify(sinks) !== JSON.stringify(['jsonl', 'text']) || db.prepare('SELECT COUNT(*) AS count FROM audit_projection_lease WHERE singleton = 1').get().count !== 1) throw new Error('audit singleton');
}

function selectExactEvents(db, action, target) {
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT event_id FROM audit_events
    WHERE json_extract(event_json, '$.action') = ? AND json_extract(event_json, '$.target') = ?
    ORDER BY sequence LIMIT 3`).all(action, target);
  if (!plan.some(row => String(row.detail).includes('audit_events_action_target_sequence_idx'))) throw new Error('audit selector');
  return db.prepare(`SELECT * FROM audit_events
    WHERE json_extract(event_json, '$.action') = ? AND json_extract(event_json, '$.target') = ?
    ORDER BY sequence LIMIT 3`).all(action, target);
}

function verifySelectedRow(db, row) {
  if (!row || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || typeof row.event_id !== 'string' || !ID_RE.test(row.event_id) ||
      !Number.isSafeInteger(row.occurred_at_ms) || row.occurred_at_ms < 0 || typeof row.event_json !== 'string' ||
      Buffer.byteLength(row.event_json, 'utf8') < 2 || Buffer.byteLength(row.event_json, 'utf8') > MAX_EVENT_BYTES ||
      typeof row.previous_hash !== 'string' || !HASH_RE.test(row.previous_hash) ||
      typeof row.event_hash !== 'string' || !HASH_RE.test(row.event_hash) || typeof row.key_id !== 'string' || !ID_RE.test(row.key_id) ||
      typeof row.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(row.signature) ||
      !Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0) throw new Error('audit row');
  const event = JSON.parse(row.event_json);
  if (!plain(event) || canonicalJson(event) !== row.event_json || row.event_hash !== sha256(eventHashInput(row))) throw new Error('audit hash');
  const keyRow = db.prepare('SELECT key_id, algorithm, public_key_pem, public_key_hash, created_at_ms FROM audit_keys WHERE key_id = ?').get(row.key_id);
  if (!keyRow || keyRow.key_id !== row.key_id || keyRow.algorithm !== 'ed25519' || typeof keyRow.public_key_pem !== 'string' ||
      keyRow.public_key_pem.length < 80 || keyRow.public_key_pem.length > 10000 || typeof keyRow.public_key_hash !== 'string' ||
      !HASH_RE.test(keyRow.public_key_hash) || !Number.isSafeInteger(keyRow.created_at_ms) || keyRow.created_at_ms < 0) throw new Error('audit key shape');
  const key = crypto.createPublicKey(keyRow.public_key_pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('audit key type');
  const keyHash = crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
  if (keyHash !== keyRow.public_key_hash || !crypto.verify(null, Buffer.from(row.event_hash, 'hex'), key, Buffer.from(row.signature, 'base64'))) throw new Error('audit signature');
  return { row, event, keyHash };
}

function getOne(rows, missing, conflict) {
  if (rows.length === 0) return { error: missing };
  if (rows.length !== 1) return { error: conflict };
  return { value: rows[0] };
}

function main() {
  let db;
  let opened = false;
  try {
    if (!['prepare', 'verify'].includes(mode) || typeof dbPath !== 'string' || typeof launchId !== 'string' || !LAUNCH_ID_RE.test(launchId)) throw new Error('arguments');
    assertDraftPolicy(expectedPolicy);
    db = new DatabaseSync(dbPath, { readOnly: true, allowExtension: false, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    opened = true;
    db.exec('PRAGMA query_only = ON');
    verifyDatabaseIdentity(db);
    const launchResult = getOne(selectExactEvents(db, 'controller.agent.launch', launchId), 'CANONICAL_LAUNCH_NOT_FOUND', 'CANONICAL_LAUNCH_CONFLICT');
    if (launchResult.error) return emit(false, launchResult.error);
    const launch = verifySelectedRow(db, launchResult.value);
    try { assertLaunchEvent(launch.event); } catch (error) {
      return emit(false, error.message === 'launch replay' ? 'CANONICAL_LAUNCH_REPLAYED' : 'CANONICAL_LAUNCH_FACTS_MISMATCH');
    }
    const fullPolicy = withAuditAnchor(expectedPolicy, launch.row, launch.keyHash);
    assertExpectedPolicy(fullPolicy);
    const policyRows = selectExactEvents(db, 'controller.agent.launch.policy', launchId);
    if (mode === 'prepare') {
      if (policyRows.length !== 0) return emit(false, 'CANONICAL_POLICY_ALREADY_EXISTS');
      process.stdout.write(canonicalJson(fullPolicy) + '\n');
      return 0;
    }
    const policyResult = getOne(policyRows, 'CANONICAL_POLICY_NOT_FOUND', 'CANONICAL_POLICY_CONFLICT');
    if (policyResult.error) return emit(false, policyResult.error);
    const policy = verifySelectedRow(db, policyResult.value);
    if (policy.row.sequence <= launch.row.sequence || policy.row.key_id !== launch.row.key_id || policy.keyHash !== launch.keyHash) return emit(false, 'CANONICAL_POLICY_MISMATCH');
    try { assertPolicyEvent(policy.event, fullPolicy); } catch { return emit(false, 'CANONICAL_POLICY_MISMATCH'); }
    return emit(true, 'CANONICAL_LAUNCH_VERIFIED');
  } catch {
    return emit(false, opened ? 'CANONICAL_AUDIT_INVALID' : 'CANONICAL_AUDIT_OPEN_FAILED');
  } finally {
    if (db) { try { db.close(); } catch { /* verdict already bounded */ } }
  }
}

process.exitCode = main();
'@

function New-LaneException {
  param(
    [string]$Code,
    [string]$Message,
    [string]$Class = 'preflight'
  )
  $exception = New-Object System.Exception($Message)
  $exception.Data['LaneCode'] = $Code
  $exception.Data['LaneClass'] = $Class
  return $exception
}

function Fail-Lane {
  param([string]$Code, [string]$Message, [string]$Class = 'preflight')
  throw (New-LaneException -Code $Code -Message $Message -Class $Class)
}

function Get-ExceptionData {
  param([System.Exception]$Exception, [string]$Name, [string]$Fallback)
  if ($null -ne $Exception -and $Exception.Data.Contains($Name)) {
    return [string]$Exception.Data[$Name]
  }
  return $Fallback
}

function Get-ExitCodeForClass {
  param([string]$Class)
  switch ($Class) {
    'preflight' { return 10 }
    'harness' { return 20 }
    'model-quality' { return 30 }
    'scope' { return 40 }
    'test' { return 50 }
    default { return 20 }
  }
}

function Set-LaneFailure {
  param(
    [System.Collections.IDictionary]$Manifest,
    [string]$Class,
    [string]$Code,
    [string]$Message,
    [bool]$Eligible = $false
  )
  $Manifest.terminalState = 'rejected'
  $Manifest.failureClass = $Class
  $Manifest.failureCode = $Code
  $Manifest.failureMessage = ([string]$Message).Substring(0, [Math]::Min(2000, ([string]$Message).Length))
  $Manifest.eligibleForDenominator = $Eligible
  if ($Class -eq 'preflight') {
    $Manifest.preflight.state = 'failed'
    $Manifest.preflight.failureCode = $Code
  }
  $script:ExitCode = Get-ExitCodeForClass -Class $Class
}

function Stop-Lane {
  param(
    [System.Collections.IDictionary]$Manifest,
    [string]$Class,
    [string]$Code,
    [string]$Message,
    [bool]$Eligible = $false
  )
  Set-LaneFailure -Manifest $Manifest -Class $Class -Code $Code -Message $Message -Eligible $Eligible
  $exception = New-LaneException -Code $Code -Message $Message -Class $Class
  $exception.Data['TerminalStop'] = $true
  throw $exception
}

function Write-Utf8NoBom {
  param([string]$Path, [string]$Text)
  $encoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
  [System.IO.File]::WriteAllText($Path, [string]$Text, $encoding)
}

function ConvertTo-JsonText {
  param($Value)
  return (ConvertTo-Json -InputObject $Value -Depth 32 -Compress)
}

function Write-TerminalManifest {
  param([System.Collections.IDictionary]$Manifest, [string]$Path)
  $Manifest.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
  Write-Utf8NoBom -Path $Path -Text (ConvertTo-JsonText -Value $Manifest)
}

function Get-FullAbsolutePath {
  param([string]$PathValue, [string]$Name)
  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    Fail-Lane -Code 'PATH_REQUIRED' -Message "$Name is required"
  }
  if (-not [System.IO.Path]::IsPathRooted($PathValue)) {
    Fail-Lane -Code 'PATH_NOT_ABSOLUTE' -Message "$Name must be absolute"
  }
  try {
    $full = [System.IO.Path]::GetFullPath($PathValue)
  } catch {
    Fail-Lane -Code 'PATH_INVALID' -Message "$Name is not a valid filesystem path"
  }
  if ($full.Length -gt $script:MaxPathLength) {
    Fail-Lane -Code 'PATH_TOO_LONG' -Message "$Name exceeds the path length bound"
  }
  return $full
}

function Get-PathComparisonValue {
  param([string]$PathValue)
  $full = [System.IO.Path]::GetFullPath($PathValue)
  $root = [System.IO.Path]::GetPathRoot($full)
  while ($full.Length -gt $root.Length -and ($full.EndsWith('\') -or $full.EndsWith('/'))) {
    $full = $full.Substring(0, $full.Length - 1)
  }
  if ($env:OS -eq 'Windows_NT' -or $env:windir) {
    return $full.ToLowerInvariant()
  }
  return $full
}

function Test-PathContained {
  param([string]$Child, [string]$Root)
  $childValue = Get-PathComparisonValue -PathValue $Child
  $rootValue = Get-PathComparisonValue -PathValue $Root
  if ($childValue -eq $rootValue) { return $true }
  $separator = [System.IO.Path]::DirectorySeparatorChar
  return $childValue.StartsWith($rootValue + $separator, [System.StringComparison]::OrdinalIgnoreCase)
}

function Initialize-ReparseTagReader {
  if ($null -ne ('Q66Lane.ReparseTagReader' -as [type])) { return }
  if (-not ($env:OS -eq 'Windows_NT' -or $env:windir)) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Q66Lane {
  public static class ReparseTagReader {
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FSCTL_GET_REPARSE_POINT = 0x000900A8;
    private const int MAXIMUM_REPARSE_DATA_BUFFER_SIZE = 16 * 1024;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
      string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
      uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool DeviceIoControl(
      SafeFileHandle device, uint controlCode, IntPtr inputBuffer, int inputBufferSize,
      byte[] outputBuffer, int outputBufferSize, out int bytesReturned, IntPtr overlapped);

    public static uint Read(string path) {
      using (SafeFileHandle handle = CreateFileW(
        path, 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, IntPtr.Zero,
        OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        byte[] buffer = new byte[MAXIMUM_REPARSE_DATA_BUFFER_SIZE];
        int bytesReturned;
        if (!DeviceIoControl(handle, FSCTL_GET_REPARSE_POINT, IntPtr.Zero, 0,
          buffer, buffer.Length, out bytesReturned, IntPtr.Zero)) {
          throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        if (bytesReturned < 8) throw new InvalidOperationException("Reparse data is truncated.");
        return BitConverter.ToUInt32(buffer, 0);
      }
    }
  }
}
'@
}

function Get-ReparseTag {
  param([string]$PathValue, [string]$Name)
  if (-not ($env:OS -eq 'Windows_NT' -or $env:windir)) {
    Fail-Lane -Code 'PATH_REPARSE_TAG_UNAVAILABLE' -Message "$Name contains an unsupported reparse component"
  }
  try {
    Initialize-ReparseTagReader
    return [uint32][Q66Lane.ReparseTagReader]::Read($PathValue)
  } catch {
    Fail-Lane -Code 'PATH_REPARSE_TAG_UNAVAILABLE' -Message "$Name contains a reparse component whose tag could not be verified"
  }
}

function Test-ReparseTagIsNameSurrogate {
  param([uint32]$Tag)
  # Windows sets bit 0x20000000 on name-surrogate tags such as symbolic links
  # and mount points.  Cloud-filter placeholders (including the fixed OneDrive
  # ancestors of the canonical Machine-B checkout) are reparse points too, but
  # do not redirect pathname resolution and therefore do not set this bit.
  return (($Tag -band [uint32]0x20000000) -ne 0)
}

function Assert-NoReparseComponents {
  param([string]$PathValue, [string]$Name)
  $full = [System.IO.Path]::GetFullPath($PathValue)
  $root = [System.IO.Path]::GetPathRoot($full)
  $remaining = $full.Substring($root.Length)
  $segments = @($remaining -split '[\\/]')
  $current = $root
  foreach ($segment in $segments) {
    if ([string]::IsNullOrEmpty($segment)) { continue }
    $current = Join-Path -Path $current -ChildPath $segment
    if (-not (Test-Path -LiteralPath $current)) { break }
    $item = Get-Item -LiteralPath $current -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      $tag = Get-ReparseTag -PathValue $current -Name $Name
      if (Test-ReparseTagIsNameSurrogate -Tag $tag) {
        Fail-Lane -Code 'PATH_REPARSE_COMPONENT' -Message "$Name contains a name-surrogate reparse point (symlink or junction): $current"
      }
    }
  }
}

function Get-SafeExistingDirectory {
  param([string]$PathValue, [string]$Name)
  $full = Get-FullAbsolutePath -PathValue $PathValue -Name $Name
  if (-not (Test-Path -LiteralPath $full -PathType Container)) {
    Fail-Lane -Code 'DIRECTORY_NOT_FOUND' -Message "$Name must be an existing directory"
  }
  Assert-NoReparseComponents -PathValue $full -Name $Name
  return $full
}

function Get-SafeExistingFile {
  param([string]$PathValue, [string]$Name)
  $full = Get-FullAbsolutePath -PathValue $PathValue -Name $Name
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
    Fail-Lane -Code 'FILE_NOT_FOUND' -Message "$Name must be an existing regular file"
  }
  Assert-NoReparseComponents -PathValue $full -Name $Name
  $item = Get-Item -LiteralPath $full -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail-Lane -Code 'FILE_REPARSE_POINT' -Message "$Name must not be a symlink or junction"
  }
  return $full
}

function Get-FileHashSnapshot {
  param([string[]]$Paths)
  # Several roles can use one executable. Read its bytes once at this boundary,
  # keeping every file open without write/delete sharing until the snapshot is
  # complete. Nothing is cached across the helper, agent, or verifier runs.
  $streams = New-Object 'System.Collections.Generic.Dictionary[string,System.IO.FileStream]' ([System.StringComparer]::OrdinalIgnoreCase)
  $hashes = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::OrdinalIgnoreCase)
  try {
    foreach ($pathValue in $Paths) {
      if (-not $streams.ContainsKey($pathValue)) {
        try { $streams.Add($pathValue, [System.IO.File]::OpenRead($pathValue)) }
        catch { $_.Exception.Data['LaneHashPath'] = $pathValue; throw }
      }
    }
    foreach ($entry in $streams.GetEnumerator()) {
      try { $hashes.Add($entry.Key, (Get-FileHash -InputStream $entry.Value -Algorithm SHA256).Hash.ToLowerInvariant()) }
      catch { $_.Exception.Data['LaneHashPath'] = $entry.Key; throw }
    }
    return $hashes
  } finally {
    foreach ($stream in $streams.Values) { $stream.Dispose() }
  }
}

function Assert-FileHashesUnchanged {
  param([object[]]$Files)
  $boundFile = $null
  try {
    $paths = @()
    foreach ($boundFile in $Files) {
      $paths += Get-SafeExistingFile -PathValue $boundFile.path -Name $boundFile.name
    }
    $hashes = Get-FileHashSnapshot -Paths $paths
    foreach ($boundFile in $Files) {
      if ($hashes[$boundFile.path] -ne $boundFile.hash) { throw 'hash mismatch' }
    }
  } catch {
    $failedPath = $_.Exception.Data['LaneHashPath']
    if ($null -ne $failedPath) {
      foreach ($file in $Files) {
        if ($file.path -eq $failedPath) { $boundFile = $file; break }
      }
    }
    Fail-Lane -Code $boundFile.code -Message "$($boundFile.name) changed after its controller policy hash was captured" -Class 'harness'
  }
}

function Assert-NewDirectoryTarget {
  param([string]$PathValue, [string]$Name)
  $full = Get-FullAbsolutePath -PathValue $PathValue -Name $Name
  if (Test-Path -LiteralPath $full) {
    Fail-Lane -Code 'WORKTREE_TARGET_EXISTS' -Message "$Name must not already exist"
  }
  $parent = [System.IO.Directory]::GetParent($full).FullName
  if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
    Fail-Lane -Code 'TARGET_PARENT_NOT_FOUND' -Message "$Name parent directory must already exist"
  }
  Assert-NoReparseComponents -PathValue $parent -Name "$Name parent"
  return $full
}

function Assert-EmptyOrCreateArtifactDirectory {
  param([string]$PathValue)
  $full = Get-FullAbsolutePath -PathValue $PathValue -Name 'ArtifactPath'
  if (Test-Path -LiteralPath $full) {
    if (-not (Test-Path -LiteralPath $full -PathType Container)) {
      Fail-Lane -Code 'ARTIFACT_NOT_DIRECTORY' -Message 'ArtifactPath must be a directory'
    }
    Assert-NoReparseComponents -PathValue $full -Name 'ArtifactPath'
    $items = @(Get-ChildItem -LiteralPath $full -Force)
    if ($items.Count -ne 0) {
      Fail-Lane -Code 'ARTIFACT_DIRECTORY_NONEMPTY' -Message 'ArtifactPath must be absent or empty'
    }
    return $full
  }
  $parent = [System.IO.Directory]::GetParent($full).FullName
  if ([string]::IsNullOrWhiteSpace($parent) -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
    Fail-Lane -Code 'ARTIFACT_PARENT_NOT_FOUND' -Message 'ArtifactPath parent directory must already exist'
  }
  Assert-NoReparseComponents -PathValue $parent -Name 'ArtifactPath parent'
  New-Item -ItemType Directory -Path $full -Force:$false | Out-Null
  return $full
}

function Assert-OutsidePath {
  param([string]$PathValue, [string]$Root, [string]$Name)
  if (Test-PathContained -Child $PathValue -Root $Root) {
    Fail-Lane -Code 'PATH_ESCAPES_DECLARED_ROOT' -Message "$Name is inside the writable worktree"
  }
}

function Resolve-ApplicationPath {
  param([string]$Name)
  try {
    $commands = @(Get-Command -Name $Name -CommandType Application -ErrorAction Stop)
    $candidate = if ($commands.Count -gt 0) { [string]$commands[0].Path } else { $null }
  } catch {
    Fail-Lane -Code 'EXECUTABLE_NOT_FOUND' -Message "Unable to resolve $Name"
  }
  if ([string]::IsNullOrWhiteSpace($candidate) -or -not [System.IO.Path]::IsPathRooted($candidate)) {
    Fail-Lane -Code 'EXECUTABLE_NOT_ABSOLUTE' -Message "$Name did not resolve to an absolute path"
  }
  return Get-SafeExistingFile -PathValue $candidate -Name $Name
}

function ConvertTo-WindowsArgument {
  param([AllowNull()][string]$Argument)
  if ($null -eq $Argument -or $Argument.Length -eq 0) { return '""' }
  if ($Argument -notmatch '[\s"]') { return $Argument }
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Argument.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes++
      continue
    }
    if ($character -eq '"') {
      if ($backslashes -gt 0) {
        [void]$builder.Append((('\' * (2 * $backslashes + 1)) -join ''))
      } else {
        [void]$builder.Append('\')
      }
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }
    if ($backslashes -gt 0) {
      [void]$builder.Append((('\' * $backslashes) -join ''))
      $backslashes = 0
    }
    [void]$builder.Append($character)
  }
  if ($backslashes -gt 0) {
    [void]$builder.Append((('\' * (2 * $backslashes)) -join ''))
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function ConvertTo-WindowsArgumentString {
  param([string[]]$Arguments)
  $parts = @()
  foreach ($argument in @($Arguments)) {
    $parts += ConvertTo-WindowsArgument -Argument $argument
  }
  return [string]::Join(' ', $parts)
}

function Set-MinimalChildEnvironment {
  param([System.Diagnostics.ProcessStartInfo]$StartInfo)
  $inheritedNames = @($StartInfo.EnvironmentVariables.Keys | ForEach-Object { [string]$_ })
  $StartInfo.EnvironmentVariables.Clear()
  $keptNames = @()
  foreach ($name in $script:ChildEnvironmentNames) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ($null -ne $value) {
      # Values are copied only for this explicit safe-name allowlist. They are
      # never placed in a manifest, command line, exception, or log.
      $StartInfo.EnvironmentVariables[$name] = [string]$value
      $keptNames += $name
    }
  }
  $dropped = @($inheritedNames | Where-Object { $keptNames -notcontains $_ } | Sort-Object -Unique)
  return [pscustomobject]@{ allowedNames = @($keptNames | Sort-Object -Unique); droppedNames = $dropped }
}

function Initialize-BoundedCaptureType {
  if ($null -ne ('Q66Lane.BoundedCaptureSession' -as [type])) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Collections;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Q66Lane {
  public sealed class BoundedCaptureSession {
    private readonly object gate = new object();
    private readonly long budget;
    private readonly bool inMemory;
    private readonly MemoryStream stdoutMemory;
    private readonly MemoryStream stderrMemory;
    private readonly Task stdoutTask;
    private readonly Task stderrTask;
    private long totalBytes;
    private long stdoutBytes;
    private long stderrBytes;
    private volatile bool overflowed;
    private volatile bool readerError;

    public BoundedCaptureSession(ContainedProcess process, string stdoutPath, string stderrPath, long byteBudget) {
      if (process == null) throw new ArgumentNullException("process");
      if (byteBudget < 1) throw new ArgumentOutOfRangeException("byteBudget");
      budget = byteBudget;
      inMemory = String.IsNullOrEmpty(stdoutPath) && String.IsNullOrEmpty(stderrPath);
      if (inMemory) {
        stdoutMemory = new MemoryStream();
        stderrMemory = new MemoryStream();
      }
      stdoutTask = Task.Factory.StartNew(() => Drain(process.StandardOutput.BaseStream, stdoutPath, true),
        CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
      stderrTask = Task.Factory.StartNew(() => Drain(process.StandardError.BaseStream, stderrPath, false),
        CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    private void Drain(Stream input, string path, bool stdout) {
      FileStream file = null;
      try {
        if (!inMemory && !String.IsNullOrEmpty(path)) {
          file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 8192, FileOptions.SequentialScan);
        }
        byte[] buffer = new byte[8192];
        while (true) {
          int count;
          try { count = input.Read(buffer, 0, buffer.Length); }
          catch { break; }
          if (count <= 0) break;
          lock (gate) {
            long remaining = budget - totalBytes;
            int keep = remaining <= 0 ? 0 : (int)Math.Min((long)count, remaining);
            if (keep > 0) {
              if (inMemory) {
                (stdout ? stdoutMemory : stderrMemory).Write(buffer, 0, keep);
              } else {
                file.Write(buffer, 0, keep);
              }
              totalBytes += keep;
              if (stdout) stdoutBytes += keep; else stderrBytes += keep;
            }
            if (keep < count) overflowed = true;
          }
        }
      } catch { readerError = true; }
      finally { if (file != null) { try { file.Dispose(); } catch { } } }
    }

    public bool Overflowed { get { return overflowed; } }
    public bool ReaderError { get { return readerError; } }
    public long TotalBytes { get { return Interlocked.Read(ref totalBytes); } }
    public long StdoutBytes { get { return Interlocked.Read(ref stdoutBytes); } }
    public long StderrBytes { get { return Interlocked.Read(ref stderrBytes); } }

    public bool WaitForReaders(int milliseconds) {
      if (milliseconds < 1) milliseconds = 1;
      try { return Task.WaitAll(new Task[] { stdoutTask, stderrTask }, milliseconds); }
      catch { return false; }
    }

    public string StdoutText() {
      if (!inMemory) return String.Empty;
      lock (gate) { return Encoding.UTF8.GetString(stdoutMemory.ToArray()); }
    }

    public string StderrText() {
      if (!inMemory) return String.Empty;
      lock (gate) { return Encoding.UTF8.GetString(stderrMemory.ToArray()); }
    }
  }
}

namespace Q66Lane {
  // Every workload is born suspended, assigned to its own non-breakaway Job,
  // and observed through retained handles. Numeric process ids are evidence,
  // never termination capabilities or a later process-tree lookup.
  public sealed class ContainedProcess : IDisposable {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Startup {
      public uint cb;
      public string reserved, desktop, title;
      public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
      public short show, reservedSize;
      public IntPtr reservedBytes, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct StartupEx { public Startup startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
      public long processTime, jobTime;
      public uint flags;
      public UIntPtr minimum, maximum;
      public uint activeLimit;
      public UIntPtr affinity;
      public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
      public BasicLimits basic;
      public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
      public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting {
      public long user, kernel, periodUser, periodKernel;
      public uint faults, total, active, terminated;
    }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string file, StringBuilder command, IntPtr pa, IntPtr ta,
      bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    private static extern bool QueryRaw(IntPtr job, int kind, IntPtr info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
      IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr job, root, thread;
    private bool assigned;
    private AnonymousPipeServerStream inputPipe, outputPipe, errorPipe;
    public ProcessStartInfo StartInfo { get; set; }
    public StreamWriter StandardInput { get; private set; }
    public StreamReader StandardOutput { get; private set; }
    public StreamReader StandardError { get; private set; }
    public int Id { get; private set; }
    public string StartTicks { get; private set; }

    private static void Require(bool ok, string message) {
      if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), message);
    }
    private static void Close(ref IntPtr handle) {
      if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }
    public bool Start() {
      if (job != IntPtr.Zero || root != IntPtr.Zero) throw new InvalidOperationException("Already started");
      if (StartInfo == null || !Path.IsPathRooted(StartInfo.FileName) || StartInfo.FileName.Contains("\""))
        throw new ArgumentException("An absolute executable is required");
      IntPtr attributes = IntPtr.Zero, handles = IntPtr.Zero, environment = IntPtr.Zero;
      bool attributesReady = false;
      try {
        job = CreateJobObject(IntPtr.Zero, null);
        Require(job != IntPtr.Zero, "Job creation failed");
        ExtendedLimits limits = new ExtendedLimits();
        limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway flags.
        Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "Job limits failed");
        inputPipe = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable);
        outputPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
        errorPipe = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable);
        IntPtr[] childHandles = { inputPipe.ClientSafePipeHandle.DangerousGetHandle(),
          outputPipe.ClientSafePipeHandle.DangerousGetHandle(), errorPipe.ClientSafePipeHandle.DangerousGetHandle() };
        IntPtr bytes = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
        if (bytes == IntPtr.Zero) throw new InvalidOperationException("Attribute size unavailable");
        attributes = Marshal.AllocHGlobal(bytes);
        Require(InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes), "Attribute initialization failed");
        attributesReady = true;
        handles = Marshal.AllocHGlobal(IntPtr.Size * childHandles.Length);
        Marshal.Copy(childHandles, 0, handles, childHandles.Length);
        Require(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles,
          new IntPtr(IntPtr.Size * childHandles.Length), IntPtr.Zero, IntPtr.Zero), "Handle allowlist failed");
        StartupEx startup = new StartupEx();
        startup.startup.cb = (uint)Marshal.SizeOf(typeof(StartupEx));
        startup.startup.flags = 0x101; // USESTDHANDLES | USESHOWWINDOW (hidden).
        startup.startup.stdin = childHandles[0];
        startup.startup.stdout = childHandles[1];
        startup.startup.stderr = childHandles[2];
        startup.attributes = attributes;
        var names = new System.Collections.Generic.List<string>();
        foreach (DictionaryEntry entry in StartInfo.EnvironmentVariables) names.Add((string)entry.Key);
        names.Sort(StringComparer.OrdinalIgnoreCase);
        StringBuilder block = new StringBuilder();
        foreach (string name in names) {
          string value = StartInfo.EnvironmentVariables[name];
          if (name.IndexOf('\0') >= 0 || name.IndexOf('=') >= 0 || value == null || value.IndexOf('\0') >= 0)
            throw new ArgumentException("Invalid environment entry");
          block.Append(name).Append('=').Append(value).Append('\0');
        }
        block.Append('\0');
        environment = Marshal.StringToHGlobalUni(block.ToString());
        ProcessInfo info;
        // CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT |
        // EXTENDED_STARTUPINFO_PRESENT. Only the three private pipe ends inherit.
        Require(CreateProcessW(StartInfo.FileName, new StringBuilder("\"" + StartInfo.FileName + "\" " + StartInfo.Arguments),
          IntPtr.Zero, IntPtr.Zero, true, 0x08080404, environment, StartInfo.WorkingDirectory, ref startup, out info), "Child creation failed");
        root = info.process; thread = info.thread; Id = checked((int)info.pid);
        long created, exited, kernel, user;
        Require(GetProcessTimes(root, out created, out exited, out kernel, out user), "Child identity unavailable");
        StartTicks = DateTime.FromFileTimeUtc(created).Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture);
        Require(AssignProcessToJobObject(job, root), "Suspended child assignment failed");
        assigned = true;
        StandardInput = new StreamWriter(inputPipe, new UTF8Encoding(false)) { AutoFlush = true };
        StandardOutput = new StreamReader(outputPipe, Encoding.UTF8);
        StandardError = new StreamReader(errorPipe, Encoding.UTF8);
        Require(ResumeThread(thread) != UInt32.MaxValue, "Contained child resume failed");
        Close(ref thread);
        return true;
      } finally {
        if (inputPipe != null) inputPipe.DisposeLocalCopyOfClientHandle();
        if (outputPipe != null) outputPipe.DisposeLocalCopyOfClientHandle();
        if (errorPipe != null) errorPipe.DisposeLocalCopyOfClientHandle();
        if (attributesReady) DeleteProcThreadAttributeList(attributes);
        if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
        if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
      }
    }
    public bool WaitForExit(int milliseconds) {
      if (root == IntPtr.Zero || milliseconds < 0) throw new InvalidOperationException("Original process handle unavailable");
      uint result = WaitForSingleObject(root, (uint)milliseconds);
      if (result == 0) return true;
      if (result == 258) return false;
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Original process wait failed");
    }
    public bool HasExited { get { return WaitForExit(0); } }
    public int ExitCode {
      get {
        if (!HasExited) throw new InvalidOperationException("Original process is not signalled");
        uint code;
        Require(GetExitCodeProcess(root, out code), "Original exit code unavailable");
        return unchecked((int)code); // 259 is a valid exit after the handle signals.
      }
    }
    private Accounting ReadAccounting() {
      if (job == IntPtr.Zero) throw new InvalidOperationException("Original Job handle unavailable");
      Accounting result;
      Require(QueryInformationJobObject(job, 1, out result, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "Job accounting unavailable");
      return result;
    }
    public uint ActiveProcesses { get { return ReadAccounting().active; } }
    public uint TotalProcesses { get { return ReadAccounting().total; } }
    public long[] ProcessIds() {
      IntPtr data = Marshal.AllocHGlobal(4096);
      try {
        Require(QueryRaw(job, 3, data, 4096, IntPtr.Zero), "Job members unavailable");
        int count = Marshal.ReadInt32(data, 4);
        if (count < 0 || count > (4096 - 8) / IntPtr.Size) throw new InvalidOperationException("Invalid Job members");
        long[] result = new long[count];
        for (int i = 0; i < count; i++) result[i] = Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64();
        return result;
      } finally { Marshal.FreeHGlobal(data); }
    }
    public bool WaitForEmpty(int milliseconds) {
      Stopwatch clock = Stopwatch.StartNew();
      do { if (ActiveProcesses == 0) return true; Thread.Sleep(10); }
      while (clock.ElapsedMilliseconds < milliseconds);
      return ActiveProcesses == 0;
    }
    public bool Stop(int milliseconds) {
      // Start may fail before assignment. Even that suspended root is stopped
      // only using its original handle; no OpenProcess/taskkill/PID fallback.
      if (job != IntPtr.Zero && ActiveProcesses != 0) Require(TerminateJobObject(job, 124), "Owned Job termination failed");
      if (!assigned && root != IntPtr.Zero && !HasExited) {
        if (!TerminateProcess(root, 124) && !HasExited) throw new Win32Exception(Marshal.GetLastWin32Error(), "Original root termination failed");
      }
      bool empty = job == IntPtr.Zero || WaitForEmpty(milliseconds);
      return empty && (root == IntPtr.Zero || WaitForExit(milliseconds));
    }
    public void Dispose() {
      Close(ref job); // Retained non-inherited KILL_ON_JOB_CLOSE backstop.
      Close(ref thread); Close(ref root);
      if (inputPipe != null) inputPipe.Dispose();
      if (outputPipe != null) outputPipe.Dispose();
      if (errorPipe != null) errorPipe.Dispose();
    }
  }
}
'@ -ErrorAction Stop
}

function Stop-ProcessTree {
  param([Q66Lane.ContainedProcess]$Process)
  try { return $Process.Stop($script:CleanupTimeoutMilliseconds) }
  catch { return $false }
}

function Test-WatchedPathOverflow {
  param([AllowNull()][string]$PathValue, [int64]$MaximumBytes)
  if ([string]::IsNullOrEmpty($PathValue)) { return $false }
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $PathValue -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $true }
  return ([int64]$item.Length -gt $MaximumBytes)
}

function Invoke-CapturedProcess {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [string]$WorkingDirectory,
    [int]$Timeout,
    [int64]$OutputBudget = $script:MaxInternalOutputBytes,
    [AllowNull()][string]$InputText = $null,
    [AllowNull()][string]$StdoutPath = $null,
    [AllowNull()][string]$StderrPath = $null,
    [AllowNull()][string]$WatchPath = $null
  )
  Initialize-BoundedCaptureType
  $result = [ordered]@{
    started = $false
    exited = $false
    timedOut = $false
    outputOverflowed = $false
    watchedPathOverflowed = $false
    cleanupFailed = $false
    drainCompleted = $false
    rootPid = $null
    rootStartTicks = $null
    jobEmpty = $false
    containedProcessCount = $null
    exitCode = $null
    commandLine = $null
    stdout = ''
    stderr = ''
    stdoutBytes = 0
    stderrBytes = 0
    outputBytes = 0
    startError = $null
    removedEnvironmentNames = @()
    allowedEnvironmentNames = @()
  }
  if ($Timeout -lt 1 -or $OutputBudget -lt 1) {
    $result.startError = 'Invalid bounded process limits'
    return [pscustomobject]$result
  }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $FilePath
  $startInfo.Arguments = ConvertTo-WindowsArgumentString -Arguments $Arguments
  $result.commandLine = $startInfo.Arguments
  $startInfo.WorkingDirectory = $WorkingDirectory
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $environment = Set-MinimalChildEnvironment -StartInfo $startInfo
  $result.removedEnvironmentNames = @($environment.droppedNames)
  $result.allowedEnvironmentNames = @($environment.allowedNames)
  $process = New-Object Q66Lane.ContainedProcess
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      $result.startError = 'Process.Start returned false'
      $result.cleanupFailed = -not (Stop-ProcessTree -Process $process)
      try { $process.Dispose() } catch { $result.cleanupFailed = $true }
      return [pscustomobject]$result
    }
    $result.started = $true
    $result.rootPid = $process.Id
    $result.rootStartTicks = $process.StartTicks
  } catch {
    $result.startError = 'Process could not start'
    $result.cleanupFailed = -not (Stop-ProcessTree -Process $process)
    try { $process.Dispose() } catch { $result.cleanupFailed = $true }
    return [pscustomobject]$result
  }

  $capture = $null
  try {
    $capture = New-Object Q66Lane.BoundedCaptureSession($process, $StdoutPath, $StderrPath, $OutputBudget)
  } catch {
    $result.startError = 'Bounded output capture could not start'
    $result.cleanupFailed = -not (Stop-ProcessTree -Process $process)
    try { $process.Dispose() } catch { }
    return [pscustomobject]$result
  }

  $stopRequested = $false
  $deadline = [DateTime]::UtcNow.AddMilliseconds($Timeout * 1000)
  try {
    if ($null -ne $InputText) {
      $inputTask = $process.StandardInput.WriteAsync($InputText)
      # Codex normally consumes stdin promptly, but an untrusted executable
      # may deliberately stop reading it. Keep enforcing every output budget
      # while that write is pending; otherwise a last-response file could grow
      # until the wall-clock timeout before the monitor starts.
      while (-not $inputTask.Wait(20)) {
        if ($capture.Overflowed) {
          $result.outputOverflowed = $true
          $stopRequested = $true
          break
        }
        if (Test-WatchedPathOverflow -PathValue $WatchPath -MaximumBytes $OutputBudget) {
          $result.watchedPathOverflowed = $true
          $result.outputOverflowed = $true
          $stopRequested = $true
          break
        }
        if ([DateTime]::UtcNow -ge $deadline) {
          $result.timedOut = $true
          $stopRequested = $true
          break
        }
      }
    }
    try { $process.StandardInput.Close() } catch { }
  } catch { try { $process.StandardInput.Close() } catch { } }

  while (-not $stopRequested) {
    try {
      if ($capture.Overflowed) {
        $result.outputOverflowed = $true
        $stopRequested = $true
        break
      }
      if (Test-WatchedPathOverflow -PathValue $WatchPath -MaximumBytes $OutputBudget) {
        $result.watchedPathOverflowed = $true
        $result.outputOverflowed = $true
        $stopRequested = $true
        break
      }
      if ($process.HasExited) { $result.exited = $true; break }
    } catch {
      $stopRequested = $true
      $result.cleanupFailed = $true
      break
    }
    if ([DateTime]::UtcNow -ge $deadline) {
      $result.timedOut = $true
      $stopRequested = $true
      break
    }
    Start-Sleep -Milliseconds 20
  }
  if ($stopRequested) {
    if (-not (Stop-ProcessTree -Process $process)) { $result.cleanupFailed = $true }
  }
  try {
    if (-not $process.HasExited) {
      if (-not $process.WaitForExit($script:CleanupTimeoutMilliseconds)) { $result.cleanupFailed = $true }
    }
    if ($process.HasExited) { $result.exited = $true }
  } catch { $result.cleanupFailed = $true }

  if ($null -ne $capture) {
    $result.drainCompleted = $capture.WaitForReaders($script:CleanupTimeoutMilliseconds)
    if (-not $result.drainCompleted) {
      $result.cleanupFailed = $true
      if (-not (Stop-ProcessTree -Process $process)) { $result.cleanupFailed = $true }
      $result.drainCompleted = $capture.WaitForReaders(1000)
      if (-not $result.drainCompleted) { $result.cleanupFailed = $true }
    }
    $result.stdoutBytes = $capture.StdoutBytes
    $result.stderrBytes = $capture.StderrBytes
    $result.outputBytes = $capture.TotalBytes
    if ($capture.Overflowed) { $result.outputOverflowed = $true }
    if ([string]::IsNullOrEmpty($StdoutPath)) { $result.stdout = $capture.StdoutText() }
    if ([string]::IsNullOrEmpty($StderrPath)) { $result.stderr = $capture.StderrText() }
    if ($capture.ReaderError) { $result.cleanupFailed = $true }
  }
  if ($result.exited -and -not $result.timedOut -and -not $result.outputOverflowed) {
    try { $result.exitCode = $process.ExitCode } catch { $result.cleanupFailed = $true }
  }
  try {
    # Root completion and pipe EOF do not establish descendant absence. Wait
    # for the owned Job separately. A forced late cleanup remains a refusal.
    if (-not $process.WaitForEmpty($script:CleanupTimeoutMilliseconds)) {
      $result.cleanupFailed = $true
      [void](Stop-ProcessTree -Process $process)
    }
    $result.jobEmpty = ($process.ActiveProcesses -eq 0)
    $result.containedProcessCount = $process.TotalProcesses
    if (-not $result.jobEmpty) { $result.cleanupFailed = $true }
  } catch { $result.cleanupFailed = $true }
  try { $process.Dispose() } catch { }
  return [pscustomobject]$result
}

function Get-GitResult {
  param([string[]]$Arguments, [string]$WorkingDirectory, [int]$Timeout = $script:GitTimeoutSeconds)
  return Invoke-CapturedProcess -FilePath $script:GitPath -Arguments $Arguments -WorkingDirectory $WorkingDirectory -Timeout $Timeout -OutputBudget $script:MaxInternalOutputBytes
}

function Normalize-Allowlist {
  param([string[]]$Values, [string]$RepoRoot)
  if ($null -eq $Values -or $Values.Count -eq 0 -or $Values.Count -gt 128) {
    Fail-Lane -Code 'ALLOWLIST_EMPTY_OR_BROAD' -Message 'AllowPath must contain between one and 128 exact files'
  }
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $normalized = @()
  foreach ($value in $Values) {
    if ([string]::IsNullOrWhiteSpace($value) -or $value -ne $value.Trim() -or $value.Length -gt 512) {
      Fail-Lane -Code 'ALLOWLIST_PATH_INVALID' -Message 'AllowPath entries must be bounded, trimmed, relative paths'
    }
    if ($value.Contains('\') -or $value.StartsWith('/') -or [System.IO.Path]::IsPathRooted($value) -or $value -match '[*?\[\]]') {
      Fail-Lane -Code 'ALLOWLIST_PATH_TRAVERSAL' -Message "AllowPath is not an exact slash-normalized relative path: $value"
    }
    $segments = @($value -split '/')
    $ambiguousSegments = @($segments | Where-Object { [string]::IsNullOrEmpty($_) -or $_ -eq '.' -or $_ -eq '..' })
    if ($segments.Count -eq 0 -or $ambiguousSegments.Count -gt 0) {
      Fail-Lane -Code 'ALLOWLIST_PATH_TRAVERSAL' -Message "AllowPath contains an ambiguous segment: $value"
    }
    foreach ($segment in $segments) {
      # Git and Windows both support ordinary product directories containing
      # spaces and parentheses. Keep the allowlist exact while rejecting
      # traversal aliases, Win32 trailing-dot/space ambiguity, device names,
      # separators, controls, wildcards, and shell-special punctuation.
      $deviceStem = @($segment -split '\.', 2)[0]
      $reservedDevice = $deviceStem -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$'
      if ($segment -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._@+()\-]{0,127}$' -or
          $segment.EndsWith(' ') -or $segment.EndsWith('.') -or
          $reservedDevice -or $segment -eq '.git') {
        Fail-Lane -Code 'ALLOWLIST_PATH_INVALID' -Message "AllowPath contains an unsafe segment: $value"
      }
    }
    $canonical = ($segments -join '/')
    if (-not $seen.Add($canonical)) {
      Fail-Lane -Code 'ALLOWLIST_DUPLICATE' -Message "AllowPath repeats $canonical"
    }
    $sourcePath = Join-Path -Path $RepoRoot -ChildPath ($canonical -replace '/', '\')
    Assert-NoReparseComponents -PathValue $sourcePath -Name "AllowPath $canonical"
    if (Test-Path -LiteralPath $sourcePath -PathType Container) {
      Fail-Lane -Code 'ALLOWLIST_EMPTY_OR_BROAD' -Message "AllowPath names a directory, not an exact file: $canonical"
    }
    $normalized += $canonical
  }
  return @($normalized | Sort-Object { $_.ToLowerInvariant() })
}

function Assert-VerificationArguments {
  param(
    [string[]]$Arguments,
    [string[]]$Allowlist,
    [bool]$AllowChangedPathArguments
  )
  $allowSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($path in @($Allowlist)) { [void]$allowSet.Add($path) }
  foreach ($argument in @($Arguments)) {
    if ($null -eq $argument) { Fail-Lane -Code 'VERIFICATION_ARGUMENT_INVALID' -Message 'Verification arguments cannot be null' }
    # Arguments may be arbitrary program text (for example Node's -e source),
    # so Path.IsPathRooted is unsafe here: .NET Framework throws on otherwise
    # valid CLI text containing Windows-invalid filename characters. Reject
    # only path-shaped roots and parent traversal without interpreting code as
    # a filesystem path.
    if ($argument -match '^(?:[A-Za-z]:|[\\/])' -or $argument -match '(^|[\\/])\.\.([\\/]|$)') {
      Fail-Lane -Code 'PATH_ESCAPES_DECLARED_ROOT' -Message 'Verification arguments must use worktree-relative paths'
    }
    $relativeArgument = $argument.Replace('\\', '/')
    if ($relativeArgument.StartsWith('./')) { $relativeArgument = $relativeArgument.Substring(2) }
    if ($allowSet.Contains($relativeArgument) -and -not $AllowChangedPathArguments) {
      Fail-Lane -Code 'VERIFICATION_CHANGED_PATH_UNAUTHORIZED' -Message 'Verification arguments reference an allowlisted file without explicit controller policy'
    }
    if ($allowSet.Contains($relativeArgument) -and $AllowChangedPathArguments -and $relativeArgument -ne $argument.Replace('\\', '/')) {
      Fail-Lane -Code 'VERIFICATION_ARGUMENT_INVALID' -Message 'Verification changed-file arguments must be canonical relative paths'
    }
  }
}

function Read-StringArrayJson {
  param([string]$JsonText, [string]$Name, [string]$Code = 'VERIFICATION_ARGUMENT_INVALID')
  if ($null -eq $JsonText -or $JsonText.Length -gt 1024 * 1024) {
    Fail-Lane -Code $Code -Message "$Name exceeds the bounded JSON input size"
  }
  if ([string]::IsNullOrWhiteSpace($JsonText) -or $JsonText.Trim() -notmatch '^\[') {
    Fail-Lane -Code $Code -Message "$Name must be a JSON array"
  }
  try {
    $parsed = ConvertFrom-Json -InputObject $JsonText
  } catch {
    Fail-Lane -Code $Code -Message "$Name is not valid JSON"
  }
  $values = @($parsed)
  if ($null -eq $parsed) { $values = @() }
  foreach ($value in $values) {
    if ($value -isnot [string]) {
      Fail-Lane -Code $Code -Message "Every $Name entry must be a string"
    }
  }
  return @($values)
}

function Read-VerificationArguments {
  param([string]$JsonText)
  return Read-StringArrayJson -JsonText $JsonText -Name 'VerificationArgumentsJson'
}

function Assert-CanonicalLaunchRecord {
  param(
    [string]$ControlRoot,
    [string]$NodePath,
    [string]$ExpectedLaunchId,
    [int]$Timeout,
    [System.Collections.IDictionary]$ExpectedPolicy
  )
  # The control root is derived from this trusted executor's own location.
  # It is deliberately not a parameter: a caller may supply a clean source
  # checkout, but never an alternate audit DB, JWK, helper module, or policy.
  $auditDb = Get-SafeExistingFile -PathValue (Join-Path $ControlRoot 'state\audit.sqlite3') -Name 'Canonical control-root audit database'
  $policyJson = ConvertTo-JsonText -Value $ExpectedPolicy
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $helper = Invoke-CapturedProcess -FilePath $NodePath -Arguments @(
    '-e', $script:CanonicalAuditVerifier, 'verify', $auditDb, $ExpectedLaunchId, $policyJson
  ) -WorkingDirectory $ControlRoot -Timeout ([Math]::Min($Timeout, 30)) -OutputBudget 65536
  $stopwatch.Stop()
  if (-not $helper.started -or -not $helper.exited -or $helper.timedOut -or $helper.outputOverflowed -or
      $helper.cleanupFailed -or $helper.exitCode -ne 0) {
    Fail-Lane -Code 'CANONICAL_LAUNCH_HELPER_FAILED' -Message 'The read-only canonical launch verifier did not produce a bounded verdict'
  }
  $verdict = $null
  try {
    $lines = @($helper.stdout -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -ne 1) { throw 'unexpected verdict shape' }
    $verdict = ConvertFrom-Json -InputObject $lines[0]
  } catch {
    Fail-Lane -Code 'CANONICAL_LAUNCH_HELPER_FAILED' -Message 'The canonical launch verifier verdict was malformed'
  }
  if ($null -eq $verdict -or $verdict.ok -ne $true -or [string]$verdict.code -ne 'CANONICAL_LAUNCH_VERIFIED') {
    $code = if ($null -ne $verdict -and [string]$verdict.code -match '^CANONICAL_[A-Z0-9_]+$') { [string]$verdict.code } else { 'CANONICAL_LAUNCH_INVALID' }
    Fail-Lane -Code $code -Message 'The canonical audit launch or controller-owned policy did not authorize this exact lane'
  }
  return [pscustomobject]@{ path = $auditDb; verified = $true; durationMs = $stopwatch.ElapsedMilliseconds; removedEnvironmentNames = @($helper.removedEnvironmentNames) }
}

function Get-PreparedCanonicalPolicy {
  param(
    [string]$ControlRoot,
    [string]$NodePath,
    [string]$ExpectedLaunchId,
    [int]$Timeout,
    [System.Collections.IDictionary]$DraftPolicy
  )
  # Preparation derives the control root from this script exactly as execution
  # does. It reads the selected signed launch row and emits the policy details
  # object for controller review/signing, but accepts no caller-supplied trust
  # root, key, audit path, or signing authority.
  $auditDb = Get-SafeExistingFile -PathValue (Join-Path $ControlRoot 'state\audit.sqlite3') -Name 'Canonical control-root audit database'
  $policyJson = ConvertTo-JsonText -Value $DraftPolicy
  $helper = Invoke-CapturedProcess -FilePath $NodePath -Arguments @(
    '-e', $script:CanonicalAuditVerifier, 'prepare', $auditDb, $ExpectedLaunchId, $policyJson
  ) -WorkingDirectory $ControlRoot -Timeout ([Math]::Min($Timeout, 30)) -OutputBudget 65536
  if (-not $helper.started -or -not $helper.exited -or $helper.timedOut -or $helper.outputOverflowed -or
      $helper.cleanupFailed -or $helper.exitCode -ne 0) {
    Fail-Lane -Code 'CANONICAL_PREPARATION_HELPER_FAILED' -Message 'The read-only canonical policy preparation helper did not produce a bounded packet'
  }
  $prepared = $null
  try {
    $lines = @($helper.stdout -split "`r?`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($lines.Count -ne 1) { throw 'unexpected packet shape' }
    $prepared = ConvertFrom-Json -InputObject $lines[0]
    if ($null -eq $prepared) { throw 'missing packet' }
  } catch {
    Fail-Lane -Code 'CANONICAL_PREPARATION_HELPER_FAILED' -Message 'The canonical policy preparation packet was malformed'
  }
  if ($prepared.PSObject.Properties.Name -contains 'ok') {
    $code = if ($prepared.ok -eq $false -and [string]$prepared.code -match '^CANONICAL_[A-Z0-9_]+$') { [string]$prepared.code } else { 'CANONICAL_LAUNCH_INVALID' }
    Fail-Lane -Code $code -Message 'The canonical signed launch record did not authorize policy preparation for this exact lane'
  }
  return [pscustomobject]@{ path = $auditDb; policy = $prepared; removedEnvironmentNames = @($helper.removedEnvironmentNames) }
}

function Get-NulSeparatedValues {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return @() }
  return @($Text -split "`0" | Where-Object { $_ -ne '' })
}

function Normalize-GitPath {
  param([string]$PathValue)
  $normalized = $PathValue.Replace('\', '/')
  while ($normalized.EndsWith('/')) { $normalized = $normalized.Substring(0, $normalized.Length - 1) }
  return $normalized
}

function Get-ChangedPaths {
  param([string]$Worktree)
  $diff = Get-GitResult -Arguments @('diff','--name-only','--no-renames','-z','HEAD','--') -WorkingDirectory $Worktree
  if (-not $diff.started -or -not $diff.exited -or $diff.exitCode -ne 0) {
    Fail-Lane -Code 'CHANGE_SCAN_FAILED' -Message 'Unable to enumerate tracked changes' -Class 'harness'
  }
  $status = Get-GitResult -Arguments @('status','--porcelain=v1','--untracked-files=all','--ignored=matching','-z','--') -WorkingDirectory $Worktree
  if (-not $status.started -or -not $status.exited -or $status.exitCode -ne 0) {
    Fail-Lane -Code 'CHANGE_SCAN_FAILED' -Message 'Unable to enumerate untracked changes' -Class 'harness'
  }
  $set = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $paths = @()
  foreach ($pathValue in @(Get-NulSeparatedValues -Text $diff.stdout)) {
    $path = Normalize-GitPath -PathValue $pathValue
    if ($set.Add($path)) { $paths += $path }
  }
  foreach ($record in @(Get-NulSeparatedValues -Text $status.stdout)) {
    if ($record.Length -lt 4) { continue }
    $state = $record.Substring(0, 2)
    if ($state -ne '??' -and $state -ne '!!') { continue }
    $path = Normalize-GitPath -PathValue $record.Substring(3)
    if ($set.Add($path)) { $paths += $path }
  }
  return @($paths | Sort-Object { $_.ToLowerInvariant() })
}

function Get-SafeWorktreePath {
  param([string]$Worktree, [string]$RelativePath)
  try {
    $candidate = [System.IO.Path]::GetFullPath((Join-Path -Path $Worktree -ChildPath ($RelativePath -replace '/', '\')))
  } catch { return $null }
  if (-not (Test-PathContained -Child $candidate -Root $Worktree) -or $candidate -eq (Get-PathComparisonValue -PathValue $Worktree)) {
    return $null
  }
  try { Assert-NoReparseComponents -PathValue $candidate -Name "Changed path $RelativePath" } catch { return $null }
  return $candidate
}

function Get-ChangedHashEvidence {
  param([string]$Worktree, [string[]]$Paths)
  $files = [ordered]@{}
  $issues = @()
  foreach ($relative in @($Paths)) {
    $candidate = Get-SafeWorktreePath -Worktree $Worktree -RelativePath $relative
    if ($null -eq $candidate) {
      $files[$relative] = [ordered]@{ kind = 'unsafe-path'; sha256 = $null }
      $issues += $relative
      continue
    }
    if (-not (Test-Path -LiteralPath $candidate)) {
      $files[$relative] = [ordered]@{ kind = 'deleted'; sha256 = $null }
      continue
    }
    try { $item = Get-Item -LiteralPath $candidate -Force } catch {
      $files[$relative] = [ordered]@{ kind = 'unsafe-path'; sha256 = $null }
      $issues += $relative
      continue
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      $files[$relative] = [ordered]@{ kind = 'reparse-point'; sha256 = $null }
      $issues += $relative
      continue
    }
    if ($item.PSIsContainer) {
      $files[$relative] = [ordered]@{ kind = 'directory'; sha256 = $null }
      $issues += $relative
      continue
    }
    try {
      $hash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    } catch {
      Fail-Lane -Code 'HASH_CAPTURE_FAILED' -Message "Unable to hash changed path $relative" -Class 'harness'
    }
    $files[$relative] = [ordered]@{ kind = 'file'; sha256 = $hash }
  }
  return [pscustomobject]@{ files = $files; issues = @($issues) }
}

function New-PortablePatch {
  param(
    [string]$Worktree,
    [string[]]$ChangedPaths,
    [string]$PatchPath
  )
  $tracked = Get-GitResult -Arguments @('diff','--binary','--no-ext-diff','--no-color','--no-renames','--no-prefix','HEAD','--') -WorkingDirectory $Worktree
  if (-not $tracked.started -or -not $tracked.exited -or $tracked.cleanupFailed -or $tracked.outputOverflowed -or $tracked.exitCode -ne 0) {
    Fail-Lane -Code 'PATCH_CAPTURE_FAILED' -Message 'Unable to capture tracked portable patch' -Class 'harness'
  }
  $parts = @()
  if (-not [string]::IsNullOrEmpty($tracked.stdout)) { $parts += $tracked.stdout.TrimEnd("`r", "`n") }
  $trackedNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  $trackedNameResult = Get-GitResult -Arguments @('diff','--name-only','--no-renames','-z','HEAD','--') -WorkingDirectory $Worktree
  if (-not $trackedNameResult.started -or -not $trackedNameResult.exited -or $trackedNameResult.exitCode -ne 0) {
    Fail-Lane -Code 'PATCH_CAPTURE_FAILED' -Message 'Unable to enumerate tracked patch paths' -Class 'harness'
  }
  foreach ($name in @(Get-NulSeparatedValues -Text $trackedNameResult.stdout)) {
    [void]$trackedNames.Add((Normalize-GitPath -PathValue $name))
  }
  $warnings = @()
  foreach ($relative in @($ChangedPaths)) {
    if ($trackedNames.Contains($relative)) { continue }
    $candidate = Get-SafeWorktreePath -Worktree $Worktree -RelativePath $relative
    if ($null -eq $candidate -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      $warnings += "${relative}: not a regular file; no standalone untracked patch emitted"
      continue
    }
    $item = Get-Item -LiteralPath $candidate -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      $warnings += "${relative}: reparse point; patch read refused"
      continue
    }
    $untracked = Get-GitResult -Arguments @('diff','--no-index','--binary','--no-ext-diff','--no-color','--no-prefix','--','/dev/null',$relative) -WorkingDirectory $Worktree
    if (-not $untracked.started -or -not $untracked.exited -or $untracked.cleanupFailed -or $untracked.outputOverflowed -or $script:AllowedExitCodesForNoIndex -notcontains $untracked.exitCode) {
      Fail-Lane -Code 'PATCH_CAPTURE_FAILED' -Message "Unable to capture untracked portable patch for $relative" -Class 'harness'
    }
    if (-not [string]::IsNullOrEmpty($untracked.stdout)) { $parts += $untracked.stdout.TrimEnd("`r", "`n") }
  }
  $patch = ''
  if ($parts.Count -gt 0) { $patch = (($parts -join "`n").TrimEnd("`r", "`n") + "`n") }
  $patchBytes = [System.Text.Encoding]::UTF8.GetByteCount($patch)
  if ($patchBytes -gt $script:MaxInternalOutputBytes) {
    Fail-Lane -Code 'PATCH_TOO_LARGE' -Message 'Portable patch exceeded the bounded artifact limit' -Class 'harness'
  }
  Write-Utf8NoBom -Path $PatchPath -Text $patch
  return [pscustomobject]@{ warnings = @($warnings); bytes = $patchBytes }
}

function Get-SourceStatus {
  param([string]$Repo, [switch]$IncludeIgnored)
  $arguments = @('status','--porcelain=v1','--untracked-files=all')
  if ($IncludeIgnored) { $arguments += '--ignored=matching' }
  $arguments += '--'
  $result = Get-GitResult -Arguments $arguments -WorkingDirectory $Repo
  if (-not $result.started -or -not $result.exited -or $result.exitCode -ne 0) {
    Fail-Lane -Code 'SOURCE_STATUS_FAILED' -Message 'Unable to inspect source checkout' -Class 'harness'
  }
  return [string]$result.stdout
}

function Get-ManifestArtifactPaths {
  param([string]$ArtifactRoot)
  return [ordered]@{
    worktreeStdout = Join-Path $ArtifactRoot 'worktree-stdout.txt'
    worktreeStderr = Join-Path $ArtifactRoot 'worktree-stderr.txt'
    agentStdout = Join-Path $ArtifactRoot 'agent-stdout.txt'
    agentStderr = Join-Path $ArtifactRoot 'agent-stderr.txt'
    lastResponse = Join-Path $ArtifactRoot 'last-response.txt'
    verificationStdout = Join-Path $ArtifactRoot 'verification-stdout.txt'
    verificationStderr = Join-Path $ArtifactRoot 'verification-stderr.txt'
    portablePatch = Join-Path $ArtifactRoot 'portable.patch'
    terminalManifest = Join-Path $ArtifactRoot 'terminal-manifest.json'
  }
}

function Limit-FileBytes {
  param([string]$PathValue, [int64]$MaximumBytes)
  if (-not (Test-Path -LiteralPath $PathValue -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $PathValue -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail-Lane -Code 'ARTIFACT_REPARSE_FILE' -Message 'A bounded artifact file became a reparse point' -Class 'harness'
  }
  if ($item.Length -le $MaximumBytes) { return $false }
  $stream = $null
  try {
    $stream = New-Object System.IO.FileStream($PathValue, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::Read)
    $stream.SetLength($MaximumBytes)
  } catch {
    Fail-Lane -Code 'ARTIFACT_TRUNCATION_FAILED' -Message 'A bounded artifact could not be truncated' -Class 'harness'
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
  }
  return $true
}

function Get-ArtifactSnapshot {
  param([string]$ArtifactRoot)
  $files = [ordered]@{}
  $issues = @()
  $queue = New-Object 'System.Collections.Generic.Queue[string]'
  $queue.Enqueue($ArtifactRoot)
  while ($queue.Count -gt 0) {
    $directory = $queue.Dequeue()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
      $relative = $item.FullName.Substring($ArtifactRoot.Length).TrimStart('\', '/') -replace '\\', '/'
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        $issues += $relative
        continue
      }
      if ($item.PSIsContainer) {
        $queue.Enqueue($item.FullName)
        continue
      }
      if ($item.Length -gt $script:MaxArtifactFileBytes) {
        $issues += $relative
        continue
      }
      try { $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() } catch {
        Fail-Lane -Code 'ARTIFACT_SNAPSHOT_FAILED' -Message 'Unable to snapshot an artifact file' -Class 'harness'
      }
      $files[$relative] = [ordered]@{ sha256 = $hash; length = [int64]$item.Length }
    }
  }
  return [pscustomobject]@{ files = $files; issues = @($issues) }
}

function Compare-ArtifactSnapshots {
  param(
    $Before,
    $After,
    [string[]]$IgnoredPaths
  )
  $ignored = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($path in @($IgnoredPaths)) { [void]$ignored.Add($path) }
  $issues = @($Before.issues + $After.issues)
  $paths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($path in $Before.files.Keys) { [void]$paths.Add([string]$path) }
  foreach ($path in $After.files.Keys) { [void]$paths.Add([string]$path) }
  foreach ($path in $paths) {
    if ($ignored.Contains($path)) { continue }
    $beforeItem = $Before.files[[string]$path]
    $afterItem = $After.files[[string]$path]
    if ($null -eq $beforeItem -or $null -eq $afterItem -or
        $beforeItem.sha256 -ne $afterItem.sha256 -or $beforeItem.length -ne $afterItem.length) {
      $issues += [string]$path
    }
  }
  return @($issues | Sort-Object -Unique)
}

function Capture-WorktreeEvidence {
  param([System.Collections.IDictionary]$Manifest, [string]$Worktree)
  $changed = @(Get-ChangedPaths -Worktree $Worktree)
  $hashes = Get-ChangedHashEvidence -Worktree $Worktree -Paths $changed
  $patch = New-PortablePatch -Worktree $Worktree -ChangedPaths $changed -PatchPath $Manifest.artifacts.portablePatch
  $Manifest.changedPaths = $changed
  $Manifest.hashes.files = $hashes.files
  $Manifest.patchWarnings = @($patch.warnings)
  if (Test-Path -LiteralPath $Manifest.artifacts.portablePatch -PathType Leaf) {
    $Manifest.hashes.portablePatchSha256 = (Get-FileHash -LiteralPath $Manifest.artifacts.portablePatch -Algorithm SHA256).Hash.ToLowerInvariant()
  } else {
    $Manifest.hashes.portablePatchSha256 = $null
  }
  return [pscustomobject]@{ paths = $changed; hashes = $hashes; patch = $patch }
}

function Compare-HashEvidence {
  param($Before, $After)
  $issues = @()
  $paths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($path in $Before.files.Keys) { [void]$paths.Add([string]$path) }
  foreach ($path in $After.files.Keys) { [void]$paths.Add([string]$path) }
  foreach ($path in $paths) {
    $beforeItem = $Before.files[[string]$path]
    $afterItem = $After.files[[string]$path]
    if ($null -eq $beforeItem -or $null -eq $afterItem -or
        $beforeItem.kind -ne $afterItem.kind -or $beforeItem.sha256 -ne $afterItem.sha256) {
      $issues += [string]$path
    }
  }
  return @($issues | Sort-Object -Unique)
}

$selectedSandbox = if ($AllowNpmRegistryNetwork.IsPresent) {
  "permission-profile:$($script:NpmRegistryPermissionProfileName)"
} else {
  'workspace-write'
}

$manifest = [ordered]@{
  schemaVersion = 1
  kind = 'luna-worktree-lane-terminal'
  terminalState = 'not-started'
  failureClass = $null
  failureCode = $null
  failureMessage = $null
  eligibleForDenominator = $false
  launchId = $LaunchId
  laneId = $LaneId
  objectiveRef = $ObjectiveRef
  model = $agentProfileValues.model
  reasoningEffort = $agentProfileValues.reasoningEffort
  sandbox = $selectedSandbox
  repoPath = $RepoPath
  worktreePath = $WorktreePath
  artifactPath = $ArtifactPath
  baseCommit = $BaseCommit
  allowlist = @()
  timeoutSeconds = $TimeoutSeconds
  outputBudgetBytes = $OutputBudgetBytes
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  finishedAt = $null
  preflight = [ordered]@{ state = 'not-run'; failureCode = $null; sourceStatusBefore = $null; sourceStatusAfter = $null }
  evidence = [ordered]@{ canonicalControlRoot = $null; canonicalAuditPath = $null; canonicalVerified = $false; canonicalVerifierDurationMs = $null; legacyEvidenceIgnored = (-not [string]::IsNullOrWhiteSpace($LaunchEvidencePath)); legacyPublicKeyIgnored = (-not [string]::IsNullOrWhiteSpace($LaunchPublicKeyPath)) }
  worktree = [ordered]@{ created = $false; preserved = $false; head = $null; detached = $false; createExitCode = $null }
  prompt = [ordered]@{ path = $PromptFile; sha256 = $null; bytes = $null }
  environment = [ordered]@{ allowedNames = @($script:ChildEnvironmentNames); agentDroppedNames = @(); verificationDroppedNames = @(); canonicalVerifierDroppedNames = @() }
  agent = [ordered]@{ executable = $null; executableSha256 = $null; prefixArguments = @(); arguments = @(); commandLine = $null; workingDirectory = $null; exitState = 'not-started'; started = $false; timedOut = $false; outputOverflowed = $false; lastResponseOverflowed = $false; cleanupFailed = $false; drainCompleted = $false; exitCode = $null; outputBytes = $null; removedEnvironmentNames = @() }
  verification = [ordered]@{ program = $VerificationProgram; programSha256 = $null; arguments = @(); workingDirectory = $null; controllerOwned = $true; allowChangedPathArguments = $false; exitState = 'not-run'; started = $false; timedOut = $false; outputOverflowed = $false; cleanupFailed = $false; drainCompleted = $false; exitCode = $null; passed = $false; outputBytes = $null; removedEnvironmentNames = @() }
  changedPaths = @()
  hashes = [ordered]@{ files = [ordered]@{}; portablePatchSha256 = $null }
  patchWarnings = @()
  artifacts = [ordered]@{}
  controllerNotes = [ordered]@{ noAutoMerge = $true; noAutoApply = $true; noAutoCommit = $true; noAutoDelete = $true; noAutoCleanup = $true }
}

$artifactReady = $false
$phase = 'preflight'
$createdWorktree = $false
$preparationCompleted = $false
$preparedPolicy = $null

try {
  if ($TimeoutSeconds -lt 1 -or $TimeoutSeconds -gt 86400) {
    Fail-Lane -Code 'TIMEOUT_OUT_OF_BOUNDS' -Message 'TimeoutSeconds must be between 1 and 86400'
  }
  if ($OutputBudgetBytes -lt 65536 -or $OutputBudgetBytes -gt 67108864) {
    Fail-Lane -Code 'OUTPUT_BUDGET_OUT_OF_BOUNDS' -Message 'OutputBudgetBytes must be between 65536 and 67108864'
  }
  if ($LaunchId -notmatch '^launch_[A-Za-z0-9_-]{16,64}$') {
    Fail-Lane -Code 'LAUNCH_ID_INVALID' -Message 'LaunchId is not a signed launch identifier shape'
  }
  if ($LaneId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$' -or $LaneId -eq '.' -or $LaneId -eq '..') {
    Fail-Lane -Code 'LANE_ID_INVALID' -Message 'LaneId is not a safe unique lane identifier'
  }
  if ($ObjectiveRef -notmatch '^(?:Q(?:[1-9][0-9]{0,2})|R(?:[1-9][0-9]{0,3}))$') {
    Fail-Lane -Code 'OBJECTIVE_REF_INVALID' -Message 'ObjectiveRef must be an exact queue phase Q1 through Q999 or captured owner request R1 through R9999, never a prefix, slice label, or prompt text'
  }
  if ($BaseCommit -notmatch '^[0-9a-f]{40}$') {
    Fail-Lane -Code 'BASE_COMMIT_INVALID' -Message 'BaseCommit must be an immutable lowercase 40-hex commit'
  }

  $executorScript = Get-SafeExistingFile -PathValue $PSCommandPath -Name 'Executor script'
  $executorTools = Get-SafeExistingDirectory -PathValue $PSScriptRoot -Name 'Executor tools directory'
  $controlRoot = Get-SafeExistingDirectory -PathValue (Split-Path -Parent $executorTools) -Name 'Canonical control root'
  if (-not (Test-PathContained -Child $executorScript -Root $controlRoot)) {
    Fail-Lane -Code 'CONTROL_ROOT_INVALID' -Message 'The executor script must be contained by its self-derived canonical control root'
  }

  $repo = Get-SafeExistingDirectory -PathValue $RepoPath -Name 'RepoPath'
  $worktree = Assert-NewDirectoryTarget -PathValue $WorktreePath -Name 'WorktreePath'
  $artifactCandidate = Get-FullAbsolutePath -PathValue $ArtifactPath -Name 'ArtifactPath'
  if ((Test-PathContained -Child $repo -Root $controlRoot) -or (Test-PathContained -Child $controlRoot -Root $repo)) {
    Fail-Lane -Code 'CONTROL_REPO_OVERLAP' -Message 'RepoPath must be a dedicated clean source checkout, separate from the canonical control root'
  }
  if ((Test-PathContained -Child $worktree -Root $controlRoot) -or (Test-PathContained -Child $controlRoot -Root $worktree) -or
      (Test-PathContained -Child $artifactCandidate -Root $controlRoot) -or (Test-PathContained -Child $controlRoot -Root $artifactCandidate)) {
    Fail-Lane -Code 'CONTROL_EXECUTION_OVERLAP' -Message 'WorktreePath and ArtifactPath must be outside the canonical control root'
  }
  if ((Test-PathContained -Child $worktree -Root $repo) -or (Test-PathContained -Child $repo -Root $worktree)) {
    Fail-Lane -Code 'WORKTREE_REPO_OVERLAP' -Message 'WorktreePath must be outside RepoPath and must not contain it'
  }
  if ((Test-PathContained -Child $artifactCandidate -Root $worktree) -or (Test-PathContained -Child $worktree -Root $artifactCandidate)) {
    Fail-Lane -Code 'ARTIFACT_INSIDE_WORKTREE' -Message 'ArtifactPath and WorktreePath may not overlap'
  }
  if ((Test-PathContained -Child $artifactCandidate -Root $repo) -or (Test-PathContained -Child $repo -Root $artifactCandidate)) {
    Fail-Lane -Code 'ARTIFACT_REPO_OVERLAP' -Message 'ArtifactPath must be outside the source checkout'
  }

  $prompt = Get-SafeExistingFile -PathValue $PromptFile -Name 'PromptFile'
  $verification = Get-SafeExistingFile -PathValue $VerificationProgram -Name 'VerificationProgram'
  $verificationArguments = Read-VerificationArguments -JsonText $VerificationArgumentsJson
  $prefixArguments = Read-StringArrayJson -JsonText $CodexPrefixArgumentsJson -Name 'CodexPrefixArgumentsJson' -Code 'CODEX_PREFIX_INVALID'
  if ((Test-PathContained -Child $prompt -Root $worktree) -or (Test-PathContained -Child $verification -Root $worktree)) {
    Fail-Lane -Code 'PATH_ESCAPES_DECLARED_ROOT' -Message 'An input path is inside the writable worktree'
  }
  if ((Test-PathContained -Child $verification -Root $repo) -or (Test-PathContained -Child $verification -Root $artifactCandidate)) {
    Fail-Lane -Code 'VERIFICATION_PROGRAM_SCOPE' -Message 'The controller-owned verification program must be outside the source and artifact roots'
  }

  if ([string]::IsNullOrWhiteSpace($CodexExecutablePath)) {
    $codex = Resolve-ApplicationPath -Name 'codex.exe'
  } else {
    $codex = Get-SafeExistingFile -PathValue $CodexExecutablePath -Name 'CodexExecutablePath'
  }
  if ((Test-PathContained -Child $codex -Root $repo) -or (Test-PathContained -Child $codex -Root $worktree) -or (Test-PathContained -Child $codex -Root $artifactCandidate)) {
    Fail-Lane -Code 'CODEX_EXECUTABLE_SCOPE' -Message 'CodexExecutablePath must be outside project and artifact roots'
  }

  if ([string]::IsNullOrWhiteSpace($NodeExecutablePath)) {
    $node = Resolve-ApplicationPath -Name 'node.exe'
  } else {
    $node = Get-SafeExistingFile -PathValue $NodeExecutablePath -Name 'NodeExecutablePath'
  }
  if ((Test-PathContained -Child $node -Root $repo) -or (Test-PathContained -Child $node -Root $worktree) -or (Test-PathContained -Child $node -Root $artifactCandidate)) {
    Fail-Lane -Code 'NODE_EXECUTABLE_SCOPE' -Message 'NodeExecutablePath must be outside project and artifact roots'
  }

  $gitResolved = Resolve-ApplicationPath -Name 'git.exe'
  $script:GitPath = $gitResolved
  $repoTop = Get-GitResult -Arguments @('rev-parse','--show-toplevel') -WorkingDirectory $repo
  if (-not $repoTop.started -or -not $repoTop.exited -or $repoTop.exitCode -ne 0) {
    Fail-Lane -Code 'REPO_NOT_GIT' -Message 'RepoPath is not a readable git checkout'
  }
  $reportedRoot = [System.IO.Path]::GetFullPath($repoTop.stdout.Trim())
  if ((Get-PathComparisonValue -PathValue $reportedRoot) -ne (Get-PathComparisonValue -PathValue $repo)) {
    Fail-Lane -Code 'REPO_PATH_NOT_ROOT' -Message 'RepoPath must name the checkout root, not a subdirectory'
  }
  $sourceStatusBefore = Get-SourceStatus -Repo $repo
  $sourceStatusAllBefore = Get-SourceStatus -Repo $repo -IncludeIgnored
  if (-not [string]::IsNullOrWhiteSpace($sourceStatusBefore)) {
    Fail-Lane -Code 'SOURCE_CHECKOUT_DIRTY' -Message 'Source checkout is dirty; the requested base would be ambiguous'
  }
  if (-not [string]::IsNullOrWhiteSpace($sourceStatusAllBefore)) {
    Fail-Lane -Code 'SOURCE_CHECKOUT_NOT_DEDICATED_CLEAN' -Message 'RepoPath must be a dedicated clean source checkout with no ignored runtime state'
  }
  $baseLookup = Get-GitResult -Arguments @('rev-parse','--verify',("$BaseCommit^{commit}")) -WorkingDirectory $repo
  if (-not $baseLookup.started -or -not $baseLookup.exited -or $baseLookup.cleanupFailed -or $baseLookup.outputOverflowed -or $baseLookup.exitCode -ne 0 -or $baseLookup.stdout.Trim().ToLowerInvariant() -ne $BaseCommit) {
    Fail-Lane -Code 'BASE_COMMIT_UNKNOWN' -Message 'BaseCommit is not an object naming a commit in RepoPath'
  }

  $allowlist = Normalize-Allowlist -Values $AllowPath -RepoRoot $repo
  Assert-VerificationArguments -Arguments $verificationArguments -Allowlist $allowlist -AllowChangedPathArguments $AllowVerificationChangedPathArguments.IsPresent
  foreach ($argument in @($prefixArguments)) {
    if ($argument -match '(?i)(dangerously|bypass|full-access|no-sandbox|disable-sandbox)') {
      Fail-Lane -Code 'CODEX_PREFIX_INVALID' -Message 'Codex executable policy contains a forbidden bypass argument'
    }
    if ($AllowNpmRegistryNetwork.IsPresent -and
        $argument -match '(?i)(?:--sandbox|sandbox_mode|sandbox_workspace_write|default_permissions|permissions\.|network_proxy)') {
      Fail-Lane -Code 'CODEX_PREFIX_INVALID' -Message 'Permission-profile lanes reject caller-supplied sandbox or network configuration'
    }
  }
  $manifest.allowlist = @($allowlist)
  $manifest.baseCommit = $BaseCommit
  if ([string]::IsNullOrWhiteSpace([System.IO.File]::ReadAllText($prompt))) {
    Fail-Lane -Code 'PROMPT_EMPTY' -Message 'PromptFile must contain a non-empty Luna prompt'
  }
  $promptBytes = (Get-Item -LiteralPath $prompt -Force).Length
  if ($promptBytes -gt $script:MaxPromptBytes) {
    Fail-Lane -Code 'PROMPT_TOO_LARGE' -Message 'PromptFile exceeds the prompt size bound'
  }
  $manifest.prompt.bytes = $promptBytes
  $initialHashes = Get-FileHashSnapshot -Paths @($prompt, $verification, $codex, $node)
  $manifest.prompt.sha256 = $initialHashes[$prompt]
  $verificationHash = $initialHashes[$verification]
  $codexHash = $initialHashes[$codex]
  $nodeHash = $initialHashes[$node]
  $boundExecutableFiles = @(
    [pscustomobject]@{ path = $node; hash = $nodeHash; name = 'Canonical helper Node executable'; code = 'CANONICAL_HELPER_NODE_CHANGED' },
    [pscustomobject]@{ path = $codex; hash = $codexHash; name = 'Codex executable'; code = 'CODEX_EXECUTABLE_CHANGED' },
    [pscustomobject]@{ path = $verification; hash = $verificationHash; name = 'Verification program'; code = 'VERIFICATION_PROGRAM_CHANGED' }
  )
  $boundControllerFiles = @([pscustomobject]@{ path = $prompt; hash = $manifest.prompt.sha256; name = 'Prompt file'; code = 'PROMPT_FILE_CHANGED' }) + $boundExecutableFiles
  $plannedLastResponse = Join-Path $artifactCandidate 'last-response.txt'
  # MCP servers from ambient/project config are host capabilities, not part of
  # a bounded Luna coding lane, and merely starting them can initialize
  # lane-local runtime state before the model edits a file. Codex's
  # --ignore-user-config suppresses the ambient file while retaining auth, but
  # it also removes this host's required Windows elevated sandbox backend.
  # Restore only that backend explicitly. Project config is still discovered
  # under --cd, so clear the whole MCP table:
  # partial enabled=false overrides create incomplete server stubs, while an
  # empty table is closed and remains correct if project servers are added.
  # Noninteractive lanes also cannot service an approval prompt. Set approval
  # policy explicitly to never. The default path retains workspace-write. The
  # explicit npm path uses a named profile that inherits :workspace and grants
  # only registry.npmjs.org plus exact loopback for lane-local preview servers;
  # the runner's exact changed-path allowlist remains the post-execution gate.
  $plannedAgentArgs = @('--ask-for-approval','never')
  if ($ApplyPatchOnly) {
    $plannedAgentArgs += @('--disable','shell_tool')
  }
  $plannedAgentArgs += @(
    'exec','--json','--ephemeral','--ignore-user-config'
  )
  # These overrides deliberately live in the exec configuration layer. If
  # placed before `exec`, --ignore-user-config resolves the turn before the
  # custom profile is selected and the command sandbox becomes read-only.
  if ($AllowNpmRegistryNetwork.IsPresent) {
    $plannedAgentArgs += @(
      '-c',('default_permissions="{0}"' -f $script:NpmRegistryPermissionProfileName),
      '-c',('permissions.{0}.extends=":workspace"' -f $script:NpmRegistryPermissionProfileName),
      '-c',("permissions.{0}.network.enabled=true" -f $script:NpmRegistryPermissionProfileName),
      '-c',('permissions.{0}.network.domains={{ "registry.npmjs.org" = "allow", "127.0.0.1" = "allow" }}' -f $script:NpmRegistryPermissionProfileName)
    )
  }
  $plannedAgentArgs += @(
    '-c','windows.sandbox="elevated"',
    '-c','mcp_servers={}'
  )
  if (-not $AllowNpmRegistryNetwork.IsPresent) {
    $plannedAgentArgs += @('--sandbox','workspace-write')
  }
  $plannedAgentArgs += @(
    '--cd',$worktree,'--model',$agentProfileValues.model,
    '-c',("model_reasoning_effort={0}" -f $agentProfileValues.reasoningEffort),'--output-last-message',$plannedLastResponse,'-'
  )
  $expectedPolicy = [ordered]@{
    schemaVersion = 1
    controllerActor = 'codex'
    launchId = $LaunchId
    laneId = $LaneId
    objectiveRef = $ObjectiveRef
    baseCommit = $BaseCommit
    allowlist = @($allowlist)
    prompt = [ordered]@{ path = $prompt; sha256 = $manifest.prompt.sha256 }
    verification = [ordered]@{
      program = $verification
      sha256 = $verificationHash
      arguments = @($verificationArguments)
      allowChangedPathArguments = [bool]$AllowVerificationChangedPathArguments.IsPresent
    }
    timeoutSeconds = $TimeoutSeconds
    outputBudgetBytes = $OutputBudgetBytes
    agent = [ordered]@{
      program = $codex
      sha256 = $codexHash
      prefixArguments = @($prefixArguments)
      arguments = @($plannedAgentArgs)
      model = $agentProfileValues.model
      reasoningEffort = $agentProfileValues.reasoningEffort
      sandbox = $selectedSandbox
      nodePath = $node
      nodeSha256 = $nodeHash
    }
  }
  if ($PreparePolicy) {
    $prepared = Get-PreparedCanonicalPolicy -ControlRoot $controlRoot -NodePath $node -ExpectedLaunchId $LaunchId -Timeout $TimeoutSeconds -DraftPolicy $expectedPolicy
    Assert-FileHashesUnchanged -Files ($boundExecutableFiles + @($boundControllerFiles[0]))
    $preparedPolicy = $prepared.policy
    $preparationCompleted = $true
    $script:ExitCode = 0
  } else {
  $canonical = Assert-CanonicalLaunchRecord -ControlRoot $controlRoot -NodePath $node -ExpectedLaunchId $LaunchId -Timeout $TimeoutSeconds -ExpectedPolicy $expectedPolicy
  Assert-FileHashesUnchanged -Files $boundExecutableFiles

  $artifact = Assert-EmptyOrCreateArtifactDirectory -PathValue $artifactCandidate
  $artifactReady = $true
  $manifest.repoPath = $repo
  $manifest.worktreePath = $worktree
  $manifest.artifactPath = $artifact
  $manifest.prompt.path = $prompt
  $manifest.evidence.canonicalControlRoot = $controlRoot
  $manifest.evidence.canonicalAuditPath = $canonical.path
  $manifest.evidence.canonicalVerified = $canonical.verified
  $manifest.evidence.canonicalVerifierDurationMs = $canonical.durationMs
  $manifest.environment.canonicalVerifierDroppedNames = @($canonical.removedEnvironmentNames)
  $manifest.verification.program = $verification
  $manifest.verification.programSha256 = $verificationHash
  $manifest.verification.arguments = @($verificationArguments)
  $manifest.verification.allowChangedPathArguments = [bool]$AllowVerificationChangedPathArguments.IsPresent
  $manifest.agent.prefixArguments = @($prefixArguments)
  $manifest.agent.executableSha256 = $codexHash
  $manifest.artifacts = Get-ManifestArtifactPaths -ArtifactRoot $artifact
  $manifest.preflight.state = 'passed'
  $manifest.preflight.sourceStatusBefore = $sourceStatusAllBefore

  $phase = 'worktree'
  $add = Invoke-CapturedProcess -FilePath $script:GitPath -Arguments @('worktree','add','--detach',$worktree,$BaseCommit) -WorkingDirectory $repo -Timeout $TimeoutSeconds -OutputBudget 1048576 -StdoutPath $manifest.artifacts.worktreeStdout -StderrPath $manifest.artifacts.worktreeStderr
  $manifest.worktree.createExitCode = $add.exitCode
  if (-not $add.started) {
    Stop-Lane -Manifest $manifest -Class 'harness' -Code 'WORKTREE_CREATE_START_FAILED' -Message 'git worktree add could not start'
  }
  if (-not $add.exited -or $add.timedOut -or $add.cleanupFailed -or $add.outputOverflowed -or $add.exitCode -ne 0) {
    $manifest.worktree.preserved = Test-Path -LiteralPath $worktree
    Stop-Lane -Manifest $manifest -Class 'harness' -Code 'WORKTREE_CREATE_FAILED' -Message 'git worktree add failed; any target was preserved'
  }
  $createdWorktree = $true
  $manifest.worktree.created = $true
  $manifest.worktree.preserved = $true
  $head = Get-GitResult -Arguments @('rev-parse','--verify','HEAD') -WorkingDirectory $worktree
  if (-not $head.started -or -not $head.exited -or $head.cleanupFailed -or $head.outputOverflowed -or $head.exitCode -ne 0 -or $head.stdout.Trim().ToLowerInvariant() -ne $BaseCommit) {
    Stop-Lane -Manifest $manifest -Class 'harness' -Code 'WORKTREE_BASE_MISMATCH' -Message 'Created worktree is not detached at the supplied base commit'
  }
  $manifest.worktree.head = $head.stdout.Trim().ToLowerInvariant()
  $manifest.worktree.detached = $true

  $promptText = [System.IO.File]::ReadAllText($prompt)
  $agentArgs = @($plannedAgentArgs)
  $manifest.agent.executable = $codex
  $manifest.agent.arguments = @($agentArgs)
  $manifest.agent.workingDirectory = $worktree
  $phase = 'agent'
  $agentInvocationArgs = @($prefixArguments) + @($agentArgs)
  $agent = Invoke-CapturedProcess -FilePath $codex -Arguments $agentInvocationArgs -WorkingDirectory $worktree -Timeout $TimeoutSeconds -OutputBudget $OutputBudgetBytes -InputText $promptText -StdoutPath $manifest.artifacts.agentStdout -StderrPath $manifest.artifacts.agentStderr -WatchPath $manifest.artifacts.lastResponse
  $manifest.agent.started = $agent.started
  $manifest.agent.rootPid = $agent.rootPid
  $manifest.agent.rootStartTicks = $agent.rootStartTicks
  $manifest.agent.jobEmpty = $agent.jobEmpty
  $manifest.agent.containedProcessCount = $agent.containedProcessCount
  $manifest.agent.timedOut = $agent.timedOut
  $manifest.agent.outputOverflowed = $agent.outputOverflowed
  $manifest.agent.lastResponseOverflowed = $agent.watchedPathOverflowed
  $manifest.agent.cleanupFailed = $agent.cleanupFailed
  $manifest.agent.drainCompleted = $agent.drainCompleted
  $manifest.agent.exitCode = $agent.exitCode
  $manifest.agent.commandLine = $agent.commandLine
  $manifest.agent.removedEnvironmentNames = @($agent.removedEnvironmentNames)
  $manifest.environment.agentDroppedNames = @($agent.removedEnvironmentNames)
  $manifest.agent.outputBytes = $agent.outputBytes
  if (-not $agent.started) { $manifest.agent.exitState = 'start-failed' }
  elseif ($agent.cleanupFailed) { $manifest.agent.exitState = 'cleanup-failed' }
  elseif ($agent.outputOverflowed) { $manifest.agent.exitState = 'output-overflow' }
  elseif ($agent.timedOut) { $manifest.agent.exitState = 'timed-out' }
  elseif ($agent.exited) { $manifest.agent.exitState = 'exited' }
  else { $manifest.agent.exitState = 'unknown' }

  $sourceStatusAfter = Get-SourceStatus -Repo $repo
  $sourceStatusAllAfter = Get-SourceStatus -Repo $repo -IncludeIgnored
  $manifest.preflight.sourceStatusAfter = $sourceStatusAllAfter
  $agentEvidence = Capture-WorktreeEvidence -Manifest $manifest -Worktree $worktree
  $hashEvidence = $agentEvidence.hashes
  if ($sourceStatusAllAfter -ne $sourceStatusAllBefore) {
    Stop-Lane -Manifest $manifest -Class 'harness' -Code 'SOURCE_CHECKOUT_INTERFERENCE' -Message 'The shared source checkout changed concurrently; this is harness interference, not Luna model quality' -Eligible $false
  }

  if (-not $agent.started) {
    Stop-Lane -Manifest $manifest -Class 'harness' -Code 'AGENT_START_FAILED' -Message 'Codex agent process could not start'
  }
  if ($agent.cleanupFailed -or -not $agent.drainCompleted) {
    Stop-Lane -Manifest $manifest -Class 'harness' -Code 'PROCESS_CLEANUP_FAILED' -Message 'The Luna process tree or bounded output streams could not be reaped by the finite cleanup deadline' -Eligible $false
  }
  # The watched-path monitor should stop the agent before it gets here. Recheck
  # the on-disk artifact before timeout/nonzero classification so a concurrent
  # write cannot be misreported if it races a stdin write or process teardown.
  $lastResponseTooLarge = Limit-FileBytes -PathValue $manifest.artifacts.lastResponse -MaximumBytes $OutputBudgetBytes
  if ($agent.watchedPathOverflowed -or $lastResponseTooLarge) {
    Stop-Lane -Manifest $manifest -Class 'model-quality' -Code 'LAST_RESPONSE_TOO_LARGE' -Message 'Last response exceeded the declared output budget' -Eligible $true
  }
  if ($agent.outputOverflowed -or $manifest.agent.outputBytes -gt $OutputBudgetBytes) {
    Stop-Lane -Manifest $manifest -Class 'model-quality' -Code 'OUTPUT_BUDGET_EXCEEDED' -Message 'Agent stdout and stderr exceeded the declared output budget' -Eligible $true
  }
  if ($agent.timedOut) {
    Stop-Lane -Manifest $manifest -Class 'model-quality' -Code 'AGENT_TIMEOUT' -Message 'Luna agent exceeded the bounded timeout' -Eligible $true
  }
  if ($agent.exitCode -ne 0) {
    Stop-Lane -Manifest $manifest -Class 'model-quality' -Code 'AGENT_EXIT_NONZERO' -Message "Luna agent exited with code $($agent.exitCode)" -Eligible $true
  }
  if (-not (Test-Path -LiteralPath $manifest.artifacts.lastResponse -PathType Leaf)) {
    Stop-Lane -Manifest $manifest -Class 'model-quality' -Code 'LAST_RESPONSE_MISSING' -Message 'Codex did not emit the required last response artifact' -Eligible $true
  }
  if ($manifest.changedPaths.Count -eq 0) {
    Stop-Lane -Manifest $manifest -Class 'model-quality' -Code 'NO_SOURCE_DIFF' -Message 'Luna agent produced no source diff' -Eligible $true
  }
  $allowedSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($allowedPath in @($allowlist)) { [void]$allowedSet.Add($allowedPath) }
  $outside = @($manifest.changedPaths | Where-Object { -not $allowedSet.Contains($_) })
  if ($outside.Count -gt 0 -or $hashEvidence.issues.Count -gt 0) {
    Stop-Lane -Manifest $manifest -Class 'scope' -Code 'CHANGED_PATH_OUTSIDE_ALLOWLIST' -Message ("Changed paths were outside the exact allowlist: " + (($outside + $hashEvidence.issues) -join ', ')) -Eligible $true
  }

  try {
    $boundPaths = @()
    foreach ($boundFile in $boundControllerFiles) {
      $boundPaths += Get-SafeExistingFile -PathValue $boundFile.path -Name $boundFile.name
    }
    $afterAgentHashes = Get-FileHashSnapshot -Paths $boundPaths
    foreach ($boundFile in $boundControllerFiles) {
      if ($afterAgentHashes[$boundFile.path] -ne $boundFile.hash) { throw $boundFile.name }
    }
  } catch {
    Stop-Lane -Manifest $manifest -Class 'scope' -Code 'AGENT_CONTROLLER_FILE_CHANGED' -Message 'The Luna process modified a controller-owned policy-bound file' -Eligible $false
  }

  $artifactBeforeVerification = Get-ArtifactSnapshot -ArtifactRoot $artifact
  $hashEvidenceBeforeVerification = $hashEvidence
  $manifest.verification.workingDirectory = $worktree
  $phase = 'verification'
  $verify = Invoke-CapturedProcess -FilePath $verification -Arguments @($verificationArguments) -WorkingDirectory $worktree -Timeout $TimeoutSeconds -OutputBudget $OutputBudgetBytes -StdoutPath $manifest.artifacts.verificationStdout -StderrPath $manifest.artifacts.verificationStderr
  $manifest.verification.started = $verify.started
  $manifest.verification.rootPid = $verify.rootPid
  $manifest.verification.rootStartTicks = $verify.rootStartTicks
  $manifest.verification.jobEmpty = $verify.jobEmpty
  $manifest.verification.containedProcessCount = $verify.containedProcessCount
  $manifest.verification.timedOut = $verify.timedOut
  $manifest.verification.outputOverflowed = $verify.outputOverflowed
  $manifest.verification.cleanupFailed = $verify.cleanupFailed
  $manifest.verification.drainCompleted = $verify.drainCompleted
  $manifest.verification.exitCode = $verify.exitCode
  $manifest.verification.removedEnvironmentNames = @($verify.removedEnvironmentNames)
  $manifest.environment.verificationDroppedNames = @($verify.removedEnvironmentNames)
  $manifest.verification.outputBytes = $verify.outputBytes
  if (-not $verify.started) { $manifest.verification.exitState = 'start-failed' }
  elseif ($verify.cleanupFailed) { $manifest.verification.exitState = 'cleanup-failed' }
  elseif ($verify.outputOverflowed) { $manifest.verification.exitState = 'output-overflow' }
  elseif ($verify.timedOut) { $manifest.verification.exitState = 'timed-out' }
  elseif ($verify.exited) { $manifest.verification.exitState = 'exited' }
  else { $manifest.verification.exitState = 'unknown' }

  $verificationEvidence = Capture-WorktreeEvidence -Manifest $manifest -Worktree $worktree
  $postVerificationHashes = $verificationEvidence.hashes
  $artifactAfterVerification = Get-ArtifactSnapshot -ArtifactRoot $artifact
  # portable.patch is regenerated by Capture-WorktreeEvidence after the
  # verifier's source rescan. It is controller-owned evidence, not a verifier
  # write, so compare only artifacts the verifier could have altered directly.
  $artifactIssues = @(Compare-ArtifactSnapshots -Before $artifactBeforeVerification -After $artifactAfterVerification -IgnoredPaths @('verification-stdout.txt', 'verification-stderr.txt', 'portable.patch'))
  $sourceStatusAfterVerification = Get-SourceStatus -Repo $repo
  $sourceStatusAllAfterVerification = Get-SourceStatus -Repo $repo -IncludeIgnored
  if ($sourceStatusAllAfterVerification -ne $sourceStatusAllBefore) {
    Stop-Lane -Manifest $manifest -Class 'harness' -Code 'SOURCE_CHECKOUT_INTERFERENCE' -Message 'The shared source checkout changed during verification; this is harness interference, not Luna model quality' -Eligible $false
  }
  if ($artifactIssues.Count -gt 0) {
    Stop-Lane -Manifest $manifest -Class 'scope' -Code 'VERIFIER_ARTIFACT_SCOPE_VIOLATION' -Message 'Controller-owned verification modified or created an artifact outside its two bounded output files' -Eligible $false
  }
  $verificationAfterHash = $null
  $codexAfterHash = $null
  $nodeAfterHash = $null
  $promptAfterHash = $null
  try {
    $boundPaths = @()
    foreach ($boundFile in $boundControllerFiles) {
      $boundPaths += Get-SafeExistingFile -PathValue $boundFile.path -Name $boundFile.name
    }
    $afterVerifierHashes = Get-FileHashSnapshot -Paths $boundPaths
    $promptAfterHash = $afterVerifierHashes[$prompt]
    $verificationAfterHash = $afterVerifierHashes[$verification]
    $codexAfterHash = $afterVerifierHashes[$codex]
    $nodeAfterHash = $afterVerifierHashes[$node]
  } catch {
    Stop-Lane -Manifest $manifest -Class 'scope' -Code 'VERIFIER_CONTROLLER_FILE_CHANGED' -Message 'The controller-owned verifier or executable changed during verification' -Eligible $false
  }
  if ($promptAfterHash -ne $manifest.prompt.sha256 -or $verificationAfterHash -ne $verificationHash -or $codexAfterHash -ne $codexHash -or $nodeAfterHash -ne $nodeHash) {
    Stop-Lane -Manifest $manifest -Class 'scope' -Code 'VERIFIER_CONTROLLER_FILE_CHANGED' -Message 'A controller-owned policy-bound file changed during verification' -Eligible $false
  }
  $verificationHashIssues = @(Compare-HashEvidence -Before $hashEvidenceBeforeVerification -After $postVerificationHashes)
  $postOutside = @($manifest.changedPaths | Where-Object { -not $allowedSet.Contains($_) })
  if ($postOutside.Count -gt 0 -or $postVerificationHashes.issues.Count -gt 0 -or $verificationHashIssues.Count -gt 0) {
    Stop-Lane -Manifest $manifest -Class 'scope' -Code 'VERIFIER_WORKTREE_SCOPE_VIOLATION' -Message 'Verification changed an allowlist path, created an out-of-allowlist path, or introduced an unsafe worktree path' -Eligible $false
  }
  if (-not $verify.started) {
    Stop-Lane -Manifest $manifest -Class 'harness' -Code 'VERIFICATION_START_FAILED' -Message 'Independent verification program could not start' -Eligible $false
  }
  if ($verify.cleanupFailed -or -not $verify.drainCompleted) {
    Stop-Lane -Manifest $manifest -Class 'harness' -Code 'PROCESS_CLEANUP_FAILED' -Message 'The verification process tree or bounded output streams could not be reaped by the finite cleanup deadline' -Eligible $false
  }
  if ($verify.outputOverflowed -or $manifest.verification.outputBytes -gt $OutputBudgetBytes) {
    Stop-Lane -Manifest $manifest -Class 'test' -Code 'VERIFICATION_OUTPUT_BUDGET_EXCEEDED' -Message 'Independent verification stdout and stderr exceeded the declared output budget' -Eligible $true
  }
  if ($verify.timedOut) {
    Stop-Lane -Manifest $manifest -Class 'test' -Code 'VERIFICATION_TIMEOUT' -Message 'Independent verification exceeded the bounded timeout' -Eligible $true
  }
  if ($verify.exitCode -ne 0) {
    Stop-Lane -Manifest $manifest -Class 'test' -Code 'VERIFICATION_FAILED' -Message "Independent verification exited with code $($verify.exitCode)" -Eligible $true
  }
  $manifest.verification.passed = $true
  $manifest.terminalState = 'accepted'
  $manifest.failureClass = $null
  $manifest.failureCode = $null
  $manifest.failureMessage = $null
  $manifest.eligibleForDenominator = $true
  $script:ExitCode = 0
  }
} catch {
  $exception = $_.Exception
  $isTerminalStop = $exception.Data.Contains('TerminalStop') -and [bool]$exception.Data['TerminalStop']
  if (-not $isTerminalStop) {
    $class = Get-ExceptionData -Exception $exception -Name 'LaneClass' -Fallback ($(if ($phase -eq 'preflight') { 'preflight' } else { 'harness' }))
    $code = Get-ExceptionData -Exception $exception -Name 'LaneCode' -Fallback 'UNHANDLED_LANE_ERROR'
    $message = $exception.Message
    if ($null -ne $_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
      $message = "$message | $($_.InvocationInfo.PositionMessage)"
    }
    Set-LaneFailure -Manifest $manifest -Class $class -Code $code -Message $message -Eligible $false
  }
} finally {
  if ($createdWorktree -or (Test-Path -LiteralPath $WorktreePath)) {
    $manifest.worktree.preserved = $true
  }
  if ($artifactReady) {
    try {
      Write-TerminalManifest -Manifest $manifest -Path $manifest.artifacts.terminalManifest
    } catch {
      Set-LaneFailure -Manifest $manifest -Class 'harness' -Code 'MANIFEST_WRITE_FAILED' -Message $_.Exception.Message -Eligible $false
      try { Write-TerminalManifest -Manifest $manifest -Path $manifest.artifacts.terminalManifest } catch { }
    }
  }
}

if ($preparationCompleted) {
  Write-Output (ConvertTo-JsonText -Value $preparedPolicy)
  exit 0
}

Write-Output (ConvertTo-JsonText -Value $manifest)
exit $script:ExitCode
