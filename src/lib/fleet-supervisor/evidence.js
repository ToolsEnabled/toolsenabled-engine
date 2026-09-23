'use strict';

// HARNESS-SIDE EVIDENCE VERIFICATION.
//
// WHY THIS EXISTS: docs/GEMINI-LANE-DOCTRINE.md rejects a lane's self-reported
// test result as worthless evidence -- and then review.js accepted the
// REVIEWER's self-reported execution on exactly the same faith. `parseVerdict()`
// gated an ACCEPTED verdict on the SYNTACTIC PRESENCE of RAN-COMMAND /
// RAN-OUTPUT; nothing ever re-ran the command and nothing ever compared its
// output to what the reviewer claimed. A reviewer could invent both strings.
//
// The owner's own benchmarking harness (LEAN-Bench) never does this: the
// HARNESS runs the code and the HARNESS parses the log. A model's account of
// its own execution is never an input to a score. This module is that rule,
// applied one level up:
//
//   reviewer says "I ran X and it printed Y"
//     -> WE run X ourselves, in the same review workspace
//     -> WE compare what it really printed against Y
//     -> a mismatch DISCARDS the verdict as unverifiable (it is not evidence
//        that the artifact is bad -- a reviewer misquoting output tells us
//        nothing about the lane, only that we cannot use this review).
//
// It also holds the two other machine checks that turn reviewer prose into
// typed facts: FAILURE-MODES flag parsing and the EFFECT non-triviality check.

const path = require('node:path');
const { spawnHidden } = require('../proc/hidden-spawn');
const { killProcessTree } = require('./kill-tree.js');
const { deleteEnvNames } = require('../env-scrub.js');

// Bumped whenever the review CONTRACT changes (fields required, rubric anchors,
// score threshold). Stamped onto every verdict so a historical accept/reject
// stays interpretable after the prompt is edited -- otherwise every prior
// verdict silently becomes incomparable to every later one.
const REVIEW_RUBRIC_VERSION = 2;

// ---------------------------------------------------------------------------
// The graded score
// ---------------------------------------------------------------------------
// DERIVED FROM OUR OWN RUBRIC, not copied from LEAN-Bench's 0.7 (that number is
// anchored to "mostly correct trading algorithm", a different domain). Our
// anchors, in the prompt, are:
//   1.0 executed against real data, output matched independently-obtained
//       ground truth, every consumed field traced to a real producer, reachable
//   0.8 correct against real data; a minor gap that does not affect the
//       briefed behaviour
//   0.6 behaviour verified but a doctrine countermeasure is unmet (the classic
//       case: correct code nobody can call) -- correct, NOT deliverable
//   0.3 executed, but produced wrong or unverifiable results
//   0.0 imagined schema / fabricated numbers / authority inversion
// Our accept bar is "deliverable as-is", so 0.6 must sit BELOW the line and 0.8
// ABOVE it. The threshold is the midpoint of those two adjacent anchors.
const REVIEW_SCORE_THRESHOLD = 0.7;
// A second, different-vendor reviewer is spent ONLY here: exactly the span
// between the two anchors that straddle the line. 0.9/1.0 (clear accept) and
// 0.3/0.0 (clear reject) get one reviewer. Rationale (LEAN-Bench, measured):
// two frontier judges on the same locked rubric disagreed by 0.178 mean and
// landed on OPPOSITE sides of the pass line on 15 of 49 pairs -- a single
// reviewer emitting one bit is near coin-flip precisely in this band, and a
// bit carries no distance-from-threshold so we cannot even tell which verdicts
// were borderline.
const REVIEW_SCORE_BAND = 0.1;

function scoreIsBorderline(score, {
  threshold = REVIEW_SCORE_THRESHOLD,
  band = REVIEW_SCORE_BAND
} = {}) {
  if (!Number.isFinite(score)) return false;
  return Math.abs(score - threshold) <= band + 1e-9;
}

