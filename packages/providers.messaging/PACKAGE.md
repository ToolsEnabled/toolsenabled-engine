# `providers.messaging` package charter

## Purpose

Owns Instagram and generic messaging provider adapters. Destination policy,
owner prompts, and durable delivery status remain outside this provider family.

## Public API

`src/lib/providers/instagram.js`, `messaging.js`.

## Allowed dependencies

Q46-observed direct packages (cross-domain imports are compatibility exceptions
while the checker is report-only): `kernel.audit`, `kernel.policy`, `kernel.runtime`,
`kernel.state`, `providers.misc`.

## Action classes

`OUTWARD`, `ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not send, post, or interpret a response as owner authorization without
registry preflight and audit; add no dependency without a new Q46 edge.

## Verification

`node tests/package-charters.js`; `node tools/package-check.js`. Queue:
`BUILD-QUEUE.md`.
