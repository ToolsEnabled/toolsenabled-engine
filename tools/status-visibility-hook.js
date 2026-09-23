#!/usr/bin/env node
'use strict';

// Status-visibility PreToolUse hook -- an ADVISORY-ONLY nudge for the most
// repeated failure of the 2026-08-03/04 session: reading a command's exit
// status from the wrong place. See docs/coordinator/MECHANIZE-NOT-REMEMBER.md
// item 2 and STANDING-ORDERS.md class LOCAL-WORK (0-COMMERCIAL) for the
// standard this exists under: "Things that can be mechanically built and
// implemented should be. Agents should not be relied on to have to do things
// we could have done for them with 100% success rates." Two agents were told
// about the `/tmp` redirect trap in writing, in their briefs, and hit it
// anyway -- a written warning does not survive to the moment it is needed;
// a hook that inspects the actual command text does.
//
// Confirmed occurrences this session, five real commands across four agents
// and the coordinator, reproduced verbatim (as far as the transcripts give
// exact text) in tests/status-visibility-hook.js:
//   - `git push ... | tail -2` printed exit=0 while the push failed on a
//     refspec error -- nearly leaving 24 single-copy commits unrescued.
//   - `node --test tests/agent-comms/ > /tmp_log 2>&1` exited 1 because the
//     REDIRECT failed (no writable /tmp_log on this machine), not the tests.
//     This happened twice, the second time after an explicit written warning.
//   - `npm test | tail -5` reported green while the suite failed.
//   - `gh ... | head` masked that `gh` was not installed.
//   - `node --test tests/agent-comms/` (bare directory, no redirect) exits 1
//     via a Node test-runner quirk -- see src/lib/proc/run.js's
//     isNodeTestDirectoryQuirk() header for the full mechanism -- unrelated
//     to whether any test actually failed.
//
// WHY THIS IS ADVISORY, NEVER BLOCKING -- read this before "fixing" it to
// block. The judgement call the task asked for, made explicit:
//
//   1. The signal this hook can see (command text) cannot distinguish "a
//      status-bearing command piped into something that will misreport its
//      exit code" from "a status-bearing command piped into something and
//      the agent does not care about the exit code at all" (e.g. skimming
//      `npm test | tail -40` purely to eyeball the last lines of output,
//      already knowing it will check `$?` separately, or not caring because
//      the real verdict comes from a later, unpiped command). Intent is not
//      observable from a command string. A hook that cannot tell the two
//      apart and blocks anyway will be disabled by the first person it stops
//      from doing legitimate work -- and a disabled guard is worse than no
//      guard, because it is still believed to be running.
//   2. This repo's own precedent already answers this exact question the
//      same way: tools/standing-orders-hook.js's LOCAL-WORK rule 0 (the grep
//      lookup-ladder reminder) is explicitly advisory for the identical
//      reason -- "This cannot block ... it exists to make drift visible, not
//      to stop it by force." Three OTHER rules in that same file DO block,
//      but only because their signal is structural and near-unambiguous
//      (literally driving a CDP session; a literal provenance marker in a
//      filename) -- not a judgement call about what the agent meant.
//   3. Even the two highest-confidence checks here (a redirect target that
//      will not resolve; `node --test` given a real directory on disk) are
//      pattern matches on a KNOWN, VERIFIED incident shape, not a proof the
//      command is wrong in general -- see src/lib/proc/run.js's own
//      isNodeTestDirectoryQuirk comment, which hedges the same way ("a
//      different Node version ... could still evade or false-trigger it").
//      Reporting a false failure by refusing a command outright would be a
//      strictly worse failure mode than the one this hook exists to prevent.
//
// So every rule below returns advisory text via allow(), never block(). The
// mechanism this hook cannot BE is the actual fix -- that is
// src/lib/proc/run.js's runChecked()/runPipeline(), which reports the real
// status in-process with no shell pipe to misread in the first place. This
// hook's job is narrower: catch the ad hoc shell command an agent types by
// hand before it produces a false green or a false red, and point at the
// real fix in the moment it would have helped.
//
// FAIL OPEN, DELIBERATELY THE OPPOSITE OF THIS REPO'S USUAL FAIL-CLOSED
// RULE. Elsewhere in this repo (egress gates, ledger writes, credential
// handling) failing closed is correct: an unverifiable state must not be
// treated as safe. This hook is different in kind, not just in degree -- it
// is required, by the task that produced it, to never be able to wedge a
// session: "if the hook itself errors, Bash calls must still proceed." A
// PreToolUse hook sits in front of EVERY shell call in EVERY session; if a
// bug in a regression to this file could ever make a Bash call impossible to
// run, one bad edit here would silently brick every agent's ability to do
// anything at all, for a benefit (a heuristic reminder) that is not worth
// that risk. Every rule below runs in its own try/catch; any internal error
// is logged and treated as "no opinion" -- exactly the same contract
// tools/standing-orders-hook.js already uses for its own internal errors,
// just applied here without the three rules that are allowed to block.
//
// NO HARDCODED PATHS. This file deliberately invokes plain `node` (PATH
// resolution) from .claude/settings.json, not a pinned absolute interpreter
// path -- unlike the standing-orders-hook.js entry in that same file, which
// pins C:\agent-apps\node-v22.19.0\node.exe to dodge a specific node:sqlite
// defect on an older PATH-resolved Node build (see that file's own header).
// This hook touches no node:sqlite and has no such landmine, so pinning
// would only add an unnecessary hardcoded, machine-specific path -- exactly
// the class of defect this session's own MECHANIZE-NOT-REMEMBER.md documents
// 33 instances of (33 files hardcoding one user's home directory -- "across
// users, across setups" is the standard this repo is held to).