// ---------------------------------------------------------------------------
// Command safety: the reviewer supplies this string, so it is parsed, not run
// ---------------------------------------------------------------------------
// DESIGN DECISIONS, stated because this is the one place a model's text becomes
// a process on this machine:
//
//  1. NEVER a shell. The string is tokenized here and spawned with
//     shell:false. Any top-level shell metacharacter (&& || | ; > < ` $( ) newline)
//     is a REFUSAL, not an escape-and-run. So chaining, redirection and command
//     substitution are unreachable rather than "quoted carefully".
//  2. ALLOWLIST of command shapes, not of arbitrary binaries. `node`, `npm`
//     (only test / run / run-script) and read-only `git` subcommands. Nothing
//     that installs, fetches, elevates, or names a shell can even be spelled --
//     `sudo`, `runas`, `powershell`, `cmd`, `npm install` are simply not on it.
//  3. NEVER elevated, and never wider than review already is. This runs with the
//     supervisor's own rights, cwd pinned to the review workspace, windowsHide,
//     and with credential-shaped environment variables stripped. It is strictly
//     LESS powerful than the reviewer CLI that already ran in that workspace.
//  4. BOUNDED: hard timeout, output cap, and the child is killed on expiry.
//  5. CONTAINED: for `node <script>`, the script path must resolve inside the
//     review workspace or the live repo root. `node -e` is allowed (it is the
//     shape the review prompt itself suggests) and carries no path.
const ALLOWED_COMMANDS = Object.freeze({
  node: null, // subcommand-free
  npm: Object.freeze(['test', 'run', 'run-script']),
  git: Object.freeze(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'cat-file', 'grep', 'blame'])
});
const SHELL_METACHARACTERS = /[;&|<>`\n\r]|\$\(/;
const DEFAULT_HARNESS_TIMEOUT_MS = 120_000;
const DEFAULT_HARNESS_CLEANUP_MS = 10_000;
const MAX_HARNESS_OUTPUT_BYTES = 200_000;
// Environment shapes that must never be inherited by a command a MODEL chose.
const STRIPPED_ENV = Object.freeze([
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY',
  'TELEGRAM_BOT_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'
]);

// Quote-aware tokenizer. Deliberately tiny and deliberately NOT a shell: it
// understands single and double quotes and nothing else, so anything it cannot
// account for becomes a refusal upstream rather than a surprise.
function tokenizeCommand(text) {
  const source = String(text || '');
  const tokens = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started || current) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) return { tokens: null, reason: 'unbalanced-quote' };
  if (started || current) tokens.push(current);
  return { tokens, reason: null };
}

function baseCommandName(token) {
  const bare = path.basename(String(token || '')).toLowerCase();
  return bare.replace(/\.(cmd|exe|bat|ps1)$/i, '');
}

// Returns { ok, argv, head, reason }. `ok:false` means we refuse to run it, and
// the reason is recorded as evidence rather than being retried differently.
function planHarnessCommand(commandText, { workspace, repoRoot = null } = {}) {
  const raw = String(commandText || '').trim();
  if (!raw) return { ok: false, reason: 'empty-command' };
  if (raw.length > 600) return { ok: false, reason: 'command-too-long' };
  // Checked on the RAW string, before tokenizing, so a metacharacter can never
  // survive inside a token and be handed to something that re-parses it.
  const inlineEval = /(^|\s)(-e|--eval|-p|--print)(\s|=)/.test(raw);
  if (!inlineEval && SHELL_METACHARACTERS.test(raw)) {
    return { ok: false, reason: 'command-contains-shell-metacharacters' };
  }
  const { tokens, reason } = tokenizeCommand(raw);
  if (!tokens) return { ok: false, reason };
  if (!tokens.length) return { ok: false, reason: 'empty-command' };

  const head = baseCommandName(tokens[0]);
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_COMMANDS, head)) {
    return { ok: false, reason: `command-not-on-allowlist: ${head}` };
  }
  const allowedSub = ALLOWED_COMMANDS[head];
  const args = tokens.slice(1);
  if (allowedSub) {
    const sub = (args.find(token => token && !token.startsWith('-')) || '').toLowerCase();
    if (!allowedSub.includes(sub)) {
      return { ok: false, reason: `${head}-subcommand-not-on-allowlist: ${sub || '(none)'}` };
    }
  }
  // Path containment for `node <script>`: the executed FILE must live in the
  // workspace or in the live repo. Inline eval carries no file and is exempt.
  if (head === 'node' && !inlineEval) {
    const script = args.find(token => token && !token.startsWith('-'));
    if (script) {
      const resolved = path.resolve(workspace, script);
      const roots = [path.resolve(workspace)];
      if (repoRoot) roots.push(path.resolve(repoRoot));
      const contained = roots.some(root => resolved === root || resolved.startsWith(root + path.sep));
      if (!contained) return { ok: false, reason: 'node-script-escapes-workspace-and-repo' };
    }
  }
  // `node` itself is spawned as this process's own executable, never as
  // whatever "node" happens to resolve to on PATH for a model-supplied string.
  const executable = head === 'node' ? process.execPath : tokens[0];
  return { ok: true, executable, args, head, argv: tokens, reason: null };
}

function harnessEnvironment(baseEnv = process.env) {
  /* `for (const name of STRIPPED_ENV) delete env[name]` until 2026-08-11 --
   * exact-case, so a machine carrying `openai_api_key` handed it to a command a
   * MODEL chose. MEASURED: harnessEnvironment() with that spelling produced a
   * surviving own key and a real child that read canonical OPENAI_API_KEY.
   * The removal decision belongs to one module; see src/lib/env-scrub.js. */
  const env = deleteEnvNames({ ...baseEnv }, STRIPPED_ENV);
  // Deterministic-ish output: no colour codes to normalize away later.
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return env;
}

// ASYNCHRONOUS ON PURPOSE. The obvious implementation is spawnSync -- shorter,
// and the caller is already inside an await. It is also wrong here: spawnSync
// blocks the whole Node event loop, and this runs inside the SUPERVISOR
// process, which is concurrently managing lanes, refilling slots, writing
// heartbeats and driving a second review. A two-minute blocking child would
// freeze all of that and make the supervisor's own liveness reporting a lie.
function runHarnessCommand(plan, {
  workspace,
  timeoutMs = DEFAULT_HARNESS_TIMEOUT_MS,
  cleanupTimeoutMs = DEFAULT_HARNESS_CLEANUP_MS,
  spawnImpl = spawnHidden,
  env = null
} = {}) {
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 120_000) {
    return Promise.reject(new TypeError('Harness cleanup timeout must be from 1 through 120000 milliseconds.'));
  }
  return new Promise(resolve => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawnImpl(plan.executable, plan.args, {
        cwd: workspace,
        windowsHide: true,
        shell: false,
        containProcessTree: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env || harnessEnvironment()
      });
    } catch (error) {
      return resolve({
        ran: false, code: 'SPAWN_THREW', exitCode: null, output: '',
        detail: String((error && error.message) || error).slice(0, 200),
        durationMs: Date.now() - startedAt
      });
    }

    let output = '';
    let settled = false;
    let finishing = false;
    const owned = typeof child.terminateJob === 'function' && child.jobOutcome && child.jobClosed;
    const finish = result => {
      if (settled || finishing) return;
      finishing = true;
      clearTimeout(timer);
      const complete = (outcome, cleanupConfirmed) => {
        if (settled) return;
        settled = true;
        resolve({ durationMs: Date.now() - startedAt, ...outcome,
          output: output.slice(0, MAX_HARNESS_OUTPUT_BYTES), cleanupConfirmed });
      };
      // The default Linux/Windows path owns a native descendant scope. Neither
      // a kill request nor the wrapper's exit proves the command stopped.
      // Preserve direct injected transports for existing process test seams,
      // while explicitly declining to claim descendant proof for that shape.
      if (!owned) { complete(result, false); return; }
      let cleanupTimer, fallbackTimer;
      const unproven = () => {
        if (typeof child.terminateRetainedWrapper === 'function') {
          Promise.resolve().then(() => child.terminateRetainedWrapper()).catch(() => {});
        }
        complete({ ...result, ran: false, code: 'CLEANUP_UNPROVEN', exitCode: null,
          detail: 'reviewer command ended without confirming descendant cleanup' }, false);
      };
      cleanupTimer = setTimeout(unproven, cleanupTimeoutMs);
      if (typeof child.terminateRetainedWrapper === 'function') {
        fallbackTimer = setTimeout(() => {
          Promise.resolve().then(() => child.terminateRetainedWrapper()).catch(() => {});
        }, Math.max(1, Math.floor(cleanupTimeoutMs / 2)));
      }
      Promise.all([child.jobOutcome, child.jobClosed]).then(([receipt, closed]) => {
        if (!receipt || !['exit', 'terminated', 'not-started'].includes(receipt.type)
            || receipt.activeProcesses !== 0 || receipt.failure || !closed || closed.failure) {
          unproven();
          return;
        }
        if (result.ran && (receipt.type !== 'exit' || !Number.isInteger(receipt.exitCode)
            || receipt.exitSignal)) {
          complete({ ...result, ran: false, code: 'TERMINATED_BY_SIGNAL', exitCode: null,
            detail: 'reviewer command ended without a normal root exit' }, true);
          return;
        }
        complete(result.ran ? { ...result, exitCode: receipt.exitCode } : result, true);
      }, unproven).finally(() => { clearTimeout(cleanupTimer); clearTimeout(fallbackTimer); });
    };
    const timer = setTimeout(() => {
      if (owned) Promise.resolve().then(() => child.terminateJob()).catch(() => {});
      else killProcessTree(child);
      finish({
        ran: false, code: 'TIMEOUT', exitCode: null,
        output: output.slice(0, MAX_HARNESS_OUTPUT_BYTES),
        detail: `reviewer command exceeded ${timeoutMs}ms`
      });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    // stdout and stderr are BOTH evidence: a reviewer legitimately quotes
    // either, so they are captured into one stream in arrival order.
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      stream.setEncoding('utf8');
      stream.on('data', chunk => { if (output.length < MAX_HARNESS_OUTPUT_BYTES) output += chunk; });
    }
    child.on('error', error => {
      if (owned) Promise.resolve().then(() => child.terminateJob()).catch(() => {});
      finish({
        ran: false, code: 'SPAWN_FAILED', exitCode: null, output: '',
        detail: String((error && error.code) || error.message).slice(0, 200)
      });
    });
    child.on('close', (exitCode, signal) => {
      // Node reports a null exit code when the child was terminated by a
      // signal. That is not a completed execution whose partial output can
      // verify a reviewer's claim: the command's answer was never established.
      if (!Number.isInteger(exitCode)) {
        return finish({
          ran: false,
          code: 'TERMINATED_BY_SIGNAL',
          exitCode: null,
          output: output.slice(0, MAX_HARNESS_OUTPUT_BYTES),
          detail: signal ? `reviewer command terminated by ${signal}` : 'reviewer command closed without an exit status'
        });
      }
      return finish({
        ran: true,
        code: null,
        exitCode,
        output: output.slice(0, MAX_HARNESS_OUTPUT_BYTES),
        detail: null
      });
    });
  });
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------
// DESIGN DECISION -- WHAT COUNTS AS A MATCH. Exact comparison is wrong here and
// would be worse than no check at all: real output carries timestamps, absolute
// paths, pids, durations and hex ids, and the reviewer is asked for "the real
// first line(s), <=300 chars", i.e. a deliberately partial quote. An exact
// matcher would fail almost every honest review and would then have to be
// switched off, which is how a safety check becomes decorative.
//
// So the comparison is layered, cheapest and strictest first:
//   1. NORMALIZE both sides: strip ANSI, collapse whitespace, and replace
//      volatile tokens (ISO timestamps, durations, absolute paths, uuids, long
//      hex, pids) with stable placeholders. This is the same discipline as
//      LEAN-Bench's determinism strippers, applied to the COMPARISON only -- we
//      never demand byte-identical reruns, which is not achievable for this
//      repo and is not a claim we make.
//   2. EQUAL after normalization           -> 'exact-normalized'
//   3. CLAIM IS A SUBSTRING of the real output -> 'substring'. The reverse
//      containment (real output inside a longer quote) is also accepted, but
//      ONLY when the real output is substantial: without that floor, a run that
//      prints "3" would match any claim anywhere containing a 3.
//   4. KEY-TOKEN OVERLAP: identifier- and number-shaped tokens in the claim must
//      mostly appear in the real output -- 0.7 of them -> 'token-overlap'. This
//      tolerates re-ordering and paraphrase while still catching invention.
//      PLUS a hard rule that overlap alone cannot satisfy: EVERY NUMBER in the
//      claim must really appear in the output. Numbers are the payload of an
//      execution claim -- counts, totals, page numbers -- and fabricating one is
//      precisely the s03 escape (a wrong count reported with ok:true). Prose may
//      drift; a number may not.
//   5. otherwise                            -> 'mismatch'
const MATCH_TOKEN_RATIO = 0.7;
const MIN_REVERSE_SUBSTRING_CHARS = 24;

const NORMALIZERS = Object.freeze([
  [/\[[0-9;?]*[ -/]*[@-~]/g, ''],                                   // ANSI
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>'],
  [/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<TIME>'],
  [/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, '<UUID>'],
  [/\b[0-9a-fA-F]{12,}\b/g, '<HEX>'],
  [/\b[A-Za-z]:[\\/][^\s"']{2,}/g, '<PATH>'],                             // windows absolute
  [/(?:^|\s)\/(?:[A-Za-z0-9_.-]+\/){2,}[A-Za-z0-9_.-]*/g, ' <PATH>'],     // posix absolute
  [/\b\d+(?:\.\d+)?\s?ms\b/gi, '<DUR>'],
  [/\b\d+(?:\.\d+)?\s?s(?:ec(?:onds?)?)?\b/gi, '<DUR>'],
  [/\bpid[:= ]\s*\d+/gi, 'pid <PID>']
]);

function normalizeOutput(text) {
  let value = String(text === null || text === undefined ? '' : text);
  value = value.replace(/\r\n?/g, '\n');
  for (const [pattern, replacement] of NORMALIZERS) value = value.replace(pattern, replacement);
  return value.replace(/\s+/g, ' ').trim();
}

// Numbers and identifier-ish words. Placeholders introduced by normalization
// are deliberately excluded -- matching on '<TS>' would be matching on nothing.
function salientTokens(normalized) {
  const raw = String(normalized || '').match(/[A-Za-z_][A-Za-z0-9_.-]{2,}|\d+(?:[./:]\d+)*/g) || [];
  const skip = new Set(['ts', 'time', 'uuid', 'hex', 'path', 'dur', 'pid']);
  const tokens = [];
  for (const token of raw) {
    const bare = token.replace(/^<|>$/g, '');
    if (skip.has(bare.toLowerCase())) continue;
    tokens.push(bare);
  }
  return tokens;
}

function compareOutputs(actual, claimed) {
  const normalizedActual = normalizeOutput(actual);
  const normalizedClaimed = normalizeOutput(claimed);
  if (!normalizedClaimed) {
    return { match: false, mode: 'no-claim', overlap: 0, claimedTokens: 0, matchedTokens: 0 };
  }
  if (normalizedActual === normalizedClaimed) {
    return { match: true, mode: 'exact-normalized', overlap: 1, claimedTokens: 0, matchedTokens: 0 };
  }
  if (normalizedActual.includes(normalizedClaimed)) {
    return { match: true, mode: 'substring', overlap: 1, claimedTokens: 0, matchedTokens: 0, missingNumbers: [] };
  }
  if (normalizedActual.length >= MIN_REVERSE_SUBSTRING_CHARS && normalizedClaimed.includes(normalizedActual)) {
    return { match: true, mode: 'substring-reverse', overlap: 1, claimedTokens: 0, matchedTokens: 0, missingNumbers: [] };
  }
  const claimedTokens = salientTokens(normalizedClaimed);
  if (!claimedTokens.length) {
    // Nothing checkable in the claim. That is not a match -- it is an absence
    // of evidence, and it is reported as such rather than passed.
    return { match: false, mode: 'claim-carries-no-checkable-token', overlap: 0, claimedTokens: 0, matchedTokens: 0, missingNumbers: [] };
  }
  const actualTokens = new Set(salientTokens(normalizedActual));
  let matched = 0;
  for (const token of claimedTokens) if (actualTokens.has(token)) matched += 1;
  const overlap = matched / claimedTokens.length;
  // The numeric rule: a claimed number that the command never printed is not a
  // paraphrase, it is an invention, and no amount of matching prose around it
  // makes it evidence.
  const missingNumbers = [...new Set(claimedTokens.filter(token => /^\d/.test(token)))]
    .filter(token => !actualTokens.has(token));
  if (missingNumbers.length) {
    return {
      match: false, mode: 'number-not-in-real-output', overlap,
      claimedTokens: claimedTokens.length, matchedTokens: matched, missingNumbers: missingNumbers.slice(0, 8)
    };
  }
  if (overlap >= MATCH_TOKEN_RATIO) {
    return { match: true, mode: 'token-overlap', overlap, claimedTokens: claimedTokens.length, matchedTokens: matched, missingNumbers: [] };
  }
  return { match: false, mode: 'mismatch', overlap, claimedTokens: claimedTokens.length, matchedTokens: matched, missingNumbers: [] };
}

// ---------------------------------------------------------------------------
// verifyEvidence -- the harness becomes the executor of record
// ---------------------------------------------------------------------------
// Returns a typed record. `verified` is the only field the gate reads; every
// other field exists so a human (or --status) can tell the difference between
// "the reviewer lied", "the command legitimately varies between runs" and "we
// refused to run what it asked for".
//
// NON-DETERMINISM (explicit design decision): a command whose output honestly
// changes between runs must NOT be scored as a lie. So on a first-run mismatch
// we run the command a SECOND time and compare the two RUNS to each other:
//   * runs agree with each other, claim matches neither -> 'fabricated'
//     (deterministic command; the reviewer's quote is not what it produces)
//   * runs disagree with each other, claim matches one  -> 'nondeterministic'
//     and VERIFIED: the reviewer quoted a real run
//   * runs disagree, claim matches neither              -> 'nondeterministic'
//     and NOT verified, but reported as unverifiable-nondeterministic, which is
//     a different fact from fabrication and is labelled as one.
// The second run only happens on mismatch, so the common path costs one
// execution.
async function verifyEvidence({
  command,
  claimedOutput,
  workspace,
  repoRoot = null,
  timeoutMs = DEFAULT_HARNESS_TIMEOUT_MS,
  changedPaths = null,
  spawnImpl = spawnHidden,
  env = null
} = {}) {
  const record = {
    attempted: true,
    verified: false,
    classification: null,
    reason: null,
    command: command ? String(command).slice(0, 400) : null,
    executedArgv: null,
    exitCode: null,
    harnessOutput: null,
    claimedOutput: claimedOutput ? String(claimedOutput).slice(0, 800) : null,
    match: null,
    reruns: 0,
    durationMs: 0,
    warnings: [],
    // Surfaced, never gated on: a harness that runs a throwaway script which
    // requires the artifact will not name a changed path, so treating this as
    // a gate would punish exactly the procedure the review prompt asks for.
    commandNamesChangedFile: null
  };
  if (!workspace) {
    record.attempted = false;
    record.classification = 'no-workspace';
    record.reason = 'no review workspace exists to re-execute the command in';
    return record;
  }
  const plan = planHarnessCommand(command, { workspace, repoRoot });
  if (!plan.ok) {
    record.classification = 'refused';
    record.reason = `harness-refused-to-run-reviewer-command: ${plan.reason}`;
    return record;
  }
  record.executedArgv = [plan.executable, ...plan.args].join(' ').slice(0, 400);
  if (Array.isArray(changedPaths) && changedPaths.length) {
    const text = String(command || '');
    record.commandNamesChangedFile = changedPaths.some(file => {
      const base = path.basename(String(file || ''));
      return base.length > 2 && text.includes(base);
    });
  }

  const first = await runHarnessCommand(plan, { workspace, timeoutMs, spawnImpl, env });
  record.reruns = 1;
  record.durationMs = first.durationMs;
  record.exitCode = first.exitCode;
  record.harnessOutput = String(first.output || '').slice(0, 1200);
  if (!first.ran) {
    record.classification = first.code === 'TIMEOUT' ? 'timeout' : 'not-executable';
    record.reason = `harness-could-not-execute-reviewer-command: ${first.code} ${first.detail || ''}`.trim().slice(0, 300);
    return record;
  }

  const compared = compareOutputs(first.output, claimedOutput);
  record.match = compared;
  if (compared.match) {
    record.verified = true;
    record.classification = 'match';
    record.reason = `harness re-ran the reviewer's command and the real output matched the claim (${compared.mode})`;
    // DESIGN DECISION: a non-zero exit does NOT by itself discard a matched
    // verdict. `git diff` exits 1 whenever there ARE differences, and a
    // reviewer that quotes that output honestly is not the failure this check
    // exists to catch. It is recorded and surfaced instead of being silently
    // fused into the gate.
    if (record.exitCode !== 0) record.warnings.push(`harness-exit-nonzero:${record.exitCode}`);
    return record;
  }

  // Mismatch. Before calling it fabrication, prove the command is deterministic.
  const second = await runHarnessCommand(plan, { workspace, timeoutMs, spawnImpl, env });
  record.reruns = 2;
  record.durationMs += second.durationMs;
  if (!second.ran) {
    record.classification = 'unstable';
    record.reason = `harness re-run mismatched the claim and a confirming re-run failed (${second.code}); treated as unverifiable, not as a false claim`;
    return record;
  }
  const runsAgree = normalizeOutput(first.output) === normalizeOutput(second.output);
  if (runsAgree) {
    record.classification = 'fabricated';
    const numbers = compared.missingNumbers && compared.missingNumbers.length
      ? `; numbers claimed but never printed: ${compared.missingNumbers.join(', ')}`
      : '';
    record.reason = 'reviewer RAN-OUTPUT does not match what the command really prints on this machine '
      + `(deterministic across ${record.reruns} runs; ${compared.matchedTokens}/${compared.claimedTokens} claimed tokens present${numbers})`;
    return record;
  }
  const againstSecond = compareOutputs(second.output, claimedOutput);
  if (againstSecond.match) {
    record.verified = true;
    record.classification = 'nondeterministic';
    record.match = againstSecond;
    record.warnings.push('command-output-varies-between-runs');
    record.reason = 'the command\'s output legitimately varies between runs; the reviewer\'s quote matched one real run';
    if (record.exitCode !== 0) record.warnings.push(`harness-exit-nonzero:${record.exitCode}`);
    return record;
  }
  record.classification = 'nondeterministic';
  record.warnings.push('command-output-varies-between-runs');
  record.reason = 'the command\'s output varies between runs and the reviewer\'s quote matched neither; '
    + 'unverifiable, and NOT recorded as a false claim';
  return record;
}

