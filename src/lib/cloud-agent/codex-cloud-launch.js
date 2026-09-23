'use strict';

// R1186: the PRODUCT path for "launch a Codex Cloud task", the operation the
// owner named as a product feature that must work from the software rather
// than from a developer's command line. It composes four things that already
// existed on this machine but had never been joined into one callable:
//
//   1. multi-account/switcher.js  -- WHICH account serves the call, with the
//      owner's requested failover, asking the provider instead of guessing.
//   2. multi-account/launch.js    -- the composed child environment: every
//      billing credential scrubbed, and CODEX_HOME pinned to the chosen
//      account's own home so the call cannot silently run as someone else.
//   3. multi-account/launch.js    -- codexExecutable(), the RESOLVED codex
//      executable. This is load-bearing on Windows: the transport spawns with
//      shell:false, and bare `codex` is an npm .cmd shim that shell:false
//      cannot resolve (measured here: `spawn codex ENOENT`). tools/cloud-lane.js
//      works around it with a --codex-binary flag, which is fine for a CLI and
//      useless for a person clicking a button; this module resolves it itself.
//   4. cloud-agent/codex-cli-transport.js -- the bounded, fail-closed client.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO, so nobody reads more into its
// output than is there: it does not route through the custody contract in
// ./contract.js. That contract requires a FileKeeperProof binding a pushed
// tree, and the only honest way to obtain one is the outbound half of
// tools/cloud-lane.js. Synthesizing a shape-valid proofId here would satisfy
// validateRequest() and forge custody evidence, so this module submits through
// the transport directly and reports ONLY what the CLI actually acknowledged.
// A task launched through here is a real cloud task; it is NOT a custody-
// verified change-delivery, and no caller should present it as one.
//
// Credential discipline: the composed environment legitimately carries account
// material, so it is never logged, never returned, and never placed in an
// error. Every value this module reports about an account is its NAME and its
// provider-reported usage PERCENT.

const { loadRegistry } = require('../multi-account/registry.js');
const { STATUS, probeAccount } = require('../multi-account/health.js');
const { commitLaunchSelection, resolveForLaunch } = require('../multi-account/switcher.js');
const { launchEnvironment, codexExecutable } = require('../multi-account/launch.js');
const { createCodexCliTransport } = require('./codex-cli-transport');
const { discoverCloudEnvironments } = require('./codex-cloud-environments');
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

/* NO CODEX PIN IS WRITTEN FROM THE CLOUD LANE, and that is a correction rather
 * than an omission.
 *
 * resolveForLaunch() accepts a `codexConfigPath` and, when given one, rewrites
 * `profileDir` in it so a switch is obeyed by other consumers. This lane used
 * to pass `ROOT/config/codex.json`, which produced two distinct faults on an
 * installed copy and neither could be seen from a checkout:
 *
 *   1. IT WRITES INTO THE INSTALL DIRECTORY. Exactly the class of defect
 *      src/lib/runtime-state-root.js exists to end, and the packaged build
 *      gates on that directory being byte-unchanged after a session.
 *   2. IT REPINS LOCAL DISPATCH AS A SIDE EFFECT. That file is read by
 *      src/lib/mission-bridge/actions.js to decide WHICH CODEX IDENTITY a
 *      local agent lane runs as. Launching a cloud task under the account that
 *      can see the environment would silently move every subsequent local
 *      dispatch onto that identity.
 *
 * Nothing about a cloud launch needs the pin: transportFor() below builds the
 * child environment from the chosen account's own profile directory directly.
 * The account that served is reported to the caller instead, which is the
 * visibility the pin was standing in for. */
const CODEX_PIN_PATH = null;

// Codex Cloud environment ids observed live are 32 lowercase hex characters.
// The display label (Owner/repo) is NOT an id and the CLI rejects it, so it is
// rejected here too with a message that says what to pass instead.
const ENVIRONMENT_ID = /^[0-9a-f]{32}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const MAX_PROMPT_CHARS = 32_768;
const MAX_TARGET_CHARS = 1_000;
// The declared source binding, bounded like the bridge's boundedText: a
// non-empty, single-line "owner/name". It is deliberately NOT pattern-strict
// beyond that -- the real check is the case-insensitive comparison below
// against the repository the PROVIDER reports for the environment, so a caller
// that declares a wrong-but-well-formed name is still stopped.
const MAX_REPOSITORY_CHARS = 220;
// Bounded paging for a single-task status search: 3 pages x 20 tasks. Bounded
// rather than exhaustive so a status read can never turn into an open-ended
// walk of the account's whole task history.
const STATUS_SEARCH_MAX_PAGES = 3;

// Derived from the id, not invented: `codex cloud list --json` returns this
// exact URL shape for every task it lists. It is a convenience link, which is
// why it is named for what it is rather than presented as provider output.
const TASK_URL_PREFIX = 'https://chatgpt.com/codex/tasks/';

