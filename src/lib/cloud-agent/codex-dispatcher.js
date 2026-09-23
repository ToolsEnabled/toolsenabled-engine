'use strict';

/* THE REAL DISPATCHER -- the one function in the batch lane that spends money.
 *
 * Everything else in this lane is injected and testable precisely so that this
 * file can be small, boring, and the only place a real cloud task is created.
 * runBatch takes `dispatch` as a parameter for exactly that reason.
 *
 * TWO FACTS FROM MEASUREMENT SHAPE ALL OF IT.
 *
 * 1. CODEX_HOME MUST BE PINNED PER ACCOUNT. The CLI's default home is
 *    `cloud-a`. A wave created by `cloud-b` answers 404 to `codex cloud diff`
 *    run under the default, and a harness reading that 404 as "no diff" would
 *    re-dispatch twenty tasks that all had work. The account a task belongs to
 *    is part of the task's identity, not an ambient setting.
 *
 * 2. THE ENVIRONMENT DECIDES THE REPOSITORY, AND THE ACCOUNT DECIDES THE
 *    ENVIRONMENT. Each environment is authorized for specific accounts, so an
 *    account and an environment id are declared together or not at all.
 *    Dispatching to an environment the account cannot use fails at the
 *    provider, after the money question is already live.
 *
 * WHAT THIS RETURNS, AND WHY THE SHAPE MATTERS. runBatch distinguishes three
 * answers and the distinction is the whole safety property:
 *
 *   { taskId }                      the provider accepted; the id is the only
 *                                   handle anybody will ever have on it.
 *   throw with providerAnswered     the provider ANSWERED and turned it away.
 *                                   Certain. Recorded as refused.
 *   throw without providerAnswered  we could not tell. The task may be running
 *                                   RIGHT NOW and billing. Left unresolved, so
 *                                   a resume refuses until somebody reconciles.
 *
 * So this file's single hardest job is to be honest about which of the last two
 * it is looking at. It errs toward "could not tell", because being made to
 * reconcile a few dispatches costs minutes and paying twice for a task that
 * cannot be cancelled costs money nobody can get back.
 */

const { spawnHidden } = require('../proc/hidden-spawn');

const { CloudAgentError } = require('./errors');
/* The scrub defaultSpawn applies (46f8e18) arrived without this import, so
 * every un-injected dispatch died on a ReferenceError inside the spawn try --
 * resolved as `error`, held as UNCERTAIN, and a whole 149-task wave closed in
 * 4ms with every intent unresolved. The injected `scrubEnvironment` parameter
 * stays: callers still must name their scrub; this import only lets the
 * default spawn honor the same rule for the env object it is handed. */
const { safeLaunchEnvironment } = require('../providers/subscription-launch-env');

const DEFAULT_TIMEOUT_MS = 180_000;

/* Windows CreateProcess refuses a command line over 32,767 UTF-16 units, and
 * the prompt travels in argv. MAX_PROMPT_CHARS is that ceiling minus generous
 * slack for the command path, the fixed arguments, quoting, and a 32-hex
 * environment id -- the number the PLANNER holds briefs to, so an oversized
 * brief is refused while it is still cheap to fix instead of failing at
 * dispatch after admission sealed it. */
const WINDOWS_COMMAND_LINE_LIMIT = 32_767;
const MAX_PROMPT_CHARS = 30_000;

/* HOW TO SPAWN THE CODEX BINARY, IN ONE PLACE. A .js/.cjs/.mjs entry is run
 * under this process's own node (the npm shim only exists to find a node and
 * hand it the file); a native binary is spawned directly. Dispatch and harvest
 * both call this so they can never diverge on the rule -- which they did once,
 * harvest running a native codex.exe under node and erroring every fetch.
 * Returns { command, argv } for a shell-less spawn. */
function codexSpawn(codexBinary, args) {
  const runsUnderNode = /\.[cm]?js$/i.test(codexBinary);
  return runsUnderNode
    ? { command: process.execPath, argv: [codexBinary, ...args] }
    : { command: codexBinary, argv: [...args] };
}

