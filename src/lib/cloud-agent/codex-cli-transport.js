'use strict';

// R1177 S1: the real transport that binds src/lib/providers/codex-cloud.js to
// the LOCAL `codex` CLI (verified against codex-cli 0.146.0 on this machine).
// It implements exactly the method surface the provider expects from an
// injected transport -- bindEnvironment / createTask / getTask /
// getTaskChanges / cancelTask -- plus two transport-specific READ-ONLY
// helpers (listTasks, fetchTaskDiff). Nothing here writes a checkout, applies
// a diff, or shells out through a command string: every child process is
// spawned with an explicit argv array, shell:false, windowsHide:true, a
// bounded per-call timeout, and a bounded output cap. Task prompts travel on
// stdin, not argv: codex cloud exec documents QUERY as optional and reports
// "Reading query from stdin..." when it is omitted. This also avoids Windows'
// 8191-character command-line ceiling without truncating a person's task.
//
// Fail-closed ground rules, in the order they bit previous sessions:
//   - `codex cloud exec` can print `Error: environment '<x>' not found` and
//     still EXIT 0 (verified). Exit code alone therefore never proves
//     success; every parser checks output content for error signatures first.
//   - A timeout or output-limit kill is NEVER success and never silently
//     absorbed here: it surfaces as a distinct error code so the session
//     layer can absorb it into UNKNOWN (truncation is continuation, not
//     completion).
//   - Unrecognized `codex cloud status` output maps to a null status, which
//     the provider's STATUS_MAP renders as UNKNOWN -- never as SUCCEEDED.
//   - Unparseable `codex cloud list --json` output is a hard
//     CODEX_CLI_OUTPUT_UNPARSEABLE error, never an empty-list "success".
//   - codex-cli 0.146.0 has NO cancel subcommand and its diff output (a
//     unified diff string) cannot supply the sha256/sizeBytes entries the
//     provider-neutral ChangeManifest requires; cancelTask and
//     getTaskChanges fail closed with distinct codes instead of fabricating
//     evidence. The raw diff stays available read-only via fetchTaskDiff.
//   - The CLI has no idempotency-key lookup, so findTaskByIdempotencyKey is
//     deliberately ABSENT: the provider's reconcile() then reports an
//     ambiguous submission as UNKNOWN instead of guessing.

const crypto = require('node:crypto');
const { spawnHidden } = require('../proc/hidden-spawn');
const { CloudAgentError } = require('./errors');

const DEFAULT_CODEX_BINARY = 'codex';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES_CEILING = 64 * 1024 * 1024;
const MAX_STDERR_EXCERPT_CHARS = 1024; // hard bound; an error message never carries a raw dump
const MAX_QUERY_CHARS = 32_768;
const MAX_LIST_LIMIT = 20; // documented CLI bound: --limit accepts 1-20

// Mirrors of the contract's own shape rules, revalidated here because a
// transport must never trust its caller enough to place an unchecked string
// into an argv slot (a leading "-" would be parsed as a flag by the CLI).
// Observed live 2026-08-08: real environment ids are 32 lowercase hex chars and
// may START WITH A DIGIT, so the first character class must include digits --
// an id-shaped example is deliberately not quoted here, because a real
// environment id identifies a specific person's private cloud environment and
// this file ships inside the capability payload. Display labels (Owner/repo)
// stay rejected.
const ENVIRONMENT_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
// MEASURED 2026-09-03 against codex-cli 0.146.1 on this machine: a real
// pagination cursor from `codex cloud list --json` is 330 characters long,
// STARTS WITH "+", and carries ":", "~" and "#" --
//   +RID:~<base64>==#RT:1#TRC:1#RTD:<base64>#ISV:2#IEO:65567#QCF:8#CID:2
// The previous class ([A-Za-z0-9] then [A-Za-z0-9+/=_.-]) rejected the
// provider's own cursor at its very first character. cloudTaskStatus pages by
// feeding this string straight back in, so page 2 was unreachable: every
// status read for a task outside the newest 20 died with
// CODEX_CLI_INPUT_INVALID naming a "cursor" the caller never supplied and
// could not change (14 such cloud.task_status failures in the action ledger).
// The guarantee that matters for an argv slot is unchanged, only stated
// positively: printable ASCII with no whitespace and no control bytes,
// bounded to 512 characters, and NEVER a leading "-" -- that, and only that,
// is what the CLI would read as a flag.
const CURSOR = /^(?!-)[\x21-\x7E]{1,512}$/;

