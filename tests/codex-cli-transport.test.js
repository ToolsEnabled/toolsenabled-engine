// NOTHING FOUND
//
// Test-can-fail report: testcanfail-tests-codex-cli-transport-test-js
//
// Mutation observations (the production file was restored byte-for-byte):
// - Disabled content-level reported-error detection. RED:
//   "AssertionError [ERR_ASSERTION]: Missing expected rejection."
// - Changed labeled status parsing to return `status: null`. RED:
//   "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal"
//   with actual `status: null` and expected `status: 'in_progress'`.
// - Disabled child killing. RED:
//   "AssertionError [ERR_ASSERTION]: the timed-out child must be killed"
//   followed by `false !== true`.
// - Restoration was verified by matching SHA-256 hashes
//   `02faefaca04a88d4bddae843553a43a5342c67bbce2f30bf176b83aa9a8b7790`,
//   after which the suite was GREEN: "codex-cli transport tests passed (23
//   checks: fail-closed factory options, no-shell argv submit parse,
//   env-not-found at exit 0, ambiguous-submit null, strict list --json parse,
//   defensive status parse to UNKNOWN, timeout and output-cap kill paths,
//   bounded nonzero-exit excerpts, unsupported cancel/manifest refusals,
//   read-only diff passthrough, argv input hardening, and provider-API
//   integration with fake spawn)."
//
// Census of requested non-discriminating shapes:
// - NOT-FOUND (empty iteration): the only assertion loop iterates a fixed,
//   non-empty literal of ten malformed factory-option fixtures.
// - NOT-FOUND (exit status/truthy-only evidence): the nonzero-exit test also
//   verifies the transport-owned error code, bounded message, status excerpt,
//   and truncation marker; rejection predicates assert their owned error type
//   and exact error code before returning true.
// - NOT-FOUND (swallowed failure): no test-side try/catch or optional chain
//   absorbs a failure; the suite-level catch sets a failing process exit code.
// - NOT-FOUND (mock of the subject): fakeSpawn models the injected process
//   boundary, while assertions exercise transport parsing, validation,
//   classification, argv construction, limits, and provider integration.
// - NOT-FOUND (skip/platform no-op): there are no skips or platform guards.
// - NOT-FOUND (self-computed expected value): expected transport results are
//   independent literals/fixtures; contract validators are supplemented by
//   explicit state, task-id, and reconcile assertions.
//
// Preconditions not met: none.

'use strict';

// R1177 S1: focused tests for src/lib/cloud-agent/codex-cli-transport.js.
// Plain `node tests/codex-cli-transport.test.js`. Every child process is an
// injected fake spawnImpl: this suite never runs the real codex binary and
// never touches the network. The CLI behaviors asserted here mirror facts
// verified against codex-cli 0.146.0 on this machine, most importantly that
// `codex cloud exec` reports environment-not-found on stdout/stderr while
// still EXITING 0 -- so success may never be inferred from exit code alone.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createCodexCliTransport } = require('../src/lib/cloud-agent/codex-cli-transport');
const { createCodexCloudAdapter } = require('../src/lib/providers/codex-cloud');
const { CloudAgentError } = require('../src/lib/cloud-agent/errors');
const contract = require('../src/lib/cloud-agent/contract');

let checks = 0;
const check = (label, fn) => { fn(); checks += 1; void label; };
const asyncCheck = async (label, fn) => { await fn(); checks += 1; void label; };

async function rejectsWithCode(promise, expectedCode) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof CloudAgentError, `expected a CloudAgentError, got ${error && error.constructor && error.constructor.name}`);
    assert.equal(error.code, expectedCode, `expected code ${expectedCode}, got ${error.code}: ${error.message}`);
    return true;
  });
}

const hex = (char, length = 64) => char.repeat(length);
const opaque = (prefix, char = 'a') => `${prefix}${char.repeat(20)}`;
const TASK_ID = 'task_e_abc123DEF456';

function rawRequestInput(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'codex-cloud',
    environment: 'env-main',
    repository: { rootId: 'toolsenabled' },
    sourceRevision: hex('a', 40),
    fileKeeperProof: { proofId: opaque('fkp-', 'b'), treeSha256: hex('c') },
    idempotencyKey: opaque('idem-', 'd'),
    requiredModel: 'gpt-test-model',
    taskHash: hex('e'),
    pathAllowlist: ['src/**'],
    byteBudget: 4096,
    timeBudgetMs: 5000,
    ...overrides
  };
}

