# `agent-engine` package charter

## Purpose

Owns the process-spawning adapters that turn a Claude or Codex CLI invocation
into a bounded, contract-shaped turn.

Confinement configuration belongs to `surface.policy`; the generic retained
child cleanup primitive belongs to `kernel.runtime`. Their existing files
under `src/lib/agent-engine/` keep public import paths stable without making
policy or process-custody primitives part of a provider protocol.

## Public API

`src/lib/agent-engine/engine-contract.js`, `src/lib/agent-engine/claude-adapter.js`,
`src/lib/agent-engine/claude-process.js`, `src/lib/agent-engine/codex-adapter.js`,
`src/lib/agent-engine/codex-process.js`.

## Allowed dependencies

Q46-observed: `kernel.runtime`. Each adapter otherwise spawns its CLI as a
child process rather than requiring another package's module.

`kernel.runtime`: `claude-process.js` builds that child's environment from
`env-scrub.js`, which is the one place the credential delete list lives.

## Action classes

`SPAWN`, `LOCAL-WORK`.

## Must not do

Do not run a turn without the caller-supplied bounded contract, and do not
persist provider credentials outside the injected environment.

## Verification

`node tests/agent-engine/claude-adapter.js`; `node tests/agent-engine/codex-adapter.js`;
`node tests/agent-engine/codex-process.test.js`; `node tests/package-charters.js`.
