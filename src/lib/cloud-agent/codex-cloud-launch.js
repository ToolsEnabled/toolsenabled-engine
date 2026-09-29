'use strict';

// READING CODEX CLOUD TASKS: status, diff and the recent-task list, each asked
// of exactly one Codex account through the official Codex CLI. It composes:
//
//   1. multi-account/switcher.js  -- WHETHER the one account chosen for the
//      call can serve it, asking the provider instead of guessing. No other
//      account of the same provider is tried by itself.
//   2. multi-account/launch.js    -- the composed child environment: every
//      billing credential scrubbed, and CODEX_HOME pinned to the chosen
//      account's own home so the call cannot silently run as someone else.
//   3. multi-account/launch.js    -- codexExecutable(), the RESOLVED codex
//      executable. This is load-bearing on Windows: the transport spawns with
//      shell:false, and bare `codex` is an npm .cmd shim that shell:false
//      cannot resolve (measured here: `spawn codex ENOENT`).
//   4. cloud-agent/codex-cli-transport.js -- the bounded, fail-closed client.
//
// WHAT IS NOT HERE. Launching a task and listing the accounts' environments
// both depended on a Codex Cloud environment reader that read the Codex
// sign-in and called an undocumented provider endpoint with it. That reader
// was removed, and the launch and environment listing were removed with it.
// Everything left in this file goes through the official CLI only.
//
// Credential discipline: the composed environment legitimately carries account
// material, so it is never logged, never returned, and never placed in an
// error. Every value this module reports about an account is its NAME and its
// provider-reported usage PERCENT.

const { findAccount, loadRegistry } = require('../multi-account/registry.js');
const { probeAccount } = require('../multi-account/health.js');
const { activeFor, readState, selectAccount } = require('../multi-account/switcher.js');
const { launchEnvironment, codexExecutable } = require('../multi-account/launch.js');
const { createCodexCliTransport } = require('./codex-cli-transport');
const { mapStatus } = require('../providers/codex-cloud');
const { CloudAgentError } = require('./errors');
const { statePath } = require('../runtime-state-root');
const { accountRegistryPath } = require('../multi-account/registry-location.js');

// Written at runtime, so installed it is not the program directory.
// See src/lib/runtime-state-root.js.
const STATE_PATH = statePath('state', 'multi-account', 'state.json');

/* WHERE THE ACCOUNT REGISTRY IS READ FROM: ../multi-account/registry-location.js,
 * imported above, which is the only place that question is answered.
 *
 * IT MOVED OUT OF THIS FILE, AND THE MOVE IS THE POINT. The resolution order and
 * its reasoning are unchanged and travelled with it. What changed is who else
 * can see it: ../multi-account/registry-write.js -- the writer that lets a
 * person ADD an account instead of hand-authoring the file this module refuses
 * without -- has to write the file this module reads. While the rule lived here,
 * the only way for the writer to have it was to copy it, and two copies of
 * "where is the registry" become two registries the first time one is edited.
 *
 * It is still re-exported below, unchanged, because tools and tests already ask
 * this module for it. */

/* NOTHING IS WRITTEN FROM THE CLOUD LANE: no Codex pin and no account state.
 * A pin written here would move local dispatch onto whichever account served a
 * cloud call, and state written by a read would change which account the next
 * unspecified call asks. transportFor() below builds the child environment
 * from the chosen account's own profile directory directly, and the account
 * that served is reported to the caller instead. */

// Codex Cloud environment ids observed live are 32 lowercase hex characters.
// The display label (Owner/repo) is NOT an id and the CLI rejects it, so it is
// rejected here too with a message that says what to pass instead.
const ENVIRONMENT_ID = /^[0-9a-f]{32}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
// Bounded paging for a single-task status search: 3 pages x 20 tasks. Bounded
// rather than exhaustive so a status read can never turn into an open-ended
// walk of the account's whole task history.
const STATUS_SEARCH_MAX_PAGES = 3;

// Derived from the id, not invented: `codex cloud list --json` returns this
// exact URL shape for every task it lists. It is a convenience link, which is
// why it is named for what it is rather than presented as provider output.
const TASK_URL_PREFIX = 'https://chatgpt.com/codex/tasks/';

function fail(code, message) { throw new CloudAgentError(code, message); }