// Verified output signatures (codex-cli 0.146.0). The env-not-found line is
// checked before the generic Error: line because it IS a generic Error: line.
const ENV_NOT_FOUND_PATTERN = /environment '([^']{1,128})' not found/;
const REPORTED_ERROR_PATTERN = /^\s*error:\s?.*$/im;
// Task ids observed from `codex cloud list --json` are `task_e_...`. A future
// id shape simply fails to match, which downgrades the submission outcome to
// UNKNOWN -- fail closed, never a guessed id.
const TASK_ID_IN_OUTPUT = /\btask_e_[A-Za-z0-9]{4,64}\b/;
const LABELED_STATUS_LINE = /^\s*status\s*[:=]\s*([A-Za-z][A-Za-z_-]{0,31})\s*$/im;

function fail(code, message) { throw new CloudAgentError(code, message); }

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function excerpt(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return '(no output)';
  return value.length <= MAX_STDERR_EXCERPT_CHARS ? value : `${value.slice(0, MAX_STDERR_EXCERPT_CHARS)}...[truncated]`;
}

function boundedField(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function requireEnvironmentId(value) {
  if (typeof value !== 'string' || !ENVIRONMENT_ID.test(value)) {
    fail('CODEX_CLI_INPUT_INVALID', 'A codex cloud environment id must match the contract environment shape.');
  }
  return value;
}

function requireTaskId(value) {
  if (typeof value !== 'string' || !TASK_ID.test(value)) {
    fail('CODEX_CLI_INPUT_INVALID', 'A codex cloud task id must be an opaque [A-Za-z0-9_-] identifier.');
  }
  return value;
}

// Deterministic, credential-free acknowledgment token for a bound
// environment; shaped to satisfy the contract's OPAQUE environmentRef rule.
function environmentRefFor(environment) {
  return `cli-env-${crypto.createHash('sha256').update(environment).digest('hex').slice(0, 24)}`;
}

// Content-level error detection. Runs on EVERY successful (exit 0) CLI call
// because codex-cli 0.146.0 reports at least env-not-found at exit 0.
function detectReportedError(stdout, stderr, opLabel, taskId) {
  const combined = `${stdout || ''}\n${stderr || ''}`;
  // Native cloud diff reported this exact task-details 404 at exit zero.
  // Recognize only the requested task, fixed provider endpoint and closed
  // response body. Unknown CLI prose stays generic, and diff body text is
  // excluded by the caller before this detector runs.
  if (opLabel === 'cloud diff' && typeof taskId === 'string' && TASK_ID.test(taskId)) {
    const unavailable = `Error: http error: get_task_details failed: GET https://chatgpt.com/backend-api/wham/tasks/${taskId} failed: 404 Not Found; content-type=application/json; body={"detail":"Invalid task ID"}`;
    if (combined.split(/\r?\n/).some(line => line.trim() === unavailable)) {
      fail('CODEX_CLI_TASK_NOT_VISIBLE',
        'This Codex Cloud task is not available to the selected account. Check the task ID and sign in to the account that created it.');
    }
  }
  const envMatch = ENV_NOT_FOUND_PATTERN.exec(combined);
  if (envMatch) {
    fail('CODEX_CLI_ENV_NOT_FOUND', `codex ${opLabel}: environment '${envMatch[1]}' is not a known Codex Cloud environment.`);
  }
  const reported = REPORTED_ERROR_PATTERN.exec(combined);
  if (reported) {
    fail('CODEX_CLI_REPORTED_ERROR', `codex ${opLabel} reported an error regardless of its exit code: ${excerpt(reported[0])}`);
  }
}

// `codex cloud status` has no --json flag (verified via --help), so its
// output format is not contractually known. Parse defensively: accept a
// whole-output JSON object or a labeled `Status: <token>` line; anything
// else is a null status, which the provider maps to UNKNOWN -- never to
// success.
function parseStatusOutput(taskId, stdout) {
  const trimmed = (stdout || '').trim();
  if (trimmed.startsWith('{')) {
    let parsed = null;
    try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
    if (isPlainObject(parsed)) {
      return Object.freeze({
        id: boundedField(parsed.id, 128) || taskId,
        status: typeof parsed.status === 'string' && parsed.status.length <= 64 ? parsed.status.toLowerCase() : null
      });
    }
  }
  const labeled = LABELED_STATUS_LINE.exec(stdout || '');
  if (labeled) return Object.freeze({ id: taskId, status: labeled[1].toLowerCase() });
  return Object.freeze({ id: taskId, status: null });
}

// Strict parse of the one CLI surface with a documented JSON envelope:
// `codex cloud list --json` emits {"tasks":[...],"cursor":...}. Anything
// else is refused outright rather than read as an empty result.
function parseListJson(stdout, opLabel) {
  let parsed = null;
  try { parsed = JSON.parse((stdout || '').trim()); } catch { parsed = null; }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.tasks)) {
    fail('CODEX_CLI_OUTPUT_UNPARSEABLE', `codex ${opLabel} did not emit the documented {"tasks":[...]} JSON envelope; refusing to interpret: ${excerpt(stdout)}`);
  }
  return parsed;
}

