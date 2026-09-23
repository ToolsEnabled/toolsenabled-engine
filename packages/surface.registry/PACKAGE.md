# `surface.registry` package charter

## Purpose

Defines the MCP tool registry, capability metadata, approvals, and the public
surface that routes a request to a provider. It is the effect chokepoint, so
all provider invocation must pass its policy and audit boundaries.

`src/lib/role-functions.js` owns selection of this registry's exact function
names and effects, including the trusted direct-user-turn check. Role sheets
reuse the registry; this module neither implements a second tool surface nor
dispatches an action on its own.

`src/lib/audit-activity.js` resolves the owner's tool-activity recording
preference for this registry. It does not write or verify the canonical audit
ledger; those operations remain in `kernel.audit`. Unreadable preferences keep
full activity recording, and unknown outcomes remain recorded.

`src/lib/byte-tool-refusal.js` projects typed repository coordination failures
into bounded public repair metadata at the dispatch boundary. It uses
`kernel.state` for the refusal type and `providers.misc` for repository bounds;
it does not expose arbitrary provider details or changed file contents.

## Public API

`src/lib/tool-registry.js`, `src/lib/scoped-approvals.js`,
`src/lib/capability-manifests.js`, `src/lib/mcp-handshake-probe.js`,
`src/lib/mcp-tool-surface.js`; tools: `tools/capability-profile.js`,
`tools/mcp-call.js`, `tools/mcp-handshake-probe.js`,
`tools/mcp-owner-proxy.js`.

## Allowed dependencies

 Q46-observed direct packages: `agent-comms`, `auth.duo`, `auth.google`, `controller`,
 `desktop.native`, `domains.misc`, `entry.setup`, `fleet`, `fra`, `coordinator.core`, `kernel.audit`,
 `kernel.policy`, `kernel.runtime`, `kernel.state`, `mission-bridge`, `models`,
 `owner.inbox`, `providers.chrome-web-store`, `providers.billing`,
 `providers.gateway`, `providers.github`,
 `providers.google.suite`, `providers.infrastructure`, `providers.iphone.handoff`,
 `providers.launch`, `providers.messaging`, `providers.misc`, `providers.research`,
 `providers.sandbox`, `providers.web`, `repo-gate`, `sched`, `search`, `secrets`,
 and `surface.policy`. Surface-to-domain imports are registry-wiring
 compatibility exceptions, not precedent for arbitrary cross-package imports.
 `fleet`: the four `cloud.*` tool definitions dispatch straight to
 `cloud-agent/codex-cloud-launch.js`; that is registry wiring, not fleet logic.

## Action classes

`OUTWARD`, `BROWSER`, `ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not bypass egress preflight, kill-switch, audit, or approval enforcement;
do not expose a provider's private helper as a tool.

## Verification

`node tests/mcp-contract.js`; `node tests/tool-registry-egress-guard.js`;
`node tools/package-check.js`. Queue: `BUILD-QUEUE.md`.
