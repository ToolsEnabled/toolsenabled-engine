# `controller` package charter

## Purpose

Projects agent activity, metering, escalation, focus, launches, and supervision.

## Public API

`src/lib/controller-*.js`, `src/lib/coordinator/`, `src/lib/supervision/`, and
`src/lib/source-freeze.js`; `src/lib/continuation-prune.js` exposes the native
owner-only dated-copy preview and confirmation service (no load-time pruning);
the owner-request scope family
(`src/lib/owner-request-scope*.js`, `src/lib/owner-request-lifecycle-projection.js`,
`src/lib/owner-request-status-projection.js`), `src/lib/backup-duty.js`,
`src/lib/ide-session-consent.js`, `src/lib/ide-session-consent-writer.js`;
tools: `tools/coordinator-duty-host.js`, `tools/coordinator-escalate.js`,
`tools/coordinator-runs.js`, `tools/generate-agent-activity-contracts.js`,
`tools/generate-delegation-contract-schema.js`, `tools/launch-terminal-record.js`,
`tools/process-visibility-refresh.js`, `tools/process-visibility-snapshot-writer.js`,
`tools/source-freeze.js`, `tools/spawn-record.js`, `tools/generate-mirrors.js`,
`tools/record-luna-worktree-policy.js`.

The report-only backup activation boundary is `src/lib/coordinator/backup-activation-request.js`
and `src/lib/coordinator/backup-execution-gate.js`; it names a pending request and a
blocked execution state, but does not create or schedule backups.

## Allowed dependencies

Q46-observed: `auth.google`, `delegation`, `fleet`, `fra`, `coordinator.core`,
`kernel.audit`, `kernel.policy`, `kernel.runtime`, `kernel.state`, `models`,
`owner.digest`, `owner.inbox`, `owner.ledger`, `sched`.

## Action classes

`SPAWN`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not silently launch or count an unverified metric as a verified saving.

## Verification

`node tests/controller-launch-record.js`; `node tests/package-charters.js`.
