#!/usr/bin/env node
'use strict';

// Clarify-before-work PreToolUse gate. Its authority is the shipped product
// policy plus the current config/clarify-gate.json setting; request identifiers
// and inherited account history carry no meaning here.
//
// WHAT IT DOES: before any MUTATING tool call (native Edit/Write/NotebookEdit,
// or a Bash/PowerShell command the heuristics below classify as mutating --
// file writes, git commit/push, rm/del, installs), this hook requires a valid
// INTERPRETATION RECORD for the current session at
// state/clarify/<sessionId>.json:
//   directiveQuoted  -- the user's own words, quoted
//   interpretation   -- what this session understood the directive to mean
//   ambiguityCheck   -- "no-ambiguity-stated" | "question-asked"
//   question         -- required when ambiguityCheck is "question-asked"
// No valid record => the mutating call is refused (exit 2) with the exact
// remedy in the refusal text. Writing the record ITSELF is always allowed
// through the gate (the gate must never deadlock its own remedy).
//
// DECISION POLICY (deliberately different from standing-orders-hook.js's
// blanket fail-open):
//   - ABSENCE IS NOT CONSENT. A missing config file, a missing `enabled`
//     field, a malformed config, a missing record, an EMPTY record, or a
//     malformed record all mean the gate is ON and the call is refused.
//     Absence-as-consent is this codebase's recurring defect; every
//     validation failure here is fail-closed.
//   - `enabled: false` is an HONEST withhold: the mutating call proceeds, but
//     the hook logs that the gate was disabled by setting. Never silent.
//   - Read-only/observability commands (ls, cat, git status/log/diff, grep,
//     node --version, ...) always pass: the gate blocks mutation, not
//     investigation. An unclassified command passes; the mutation matchers
//     are the positive detections.
//   - PLUMBING failures refuse too (unreadable/unparseable stdin or an
//     unexpected internal bug). An input the hook could not evaluate must not
//     be collapsed into permission to mutate.
//
// This is a discipline mechanism, not an adversarial security boundary --
// like CONTROLLER_DELEGATED in standing-orders-hook.js, the remedy carve-out
// is an auditable, visible signal, not an unforgeable one; every decision
// (allow/refuse/withheld) writes one line to logs/clarify-gate-hook.log.
//
// Schema: PreToolUse receives {tool_name, tool_input, cwd, session_id, ...}
// on stdin; exit 2 blocks the call and shows stderr to the model/user; exit 0
// allows. Exit 1 is deliberately never used, matching
// tools/standing-orders-hook.js.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'logs', 'clarify-gate-hook.log');
const DEFAULT_CONFIG_FILE = path.join(ROOT, 'config', 'clarify-gate.json');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'clarify');
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_LOG_FIELD_LENGTH = 400;
const LOCAL_WRITE_TOOL_RE = /^(Edit|Write|NotebookEdit)$/;
const SHELL_TOOL_RE = /^(Bash|PowerShell)$/;
// "question-asked" means the question was surfaced in the reply, recorded,
// and worked past under a named assumption. It does not mean the session
// halted. The value remains stable for compatibility with current records.
const AMBIGUITY_CHECK_VALUES = ['no-ambiguity-stated', 'question-asked'];
// Path-traversal guard on the record filename: a session id that is not this
// shape (including one containing `..` or a separator) falls back to the
// fixed name below instead of ever reaching path.join.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FALLBACK_SESSION_ID = 'unknown-session';

// ---------------------------------------------------------------------------
// logging -- best-effort, append-only, never load-bearing for the decision.
// Same convention as logs/standing-orders-hook.log: one JSON line per entry.
// ---------------------------------------------------------------------------

function truncate(value) {
  if (typeof value !== 'string') return value;
  return value.length > MAX_LOG_FIELD_LENGTH ? `${value.slice(0, MAX_LOG_FIELD_LENGTH)}…` : value;
}

function appendLog(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch {
    // Logging must never be why this hook fails open or blocks. Swallow.
  }
}

function snippet(command) {
  return truncate(String(command || ''));
}

// ---------------------------------------------------------------------------
// stdin / decision plumbing (BOM strip mirrors standing-orders-hook.js, which
// measured a leading UTF-8 BOM on ~13% of real PreToolUse invocations).
// ---------------------------------------------------------------------------

function stripBom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readStdin() {
  return stripBom(fs.readFileSync(0, 'utf8'));
}

function allow() {
  process.exit(0);
}

function block(message) {
  const text = message.endsWith('\n') ? message : `${message}\n`;
  process.stderr.write(text);
  process.exit(2);
}

