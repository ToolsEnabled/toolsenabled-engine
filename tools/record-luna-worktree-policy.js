#!/usr/bin/env node
'use strict';

// The controller-only signing boundary for a closed-profile worktree lane. The
// executable is intentionally self-rooted: its CLI accepts a launch ID and
// the exact preparation packet only.  It never accepts an audit path, vault,
// key, module, root, or other signing seam from a caller.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LAUNCH_ACTION = 'controller.agent.launch';
const POLICY_ACTION = 'controller.agent.launch.policy';
const LAUNCH_ID_RE = /^launch_[A-Za-z0-9_-]{16,64}$/;
const OBJECTIVE_REF_RE = /^(?:Q(?:[1-9][0-9]{0,2})|R(?:[1-9][0-9]{0,3}))$/;
const LANE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const MAX_PREPARED_POLICY_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_ARGUMENT_BYTES = 8192;
const SCOPE_RULE_ID_RE = /^rule_[a-z0-9][a-z0-9._:-]{1,127}$/;
const SCOPE_RULE_KEY_RE = /^[a-z][a-z0-9._:-]{0,63}$/;
const SCOPE_THREAD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SCOPE_REQUEST_ID_RE = /^R[0-9]{1,4}$/;
const SCOPE_EVIDENCE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,511}$/;
const SCOPE_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SCOPE_CONFLICT_REASONS = new Set([
  'newer-or-equal-thread-override',
  'newer-global-default',
  'newer-or-equal-rule',
]);
const TRANSACTION_REFUSAL_CODES = new Set([
  'POLICY_ALREADY_EXISTS',
  'POLICY_LAUNCH_NOT_FOUND',
  'POLICY_LAUNCH_CONFLICT',
  'POLICY_LAUNCH_INVALID',
  'POLICY_LAUNCH_MISMATCH',
  'POLICY_OBJECTIVE_MISMATCH',
  'POLICY_RECORD_UNAVAILABLE',
]);

class PolicyRecordError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PolicyRecordError';
    this.code = code;
  }
}

