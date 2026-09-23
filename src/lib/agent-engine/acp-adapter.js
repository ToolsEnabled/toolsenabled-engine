'use strict';

const {
  validateApprovalAnswer,
  validateEngineEvent,
  validateSendTurnRequest,
  validateThreadId,
  validateThreadOptions
} = require('./engine-contract');
const { randomUUID } = require('node:crypto');

// ACP is negotiated at runtime. The official agent subprocess owns authentication;
// this adapter only selects an auth method advertised by the agent.
const ACP_PROTOCOL_VERSION = 1;

const METHOD = Object.freeze({
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionFork: 'session/fork',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetModel: 'session/set_model',
  sessionSetConfigOption: 'session/set_config_option',
  sessionUpdate: 'session/update',
  sessionRequestPermission: 'session/request_permission'
});

const TERMINAL_TOOL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);
const MAX_LINE_BYTES = 8_000_000;
const MAX_IMAGE_BYTES = 3_000_000;

// Gemini individual accounts moved to Antigravity; Enterprise/API access remains
// supported by Gemini CLI: github.com/google-gemini/gemini-cli/discussions/28017.
const GEMINI_INDIVIDUAL_RETIREMENT_MESSAGE = 'Gemini CLI no longer supports this Google account. In Accounts, add Antigravity and select that connection.';

class AcpAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AcpAdapterError';
    this.code = code;
    if (Object.hasOwn(details, 'rpcCode')) this.rpcCode = details.rpcCode;
    if (Object.hasOwn(details, 'authMethods')) this.authMethods = details.authMethods;
    if (Object.hasOwn(details, 'exit')) this.exit = details.exit;
  }
}

const EXIT_DETAIL_LIMIT = 2_000;

// Preserve the exit information supplied by the transport. Previously this
// boundary discarded it and left callers with only ACP_PROCESS_EXITED. The
// bounded stderr tail may help explain an exit; its contents are not a proven
// cause, and callers still apply their own diagnostic disclosure rules.
function processExitError(exitInfo) {
  const info = exitInfo && typeof exitInfo === 'object' ? exitInfo : {};
  const signal = info.signal === null || info.signal === undefined ? null : String(info.signal).slice(0, 64);
  const code = info.code === null || info.code === undefined ? null : info.code;
  const spawnError = info.error ? String(info.error.message || info.error).slice(0, 200) : null;
  const stderr = String(info.stderr === null || info.stderr === undefined ? '' : info.stderr)
    .trim().slice(-EXIT_DETAIL_LIMIT);
  /* The transport reports an error for a spawn that never started AND for a
     pipe that broke under a program that had started, and it cannot tell them
     apart. On a killed child either one can arrive first, so this says what is
     true of both and never claims a status it did not receive. */
  const cause = spawnError !== null ? `could not be run or reached: ${spawnError}`
    : signal !== null ? `signal ${signal}`
      : code === null ? 'no exit status reported'
        : `exit code ${code}`;
  return new AcpAdapterError('ACP_PROCESS_EXITED',
    `The ACP program exited (${cause})${stderr ? `: ${stderr}` : ''}`,
    { exit: Object.freeze({ code, signal, spawnError, stderr }) });
}

function fail(code, message, details) {
  throw new AcpAdapterError(code, message, details);
}

function ownRecord(value, label, { allowed } = {}) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail('ACP_PROTOCOL_INVALID', `${label} must be an object`);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('ACP_PROTOCOL_INVALID', `${label} must be plain JSON data`);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      fail('ACP_PROTOCOL_INVALID', `${label} has symbol keys`);
    }
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.keys(fields).length > 1_024) fail('ACP_PROTOCOL_INVALID', `${label} has too many fields`);
    for (const [key, descriptor] of Object.entries(fields)) {
      if (!Object.hasOwn(descriptor, 'value')) fail('ACP_PROTOCOL_INVALID', `${label}.${key} must be data`);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        fail('ACP_PROTOCOL_INVALID', `${label} has an unsafe key`);
      }
      if (allowed && !allowed.includes(key)) fail('ACP_PROTOCOL_INVALID', `${label} contains unsupported field ${key}`);
    }
    return fields;
  } catch (error) {
    if (error instanceof AcpAdapterError) throw error;
    fail('ACP_PROTOCOL_INVALID', `${label} cannot be inspected safely`);
  }
}

function requiredString(fields, key, label, { allowEmpty = false, max = 1_000_000 } = {}) {
  if (!Object.hasOwn(fields, key) || typeof fields[key].value !== 'string' ||
    (!allowEmpty && fields[key].value.length === 0) || fields[key].value.length > max) {
    fail('ACP_PROTOCOL_INVALID', `${label}.${key} must be a bounded string`);
  }
  return fields[key].value;
}

function optionalString(fields, key, label, options) {
  if (!Object.hasOwn(fields, key) || fields[key].value === null) return null;
  return requiredString(fields, key, label, { allowEmpty: true, ...options });
}

function requiredNumber(fields, key, label, { integer = false, min = -Number.MAX_VALUE, max = Number.MAX_VALUE } = {}) {
  const value = Object.hasOwn(fields, key) ? fields[key].value : null;
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) ||
    value < min || value > max) {
    fail('ACP_PROTOCOL_INVALID', `${label}.${key} must be a bounded number`);
  }
  return value;
}

function jsonData(value, label, depth = 0) {
  if (depth > 32) fail('ACP_PROTOCOL_INVALID', `${label} is too deeply nested`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 10_000) fail('ACP_PROTOCOL_INVALID', `${label} has too many entries`);
    return value.map((entry, index) => jsonData(entry, `${label}[${index}]`, depth + 1));
  }
  const fields = ownRecord(value, label);
  const copy = {};
  for (const [key, descriptor] of Object.entries(fields)) copy[key] = jsonData(descriptor.value, `${label}.${key}`, depth + 1);
  return copy;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateTransport(transport) {
  if (transport === null || (typeof transport !== 'object' && typeof transport !== 'function')) {
    fail('ACP_TRANSPORT_INVALID', 'ACP transport must be an object');
  }
  for (const method of ['write', 'onData']) {
    let cursor = transport;
    let descriptor = null;
    for (let depth = 0; cursor !== null && depth < 8; depth += 1, cursor = Object.getPrototypeOf(cursor)) {
      descriptor = Object.getOwnPropertyDescriptor(cursor, method);
      if (descriptor) break;
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      fail('ACP_TRANSPORT_INVALID', `ACP transport requires data method ${method}()`);
    }
  }
  return transport;
}

function validateProtocolVersion(value) {
  if ((!Number.isInteger(value) && typeof value !== 'string') || value !== ACP_PROTOCOL_VERSION) {
    fail('ACP_PROTOCOL_VERSION_MISMATCH', `ACP requires protocol version ${ACP_PROTOCOL_VERSION}`);
  }
  return value;
}

function normalizeAuthMethods(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 32) fail('ACP_PROTOCOL_INVALID', 'initialize result.authMethods must be a bounded array');
  const ids = new Set();
  const methods = value.map((method, index) => {
    const label = `initialize result.authMethods[${index}]`;
    const copy = jsonData(method, label);
    const fields = ownRecord(copy, label);
    const id = requiredString(fields, 'id', label, { max: 512 });
    if (Object.hasOwn(fields, '_meta')) jsonData(fields._meta.value, `${label}._meta`);
    if (ids.has(id)) fail('ACP_PROTOCOL_INVALID', 'initialize result contains duplicate auth method ids');
    ids.add(id);
    return deepFreeze(copy);
  });
  return Object.freeze(methods);
}