function refuseIndeterminate(context, error) {
  const detail = truncate(String((error && error.message) || error || 'unknown failure'));
  appendLog({ rule: 'CLARIFY-GATE', decision: 'block-indeterminate', context, error: detail });
  block(`CLARIFY-GATE: refusing mutating work because the hook could not establish a safe decision (${context}: ${detail}).`);
}

// ---------------------------------------------------------------------------
// test-only path overrides, constrained under <repo>/scratch exactly like
// STANDING_ORDERS_HOOK_TEST_AUTH_DIR: honored only when NODE_ENV=test, and
// only when the target resolves strictly inside the ignored scratch/ tree,
// so they can never redirect production gate state.
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
  return overriddenPath('CLARIFY_GATE_TEST_CONFIG_FILE', DEFAULT_CONFIG_FILE, env);
}

function stateDirectory(env = process.env) {
  return overriddenPath('CLARIFY_GATE_TEST_STATE_DIR', DEFAULT_STATE_DIR, env);
}

// ---------------------------------------------------------------------------
// config -- current user setting. Every failure mode is GATE ON: an absent
// file, an unreadable file, malformed JSON, a missing `enabled` field, or a
// non-boolean `enabled` all mean the gate stands. Only a literal boolean
// false turns it off, and that is logged as withheld, never silent.
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
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { enabled: true, state: 'config-absent-gate-on', file };
    }
    return {
      enabled: true,
      state: 'config-unreadable-gate-on',
      file,
      error: truncate(String((error && error.message) || error))
    };
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
// interpretation record -- state/clarify/<sessionId>.json
// ---------------------------------------------------------------------------

function sessionIdFrom(payload) {
  const supplied = payload && payload.session_id;
  if (typeof supplied === 'string' && SESSION_ID_RE.test(supplied)) return supplied;
  return FALLBACK_SESSION_ID;
}

function recordFile(sessionId, env = process.env) {
  return path.join(stateDirectory(env), `${sessionId}.json`);
}

function validateRecordObject(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return ['the record must be a JSON object'];
  }
  const problems = [];
  if (typeof record.directiveQuoted !== 'string' || !record.directiveQuoted.trim()) {
    problems.push('directiveQuoted must be a non-empty string quoting the user\'s own words');
  }
  if (typeof record.interpretation !== 'string' || !record.interpretation.trim()) {
    problems.push('interpretation must be a non-empty string stating what this session understood the directive to mean');
  }
  if (!AMBIGUITY_CHECK_VALUES.includes(record.ambiguityCheck)) {
    problems.push(`ambiguityCheck must be exactly one of ${AMBIGUITY_CHECK_VALUES.map(v => `"${v}"`).join(' | ')}`);
  }
  if (record.ambiguityCheck === 'question-asked' && (typeof record.question !== 'string' || !record.question.trim())) {
    problems.push('question is required (a non-empty string: the follow-up question surfaced in your reply) when ambiguityCheck is "question-asked"');
  }
  if (record.question !== undefined && typeof record.question !== 'string') {
    problems.push('question, when present, must be a string');
  }
  return problems;
}

// Returns {status:'absent'} | {status:'invalid', problems} | {status:'valid'}.
// Every read failure other than a clean ENOENT is INVALID, not absent-and-
// ignored and not fail-open: an unreadable or oversized record is not consent.
function loadInterpretationRecord(sessionId, env = process.env) {
  const file = recordFile(sessionId, env);
  let raw;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { status: 'invalid', file, problems: ['the record path exists but is not a regular file'] };
    if (stat.size === 0) return { status: 'invalid', file, problems: ['the record file is empty; an empty record is not consent'] };
    if (stat.size > MAX_RECORD_BYTES) return { status: 'invalid', file, problems: [`the record file exceeds ${MAX_RECORD_BYTES} bytes`] };
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return { status: 'absent', file };
    return { status: 'invalid', file, problems: [`the record could not be read: ${String((error && error.message) || error)}`] };
  }
  let parsed;
  try {
    parsed = JSON.parse(stripBom(raw));
  } catch {
    return { status: 'invalid', file, problems: ['the record is not valid JSON'] };
  }
  const problems = validateRecordObject(parsed);
  if (problems.length) return { status: 'invalid', file, problems };
  return { status: 'valid', file, record: parsed };
}

// ---------------------------------------------------------------------------
// mutation heuristics for Bash/PowerShell. Positive detections only: a
// command none of these recognize passes as investigation. Read-only staples
// (ls, cat, git status/log/diff, grep, node --version) match nothing here.
// ---------------------------------------------------------------------------