function fail(code) { throw new PolicyRecordError(code); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys) {
  if (!plain(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) fail('PREPARED_POLICY_INVALID');
  return value;
}
function boundedText(value, limit) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= limit;
}
function safeInteger(value, minimum, maximum) { return Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function boundedStrings(value, maximumItems, maximumBytes) {
  return Array.isArray(value) && value.length <= maximumItems && value.every(item => boundedText(item, maximumBytes));
}

function agentProfile(model, reasoningEffort) {
  if (model === 'gpt-5.6-luna' && reasoningEffort === 'max') return { targetAgentId: 'luna', tier: 'cheap', tierProposed: false };
  if (model === 'gpt-5.6-terra' && reasoningEffort === 'xhigh') return { targetAgentId: 'terra', tier: 'standard', tierProposed: true };
  if (model === 'gpt-5.6-sol' && reasoningEffort === 'ultra') return { targetAgentId: 'sol', tier: 'premium', tierProposed: true };
  return null;
}

function validAgentSandbox(agent) {
  const legacy = agent.sandbox === 'workspace-write';
  const npmProfile = agent.sandbox === 'permission-profile:lane-npm-registry';
  if (!legacy && !npmProfile) return false;
  const sandboxIndex = agent.arguments.indexOf('--sandbox');
  const ignoreConfigIndex = agent.arguments.indexOf('--ignore-user-config');
  const hasLegacySandbox = sandboxIndex >= 0 && agent.arguments[sandboxIndex + 1] === 'workspace-write';
  const requiredProfileArguments = [
    'default_permissions="lane-npm-registry"',
    'permissions.lane-npm-registry.extends=":workspace"',
    'permissions.lane-npm-registry.network.enabled=true',
    'permissions.lane-npm-registry.network.domains={ "registry.npmjs.org" = "allow", "127.0.0.1" = "allow" }',
  ];
  if (legacy) return hasLegacySandbox && !requiredProfileArguments.some(argument => agent.arguments.includes(argument));
  return sandboxIndex === -1 && ignoreConfigIndex >= 0 &&
    requiredProfileArguments.every(argument => agent.arguments.indexOf(argument) > ignoreConfigIndex);
}

function exactKeys(value, keys) {
  return plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isSafeInteger(Date.parse(value));
}

function validScopeThreadId(value) {
  return value === null || (typeof value === 'string' && SCOPE_THREAD_ID_RE.test(value));
}

function validEvidenceRefs(value) {
  if (!Array.isArray(value) || value.length > 32) return false;
  const seen = new Set();
  for (const ref of value) {
    if (typeof ref !== 'string' || !SCOPE_EVIDENCE_REF_RE.test(ref) || seen.has(ref)) return false;
    seen.add(ref);
  }
  return true;
}

function validScopeRule(value, packetThreadId, includeVerbatim) {
  const keys = [
    'ruleId', 'ruleKey', 'scopeKind', 'threadId', 'sourceRequestId',
    'issuedAt', 'expiresAt', 'decisionSummary', 'evidenceRefs'
  ];
  if (includeVerbatim) keys.push('ownerVerbatim');
  if (!exactKeys(value, keys) || !SCOPE_RULE_ID_RE.test(value.ruleId) || !SCOPE_RULE_KEY_RE.test(value.ruleKey) ||
      !['global', 'thread'].includes(value.scopeKind) || !SCOPE_REQUEST_ID_RE.test(value.sourceRequestId) ||
      !validTimestamp(value.issuedAt) || (value.expiresAt !== null && !validTimestamp(value.expiresAt)) ||
      !boundedText(value.decisionSummary, 2000) || !validEvidenceRefs(value.evidenceRefs) ||
      (includeVerbatim && !boundedText(value.ownerVerbatim, 20000))) return false;
  if (value.expiresAt !== null && Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) return false;
  if (value.scopeKind === 'global') return value.threadId === null;
  return packetThreadId !== null && value.threadId === packetThreadId;
}

function validScopeConflict(value, packetThreadId) {
  if (!exactKeys(value, ['ruleKey', 'winner', 'losers']) || !SCOPE_RULE_KEY_RE.test(value.ruleKey) ||
      !validScopeRule(value.winner, packetThreadId, false) || value.winner.ruleKey !== value.ruleKey ||
      !Array.isArray(value.losers) || value.losers.length === 0 || value.losers.length > 2000) return false;
  const seen = new Set([value.winner.ruleId]);
  for (const loser of value.losers) {
    if (!exactKeys(loser, ['reason', 'provenance']) || !SCOPE_CONFLICT_REASONS.has(loser.reason) ||
        !validScopeRule(loser.provenance, packetThreadId, false) || loser.provenance.ruleKey !== value.ruleKey ||
        seen.has(loser.provenance.ruleId)) return false;
    seen.add(loser.provenance.ruleId);
  }
  return true;
}

function validScopePacket(value, expectedAgentId) {
  const keys = ['schemaVersion', 'agentId', 'threadId', 'generatedAt', 'appliedRuleIds', 'rules', 'conflicts', 'grantsAuthority'];
  if (!exactKeys(value, keys) || value.schemaVersion !== 1 || value.grantsAuthority !== false ||
      typeof expectedAgentId !== 'string' || !SCOPE_AGENT_ID_RE.test(expectedAgentId) || value.agentId !== expectedAgentId ||
      !validScopeThreadId(value.threadId) || !validTimestamp(value.generatedAt) ||
      !Array.isArray(value.appliedRuleIds) || !Array.isArray(value.rules) || !Array.isArray(value.conflicts) ||
      value.rules.length > 2000 || value.conflicts.length > 2000 || value.appliedRuleIds.length !== value.rules.length) return false;
  const ids = [];
  const seen = new Set();
  for (const rule of value.rules) {
    if (!validScopeRule(rule, value.threadId, true) || seen.has(rule.ruleId)) return false;
    seen.add(rule.ruleId);
    ids.push(rule.ruleId);
  }
  if (ids.some((ruleId, index) => value.appliedRuleIds[index] !== ruleId)) return false;
  return value.conflicts.every(conflict => validScopeConflict(conflict, value.threadId));
}

function canonicalRoot() {
  const ownFile = fs.realpathSync.native(__filename);
  const toolsDirectory = path.dirname(ownFile);
  if (path.basename(toolsDirectory).toLowerCase() !== 'tools') fail('POLICY_RECORDER_ROOT_INVALID');
  return path.dirname(toolsDirectory);
}

function loadCanonicalAudit() {
  // This is intentionally not parameterized.  The root is anchored at this
  // helper's own real path, so the CLI cannot redirect an audit write to a
  // caller-selected checkout, database, module, key, or vault.
  return require(path.join(canonicalRoot(), 'src', 'lib', 'audit.js'));
}

function preparedPolicyBytes(policy) {
  let json;
  try { json = JSON.stringify(policy); }
  catch { fail('PREPARED_POLICY_INVALID'); }
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_PREPARED_POLICY_BYTES) fail('PREPARED_POLICY_TOO_LARGE');
  return json;
}