// ---------------------------------------------------------------------------
// FAILURE-MODES: typed flags, not an opaque string
// ---------------------------------------------------------------------------
// Before this, `FAILURE-MODES: imagined-schema=fail, ...` was stored verbatim
// and never read, so a reviewer could report a doctrine violation and ACCEPT in
// the same breath and the machinery recorded both without complaint.
const KNOWN_FAILURE_MODES = Object.freeze([
  'imagined-schema', 'unreachable-code', 'authority-inversion', 'fabricated-numbers', 'scope'
]);

function parseFailureModes(text) {
  const raw = String(text === null || text === undefined ? '' : text).trim();
  const result = {
    present: Boolean(raw),
    modes: {},
    failing: [],
    unknownValues: [],
    unrecognizedModes: [],
    missingModes: []
  };
  if (!raw) {
    result.missingModes = KNOWN_FAILURE_MODES.slice();
    return result;
  }
  for (const chunk of raw.split(/[,;]/)) {
    const pair = /^\s*([A-Za-z][A-Za-z0-9_-]*)\s*[=:]\s*([A-Za-z/-]+)\s*$/.exec(chunk);
    if (!pair) continue;
    const mode = pair[1].toLowerCase();
    const value = pair[2].toLowerCase();
    if (!KNOWN_FAILURE_MODES.includes(mode)) { result.unrecognizedModes.push(mode); continue; }
    if (value === 'pass' || value === 'ok') result.modes[mode] = 'pass';
    else if (value === 'fail' || value === 'failed') result.modes[mode] = 'fail';
    else { result.modes[mode] = 'unknown'; result.unknownValues.push(`${mode}=${pair[2]}`); }
  }
  result.failing = Object.entries(result.modes).filter(([, value]) => value === 'fail').map(([mode]) => mode);
  result.missingModes = KNOWN_FAILURE_MODES.filter(mode => !Object.prototype.hasOwnProperty.call(result.modes, mode));
  return result;
}

