# `fra` package charter

## Purpose

Owns Full Remote Access: bridge/tunnel health, peer/token enrollment,
peer identity probing, and the service/machine registries.

`src/lib/online-fra-bridge-response.js` bounds the local bridge response's
deadline and bytes before relay delivery. It does not retry uncertain actions.

## Public API

Registries: `src/lib/service-registry.js`, `src/lib/service-registry-probe.js`
(the machine profile is `kernel.runtime`'s). Peer pairing:
`src/lib/peer-*.js` (enrollment,
link-rotation). Session/transport:
`src/lib/fra-*.js`, `src/lib/online-*.js`,
`src/full-remote-access-bridge.js`,
`src/lib/providers/fra-workspace-handles.js`,
`src/lib/providers/remote-playwright.js`.

Tools: `tools/bridge-status.js`, `tools/fra-doctor.js`, `tools/fra-keeper.js`,
`tools/fra-lifecycle-tunnel-notice.js`, `tools/fra-peer-heartbeat.js`,
`tools/fra-token-enrollment-a.js`, `tools/fra-token-enrollment-lifecycle.js`,
`tools/fra-token-enrollment-receiver.js`, `tools/lib/fra-token-enrollment.js`,
`tools/lib/fra-token-enrollment-vault.js`,
`tools/full-remote-access-enroll-peer.js`,
`tools/full-remote-access-enroll-token.js`,
`tools/full-remote-access-listener-host.js`,
`tools/full-remote-access-mcp-proxy.js`,
`tools/full-remote-access-release-enroll.js`,
`tools/full-remote-playwright-mcp-proxy.js`, `tools/link-bus-exact-launch.js`,
`tools/peer-dispatch.js`, `tools/peer-enroll.js`,
`tools/fra-peer-identity-probe.js`, `tools/remote-agent-bridge-reconcile.js`,
`tools/tunnel-bridge-health.js`, `tools/tunnel-bridge-preflight.js`.

The tunnel/bridge keeper is an optional, on-demand managed process. It stays
off on a fresh installation and refuses to start until the customer's own
two-computer service registry, checkout roots, endpoints, and two distinct
vault tokens pass `tools/tunnel-bridge-preflight.js`.

The customer-facing distinction between Tunnel, Bridge, and Full Remote
Access, including the public-network boundary, ships at
`docs/full-remote-access.md`. Documentation is recorded here rather than in
`config/packages.json`, whose executable package contract accepts only
JavaScript under `src/`, `tools/`, and `sidecars/`.

## Allowed dependencies

Observed direct packages: `desktop.browser`, `desktop.native`, `entry`, `link.bus`,
`kernel.audit`, `kernel.policy`, `kernel.runtime`, `surface.policy`,
`surface.registry`.

## Action classes

`OUTWARD`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not accept a bridge origin, token, or peer identity claim without the
enrollment/vault checks these tools already perform; never widen a listener
beyond the declared service-registry endpoint.

## Verification

`node tools/bridge-status.js`; `node tests/pkg.tree/package-check.js`.