function baseRequestInput(overrides = {}) {
  return contract.validateRequest(rawRequestInput(overrides));
}

// A fake child process: an EventEmitter with stdout/stderr sub-emitters and a
// recorded kill(). Emission is deferred with setImmediate so the transport
// has attached its listeners first, exactly like a real async spawn.
function fakeChild(spec = {}) {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdinText = null;
  child.stdin.end = (value, encoding) => {
    child.stdinText = typeof value === 'string' ? value : Buffer.from(value).toString(encoding || 'utf8');
    if (spec.stdinError) setImmediate(() => child.stdin.emit('error', spec.stdinError));
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.kills = [];
  child.kill = signal => { child.kills.push(signal === undefined ? null : signal); return true; };
  setImmediate(() => {
    if (spec.stdout) child.stdout.emit('data', spec.stdout);
    if (spec.stderr) child.stderr.emit('data', spec.stderr);
    if (!spec.neverExits) setImmediate(() => child.emit('close', spec.exitCode === undefined ? 0 : spec.exitCode));
  });
  return child;
}

// route: (command, args, options) -> child spec. Every invocation is recorded
// with its exact argv and options so tests can assert the no-shell contract.
function fakeSpawn(route) {
  const calls = [];
  const impl = (command, args, options) => {
    const spec = (typeof route === 'function' ? route(command, args, options) : route) || {};
    const child = fakeChild(spec);
    calls.push({ command, args: [...args], options, child });
    return child;
  };
  impl.calls = calls;
  return impl;
}

const GROUND_TRUTH_LIST_JSON = JSON.stringify({
  tasks: [{
    id: TASK_ID,
    url: 'https://chatgpt.com/codex/tasks/' + TASK_ID,
    title: 'R1177 s1 lane task',
    status: 'ready',
    updated_at: '2026-08-08T00:00:00Z',
    environment_id: null,
    environment_label: 'Owner/repo',
    summary: { files_changed: 3 },
    is_review: false,
    attempt_total: 1
  }],
  cursor: 'cursor-abc123'
});

(async () => {
  // --- factory validation ------------------------------------------------------

  check('the factory fails closed on malformed options', () => {
    for (const bad of [
      { timeoutMs: 0 }, { timeoutMs: 'fast' }, { maxOutputBytes: 1 },
      { spawnImpl: 'not-a-function' }, { branch: '-rf' }, { branch: 'a..b' },
      { attempts: 0 }, { attempts: 99 }, { buildQuery: 'not-a-function' }, { codexBinary: '' }
    ]) {
      assert.throws(() => createCodexCliTransport(bad), error => {
        assert.ok(error instanceof CloudAgentError);
        assert.equal(error.code, 'CODEX_CLI_TRANSPORT_INVALID', `expected rejection for ${JSON.stringify(bad)}`);
        return true;
      });
    }
  });

  // --- createTask: submit success parse ---------------------------------------

  await asyncCheck('createTask submits the query on stdin with an explicit no-shell argv and parses the acknowledged task id', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: `Submitted task ${TASK_ID}\nView it at https://chatgpt.com/codex/tasks/${TASK_ID}\n` }));
    const transport = createCodexCliTransport({
      spawnImpl,
      branch: 'r1177/s1-cloud-core',
      attempts: 2,
      buildQuery: payload => `Run the bound charter task ${payload.taskHash}`
    });
    const request = baseRequestInput();
    const raw = await transport.createTask(request);
    assert.deepEqual(raw, { id: TASK_ID, status: 'queued' });
    assert.equal(Object.isFrozen(raw), true);

    assert.equal(spawnImpl.calls.length, 1);
    const call = spawnImpl.calls[0];
    assert.equal(call.command, 'codex');
    assert.deepEqual(call.args, [
      'cloud', 'exec', '--env', 'env-main', '--branch', 'r1177/s1-cloud-core',
      '--attempts', '2'
    ]);
    assert.equal(call.child.stdinText, `Run the bound charter task ${request.taskHash}`);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  });

  await asyncCheck('createTask carries a query longer than the Windows command-line ceiling intact on stdin', async () => {
    const query = 'long task body '.repeat(700);
    assert.ok(query.length > 8191, 'fixture must exceed the measured Windows command-line ceiling');
    const spawnImpl = fakeSpawn(() => ({ stdout: `Submitted task ${TASK_ID}\n` }));
    const transport = createCodexCliTransport({ spawnImpl, branch: 'main', buildQuery: () => query });
    await transport.createTask(baseRequestInput());
    assert.equal(spawnImpl.calls[0].args.includes(query), false, 'the long query must never occupy an argv slot');
    assert.equal(spawnImpl.calls[0].child.stdinText, query, 'the long query must reach stdin byte-for-byte, without truncation');
  });

  await asyncCheck('an acknowledged-but-unrecognizable submission returns null (UNKNOWN downstream), never a guessed id', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: 'Task accepted. Watch the dashboard for progress.\n' }));
    const transport = createCodexCliTransport({ spawnImpl, branch: 'main', buildQuery: () => 'do the task' });
    const raw = await transport.createTask(baseRequestInput());
    assert.equal(raw, null);
  });

  await asyncCheck('a failed stdin write is could-not-tell, is not latched, and does not erase the definite env-not-found control', async () => {
    let invocation = 0;
    const spawnImpl = fakeSpawn(() => {
      invocation += 1;
      if (invocation === 1) return { stdinError: Object.assign(new Error('machine busy'), { code: 'EIO' }) };
      if (invocation === 2) return { stdout: `Submitted task ${TASK_ID}\n` };
      return { stdout: "Error: environment 'env-main' not found\n" };
    });
    const transport = createCodexCliTransport({ spawnImpl, branch: 'main', buildQuery: () => 'do the task' });

    await rejectsWithCode(transport.createTask(baseRequestInput()), 'CODEX_CLI_STDIN_WRITE_FAILED');
    assert.equal(spawnImpl.calls[0].child.kills.length, 1, 'the child with an indeterminate write must be killed');
    assert.deepEqual(await transport.createTask(baseRequestInput()), { id: TASK_ID, status: 'queued' },
      'the per-call EIO must not be latched as absence or suppress a retry');
    await rejectsWithCode(transport.createTask(baseRequestInput()), 'CODEX_CLI_ENV_NOT_FOUND');
    assert.equal(spawnImpl.calls.length, 3, 'the existing definite not-found classification must still be reached independently');
  });

  // --- env-not-found detection despite exit 0 ----------------------------------

  await asyncCheck('createTask detects environment-not-found from content even though the CLI exits 0 (verified 0.146.0 behavior)', async () => {
    const spawnImpl = fakeSpawn(() => ({
      stdout: "Error: environment 'env-main' not found; run `codex cloud` to list available environments\n",
      exitCode: 0
    }));
    const transport = createCodexCliTransport({ spawnImpl, branch: 'main', buildQuery: () => 'do the task' });
    await rejectsWithCode(transport.createTask(baseRequestInput()), 'CODEX_CLI_ENV_NOT_FOUND');
  });

  await asyncCheck('any other Error: line at exit 0 is surfaced as a reported error, never as success', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: 'Error: not signed in to Codex Cloud\n', exitCode: 0 }));
    const transport = createCodexCliTransport({ spawnImpl, branch: 'main', buildQuery: () => 'do the task' });
    await rejectsWithCode(transport.createTask(baseRequestInput()), 'CODEX_CLI_REPORTED_ERROR');
  });

  await asyncCheck('an Error: line written only to stderr at exit 0 is also surfaced, never as success', async () => {
    const spawnImpl = fakeSpawn(() => ({ stderr: 'Error: not signed in to Codex Cloud\n', exitCode: 0 }));
    const transport = createCodexCliTransport({ spawnImpl, branch: 'main', buildQuery: () => 'do the task' });
    await rejectsWithCode(transport.createTask(baseRequestInput()), 'CODEX_CLI_REPORTED_ERROR');
  });

  // --- fail-closed preconditions: no spawn happens ------------------------------

  await asyncCheck('createTask refuses to run without an explicit branch or query builder, before any process is spawned', async () => {
    const spawnImpl = fakeSpawn(() => ({}));
    const noBranch = createCodexCliTransport({ spawnImpl, buildQuery: () => 'do the task' });
    await rejectsWithCode(noBranch.createTask(baseRequestInput()), 'CODEX_CLI_BRANCH_NOT_CONFIGURED');
    const noQuery = createCodexCliTransport({ spawnImpl, branch: 'main' });
    await rejectsWithCode(noQuery.createTask(baseRequestInput()), 'CODEX_CLI_QUERY_NOT_CONFIGURED');
    const emptyQuery = createCodexCliTransport({ spawnImpl, branch: 'main', buildQuery: () => '' });
    await rejectsWithCode(emptyQuery.createTask(baseRequestInput()), 'CODEX_CLI_QUERY_INVALID');
    const flagQuery = createCodexCliTransport({ spawnImpl, branch: 'main', buildQuery: () => '--attempts 9' });
    await rejectsWithCode(flagQuery.createTask(baseRequestInput()), 'CODEX_CLI_QUERY_INVALID');
    assert.equal(spawnImpl.calls.length, 0, 'no child process may be spawned for a refused precondition');
  });

  // --- list parse --------------------------------------------------------------

  await asyncCheck('listTasks parses the documented list --json envelope into bounded, frozen task rows', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: GROUND_TRUTH_LIST_JSON }));
    const transport = createCodexCliTransport({ spawnImpl });
    const listed = await transport.listTasks({ limit: 5 });
    assert.deepEqual(spawnImpl.calls[0].args, ['cloud', 'list', '--json', '--limit', '5']);
    assert.equal(Object.isFrozen(listed), true);
    assert.equal(Object.isFrozen(listed.tasks), true);
    assert.equal(listed.cursor, 'cursor-abc123');
    assert.equal(listed.tasks.length, 1);
    const task = listed.tasks[0];
    assert.equal(task.id, TASK_ID);
    assert.equal(task.status, 'ready');
    assert.equal(task.environmentLabel, 'Owner/repo');
    assert.equal(task.filesChanged, 3);
    assert.equal(task.isReview, false);
    assert.equal(task.attemptTotal, 1);
  });

  await asyncCheck('listTasks refuses non-JSON output outright instead of reading it as an empty list', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: 'a plain-text task table, not JSON' }));
    const transport = createCodexCliTransport({ spawnImpl });
    await rejectsWithCode(transport.listTasks(), 'CODEX_CLI_OUTPUT_UNPARSEABLE');
  });

  // --- status parsing ----------------------------------------------------------

  await asyncCheck('getTask extracts a labeled status line from plain-text status output', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: `Task ${TASK_ID}\nStatus: in_progress\nAttempts: 1\n` }));
    const transport = createCodexCliTransport({ spawnImpl });
    const raw = await transport.getTask(TASK_ID);
    assert.deepEqual(raw, { id: TASK_ID, status: 'in_progress' });
    assert.deepEqual(spawnImpl.calls[0].args, ['cloud', 'status', TASK_ID]);
  });

  await asyncCheck('getTask treats unrecognized status output as a null status, which the provider maps to UNKNOWN', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: 'a rich TUI table with no recognizable fields\njust prose\n' }));
    const transport = createCodexCliTransport({ spawnImpl });
    const raw = await transport.getTask(TASK_ID);
    assert.deepEqual(raw, { id: TASK_ID, status: null });

    const adapter = createCodexCloudAdapter({ transport, procRun: () => ({ status: 'failure' }) });
    const result = contract.validateResult(await adapter.inspect(TASK_ID, baseRequestInput()));
    assert.equal(result.state, 'UNKNOWN', 'unrecognized CLI output must surface as UNKNOWN, never as success');
  });

  // --- timeout and output-cap kill paths ----------------------------------------

  await asyncCheck('a hung CLI call is killed at timeoutMs and surfaces a distinct timeout code -- never success', async () => {
    const spawnImpl = fakeSpawn(() => ({ neverExits: true }));
    const transport = createCodexCliTransport({ spawnImpl, timeoutMs: 40 });
    await rejectsWithCode(transport.getTask(TASK_ID), 'CODEX_CLI_TIMEOUT');
    assert.equal(spawnImpl.calls[0].child.kills.length >= 1, true, 'the timed-out child must be killed');
  });

  await asyncCheck('output beyond maxOutputBytes kills the child and surfaces a distinct cap code -- never success', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: 'x'.repeat(5000), neverExits: true }));
    const transport = createCodexCliTransport({ spawnImpl, maxOutputBytes: 1024 });
    await rejectsWithCode(transport.getTask(TASK_ID), 'CODEX_CLI_OUTPUT_LIMIT_EXCEEDED');
    assert.equal(spawnImpl.calls[0].child.kills.length >= 1, true, 'the over-cap child must be killed');
  });

  // --- nonzero exit carries a bounded stderr excerpt ----------------------------

  await asyncCheck('a nonzero exit rejects with a bounded stderr excerpt, never a raw multi-kilobyte dump', async () => {
    const spawnImpl = fakeSpawn(() => ({ stderr: 'boom '.repeat(4000), exitCode: 3 }));
    const transport = createCodexCliTransport({ spawnImpl });
    await assert.rejects(transport.getTask(TASK_ID), error => {
      assert.equal(error.code, 'CODEX_CLI_NONZERO_EXIT');
      assert.ok(error.message.length < 2048, `error message must stay under 2KB, was ${error.message.length}`);
      assert.match(error.message, /status 3/);
      assert.match(error.message, /truncated/);
      return true;
    });
  });

  // --- fail-closed unsupported operations ---------------------------------------

  await asyncCheck('cancelTask and getTaskChanges fail closed with distinct codes and spawn nothing (no cancel subcommand, no manifest source in codex-cli 0.146.0)', async () => {
    const spawnImpl = fakeSpawn(() => ({}));
    const transport = createCodexCliTransport({ spawnImpl });
    await rejectsWithCode(transport.cancelTask(TASK_ID), 'CODEX_CLI_CANCEL_UNSUPPORTED');
    await rejectsWithCode(transport.getTaskChanges(TASK_ID), 'CODEX_CLI_MANIFEST_UNAVAILABLE');
    assert.equal(spawnImpl.calls.length, 0);
  });

  check('findTaskByIdempotencyKey is deliberately absent so ambiguous reconciles stay UNKNOWN', () => {
    const transport = createCodexCliTransport({ spawnImpl: fakeSpawn(() => ({})) });
    assert.equal('findTaskByIdempotencyKey' in transport, false);
  });

  // --- diff passthrough ---------------------------------------------------------

  await asyncCheck('fetchTaskDiff passes the unified diff through as a read-only string, untouched', async () => {
    const diffText = 'diff --git a/src/foo.js b/src/foo.js\n--- a/src/foo.js\n+++ b/src/foo.js\n@@ -1 +1 @@\n-old\n+new\n';
    const spawnImpl = fakeSpawn(() => ({ stdout: diffText }));
    const transport = createCodexCliTransport({ spawnImpl });
    assert.equal(await transport.fetchTaskDiff(TASK_ID), diffText);
    assert.deepEqual(spawnImpl.calls[0].args, ['cloud', 'diff', TASK_ID]);

    assert.equal(await transport.fetchTaskDiff(TASK_ID, { attempt: 2 }), diffText);
    assert.deepEqual(spawnImpl.calls[1].args, ['cloud', 'diff', '--attempt', '2', TASK_ID]);
  });

  // A DIFF IS ARBITRARY FILE CONTENT, NOT CLI OUTPUT TO BE SCANNED.
  //
  // The reported-error detector matches /^\s*error:\s?.*$/im, and an UNCHANGED
  // context line in a unified diff begins with a single space -- so an entirely
  // ordinary source line reading "error: marker," matched, and a SUCCEEDED
  // task's diff came back as CODEX_CLI_REPORTED_ERROR. That is the precise
  // failure the retrieval leg exists to end: the work exists and nothing can
  // fetch it. This codebase is dense with `error:` properties, so the class is
  // large. Found by using the tool against a real task, not by review.
  await asyncCheck('a diff whose own content contains error-shaped lines is retrieved, not misreported', async () => {
    const diffText = [
      'diff --git a/src/lib/x.js b/src/lib/x.js',
      '--- a/src/lib/x.js',
      '+++ b/src/lib/x.js',
      '@@ -1,5 +1,5 @@',
      ' const record = {',
      '   error: marker,',
      '-  old: 1',
      '+  now: 2',
      ' };',
      ''
    ].join('\n');
    const spawnImpl = fakeSpawn(() => ({ stdout: diffText }));
    const transport = createCodexCliTransport({ spawnImpl });
    assert.equal(await transport.fetchTaskDiff(TASK_ID), diffText,
      'a diff containing an error-shaped context line must be returned, not raised as a CLI failure');
  });

  // The detector must still work where it belongs. A real CLI failure is
  // reported on stderr, which is never a diff, so weakening stdout scanning for
  // this one operation must not weaken that.
  await asyncCheck('a real cloud diff failure on stderr is still raised', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: '', stderr: 'error: task not found\n' }));
    const transport = createCodexCliTransport({ spawnImpl });
    await rejectsWithCode(transport.fetchTaskDiff(TASK_ID), 'CODEX_CLI_REPORTED_ERROR');
  });

  await asyncCheck('the observed task-details 404 remains an actionable account prerequisite at exit zero or nonzero', async () => {
    for (const exitCode of [0, 1]) {
      const stderr = `Error: http error: get_task_details failed: GET https://chatgpt.com/backend-api/wham/tasks/${TASK_ID} failed: 404 Not Found; content-type=application/json; body={"detail":"Invalid task ID"}\n`;
      const transport = createCodexCliTransport({ spawnImpl: fakeSpawn(() => ({ stderr, exitCode })) });
      await assert.rejects(transport.fetchTaskDiff(TASK_ID), error => {
        assert.equal(error.code, 'CODEX_CLI_TASK_NOT_VISIBLE');
        assert.match(error.message, /Check the task ID and sign in to the account that created it/);
        assert.doesNotMatch(error.message, /https:|get_task_details|body=/);
        return true;
      });
    }
  });

  await asyncCheck('task absence recognition is bound to the requested task and exact provider diagnostic', async () => {
    const diagnostic = `Error: http error: get_task_details failed: GET https://chatgpt.com/backend-api/wham/tasks/${TASK_ID} failed: 404 Not Found; content-type=application/json; body={"detail":"Invalid task ID"}\n`;
    for (const stderr of [
      diagnostic.replace(TASK_ID, 'task_e_another0001'),
      diagnostic.replace('chatgpt.com', 'example.invalid'),
      diagnostic.replace('404 Not Found', '500 Internal Server Error'),
      diagnostic.replace('Invalid task ID', 'private-provider-failure-canary'),
      diagnostic.replace('"detail":"Invalid task ID"', '"detail":"Invalid task ID","private":"canary"')
    ]) {
      const transport = createCodexCliTransport({ spawnImpl: fakeSpawn(() => ({ stderr })) });
      await rejectsWithCode(transport.fetchTaskDiff(TASK_ID), 'CODEX_CLI_REPORTED_ERROR');
    }
    const diff = `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n ${diagnostic}`;
    const transport = createCodexCliTransport({ spawnImpl: fakeSpawn(() => ({ stdout: diff })) });
    assert.equal(await transport.fetchTaskDiff(TASK_ID), diff);
  });

  // A non-diff stdout is still suspect: an empty body is a real answer ("this
  // task changed no files"), but prose where a diff belongs is not.
  await asyncCheck('an error reported on stdout where no diff was produced is still raised', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: 'error: no attempt 7 for this task\n' }));
    const transport = createCodexCliTransport({ spawnImpl });
    await rejectsWithCode(transport.fetchTaskDiff(TASK_ID), 'CODEX_CLI_REPORTED_ERROR');
  });

  // --- input hardening ----------------------------------------------------------

  await asyncCheck('argv-bound inputs are validated so a crafted value can never be parsed as a CLI flag', async () => {
    const spawnImpl = fakeSpawn(() => ({}));
    const transport = createCodexCliTransport({ spawnImpl });
    await rejectsWithCode(transport.getTask('--config=evil'), 'CODEX_CLI_INPUT_INVALID');
    await rejectsWithCode(transport.getTask('short'), 'CODEX_CLI_INPUT_INVALID');
    await rejectsWithCode(transport.listTasks({ limit: 21 }), 'CODEX_CLI_INPUT_INVALID');
    await rejectsWithCode(transport.listTasks({ cursor: '--evil' }), 'CODEX_CLI_INPUT_INVALID');
    await rejectsWithCode(transport.fetchTaskDiff(TASK_ID, { attempt: 0 }), 'CODEX_CLI_INPUT_INVALID');
    await rejectsWithCode(transport.bindEnvironment({ environment: '--env-injection' }), 'CODEX_CLI_INPUT_INVALID');
    assert.equal(spawnImpl.calls.length, 0);
  });

  // A GROUND-TRUTH cursor, captured 2026-09-03 from `codex cloud list --json
  // --limit 1` running codex-cli 0.146.1 on this machine (the base64 bodies
  // are shortened; the punctuation and the leading "+" are verbatim). The
  // same call fed straight back as `--cursor` returned page 2 with a
  // different task id, so this value is a WORKING cursor at the CLI. The two
  // checks below are about the transport being able to use it at all.
  const REAL_CURSOR = '+RID:~G4U-AJOIzhldOQcEAAjRAQ==#RT:1#TRC:1#RTD:FFMNeBmc06hP2994zep3KwV2dGZzLk1Y#ISV:2#IEO:65567#QCF:8#CID:2';

  await asyncCheck('a cursor in the shape the CLI actually emits reaches argv instead of being refused as invalid input', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: JSON.stringify({ tasks: [], cursor: null }) }));
    const transport = createCodexCliTransport({ spawnImpl });
    const listed = await transport.listTasks({ limit: 5, cursor: REAL_CURSOR });
    assert.deepEqual(listed.tasks, []);
    const args = spawnImpl.calls[0].args;
    assert.equal(args[args.indexOf('--cursor') + 1], REAL_CURSOR, 'the cursor must be handed to the CLI verbatim');
  });

  await asyncCheck('the cursor the transport reports is a cursor the transport will accept back, so paging can advance', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: JSON.stringify({ tasks: [], cursor: REAL_CURSOR }) }));
    const transport = createCodexCliTransport({ spawnImpl });
    const page1 = await transport.listTasks({ limit: 5 });
    assert.equal(page1.cursor, REAL_CURSOR);
    // Feeding the transport's own output back in is exactly what
    // cloudTaskStatus does; it must not be an input error.
    const page2 = await transport.listTasks({ limit: 5, cursor: page1.cursor });
    assert.deepEqual(page2.tasks, []);
    assert.equal(spawnImpl.calls.length, 2);
  });

  await asyncCheck('a cursor that could be parsed as a CLI flag, or carries whitespace or a control byte, is still refused', async () => {
    const spawnImpl = fakeSpawn(() => ({}));
    const transport = createCodexCliTransport({ spawnImpl });
    await rejectsWithCode(transport.listTasks({ cursor: '-c' }), 'CODEX_CLI_INPUT_INVALID');
    await rejectsWithCode(transport.listTasks({ cursor: '+RID has a space' }), 'CODEX_CLI_INPUT_INVALID');
    await rejectsWithCode(transport.listTasks({ cursor: `+RID${String.fromCharCode(0)}NUL` }), 'CODEX_CLI_INPUT_INVALID');
    await rejectsWithCode(transport.listTasks({ cursor: `+${'a'.repeat(512)}` }), 'CODEX_CLI_INPUT_INVALID');
    await rejectsWithCode(transport.listTasks({ cursor: '' }), 'CODEX_CLI_INPUT_INVALID');
    assert.equal(spawnImpl.calls.length, 0, 'a refused cursor must never reach a child process');
  });

  await asyncCheck('an emitted cursor the transport could not page with is reported at the call that produced it, not two calls later', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: JSON.stringify({ tasks: [], cursor: '--not-a-cursor' }) }));
    const transport = createCodexCliTransport({ spawnImpl });
    await rejectsWithCode(transport.listTasks({ limit: 5 }), 'CODEX_CLI_OUTPUT_UNPARSEABLE');
  });

  // THE OUTPUT REFUSAL IS THE ONLY ONE THAT FIRES, SO IT CARRIES EVERYTHING.
  // A second guard below it -- `normalizedCursor !== null &&
  // !CURSOR.test(normalizedCursor)` -- was unreachable by construction, and it
  // was holding the two facts a reader needs (which cursor, and how many tasks
  // went unreported) plus a rule that had stopped being true: it still demanded
  // "letters, digits and + / = _ . -", the alphabet deleted for rejecting the
  // CLI's own `+RID:~...#...` cursor.
  await asyncCheck('the unusable-cursor refusal names the cursor, the tasks withheld, and the rule the shipped code enforces', async () => {
    const page = JSON.stringify({
      tasks: JSON.parse(GROUND_TRUTH_LIST_JSON).tasks,
      cursor: '--not-a-cursor'
    });
    const spawnImpl = fakeSpawn(() => ({ stdout: page }));
    const transport = createCodexCliTransport({ spawnImpl });
    await assert.rejects(transport.listTasks({ limit: 5 }), error => {
      assert.equal(error.code, 'CODEX_CLI_OUTPUT_UNPARSEABLE');
      assert.match(error.message, /--not-a-cursor/, 'the offending cursor must be quoted back');
      assert.match(error.message, /1 task\(s\) on this page were not reported/, 'the withheld tasks must be counted');
      assert.doesNotMatch(
        error.message,
        /letters, digits and \+ \/ = _ \. -/,
        'the refusal must not state the alphabet CURSOR no longer enforces'
      );
      assert.doesNotMatch(
        error.message,
        /begin with a letter or digit/,
        'a cursor beginning with "+" is accepted, so the refusal may not demand a leading letter or digit'
      );
      return true;
    });
  });

  // The dead guard's sentence, applied to the CLI's real cursor, would have
  // called a WORKING token malformed. Nothing may refuse this value.
  await asyncCheck('the shape the refusal describes is the shape the transport actually accepts', async () => {
    const spawnImpl = fakeSpawn(() => ({ stdout: JSON.stringify({ tasks: [], cursor: REAL_CURSOR }) }));
    const transport = createCodexCliTransport({ spawnImpl });
    const page = await transport.listTasks({ limit: 5 });
    assert.equal(page.cursor, REAL_CURSOR, 'the CLI\'s own cursor must survive the round trip');
    await transport.listTasks({ limit: 5, cursor: page.cursor });
    assert.equal(spawnImpl.calls[1].args[spawnImpl.calls[1].args.indexOf('--cursor') + 1], REAL_CURSOR);
  });

  // --- integration-shaped: the provider wired with this transport ---------------

  await asyncCheck('the codex-cloud provider wired with this transport surfaces bind/submit/status through the provider API', async () => {
    const spawnImpl = fakeSpawn((command, args) => {
      const subcommand = args[1];
      if (subcommand === 'list') return { stdout: JSON.stringify({ tasks: [], cursor: null }) };
      if (subcommand === 'exec') return { stdout: `Submitted task ${TASK_ID}\n` };
      if (subcommand === 'status') return { stdout: `Task ${TASK_ID}\nStatus: in_progress\n` };
      throw new Error(`unexpected subcommand: ${subcommand}`);
    });
    const transport = createCodexCliTransport({
      spawnImpl,
      branch: 'r1177/s1-cloud-core',
      buildQuery: payload => `Run the bound charter task ${payload.taskHash}`
    });
    const adapter = createCodexCloudAdapter({ transport, procRun: () => ({ status: 'failure' }) });
    const request = baseRequestInput();

    const ack = await adapter.bindEnvironment(request);
    contract.validateEnvironmentAck(ack);
    assert.match(ack.environmentRef, /^cli-env-[a-f0-9]{24}$/);

    const submitted = contract.validateResult(await adapter.submit(request));
    contract.assertResultMatchesRequest(request, submitted);
    assert.equal(submitted.state, 'SUBMITTED');
    assert.equal(submitted.providerTaskId, TASK_ID);

    const inspected = contract.validateResult(await adapter.inspect(TASK_ID, request));
    contract.assertResultMatchesRequest(request, inspected);
    assert.equal(inspected.state, 'RUNNING');
    assert.equal(inspected.providerTaskId, TASK_ID);

    // The transport has no idempotency lookup, so an ambiguous submission
    // reconciles to an honest UNKNOWN -- never a re-submit, never a guess.
    const reconciled = contract.validateResult(await adapter.reconcile(null, request));
    assert.equal(reconciled.state, 'UNKNOWN');
    assert.equal(reconciled.providerTaskId, null);
    assert.equal(spawnImpl.calls.filter(call => call.args[1] === 'exec').length, 1, 'reconcile must never re-run cloud exec');
  });

  console.log(`codex-cli transport tests passed (${checks} checks: fail-closed factory options, no-shell argv submit parse, env-not-found at exit 0, ambiguous-submit null, strict list --json parse, defensive status parse to UNKNOWN, timeout and output-cap kill paths, bounded nonzero-exit excerpts, unsupported cancel/manifest refusals, read-only diff passthrough, argv input hardening, and provider-API integration with fake spawn).`);
})().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
