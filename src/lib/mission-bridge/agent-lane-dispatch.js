'use strict';

// App dispatch adapter for the canonical Phase 1 lane runtime. The adapter
// owns only bridge-specific persistence and startup observation; runLane
// remains the authority for tasks, presence, heartbeats, launch specs, exit
// codes, and VERDICT capture.

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const agentLane = require('../agent-lane');
const presence = require('../agent-presence');
const { MissionBridgeError } = require('./errors');
const { assertNoBillingCredentials, safeLaunchEnvironment } = require('../providers/subscription-launch-env.js');
const { deleteEnvNames } = require('../env-scrub.js');
const laneScope = require('../lane-scope.js');
const windowsJob = require('../windows-job-control.js');

const LAUNCH_ID_RE = /^launch_[A-Za-z0-9_-]{16,64}$/;
const BRIEF_DIRECTORY = path.join('state', 'mission-bridge-briefs');
const CHECKPOINT_DIRECTORY = path.join('state', 'mission-bridge-checkpoints');
const CONSOLE_DIRECTORY = path.join('logs', 'mission-bridge-lanes');
const MAX_CHECKPOINT_BYTES = agentLane.MAX_CHECKPOINT_BYTES;
const MAX_CHECKPOINT_INSTRUCTION_BYTES = 1024;
const CHECKPOINT_CREDENTIAL_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*\S+/i,
  /\b(?:sk|xox[a-z]?|gh[opusr])[-_][A-Za-z0-9_-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
]);

function fail(code, message, status = 503, details = null) {
  throw new MissionBridgeError(code, message, { status, details });
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realpath(fsImpl, target) {
  const resolve = fsImpl.realpathSync;
  if (typeof resolve !== 'function') fail('BRIDGE_AGENT_PATH_INVALID', 'The lane artifact path cannot be verified.', 503);
  return typeof resolve.native === 'function' ? resolve.native(target) : resolve(target);
}

function assertLaunchId(launchId) {
  if (typeof launchId !== 'string' || !LAUNCH_ID_RE.test(launchId)) {
    fail('BRIDGE_AGENT_PATH_INVALID', 'The launch id cannot name a lane artifact.', 400);
  }
  return launchId;
}

function launchArtifactPath(projectRoot, launchId, directory, extension) {
  if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    fail('BRIDGE_AGENT_PATH_INVALID', 'The declared project root is invalid.', 400);
  }
  assertLaunchId(launchId);
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, directory, `${launchId}${extension}`);
  if (!inside(root, target)) fail('BRIDGE_AGENT_PATH_INVALID', 'The lane artifact escaped its declared project root.', 400);
  return target;
}

function durableBriefPath(projectRoot, launchId) {
  return launchArtifactPath(projectRoot, launchId, BRIEF_DIRECTORY, '.md');
}

function checkpointPath(projectRoot, launchId) {
  return launchArtifactPath(projectRoot, launchId, CHECKPOINT_DIRECTORY, '.md');
}

function checkpointRelativePath(launchId) {
  assertLaunchId(launchId);
  return ['state', 'mission-bridge-checkpoints', `${launchId}.md`].join('/');
}

function consoleLogPath(projectRoot, launchId) {
  return launchArtifactPath(projectRoot, launchId, CONSOLE_DIRECTORY, '.log');
}

function initialCheckpointSeed(launchId) {
  assertLaunchId(launchId);
  return [
    '# Mission Bridge launch checkpoint',
    '',
    `Launch ID: ${launchId}`,
    'Checkpoint state: no child-authored progress has been recorded.',
    'This is the first-run seed. It is not evidence that the lane started, resumed, or completed work.',
    ''
  ].join('\n');
}

function checkpointInstruction(launchId) {
  const relative = checkpointRelativePath(launchId);
  const instruction = [
    'DURABLE CHECKPOINT FOR THIS LAUNCH:',
    `Relative checkpoint path from the selected project root: ${relative}`,
    `When durable progress exists, atomically replace that exact regular UTF-8 file with no more than ${MAX_CHECKPOINT_BYTES} bytes.`,
    'Never write credential material, create a symlink or junction, or write outside that one file.',
    'The current file is a truthful first-run seed and does not claim that any work has started or completed.'
  ].join('\n');
  if (Buffer.byteLength(instruction, 'utf8') > MAX_CHECKPOINT_INSTRUCTION_BYTES) {
    fail('BRIDGE_AGENT_CHECKPOINT_INVALID', 'The checkpoint instruction is too large.', 500);
  }
  return instruction;
}

