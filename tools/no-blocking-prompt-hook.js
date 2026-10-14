#!/usr/bin/env node
'use strict';

// NO-BLOCKING-PROMPT PreToolUse gate -- enforcement for the customer setting
// that prevents an agent from halting its workflow on a modal question. The
// setting remains user-changeable through the product settings surface.
//
// WHAT IT DOES: refuses (exit 2) any tool call whose whole purpose is to HALT
// the caller until a human answers -- AskUserQuestion (the harness option box),
// mcp__toolsenabled__system_ask (a WinForms ShowDialog() driven by spawnSync,
// 5-900s), and mcp__toolsenabled__system_ask_remote (a while(true) poll,
// 5-600s) -- plus any other MCP server re-exporting the same two tools under
// its own prefix. The refusal text IS the remedy: state the question and the
// assumption you are proceeding under in your reply, and keep working.
//
// WHAT IT NEVER REFUSES: the tools that NOTIFY or ENQUEUE and return in
// milliseconds -- owner_prompts_start/status/events/cancel,
// system_credential_request, purchase_request,
// purchase_decision, system_notify. Those are the substitute behaviour the
// refusal points at, so gating them would leave an agent with no route to the
// owner at all. Detection here is POSITIVE ONLY: anything not in the deny set
// returns allow-not-gated-tool without reading any config.
//
// AUTHORIZATION MODE IS ALSO REFUSED, and that has a stated cost. system.ask
// in authorization mode (tool_input.action + tool_input.arguments) is the only
// issuer of the one-time approval token that the MCP tool registry demands for
// approval-gated tools; it blocks on the same spawnSync dialog. So while this
// gate is ON, approval-gated tools are not callable by an agent at all. That
// is logged under its own mode ('authorization') so the cost is visible rather
// than discovered. Splitting the registry entry so authorization mode survives
// is a recorded follow-up (docs/design/NO-BLOCKING-PROMPT-GATE.md), not built
// here.
//
// DECISION POLICY (same shape as tools/clarify-gate-hook.js, deliberately):
//   - ABSENCE IS NOT CONSENT. A missing settings file, an unreadable settings
//     file, a malformed config, a missing or non-boolean `enabled` field, an
//     unloadable registry -- all mean the gate is ON.
//   - `enabled: false`, or the user setting agent.blocking_prompt_gate set to
//     false by a person, is an HONEST withhold: the call proceeds, and the
//     hook logs that it was withheld. Never silent.
//   - Only PLUMBING failures fail open (unreadable/unparseable stdin, an
//     unexpected internal bug), logged distinctly as fail-open.
//
// PRECEDENCE: the REGISTRY ROW IS AUTHORITATIVE. A value for
// agent.blocking_prompt_gate whose provenance source is 'user' or 'installer'
// decides, and config/no-blocking-prompt-gate.json is ignored. The config file
// only decides when nobody has chosen -- i.e. when the setting is still at its
// registry default. That is what makes the row a real control rather than a
// dead catalogue entry.
//
// Schema: PreToolUse receives {tool_name, tool_input, cwd, session_id, ...} on
// stdin; exit 2 blocks the call and shows stderr to the model/user; exit 0
// allows. Exit 1 is deliberately never used (fail-open uses exit 0), matching
// tools/clarify-gate-hook.js.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'logs', 'no-blocking-prompt-hook.log');
const DEFAULT_CONFIG_FILE = path.join(ROOT, 'config', 'no-blocking-prompt-gate.json');
const SETTING_ID = 'agent.blocking_prompt_gate';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_LOG_FIELD_LENGTH = 400;

// Exact names first (all fast-path safe), then an alias regex for any other MCP
// server name that re-exports the same two tools.
const BLOCKING_TOOL_NAMES = new Set([
  'AskUserQuestion',
  'mcp__toolsenabled__system_ask',
  'mcp__toolsenabled__system_ask_remote',
  'system.ask',
  'system.ask_remote'
]);
const BLOCKING_TOOL_RE = /^mcp__[A-Za-z0-9_-]+__system_ask(?:_remote)?$/;

// Path-traversal guard on the session id: a session id that is not this shape
// falls back to the fixed name below. Log field only -- this hook writes no
// per-session state.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FALLBACK_SESSION_ID = 'unknown-session';

function isBlockingTool(toolName) {
  return BLOCKING_TOOL_NAMES.has(toolName) || BLOCKING_TOOL_RE.test(toolName);
}

// ---------------------------------------------------------------------------
// logging -- best-effort, append-only, never load-bearing for the decision.
// ---------------------------------------------------------------------------

function truncate(value) {
  if (typeof value !== 'string') return value;
  return value.length > MAX_LOG_FIELD_LENGTH ? `${value.slice(0, MAX_LOG_FIELD_LENGTH)}…` : value;
}

function appendLog(entry, env = process.env) {
  try {
    const file = logFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    // Logging must never be why this hook fails open or blocks. Swallow.
  }
}

