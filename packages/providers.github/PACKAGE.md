# `providers.github` package charter

## Purpose

Owns the GitHub provider adapter. It translates approved capability calls but
does not define approval, policy, or audit behavior.

## Public API

`src/lib/providers/github.js`.

## Allowed dependencies

Q46-observed direct packages (cross-domain imports are compatibility exceptions
while the checker is report-only): `kernel.audit`, `kernel.policy`, `kernel.runtime`,
`kernel.state`.

## Action classes

`OUTWARD`, `ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not push, publish, or reveal credentials without registry preflight and
audit; add no dependency without a new Q46 edge.

## Verification

`node tests/package-charters.js`; `node tools/package-check.js`. Queue:
`BUILD-QUEUE.md`.
