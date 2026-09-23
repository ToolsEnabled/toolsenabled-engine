# `link.bus` package charter

## Purpose

Owns isolated local-coder and link-bus sidecar process implementations.

## Public API

`sidecars/link-bus/`, `sidecars/local-coder/bin/`, `sidecars/local-coder/src/`.
Shared one-shot enrollment primitive: `tools/lib/one-shot-token-enroll.js`.
Link-bus bootstrap: `tools/link-bus-enroll-token.js`; bounded bridge
verification: `tools/link-bus-smoke-test.js`.

## Allowed dependencies

Q46-observed: `agent-comms`, `controller`, `fra`, `coordinator.core`, `kernel.audit`,
`kernel.runtime`, `models`, `providers.gateway`,
`providers.research`, `sched`, `surface.registry`.

## Action classes

`OUTWARD`, `LOCAL-WORK`, `RECORD`.

## Must not do

Do not inherit host browser profiles, Docker sockets, or unbounded host access.
The enrollment bootstrap must stay one-shot and may never become a general
network listener or expose token content in argv, output, or logs. Any live Q20
owner notice must traverse the closed provider handoff and generic
owner-delivery boundaries; this package must not own a Telegram transport.

## Verification

`node tests/link.bus/link-bus.js`; `node tests/link-bus-enroll-token.js`;
`node tests/link-bus-smoke-test.js`; `node tests/package-charters.js`.
