'use strict';

const path = require('node:path');
const { assertAntigravitySurface } = require('./antigravity-confinement');
const { scopedEnvironment } = require('../../../tools/antigravity-mcp-owner-proxy');
const { AntigravityCliAdapter, ANTIGRAVITY_MAX_TURN_MS, failure } = require('./antigravity-cli-adapter');
const { createCodexProcessTransport } = require('./codex-process');
const { createStartupControl } = require('./startup-control');
const { cleanupFailure, validateCleanupTimeout, withOwnedStartupCleanup } = require('./codex-startup-cleanup');
const { safeLaunchEnvironment } = require('../supervision/launch-environment');

/* WHICH ANTIGRAVITY ANSWERED, FOR THE SESSION RECORD.
 *
 * Antigravity updates itself, so the copy on a computer moves on without
 * ToolsEnabled; the notes in this engine were written against 1.2.0 and this
 * computer ran 1.2.2 by 2026-09-22. A start reads the program's own
 * `--version` once, in the launch's own environment (its account home,
 * self-update off), with stdin closed and a 10 s limit, and returns it as
 * `cliVersion` beside the session, the field the Claude engine already
 * reports. It is read at session start only; no screen starts the program to
 * ask.
 *
 * BEST EFFORT AND NEVER FATAL. A version that cannot be read is null and the
 * session starts exactly as before. A version never admits or refuses a start.
 * MEASURED 2026-09-22 on agy 1.2.2 and 1.2.8: the bare version on stdout,
 * exit 0, in under a second, and nothing written to the home it ran in. */
const ANTIGRAVITY_VERSION_OUTPUT_LIMIT = 4096;
function readAntigravityVersion({ command = 'agy', env, cwd, timeoutMs = 10_000,
  spawnImpl = require('../proc/hidden-spawn').spawnHidden } = {}) {
  return new Promise(resolve => {
    let settled = false;
    let text = '';
    let child;
    let timer = null;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    try {
      child = spawnImpl(command, ['--version'], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { finish(null); return; }
    timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(null); }, timeoutMs);
    child.stdout?.on('data', chunk => {
      if (text.length < ANTIGRAVITY_VERSION_OUTPUT_LIMIT) text += String(chunk).slice(0, ANTIGRAVITY_VERSION_OUTPUT_LIMIT - text.length);
    });
    child.on('error', () => finish(null));
    child.on('close', code => {
      const first = text.trim().split(/\r?\n/)[0] || '';
      /* Output from a failed read is diagnostic text, not a version. */
      finish(code === 0 && /^v?\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/.test(first) ? first : null);
    });
  });
}

