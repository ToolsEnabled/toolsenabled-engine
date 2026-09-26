# `sched` package charter

## Purpose

Owns durable schedules, managed processes, service lifecycle, and task dispatch.

## Public API

`src/lib/scheduled-actions.js`, `src/lib/scheduler-adapter.js`,
`src/lib/resource-alerts.js`; tools:
`tools/health-observer.js`, `tools/reap-playwright-temp.js`, `tools/service-restart.js`,
`tools/resource-alerts.js`, `tools/idle-cpu-check.js`, `tools/configure-editor-perf.js`.

## Allowed dependencies

Q46-observed: `controller`, `delegation`, `desktop.native`, `fra`, `coordinator.core`,
`kernel.audit`, `kernel.policy`, `kernel.runtime`, `kernel.state`, `owner.inbox`, `surface.registry`.

## Action classes

`RECORD`, `LOCAL-WORK`.

## Must not do

Do not perform unbounded retries, hide a dead service, or bypass the kill switch.

## Verification

`npm run test:sched`; `node tests/package-charters.js`.
