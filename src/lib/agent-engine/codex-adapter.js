'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');

const {
  validateApprovalAnswer,
  validateEngineEvent,
  validateSendTurnRequest,
  validateThreadId,
  validateThreadOptions
} = require('./engine-contract');

// Generated locally from codex-cli 0.146.0 with:
//   codex app-server generate-json-schema --out <temporary directory>
//   codex app-server generate-ts --out <temporary directory>
// These constants identify the original fixture, not a CLI admission rule.
// Compatibility is established by the running server's responses. Installing a
// new CLI must not disable every session until the desktop is rebuilt.
const CODEX_CLI_VERSION = '0.146.0';
const CODEX_PROTOCOL_COMPATIBILITY_LINE = '0.146';

const METHOD = Object.freeze({
  initialize: 'initialize',
  threadStart: 'thread/start',
  threadResume: 'thread/resume',
  threadRead: 'thread/read',
  threadFork: 'thread/fork',
  threadSettingsUpdate: 'thread/settings/update',
  modelList: 'model/list',
  turnStart: 'turn/start',
  turnSteer: 'turn/steer',
  turnInterrupt: 'turn/interrupt',
  commandApproval: 'item/commandExecution/requestApproval',
  fileApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  agentMessageDelta: 'item/agentMessage/delta',
  reasoningSummaryDelta: 'item/reasoning/summaryTextDelta',
  reasoningSummaryPart: 'item/reasoning/summaryPartAdded',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  tokenUsageUpdated: 'thread/tokenUsage/updated',
  turnCompleted: 'turn/completed'
});

const COMMAND_DECISIONS = Object.freeze([
  'accept',
  'acceptForSession',
  'acceptWithExecpolicyAmendment',
  'applyNetworkPolicyAmendment',
  'decline',
  'cancel'
]);
const FILE_DECISIONS = Object.freeze(['accept', 'acceptForSession', 'decline', 'cancel']);
const TERMINAL_TURN_STATUSES = Object.freeze(['completed', 'interrupted', 'failed']);

// Codex turn.error uses the app-server's camel-case error enum, not the
// snake-case names persisted in native rollout files. Translate recognized
// codes into bounded customer copy; provider message/additionalDetails can
// contain account URLs, paths or credentials and must not cross this boundary.
const TURN_FAILURE_TEXT = Object.freeze({
  usageLimitExceeded: 'This Codex account has reached its usage limit. Wait for its allowance to reset or choose another account.',
  contextWindowExceeded: "This Codex conversation has reached the model's context limit.",
  sessionBudgetExceeded: 'This Codex session has reached its budget limit.',
  unauthorized: 'Codex could not authenticate this account. Check its sign-in.',
  rateLimitExceeded: 'Codex is temporarily rate limited. Wait before trying again.',
  serverOverloaded: 'Codex is temporarily overloaded. Try again later.'
});

/* WHEN A USAGE LIMIT ENDS, AS AN INSTANT AND NOTHING ELSE (T1509).
   On 2026-09-22 thirty-seven Codex turns ended on a weekly limit and every
   card said only that the turn failed: the provider's message named the reset
   ("... or try again at Sep 29th, 2026 2:13 AM.") but the whole message is
   withheld here, rightly, because it also carries account URLs. The reset is
   the one part a person can act on, so it is read out of the message with a
   pattern that can only match a month abbreviation, digits and AM/PM, checked
   to be a real near-future moment, and carried as an ISO instant. No other
   byte of the provider's prose crosses. Codex writes the time in this
   computer's local time, and omits the date when the reset is today. */
const RESET_MONTHS = Object.freeze(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']);
const RESET_PATTERN = /\b[Tt]ry again at (?:([A-Za-z]{3}) (\d{1,2})(?:st|nd|rd|th)?, (\d{4}) )?(\d{1,2}):(\d{2}) ?([AaPp][Mm])(?![A-Za-z])/;
function usageLimitResetsAt(message, now) {
  if (typeof message !== 'string') return null;
  const match = RESET_PATTERN.exec(message.slice(0, 4096));
  if (!match) return null;
  const [, monthWord, dayText, yearText, hourText, minuteText, meridiem] = match;
  const hour12 = Number(hourText), minute = Number(minuteText);
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
  const hour = (hour12 % 12) + (/^p/i.test(meridiem) ? 12 : 0);
  const today = new Date(now);
  let at;
  if (monthWord) {
    const month = RESET_MONTHS.indexOf(monthWord.toLowerCase());
    const day = Number(dayText);
    if (month < 0) return null;
    at = new Date(Number(yearText), month, day, hour, minute);
    if (at.getMonth() !== month || at.getDate() !== day) return null;
  } else {
    at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, minute);
  }
  const ms = at.getTime();
  // A reset an hour gone or more than a year away is not one this turn can act on.
  if (!Number.isFinite(ms) || ms < now - 3_600_000 || ms > now + 400 * 86_400_000) return null;
  return at.toISOString();
}
/* Written out by hand rather than through toLocaleString, whose output
   (spaces, punctuation) changes with the ICU build this runs on. */
function resetWords(iso, now) {
  const at = new Date(iso);
  const month = RESET_MONTHS[at.getMonth()];
  const hour12 = at.getHours() % 12 || 12;
  const year = at.getFullYear() === new Date(now).getFullYear() ? '' : ` ${at.getFullYear()}`;
  return `${month[0].toUpperCase()}${month.slice(1)} ${at.getDate()}${year}, ${hour12}:${String(at.getMinutes()).padStart(2, '0')} ${at.getHours() < 12 ? 'AM' : 'PM'}`;
}

class CodexAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CodexAdapterError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CodexAdapterError(code, message);
}

function ownRecord(value, label) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('CODEX_PROTOCOL_INVALID', `${label} must be an object`);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('CODEX_PROTOCOL_INVALID', `${label} must be plain JSON data`);
    if (Object.getOwnPropertySymbols(value).length !== 0) fail('CODEX_PROTOCOL_INVALID', `${label} has symbol keys`);
    const fields = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(fields)) {
      if (!Object.hasOwn(descriptor, 'value')) fail('CODEX_PROTOCOL_INVALID', `${label}.${key} must be data`);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail('CODEX_PROTOCOL_INVALID', `${label} has an unsafe key`);
    }
    return fields;
  } catch (error) {
    if (error instanceof CodexAdapterError) throw error;
    fail('CODEX_PROTOCOL_INVALID', `${label} cannot be inspected safely`);
  }
}

function requiredString(fields, key, label, { allowEmpty = false } = {}) {
  if (!Object.hasOwn(fields, key) || typeof fields[key].value !== 'string' || (!allowEmpty && fields[key].value.length === 0)) {
    fail('CODEX_PROTOCOL_INVALID', `${label}.${key} must be a ${allowEmpty ? 'string' : 'non-empty string'}`);
  }
  return fields[key].value;
}

function optionalString(fields, key, label) {
  if (!Object.hasOwn(fields, key) || fields[key].value === null) return null;
  if (typeof fields[key].value !== 'string') fail('CODEX_PROTOCOL_INVALID', `${label}.${key} must be a string or null`);
  return fields[key].value;
}

function requiredInteger(fields, key, label) {
  if (!Object.hasOwn(fields, key) || !Number.isInteger(fields[key].value)) fail('CODEX_PROTOCOL_INVALID', `${label}.${key} must be an integer`);
  return fields[key].value;
}

function arrayField(fields, key, label, { required = false } = {}) {
  if (!Object.hasOwn(fields, key)) {
    if (required) fail('CODEX_PROTOCOL_INVALID', `${label}.${key} must be an array`);
    return [];
  }
  if (!Array.isArray(fields[key].value)) fail('CODEX_PROTOCOL_INVALID', `${label}.${key} must be an array`);
  return fields[key].value;
}

function jsonData(value, label, depth = 0) {
  if (depth > 32) fail('CODEX_PROTOCOL_INVALID', `${label} is too deeply nested`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => jsonData(entry, `${label}[${index}]`, depth + 1));
  const fields = ownRecord(value, label);
  const copy = {};
  for (const [key, descriptor] of Object.entries(fields)) copy[key] = jsonData(descriptor.value, `${label}.${key}`, depth + 1);
  return copy;
}