function parseInitializeResult(result) {
  const fields = ownRecord(result, 'initialize result', {
    allowed: ['protocolVersion', 'agentCapabilities', 'agentInfo', 'authMethods', '_meta']
  });
  if (!Object.hasOwn(fields, 'protocolVersion')) fail('ACP_PROTOCOL_INVALID', 'initialize result is missing protocolVersion');
  validateProtocolVersion(fields.protocolVersion.value);
  const agentCapabilities = deepFreeze(jsonData(
    Object.hasOwn(fields, 'agentCapabilities') ? fields.agentCapabilities.value : {},
    'initialize result.agentCapabilities'
  ));
  const authMethods = normalizeAuthMethods(Object.hasOwn(fields, 'authMethods') ? fields.authMethods.value : undefined);
  const output = { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities, authMethods };
  if (Object.hasOwn(fields, 'agentInfo')) output.agentInfo = deepFreeze(jsonData(fields.agentInfo.value, 'initialize result.agentInfo'));
  if (Object.hasOwn(fields, '_meta')) jsonData(fields._meta.value, 'initialize result._meta');
  return deepFreeze(output);
}

function hasImageCapability(capabilities) {
  const fields = ownRecord(capabilities, 'agent capabilities');
  if (!Object.hasOwn(fields, 'promptCapabilities')) return false;
  const prompts = ownRecord(fields.promptCapabilities.value, 'agent capabilities.promptCapabilities');
  return Object.hasOwn(prompts, 'image') && prompts.image.value === true;
}

function hasLoadCapability(capabilities) {
  const fields = ownRecord(capabilities, 'agent capabilities');
  if (Object.hasOwn(fields, 'loadSession')) return fields.loadSession.value === true;
  if (!Object.hasOwn(fields, 'sessionCapabilities')) return false;
  const session = ownRecord(fields.sessionCapabilities.value, 'agent capabilities.sessionCapabilities');
  return (Object.hasOwn(session, 'load') && session.load.value === true) ||
    (Object.hasOwn(session, 'resume') && session.resume.value === true);
}

function hasForkCapability(capabilities) {
  const fields = ownRecord(capabilities, 'agent capabilities');
  if (Object.hasOwn(fields, 'forkSession')) return fields.forkSession.value === true;
  if (!Object.hasOwn(fields, 'sessionCapabilities')) return false;
  const session = ownRecord(fields.sessionCapabilities.value, 'agent capabilities.sessionCapabilities');
  return Object.hasOwn(session, 'fork') && session.fork.value === true;
}

function normalizeSessionModes(value, label) {
  const fields = ownRecord(value, label, { allowed: ['currentModeId', 'availableModes'] });
  const currentModeId = requiredString(fields, 'currentModeId', label, { max: 512 });
  const output = { currentModeId };
  if (!Object.hasOwn(fields, 'availableModes')) return Object.freeze(output);
  if (!Array.isArray(fields.availableModes.value) || fields.availableModes.value.length === 0 ||
    fields.availableModes.value.length > 32) {
    fail('ACP_PROTOCOL_INVALID', `${label}.availableModes must be a bounded non-empty array`);
  }
  const ids = new Set();
  const availableModes = fields.availableModes.value.map((mode, index) => {
    const modeLabel = `${label}.availableModes[${index}]`;
    const modeFields = ownRecord(mode, modeLabel, { allowed: ['id', 'name', 'description'] });
    const id = requiredString(modeFields, 'id', modeLabel, { max: 512 });
    const name = optionalString(modeFields, 'name', modeLabel, { max: 32_768 });
    const description = optionalString(modeFields, 'description', modeLabel, { max: 32_768 });
    if (ids.has(id)) fail('ACP_PROTOCOL_INVALID', `${label} contains duplicate mode ids`);
    ids.add(id);
    const normalized = { id };
    if (name !== null) normalized.name = name;
    if (description !== null) normalized.description = description;
    return Object.freeze(normalized);
  });
  if (!ids.has(currentModeId)) {
    fail('ACP_PROTOCOL_INVALID', `${label}.currentModeId must identify an available mode`);
  }
  output.availableModes = availableModes;
  return deepFreeze(output);
}

function normalizeSessionConfigOptions(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    fail('ACP_PROTOCOL_INVALID', `${label} must be a bounded non-empty array`);
  }
  const ids = new Set();
  const configOptions = value.map((configOption, index) => {
    const optionLabel = `${label}[${index}]`;
    const fields = ownRecord(configOption, optionLabel, {
      allowed: ['id', 'name', 'description', 'category', 'type', 'currentValue', 'options']
    });
    const id = requiredString(fields, 'id', optionLabel, { max: 512 });
    const name = optionalString(fields, 'name', optionLabel, { max: 32_768 });
    const description = optionalString(fields, 'description', optionLabel, { max: 32_768 });
    const category = optionalString(fields, 'category', optionLabel, { max: 32_768 });
    const type = optionalString(fields, 'type', optionLabel, { max: 128 });
    const currentValue = optionalString(fields, 'currentValue', optionLabel, { max: 32_768 });
    if (type !== null && type !== 'select') fail('ACP_PROTOCOL_INVALID', `${optionLabel}.type must be select`);
    if (ids.has(id)) fail('ACP_PROTOCOL_INVALID', `${label} contains duplicate config option ids`);
    ids.add(id);
    const normalized = { id };
    if (name !== null) normalized.name = name;
    if (description !== null) normalized.description = description;
    if (category !== null) normalized.category = category;
    if (type !== null) normalized.type = type;
    if (currentValue !== null) normalized.currentValue = currentValue;
    if (Object.hasOwn(fields, 'options')) {
      if (!Array.isArray(fields.options.value) || fields.options.value.length === 0 ||
        fields.options.value.length > 256) {
        fail('ACP_PROTOCOL_INVALID', `${optionLabel}.options must be a bounded non-empty array`);
      }
      const values = new Set();
      normalized.options = fields.options.value.map((choice, choiceIndex) => {
        const choiceLabel = `${optionLabel}.options[${choiceIndex}]`;
        const choiceFields = ownRecord(choice, choiceLabel, { allowed: ['value', 'name', 'description'] });
        const value = requiredString(choiceFields, 'value', choiceLabel, { max: 32_768 });
        const choiceName = optionalString(choiceFields, 'name', choiceLabel, { max: 32_768 });
        const choiceDescription = optionalString(choiceFields, 'description', choiceLabel, { max: 32_768 });
        if (values.has(value)) fail('ACP_PROTOCOL_INVALID', `${optionLabel} contains duplicate option values`);
        values.add(value);
        const normalizedChoice = { value };
        if (choiceName !== null) normalizedChoice.name = choiceName;
        if (choiceDescription !== null) normalizedChoice.description = choiceDescription;
        return Object.freeze(normalizedChoice);
      });
      if (currentValue !== null && !values.has(currentValue)) {
        fail('ACP_PROTOCOL_INVALID', `${optionLabel}.currentValue must identify an available option`);
      }
    }
    return deepFreeze(normalized);
  });
  return Object.freeze(configOptions);
}

function parseSessionResult(result, method, fallbackSessionId = null) {
  const fields = ownRecord(result, `${method} result`, {
    allowed: ['sessionId', 'modes', 'models', 'configOptions', '_meta']
  });
  const sessionId = Object.hasOwn(fields, 'sessionId')
    ? requiredString(fields, 'sessionId', `${method} result`, { max: 512 })
    : fallbackSessionId;
  if (!sessionId) fail('ACP_PROTOCOL_INVALID', `${method} result is missing sessionId`);
  if (Object.hasOwn(fields, '_meta')) jsonData(fields._meta.value, `${method} result._meta`);
  const output = { threadId: sessionId };
  if (Object.hasOwn(fields, 'models')) output.models = deepFreeze(jsonData(fields.models.value, `${method} result.models`));
  if (Object.hasOwn(fields, 'modes')) output.modes = normalizeSessionModes(fields.modes.value, `${method} result.modes`);
  if (Object.hasOwn(fields, 'configOptions')) {
    output.configOptions = normalizeSessionConfigOptions(fields.configOptions.value, `${method} result.configOptions`);
  }
  return Object.freeze(output);
}

