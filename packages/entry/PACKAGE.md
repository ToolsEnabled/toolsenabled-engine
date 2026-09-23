# `entry` package charter

## Purpose

Thin executable and transport entrypoints that compose packages into a
process. Wires policy-governed services; not a business-logic or provider
domain.

## Public API

`src/mcp-server.js`, `src/doctor.js`, `src/job-runner.js`, `src/owner-host.js`,
`src/playwright-gateway.js`, `src/uac-delegation-helper.js`,
`src/remote-agent-bridge.js`; `tools/entitlement.js` (customer licence CLI).

Transport tools: `tools/remote-bridge-enroll-token.js`, `tools/remote-bridge-smoke-test.js`,
`tools/lib/link-bus-offer-client.js`, `tools/lib/link-bus-token-rotation*.js`
(three files: the entrypoint plus its hmac and vault halves),
`tools/lib/special-session-sealed-transport.js`,
`tools/link-bus-bootstrap.js`, `tools/link-bus-peer-status.js`,
`tools/link-bus-token-rotation-a.js`, `tools/link-bus-token-rotation-local.js`,
`tools/link-bus-token-rotation-receiver.js`,
`tools/link-bus-token-rotation-verify.js`, `tools/mechanical-bridge-smoke.js`,
`tools/remote-agent-mcp-proxy-smoke.js`, `tools/remote-agent-mcp-proxy.js`,
`tools/remote-bridge-bootstrap.js`, `tools/remote-bridge-peer-status.js`.

## Allowed dependencies

Q46-observed: `auth.google`, `delegation`, `desktop.native`, `entry.setup`, `fra`, `kernel.audit`,
`kernel.policy`, `kernel.runtime`, `kernel.state`, `providers.billing`, `sched`,
`surface.policy`, and `surface.registry`. The direct-link enrollment entrypoint uses
`link.bus`'s one-shot primitive. Entry may import these only to start or
dispatch their bounded public surfaces.

## Action classes

`OUTWARD`, `BROWSER`, `ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not add domain logic, bypass policy/audit/kill-switch enforcement, or make
the direct-link bridge a general network listener or an actor-negotiation API.

## Verification

`node tests/mcp-contract.js`; `node tests/package-charters.js`; `node tools/package-check.js`.
