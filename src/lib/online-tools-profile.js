'use strict';

// Q67's online ToolsEnabled profile is deliberately a closed contract. It is
// neither the local readonly profile nor either direct-link profile: remote
// ToolsEnabled access must opt into one explicit tier and one reviewed tool.
// This module accepts its catalogue and every volatile security source by
// injection, so it has no dependency on the live registry, audit, transport,
// vault, or network.

const PROFILE_ID = 'online-tools-profile.v1';
const CREDENTIAL_DOMAIN = 'online-tools-credential.v1';
const AUTHORIZATION_VERSION = 'online-tools-authorization.v1';
const TOOLS_TIER = 'toolsenabled';
const REMOTE_TIERS = Object.freeze(['tunnel', TOOLS_TIER, 'full-remote']);
const MAX_REVOKED_LEASES = 128;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1000;

const ONLINE_TOOLS = Object.freeze([
  'audit.status',
  'audit.tail',
  'code.diagnostics',
  'code.document_symbols',
  'code.find_references',
  'code.goto_definition',
  'code.hover',
  'code.status',
  'code.workspace_symbols',
  'memory.get',
  'memory.search',
  'overnight_advisory.lifecycle_status',
  'overnight_advisory.list',
  'overnight_advisory.status',
  'research.local_tiers_status',
  'sandbox.auth_profile_status',
  'sandbox.doctor',
  'sandbox.status',
  'search.query',
  'search.status',
  'system.doctor',
  'system.kill_switch_status',
  'system.status',
  'task.get',
  'task.list'
].sort());

const FORBIDDEN_NAMESPACES = new Set([
  'browser', 'chrome', 'clipboard', 'email',
  'gcloud', 'github', 'gmail', 'host', 'ocr', 'outlook', 'screen', 'shell',
  'slack', 'stripe', 'telegram', 'vault', 'window'
]);

const FORBIDDEN_ACTION_PARTS = new Set([
  'account_login', 'browser', 'clipboard', 'credential', 'exec', 'login',
  'ocr', 'password', 'prompt', 'screen', 'secret', 'shell', 'token', 'vault'
]);

const TOOL_NAME_RE = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/;
const IDENTITY_ID_RE = /^online-tools-id_[A-Za-z0-9_-]{8,120}$/;
const LEASE_ID_RE = /^online-tools-lease_[A-Za-z0-9_-]{8,120}$/;
const SESSION_ID_RE = /^online-tools-session-[1-9][0-9]*$/;

const PROFILE_KEYS = Object.freeze([
  'allowlist', 'auditRequired', 'credentialDomain', 'defaultOff',
  'fixedExplicit', 'identityGeneration', 'killSwitchRequired', 'profileId',
  'readOnlyIntent', 'tier', 'tools'
]);
const LEASE_KEYS = Object.freeze([
  'credentialDomain', 'expiresAtMs', 'generation', 'identityId', 'issuedAtMs',
  'leaseId', 'tiers'
]);
const AUTHORIZATION_KEYS = Object.freeze([
  'catalogue', 'killSwitchActive', 'lease', 'now', 'profile', 'profileEnabled',
  'revokedLeaseIds', 'tier'
]);
const INVOCATION_KEYS = Object.freeze([...AUTHORIZATION_KEYS, 'toolName']);
const OPEN_KEYS = Object.freeze(['lease', 'tier']);

function profileError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze({ ...details });
  return error;
}

function plainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw profileError('ONLINE_PROFILE_INVALID_SHAPE', `${label} must be a plain record.`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const source = plainRecord(value, label);
  const actual = Reflect.ownKeys(source);
  if (actual.some(key => typeof key !== 'string') || actual.length !== keys.length
    || actual.some(key => !keys.includes(key))) {
    throw profileError('ONLINE_PROFILE_INVALID_SHAPE', `${label} fields do not match the required shape.`);
  }
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw profileError('ONLINE_PROFILE_INVALID_SHAPE', `${label} fields must be enumerable data properties.`);
    }
  }
  return source;
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw profileError('ONLINE_PROFILE_INVALID_VALUE', `${label} must be a non-negative safe integer.`);
  }
  return value;
}

