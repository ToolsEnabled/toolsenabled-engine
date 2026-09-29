'use strict';

// Q67 worker contract for the future online Full Remote maintenance tier.
// This is an authorization-only module.  It never chooses an executable,
// builds a shell command, reads a path, starts a process, opens a socket, or
// reads a credential.  The eventual broker must map these fixed command IDs to
// reviewed in-process handlers under its separate non-admin service account.

const CONTRACT_VERSION = 'online-maintenance-contract.v1';
const PROFILE_ID = 'online-full-remote.v1';
const CREDENTIAL_DOMAIN = 'online-full-remote-credential.v1';
const SERVICE_ACCOUNT = 'toolsenabled-online-maintenance';
const MAX_SESSION_COMMANDS = 32;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 200_000;
const SERVICE_IDS = Object.freeze(['api', 'backup', 'web', 'worker']);

const ROOTS = Object.freeze([
  Object.freeze({ rootId: 'service-state', mode: 'read-only' }),
  Object.freeze({ rootId: 'backup-state', mode: 'read-only' })
]);

const COMMANDS = Object.freeze([
  Object.freeze({ commandId: 'backup.manifest', rootId: 'backup-state', argumentShape: 'relative-json-path', maxTimeoutMs: 10_000, maxOutputBytes: 64 * 1024 }),
  Object.freeze({ commandId: 'health.snapshot', rootId: 'service-state', argumentShape: 'none', maxTimeoutMs: 10_000, maxOutputBytes: 64 * 1024 }),
  Object.freeze({ commandId: 'runtime.version', rootId: 'service-state', argumentShape: 'none', maxTimeoutMs: 10_000, maxOutputBytes: 16 * 1024 }),
  Object.freeze({ commandId: 'service.status', rootId: 'service-state', argumentShape: 'service-id', maxTimeoutMs: 10_000, maxOutputBytes: 64 * 1024 })
]);

const PROFILE_KEYS = Object.freeze([
  'auditRequired',
  'commandAllowlist',
  'credentialDomain',
  'defaultOff',
  'identityGeneration',
  'killSwitchRequired',
  'maxCommandTimeoutMs',
  'maxOutputBytes',
  'maxSessionCommands',
  'noClipboard',
  'noOcr',
  'noOwnerProfile',
  'noRoot',
  'noScreen',
  'noShell',
  'noSudo',
  'noVault',
  'nonAdmin',
  'profileId',
  'schemaVersion',
  'serviceAccount',
  'workingRoots'
]);

const IDENTITY_KEYS = Object.freeze(['credentialDomain', 'generation', 'identityId', 'nonAdmin', 'serviceAccount']);
const REQUEST_KEYS = Object.freeze([
  'args',
  'commandId',
  'identity',
  'killSwitchActive',
  'profile',
  'profileEnabled',
  'requestedOutputBytes',
  'requestedTimeoutMs',
  'revokedIdentityIds',
  'sessionCommandIndex'
]);

class OnlineMaintenanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OnlineMaintenanceError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new OnlineMaintenanceError(code, message);
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('ONLINE_MAINTENANCE_INVALID_SHAPE', `${label} must be a plain record.`);
  }
  return value;
}

function exact(value, keys, label) {
  const source = plain(value, label);
  const actual = Reflect.ownKeys(source);
  const expected = [...keys];
  if (actual.some(key => typeof key !== 'string') || actual.length !== expected.length
    || actual.some(key => !expected.includes(key))) {
    fail('ONLINE_MAINTENANCE_INVALID_SHAPE', `${label} fields do not match the required shape.`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('ONLINE_MAINTENANCE_INVALID_SHAPE', `${label} fields must be enumerable data properties.`);
    }
  }
  return source;
}

function safeString(value, label, pattern, max = 160) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max
    || /[\x00-\x1f\x7f]/.test(value) || (pattern && !pattern.test(value))) {
    fail('ONLINE_MAINTENANCE_INVALID_VALUE', `${label} has an invalid shape.`);
  }
  return value;
}

function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('ONLINE_MAINTENANCE_INVALID_VALUE', `${label} must be a safe integer in the permitted range.`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') fail('ONLINE_MAINTENANCE_INVALID_VALUE', `${label} must be boolean.`);
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateIdentityId(value) {
  return safeString(value, 'identity.identityId', /^online-id_[A-Za-z0-9_-]{8,120}$/, 130);
}

function validateRelativeJsonPath(value) {
  const path = safeString(value, 'args.relativePath', /^[A-Za-z0-9][A-Za-z0-9._/-]{0,179}$/, 180);
  if (path.startsWith('/') || path.includes('\\') || path.includes('//')) {
    fail('ONLINE_MAINTENANCE_PATH_DENIED', 'relativePath is not a normalized relative path.');
  }
  const parts = path.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.includes(':')) || !path.endsWith('.json')) {
    fail('ONLINE_MAINTENANCE_PATH_DENIED', 'relativePath escapes the fixed JSON maintenance surface.');
  }
  return path;
}

