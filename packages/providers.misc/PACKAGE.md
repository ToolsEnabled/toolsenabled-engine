# `providers.misc` package charter

## Purpose

Groups small capability-manifest, code-intelligence, document-intelligence, and
shared local-input/path-safety provider leaves that share no stronger family.
It is not an unbounded catch-all.

## Public API

`src/lib/canonical-path.js`, `src/lib/providers/capability-manifests.js`,
`code-intel.js`, `doc-intel.js`, `host-control.js`,
`sensitive-local-input.js`, `repo-files.js`,
`owned-browser-cdp.js`.

The shared `provider-safety.js` compatibility path is owned by `kernel.runtime`;
it contains no provider-specific behavior and is used across provider families.

## Allowed dependencies

Q46-observed direct packages (cross-domain imports are compatibility exceptions
while the checker is report-only): `code.intel`, `fleet`, `coordinator.core`, `kernel.audit`,
`kernel.policy`, `kernel.runtime`, `kernel.state`, `surface.policy`, `surface.registry`.

## Action classes

`RECORD`, `LOCAL-WORK`.

## Must not do

Do not absorb unrelated provider code, bypass registry policy, grant a
manifest authority, or let generic repository-file access reach protected or
tool-managed paths; add no dependency without a new Q46 edge.

## Verification

`node tests/package-charters.js`; `node tools/package-check.js`. Queue:
`BUILD-QUEUE.md`.
