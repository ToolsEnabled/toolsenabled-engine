'use strict';

// Cryptographic context layer above FRA v2 frames. The secure-session module
// authenticates the PSK, host pair, session id, generation, and frame order;
// this module binds the immutable runtime/profile/policy/root attestations and
// the canonical MCP arguments into that session before dispatch is eligible.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WORKSPACE_POLICY_DIGEST } = require('./fra-workspace-policy');
const { ROOT_ACCESS_POLICY_DIGEST } = require('./fra-root-access');
const {
  assertSanctionedMachineAddress,
  peerMachineForAddress,
  ServiceRegistryError
} = require('./service-registry');

const BINDING_TYPE = 'fra.transport-binding';
const ACCEPTANCE_TYPE = 'fra.binding-accepted';
const REQUEST_TYPE = 'fra.bound-request';
const RESPONSE_TYPE = 'fra.bound-response';
const SCHEMA_VERSION = 1;
const RESULT_PROJECTOR_VERSION = 'fra.closed-mcp-result-projector.v1';
const PROTOCOL_VERSION = 2;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const MAX_CANONICAL_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_KEYS = 4096;
const MAX_JSON_ARRAY = 10000;
const MAX_JSON_STRING_BYTES = 768 * 1024;
// Enforcement configuration only. These two files genuinely gate tool calls and
// change rarely, so requiring both machines to hold identical bytes is a
// promise worth having.
//
// STANDING-ORDERS.md and config/standing-orders.json were here and are
// deliberately gone. No code in the FRA request path reads either one -- their
// only readers are an enforcement report and a Claude Code hook, both outside
// the listener -- so pinning them bought a cryptographic promise that the two
// machines carry the same narrative document, at the cost of refusing every
// session whenever an agent recorded an owner directive. Which is constantly,
// and by design. On 2026-08-02 that took FRA down for nineteen hours.
// See docs/full-remote-access.md, and the re-add guard in
// tests/fra-transport-binding.js.
const POLICY_FILES = Object.freeze([
  'config/toolsenabled.policy.json',
  'config/uac-delegation-allowlist.json'
]);
const TRANSPORT_POLICY_DESCRIPTOR = Object.freeze({
  bindingSchemaVersion: SCHEMA_VERSION,
  boundRequestSchemaVersion: SCHEMA_VERSION,
  boundResponseSchemaVersion: SCHEMA_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  resultProjectorVersion: RESULT_PROJECTOR_VERSION,
  rootAccessPolicyDigest: ROOT_ACCESS_POLICY_DIGEST,
  workspacePolicyDigest: WORKSPACE_POLICY_DIGEST,
  pathIdentityDisclosure: false
});

class FraTransportBindingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FraTransportBindingError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new FraTransportBindingError(code, message);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, expected, code = 'FRA_BINDING_SHAPE_INVALID') {
  if (!plainObject(value)) fail(code, 'FRA binding value must be a plain object');
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    fail(code, 'FRA binding value has unsupported fields');
  }
  return value;
}

function canonicalStringify(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('FRA_CANONICAL_VALUE_INVALID', 'FRA canonical numbers must be finite');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  if (!plainObject(value)) {
    fail('FRA_CANONICAL_VALUE_INVALID', 'FRA canonical values must be JSON data');
  }
  return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${canonicalStringify(value[key])}`
  )).join(',')}}`;
}

function digest(domain, value) {
  const canonical = canonicalStringify(value);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_CANONICAL_BYTES) {
    fail('FRA_CANONICAL_VALUE_TOO_LARGE', 'FRA canonical value exceeded its bound');
  }
  return crypto.createHash('sha256')
    .update(domain, 'utf8').update('\0', 'utf8')
    .update(canonical, 'utf8').digest('hex');
}

