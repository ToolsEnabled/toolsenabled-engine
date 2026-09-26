# Mediated byte coordination: repository files and FRA workspace reads

This slice connects actual `repo.read_file`, `repo.patch_file` and
`repo.write_file`, plus authenticated FRA `workspace.read`, to durable byte coordination. It is not the complete
shared-file system
replacement and does not establish semantic dependence.

## Choosing the file target

The four `repo.*` file tools resolve relative paths against the repository
containing the loaded provider. `providers/repo-files.js` derives `ROOT`
from its module location; in a packaged app this is the `app/capability`
package. It is not the checkout named in a task or the current shell directory.
Changing `host.exec` cwd does not retarget `repo.*`, and their arguments
provide no root selector. A successful mediated read receipt identifies its
canonical resource; that receipt describes the call's target, not permission
to change the target or reuse another transport's observations.

For files in an independent checkout inside the permitted owner profile, use
`host.read_file` with the absolute file path, then `host.patch_file` on
that same path. Use `host.write_file` when whole-file creation or replacement
is intended, observing its read-before-replacement requirement. These tools
still enforce profile containment, canonical identity, protected paths and
credential exclusions. A refused write is not permission to retry the same
target through another API or shell.

Shell reads and native tool reads do not establish the host file API's read
receipts. `host.exec`, native commands and external editors are not
byte-mediated. Repo and host file mediation also use separate authority stores;
observations and rebasing do not transfer between them. Use one appropriate
mediated file API for the intended target and reconcile explicit stale-read
refusals before editing.

Byte-disjoint mediated edits can have different writers. The authority
serializes individual operations; it does not assign one agent ownership of an
entire checkout. Semantic conflicts and shared Git index, commit and execution
resources still need coordination. A committed byte receipt confirms file
publication, not a Git commit or release qualification.

## Transport identity and observations

The owner host issues a private in-process scope for each authenticated session
binding. Sessions with the same declared agent ID still receive distinct scope
IDs. Direct stdin and authenticated paired-desktop transports have anonymous
transport scopes, not identities inferred from environment variables, role
names, or tool arguments. Revocation invalidates the private capability before
asynchronous durable closure. Tool callers cannot manufacture one by copying a
receipt or submitting an actor field.

These scopes are not canonical controller LaunchRecords. `canonicalLaunchId`,
`laneId`, `runId` and `rosterRef` remain null until a real authenticated
association exists. No fixture or receipt silently invents that association.

Each actual repository file-tool dispatch also receives a private one-shot
invocation capability using the registry's generated invocation ID and resolved
tool name. The provider consumes it once, checks its currentness alongside the
transport scope throughout the operation, and the registry retires it when the
handler settles. Retiring a call does not retire the scope or discard reads
needed by subsequent calls. Copied capabilities and public call traces cannot
be reused to execute another operation.

Successful repository-tool results include a separate top-level `currentToolInvocation`
diagnostic: its `invocationId`, `toolName`, `runtimeScopeId` and, for owner-host
scopes, a `sessionAssociation` with kind `owner-host-accepted-session` and the
accepted `sessionId`. That session identifier may have been supplied to the
app's start request; it is not necessarily host-generated or a canonical run.
Anonymous transports have no asserted session association. Repeated client
JSON-RPC IDs still produce distinct registry invocations; this is not network
request deduplication or an exactly-once transport guarantee.

This diagnostic describes only the current call. It is not a serialized
capability, durable provenance receipt, or attribution of an operation recovered
while admitting that call. The byte database remains v2: scope bindings, read
receipts, operation JSON, checksums and recovery semantics are unchanged. In
particular, an old operation is never assigned the recovering call's invocation
or session identity. Durable invocation/session provenance requires a separately
reviewed migration and rollout plan; it is not implemented by this diagnostic.

A repository read materializes a bounded, stable file Buffer and records exactly the
returned byte window before releasing its content. Receipts bind the transport,
resource, offsets, content/file hashes, resource version and durable sequence.
Offsets count bytes, not characters or lines. Invalid UTF-8 and windows cutting
a multibyte character refuse instead of recording a lossy decoding. BOMs and
line endings are preserved. Unread bytes are not recorded as observed.