async function openAntigravitySession({ plan, command = 'agy', onEvent, rootLaunch, signal = null,
  env, startupTimeoutMs = 60_000, cleanupTimeoutMs = 5_000, threadId = null, threadOptions = {},
  transportFactory = createCodexProcessTransport, readVersion = readAntigravityVersion } = {}) {
  if ([process.env, env || {}, plan?.env || {}].some(value => Object.keys(value).some(key => key.toUpperCase() === 'TOOLSENABLED_PROVIDER_ISOLATION_ROOT'))) {
    throw failure('AGY_CLI_SHARED_AUTH', 'Antigravity uses the owning OS sign-in; it cannot prove an independent private account in this isolated session.');
  }
  const surface = plan?.antigravity;
  if (plan?.ok !== true || plan.agentApiMode !== 'Only' || surface?.contractVersion !== 1
    || !path.isAbsolute(surface.cwd || '') || !path.isAbsolute(surface.accountHome || '')
    || !Array.isArray(surface.tools) || typeof surface.agent !== 'string' || !surface.agent) {
    throw failure('AGY_CLI_PLAN_REQUIRED', 'Antigravity needs a prepared account and Research tool boundary.');
  }
  assertAntigravitySurface(surface);
  scopedEnvironment(plan.env);
  const selected = threadOptions.model;
  const prefix = 'gemini/antigravity/';
  const model = typeof selected === 'string' && selected.startsWith(prefix) ? selected.slice(prefix.length) : null;
  if (!model || !model.startsWith('gemini-') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(model)) {
    throw failure('AGY_CLI_MODEL_REQUIRED', 'Choose an exact model advertised by Antigravity for this account.');
  }
  const effort = threadOptions.effort;
  if (effort != null && !['low', 'medium', 'high'].includes(effort)) {
    throw failure('ACP_EFFORT_UNAVAILABLE', 'Antigravity supports low, medium or high effort. Nothing was started.');
  }
  validateCleanupTimeout(cleanupTimeoutMs);
  const startup = createStartupControl({ signal, timeoutMs: startupTimeoutMs, label: 'Antigravity startup', codePrefix: 'AGY_CLI_START' });
  const ambient = Object.fromEntries(Object.entries(safeLaunchEnvironment(env || process.env)).filter(([key]) =>
    !/^(?:AGY_|ANTIGRAVITY_|GEMINI_|GOOGLE_)/i.test(key)));
  const accountHome = surface.accountHome;
  const childEnv = safeLaunchEnvironment({ ...ambient, ...plan.env,
    HOME: accountHome, USERPROFILE: accountHome,
    XDG_CONFIG_HOME: path.join(accountHome, '.config'), XDG_CACHE_HOME: path.join(accountHome, '.cache'),
    XDG_DATA_HOME: path.join(accountHome, '.local', 'share'), AGY_CLI_DISABLE_AUTO_UPDATE: '1' });
  let transport;
  let adapter;
  let signInRequired = false;
  let removeStderr;
  try {
    startup.throwIfStopped();
    const cliVersion = await startup.wait(() => readVersion({ command, env: childEnv, cwd: surface.cwd }));
    // Through 1.2.5 the native default wait was five minutes, its expiry
    // reported SUCCESS even when work was unfinished, and zero expired at
    // once; from 1.2.6 the default and zero wait without limit. An explicit
    // expiry beyond our absolute turn limit behaves the same on both: our
    // custodian reports a typed failure and closes the job.
    const printTimeout = `${(ANTIGRAVITY_MAX_TURN_MS + 60 * 60_000) / 1000}s`;
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json',
      '--disable-slash-commands', '--print-timeout', printTimeout, '--agent', surface.agent, '--model', model,
      ...(effort == null ? [] : ['--effort', effort]), ...(threadId === null ? [] : ['--conversation', threadId])];
    transport = transportFactory({ command, args, cwd: surface.cwd, env: childEnv, rootLaunch });
    removeStderr = transport.onStderr?.(text => {
      if (/please sign in|launch the cli without arguments to sign in/i.test(text)) signInRequired = true;
    });
    adapter = new AntigravityCliAdapter({ transport, model, tools: surface.tools, agent: surface.agent,
      cwd: surface.cwd, resumeThreadId: threadId, servers: surface.servers,
      assertBoundary: () => assertAntigravitySurface(surface) });
    if (onEvent) adapter.onEvent(onEvent);
    if (rootLaunch) await startup.wait(() => transport.rootReady);
    const started = await startup.wait(() => threadId === null ? adapter.startThread() : adapter.resumeThread(threadId));
    return { adapter, threadId: started.threadId, model: selected, client: 'antigravity',
      // Which program answered: its own version string, or null. Never a path.
      cliVersion: typeof cliVersion === 'string' ? cliVersion : null,
      // The official init event reports model identity, but not effort. Do not
      // manufacture an effort readback or a resumed transcript/turn count.
      ...(threadId === null ? {} : { turns: started.turns }), close: () => adapter.close() };
  } catch (original) {
    const error = signInRequired ? failure('AGY_CLI_AUTH_REQUIRED', 'Sign in through the official Antigravity terminal for this selected account, then try again.') : original;
    const nestedCleanup = typeof original?.retryCleanup === 'function' ? original.retryCleanup.bind(original) : null;
    let cleanupConfirmed = false;
    const retryCleanup = async () => {
      if (cleanupConfirmed) return;
      const errors = [];
      if (nestedCleanup) {
        try { await nestedCleanup(); } catch (cause) { errors.push(cause); }
      }
      try { if (adapter) await adapter.close(); else await transport?.closeForStartupFailure(cleanupTimeoutMs); }
      catch (cause) { errors.push(cause); }
      if (errors.length) throw cleanupFailure('AGY_CLI_START_CLEANUP_UNPROVEN', error, errors, retryCleanup);
      cleanupConfirmed = true;
    };
    await retryCleanup();
    throw withOwnedStartupCleanup(error, retryCleanup);
  } finally { startup.dispose(); removeStderr?.(); }
}

function startAntigravitySession(options) { return openAntigravitySession(options); }
function resumeAntigravitySession(options) {
  if (typeof options?.threadId !== 'string' || !options.threadId) {
    return Promise.reject(failure('AGY_CLI_RESUME_ID_REQUIRED', 'Choose the exact Antigravity conversation to resume.'));
  }
  return openAntigravitySession(options);
}

module.exports = { ROOT_ADMISSION_CONTRACT_VERSION: 1, MODEL_SELECTION_CONTRACT_VERSION: 1,
  readAntigravityVersion, startAntigravitySession, resumeAntigravitySession };
