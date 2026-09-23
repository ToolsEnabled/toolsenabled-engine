# `providers.research` package charter

## Purpose

Owns bounded Hermes and strong-research provider adapters. Research output is
untrusted advice until independently verified by the caller.

## Public API

`src/lib/providers/research-hermes.js`, `research-strong.js`, `research.js`,
`research-runs-runtime.js`; the durable run machinery
`src/lib/research/collectors.js`, `runners.js`, `settings-gate.js`,
`research-runs-worker.js`, and its entrypoint `tools/research-runs-worker.js`.

## Allowed dependencies

Q46-observed direct packages (cross-domain imports are compatibility exceptions
while the checker is report-only): `kernel.audit`, `kernel.policy`, `kernel.state`,
`models`, `providers.gateway`, `providers.misc`, `fleet`, `coordinator.core`,
`kernel.runtime`, `sched`, `surface.policy`, `surface.registry`.
`surface.policy` supplies the account registry used by research runners.

The five added here became visible when the run machinery was claimed in
config/packages.json; they were always imported, and an unclaimed file simply
hid them. `kernel.runtime` resolves the state root, `sched` and `coordinator.core`
carry durable run scheduling, `fleet` reads machine capability, and
`surface.registry` is how a run declares the tools it may use.

## Action classes

`RECORD`, `LOCAL-WORK`.

## Must not do

Do not treat model output as authority, expose local-model endpoints, or retain
private prompts; add no dependency without a new Q46 edge.

## Verification

`node tests/provider-charters.js`; `node tools/package-check.js`. Queue:
`BUILD-QUEUE.md`.
