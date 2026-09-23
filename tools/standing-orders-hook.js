#!/usr/bin/env node
'use strict';

// Standing Orders PreToolUse hook -- the harness-level teeth for STANDING-ORDERS.md.
//
// STANDING-ORDERS.md is prose, discipline-checked. Its OUTWARD and BROWSER
// classes were both violated the same day they were written down (the McNair
// filename leak; the controller driving the browser itself the same hour a
// semantic layer was demoed to stop grep drift). Prose that nothing enforces
// is not a backstop -- it is documentation. This script is the enforcement:
// Claude Code and Codex invoke it as a PreToolUse hook before matching local
// tool calls, and it can hard-refuse the call (exit 2) before it ever runs.
// Codex reports its canonical shell tool name as Bash even when the host shell
// is PowerShell.
//
// Seven rules, each mapped to a STANDING-ORDERS.md class:
//   OUTWARD (class OUTWARD, rules 3-4)   -- refuse a provenance-leaking
//     filename/metadata, or an unmet owner-instruction gate, on an outward
//     upload/publish/send detected in the command.
//   BROWSER (class BROWSER, rule 1)      -- refuse the controller driving a
//     browser/CDP session itself; dispatched agents pass by marking their
//     command CONTROLLER_DELEGATED=1 (documented in STANDING-ORDERS.md).
//   LOCAL-WORK (class LOCAL-WORK, rule 3) -- refuse an explicitly visible
//     PowerShell/cmd/terminal launch or an interactive scheduled-task principal
//     unless the command carries the narrow VISIBLE-SHELL-ALLOWLIST exception.
//   LOCAL-WORK (class LOCAL-WORK, rule 0) -- advisory only: a symbol-shaped
//     grep/rg/findstr/Select-String call gets a one-line reminder to try the
//     code.* lookup ladder first. This cannot block (see rationale below);
//     it exists to make drift visible, not to stop it by force.
//   SYNC (class SYNC, rule 7)              -- refuse native Edit/Write/
//     NotebookEdit calls against repo.write_file's existing protected-file
//     set. BUILD-QUEUE closure stays available through a narrow receipt-first
//     transition; other non-control files require a target/hash-bound,
//     single-use authorization. The settings and hook files have no native
//     escape because they are the control plane for this rule.
//   DEPENDENCY ACCEPTANCE (R1162 item 7) -- refuse raw package-manager install
//     commands that bypass the protected package files, and hard-stop local
//     distribution commands while a new dependency is unclassified.
//   SYNC (class SYNC, rule 5)              -- advisory only: `git checkout
//     -- <path>`/`git checkout .`, `git restore <path>`, `git reset --hard`,
//     or `git clean -f` gets a reminder naming the specific remedy (restore by
//     file copy, commit before the risky op) instead of a generic caution.
//     This cannot block (R1162 near-miss, 2026-08-09); it exists to make the
//     hazard visible, not to stop it by force.
//
// Design constraints that shaped every decision below:
//   - FAIL OPEN. A hook bug must never brick the session. Every rule runs
//     inside its own try/catch; any internal error is logged and treated as
//     "no opinion", never as a block. The only way this script exits 2 is a
//     rule *positively* detecting the exact condition it targets.
//   - NEAR-ZERO FALSE POSITIVES. Ordinary local work (tests, npm scripts,
//     grepping markdown) must never be touched. Every matcher below is
//     deliberately narrow; when a heuristic can't tell, it stays quiet.
//   - FAST. No spawns, no network calls, only local fs reads bounded to a
//     handful of small files (the ledger, an mcp-call.js --input JSON, or one
//     explicitly targeted protected file). Typical run is well under 200ms.
//
// Schema verified against Claude's hook documentation on 2026-07-28 and the
// current Codex Hooks manual on 2026-08-02: PreToolUse receives
// {tool_name, tool_input, cwd, ...} on stdin; exit 2 blocks the call and shows
// stderr to the model/user as the refusal reason; exit 0 with a
// hookSpecificOutput.additionalContext JSON payload surfaces an advisory
// without blocking. Exit 1 is deliberately avoided here (fail-open uses exit
// 0 instead, so a hook malfunction never even shows as an error banner).

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const egressPreflight = require('../src/lib/egress-preflight');
const dependencyAcceptance = require('../src/lib/dependency-acceptance');

const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'logs', 'standing-orders-hook.log');
const MAX_MCP_INPUT_BYTES = 64 * 1024;
const MAX_LOG_FIELD_LENGTH = 400;
const LOCAL_WRITE_TOOL_RE = /^(Edit|Write|NotebookEdit)$/;
const SHELL_TOOL_RE = /^(Bash|PowerShell)$/;
const PACKAGE_INSTALL_COMMAND_RE = /(?:^|[;&|]\s*)(?:npm(?:\.cmd)?\s+(?:install|i|add)\b|pnpm(?:\.cmd)?\s+(?:install|add)\b|yarn(?:\.cmd)?\s+add\b|bun(?:\.exe)?\s+add\b)/i;
const DISTRIBUTION_COMMAND_RE = /(?:^|[;&|]\s*)(?:npm(?:\.cmd)?\s+(?:pack|publish)\b|pnpm(?:\.cmd)?\s+(?:pack|publish)\b|yarn(?:\.cmd)?\s+(?:pack|npm\s+publish)\b|bun(?:\.exe)?\s+publish\b)/i;
const BUILD_QUEUE_FILE = 'build-queue.md';
const PROTECTED_WRITE_AUTH_SCHEMA = 1;
const PROTECTED_WRITE_AUTH_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PROTECTED_WRITE_AUTH_DIR = path.join(ROOT, 'state', 'standing-orders-protected-write-authorizations');
// Test-only override so tests/standing-orders-hook.js can point assertGatesMet
// at a scratch ledger instead of reports/OWNER-REQUEST-LEDGER.json (the real,
// production ledger). Unset in every real invocation; defaults to the real
// ledger via egress-preflight's own default parameter.
const LEDGER_FILE_OVERRIDE = process.env.STANDING_ORDERS_HOOK_LEDGER_FILE || undefined;

// ---------------------------------------------------------------------------
// logging -- best-effort, append-only, never load-bearing for the decision.
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
// stdin / decision plumbing
// ---------------------------------------------------------------------------

// Live bug found in this session's own adversarial replay: Claude Code wrote
// a leading UTF-8 BOM (U+FEFF) on stdin for 14/107 (~13%) of this session's
// real PreToolUse invocations. JSON.parse('﻿{...}') throws (a BOM is not
// valid leading JSON whitespace), which previously landed in main()'s
// stdin-parse catch and fell through to failOpen() -- so this hook silently
// had no opinion on roughly one call in eight, with zero visible signal
// distinguishing that from "nothing to check here." Stripping the BOM before
// JSON.parse (the same fix Node's own JSON.parse callers use for BOM-prefixed
// files) closes the whole failure class at its source instead of only
// widening the parse's error handling.
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

function allow(additionalContext) {
  if (additionalContext) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext
      }
    }));
  }
  process.exit(0);
}

function block(message) {
  const text = message.endsWith('\n') ? message : `${message}\n`;
  process.stderr.write(text);
  process.exit(2);
}

function failOpen(context, error) {
  appendLog({ rule: 'internal-error', decision: 'fail-open', context, error: truncate(String((error && error.message) || error || '')) });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Rule 0: SYNC -- STANDING-ORDERS.md class SYNC, rule 7.
// Native Edit/Write/NotebookEdit coverage for repo.write_file's existing
// protected-file authority.  This module is loaded lazily inside the rule:
// if it is missing, cannot load, or cannot resolve a target, the surrounding
// main() catch MUST allow the tool call.  Do not "harden" this into fail-closed;
// a broken project hook must never wedge every editing session in the repo.
// Exact membership in a named set is not an intent heuristic, so a warning
// would only leave the writer optional. The narrow closure/authorization paths
// below preserve legitimate maintenance without weakening the default block.
// ---------------------------------------------------------------------------

function loadProtectedFileAuthority() {
  // Lazy by design: a load-time failure would exit before main() can apply the
  // required fail-open behavior.
  const authority = require('../src/lib/providers/repo-files');
  if (!(authority.WRITE_PROTECTED_FILES instanceof Set)
      || !(authority.WRITE_GUARD_CONTROL_FILES instanceof Set)
      || typeof authority.ROOT !== 'string') {
    throw new Error('repo-files write-protection authority is unavailable or malformed.');
  }
  return authority;
}

function localWritePathFromInput(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (toolName === 'NotebookEdit') return toolInput.notebook_path;
  if (toolName === 'Edit' || toolName === 'Write') return toolInput.file_path;
  return null;
}

function relativePathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('local write target did not resolve inside the repository.');
  }
  return relative.split(path.sep).join('/');
}

