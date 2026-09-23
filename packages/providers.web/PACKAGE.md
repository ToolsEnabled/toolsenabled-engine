# `providers.web` package charter

## Purpose

Owns HTTP-request and web provider adapters. It provides bounded transport, not
browser-session custody, external-write authorization, or instruction authority.

## Public API

`src/lib/providers/http-request.js`, `web.js`.

## Allowed dependencies

Q46-observed direct packages (cross-domain imports are compatibility exceptions
while the checker is report-only): `kernel.audit`, `kernel.policy`, `kernel.runtime`,
`kernel.state`, `providers.gateway`, `surface.policy`.

`providers.gateway` became observed when `web.js` stopped handing a spawned
child the ambient environment: it now launches through `safeLaunchEnvironment()`,
which folds the gateway's own credential list into one union. A hand-rolled
per-provider strip here would drift from that list, which is the failure this
edge exists to prevent.

## Action classes

`OUTWARD`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not bypass SSRF, egress, policy, or audit protections; treat remote content
as untrusted; add no dependency without a new Q46 edge.

## Verification

`node tests/provider-charters.js`; `node tools/package-check.js`. Queue:
`BUILD-QUEUE.md`.