function ensureContainedDirectory(projectRoot, directory, fsImpl) {
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, directory);
  if (!inside(root, directory) || relative === '') {
    fail('BRIDGE_AGENT_PATH_REFUSED', 'The lane artifact directory is not contained by its declared project root.', 400);
  }
  let rootStat;
  try { rootStat = fsImpl.lstatSync(root); }
  catch { fail('BRIDGE_AGENT_PATH_INVALID', 'The declared project root is unavailable.', 400); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('BRIDGE_AGENT_PATH_REFUSED', 'The declared project root must be a regular directory.', 400);
  }
  let canonicalRoot;
  try { canonicalRoot = realpath(fsImpl, root); }
  catch (error) {
    if (error instanceof MissionBridgeError) throw error;
    fail('BRIDGE_AGENT_PATH_INVALID', 'The declared project root cannot be resolved.', 400);
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try { fsImpl.mkdirSync(current, { mode: 0o700 }); }
    catch (error) {
      if (!error || error.code !== 'EEXIST') {
        fail('BRIDGE_AGENT_PATH_INVALID', 'The lane artifact directory could not be created.', 503, {
          cause: typeof error?.code === 'string' ? error.code : null
        });
      }
    }
    let stat;
    let canonical;
    try {
      stat = fsImpl.lstatSync(current);
      canonical = realpath(fsImpl, current);
    } catch (error) {
      if (error instanceof MissionBridgeError) throw error;
      fail('BRIDGE_AGENT_PATH_INVALID', 'The lane artifact directory could not be verified.', 503, {
        cause: typeof error?.code === 'string' ? error.code : null
      });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(canonicalRoot, canonical)) {
      fail('BRIDGE_AGENT_PATH_REFUSED', 'The lane artifact directory contains a symlink, junction, or path escape.', 400);
    }
  }
  return canonicalRoot;
}

