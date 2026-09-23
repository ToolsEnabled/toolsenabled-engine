'use strict';

// Behavioural tests for the Codex Cloud product launch path.
//
// Everything is injected: no network, no real codex binary, no real account
// registry, and no writes outside a per-run temp directory. Each assertion
// carries a DISTINCT message so a mutant that dies for a new reason stays
// visible instead of hiding behind a shared "expected true" failure.
//
// The behaviours pinned here are the ones that were WRONG when this path was
// first built and were only found by launching a real cloud task:
//   - a Codex Cloud environment is scoped to the account that created it, so
//     the launcher must fail over across accounts on env-not-found;
//   - `codex cloud exec` reports env-not-found with a NONZERO exit, so the
//     transport must classify by content and not by exit code;
//   - a freshly accepted task reports provider status "pending";
//   - an ambiguous submit must never be retried and never invent a task id.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const launcher = require('../src/lib/cloud-agent/codex-cloud-launch');
const { createCodexCliTransport } = require('../src/lib/cloud-agent/codex-cli-transport');
const { mapStatus } = require('../src/lib/providers/codex-cloud');

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-launch-test-'));
const ENVIRONMENT = 'a'.repeat(32);
// The repository the test environment is bound to. A launch must now DECLARE
// this and it is verified against the provider's reported binding before
// anything is sent. Deliberately an example owner/name, not this repo's own.
const REPOSITORY = 'ExampleOwner/example-repo';

// A stand-in for discoverCloudEnvironments: it answers the same shape the real
// reader does. By default it reports ENVIRONMENT authorized and bound to
// REPOSITORY for every account, so a correctly declared launch passes the
// binding gate; individual tests override it to exercise every refusal.
function stubDiscovery({ complete = true, environments, accounts = [] } = {}) {
  const envs = environments !== undefined ? environments : [
    {
      environmentId: ENVIRONMENT, label: 'Example', repository: REPOSITORY,
      repositories: [REPOSITORY], defaultBranch: 'main', visibility: 'private',
      launchable: true, reason: null, accounts: ['first', 'second', 'third']
    }
  ];
  return { environments: envs, accounts, complete, readAt: '2026-08-11T00:00:00.000Z' };
}

// A FRESH state/pin pair per test block. The launcher deliberately persists
// which account last served, so a shared state file would let one block's
// outcome pick the starting account for the next one -- real behaviour, but it
// would make these tests order-dependent and their failures misleading.
let stateSeq = 0;
function freshPaths() {
  stateSeq += 1;
  return {
    statePath: path.join(TEMP_ROOT, `state-${stateSeq}.json`),
    codexConfigPath: path.join(TEMP_ROOT, `codex-${stateSeq}.json`)
  };
}

const REGISTRY = Object.freeze({
  exhaustedAtPercent: 95,
  accounts: Object.freeze([
    Object.freeze({ name: 'first', role: 'institutional', profileDir: '.codex-first', priority: 1 }),
    Object.freeze({ name: 'second', role: 'personal', profileDir: '.codex-second', priority: 2 }),
    Object.freeze({ name: 'third', role: 'work', profileDir: '.codex-third', priority: 3 })
  ])
});

function healthyProbe(account) {
  return Promise.resolve(Object.freeze({
    account: account.name, email: null, usedPercent: 5, resetsAt: null, planType: 'pro',
    status: 'healthy', canServe: true, reason: `"${account.name}" can serve.`
  }));
}

// A CloudAgentError-shaped rejection, matching what the transport really throws.
function transportError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function baseDeps(overrides) {
  const paths = freshPaths();
  return Object.assign({
    accountRegistryPathImpl: () => path.join(TEMP_ROOT, 'accounts.json'),
    loadRegistryImpl: () => REGISTRY,
    probeImpl: healthyProbe,
    statePath: paths.statePath,
    codexConfigPath: paths.codexConfigPath,
    executableImpl: () => ({ command: 'fake-codex', prefixArgs: [] }),
    environmentImpl: () => ({ CODEX_HOME: 'fake-home' }),
    // Every launch now verifies its declared repository against the provider's
    // environment binding first; injected so no test performs a real network read.
    discoverEnvironmentsImpl: async () => stubDiscovery(),
    // Every launch also refuses when the cloud mirror it would diff against is
    // not at this checkout's HEAD. Stubbed fresh here because these cases are
    // about account failover and repository binding; the gate itself is proven
    // by its own case below and by tests/cloud-mirror.test.js.
    checkMirrorFreshnessImpl: async () => ({ fresh: true, project: 'stub' })
  }, overrides);
}

function seedPreference(deps, activeAccount = 'second') {
  const state = `${JSON.stringify({
    activeAccount,
    lastSwitch: null,
    history: [{ at: '2026-08-10T00:00:00.000Z', outcome: 'manual-switch', account: activeAccount }]
  }, null, 2)}\n`;
  const pin = `${JSON.stringify({ $comment: ['fixture pin'], profileDir: `.codex-${activeAccount}` }, null, 2)}\n`;
  fs.writeFileSync(deps.statePath, state, 'utf8');
  fs.writeFileSync(deps.codexConfigPath, pin, 'utf8');
  return { state, pin };
}