function resolveLocalWriteTarget(toolName, toolInput, cwd, authority = loadProtectedFileAuthority()) {
  const supplied = localWritePathFromInput(toolName, toolInput);
  if (typeof supplied !== 'string' || !supplied.trim()) return null;
  const base = typeof cwd === 'string' && cwd ? cwd : ROOT;
  const absolute = path.isAbsolute(supplied) ? path.resolve(supplied) : path.resolve(base, supplied);
  const authorityRoot = path.resolve(authority.ROOT);
  if (path.relative(authorityRoot, ROOT) !== '') throw new Error('hook root does not match repo-files authority root.');

  // Reuse the same canonical-path primitive as repo.write_file, but do not
  // reuse resolveInsideRepo's remote-tool directory exclusions. Native local
  // edits to ordinary files in those directories are outside this exact-file
  // rule; more importantly, an alias located there must still canonicalize to
  // (and block) a protected target rather than turning an expected exclusion
  // into a fail-open bypass.
  const { canonicalizeForContainment } = require('../src/lib/canonical-path');
  const canonicalRoot = fs.realpathSync.native(authorityRoot);
  const canonical = canonicalizeForContainment(absolute);
  const canonicalRelative = relativePathInside(canonicalRoot, canonical);
  // Preserve the caller's ordinary repo-relative spelling when it has one.
  // If an alternate absolute spelling is not lexically comparable but its
  // canonical target is inside the repo, use the canonical spelling instead
  // of turning that alias into an early fail-open escape.
  let relative;
  try { relative = relativePathInside(authorityRoot, absolute); }
  catch { relative = canonicalRelative; }
  const relativeLower = relative.toLowerCase();
  const canonicalLower = canonicalRelative.toLowerCase();
  const protectionKey = authority.WRITE_PROTECTED_FILES.has(relativeLower)
    ? relativeLower
    : authority.WRITE_PROTECTED_FILES.has(canonicalLower)
      ? canonicalLower
      : null;
  return {
    resolved: absolute,
    relative,
    canonicalRelative,
    relativeLower,
    canonicalLower,
    protectionKey
  };
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function protectedWriteAuthorizationDirectory(env = process.env) {
  // Tests need isolation from the real state/ marker directory.  The override
  // is deliberately test-only and must remain under this repo's ignored
  // scratch/ tree, so it cannot redirect production authorization state.
  const override = env && env.NODE_ENV === 'test' && env.STANDING_ORDERS_HOOK_TEST_AUTH_DIR;
  if (!override) return DEFAULT_PROTECTED_WRITE_AUTH_DIR;
  const resolved = path.resolve(override);
  const scratchRoot = path.join(ROOT, 'scratch');
  relativePathInside(scratchRoot, resolved);
  return resolved;
}

function protectedWriteAuthorizationFile(protectionKey, env = process.env) {
  const name = crypto.createHash('sha256').update(protectionKey).digest('hex');
  return path.join(protectedWriteAuthorizationDirectory(env), `${name}.json`);
}

function discardAuthorization(file) {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function consumeProtectedWriteAuthorization(target, env = process.env, now = Date.now()) {
  const file = protectedWriteAuthorizationFile(target.protectionKey, env);
  const claimed = `${file}.${process.pid}.${crypto.randomUUID()}.claimed`;
  try {
    // rename is the atomic single-consumer claim. Reading and then unlinking
    // the shared filename would let two concurrent hook processes both read
    // the same marker before either deletion won the race.
    fs.renameSync(file, claimed);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const raw = fs.readFileSync(claimed, 'utf8');
    let marker;
    try {
      marker = raw.length <= 4096 ? JSON.parse(raw) : null;
    } catch {
      marker = null;
    }
    const structurallyValid = marker
      && marker.schemaVersion === PROTECTED_WRITE_AUTH_SCHEMA
      && marker.target === target.protectionKey
      && typeof marker.reason === 'string'
      && marker.reason.trim()
      && marker.reason.trim().length <= MAX_LOG_FIELD_LENGTH
      && Number.isSafeInteger(marker.createdAtMs)
      && Number.isSafeInteger(marker.expiresAtMs)
      && marker.expiresAtMs > marker.createdAtMs
      && marker.createdAtMs <= now
      && marker.expiresAtMs >= now
      && marker.expiresAtMs - marker.createdAtMs <= PROTECTED_WRITE_AUTH_TTL_MS
      && typeof marker.expectedSha256 === 'string'
      && /^[a-f0-9]{64}$/.test(marker.expectedSha256);

    if (!structurallyValid) {
      appendLog({ rule: 'SYNC-WRITE-PROTECTION', decision: 'discard-invalid-authorization', target: target.protectionKey });
      return null;
    }
    if (sha256File(target.resolved) !== marker.expectedSha256) {
      appendLog({ rule: 'SYNC-WRITE-PROTECTION', decision: 'discard-stale-authorization', target: target.protectionKey });
      return null;
    }

    // The atomic rename consumed the shared marker BEFORE this allowance. A
    // failed native edit therefore needs a fresh authorization, and neither a
    // replay nor a concurrent hook can silently reuse the same marker.
    return marker;
  } finally {
    // If this unlink unexpectedly throws, that error intentionally reaches
    // main()'s fail-open catch per the repo-wide availability requirement.
    discardAuthorization(claimed);
  }
}

function writeProtectedWriteAuthorization(target, reason, env = process.env, now = Date.now()) {
  const directory = protectedWriteAuthorizationDirectory(env);
  const file = protectedWriteAuthorizationFile(target.protectionKey, env);
  const marker = {
    schemaVersion: PROTECTED_WRITE_AUTH_SCHEMA,
    target: target.protectionKey,
    expectedSha256: sha256File(target.resolved),
    reason: reason.trim(),
    createdAtMs: now,
    expiresAtMs: now + PROTECTED_WRITE_AUTH_TTL_MS
  };
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    discardAuthorization(file);
    fs.renameSync(temporary, file);
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
  appendLog({
    rule: 'SYNC-WRITE-PROTECTION',
    decision: 'authorization-created',
    target: target.protectionKey,
    reason: truncate(marker.reason),
    expiresAtMs: marker.expiresAtMs
  });
  return marker;
}

function argumentValue(argv, name) {
  const exactIndex = argv.indexOf(name);
  if (exactIndex !== -1) return argv[exactIndex + 1] || null;
  const prefix = `${name}=`;
  const joined = argv.find(value => typeof value === 'string' && value.startsWith(prefix));
  return joined ? joined.slice(prefix.length) : null;
}

function authorizeProtectedWrite(argv, env = process.env) {
  const targetPath = argumentValue(argv, '--path');
  const reason = argumentValue(argv, '--reason');
  if (!targetPath || !reason || !reason.trim()) {
    throw new Error('usage: standing-orders-hook.js authorize-protected-write --path <repo-file> --reason <reviewed reason>');
  }
  if (reason.trim().length > MAX_LOG_FIELD_LENGTH) {
    throw new Error(`authorization reason must be ${MAX_LOG_FIELD_LENGTH} characters or fewer.`);
  }
  const authority = loadProtectedFileAuthority();
  const target = resolveLocalWriteTarget('Edit', { file_path: targetPath }, process.cwd(), authority);
  if (!target || !target.protectionKey) throw new Error('the requested path is not in WRITE_PROTECTED_FILES.');
  if (!fs.existsSync(target.resolved)) throw new Error('the protected target does not exist; no authorization was created.');
  if (authority.WRITE_GUARD_CONTROL_FILES.has(target.protectionKey)) {
    throw new Error('the local-write guard control files have no native Edit/Write authorization escape.');
  }
  if (target.protectionKey === BUILD_QUEUE_FILE) {
    throw new Error('BUILD-QUEUE.md has no generic escape; add its Completed receipt first, then delete the retired phase body.');
  }
  return writeProtectedWriteAuthorization(target, reason, env);
}

function receiptIdForLine(line, writer) {
  const match = String(line || '').match(/^-\s+\*\*(Q[1-9]\d{0,2})\b/);
  if (!match) return null;
  const id = match[1];
  try {
    const next = writer.nextPhaseId(`${line}\n`);
    return next === `Q${Number.parseInt(id.slice(1), 10) + 1}` ? id : null;
  } catch (error) {
    return id === 'Q999' && error && error.code === 'QUEUE_PHASE_LIMIT' ? id : null;
  }
}

function completedSectionRange(lines) {
  const start = lines.findIndex(line => /^##\s+Completed\b/i.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function completedReceiptIds(markdown, writer) {
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const range = completedSectionRange(lines);
  const ids = new Set();
  if (!range) return ids;
  for (let index = range.start + 1; index < range.end; index += 1) {
    const id = receiptIdForLine(lines[index], writer);
    if (id) ids.add(id);
  }
  return ids;
}

function singleInsertedLine(before, after) {
  const beforeLines = String(before).replace(/\r\n/g, '\n').split('\n');
  const afterLines = String(after).replace(/\r\n/g, '\n').split('\n');
  if (afterLines.length !== beforeLines.length + 1) return null;
  let index = 0;
  while (index < beforeLines.length && beforeLines[index] === afterLines[index]) index += 1;
  for (let cursor = index; cursor < beforeLines.length; cursor += 1) {
    if (beforeLines[cursor] !== afterLines[cursor + 1]) return null;
  }
  return { line: afterLines[index], index, afterLines };
}

function simulateNativeEdit(current, toolInput) {
  const oldString = toolInput && toolInput.old_string;
  const newString = toolInput && toolInput.new_string;
  if (typeof oldString !== 'string' || !oldString || typeof newString !== 'string') {
    throw new Error('native Edit input could not be resolved into an exact before/after candidate.');
  }
  const occurrences = current.split(oldString).length - 1;
  if (toolInput.replace_all === true) {
    if (occurrences < 1) throw new Error('native Edit old_string does not occur in the target.');
    return current.split(oldString).join(newString);
  }
  if (occurrences !== 1) throw new Error('native Edit old_string is absent or ambiguous in the target.');
  return current.replace(oldString, newString);
}

function isSanctionedBuildQueueEdit(before, after, toolInput, writer = require('../src/lib/build-queue-writer')) {
  let beforePhases;
  let afterPhases;
  try {
    beforePhases = writer.parseStrictQueue(before);
    afterPhases = writer.parseStrictQueue(after);
  } catch {
    // A malformed proposed queue is a positive structural violation, not a
    // hook malfunction. Return false so it blocks; reserve fail-open for an
    // actual rule/runtime error that reaches main().
    return false;
  }
  const beforeIds = new Set(beforePhases.map(phase => phase.id));
  const afterIds = new Set(afterPhases.map(phase => phase.id));
  const added = [...afterIds].filter(id => !beforeIds.has(id));
  const removed = [...beforeIds].filter(id => !afterIds.has(id));
  if (added.length || removed.length > 1) return false;

  const beforeReceipts = completedReceiptIds(before, writer);
  const afterReceipts = completedReceiptIds(after, writer);

  // Step 1 of the safe close: insert exactly one writer-recognized receipt
  // under ## Completed while the live phase still exists.  Reserving the id
  // first eliminates the dangerous gap in which the allocator could reuse it.
  if (removed.length === 0) {
    const insertion = singleInsertedLine(before, after);
    if (!insertion) return false;
    const id = receiptIdForLine(insertion.line, writer);
    const range = completedSectionRange(insertion.afterLines);
    return Boolean(id
      && beforeIds.has(id)
      && !beforeReceipts.has(id)
      && afterReceipts.has(id)
      && range
      && insertion.index > range.start
      && insertion.index < range.end);
  }

  // Step 2: delete exactly one live phase only after its receipt already
  // reserves the id.  Keep this Edit-only and narrow: one Q heading in the
  // removed text, a real Status line, and only separators/whitespace added.
  const retiredId = removed[0];
  const oldString = toolInput && toolInput.old_string;
  const newString = toolInput && toolInput.new_string;
  const removedSectionHeadings = typeof oldString === 'string'
    ? [...oldString.matchAll(/^##\s+.+$/gm)].map(match => match[0])
    : [];
  const removedHeadings = removedSectionHeadings
    .map(heading => heading.match(/^##\s+(Q[1-9]\d{0,2})\s+.+$/))
    .filter(Boolean)
    .map(match => match[1]);
  const replacementIsOnlyBoundary = typeof newString === 'string'
    && newString.replace(/(?:\r?\n|[\t ]|---)/g, '') === '';

  // The removed text must cover the whole semantic phase section, not merely
  // its heading/status lines, and must not cross into another level-two
  // section. Otherwise a superficially valid deletion could strand orphaned
  // instructions or erase a historical receipt/slice marker that also keeps
  // an id reserved.
  const occurrence = typeof oldString === 'string' ? before.indexOf(oldString) : -1;
  const headingPattern = new RegExp(`^##\\s+${retiredId}\\s+.+$`, 'm');
  const headingMatch = before.match(headingPattern);
  const headingStart = headingMatch ? headingMatch.index : -1;
  const headingEnd = headingMatch ? headingStart + headingMatch[0].length : -1;
  const nextHeadingRelative = headingEnd >= 0 ? before.slice(headingEnd).search(/^##\s+.+$/m) : -1;
  const sectionEnd = nextHeadingRelative === -1 ? before.length : headingEnd + nextHeadingRelative;
  const removalEnd = occurrence === -1 ? -1 : occurrence + oldString.length;
  const boundaryOnly = value => String(value).replace(/(?:\r?\n|[\t ]|---)/g, '') === '';
  const removesWholePhaseOnly = occurrence !== -1
    && headingStart !== -1
    && occurrence <= headingStart
    && removalEnd <= sectionEnd
    && boundaryOnly(before.slice(occurrence, headingStart))
    && boundaryOnly(before.slice(removalEnd, sectionEnd));
  const removesAllocatorMarker = typeof oldString === 'string'
    && /^(?:-\s+\*\*Q|<!--\s*build-queue-slice:v1\s+phase=)/m.test(oldString);
  return beforeReceipts.has(retiredId)
    && afterReceipts.has(retiredId)
    && removedSectionHeadings.length === 1
    && removedHeadings.length === 1
    && removedHeadings[0] === retiredId
    && /^\*\*Status:\*\*/m.test(oldString)
    && replacementIsOnlyBoundary
    && removesWholePhaseOnly
    && !removesAllocatorMarker;
}

function protectedWriteMessage(target, authority) {
  const membership = target.relativeLower === target.canonicalLower
    ? `${target.relative} is named by src/lib/providers/repo-files.js WRITE_PROTECTED_FILES`
    : `${target.relative} resolves to protected canonical target ${target.canonicalRelative} in src/lib/providers/repo-files.js WRITE_PROTECTED_FILES`;
  const currentNode = /\s/.test(process.execPath) ? `"${process.execPath}"` : process.execPath;
  const preamble = [
    'STANDING-ORDERS.md Class SYNC, rule 7: "Never hand-edit a file that has a writer."',
    `${membership}; this native write is blocked before execution.`
  ];
  if (authority.WRITE_GUARD_CONTROL_FILES.has(target.protectionKey)) {
    return preamble.concat([
      'This file defines or runs the guard itself, so native Edit/Write/NotebookEdit has no escape for it.',
      'Change it only through a separately reviewed maintenance path, then rerun the guard contract tests.'
    ]).join('\n');
  }
  if (target.protectionKey === BUILD_QUEUE_FILE) {
    return preamble.concat([
      'Use src/lib/build-queue-writer.js to create OPEN phases.',
      'To close a phase without opening an id-reuse window: first add its one-line receipt under ## Completed, then delete that phase body. Only those two structural Edits are allowed.'
    ]).join('\n');
  }
  return preamble.concat([
    'For a reviewed workflow with no dedicated writer, create one target/hash-bound, single-use marker, then retry once:',
    `  ${currentNode} tools/standing-orders-hook.js authorize-protected-write --path "${target.relative}" --reason "<owner directive or reviewed maintenance reason>"`,
    'The authorization expires after five minutes and both creation and consumption are logged.'
  ]).join('\n');
}

function checkProtectedWrite(toolName, toolInput, cwd, env = process.env) {
  if (SHELL_TOOL_RE.test(String(toolName))) {
    const command = toolInput && typeof toolInput.command === 'string' ? toolInput.command : '';
    if (!PACKAGE_INSTALL_COMMAND_RE.test(command)) return null;
    appendLog({ rule: 'DEPENDENCY-ACCEPTANCE', decision: 'block-direct-package-install', toolName });
    return [
      'R1162 item 7: direct package-manager installs bypass protected package.json/lockfile writes and are blocked.',
      'Use the capture-first install path so every new dependency is classified:',
      '  node tools/dependency-acceptance.js install --name <pkg> --kind <crypto|protocol|other> --license <SPDX> --reuse-type <type>',
      'For kind=other, omit --license and --reuse-type.'
    ].join('\n');
  }
  if (!LOCAL_WRITE_TOOL_RE.test(String(toolName))) return null;
  const authority = loadProtectedFileAuthority();
  const target = resolveLocalWriteTarget(toolName, toolInput, cwd, authority);
  if (!target || !target.protectionKey) return null;

  // The owner explicitly requires a missing file to fail open.  This is
  // counter-intuitive for a Write/create call, but availability wins here;
  // an absent target or any fs/resolution error must not wedge the session.
  if (!fs.existsSync(target.resolved)) throw new Error(`protected target is missing: ${target.relative}`);

  if (authority.WRITE_GUARD_CONTROL_FILES.has(target.protectionKey)) {
    appendLog({ rule: 'SYNC-WRITE-PROTECTION', decision: 'block-self-protection', toolName, target: target.protectionKey });
    return protectedWriteMessage(target, authority);
  }

  if (target.protectionKey === BUILD_QUEUE_FILE) {
    if (toolName === 'Edit') {
      const before = fs.readFileSync(target.resolved, 'utf8');
      const after = simulateNativeEdit(before, toolInput);
      if (isSanctionedBuildQueueEdit(before, after, toolInput)) {
        appendLog({ rule: 'SYNC-WRITE-PROTECTION', decision: 'allow-build-queue-close', toolName, target: target.protectionKey });
        return null;
      }
    }
    appendLog({ rule: 'SYNC-WRITE-PROTECTION', decision: 'block', toolName, target: target.protectionKey });
    return protectedWriteMessage(target, authority);
  }

  const authorization = consumeProtectedWriteAuthorization(target, env);
  if (authorization) {
    appendLog({
      rule: 'SYNC-WRITE-PROTECTION',
      decision: 'allow-authorized-once',
      toolName,
      target: target.protectionKey,
      reason: truncate(authorization.reason)
    });
    return null;
  }

  appendLog({ rule: 'SYNC-WRITE-PROTECTION', decision: 'block', toolName, target: target.protectionKey });
  return protectedWriteMessage(target, authority);
}

function checkDependencyDistribution(command, options = {}) {
  if (typeof command !== 'string' || !DISTRIBUTION_COMMAND_RE.test(command)) return null;
  try {
    dependencyAcceptance.assertEventAllowed({
      event: 'distribution',
      registryFile: options.registryFile,
      packageFile: options.packageFile,
      fsApi: options.fsApi
    });
    appendLog({ rule: 'DEPENDENCY-ACCEPTANCE', decision: 'allow-distribution' });
    return null;
  } catch (error) {
    appendLog({ rule: 'DEPENDENCY-ACCEPTANCE', decision: 'block-distribution', code: error && error.code });
    return [
      'R1162 item 7: distribution is blocked by the crypto/protocol dependency acceptance gate.',
      String(error && error.message || error),
      'Classify the dependency with tools/dependency-acceptance.js, then retry.'
    ].join('\n');
  }
}

// ---------------------------------------------------------------------------
// Rule 1: OUTWARD -- STANDING-ORDERS.md class OUTWARD, rules 3 and 4.
// ---------------------------------------------------------------------------

// Only tools shaped like an egress verb are candidates. This intentionally
// covers *future* outward tools (cws.publish, ig.publish, anything ending in
// send/upload/publish/submit) without hardcoding a name list that goes stale.
function isOutwardToolName(tool) {
  return typeof tool === 'string' && /\.(send|upload|publish|submit)$/i.test(tool);
}

function extractFlagValue(command, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = command.match(new RegExp(`${escaped}\\s+"?([^"\\s]+)"?`));
  return match ? match[1] : null;
}

function extractRequestIdFromCommand(command) {
  const match = command.match(/--request-id[=\s]+"?([A-Za-z0-9_.:-]+)"?/i)
    || command.match(/\bTOOLSENABLED_LEDGER_REQUEST_ID=([A-Za-z0-9_.:-]+)/)
    || command.match(/\bREQUEST_ID=([A-Za-z0-9_.:-]+)/);
  return match ? match[1] : null;
}

// Everything an agent needs to drive a real outward call in this repo goes
// through `node tools/mcp-call.js --input <request.json>` (the checked-in
// one-shot MCP client -- see tools/mcp-call.js), because that is the only
// route that keeps the normal allowlist/actor/policy/audit path in force.
// Reading that JSON is therefore the highest-signal, lowest-false-positive
// way to see the real tool name and arguments before the call leaves.
function findMcpCallOutwardCandidate(command, cwd) {
  if (!/\bmcp-call\.js\b/i.test(command)) return null;
  const inputPath = extractFlagValue(command, '--input');
  if (!inputPath) return null;
  const base = typeof cwd === 'string' && cwd ? cwd : ROOT;
  const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(base, inputPath);
  // Stay inside the repo; mcp-call.js enforces this itself too, but a hook
  // that reads outside its own tree on a whim is a liability, not a check.
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) return null;
  if (!fs.existsSync(resolved)) return null;
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MCP_INPUT_BYTES) return null;
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !isOutwardToolName(parsed.tool)) return null;
  const args = parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {};
  const filePaths = [];
  for (const key of ['filePath', 'path', 'file']) {
    if (typeof args[key] === 'string') filePaths.push(args[key]);
  }
  if (Array.isArray(args.paths)) {
    for (const value of args.paths) if (typeof value === 'string') filePaths.push(value);
  }
  return {
    source: `mcp-call:${parsed.tool}`,
    filePaths,
    metadata: args.metadata && typeof args.metadata === 'object' ? args.metadata : null,
    requestId: typeof args.requestId === 'string' ? args.requestId : null
  };
}

function hasExternalHost(command) {
  const re = /https?:\/\/([^/\s"']+)/gi;
  let match;
  while ((match = re.exec(command))) {
    const host = match[1].split(':')[0].toLowerCase();
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && !host.endsWith('.local')) return true;
  }
  return false;
}

// Token-based, not a single regex: a real filename ("McNair Draft 7.28
// (agent-reviewed).pdf") contains spaces, and the exact incident this hook
// exists to catch would slip past any regex that stops capturing at the
// first space. tokenize()/unquote() (defined below) treat a whole quoted
// argument as one token, so a quoted path with spaces survives intact.
function extractCurlFilePaths(command) {
  const tokens = tokenize(command).map(unquote);
  const paths = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '-F' || token === '--form') {
      const value = tokens[index + 1];
      if (value && value.includes('=@')) paths.push(value.slice(value.indexOf('=@') + 2));
    } else if (token.includes('=@') && (token.startsWith('-F') || token.startsWith('--form'))) {
      paths.push(token.slice(token.indexOf('=@') + 2)); // glued form, e.g. -Ffield=@path
    } else if (token === '--upload-file' || token === '-T') {
      const value = tokens[index + 1];
      if (value) paths.push(value);
    }
  }
  return paths;
}

function extractPowerShellUploadFilePaths(command) {
  const tokens = tokenize(command).map(unquote);
  const paths = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (/^-InFile$/i.test(tokens[index]) && tokens[index + 1]) paths.push(tokens[index + 1]);
  }
  return paths;
}

// A second, narrower candidate: a raw curl / Invoke-WebRequest / Invoke-RestMethod
// call that writes a local file to a non-local host. This is deliberately
// conservative (requires POST/PUT semantics, an external host, AND an
// extractable file argument) so it does not fire on ordinary GETs or JSON-body
// posts that carry no file.
function findDirectUploadCandidate(command) {
  const isCurl = /\bcurl(\.exe)?\b/i.test(command);
  const isPowerShellWebCall = /Invoke-(WebRequest|RestMethod)\b/i.test(command);
  if (!isCurl && !isPowerShellWebCall) return null;
  const hasWriteMethod = /(-X\s*POST|-X\s*PUT|--request\s+(POST|PUT)|-Method\s+['"]?(Post|Put)['"]?)/i.test(command);
  if (isPowerShellWebCall && !hasWriteMethod) return null;
  if (!hasExternalHost(command)) return null;
  const filePaths = [...extractCurlFilePaths(command), ...extractPowerShellUploadFilePaths(command)];
  if (filePaths.length === 0) return null;
  return { source: 'direct-upload-cli', filePaths, metadata: null, requestId: null };
}

function findOutwardCandidate(command, cwd) {
  return findMcpCallOutwardCandidate(command, cwd) || findDirectUploadCandidate(command);
}

function checkOutward(command, cwd, env) {
  const candidate = findOutwardCandidate(command, cwd);
  if (!candidate) return null;

  const findings = [];
  for (const filePath of candidate.filePaths) findings.push(...egressPreflight.inspectFilename(filePath));
  if (candidate.metadata) findings.push(...egressPreflight.inspectMetadata(candidate.metadata));
  const blocking = findings.filter(finding => finding.severity === 'block');

  let gatesMessage = null;
  const requestId = candidate.requestId
    || extractRequestIdFromCommand(command)
    || (env && (env.TOOLSENABLED_LEDGER_REQUEST_ID || env.REQUEST_ID))
    || null;
  if (requestId) {
    try {
      egressPreflight.assertGatesMet(requestId, LEDGER_FILE_OVERRIDE);
    } catch (error) {
      if (error && error.code === 'EGRESS_GATES_UNMET') {
        gatesMessage = error.message;
      } else {
        // Unknown request id, unreadable ledger, etc: this is a heuristic
        // hook layered in front of the real fix (wiring assertGatesMet into
        // the provider code itself), not the only line of defense. Log and
        // fail open rather than block on an id this hook cannot resolve.
        appendLog({ rule: 'OUTWARD', decision: 'fail-open-gates', requestId, error: truncate(String(error && error.message || error)) });
      }
    }
  }

  appendLog({
    rule: 'OUTWARD',
    source: candidate.source,
    decision: blocking.length || gatesMessage ? 'block' : 'allow',
    filePaths: candidate.filePaths.map(truncate),
    requestId,
    findingCodes: findings.map(f => f.code)
  });

  if (blocking.length) {
    return [
      'STANDING-ORDERS.md Class OUTWARD, rule 3: "No provenance leaks: no agent/AI/model markers in filename OR document metadata."',
      `egress-preflight BLOCKED this outward call: ${blocking.map(f => `${f.code} (${f.where}: "${f.matched}")`).join('; ')}.`,
      'Rename the artifact (and/or strip document metadata) before it leaves this machine, then retry.'
    ].join('\n');
  }
  if (gatesMessage) {
    return [
      'STANDING-ORDERS.md Class OUTWARD, rule 4: "Owner-instruction gates... A deadline does not override a gate."',
      gatesMessage
    ].join('\n');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 2: BROWSER -- STANDING-ORDERS.md class BROWSER, rule 1.
// ---------------------------------------------------------------------------

// These name actual browser-driving MECHANISMS. A bare `/\bplaywright\b/` used
// to live here and was removed: merely CONTAINING the word is not evidence of
// driving a session, and it false-positived hard in practice -- it blocked the
// controller from reading a file whose name contains it, and then from writing
// a ledger entry whose TEXT mentions it. An over-broad rule that fires on
// prose trains its reader to reach for the bypass marker, which is worse for
// the standing order than a rule with a narrower, honest surface. Every real
// driving mechanism is still covered specifically below, including invoking
// the gateway or the playwright CLI as a command.
const BROWSER_DRIVING_PATTERNS = [
  /connectOverCDP/i,
  /cdp-drive/i,
  /--remote-debugging-port/i,
  /\bplaywright-call\.js\b/i,
  /\bplaywright-mcp\b/i,
  // playwright invoked AS a command (start of line or after a shell operator),
  // rather than appearing as text somewhere inside one.
  /(^|[;&|]\s*|\|\|\s*|&&\s*)(npx\s+|pnpm\s+dlx\s+|yarn\s+)?playwright\b/i,
  // executing a playwright-ish script file, e.g. `node src/playwright-gateway.js`
  /\bnode(\.exe)?\s+[^\s;|&]*playwright[\w-]*\.(js|mjs|cjs)\b/i,
  /\bchrome(\.exe)?\s+--remote-debugging/i,
  /\bmsedge(\.exe)?\s+--remote-debugging/i
];

// Carve-outs mirroring LOCAL-WORK rule 0's own prose/test carve-out: running
// this repo's own test suite (which exercises mocked/local Playwright
// fixtures, not the owner's authenticated browser) is ordinary local work,
// not "driving a browser". Package-manager install/download commands are not
// driving a session either.
function isBrowserTestOrToolingInvocation(command) {
  if (/\btests[\\/]/i.test(command) || /\btest:[a-z-]+\b/i.test(command)) return true;
  if (/^\s*(npm|npx|yarn|pnpm)\s+(install|ci|i)\b/i.test(command)) return true;
  if (/\bnpx\s+playwright\s+install\b/i.test(command)) return true;
  return false;
}

function isBrowserDriving(command) {
  if (isBrowserTestOrToolingInvocation(command)) return false;
  return BROWSER_DRIVING_PATTERNS.some(pattern => pattern.test(command));
}

// The delegation signal STANDING-ORDERS.md documents: a dispatched agent
// marks its own command CONTROLLER_DELEGATED=1 (inline env assignment, bash
// or powershell form) so the hook can tell "controller driving the browser
// itself" apart from "a dispatched agent doing exactly what it was sent to
// do". This is not cryptographic proof of delegation -- like the rest of the
// coordinator trust boundary, it is an auditable, visible signal, not an
// unforgeable one; evasion is still logged either way (see below).
function hasControllerDelegation(command, env) {
  if (env && String(env.CONTROLLER_DELEGATED) === '1') return true;
  if (/(^|[\s;&|])CONTROLLER_DELEGATED\s*=\s*1\b/.test(command)) return true;
  if (/\$env:CONTROLLER_DELEGATED\s*=\s*["']?1["']?/i.test(command)) return true;
  return false;
}

// RETIRED AS A BLOCK on 2026-08-10, by the owner, in his own words: "literally
// you can drive the browsers as needed that was a thread specific rule and
// needs to be cleaned up."
//
// The original order ("do not Playwright or web-browse yourself -- send
// agents", R05 and twice on 2026-07-28) was scoped to a specific thread and
// was being applied globally and forever, which is how it ended up blocking
// the controller from doing work the owner now explicitly wants done directly
// -- including signing in AS A USER through a real browser, which the owner
// requires be done "by being a user not by injecting code but by playwriting
// and such". A rule that forbids the very thing now being demanded is not a
// safety rail, it is stale prose with an enforcement hook attached.
//
// WHAT IS DELIBERATELY KEPT:
//   * The LOGGING. Every browser-driving command is still recorded to
//     logs/standing-orders-hook.log, so the surface stays auditable even
//     though it is no longer refused. Retiring a rule is not a reason to go
//     blind to the thing it watched.
//   * STANDING-ORDERS.md class BROWSER *rule 2* -- never copy the owned
//     browser profile, cookies, or CDP into a container -- is UNTOUCHED and
//     still enforced by src/lib/action-guards.js findBrowserBoundaryViolation().
//     It stands on ordinary credential hygiene: the owner's live authenticated
//     sessions must not be duplicated into a sandbox. (Its original write-up
//     leaned on the Duo remembered-device state; the owner has since said Duo
//     is not shipping, so that is no longer the reason to keep it.) Rule 1 and
//     rule 2 solved different problems and only rule 1 was thread-scoped.
//
// CONTROLLER_DELEGATED is still honoured and still recorded distinctly, so
// dispatched agents that already mark their commands keep working unchanged
// and the log can still tell the two callers apart.
function checkBrowser(command, env) {
  if (!isBrowserDriving(command)) return null;
  const delegated = hasControllerDelegation(command, env);
  appendLog({
    rule: 'BROWSER',
    decision: delegated ? 'allow-delegated' : 'allow-rule1-retired',
    command: snippet(command)
  });
  return null;
}

// ---------------------------------------------------------------------------
// Rule 3: LOCAL-WORK shell quietness -- STANDING-ORDERS.md class LOCAL-WORK,
// rule 3.  This is intentionally narrow: it only blocks a command that is
// explicitly launching a console shell visibly, or explicitly registers an
// interactive scheduled-task principal.  It does not touch ordinary commands,
// visible owner-requested applications, or source-code reads that mention the
// relevant words.
// ---------------------------------------------------------------------------

const VISIBLE_SHELL_ALLOWLIST = 'VISIBLE-SHELL-ALLOWLIST';

function hasVisibleShellAllowance(command) {
  return new RegExp(`\\b${VISIBLE_SHELL_ALLOWLIST}\\b`, 'i').test(String(command || ''));
}

function usesStartProcessForConsoleShell(command) {
  return /\bStart-Process\b[^\r\n;]{0,360}\b(?:powershell|pwsh|cmd)(?:\.exe)?\b/i.test(command);
}

function usesDirectConsoleShell(command) {
  // Only match a process command at the beginning of a command segment.  This
  // avoids treating prose, paths, and quoted child-process examples as a launch.
  //
  // Two bypasses this closes, both found by review and both the shape this
  // repo's own launchers use: a fully-qualified QUOTED interpreter path ends
  // with `"` immediately after `.exe`, so a `(?=\s|$)` lookahead alone never
  // fires; and PowerShell's `start` alias for Start-Process was not a
  // recognised launch token at all.
  return /(?:^\s*|[;&|]\s*)(?:&\s*)?(?:start\s+)?(?:(?:["'][^"']*[\\/])?)(?:powershell|pwsh|cmd)(?:\.exe)?(?=["'\s]|$)/i.test(command);
}

function hasHiddenConsoleBoundary(command) {
  return /(?:-WindowStyle\s+Hidden|\bCreateNoWindow\s*=\s*\$true|\bwindowsHide\s*:\s*true)/i.test(command);
}

function registersInteractiveScheduledTask(command) {
  return /\bNew-ScheduledTaskPrincipal\b[^\r\n;]{0,360}-LogonType\s+Interactive\b/i.test(command);
}

function checkConsoleVisibility(command) {
  const text = String(command || '');
  const interactiveTask = registersInteractiveScheduledTask(text);
  const shellLaunch = usesStartProcessForConsoleShell(text) || usesDirectConsoleShell(text);
  if (!interactiveTask && !shellLaunch) return null;

  const exception = hasVisibleShellAllowance(text);
  if (interactiveTask) {
    appendLog({ rule: 'LOCAL-WORK-CONSOLE', decision: exception ? 'allow-exception' : 'block-interactive-task', command: snippet(text) });
    if (exception) return null;
    return [
      'STANDING-ORDERS.md Class LOCAL-WORK, rule 3: scheduled tasks must be non-interactive (S4U where available).',
      'This command explicitly creates an Interactive scheduled-task principal, which can put a console on the owner\'s desktop.',
      `Use a non-interactive principal instead. If a visible desktop session is truly required, add ${VISIBLE_SHELL_ALLOWLIST} and the owner-facing reason.`
    ].join('\n');
  }

  if (hasHiddenConsoleBoundary(text)) {
    appendLog({ rule: 'LOCAL-WORK-CONSOLE', decision: 'allow-hidden', command: snippet(text) });
    return null;
  }
  appendLog({ rule: 'LOCAL-WORK-CONSOLE', decision: exception ? 'allow-exception' : 'block-visible-shell', command: snippet(text) });
  if (exception) return null;
  return [
    'STANDING-ORDERS.md Class LOCAL-WORK, rule 3: console windows must never flash.',
    'This command appears to launch PowerShell, cmd, or another terminal without a hidden native boundary.',
    'Use Node `{ windowsHide: true, shell: false }` or PowerShell ProcessStartInfo with CreateNoWindow + hidden window style.',
    `A visible shell is allowed only for a genuinely necessary owner-facing interaction; add ${VISIBLE_SHELL_ALLOWLIST} and the reason when that exception applies.`
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Rule 4: LOCAL-WORK advisory -- STANDING-ORDERS.md class LOCAL-WORK, rule 0.
// ---------------------------------------------------------------------------

const GREP_TOOL_RE = /^(grep|rg|ripgrep|findstr)$/i;

function tokenize(command) {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
}

function unquote(token) {
  if (token.length >= 2 && ((token[0] === '"' && token.endsWith('"')) || (token[0] === "'" && token.endsWith("'")))) {
    return token.slice(1, -1);
  }
  return token;
}

function extractGrepLikePattern(command) {
  const tokens = tokenize(command);
  const toolIndex = tokens.findIndex(token => GREP_TOOL_RE.test(unquote(token)));
  if (toolIndex === -1) return null;
  for (let index = toolIndex + 1; index < tokens.length; index += 1) {
    const raw = unquote(tokens[index]);
    if (raw.startsWith('-')) continue; // skip flags; a heuristic, not a full arg parser
    return raw;
  }
  return null;
}

function extractSelectStringPattern(command) {
  if (!/Select-String/i.test(command)) return null;
  const match = command.match(/-Pattern\s+"?'?([^"'\s]+)"?'?/i);
  if (match) return match[1];
  // Positional: `Select-String "pattern" file` or via pipeline `... | Select-String "pattern"`
  const tokens = tokenize(command);
  const index = tokens.findIndex(token => /Select-String/i.test(token));
  if (index === -1) return null;
  for (let i = index + 1; i < tokens.length; i += 1) {
    const raw = unquote(tokens[i]);
    if (raw.startsWith('-')) continue;
    return raw;
  }
  return null;
}

// camelCase or snake_case identifier -- the shape of a real symbol lookup,
// not a plain English word (STANDING-ORDERS 0's own "prose, markdown,
// config, log" carve-out is respected by requiring this shape).
function isSingleTokenSymbolShaped(term) {
  if (typeof term !== 'string' || term.length < 3) return false;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(term)) return false;
  const camel = /[a-z][A-Z]/.test(term);
  const snake = term.includes('_') && term.length > 1;
  return camel || snake;
}

// Live bug found in this session's own adversarial replay: a quoted
// multi-word grep pattern (`grep -n 'function assertGatesMet' file.js`) is
// unquoted whole by extractGrepLikePattern()/extractSelectStringPattern()
// below into one string containing a space, and the single-token regex above
// rejects anything with a space outright -- so the exact replay command got
// no lookup-ladder reminder. A multi-word phrase is still worth the reminder
// if at least one of its words looks like a real identifier; this keeps the
// single-word contract (a plain English word like "error" stays silent)
// while no longer dropping every quoted phrase that contains one.
function isSymbolShaped(term) {
  if (typeof term !== 'string') return false;
  const trimmed = term.trim();
  if (!trimmed) return false;
  if (isSingleTokenSymbolShaped(trimmed)) return true;
  const words = trimmed.split(/\s+/);
  return words.length > 1 && words.some(isSingleTokenSymbolShaped);
}

// If the command explicitly names prose/config/log targets (and no code
// extension), this is exactly the carve-out LOCAL-WORK rule 0 states --
// stay silent rather than nag.
function targetsProseOnly(command) {
  const proseExt = /\.(md|markdown|txt|log|jsonl?|ya?ml|csv)\b/i.test(command);
  const codeExt = /\.(js|ts|jsx|tsx|py|ps1|cjs|mjs|json5)\b/i.test(command);
  return proseExt && !codeExt;
}

// The policy hook is a shipped engine component, while a customer's broader
// standing-order catalogue is optional local state.  This narrow advisory
// therefore recognizes only the command forms it can parse itself; it must not
// disappear merely because no private standing-orders mirror is installed.
function checkLocalWork(command, tool) {
  if (targetsProseOnly(command)) return null;
  if (!SHELL_TOOL_RE.test(String(tool || ''))) return null;
  const pattern = extractGrepLikePattern(command) || extractSelectStringPattern(command);
  if (!isSymbolShaped(pattern)) return null;
  return [
    'LOCAL-WORK lookup ladder reminder (STANDING-ORDERS.md class LOCAL-WORK, rule 0):',
    `"${pattern}" looks like a symbol lookup. Try code.* first (goto_definition, find_references, document_symbols,`,
    'workspace_symbols, diagnostics, hover), then AST, then git history, then ripgrep/grep as the last resort.',
    'Do not assume document_symbols saves bytes: dense files can return a larger outline than the source, so inspect its measurement before expanding it.',
    'If code.* is unreachable or absent in this session, report that limitation instead of silently falling back to grep; otherwise use the ladder above.',
    'This is advisory only and does not block the command.'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Rule 5: SYNC advisory -- destructive git operations.
// STANDING-ORDERS.md Class SYNC, rule 5: "Untracked files, uncommitted edits,
// and commits on no remote are all single-copy work." `git checkout --`/
// `git restore`, `git reset --hard`, and `git clean -f` destroy exactly that
// single-copy work -- instantly, silently, with no confirmation and no undo.
// R1162 near-miss (2026-08-09): a lane restoring a file mid red-cycle
// destroyed its own uncommitted seam and guard with `git checkout --`, a
// concurrent agent ran `git checkout -- package.json` on the shared canonical
// tree and reverted another lane's in-flight edit, and a third agent ran a
// hard reset. Every one of those cost nothing only because the work happened
// to already be committed.
//
// This mirrors Rule 4 exactly and for the same reason: it cannot reliably
// tell a genuinely destructive invocation from a rare, deliberately unusual
// one (a fixture, a doc example, a dry run muddled into a combined flag), so
// it stays an advisory, never a block. No deny path here, ever -- match Rule
// 4's shape: a function returning a joined string that ends by saying so.
// ---------------------------------------------------------------------------

// `git checkout -- <path>` / `git checkout .`: the `--` pathspec separator or
// a lone `.` (checkout the whole cwd) as a standalone, whitespace-bounded
// token. Deliberately does NOT match `git checkout <branch>`, `git checkout
// -b`, or a dotted name like `git checkout .github` (no whitespace precedes
// the rest of that token, so the `(?=\s|$)` lookahead fails).
const GIT_CHECKOUT_PATH_RE = /\bgit(?:\.exe)?\s+checkout\b[^\r\n;&|]{0,200}?(?<=\s)(?:--(?=\s|$)|\.(?=\s|$))/i;

// `git restore <path>`: same working-tree-overwrite hazard as `git checkout
// --`, newer spelling. `git restore --help`/`-h` is excluded (prints usage,
// touches nothing).
const GIT_RESTORE_RE = /\bgit(?:\.exe)?\s+restore\b(?!\s*(?:--help|-h)\b)/i;

// `git reset --hard`: requires the literal `--hard` flag, whitespace-bounded,
// somewhere after `git reset`. Plain `git reset`, `git reset --soft`, and
// `git reset --mixed` do not contain that substring and are left alone.
const GIT_RESET_HARD_RE = /\bgit(?:\.exe)?\s+reset\b[^\r\n;&|]{0,200}?(?<=\s)--hard\b/i;

// `git clean` with `-f`/`--force` (in any combination with git clean's other
// real short flags: d, i, q, x, X). `n` (--dry-run) is deliberately excluded
// from the combinable set: `git clean -n` and `-nf`/`-fn` do not actually
// delete anything (dry-run wins), so they stay quiet rather than nag on a
// command that is already the safe rehearsal form.
const GIT_CLEAN_FORCE_RE = /\bgit(?:\.exe)?\s+clean\b[^\r\n;&|]{0,200}?(?<=\s)(?:--force\b|-[dfiqxX]*f[dfiqxX]*\b)/i;

function describeGitDestructiveMatch(command) {
  const text = String(command || '');
  // Ordered by blast radius, most severe first, so the message names the
  // single most relevant hazard when a command happens to match more than one.
  if (GIT_RESET_HARD_RE.test(text)) {
    return {
      op: 'git reset --hard',
      detail: 'discards every uncommitted change in the working tree and resets the index in one step, with no confirmation and no undo.'
    };
  }
  if (GIT_CLEAN_FORCE_RE.test(text)) {
    return {
      op: 'git clean -f (or --force)',
      detail: 'deletes untracked files outright -- they were never in git history, so there is no commit to recover them from.'
    };
  }
  if (GIT_CHECKOUT_PATH_RE.test(text)) {
    return {
      op: 'git checkout -- <path> (or git checkout .)',
      detail: 'overwrites the named path(s), or the whole working directory, from the index/ref -- discarding any uncommitted edit there.'
    };
  }
  if (GIT_RESTORE_RE.test(text)) {
    return {
      op: 'git restore <path>',
      detail: 'the newer spelling of the same hazard as git checkout -- <path>: overwrites the working-tree file from the index/ref.'
    };
  }
  return null;
}

function checkGitDestructive(command) {
  const match = describeGitDestructiveMatch(command);
  if (!match) return null;
  return [
    'GIT-DESTRUCTIVE advisory (STANDING-ORDERS.md Class SYNC, rule 5: "untracked files, uncommitted edits... are all single-copy work"):',
    `${match.op} ${match.detail}`,
    'Restore by FILE COPY in a red cycle, never `git checkout`/`git restore`: their blast radius is the whole working tree, not just your edit.',
    'Commit BEFORE the risky operation, not after. A commit is a durability operation; the message is where claims live, so an honest "WIP, unreviewed" message asserts nothing -- commit anyway.',
    "On a shared tree, another lane's uncommitted work is invisible to you and is destroyed silently -- yours may be invisible to them too.",
    'This is advisory only and does not block the command.'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Rule 6: SYNC hard guard -- whole-tree destructive git op while the working
// tree actually has uncommitted work right now (R1162 follow-up, git-safety-
// guard lane, 2026-08-10).
//
// Rule 5 above is deliberately advisory-only and command-text-only -- it
// cannot see whether anything is actually at risk, so its own test file
// explicitly forbids it ever growing a deny path. Two real incidents the
// same day proved that gap costs real work: an unscoped `git stash` (no
// pathspec) reverted roughly 16 concurrent agents' uncommitted edits to HEAD
// for about 60 seconds -- `git stash pop` then conflicted on three files and
// never applied; recovery took a 38-file diff, 35 hand-restores, and one
// hunk re-applied from memory. Hours later a bare `git reset` from a
// different agent (confirmed after the fact via `git reflog`, which showed a
// bare "reset: moving to HEAD" between the victim's edits and their next
// check) destroyed five uncommitted files from a third lane, redone from
// memory. Both agents disclosed and recovered well -- the TOOLING had no
// opinion on either event, before or after.
//
// This rule adds the one signal Rule 5 deliberately omits: REAL, CURRENT
// `git status --porcelain` state in the command's own cwd. That turns "is
// this command SHAPED like a whole-tree op" (Rule 5's only question) into
// "is this command about to run against a tree that actually has something
// to lose, right now" -- a far lower false-positive question, which is why
// this rule is allowed to block where Rule 5 is not. It is a SEPARATE rule,
// not an edit to Rule 5 or its matchers: Rule 5's own contract test asserts
// its listed commands are never blocked, and that contract stays true here
// unconditionally (this rule fires independently, alongside it).
//
// SCOPE is deliberately the four exact operations named for this task, not
// the broader Rule 5 set: `git stash` (no pathspec), `git reset` of any
// flavour (no pathspec), `git checkout .` / `git restore .` (the whole-cwd
// form only), and `git clean` with a force flag and no path argument. A
// command that names an explicit target (a `--` pathspec for stash/reset,
// any real path for checkout/restore/clean) is exactly the safe, scoped
// alternative this rule's own message recommends, and is left alone --
// Rule 5's own advisory still covers it if it separately matches there.
//
// Ref-vs-path ambiguity: `git reset <token>` and `git stash push <token>`
// can each mean either a ref/message or a pathspec, and this heuristic
// cannot safely tell them apart -- so for those two verbs ONLY an explicit
// `--` pathspec separator counts as scoped. `git checkout`/`git restore`
// have no such ambiguity for a bare token (checkout treats it as a branch or
// an implicit path, neither of which is the whole-tree hazard this rule
// guards; restore has no branch-switch meaning at all, so a bare token is
// always a path) -- only a literal, whitespace-bounded `.` target counts as
// whole-tree for those two. `git clean` takes no refs at all, so an absent
// target is exactly as whole-tree as an explicit `.`.
//
// FAILS OPEN: if `git status --porcelain` cannot be evaluated (no repo at
// that cwd, git missing, timeout, killed by an external signal) this rule
// has no opinion -- it does not guess dirty in either direction; see
// workingTreeDirtyStatus() below for the real three-outcome handling
// (STANDING-ORDERS.md Class SYNC, rule 2: never misread a git command's
// status).
//
// OVERRIDE: TOOLSENABLED_ALLOW_WHOLE_TREE_GIT=1 (same shape as the sibling
// installer repo's MC_ALLOW_DIRTY_BUILD=1) proceeds anyway; an optional
// TOOLSENABLED_ALLOW_WHOLE_TREE_GIT_REASON is included in the log line if
// set. Every override is logged with the command, cwd, and dirty file count
// -- the goal is that nobody hits this BY ACCIDENT, not that nobody ever can.
// ---------------------------------------------------------------------------

/* Raised from 3,000 ms after a chain test caught this timing out under the
   fleet this repository asks to be run: `git status --porcelain` on a busy
   box genuinely takes longer than three seconds. The ceiling still exists
   because a hook must not hang a person's shell, but exceeding it now
   REFUSES rather than allows -- see the indeterminate branch below. */
const GIT_DIRTY_STATUS_TIMEOUT_MS = 10000;
const GIT_DIRTY_TREE_OVERRIDE_ENV = 'TOOLSENABLED_ALLOW_WHOLE_TREE_GIT';
const GIT_DIRTY_TREE_OVERRIDE_REASON_ENV = 'TOOLSENABLED_ALLOW_WHOLE_TREE_GIT_REASON';
const MAX_DIRTY_PATH_EXAMPLES = 8;
const STASH_NON_CREATING_SUBCOMMANDS = new Set(['list', 'show', 'pop', 'apply', 'drop', 'branch', 'clear']);

// Every token after the named verb (already unquoted), or null if the verb
// is not present as its own token at all.
function verbTokens(command, verb) {
  const tokens = tokenize(String(command || '')).map(unquote);
  const verbIndex = tokens.findIndex(token => new RegExp(`^${verb}$`, 'i').test(token));
  if (verbIndex === -1) return null;
  return tokens.slice(verbIndex + 1);
}

// checkout/restore/clean: whole-tree if there is no real target, or the only
// target(s) present are the literal '.' -- honours an explicit `--` when
// present, otherwise looks at every non-flag token.
function targetsAfterOptionalPathspecSeparator(tokens) {
  const dashIndex = tokens.indexOf('--');
  return dashIndex === -1 ? tokens.filter(token => !token.startsWith('-')) : tokens.slice(dashIndex + 1);
}

// reset/stash: the ref-vs-path ambiguity means only an EXPLICIT `--`
// (followed by nothing, or only '.') counts as scoped; a bare trailing
// token with no `--` is treated as whole-tree even though it might, in a
// human reader's eyes, obviously be a path.
function lacksExplicitPathspec(tokens) {
  const dashIndex = tokens.indexOf('--');
  if (dashIndex === -1) return true;
  const targets = tokens.slice(dashIndex + 1);
  return targets.length === 0 || targets.every(token => token === '.');
}

function isWholeTreeStash(command) {
  if (!/\bgit(?:\.exe)?\s+stash\b/i.test(String(command || ''))) return false;
  const rest = verbTokens(command, 'stash');
  if (!rest) return false;
  const first = rest[0];
  if (first && !first.startsWith('-') && STASH_NON_CREATING_SUBCOMMANDS.has(first.toLowerCase())) return false;
  return lacksExplicitPathspec(rest);
}

function isWholeTreeReset(command) {
  const text = String(command || '');
  if (!/\bgit(?:\.exe)?\s+reset\b/i.test(text)) return false;
  if (/(?:^|\s)(?:--help|-h)\b/i.test(text)) return false;
  const rest = verbTokens(command, 'reset');
  if (!rest) return false;
  return lacksExplicitPathspec(rest);
}

function isWholeTreeCheckoutOrRestore(command, verb) {
  const text = String(command || '');
  if (!new RegExp(`\\bgit(?:\\.exe)?\\s+${verb}\\b`, 'i').test(text)) return false;
  if (verb === 'restore' && /(?:^|\s)(?:--help|-h)\b/i.test(text)) return false;
  const rest = verbTokens(command, verb);
  if (!rest || rest.length === 0) return false;
  const targets = targetsAfterOptionalPathspecSeparator(rest);
  return targets.length > 0 && targets.every(token => token === '.');
}

function isWholeTreeClean(command) {
  const text = String(command || '');
  if (!GIT_CLEAN_FORCE_RE.test(text)) return false;
  const rest = verbTokens(command, 'clean');
  if (!rest) return false;
  const targets = targetsAfterOptionalPathspecSeparator(rest);
  return targets.every(token => token === '.'); // empty list also satisfies "every"
}

function describeWholeTreeDestructiveMatch(command) {
  const text = String(command || '');
  // Ordered by blast radius, most severe first, matching describeGitDestructiveMatch above.
  if (isWholeTreeReset(text)) {
    return { op: 'git reset (no pathspec)', safeAlternative: 'git reset -- <path> (or commit/stash the exact paths you mean to touch first)' };
  }
  if (isWholeTreeStash(text)) {
    return { op: 'git stash (no pathspec)', safeAlternative: 'git stash push -- <path>' };
  }
  if (isWholeTreeCheckoutOrRestore(text, 'checkout')) {
    return { op: 'git checkout . (whole tree)', safeAlternative: 'git checkout <ref> -- <path>' };
  }
  if (isWholeTreeCheckoutOrRestore(text, 'restore')) {
    return { op: 'git restore . (whole tree)', safeAlternative: 'git restore -- <path>' };
  }
  if (isWholeTreeClean(text)) {
    return { op: 'git clean (force, no path argument)', safeAlternative: 'git clean -f -- <path> (name the exact untracked path(s) to remove)' };
  }
  return null;
}

// Real, current git status in `cwd` -- never a guess. { determined: false }
// means "could not tell" (no repo there, git missing, timeout, killed by an
// external signal), and this rule's caller must treat that as fail-open, not
// as "clean". Spawns `git` directly (no shell string, explicit argv,
// windowsHide) rather than reusing src/lib/proc/run.js's runChecked: that
// module lives in a different package than this hook (surface.policy), and
// reaching across for one narrow spawn is not worth the cross-package edge
// when the safety properties that matter here -- no shell, explicit argv,
// a bounded timeout, and a real three-way outcome instead of a guessed
// boolean -- are cheap to keep locally.
function gitMarkerBelowVolumeRoot(cwd) {
  let current;
  try {
    current = path.resolve(cwd);
    const cwdStat = fs.statSync(current);
    if (!cwdStat.isDirectory()) {
      return { determined: false, reason: `${cwd} is not a directory.` };
    }
  } catch (error) {
    return {
      determined: false,
      reason: `the command working directory could not be inspected: ${(error && error.code) || 'unknown error'}.`
    };
  }
  for (;;) {
    const parent = path.dirname(current);
    // A volume-root .git marker makes every unrelated directory on that drive
    // look like one enormous repository and can also be owned by a different
    // security principal. Never adopt the volume root as this command's tree.
    if (parent === current) return { determined: true, found: false };
    try {
      fs.lstatSync(path.join(current, '.git'));
      return { determined: true, found: true };
    } catch (error) {
      if (!error || error.code !== 'ENOENT') {
        return {
          determined: false,
          reason: `the repository marker at ${current} could not be inspected: ${(error && error.code) || 'unknown error'}.`
        };
      }
    }
    current = parent;
  }
}

function workingTreeDirtyStatus(cwd, timeoutMs = GIT_DIRTY_STATUS_TIMEOUT_MS) {
  const marker = gitMarkerBelowVolumeRoot(cwd);
  if (!marker.determined) return marker;
  if (!marker.found) {
    return {
      determined: false,
      notARepository: true,
      reason: `${cwd} has no repository marker below its volume root, so there is no working tree to protect.`
    };
  }
  let spawned;
  try {
    const { safeLaunchEnvironment } = require('../src/lib/providers/subscription-launch-env');
    spawned = spawnSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
      env: safeLaunchEnvironment()
    });
  } catch (error) {
    return { determined: false, reason: `git status --porcelain could not be started: ${(error && error.message) || 'unknown error'}.` };
  }
  if (spawned.error) {
    return { determined: false, reason: `git status --porcelain could not be evaluated: ${(spawned.error && spawned.error.message) || spawned.error}.` };
  }
  if (spawned.status === null) {
    return { determined: false, reason: `git status --porcelain was terminated by signal ${spawned.signal || '(unknown)'} before it could exit on its own.` };
  }
  if (spawned.status !== 0) {
    const stderrText = String(spawned.stderr || '').trim();
    /* NOT A REPOSITORY IS A DEFINITE ANSWER, NOT AN UNKNOWN. There is no
       working tree here, so there is no uncommitted work this operation
       could destroy. Reporting it as indeterminate would make the guard
       refuse every git command run outside a repository, which is noise
       with no safety in it -- and noise is how a guard gets switched off. */
    if (/not a git repository/i.test(stderrText)) {
      return { determined: false, notARepository: true, reason: `${cwd} is not a git repository, so there is no working tree to protect.` };
    }
    return { determined: false, reason: `git status --porcelain exited ${spawned.status}: ${truncate(stderrText)}` };
  }
  const lines = String(spawned.stdout || '').split(/\r?\n/).filter(Boolean);
  return { determined: true, dirty: lines.length > 0, count: lines.length, paths: lines.map(line => line.slice(3)) };
}

function gitDirtyTreeOverrideActive(env) {
  return Boolean(env && String(env[GIT_DIRTY_TREE_OVERRIDE_ENV]) === '1');
}

function checkGitDestructiveDirtyTree(command, cwd, env = process.env) {
  const match = describeWholeTreeDestructiveMatch(command);
  if (!match) return null;

  if (gitDirtyTreeOverrideActive(env)) {
    appendLog({
      rule: 'GIT-DESTRUCTIVE-DIRTY-TREE',
      decision: 'allow-override',
      op: match.op,
      command: snippet(command),
      cwd: truncate(String(cwd || '')),
      reason: truncate(String((env && env[GIT_DIRTY_TREE_OVERRIDE_REASON_ENV]) || '(no reason given)'))
    });
    return null;
  }

  const status = workingTreeDirtyStatus(cwd);
  if (!status.determined && status.notARepository) {
    appendLog({ rule: 'GIT-DESTRUCTIVE-DIRTY-TREE', decision: 'allow-not-a-repository', op: match.op, reason: truncate(status.reason) });
    return null;
  }
  if (!status.determined) {
    /* COULD NOT LOOK IS NOT A CLEAN TREE. This branch used to return null,
       which allows -- so the one guard standing between a whole-tree
       destructive git and other people's uncommitted work fell open exactly
       when the machine was too busy to answer, which is when the most work
       is at risk. Refusing costs one retry with an override that already
       exists and is already logged; allowing costs somebody their only copy.
       The rest of this codebase already decides this way: the web-drive
       gate's unknown() object denies, and the vault reports UNREADABLE
       rather than ABSENT. */
    appendLog({ rule: 'GIT-DESTRUCTIVE-DIRTY-TREE', decision: 'block-indeterminate', op: match.op, reason: truncate(status.reason) });
    return [
      `GIT-DESTRUCTIVE-DIRTY-TREE block (R1162 follow-up): ${match.op}`,
      `Whether this working tree holds uncommitted work COULD NOT BE ESTABLISHED, so this whole-tree operation is refused rather than allowed.`,
      `Reason: ${status.reason}`,
      `On a shared tree this can be someone else's work -- it does not have to be yours to be destroyed, and an unread tree is not an empty one.`,
      `Safe alternative: ${match.safeAlternative}`,
      `If this whole-tree operation is genuinely intended: set ${GIT_DIRTY_TREE_OVERRIDE_ENV}=1 (optionally with ${GIT_DIRTY_TREE_OVERRIDE_REASON_ENV}="<reason>") and retry. This is logged, not silent, and is not blocked again.`
    ].join('\n');
  }
  if (!status.dirty) {
    appendLog({ rule: 'GIT-DESTRUCTIVE-DIRTY-TREE', decision: 'allow-clean-tree', op: match.op });
    return null;
  }

  appendLog({ rule: 'GIT-DESTRUCTIVE-DIRTY-TREE', decision: 'block', op: match.op, dirtyCount: status.count, command: snippet(command) });
  const examples = status.paths.slice(0, MAX_DIRTY_PATH_EXAMPLES).map(entryPath => `  - ${entryPath}`).join('\n');
  const more = status.paths.length > MAX_DIRTY_PATH_EXAMPLES ? `\n  ...and ${status.paths.length - MAX_DIRTY_PATH_EXAMPLES} more` : '';
  return [
    `GIT-DESTRUCTIVE-DIRTY-TREE block (R1162 follow-up): ${match.op}`,
    `${status.count} path(s) show uncommitted work in this working tree RIGHT NOW. On a shared tree this can be someone else's work -- it does not have to be yours to be destroyed.`,
    `${examples}${more}`,
    `Safe alternative: ${match.safeAlternative}`,
    'Commit or stash the SPECIFIC paths you mean to touch first, or scope this operation with an explicit pathspec, instead of running it whole-tree.',
    `If this whole-tree operation is genuinely intended: set ${GIT_DIRTY_TREE_OVERRIDE_ENV}=1 (optionally with ${GIT_DIRTY_TREE_OVERRIDE_REASON_ENV}="<reason>") and retry. This is logged, not silent, and is not blocked again.`
  ].join('\n');
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

  const toolName = payload && payload.tool_name;
  const toolInput = (payload && payload.tool_input) || {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : ROOT;

  if (LOCAL_WRITE_TOOL_RE.test(String(toolName))) {
    try {
      const protectedWriteBlock = checkProtectedWrite(toolName, toolInput, cwd, process.env);
      if (protectedWriteBlock) return block(protectedWriteBlock);
    } catch (error) {
      // REQUIRED FAIL-OPEN BOUNDARY. Missing files, unavailable authority,
      // target-resolution failures, and all unexpected guard errors proceed.
      // A bug here must never wedge every Edit/Write session in the repo.
      appendLog({
        rule: 'SYNC-WRITE-PROTECTION',
        decision: 'fail-open',
        toolName: truncate(String(toolName || '')),
        error: truncate(String(error && error.message || error))
      });
    }
    return allow();
  }

  if (!command || !SHELL_TOOL_RE.test(String(toolName))) return allow();

  try {
    const protectedWriteBlock = checkProtectedWrite(toolName, toolInput, cwd, process.env);
    if (protectedWriteBlock) return block(protectedWriteBlock);
  } catch (error) {
    appendLog({ rule: 'DEPENDENCY-ACCEPTANCE', decision: 'fail-open-install-check', error: truncate(String(error && error.message || error)) });
  }

  const dependencyDistributionBlock = checkDependencyDistribution(command);
  if (dependencyDistributionBlock) return block(dependencyDistributionBlock);

  try {
    const outwardMessage = checkOutward(command, cwd, process.env);
    if (outwardMessage) return block(outwardMessage);
  } catch (error) {
    appendLog({ rule: 'OUTWARD', decision: 'fail-open', error: truncate(String(error && error.message || error)) });
  }

  try {
    const browserMessage = checkBrowser(command, process.env);
    if (browserMessage) return block(browserMessage);
  } catch (error) {
    appendLog({ rule: 'BROWSER', decision: 'fail-open', error: truncate(String(error && error.message || error)) });
  }

  try {
    const consoleMessage = checkConsoleVisibility(command);
    if (consoleMessage) return block(consoleMessage);
  } catch (error) {
    appendLog({ rule: 'LOCAL-WORK-CONSOLE', decision: 'fail-open', error: truncate(String(error && error.message || error)) });
  }

  try {
    const reminder = checkLocalWork(command, toolName);
    if (reminder) return allow(reminder);
  } catch (error) {
    appendLog({ rule: 'LOCAL-WORK', decision: 'fail-open', error: truncate(String(error && error.message || error)) });
  }

  try {
    const dirtyTreeBlock = checkGitDestructiveDirtyTree(command, cwd, process.env);
    if (dirtyTreeBlock) return block(dirtyTreeBlock);
  } catch (error) {
    appendLog({ rule: 'GIT-DESTRUCTIVE-DIRTY-TREE', decision: 'fail-open', error: truncate(String(error && error.message || error)) });
  }

  try {
    const gitDestructiveReminder = checkGitDestructive(command);
    if (gitDestructiveReminder) {
      appendLog({ rule: 'GIT-DESTRUCTIVE', decision: 'advisory', command: snippet(command) });
      return allow(gitDestructiveReminder);
    }
  } catch (error) {
    appendLog({ rule: 'GIT-DESTRUCTIVE', decision: 'fail-open', error: truncate(String(error && error.message || error)) });
  }

  return allow();
}

if (require.main === module) {
  if (process.argv[2] === 'authorize-protected-write') {
    try {
      const marker = authorizeProtectedWrite(process.argv.slice(3), process.env);
      process.stdout.write(`Protected write authorized once for ${marker.target}; expires in five minutes.\n`);
      process.exit(0);
    } catch (error) {
      process.stderr.write(`Protected write authorization refused: ${String(error && error.message || error)}\n`);
      process.exit(2);
    }
  } else {
    try {
      main();
    } catch (error) {
      failOpen('main', error);
    }
  }
}

module.exports = {
  ROOT,
  LOG_FILE,
  LOCAL_WRITE_TOOL_RE,
  DEFAULT_PROTECTED_WRITE_AUTH_DIR,
  PROTECTED_WRITE_AUTH_TTL_MS,
  loadProtectedFileAuthority,
  resolveLocalWriteTarget,
  checkProtectedWrite,
  PACKAGE_INSTALL_COMMAND_RE,
  DISTRIBUTION_COMMAND_RE,
  checkDependencyDistribution,
  authorizeProtectedWrite,
  consumeProtectedWriteAuthorization,
  writeProtectedWriteAuthorization,
  simulateNativeEdit,
  isSanctionedBuildQueueEdit,
  completedReceiptIds,
  checkOutward,
  checkBrowser,
  checkConsoleVisibility,
  checkLocalWork,
  isOutwardToolName,
  findOutwardCandidate,
  isBrowserDriving,
  hasControllerDelegation,
  hasVisibleShellAllowance,
  usesStartProcessForConsoleShell,
  usesDirectConsoleShell,
  hasHiddenConsoleBoundary,
  registersInteractiveScheduledTask,
  extractGrepLikePattern,
  extractSelectStringPattern,
  isSymbolShaped,
  targetsProseOnly,
  checkGitDestructive,
  describeGitDestructiveMatch,
  GIT_CHECKOUT_PATH_RE,
  GIT_RESTORE_RE,
  GIT_RESET_HARD_RE,
  GIT_CLEAN_FORCE_RE,
  stripBom,
  readStdin,
  checkGitDestructiveDirtyTree,
  describeWholeTreeDestructiveMatch,
  isWholeTreeStash,
  isWholeTreeReset,
  isWholeTreeCheckoutOrRestore,
  isWholeTreeClean,
  workingTreeDirtyStatus,
  gitDirtyTreeOverrideActive,
  GIT_DIRTY_TREE_OVERRIDE_ENV,
  GIT_DIRTY_TREE_OVERRIDE_REASON_ENV
};
