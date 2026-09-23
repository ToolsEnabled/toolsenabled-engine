'use strict';

// Runners: how a claimed research run actually does its work. All three are
// configuration-as-data — the experiment's immutable runner config plus the
// run's params decide everything, and the {param} substitution language is the
// whole templating surface. The settings gate has already decided WHETHER a
// kind may run before any of these is reached; this module decides HOW.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const windowsJobs = require('../windows-job-control');
const linuxProcesses = require('../linux-process-control');
const { request } = require('../http');
const { rootPath } = require('../runtime');
const { safeLaunchEnvironment } = require('../providers/subscription-launch-env');
const provenance = require('./provenance');
const { validateStudyProtocol } = require('./study-protocol');

const RUNNER_KINDS = Object.freeze(['agent', 'process', 'http']);
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_HTTP_BODY_BYTES = 256 * 1024;
const MAX_ARGS = 64;
const MAX_ENV_KEYS = 16;
const PROCESS_CLEANUP_MS = 15_000;
const PROCESS_PIPE_DRAIN_MS = 1_000;
// Keep exact child handles until their close event, including a cleanup that
// exceeded its observation budget. A timeout is not permission to rediscover
// and kill a possibly reused PID later.
const pendingProcessChildren = new Set();
// Header names that carry authority. The http runner refuses them outright:
// a declared request that needs a credential is a v1.1 authProfile seam, not
// a header string in an experiment config.
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'x-auth-token']);
// What a child process inherits when the experiment declares nothing: enough
// to execute at all on Windows, and not the owner's session.
const BASE_ENV_KEYS = Object.freeze(['PATH', 'Path', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']);

// Is this URL hostname a literal that names this machine or its private
// networks? The http runner refuses those: a declared research request reaches
// outside services, and the loopback range holds this product's own bridges.
//
// The check runs on the WHATWG-normalized hostname, which already folds the
// decimal, octal and hex IPv4 spellings back to dotted quads (2130706433,
// 0x7f000001 and 017700000001 all arrive as 127.0.0.1 — verified). What it did
// NOT fold, and what the first version of this guard missed, is IPv4-mapped
// IPv6: https://[::ffff:127.0.0.1]/ normalizes to [::ffff:7f00:1], matched no
// dotted-quad pattern, and reached loopback. So an IPv6 literal is expanded and
// its embedded IPv4 re-checked rather than pattern-matched as text.
//
// A NAME that resolves privately (a DNS record pointing at 127.0.0.1, or a
// rebind after this check) is beyond what any pre-request check can see and
// remains the operator's declared responsibility, as before.
function privateIpv4(host) {
  return host === '0.0.0.0' || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) || /^169\.254\./.test(host);
}

function ipv6Groups(text) {
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parsePart = part => {
    if (part === '') return [];
    const out = [];
    for (const piece of part.split(':')) {
      const dotted = piece.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (dotted) {
        const octets = dotted.slice(1).map(Number);
        if (octets.some(octet => octet > 255)) return null;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };
  const head = parsePart(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parsePart(halves[1]);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

function isPrivateHostLiteral(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (privateIpv4(host)) return true;
  if (!host.startsWith('[') || !host.endsWith(']')) return false;
  const groups = ipv6Groups(host.slice(1, -1));
  // An IPv6 literal this parser cannot read is refused rather than allowed:
  // an unreadable address is not an argument that it is public.
  if (!groups) return true;
  if (groups.every(group => group === 0)) return true;                    // ::
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true;  // ::1
  if ((groups[0] & 0xfe00) === 0xfc00) return true;                       // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return true;                       // fe80::/10 link-local
  if ((groups[0] & 0xffc0) === 0xfec0) return true;                       // fec0::/10 deprecated site-local
  const mapped = groups.slice(0, 5).every(group => group === 0) && (groups[5] === 0 || groups[5] === 0xffff);
  if (mapped) {
    const dotted = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
    return privateIpv4(dotted);
  }
  return false;
}

class RunnerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
    this.details = details;
  }
}

// Only these current-policy decisions permit a named queue pause. A native
// wrapper failure or an arbitrary callback error cannot claim this contract.
class ResearchPolicyRefusal extends RunnerError {
  constructor(code, message, reason) {
    if (!['RESEARCH_PROJECT_DISABLED', 'RESEARCH_PAUSED_BY_SETTINGS'].includes(code)
        || !['project', 'pipeline', 'runner'].includes(reason)) {
      throw new RunnerError('RESEARCH_RUNNER_POLICY_INVALID', 'The research policy refusal is not a known pause decision.');
    }
    super(code, message);
    this.name = 'ResearchPolicyRefusal';
    this.reason = reason;
  }
}

// {name} → params.name, every occurrence, every param stringified. A token
// naming a param the run does not carry is a refusal, not an empty string —
// an empty string is how a wrong command runs quietly.
function substitute(template, params, label) {
  return String(template).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (token, name) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new RunnerError('RESEARCH_RUNNER_PARAM_MISSING', `${label} references {${name}} but the run's params do not carry it.`, { name });
    }
    if (typeof value === 'object') {
      throw new RunnerError('RESEARCH_RUNNER_PARAM_NOT_TEXT', `${label} references {${name}} but that param is not a plain value.`, { name });
    }
    return String(value);
  });
}

