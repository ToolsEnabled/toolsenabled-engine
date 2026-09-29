# `providers.openshell` package charter

## Purpose

Owns the terminal build's integration with a person's own NVIDIA OpenShell
sandbox: sandbox detection and the policy advisor client, the policy tools,
the sandbox vault, the terminal ledger and settings pages, model endpoints,
roles, and the agent tree inside one sandbox.

## Public API

`src/lib/providers/openshell.js`, `openshell-inside.js`, `openshell-surface.js`,
`openshell-agent-host.js`, `openshell-models.js`, `vault-openshell.js`, and the
terminal pages behind `bin/toolsenabled-openshell.js`.

## Allowed dependencies

Q46-observed direct packages: `agent-engine`, `controller`, `kernel.policy`,
`kernel.runtime`, `mission-bridge`, `owner.ledger`, `providers.misc`,
`surface.policy`, `surface.registry`.

## Action classes

`ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Never approve, apply or widen an OpenShell policy, hold a gateway credential,
or read, copy or relay a CLI's sign-in; the person decides every rule with the
openshell CLI. Add no dependency without a new Q46 edge.

## Verification

`node --test tests/openshell-*.test.js`; `node tests/provider-charters.js`;
the hand test in a sandbox (not part of this repository).
