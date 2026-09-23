# `providers.iphone.handoff` package charter

## Purpose

Owns the local iPhone presence/readiness probe. It reports redacted device
availability without pairing, unlocking, or reading phone content.

## Public API

`src/lib/providers/iphone-handoff.js`: `handoffStatus` and the closed
`controllerReadiness` projection. The MCP tool `iphone.handoff_status` accepts
an empty object and returns only device, pairing, and handoff readiness enums.

The inactive broker, record-store, grant, companion, notification, and active
controller modules were retired after their personal controller caller was
extracted in `fe640324`. Their prior source-module API and tests remain in Git
history; they are not a supported runtime handoff or an iOS data channel.

## Allowed dependencies

Q46-observed direct packages: `kernel.audit`, `kernel.runtime`.

## Action classes

`LOCAL-WORK` (read-only local device inventory and redacted audit).

## Must not do

Do not read, retain, or relay phone content, broker records, task-owner state,
grants, device identifiers, messages, notifications, or authentication codes.
Do not infer pairing or unlock authority from USB presence.

## Verification

`node tests/providers.iphone.handoff/run.js`;
`node tests/provider-charters.js`; `node tools/invocation-guard.js`.
