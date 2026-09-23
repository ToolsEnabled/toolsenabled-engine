# Research process input provenance

Research process experiments may declare `runnerConfig.pinnedFiles`. Each entry
contains an absolute literal `path` and the full expected `sha256` of its raw
bytes. The array is part of the existing immutable experiment configuration.
Changing a pin requires a new experiment. Omitting the property preserves
ordinary process execution; an empty array is refused rather than treated as a
verified empty manifest. Agent and HTTP runners refuse this option.

This is an executable process-runner contract. It is not a claim that a research
result is scientifically valid or that a benchmark protocol was satisfied.

## Submission and inspection

Use the authenticated `research-experiment-save` bridge action to register a
full experiment declaration, or pass it as `experiment` to
`research-run-submit`. The Research form currently authors command/argument
declarations but does not provide a pinned-file editor. Existing experiments
can also be submitted through `research.run_submit` using their experiment ID.
Registration alone does not execute anything. Submission can execute when the
Research pipeline, process runner, project, and worker are enabled.

Example declaration shape (angle-bracket values are placeholders, not real
paths or measured digests):

```json
{
  "projectId": "<existing project ID>",
  "name": "Pinned offline calculation",
  "runnerKind": "process",
  "runnerConfig": {
    "command": "<absolute executable path>",
    "args": ["<absolute script path>", "{replicate}"],
    "stdin": "params-json",
    "pinnedFiles": [
      { "path": "<absolute executable path>", "sha256": "<reviewed executable SHA-256>" },
      { "path": "<absolute script path>", "sha256": "<reviewed script SHA-256>" },
      { "path": "<absolute input path>", "sha256": "<reviewed input SHA-256>" }
    ]
  },
  "resultSchema": {
    "fields": { "observationId": "string", "value": "number" },
    "required": ["observationId", "value"]
  },
  "collector": { "kind": "stdout-json", "recordKind": "summary" },
  "maxParallel": 1,
  "timeoutMs": 30000
}
```

After registration, a submission can carry
`{ "experimentId": "<returned ID>", "params": { "replicate": 0 } }`.
Identical experiment/params replay the same run; independent replicates require
different params. Review and freeze the expected digests before submission.
Recomputing a digest from an unexpectedly changed file would approve those
changed bytes, not establish agreement with the intended instrument.

Read `research-runs` with the run ID, or `research.run_status`. A completed
pinned run retains `task.result.provenance` beside its collected-record hash,
attempt, fence, and existing evidence status. The current JSON results export
retains that task result. A missing receipt on an older run establishes no
input verification.

## Enforced checks and receipt

Before spawning the declared command, the runner measures every pinned file.
After the process closes, it measures them again before the worker can collect
and accept results. Both checks must equal the declared digest. Missing,
unreadable, mismatched, nonregular, linked, changing-during-read, or oversized
inputs refuse completion. A preflight mismatch prevents the command from
starting. A post-process mismatch preserves the failed attempt without
accepting its otherwise valid result records.
The worker rechecks its claim and cancellation state after asynchronous input
verification before allowing the command to start.

There may be 1 through 64 distinct files, with at most 256 MiB of total bytes
per verification phase. Paths are literal, not globbed or parameter-expanded.
Windows device paths, UNC paths, alternate streams, ambiguous path segments,
foreign profile spellings, and linked parent chains are refused before being
followed. File descriptors are compared with path observations before and
after bounded asynchronous hashing. Operational resource exhaustion remains
an indeterminate failure handled by the worker's existing retry policy.

The version 1 receipt has scope
`declared-file-checks-at-process-boundaries`. It records:

- The run ID and the unique attempt working directory.
- The actual substituted command and ordered arguments, stdin mode, UTF-8 byte
  count, and stdin SHA-256. The payload remains in the run params; it is not
  duplicated in the receipt.
- Sorted variable names and a SHA-256 of the sorted `[name, value]` pairs in
  the environment object handed to process spawning. Environment values are
  not exported; operating-system case handling may merge equivalent names.
- Each phase's start/end timestamp and each declared path's measured byte count
  and digest.
- `invocationSha256` and `receiptSha256`. Their input is compact UTF-8 JSON with
  object keys sorted recursively and array order preserved. The receipt digest
  excludes its own `receiptSha256` property. These survive durable task JSON
  serialization and can be recomputed after export.

Worker acceptance and the atomic state completion both check the receipt's
shape, digests, declared pins, run ID, and attempt directory. The result records
and receipt commit under the same queue fence. The receipt digest is an
integrity checksum, not a signature or independent attestation; a party able to
rewrite both a receipt and its digest can produce another self-consistent
document. The existing evidence status remains `collected` or
`execution-only`.

## Boundary of the guarantee