function requireFunction(value, label) {
  if (typeof value !== 'function') {
    throw profileError('ONLINE_PROFILE_DEPENDENCY_INVALID', `${label} must be a function.`);
  }
  return value;
}

function assertSafeToolName(name) {
  if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
    throw profileError('ONLINE_PROFILE_TOOL_NAME_INVALID', 'Online profile tool names must be explicit namespace.tool strings.', { name });
  }
  const [namespace, action] = name.split('.');
  if (FORBIDDEN_NAMESPACES.has(namespace) || [...FORBIDDEN_ACTION_PARTS].some(part => action.includes(part))) {
    throw profileError('ONLINE_PROFILE_TOOL_FORBIDDEN', 'The online profile cannot contain a shell, credential, browser, desktop-observation, or provider-control tool.', { name });
  }
  return true;
}

function assertCanonicalProfile() {
  const seen = new Set();
  for (const name of ONLINE_TOOLS) {
    assertSafeToolName(name);
    if (seen.has(name)) throw profileError('ONLINE_PROFILE_DUPLICATE', 'The online profile contains a duplicate tool.', { name });
    seen.add(name);
  }
  if (ONLINE_TOOLS.some(name => name.includes('*') || name.includes(','))) {
    throw profileError('ONLINE_PROFILE_NOT_EXPLICIT', 'The online profile must not contain wildcard or compound selectors.');
  }
  return true;
}

function registryEntries(catalogue) {
  if (!Array.isArray(catalogue)) {
    throw profileError('ONLINE_PROFILE_REGISTRY_INVALID', 'An injected tool catalogue array is required.');
  }
  const entries = new Map();
  for (const entry of catalogue) {
    if (!entry || typeof entry.name !== 'string') {
      throw profileError('ONLINE_PROFILE_REGISTRY_INVALID', 'Every tool catalogue entry must expose a string name.');
    }
    if (entries.has(entry.name)) {
      throw profileError('ONLINE_PROFILE_REGISTRY_DUPLICATE', 'The injected tool catalogue contains duplicate names.', { name: entry.name });
    }
    entries.set(entry.name, entry);
  }
  return entries;
}

function validateExplicitTools(tools) {
  if (!Array.isArray(tools) || tools.some(name => typeof name !== 'string')
    || new Set(tools).size !== tools.length || tools.some(name => !ONLINE_TOOLS.includes(name))
    || tools.some((name, index) => index > 0 && tools[index - 1] >= name)) {
    throw profileError('ONLINE_PROFILE_NOT_EXPLICIT', 'The online ToolsEnabled profile must contain a sorted unique subset of the reviewed explicit allowlist.');
  }
  for (const name of tools) assertSafeToolName(name);
  return Object.freeze([...tools]);
}

function buildOnlineToolsAllowlist(catalogue, tools = ONLINE_TOOLS) {
  assertCanonicalProfile();
  const safeTools = validateExplicitTools(tools);
  const entries = registryEntries(catalogue);
  const missing = safeTools.filter(name => !entries.has(name));
  if (missing.length) {
    throw profileError('ONLINE_PROFILE_REGISTRY_GAP', 'The explicit online profile is not fully present in the injected tool catalogue.', { missing });
  }
  const unsafe = safeTools.filter(name => {
    const entry = entries.get(name);
    return entry.effect !== 'local-read' || entry.annotations?.readOnlyHint !== true
      || entry.annotations?.destructiveHint !== false || entry.annotations?.openWorldHint !== false;
  });
  if (unsafe.length) {
    throw profileError('ONLINE_PROFILE_REGISTRY_UNSAFE', 'An explicit online tool no longer satisfies the closed local-read contract.', { unsafe });
  }
  return safeTools.join(',');
}