/* THE DEFAULT SPAWN IS ASYNCHRONOUS, AND THAT IS NOT A STYLE CHOICE.
 *
 * This used `spawnSync`, which blocks Node's ENTIRE event loop for the whole
 * call. Measured consequence: a runner given six concurrent workers dispatched
 * eleven tasks in 117.6 seconds -- 5.6 a minute, indistinguishable from
 * serial -- because while any one `codex cloud exec` was in flight, nothing else
 * in the process could run at all. Concurrency was not slow; it was impossible.
 *
 * The shape returned is deliberately identical to spawnSync's
 * ({ status, stdout, stderr, error }) so every caller and every injected test
 * double keeps working unchanged. The dispatcher awaits it, and awaiting a
 * plain object is a no-op -- so a synchronous spawnImpl injected by a test
 * behaves exactly as it did before.
 */
function defaultSpawn(command, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      // THE NO-PROVIDER SWITCH (R38). This is the real dispatcher this file's
      // own header calls "the one function in the batch lane that spends
      // money" -- the packaged-QA fence that is supposed to stop provider
      // spend must reach it. See src/lib/proc/hidden-spawn.js.
      child = spawnHidden(command, args, {
        /* SCRUBBED, NOT PASSED THROUGH. `options.env` is assembled by the
           caller and may carry the ambient environment; a cloud dispatch
           that inherits a billing credential would bill the wrong account
           and take precedence over the subscription login. Hand-rolling a
           delete list does not work here: Windows env names are
           case-insensitive and a plain object is not, so deleting
           ANTHROPIC_API_KEY leaves anthropic_api_key for the child. */
        env: safeLaunchEnvironment(options.env || process.env, { context: 'codex cloud dispatch' }),
        shell: false,
        windowsHide: true
      });
    } catch (error) {
      resolve({ error, status: null, stdout: '', stderr: '' });
      return;
    }
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      /* A TIMEOUT RESOLVES WITH AN `error`, which the caller reads as UNCERTAIN
       * rather than as a refusal. The request may have arrived; we stopped
       * listening. That distinction is the whole safety property here. */
      finish({ error: Object.assign(new Error(`timed out after ${options.timeout}ms`), { code: 'ETIMEDOUT' }), status: null, stdout: stdout.join(''), stderr: stderr.join('') });
    }, Math.max(1, options.timeout || DEFAULT_TIMEOUT_MS));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => finish({ error, status: null, stdout: stdout.join(''), stderr: stderr.join('') }));
    child.on('close', (status) => finish({ status, stdout: stdout.join(''), stderr: stderr.join('') }));
  });
}

/* The provider ANSWERED and said no. These are refusals, not transport
 * failures: the request arrived, was understood, and was declined. Anything not
 * matched here is treated as could-not-tell, which is the safe direction. */
const PROVIDER_REFUSAL_PATTERNS = Object.freeze([
  /\bnot authorized\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\bquota\b/i,
  /\brate limit(ed)?\b/i,
  /\benvironment .* not found\b/i,
  /\bunknown environment\b/i,
  /\binvalid .*\b(env|environment)\b/i,
  /\bsign(ed)? in\b/i,
  /\bnot logged in\b/i,
]);

/* A task id in the CLI's own output. Matched against the task URL it prints,
 * because that is the form it actually emits -- see tools/cloud-lane.js and the
 * harvest toolchain, both of which parse the same shape. */
const TASK_URL = /https:\/\/chatgpt\.com\/codex\/tasks\/(task_[A-Za-z0-9_]+)/;
const BARE_TASK_ID = /\b(task_[A-Za-z0-9_]{8,})\b/;

function fail(code, message, { providerAnswered = false, details } = {}) {
  const error = new CloudAgentError(code, message, details);
  /* THE FIELD runBatch BRANCHES ON. Present and true means "the provider said
   * no". Absent means "nobody knows", and runBatch leaves the intent
   * outcome-less rather than claiming the task never ran. */
  if (providerAnswered) error.providerAnswered = true;
  throw error;
}

function looksLikeProviderRefusal(text) {
  return PROVIDER_REFUSAL_PATTERNS.some((pattern) => pattern.test(text));
}