// `>`/`>>` to a real file is a write; `> /dev/null`, `>$null`, `>NUL`, and
// fd duplication (`2>&1`) are output plumbing, not mutation.
function hasFileWriteRedirect(command) {
  const re = /\d*>>?\s*([^\s;|&<>]+)/g;
  let match;
  while ((match = re.exec(String(command || '')))) {
    const target = match[1].toLowerCase();
    if (target === '/dev/null' || target === '$null' || target === 'nul' || target.startsWith('&')) continue;
    return true;
  }
  return false;
}

const SHELL_MUTATION_MATCHERS = [
  { code: 'powershell-write-cmdlet', re: /\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content)\b/i },
  { code: 'file-mutation-cli', re: /(?:^\s*|[;&|]\s*)(?:sudo\s+)?(?:rm|del|erase|rmdir|rd|mv|move|cp|copy|mkdir|md|touch|tee)(?:\.exe)?\s/i },
  { code: 'in-place-edit', re: /(?:^\s*|[;&|]\s*)sed(?:\.exe)?\s[^\n;|&]*-i\b/i },
  { code: 'tee-write', re: /\|\s*tee\b/i },
  { code: 'git-mutation', re: /(?:^\s*|[;&|]\s*)git(?:\.exe)?\s+(?:commit|push|merge|rebase|revert|cherry-pick|rm|mv|apply|am|stash|tag|reset|restore|clean|switch|checkout)\b/i },
  { code: 'package-install', re: /(?:^\s*|[;&|]\s*)(?:npm|pnpm|yarn|bun|pip|pip3|pipx)(?:\.cmd|\.exe)?\s+(?:install|i|ci|add|uninstall|remove|rm|un)\b/i }
];

// Returns { mutating: boolean, code: string|null }.
function classifyShellMutation(command) {
  const text = String(command || '');
  for (const matcher of SHELL_MUTATION_MATCHERS) {
    if (matcher.re.test(text)) return { mutating: true, code: matcher.code };
  }
  if (hasFileWriteRedirect(text)) return { mutating: true, code: 'redirect-write' };
  return { mutating: false, code: null };
}

// ---------------------------------------------------------------------------
// remedy carve-out -- the gate must never deadlock the write that satisfies
// it. Any write into the clarify state directory passes, natively or via a
// shell command that names it. Visible signal, not unforgeable proof; every
// use is logged as allow-remedy.
// ---------------------------------------------------------------------------

function nativeWriteTarget(toolName, toolInput, cwd) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const supplied = toolName === 'NotebookEdit' ? toolInput.notebook_path : toolInput.file_path;
  if (typeof supplied !== 'string' || !supplied.trim()) return null;
  const base = typeof cwd === 'string' && cwd ? cwd : ROOT;
  return path.isAbsolute(supplied) ? path.resolve(supplied) : path.resolve(base, supplied);
}

