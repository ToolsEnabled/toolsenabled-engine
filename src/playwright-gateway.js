#!/usr/bin/env node
'use strict';

// Stdio policy/audit gateway for the upstream Playwright MCP server. Page
// content remains untrusted and otherwise opaque, but credential-shaped values
// in URLs, headers, console/network text, snapshots, and structured content are
// redacted before any upstream response can reach a client or helper output.
const readline = require('node:readline');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { commandPath, ROOT, rootPath } = require('./lib/runtime');
const { assertActive } = require('./lib/policy');
const audit = require('./lib/audit');
const operationAudit = require('./lib/operation-audit');
const egressPreflight = require('./lib/egress-preflight');
const requestContext = require('./lib/request-context');
const googleAccounts = require('./lib/google-accounts');
const { isAccountAwareGoogleUrl, applyGoogleAccount } = require('./lib/browser-account-url');
const browserOwner = require('./lib/browser-owner');

// The upstream five-second action default is too short for signed-in console
// applications that continuously reflow while loading.  This only extends the
// bounded wait for an element to become visible, enabled, and stable; it does
// not enable force-clicking or relax any gateway/tool boundary.
const PLAYWRIGHT_ACTION_TIMEOUT_MS = 20_000;
// Attaching to the long-lived owned browser can take longer than upstream's
// 30-second default while Chrome enumerates an established signed-in profile.
// Keep this finite and scoped to the loopback owner attachment; individual UI
// actions retain the tighter bounded timeout above.
const PLAYWRIGHT_CDP_CONNECT_TIMEOUT_MS = 90_000;
// A tab-close preflight is an internal safety query, not an unbounded browser
// operation. If upstream stalls, fail the requested close closed rather than
// retaining the client request until the whole MCP process exits.
const TAB_COUNT_QUERY_TIMEOUT_MS = 5_000;
const SENSITIVE_URL_PARAMETER = /([?&#](?:access_?token|refresh_?token|id_?token|token|authorization_?code|code|code_?verifier|code_?challenge|state|nonce|assertion|credential|secret|password|jwt|oidcjwt|rapt|dsh|ifkv|part|sso|session|session_?state|continue)=)[^&#\s<>"'`)\]}]*/giu;
const SENSITIVE_RESPONSE_KEY = /^(?:authorization|proxy[-_]?authorization|authentication|auth|cookie|set[-_]?cookie|password|passphrase|api[-_]?key|apikey|x[-_]?api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|credential|credentials|private[-_]?key)$/i;
const PRIVATE_KEY_VALUE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const AUTHORIZATION_HEADER_VALUE = /(\b(?:authorization|proxy-authorization)\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi;
const COOKIE_HEADER_VALUE = /(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]+/gi;
const BEARER_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi;
const SENSITIVE_ASSIGNMENT_VALUE = /((?:^|\b)(?:access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|api[-_]?key|apikey|x[-_]?api[-_]?key|password|passphrase|authorization|cookie|credential)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}\]]+)/gim;
const FAKE_CREDENTIAL_CANARY = /\b(?:[A-Za-z0-9]+[-_]){0,4}canary(?:[-_][A-Za-z0-9._~+\/=]+){1,6}\b/gi;

if (require.main === module) {
  const packageSpec = process.argv[2];
  if (!/^@playwright\/mcp@\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(packageSpec || '')) {
    process.stderr.write('A pinned @playwright/mcp version is required.\n');
    process.exitCode = 2;
  } else {
    try { start(packageSpec); }
    catch (error) {
      process.stderr.write(`${safeMessage(error)}\n`);
      process.exitCode = 2;
    }
  }
}

function safeMessage(error) {
  return redactSensitiveUrlText(audit.redact(error && error.message ? error.message : String(error)))
    .replace(/\r?\n/g, ' ').slice(0, 1000);
}

function writeUpstreamStderrLine(line, write = value => process.stderr.write(value)) {
  write(`${safeMessage(line)}\n`);
}

function requestKey(id) { return `${typeof id}:${JSON.stringify(id)}`; }

function redactSensitiveUrlText(value) {
  if (typeof value !== 'string' || !/[?&#]/.test(value)) return value;
  return value.replace(SENSITIVE_URL_PARAMETER, '$1[REDACTED]');
}

function redactPlaywrightText(value) {
  return redactSensitiveUrlText(String(value))
    .replace(PRIVATE_KEY_VALUE, '[REDACTED PRIVATE KEY]')
    .replace(COOKIE_HEADER_VALUE, '$1[REDACTED]')
    .replace(AUTHORIZATION_HEADER_VALUE, '$1[REDACTED]')
    .replace(BEARER_VALUE, '$1 [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT_VALUE, '$1[REDACTED]')
    .replace(FAKE_CREDENTIAL_CANARY, '[REDACTED CANARY]');
}

function redactPlaywrightResponse(value) {
  if (typeof value === 'string') return redactPlaywrightText(value);
  if (Array.isArray(value)) return value.map(redactPlaywrightResponse);
  if (!value || typeof value !== 'object') return value;
  const redacted = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = SENSITIVE_RESPONSE_KEY.test(key) ? '[REDACTED]' : redactPlaywrightResponse(child);
  }
  return redacted;
}

function stripIncidentalTabInventory(value) {
  if (typeof value !== 'string' || !value.includes('### Open tabs')) return value;
  const lines = value.split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (line === '### Open tabs') {
      skipping = true;
      continue;
    }
    if (skipping && line.startsWith('- ')) continue;
    if (skipping) skipping = false;
    kept.push(line);
  }
  return kept.join('\n');
}

function stripIncidentalTabInventoryDeep(value) {
  if (typeof value === 'string') return stripIncidentalTabInventory(value);
  if (Array.isArray(value)) return value.map(stripIncidentalTabInventoryDeep);
  if (!value || typeof value !== 'object') return value;
  const stripped = {};
  for (const [key, child] of Object.entries(value)) {
    stripped[key] = stripIncidentalTabInventoryDeep(child);
  }
  return stripped;
}

function sanitizeTrackedResponse(message, tracked) {
  let sanitized = redactPlaywrightResponse(message);
  if (!tracked) return sanitized;
  if (tracked.name === 'browser_tabs' && (tracked.tabAction === 'select' || tracked.tabAction === 'close')
      && sanitized && sanitized.result && typeof sanitized.result === 'object') {
    const failed = Boolean(sanitized.result.isError);
    const closing = tracked.tabAction === 'close';
    return {
      jsonrpc: sanitized.jsonrpc,
      id: sanitized.id,
      result: {
        content: [{
          type: 'text',
          text: failed
            ? (closing ? 'Tab close failed.' : 'Tab selection failed.')
            : (closing ? 'Tab closed.' : 'Tab selected.')
        }],
        ...(failed ? { isError: true } : {})
      }
    };
  }
  if (tracked.name === 'browser_tabs' && tracked.tabAction === 'list') return sanitized;
  return stripIncidentalTabInventoryDeep(sanitized);
}

// The real Playwright error text lives in result.content[].text when
// result.isError is set; the top-level JSON-RPC `error.message` is used only
// for protocol-level failures. Extracting it lets the audit ledger record
// something diagnostic instead of a placeholder. The caller passes the
// already-redacted response, so no additional secret material is exposed.
function extractPlaywrightErrorText(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) return null;
  const texts = [];
  for (const block of result.content) {
    if (block && typeof block.text === 'string' && block.text.trim()) texts.push(block.text.trim());
  }
  return texts.length ? texts.join(' ') : null;
}