function requireEnvironment(value) {
  if (typeof value !== 'string' || !ENVIRONMENT_ID.test(value)) {
    fail('CLOUD_LAUNCH_ENVIRONMENT_INVALID',
      'environment must be a 32-character Codex Cloud environment id (for example the id in the chatgpt.com/codex/cloud/settings/environment/<id> URL), not the "Owner/repo" display label.');
  }
  return value;
}

function requireTaskId(value) {
  if (typeof value !== 'string' || !TASK_ID.test(value)) {
    fail('CLOUD_LAUNCH_TASK_ID_INVALID', 'taskId must be an opaque [A-Za-z0-9_-] Codex Cloud task identifier.');
  }
  return value;
}

// probeAccount() needs the launch environment and the resolved executable
// injected -- it deliberately owns neither. This mirrors tools/account.js's
// makeProbe() exactly rather than introducing a second way to build a probe,
// so both paths ask the provider the same question the same way.
function defaultProbe(registry) {
  const executable = codexExecutable();
  const homeDir = process.env.USERPROFILE || process.env.HOME || '';
  return account => probeAccount(account, {
    homeDir,
    environmentFor: (target, options) => launchEnvironment(target, { homeDir: options.homeDir, fsImpl: options.fsImpl }),
    executable,
    exhaustedAtPercent: registry.exhaustedAtPercent
  });
}

// The account surface, reduced to exactly what is safe to report and show.
function accountReport(account, probe) {
  return Object.freeze({
    name: account.name,
    role: typeof account.role === 'string' ? account.role : null,
    usedPercent: probe && Number.isFinite(probe.usedPercent) ? probe.usedPercent : null,
    status: probe ? probe.status : null
  });
}

/**
 * Choose the account that serves this call, and never a second one.
 *
 * The account is the one the caller named, else the Codex account recorded as
 * in use, else the first listed Codex account. It is asked whether it can
 * serve; when it cannot, the call is refused with that account's reason. No
 * other account of the same provider is tried by itself -- the caller can name
 * another account, or wait for this one to reset. Nothing is written: choosing
 * an account to ask is not adopting it.
 */
async function chooseAccount({
  registry,
  preferred = null,
  probeImpl,
  statePath,
  fsImpl
}) {
  const probe = probeImpl || defaultProbe(registry);
  const codexAccounts = registry.accounts.filter(account => account.provider == null || account.provider === 'codex');
  let head;
  if (preferred) {
    head = findAccount({ accounts: codexAccounts }, preferred) || null;
  } else {
    const state = readState(statePath || STATE_PATH, fsImpl ? { fsImpl } : {});
    const recorded = activeFor(state, 'codex');
    /* A recorded name that is no longer registered is not a choice anybody can
       still act on; the first listed account is asked instead, as it would be
       on a computer with no record at all. */
    head = (recorded && findAccount({ accounts: codexAccounts }, recorded)) || codexAccounts[0] || null;
  }
  if (!head) {
    return Object.freeze({
      ok: false, account: null, probe: null, attempts: Object.freeze([]), switched: false,
      reason: preferred
        ? `No Codex account named "${preferred}" is registered on this computer.`
        : 'No Codex account is registered on this computer.'
    });
  }
  return selectAccount({ registry: { accounts: [head] }, preferred: head.name, probe });
}

// One transport bound to one account: resolved executable and that account's
// pinned+scrubbed environment.
function transportFor(account, { timeoutMs, transportFactory, executableImpl, environmentImpl } = {}) {
  const executable = (executableImpl || codexExecutable)();
  const environment = (environmentImpl || launchEnvironment)(account, {});
  const factory = transportFactory || createCodexCliTransport;
  const options = {
    codexBinary: executable.command,
    prefixArgs: executable.prefixArgs || [],
    env: environment
  };
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
  return factory(options);
}

/**
 * Read-only status of one task.
 *
 * Reads the LIST surface, not `codex cloud status`, and that choice is
 * measured rather than stylistic. MEASURED 2026-08-11 against a task that had
 * just been submitted successfully: `codex cloud status <id>` exits 1 and
 * prints an unstructured human block ("[PENDING] <title> ... no diff") with no
 * --json option. Building the product's status read on it would surface a
 * hard error for a perfectly healthy task. `cloud list --json` is the only
 * surface with a documented envelope, so it is the one used here; the raw
 * `cloud status` passthrough stays available on the transport for diagnosis.
 *
 * One account is asked; another is never tried by itself. Paging is bounded:
 * a task outside the searched window is reported UNKNOWN/notFound, never
 * guessed.
 */