function validateOnlineToolsProfile(profile, catalogue) {
  const source = exactKeys(profile, PROFILE_KEYS, 'online ToolsEnabled profile');
  if (source.profileId !== PROFILE_ID || source.credentialDomain !== CREDENTIAL_DOMAIN
    || source.defaultOff !== true || source.fixedExplicit !== true || source.readOnlyIntent !== true
    || source.killSwitchRequired !== true || source.auditRequired !== true || source.tier !== TOOLS_TIER) {
    throw profileError('ONLINE_PROFILE_UNSAFE', 'The online ToolsEnabled profile does not enforce the fixed safety boundary.');
  }
  const identityGeneration = integer(source.identityGeneration, 'profile.identityGeneration');
  const tools = validateExplicitTools(source.tools);
  if (source.allowlist !== tools.join(',')) {
    throw profileError('ONLINE_PROFILE_NOT_EXPLICIT', 'The online ToolsEnabled profile allowlist does not match its explicit tools.');
  }
  if (catalogue !== undefined) buildOnlineToolsAllowlist(catalogue, tools);
  return Object.freeze({ ...source, identityGeneration, tools });
}

function createOnlineToolsProfile(catalogue, { identityGeneration } = {}) {
  const allowlist = buildOnlineToolsAllowlist(catalogue);
  return validateOnlineToolsProfile({
    profileId: PROFILE_ID,
    credentialDomain: CREDENTIAL_DOMAIN,
    identityGeneration: integer(identityGeneration, 'identityGeneration'),
    defaultOff: true,
    fixedExplicit: true,
    readOnlyIntent: true,
    killSwitchRequired: true,
    auditRequired: true,
    tier: TOOLS_TIER,
    tools: ONLINE_TOOLS,
    allowlist
  }, catalogue);
}

function validateLease(lease) {
  const source = exactKeys(lease, LEASE_KEYS, 'online ToolsEnabled lease');
  if (source.credentialDomain !== CREDENTIAL_DOMAIN || typeof source.identityId !== 'string'
    || !IDENTITY_ID_RE.test(source.identityId) || typeof source.leaseId !== 'string' || !LEASE_ID_RE.test(source.leaseId)) {
    throw profileError('ONLINE_PROFILE_LEASE_DENIED', 'The online ToolsEnabled lease is outside the fixed credential domain.');
  }
  const generation = integer(source.generation, 'lease.generation');
  const issuedAtMs = integer(source.issuedAtMs, 'lease.issuedAtMs');
  const expiresAtMs = integer(source.expiresAtMs, 'lease.expiresAtMs');
  if (expiresAtMs <= issuedAtMs || expiresAtMs - issuedAtMs > MAX_LEASE_TTL_MS) {
    throw profileError('ONLINE_PROFILE_LEASE_INVALID', 'The online ToolsEnabled lease lifetime is outside the permitted range.');
  }
  if (!Array.isArray(source.tiers) || source.tiers.length === 0 || source.tiers.length > REMOTE_TIERS.length
    || source.tiers.some(tier => typeof tier !== 'string' || !REMOTE_TIERS.includes(tier))
    || new Set(source.tiers).size !== source.tiers.length) {
    throw profileError('ONLINE_PROFILE_LEASE_INVALID', 'The online ToolsEnabled lease tier memberships are invalid.');
  }
  return Object.freeze({ ...source, generation, issuedAtMs, expiresAtMs, tiers: Object.freeze([...source.tiers]) });
}

function validateRevocations(revokedLeaseIds) {
  if (!Array.isArray(revokedLeaseIds) || revokedLeaseIds.length > MAX_REVOKED_LEASES
    || revokedLeaseIds.some(value => typeof value !== 'string' || !LEASE_ID_RE.test(value))
    || new Set(revokedLeaseIds).size !== revokedLeaseIds.length) {
    throw profileError('ONLINE_PROFILE_REVOCATION_INVALID', 'The online ToolsEnabled revocation state is malformed.');
  }
  return Object.freeze([...revokedLeaseIds]);
}

