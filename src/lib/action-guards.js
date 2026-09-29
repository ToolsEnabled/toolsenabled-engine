'use strict';

// Point-of-action refusals for built-in product policies that can be decided
// mechanically with high precision.
//
//   BROWSER ISOLATION     -- the owned browser profile, its cookies, and its CDP
//                            endpoint may never cross into Docker.
//   COMPLETION INTEGRITY -- a timeout or truncation is a continuation, never a success.
//   LANE SCOPE   -- a local lane may not invoke outward/cross-machine tools.
//
// Dependency-free (node builtins only). No I/O, no network, no writes.

const path = require('node:path');
const laneScope = require('./lane-scope');

// --- shared: bounded argument traversal --------------------------------------

const MAX_SCAN_NODES = 512;
const MAX_VALUE_CHARS = 20000;

/** Every string argument value with its argument path. Bounded. */
function findStringArguments(args, { maxNodes = MAX_SCAN_NODES } = {}) {
  const found = [];
  let visited = 0;
  const walk = (value, keyPath) => {
    if (visited >= maxNodes) return;
    visited += 1;
    if (typeof value === 'string') {
      if (value.length > 0) found.push({ key: keyPath || '$', value: value.slice(0, MAX_VALUE_CHARS) });
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) walk(entry, `${keyPath}[${index}]`);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) walk(entry, keyPath ? `${keyPath}.${key}` : key);
    }
  };
  walk(args, '');
  return found;
}

// =============================================================================
// Browser isolation -- the owned browser profile never crosses the Docker boundary
// =============================================================================
//
// The built-in browser-isolation policy keeps authenticated sessions in the
// host-owned browser and never copies its profile, cookies, or CDP into Docker.
//
// SCOPE, deliberately narrow: sandbox.* tools only. The order does NOT forbid
// using the profile -- the whole point of `profiles/chrome` is that the owned
// browser uses it. It forbids putting it in Docker. Guarding every tool would
// refuse the legitimate host-browser path and train people to ignore this
// refusal, so the guard fires exactly at the boundary the order names.

const SANDBOX_TOOL_PREFIX = 'sandbox.';