// ---------------------------------------------------------------------------
// stdin / decision plumbing (BOM strip mirrors clarify-gate-hook.js, which
// measured a leading UTF-8 BOM on real PreToolUse invocations).
// ---------------------------------------------------------------------------

function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readStdin() {
  try {
    return stripBom(fs.readFileSync(0, 'utf8'));
  } catch {
    return '';
  }
}

function allow() {
  process.exit(0);
}

function block(message) {
  const text = message.endsWith('\n') ? message : `${message}\n`;
  process.stderr.write(text);
  process.exit(2);
}

function failOpen(context, error) {
  appendLog({
    rule: 'NO-BLOCKING-PROMPT',
    decision: 'fail-open',
    context,
    error: truncate(String((error && error.message) || error || ''))
  });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// test-only path overrides, constrained under <repo>/scratch exactly like
// clarify-gate-hook.js: honored only when NODE_ENV=test, and only when the
// target resolves strictly inside the ignored scratch/ tree.
//
// The LOG file override is new here, and deliberate. tests/clarify-gate.test.js
// asserts an exact line count against the real shared logs/clarify-gate-hook.log
// and therefore flakes whenever another live session appends to it. Do not
// repeat that defect: this hook's tests read a test-only log file whole.
// ---------------------------------------------------------------------------

function relativePathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`test override did not resolve inside ${root}`);
  }
  return relative;
}

function overriddenPath(envName, fallback, env) {
  const override = env && env.NODE_ENV === 'test' && env[envName];
  if (!override) return fallback;
  const resolved = path.resolve(override);
  relativePathInside(path.join(ROOT, 'scratch'), resolved);
  return resolved;
}

function configFile(env = process.env) {
  return overriddenPath('NO_BLOCKING_PROMPT_TEST_CONFIG_FILE', DEFAULT_CONFIG_FILE, env);
}

function logFile(env = process.env) {
  try {
    return overriddenPath('NO_BLOCKING_PROMPT_TEST_LOG_FILE', LOG_FILE, env);
  } catch {
    return LOG_FILE;
  }
}

// ---------------------------------------------------------------------------
// config -- the machine-local mirror. Every failure mode is GATE ON: an absent
// file, an unreadable file, malformed JSON, a missing `enabled` field, or a
// non-boolean `enabled` all mean the gate stands. Only a literal boolean false
// turns it off, and that is logged as withheld, never silent.
// ---------------------------------------------------------------------------

function loadGateConfig(env = process.env) {
  const file = configFile(env);
  let raw;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
      return { enabled: true, state: 'config-unusable-gate-on', file };
    }
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { enabled: true, state: 'config-absent-gate-on', file };
  }
  let parsed;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch {
    return { enabled: true, state: 'config-malformed-gate-on', file };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { enabled: true, state: 'config-malformed-gate-on', file };
  }
  if (parsed.enabled === false) return { enabled: false, state: 'config-disabled', file };
  if (parsed.enabled === true) return { enabled: true, state: 'config-enabled', file };
  return { enabled: true, state: 'config-enabled-field-invalid-gate-on', file };
}

// ---------------------------------------------------------------------------
// the user setting -- agent.blocking_prompt_gate, read through the real
// settings loader so the registry row is not a dead catalogue entry. Never
// throws: an unreadable settings file or an unloadable registry is reported as
// unavailable, which resolves to GATE ON.
// ---------------------------------------------------------------------------

function readSettingValue(env = process.env) {
  try {
    const { loadSettings } = require('../src/lib/settings');
    const resolved = loadSettings({ env });
    const value = resolved.values[SETTING_ID];
    const source = resolved.provenance[SETTING_ID] && resolved.provenance[SETTING_ID].source;
    if (typeof value !== 'boolean') return { available: false, reason: 'setting-absent-or-mistyped' };
    return { available: true, value, source };
  } catch {
    return { available: false, reason: 'settings-unreadable' };
  }
}

// A value NOBODY CHOSE IS NOT CONSENT: provenance 'default' cannot disable the
// gate, only 'user' or 'installer' can. That is the same rule the clarify gate
// applies to an absent record, stated for a settings value instead of a file.
function resolveGate(env = process.env) {
  const setting = readSettingValue(env);
  if (setting.available && (setting.source === 'user' || setting.source === 'installer')) {
    return { enabled: setting.value, state: `setting-${setting.source}`, source: SETTING_ID, file: null };
  }
  const config = loadGateConfig(env);
  if (config.state === 'config-disabled') return { ...config, source: 'config-file' };
  if (config.state === 'config-enabled') return { ...config, source: 'config-file' };
  if (setting.available) return { enabled: setting.value, state: 'setting-default', source: SETTING_ID, file: config.file };
  return {
    enabled: true,
    state: setting.reason ? `${setting.reason}-gate-on` : 'gate-on',
    source: 'fail-closed',
    file: config.file
  };
}