const fs = require('node:fs');
const path = require('node:path');

const LOG_FILE = path.join(__dirname, '..', 'logs', 'status-visibility-hook.log');
const MAX_LOG_FIELD_LENGTH = 400;

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
    // Logging must never be why this hook fails open. Swallow.
  }
}

// ---------------------------------------------------------------------------
// stdin / decision plumbing -- mirrors tools/standing-orders-hook.js's own
// contract (verified against the same hook schema) but is a self-contained
// copy, not a require() of that file: this hook is a separate, independently
// deployable concern (a different STANDING-ORDERS.md item, a different
// author, a different file-territory claim) and should not gain a runtime
// dependency on a sibling script's internals just to save a few lines.
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

// Every exit path in this file is allow() or failOpen() -- there is no
// block() at all. See the header comment for why blocking was rejected.
function failOpen(context, error) {
  appendLog({ rule: 'internal-error', decision: 'fail-open', context, error: truncate(String((error && error.message) || error || '')) });
  process.exit(0);
}

// ---------------------------------------------------------------------------
// shell-aware tokenizing -- quote-respecting, no shell spawned.
// ---------------------------------------------------------------------------

function tokenize(command) {
  return String(command || '').match(/"[^"]*"|'[^']*'|\S+/g) || [];
}

function unquote(token) {
  if (token.length >= 2 && ((token[0] === '"' && token.endsWith('"')) || (token[0] === "'" && token.endsWith("'")))) {
    return token.slice(1, -1);
  }
  return token;
}

// Splits a full command string into PIPELINES (each an array of stage
// strings joined by unquoted `|`), at every unquoted `&&`, `||`, `;`, or
// newline. Quote-aware (tracks a single active ' or " at a time; a backslash
// escapes the next character) so a pipe character or operator INSIDE a
// quoted argument is never mistaken for a real shell operator -- the same
// class of bug the McNair-filename fix in standing-orders-hook.js exists to
// avoid (a quoted string with meaningful punctuation must survive intact).
function splitPipelines(command) {
  const text = String(command || '');
  const parts = [];
  let current = '';
  let quote = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      current += ch + text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '&' && text[i + 1] === '&') { parts.push({ text: current, op: '&&' }); current = ''; i += 2; continue; }
    if (ch === '|' && text[i + 1] === '|') { parts.push({ text: current, op: '||' }); current = ''; i += 2; continue; }
    if (ch === '|') { parts.push({ text: current, op: '|' }); current = ''; i += 1; continue; }
    if (ch === ';' || ch === '\n') { parts.push({ text: current, op: ';' }); current = ''; i += 1; continue; }
    current += ch;
    i += 1;
  }
  parts.push({ text: current, op: null });

  const pipelines = [];
  let stages = [];
  for (const part of parts) {
    stages.push(part.text);
    if (part.op !== '|') {
      pipelines.push(stages);
      stages = [];
    }
  }
  return pipelines;
}