// Submitting is the one operation where a retry can create a SECOND real cloud
// task. These outcomes mean "the CLI never got far enough to create anything",
// so failing over after them is safe. Anything else -- above all a timeout or
// an output-cap kill, whose true outcome is unknown -- is never retried.
//
// CODEX_CLI_ENV_NOT_FOUND is in this list for a reason that is easy to get
// backwards. MEASURED 2026-08-11 across three signed-in accounts on one
// machine, with one binary and one environment id: a Codex Cloud environment
// is scoped to the ACCOUNT THAT CREATED IT. The creating account resolved the
// environment; the other two reported "not found" for that same id. So failing
// over is not merely about who pays -- for an environment the current account
// cannot see, another account is the only thing that can make the launch work
// at all. Nothing is created when the CLI refuses an unknown environment, so
// retrying elsewhere is safe.
// (No account is named here, and none may be. This file ships inside the
// capability payload, so a customer would receive the comment along with the
// code; the accounts involved were the builder's own. Name the mechanism, not
// the identity.)
const SAFE_TO_FAILOVER_AFTER = Object.freeze([
  'CODEX_CLI_SPAWN_FAILED',
  'CODEX_CLI_NONZERO_EXIT',
  'CODEX_CLI_REPORTED_ERROR',
  'CODEX_CLI_ENV_NOT_FOUND'
]);

function fail(code, message) { throw new CloudAgentError(code, message); }

function requireEnvironment(value) {
  if (typeof value !== 'string' || !ENVIRONMENT_ID.test(value)) {
    fail('CLOUD_LAUNCH_ENVIRONMENT_INVALID',
      'environment must be a 32-character Codex Cloud environment id (for example the id in the chatgpt.com/codex/cloud/settings/environment/<id> URL), not the "Owner/repo" display label.');
  }
  return value;
}

function requireBranch(value) {
  if (typeof value !== 'string' || !BRANCH.test(value) || value.includes('..')) {
    fail('CLOUD_LAUNCH_BRANCH_INVALID', 'branch must be a plain git branch name with no leading dash and no ".." segment.');
  }
  return value;
}

function requirePrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) {
    fail('CLOUD_LAUNCH_PROMPT_INVALID',
      'prompt must be non-empty and cannot contain a null character.');
  }
  return value;
}

function requireTaskId(value) {
  if (typeof value !== 'string' || !TASK_ID.test(value)) {
    fail('CLOUD_LAUNCH_TASK_ID_INVALID', 'taskId must be an opaque [A-Za-z0-9_-] Codex Cloud task identifier.');
  }
  return value;
}

/* THE DECLARED SOURCE BINDING, REQUIRED.
 *
 * This mirrors the bridge action's `repository`: an absent or blank binding is a
 * REFUSAL, never an unbound launch. This codebase's recurring defect is a
 * missing field read as permission, and a cloud submission is the worst place
 * for it -- an environment points at a repository, the caller cannot see which,
 * and a task sent to the wrong one runs real work against someone else's source
 * and cannot be cancelled. The raw MCP tool is a shipped surface too, so it may
 * not lean on the bridge to enforce this on its behalf. */
function requireRepository(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_REPOSITORY_CHARS
      || value.includes('\0') || /[\r\n]/.test(value)) {
    fail('CLOUD_LAUNCH_REPOSITORY_INVALID',
      `repository must be a non-empty, single-line "owner/name" source binding of at most ${MAX_REPOSITORY_CHARS} characters. A launch without it is refused rather than run against an unverified environment.`);
  }
  return value.trim();
}

function requireTarget(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TARGET_CHARS
      || value.includes('\0') || /[\r\n]/.test(value)) {
    fail('CLOUD_LAUNCH_TARGET_INVALID',
      `target must name the concrete file, directory, component, or repository root in one line of at most ${MAX_TARGET_CHARS} characters.`);
  }
  return value.trim();
}

/**
 * Turn a person's task words into the contract Codex Cloud actually receives.
 *
 * The first line is deliberately sufficient on its own. Measured dispatches
 * showed that the cloud worker can treat only that line as its task, so neither
 * the repository nor the target may be left to later prose. The person's words
 * remain a distinct, verbatim body and the standing fences are always last.
 */