function isInsideClarifyState(target, env = process.env) {
  if (typeof target !== 'string' || !target) return false;
  const relative = path.relative(stateDirectory(env), target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function referencesClarifyState(command, env = process.env) {
  const text = String(command || '');
  const normalize = value => value.replace(/\//g, '\\').toLowerCase();
  if (normalize(text).includes(normalize(stateDirectory(env)))) return true;
  return /state[\\/]+clarify[\\/]/i.test(text);
}

// ---------------------------------------------------------------------------
// refusal text -- the message IS the remedy. A refusal that does not say
// exactly how to proceed just teaches the reader to fight the gate.
// ---------------------------------------------------------------------------

function refusalMessage(record, sessionId) {
  const status = record.status === 'invalid'
    ? `An interpretation record exists at ${record.file} but it is INVALID -- an empty or malformed record is not consent: ${record.problems.join('; ')}.`
    : `No interpretation record exists for this session (session id: ${sessionId}; expected at ${record.file}).`;
  return [
    'CLARIFY-GATE: mutating work is blocked until this session records its interpretation of the user\'s directive.',
    'Ambiguous directives require a follow-up question to be surfaced before mutating work starts. Record the question here and continue under a named assumption rather than halting for an answer.',
    status,
    'Remedy (this specific write is allowed through the gate): write that file as JSON with exactly these fields:',
    '  directiveQuoted  - the user\'s own words, quoted',
    '  interpretation   - what this session understood the directive to mean',
    '  ambiguityCheck   - "no-ambiguity-stated" if the directive is genuinely unambiguous, or "question-asked" if you surfaced a follow-up question in your reply',
    '  question         - required when ambiguityCheck is "question-asked": the follow-up question you stated in your reply (state it, name your working assumption, and continue; do not wait for an answer)',
    'If the directive is ambiguous, STATE the question and the assumption you are proceeding on in your reply, record "question-asked" with that same question, and keep working -- never halt for an answer (see the NO-BLOCKING-PROMPT gate). "no-ambiguity-stated" is an explicit, logged claim, not a formality.',
    'This gate is controlled by the current user setting: config/clarify-gate.json {"enabled": false} withholds it, honestly and logged. Absence of that file or field means the gate is ON.'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// the decision. Pure-ish (fs reads only) and exported for unit tests; main()
// owns process exit and the one-line-per-decision log.
// ---------------------------------------------------------------------------

function evaluate(payload, env = process.env) {
  const toolName = String((payload && payload.tool_name) || '');
  const toolInput = (payload && payload.tool_input) || {};
  const cwd = payload && typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : ROOT;
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';

  const isNativeWrite = LOCAL_WRITE_TOOL_RE.test(toolName);
  const isShell = SHELL_TOOL_RE.test(toolName);
  if (!isNativeWrite && !isShell) {
    return { decision: 'allow-not-gated-tool', toolName: truncate(toolName) };
  }

  let mutationCode;
  if (isNativeWrite) {
    mutationCode = `native-${toolName.toLowerCase()}`;
    const target = nativeWriteTarget(toolName, toolInput, cwd);
    if (target && isInsideClarifyState(target, env)) {
      return { decision: 'allow-remedy', toolName, target: truncate(target) };
    }
  } else {
    const classification = classifyShellMutation(command);
    if (!classification.mutating) {
      return { decision: 'allow-read-only', toolName, command: snippet(command) };
    }
    mutationCode = classification.code;
    if (referencesClarifyState(command, env)) {
      return { decision: 'allow-remedy', toolName, command: snippet(command) };
    }
  }

  const sessionId = sessionIdFrom(payload);
  const config = loadGateConfig(env);
  const record = loadInterpretationRecord(sessionId, env);

  if (record.status === 'valid') {
    return { decision: 'allow-valid-record', toolName, mutationCode, sessionId, configState: config.state };
  }

  if (!config.enabled) {
    // Disabled is an HONEST withhold. The call proceeds, and this log
    // line is the never-silent part of that contract.
    return {
      decision: 'allow-withheld-disabled',
      toolName,
      mutationCode,
      sessionId,
      recordStatus: record.status,
      note: 'clarify gate DISABLED by config/clarify-gate.json enabled:false; this mutating call would otherwise require an interpretation record'
    };
  }

  const decision = record.status === 'invalid' ? 'block-invalid-record' : 'block-no-record';
  return {
    decision,
    toolName,
    mutationCode,
    sessionId,
    configState: config.state,
    command: isShell ? snippet(command) : undefined,
    problems: record.status === 'invalid' ? record.problems.map(truncate) : undefined,
    message: refusalMessage(record, sessionId)
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
    return refuseIndeterminate('stdin-read', error);
  }

  let payload;
  try {
    if (!raw) throw new Error('stdin payload is empty');
    payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('stdin payload must be a JSON object');
    }
    if (typeof payload.tool_name !== 'string' || !payload.tool_name) {
      throw new Error('stdin payload must contain a non-empty tool_name');
    }
    if (!payload.tool_input || typeof payload.tool_input !== 'object' || Array.isArray(payload.tool_input)) {
      throw new Error('stdin payload must contain a tool_input object');
    }
  } catch (error) {
    return refuseIndeterminate('stdin-parse', error);
  }

  let outcome;
  try {
    outcome = evaluate(payload, process.env);
  } catch (error) {
    // Config and record validation failures normally return block decisions.
    // An unexpected evaluation failure is indeterminate and therefore also
    // refuses rather than becoming permission to mutate.
    return refuseIndeterminate('evaluate', error);
  }

  const { message, ...logFields } = outcome;
  appendLog({ rule: 'CLARIFY-GATE', ...logFields });
  if (outcome.decision.startsWith('block')) return block(message);
  return allow();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    refuseIndeterminate('main', error);
  }
}

module.exports = {
  ROOT,
  LOG_FILE,
  DEFAULT_CONFIG_FILE,
  DEFAULT_STATE_DIR,
  FALLBACK_SESSION_ID,
  AMBIGUITY_CHECK_VALUES,
  configFile,
  stateDirectory,
  loadGateConfig,
  sessionIdFrom,
  recordFile,
  validateRecordObject,
  loadInterpretationRecord,
  hasFileWriteRedirect,
  classifyShellMutation,
  nativeWriteTarget,
  isInsideClarifyState,
  referencesClarifyState,
  refusalMessage,
  evaluate,
  stripBom
};