function validatePreparedPolicy(launchId, policy) {
  if (typeof launchId !== 'string' || !LAUNCH_ID_RE.test(launchId)) fail('POLICY_LAUNCH_ID_INVALID');
  preparedPolicyBytes(policy);
  exact(policy, ['schemaVersion', 'controllerActor', 'launchId', 'laneId', 'objectiveRef', 'baseCommit', 'allowlist', 'prompt', 'verification', 'timeoutSeconds', 'outputBudgetBytes', 'agent', 'auditAnchor']);
  if (policy.launchId !== launchId) fail('POLICY_LAUNCH_MISMATCH');
  if (policy.schemaVersion !== 1 || policy.controllerActor !== 'codex' ||
      typeof policy.laneId !== 'string' || !LANE_ID_RE.test(policy.laneId) ||
      typeof policy.objectiveRef !== 'string' || !OBJECTIVE_REF_RE.test(policy.objectiveRef) ||
      typeof policy.baseCommit !== 'string' || !/^[a-f0-9]{40}$/.test(policy.baseCommit) ||
      !boundedStrings(policy.allowlist, 128, 1024) || policy.allowlist.length < 1 ||
      !safeInteger(policy.timeoutSeconds, 1, 86400) || !safeInteger(policy.outputBudgetBytes, 65536, 67108864)) {
    fail('PREPARED_POLICY_INVALID');
  }
  exact(policy.prompt, ['path', 'sha256']);
  if (!boundedText(policy.prompt.path, MAX_PATH_BYTES) || typeof policy.prompt.sha256 !== 'string' || !HASH_RE.test(policy.prompt.sha256)) fail('PREPARED_POLICY_INVALID');
  exact(policy.verification, ['program', 'sha256', 'arguments', 'allowChangedPathArguments']);
  if (!boundedText(policy.verification.program, MAX_PATH_BYTES) || typeof policy.verification.sha256 !== 'string' || !HASH_RE.test(policy.verification.sha256) ||
      !boundedStrings(policy.verification.arguments, 256, MAX_ARGUMENT_BYTES) || typeof policy.verification.allowChangedPathArguments !== 'boolean') fail('PREPARED_POLICY_INVALID');
  exact(policy.agent, ['program', 'sha256', 'prefixArguments', 'arguments', 'model', 'reasoningEffort', 'sandbox', 'nodePath', 'nodeSha256']);
  if (!boundedText(policy.agent.program, MAX_PATH_BYTES) || typeof policy.agent.sha256 !== 'string' || !HASH_RE.test(policy.agent.sha256) ||
      !boundedStrings(policy.agent.prefixArguments, 128, MAX_ARGUMENT_BYTES) || !boundedStrings(policy.agent.arguments, 128, MAX_ARGUMENT_BYTES) ||
      !agentProfile(policy.agent.model, policy.agent.reasoningEffort) || !validAgentSandbox(policy.agent) ||
      !boundedText(policy.agent.nodePath, MAX_PATH_BYTES) || typeof policy.agent.nodeSha256 !== 'string' || !HASH_RE.test(policy.agent.nodeSha256)) fail('PREPARED_POLICY_INVALID');
  exact(policy.auditAnchor, ['schemaVersion', 'launchEventId', 'launchSequence', 'launchPreviousHash', 'launchEventHash', 'launchKeyId', 'launchPublicKeyHash']);
  if (policy.auditAnchor.schemaVersion !== 1 || typeof policy.auditAnchor.launchEventId !== 'string' || !EVENT_ID_RE.test(policy.auditAnchor.launchEventId) ||
      !safeInteger(policy.auditAnchor.launchSequence, 1, Number.MAX_SAFE_INTEGER) || typeof policy.auditAnchor.launchPreviousHash !== 'string' || !HASH_RE.test(policy.auditAnchor.launchPreviousHash) ||
      typeof policy.auditAnchor.launchEventHash !== 'string' || !HASH_RE.test(policy.auditAnchor.launchEventHash) ||
      typeof policy.auditAnchor.launchKeyId !== 'string' || !EVENT_ID_RE.test(policy.auditAnchor.launchKeyId) ||
      typeof policy.auditAnchor.launchPublicKeyHash !== 'string' || !HASH_RE.test(policy.auditAnchor.launchPublicKeyHash)) fail('PREPARED_POLICY_INVALID');
  return Object.freeze(policy);
}