function directPair(serverHost, clientHost, serviceRegistryOptions = {}) {
  try {
    assertSanctionedMachineAddress(serverHost, serviceRegistryOptions);
    assertSanctionedMachineAddress(clientHost, serviceRegistryOptions);
    if (serverHost === clientHost
        || peerMachineForAddress(serverHost, serviceRegistryOptions).address !== clientHost) {
      fail('FRA_BINDING_HOST_INVALID', 'FRA binding requires the exact registry-declared peer pair');
    }
  } catch (error) {
    if (error instanceof FraTransportBindingError) throw error;
    if (error instanceof ServiceRegistryError
        && ['SERVICE_MACHINE_ADDRESS_INVALID', 'SERVICE_MACHINE_ADDRESS_UNSANCTIONED', 'SERVICE_PEER_UNDETERMINED'].includes(error.code)) {
      fail('FRA_BINDING_HOST_INVALID', 'FRA binding requires the exact registry-declared peer pair');
    }
    throw error;
  }
  return { serverHost, clientHost };
}

function safeRealpath(fsApi, target) {
  const selected = fsApi.realpathSync.native || fsApi.realpathSync;
  return selected.call(fsApi.realpathSync, target);
}

function rootIdentityReport({ root, fsApi = fs } = {}) {
  if (typeof root !== 'string' || !root) {
    fail('FRA_ROOT_IDENTITY_INVALID', 'FRA root is required for identity verification');
  }
  const resolved = path.resolve(root);
  let descriptor;
  try {
    const before = fsApi.lstatSync(resolved, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      fail('FRA_ROOT_IDENTITY_INVALID', 'FRA root must be a regular directory');
    }
    const real = safeRealpath(fsApi, resolved);
    const canonical = path.resolve(real);
    if (process.platform === 'win32'
      ? canonical.toLowerCase() !== resolved.toLowerCase()
      : canonical !== resolved) {
      fail('FRA_ROOT_IDENTITY_INVALID', 'FRA root must not alias another path');
    }
    descriptor = fsApi.openSync(resolved, process.platform === 'linux'
      ? fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW : 'r');
    const opened = fsApi.fstatSync(descriptor, { bigint: true });
    const after = fsApi.lstatSync(resolved, { bigint: true });
    const fields = ['dev', 'ino', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    if (!opened.isDirectory() || fields.some(field => typeof opened[field] !== 'bigint')
        || opened.dev <= 0n || opened.ino <= 0n || opened.nlink <= 0n
        || (process.platform === 'win32' && opened.nlink !== 1n)
        || fields.some(field => before[field] !== opened[field] || opened[field] !== after[field])) {
      fail('FRA_ROOT_IDENTITY_INVALID', 'FRA root identity is not stable or has an invalid link count');
    }
    // dev + ino identify the directory. ctimeNs is NOT part of its identity:
    // it is mutable state that moves whenever an entry is created or removed in
    // the root, so including it made device continuity a function of the
    // directory's MUTATION HISTORY rather than of which directory this is.
    //
    // Measured, not reasoned: adding a file to the root changed this digest, and
    // REMOVING it again produced a third value rather than restoring the first.
    // So ordinary development permanently broke continuity, and the peer could
    // never be recognised again -- REMOTE_BRIDGE_DEVICE_CONTINUITY_MISMATCH on
    // every reconnect after either machine did any work in its root.
    //
    // This is the same coupling that started the 2026-08-02 incident, one layer
    // down: something edited during ordinary use wired into something that must
    // stay fixed. The continuity check is supposed to answer "is this the same
    // machine", and a directory that has had files written to it is still the
    // same directory.
    //
    // ctimeNs is deliberately still checked for STABILITY above, where it
    // belongs: three reads must agree within one call, which is what catches a
    // root being swapped underneath us mid-verification.
    // POSIX directory link counts can change when child directories change.
    // Keep them in the within-call stability check, never the POSIX identity.
    // Preserve existing Windows digests so this repair does not invalidate
    // a Windows peer's recorded continuity proof.
    const rootIdentityDigest = process.platform === 'win32'
      ? digest('ToolsEnabled/FRA/root-identity/v1', {
        dev: opened.dev.toString(10),
        ino: opened.ino.toString(10),
        nlink: opened.nlink.toString(10)
      })
      : digest('ToolsEnabled/FRA/root-identity/posix/v2', {
        dev: opened.dev.toString(10),
        ino: opened.ino.toString(10)
      });
    return Object.freeze({ valid: true, rootIdentityDigest });
  } catch (error) {
    if (error instanceof FraTransportBindingError) throw error;
    fail('FRA_ROOT_IDENTITY_INVALID', 'FRA root identity could not be verified');
  } finally {
    if (descriptor !== undefined) {
      try {
        fsApi.closeSync(descriptor);
      } catch {
        fail('FRA_ROOT_IDENTITY_INVALID', 'FRA root identity descriptor could not be closed');
      }
    }
  }
}

function policyDigestForRoot({ root, fsApi = fs } = {}) {
  if (typeof root !== 'string' || !root) {
    fail('FRA_POLICY_FILE_INVALID', 'FRA root is required for policy verification');
  }
  const resolvedRoot = path.resolve(root);
  const hash = crypto.createHash('sha256')
    .update('ToolsEnabled/FRA/policy-files/v1', 'utf8').update('\0', 'utf8');
  for (const relative of POLICY_FILES) {
    const target = path.resolve(resolvedRoot, ...relative.split('/'));
    let stat;
    let bytes;
    try {
      stat = fsApi.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        fail('FRA_POLICY_FILE_INVALID', 'FRA policy input is not a regular file');
      }
      bytes = fsApi.readFileSync(target);
      hash.update(relative, 'utf8').update('\0', 'utf8')
        .update(String(bytes.length), 'utf8').update('\0', 'utf8')
        .update(bytes).update('\0', 'utf8');
    } catch (error) {
      if (error instanceof FraTransportBindingError) throw error;
      fail('FRA_POLICY_FILE_INVALID', 'FRA policy input is unavailable');
    } finally {
      if (Buffer.isBuffer(bytes)) bytes.fill(0);
    }
  }
  return hash.digest('hex');
}