function boundedAppend(existing, chunk) {
  if (existing.length >= MAX_CAPTURE_BYTES) return existing;
  return Buffer.concat([existing, chunk]).subarray(0, MAX_CAPTURE_BYTES);
}

// The 'codex-account' seam: an experiment may declare that its child runs
// under a named provider account's scrubbed launch environment. This module
// knows the HOOK, never the domain — which accounts exist and what they are
// for is the multi-account registry's business.
function environmentForProfile(profile, accountName) {
  if (profile !== 'codex-account') {
    throw new RunnerError('RESEARCH_ENV_PROFILE_UNSUPPORTED', `envProfile must be "codex-account" when declared; "${profile}" is not known.`, { profile });
  }
  let registry;
  let launch;
  try {
    registry = require('../multi-account/registry');
    launch = require('../multi-account/launch');
  } catch (error) {
    // MODULE_NOT_FOUND only proves this feature absent when the missing module
    // is one of the two modules requested here. A missing transitive dependency
    // and operational loader failures (EMFILE, EAGAIN, EIO, EBUSY, timeouts)
    // mean that this attempt could not tell; Node does not cache failed loads.
    const firstLine = String(error && error.message || '').split('\n', 1)[0];
    const requestedModuleIsAbsent = error && error.code === 'MODULE_NOT_FOUND'
      && (firstLine.includes("'../multi-account/registry'") || firstLine.includes("'../multi-account/launch'"));
    if (requestedModuleIsAbsent) {
      throw new RunnerError('RESEARCH_ENV_PROFILE_UNAVAILABLE', 'The account launch environment is not available on this host.');
    }
    throw new RunnerError(
      'RESEARCH_ENV_PROFILE_INDETERMINATE',
      'The account launch environment could not be loaded right now; this does not claim that it is absent.',
      { causeCode: error && typeof error.code === 'string' ? error.code : null }
    );
  }
  const accounts = typeof registry.listAccounts === 'function' ? registry.listAccounts() : [];
  const list = Array.isArray(accounts) ? accounts : (accounts && Array.isArray(accounts.accounts) ? accounts.accounts : []);
  const account = list.find(entry => entry && entry.name === accountName);
  if (!account) {
    throw new RunnerError('RESEARCH_ENV_PROFILE_ACCOUNT_UNKNOWN', `No registered account is named "${accountName}".`, { accountName });
  }
  return launch.launchEnvironment(account);
}

function childEnvironment({ config, params, artifactDir, runId }) {
  let environment;
  if (config.envProfile !== undefined) {
    const accountName = substitute(String(config.envProfileAccount || ''), params, 'runnerConfig.envProfileAccount');
    environment = environmentForProfile(config.envProfile, accountName);
  } else {
    environment = {};
    for (const key of BASE_ENV_KEYS) {
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    }
  }
  const declared = config.envKeys === undefined ? [] : config.envKeys;
  if (!Array.isArray(declared) || declared.length > MAX_ENV_KEYS || declared.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', `envKeys must be at most ${MAX_ENV_KEYS} plain environment names.`);
  }
  for (const key of declared) {
    // The value fence cannot see a secret that only the NAME gives away, and
    // envKeys copies the live value into a child a config declared. Names
    // shaped like credentials are refused; a study that genuinely needs one
    // is the parameterized auth seam's business, not an env passthrough.
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|AUTH)/i.test(key)) {
      throw new RunnerError('RESEARCH_RUNNER_ENV_REFUSED', `envKeys names "${key}", which is shaped like a credential and is not passed to research work.`, { key });
    }
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  // Additive exports only — the child learns where to put artifacts and which
  // run it is; nothing here rewrites the lane-scope contract.
  environment.TOOLSENABLED_RESEARCH_ARTIFACT_DIR = artifactDir;
  environment.TOOLSENABLED_RESEARCH_RUN = runId;
  return environment;
}