function launchFromSelectedEvent(launchId, entry, expectedPolicy) {
  if (!plain(entry) || !safeInteger(entry.sequence, 1, Number.MAX_SAFE_INTEGER) || typeof entry.eventId !== 'string' || !EVENT_ID_RE.test(entry.eventId) ||
      typeof entry.previousHash !== 'string' || !HASH_RE.test(entry.previousHash) || typeof entry.eventHash !== 'string' || !HASH_RE.test(entry.eventHash) ||
      typeof entry.keyId !== 'string' || !EVENT_ID_RE.test(entry.keyId)) fail('POLICY_LAUNCH_INVALID');
  const event = entry.event;
  if (!plain(event) || event.action !== LAUNCH_ACTION || event.target !== launchId || !exactLaunchDetails(event.details)) fail('POLICY_LAUNCH_INVALID');
  const record = event.details.record;
  const profile = agentProfile(expectedPolicy.agent.model, expectedPolicy.agent.reasoningEffort);
  const hasScopePacket = Object.hasOwn(record, 'scopePacket');
  if (!profile || record.schemaVersion !== 1 || record.launchId !== launchId || !LAUNCH_ID_RE.test(record.launchId) ||
      record.requestingActor !== 'codex' || record.targetAgentId !== profile.targetAgentId || record.tier !== profile.tier || record.tierProposed !== profile.tierProposed ||
      record.model !== expectedPolicy.agent.model || typeof record.objectiveRef !== 'string' || !OBJECTIVE_REF_RE.test(record.objectiveRef) ||
      !plain(record.cap) || !['turns', 'budget'].includes(record.cap.kind) || !safeInteger(record.cap.value, 1, 100000) ||
      !safeInteger(record.cap.capMs, 60000, 86400000) || record.parentLaunchId !== null || record.depth !== 0 ||
      record.terminalState !== 'pending' || typeof record.launchedAt !== 'string' || !Number.isSafeInteger(Date.parse(record.launchedAt)) ||
      (hasScopePacket && !validScopePacket(record.scopePacket, record.targetAgentId))) fail('POLICY_LAUNCH_INVALID');
  if (profile.targetAgentId === 'sol' && (!hasScopePacket || !record.scopePacket.rules.some(rule =>
    rule.ruleKey === 'game.agent.model'
  ))) fail('POLICY_LAUNCH_INVALID');
  return { entry, record };
}