function capabilityProfileDigest(profile) {
  if (!plainObject(profile)
      || !Number.isSafeInteger(profile.schemaVersion) || profile.schemaVersion < 1
      || !DIGEST_RE.test(profile.registryNameDigest || '')
      || !DIGEST_RE.test(profile.allowedToolNamesDigest || '')
      || !Number.isSafeInteger(profile.allowedToolCount)
      || !Array.isArray(profile.allowedTools)
      || profile.allowedTools.length !== profile.allowedToolCount
      || profile.allowedTools.some(name => !TOOL_NAME_RE.test(name))
      || !Array.isArray(profile.excludedTools)
      || profile.excludedTools.some(name => !TOOL_NAME_RE.test(name))
      || !plainObject(profile.desktopCapabilities)
      || !plainObject(profile.transportPolicy)
      || canonicalStringify(profile.transportPolicy)
        !== canonicalStringify(TRANSPORT_POLICY_DESCRIPTOR)) {
    fail('FRA_PROFILE_BINDING_INVALID', 'FRA capability profile cannot be bound');
  }
  const sortedAllowed = [...profile.allowedTools].sort();
  const namesDigest = crypto.createHash('sha256')
    .update(sortedAllowed.join('\n'), 'utf8').digest('hex');
  if (new Set(sortedAllowed).size !== sortedAllowed.length
      || profile.allowedTools.some((name, index) => name !== sortedAllowed[index])
      || namesDigest !== profile.allowedToolNamesDigest
      || (profile.allowedToolNames !== undefined
        && (!Array.isArray(profile.allowedToolNames)
          || profile.allowedToolNames.length !== sortedAllowed.length
          || profile.allowedToolNames.some((name, index) => name !== sortedAllowed[index])))) {
    fail('FRA_PROFILE_BINDING_INVALID', 'FRA capability names do not match their digest');
  }
  return digest('ToolsEnabled/FRA/capability-profile/v1', {
    schemaVersion: profile.schemaVersion,
    registryNameDigest: profile.registryNameDigest,
    allowedToolNamesDigest: profile.allowedToolNamesDigest,
    allowedToolCount: profile.allowedToolCount,
    allowedTools: [...profile.allowedTools],
    excludedTools: [...profile.excludedTools],
    desktopCapabilities: profile.desktopCapabilities,
    transportPolicy: profile.transportPolicy
  });
}