// Strips leading whitespace and any leading inline env-var assignments
// (`FOO=bar BAZ="q u x" realcommand ...`) so the status-bearing patterns
// below match the real command word, not an assignment that happens to look
// like one.
function stripLeadingAssignments(stageText) {
  let text = String(stageText || '').replace(/^\s+/, '');
  const assignmentRe = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
  let match = assignmentRe.exec(text);
  while (match) {
    text = text.slice(match[0].length);
    match = assignmentRe.exec(text);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Rule 1: a status-bearing command piped into anything.
// ---------------------------------------------------------------------------
//
// This list is deliberately a curated set of command HEADS whose exit status
// is the entire reason to run them (a test runner, a type-checker, a VCS
// mutation, a CLI whose absence/failure is itself the finding) -- never a
// generic "any pipe" match. `ls | head`, `grep foo bar.txt | head -3`, and
// every other pipe whose left side is not in this list produces no warning
// at all; that is the intended, load-bearing behaviour (see tests for the
// true-negative cases this depends on). The task's own five incidents are
// the first block; the second block are close analogues in the same failure
// class (same reasoning, not yet independently confirmed as an incident
// here) -- kept because they cost nothing in false-positive risk (their
// command names are unambiguous) while extending real coverage.
const STATUS_BEARING_HEAD_PATTERNS = [
  // --- tonight's confirmed incidents (docs/coordinator/MECHANIZE-NOT-REMEMBER.md item 2) ---
  { label: 'npm test / npm run', re: /^npm(\.cmd)?\s+(test\b|run\b|ci\b)/i },
  { label: 'node --test', re: /^node(\.exe)?\s+(?:[^|;&\n]{0,200}\s)?--test(?=\s|$)/i },
  { label: 'node test path', re: /^node(\.exe)?\b[^|;&\n]{0,200}?\btests?[\\/]/i },
  { label: 'pytest', re: /^(?:python[0-9.]*\s+-m\s+)?pytest\b/i },
  { label: 'git push', re: /^git\s+push\b/i },
  { label: 'git commit', re: /^git\s+commit\b/i },
  { label: 'gh CLI', re: /^gh(\.exe)?(?=\s)/i },
  // --- close analogues, same failure class, same low false-positive bar ---
  { label: 'yarn/pnpm test or run', re: /^(?:yarn|pnpm)(?:\.cmd)?\s+(test\b|run\b)/i },
  { label: 'cargo test/build', re: /^cargo\s+(test|build)\b/i },
  { label: 'tsc', re: /^(?:npx\s+)?tsc(?:\.cmd)?\b/i },
  { label: 'go test', re: /^go\s+test\b/i },
  { label: 'dotnet test', re: /^dotnet(?:\.exe)?\s+test\b/i },
  { label: 'mvn test', re: /^mvn(?:\.cmd)?\s+test\b/i },
  { label: 'jest/mocha/vitest', re: /^(?:npx\s+)?(?:jest|mocha|vitest)(?:\.cmd)?\b/i }
];

// A sophisticated command that already captures the real per-stage status
// (bash `set -o pipefail`, `${PIPESTATUS[...]}`, PowerShell `$LASTEXITCODE`)
// has already solved the exact problem this rule exists to flag -- warning
// on it anyway would be pure noise against a caller who did the right thing.
function hasExplicitStatusHandling(command) {
  const text = String(command || '');
  return /\bpipefail\b/i.test(text) || /PIPESTATUS/i.test(text) || /\$LASTEXITCODE\b/i.test(text);
}

function matchStatusBearingHead(stageText) {
  const cleaned = stripLeadingAssignments(stageText);
  for (const pattern of STATUS_BEARING_HEAD_PATTERNS) {
    if (pattern.re.test(cleaned)) return pattern;
  }
  return null;
}

function checkPipeMasking(command) {
  if (hasExplicitStatusHandling(command)) return null;
  const pipelines = splitPipelines(command);
  const hits = [];
  for (const stages of pipelines) {
    if (stages.length < 2) continue; // no `|` at all -- nothing to mask
    // Only the non-last stages can have their status masked by a later stage.
    for (let index = 0; index < stages.length - 1; index += 1) {
      const match = matchStatusBearingHead(stages[index]);
      if (match) {
        hits.push({ label: match.label, stage: stages[index].trim() });
        break; // one nudge per pipeline is enough
      }
    }
  }
  if (hits.length === 0) return null;

  appendLog({ rule: 'PIPE-MASKING', decision: 'advisory', hits: hits.map(h => ({ label: h.label, stage: truncate(h.stage) })) });

  const named = hits.map(h => `"${h.label}"`).join(', ');
  return [
    'STATUS-VISIBILITY advisory (docs/coordinator/MECHANIZE-NOT-REMEMBER.md item 2; STANDING-ORDERS.md class LOCAL-WORK, 0-COMMERCIAL):',
    `A status-bearing command (${named}) is piped into another command. After a pipe, $?/$LASTEXITCODE reflects the LAST stage, not the command whose status actually matters -- a failing test/build/push whose output is piped into tail/head/grep/jq can still report success (or a harmless downstream failure can be misread as the real command failing).`,
    'If the exit status matters here, run the status-bearing command by itself (no pipe) and read its own exit code directly, or use src/lib/proc/run.js\'s runChecked()/runPipeline(), which attribute the verdict to the command that matters, never to a later stage.',
    'This is advisory only and does not block the command.'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Rule 2: `node --test <directory>` -- known false-red on this platform.
// ---------------------------------------------------------------------------
//
// Verified mechanism: src/lib/proc/run.js's isNodeTestDirectoryQuirk(). This
// rule only fires when the argument resolves, on THIS machine, to a real
// directory -- not merely a path that looks directory-shaped -- which is
// what keeps its false-positive rate near zero: a single file, a glob, or a
// nonexistent path never matches.
function findNodeTestDirectoryArgs(command) {
  const args = [];
  const re = /\bnode(?:\.exe)?\s+--test(?=\s|$)([^\n]*)/gi;
  let match = re.exec(command);
  while (match) {
    const tokens = tokenize(match[1]).map(unquote);
    for (const token of tokens) {
      if (token.startsWith('-')) continue; // skip flags -- heuristic, not a full arg parser
      args.push(token);
      break; // first non-flag token is the target
    }
    match = re.exec(command);
  }
  return args;
}

function checkNodeTestDirectory(command, cwd) {
  const candidates = findNodeTestDirectoryArgs(command);
  if (candidates.length === 0) return null;

  const base = typeof cwd === 'string' && cwd ? cwd : process.cwd();
  const flagged = [];
  for (const candidate of candidates) {
    if (/[*?[\]]/.test(candidate)) continue; // already a glob -- the known-good form
    if (/\.(js|mjs|cjs|ts)$/i.test(candidate)) continue; // a single file target, not a directory
    const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(base, candidate);
    let stat;
    try { stat = fs.statSync(resolved); } catch { continue; } // does not exist -- not this hook's business
    if (stat.isDirectory()) flagged.push(candidate);
  }
  if (flagged.length === 0) return null;

  appendLog({ rule: 'NODE-TEST-DIRECTORY', decision: 'advisory', candidates: flagged.map(truncate) });

  const displayed = flagged.map(c => `"${c}"`).join(', ');
  return [
    'STATUS-VISIBILITY advisory (docs/coordinator/MECHANIZE-NOT-REMEMBER.md item 2):',
    `"node --test" targets a real directory (${displayed}). On this Node build, a bare directory argument whose files do not match the default test-name globs makes node try to require() the directory itself and exit 1 with a single synthetic failing test -- not a real test failure (verified: src/lib/proc/run.js's isNodeTestDirectoryQuirk).`,
    'Prefer the glob form (e.g. "<dir>/*.js"), or check the result against isNodeTestDirectoryQuirk() before treating a nonzero exit here as real.',
    'This is advisory only and does not block the command.'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Rule 3: a redirect target that will not resolve on this platform.
// ---------------------------------------------------------------------------
//
// The exact incident: `node --test tests/agent-comms/ > /tmp_log 2>&1`
// exited 1 because the redirect itself failed (no writable /tmp_log; see
// this file's header for the verified permission-denied behaviour), not
// because any test failed. Scoped narrowly to a POSIX-style redirect
// operator immediately followed by a `/tmp...` target -- this is a
// structural pattern match (operator + path), not a guess about intent, so
// it stays cheap to keep precise. Bash tool sessions on this repo's own
// MSYS2 shell DO have a working /tmp/ subtree (verified while building this
// hook) but a bare root-level target under `/tmp...` still failed with
// EACCES in that same verification, and PowerShell/cmd sessions have no
// /tmp at all -- so a redirect there is unreliable either way, which is
// exactly why this repo's own CLAUDE.md scratchpad convention says to use a
// repo-relative scratch directory instead of /tmp in the first place.
const TMP_REDIRECT_RE = /(?:^|[\s;&|(])(?:[12]?>{1,2}|&>{1,2})\s*["']?(\/tmp\S*)/gi;

function findTmpRedirectTargets(command) {
  const text = String(command || '');
  const targets = new Set();
  let match = TMP_REDIRECT_RE.exec(text);
  while (match) {
    targets.add(match[1].replace(/["']$/, ''));
    match = TMP_REDIRECT_RE.exec(text);
  }
  return [...targets];
}

function checkTmpRedirect(command) {
  const targets = findTmpRedirectTargets(command);
  if (targets.length === 0) return null;

  appendLog({ rule: 'TMP-REDIRECT', decision: 'advisory', targets: targets.map(truncate) });

  const displayed = targets.map(t => `"${t}"`).join(', ');
  return [
    'STATUS-VISIBILITY advisory (docs/coordinator/MECHANIZE-NOT-REMEMBER.md item 2):',
    `This command redirects output to ${displayed}. A redirect failure (not the command it wraps) can be the reason a run reports failure -- this exact shape produced a false red tonight because the target was not writable on this machine, and /tmp does not exist at all under PowerShell/cmd.`,
    'Prefer a repo-relative path (e.g. under scratch/) or this session\'s scratchpad directory, and check whether a nonzero exit came from the redirect or the command it wraps.',
    'This is advisory only and does not block the command.'
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
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : process.cwd();

  if (!command || !/^(Bash|PowerShell)$/.test(String(toolName))) return allow();

  const notes = [];

  try {
    const note = checkPipeMasking(command);
    if (note) notes.push(note);
  } catch (error) {
    appendLog({ rule: 'PIPE-MASKING', decision: 'fail-open', error: truncate(String((error && error.message) || error)) });
  }

  try {
    const note = checkNodeTestDirectory(command, cwd);
    if (note) notes.push(note);
  } catch (error) {
    appendLog({ rule: 'NODE-TEST-DIRECTORY', decision: 'fail-open', error: truncate(String((error && error.message) || error)) });
  }

  try {
    const note = checkTmpRedirect(command);
    if (note) notes.push(note);
  } catch (error) {
    appendLog({ rule: 'TMP-REDIRECT', decision: 'fail-open', error: truncate(String((error && error.message) || error)) });
  }

  if (notes.length === 0) return allow();
  return allow(notes.join('\n\n'));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    failOpen('main', error);
  }
}

module.exports = {
  stripBom,
  readStdin,
  tokenize,
  unquote,
  splitPipelines,
  stripLeadingAssignments,
  STATUS_BEARING_HEAD_PATTERNS,
  hasExplicitStatusHandling,
  matchStatusBearingHead,
  checkPipeMasking,
  findNodeTestDirectoryArgs,
  checkNodeTestDirectory,
  findTmpRedirectTargets,
  checkTmpRedirect,
  LOG_FILE
};
