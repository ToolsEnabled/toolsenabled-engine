# `providers.gateway` package charter

## Purpose

Owns CLI and Vertex Gemini gateway adapters, agentic invocation, and bounded
model-provider routing. It is not the model-floor authority or fleet scheduler.

## Public API

`src/lib/providers/cli-provider-gateway.js`, `gemini-agentic.js`, `model.js`,
`vertex-gemini-seat.js`, `vertex-gemini-strong.js`, `vertex-gemini.js`,
`customer-model.js`.

The shared subscription launch scrub is owned by `kernel.runtime`; gateway
callers use that canonical implementation through its compatibility export.

## Allowed dependencies

Q46-observed direct packages (cross-domain imports are compatibility exceptions
while the checker is report-only): `auth.google`, `fleet`, `fra`, `coordinator.core`,
`kernel.audit`, `kernel.policy`, `kernel.runtime`, `kernel.state`, `models`,
`providers.misc`, `providers.research`, `surface.policy`, `surface.registry`.
The gateway and provider probes use `surface.policy` for session isolation.

## Action classes

`ASK`, `RECORD`, `LOCAL-WORK`.

## Must not do

Do not silently downgrade a model, bypass model-floor/policy checks, or turn
provider output into authority; add no dependency without a new Q46 edge.

## Verification

`node tests/gemini-agentic.js`; `node tests/vertex-gemini-strong.js`; `node
tests/provider-charters.js`. Queue: `BUILD-QUEUE.md`.
