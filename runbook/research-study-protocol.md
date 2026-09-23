# Research study declarations (v1)

This is a provenance foundation, not an executable LEAN-bench protocol adapter.
An accepted declaration means its structure and run binding were checked. It
does not mean the declared artifacts exist, were read, were complete, or were
used. It never makes a run ready or scientifically verified.

Ordinary Research experiments omit `runnerConfig.studyProtocol` and keep their
existing behavior. This optional declaration is supported only by the process
runner. The Research designer's existing additional runner-options JSON retains
it; no automatic benchmark configuration or provider call is supplied.

## Declaration schema

Every listed field is required when `studyProtocol` is present. Unknown fields
are refused, including purported canary pass results or verification badges.

| Field | Required declaration |
| --- | --- |
| `version` | `1` |
| `protocolId` | `lean-bench` |
| `studyId`, `batchId` | Explicit lowercase IDs, 1–120 characters; letters, digits, `.`, `_`, `:`, `-`; first character alphanumeric |
| `source` | Exactly `repository`: an explicitly selected `https://github.com/<owner>/<repository>` root URL, and `revision`: full lowercase 40-hex commit ID |
| `artifacts` | 1–64 objects containing exactly `id`, `role`, `sha256`; IDs unique across roles; full lowercase SHA-256 expected-byte identities |
| `environment` | Exactly `variableAllowlist`: 1–64 unique variable names (case-insensitive uniqueness), and `instructionPolicy: "instruction-bare"`; no variable values |
| `oracle` | Exactly `engineImage`: a digest-qualified image reference ending in `@sha256:` plus a full lowercase SHA-256; not a floating tag |
| `canary` | Exactly `surfaceIds`: 1–16 unique explicit IDs, and `policy: "calibrated-same-utc-day-before-and-after-batch"` |
| `gradingPolicy` | `deterministic-no-llm` |

Declare at least one artifact in each role: `protocol`, `prompt`,
`environment-manifest`, `oracle-data-freeze`, `oracle-bank-manifest`, `checker`,
`generation-harness`, `canary-harness`. Multiple prompt and checker artifacts
are permitted. Artifact IDs use the same format as study IDs. Role membership
is explicit, never inferred from filenames. The manifest is limited to 32 KiB;
the existing entire runner-configuration limit is still 64 KiB.

Select the primary protocol repository or a deliberately reviewed fork; there
is no built-in repository account or default. The URL must use the exact HTTPS
GitHub root form above, without credentials, a port, query, fragment, percent
escapes, extra path components or a trailing slash. Owner segments contain
1–39 ASCII letters, digits or hyphens, beginning and ending alphanumeric;
repository segments contain 1–100 ASCII letters, digits, `.`, `_` or `-` and
cannot be `.` or `..`. Accepted spelling is preserved in the immutable manifest
and its digest. This syntax check does not contact the repository, establish
upstream identity, prove a fork relationship, or verify protocol equivalence.
The `lean-bench` protocol ID remains a declaration, not an authenticity claim.

Each artifact digest identifies the expected bytes of a file or manifest, not
an unspecified directory. For a bank or data set, declare the expected bank or
data-freeze manifest's byte hash; the future adapter must also verify that
manifest's members and its defined aggregate algorithm. A syntactically valid
digest is not evidence of any of those checks. Do not substitute a registered
data aggregate hash for the hash of the data-freeze manifest file itself.

No paths, prompt bodies, environment values or authentication material belong
here. Artifact roles do not imply every necessary file has been enumerated.
In particular, a `checker` identity does not say which commands were invoked,
which code paths ran, or whether their verdicts were interpreted correctly.

The assessed public source revision was
`c5237c388263932b69d7aaf1fe1ac2f73436262c`. It is not a default, an installed
version assertion, or a requirement to keep using that revision. Explicitly
select the source revision and measure artifact hashes when preparing a study.

## Persistence and evidence boundaries

The exact manifest is part of immutable experiment configuration and its
existing configuration hash. Changing it requires a new experiment. The
worker validates it again before any runner action.

On successful process completion, `task.result.studyProtocol` contains:

```text
version: 1
status: declared-unverified
scope: prospective-study-manifest
manifest: <the exact prospective declaration>
manifestSha256: <SHA-256 of canonical JSON>
runId, experimentId, experimentConfigHash, paramsHash, attempt, fence
unmeasured: <the explicit unresolved requirements below>
```

Canonical JSON recursively sorts object keys, retains array order and string
values, and uses compact JSON serialization. Digests are lowercase hex. The
atomic completion boundary compares the declaration against the stored
experiment and current run/attempt, so a changed manifest, recomputed digest,
missing declaration, false verification label or cross-run substitution cannot
be accepted. This is a consistency check, not a cryptographic signature or
protection against an actor rewriting the whole database.

The study record is separate from `task.result.provenance` (optional declared
file checks at process boundaries), the user's input parameters and collected
result fields. Existing result JSON/CSV export retains nested `taskResult`.
Its `evidenceStatus` remains `collected` or `execution-only`, never a scientific
verdict. Queueing is not execution: queued and failed attempts retain the
declaration in experiment configuration, without a successful task-result
declaration. This slice does not add a failed-attempt/batch evidence export.

## Required future adapter work

All six requirements remain explicitly `unmeasured`, even after successful
process execution, collection and optional pre/post file checks:

1. Verify actual artifact bytes, manifest membership, data and bank completeness.
2. Measure an allowed-account cleanroom and reachable instruction-file absence.
3. Resolve actual generation surface, engine image and oracle identities.
4. Bind the delivered prompt bytes, conditions and draw identity to the batch.
5. Bind calibrated pre- and post-batch canary artifacts to that batch, each
   relevant surface, the generation interval and the same UTC day. Prospective
   policy fields are not retrospective certificates.
6. Execute the pinned deterministic checker and controls, bind their artifacts
   and outcomes, and distinguish harness/provider failures from model outputs.

The present per-run worker does not own an entire batch or enforce its pre/post
canary ordering. This document and schema do not invent checker semantics,
certify a generation model by its name, or imply OS sandboxing. A future
adapter must validate the actual pinned protocol rather than trusting success
shaped JSON or assuming every published entry point enforces every requirement.
Account fences still apply; historical CLI defaults or credential-copy paths
from another account must never be followed.

## Primary protocol references

- [Protocol overview at the assessed revision](https://github.com/JoshuaPinckard/LEAN-bench/blob/c5237c388263932b69d7aaf1fe1ac2f73436262c/README.md).
- [Calibrated per-surface canary instrument](https://github.com/JoshuaPinckard/LEAN-bench/blob/c5237c388263932b69d7aaf1fe1ac2f73436262c/instruments/canary.js) and [generation instrument](https://github.com/JoshuaPinckard/LEAN-bench/blob/c5237c388263932b69d7aaf1fe1ac2f73436262c/instruments/generate.js).
- [Bank identity checks](https://github.com/JoshuaPinckard/LEAN-bench/blob/c5237c388263932b69d7aaf1fe1ac2f73436262c/bank/verify_bank.py) and [deterministic grader/controls](https://github.com/JoshuaPinckard/LEAN-bench/blob/c5237c388263932b69d7aaf1fe1ac2f73436262c/instruments/grade.py).

The role names, bounds and v1 JSON structure above are ToolsEnabled's declared
provenance interface, not an upstream benchmark schema or a conformance verdict.