// Counts the tab entries in an upstream `browser_tabs` (action: 'list')
// result. Each open tab is rendered as one line beginning with "- ". Returns
// null when the count cannot be determined (error result or no text content
// at all), so the caller can fail closed instead of guessing.
function countOpenTabsFromListResult(result) {
  if (!result || typeof result !== 'object' || result.isError || !Array.isArray(result.content)) return null;
  let sawText = false;
  let count = 0;
  for (const block of result.content) {
    if (!block || typeof block.text !== 'string') continue;
    sawText = true;
    for (const rawLine of block.text.split(/\r?\n/)) {
      if (rawLine.startsWith('- ')) count += 1;
    }
  }
  return sawText ? count : null;
}

function configuredPath(name, fallback) {
  const configured = typeof process.env[name] === 'string' ? process.env[name].trim() : '';
  return configured ? path.resolve(configured) : rootPath(...fallback);
}

function recordOutcome(outcome, name, startedAt, error, intentEventId, auditApi = operationAudit, now = Date.now) {
  const details = { durationMs: Math.max(0, now() - startedAt), gateway: 'playwright' };
  if (intentEventId !== undefined) details.intentEventId = intentEventId;
  if (error) details.error = safeMessage(error);
  try { auditApi.record(`playwright.tool.${outcome}`, name, details); }
  catch (auditError) { process.stderr.write(`Playwright audit write failed: ${safeMessage(auditError)}\n`); }
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function blockedResult(id, error) {
  const message = safeMessage(error);
  return {
    jsonrpc: '2.0', id,
    result: {
      content: [{ type: 'text', text: message }],
      structuredContent: { error: { message, code: error && error.code || 'POLICY_BLOCKED' } },
      isError: true
    }
  };
}

const DIRECT_LIFECYCLE_TOOLS = new Set([
  'browser_close',
  // Either tool can call page/context/browser close APIs directly, bypassing
  // the input-bound browser.stop approval even when its source text looks
  // harmless. The gateway therefore does not expose arbitrary JavaScript.
  'browser_evaluate',
  'browser_run_code',
  'browser_run_code_unsafe'
]);
const LIFECYCLE_NAME = /(?:^|_)(?:close|quit|exit|kill|terminate|shutdown|restart)(?:_|$)/i;
// This is deliberately a positive list for the exact pinned upstream surface.
// A future @playwright/mcp tool is unavailable until it is explicitly reviewed,
// even if its name does not advertise lifecycle behavior.
const SAFE_BROWSER_TOOLS = new Set([
  'browser_click', 'browser_console_messages', 'browser_drag', 'browser_drop',
  'browser_file_upload', 'browser_fill_form', 'browser_find', 'browser_handle_dialog',
  'browser_hover', 'browser_navigate', 'browser_navigate_back', 'browser_network_request',
  'browser_network_requests', 'browser_press_key', 'browser_resize', 'browser_select_option',
  'browser_snapshot', 'browser_tabs', 'browser_take_screenshot', 'browser_type', 'browser_wait_for'
]);
const SAFE_BROWSER_TOOL_NAMES = Object.freeze([...SAFE_BROWSER_TOOLS].sort());

/* WHAT THIS GATEWAY NEEDS FROM @playwright/mcp, READ FROM THE SERVER ITSELF.
 *
 * The gateway used to trust one pinned version: whatever that version offered
 * was assumed to match the checks below. A different version is accepted only
 * if its own tools/list shows it still offers what the gateway relies on, so a
 * new release needs no new ToolsEnabled release and nobody has to "parent" the
 * version number.
 *
 * One entry per SAFE_BROWSER_TOOLS name (a test holds the two lists equal):
 *   required  the browser tools cannot do their basic job without this tool.
 *             Missing: the check says 'update-needed'. Otherwise a missing
 *             tool only limits what the browser can do ('ready-with-limits').
 *   guards    argument names the gateway inspects to enforce a boundary
 *             (navigation URL, tab close, key filter, file egress). If the
 *             server's schema no longer has one, that check would silently
 *             stop applying, so the tool is hidden from tools/list and every
 *             call to it is refused. This is the fail-closed part.
 *   uses      argument names the gateway rewrites older spellings into
 *             (ref -> target). Missing: the tool is reported as not usable,
 *             but no boundary depends on it.
 *   reviewed  (guarded tools only) every argument name the gateway's checks
 *             were written against, read from the tools/list of
 *             @playwright/mcp 0.0.78 and 0.0.82. A newer server may add an
 *             argument that changes what a guarded call does, so an argument
 *             outside this list is removed from the advertised schema and
 *             refused on a call, and a tool whose schema REQUIRES one is
 *             hidden. Unguarded tools keep every argument the server offers.
 * The version number is shown for information only; it never admits or
 * refuses a start. */
const NO_FIELDS = Object.freeze([]);
function toolFeature(required, guards = NO_FIELDS, uses = NO_FIELDS, reviewed = null) {
  return Object.freeze({ required, guards: Object.freeze([...guards]), uses: Object.freeze([...uses]),
    reviewed: reviewed ? Object.freeze([...new Set([...guards, ...uses, ...reviewed])].sort()) : null });
}
const PLAYWRIGHT_TOOL_FEATURES = Object.freeze({
  browser_navigate: toolFeature(true, ['url'], NO_FIELDS, ['url']),
  browser_snapshot: toolFeature(true),
  browser_click: toolFeature(true, NO_FIELDS, ['target']),
  browser_type: toolFeature(true, NO_FIELDS, ['target']),
  browser_tabs: toolFeature(true, ['action'], NO_FIELDS, ['action', 'index', 'url']),
  browser_press_key: toolFeature(false, ['key'], NO_FIELDS, ['key']),
  browser_file_upload: toolFeature(false, ['paths'], NO_FIELDS, ['paths']),
  browser_take_screenshot: toolFeature(false, ['filename'], ['target'],
    ['element', 'filename', 'fullPage', 'scale', 'target', 'type']),
  browser_drag: toolFeature(false, NO_FIELDS, ['startTarget', 'endTarget']),
  browser_drop: toolFeature(false, NO_FIELDS, ['target']),
  browser_hover: toolFeature(false, NO_FIELDS, ['target']),
  browser_select_option: toolFeature(false, NO_FIELDS, ['target']),
  browser_fill_form: toolFeature(false, NO_FIELDS, ['fields']),
  browser_console_messages: toolFeature(false),
  browser_find: toolFeature(false),
  browser_handle_dialog: toolFeature(false),
  browser_navigate_back: toolFeature(false),
  browser_network_request: toolFeature(false),
  browser_network_requests: toolFeature(false),
  browser_resize: toolFeature(false),
  browser_wait_for: toolFeature(false)
});
const PLAYWRIGHT_FEATURE_STATES = Object.freeze(['ready', 'ready-with-limits', 'update-needed', 'not-installed', 'unknown']);

function schemaProperties(tool) {
  const properties = tool && tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema.properties : null;
  return properties && typeof properties === 'object' && !Array.isArray(properties) ? properties : {};
}

function schemaRequired(tool) {
  const required = tool && tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema.required : null;
  return Array.isArray(required) ? required.filter(name => typeof name === 'string') : [];
}

/**
 * Checks one @playwright/mcp tools/list answer against PLAYWRIGHT_TOOL_FEATURES.
 * Returns { state, hidden, missingRequired, missingOptional } where `state` is
 * one word of PLAYWRIGHT_FEATURE_STATES, `hidden` names the offered tools the
 * gateway hides and refuses (a guarded argument is gone, or the tool now
 * requires an argument nobody reviewed), and the two missing lists name the
 * tools, or "tool.argument", this gateway cannot use.
 */
function checkPlaywrightTools(tools) {
  if (!Array.isArray(tools)) {
    return Object.freeze({ state: 'unknown', hidden: NO_FIELDS, missingRequired: NO_FIELDS, missingOptional: NO_FIELDS });
  }
  const offered = new Map();
  for (const tool of tools) {
    if (tool && typeof tool.name === 'string' && !offered.has(tool.name)) offered.set(tool.name, tool);
  }
  const hidden = [];
  const missingRequired = [];
  const missingOptional = [];
  for (const [name, feature] of Object.entries(PLAYWRIGHT_TOOL_FEATURES)) {
    const missing = feature.required ? missingRequired : missingOptional;
    const tool = offered.get(name);
    if (!tool) { missing.push(name); continue; }
    const fields = new Set(Object.keys(schemaProperties(tool)));
    const lostGuards = feature.guards.filter(field => !fields.has(field));
    const lostUses = feature.uses.filter(field => !fields.has(field));
    const unreviewedRequired = feature.reviewed
      ? schemaRequired(tool).filter(field => !feature.reviewed.includes(field)) : [];
    if (lostGuards.length || unreviewedRequired.length) hidden.push(name);
    for (const field of [...lostGuards, ...lostUses]) missing.push(`${name}.${field}`);
    for (const field of unreviewedRequired) missing.push(`${name}.${field} (not reviewed)`);
  }
  const state = missingRequired.length ? 'update-needed' : missingOptional.length ? 'ready-with-limits' : 'ready';
  return Object.freeze({
    state,
    hidden: Object.freeze(hidden.sort()),
    missingRequired: Object.freeze(missingRequired),
    missingOptional: Object.freeze(missingOptional)
  });
}

// The schema a client is shown for one offered tool. Guarded tools lose any
// argument nobody reviewed, so a client is never invited to use one.
function advertisedTool(tool) {
  const feature = tool && PLAYWRIGHT_TOOL_FEATURES[tool.name];
  if (!feature || !feature.reviewed || !tool.inputSchema || typeof tool.inputSchema !== 'object') return tool;
  const properties = {};
  for (const [field, schema] of Object.entries(schemaProperties(tool))) {
    if (feature.reviewed.includes(field)) properties[field] = schema;
  }
  const inputSchema = { ...tool.inputSchema, properties };
  if (Array.isArray(tool.inputSchema.required)) {
    inputSchema.required = tool.inputSchema.required.filter(field => feature.reviewed.includes(field));
  }
  return { ...tool, inputSchema };
}

// A guarded tool is called only with arguments its checks were written for.
// Older spellings are translated first (ref -> target), exactly as the call
// itself will be.
function assertReviewedArguments(name, args) {
  const feature = PLAYWRIGHT_TOOL_FEATURES[name];
  if (!feature || !feature.reviewed || !args || typeof args !== 'object' || Array.isArray(args)) return;
  const unreviewed = Object.keys(normalizeBrowserArguments(name, args))
    .filter(field => !feature.reviewed.includes(field));
  if (unreviewed.length) {
    throw codedError('BROWSER_ARGUMENT_NOT_REVIEWED', `This Playwright tool was called with an argument ToolsEnabled has not reviewed (${unreviewed.slice(0, 5).join(', ')}). Use only the arguments tools/list shows.`);
  }
}

function describePlaywrightCheck(check, serverVersion) {
  const version = typeof serverVersion === 'string' && /^[0-9A-Za-z.+-]{1,40}$/.test(serverVersion)
    ? ` ${serverVersion}` : '';
  const hidden = check.hidden.length
    ? ` ToolsEnabled turned off ${check.hidden.join(', ')}, because a check it relies on would no longer apply.` : '';
  if (check.state === 'update-needed') {
    return `Playwright MCP${version} does not offer what ToolsEnabled's browser tools need (${check.missingRequired.join(', ')}). Update Playwright MCP.${hidden}`;
  }
  if (check.state === 'ready-with-limits') {
    return `Playwright MCP${version} works with limits: it does not offer ${check.missingOptional.join(', ')}.${hidden}`;
  }
  return null;
}
const SAFE_KEY = /^(?:(?:Shift\+)?(?:Enter|Tab|Escape|Backspace|Delete|Insert|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Space)|[^\p{Cc}\p{Cf}])$/iu;

function httpNavigation(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192) {
    throw codedError('BROWSER_NAVIGATION_URL_INVALID', 'Playwright navigation requires one bounded HTTP or HTTPS URL.');
  }
  let parsed;
  try { parsed = new URL(value); }
  catch { throw codedError('BROWSER_NAVIGATION_URL_INVALID', 'Playwright navigation requires a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw codedError('BROWSER_NAVIGATION_URL_FORBIDDEN', 'Playwright may navigate only to HTTP or HTTPS URLs without embedded credentials. Internal browser, file, data, script, extension, and command URLs are blocked.');
  }
  return parsed.href;
}

function assertSafeBrowserCall(message, options = {}) {
  const name = message?.params?.name;
  const args = message?.params?.arguments;
  if (DIRECT_LIFECYCLE_TOOLS.has(name) || LIFECYCLE_NAME.test(name)) {
    throw codedError('BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL', 'This Playwright lifecycle or arbitrary-code tool is blocked. Only ToolsEnabled browser.stop may close the owned browser, using a fresh local approval for its exact generation.');
  }
  if (!SAFE_BROWSER_TOOLS.has(name)) {
    throw codedError('BROWSER_TOOL_NOT_ALLOWED', 'This Playwright tool is not in the reviewed positive allowlist for the pinned upstream package.');
  }
  if (options.hiddenTools && options.hiddenTools.has(name)) {
    throw codedError('BROWSER_TOOL_UPDATE_NEEDED', 'ToolsEnabled turned this Playwright tool off because the Playwright MCP copy in use changed an argument its safety check relies on.');
  }
  assertReviewedArguments(name, args);
  if (name === 'browser_tabs') {
    const action = args && typeof args.action === 'string' ? args.action.toLowerCase() : '';
    // Closing a tab is only ever safe when something has just re-verified,
    // against the live browser, that it would not close the final owned tab.
    // That live check requires an active gateway session (see
    // createGatewaySession/handleTabClose) and cannot be performed here, so
    // this structural check continues to fail closed for every other caller
    // (including the offline tools/playwright-call.js pre-validator, which has
    // no live browser to query).
    if (action === 'close' && options.tabCloseAllowed !== true) {
      throw codedError('BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL', 'Playwright tab close requires a live re-verified open-tab count that this caller cannot provide. Use ToolsEnabled browser.stop with exact-generation approval.');
    }
    if (action === 'new' && args.url !== undefined) {
      httpNavigation(args.url);
    }
  }
  if (name === 'browser_press_key') {
    const key = args && typeof args.key === 'string' ? args.key.replace(/\s+/g, '') : '';
    if (!SAFE_KEY.test(key)) {
      throw codedError('BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL', 'Playwright modifier, function, browser-control, and other unreviewed key combinations are blocked. Use direct page controls or ToolsEnabled browser.stop.');
    }
  }
  if (name === 'browser_navigate') httpNavigation(args && args.url);
}

function normalizeBrowserArguments(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const result = { ...args };
  const aliases = name === 'browser_drag' ? [['startRef', 'startTarget'], ['endRef', 'endTarget']]
    : ['browser_click', 'browser_type', 'browser_hover', 'browser_select_option', 'browser_take_screenshot', 'browser_drop'].includes(name)
      ? [['ref', 'target']] : [];
  for (const [old, current] of aliases) {
    if (!Object.hasOwn(result, old)) continue;
    if (Object.hasOwn(result, current) && result[current] !== result[old]) {
      throw codedError('BROWSER_TARGET_AMBIGUOUS', `Supply only one target. ${old} and ${current} refer to different elements.`);
    }
    result[current] = result[old]; delete result[old];
  }
  if (name === 'browser_fill_form' && Array.isArray(result.fields)) {
    result.fields = result.fields.map(field => normalizeBrowserArguments('browser_type', field));
  }
  return result;
}

// Q31 build item 2: the exact leaked route. In a real incident, a filename
// carrying internal provenance markers reached its outside destination through
// this upstream Playwright tool -- a command-line-scanning PreToolUse hook
// cannot see it at all, because a native mcp__playwright__browser_file_upload
// call never shapes as a Bash/PowerShell command line. This gateway is the
// real chokepoint: every tools/call for a SAFE_BROWSER_TOOLS-listed tool
// already passes through clientLine() below before it is ever forwarded
// upstream, so the same egress-preflight boundary tool-registry.js now
// enforces for native mcp__toolsenabled__* tools is enforced here too.
//
// Scoped to the exact file-bearing fields the reviewed upstream tools carry:
// browser_file_upload's `paths` (the exact leaked field) and
// browser_take_screenshot's optional `filename` (a locally-saved artifact
// that can still carry a provenance-leaking name forward if a human later
// shares it).
//
// THIS NOTE USED TO END "Every other SAFE_BROWSER_TOOLS entry carries no local
// file path argument at all", AND THAT WAS NOT TRUE. Read out of the gateway's
// own advertised schemas rather than from memory: browser_console_messages,
// browser_network_requests, browser_network_request and browser_snapshot each
// take an optional `filename` that writes a local artifact. Four tools carry
// the field; two are scrubbed.
//
// The sentence mattered because it was the JUSTIFICATION for this map being
// short -- a reader checking whether the scrubbing was complete would have
// stopped at it. The map is deliberately left as it is: widening what gets
// scrubbed changes behaviour on paths a person may already rely on, and that is
// the owner's call, not a comment repair's. What is fixed here is that the
// comment no longer asserts the gap away.
const UPLOAD_TOOL_PATH_FIELDS = Object.freeze({
  browser_file_upload: 'paths',
  browser_take_screenshot: 'filename'
});

function extractCandidateFilePaths(name, args) {
  const field = UPLOAD_TOOL_PATH_FIELDS[name];
  if (!field || !args || typeof args !== 'object') return [];
  const value = args[field];
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.filter(entry => typeof entry === 'string' && entry.trim());
  return [];
}

function assertFileUploadPreflight(message) {
  const name = message?.params?.name;
  const args = message?.params?.arguments;
  for (const filePath of extractCandidateFilePaths(name, args)) {
    const result = egressPreflight.preflight({ filePath, destination: `playwright:${name}` });
    if (!result.allowed) {
      throw codedError('EGRESS_PREFLIGHT_BLOCKED', `Blocked '${name}' file argument '${filePath}': ${result.summary}`);
    }
  }
}

// Native Playwright calls do not pass through tool-registry.js.  For the
// artifact-bearing subset, the gateway therefore performs the same owner
// instruction check before forwarding anything upstream.  The direct helper
// remains preflight-only by default for offline callers; live gateway sessions
// opt into the bound-request requirement below.  The marker is host-owned and
// never comes from page content or an upstream tool result.
function assertFileUploadGates(message, { requireBoundRequest = false } = {}) {
  if (!requireBoundRequest || extractCandidateFilePaths(message?.params?.name, message?.params?.arguments).length === 0) return;
  const requestId = requestContext.getActiveRequest();
  if (!requestId) throw codedError('EGRESS_GATES_REQUIRED', 'Artifact-bearing Playwright calls require an active owner-instruction request before forwarding.');
  try {
    egressPreflight.assertGatesMet(requestId);
  } catch (error) {
    if (error && error.code === 'EGRESS_GATES_UNMET') throw error;
    throw codedError('EGRESS_GATES_REQUIRED', 'The active owner-instruction request could not be verified before forwarding the artifact.');
  }
}

// The Playwright profile can legitimately contain several Google sessions.
// Google otherwise chooses its cookie-order default (`authuser=0`), which is
// unrelated to ToolsEnabled's configured default account.  Select the account
// per navigation rather than mutating session cookies or inspecting page data.
function routeGoogleNavigation(message, accountRegistry = googleAccounts) {
  const originalUrl = message?.params?.arguments?.url;
  if (typeof originalUrl !== 'string' || !isAccountAwareGoogleUrl(originalUrl)) return message;
  const account = accountRegistry.resolve();
  const details = accountRegistry.load().accounts[account];
  const url = applyGoogleAccount(originalUrl, details && details.email);
  if (url === originalUrl) return message; // Includes an explicit authuser selector.
  return {
    ...message,
    params: {
      ...message.params,
      arguments: { ...message.params.arguments, url }
    }
  };
}

function createGatewaySession(options) {
  if (!options || typeof options.writeUpstream !== 'function' || typeof options.writeClient !== 'function') {
    throw new TypeError('Gateway session requires upstream and client writers.');
  }
  const auditApi = options.auditApi || operationAudit;
  const assertActiveFn = options.assertActiveFn || assertActive;
  const accountRegistry = options.accountRegistry || googleAccounts;
  const now = options.now || Date.now;
  const pending = new Map();
  // Internal, gateway-issued `browser_tabs` (action: 'list') preflight queries
  // used only to decide whether a close request is safe. Keyed in a separate
  // namespace (an unpredictable per-session nonce) so a client-chosen id can
  // never be mistaken for one, and never forwarded to the client (see
  // serverLine below).
  const tabCountQueries = new Map();
  // Client ids claimed by close requests whose live-count preflight has not
  // completed yet. These ids are already in flight even though the actual
  // close is not in `pending`, so ordinary duplicate-id enforcement must see
  // them too.
  const tabClosePreflights = new Set();
  const tabCountQueryNonce = options.internalRequestNonce || crypto.randomUUID();
  const tabCountQueryTimeoutMs = Number.isFinite(options.tabCountQueryTimeoutMs) && options.tabCountQueryTimeoutMs > 0
    ? options.tabCountQueryTimeoutMs : TAB_COUNT_QUERY_TIMEOUT_MS;
  let tabCountQueryCounter = 0;
  // Number of browser_tabs close calls this session has already forwarded
  // upstream but not yet resolved. Subtracted from every fresh live tab count
  // so a second concurrent close decision can never be based on a count that
  // the first, still in-flight close has already claimed. See handleTabClose.
  let reservedTabCloses = 0;
  // What the upstream's own tools/list says it offers, checked against
  // PLAYWRIGHT_TOOL_FEATURES. Tools whose guarded arguments are gone are
  // hidden from the client and refused on a call.
  const hiddenTools = new Set();
  let listedTools = [];
  let featureCheck = checkPlaywrightTools(null);
  // The @playwright/mcp version this session launched, for the note only.
  // (The server's own serverInfo.version is its Playwright core version.)
  const packageVersion = typeof options.packageVersion === 'string' ? options.packageVersion : null;
  let lastFeatureNote = null;
  const writeDiagnostic = typeof options.writeDiagnostic === 'function'
    ? options.writeDiagnostic : line => writeUpstreamStderrLine(line);

  function outcome(state, tracked, error) {
    if (tracked && tracked.releasesTabCloseReservation) {
      reservedTabCloses = Math.max(0, reservedTabCloses - 1);
    }
    // Replies and process-exit callbacks run outside the original request's
    // async context. Re-enter its captured policy; never read reply fields.
    operationAudit.withPolicy(tracked.auditPolicy, () =>
      recordOutcome(state, tracked.name, tracked.startedAt, error, tracked.intentEventId, auditApi, now));
  }

  function queryLiveOpenTabCount() {
    return new Promise(resolve => {
      tabCountQueryCounter += 1;
      const id = `${tabCountQueryNonce}:tabcount:${tabCountQueryCounter}`;
      const key = requestKey(id);
      const query = {
        resolve(value) {
          clearTimeout(query.timeout);
          tabCountQueries.delete(key);
          resolve(value);
        },
        timeout: null
      };
      query.timeout = setTimeout(() => query.resolve(null), tabCountQueryTimeoutMs);
      tabCountQueries.set(key, query);
      try {
        options.writeUpstream(JSON.stringify({
          jsonrpc: '2.0', id, method: 'tools/call',
          params: { name: 'browser_tabs', arguments: { action: 'list' } }
        }));
      } catch {
        query.resolve(null);
      }
    });
  }

  function recordBlockedTabClose(name, startedAt, messageId, error) {
    recordOutcome('blocked', name, startedAt, error, undefined, auditApi, now);
    options.writeClient(JSON.stringify(blockedResult(messageId, error)));
  }

  // The only path allowed to skip assertSafeBrowserCall's blanket tab-close
  // refusal. It re-verifies, against a *fresh* live query issued right now
  // (never a cached count), that closing would leave at least one owned tab
  // open, and reserves that outcome before ever forwarding the real close so
  // a second concurrent close cannot be decided against a stale count.
  async function handleTabClose(message, name, startedAt, key, line, auditPolicy) {
    try {
      try {
        assertSafeBrowserCall(message, { tabCloseAllowed: true, hiddenTools });
      } catch (error) {
        recordBlockedTabClose(name, startedAt, message.id, error);
        return;
      }
      try {
        assertActiveFn(`playwright.${name}`);
      } catch (error) {
        recordBlockedTabClose(name, startedAt, message.id, error);
        return;
      }

      const observedCount = await queryLiveOpenTabCount();
      const available = observedCount === null ? null : observedCount - reservedTabCloses;
      if (available === null || available <= 1) {
        recordBlockedTabClose(name, startedAt, message.id, codedError(
          'BROWSER_LIFECYCLE_REQUIRES_OWNER_APPROVAL',
          available === null
            ? 'Playwright tab close is blocked because the current open-tab count could not be confirmed. Use ToolsEnabled browser.stop, or retry once the tab list is available.'
            : 'Playwright tab close is blocked because it would close the last owned browser tab. Use ToolsEnabled browser.stop with exact-generation approval.'
        ));
        return;
      }

      // Nothing below awaits again before forwarding, so this reservation and
      // the eventual pending.set/writeUpstream are atomic with respect to any
      // other in-flight handleTabClose call.
      reservedTabCloses += 1;
      let intentEventId;
      try {
        assertActiveFn(`playwright.${name}`);
        const intent = auditApi.requireRecord('playwright.tool.intent', name, {
          gateway: 'playwright', requestId: String(message.id).slice(0, 120)
        });
        intentEventId = intentIdentity(intent, name, auditPolicy);
      } catch (error) {
        reservedTabCloses = Math.max(0, reservedTabCloses - 1);
        recordBlockedTabClose(name, startedAt, message.id, error);
        return;
      }

      pending.set(key, { name, startedAt, intentEventId, auditPolicy, tabAction: 'close', releasesTabCloseReservation: true });
      options.writeUpstream(line);
    } finally {
      tabClosePreflights.delete(key);
    }
  }

  function intentIdentity(intent, name, policy) {
    if (!policy.required && operationAudit.isNotRequired(intent, 'playwright.tool.intent', name)) return undefined;
    if (!intent || typeof intent.eventId !== 'string' || !intent.eventId.trim()) {
      throw codedError('AUDIT_INVALID_RESULT', 'Playwright intent requires a recorded event id or its exact audit-off receipt.');
    }
    return intent.eventId;
  }

  function clientLine(line) {
    let auditPolicy;
    try { auditPolicy = operationAudit.capturePolicy(); }
    catch (error) {
      // Unknown configuration is a refusal, never permission to omit audit.
      // No browser dispatch or optional writer has started at this point.
      let message;
      try { message = JSON.parse(line); } catch {}
      options.writeClient(JSON.stringify(blockedResult(message?.id ?? null, error)));
      return;
    }
    return operationAudit.withPolicy(auditPolicy, () => clientLineWithPolicy(line, auditPolicy));
  }

  function clientLineWithPolicy(line, auditPolicy) {
    let message;
    try { message = JSON.parse(line); }
    catch {
      // A line that cannot be classified as a JSON-RPC request cannot be
      // established to be safe. Never turn that parse failure into an
      // unconditional upstream pass-through that bypasses every tool gate.
      const refusal = codedError('JSONRPC_PARSE_ERROR', 'Playwright gateway refused malformed JSON before forwarding.');
      recordOutcome('blocked', 'unknown', now(), refusal, undefined, auditApi, now);
      options.writeClient(JSON.stringify(blockedResult(null, refusal)));
      return;
    }
    if (message && message.method === 'tools/call' && message.params && typeof message.params.name === 'string') {
      const name = message.params.name;
      const startedAt = now();
      const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
      if (!hasId) {
        // A notification has no response channel and therefore no reliable way
        // to correlate an upstream outcome. Reject it before any browser effect.
        const error = codedError('JSONRPC_REQUEST_ID_REQUIRED', 'Playwright tools/call must include a JSON-RPC request id.');
        recordOutcome('blocked', name, startedAt, error, undefined, auditApi, now);
        return;
      }
      const key = requestKey(message.id);
      if (pending.has(key) || tabClosePreflights.has(key)) {
        const error = codedError('JSONRPC_DUPLICATE_ID', 'A Playwright tools/call with this request id is already in flight.');
        recordOutcome('blocked', name, startedAt, error, undefined, auditApi, now);
        options.writeClient(JSON.stringify(blockedResult(message.id, error)));
        return;
      }

      const callArguments = message.params.arguments;
      if (name === 'browser_tabs' && callArguments && typeof callArguments.action === 'string'
          && callArguments.action.toLowerCase() === 'close') {
        // Asynchronously re-verified against the live browser; see
        // handleTabClose. Everything else below remains synchronous.
        tabClosePreflights.add(key);
        return handleTabClose(message, name, startedAt, key, line, auditPolicy);
      }

      let intentEventId;
      // Keep the upstream session attachment-only. Lifecycle tools, arbitrary
      // JavaScript, browser-command URLs, and closing key combinations are
      // rejected before policy, audit intent, or forwarding. Tab close is
      // handled above with its own live re-verified gate.
      try {
        message = { ...message, params: { ...message.params, arguments: normalizeBrowserArguments(name, message.params.arguments) } };
        line = JSON.stringify(message);
        assertSafeBrowserCall(message, { hiddenTools });
        assertFileUploadPreflight(message);
        assertFileUploadGates(message, { requireBoundRequest: options.requireOutwardGates !== false });
      }
      catch (error) {
        recordOutcome('blocked', name, startedAt, error, undefined, auditApi, now);
        options.writeClient(JSON.stringify(blockedResult(message.id, error)));
        return;
      }
      {
        try {
          assertActiveFn(`playwright.${name}`);
          const intent = auditApi.requireRecord('playwright.tool.intent', name, {
            gateway: 'playwright', requestId: String(message.id).slice(0, 120)
          });
          intentEventId = intentIdentity(intent, name, auditPolicy);
        }
        catch (error) {
          recordOutcome('blocked', name, startedAt, error, undefined, auditApi, now);
          options.writeClient(JSON.stringify(blockedResult(message.id, error)));
          return;
        }
      }
      pending.set(key, {
        name,
        startedAt,
        intentEventId,
        auditPolicy,
        tabAction: name === 'browser_tabs' && message.params.arguments
          ? message.params.arguments.action : undefined
      });
      if (name === 'browser_navigate') {
        try {
          message = {
            ...message,
            params: {
              ...message.params,
              arguments: { ...message.params.arguments, url: httpNavigation(message.params.arguments.url) }
            }
          };
          message = routeGoogleNavigation(message, accountRegistry);
          line = JSON.stringify(message);
        } catch (error) {
          pending.delete(key);
          recordOutcome('blocked', name, startedAt, error, intentEventId, auditApi, now);
          options.writeClient(JSON.stringify(blockedResult(message.id, error)));
          return;
        }
      }
    }
    options.writeUpstream(line);
  }

  function serverLine(line) {
    let message;
    try { message = JSON.parse(line); }
    catch {
      options.writeClient(redactSensitiveUrlText(line));
      return;
    }
    if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
      const internalKey = requestKey(message.id);
      const internalQuery = tabCountQueries.get(internalKey);
      if (internalQuery) {
        // Internal preflight traffic must never reach the client and is never
        // tracked as an ordinary tool call outcome.
        const failed = Boolean(message.error || (message.result && message.result.isError));
        internalQuery.resolve(failed ? null : countOpenTabsFromListResult(message.result));
        return;
      }
      // A response may arrive after its preflight deadline removed the query.
      // The per-session nonce still identifies it as gateway-owned traffic;
      // never misattribute or expose that late internal response to a client.
      if (typeof message.id === 'string' && message.id.startsWith(`${tabCountQueryNonce}:tabcount:`)) return;
    }
    if (message && message.result && Array.isArray(message.result.tools)) {
      const page = message.result.tools;
      for (const name of checkPlaywrightTools(page).hidden) hiddenTools.add(name);
      listedTools.push(...page);
      if (!message.result.nextCursor) {
        featureCheck = checkPlaywrightTools(listedTools);
        listedTools = [];
        const note = describePlaywrightCheck(featureCheck, packageVersion);
        if (note && note !== lastFeatureNote) {
          lastFeatureNote = note;
          try { writeDiagnostic(note); } catch { /* a diagnostic never blocks the answer */ }
        }
      }
      message = {
        ...message,
        result: {
          ...message.result,
          tools: page.filter(tool => tool && SAFE_BROWSER_TOOLS.has(tool.name) && !hiddenTools.has(tool.name))
            .map(advertisedTool)
        }
      };
    }
    let tracked;
    if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
      tracked = pending.get(requestKey(message.id));
    }
    message = sanitizeTrackedResponse(message, tracked);
    line = JSON.stringify(message);
    if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
      const key = requestKey(message.id);
      if (tracked) {
        pending.delete(key);
        const failed = Boolean(message.error || (message.result && message.result.isError));
        let failureError = null;
        if (failed) {
          const detail = message.error ? message.error.message : extractPlaywrightErrorText(message.result);
          failureError = new Error(detail || 'Playwright tool returned an error result.');
        }
        outcome(failed ? 'failed' : 'succeeded', tracked, failureError);
      }
    }
    options.writeClient(line);
  }

  function upstreamClosed(code) {
    for (const tracked of pending.values()) {
      outcome('failed', tracked, new Error(`Playwright MCP exited ${code}.`));
    }
    pending.clear();
    // An in-flight preflight can never resolve once upstream is gone; resolve
    // it to "unknown" so any awaiting handleTabClose call fails closed instead
    // of hanging forever.
    for (const query of [...tabCountQueries.values()]) query.resolve(null);
    tabCountQueries.clear();
  }

  return { clientLine, serverLine, upstreamClosed, pendingCount: () => pending.size,
    featureCheck: () => featureCheck };
}

