'use strict';

// THE WINDOWS COMMAND-LINE CEILING, MEASURED THE WAY WINDOWS MEASURES IT.
//
// The prompt rides in argv. On Windows argv is not a vector: libuv folds it
// into ONE string for CreateProcessW, and folding it QUOTES and ESCAPES. A
// brief full of double quotes therefore costs far more command line than it
// costs characters -- each `"` becomes `\"`, and each backslash in a run that
// touches a quote is doubled.
//
// The old check added a flat three characters per argument and never looked
// inside one. So a quote-heavy brief measured well under the cap, passed, and
// then CreateProcess refused it -- and the dispatcher recorded that refusal as
// UNCERTAIN, sending somebody to reconcile a task that had never been sent.
// Both halves are asserted here: the measurement, and the honesty of the
// answer when a command line is rejected anyway.
//
// Nothing here spawns anything. spawnImpl is injected and counts its calls,
// because the point of the pre-spawn check is that the spawn never happens.

const assert = require('node:assert');

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const dispatcher = require('../src/lib/cloud-agent/codex-dispatcher');
const windowsJob = require('../src/lib/windows-job-control');

let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks += 1; }

async function raises(code, action, message) {
  let error = null;
  try { await action(); } catch (raised) { error = raised; }
  check(error !== null, `${message} (nothing was thrown)`);
  check(error && error.code === code, `${message} (expected ${code}, got ${error && error.code}: ${error && error.message})`);
  return error;
}

const CODEX_ENTRY = '\x43:/npm/node_modules/@openai/codex/bin/codex.js';
const ACCOUNT_HOME = '\x43:/homes/a';
const ENVIRONMENT = 'env-aaa';

function scrubber() { return () => ({ PATH: 'p' }); }

function make(spawnImpl, options = {}) {
  return dispatcher.createCodexDispatcher({
    codexBinary: CODEX_ENTRY,
    accountHome: ACCOUNT_HOME,
    environment: ENVIRONMENT,
    scrubEnvironment: scrubber(),
    spawnImpl,
    ...options
  });
}

function counting(result) {
  const calls = [];
  const spawnImpl = (command, argv) => { calls.push({ command, argv }); return result; };
  return { calls, spawnImpl };
}