(async () => {
  // ---------------------------------------------------------------------
  // 1. Environment scoping: the launcher must walk past accounts that cannot
  //    see the environment and land on the one that can.
  // ---------------------------------------------------------------------
  {
    const attemptedBy = [];
    const deps = baseDeps({
      transportFactory: () => ({
        createTask: async () => {
          const account = attemptedBy.length;
          attemptedBy.push(account);
          // Only the THIRD account can see this environment.
          if (attemptedBy.length < 3) throw transportError('CODEX_CLI_ENV_NOT_FOUND', 'not found');
          return { id: 'task_e_abcdef123456', status: 'pending' };
        }
      })
    });
    const result = await launcher.launchCloudTask(
      { environment: ENVIRONMENT, branch: 'main', prompt: 'do a thing', repository: REPOSITORY }, deps);

    check(result.ok === true, 'env-scoped failover: a launch that succeeds on the third account must report ok:true');
    check(result.taskId === 'task_e_abcdef123456', 'env-scoped failover: the provider task id must be reported verbatim');
    check(result.account.name === 'third', 'env-scoped failover: the SERVING account must be the one that could see the environment, not the first tried');
    check(result.accountsConsidered.length === 3, 'env-scoped failover: every account tried must appear in accountsConsidered');
    check(result.state === 'SUBMITTED', 'env-scoped failover: provider status "pending" must map to SUBMITTED, not UNKNOWN');
    const committedState = JSON.parse(fs.readFileSync(deps.statePath, 'utf8'));
    const committedPin = JSON.parse(fs.readFileSync(deps.codexConfigPath, 'utf8'));
    check(committedState.activeAccount === 'third',
      'env-scoped failover: only the account that received a concrete provider task id becomes active');
    check(committedState.history.filter(entry => entry.outcome === 'selected').length === 1
      && committedState.history.at(-1).account === 'third',
    'env-scoped failover: failed preflight attempts must never leave selected-account history');
    check(committedPin.profileDir === '.codex-third',
      'env-scoped failover: the profile pin is committed only to the account that actually launched');
  }

  // ---------------------------------------------------------------------
  // 2. No account can see the environment -> a precise, actionable refusal
  //    that names the environment problem rather than an allowance problem.
  // ---------------------------------------------------------------------
  {
    const deps = baseDeps({
      transportFactory: () => ({
        createTask: async () => { throw transportError('CODEX_CLI_ENV_NOT_FOUND', 'not found'); }
      })
    });
    const preferenceBefore = seedPreference(deps);
    let raised = null;
    try {
      await launcher.launchCloudTask({ environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY }, deps);
    } catch (error) { raised = error; }

    check(raised !== null, 'invisible environment: exhausting every account must throw rather than resolve');
    check(raised.code === 'CLOUD_LAUNCH_ENVIRONMENT_NOT_VISIBLE',
      'invisible environment: the refusal must be ENVIRONMENT_NOT_VISIBLE, not the generic NO_ACCOUNT_AVAILABLE');
    check(/scoped to the account that created it/.test(raised.message),
      'invisible environment: the message must explain that an environment belongs to its creating account');
    check(fs.readFileSync(deps.statePath, 'utf8') === preferenceBefore.state
      && fs.readFileSync(deps.codexConfigPath, 'utf8') === preferenceBefore.pin,
    'invisible environment: a refused launch must leave both account preference and profile pin byte-identical');
  }

  // ---------------------------------------------------------------------
  // 3. An AMBIGUOUS submit is never retried and never invents an id.
  //    A timeout could mean a task was created; retrying would double-submit.
  // ---------------------------------------------------------------------
  {
    let calls = 0;
    const deps = baseDeps({
      transportFactory: () => ({
        createTask: async () => { calls += 1; throw transportError('CODEX_CLI_TIMEOUT', 'killed'); }
      })
    });
    const preferenceBefore = seedPreference(deps);
    // Caught deliberately. If the no-retry rule regresses, launchCloudTask
    // stops RETURNING an UNKNOWN report and starts THROWING the transport's
    // raw error instead -- which would surface here as a bare "Error: killed"
    // that tells a reader nothing about what broke. Converting it into a named
    // assertion keeps the reason for the failure legible.
    let result = null;
    let raised = null;
    try {
      result = await launcher.launchCloudTask(
        { environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY }, deps);
    } catch (error) { raised = error; }

    check(raised === null,
      `ambiguous submit: an ambiguous outcome must be REPORTED as UNKNOWN, not thrown (threw ${raised && raised.code})`);
    check(calls === 1, 'ambiguous submit: a timeout must NOT be retried on another account (that would risk two real cloud tasks)');
    check(result && result.ok === false, 'ambiguous submit: an unconfirmed launch must not report ok:true');
    check(result && result.state === 'UNKNOWN', 'ambiguous submit: an unconfirmed launch must report state UNKNOWN');
    check(result && result.taskId === null, 'ambiguous submit: an unconfirmed launch must report a null task id, never a synthesized one');
    check(result && result.code === 'CODEX_CLI_TIMEOUT', 'ambiguous submit: the originating transport error code must be preserved');
    check(fs.readFileSync(deps.statePath, 'utf8') === preferenceBefore.state
      && fs.readFileSync(deps.codexConfigPath, 'utf8') === preferenceBefore.pin,
    'ambiguous submit: an unknown launch outcome must leave account preference and profile pin byte-identical');
  }

  // ---------------------------------------------------------------------
  // 4. The CLI answered with neither an error nor a task id.
  // ---------------------------------------------------------------------
  {
    const deps = baseDeps({ transportFactory: () => ({ createTask: async () => null }) });
    const result = await launcher.launchCloudTask(
      { environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY }, deps);

    check(result.ok === false, 'unconfirmed submit: a null transport result must not report ok:true');
    check(result.taskId === null, 'unconfirmed submit: a null transport result must yield a null task id');
    check(result.code === 'CLOUD_LAUNCH_UNCONFIRMED', 'unconfirmed submit: the distinct CLOUD_LAUNCH_UNCONFIRMED code must be used');
  }

  // ---------------------------------------------------------------------
  // 5. Input shapes the CLI would misread are refused before any spawn.
  // ---------------------------------------------------------------------
  {
    const spawnCounter = { count: 0 };
    const deps = baseDeps({
      transportFactory: () => ({ createTask: async () => { spawnCounter.count += 1; return { id: 'task_e_zzzzzzzz', status: 'pending' }; } })
    });
    const cases = [
      // A display label, not a real one: this repository's own owner/repo pair
      // is deliberately not used, so no builder identity travels in a fixture.
      [{ environment: 'ExampleOwner/example-repo', branch: 'main', prompt: 'x' }, 'CLOUD_LAUNCH_ENVIRONMENT_INVALID',
        'input shapes: the "Owner/repo" display label must be refused as an environment id'],
      [{ environment: ENVIRONMENT, branch: '--not-a-branch', prompt: 'x' }, 'CLOUD_LAUNCH_BRANCH_INVALID',
        'input shapes: a branch that starts with a dash must be refused']
    ];
    for (const [request, expectedCode, message] of cases) {
      let raised = null;
      try { await launcher.launchCloudTask(request, deps); } catch (error) { raised = error; }
      check(raised && raised.code === expectedCode, message);
    }
    check(spawnCounter.count === 0, 'input shapes: no invalid request may reach the transport at all');
  }

  // ---------------------------------------------------------------------
  // 6. Every person's prompt is wrapped in a first-line repository/target
  //    contract. Generic words and words naming no file must not be dispatched
  //    bare, and a body beyond Windows' 8191-character command ceiling must be
  //    preserved rather than silently truncated.
  // ---------------------------------------------------------------------
  {
    let seenQuery = null;
    const deps = baseDeps({
      transportFactory: (options) => {
        seenQuery = options.buildQuery ? options.buildQuery({}) : null;
        return { createTask: async () => ({ id: 'task_e_spaces12', status: 'pending' }) };
      }
    });
    const personWords = 'fix controls that do nothing';
    const target = 'src/lib/cloud-agent/';
    const result = await launcher.launchCloudTask(
      { environment: ENVIRONMENT, branch: 'main', prompt: personWords, repository: REPOSITORY, target }, deps);
    check(result.ok === true, 'generic prompt contract: an ordinary non-technical request must be accepted');
    check(seenQuery.split('\n')[0] === `ROLE: Codex Cloud worker in repository "${REPOSITORY}"; concrete target: "${target}".`,
      'generic prompt contract: the FIRST LINE must name the exact repository and concrete target');
    check(seenQuery.includes(`TASK FROM THE PERSON:\n${personWords}\n`),
      'generic prompt contract: the person\'s generic words must remain verbatim in the task body');
    check(seenQuery.endsWith('- Do not commit or push. Report the exact files changed and the tests run.'),
      'generic prompt contract: standing fences must be the final block');
  }

  {
    const noFileWords = 'make the login button work';
    const target = 'src/auth/login-button.js';
    const contract = launcher.buildCloudTaskContract({ repository: REPOSITORY, target, prompt: noFileWords });
    check(contract.split('\n')[0].includes(`concrete target: "${target}"`),
      'no-file prompt contract: a prompt naming no file must inherit the concrete action target on its first line');
    check(contract.includes(`TASK FROM THE PERSON:\n${noFileWords}\n`),
      'no-file prompt contract: the seam must not rewrite or guess at the person\'s words');
  }

  {
    const longWords = 'keep this exact task body intact. '.repeat(300);
    check(longWords.length > 8191,
      'long prompt contract: the fixture itself must exceed the Windows command-line ceiling');
    const contract = launcher.buildCloudTaskContract({
      repository: REPOSITORY, target: 'src/auth/login-button.js', prompt: longWords
    });
    check(contract.includes(`TASK FROM THE PERSON:\n${longWords}\n\nSTANDING FENCES:`),
      'long prompt contract: the complete over-ceiling person body must survive without truncation');
  }

  {
    const missing = Object.assign(new Error('registry absent'), { code: 'ACCOUNTS_REGISTRY_MISSING' });
    const deps = baseDeps({ loadRegistryImpl: () => { throw missing; } });
    let raised = null;
    try {
      await launcher.launchCloudTask({
        environment: ENVIRONMENT, branch: 'main', repository: REPOSITORY,
        target: 'src/auth/login-button.js', prompt: 'fix the login button'
      }, deps);
    } catch (error) { raised = error; }
    check(raised && raised.code === 'CLOUD_LAUNCH_ACCOUNT_NOT_REGISTERED',
      'missing registry: the action must identify missing ToolsEnabled account registration, not infer CLI sign-out');
    check(/separate from Codex CLI sign-in/.test(raised && raised.message),
      'missing registry: the remedy must distinguish product registration from an existing CLI sign-in');
    check(!/sign in to Codex Cloud/i.test(raised && raised.message),
      'missing registry: the action must not tell an already-signed-in person to sign in again');
  }

  // ---------------------------------------------------------------------
  // 7. Account pinning: the transport must be built with the chosen account's
  //    composed environment and the RESOLVED executable, not a bare name.
  // ---------------------------------------------------------------------
  {
    let observed = null;
    const deps = baseDeps({
      executableImpl: () => ({ command: 'C:/resolved/codex.exe', prefixArgs: ['--flagless-prefix'] }),
      environmentImpl: (account) => ({ CODEX_HOME: `home-for-${account.name}` }),
      transportFactory: (options) => { observed = options; return { createTask: async () => ({ id: 'task_e_pinned01', status: 'pending' }) }; }
    });
    await launcher.launchCloudTask({ environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY }, deps);

    check(observed.codexBinary === 'C:/resolved/codex.exe',
      'account pinning: the transport must receive the RESOLVED executable path (bare "codex" cannot spawn with shell:false on Windows)');
    check(observed.env && observed.env.CODEX_HOME === 'home-for-first',
      'account pinning: the transport must receive the chosen account\'s CODEX_HOME, or the call silently runs as the ambient account');
    check(Array.isArray(observed.prefixArgs) && observed.prefixArgs[0] === '--flagless-prefix',
      'account pinning: the executable prefixArgs must be forwarded to the transport');
  }

  // ---------------------------------------------------------------------
  // 8. Status reads use the documented JSON list surface, and a task outside
  //    the searched window is honestly "not found", never failed.
  // ---------------------------------------------------------------------
  {
    const deps = baseDeps({
      transportFactory: () => ({
        listTasks: async () => ({
          tasks: [{ id: 'task_e_present1', status: 'ready', title: 'A task', updatedAt: '2026-08-11T06:00:00Z', url: 'https://example.invalid/t' }],
          cursor: null
        })
      })
    });
    const present = await launcher.cloudTaskStatus({ taskId: 'task_e_present1' }, deps);
    check(present.found === true, 'status read: a task present in the list must be reported found:true');
    check(present.state === 'SUCCEEDED', 'status read: provider status "ready" must map to SUCCEEDED');
    check(present.title === 'A task', 'status read: the provider-supplied title must be surfaced');

    const absent = await launcher.cloudTaskStatus({ taskId: 'task_e_missing1' }, deps);
    check(absent.found === false, 'status read: a task absent from the window must be reported found:false');
    check(absent.state === 'UNKNOWN', 'status read: an absent task must be UNKNOWN, never FAILED and never SUCCEEDED');
  }

  // ---------------------------------------------------------------------
  // 8b. A status read must be able to reach page 2. The cursor below is the
  //     shape `codex cloud list --json` really emits (captured 2026-09-03
  //     from codex-cli 0.146.1 on this machine; base64 bodies shortened,
  //     punctuation and the leading "+" verbatim). Handed back to the CLI as
  //     --cursor it returned a second page with a different task id, so the
  //     only thing that ever stopped paging was the transport refusing its
  //     own cursor -- which surfaced as 14 cloud.task_status failures reading
  //     "listTasks cursor must be a bounded opaque token when provided."
  //     against a caller who had supplied nothing but a task id.
  // ---------------------------------------------------------------------
  {
    const REAL_CURSOR = '+RID:~G4U-AJOIzhldOQcEAAjRAQ==#RT:1#TRC:1#RTD:FFMNeBmc06hP2994zep3KwV2dGZzLk1Y#ISV:2#IEO:65567#QCF:8#CID:2';
    const cursorsSeen = [];
    const deps = baseDeps({
      transportFactory: () => ({
        listTasks: async ({ cursor = null } = {}) => {
          cursorsSeen.push(cursor);
          if (cursor === null) {
            return { tasks: [{ id: 'task_e_page1aaa', status: 'ready', title: 'Newest', updatedAt: '2026-09-03T06:00:00Z', url: null }], cursor: REAL_CURSOR };
          }
          if (cursor !== REAL_CURSOR) throw new Error(`the paging loop must resend the cursor verbatim, got ${cursor}`);
          return { tasks: [{ id: 'task_e_page2bbb', status: 'in_progress', title: 'Older', updatedAt: '2026-09-02T06:00:00Z', url: null }], cursor: null };
        }
      })
    });

    const onPageTwo = await launcher.cloudTaskStatus({ taskId: 'task_e_page2bbb' }, deps);
    check(onPageTwo.found === true, 'status paging: a task on the second page must be found, not reported UNKNOWN and not raised as an error');
    check(onPageTwo.state === 'RUNNING', 'status paging: the second page task\'s provider status must be mapped, here in_progress -> RUNNING');
    check(onPageTwo.title === 'Older', 'status paging: the title must come from the page the task was actually on');
    check(cursorsSeen.length === 2 && cursorsSeen[0] === null && cursorsSeen[1] === REAL_CURSOR,
      'status paging: page 1 is fetched with no cursor and page 2 with the cursor page 1 returned');
  }

  // ---------------------------------------------------------------------
  // 8c. The same paging run through the REAL transport, so the cursor is
  //     validated by the production regex rather than a stub. Before the fix
  //     this raised CODEX_CLI_INPUT_INVALID on the second listTasks call.
  // ---------------------------------------------------------------------
  {
    const REAL_CURSOR = '+RID:~G4U-AJOIzhldOQcEAAjRAQ==#RT:1#TRC:1#RTD:FFMNeBmc06hP2994zep3KwV2dGZzLk1Y#ISV:2#IEO:65567#QCF:8#CID:2';
    const argvSeen = [];
    const pagingSpawn = (command, args) => {
      argvSeen.push([...args]);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      const second = args.includes('--cursor');
      const body = second
        ? { tasks: [{ id: 'task_e_deep2222', status: 'in_progress' }], cursor: null }
        : { tasks: [{ id: 'task_e_shallow1', status: 'ready' }], cursor: REAL_CURSOR };
      setImmediate(() => {
        child.stdout.emit('data', JSON.stringify(body));
        child.emit('close', 0);
      });
      return child;
    };
    const deps = baseDeps({
      transportFactory: () => createCodexCliTransport({ codexBinary: 'C:/resolved/codex.exe', spawnImpl: pagingSpawn })
    });

    const deep = await launcher.cloudTaskStatus({ taskId: 'task_e_deep2222' }, deps);
    check(deep.found === true, 'status paging (real transport): a task only on page 2 must still be found');
    check(deep.state === 'RUNNING', 'status paging (real transport): the found task\'s status must be mapped, not left UNKNOWN');
    check(argvSeen.length === 2, 'status paging (real transport): the loop must actually issue a second cloud list call');
    check(argvSeen[1][argvSeen[1].indexOf('--cursor') + 1] === REAL_CURSOR,
      'status paging (real transport): the provider cursor must survive validation and land in argv unchanged');
  }

  // ---------------------------------------------------------------------
  // 9. TRANSPORT: env and prefixArgs must actually reach spawn, and the
  //    environment must be passed through EXACTLY (no merge with process.env,
  //    which would reintroduce the ambient CODEX_HOME).
  // ---------------------------------------------------------------------
  {
    let spawnArgs = null;
    const fakeSpawn = (command, args, options) => {
      spawnArgs = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit('data', JSON.stringify({ tasks: [], cursor: null }));
        child.emit('close', 0);
      });
      return child;
    };
    const transport = createCodexCliTransport({
      codexBinary: 'C:/resolved/codex.exe',
      prefixArgs: ['prefix-one'],
      env: { CODEX_HOME: 'pinned-home', PATH: 'p' },
      spawnImpl: fakeSpawn
    });
    await transport.listTasks({ limit: 1 });

    check(spawnArgs.options.env && spawnArgs.options.env.CODEX_HOME === 'pinned-home',
      'transport env: the configured CODEX_HOME must be handed to spawn');
    check(Object.keys(spawnArgs.options.env).length === 2,
      'transport env: the configured environment must be passed EXACTLY, not merged over process.env');
    check(spawnArgs.args[0] === 'prefix-one' && spawnArgs.args[1] === 'cloud',
      'transport env: prefixArgs must precede the codex subcommand in argv');
    check(spawnArgs.options.shell === false, 'transport env: the child must still be spawned without a shell');
  }

  // ---------------------------------------------------------------------
  // 10. TRANSPORT: env-not-found must be classified by CONTENT even when the
  //     CLI exits NONZERO. `cloud exec` exits 1; `cloud list` exits 0; both
  //     print the same sentence. Classifying on the exit code alone hands the
  //     caller an untyped error it cannot act on.
  // ---------------------------------------------------------------------
  {
    const exitOneWithEnvError = () => {
      const child = new EventEmitter();
      child.stdin = new EventEmitter();
      child.stdin.end = () => {};
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stderr.emit('data', "Error: environment 'deadbeef' not found; run `codex cloud` to list available environments");
        child.emit('close', 1);
      });
      return child;
    };
    const transport = createCodexCliTransport({
      codexBinary: 'x', branch: 'main', buildQuery: () => 'q', spawnImpl: exitOneWithEnvError
    });
    let raised = null;
    try { await transport.createTask({ environment: 'deadbeef' }); } catch (error) { raised = error; }

    check(raised !== null, 'nonzero classification: an env-not-found exec must reject');
    check(raised.code === 'CODEX_CLI_ENV_NOT_FOUND',
      'nonzero classification: env-not-found at exit 1 must be CODEX_CLI_ENV_NOT_FOUND, not the generic CODEX_CLI_NONZERO_EXIT');
  }

  // ---------------------------------------------------------------------
  // 11. A genuinely unclassifiable nonzero exit still reports the generic
  //     code. (Guards against "classify everything" over-correction.)
  // ---------------------------------------------------------------------
  {
    const exitOneOpaque = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => { child.stderr.emit('data', 'segmentation fault'); child.emit('close', 139); });
      return child;
    };
    const transport = createCodexCliTransport({ codexBinary: 'x', spawnImpl: exitOneOpaque });
    let raised = null;
    try { await transport.listTasks({ limit: 1 }); } catch (error) { raised = error; }
    check(raised && raised.code === 'CODEX_CLI_NONZERO_EXIT',
      'nonzero classification: an unrecognized nonzero exit must still report CODEX_CLI_NONZERO_EXIT');
  }

  // ---------------------------------------------------------------------
  // 12. Provider status vocabulary.
  // ---------------------------------------------------------------------
  {
    check(mapStatus('pending') === 'SUBMITTED', 'status vocabulary: "pending" (a freshly accepted task) must map to SUBMITTED');
    check(mapStatus('ready') === 'SUCCEEDED', 'status vocabulary: "ready" must map to SUCCEEDED');
    check(mapStatus('who-knows') === 'UNKNOWN', 'status vocabulary: an unrecognized provider status must map to UNKNOWN, never to a success state');
  }

  // ---------------------------------------------------------------------
  // 13. THE REPOSITORY BINDING GATE. cloud.task_launch is a shipped surface
  //     reachable without the bridge, so it must itself refuse a launch whose
  //     declared repository is absent or does not match the binding the
  //     provider reports for that environment -- with NOTHING sent. This is
  //     the raw-tool half of the bridge's "never route work into an unrelated
  //     environment" fence.
  // ---------------------------------------------------------------------
  {
    const spawnCounter = { count: 0 };
    function bindingDeps(overrides) {
      return baseDeps(Object.assign({
        transportFactory: () => ({
          createTask: async () => { spawnCounter.count += 1; return { id: 'task_e_shouldnothappen', status: 'pending' }; }
        })
      }, overrides));
    }
    const cases = [
      // No repository at all -> refused before any provider read.
      [{ environment: ENVIRONMENT, branch: 'main', prompt: 'x' }, {},
        'CLOUD_LAUNCH_REPOSITORY_INVALID',
        'binding: a launch with NO declared repository must be refused, never run unbound'],
      // Declared repository differs from the provider's binding.
      [{ environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: 'SomeoneElse/other-repo' }, {},
        'CLOUD_LAUNCH_REPOSITORY_MISMATCH',
        'binding: a declared repository that differs from the environment binding must be refused'],
      // Environment absent from a COMPLETE reading -> authorized for no account.
      [{ environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY },
        { discoverEnvironmentsImpl: async () => stubDiscovery({ environments: [] }) },
        'CLOUD_LAUNCH_ENVIRONMENT_NOT_VISIBLE',
        'binding: an environment absent from a complete reading must be refused as not visible'],
      // Environment absent from an INCOMPLETE reading -> unverified, NOT "unauthorized".
      [{ environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY },
        { discoverEnvironmentsImpl: async () => stubDiscovery({ environments: [], complete: false }) },
        'CLOUD_LAUNCH_BINDING_UNVERIFIED',
        'binding: an environment absent from an incomplete reading must be refused as unverified, not unauthorized'],
      // Environment present but the provider reports no single repository for it.
      [{ environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY },
        { discoverEnvironmentsImpl: async () => stubDiscovery({ environments: [
          { environmentId: ENVIRONMENT, repository: null, reason: 'This environment names no readable repository.' }
        ] }) },
        'CLOUD_LAUNCH_BINDING_UNVERIFIED',
        'binding: an environment whose repository the provider does not report must be refused'],
      // The discovery read itself failed -> unverified, nothing sent.
      [{ environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY },
        { discoverEnvironmentsImpl: async () => { throw Object.assign(new Error('reader down'), { code: 'READER_DOWN' }); } },
        'CLOUD_LAUNCH_BINDING_UNVERIFIED',
        'binding: a discovery read that fails must refuse as unverified rather than proceed'],
      // The discovery read RESOLVED (did not throw) but to nothing at all. This
      // is distinct from the case above: a reader that answers with null is a
      // reader that failed just the same, and must land on the identical typed
      // refusal rather than let `discovery.complete` be read off it raw.
      [{ environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY },
        { discoverEnvironmentsImpl: async () => null },
        'CLOUD_LAUNCH_BINDING_UNVERIFIED',
        'binding: a discovery read that resolves to null must refuse as unverified, not throw a raw TypeError']
    ];
    for (const [request, overrides, expectedCode, message] of cases) {
      let raised = null;
      try { await launcher.launchCloudTask(request, bindingDeps(overrides)); } catch (error) { raised = error; }
      check(raised && raised.code === expectedCode, `${message} (got ${raised && raised.code})`);
    }
    check(spawnCounter.count === 0, 'binding: no unbound or mismatched launch may reach the transport at all');

    // An INCOMPLETE reading must name WHICH accounts could not be read and why,
    // not just announce that the reading was incomplete. 'second' answered fine
    // (reading: 'authorized') and must NOT be named -- only the account that
    // actually came back 'unknown' is unread.
    {
      let raised = null;
      try {
        await launcher.launchCloudTask(
          { environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY },
          bindingDeps({ discoverEnvironmentsImpl: async () => stubDiscovery({
            environments: [], complete: false,
            accounts: [
              { account: 'work', reading: 'unknown', reason: 'This account\'s environments could not be read (ETIMEDOUT).' },
              { account: 'second', reading: 'authorized', reason: null }
            ]
          }) })
        );
      } catch (error) { raised = error; }
      check(raised && raised.code === 'CLOUD_LAUNCH_BINDING_UNVERIFIED',
        `binding: an incomplete reading with named accounts must still refuse as unverified (got ${raised && raised.code})`);
      check(Boolean(raised) && typeof raised.message === 'string'
        && raised.message.includes('work') && raised.message.includes('ETIMEDOUT'),
        'binding: the refusal must name the unread account and its reason, not just say "incomplete"');
      check(Boolean(raised) && typeof raised.message === 'string' && !raised.message.includes('second'),
        'binding: an account that answered "authorized" must not be listed among the unread ones');
    }
    check(spawnCounter.count === 0, 'binding: the named-accounts case above must not have reached the transport either');

    // Positive control: a repository that matches the provider binding (proven
    // case-insensitively) passes the gate, reaches the transport, and the
    // receipt records the PROVIDER's repository, not merely the declaration.
    let launched = false;
    const okDeps = baseDeps({
      transportFactory: () => ({ createTask: async () => { launched = true; return { id: 'task_e_bound0001', status: 'pending' }; } })
    });
    const okResult = await launcher.launchCloudTask(
      { environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY.toUpperCase() }, okDeps);
    check(launched === true, 'binding: a repository matching the provider binding (case-insensitively) must pass the gate');
    check(okResult.ok === true && okResult.repository === REPOSITORY,
      'binding: the receipt must carry the provider-reported repository the task was bound to');
  }

  // ---------------------------------------------------------------------
  // 13. THE RETRIEVAL LEG. Before cloudTaskDiff the cloud surface was
  //     write-only: a caller could create billable remote work and read its
  //     state, and had no way to get the work itself back -- which is how a
  //     campaign of ~2,380 dispatched tasks landed zero lines. These cases pin
  //     the three ways retrieval lies if it is written carelessly: silent
  //     truncation, an empty diff read as an error, and an account-scoped
  //     invisibility reported as a missing task.
  // ---------------------------------------------------------------------
  {
    const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n';
    let observedArgs = null;
    const deps = baseDeps({
      transportFactory: () => ({
        fetchTaskDiff: async (taskId, options) => { observedArgs = { taskId, options }; return DIFF; }
      })
    });

    const got = await launcher.cloudTaskDiff({ taskId: 'task_e_diff00001' }, deps);
    check(got.diff === DIFF, 'diff read: the provider diff must be returned byte-for-byte, unparsed');
    check(got.truncated === false, 'diff read: a small diff must not be reported truncated');
    check(got.changedNothing === false, 'diff read: a non-empty diff must not report changedNothing');
    check(got.bytes === Buffer.byteLength(DIFF, 'utf8'), 'diff read: bytes must describe the WHOLE diff, not the returned slice');
    check(observedArgs.taskId === 'task_e_diff00001', 'diff read: the task id must reach the transport');
    check(observedArgs.options && observedArgs.options.attempt === undefined,
      'diff read: no attempt must be sent when the caller did not choose one, so the provider keeps its own default');

    await launcher.cloudTaskDiff({ taskId: 'task_e_diff00001', attempt: 3 }, deps);
    check(observedArgs.options.attempt === 3, 'diff read: an explicit best-of-N attempt must reach the transport');

    // A task that changed no files is a REAL and common answer -- a read-only
    // task, or one that wrote findings it never committed. Reporting it as its
    // own field is what stops a caller inferring "the fetch broke" from "".
    const emptyDeps = baseDeps({ transportFactory: () => ({ fetchTaskDiff: async () => '' }) });
    const empty = await launcher.cloudTaskDiff({ taskId: 'task_e_diff00002' }, emptyDeps);
    check(empty.changedNothing === true, 'diff read: an empty diff must be reported changedNothing:true, never as a failure');
    check(empty.bytes === 0 && empty.truncated === false, 'diff read: an empty diff is zero bytes and is not truncated');

    // Truncation must be ANNOUNCED. A half diff is the dangerous case: it can
    // apply cleanly and silently drop the rest of the task's work.
    const huge = 'x'.repeat(launcher.MAX_DIFF_BYTES + 4096);
    const hugeDeps = baseDeps({ transportFactory: () => ({ fetchTaskDiff: async () => huge }) });
    const big = await launcher.cloudTaskDiff({ taskId: 'task_e_diff00003' }, hugeDeps);
    check(big.truncated === true, 'diff read: a diff past the cap must be reported truncated:true');
    check(Buffer.byteLength(big.diff, 'utf8') <= launcher.MAX_DIFF_BYTES,
      'diff read: the returned diff must actually be capped, not merely flagged');
    check(big.bytes === Buffer.byteLength(huge, 'utf8'),
      'diff read: bytes must report the TRUE size so a caller can tell how much was withheld');

    // Account scoping is the failure that cost a whole session: a task created
    // by another account reads as absent, and a refusal that does not name the
    // serving account invites re-launching work that already exists.
    const blindDeps = baseDeps({
      transportFactory: () => ({
        fetchTaskDiff: async () => { throw transportError('CODEX_CLI_TASK_NOT_FOUND', 'task not found'); }
      })
    });
    let refusal = null;
    try { await launcher.cloudTaskDiff({ taskId: 'task_e_diff00004' }, blindDeps); }
    catch (error) { refusal = error; }
    check(refusal !== null, 'diff read: a provider failure must refuse, never resolve with an empty diff');
    check(/different account/i.test(refusal.message),
      'diff read: a refusal must say the read is account-scoped, or the caller re-launches work that already exists');
    check(/task_e_diff00004|not found/i.test(refusal.message),
      'diff read: a refusal must carry the provider\'s own reason, not replace it');
  }

  // ---------------------------------------------------------------------
  // The cloud mirror freshness gate. A launch against a mirror that is not at
  // this checkout's HEAD is the measured cause of empty applies and citations
  // pointing at unrelated code (467 commits of drift on the app repository,
  // 2026-08-24), so it must refuse BEFORE a transport exists and it must key on
  // the repository the PROVIDER reported, not the one the caller declared.
  // ---------------------------------------------------------------------
  {
    const spawnCounter = { count: 0 };
    const asked = [];
    const staleDeps = baseDeps({
      transportFactory: () => ({
        createTask: async () => { spawnCounter.count += 1; return { id: 'task_mirror_never', status: 'pending' }; }
      }),
      checkMirrorFreshnessImpl: async (request) => {
        asked.push(request);
        const error = new Error('the cloud mirror for ExampleOwner/example-repo was built from abc123456789 and this checkout is at def123456789, 467 commit(s) ahead.');
        error.code = 'CLOUD_MIRROR_STALE';
        throw error;
      }
    });
    let refusal = null;
    try {
      await launcher.launchCloudTask(
        { environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY }, staleDeps);
    } catch (error) { refusal = error; }
    check(refusal !== null, 'mirror gate: a stale mirror must refuse the launch, never fall through to a submit');
    check(refusal.code === 'CLOUD_MIRROR_STALE',
      'mirror gate: the refusal must arrive under its own name, not be reclassified as a launch error');
    check(spawnCounter.count === 0,
      'mirror gate: NOTHING may be sent when the mirror is stale -- a refusal after a createTask is a billable cloud task against an old tree');
    check(asked.length === 1 && asked[0].cloudRepository === REPOSITORY,
      'mirror gate: the check must be asked about the repository the PROVIDER bound the environment to');

    // The mutation that proves the gate is load-bearing rather than decorative:
    // with the same launch and a check that answers fresh, the submit proceeds.
    const freshDeps = baseDeps({
      transportFactory: () => ({
        createTask: async () => { spawnCounter.count += 1; return { id: 'task_mirror_ok0001', status: 'pending' }; }
      })
    });
    const allowed = await launcher.launchCloudTask(
      { environment: ENVIRONMENT, branch: 'main', prompt: 'x', repository: REPOSITORY }, freshDeps);
    check(spawnCounter.count === 1 && allowed.taskId === 'task_mirror_ok0001',
      'mirror gate: a fresh mirror must let the same launch through, or the refusal above proves nothing');
  }

  // ---------------------------------------------------------------------
  // cloud.account_list must not let two accounts that share a NAME across
  // different providers borrow each other's environment data. The registry
  // scopes name uniqueness to one provider (registry.js's own duplicate
  // check is "<provider>:<name>"), so a Claude account and a Codex account
  // are free to share a name. MEASURED live 2026-09-03: exactly that
  // happened on a real installation's own registry, and cloud.account_list
  // reported the non-Codex row as "authorized" for the Codex account's own
  // 7 environments, purely because the two rows shared a name.
  // ---------------------------------------------------------------------
  {
    const SHARED_NAME = 'shared-example';
    const collisionRegistry = Object.freeze({
      exhaustedAtPercent: 95,
      accounts: Object.freeze([
        // Listed first, matching the real incident: the non-Codex row sorts
        // ahead of the Codex row that happens to share its name.
        Object.freeze({ name: SHARED_NAME, role: null, provider: 'claude', configDir: '.claude-shared', priority: 1 }),
        Object.freeze({ name: SHARED_NAME, role: null, provider: 'codex', profileDir: '.codex-shared', priority: 2 })
      ])
    });
    const ENV_ID = 'b'.repeat(32);
    const deps = baseDeps({
      loadRegistryImpl: () => collisionRegistry,
      probeImpl: async (account) => Object.freeze({
        account: account.name, email: null,
        usedPercent: account.provider === 'codex' ? 40 : null,
        resetsAt: null, planType: null,
        status: account.provider === 'codex' ? 'healthy' : 'not_provisioned',
        canServe: account.provider === 'codex',
        reason: account.provider === 'codex'
          ? `"${account.name}" can serve.`
          : `"${account.name}" is a ${account.provider} account. The Codex account surface cannot check it, so it was skipped here.`
      }),
      discoverEnvironmentsImpl: async () => ({
        environments: [{
          environmentId: ENV_ID, label: 'Shared example', repository: REPOSITORY,
          repositories: [REPOSITORY], defaultBranch: 'main', visibility: 'private',
          launchable: true, reason: null, accounts: [SHARED_NAME]
        }],
        // Two READING rows sharing one account NAME -- one per provider --
        // exactly the shape discoverCloudEnvironments() produces once its own
        // per-account rows carry `provider`.
        accounts: [
          { account: SHARED_NAME, provider: 'claude', reading: 'signed-out',
            reason: 'This account has no signed-in Codex home, so it can list no environments.', count: 0 },
          { account: SHARED_NAME, provider: 'codex', reading: 'authorized', reason: null, count: 1 }
        ],
        complete: true,
        readAt: '2026-09-03T00:00:00.000Z'
      })
    });

    const result = await launcher.listCloudAccounts({}, deps);
    check(result.accounts.length === 2, 'account collision: both registry rows must be reported');
    const claudeRow = result.accounts.find(a => a.reason && a.reason.includes('claude account'));
    const codexRow = result.accounts.find(a => a.status === 'healthy');
    check(Boolean(claudeRow) && Boolean(codexRow),
      'account collision: both a skipped non-Codex row and a healthy Codex row must be present');
    check(claudeRow.environmentsReading === 'signed-out',
      `account collision: the non-Codex row must report its OWN reading (signed-out), not borrow the Codex row's (got "${claudeRow.environmentsReading}")`);
    check(claudeRow.environments.length === 0,
      `account collision: the non-Codex row must list no environments -- it cannot see any Codex Cloud environment (got ${claudeRow.environments.length})`);
    check(codexRow.environmentsReading === 'authorized',
      'account collision: the real Codex row must still report its own authorized reading');
    check(codexRow.environments.length === 1 && codexRow.environments[0] === ENV_ID,
      'account collision: the real Codex row must still list the environment it is actually authorized for');
  }

  // ---------------------------------------------------------------------
  // 15. A DECLARED READ MUST NOT ADOPT AN ACCOUNT. cloud.task_status,
  //     cloud.task_diff and cloud.task_list are all registered in
  //     tool-registry.js as `effect: 'external-read', readOnlyHint: true` --
  //     a caller and any approval policy are both told these three do
  //     nothing but look. MEASURED 2026-09-03 against this file pre-fix:
  //     all three called chooseAccount() without launchCloudTask's own
  //     `persistSelection: false` (present two sections above, on its
  //     per-attempt preflight selection), so every read committed a real
  //     write through resolveForLaunch() -> commitLaunchSelection() --
  //     appending an unbounded `history` entry on every call, and flipping
  //     `activeAccount` whenever the account it happened to probe differed
  //     from the one already active. Fixed by passing the same
  //     `persistSelection: false` all three read paths already had the
  //     account-selection MACHINERY for, just not the guard against
  //     adopting its answer.
  // ---------------------------------------------------------------------
  {
    // 15a. cloud.task_status: a plain read leaves account preference and
    // profile pin byte-identical, exactly the guarantee section 2 and 3
    // above already require of a REFUSED or UNKNOWN launch.
    const statusDeps = baseDeps({
      transportFactory: () => ({
        listTasks: async () => ({ tasks: [{ id: 'task_e_ro0status', status: 'ready', title: 'RO', updatedAt: null, url: null }], cursor: null })
      })
    });
    const statusBefore = seedPreference(statusDeps, 'second');
    const statusResult = await launcher.cloudTaskStatus({ taskId: 'task_e_ro0status' }, statusDeps);
    check(statusResult.found === true, 'read-only status: the read must still succeed and find the task');
    check(fs.readFileSync(statusDeps.statePath, 'utf8') === statusBefore.state
      && fs.readFileSync(statusDeps.codexConfigPath, 'utf8') === statusBefore.pin,
    'read-only status: cloud.task_status must leave account preference and profile pin byte-identical -- a status check is not a switch');

    // 15b. cloud.task_diff: same guarantee on the retrieval leg.
    const diffDeps = baseDeps({
      transportFactory: () => ({ fetchTaskDiff: async () => 'diff --git a/x b/x\n' })
    });
    const diffBefore = seedPreference(diffDeps, 'second');
    await launcher.cloudTaskDiff({ taskId: 'task_e_ro00diff' }, diffDeps);
    check(fs.readFileSync(diffDeps.statePath, 'utf8') === diffBefore.state
      && fs.readFileSync(diffDeps.codexConfigPath, 'utf8') === diffBefore.pin,
    'read-only diff: cloud.task_diff must leave account preference and profile pin byte-identical -- fetching a diff is not a switch');

    // 15c. cloud.task_list: same guarantee, PLUS this call had zero prior
    // behavioural coverage anywhere in this codebase before this section --
    // grep found it named only in a tool-registry naming list and a
    // capability-recall fixture, never exercised. It gets both a normal
    // functional check and the persistence guarantee here.
    const listDeps = baseDeps({
      transportFactory: () => ({
        listTasks: async () => ({
          tasks: [{ id: 'task_e_ro00list', status: 'in_progress', title: 'Listed', updatedAt: '2026-09-03T00:00:00Z', environmentLabel: 'Example', url: 'https://example.invalid/l' }],
          cursor: null
        })
      })
    });
    const listBefore = seedPreference(listDeps, 'second');
    const listResult = await launcher.listCloudTasks({}, listDeps);
    check(Array.isArray(listResult.tasks) && listResult.tasks.length === 1,
      'task list: the provider-listed task must be reported');
    check(listResult.tasks[0].taskId === 'task_e_ro00list' && listResult.tasks[0].state === 'RUNNING'
      && listResult.tasks[0].title === 'Listed' && listResult.tasks[0].environmentLabel === 'Example',
    'task list: id, mapped state, title and environment label must all survive from the provider row to the report');
    check(fs.readFileSync(listDeps.statePath, 'utf8') === listBefore.state
      && fs.readFileSync(listDeps.codexConfigPath, 'utf8') === listBefore.pin,
    'read-only list: cloud.task_list must leave account preference and profile pin byte-identical -- listing is not a switch');

    // 15d. THE CROSS-TOOL CONSEQUENCE, entirely inside this domain: before the
    // fix, ONE cloud.task_status read with an explicit `account` steered a
    // LATER, unspecified cloud.task_list call onto that same account, because
    // resolveForLaunch()'s own bias (`preferred || activeFor(state, provider)`)
    // read back exactly what the status read had just committed. A caller
    // that never named an account could not see or predict that choice.
    const crossDeps = baseDeps({
      transportFactory: () => ({ listTasks: async () => ({ tasks: [], cursor: null }) })
    });
    seedPreference(crossDeps, 'first'); // registry priority 1, the untouched default
    await launcher.cloudTaskStatus({ taskId: 'task_e_crossxxx', account: 'third' }, crossDeps);
    const unspecified = await launcher.listCloudTasks({}, crossDeps); // no `account` passed
    check(unspecified.account.name === 'first',
      `cross-tool: an explicit-account status read must not steer a later unspecified list call (served by "${unspecified.account.name}", expected the untouched default "first")`);
  }

  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`codex-cloud-launch tests passed (${checks} checks: account-scoped environment failover, invisible-environment refusal, no-retry on ambiguous submit, unconfirmed-submit honesty, argv input hardening, natural-language prompts, account CODEX_HOME pinning with resolved executable, list-surface status reads, exact env passthrough to spawn, content-based nonzero classification, provider status vocabulary, the repository binding gate that refuses an unbound or mismatched launch before anything is sent, the cloud-mirror freshness gate that refuses a stale mirror before any transport exists and lets the same launch through when it is fresh, and the retrieval leg -- byte-for-byte diff passthrough, announced truncation, an empty diff reported as changedNothing rather than as a failure, and an account-scoped refusal that says so, and cloud.account_list keeping two same-named accounts on different providers from borrowing each other's environment data, and cloud.task_status/cloud.task_diff/cloud.task_list -- all three declared read-only -- never adopting the account they read as the account everything else now runs as).`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