## Authenticated FRA workspace observations

After secure authentication, required authorization audit and exact binding
acceptance, the FRA listener creates one private `paired-desktop` scope. Its
association with the accepted workspace context and live connection is private;
copying the public digest/generation/host object cannot create or reuse that
capability. Workspace handle sessions also retain the exact private scope.
The real registry issues a one-shot invocation for each `workspace.read`.
No owner-host session, canonical launch or durable invocation origin is inferred.

The broker selects only its previously issued opaque file handle and expected
identity version. Its actual descriptor materialization runs after relevant
publication recovery, inside the same authority transaction used by repo
writes. The authority copies and hashes that Buffer, validates the selected
window and records it before content release. The workspace audit explicitly
requests a durable, anchored append; ordinary batchable audit recording is not
substituted for that requirement.

FRA and repo use the same state-root authority files and canonical absolute
resource keys (case-folded on Windows), not separate databases keyed by handle
or session digest. Both refuse ordinary hard-link aliases. Canonical containment,
protected paths and descriptor/name identity are rechecked; this is fail-closed
alias handling, not complete filesystem alias support. The shared internal
canonical-resource resolver has no public path-input length cap; the public
repo tool still enforces its existing 400-character input limit.

The existing pathless FRA output shape is retained. It returns no raw authority
receipt, resource path, private capability or repair bytes. UTF-8 retains FRA's
existing TextDecoder BOM behavior, and Base64 preserves exact binary bytes.
An offset past EOF still returns an empty window at EOF while reporting the
original requested offset; the receipt records the actual clamped interval.
Invalid UTF-8 or failed audit produces no byte-read receipt.

Disconnect, timeout, key rotation and service shutdown synchronously revoke
the private scope. Durable closure is tracked and failures are logged as
unproved. The service shutdown callback joins that closure. Currentness is
checked again inside admission and before the final encrypted response, including
after MCP's final audit. A receipt committed before later revocation remains a
record of the adapter observation, not proof that the remote peer received it.
The listener process propagates a missing or failed retirement join as a bounded
shutdown failure, not exit 0. Exit 1 reports an unproved outcome; it is not proof
of cleanup or global quiescence of other processes.

FRA's reviewed permission exclusions are unchanged: it cannot call repo or host
file writers through this adapter. A separate local mediated writer can rebase
or invalidate FRA observations through the common authority. Workspace listing,
absence/directory observations and native file adapters are not byte-mediated by
this change. Old FRA processes do not acquire this implementation dynamically;
restart the corresponding process before treating its reads as covered.

## Publication and recovery

A patch requires prior observations covering its changed span, and validates
the scope's other file observations as well. A mediated length-changing edit
rebases unaffected intervals and invalidates overlapping observations. A
partial reread repairs only the bytes it actually exposes. Detected unmediated
changes require a whole-file reread because their coordinate transform is not
known. Rereading satisfies the mechanical freshness requirement; it does not
prove that an agent reasoned correctly about the change.

A whole-file write is explicitly blind replacement, not a patch pretending
that its supplied bytes were read. It needs no target read receipt but still
validates the scope's actual read set. A changed whole-file write invalidates
all observations on that resource, including the writer's. Missing and empty files are
distinct durable states; creating an empty file is an effect, not a no-op.
A deleted observed dependency cannot be cleared by pretending absence was a
read: restore and actually reread it, or use a legitimately new scope.

Creation uses an exclusively created, fsynced sibling stage with a bounded
operation-derived name. PREPARED binds its device, inode, digest and length.
Atomic hard-link publication refuses an intervening target instead of replacing
it. Only the exact prepared stage/target identity pair may retire that temporary
second link. Recovery refuses equal-content replacement identities and extra
aliases; ordinary materialization still requires one link. An interruption
before PREPARED can leave an unreferenced stage, never a published target. Such
stages are not swept or adopted using age or filename guesses. V1 store migration
preserves the original operation and receipt JSON and integrity checksums while
interpreting its existing-file records as present. This is process
crash recovery, not a guarantee against arbitrary filesystem or power loss.