function commandRecord(value, index) {
  const source = exact(value, ['argumentShape', 'commandId', 'maxOutputBytes', 'maxTimeoutMs', 'rootId'], `commandAllowlist[${index}]`);
  const commandId = safeString(source.commandId, `commandAllowlist[${index}].commandId`, /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/, 80);
  if (commandId.includes('*')) fail('ONLINE_MAINTENANCE_ALLOWLIST_INVALID', 'wildcard command IDs are forbidden.');
  const expected = COMMANDS.find(item => item.commandId === commandId);
  if (!expected || source.rootId !== expected.rootId || source.argumentShape !== expected.argumentShape
    || source.maxTimeoutMs !== expected.maxTimeoutMs || source.maxOutputBytes !== expected.maxOutputBytes) {
    fail('ONLINE_MAINTENANCE_ALLOWLIST_INVALID', 'commandAllowlist differs from the fixed command contract.');
  }
  return Object.freeze({ ...expected });
}

function validateProfile(profile) {
  const source = exact(profile, PROFILE_KEYS, 'online maintenance profile');
  if (source.schemaVersion !== CONTRACT_VERSION || source.profileId !== PROFILE_ID
    || source.credentialDomain !== CREDENTIAL_DOMAIN || source.serviceAccount !== SERVICE_ACCOUNT) {
    fail('ONLINE_MAINTENANCE_PROFILE_UNSUPPORTED', 'online maintenance profile identity is unsupported.');
  }
  integer(source.identityGeneration, 'profile.identityGeneration');
  if (source.nonAdmin !== true || source.defaultOff !== true || source.noShell !== true || source.noSudo !== true
    || source.noRoot !== true || source.noVault !== true || source.noOwnerProfile !== true || source.noScreen !== true
    || source.noClipboard !== true || source.noOcr !== true || source.killSwitchRequired !== true || source.auditRequired !== true) {
    fail('ONLINE_MAINTENANCE_PROFILE_UNSAFE', 'online maintenance profile does not enforce the non-admin boundary.');
  }
  if (source.maxSessionCommands !== MAX_SESSION_COMMANDS || source.maxCommandTimeoutMs !== MAX_COMMAND_TIMEOUT_MS
    || source.maxOutputBytes !== MAX_OUTPUT_BYTES) {
    fail('ONLINE_MAINTENANCE_PROFILE_UNSAFE', 'online maintenance bounds differ from the fixed contract.');
  }
  if (!Array.isArray(source.workingRoots) || source.workingRoots.length !== ROOTS.length) {
    fail('ONLINE_MAINTENANCE_PROFILE_UNSAFE', 'online maintenance working roots are invalid.');
  }
  const roots = source.workingRoots.map((value, index) => {
    const item = exact(value, ['mode', 'rootId'], `workingRoots[${index}]`);
    const expected = ROOTS[index];
    if (item.rootId !== expected.rootId || item.mode !== expected.mode) fail('ONLINE_MAINTENANCE_PROFILE_UNSAFE', 'working roots differ from the fixed read-only roots.');
    return Object.freeze({ ...expected });
  });
  if (!Array.isArray(source.commandAllowlist) || source.commandAllowlist.length !== COMMANDS.length) {
    fail('ONLINE_MAINTENANCE_ALLOWLIST_INVALID', 'online maintenance command allowlist has the wrong size.');
  }
  const commands = source.commandAllowlist.map(commandRecord);
  if (new Set(commands.map(item => item.commandId)).size !== commands.length
    || commands.map(item => item.commandId).sort().join(',') !== COMMANDS.map(item => item.commandId).sort().join(',')) {
    fail('ONLINE_MAINTENANCE_ALLOWLIST_INVALID', 'online maintenance command allowlist is not exact.');
  }
  return deepFreeze({ ...source, workingRoots: roots, commandAllowlist: commands });
}

function createOnlineMaintenanceProfile({ identityGeneration } = {}) {
  integer(identityGeneration, 'identityGeneration');
  return validateProfile({
    schemaVersion: CONTRACT_VERSION,
    profileId: PROFILE_ID,
    credentialDomain: CREDENTIAL_DOMAIN,
    serviceAccount: SERVICE_ACCOUNT,
    nonAdmin: true,
    defaultOff: true,
    identityGeneration,
    workingRoots: ROOTS.map(value => ({ ...value })),
    commandAllowlist: COMMANDS.map(value => ({ ...value })),
    maxSessionCommands: MAX_SESSION_COMMANDS,
    maxCommandTimeoutMs: MAX_COMMAND_TIMEOUT_MS,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    noShell: true,
    noSudo: true,
    noRoot: true,
    noVault: true,
    noOwnerProfile: true,
    noScreen: true,
    noClipboard: true,
    noOcr: true,
    killSwitchRequired: true,
    auditRequired: true
  });
}