function projectorSetDigest(allowedTools) {
  if (!Array.isArray(allowedTools) || allowedTools.length < 1
      || allowedTools.some(name => !TOOL_NAME_RE.test(name))) {
    fail('FRA_PROJECTOR_PROFILE_INVALID', 'FRA result projector set is invalid');
  }
  return digest('ToolsEnabled/FRA/result-projectors/v1', {
    projectorVersion: RESULT_PROJECTOR_VERSION,
    tools: [...allowedTools].sort().map(name => ({
      name,
      projector: name.startsWith('workspace.')
        ? `closed-${name}-result.v1`
        : 'closed-mcp-tool-result.v1'
    }))
  });
}

function normalizeSession(session) {
  const value = session && typeof session.toJSON === 'function'
    ? session.toJSON() : session;
  if (!plainObject(value)
      || !SESSION_ID_RE.test(value.sessionId || '')
      || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    fail('FRA_SESSION_BINDING_INVALID', 'FRA secure session identity is invalid');
  }
  return Object.freeze({
    sessionId: value.sessionId,
    generation: value.generation
  });
}

const BINDING_KEYS = Object.freeze([
  'type', 'version', 'protocolVersion', 'sessionId', 'generation',
  'serverHost', 'clientHost', 'deviceIdentityDigest',
  'rootIdentityDigest', 'rootAccessPolicyDigest', 'rootAclDigest',
  'runtimeDigest', 'policyDigest', 'capabilityProfileDigest',
  'registryNameDigest', 'allowedToolNamesDigest', 'allowedToolCount',
  'resultProjectorDigest', 'workspacePolicyDigest', 'contextDigest'
]);

function bindingProjection(binding) {
  const projection = {};
  for (const key of BINDING_KEYS) {
    if (key !== 'contextDigest') projection[key] = binding[key];
  }
  return projection;
}

function normalizeRootAccessReport(value) {
  if (!plainObject(value)
      || Object.keys(value).sort().join(',') !==
        'descriptorDigest,policyDigest,schemaVersion,secretValuesEmitted,valid'
      || value.schemaVersion !== 1 || value.valid !== true
      || value.secretValuesEmitted !== false
      || !DIGEST_RE.test(value.policyDigest || '')
      || !DIGEST_RE.test(value.descriptorDigest || '')) {
    fail('FRA_ROOT_ACCESS_INVALID', 'FRA root access policy is not verified');
  }
  return Object.freeze({ ...value });
}

function createServerBinding({
  session,
  serverHost,
  clientHost,
  capabilityProfile,
  runtimeDigest,
  policyDigest,
  rootIdentity,
  rootAccessReport,
  serviceRegistryOptions = {}
}) {
  directPair(serverHost, clientHost, serviceRegistryOptions);
  const secureSession = normalizeSession(session);
  const root = rootIdentity && rootIdentity.valid === true
    && DIGEST_RE.test(rootIdentity.rootIdentityDigest || '')
    ? rootIdentity : fail('FRA_ROOT_IDENTITY_INVALID', 'FRA root identity is not verified');
  const access = normalizeRootAccessReport(rootAccessReport);
  if (!DIGEST_RE.test(runtimeDigest || '') || !DIGEST_RE.test(policyDigest || '')) {
    fail('FRA_RUNTIME_BINDING_INVALID', 'FRA runtime or policy digest is invalid');
  }
  const profileDigest = capabilityProfileDigest(capabilityProfile);
  const resultProjectorDigest = projectorSetDigest(capabilityProfile.allowedTools);
  const deviceIdentityDigest = digest('ToolsEnabled/FRA/device-identity/v1', {
    serverHost,
    rootIdentityDigest: root.rootIdentityDigest,
    rootAclDigest: access.descriptorDigest
  });
  const binding = {
    type: BINDING_TYPE,
    version: SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    sessionId: secureSession.sessionId,
    generation: secureSession.generation,
    serverHost,
    clientHost,
    deviceIdentityDigest,
    rootIdentityDigest: root.rootIdentityDigest,
    rootAccessPolicyDigest: access.policyDigest,
    rootAclDigest: access.descriptorDigest,
    runtimeDigest,
    policyDigest,
    capabilityProfileDigest: profileDigest,
    registryNameDigest: capabilityProfile.registryNameDigest,
    allowedToolNamesDigest: capabilityProfile.allowedToolNamesDigest,
    allowedToolCount: capabilityProfile.allowedToolCount,
    resultProjectorDigest,
    workspacePolicyDigest: WORKSPACE_POLICY_DIGEST
  };
  return Object.freeze({
    ...binding,
    contextDigest: digest('ToolsEnabled/FRA/transport-binding/v1', binding)
  });
}