One SQLite writer transaction retains the authority's operating-system lock
throughout each asynchronous operation. There is no age-based live-owner lock
steal. A separate database durably records PREPARED before atomic file
publication, then COMMITTED afterward. The publisher checks the private scope
synchronously immediately before rename or link. Revocation after a committed write
reports that publication occurred; it cannot falsely report an unapplied write.

Admission recovers relevant pending operations when the current bytes match
the recorded before or after image. Unexpected bytes remain UNKNOWN and block
the affected resource and scopes depending on it, not unrelated work. Recovery
records observed materialization, not a claim that the original caller received
success. A missing/corrupt authority store refuses; it is not an empty history.

The existing whole-file guard is retained around synchronous publication for
compatibility when concurrent legacy writes are disabled. The new
byte authority itself does not disappear when concurrent legacy writes are
enabled. External editors do not hold this authority's lock; a final comparison
can detect observed drift but is not an operating-system fence against every
unmediated check-to-rename race.

## Host file tools (`host.read_file`, `host.write_file`, `host.patch_file`)

Added 2026-09-11 so the coordination works on any codebase in the owner
profile tree, not only this package: agents in Agent API mode "Only" edit
their own clones through the host tools, and `repo.*` cannot write an
installed payload.

**Scope.** A host tool dispatch that carries the transport's private file
scope (owner-host session, direct stdio, paired desktop) gets the same
one-shot invocation capability as `repo.*`, and its binding is that scope.
Host resources live in a separate authority instance with its own store,
`<state>/state/byte-coordination-host/`, keyed by canonical absolute path;
they can never share rows with the `repo.*` store, whose schema, data and
512 KiB bound are unchanged. Host resources use the host bound, 2 MiB. The
host instance turns on five opt-in authority options (all default off, so
`repo.*` and FRA behave exactly as before):

- `readSetScope: 'resource'` validates and recovers only the resource being
  written. Another file this scope once read, or an unresolved operation on
  an unrelated file, never blocks this write.
- `writeRequiresObservation`: replacing an existing file requires this
  scope's current observations to cover every current byte (a byte window is
  not enough). `host.write_file` is therefore read-before-write, unlike the
  blind `repo.write_file`.
- `observeOwnWrites`: under the same lock that confirmed the published bytes,
  a committed whole-file write leaves its writer a current observation of
  exactly those bytes (receipt `source: 'own-publication'`), so consecutive
  writes and patches by one scope need no reread. Never granted to recovered
  operations.
- `pruneCommittedPayloads` (see Retention).
- create-conflict abort: if an unmediated writer creates the target inside
  the publication window, the atomic no-replace link fails with EEXIST, the
  adapter retires its own verified stage, and the authority, after checking
  under the lock that the target is not its stage and the stage is gone,
  marks the operation ABORTED (`BYTE_CREATE_CONFLICT`). The resource is not
  left UNKNOWN.

A read that finds a file absent observes that absence: it releases no content
and creates no receipt, but it retires this scope's own stale observations of
the vanished file so the scope may create it again (create-only).

**Guarantees.** `host.read_file` records a durable receipt for exactly the
bytes returned (whole file, or a character-aligned `startByte`/`endByte`
window) after durable audit admission; a whole file decodes exactly as the
legacy reader did (invalid UTF-8 becomes U+FFFD, never a refusal).
`host.write_file` replaces an existing file only when this scope has read all
of it and nothing changed since, through any path: another agent's mediated
write, `host.exec`, a native tool or an external process. Otherwise it
refuses with `HOST_FILE_STALE` (changed; the message names the changed byte
windows) or `HOST_FILE_READ_REQUIRED` (never read, or only partly), and
nothing is written. A missing target uses atomic no-replace creation; when
another writer creates it first, the call refuses. A successful write marks
every other scope's observation of the file stale, so their writes refuse.
`host.patch_file` replaces one exact, uniquely occurring span this scope has
read; byte-disjoint mediated edits by others are rebased, overlapping or stale
observations refuse. Every legacy refusal is kept: credential locations,
symlinks, non-files, write-protected anchors, the 2 MiB limit, audit admission
before any byte, and `withSharedWrite` on the canonical target (the same key
the legacy writer takes). Publication preserves the existing file mode and
fsyncs before rename.

