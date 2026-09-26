# `providers.sandbox` package charter

## Purpose

Owns the isolated agent-sandbox provider adapter. It brokers bounded disposable
execution and does not receive host browser profiles, secrets, or Docker control.

## Public API

`src/lib/providers/agent-sandbox.js`.

## Allowed dependencies

Q46-observed direct packages (cross-domain imports are compatibility exceptions
while the checker is report-only): `kernel.audit`, `kernel.runtime`, `kernel.state`.

## Action classes

`RECORD`, `LOCAL-WORK`.

## Must not do

Do not bridge host profiles, secrets, local-model ports, or Docker sockets into
the sandbox; add no dependency without a new Q46 edge.

## Verification

`node tests/package-charters.js`; `node tools/package-check.js`. Queue:
`BUILD-QUEUE.md`.