function sessionIdFrom(payload) {
  const supplied = payload && payload.session_id;
  if (typeof supplied === 'string' && SESSION_ID_RE.test(supplied)) return supplied;
  return FALLBACK_SESSION_ID;
}

// ---------------------------------------------------------------------------
// refusal text -- the message IS the remedy. A refusal that only says "no"
// teaches the reader to fight the gate; this one says what to do instead and
// names the non-blocking routes that stay open.
// ---------------------------------------------------------------------------

function refusalMessage(toolName, mode, gate) {
  return [
    `NO-BLOCKING-PROMPT (owner 2026-08-13): ${toolName} is refused. This tool halts your turn waiting for a human answer.`,
    'Owner directive, verbatim: "do not ever pop up question boxes that stop your workflow. i said that. hold yourself and other agents to it thats a rule, its a setting make it a user setting in the program, it should be mechanically enforced in the program as our programs a harness".',
    'DO THIS INSTEAD, and keep working:',
    '  1. STATE the question in your reply text, in one sentence.',
    '  2. STATE the assumption you are proceeding on, in one sentence, in the owner\'s own terms.',
    '  3. CONTINUE the work under that assumption. Do not wait for an answer.',
    '  4. If the answer would change the result, put the question at the TOP of your final report, not buried in it.',
    'If a lane brief fences you and the question is genuinely blocking, use the non-blocking route: write LANE-QUESTIONS.md and end with VERDICT: NEEDS_INPUT (exit 0), or enqueue for the owner with a tool that returns immediately -- owner_prompts_start, system_credential_request, purchase_request, system_notify. None of those are gated here.',
    mode === 'authorization'
      ? 'NOTE: this was system.ask in AUTHORIZATION mode, the only issuer of the one-time approval token. While this gate is on, approval-gated tools are not callable by an agent. Report that as a blocked capability; do not work around it.'
      : null,
    `This gate is a user setting: ${SETTING_ID} (default true). A person turns it off in the app, or with: node tools/settings-set.js ${SETTING_ID} false. Absence of a value or of ${path.relative(ROOT, (gate && gate.file) || DEFAULT_CONFIG_FILE)} means the gate is ON.`
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// the decision. Pure-ish (fs reads only) and exported for unit tests; main()
// owns process exit and the one-line-per-decision log.
// ---------------------------------------------------------------------------

function evaluate(payload, env = process.env) {
  const toolName = String((payload && payload.tool_name) || '');

  // Positive detection only, and BEFORE any config or settings read: an
  // ungated tool must not pay for, or be affected by, a settings failure.
  if (!isBlockingTool(toolName)) {
    return { decision: 'allow-not-gated-tool', toolName: truncate(toolName) };
  }

  const toolInput = (payload && payload.tool_input) || {};
  const mode = toolName === 'AskUserQuestion'
    ? 'harness'
    : (typeof toolInput.action === 'string' && toolInput.action.trim() ? 'authorization' : 'general');
  const sessionId = sessionIdFrom(payload);
  const gate = resolveGate(env);

  if (gate.enabled === false) {
    // HONEST WITHHOLD: the call proceeds, and this log line is the
    // never-silent part of that contract.
    return {
      decision: 'allow-withheld-disabled',
      toolName,
      mode,
      sessionId,
      gateState: gate.state,
      source: gate.source,
      note: `no-blocking-prompt gate DISABLED by user setting ${SETTING_ID}=false; this call would otherwise be refused`
    };
  }

  return {
    decision: 'block-blocking-prompt',
    toolName,
    mode,
    sessionId,
    gateState: gate.state,
    source: gate.source,
    message: refusalMessage(toolName, mode, gate)
  };
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

function main() {
  let raw;
  try {
    raw = readStdin();
  } catch (error) {
    return failOpen('stdin-read', error);
  }

  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (error) {
    return failOpen('stdin-parse', error);
  }

  let outcome;
  try {
    outcome = evaluate(payload, process.env);
  } catch (error) {
    // Plumbing/unexpected-bug boundary ONLY. Config and settings validation
    // failures never throw out of evaluate(); they resolve to GATE ON.
    return failOpen('evaluate', error);
  }

  const { message, ...logFields } = outcome;
  appendLog({ rule: 'NO-BLOCKING-PROMPT', ...logFields });
  if (outcome.decision.startsWith('block')) return block(message);
  return allow();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    failOpen('main', error);
  }
}

module.exports = {
  ROOT,
  LOG_FILE,
  DEFAULT_CONFIG_FILE,
  SETTING_ID,
  FALLBACK_SESSION_ID,
  BLOCKING_TOOL_NAMES,
  BLOCKING_TOOL_RE,
  isBlockingTool,
  configFile,
  logFile,
  loadGateConfig,
  readSettingValue,
  resolveGate,
  sessionIdFrom,
  refusalMessage,
  evaluate,
  stripBom
};