function buildCloudTaskContract({ repository, target, prompt } = {}) {
  const source = requireRepository(repository);
  const concreteTarget = requireTarget(target);
  const personWords = requirePrompt(prompt);
  const contract = [
    `ROLE: Codex Cloud worker in repository "${source}"; concrete target: "${concreteTarget}".`,
    '',
    'TASK FROM THE PERSON:',
    personWords,
    '',
    'STANDING FENCES:',
    `- Work only in repository "${source}" and start from "${concreteTarget}"; do not substitute a similarly named repository, directory, or component.`,
    '- Keep unrelated worktree changes intact and do not edit files outside the task.',
    '- Do not commit or push. Report the exact files changed and the tests run.'
  ].join('\n');
  if (contract.length > MAX_PROMPT_CHARS) {
    fail('CLOUD_LAUNCH_PROMPT_INVALID',
      `the complete cloud task contract must be at most ${MAX_PROMPT_CHARS} characters; shorten the task body without truncating it.`);
  }
  return contract;
}

function loadLaunchRegistry(load, registryPath = accountRegistryPath) {
  try {
    return load({ configPath: registryPath() });
  } catch (error) {
    if (error && error.code === 'ACCOUNTS_REGISTRY_MISSING') {
      fail('CLOUD_LAUNCH_ACCOUNT_NOT_REGISTERED',
        'Cloud dispatch has no ToolsEnabled account registration. This is separate from Codex CLI sign-in, so an existing signed-in session may still be present; do not sign in again solely because this registration is missing. Nothing was sent.');
    }
    throw error;
  }
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
 * Choose the account that should serve this call.
 *
 * `excluded` carries the accounts an earlier attempt in THIS call already
 * burned. They are reported to the selector as unable to serve rather than
 * filtered out silently, so the refusal message still names every account that
 * was considered and why each one was passed over.
 */
async function chooseAccount({
  registry,
  preferred = null,
  excluded = new Set(),
  probeImpl,
  statePath,
  codexConfigPath,
  persistSelection = true,
  fsImpl
}) {
  const probe = probeImpl || defaultProbe(registry);
  const selection = await resolveForLaunch({
    registry,
    preferred,
    statePath: statePath || STATE_PATH,
    codexConfigPath: codexConfigPath || CODEX_PIN_PATH,
    persistSelection,
    ...(fsImpl ? { fsImpl } : {}),
    probe: async (account) => {
      if (excluded.has(account.name)) {
        return Object.freeze({
          account: account.name, email: null, usedPercent: null, resetsAt: null, planType: null,
          status: STATUS.EXHAUSTED, canServe: false,
          reason: 'Already attempted during this request and it did not complete.'
        });
      }
      return probe(account);
    }
  });
  return selection;
}

// One transport bound to one account: resolved executable, that account's
// pinned+scrubbed environment, and the caller's branch/prompt.
function transportFor(account, { branch = null, prompt = null, attempts = null, timeoutMs, transportFactory, executableImpl, environmentImpl } = {}) {
  const executable = (executableImpl || codexExecutable)();
  const environment = (environmentImpl || launchEnvironment)(account, {});
  const factory = transportFactory || createCodexCliTransport;
  const options = {
    codexBinary: executable.command,
    prefixArgs: executable.prefixArgs || [],
    env: environment
  };
  if (branch !== null) options.branch = branch;
  if (attempts !== null) options.attempts = attempts;
  if (timeoutMs !== undefined) options.timeoutMs = timeoutMs;
  if (prompt !== null) options.buildQuery = () => prompt;
  return factory(options);
}

function isSafeToFailoverAfter(error) {
  return Boolean(error) && SAFE_TO_FAILOVER_AFTER.includes(error.code);
}

/**
 * VERIFY THE DECLARED SOURCE BINDING BEFORE ANY TRANSPORT CALL.
 *
 * This is the raw-MCP-tool half of the same fence the bridge action enforces in
 * src/lib/mission-bridge/actions.js (`cloudLaunch`). `cloud.task_launch` is a
 * shipped surface reachable without the bridge, so it cannot rely on the bridge
 * to have checked: it resolves the environment through the provider's own
 * account-scoped environment reader and refuses on every absence, mirroring the
 * bridge's four distinct outcomes so a person is sent to the right screen:
 *
 *   - the environments could not be read at all           -> BINDING_UNVERIFIED
 *   - the environment is absent from an INCOMPLETE reading -> BINDING_UNVERIFIED
 *   - the environment is absent from a COMPLETE reading    -> ENVIRONMENT_NOT_VISIBLE
 *   - the environment has no / a different repository       -> BINDING_UNVERIFIED / REPOSITORY_MISMATCH
 *
 * Returns the resolved, repository-matched environment row on success. Every
 * refusal happens with nothing sent, and the comparison is the point:
 * DECLARING the repository is necessary and not sufficient -- it is checked
 * against the binding the PROVIDER reports, so a wrong-but-well-formed
 * declaration is stopped, which is the case a declaration alone sails through.
 */
async function verifyRepositoryBinding({ environment, repository, registry, dependencies = {} }) {
  let discovery;
  try {
    discovery = await (dependencies.discoverEnvironmentsImpl || discoverCloudEnvironments)(
      { accounts: registry.accounts }, dependencies
    );
  } catch (error) {
    fail('CLOUD_LAUNCH_BINDING_UNVERIFIED',
      `The authorized Codex Cloud environments could not be read (${(error && error.code) || 'reader failed'}), so this environment's source repository could not be confirmed. Nothing was sent.`);
  }
  // A reader that resolves to nothing is a reader that failed, and it must
  // land on the same typed refusal as one that threw. The line below already
  // guarded `discovery &&` for `environments`; `discovery.complete` two lines
  // later did not, so an injected reader resolving null answered a launch with
  // "Cannot read properties of null (reading 'complete')" instead of a
  // refusal -- a crash exactly where this function's whole job is to refuse.
  if (!discovery || typeof discovery !== 'object') {
    fail('CLOUD_LAUNCH_BINDING_UNVERIFIED',
      'The authorized Codex Cloud environments reader returned no reading at all, so this environment\'s source repository could not be confirmed. Nothing was sent.');
  }
  const environments = Array.isArray(discovery.environments) ? discovery.environments : [];
  const bound = environments.find(entry => entry && entry.environmentId === environment) || null;
  if (!bound) {
    if (discovery.complete !== true) {
      /* WHY IT COULD NOT BE READ IN FULL IS ALREADY IN HAND. This function's
       * header promises it mirrors the bridge's four outcomes "so a person is
       * sent to the right screen", and for this one outcome it sent them
       * nowhere: MEASURED in capability/logs/actions.jsonl (grep -c "could not
       * be read in full", 2026-09-03) -- 7 of 7 matches are cloud.task_launch
       * failures, every one carrying only "could not be read in full", with no
       * account named and nothing to do.
       * discoverCloudEnvironments() returns `accounts`, each with a `reading`
       * and the sentence it already wrote for a failed one ("This account's
       * environments could not be read (<code>)."). Say which accounts those
       * were, and give the instruction its sibling in mission-bridge/actions.js
       * already gives for the identical condition. */
      const unreadable = (Array.isArray(discovery.accounts) ? discovery.accounts : [])
        .filter(entry => entry && entry.reading === 'unknown')
        .map(entry => `${entry.account || 'an unnamed account'}: ${entry.reason || 'no reason was reported'}`);
      fail('CLOUD_LAUNCH_BINDING_UNVERIFIED',
        `The authorized Codex Cloud environments could not be read in full, so this environment's source repository could not be confirmed. Nothing was sent.${
          unreadable.length ? ` Unread: ${unreadable.join('; ')}` : ''
        } A Codex Cloud environment is scoped to the account that created it, so sign in to the account that owns ${environment} on this computer and try again.`);
    }
    fail('CLOUD_LAUNCH_ENVIRONMENT_NOT_VISIBLE',
      `No configured Codex account is authorized for environment ${environment}, so nothing was sent. A Codex Cloud environment is scoped to the account that created it, so it must be launched from its owner's account.`);
  }
  if (typeof bound.repository !== 'string' || !bound.repository) {
    fail('CLOUD_LAUNCH_BINDING_UNVERIFIED',
      `That Codex Cloud environment does not report exactly one source repository${bound.reason ? ` (${bound.reason})` : ''}, so a task cannot be bound to one. Nothing was sent.`);
  }
  if (bound.repository.toLowerCase() !== repository.toLowerCase()) {
    fail('CLOUD_LAUNCH_REPOSITORY_MISMATCH',
      `That Codex Cloud environment is bound to ${bound.repository}, not to the declared ${repository}. Nothing was sent.`);
  }
  return bound;
}

/**
 * Launch a real Codex Cloud task.
 *
 * Resolves to a report whose `state` is the provider-neutral vocabulary from
 * ./contract.js. A confirmed submission is SUBMITTED. A call whose real
 * outcome the CLI did not make knowable is UNKNOWN with taskId null -- never
 * SUBMITTED, and never a synthesized id.
 */
async function launchCloudTask(request = {}, dependencies = {}) {
  const environment = requireEnvironment(request.environment);
  const branch = requireBranch(request.branch);
  const repository = requireRepository(request.repository);
  // Older trusted callers predate the node/action target field. Their honest
  // concrete target is the bound repository root; action surfaces should pass
  // the selected node's target explicitly so the first line is narrower.
  const target = request.target === undefined || request.target === null
    ? `repository root (${repository})`
    : requireTarget(request.target);
  const prompt = buildCloudTaskContract({ repository, target, prompt: request.prompt });
  const attempts = request.attempts === undefined || request.attempts === null ? null : request.attempts;
  if (attempts !== null && (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10)) {
    fail('CLOUD_LAUNCH_ATTEMPTS_INVALID', 'attempts must be an integer between 1 and 10 when provided.');
  }

  const registry = loadLaunchRegistry(
    dependencies.loadRegistryImpl || loadRegistry,
    dependencies.accountRegistryPathImpl || accountRegistryPath
  );

  // The declared repository is verified against the provider's own binding for
  // this environment BEFORE any transport is built or any task is created. A
  // refusal here means nothing was ever sent. See verifyRepositoryBinding.
  const bound = await verifyRepositoryBinding({ environment, repository, registry, dependencies });

  /* THE FRESHNESS GATE. A launch against a mirror that is not at this
   * checkout's HEAD is refused here, before any transport is built and before
   * any task is created.
   *
   * WHY THIS IS A GATE AND NOT A WARNING, MEASURED 2026-08-24. Cloud agents on
   * the app repository were diffing against a branch 467 commits behind local
   * HEAD, and their work came back as empty applies, as "fixes" already present
   * in the tree, and as citations pointing at unrelated code. The engine's
   * branch was 5 behind and its harvests were clean the same night. Nothing in
   * the prompt, the model or the harvest was broken -- the branch was old, and
   * nothing in this path had any reason to notice. A gate that warned would
   * have produced the same 28 wasted harvests with a line of text above them.
   *
   * IT KEYS ON THE PROVIDER'S BINDING, NOT THE CALLER'S DECLARATION.
   * `bound.repository` is what verifyRepositoryBinding just read back from the
   * environment itself, so the mirror that gets checked is the one the cloud
   * worker will actually clone. Keying on `repository` would check whichever
   * mirror the caller named, which is the same class of defect one layer up.
   *
   * INJECTED, AND THE DEFAULT IS THE REAL CHECK. Tests pass a stub because
   * their subject is account failover and repository binding; a default that
   * did nothing would make this gate present in the file and absent in the
   * product, which is the shape of tools/repo-sync.js -- built, correct, and in
   * zero npm scripts. */
  const checkMirror = dependencies.checkMirrorFreshnessImpl
    || require('./cloud-mirror').checkMirrorFreshness;
  /* THE BRANCH GOES WITH IT. One private mirror serves several projects, and the
     branch is derived per project, so repository alone can no longer say which
     project this dispatch belongs to. Passing it keeps this keyed on what the
     provider will actually clone while making the answer exact. */
  await checkMirror({ cloudRepository: bound.repository, mirrorBranch: branch });

  const excluded = new Set();
  const considered = [];
  // Accounts that answered specifically "I cannot see that environment". Kept
  // apart from `considered` so the final refusal can tell the two situations
  // apart: "nobody had allowance left" and "nobody owns this environment".
  const environmentUnseenBy = [];

  // Bounded by the number of configured accounts: failover never loops.
  for (let attempt = 0; attempt < registry.accounts.length; attempt += 1) {
    const selection = await chooseAccount({
      registry,
      preferred: request.account || null,
      excluded,
      probeImpl: dependencies.probeImpl,
      statePath: dependencies.statePath,
      codexConfigPath: dependencies.codexConfigPath,
      persistSelection: false,
      fsImpl: dependencies.fsImpl
    });
    if (!selection.ok) {
      fail('CLOUD_LAUNCH_NO_ACCOUNT_AVAILABLE',
        `No configured Codex account can serve this launch: ${selection.reason}`);
    }

    const account = selection.account;
    excluded.add(account.name);
    considered.push(account.name);

    let transport;
    try {
      transport = transportFor(account, {
        branch, prompt, attempts,
        timeoutMs: dependencies.timeoutMs,
        transportFactory: dependencies.transportFactory,
        executableImpl: dependencies.executableImpl,
        environmentImpl: dependencies.environmentImpl
      });
    } catch (error) {
      // A profile that is missing or signed out is this account's problem, not
      // the request's: try the next account rather than failing the launch.
      if (error && (error.code === 'ACCOUNT_PROFILE_UNAVAILABLE' || error.code === 'LAUNCH_BILLING_CREDENTIAL_PRESENT')) {
        if (error.code === 'LAUNCH_BILLING_CREDENTIAL_PRESENT') throw error; // a leaked credential is never routed around
        continue;
      }
      throw error;
    }

    let raw;
    try {
      raw = await transport.createTask({ environment });
    } catch (error) {
      if (!isSafeToFailoverAfter(error)) {
        // Ambiguous: a task MAY exist on the provider side. Say so exactly.
        return Object.freeze({
          ok: false,
          state: 'UNKNOWN',
          taskId: null,
          environment,
          branch,
          account: accountReport(account, selection.probe),
          accountsConsidered: Object.freeze([...considered]),
          code: error && error.code ? error.code : 'CLOUD_LAUNCH_FAILED',
          message: error && error.message ? error.message : 'The launch did not complete and its real outcome is unknown.'
        });
      }
      // An environment this account cannot see is not an allowance problem and
      // never will be: no probe can change it. Move straight to the next
      // account, which is the only thing that can resolve it.
      if (error.code === 'CODEX_CLI_ENV_NOT_FOUND') {
        environmentUnseenBy.push(account.name);
        continue;
      }
      // Nothing was created. Ask the provider whether THIS account is spent
      // before deciding to move on -- never pattern-match the CLI's wording.
      const after = await (dependencies.probeImpl || defaultProbe(registry))(account);
      if (after && after.status === STATUS.EXHAUSTED) continue;
      throw error;
    }

    if (!raw || typeof raw.id !== 'string') {
      // The CLI returned no error signature and no task id. Refusing to guess.
      return Object.freeze({
        ok: false,
        state: 'UNKNOWN',
        taskId: null,
        environment,
        branch,
        account: accountReport(account, selection.probe),
        accountsConsidered: Object.freeze([...considered]),
        code: 'CLOUD_LAUNCH_UNCONFIRMED',
        message: 'The codex CLI reported neither an error nor a task id, so whether a task was created is unknown.'
      });
    }

    // Selection is a preflight, not success. Only the provider's concrete task
    // id proves that this account actually served the launch; committing any
    // earlier makes a refused, timed-out, or environment-invisible attempt the
    // preferred account for the next request.
    commitLaunchSelection({
      selection,
      statePath: dependencies.statePath || STATE_PATH,
      codexConfigPath: dependencies.codexConfigPath || CODEX_PIN_PATH,
      ...(dependencies.fsImpl ? { fsImpl: dependencies.fsImpl } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {})
    });

    return Object.freeze({
      ok: true,
      state: mapStatus(raw.status),
      taskId: raw.id,
      taskUrl: `${TASK_URL_PREFIX}${raw.id}`,
      environment,
      // The provider-reported binding the declaration was checked against, so
      // the receipt records the repository the task actually landed in rather
      // than only the one the caller asserted.
      repository: bound.repository,
      branch,
      account: accountReport(account, selection.probe),
      accountsConsidered: Object.freeze([...considered])
    });
  }

  // Name the actual wall that was hit. A Codex Cloud environment belongs to
  // the account that created it, so "no account could see this environment" is
  // a different problem with a different fix than "every account is spent", and
  // telling a person the wrong one sends them to the wrong screen.
  if (environmentUnseenBy.length > 0) {
    fail('CLOUD_LAUNCH_ENVIRONMENT_NOT_VISIBLE',
      `No configured Codex account can see environment ${environment}. A Codex Cloud environment is scoped to the account that created it, so it must be launched from its owner's account, or an environment for this repository must be created under one of these accounts: ${environmentUnseenBy.join(', ')}.`);
  }
  fail('CLOUD_LAUNCH_NO_ACCOUNT_AVAILABLE',
    `Every configured Codex account was tried and none could serve this launch (tried: ${considered.join(', ') || 'none'}).`);
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
 * Read-only, so failing over between accounts here is always safe. Paging is
 * bounded: a task outside the searched window is reported UNKNOWN/notFound,
 * never guessed.
 */
async function cloudTaskStatus(request = {}, dependencies = {}) {
  const taskId = requireTaskId(request.taskId);
  const registry = (dependencies.loadRegistryImpl || loadRegistry)({
    configPath: (dependencies.accountRegistryPathImpl || accountRegistryPath)()
  });
  // persistSelection:false -- see the identical note on listCloudTasks below.
  // This is a status READ; it must choose an account to ask, not adopt one.
  const selection = await chooseAccount({ registry, preferred: request.account || null, probeImpl: dependencies.probeImpl,
      statePath: dependencies.statePath,
      codexConfigPath: dependencies.codexConfigPath,
      persistSelection: false });
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

// THE RETRIEVAL LEG. Without this, a cloud task is write-only: the product
// could launch one, the provider would charge for it, and the only thing that
// ever came back was a URL. That is not a tooling inconvenience -- launching a
// cloud agent is a shipped product feature, so a customer hits it too. It is
// also how ~2,380 dispatched tasks landed zero lines: the work existed, and
// nothing could fetch it.
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
  // persistSelection:false -- see the identical note on listCloudTasks below.
  // This is a diff READ; it must choose an account to ask, not adopt one.
  const selection = await chooseAccount({
    registry,
    preferred: request.account || null,
    probeImpl: dependencies.probeImpl,
    statePath: dependencies.statePath,
    codexConfigPath: dependencies.codexConfigPath,
    persistSelection: false
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
  /* persistSelection:false, MEASURED. cloud.task_list, cloud.task_status and
   * cloud.task_diff are all declared `effect: 'external-read', readOnlyHint:
   * true` in tool-registry.js -- three tools a caller and an approval policy
   * are both told do nothing but look. Left at chooseAccount()'s own default
   * (persistSelection:true, since none of these three passed the override
   * launchCloudTask's own per-attempt selection already uses two screens up),
   * every one of them called resolveForLaunch() -> commitLaunchSelection(),
   * which unconditionally writes STATE_PATH: it appends a `history` entry on
   * every single call, and when the account it happened to pick differs from
   * the one currently active, it FLIPS `activeAccount` -- exactly the
   * "repins something as a side effect of a call that only looked" defect
   * CODEX_PIN_PATH's own comment above already ruled out for the codex-config
   * pin, left standing here for the state file.
   *
   * Reproduced 2026-09-03 against this file pre-fix, no source outside this
   * repo: seed state.json with activeAccount:"first" (registry priority 1,
   * the untouched default); call cloudTaskStatus() ONCE with an explicit
   * `account:"third"` (an ordinary status check, nothing that asks to
   * switch anything); then call listCloudTasks() with NO account. Before this
   * fix that second, unspecified call probed "third" first and served from
   * it -- not "first" -- because resolveForLaunch()'s own bias,
   * `preferred || activeFor(state, provider)`, read back exactly what the
   * status read had just committed. A caller who never named an account
   * could not have predicted or seen that choice being made. Five consecutive
   * read-only status polls in a tight loop -- an ordinary "watch this task"
   * UI -- left five new entries in `history`, unbounded, from calls that told
   * their caller they only looked.
   *
   * The fix is the same one line launchCloudTask already applies to its own
   * preflight selection, on all three read paths: choosing an account to ask
   * is still exactly resolveForLaunch()'s job; adopting the answer as the
   * account everything else now runs as is not a read's job to do. */
  const selection = await chooseAccount({ registry, preferred: request.account || null, probeImpl: dependencies.probeImpl,
      statePath: dependencies.statePath,
      codexConfigPath: dependencies.codexConfigPath,
      persistSelection: false });
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

/**
 * Read-only enumeration of the configured accounts, each asked whether it can
 * actually serve right now.
 *
 * WHY THIS EXISTS AT ALL. Every other function here reports the account that
 * ALREADY served, which is enough for a receipt and useless for a choice: a
 * person cannot pick between accounts they have never been shown. The owner has
 * more than one authorized Codex account and asked that both be used, and until
 * this call the product had no way to say which ones exist, which one a launch
 * would land on, or why it would skip the others. That made the account an
 * implicit property of a launch, which is precisely what an outward action must
 * not have.
 *
 * NEVER FAILS BECAUSE ONE ACCOUNT IS UNHEALTHY. A signed-out or spent account is
 * a row with a reason on it, not an error: the whole point is to show the person
 * the state they need to fix. The only refusal is an unreadable registry, which
 * is a different fact and reported as one.
 *
 * WHAT IS DELIBERATELY NOT RETURNED: the account's e-mail address. probeAccount
 * reads one and this function drops it. The registry NAME is what the launch
 * arguments use and what a receipt cites, so the address adds no capability, and
 * this value crosses into a renderer and into audit metadata. accountReport()
 * above made the same choice for the same reason; making it twice by accident
 * would be luck, so it is stated here.
 */
function readAccountRegistry(load, registryPath = accountRegistryPath) {
  // Missing is UNKNOWN, not EMPTY. loadRegistry's named refusal must reach the
  // surface unchanged; manufacturing [] here is the mutation that made two
  // provisioned accounts appear to be zero when a different path was read.
  return load({ configPath: registryPath() });
}

async function listCloudAccounts(request = {}, dependencies = {}) {
  const registry = readAccountRegistry(
    dependencies.loadRegistryImpl || loadRegistry,
    dependencies.accountRegistryPathImpl || accountRegistryPath
  );
  const probe = dependencies.probeImpl || defaultProbe(registry);
  const accounts = [];
  for (const account of registry.accounts) {
    let reading = null;
    let failure = null;
    try {
      reading = await probe(account);
    } catch (error) {
      // An account whose probe THREW is unknown, not spent and not signed out.
      // Reporting it as either would send the person to the wrong remedy.
      failure = error && error.code ? error.code : 'ACCOUNT_PROBE_FAILED';
    }
    accounts.push(Object.freeze({
      name: account.name,
      role: typeof account.role === 'string' ? account.role : null,
      priority: account.priority,
      status: failure ? 'unknown' : (reading ? reading.status : 'unknown'),
      canServe: failure ? false : Boolean(reading && reading.canServe),
      usedPercent: !failure && reading && Number.isFinite(reading.usedPercent) ? reading.usedPercent : null,
      resetsAt: !failure && reading && typeof reading.resetsAt === 'string' ? reading.resetsAt : null,
      planType: !failure && reading && typeof reading.planType === 'string' ? reading.planType : null,
      reason: failure
        ? `This account could not be checked (${failure}). That says nothing about its allowance.`
        : (reading && typeof reading.reason === 'string' ? reading.reason : null)
    }));
  }
  // The account a launch with no explicit choice would land on: the first that
  // can serve, in registry priority order. Computed from the same readings the
  // caller is being shown, so the UI cannot claim a default the launch would
  // not honour.
  const serving = accounts.find(account => account.canServe) || null;

  /* THE ENVIRONMENT AXIS RIDES WITH THE ACCOUNT AXIS, and that is a statement
   * about the provider rather than a convenience. A Codex Cloud environment is
   * scoped to the account that created it -- measured across three signed-in
   * accounts on one machine: the creating account resolved the id and the other
   * two answered "not found" for the same id. So "which environments exist" has
   * no answer that is not per-account, and the two questions a person actually
   * asks -- which account will serve, and which environment can it launch into
   * -- are one question with one answer.
   *
   * A discovery that fails does NOT fail this call. The accounts half is still
   * true and still useful; the environments half reports `complete: false` and
   * the caller must say so rather than render a short list as the whole set. */
  /* WITH NO ACCOUNT TO ASK, AN EMPTY LIST IS THE WHOLE SET. `complete: true`
     here is not optimism: an environment is scoped to an account, so with no
     accounts there is nothing this list could be missing. Reporting it as
     incomplete would make the surface say "this may be partial" about a set
     that is provably empty, and send somebody looking for environments that
     cannot exist. */
  let discovery;
  if (registry.accounts.length === 0) {
    discovery = Object.freeze({
      environments: Object.freeze([]),
      accounts: Object.freeze([]),
      complete: true,
      readAt: new Date().toISOString(),
      reason: 'No Codex account is signed in on this computer, so there was nothing to ask.'
    });
  } else {
    try {
      discovery = await (dependencies.discoverEnvironmentsImpl || discoverCloudEnvironments)(
        { accounts: registry.accounts }, dependencies
      );
    } catch (error) {
      discovery = Object.freeze({
        environments: Object.freeze([]),
        accounts: Object.freeze([]),
        complete: false,
        readAt: new Date().toISOString(),
        reason: `The authorized environments could not be read (${(error && error.code) || 'reader failed'}).`
      });
    }
  }
  /* MATCHED BY (name, provider), NOT NAME ALONE. A registry name is unique
   * only WITHIN one provider (registry.js scopes its duplicate check
   * "<provider>:<name>"), so this registry can legitimately hold two
   * accounts, on two different providers, that share a name.
   * discovery.accounts now carries each reading's provider (see
   * codex-cloud-environments.js) precisely so this lookup can tell them
   * apart; a plain name-keyed Map here returned whichever entry happened to
   * be inserted last for that name -- MEASURED live 2026-09-03: a non-Codex
   * account was reported "authorized" for the Codex account's own
   * environments purely because the two share a name. */
  const readingFor = (name, provider) => discovery.accounts.find(entry => entry.account === name && entry.provider === provider) || null;

  return Object.freeze({
    accounts: Object.freeze(accounts.map((account, index) => {
      // registry.accounts[index] corresponds to accounts[index]: the loop
      // that built `accounts` above pushes exactly one entry per
      // registry.accounts iteration, in order, nothing filtered or
      // reordered in between.
      const provider = registry.accounts[index] && typeof registry.accounts[index].provider === 'string'
        ? registry.accounts[index].provider
        : null;
      const reading = readingFor(account.name, provider);
      return Object.freeze({
        ...account,
        environmentsReading: reading ? reading.reading : 'unknown',
        environmentsReason: reading ? reading.reason : 'This account was not asked for its environments.',
        // Guarded on provider too, for the same reason as readingFor() above:
        // environment.accounts (codex-cloud-environments.js) is a bare name
        // list that only a Codex-provider reading ever populates, so a
        // non-Codex row can never legitimately own an entry in it -- matching
        // it by name alone here was the same defect as the Map above, just
        // on the environment list instead of the reading.
        environments: Object.freeze(provider === 'codex'
          ? discovery.environments
            .filter(environment => environment.accounts.includes(account.name))
            .map(environment => environment.environmentId)
          : [])
      });
    })),
    defaultAccount: serving ? serving.name : null,
    signedIn: accounts.length > 0,
    exhaustedAtPercent: registry.exhaustedAtPercent,
    environments: discovery.environments,
    environmentsComplete: discovery.complete === true,
    environmentsReadAt: discovery.readAt
  });
}

module.exports = Object.freeze({
  ENVIRONMENT_ID,
  SAFE_TO_FAILOVER_AFTER,
  MAX_DIFF_BYTES,
  accountRegistryPath,
  buildCloudTaskContract,
  cloudTaskDiff,
  cloudTaskStatus,
  launchCloudTask,
  listCloudAccounts,
  listCloudTasks
});
