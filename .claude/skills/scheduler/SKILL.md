---
name: scheduler
description: Schedule durable recurring ToolsEnabled actions using the SQLite-backed Windows Task Scheduler saga.
---

Call `system.status` to get the supported action list, then `scheduler.create` with
a stable name, a `daily`, `hourly`, or `minutes` schedule, action, and arguments.
For `minutes`, provide `intervalMinutes` from 1 through 1439. Use `scheduler.list`,
`scheduler.reconcile`, and `scheduler.remove` to manage jobs. A create or replacement
is durable before Windows registration; the prior immutable generation remains active
until its replacement is observed exactly. Unsupported actions and invalid arguments
are rejected before a task is registered. Treat an `uncertain` provider state as an
unresolved OS outcome and reconcile it rather than assuming success or absence.

Read `legacyCleanup` in reconcile results. Pre-saga `ToolsEnabled-<name>` tasks are
deleted only when the digest archive, timestamp, current account/SID, trigger, settings,
and historical command all match. A `conflict` or `unknown` result is deliberately left
untouched. Never delete scheduler tasks by prefix or name alone.
