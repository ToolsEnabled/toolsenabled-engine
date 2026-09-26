'use strict';

// The one function in the batch lane that spends money.
//
// EVERY TEST HERE IS ABOUT WHICH OF THREE ANSWERS IT GIVES, because that choice
// is the safety property of the whole lane:
//
//   { taskId }                     accepted; the id is the only handle anyone
//                                  will ever have on it.
//   throw providerAnswered=true    the provider ANSWERED and declined. Certain.
//   throw without that field       we could not tell. The task may be running
//                                  right now and billing.
//
// The third is the one that costs money to get wrong, in both directions: call
// an uncertain dispatch "refused" and a resume never reconciles a task that is
// running; call a certain refusal "uncertain" and somebody reconciles for
// nothing. So the bias is deliberate and asserted -- anything the provider did
// not clearly decline is uncertain.
//
// spawnImpl is injected. Nothing here creates a real cloud task, which cannot
// be cancelled once created.

const assert = require('node:assert');

const dispatcher = require('../src/lib/cloud-agent/codex-dispatcher');

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

async function raises(code, action, message) {
  let error = null;
  try { await action(); } catch (raised) { error = raised; }
  check(error !== null, `${message} (nothing was thrown)`);
  check(error && error.code === code, `${message} (expected ${code}, got ${error && error.code}: ${error && error.message})`);
  return error;
}

/* The REAL entry point, not the npm shim. A shell-less spawn cannot run a
   .cmd -- it fails EINVAL, which at dispatch time is indistinguishable from a
   provider that never answered, and a live two-task proof came back with both
   unresolved because of exactly that. The dispatcher now refuses a shim by
   name, so the fixture has to be the thing a caller should really pass. */
const CODEX_ENTRY = 'C:/npm/node_modules/@openai/codex/bin/codex.js';

const HOMES = { 'cloud-a': 'C:/homes/a', 'cloud-b': 'C:/homes/b' };
const ENVIRONMENTS = { 'cloud-a': 'env-aaa', 'cloud-b': 'env-bbb' };
const TASK = { target: 'src/x.js', contract: 'CONTRACT/1\nrole IMPLEMENTER\ntarget src/x.js' };

// A stand-in for the shared scrubber. Records that it was called, because the
// codex child inheriting this process's credentials is a leak this repository
// has already had once.
function scrubber(seen) {
  return (source, options) => { seen.push(options && options.context); return { PATH: 'p' }; };
}

function make(spawnImpl, extra = {}) {
  return dispatcher.createCodexDispatcher({
    codexBinary: CODEX_ENTRY,
    accountHomes: HOMES,
    accountEnvironments: ENVIRONMENTS,
    scrubEnvironment: scrubber(extra.seen || []),
    spawnImpl,
    ...extra.options
  });
}