**Non-guarantees.** `host.exec`, native CLI tools and external processes are
not mediated and are not fenced: they can change a file at any time. Mediated
writes detect such changes and refuse rather than clobber them, but a change
racing the final comparison-to-rename step of a mediated publication is not
excluded by an OS lock. Calls that arrive without a transport file scope
(in-process callers such as the mission bridge, direct provider calls) keep
the legacy unmediated behaviour; their writes look like external changes to
mediated scopes. `host.patch_file` has no unmediated form and refuses there
(`HOST_FILE_SCOPE_REQUIRED`). Hard-linked host files are readable (legacy
behaviour) and replacement by rename detaches the other link, as before.
Reads expire like `repo.*` reads (1 h solo, 60 s when another scope holds a
live read of the same file); an expired observation refuses a write until
reread. Creation needs `link()` support on the target filesystem. One SQLite
writer transaction serializes all host authority operations machine-wide, and
its synchronous work runs on the calling process's thread.

**Retention.** Host writes can be 2 MiB and many agents write constantly. With
`pruneCommittedPayloads`, a committed operation's replacement payload is
removed from both the operations journal and its `*.prepared` event in the
same transaction that records COMMITTED; hashes, sizes, ranges, the original
integrity checksum and the receipt remain. Recovery only ever reads PREPARED
and UNKNOWN rows, so it is unaffected (recovered commits are pruned too).
Payload bytes are therefore bounded by live observations (one row per scope
and file, replaced on reread, deleted when the scope closes), not by the
number of writes; the remaining per-operation metadata grows linearly at a
few kilobytes per write. Measured 2026-09-11 on Linux (500 writes of
100 KB through the shipping configuration): without pruning the store grew
141.1 MB (about 282 KB per write: the payload is kept in both the operation
row and its prepared event); with pruning, 4.9 MB for 500 writes to one file
(about 9.9 KB per write of hashes, receipts and events) and 10.0 MB for 500
writes spread over 50 files, of which 5.3 MB were the 50 live 100 KB
observations; closing that scope freed them for reuse (SQLite reuses free
pages; the file does not shrink without VACUUM). Receipts, events and
terminal operation rows are not compacted yet: plan on roughly 10 KB per
write and 1.5 KB per read of durable metadata.

**Kill switch.** `TOOLSENABLED_HOST_BYTE_MEDIATION=off` (also `0`, `false`,
`no`, `disabled`; read per call) restores the legacy `host.read_file` and
`host.write_file` byte for byte, with no receipt fields and no host store
access; byte-window reads and `host.patch_file` refuse with
`HOST_BYTE_MEDIATION_OFF`. Default is on.

## Remaining work before a full replacement

- Migrate native CLI/file tools, search outputs, `host.exec` and every
  other relevant file exposure/publication path. Compatibility provider calls
  currently remain unmediated and do not return coordinated receipts.
- Bind scopes to actual controller launch, lane and run authority; implement
  dispatch/acknowledgment and durable repair-budget orchestration.
- Persist authenticated session and invocation provenance with an explicit
  backward-compatible migration and safe mixed-version rollout.
- Establish bounded retention/compaction and measure many-agent throughput.
  A single cross-process transaction currently serializes authority operations;
  these focused tests do not demonstrate 50 or 1,000 simultaneous agents.
- Study semantic dependency witnesses using observed code/contracts/tests.
  Byte-disjoint edits can still break a shared invariant. Exposure is evidence
  of what was read, not proof of what the work semantically depends on.

Focused offline tests exercise actual registry/provider/file/SQLite execution,
authenticated owner-host sessions, paired-desktop binding, separate-process
contention, controlled crashes, revocation and recovery. Some transport tests
inject principal/ACL lookup; they do not certify a production Windows ACL or
owner-window restart. No provider account or research benchmark is used.