function authorizeOnlineToolsProfile(input) {
  const source = exactKeys(input, AUTHORIZATION_KEYS, 'online ToolsEnabled authorization');
  const profile = validateOnlineToolsProfile(source.profile, source.catalogue);
  if (source.profileEnabled !== true) {
    throw profileError('ONLINE_PROFILE_DISABLED', 'The online ToolsEnabled profile is disabled by default.');
  }
  if (source.killSwitchActive !== false) {
    throw profileError(source.killSwitchActive === true ? 'ONLINE_PROFILE_KILLSWITCH_ACTIVE' : 'ONLINE_PROFILE_KILLSWITCH_UNKNOWN',
      'The online ToolsEnabled profile requires a known inactive kill switch.');
  }
  if (source.tier !== TOOLS_TIER) {
    throw profileError('ONLINE_PROFILE_TIER_DENIED', 'This profile authorizes only an explicit ToolsEnabled-tier request.');
  }
  const lease = validateLease(source.lease);
  const now = integer(source.now, 'now');
  if (now >= lease.expiresAtMs) {
    throw profileError('ONLINE_PROFILE_LEASE_EXPIRED', 'The online ToolsEnabled lease has expired.');
  }
  if (lease.generation !== profile.identityGeneration) {
    throw profileError('ONLINE_PROFILE_LEASE_STALE', 'The online ToolsEnabled lease generation is stale.');
  }
  if (!lease.tiers.includes(TOOLS_TIER)) {
    throw profileError('ONLINE_PROFILE_TIER_DENIED', 'The lease does not explicitly include the ToolsEnabled tier.');
  }
  const revokedLeaseIds = validateRevocations(source.revokedLeaseIds);
  if (revokedLeaseIds.includes(lease.leaseId)) {
    throw profileError('ONLINE_PROFILE_LEASE_REVOKED', 'The online ToolsEnabled lease has been revoked.');
  }
  return Object.freeze({
    schemaVersion: AUTHORIZATION_VERSION,
    status: 'authorized',
    profileId: PROFILE_ID,
    identityId: lease.identityId,
    leaseId: lease.leaseId,
    identityGeneration: lease.generation,
    credentialDomain: CREDENTIAL_DOMAIN,
    tier: TOOLS_TIER,
    tools: profile.tools,
    allowlist: profile.allowlist,
    readOnly: true,
    killSwitchRequired: true,
    auditRequired: true,
    grantsAuthority: false
  });
}

function authorizeOnlineToolInvocation(input) {
  const source = exactKeys(input, INVOCATION_KEYS, 'online ToolsEnabled tool invocation');
  const authorization = authorizeOnlineToolsProfile({
    catalogue: source.catalogue,
    killSwitchActive: source.killSwitchActive,
    lease: source.lease,
    now: source.now,
    profile: source.profile,
    profileEnabled: source.profileEnabled,
    revokedLeaseIds: source.revokedLeaseIds,
    tier: source.tier
  });
  if (typeof source.toolName !== 'string' || !TOOL_NAME_RE.test(source.toolName)) {
    throw profileError('ONLINE_PROFILE_TOOL_UNKNOWN', 'The requested online tool name is unknown.', { toolName: source.toolName });
  }
  const entries = registryEntries(source.catalogue);
  if (!entries.has(source.toolName)) {
    throw profileError('ONLINE_PROFILE_TOOL_UNKNOWN', 'The requested tool is absent from the injected tool catalogue.', { toolName: source.toolName });
  }
  if (!authorization.tools.includes(source.toolName)) {
    throw profileError('ONLINE_PROFILE_TOOL_NOT_ALLOWED', 'The requested tool is not explicitly present in the current online profile.', { toolName: source.toolName });
  }
  assertSafeToolName(source.toolName);
  return Object.freeze({ ...authorization, toolName: source.toolName });
}

function closeReason(reason) {
  if (typeof reason !== 'string' || !/^[a-z0-9-]{1,64}$/.test(reason)) {
    throw profileError('ONLINE_PROFILE_CLOSE_REASON_INVALID', 'The online ToolsEnabled session close reason is invalid.');
  }
  return reason;
}

function safeDenialText(value) {
  return typeof value === 'string' && value.length <= 160 ? value : null;
}

