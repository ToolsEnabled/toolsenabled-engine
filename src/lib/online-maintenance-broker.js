'use strict';

// Disabled-by-default, transport-agnostic executor for the fixed online
// maintenance contract.  All platform work is behind narrow *trusted* adapters:
// no network listener, shell command, path string, runtime operation spec, or
// inherited environment crosses this module's request boundary.
// `openBeneath` must atomically open beneath the host-owned root (with its
// platform's no-follow / no-reparse-point semantics) and issue a capability ID
// consumed by the paired launcher.  It must never return a path claim.
const maintenance = require('./online-maintenance-contract');

const BROKER_VERSION = 'online-maintenance-broker.v2';
const FIXED_EXECUTABLE = '/usr/local/libexec/toolsenabled-online-maintenance-handler';
const FIXED_ENV = Object.freeze({ LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' });
const MAX_SESSION_COMMANDS = maintenance.MAX_SESSION_COMMANDS;
const SAFE_ID = /^[A-Za-z0-9_-]{8,160}$/;
const SAFE_UID = /^[A-Za-z0-9._:-]{1,160}$/;
const SAFE_SID = /^[A-Za-z0-9._:-]{1,240}$/;
// Keep the deadline result outside the launch adapter's value namespace. A
// malformed adapter is allowed to return null, but that could not establish
// that the deadline expired and must be refused as malformed instead.
const DEADLINE_EXPIRED = Symbol('online-maintenance-deadline-expired');
const OPERATION_TABLE = Object.freeze({
  'backup.manifest': Object.freeze({ rootId: 'backup-state', argv: Object.freeze(['backup.manifest']) }),
  'health.snapshot': Object.freeze({ rootId: 'service-state', argv: Object.freeze(['health.snapshot']) }),
  'runtime.version': Object.freeze({ rootId: 'service-state', argv: Object.freeze(['runtime.version']) }),
  'service.status': Object.freeze({ rootId: 'service-state', argv: Object.freeze(['service.status']) })
});

// These errors cross the broker boundary and are shown by the app.  A code is
// useful to software, but it is not an explanation to the person whose switch,
// session, or request was refused.  Keep the sentences beside the boundary so
// every throw path (including the queue and control fast paths) gets one.
const ERROR_MESSAGES = Object.freeze({
  ONLINE_MAINTENANCE_AUDIT_FAILED: 'The maintenance action stopped because its required audit record could not be saved.',
  ONLINE_MAINTENANCE_AUDIT_REQUIRED: 'Online maintenance requires a working audit recorder before it can run.',
  ONLINE_MAINTENANCE_BROKER_DISABLED: 'Online maintenance is turned off on this computer.',
  ONLINE_MAINTENANCE_BROKER_GENERATION_INVALID: 'The maintenance broker belongs to an obsolete service generation and must be restarted.',
  ONLINE_MAINTENANCE_BROKER_OPTIONS_INVALID: 'The maintenance broker is not configured correctly on this computer.',
  ONLINE_MAINTENANCE_CANCELLED: 'The maintenance action was cancelled before it completed.',
  ONLINE_MAINTENANCE_COMMAND_DENIED: 'This command is not one of the maintenance actions this computer permits.',
  ONLINE_MAINTENANCE_CONTROL_INVALID: 'The maintenance controls could not be read safely, so the action was not run.',
  ONLINE_MAINTENANCE_EXECUTION_FAILED: 'The maintenance program failed, so no result was accepted.',
  ONLINE_MAINTENANCE_IDENTITY_STALE: 'The maintenance authorization belongs to an older service identity; reconnect and try again.',
  ONLINE_MAINTENANCE_KILLSWITCH_ACTIVE: 'The online-maintenance kill switch is active, so this action was not run.',
  ONLINE_MAINTENANCE_KILL_FAILED: 'The maintenance process could not be confirmed stopped; the action remains refused for safety.',
  ONLINE_MAINTENANCE_OUTPUT_INVALID: 'The maintenance program returned an invalid result, so it was not accepted.',
  ONLINE_MAINTENANCE_OUTPUT_OVERFLOW: 'The maintenance result exceeded the allowed size and was not accepted.',
  ONLINE_MAINTENANCE_OUTPUT_TRUNCATED: 'The maintenance result was incomplete and was not accepted.',
  ONLINE_MAINTENANCE_PATH_DENIED: 'The requested location is outside the read-only maintenance boundary.',
  ONLINE_MAINTENANCE_QUEUE_FULL: 'Online maintenance is busy and its waiting queue is full; try again later.',
  ONLINE_MAINTENANCE_SERVICE_IDENTITY_DENIED: 'The running service is not the identity authorized for online maintenance.',
  ONLINE_MAINTENANCE_SERVICE_IDENTITY_INVALID: 'The maintenance service identity could not be verified, so the action was not run.',
  ONLINE_MAINTENANCE_SESSION_DENIED: 'This maintenance session is invalid, expired, or has already used this command position.',
  ONLINE_MAINTENANCE_SESSION_STATE_REQUIRED: 'Online maintenance requires a working session-state recorder before it can run.',
  ONLINE_MAINTENANCE_SPAWN_INVALID: 'The maintenance program did not start in a verifiable way.',
  ONLINE_MAINTENANCE_TIMEOUT: 'The maintenance action exceeded its time limit and was stopped.'
});

class OnlineMaintenanceBrokerError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] || 'Online maintenance was refused for an unknown reason.');
    this.name = 'OnlineMaintenanceBrokerError';
    this.code = code;
  }
}
function fail(code) { throw new OnlineMaintenanceBrokerError(code); }
function plain(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function exact(value, keys, code) {
  let source; let actual;
  try { source = plain(value) ? value : null; actual = source && Reflect.ownKeys(source); }
  catch { fail(code); }
  if (!source || actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) fail(code);
  for (const key of actual) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(source, key); }
    catch { fail(code); }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(code);
  }
  return source;
}
function integer(value, code, min, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(code); return value; }
function string(value, code, expression, max) { if (typeof value !== 'string' || value.length < 1 || value.length > max || !expression.test(value)) fail(code); return value; }

