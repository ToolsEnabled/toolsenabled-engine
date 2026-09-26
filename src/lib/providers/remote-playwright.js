'use strict';

// Peer-safe facade over the checked-in Playwright gateway. Calls still pass
// through the gateway's positive tool allowlist, owned-browser/CDP check,
// egress preflight, owner-request gates, kill switch, and browser audit. The
// facade exists so FRA can expose the peer's browser without exposing CDP or
// launching a second browser transport outside those controls.

const browserOwner = require('../browser-owner');
const audit = require('../operation-audit');
const { assertActive } = require('../policy');
const { executeOneShot, listTools, validateRequestObject, PlaywrightSession } = require('../../../tools/playwright-call');
const { redactPlaywrightResponse } = require('../../playwright-gateway');

const TIMEOUT_MS = 180_000;
const sessions = new Map();
const anonymousSessions = new WeakMap();
const WORKFLOW = Object.freeze({
  start: 'Call browser.start once if browser.status reports no owned browser.',
  discover: 'Call browser.playwright_tools for exact schemas. These calls work in Enabled and Only API modes when assigned to your role and permitted by your installation.',
  navigate: 'Call browser_navigate, then browser_snapshot. For a large page, browser_find returns matching snapshot nodes without the entire tree. Pass a current ref or unique selector as target for browser_click/browser_type; older ref arguments are accepted. Refresh after navigation or stale-ref errors.',
  tabs: 'Use browser_tabs list before select. A bound agent session retains the selected tab and refs between calls. Keep dependent actions sequential.',
  software: 'For ToolsEnabled screens use app.context and app.navigate. For desktop software call screen.status, then screen.control with action screenshot to acquire a turn and inspect. The person enables access in Settings → App permissions or Page 2. One agent holds control; wait on busy, keep actions sequential, and call action release when finished. Browser tabs remain separate from native desktop control.',
  recover: 'After a transport failure, inspect current page state before repeating an action; it may already have completed. Never automatically replay a click, upload or form submission.'
});

function sessionFor(context = {}) {
  const principal = context.agentPrincipal;
  const identity = principal?.kind === 'agent-session' && principal.sessionId
    ? JSON.stringify([principal.sessionId, principal.agentId])
    : context.agentSessionId ? JSON.stringify([context.agentSessionId, context.agentId || context.agentActor || '']) : null;
  const scope = identity || context.fileToolContext;
  if (!scope || (typeof scope !== 'string' && typeof scope !== 'object')) return null;
  const store = identity ? sessions : anonymousSessions;
  let session = store.get(scope);
  if (!session || session.closed) {
    if (identity) {
      for (const [key, value] of sessions) if (value.closed) sessions.delete(key);
      if (sessions.size >= 32) throw new RemotePlaywrightError('PLAYWRIGHT_SESSION_LIMIT', 'Browser sessions are busy. Let an idle session expire before opening another.');
    }
    session = new PlaywrightSession({ timeoutMs: TIMEOUT_MS });
    store.set(scope, session);
  }
  return session;
}

async function closeSession(sessionId) {
  const closing = [];
  for (const [key, session] of sessions) {
    if (JSON.parse(key)[0] === sessionId) { sessions.delete(key); closing.push(session.close()); }
  }
  await Promise.all(closing);
}

async function closeContext(scope) {
  const session = scope && anonymousSessions.get(scope);
  if (session) { anonymousSessions.delete(scope); await session.close(); }
}

class RemotePlaywrightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RemotePlaywrightError';
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function normalizeRequest({ name, arguments: args } = {}) {
  if (typeof name !== 'string' || !/^browser_[a-z0-9_]+$/.test(name)) {
    throw new RemotePlaywrightError('REMOTE_PLAYWRIGHT_TOOL_INVALID', 'A reviewed browser tool name is required.');
  }
  if (!plainObject(args)) {
    throw new RemotePlaywrightError('REMOTE_PLAYWRIGHT_ARGUMENTS_INVALID', 'Browser tool arguments must be one JSON object.');
  }
  try { return validateRequestObject({ tool: name, arguments: args }); }
  catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'REMOTE_PLAYWRIGHT_ARGUMENTS_INVALID';
    throw new RemotePlaywrightError(code, redactPlaywrightResponse(error.message));
  }
}