(async () => {
  // -------------------------------------------------------------------
  // THE MEASUREMENT ITSELF, against libuv's own worked examples.
  //
  // These are the input/output pairs written in uv/src/win/process.c's
  // quote_cmd_arg, which is the function that builds the string Windows
  // actually receives. If this table ever stops matching, the dispatcher's
  // ceiling has stopped meaning anything.
  // -------------------------------------------------------------------
  {
    const quoted = dispatcher.windowsQuotedArgumentLength;
    check(typeof quoted === 'function',
      'the quoting cost of a single argument is measurable on its own -- the whole defect was a measurement that never looked inside an argument');

    // An argument with no space, tab or quote is passed through untouched;
    // backslashes alone cost nothing.
    check(quoted('plain') === 'plain'.length,
      'an argument needing no quoting costs exactly its own characters');
    check(quoted('back\\slash') === 'back\\slash'.length,
      'backslashes with nothing to escape against are not doubled -- the argument is not quoted at all');
    check(quoted('') === 2,
      'an empty argument still costs the two quotes that make it visible as an argument');
    check(quoted('has space') === 'has space'.length + 2,
      'a space forces surrounding quotes and nothing more, when there is no quote or backslash inside');

    // libuv's documented expansions. Each right-hand side is the string
    // Windows receives; the number is its length.
    const table = [
      ['hello"world', '"hello\\"world"'],
      ['hello""world', '"hello\\"\\"world"'],
      ['hello\\"world', '"hello\\\\\\"world"'],
      ['hello\\\\"world', '"hello\\\\\\\\\\"world"'],
      ['hello world\\', '"hello world\\\\"'],
    ];
    for (const [input, expanded] of table) {
      check(quoted(input) === expanded.length,
        `${JSON.stringify(input)} costs ${expanded.length} command-line units (${JSON.stringify(expanded)}), not ${quoted(input)}`);
    }
  }

  // -------------------------------------------------------------------
  // THE COUNTER AGAINST AN INDEPENDENT BUILDER.
  //
  // The dispatcher COUNTS the expansion without building it, so that measuring
  // a 30,000-character brief does not cost a second copy of it. A counter is
  // easy to get subtly wrong, so it is checked here against a reference that
  // actually BUILDS the string, written the other way round: the conventional
  // forward CommandLineToArgvW-compatible algorithm, not libuv's backward
  // walk. Two independent derivations agreeing on 400 adversarial inputs is
  // the evidence; one clever loop agreeing with itself is not.
  //
  // The generator is seeded, so a failure here is reproducible.
  // -------------------------------------------------------------------
  {
    const quoted = dispatcher.windowsQuotedArgumentLength;

    function reference(text) {
      if (text.length === 0) return '""';
      if (!/[ \t"]/.test(text)) return text;
      let out = '"';
      let index = 0;
      while (index < text.length) {
        let slashes = 0;
        while (index < text.length && text[index] === '\\') { slashes += 1; index += 1; }
        if (index === text.length) { out += '\\'.repeat(slashes * 2); break; }
        if (text[index] === '"') { out += `${'\\'.repeat(slashes * 2 + 1)}"`; index += 1; }
        else { out += '\\'.repeat(slashes) + text[index]; index += 1; }
      }
      return `${out}"`;
    }

    // Deliberately adversarial alphabet: quotes, backslashes, spaces and tabs
    // in every adjacency, which is where the doubling rule lives.
    const alphabet = ['"', '\\', ' ', '\t', 'a', 'Z', '{', '}'];
    let seed = 0x5f37_59df;
    const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fff_ffff; return seed; };
    let mismatch = null;
    for (let case_ = 0; case_ < 400 && mismatch === null; case_ += 1) {
      const length = next() % 24;
      let text = '';
      for (let i = 0; i < length; i += 1) text += alphabet[next() % alphabet.length];
      const built = reference(text);
      if (quoted(text) !== built.length) mismatch = { text, built, counted: quoted(text) };
    }
    check(mismatch === null,
      mismatch
        ? `the counter disagrees with a built expansion for ${JSON.stringify(mismatch.text)}: counted ${mismatch.counted}, built ${JSON.stringify(mismatch.built)} (${mismatch.built.length})`
        : 'the counter agrees with an independently built expansion across 400 adversarial inputs');
    // And the reference agrees with libuv's own table, so it is not two wrongs.
    check(reference('hello\\\\"world') === '"hello\\\\\\\\\\"world"',
      'the reference builder itself reproduces libuv\'s worked example, so the agreement above is not two derivations sharing one mistake');
  }

  // -------------------------------------------------------------------
  // THE WHOLE COMMAND LINE: quoted arguments, one space between each, and
  // the terminating NUL, which the 32,767 cap counts.
  // -------------------------------------------------------------------
  {
    const length = dispatcher.windowsCommandLineLength;
    check(typeof length === 'function', 'the command line is measured as a whole, not summed with a flat per-argument guess');
    check(length('node', ['a', 'b']) === 4 + 1 + 1 + 1 + 1 + 1,
      'three unquoted arguments cost their characters, two separators and the NUL');
    check(length('node', ['say "hi"']) === 4 + 1 + '"say \\"hi\\""'.length + 1,
      'a quoted argument costs its ESCAPED length, which is the number the old check could not see');
    check(dispatcher.WINDOWS_COMMAND_LINE_LIMIT === 32_767,
      'the cap is CreateProcessW\'s 32,767 UTF-16 units, terminating NUL included');
  }

  // -------------------------------------------------------------------
  // THE DEFECT, END TO END. A quote-heavy brief whose plain character count
  // sits far under the cap but whose COMMAND LINE does not.
  //
  // 11,000 quotes inside a 22,000-character brief. Characters: ~22,300 with
  // the binary and fixed arguments -- comfortably "fine" to the old check.
  // Command line: ~33,300 -- refused by CreateProcess, every time.
  // -------------------------------------------------------------------
  {
    const quoteHeavy = 'x"'.repeat(11_000);
    check(quoteHeavy.length === 22_000, 'the fixture brief is 22,000 characters');

    const { calls, spawnImpl } = counting({ status: 0, stdout: 'task_should_never_happen_1234', stderr: '' });
    const dispatch = make(spawnImpl);
    const error = await raises('CLOUD_DISPATCH_PROMPT_TOO_LONG',
      () => dispatch({ task: { contract: quoteHeavy }, index: 7, account: 'cloud-a' }),
      'a quote-heavy brief is refused on its COMMAND-LINE length, not on its character count');
    check(error.providerAnswered === true,
      'and the refusal is CERTAIN: the check runs before the spawn, so nothing can be running');
    check(calls.length === 0,
      'and the spawn never happened -- a check that refuses after spawning is not a check');
    check(/[Nn]othing was sent/.test(error.message),
      'and the message says plainly that nothing was sent, so nobody reconciles it');
    check(/3[0-9],?[0-9]{3}/.test(error.message.replace(/,/g, '')) || /\b3[0-9]{4}\b/.test(error.message),
      `and it reports the real command-line length, not the character count: ${error.message}`);
    check(error.message.includes('22000') || error.message.includes('22,000'),
      'and it still reports the brief\'s own size, which is the number the author can act on');
  }

  // -------------------------------------------------------------------
  // NO FALSE REFUSALS. The same 22,000 characters without quotes fit, and
  // must still dispatch. A ceiling that refuses everything is not a fix.
  // -------------------------------------------------------------------
  {
    const plain = 'x'.repeat(22_000);
    const { calls, spawnImpl } = counting({ status: 0, stdout: 'https://chatgpt.com/codex/tasks/task_plain_ok_0001', stderr: '' });
    const dispatch = make(spawnImpl);
    const result = await dispatch({ task: { contract: plain }, index: 8, account: 'cloud-a' });
    check(result.taskId === 'task_plain_ok_0001',
      'a brief of the same length with nothing to escape still dispatches');
    check(calls.length === 1 && calls[0].argv[calls[0].argv.length - 1] === plain,
      'and the prompt travelled as its own argv element, unquoted and unmangled');
  }

  // -------------------------------------------------------------------
  // A brief that is simply too long is still refused, certainly.
  // -------------------------------------------------------------------
  {
    const huge = 'x'.repeat(40_000);
    const { calls, spawnImpl } = counting({ status: 0, stdout: 'task_never_1234', stderr: '' });
    const dispatch = make(spawnImpl);
    const error = await raises('CLOUD_DISPATCH_PROMPT_TOO_LONG',
      () => dispatch({ task: { contract: huge }, index: 9, account: 'cloud-a' }),
      'an oversized plain brief is still refused');
    check(error.providerAnswered === true && calls.length === 0,
      'certainly, and without spawning');
  }

  // -------------------------------------------------------------------
  // THE HONEST FAILURE PATH. If a command line is rejected by the OS anyway
  // -- a measurement this dispatcher got wrong, a limit that moved -- the
  // answer is CERTAIN, not uncertain: CreateProcess refuses before it starts
  // anything, so no request left this machine.
  // -------------------------------------------------------------------
  {
    for (const code of ['ENAMETOOLONG', 'E2BIG']) {
      const dispatch = make(() => ({
        error: Object.assign(new Error('spawn failed'), { code }),
        status: null, stdout: '', stderr: ''
      }));
      const error = await raises('CLOUD_DISPATCH_COMMAND_LINE_REJECTED',
        () => dispatch({ task: { contract: 'brief' }, index: 10, account: 'cloud-a' }),
        `${code} means the command line was refused before the process existed`);
      check(error.providerAnswered === true,
        `and ${code} is recorded as CERTAIN -- nothing was sent, so nobody is owed a reconciliation`);
      check(/[Nn]othing was sent/.test(error.message),
        `and ${code} says so in as many words`);
    }
  }

  // -------------------------------------------------------------------
  // AND NOT ONE STEP FURTHER. EINVAL is exactly what an npm .cmd shim gives,
  // and this file's own history says that is indistinguishable at dispatch
  // time from a provider that never answered. It stays uncertain.
  // -------------------------------------------------------------------
  {
    const dispatch = make(() => ({
      error: Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }),
      status: null, stdout: '', stderr: ''
    }));
    const error = await raises('CLOUD_DISPATCH_UNCERTAIN',
      () => dispatch({ task: { contract: 'brief' }, index: 11, account: 'cloud-a' }),
      'EINVAL is NOT promoted to certain -- it is the shim failure, and guessing here is how a running task gets recorded as refused');
    check(error.providerAnswered !== true, 'and it carries no providerAnswered');
  }

  // -------------------------------------------------------------------
  // THE CONTAINED WINDOWS LAUNCH HAS A LONGER COMMAND LINE THAN CODEX'S OWN.
  // On win32 the default spawn contains the dispatch in a Job Object: it
  // starts powershell.exe with the wrapper script, and the codex command and
  // its arguments ride on THAT command line base64-encoded. A brief that fits
  // the cap as codex's own argv can overflow it once wrapped, so the check
  // must measure the wrapper line before anything starts.
  // -------------------------------------------------------------------
  {
    // The measured wrapper line is the one spawnInJob really builds.
    const brief = 'word '.repeat(200);
    const argv = [CODEX_ENTRY, 'cloud', 'exec', '--env', 'env-aaa', '--branch', 'main', brief];
    const dependencies = {
      wrapperScript: '/opt/ToolsEnabled/resources/capability/tools/windows-job-wrapper.ps1',
      assemblyCacheDirectory: '/state/windows-job-wrapper-cache'
    };
    let launched = null;
    const stopped = new Error('captured');
    try {
      windowsJob.spawnInJob('\x43:/node/node.exe', argv, { cwd: '/work', env: { SystemRoot: '\x43:\\Windows' } }, {
        ...dependencies,
        platform: 'win32',
        recordDirectory: '/state/windows-jobs',
        safeLaunchEnvironment: env => ({ ...(env || {}) }),
        fsImpl: { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }), mkdirSync: () => {} },
        spawnImpl: (command, args) => { launched = { command, args }; throw stopped; }
      });
    } catch (error) { if (error !== stopped) throw error; }
    check(launched !== null, 'spawnInJob built its wrapper command line');
    check(typeof windowsJob.jobWrapperInvocation === 'function', 'the wrapper command line can be built without launching it');
    const measured = windowsJob.jobWrapperInvocation('\x43:/node/node.exe', argv, { cwd: '/work', env: { SystemRoot: '\x43:\\Windows' } }, dependencies);
    check(measured.command === launched.command, 'the measured wrapper is the program spawnInJob starts');
    check(dispatcher.windowsCommandLineLength(measured.command, measured.args)
        === dispatcher.windowsCommandLineLength(launched.command, launched.args),
      'and the measured wrapper command line is exactly as long as the launched one');
  }

  function containedSpawn(platform) {
    const calls = [];
    const spawnHidden = (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 4343;
      child.terminateJob = () => Promise.resolve({ type: 'terminated', activeProcesses: 0 });
      setImmediate(() => {
        child.stdout.end('https://chatgpt.com/codex/tasks/task_contained_ok_0001\n');
        child.stderr.end();
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    };
    return { calls, spawnImpl: dispatcher.createDefaultSpawn({ spawnHidden, platform }) };
  }

  {
    // 26,000 characters: fits as codex's own command line, not once wrapped.
    const brief = 'word '.repeat(5_200);
    check(dispatcher.windowsCommandLineLength('node', [CODEX_ENTRY, brief]) < dispatcher.WINDOWS_COMMAND_LINE_LIMIT,
      'the fixture brief fits the cap as codex\'s own command line');
    const { calls, spawnImpl } = containedSpawn('win32');
    const dispatch = make(spawnImpl);
    const error = await raises('CLOUD_DISPATCH_PROMPT_TOO_LONG',
      () => dispatch({ task: { contract: brief }, index: 12, account: 'cloud-a' }),
      'a contained win32 dispatch whose WRAPPER command line is over the cap is refused before any spawn');
    check(error.providerAnswered === true && calls.length === 0,
      'certainly, and without spawning');
    check(/Job Object wrapper/.test(error.message) && /\b3[3-9][0-9]{3}-unit\b/.test(error.message),
      `and it names the wrapper and its real command-line length: ${error.message}`);
  }

  {
    // Non-ASCII costs more once wrapped: three UTF-8 bytes, four base64 units.
    const brief = '\u4e2d'.repeat(9_000);
    const { calls, spawnImpl } = containedSpawn('win32');
    const dispatch = make(spawnImpl);
    await raises('CLOUD_DISPATCH_PROMPT_TOO_LONG',
      () => dispatch({ task: { contract: brief }, index: 13, account: 'cloud-a' }),
      'a 9,000-character CJK brief is refused on win32 on its wrapped length');
    check(calls.length === 0, 'without spawning');
  }

  {
    const brief = 'word '.repeat(400);
    const { calls, spawnImpl } = containedSpawn('win32');
    const result = await make(spawnImpl)({ task: { contract: brief }, index: 14, account: 'cloud-a' });
    check(result.taskId === 'task_contained_ok_0001' && calls.length === 1,
      'a brief that fits once wrapped still dispatches on win32');
    check(calls[0].options.containProcessTree === true, 'and it is still contained');
  }

  {
    // Where there is no wrapper command line, nothing changes.
    const brief = 'word '.repeat(5_200);
    const { calls, spawnImpl } = containedSpawn('linux');
    const result = await make(spawnImpl)({ task: { contract: brief }, index: 15, account: 'cloud-a' });
    check(result.taskId === 'task_contained_ok_0001' && calls.length === 1,
      'the same 26,000-character brief still dispatches on Linux');
  }

  console.log(`codex-dispatcher command-line tests passed (${checks} checks: the per-argument quoting cost measured against libuv's own worked examples, the whole command line summed with separators and the terminating NUL, a quote-heavy brief refused BEFORE any spawn and marked certain, the same length without quotes still dispatching, an OS-level command-line rejection recorded as certain while EINVAL stays uncertain, and a contained win32 dispatch measured on the wrapper command line it really launches).`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