function validateServerBinding(binding, {
  session,
  serverHost,
  clientHost,
  capabilityProfile,
  runtimeDigest,
  policyDigest,
  rootAccessPolicyDigest,
  priorBinding,
  serviceRegistryOptions = {}
}) {
  exactKeys(binding, BINDING_KEYS);
  directPair(serverHost, clientHost, serviceRegistryOptions);
  const secureSession = normalizeSession(session);
  const expectedProfileDigest = capabilityProfileDigest(capabilityProfile);
  const expectedProjectorDigest = projectorSetDigest(capabilityProfile.allowedTools);
  for (const field of [
    'deviceIdentityDigest', 'rootIdentityDigest', 'rootAccessPolicyDigest',
    'rootAclDigest', 'runtimeDigest', 'policyDigest', 'capabilityProfileDigest',
    'registryNameDigest', 'allowedToolNamesDigest', 'resultProjectorDigest',
    'workspacePolicyDigest', 'contextDigest'
  ]) {
    if (!DIGEST_RE.test(binding[field] || '')) {
      fail('FRA_BINDING_DIGEST_INVALID', 'FRA binding contains an invalid digest');
    }
  }
  if (binding.type !== BINDING_TYPE || binding.version !== SCHEMA_VERSION
      || binding.protocolVersion !== PROTOCOL_VERSION
      || binding.sessionId !== secureSession.sessionId
      || binding.generation !== secureSession.generation
      || binding.serverHost !== serverHost || binding.clientHost !== clientHost
      || binding.runtimeDigest !== runtimeDigest
      || binding.policyDigest !== policyDigest
      || binding.capabilityProfileDigest !== expectedProfileDigest
      || binding.registryNameDigest !== capabilityProfile.registryNameDigest
      || binding.allowedToolNamesDigest !== capabilityProfile.allowedToolNamesDigest
      || binding.allowedToolCount !== capabilityProfile.allowedToolCount
      || binding.resultProjectorDigest !== expectedProjectorDigest
      || binding.workspacePolicyDigest !== WORKSPACE_POLICY_DIGEST
      || binding.rootAccessPolicyDigest !== rootAccessPolicyDigest
      || binding.contextDigest !== digest(
        'ToolsEnabled/FRA/transport-binding/v1',
        bindingProjection(binding)
      )) {
    fail('FRA_BINDING_MISMATCH', 'FRA transport binding did not match local policy');
  }
  if (priorBinding !== undefined && priorBinding !== null) {
    if (!plainObject(priorBinding)
        || priorBinding.serverHost !== serverHost
        || priorBinding.deviceIdentityDigest !== binding.deviceIdentityDigest
        || priorBinding.rootIdentityDigest !== binding.rootIdentityDigest
        || priorBinding.rootAclDigest !== binding.rootAclDigest) {
      fail('FRA_DEVICE_CONTINUITY_MISMATCH', 'FRA endpoint identity changed');
    }
  }
  return Object.freeze({ ...binding });
}

function argumentProjection(message) {
  if (message.method === 'tools/call') {
    const params = plainObject(message.params) ? message.params : {};
    return plainObject(params.arguments) ? params.arguments : {};
  }
  return plainObject(message.params) ? message.params : {};
}

function toolNameFor(message) {
  return message.method === 'tools/call' && plainObject(message.params)
    && typeof message.params.name === 'string' ? message.params.name : null;
}

function requestProjection(envelope) {
  return {
    type: envelope.type,
    version: envelope.version,
    contextDigest: envelope.contextDigest,
    method: envelope.method,
    toolName: envelope.toolName,
    canonicalArgumentsDigest: envelope.canonicalArgumentsDigest,
    message: envelope.message
  };
}