// Spawn the exact declared command with substituted args, a scrubbed
// environment and a hard timeout; capture bounded output; never a shell.
function runProcess({ experiment, run, artifactDir, beforeLaunch, requirePolicy, signal }, dependencies = {}) {
  const config = experiment.runnerConfig || {};
  const pins = provenance.validatePinnedFiles('process', config);
  validateStudyProtocol('process', config);
  const params = run.params || {};
  if (typeof config.command !== 'string' || !config.command.trim()) {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', 'The process runner requires runnerConfig.command.');
  }
  const rawArgs = config.args === undefined ? [] : config.args;
  if (!Array.isArray(rawArgs) || rawArgs.length > MAX_ARGS || rawArgs.some(item => typeof item !== 'string')) {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', `runnerConfig.args must be at most ${MAX_ARGS} strings.`);
  }
  const stdinMode = config.stdin === undefined ? 'none' : config.stdin;
  if (!['none', 'params-json'].includes(stdinMode)) {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', "runnerConfig.stdin must be 'none' or 'params-json'.");
  }
  const command = substitute(config.command, params, 'runnerConfig.command');
  const args = rawArgs.map((item, index) => substitute(item, params, `runnerConfig.args[${index}]`));
  const environment = childEnvironment({ config, params, artifactDir, runId: run.runId });
  const timeoutMs = experiment.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', 'The process timeout must be a positive bounded integer.');
  }
  const cleanupMs = dependencies.cleanupMs === undefined ? PROCESS_CLEANUP_MS : dependencies.cleanupMs;
  if (!Number.isSafeInteger(cleanupMs) || cleanupMs < 100 || cleanupMs > 120_000) {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', 'The internal process cleanup budget must be from 100 through 120000 milliseconds.');
  }
  if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', 'Process cancellation requires an AbortSignal.');
  }
  if (requirePolicy !== undefined && typeof requirePolicy !== 'function') {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', 'The internal research policy check must be a function.');
  }
  let stdinPayload;
  if (stdinMode === 'params-json') {
    try {
      stdinPayload = JSON.stringify(params);
    } catch {
      // An unserializable params object must not quietly launch a process with
      // empty stdin and then report that process's answer as the run's answer.
      throw new RunnerError('RESEARCH_RUNNER_PARAMS_NOT_JSON', 'The run params cannot be serialized for runnerConfig.stdin=params-json.');
    }
  }

  const launchEnvironment = safeLaunchEnvironment(environment, { context: 'research process runner' });
  const invocation = pins ? provenance.invocationReceipt({ command, args, artifactDir, stdinMode, stdinPayload, environment: launchEnvironment }) : null;
  const abortError = () => new RunnerError('RESEARCH_RUN_ABORTED', 'The research command was cancelled by its owner.', {
    causeCode: typeof signal?.reason?.code === 'string' ? signal.reason.code : null
  });
  const requireLaunch = () => { if (signal?.aborted) throw abortError(); };
  const checkPolicy = () => {
    const checked = requirePolicy?.();
    if (checked && typeof checked.then === 'function') {
      Promise.resolve(checked).catch(() => {});
      throw new RunnerError('RESEARCH_RUNNER_POLICY_ASYNC', 'The final research policy check must be synchronous.');
    }
  };
  const launch = () => new Promise(resolve => {
    const startedAt = performance.now();
    const platform = dependencies.platform || process.platform;
    const linux = platform === 'linux';
    const native = linux || platform === 'win32';
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let child = null;
    let started = false;
    let rootExited = false;
    let rootExitCode = null;
    let rootSignal = null;
    let pipesClosed = false;
    let wrapperExitCode = null;
    let nativeReceipt = null;
    let receiptSettled = !native;
    let spawnError = null;
    let rootCreationRefused = false;
    let admissionRefusal = null;
    let failure = null;
    let cleanupTimer = null;
    let fallbackTimer = null;
    let drainTimer = null;
    let stopRequested = false;
    let groupStopRequested = false;
    let fallbackRequested = false;
    const timer = setTimeout(() => { timedOut = true; stop('RESEARCH_RUN_TIMEOUT', `The command exceeded its ${timeoutMs}ms limit.`); }, timeoutMs);
    const finish = () => {
      if (settled) return;
      if (!failure && performance.now() - startedAt >= timeoutMs) {
        timedOut = true;
        failure = { code: 'RESEARCH_RUN_TIMEOUT', message: `The command completed after its ${timeoutMs}ms limit.` };
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(cleanupTimer);
      clearTimeout(fallbackTimer);
      clearTimeout(drainTimer);
      signal?.removeEventListener('abort', abort);
      const empty = native && nativeReceipt !== null && nativeReceipt.type !== 'not-started' && pipesClosed;
      // A policy pause may release the queue only after the retained helper's
      // non-start receipt AND close. A callback refusal or wrapper kill alone
      // is not enough, even when no root spawn event was observed.
      const notStarted = pipesClosed && (!child || rootCreationRefused
        && (!admissionRefusal || nativeReceipt?.type === 'not-started'));
      const cleanupStatus = empty ? 'EMPTY' : notStarted ? 'NOT_STARTED'
        : !native && pipesClosed && !stopRequested ? 'ROOT_CLOSED' : 'UNKNOWN';
      if (cleanupStatus === 'UNKNOWN' && (!failure || admissionRefusal)) {
        failure = { code: 'RESEARCH_RUN_CLEANUP_UNPROVEN', message: 'The command ended without confirming its process cleanup.' };
      }
      if (!pipesClosed && child) {
        child.unref?.();
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      const exitCode = native ? nativeReceipt?.type === 'exit' ? nativeReceipt.exitCode : null : rootExitCode;
      const identity = native && (linux ? child?.ownershipIdentity : child?.jobIdentity);
      resolve({
        kind: 'process', exitCode, signal: rootSignal, timedOut, cancelled,
        spawnError, failure, ...(admissionRefusal ? { admissionRefusal } : {}),
        stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
        stdoutBytes, stderrBytes,
        stdoutTruncated: stdoutBytes > stdout.length,
        stderrTruncated: stderrBytes > stderr.length,
        durationMs: performance.now() - startedAt,
        processLifecycle: {
          schemaVersion: 1, backend: linux ? 'linux-subreaper-pidfd-v2' : native ? 'windows-job' : 'posix-process-group',
          scope: linux ? 'The retained Linux guardian, pidfd-verified children reaped to ECHILD and observed pipe closure.'
            : native ? 'The retained native Job and observed wrapper/pipe closure.'
            : 'Normal root exit and pipe closure only; descendants that leave the process group are not observed.',
          started, rootExited, pipesClosed, wrapperClosed: native ? pipesClosed : null,
          wrapperExitCode: native ? wrapperExitCode : null,
          cleanupStatus, stopRequested, groupStopRequested, fallbackRequested,
          receipt: nativeReceipt,
          identity: identity ? linux ? { ...identity } : { jobId: identity.jobId, wrapperPid: identity.wrapperPid,
            wrapperStartTicks: identity.wrapperStartTicks, rootPid: identity.rootPid, rootStartTicks: identity.rootStartTicks } : null,
          acceptanceReady: !failure && exitCode === 0 && rootSignal === null && pipesClosed
            && (native ? empty && nativeReceipt.type === 'exit' && wrapperExitCode === 0 : !stopRequested),
        }
      });
    };
    const maybeFinish = () => { if (pipesClosed && receiptSettled) finish(); };
    const recordReceipt = outcome => {
      if (settled) return;
      receiptSettled = true;
      const verifiedNonStart = admissionRefusal && rootCreationRefused && !started
        && outcome?.type === 'not-started' && !outcome.failure && outcome.activeProcesses === 0
        && (linux ? outcome.backend === linuxProcesses.BACKEND && child?.ownershipIdentity?.backend === linuxProcesses.BACKEND
          && outcome.observedChildren === 0 && outcome.reapedChildren === 0
          && outcome.exitCode === null && outcome.exitSignal === null
          : native && !child?.jobIdentity && Number.isInteger(outcome.exitCode));
      if (verifiedNonStart) {
        nativeReceipt = { type: 'not-started', exitCode: outcome.exitCode, activeProcesses: 0,
          ...(linux ? { backend: outcome.backend, exitSignal: null, observedChildren: 0, reapedChildren: 0 } : {}) };
        maybeFinish();
        return;
      }
      const linuxOutcome = linux && outcome?.backend === linuxProcesses.BACKEND && child?.ownershipIdentity?.backend === linuxProcesses.BACKEND
        && Number.isSafeInteger(outcome.observedChildren) && outcome.observedChildren > 0
        && outcome.observedChildren === outcome.reapedChildren
        && ((Number.isInteger(outcome.exitCode) && outcome.exitSignal === null)
          || (outcome.exitCode === null && typeof outcome.exitSignal === 'string'));
      if (!outcome || outcome.failure || !['exit', 'terminated'].includes(outcome.type)
          || outcome.activeProcesses !== 0 || (linux ? !linuxOutcome : !Number.isInteger(outcome.exitCode) || !child?.jobIdentity)) {
        stop('RESEARCH_RUN_CLEANUP_UNPROVEN', 'The native Job did not return an authenticated zero-member outcome.');
      } else {
        nativeReceipt = { type: outcome.type, exitCode: outcome.exitCode, activeProcesses: 0 };
        if (linux) {
          rootSignal = outcome.exitSignal;
          Object.assign(nativeReceipt, { backend: outcome.backend, exitSignal: outcome.exitSignal,
            observedChildren: outcome.observedChildren, reapedChildren: outcome.reapedChildren });
        }
        rootExited = true;
        if (outcome.type === 'terminated' && !failure) stop('RESEARCH_RUN_PROCESS_TERMINATED', 'The native Job was terminated before normal completion.');
      }
      maybeFinish();
    };
    const stop = (code, message) => {
      if (settled) return;
      if (!failure) failure = { code, message };
      if (!cleanupTimer) cleanupTimer = setTimeout(finish, cleanupMs);
      if (!child || pipesClosed || stopRequested) { maybeFinish(); return; }
      stopRequested = true;
      if (native) {
        Promise.resolve().then(() => child.terminateJob()).then(recordReceipt, () => {});
        fallbackTimer = setTimeout(() => {
          if (settled || pipesClosed) return;
          fallbackRequested = true;
          Promise.resolve().then(() => child.terminateRetainedWrapper()).catch(() => {});
        }, Math.max(1, Math.floor(cleanupMs / 2)));
      } else if (!rootExited && Number.isSafeInteger(child.pid) && child.pid > 0) {
        // This is the new group created by detached:true, while its launched
        // root is retained. Never rediscover a PID tree, or signal this numeric
        // group after observing the root exit. This is not a Windows Job proof.
        groupStopRequested = true;
        try { (dependencies.killProcessGroup || process.kill)(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch {} }
      }
    };
    const abort = () => { cancelled = true; stop('RESEARCH_RUN_ABORTED', 'The research command was cancelled by its owner.'); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      cancelled = true;
      failure = { code: 'RESEARCH_RUN_ABORTED', message: 'The command was cancelled before process creation.' };
      pipesClosed = true;
      receiptSettled = true;
      finish();
      return;
    }
    try {
      const options = { cwd: artifactDir, env: launchEnvironment, windowsHide: true, shell: false,
        stdio: [stdinMode === 'none' ? 'ignore' : 'pipe', 'pipe', 'pipe'] };
      child = native ? (linux ? dependencies.spawnLinuxOwned || linuxProcesses.spawnLinuxOwned
        : dependencies.spawnInJob || windowsJobs.spawnInJob)(command, args, {
        ...options, terminateDescendantsOnRootExit: true
      }, { safeLaunchEnvironment, cleanupTimeoutMs: cleanupMs, beforeRootSpawn: () => {
        try {
          requireLaunch();
          // Native wrapper startup is inside the command budget. A late
          // handshake must not authorize the root after stop/timeout won.
          if (failure || performance.now() - startedAt >= timeoutMs) {
            throw new RunnerError(failure?.code || 'RESEARCH_RUN_TIMEOUT',
              'The command no longer has permission to start.');
          }
          checkPolicy();
        } catch (error) {
          rootCreationRefused = true;
          if (error instanceof ResearchPolicyRefusal) {
            admissionRefusal = { code: error.code, message: error.message, reason: error.reason };
            if (!failure) failure = { code: error.code, message: error.message };
          }
          throw error;
        }
      } })
        : (dependencies.spawn || spawn)(command, args, { ...options, detached: true });
    } catch (error) {
      spawnError = String(error?.message || error).slice(0, 500);
      failure = { code: 'RESEARCH_RUN_SPAWN_FAILED', message: spawnError };
      pipesClosed = true;
      receiptSettled = true;
      finish();
      return;
    }
    pendingProcessChildren.add(child);
    const capture = (channel, data) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (channel === 'stdout') { stdoutBytes += chunk.length; stdout = boundedAppend(stdout, chunk); }
      else { stderrBytes += chunk.length; stderr = boundedAppend(stderr, chunk); }
      if (stdoutBytes > MAX_CAPTURE_BYTES || stderrBytes > MAX_CAPTURE_BYTES) {
        stop('RESEARCH_RUN_OUTPUT_INCOMPLETE', 'The command exceeded its output capture limit and was asked to stop.');
      }
    };
    child.stdout.on('data', chunk => capture('stdout', chunk));
    child.stderr.on('data', chunk => capture('stderr', chunk));
    child.stdin?.on('error', () => stop('RESEARCH_RUN_STDIN_FAILED', 'The declared stdin payload could not be delivered completely.'));
    child.once('spawn', () => {
      started = true;
      if (signal?.aborted) abort();
      if (!failure && stdinMode === 'params-json') {
        try { child.stdin.end(stdinPayload); }
        catch { stop('RESEARCH_RUN_STDIN_FAILED', 'The declared stdin payload could not be delivered completely.'); }
      }
    });
    child.once('error', error => {
      if (!started) spawnError = String(error?.message || error).slice(0, 500);
      if (!native && !started) rootCreationRefused = true;
      stop(started ? 'RESEARCH_RUN_CLEANUP_UNPROVEN' : 'RESEARCH_RUN_SPAWN_FAILED',
        started ? 'The retained process lifecycle failed to confirm cleanup.' : spawnError);
    });
    child.once('exit', (code, exitSignal) => {
      if (!native) { rootExited = true; rootExitCode = code; rootSignal = exitSignal || null; }
      if (!settled && !pipesClosed) drainTimer = setTimeout(() => {
        stop('RESEARCH_RUN_PIPE_CLOSE_TIMEOUT', 'The process exited while output pipes remained open.');
      }, PROCESS_PIPE_DRAIN_MS);
    });
    child.once('close', (code, closeSignal) => {
      pendingProcessChildren.delete(child);
      pipesClosed = true;
      if (native) wrapperExitCode = linux ? child.wrapperExitCode : code;
      else { rootExited = started; rootExitCode = code; rootSignal = closeSignal || null; }
      // Both owned backends can emit close before their outcome promise's
      // reaction runs. A typed policy refusal must wait for that receipt.
      if (!started && (!native || !admissionRefusal)) receiptSettled = true;
      maybeFinish();
      if (!settled && !cleanupTimer) cleanupTimer = setTimeout(() => {
        stop('RESEARCH_RUN_CLEANUP_UNPROVEN', 'The wrapper closed without a native terminal receipt.');
        finish();
      }, cleanupMs);
    });
    if (native) {
      child.jobReady.catch(error => {
        rootCreationRefused = rootCreationRefused || error?.code === 'WINDOWS_JOB_CHILD_SPAWN_FAILED'
          || error?.code === 'WINDOWS_JOB_WRAPPER_UNAVAILABLE';
        spawnError = String(error?.message || error).slice(0, 500);
        stop('RESEARCH_RUN_SPAWN_FAILED', spawnError);
      });
      child.jobOutcome.then(recordReceipt, () => {
        receiptSettled = true;
        stop('RESEARCH_RUN_CLEANUP_UNPROVEN', 'The native wrapper did not confirm a terminal Job outcome.');
        maybeFinish();
      });
    }
  });
  return (async () => {
    requireLaunch();
    checkPolicy();
    const before = pins ? await provenance.verifyPinnedFiles(pins, 'before-process') : null;
    // Hashing is asynchronous. The worker must recheck its claim before the
    // first side effect if cancellation, stop, or lease loss arrived meanwhile.
    if (beforeLaunch) await beforeLaunch();
    requireLaunch();
    checkPolicy();
    const outcome = await launch();
    // Uncertain cleanup may leave writers active. Do not inspect their files
    // or turn partial output into a provenance receipt after a failed run.
    if (!pins || !outcome.processLifecycle.acceptanceReady) return outcome;
    const after = await provenance.verifyPinnedFiles(pins, 'after-process');
    return { ...outcome, provenance: provenance.processReceipt({ invocation, before, after, runId: run.runId }) };
  })();
}

// One declared HTTPS request. No credential-shaped headers, encrypted
// transport only; the parameterized auth seam (authProfile) is a named v1.1
// item, not something a header string can smuggle in early.
async function runHttp({ experiment, run }) {
  const config = experiment.runnerConfig || {};
  provenance.validatePinnedFiles('http', config);
  validateStudyProtocol('http', config);
  const params = run.params || {};
  if (typeof config.url !== 'string' || !config.url.trim()) {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', 'The http runner requires runnerConfig.url.');
  }
  const url = substitute(config.url, params, 'runnerConfig.url');
  let parsed;
  try { parsed = new URL(url); } catch {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', 'The substituted url is not a valid URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new RunnerError('RESEARCH_RUNNER_HTTPS_REQUIRED', 'The http runner sends over encrypted connections only.');
  }
  if (parsed.username || parsed.password) {
    throw new RunnerError('RESEARCH_RUNNER_CREDENTIAL_REFUSED', 'The declared url carries userinfo credentials, which this runner refuses.');
  }
  // The host can arrive through {param} substitution, so encrypted-only is not
  // an internal-network control on its own. See isPrivateHostLiteral above for
  // what this refuses and what it cannot see.
  if (isPrivateHostLiteral(parsed.hostname)) {
    throw new RunnerError('RESEARCH_RUNNER_HOST_REFUSED', `The declared request targets "${parsed.hostname}", a local or private address; the http runner reaches outside services only.`, { host: parsed.hostname });
  }
  const method = config.method === undefined ? 'GET' : String(config.method).toUpperCase();
  if (!['GET', 'POST', 'PUT'].includes(method)) {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', "runnerConfig.method must be GET, POST or PUT.");
  }
  const headers = {};
  const declaredHeaders = config.headers === undefined ? {} : config.headers;
  if (!declaredHeaders || typeof declaredHeaders !== 'object' || Array.isArray(declaredHeaders)) {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', 'runnerConfig.headers must be an object.');
  }
  for (const [name, value] of Object.entries(declaredHeaders)) {
    if (CREDENTIAL_HEADERS.has(name.toLowerCase())) {
      throw new RunnerError('RESEARCH_RUNNER_CREDENTIAL_REFUSED', `The "${name}" header carries authority and is refused; credentialed sweeps are the authProfile seam.`);
    }
    headers[name] = substitute(String(value), params, `runnerConfig.headers.${name}`);
  }
  const body = config.bodyTemplate === undefined ? undefined : substitute(String(config.bodyTemplate), params, 'runnerConfig.bodyTemplate');
  const startedAt = Date.now();
  const response = await request(url, {
    method, headers, body, timeoutMs: experiment.timeoutMs,
    retries: method === 'GET' ? 2 : 0, redirect: 'manual',
    responseMode: 'text', maxResponseBytes: MAX_HTTP_BODY_BYTES
  });
  if (typeof response.body !== 'string' || typeof response.truncated !== 'boolean' || !Number.isSafeInteger(response.bodyBytes)) {
    throw new RunnerError('RESEARCH_RUNNER_RESPONSE_INVALID', 'The HTTP transport did not return bounded text and its completeness metadata.');
  }
  return {
    kind: 'http', status: response.status,
    body: response.body, truncated: response.truncated, bodyBytes: response.bodyBytes,
    durationMs: Date.now() - startedAt
  };
}

function bridgeStateIndeterminate(error) {
  return new RunnerError(
    'RESEARCH_BRIDGE_STATE_INDETERMINATE',
    'The mission bridge state could not be read right now; this does not claim that the bridge is absent.',
    { causeCode: error && typeof error.code === 'string' ? error.code : null }
  );
}

function readOwnerOnlyRecord(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (error) {
    // ENOENT is the one read failure that establishes absence. Resource
    // exhaustion, a busy device, I/O failure, and a malformed/partial record
    // only establish that this attempt could not inspect the bridge state.
    if (error && error.code === 'ENOENT') return null;
    throw bridgeStateIndeterminate(error);
  }
}

// Default agent dispatch: POST the live bridge's own dispatch action over
// loopback, with the same per-boot bearer every local client uses. Going
// through the bridge, not around it, keeps one launch choke point — research
// agent runs get launch records, pg2 presence and audit exactly like a
// human-clicked launch.
async function defaultDispatch({ brief, objectiveRef, timeoutMs }, dependencies = {}) {
  // The path resolver is injectable only through this second, internal-facing
  // argument. Production callers pass one request object; tests can point the
  // exact owner-record reader at disposable state without globally replacing
  // fs.readFileSync (which would also corrupt runtime-state-root resolution).
  const resolveRootPath = typeof dependencies.rootPath === 'function'
    ? dependencies.rootPath
    : rootPath;
  let runtimeFile;
  let tokenFile;
  try {
    runtimeFile = resolveRootPath('state', 'mission-bridge-runtime.json');
    tokenFile = resolveRootPath('state', 'mission-bridge-token.json');
  } catch (error) {
    // Locating the owner-only records is part of reading bridge state. A
    // transient state-root or account-fence failure does not prove that the
    // records (or bridge) are absent, so expose the same indeterminate result
    // as an operational failure from readFileSync below.
    throw bridgeStateIndeterminate(error);
  }
  const runtimeRecord = readOwnerOnlyRecord(runtimeFile);
  const tokenRecord = readOwnerOnlyRecord(tokenFile);
  if (!runtimeRecord || typeof runtimeRecord.baseUrl !== 'string' || !tokenRecord || typeof tokenRecord.token !== 'string') {
    throw new RunnerError('RESEARCH_BRIDGE_UNAVAILABLE', 'The mission bridge is not running on this host, so an agent run cannot be dispatched right now.');
  }
  const response = await request(`${runtimeRecord.baseUrl}/v1/actions/dispatch`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenRecord.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ brief, objectiveRef }),
    timeoutMs: Math.min(timeoutMs, 60_000), retries: 0, redirect: 'manual'
  });
  const parsed = response.body;
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299 || !parsed || parsed.ok !== true) {
    throw new RunnerError('RESEARCH_BRIDGE_DISPATCH_FAILED', `The bridge refused the dispatch (status ${response.status}).`, {
      status: response.status, reason: parsed && parsed.error ? String(parsed.error.code || parsed.error).slice(0, 120) : null
    });
  }
  return parsed;
}