function exactLaunchDetails(value) {
  if (!plain(value) || Object.keys(value).length !== 2 || value.schemaVersion !== 1 || !plain(value.record)) return false;
  const keys = ['schemaVersion', 'launchId', 'requestingActor', 'targetAgentId', 'tier', 'tierProposed', 'model', 'objectiveRef', 'cap', 'parentLaunchId', 'depth', 'launchedAt', 'terminalState'];
  const allowedKeys = Object.hasOwn(value.record, 'scopePacket') ? [...keys, 'scopePacket'] : keys;
  return Object.keys(value.record).length === allowedKeys.length && allowedKeys.every(key => Object.hasOwn(value.record, key));
}

function assertLaunchPolicyMatch(policy, selectedLaunch) {
  const { entry, record } = selectedLaunch;
  if (record.objectiveRef !== policy.objectiveRef) fail('POLICY_OBJECTIVE_MISMATCH');
  const anchor = policy.auditAnchor;
  if (anchor.launchEventId !== entry.eventId || anchor.launchSequence !== entry.sequence || anchor.launchPreviousHash !== entry.previousHash ||
      anchor.launchEventHash !== entry.eventHash || anchor.launchKeyId !== entry.keyId) fail('POLICY_LAUNCH_MISMATCH');
  if (record.model !== policy.agent.model || record.requestingActor !== policy.controllerActor || record.cap.capMs < policy.timeoutSeconds * 1000) fail('POLICY_LAUNCH_MISMATCH');
}

function sanitizedReceipt(launchId, objectiveRef, receipt) {
  if (!plain(receipt) || receipt.recorded !== true || receipt.durable !== true || receipt.anchored !== true ||
      !safeInteger(receipt.sequence, 1, Number.MAX_SAFE_INTEGER) || typeof receipt.eventHash !== 'string' || !HASH_RE.test(receipt.eventHash)) {
    fail('POLICY_RECORD_RECEIPT_INVALID');
  }
  return Object.freeze({
    ok: true,
    code: 'POLICY_RECORDED',
    launchId,
    objectiveRef,
    sequence: receipt.sequence,
    eventHash: receipt.eventHash,
    durable: true,
    anchored: true,
  });
}

function recordPreparedPolicy(launchId, policy, dependencies = {}) {
  const validated = validatePreparedPolicy(launchId, policy);
  const auditApi = dependencies.auditApi;
  if (!auditApi || typeof auditApi.conditionalRecord !== 'function') fail('POLICY_RECORD_UNAVAILABLE');
  const eventId = dependencies.eventId || `luna-policy-${crypto.randomUUID()}`;
  if (typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId)) fail('POLICY_RECORD_UNAVAILABLE');
  let receipt;
  try {
    receipt = auditApi.conditionalRecord({
      action: POLICY_ACTION,
      target: launchId,
      eventId,
      decide: ({ findEvents }) => {
        try {
          if (typeof findEvents !== 'function') fail('POLICY_RECORD_UNAVAILABLE');
          const launchRows = findEvents({ action: LAUNCH_ACTION, target: launchId, limit: 2 });
          if (!Array.isArray(launchRows)) fail('POLICY_RECORD_UNAVAILABLE');
          if (launchRows.length === 0) fail('POLICY_LAUNCH_NOT_FOUND');
          if (launchRows.length !== 1) fail('POLICY_LAUNCH_CONFLICT');
          assertLaunchPolicyMatch(validated, launchFromSelectedEvent(launchId, launchRows[0], validated));
          const policies = findEvents({ action: POLICY_ACTION, target: launchId, limit: 2 });
          if (!Array.isArray(policies)) fail('POLICY_RECORD_UNAVAILABLE');
          if (policies.length !== 0) return { kind: 'refused', refusal: 'POLICY_ALREADY_EXISTS' };
          return { kind: 'record', details: validated };
        } catch (error) {
          if (error instanceof PolicyRecordError && TRANSACTION_REFUSAL_CODES.has(error.code)) {
            return { kind: 'refused', refusal: error.code };
          }
          throw error;
        }
      }
    });
  } catch (error) {
    if (error instanceof PolicyRecordError) throw error;
    fail('POLICY_RECORD_UNAVAILABLE');
  }
  if (plain(receipt) && receipt.recorded === false && TRANSACTION_REFUSAL_CODES.has(receipt.refusal)) fail(receipt.refusal);
  return sanitizedReceipt(launchId, validated.objectiveRef, receipt);
}