function buildUpstreamArgs(pinnedPackage, session) {
  if (!session || typeof session.cdpEndpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(session.cdpEndpoint)) {
    throw codedError('BROWSER_OWNER_REQUIRED', 'Playwright requires a revalidated ToolsEnabled-owned loopback CDP browser. Run browser.start through ToolsEnabled first.');
  }
  return [
    '-y', pinnedPackage,
    '--cdp-endpoint', session.cdpEndpoint,
    '--cdp-timeout', String(PLAYWRIGHT_CDP_CONNECT_TIMEOUT_MS),
    '--timeout-action', String(PLAYWRIGHT_ACTION_TIMEOUT_MS),
    '--init-page', path.join(__dirname, 'lib', 'browser-action-cursor.js'),
    '--output-dir', configuredPath('TOOLSENABLED_PLAYWRIGHT_OUTPUT_PATH', ['logs', 'playwright'])
  ];
}

function resolveCachedPlaywrightCli(pinnedPackage, dependencies = {}) {
  const match = /^(@playwright\/mcp)@(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(String(pinnedPackage || ''));
  if (!match) return null;
  const environment = dependencies.environment || process.env;
  const platform = dependencies.platform || process.platform;
  const fs = dependencies.fsApi || require('node:fs');
  const configured = String(environment.npm_config_cache || environment.NPM_CONFIG_CACHE || '').trim();
  const cacheBase = configured || (platform === 'win32'
    ? environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, 'npm-cache')
    : path.join(dependencies.home || os.homedir(), '.npm'));
  if (!cacheBase) return null;
  const cacheRoot = path.resolve(cacheBase, '_npx');
  let entries;
  try { entries = fs.readdirSync(cacheRoot, { withFileTypes: true }); } catch { return null; }
  const candidates = [];
  for (const entry of entries.slice(0, 128)) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f0-9]{8,64}$/i.test(entry.name)) continue;
    const packageRoot = path.join(cacheRoot, entry.name, 'node_modules', '@playwright', 'mcp');
    const manifest = path.join(packageRoot, 'package.json');
    const cli = path.join(packageRoot, 'cli.js');
    try {
      const manifestStat = fs.lstatSync(manifest);
      const cliStat = fs.lstatSync(cli);
      if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || !cliStat.isFile() || cliStat.isSymbolicLink()) continue;
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (parsed.name !== match[1] || parsed.version !== match[2]) continue;
      const cacheReal = fs.realpathSync(cacheRoot);
      const cliReal = fs.realpathSync(cli);
      const relative = path.relative(cacheReal, cliReal);
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) continue;
      candidates.push({ cli, mtimeMs: manifestStat.mtimeMs });
    } catch { /* stale or incomplete npx cache entry */ }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.cli || null;
}

