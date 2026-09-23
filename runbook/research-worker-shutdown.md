# Research worker shutdown foundation (V24)

This is process-lifetime infrastructure, not scientific certification or a
database migration permit. It does not run a benchmark, validate a study, or
activate the held V25 cleanup-quarantine migration.

## Owned shutdown contract

`getResearchWorkerSupervisor()` returns the same process-local registry facade
used by the research lifecycle tools. The application retains one facade for
its in-process owner host and a separate private inherited-IPC facade for the
capability child. Both must be sealed before waiting for either one. They are
not a new central service and neither one's observation stands for the other.

The supervisor creates a durable V2 launch record before spawning, retains the
original native process control and record handles, and starts the worker only
after a bounded private stdio handshake. The launch key is random and confined
to that retained stdin pipe; it is absent from argv, environment, persisted
records and diagnostics. A synchronous per-entry stop fence is checked at
native root authorization and before the private start command. Public stop
can finish one lifetime and permit a new clean start; app shutdown seals the
whole host epoch permanently.

The original monotonic deadlines are checked again when readiness/write
promises and private IPC replies resolve, and at final launch authorization.
A response that beats a starved timer callback but is already late cannot
extend its budget or authorize a private start.

The worker stops admission first, aborts its active run and wakes idle waits.
It drains the run and any already-pending heartbeat before closing its own
SQLite connection. Only then can it send the signed DB-close acknowledgement.
`owned-empty` additionally requires the original native scope's authenticated
empty outcome and the original wrapper/stdio close observation.
The actual nested runner and detached-leaf regression exercises this
containment; a root exit or PID probe alone is never substituted for it.

`quiesceOwned` is single-flight for the sealed host epoch. Its first request ID
and result are retained; another request does not rearm admission, create a new
deadline, or erase an UNKNOWN. `readResearchQuiescenceObservation(value, facade)`
returns a privately issued observation only for its exact issuing retained
facade. Copies, arbitrary JSON and even another genuine facade's observation
return null. The public lifecycle tool's ordinary result is not such proof.

## Private app transport

The mission bridge's `--research-lifecycle-channel inherited` flag installs
`toolsenabled.research-lifecycle.v1` before asynchronous startup or research
control construction. Parent hello binds a fresh app boot/per-spawn transport
generation. The child independently derives its host epoch and canonical-path
state scope. Subsequent requests and replies bind those values, sequence and
request ID. The generation identifies a connection incarnation, not a certified
source build. No database path or caller proof boolean is accepted over IPC.

The private lifecycle namespace can share the inherited descriptor with the
resource channel. Disposing its parent facade removes only its own listeners
and requests; it does not disconnect the shared descriptor or stop unrelated
services. The app must initiate owned quiescence before final child teardown.
Unavailable, unsupported, disconnected, malformed, replayed and timed-out
responses remain UNKNOWN. A local seal latch is not a remote acknowledgement.

## Deliberate limits and recovery

- This remains schema V24. Lazy research control construction avoids an eager
  research-side DB open, but other shared-state consumers can open the database.
  Laziness is not a V25 migration hold or cross-version fence.
- Observations cover only the originally owned worker scope, its descendants and
  that worker's SQLite connection. They do not prove that the in-process shared
  store, arbitrary external clients, agent-dispatched work, another runtime, or
  a previously detached legacy worker has closed.
- V1 records, legacy lifecycle locks, foreign/malformed V2 records and an
  interrupted record with no original ownership handle remain UNKNOWN and are
  preserved. Missing records, elapsed time and missing/dead PIDs do not establish
  global absence. This slice provides no force/PID/age-based reclaim or durable
  positive migration certificate. Restarted UNKNOWN requires a separately
  reviewed evidence/recovery mechanism; selecting another runtime is not one.
- `stateIdentity` is a digest of a canonical **path-scoped** identity, not SQLite
  contents, a stable database inode identity, or a proof that all connections
  have been found. Existing parents are checked without opening the DB;
  directory reparse/symlink aliases and observed multiply linked files are
  refused. Concurrent hostile filesystem replacement is not certified.
- Record removal retains and rechecks the original descriptor/file identity,
  exact bytes and final observed pathname identity. An observed replacement is
  left intact and makes the result UNKNOWN. Node's final pathname unlink is
  not atomic delete-by-retained-handle: a hostile swap after the last check is
  a residual boundary. This foundation must not be described as solving that
  race or used to authorize migration. A stronger native primitive is separate
  work, not a reason to weaken ownership checks.
- A DB-close failure or missing acknowledgement stays UNKNOWN even when native
  EMPTY was observed; the partial native fact is kept separately. Forced native
  cleanup without a complete worker acknowledgement is likewise not quiescence.
- Windows retains its native Job backend. Linux uses the separate retained
  guardian described below. Other platforms refuse managed worker startup;
  the older non-Linux POSIX process runner is not native descendant proof.

Before any future V25 operational migration, every old research worker must be
quiesced through its original retained control/child handles with supported
cleanup evidence. Newly opening V24 code rejects a V25 database, but migration
does not revoke already-open V24 connections. Mixed-version research workers
sharing a database remain uncertified. Neither this module nor app restart may
turn its limited observations into global database quiescence.

## Native Linux backend

Linux requires `/usr/bin/python3` with `os.pidfd_open`, `os.waitid(P_PIDFD)` and
`signal.pidfd_send_signal`, a supporting kernel, subreaper admission and readable
`/proc/self/task/.../children`. The fixed helper runs with `-I -S -B` and a minimal
environment. Missing or unusable native support refuses admission; it does not
fall back to numeric PID or process-group cleanup.

`linux-subreaper-pidfd-v2` retains each acquired pidfd through reaping and requires
kernel ECHILD plus matching observed/reaped counts and the exact guardian's
successful close. Counts cover children actually adopted/observed by the
guardian, not every short-lived descendant ever spawned. Guardian control,
private receipts and worker stdin use separate descriptors; the private receipt
descriptor is closed before worker exec. EOF or malformed receipts cannot claim
EMPTY. The caller retains unresolved ownership after its observation deadline.

This is process-lifetime custody, not a filesystem/network sandbox, protection
against hostile same-UID code, a durable cgroup, or a guarantee after guardian
death. DB-close acknowledgement is still separately required. No migration,
UNKNOWN recovery, provider login, agent dispatch or settings change is authorized
by a successful native cleanup receipt.

Research-run IDs and artifact paths remain in the fenced durable run record.
The worker does not duplicate them into generic free-text checkpoints, where a
generated hex ID can resemble a provider credential. General checkpoint and
task credential screening remains unchanged.

## Offline verification

The focused supervisor, worker-protocol and lifecycle-channel suites use finite
local Node children and private stream/IPC fault injection. They cover native
normal/no-start/DB-close-failure/nested-descendant paths, stop-start races,
observed record replacement, legacy preservation, pending-heartbeat drain,
forged/replayed/cross-facade/cross-epoch replies and namespace disposal.
No provider, benchmark, operational worker, owner restart or live DB is used.

On Linux, `tests/linux-native.js` also executes `linux-process-control.test.js`
and `linux-research-worker.test.js`, including the actual shipped worker with a
fresh V24 database, nested native runners, detached leaves, stdin separation,
admission/deadline races, failed DB acknowledgement, retained record replacement,
missing helper and malformed private-channel cases. Windows-only native tests
remain Windows-only; their skips are not counted as Linux proof.