function status() {
  assertActive('browser.playwright_status');
  const owner = browserOwner.status();
  const result = {
    owned: owner.owned === true,
    ownerStatus: owner.ownerStatus || null,
    generation: typeof owner.generation === 'string' ? owner.generation : null,
    peerCallable: owner.owned === true,
    nextAction: owner.owned === true ? 'browser.playwright_tools' : 'browser.start',
    workflow: WORKFLOW
  };
  audit.record('browser.playwright_status', 'owned-browser', {
    owned: result.owned,
    ownerStatus: result.ownerStatus
  });
  return result;
}

async function tools(context = {}) {
  assertActive('browser.playwright_tools');
  audit.requireRecord('browser.playwright_tools.intent', 'owned-browser', { peerFacade: true });
  try {
    const session = sessionFor(context);
    const surface = session ? await session.tools() : await listTools({ timeoutMs: TIMEOUT_MS });
    audit.record('browser.playwright_tools.result', 'owned-browser', { toolCount: surface.length });
    return { tools: surface, workflow: WORKFLOW, persistentSession: Boolean(session) };
  } catch (error) {
    audit.record('browser.playwright_tools.failed', 'owned-browser', {
      code: error && typeof error.code === 'string' ? error.code : 'REMOTE_PLAYWRIGHT_LIST_FAILED'
    });
    throw error;
  }
}

async function call(args = {}, context = {}) {
  assertActive('browser.playwright_call');
  const request = normalizeRequest(args);
  audit.requireRecord('browser.playwright_call.intent', request.tool, { peerFacade: true });
  try {
    const session = sessionFor(context);
    const response = redactPlaywrightResponse(session ? await session.call(request)
      : (await executeOneShot(request, { timeoutMs: TIMEOUT_MS })).response);
    audit.record('browser.playwright_call.result', request.tool, {
      rpcError: Boolean(response && response.error),
      isError: Boolean(response && response.result && response.result.isError)
    });
    const failed = Boolean(response?.error || response?.result?.isError);
    const result = { upstreamResponse: response, ok: !failed, persistentSession: Boolean(session),
      ...(failed ? { recovery: WORKFLOW.recover + ' ' + WORKFLOW.navigate } : {}) };
    // Preserve native MCP image/text blocks and isError for API-only clients.
    // A Symbol cannot be forged by JSON content returned from a web page.
    if (response?.result) Object.defineProperty(result, Symbol.for('toolsenabled.playwright.result'), { value: response.result });
    else if (response?.error) Object.defineProperty(result, Symbol.for('toolsenabled.playwright.result'), { value: {
      isError: true, content: [{ type: 'text', text: `Browser call failed. ${WORKFLOW.recover}` }]
    } });
    return result;
  } catch (error) {
    audit.record('browser.playwright_call.failed', request.tool, {
      code: error && typeof error.code === 'string' ? error.code : 'REMOTE_PLAYWRIGHT_CALL_FAILED'
    });
    throw error;
  }
}

module.exports = Object.freeze({
  WORKFLOW,
  closeSession,
  closeContext,
  RemotePlaywrightError,
  TIMEOUT_MS,
  normalizeRequest,
  // Direct callers and registry callers share the same trusted request
  // snapshot. An in-flight toggle cannot split intent and outcome policy.
  status: (...args) => audit.withPolicy(audit.capturePolicy(), () => status(...args)),
  tools: async (...args) => audit.withPolicy(audit.capturePolicy(), () => tools(...args)),
  call: async (...args) => audit.withPolicy(audit.capturePolicy(), () => call(...args))
});
