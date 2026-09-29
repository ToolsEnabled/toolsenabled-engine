# `models` package charter

## Purpose

Tracks model policy, licenses, usage, selection, and bounded research enrichment.

## Public API

`src/lib/model-floor.js`, `src/lib/model-picker.js`, `src/lib/cli-session-usage.js`,
`src/lib/providers/model-role.js`, `src/lib/usage/`; tools:
`tools/usage-attribution-query.js`, `tools/usage-attribution-selftest.js`.

## Allowed dependencies

Q46-observed: `controller`, `fleet`, `kernel.audit`, `kernel.runtime`,
`kernel.state`, `providers.gateway`, `providers.misc`, `providers.web`,
`surface.registry`.

`fleet`: `status-injection.js` reports the default Codex quota, and the
accounts it must probe are held by `multi-account/{registry,health,launch}.js`.

## Action classes

`RECORD`, `LOCAL-WORK`.

## Must not do

Do not silently downgrade a producing model or claim unavailable capacity exists.

## Verification

`node tests/model-floor.js`; `node tests/package-charters.js`.
