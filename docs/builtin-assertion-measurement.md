# Reviewed legacy assertion measurement

`tools/measure-builtin-assertions.js` measures explicitly reviewed existing
CommonJS programs that use Node's builtin assertion library. The engine runner
enables it only with an explicit flag. It must run inside the same owned offline sandbox and
process guardian as the original test. It starts no additional process and uses
the original entry as the CommonJS main module, with its original arguments.

The request is a JSON file containing `schemaVersion: 1`, a fresh hexadecimal
`nonce` of at least 32 characters, absolute real engine `root`, absolute `entry`,
explicit string `args`, `modules: [{path, sha256}]`, and an unused absolute
`tracePath`. `modules` names the reviewed test entry and any additional fixture
modules whose assertions should count. Every file must be inside the real root
and match its independently captured SHA-256. Optional `excludedAssertions` is
an explicit array of `{path, sha256}` for reviewed product assertions that are
not test authority; it defaults to an empty array, never a path heuristic.
Exclusions must be disjoint from measured modules and belong to the source
closure when one is present. Invoke:

```text
node tools/measure-builtin-assertions.js --request /owned/request.json
```

The measurement proxy calls the real builtin assertion functions. It records
JSONL start/result events for each **outermost builtin assertion invocation**.
For example, five loop iterations with `assert.equal` produce five measured
calls. `assert.throws(() => assert.fail())` produces one passing outer assertion;
the expected nested failure is not a separate failed test. Async assertion
promises must settle. A caught assertion failure remains a measured failure and
forces a nonzero exit. Detached work is measured independently once its enclosing
assertion has completed. This unit differs from a Node test case and must never
be relabeled as a file's internal test-case count.

`validateAssertionEvidence` independently reconciles the raw event sequence,
source request, fixture imports, actual child PID/status/signal/error, runtime
hashes, natural completion, pending calls, summary totals and reported skips.
The caller must retain the raw trace, raw stdout/stderr and actual child process
result, including `pid`; it supplies its independently captured `expectedHarness`
(`builtin-assertion-evidence.js`, then the launcher), `expectedNode` (path,
version, SHA-256), `expectedPlatform`, and `expectedCwd`. The local validator
also reopens the measured files, so call it on that host before removing the
owned snapshot. Cross-host cut verification still needs to bind the exported
raw trace to the frozen source/input archive and runtime receipts; a local
validation result alone is not final cut authority.

Zero calls, pending promises, early `process.exit`, missing or changed source,
runtime drift, unmeasured fixture assertion imports, mixed `node:test` use,
loader replacement, proxy mutation, unsupported assertion APIs, late exit
assertions and unreconciled skips remain incomplete. Only explicitly declared
production-module assertion imports are excluded. Every other undeclared
builtin assertion import inside the source root invalidates the measurement.
Nonconfigurable loader and exit observers record temporary assignments, and an
explicit exit after a `beforeExit` callback cannot qualify as natural completion.

This does **not** prove that all branches ran, count a program's custom checks,
interpret arbitrary PASS counters, or measure ESM imports/new `Assert` instances.
A builtin import census only identifies candidates. Before enabling a program,
review its actual assertion authority and skip/reporting paths, declare its
fixture module scope, and preserve hybrid/custom gaps. The checked-in manifest
currently enables four programs. The cloud CommonJS import graphs were reviewed
at engine `99d3e302`; the exercised role-library graph was reviewed at `2aa1f372`:

| Program | Expected outer calls | Actual contract exercised |
| --- | ---: | --- |
| `tests/cloud-agent-state-machine.test.js` | 38 | Binding, submission, observation transitions and advancement gates |
| `tests/cloud-agent-session.test.js` | 9 | A new observation invalidates prior reconciliation until fresh evidence |
| `tests/cloud-agent-session-refusals.test.js` | 23 | Evidence/terminal refusals and the real one-second terminal observation timeout |
| `tests/agent-roles.test.js` | 65 | Public lookup, immutable projections, stored dispatch directions and unchanged capabilities |

The cloud fixture adapters return in-memory values. The role test loads four
product modules but calls only in-memory role lookup/projection functions;
their deferred storage, account-boundary and resource functions never run.
All four make no provider, network, filesystem or child-process call. The state-machine program's printed logical
check counter describes a different unit from the measured builtin calls.
The role denominator is independently enumerated as 6 lookup checks, 4 editable
projection checks, 4 immutable-library checks, 2 roles × 3 variants × 7
dispatch checks, 7 other-role checks and 2 no-base checks. The role directions
are product data; this program does not establish that a model follows them.
The session refusal's nested error-code check belongs to its one outer
`assert.rejects` invocation, and does not inflate the total.

The bounded regression command is:

```text
node --test --test-concurrency=1 --test-reporter=tap tests/builtin-assertion-evidence.test.js tests/builtin-assertion-scope.test.js
```

These tests spawn only tiny owned temporary Node fixtures and the inspected pure
programs. They make no provider, network or owner-state call.

The scope helper, `tools/lib/builtin-assertion-scope.js`, reads the exact
`tests/builtin-assertion-scopes.json` file. Every manifest entry requires a
complete hash-bound import closure, an explicit `excludedAssertions` list,
the independently reviewed expected number of outer calls, and a review
rationale. It adds the manifest to the request authority, and retains raw
request/trace/stdout/stderr in a fresh directory outside the disposable test
tree. Optional core request
fields `sourceClosure` and `expectedAssertions` let the core reject source drift,
undeclared CommonJS imports and a changed measured denominator. The helper's
`prepare(file, index)` returns `null` for every unreviewed program; no census
classification enables a test automatically. Unreviewed programs keep their
existing completion evidence, including unknown assertion counts.

Set `TOOLSENABLED_TEST_STRICT=1` through the caller's environment, then invoke
the maintained runner inside its owned source-test sandbox:

```text
node tests/run-isolated.js --config-integrity --summary /owned/result.json --measure-builtin-assertions /owned/result.json.assertions tests/cloud-agent-state-machine.test.js tests/cloud-agent-session.test.js tests/cloud-agent-session-refusals.test.js
```

The flag requires strict mode, a summary path, and the exact resolved
`<summary>.assertions` directory. Reusing an existing directory is refused.
Each measured row retains `measurement` with the actual PID/status/signal/error,
argv/cwd, source/manifest/harness/runtime identities, and relative artifact
paths with SHA-256 and byte lengths. Requested file index zero uses `00001`;
later indexes preserve their requested positions. The original stdout/stderr
bytes are written unchanged before the runner adds its own completion marker.
Test state is deleted normally; retained evidence remains outside that state.
Ordinary failures continue to the next file, and timeout/config-integrity rules
still apply. A missing trace, changed authority or caught assertion failure
cannot become a passing measurement.

Core controls reject scheduled explicit exit after `beforeExit`, temporary
loader/exit replacement, undeclared assertion exclusions, forged events and
source drift. Maintained-runner controls also exercise actual cleanup, byte
preservation, failure continuation, pending assertions, timeout, skipped work,
changed denominators, undeclared imports, invalid scope manifests and retained
directory reuse. Passing these controls and the four local programs
supplies no cut acceptance by itself. Cross-host verification must independently
match their raw events and bytes to the frozen source plan, current runtime,
actual parent process receipt and complete outer cleanup proof.