// The owned profile root. Both separators, and the boundaries are deliberately
// looser than "start of string or a slash": the realistic violation is a path
// embedded in a shell string -- `cp -r profiles/chrome /w` -- which a
// start-or-separator anchor misses entirely. (That exact case was a live gap
// caught by this module's own negative tests before it shipped.) The leading
// boundary is any non-path-name character, so `myprofiles/chrome` still does
// not match; the trailing boundary allows whitespace and quotes so a
// mid-command occurrence is caught, while `profiles/chromium` still is not.
const OWNED_PROFILE_SEGMENT = /(?:^|[^A-Za-z0-9_.-])profiles[\\/]chrome(?=[\\/]|\s|["']|$)/i;

// Chrome's own credential-bearing files inside a profile. Named explicitly so a
// copy of just the cookie jar -- without the directory name -- is still caught.
//
// CASE-SENSITIVE on purpose: these are Chrome's exact on-disk filenames, and
// matching them case-insensitively next to a whitespace boundary would fire on
// ordinary prose like "the web data pipeline". Precision matters more than
// recall here -- a guard that refuses honest work gets overridden, and an
// overridden guard is worse than no guard.
const PROFILE_CREDENTIAL_FILE = /(?:^|[^A-Za-z0-9_.-])(?:Cookies(?:-journal)?|Login Data(?:-journal)?|Local State|Web Data|Safe Browsing Cookies)(?=[\\/]|\s|["']|$)/;

// A CDP control surface. These are the shapes that actually let a container
// drive or drain the owned browser session.
const CDP_SIGNAL = [
  { pattern: /--remote-debugging-(?:port|address|pipe)\b/i, what: 'a Chrome remote-debugging flag' },
  { pattern: /\bws:\/\/[^\s"']*\/devtools\//i, what: 'a DevTools WebSocket endpoint' },
  { pattern: /\bhttps?:\/\/[^\s"']*\/json\/(?:version|list|new)\b/i, what: 'a CDP HTTP discovery endpoint' },
  { pattern: /\bdevtools\/browser\/[0-9a-f-]{8,}/i, what: 'a DevTools browser target id' },
  { pattern: /\bCDP_(?:ENDPOINT|URL|PORT)\b/i, what: 'a CDP endpoint environment variable' }
];

/**
 * Decide whether one sandbox argument value crosses the browser boundary.
 * @returns {{what:string, detail:string}|null}
 */
function browserBoundaryFinding(value) {
  const text = String(value);
  if (OWNED_PROFILE_SEGMENT.test(text)) {
    return {
      what: 'the host-owned browser profile directory (profiles/chrome)',
      detail: 'That directory can hold long-lived remembered-device state. No agent can '
        + 'recreate it -- restoring it requires a person physically approving an MFA factor.'
    };
  }
  if (PROFILE_CREDENTIAL_FILE.test(text)) {
    return {
      what: 'a Chrome profile credential store (cookie jar / login data / local state)',
      detail: 'Copying the cookie jar into a container is copying the authenticated session itself, which is '
        + 'the thing this order exists to keep on the host.'
    };
  }
  for (const { pattern, what } of CDP_SIGNAL) {
    if (pattern.test(text)) {
      return {
        what: `${what} (Chrome DevTools Protocol)`,
        detail: 'CDP access to the owned browser is full control of the authenticated session. A container '
          + 'holding it can read every logged-in account without any further credential.'
      };
    }
  }
  return null;
}

/**
 * @param {string} toolName
 * @param {object} args
 * @returns {{key:string, value:string, what:string, detail:string}|null}
 */
function findBrowserBoundaryViolation(toolName, args) {
  if (typeof toolName !== 'string' || !toolName.startsWith(SANDBOX_TOOL_PREFIX)) return null;
  for (const { key, value } of findStringArguments(args)) {
    const finding = browserBoundaryFinding(value);
    if (finding) return { key, value: value.slice(0, 300), ...finding };
  }
  return null;
}

function browserBoundaryRefusal(toolName, finding) {
  const error = new Error(
    `Tool '${toolName}' argument ${finding.key} references ${finding.what}, which may never cross into a `
    + `Docker sandbox. ${finding.detail} `
    + 'Built-in browser isolation policy: keep authenticated sessions in the host-owned browser '
    + 'and never copy its profile, cookies, or CDP into Docker. '
    + 'This order permits USING the owned profile from the host browser; it forbids putting it in a '
    + 'container. Drive the authenticated session through the host browser path instead, or run the '
    + 'sandbox against a throwaway profile it creates itself. '
    + `Offending value: ${JSON.stringify(finding.value)}`
  );
  error.code = 'BROWSER_ISOLATION_REFUSED';
  error.tool = toolName;
  error.field = finding.key;
  return error;
}

// =============================================================================
// Lane-scope policy -- a local lane cannot cross the machine boundary
// =============================================================================

// Exact names are enumerated from src/lib/tool-registry.js. The family
// prefixes retain the explicit `family.*` contract if another tool is
// later added inside one of those already-scoped families. host.* and repo.*
// are the registered file/exec surfaces exposed by the Bridge/FRA proxy
// machinery; a lane-scoped process cannot distinguish a local registration
// from the same registered name reached through a peer proxy, so local lanes
// fail closed on those bounded surfaces.
const LANE_SCOPE_CROSS_MACHINE_PREFIXES = Object.freeze([
  'instagram.', 'workstation.', 'iphone.'
]);
const LANE_SCOPE_CROSS_MACHINE_TOOLS = new Set([
  'gmail.send',
  'instagram.verify',
  'instagram.publish_image',
  'workstation.status',
  'workstation.install_cursor',
  'workstation.sync_cursor_extensions',
  'workstation.configure_agent_clients',
  'workstation.initialize_cursor_state',
  'workstation.launch_cursor',
  'iphone.handoff_status',
  'host.read_file',
  'host.write_file',
  'host.patch_file',
  'host.list_dir',
  'host.list_processes',
  'host.exec',
  'repo.read_file',
  'repo.write_file',
  'repo.patch_file',
  'repo.list_dir',
  // The internal agent-comms fabric's relay is an authenticated cross-machine
  // transport (src/lib/tool-registry.js effect: external-write/external-read).
  // agent_comms.acknowledge stays local
  // (it only touches this agent's own already-synchronized inbox cursor;
  // synchronization itself happens in .read, which is now guarded).
  'agent_comms.send',
  'agent_comms.read'
]);

function crossMachineFamily(toolName) {
  if (typeof toolName !== 'string') return null;
  const prefix = LANE_SCOPE_CROSS_MACHINE_PREFIXES.find(value => toolName.startsWith(value));
  if (prefix) return prefix;
  if (LANE_SCOPE_CROSS_MACHINE_TOOLS.has(toolName)) return toolName;
  return null;
}

/**
 * @param {string} toolName
 * @param {object} args
 * @returns {{directiveId:string|null, family:string, machineScope:string|null, invalidContract?:boolean, detail?:string}|null}
 */
function findLaneScopeViolation(toolName, args) {
  void args;
  const family = crossMachineFamily(toolName);
  if (!family || !Object.prototype.hasOwnProperty.call(process.env, laneScope.ENV_VAR)) return null;
  let scope;
  try { scope = laneScope.parse(process.env[laneScope.ENV_VAR]); }
  catch (error) {
    return {
      directiveId: null,
      family,
      machineScope: null,
      invalidContract: true,
      detail: error && error.message ? String(error.message).slice(0, 300) : 'invalid lane scope payload'
    };
  }
  if (scope.machineScope === 'cross-machine') return null;
  return {
    directiveId: scope.directiveId === undefined ? null : scope.directiveId,
    family,
    machineScope: scope.machineScope
  };
}

function laneScopeRefusal(toolName, finding) {
  const directive = finding.directiveId === null ? '(not provided)' : finding.directiveId;
  const contractDetail = finding.invalidContract
    ? `The ${laneScope.ENV_VAR} contract is invalid (${finding.detail}), so cross-machine authority cannot be established. `
    : `The lane contract has machineScope '${finding.machineScope}'. `;
  const error = new Error(
    `Directive ${directive} lane scope refuses tool '${toolName}' from cross-machine family '${finding.family}'. `
    + contractDetail
    + "This action requires machineScope 'cross-machine'; local scope cannot send, copy, sync, read, write, or execute across another machine."
  );
  error.code = 'LANE_SCOPE_REFUSED';
  error.tool = toolName;
  error.directiveId = finding.directiveId;
  error.requiredMachineScope = 'cross-machine';
  return error;
}

// =============================================================================
// Completion integrity -- a truncation is a continuation, never a success
// =============================================================================
//
// Built-in completion-integrity policy: a timeout or truncation is continuation,
// never success. The durable-task shared-run protocol uses the same rule.
//
// SCOPE: tools that record a TERMINAL SUCCESS. Refusing here is safe precisely
// because the honest paths remain wide open -- task.fail carries a
// disposition, and task.checkpoint carries partial progress
// forward. Nothing is blocked except the one claim that is false.
//
// PRECISION over recall, deliberately. These patterns are machine-emitted
// SENTINELS, not natural prose. "the flaky test that timed out now passes" is a
// legitimate success summary and must not be refused -- so bare words like
// "timeout" and "truncated" are NOT on this list. Only bracketed markers,
// provider stop-reason fields, and signal names are, because a human writing a
// summary does not produce those by accident. A refusal that fires on honest
// prose would get routinely overridden, which trains everyone to ignore
// refusals and is worse than the prose rule it replaced.

const TERMINAL_SUCCESS_TOOLS = new Set(['task.complete']);

const TRUNCATION_SENTINEL = [
  { pattern: /\[\s*(?:output\s+|response\s+|result\s+)?truncated[^\]]*\]/i, what: 'a bracketed [truncated] marker' },
  { pattern: /<\s*truncated[^>]*>/i, what: 'a <truncated> marker' },
  { pattern: /\.\.\.\s*\(\s*truncated/i, what: 'an ellipsis-truncated marker' },
  { pattern: /%TRUNCATED%/i, what: 'a %TRUNCATED% sentinel' },
  { pattern: /"?(?:stop|finish)_reason"?\s*[:=]\s*"?(?:max_tokens|length)"?/i, what: 'a provider stop_reason of max_tokens/length' },
  { pattern: /\bmax_output_tokens\s+(?:reached|exceeded|hit)\b/i, what: 'an output-token limit report' },
  { pattern: /\bETIMEDOUT\b/, what: 'an ETIMEDOUT error code' },
  { pattern: /\bSIGKILL\b/, what: 'a SIGKILL signal name' },
  { pattern: /\bcommand timed out after\b/i, what: 'a command-timeout report' },
  { pattern: /\bwall[- ]clock (?:limit|budget) (?:reached|exceeded)\b/i, what: 'a wall-clock budget report' }
];

/**
 * @param {string} toolName
 * @param {object} args
 * @returns {{key:string, value:string, what:string}|null}
 */
function findTruncatedSuccessClaim(toolName, args) {
  if (!TERMINAL_SUCCESS_TOOLS.has(toolName)) return null;
  for (const { key, value } of findStringArguments(args)) {
    for (const { pattern, what } of TRUNCATION_SENTINEL) {
      if (pattern.test(value)) {
        const match = value.match(pattern);
        return { key, value: String(match && match[0] ? match[0] : value).slice(0, 200), what };
      }
    }
  }
  return null;
}

function truncatedSuccessRefusal(toolName, finding) {
  const error = new Error(
    `Tool '${toolName}' would record a TERMINAL SUCCESS whose payload carries ${finding.what} at argument `
    + `${finding.key} (${JSON.stringify(finding.value)}). `
    + 'Built-in completion integrity policy: a timeout or truncation is continuation, never success. '
    + 'A success recorded over a truncated result is a softened status, and a softened status '
    + 'is what the person reading the report ends up believing. '
    + 'The honest paths are open and unchanged: checkpoint the partial progress and keep working '
    + `(task.checkpoint), or record the real `
    + `outcome (task.fail) with its disposition. `
    + 'If the work genuinely finished and this marker is quoted evidence rather than your own outcome, '
    + 'summarise it in words instead of pasting the sentinel.'
  );
  error.code = 'TRUNCATED_SUCCESS_REFUSED';
  error.tool = toolName;
  error.field = finding.key;
  return error;
}

// --- the single entry point the chokepoint calls -----------------------------

/**
 * Run every point-of-action guard for one tool dispatch. Throws the first
 * refusal; returns silently when nothing is violated.
 *
 * Called from src/lib/tool-registry.js#executeTool(), the one route every tool
 * call takes -- native mcp__toolsenabled__* included, which is the route no
 * PreToolUse hook can see.
 */
function assertActionGuards(toolName, args) {
  const browserFinding = findBrowserBoundaryViolation(toolName, args);
  if (browserFinding) throw browserBoundaryRefusal(toolName, browserFinding);

  const laneFinding = findLaneScopeViolation(toolName, args);
  if (laneFinding) throw laneScopeRefusal(toolName, laneFinding);

  const truncationFinding = findTruncatedSuccessClaim(toolName, args);
  if (truncationFinding) throw truncatedSuccessRefusal(toolName, truncationFinding);
}

module.exports = {
  assertActionGuards,
  findStringArguments,
  findBrowserBoundaryViolation,
  browserBoundaryFinding,
  findLaneScopeViolation,
  laneScopeRefusal,
  findTruncatedSuccessClaim,
  LANE_SCOPE_CROSS_MACHINE_PREFIXES,
  LANE_SCOPE_CROSS_MACHINE_TOOLS,
  TERMINAL_SUCCESS_TOOLS,
  SANDBOX_TOOL_PREFIX
};