function normalizeListedTask(raw, index) {
  if (!isPlainObject(raw)) {
    fail('CODEX_CLI_OUTPUT_UNPARSEABLE', `codex cloud list emitted a non-object task at index ${index}; refusing to report a partial task list.`);
  }
  const id = boundedField(raw.id, 128);
  if (!id) {
    fail('CODEX_CLI_OUTPUT_UNPARSEABLE', `codex cloud list emitted a task without a bounded id at index ${index}; refusing to report a partial task list.`);
  }
  const summary = isPlainObject(raw.summary) ? raw.summary : null;
  return Object.freeze({
    id,
    status: typeof raw.status === 'string' && raw.status.length <= 64 ? raw.status : null,
    title: boundedField(raw.title, 512),
    url: boundedField(raw.url, 1024),
    updatedAt: boundedField(raw.updated_at, 64),
    environmentId: boundedField(raw.environment_id, 128),
    environmentLabel: boundedField(raw.environment_label, 256),
    filesChanged: summary && Number.isSafeInteger(summary.files_changed) ? summary.files_changed : null,
    isReview: typeof raw.is_review === 'boolean' ? raw.is_review : null,
    attemptTotal: Number.isSafeInteger(raw.attempt_total) ? raw.attempt_total : null
  });
}

// One bounded child process per CLI call: explicit argv, shell:false,
// windowsHide:true, output cap, kill-on-timeout. Resolves only on a clean
// exit 0; every other outcome is a distinct, typed error.
//
// `env` is passed through EXACTLY as configured or not at all. There is no
// merge with process.env here on purpose: the composed launch environment
// from src/lib/multi-account/launch.js is already a full, scrubbed
// environment whose CODEX_HOME pins which account serves the call. Merging
// process.env over it would reintroduce the ambient CODEX_HOME that the
// 2026-08-09 wrong-account incident came from, and could re-admit a billing
// credential that launchEnvironment() deliberately stripped.
function runCli(config, args, stdin = null) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      const spawnOptions = {
        shell: false,
        windowsHide: true,
        stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe']
      };
      if (config.env !== null) spawnOptions.env = config.env;
      child = config.spawnImpl(config.codexBinary, [...config.prefixArgs, ...args], spawnOptions);
    } catch (error) {
      reject(new CloudAgentError('CODEX_CLI_SPAWN_FAILED', `The codex CLI could not be started: ${excerpt(error && error.message)}`));
      return;
    }
    if (!child || typeof child.on !== 'function') {
      reject(new CloudAgentError('CODEX_CLI_SPAWN_FAILED', 'The injected spawn implementation did not return a child process.'));
      return;
    }

    let settled = false;
    let totalBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];

    const killQuietly = () => {
      try { if (typeof child.kill === 'function') child.kill(); } catch { /* already gone */ }
    };
    const finish = (settler) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settler();
    };

    // A timeout is NEVER success: the child is killed and the caller gets a
    // distinct code whose only honest meaning is "outcome unknown".
    const timer = setTimeout(() => {
      killQuietly();
      finish(() => reject(new CloudAgentError('CODEX_CLI_TIMEOUT', `codex ${args.slice(0, 2).join(' ')} did not finish within ${config.timeoutMs}ms and was killed; its real outcome is unknown -- a timeout is never success.`)));
    }, Math.max(1, config.timeoutMs));

    const collectInto = (chunks) => (chunk) => {
      const text = typeof chunk === 'string' ? chunk : String(chunk);
      totalBytes += Buffer.byteLength(text, 'utf8');
      if (totalBytes > config.maxOutputBytes) {
        killQuietly();
        finish(() => reject(new CloudAgentError('CODEX_CLI_OUTPUT_LIMIT_EXCEEDED', `codex ${args.slice(0, 2).join(' ')} exceeded the ${config.maxOutputBytes}-byte output cap and was killed; its real outcome is unknown.`)));
        return;
      }
      chunks.push(text);
    };
    if (child.stdout && typeof child.stdout.on === 'function') {
      if (typeof child.stdout.setEncoding === 'function') child.stdout.setEncoding('utf8');
      child.stdout.on('data', collectInto(stdoutChunks));
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      if (typeof child.stderr.setEncoding === 'function') child.stderr.setEncoding('utf8');
      child.stderr.on('data', collectInto(stderrChunks));
    }

    if (stdin !== null) {
      if (!child.stdin || typeof child.stdin.end !== 'function') {
        killQuietly();
        finish(() => reject(new CloudAgentError('CODEX_CLI_STDIN_UNAVAILABLE',
          'The codex CLI process did not expose stdin, so the task contract was not submitted.')));
        return;
      }
      // A failed write means the query may not have reached the CLI. Even EPIPE
      // cannot be converted into an ambiguous-submit null merely because the
      // child later exits 0: that would turn "could not tell" into a definite
      // answer. This failure is per-call only; the transport does not latch it.
      if (typeof child.stdin.on === 'function') {
        child.stdin.on('error', (error) => {
          killQuietly();
          finish(() => reject(new CloudAgentError('CODEX_CLI_STDIN_WRITE_FAILED',
            `The task query could not be written to codex CLI stdin (${excerpt(error && error.code || error && error.message)}); the submission outcome is unknown and this is NOT a claim that the task is absent.`)));
        });
      }
      child.stdin.end(stdin, 'utf8');
    }

    child.on('error', (error) => {
      finish(() => reject(new CloudAgentError('CODEX_CLI_SPAWN_FAILED', `The codex CLI could not be started: ${excerpt(error && error.message)}`)));
    });
    child.on('close', (exitCode) => {
      finish(() => {
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        if (exitCode !== 0) {
          // Classify by CONTENT before falling back to the generic exit-code
          // error. The same condition reports different exit codes across
          // subcommands -- MEASURED on this machine: an unknown --env exits 0
          // from `cloud list` and exits 1 from `cloud exec`, with identical
          // "environment '<id>' not found" text. Rejecting on the exit code
          // alone would erase that signature for exec callers and hand them an
          // untyped CODEX_CLI_NONZERO_EXIT, which is precisely the error a
          // caller cannot act on. This is the mirror of the rule above it:
          // exit 0 never proves success, and nonzero never erases a known
          // diagnosis.
          try {
            const opLabel = args.slice(0, 2).join(' ');
            const diffBody = opLabel === 'cloud diff' && /^(diff --git |--- |Index: )/.test(stdout);
            detectReportedError(diffBody ? '' : stdout, stderr, opLabel, args.at(-1));
          } catch (classified) {
            reject(classified);
            return;
          }
          reject(new CloudAgentError('CODEX_CLI_NONZERO_EXIT', `codex ${args.slice(0, 2).join(' ')} exited with status ${exitCode}: ${excerpt(stderr || stdout)}`));
          return;
        }
        // Exit 0 is necessary but NOT sufficient (verified: env-not-found
        // exits 0); each caller still runs detectReportedError on content.
        resolve({ stdout, stderr });
      });
    });
  });
}

