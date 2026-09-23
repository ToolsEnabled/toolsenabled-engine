# Coordinator Platform wire contracts

`manifest.json` and the versioned JSON Schema files below it are the sole wire
authority for P06. ToolsEnabled owns this package, while the `owner` recorded
for each schema is the P04 domain owner; this distinction does not grant a
runtime import, shared database, or new authority.

Run one deterministic command after changing a schema:

```powershell
node tools/generate-platform-contracts.js
node tools/generate-platform-contracts.js --check
```

The generator writes self-contained bindings for ToolsEnabled and the Portfolio
Dashboard consumer. Generated files never import application code. The runtime
consumer remains disabled unless a later explicitly approved migration phase
connects it; P06 only defines and validates wire shapes.

## Version and compatibility policy

- Every schema has a semantic package version in its `$id` and a required
  `schemaVersion` field. `1.0.0` is the only current wire version.
- Additive changes in the same major version may add optional fields only.
  Existing fields, their validation constraints, and required fields remain
  byte-for-byte equivalent.
- Removing or renaming a field, tightening a constraint, changing a field
  type, or making a formerly optional field required is breaking. Create a new
  major-version directory and adapter; do not silently reinterpret old data.
- `additionalProperties` is false everywhere except the explicitly documented
  `finance-result.data` source payload. That field is a read-only,
  source-labeled application result and is intentionally extensible. Its
  dynamic values are still recursively restricted to JSON primitives, arrays,
  objects with ASCII keys, and safe integers so both consumers hash it the
  same way.
- Canonical serialization is the documented `coordinator-platform-c14n-v1` subset:
  ASCII-sorted keys, ASCII JSON escaping, and finite safe-integer numbers only.
  Rejecting unsupported number forms is intentional; it avoids cross-language
  hash drift.
- Schema patterns use the checked portable ASCII subset. The generator rejects
  non-ASCII patterns and lookaround, named-capture, or Unicode-property syntax
  that could validate differently in Python and JavaScript.

Shared valid and invalid fixtures live in `fixtures/`. Both generated consumers
validate them; invalid fixtures prove a breaking extra field is rejected.

## P07 identity, clock, and hash policy

`identifier-policy.json` is the canonical ToolsEnabled-owned P07 policy.
The same deterministic generator emits self-contained Node/TypeScript and
Python utilities plus a checked hash-vector artifact. They remain a utility
layer only: this phase neither enables a runtime route nor changes any owner,
database, provider, or existing P06 schema field.

- `newId` / `new_id` uses a CSPRNG and 24 random bytes encoded as exactly 32
  base64url characters after a typed visible prefix. `validateId` /
  `validate_id` is lexical validation only. A matching prefix never grants
  identity, authorization, existence, or ownership.
- Control timestamps are exactly UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. Preserve a
  market-local timezone in a separate explicitly named field when needed.
  Monotonic-clock readings are process-local duration measurements and are
  deliberately neither serialized nor compared between processes.
- `TaskEventSequence` is an in-memory positive sequence helper. Its caller
  must persist and coordinate a sequence before using it as an authoritative
  event cursor; P07 does not introduce shared storage.
- `canonicalHash` / `canonical_hash` hashes the P06 canonical JSON subset
  with a length-framed, ASCII domain-separated SHA-256 frame. The hash domain
  is required and part of the digest, so one logical payload cannot be reused
  as a hash in another protocol domain.

P06 `1.0.0` keeps its existing, intentionally wider ID schema constraints for
compatibility. Future wire contracts may adopt a P07 typed-ID constraint in a
versioned additive/new-major contract; do not silently tighten existing data.

## P08 provenance labels and sink checks

`provenance-policy.json` and `provenance.schema.json` define a closed,
ToolsEnabled-owned provenance envelope. The generator emits self-contained
Node/TypeScript and Python bindings with the same vectors and no application
runtime import. This is an additive utility layer: existing P06 contracts,
provider behavior, storage, and production routes are unchanged.

- A provenance envelope has canonical, exact-case Section 10 labels plus
  safe evidence references (`evidenceId` and content hash). Labels and source references are
  sorted and de-duplicated, so serialization cannot drop or ambiguously merge
  provenance.