function createOnlineToolsProfileEnforcer({
  catalogue,
  loadProfile,
  isProfileEnabled,
  isKillSwitchActive,
  getRevokedLeaseIds,
  clock,
  recordDenial,
  closeSession
} = {}) {
  // Validate structure at construction but do not materialize a profile here:
  // profile loading is intentionally repeated for every invocation.
  registryEntries(catalogue);
  requireFunction(loadProfile, 'loadProfile');
  requireFunction(isProfileEnabled, 'isProfileEnabled');
  requireFunction(isKillSwitchActive, 'isKillSwitchActive');
  requireFunction(getRevokedLeaseIds, 'getRevokedLeaseIds');
  requireFunction(clock, 'clock');
  requireFunction(recordDenial, 'recordDenial');
  requireFunction(closeSession, 'closeSession');

  let nextSessionId = 1;
  const active = new Map();
  const denials = [];

  async function readState() {
    let profile;
    try {
      profile = await loadProfile();
    } catch (error) {
      throw profileError('ONLINE_PROFILE_LOAD_FAILED', 'The online ToolsEnabled profile could not be loaded.', { causeCode: error?.code });
    }
    let profileEnabled;
    let killSwitchActive;
    let revokedLeaseIds;
    let now;
    try {
      [profileEnabled, killSwitchActive, revokedLeaseIds, now] = await Promise.all([
        isProfileEnabled(), isKillSwitchActive(), getRevokedLeaseIds(), clock()
      ]);
    } catch (error) {
      throw profileError('ONLINE_PROFILE_SECURITY_STATE_UNAVAILABLE', 'Online ToolsEnabled security state is unavailable.', { causeCode: error?.code });
    }
    return Object.freeze({ profile, profileEnabled, killSwitchActive, revokedLeaseIds, now });
  }

  async function closeRecord(record, reason) {
    const safeReason = closeReason(reason);
    if (record.closed) return false;
    record.closed = true;
    active.delete(record.sessionId);
    try {
      await closeSession(Object.freeze({ sessionId: record.sessionId, reason: safeReason }));
    } catch (error) {
      // Logical closure is committed before the callback so a broken callback
      // cannot leave the session usable, but callback delivery is not reported
      // as a successful close when it could not be established.
      throw profileError('ONLINE_PROFILE_SESSION_CLOSE_FAILED',
        'The online ToolsEnabled session was closed locally, but its close callback failed.',
        { sessionId: record.sessionId, causeCode: error?.code });
    }
    return true;
  }

  async function closeAll(reason) {
    const records = [...active.values()];
    let closeError;
    for (const record of records) {
      try {
        await closeRecord(record, reason);
      } catch (error) {
        closeError ??= error;
      }
    }
    if (closeError) throw closeError;
    return Object.freeze({ closedSessionCount: records.length, activeSessionCount: active.size });
  }

  async function recordDenied(context, error, now) {
    const denial = Object.freeze({
      event: 'online-tools-denied',
      atMs: Number.isSafeInteger(now) && now >= 0 ? now : 0,
      sessionId: safeDenialText(context.sessionId),
      tier: safeDenialText(context.tier),
      toolName: safeDenialText(context.toolName),
      reason: typeof error?.code === 'string' ? error.code : 'ONLINE_PROFILE_DENIED'
    });
    denials.push(denial);
    try {
      await recordDenial(denial);
    } catch (auditError) {
      return Object.freeze({
        status: 'denied', allowed: false, reason: 'ONLINE_PROFILE_DENIAL_AUDIT_FAILED',
        originalReason: denial.reason, denial
      });
    }
    return Object.freeze({ status: 'denied', allowed: false, reason: denial.reason, denial });
  }

  function shouldCloseAll(error) {
    return new Set([
      'ONLINE_PROFILE_DISABLED', 'ONLINE_PROFILE_KILLSWITCH_ACTIVE', 'ONLINE_PROFILE_KILLSWITCH_UNKNOWN',
      'ONLINE_PROFILE_LOAD_FAILED', 'ONLINE_PROFILE_NOT_EXPLICIT', 'ONLINE_PROFILE_REGISTRY_GAP',
      'ONLINE_PROFILE_REGISTRY_INVALID', 'ONLINE_PROFILE_REGISTRY_UNSAFE', 'ONLINE_PROFILE_SECURITY_STATE_UNAVAILABLE',
      'ONLINE_PROFILE_UNSAFE', 'ONLINE_PROFILE_INVALID_SHAPE', 'ONLINE_PROFILE_INVALID_VALUE'
    ]).has(error?.code);
  }

  function shouldCloseSession(error) {
    return new Set([
      'ONLINE_PROFILE_LEASE_DENIED', 'ONLINE_PROFILE_LEASE_EXPIRED', 'ONLINE_PROFILE_LEASE_INVALID',
      'ONLINE_PROFILE_LEASE_REVOKED', 'ONLINE_PROFILE_LEASE_STALE', 'ONLINE_PROFILE_REVOCATION_INVALID',
      'ONLINE_PROFILE_TIER_DENIED'
    ]).has(error?.code);
  }

  async function authorizeCurrent(request, toolName) {
    const state = await readState();
    const base = {
      catalogue,
      killSwitchActive: state.killSwitchActive,
      lease: request.lease,
      now: state.now,
      profile: state.profile,
      profileEnabled: state.profileEnabled,
      revokedLeaseIds: state.revokedLeaseIds,
      tier: request.tier
    };
    let authorization;
    try {
      authorization = toolName === undefined
        ? authorizeOnlineToolsProfile(base)
        : authorizeOnlineToolInvocation({ ...base, toolName });
    } catch (error) {
      // Denial auditing needs the authoritative injected clock even when a
      // profile rule rejects before an authorization object can be returned.
      error.onlineProfileNow = state.now;
      throw error;
    }
    return Object.freeze({ authorization, now: state.now });
  }

  async function open(request) {
    const context = { sessionId: null, tier: request?.tier, toolName: null };
    let now = 0;
    try {
      exactKeys(request, OPEN_KEYS, 'online ToolsEnabled session request');
      const result = await authorizeCurrent(request);
      now = result.now;
      const sessionId = `online-tools-session-${nextSessionId}`;
      nextSessionId += 1;
      const record = { sessionId, request: Object.freeze({ ...request }), closed: false };
      active.set(sessionId, record);
      return Object.freeze({
        status: 'authorized',
        sessionId,
        authorization: result.authorization,
        invoke: toolName => invoke(sessionId, toolName),
        close: reason => closeRecord(record, reason)
      });
    } catch (error) {
      now = error?.onlineProfileNow ?? now;
      if (shouldCloseAll(error)) await closeAll('security-state-rejected');
      return recordDenied(context, error, now);
    }
  }

  async function invoke(sessionId, toolName) {
    const record = active.get(sessionId);
    const context = { sessionId, tier: record?.request?.tier, toolName };
    if (!record || record.closed || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) {
      return recordDenied(context, profileError('ONLINE_PROFILE_SESSION_CLOSED', 'The online ToolsEnabled session is closed.'), 0);
    }
    let now = 0;
    try {
      const result = await authorizeCurrent(record.request, toolName);
      now = result.now;
      return Object.freeze({ status: 'authorized', allowed: true, authorization: result.authorization });
    } catch (error) {
      now = error?.onlineProfileNow ?? now;
      if (shouldCloseAll(error)) await closeAll('security-state-rejected');
      else if (shouldCloseSession(error)) await closeRecord(record, 'lease-rejected');
      return recordDenied(context, error, now);
    }
  }

  async function reconcile() {
    const records = [...active.values()];
    let closedSessionCount = 0;
    for (const record of records) {
      const result = await invoke(record.sessionId, ONLINE_TOOLS[0]);
      if (result.status === 'denied' && !active.has(record.sessionId)) closedSessionCount += 1;
    }
    return Object.freeze({ closedSessionCount, activeSessionCount: active.size });
  }

  return Object.freeze({
    closeAll,
    getActiveSessionCount: () => active.size,
    getDenials: () => Object.freeze([...denials]),
    invoke,
    open,
    reconcile
  });
}

assertCanonicalProfile();

module.exports = Object.freeze({
  PROFILE_ID,
  CREDENTIAL_DOMAIN,
  AUTHORIZATION_VERSION,
  TOOLS_TIER,
  REMOTE_TIERS,
  MAX_REVOKED_LEASES,
  MAX_LEASE_TTL_MS,
  ONLINE_TOOLS,
  FORBIDDEN_NAMESPACES,
  FORBIDDEN_ACTION_PARTS,
  assertSafeToolName,
  authorizeOnlineToolsProfile,
  authorizeOnlineToolInvocation,
  buildOnlineToolsAllowlist,
  createOnlineToolsProfile,
  createOnlineToolsProfileEnforcer,
  validateLease,
  validateOnlineToolsProfile
});