function extractTaskId(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`;
  const url = TASK_URL.exec(text);
  if (url) return url[1];
  const bare = BARE_TASK_ID.exec(text);
  return bare ? bare[1] : null;
}

/**
 * Build the dispatch function runBatch calls.
 *
 * `accountEnvironments` maps an account name to the environment id that account
 * is authorized for. Declared, never inferred: an account with no environment
 * refuses rather than falling back to somebody else's, because a task dispatched
 * into the wrong environment runs against the wrong repository and cannot be
 * cancelled.
 */
function createCodexDispatcher({
  codexBinary,
  accountHomes,
  accountEnvironments,
  branch = 'main',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = defaultSpawn,
  scrubEnvironment
} = {}) {
  if (typeof codexBinary !== 'string' || !codexBinary.trim()) {
    throw new CloudAgentError('CLOUD_DISPATCH_NO_BINARY', 'codexBinary must be the path to the codex CLI.');
  }
  /* A .cmd SHIM IS REFUSED BY NAME, because the alternative is an opaque EINVAL
   * at dispatch time -- which the runner then correctly holds as "could not
   * tell", sending somebody to reconcile a batch that never left this machine.
   * Found exactly that way: a live two-task proof came back with both
   * unresolved, and reconciling against the provider showed nothing had been
   * created.
   *
   * Node refuses to spawn .cmd/.bat without a shell, and a shell is not the fix
   * -- passing a prompt through a command string is the quoting trap this
   * project has been burned by twice on Windows. tools/cloud-lane.js already
   * states the house answer in as many words: "shell:false spawn cannot resolve
   * npm's `codex` .cmd shim on Windows, so the transport needs the real
   * executable." So this refuses and says where the real one is, rather than
   * inventing a second way to launch the same CLI. */
  if (/\.(cmd|bat)$/i.test(codexBinary.trim())) {
    throw new CloudAgentError('CLOUD_DISPATCH_SHIM_NOT_EXECUTABLE',
      `${codexBinary} is an npm shim, and a shell-less spawn cannot run one -- it fails EINVAL, which is indistinguishable at dispatch time from a provider that never answered. `
      + 'Pass the real entry point instead: the .js the shim wraps (run under this process\'s own node), or a native executable.');
  }
  if (!accountHomes || typeof accountHomes !== 'object') {
    throw new CloudAgentError('CLOUD_DISPATCH_NO_HOMES', 'accountHomes must map each account name to its CODEX_HOME.');
  }
  if (!accountEnvironments || typeof accountEnvironments !== 'object') {
    throw new CloudAgentError('CLOUD_DISPATCH_NO_ENVIRONMENTS', 'accountEnvironments must map each account name to the environment it is authorized for.');
  }
  if (typeof scrubEnvironment !== 'function') {
    /* NOT OPTIONAL. A codex child inherits this process's environment unless
     * something removes the provider credentials from it, and the repository's
     * spawn-environment gate exists because that leak has happened here before.
     * Requiring it rather than defaulting means a caller cannot forget. */
    throw new CloudAgentError('CLOUD_DISPATCH_NO_SCRUB',
      'scrubEnvironment must be supplied so the codex child never inherits this process\'s provider credentials. Pass safeLaunchEnvironment from src/lib/providers/subscription-launch-env.js.');
  }

  return async function dispatch({ task, index, account }) {
    const home = accountHomes[account];
    const environment = accountEnvironments[account];
    if (typeof home !== 'string' || !home.trim()) {
      fail('CLOUD_DISPATCH_ACCOUNT_HOME_UNKNOWN',
        `no CODEX_HOME is declared for account ${JSON.stringify(account)}. The CLI would fall back to its default home, and a task created under the wrong home answers 404 to every later diff -- which a harvest reads as "no work" and re-dispatches.`);
    }
    if (typeof environment !== 'string' || !environment.trim()) {
      fail('CLOUD_DISPATCH_ACCOUNT_ENVIRONMENT_UNKNOWN',
        `no environment is declared for account ${JSON.stringify(account)}. An environment decides which repository the task runs against, so guessing one would run real work against the wrong source.`);
    }
    const prompt = task && typeof task.contract === 'string' ? task.contract : null;
    if (!prompt) {
      fail('CLOUD_DISPATCH_NO_PROMPT',
        `task ${index} carries no contract text to send. Admission validates every brief, so reaching here means the declaration was changed after admission.`);
    }

    const env = scrubEnvironment(process.env, { context: 'codex cloud dispatch' });
    env.CODEX_HOME = home;

    /* A .js ENTRY POINT RUNS UNDER THIS PROCESS'S OWN NODE, a native binary is
     * spawned directly -- the one rule codexSpawn owns so dispatch and harvest
     * cannot diverge (they did: the harvest path ran a native codex.exe under
     * node and errored every fetch). Using process.execPath for a .js entry
     * means the child runs the same vetted runtime, and every argument travels
     * as an array element -- no quoting, no shell. */
    const { command, argv } = codexSpawn(codexBinary, ['cloud', 'exec', '--env', environment, '--branch', branch, prompt]);

    /* THE PROMPT RIDES IN ARGV, AND WINDOWS CAPS A COMMAND LINE AT 32,767
     * UTF-16 UNITS. Above that, CreateProcess fails before anything reaches
     * the provider -- which is CERTAIN, not uncertain, and it used to land in
     * the catch-all uncertain bucket: the journal kept an intent with no
     * outcome, the runner closed "done" with exit 0, and the operator learned
     * nothing. Measured 2026-08-25: the two largest briefs of a 20-task wave
     * (a 31KB diff riding base64) failed exactly this way, twice, silently --
     * every smaller sibling launched. The check runs BEFORE the spawn so the
     * refusal is deterministic and providerAnswered is honestly true: nothing
     * was sent, no reconciliation is owed. The planner enforces the same
     * ceiling at authoring time via MAX_PROMPT_CHARS; this is the last line
     * for briefs that arrive by other routes. */
    const commandLineLength = [command, ...argv].reduce((total, part) => total + String(part).length + 3, 0);
    if (commandLineLength > WINDOWS_COMMAND_LINE_LIMIT) {
      fail('CLOUD_DISPATCH_PROMPT_TOO_LONG',
        `the dispatch for task ${index} would need a ${commandLineLength}-character command line and Windows caps CreateProcess at ${WINDOWS_COMMAND_LINE_LIMIT}. Nothing was sent. Shrink the brief (the prompt is ${prompt.length} characters), or carry its payload another way.`,
        { providerAnswered: true });
    }

    const outcome = await spawnImpl(command, argv, {
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024
    });

    if (outcome.error && outcome.error.code === 'ENOENT') {
      /* CERTAIN. The binary does not exist, so nothing was sent and no task can
       * be running. Naming it as answered spares a pointless reconciliation. */
      fail('CLOUD_DISPATCH_CLI_ABSENT', `the codex CLI was not found at ${command}.`, { providerAnswered: true });
    }
    if (outcome.error) {
      /* A TIMEOUT IS THE WORST CASE AND IT IS DELIBERATELY NOT A REFUSAL. The
       * request may have arrived and be running; we simply stopped listening. */
      fail('CLOUD_DISPATCH_UNCERTAIN',
        `the dispatch for task ${index} did not complete: ${String(outcome.error.message).slice(0, 200)}. Whether the provider received it is unknown, so it is left to be reconciled rather than recorded as refused.`);
    }

    const stdout = String(outcome.stdout || '');
    const stderr = String(outcome.stderr || '');
    const taskId = extractTaskId(stdout, stderr);

    if (outcome.status === 0) {
      if (taskId) return { taskId };
      /* Exit 0 and no id: the provider is happy and we cannot name what it
       * created. Unknown, not launched -- inventing an id would be worse. */
      fail('CLOUD_DISPATCH_ID_UNREADABLE',
        `the dispatch for task ${index} succeeded but no task id could be read from its output, so nothing can address the task it created.`);
    }

    /* NON-ZERO. Now the only question that matters: did the provider answer? */
    const text = `${stdout}\n${stderr}`;
    if (taskId) {
      /* IT FAILED AND IT STILL PRINTED AN ID. The task exists. Returning it is
       * the honest answer -- refusing would strand a real, billing task. */
      return { taskId };
    }
    if (looksLikeProviderRefusal(text)) {
      fail('CLOUD_DISPATCH_REFUSED',
        `the provider declined task ${index}: ${text.trim().slice(0, 300)}`,
        { providerAnswered: true });
    }
    fail('CLOUD_DISPATCH_UNCERTAIN',
      `the dispatch for task ${index} exited ${outcome.status} and its output matches no known provider refusal, so whether it reached the provider is unknown: ${text.trim().slice(0, 300)}`);
  };
}

module.exports = Object.freeze({
  DEFAULT_TIMEOUT_MS,
  MAX_PROMPT_CHARS,
  PROVIDER_REFUSAL_PATTERNS,
  WINDOWS_COMMAND_LINE_LIMIT,
  codexSpawn,
  createCodexDispatcher,
  extractTaskId,
  looksLikeProviderRefusal
});