(async () => {
  // -------------------------------------------------------------------
  // CONSTRUCTION-TIME REFUSALS ARE DRIVEN THROUGH THE PUBLIC FACTORY.
  // None may scrub an environment or spawn a process: invalid transport
  // configuration is rejected before a dispatch function even exists.
  // -------------------------------------------------------------------
  {
    for (const fixture of [
      {
        code: 'CLOUD_DISPATCH_NO_BINARY',
        label: 'a missing CLI path',
        options: { codexBinary: '' }
      },
      {
        code: 'CLOUD_DISPATCH_SHIM_NOT_EXECUTABLE',
        label: 'an npm Windows shim',
        options: { codexBinary: 'C:/npm/codex.cmd' }
      },
      {
        code: 'CLOUD_DISPATCH_NO_HOMES',
        label: 'a missing account-to-home declaration',
        options: { accountHomes: null }
      },
      {
        code: 'CLOUD_DISPATCH_NO_ENVIRONMENTS',
        label: 'a missing account-to-environment declaration',
        options: { accountEnvironments: null }
      }
    ]) {
      let spawnCalls = 0;
      let scrubCalls = 0;
      const options = {
        codexBinary: CODEX_ENTRY,
        accountHomes: HOMES,
        accountEnvironments: ENVIRONMENTS,
        spawnImpl: () => { spawnCalls += 1; return { status: 0, stdout: 'task_should_not_exist', stderr: '' }; },
        scrubEnvironment: () => { scrubCalls += 1; return {}; },
        ...fixture.options
      };
      const error = await raises(fixture.code,
        () => dispatcher.createCodexDispatcher(options),
        `${fixture.label} is rejected by the public dispatcher factory`);
      check(error.providerAnswered !== true,
        `${fixture.label} is a local construction refusal, not a claim that the provider answered`);
      check(spawnCalls === 0 && scrubCalls === 0,
        `${fixture.label} refuses before anything is scrubbed, written, or spawned`);
    }
  }

  // -------------------------------------------------------------------
  // THE HOME IS PINNED PER ACCOUNT. Measured consequence of getting this
  // wrong: a wave created by cloud-b answers 404 to every diff run under the
  // default home, and a harvest reads that as "no work" and re-dispatches
  // twenty tasks that all had work.
  // -------------------------------------------------------------------
  {
    const calls = [];
    const dispatch = make((binary, args, options) => {
      calls.push({ binary, args, home: options.env.CODEX_HOME });
      return { status: 0, stdout: 'https://chatgpt.com/codex/tasks/task_abc123\n', stderr: '' };
    });
    const a = await dispatch({ task: TASK, index: 0, account: 'cloud-a' });
    const b = await dispatch({ task: TASK, index: 1, account: 'cloud-b' });
    check(a.taskId === 'task_abc123', 'the task id is read from the URL the CLI prints');
    check(b.taskId === 'task_abc123', 'the same for the second account');
    check(calls[0].home === 'C:/homes/a' && calls[1].home === 'C:/homes/b',
      'CODEX_HOME is pinned to the dispatching account, never left to the CLI default');
    check(calls[0].args.includes('env-aaa') && calls[1].args.includes('env-bbb'),
      'each account dispatches into the environment IT is authorized for');
    /* A .js ENTRY POINT RUNS UNDER THIS PROCESS'S OWN NODE, so the script is
       argv[0] and the CLI's own verbs follow it. Asserted as "the verbs are
       present, in order, as separate array elements" rather than at fixed
       positions -- the position depends on how the entry point is reached, and
       pinning it would fail against a native binary that needs no prefix.
       What must never change is that every argument is its own element: on
       Windows a path-bearing shell string keeps its quotes and gives ENOENT,
       and a prompt full of newlines and quotes would not survive at all. */
    check(calls[0].args[0] === CODEX_ENTRY,
      'a .js entry point is passed to node as the script, not executed directly');
    const verbs = calls[0].args.slice(1, 3);
    check(verbs[0] === 'cloud' && verbs[1] === 'exec',
      'the CLI verbs follow the script, each its own array element');
    check(calls[0].args.some((argument) => argument.includes('CONTRACT/1')),
      'the whole brief travels as ONE array element -- newlines and all -- rather than being flattened into a command string');
  }

  // -------------------------------------------------------------------
  // AN OVERSIZED PROMPT REFUSES BEFORE SPAWN. The scrubber returns a fresh
  // object, so checking that object as well as the spawn counter proves the
  // refusal did not hand anything to the process boundary.
  // -------------------------------------------------------------------
  {
    let spawnCalls = 0;
    const launchEnvironment = { PATH: 'p' };
    const dispatch = dispatcher.createCodexDispatcher({
      codexBinary: CODEX_ENTRY,
      accountHomes: HOMES,
      accountEnvironments: ENVIRONMENTS,
      scrubEnvironment: () => launchEnvironment,
      spawnImpl: () => { spawnCalls += 1; return { status: 0, stdout: 'task_should_not_exist', stderr: '' }; }
    });
    const tooLong = { ...TASK, contract: 'x'.repeat(dispatcher.WINDOWS_COMMAND_LINE_LIMIT + 1) };
    const error = await raises('CLOUD_DISPATCH_PROMPT_TOO_LONG',
      () => dispatch({ task: tooLong, index: 9, account: 'cloud-a' }),
      'a command line beyond the platform ceiling is refused by a real dispatch call');
    check(error.providerAnswered === true,
      'the oversized-prompt refusal is certain because no process reached the provider');
    check(spawnCalls === 0,
      'the oversized-prompt refusal never invokes the injected process boundary');
    check(launchEnvironment.CODEX_HOME === HOMES['cloud-a'] && Object.keys(launchEnvironment).length === 2,
      'the refusal performs only the documented CODEX_HOME preparation and writes no prompt or task payload');
  }

  // -------------------------------------------------------------------
  // An account with no declared home or environment REFUSES rather than
  // falling back. A fallback here runs real work against the wrong source.
  // -------------------------------------------------------------------
  {
    const dispatch = make(() => ({ status: 0, stdout: 'task_x', stderr: '' }));
    await raises('CLOUD_DISPATCH_ACCOUNT_HOME_UNKNOWN',
      () => dispatch({ task: TASK, index: 0, account: 'cloud-nowhere' }),
      'an account with no declared home refuses');
    const noEnv = dispatcher.createCodexDispatcher({
      codexBinary: CODEX_ENTRY, accountHomes: HOMES, accountEnvironments: { 'cloud-a': '' },
      scrubEnvironment: scrubber([]), spawnImpl: () => ({ status: 0, stdout: '', stderr: '' })
    });
    await raises('CLOUD_DISPATCH_ACCOUNT_ENVIRONMENT_UNKNOWN',
      () => noEnv({ task: TASK, index: 0, account: 'cloud-a' }),
      'an account with no declared environment refuses rather than borrowing another');
  }

  // -------------------------------------------------------------------
  // THE SCRUBBER IS REQUIRED, NOT DEFAULTED. A caller cannot forget it.
  // -------------------------------------------------------------------
  {
    let threw = null;
    try {
      dispatcher.createCodexDispatcher({ codexBinary: CODEX_ENTRY, accountHomes: HOMES, accountEnvironments: ENVIRONMENTS });
    } catch (error) { threw = error; }
    check(threw && threw.code === 'CLOUD_DISPATCH_NO_SCRUB',
      'building a dispatcher without a scrubber refuses -- the codex child would inherit this process\'s provider credentials');
    const seen = [];
    const dispatch = make(() => ({ status: 0, stdout: 'created task_e_6a8cb843d21f', stderr: '' }), { seen });
    await dispatch({ task: TASK, index: 0, account: 'cloud-a' });
    check(seen.length === 1 && /codex cloud dispatch/.test(String(seen[0])),
      'the scrubber is actually called, with a context naming this call site');
  }

  // -------------------------------------------------------------------
  // THE THREE ANSWERS. This block is the file's reason for existing.
  // -------------------------------------------------------------------
  {
    // Certain refusal: the provider answered and declined.
    for (const [text, why] of [
      ['error: not authorized for this environment', 'an authorization refusal'],
      ['quota exceeded for this account', 'a quota refusal'],
      ['unknown environment env-aaa', 'an unknown environment'],
      ['you are not logged in', 'a sign-in refusal'],
    ]) {
      const dispatch = make(() => ({ status: 1, stdout: '', stderr: text }));
      const error = await raises('CLOUD_DISPATCH_REFUSED',
        () => dispatch({ task: TASK, index: 0, account: 'cloud-a' }),
        `${why} is recognised as the provider ANSWERING`);
      check(error.providerAnswered === true,
        `${why} is marked providerAnswered, so the runner records it as refused rather than leaving it to be reconciled`);
    }

    // UNCERTAIN: a non-zero exit that matches no known refusal. The default,
    // and deliberately so.
    const dispatch = make(() => ({ status: 7, stdout: '', stderr: 'connection reset by peer' }));
    const error = await raises('CLOUD_DISPATCH_UNCERTAIN',
      () => dispatch({ task: TASK, index: 0, account: 'cloud-a' }),
      'a transport failure is UNCERTAIN, never a refusal');
    check(error.providerAnswered !== true,
      'the uncertain case carries NO providerAnswered flag, which is what makes the runner leave the intent outcome-less');
    check(/unknown/.test(error.message),
      'the uncertain refusal says the outcome is unknown rather than implying the task never ran');

    // A timeout is the worst case and is also uncertain.
    const timedOut = make(() => ({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }));
    const timeoutError = await raises('CLOUD_DISPATCH_UNCERTAIN',
      () => timedOut({ task: TASK, index: 0, account: 'cloud-a' }),
      'a timeout is uncertain -- the request may have arrived and we simply stopped listening');
    check(timeoutError.providerAnswered !== true, 'a timeout is never marked as answered');

    // An absent binary IS certain: nothing was sent.
    const missing = make(() => ({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }));
    const absent = await raises('CLOUD_DISPATCH_CLI_ABSENT',
      () => missing({ task: TASK, index: 0, account: 'cloud-a' }),
      'an absent CLI is certain -- nothing was sent, so no task can be running');
    check(absent.providerAnswered === true,
      'the absent-binary case IS marked answered, sparing a pointless reconciliation');
  }

  // -------------------------------------------------------------------
  // A FAILED EXIT THAT STILL PRINTED AN ID MEANS THE TASK EXISTS.
  //
  // Refusing here would strand a real, billing task that nothing can address.
  // -------------------------------------------------------------------
  {
    const dispatch = make(() => ({
      status: 1,
      stdout: 'https://chatgpt.com/codex/tasks/task_created_anyway\n',
      stderr: 'warning: something went wrong afterwards'
    }));
    const result = await dispatch({ task: TASK, index: 0, account: 'cloud-a' });
    check(result.taskId === 'task_created_anyway',
      'a non-zero exit that still printed an id returns that id -- the task exists, and stranding it would leave a billing task nobody can name');
  }

  // -------------------------------------------------------------------
  // SUCCESS WITH NO READABLE ID IS UNKNOWN, NOT LAUNCHED.
  // -------------------------------------------------------------------
  {
    const dispatch = make(() => ({ status: 0, stdout: 'done.\n', stderr: '' }));
    const error = await raises('CLOUD_DISPATCH_ID_UNREADABLE',
      () => dispatch({ task: TASK, index: 0, account: 'cloud-a' }),
      'exit 0 with no readable id is unknown -- inventing an id would be worse than admitting we cannot name what was created');
    check(error.providerAnswered !== true,
      'and it is not marked answered, because the provider plainly did accept something');
  }

  // -------------------------------------------------------------------
  // A declaration edited after admission cannot smuggle an empty prompt past.
  // -------------------------------------------------------------------
  {
    const dispatch = make(() => ({ status: 0, stdout: 'created task_e_6a8cb843d21f', stderr: '' }));
    await raises('CLOUD_DISPATCH_NO_PROMPT',
      () => dispatch({ task: { target: 'src/x.js' }, index: 4, account: 'cloud-a' }),
      'a task with no contract text refuses -- admission validates every brief, so reaching here means the declaration changed after admission');
  }

  // -------------------------------------------------------------------
  // The id reader handles both shapes the CLI emits.
  // -------------------------------------------------------------------
  {
    check(dispatcher.extractTaskId('see https://chatgpt.com/codex/tasks/task_url_form', '') === 'task_url_form',
      'the id is read from the task URL');
    check(dispatcher.extractTaskId('', 'created task_bare_form_1234') === 'task_bare_form_1234',
      'and from a bare id in stderr, because the CLI has emitted both');
    check(dispatcher.extractTaskId('nothing here', '') === null,
      'and returns null rather than a guess when neither shape is present');
  }

  console.log(`codex-dispatcher tests passed (${checks} checks: CODEX_HOME pinned per account and the environment taken from the account that is authorized for it, arguments passed as an array, an undeclared account refusing rather than falling back, the credential scrubber required rather than defaulted, and above all the three answers kept apart -- a provider that ANSWERED marked certain, a transport failure or timeout left UNCERTAIN so a resume reconciles it, an absent binary certain because nothing was sent, a failed exit that still printed an id returning that id rather than stranding a billing task, and exit 0 with no readable id held as unknown rather than invented).`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