function exactIdentity(value, code) {
  const source = exact(value, ['name', 'nonAdmin', 'serviceAccount', 'sid', 'uid'], code);
  if (source.nonAdmin !== true || source.name !== maintenance.SERVICE_ACCOUNT || source.serviceAccount !== maintenance.SERVICE_ACCOUNT) fail(code);
  return Object.freeze({
    name: source.name,
    nonAdmin: true,
    serviceAccount: source.serviceAccount,
    sid: string(source.sid, code, SAFE_SID, 240),
    uid: string(source.uid, code, SAFE_UID, 160)
  });
}

function exactReceipt(value, phase, code) {
  const source = exact(value, ['durable', 'ok', 'phase', 'receiptId'], code);
  if (source.ok !== true || source.durable !== true || source.phase !== phase) fail(code);
  return Object.freeze({ durable: true, ok: true, phase, receiptId: string(source.receiptId, code, /^audit_[A-Za-z0-9_-]{8,160}$/, 166) });
}

function exactOpenReceipt(value, rootId, code) {
  const source = exact(value, ['capabilityId', 'kind', 'ok', 'rootId'], code);
  if (source.ok !== true || source.rootId !== rootId || source.kind !== 'opened-readonly') fail(code);
  return Object.freeze({ capabilityId: string(source.capabilityId, code, /^cap_[A-Za-z0-9_-]{8,160}$/, 164), kind: 'opened-readonly', rootId });
}

function exactSessionReceipt(value, sessionId, generation, expectedIndex, code) {
  const source = exact(value, ['generation', 'nextIndex', 'ok', 'sessionId'], code);
  if (source.ok !== true || source.sessionId !== sessionId || source.generation !== generation || source.nextIndex !== expectedIndex + 1) fail(code);
  return Object.freeze({ generation, nextIndex: source.nextIndex, ok: true, sessionId });
}

function exactLaunch(value, code) {
  const source = exact(value, ['completed', 'handle'], code);
  if (!source.handle || (typeof source.handle !== 'object' && typeof source.handle !== 'function')) fail(code);
  let then;
  try { then = source.completed && source.completed.then; } catch { fail(code); }
  if (typeof then !== 'function') fail(code);
  return Object.freeze({ completed: source.completed, handle: source.handle });
}