function validateFactoryOptions(options) {
  if (!isPlainObject(options)) fail('CODEX_CLI_TRANSPORT_INVALID', 'createCodexCliTransport options must be a plain object.');
  const codexBinary = options.codexBinary === undefined ? DEFAULT_CODEX_BINARY : options.codexBinary;
  if (typeof codexBinary !== 'string' || !codexBinary.trim() || codexBinary.length > 260 || codexBinary.includes('\u0000')) {
    fail('CODEX_CLI_TRANSPORT_INVALID', 'codexBinary must be a non-empty bounded string.');
  }
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    fail('CODEX_CLI_TRANSPORT_INVALID', `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
  }
  const maxOutputBytes = options.maxOutputBytes === undefined ? DEFAULT_MAX_OUTPUT_BYTES : options.maxOutputBytes;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > MAX_OUTPUT_BYTES_CEILING) {
    fail('CODEX_CLI_TRANSPORT_INVALID', `maxOutputBytes must be an integer between 1024 and ${MAX_OUTPUT_BYTES_CEILING}.`);
  }
  // THE NO-PROVIDER SWITCH (R38). This transport runs the real local `codex`
  // binary (`codex cloud exec/list/status/diff`); the packaged-QA fence that
  // is supposed to stop provider spend must reach it. See
  // src/lib/proc/hidden-spawn.js.
  const spawnImpl = options.spawnImpl === undefined ? spawnHidden : options.spawnImpl;
  if (typeof spawnImpl !== 'function') fail('CODEX_CLI_TRANSPORT_INVALID', 'spawnImpl must be a function when provided.');
  const branch = options.branch === undefined ? null : options.branch;
  if (branch !== null && (typeof branch !== 'string' || !BRANCH.test(branch) || branch.includes('..'))) {
    fail('CODEX_CLI_TRANSPORT_INVALID', 'branch must be a plain git branch name (no leading dash, no ".." segment).');
  }
  const attempts = options.attempts === undefined ? null : options.attempts;
  if (attempts !== null && (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10)) {
    fail('CODEX_CLI_TRANSPORT_INVALID', 'attempts must be an integer between 1 and 10 when provided.');
  }
  const buildQuery = options.buildQuery === undefined ? null : options.buildQuery;
  if (buildQuery !== null && typeof buildQuery !== 'function') {
    fail('CODEX_CLI_TRANSPORT_INVALID', 'buildQuery must be a function when provided.');
  }
  // Argv the resolved executable needs BEFORE the codex subcommand (e.g. a
  // launcher that takes a script path). Validated with the same rule as every
  // other argv slot: a leading "-" would be reparsed as a flag.
  const prefixArgs = options.prefixArgs === undefined ? [] : options.prefixArgs;
  if (!Array.isArray(prefixArgs) || prefixArgs.length > 8
      || prefixArgs.some(arg => typeof arg !== 'string' || !arg.trim() || arg.length > 260 || arg.startsWith('-') || arg.includes('\u0000'))) {
    fail('CODEX_CLI_TRANSPORT_INVALID', 'prefixArgs must be an array of at most 8 non-empty bounded strings that cannot be mistaken for CLI flags.');
  }
  // A full child environment, or null to inherit this process's. Values are
  // required to be strings so a stray object/number cannot reach spawn, and
  // the whole map is never logged: it legitimately carries the account's
  // CODEX_HOME and must be treated as sensitive.
  const env = options.env === undefined ? null : options.env;
  if (env !== null) {
    if (!isPlainObject(env)) fail('CODEX_CLI_TRANSPORT_INVALID', 'env must be a plain object of string values when provided.');
    for (const key of Object.keys(env)) {
      if (typeof env[key] !== 'string') {
        fail('CODEX_CLI_TRANSPORT_INVALID', `env.${key} must be a string; a non-string environment value cannot be passed to spawn.`);
      }
    }
  }
  return { codexBinary, timeoutMs, maxOutputBytes, spawnImpl, branch, attempts, buildQuery, prefixArgs, env: env === null ? null : Object.freeze({ ...env }) };
}

function requireQuery(buildQuery, payload) {
  if (typeof buildQuery !== 'function') {
    fail('CODEX_CLI_QUERY_NOT_CONFIGURED', 'createTask requires a buildQuery(payload) option: the provider payload carries only the taskHash, never the task prompt text itself.');
  }
  const query = buildQuery(payload);
  if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY_CHARS || query.startsWith('-') || query.includes('\u0000')) {
    fail('CODEX_CLI_QUERY_INVALID', `buildQuery must return a non-empty string of at most ${MAX_QUERY_CHARS} characters that cannot be mistaken for a CLI flag.`);
  }
  return query;
}

/**
 * Real codex-CLI transport for createCodexCloudAdapter({ transport }).
 *
 * options:
 *   codexBinary    -- executable name/path (default 'codex'); argv only, never a shell string
 *   timeoutMs      -- bounded per-CLI-call budget (default 120000); on breach the child is
 *                     killed and CODEX_CLI_TIMEOUT is thrown (never success)
 *   maxOutputBytes -- combined stdout+stderr cap per call (default 16 MiB)
 *   spawnImpl      -- child_process.spawn replacement for tests (default: the real spawn)
 *   branch         -- git branch submitted via `--branch`; REQUIRED before createTask because
 *                     the CLI would otherwise silently target "whatever branch the cwd is on",
 *                     breaking the request's pinned sourceRevision
 *   attempts       -- optional `--attempts N` (1-10, best-of-N)
 *   buildQuery     -- function(payload) returning the task prompt text; REQUIRED before
 *                     createTask (the provider payload has no prompt field to forward)
 *   prefixArgs     -- argv the executable needs before the codex subcommand (default [])
 *   env            -- full child environment, or null (default) to inherit this process's.
 *                     Pass the composed environment from src/lib/multi-account/launch.js to
 *                     pin WHICH ACCOUNT serves the call via CODEX_HOME. Without it the child
 *                     inherits the ambient ~/.codex and runs as whoever that happens to be --
 *                     the silent wrong-account failure that launch.js's header documents.
 */
function createCodexCliTransport(options = {}) {
  const config = validateFactoryOptions(options);

  return Object.freeze({
    // The CLI has no bind/handshake operation, so this degrades to a bounded
    // READ-ONLY reachability probe: one `codex cloud list --json --limit 1
    // --env <id>` call proves the CLI runs and answers for this environment
    // in the documented envelope. repository/sourceRevision/fileKeeperProof
    // cannot be transmitted through codex-cli 0.146.0 and are deliberately
    // not echoed into any claim here (custody verification is S2's lane).
    async bindEnvironment(payload) {
      if (!isPlainObject(payload)) fail('CODEX_CLI_INPUT_INVALID', 'bindEnvironment payload must be a plain object.');
      const environment = requireEnvironmentId(payload.environment);
      const { stdout, stderr } = await runCli(config, ['cloud', 'list', '--json', '--limit', '1', '--env', environment]);
      detectReportedError(stdout, stderr, 'cloud list');
      parseListJson(stdout, 'cloud list');
      return Object.freeze({ environmentRef: environmentRefFor(environment) });
    },

    // `codex cloud exec --env <id> --branch <branch> [--attempts N]`, with the
    // query on stdin. Keeping it out of argv is required for long Windows tasks.
    // Success is claimed only as far as the evidence goes: a printed task id
    // is the CLI's acknowledgment of receipt, reported as status 'queued'
    // (the provider's vocabulary for exactly that acknowledgment, mapped to
    // SUBMITTED -- never further). No id and no error signature returns
    // null, which the provider reports as an UNKNOWN submission outcome.
    async createTask(payload) {
      if (!isPlainObject(payload)) fail('CODEX_CLI_INPUT_INVALID', 'createTask payload must be a plain object.');
      const environment = requireEnvironmentId(payload.environment);
      if (config.branch === null) {
        fail('CODEX_CLI_BRANCH_NOT_CONFIGURED', 'createTask requires an explicit branch option: codex-cli 0.146.0 accepts only --branch, and defaulting to the current checkout branch would silently detach the submission from the request\'s pinned sourceRevision.');
      }
      const query = requireQuery(config.buildQuery, payload);
      const args = ['cloud', 'exec', '--env', environment, '--branch', config.branch];
      if (config.attempts !== null) args.push('--attempts', String(config.attempts));
      const { stdout, stderr } = await runCli(config, args, query);
      detectReportedError(stdout, stderr, 'cloud exec');
      const match = TASK_ID_IN_OUTPUT.exec(`${stdout}\n${stderr}`);
      if (!match) return null;
      return Object.freeze({ id: match[0], status: 'queued' });
    },

    // `codex cloud status <task-id>` (no --json flag exists; verified via
    // --help). Unrecognized output yields status null, which the provider
    // maps to UNKNOWN -- treating it as success is impossible by shape.
    async getTask(providerTaskId) {
      const taskId = requireTaskId(providerTaskId);
      const { stdout, stderr } = await runCli(config, ['cloud', 'status', taskId]);
      detectReportedError(stdout, stderr, 'cloud status');
      return parseStatusOutput(taskId, stdout);
    },

    // Fail closed: the provider-neutral ChangeManifest requires per-file
    // sha256 and sizeBytes, and codex-cli 0.146.0 can only produce a unified
    // diff string. Fabricating hashes would forge custody evidence, so this
    // operation refuses; the raw diff stays readable via fetchTaskDiff.
    async getTaskChanges(providerTaskId) {
      requireTaskId(providerTaskId);
      fail('CODEX_CLI_MANIFEST_UNAVAILABLE', 'codex-cli 0.146.0 cannot produce a sha256/sizeBytes ChangeManifest; use fetchTaskDiff for the read-only unified diff and a custody-capable channel for manifests.');
    },

    // Fail closed: `codex cloud` has no cancel subcommand (verified via
    // --help), so claiming a cancellation would be a lie.
    async cancelTask(providerTaskId) {
      requireTaskId(providerTaskId);
      fail('CODEX_CLI_CANCEL_UNSUPPORTED', 'codex-cli 0.146.0 exposes no cloud cancel operation; the task keeps running on the provider side.');
    },

    // Transport-specific READ-ONLY enumeration over the one documented JSON
    // surface. Not part of the provider adapter interface.
    async listTasks({ limit = MAX_LIST_LIMIT, cursor = null, environment = null } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
        fail('CODEX_CLI_INPUT_INVALID', `listTasks limit must be an integer between 1 and ${MAX_LIST_LIMIT}.`);
      }
      if (cursor !== null && (typeof cursor !== 'string' || !CURSOR.test(cursor))) {
        fail('CODEX_CLI_INPUT_INVALID', 'listTasks cursor must be a bounded opaque token when provided.');
      }
      const args = ['cloud', 'list', '--json', '--limit', String(limit)];
      if (environment !== null) args.push('--env', requireEnvironmentId(environment));
      if (cursor !== null) args.push('--cursor', cursor);
      const { stdout, stderr } = await runCli(config, args);
      detectReportedError(stdout, stderr, 'cloud list');
      const parsed = parseListJson(stdout, 'cloud list');
      const tasks = parsed.tasks.map(normalizeListedTask);
      // The emitted cursor is checked against the SAME rule this method
      // enforces on an incoming cursor. Accepting a cursor here that the next
      // call would refuse is how paging silently became one page: the mismatch
      // surfaced two calls later as an INPUT_INVALID blamed on a caller who
      // only ever passed a task id. A cursor this transport cannot hand back
      // to itself is unusable output, so it is reported as such, at the call
      // that produced it -- still refusing to report pagination as complete.
      const normalizedCursor = parsed.cursor === undefined || parsed.cursor === null
        ? null
        : (typeof parsed.cursor === 'string' && CURSOR.test(parsed.cursor) ? parsed.cursor : null);
      if (parsed.cursor !== undefined && parsed.cursor !== null && normalizedCursor === null) {
        // A CURSOR HANDED OUT MUST BE ONE THIS TRANSPORT WILL TAKE BACK, and
        // the ternary above is where that is enforced -- there is no second
        // check below it. A guard reading `normalizedCursor !== null &&
        // !CURSOR.test(normalizedCursor)` stood here and could never run:
        // normalizedCursor is null unless CURSOR.test already passed, so the
        // two halves were a contradiction. Worse, its sentence still described
        // the alphabet CURSOR used to have -- "must begin with a letter or
        // digit and hold only letters, digits and + / = _ . - characters" --
        // which is exactly the rule that was deleted for rejecting the
        // provider's own `+RID:~...#...` cursor. Dead code cannot be wrong
        // where anyone will see it, so it read as a live second opinion while
        // stating the opposite of the shipped rule; the useful half of it, the
        // offending value and the count of tasks withheld, is folded into the
        // one refusal that does fire.
        fail('CODEX_CLI_OUTPUT_UNPARSEABLE',
          'codex cloud list emitted a next-page cursor this transport cannot send back: '
          + `${excerpt(typeof parsed.cursor === 'string' ? parsed.cursor : JSON.stringify(parsed.cursor))}. `
          + 'A cursor is pushed to the CLI as the value of --cursor, so it must be 1-512 printable ASCII characters '
          + 'with no whitespace and no control bytes, and must not begin with "-" where the CLI would read it as a '
          + `flag. The ${tasks.length} task(s) on this page were not reported, because a partial list that claims no `
          + 'more pages exist is the failure this refusal prevents.');
      }
      return Object.freeze({ tasks: Object.freeze(tasks), cursor: normalizedCursor });
    },

    // Transport-specific READ-ONLY passthrough of `codex cloud diff
    // <task-id>`: the unified diff comes back as an untouched string. This
    // transport never parses it into claims and never applies it.
    async fetchTaskDiff(providerTaskId, { attempt = null } = {}) {
      const taskId = requireTaskId(providerTaskId);
      if (attempt !== null && (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100)) {
        fail('CODEX_CLI_INPUT_INVALID', 'fetchTaskDiff attempt must be an integer between 1 and 100 when provided.');
      }
      const args = ['cloud', 'diff'];
      if (attempt !== null) args.push('--attempt', String(attempt));
      args.push(taskId);
      const { stdout, stderr } = await runCli(config, args);
      // THE DIFF BODY IS ARBITRARY FILE CONTENT AND MUST NOT BE SCANNED FOR
      // CLI ERROR TEXT. Every other operation here returns JSON or a short
      // status line, so detectReportedError can safely read their stdout. This
      // one returns whatever was in the customer's source. Its pattern is
      // /^\s*error:\s?.*$/im -- and in a unified diff an UNCHANGED context line
      // begins with a single space, so a perfectly ordinary line reading
      //     error: marker,
      // matches and a successful retrieval is reported as a CLI failure. Found
      // by using this: a real SUCCEEDED task whose diff touched error-handling
      // code was unretrievable, which is the exact "the work exists and nothing
      // can fetch it" defect this whole retrieval leg was added to end. This
      // codebase is dense with `error:` object properties, so the false-positive
      // class is large rather than exotic.
      //
      // stderr still gets the full detector: that is where the CLI actually
      // reports failure, and it is never a diff. stdout is checked only when it
      // is NOT a diff -- an empty body is a real answer ("this task changed no
      // files"), and anything else non-diff-shaped is still suspect.
      const looksLikeDiff = /^(diff --git |--- |Index: )/.test(stdout || '');
      detectReportedError(looksLikeDiff ? '' : stdout, stderr, 'cloud diff', taskId);
      return stdout;
    }
  });
}

module.exports = Object.freeze({
  createCodexCliTransport
});
