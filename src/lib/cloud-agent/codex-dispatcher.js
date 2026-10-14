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

const { spawnHidden, resolveHiddenInvocation } = require('../proc/hidden-spawn');
const { jobWrapperInvocation } = require('../windows-job-control');

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

/* HOW MANY COMMAND-LINE UNITS ONE ARGUMENT COSTS ON WINDOWS.
 *
 * argv is not a vector on Windows. CreateProcessW takes ONE string, and libuv
 * folds our array into it (uv/src/win/process.c, make_program_args ->
 * quote_cmd_arg, the non-verbatim path, which is what `shell: false` uses).
 * Folding QUOTES AND ESCAPES, so an argument's cost is not its length:
 *
 *   - no space, tab or `"`            -> passed through untouched, len units.
 *     Backslashes alone cost nothing; there is nothing to escape against.
 *   - empty                          -> `""`, 2 units.
 *   - space or tab, no `"` and no \  -> wrapped, len + 2.
 *   - anything else                  -> wrapped, each `"` becomes `\"`, and
 *     every backslash in a run that touches a `"` or the end of the argument
 *     is doubled.
 *
 * MEASURED, NOT ESTIMATED, and that is the whole point of this function. The
 * old ceiling added a flat three characters per argument and never looked
 * inside one, so a brief carrying 11,000 double quotes measured ~22,300 and
 * built a ~33,300-unit command line: it passed the check, CreateProcess
 * refused it, and the dispatcher recorded that as UNCERTAIN -- sending
 * somebody to reconcile a task that had never been sent. Quote-heavy briefs
 * are not exotic here; JSON payloads and embedded diffs are the normal shape.
 *
 * This counts without building the string, so measuring a 30,000-character
 * brief costs no second copy of it.
 */
