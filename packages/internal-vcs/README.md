# Internal VCS control plane

This package contains the complete Q100 internal VCS control plane through
stage-3 milestone M9. The design of record is
`docs/design/INTERNAL-VCS-DESIGN.md`.

Git remains the transition-era content/history adapter. The internal control
plane is designed to become authoritative for admission, revision completeness,
leases and fence tokens, typed conflicts, policy attestations, provenance,
multi-participant operation records, publish receipts, and recovery evidence.

`src/m1/` implements canonical immutable records and a caller-rooted,
append-only file control store with hash-linked events, compare-and-swap,
immutable snapshots, crash replay, and rebuildable projections. `src/m2/`
implements revision-manifest validation and a read-only Git shadow importer
covering Git objects, required refs, LFS objects, and submodules. The importer
uses an explicit-argv process runner and never fetches or mutates the observed
repository.

`src/m3/` through `src/m9/` implement explicit Ed25519 identity/trust mapping,
versioned policy and admission, fenced claims and lane lifecycle, typed
conflicts and validators, receipt-backed Git publication, recoverable sagas,
signed closure backups with isolated restore drills, and bounded protected-
stream migration. `createInternalVcsSystem(options)` binds all 38 service
methods to explicit adapters. The module-level `services` export preserves the
stage-2 method shape but fails with `VCS_ADAPTER_UNAVAILABLE` until callers
create an isolated bound system; it never falls back to a process-global
runtime.

Git remains the content, worktree, diff, and transport adapter. Shadow import
is read-only, protected publication is receipt-backed, and coexistence rollback
returns authority to Git without enabling a raw protected publish route. This
is the permanent dual-tree/parallel-system posture, not a flag-day replacement.

Safe defaults are exposed through `configuration.createInternalVcsConfig()`:
Ed25519 with explicit trust and opaque credential references, permanent
control/provenance/repository retention, 90-day build/evidence retention with
tombstones, no hard deletion, RPO <= 24 hours, and RTO <= 1 hour. Callers may
provide reviewed configuration overrides; unknown or unsafe options fail
closed.

Run the package checks from the repository root:

```powershell
node tests/run-isolated.js <packages/internal-vcs/test/*.test.js files>
```
Product name: **Filekeeper** (owner, R1162 2026-08-07). The stable code identifier remains `internal-vcs`; see docs/design/FILEKEEPER-EVIDENCE-ADDENDUM-2026-08-05.md.
