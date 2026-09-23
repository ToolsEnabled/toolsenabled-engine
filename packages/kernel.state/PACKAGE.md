# `kernel.state` package charter

## Purpose

Owns durable local state transitions and concurrency-safe persistence. It is
a kernel boundary: consumers use the store API and do not reach into its files.

## Public API

`src/lib/state-store.js`, `src/lib/agent-coord-integrity.js`.

`src/lib/region-holds/byte-authority.js` owns the mediated byte-read receipts,
publication journal, recovery, and SQLite lifetime lock. Adapters supply exact
materialized bytes and canonical resources; this store does not infer semantic
dependencies or protect writes that bypass those adapters.

## Allowed dependencies

Q46-observed direct packages: `coordinator.workflow`, `kernel.runtime`, `sched`,
`surface.registry`. Non-kernel targets are existing
compatibility exceptions; do not extend them without a deliberate boundary change.

## Action classes

`LOCAL-WORK`, `RECORD`.

## Must not do

Do not perform network/browser effects or persist credentials in ordinary
state records; do not make state transitions non-atomic.

## Verification

`npm run test:state`; `node tools/package-check.js`. Queue: `BUILD-QUEUE.md`.
