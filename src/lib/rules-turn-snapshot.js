'use strict';

// The host takes one complete canonical read before each enabled turn and
// rechecks it after any asynchronous admission wait. No truncated prompt or
// caller-supplied acknowledgement can stand in for that read. This establishes
// delivery of the rules to the provider, not the model's comprehension of them.
const crypto = require('node:crypto');
const ledger = require('./owner-request-store');

const SETTING_ID = 'rules.require_read_each_turn';
// Below the shared adapter's 1,000,000-character request ceiling, with room for
// the host's 200,000-character user message and other retained instructions.
// Smaller provider limits still refuse the complete request; nothing is shed.
const MAX_RULES_TURN_BYTES = 512 * 1024;
const issuedSnapshots = new WeakMap();

class RulesTurnSnapshotError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RulesTurnSnapshotError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(code, message, details) { throw new RulesTurnSnapshotError(code, message, details); }
function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function loadRulesReadMode({ loadSettings = require('./settings').loadSettings } = {}) {
  let setting;
  try { setting = loadSettings({ ids: [SETTING_ID] }); }
  catch { fail('RULES_POLICY_UNAVAILABLE', 'The rule-reading setting could not be checked. Nothing was started.'); }
  if (!plain(setting) || !plain(setting.values)
      || !Array.isArray(setting.rejected)
      || setting.rejected.some(row => row?.id === '*' || row?.id === SETTING_ID)
      || typeof setting.values[SETTING_ID] !== 'boolean') {
    fail('RULES_POLICY_UNAVAILABLE', 'The rule-reading setting is unavailable or invalid. Nothing was started.');
  }
  return Object.freeze({ enabled: setting.values[SETTING_ID] });
}

function scopeKey(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !ledger.SAFE_KEY.test(value)) {
    fail('RULES_CONTEXT_SCOPE_INVALID', `The saved ${label} for the current rules is invalid. Nothing was started.`);
  }
  return value;
}

function scopeIdentity(value = {}) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !['sessionId', 'treeAnchors', 'threadId'].includes(key))) {
    fail('RULES_CONTEXT_SCOPE_INVALID', 'The saved rule scope is invalid. Nothing was started.');
  }
  const anchors = value.treeAnchors === undefined ? [] : value.treeAnchors;
  if (!Array.isArray(anchors)) {
    fail('RULES_CONTEXT_SCOPE_INVALID', 'The saved tree ancestry for the current rules is invalid. Nothing was started.');
  }
  const treeAnchors = anchors.map(anchor => {
    const key = scopeKey(anchor, 'tree identity');
    if (key === null) fail('RULES_CONTEXT_SCOPE_INVALID', 'A saved tree identity is missing. Nothing was started.');
    return key;
  });
  if (new Set(treeAnchors).size !== treeAnchors.length) {
    fail('RULES_CONTEXT_SCOPE_INVALID', 'The saved tree ancestry repeats a scope. Nothing was started.');
  }
  return Object.freeze({
    sessionId: scopeKey(value.sessionId, 'session identity'),
    treeAnchors: Object.freeze(treeAnchors),
    threadId: scopeKey(value.threadId, 'conversation identity'),
  });
}

function sourceOf({ store = ledger, storeOptions = {}, maxBytes = MAX_RULES_TURN_BYTES } = {}) {
  if (!store || typeof store.readAll !== 'function' || !plain(storeOptions)
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RULES_TURN_BYTES) {
    fail('RULES_CONTEXT_READER_INVALID', 'The complete rule reader is unavailable. Nothing was started.');
  }
  return Object.freeze({ read: store.readAll.bind(store), options: Object.freeze({ ...storeOptions }), maxBytes });
}