function createBoundRequest(message, contextDigest) {
  if (!plainObject(message) || message.jsonrpc !== '2.0'
      || typeof message.method !== 'string' || !message.method
      || !DIGEST_RE.test(contextDigest || '')) {
    fail('FRA_BOUND_REQUEST_INVALID', 'FRA bound request is invalid');
  }
  const toolName = toolNameFor(message);
  const envelope = {
    type: REQUEST_TYPE,
    version: SCHEMA_VERSION,
    contextDigest,
    method: message.method,
    toolName,
    canonicalArgumentsDigest: digest(
      'ToolsEnabled/FRA/canonical-arguments/v1',
      argumentProjection(message)
    ),
    message
  };
  return Object.freeze({
    ...envelope,
    requestDigest: digest('ToolsEnabled/FRA/bound-request/v1', envelope)
  });
}

function validateBoundRequest(envelope, contextDigest) {
  exactKeys(envelope, [
    'type', 'version', 'contextDigest', 'method', 'toolName',
    'canonicalArgumentsDigest', 'message', 'requestDigest'
  ], 'FRA_BOUND_REQUEST_INVALID');
  if (envelope.type !== REQUEST_TYPE || envelope.version !== SCHEMA_VERSION
      || envelope.contextDigest !== contextDigest
      || !DIGEST_RE.test(envelope.canonicalArgumentsDigest || '')
      || !DIGEST_RE.test(envelope.requestDigest || '')
      || !plainObject(envelope.message)
      || envelope.message.jsonrpc !== '2.0'
      || envelope.method !== envelope.message.method
      || envelope.toolName !== toolNameFor(envelope.message)
      || envelope.canonicalArgumentsDigest !== digest(
        'ToolsEnabled/FRA/canonical-arguments/v1',
        argumentProjection(envelope.message)
      )
      || envelope.requestDigest !== digest(
        'ToolsEnabled/FRA/bound-request/v1',
        requestProjection(envelope)
      )) {
    fail('FRA_BOUND_REQUEST_MISMATCH', 'FRA bound request did not match its session context');
  }
  return Object.freeze({ ...envelope, message: envelope.message });
}

function closedJson(value, state = { keys: 0 }, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('FRA_RESULT_PROJECTION_INVALID', 'non-finite result number');
    return value;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_JSON_STRING_BYTES) {
      fail('FRA_RESULT_PROJECTION_TOO_LARGE', 'result string exceeded its bound');
    }
    return value;
  }
  if (depth >= MAX_JSON_DEPTH) {
    fail('FRA_RESULT_PROJECTION_TOO_DEEP', 'result exceeded its depth bound');
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ARRAY) {
      fail('FRA_RESULT_PROJECTION_TOO_LARGE', 'result array exceeded its bound');
    }
    return value.map(item => closedJson(item, state, depth + 1));
  }
  if (!plainObject(value)) {
    fail('FRA_RESULT_PROJECTION_INVALID', 'result contains a non-JSON value');
  }
  const output = {};
  for (const key of Object.keys(value).sort()) {
    state.keys += 1;
    if (state.keys > MAX_JSON_KEYS || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(key)
        || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      fail('FRA_RESULT_PROJECTION_INVALID', 'result contains an invalid field');
    }
    output[key] = closedJson(value[key], state, depth + 1);
  }
  return output;
}

function validRpcId(value) {
  return value === null || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function projectRpcError(error) {
  if (!plainObject(error) || !Number.isInteger(error.code)
      || typeof error.message !== 'string' || error.message.length > 500) {
    fail('FRA_RESULT_PROJECTION_INVALID', 'RPC error is invalid');
  }
  let data;
  if (plainObject(error.data) && typeof error.data.code === 'string'
      && /^[A-Z0-9_.-]{1,96}$/.test(error.data.code)) {
    data = { code: error.data.code };
  }
  return Object.freeze({
    code: error.code,
    message: error.message,
    ...(data ? { data } : {})
  });
}

function projectToolResult(result) {
  if (!plainObject(result)
      || Object.keys(result).some(key => ![
        'content', 'structuredContent', 'isError'
      ].includes(key))
      || !plainObject(result.structuredContent)
      || (result.isError !== undefined && typeof result.isError !== 'boolean')) {
    fail('FRA_RESULT_PROJECTION_INVALID', 'MCP tool result is invalid');
  }
  const structuredContent = closedJson(result.structuredContent);
  const text = JSON.stringify(structuredContent);
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_STRING_BYTES) {
    fail('FRA_RESULT_PROJECTION_TOO_LARGE', 'MCP tool result exceeded its bound');
  }
  return Object.freeze({
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    structuredContent,
    ...(result.isError === true ? { isError: true } : {})
  });
}