function resolveNpxInvocation(pinnedPackage) {
  const cachedCli = resolveCachedPlaywrightCli(pinnedPackage);
  if (cachedCli) return { executable: process.execPath, prefix: [cachedCli], source: 'cache' };
  const npx = commandPath('npx');
  if (!npx) throw new Error('npx is required to launch the Playwright MCP server.');
  // On Windows `npx` normally resolves to npx.cmd.  Calling that batch file
  // forces a cmd.exe console allocation in some MCP hosts, even when the
  // outer spawn requests windowsHide.  Invoke npm's pinned npx CLI through
  // node instead; this keeps the same npm installation and avoids a helper
  // console entirely.
  if (process.platform === 'win32' && /\.(?:cmd|bat|ps1)$/i.test(npx)) {
    const cli = path.join(path.dirname(npx), 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (fs.existsSync(cli) && fs.statSync(cli).isFile()) {
      return { executable: process.execPath, prefix: [cli], source: 'npx' };
    }
  }
  return { executable: npx, prefix: [], source: 'fallback' };
}

// buildUpstreamArgs() always returns the npx-style argv: a leading '-y' and
// the pinned package spec (so npx installs/selects the right version without
// an interactive prompt) followed by the actual @playwright/mcp CLI flags.
// That leading pair is only meaningful when the spawned executable *is* npx.
// When resolveNpxInvocation() found a package already cached under npm's
// `_npx` store, `npx.prefix` bypasses npx entirely and points straight at
// the cached CLI's own entry point for speed. Forwarding '-y' and the
// package spec to that CLI directly hands it two arguments its own parser
// does not recognize, and it exits immediately with
// "error: unknown option '-y'" before ever attaching to the browser. Strip
// that npx-only prefix whenever the resolved invocation does not go through
// npx.
function upstreamSpawnArgs(npx, upstreamArgs) {
  return npx.source === 'cache' ? upstreamArgs.slice(2) : upstreamArgs;
}

function start(pinnedPackage, dependencies = {}) {
  const npx = resolveNpxInvocation(pinnedPackage);
  const owner = dependencies.browserOwner || browserOwner;
  const ownerSession = owner.attach();
  const upstreamArgs = upstreamSpawnArgs(npx, buildUpstreamArgs(pinnedPackage, ownerSession));
  const upstream = spawn(npx.executable, [...npx.prefix, ...upstreamArgs], {
    cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false
  });
  const client = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const server = readline.createInterface({ input: upstream.stdout, crlfDelay: Infinity });
  const serverErrors = readline.createInterface({ input: upstream.stderr, crlfDelay: Infinity });
  const gatewaySession = createGatewaySession({
    packageVersion: /@(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/.exec(pinnedPackage)?.[1],
    assertActiveFn: name => {
      assertActive(name);
      const current = owner.attach();
      if (current.generation !== ownerSession.generation || current.cdpEndpoint !== ownerSession.cdpEndpoint) {
        throw codedError('BROWSER_SESSION_CHANGED', 'The owned browser changed. Reconnect, take a fresh snapshot and inspect the page before repeating an action.');
      }
    },
    writeUpstream: line => upstream.stdin.write(`${line}\n`),
    writeClient: line => process.stdout.write(`${line}\n`)
  });

  client.on('line', gatewaySession.clientLine);
  server.on('line', gatewaySession.serverLine);

  // Read complete lines so a sensitive URL parameter split across stream
  // chunks cannot bypass redaction. Upstream diagnostics are untrusted and
  // bounded by safeMessage before they reach the host stderr stream.
  serverErrors.on('line', line => writeUpstreamStderrLine(line));
  upstream.on('error', error => {
    process.stderr.write(`Unable to launch Playwright MCP: ${safeMessage(error)}\n`);
    process.exitCode = 1;
  });
  upstream.on('close', code => {
    gatewaySession.upstreamClosed(code);
    process.exitCode = code || process.exitCode;
  });
  client.on('close', () => upstream.stdin.end());
}

module.exports = {
  PLAYWRIGHT_CDP_CONNECT_TIMEOUT_MS,
  PLAYWRIGHT_FEATURE_STATES,
  PLAYWRIGHT_TOOL_FEATURES,
  SAFE_BROWSER_TOOL_NAMES,
  advertisedTool, assertReviewedArguments, checkPlaywrightTools, describePlaywrightCheck,
  assertSafeBrowserCall, normalizeBrowserArguments, assertFileUploadPreflight, assertFileUploadGates, extractCandidateFilePaths, UPLOAD_TOOL_PATH_FIELDS,
  blockedResult, buildUpstreamArgs, countOpenTabsFromListResult, createGatewaySession,
  extractPlaywrightErrorText, httpNavigation, recordOutcome, redactPlaywrightResponse, redactPlaywrightText, redactSensitiveUrlText,
  routeGoogleNavigation, safeMessage, sanitizeTrackedResponse, start, resolveCachedPlaywrightCli,
  stripIncidentalTabInventory, writeUpstreamStderrLine, resolveNpxInvocation, upstreamSpawnArgs
};