These checks observe specified files during two bounded time windows. They do
not prove that those files were unchanged throughout execution; a program
could change and restore them between checks. They do not prove which bytes a
child read, freeze undeclared imports, verify remote services, or constrain the
process's filesystem/network access. A command path is only byte-pinned if that
executable itself is listed. A hash of an environment is not a cleanroom
certificate. File checks are not an operating-system sandbox or protection
against an adversarial process that can race path replacement on the same host.

For a future LEAN-bench adapter, the public
[repository protocol](https://github.com/JoshuaPinckard/LEAN-bench/blob/main/README.md)
requires frozen prompts, a pinned LEAN engine and hash-verified oracle bank,
deterministic execution grading, and an instruction-bare environment with
calibrated same-day canaries around each batch. Generic file pins can bind
reviewed prompts, scripts, and manifest files, but do not inspect transitive
manifest entries or assert any of those other requirements. The
[cleanroom record](https://github.com/JoshuaPinckard/LEAN-bench/tree/main/cleanroom)
describes its calibration evidence. A supported benchmark adapter still needs
actual environment isolation and measurement, batch/canary enforcement,
container/oracle verification, deterministic grader integration, and explicit
binding of each observation to those artifacts. No LEAN-bench execution or
provider call is needed to exercise these generic local fixture tests.

## Process lifetime and cancellation

The process runner accepts an internal worker `AbortSignal`. Task cancellation,
heartbeat read failure, lease loss, and worker stop abort an in-flight command;
the worker waits for bounded cleanup before deciding its outcome. Worker stop
also wakes an idle/settings-pause wait. No worker instance claims another task
while its current `runOnce` is pending.

On Windows, the declared command starts inside the existing native Windows Job
wrapper. Root exit ends remaining Job members. Timeout, cancellation, broken
stdin delivery, and output overflow request authenticated Job termination, with
retained-wrapper termination as a fallback. The command timeout includes wrapper
startup; a late handshake cannot authorize a command after that deadline.
Cleanup observation has a separate 15-second budget. Root exit with pipes still
open receives a one-second drain budget before cleanup is requested. Each output
stream retains at most 1 MiB; exceeding either limit stops the command and
refuses collection, even if the captured prefix is valid result JSON.

`task.result.processLifecycle` records successful execution boundaries. It
includes the backend, root/wrapper/pipe observations, stop/fallback flags, a
non-secret process identity, and the native terminal outcome when observed.
`cleanupStatus: "EMPTY"` requires the authenticated native zero-member outcome
and wrapper/pipe closure. Root exit alone, a termination request, PID absence,
or the fallback's synthetic zero count is not that outcome. A normal native
root exit code of zero, wrapper exit code of zero, complete pipes/output, and
no timeout/cancellation/failure are all required before collection. An outcome
whose terminal type is `terminated` is never represented as a successful root
exit. Failed attempts try to retain lifecycle metadata in the existing fenced
checkpoint; cancellation or lease loss may legitimately refuse that write.
The code never writes around a task fence to preserve a receipt.

On POSIX, ordinary execution remains available in a fresh detached process
group. `cleanupStatus: "ROOT_CLOSED"` records only normal root exit and pipe
closure; it does **not** certify that every descendant stopped. Cancellation
requests `SIGKILL` for that group only before the root's exit has been observed.
No later numeric PID/group rediscovery is used. A group signal is not a native
membership receipt: interrupted POSIX cleanup remains `UNKNOWN`, even when the
root closes. Descendants can leave a process group. This is deliberately a
weaker compatibility guarantee than Windows Job containment, not a portable
sandbox or an independently verified research environment.

If bounded cleanup remains `UNKNOWN`, no records or post-process file receipts
are accepted, the attempt is not retried by that worker, and that worker
instance halts with `RESEARCH_RUN_CLEANUP_UNPROVEN`. Exact pending child handles
remain retained until actual closure; no PID-tree kill is substituted. The
entrypoint reports a nonzero exit on that halt. This is **not a durable
post-crash admission fence**: a new worker or the existing expired-task reaper
cannot establish cleanup from a stopped predecessor's missing receipt. Review
that unresolved attempt before starting replacement research work. Automatic
restart quarantine and authenticated durable terminal receipts remain separate
work; do not infer recovery permission from a PID, an age, or a missing file.

Focused verification uses `tests/research-runners.test.js` and
`tests/research-runs-worker.test.js`: small finite local Node descendants plus
explicitly injected lifecycle failures. The Windows cases exercise real native
Job cleanup on root exit, timeout, cancellation, and worker stop. Injected POSIX
checks establish control-flow behavior only, not a live Linux kernel proof.
This lifecycle contract does not change study-protocol status from
`declared-unverified` and does not certify any benchmark or scientific result.