function sessionModels(value) {
  const fields = ownRecord(value, 'session models');
  const currentModelId = requiredString(fields, 'currentModelId', 'session models', { max: 512 });
  const choices = fields.availableModels?.value;
  if (!Array.isArray(choices) || choices.length > 256) fail('ACP_PROTOCOL_INVALID', 'Session model choices must be bounded.');
  const ids = new Set();
  const availableModels = choices.map(choice => {
    const model = ownRecord(choice, 'session model');
    const modelId = requiredString(model, 'modelId', 'session model', { max: 512 });
    if (ids.has(modelId)) fail('ACP_PROTOCOL_INVALID', 'Session model choices must be unique.');
    ids.add(modelId);
    return deepFreeze({ ...jsonData(choice, 'session model'), modelId });
  });
  return deepFreeze({ currentModelId, availableModels });
}

function normalizePromptUsage(value) {
  const label = 'session/prompt result.usage';
  const fields = ownRecord(value, label, {
    allowed: ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens', 'totalTokens']
  });
  return Object.freeze({
    inputTokens: requiredNumber(fields, 'inputTokens', label, { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER }),
    outputTokens: requiredNumber(fields, 'outputTokens', label, { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER }),
    cachedReadTokens: requiredNumber(fields, 'cachedReadTokens', label, {
      integer: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER
    }),
    cachedWriteTokens: requiredNumber(fields, 'cachedWriteTokens', label, {
      integer: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER
    }),
    totalTokens: requiredNumber(fields, 'totalTokens', label, { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER })
  });
}

function normalizeAvailableCommandsUpdate(value) {
  const label = 'available_commands_update';
  const fields = ownRecord(value, label, { allowed: ['sessionUpdate', 'availableCommands', '_meta'] });
  if (requiredString(fields, 'sessionUpdate', label, { max: 256 }) !== 'available_commands_update') {
    fail('ACP_PROTOCOL_INVALID', 'available_commands_update has an invalid sessionUpdate discriminator');
  }
  if (!Object.hasOwn(fields, 'availableCommands') || !Array.isArray(fields.availableCommands.value) ||
    fields.availableCommands.value.length > 1_024) {
    fail('ACP_PROTOCOL_INVALID', 'available_commands_update.availableCommands must be a bounded array');
  }
  return Object.freeze(fields.availableCommands.value.map((command, index) => {
    const commandLabel = `${label}.availableCommands[${index}]`;
    const copy = deepFreeze(jsonData(command, commandLabel));
    ownRecord(copy, commandLabel);
    return copy;
  }));
}

function normalizeUsageUpdate(value) {
  const label = 'usage_update';
  const fields = ownRecord(value, label, {
    allowed: ['sessionUpdate', 'used', 'size', 'cost', '_meta']
  });
  if (requiredString(fields, 'sessionUpdate', label, { max: 256 }) !== 'usage_update') {
    fail('ACP_PROTOCOL_INVALID', 'usage_update has an invalid sessionUpdate discriminator');
  }
  const usage = {
    used: requiredNumber(fields, 'used', label, { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER }),
    size: requiredNumber(fields, 'size', label, { integer: true, min: 0, max: Number.MAX_SAFE_INTEGER })
  };
  if (Object.hasOwn(fields, 'cost')) {
    const cost = ownRecord(fields.cost.value, 'usage_update.cost', { allowed: ['amount', 'currency'] });
    usage.cost = Object.freeze({
      amount: requiredNumber(cost, 'amount', 'usage_update.cost', { min: 0, max: Number.MAX_SAFE_INTEGER }),
      currency: requiredString(cost, 'currency', 'usage_update.cost', { max: 32 })
    });
  }
  if (Object.hasOwn(fields, '_meta')) jsonData(fields._meta.value, 'usage_update._meta');
  return deepFreeze(usage);
}

function sessionParams(options, defaultCwd) {
  const normalized = validateThreadOptions(options);
  const unsupported = Object.keys(normalized).find(key => key !== 'cwd');
  if (unsupported) fail('ACP_ADAPTER_INVALID', `ACP session creation does not accept the engine-neutral ${unsupported} option`);
  const cwd = normalized.cwd || defaultCwd;
  if (!cwd) fail('ACP_ADAPTER_INVALID', 'ACP session creation requires cwd or defaultCwd');
  return { cwd, mcpServers: [] };
}

function imageContentBlock(image, imageLoader) {
  if (Object.hasOwn(image, 'path')) {
    if (!imageLoader) fail('ACP_IMAGE_INVALID', 'ACP local image paths require an injected imageLoader');
    let loaded;
    try { loaded = imageLoader(image.path); } catch { fail('ACP_IMAGE_INVALID', 'ACP imageLoader failed'); }
    const fields = ownRecord(loaded, 'imageLoader result', { allowed: ['data', 'mimeType'] });
    return validateImageBytes(
      requiredString(fields, 'data', 'imageLoader result', { max: 4_000_000 }),
      requiredString(fields, 'mimeType', 'imageLoader result', { max: 256 })
    );
  }
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.url);
  if (!match) fail('ACP_IMAGE_INVALID', 'ACP images must be base64 data URLs or use an injected imageLoader');
  return validateImageBytes(match[2], match[1]);
}

function validateImageBytes(data, mimeType) {
  if (!/^image\/[A-Za-z0-9.+-]+$/.test(mimeType) || data.length % 4 !== 0) {
    fail('ACP_IMAGE_INVALID', 'ACP image data is malformed');
  }
  let bytes;
  try { bytes = Buffer.from(data, 'base64'); } catch { fail('ACP_IMAGE_INVALID', 'ACP image data is malformed'); }
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== data) {
    fail('ACP_IMAGE_INVALID', 'ACP image data is malformed or exceeds the safety limit');
  }
  return Object.freeze({ type: 'image', data, mimeType });
}