- Concatenation and deterministic calculations union input labels and evidence.
  Agent transformations add `untrusted-agent`; model summaries add
  `generated-model` while retaining every input label and source. Redaction
  preserves taint and adds `secret-derived` when appropriate; it never launders a
  secret into trusted data.
- `evaluateSink` / `evaluate_sink` covers command, memory, secret,
  approval, network, and external-write sinks. Any matching deny label blocks;
  an allowed result is only a necessary provenance condition and never grants
  authority. `requireSink` is a deterministic guard for a caller that has chosen to
  integrate the utility in a later migration phase.
- `safeDisplay` returns only labels, a source count, and a derived secret flag. It
  intentionally never returns payload content, evidence IDs, or hashes.

## P09 redaction and secret-canary gate

`redaction-policy.json` and `redaction-report.schema.json` centralize the
redaction categories already used by the audit and provider-specific safety
layers. The generator emits matching, self-contained Node/TypeScript and Python
services plus a cross-repository fixture artifact. Existing runtime redactors
remain in place during Release A; P09 adds the canonical service and gate
without changing a provider, SSE path, log sink, database, or production flag.

- `prepareEgress` / `prepare_egress` deep-clones JSON-compatible data, rejects
  cycles, excessive depth, and non-finite values, redacts sensitive structured
  fields before scanning strings, and returns a closed payload/report envelope.
- The policy covers safe handles and vault references, account and brokerage
  identifiers, cookies, tokens, authentication codes, private keys, payment
  credentials, and the existing generic credential/session suffixes. User
  customization accepts only bounded exact literals and exact field names;
  arbitrary regular expressions cannot enter the runtime.
- Findings contain only a safe path, detector ID, category, and count. They
  never retain the matched field value, literal, token, or canary. Reports are
  deterministic diagnostics, not authorization or cryptographic attestations.
- `verifyPreparedEgress` / `verify_prepared_egress` validates the report and
  expected egress, then rescans the prepared payload. A marker alone is
  insufficient, and residual canaries or sensitive material fail closed.
- The six declared boundaries are provider, log, SSE, evidence export,
  notification, and training candidate. The fake `TOOLSENABLED_CANARY_*` corpus covers
  nested errors, headers, browser traces, streams, and finance objects without
  using any real credential. Tickers and harmless code are explicit negative
  controls.

## P10 shared evidence store

`evidence-store-policy.json` and `evidence-store-record.schema.json` define the
additive P10 storage contract. They do not alter the frozen P06
`1.0.0/evidence.schema.json` wire contract. The main deterministic generator
also emits the same standard-library-only Python verifier into ToolsEnabled and
Portfolio Dashboard plus
`artifacts/coordinator-platform-evidence-store-1.0.0.json`.

- The store is a separate `TEEV` SQLite application with schema version 1.
  Metadata rows and tombstones are append-only. Protected and public bodies are
  never placed in the database; raw-byte SHA-256 objects live under
  `objects/sha256/<2>/<2>/<hash>.blob`.
- Every record binds a P07 evidence ID, task ID, context/scope ID, and request
  event ID to its P08 provenance, source version, protected locator, P09
  redaction report, content descriptors, and retention class. A
  domain-separated P07 record hash detects metadata changes.
- Public content must arrive in a verified P09 `evidence-export` envelope whose
  payload has exactly `summary`, `format`, and `content`. Public methods omit
  locators, source versions, protected descriptors, redaction reports,
  provenance source references, and all protected bytes. The generated Python
  module exposes no protected-content reader and its public readers default to
  deny without an authorizer.
- The Node service defaults to deny when no synchronous authorizer is supplied.
  Task and scope selectors must match the stored record exactly, but matching
  an ID is never itself an authorization grant.
- Deletion appends a content-bound tombstone before collecting an object.
  Collection occurs only when no active public or protected descriptor refers
  to that hash. Original record metadata remains verifiable after content
  retention expires.
- Writers stage and hash outside SQLite, then link CAS objects and append their
  record under the same immediate write lock used by collection. Span
  verification and extraction use one open descriptor. A bounded,
  authorization-gated sweep removes only old service-shaped temp, trash, and
  unreferenced CAS orphans.
- P10 remains unregistered and default-off. It adds no provider, MCP route,
  coordinator runtime import, external call, or signed-audit event; the latter is the
  separate P11 phase.