function parseVersion(version) {
  if (typeof version !== 'string') fail('CODEX_PROTOCOL_VERSION_MISMATCH', 'Codex app-server requires an injected Codex CLI version');
  const match = /(?:^|\s)(?:codex-cli\s+)?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?(?:\s|$)/.exec(version.trim());
  if (!match) fail('CODEX_PROTOCOL_VERSION_MISMATCH', 'Codex app-server received an unparseable CLI version');
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

// Kept as an export for paired hosts that import the old name. It validates
// the executable's identity output, never compares it with a release allowlist.
function assertPinnedVersion(version) {
  parseVersion(version);
  return version;
}

function validateTransport(transport) {
  if (transport === null || (typeof transport !== 'object' && typeof transport !== 'function')) {
    fail('CODEX_TRANSPORT_INVALID', 'Codex transport must be an object');
  }
  for (const method of ['write', 'onData']) {
    let cursor = transport;
    let descriptor = null;
    for (let depth = 0; cursor !== null && depth < 8; depth += 1, cursor = Object.getPrototypeOf(cursor)) {
      descriptor = Object.getOwnPropertyDescriptor(cursor, method);
      if (descriptor) break;
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      fail('CODEX_TRANSPORT_INVALID', `Codex transport requires data method ${method}()`);
    }
  }
  return transport;
}

function approvalChoices(kind) {
  if (kind === 'commandExecution') return COMMAND_DECISIONS.map(value => Object.freeze({ value }));
  if (kind === 'fileChange') return FILE_DECISIONS.map(value => Object.freeze({ value }));
  return [Object.freeze({ responseFields: Object.freeze(['permissions', 'scope', 'strictAutoReview']), scopes: Object.freeze(['turn', 'session']) })];
}

function validateApprovalParams(method, params) {
  const fields = ownRecord(params, 'approval params');
  const common = {
    threadId: requiredString(fields, 'threadId', 'approval params'),
    turnId: requiredString(fields, 'turnId', 'approval params'),
    itemId: requiredString(fields, 'itemId', 'approval params'),
    startedAtMs: requiredInteger(fields, 'startedAtMs', 'approval params')
  };
  if (method === METHOD.commandApproval) {
    return { kind: 'commandExecution', ...common, details: {
      approvalId: optionalString(fields, 'approvalId', 'approval params'),
      environmentId: optionalString(fields, 'environmentId', 'approval params'),
      reason: optionalString(fields, 'reason', 'approval params'),
      command: optionalString(fields, 'command', 'approval params'),
      cwd: optionalString(fields, 'cwd', 'approval params'),
      commandActions: Object.hasOwn(fields, 'commandActions') && fields.commandActions.value !== null
        ? jsonData(fields.commandActions.value, 'approval params.commandActions') : null,
      networkApprovalContext: Object.hasOwn(fields, 'networkApprovalContext') && fields.networkApprovalContext.value !== null
        ? jsonData(fields.networkApprovalContext.value, 'approval params.networkApprovalContext') : null,
      proposedExecpolicyAmendment: Object.hasOwn(fields, 'proposedExecpolicyAmendment') && fields.proposedExecpolicyAmendment.value !== null
        ? jsonData(fields.proposedExecpolicyAmendment.value, 'approval params.proposedExecpolicyAmendment') : null,
      proposedNetworkPolicyAmendments: Object.hasOwn(fields, 'proposedNetworkPolicyAmendments') && fields.proposedNetworkPolicyAmendments.value !== null
        ? jsonData(fields.proposedNetworkPolicyAmendments.value, 'approval params.proposedNetworkPolicyAmendments') : null
    } };
  }
  if (method === METHOD.fileApproval) {
    return { kind: 'fileChange', ...common, details: {
      reason: optionalString(fields, 'reason', 'approval params'),
      grantRoot: optionalString(fields, 'grantRoot', 'approval params')
    } };
  }
  return { kind: 'permissions', ...common, details: {
    environmentId: optionalString(fields, 'environmentId', 'approval params'),
    cwd: requiredString(fields, 'cwd', 'approval params'),
    reason: optionalString(fields, 'reason', 'approval params'),
    permissions: jsonData(fields.permissions ? fields.permissions.value : undefined, 'approval params.permissions')
  } };
}

function commandDecision(value) {
  if (typeof value === 'string') {
    if (!COMMAND_DECISIONS.includes(value)) fail('CODEX_APPROVAL_INVALID', 'Unsupported command approval decision');
    if (value === 'acceptWithExecpolicyAmendment' || value === 'applyNetworkPolicyAmendment') {
      fail('CODEX_APPROVAL_INVALID', 'Structured command approval decisions require their generated response payload');
    }
    return value;
  }
  const fields = ownRecord(value, 'command approval decision');
  if (Object.keys(fields).length !== 1) fail('CODEX_APPROVAL_INVALID', 'Command approval decision must have one choice');
  if (Object.hasOwn(fields, 'acceptWithExecpolicyAmendment')) {
    const body = ownRecord(fields.acceptWithExecpolicyAmendment.value, 'acceptWithExecpolicyAmendment');
    if (!Object.hasOwn(body, 'execpolicy_amendment') || !Array.isArray(body.execpolicy_amendment.value) ||
      body.execpolicy_amendment.value.some(value => typeof value !== 'string')) {
      fail('CODEX_APPROVAL_INVALID', 'acceptWithExecpolicyAmendment must contain execpolicy_amendment strings');
    }
    return { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...body.execpolicy_amendment.value] } };
  }
  if (Object.hasOwn(fields, 'applyNetworkPolicyAmendment')) {
    const body = ownRecord(fields.applyNetworkPolicyAmendment.value, 'applyNetworkPolicyAmendment');
    const amendment = ownRecord(body.network_policy_amendment ? body.network_policy_amendment.value : undefined, 'network_policy_amendment');
    const action = requiredString(amendment, 'action', 'network_policy_amendment');
    const host = requiredString(amendment, 'host', 'network_policy_amendment');
    if (!['allow', 'deny'].includes(action)) fail('CODEX_APPROVAL_INVALID', 'network policy action must be allow or deny');
    return { applyNetworkPolicyAmendment: { network_policy_amendment: { action, host } } };
  }
  fail('CODEX_APPROVAL_INVALID', 'Unsupported command approval decision');
}

function permissionResponse(value) {
  const fields = ownRecord(value, 'permissions approval response');
  if (!Object.hasOwn(fields, 'permissions') || !Object.hasOwn(fields, 'scope')) {
    fail('CODEX_APPROVAL_INVALID', 'Permissions approval requires permissions and scope');
  }
  const scope = requiredString(fields, 'scope', 'permissions approval response');
  if (!['turn', 'session'].includes(scope)) fail('CODEX_APPROVAL_INVALID', 'Permissions approval scope must be turn or session');
  const response = { permissions: jsonData(fields.permissions.value, 'permissions approval response.permissions'), scope };
  if (Object.hasOwn(fields, 'strictAutoReview')) {
    if (typeof fields.strictAutoReview.value !== 'boolean') fail('CODEX_APPROVAL_INVALID', 'strictAutoReview must be boolean');
    response.strictAutoReview = fields.strictAutoReview.value;
  }
  return response;
}

/* HOW MUCH OF A RESUMED CONVERSATION WE ARE WILLING TO CARRY. A rollout of
   several hundred turns is ordinary, and every one of them crosses a process
   boundary into a renderer. The newest turns are the ones a person is
   continuing from, so the tail is what survives. */
const MAX_RESUMED_TURNS = 200;

/* One message's words, whichever shape it arrived in: `text` (agent
   messages), a plain `content` string, or `content` as the blocks a message
   was assembled from. Anything else answers null and is skipped rather than
   guessed at. */
function readTurnItemText(item) {
  const direct = optionalString(item, 'text', 'thread turn item');
  if (direct) return direct;
  const content = Object.hasOwn(item, 'content') ? item.content.value : null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const fields = ownRecord(block, 'thread turn item content');
    const text = optionalString(fields, 'text', 'thread turn item content');
    if (text) parts.push(text);
  }
  const joined = parts.join('\n').trim();
  return joined.length > 0 ? joined : null;
}

/* The turn as the app needs it: who spoke and what was said, with the item
   shapes flattened to text. Anything richer (tool payloads, reasoning) is
   deliberately left on the engine side -- this crosses into a UI. */
function parseThreadTurn(value) {
  const turn = ownRecord(value, 'thread turn');
  const id = optionalString(turn, 'id', 'thread turn');
  /* An omitted item list is a legitimate summary-only turn. A PRESENT list
     that is unreadable is not an empty conversation: refusing here prevents
     malformed history from becoming a confident `said: []`. */
  const items = arrayField(turn, 'items', 'thread turn');
  const said = [];
  for (const entry of items) {
    const item = ownRecord(entry, 'thread turn item');
    const kind = optionalString(item, 'type', 'thread turn item') || optionalString(item, 'itemType', 'thread turn item');
    const who = kind === 'userMessage' || kind === 'user_message' ? 'you'
      : kind === 'agentMessage' || kind === 'agent_message' || kind === 'assistantMessage' ? 'agent'
        : null;
    if (!who) continue;
    /* The two sides are not shaped alike, measured against codex 0.146.0:
       an agentMessage carries `text`, a userMessage carries `content` — a
       string, or the blocks a message was assembled from. Reading only
       `text` silently dropped every line the PERSON wrote, which would have
       restored a conversation with one voice missing. */
    const text = readTurnItemText(item);
    if (text) said.push({ who, text });
  }
  return { id, said };
}

/* WHAT THE ENGINE JUST TOLD US, KEPT.
 *
 * This returned `{ threadId }` and dropped everything else on the floor --
 * including `Thread.turns`, which `thread/resume`, `thread/fork`,
 * `thread/rollback` and `thread/read` populate with THE ENTIRE CONVERSATION.
 * The product above was therefore unable to resume anything: it asked the
 * engine for a thread, received its history, discarded it, and fell back to
 * pasting a bounded summary into a brand-new agent. The mechanism was built
 * to the doorstep and stopped one line short.
 *
 * The response also carries the settings the thread really has -- model,
 * reasoning effort, cwd, sandbox -- which is the only honest source for
 * "what is this agent running at". Everything is optional: `thread/start`
 * answers with far less than `thread/resume`, and a field this parser
 * insists on is a field that breaks the start path.
 */
/* WHAT THE ENGINE RESOLVED THE SANDBOX TO, WHICH IS NOT ALWAYS WHAT WAS ASKED
 * FOR -- and the field this parser used to drop while its own header called the
 * response "the only honest source for what is this agent running at".
 *
 * MEASURED 2026-08-20 against codex-cli 0.146.0 on Windows, one `thread/start`
 * per row, reading this exact field off the wire:
 *
 *   asked read-only          -> {"type":"readOnly","networkAccess":false}
 *   asked workspace-write    -> {"type":"readOnly","networkAccess":false}   <-- DOWNGRADED
 *   asked danger-full-access -> {"type":"dangerFullAccess"}
 *
 * The middle row is the whole reason this is now read. A session started at the
 * Standard level asked for workspace-write and was given read-only, silently:
 * driven through the packaged product the same day, that session could not
 * create a file in its own working directory AND could not run `node --version`
 * ("rejected: blocked by policy", declined in 0ms). Nothing above this line
 * could tell, so the person was told they had a level that works and got one
 * that does nothing.
 *
 * IT NEVER THROWS. The header above parseThreadResponse() already warns that a
 * field this parser insists on is a field that breaks the start path, and
 * refusing to start a session over a shape we did not expect would trade a
 * cosmetic defect for an outage. An absent, malformed, or unfamiliar value
 * answers null, and null means THE ENGINE DID NOT SAY -- never "unconfined".
 *
 * THE VOCABULARY IS THE ENGINE'S, deliberately not translated into the word the
 * caller sent (`readOnly` here, `read-only` there). Translating at this seam
 * would mean inventing a mapping for values this machine has never produced --
 * no `workspaceWrite` was ever observed, because on this platform nothing
 * resolves to one. A caller that wants to compare should compare the two
 * vocabularies explicitly, where the pairing can be read and checked.
 */
