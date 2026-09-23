# `owner.digest` package charter

## Purpose

Builds, schedules, and renders the owner-facing agent activity digest.

## Public API

`src/agent-digest.js`, `src/lib/agent-digest/`.

## Allowed dependencies

Q46-observed: `auth.google`, `controller`, `fleet`, `fra`, `coordinator.core`, `kernel.audit`,
`kernel.runtime`, `kernel.state`, `owner.inbox`, `providers.gateway`,
`providers.google.suite`, `sched`.

## Action classes

`OUTWARD`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not claim a send or schedule succeeded without its durable transport record.

## Verification

`node tests/agent-digest.js`; `node tests/package-charters.js`.