function normalizePermissionParams(params) {
  const fields = ownRecord(params, 'session/request_permission params', {
    allowed: ['sessionId', 'toolCall', 'options', '_meta']
  });
  const sessionId = requiredString(fields, 'sessionId', 'session/request_permission params', { max: 512 });
  if (Object.hasOwn(fields, '_meta')) jsonData(fields._meta.value, 'session/request_permission params._meta');
  if (!Object.hasOwn(fields, 'toolCall')) fail('ACP_PROTOCOL_INVALID', 'session/request_permission params is missing toolCall');
  const toolCall = deepFreeze(jsonData(fields.toolCall.value, 'session/request_permission params.toolCall'));
  const toolFields = ownRecord(toolCall, 'session/request_permission params.toolCall');
  const toolCallId = requiredString(toolFields, 'toolCallId', 'session/request_permission params.toolCall', { max: 1_024 });
  if (!Object.hasOwn(fields, 'options') || !Array.isArray(fields.options.value) ||
    fields.options.value.length === 0 || fields.options.value.length > 32) {
    fail('ACP_PROTOCOL_INVALID', 'session/request_permission params.options must be a bounded non-empty array');
  }
  const ids = new Set();
  const options = fields.options.value.map((option, index) => {
    const copy = deepFreeze(jsonData(option, `session/request_permission params.options[${index}]`));
    const optionFields = ownRecord(copy, `session/request_permission params.options[${index}]`);
    const optionId = requiredString(optionFields, 'optionId', `session/request_permission params.options[${index}]`, { max: 512 });
    requiredString(optionFields, 'name', `session/request_permission params.options[${index}]`, { max: 32_768 });
    const kind = requiredString(optionFields, 'kind', `session/request_permission params.options[${index}]`, { max: 128 });
    if (!['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(kind)) {
      fail('ACP_PROTOCOL_INVALID', 'Permission option has an unsupported scope');
    }
    if (ids.has(optionId)) fail('ACP_PROTOCOL_INVALID', 'session/request_permission reused an option id');
    ids.add(optionId);
    return copy;
  });
  return { sessionId, toolCallId, toolCall, options: Object.freeze(options), optionIds: ids };
}

function permissionResponse(value, optionIds) {
  const fields = ownRecord(value, 'permission response', { allowed: ['outcome', 'decision'] });
  // The shared host carries the exact offered button id. Do not infer an
  // allow-once/session/remembered grant from another provider's vocabulary.
  if (Object.hasOwn(fields, 'decision')) {
    if (Object.hasOwn(fields, 'outcome')) fail('ACP_APPROVAL_INVALID', 'Permission response must select one answer format');
    const optionId = requiredString(fields, 'decision', 'permission response', { max: 512 });
    if (!optionIds.has(optionId)) fail('ACP_APPROVAL_INVALID', 'Permission response selected an unavailable option');
    return { outcome: { outcome: 'selected', optionId } };
  }
  if (!Object.hasOwn(fields, 'outcome')) fail('ACP_APPROVAL_INVALID', 'Permission response requires outcome');
  const outcome = ownRecord(fields.outcome.value, 'permission response.outcome', { allowed: ['outcome', 'optionId'] });
  const kind = requiredString(outcome, 'outcome', 'permission response.outcome', { max: 128 });
  if (kind === 'cancelled') {
    if (Object.hasOwn(outcome, 'optionId')) fail('ACP_APPROVAL_INVALID', 'Cancelled permission response cannot select an option');
    return { outcome: { outcome: 'cancelled' } };
  }
  if (kind !== 'selected') fail('ACP_APPROVAL_INVALID', 'Permission outcome must be selected or cancelled');
  const optionId = requiredString(outcome, 'optionId', 'permission response.outcome', { max: 512 });
  if (!optionIds.has(optionId)) fail('ACP_APPROVAL_INVALID', 'Permission response selected an unavailable option');
  return { outcome: { outcome: 'selected', optionId } };
}

class AcpAdapter {
  constructor({
    transport,
    protocolVersion = ACP_PROTOCOL_VERSION,
    clientInfo = { name: 'toolsenabled', title: 'ToolsEnabled', version: '1' },
    clientCapabilities = {},
    defaultCwd = null,
    imageLoader = null,
    mcpServers = [],
    sessionMeta = null
  } = {}) {
    this.transport = validateTransport(transport);
    this.protocolVersion = validateProtocolVersion(protocolVersion);
    this.clientInfo = deepFreeze(jsonData(clientInfo, 'clientInfo'));
    this.clientCapabilities = deepFreeze(jsonData(clientCapabilities, 'clientCapabilities'));
    if (defaultCwd !== null && (typeof defaultCwd !== 'string' || defaultCwd.length === 0 || defaultCwd.length > 32_768)) {
      fail('ACP_ADAPTER_INVALID', 'defaultCwd must be a bounded non-empty string or null');
    }
    if (imageLoader !== null && typeof imageLoader !== 'function') fail('ACP_ADAPTER_INVALID', 'imageLoader must be a function or null');
    this.defaultCwd = defaultCwd;
    this.imageLoader = imageLoader;
    if (!Array.isArray(mcpServers)) fail('ACP_ADAPTER_INVALID', 'ACP MCP servers must be an array');
    this.mcpServers = deepFreeze(jsonData(mcpServers, 'mcpServers'));
    this.sessionMeta = sessionMeta === null ? null : deepFreeze(jsonData(sessionMeta, 'sessionMeta'));
    this.nextRequestId = 1;
    /* A TURN ID MUST NOT REPEAT ACROSS PROCESSES. The counter alone restarted
       at 1 in every adapter, so a resumed conversation reissued acp-turn-1 for
       a turn its restored history already held, and a transcript that places a
       row by turn identity could no longer tell the two apart. The token is
       per instance; the counter still gives one turn one id for its events and
       its receipt. */
    this.turnIdToken = randomUUID();
    this.nextTurnId = 1;
    this.pending = new Map();
    this.approvals = new Map();
    this.pendingApprovalRequests = new Set();
    this.nextApprovalId = 1;
    this.listeners = new Set();
    this.activeTurns = new Map();
    this.loadingSessions = new Set();
    this.usage = new Map();
    this.sessionModes = new Map();
    this.sessionSelections = new Map();
    this.sessionIdentities = new Map();
    this.sessionConfigOptions = new Map();
    this.sessionModels = new Map();
    this.selectedModels = new Map();
    this.modelProvider = null;
    this.buffer = '';
    this.closed = null;
    this.initialized = null;
    this.initializing = null;
    this.authenticatedMethodId = null;
    const unsubscribe = this.transport.onData((chunk, exitInfo) => {
      if (exitInfo) this._failClosed(processExitError(exitInfo));
      else this._receive(chunk);
    });
    if (unsubscribe !== undefined && typeof unsubscribe !== 'function') {
      fail('ACP_TRANSPORT_INVALID', 'ACP transport onData must return a function when it returns a value');
    }
    this.unsubscribe = unsubscribe || null;
  }

  onEvent(listener) {
    if (typeof listener !== 'function') fail('ACP_ADAPTER_INVALID', 'onEvent requires a listener function');
    this._assertOpen();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  initialize() {
    this._assertOpen();
    if (this.initialized) return Promise.resolve(this.initialized);
    if (this.initializing) return this.initializing;
    this.initializing = this._request(METHOD.initialize, {
      protocolVersion: this.protocolVersion,
      clientCapabilities: this.clientCapabilities,
      clientInfo: this.clientInfo
    }).then(result => {
      this.initialized = parseInitializeResult(result);
      this.initializing = null;
      return this.initialized;
    }, error => {
      this.initializing = null;
      throw error;
    });
    return this.initializing;
  }

  getCapabilities() {
    return this.initialized ? this.initialized.agentCapabilities : null;
  }

  getAuthMethods() {
    return this.initialized ? this.initialized.authMethods : null;
  }

  async authenticate(methodId, meta = null) {
    this._assertInitialized();
    if (typeof methodId !== 'string' || methodId.length === 0 || methodId.length > 512) {
      fail('ACP_AUTH_METHOD_INVALID', 'authenticate requires a bounded auth method id');
    }
    if (!this.initialized.authMethods.some(method => method.id === methodId)) {
      fail('ACP_AUTH_METHOD_INVALID', 'authenticate requires an auth method advertised by the agent');
    }
    await this._request(METHOD.authenticate, { methodId, ...(meta === null ? {} : { _meta: jsonData(meta, 'authenticate._meta') }) });
    this.authenticatedMethodId = methodId;
    return Object.freeze({ methodId });
  }

  async startThread(options = {}) {
    this._assertInitialized();
    return this._storeSessionResult(parseSessionResult(
      await this._request(METHOD.sessionNew, sessionParams(options, this.defaultCwd)),
      METHOD.sessionNew
    ));
  }

  async resumeThread(threadId, options = {}) {
    this._assertInitialized();
    if (!hasLoadCapability(this.initialized.agentCapabilities)) {
      fail('ACP_CAPABILITY_UNSUPPORTED', 'ACP agent did not advertise session loading');
    }
    const sessionId = validateThreadId(threadId);
    if (this.activeTurns.has(sessionId) || this.loadingSessions.has(sessionId) || this.sessionSelections.has(sessionId)) {
      fail('ACP_ADAPTER_BUSY', 'ACP session is already active or loading');
    }
    const params = { sessionId, ...sessionParams(options, this.defaultCwd) };
    this.loadingSessions.add(sessionId);
    try {
      return this._storeSessionResult(parseSessionResult(
        await this._request(METHOD.sessionLoad, params),
        METHOD.sessionLoad,
        sessionId
      ));
    } finally { this.loadingSessions.delete(sessionId); }
  }

  async forkThread(threadId, options = {}) {
    this._assertInitialized();
    if (!hasForkCapability(this.initialized.agentCapabilities)) {
      fail('ACP_CAPABILITY_UNSUPPORTED', 'ACP agent did not advertise session forking');
    }
    const params = { sessionId: validateThreadId(threadId), ...sessionParams(options, this.defaultCwd) };
    return this._storeSessionResult(parseSessionResult(
      await this._request(METHOD.sessionFork, params),
      METHOD.sessionFork
    ));
  }

  async sendTurn(request) {
    this._assertInitialized();
    const normalized = validateSendTurnRequest(request);
    if (this.activeTurns.has(normalized.threadId) || this.loadingSessions.has(normalized.threadId) || this.sessionSelections.has(normalized.threadId)) {
      fail('ACP_ADAPTER_BUSY', 'ACP session has an active prompt, load, or mode selection');
    }
    if (normalized.images.length > 0 && !hasImageCapability(this.initialized.agentCapabilities)) {
      fail('ACP_IMAGE_UNSUPPORTED', 'ACP agent did not advertise the image prompt capability');
    }
    if (Object.keys(normalized.options).length !== 0) {
      fail('ACP_ADAPTER_INVALID', 'ACP session/prompt does not accept engine-neutral turn options');
    }
    const prompt = [];
    if (normalized.text.length > 0) prompt.push({ type: 'text', text: normalized.text });
    for (const image of normalized.images) prompt.push(imageContentBlock(image, this.imageLoader));
    const turnId = `acp-turn-${this.turnIdToken}-${this.nextTurnId++}`;
    const active = {
      turnId,
      assistantItemId: `acp-assistant-${turnId}`,
      assistantParts: [],
      thinking: null,
      nextThinkingId: 0,
      toolCalls: new Map()
    };
    this.activeTurns.set(normalized.threadId, active);
    try {
      const result = await this._request(METHOD.sessionPrompt, { sessionId: normalized.threadId, prompt });
      const fields = ownRecord(result, 'session/prompt result', { allowed: ['stopReason', 'usage', '_meta'] });
      const stopReason = requiredString(fields, 'stopReason', 'session/prompt result', { max: 256 });
      if (Object.hasOwn(fields, 'usage')) {
        this._recordUsage(normalized.threadId, turnId, normalizePromptUsage(fields.usage.value));
      }
      if (Object.hasOwn(fields, '_meta')) jsonData(fields._meta.value, 'session/prompt result._meta');
      this._finishThinking(normalized.threadId, active);
      if (active.assistantParts.length > 0) {
        this._emit({
          type: 'assistant_text', threadId: normalized.threadId, turnId,
          itemId: active.assistantItemId, text: active.assistantParts.join('')
        });
      }
      this._emit({ type: 'turn_completed', threadId: normalized.threadId, turnId, status: stopReason });
      return Object.freeze({ turnId, stopReason });
    } finally {
      active.settled = true;
      if (!this.closed) this._cancelApprovals(active);
      this.activeTurns.delete(normalized.threadId);
    }
  }

  // Cancellation ownership does not assert provider acceptance.
  pendingTurnForInterrupt({ threadId } = {}) {
    const active = this.activeTurns.get(threadId);
    if (this.closed || !active || active.settled) return null;
    return Object.freeze({ threadId, turnId: active.turnId });
  }

  async interrupt({ threadId, turnId }) {
    this._assertInitialized();
    const sessionId = validateThreadId(threadId);
    validateThreadId(turnId, 'turnId');
    const active = this.activeTurns.get(sessionId);
    if (!active || active.settled || active.turnId !== turnId) fail('ACP_TURN_UNKNOWN', 'ACP turn is not active');
    active.cancelled = true;
    this._write({ jsonrpc: '2.0', method: METHOD.sessionCancel, params: { sessionId } });
    this._cancelApprovals(active);
    return Object.freeze({ cancelled: true });
  }

  answerApproval(answer) {
    const normalized = validateApprovalAnswer(answer);
    const approval = this.approvals.get(normalized.approvalId);
    if (!approval || approval.active.cancelled || approval.active.settled ||
      this.activeTurns.get(approval.sessionId) !== approval.active) {
      fail('ACP_APPROVAL_UNKNOWN', 'Approval is not pending for this ACP adapter');
    }
    const result = permissionResponse(normalized.response, approval.optionIds);
    this.approvals.delete(normalized.approvalId);
    this.pendingApprovalRequests.delete(approval.rpcId);
    this._write({ jsonrpc: '2.0', id: approval.rpcId, result });
  }

  _cancelApprovals(active) {
    for (const [id, approval] of this.approvals) {
      if (approval.active !== active) continue;
      this.approvals.delete(id);
      this.pendingApprovalRequests.delete(approval.rpcId);
      this._write({ jsonrpc: '2.0', id: approval.rpcId, result: { outcome: { outcome: 'cancelled' } } });
    }
  }

  _retirePrompt(pending) {
    if (!pending.active) return;
    // Retire synchronously: another packet or UI click can arrive before
    // sendTurn's promise continuation runs, including in the same chunk.
    pending.active.settled = true;
    this._cancelApprovals(pending.active);
  }

  getUsage(threadId) {
    const usage = this.usage.get(validateThreadId(threadId));
    return usage ? deepFreeze(jsonData(usage, 'stored usage')) : null;
  }

  getSessionModes(threadId) {
    return this.sessionModes.get(validateThreadId(threadId)) || null;
  }

  async selectMode(threadId, modeId) {
    this._assertInitialized();
    const id = validateThreadId(threadId);
    if (typeof modeId !== 'string' || !modeId || modeId.length > 512) {
      fail('ACP_MODE_UNAVAILABLE', 'The requested mode must be a bounded advertised mode id.');
    }
    return this._withSessionSelection(id, async validate => {
      const modes = this.sessionModes.get(id);
      if (!modes?.availableModes?.some(mode => mode.id === modeId)) {
        fail('ACP_MODE_UNAVAILABLE', 'This session does not advertise the requested mode.');
      }
      if (modes.currentModeId === modeId) return modes;
      const response = await this._request('session/set_mode', { sessionId: id, modeId });
      validate();
      const fields = ownRecord(response, 'session/set_mode result', { allowed: ['_meta'] });
      if (Object.hasOwn(fields, '_meta')) jsonData(fields._meta.value, 'session/set_mode result._meta');
      const current = this.sessionModes.get(id);
      // An ACK confirms the request, but must never overwrite a newer
      // provider notification or a replacement session's advertisement.
      if (current !== modes) {
        if (current?.currentModeId === modeId && current.availableModes === modes.availableModes) return current;
        fail('ACP_MODE_SELECTION_UNCONFIRMED', 'The session mode changed while the request was pending.');
      }
      const confirmed = deepFreeze({ ...modes, currentModeId: modeId });
      this.sessionModes.set(id, confirmed);
      return confirmed;
    });
  }

  getSessionConfigOptions(threadId) {
    return this.sessionConfigOptions.get(validateThreadId(threadId)) || null;
  }

  getSessionModels(threadId) {
    return this.sessionModels.get(validateThreadId(threadId)) || null;
  }

  async selectModel(threadId, modelId) {
    this._assertInitialized();
    const id = validateThreadId(threadId);
    return this._withSessionSelection(id, async validate => {
      const option = this.sessionConfigOptions.get(id)?.find(item => item.category === 'model' || item.id === 'model');
      const models = this.sessionModels.get(id);
      if (option) {
        if (!option.options?.some(choice => choice.value === modelId)) fail('ACP_MODEL_UNAVAILABLE', 'This account does not advertise the requested model.');
        await this._selectConfig(id, option, modelId, 'MODEL', validate);
        validate();
      } else {
        if (!models?.availableModels.some(choice => choice.modelId === modelId)) fail('ACP_MODEL_UNAVAILABLE', 'This account does not advertise the requested model.');
        if (models.currentModelId !== modelId) {
          const response = await this._request(METHOD.sessionSetModel, { sessionId: id, modelId });
          validate();
          const fields = ownRecord(response, 'session/set_model result', { allowed: ['_meta'] });
          if (Object.hasOwn(fields, '_meta')) jsonData(fields._meta.value, 'session/set_model result._meta');
        }
        this.sessionModels.set(id, deepFreeze({ ...models, currentModelId: modelId }));
      }
      this.selectedModels.set(id, modelId);
      return modelId;
    });
  }

  async selectEffort(threadId, effort) {
    this._assertInitialized();
    const id = validateThreadId(threadId);
    return this._withSessionSelection(id, async validate => {
      const option = this.sessionConfigOptions.get(id)?.find(item => item.category === 'thought_level' || item.id === 'reasoning_effort');
      if (!option?.options?.some(choice => choice.value === effort)) fail('ACP_EFFORT_UNAVAILABLE', 'This model does not advertise the requested reasoning effort.');
      await this._selectConfig(id, option, effort, 'EFFORT', validate);
      validate();
      return effort;
    });
  }

  async _selectConfig(sessionId, option, value, kind, validate) {
    if (option.currentValue === value) return;
    const before = this.sessionConfigOptions.get(sessionId);
    const response = await this._request(METHOD.sessionSetConfigOption, { sessionId, configId: option.id, value });
    validate();
    const fields = ownRecord(response, 'session/set_config_option result', { allowed: ['configOptions', '_meta'] });
    const options = normalizeSessionConfigOptions(fields.configOptions?.value, 'session/set_config_option result.configOptions');
    if (options.find(item => item.id === option.id)?.currentValue !== value) {
      fail(`ACP_${kind}_SELECTION_UNCONFIRMED`, 'The assistant did not confirm the requested model setting.');
    }
    const current = this.sessionConfigOptions.get(sessionId);
    if (current !== before) {
      if (current?.find(item => item.id === option.id)?.currentValue === value) return;
      fail(`ACP_${kind}_SELECTION_UNCONFIRMED`, 'The session settings changed while the request was pending.');
    }
    this.sessionConfigOptions.set(sessionId, options);
  }

  _withSessionSelection(id, operation) {
    this._assertInitialized();
    const previous = this.sessionSelections.get(id);
    const identity = this.sessionIdentities.get(id);
    const transport = this.transport;
    const validate = () => {
      this._assertInitialized();
      if (this.sessionIdentities.get(id) !== identity || this.transport !== transport) {
        fail('ACP_SESSION_CHANGED', 'The ACP session changed while a setting was pending.');
      }
    };
    let resolve, reject;
    const selection = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Reserve before calling the operation: even a synchronous transport or
    // a second setting in this stack cannot start an overlapping mutation.
    this.sessionSelections.set(id, selection);
    const run = async () => {
      try {
        validate();
        if (this.activeTurns.has(id) || this.loadingSessions.has(id)) {
          fail('ACP_ADAPTER_BUSY', 'ACP session is active or loading.');
        }
        const result = await operation(validate);
        validate();
        return result;
      } finally {
        if (this.sessionSelections.get(id) === selection) this.sessionSelections.delete(id);
      }
    };
    if (previous) previous.catch(() => {}).then(run).then(resolve, reject);
    else run().then(resolve, reject);
    return selection;
  }

  async listModels() {
    const models = new Map();
    for (const [threadId, state] of this.sessionModels) {
      const options = this.sessionConfigOptions.get(threadId);
      const thought = options?.find(item => item.category === 'thought_level' || item.id === 'reasoning_effort');
      for (const model of state.availableModels) {
        const current = options?.find(item => item.category === 'model' || item.id === 'model')?.currentValue || state.currentModelId;
        const efforts = model._meta?.reasoningEfforts || (model.modelId === current ? thought?.options : []) || [];
        models.set(model.modelId, deepFreeze({ id: `${this.modelProvider}/${model.modelId}`,
          displayName: model.name || model.modelId, description: model.description || null, hidden: false,
          efforts: efforts.map(item => ({ id: item.value || item.id, description: item.description || item.name || item.label || '' })),
          defaultEffort: model._meta?.reasoningEffort || (model.modelId === current ? thought?.currentValue : null) || null }));
      }
    }
    return Object.freeze({ models: Object.freeze([...models.values()]) });
  }

  close() {
    if (this.closed) {
      // A failed protocol reader still owns its child until closure is proven.
      // Retry the retained handle; never rediscover a process by PID.
      if (this.closed.retryCleanup) this.closed.retryCleanup().catch(() => {});
      return;
    }
    for (const active of this.activeTurns.values()) {
      active.cancelled = true;
      try { this._cancelApprovals(active); }
      catch { break; /* A write failure has already failed closed and retained cleanup. */ }
    }
    // An explicit close owns the transport itself (openAcpSession closes it
    // straight after), so this path must not reach for the protocol kill.
    this._failClosed(new AcpAdapterError('ACP_ADAPTER_CLOSED', 'ACP adapter was closed'), { closeTransport: false });
  }

  _assertOpen() {
    if (this.closed) throw this.closed;
  }

  _assertInitialized() {
    this._assertOpen();
    if (!this.initialized) fail('ACP_NOT_INITIALIZED', 'ACP initialize must complete first');
  }

  _request(method, params) {
    this._assertOpen();
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      this.pending.set(id, { method, resolve, reject,
        ...(method === METHOD.sessionPrompt ? { active: this.activeTurns.get(params.sessionId) } : {}) });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _storeSessionResult(result) {
    this._assertOpen();
    this.sessionIdentities.set(result.threadId, {});
    if (!result.models) this.sessionModels.delete(result.threadId);
    if (!result.configOptions) this.sessionConfigOptions.delete(result.threadId);
    if (!result.modes) this.sessionModes.delete(result.threadId);
    if (result.models) this.sessionModels.set(result.threadId, sessionModels(result.models));
    if (result.modes) this.sessionModes.set(result.threadId, result.modes);
    if (result.configOptions) this.sessionConfigOptions.set(result.threadId, result.configOptions);
    return result;
  }

  _write(message) {
    this._assertOpen();
    if ([METHOD.sessionNew, METHOD.sessionLoad, METHOD.sessionFork].includes(message.method)) {
      message = { ...message, params: { ...message.params, mcpServers: this.mcpServers,
        ...(this.sessionMeta === null ? {} : { _meta: this.sessionMeta }) } };
    }
    let line;
    try { line = `${JSON.stringify(message)}\n`; } catch { fail('ACP_PROTOCOL_INVALID', 'ACP message could not be serialized'); }
    try { this.transport.write(line); } catch {
      this._failClosed(new AcpAdapterError('ACP_TRANSPORT_WRITE_FAILED', 'ACP transport write failed'));
      throw this.closed;
    }
  }

  _receive(chunk) {
    if (this.closed) return;
    try {
      if (Buffer.isBuffer(chunk)) chunk = chunk.toString('utf8');
      if (typeof chunk !== 'string') fail('ACP_PROTOCOL_INVALID', 'ACP transport emitted non-text data');
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE_BYTES) {
        fail('ACP_PROTOCOL_INVALID', 'ACP transport line exceeds the safety limit');
      }
      let newline;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, '');
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message;
        try { message = JSON.parse(line); } catch { fail('ACP_PROTOCOL_INVALID', 'ACP transport emitted malformed JSON'); }
        this._handleMessage(message);
      }
    } catch (error) {
      this._failClosed(error instanceof AcpAdapterError
        ? error : new AcpAdapterError('ACP_PROTOCOL_INVALID', 'ACP protocol handling failed'));
    }
  }

  _handleMessage(message) {
    const fields = ownRecord(message, 'ACP JSON-RPC message', {
      allowed: ['jsonrpc', 'id', 'method', 'params', 'result', 'error']
    });
    if (!Object.hasOwn(fields, 'jsonrpc') || fields.jsonrpc.value !== '2.0') {
      fail('ACP_PROTOCOL_INVALID', 'ACP JSON-RPC version must be 2.0');
    }
    const hasId = Object.hasOwn(fields, 'id');
    const hasMethod = Object.hasOwn(fields, 'method');
    const hasResult = Object.hasOwn(fields, 'result');
    const hasError = Object.hasOwn(fields, 'error');
    if (hasMethod && hasId && !hasResult && !hasError) return this._handleAgentRequest(fields);
    if (hasMethod && !hasId && !hasResult && !hasError) return this._handleNotification(fields);
    if (hasId && !hasMethod && (hasResult !== hasError)) return this._handleResponse(fields);
    fail('ACP_PROTOCOL_INVALID', 'ACP JSON-RPC message has an unsupported shape');
  }

  _handleResponse(fields) {
    const id = fields.id.value;
    if ((typeof id !== 'number' || !Number.isInteger(id)) && typeof id !== 'string') {
      fail('ACP_PROTOCOL_INVALID', 'ACP response id is invalid');
    }
    const pending = this.pending.get(id);
    if (!pending) fail('ACP_PROTOCOL_INVALID', 'ACP response did not match a pending request');
    if (Object.hasOwn(fields, 'error')) {
      // Retain the request until error validation succeeds. A malformed
      // response closes the reader and must reject this promise with the rest.
      const error = ownRecord(fields.error.value, 'ACP response error', { allowed: ['code', 'message', 'data'] });
      if (!Object.hasOwn(error, 'code') || !Number.isInteger(error.code.value)) {
        fail('ACP_PROTOCOL_INVALID', 'ACP response error code is invalid');
      }
      const providerMessage = requiredString(error, 'message', 'ACP response error', { allowEmpty: true, max: 32_768 });
      if (Object.hasOwn(error, 'data')) jsonData(error.data.value, 'ACP response error.data');
      this._retirePrompt(pending);
      this.pending.delete(id);
      if (/UNSUPPORTED_CLIENT|client is no longer supported.*Gemini Code Assist/i.test(providerMessage)) {
        const message = this.modelProvider === 'gemini' ? GEMINI_INDIVIDUAL_RETIREMENT_MESSAGE
          : 'The provider refused this assistant client. Check which clients your account supports before retrying.';
        pending.reject(new AcpAdapterError('ACP_CLIENT_UNSUPPORTED', message, { rpcCode: error.code.value }));
      } else if (error.code.value === -32000 && /project.?id|GOOGLE_CLOUD_PROJECT/i.test(providerMessage)) {
        pending.reject(new AcpAdapterError('ACP_PROJECT_REQUIRED', 'Gemini requires a Google Cloud project for this account. Complete its official setup before starting Research.', { rpcCode: error.code.value }));
      } else if (/quota|rate.limit|usage.limit|429/i.test(providerMessage)) {
        pending.reject(new AcpAdapterError('ACP_RATE_LIMITED', 'The assistant account has reached a provider usage limit.', { rpcCode: error.code.value }));
      } else if ([METHOD.sessionNew, METHOD.authenticate].includes(pending.method) && error.code.value === -32000) {
        pending.reject(new AcpAdapterError('ACP_AUTH_REQUIRED', 'ACP agent requires authentication', {
          rpcCode: error.code.value,
          authMethods: this.getAuthMethods()
        }));
      } else {
        pending.reject(new AcpAdapterError('ACP_REQUEST_FAILED', `ACP ${pending.method} failed`, { rpcCode: error.code.value }));
      }
      return;
    }
    this._retirePrompt(pending);
    this.pending.delete(id);
    pending.resolve(fields.result.value);
  }

  _handleAgentRequest(fields) {
    const method = requiredString(fields, 'method', 'ACP agent request', { max: 512 });
    if (method !== METHOD.sessionRequestPermission) {
      fail('ACP_PROTOCOL_UNSUPPORTED_REQUEST', `ACP agent requested unsupported host action ${method}`);
    }
    const rpcId = fields.id.value;
    if (!((typeof rpcId === 'number' && Number.isSafeInteger(rpcId)) ||
      (typeof rpcId === 'string' && rpcId.length > 0 && rpcId.length <= 512))) {
      fail('ACP_PROTOCOL_INVALID', 'ACP permission request id is invalid');
    }
    const parsed = normalizePermissionParams(Object.hasOwn(fields, 'params') ? fields.params.value : undefined);
    if (this.pendingApprovalRequests.has(rpcId)) fail('ACP_PROTOCOL_INVALID', 'ACP reused a pending permission id');
    const active = this.activeTurns.get(parsed.sessionId);
    if (!active || active.cancelled || active.settled) {
      this._write({ jsonrpc: '2.0', id: rpcId, result: { outcome: { outcome: 'cancelled' } } });
      return;
    }
    if (this.approvals.size >= 4096 || !Number.isSafeInteger(this.nextApprovalId)) {
      fail('ACP_PROTOCOL_INVALID', 'ACP has too many pending permission requests');
    }
    // Native request ids can be reused. A UI handle identifies this one
    // request across turns and adapter restarts, never a future request.
    const approvalId = `acp:permission:${this.turnIdToken}:${this.nextApprovalId++}`;
    this.approvals.set(approvalId, { rpcId, optionIds: parsed.optionIds, sessionId: parsed.sessionId, active });
    this.pendingApprovalRequests.add(rpcId);
    this._emit({
      type: 'approval_request',
      threadId: parsed.sessionId,
      turnId: active.turnId,
      itemId: parsed.toolCallId,
      toolCallId: parsed.toolCallId,
      approval: {
        approvalId,
        kind: 'tool_permission',
        details: { toolCall: parsed.toolCall },
        availableDecisions: parsed.options
      }
    });
  }

  _handleNotification(fields) {
    const method = requiredString(fields, 'method', 'ACP notification', { max: 512 });
    if (method !== METHOD.sessionUpdate) return;
    const params = ownRecord(Object.hasOwn(fields, 'params') ? fields.params.value : undefined, 'session/update params', {
      allowed: ['sessionId', 'update', '_meta']
    });
    const sessionId = requiredString(params, 'sessionId', 'session/update params', { max: 512 });
    if (Object.hasOwn(params, '_meta')) jsonData(params._meta.value, 'session/update params._meta');
    if (!Object.hasOwn(params, 'update')) fail('ACP_PROTOCOL_INVALID', 'session/update params is missing update');
    this._handleSessionUpdate(sessionId, params.update.value);
  }

  _handleSessionUpdate(sessionId, value) {
    const update = ownRecord(value, 'session/update update');
    if (Object.hasOwn(update, '_meta')) jsonData(update._meta.value, 'session/update update._meta');
    const kind = requiredString(update, 'sessionUpdate', 'session/update update', { max: 256 });
    const active = this.activeTurns.get(sessionId);
    if (kind === 'config_option_update') {
      const options = normalizeSessionConfigOptions(update.configOptions?.value, 'config_option_update.configOptions');
      const model = options.find(item => item.category === 'model' || item.id === 'model');
      if (this.selectedModels.has(sessionId) && model?.currentValue !== this.selectedModels.get(sessionId)) {
        fail('ACP_MODEL_SELECTION_UNCONFIRMED', 'The assistant changed away from the explicitly selected model.');
      }
      this.sessionConfigOptions.set(sessionId, options);
      return;
    }
    if (!active && this.loadingSessions.has(sessionId)) {
      // session/load replays history. The app already owns its conversation
      // log; do not re-emit historical calls as newly executing work. This
      // exemption applies only to bounded notifications during this load,
      // never permission requests or updates for another session.
      jsonData(value, 'session/load history');
      return;
    }
    if (kind === 'available_commands_update') {
      normalizeAvailableCommandsUpdate(value);
      return;
    }
    if (kind === 'agent_thought_chunk') {
      if (!active) fail('ACP_PROTOCOL_INVALID', 'ACP emitted thinking outside an active prompt');
      const thought = ownRecord(value, 'agent_thought_chunk', { allowed: ['sessionUpdate', 'content', 'messageId', '_meta'] });
      const messageId = optionalString(thought, 'messageId', 'agent_thought_chunk', { max: 1_024 });
      const content = ownRecord(thought.content?.value, 'agent_thought_chunk.content');
      // ACP exposes thought chunks as content. Display only explicit text;
      // resource, image and opaque fields cannot manufacture a summary.
      if (requiredString(content, 'type', 'agent_thought_chunk.content', { max: 128 }) !== 'text') return;
      const text = requiredString(content, 'text', 'agent_thought_chunk.content', { allowEmpty: true });
      if (!text) return;
      if (active.thinking && active.thinking.messageId !== messageId) this._finishThinking(sessionId, active);
      if (!active.thinking) active.thinking = { itemId: `acp-thinking-${active.turnId}-${++active.nextThinkingId}`, messageId, text: '', truncated: false };
      const held = active.thinking;
      const next = held.text + text;
      held.text = next.slice(0, 1_000_000);
      held.truncated ||= next.length > 1_000_000;
      this._emit({ type: 'thinking', threadId: sessionId, turnId: active.turnId, itemId: held.itemId, text: held.text,
        status: 'inProgress', ...(held.truncated ? { payload: { truncated: true } } : {}) });
      return;
    }
    if (active && ['agent_message_chunk', 'tool_call', 'tool_call_update'].includes(kind)) this._finishThinking(sessionId, active);
    if (kind === 'agent_message_chunk') {
      if (!active) fail('ACP_PROTOCOL_INVALID', 'ACP emitted assistant text outside an active prompt');
      const messageUpdate = ownRecord(value, 'agent_message_chunk', {
        allowed: ['sessionUpdate', 'content', 'messageId', '_meta']
      });
      if (requiredString(messageUpdate, 'sessionUpdate', 'agent_message_chunk', { max: 256 }) !== 'agent_message_chunk') {
        fail('ACP_PROTOCOL_INVALID', 'agent_message_chunk has an invalid sessionUpdate discriminator');
      }
      optionalString(messageUpdate, 'messageId', 'agent_message_chunk', { max: 1_024 });
      const content = ownRecord(
        Object.hasOwn(messageUpdate, 'content') ? messageUpdate.content.value : undefined,
        'agent_message_chunk.content', {
        allowed: ['type', 'text', 'annotations', '_meta']
        }
      );
      if (requiredString(content, 'type', 'agent_message_chunk.content', { max: 128 }) !== 'text') {
        fail('ACP_PROTOCOL_INVALID', 'ACP emitted unsupported assistant content');
      }
      const text = requiredString(content, 'text', 'agent_message_chunk.content', { allowEmpty: true });
      if (Object.hasOwn(content, 'annotations')) jsonData(content.annotations.value, 'agent_message_chunk.content.annotations');
      if (Object.hasOwn(content, '_meta')) jsonData(content._meta.value, 'agent_message_chunk.content._meta');
      active.assistantParts.push(text);
      this._emit({
        type: 'assistant_text_delta', threadId: sessionId, turnId: active.turnId,
        itemId: active.assistantItemId, text
      });
      return;
    }
    if (kind === 'tool_call') {
      if (!active) fail('ACP_PROTOCOL_INVALID', 'ACP emitted a tool call outside an active prompt');
      const toolCallId = requiredString(update, 'toolCallId', 'tool_call update', { max: 1_024 });
      if (active.toolCalls.has(toolCallId)) fail('ACP_PROTOCOL_INVALID', 'ACP reused a tool call id');
      const title = requiredString(update, 'title', 'tool_call update', { max: 32_768 });
      const tool = optionalString(update, 'kind', 'tool_call update', { max: 512 }) || title;
      const payload = this._toolUpdatePayload(update);
      active.toolCalls.set(toolCallId, { tool, terminal: false });
      this._emit({ type: 'tool_call', threadId: sessionId, turnId: active.turnId, itemId: toolCallId, toolCallId, tool, payload });
      if (Object.hasOwn(update, 'status') && TERMINAL_TOOL_STATUSES.includes(update.status.value)) {
        active.toolCalls.get(toolCallId).terminal = true;
        this._emit({ type: 'tool_result', threadId: sessionId, turnId: active.turnId, itemId: toolCallId, toolCallId, tool, payload });
      }
      return;
    }
    if (kind === 'tool_call_update') {
      if (!active) fail('ACP_PROTOCOL_INVALID', 'ACP emitted a tool update outside an active prompt');
      const toolCallId = requiredString(update, 'toolCallId', 'tool_call_update', { max: 1_024 });
      const toolCall = active.toolCalls.get(toolCallId);
      if (!toolCall) fail('ACP_PROTOCOL_INVALID', 'ACP updated an unknown tool call');
      const status = optionalString(update, 'status', 'tool_call_update', { max: 256 });
      if (status && TERMINAL_TOOL_STATUSES.includes(status) && !toolCall.terminal) {
        toolCall.terminal = true;
        this._emit({
          type: 'tool_result', threadId: sessionId, turnId: active.turnId,
          itemId: toolCallId, toolCallId, tool: toolCall.tool, payload: this._toolUpdatePayload(update)
        });
      }
      return;
    }
    if (kind === 'usage_update') {
      if (!active) fail('ACP_PROTOCOL_INVALID', 'ACP emitted usage outside an active prompt');
      this._recordUsage(sessionId, active.turnId, normalizeUsageUpdate(value));
      return;
    }
    if (kind === 'current_mode_update') {
      const modeUpdate = ownRecord(value, 'current_mode_update', {
        allowed: ['sessionUpdate', 'currentModeId', '_meta']
      });
      const currentModeId = requiredString(modeUpdate, 'currentModeId', 'current_mode_update', { max: 512 });
      if (Object.hasOwn(modeUpdate, '_meta')) jsonData(modeUpdate._meta.value, 'current_mode_update._meta');
      const modes = this.sessionModes.get(sessionId);
      if (!modes) fail('ACP_PROTOCOL_INVALID', 'ACP updated modes for a session without advertised modes');
      if (!modes.availableModes?.some(mode => mode.id === currentModeId)) {
        fail('ACP_PROTOCOL_INVALID', 'ACP selected a mode it did not advertise');
      }
      this.sessionModes.set(sessionId, deepFreeze({ currentModeId, availableModes: modes.availableModes }));
      return;
    }
    // Other session/update variants carry display state, not host authority.
  }

  _finishThinking(sessionId, active) {
    const held = active.thinking;
    if (!held) return;
    active.thinking = null;
    this._emit({ type: 'thinking', threadId: sessionId, turnId: active.turnId, itemId: held.itemId, text: held.text,
      ...(held.truncated ? { payload: { truncated: true } } : {}) });
  }

  _toolUpdatePayload(fields) {
    const payload = {};
    for (const key of ['title', 'kind', 'status', 'rawInput', 'rawOutput', 'content', 'locations']) {
      if (Object.hasOwn(fields, key)) payload[key] = jsonData(fields[key].value, `tool update.${key}`);
    }
    return payload;
  }

  _recordUsage(threadId, turnId, value) {
    const usage = deepFreeze(jsonData(value, 'ACP usage'));
    this.usage.set(threadId, usage);
    this._emit({ type: 'usage', threadId, turnId, usage });
  }

  _emit(event) {
    const normalized = validateEngineEvent(event);
    for (const listener of this.listeners) {
      try { listener(normalized); } catch { /* Host listener errors cannot corrupt the protocol session. */ }
    }
  }

  _failClosed(error, { closeTransport = true } = {}) {
    if (this.closed) return;
    this.closed = error instanceof AcpAdapterError
      ? error : new AcpAdapterError('ACP_PROTOCOL_INVALID', 'ACP protocol failed closed');
    if (this.unsubscribe) {
      try { this.unsubscribe(); } catch { /* Transport cleanup is best effort. */ }
    }
    for (const pending of this.pending.values()) pending.reject(this.closed);
    this.pending.clear();
    this.approvals.clear();
    this.pendingApprovalRequests.clear();
    this.activeTurns.clear();
    /* A POISONED READER STILL OWNS ITS CHILD. Unsubscribing only stops this
       adapter from listening: the agent process kept running, the host was
       never told the session had ended, and every send refused against a
       session that still looked ready. Closing the transport is what makes the
       process actually complete, which is the completion the host observes.
       A pure wire transport has no child to close. */
    if (!closeTransport || typeof this.transport.closeForProtocolFailure !== 'function') return;
    let inFlight = null;
    let proven = false;
    const retryCleanup = () => {
      if (proven) return Promise.resolve();
      if (!inFlight) {
        inFlight = Promise.resolve()
          .then(() => this.transport.closeForProtocolFailure())
          .then(() => { proven = true; })
          .finally(() => { inFlight = null; });
      }
      return inFlight;
    };
    // On refusal the same retry handle stays on the error. No closure outcome
    // is inferred from a kill request that was never confirmed.
    Object.defineProperty(this.closed, 'retryCleanup', { value: retryCleanup });
    retryCleanup().catch(() => {});
  }
}

function createAcpAdapter(options) {
  return new AcpAdapter(options);
}

module.exports = {
  ACP_PROTOCOL_VERSION,
  METHOD,
  GEMINI_INDIVIDUAL_RETIREMENT_MESSAGE,
  AcpAdapter,
  AcpAdapterError,
  createAcpAdapter
};
