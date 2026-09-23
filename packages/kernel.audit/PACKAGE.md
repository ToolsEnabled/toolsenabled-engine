# `kernel.audit` package charter

## Purpose

Provides the append-only audit store and audit event facade used to record
local and outward capability activity. It is a kernel package: callers depend
on its public recording and verification API, not its storage internals.

## Public API

`src/lib/audit.js`, `src/lib/audit-store.js`; tools: `tools/audit-durability-check.js`.

## Allowed dependencies

Q46-observed direct packages: `kernel.policy`, `kernel.runtime`. Add no other
cross-package import without updating the boundary map and this charter.

Left undeclared on purpose: `tools/record-agent-launch.js` requires
`providers/subscription-launch-env.js`, so Q46 sees an edge to
providers.gateway -- unbackticked, so the charter test keeps reporting it. A
kernel package declaring a provider is an upward import; see
`packages/kernel.runtime/PACKAGE.md` for why the answer is to move that file
into the kernel rather than to declare it in six charters.

## Action classes

`LOCAL-WORK`, `RECORD`.

## Must not do

Do not send, publish, or interpret audit projections as authority; never store
credentials in audit payloads.

## Verification

`npm run test:audit`; `node tools/package-check.js`. Queue: `BUILD-QUEUE.md`.