function readSnapshot(identity, source) {
  let all;
  try {
    // A single canonical document read keeps all layers on the same revision.
    // Include inactive records for validation, then use the store's existing
    // scope and active-status semantics. T/A/P records never become rules.
    all = source.read({ ...source.options, kinds: ['R'], includeRemoved: true, includeProposed: true, requireCompleteRules: true });
  } catch (error) {
    fail('RULES_CONTEXT_UNAVAILABLE', 'Your current Ledger rules could not be read completely. Nothing was started.', {
      causeCode: typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : null,
    });
  }
  if (!plain(all) || all.exists !== true || !Number.isSafeInteger(all.revision) || all.revision < 0
      || !Array.isArray(all.records) || all.complete === false || all.truncated === true
      || (all.nextOffset !== undefined && all.nextOffset !== null)
      || (all.warnings !== undefined && (!Array.isArray(all.warnings) || all.warnings.length))) {
    fail('RULES_CONTEXT_UNAVAILABLE', 'Your current Ledger rules are missing or incomplete. Nothing was started.');
  }
  const ids = new Set();
  for (const record of all.records) {
    if (!plain(record) || ledger.idKind(record.id) !== 'R' || record.kind !== 'R'
        || ids.has(record.id) || !ledger.SCOPES.includes(record.scope)
        || (record.scope !== 'global' && (typeof record.scopeKey !== 'string' || !ledger.SAFE_KEY.test(record.scopeKey)))) {
      fail('RULES_CONTEXT_INCOMPLETE', 'A Ledger rule has an invalid identity or scope. Nothing was started.');
    }
    ids.add(record.id);
  }
  const applicable = ledger.selectForContext(all.records, identity);
  for (const record of applicable) {
    if (!Object.hasOwn(ledger.STATUS_VOCABULARY, record.status)) {
      fail('RULES_CONTEXT_INCOMPLETE', 'An applicable Ledger rule has an unknown status. Nothing was started.');
    }
    if (ledger.ACTIVE_STATUSES.has(record.status)
        && (typeof record.verbatim !== 'string' || record.verbatim.trim().length === 0)) {
      fail('RULES_CONTEXT_INCOMPLETE', 'The complete wording of an applicable Ledger rule is missing. Nothing was started.');
    }
  }
  const active = applicable.filter(record => ledger.ACTIVE_STATUSES.has(record.status));
  const layers = [['global', null]];
  if (identity.sessionId !== null) layers.push(['session', identity.sessionId]);
  for (const anchor of identity.treeAnchors) layers.push(['tree', anchor]);
  if (identity.threadId !== null) layers.push(['thread', identity.threadId]);
  const scopes = layers.map(([scope, key]) => {
    const selected = active.filter(record => record.scope === scope && (scope === 'global' || record.scopeKey === key));
    const entries = ledger.nestEntries(selected.map(record => ({
      id: record.id, parentId: record.parentId, status: record.status, words: record.verbatim,
    })));
    if (entries.length !== selected.length) {
      fail('RULES_CONTEXT_INCOMPLETE', 'The complete order of an applicable Ledger rule could not be established. Nothing was started.');
    }
    return Object.freeze({ scope, key, entries: Object.freeze(entries) });
  });
  const ruleCount = scopes.reduce((total, scope) => total + scope.entries.length, 0);
  if (ruleCount !== active.length) {
    fail('RULES_CONTEXT_INCOMPLETE', 'Not every applicable Ledger rule could be included. Nothing was started.');
  }
  const lines = [
    'Current active Ledger rules for this turn',
    'Read and apply every rule below. This complete block replaces earlier Ledger rule blocks; removed and resolved rules no longer apply.',
  ];
  for (const layer of scopes) {
    lines.push('', `${ledger.SCOPE_WORD[layer.scope]}${layer.key === null ? '' : ` [${layer.key}]`}`);
    if (layer.entries.length === 0) lines.push('No active rules in this scope.');
    for (const entry of layer.entries) lines.push(`${entry.id}${entry.parentId ? ` (refines ${entry.parentId})` : ''}:`, entry.words);
  }
  const text = lines.join('\n');
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > source.maxBytes) {
    fail('RULES_CONTEXT_TOO_LARGE', 'Your complete applicable rules are too large for this turn. Nothing was started and no rules were left out.', {
      byteLength, maxBytes: source.maxBytes, ruleCount,
    });
  }
  const digest = crypto.createHash('sha256').update(JSON.stringify({ version: 1, identity, scopes }), 'utf8').digest('hex');
  const snapshot = Object.freeze({ complete: true, revision: all.revision, digest, text, ruleCount,
    scopes: Object.freeze(scopes), byteLength });
  issuedSnapshots.set(snapshot, { identity, source });
  return snapshot;
}

function buildRulesTurnSnapshot(identity = {}, options = {}) {
  return readSnapshot(scopeIdentity(identity), sourceOf(options));
}

function assertRulesTurnSnapshotCurrent(snapshot, currentIdentity = undefined) {
  const issued = snapshot && issuedSnapshots.get(snapshot);
  if (!issued) fail('RULES_CONTEXT_UNVERIFIED', 'The complete rule snapshot could not be verified. Nothing was started.');
  const current = readSnapshot(currentIdentity === undefined ? issued.identity : scopeIdentity(currentIdentity), issued.source);
  if (current.digest !== snapshot.digest) {
    fail('RULES_CONTEXT_CHANGED', 'Your applicable rules or saved tree scope changed before this turn could start. Send again to use the current rules. Nothing was started.');
  }
  return current;
}

module.exports = Object.freeze({ SETTING_ID, MAX_RULES_TURN_BYTES, RulesTurnSnapshotError,
  loadRulesReadMode, buildRulesTurnSnapshot, assertRulesTurnSnapshotCurrent });