async function cloudTaskStatus(request = {}, dependencies = {}) {
  const taskId = requireTaskId(request.taskId);
  const registry = (dependencies.loadRegistryImpl || loadRegistry)({
    configPath: (dependencies.accountRegistryPathImpl || accountRegistryPath)()
  });
  // A status READ chooses one account to ask and never adopts it.
  const selection = await chooseAccount({ registry, preferred: request.account || null, probeImpl: dependencies.probeImpl,
      statePath: dependencies.statePath, fsImpl: dependencies.fsImpl });
  if (!selection.ok) {
    fail('CLOUD_LAUNCH_NO_ACCOUNT_AVAILABLE', `No configured Codex account can serve this status read: ${selection.reason}`);
  }
  const transport = transportFor(selection.account, {
    timeoutMs: dependencies.timeoutMs,
    transportFactory: dependencies.transportFactory,
    executableImpl: dependencies.executableImpl,
    environmentImpl: dependencies.environmentImpl
  });
  const environment = request.environment === undefined || request.environment === null
    ? null
    : requireEnvironment(request.environment);

  let cursor = null;
  for (let page = 0; page < STATUS_SEARCH_MAX_PAGES; page += 1) {
    const listed = await transport.listTasks({ limit: 20, cursor, environment });
    const found = listed.tasks.find(task => task.id === taskId);
    if (found) {
      return Object.freeze({
        taskId,
        found: true,
        state: mapStatus(found.status),
        providerStatus: found.status,
        title: found.title,
        updatedAt: found.updatedAt,
        taskUrl: found.url || `${TASK_URL_PREFIX}${taskId}`,
        account: accountReport(selection.account, selection.probe)
      });
    }
    if (!listed.cursor) break;
    cursor = listed.cursor;
  }

  // Absent from the searched window is NOT "failed" and NOT "does not exist".
  return Object.freeze({
    taskId,
    found: false,
    state: 'UNKNOWN',
    providerStatus: null,
    title: null,
    updatedAt: null,
    taskUrl: `${TASK_URL_PREFIX}${taskId}`,
    account: accountReport(selection.account, selection.probe)
  });
}

// THE RETRIEVAL LEG. Without it, a cloud task's work cannot be fetched back:
// the only thing that came back was a URL.
//
// WHY THIS RETURNS A DIFF AND IS NAMED FOR ONE. `codex cloud diff` is the only
// retrieval the CLI offers. The sibling operations fail closed and cannot
// stand in: getTaskChanges refuses CODEX_CLI_MANIFEST_UNAVAILABLE, and there
// is no surface at all for a task's prose. So this returns a unified diff and
// NOTHING else -- no artifacts, no agent messages, no logs. Calling it
// `task_result` would promise "the agent's answer", which it cannot provide,
// and the caller would read an empty diff as an empty answer rather than as
// "this task changed no files".
//
// WHY IT DOES NOT WRITE. Applying, or even staging, a diff fetched from a
// remote agent is a mutation with its own review requirements; cloud-lane's
// runVerify additionally writes a task record back. Keeping retrieval a pure
// read means the fetch can never be the step that damages a tree, and the
// decision to apply stays where it belongs -- with a caller that reviewed it.
//
// The byte cap is deliberately far below the transport's own 16 MiB output
// ceiling. Truncation is REPORTED, never silent: a half diff that looks whole
// is worse than no diff, because it applies cleanly and drops work.
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

