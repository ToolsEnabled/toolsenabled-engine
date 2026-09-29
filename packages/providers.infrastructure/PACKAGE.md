# `providers.infrastructure` package charter

## Purpose

Owns generic deployment and infrastructure provider adapters. It composes
approved provider APIs; it does not own project policy or release decisions.

## Public API

`src/lib/providers/deployment.js`, `infrastructure.js`.

## Allowed dependencies

Q46-observed direct packages (cross-domain imports are compatibility exceptions
while the checker is report-only): `auth.google`, `kernel.audit`, `kernel.policy`,
`kernel.runtime`, `providers.google.suite`, `providers.misc`.

## Action classes

`OUTWARD`, `ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not deploy, alter infrastructure, or expose tokens without registry policy,
approval, and audit; add no dependency without a new Q46 edge.

## Verification

`node tests/package-charters.js`; `node tools/package-check.js`. Queue:
`BUILD-QUEUE.md`.