function parseResolvedSandbox(fields, key) {
  if (!Object.hasOwn(fields, key)) return null;
  const value = fields[key].value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    /* Descriptors rather than property reads, the same discipline ownRecord()
       follows: a getter on untrusted JSON must not run, and must not throw
       through a parser that is not allowed to fail. */
    const own = Object.getOwnPropertyDescriptors(value);
    const typeField = Object.hasOwn(own, 'type') ? own.type : null;
    const type = typeField && Object.hasOwn(typeField, 'value')
      && typeof typeField.value === 'string' && typeField.value.length > 0
      ? typeField.value
      : null;
    if (type === null) return null;
    const networkField = Object.hasOwn(own, 'networkAccess') ? own.networkAccess : null;
    const networkAccess = networkField && Object.hasOwn(networkField, 'value')
      && typeof networkField.value === 'boolean'
      ? networkField.value
      : null;
    return Object.freeze({ type, networkAccess });
  } catch {
    return null;
  }
}

function parseThreadResponse(result, method) {
  const fields = ownRecord(result, `${method} result`);
  const thread = ownRecord(fields.thread ? fields.thread.value : undefined, `${method} result.thread`);
  /* Start/fork responses may omit history. If they do name `turns`, however,
     a malformed value is not evidence of zero turns and must fail closed. */
  const rawTurns = arrayField(thread, 'turns', `${method} result.thread`);
  const turns = rawTurns.slice(-MAX_RESUMED_TURNS).map(parseThreadTurn);
  return Object.freeze({
    threadId: requiredString(thread, 'id', `${method} result.thread`),
    turns: Object.freeze(turns.map(turn => Object.freeze({ ...turn, said: Object.freeze(turn.said) }))),
    turnCount: rawTurns.length,
    cwd: optionalString(thread, 'cwd', `${method} result.thread`),
    rolloutPath: optionalString(thread, 'path', `${method} result.thread`),
    // 0.154 thread/read nests these in Thread; start/resume/fork also
    // return resolved top-level settings. Prefer a present top-level value,
    // including explicit null, and never invent a default for missing data.
    model: Object.hasOwn(fields, 'model')
      ? optionalString(fields, 'model', `${method} result`)
      : optionalString(thread, 'model', `${method} result.thread`),
    reasoningEffort: Object.hasOwn(fields, 'reasoningEffort')
      ? optionalString(fields, 'reasoningEffort', `${method} result`)
      : optionalString(thread, 'reasoningEffort', `${method} result.thread`),
    /* See parseResolvedSandbox(): null means the engine did not say, never
       "unconfined". `thread/start` answers with far less than `thread/resume`,
       so this is absent on some responses by design. */
    resolvedSandbox: parseResolvedSandbox(fields, 'sandbox'),
  });
}

function parseTurnResponse(result) {
  const fields = ownRecord(result, 'turn/start result');
  const turn = ownRecord(fields.turn ? fields.turn.value : undefined, 'turn/start result.turn');
  return Object.freeze({ turnId: requiredString(turn, 'id', 'turn/start result.turn') });
}