async function cloudTaskDiff(request = {}, dependencies = {}) {
  const taskId = requireTaskId(request.taskId);
  const attempt = request.attempt === undefined || request.attempt === null ? null : request.attempt;
  if (attempt !== null && (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100)) {
    fail('CLOUD_DIFF_ATTEMPT_INVALID', 'attempt must be an integer between 1 and 100 when provided.');
  }

  const registry = (dependencies.loadRegistryImpl || loadRegistry)({
    configPath: (dependencies.accountRegistryPathImpl || accountRegistryPath)()
  });
  // A diff READ chooses one account to ask and never adopts it.
  const selection = await chooseAccount({
    registry,
    preferred: request.account || null,
    probeImpl: dependencies.probeImpl,
    statePath: dependencies.statePath,
    fsImpl: dependencies.fsImpl
  });
  if (!selection.ok) {
    fail('CLOUD_LAUNCH_NO_ACCOUNT_AVAILABLE', `No configured Codex account can serve this diff read: ${selection.reason}`);
  }

  const transport = transportFor(selection.account, {
    timeoutMs: dependencies.timeoutMs,
    transportFactory: dependencies.transportFactory,
    executableImpl: dependencies.executableImpl,
    environmentImpl: dependencies.environmentImpl
  });

  // A Codex Cloud task is scoped to the account that created it, so a task the
  // serving account cannot see reads as "not found" rather than as a failure.
  // Saying WHICH account served the read is the whole remedy: the recurring
  // mistake here is reading that absence as a missing task and re-launching
  // work that already exists under another account.
  let raw;
  try {
    raw = await transport.fetchTaskDiff(taskId, attempt === null ? {} : { attempt });
  } catch (error) {
    const code = error && typeof error.code === 'string' ? error.code : 'CLOUD_DIFF_FAILED';
    const detail = error && error.message ? error.message : String(error);
    fail(code, `${detail} (served by account "${selection.account.name}"; a task created by a different account is not visible to it).`);
  }

  const diff = typeof raw === 'string' ? raw : '';
  const bytes = Buffer.byteLength(diff, 'utf8');
  const truncated = bytes > MAX_DIFF_BYTES;
  return Object.freeze({
    taskId,
    attempt,
    diff: truncated ? Buffer.from(diff, 'utf8').subarray(0, MAX_DIFF_BYTES).toString('utf8') : diff,
    bytes,
    truncated,
    // An empty diff is a real, common answer (a task that only read, or that
    // wrote its findings into a file it then failed to commit). It is reported
    // as its own field so a caller never has to infer it from an empty string.
    changedNothing: bytes === 0,
    taskUrl: `${TASK_URL_PREFIX}${taskId}`,
    account: accountReport(selection.account, selection.probe)
  });
}

/** Read-only enumeration of recent tasks. */
async function listCloudTasks(request = {}, dependencies = {}) {
  const limit = request.limit === undefined || request.limit === null ? 20 : request.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    fail('CLOUD_LAUNCH_LIMIT_INVALID', 'limit must be an integer between 1 and 20.');
  }
  const environment = request.environment === undefined || request.environment === null
    ? null
    : requireEnvironment(request.environment);
  const registry = (dependencies.loadRegistryImpl || loadRegistry)({
    configPath: (dependencies.accountRegistryPathImpl || accountRegistryPath)()
  });
  /* cloud.task_list, cloud.task_status and cloud.task_diff are declared
   * `effect: 'external-read', readOnlyHint: true`, so choosing an account to
   * ask writes nothing: no history entry, and no change to the account in use
   * that the next unspecified call would read back. */
  const selection = await chooseAccount({ registry, preferred: request.account || null, probeImpl: dependencies.probeImpl,
      statePath: dependencies.statePath, fsImpl: dependencies.fsImpl });
  if (!selection.ok) {
    fail('CLOUD_LAUNCH_NO_ACCOUNT_AVAILABLE', `No configured Codex account can serve this list: ${selection.reason}`);
  }
  const transport = transportFor(selection.account, {
    timeoutMs: dependencies.timeoutMs,
    transportFactory: dependencies.transportFactory,
    executableImpl: dependencies.executableImpl,
    environmentImpl: dependencies.environmentImpl
  });
  const listed = await transport.listTasks({ limit, environment });
  return Object.freeze({
    tasks: Object.freeze(listed.tasks.map(task => Object.freeze({
      taskId: task.id,
      title: task.title,
      state: mapStatus(task.status),
      providerStatus: task.status,
      updatedAt: task.updatedAt,
      environmentLabel: task.environmentLabel,
      taskUrl: task.url
    }))),
    account: accountReport(selection.account, selection.probe)
  });
}

module.exports = Object.freeze({
  ENVIRONMENT_ID,
  MAX_DIFF_BYTES,
  accountRegistryPath,
  cloudTaskDiff,
  cloudTaskStatus,
  listCloudTasks
});