function exactResult(value, maxOutputBytes, code) {
  const source = exact(value, ['exitCode', 'stderr', 'stdout', 'totalOutputBytes', 'truncated'], code);
  if (source.exitCode !== 0) fail('ONLINE_MAINTENANCE_EXECUTION_FAILED');
  if (source.truncated === true) fail('ONLINE_MAINTENANCE_OUTPUT_TRUNCATED');
  if (source.truncated !== false || !Number.isSafeInteger(source.totalOutputBytes) || source.totalOutputBytes < 0
      || typeof source.stdout !== 'string' || typeof source.stderr !== 'string') fail(code);
  if (source.totalOutputBytes > maxOutputBytes || source.stdout.length > maxOutputBytes || source.stderr.length > maxOutputBytes) fail('ONLINE_MAINTENANCE_OUTPUT_OVERFLOW');
  // byteLength does not allocate a Buffer; launcher is required to capture and
  // cap data before it becomes a JavaScript string.
  const bytes = Buffer.byteLength(source.stdout, 'utf8') + Buffer.byteLength(source.stderr, 'utf8');
  if (bytes > maxOutputBytes) fail('ONLINE_MAINTENANCE_OUTPUT_OVERFLOW');
  if (bytes !== source.totalOutputBytes) fail(code);
  return Object.freeze({ exitCode: 0, stderr: source.stderr, stdout: source.stdout, totalOutputBytes: bytes, truncated: false });
}

async function awaited(adapter, request, code) {
  let returned;
  try { returned = adapter(Object.freeze(request)); }
  catch { fail(code); }
  try { return await returned; }
  catch { fail(code); }
}

