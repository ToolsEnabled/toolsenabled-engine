# `coordinator.core` package charter

## Purpose

Hosts coordinator audit events, the durable worker runtime, durable memory, and advisory runtime.

## Public API

`src/lib/coordinator-audit-events.js`, `src/lib/providers/durable-worker-runtime.js`,
`src/lib/providers/memory.js`,
`src/lib/providers/overnight-advisory.js`,
`src/lib/providers/overnight-advisory-runtime.js`; tools:
`tools/generate-evidence-store.js`, `tools/generate-platform-contracts.js`,
`tools/research-once.js`.

## Allowed dependencies

Q46-observed: `auth.google`, `controller`, `coordinator.workflow`, `kernel.audit`, `kernel.policy`,
`kernel.runtime`, `kernel.state`, `models`, `providers.research`, `providers.web`, `secrets`.

## Action classes

`RECORD`, `LOCAL-WORK`.

## Must not do

Do not place credentials or owner personal data in mission or memory context.

## Verification

`node tests/providers/durable-worker-runtime.test.js`;
`node tests/memory/memory-provider.js`; `node tests/package-charters.js`.