function validateArtifactContent(content, { label, maximum = null, refuseCredentials = false }) {
  if (typeof content !== 'string' || content.length === 0 || content.includes('\0')) {
    fail(`BRIDGE_AGENT_${label}_INVALID`, `The durable lane ${label.toLowerCase()} is invalid.`, 400);
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (maximum !== null && bytes > maximum) {
    fail(`BRIDGE_AGENT_${label}_INVALID`, `The durable lane ${label.toLowerCase()} exceeds ${maximum} UTF-8 bytes.`, 400);
  }
  if (refuseCredentials && CHECKPOINT_CREDENTIAL_PATTERNS.some(pattern => pattern.test(content))) {
    fail('BRIDGE_AGENT_CHECKPOINT_CREDENTIAL_REFUSED', 'The durable lane checkpoint appears to contain credential material.', 400);
  }
  return bytes;
}

function persistExclusiveArtifact({ projectRoot, content, file, label, collisionCode, writeCode }, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const canonicalRoot = ensureContainedDirectory(projectRoot, path.dirname(file), fsImpl);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = fsImpl.openSync(temporary, 'wx', 0o600);
    fsImpl.writeFileSync(handle, content, 'utf8');
    fsImpl.fsyncSync(handle);
    fsImpl.closeSync(handle);
    handle = undefined;
    // An atomic hard-link publish refuses an existing final path on every
    // supported platform instead of relying on rename overwrite semantics.
    fsImpl.linkSync(temporary, file);
    const stat = fsImpl.lstatSync(file);
    const canonical = realpath(fsImpl, file);
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(canonicalRoot, canonical)) {
      fail('BRIDGE_AGENT_PATH_REFUSED', 'The published lane artifact is not a contained regular file.', 503);
    }
  } catch (error) {
    if (error instanceof MissionBridgeError) throw error;
    if (error && error.code === 'EEXIST' && fsImpl.existsSync(file)) {
      fail(collisionCode, `The launch ${label} already exists and will not be overwritten.`, 409);
    }
    fail(writeCode, `The durable lane ${label} could not be persisted.`, 503, {
      cause: typeof error?.code === 'string' ? error.code : null
    });
  } finally {
    if (handle !== undefined) {
      try { fsImpl.closeSync(handle); } catch { /* best effort */ }
    }
    try { fsImpl.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
  return file;
}

function persistBrief({ projectRoot, launchId, content }, dependencies = {}) {
  validateArtifactContent(content, { label: 'BRIEF' });
  return persistExclusiveArtifact({
    projectRoot,
    content,
    file: durableBriefPath(projectRoot, launchId),
    label: 'brief',
    collisionCode: 'BRIDGE_AGENT_BRIEF_COLLISION',
    writeCode: 'BRIDGE_AGENT_BRIEF_WRITE_FAILED'
  }, dependencies);
}

function persistCheckpoint({ projectRoot, launchId, content = initialCheckpointSeed(launchId) }, dependencies = {}) {
  validateArtifactContent(content, { label: 'CHECKPOINT', maximum: MAX_CHECKPOINT_BYTES, refuseCredentials: true });
  return persistExclusiveArtifact({
    projectRoot,
    content,
    file: checkpointPath(projectRoot, launchId),
    label: 'checkpoint',
    collisionCode: 'BRIDGE_AGENT_CHECKPOINT_COLLISION',
    writeCode: 'BRIDGE_AGENT_CHECKPOINT_WRITE_FAILED'
  }, dependencies);
}

function observedPresence(basePresence, onRunning) {
  return Object.freeze({
    ...basePresence,
    heartbeat(...args) {
      const record = basePresence.heartbeat(...args);
      if (record && record.status === 'running') onRunning(record);
      return record;
    }
  });
}

/* The Windows launch path owns a kernel Job Object before the lane's first
 * instruction runs.  Termination therefore addresses that retained object,
 * not a PID snapshot and not taskkill's live parent/child walk.  This closes
 * both historical gaps: a dead intermediate cannot orphan descendants, and a
 * reused PID cannot redirect a later terminate request at an unrelated process.
 */
function killLaneTree(child, dependencies = {}) {
  if (child && typeof child.terminateJob === 'function') {
    try {
      const termination = child.terminateJob();
      // The lane result still waits for close; consume a parallel rejection so
      // a failed control exchange cannot become an unhandled rejection first.
      if (termination && typeof termination.catch === 'function') termination.catch(() => {});
      return termination;
    } catch { /* the retained wrapper handle below remains exact */ }
  }
  try { return child && child.kill(); }
  catch { return false; /* runLane classifies the terminal result */ }
}

/* THE LANE CHILD'S ENVIRONMENT: PROVENANCE IN, CREDENTIALS OUT.
 *
 * boundedSpawn used to spread `...options` and then OVERWRITE env with
 * `{ ...cleanEnvironment, TOOLSENABLED_AGENT_ID }`. Everything else
 * agent-lane.js:spawnChild had just computed for the child -- role, tier, its
 * OWN project root, the onboarding packet version and hash, the
 * launcher-provenance marker, the R-ledger session/thread/tree identity, and
 * the lane scope fence -- was silently dropped for every app-dispatched child.
 *
 * MEASURED 2026-08-18 with a real spawned child through the real
 * startAgentLane -> boundedSpawn -> spawnChild path, canary values only: the
 * child booted with the DISPATCHER'S TOOLSENABLED_PROJECT_ROOT and the
 * DISPATCHER'S TOOLSENABLED_LANE_SCOPE (the app process's own ambient values,
 * riding in through cleanEnvironment), a raw ambient TOOLSENABLED_TREE_ANCESTORS
 * instead of the lineage spawnChild computed, and NO packet hash at all. A lane
 * child confined by somebody else's scope fence is not confined; a child that
 * cannot prove which packet briefed it is outside its own provenance contract.
 *
 * The merge below is an ALLOWLIST, not a spread: the app's scrubbed environment
 * (actions.js scrubEnvironment + the Codex identity pin) stays the base for
 * everything, and ONLY the launcher-built lane-local names cross from the
 * caller side -- so the app's credential scrub cannot be walked backwards
 * through options.env, the owner's CODEX_HOME pin still outranks whatever
 * ambient value the lane carried, and on a provenance collision the launcher
 * wins in every casing (Windows resolves names case-insensitively, so exactly
 * one spelling may survive). tests/agent-lane.test.js pins all four properties,
 * and its drift guard fails this list the day spawnChild grows a lane-local
 * name the list does not carry. */
const LANE_PROVENANCE_ENV_NAMES = Object.freeze([
  'TOOLSENABLED_AGENT_ID',
  'TOOLSENABLED_AGENT_ROLE',
  'TOOLSENABLED_AGENT_TIER',
  'TOOLSENABLED_PROJECT_ROOT',
  'TOOLSENABLED_ONBOARDING_PACKET_VERSION',
  'TOOLSENABLED_ONBOARDING_PACKET_HASH',
  'TOOLSENABLED_ONBOARDING_LAUNCHER_PROVENANCE',
  'TOOLSENABLED_SESSION_ID',
  'TOOLSENABLED_THREAD_ID',
  'TOOLSENABLED_TREE_ANCESTORS',
  laneScope.ENV_VAR
]);

function laneChildEnvironment(cleanEnvironment, callerEnvironment) {
  // Fail closed before merging: a null/undefined base is node's spelling of
  // "inherit everything", and a base that still carries a billing credential
  // must refuse the launch loudly rather than charge silently.
  const child = { ...assertNoBillingCredentials(cleanEnvironment, { context: 'mission-bridge lane child' }) };
  // This service's private app connection never becomes a provider connection.
  // Node normally consumes these at startup; scrub every casing explicitly too.
  deleteEnvNames(child, ['NODE_CHANNEL_FD', 'NODE_CHANNEL_SERIALIZATION_MODE']);
  if (!callerEnvironment || typeof callerEnvironment !== 'object') return child;
  for (const name of LANE_PROVENANCE_ENV_NAMES) {
    const value = callerEnvironment[name];
    if (typeof value !== 'string') continue; // a non-string value is not an environment value
    deleteEnvNames(child, [name]); // exactly one (canonical) spelling reaches the child
    child[name] = value;
  }
  return child;
}

function boundedSpawn(spawnImpl, cleanEnvironment, capMs, timeoutState, timers = {}) {
  const setTimeoutImpl = timers.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = timers.clearTimeoutImpl || clearTimeout;
  const killTree = timers.killLaneTree || killLaneTree;
  return (command, args, options) => {
    const childEnvironment = safeLaunchEnvironment(
      laneChildEnvironment(cleanEnvironment, options?.env),
      { context: 'mission-bridge bounded lane child' }
    );
    const childOptions = {
      ...options,
      env: childEnvironment,
      windowsHide: true,
      shell: false
    };
    const platform = timers.platform || process.platform;
    const launch = timers.spawnInJobImpl || windowsJob.spawnInJob;
    // Consume one atomic reservation at the real OS boundary, after all
    // asynchronous task/identity/brief preparation. No per-start OS probe.
    const reservation = typeof timers.reserveResources === 'function' ? timers.reserveResources() : null;
    if (reservation && typeof reservation.then === 'function') {
      void reservation.then(value => value?.release(), () => {});
      fail('AGENT_RESOURCE_PREPARATION_REQUIRED', 'The resource reservation must be awaited before reaching the process boundary.');
    }
    let child;
    try {
      timers.assertPermissionCurrent?.();
      reservation?.beforeSpawn?.();
      // Without a Windows wrapper this IS the provider-root boundary. The
      // canonical preparation below awaited its app revalidation; check that
      // same grant synchronously here, after all awaits and before OS spawn.
      if (platform !== 'win32') reservation?.beforeRootSpawn?.();
      child = platform === 'win32'
        ? launch(command, args, childOptions, {
          ...(timers.windowsJobDependencies || {}),
          platform,
          spawnImpl,
          safeLaunchEnvironment,
          prepareRootSpawn: reservation?.prepareRootSpawn ? () => reservation.prepareRootSpawn() : undefined,
          beforeRootSpawn: (timers.assertPermissionCurrent || reservation?.beforeRootSpawn) ? () => {
            timers.assertPermissionCurrent?.();
            reservation?.beforeRootSpawn?.();
          } : undefined
        })
        : spawnImpl(command, args, {
          ...childOptions,
          // Keep this explicit at the actual fallback spawn boundary. Besides
          // surviving future childOptions refactors, it lets the release scan
          // mechanically prove that non-Windows development runs cannot flash a
          // terminal when this code is packaged and exercised on Windows.
          windowsHide: true,
          // Keep the actual child-process boundary mechanically self-proving to
          // the spawn-environment release gate. The first scrub above protects
          // the Windows wrapper too; this second pass is idempotent.
          env: safeLaunchEnvironment(childEnvironment, { context: 'mission-bridge bounded lane fallback' })
        });
    } catch (error) {
      reservation?.release();
      throw error;
    }
    if (reservation) {
      reservation.spawned?.(child);
      // A bookkeeping rejection or child `error` is not proof that a retained
      // Windows job is gone. Only close releases an existing process here.
      child.once('close', () => reservation.release());
      if (child.jobReady && typeof child.jobReady.then === 'function') {
        Promise.resolve(child.jobReady).then(() => reservation.ready(), () => {});
      } else child.once('spawn', () => reservation.ready());
    }
    const timer = setTimeoutImpl(() => {
      timeoutState.timedOut = true;
      killTree(child, timers);
    }, capMs);
    if (timer.unref) timer.unref();
    const clear = () => clearTimeoutImpl(timer);
    child.once('error', clear);
    child.once('close', clear);
    return child;
  };
}

function startAgentLane(laneOptions, dependencies = {}) {
  const runLaneImpl = dependencies.runLane || agentLane.runLane;
  const basePresence = dependencies.presence || presence;
  const spawnImpl = dependencies.spawnImpl || spawn;
  const cleanEnvironment = dependencies.env || {};
  const timeoutState = { timedOut: false };
  let prepared = false;
  let consumed = false;
  let preparedReservation = null;
  const prepareResources = async () => {
    if (prepared) fail('AGENT_RESOURCE_GRANT_USED', 'This lane already prepared its one launch.');
    preparedReservation = typeof dependencies.reserveResources === 'function' ? await dependencies.reserveResources() : null;
    prepared = true;
    // Windows must defer this to its later OWNER handshake. A direct root has
    // no wrapper: revalidate before returning to the synchronous spawn path,
    // without reserving again or extending the original sample/advice expiry.
    if ((dependencies.platform || process.platform) !== 'win32') await preparedReservation?.prepareRootSpawn?.();
  };
  const consumeResources = () => {
    if (consumed) fail('AGENT_RESOURCE_GRANT_USED', 'This lane already consumed its one launch.');
    consumed = true;
    // Preserve synchronous in-process adapters. A promise here fails closed in
    // boundedSpawn; the canonical runLane always awaits beforeSpawn below.
    return prepared ? preparedReservation : dependencies.reserveResources?.();
  };
  let startedSettled = false;
  let resolveStarted;
  let rejectStarted;
  const started = new Promise((resolve, reject) => {
    resolveStarted = value => {
      if (startedSettled) return;
      startedSettled = true;
      resolve(value);
    };
    rejectStarted = error => {
      if (startedSettled) return;
      startedSettled = true;
      reject(error);
    };
  });
  const laneDependencies = {
    ...(dependencies.laneDependencies || {}),
    presence: observedPresence(basePresence, resolveStarted),
    beforeSpawn: prepareResources,
    spawnImpl: boundedSpawn(spawnImpl, cleanEnvironment, dependencies.capMs, timeoutState, { ...dependencies, reserveResources: consumeResources })
  };
  let completion;
  try { completion = Promise.resolve(runLaneImpl(laneOptions, laneDependencies)); }
  catch (error) { completion = Promise.reject(error); }
  completion.then(
    result => resolveStarted(result && result.terminal ? result.terminal : result),
    rejectStarted
  );
  // Failure before the synchronous boundary cannot have created a process.
  // Once consumed, only the actual child/job lifecycle may release capacity.
  void completion.finally(() => { if (prepared && !consumed) preparedReservation?.release(); }).catch(() => {});
  return Object.freeze({
    started,
    completion,
    get timedOut() { return timeoutState.timedOut; }
  });
}

module.exports = Object.freeze({
  BRIEF_DIRECTORY,
  CHECKPOINT_DIRECTORY,
  CONSOLE_DIRECTORY,
  LANE_PROVENANCE_ENV_NAMES,
  MAX_CHECKPOINT_BYTES,
  checkpointInstruction,
  checkpointPath,
  checkpointRelativePath,
  consoleLogPath,
  durableBriefPath,
  initialCheckpointSeed,
  killLaneTree,
  laneChildEnvironment,
  persistBrief,
  persistCheckpoint,
  startAgentLane
});