function projectToolList(result, allowedTools) {
  if (!plainObject(result) || !Array.isArray(result.tools)) {
    fail('FRA_RESULT_PROJECTION_INVALID', 'MCP tool list is invalid');
  }
  const allowed = new Set(allowedTools);
  const projected = result.tools.map(tool => {
    if (!plainObject(tool) || !allowed.has(tool.name)
        || typeof tool.description !== 'string' || !plainObject(tool.inputSchema)) {
      fail('FRA_RESULT_PROJECTION_INVALID', 'MCP tool descriptor is invalid');
    }
    return Object.freeze({
      name: tool.name,
      description: tool.description,
      inputSchema: closedJson(tool.inputSchema),
      ...(plainObject(tool.annotations)
        ? { annotations: closedJson(tool.annotations) } : {})
    });
  });
  const names = projected.map(tool => tool.name).sort();
  const expected = [...allowedTools].sort();
  if (names.length !== expected.length
      || names.some((name, index) => name !== expected[index])) {
    fail('FRA_RESULT_PROJECTION_INVALID', 'MCP tool list differs from its bound profile');
  }
  return Object.freeze({ tools: Object.freeze(projected) });
}

function projectMcpResponse(request, response, allowedTools) {
  if (!plainObject(request) || !plainObject(response)
      || response.jsonrpc !== '2.0' || !validRpcId(response.id)
      || response.id !== request.id
      || !Array.isArray(allowedTools)) {
    fail('FRA_RESULT_PROJECTION_INVALID', 'MCP response is invalid');
  }
  if (response.error !== undefined) {
    if (response.result !== undefined) {
      fail('FRA_RESULT_PROJECTION_INVALID', 'MCP response mixed result and error');
    }
    return Object.freeze({
      jsonrpc: '2.0',
      id: response.id,
      error: projectRpcError(response.error)
    });
  }
  if (response.result === undefined) {
    fail('FRA_RESULT_PROJECTION_INVALID', 'MCP response has no result');
  }
  let result;
  if (request.method === 'tools/call') {
    const name = toolNameFor(request);
    if (!name || !allowedTools.includes(name)) {
      fail('FRA_RESULT_PROJECTION_INVALID', 'MCP tool result is not in the bound profile');
    }
    result = projectToolResult(response.result);
  } else if (request.method === 'tools/list') {
    result = projectToolList(response.result, allowedTools);
  } else if (request.method === 'initialize') {
    const supplied = response.result;
    if (!plainObject(supplied) || typeof supplied.protocolVersion !== 'string'
        || !plainObject(supplied.capabilities) || !plainObject(supplied.serverInfo)
        || supplied.serverInfo.name !== 'toolsenabled'
        || typeof supplied.serverInfo.version !== 'string') {
      fail('FRA_RESULT_PROJECTION_INVALID', 'MCP initialize result is invalid');
    }
    result = Object.freeze({
      protocolVersion: supplied.protocolVersion,
      capabilities: closedJson(supplied.capabilities),
      serverInfo: Object.freeze({
        name: 'toolsenabled',
        version: supplied.serverInfo.version
      })
    });
  } else {
    result = closedJson(response.result);
  }
  return Object.freeze({ jsonrpc: '2.0', id: response.id, result });
}

function createBoundResponse({ requestEnvelope, response, allowedTools }) {
  const projected = projectMcpResponse(
    requestEnvelope.message,
    response,
    allowedTools
  );
  const base = {
    type: RESPONSE_TYPE,
    version: SCHEMA_VERSION,
    contextDigest: requestEnvelope.contextDigest,
    requestDigest: requestEnvelope.requestDigest,
    response: projected
  };
  return Object.freeze({
    ...base,
    responseDigest: digest('ToolsEnabled/FRA/bound-response/v1', base)
  });
}