function windowsQuotedArgumentLength(argument) {
  const text = String(argument);
  if (text.length === 0) return 2;
  if (!/[ \t"]/.test(text)) return text.length;
  if (!/["\\]/.test(text)) return text.length + 2;
  /* The backward walk is libuv's own: a backslash is doubled only while a
   * quote (or the argument's end) is still "pending" to its right. */
  let units = 2;
  let quotePending = true;
  for (let index = text.length; index > 0; index -= 1) {
    const character = text[index - 1];
    units += 1;
    if (quotePending && character === '\\') units += 1;
    else if (character === '"') { quotePending = true; units += 1; }
    else quotePending = false;
  }
  return units;
}

/* THE WHOLE COMMAND LINE: every argument at its escaped cost, one space
 * between each, and the terminating NUL -- which CreateProcessW's 32,767
 * counts ("including the Unicode terminating null character"). argv[0] is the
 * program name and rides in the command line too, so it is measured with the
 * rest. */
function windowsCommandLineLength(command, argv = []) {
  const parts = [command, ...argv];
  let units = parts.length; /* one separator per gap, plus the terminating NUL */
  for (const part of parts) units += windowsQuotedArgumentLength(part);
  return units;
}

/* A COMMAND LINE THE OS ITSELF REFUSED, which is CERTAIN: CreateProcess (and
 * execve) validate before anything starts, so no request left this machine.
 * ENAMETOOLONG is what libuv reports for ERROR_FILENAME_EXCED_RANGE;
 * E2BIG is the POSIX spelling of the same refusal.
 *
 * EINVAL IS DELIBERATELY NOT IN THIS SET. It is exactly what an npm .cmd shim
 * gives, and this file's own history says that failure is indistinguishable at
 * dispatch time from a provider that never answered -- a live two-task proof
 * came back with both unresolved because of it. Promoting EINVAL to certain
 * would be how a task that IS running gets recorded as refused. */
const COMMAND_LINE_REJECTION_CODES = Object.freeze(new Set(['ENAMETOOLONG', 'E2BIG']));

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
/* A DISPATCH IS A PROCESS TREE, SO A DISPATCH TIMEOUT MUST END A TREE.
 *
 * `codex cloud exec` is not one process: the npm entry point runs under this
 * process's own node, and the CLI starts children of its own. This path used to
 * call `child.kill()` on the timeout, which signals the DIRECT CHILD ONLY. The
 * root died, the grandchild was orphaned, and it kept running -- the exact
 * shape hidden-spawn.js records from 2026-09-03, where one orphaned Git grep
 * walked the development tree for 55 minutes at 223% process CPU and survived
 * an app restart. On Windows an orphan is worse than untidy: taskkill /T can no
 * longer discover it from the dead root's pid, so nothing can find it again.
 *
 * The containment already exists in this engine and is opted into, never
 * inferred: spawnHidden's `containProcessTree` gives a Windows Job Object on
 * win32 and a subreaper/pidfd scope on Linux, and `terminateJob()` ends every
 * member of the scope THIS dispatch created.
 *
 * WHAT IT MUST NEVER DO, stated because the alternative is what the naive fix
 * reaches for: no `process.kill(pid, ...)`, no negative pid, no signal to a
 * process group this dispatch did not create. Nothing here may signal anything
 * it did not start, and above all not a parent. Terminating a scope we own is
 * the only operation used, and the contained wrappers do not expose `kill` at
 * all -- so the old `child.kill()` would have thrown into an empty catch and
 * killed nothing whatsoever once containment was on.
 *
 * spawnHidden is a parameter so the containment request and the timeout can be
 * proved with a fake, without starting a real tree to orphan.
 */
function createDefaultSpawn({ spawnHidden: spawnHiddenImpl = spawnHidden, platform = process.platform } = {}) {
  function defaultSpawn(command, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      // THE NO-PROVIDER SWITCH (R38). This is the real dispatcher this file's
      // own header calls "the one function in the batch lane that spends
      // money" -- the packaged-QA fence that is supposed to stop provider
      // spend must reach it. See src/lib/proc/hidden-spawn.js.
      child = spawnHiddenImpl(command, args, {
        /* SCRUBBED, NOT PASSED THROUGH. `options.env` is assembled by the
           caller and may carry the ambient environment; a cloud dispatch
           that inherits a billing credential would bill the wrong account
           and take precedence over the subscription login. Hand-rolling a
           delete list does not work here: Windows env names are
           case-insensitive and a plain object is not, so deleting
           ANTHROPIC_API_KEY leaves anthropic_api_key for the child. */
        env: safeLaunchEnvironment(options.env || process.env, { context: 'codex cloud dispatch' }),
        shell: false,
        windowsHide: true,
        /* REQUESTED HERE AND NOWHERE ELSE, because a tree cannot be adopted
           after the fact. Containment has to be in place before the CLI's
           first instruction runs, or the grandchild that outlives a timeout is
           already unreachable. */
        containProcessTree: true
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
      /* END THE SCOPE WE OWN, not a pid. `terminateJob` is the contained
         wrapper's own operation: it terminates every member of the Job Object
         or subreaper scope this dispatch created, proves zero active
         processes, and can reach nothing outside it. Its rejection is handled
         rather than left to become an unhandled rejection that would take a
         runner down mid-wave; the retained-wrapper handle is the same
         second chance codex-process.js uses, and KILL_ON_JOB_CLOSE still
         backs both. Only an UNCONTAINED child -- a platform spawnHidden does
         not contain -- falls back to its own kill handle, and never to
         process.kill. */
      if (typeof child.terminateJob === 'function') {
        child.terminateJob().catch(() => {
          if (typeof child.terminateRetainedWrapper === 'function') {
            child.terminateRetainedWrapper().catch(() => { /* the job limit still ends the members */ });
          }
        });
      } else {
        try { child.kill(); } catch { /* already gone */ }
      }
      /* A TIMEOUT RESOLVES WITH AN `error`, which the caller reads as UNCERTAIN
       * rather than as a refusal. The request may have arrived; we stopped
       * listening. Killing OUR tree says nothing about what the provider did,
       * so containment does not make a timeout any more certain than it was.
       * That distinction is the whole safety property here. */
      finish({ error: Object.assign(new Error(`timed out after ${options.timeout}ms`), { code: 'ETIMEDOUT' }), status: null, stdout: stdout.join(''), stderr: stderr.join('') });
    }, Math.max(1, options.timeout || DEFAULT_TIMEOUT_MS));
    /* A contained wrapper exposes the root's pipes, but a caller that asked for
       no pipes has none. Missing pipes are not an argument for skipping the
       timeout, so they are tolerated rather than thrown from inside here. */
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => stdout.push(chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => stderr.push(chunk));
    }
    child.on('error', (error) => finish({ error, status: null, stdout: stdout.join(''), stderr: stderr.join('') }));
    child.on('close', (status) => finish({ status, stdout: stdout.join(''), stderr: stderr.join('') }));
  });
  }

  /* THE OTHER COMMAND LINES THIS SPAWN HANDS CreateProcess, for the
   * dispatcher's pre-spawn check. On win32 the contained launch starts
   * powershell.exe with the Job Object wrapper, and the codex command, its
   * arguments and the working directory ride on that command line
   * base64-encoded (windows-job-control.js jobWrapperInvocation). That line
   * is longer than the codex line itself, so measuring only the codex line
   * let a brief of roughly 24,000 to 30,000 characters pass the check and
   * then fail at CreateProcess. Built from the same resolution spawnHidden
   * uses (resolveHiddenInvocation) and the same working directory it falls
   * back to. Elsewhere there is no wrapper command line, so nothing is added. */
  defaultSpawn.windowsLaunchCommandLines = function windowsLaunchCommandLines(command, args, options = {}) {
    if (platform !== 'win32') return [];
    let invocation;
    try { invocation = resolveHiddenInvocation(command, args, options.env); }
    catch { invocation = { command, args }; }
    const wrapper = jobWrapperInvocation(invocation.command, invocation.args, {
      cwd: process.cwd(),
      env: options.env || process.env,
      terminateDescendantsOnRootExit: true
    });
    return [{ what: 'the Windows Job Object wrapper that contains the dispatch', command: wrapper.command, argv: wrapper.args }];
  };
  return defaultSpawn;
}

const defaultSpawn = createDefaultSpawn();

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
 * `accountHome` and `environment` belong to the explicitly selected account.
 * Both stay fixed for every task in the batch.
 */
function createCodexDispatcher({
  codexBinary,
  accountHome,
  environment,
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
  if (typeof accountHome !== 'string' || !accountHome.trim()) {
    throw new CloudAgentError('CLOUD_DISPATCH_NO_HOMES', "accountHome must name the selected account's CODEX_HOME.");
  }
  if (typeof environment !== 'string' || !environment.trim()) {
    throw new CloudAgentError('CLOUD_DISPATCH_NO_ENVIRONMENTS', 'environment must name the environment the selected account is authorized for.');
  }
  if (typeof scrubEnvironment !== 'function') {
    /* NOT OPTIONAL. A codex child inherits this process's environment unless
     * something removes the provider credentials from it, and the repository's
     * spawn-environment gate exists because that leak has happened here before.
     * Requiring it rather than defaulting means a caller cannot forget. */
    throw new CloudAgentError('CLOUD_DISPATCH_NO_SCRUB',
      'scrubEnvironment must be supplied so the codex child never inherits this process\'s provider credentials. Pass safeLaunchEnvironment from src/lib/providers/subscription-launch-env.js.');
  }

  return async function dispatch({ task, index }) {
    const prompt = task && typeof task.contract === 'string' ? task.contract : null;
    if (!prompt) {
      fail('CLOUD_DISPATCH_NO_PROMPT',
        `task ${index} carries no contract text to send. Admission validates every brief, so reaching here means the declaration was changed after admission.`);
    }

    const env = scrubEnvironment(process.env, { context: 'codex cloud dispatch' });
    env.CODEX_HOME = accountHome;

    /* A .js ENTRY POINT RUNS UNDER THIS PROCESS'S OWN NODE, a native binary is
     * spawned directly -- the one rule codexSpawn owns so dispatch and harvest
     * cannot diverge (they did: the harvest path ran a native codex.exe under
     * node and errored every fetch). Using process.execPath for a .js entry
     * means the child runs the same vetted runtime, and every argument travels
     * as an array element -- no quoting, no shell.
     *
     * `--` ENDS THE OPTIONS BEFORE THE BRIEF, because an array element is not
     * a quoted string to the CLI's own parser. Measured against codex-cli
     * 0.156.0: a brief that opens with a markdown bullet ("- fix ...") or a
     * front-matter rule ("---") is refused as an unexpected argument (exit 2,
     * nothing sent), which the classification below can only call UNCERTAIN
     * and so strands the wave for reconciliation; one that opens with "-c"
     * is accepted as a config override and the task goes out without its
     * brief. After `--` every one of those is the task prompt. */
    const { command, argv } = codexSpawn(codexBinary, ['cloud', 'exec', '--env', environment, '--branch', branch, '--', prompt]);

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
     * for briefs that arrive by other routes.
     *
     * MEASURED THE WAY WINDOWS MEASURES IT. This used to add a flat three
     * characters per argument -- two quotes and a space -- and never look
     * inside one, which ignores the escaping libuv applies when it folds argv
     * into a single command line. A quote-heavy brief therefore measured a
     * third under its true cost, passed this check, failed at CreateProcess,
     * and landed in the uncertain bucket the check exists to keep empty. See
     * windowsQuotedArgumentLength for the rule and the numbers.
     *
     * Enforced on every platform, not only win32, so a brief refused on one
     * machine in the fleet is refused on all of them; POSIX's own limit is
     * far larger, so this never refuses something execve would have taken. */
    let commandLineLength = windowsCommandLineLength(command, argv);
    if (commandLineLength > WINDOWS_COMMAND_LINE_LIMIT) {
      fail('CLOUD_DISPATCH_PROMPT_TOO_LONG',
        `the dispatch for task ${index} would need a ${commandLineLength}-unit Windows command line and CreateProcess caps it at ${WINDOWS_COMMAND_LINE_LIMIT}. Nothing was sent. Shrink the brief (the prompt is ${prompt.length} characters, which quoting and escaping expand), or carry its payload another way.`,
        { providerAnswered: true });
    }
    /* AND THE LINE THAT IS REALLY LAUNCHED. A spawn that wraps the codex
     * process (the contained win32 launch) names the command lines it hands
     * CreateProcess; each is held to the same cap, before anything starts.
     * An injected spawn that names none is measured on the codex line alone. */
    const launchLines = typeof spawnImpl.windowsLaunchCommandLines === 'function'
      ? spawnImpl.windowsLaunchCommandLines(command, argv, { env }) : [];
    for (const line of launchLines) {
      const lineLength = windowsCommandLineLength(line.command, line.argv);
      if (lineLength > WINDOWS_COMMAND_LINE_LIMIT) {
        fail('CLOUD_DISPATCH_PROMPT_TOO_LONG',
          `the dispatch for task ${index} would need a ${lineLength}-unit Windows command line for ${line.what}, and CreateProcess caps it at ${WINDOWS_COMMAND_LINE_LIMIT}. The wrapper carries the codex command and its arguments base64-encoded, about four units for every three bytes of the brief. Nothing was sent. Shrink the brief (the prompt is ${prompt.length} characters), or carry its payload another way.`,
          { providerAnswered: true });
      }
      commandLineLength = Math.max(commandLineLength, lineLength);
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
    if (outcome.error && COMMAND_LINE_REJECTION_CODES.has(outcome.error.code)) {
      /* CERTAIN, for the same reason CLI_ABSENT is. The kernel validated the
       * command line and refused to create the process, so nothing was sent
       * and nothing can be billing. This is the belt to the pre-spawn check's
       * braces: if the measurement above is ever wrong -- a limit that moved,
       * a quoting rule that changed -- the answer is still honest instead of
       * "we could not tell", which is what sent an operator to reconcile a
       * dispatch that had never left the machine. */
      fail('CLOUD_DISPATCH_COMMAND_LINE_REJECTED',
        `the dispatch for task ${index} was refused by the operating system before the codex process existed (${outcome.error.code}): the command line was too long. Nothing was sent, so there is nothing to reconcile. Its measured length was ${commandLineLength} units against a ${WINDOWS_COMMAND_LINE_LIMIT} cap, so that measurement is wrong and should be reported. Shrink the brief (the prompt is ${prompt.length} characters).`,
        { providerAnswered: true });
    }
    if (outcome.error) {
      /* A TIMEOUT IS THE WORST CASE AND IT IS DELIBERATELY NOT A REFUSAL. The
       * request may have arrived and be running; we simply stopped listening. */
      fail('CLOUD_DISPATCH_UNCERTAIN',
        `the dispatch for task ${index} did not complete. Whether the provider received it is unknown, so it is left to be reconciled rather than recorded as refused.`);
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
        `the provider declined task ${index}. Check the selected account or wait for its usage limit to reset.`,
        { providerAnswered: true });
    }
    fail('CLOUD_DISPATCH_UNCERTAIN',
      `the dispatch for task ${index} exited ${outcome.status} and its output matches no known provider refusal, so whether it reached the provider is unknown.`);
  };
}

module.exports = Object.freeze({
  COMMAND_LINE_REJECTION_CODES,
  DEFAULT_TIMEOUT_MS,
  MAX_PROMPT_CHARS,
  PROVIDER_REFUSAL_PATTERNS,
  WINDOWS_COMMAND_LINE_LIMIT,
  codexSpawn,
  createCodexDispatcher,
  createDefaultSpawn,
  extractTaskId,
  looksLikeProviderRefusal,
  windowsCommandLineLength,
  windowsQuotedArgumentLength
});
