'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const audit = require('../audit');
const operationAudit = require('../operation-audit');
const {
  ensureDir, getOrCreateSecret, readJson, rootPath, writeJsonAtomic
} = require('../runtime');
const { getStateStore, hashInput } = require('../state-store');
const { defaultAdmissionGuardPath, withSandboxAdmissionLock } = require('../sandbox-admission-lock');

const CONTRACT = 'agent-playwright-v1';
const IMAGE_TAG = 'toolsenabled/agent-playwright-sandbox:1.61.0-v1';
const PLAYWRIGHT_VERSION = '1.61.0';
const BASE_DIGEST = 'sha256:111dde95859f2c659291cb60e698f9048a8fc30b35b4ddb7c90f9cb5b73062d9';
const IMAGE_LOCK_PATH = rootPath('state', 'sandboxes', 'image-lock.json');
const DISPOSABLE_ROOT = rootPath('state', 'sandboxes', 'disposable');
const AUTH_ROOT = rootPath('state', 'sandboxes', 'auth-profiles');
const AUTH_KEY_NAME = 'sandbox_auth_profile_encryption_key_v1';
const MANAGED_LABEL = 'org.toolsenabled.managed';
const MANAGED_VALUE = 'agent-playwright-v1';
const SCOPE_LABEL = 'org.toolsenabled.sandbox.scope';
const AGENTS = new Set(['codex', 'claude', 'gemini', 'grok']);
const NETWORK_MODES = new Set(['none', 'fixture']);
const SANDBOX_ID_RE = /^sbx-[a-f0-9]{20}$/;
const PROFILE_ID_RE = /^auth-[a-f0-9]{20}$/;
const STABLE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const SAFE_RELATIVE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/;
const OPERATION_TYPE = 'sandbox.disposable-v1';
const AUTH_OPERATION_TYPE = 'sandbox.auth-profile-slot-v1';
const MAX_WORKSPACE_TEXT_BYTES = 256 * 1024;
const MAX_READ_BYTES = 512 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 256 * 1024;
const MAX_ACTIVE_SANDBOXES = 4;
const MAX_ACTIVE_PER_AGENT = 2;
const MIN_CREATE_LEASE_MS = 240_000;
const MIN_WORKSPACE_LEASE_MS = 90_000;
const MIN_CLEANUP_LEASE_MS = 180_000;
const EXEC_RECOVERY_MARGIN_MS = 90_000;

const RESOURCE_LIMITS = Object.freeze({
  browser: Object.freeze({
    cpus: 1,
    memoryBytes: 1024 * 1024 * 1024,
    pids: 256,
    shmBytes: 256 * 1024 * 1024,
    tmpBytes: 128 * 1024 * 1024,
    cacheBytes: 128 * 1024 * 1024,
    nofileSoft: 1024,
    nofileHard: 2048
  }),
  fixture: Object.freeze({
    cpus: 0.25,
    memoryBytes: 128 * 1024 * 1024,
    pids: 64,
    shmBytes: 64 * 1024 * 1024,
    tmpBytes: 16 * 1024 * 1024,
    nofileSoft: 256,
    nofileHard: 512
  })
});

const IMAGE_SOURCE_FILES = Object.freeze([
  'Dockerfile',
  'package.json',
  'package-lock.json',
  'bounded-exec.js',
  'fixture-server.js',
  'hold-open.js'
]);

class AgentSandboxError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentSandboxError';
    this.code = code;
    this.details = details;
  }
}

function sandboxError(code, message, details) {
  return new AgentSandboxError(code, message, details);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requireObject(value, label) {
  if (!plainObject(value)) throw sandboxError('SANDBOX_INPUT_INVALID', `${label} must be an object.`);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw sandboxError('SANDBOX_INPUT_INVALID', `${label} contains unsupported field '${key}'.`);
  }
}