function validateBoundResponse(envelope, { requestEnvelope, allowedTools }) {
  exactKeys(envelope, [
    'type', 'version', 'contextDigest', 'requestDigest',
    'response', 'responseDigest'
  ], 'FRA_BOUND_RESPONSE_INVALID');
  if (envelope.type !== RESPONSE_TYPE || envelope.version !== SCHEMA_VERSION
      || envelope.contextDigest !== requestEnvelope.contextDigest
      || envelope.requestDigest !== requestEnvelope.requestDigest
      || !DIGEST_RE.test(envelope.responseDigest || '')) {
    fail('FRA_BOUND_RESPONSE_MISMATCH', 'FRA bound response context did not match');
  }
  const projected = projectMcpResponse(
    requestEnvelope.message,
    envelope.response,
    allowedTools
  );
  const base = {
    type: envelope.type,
    version: envelope.version,
    contextDigest: envelope.contextDigest,
    requestDigest: envelope.requestDigest,
    response: projected
  };
  if (canonicalStringify(projected) !== canonicalStringify(envelope.response)
      || envelope.responseDigest !== digest(
        'ToolsEnabled/FRA/bound-response/v1',
        base
      )) {
    fail('FRA_BOUND_RESPONSE_MISMATCH', 'FRA bound response projection did not match');
  }
  return Object.freeze({ ...envelope, response: projected });
}

function workspaceContextFromBinding(binding) {
  exactKeys(binding, BINDING_KEYS);
  return Object.freeze({
    sessionContextDigest: binding.contextDigest,
    generation: binding.generation,
    serverHost: binding.serverHost,
    clientHost: binding.clientHost
  });
}

function createBindingAcceptance(binding) {
  exactKeys(binding, BINDING_KEYS);
  if (!DIGEST_RE.test(binding.contextDigest || '')
      || !SESSION_ID_RE.test(binding.sessionId || '')
      || !Number.isSafeInteger(binding.generation) || binding.generation < 1) {
    fail('FRA_BINDING_ACCEPTANCE_INVALID', 'FRA binding acceptance input is invalid');
  }
  const base = {
    type: ACCEPTANCE_TYPE,
    version: SCHEMA_VERSION,
    contextDigest: binding.contextDigest,
    sessionId: binding.sessionId,
    generation: binding.generation
  };
  return Object.freeze({
    ...base,
    acceptanceDigest: digest('ToolsEnabled/FRA/binding-accepted/v1', base)
  });
}

function validateBindingAcceptance(value, binding) {
  exactKeys(value, [
    'type', 'version', 'contextDigest', 'sessionId', 'generation',
    'acceptanceDigest'
  ], 'FRA_BINDING_ACCEPTANCE_INVALID');
  const base = {
    type: value.type,
    version: value.version,
    contextDigest: value.contextDigest,
    sessionId: value.sessionId,
    generation: value.generation
  };
  if (value.type !== ACCEPTANCE_TYPE || value.version !== SCHEMA_VERSION
      || value.contextDigest !== binding.contextDigest
      || value.sessionId !== binding.sessionId
      || value.generation !== binding.generation
      || !DIGEST_RE.test(value.acceptanceDigest || '')
      || value.acceptanceDigest !== digest(
        'ToolsEnabled/FRA/binding-accepted/v1',
        base
      )) {
    fail('FRA_BINDING_ACCEPTANCE_MISMATCH', 'FRA binding acceptance did not match the session');
  }
  return Object.freeze({ ...value });
}

module.exports = Object.freeze({
  BINDING_TYPE,
  ACCEPTANCE_TYPE,
  REQUEST_TYPE,
  RESPONSE_TYPE,
  SCHEMA_VERSION,
  RESULT_PROJECTOR_VERSION,
  PROTOCOL_VERSION,
  POLICY_FILES,
  TRANSPORT_POLICY_DESCRIPTOR,
  WORKSPACE_POLICY_DIGEST,
  FraTransportBindingError,
  canonicalStringify,
  digest,
  rootIdentityReport,
  policyDigestForRoot,
  capabilityProfileDigest,
  projectorSetDigest,
  createServerBinding,
  validateServerBinding,
  createBindingAcceptance,
  validateBindingAcceptance,
  createBoundRequest,
  validateBoundRequest,
  projectMcpResponse,
  createBoundResponse,
  validateBoundResponse,
  workspaceContextFromBinding
});