class CodexAdapter {
  constructor({
    transport,
    codexVersion,
    clientInfo = { name: 'toolsenabled', title: 'ToolsEnabled', version: '1' },
    maxBackpressureRetries = 2,
    retryDelayMs = 25,
    now = Date.now
  } = {}) {
    this.transport = validateTransport(transport);
    this.codexVersion = assertPinnedVersion(codexVersion);
    this.threadSettingsUpdate = null;
    /* Per-thread reasoning effort on a line whose wire has no thread-level
       knob: remembered here and sent on that thread's next turn/start. */
    this.pendingTurnEffort = new Map();
    this.settingsSelections = new Set();
    this.collaborationModes = null;
    this.confirmedModes = new Map();
    Object.defineProperty(this, 'modeSelectionRequiresSettings', { value: true, enumerable: true });
    this.clientInfo = jsonData(clientInfo, 'clientInfo');
    if (!Number.isInteger(maxBackpressureRetries) || maxBackpressureRetries < 0 || maxBackpressureRetries > 8) {
      fail('CODEX_ADAPTER_INVALID', 'maxBackpressureRetries must be a bounded integer');
    }
    if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) {
      fail('CODEX_ADAPTER_INVALID', 'retryDelayMs must be a bounded integer');
    }
    if (typeof now !== 'function') fail('CODEX_ADAPTER_INVALID', 'now must be a clock function');
    this.maxBackpressureRetries = maxBackpressureRetries;
    this.retryDelayMs = retryDelayMs;
    this.now = now;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.approvals = new Map();
    this.listeners = new Set();
    this.usage = new Map();
    this.assistantParts = new Map();
    this.reasoningParts = new Map();
    /* A notification is not authority to end an arbitrary host turn merely
       because it carries a plausible id. Keep the thread/turn pair established
       by turn/start, including the legal case where the first notification
       arrives synchronously before the turn/start response. Besides rejecting
       cross-thread and wrong-turn packets, this gives fail-closed handling the
       exact active turn it must terminate when the reader can no longer reach
       the provider's later turn/completed notification. */
    this.activeTurns = new Map();
    // Native app-server multiplexes built-in worker events onto this pipe.
    // Only a validated parent's subAgentActivity may establish this relation;
    // child telemetry is not a host turn and never acquires approval authority.
    this.subAgentThreads = new Map();
    this.hostThreads = new Set();
    // A fresh process can bind an explicit restore override. A later or
    // concurrent start/restore may rejoin an already-running thread, whose
    // settings are not confirmed by merely acknowledging resume options.
    this.threadEstablishmentVersion = 0;
    // Interrupt can finish a turn before its command reports its last item.
    // Retain only identities this reader actually completed: late output from
    // those turns is stale, while an unknown thread/turn still fails closed.
    this.retiredTurns = new Set();
    this.pendingRestoredUsage = [];
    this.buffer = '';
    this.closed = null;
    this.initialized = null;
    this.initializing = null;
    /* The transport's contract is listener(chunk) for data and
     * listener(null, exitInfo) for child exit -- see createCodexProcessTransport
     * notifyExit(). This used to be `chunk => this._receive(chunk)`, which
     * dropped the second argument, so an EXIT arrived at _receive() as a bare
     * null and fell through its `typeof chunk !== 'string'` guard. The child
     * dying was therefore reported as "Codex transport emitted non-text data" --
     * a protocol violation that never happened -- while exitInfo, which carries
     * the child's exit code AND its stderr, was thrown away. That is the single
     * most useful diagnostic in the whole path, and it was being discarded at
     * the exact moment it mattered. */
    const unsubscribe = this.transport.onData((chunk, exitInfo) => this._receive(chunk, exitInfo));
    if (unsubscribe !== undefined && typeof unsubscribe !== 'function') fail('CODEX_TRANSPORT_INVALID', 'Codex transport onData must return a function when it returns a value');
    this.unsubscribe = unsubscribe || null;
  }

  onEvent(listener) {
    if (typeof listener !== 'function') fail('CODEX_ADAPTER_INVALID', 'onEvent requires a listener function');
    this._assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async initialize() {
    this._assertOpen();
    if (this.initialized) return this.initialized;
    if (this.initializing) return this.initializing;
    /* THE CAPABILITY IS DECLARED, AND THAT IS WHY THE EFFORT KNOB EXISTS.
       `thread/settings/update` -- the wire's own way to change reasoning
       effort on a running thread -- refuses with "requires experimentalApi
       capability" unless it is asked for here. We never asked, concluded the
       protocol had no such field, and built a process restart instead:
       measured 2026-08-16 against codex-cli 0.146.0, where declaring it made
       the same call succeed. Declaring a capability enables methods; it
       changes nothing about the ones already in use. */
    this.initializing = this._request(METHOD.initialize, {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true },
    }).then(result => {
      this.initialized = jsonData(result, 'initialize result');
      this._write({ method: 'initialized' });
      this.initializing = null;
      return this.initialized;
    }, error => {
      this.initializing = null;
      throw error;
    });
    return this.initializing;
  }

  getServerInfo() {
    return this.initialized ? Object.freeze(jsonData(this.initialized, 'stored server info')) : null;
  }

  async startThread(options = {}) {
    this._assertInitialized();
    return parseThreadResponse(await this._request(METHOD.threadStart, validateThreadOptions(options)), METHOD.threadStart);
  }

  // Bind effective config explicitly before a fresh start. config/read is
  // not a snapshot of a resumed thread and must never recover one implicitly.
  async startThreadWithNativeModeSettings(options = {}, { configTimeoutMs = 1500 } = {}) {
    this._assertInitialized();
    const params = { ...validateThreadOptions(options) };
    if (!Number.isInteger(configTimeoutMs) || configTimeoutMs < 1 || configTimeoutMs > 10_000) {
      fail('CODEX_ADAPTER_INVALID', 'Config read timeout must be between 1 and 10000 milliseconds');
    }
    let instructions = Object.hasOwn(params, 'developerInstructions') ? params.developerInstructions : null;
    let unavailable = null;
    if (instructions === null) {
      let timer;
      try {
        const config = await Promise.race([
          this._request('config/read', { includeLayers: false, ...(params.cwd ? { cwd: params.cwd } : {}) }),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new CodexAdapterError(
            'CODEX_MODE_CONFIG_TIMEOUT', 'Effective launch configuration did not answer in time')), configTimeoutMs); })
        ]);
        const fields = ownRecord(config, 'config/read result');
        const effective = ownRecord(fields.config?.value, 'config/read result.config');
        instructions = optionalString(effective, 'developer_instructions', 'config/read result.config');
        if (instructions === null) unavailable = 'CODEX_MODE_INSTRUCTIONS_UNAVAILABLE';
        else if (instructions.length > 1_000_000) { instructions = null; unavailable = 'CODEX_MODE_INSTRUCTIONS_TOO_LARGE'; }
      } catch (error) {
        unavailable = error.code === 'CODEX_MODE_CONFIG_TIMEOUT' ? error.code : 'CODEX_MODE_CONFIG_UNAVAILABLE';
      } finally { clearTimeout(timer); }
      this._assertOpen();
    }
    // Empty is a known config value, unlike null/missing. All other options
    // were validated above; this protocol field permits an empty string.
    if (instructions !== null) params.developerInstructions = instructions;
    const raw = await this._request(METHOD.threadStart, params);
    const result = parseThreadResponse(raw, METHOD.threadStart);
    this._assertOpen();
    const effortKnown = Object.hasOwn(raw, 'reasoningEffort') || Object.hasOwn(raw.thread, 'reasoningEffort');
    const nativeModeSettings = instructions !== null && effortKnown && typeof result.model === 'string' && result.model.length > 0
      ? Object.freeze({ model: result.model, effort: result.reasoningEffort, developerInstructions: instructions }) : null;
    return Object.freeze({ ...result, nativeModeSettings,
      nativeModeUnavailableReason: nativeModeSettings ? null : unavailable || (!result.model ? 'CODEX_MODE_MODEL_UNAVAILABLE' : 'CODEX_MODE_EFFORT_UNAVAILABLE') });
  }

  async resumeThread(threadId, options = {}) {
    this._assertInitialized();
    const params = { threadId: validateThreadId(threadId), ...validateThreadOptions(options) };
    const previousVersion = this.threadEstablishmentVersion;
    const raw = await this._request(METHOD.threadResume, params);
    const result = parseThreadResponse(raw, METHOD.threadResume);
    this._assertOpen();
    return this._bindExplicitResumeSettings(raw, result, params, previousVersion);
  }

  async resumeThreadFromPath(threadId, sourcePath, options = {}) {
    this._assertInitialized();
    if (typeof sourcePath !== 'string' || sourcePath.length > 32768 || !path.isAbsolute(sourcePath) || sourcePath.includes('\0')) {
      fail('CODEX_ADAPTER_INVALID', 'Resume requires a validated absolute rollout path');
    }
    const params = { threadId: validateThreadId(threadId), path: sourcePath, ...validateThreadOptions(options) };
    const previousVersion = this.threadEstablishmentVersion;
    const raw = await this._request(METHOD.threadResume, params);
    const result = parseThreadResponse(raw, METHOD.threadResume);
    this._assertOpen();
    // Native path resume ignores threadId for a non-running thread. The
    // caller's exact identity therefore remains a checked postcondition.
    if (result.threadId !== threadId) fail('CODEX_RESUME_IDENTITY_MISMATCH', 'The saved rollout restored a different conversation.');
    return this._bindExplicitResumeSettings(raw, result, params, previousVersion);
  }

  _bindExplicitResumeSettings(raw, result, params, previousVersion) {
    // restoreCodexSession owns a newly spawned app-server. Only its first,
    // uncontested restore may bind the explicit override it actually sent.
    // This is not recovery of historical instructions: absent options stay
    // unknown, and config/read is deliberately never consulted here.
    if (previousVersion !== 0 || this.threadEstablishmentVersion !== 1
        || result.threadId !== params.threadId || typeof params.developerInstructions !== 'string') return result;
    const effortKnown = Object.hasOwn(raw, 'reasoningEffort') || Object.hasOwn(raw.thread, 'reasoningEffort');
    const modelKnown = typeof result.model === 'string' && result.model.length > 0 && result.model.length <= 512;
    const effortValid = result.reasoningEffort === null || typeof result.reasoningEffort === 'string'
      && result.reasoningEffort.length > 0 && result.reasoningEffort.length <= 32;
    const nativeModeSettings = modelKnown && effortKnown && effortValid
      ? Object.freeze({ model: result.model, effort: result.reasoningEffort, developerInstructions: params.developerInstructions }) : null;
    return Object.freeze({ ...result, nativeModeSettings,
      nativeModeUnavailableReason: nativeModeSettings ? null : !modelKnown ? 'CODEX_MODE_MODEL_UNAVAILABLE' : 'CODEX_MODE_EFFORT_UNAVAILABLE' });
  }

  async forkThread(threadId, options = {}) {
    this._assertInitialized();
    const normalized = validateThreadOptions(options);
    const params = { threadId: validateThreadId(threadId), ...normalized };
    const result = parseThreadResponse(await this._request(METHOD.threadFork, params), METHOD.threadFork);
    this._assertOpen();
    return result;
  }

  // 0.153 requires the selected rollout to exist in this client's own store;
  // an external path alone neither imports it nor bypasses a stale-path check.
  // The receipt-bound launcher stages that copy and passes its private path.
  async forkThreadFromPath(threadId, sourcePath, options = {}) {
    this._assertInitialized();
    if (typeof sourcePath !== 'string' || sourcePath.length > 32768 || !path.isAbsolute(sourcePath) || sourcePath.includes('\0')) {
      fail('CODEX_ADAPTER_INVALID', 'An editor fork requires its validated absolute rollout path');
    }
    const params = { threadId: validateThreadId(threadId), path: sourcePath,
      ...validateThreadOptions(options), deferGoalContinuation: true };
    const forked = parseThreadResponse(await this._request(METHOD.threadFork, params), METHOD.threadFork);
    this._assertOpen();
    if (forked.threadId === threadId) fail('CODEX_EDITOR_FORK_INVALID', 'Codex did not create a different conversation for this copy.');
    return forked;
  }

  /* READ A THREAD WITHOUT RUNNING IT. Resume spawns work; this only reads,
     which is what a surface wants when it is showing a past conversation
     rather than continuing one. */
  async readThread(threadId, { includeTurns = true } = {}) {
    this._assertInitialized();
    const params = { threadId: validateThreadId(threadId), includeTurns: includeTurns === true };
    return parseThreadResponse(await this._request(METHOD.threadRead, params), METHOD.threadRead);
  }

  /* CHANGE HOW HARD A RUNNING THREAD THINKS. The wire's own knob -- no
     restart, no re-sent conversation, no second process. Requires the
     experimentalApi capability declared in initialize(). */
  async updateThreadSettings(threadId, { effort = null } = {}) {
    this._assertInitialized();
    if (typeof effort !== 'string' || effort.length === 0 || effort.length > 32) {
      fail('CODEX_ADAPTER_INVALID', 'updateThreadSettings requires a bounded effort string');
    }
    const id = validateThreadId(threadId);
    if (this.settingsSelections.has(id)) fail('CODEX_SETTINGS_BUSY', 'A settings selection is already pending for this thread');
    this.settingsSelections.add(id);
    try {
      if (this.threadSettingsUpdate !== false) {
        try {
          await this._request(METHOD.threadSettingsUpdate, { threadId: id, effort });
          this.threadSettingsUpdate = true;
          return Object.freeze({ threadId: id, effort });
        } catch (error) {
          // Only the server's explicit "method not found" -- JSON-RPC -32601, or
          // Codex's own "unknown variant" answer for exactly this method -- means
          // the method is unavailable. Auth, invalid params, and transport
          // failures still fail.
          if (error.rpcCode !== -32601 && error.requestUnknown !== true) throw error;
          this.threadSettingsUpdate = false;
        }
      }
      if (this.threadSettingsUpdate === false) {
        this.pendingTurnEffort.set(id, effort);
        return Object.freeze({ threadId: id, effort, appliesOn: 'next-turn' });
      }
    } finally { this.settingsSelections.delete(id); }
  }

  // Installed 0.154.0 schema: collaborationMode/list returns preset metadata,
  // not the current thread mode. Keep this separate from ACP session modes.
  // Selecting a preset also replaces model/effort/developer instructions and
  // requires the host to retain those settings before offering a selector.
  // The caller owns the authoritative launch/resume settings. In particular,
  // null developer_instructions selects built-ins; it does NOT retain the
  // host's instructions. Refuse missing retained data rather than erase it.
  async selectMode(threadId, modeId, retainedSettings) {
    this._assertInitialized();
    const id = validateThreadId(threadId);
    if (!this.hostThreads.has(id)) fail('CODEX_MODE_THREAD_UNAVAILABLE', 'Open this thread before selecting its mode');
    if (typeof modeId !== 'string' || !modeId || modeId.length > 512) fail('CODEX_MODE_UNAVAILABLE', 'Select an advertised collaboration mode');
    if (!retainedSettings || typeof retainedSettings !== 'object') fail('CODEX_MODE_SETTINGS_REQUIRED', 'Retained model, effort, and developer instructions are required');
    const fields = ownRecord(retainedSettings, 'retained collaboration settings');
    if (Object.keys(fields).length !== 3 || !['model', 'effort', 'developerInstructions'].every(key => Object.hasOwn(fields, key)) ||
        typeof fields.model.value !== 'string' || !fields.model.value || fields.model.value.length > 512 ||
        (fields.effort.value !== null && (typeof fields.effort.value !== 'string' || !fields.effort.value || fields.effort.value.length > 32)) ||
        typeof fields.developerInstructions.value !== 'string' || fields.developerInstructions.value.length > 1_000_000) {
      fail('CODEX_MODE_SETTINGS_REQUIRED', 'Supply the retained model, nullable effort, and explicit developer instructions');
    }
    const settings = { model: fields.model.value, reasoning_effort: fields.effort.value,
      developer_instructions: fields.developerInstructions.value };
    if (this.activeTurns.has(id) || this.settingsSelections.has(id) ||
        [...this.pending.values()].some(request => request.params?.threadId === id && [METHOD.threadResume, METHOD.threadFork].includes(request.method))) fail('CODEX_SETTINGS_BUSY', 'Wait for this thread to finish its turn or settings selection');
    this.settingsSelections.add(id);
    try {
      const catalog = await this.listCollaborationModes();
      this._assertOpen();
      if (!catalog.modes.some(preset => preset.mode === modeId)) fail('CODEX_MODE_UNAVAILABLE', 'This provider does not advertise the requested collaboration mode');
      const response = await this._request(METHOD.threadSettingsUpdate, { threadId: id, collaborationMode: { mode: modeId, settings } });
      ownRecord(response, 'thread/settings/update mode result');
      this._assertOpen();
      this.pendingTurnEffort.delete(id);
      this.confirmedModes.set(id, modeId);
      return Object.freeze({ threadId: id, currentModeId: modeId, appliesOn: 'subsequent-turns' });
    } finally { this.settingsSelections.delete(id); }
  }

  getSessionModes(threadId) {
    const id = validateThreadId(threadId);
    if (!this.collaborationModes || !this.hostThreads.has(id)) return null;
    const availableModes = Object.freeze(this.collaborationModes.modes
      .filter(preset => preset.mode !== null && preset.mode.length > 0)
      .map(preset => Object.freeze({ id: preset.mode, name: preset.name })));
    const confirmed = this.confirmedModes.get(id);
    return Object.freeze({ currentModeId: availableModes.some(mode => mode.id === confirmed) ? confirmed : null, availableModes });
  }

  async listCollaborationModes() {
    this._assertInitialized();
    const result = await this._request('collaborationMode/list', {});
    const fields = ownRecord(result, 'collaborationMode/list result');
    const entries = arrayField(fields, 'data', 'collaborationMode/list result', { required: true });
    if (entries.length > 128) fail('CODEX_PROTOCOL_INVALID', 'The collaboration mode catalog exceeded its bound');
    const catalog = Object.freeze({ modes: Object.freeze(entries.map(entry => {
      const preset = ownRecord(entry, 'collaboration mode preset');
      return Object.freeze({
        name: requiredString(preset, 'name', 'collaboration mode preset'),
        mode: optionalString(preset, 'mode', 'collaboration mode preset'),
        model: optionalString(preset, 'model', 'collaboration mode preset'),
        reasoningEffort: optionalString(preset, 'reasoning_effort', 'collaboration mode preset')
      });
    })) });
    this._assertOpen();
    this.collaborationModes = catalog;
    return catalog;
  }

  /* THE PROVIDER'S OWN MODEL CATALOG: every model, the reasoning efforts it
     really supports, each with the provider's own description, and its
     default. This is what a menu of "how hard should it think" must be built
     from -- a hand-written list in the product is a list that disagrees with
     the engine the moment either changes, which is exactly what happened. */
  async listModels() {
    this._assertInitialized();
    const rawModels = [], cursors = new Set();
    let cursor = null;
    do {
      const result = await this._request(METHOD.modelList, cursor ? { cursor } : {});
      const fields = ownRecord(result, 'model/list result');
      if (Object.hasOwn(fields, 'data') && Object.hasOwn(fields, 'models')) {
        fail('CODEX_PROTOCOL_INVALID', 'model/list result has two conflicting catalogs');
      }
      const page = arrayField(fields, Object.hasOwn(fields, 'models') ? 'models' : 'data', 'model/list result', { required: true });
      rawModels.push(...page);
      cursor = optionalString(fields, 'nextCursor', 'model/list result');
      if (rawModels.length > 2000 || (cursor && (cursors.has(cursor) || cursors.size >= 20))) {
        fail('CODEX_PROTOCOL_INVALID', 'The model catalog exceeded its pagination bound');
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const models = rawModels.map(entry => {
      const model = ownRecord(entry, 'model/list model');
      /* Likewise, an unreadable effort list cannot establish that this model
         supports no reasoning efforts. */
      const rawEfforts = arrayField(model, 'supportedReasoningEfforts', 'model/list model', { required: true });
      const efforts = rawEfforts.map(effortEntry => {
        const effort = ownRecord(effortEntry, 'model/list reasoning effort');
        return Object.freeze({
          id: requiredString(effort, 'reasoningEffort', 'model/list reasoning effort'),
          description: optionalString(effort, 'description', 'model/list reasoning effort'),
        });
      });
      return Object.freeze({
        id: requiredString(model, 'id', 'model/list model'),
        displayName: optionalString(model, 'displayName', 'model/list model'),
        description: optionalString(model, 'description', 'model/list model'),
        hidden: model.hidden ? model.hidden.value === true : false,
        efforts: Object.freeze(efforts),
        defaultEffort: optionalString(model, 'defaultReasoningEffort', 'model/list model'),
      });
    });
    return Object.freeze({ models: Object.freeze(models) });
  }

  async sendTurn(request) {
    this._assertInitialized();
    const normalized = validateSendTurnRequest(request);
    if (this.settingsSelections.has(normalized.threadId)) fail('CODEX_SETTINGS_BUSY', 'Wait for the pending settings selection before starting a turn');
    const input = [{ type: 'text', text: normalized.text, text_elements: [] }];
    for (const image of normalized.images) {
      input.push(Object.hasOwn(image, 'url')
        ? { type: 'image', url: image.url, ...(image.detail ? { detail: image.detail } : {}) }
        : { type: 'localImage', path: image.path, ...(image.detail ? { detail: image.detail } : {}) });
    }
    const unsupported = ['sandbox', 'baseInstructions', 'developerInstructions', 'personality', 'ephemeral', 'lastTurnId']
      .find(key => Object.hasOwn(normalized.options, key));
    if (unsupported) {
      fail('CODEX_ADAPTER_INVALID', `turn/start does not accept the engine-neutral ${unsupported} option`);
    }
    const turnOptions = {};
    for (const key of ['cwd', 'approvalPolicy', 'model', 'serviceTier']) {
      if (Object.hasOwn(normalized.options, key)) turnOptions[key] = normalized.options[key];
    }
    const params = { threadId: normalized.threadId, input, ...turnOptions };
    if (this.pendingTurnEffort.has(normalized.threadId)) {
      params.effort = this.pendingTurnEffort.get(normalized.threadId);
    }
    if (this.activeTurns.has(normalized.threadId)) {
      fail('CODEX_TURN_ACTIVE', `Codex thread ${normalized.threadId} already has an active turn`);
    }
    this._rememberHostThread(normalized.threadId);
    const active = { threadId: normalized.threadId, turnId: null, acknowledged: false, completed: false, assistantItems: new Set() };
    this.activeTurns.set(normalized.threadId, active);
    try {
      const accepted = parseTurnResponse(await this._request(METHOD.turnStart, params));
      /* A response and another protocol line can be delivered in one transport
         callback. _receive() may therefore have failed closed after resolving
         the request but before this continuation runs. Never turn that closed
         reader into a successful, permanently active host turn. */
      this._assertOpen();
      this._bindTurn(active, accepted.turnId, 'turn/start response');
      active.acknowledged = true;
      if (active.completed && this.activeTurns.get(active.threadId) === active) {
        this.activeTurns.delete(active.threadId);
      }
      return accepted;
    } catch (error) {
      if (this.activeTurns.get(active.threadId) === active) this.activeTurns.delete(active.threadId);
      this._retireTurnApprovals(active);
      throw error;
    }
  }

  // https://learn.chatgpt.com/docs/app-server#steer-an-active-turn
  // Match the exact active turn; never interrupt it or create another turn.
  async steerTurn({ threadId, turnId, text }) {
    this._assertInitialized();
    const id = validateThreadId(threadId);
    const expectedTurnId = validateThreadId(turnId, 'turnId');
    const normalized = validateSendTurnRequest({ threadId: id, text });
    const active = this.activeTurns.get(id);
    if (!active || active.completed || active.turnId !== expectedTurnId) {
      fail('CODEX_STEER_TURN_CHANGED', 'The receiving turn finished or changed before the message could be delivered.');
    }
    const result = await this._request(METHOD.turnSteer, {
      threadId: id, expectedTurnId,
      input: [{ type: 'text', text: normalized.text, text_elements: [] }]
    });
    if (!result || result.turnId !== expectedTurnId) fail('CODEX_STEER_RESPONSE_INVALID', 'The message delivery acknowledgement did not identify the receiving turn.');
    return Object.freeze({ threadId: id, turnId: expectedTurnId });
  }

  async interrupt({ threadId, turnId }) {
    this._assertInitialized();
    return this._request(METHOD.turnInterrupt, { threadId: validateThreadId(threadId), turnId: validateThreadId(turnId, 'turnId') });
  }

  answerApproval(answer) {
    const normalized = validateApprovalAnswer(answer);
    const approval = this.approvals.get(normalized.approvalId);
    if (!approval) fail('CODEX_APPROVAL_UNKNOWN', 'Approval is not pending for this Codex adapter');
    if (approval.active.completed || this.activeTurns.get(approval.active.threadId) !== approval.active) {
      this.approvals.delete(normalized.approvalId);
      fail('CODEX_APPROVAL_UNKNOWN', 'Approval is no longer pending for the active Codex turn');
    }
    let result;
    if (approval.kind === 'commandExecution') {
      const fields = ownRecord(normalized.response, 'command approval response');
      result = { decision: commandDecision(fields.decision ? fields.decision.value : undefined) };
    } else if (approval.kind === 'fileChange') {
      const fields = ownRecord(normalized.response, 'file approval response');
      const decision = fields.decision ? fields.decision.value : undefined;
      if (typeof decision !== 'string' || !FILE_DECISIONS.includes(decision)) fail('CODEX_APPROVAL_INVALID', 'Unsupported file change approval decision');
      result = { decision };
    } else {
      result = permissionResponse(normalized.response);
    }
    this.approvals.delete(normalized.approvalId);
    this._write({ jsonrpc: '2.0', id: approval.rpcId, result });
  }

  getUsage(threadId) {
    const usage = this.usage.get(validateThreadId(threadId));
    return usage ? Object.freeze(jsonData(usage, 'stored usage')) : null;
  }

  close() {
    if (this.closed) {
      // A failed protocol reader still owns its transport until closure is
      // proven. Retry the retained handle; never rediscover a process by PID.
      if (this.closed.retryCleanup) this.closed.retryCleanup().catch(() => {});
      return;
    }
    this._failClosed(new CodexAdapterError('CODEX_ADAPTER_CLOSED', 'Codex adapter was closed'), { terminateTurns: false });
  }

  _assertOpen() {
    if (this.closed) throw this.closed;
  }

  _assertInitialized() {
    this._assertOpen();
    if (!this.initialized) fail('CODEX_NOT_INITIALIZED', 'Codex app-server initialize must complete first');
  }

  _request(method, params, attempt = 0) {
    this._assertOpen();
    if ([METHOD.threadResume, METHOD.threadFork].includes(method) && this.settingsSelections.has(params.threadId)) {
      fail('CODEX_SETTINGS_BUSY', 'Wait for the pending settings selection before restoring this thread');
    }
    if ([METHOD.threadResume, METHOD.threadFork].includes(method)) this.confirmedModes.delete(params.threadId);
    if ([METHOD.threadStart, METHOD.threadResume, METHOD.threadFork].includes(method)) this.threadEstablishmentVersion += 1;
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      this.pending.set(id, { method, params, attempt, resolve, reject });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        if (this.closed && this.pending.has(id)) return;
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _write(message) {
    this._assertOpen();
    let line;
    try {
      line = `${JSON.stringify(message)}\n`;
    } catch {
      fail('CODEX_PROTOCOL_INVALID', 'Codex JSON-RPC message could not be serialized');
    }
    try {
      this.transport.write(line);
    } catch {
      this._failClosed(new CodexAdapterError('CODEX_TRANSPORT_WRITE_FAILED', 'Codex transport write failed'));
      throw this.closed;
    }
  }

  _receive(chunk, exitInfo) {
    if (this.closed) return;
    try {
      /* Child exit, not a protocol event. Reported with the code and the
       * child's own stderr, because "the process died and here is what it
       * said" is actionable and "non-text data" is not. */
      if (exitInfo) {
        const detail = String(exitInfo.stderr || '').trim();
        const cause = exitInfo.error ? exitInfo.error.message
          : exitInfo.signal ? `signal ${exitInfo.signal}`
          : `exit code ${exitInfo.code}`;
        fail('CODEX_APP_SERVER_EXITED',
          `Codex app-server exited before the session was ready (${cause})${detail ? `: ${detail}` : ''}`);
      }
      if (Buffer.isBuffer(chunk)) chunk = chunk.toString('utf8');
      if (typeof chunk !== 'string') fail('CODEX_PROTOCOL_INVALID', 'Codex transport emitted non-text data');
      this.buffer += chunk;
      if (this.buffer.length > 8_000_000) fail('CODEX_PROTOCOL_INVALID', 'Codex transport line exceeds the safety limit');
      let newline;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, '');
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail('CODEX_PROTOCOL_INVALID', 'Codex transport emitted malformed JSON'); }
        this._handleMessage(message);
      }
    } catch (error) {
      this._failClosed(error instanceof CodexAdapterError ? error : new CodexAdapterError('CODEX_PROTOCOL_INVALID', 'Codex protocol handling failed'));
    }
  }

  _handleMessage(message) {
    const fields = ownRecord(message, 'Codex JSON-RPC message');
    if (Object.hasOwn(fields, 'jsonrpc') && fields.jsonrpc.value !== '2.0') fail('CODEX_PROTOCOL_INVALID', 'Codex JSON-RPC version must be 2.0');
    const hasId = Object.hasOwn(fields, 'id');
    const hasMethod = Object.hasOwn(fields, 'method');
    const hasResult = Object.hasOwn(fields, 'result');
    const hasError = Object.hasOwn(fields, 'error');
    if (hasMethod && hasId) return this._handleServerRequest(fields);
    if (hasMethod) return this._handleNotification(fields);
    if (hasId && (hasResult || hasError) && !(hasResult && hasError)) return this._handleResponse(fields);
    fail('CODEX_PROTOCOL_INVALID', 'Codex JSON-RPC message has an unsupported shape');
  }

  _handleResponse(fields) {
    const id = fields.id.value;
    if ((typeof id !== 'number' || !Number.isInteger(id)) && typeof id !== 'string') fail('CODEX_PROTOCOL_INVALID', 'Codex response id is invalid');
    const pending = this.pending.get(id);
    if (!pending) fail('CODEX_PROTOCOL_INVALID', 'Codex response did not match a pending request');
    if (Object.hasOwn(fields, 'error')) {
      // Keep ownership until validation succeeds. A malformed error closes the
      // reader, which must still be able to reject this request with the rest.
      const error = ownRecord(fields.error.value, 'Codex response error');
      const code = error.code ? error.code.value : undefined;
      if (!Number.isInteger(code)) fail('CODEX_PROTOCOL_INVALID', 'Codex response error code is invalid');
      this.pending.delete(id);
      if (code === -32001 && pending.attempt < this.maxBackpressureRetries) {
        setTimeout(() => {
          if (this.closed) pending.reject(this.closed);
          else this._request(pending.method, pending.params, pending.attempt + 1).then(pending.resolve, pending.reject);
        }, this.retryDelayMs);
        return;
      }
      const failure = new CodexAdapterError(code === -32001 ? 'CODEX_APP_SERVER_BACKPRESSURE' : 'CODEX_APP_SERVER_ERROR',
        `Codex app-server ${pending.method} failed with JSON-RPC code ${code}`);
      failure.rpcCode = code;
      /* WHETHER THIS CODEX HAS THE REQUEST AT ALL. A Codex app-server does not
         answer an unknown method with JSON-RPC's -32601: it answers -32600
         "Invalid request: unknown variant `<method>`, expected one of ...",
         and it uses -32601 for things it has but has "not supported yet"
         (measured on 0.155.1 and 0.156.0: `no/such/method` -> -32600 unknown
         variant; thread/read of an unsaved thread -> -32601 "list_turns is
         not supported yet"). Only a boolean crosses: the provider's message
         itself stays here. It is true only when the variant named is the
         method this request asked for, so an invalid-params -32600 is never
         mistaken for a missing request. */
      const serverMessage = error.message && typeof error.message.value === 'string' ? error.message.value.slice(0, 256) : '';
      const unknownVariant = /\bunknown variant `([^`]{1,128})`/.exec(serverMessage)?.[1] ?? null;
      failure.requestUnknown = code === -32600 && unknownVariant === pending.method;
      pending.reject(failure);
      return;
    }
    if (pending.method === METHOD.threadStart) {
      this._rememberHostThread(parseThreadResponse(fields.result.value, pending.method).threadId);
    }
    if ([METHOD.threadResume, METHOD.threadFork].includes(pending.method)) {
      // Native restore reports saved token usage, sometimes before its reply,
      // sometimes in the same transport chunk immediately after it. Establish
      // historical identities synchronously at the validated response, before
      // promise continuations can announce a ready session. These identities
      // never grant live-turn or approval authority.
      const restored = parseThreadResponse(fields.result.value, pending.method);
      this._rememberHostThread(restored.threadId);
      for (const turn of restored.turns) {
        this.retiredTurns.add(JSON.stringify([restored.threadId, turn.id]));
        if (this.retiredTurns.size > 1024) this.retiredTurns.delete(this.retiredTurns.values().next().value);
      }
      this.pendingRestoredUsage = this.pendingRestoredUsage.filter(usage => {
        if (usage.threadId !== restored.threadId) return true;
        if (!this.retiredTurns.has(JSON.stringify([usage.threadId, usage.turnId]))) {
          fail('CODEX_PROTOCOL_INVALID', 'Restored token usage did not match a saved Codex turn');
        }
        return false;
      });
      const otherRestore = [...this.pending.entries()].some(([requestId, request]) => requestId !== id
        && [METHOD.threadResume, METHOD.threadFork].includes(request.method));
      if (!otherRestore && this.pendingRestoredUsage.length) {
        fail('CODEX_PROTOCOL_INVALID', 'Restored token usage did not match the restored Codex thread');
      }
    }
    this.pending.delete(id);
    pending.resolve(fields.result.value);
  }

  _handleServerRequest(fields) {
    const method = requiredString(fields, 'method', 'Codex server request');
    if (![METHOD.commandApproval, METHOD.fileApproval, METHOD.permissionsApproval].includes(method)) {
      fail('CODEX_PROTOCOL_UNSUPPORTED_REQUEST', `Codex app-server requested unsupported host action ${method}`);
    }
    const rpcId = fields.id.value;
    if ((typeof rpcId !== 'number' || !Number.isInteger(rpcId)) && typeof rpcId !== 'string') fail('CODEX_PROTOCOL_INVALID', 'Codex approval request id is invalid');
    const parsed = validateApprovalParams(method, fields.params ? fields.params.value : undefined);
    if (this.subAgentThreads.has(parsed.threadId)) {
      this._write({ jsonrpc: '2.0', id: rpcId, error: { code: -32600, message: 'Native sub-agent approvals have no bound host turn.' } });
      return;
    }
    if ([...this.approvals.values()].some(approval => approval.rpcId === rpcId)) {
      fail('CODEX_PROTOCOL_INVALID', 'Codex reused a pending approval id');
    }
    const active = this._turnEvent(parsed.threadId, parsed.turnId, method);
    if (!active) {
      // A request needs an answer even when its turn was already retired.
      // Refuse it without opening a prompt or disturbing a newer active turn.
      this._write({ jsonrpc: '2.0', id: rpcId, error: { code: -32600, message: 'Approval request belongs to a completed Codex turn.' } });
      return;
    }
    // RPC ids may be reused after a response. A delayed UI answer must never
    // name a different request merely because the provider reused its id.
    const approvalId = `codex:approval:${randomUUID()}`;
    this.approvals.set(approvalId, { rpcId, kind: parsed.kind, active });
    this._emit({
      type: 'approval_request',
      threadId: parsed.threadId,
      turnId: parsed.turnId,
      itemId: parsed.itemId,
      approval: {
        approvalId,
        kind: parsed.kind,
        startedAtMs: parsed.startedAtMs,
        details: parsed.details,
        availableDecisions: approvalChoices(parsed.kind)
      }
    });
  }

  _handleNotification(fields) {
    const method = requiredString(fields, 'method', 'Codex notification');
    const params = fields.params ? fields.params.value : undefined;
    if ([METHOD.agentMessageDelta, METHOD.reasoningSummaryDelta, METHOD.reasoningSummaryPart, METHOD.itemStarted, METHOD.itemCompleted, METHOD.tokenUsageUpdated, METHOD.turnCompleted].includes(method)) {
      const data = ownRecord(params, method);
      const threadId = requiredString(data, 'threadId', method);
      if (this.subAgentThreads.has(threadId)) {
        if (method === METHOD.itemStarted || method === METHOD.itemCompleted) {
          this._rememberSubAgent(threadId, ownRecord(data.item ? data.item.value : undefined, `${method}.item`));
        }
        return;
      }
    }
    if (method === METHOD.agentMessageDelta) {
      const data = ownRecord(params, method);
      const threadId = requiredString(data, 'threadId', method);
      const turnId = requiredString(data, 'turnId', method);
      const active = this._turnEvent(threadId, turnId, method);
      if (!active) return;
      const itemId = requiredString(data, 'itemId', method);
      const delta = requiredString(data, 'delta', method);
      const parts = this.assistantParts.get(itemId) || [];
      parts.push(delta);
      this.assistantParts.set(itemId, parts);
      active.assistantItems.add(itemId);
      this._emit({ type: 'assistant_text_delta', threadId, turnId, itemId, text: delta });
      return;
    }
    if (method === METHOD.reasoningSummaryDelta || method === METHOD.reasoningSummaryPart) {
      // Only the provider's readable summary stream. item/reasoning/textDelta
      // and reasoning content/encrypted_content deliberately have no route.
      // Protocol: https://learn.chatgpt.com/docs/app-server
      const data = ownRecord(params, method);
      const threadId = requiredString(data, 'threadId', method);
      const turnId = requiredString(data, 'turnId', method);
      if (!this._turnEvent(threadId, turnId, method)) return;
      const itemId = requiredString(data, 'itemId', method);
      const index = data.summaryIndex?.value;
      if (!Number.isSafeInteger(index) || index < 0 || index >= 128) fail('CODEX_PROTOCOL_INVALID', 'Codex summary section index is invalid');
      const key = JSON.stringify([threadId, turnId, itemId]);
      let held = this.reasoningParts.get(key);
      if (!held) {
        if (this.reasoningParts.size >= 128) fail('CODEX_PROTOCOL_INVALID', 'Too many unfinished Codex summaries');
        held = { threadId, turnId, sections: [], characters: 0, truncated: false };
        this.reasoningParts.set(key, held);
      }
      if (method === METHOD.reasoningSummaryPart) return;
      const delta = requiredString(data, 'delta', method, { allowEmpty: true });
      const admitted = delta.slice(0, Math.max(0, 1_000_000 - held.characters));
      held.sections[index] = (held.sections[index] || '') + admitted;
      held.characters += admitted.length;
      const text = held.sections.filter(part => typeof part === 'string').join('\n');
      held.truncated ||= admitted.length < delta.length || text.length > 1_000_000;
      if (text) this._emit({ type: 'thinking', threadId, turnId, itemId, text: text.slice(0, 1_000_000), status: 'inProgress',
        ...(held.truncated ? { payload: { truncated: true } } : {}) });
      return;
    }
    if (method === METHOD.itemStarted || method === METHOD.itemCompleted) return this._handleItem(method, params);
    if (method === METHOD.tokenUsageUpdated) {
      const data = ownRecord(params, method);
      const threadId = requiredString(data, 'threadId', method);
      const turnId = requiredString(data, 'turnId', method);
      if (!this.activeTurns.has(threadId) && !this.retiredTurns.has(JSON.stringify([threadId, turnId]))
          && [...this.pending.values()].some(request => [METHOD.threadResume, METHOD.threadFork].includes(request.method))) {
        jsonData(data.tokenUsage ? data.tokenUsage.value : undefined, `${method}.tokenUsage`);
        if (this.pendingRestoredUsage.length >= 32) fail('CODEX_PROTOCOL_INVALID', 'Too many pending restored token usage notifications');
        this.pendingRestoredUsage.push({ threadId, turnId });
        return;
      }
      if (!this._turnEvent(threadId, turnId, method)) return;
      const usage = jsonData(data.tokenUsage ? data.tokenUsage.value : undefined, `${method}.tokenUsage`);
      this.usage.set(threadId, usage);
      this._emit({ type: 'usage', threadId, turnId, usage });
      return;
    }
    if (method === METHOD.turnCompleted) {
      const data = ownRecord(params, method);
      const threadId = requiredString(data, 'threadId', method);
      const turn = ownRecord(data.turn ? data.turn.value : undefined, `${method}.turn`);
      const turnId = requiredString(turn, 'id', `${method}.turn`);
      const status = requiredString(turn, 'status', `${method}.turn`);
      const active = this._turnEvent(threadId, turnId, method);
      if (!active) return;
      if (!TERMINAL_TURN_STATUSES.includes(status)) {
        fail('CODEX_PROTOCOL_INVALID', `${method}.turn.status must be a terminal status`);
      }
      let text = null;
      let resetsAt = null;
      let limit = null;
      if (status === 'failed' && turn.error?.value != null) {
        const error = ownRecord(turn.error.value, `${method}.turn.error`);
        const code = error.codexErrorInfo?.value;
        if (typeof code === 'string' && Object.hasOwn(TURN_FAILURE_TEXT, code)) text = TURN_FAILURE_TEXT[code];
        if (code === 'usageLimitExceeded') {
          const clock = Number(this.now());
          resetsAt = Number.isFinite(clock) ? usageLimitResetsAt(error.message?.value, clock) : null;
          limit = resetsAt ? { limit: 'usage', resetsAt } : { limit: 'usage' };
          if (resetsAt) text = `This Codex account has reached its usage limit. The limit resets ${resetWords(resetsAt, clock)}. Until then, choose another account in the Accounts menu.`;
        }
      }
      active.completed = true;
      this._retireTurnApprovals(active);
      this.retiredTurns.add(JSON.stringify([threadId, turnId]));
      if (this.retiredTurns.size > 1024) this.retiredTurns.delete(this.retiredTurns.values().next().value);
      for (const itemId of active.assistantItems) this.assistantParts.delete(itemId);
      for (const [key, summary] of this.reasoningParts) if (summary.threadId === threadId && summary.turnId === turnId) this.reasoningParts.delete(key);
      if (active.acknowledged && this.activeTurns.get(threadId) === active) this.activeTurns.delete(threadId);
      // The payload is the same fact for a machine reader: a usage limit, and
      // when it resets if the provider said. Nothing else of the message.
      this._emit({ type: 'turn_completed', threadId, turnId, status, ...(text ? { text } : {}),
        ...(limit ? { payload: limit } : {}) });
    }
    // Unknown notifications are ignored: they have no host authority. Unknown
    // requests are rejected above so a new server action cannot be trusted.
  }

  _handleItem(method, params) {
    const data = ownRecord(params, method);
    const threadId = requiredString(data, 'threadId', method);
    const turnId = requiredString(data, 'turnId', method);
    if (!this._turnEvent(threadId, turnId, method)) return;
    const item = ownRecord(data.item ? data.item.value : undefined, `${method}.item`);
    const type = requiredString(item, 'type', `${method}.item`);
    const itemId = requiredString(item, 'id', `${method}.item`);
    if (type === 'subAgentActivity') {
      this._rememberSubAgent(threadId, item);
      return;
    }
    if (type === 'agentMessage' && method === METHOD.itemCompleted) {
      // Silent final messages are valid. Rejecting one closes the reader before
      // turn/completed arrives and leaves the host's active turn stuck busy.
      const finalText = requiredString(item, 'text', `${method}.item`, { allowEmpty: true });
      const parts = this.assistantParts.get(itemId);
      const assembled = parts ? parts.join('') : finalText;
      if (parts && assembled !== finalText) fail('CODEX_PROTOCOL_INVALID', 'Codex assistant message deltas disagree with the completed item');
      this.assistantParts.delete(itemId);
      this._emit({ type: 'assistant_text', threadId, turnId, itemId, text: assembled });
      return;
    }
    // A reasoning item can be active without exposing any reasoning text.
    // Forward its lifecycle so the UI does not keep showing an old tool result.
    if (type === 'reasoning') {
      if (method === METHOD.itemStarted) {
        this._emit({ type: 'thinking', threadId, turnId, itemId, text: '', status: 'inProgress' });
      } else {
        // Current Codex uses summary[], while older integrations used text.
        // Never read raw content or encrypted reasoning to manufacture progress.
        const summary = item.summary?.value;
        const key = JSON.stringify([threadId, turnId, itemId]);
        const streamed = this.reasoningParts.get(key);
        this.reasoningParts.delete(key);
        const completedText = Array.isArray(summary)
          ? summary.filter(part => typeof part === 'string').join('\n')
          : optionalString(item, 'text', `${method}.item`);
        // An empty final summary is not a retraction of the readable summary
        // already supplied on the wire. The completed item closes that same
        // text, allowing its final presentation fragment to flush immediately.
        const text = completedText || streamed?.sections.filter(part => typeof part === 'string').join('\n');
        if (text) this._emit({ type: 'thinking', threadId, turnId, itemId, text: text.slice(0, 1_000_000),
          ...(text.length > 1_000_000 || (!completedText && streamed?.truncated) ? { payload: { truncated: true } } : {}) });
      }
      return;
    }
    /* A SANDBOX-REFUSED FILE CHANGE ARRIVES AS NO ITEM AT ALL, AND THIS LIST IS
     * NOT WHY. Written down because the next person to ask "why did the chat
     * show the agent SAY it was refused and show no action behind it" will
     * suspect this line first, and adding item types here would fix nothing.
     *
     * MEASURED 2026-08-20, codex-cli 0.146.0, this adapter over this transport,
     * one prompt ("create hello.txt in the current folder"), every raw
     * app-server message logged, same confined home and same git-initialised
     * workspace on both rows:
     *
     *   thread/start sandbox=read-only          -> items: userMessage x2,
     *     agentMessage x4. NO fileChange, NO commandExecution, NO
     *     dynamicToolCall. The turn completed normally. The only trace of the
     *     attempt anywhere was the model's own prose, "patch rejected: writing
     *     is blocked by read-only sandbox" -- and prose is not evidence.
     *   thread/start sandbox=danger-full-access -> the SAME prompt produced
     *     item/started + item/completed of type `fileChange`, which this list
     *     admits and which left here as tool_call and tool_result. The file was
     *     on disk.
     *
     * So the engine emits the item for a change it PERFORMS and none for a
     * change its sandbox refuses; nothing above this line can render what it is
     * never told. What the product can still do honestly is say what the
     * session's sandbox IS -- which is why parseThreadResponse keeps the
     * resolved sandbox, and why the Start controls carry the confinement
     * sentence. */
    if (!['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(type)) return;
    const tool = type;
    if (method === METHOD.itemStarted) {
      this._emit({ type: 'tool_call', threadId, turnId, itemId, toolCallId: itemId, tool, payload: this._toolPayload(item) });
    } else {
      this._emit({ type: 'tool_result', threadId, turnId, itemId, toolCallId: itemId, tool, payload: this._toolResult(item) });
    }
  }

  _toolPayload(item) {
    const payload = {};
    for (const key of ['command', 'cwd', 'server', 'tool', 'arguments', 'changes']) {
      if (Object.hasOwn(item, key)) payload[key] = jsonData(item[key].value, `tool item.${key}`);
    }
    return payload;
  }

  _toolResult(item) {
    // A renderer may rejoin after item/started. The completed item carries
    // its own tool/arguments; preserve them so its result remains readable.
    const payload = this._toolPayload(item);
    for (const key of ['status', 'aggregatedOutput', 'exitCode', 'result', 'error', 'success', 'contentItems']) {
      if (Object.hasOwn(item, key)) payload[key] = jsonData(item[key].value, `tool item.${key}`);
    }
    return payload;
  }

  _rememberHostThread(threadId) {
    if (this.subAgentThreads.has(threadId)) fail('CODEX_PROTOCOL_INVALID', 'A native worker cannot replace a host-owned thread');
    if (!this.hostThreads.has(threadId) && this.hostThreads.size >= 4096) fail('CODEX_PROTOCOL_INVALID', 'Codex host thread identity limit exceeded');
    this.hostThreads.add(threadId);
  }

  _rememberSubAgent(parentThreadId, item) {
    if (requiredString(item, 'type', 'Codex worker item') !== 'subAgentActivity') return;
    requiredString(item, 'id', 'Codex worker item');
    const kind = requiredString(item, 'kind', 'Codex worker item');
    if (!['started', 'interacted', 'interrupted', 'completed'].includes(kind)) fail('CODEX_PROTOCOL_INVALID', 'Unknown Codex worker activity kind');
    const childThreadId = requiredString(item, 'agentThreadId', 'Codex worker item');
    const rootThreadId = this.subAgentThreads.get(parentThreadId) || parentThreadId;
    // Native send_message from a bound worker back to its root emits an
    // interacted item naming that root. It reports communication, not a new
    // worker: keep the parent's active turn and its ownership unchanged.
    if (kind === 'interacted' && this.subAgentThreads.has(parentThreadId) && childThreadId === rootThreadId) return;
    if (childThreadId === rootThreadId || childThreadId === parentThreadId || this.hostThreads.has(childThreadId)
        || this.subAgentThreads.has(childThreadId) && this.subAgentThreads.get(childThreadId) !== rootThreadId) {
      fail('CODEX_PROTOCOL_INVALID', 'Codex worker activity conflicts with an owned thread');
    }
    if (!this.subAgentThreads.has(childThreadId) && this.subAgentThreads.size >= 4096) fail('CODEX_PROTOCOL_INVALID', 'Codex worker identity limit exceeded');
    this.subAgentThreads.set(childThreadId, rootThreadId);
  }

  _bindTurn(active, turnId, label) {
    if (!active || this.activeTurns.get(active.threadId) !== active) {
      fail('CODEX_PROTOCOL_INVALID', `${label} did not match the pending Codex turn`);
    }
    if (!active.completed && this.retiredTurns.has(JSON.stringify([active.threadId, turnId]))) {
      fail('CODEX_PROTOCOL_INVALID', `${label} reused a completed Codex turn`);
    }
    if (active.turnId === null) active.turnId = turnId;
    else if (active.turnId !== turnId) {
      fail('CODEX_PROTOCOL_INVALID', `${label} did not match the active Codex turn`);
    }
    return active;
  }

  _turnEvent(threadId, turnId, label) {
    if (this.retiredTurns.has(JSON.stringify([threadId, turnId]))) return null;
    const active = this.activeTurns.get(threadId);
    if (!active) fail('CODEX_PROTOCOL_INVALID', `${label} did not match an active Codex thread`);
    return this._bindTurn(active, turnId, label);
  }

  _retireTurnApprovals(active) {
    for (const [approvalId, approval] of this.approvals) {
      if (approval.active === active) this.approvals.delete(approvalId);
    }
  }

  _emit(event) {
    const normalized = validateEngineEvent(event);
    for (const listener of this.listeners) {
      try { listener(normalized); } catch { /* Host listener errors cannot corrupt the protocol session. */ }
    }
  }

  _failClosed(error, { terminateTurns = true } = {}) {
    if (this.closed) return;
    this.closed = error instanceof CodexAdapterError ? error : new CodexAdapterError('CODEX_PROTOCOL_INVALID', 'Codex protocol failed closed');
    const interrupted = terminateTurns
      ? [...this.activeTurns.values()].filter(active => !active.completed && typeof active.turnId === 'string')
      : [];
    if (this.unsubscribe) {
      try { this.unsubscribe(); } catch { /* Transport cleanup is best effort. */ }
    }
    this.approvals.clear();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.activeTurns.clear();
      this.subAgentThreads.clear();
      this.hostThreads.clear();
      this.confirmedModes.clear();
      this.collaborationModes = null;
      this.retiredTurns.clear();
      this.assistantParts.clear();
      this.reasoningParts.clear();
      // Only confirmed transport closure may turn accepted work into a failed
      // terminal. A parser failure by itself does not stop native effects.
      for (const active of interrupted) this._emit({
        type: 'turn_completed', threadId: active.threadId, turnId: active.turnId,
        status: 'failed', text: this.closed.message,
      });
      for (const pending of this.pending.values()) pending.reject(this.closed);
      this.pending.clear();
    };
    if (terminateTurns && typeof this.transport.closeForProtocolFailure === 'function') {
      let inFlight = null;
      const retryCleanup = () => {
        if (finished) return Promise.resolve();
        if (!inFlight) inFlight = Promise.resolve()
          .then(() => this.transport.closeForProtocolFailure())
          .then(finish)
          .finally(() => { inFlight = null; });
        return inFlight;
      };
      Object.defineProperty(this.closed, 'retryCleanup', { value: retryCleanup });
      // On refusal retain turn/request custody and the same retry handle. No
      // terminal or idle result can be inferred from a failed kill request.
      retryCleanup().catch(() => {});
    } else finish(); // Explicit close owns its lifecycle; pure wire transports have no native child.
  }
}

function createCodexAdapter(options) {
  return new CodexAdapter(options);
}

module.exports = {
  CODEX_CLI_VERSION,
  CODEX_PROTOCOL_COMPATIBILITY_LINE,
  METHOD,
  COMMAND_DECISIONS,
  FILE_DECISIONS,
  CodexAdapter,
  CodexAdapterError,
  assertPinnedVersion,
  createCodexAdapter
};