function safeString(value, label, { min = 1, max = 200, pattern } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || (pattern && !pattern.test(value))) {
    throw sandboxError('SANDBOX_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function safeInteger(value, label, { min, max } = {}) {
  if (!Number.isSafeInteger(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    throw sandboxError('SANDBOX_INPUT_INVALID', `${label} is invalid.`);
  }
  return value;
}

function agent(value) {
  if (!AGENTS.has(value)) throw sandboxError('SANDBOX_INPUT_INVALID', 'agent is invalid.');
  return value;
}

function stableKey(value, label) {
  return safeString(value, label, { min: 8, max: 200, pattern: STABLE_KEY_RE });
}

function leaseMs(value) {
  const seconds = value === undefined ? 300 : safeInteger(value, 'leaseSeconds', { min: 30, max: 900 });
  return seconds * 1000;
}

function shortDigest(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function legacySandboxIdFor(agentName, sandboxKey) {
  return `sbx-${shortDigest(`${CONTRACT}\0${agentName}\0${sandboxKey}`)}`;
}

// Docker names belong to the daemon, not to this process's state database.
// Bind them to the same root that owns the durable workspace/operation records.
// The digest is persisted in resource labels and workspace markers; no source
// checkout path, PID, version or caller-controlled tool option selects it.
function sandboxScopeFor(disposableRoot, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path;
  const absolute = paths.resolve(disposableRoot);
  return shortDigest(`${CONTRACT}\0${platform === 'win32' ? absolute.toLowerCase() : absolute}`);
}

function sandboxIdFor(agentName, sandboxKey, scope = sandboxScopeFor(DISPOSABLE_ROOT)) {
  return `sbx-${shortDigest(`${CONTRACT}\0${scope}\0${agentName}\0${sandboxKey}`)}`;
}

function profileIdFor(account, purpose) {
  return `auth-${shortDigest(`${CONTRACT}\0${account.toLowerCase()}\0${purpose.toLowerCase()}`)}`;
}

function operationHandle(value, resourceKey) {
  const source = requireObject(value, 'handle');
  const allowed = new Set([resourceKey, 'operationId', 'ownerId', 'token', 'fence', 'expiresAtMs']);
  if (resourceKey === 'profileId') allowed.add('slotFence');
  exactKeys(source, allowed, 'handle');
  return {
    resourceId: safeString(source[resourceKey], `handle.${resourceKey}`, {
      max: 25, pattern: resourceKey === 'sandboxId' ? SANDBOX_ID_RE : PROFILE_ID_RE
    }),
    slotFence: resourceKey === 'profileId'
      ? safeInteger(source.slotFence, 'handle.slotFence', { min: 1 })
      : null,
    lease: {
      operationId: safeString(source.operationId, 'handle.operationId', { max: 500 }),
      ownerId: safeString(source.ownerId, 'handle.ownerId', { max: 200 }),
      token: safeString(source.token, 'handle.token', { max: 500 }),
      fence: safeInteger(source.fence, 'handle.fence', { min: 1 })
    }
  };
}

function publicHandle(resourceKey, resourceId, handle) {
  return {
    [resourceKey]: resourceId,
    operationId: handle.operationId,
    ownerId: handle.ownerId,
    token: handle.token,
    fence: handle.fence,
    expiresAtMs: handle.expiresAtMs
  };
}

function publicAuthHandle(profileId, handle, slotFence) {
  return {
    ...publicHandle('profileId', profileId, handle),
    slotFence
  };
}

function contextDigest(fileSystem = fs) {
  const hash = crypto.createHash('sha256');
  const base = rootPath('docker', 'agent-sandbox');
  for (const relative of IMAGE_SOURCE_FILES) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fileSystem.readFileSync(path.join(base, relative)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function defaultDocker(args, options = {}) {
  return spawnSync('docker', args, {
    cwd: rootPath(),
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    timeout: options.timeoutMs || 30_000,
    maxBuffer: options.maxBuffer || 1024 * 1024,
    env: process.env
  });
}

function normalizedDockerResult(result) {
  return {
    status: result && Number.isInteger(result.status) ? result.status : null,
    stdout: String(result && result.stdout || ''),
    stderr: String(result && result.stderr || ''),
    error: result && result.error
  };
}

function dockerFailure(result, operation, redact = audit.redact) {
  if (result.error && result.error.code === 'ETIMEDOUT') {
    return sandboxError('SANDBOX_DOCKER_TIMEOUT', `Docker timed out during ${operation}.`);
  }
  if (result.error && result.error.code === 'ENOENT') {
    return sandboxError('SANDBOX_DOCKER_UNAVAILABLE', 'Docker CLI is not installed or not on PATH.');
  }
  const detail = redact(result.stderr || (result.error && result.error.message) || '').slice(0, 1000);
  return sandboxError('SANDBOX_DOCKER_FAILED', `Docker failed during ${operation}.`, detail ? { detail } : {});
}

function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch { throw sandboxError('SANDBOX_DOCKER_RESPONSE_INVALID', `Docker returned invalid JSON for ${label}.`); }
}

function labelsFromInspect(value) {
  return value && value.Config && plainObject(value.Config.Labels) ? value.Config.Labels : {};
}

function validateImageMetadata(image) {
  const labels = labelsFromInspect(image);
  if (labels['org.toolsenabled.sandbox.contract'] !== CONTRACT
    || labels['org.toolsenabled.sandbox.playwright'] !== PLAYWRIGHT_VERSION
    || labels['org.toolsenabled.sandbox.base-digest'] !== BASE_DIGEST) {
    throw sandboxError('SANDBOX_IMAGE_UNTRUSTED', 'The sandbox image labels do not match the pinned ToolsEnabled contract.');
  }
  if (image.Os !== 'linux' || image.Architecture !== 'amd64') {
    throw sandboxError('SANDBOX_IMAGE_UNTRUSTED', 'The sandbox image must be linux/amd64.');
  }
  const configuredUser = image && image.Config && image.Config.User;
  if (configuredUser !== '10001:10001') {
    throw sandboxError('SANDBOX_IMAGE_UNTRUSTED', 'The sandbox image must default to UID/GID 10001.');
  }
}

function readMetadata(file) {
  const value = readJson(file, null);
  if (!plainObject(value)) throw sandboxError('SANDBOX_STATE_INVALID', 'Sandbox metadata is missing or invalid.');
  return value;
}

function createSandboxProvider(dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  const state = () => dependencies.state || getStateStore();
  const runDocker = dependencies.runDocker || defaultDocker;
  const auditor = dependencies.audit || audit;
  const now = dependencies.now || (() => Date.now());
  const imageLockPath = dependencies.imageLockPath || IMAGE_LOCK_PATH;
  const disposableRoot = dependencies.disposableRoot || DISPOSABLE_ROOT;
  const authRoot = dependencies.authRoot || AUTH_ROOT;
  const createGuardPath = dependencies.createGuardPath
    || path.join(path.dirname(disposableRoot), '.create.guard.json');
  const getEncryptionSecret = dependencies.getOrCreateSecret || getOrCreateSecret;
  const platform = dependencies.platform || process.platform;
  const scope = sandboxScopeFor(disposableRoot, platform);
  let linuxWorkspace = dependencies.linuxWorkspace || null;

  function requireLinuxWorkspace() {
    if (!linuxWorkspace && dependencies.runDocker) {
      throw sandboxError('SANDBOX_LINUX_WORKSPACE_REFUSED', 'An injected Docker transport requires an explicit workspace ownership fixture.');
    }
    if (!linuxWorkspace) linuxWorkspace = require('../linux-sandbox-workspace').createLinuxSandboxWorkspace({
      disposableRoot,
      auditIntent: (event, resource, detail) => auditIntent(event, resource, detail),
    });
    return linuxWorkspace;
  }

  function rawDocker(args, options = {}) {
    // Every Linux Docker operation uses the same verified local daemon, not
    // whichever context/environment happens to be current after an ACL grant.
    if (platform === 'linux') {
      try { return normalizedDockerResult(requireLinuxWorkspace().runDocker(args, options)); }
      catch (error) { return normalizedDockerResult({ status: null, error, stdout: '', stderr: '' }); }
    }
    return normalizedDockerResult(runDocker(args, options));
  }

  function docker(args, operation, options = {}) {
    const result = rawDocker(args, options);
    if (result.status !== 0) throw dockerFailure(result, operation, auditor.redact);
    return result.stdout.trim();
  }

  function inspect(kind, identifier, { optional = false } = {}) {
    const result = rawDocker([kind, 'inspect', identifier], { timeoutMs: 15_000 });
    if (result.status !== 0) {
      if (optional && /(?:no such|not found)/i.test(result.stderr)) return null;
      throw dockerFailure(result, `${kind} inspect`, auditor.redact);
    }
    const parsed = parseJson(result.stdout, `${kind} inspect`);
    if (!Array.isArray(parsed) || parsed.length !== 1 || !plainObject(parsed[0])) {
      throw sandboxError('SANDBOX_DOCKER_RESPONSE_INVALID', `Docker returned an invalid ${kind} inspection.`);
    }
    return parsed[0];
  }

  function probeDockerCompatibility() {
    const version = rawDocker(['version', '--format', '{{json .Server}}'], { timeoutMs: 15_000 });
    if (version.status !== 0) {
      const errorCode = version.error && version.error.code;
      if (errorCode === 'SANDBOX_LINUX_WORKSPACE_REFUSED') {
        return {
          available: null,
          compatible: null,
          code: errorCode,
          message: 'The Linux sandbox requires a verified local rootless Docker endpoint, Python 3, and the setfacl/getfacl utilities. Workspace ownership could not be verified; no sandbox was started.',
          reasons: ['linux-workspace-ownership-unverified'],
          server: {},
          info: {}
        };
      }
      const couldNotDetermine = version.status === null && errorCode !== 'ENOENT';
      return {
        available: couldNotDetermine ? null : false,
        compatible: couldNotDetermine ? null : false,
        code: couldNotDetermine
          ? 'SANDBOX_DOCKER_STATUS_UNKNOWN'
          : errorCode === 'ENOENT'
          ? 'SANDBOX_DOCKER_UNAVAILABLE'
          : 'SANDBOX_DOCKER_NOT_RUNNING',
        message: couldNotDetermine
          ? 'Docker availability could not be determined; this does not claim that Docker is absent or stopped.'
          : undefined,
        reasons: ['docker-server-unavailable'],
        server: {},
        info: {}
      };
    }
    let server;
    try {
      server = parseJson(version.stdout, 'Docker server version');
    } catch {
      return {
        available: true,
        compatible: false,
        code: 'SANDBOX_DOCKER_RESPONSE_INVALID',
        reasons: ['invalid-version-response'],
        server: {},
        info: {}
      };
    }
    const infoResult = rawDocker(['info', '--format', '{{json .}}'], { timeoutMs: 15_000 });
    if (infoResult.status !== 0) {
      if (infoResult.status === null) {
        return {
          available: true,
          compatible: null,
          code: 'SANDBOX_DOCKER_STATUS_UNKNOWN',
          message: 'Docker compatibility could not be determined; this does not claim that Docker is absent, stopped, or incompatible.',
          reasons: ['docker-info-unanswered'],
          server,
          info: {}
        };
      }
      return {
        available: true,
        compatible: false,
        code: 'SANDBOX_DOCKER_INFO_UNAVAILABLE',
        reasons: ['docker-info-unavailable'],
        server,
        info: {}
      };
    }
    let info;
    try {
      info = parseJson(infoResult.stdout, 'Docker info');
    } catch {
      return {
        available: true,
        compatible: false,
        code: 'SANDBOX_DOCKER_RESPONSE_INVALID',
        reasons: ['invalid-info-response'],
        server,
        info: {}
      };
    }
    const dockerMajor = Number.parseInt(String(server.Version || '').split('.')[0], 10);
    const checks = {
      linux: server.Os === 'linux',
      amd64: server.Arch === 'amd64',
      docker28: Number.isSafeInteger(dockerMajor) && dockerMajor >= 28,
      memoryLimit: info.MemoryLimit === true,
      pidsLimit: info.PidsLimit === true
    };
    const reasons = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
    return {
      available: true,
      compatible: reasons.length === 0,
      code: reasons.length === 0 ? null : 'SANDBOX_DOCKER_INCOMPATIBLE',
      reasons,
      server,
      info
    };
  }

  function assertDockerCompatible() {
    const probe = probeDockerCompatibility();
    if (probe.available === null || probe.compatible === null) {
      throw sandboxError(probe.code, probe.message);
    }
    if (!probe.available) {
      throw sandboxError(probe.code, 'Docker is unavailable for agent sandboxes.');
    }
    if (!probe.compatible) {
      throw sandboxError(
        probe.code || 'SANDBOX_DOCKER_INCOMPATIBLE',
        'Docker does not satisfy the enforced linux/amd64, Docker 28+, memory-limit, and PID-limit sandbox contract.',
        { reasons: probe.reasons }
      );
    }
    return probe;
  }

  function verifyImage() {
    const lock = readJson(imageLockPath, null);
    if (!plainObject(lock)) {
      throw sandboxError('SANDBOX_IMAGE_NOT_PROVISIONED', 'Build and lock the pinned sandbox image with tools/build-agent-sandbox.ps1.');
    }
    const legacy = lock.version === 1 && lock.tag === IMAGE_TAG;
    const scoped = lock.version === 2 && lock.scope === scope
      && lock.tag === imageTag(lock.contextSha256);
    if ((!legacy && !scoped) || lock.contract !== CONTRACT
      || lock.baseDigest !== BASE_DIGEST || lock.playwrightVersion !== PLAYWRIGHT_VERSION
      || !/^sha256:[a-f0-9]{64}$/.test(lock.imageId || '')
      || !/^[a-f0-9]{64}$/.test(lock.contextSha256 || '')) {
      throw sandboxError('SANDBOX_IMAGE_LOCK_INVALID', 'The sandbox image lock is invalid.');
    }
    if (lock.contextSha256 !== contextDigest(fileSystem)) {
      throw sandboxError('SANDBOX_IMAGE_LOCK_STALE', 'Sandbox image sources changed after the image was locked; rebuild it.');
    }
    const image = inspect('image', lock.imageId);
    if (image.Id !== lock.imageId) throw sandboxError('SANDBOX_IMAGE_UNTRUSTED', 'The locked image ID did not inspect to itself.');
    validateImageMetadata(image);
    const tagImage = inspect('image', lock.tag);
    if (tagImage.Id !== lock.imageId) {
      throw sandboxError('SANDBOX_IMAGE_LOCK_STALE', 'The sandbox image tag no longer points to the locked immutable image ID.');
    }
    return { imageId: lock.imageId, contextSha256: lock.contextSha256 };
  }

  function imageTag(digest = contextDigest(fileSystem)) {
    return `${IMAGE_TAG}-${scope}-${String(digest).slice(0, 20)}`;
  }

  function imageLockWrite(imageRef = IMAGE_TAG) {
    const contextSha256 = contextDigest(fileSystem);
    const legacy = imageRef === IMAGE_TAG;
    if (!legacy && imageRef !== imageTag(contextSha256)) {
      throw sandboxError('SANDBOX_INPUT_INVALID', 'Only this installation\'s pinned sandbox image tag may be locked.');
    }
    const image = inspect('image', imageRef);
    if (!/^sha256:[a-f0-9]{64}$/.test(image.Id || '')) {
      throw sandboxError('SANDBOX_IMAGE_UNTRUSTED', 'Docker did not return an immutable image ID.');
    }
    validateImageMetadata(image);
    const lock = {
      version: legacy ? 1 : 2,
      contract: CONTRACT,
      tag: imageRef,
      ...(legacy ? {} : { scope }),
      imageId: image.Id,
      baseDigest: BASE_DIGEST,
      playwrightVersion: PLAYWRIGHT_VERSION,
      contextSha256,
      lockedAt: new Date(now()).toISOString()
    };
    writeJsonAtomic(imageLockPath, lock);
    return lock;
  }

  // Owner setup only; deliberately absent from the agent tool registry. The
  // synchronous transport is bounded, not interactively cancellable. Run this
  // outside the UI thread; a timeout is not proof daemon-side work stopped.
  let preparingImage = false;
  function prepareImage(value = {}) {
    const input = requireObject(value, 'sandbox image preparation');
    exactKeys(input, new Set(['allowBuild']), 'sandbox image preparation');
    if (input.allowBuild !== undefined && typeof input.allowBuild !== 'boolean') {
      throw sandboxError('SANDBOX_INPUT_INVALID', 'allowBuild must be a boolean.');
    }
    if (preparingImage) throw sandboxError('SANDBOX_IMAGE_PREPARATION_BUSY', 'Image preparation is already running.');
    preparingImage = true;
    try {
      assertDockerCompatible();
      const before = contextDigest(fileSystem);
      const tag = imageTag(before);
      const existing = inspect('image', tag, { optional: true });
      if (!existing && input.allowBuild !== true) {
        throw sandboxError('SANDBOX_IMAGE_BUILD_REQUIRED', 'Preparing the fixed sandbox image requires an explicit owner-approved download and build.');
      }
      if (existing) validateImageMetadata(existing);
      auditCoordination('sandbox.image.prepare.intent', tag, { build: !existing, contextSha256: before });
      if (!existing) {
        // Trusted setup lifecycle hook, never part of the agent/input schema.
        // Durable coordination must succeed before any daemon-side build.
        if (dependencies.onImageBuildStart) {
          if (typeof dependencies.onImageBuildStart !== 'function') throw sandboxError('SANDBOX_INPUT_INVALID', 'Invalid setup lifecycle hook.');
          const marked = dependencies.onImageBuildStart();
          if (marked && typeof marked.then === 'function') {
            void Promise.resolve(marked).catch(() => {});
            throw sandboxError('SANDBOX_INPUT_INVALID', 'Setup lifecycle marking must be synchronous.');
          }
        }
        docker(['build', '--pull', '--tag', tag, rootPath('docker', 'agent-sandbox')],
          'pinned sandbox image build', { timeoutMs: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
      }
      if (contextDigest(fileSystem) !== before) {
        throw sandboxError('SANDBOX_IMAGE_LOCK_STALE', 'The packaged image context changed during preparation.');
      }
      const lock = imageLockWrite(tag);
      const ready = doctor();
      if (ready.available !== true || ready.compatible !== true || ready.imageReady !== true) {
        throw sandboxError(ready.imageCode || ready.code || 'SANDBOX_IMAGE_NOT_PROVISIONED', 'The sandbox image could not be verified after preparation.');
      }
      return { status: 'ready', built: !existing, imageId: lock.imageId, contextSha256: lock.contextSha256,
        contract: CONTRACT, interactiveCancellationSupported: false };
    } finally { preparingImage = false; }
  }

  function ownerLabels(sandboxId, role, handle, agentName) {
    return [
      '--label', `${MANAGED_LABEL}=${MANAGED_VALUE}`,
      '--label', `${SCOPE_LABEL}=${scope}`,
      '--label', `org.toolsenabled.sandbox.id=${sandboxId}`,
      '--label', `org.toolsenabled.sandbox.role=${role}`,
      '--label', `org.toolsenabled.sandbox.operation=${handle.operationId}`,
      '--label', `org.toolsenabled.sandbox.fence=${handle.fence}`,
      '--label', `org.toolsenabled.sandbox.agent=${agentName}`
    ];
  }

  function browserContainerArgs({ name, sandboxId, imageId, handle, agentName, networkMode, workspace }) {
    const limit = RESOURCE_LIMITS.browser;
    const network = networkMode === 'none' ? 'none' : `${sandboxId}-net`;
    const args = [
      'run', '-d', '--pull', 'never', '--platform', 'linux/amd64',
      '--name', name, '--hostname', 'sandbox',
      '--restart', 'no', '--init', '--stop-timeout', '5',
      '--user', '10001:10001', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--pids-limit', String(limit.pids),
      '--cpus', String(limit.cpus),
      '--memory', String(limit.memoryBytes),
      '--memory-swap', String(limit.memoryBytes),
      '--shm-size', String(limit.shmBytes),
      '--ulimit', `nofile=${limit.nofileSoft}:${limit.nofileHard}`,
      '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${limit.tmpBytes},mode=1777`,
      '--tmpfs', `/home/sandbox/.cache:rw,noexec,nosuid,nodev,size=${limit.cacheBytes},uid=10001,gid=10001`,
      '--mount', `type=bind,src=${workspace},dst=/workspace`,
      '--network', network,
      '--workdir', '/workspace',
      '--env', 'HOME=/home/sandbox',
      '--env', 'NODE_PATH=/opt/toolsenabled/node_modules',
      '--env', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
      '--log-driver', 'json-file', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=1',
      ...ownerLabels(sandboxId, 'browser', handle, agentName)
    ];
    if (networkMode === 'fixture') args.push('--env', 'SANDBOX_FIXTURE_URL=http://fixture:8080');
    args.push(imageId, 'node', '/opt/toolsenabled/hold-open.js');
    return args;
  }

  function fixtureContainerArgs({ name, sandboxId, imageId, handle, agentName }) {
    const limit = RESOURCE_LIMITS.fixture;
    return [
      'run', '-d', '--pull', 'never', '--platform', 'linux/amd64',
      '--name', name, '--hostname', 'fixture',
      '--restart', 'no', '--init', '--stop-timeout', '3',
      '--user', '10001:10001', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
      '--pids-limit', String(limit.pids),
      '--cpus', String(limit.cpus),
      '--memory', String(limit.memoryBytes),
      '--memory-swap', String(limit.memoryBytes),
      '--shm-size', String(limit.shmBytes),
      '--ulimit', `nofile=${limit.nofileSoft}:${limit.nofileHard}`,
      '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${limit.tmpBytes},mode=1777`,
      '--network', `${sandboxId}-net`, '--network-alias', 'fixture',
      '--log-driver', 'json-file', '--log-opt', 'max-size=256k', '--log-opt', 'max-file=1',
      ...ownerLabels(sandboxId, 'fixture', handle, agentName),
      imageId, 'node', '/opt/toolsenabled/fixture-server.js'
    ];
  }

  function sandboxPaths(sandboxId) {
    if (!SANDBOX_ID_RE.test(sandboxId)) throw sandboxError('SANDBOX_INPUT_INVALID', 'sandboxId is invalid.');
    const root = path.resolve(disposableRoot, sandboxId);
    const relative = path.relative(path.resolve(disposableRoot), root);
    if (relative !== sandboxId || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw sandboxError('SANDBOX_PATH_INVALID', 'The sandbox path escaped the managed root.');
    }
    return {
      root,
      workspace: path.join(root, 'workspace'),
      marker: path.join(root, '.sandbox-owner.json'),
      execLock: path.join(root, '.exec.lock.json'),
      quarantine: path.join(root, '.quarantine.json'),
      browserName: `${sandboxId}-browser`,
      fixtureName: `${sandboxId}-fixture`,
      networkName: `${sandboxId}-net`
    };
  }

  function assertManagedContainer(container, sandboxId, role, operationId, { inventory = false } = {}) {
    const labels = labelsFromInspect(container);
    if (labels[MANAGED_LABEL] !== MANAGED_VALUE
      || labels['org.toolsenabled.sandbox.id'] !== sandboxId
      || labels['org.toolsenabled.sandbox.role'] !== role
      || (operationId && labels['org.toolsenabled.sandbox.operation'] !== operationId)) {
      throw sandboxError('SANDBOX_OWNERSHIP_MISMATCH', `Refusing to operate on non-owned ${role} container.`);
    }
    // Inventory intentionally spans installations to retain the machine budget.
    // Every operation on a container also requires this installation's marker.
    if (inventory) return;
    const marker = assertResourceScope(labels, sandboxId, operationId);
    if (marker.version === 2 && role === 'browser') {
      const expected = sandboxPaths(sandboxId).workspace;
      if (!Array.isArray(container.Mounts) || !container.Mounts.some(mount =>
        mount?.Type === 'bind' && mount.Destination === '/workspace'
        && typeof mount.Source === 'string' && path.resolve(mount.Source) === path.resolve(expected))) {
        throw sandboxError('SANDBOX_OWNERSHIP_MISMATCH', 'The legacy sandbox does not mount this installation\'s workspace.');
      }
    }
  }

  function assertResourceScope(labels, sandboxId, operationId = null) {
    const marker = sandboxMarker(sandboxPaths(sandboxId), sandboxId, operationId);
    if ((marker.version === 3 ? labels[SCOPE_LABEL] !== scope : labels[SCOPE_LABEL] !== undefined)
      || (labels['org.toolsenabled.sandbox.operation'] !== undefined
        && labels['org.toolsenabled.sandbox.operation'] !== marker.operationId)
      || (marker.version === 3 && labels['org.toolsenabled.sandbox.operation'] !== marker.operationId)) {
      throw sandboxError('SANDBOX_OWNERSHIP_MISMATCH', 'The Docker resource belongs to another installation or generation.');
    }
    return marker;
  }

  function assertManagedNetwork(network, sandboxId, operationId = null) {
    const labels = plainObject(network.Labels) ? network.Labels : {};
    if (labels[MANAGED_LABEL] !== MANAGED_VALUE || labels['org.toolsenabled.sandbox.id'] !== sandboxId) {
      throw sandboxError('SANDBOX_OWNERSHIP_MISMATCH', 'Refusing to operate on a non-owned Docker network.');
    }
    assertResourceScope(labels, sandboxId, operationId);
  }

  function assertFixtureNetworkBoundary(network, sandboxId) {
    assertManagedNetwork(network, sandboxId);
    const options = plainObject(network.Options) ? network.Options : {};
    if (network.Driver !== 'bridge'
      || network.Internal !== true
      || options['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated') {
      throw sandboxError(
        'SANDBOX_NETWORK_ISOLATION_FAILED',
        'Docker did not enforce the internal isolated-gateway fixture network.'
      );
    }
  }

  function hasPublishedPorts(value) {
    if (!plainObject(value)) return false;
    return Object.values(value).some(bindings => Array.isArray(bindings) && bindings.length > 0);
  }

  function normalizedHostPath(value) {
    const normalized = path.resolve(String(value || '')).replaceAll('\\', '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  }

  function tmpfsHas(value, expectedSize) {
    if (typeof value !== 'string') return false;
    const options = new Set(value.split(',').map(item => item.trim().toLowerCase()));
    return options.has('rw') && options.has('noexec') && options.has('nosuid') && options.has('nodev')
      && options.has(`size=${expectedSize}`);
  }

  function assertContainerBoundary(container, {
    sandboxId, role, operationId, imageId, networkMode, workspace
  }) {
    assertManagedContainer(container, sandboxId, role, operationId);
    const limit = RESOURCE_LIMITS[role];
    const config = plainObject(container.Config) ? container.Config : {};
    const host = plainObject(container.HostConfig) ? container.HostConfig : {};
    const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
    const securityOptions = Array.isArray(host.SecurityOpt)
      ? host.SecurityOpt.map(item => String(item).toLowerCase())
      : [];
    const capDrop = Array.isArray(host.CapDrop)
      ? host.CapDrop.map(item => String(item).toUpperCase())
      : [];
    const ulimits = Array.isArray(host.Ulimits) ? host.Ulimits : [];
    const nofile = ulimits.find(item => item && String(item.Name).toLowerCase() === 'nofile');
    const tmpfs = plainObject(host.Tmpfs) ? host.Tmpfs : {};
    const expectedNetwork = networkMode === 'none' ? 'none' : `${sandboxId}-net`;
    const mountValid = role === 'browser'
      ? mounts.length === 1
        && mounts[0] && mounts[0].Type === 'bind'
        && mounts[0].Destination === '/workspace'
        && mounts[0].RW === true
        && normalizedHostPath(mounts[0].Source) === normalizedHostPath(workspace)
      : mounts.length === 0;
    const deviceCount = [
      ...(Array.isArray(host.Devices) ? host.Devices : []),
      ...(Array.isArray(host.DeviceRequests) ? host.DeviceRequests : [])
    ].length;
    const cacheValid = role !== 'browser'
      || (tmpfsHas(tmpfs['/home/sandbox/.cache'], limit.cacheBytes)
        && String(tmpfs['/home/sandbox/.cache']).toLowerCase().includes('uid=10001')
        && String(tmpfs['/home/sandbox/.cache']).toLowerCase().includes('gid=10001'));
    const valid = container.Image === imageId
      && config.User === '10001:10001'
      && host.Privileged === false
      && host.ReadonlyRootfs === true
      && capDrop.includes('ALL')
      && securityOptions.some(item => item === 'no-new-privileges:true' || item === 'no-new-privileges')
      && host.PidsLimit === limit.pids
      && host.Memory === limit.memoryBytes
      && host.MemorySwap === limit.memoryBytes
      && host.NanoCpus === Math.round(limit.cpus * 1_000_000_000)
      && host.ShmSize === limit.shmBytes
      && host.NetworkMode === expectedNetwork
      && nofile && nofile.Soft === limit.nofileSoft && nofile.Hard === limit.nofileHard
      && tmpfsHas(tmpfs['/tmp'], limit.tmpBytes)
      && cacheValid
      && mountValid
      && deviceCount === 0
      && !hasPublishedPorts(host.PortBindings)
      && !hasPublishedPorts(container.NetworkSettings && container.NetworkSettings.Ports)
      && mounts.every(item => !/(?:docker\.sock|docker_engine)/i.test(String(item && item.Source || '')));
    if (!valid) {
      throw sandboxError(
        'SANDBOX_CONTAINER_ISOLATION_FAILED',
        `Docker did not enforce the complete ${role} container isolation contract.`
      );
    }
    if (!container.State || container.State.Running !== true) {
      throw sandboxError('SANDBOX_NOT_RUNNING', `The ${role} sandbox container is not running.`);
    }
  }

  function auditIntent(event, target, details) {
    const auditPolicy = operationAudit.capturePolicy();
    const recorded = operationAudit.requireRecord(event, target, details, { audit: auditor, auditPolicy });
    if (!auditPolicy.required && operationAudit.isNotRequired(recorded, event, target)) return;
    if (!recorded || recorded.durable !== true) {
      throw sandboxError('SANDBOX_AUDIT_UNAVAILABLE', 'A durable sandbox intent could not be recorded.');
    }
  }

  // Image preparation coordinates owner setup with a daemon-side build.
  // Its durable anchor remains required independently of optional activity.
  function auditCoordination(event, target, details) {
    const recorded = auditor.requireRecord(event, target, details);
    if (!recorded || recorded.durable !== true) {
      throw sandboxError('SANDBOX_AUDIT_UNAVAILABLE', 'A durable sandbox intent could not be recorded.');
    }
  }

  function acquireCreateGuard() {
    ensureDir(path.dirname(createGuardPath));
    const attempt = () => {
      const descriptor = fileSystem.openSync(createGuardPath, 'wx');
      fileSystem.writeFileSync(descriptor, `${JSON.stringify({
        version: 1, pid: process.pid, createdAtMs: now()
      })}\n`, 'utf8');
      return descriptor;
    };
    try { return attempt(); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const prior = readJson(createGuardPath, null);
    const stale = plainObject(prior) && Number.isSafeInteger(prior.pid) && prior.pid > 0
      && Number.isSafeInteger(prior.createdAtMs) && now() - prior.createdAtMs > 120_000;
    let ownerAlive = true;
    if (stale) {
      try { process.kill(prior.pid, 0); } catch (error) {
        if (error.code === 'ESRCH') ownerAlive = false;
      }
    }
    if (!stale || ownerAlive) throw sandboxError('SANDBOX_CREATE_BUSY', 'Another process is creating a sandbox.');
    fileSystem.unlinkSync(createGuardPath);
    try { return attempt(); } catch (error) {
      if (error.code === 'EEXIST') throw sandboxError('SANDBOX_CREATE_BUSY', 'Another process acquired sandbox creation.');
      throw error;
    }
  }

  function releaseCreateGuard(descriptor) {
    try { fileSystem.closeSync(descriptor); } finally {
      releaseGuardFile(
        createGuardPath,
        'SANDBOX_CREATE_GUARD_RELEASE_FAILED',
        'The sandbox creation guard could not be released.'
      );
    }
  }

  function releaseGuardFile(guardPath, code, message) {
    try {
      fileSystem.unlinkSync(guardPath);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw sandboxError(code, message);
    }
  }

  function withCreateGuard(callback) {
    const descriptor = acquireCreateGuard();
    try {
      return withSandboxAdmissionLock(dependencies.admissionGuardPath || defaultAdmissionGuardPath(), callback);
    } catch (error) {
      if (!(error instanceof AgentSandboxError) && /^SANDBOX_CREATE_/.test(error.code || '')) {
        throw sandboxError(error.code, error.message);
      }
      throw error;
    } finally { releaseCreateGuard(descriptor); }
  }

  function activeSandboxInventory() {
    const result = rawDocker([
      'container', 'ls', '--all',
      '--filter', `label=${MANAGED_LABEL}=${MANAGED_VALUE}`,
      '--filter', 'label=org.toolsenabled.sandbox.role=browser',
      '--format', '{{.Names}}'
    ], { timeoutMs: 15_000 });
    if (result.status !== 0) throw dockerFailure(result, 'sandbox admission inventory', auditor.redact);
    const names = result.stdout.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    if (names.length > 32 || names.some(name => !/^sbx-[a-f0-9]{20}-browser$/.test(name))) {
      throw sandboxError('SANDBOX_DOCKER_RESPONSE_INVALID', 'Docker returned an invalid managed-sandbox inventory.');
    }
    return names.map(name => {
      const sandboxId = name.slice(0, -'-browser'.length);
      const container = inspect('container', name);
      assertManagedContainer(container, sandboxId, 'browser', null, { inventory: true });
      const labelSet = labelsFromInspect(container);
      return { name, sandboxId, agent: labelSet['org.toolsenabled.sandbox.agent'] || null };
    });
  }

  function assertAdmission(agentName) {
    const active = activeSandboxInventory();
    if (active.length >= MAX_ACTIVE_SANDBOXES) {
      throw sandboxError('SANDBOX_CAPACITY_REACHED', `At most ${MAX_ACTIVE_SANDBOXES} disposable browser sandboxes may exist.`);
    }
    if (active.filter(item => item.agent === agentName).length >= MAX_ACTIVE_PER_AGENT) {
      throw sandboxError('SANDBOX_AGENT_CAPACITY_REACHED', `Agent '${agentName}' already owns its ${MAX_ACTIVE_PER_AGENT}-sandbox limit.`);
    }
  }

  function removeOwnedContainer(name, sandboxId, role, operationId, expectedContainerId = null) {
    const container = inspect('container', name, { optional: true });
    if (!container) return false;
    assertManagedContainer(container, sandboxId, role, operationId);
    if (expectedContainerId && container.Id !== expectedContainerId) {
      throw sandboxError('SANDBOX_OWNERSHIP_MISMATCH', `Refusing to remove a replaced ${role} container.`);
    }
    auditIntent('sandbox.container.remove.intent', sandboxId, { role, containerName: name });
    if (typeof container.Id !== 'string' || !container.Id) {
      throw sandboxError('SANDBOX_OWNERSHIP_MISMATCH', 'Docker did not identify the owned container.');
    }
    docker(['container', 'rm', '--force', container.Id], `${role} container cleanup`, { timeoutMs: 30_000 });
    return true;
  }

  function removeOwnedNetwork(name, sandboxId, operationId = null) {
    const network = inspect('network', name, { optional: true });
    if (!network) return false;
    assertManagedNetwork(network, sandboxId, operationId);
    auditIntent('sandbox.network.remove.intent', sandboxId, { networkName: name });
    if (typeof network.Id !== 'string' || !network.Id) {
      throw sandboxError('SANDBOX_OWNERSHIP_MISMATCH', 'Docker did not identify the owned network.');
    }
    docker(['network', 'rm', network.Id], 'sandbox network cleanup', { timeoutMs: 30_000 });
    return true;
  }

  function removeOwnedWorkspace(paths, sandboxId, operationId = null) {
    if (!fileSystem.existsSync(paths.root)) return false;
    sandboxMarker(paths, sandboxId, operationId);
    const resolvedRoot = path.resolve(paths.root);
    const managedRoot = path.resolve(disposableRoot);
    const relative = path.relative(managedRoot, resolvedRoot);
    if (relative !== sandboxId || !SANDBOX_ID_RE.test(relative) || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw sandboxError('SANDBOX_PATH_INVALID', 'Refusing to remove a workspace outside the managed disposable root.');
    }
    auditIntent('sandbox.workspace.remove.intent', sandboxId, { sandboxId });
    fileSystem.rmSync(resolvedRoot, { recursive: true, force: false });
    return true;
  }

  function bestEffortPartialCleanup(paths, sandboxId, operationId) {
    for (const item of [
      [paths.browserName, 'browser'],
      [paths.fixtureName, 'fixture']
    ]) {
      try { removeOwnedContainer(item[0], sandboxId, item[1], operationId); } catch { /* original create failure wins */ }
    }
    try { removeOwnedNetwork(paths.networkName, sandboxId, operationId); } catch { /* original create failure wins */ }
    try { removeOwnedWorkspace(paths, sandboxId, operationId); } catch { /* original create failure wins */ }
  }

  function sandboxMarker(paths, sandboxId, operationId = null) {
    const marker = readJson(paths.marker, null);
    if (!plainObject(marker) || ![2, 3].includes(marker.version) || marker.contract !== CONTRACT
      || marker.sandboxId !== sandboxId
      || (marker.version === 3 && marker.scope !== scope)
      || (operationId && marker.operationId !== operationId)
      || !AGENTS.has(marker.agent)
      || !NETWORK_MODES.has(marker.networkMode)
      || !/^sha256:[a-f0-9]{64}$/.test(marker.imageId || '')) {
      throw sandboxError('SANDBOX_OWNERSHIP_MISMATCH', 'The sandbox ownership marker is invalid or does not match this generation.');
    }
    // A copied/foreign Docker name cannot establish ownership. The marker must
    // join to the operation in THIS state store, including its logical key.
    const operation = state().getOperation({ id: marker.operationId });
    const prefix = `${marker.agent}:`;
    if (!operation || operation.type !== OPERATION_TYPE
      || typeof operation.key !== 'string' || !operation.key.startsWith(prefix)
      || (marker.version === 2
        ? legacySandboxIdFor(marker.agent, operation.key.slice(prefix.length))
        : sandboxIdFor(marker.agent, operation.key.slice(prefix.length), scope)) !== sandboxId) {
      throw sandboxError('SANDBOX_OWNERSHIP_MISMATCH', 'The sandbox has no matching operation in this installation.');
    }
    return marker;
  }

  function prepareWorkspace(paths, sandboxId, operationId, { agentName, networkMode, imageId }) {
    if (fileSystem.existsSync(paths.root)) {
      const marker = sandboxMarker(paths, sandboxId, operationId);
      if (marker.agent !== agentName || marker.networkMode !== networkMode || marker.imageId !== imageId) {
        throw sandboxError('SANDBOX_OWNERSHIP_MISMATCH', 'The existing sandbox generation does not match the requested isolation contract.');
      }
      if (fileSystem.existsSync(paths.quarantine)) {
        throw sandboxError('SANDBOX_QUARANTINED', 'This sandbox generation was quarantined; reap it and use a new sandboxKey.');
      }
    } else {
      fileSystem.mkdirSync(paths.root, { recursive: true, ...(platform === 'linux' ? { mode: 0o700 } : {}) });
      writeJsonAtomic(paths.marker, {
        version: 3, scope, contract: CONTRACT, sandboxId, operationId,
        agent: agentName, networkMode, imageId,
        createdAt: new Date(now()).toISOString()
      });
    }
    const rootStat = fileSystem.lstatSync(paths.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw sandboxError('SANDBOX_PATH_INVALID', 'The managed sandbox root must be a real directory.');
    }
    ensureDir(paths.workspace);
    ensureDir(path.join(paths.workspace, 'artifacts'));
    for (const directory of [paths.workspace, path.join(paths.workspace, 'artifacts')]) {
      const stat = fileSystem.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw sandboxError('SANDBOX_PATH_INVALID', 'Managed workspace directories may not be links.');
      }
    }
  }

  function create(value = {}) {
    const input = requireObject(value, 'sandbox.create input');
    exactKeys(input, new Set(['agent', 'taskKey', 'sandboxKey', 'networkMode', 'leaseSeconds']), 'sandbox.create input');
    const agentName = agent(input.agent);
    const taskKey = stableKey(input.taskKey, 'taskKey');
    const sandboxKey = stableKey(input.sandboxKey, 'sandboxKey');
    const networkMode = input.networkMode === undefined ? 'none' : input.networkMode;
    if (!NETWORK_MODES.has(networkMode)) throw sandboxError('SANDBOX_INPUT_INVALID', 'networkMode is invalid.');
    const requestedLeaseMs = leaseMs(input.leaseSeconds);
    const creationLeaseMs = Math.max(requestedLeaseMs, MIN_CREATE_LEASE_MS);
    const sandboxId = sandboxIdFor(agentName, sandboxKey, scope);
    const legacyId = legacySandboxIdFor(agentName, sandboxKey);
    const legacyPaths = sandboxPaths(legacyId);
    if (fileSystem.existsSync(legacyPaths.marker)) {
      sandboxMarker(legacyPaths, legacyId);
      throw sandboxError('SANDBOX_LEGACY_REAP_REQUIRED', 'This sandbox key has an existing legacy workspace. Close or reap that generation, then use a new sandboxKey.');
    }
    const paths = sandboxPaths(sandboxId);
    if (paths.workspace.includes(',')) throw sandboxError('SANDBOX_PATH_INVALID', 'Docker bind source paths may not contain commas.');
    assertDockerCompatible();
    const image = verifyImage();
    return withCreateGuard(() => {
      assertAdmission(agentName);
      const inputHash = hashInput({
        contract: CONTRACT, sandboxId, agent: agentName, networkMode,
        limits: RESOURCE_LIMITS, imageId: image.imageId
      });
      const reservation = state().reserveOperation({
        type: OPERATION_TYPE,
        key: `${agentName}:${sandboxKey}`,
        inputHash,
        leaseMs: creationLeaseMs,
        ownerId: `sandbox:${agentName}:${shortDigest(taskKey)}`
      });
      if (reservation.disposition !== 'reserved') {
        throw sandboxError('SANDBOX_ALREADY_COMPLETED', 'This sandbox key was already cleaned up; use a new sandboxKey.');
      }
      const executing = state().markOperationExecuting(reservation.handle, { leaseMs: creationLeaseMs });
      const handle = executing.handle;
      try {
        prepareWorkspace(paths, sandboxId, handle.operationId, {
          agentName, networkMode, imageId: image.imageId
        });
        if (platform === 'linux') requireLinuxWorkspace().prepare({ workspace: paths.workspace, imageId: image.imageId });
        if (networkMode === 'fixture') {
          auditIntent('sandbox.network.create.intent', sandboxId, { networkMode: 'internal-fixture' });
          docker([
            'network', 'create', '--driver', 'bridge', '--internal',
            '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated',
            '--label', `${MANAGED_LABEL}=${MANAGED_VALUE}`,
            '--label', `org.toolsenabled.sandbox.id=${sandboxId}`,
            '--label', `${SCOPE_LABEL}=${scope}`,
            '--label', `org.toolsenabled.sandbox.operation=${handle.operationId}`,
            paths.networkName
          ], 'sandbox network creation');
          const network = inspect('network', paths.networkName);
          assertFixtureNetworkBoundary(network, sandboxId);
          auditIntent('sandbox.container.create.intent', sandboxId, { role: 'fixture' });
          docker(fixtureContainerArgs({
            name: paths.fixtureName, sandboxId, imageId: image.imageId,
            handle, agentName
          }), 'fixture container creation', { timeoutMs: 60_000 });
          const fixture = inspect('container', paths.fixtureName);
          assertContainerBoundary(fixture, {
            sandboxId,
            role: 'fixture',
            operationId: handle.operationId,
            imageId: image.imageId,
            networkMode: 'fixture'
          });
        }
        auditIntent('sandbox.container.create.intent', sandboxId, { role: 'browser', networkMode });
        docker(browserContainerArgs({
          name: paths.browserName, sandboxId, imageId: image.imageId, handle,
          agentName, networkMode, workspace: paths.workspace
        }), 'browser container creation', { timeoutMs: 60_000 });
        const browser = inspect('container', paths.browserName);
        assertContainerBoundary(browser, {
          sandboxId,
          role: 'browser',
          operationId: handle.operationId,
          imageId: image.imageId,
          networkMode,
          workspace: paths.workspace
        });
        return {
          sandboxId,
          handle: publicHandle('sandboxId', sandboxId, handle),
          agent: agentName,
          networkMode,
          fixtureUrl: networkMode === 'fixture' ? 'http://fixture:8080' : null,
          workspacePath: paths.workspace,
          imageId: image.imageId,
          limits: RESOURCE_LIMITS.browser,
          isolation: {
            rootFilesystemReadOnly: true,
            nonRoot: '10001:10001',
            capabilitiesDropped: 'ALL',
            noNewPrivileges: true,
            hostDockerSocket: false,
            hostSecrets: false,
            hostBrowserProfile: false,
            network: networkMode === 'none' ? 'none' : 'internal-fixture-only'
          }
        };
      } catch (caught) {
        bestEffortPartialCleanup(paths, sandboxId, handle.operationId);
        try {
          state().failOperation(handle, {
            errorCode: caught.code && /^[A-Za-z0-9_.:-]+$/.test(caught.code) ? caught.code : 'SANDBOX_CREATE_FAILED',
            errorMessage: auditor.redact(caught.message || String(caught)).slice(0, 1000)
          });
        } catch { /* retain the original error */ }
        throw caught;
      }
    });
  }

  function heartbeat(value = {}) {
    const input = requireObject(value, 'sandbox.heartbeat input');
    exactKeys(input, new Set(['handle', 'leaseSeconds']), 'sandbox.heartbeat input');
    const active = requireActiveSandbox(
      input.handle,
      Math.max(MIN_WORKSPACE_LEASE_MS, leaseMs(input.leaseSeconds))
    );
    return {
      sandboxId: active.parsed.resourceId,
      handle: publicHandle('sandboxId', active.parsed.resourceId, active.renewed.handle)
    };
  }

  function inspectSandbox(sandboxId) {
    safeString(sandboxId, 'sandboxId', { max: 25, pattern: SANDBOX_ID_RE });
    const paths = sandboxPaths(sandboxId);
    const browser = inspect('container', paths.browserName, { optional: true });
    const quarantined = fileSystem.existsSync(paths.quarantine);
    if (!browser) return {
      exists: false,
      sandboxId,
      quarantined,
      reapRequired: quarantined || fileSystem.existsSync(paths.root)
    };
    assertManagedContainer(browser, sandboxId, 'browser');
    const labels = labelsFromInspect(browser);
    const operationId = labels['org.toolsenabled.sandbox.operation'];
    const marker = sandboxMarker(paths, sandboxId, operationId);
    const operation = state().getOperation({ id: operationId });
    const fixture = inspect('container', paths.fixtureName, { optional: true });
    if (fixture) assertManagedContainer(fixture, sandboxId, 'fixture', operationId);
    const network = inspect('network', paths.networkName, { optional: true });
    if (network) assertManagedNetwork(network, sandboxId);
    let boundaryErrorCode = null;
    try {
      assertContainerBoundary(browser, {
        sandboxId,
        role: 'browser',
        operationId,
        imageId: marker.imageId,
        networkMode: marker.networkMode,
        workspace: paths.workspace
      });
      if (marker.networkMode === 'fixture') {
        if (!fixture || !network) {
          throw sandboxError('SANDBOX_NETWORK_ISOLATION_FAILED', 'The required fixture isolation resources are missing.');
        }
        assertFixtureNetworkBoundary(network, sandboxId);
        assertContainerBoundary(fixture, {
          sandboxId,
          role: 'fixture',
          operationId,
          imageId: marker.imageId,
          networkMode: 'fixture'
        });
      } else if (fixture || network) {
        throw sandboxError('SANDBOX_NETWORK_ISOLATION_FAILED', 'A no-network sandbox has unexpected fixture resources.');
      }
    } catch (error) {
      boundaryErrorCode = error.code || 'SANDBOX_CONTAINER_ISOLATION_FAILED';
    }
    const hostConfig = plainObject(browser.HostConfig) ? browser.HostConfig : {};
    const mounts = Array.isArray(browser.Mounts) ? browser.Mounts : [];
    const networkOptions = network && plainObject(network.Options) ? network.Options : {};
    return {
      exists: true,
      sandboxId,
      agent: labels['org.toolsenabled.sandbox.agent'] || null,
      running: Boolean(browser.State && browser.State.Running),
      browserContainerId: String(browser.Id || '').slice(0, 12),
      fixtureRunning: fixture ? Boolean(fixture.State && fixture.State.Running) : false,
      networkMode: marker.networkMode,
      workspacePath: paths.workspace,
      quarantined,
      reapRequired: quarantined,
      operation: operation ? {
        id: operation.id,
        status: operation.status,
        fence: operation.fence,
        leaseExpiresAtMs: operation.leaseExpiresAtMs
      } : null,
      observed: {
        readOnlyRootfs: hostConfig.ReadonlyRootfs === true,
        capDrop: Array.isArray(hostConfig.CapDrop) ? hostConfig.CapDrop : [],
        securityOpt: Array.isArray(hostConfig.SecurityOpt) ? hostConfig.SecurityOpt : [],
        pidsLimit: hostConfig.PidsLimit,
        memoryBytes: hostConfig.Memory,
        nanoCpus: hostConfig.NanoCpus,
        networkMode: hostConfig.NetworkMode,
        publishedPorts: hasPublishedPorts(hostConfig.PortBindings)
          || hasPublishedPorts(browser.NetworkSettings && browser.NetworkSettings.Ports),
        boundaryValid: boundaryErrorCode === null,
        boundaryErrorCode,
        networkInternal: network ? network.Internal === true : null,
        networkGatewayModeIpv4: network
          ? networkOptions['com.docker.network.bridge.gateway_mode_ipv4'] || null
          : null,
        mountDestinations: mounts.map(item => item && item.Destination).filter(item => typeof item === 'string').slice(0, 20),
        hostDockerSocketMounted: mounts.some(item => item && /(?:docker\.sock|docker_engine)/i.test(String(item.Source || '')))
      }
    };
  }

  function status(value = {}) {
    const input = requireObject(value, 'sandbox.status input');
    exactKeys(input, new Set(['sandboxId']), 'sandbox.status input');
    return inspectSandbox(input.sandboxId);
  }

  function requireActiveSandbox(handleValue, requestedLeaseMs) {
    const parsed = operationHandle(handleValue, 'sandboxId');
    const paths = sandboxPaths(parsed.resourceId);
    if (fileSystem.existsSync(paths.quarantine)) {
      throw sandboxError('SANDBOX_QUARANTINED', 'The sandbox failed containment reset and must be reaped.');
    }
    const marker = sandboxMarker(paths, parsed.resourceId, parsed.lease.operationId);
    const browser = inspect('container', paths.browserName);
    assertManagedContainer(browser, parsed.resourceId, 'browser', parsed.lease.operationId);
    const renewed = state().heartbeatOperation(parsed.lease, { leaseMs: requestedLeaseMs });
    const active = { parsed, renewed, paths, browser, marker };
    try {
      const image = verifyImage();
      if (image.imageId !== marker.imageId) {
        throw sandboxError('SANDBOX_IMAGE_LOCK_STALE', 'The active sandbox image no longer matches the immutable image lock.');
      }
      assertActiveSandboxBoundary(active);
    } catch (error) {
      quarantineSandbox(active, error);
      throw error;
    }
    active.renewed = state().heartbeatOperation(active.renewed.handle, { leaseMs: requestedLeaseMs });
    return active;
  }

  function assertActiveSandboxBoundary(active) {
    const { parsed, paths, marker } = active;
    const browser = inspect('container', paths.browserName);
    if (active.browser && active.browser.Id && browser.Id !== active.browser.Id) {
      throw sandboxError('SANDBOX_OWNERSHIP_MISMATCH', 'The sandbox browser container identity changed unexpectedly.');
    }
    assertContainerBoundary(browser, {
      sandboxId: parsed.resourceId,
      role: 'browser',
      operationId: parsed.lease.operationId,
      imageId: marker.imageId,
      networkMode: marker.networkMode,
      workspace: paths.workspace
    });
    if (marker.networkMode === 'fixture') {
      const network = inspect('network', paths.networkName);
      assertFixtureNetworkBoundary(network, parsed.resourceId);
      const fixture = inspect('container', paths.fixtureName);
      assertContainerBoundary(fixture, {
        sandboxId: parsed.resourceId,
        role: 'fixture',
        operationId: parsed.lease.operationId,
        imageId: marker.imageId,
        networkMode: 'fixture'
      });
    } else if (inspect('network', paths.networkName, { optional: true })
      || inspect('container', paths.fixtureName, { optional: true })) {
      throw sandboxError('SANDBOX_NETWORK_ISOLATION_FAILED', 'A no-network sandbox has unexpected fixture resources.');
    }
    active.browser = browser;
    return browser;
  }

  function relativeWorkspacePath(relativePath, label = 'path') {
    safeString(relativePath, label, { max: 500 });
    if (relativePath.includes('\\') || relativePath.startsWith('/') || relativePath.endsWith('/')) {
      throw sandboxError('SANDBOX_PATH_INVALID', `${label} must be a slash-separated relative path.`);
    }
    const segments = relativePath.split('/');
    if (segments.length > 12 || segments.some(segment => !SAFE_RELATIVE_SEGMENT_RE.test(segment) || segment === '.' || segment === '..')) {
      throw sandboxError('SANDBOX_PATH_INVALID', `${label} contains an invalid segment.`);
    }
    return segments;
  }

  function acquireExecLock(paths) {
    const attempt = () => {
      const descriptor = fileSystem.openSync(paths.execLock, 'wx');
      fileSystem.writeFileSync(descriptor, `${JSON.stringify({
        version: 1,
        pid: process.pid,
        createdAtMs: now()
      })}\n`, 'utf8');
      return { descriptor, recoveredStale: false };
    };
    try { return attempt(); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const prior = readJson(paths.execLock, null);
    const stale = plainObject(prior) && Number.isSafeInteger(prior.pid) && prior.pid > 0
      && Number.isSafeInteger(prior.createdAtMs) && now() - prior.createdAtMs > 120_000;
    let ownerAlive = true;
    if (stale) {
      try { process.kill(prior.pid, 0); } catch (error) {
        if (error.code === 'ESRCH') ownerAlive = false;
      }
    }
    if (!stale || ownerAlive) {
      throw sandboxError('SANDBOX_EXEC_BUSY', 'Another bounded command currently owns this sandbox.');
    }
    fileSystem.unlinkSync(paths.execLock);
    try {
      const acquired = attempt();
      return { ...acquired, recoveredStale: true };
    } catch (error) {
      if (error.code === 'EEXIST') throw sandboxError('SANDBOX_EXEC_BUSY', 'Another bounded command acquired this sandbox.');
      throw error;
    }
  }

  function releaseExecLock(paths, lock) {
    try { fileSystem.closeSync(lock.descriptor); } finally {
      releaseGuardFile(
        paths.execLock,
        'SANDBOX_EXEC_GUARD_RELEASE_FAILED',
        'The bounded-command guard could not be released; explicit cleanup may be required.'
      );
    }
  }

  function containmentResetError(error) {
    return sandboxError('SANDBOX_CONTAINER_RESET_FAILED', 'The sandbox container could not be reset to its trusted idle process.', {
      code: error && error.code && /^[A-Za-z0-9_.:-]+$/.test(error.code)
        ? error.code
        : 'SANDBOX_DOCKER_FAILED'
    });
  }

  function quarantineSandbox(active, cause) {
    const code = cause && cause.code && /^[A-Za-z0-9_.:-]+$/.test(cause.code)
      ? cause.code
      : 'SANDBOX_CONTAINMENT_UNKNOWN';
    try {
      writeJsonAtomic(active.paths.quarantine, {
        version: 1,
        contract: CONTRACT,
        sandboxId: active.parsed.resourceId,
        operationId: active.parsed.lease.operationId,
        errorCode: code,
        quarantinedAt: new Date(now()).toISOString()
      });
    } catch { /* durable operation state and exact container removal still fail closed */ }
    try {
      state().markOperationUncertain(
        active.renewed && active.renewed.handle ? active.renewed.handle : active.parsed.lease,
        {
          errorCode: 'SANDBOX_CONTAINER_RESET_FAILED',
          errorMessage: 'Sandbox containment could not be re-established; explicit reap is required.'
        }
      );
    } catch { /* a previously uncertain lease already rejects further heartbeats */ }
    try {
      removeOwnedContainer(
        active.paths.browserName,
        active.parsed.resourceId,
        'browser',
        active.parsed.lease.operationId,
        active.browser && active.browser.Id
      );
    } catch { /* never remove a replaced or ownership-mismatched container */ }
  }

  function resetBrowserContainer(active, reason) {
    auditIntent('sandbox.container.reset.intent', active.parsed.resourceId, {
      role: 'browser', reason
    });
    docker(
      ['container', 'restart', '--time', '1', active.browser.Id],
      'sandbox process reset',
      { timeoutMs: 30_000 }
    );
    return assertActiveSandboxBoundary(active);
  }

  function withWorkspaceAccess(active, callback) {
    const lock = acquireExecLock(active.paths);
    try {
      if (lock.recoveredStale) {
        try {
          resetBrowserContainer(active, 'stale-workspace-access-recovery');
        } catch (error) {
          const resetError = containmentResetError(error);
          quarantineSandbox(active, resetError);
          throw resetError;
        }
      }
      return callback();
    } finally {
      releaseExecLock(active.paths, lock);
    }
  }

  function pathContainedBy(parent, candidate) {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  function realWorkspaceRoot(workspace) {
    const sandboxRoot = path.dirname(workspace);
    for (const directory of [sandboxRoot, workspace]) {
      if (!fileSystem.existsSync(directory)) {
        throw sandboxError('SANDBOX_PATH_INVALID', 'The managed workspace directory is missing.');
      }
      const stat = fileSystem.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw sandboxError('SANDBOX_PATH_INVALID', 'Managed workspace roots may not be links.');
      }
    }
    const realSandboxRoot = fileSystem.realpathSync(sandboxRoot);
    const realWorkspace = fileSystem.realpathSync(workspace);
    if (!pathContainedBy(realSandboxRoot, realWorkspace)) {
      throw sandboxError('SANDBOX_PATH_INVALID', 'The workspace resolved outside its owned sandbox root.');
    }
    return realWorkspace;
  }

  function safeHostPath(workspace, relativePath, { createParents = false } = {}) {
    const segments = relativeWorkspacePath(relativePath);
    const realWorkspace = realWorkspaceRoot(workspace);
    let cursor = realWorkspace;
    for (let index = 0; index < segments.length - 1; index += 1) {
      cursor = path.join(cursor, segments[index]);
      if (!fileSystem.existsSync(cursor)) {
        if (!createParents) throw sandboxError('SANDBOX_FILE_NOT_FOUND', 'A workspace parent directory does not exist.');
        fileSystem.mkdirSync(cursor);
      }
      const stat = fileSystem.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw sandboxError('SANDBOX_PATH_INVALID', 'Workspace paths may not traverse links or non-directories.');
      }
      if (!pathContainedBy(realWorkspace, fileSystem.realpathSync(cursor))) {
        throw sandboxError('SANDBOX_PATH_INVALID', 'A workspace parent resolved outside its root.');
      }
    }
    const target = path.join(realWorkspace, ...segments);
    const relative = path.relative(realWorkspace, path.resolve(target));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw sandboxError('SANDBOX_PATH_INVALID', 'Workspace path escaped its root.');
    if (fileSystem.existsSync(target)) {
      const stat = fileSystem.lstatSync(target);
      if (stat.isSymbolicLink() || !pathContainedBy(realWorkspace, fileSystem.realpathSync(target))) {
        throw sandboxError('SANDBOX_PATH_INVALID', 'Workspace files may not be links or resolve outside the workspace.');
      }
    }
    return target;
  }

  function workspaceWrite(value = {}) {
    const input = requireObject(value, 'sandbox.workspace_write input');
    exactKeys(input, new Set(['handle', 'path', 'content', 'leaseSeconds']), 'sandbox.workspace_write input');
    if (typeof input.content !== 'string' || Buffer.byteLength(input.content, 'utf8') > MAX_WORKSPACE_TEXT_BYTES) {
      throw sandboxError('SANDBOX_INPUT_INVALID', `content must be UTF-8 text up to ${MAX_WORKSPACE_TEXT_BYTES} bytes.`);
    }
    const active = requireActiveSandbox(
      input.handle,
      Math.max(MIN_WORKSPACE_LEASE_MS, leaseMs(input.leaseSeconds))
    );
    return withWorkspaceAccess(active, () => {
      const target = safeHostPath(active.paths.workspace, input.path, { createParents: true });
      if (fileSystem.existsSync(target) && !fileSystem.lstatSync(target).isFile()) {
        throw sandboxError('SANDBOX_PATH_INVALID', 'The workspace target is not a regular file.');
      }
      const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        fileSystem.writeFileSync(temp, input.content, { encoding: 'utf8', flag: 'wx' });
        fileSystem.renameSync(temp, target);
      } finally {
        try { if (fileSystem.existsSync(temp)) fileSystem.unlinkSync(temp); } catch { /* best effort */ }
      }
      return {
        sandboxId: active.parsed.resourceId,
        path: input.path,
        bytes: Buffer.byteLength(input.content, 'utf8'),
        handle: publicHandle('sandboxId', active.parsed.resourceId, active.renewed.handle)
      };
    });
  }

  function workspaceRead(value = {}) {
    const input = requireObject(value, 'sandbox.workspace_read input');
    exactKeys(input, new Set(['handle', 'path', 'leaseSeconds']), 'sandbox.workspace_read input');
    const active = requireActiveSandbox(
      input.handle,
      Math.max(MIN_WORKSPACE_LEASE_MS, leaseMs(input.leaseSeconds))
    );
    return withWorkspaceAccess(active, () => {
      const target = safeHostPath(active.paths.workspace, input.path);
      if (!fileSystem.existsSync(target) || !fileSystem.lstatSync(target).isFile()) {
        throw sandboxError('SANDBOX_FILE_NOT_FOUND', 'The workspace file does not exist.');
      }
      const size = fileSystem.statSync(target).size;
      if (size > MAX_READ_BYTES) throw sandboxError('SANDBOX_FILE_TOO_LARGE', `Workspace reads are limited to ${MAX_READ_BYTES} bytes.`);
      const content = fileSystem.readFileSync(target, 'utf8');
      return {
        sandboxId: active.parsed.resourceId,
        path: input.path,
        bytes: size,
        content,
        contentTrust: 'untrusted',
        grantsAuthority: false,
        handle: publicHandle('sandboxId', active.parsed.resourceId, active.renewed.handle)
      };
    });
  }

  function execute(value = {}) {
    const input = requireObject(value, 'sandbox.exec input');
    exactKeys(input, new Set(['handle', 'scriptPath', 'args', 'timeoutSeconds', 'leaseSeconds']), 'sandbox.exec input');
    const timeoutSeconds = input.timeoutSeconds === undefined
      ? 30 : safeInteger(input.timeoutSeconds, 'timeoutSeconds', { min: 1, max: 60 });
    const requestedLease = Math.max(
      MIN_WORKSPACE_LEASE_MS,
      leaseMs(input.leaseSeconds),
      timeoutSeconds * 1000 + EXEC_RECOVERY_MARGIN_MS
    );
    if (requestedLease > 900_000) throw sandboxError('SANDBOX_INPUT_INVALID', 'Requested lease exceeds the maximum.');
    const active = requireActiveSandbox(input.handle, requestedLease);
    const segments = relativeWorkspacePath(input.scriptPath, 'scriptPath');
    if (!/\.(?:cjs|mjs|js)$/i.test(segments.at(-1))) {
      throw sandboxError('SANDBOX_INPUT_INVALID', 'scriptPath must name a JavaScript module.');
    }
    const args = input.args === undefined ? [] : input.args;
    if (!Array.isArray(args) || args.length > 32
      || args.some(item => typeof item !== 'string' || item.length > 512 || /[\u0000\r\n]/.test(item))) {
      throw sandboxError('SANDBOX_INPUT_INVALID', 'args must contain at most 32 bounded single-line strings.');
    }
    const containerScript = `/workspace/${segments.join('/')}`;
    const lock = acquireExecLock(active.paths);
    let result;
    let commandError;
    let thrownError;
    let resetError;
    try {
      if (lock.recoveredStale) {
        try {
          resetBrowserContainer(active, 'stale-exec-recovery');
        } catch (error) {
          throw containmentResetError(error);
        }
      }
      const target = safeHostPath(active.paths.workspace, input.scriptPath);
      if (!fileSystem.existsSync(target) || !fileSystem.lstatSync(target).isFile()) {
        throw sandboxError('SANDBOX_FILE_NOT_FOUND', 'The sandbox script does not exist.');
      }
      result = rawDocker([
        'container', 'exec',
        '--user', '10001:10001',
        '--workdir', '/workspace',
        active.paths.browserName,
        'node', '/opt/toolsenabled/bounded-exec.js',
        String(timeoutSeconds * 1000), 'node', containerScript, ...args
      ], {
        timeoutMs: (timeoutSeconds + 10) * 1000,
        maxBuffer: MAX_EXEC_OUTPUT_BYTES + 16 * 1024
      });
      if (result.error) commandError = dockerFailure(result, 'sandbox command', auditor.redact);
    } catch (error) {
      thrownError = error;
    } finally {
      try {
        resetBrowserContainer(active, 'post-exec');
      } catch (error) {
        resetError = containmentResetError(error);
        quarantineSandbox(active, resetError);
      }
      releaseExecLock(active.paths, lock);
    }
    if (resetError) throw resetError;
    if (thrownError) throw thrownError;
    if (commandError) throw commandError;
    const stdout = result.stdout.slice(0, MAX_EXEC_OUTPUT_BYTES);
    const stderr = result.stderr.slice(0, MAX_EXEC_OUTPUT_BYTES);
    return {
      sandboxId: active.parsed.resourceId,
      exitCode: result.status,
      stdout,
      stderr,
      truncated: result.stdout.length > stdout.length || result.stderr.length > stderr.length,
      contentTrust: 'untrusted',
      grantsAuthority: false,
      handle: publicHandle('sandboxId', active.parsed.resourceId, active.renewed.handle)
    };
  }

  function artifactRead(value = {}) {
    const input = requireObject(value, 'sandbox.artifact_read input');
    exactKeys(input, new Set(['handle', 'name', 'leaseSeconds']), 'sandbox.artifact_read input');
    if (typeof input.name !== 'string' || !SAFE_RELATIVE_SEGMENT_RE.test(input.name)
      || !/\.png$/i.test(input.name) || input.name.length > 120) {
      throw sandboxError('SANDBOX_INPUT_INVALID', 'Select one direct PNG artifact name, not a host path.');
    }
    const active = requireActiveSandbox(input.handle, Math.max(MIN_WORKSPACE_LEASE_MS, leaseMs(input.leaseSeconds)));
    return withWorkspaceAccess(active, () => {
      const target = safeHostPath(active.paths.workspace, `artifacts/${input.name}`);
      const parents = [active.paths.workspace, path.dirname(target)];
      const identities = parents.map(parent => fileSystem.lstatSync(parent));
      const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
        && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
      const before = fileSystem.lstatSync(target);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw sandboxError('SANDBOX_PATH_INVALID', 'Artifact must be a single-link regular file.');
      if (before.size < 1 || before.size > 1024 * 1024) throw sandboxError('SANDBOX_FILE_TOO_LARGE', 'PNG artifacts must fit the 1-MiB image limit.');
      const fd = fileSystem.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      let bytes;
      try {
        const opened = fileSystem.fstatSync(fd);
        if (!opened.isFile() || !same(before, opened)) throw sandboxError('SANDBOX_PATH_INVALID', 'Artifact changed while opening.');
        bytes = Buffer.alloc(opened.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = fileSystem.readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (count < 1) throw sandboxError('SANDBOX_PATH_INVALID', 'Artifact changed while reading.');
          offset += count;
        }
        if (!same(opened, fileSystem.fstatSync(fd)) || !same(opened, fileSystem.lstatSync(target))
          || safeHostPath(active.paths.workspace, `artifacts/${input.name}`) !== target
          || parents.some((parent, index) => !same(identities[index], fileSystem.lstatSync(parent)))) {
          throw sandboxError('SANDBOX_PATH_INVALID', 'Artifact path or contents changed while reading.');
        }
      } finally { fileSystem.closeSync(fd); }
      // Deliberately support bounded non-interlaced 8-bit RGB/RGBA screenshots,
      // not arbitrary image formats or active markup. Check every chunk CRC and
      // bound decompression independently of the compressed-byte limit.
      const zlib = require('node:zlib');
      const invalid = () => { throw sandboxError('SANDBOX_IMAGE_INVALID', 'Artifact must be a valid bounded non-interlaced RGB/RGBA PNG screenshot.'); };
      if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) invalid();
      let at = 8, width, height, channels, ended = false, dataEnded = false;
      const compressed = [];
      while (at < bytes.length) {
        if (at + 12 > bytes.length) invalid();
        const length = bytes.readUInt32BE(at), kind = bytes.toString('ascii', at + 4, at + 8);
        const end = at + 12 + length;
        if (end > bytes.length || zlib.crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
        const chunk = bytes.subarray(at + 8, end - 4);
        if (at === 8) {
          if (kind !== 'IHDR' || length !== 13) invalid();
          width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
          channels = chunk[9] === 2 ? 3 : chunk[9] === 6 ? 4 : 0;
          if (!width || !height || width > 4096 || height > 4096 || width * height > 4_194_304
            || chunk[8] !== 8 || !channels || chunk[10] || chunk[11] || chunk[12]) invalid();
        } else if (kind === 'IDAT') {
          if (dataEnded) invalid();
          compressed.push(chunk);
        } else if (kind === 'IEND') {
          if (length || !compressed.length || end !== bytes.length) invalid();
          ended = true;
        } else {
          if (compressed.length) dataEnded = true;
          // Reject unknown critical chunks, animation, and executable metadata.
          const sizes = { sRGB: 1, gAMA: 4, cHRM: 32, pHYs: 9 };
          if (!Object.hasOwn(sizes, kind) || length !== sizes[kind] || compressed.length) invalid();
        }
        at = end;
      }
      if (!ended) invalid();
      const stride = 1 + width * channels, expected = stride * height;
      let pixels;
      try {
        const packed = Buffer.concat(compressed);
        const inflated = zlib.inflateSync(packed, { maxOutputLength: expected, info: true });
        if (inflated.engine.bytesWritten !== packed.length) invalid();
        pixels = inflated.buffer;
      } catch { invalid(); }
      if (pixels.length !== expected) invalid();
      for (let row = 0; row < height; row++) if (pixels[row * stride] > 4) invalid();
      const result = { sandboxId: active.parsed.resourceId, name: input.name, bytes: bytes.length,
        width, height, mimeType: 'image/png', contentTrust: 'untrusted', grantsAuthority: false,
        handle: publicHandle('sandboxId', active.parsed.resourceId, active.renewed.handle) };
      Object.defineProperty(result, '__mcpImage', { value: bytes, enumerable: false });
      return result;
    });
  }

  function artifacts(value = {}) {
    const input = requireObject(value, 'sandbox.artifacts input');
    exactKeys(input, new Set(['handle', 'leaseSeconds']), 'sandbox.artifacts input');
    const active = requireActiveSandbox(
      input.handle,
      Math.max(MIN_WORKSPACE_LEASE_MS, leaseMs(input.leaseSeconds))
    );
    return withWorkspaceAccess(active, () => {
      const workspaceRoot = realWorkspaceRoot(active.paths.workspace);
      const root = path.join(workspaceRoot, 'artifacts');
      const items = [];
      if (fileSystem.existsSync(root)) {
        const rootStat = fileSystem.lstatSync(root);
        if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
          throw sandboxError('SANDBOX_PATH_INVALID', 'The artifact root must be a real directory.');
        }
        const realArtifactRoot = fileSystem.realpathSync(root);
        if (!pathContainedBy(workspaceRoot, realArtifactRoot)) {
          throw sandboxError('SANDBOX_PATH_INVALID', 'The artifact root resolved outside the workspace.');
        }
        for (const entry of fileSystem.readdirSync(realArtifactRoot, { withFileTypes: true }).slice(0, 100)) {
          if (!SAFE_RELATIVE_SEGMENT_RE.test(entry.name)) continue;
          const target = path.join(realArtifactRoot, entry.name);
          const stat = fileSystem.lstatSync(target);
          if (!entry.isFile() || stat.isSymbolicLink() || !stat.isFile()) {
            throw sandboxError('SANDBOX_PATH_INVALID', 'Artifact entries must be regular files, never links.');
          }
          const realTarget = fileSystem.realpathSync(target);
          if (!pathContainedBy(realArtifactRoot, realTarget)) {
            throw sandboxError('SANDBOX_PATH_INVALID', 'An artifact resolved outside the artifact root.');
          }
          items.push({
            name: entry.name,
            bytes: stat.size,
            hostPath: realTarget
          });
        }
      }
      return {
        sandboxId: active.parsed.resourceId,
        artifacts: items,
        contentTrust: 'untrusted',
        grantsAuthority: false,
        handle: publicHandle('sandboxId', active.parsed.resourceId, active.renewed.handle)
      };
    });
  }

  function cleanup(value = {}) {
    const input = requireObject(value, 'sandbox.cleanup input');
    exactKeys(input, new Set(['handle']), 'sandbox.cleanup input');
    const parsed = operationHandle(input.handle, 'sandboxId');
    state().heartbeatOperation(parsed.lease, { leaseMs: MIN_CLEANUP_LEASE_MS });
    const paths = sandboxPaths(parsed.resourceId);
    if (fileSystem.existsSync(paths.execLock)) {
      throw sandboxError('SANDBOX_EXEC_BUSY', 'Wait for the active bounded command before cleanup.');
    }
    const removed = {
      browser: removeOwnedContainer(paths.browserName, parsed.resourceId, 'browser', parsed.lease.operationId),
      fixture: removeOwnedContainer(paths.fixtureName, parsed.resourceId, 'fixture', parsed.lease.operationId)
    };
    removed.network = removeOwnedNetwork(paths.networkName, parsed.resourceId, parsed.lease.operationId);
    removed.workspace = removeOwnedWorkspace(paths, parsed.resourceId, parsed.lease.operationId);
    const completed = state().succeedOperation(parsed.lease, {
      result: { sandboxId: parsed.resourceId, cleaned: true }
    });
    return { sandboxId: parsed.resourceId, cleaned: true, removed, operation: completed.operation };
  }

  function reap(value = {}) {
    const input = requireObject(value, 'sandbox.reap input');
    exactKeys(input, new Set(['sandboxId', 'confirmSandboxId']), 'sandbox.reap input');
    const sandboxId = safeString(input.sandboxId, 'sandboxId', { max: 25, pattern: SANDBOX_ID_RE });
    if (input.confirmSandboxId !== sandboxId) {
      throw sandboxError('SANDBOX_CONFIRMATION_MISMATCH', 'confirmSandboxId must exactly match sandboxId.');
    }
    const paths = sandboxPaths(sandboxId);
    const browser = inspect('container', paths.browserName, { optional: true });
    let operationId = null;
    let operation = null;
    if (browser) {
      assertManagedContainer(browser, sandboxId, 'browser');
      operationId = labelsFromInspect(browser)['org.toolsenabled.sandbox.operation'];
    } else if (fileSystem.existsSync(paths.marker)) {
      const marker = sandboxMarker(paths, sandboxId);
      operationId = marker.operationId;
    }
    if (operationId) operation = state().getOperation({ id: operationId });
    if (operation && ['reserved', 'executing'].includes(operation.status)
      && Number.isSafeInteger(operation.leaseExpiresAtMs) && operation.leaseExpiresAtMs > now()) {
      throw sandboxError('SANDBOX_LEASE_ACTIVE', 'Refusing to reap a sandbox with an active durable lease.');
    }
    const removed = {
      browser: removeOwnedContainer(paths.browserName, sandboxId, 'browser', operationId),
      fixture: removeOwnedContainer(paths.fixtureName, sandboxId, 'fixture', operationId)
    };
    removed.network = removeOwnedNetwork(paths.networkName, sandboxId, operationId);
    removed.workspace = removeOwnedWorkspace(paths, sandboxId, operationId);
    return {
      sandboxId,
      reaped: true,
      removed,
      durableOperation: operation ? { id: operation.id, status: operation.status } : null
    };
  }

  function profilePaths(profileId) {
    safeString(profileId, 'profileId', { max: 25, pattern: PROFILE_ID_RE });
    const root = path.resolve(authRoot, profileId);
    const relative = path.relative(path.resolve(authRoot), root);
    if (relative !== profileId || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw sandboxError('SANDBOX_PATH_INVALID', 'The auth profile path escaped its managed root.');
    }
    return {
      root,
      metadata: path.join(root, 'metadata.json'),
      encrypted: path.join(root, 'profile.enc.json'),
      lease: path.join(root, 'lease.json'),
      leaseGuard: path.join(root, '.lease.guard.json')
    };
  }

  function tokenHash(token) {
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  }

  function readAuthLease(paths, { optional = false } = {}) {
    if (!fileSystem.existsSync(paths.lease)) {
      if (optional) return null;
      throw sandboxError('SANDBOX_AUTH_PROFILE_LEASE_LOST', 'The auth-profile lease no longer exists.');
    }
    const record = readJson(paths.lease, null);
    if (!plainObject(record) || record.version !== 1 || !PROFILE_ID_RE.test(record.profileId || '')
      || typeof record.operationId !== 'string' || typeof record.ownerId !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.tokenHash || '')
      || !Number.isSafeInteger(record.operationFence) || record.operationFence < 1
      || !Number.isSafeInteger(record.slotFence) || record.slotFence < 1
      || !Number.isSafeInteger(record.expiresAtMs) || record.expiresAtMs < 0) {
      throw sandboxError('SANDBOX_STATE_INVALID', 'Auth-profile lease metadata is invalid.');
    }
    return record;
  }

  function acquireAuthGuard(paths) {
    const attempt = () => {
      const descriptor = fileSystem.openSync(paths.leaseGuard, 'wx');
      fileSystem.writeFileSync(descriptor, `${JSON.stringify({
        version: 1, pid: process.pid, createdAtMs: now()
      })}\n`, 'utf8');
      return descriptor;
    };
    try { return attempt(); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const prior = readJson(paths.leaseGuard, null);
    const stale = plainObject(prior) && Number.isSafeInteger(prior.pid) && prior.pid > 0
      && Number.isSafeInteger(prior.createdAtMs) && now() - prior.createdAtMs > 30_000;
    let ownerAlive = true;
    if (stale) {
      try { process.kill(prior.pid, 0); } catch (error) {
        if (error.code === 'ESRCH') ownerAlive = false;
      }
    }
    if (!stale || ownerAlive) {
      throw sandboxError('SANDBOX_AUTH_PROFILE_BUSY', 'Another process is updating this auth-profile lease.');
    }
    fileSystem.unlinkSync(paths.leaseGuard);
    try { return attempt(); } catch (error) {
      if (error.code === 'EEXIST') throw sandboxError('SANDBOX_AUTH_PROFILE_BUSY', 'Another process acquired this auth-profile lease.');
      throw error;
    }
  }

  function releaseAuthGuard(paths, descriptor) {
    try { fileSystem.closeSync(descriptor); } finally {
      releaseGuardFile(
        paths.leaseGuard,
        'SANDBOX_AUTH_GUARD_RELEASE_FAILED',
        'The auth-profile guard could not be released.'
      );
    }
  }

  function withAuthGuard(paths, callback) {
    for (const root of [authRoot, paths.root]) {
      const stat = fileSystem.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw sandboxError('SANDBOX_PATH_INVALID', 'Auth-profile directories must not be links.');
    }
    const descriptor = acquireAuthGuard(paths);
    try { return callback(); } finally { releaseAuthGuard(paths, descriptor); }
  }

  function authLeaseOperation(record) {
    const operation = state().getOperation({ id: record.operationId });
    if (!operation) {
      throw sandboxError('SANDBOX_AUTH_PROFILE_STATE_UNKNOWN', 'The durable auth-profile lease operation is missing.');
    }
    if (operation.type !== AUTH_OPERATION_TYPE
      || operation.key !== `${record.profileId}:${record.slotFence}`
      || operation.fence !== record.operationFence
      || (operation.status === 'executing' && operation.leaseOwner !== record.ownerId)) {
      throw sandboxError('SANDBOX_AUTH_PROFILE_STATE_UNKNOWN', 'The durable auth-profile lease binding is inconsistent.');
    }
    return operation;
  }

  function activeAuthLease(record, operation) {
    return Boolean(record && operation
      && operation.id === record.operationId
      && operation.fence === record.operationFence
      && operation.status === 'executing'
      && Number.isSafeInteger(operation.leaseExpiresAtMs)
      && operation.leaseExpiresAtMs > now());
  }

  function requireAuthLeaseHandle(handleValue) {
    const parsed = operationHandle(handleValue, 'profileId');
    const paths = profilePaths(parsed.resourceId);
    const record = readAuthLease(paths);
    const suppliedHash = Buffer.from(tokenHash(parsed.lease.token), 'hex');
    const expectedHash = Buffer.from(record.tokenHash, 'hex');
    if (record.profileId !== parsed.resourceId
      || record.operationId !== parsed.lease.operationId
      || record.ownerId !== parsed.lease.ownerId
      || record.operationFence !== parsed.lease.fence
      || record.slotFence !== parsed.slotFence
      || suppliedHash.length !== expectedHash.length
      || !crypto.timingSafeEqual(suppliedHash, expectedHash)) {
      throw sandboxError('SANDBOX_AUTH_PROFILE_LEASE_LOST', 'The auth-profile handle is stale or no longer owns the slot.');
    }
    return { parsed, paths, record };
  }

  function encryptionKey() {
    const candidate = crypto.randomBytes(32).toString('base64url');
    const encoded = getEncryptionSecret(AUTH_KEY_NAME, candidate);
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== encoded) {
      throw sandboxError('SANDBOX_AUTH_KEY_INVALID', 'The sandbox auth-profile encryption key is invalid.');
    }
    return decoded;
  }

  function encryptedEmptyProfile() {
    const key = encryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(CONTRACT, 'utf8'));
    const plaintext = Buffer.from(JSON.stringify({ version: 1, files: [] }), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    key.fill(0);
    plaintext.fill(0);
    return {
      version: 1,
      algorithm: 'aes-256-gcm',
      aad: CONTRACT,
      iv: iv.toString('base64url'),
      tag: tag.toString('base64url'),
      ciphertext: ciphertext.toString('base64url')
    };
  }

  function validateEncryptedProfile(paths) {
    const roots = [authRoot, paths.root];
    const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
      && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
    const rootStats = roots.map(root => {
      const stat = fileSystem.lstatSync(root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw sandboxError('SANDBOX_PATH_INVALID', 'Auth-profile directories must not be links.');
      return stat;
    });
    const before = fileSystem.lstatSync(paths.encrypted);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw sandboxError('SANDBOX_PATH_INVALID', 'Auth-profile envelope must be a single-link regular file.');
    if (before.size < 1 || before.size > 64 * 1024 * 1024) throw sandboxError('SANDBOX_STATE_INVALID', 'The encrypted auth-profile envelope is missing or too large.');
    const fd = fileSystem.openSync(paths.encrypted, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    let envelope;
    try {
      const opened = fileSystem.fstatSync(fd);
      if (!opened.isFile() || !same(before, opened)) throw sandboxError('SANDBOX_PATH_INVALID', 'Auth-profile envelope changed while opening.');
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fileSystem.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw sandboxError('SANDBOX_PATH_INVALID', 'Auth-profile envelope changed while reading.');
        offset += count;
      }
      if (!same(opened, fileSystem.fstatSync(fd)) || !same(opened, fileSystem.lstatSync(paths.encrypted))
        || roots.some((root, index) => !same(rootStats[index], fileSystem.lstatSync(root)))) throw sandboxError('SANDBOX_PATH_INVALID', 'Auth-profile envelope or directory changed while reading.');
      try { envelope = JSON.parse(bytes.toString('utf8')); } catch { throw sandboxError('SANDBOX_STATE_INVALID', 'The encrypted auth-profile envelope is invalid.'); }
    } finally { fileSystem.closeSync(fd); }
    if (!plainObject(envelope) || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm'
      || envelope.aad !== CONTRACT
      || !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv || '')
      || !/^[A-Za-z0-9_-]{22}$/.test(envelope.tag || '')
      || typeof envelope.ciphertext !== 'string' || envelope.ciphertext.length < 1
      || !/^[A-Za-z0-9_-]+$/.test(envelope.ciphertext)) {
      throw sandboxError('SANDBOX_STATE_INVALID', 'The encrypted auth-profile envelope is missing or invalid.');
    }
    return envelope;
  }

  function authenticateEncryptedProfile(paths) {
    const envelope = validateEncryptedProfile(paths);
    const key = encryptionKey();
    let plaintext;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
      decipher.setAAD(Buffer.from(CONTRACT, 'utf8'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final()
      ]);
      const manifest = JSON.parse(plaintext.toString('utf8'));
      if (!plainObject(manifest) || manifest.version !== 1 || !Array.isArray(manifest.files)) {
        throw new Error('invalid manifest');
      }
      return true;
    } catch {
      throw sandboxError('SANDBOX_AUTH_PROFILE_DECRYPT_FAILED', 'The encrypted auth-profile archive failed authentication.');
    } finally {
      key.fill(0);
      if (plaintext) plaintext.fill(0);
    }
  }

  function validateProfileMetadata(metadata, profileId) {
    if (metadata.version !== 1 || metadata.contract !== CONTRACT || metadata.profileId !== profileId
      || typeof metadata.account !== 'string' || typeof metadata.purpose !== 'string'
      || typeof metadata.provisioned !== 'boolean' || metadata.encryptedAtRest !== true
      || !Number.isSafeInteger(metadata.lastFence) || metadata.lastFence < 0) {
      throw sandboxError('SANDBOX_STATE_INVALID', 'Auth profile metadata is invalid.');
    }
    return metadata;
  }

  function createAuthProfile(value = {}) {
    const input = requireObject(value, 'sandbox.auth_profile_create input');
    exactKeys(input, new Set(['account', 'purpose']), 'sandbox.auth_profile_create input');
    const account = safeString(input.account, 'account', {
      max: 200, pattern: /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,199}$/
    });
    const purpose = safeString(input.purpose, 'purpose', {
      max: 80, pattern: /^[a-z0-9][a-z0-9._-]{2,79}$/
    });
    const profileId = profileIdFor(account, purpose);
    const paths = profilePaths(profileId);
    ensureDir(authRoot);
    try {
      fileSystem.mkdirSync(paths.root, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    return withAuthGuard(paths, () => {
      if (fileSystem.existsSync(paths.metadata)) {
        const metadata = validateProfileMetadata(readMetadata(paths.metadata), profileId);
        authenticateEncryptedProfile(paths);
        if (metadata.account !== account || metadata.purpose !== purpose) {
          throw sandboxError('SANDBOX_AUTH_PROFILE_CONFLICT', 'The deterministic auth profile identity conflicts with existing metadata.');
        }
        const record = readAuthLease(paths, { optional: true });
        const operation = record ? authLeaseOperation(record) : null;
        return { ...authProfilePublic(metadata, record, operation), replayed: true };
      }
      const unexpected = fileSystem.readdirSync(paths.root)
        .filter(name => name !== path.basename(paths.leaseGuard));
      if (unexpected.length) {
        throw sandboxError('SANDBOX_AUTH_PROFILE_INCOMPLETE', 'The auth-profile directory contains incomplete or foreign state.');
      }
      auditIntent('sandbox.auth_profile.create.intent', profileId, { purpose });
      const encrypted = encryptedEmptyProfile();
      const metadata = {
        version: 1,
        contract: CONTRACT,
        profileId,
        account,
        purpose,
        provisioned: false,
        encryptedAtRest: true,
        lastFence: 0,
        createdAt: new Date(now()).toISOString()
      };
      writeJsonAtomic(paths.encrypted, encrypted);
      writeJsonAtomic(paths.metadata, metadata);
      return { ...authProfilePublic(metadata), replayed: false };
    });
  }

  function authProfilePublic(metadata, record = null, operation = null) {
    const active = activeAuthLease(record, operation);
    return {
      profileId: metadata.profileId,
      account: metadata.account,
      purpose: metadata.purpose,
      provisioned: metadata.provisioned,
      signInRequired: !metadata.provisioned,
      encryptedAtRest: metadata.encryptedAtRest,
      cookieExportSupported: false,
      cdpExposure: 'none',
      hostBrowserUnaffected: true,
      browserSessionAvailable: false,
      readiness: 'control-plane-only',
      ownerSignInSupported: false,
      lease: record ? {
        active: Boolean(active),
        status: active ? 'executing' : 'expired_or_inactive',
        fence: record.slotFence,
        expiresAtMs: operation && operation.leaseExpiresAtMs !== null
          ? operation.leaseExpiresAtMs
          : record.expiresAtMs
      } : {
        active: false,
        status: metadata.lastFence === 0 ? 'never_leased' : 'released',
        fence: metadata.lastFence,
        expiresAtMs: null
      }
    };
  }

  function authProfileStatus(value = {}) {
    const input = requireObject(value, 'sandbox.auth_profile_status input');
    exactKeys(input, new Set(['profileId']), 'sandbox.auth_profile_status input');
    const profileId = safeString(input.profileId, 'profileId', { max: 25, pattern: PROFILE_ID_RE });
    const paths = profilePaths(profileId);
    if (!fileSystem.existsSync(paths.metadata)) return { exists: false, profileId };
    const metadata = validateProfileMetadata(readMetadata(paths.metadata), profileId);
    validateEncryptedProfile(paths);
    const record = readAuthLease(paths, { optional: true });
    const operation = record ? authLeaseOperation(record) : null;
    return { exists: true, ...authProfilePublic(metadata, record, operation) };
  }

  function leaseAuthProfile(value = {}) {
    const input = requireObject(value, 'sandbox.auth_profile_lease input');
    exactKeys(input, new Set(['profileId', 'agent', 'taskKey', 'leaseSeconds']), 'sandbox.auth_profile_lease input');
    const profileId = safeString(input.profileId, 'profileId', { max: 25, pattern: PROFILE_ID_RE });
    const agentName = agent(input.agent);
    const taskKey = stableKey(input.taskKey, 'taskKey');
    const requestedLeaseMs = leaseMs(input.leaseSeconds);
    const paths = profilePaths(profileId);
    if (!fileSystem.existsSync(paths.metadata)) throw sandboxError('SANDBOX_AUTH_PROFILE_NOT_FOUND', 'Auth profile does not exist.');
    return withAuthGuard(paths, () => {
      const metadata = validateProfileMetadata(readMetadata(paths.metadata), profileId);
      authenticateEncryptedProfile(paths);
      const prior = readAuthLease(paths, { optional: true });
      if (prior) {
        const priorOperation = authLeaseOperation(prior);
        if (activeAuthLease(prior, priorOperation)) {
          throw sandboxError('SANDBOX_AUTH_PROFILE_LEASED', 'The auth profile already has an active exclusive lease.');
        }
        fileSystem.unlinkSync(paths.lease);
      }
      const slotFence = metadata.lastFence + 1;
      const ownerId = `sandbox-auth:${agentName}:${shortDigest(taskKey)}`;
      const reservation = state().reserveOperation({
        type: AUTH_OPERATION_TYPE,
        key: `${profileId}:${slotFence}`,
        inputHash: hashInput({ contract: CONTRACT, profileId, slotFence }),
        ownerId,
        leaseMs: requestedLeaseMs
      });
      if (reservation.disposition !== 'reserved') {
        throw sandboxError('SANDBOX_AUTH_PROFILE_LEASE_CONFLICT', 'The auth profile lease generation already exists.');
      }
      const executing = state().markOperationExecuting(reservation.handle, { leaseMs: requestedLeaseMs });
      const updatedMetadata = { ...metadata, lastFence: slotFence };
      const record = {
        version: 1,
        profileId,
        operationId: executing.handle.operationId,
        ownerId: executing.handle.ownerId,
        tokenHash: tokenHash(executing.handle.token),
        operationFence: executing.handle.fence,
        slotFence,
        expiresAtMs: executing.handle.expiresAtMs
      };
      writeJsonAtomic(paths.metadata, updatedMetadata);
      writeJsonAtomic(paths.lease, record);
      return {
        profile: authProfilePublic(updatedMetadata, record, executing.operation),
        handle: publicAuthHandle(profileId, executing.handle, slotFence),
        browserStarted: false,
        nextGate: metadata.provisioned
          ? 'A mediated authenticated browser runner is not installed.'
          : 'Owner container sign-in is not implemented. This reserves only the control-plane slot; host sessions are never cloned.'
      };
    });
  }

  function heartbeatAuthProfile(value = {}) {
    const input = requireObject(value, 'sandbox.auth_profile_heartbeat input');
    exactKeys(input, new Set(['handle', 'leaseSeconds']), 'sandbox.auth_profile_heartbeat input');
    const initial = operationHandle(input.handle, 'profileId');
    const paths = profilePaths(initial.resourceId);
    return withAuthGuard(paths, () => {
      const owned = requireAuthLeaseHandle(input.handle);
      const renewed = state().heartbeatOperation(owned.parsed.lease, { leaseMs: leaseMs(input.leaseSeconds) });
      writeJsonAtomic(paths.lease, { ...owned.record, expiresAtMs: renewed.handle.expiresAtMs });
      return {
        profileId: owned.parsed.resourceId,
        handle: publicAuthHandle(owned.parsed.resourceId, renewed.handle, owned.parsed.slotFence)
      };
    });
  }

  function releaseAuthProfile(value = {}) {
    const input = requireObject(value, 'sandbox.auth_profile_release input');
    exactKeys(input, new Set(['handle']), 'sandbox.auth_profile_release input');
    const initial = operationHandle(input.handle, 'profileId');
    const paths = profilePaths(initial.resourceId);
    return withAuthGuard(paths, () => {
      const owned = requireAuthLeaseHandle(input.handle);
      const released = state().succeedOperation(owned.parsed.lease, {
        result: { profileId: owned.parsed.resourceId, released: true, slotFence: owned.parsed.slotFence }
      });
      fileSystem.unlinkSync(paths.lease);
      return {
        profileId: owned.parsed.resourceId,
        released: true,
        cookiesReturned: false,
        operation: {
          id: released.operation.id,
          status: released.operation.status,
          fence: owned.parsed.slotFence
        }
      };
    });
  }

  function revokeAuthProfile(value = {}) {
    const input = requireObject(value, 'sandbox.auth_profile_revoke input');
    exactKeys(input, new Set(['profileId', 'confirmProfileId']), 'sandbox.auth_profile_revoke input');
    const profileId = safeString(input.profileId, 'profileId', { max: 25, pattern: PROFILE_ID_RE });
    if (input.confirmProfileId !== profileId) {
      throw sandboxError('SANDBOX_CONFIRMATION_MISMATCH', 'confirmProfileId must exactly match profileId.');
    }
    const paths = profilePaths(profileId);
    if (!fileSystem.existsSync(paths.metadata)) return { profileId, revoked: false, reason: 'not_found' };
    const descriptor = acquireAuthGuard(paths);
    try {
      const metadata = validateProfileMetadata(readMetadata(paths.metadata), profileId);
      const record = readAuthLease(paths, { optional: true });
      const operation = record ? authLeaseOperation(record) : null;
      if (activeAuthLease(record, operation)) {
        throw sandboxError('SANDBOX_AUTH_PROFILE_LEASED', 'Release the active auth-profile lease before revoking it.');
      }
      auditIntent('sandbox.auth_profile.revoke.intent', profileId, {
        purpose: metadata.purpose
      });
      if (fileSystem.existsSync(paths.lease)) fileSystem.unlinkSync(paths.lease);
      fileSystem.unlinkSync(paths.encrypted);
      fileSystem.unlinkSync(paths.metadata);
    } finally {
      releaseAuthGuard(paths, descriptor);
    }
    fileSystem.rmdirSync(paths.root);
    return {
      profileId,
      revoked: true,
      recoverable: false,
      encryptedProfileDeleted: true,
      cookiesReturned: false
    };
  }

  function doctor() {
    const probe = probeDockerCompatibility();
    if (!probe.available || probe.compatible === null) {
      return {
        available: probe.available,
        compatible: probe.compatible,
        code: probe.code,
        ...(probe.message ? { message: probe.message } : {}),
        imageReady: false,
        contract: CONTRACT
      };
    }
    const server = probe.server;
    const info = probe.info;
    let imageReady = true;
    let imageCode = null;
    let imageId = null;
    try { imageId = verifyImage().imageId; }
    catch (error) {
      imageCode = error.code || 'SANDBOX_IMAGE_INVALID';
      imageReady = new Set([
        'SANDBOX_IMAGE_NOT_PROVISIONED',
        'SANDBOX_IMAGE_LOCK_INVALID',
        'SANDBOX_IMAGE_LOCK_STALE',
        'SANDBOX_IMAGE_UNTRUSTED'
      ]).has(imageCode) ? false : null;
    }
    const dockerMajor = Number.parseInt(String(server.Version || '').split('.')[0], 10);
    const isolatedGatewaySupported = Number.isSafeInteger(dockerMajor) && dockerMajor >= 28;
    return {
      available: true,
      compatible: probe.compatible,
      code: probe.code,
      incompatibilityReasons: probe.reasons,
      docker: {
        version: server.Version || null,
        os: server.Os || null,
        architecture: server.Arch || null,
        memoryLimit: info.MemoryLimit === true,
        pidsLimit: info.PidsLimit === true,
        isolatedGatewaySupported,
        cpuCount: Number.isSafeInteger(info.NCPU) ? info.NCPU : null,
        memoryBytes: Number.isSafeInteger(info.MemTotal) ? info.MemTotal : null
      },
      imageReady,
      imageCode,
      imageId,
      contract: CONTRACT,
      playwrightVersion: PLAYWRIGHT_VERSION,
      networkModes: [...NETWORK_MODES],
      authenticatedContainerSignInEstablished: false,
      hostBrowserRemainsOwnerOfExistingAuthenticatedSessions: true,
      localModelAccess: 'ToolsEnabled research/model tools only; never mounted or exposed to containers',
      capacity: {
        maxActiveSandboxes: MAX_ACTIVE_SANDBOXES,
        maxActivePerAgent: MAX_ACTIVE_PER_AGENT
      },
      limits: RESOURCE_LIMITS
    };
  }

  return {
    artifacts,
    artifactRead,
    authProfileStatus,
    cleanup,
    create,
    createAuthProfile,
    doctor,
    execute,
    heartbeat,
    heartbeatAuthProfile,
    imageLockWrite,
    imageTag,
    prepareImage,
    inspectSandbox,
    leaseAuthProfile,
    reap,
    releaseAuthProfile,
    revokeAuthProfile,
    status,
    verifyImage,
    workspaceRead,
    workspaceWrite
  };
}

const provider = createSandboxProvider();

module.exports = {
  AGENTS,
  AUTH_KEY_NAME,
  AUTH_OPERATION_TYPE,
  AgentSandboxError,
  BASE_DIGEST,
  CONTRACT,
  DISPOSABLE_ROOT,
  IMAGE_LOCK_PATH,
  IMAGE_SOURCE_FILES,
  IMAGE_TAG,
  MAX_EXEC_OUTPUT_BYTES,
  MAX_ACTIVE_PER_AGENT,
  MAX_ACTIVE_SANDBOXES,
  MAX_READ_BYTES,
  MAX_WORKSPACE_TEXT_BYTES,
  NETWORK_MODES,
  OPERATION_TYPE,
  PLAYWRIGHT_VERSION,
  RESOURCE_LIMITS,
  ...provider,
  contextDigest,
  createSandboxProvider,
  profileIdFor,
  sandboxIdFor
};