function validateIdentity(identity) {
  const source = exact(identity, IDENTITY_KEYS, 'online maintenance identity');
  if (source.credentialDomain !== CREDENTIAL_DOMAIN || source.serviceAccount !== SERVICE_ACCOUNT || source.nonAdmin !== true) {
    fail('ONLINE_MAINTENANCE_IDENTITY_DENIED', 'identity is not the separate non-admin online maintenance identity.');
  }
  return Object.freeze({
    credentialDomain: source.credentialDomain,
    generation: integer(source.generation, 'identity.generation'),
    identityId: validateIdentityId(source.identityId),
    nonAdmin: true,
    serviceAccount: source.serviceAccount
  });
}

function validateArguments(command, args) {
  if (command.argumentShape === 'none') {
    exact(args, [], `args for ${command.commandId}`);
    return Object.freeze({});
  }
  if (command.argumentShape === 'service-id') {
    const source = exact(args, ['serviceId'], `args for ${command.commandId}`);
    if (!SERVICE_IDS.includes(source.serviceId)) fail('ONLINE_MAINTENANCE_ARGUMENT_DENIED', 'serviceId is not in the fixed service set.');
    return Object.freeze({ serviceId: source.serviceId });
  }
  if (command.argumentShape === 'relative-json-path') {
    const source = exact(args, ['relativePath'], `args for ${command.commandId}`);
    return Object.freeze({ relativePath: validateRelativeJsonPath(source.relativePath) });
  }
  fail('ONLINE_MAINTENANCE_ALLOWLIST_INVALID', 'command argument shape is unsupported.');
}

function authorizeOnlineMaintenanceCommand(input) {
  const source = exact(input, REQUEST_KEYS, 'online maintenance request');
  const profile = validateProfile(source.profile);
  if (source.profileEnabled !== true) fail('ONLINE_MAINTENANCE_PROFILE_DISABLED', 'online maintenance profile is disabled by default.');
  if (source.killSwitchActive !== false) {
    if (source.killSwitchActive === true) fail('ONLINE_MAINTENANCE_KILLSWITCH_ACTIVE', 'online maintenance is disabled by the kill switch.');
    fail('ONLINE_MAINTENANCE_KILLSWITCH_UNKNOWN', 'online maintenance kill-switch state is unavailable.');
  }
  const identity = validateIdentity(source.identity);
  if (identity.generation !== profile.identityGeneration) fail('ONLINE_MAINTENANCE_IDENTITY_STALE', 'maintenance identity generation is stale.');
  if (!Array.isArray(source.revokedIdentityIds) || source.revokedIdentityIds.length > 128
    || source.revokedIdentityIds.some(value => !/^online-id_[A-Za-z0-9_-]{8,120}$/.test(value))
    || new Set(source.revokedIdentityIds).size !== source.revokedIdentityIds.length) {
    fail('ONLINE_MAINTENANCE_REVOCATION_INVALID', 'revoked identity state is malformed.');
  }
  if (source.revokedIdentityIds.includes(identity.identityId)) fail('ONLINE_MAINTENANCE_IDENTITY_REVOKED', 'maintenance identity has been revoked.');
  const commandId = safeString(source.commandId, 'commandId', /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/, 80);
  const command = profile.commandAllowlist.find(item => item.commandId === commandId);
  if (!command) fail('ONLINE_MAINTENANCE_COMMAND_DENIED', 'command is not in the fixed online maintenance allowlist.');
  const args = validateArguments(command, source.args);
  integer(source.requestedTimeoutMs, 'requestedTimeoutMs', 1, command.maxTimeoutMs);
  integer(source.requestedOutputBytes, 'requestedOutputBytes', 1, command.maxOutputBytes);
  const sessionCommandIndex = integer(source.sessionCommandIndex, 'sessionCommandIndex', 0, MAX_SESSION_COMMANDS - 1);
  return deepFreeze({
    schemaVersion: CONTRACT_VERSION,
    status: 'authorized',
    profileId: profile.profileId,
    identityId: identity.identityId,
    identityGeneration: identity.generation,
    credentialDomain: identity.credentialDomain,
    serviceAccount: identity.serviceAccount,
    commandId: command.commandId,
    rootId: command.rootId,
    args,
    timeoutMs: source.requestedTimeoutMs,
    maxOutputBytes: source.requestedOutputBytes,
    sessionCommandIndex,
    remainingSessionCommands: MAX_SESSION_COMMANDS - sessionCommandIndex - 1,
    readOnly: true,
    shell: false,
    elevated: false,
    allowSudo: false,
    grantsVault: false,
    grantsOwnerProfile: false,
    grantsScreen: false,
    grantsClipboard: false,
    grantsOcr: false,
    killSwitchRequired: true,
    auditRequired: true,
    grantsAuthority: false
  });
}

module.exports = Object.freeze({
  COMMANDS,
  CONTRACT_VERSION,
  CREDENTIAL_DOMAIN,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_SESSION_COMMANDS,
  OnlineMaintenanceError,
  PROFILE_ID,
  ROOTS,
  SERVICE_ACCOUNT,
  SERVICE_IDS,
  authorizeOnlineMaintenanceCommand,
  createOnlineMaintenanceProfile,
  validateProfile
});