function parsePreparedPolicyInput(source) {
  if (!Buffer.isBuffer(source) || source.length === 0) fail('POLICY_INPUT_INVALID');
  if (source.length > MAX_PREPARED_POLICY_BYTES) fail('POLICY_INPUT_TOO_LARGE');
  // Windows PowerShell 5.1 writes one UTF-8 preamble when a captured string is
  // piped to a native executable.  That preamble is transport encoding, not a
  // byte in the preparation JSON emitted by the runner.  Accept exactly one
  // leading UTF-8 BOM so the documented copy/paste-safe pipeline works on the
  // canonical Windows host; JSON.parse still refuses repeated BOMs, UTF-16,
  // trailing data, or any other mutation of the prepared packet.
  const jsonBytes = source.length >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf
    ? source.subarray(3) : source;
  if (jsonBytes.length === 0) fail('POLICY_INPUT_INVALID');
  let policy;
  try { policy = JSON.parse(jsonBytes.toString('utf8')); }
  catch { fail('POLICY_INPUT_INVALID'); }
  if (!plain(policy)) fail('POLICY_INPUT_INVALID');
  return policy;
}

function readBoundedStdin() {
  const chunks = [];
  let total = 0;
  const chunk = Buffer.allocUnsafe(8192);
  while (true) {
    const remaining = MAX_PREPARED_POLICY_BYTES + 1 - total;
    const bytesRead = fs.readSync(0, chunk, 0, Math.min(chunk.length, remaining), null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > MAX_PREPARED_POLICY_BYTES) fail('POLICY_INPUT_TOO_LARGE');
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks, total);
}

function outcome(ok, code, extra = {}) {
  return JSON.stringify({ ok, code, ...extra }) + '\n';
}

function main(argv = process.argv.slice(2)) {
  try {
    if (!Array.isArray(argv) || argv.length !== 1 || typeof argv[0] !== 'string' || !LAUNCH_ID_RE.test(argv[0])) fail('POLICY_CLI_USAGE');
    const launchId = argv[0];
    const policy = parsePreparedPolicyInput(readBoundedStdin());
    // The CLI always resolves this helper's real-path root and the canonical
    // audit module below.  Injectable APIs are confined to the exported pure
    // recording function for deterministic, ledger-isolated unit tests.
    const receipt = recordPreparedPolicy(launchId, policy, { auditApi: loadCanonicalAudit() });
    process.stdout.write(outcome(true, receipt.code, {
      launchId: receipt.launchId,
      objectiveRef: receipt.objectiveRef,
      sequence: receipt.sequence,
      eventHash: receipt.eventHash,
      durable: true,
      anchored: true,
    }));
    return 0;
  } catch (error) {
    const code = error instanceof PolicyRecordError ? error.code : 'POLICY_RECORD_UNAVAILABLE';
    process.stdout.write(outcome(false, code));
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = Object.freeze({
  LAUNCH_ACTION,
  POLICY_ACTION,
  MAX_PREPARED_POLICY_BYTES,
  PolicyRecordError,
  canonicalRoot,
  parsePreparedPolicyInput,
  recordPreparedPolicy,
  sanitizedReceipt,
  validatePreparedPolicy,
  main,
});
