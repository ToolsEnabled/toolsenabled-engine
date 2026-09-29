'use strict';

const { AcpAdapter } = require('./acp-adapter');
const { createCodexProcessTransport, detectCodexVersion } = require('./codex-process');
const { createStartupControl } = require('./startup-control');
const { cleanupFailure, validateCleanupTimeout, withOwnedStartupCleanup } = require('./codex-startup-cleanup');
const { safeLaunchEnvironment } = require('../supervision/launch-environment');
const { assertGrokInspection } = require('./acp-confinement');
const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = Object.freeze(['gemini', 'grok']);

/* GROK'S REFUSALS NAME GROK AND GROK'S OWN FIX.
 *
 * The Grok preflight runs through the Codex version reader, whose codes name
 * Codex: a missing Grok arrived as CODEX_CLI_NOT_FOUND ("install Codex"), and a
 * Grok that refused an option as CODEX_VERSION_DETECTION_FAILED ("run codex
 * --version"). An agent that refused an option the start passes arrived as
 * ACP_PROCESS_EXITED ("check its sign-in").
 *
 * COMPATIBILITY IS DECIDED BY WHAT THIS GROK ACCEPTS, NEVER BY A VERSION. Grok's
 * argument parser exits 2 with "error: unexpected argument '<x>' found" (or
 * "unrecognized subcommand", "invalid value") when it lacks an option. Recorded
 * from Grok 1.0.25 and 1.0.40 on 2026-09-22; both accept every option used here. */
const GROK_USAGE_ERROR = /(?:^|\n|: )error: (?:unexpected argument|unrecognized subcommand|invalid value)\b/;