// ---------------------------------------------------------------------------
// EFFECT: did the artifact actually DO anything
// ---------------------------------------------------------------------------
// LEAN-Bench's `trade` stage exists solely to catch code that compiles, runs
// clean, and does nothing; `no_trades_placed` is the second most common primary
// failure in that corpus. Our doctrine failure mode #3 (unreachable/unregistered
// code -- 100% of batch 1) is the same class and we had no analogue: a reviewer
// could satisfy the old contract with a command that imports a module and
// prints nothing.
const TRIVIAL_EFFECTS = Object.freeze([
  'undefined', 'null', 'nothing', 'none', 'n/a', 'na', 'no output', 'no effect',
  'no change', '0', 'false', 'void', '-', 'empty', 'nil', 'no side effects',
  'no observable effect', 'unknown', 'not applicable'
]);

function checkEffect(text) {
  const raw = String(text === null || text === undefined ? '' : text).trim();
  const result = { present: Boolean(raw), value: raw ? raw.slice(0, 300) : null, trivial: false, reason: null };
  if (!raw) {
    result.reason = 'no EFFECT field: the review never says what observable change the artifact produced';
    return result;
  }
  const normalized = raw.toLowerCase().replace(/[.!]+$/, '').replace(/^\(|\)$/g, '').trim();
  if (TRIVIAL_EFFECTS.includes(normalized)) {
    result.trivial = true;
    result.reason = `EFFECT is trivial ("${raw.slice(0, 60)}"): an artifact that changes nothing observable is the silent-failure mode this field exists to catch`;
    return result;
  }
  if (normalized.length < 10) {
    result.trivial = true;
    result.reason = `EFFECT is too short to name an observable change ("${raw.slice(0, 60)}")`;
    return result;
  }
  return result;
}

module.exports = {
  ALLOWED_COMMANDS,
  DEFAULT_HARNESS_TIMEOUT_MS,
  KNOWN_FAILURE_MODES,
  MATCH_TOKEN_RATIO,
  REVIEW_RUBRIC_VERSION,
  REVIEW_SCORE_BAND,
  REVIEW_SCORE_THRESHOLD,
  checkEffect,
  compareOutputs,
  harnessEnvironment,
  normalizeOutput,
  parseFailureModes,
  planHarnessCommand,
  runHarnessCommand,
  salientTokens,
  scoreIsBorderline,
  tokenizeCommand,
  verifyEvidence
};