function createOnlineMaintenanceBroker(options = {}) {
  exact(options, ['audit', 'enabled', 'expectedServiceIdentity', 'generation', 'killProcessTree', 'killSwitchActive', 'launch', 'maxConcurrency', 'maxQueue', 'openBeneath', 'profile', 'serviceIdentity', 'sessionState'], 'ONLINE_MAINTENANCE_BROKER_OPTIONS_INVALID');
  if (typeof options.enabled !== 'boolean' || typeof options.killSwitchActive !== 'boolean'
      || typeof options.openBeneath !== 'function' || typeof options.launch !== 'function'
      || typeof options.killProcessTree !== 'function' || typeof options.serviceIdentity !== 'function') fail('ONLINE_MAINTENANCE_BROKER_OPTIONS_INVALID');
  const auditAdapter = exact(options.audit, ['record', 'require'], 'ONLINE_MAINTENANCE_AUDIT_REQUIRED');
  if (typeof auditAdapter.require !== 'function' || typeof auditAdapter.record !== 'function') fail('ONLINE_MAINTENANCE_AUDIT_REQUIRED');
  const sessionAdapter = exact(options.sessionState, ['consume'], 'ONLINE_MAINTENANCE_SESSION_STATE_REQUIRED');
  if (typeof sessionAdapter.consume !== 'function') fail('ONLINE_MAINTENANCE_SESSION_STATE_REQUIRED');
  // Capture every trusted adapter after validation. The caller-owned options
  // object and its nested adapter objects remain mutable; consulting them at
  // execution time would turn configuration into a post-validation TOCTOU
  // boundary.
  const auditRequire = auditAdapter.require;
  const auditRecord = auditAdapter.record;
  const consumeSessionState = sessionAdapter.consume;
  const killProcessTree = options.killProcessTree;
  const launchAdapter = options.launch;
  const openBeneath = options.openBeneath;
  const serviceIdentity = options.serviceIdentity;
  let enabled = options.enabled;
  let generation = integer(options.generation, 'ONLINE_MAINTENANCE_BROKER_OPTIONS_INVALID', 1);
  let killSwitchActive = options.killSwitchActive;
  const maxConcurrency = integer(options.maxConcurrency, 'ONLINE_MAINTENANCE_BROKER_OPTIONS_INVALID', 1, 16);
  const maxQueue = integer(options.maxQueue, 'ONLINE_MAINTENANCE_BROKER_OPTIONS_INVALID', 0, 128);
  const expectedIdentity = exactIdentity(options.expectedServiceIdentity, 'ONLINE_MAINTENANCE_SERVICE_IDENTITY_INVALID');
  const profile = maintenance.validateProfile(options.profile);
  if (profile.identityGeneration !== generation) fail('ONLINE_MAINTENANCE_BROKER_GENERATION_INVALID');
  const active = new Map(); let queued = []; let sequence = 0;

  function assertControl(authorized) {
    if (!enabled) fail('ONLINE_MAINTENANCE_BROKER_DISABLED');
    if (killSwitchActive) fail('ONLINE_MAINTENANCE_KILLSWITCH_ACTIVE');
    if (authorized.identityGeneration !== generation) fail('ONLINE_MAINTENANCE_IDENTITY_STALE');
  }
  function cancellationCode(task) { return task.cancelCode || (task.timedOut ? 'ONLINE_MAINTENANCE_TIMEOUT' : null); }
  async function killHandle(task) {
    if (!task.handle) return false;
    if (task.killPromise) return task.killPromise;
    task.killPromise = (async () => {
      try {
        const receipt = await awaited(killProcessTree, { handle: task.handle, reason: cancellationCode(task) || 'ONLINE_MAINTENANCE_CANCELLED' }, 'ONLINE_MAINTENANCE_KILL_FAILED');
        const checked = exact(receipt, ['ok', 'terminated'], 'ONLINE_MAINTENANCE_KILL_FAILED');
        if (checked.ok !== true || checked.terminated !== true) fail('ONLINE_MAINTENANCE_KILL_FAILED');
        return true;
      } catch {
        // Without an affirmative tree-termination receipt, retain this slot.
        // Starting another maintenance action would be a fail-open response.
        task.quarantined = true;
        fail('ONLINE_MAINTENANCE_KILL_FAILED');
      }
    })();
    return task.killPromise;
  }
  async function cancelTask(task, code) {
    if (!task.cancelCode) task.cancelCode = code;
    if (task.controller) task.controller.abort();
    if (task.stop) task.stop();
    if (task.handle) await killHandle(task);
    return true;
  }
  async function abortAll(code) {
    const pending = queued; queued = [];
    for (const task of pending) task.reject(new OnlineMaintenanceBrokerError(code));
    const results = await Promise.allSettled([...active.values()].map(task => cancelTask(task, code)));
    if (results.some(result => result.status === 'rejected')) fail('ONLINE_MAINTENANCE_KILL_FAILED');
  }
  async function setControl(value) {
    exact(value, ['enabled', 'generation', 'killSwitchActive'], 'ONLINE_MAINTENANCE_CONTROL_INVALID');
    if (typeof value.enabled !== 'boolean' || typeof value.killSwitchActive !== 'boolean') fail('ONLINE_MAINTENANCE_CONTROL_INVALID');
    const next = integer(value.generation, 'ONLINE_MAINTENANCE_CONTROL_INVALID', 1);
    const changed = next !== generation;
    enabled = value.enabled; generation = next; killSwitchActive = value.killSwitchActive;
    if (!enabled || killSwitchActive || changed) await abortAll(killSwitchActive ? 'ONLINE_MAINTENANCE_KILLSWITCH_ACTIVE' : changed ? 'ONLINE_MAINTENANCE_IDENTITY_STALE' : 'ONLINE_MAINTENANCE_BROKER_DISABLED');
  }
  async function identity(task) {
    const value = exactIdentity(await task.await(awaited(serviceIdentity, { signal: task.controller.signal }, 'ONLINE_MAINTENANCE_SERVICE_IDENTITY_INVALID')), 'ONLINE_MAINTENANCE_SERVICE_IDENTITY_INVALID');
    if (value.uid !== expectedIdentity.uid || value.sid !== expectedIdentity.sid || value.name !== expectedIdentity.name) fail('ONLINE_MAINTENANCE_SERVICE_IDENTITY_DENIED');
    return value;
  }
  function argumentsFor(authorized) {
    const operation = OPERATION_TABLE[authorized.commandId];
    if (!operation || operation.rootId !== authorized.rootId) fail('ONLINE_MAINTENANCE_COMMAND_DENIED');
    const extra = authorized.commandId === 'service.status' ? [authorized.args.serviceId] : [];
    return Object.freeze({ argv: Object.freeze([...operation.argv, ...extra]), rootId: operation.rootId });
  }
  async function openTarget(task, authorized, rootId) {
    const relativePath = Object.hasOwn(authorized.args, 'relativePath') ? authorized.args.relativePath : null;
    if (relativePath !== null && (relativePath.includes('\\') || relativePath.startsWith('/') || relativePath.startsWith('\\') || relativePath.includes(':') || relativePath.includes('..'))) fail('ONLINE_MAINTENANCE_PATH_DENIED');
    // The opener owns any capability produced after its signal is aborted. It
    // must dispose rather than publish that capability; the broker never
    // accepts a late receipt into the launcher's capability namespace.
    const receipt = await task.await(awaited(openBeneath, { mode: 'read-only', relativePath, rootId, signal: task.controller.signal }, 'ONLINE_MAINTENANCE_PATH_DENIED'));
    return exactOpenReceipt(receipt, rootId, 'ONLINE_MAINTENANCE_PATH_DENIED');
  }
  async function audit(task, phase, fields) {
    const adapter = phase === 'intent' ? auditRequire : auditRecord;
    const receipt = await task.await(awaited(adapter, { ...fields, phase, signal: task.controller.signal, type: `online_maintenance.${phase}` }, 'ONLINE_MAINTENANCE_AUDIT_FAILED'));
    return exactReceipt(receipt, phase, 'ONLINE_MAINTENANCE_AUDIT_FAILED');
  }
  async function consumeSession(task, sessionId, authorized) {
    const receipt = await task.await(awaited(consumeSessionState, {
      commandIndex: authorized.sessionCommandIndex,
      generation: authorized.identityGeneration,
      identityId: authorized.identityId,
      sessionId,
      signal: task.controller.signal
    }, 'ONLINE_MAINTENANCE_SESSION_DENIED'));
    return exactSessionReceipt(receipt, sessionId, authorized.identityGeneration, authorized.sessionCommandIndex, 'ONLINE_MAINTENANCE_SESSION_DENIED');
  }
  function quarantineLateLaunch(task, launchPromise) {
    task.quarantined = true;
    Promise.resolve(launchPromise).then(async value => {
      const launch = exactLaunch(value, 'ONLINE_MAINTENANCE_SPAWN_INVALID');
      task.handle = launch.handle;
      await killHandle(task);
      task.quarantined = false;
      active.delete(task.id);
      drain();
    }).catch(() => {
      // A malformed late result cannot prove that no child was created. Keep
      // the slot quarantined until a supervising process resolves the host.
    });
  }
  async function run(task) {
    const authorized = maintenance.authorizeOnlineMaintenanceCommand(task.request);
    const controller = new AbortController(); task.controller = controller;
    let stop;
    const stopped = new Promise(resolve => { stop = () => resolve(DEADLINE_EXPIRED); });
    task.stop = stop;
    task.await = async promise => {
      const value = await Promise.race([promise, stopped]);
      if (value === DEADLINE_EXPIRED) fail(cancellationCode(task) || 'ONLINE_MAINTENANCE_CANCELLED');
      return value;
    };
    const timeoutId = setTimeout(() => {
      task.timedOut = true;
      void cancelTask(task, 'ONLINE_MAINTENANCE_TIMEOUT').catch(() => {});
    }, authorized.timeoutMs);
    const deadline = stopped;
    let launchPromise;
    try {
      assertControl(authorized);
      await identity(task); assertControl(authorized);
      const operation = argumentsFor(authorized);
      const capability = await openTarget(task, authorized, operation.rootId); assertControl(authorized);
      await consumeSession(task, task.sessionId, authorized); assertControl(authorized);
      await audit(task, 'intent', { commandId: authorized.commandId, bytes: authorized.maxOutputBytes, timeoutMs: authorized.timeoutMs }); assertControl(authorized);
      // The only executable/argv/env are immutable internal constants.  The
      // platform launcher receives opaque opened capability IDs, never paths.
      launchPromise = Promise.resolve().then(() => launchAdapter(Object.freeze({
        argv: operation.argv, cwdCapability: Object.freeze({ kind: 'root-capability', rootId: operation.rootId }),
        env: FIXED_ENV, executable: FIXED_EXECUTABLE, shell: false,
        maxOutputBytes: authorized.maxOutputBytes, signal: controller.signal,
        targetCapability: capability, timeoutMs: authorized.timeoutMs, windowsHide: true
      })));
      const raced = await Promise.race([launchPromise, deadline]);
      if (raced === DEADLINE_EXPIRED) { quarantineLateLaunch(task, launchPromise); fail(cancellationCode(task) || 'ONLINE_MAINTENANCE_CANCELLED'); }
      const launched = exactLaunch(raced, 'ONLINE_MAINTENANCE_SPAWN_INVALID');
      task.handle = launched.handle;
      if (cancellationCode(task)) { await killHandle(task); fail(cancellationCode(task)); }
      assertControl(authorized);
      let result;
      // Every other failure branch in this function kills the tree before
      // failing (see the timeout, cancellation, and stale-generation checks
      // around this one). This one did not: a rejected `completed` promise
      // (the launched process errored instead of exiting normally) reached
      // fail() directly, leaving whatever the launch adapter started still
      // running with nothing left tracking it -- a leaked process tree,
      // exactly the class of bug killProcessTree/killHandle exists to
      // prevent. Match the sibling branches instead of writing a second
      // kill path.
      try { result = await Promise.race([launched.completed, deadline]); }
      catch { await killHandle(task); fail('ONLINE_MAINTENANCE_EXECUTION_FAILED'); }
      if (result === DEADLINE_EXPIRED) { await killHandle(task); fail(cancellationCode(task) || 'ONLINE_MAINTENANCE_CANCELLED'); }
      if (cancellationCode(task)) { await killHandle(task); fail(cancellationCode(task)); }
      const checked = exactResult(result, authorized.maxOutputBytes, 'ONLINE_MAINTENANCE_OUTPUT_INVALID');
      await audit(task, 'completed', { commandId: authorized.commandId, exitCode: 0, outputBytes: checked.totalOutputBytes });
      return Object.freeze({ commandId: authorized.commandId, exitCode: 0, stderr: checked.stderr, stdout: checked.stdout, outputBytes: checked.totalOutputBytes, truncated: false });
    } finally {
      clearTimeout(timeoutId);
    }
  }
  function drain() {
    while (active.size < maxConcurrency && queued.length) {
      const task = queued.shift(); active.set(task.id, task);
      run(task).then(task.resolve, error => {
        const code = error && typeof error.code === 'string' && /^ONLINE_MAINTENANCE_[A-Z_]+$/.test(error.code)
          ? error.code : 'ONLINE_MAINTENANCE_EXECUTION_FAILED';
        task.reject(new OnlineMaintenanceBrokerError(code));
      }).finally(() => {
        if (!task.quarantined) { active.delete(task.id); drain(); }
      });
    }
  }
  function execute(request, sessionId) {
    if (!enabled) return Promise.reject(new OnlineMaintenanceBrokerError('ONLINE_MAINTENANCE_BROKER_DISABLED'));
    if (killSwitchActive) return Promise.reject(new OnlineMaintenanceBrokerError('ONLINE_MAINTENANCE_KILLSWITCH_ACTIVE'));
    try { string(sessionId, 'ONLINE_MAINTENANCE_SESSION_DENIED', /^online-session_[A-Za-z0-9_-]{8,160}$/, 175); }
    catch (error) { return Promise.reject(error); }
    if (active.size >= maxConcurrency && queued.length >= maxQueue) return Promise.reject(new OnlineMaintenanceBrokerError('ONLINE_MAINTENANCE_QUEUE_FULL'));
    return new Promise((resolve, reject) => { queued.push({ await: null, cancelCode: null, controller: null, handle: null, id: ++sequence, killPromise: null, quarantined: false, request, resolve, reject, sessionId, stop: null, timedOut: false }); drain(); });
  }
  return Object.freeze({ execute, setControl, snapshot: () => Object.freeze({ enabled, generation, killSwitchActive, active: active.size, queued: queued.length }) });
}

module.exports = Object.freeze({ BROKER_VERSION, ERROR_MESSAGES, FIXED_ENV, FIXED_EXECUTABLE, OPERATION_TABLE, OnlineMaintenanceBrokerError, createOnlineMaintenanceBroker });