function grokRefusal(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function grokIncompatible(detail, cause) {
  const text = String(detail || '');
  if (!GROK_USAGE_ERROR.test(text)) return null;
  const named = text.match(/(?:^|\n|: )error: [^'\n]*'([^'\n]{1,80})'/);
  return grokRefusal('GROK_CLI_INCOMPATIBLE', `This Grok does not accept ${named ? `"${named[1]}"` : 'an option'}, `
    + 'which ToolsEnabled passes when it starts a session. Run "grok update" in a terminal, then start again.', cause);
}

// Only the two answers the reader gives after its child has closed are renamed.
// Timeouts, stops and unproven cleanup keep their own codes and retry custody.
function grokPreflightRefusal(error) {
  if (error?.code === 'CODEX_CLI_NOT_FOUND') {
    return grokRefusal('PROVIDER_LOGIN_NOT_INSTALLED', 'Grok could not be found on this computer. Install Grok, then start again.', error);
  }
  if (error?.code !== 'CODEX_VERSION_DETECTION_FAILED') return error;
  return grokIncompatible(error.message, error) || grokRefusal('GROK_CLI_CHECK_FAILED',
    'Grok did not answer when ToolsEnabled checked its tools and extensions. Run "grok inspect" in a terminal to see what it reports.', error);
}

// An agent process that ended with the parser's own refusal, before any
// session existed, was refused an option the start passed. The parser exits 2,
// but the closed pipe is often reported first (code null, "read ECONNRESET"),
// so the status may be missing; a signal is never this refusal.
function grokStartRefusal(error) {
  const exit = error?.code === 'ACP_PROCESS_EXITED' ? error.exit : null;
  if (!exit || exit.signal !== null || (exit.code !== 2 && exit.code !== null)) return null;
  return grokIncompatible(exit.stderr, error);
}

async function openAcpSession({ provider, plan, command = provider, clientInfo, onEvent,
  rootLaunch, signal = null, env, startupTimeoutMs = 60_000, cleanupTimeoutMs = 5_000,
  threadId = null, threadOptions = {}, transportFactory = createCodexProcessTransport, inspect = detectCodexVersion } = {}) {
  if (!PROVIDERS.includes(provider) || plan?.ok !== true || plan?.agentApiMode !== 'Only' ||
    plan?.acp?.provider !== provider || !Array.isArray(plan.acp.args) || !Array.isArray(plan.acp.mcpServers)) {
    const error = new Error('This assistant needs a prepared Research tool and account boundary.');
    error.code = 'AGENT_ACP_PLAN_REQUIRED';
    throw error;
  }
  validateCleanupTimeout(cleanupTimeoutMs);
  const requestedModel = threadOptions.model;
  const model = requestedModel === undefined || requestedModel === null || requestedModel === `${provider}/auto`
    ? null : typeof requestedModel === 'string' && requestedModel.startsWith(`${provider}/`)
      ? requestedModel.slice(provider.length + 1) : requestedModel;
  if (model !== null && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(model))) {
    const error = new Error('Choose an exact model advertised by this provider.');
    error.code = 'ACP_MODEL_UNAVAILABLE';
    throw error;
  }
  const startup = createStartupControl({ signal, timeoutMs: startupTimeoutMs, label: `${provider} startup`, codePrefix: 'ACP_START' });
  let transport;
  let adapter;
  const ambient = Object.fromEntries(Object.entries(safeLaunchEnvironment(env || process.env)).filter(([key]) =>
    !/^(?:GROK_|GEMINI_|GOOGLE_)/i.test(key)));
  const childEnv = safeLaunchEnvironment({ ...ambient, ...plan.env });
  try {
    startup.throwIfStopped();
    if (provider === 'gemini') {
      let signedIn = false;
      try {
        const stat = fs.lstatSync(path.join(plan.configDir, '.gemini', 'oauth_creds.json'));
        signedIn = stat.isFile() && !stat.isSymbolicLink() && stat.size > 0;
      } catch { /* Presence is not a reason to open or copy a credential. */ }
      if (!signedIn) {
        const error = new Error('Sign in to Gemini in its official terminal, then start this Research agent again.');
        error.code = 'ACP_AUTH_REQUIRED';
        throw error;
      }
    }
    if (provider === 'grok') {
      let inspection;
      try {
        inspection = await inspect({ provider, command, args: ['--no-auto-update', 'inspect', '--json'], cwd: plan.acp.cwd,
          env: childEnv, signal: startup.signal, containProcessTree: true, cleanupTimeoutMs });
      } catch (error) { throw grokPreflightRefusal(error); }
      assertGrokInspection(inspection);
    }
    startup.throwIfStopped();
    const args = provider === 'grok' ? ['--no-auto-update', ...plan.acp.args]
      : [...plan.acp.args, ...(model ? ['--model', model] : [])];
    transport = transportFactory({ provider, command, args, cwd: plan.acp.cwd, env: childEnv, rootLaunch });
    adapter = new AcpAdapter({ transport, clientInfo, defaultCwd: plan.acp.cwd, mcpServers: plan.acp.mcpServers });
    adapter.modelProvider = provider;
    if (onEvent) adapter.onEvent(onEvent);
    if (rootLaunch) await startup.wait(() => transport.rootReady);
    await startup.wait(() => adapter.initialize());
    const methods = adapter.getAuthMethods();
    // Authenticate through a method actually advertised by the official client.
    // Never receive a password, copy a token, or start a browser in the background.
    const method = methods.find(entry => entry.id === (provider === 'grok' ? 'cached_token' : 'oauth-personal'));
    if (provider === 'grok' && method) await startup.wait(() => adapter.authenticate(method.id, { headless: true }));
    if (provider === 'gemini' && method) await startup.wait(() => adapter.authenticate(method.id));
    const started = await startup.wait(() => threadId === null ? adapter.startThread() : adapter.resumeThread(threadId));
    if (model) await startup.wait(() => adapter.selectModel(started.threadId, model));
    const effort = threadOptions.effort;
    if (effort != null) await startup.wait(() => adapter.selectEffort(started.threadId, effort));
    return { adapter, threadId: started.threadId,
      ...(model ? { model: `${provider}/${model}` } : {}),
      ...(effort != null ? { reasoningEffort: effort } : {}),
      close() { try { adapter.close(); } finally { transport.close(); } } };
  } catch (error) {
    const nestedCleanup = typeof error?.retryCleanup === 'function' ? error.retryCleanup.bind(error) : null;
    let cleanupConfirmed = false;
    const retryCleanup = async () => {
      if (cleanupConfirmed) return;
      const errors = [];
      if (nestedCleanup) {
        try { await nestedCleanup(); } catch (failure) { errors.push(failure); }
      }
      try { adapter?.close(); } catch (failure) { errors.push(failure); }
      try { await transport?.closeForStartupFailure(cleanupTimeoutMs); } catch (failure) { errors.push(failure); }
      if (errors.length) throw cleanupFailure('ACP_START_CLEANUP_UNPROVEN', error, errors, retryCleanup);
      cleanupConfirmed = true;
    };
    await retryCleanup();
    throw withOwnedStartupCleanup((provider === 'grok' && grokStartRefusal(error)) || error, retryCleanup);
  } finally { startup.dispose(); }
}

function startAcpSession(options) { return openAcpSession(options); }
function resumeAcpSession(options) {
  if (typeof options?.threadId !== 'string' || !options.threadId) {
    const error = new Error('Choose the Research conversation to resume.');
    error.code = 'ACP_RESUME_ID_REQUIRED';
    return Promise.reject(error);
  }
  return openAcpSession(options);
}

module.exports = { ROOT_ADMISSION_CONTRACT_VERSION: 1, MODEL_SELECTION_CONTRACT_VERSION: 1, PROVIDERS, startAcpSession, resumeAcpSession };