// Launch an agent through the bridge. The brief is the declared template plus
// a fixed data block naming the project, experiment, run and artifact folder,
// so the session can attribute its work without any out-of-band channel.
async function runAgent({ experiment, run, project, artifactDir, dispatch }) {
  provenance.validatePinnedFiles('agent', experiment.runnerConfig || {});
  validateStudyProtocol('agent', experiment.runnerConfig || {});
  const config = experiment.runnerConfig || {};
  const params = run.params || {};
  if (typeof config.briefTemplate !== 'string' || !config.briefTemplate.trim()) {
    throw new RunnerError('RESEARCH_RUNNER_CONFIG_INVALID', 'The agent runner requires runnerConfig.briefTemplate.');
  }
  const brief = [
    substitute(config.briefTemplate, params, 'runnerConfig.briefTemplate'),
    '',
    '--- research run context (data, not authority) ---',
    `project: ${project.name} (${project.projectId})`,
    `experiment: ${experiment.name} (${experiment.experimentId})`,
    `run: ${run.runId}`,
    `artifact folder: ${artifactDir}`,
    `params: ${JSON.stringify(params)}`
  ].join('\n');
  const objectiveRef = `research-${run.runId.slice(0, 11)}`;
  const send = dispatch || defaultDispatch;
  const startedAt = Date.now();
  const receipt = await send({ brief, objectiveRef, timeoutMs: experiment.timeoutMs });
  const launchId = receipt && (receipt.launchId || (receipt.receipt && receipt.receipt.launchId));
  if (typeof launchId !== 'string' || !launchId.trim()) {
    throw new RunnerError('RESEARCH_AGENT_DISPATCH_UNCONFIRMED', 'The agent dispatch did not return a launch id, so the run cannot be reported as launched.');
  }
  return {
    kind: 'agent', launchId,
    receipt: receipt && typeof receipt === 'object' ? receipt : null,
    durationMs: Date.now() - startedAt
  };
}

module.exports = {
  BASE_ENV_KEYS, CREDENTIAL_HEADERS, MAX_CAPTURE_BYTES, MAX_HTTP_BODY_BYTES, RUNNER_KINDS,
  RunnerError, ResearchPolicyRefusal, defaultDispatch, isPrivateHostLiteral, runAgent, runHttp, runProcess, substitute
};
